"""Account-scoped conversation directory and source-device synchronization."""
from __future__ import annotations

import hashlib
import json
import logging
import uuid
import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from ..account_conversation_models import (
    AccountConversation,
    AccountConversationCursor,
    AccountConversationMessage,
)
from ..db import SessionLocal, get_session
from ..deps import current_client, identity_only
from ..models import Client
from ..realtime import hub

router = APIRouter(prefix="/api/v1/account-conversations", tags=["account-conversations"])

_MAX_TITLE = 200
_MAX_SESSION = 180
_MAX_EPOCH = 180
_MAX_MESSAGE_ID = 240
_MAX_MESSAGES = 1000
_MAX_MESSAGE_TEXT = 200_000
_MAX_BATCH_BYTES = 2 * 1024 * 1024
_MAX_DIRECTORY = 100
_MAX_TRANSCRIPT = 100
_STATES = {"idle", "responding", "completed", "interrupted", "stopped", "failed"}
log = logging.getLogger("uvicorn.error")


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _publish_account_update(owner: str, row: AccountConversation) -> None:
    """Wake every active device in the account after the durable write.

    The event contains only an invalidation hint.  Clients must re-read the
    account directory/transcript with their normal authorization, so a stale
    or forged event can never grant access or become the source of truth.
    """
    try:
        async with SessionLocal() as notify_session:
            device_ids = list((await notify_session.scalars(select(Client.id).where(
                Client.user_ref == owner,
                Client.auth_state == "active",
            ))).all())
        event = {
            "type": "account-conversation",
            "conversationId": row.id,
            "revision": int(row.revision or 0),
            "sourceRevision": int(row.source_revision or 0),
            "state": row.state,
            "deleted": bool(row.deleted),
        }
        await asyncio.gather(*(
            hub.publish(str(device_id), event, user_id=owner)
            for device_id in device_ids
        ), return_exceptions=True)
    except Exception as exc:  # noqa: BLE001 - a wake-up must not fail a committed sync
        log.warning("账号会话实时通知失败: %s", type(exc).__name__)


