"""Runner ownership, remote proxies and realtime fan-out for multi-instance Hubs."""
from __future__ import annotations

import asyncio
import logging
import time
import uuid

from .cluster_bus import bus, ClusterUnavailable, RunnerOwnerChanged
from . import runner_hub

_REMOTE = {}
_LOCAL_INVENTORY = {}
_DEVICES = set()
_RELAY = asyncio.Queue(maxsize=2048)
_RELAY_JOB = None
_RELAY_CLOSE_JOBS = set()
_STOPPING = False
log = logging.getLogger("uvicorn.error")


class _RemoteSocket:
    def __init__(self, runner):
        self.runner = runner

    async def close(self, code=1012):
        await self.runner.call("$close", {"code": code}, 10)


class RemoteRunner(runner_hub._Runner):
    """The existing Runner contract; only transport crosses the Hub boundary."""
    def __init__(self, node, info):
        super().__init__(None, info)
        self.node = node
        self.ws = _RemoteSocket(self)
        self.cluster_token = info["clusterToken"]
        self.update(info)

    def update(self, info):
        self._reported_load = int(info.get("load", 0))
        self._reported_available = bool(info.get("available"))
        self.host = info.get("host", "")
        self.owner_name = info.get("ownerName", "")
        self.org_id = info.get("orgId", "")
        self.owner_user_id = info.get("ownerUserId", "")
        self.management_state = info.get("managementState", "")
        self.client_id = info.get("clientId", "")
        self.agents = list(info.get("agents", []))
        self.caps = runner_hub.clean_protocol_caps(info.get("caps"))
        self.skills = list(info.get("skills", []))
        self.skills_known = info.get("skillsKnown", False)
        self.skill_catalog = list(info.get("skillCatalog", []))
        self.capabilities = info.get("capabilities", {})
        self.tags = list(info.get("tags", []))
        self.work_root = info.get("workRoot", "")
        self.last_beat = info.get("lastSeen", 0)
        self.connected_at = info.get("since", 0)
        self.dispatch_mode = info.get("mode", "disabled")
        self.inventory_ready = info.get("inventoryReady", False)
        self.ready = info.get("ready", False)
        for attr, key in (
            ("busy", "busy"), ("max_concurrent", "maxConcurrent"),
            ("adaptive_limit", "adaptiveLimit"), ("concurrency_ceiling", "concurrencyCeiling"),
            ("queue_depth", "queueDepth"), ("queued_conversations", "queuedConversations"),
            ("queued_tasks", "queuedTasks"), ("task_outstanding", "taskOutstanding"),
            ("task_queue_capacity", "taskQueueCapacity"), ("cpu_percent", "cpuPercent"),
            ("memory_percent", "memoryPercent"), ("memory_available_bytes", "memoryAvailableBytes"),
            ("resource_pressure", "resourcePressure"),
        ):
            if key in info:
                setattr(self, attr, info[key])

    def effective_load(self):
        return getattr(self, "_reported_load", 0)

    def has_capacity(self):
        return getattr(self, "_reported_available", False)

    def alive(self):
        return bus.healthy and self.node in bus.peers and super().alive()

    async def call(self, op, data, timeout=60, *, _rerouted=False):
        try:
            result = await bus.request(self.node, "runner.call", {
                "runner": self.id, "token": self.cluster_token,
                "op": op, "data": data, "timeout": timeout,
                "client": self.client_id, "org": self.org_id,
                "owner": self.owner_user_id,
            }, timeout + 5)
            # A rejected old owner has NOT forwarded bytes. Refresh once so a
            # just-reconnected Runner does not require a second user click.
            if (not _rerouted and result.get("code") == "RUNNER_OWNER_CHANGED"
                    and not op.startswith("$")):
                await bus.refresh()
                current = runner_hub.get(self.id)
                if (current is not None and current is not self
                        and current.client_id == self.client_id and current.org_id == self.org_id
                        and current.owner_user_id == self.owner_user_id):
                    task = str(data.get("task", "")) if op == "term.open" else ""
                    if task and task in self.term_subs:
                        current.term_subs[task] = self.term_subs.pop(task)
                    if isinstance(current, RemoteRunner):
                        retried = await current.call(op, data, timeout, _rerouted=True)
                    else:
                        retried = await current.call(op, data, timeout)
                    if task and not retried.get("ok"):
                        current.term_subs.pop(task, None)
                    return retried
            return result
        except Exception:
            return {"ok": False, "code": "CLUSTER_RUNNER_UNAVAILABLE",
                    "error": "执行机连接正在恢复，请稍后重试",
                    "uncertain": op in {"job.dispatch", "job.comment"}}

    async def send(self, msg):
        result = await self.call("$send", msg, 15)
        if not result.get("ok"):
            raise ClusterUnavailable("Runner transport unavailable")

    def reserve_dispatch(self, key):
        result = runner_hub.call_sync(self, "$reserve", {"key": key}, 10)
        return bool(result.get("ok")), result.get("token", "capacity")

    def release_dispatch(self, token):
        runner_hub.call_sync(self, "$release", {"token": token}, 10)

    def note_dispatch_accepted(self, queued=False):
        runner_hub.call_sync(self, "$accepted", {"queued": queued}, 10)


