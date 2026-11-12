"""Requirement preparation and sharing on the authoritative Task entity.

Company visibility never grants access to execution transcripts, personal
instructions, comments or old delivery attachments. Those keep task_access.
"""
from datetime import datetime, timezone
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import and_, func, or_, select, update

from .. import models

KINDS = {"requirement", "bug", "ticket", "improvement", "other"}
TRIAGE = {"intake", "clarifying", "ready"}
EXTRA_KEYS = {"kind", "acceptanceCriteria", "triageStage", "archivedAt", "visibility",
              "automationScheduleId", "requirementVersion"}
BUSINESS_KEYS = {"title", "note", "source", "priority", "tags", "requesterUserId",
                 "requesterName", "requesterContact", "projectId", "repoId"}
EXECUTION_REFERENCE_KEYS = {"requesterUserId", "projectId", "repoId"}


def is_review_submitter(task, client):
    """Only the assigned executor account, or an unassigned execution owner, submits work."""
    from . import task_access
    assignee = str(task.assignee_user_id or "")
    return bool(client.user_ref and assignee == str(client.user_ref)) if assignee else task_access.is_owner(task, client)


def ensure_executable(task):
    if getattr(task, "archived_at", None):
        raise ValueError("请先恢复已归档的需求，再安排执行")
    if (getattr(task, "triage_stage", None) or "ready") in {"intake", "clarifying"}:
        raise ValueError("请先澄清需求并设为待交付，再安排执行")


def stage(task):
    if getattr(task, "archived_at", None) or task.status == "cancel":
        return "closed"
    if task.status == "done":
        return "delivered"
    if task.status in {"doing", "paused"}:
        return "delivering"
    return getattr(task, "triage_stage", None) or "ready"


def fields(task):
    from ..schemas import _ms
    return {
        "kind": getattr(task, "kind", None) or "requirement",
        "acceptanceCriteria": list(getattr(task, "acceptance_criteria", None) or []),
        "triageStage": getattr(task, "triage_stage", None) or "ready",
        "archivedAt": _ms(getattr(task, "archived_at", None)),
        "visibility": "organization" if getattr(task, "origin", None) == "github_issue" or
            (getattr(task, "shared_org_id", None) and getattr(task, "origin", None) != "gitlab_issue") else "related",
        "sharedOrgId": getattr(task, "shared_org_id", None),
        "automationScheduleId": getattr(task, "automation_schedule_id", None),
        "requirementStage": stage(task),
        "requirementVersion": int(getattr(task, "requirement_version", None) or 1),
        "migratedRequirements": [{
            **{key: row.get(key) for key in ("id", "title", "description", "kind", "source", "tags", "status")},
            "acceptanceCriteria": row.get("acceptance_criteria") or [],
            "createdAt": row.get("created_at"), "updatedAt": row.get("updated_at"),
        } for row in (getattr(task, "legacy_requirements", None) or [])],
    }


async def identity(session, client):
    return await session.get(models.User, client.user_ref) if client and client.user_ref else None


def principal_clause(client):
    access = models.TaskRequirementAccess
    clauses = []
    if client.user_ref:
        clauses.append(and_(access.principal_kind == "user", access.principal_id == client.user_ref))
    else:
        clauses.append(and_(access.principal_kind == "client", access.principal_id == client.id))
    return or_(*clauses)


@dataclass
class _ListRead:
    """One list response's ACL snapshot; never retained on a session or globally."""
    user: object
    company_scope: set[str] | None
    grants: dict[str, list]
    repository_issues: dict
    reviewable: set[str] | None = None


async def source_access(session, client, task, *, prepared=None):
    if prepared is not None:
        return prepared.grants.get(task.id, [])
    return list((await session.scalars(select(models.TaskRequirementAccess).where(
        models.TaskRequirementAccess.task_id == task.id, principal_clause(client)))).all())


async def company_access(session, client, task, *, prepared=None):
    from . import rbac
    if getattr(task, "origin", None) == "github_issue":
        from . import repository_issue_access
        if prepared is not None:
            return bool(prepared.repository_issues.get(task.id, {}).get("member"))
        return await repository_issue_access.is_member(session, client, task)
    if getattr(task, "origin", None) == "gitlab_issue":
        return False
    if prepared is None:
        scope = await rbac.company_org_ids(session, await identity(session, client))
    else:
        scope = prepared.company_scope
    # A super administrator could read the retired pool, but still receives no
    # execution rights to a private Task through that historical permission.
    if scope is None:
        return bool(task.shared_org_id or task.legacy_requirements)
    return bool(task.shared_org_id and task.shared_org_id in scope)


