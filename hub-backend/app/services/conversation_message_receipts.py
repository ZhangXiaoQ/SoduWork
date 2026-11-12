"""Durable send receipts around the existing Runner comment/turnId queue.

If the Hub dies after sending but before storing the receipt, keep the send
uncertain. Never manufacture an ACK or blindly replay that external operation.
"""
import asyncio
import hashlib
import json
import re
import uuid

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from ..conversation_handoff_models import ConversationMessageReceipt as Receipt
from . import ai_exec


async def send(session, client, task_id, ref, text, message_id, ctx, *, execution_selection=None, file_manifest=None):
    from . import cloud_acceptance
    if await cloud_acceptance.status(session, task_id):
        raise HTTPException(409, "自动验收会话保留本轮报告；请回到原需求查看结果或重新发起验收")
    if not isinstance(message_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,80}", message_id):
        raise HTTPException(400, "消息编号格式不正确")
    row_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "soduwork:message:" + client.id + ":" + task_id + ":" + message_id))
    content = text if execution_selection is None else json.dumps(
        {"text": text, "executionSelection": execution_selection}, sort_keys=True, ensure_ascii=False)
    if file_manifest:
        content = json.dumps({"content": content, "files": file_manifest}, sort_keys=True, ensure_ascii=False)
    if ctx.get("_turnPlugins"):
        content = json.dumps({"content": content, "plugins": ctx["_turnPlugins"]}, sort_keys=True, ensure_ascii=False)
    if ctx.get("_turnSkills"):
        content = json.dumps({"content": content, "skills": ctx["_turnSkills"]}, sort_keys=True, ensure_ascii=False)
    digest = hashlib.sha256(content.encode()).hexdigest()
    row = await session.get(Receipt, row_id)
    account_id = str(uuid.uuid5(uuid.NAMESPACE_URL,
        "soduwork:cloud-message:" + str(client.user_ref or "") + ":" + task_id + ":" + message_id))
    if row is None and client.user_ref:
        row = await session.get(Receipt, account_id)
        if row is not None:
            row_id = account_id
    if row is None:
        from . import cloud_message_recovery
        payload = await cloud_message_recovery.envelope(session, client, task_id, ref, text, ctx)
        if ctx.get("_turnSkills") and not payload:
            raise HTTPException(409, "原会话暂不支持可靠的技能续聊，请刷新执行器连接")
        if ctx.get("_turnPlugins") and not payload:
            raise HTTPException(409, "原会话暂不支持可靠的插件续聊，请刷新原电脑连接")
        if payload:
            row_id = account_id
            from . import conversation_content
            conversation_content.require_endpoint(payload["runnerId"])
            if conversation_content.supported(payload["runnerId"]):
                pointer = await conversation_content.put_json(payload["runnerId"], client.user_ref, "message:" + row_id, payload, session=session)
                payload = {key: payload[key] for key in ("schema", "ownerUserId", "ref", "runnerId", "runnerBootId")}
                payload["contentRef"] = pointer
        row = Receipt(id=row_id, task_id=task_id, owner_client_id=client.id,
                      message_id=message_id, content_hash=digest, payload=payload,
                      created_at=cloud_message_recovery.now(),
                      phase="queued" if payload else "sending",
                      retry_after=cloud_message_recovery.now() if payload else None)
        session.add(row)
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
        else:
            if payload:
                await cloud_message_recovery.attempt(row_id)
                row = await session.get(Receipt, row_id, populate_existing=True)
                return cloud_message_recovery.public(row)
            result = await asyncio.to_thread(ai_exec.say_sync, ctx, ref, text, message_id=row_id)
            if result.get("ok"):
                row.phase, row.receipt = "accepted", dict(result)
                await session.commit()
                return {**result, "messageId": message_id, "delivery": "accepted"}
            # An explicit refusal before send is retryable; an unconfirmed RPC
            # remains fenced. Keep the original error for a useful user recovery.
            row.phase = "uncertain" if result.get("uncertain") else "rejected"
            row.receipt = dict(result)
            await session.commit()
    row = await session.get(Receipt, row_id, populate_existing=True)
    if row.content_hash != digest:
        raise HTTPException(409, "消息编号已用于另一段内容")
    if row.payload:
        from . import cloud_message_recovery
        return cloud_message_recovery.public(row)
    if row.phase == "accepted":
        return {**row.receipt, "messageId": message_id, "delivery": "accepted", "duplicate": True}
    if row.phase == "rejected":
        return {**row.receipt, "messageId": message_id, "delivery": "rejected"}
    return {"ok": False, "pending": True, "uncertain": True, "messageId": message_id,
            "delivery": "uncertain", "error": "正在核对这条消息是否已送达，请不要重复发送"}
