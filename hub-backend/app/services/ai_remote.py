"""Dispatch execution to an available desktop or service Runner."""
from __future__ import annotations

import base64
import hashlib
import logging
import threading
import uuid
from collections import OrderedDict

from . import (agent_naming, dispatch_identity, execution_capabilities,
               runner_hub, runner_skills)
from .agent_execution_options import GATEWAY_MODEL_KINDS, supports_soduwork_model_kind
from ..agent_catalog import AGENTS

log = logging.getLogger("uvicorn.error")

PREFIX = "runner:"
_DISPATCH_TIMEOUT = 120.0        # Allow extra time for dispatch to create a session and start its process.
_INPUT_CHUNK = 512 * 1024         # The encoded chunk remains below the WebSocket frame-size limit.
_OUTPUT_CHUNK = 512 * 1024
_OUTPUT_MAX = 512 * 1024 * 1024

_ACTIVE_AGENT_KEYS = frozenset(AGENTS)


def _active_agent_key(value: str) -> str:
    """Normalize a runner's portable CLI key for catalog admission."""
    key = str(value or "").strip().lower()
    return key.split(":", 1)[-1]


def _active_agent(value: str) -> bool:
    key = _active_agent_key(value)
    return key in _ACTIVE_AGENT_KEYS or key.startswith("custom-")

def _agent_usable(agent: dict) -> bool:
    """Old Runners omit auth; new Runners must not advertise logged-out CLIs."""
    return str((agent or {}).get("auth") or "").strip().lower() != "unauthed"



# Cache the Runner for each execution ref at dispatch time.
# Frequent status polling should not broadcast a lookup to every Runner.
# Direct routing avoids network round trips proportional to the number of machines.
# Treat this mapping only as a shortcut.
# If absent or offline, _runner_of_ref performs discovery rather than trusting stale data.
# Bounded as an LRU: writes accumulate for the process lifetime otherwise, and only
# offline-miss pops single entries. Dropping a shortcut is always safe because
# _runner_of_ref rediscovers through the full Runner list on a miss.
_WHERE_MAX = 10_000
_WHERE: OrderedDict[str, str] = OrderedDict()
_WHERE_LOCK = threading.Lock()


def remember(ref: str, runner_id: str) -> None:
    """Remember an execution's Runner, both after dispatch and when restoring runnerId from task
    history. Centralize mapping writes here.
    """
    ref, runner_id = str(ref or ""), str(runner_id or "")
    if ref and runner_id:
        with _WHERE_LOCK:
            _WHERE[ref] = runner_id
            _WHERE.move_to_end(ref)
            while len(_WHERE) > _WHERE_MAX:
                _WHERE.popitem(last=False)


def _cached_runner(ref: str):
    """Read only the in-memory mapping without RPC; safe to call from the event loop."""
    ref = str(ref or "")
    with _WHERE_LOCK:
        rid = _WHERE.get(ref)
        if not rid:
            return None
        _WHERE.move_to_end(ref)
    r = runner_hub.get(rid)
    if r is not None:
        return r
    # runner_hub.get deliberately stays outside the cache lock. A concurrent
    # discovery may replace this stale route while the lookup is in progress;
    # only remove the exact mapping that was observed above.
    with _WHERE_LOCK:
        if _WHERE.get(ref) == rid:
            _WHERE.pop(ref, None)
    return None


# This provider requires no additional configuration.
def load(cfg: dict | None = None) -> dict:
    return dict(cfg or {})


def enabled(cfg: dict | None = None) -> bool:
    """Available when a Runner is online."""
    return bool(runner_hub.dispatchable())


def configured(cfg: dict | None = None) -> bool:
    return enabled(cfg)


# Dispatch recipients.
def _parse(aid: str) -> tuple[str, str]:
    """`runner:<runnerId>:<cli>` → (runnerId, cli)"""
    body = str(aid or "")[len(PREFIX):] if str(aid or "").startswith(PREFIX) else str(aid or "")
    rid, _, cli = body.partition(":")
    return rid, (cli or "")


