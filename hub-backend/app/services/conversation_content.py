"""Hub-side references to durable endpoint content, never a body cache.

Callers must first authorize the owner and source execution. References are
bound to an owner, endpoint and logical record; no caller-selected paths exist.
"""
from __future__ import annotations

import base64
import asyncio
import hashlib
import json

from fastapi import HTTPException

from . import runner_hub
from .runner_content_store import CHUNK, MAX_OBJECT


def supported(runner_id):
    runner = runner_hub.get(runner_id)
    return bool(runner and "conversationContent1" in getattr(runner, "caps", []))


def metadata_only():
    from ..config import get_settings
    return get_settings().soduwork_conversation_metadata_only


def require_endpoint(runner_id):
    if metadata_only() and not supported(runner_id):
        raise HTTPException(409, "请更新并连接会话执行终端，Hub 已停用正文保存")


async def save_options(runner_id, owner, record, options, *, session=None):
    """Keep execution selection metadata readable while moving user material."""
    require_endpoint(runner_id)
    keys = ("instruction", "userText", "inputPreparation", "sourceGoal")
    body = {key: options[key] for key in keys if key in options}
    if not body or not supported(runner_id):
        return options
    pointer = await put_json(runner_id, owner, record, body, session=session)
    return {**{key: value for key, value in options.items() if key not in keys}, "contentRef": pointer}


async def load_options(owner, record, options, *, session=None):
    if not options.get("contentRef"):
        return options
    body = await get_json(options["contentRef"], owner, record, session=session)
    return {**options, **body}


def scope(owner: str, record: str) -> str:
    if not owner or not record:
        raise ValueError("Conversation content requires an owner and record")
    return hashlib.sha256(json.dumps([owner, record], separators=(",", ":")).encode()).hexdigest()


def _runner(runner_id):
    runner = runner_hub.get(runner_id)
    if not runner or not runner.alive() or "conversationContent1" not in getattr(runner, "caps", []):
        raise HTTPException(409, "会话存储终端未连接或需要更新，请连接原终端后重试")
    return runner


async def owned_endpoint(session, client, runner_id):
    """Authorize storage independently of Agent login, skills or dispatch load."""
    from sqlalchemy import select
    from ..automation_models import RunnerNode
    from ..models import Client
    if not client.user_ref:
        raise HTTPException(403, "请先登录当前账号")
    node = await session.scalar(select(RunnerNode).where(RunnerNode.id == runner_id)
        .execution_options(populate_existing=True))
    if not node or node.auth_state == "revoked" or node.management_state in {"retired", "pending_setup"}:
        raise HTTPException(409, "原会话存储终端暂不可用，请恢复连接后重试")
    if node.owner_user_id:
        allowed = node.owner_user_id == client.user_ref
    else:
        source = await session.scalar(select(Client).where(Client.id == node.client_id)
            .execution_options(populate_existing=True)) if node.client_id else None
        allowed = bool(source and source.auth_state == "active" and source.user_ref == client.user_ref)
    if not allowed:
        raise HTTPException(403, "原会话存储终端不属于当前账号")
    runner = _runner(runner_id)
    if (str(getattr(runner, "owner_user_id", "") or "") != str(node.owner_user_id or "")
            or str(getattr(runner, "client_id", "") or "") != str(node.client_id or "")):
        raise HTTPException(409, "会话存储终端归属已变化，请刷新后重试")
    return runner


async def _call(runner, op, body, session=None):
    from .runner_access_policy import content_transaction
    with content_transaction(session):
        reply = await runner.call(op, body, timeout=30)
    if not isinstance(reply, dict) or reply.get("ok") is not True or not isinstance(reply.get("data"), dict):
        raise HTTPException(503, "会话正文尚未获得终端持久化确认，请重试")
    return reply["data"]


async def put(runner_id: str, owner: str, record: str, value: bytes, *, session=None, resume=False) -> dict:
    if not isinstance(value, bytes) or len(value) > MAX_OBJECT:
        raise HTTPException(413, "会话正文超过单次传输上限")
    runner = _runner(runner_id)
    digest, namespace = hashlib.sha256(value).hexdigest(), scope(owner, record)
    pointer = {"schema": 1, "runnerId": runner_id, "scope": namespace, "sha256": digest, "size": len(value)}
    if resume:
        saved = await _call(runner, "content.status", {"scope": namespace, "sha256": digest}, session)
        if saved.get("durable") is True:
            if any(saved.get(key) != pointer[key] for key in ("scope", "sha256", "size")):
                raise HTTPException(502, "终端返回的会话持久化回执不匹配")
            return pointer
    for offset in range(0, max(1, len(value)), CHUNK):
        chunk = value[offset:offset + CHUNK]
        receipt = await _call(runner, "content.put", {"scope": namespace, "sha256": digest,
            "size": len(value), "offset": offset, "b64": base64.b64encode(chunk).decode("ascii")}, session)
        if receipt.get("offset") != offset or receipt.get("size") != len(chunk):
            raise HTTPException(502, "终端返回的会话分片回执不匹配")
    receipt = await _call(runner, "content.seal", {"scope": namespace, "sha256": digest}, session)
    if (receipt.get("durable") is not True or receipt.get("sha256") != digest
            or receipt.get("scope") != namespace or receipt.get("size") != len(value)):
        raise HTTPException(502, "终端返回的会话持久化回执不匹配")
    return pointer


async def stream(pointer: dict, owner: str, record: str, *, session=None):
    if (not isinstance(pointer, dict) or pointer.get("schema") != 1
            or pointer.get("scope") != scope(owner, record)
            or type(pointer.get("size")) is not int or not 0 <= pointer["size"] <= MAX_OBJECT):
        raise HTTPException(409, "会话正文引用与当前账号不匹配")
    runner = _runner(pointer.get("runnerId"))
    checksum = hashlib.sha256()
    for offset in range(0, max(1, pointer["size"]), CHUNK):
        receipt = await _call(runner, "content.read", {"scope": pointer["scope"],
            "sha256": pointer["sha256"], "offset": offset}, session)
        if any(receipt.get(key) != pointer[key] for key in ("scope", "sha256", "size")) or receipt.get("offset") != offset:
            raise HTTPException(502, "终端返回的会话正文与请求不匹配")
        try:
            if not isinstance(receipt.get("b64"), str) or len(receipt["b64"]) > ((CHUNK + 2) // 3) * 4:
                raise ValueError("Oversized content chunk")
            data = base64.b64decode(receipt["b64"], validate=True)
        except (KeyError, ValueError):
            raise HTTPException(502, "终端返回的会话正文格式无效") from None
        if len(data) != min(CHUNK, pointer["size"] - offset):
            raise HTTPException(502, "终端返回的会话正文不完整")
        checksum.update(data)
        yield data
    if checksum.hexdigest() != pointer["sha256"]:
        raise HTTPException(502, "会话正文校验失败")


async def get(pointer: dict, owner: str, record: str, *, session=None) -> bytes:
    return b"".join([chunk async for chunk in stream(pointer, owner, record, session=session)])


async def put_json(runner_id, owner, record, value, *, session=None, resume=False):
    data = await asyncio.to_thread(lambda: json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf8"))
    return await put(runner_id, owner, record, data, session=session, resume=resume)


async def get_json(pointer, owner, record, *, session=None):
    data = await get(pointer, owner, record, session=session)
    return await asyncio.to_thread(json.loads, data)
