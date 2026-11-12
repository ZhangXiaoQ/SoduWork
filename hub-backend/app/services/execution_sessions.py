"""Provider-independent session index with incremental receipts and replay.

Endpoint-capable Runners retain transcript bodies. Hub metadata preserves event
ordering and audit identity; body reads report endpoint unavailability explicitly.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from . import execution_event_policy

_STATE_ALIASES = {
    "complete": "done", "completed": "done", "success": "done", "succeeded": "done",
    "error": "failed", "errored": "failed", "failure": "failed",
    "canceled": "cancelled", "aborted": "interrupted",
}
_TERMINAL = {
    "done", "failed", "stopped", "interrupted", "cancelled", "canceled",
    *_STATE_ALIASES.keys(),
}


def canonical_state(value, default: str = "") -> str:
    """Fold legacy/provider state names into the execution-session vocabulary."""
    state = str(value or "").strip().lower()
    return _STATE_ALIASES.get(state, state) or default


def is_terminal(value) -> bool:
    return canonical_state(value) in _TERMINAL


async def _get_or_create_session(session: AsyncSession, task_id: str,
                                 ref: str) -> am.ExecutionSession:
    """Return the one durable row for an execution ref under concurrent writers.

    The dispatch HTTP transaction and Runner telemetry can observe a new execution
    at the same time. A SELECT followed by INSERT is not atomic; a savepoint keeps
    the outer business transaction alive, then the losing writer loads the winner.
    """
    row = (await session.execute(select(am.ExecutionSession).where(
        am.ExecutionSession.ref == ref).limit(1))).scalar_one_or_none()
    if row is not None:
        return row
    candidate = am.ExecutionSession(task_id=task_id, ref=ref)
    try:
        async with session.begin_nested():
            session.add(candidate)
            await session.flush()
        return candidate
    except IntegrityError:
        row = (await session.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.ref == ref).limit(1))).scalar_one_or_none()
        if row is None:
            raise
        return row


async def _insert_event_once(session: AsyncSession, values: dict) -> None:
    """Insert one replay event idempotently across heartbeat/live-read writers."""
    from .cloud_sync_notifications import mark
    mark(session, "", execution_id=values.get("session_id"))
    dialect = session.get_bind().dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
        statement = insert(am.ExecutionEvent).values(**values).on_conflict_do_nothing(
            index_elements=["session_id", "seq"])
        await session.execute(statement)
        return
    if dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
        statement = insert(am.ExecutionEvent).values(**values).on_conflict_do_nothing(
            index_elements=["session_id", "seq"])
        await session.execute(statement)
        return
    try:
        async with session.begin_nested():
            session.add(am.ExecutionEvent(**values))
            await session.flush()
    except IntegrityError:
        return


def _dt(value) -> datetime | None:
    if value in (None, "", 0):
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    try:
        text = str(value).replace("Z", "+00:00")
        out = datetime.fromisoformat(text)
        return out if out.tzinfo else out.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError, OverflowError):
        return None


def _no_future(value: datetime | None, now: datetime, skew_seconds: int = 120) -> datetime | None:
    """Clamp timestamps more than two minutes in the future to server receipt time. Incorrect
    Runner time zones must not keep completed sessions appearing active.
    """
    if value is None:
        return None
    return value if value <= now + timedelta(seconds=skew_seconds) else now


async def _heal_lost_dispatch(session: AsyncSession, task: models.Task,
                              row: am.ExecutionSession) -> bool:
    """Reconcile a live session when its dispatch receipt was lost. Heartbeats are authoritative
    session evidence: recover eligible pending or receipt-unconfirmed tasks by recording an
    ai.dispatched event with a healed marker when no successful dispatch has claimed that
    reference. The recorded reference makes subsequent heartbeats idempotent and keeps detached
    execution consistent with Hub state."""
    if task.status not in {"todo", "doing"}:
        return False
    from . import ai_exec, task_events, task_status
    events = list((await session.execute(
        select(models.TaskEvent).where(
            models.TaskEvent.task_id == task.id,
            models.TaskEvent.kind.in_(ai_exec.KINDS_DISPATCH_STATE)
        ).order_by(models.TaskEvent.at.desc(), models.TaskEvent.id.desc())
    )).scalars().all())
    pending_exact = None
    pending_runner = None
    latest_start_at = None
    latest_failed_at = None
    now = datetime.now(timezone.utc)
    for event in events:
        detail = dict(event.detail or {})
        if event.kind in ai_exec.KINDS_DISPATCHED:
            if str(detail.get("ref") or detail.get("issueId") or "") == row.ref:
                return False
            continue
        event_at = _dt(event.at)
        if event.kind == ai_exec.EV_DISPATCH_FAILED:
            if latest_failed_at is None:
                latest_failed_at = event_at
        elif event.kind == ai_exec.EV_DISPATCH_UNCERTAIN:
            expected = str(detail.get("expectedRef") or "")
            same_runner = (str(detail.get("runnerId") or "") != "" and
                           str(detail.get("runnerId") or "") == str(row.runner_id or ""))
            if expected == row.ref and pending_exact is None:
                pending_exact = (detail, event_at)
            elif same_runner and pending_runner is None:
                pending_runner = (detail, event_at)
        elif event.kind == ai_exec.EV_DISPATCH_STARTED:
            if latest_start_at is None:
                latest_start_at = event_at
    pending, pending_at = pending_exact or pending_runner or (None, None)
    runner_fallback = pending_exact is None and pending_runner is not None
    # A same-runner fallback exists for old Runners that did not understand the
    # deterministic ref yet. It is valid only when the Hub first saw that session
    # after this dispatch intent; otherwise an old session on the same machine can
    # impersonate a new attempt.
    if (pending is not None and latest_start_at is not None and
            pending_at is not None and pending_at < latest_start_at):
        pending = None
        pending_at = None
    if runner_fallback and pending is not None:
        row_seen_at = _dt(row.created_at)
        if (latest_start_at is None or row_seen_at is None or
                row_seen_at < latest_start_at):
            pending = None
            pending_at = None
    recent_start = bool(
        latest_start_at is not None and now - latest_start_at <= timedelta(minutes=3))
    failed_after_start = bool(
        latest_failed_at is not None and latest_start_at is not None and
        latest_failed_at >= latest_start_at)
    # A normal Runner reports seq=0 immediately before its RPC reply. Give that
    # reply time to commit; otherwise every healthy dispatch gets a fake heal event.
    if pending is None and (task.status == "doing" or
                            (recent_start and not failed_after_start)):
        return False
    identity = dict(dict(row.metadata_ or {}).get("executionIdentity") or {})
    healed_from = "runner-ack-reconciliation" if pending else "session-heartbeat"
    summary = ("执行机回执已按会话实况确认" if pending else
               "安排执行回执丢失（执行机回执路径出错），已按会话实况自动接回")
    task_events.record(session, task.id, ai_exec.EV_DISPATCHED, {
        "ref": row.ref, "issueId": row.ref, "provider": "runner",
        "runnerId": row.runner_id, "host": row.host,
        "assigneeId": "runner:%s:%s" % (row.runner_id, row.engine or ""),
        "assigneeName": str(identity.get("agentName") or row.engine or "AI"),
        "assigneeCli": str(identity.get("agentName") or row.engine or ""),
        "attemptId": str((pending or {}).get("attemptId") or ""),
        "expectedRef": str((pending or {}).get("expectedRef") or row.ref),
        "healedFrom": healed_from,
        "summary": summary,
        "runnerVersion": str(identity.get("runnerVersion") or ""),
    }, actor="SoduWork")
    if task.status == "todo":
        await task_status.mark(session, task, "doing", why="执行会话实况接回")
    # Send throttled upgrade guidance when an outdated Runner may have lost its receipt.
    from . import update_nudges
    await update_nudges.nudge_stale_runner(
        str(task.owner_client_id or ""), str(identity.get("runnerVersion") or ""),
        row.host, healed=True)
    return True


async def confirm_uncertain_dispatch(session: AsyncSession, task: models.Task,
                                     expected_ref: str = "",
                                     runner_id: str = "") -> str:
    """Close an indeterminate ACK immediately when its heartbeat already arrived."""
    row = None
    if expected_ref:
        row = (await session.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.ref == str(expected_ref)[:180]).limit(1))
        ).scalar_one_or_none()
    if row is None and runner_id:
        row = (await session.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.task_id == task.id,
            am.ExecutionSession.runner_id == str(runner_id)[:80],
            am.ExecutionSession.state != "interrupted",
        ).order_by(am.ExecutionSession.started_at.desc().nullslast(),
                   am.ExecutionSession.created_at.desc(),
                   am.ExecutionSession.id.desc()).limit(1))).scalar_one_or_none()
    healed = bool(row is not None and await _heal_lost_dispatch(session, task, row))
    return str(row.ref or "") if healed else ""


def _event_api(row: am.ExecutionEvent) -> dict:
    detail = dict(row.detail or {})
    out = {"seq": int(row.seq or 0), "kind": row.kind or "out",
           "tool": row.tool or "", "text": row.text or "",
           "at": row.at.isoformat() if row.at else ""}
    for key in ("seg", "round", "admissionKey", "admissionStartSeq", "turnState", "textTruncated", "full", "sourceId", "callId", "isError",
                "streamId", "done", "delta", "arguments", "usage", "usageScope", "toolKind", "sentAt", "state", "cancelReason", "attachments", "plugins",
                "serviceUrl", "previewUrl", "host", "port", "services", "phase", "contentUnavailable"):
        if detail.get(key) not in (None, ""):
            out[key] = detail[key]
    return out


def _loaded_iso(row, field: str) -> str:
    """Serialize loaded timestamps without triggering asynchronous lazy loading of new
    server-default values.
    """
    value = row.__dict__.get(field)
    return value.isoformat() if value else ""


def _public_execution_context(value: dict | None) -> dict:
    from . import execution_context
    return execution_context.public(value)


def settlement_is_current(row: am.ExecutionSession, mark: dict | None = None) -> bool:
    """A terminal receipt belongs to a turn, not to the lifetime of a CLI ref.

    Legacy receipts did not carry a round. Treat those as the initial round,
    and also reject a failed receipt attached to a now-successful execution.
    This repairs persisted pre-upgrade sessions without rewriting their events.
    """
    meta = dict(row.metadata_ or {})
    mark = dict(mark if mark is not None else meta.get("terminalSettlement") or {})
    state = canonical_state(row.state)
    if not mark or not is_terminal(state):
        return False
    if int(mark.get("round") or 1) != int(meta.get("round") or 1):
        return False
    settled_state = canonical_state(mark.get("executionState"))
    if settled_state and settled_state != state:
        return False
    if mark.get("state") == "failed" and state == "done":
        return False
    if mark.get("state") in {"done", "done_no_output", "delegated"} and state != "done":
        return False
    settled_at, started_at = _dt(mark.get("at")), _dt(row.started_at)
    return not (settled_at and started_at and settled_at < started_at)


def session_api(row: am.ExecutionSession, *, items: list | None = None) -> dict:
    meta = dict(row.metadata_ or {})
    settlement = dict(meta.get("terminalSettlement") or {})
    state = canonical_state(row.state, "running")
    return {
        'executionContext': _public_execution_context(
            meta.get('executionContext')),
        "id": row.id, "ref": row.ref, "taskId": row.task_id,
        "workflowRunId": row.workflow_run_id, "nodeRunId": row.node_run_id,
        "runnerId": row.runner_id, "runnerClientId": row.runner_client_id,
        "host": row.host, "engine": row.engine, "model": row.model,
        "activeExecutionSelection": {"agentId": row.engine or "", "modelName": row.model or "",
            "reasoningEffort": str(meta.get("reasoningEffort") or "")},
        "status": state, "seq": int(row.seq or 0), "last": int(row.seq or 0),
        "persistedThrough": int(row.persisted_seq or 0),
        "workDir": row.work_dir, "startedAt": row.started_at.isoformat() if row.started_at else "",
        "finishedAt": row.finished_at.isoformat() if row.finished_at else "",
        "createdAt": _loaded_iso(row, "created_at"),
        "updatedAt": _loaded_iso(row, "updated_at"),
        "lastEventAt": _loaded_iso(row, "last_event_at"),
        "canStop": state in {"queued", "dispatching", "running"},
        "queued": state == "queued",
        "queuePosition": max(0, int(meta.get("queuePosition") or 0)),
        "queueClass": str(meta.get("queueClass") or ""),
        "detached": bool(meta.get("detached")),
        "segment": int(meta.get("segment") or 1), "round": int(meta.get("round") or 1),
        "tokens": dict(meta.get("tokens") or {}),
        "ctxPct": float(meta.get("ctxPct") or 0), "ctxWindow": int(meta.get("ctxWindow") or 0),
        "ctxWindowKnown": bool(meta.get("ctxWindowKnown")),
        # Read terminal diagnostics from older records that stored failure details only at settlement.
        # Present them as auditable diagnostics, never fabricated AI conversation text.
        "error": str((meta.get("error") if "error" in meta else
                     settlement.get("error") if settlement_is_current(row, settlement) else "") or ""),
        "failureKind": str(meta.get("failureKind") or ""),
        "failurePath": str(meta.get("failurePath") or ""),
        "identity": dict(meta.get("executionIdentity") or {}),
        # Keep cumulative usage and first-start time separate from per-step context occupancy.
        "usage": dict(meta.get("usage") or {}), "firstStarted": meta.get("firstStarted") or 0,
        "items": items or [], "ok": True, "persisted": True,
    }


def _epoch(value) -> float:
    """Convert datetime to epoch seconds, matching the local console's time.time() timestamps."""
    if not value:
        return 0.0
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.timestamp()


