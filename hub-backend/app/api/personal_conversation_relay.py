"""Authenticated native-session admission, without creating another task queue."""
import hashlib
import json
import re
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from ..account_conversation_models import AccountConversation, PersonalConversationRelay as Relay
from ..db import get_session
from ..deps import current_client, identity_only
from ..models import Client
from ..services import native_discovery

router = APIRouter(prefix="/api/v1/personal-conversation-relay", tags=["account-conversations"])
PREFIX = "personalConversationRelay"


def now():
    return datetime.now(timezone.utc)


def utc(value):
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def owner(client):
    if not client.user_ref or client.auth_state != "active":
        raise HTTPException(403, "请先登录当前账号")
    return str(client.user_ref)


async def conversation(session, client, cid, *, receipt_only=False):
    row = await session.get(AccountConversation, cid)
    if not row or row.owner_user_id != owner(client):
        raise HTTPException(404, "会话不存在或当前账号无权访问")
    if not receipt_only and (row.deleted or row.archived):
        raise HTTPException(409, "原会话已关闭，请在来源电脑检查")
    source = await session.get(Client, row.source_client_id)
    if not source or source.auth_state != "active" or source.user_ref != row.owner_user_id:
        raise HTTPException(403, "来源电脑的账号归属已变化")
    return row, source


async def available(source):
    try:
        if await native_discovery.presence.available(source.id, source.user_ref, source.auth_version):
            return True
    except native_discovery.PresenceUnavailable:
        return False
    presence = (source.config or {}).get(PREFIX) or {}
    return (presence.get("owner") == source.user_ref and presence.get("protocol") == 1
            and presence.get("authVersion", int(source.auth_version or 1)) == int(source.auth_version or 1)
            and isinstance(presence.get("at"), (int, float))
            and 0 <= now().timestamp() - presence["at"] < 30)


def public(row):
    return {"id": row.id, "requestId": row.request_id, "conversationId": row.conversation_id,
            "targetClientId": row.source_client_id, "phase": row.phase, "reason": row.reason,
            "nativeSession": True}


async def expire(session, row):
    if row.phase == "prepared" and utc(row.expires_at) <= now():
        await session.execute(update(Relay).where(Relay.id == row.id, Relay.phase == "prepared").values(
            phase="rejected", reason="电脑未及时接收，未自动执行；请确认电脑在线后重新发送", active_conversation_id=None))
        await session.commit()
        await session.refresh(row)
    return row


@router.get("/targets/{cid}")
async def target(cid: str, client=Depends(current_client), session=Depends(get_session)):
    row, source = await conversation(session, client, cid)
    ready = await available(source)
    return {"available": ready, "targetClientId": source.id,
            "name": source.name or row.source_device_name or "本人电脑",
            "reason": "" if ready else "来源电脑未在线或尚未加载接力版本，请打开并登录同一账号",
            "mode": "native-session", "revision": row.revision}


@router.post("/requests/{request_id}")
async def prepare(request_id: str, body: dict = Body(...), client=Depends(current_client), session=Depends(get_session)):
    uid = owner(client)
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", request_id) or set(body) != {
        "conversationId", "targetClientId", "expectedRevision", "instruction"}:
        raise HTTPException(422, "接力请求格式不正确")
    instruction = body.get("instruction")
    if not isinstance(instruction, str) or not instruction.strip() or len(instruction) > 50000 or "\0" in instruction:
        raise HTTPException(422, "请输入不超过 50000 字的接力要求")
    if not isinstance(body.get("conversationId"), str) or not isinstance(body.get("targetClientId"), str):
        raise HTTPException(422, "会话与目标电脑编号不正确")
    digest = hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    rid = str(uuid.uuid5(uuid.NAMESPACE_URL, "personal-relay:" + client.id + ":" + request_id))
    old = await session.get(Relay, rid)
    if old:
        if old.owner_user_id != uid or old.request_hash != digest:
            raise HTTPException(409, "该请求编号已使用，请核对原请求结果")
        await conversation(session, client, old.conversation_id, receipt_only=True)
        return public(await expire(session, old))
    source, device = await conversation(session, client, body["conversationId"])
    if body["targetClientId"] != source.source_client_id:
        raise HTTPException(409, "只能由原会话所在的本人电脑接续，不会自动换机")
    if type(body["expectedRevision"]) is not int or body["expectedRevision"] != source.revision:
        raise HTTPException(409, "来源聊天已有更新，请刷新后重新确认")
    if source.state == "responding":
        raise HTTPException(409, "原会话仍在执行，请等待结束")
    if not await available(device):
        raise HTTPException(409, "来源电脑不在线或未准备好接力")
    active = await session.scalar(select(Relay).where(Relay.active_conversation_id == source.id))
    if active:
        await expire(session, active)
        if active.active_conversation_id:
            raise HTTPException(409, "已有接力待确认，请先核对原请求，勿重复发送")
    row = Relay(id=rid, owner_user_id=uid, requester_client_id=client.id,
        source_client_id=device.id, conversation_id=source.id, active_conversation_id=source.id,
        request_id=request_id, request_hash=digest, instruction=instruction,
        source_epoch=source.source_epoch, source_revision=source.source_revision,
        phase="prepared", reason="", expires_at=now() + timedelta(seconds=60))
    from . import desktop_capabilities
    from ..services import conversation_content
    if source.storage_mode == "endpoint" or conversation_content.metadata_only():
        _, endpoint = await desktop_capabilities.resolve(session, client, device.id)
        row.content_ref = await conversation_content.put_json(endpoint.id, uid, "relay:" + rid, {"instruction": instruction}, session=session)
        row.instruction = ""
    session.add(row)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        old = await session.get(Relay, rid)
        if old and old.owner_user_id == uid and old.request_hash == digest:
            return public(old)
        raise HTTPException(409, "已有接力请求，请核对后再试")
    await native_discovery.wake(device.id, uid, "personal-relay")
    return public(row)


