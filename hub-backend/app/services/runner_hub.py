"""Public module behavior and service contracts."""
from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid

from . import execution_capabilities
from .runner_identity_error import RunnerIdentityConflict
from ..agent_catalog import AGENTS

log = logging.getLogger("uvicorn.error")

# Online Runners indexed by Runner ID.
_RUNNERS: dict[str, "_Runner"] = {}

_RPC_TIMEOUT = 60.0          # Default RPC timeout; dispatch can request a longer deadline.
_BEAT_DEAD_S = 90            # Heartbeat expiry interval.
CLIENT_TAG = "soduwork-client"   # Reserved tag identifying desktop-embedded Runners.
_MAX_CONCURRENT_LIMIT = 20


def clean_protocol_caps(value) -> list[str]:
    """Preserve bounded protocol identifiers exactly across Hub transports."""
    if not isinstance(value, list):
        return []
    # executionSelection1 exceeds the old 16-character display-style limit.
    # Drop malformed/oversized identifiers instead of creating truncated aliases.
    # Desktop hello already advertises nine capabilities, including admit1.
    # Leave bounded room for protocol growth without dropping admission support.
    return list(dict.fromkeys(item for item in value[:32]
                              if isinstance(item, str) and 0 < len(item) <= 64))


def clean_max_concurrent(value, default: int = 1) -> int:
    """Normalize a Runner capacity advertised across the trust boundary."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = int(default or 1)
    return max(1, min(_MAX_CONCURRENT_LIMIT, number))


def clean_counter(value, default: int = 0, maximum: int = 1_000_000) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = int(default or 0)
    return max(0, min(maximum, number))


def clean_percent(value, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = float(default or 0.0)
    return max(0.0, min(100.0, number))


def clean_agent_inventory(value) -> list[dict]:
    """Keep runner inventory aligned with the active Agent catalog.

    Runners can outlive a catalog update and continue to report an executable
    that SoduWork no longer offers. Filtering at the registry boundary prevents
    stale Claude Code entries from appearing in management pages or being
    selected for new work, while preserving the rest of each inventory row.
    """
    if not isinstance(value, list):
        return []
    active = set(AGENTS)
    result = []
    for row in value:
        if not isinstance(row, dict):
            continue
        key = str(row.get("key") or row.get("id") or "").strip()
        base = key.split(":", 1)[-1].strip()
        if base not in active and not base.startswith("custom-"):
            continue
        result.append(row)
    return result

# Retain the event-loop handle for worker-thread provider calls.
# Runner WebSockets belong to the main event loop.
# Worker threads must not access those connections directly.
# call_sync submits work through run_coroutine_threadsafe.
_LOOP: "asyncio.AbstractEventLoop | None" = None


def clean_skill_names(value) -> list[str]:
    """Accept skill names only from Runners, never local paths or package contents."""
    out = []
    for item in value or []:
        name = str(item or "").strip()[:64]
        if name and name not in out:
            out.append(name)
    return out[:200]


_SKILL_SOURCE_LABELS = {
    "pi": "Pi", "codex": "Codex", "claude": "Claude Code",
    "agents": "Agent Skills", "soduwork": "SoduWork 本机",
    "builtin": "SoduWork 内置", "local": "本机 Skill",
}


def clean_skill_catalog(value) -> list[dict]:
    """Accept only display metadata; paths, instructions and resources are dropped."""
    out = []
    seen = set()
    for raw in value or []:
        item = raw if isinstance(raw, dict) else {}
        name = str(item.get("name") or "").strip()[:64]
        if not name or name in seen:
            continue
        seen.add(name)
        source_key = str(item.get("sourceKey") or "local").strip().lower()[:24]
        if source_key not in _SKILL_SOURCE_LABELS:
            source_key = "local"
        out.append({
            "name": name,
            "description": str(item.get("description") or "")[:1024],
            "compatibility": str(item.get("compatibility") or "")[:500],
            "source": _SKILL_SOURCE_LABELS[source_key],
            "sourceKey": source_key,
            "version": str(item.get("version") or "")[:64],
            "hasScripts": bool(item.get("hasScripts")),
        })
        if len(out) >= 200:
            break
    return out


def bind_loop() -> None:
    """Capture the active event loop for later worker-thread calls."""
    global _LOOP
    try:
        _LOOP = asyncio.get_running_loop()
    except RuntimeError:
        _LOOP = None


def call_sync(runner: "_Runner", op: str, data: dict, timeout: float = _RPC_TIMEOUT) -> dict:
    """Behavior and constraints for this operation."""
    if _LOOP is None:
        return {"ok": False, "error": "后端还没准备好（事件循环没绑上）"}
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        pass                        # A valid caller is a worker thread without a running event loop.
    else:
        log.error("★call_sync(%s) 被在事件循环里调用了——会把整个后端卡住。"
                  "调用方请改成 await asyncio.to_thread(...)", op)
        return {"ok": False, "error": "内部错误：执行机通信被放在了错误的线程上"}
    import concurrent.futures
    fut = asyncio.run_coroutine_threadsafe(runner.call(op, data, timeout), _LOOP)
    try:
        return fut.result(timeout + 10)
    except concurrent.futures.TimeoutError:
        fut.cancel()
        return {"ok": False, "error": "执行机 %s 超时没回话" % runner.host,
                "uncertain": op in {"job.dispatch", "job.comment"}}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": "发给执行机失败（%s）" % type(e).__name__,
                "uncertain": op in {"job.dispatch", "job.comment"}}

class _Runner:
    """One connected Runner."""

    def __init__(self, ws, info: dict):
        self.ws = ws
        self.id = str(info.get("runnerId") or "")[:64]
        self.host = str(info.get("host") or "")[:80]
        self.os = str(info.get("os") or "")[:40]
        self.version = str(info.get("version") or "")[:40]
        self.boot_id = str(info.get("bootId") or "")[:64]
        # Resolve owner names from authenticated Hub device records, not Runner-provided claims.
        self.owner_name = ""
        self.owner_user_id = ""  # Bound from RunnerNode by the Hub, never hello.
        self.management_state = ""  # Administrator policy, never accepted from hello.
        # Set by the authenticated Hub handshake, never trusted from Runner hello payload.
        self.org_id = ""
        # Use binary frames only when both peers negotiate bin1.
        self.caps = clean_protocol_caps(info.get("caps"))
        self.bin = "bin1" in self.caps
        # Installed CLI inventory reported by the Runner's local discovery.
        raw_agents = info.get("agents")
        self.agents: list[dict] = clean_agent_inventory(raw_agents)
        # An inventory report is distinct from having at least one installed agent.
        # The initial handshake may carry an unscanned empty array.
        # New Runners explicitly report inventoryReady.
        # Older empty-inventory Runners wait for heartbeat confirmation before accepting jobs.
        self.inventory_ready = bool(info.get("inventoryReady")) or bool(self.agents)
        self.skills_known = isinstance(info.get("skills"), list)
        self.skills = clean_skill_names(info.get("skills"))
        self.skill_catalog = clean_skill_catalog(info.get("skillCatalog"))
        # Missing capability reports remain empty; capability-based scheduling fails conservatively.
        self.capabilities = execution_capabilities.clean_report(info.get("capabilities"))
        # Owning desktop client used for preferred-device routing.
        self.client_id = str(info.get("clientId") or "")[:64]
        # Runner-reported work root; the server must not infer remote paths from its own filesystem.
        self.work_root = str(info.get("workRoot") or "")[:500]
        self.tags = [str(x).strip().lower()[:40] for x in (info.get("tags") or [])
                     if str(x).strip()][:20]
        self.connected_at = time.time()
        self.last_beat = time.time()
        self.busy = 0
        self.max_concurrent = clean_max_concurrent(info.get("maxConcurrent"), 1)
        self.adaptive_limit = clean_max_concurrent(
            info.get("adaptiveLimit"), self.max_concurrent)
        self.concurrency_ceiling = clean_max_concurrent(
            info.get("concurrencyCeiling"), self.adaptive_limit)
        self.queue_depth = clean_counter(info.get("queueDepth"))
        self.queued_conversations = clean_counter(info.get("queuedConversations"))
        self.queued_tasks = clean_counter(info.get("queuedTasks"))
        self.task_outstanding = clean_counter(info.get("taskOutstanding"))
        self.task_queue_capacity = clean_counter(info.get("taskQueueCapacity"), maximum=10_000)
        self.cpu_percent = clean_percent(info.get("cpuPercent"))
        self.memory_percent = clean_percent(info.get("memoryPercent"))
        self.memory_available_bytes = clean_counter(
            info.get("memoryAvailableBytes"), maximum=1 << 60)
        self.resource_pressure = str(info.get("resourcePressure") or "normal")[:20]
        # The durable registry replaces this warming state before the welcome message.  A
        # reconnecting disabled node must never receive work in that short window.
        self.dispatch_mode = "warming"
        self._registry_write = 0.0
        self._waiters: dict[str, asyncio.Future] = {}
        # ASGI WebSocket only has one outbound transport.  Probe, dispatch, terminal
        # relay and status recovery may call it concurrently, so serialize every frame.
        self._send_lock = asyncio.Lock()
        self.ready = False
        # Reserve capacity between scheduling and the first authoritative heartbeat.
        self._reservation_lock = threading.Lock()
        self._dispatch_reservations: set[str] = set()
        # Terminal subscriptions map tasks to output callbacks.
        self.term_subs: dict[str, object] = {}

    # RPC send and receive.
    async def send(self, msg: dict) -> None:
        from .cluster_runtime import check_owner
        from .runner_access_policy import authorize_send
        # Content operations may already own the policy transaction. Always
        # acquire policy before the socket lock: another request waiting for
        # that transaction must not block its owner's content RPCs.
        async with authorize_send(self, str(msg.get("op") or "")):
            async with self._send_lock:
                await check_owner(self)
                # A half-open socket must fail fast. Without a send timeout the caller can
                # wait forever before the RPC reply timeout has even started.
                await asyncio.wait_for(self.ws.send_json(msg), timeout=15)

    async def call(self, op: str, data: dict, timeout: float = _RPC_TIMEOUT) -> dict:
        """Send one RPC and await its reply with a mandatory timeout because remote machines may
        sleep or disconnect.
        """
        if not self.ready:
            return {"ok": False, "error": f"执行机 {self.host} 仍在建立控制通道",
                    "code": "RUNNER_NOT_READY", "uncertain": False}
        if op == "job.dispatch":
            from .cluster_runtime import check_admission
            if not await check_admission(self):
                return {"ok": False, "uncertain": False, "code": "RUNNER_ADMISSION_REVOKED",
                        "error": "执行机授权或接单状态已变更，请重新选择"}
        from .cluster_bus import RunnerOwnerChanged
        from .runner_access_policy import RunnerAccessDenied
        rid = uuid.uuid4().hex[:12]
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._waiters[rid] = fut
        try:
            # Assign the transport correlation ID after copying business fields.
            # A payload ID must not overwrite it and orphan an otherwise successful reply.
            if op in {"runner.probe", "job.dispatch"}:
                log.info("向执行机 %s 发送指令：%s", self.id, op)
            await self.send({"op": op, **data, "id": rid})
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            log.warning("执行机指令超时 runner=%s op=%s", self.id, op)
            return {"ok": False, "error": f"执行机 {self.host} 超过 {int(timeout)} 秒没回话",
                    "code": "RUNNER_ACK_TIMEOUT", "uncertain": op in {"job.dispatch", "job.comment"}}
        except RunnerAccessDenied as exc:
            return {"ok": False, "uncertain": False, "code": "RUNNER_MANAGEMENT_RESTRICTED",
                    "error": str(exc)}
        except RunnerOwnerChanged:
            return {"ok": False, "uncertain": False, "code": "RUNNER_OWNER_CHANGED",
                    "error": "执行机已重新连接，正在更新路由"}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"发给执行机失败（{type(e).__name__}）",
                    "code": "RUNNER_CONNECTION_ERROR", "uncertain": op in {"job.dispatch", "job.comment"}}
        finally:
            self._waiters.pop(rid, None)

    def resolve(self, rid: str, payload: dict) -> None:
        fut = self._waiters.get(rid)
        if fut is not None and not fut.done():
            fut.set_result(payload)

    def effective_load(self) -> int:
        with self._reservation_lock:
            pending = len(self._dispatch_reservations)
        return (max(0, int(self.busy or 0)) + max(0, int(self.queued_conversations or 0)) +
                max(0, int(self.queued_tasks or 0)) + pending)

    def has_capacity(self) -> bool:
        with self._reservation_lock:
            pending = len(self._dispatch_reservations)
        if self.task_queue_capacity > 0:
            return self.task_outstanding + pending < self.task_queue_capacity
        return max(0, int(self.busy or 0)) + pending < self.max_concurrent

    def reserve_dispatch(self, key: str) -> tuple[bool, str]:
        """Atomically reserve one slot before bytes or credentials leave the Hub."""
        token = str(key or "")[:128] or uuid.uuid4().hex
        with self._reservation_lock:
            if token in self._dispatch_reservations:
                return False, "duplicate"
            pending = len(self._dispatch_reservations)
            if self.task_queue_capacity > 0:
                if self.task_outstanding + pending >= self.task_queue_capacity:
                    return False, "capacity"
            elif max(0, int(self.busy or 0)) + pending >= self.max_concurrent:
                return False, "capacity"
            self._dispatch_reservations.add(token)
        return True, token

    def note_dispatch_accepted(self, queued: bool = False) -> None:
        """Optimistically close the heartbeat gap after a successful task ACK."""
        if self.task_queue_capacity <= 0:
            return
        self.task_outstanding = min(self.task_queue_capacity, self.task_outstanding + 1)
        if queued:
            self.queued_tasks = min(self.task_queue_capacity, self.queued_tasks + 1)
            self.queue_depth = max(self.queue_depth, self.queued_tasks + self.queued_conversations)

    def release_dispatch(self, token: str) -> None:
        with self._reservation_lock:
            self._dispatch_reservations.discard(str(token or ""))

    def api(self) -> dict:
        return {"runnerId": self.id, "host": self.host, "os": self.os,
                "version": self.version, "bootId": self.boot_id, "clientId": self.client_id,
                "orgId": self.org_id, "ownerUserId": self.owner_user_id,
                "managementState": self.management_state,
                "workRoot": self.work_root,
                "tags": self.tags, "agents": self.agents, "caps": list(self.caps),
                "skills": list(self.skills), "skillsKnown": self.skills_known,
                "skillCatalog": [dict(item) for item in self.skill_catalog],
                "capabilities": self.capabilities, "busy": self.busy,
                "pending": max(0, self.effective_load() - max(0, int(self.busy or 0))),
                "load": self.effective_load(), "maxConcurrent": self.max_concurrent,
                "adaptiveLimit": self.adaptive_limit,
                "concurrencyCeiling": self.concurrency_ceiling,
                "queueDepth": self.queue_depth,
                "queuedConversations": self.queued_conversations,
                "queuedTasks": self.queued_tasks,
                "taskOutstanding": self.task_outstanding,
                "taskQueueCapacity": self.task_queue_capacity,
                "cpuPercent": round(self.cpu_percent, 1),
                "memoryPercent": round(self.memory_percent, 1),
                "memoryAvailableBytes": self.memory_available_bytes,
                "resourcePressure": self.resource_pressure,
                "available": can_dispatch(self) and self.has_capacity(),
                "online": self.alive(), "mode": self.dispatch_mode,
                "inventoryReady": self.inventory_ready,
                "accepting": can_dispatch(self),
                "since": int(self.connected_at), "lastSeen": int(self.last_beat)}

    def alive(self) -> bool:
        return (time.time() - self.last_beat) < _BEAT_DEAD_S


# Connection registry.
def add(ws, info: dict) -> _Runner:
    r = _Runner(ws, info)
    if not r.id:
        r.id = uuid.uuid4().hex[:12]
    old = _RUNNERS.get(r.id)
    if old is not None and old.ws is not ws:
        if str(old.client_id or "") != str(r.client_id or ""):
            raise RunnerIdentityConflict()
        # Replace the previous connection when the same Runner reconnects.
        log.info("执行机 %s 重连，替换旧连接", r.id)
        for fut in list(old._waiters.values()):
            if not fut.done():
                fut.set_result({"ok": False, "error": "执行机已建立新连接",
                                "code": "RUNNER_RECONNECTED", "uncertain": True})
        try:
            asyncio.get_running_loop().create_task(_close_quietly(old.ws, 1012))
        except Exception:  # noqa: BLE001 - tests and already-closed peers may have no live loop
            pass
    _RUNNERS[r.id] = r
    return r


async def _close_quietly(ws, code: int) -> None:
    try:
        await ws.close(code=code)
    except Exception:  # noqa: BLE001 - replacement must not leak task exceptions
        pass


def drop(runner_id: str, ws=None) -> bool:
    """Remove a connection only when its WebSocket identity still matches; a delayed close from an
    old connection must not delete its replacement.
    """
    cur = _RUNNERS.get(runner_id)
    if cur is not None and (ws is None or cur.ws is ws):
        _RUNNERS.pop(runner_id, None)
        for fut in list(cur._waiters.values()):
            if not fut.done():
                fut.set_result({"ok": False, "error": "执行机连接已断开",
                                "code": "RUNNER_DISCONNECTED", "uncertain": True})
        return True
    return False


async def disconnect_client(client_id: str, code: int = 4403, *, _local: bool = False) -> None:
    """Drop every runner authenticated as a revoked/rebound SoduWork device."""
    from .cluster_bus import bus
    if bus.enabled and not _local:
        await bus.broadcast({"kind": "revoke", "device": client_id, "code": code})
    targets = [r for r in list(_RUNNERS.values()) if r.client_id == client_id]
    for runner in targets:
        drop(runner.id, runner.ws)
        try:
            await runner.ws.close(code=code)
        except Exception:  # noqa: BLE001 - closing a dead socket is harmless
            pass


async def disconnect_runner(runner_id: str, code: int = 4401) -> bool:
    """Evict one live Runner without waiting for its process to exit."""
    runner = _RUNNERS.get(str(runner_id or ""))
    if runner is None:
        return False
    removed = drop(runner.id, runner.ws)
    try:
        await runner.ws.close(code=code)
    except Exception:  # noqa: BLE001 - the peer may already be gone
        pass
    return removed


def _all_runners() -> dict:
    from .cluster_runtime import remote_runners
    return {**_RUNNERS, **{r.id: r for r in remote_runners()}}


def get(runner_id: str) -> _Runner | None:
    r = _all_runners().get(runner_id)
    return r if (r is not None and r.alive()) else None


def online() -> list[_Runner]:
    return [r for r in _all_runners().values() if r.alive()]


def api_list() -> list[dict]:
    return [r.api() for r in _all_runners().values()]


def can_dispatch(runner: _Runner) -> bool:
    """Whether the node may receive new work; unassigned standalone nodes fail closed."""
    from .cluster_bus import bus
    if not bus.healthy:
        return False
    assigned = bool(str(getattr(runner, "client_id", "") or "") or
                    str(getattr(runner, "org_id", "") or ""))
    return (runner.alive() and assigned and bool(getattr(runner, "ready", False)) and
            not getattr(runner, "management_state", "") and
            bool(getattr(runner, "inventory_ready", False)) and
            getattr(runner, "dispatch_mode", "accepting") == "accepting")


def dispatchable() -> list[_Runner]:
    return [r for r in _all_runners().values() if can_dispatch(r)]


def effective_load(runner) -> int:
    method = getattr(runner, "effective_load", None)
    if callable(method):
        return max(0, int(method() or 0))
    return max(0, int(getattr(runner, "busy", 0) or 0))


def has_capacity(runner) -> bool:
    method = getattr(runner, "has_capacity", None)
    return bool(method()) if callable(method) else True


def reserve_dispatch(runner, key: str) -> tuple[bool, str]:
    method = getattr(runner, "reserve_dispatch", None)
    return method(key) if callable(method) else (True, str(key or uuid.uuid4().hex))


def release_dispatch(runner, token: str) -> None:
    method = getattr(runner, "release_dispatch", None)
    if callable(method):
        method(token)


def is_client_runtime(runner: _Runner) -> bool:
    """Identify an embedded desktop Runner from its reserved tag, not its hostname."""
    return CLIENT_TAG in set(getattr(runner, "tags", []) or [])


def _personal_rank(runner: _Runner) -> tuple:
    """Order personal executors by embedded-client preference, load, then stable connection order.

    """
    return (0 if is_client_runtime(runner) else 1,
            effective_load(runner),
            float(getattr(runner, "connected_at", 0) or 0))


def capability_verdict(runner: _Runner, required=None) -> dict:
    return execution_capabilities.evaluate(
        getattr(runner, "capabilities", None), required)


def supports_capabilities(runner: _Runner, required=None) -> bool:
    return bool(capability_verdict(runner, required).get("ok"))


def in_scope(runner: _Runner, allowed_client_ids: set[str] | None = None,
             allowed_org_ids: set[str] | None = None) -> bool:
    """Fail-closed tenant boundary shared by dispatch, terminals and session routing."""
    if getattr(runner, "owner_user_id", ""):
        # Personal external runners cannot become shared infrastructure via
        # inherited org permissions. Cloud dispatch has a separate exact-owner
        # grant, derived from the durable registry.
        return False
    if allowed_client_ids is None and allowed_org_ids is None:
        return True
    client_id = str(getattr(runner, "client_id", "") or "")
    if client_id:
        return allowed_client_ids is not None and client_id in allowed_client_ids
    org_id = str(getattr(runner, "org_id", "") or "")
    return bool(org_id and allowed_org_ids is not None and org_id in allowed_org_ids)


def pick_for(client_id: str, cli: str = "",
             allowed_client_ids: set[str] | None = None,
             required_capabilities=None,
             allowed_org_ids: set[str] | None = None) -> _Runner | None:
    """Behavior and constraints for this operation."""
    cands = [r for r in dispatchable()
             if not getattr(r, "owner_user_id", "")
             and (not cli or any(a.get("key") == cli for a in r.agents))
             and supports_capabilities(r, required_capabilities)
             and has_capacity(r)]
    if allowed_client_ids is not None or allowed_org_ids is not None:
        # Shared standalone Runners have no owning desktop client.
        # Do not exclude eligible shared machines solely through client ownership filtering.
        cands = [r for r in cands if in_scope(r, allowed_client_ids, allowed_org_ids)]
    if not cands:
        return None
    mine = [r for r in cands if client_id and r.client_id == client_id]
    pool = mine or cands
    # One user may own a desktop and separate build machines; prefer the embedded client over standalone nodes.
    # Within each node type, sort by load and stable connection order. resolve_kind handles repair affinity first.
    pool.sort(key=_personal_rank if mine else lambda r: (effective_load(r), r.connected_at))
    return pool[0]


def pick_by_tags(tags: list[str] | None, client_id: str = "",
                 allowed_client_ids: set[str] | None = None,
                 required_capabilities=None,
                 allowed_org_ids: set[str] | None = None,
                 allowed_runner_ids: set[str] | None = None) -> _Runner | None:
    """Select deployment executors by required tags and capabilities, then ownership and load."""
    need = {str(x).strip().lower() for x in (tags or []) if str(x).strip()}
    cands = [r for r in dispatchable()
             if not getattr(r, "owner_user_id", "") and need.issubset(set(r.tags or []))
             and supports_capabilities(r, required_capabilities)
             and has_capacity(r)]
    if allowed_runner_ids is not None:
        # An administrator-bound deployment runner is itself the authorization boundary.
        # Never relax an explicit machine allowlist back to a same-tag tenant runner.
        cands = [r for r in cands if r.id in allowed_runner_ids]
    elif allowed_client_ids is not None or allowed_org_ids is not None:
        cands = [r for r in cands if in_scope(r, allowed_client_ids, allowed_org_ids)]
    if not cands:
        return None
    mine = [r for r in cands if client_id and r.client_id == client_id]
    pool = mine or cands
    pool.sort(key=lambda r: (effective_load(r), r.connected_at))
    return pool[0]


def explain_no_tagged_runner(tags: list[str] | None, allowed_client_ids: set[str] | None = None,
                             required_capabilities=None,
                             allowed_org_ids: set[str] | None = None,
                             allowed_runner_ids: set[str] | None = None) -> str:
    """Explain why a tagged deployment cannot be scheduled without hiding upgrade drift."""
    need_tags = {str(x).strip().lower() for x in (tags or []) if str(x).strip()}
    tagged = [r for r in online() if not getattr(r, "owner_user_id", "") and need_tags.issubset(set(r.tags or []))]
    if allowed_runner_ids is not None:
        tagged = [r for r in tagged if r.id in allowed_runner_ids]
    elif allowed_client_ids is not None or allowed_org_ids is not None:
        tagged = [r for r in tagged if in_scope(r, allowed_client_ids, allowed_org_ids)]
    suffix = ("：" + ", ".join(sorted(need_tags))) if need_tags else ""
    if not tagged:
        return "等待带有所需标签的执行机上线" + suffix
    accepting = [r for r in tagged if can_dispatch(r)]
    if not accepting:
        names = "、".join((r.host or r.id) for r in tagged[:3])
        return "匹配的执行机当前暂停接单：" + names
    available = [r for r in accepting if has_capacity(r)]
    if not available:
        names = "、".join("%s（%d/%d）" % (
            r.host or r.id,
            max(0, int(getattr(r, "task_outstanding", 0) or 0)),
            max(1, int(getattr(r, "task_queue_capacity", 0) or 100)))
            for r in accepting[:3])
        return "匹配的执行机后台任务队列已满，请等待已有任务完成：" + names
    issues = []
    for runner in available[:5]:
        verdict = capability_verdict(runner, required_capabilities)
        if verdict.get("ok"):
            continue
        report = dict(verdict.get("report") or {})
        label = runner.host or runner.id
        if not int(report.get("reportedAt") or 0):
            version = (" " + runner.version) if runner.version else ""
            issues.append("%s 的 Runner%s 未上报能力，请升级并重启 Runner" % (
                label, version))
        else:
            issues.append("%s 缺少%s" % (
                label, "、".join(verdict.get("missingLabels") or ["所需能力"])))
    return "；".join(issues) or ("等待可接单的执行机" + suffix)

def for_client(client_id: str) -> _Runner | None:
    """Resolve this device's own Runner for machine-level actions such as installation and removal.

    """
    mine = [r for r in online() if (client_id and r.client_id == client_id
                                         and is_client_runtime(r))]
    if not mine:
        return None
    mine.sort(key=_personal_rank)
    return mine[0]


# Terminal relay.
async def term_open(r: _Runner, task: str, spec: dict, on_data) -> dict:
    """Open a real remote PTY and route its output to on_data using the same text contract as local
    terminals.
    """
    r.term_subs[task] = on_data
    res = await r.call("term.open", {"task": task, **spec}, timeout=45)
    if not res.get("ok"):
        r.term_subs.pop(task, None)
    return res


async def term_write(r: _Runner, task: str, data: str) -> None:
    try:
        await r.send({"op": "term.in", "task": task, "d": data})
    except Exception:  # noqa: BLE001 - typing during disconnect is harmless
        pass


async def term_resize(r: _Runner, task: str, cols: int, rows: int) -> None:
    try:
        await r.send({"op": "term.resize", "task": task, "cols": cols, "rows": rows})
    except Exception:  # noqa: BLE001 - resize racing disconnect is harmless
        pass


async def term_close(r: _Runner, task: str) -> None:
    r.term_subs.pop(task, None)
    try:
        await r.send({"op": "term.close", "task": task})
    except Exception:  # noqa: BLE001 - Ignore cleanup after the connection has already disappeared.
        pass


async def term_detach(r: _Runner, task: str) -> None:
    """Unsubscribe on browser departure without closing the PTY; reconnects reuse it and Runner
    idle cleanup owns expiration.
    """
    r.term_subs.pop(task, None)
    try:
        await r.send({"op": "term.detach", "task": task})
    except Exception:  # noqa: BLE001
        pass


def term_feed(r: _Runner, task: str, data) -> None:
    """Relay Runner PTY output to the subscribing browser connection."""
    cb = r.term_subs.get(task)
    if cb is None:
        return
    try:
        cb(data)
    except Exception:  # noqa: BLE001
        pass


# Do not infer execution location from terminal subscriptions.
# execution_sessions.task_runner_route owns routing from persisted dispatch facts.