async def console_rows(session: AsyncSession, client_id: str,
                       exclude_refs: set[str] | None = None, limit: int = 40) -> list[dict]:
    """List remote sessions in the same shape as local consoles using persisted session rows. Avoid
    frequent Runner broadcasts and retain routing across backend restarts.
    """
    from . import task_access
    client = await session.get(models.Client, client_id)
    if client is None:
        return []
    exclude = exclude_refs or set()
    rows = (await session.execute(
        select(am.ExecutionSession, models.Task)
        .join(models.Task, models.Task.id == am.ExecutionSession.task_id)
        .where(task_access.owner_clause(client))
        .order_by(am.ExecutionSession.started_at.desc())
        .limit(limit * 2))).all()
    out = []
    for row, task in rows:
        if not row.ref or row.ref in exclude:
            continue
        meta = dict(row.metadata_ or {})
        out.append({
            "ref": row.ref, "taskId": row.task_id, "title": task.title or "",
            "cli": row.engine or "", "cliName": row.engine or "",
            "state": canonical_state(row.state), "started": _epoch(row.started_at),
            "ended": _epoch(row.finished_at), "seq": int(row.seq or 0),
            "segment": int(meta.get("segment") or 1), "round": int(meta.get("round") or 1),
            "detached": bool(meta.get("detached")),
            "ctxPct": float(meta.get("ctxPct") or 0), "tokens": dict(meta.get("tokens") or {}),
            "ctxWindow": int(meta.get("ctxWindow") or 0),
            "ctxWindowKnown": bool(meta.get("ctxWindowKnown")),
            "queued": 1 if canonical_state(row.state) == "queued" else 0,
            "queuePosition": max(0, int(meta.get("queuePosition") or 0)),
            "queueClass": str(meta.get("queueClass") or ""),
            "error": str(meta.get("error") or ""),
            "usage": dict(meta.get("usage") or {}),
            "firstStarted": meta.get("firstStarted") or _epoch(row.started_at),
            "workDir": row.work_dir or "", "local": False,
            # Include Runner and host identity to distinguish similarly named seats.
            "runnerId": row.runner_id or "", "host": row.host or "", "model": row.model or "",
            "identity": dict(meta.get("executionIdentity") or {}),
        })
    out.sort(key=lambda x: (x["state"] != "running", -(x["started"] or 0)))
    return out[:limit]


