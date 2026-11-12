"""Pinned personal plugin selections for an existing, account-owned PC turn.

Only identifiers cross Hub. Plugin bodies and resources are resolved on the
original desktop, after admission, using its existing conversation resolver.
"""
import re

from fastapi import HTTPException


def normalize(value):
    if value is None or value == []:
        return []
    if not isinstance(value, list) or not 1 <= len(value) <= 3:
        raise HTTPException(422, "每轮最多选择三个本人电脑插件")
    result = []
    for row in value:
        if (not isinstance(row, dict) or set(row) != {"pluginId", "checksum"}
                or not isinstance(row["pluginId"], str)
                or not re.fullmatch(r"local:[A-Za-z0-9._:-]{1,160}", row["pluginId"])
                or not isinstance(row["checksum"], str)
                or not re.fullmatch(r"[a-f0-9]{64}", row["checksum"])):
            raise HTTPException(422, "插件版本信息不完整，请重新选择")
        if any(item["pluginId"] == row["pluginId"] for item in result):
            raise HTTPException(422, "插件不能重复选择")
        result.append(dict(row))
    return result


async def validate(session, client, handoff, ref, selections):
    if not selections:
        return
    from sqlalchemy import select
    from ..automation_models import ExecutionSession
    from . import runner_hub
    from ..api.desktop_capabilities import resolve
    if (not handoff or handoff.phase != "committed"
            or handoff.owner_user_id != client.user_ref):
        raise HTTPException(403, "只能为本人会话追加电脑插件")
    execution = await session.scalar(select(ExecutionSession).where(
        ExecutionSession.task_id == handoff.task_id, ExecutionSession.ref == ref))
    runner = runner_hub.get(execution.runner_id) if execution else None
    if not runner or not runner.client_id:
        raise HTTPException(409, "原会话的本人电脑暂不可用，不会切换到其他执行机")
    _, current = await resolve(session, client, runner.client_id)
    if current is not runner or "desktopPluginTurn1" not in runner.caps or "admit1" not in runner.caps:
        raise HTTPException(409, "请更新并重启原电脑客户端后，在此会话继续使用插件")


async def validate_start(session, client, runner_id):
    from . import runner_hub
    from ..api.desktop_capabilities import resolve
    runner = runner_hub.get(runner_id)
    if not runner or not runner.client_id:
        raise HTTPException(409, "所选本人电脑暂不可用，不会切换到其他执行机")
    _, current = await resolve(session, client, runner.client_id)
    if current is not runner or not {"desktopPluginStart1", "admit1"}.issubset(set(runner.caps)):
        raise HTTPException(409, "请更新并重启原电脑执行器后使用插件新建对话")
    return runner


def authorization(client, runner, ref, selections, turn_id):
    from ..auth import sign_claims
    from ..api.desktop_capabilities import digest
    # Desktop capability IDs have a narrower alphabet than dispatch/turn IDs.
    # Keep valid existing IDs; map internal IDs deterministically before signing.
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", str(turn_id)):
        import hashlib
        import json
        turn_id = "plugin-" + hashlib.sha256(json.dumps(
            [ref, turn_id], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    packet = {"operation": "plugin.prepare", "requestId": turn_id,
              "targetClientId": runner.client_id, "ownerUserId": client.user_ref,
              "args": {"ref": ref, "plugins": normalize(selections)}}
    return {**packet, "authorization": sign_claims(
        {"uid": client.user_ref, "cid": runner.client_id, "digest": digest(packet)},
        ttl_seconds=120, token_type="desktop-capability")}