async def readable_sources(session, client, task, *, prepared=None):
    snapshots = list(task.legacy_requirements or [])
    if await company_access(session, client, task, prepared=prepared):
        return snapshots
    allowed = {row.source_id for row in await source_access(session, client, task, prepared=prepared)}
    return [row for row in snapshots if row.get("id") in allowed]


async def visible_clause(session, client):
    from . import rbac, task_access, repository_issue_access
    scope = await rbac.company_org_ids(session, await identity(session, client))
    shared = models.Task.shared_org_id.isnot(None) if scope is None else models.Task.shared_org_id.in_(scope)
    shared = and_(shared, ~repository_issue_access.linked_clause())
    access = select(models.TaskRequirementAccess.task_id)
    if scope is not None:
        access = access.where(principal_clause(client))
    legacy_admin = func.json_array_length(models.Task.legacy_requirements) > 0 if scope is None else False
    return or_(task_access.visible_clause(client), shared, models.Task.id.in_(access), legacy_admin,
               repository_issue_access.visible_clause(client))


async def can_read(session, client, task):
    from . import rbac, task_access, repository_issue_access
    if await task_access.can_view(session, client, task):
        return True
    return (await company_access(session, client, task) or bool(await source_access(session, client, task))
            or await repository_issue_access.is_member(session, client, task))


async def can_manage(session, client, task, context=None, *, prepared=None):
    from . import task_access
    if task_access.is_owner(task, client):
        return True
    if client.user_ref and client.user_ref in task_access.participant_user_ids(task):
        return True
    # A source-only participant must never rewrite another private source in a
    # merged Task. Their history and files stay readable, not jointly editable.
    snapshots = list(task.legacy_requirements or [])
    me = prepared.user if prepared is not None else await identity(session, client)
    if snapshots and me and me.is_super:
        return True
    if snapshots and task.status == "todo":
        owned = {row.source_id for row in await source_access(session, client, task, prepared=prepared)}
        if owned and all(row.get("id") in owned for row in snapshots):
            return True
    if not task.shared_org_id:
        return False
    # Team visibility grants read access, not unrestricted editing. Keep edits
    # with the requester, assignee, execution device, or super administrator.
    if context is not None:
        me = context[0]
    return bool(me and me.is_super)


async def can_edit(session, client, task, context=None, *, prepared=None):
    if not await can_manage(session, client, task, context, prepared=prepared):
        return False
    from . import requirement_edit_policy
    facts = await requirement_edit_policy.facts_many(session, [task])
    return not facts.get(task.id, (False, ""))[1]

async def is_maintenance_creator(session, task, *, user_id="", client_id="", prepared=None):
    from . import task_access
    if task_access.is_creator(task, user_id=user_id, client_id=client_id):
        return True
    sources = {str(row.get("id") or "") for row in task.legacy_requirements or []}
    if not sources or "" in sources:
        return False
    if prepared is not None:
        owned = {row.source_id for row in prepared.grants.get(task.id, []) if row.role == "creator"}
        return sources.issubset(owned)
    access = models.TaskRequirementAccess
    principals = []
    if user_id:
        principals.append(and_(access.principal_kind == "user", access.principal_id == user_id))
    if client_id and not user_id:
        principals.append(and_(access.principal_kind == "client", access.principal_id == client_id))
    if not principals:
        return False
    owned = set(await session.scalars(select(access.source_id).where(
        access.task_id == task.id, access.role == "creator", or_(*principals))))
    return sources.issubset(owned)


async def can_maintain(session, client, task, context=None, authority=None, *, prepared=None):
    # Execution history freezes the definition, not authorized maintenance of
    # terminal work. task_maintenance independently guards live execution/stage.
    if authority is None:
        authority = await can_manage(session, client, task, context, prepared=prepared)
    if not authority:
        return False
    if stage(task) not in {"intake", "clarifying", "ready"}:
        return True
    return await is_maintenance_creator(session, task, user_id=client.user_ref or "", client_id=client.id,
                                        prepared=prepared)


