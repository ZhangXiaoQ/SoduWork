"""Read source transcripts over the existing account-authorized PC transport."""
import uuid

from fastapi import HTTPException


async def page(session, client, row, after=0, limit=100):
    from ..api import desktop_capabilities, account_conversations
    if row.owner_user_id != client.user_ref:
        raise HTTPException(403, "会话不属于当前账号")
    pointer = row.content_ref or {}
    migrated = pointer.get("localReplicaId") and pointer.get("sourceRevision") == row.source_revision
    source_id = pointer["localReplicaId"] if migrated else row.source_session_id
    source_client = pointer["targetClientId"] if migrated else row.source_client_id
    result = await desktop_capabilities.request(source_client, {
        "requestId": "history-" + uuid.uuid4().hex, "operation": "conversation.history",
        "args": {"action": "read", "id": source_id, "after": after, "limit": min(200, limit)},
    }, client, session)
    local = result.get("conversation") or {}
    if local.get("id") != source_id:
        raise HTTPException(502, "来源电脑返回的会话不匹配")
    if local.get("deleted"):
        raise HTTPException(410, "来源电脑的本地副本已删除，未自动恢复")
    return {**result, "conversation": account_conversations._conversation_json(row, client.id)}


async def context(session, client, row, maximum=1000):
    after, messages = 0, {}
    while True:
        result = await page(session, client, row, after)
        for message in result.get("items", []):
            key = message["id"]
            old = messages.get(key, {})
            messages[key] = {**message, "text": (old.get("text", "") if message.get("delta") else "") + message.get("text", "")}
        if len(messages) > maximum or sum(len(item["text"]) for item in messages.values()) > 32 * 1024 * 1024:
            raise HTTPException(413, "会话内容较大，请在来源电脑选择需要接续的内容")
        if not result.get("hasMore"):
            return list(messages.values())
        cursor = result.get("cursor")
        if type(cursor) is not int or cursor <= after:
            raise HTTPException(502, "来源电脑会话游标未前进")
        after = cursor