def list_assignees_sync(cfg: dict) -> dict:
    """Expose installed CLIs on online Runners as agents. Prefer configured aliases and use
    unique_machine_labels to disambiguate multiple machines owned by one user.
    """
    from . import execution_aliases
    aliases = cfg.get("names") or {}
    allowed = cfg.get("allowedClients")
    allowed = set(allowed) if allowed is not None else None
    allowed_orgs = cfg.get("allowedOrgs")
    allowed_orgs = set(allowed_orgs) if allowed_orgs is not None else None
    allowed_runners = cfg.get("allowedRunners")
    allowed_runners = set(allowed_runners) if allowed_runners is not None else None

    nodes = [r for r in runner_hub.dispatchable()
             if (personal_cloud_authorized(cfg, r) or runner_hub.in_scope(r, allowed, allowed_orgs))
             and (allowed_runners is None or r.id in allowed_runners)]
    # Compute labels for the complete machine set so collisions can be resolved.
    labels = agent_naming.unique_machine_labels([{
        "key": agent_naming.machine_key(host=r.host, runner_id=r.id),
        "alias": execution_aliases.machine_name(
            aliases, agent_naming.machine_key(host=r.host, runner_id=r.id)),
        "host": r.host, "osName": getattr(r, "os", ""), "runnerId": r.id,
        "person": getattr(r, "owner_name", ""),
    } for r in nodes])

    agents = []
    for r in nodes:
        mkey = agent_naming.machine_key(host=r.host, runner_id=r.id)
        label = labels.get(mkey) or r.host or r.id[:12]
        runner_kind = "work-computer" if runner_hub.is_client_runtime(r) else "cloud"
        for a in (r.agents or []):
            key = a.get("key") or ""
            if not key or not _active_agent(key) or not _agent_usable(a):
                continue
            agents.append({
                "id": "%s%s:%s" % (PREFIX, r.id, key),
                "name": execution_aliases.seat_name(
                    aliases, machine_key=mkey, cli_key=agent_naming.cli_key(key),
                    cli_name=a.get("name") or key, machine_label=label),
                "type": "agent", "cli": key, "cliName": a.get("name") or key,
                "cliVersion": a.get("version") or "", "runnerVersion": r.version or "",
                # Runner busy is machine-wide load, not this CLI seat state.
                "model": "", "avatar": "", "online": True, "busy": False,
                "runnerBusy": max(0, int(getattr(r, "busy", 0) or 0)),
                "local": False, "remote": True,
                "runnerId": r.id, "host": r.host, "clientId": r.client_id,
                "runnerKind": runner_kind,
                "isWorkComputer": runner_kind == "work-computer",
                "runnerBootId": str(getattr(r, "boot_id", "") or ""),
                "orgId": r.org_id,
                "capabilities": execution_capabilities.clean_report(r.capabilities),
                "machineKey": mkey, "machineLabel": label,
                # As with ai_local, only gateway-backed runtimes support model overrides.
                "modelPick": supports_soduwork_model_kind("local:" + key),
                "note": "在 %s 上跑，产出落那台机器的工作目录" % (label or "远程执行机"),
            })
    return {"agents": agents, "squads": []}


def personal_cloud_authorized(cfg, runner):
    """A server-derived exact owner + runner grant; not inferred from orgs."""
    owner_id = str(cfg.get("personalRunnerOwner") or "")
    return bool(owner_id and owner_id == str(getattr(runner, "owner_user_id", "") or "")
                and runner.id in set(cfg.get("personalRunnerIds") or []))


def resolve_assignee_sync(cfg: dict, aid: str, atype: str = "") -> dict | None:
    rid, cli = _parse(aid)
    r = runner_hub.get(rid)
    if r is None:
        log.warning("派活找不到执行机 %s（在线的：%s）", rid,
                    ",".join(x.id for x in runner_hub.online()) or "一台都没有")
        return None
    if not runner_hub.can_dispatch(r):
        log.warning("执行节点 %s 当前不接新任务（%s）", rid, getattr(r, "dispatch_mode", ""))
        return None
    if cli and (not _active_agent(cli) or not any(
            a.get("key") == cli and _agent_usable(a)
            for a in (r.agents or []))):
        log.warning("执行机 %s 上没有 %s（它有：%s）", rid, cli,
                    ",".join(str(a.get("key")) for a in (r.agents or [])))
        return None
    for a in list_assignees_sync(cfg)["agents"]:
        if a["id"] == aid:
            return a
    return None