def _iso(value: datetime | None) -> str:
    if value is None:
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_time(value: object) -> datetime:
    if isinstance(value, (int, float)) and value == value:
        return datetime.fromtimestamp(float(value) / 1000, tz=timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
        except ValueError:
            pass
    raise HTTPException(status_code=422, detail="聊天消息时间格式不正确")


def _owner(client: Client) -> str:
    owner = str(client.user_ref or "").strip()
    if not owner:
        raise HTTPException(status_code=403, detail="设备尚未绑定企业账号")
    return owner


def _text(value: object, field: str, limit: int, *, required: bool = False) -> str:
    if not isinstance(value, str):
        if required:
            raise HTTPException(status_code=422, detail=f"{field} 必须是文本")
        return ""
    value = value.strip()
    if required and not value:
        raise HTTPException(status_code=422, detail=f"{field} 不能为空")
    if len(value) > limit:
        raise HTTPException(status_code=413, detail=f"{field} 超过长度限制")
    return value


def _conversation_json(row: AccountConversation, client_id: str) -> dict:
    return {
        "id": row.id,
        "sourceSessionId": row.source_session_id,
        "taskProjectionId": row.task_projection_id or "",
        "sourceClientId": row.source_client_id,
        "sourceDeviceName": row.source_device_name or "",
        "title": row.title or "",
        "state": row.state or "idle",
        "archived": bool(row.archived),
        "deleted": bool(row.deleted),
        "lifecycleRevision": int(row.lifecycle_revision or 0),
        "revision": int(row.revision or 0),
        "createdAt": _iso(row.created_at),
        "updatedAt": _iso(row.updated_at),
        "sourceRevision": int(row.source_revision or 0),
        "storageMode": row.storage_mode or "legacy",
        "canView": True,
        # The source device remains the only device that may checkpoint the
        # native session. Every device authenticated to the same account may,
        # however, continue from this Hub-owned snapshot through the explicit
        # branch endpoint below.
        "canContinue": not row.deleted,
        "canSend": row.source_client_id == client_id and not row.deleted,
    }


def _message_json(row: AccountConversationMessage) -> dict:
    return {
        "id": row.id,
        "position": int(row.position),
        "role": row.role,
        "text": row.text or "",
        "deleted": bool(row.deleted),
        "revision": int(row.revision or 0),
        "createdAt": _iso(row.created_at),
        "done": bool(row.done),
    }


async def _load_owned(
    conversation_id: str,
    owner: str,
    session: AsyncSession,
    *,
    lock: bool = False,
) -> AccountConversation:
    query = select(AccountConversation).where(
        AccountConversation.id == conversation_id,
        AccountConversation.owner_user_id == owner,
    )
    row = await session.scalar(query.with_for_update() if lock else query)
    if row is None:
        # Do not reveal whether another account owns the id.
        raise HTTPException(status_code=404, detail="会话不存在或无权访问")
    return row


async def _next_directory_revision(owner: str, session: AsyncSession) -> int:
    cursor = await session.scalar(
        select(AccountConversationCursor)
        .where(AccountConversationCursor.owner_user_id == owner)
        .with_for_update()
    )
    if cursor is None:
        cursor = AccountConversationCursor(owner_user_id=owner, revision=0)
        session.add(cursor)
        await session.flush()
    cursor.revision = int(cursor.revision or 0) + 1
    return cursor.revision


async def _next_message_revision(conversation_id: str, session: AsyncSession) -> int:
    current = await session.scalar(
        select(func.max(AccountConversationMessage.revision)).where(
            AccountConversationMessage.conversation_id == conversation_id
        )
    )
    return int(current or 0) + 1


@router.get("")
@identity_only
async def list_account_conversations(
    after: int = Query(default=0, ge=0),
    limit: int = Query(default=_MAX_DIRECTORY, ge=1, le=_MAX_DIRECTORY),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    owner = _owner(client)
    rows = list((await session.scalars(
        select(AccountConversation)
        .where(AccountConversation.owner_user_id == owner, AccountConversation.revision > after)
        .order_by(AccountConversation.revision.asc(), AccountConversation.id.asc())
        .limit(limit + 1)
    )).all())
    has_more = len(rows) > limit
    rows = rows[:limit]
    cursor = rows[-1].revision if rows else after
    counts = dict((await session.execute(
        select(AccountConversationMessage.conversation_id, func.count())
        .where(AccountConversationMessage.conversation_id.in_([row.id for row in rows]),
               AccountConversationMessage.deleted.is_(False))
        .group_by(AccountConversationMessage.conversation_id)
    )).all()) if rows else {}
    return {
        "items": [{**_conversation_json(row, client.id), "messageCount": row.message_count if row.storage_mode == "endpoint" else counts.get(row.id, 0)}
                  for row in rows],
        "cursor": int(cursor),
        "hasMore": has_more,
    }


@router.get("/{conversation_id}/messages")
async def list_account_conversation_messages(
    conversation_id: str,
    after: int = Query(default=0, ge=0),
    limit: int = Query(default=_MAX_TRANSCRIPT, ge=1, le=_MAX_TRANSCRIPT),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    row = await _load_owned(conversation_id, _owner(client), session)
    if row.storage_mode == "endpoint":
        from ..services import account_endpoint_history
        return await account_endpoint_history.page(session, client, row, after, limit)
    messages = list((await session.scalars(
        select(AccountConversationMessage)
        .where(
            AccountConversationMessage.conversation_id == row.id,
            AccountConversationMessage.revision > after,
        )
        .order_by(AccountConversationMessage.revision.asc(), AccountConversationMessage.id.asc())
        .limit(limit + 1)
    )).all())
    has_more = len(messages) > limit
    messages = messages[:limit]
    cursor = messages[-1].revision if messages else after
    return {
        "conversation": _conversation_json(row, client.id),
        "items": [_message_json(item) for item in messages],
        "cursor": int(cursor),
        "hasMore": has_more,
    }


@router.get("/{conversation_id}/source")
async def account_conversation_source(
    conversation_id: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    row = await _load_owned(conversation_id, _owner(client), session)
    return {
        "conversation": _conversation_json(row, client.id),
        "sourceEpoch": row.source_epoch,
        "sourceRevision": int(row.source_revision or 0),
    }


@router.post("/{conversation_id}/lifecycle")
async def update_account_conversation_lifecycle(
    conversation_id: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Account intent is independent of source-device transcript checkpoints."""
    action = body.get("action")
    if not isinstance(action, str) or action not in {"archive", "restore", "delete"}:
        raise HTTPException(status_code=422, detail="会话操作必须为 archive、restore 或 delete")
    expected_revision = body.get("expectedRevision")
    if type(expected_revision) is not int or expected_revision < 1:
        raise HTTPException(status_code=422, detail="请提供有效的会话目录版本")
    owner = _owner(client)
    # Use the same row -> account cursor lock order as source /sync. The source
    # writer and every device's lifecycle writer serialize against this row.
    row = await _load_owned(conversation_id, owner, session, lock=True)
    if row.deleted and action != "delete":
        raise HTTPException(status_code=410, detail={
            "code": "ACCOUNT_CONVERSATION_DELETED",
            "message": "会话已删除，无法归档或恢复",
            "conversation": _conversation_json(row, client.id),
        })
    reached = bool(row.deleted) if action == "delete" else bool(row.archived) == (action == "archive")
    if reached and int(row.lifecycle_revision or 0) > 0:
        # A lost receipt may be retried with the old revision, but this is only
        # a read: it must never reverse a newer archive/restore/delete action.
        return {"ok": True, "conversation": _conversation_json(row, client.id)}
    if expected_revision != int(row.revision or 0):
        raise HTTPException(status_code=409, detail={
            "code": "ACCOUNT_CONVERSATION_CHANGED",
            "message": "会话已更新，请刷新后重试",
            "conversation": _conversation_json(row, client.id),
        })
    # SQLite does not implement SELECT FOR UPDATE. Claim the observed version
    # with an explicit conditional write on every supported database before
    # allocating a directory revision. ORM dirty-field updates could otherwise
    # acknowledge a restore without writing archived=False from a stale object.
    changes = {"deleted": True} if action == "delete" else {"archived": action == "archive"}
    try:
        changed = await session.execute(update(AccountConversation).where(
            AccountConversation.id == conversation_id,
            AccountConversation.owner_user_id == owner,
            AccountConversation.revision == expected_revision,
        ).values(**changes).execution_options(synchronize_session=False))
    except OperationalError as exc:
        await session.rollback()
        if session.get_bind().dialect.name == "sqlite" and any(
                reason in str(exc.orig).lower() for reason in ("locked", "busy")):
            raise HTTPException(status_code=409, detail="会话状态更新发生并发冲突，请刷新后重试") from exc
        raise
    if changed.rowcount != 1:
        await session.rollback()
        latest = await _load_owned(conversation_id, owner, session)
        raise HTTPException(status_code=409, detail={
            "code": "ACCOUNT_CONVERSATION_CHANGED",
            "message": "会话已更新，请刷新后重试",
            "conversation": _conversation_json(latest, client.id),
        })
    await session.refresh(row)
    # Even a first explicit restore of an active row records intent, allowing
    # clients to distinguish it from an old source snapshot's default false.
    row.revision = await _next_directory_revision(owner, session)
    row.lifecycle_revision = row.revision
    row.updated_at = _now()
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail="会话状态更新发生并发冲突，请刷新后重试") from exc
    await _publish_account_update(owner, row)
    return {"ok": True, "conversation": _conversation_json(row, client.id)}


def _sync_digest(body: dict) -> str:
    encoded = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _validate_messages(raw: object) -> list[dict]:
    if not isinstance(raw, list) or len(raw) > _MAX_MESSAGES:
        raise HTTPException(status_code=422, detail="聊天消息列表不完整或超过限制")
    messages: list[dict] = []
    ids: set[str] = set()
    positions: set[int] = set()
    total = 0
    for value in raw:
        if not isinstance(value, dict):
            raise HTTPException(status_code=422, detail="聊天消息格式不正确")
        message_id = _text(value.get("id"), "消息 id", _MAX_MESSAGE_ID, required=True)
        role = _text(value.get("role"), "消息角色", 16, required=True)
        if role not in {"user", "assistant"}:
            raise HTTPException(status_code=422, detail="聊天消息角色不受支持")
        position = value.get("position")
        if not isinstance(position, int) or position < 0 or position in positions:
            raise HTTPException(status_code=422, detail="聊天消息位置重复或无效")
        positions.add(position)
        text = value.get("text")
        if not isinstance(text, str) or len(text) > _MAX_MESSAGE_TEXT:
            raise HTTPException(status_code=413, detail="聊天消息正文超过限制")
        if message_id in ids:
            raise HTTPException(status_code=422, detail="聊天消息 id 重复")
        ids.add(message_id)
        total += len(text.encode("utf-8"))
        if total > _MAX_BATCH_BYTES:
            raise HTTPException(status_code=413, detail="聊天同步批次超过 2 MiB")
        messages.append({
            "id": message_id,
            "position": position,
            "role": role,
            "text": text,
            "deleted": value.get("deleted") is True,
            "done": value.get("done") is True,
            "created_at": _parse_time(value.get("createdAt")),
        })
    return messages


@router.post("/sync")
async def sync_account_conversation(
    request: Request,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    owner = _owner(client)
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail="同步请求必须是对象")
    try:
        if len(json.dumps(body, ensure_ascii=False).encode("utf-8")) > _MAX_BATCH_BYTES:
            raise HTTPException(status_code=413, detail="聊天同步批次超过 2 MiB")
    except (TypeError, ValueError, RecursionError) as exc:
        raise HTTPException(status_code=422, detail="同步请求无法解析") from exc
    source_client_id = _text(body.get("sourceClientId"), "来源设备", 64) or client.id
    if source_client_id != client.id:
        raise HTTPException(status_code=403, detail="只能同步当前设备创建的会话")
    source_session_id = _text(body.get("sourceSessionId"), "来源会话", _MAX_SESSION, required=True)
    source_epoch = _text(body.get("sourceEpoch"), "来源版本", _MAX_EPOCH, required=True)
    source_revision = body.get("sourceRevision")
    if not isinstance(source_revision, int) or not 1 <= source_revision <= 2_000_000_000:
        raise HTTPException(status_code=422, detail="来源会话版本无效")
    title = _text(body.get("title"), "会话标题", _MAX_TITLE)
    state = _text(body.get("state"), "会话状态", 24) or "idle"
    if state not in _STATES:
        raise HTTPException(status_code=422, detail="会话状态不受支持")
    archived = body.get("archived") is True
    deleted = body.get("deleted") is True
    # New source clients send a complete bounded snapshot. Older clients omit
    # this field and keep the legacy append/update semantics for compatibility.
    snapshot_complete = body.get("snapshotComplete") is True
    messages = _validate_messages(body.get("messages"))
    endpoint_storage = body.get("storageMode") == "endpoint"
    from ..services import conversation_content
    if conversation_content.metadata_only() and not endpoint_storage:
        raise HTTPException(409, "请更新来源电脑，Hub 已停用会话正文同步")
    if endpoint_storage and (messages or snapshot_complete):
        raise HTTPException(422, "终端会话只同步目录，不接收正文快照")
    message_count = body.get("messageCount", 0)
    if endpoint_storage and (type(message_count) is not int or not 0 <= message_count <= 1_000_000_000):
        raise HTTPException(422, "会话消息数量无效")
    digest = _sync_digest(body)
    task_projection_id = _text(body.get("taskProjectionId"), "关联需求", 120)
    if task_projection_id:
        # This is a navigation alias, never an authorization grant. All task
        # reads and decisions still pass through their own access checks.
        from ..services.task_access import view_task
        await view_task(session, client, task_projection_id)

    row = await session.scalar(select(AccountConversation).where(
        AccountConversation.owner_user_id == owner,
        AccountConversation.source_client_id == source_client_id,
        AccountConversation.source_session_id == source_session_id,
    ).with_for_update())
    if row is not None:
        if row.source_epoch != source_epoch:
            raise HTTPException(status_code=409, detail="来源会话版本已变化，不能覆盖旧会话")
        current_source_revision = int(row.source_revision or 0)
        if source_revision < current_source_revision:
            raise HTTPException(status_code=409, detail="同步版本落后于 Hub 当前版本")
        endpoint_transition = endpoint_storage and row.storage_mode != "endpoint"
        if source_revision == current_source_revision and not endpoint_transition:
            if row.source_digest and row.source_digest != digest:
                raise HTTPException(status_code=409, detail="相同同步版本的内容不一致")
            return {
                "ok": True,
                "conversationId": row.id,
                "sourceRevision": source_revision,
                "revision": int(row.revision or 0),
                "sourceEpoch": row.source_epoch,
                "idempotent": True,
            }

    new_source = row is None
    if row is None:
        row = AccountConversation(
            id="acct-" + uuid.uuid4().hex,
            owner_user_id=owner,
            source_client_id=source_client_id,
            source_session_id=source_session_id,
            archived=archived,
            deleted=deleted,
        )
        session.add(row)
        await session.flush()
    row.source_device_name = _text(client.name, "设备名称", 120)
    if "taskProjectionId" in body:
        row.task_projection_id = task_projection_id
    row.source_epoch = source_epoch
    row.source_revision = source_revision
    row.source_digest = digest
    if endpoint_storage:
        row.storage_mode = "endpoint"
        row.message_count = message_count
    elif row.storage_mode == "endpoint":
        raise HTTPException(409, "会话已使用终端存储，请更新客户端后重试")
    row.title = title
    row.state = state
    # Existing lifecycle state belongs to explicit account actions, not a
    # delayed source snapshot or outbox replay. Deletion remains a tombstone.
    row.updated_at = _now()
    row.revision = await _next_directory_revision(owner, session)

    incoming_ids = [item["id"] for item in messages]
    existing = {}
    if snapshot_complete:
        # A complete source checkpoint is allowed to express deletion by
        # omission. Lock the whole transcript so a concurrent checkpoint
        # cannot resurrect a message after the missing-row sweep below.
        existing_rows = (await session.scalars(
            select(AccountConversationMessage).where(
                AccountConversationMessage.conversation_id == row.id
            ).with_for_update()
        )).all()
        existing = {item.id: item for item in existing_rows}
    elif incoming_ids:
        existing_rows = (await session.scalars(
            select(AccountConversationMessage).where(AccountConversationMessage.id.in_(incoming_ids)).with_for_update()
        )).all()
        existing = {item.id: item for item in existing_rows}
        foreign = [item for item in existing.values() if item.conversation_id != row.id]
        if foreign:
            raise HTTPException(status_code=409, detail="消息已属于另一条会话")
    next_message_revision = await _next_message_revision(row.id, session)
    incoming_id_set = set(incoming_ids)
    if snapshot_complete:
        for stored in existing.values():
            if stored.id not in incoming_id_set and not stored.deleted:
                stored.deleted = True
                stored.revision = next_message_revision
                next_message_revision += 1
    for item in messages:
        stored = existing.get(item["id"])
        if stored is not None and (
            stored.position == item["position"] and
            stored.role == item["role"] and
            stored.text == item["text"] and
            bool(stored.deleted) == item["deleted"] and
            bool(stored.done) == item["done"] and
            stored.created_at == item["created_at"]
        ):
            # Desktop checkpoints contain the complete visible snapshot. Do
            # not manufacture a new transcript revision for unchanged rows.
            continue
        if stored is None:
            stored = AccountConversationMessage(id=item["id"], conversation_id=row.id)
            session.add(stored)
        stored.position = item["position"]
        stored.role = item["role"]
        stored.text = item["text"]
        stored.deleted = item["deleted"]
        stored.done = item["done"]
        stored.created_at = item["created_at"]
        stored.revision = next_message_revision
        next_message_revision += 1
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail="会话同步发生并发冲突，请重试原批次") from exc
    await _publish_account_update(owner, row)
    if new_source:
        # Existing groups may now resolve an opaque member to its account identity.
        from ..services.client_domain_events import account_changed
        await account_changed(session, owner, "conversation-projects")
    return {
        "ok": True,
        "conversationId": row.id,
        "sourceRevision": source_revision,
        "revision": int(row.revision or 0),
        "sourceEpoch": row.source_epoch,
        "idempotent": False,
    }


@router.post("/branches/{conversation_id}")
async def branch_account_conversation(
    conversation_id: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Create a new task from an account-owned conversation snapshot.

    Only the source device may checkpoint the native session. Any device
    authenticated to the same account may explicitly branch from the durable
    Hub snapshot. The directory revision is a compare-and-swap fence so a
    stale mobile draft cannot silently omit newer messages or execute against
    a different transcript.
    """
    request_id = _text(conversation_id, "branch request", 160, required=True)
    import re
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", request_id):
        raise HTTPException(status_code=422, detail="invalid branch request id")
    account_id = _text(body.get("accountConversationId"), "account conversation", 180, required=True)
    row = await _load_owned(account_id, _owner(client), session)
    if row.deleted:
        raise HTTPException(status_code=410, detail="conversation is closed")
    expected_revision = body.get("expectedRevision")
    if not isinstance(expected_revision, int) or expected_revision != int(row.revision or 0):
        raise HTTPException(status_code=409, detail="conversation changed; refresh before continuing")
    instruction = _text(body.get("instruction"), "instruction", 200_000, required=True)
    agent_id = _text(body.get("agentId"), "Agent", 80, required=True)
    model = _text(body.get("model"), "model", 200)
    target_runner_id = _text(body.get("targetRunnerId"), "target runner", 80)
    if target_runner_id and not re.fullmatch(r"[A-Za-z0-9._:-]{1,80}", target_runner_id):
        raise HTTPException(status_code=422, detail="invalid target runner id")
    target_runner_kind = _text(body.get("targetRunnerKind"), "target runner kind", 40)

    message_query = select(AccountConversationMessage).where(
        AccountConversationMessage.conversation_id == row.id,
        AccountConversationMessage.deleted.is_(False),
    ).order_by(AccountConversationMessage.position.asc(), AccountConversationMessage.id.asc())
    messages = list((await session.scalars(message_query)).all())
    if len(messages) > _MAX_MESSAGES:
        raise HTTPException(status_code=413, detail="source conversation is too long")
    # Keep the branch prompt bounded even when an individual assistant reply is
    # large.  The newest messages carry the actionable context; retain the
    # beginning marker so the model knows that older content was truncated.
    prefix = "Read-only context from the original account conversation:"
    lines = [
        ("user" if message.role == "user" else "assistant") + ": " + str(message.text or "")
        for message in messages
    ]
    if row.storage_mode == "endpoint":
        from ..services import account_endpoint_history
        lines = [item["role"] + ": " + item["text"]
                 for item in await account_endpoint_history.context(session, client, row, _MAX_MESSAGES)]
    selected = []
    total = 0
    context_limit = max(0, min(150_000, 190_000 - len(instruction)))
    for line in reversed(lines):
        if total + len(line) + 2 > context_limit:
            break
        selected.append(line)
        total += len(line) + 2
    selected.reverse()
    context_parts = [prefix]
    if len(selected) < len(lines):
        context_parts.append("[older context omitted]")
    context_parts.extend(selected)
    context = "\n\n".join(context_parts)
    branch_text = (context + "\n\nContinuation request:\n" + instruction).strip()
    if len(branch_text) > 200_000:
        # Preserve the new request in full; dropping the tail could change the
        # user's intent.  The source transcript is optional context.
        branch_text = instruction

    from ..services import cloud_conversations
    options = {
        "sessionId": "cloud-" + request_id,
        "agentId": agent_id,
        "model": model,
        "title": row.title or instruction[:80],
        "text": branch_text,
        "userText": instruction,
        "requiredSkills": [],
        **({"targetRunnerId": target_runner_id} if target_runner_id else {}),
        **({"targetRunnerKind": target_runner_kind} if target_runner_kind else {}),
    }
    receipt = await cloud_conversations.create(session, client, request_id, options, [])
    if not isinstance(receipt, dict) or receipt.get("ok") is False:
        raise HTTPException(status_code=502, detail="branch task could not be created")
    return {
        **receipt,
        "transferId": request_id,
        "sessionId": "cloud-" + request_id,
        "branch": {
            "accountConversationId": row.id,
            "expectedRevision": expected_revision,
            **({"targetRunnerKind": target_runner_kind} if target_runner_kind else {}),
        },
    }