def snapshot():
    from ..realtime import hub
    from .native_discovery import EXTENDED_TOPICS
    # Heartbeats contain small references, not every Skill description on every
    # Runner. Unchanged inventory is kept locally and renewed without retransmit.
    return {"runners": [entry["reference"] for entry in _LOCAL_INVENTORY.values()],
            "nativeDiscoveryTopics": sorted(EXTENDED_TOPICS),
            "devices": list(hub._conns)}


async def register(runner):
    if not bus.enabled:
        return
    runner.cluster_token = bus.node + ":" + uuid.uuid4().hex
    await bus.claim(runner.id, runner.cluster_token)


async def release(runner):
    if not bus.enabled:
        return True
    token = getattr(runner, "cluster_token", "")
    return bool(token and await bus.release(runner.id, token))


async def check_owner(runner):
    if not bus.enabled:
        return
    if not bus.healthy:
        raise ClusterUnavailable("Cluster transport is not ready")
    if (not getattr(runner, "cluster_token", "")
            or not await bus.owns(runner.id, runner.cluster_token)):
        raise RunnerOwnerChanged("Runner connection ownership changed")



async def check_admission(runner):
    if not bus.enabled and not (getattr(runner, "owner_user_id", "") or
                                getattr(runner, "management_state", "")):
        return True
    from .. import automation_models as am, models
    from ..db import SessionLocal
    async with SessionLocal() as session:
        row = await session.get(am.RunnerNode, runner.id)
        if (row is None or row.dispatch_mode != "accepting" or row.auth_state == "revoked"
                or str(getattr(row, "management_state", "") or "")):
            return False
        if str(row.owner_user_id or "") != str(getattr(runner, "owner_user_id", "") or ""):
            return False
        if runner.client_id:
            client = await session.get(models.Client, runner.client_id)
            if client is None or client.auth_state != "active" or row.client_id != runner.client_id:
                return False
        elif str(row.org_id or "") != runner.org_id:
            return False
    return True

async def before_refresh():
    from .cluster_bus import _COMPARE_EXPIRE
    runners = [r for r in list(runner_hub._RUNNERS.values())
               if getattr(r, "cluster_token", "")]
    pipe = bus.redis.pipeline()
    for runner in runners:
        pipe.eval(_COMPARE_EXPIRE, 1, bus.key("runner", runner.id), runner.cluster_token,
                  bus.settings.cluster_lease_seconds)
    renewed = await pipe.execute() if runners else []
    writes = bus.redis.pipeline()
    updates = {}
    seen = set()
    for runner, owns in zip(runners, renewed):
        if not runner.alive() or not owns:
            runner_hub.drop(runner.id, runner.ws)
            await runner_hub._close_quietly(runner.ws, 1012)
            continue
        seen.add(runner.id)
        for key, deadline in list(getattr(runner, "_cluster_reservations", {}).items()):
            if deadline <= time.monotonic():
                runner.release_dispatch(key)
                runner._cluster_reservations.pop(key, None)
        fingerprint = (runner.cluster_token, runner.last_beat, runner.ready,
                       runner.dispatch_mode, runner.management_state, runner._registry_write,
                       runner.effective_load(), runner.task_outstanding)
        old = _LOCAL_INVENTORY.get(runner.id)
        key = bus.key("inventory", runner.cluster_token)
        if old is None or old["fingerprint"] != fingerprint:
            reference = {"runnerId": runner.id, "clusterToken": runner.cluster_token,
                         "revision": uuid.uuid4().hex}
            detail = {**runner.api(), "clusterToken": runner.cluster_token,
                      "ready": runner.ready, "ownerName": runner.owner_name}
            writes.set(key, bus.codec.encode(detail), ex=bus.settings.cluster_lease_seconds * 2)
            updates[runner.id] = {"fingerprint": fingerprint, "reference": reference}
        else:
            writes.expire(key, bus.settings.cluster_lease_seconds * 2)
    await writes.execute()
    _LOCAL_INVENTORY.update(updates)
    for rid in set(_LOCAL_INVENTORY) - seen:
        _LOCAL_INVENTORY.pop(rid, None)


