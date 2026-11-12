"""Move event bodies to the endpoint while retaining Hub ordering and receipts."""
from __future__ import annotations

import hashlib
import json
from types import SimpleNamespace

from fastapi import HTTPException
from sqlalchemy import select

from ..models import Task
from . import conversation_content

METADATA = {"seg", "round", "admissionKey", "admissionStartSeq", "turnState",
            "sourceId", "callId", "isError", "streamId", "done", "delta",
            "usage", "usageScope", "toolKind", "sentAt", "state", "phase"}


async def externalize(session, execution, values):
    if values:
        conversation_content.require_endpoint(execution.runner_id)
    if not values or not conversation_content.supported(execution.runner_id):
        return values
    owner = await session.scalar(select(Task.owner_user_id).where(Task.id == execution.task_id))
    if not owner:
        if conversation_content.metadata_only():
            raise HTTPException(409, "旧执行记录缺少归属，请先完成迁移归属核对")
        # Legacy unowned jobs need an explicit administrator migration target.
        return values
    bodies = [{"seq": item["seq"], "text": item["text"], "detail": item["detail"]} for item in values]
    checksum = hashlib.sha256(json.dumps(bodies, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    record = "events:" + execution.id + ":" + checksum
    pointer = await conversation_content.put_json(execution.runner_id, owner, record, bodies, session=session)
    return [{**item, "text": "", "detail": {
        **{key: value for key, value in item["detail"].items() if key in METADATA},
        "contentRef": {**pointer, "record": record, "ownerUserId": owner, "index": index},
    }} for index, item in enumerate(values)]


async def hydrate(rows, *, strict=True, session=None):
    cache, result = {}, []
    for row in rows:
        pointer = (row.detail or {}).get("contentRef")
        if not pointer:
            result.append(row)
            continue
        key = (pointer.get("runnerId"), pointer.get("scope"), pointer.get("sha256"))
        try:
            if key not in cache:
                cache[key] = await conversation_content.get_json(pointer, pointer["ownerUserId"], pointer["record"], session=session)
            body = cache[key][pointer["index"]]
            if body["seq"] != row.seq:
                raise HTTPException(502, "终端会话事件顺序不匹配")
            result.append(SimpleNamespace(seq=row.seq, kind=row.kind, tool=row.tool,
                text=body["text"], detail=body["detail"], at=row.at))
        except (HTTPException, KeyError, IndexError, TypeError, ValueError) as error:
            if strict:
                if isinstance(error, HTTPException):
                    raise
                raise HTTPException(502, "终端返回的会话事件格式无效") from None
            result.append(SimpleNamespace(seq=row.seq, kind=row.kind, tool=row.tool,
                text="", detail={**row.detail, "contentUnavailable": True}, at=row.at))
    return result