# Dispatch, status, and outputs.
def _task_payload(t) -> dict:
    """Serialize only task fields required by the Runner; do not send ORM objects or database
    dependencies.
    """
    g = lambda k, d="": getattr(t, k, d) or d           # noqa: E731
    return {"id": g("id"), "title": g("title"), "note": g("note"), "result": g("result"),
            "status": g("status"), "priority": g("priority"), "source": g("source"),
            "createdByName": g("created_by_name"), "acceptanceCriteria": g("acceptance_criteria", [])}


def _file_parts(item) -> tuple[str, bytes | None, str]:
    """Accept SoduWork's attachment tuple shape: name, bytes, and content type."""
    if isinstance(item, (tuple, list)):
        name = str(item[0] if item else "")
        data = item[1] if len(item) > 1 else None
        ctype = str(item[2] if len(item) > 2 else "application/octet-stream")
    elif isinstance(item, dict):
        name = str(item.get("filename") or item.get("name") or "")
        data = item.get("data")
        ctype = str(item.get("contentType") or "application/octet-stream")
    else:
        return "", None, "application/octet-stream"
    if isinstance(data, str):
        data = data.encode("utf-8")
    return name, (bytes(data) if isinstance(data, (bytes, bytearray)) else None), ctype


def _upload_inputs(r, files: list | None) -> tuple[dict, str]:
    """Upload input attachments in chunks; return the job.dispatch manifest and any error."""
    valid = []
    for item in (files or [])[:20]:
        name, data, ctype = _file_parts(item)
        if data is not None:
            valid.append((name or "附件", data, ctype))
    if not valid:
        return {"transfer": "", "items": []}, ""
    transfer = uuid.uuid4().hex
    items = []
    for idx, (name, data, ctype) in enumerate(valid):
        digest = hashlib.sha256(data).hexdigest()
        # Send one frame even for an empty file so the Runner creates it.
        offsets = range(0, len(data), _INPUT_CHUNK) if data else (0,)
        for offset in offsets:
            chunk = data[offset:offset + _INPUT_CHUNK]
            res = runner_hub.call_sync(r, "input.chunk", {
                "transfer": transfer, "index": idx, "offset": offset,
                "b64": base64.b64encode(chunk).decode("ascii"),
            }, timeout=60)
            if not res.get("ok"):
                runner_hub.call_sync(r, "input.drop", {"transfer": transfer}, timeout=15)
                return {}, res.get("error") or "输入附件没能送到执行机"
        items.append({"index": idx, "filename": name, "contentType": ctype,
                      "size": len(data), "sha256": digest})
    return {"transfer": transfer, "items": items}, ""


def _ctx_for_runner(ctx: dict | None, r) -> dict:
    """Convert server directory paths into a workspace plan executable on the Runner."""
    out = dict(ctx or {})
    repo = dict(out.get("repo") or {})
    own_root = str(getattr(r, "work_root", "") or out.get("workRoot") or "").strip()
    old_path = str(repo.get("path") or out.get("workDir") or "").strip()
    out["workspace"] = {
        "workRoot": own_root,
        # Preserve legacy paths when the Runner reports no root, supporting same-host development.
        "devicePath": "" if own_root else old_path,
        "repo": repo,
    }
    if own_root:
        out["workDir"] = ""
        if repo:
            repo["path"] = ""
            out["repo"] = repo
    # Hub paths never make sense on another machine. Bundled skills arrive through an
    # integrity-checked immutable packet; ordinary skills are resolved by name on the Runner.
    out["skills"] = [{k: v for k, v in item.items() if k not in ("path", "root")}
                     for item in (out.get("skills") or []) if isinstance(item, dict)]
    return out


