"""Create a conversation directly on an authorized remote Runner."""
import json
import re
from datetime import datetime

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, UploadFile
from sqlalchemy import and_, func, or_, select

from ..conversation_handoff_models import ConversationHandoff
from ..db import get_session
from ..deps import current_ai_client
from ..models import Task, TaskEvent
from ..services import ai_exec, cloud_conversations as svc
from ..services import conversation_handoffs, task_access
from ..services import tasks as task_svc

router = APIRouter(prefix="/api/v1/cloud-conversations", tags=["cloud-conversations"])


@router.get("")
async def directory(
    client=Depends(current_ai_client), session=Depends(get_session),
    limit: int = Query(default=100, ge=1, le=100),
    cursor: str = Query(default="", max_length=500),
):
    """Return the account-scoped directory of cloud conversation projections.

    The directory is deliberately metadata-only.  Transcript and execution
    state remain behind the existing task session endpoints; a desktop client
    uses this response only to discover a remote conversation that was started
    on another device.
    """
    # This is a directory read, not a task-board read.  The previous
    # implementation materialized every visible task, calculated every task's
    # AI state and then filtered to cloud conversations.  That made opening a
    # desktop sidebar O(account task count) and returned an unbounded payload.
    # Query the account's cloud rows first and decorate only one page.
    # Unit tests and internal callers invoke the endpoint function directly,
    # so FastAPI's Query defaults may still be present instead of plain values.
    if not isinstance(limit, int):
        limit = 100
    if not isinstance(cursor, str):
        cursor = ""
    if not client.user_ref:
        return {"ok": True, "chats": [], "hasMore": False, "nextCursor": ""}
    sort_at = func.coalesce(Task.updated_at, Task.created_at)
    condition = and_(
        Task.origin == "cloud-conversation",
        Task.owner_user_id == client.user_ref,
    )
    if cursor:
        import base64
        try:
            padded = cursor + "=" * (-len(cursor) % 4)
            decoded = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
            cursor_at = datetime.fromisoformat(str(decoded["at"]))
            cursor_id = str(decoded["id"])
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=400, detail="invalid cloud conversation cursor") from exc
        condition = and_(condition, or_(
            sort_at < cursor_at,
            and_(sort_at == cursor_at, Task.id < cursor_id),
        ))
    cloud_rows = list((await session.execute(
        select(Task).where(condition)
        .order_by(sort_at.desc(), Task.id.desc())
        .limit(limit + 1)
    )).scalars().all())
    has_more = len(cloud_rows) > limit
    cloud_rows = cloud_rows[:limit]
    task_ids = [str(task.id) for task in cloud_rows]
    cloud_tasks = [task_svc.task_to_api(task) for task in cloud_rows]
    from ..services import conversation_review_projection
    await conversation_review_projection.decorate_many(session, cloud_rows, cloud_tasks)
    ai = await task_svc.ai_states(session, task_ids)
    for task in cloud_tasks:
        if task["id"] in ai:
            task["ai"] = ai[task["id"]]
    cloud_tasks = await task_access.decorate_many(session, cloud_rows, cloud_tasks, client)
    handoffs = {}
    if task_ids:
        handoff_rows = (await session.execute(
            select(ConversationHandoff).where(ConversationHandoff.task_id.in_(task_ids))
        )).scalars().all()
        handoffs = {str(row.task_id): row for row in handoff_rows}
    # A committed direct-cloud handoff stores its execution ref in the receipt.
    # Only legacy/in-flight rows need the event fallback, and that fallback is
    # also batched so a large account never causes one query per conversation.
    missing_ref_ids = [task_id for task_id in task_ids
                       if task_id in handoffs and not ((handoffs[task_id].receipt or {}).get("ref") or
                                                       (handoffs[task_id].receipt or {}).get("issueId"))]
    events = {}
    if missing_ref_ids:
        event_rows = (await session.execute(
            select(TaskEvent).where(TaskEvent.task_id.in_(missing_ref_ids),
                                    TaskEvent.kind.in_(ai_exec.KINDS_DISPATCH_STATE))
            .order_by(TaskEvent.at, TaskEvent.id)
        )).scalars().all()
        for row in event_rows:
            task_id = str(row.task_id)
            detail = dict(row.detail or {})
            if task_id not in events or detail.get("ref") or detail.get("issueId"):
                events[task_id] = row
    rows = []
    for task in cloud_tasks:
        handoff = handoffs.get(str(task["id"]))
        if handoff is None or str(handoff.owner_user_id or "") != str(client.user_ref or ""):
            continue
        receipt = dict(handoff.receipt or {})
        source = dict(handoff.source or {})
        routing = dict(task.get("workRouting") or {})
        cloud = dict(routing.get("cloudConversation") or {})
        event = events.get(str(task["id"]))
        detail = dict(event.detail or {}) if event else {}
        ref = str(receipt.get("ref") or receipt.get("issueId") or
                  detail.get("ref") or detail.get("issueId") or "")
        target_snapshot = dict((handoff.options or {}).get("targetSnapshot") or {})
        target = {
            key: str(target_snapshot.get(key) or "")
            for key in ("name", "runnerName", "agentId", "modelMode", "runnerId", "host", "runnerKind")
        }
        target.update({"id": str((handoff.options or {}).get("assigneeId") or ""),
                       "model": str((handoff.options or {}).get("model") or "")})
        session_id = str(source.get("sessionId") or cloud.get("sessionId") or
                         "cloud-task:" + str(task["id"]))
        ai = dict(task.get("ai") or {})
        state = str(ai.get("state") or receipt.get("state") or "queued")
        can_continue = handoff.phase == "committed" and not bool(task.get("archivedAt"))
        rows.append({
            "id": session_id,
            "sessionId": session_id,
            "taskId": str(task["id"]),
            "transferId": str(handoff.transfer_id or ""),
            "ref": ref,
            "title": str((task.get("title") if task.get("conversationReview") else source.get("title"))
                         or task.get("title") or "Cloud conversation")[:200],
            "conversationReview": task.get("conversationReview"),
            "at": task.get("updatedAt") or task.get("created"),
            "state": state,
            "remoteState": state,
            "phase": str(handoff.phase or "committed"),
            "adapterId": str(source.get("adapterId") or target.get("agentId") or "pi"),
            "model": str(source.get("modelName") or target.get("model") or ""),
            "target": target,
            "runnerKind": target.get("runnerKind") or "cloud",
            "ownerClientId": str(handoff.owner_client_id or ""),
            "createdBy": task.get("createdBy") or "",
            "cloud": True,
            "remoteProjection": True,
            # This directory contains direct cloud conversations.  The
            # explicit marker lets mobile skip the workflow restore probe;
            # workflow state is only requested for an actual workflow row.
            "workflow": False,
            "canContinue": can_continue,
            "canSend": can_continue,
            "readOnly": not can_continue,
            "locationMode": "remote",
            "location": target.get("runnerKind") or "cloud",
        })
    next_cursor = ""
    if has_more and cloud_rows and (getattr(cloud_rows[-1], "updated_at", None)
                                    or getattr(cloud_rows[-1], "created_at", None)):
        import base64
        stamp = getattr(cloud_rows[-1], "updated_at", None) or getattr(cloud_rows[-1], "created_at", None)
        payload = json.dumps({"at": stamp.isoformat(), "id": str(cloud_rows[-1].id)}, separators=(",", ":")).encode()
        next_cursor = base64.urlsafe_b64encode(payload).decode().rstrip("=")
    return {"ok": True, "chats": rows, "hasMore": has_more, "nextCursor": next_cursor}