@router.get("/requests/{request_id}")
async def status(request_id: str, client=Depends(current_client), session=Depends(get_session)):
    rid = str(uuid.uuid5(uuid.NAMESPACE_URL, "personal-relay:" + client.id + ":" + request_id))
    row = await session.get(Relay, rid)
    if not row or row.owner_user_id != owner(client):
        raise HTTPException(404, "未找到接力回执")
    await conversation(session, client, row.conversation_id, receipt_only=True)
    return public(await expire(session, row))


@router.post("/requests/{request_id}/resolve")
async def resolve(request_id: str, body: dict = Body(...), client=Depends(current_client), session=Depends(get_session)):
    rid = str(uuid.uuid5(uuid.NAMESPACE_URL, "personal-relay:" + client.id + ":" + request_id))
    row = await session.get(Relay, rid)
    if not row or row.owner_user_id != owner(client):
        raise HTTPException(404, "未找到接力回执")
    if set(body) != {"checkedOnSourcePC"} or body["checkedOnSourcePC"] is not True:
        raise HTTPException(422, "请先在来源电脑核对实际发送结果")
    source, _ = await conversation(session, client, row.conversation_id, receipt_only=True)
    if row.phase == "closed":
        return public(row)
    if source.state == "responding" or row.phase != "uncertain":
        raise HTTPException(409, "仍在确认或执行中，暂不能关闭回执")
    result = await session.execute(update(Relay).where(Relay.id == rid, Relay.phase == "uncertain").values(
        phase="closed", active_conversation_id=None, reason="用户已在来源电脑核对并关闭回执；未重新发送"))
    await session.commit()
    if result.rowcount != 1:
        raise HTTPException(409, "回执已变化，请重新核对")
    await session.refresh(row)
    return public(row)