async def get(session, client, tid):
    task = await session.get(models.Task, tid)
    if task is None or not await can_read(session, client, task):
        raise HTTPException(404, "需求不存在")
    return task


def public_content(task):
    """Migrated deliveries may have private notes beyond their original request."""
    frozen = dict(getattr(task, "requirement_content", None) or {})
    return {"title": frozen.get("title", task.title), "note": frozen.get("note", task.note)}


def snapshot_content(snapshots):
    return {"title": " / ".join(row.get("title") or "" for row in snapshots),
            "note": "\n\n".join((row.get("title") or "") + "\n" +
                               (row.get("description") or "") for row in snapshots)}


async def can_read_attachment(session, client, task, attachment):
    from . import task_access
    if await task_access.can_view(session, client, task):
        return True
    meta = attachment.evidence_meta or {}
    if attachment.role != "input" or meta.get("kind") != "requirement_input":
        return False
    if await company_access(session, client, task):
        return True
    sources = await readable_sources(session, client, task)
    if meta.get("migratedRequirementId"):
        return any(row.get("id") == meta["migratedRequirementId"] for row in sources)
    return bool(sources and len(sources) == len(task.legacy_requirements or []))


async def decorate(session, client, task, api, *, context=None, prepared=None, edit_facts=None):
    from . import task_access
    execution = await task_access.can_view(session, client, task)
    authority = await can_manage(session, client, task, context, prepared=prepared)
    if "requirementEditBlocked" not in api:
        from . import requirement_edit_policy
        await requirement_edit_policy.decorate_many(session, [task], [api], facts=edit_facts)
    editable = authority and not api.get("requirementEditBlocked", False)
    content = public_content(task)
    if not execution:
        allowed = {"id", "status", "priority", "tags", "created", "updatedAt", "source", "projectId", "repoId",
                   "assigneeUserId", "assigneeName", "requesterUserId", "requesterName", "createdBy",
                   "createdByName", "myRoles", "kind", "acceptanceCriteria", "triageStage", "archivedAt",
                   "visibility", "sharedOrgId", "automationScheduleId", "requirementStage", "requirementVersion", "migratedRequirements", "reviewedAt"}
        allowed.update({"maintenanceBlocked", "maintenanceBlockReason", "projectionPending"})
        allowed.update({"hasExecutionHistory", "requirementEditBlocked", "requirementEditBlockReason"})
        api = {key: value for key, value in api.items() if key in allowed}
        snapshots = list(task.legacy_requirements or [])
        visible = await readable_sources(session, client, task, prepared=prepared) if snapshots else []
        if snapshots and len(visible) != len(snapshots):
            content = snapshot_content(visible)
            ids = {row["id"] for row in visible}
            api["migratedRequirements"] = [row for row in api.get("migratedRequirements", []) if row["id"] in ids]
            api["acceptanceCriteria"] = list(dict.fromkeys(value for row in visible
                for value in row.get("acceptance_criteria") or []))
            primary = visible[0] if visible else {}
            for key, source in (("kind", "kind"), ("priority", "priority"), ("tags", "tags"), ("source", "source"),
                ("projectId", "project_id"), ("repoId", "repo_id"), ("createdBy", "created_by_user_id"),
                ("createdByName", "created_by_name"), ("requesterUserId", "requester_user_id"),
                ("requesterName", "requester_name"), ("assigneeUserId", "assignee_user_id"), ("assigneeName", "assignee_name")):
                api[key] = primary.get(source)
            api["automationScheduleId"] = primary.get("automation_schedule_id")
        api.update(content)
        historical_roles = {row.role for row in await source_access(session, client, task, prepared=prepared)}
        api["myRoles"] = list(dict.fromkeys(list(api.get("myRoles") or []) + sorted(historical_roles)))
        api["readOnly"] = True
    api["requirementContent"] = content
    maintenance = await can_maintain(session, client, task, context, authority=authority, prepared=prepared)
    if maintenance and stage(task) in TRIAGE:
        # Preparation-stage maintenance already proves aggregate creator rights.
        api["myRoles"] = list(dict.fromkeys(list(api.get("myRoles") or []) + ["creator"]))
    api.update(canEditRequirement=editable, canViewExecution=execution, canComment=execution,
               canContinueExecution=bool(execution and task_access.can_continue_execution(task, client)),
               canDeleteRequirement=maintenance, canArchiveRequirement=maintenance,
               canManageRequirementMaterials=authority,
               canSubmitReview=bool(execution and is_review_submitter(task, client)
                                    and task.status == "doing" and not task.archived_at
                                    and api.get("requirementStage") == "delivering"
                                    and not api.get("maintenanceBlocked", True)),
               canManageRequirementAutomation=authority)
    # Formal reviews may wait while the execution Task still has status=doing.
    # Carry the personal decision capability in the same snapshot as its stage.
    pending_review = False
    if execution and api.get("requirementStage") == "reviewing":
        from . import requirement_review_access
        reviewable = prepared.reviewable if prepared is not None else None
        if reviewable is None:
            reviewable = await requirement_review_access.pending_task_ids(session, client.user_ref, [task.id])
        pending_review = task.id in reviewable
    # Formal reviews use personal assignment and decision rights, including
    # pending co-sign requests after this reviewer has already voted.
    api["canReview"] = bool(
        pending_review or (execution and task.status == "done" and api.get("requirementStage") != "reviewing"
        and not getattr(task, "reviewed_at", None)
        and not getattr(task, "archived_at", None)
        and client.user_ref and str(getattr(task, "created_by", "") or "") == str(client.user_ref)
        )
    )
    from . import repository_issue_access, task_execution_claim
    api["canClaimExecution"] = execution and task_execution_claim.available(task, client, api)
    return await repository_issue_access.decorate(session, client, task, api,
        prepared=prepared.repository_issues if prepared is not None else None)


