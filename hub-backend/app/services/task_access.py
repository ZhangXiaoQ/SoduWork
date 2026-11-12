"""Participant read access and live task delivery. The owning execution device retains write
authority; creators, requesters, and assignees can follow the same task without duplicating it
or competing over execution state.
"""
from __future__ import annotations

import asyncio
from collections.abc import Iterable

from fastapi import HTTPException
from sqlalchemy import and_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..realtime import hub
from ..schemas import task_to_api
from ..repository_issue_models import RepositoryIssueLink

_PUBLISH_CONCURRENCY = 32


def participant_user_ids(task: models.Task) -> set[str]:
    return {
        str(value) for value in (
            getattr(task, "created_by", None),
            getattr(task, "requester_user_id", None),
            getattr(task, "assignee_user_id", None),
        ) if value
    }


def is_owner(task: models.Task, client: models.Client | None) -> bool:
    """Execution authority survives device account switches without transferring."""
    return bool(client and task.owner_client_id == client.id and
                str(getattr(task, "owner_user_id", None) or "") == str(client.user_ref or ""))


def can_continue_cloud(task: models.Task, client: models.Client | None) -> bool:
    """A cloud conversation can be continued by any device in its account.

    The Runner remains pinned to the handoff record; this capability only
    authorizes another account device to append a turn through Hub.  Local
    tasks keep their existing owner-device execution boundary.
    """
    return bool(
        client and task.origin == "cloud-conversation"
        and client.user_ref
        and str(task.owner_user_id or "") == str(client.user_ref)
        and task.archived_at is None
    )


def can_continue_execution(task: models.Task, client: models.Client | None) -> bool:
    """Continue the existing execution without granting task mutation rights.

    Shared viewers do not acquire execution authority. An account-owned
    requirement may be continued from that account's devices only when its
    execution context pins a Runner; local/remote is relative to the viewing
    device, not an account authorization boundary. Never select a fallback host.
    """
    if not client or task.archived_at is not None:
        return False
    if is_owner(task, client) or can_continue_cloud(task, client):
        return True
    context = (getattr(task, "work_routing", None) or {}).get("executionContext") or {}
    runner = context.get("runner") or {}
    # A requirement dispatched from the owning PC is projected as "local".
    # Its other account devices still address the exact registered Runner.
    # Sending revalidates the frozen ExecutionSession in task_continuation.
    from .task_requirements import KINDS
    local_requirement = (
        task.kind in KINDS and runner.get("mode") == "local"
        and bool(task.owner_client_id)
        and runner.get("clientId") == task.owner_client_id
        and str((context.get("agent") or {}).get("id") or "").startswith(
            "runner:" + str(runner.get("runnerId") or "") + ":")
    )
    return bool(client.user_ref and str(task.owner_user_id or "") == str(client.user_ref)
                and (runner.get("mode") == "remote" or local_requirement) and runner.get("runnerId"))


def owner_clause(client: models.Client | None):
    if client is None:
        return False
    account = (models.Task.owner_user_id == client.user_ref if client.user_ref
               else models.Task.owner_user_id.is_(None))
    return and_(models.Task.owner_client_id == client.id, account)


def visible_clause(client: models.Client):
    clauses = [owner_clause(client)]
    if client.user_ref:
        clauses.extend((
            models.Task.created_by == client.user_ref,
            models.Task.requester_user_id == client.user_ref,
            models.Task.assignee_user_id == client.user_ref,
        ))
    return or_(*clauses)


def is_creator(task: models.Task, *, user_id: str = "", client_id: str = "") -> bool:
    creator = str(getattr(task, "created_by", None) or "")
    if creator:
        return bool(user_id and creator == str(user_id))
    # Legacy local tasks could predate account activation. A receiving device
    # on an imported/dispatched task is not its creator.
    return bool(client_id and task.owner_client_id == client_id and
                str(getattr(task, "owner_user_id", None) or "") == str(user_id or "") and
                getattr(task, "origin", None) == "local")


def my_roles(task: models.Task, client: models.Client) -> list[str]:
    roles: list[str] = []
    uid = str(client.user_ref or "")
    if is_owner(task, client):
        roles.append("executor")
    if is_creator(task, user_id=uid, client_id=client.id):
        roles.append("creator")
    for role, value in (
        ("creator", getattr(task, "created_by", None)),
        ("requester", getattr(task, "requester_user_id", None)),
        ("assignee", getattr(task, "assignee_user_id", None)),
    ):
        if uid and uid == str(value or "") and role not in roles:
            roles.append(role)
    return roles


async def can_view(session: AsyncSession, client: models.Client,
                   task: models.Task) -> bool:
    if is_owner(task, client):
        return True
    return bool(client.user_ref and client.user_ref in participant_user_ids(task))


