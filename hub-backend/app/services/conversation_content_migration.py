"""Explicit, resumable migration; no production migration runs at startup.

Every destructive database update follows a matching endpoint seal and a fresh
row/version check. Unreachable endpoints retain their existing Hub content.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import uuid

from fastapi import HTTPException
from sqlalchemy import select, update

from ..account_conversation_models import AccountConversation, AccountConversationMessage, PersonalConversationRelay
from ..conversation_handoff_models import ConversationHandoff, ConversationMessageReceipt
from ..models import Task, Attachment, Client, TaskEvent, AiScheduleRun
from . import conversation_content, storage


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()


def actor(client):
    return client.id, client.user_ref, int(client.auth_version or 1)


async def assert_actor(session, captured):
    current = (await session.execute(select(Client.user_ref, Client.auth_version, Client.auth_state)
        .where(Client.id == captured[0]).with_for_update())).first()
    if not current or tuple(current) != (captured[1], captured[2], "active"):
        raise HTTPException(409, "迁移期间登录状态已变化，Hub 原文已保留")


async def account(session, client, row, target_client_id):
    captured_actor = actor(client)
    from ..api import desktop_capabilities, account_conversations
    if row.owner_user_id != client.user_ref:
        raise HTTPException(403, "会话不属于当前账号")
    _, endpoint = await desktop_capabilities.resolve(session, client, target_client_id)
    if "desktopHistory1" not in endpoint.caps:
        raise HTTPException(409, "请更新目标电脑客户端后迁移")
    version, identity = (row.source_revision, row.revision, row.deleted, row.archived), row.id
    has_body = await session.scalar(select(AccountConversationMessage.id).where(
        AccountConversationMessage.conversation_id == row.id, AccountConversationMessage.text != "").limit(1))
    if row.content_ref and not has_body:
        return {"ok": True, "alreadyMigrated": True, "conversationId": identity}
    # No Hub row is mutated yet. Release each transport policy transaction
    # before asking the desktop to import, whose signed request re-enters Hub.
    from .account_content_export import export
    pointer, count, visible = await export(session, row, endpoint.id)
    receipt = await desktop_capabilities.request(target_client_id, {
        "requestId": "migration-" + uuid.uuid4().hex, "operation": "conversation.history",
        "args": {"action": "import", "pointer": pointer,
                 "metadata": account_conversations._conversation_json(row, client.id)},
    }, client, session)
    if (receipt.get("ok") is not True or receipt.get("durable") is not True
            or not re.fullmatch(r"migrated-[a-f0-9]{64}", str(receipt.get("id", "")))
            or any(receipt.get(key) != pointer[key] for key in ("sha256", "size"))):
        raise HTTPException(409, "本地副本尚未完整保存，Hub 原文已保留")
    current = await session.scalar(select(AccountConversation).where(
        AccountConversation.id == identity).with_for_update().execution_options(populate_existing=True))
    if (not current or current.owner_user_id != client.user_ref
            or (current.source_revision, current.revision, current.deleted, current.archived) != version):
        raise HTTPException(409, "迁移期间会话已更新，原文已保留，请重试")
    await assert_actor(session, captured_actor)
    current.content_ref = {**pointer, "targetClientId": target_client_id,
                           "localReplicaId": receipt.get("id", ""), "sourceRevision": version[0]}
    current.storage_mode = "endpoint"
    current.message_count = max(current.message_count, visible)
    await session.execute(update(AccountConversationMessage).where(
        AccountConversationMessage.conversation_id == identity).values(text=""))
    await session.commit()
    return {"ok": True, "conversationId": identity, "sha256": pointer["sha256"], "messages": count}


async def handoff(session, client, row):
    captured_actor = actor(client)
    if row.owner_user_id != client.user_ref or row.phase == "committing":
        raise HTTPException(409, "会话正在交接或归属不匹配，请稍后重试")
    captured = fingerprint([row.options, row.source, row.storage_key, row.backend, row.phase])
    runner_id = (row.options.get("targetSnapshot") or {}).get("runnerId") or row.options["assigneeId"].split(":")[1]
    await conversation_content.owned_endpoint(session, client, runner_id)
    options = await conversation_content.load_options(row.owner_user_id, "handoff:" + row.id, row.options, session=session)
    task = await session.get(Task, row.task_id)
    task_note = task.note if task and task.origin in {"cloud-conversation", "conversation-handoff"} else None
    if task_note:
        options["instruction"] = options.get("instruction") or task_note
        options["legacyTaskNote"] = task_note
    if row.source.get("goal"):
        options["legacySourceGoal"] = row.source["goal"]
    briefs = list((await session.scalars(select(TaskEvent).where(TaskEvent.task_id == row.task_id,
        TaskEvent.detail["carried"]["brief"].as_string() != ""))).all())
    brief_versions = {event.id: fingerprint(event.detail) for event in briefs}
    if briefs:
        options["legacyDispatchBriefs"] = [{"id": event.id, "brief": event.detail["carried"]["brief"]} for event in briefs]
    material = {key: options[key] for key in ("instruction", "userText", "inputPreparation", "sourceGoal", "legacyTaskNote", "legacySourceGoal", "legacyDispatchBriefs") if key in options}
    if material:
        pointer = await conversation_content.put_json(runner_id, row.owner_user_id, "handoff:" + row.id, material, session=session)
        options = {**{key: value for key, value in options.items() if key not in material}, "contentRef": pointer}
    key, backend = row.storage_key, row.backend
    if key:
        data = await asyncio.to_thread(storage.get, key, backend)
        if hashlib.sha256(data).hexdigest() != row.sha256:
            raise HTTPException(409, "原交接文件校验失败，未删除任何数据")
        options["archiveRef"] = await conversation_content.put(runner_id, row.owner_user_id, "archive:" + row.id, data, session=session)
        options["legacyBlob"] = {"key": key, "backend": backend}
    current = await session.scalar(select(ConversationHandoff).where(ConversationHandoff.id == row.id)
        .with_for_update().execution_options(populate_existing=True))
    if not current or current.owner_user_id != client.user_ref or captured != fingerprint([current.options, current.source, current.storage_key, current.backend, current.phase]):
        raise HTTPException(409, "迁移期间交接状态已变化，原文已保留")
    current_task = await session.scalar(select(Task).where(Task.id == row.task_id)
        .with_for_update().execution_options(populate_existing=True)) if task_note is not None else None
    if current_task and current_task.note != task_note:
        raise HTTPException(409, "迁移期间会话内容已更新，原文已保留")
    current_briefs = list((await session.scalars(select(TaskEvent).where(TaskEvent.id.in_(brief_versions))
        .with_for_update().execution_options(populate_existing=True))).all()) if brief_versions else []
    if any(fingerprint(event.detail) != brief_versions[event.id] for event in current_briefs):
        raise HTTPException(409, "迁移期间会话记录已更新，原文已保留")
    await assert_actor(session, captured_actor)
    current.options = options
    current.source = {**current.source, "goal": ""}
    current.storage_key, current.backend = "", ""
    for event in current_briefs:
        event.detail = {**event.detail, "carried": {**event.detail["carried"], "brief": ""}}
    if options.get("archiveRef"):
        attachments = list((await session.scalars(select(Attachment).where(
            Attachment.task_id == row.task_id, Attachment.role == "handoff").with_for_update())).all())
        for attachment in attachments:
            attachment.storage_key, attachment.backend = "", ""
            attachment.evidence_meta = {**(attachment.evidence_meta or {}),
                "contentRef": options["archiveRef"], "contentRecord": "archive:" + row.id,
                "contentOwner": row.owner_user_id}
    if task_note is not None:
        await session.execute(update(Task).where(Task.id == row.task_id, Task.note == task_note).values(note=""))
    await session.commit()
    legacy = options.get("legacyBlob")
    if legacy:
        await asyncio.to_thread(storage.delete, legacy["key"], legacy["backend"])
        current.options = {key: value for key, value in options.items() if key != "legacyBlob"}
        await session.commit()
    return {"ok": True, "handoffId": row.id}


async def pending_message(session, client, row):
    captured_actor = actor(client)
    payload = dict(row.payload or {})
    parent = await session.scalar(select(ConversationHandoff).where(ConversationHandoff.task_id == row.task_id))
    if not parent or parent.owner_user_id != client.user_ref:
        raise HTTPException(403, "原云端会话归属不匹配")
    if payload and payload.get("ownerUserId") != client.user_ref:
        raise HTTPException(403, "消息不属于当前账号")
    if not payload or payload.get("contentRef"):
        return {"ok": True, "alreadyMigrated": True}
    await conversation_content.owned_endpoint(session, client, payload["runnerId"])
    captured = fingerprint(payload)
    pointer = await conversation_content.put_json(payload["runnerId"], client.user_ref, "message:" + row.id, payload, session=session)
    current = await session.scalar(select(ConversationMessageReceipt).where(ConversationMessageReceipt.id == row.id)
        .with_for_update().execution_options(populate_existing=True))
    if not current or captured != fingerprint(current.payload):
        raise HTTPException(409, "消息送达状态已更新，原文已保留")
    await session.refresh(parent, with_for_update=True)
    if parent.owner_user_id != client.user_ref:
        raise HTTPException(409, "迁移期间会话归属已变化，原文已保留")
    await assert_actor(session, captured_actor)
    current.payload = {**{key: payload[key] for key in ("schema", "ownerUserId", "ref", "runnerId", "runnerBootId") if key in payload},
                       "contentRef": pointer}
    await session.commit()
    return {"ok": True, "messageId": row.id}


async def relay(session, client, row):
    captured_actor = actor(client)
    from ..api import desktop_capabilities
    if row.owner_user_id != client.user_ref:
        raise HTTPException(403, "消息不属于当前账号")
    if not row.instruction:
        return {"ok": True, "alreadyMigrated": True}
    captured = fingerprint([row.instruction, row.phase, row.owner_user_id])
    _, endpoint = await desktop_capabilities.resolve(session, client, row.source_client_id)
    pointer = await conversation_content.put_json(endpoint.id, row.owner_user_id, "relay:" + row.id,
                                                 {"instruction": row.instruction}, session=session)
    current = await session.scalar(select(PersonalConversationRelay).where(PersonalConversationRelay.id == row.id)
        .with_for_update().execution_options(populate_existing=True))
    if not current or captured != fingerprint([current.instruction, current.phase, current.owner_user_id]):
        raise HTTPException(409, "迁移期间接力状态已更新，原文已保留")
    await assert_actor(session, captured_actor)
    current.content_ref, current.instruction = pointer, ""
    await session.commit()
    return {"ok": True, "relayId": row.id}


async def execution(session, client, row, *, limit=200):
    captured_actor = actor(client)
    from ..automation_models import ExecutionEvent
    from . import endpoint_events, task_access
    await task_access.view_task(session, client, row.task_id)
    events = list((await session.scalars(select(ExecutionEvent).where(
        ExecutionEvent.session_id == row.id,
        ExecutionEvent.detail["contentRef"].as_string().is_(None),
    ).order_by(ExecutionEvent.seq).limit(limit))).all())
    if not events:
        return {"ok": True, "migrated": 0, "complete": True}
    snapshot = {event.id: fingerprint([event.text, event.detail]) for event in events}
    values = [{"session_id": row.id, "seq": event.seq, "kind": event.kind, "tool": event.tool,
               "text": event.text, "detail": dict(event.detail or {}), "at": event.at} for event in events]
    stored = await endpoint_events.externalize(session, row, values)
    if any(not value["detail"].get("contentRef") for value in stored):
        raise HTTPException(409, "原执行机未准备好迁移，Hub 原文已保留")
    current = list((await session.scalars(select(ExecutionEvent).where(ExecutionEvent.id.in_(snapshot))
        .with_for_update().execution_options(populate_existing=True))).all())
    await assert_actor(session, captured_actor)
    by_seq = {value["seq"]: value for value in stored}
    migrated = 0
    for event in current:
        if fingerprint([event.text, event.detail]) != snapshot[event.id]:
            continue
        event.text, event.detail = "", by_seq[event.seq]["detail"]
        migrated += 1
    await session.commit()
    return {"ok": True, "migrated": migrated, "complete": len(events) < limit}


async def schedule(session, client, row):
    from . import schedule_content
    captured_actor = actor(client)
    if row.owner_user_id != client.user_ref:
        raise HTTPException(403, "自动化记录不属于当前账号")
    envelope = dict((row.receipt or {}).get("conversationInput") or {})
    if not envelope or "text" not in envelope:
        return {"ok": True, "alreadyMigrated": True}
    version = fingerprint([row.owner_user_id, row.owner_client_id, row.receipt, row.state])
    stored = await schedule_content.save(session, client, row, envelope, required=True)
    current = await session.scalar(select(AiScheduleRun).where(AiScheduleRun.id == row.id)
        .with_for_update().execution_options(populate_existing=True))
    if not current or version != fingerprint([current.owner_user_id, current.owner_client_id, current.receipt, current.state]):
        raise HTTPException(409, "迁移期间自动化记录已更新，Hub 原文已保留")
    await assert_actor(session, captured_actor)
    current.receipt = {**current.receipt, "conversationInput": stored}
    await session.commit()
    return {"ok": True, "runId": row.id}