async def apply(session, client, task, data, *, creating=False):
    """Consume preparation fields. Keep execution updates in task_status.mark."""
    from . import task_access
    edit_facts = None
    if not creating:
        from . import requirement_edit_policy
        if requirement_edit_policy.DEFINITION_KEYS.intersection(data):
            edit_facts = await requirement_edit_policy.ensure_allowed(session, task)
        if {"actualStart", "actualEnd"}.intersection(data):
            requirement_edit_policy.preserve_manual_history(session, task, task.status, task.status)
    if "priority" in data and data["priority"] not in {"low", "normal", "high", "critical"}:
        raise HTTPException(400, "优先级不正确")
    if "title" in data:
        data["title"] = str(data["title"] or "").strip()[:200]
        if not data["title"]:
            raise HTTPException(400, "请填写需求标题")
    if not creating and task.status != "todo" and {"kind", "acceptanceCriteria"}.intersection(data):
        raise HTTPException(409, "需求已进入执行，不能更改原完成标准")
    if not creating and "requirementVersion" in data:
        if data["requirementVersion"] != int(task.requirement_version or 1):
            raise HTTPException(409, "需求已被其他人更新，请刷新后再保存")
        expected = int(data["requirementVersion"])
        claimed = await session.execute(update(models.Task).where(
            models.Task.id == task.id, models.Task.requirement_version == expected,
        ).values(requirement_version=expected + 1).execution_options(synchronize_session=False))
        if claimed.rowcount != 1:
            raise HTTPException(409, "需求已被其他人更新，请刷新后再保存")
        task.requirement_version = expected + 1
    data.pop("requirementVersion", None)
    changed = bool(EXTRA_KEYS.intersection(data))
    if "kind" in data:
        value = data.pop("kind")
        if value not in KINDS:
            raise HTTPException(400, "需求类型不正确")
        task.kind = value
    if "acceptanceCriteria" in data:
        values = data.pop("acceptanceCriteria")
        if not isinstance(values, list) or len(values) > 50:
            raise HTTPException(400, "完成标准格式不正确")
        criteria = [str(value).strip() for value in values if str(value).strip()]
        if any(len(value) > 1000 for value in criteria):
            raise HTTPException(400, "每条完成标准最多 1000 字符；请拆分为多条，内容没有被截断保存")
        task.acceptance_criteria = criteria
    if "visibility" in data:
        visibility = data.pop("visibility")
        if visibility not in {"related", "organization"}:
            raise HTTPException(400, "需求可见范围不正确")
        if getattr(task, "origin", None) == "github_issue" and visibility != "organization":
            raise HTTPException(403, "GitHub Issue 需求默认对当前团队全员开放，不能改为仅相关人可见")
        if visibility == "organization" and getattr(task, "origin", None) == "gitlab_issue":
            raise HTTPException(403, "仓库 Issue 需求仅对相关仓库成员开放，不能扩为团队可见")
        me = await identity(session, client)
        if visibility == "organization" and not (me and me.is_active and me.org_id):
            raise HTTPException(409, "加入团队后才能创建团队可见的需求")
        if not creating and not task_access.is_owner(task, client) and not task_access.is_creator(
                task, user_id=client.user_ref or "", client_id=client.id):
            raise HTTPException(403, "只有创建人或执行人可以更改可见范围")
        task.shared_org_id = (me.org_id if visibility == "organization" else None) if task.origin != "github_issue" else None
    if "automationScheduleId" in data:
        sid = data.pop("automationScheduleId") or None
        schedule = await session.get(models.AiSchedule, sid) if sid else None
        if sid and (schedule is None or schedule.owner_client_id != client.id):
            raise HTTPException(404, "自动化不存在或不属于当前客户端")
        task.automation_schedule_id = sid
    if {"triageStage", "archivedAt"}.intersection(data):
        from . import task_maintenance
        if not creating:
            action = "archive" if data.get("archivedAt") else None
            await task_maintenance.ensure_allowed(session, [task], action=action, client=client)
        if "triageStage" in data:
            value = data.pop("triageStage")
            if value not in TRIAGE or (not creating and task.status != "todo" and data.get("status") != "todo"):
                raise HTTPException(409, "只能调整未开始需求的整理阶段")
            task.triage_stage = value
        if "archivedAt" in data:
            value = data.pop("archivedAt")
            task.archived_at = datetime.now(timezone.utc) if value else None
    if not creating and changed:
        task.requirement_version = int(task.requirement_version or 1) + 1
    return edit_facts