def _skill_preflight(r, items: list[dict] | None) -> dict:
    """Verify non-portable Skills exist on the selected Runner without copying them."""
    local = sorted({str(item.get("name") or "") for item in (items or [])
                    if isinstance(item, dict) and item.get("name") and not item.get("bundled")})
    if not local:
        return {"ok": True, "required": []}
    if not bool(getattr(r, "skills_known", False)):
        return {"ok": False, "required": local, "missing": local,
                "error": "执行机版本过旧，无法确认 Skill 是否可用；请升级 Runner 后重试"}
    available = set(getattr(r, "skills", []) or [])
    missing = [name for name in local if name not in available]
    if missing:
        return {"ok": False, "required": local, "missing": missing,
                "error": "执行机 %s 缺少 Skill：%s。请在目标机器安装同名 Skill，或导入 SoduWork 能力库固化版本" %
                         (r.host or r.id, "、".join(missing))}
    return {"ok": True, "required": local, "missing": []}


def _drop_packet(r, packet: dict) -> None:
    transfer = str((packet or {}).get("transfer") or "")
    if transfer:
        try:
            runner_hub.call_sync(r, "input.drop", {"transfer": transfer}, timeout=15)
        except Exception:  # noqa: BLE001 - best-effort cleanup after a failed dispatch
            pass