@router.post("/{request_id}")
async def create(request_id: str, options: str = Form(...),
                 files: list[UploadFile] = File(default=[]),
                 client=Depends(current_ai_client), session=Depends(get_session)):
    if len(options) > 250000:
        raise HTTPException(413, "云端会话说明过长")
    try:
        raw = json.loads(options)
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "云端会话选项必须是 JSON 对象") from exc
    return await svc.create(session, client, request_id, raw, files)


@router.post("/{task_id}/branch")
async def branch(task_id: str, body: dict = Body(default_factory=dict),
                 client=Depends(current_ai_client), session=Depends(get_session)):
    """Continue a cloud conversation on another owned Runner as a new task.

    A Runner session is pinned to its original machine.  This endpoint makes
    that boundary explicit: it carries bounded, server-side transcript context
    into a new handoff after rechecking the current account's target roster.
    """
    task = await session.get(Task, task_id)
    if task is None or not await task_access.can_view(session, client, task):
        raise HTTPException(status_code=404, detail="conversation not found")
    if task.origin != "cloud-conversation":
        raise HTTPException(status_code=409, detail="only cloud conversations can be moved")
    from ..services import ai_exec, conversation_handoffs, execution_sessions
    handoff = await conversation_handoffs.dispatch_record(session, task_id)
    if (handoff is None or handoff.phase != "committed"
            or str(handoff.owner_user_id or "") != str(client.user_ref or "")):
        raise HTTPException(status_code=409, detail="conversation handoff is not owned by this account")
    target_runner_id = str(body.get("targetRunnerId") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,80}", target_runner_id):
        raise HTTPException(status_code=422, detail="a target Runner is required")
    target_runner_kind = str(body.get("targetRunnerKind") or "").strip()
    request_id = str(body.get("requestId") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", request_id):
        raise HTTPException(status_code=422, detail="invalid branch request id")
    instruction = str(body.get("instruction") or "").strip()
    if not instruction or len(instruction) > 200_000 or "\0" in instruction:
        raise HTTPException(status_code=422, detail="instruction is required")
    requested_agent = str(body.get("agentId") or "").strip()
    requested_model = str(body.get("model") or "").strip()
    active = dict((handoff.receipt or {}).get("activeExecutionSelection") or {})
    agent_id = requested_agent or str(active.get("agentId") or handoff.options.get("agentId") or "")
    model = requested_model or str(active.get("modelName") or handoff.options.get("model") or "")
    if not agent_id:
        raise HTTPException(status_code=409, detail="current Agent is unavailable")
    if (handoff.options or {}).get("inputs"):
        raise HTTPException(status_code=409, detail="conversation attachments must be attached again on the new Runner")

    event = await ai_exec.last_dispatch_event(session, task_id)
    ref = str((event.detail if event else {}).get("ref") or (event.detail if event else {}).get("issueId") or "")
    cached = await execution_sessions.read_task(session, task_id, ref, 0, limit=1000) if ref else None
    items = list((cached or {}).get("items") or [])
    lines = []
    if task.note:
        lines.append("user: " + str(task.note)[:20_000])
    for item in items:
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        kind = str(item.get("kind") or "assistant")
        role = "user" if kind in {"user", "prompt", "input"} else "assistant"
        lines.append(role + ": " + text[:20_000])
    prefix = "Read-only context from the original cloud conversation:"
    selected, total = [], 0
    limit = max(0, min(150_000, 190_000 - len(instruction)))
    for line in reversed(lines):
        if total + len(line) + 2 > limit:
            break
        selected.append(line)
        total += len(line) + 2
    selected.reverse()
    context = "\n\n".join([prefix] + (["[older context omitted]"] if len(selected) < len(lines) else []) + selected)
    text = (context + "\n\nContinuation request:\n" + instruction).strip()
    if len(text) > 200_000:
        text = instruction
    receipt = await svc.create(session, client, request_id, {
        "sessionId": "cloud-" + request_id,
        "agentId": agent_id,
        "model": model,
        "title": str((handoff.source or {}).get("title") or task.title or instruction[:80])[:200],
        "text": text,
        "userText": instruction,
        "requiredSkills": list(handoff.options.get("requiredSkills") or []),
        "targetRunnerId": target_runner_id,
        **({"targetRunnerKind": target_runner_kind} if target_runner_kind else {}),
    }, [])
    return {**receipt, "branch": {"sourceTaskId": task_id, "targetRunnerId": target_runner_id,
                                  **({"targetRunnerKind": target_runner_kind} if target_runner_kind else {})}}