async def refresh_memory(session, task, previous_org=None):
    from . import org_memory
    await session.flush()
    for oid in {previous_org, getattr(task, "shared_org_id", None)} - {None, ""}:
        await org_memory.refresh(session, oid)


async def forget_previous_viewers(session, task, previous_org):
    """A visibility change removes cached public cards from former viewers."""
    if not previous_org or previous_org == task.shared_org_id:
        return
    from . import task_access
    from ..realtime import hub
    current = {row.id for row in await task_access.recipient_clients(session, task)}
    previous = await task_access.recipient_clients(session, task, shared_org_id=previous_org)
    for device in previous:
        if device.id not in current:
            await hub.publish(device.id, {"type": "task.deleted", "id": task.id}, user_id=device.user_ref or "")


async def update_shared(session, client, task, data):
    if not await can_manage(session, client, task):
        raise HTTPException(403, "你只能查看这条需求")
    restore_cancelled = (task.status == "cancel" and "archivedAt" in data and
                         data["archivedAt"] is None and data.get("status") == "todo")
    if set(data) - (EXTRA_KEYS | BUSINESS_KEYS | ({"status"} if restore_cancelled else set())):
        raise HTTPException(403, "执行状态、安排执行和交付只能由执行人处理")
    if EXECUTION_REFERENCE_KEYS.intersection(data):
        # A company reader must not grant themselves transcript access by adding
        # their ID to the task's requester/participant ACL.
        raise HTTPException(403, "执行关联只能由执行人修改")
    if task.status != "todo" and (BUSINESS_KEYS - {"tags"}).intersection(data):
        raise HTTPException(409, "需求已进入执行，请由执行人在详情中处理")
    previous_org = task.shared_org_id
    requirement_edit = "requirementVersion" in data
    edit_facts = await apply(session, client, task, data)
    if restore_cancelled:
        # Restore is maintenance, not a grant to edit execution state generally.
        from . import task_status
        data.pop("status", None)
        await task_status.mark(session, task, "todo", why="恢复需求", refresh_memory=False)
    from . import tasks
    if task.requirement_content:
        content = dict(task.requirement_content)
        for key in {"title", "note"}.intersection(data):
            content[key] = data.pop(key)
        task.requirement_content = content
    for key, value in data.items():
        setattr(task, tasks._FIELD_MAP.get(key, key), value)
    # Match update_task: only definition changes advance the version. Edits with
    # requirementVersion already increment it conditionally in apply.
    if not requirement_edit and set(data) & tasks._REQ_CONTENT_KEYS:
        task.requirement_version = int(task.requirement_version or 1) + 1
    from . import task_notifications
    task_notifications.enqueue(session, task, "task.updated", previous_org=previous_org)
    await session.commit()
    await session.refresh(task)
    from . import task_access
    api = tasks.task_to_api(task)
    api["projectionPending"] = True
    api = task_access.decorate(task, api, client, {}, {})
    api.pop("assigneeName", None)
    api.pop("executionDeviceName", None)
    return await decorate(session, client, task, api, edit_facts=edit_facts)