def dispatch_sync(cfg: dict, t, files: list | None = None,
                  assignee: dict | None = None, ctx: dict | None = None) -> dict:
    """Dispatch to the selected Runner and return the same result shape as ai_local, including
    issueId as the execution ref.
    """
    aid = (assignee or {}).get("id") or ""
    rid, cli = _parse(aid)
    r = runner_hub.get(rid)
    dispatch_id = dispatch_identity.clean_dispatch_id((ctx or {}).get("dispatchId"))
    expected_ref = dispatch_identity.execution_ref(dispatch_id)
    if r is None:
        return {"ok": False, "error": "那台执行机不在线了（%s）" % (rid or "没指定")}
    if not runner_hub.can_dispatch(r):
        return {"ok": False, "error": "本机 Runner 当前不接新需求，请恢复接单后重试"}
    allowed = cfg.get("allowedClients")
    allowed_orgs = cfg.get("allowedOrgs")
    allowed_runners = cfg.get("allowedRunners")
    if allowed_runners is not None and r.id not in set(allowed_runners):
        return {"ok": False, "error": "所选 Agent 不是当前客户端的内置 Runner，已阻止安排执行"}
    if not personal_cloud_authorized(cfg, r) and not runner_hub.in_scope(
            r, set(allowed) if allowed is not None else None,
            set(allowed_orgs) if allowed_orgs is not None else None):
        return {"ok": False, "error": "所选 Agent 不属于当前设备，已阻止安排执行"}
    installed = next((a for a in (r.agents or [])
                      if str(a.get("key") or "") == cli), None)
    if not cli or not _active_agent(cli) or installed is None:
        return {"ok": False, "error": "本机没有安装或尚未探测到所选 Agent"}
    if not _agent_usable(installed):
        return {"ok": False, "error": "本机 Codex 已安装但尚未登录，请先在本机完成登录"}
    required = execution_capabilities.required_for(t, ctx)
    verdict = runner_hub.capability_verdict(r, required)
    if not verdict["ok"]:
        return {"ok": False, "error": execution_capabilities.error_message(
            verdict, r.host or r.id), "capabilityPreflight": verdict}
    skill_verdict = _skill_preflight(r, list((ctx or {}).get("skills") or []))
    if not skill_verdict["ok"]:
        return {"ok": False, "error": skill_verdict["error"],
                "skillPreflight": skill_verdict}
    reservation_key = expected_ref or dispatch_id or uuid.uuid4().hex
    reserved, reservation = runner_hub.reserve_dispatch(r, reservation_key)
    if not reserved:
        if reservation == "duplicate":
            return {
                "ok": False, "uncertain": True, "code": "DISPATCH_IN_PROGRESS",
                "error": "同一安排执行正在发送到执行机，等待会话登记即可",
                "issueId": expected_ref, "expectedRef": expected_ref,
                "dispatchId": dispatch_id, "provider": "runner",
                "runnerId": r.id, "runnerClientId": r.client_id,
                "runnerBootId": str(getattr(r, "boot_id", "") or ""),
            }
        return {
            "ok": False, "code": "RUNNER_QUEUE_FULL", "retryable": True,
            "error": "执行机 %s 的后台任务队列已满（%d/%d）" % (
                r.host or r.id,
                max(0, int(getattr(r, "task_outstanding", 0) or 0)),
                max(1, int(getattr(r, "task_queue_capacity", 0) or 100))),
            "capacity": {
                "taskOutstanding": max(0, int(getattr(r, "task_outstanding", 0) or 0)),
                "taskQueueCapacity": max(1, int(
                    getattr(r, "task_queue_capacity", 0) or 100)),
            },
        }
    try:
        input_packet, input_error = _upload_inputs(r, files)
        if input_error:
            return {"ok": False, "error": input_error}
        try:
            bundle = runner_skills.build(list((ctx or {}).get("skills") or []))
        except ValueError as exc:
            _drop_packet(r, input_packet)
            return {"ok": False, "error": str(exc)}
        skill_packet, skill_error = _upload_inputs(
            r, [("plugin-skills.zip", bundle, "application/zip")] if bundle else [])
        if skill_error:
            _drop_packet(r, input_packet)
            return {"ok": False, "error": skill_error}
        runner_ctx = _ctx_for_runner(ctx, r)
        runner_ctx["requiredAgentCapabilities"] = required
        res = runner_hub.call_sync(r, "job.dispatch", {
            "task": _task_payload(t), "cli": cli, "cfg": cfg or {}, "ctx": runner_ctx,
            "files": input_packet, "skills": skill_packet, "requiredCapabilities": required,
            "dispatchId": dispatch_id,
        }, timeout=_DISPATCH_TIMEOUT)
    finally:
        runner_hub.release_dispatch(r, reservation)
    if not res.get("ok"):
        if res.get("uncertain"):
            # The bytes may already have reached the Runner. Dropping the task back to
            # todo would invite a second Agent; heartbeat will confirm this stable ref.
            return {"ok": False, "uncertain": True,
                    "code": str(res.get("code") or "RUNNER_ACK_UNKNOWN"),
                    "error": res.get("error") or "执行机回执暂未确认",
                    "issueId": expected_ref, "expectedRef": expected_ref,
                    "dispatchId": dispatch_id, "provider": "runner",
                    "runnerId": r.id, "runnerClientId": r.client_id,
                    "runnerBootId": str(getattr(r, "boot_id", "") or ""),
                    "runnerVersion": r.version, "host": r.host,
                    "assigneeId": aid, "assigneeType": "agent",
                    "assigneeName": (assignee or {}).get("name", ""),
                    "assigneeCli": cli}
        _drop_packet(r, input_packet)
        _drop_packet(r, skill_packet)
        return {"ok": False, "error": res.get("error") or "执行机没能把活起起来",
                "code": str(res.get("code") or ""),
                "retryable": bool(res.get("retryable")),
                "capacity": dict(res.get("data") or {})}
    d = res.get("data") or {}
    dispatch_state = str(d.get("state") or "running").lower()
    if dispatch_state in {"failed", "cancelled"}:
        return {"ok": False, "code": "RUNNER_DISPATCH_" + dispatch_state.upper(),
                "error": str(d.get("error") or "执行机未能启动这项工作"),
                "retryable": dispatch_state == "failed"}
    if d.get("ref"):
        remember(str(d["ref"]), r.id)
    if not d.get("duplicate"):
        note_accepted = getattr(r, "note_dispatch_accepted", None)
        if callable(note_accepted):
            note_accepted(dispatch_state == "queued")
    agent = next((item for item in (r.agents or [])
                  if str(item.get("key") or "") == cli), {})
    fallback_model = (dict((cfg or {}).get("llm") or {}).get("model")
                      if "local:" + cli in GATEWAY_MODEL_KINDS else "")
    model = str(d.get("model") or fallback_model or "")
    from . import turn_correlation
    return {"ok": True, "issueId": d.get("ref", ""), "identifier": d.get("identifier", ""),
            **turn_correlation.public(d),
            "url": "", "provider": "runner", "assigneeType": "agent",
            "assigneeId": aid,
            "assigneeName": (assignee or {}).get("name", ""), "assigneeCli": cli,
            "agentCli": cli, "agentCliName": agent.get("name") or cli,
            "agentCliVersion": agent.get("version") or "",
            "agentSessionId": d.get("agentSessionId") or "", "model": model,
            "reasoningEffort": d.get("reasoningEffort") or "",
            "runnerId": r.id, "runnerClientId": r.client_id,
            "runnerBootId": str(getattr(r, "boot_id", "") or ""),
            "runnerVersion": r.version, "host": r.host,
            "selection": dict((assignee or {}).get("selection") or {}),
            "pluginSnapshot": dict(d.get("pluginSnapshot") or {}),
            "contextReport": dict(d.get("contextReport") or {}),
            "files": len(input_packet.get("items") or []),
            "dispatchId": str(d.get("dispatchId") or dispatch_id),
            "duplicate": bool(d.get("duplicate")),
            "state": dispatch_state,
            "queued": dispatch_state == "queued",
            "queuePosition": max(0, int(d.get("queuePosition") or 0)),
            "queueClass": str(d.get("queueClass") or "task")}


