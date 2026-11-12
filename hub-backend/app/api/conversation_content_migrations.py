"""Account-authorized migration controls; responses never contain transcript bodies."""
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import select

from ..db import get_session
from ..deps import current_client
from ..account_conversation_models import AccountConversation, AccountConversationMessage, PersonalConversationRelay
from ..conversation_handoff_models import ConversationHandoff, ConversationMessageReceipt
from ..automation_models import ExecutionSession, ExecutionEvent
from ..models import Task, AiScheduleRun
from ..services import conversation_content_migration as migration
from ..services import conversation_content_inventory as inventory, conversation_content, conversation_migration_admission

router = APIRouter(prefix="/api/v1/conversation-content-migrations", tags=["account-conversations"])


def owner(client):
    if not client.user_ref:
        raise HTTPException(403, "请先登录当前账号")
    return client.user_ref


@router.get("")
async def candidates(kind: str = Query(...), after: str = Query(default="", max_length=180),
                     limit: int = Query(default=50, ge=1, le=100),
                     client=Depends(current_client), session=Depends(get_session)):
    uid = owner(client)
    model, query = inventory.query(kind, uid)
    rows = list((await session.scalars(query.where(model.id > after).order_by(model.id).limit(limit + 1))).all())
    page = rows[:limit]
    return {"items": [{"id": value, "kind": kind} for value in page],
            "cursor": page[-1] if page else after, "hasMore": len(rows) > limit}


@router.get("/status")
async def status(client=Depends(current_client), session=Depends(get_session)):
    pending = await inventory.counts(session, owner(client))
    return {"metadataOnly": conversation_content.metadata_only(), "pending": pending,
            "complete": not any(pending.values())}


@router.post("/{kind}/{identity}")
async def migrate(kind: str, identity: str, body: dict = Body(default_factory=dict),
                  client=Depends(current_client), session=Depends(get_session)):
    uid = owner(client)
    if kind not in inventory.KINDS or not 0 < len(identity) <= 180:
        raise HTTPException(422, "迁移类别或记录标识无效")
    with conversation_migration_admission.reserve(kind, identity):
        return await _migrate(kind, identity, body, client, session, uid)


async def _migrate(kind, identity, body, client, session, uid):
    if kind == "account":
        row = await session.get(AccountConversation, identity)
        if not row or row.owner_user_id != uid:
            raise HTTPException(404, "会话不存在")
        return await migration.account(session, client, row, body.get("targetClientId") or row.source_client_id)
    if kind == "handoff":
        row = await session.get(ConversationHandoff, identity)
        if not row or row.owner_user_id != uid:
            raise HTTPException(404, "会话不存在")
        return await migration.handoff(session, client, row)
    if kind == "message":
        row = await session.get(ConversationMessageReceipt, identity)
        if not row:
            raise HTTPException(404, "消息不存在")
        return await migration.pending_message(session, client, row)
    if kind == "execution":
        row = await session.get(ExecutionSession, identity)
        task = await session.get(Task, row.task_id) if row else None
        if not task or task.owner_user_id != uid:
            raise HTTPException(404, "会话不存在")
        return await migration.execution(session, client, row)
    if kind == "relay":
        row = await session.get(PersonalConversationRelay, identity)
        if not row or row.owner_user_id != uid:
            raise HTTPException(404, "消息不存在")
        return await migration.relay(session, client, row)
    if kind == "schedule":
        row = await session.get(AiScheduleRun, identity)
        if not row or row.owner_user_id != uid:
            raise HTTPException(404, "自动化记录不存在")
        return await migration.schedule(session, client, row)
    raise HTTPException(422, "迁移类别无效")
