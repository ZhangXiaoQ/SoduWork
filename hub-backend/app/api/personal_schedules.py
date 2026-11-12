"""Device-owned automation schedules and conversation handoff receipts."""
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import current_client, identity_only
from ..models import Client
from ..services import schedule_access
from .schedule_contract import schedule_payload

router = APIRouter()


def _my_sch_api(s) -> dict:
    from .tasks import _iso_utc
    return schedule_payload(s, timestamp=_iso_utc)


async def _my_sch(session: AsyncSession, sid: str, client: Client, *, lock: bool = False):
    from ..models import AiSchedule
    if lock:
        from ..services.schedule_timing import locked_schedule
        s = await locked_schedule(session, sid)
    else:
        s = await session.get(AiSchedule, sid)
    if s is None or not schedule_access.is_owner(s, client):
        raise HTTPException(status_code=404, detail="这条定时任务不在了")
    return s


@router.get("/schedules")
async def my_schedules(client: Client = Depends(current_client),
                       session: AsyncSession = Depends(get_session)):
    from .tasks import _my_sch_api

    from sqlalchemy import select as _sel

    from ..models import AiSchedule
    rows = (await session.execute(
        _sel(AiSchedule).where(schedule_access.owner_clause(client))
        .order_by(AiSchedule.created_at))).scalars().all()
    return [_my_sch_api(s) for s in rows]


@router.get("/schedules/templates")
async def my_schedule_templates(client: Client = Depends(current_client),
                                session: AsyncSession = Depends(get_session)):
    """Return enabled organization templates for the client schedule picker."""
    from ..services import automation_templates
    return await automation_templates.enabled(session)


@router.post('/automation-conversations/inbox')
@identity_only
async def automation_conversation_inbox(client: Client = Depends(current_client),
                                         session: AsyncSession = Depends(get_session)):
    from ..services import schedule_conversations as conversations
    return {'items': await conversations.inbox(session, client)}


@router.post('/automation-conversations/{run_id}/claim')
async def claim_automation_conversation(run_id: str, body: dict = Body(default_factory=dict),
                                        client: Client = Depends(current_client),
                                        session: AsyncSession = Depends(get_session)):
    from ..services import schedule_conversations as conversations
    return await conversations.claim(session, client, run_id, str(body.get('instanceId') or ''))


@router.post('/automation-conversations/{run_id}/state')
async def acknowledge_automation_conversation(run_id: str, body: dict = Body(default_factory=dict),
                                              client: Client = Depends(current_client),
                                              session: AsyncSession = Depends(get_session)):
    from ..services import schedule_conversations as conversations
    return await conversations.acknowledge(session, client, run_id, body)


@router.post("/schedules/preflight")
async def preflight_my_schedule(body: dict = Body(default_factory=dict),
                                client: Client = Depends(current_client),
                                session: AsyncSession = Depends(get_session)):
    """Validate policy now and explain whether a capable Runner is online."""
    from .tasks import _my_sch

    from .schedule_contract import apply_schedule_update as _sch_apply
    from ..models import AiSchedule
    from ..services import schedules as sch

    candidate = AiSchedule()
    owner_client_id, owner_user_id = client.id, client.user_ref
    schedule_id = str(body.get("scheduleId") or body.get("id") or "")
    if schedule_id:
        saved = await _my_sch(session, schedule_id, client)
        candidate = AiSchedule(**{column.key: getattr(saved, column.key) for column in AiSchedule.__table__.columns})
        owner_client_id, owner_user_id = saved.owner_client_id, saved.owner_user_id
    try:
        _sch_apply(candidate, dict(body or {}))
        # Preview the same execution identity that the saved plan will use.
        candidate.owner_client_id, candidate.owner_user_id = owner_client_id, owner_user_id
        result = await sch.preflight_execution(session, candidate)
        if candidate.every != "once":
            next_at = sch.next_run_instant(candidate)
            result = {**result, "nextRunAt": next_at.isoformat() if next_at else None,
                      "timeZone": sch.clean_time_zone(candidate.time_zone)}
        return result
    except (ValueError, HTTPException) as exc:
        if isinstance(exc, HTTPException) and exc.status_code != 400:
            raise
        mode = ("plugin" if str(candidate.plugin_binding_id or "") else
                "personal" if str(candidate.personal_plugin_key or "") else "direct")
        message = str(exc.detail if isinstance(exc, HTTPException) else exc)[:240]
        return {
            "state": "blocked", "mode": mode, "message": message,
            "checks": [{"key": "configuration", "state": "blocked",
                        "label": message}],
        }