async def _allowed(session: AsyncSession, runner, task: models.Task, *, ref: str = "") -> bool:
    from . import environment_service, runner_hub
    personal_owner = str(getattr(runner, "owner_user_id", "") or "")
    if personal_owner:
        # Personal nodes are intentionally excluded from organization sharing.
        # Returning facts uses the same durable, exact-owner cloud grant as
        # dispatch, including its pinned Runner and execution ref.
        from . import conversation_handoffs, dispatch_identity
        node = await session.get(am.RunnerNode, runner.id)
        handoff = await conversation_handoffs.dispatch_record(session, task.id)
        if (node is None or node.owner_user_id != personal_owner or node.auth_state == "revoked"
                or node.management_state in {"retired", "pending_setup"}
                or handoff is None or handoff.owner_user_id != personal_owner
                or handoff.owner_client_id != task.owner_client_id
                or handoff.phase not in {"committing", "committed"}):
            return False
        if task.owner_user_id and task.owner_user_id != personal_owner:
            return False
        if not task.owner_user_id:
            original = await session.get(models.Client, task.owner_client_id)
            if (original is None or original.user_ref != personal_owner
                    or task.created_by not in (None, "", personal_owner)):
                return False
        receipt, options = dict(handoff.receipt or {}), dict(handoff.options or {})
        expected_runner = str((options.get("targetSnapshot") or {}).get("runnerId")
                              or receipt.get("runnerId") or "")
        if not expected_runner:
            target = str(options.get("assigneeId") or "").rsplit(":", 1)[0]
            expected_runner = target[len("runner:"):] if target.startswith("runner:") else ""
        expected_ref = str(receipt.get("ref") or receipt.get("issueId") or
                           dispatch_identity.execution_ref(conversation_handoffs.dispatch_id(handoff)))
        return expected_runner == runner.id and bool(ref) and expected_ref == ref
    allowed_clients = await environment_service.task_runner_clients(session, task)
    allowed_orgs = await environment_service.task_runner_orgs(session, task)
    return runner_hub.in_scope(runner, allowed_clients, allowed_orgs)