async def view_task(session: AsyncSession, client: models.Client, tid: str) -> models.Task:
    task = await session.get(models.Task, tid)
    if task is None or not await can_view(session, client, task):
        raise HTTPException(status_code=404, detail="需求不存在")
    return task


async def require_owned_task(session: AsyncSession, client: models.Client,
                             tid: str) -> models.Task:
    """Require the owning execution device for mutations; participant visibility does not grant
    this authority.
    """
    task = await session.get(models.Task, tid)
    if task is None or not is_owner(task, client):
        raise HTTPException(status_code=404, detail="需求不存在")
    return task


async def publish_owner(session: AsyncSession, task: models.Task, event: dict) -> bool:
    """Do not deliver execution data to a subsequent login on the device."""
    client = await session.get(models.Client, task.owner_client_id,
                               populate_existing=True) if task.owner_client_id else None
    if is_owner(task, client):
        await hub.publish(client.id, event, user_id=task.owner_user_id or "")
        return True
    return False


async def reserve_task_write(session: AsyncSession, tid: str, owner_id: str) -> None:
    """Match row-lock serialization on SQLite before authorizing a task write."""
    if session.get_bind().dialect.name != "sqlite":
        return
    # SQLite ignores SELECT FOR UPDATE. This no-op takes its write reservation
    # until commit without changing the task timestamp or creating a new state.
    await session.execute(update(models.Task).where(
        models.Task.id == tid, models.Task.owner_client_id == owner_id,
    ).values(updated_at=models.Task.updated_at).execution_options(synchronize_session=False))


async def _name_map(session: AsyncSession, tasks: Iterable[models.Task]) -> dict[str, str]:
    ids: set[str] = set()
    for task in tasks:
        ids.update(participant_user_ids(task))
    if not ids:
        return {}
    users = (await session.execute(
        select(models.User).where(models.User.id.in_(ids))
    )).scalars().all()
    return {user.id: (user.display_name or user.username) for user in users}


async def _device_name_map(session: AsyncSession,
                           tasks: Iterable[models.Task]) -> dict[str, str]:
    ids = {str(task.owner_client_id) for task in tasks if task.owner_client_id}
    if not ids:
        return {}
    clients = (await session.execute(
        select(models.Client).where(models.Client.id.in_(ids))
    )).scalars().all()
    return {client.id: (client.name or client.id) for client in clients}


def decorate(task: models.Task, api: dict, client: models.Client,
             names: dict[str, str], devices: dict[str, str] | None = None) -> dict:
    out = dict(api)
    assignee_id = str(getattr(task, "assignee_user_id", None) or "")
    requester_id = str(getattr(task, "requester_user_id", None) or "")
    creator_id = str(getattr(task, "created_by", None) or "")
    out.update({
        "assigneeName": names.get(assignee_id, ""),
        "requesterName": (getattr(task, "requester_name", "") or
                          names.get(requester_id, "")),
        "createdByName": (getattr(task, "created_by_name", "") or
                          names.get(creator_id, "")),
        "executionDeviceName": (devices or {}).get(str(task.owner_client_id or ""), ""),
        "readOnly": not is_owner(task, client),
        "canSend": can_continue_execution(task, client),
        "canViewExecution": bool(my_roles(task, client)),
        "canComment": bool(my_roles(task, client)),
        "myRoles": my_roles(task, client),
    })
    return out


async def decorate_many(session: AsyncSession, tasks: list[models.Task], apis: list[dict],
                        client: models.Client) -> list[dict]:
    names = await _name_map(session, tasks)
    devices = await _device_name_map(session, tasks)
    return [decorate(task, api, client, names, devices) for task, api in zip(tasks, apis)]