@router.post("/schedules")
async def create_my_schedule(body: dict = Body(default_factory=dict),
                             client: Client = Depends(current_client),
                             session: AsyncSession = Depends(get_session)):
    from .tasks import _my_sch_api, _actor_user, _actor_label

    from .schedule_contract import apply_schedule_update as _sch_apply
    from ..models import AiSchedule
    me = await _actor_user(session, client)
    s = AiSchedule(created_by=(str(me.id) if me else None),
                   created_by_name=_actor_label(me, client),
                   org_id=(me.org_id if me else None))
    from ..services.schedule_source_app import clean as clean_source_app
    try:
        s.source_app = clean_source_app(body.get("sourceApp"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _sch_apply(s, body)
    s.owner_client_id = client.id          # Bind the schedule to the authenticated client, not a client supplied in the request.
    if not s.title:
        raise HTTPException(status_code=400, detail="请填任务标题")
    if not s.assignee_id:
        raise HTTPException(status_code=400, detail="请先选择执行底座")
    from ..services import schedules as sch
    try:
        await sch.validate_execution(session, s)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    blocker = sch.capability_save_blocker(s)
    if blocker:
        raise HTTPException(status_code=409, detail=blocker)
    session.add(s)
    await session.commit()
    await session.refresh(s)
    return _my_sch_api(s)


@router.put("/schedules/{sid}")
async def update_my_schedule(sid: str, body: dict = Body(default_factory=dict),
                             client: Client = Depends(current_client),
                             session: AsyncSession = Depends(get_session)):
    from .tasks import _my_sch, _my_sch_api

    from .schedule_contract import apply_schedule_update as _sch_apply
    s = await _my_sch(session, sid, client, lock=True)
    body.pop("ownerClientId", None)        # Do not move personal schedules to another user's machine.
    _sch_apply(s, body)
    from ..services import schedules as sch
    try:
        await sch.validate_execution(session, s)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    blocker = sch.capability_save_blocker(s)
    if blocker:
        raise HTTPException(status_code=409, detail=blocker)
    await session.commit()
    await session.refresh(s)
    return _my_sch_api(s)


@router.delete("/schedules/{sid}")
async def delete_my_schedule(sid: str, client: Client = Depends(current_client),
                             session: AsyncSession = Depends(get_session)):
    from .tasks import _my_sch

    s = await _my_sch(session, sid, client)
    await session.delete(s)
    await session.commit()
    return {"ok": True}


@router.get("/schedules/{sid}/runs")
async def my_schedule_runs(sid: str, limit: int = 20,
                           client: Client = Depends(current_client),
                           session: AsyncSession = Depends(get_session)):
    """List recent executions with status reconciled against authoritative task and workflow state.

    """
    from .tasks import _my_sch

    from ..services import schedules as sch
    from ..services import schedule_conversations as conversations
    await _my_sch(session, sid, client)
    items = await sch.list_runs(session, sid,
                               owner_user_id=str(client.user_ref or ""), limit=limit)
    await session.commit()
    return {"items": items}


@router.post("/schedules/{sid}/run")
async def run_my_schedule(sid: str, body: dict = Body(default_factory=dict),
                          client: Client = Depends(current_client),
                          session: AsyncSession = Depends(get_session)):
    """Start an immediate run and return its durable tracking record."""
    from .tasks import _my_sch

    from ..services import schedules as sch
    from ..services import schedule_conversations as conversations
    s = await _my_sch(session, sid, client)
    instance_id = str(body.get("instanceId") or "").strip()[:80]
    # A same-account device may trigger a schedule, but a local conversation
    # remains pinned to the schedule's original desktop. Only that desktop
    # may reserve/claim the local inbox occurrence. Cloud runs are returned
    # directly and never pass through the local conversation claim endpoint.
    local_owner = str(s.owner_client_id or "") == str(client.id or "")
    out = await sch.execute_one(
        session, s, trigger="manual",
        execution_instance=(instance_id if local_owner else ""))
    if not out.get("ok"):
        await session.commit()
        raise HTTPException(status_code=502, detail="没派出去：" + str(out.get("error"))[:200])
    # Immediate execution opens the ordinary chat directly in the desktop
    # client. Return the immutable conversation envelope created with this run
    # so the UI can open the selected base/model without waiting for a second
    # Runner inbox round-trip.
    from .. import models
    run = await session.get(models.AiScheduleRun, str(out.get("scheduleRunId") or ""))
    receipt = dict(run.receipt or {}) if run is not None else {}
    is_local_conversation = bool(
        run is not None and
        dict(run.receipt or {}).get("executionMode") == conversations.PROTOCOL)
    if instance_id and local_owner and is_local_conversation and run is not None:
        # The immediate button owns the run before the background worker polls
        # the inbox. This makes the UI open the chat directly and prevents a
        # second client from consuming the same occurrence first.
        claimed = await conversations.claim(session, client, run.id, instance_id)
        if claimed.get("ok"):
            receipt = dict(run.receipt or {})
            out["conversationInput"] = dict(claimed.get("input") or {})
            out["instanceId"] = instance_id
        elif claimed.get("busy"):
            out["busy"] = True
    await session.commit()
    # Only return the envelope to the client that successfully claimed this
    # occurrence.  A busy/terminal response must not let a second client open
    # and submit the same prompt concurrently.
    conversation_input = dict(out.get("conversationInput") or {})
    if not instance_id:
        conversation_input = dict(receipt.get("conversationInput") or {})
    return {"ok": True, **out, "conversationInput": conversation_input}