async def record_dispatch(session: AsyncSession, task: models.Task, dispatch: dict, *,
                          workflow_run_id: str = "", node_run_id: str = "") -> None:
    """Persist an execution immediately after successful dispatch, before its first heartbeat. This
    establishes authoritative routing for terminals, directories, artifacts, and cancellation;
    later heartbeats idempotently update the same ref.
    """
    ref = str(dispatch.get("issueId") or dispatch.get("ref") or "")[:180]
    if not ref:
        return
    rid = str(dispatch.get("runnerId") or "")[:80]
    if not rid and (str(dispatch.get("provider") or "") == "local"
                    or str(dispatch.get("assigneeId") or "").startswith("local:")):
        rid = "backend-local"
    row = await _get_or_create_session(session, task.id, ref)
    row.task_id = task.id
    # Persist exact plugin-node identity in the dispatch transaction so evidence never relies on time-window inference.
    if workflow_run_id:
        row.workflow_run_id = str(workflow_run_id)[:36]
    if node_run_id:
        row.node_run_id = str(node_run_id)[:36]
    if rid:
        from . import runner_hub
        runner = None if rid == "backend-local" else runner_hub.get(rid)
        row.runner_id = rid
        row.runner_client_id = str(
            task.owner_client_id if rid == "backend-local"
            else getattr(runner, "client_id", "") or "")[:64]
        row.host = str(dispatch.get("host") or getattr(runner, "host", "")
                       or ("后端执行机" if rid == "backend-local" else "")
                       or row.host or "")[:100]
    else:
        row.host = str(dispatch.get("host") or row.host or "")[:100]
    row.engine = str(dispatch.get("agentCli") or dispatch.get("assigneeCli")
                     or row.engine or "")[:60]
    if dispatch.get("model"):
        row.model = str(dispatch.get("model") or "")[:160]
    row.state = canonical_state(row.state)
    incoming_state = canonical_state(dispatch.get("state"), "running")
    if row.state not in _TERMINAL:
        row.state = (incoming_state if incoming_state in {
            "queued", "dispatching", "running"} else "running")
    if row.state in {"dispatching", "running"}:
        row.started_at = row.started_at or datetime.now(timezone.utc)
    meta = dict(row.metadata_ or {})
    meta.setdefault("round", max(1, int(dispatch.get("round") or 1)))
    meta["queued"] = row.state == "queued"
    meta["queuePosition"] = max(0, int(dispatch.get("queuePosition") or 0))
    meta["queueClass"] = str(dispatch.get("queueClass") or "")[:24]
    if dispatch.get("runnerBootId"):
        # Queue payloads deliberately stay in Runner memory.  Persist only the process
        # identity so a later reconnect can distinguish a network flap (same boot) from
        # a real process restart that has lost the queue.
        meta["runnerBootId"] = str(dispatch.get("runnerBootId") or "")[:64]
    from . import execution_identity
    identity_data = dict(dispatch)
    if rid and rid != "backend-local":
        runner = runner_hub.get(rid)
        if runner is not None:
            identity_data.setdefault("runnerClientId", getattr(runner, "client_id", ""))
            identity_data.setdefault("runnerVersion", getattr(runner, "version", ""))
            cli = str(identity_data.get("agentCli") or identity_data.get("assigneeCli") or "")
            agent = next((item for item in (getattr(runner, "agents", []) or [])
                          if str(item.get("key") or "") == cli), {})
            identity_data.setdefault("agentCliName", agent.get("name") or cli)
            identity_data.setdefault("agentCliVersion", agent.get("version") or "")
    meta["executionIdentity"] = execution_identity.from_dispatch(
        identity_data, workflow_run_id=workflow_run_id, node_run_id=node_run_id,
        current=meta.get("executionIdentity"))
    row.metadata_ = meta
    from . import project_context
    if dispatch.get('executionContext'):
        meta['executionContext'] = _public_execution_context(
            dispatch.get('executionContext'))
        row.metadata_ = meta
    # A new dispatch supersedes pending automatic rework delivery.
    # Clear it to avoid sending old feedback to a previous session while the new execution runs.
    routing = dict(task.work_routing or {})
    if routing.pop("reworkPending", None) is not None:
        task.work_routing = routing
        from . import task_events
        task_events.record(session, task.id, "ai.rework_taken",
                           {"ref": ref, "by": "dispatch"})
    await project_context.record_dispatch(
        session, task, dispatch, execution_ref=ref)


async def task_runner_route(session: AsyncSession, task_id: str) -> dict:
    """Resolve current task execution from the newest persisted session, returning runnerId, ref,
    and host. Use dispatch history only for legacy tasks without a session row; backend-local
    execution has no remote Runner ID.
    """
    # Order dispatches primarily by started_at, not second-resolution created_at.
    # record_dispatch supplies an application timestamp for each dispatch.
    # Use that higher precision to distinguish closely spaced executions.
    row = (await session.execute(select(am.ExecutionSession).where(
        am.ExecutionSession.task_id == task_id
    ).order_by(am.ExecutionSession.started_at.desc().nullslast(),
               am.ExecutionSession.created_at.desc()).limit(1))).scalar_one_or_none()
    if row is not None:
        rid = str(row.runner_id or "")
        return {"runnerId": "" if rid == "backend-local" else rid,
                "ref": row.ref or "", "host": row.host or ""}
    from . import ai_exec
    ev = await ai_exec.last_dispatch_event(session, task_id)
    route = (ev.detail or {}) if ev is not None else {}
    return {"runnerId": str(route.get("runnerId") or ""),
            "ref": str(route.get("ref") or route.get("issueId") or ""),
            "host": str(route.get("host") or "")}


async def warm_remote_cache(session: AsyncSession) -> int:
    """Warm ai_remote's ref-to-Runner cache from nonterminal sessions at startup so initial status,
    artifact, and cancellation requests route directly.
    """
    rows = (await session.execute(select(am.ExecutionSession).where(
        am.ExecutionSession.state.not_in(tuple(_TERMINAL)),
        am.ExecutionSession.runner_id != "",
        am.ExecutionSession.runner_id != "backend-local",
    ))).scalars().all()
    from . import ai_remote
    for row in rows:
        ai_remote.remember(row.ref, row.runner_id)
    return len(rows)