async def recipient_clients(session: AsyncSession, task: models.Task, *, shared_org_id: str | None = None) -> list[models.Client]:
    users = participant_user_ids(task)
    clauses = []
    if task.owner_client_id:
        account = (models.Client.user_ref == task.owner_user_id if task.owner_user_id
                   else models.Client.user_ref.is_(None))
        clauses.append(and_(models.Client.id == task.owner_client_id, account))
    if users:
        clauses.append(models.Client.user_ref.in_(users))
    access = models.TaskRequirementAccess
    clauses.extend((
        and_(models.Client.user_ref.is_(None), models.Client.id.in_(select(access.principal_id).where(
            access.task_id == task.id, access.principal_kind == "client"))),
        models.Client.user_ref.in_(select(access.principal_id).where(access.task_id == task.id, access.principal_kind == "user")),
    ))
    if getattr(task, "origin", None) in {"gitlab_issue", "github_issue"}:
        from . import repository_issue_access
        catalogs = select(RepositoryIssueLink.catalog_id).where(RepositoryIssueLink.task_id == task.id)
        users_for_catalog = (repository_issue_access.github_user_ids if task.origin == "github_issue"
                             else repository_issue_access.member_user_ids)
        clauses.append(and_(models.Client.auth_state == "active", models.Client.revoked_at.is_(None),
            models.Client.user_ref.in_(users_for_catalog(catalogs.scalar_subquery()))))
    shared = (None if getattr(task, "origin", None) in {"gitlab_issue", "github_issue"}
              else shared_org_id or getattr(task, "shared_org_id", None))
    if shared or getattr(task, "legacy_requirements", None):
        administrators = select(models.User.id).where(models.User.is_super.is_(True), models.User.is_active.is_(True))
        clauses.append(models.Client.user_ref.in_(administrators))
    if shared:
        from types import SimpleNamespace
        from . import rbac
        scope = await rbac.company_org_ids(session, SimpleNamespace(org_id=shared, is_active=True, is_super=False))
        shared_users = select(models.User.id).where(models.User.org_id.in_(scope or set()), models.User.is_active.is_(True))
        clauses.append(models.Client.user_ref.in_(shared_users))
    if not clauses:
        return []
    rows = (await session.execute(select(models.Client).where(or_(*clauses))
                                  .execution_options(populate_existing=True))).scalars().all()
    unique: list[models.Client] = []
    seen: set[str] = set()
    for row in rows:
        if row.id not in seen:
            seen.add(row.id)
            unique.append(row)
    return unique


async def prepare_task_events(session: AsyncSession, task: models.Task, event_type: str,
                              api: dict | None = None, *, arrival: str = "",
                              by: str = "", notification_id: str = "") -> list[tuple]:
    clients = await recipient_clients(session, task)
    if not clients:
        return []
    from . import task_requirements, requirement_edit_policy
    prepared = await task_requirements.prepare_notifications(session, task, clients)
    names = await _name_map(session, [task])
    devices = await _device_name_map(session, [task])
    # Delivery metadata belongs to the event, not the persisted task.  Only the
    # new owner may auto-open a collaboration session; tracking copies stay quiet.
    event_arrival = str(arrival or "").strip()[:24]
    event_by = str(by or "").strip()[:120]
    base = dict(api or task_to_api(task))
    await requirement_edit_policy.decorate_many(session, [task], [base])
    from . import task_requirement_projection
    await task_requirement_projection.decorate_many(session, [task], [base])
    base.pop("arrival", None)
    base.pop("by", None)
    events = []
    for client in clients:
        payload = decorate(task, base, client, names, devices)
        payload = await task_requirements.decorate(session, client, task, payload,
                                                  prepared=prepared[client.id])
        event = {"type": event_type, "task": payload}
        if notification_id:
            event["notificationId"] = notification_id
        # Assignment arrival follows the human assignee's account.  The
        # execution device remains ``owner_client_id`` and may belong to a
        # different person, so using the owner gate here showed the alert on
        # the old device and made the new assignee miss it.
        if event_arrival == "assign":
            arrival_target = bool(
                client.user_ref and
                str(client.user_ref) == str(getattr(task, "assignee_user_id", "") or "")
            )
        else:
            arrival_target = is_owner(task, client)
        if event_arrival and arrival_target:
            event["arrival"] = event_arrival
            if event_by:
                event["by"] = event_by
        events.append((client.id, event, client.user_ref or ""))
    return events


async def publish_events(events: Iterable[tuple], publish=None) -> None:
    """Bound independent transports after serial projection, preserving account fences."""
    events = list(events)
    pending, failures = iter(events), []

    async def publish_next():
        for item in pending:
            device_id, event = item[0], item[1]
            user_id = item[2] if len(item) > 2 else ""
            try:
                await (publish or hub.publish)(device_id, event, user_id=user_id)
            except Exception as error:
                failures.append(error)

    await asyncio.gather(*(publish_next() for _ in range(min(_PUBLISH_CONCURRENCY, len(events)))))
    # Await all attempted deliveries; cancellation must not leave detached work.
    if failures:
        raise failures[0]


async def publish_task(session: AsyncSession, task: models.Task, event_type: str,
                       api: dict | None = None, *, arrival: str = "",
                       by: str = "", notification_id: str = "") -> None:
    events = await prepare_task_events(session, task, event_type, api,
                                       arrival=arrival, by=by,
                                       notification_id=notification_id)
    await publish_events(events)


async def publish_deleted(clients: Iterable[models.Client], tid: str) -> None:
    for client in clients:
        await hub.publish(client.id, {"type": "task.deleted", "id": tid}, user_id=client.user_ref or "")
