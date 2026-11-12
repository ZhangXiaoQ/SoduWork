"""Two-phase local-to-remote handoff over the existing task execution pipeline.

The transfer table, not editable Task routing or renderer paths, authorizes the
snapshot and destination. An abort tombstone also fences a late first upload.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError

from ..agent_catalog import AGENTS
from ..automation_models import RunnerNode
from ..conversation_handoff_models import ConversationHandoff as Handoff
from ..models import Attachment, Client, OrgUnit, Task, User
from . import ai_exec, ai_remote, dispatch_identity, portable_workspace, rbac, runner_hub, storage
from .execution_host_policy import cloud_runner_allowed
from . import handoff_agent_policy

CAPABILITY = "handoff1"
ARCHIVE_NAME = "soduwork-workspace-handoff.zip"
RUNNER_KINDS = {"work-computer", "cloud"}
_ID = re.compile(r"[A-Za-z0-9-]{1,80}")
_NS = uuid.UUID("a48e2601-e8bc-4836-9098-ec16a67ae5fa")


def identity(client_id, transfer_id):
    if not _ID.fullmatch(str(transfer_id)):
        raise HTTPException(400, "交接编号格式不正确")
    return str(uuid.uuid5(_NS, str(client_id) + ":" + transfer_id))


def dispatch_id(row):
    return "handoff:" + row.id


async def owner(session, client):
    user = await session.get(User, client.user_ref or "")
    if not user or not user.is_active or client.auth_state != "active":
        raise HTTPException(403, "请先登录有效的 SoduWork 账号")
    return user


async def scope(session, client):
    user = await owner(session, client)
    clients = list((await session.scalars(select(Client.id).where(
        Client.user_ref == user.id, Client.auth_state == "active", Client.id != client.id))).all())
    # A department may use its own and inherited shared infrastructure, never a
    # colleague's personally enrolled desktop merely because they share an org.
    # None means unrestricted only when both scope dimensions are unrestricted.
    # Keep personal devices restricted even for admins; enumerate shared orgs.
    orgs = (set((await session.scalars(select(OrgUnit.id))).all()) if user.is_super
            else await rbac.ancestor_org_ids(session, user.org_id or ""))
    return clients, orgs


async def targets(session, client):
    clients, orgs = await scope(session, client)
    # Client cloud sessions may use only the current user's explicitly owned
    # independent environment.  In particular, never fall back to a legacy
    # NULL-owner/shared runner or a colleague's node.
    allowed = await personal_runner_ids(session, client)
    personal_clients = set((await session.scalars(select(Client.id).where(
        Client.user_ref == client.user_ref, Client.auth_state == "active"))).all())
    result = await _targets(client, clients, orgs, allowed, personal_clients)
    names = dict((await session.execute(select(RunnerNode.id, RunnerNode.enroll_name).where(
        RunnerNode.id.in_({target["runnerId"] for target in result})
    ))).all()) if result else {}
    return _named_targets(result, names)


def _named_targets(result, names):
    for target in result:
        name = str(names.get(target["runnerId"]) or "").strip()
        if name:
            target.update(runnerName=name, machineLabel=name,
                          name=name + " · " + str(target.get("cliName") or target["agentId"]))
    return result


async def personal_runner_ids(session, client):
    user = await owner(session, client)
    own_clients = select(Client.id).where(
        Client.user_ref == user.id, Client.auth_state == "active")
    result = await session.scalars(select(RunnerNode.id).where(
        or_(RunnerNode.owner_user_id == user.id,
            RunnerNode.client_id.in_(own_clients))))
    return set(result.all())


def _automatic_targets(result, agent_id="", source=None, required_skills=()):
    """Use existing Runner capacity; selection is pinned when prepare commits."""
    eligible = []
    for target in result:
        runner = runner_hub.get(target["runnerId"])
        # The roster is already filtered to the caller's exact personal scope.
        # That scope may contain another active desktop client belonging to the
        # same account, which is a valid mobile/Web destination.
        if (not runner or not cloud_runner_allowed(runner.id, runner.client_id)
                or not runner_hub.has_capacity(runner)
                or (agent_id and target["agentId"] != agent_id)):
            continue
        if source and source.get("goal") and AGENTS[target["agentId"]]["goalMode"] != "native":
            continue
        if required_skills and (not runner.skills_known or not set(required_skills).issubset(runner.skills)):
            continue
        limit = max(1, int(getattr(runner, "adaptive_limit", 0) or runner.max_concurrent))
        load = runner_hub.effective_load(runner)
        eligible.append((load / limit, load, target["id"], target))
    return [item[-1] for item in sorted(eligible, key=lambda item: item[:3])]


async def _targets(client, clients, orgs, allowed_runners=None, personal_clients=None):
    allowed_runners = None if allowed_runners is None else set(allowed_runners)
    personal_client_ids = set(personal_clients or [])
    roster = await asyncio.to_thread(ai_remote.list_assignees_sync, {
        # ``clients`` intentionally excludes the current device. A mobile or Web
        # client must still discover another active desktop client owned by the
        # same account. The checks below still exclude the current device and
        # re-check exact ownership before a handoff is committed.
        "allowedClients": sorted(set(clients) | personal_client_ids), "allowedOrgs": list(orgs),
        "personalRunnerOwner": client.user_ref if allowed_runners is not None else "",
        "personalRunnerIds": list(allowed_runners or []),
        "allowedRunners": list(allowed_runners) if allowed_runners is not None else []})
    result = []
    for candidate in roster.get("agents", []):
        runner = runner_hub.get(candidate["runnerId"])
        agent = AGENTS.get(candidate.get("cli"))
        if (not runner or (allowed_runners is not None and runner.id not in allowed_runners)
                or (allowed_runners is not None and not runner.client_id and
                    str(getattr(runner, "owner_user_id", "")) != str(client.user_ref or ""))
                or (allowed_runners is not None and runner.client_id and
                    runner.client_id != client.id and runner.client_id not in personal_client_ids)
                or not cloud_runner_allowed(runner.id, runner.client_id)
                or not agent or CAPABILITY not in getattr(runner, "caps", [])
                or not runner.work_root or runner.client_id == client.id
                or (allowed_runners is None and not runner_hub.in_scope(runner, set(clients), orgs))):
            continue
        if not runner_hub.supports_capabilities(runner, ["files", "terminal"]):
            continue
        result.append({**candidate, "agentId": agent["id"], "modelMode": agent["modelMode"],
                       "skillsKnown": bool(getattr(runner, "skills_known", False)),
                       "skills": sorted(getattr(runner, "skills", []) or []),
                       "host": candidate.get("host") or runner.host or "",
                       "runnerName": candidate.get("machineLabel") or runner.host or runner.id})
    return result


_TARGET_REASONS = {
    "current_device": ("这是当前电脑，不能作为本次交接的云端执行机", "open_setup"),
    "offline": ("执行机未连接；请检查它到当前 SoduWork 服务的网络和连接地址", "check_connection"),
    "update_required": ("执行机版本尚不支持会话交接，请更新 Runner", "update_runner"),
    "starting": ("执行机正在建立连接或探测可用 Agent，请稍后刷新", "wait"),
    "paused": ("执行机已暂停接单，请管理员恢复接单", "resume_dispatch"),
    "missing_workspace": ("执行机尚未配置工作目录", "configure_workspace"),
    "missing_capabilities": ("执行机的文件或命令执行能力尚未就绪", "configure_capabilities"),
    "missing_agent": ("执行机尚未安装可用于交接的 Agent", "install_agent"),
    "auth_required": ("执行机上的 Agent 尚未登录，请在执行机上完成登录", "sign_in_agent"),
    "agent_unavailable": ("执行机尚无与当前会话匹配且已登录的 Agent", "install_agent"),
    "at_capacity": ("执行机目前已满，请等待现有工作完成后刷新", "wait"),
    "deployment_restricted": ("当前部署未允许使用这台个人执行机，请联系管理员更新执行机白名单", "check_service"),
    "personal_device": ("这是个人客户端节点，自动云端执行需要独立接入的执行机", "open_setup"),
    "service_unavailable": ("执行服务暂时无法接收交接，请检查服务状态后刷新", "check_service"),
    "ready": ("可以接收云端会话", "available"),
}


def _target_reason(runner, *, current_device, ready, agent_id=""):
    if current_device:
        return "current_device"
    if runner is None:
        return "offline"
    if ready:
        return "ready"
    if CAPABILITY not in getattr(runner, "caps", []):
        return "update_required"
    if not runner.ready or not runner.inventory_ready:
        return "starting"
    if runner.dispatch_mode != "accepting":
        return "paused"
    if not runner.work_root:
        return "missing_workspace"
    if not runner_hub.supports_capabilities(runner, ["files", "terminal"]):
        return "missing_capabilities"
    agents = [a for a in runner.agents if isinstance(a, dict) and a.get("key") in AGENTS]
    if not agents:
        return "missing_agent"
    if not any(str(a.get("auth") or "").strip().lower() != "unauthed" for a in agents):
        return "auth_required"
    if agent_id:
        if runner.client_id:
            return "personal_device"
        if not any(a.get("key") == agent_id and
                   str(a.get("auth") or "").strip().lower() != "unauthed" for a in agents):
            return "agent_unavailable"
        if not runner_hub.has_capacity(runner):
            return "at_capacity"
    return "service_unavailable"


async def target_catalog(session, client, agent_id=""):
    """Explain unavailable destinations without broadening dispatch visibility.

    Read the durable directory for offline nodes, but select no credentials,
    paths or workload metadata. A current-device entry explains its exclusion;
    colleagues' personal nodes and unrelated organizations remain invisible.
    Unlike runner_registry.list_nodes this GET never enrolls/updates a node.
    """
    clients, orgs = await scope(session, client)
    allowed = await personal_runner_ids(session, client)
    personal_clients = set((await session.scalars(select(Client.id).where(
        Client.user_ref == client.user_ref, Client.auth_state == "active"))).all())
    if agent_id and agent_id not in AGENTS:
        raise HTTPException(422, "当前服务尚未配置此 Agent 的云端执行支持")
    result = await _targets(client, clients, orgs, allowed, personal_clients)
    automatic = _automatic_targets(result, agent_id)
    if agent_id:
        result = automatic
    # Durable diagnostics are intentionally limited to this account's
    # personal rows; shared/operations nodes remain an admin concern.
    if allowed:
        rows_result = await session.execute(select(
            RunnerNode.id, RunnerNode.client_id, RunnerNode.owner_user_id,
            RunnerNode.host, RunnerNode.enroll_name,
        ).where(RunnerNode.id.in_(allowed)))
        rows = rows_result.all()
    else:
        rows = []
    directory = {row.id: row for row in rows}
    _named_targets(result, {rid: row.enroll_name for rid, row in directory.items()})
    live = {r.id: r for r in runner_hub.online() if r.id in allowed}
    ready_ids = {target["runnerId"] for target in result}
    nodes = []
    for rid in sorted(set(directory) | set(live)):
        row, runner = directory.get(rid), live.get(rid)
        # A re-enrolled live identity can supersede a stale directory row.
        # Never leak that runner through the old owner's offline diagnosis.
        actual = runner_hub.get(rid)
        if actual and (actual.id not in allowed or actual.client_id or
                       str(getattr(actual, "owner_user_id", "")) != str(client.user_ref or "")):
            continue
        if not cloud_runner_allowed(rid, actual.client_id if actual else row.client_id):
            nodes.append({"runnerId": rid,
                          "name": (row.enroll_name if row else "") or
                                  (runner.host if runner else row.host) or rid,
                          "online": runner is not None, "code": "deployment_restricted",
                          "message": _TARGET_REASONS["deployment_restricted"][0],
                          "action": _TARGET_REASONS["deployment_restricted"][1]})
            continue
        current = (runner.client_id if runner else row.client_id) == client.id
        code = _target_reason(runner, current_device=current, ready=rid in ready_ids, agent_id=agent_id)
        message, action = _TARGET_REASONS[code]
        nodes.append({"runnerId": rid,
                      "name": (row.enroll_name if row else "") or
                              (runner.host if runner else row.host) or rid,
                      "online": runner is not None, "code": code,
                      "message": message, "action": action})
    other_nodes = [node for node in nodes if node["code"] != "current_device"]
    state = "ready" if result else "unavailable" if other_nodes else "not_configured"
    summary = {"ready": "已找到可用的云端执行机",
               "unavailable": "已接入的云端执行机暂不可用，请按提示恢复后刷新",
               "not_configured": "尚未接入可用的云端执行机，请管理员在执行网络中接入一台持续在线的机器"}[state]
    return {"ok": True, "targets": result, "handoffCapabilities": {"piFallback": True},
        "selection": {"mode": "auto", "agentId": agent_id, "eligibleCount": len(automatic)},
        "diagnostics": {
        "state": state, "summary": summary, "nodes": nodes,
        "setup": {"screen": "clients", "tab": "runners", "requiresAdmin": False},
    }}


async def destination(session, client, options, source=None):
    roster = await targets(session, client)
    picked = next((x for x in roster if x["id"] == options["assigneeId"]), None)
    if not picked:
        raise HTTPException(409, "目标必须是有权使用、支持会话交接的另一台在线执行机，请刷新列表")
    requested_runner_kind = str(options.get("targetRunnerKind") or "").strip()
    if requested_runner_kind and picked.get("runnerKind") != requested_runner_kind:
        raise HTTPException(409, "目标执行机类型已变化，请刷新工作电脑列表后重试")
    if options.get("agentId") and picked["agentId"] != options["agentId"]:
        raise HTTPException(409, "目标执行机的 Agent 与当前会话不匹配")
    fallback = handoff_agent_policy.validate(source, options, picked["agentId"])
    if fallback and not options.get("targetSnapshot") and _automatic_targets(
            roster, source["adapterId"], source, options.get("requiredSkills", [])):
        raise HTTPException(409, "已有与当前会话相同 Agent 的可用云端环境，请刷新后继续")
    if source and source.get("goal") and AGENTS[picked["agentId"]]["goalMode"] != "native":
        raise HTTPException(409, "所选底座不支持此会话的目标模式")
    runner = runner_hub.get(picked["runnerId"])
    if not runner or not cloud_runner_allowed(runner.id, runner.client_id):
        raise HTTPException(409, "目标执行机未获准承载云端会话，请刷新列表")
    # Re-check durable ownership at the final dispatch boundary.  This closes
    # the race where a node is deleted/reassigned after target discovery.
    user = await owner(session, client)
    own_clients = select(Client.id).where(
        Client.user_ref == user.id, Client.auth_state == "active")
    owned = await session.scalar(select(RunnerNode.id).where(
        RunnerNode.id == runner.id,
        or_(RunnerNode.owner_user_id == user.id,
            RunnerNode.client_id.in_(own_clients))))
    if owned is None:
        raise HTTPException(409, "目标执行机不再属于当前账号，请刷新列表")
    needed = options.get("requiredSkills", [])
    available = set(getattr(runner, "skills", []) or [])
    if needed and (not getattr(runner, "skills_known", False) or not set(needed).issubset(available)):
        raise HTTPException(409, "目标执行机缺少会话使用的技能，不能省略这些技能后继续")
    from . import task_execution_model
    ctx = await ai_exec.load(session, force=True)
    try:
        ctx, _ = await task_execution_model.prepare(session, client, ctx, picked, options["model"])
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if picked["modelMode"] == "managed":
        llm = (ctx.get("localCfg") or ctx.get("cfg") or {}).get("llm") or {}
        if not all(llm.get(key) for key in ("base", "key", "model")):
            raise HTTPException(409, "请先为所选底座配置可用模型")
    return picked


async def committed_destination(session, client, options, source=None):
    """Revalidate an already committed target without excluding its own client.

    ``targets()`` deliberately hides the caller's current desktop so a new
    handoff cannot select itself.  A cross-device continuation is different:
    it must keep the immutable Runner/ref that was already authorized, even
    when the desktop that owns that Runner is now the caller.
    """
    snapshot = dict(options.get("targetSnapshot") or {})
    agent_id = str(options.get("agentId") or snapshot.get("agentId") or "").strip()
    assignee_id = str(options.get("assigneeId") or "").strip()
    parts = assignee_id.split(":", 2)
    runner_id = str(snapshot.get("runnerId") or (parts[1] if len(parts) == 3 else "")).strip()
    if not runner_id or agent_id not in AGENTS:
        raise HTTPException(409, "云端会话的原执行目标不完整，请重新选择执行机")
    runner = runner_hub.get(runner_id)
    if (not runner or not cloud_runner_allowed(runner.id, runner.client_id)
            or not runner.ready or getattr(runner, "dispatch_mode", "") != "accepting"
            or not runner.work_root or not runner_hub.supports_capabilities(runner, ["files", "terminal"])):
        raise HTTPException(409, "原云端执行机当前不可用，请稍后重试或重新选择执行机")
    user = await owner(session, client)
    own_clients = select(Client.id).where(
        Client.user_ref == user.id, Client.auth_state == "active")
    owned = await session.scalar(select(RunnerNode.id).where(
        RunnerNode.id == runner.id,
        or_(RunnerNode.owner_user_id == user.id,
            RunnerNode.client_id.in_(own_clients))))
    if owned is None:
        raise HTTPException(409, "原云端执行机不再属于当前账号")
    installed = next((item for item in runner.agents
                      if isinstance(item, dict) and item.get("key") == agent_id), None)
    if not installed or str(installed.get("auth") or "").strip().lower() == "unauthed":
        raise HTTPException(409, "原执行机上的 Agent 尚未登录，请先完成登录")
    required = options.get("requiredSkills", [])
    if required and (not runner.skills_known or not set(required).issubset(set(runner.skills or []))):
        raise HTTPException(409, "原执行机缺少会话所需技能")
    spec = AGENTS[agent_id]
    return {
        "id": "runner:" + runner.id + ":" + agent_id,
        "agentId": agent_id, "cli": agent_id,
        "modelMode": spec.get("modelMode", "managed"),
        "clientId": str(runner.client_id or ""), "orgId": str(runner.org_id or ""),
        "runnerId": runner.id, "host": runner.host,
        "runnerName": snapshot.get("runnerName") or snapshot.get("name") or runner.host or runner.id,
        "runnerKind": snapshot.get("runnerKind") or ("work-computer" if runner.client_id else "cloud"),
        "machineLabel": snapshot.get("runnerName") or snapshot.get("name") or runner.host or runner.id,
    }


def clean_options(raw):
    if not isinstance(raw, dict) or set(raw) - {
        "sha256", "assigneeId", "agentId", "model", "instruction", "requiredSkills", "personalPlugins", "agentFallback", "targetRunnerId", "targetRunnerKind"
    }:
        raise HTTPException(400, "交接选项不正确；不能指定执行机上的目录或额外执行配置")
    out = {}
    for key, limit in (("sha256", 64), ("assigneeId", 180), ("model", 200), ("instruction", 200000)):
        value = raw.get(key, "")
        if not isinstance(value, str) or len(value) > limit or "\0" in value:
            raise HTTPException(400, "交接字段不正确：" + key)
        out[key] = value.strip()
    if not re.fullmatch(r"[0-9a-f]{64}", out["sha256"]) or (out["assigneeId"] and not out["assigneeId"].startswith("runner:")):
        raise HTTPException(400, "请提供完整文件摘要和有效的执行机标识")
    # Keep old explicit requests byte-for-byte compatible for durable retry hashes.
    if "agentId" in raw:
        if not isinstance(raw["agentId"], str) or raw["agentId"] not in AGENTS:
            raise HTTPException(422, "当前服务尚未配置此 Agent 的云端执行支持")
        out["agentId"] = raw["agentId"]
    if "targetRunnerId" in raw:
        if not isinstance(raw["targetRunnerId"], str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,80}", raw["targetRunnerId"]):
            raise HTTPException(400, "目标执行机标识不正确")
        out["targetRunnerId"] = raw["targetRunnerId"]
    if "targetRunnerKind" in raw:
        runner_kind = raw["targetRunnerKind"]
        if not isinstance(runner_kind, str) or runner_kind not in RUNNER_KINDS:
            raise HTTPException(400, "目标执行机类型不正确")
        out["targetRunnerKind"] = runner_kind
    if "agentFallback" in raw:
        out["agentFallback"] = handoff_agent_policy.clean_fallback(raw["agentFallback"])
    if not out["instruction"]:
        raise HTTPException(400, "请说明转到云端后继续做什么")
    for key in ("requiredSkills", "personalPlugins"):
        value = raw.get(key, [])
        if not isinstance(value, list) or len(value) > 100 or any(
            not isinstance(x, str) or not x or len(x) > 160 for x in value
        ):
            raise HTTPException(400, "交接能力列表不正确")
        out[key] = sorted(set(value))
    if out["personalPlugins"]:
        raise HTTPException(409, "本机个人插件尚不能迁移，请在当前电脑完成，或改用云端已配置的能力")
    if any(x.lower() in {"computer-use", "computer_use", "desktop", "local-desktop"}
           for x in out["requiredSkills"]):
        raise HTTPException(409, "正在使用本机电脑操作能力的会话不能转到云端")
    return out


async def get(session, client, transfer_id):
    await owner(session, client)
    row = await session.get(Handoff, identity(client.id, transfer_id), populate_existing=True)
    if not row:
        raise HTTPException(404, "尚未准备此交接")
    if row.owner_user_id != client.user_ref:
        raise HTTPException(403, "设备归属已变更，不能访问原账号的交接")
    return row


def public(row):
    receipt = row.receipt or {}
    snapshot = (row.options or {}).get("targetSnapshot") or {}
    target = {key: str(snapshot.get(key) or "") for key in
              ("name", "runnerName", "agentId", "modelMode", "runnerId", "host", "runnerKind")}
    target.update(id=(row.options or {}).get("assigneeId", ""),
                  model=(row.options or {}).get("model", ""))
    active = receipt.get("activeExecutionSelection") or {}
    if active:
        agent = AGENTS.get(active["agentId"], {})
        target.update(agentId=active["agentId"], model=active["modelName"],
                      id="runner:" + target["runnerId"] + ":" + active["agentId"],
                      modelMode=agent.get("modelMode", target["modelMode"]),
                      name=(target["runnerName"] or target["host"] or target["runnerId"]) +
                      " · " + agent.get("displayName", active["agentId"]))

    return {"ok": True, "transferId": row.transfer_id, "taskId": row.task_id,
            "accepted": bool(row.submitted_at),
            "acceptedAt": row.submitted_at.isoformat() if row.submitted_at else "",
            "phase": row.phase, "status": receipt.get("state") or row.phase,
            "sha256": row.sha256, "ref": receipt.get("ref") or receipt.get("issueId") or "",
            "target": target,
            "deliveryMode": (row.source or {}).get("deliveryMode", ""),
            "codeDelivery": (row.source or {}).get("codeDelivery"),
            "source": {k: (row.source or {}).get(k, "") for k in ("sessionId", "adapterId", "title", "entryKind")},
            **({"agentFallback": row.options["agentFallback"]} if (row.options or {}).get("agentFallback") else {}),
            "error": row.error or "", "canAbort": row.phase == "prepared" and not row.submitted_at}


async def refresh(session, row):
    if row.phase != "committing":
        return row
    # This uses the existing durable execution/event index and never starts work.
    event = await ai_exec.last_dispatch_event(session, row.task_id)
    if not event:
        from ..models import TaskEvent
        from . import dispatch_reconcile, task_events, execution_sessions
        latest = await session.scalar(select(TaskEvent).where(
            TaskEvent.task_id == row.task_id, TaskEvent.kind.in_(ai_exec.KINDS_DISPATCH_STATE))
            .order_by(TaskEvent.at.desc(), TaskEvent.id.desc()).limit(1))
        if latest and (latest.detail or {}).get("attemptId") == dispatch_id(row):
            detail = dict(latest.detail or {})
            if latest.kind == ai_exec.EV_DISPATCH_FAILED:
                row.phase, row.error = "prepared", str(detail.get("error") or "交接未启动")
                row.receipt = {}
                await session.commit()
                return row
            if latest.kind in {ai_exec.EV_DISPATCH_UNCERTAIN, ai_exec.EV_DISPATCH_STARTED}:
                candidate = dispatch_reconcile.Candidate(
                    row.task_id, dispatch_id(row), dispatch_identity.execution_ref(dispatch_id(row)),
                    row.options["assigneeId"].split(":")[1],
                    detail.get("runnerBootId") or (row.receipt or {}).get("runnerBootId", ""),
                    detail.get("host", ""), latest.at, detail)
                probed = await dispatch_reconcile.probe(candidate)
                if latest.kind == ai_exec.EV_DISPATCH_UNCERTAIN:
                    state, _ = await dispatch_reconcile.apply_probe(session, candidate, probed)
                    if state == "released":
                        row.phase, row.error = "prepared", "执行机已确认未启动，可重试或撤销交接"
                        row.receipt = {}
                    await session.commit()
                elif probed.get("state") == "confirmed":
                    # The Hub may have died between RPC acceptance and writing
                    # its receipt. A positive exact-ref probe repairs that gap.
                    task = await session.get(Task, row.task_id)
                    repaired = {**detail, "attemptId": dispatch_id(row), "ref": candidate.expected_ref,
                        "issueId": candidate.expected_ref, "runnerId": candidate.runner_id,
                        "provider": "runner", "assigneeId": row.options["assigneeId"],
                        "assigneeCli": row.options["assigneeId"].rsplit(":", 1)[-1],
                        "model": row.options["model"], "healedFrom": "handoff-existence-probe"}
                    task_events.record(session, task.id, ai_exec.EV_DISPATCHED, repaired, actor="SoduWork")
                    await execution_sessions.record_dispatch(session, task, repaired)
                    await session.commit()
                # A negative STARTED probe is not safe to abort: an original
                # request may still be uploading its files before sending RPC.
                event = await ai_exec.last_dispatch_event(session, row.task_id)
    if event and (event.detail or {}).get("attemptId") == dispatch_id(row):
        detail = event.detail or {}
        row.phase = "committed"
        row.receipt = {"ref": detail.get("ref") or detail.get("issueId") or
                       dispatch_identity.execution_ref(dispatch_id(row)), "state": "running"}
        row.error = ""
        await session.commit()
    return row


async def prepare(session, client, transfer_id, data, raw_options):
    user = await owner(session, client)
    row_id = identity(client.id, transfer_id)
    options = clean_options(raw_options)
    digest = hashlib.sha256(json.dumps(options, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()
    old = await session.get(Handoff, row_id)
    if old:
        if old.owner_user_id != user.id:
            raise HTTPException(403, "设备归属已变更")
        if old.phase == "aborted":
            return public(old)
        if old.request_hash != digest:
            raise HTTPException(409, "此交接编号已绑定另一份文件或目标，请使用原请求重试")
        if hashlib.sha256(data).hexdigest() != old.sha256:
            raise HTTPException(409, "重试上传的工作包与原文件不一致")
        return public(await refresh(session, old))
    try:
        manifest = await asyncio.to_thread(portable_workspace.validate, data, options["sha256"])
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    source = manifest["source"]
    agent_id = handoff_agent_policy.requested_agent(source, options)
    if not options["assigneeId"]:
        available = _automatic_targets(await targets(session, client), agent_id, source, options["requiredSkills"])
        if not available:
            raise HTTPException(409, "暂时没有匹配当前 Agent 且可接单的云端环境，请在「我的 → 云端环境」检查连接、底座和负载")
        # The request hash above describes the caller's intent. Persist the chosen
        # destination separately in options so every retry/commit uses one host.
        options["assigneeId"] = available[0]["id"]
    picked = await destination(session, client, options, source)
    options["targetSnapshot"] = {key: str(picked.get(key) or "") for key in
                                 ("name", "runnerName", "agentId", "modelMode", "runnerId", "host")}
    tid = str(uuid.uuid5(_NS, row_id + ":task"))
    key = "handoffs/" + row_id + "/" + uuid.uuid4().hex + ".zip"
    from . import conversation_content
    if conversation_content.supported(picked["runnerId"]):
        options["sourceGoal"] = source["goal"]
    options = await conversation_content.save_options(picked["runnerId"], user.id, "handoff:" + row_id, options, session=session)
    if conversation_content.supported(picked["runnerId"]):
        options["archiveRef"] = await conversation_content.put(picked["runnerId"], user.id, "archive:" + row_id, data, session=session)
        key, backend = "", ""
    else:
        backend = await asyncio.to_thread(storage.put, key, data, "application/zip")
    source_summary = {k: source[k] for k in ("sessionId", "adapterId", "modelName", "title", "goal")}
    if options.get("contentRef"):
        source_summary["goal"] = ""
    row = Handoff(id=row_id, owner_client_id=client.id, owner_user_id=user.id,
        transfer_id=transfer_id, task_id=tid, sha256=options["sha256"], request_hash=digest,
        storage_key=key, backend=backend, options=options, source=source_summary)
    task = Task(id=tid, owner_client_id=client.id, owner_user_id=user.id,
        title=(source["title"] or "云端继续会话")[:200],
        note=options.get("instruction", ""), kind="task", status="todo", origin="conversation-handoff",
        created_by=user.id, created_by_name=user.display_name or user.username,
        work_routing={"selectedStrategy": "direct", "requiredSkills": options["requiredSkills"],
                      "conversationHandoff": {
            "transferId": transfer_id, "sourceSessionId": source["sessionId"],
            "sha256": options["sha256"], "attachmentName": ARCHIVE_NAME}})
    attachment = Attachment(id=str(uuid.uuid4()), task_id=tid, filename=ARCHIVE_NAME,
        content_type="application/zip", size=len(data), storage_key=key, backend=backend,
        uploaded_by=client.id, role="handoff", evidence_meta={"transferId": transfer_id,
            **({"contentRef": options["archiveRef"], "contentRecord": "archive:" + row_id,
                "contentOwner": user.id} if options.get("archiveRef") else {})})
    session.add_all([row, task, attachment])
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        await session.refresh(client)
        if key:
            await asyncio.to_thread(storage.delete, key, backend)
        # Concurrent abort/prepare wins permanently; never overwrite its fence.
        old = await get(session, client, transfer_id)
        if old.phase != "aborted" and old.request_hash != digest:
            raise HTTPException(409, "交接编号已绑定另一份请求")
        return public(old)
    return public(row)


async def abort(session, client, transfer_id):
    user = await owner(session, client)
    row_id = identity(client.id, transfer_id)
    row = await session.get(Handoff, row_id)
    if not row:
        row = Handoff(id=row_id, owner_client_id=client.id, owner_user_id=user.id,
            transfer_id=transfer_id, task_id=str(uuid.uuid5(_NS, row_id + ":task")), phase="aborted")
        session.add(row)
        try:
            await session.commit()
            return public(row)
        except IntegrityError:
            await session.rollback()
            await session.refresh(client)
    row = await get(session, client, transfer_id)
    if row.phase == "aborted":
        return public(row)
    changed = await session.execute(update(Handoff).where(
        Handoff.id == row.id, Handoff.phase == "prepared",
        Handoff.submitted_at.is_(None)).values(phase="aborted"))
    if changed.rowcount:
        from .cloud_sync_notifications import mark
        mark(session, row.task_id, owner=row.owner_user_id)
    await session.commit()
    if not changed.rowcount:
        raise HTTPException(409, "云端已开始接管或尚在核对回执，不能恢复本地执行")
    return public(await get(session, client, transfer_id))


async def dispatch_record(session, task_id):
    return await session.scalar(select(Handoff).where(Handoff.task_id == task_id))


async def dispatch_body(session, client, task, body):
    row = await dispatch_record(session, task.id)
    if row is None:
        # A copied marker cannot authorize any remote paths or snapshot bytes.
        if ((task.work_routing or {}).get("conversationHandoff")
                or (task.work_routing or {}).get("cloudConversation")):
            raise HTTPException(409, "交接记录无效")
        return None, body
    if row.owner_client_id != client.id or row.owner_user_id != client.user_ref or row.phase != "committing":
        raise HTTPException(409, "请通过会话交接确认开始，不能从任务页重新派发此会话")
    from . import conversation_content
    options = await conversation_content.load_options(row.owner_user_id, "handoff:" + row.id, row.options, session=session)
    return row, {"assigneeId": options["assigneeId"], "assigneeType": "agent",
                 "model": options["model"], "brief": options["instruction"],
                 "executionContext": {"strategy": "direct"}}


async def dispatch_scope(session, client, ctx, row):
    picked = await destination(session, client, row.options, row.source)
    return scope_for_destination(ctx, client, picked)


def scope_for_destination(ctx, client, picked):
    """Pin execution to one destination already authorized by the directory."""
    out = dict(ctx)
    out.pop("_clientRunnerOnly", None)
    out.pop("_dispatchClientId", None)
    for key in ("cfg", "localCfg"):
        if isinstance(out.get(key), dict):
            out[key] = dict(out[key])
            out[key].pop("git", None)
    out.update(_runnerAllowedClients=[picked["clientId"]] if picked["clientId"] else [],
               _runnerAllowedOrgs=[picked["orgId"]] if picked["orgId"] else [],
               _runnerAllowedRunners=[picked["runnerId"]], _cloudExecution=True,
               _personalRunnerOwner=client.user_ref,
               _personalRunnerIds=[picked["runnerId"]])
    return out


async def dispatch_inputs(session, row, extra):
    if (row.source or {}).get("entryKind") == "cloud":
        from . import cloud_conversations
        return await cloud_conversations.dispatch_inputs(session, row, extra)
    from . import conversation_content
    options = await conversation_content.load_options(row.owner_user_id, "handoff:" + row.id, row.options, session=session)
    data = (await conversation_content.get(options["archiveRef"], row.owner_user_id, "archive:" + row.id, session=session)
        if options.get("archiveRef") else await asyncio.to_thread(storage.get, row.storage_key, row.backend))
    await asyncio.to_thread(portable_workspace.validate, data, row.sha256)
    # Do not inherit incidental client-selected desktop skills, local MCP files,
    # Git credentials/paths, plugins or source-session SDK cache.
    selected = {str(x.get("name") or ""): x for x in extra.get("skills", [])}
    required = row.options.get("requiredSkills", [])
    if any(name not in selected for name in required):
        raise ValueError("交接所需技能已不可用，请恢复配置后重试")
    extra = {"dispatchId": dispatch_id(row), "brief": options["instruction"],
        "conversationMode": "adaptive", "conversationUserText": options["instruction"],
        "agentExecution": extra.get("agentExecution", {}),
        "skills": [selected[name] for name in required], "requiredSkills": required,
        "requiredAgentCapabilities": ["files", "terminal"],
        "workspaceHandoff": {"transferId": row.id, "sha256": row.sha256,
                             "filename": ARCHIVE_NAME, "schema": portable_workspace.SCHEMA}}
    return [(ARCHIVE_NAME, data, "application/zip")], extra


async def commit(session, client, transfer_id, sha256):
    row = await get(session, client, transfer_id)
    if row.sha256 != sha256:
        raise HTTPException(409, "交接文件摘要不一致")
    row = await refresh(session, row)
    if row.phase in {"committed", "aborted"}:
        return public(row)
    if row.phase == "committing":
        from ..models import TaskEvent
        latest = await session.scalar(select(TaskEvent).where(
            TaskEvent.task_id == row.task_id,
            TaskEvent.kind.in_(ai_exec.KINDS_DISPATCH_STATE),
        ).order_by(TaskEvent.at.desc(), TaskEvent.id.desc()).limit(1))
        # A stale request timeout is not evidence that Runner did not accept it.
        # Recovery may release this fence only after an exact admission probe.
        if latest and latest.kind in {ai_exec.EV_DISPATCH_STARTED, ai_exec.EV_DISPATCH_UNCERTAIN}:
            return public(row)
    # Configuration/readiness failure is unambiguously before any dispatch.
    picked = await destination(session, client, row.options, row.source)
    now = datetime.now(timezone.utc)
    conditions = [Handoff.phase == "prepared"]
    if row.phase == "committing":
        conditions = [(Handoff.phase == "committing") &
                      (Handoff.commit_started_at < now - timedelta(minutes=2))]
    from sqlalchemy import or_
    changed = await session.execute(update(Handoff).where(
        Handoff.id == row.id, or_(*conditions)).values(phase="committing", commit_started_at=now, error="",
        submitted_at=row.submitted_at or now,
        receipt={"runnerBootId": picked.get("runnerBootId", ""), "runnerId": picked["runnerId"]}))
    if changed.rowcount:
        from .cloud_sync_notifications import mark
        mark(session, row.task_id, owner=row.owner_user_id)
    await session.commit()
    if not changed.rowcount:
        return public(await get(session, client, transfer_id))
    row = await get(session, client, transfer_id)
    from . import task_dispatch
    try:
        receipt = await task_dispatch.dispatch(row.task_id, {}, client, session)
    except HTTPException as exc:
        await session.rollback()
        await session.refresh(client)
        row = await get(session, client, transfer_id)
        # The dispatch service records failed operations only when no Runner
        # accepted them; transport uncertainty is a pending receipt, not a failure.
        from . import dispatch_attempts
        active = await dispatch_attempts.existing(session, row.task_id)
        if active is None:
            row.phase = "prepared"
            row.receipt = {}
        row.error = dispatch_attempts.public_error(exc.detail)
        await session.commit()
        return public(row)
    # Unexpected cancellation/error deliberately leaves the committing fence.
    row = await get(session, client, transfer_id)
    row.receipt = {**(row.receipt or {}),
                   "ref": receipt.get("ref") or receipt.get("issueId") or receipt.get("expectedRef") or "",
                   "state": receipt.get("state") or "running"}
    row.phase = "committing" if receipt.get("pending") or receipt.get("uncertain") else "committed"
    await session.commit()
    return public(row)
