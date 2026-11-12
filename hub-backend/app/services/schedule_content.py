"""Endpoint storage for immutable automation conversation inputs.

Schedule definitions remain business configuration. Once expanded for a run,
the conversation input is immutable content, not a Hub receipt field.
"""
from fastapi import HTTPException

from . import conversation_content, runner_hub


async def save(session, client, run, envelope, *, required=False):
    from ..api import desktop_capabilities
    runner = runner_hub.for_client(run.owner_client_id)
    if not required and not conversation_content.metadata_only() and (
            runner is None or not conversation_content.supported(runner.id)):
        return envelope
    _, runner = await desktop_capabilities.resolve(session, client, run.owner_client_id)
    conversation_content.require_endpoint(runner.id)
    pointer = await conversation_content.put_json(
        runner.id, run.owner_user_id, "schedule-input:" + run.id, envelope, session=session)
    return {"contentRef": pointer}


async def load(session, client, run, envelope):
    if not envelope.get("contentRef"):
        return envelope
    from ..api import desktop_capabilities
    # Historical pointers never authorize another account or another desktop.
    _, runner = await desktop_capabilities.resolve(session, client, run.owner_client_id)
    if runner.id != envelope["contentRef"].get("runnerId"):
        raise HTTPException(409, "自动化输入保存在原执行终端，请重新连接后重试")
    return await conversation_content.get_json(
        envelope["contentRef"], run.owner_user_id, "schedule-input:" + run.id, session=session)
