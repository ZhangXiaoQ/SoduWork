"""Bound legacy account exports by page, independently of transcript length."""
from sqlalchemy import select, func, or_, and_

from ..account_conversation_models import AccountConversationMessage as Message
from . import conversation_content

PAGE_BYTES = 4 * 1024 * 1024
FORMAT = "soduwork.account-history.pages.v1"


async def export(session, row, runner_id):
    from ..api.account_conversations import _message_json
    query = select(Message).where(Message.conversation_id == row.id)
    count, characters = (await session.execute(select(func.count(Message.id),
        func.coalesce(func.sum(func.length(Message.text)), 0))
        .where(Message.conversation_id == row.id))).one()
    record = "account:" + row.id
    # Preserve the original single-object format for small existing clients.
    # Four bytes per character bounds UTF-8; metadata is bounded by the API.
    if count <= 100 and characters * 4 + count * 4096 <= PAGE_BYTES:
        messages = list((await session.scalars(query.order_by(Message.position, Message.id))).all())
        body = [_message_json(message) for message in messages]
        pointer = await conversation_content.put_json(runner_id, row.owner_user_id, record, body, resume=True)
        return pointer, len(body), sum(not item.deleted for item in messages)
    import json
    pages, body, size, total, visible, cursor = [], [], 2, 0, 0, None

    async def flush():
        nonlocal body, size
        if not body:
            return
        pointer = await conversation_content.put_json(runner_id, row.owner_user_id, record, body, resume=True)
        pages.append({**pointer, "count": len(body)})
        body, size = [], 2

    while True:
        page_query = query
        if cursor:
            page_query = page_query.where(or_(Message.position > cursor[0],
                and_(Message.position == cursor[0], Message.id > cursor[1])))
        batch = list((await session.scalars(page_query.order_by(Message.position, Message.id).limit(20))).all())
        if not batch:
            break
        for message in batch:
            item = _message_json(message)
            item_size = len(json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode()) + 1
            if body and size + item_size > PAGE_BYTES:
                await flush()
            body.append(item)
            size += item_size
            total += 1
            visible += not message.deleted
            cursor = message.position, message.id
            session.expunge(message)
        # Source revision/lifecycle is checked again before any Hub body removal.
    await flush()
    pointer = await conversation_content.put_json(runner_id, row.owner_user_id, record,
        {"format": FORMAT, "pages": pages, "count": total}, resume=True)
    return pointer, total, visible