async def reconcile_runner_restart(session: AsyncSession, runner) -> list[dict]:
    """Close queued rows whose in-memory admission queue died with a Runner process.

    A WebSocket reconnect keeps ``boot_id`` and therefore keeps the live queue.  A
    process restart changes it; queued payloads (and their short-lived credentials) are
    intentionally not persisted.  Leaving those rows as ``queued`` forever is worse than
    an explicit interruption: the normal task retry/redispatch path can safely rebuild
    fresh credentials and inputs, while an old payload cannot be replayed safely.
    """
    runner_id = str(getattr(runner, "id", "") or "")[:80]
    boot_id = str(getattr(runner, "boot_id", "") or "")[:64]
    if not runner_id or not boot_id:
        return []
    rows = list((await session.execute(select(am.ExecutionSession).where(
        am.ExecutionSession.runner_id == runner_id,
        am.ExecutionSession.state == "queued",
    ))).scalars().all())
    stale = []
    for row in rows:
        meta = dict(row.metadata_ or {})
        previous_boot = str(meta.get("runnerBootId") or "")
        # Old rows have no reliable process identity.  Do not guess: only new-protocol
        # rows can be closed authoritatively.
        if not previous_boot or previous_boot == boot_id:
            continue
        row.state = "interrupted"
        row.finished_at = row.finished_at or datetime.now(timezone.utc)
        meta["queued"] = False
        meta["queuePosition"] = 0
        meta["error"] = (
            "执行机在需求排队期间重启，内存队列已安全失效；请从需求中重新安排执行。")
        meta["interruptedReason"] = "runner-restarted-before-launch"
        meta["observedRunnerBootId"] = boot_id
        row.metadata_ = meta
        stale.append(row)
        session.add(models.TaskEvent(
            task_id=row.task_id, kind="ai.session_reconciled", actor="SoduWork",
            detail={"ref": row.ref, "from": "queued", "to": "interrupted",
                    "reason": meta["error"], "runnerId": runner_id}))
    if not stale:
        return []
    task_ids = {row.task_id for row in stale}
    tasks = {task.id: task for task in list((await session.execute(
        select(models.Task).where(models.Task.id.in_(task_ids)))).scalars().all())}
    return [{"taskId": row.task_id,
             "clientId": str(getattr(tasks.get(row.task_id), "owner_client_id", "") or ""),
             "session": session_api(row)} for row in stale]


async def reconcile_local_sessions(session: AsyncSession) -> int:
    """Reconcile local session rows with archives after ai_local.reclaim. Use archived state when
    present; mark missing runs interrupted without completing their tasks. Claim legacy rows
    only with explicit local-provider evidence.
    """
    rows = list((await session.execute(select(am.ExecutionSession).where(
        am.ExecutionSession.state.not_in(tuple(_TERMINAL)),
        am.ExecutionSession.runner_id.in_(("", "backend-local")),
    ))).scalars().all())
    if not rows:
        return 0
    task_ids = {row.task_id for row in rows if row.runner_id != "backend-local"}
    local_refs: set[str] = set()
    if task_ids:
        events = list((await session.execute(select(models.TaskEvent).where(
            models.TaskEvent.task_id.in_(task_ids)
        ).order_by(models.TaskEvent.at.desc()))).scalars().all())
        for event in events:
            detail = dict(event.detail or {})
            ref = str(detail.get("ref") or detail.get("issueId") or "")
            if ref and (str(detail.get("provider") or "") == "local"
                        or str(detail.get("assigneeId") or "").startswith("local:")):
                local_refs.add(ref)
    candidates = [row for row in rows
                  if row.runner_id == "backend-local" or row.ref in local_refs]
    if not candidates:
        return 0
    import asyncio
    from . import ai_local
    now = datetime.now(timezone.utc)
    changed = 0
    for row in candidates:
        info = await asyncio.to_thread(ai_local.runner_info_sync, {}, row.ref)
        old = row.state
        if info:
            state = str(info.get("taskStatus") or (
                "failed" if info.get("failed") else "done" if info.get("done") else "running"))
            row.state = canonical_state(state, "running")[:32]
            row.work_dir = str(info.get("workDir") or row.work_dir or "")[:700]
            error = str(info.get("error") or "")[:1000]
        else:
            row.state = "interrupted"
            error = "本机执行存档已不存在；服务启动时已按中断收敛，请从需求中重试。"
        if row.state in _TERMINAL:
            row.finished_at = row.finished_at or now
        meta = dict(row.metadata_ or {})
        if error:
            meta["error"] = error
        row.metadata_ = meta
        if row.state != old:
            changed += 1
            session.add(models.TaskEvent(
                task_id=row.task_id, kind="ai.session_reconciled", actor="SoduWork",
                detail={"ref": row.ref, "from": old, "to": row.state,
                        "reason": error[:300]}))
    return changed


async def reconcile_lost_dispatches(session: AsyncSession, days: int = 30) -> int:
    """Reconcile historical lost dispatch receipts at startup, including already-terminal sessions
    without future heartbeats. Restore dispatch facts idempotently with healed events; never
    infer successful task delivery.
    """
    since = datetime.now(timezone.utc) - timedelta(days=max(1, int(days)))
    rows = list((await session.execute(
        select(am.ExecutionSession).where(
            am.ExecutionSession.created_at >= since,
            # Do not use sessions already reconciled as interrupted to change task state again.
            # Recover each task once, preferring its latest session.
            am.ExecutionSession.state != "interrupted",
        # Use ID only as a deterministic tie-breaker for equal timestamps.
        ).order_by(am.ExecutionSession.created_at.desc(), am.ExecutionSession.id.desc())
    )).scalars().all())
    if not rows:
        return 0
    task_ids = {row.task_id for row in rows}
    tasks = {t.id: t for t in list((await session.execute(
        select(models.Task).where(
            models.Task.id.in_(task_ids),
            models.Task.status.in_(("todo", "doing")),
        )
    )).scalars().all())}
    healed = 0
    for row in rows:
        task = tasks.get(row.task_id)
        if task is None:
            continue
        if await _heal_lost_dispatch(session, task, row):
            healed += 1
    return healed