async def decorate_many(session, client, rows, apis):
    from . import inbox, rbac
    pairs = list(zip(rows, apis))
    if not pairs:
        return []
    from . import requirement_edit_policy
    missing = [(task, api) for task, api in pairs if "requirementEditBlocked" not in api]
    if missing:
        await requirement_edit_policy.decorate_many(session,
            [task for task, _ in missing], [api for _, api in missing])
    context = await inbox._me_scope(session, client)
    scope = await rbac.company_org_ids(session, context[0])
    ids = list(dict.fromkeys(task.id for task, _ in pairs))
    grants = {}
    # Bound IN parameters while avoiding a source-ACL query per task. Preserve
    # the same user/device principal filter used by the single-item path.
    for offset in range(0, len(ids), 500):
        access = await session.scalars(select(models.TaskRequirementAccess).where(
            models.TaskRequirementAccess.task_id.in_(ids[offset:offset + 500]), principal_clause(client)))
        for row in access:
            grants.setdefault(row.task_id, []).append(row)
    from . import repository_issue_access
    repository_issues = await repository_issue_access.projection(session, client, [task for task, _ in pairs])
    from . import requirement_review_access
    reviewable = await requirement_review_access.pending_task_ids(session, client.user_ref,
        [task.id for task, api in pairs if api.get("requirementStage") == "reviewing"])
    prepared = _ListRead(context[0], scope, grants, repository_issues, reviewable)
    return [await decorate(session, client, task, api, context=context, prepared=prepared)
            for task, api in pairs]


async def prepare_notifications(session, task, clients):
    """Read one task's ACL inputs in batches, preserving account/device boundaries."""
    from . import rbac, repository_issue_access
    if not clients:
        return {}
    ids = list({client.user_ref for client in clients if client.user_ref})
    users = {}
    for offset in range(0, len(ids), 500):
        rows = await session.scalars(select(models.User).where(models.User.id.in_(ids[offset:offset + 500])))
        users.update((user.id, user) for user in rows)
    parents = {}
    if any(user.is_active and user.org_id and not user.is_super for user in users.values()):
        rows = await session.execute(select(models.OrgUnit.id, models.OrgUnit.parent_id))
        parents = {str(oid): (str(pid) if pid else "") for oid, pid in rows}
    grants = {}
    rows = await session.scalars(select(models.TaskRequirementAccess).where(
        models.TaskRequirementAccess.task_id == task.id))
    for grant in rows:
        grants.setdefault((grant.principal_kind, grant.principal_id), []).append(grant)
    # Repository projection already resolves the complete active membership of
    # each source. Reuse those facts across recipient devices; querying the same
    # source again for every account would make notification preparation O(N).
    repository_facts = await repository_issue_access.projection(session, None, [task])
    repository_members = {
        tid: {row["id"] for row in data["source"]["relatedUsers"]}
        for tid, data in repository_facts.items()
    }
    from . import requirement_review_access
    creator = str(getattr(task, "created_by", "") or "")
    reviewable = await requirement_review_access.pending_task_ids(session, creator, [task.id])
    scopes, prepared = {}, {}
    for client in clients:
        user = users.get(client.user_ref)
        key = (user.is_super, user.is_active, user.org_id) if user else None
        if key not in scopes:
            scopes[key] = await rbac.company_org_ids(session, user, parents=parents)
        principal = ("user", client.user_ref) if client.user_ref else ("client", client.id)
        repository_issues = {
            tid: {**data, "member": client.user_ref in repository_members[tid]}
            for tid, data in repository_facts.items()
        }
        prepared[client.id] = _ListRead(
            user, scopes[key], {task.id: list(grants.get(principal, []))}, repository_issues,
            reviewable if client.user_ref == creator else set())
    return prepared