async def on_snapshot(peers):
    entries = [(node, info) for node, state in peers.items() if node != bus.node
               for info in state.get("runners", [])]
    owners = await bus.redis.mget([bus.key("runner", info["runnerId"])
                                  for _, info in entries]) if entries else []
    valid = [(node, info) for (node, info), owner in zip(entries, owners)
             if owner == info.get("clusterToken", "").encode()]
    changed = [(node, info) for node, info in valid
               if info["runnerId"] not in _REMOTE
               or getattr(_REMOTE[info["runnerId"]], "inventory_revision", "") != info["revision"]]
    blobs = await bus.redis.mget([bus.key("inventory", info["clusterToken"])
                                  for _, info in changed]) if changed else []
    seen = {info["runnerId"] for _, info in valid}
    for (node, reference), blob in zip(changed, blobs):
        rid = reference["runnerId"]
        if not blob:
            seen.discard(rid)
            continue
        info = bus.codec.decode(blob)
        current = _REMOTE.get(rid)
        if current is None or current.cluster_token != info["clusterToken"]:
            if current:
                _end_terms(current)
            current = _REMOTE[rid] = RemoteRunner(node, info)
        else:
            current.update(info)
        current.inventory_revision = reference["revision"]
    for rid in set(_REMOTE) - seen:
        _end_terms(_REMOTE.pop(rid))
    _DEVICES.clear()
    for state in peers.values():
        _DEVICES.update(state.get("devices", []))


def _end_terms(runner):
    for task in list(runner.term_subs):
        runner_hub.term_feed(runner, task, None)
    runner.term_subs.clear()


def remote_runners():
    return list(_REMOTE.values()) if bus.enabled and bus.healthy else []


def remote_devices():
    return set(_DEVICES) if bus.enabled and bus.healthy else set()


def _relay(node, runner, task, data):
    if _STOPPING or task not in runner.term_subs:
        return
    try:
        _RELAY.put_nowait((node, {"kind": "terminal", "runner": runner.id,
                                 "token": runner.cluster_token, "task": task, "data": data}))
    except asyncio.QueueFull:
        # Disconnecting forces the terminal to reopen from Runner state rather
        # than displaying a silently truncated byte stream.
        runner.term_subs.pop(task, None)
        job = asyncio.create_task(_close_relay(node, {"type": "event", "event": {
            "kind": "terminal", "runner": runner.id, "token": runner.cluster_token,
            "task": task, "data": None}}), name="cluster-terminal-close")
        _RELAY_CLOSE_JOBS.add(job)
        job.add_done_callback(_RELAY_CLOSE_JOBS.discard)


async def _close_relay(node, packet):
    try:
        await bus.send(node, packet)
    except Exception as exc:
        # Do not log terminal bytes or credentials from transport exceptions.
        log.warning("Cluster terminal close failed: %s", type(exc).__name__)
        try:
            await on_failure()
        except Exception as failure:
            log.warning("Cluster terminal recovery failed: %s", type(failure).__name__)


async def relay_loop():
    while True:
        node, event = await _RELAY.get()
        try:
            await bus.send(node, {"type": "event", "event": event})
        except Exception:
            await on_failure()
        finally:
            _RELAY.task_done()