async def ingest_event_page(session: AsyncSession, row, items: list, round_no=None) -> set[int]:
    """Retain an authorized page without changing execution state, identity or billing."""
    events = [x for x in items if isinstance(x, dict) and int(x.get("seq") or 0) > 0]
    seqs = {int(x["seq"]) for x in events}
    have = set((await session.scalars(select(am.ExecutionEvent.seq).where(
        am.ExecutionEvent.session_id == row.id, am.ExecutionEvent.seq.in_(seqs)))).all()) if seqs else set()
    now = datetime.now(timezone.utc)
    prepared = []
    for item in events:
        seq = int(item["seq"])
        if seq in have:
            continue
        detail = {}
        if item.get("seg") is not None:
            detail["seg"] = int(item.get("seg") or 0)
        if item.get("round") is not None or round_no is not None:
            detail["round"] = max(1, int(item.get("round") or round_no or 1))
        source_id = item.get("sourceId") or item.get("_sourceId")
        if source_id:
            detail["sourceId"] = str(source_id)[:360]
        if item.get("full"):
            detail["full"] = str(item["full"])[:20000]
        if item.get("callId"):
            detail["callId"] = str(item["callId"])[:360]
        if "isError" in item:
            detail["isError"] = bool(item["isError"])
        from .runtime_messages import public_fields
        detail.update(public_fields(item))
        if item.get("kind") == "say" and (len(str(item.get("full") or "")) > 20000
                or len(str(item.get("text") or "")) > (50000 if item.get("streamId") else 4000)):
            detail["textTruncated"] = True
        if item.get("kind") == "user" and isinstance(item.get("plugins"), list):
            from .conversation_plugins import badges
            detail["plugins"] = badges(item["plugins"])
        if item.get("kind") == "user" and isinstance(item.get("attachments"), list):
            # Runner paths belong to another machine; retain visible names only.
            detail["attachments"] = [{"name": str(part.get("name") or "")[:200]}
                for part in item["attachments"][:20] if isinstance(part, dict) and part.get("name")]
        at = _no_future(_dt(item.get("at")), now) or now
        prepared.append({
            "session_id": row.id, "seq": seq, "kind": str(item.get("kind") or "out")[:32],
            "tool": str(item.get("tool") or "")[:120],
            "text": str(item.get("text") or "")[:50000 if item.get("streamId") else 4000],
            "detail": detail, "at": at,
        })
        have.add(seq)
        if row.last_event_at is None or _dt(row.last_event_at) < at:
            row.last_event_at = at
    from . import endpoint_events
    for values in await endpoint_events.externalize(session, row, prepared):
        await _insert_event_once(session, values)
    await advance_persisted_sequence(session, row)
    return seqs


async def advance_persisted_sequence(session: AsyncSession, row, *, persist: bool = True) -> int:
    """Advance only over committed-candidate events with no missing sequence.

    A snapshot's high-water mark and a transport packet ACK are not evidence
    that all preceding events exist. Scan bounded query pages so a read-only
    transaction can recover old rows without stalling permanently at page 4096.
    """
    through = int(row.persisted_seq or 0)
    while True:
        sequences = (await session.scalars(select(am.ExecutionEvent.seq).where(
            am.ExecutionEvent.session_id == row.id,
            am.ExecutionEvent.seq > through).order_by(am.ExecutionEvent.seq).limit(4096))).all()
        gap = False
        for sequence in sequences:
            if sequence != through + 1:
                gap = True
                break
            through = sequence
        if gap or len(sequences) < 4096:
            break
    if persist:
        row.persisted_seq = through
    return through