def _runner_of_ref(ref: str):
    """Resolve an execution's Runner from the cached mapping first, then discover it after restarts
    or machine changes.
    """
    ref = str(ref or "")
    if not ref:
        return None
    cached = _cached_runner(ref)
    if cached is not None:
        return cached
    for r in runner_hub.online():
        res = runner_hub.call_sync(r, "job.has", {"ref": ref}, timeout=15)
        if res.get("ok") and (res.get("data") or {}).get("has"):
            remember(ref, r.id)
            return r
    return None


async def runner_of_ref_async(ref: str):
    """Resolve the Runner asynchronously. Await runner.call directly; synchronous RPC from the main
    event loop would deadlock while waiting for that same loop.
    """
    ref = str(ref or "")
    if not ref:
        return None
    cached = _cached_runner(ref)
    if cached is not None:
        return cached
    for r in runner_hub.online():
        res = await r.call("job.has", {"ref": ref}, timeout=15)
        if res.get("ok") and (res.get("data") or {}).get("has"):
            remember(ref, r.id)
            return r
    return None


def status_sync(cfg: dict, ref: str) -> dict:
    r = _runner_of_ref(ref)
    if r is None:
        return {"ok": False, "error": "这条活所在的执行机不在线"}
    res = runner_hub.call_sync(r, "job.status", {"ref": ref}, timeout=60)
    if not res.get("ok"):
        return {"ok": False, "error": res.get("error") or "问不到状态"}
    d = dict(res.get("data") or {})
    d["host"] = r.host
    return d


def _scm_runner(route: dict):
    runner_id, ref = str(route.get("runnerId") or ""), str(route.get("ref") or "")
    runner = runner_hub.get(runner_id) if runner_id else None
    return runner or (_runner_of_ref(ref) if ref else None)


def git_inspect_sync(route: dict, payload: dict) -> dict:
    """Inspect a private branch on the same trusted Runner that executed it."""
    runner = _scm_runner(route)
    if runner is None:
        return {"ok": False, "error": "执行开发需求的 Runner 不在线，无法检查私有仓库"}
    result = runner_hub.call_sync(
        runner, "git.inspect", {"payload": dict(payload or {})}, timeout=240)
    if not result.get("ok"):
        return {"ok": False, "error": result.get("error") or "Runner 检查仓库失败"}
    return dict(result.get("data") or {})


def git_probe_sync(route: dict, payload: dict) -> dict:
    """Probe Git from a selected trusted Runner without modifying the remote repository."""
    runner = _scm_runner(route)
    if runner is None:
        return {"ok": False, "error": "用于工程预检的 Runner 不在线"}
    result = runner_hub.call_sync(
        runner, "git.probe", {"payload": dict(payload or {})}, timeout=240)
    if not result.get("ok"):
        data = dict(result.get("data") or {})
        return {**data, "ok": False,
                "error": data.get("error") or result.get("error") or "Runner 无法读取代码仓库"}
    return dict(result.get("data") or {})


