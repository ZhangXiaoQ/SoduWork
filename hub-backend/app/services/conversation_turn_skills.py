"""Explicit per-turn skills, resolved by policy and on the original Runner."""
import os
import re

FOUNDATIONS = {"browser-use": "browser", "computer-use": "computer", "office": "office"}


def _normalize(value):
    if value is None:
        return []
    if (not isinstance(value, list) or len(value) > 100 or any(
            not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name)
            for name in value)):
        raise ValueError("本轮技能列表不正确，请重新选择")
    return sorted(set(value))


def normalize(value):
    """Translate input errors at the Hub boundary, outside the standalone Runner."""
    from fastapi import HTTPException
    try:
        return _normalize(value)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


async def validate(session, client, handoff, ref, names):
    from fastapi import HTTPException
    from sqlalchemy import select
    from ..automation_models import ExecutionSession
    from . import runner_hub, skills
    if (not handoff or handoff.phase != "committed" or not client.user_ref
            or handoff.owner_user_id != client.user_ref):
        raise HTTPException(403, "只能在本人执行会话中选择技能")
    execution = await session.scalar(select(ExecutionSession).where(
        ExecutionSession.task_id == handoff.task_id, ExecutionSession.ref == ref))
    runner = runner_hub.get(execution.runner_id) if execution else None
    if not runner or not {"turnSkills1", "admit1"}.issubset(set(runner.caps)):
        raise HTTPException(409, "请更新并重启原执行器后，在此会话选择技能")
    if not runner.skills_known or not set(names).issubset(set(runner.skills or [])):
        raise HTTPException(409, "原执行机缺少本轮选择的技能，请重新选择")
    required = [FOUNDATIONS[name] for name in names if name in FOUNDATIONS]
    if not runner_hub.supports_capabilities(runner, required):
        raise HTTPException(409, "原执行机尚未安装或授权本轮技能所需能力")
    try:
        await skills.resolve_named(session, names, client)
    except ValueError as exc:
        raise HTTPException(403, str(exc)) from exc


async def prepare(machine, message):
    """Use only locally scanned paths; never accept a caller-supplied skill body."""
    import asyncio
    from . import execution_capabilities, local_base, skills, skill_read_scope
    names = _normalize(message.get("turnSkills"))
    if not names:
        return {"prompt": "", "selection": []}
    ref = str(message.get("ref") or "")
    run = local_base._RUNS.get(ref) or local_base.rehydrate(ref)
    if not run:
        raise ValueError("原会话尚未恢复，请刷新后重试")
    await machine._refresh_skills(force=True)
    catalog = {item["name"]: item for item in machine._skill_catalog}
    selected = [catalog[name] for name in names if name in catalog]
    if len(selected) != len(names) or any(not os.path.isfile(os.path.join(item["path"], "SKILL.md"))
                                         for item in selected):
        raise ValueError("原执行机上的技能已不可用，请重新选择")
    report = await asyncio.to_thread(execution_capabilities.runtime_report,
        machine.work_root, grants=machine.capability_grants)
    required = [FOUNDATIONS[name] for name in names if name in FOUNDATIONS]
    if not execution_capabilities.evaluate(report, required)["ok"]:
        raise ValueError("原执行机尚未安装或授权本轮技能所需能力")
    return {
        "prompt": "\n本轮用户明确选择的技能：" + "、".join(names) + "。请按本轮选择处理当前请求。\n" + skills.prompt_block(selected, native=False),
        "selection": skill_read_scope.trusted(selected),
    }