@router.post("/poll")
@identity_only
async def poll(client=Depends(current_client), session=Depends(get_session), body: dict = Body(default_factory=dict)):
    uid = owner(client)
    auth_version = int(client.auth_version or 1)
    if isinstance(body, dict) and body.get("discoveryProtocol") == 1:
        try:
            await native_discovery.presence.touch(client.id, uid, client.auth_version)
        except native_discovery.PresenceUnavailable:
            raise HTTPException(503, "接力在线状态暂不可用，请稍后重试") from None
    else:
        # Old clients/Hubs use the persisted 30-second lease. Renew at most
        # every 10 seconds; the row lock makes the check authoritative across
        # PostgreSQL workers and avoids overwriting concurrent config edits.
        if isinstance(client, Client):
            stamp = (client.config or {}).get(PREFIX) or {}
        else:
            stamp = (await session.scalar(select(Client.config[PREFIX]).where(Client.id == client.id))) or {}
        at = stamp.get("at")
        if (stamp.get("owner") != uid or stamp.get("protocol") != 1 or stamp.get("authVersion") != int(client.auth_version or 1) or
                not isinstance(at, (int, float)) or not 0 <= now().timestamp() - at < 10):
            locked = await session.scalar(select(Client).where(Client.id == client.id)
                .with_for_update().execution_options(populate_existing=True))
            # Ownership may have changed while waiting for the write lock.
            if not locked or owner(locked) != uid or int(locked.auth_version or 1) != auth_version:
                raise HTTPException(403, "来源电脑的账号归属已变化")
            stamp = (locked.config or {}).get(PREFIX) or {}
            at = stamp.get("at")
            if (stamp.get("owner") != uid or stamp.get("protocol") != 1 or stamp.get("authVersion") != int(locked.auth_version or 1) or
                    not isinstance(at, (int, float)) or not 0 <= now().timestamp() - at < 10):
                locked.config = {**(locked.config or {}), PREFIX: {"owner": uid, "at": now().timestamp(), "protocol": 1,
                                                                "authVersion": int(locked.auth_version or 1)}}
                await session.commit()
    rows = list((await session.scalars(select(Relay).where(
        Relay.source_client_id == client.id, Relay.owner_user_id == uid,
        Relay.phase.in_(["prepared", "claimed"])).order_by(Relay.created_at).limit(20))).all())
    if not rows:
        return {"requests": [], "discoveryProtocol": 1}
    expired_ids = [row.id for row in rows if row.phase == "prepared" and utc(row.expires_at) <= now()]
    if expired_ids:
        await session.execute(update(Relay).where(Relay.id.in_(expired_ids), Relay.phase == "prepared").values(
            phase="rejected", reason="电脑未及时接收，未自动执行；请确认电脑在线后重新发送", active_conversation_id=None))
        await session.commit()
    rows = [row for row in rows if row.id not in expired_ids]
    if not rows:
        return {"requests": [], "discoveryProtocol": 1}
    # A bounded batch replaces one conversation/device lookup per queued job.
    sources = {row.id: row for row in (await session.scalars(select(AccountConversation).join(
        Client, Client.id == AccountConversation.source_client_id).where(
            AccountConversation.id.in_({row.conversation_id for row in rows}),
            AccountConversation.owner_user_id == uid,
            AccountConversation.source_client_id == client.id,
            AccountConversation.deleted.is_(False), AccountConversation.archived.is_(False),
            Client.user_ref == uid, Client.auth_state == "active"))).all()}
    result = []
    for row in rows:
        source = sources.get(row.conversation_id)
        if source is None:
            continue
        instruction = row.instruction
        if row.content_ref:
            from ..services import conversation_content
            instruction = (await conversation_content.get_json(row.content_ref, uid, "relay:" + row.id, session=session))["instruction"]
        result.append({**public(row), "sourceSessionId": source.source_session_id,
                       "instruction": instruction, "sourceEpoch": row.source_epoch,
                       "sourceRevision": row.source_revision})
    return {"requests": result, "discoveryProtocol": 1}


async def source_request(session, client, rid, *, receipt_only=False):
    row = await session.get(Relay, rid)
    if not row or row.source_client_id != client.id or row.owner_user_id != owner(client):
        raise HTTPException(404, "接力请求不可访问")
    source, _ = await conversation(session, client, row.conversation_id, receipt_only=receipt_only)
    return row, source


@router.post("/claims/{rid}")
async def claim(rid: str, client=Depends(current_client), session=Depends(get_session)):
    row, source = await source_request(session, client, rid)
    await expire(session, row)
    if row.phase != "prepared":
        raise HTTPException(409, "接力已领取或已结束，不得再次执行")
    if (source.source_epoch != row.source_epoch or source.source_revision != row.source_revision
            or source.state == "responding"):
        row.phase, row.reason, row.active_conversation_id = "rejected", "来源聊天已变化，未执行本次接力", None
        await session.commit()
        raise HTTPException(409, row.reason)
    # The claim and source-version predicate share one database statement.
    matching_source = select(AccountConversation.id).where(
        AccountConversation.id == row.conversation_id,
        AccountConversation.source_epoch == row.source_epoch,
        AccountConversation.source_revision == row.source_revision,
        AccountConversation.state != "responding",
        AccountConversation.archived.is_(False), AccountConversation.deleted.is_(False)).exists()
    result = await session.execute(update(Relay).where(
        Relay.id == rid, Relay.phase == "prepared", matching_source).values(phase="claimed"))
    await session.commit()
    if result.rowcount != 1:
        raise HTTPException(409, "接力已被领取")
    return {"ok": True}


@router.post("/acks/{rid}")
async def acknowledge(rid: str, body: dict = Body(...), client=Depends(current_client), session=Depends(get_session)):
    row, _ = await source_request(session, client, rid, receipt_only=True)
    phase = body.get("phase")
    if phase not in {"accepted", "rejected", "uncertain"} or set(body) - {"phase", "reason"}:
        raise HTTPException(422, "接力回执不正确")
    reason = body.get("reason", "")
    if not isinstance(reason, str):
        raise HTTPException(422, "回执说明不正确")
    if row.phase in {"accepted", "rejected"}:
        if phase != row.phase:
            raise HTTPException(409, "接力回执已固定")
        return public(row)
    if row.phase != "claimed":
        raise HTTPException(409, "请先领取接力")
    # Uncertainty never grants permission to retry the external side effect.
    result = await session.execute(update(Relay).where(Relay.id == rid, Relay.phase == "claimed").values(
        phase=phase, reason=reason[:500], active_conversation_id=row.conversation_id if phase == "uncertain" else None))
    await session.commit()
    await session.refresh(row)
    if result.rowcount != 1 and row.phase != phase:
        raise HTTPException(409, "接力回执已固定")
    return public(row)