def git_merge_sync(route: dict, payload: dict) -> dict:
    """Execute an already-approved merge in a clean mirror on that Runner."""
    runner = _scm_runner(route)
    if runner is None:
        return {"ok": False, "error": "执行开发需求的 Runner 不在线，无法合并私有仓库"}
    result = runner_hub.call_sync(
        runner, "git.merge", {"payload": dict(payload or {})}, timeout=300)
    if not result.get("ok"):
        data = dict(result.get("data") or {})
        return {**data, "ok": False,
                "error": data.get("error") or result.get("error") or "Runner 合并仓库失败"}
    return dict(result.get("data") or {})


def runner_info_sync(cfg: dict, ref: str) -> dict:
    r = _runner_of_ref(ref)
    if r is None:
        return {}
    res = runner_hub.call_sync(r, "job.info", {"ref": ref}, timeout=30)
    d = dict((res.get("data") or {}) if res.get("ok") else {})
    if d:
        d["device"] = r.host
    return d


def session_sync(cfg: dict, ref: str, since: int = 0, limit: int = 400) -> dict:
    """Read incremental remote session activity using the shared local execution format. since
    identifies the last observed sequence number for reconnect-safe continuation.
    """
    first = _runner_of_ref(ref)
    if first is None:
        return {"ok": False, "items": [], "error": "这条活所在的执行机不在线"}
    packet = {
        "ref": ref,
        "since": max(0, int(since or 0)),
        "limit": min(1000, max(1, int(limit or 400))),
    }
    # A desktop can briefly have an old packaged Runner and a new development
    # Runner online at the same time.  The old process understands ``job.has``
    # but not ``job.session``.  Try every machine that really owns the ref so a
    # rolling upgrade never turns into a blank workbench.
    candidates = [first] + [x for x in runner_hub.online() if x.id != first.id]
    errors = []
    for index, runner in enumerate(candidates):
        if index:
            owned = runner_hub.call_sync(runner, "job.has", {"ref": ref}, timeout=15)
            ownership = dict(owned.get("data") or {})
            if not owned.get("ok") or not (ownership.get("has") or ownership.get("found")):
                continue
        res = runner_hub.call_sync(runner, "job.session", packet, timeout=30)
        if not res.get("ok"):
            errors.append(str(res.get("error") or "远程会话拿不到"))
            continue
        data = dict(res.get("data") or {})
        data.setdefault("ok", True)
        data["runnerId"] = runner.id
        data["host"] = runner.host
        remember(ref, runner.id)
        return data
    return {"ok": False, "items": [],
            "error": errors[-1] if errors else "远程会话拿不到"}


def _b64(res: dict) -> bytes | None:
    """Decode raw binary chunks from newer Runners and base64 chunks from older Runners during
    rolling upgrades.
    """
    data = res.get("data") or {}
    if not res.get("ok"):
        return None
    if isinstance(data.get("bytes"), (bytes, bytearray)):
        return bytes(data["bytes"])
    if "b64" not in data:
        return None
    try:
        return base64.b64decode(data["b64"])
    except Exception:  # noqa: BLE001
        return None


def _download(r, ref: str, att_id: str) -> bytes | None:
    """Fetch remote artifacts in chunks to avoid WebSocket frame and transfer-size limits."""
    out = bytearray()
    offset = 0
    while True:
        res = runner_hub.call_sync(r, "job.file", {
            "ref": ref, "fileId": att_id, "offset": offset, "limit": _OUTPUT_CHUNK,
        }, timeout=90)
        chunk = _b64(res)
        if chunk is None:
            log.warning("Runner 产出分片读取失败 ref=%s file=%s offset=%d: %s",
                        ref[:12], str(att_id)[:160], offset,
                        str(res.get("error") or "返回格式不完整")[:240])
            return None
        data = res.get("data") or {}
        size = int(data.get("size") or 0)
        if size > _OUTPUT_MAX or int(data.get("offset") or 0) != offset:
            log.warning("Runner 产出分片元数据不一致 ref=%s file=%s offset=%d size=%d",
                        ref[:12], str(att_id)[:160], offset, size)
            return None
        out.extend(chunk)
        offset += len(chunk)
        if data.get("eof"):
            return bytes(out) if offset == size else None
        if not chunk or offset > _OUTPUT_MAX:
            log.warning("Runner 产出分片提前结束 ref=%s file=%s offset=%d",
                        ref[:12], str(att_id)[:160], offset)
            return None