async def ingest_runner_snapshots(session: AsyncSession, runner, snapshots: list) -> list[dict]:
    """Idempotently ingest session deltas from Runner heartbeats and return summaries requiring
    client notification.
    """
    clean = [x for x in snapshots if isinstance(x, dict) and x.get("ref") and x.get("taskId")]
    if not clean:
        return []
    task_ids = {str(x["taskId"]) for x in clean}
    tasks = {x.id: x for x in list((await session.execute(
        select(models.Task).where(models.Task.id.in_(task_ids)))).scalars().all())}
    owner_ids = {str(x.owner_client_id) for x in tasks.values() if x.owner_client_id}
    owners = {}
    if owner_ids:
        owners = {x.id: x for x in (await session.execute(
            select(models.Client).where(models.Client.id.in_(owner_ids))
        )).scalars().all()}
    billing_ids = {str(x.assignee_user_id) for x in tasks.values()
                   if x.assignee_user_id}
    billing_ids.update(str(x.user_ref) for x in owners.values() if x.user_ref)
    billing_users = {}
    if billing_ids:
        billing_users = {x.id: x for x in (await session.execute(
            select(models.User).where(models.User.id.in_(billing_ids))
        )).scalars().all()}
    refs = {str(x["ref"])[:180] for x in clean}
    existing = {x.ref: x for x in list((await session.execute(
        select(am.ExecutionSession).where(am.ExecutionSession.ref.in_(refs))
        .with_for_update())).scalars().all())}
    changed: list[dict] = []
    for snap in clean:
        task = tasks.get(str(snap.get("taskId") or ""))
        if task is None or not await _allowed(session, runner, task, ref=str(snap.get("ref") or "")):
            continue
        ref = str(snap.get("ref") or "")[:180]
        row = existing.get(ref)
        if row is None:
            row = await _get_or_create_session(session, task.id, ref)
            existing[ref] = row
        runner_id = str(getattr(runner, "id", "") or "")[:80]
        if row.task_id != task.id or (row.runner_id and row.runner_id != runner_id):
            continue
        old_state = canonical_state(row.state)
        previous_meta = dict(row.metadata_ or {})
        previous_round = int(previous_meta.get("round") or 1)
        incoming_round = int(snap.get("round") or previous_round)
        incoming_state = canonical_state(snap.get("status") or snap.get("state"))
        if (incoming_round < previous_round or
                (incoming_round == previous_round and (
                    int(snap.get("seq") or 0) < int(row.seq or 0) or
                    (old_state in _TERMINAL and incoming_state not in _TERMINAL)))):
            # Delayed transport may repair historical gaps but cannot rewind a
            # newer round, its billing identity, approvals or terminal settlement.
            await ingest_event_page(session, row, snap.get("items") or [], snap.get("round"))
            changed.append({"taskId": task.id, "clientId": task.owner_client_id or "",
                            "session": session_api(row)})
            continue
        row.task_id = task.id
        row.runner_id = str(getattr(runner, "id", "") or "")[:80]
        row.runner_client_id = str(getattr(runner, "client_id", "") or "")[:64]
        row.host = str(getattr(runner, "host", "") or "")[:100]
        row.engine = str(snap.get("cli") or snap.get("engine") or row.engine or "")[:60]
        if "model" in snap:
            row.model = str(snap.get("model") or "")[:160]
        row.state = canonical_state(
            snap.get("status") or snap.get("state") or row.state, "running")[:32]
        state_changed = old_state != row.state
        row.work_dir = str(snap.get("workDir") or row.work_dir or "")[:700]
        now = datetime.now(timezone.utc)
        row.started_at = _no_future(_dt(snap.get("started")), now) or row.started_at
        # Admission can already say running while preflight is still pending.
        # Only the actual Agent child launch marker can enqueue Issue writeback;
        # it also survives a short run finishing between two heartbeats.
        if (row.state not in {"queued", "dispatching", "starting"} and not snap.get("queued")
                and _dt(snap.get("executionStartedAt")) is not None):
            from . import repository_issue_access
            await repository_issue_access.record_started(session, task)
        if row.state in _TERMINAL:
            row.finished_at = _no_future(_dt(snap.get("ended")), now) \
                or row.finished_at or now
        meta = dict(row.metadata_ or {})
        next_round = int(snap.get("round") or previous_round)
        new_turn = next_round > previous_round or (
            old_state in _TERMINAL and row.state not in _TERMINAL)
        if new_turn:
            # Keep the transcript and task audit events; retire only the current
            # turn's status/settlement so a resumed ref can deliver again.
            for key in ("terminalSettlement", "error", "failureKind", "failurePath"):
                meta.pop(key, None)
            row.finished_at = (_no_future(_dt(snap.get("ended")), now) or now
                               if row.state in _TERMINAL else None)
        for src, dest in (("segment", "segment"), ("round", "round"),
                          ("detached", "detached"),
                          ("queued", "queued"),
                          ("queuePosition", "queuePosition"),
                          ("queueClass", "queueClass"), ("reasoningEffort", "reasoningEffort"),
                          ("tokens", "tokens"), ("ctxPct", "ctxPct"),
                          ("usage", "usage"), ("firstStarted", "firstStarted"),
                          ("ctxWindow", "ctxWindow"), ("ctxWindowKnown", "ctxWindowKnown"),
                          ("error", "error"), ("failureKind", "failureKind"),
                          ("failurePath", "failurePath")):
            if snap.get(src) is not None:
                meta[dest] = snap[src]
        from . import execution_identity
        from . import turn_correlation
        if snap.get("turnCorrelationVersion") == 1:
            meta["admissionKey"] = turn_correlation.key(snap.get("admissionKey"))
            meta["turnCorrelationVersion"] = 1
            if type(snap.get("admissionStartSeq")) is int and snap["admissionStartSeq"] >= 0:
                meta["admissionStartSeq"] = snap["admissionStartSeq"]
            else:
                meta.pop("admissionStartSeq", None)
        elif new_turn:
            meta.pop("admissionKey", None)
            meta.pop("admissionStartSeq", None)
            meta.pop("turnCorrelationVersion", None)
        meta["executionIdentity"] = execution_identity.from_snapshot(
            meta.get("executionIdentity"), snap, runner)
        if not row.model and "model" not in snap:
            row.model = str(meta["executionIdentity"].get("model") or "")[:160]
        row.metadata_ = meta
        settlement = dict(meta.get("terminalSettlement") or {})
        settlement_state = str(settlement.get("state") or "")
        needs_terminal_settlement = (
            row.state in _TERMINAL
            and (not settlement_is_current(row, settlement) or
                 settlement_state not in {"done", "done_no_output", "delegated", "superseded", "failed"})
        )

        seqs = await ingest_event_page(session, row, snap.get("items") or [], snap.get("round"))
        row.seq = max(int(row.seq or 0), int(snap.get("seq") or 0),
                      max(seqs) if seqs else 0)
        from . import usage_ledger
        owner = owners.get(str(task.owner_client_id or ""))
        billing_id = str(task.assignee_user_id or (
            owner.user_ref if owner else "") or "")
        await usage_ledger.from_execution(
            session, row, task, owner_client=owner,
            billing_user=billing_users.get(billing_id))
        if row.runner_id and row.runner_id != "backend-local":
            # Refresh ai_remote's execution-to-Runner cache from heartbeats.
            # This restores direct routing after a backend restart without broadcast lookups.
            from . import ai_remote
            ai_remote.remember(row.ref, row.runner_id)
        item = {"taskId": task.id, "clientId": task.owner_client_id or "",
                "session": session_api(row)}
        healed = await _heal_lost_dispatch(session, task, row)
        # Session state is authoritative for whether an executor is still running; push task snapshots when it changes.
        # Stream event bodies through execution.updated to avoid high-frequency task redraws.
        if state_changed or healed:
            await session.flush()
            from .tasks import task_to_api_live
            item["task"] = await task_to_api_live(session, task)
        # Do not settle terminal outputs inside the Runner WebSocket receive coroutine.
        # That coroutine must keep reading RPC replies; emit an idempotent settlement signal that heartbeats can retry until persisted.
        if needs_terminal_settlement:
            item["settleTerminal"] = row.state
        changed.append(item)
    return changed