async def on_request(method, payload, source):
    if method != "runner.call":
        raise ValueError("Unknown cluster method")
    runner = runner_hub._RUNNERS.get(payload["runner"])
    if runner is None or getattr(runner, "cluster_token", "") != payload.get("token"):
        return {"ok": False, "uncertain": False, "code": "RUNNER_OWNER_CHANGED"}
    if (runner.client_id != payload.get("client") or runner.org_id != payload.get("org")
            or str(getattr(runner, "owner_user_id", "") or "") != str(payload.get("owner") or "")):
        return {"ok": False, "uncertain": False, "code": "RUNNER_SCOPE_CHANGED"}
    await check_owner(runner)
    op, data = payload["op"], payload["data"]
    if op == "$policy":
        # Modes also serve embedded-client update draining. Personal governance
        # is separate and may only be refreshed from the durable authority.
        if getattr(runner, "owner_user_id", "") or getattr(runner, "management_state", ""):
            from ..automation_models import RunnerNode
            from ..db import SessionLocal
            async with SessionLocal() as session:
                row = await session.get(RunnerNode, runner.id)
                if row is None or str(row.owner_user_id or "") != runner.owner_user_id:
                    runner.dispatch_mode = "disabled"
                    return {"ok": False, "code": "RUNNER_SCOPE_CHANGED", "uncertain": False}
                runner.management_state = str(row.management_state or "")
                runner.dispatch_mode = ("disabled" if runner.management_state or
                                        row.auth_state == "revoked" else data["mode"])
        else:
            runner.dispatch_mode = data["mode"]
        return {"ok": True}
    if op == "$reserve":
        ok, token = runner.reserve_dispatch(data["key"])
        if ok:
            if not hasattr(runner, "_cluster_reservations"):
                runner._cluster_reservations = {}
            runner._cluster_reservations[token] = time.monotonic() + 300
        return {"ok": ok, "token": token}
    if op == "$release":
        runner.release_dispatch(data["token"])
        getattr(runner, "_cluster_reservations", {}).pop(data["token"], None)
        return {"ok": True}
    if op == "$accepted":
        runner.note_dispatch_accepted(bool(data.get("queued")))
        return {"ok": True}
    if op == "$close":
        await runner.ws.close(code=int(data.get("code", 1012)))
        return {"ok": True}
    if op == "$send":
        await runner.send(data)
        if data.get("op") in ("term.detach", "term.close"):
            runner.term_subs.pop(data.get("task", ""), None)
        return {"ok": True}
    if op == "term.open":
        task = str(data.get("task", ""))
        runner.term_subs[task] = lambda value: _relay(source, runner, task, value)
    result = await runner.call(op, data, min(300, float(payload.get("timeout", 60))))
    if op == "term.open" and not result.get("ok"):
        runner.term_subs.pop(str(data.get("task", "")), None)
    return result


async def on_event(event):
    from ..realtime import hub
    kind = event.get("kind")
    if kind == "model-runtime-capacity":
        from . import model_runtime
        model_runtime.wake_capacity_waiters(broadcast=False)
    elif kind == "publish":
        await hub.publish(event["device"], event["event"], _local=True, user_id=event.get("userId"))
    elif kind == "revoke":
        from .device_connections import disconnect
        await disconnect(event["device"], event.get("code", 4403), _local=True)
    elif kind == "terminal":
        runner = _REMOTE.get(event.get("runner"))
        if runner and runner.cluster_token == event.get("token"):
            runner_hub.term_feed(runner, event["task"], event.get("data"))


async def on_failure():
    # Fail closed on lost coordination. Reconnecting clients re-authenticate and
    # replay durable events. No stale online inventory may accept another task.
    from ..realtime import hub
    from . import live_view_cache
    live_view_cache.clear()
    _DEVICES.clear()
    for remote in list(_REMOTE.values()):
        _end_terms(remote)
    for device in list(hub._conns):
        await hub.close_device(device, 1012, _local=True)


async def start():
    global _RELAY_JOB, _STOPPING
    _STOPPING = False
    runner_hub.bind_loop()
    from . import ai_local
    ai_local._HUB_CLUSTER_MODE = bus.enabled
    bus.snapshot = snapshot
    bus.before_refresh = before_refresh
    bus.on_snapshot = on_snapshot
    bus.on_event = on_event
    bus.on_request = on_request
    bus.on_failure = on_failure
    await bus.start()
    if bus.enabled:
        _RELAY_JOB = asyncio.create_task(relay_loop(), name="cluster-terminal-relay")


async def stop():
    global _RELAY_JOB, _STOPPING
    _STOPPING = True
    jobs = list(_RELAY_CLOSE_JOBS)
    if _RELAY_JOB:
        jobs.append(_RELAY_JOB)
    for job in jobs:
        job.cancel()
    try:
        await asyncio.gather(*jobs, return_exceptions=True)
    finally:
        _RELAY_CLOSE_JOBS.difference_update(jobs)
        _RELAY_JOB = None
        # A fresh runtime must not replay bytes from stopped terminal sessions.
        while not _RELAY.empty():
            _RELAY.get_nowait()
            _RELAY.task_done()
        await bus.stop()