def fetch_attachment_for_sync(cfg: dict, ref: str, att_id: str) -> bytes | None:
    """Fetch an artifact from its execution's Runner and workspace. The execution ref prevents
    collisions between identical relative paths in different tasks.
    """
    r = _runner_of_ref(ref)
    if r is None:
        return None
    return _download(r, ref, att_id)


def fetch_attachment_sync(cfg: dict, att_id: str) -> bytes | None:
    """Legacy artifact-byte lookup without an execution ref. Prefer execution-scoped retrieval
    because relative names can be ambiguous across tasks.
    """
    for r in runner_hub.online():
        b = _download(r, "", att_id)
        if b is not None:
            return b
    return None


def stop_sync(cfg: dict, ref: str) -> dict:
    r = _runner_of_ref(ref)
    if r is None:
        return {"ok": False, "error": "这条活所在的执行机不在线"}
    res = runner_hub.call_sync(r, "job.stop", {"ref": ref}, timeout=60)
    return (res.get("data") or {}) if res.get("ok") else {"ok": False, "error": res.get("error")}


def comment_sync(cfg: dict, ref: str, text: str) -> dict:
    clean_cfg = dict(cfg or {})
    pinned = str(clean_cfg.pop("_continuationRunnerId", ""))
    identity = clean_cfg.pop("_continuationRunnerIdentity", None)
    r = runner_hub.get(pinned) if pinned else _runner_of_ref(ref)
    if r is None:
        # RUNNER_OFFLINE indicates a transient delivery failure eligible for automatic retry.
        # task_rework retries it with backoff; other delivery errors require manual intervention.
        return {"ok": False, "code": "RUNNER_OFFLINE",
                "error": "\u8fd9\u6761\u6d3b\u6240\u5728\u7684\u6267\u884c\u673a\u4e0d\u5728\u7ebf"}
    if pinned and identity is not None and any(
            str(getattr(r, key, "") or "") != value for key, value in identity.items()):
        return {"ok": False, "code": "RUNNER_IDENTITY_CHANGED",
                "error": "原执行机身份已变化，请刷新状态后重试"}
    record_user = bool(clean_cfg.pop("_recordUser", False))
    message_id = str(clean_cfg.pop("_messageId", ""))
    selection = clean_cfg.pop("_executionSelection", None)
    files = clean_cfg.pop("_turnFiles", [])
    packet = {}
    if files:
        if "turnFiles1" not in getattr(r, "caps", []):
            return {"ok": False, "error": "原执行机尚未支持追加文件，请先更新"}
        packet, error = _upload_inputs(r, files)
        if error:
            return {"ok": False, "error": error}
    res = runner_hub.call_sync(r, "job.comment", {
        "ref": ref, "text": text, "cfg": clean_cfg,
        "recordUser": record_user, "turnId": message_id, "files": packet,
        **({"executionSelection": selection} if selection is not None else {})}, timeout=60)
    if not res.get("ok"):
        if not res.get("uncertain"):
            _drop_packet(r, packet)
        return {"ok": False, "error": res.get("error"), "code": res.get("code", ""),
                "uncertain": bool(res.get("uncertain"))}
    data = dict(res.get("data") or {})
    # Admission ACKs describe the accepted turn but do not carry a second `ok`.
    # Older Runners return the nested local_stream receipt, including its `ok`.
    accepted = data.get("ok", str(data.get("state") or "") not in {"failed", "cancelled"})
    if not accepted and not data.get("uncertain"):
        _drop_packet(r, packet)
    return {**data, "ok": bool(accepted)}


def is_running(ref: str) -> bool:
    st = status_sync({}, ref)
    # ai_exec.can_stop uses this as an "active and cancellable" predicate.  A queued
    # operation has not started a process yet, but cancelling it is both valid and cheap.
    return bool(st.get("running")) or str(st.get("status") or st.get("state") or "") in {
        "queued", "starting", "dispatching", "running"}


def preview_issue(t, cfg: dict, ctx: dict | None = None) -> dict:
    """Build the dispatch preview with ai_local's shared composition rules, independent of
    execution location.
    """
    from . import ai_local
    return ai_local.preview_issue(t, cfg, ctx)