async def ingest_live_snapshot(session: AsyncSession, task: models.Task, ref: str,
                               live: dict, dispatch: dict | None = None) -> dict | None:
    """Retain server-side replay events when reading older Runner or backend-local activity. This
    compatibility path matches heartbeat-based retention during rolling upgrades.
    """
    if not ref or not live.get("ok"):
        return None
    dispatch = dict(dispatch or {})
    rid = str(live.get("runnerId") or dispatch.get("runnerId") or "backend-local")
    # A reader's device is not the executor. Use the durable registry for
    # remote snapshots; unknown remote nodes must not mint execution identity.
    node = await session.get(am.RunnerNode, rid) if rid != "backend-local" else None
    if rid != "backend-local" and (node is None or node.auth_state == "revoked"
            or node.management_state in {"retired", "pending_setup"}):
        return None
    if node and node.owner_user_id:
        owner = await session.get(models.Client, task.owner_client_id)
        if (owner is None or owner.auth_state != "active"
                or owner.user_ref != node.owner_user_id
                or (task.owner_user_id and task.owner_user_id != node.owner_user_id)):
            return None
    runner = SimpleNamespace(
        id=rid,
        client_id=str(node.client_id or "") if node else str(task.owner_client_id or ""),
        org_id=str(node.org_id or "") if node else "",
        host=str(live.get("host") or dispatch.get("host") or "后端执行机"),
    )
    snap = {
        "ref": ref, "taskId": task.id,
        "cli": live.get("cli") or dispatch.get("assigneeCli") or "",
        "model": live.get("model", dispatch.get("model") or ""),
        "reasoningEffort": (live.get("activeExecutionSelection") or {}).get("reasoningEffort", ""),
        "status": live.get("status") or live.get("state") or "running",
        "state": live.get("status") or live.get("state") or "running",
        "seq": live.get("seq") or live.get("last") or 0,
        "items": list(live.get("items") or []), "workDir": live.get("workDir") or "",
        "started": live.get("started") or dispatch.get("at") or 0,
        "executionStartedAt": live.get("executionStartedAt") or 0,
        "ended": live.get("ended") or 0, "segment": live.get("segment") or 1,
        "round": live.get("round") or 1,
        "detached": bool(live.get("detached")), "tokens": dict(live.get("tokens") or {}),
        "queued": bool(live.get("queued") or
                       str(live.get("status") or live.get("state") or "") == "queued"),
        "queuePosition": max(0, int(live.get("queuePosition") or 0)),
        "queueClass": str(live.get("queueClass") or ""),
        "ctxPct": live.get("ctxPct") or 0, "ctxWindow": live.get("ctxWindow") or 0,
        "ctxWindowKnown": bool(live.get("ctxWindowKnown")), "error": live.get("error") or "",
        "failureKind": live.get("failureKind") or "",
        "failurePath": live.get("failurePath") or "",
        "cliName": live.get("cliName") or "",
        "cliVersion": live.get("cliVersion") or dispatch.get("agentCliVersion") or "",
        "cliSessionId": live.get("cliSid") or dispatch.get("agentSessionId") or "",
        "runnerVersion": live.get("runnerVersion") or dispatch.get("runnerVersion") or "",
        "executionIdentity": live.get("identity") or dispatch.get("identity") or {},
        # Persist token usage during local execution read-through. Local runs have no heartbeat,
        # so this is their usage-accounting persistence path.
        "usage": dict(live.get("usage") or {}),
        "firstStarted": live.get("firstStarted") or 0,
    }
    if live.get("turnCorrelationVersion") == 1:
        from . import turn_correlation
        snap.update(admissionKey=turn_correlation.key(live.get("admissionKey")),
            admissionStartSeq=live.get("admissionStartSeq"), turnCorrelationVersion=1)
    changed = await ingest_runner_snapshots(session, runner, [snap])
    return changed[0]["session"] if changed else None


async def read_task(session: AsyncSession, task_id: str, ref: str = "", since: int = 0,
                    limit: int = 400, *, contiguous: bool = False) -> dict | None:
    query = select(am.ExecutionSession).where(am.ExecutionSession.task_id == task_id)
    if ref:
        query = query.where(am.ExecutionSession.ref == ref)
    row = (await session.execute(query.order_by(
        am.ExecutionSession.updated_at.desc(), am.ExecutionSession.created_at.desc()))).scalars().first()
    if row is None:
        return None
    through = await advance_persisted_sequence(session, row, persist=False)
    event_query = select(am.ExecutionEvent).where(
        am.ExecutionEvent.session_id == row.id,
        am.ExecutionEvent.seq > max(0, int(since or 0)))
    if contiguous:
        event_query = event_query.where(am.ExecutionEvent.seq <= through)
    events = list((await session.execute(event_query.order_by(am.ExecutionEvent.seq).limit(
            min(1000, max(1, int(limit or 400)))))).scalars().all())
    from . import endpoint_events
    visible = execution_event_policy.visible_items(
        [_event_api(x) for x in await endpoint_events.hydrate(events, session=session)])
    out = session_api(row, items=visible)
    out["persistedThrough"] = through
    out["last"] = int(events[-1].seq) if events else int(since or 0)
    # Old best-effort histories can contain a permanent gap. Ordinary history
    # readers retain their visible suffix; sync readers must stop before it.
    next_available, stored_last = (await session.execute(select(
        func.min(am.ExecutionEvent.seq), func.max(am.ExecutionEvent.seq)).where(
            am.ExecutionEvent.session_id == row.id, am.ExecutionEvent.seq > through))).one()
    observed = max(int(row.seq or 0), int(stored_last or 0), through)
    out["historyGap"] = ({"expectedSeq": through + 1,
        "nextAvailableSeq": int(next_available) if next_available is not None else None,
        "observedThrough": observed} if observed > through else None)
    out["hasMore"] = out["last"] < (through if contiguous else max(through, int(stored_last or 0)))
    return out


async def list_task(session: AsyncSession, task_id: str, *, limit: int = 40,
                    event_limit: int = 160) -> dict:
    """Batch-read persisted sessions and recent structured events for task-chain details. Keep full
    raw logs behind the console endpoint rather than copying them into trace responses.
    """
    cap = min(100, max(1, int(limit or 40)))
    rows = list((await session.execute(select(am.ExecutionSession).where(
        am.ExecutionSession.task_id == task_id
    ).order_by(am.ExecutionSession.started_at.desc().nullslast(),
               am.ExecutionSession.created_at.desc()).limit(cap + 1))).scalars().all())
    truncated = len(rows) > cap
    rows = rows[:cap]
    if not rows:
        return {"sessions": [], "truncated": False}
    ids = [x.id for x in rows]
    per_session = min(400, max(0, int(160 if event_limit is None else event_limit)))
    # Bound the event query itself because one task may accumulate tens of thousands of records.
    events = []
    if per_session:
        events = list((await session.execute(select(am.ExecutionEvent).where(
            am.ExecutionEvent.session_id.in_(ids)
        ).order_by(am.ExecutionEvent.at.desc(), am.ExecutionEvent.seq.desc()).limit(
            cap * per_session))).scalars().all())
    grouped: dict[str, list[am.ExecutionEvent]] = {x: [] for x in ids}
    for event in reversed(events):
        bucket = grouped.setdefault(event.session_id, [])
        bucket.append(event)
        if per_session and len(bucket) > per_session:
            del bucket[0]
    from . import endpoint_events
    return {
        "sessions": [session_api(
            row,
            items=execution_event_policy.visible_items(
                [_event_api(x) for x in await endpoint_events.hydrate(grouped.get(row.id, []), strict=False, session=session)]))
                     for row in rows],
        "truncated": truncated,
    }
