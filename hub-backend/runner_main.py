# -*- coding: utf-8 -*-
"""Public module behavior and service contracts."""
from __future__ import annotations

import argparse
import asyncio
import contextvars
import json
import hashlib
import logging
import os
import platform
import re
import shutil
import socket
import sys
import threading
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import websockets  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("runner")

BEAT_S = 20
AGENT_REFRESH_S = 5 * 60
SKILL_REFRESH_S = 60
RETRY_S = 5
LOCAL_RPC_PREFIX = "@@SODUWORK_LOCAL_RPC@@"
MAX_CONCURRENT_LIMIT = 20
MAX_INFLIGHT_RPC = 256
from app.services.runner_release import RUNNER_VERSION
from app.services import runner_admission
from app.services.runner_node import _node_major, ensure_node_shim as _ensure_node_shim
from app.services.runner_handshake import HELLO_TIMEOUT_S, negotiate as _negotiate_hello
from app.services.runner_identity_error import RunnerIdentityConflict
from app.services import runner_connection_status


def _max_concurrent(value, default: int = 1) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = int(default or 1)
    return max(1, min(MAX_CONCURRENT_LIMIT, number))


def _configured_concurrency(cli_value, config: dict | None = None,
                            default: int = MAX_CONCURRENT_LIMIT) -> int:
    """Read the current concurrency limit, ignoring the legacy fixed maxConcurrent setting."""
    config = dict(config or {})
    return _max_concurrent(cli_value or config.get("concurrencyCeiling"), default)

# Open terminals on this Runner, indexed by task.
_TERMS: dict[str, object] = {}
_TERM_SUBS: dict[str, object] = {}


def _input_root(transfer: str) -> str:
    """Resolve one attachment-transfer directory; transfer IDs must be server-issued 32-character
    hexadecimal strings.
    """
    transfer = str(transfer or "")
    if not re.fullmatch(r"[0-9a-f]{32}", transfer):
        raise ValueError("附件传输号不合法")
    from app.services.local_base import _data_root
    return os.path.join(_data_root(), "runner-inputs", transfer)


async def _drop_input_transfer(transfer: str) -> None:
    """Validate and delete uploaded packet directories in a worker thread without blocking the
    Runner control channel.
    """
    try:
        root = _input_root(transfer)
    except ValueError:
        return
    await asyncio.to_thread(shutil.rmtree, root, True)


def _input_path(transfer: str, index: int) -> str:
    if index < 0 or index >= 20:
        raise ValueError("附件序号不合法")
    return os.path.join(_input_root(transfer), "%02d.bin" % index)


def _read_packet(packet: dict, label: str) -> list[tuple[dict, bytes]]:
    """Read one uploaded packet only after size and digest verification."""
    if not isinstance(packet, dict) or not packet.get("items"):
        return []
    transfer = str(packet.get("transfer") or "")
    items = list(packet.get("items") or [])
    if len(items) > 20:
        raise ValueError(f"{label}一次最多 20 个")
    out = []
    total = 0
    for meta in items:
        if not isinstance(meta, dict):
            raise ValueError(f"{label}条目格式不正确")
        # Enforce declared size limits before reading file contents.
        # Forged metadata must not trigger an unbounded memory read.
        declared = int(meta.get("size") or 0)
        name = str(meta.get("filename") or label)
        if declared < 0 or declared > 64 * 1024 * 1024 or total + declared > 128 * 1024 * 1024:
            raise ValueError(f"{label}过大：{name}")
        total += declared
        path = _input_path(transfer, int(meta.get("index") or 0))
        with open(path, "rb") as source:
            data = source.read()
        if len(data) != int(meta.get("size") or 0):
            raise ValueError(f"{label}大小校验失败：{name}")
        if hashlib.sha256(data).hexdigest() != str(meta.get("sha256") or ""):
            raise ValueError(f"{label}完整性校验失败：{name}")
        out.append((meta, data))
    return out


def _read_local_files(items, label: str) -> list[tuple[dict, bytes]]:
    """Read Electron-staged files for the private parent-process channel."""
    rows = list(items or [])
    if len(rows) > 20:
        raise ValueError(f"{label}\u4e00\u6b21\u6700\u591a 20 \u4e2a")
    out, total = [], 0
    for raw in rows:
        meta = dict(raw or {})
        source = os.path.realpath(os.path.abspath(str(meta.get("path") or "")))
        name = str(meta.get("filename") or os.path.basename(source) or label)[:240]
        if not source or not os.path.isabs(source) or not os.path.isfile(source):
            raise ValueError(f"{label}\u4e0d\u5b58\u5728\uff1a{name}")
        size = os.path.getsize(source)
        total += size
        if size > 64 * 1024 * 1024 or total > 128 * 1024 * 1024:
            raise ValueError(f"{label}\u8fc7\u5927\uff1a{name}")
        with open(source, "rb") as handle:
            data = handle.read()
        digest = str(meta.get("sha256") or "").lower()
        if digest and hashlib.sha256(data).hexdigest() != digest:
            raise ValueError(f"{label}\u5b8c\u6574\u6027\u6821\u9a8c\u5931\u8d25\uff1a{name}")
        meta.update(filename=name, size=len(data))
        out.append((meta, data))
    return out

def _with_bundled_shell(path_value: str, bundled_root: str,
                        which=shutil.which) -> str:
    """Add bundled PortableGit paths only when SODUWORK_BUNDLED_SHELL is configured and no usable
    bash exists. Preserve installed Git precedence; include bin, usr/bin, and cmd for the
    bundled shell and Git tools.
    """
    root = str(bundled_root or "").strip()
    if not root or not os.path.isfile(os.path.join(root, "bin", "bash.exe")):
        return path_value
    found = which("bash", path=path_value) or ""
    # System32 bash is a WSL launcher, not a usable native Windows task shell.
    # Treat it as unavailable for this path and use the bundled shell.
    wsl = "\\windows\\system32\\" in found.lower().replace("/", "\\")
    if found and not wsl:
        return path_value
    prepend = [os.path.join(root, "bin"), os.path.join(root, "usr", "bin"),
               os.path.join(root, "cmd")]
    return os.pathsep.join(prepend + ([path_value] if path_value else []))


def _runner_id(explicit: str) -> str:
    """Maintain one stable Runner ID per machine so restarts do not create ghost nodes or lose
    routing history.
    """
    if explicit:
        return explicit[:64]
    from app.services.local_base import _data_root
    d = _data_root()
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "runner-id")
    try:
        with open(p, encoding="utf-8") as f:
            v = f.read().strip()
        if v:
            return v
    except Exception:  # noqa: BLE001
        pass
    v = uuid.uuid4().hex[:12]
    try:
        with open(p, "w", encoding="utf-8") as f:
            f.write(v)
    except Exception:  # noqa: BLE001
        pass
    return v


def _agents() -> list[dict]:
    """Reuse local agent discovery to report installed runtime names and versions, excluding
    machine-local executable paths.
    """
    out = []
    try:
        from app.services import agent_setup
        for a in agent_setup.detect_all(has_model=True):
            if a.get("installed"):
                item = {"key": a["key"], "name": a["name"], "version": a.get("version", "")}
                # Include authentication state for runtimes with their own accounts.
                # This distinguishes installed-but-unauthenticated machines in administration.
                if a.get("auth"):
                    item["auth"] = a["auth"]
                out.append(item)
    except Exception as e:  # noqa: BLE001
        log.warning("探测本机 agent 失败: %s", type(e).__name__)
    return out


def _scan_skills() -> list[dict]:
    """Scan once per heartbeat; dispatches reuse this local-only catalog."""
    try:
        from app.services import skills
        return list(skills.scan())
    except Exception as exc:  # noqa: BLE001
        log.warning("探测本机 Skill 失败: %s", type(exc).__name__)
        return []


def _skill_names(catalog: list[dict] | None = None) -> list[str]:
    """Report available skill names only, without local paths, bodies, or resources."""
    source = _scan_skills() if catalog is None else catalog
    return sorted({str(item.get("name") or "")[:64]
                   for item in source if str(item.get("name") or "").strip()})[:200]


def _skill_report(catalog: list[dict] | None = None) -> list[dict]:
    """Report only provenance metadata; local paths and instructions stay local."""
    from app.services import skills
    source = _scan_skills() if catalog is None else catalog
    return [skills.runtime_public(item) for item in source
            if str(item.get("name") or "").strip()][:200]


def _capabilities(work_root: str, grants=None) -> dict:
    """Return conservative, substrate-neutral facts for scheduling and preflight."""
    from app.services import execution_capabilities
    return execution_capabilities.runtime_report(work_root, grants=grants)


def _capability_gate(work_root: str, required, grants=None) -> dict | None:
    """Re-probe immediately before a command-producing operation."""
    from app.services import execution_capabilities
    verdict = execution_capabilities.evaluate(_capabilities(work_root, grants), required)
    if verdict["ok"]:
        return None
    return {"ok": False, "error": execution_capabilities.error_message(
        verdict, socket.gethostname()), "capabilityPreflight": verdict}


def _busy_count() -> int:
    """Measure load from active AI jobs and subscribed interactive terminals, not terminals alone.

    """
    try:
        from app.services import ai_local
        with ai_local._LOCK:
            jobs = sum(1 for run in ai_local._RUNS.values() if run.get("state") == "running")
    except Exception:  # noqa: BLE001
        jobs = 0
    # Keep disconnected session PTYs available for reconnection.
    # Unsubscribed terminals do not count as active load; running AI jobs are counted separately.
    terms = sum(1 for task, t in _TERMS.items()
                if task in _TERM_SUBS and (t.info() or {}).get("alive"))
    try:
        from app.services import runner_deploy
        deployments = runner_deploy.busy()
    except Exception:  # noqa: BLE001
        deployments = 0
    try:
        from app.services import runner_quality
        quality = runner_quality.busy()
    except Exception:  # noqa: BLE001
        quality = 0
    return jobs + terms + deployments + quality


def _tags(value) -> list[str]:
    raw = value.split(",") if isinstance(value, str) else (value or [])
    out = []
    for item in raw:
        tag = str(item or "").strip().lower()[:40]
        if tag and tag not in out:
            out.append(tag)
    return out[:20]


class _Task:
    """Adapt the task dictionary to ai_local's attribute-based contract without importing database
    models into the Runner.
    """

    def __init__(self, d: dict):
        self.id = str(d.get("id") or "")
        self.title = str(d.get("title") or "")
        self.note = str(d.get("note") or "")
        self.result = str(d.get("result") or "")
        self.status = str(d.get("status") or "todo")
        self.priority = str(d.get("priority") or "normal")
        self.source = str(d.get("source") or "")
        self.created_by_name = str(d.get("createdByName") or "")
        self.acceptance_criteria = list(d.get("acceptanceCriteria") or [])


class _Repo:
    """Lightweight Runner-side repository object for workdirs.plan, independent of ORM models."""
    def __init__(self, d: dict):
        self.id = str(d.get("id") or "")
        self.name = str(d.get("name") or "")
        self.local_dir = str(d.get("localDir") or "")
        self.git_url = str(d.get("gitUrl") or "")
        self.default_branch = str(d.get("branch") or "")


def _localize_skills(ctx: dict, catalog: list[dict] | None = None) -> None:
    """Resolve skill names to this machine's bundled or user skill paths. Skip missing paths rather
    than passing invalid --skill arguments to the runtime.
    """
    incoming = [s for s in (ctx.get("skills") or []) if isinstance(s, dict)]
    if not incoming:
        return
    if catalog is None:
        from app.services import skills
        catalog = skills.scan()
    local = {s.get("name"): s for s in catalog if s.get("name")}
    mapped = []
    for item in incoming:
        path = str(item.get("path") or "")
        if path and os.path.isdir(path):
            mapped.append(item)
            continue
        hit = local.get(str(item.get("name") or ""))
        if hit:
            mapped.append({**item, "path": hit["path"], "root": hit.get("root", ""),
                           "dir": hit.get("dir", "")})
    ctx["skills"] = mapped


def _open_dir(path: str) -> None:
    """Open an execution's recorded directory on this machine, never a browser-supplied arbitrary
    path.
    """
    import subprocess
    if os.name == "nt":
        subprocess.run(["explorer", os.path.normpath(path)], capture_output=True, timeout=15)
    elif sys.platform == "darwin":
        subprocess.run(["open", path], capture_output=True, timeout=15)
    else:
        subprocess.run(["xdg-open", path], capture_output=True, timeout=15)


_NODE_READ_SCRIPT = r"""
const fs = require('fs');
const path = require('path');
const root = fs.realpathSync(process.argv[1]);
const file = fs.realpathSync(path.resolve(root, process.argv[2]));
const relative = path.relative(root, file);
if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
  throw new Error('产出文件不在本轮工作目录内');
}
const offset = Number(process.argv[3]);
const limit = Number(process.argv[4]);
const fd = fs.openSync(file, 'r');
try {
  const size = fs.fstatSync(fd).size;
  const buf = Buffer.alloc(Math.max(0, Math.min(limit, size - offset)));
  const count = buf.length ? fs.readSync(fd, buf, 0, buf.length, offset) : 0;
  process.stdout.write(JSON.stringify({size, count, b64: buf.subarray(0, count).toString('base64')}));
} finally {
  fs.closeSync(fd);
}
""".strip()


def _artifact_location(run: dict, att_id: str) -> tuple[str, str]:
    """Resolve paths textually without touching protected Windows file metadata in Python."""
    aid = str(att_id or "").replace("\\", "/")
    if aid.startswith("@bundle/"):
        name = aid[len("@bundle/"):]
        if not name or name != os.path.basename(name):
            return "", ""
        from app.services import ai_local
        return os.path.join(str(ai_local._STORE), str(run.get("ref") or ""), "bundles"), name
    if not aid or aid.startswith("/") or re.match(r"^[A-Za-z]:", aid):
        return "", ""
    parts = aid.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return "", ""
    root = str(run.get("ws") or "")
    return (root, os.path.join(*parts)) if root else ("", "")


def _run_snapshot(ai_local, ref: str) -> dict | None:
    """Bound runtime-state lock acquisition so a faulty worker cannot permanently block the
    WebSocket pump.
    """
    if not ai_local._LOCK.acquire(timeout=3):
        raise TimeoutError("Runner 内部会话状态锁超过 3 秒未释放")
    try:
        run = ai_local._RUNS.get(ref)
        return dict(run) if run else None
    finally:
        ai_local._LOCK.release()


_NODE_READ_AHEAD = 8 * 1024 * 1024   # Maximum bytes read by one Node subprocess.
_NODE_WINDOW_TTL_S = 10.0            # Read-window cache lifetime.
_NODE_WINDOW_MAX = 6                 # Maximum cached windows to bound memory use.
_NODE_WINDOWS: dict[tuple[str, str], tuple[float, int, int, bytes]] = {}
_NODE_WINDOW_LOCK = threading.Lock()


def _node_read_window(root: str, rel: str, offset: int, want: int) -> tuple[bytes, int]:
    """Read and cache a bounded file window through one Node subprocess. This supports
    process-authorized Windows decryption while avoiding one process launch per small sequential
    transfer chunk.
    """
    key = (root, rel)
    with _NODE_WINDOW_LOCK:
        cached = _NODE_WINDOWS.get(key)
    if cached is not None and time.monotonic() - cached[0] <= _NODE_WINDOW_TTL_S:
        _, total, start, data = cached
        if start <= offset < start + len(data):
            return data[offset - start:offset - start + want], total
    import base64
    import subprocess

    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        raise RuntimeError("这台执行机找不到 Node.js，无法读取受保护的产出文件")
    read_size = max(want, _NODE_READ_AHEAD)
    try:
        proc = subprocess.run(
            [node, "-e", _NODE_READ_SCRIPT, root, rel, str(offset), str(read_size)],
            capture_output=True, timeout=30, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired as e:
        raise TimeoutError("读取产出文件超过 30 秒，可能被本机透明加密策略拦截") from e
    if proc.returncode:
        detail = (proc.stderr or b"").decode("utf-8", "replace").strip()[-500:]
        raise OSError("Node 读取产出失败" + ("：" + detail if detail else ""))
    try:
        payload = json.loads((proc.stdout or b"").decode("utf-8"))
        total = max(0, int(payload.get("size") or 0))
        data = base64.b64decode(str(payload.get("b64") or ""))
    except Exception as e:  # noqa: BLE001
        raise OSError("Node 返回的产出分片格式不正确") from e
    if data:
        with _NODE_WINDOW_LOCK:
            _NODE_WINDOWS[key] = (time.monotonic(), total, offset, data)
            while len(_NODE_WINDOWS) > _NODE_WINDOW_MAX:
                _NODE_WINDOWS.pop(next(iter(_NODE_WINDOWS)))
    return data[:want], total


def _read_file_chunk(root: str, rel: str, offset: int, limit: int) -> dict:
    """Read a bounded artifact chunk. On Windows use a short-lived Node subprocess with a hard
    timeout for process-specific encryption policies; other platforms read directly.
    """
    if os.name == "nt":
        import base64

        data, total = _node_read_window(root, rel, offset, limit)
        return {"size": total, "count": len(data),
                "b64": base64.b64encode(data).decode("ascii") if data else ""}

    root_real = os.path.realpath(root)
    path = os.path.realpath(os.path.join(root_real, rel))
    try:
        inside = os.path.commonpath([root_real, path]) == root_real
    except ValueError:
        inside = False
    if not inside or not os.path.isfile(path):
        raise OSError("产出文件不在本轮工作目录内")
    size = os.path.getsize(path)
    if offset > size:
        raise ValueError("产出分片位置超出文件大小")
    with open(path, "rb") as f:
        f.seek(offset)
        chunk = f.read(limit)
    import base64
    return {
        "size": size, "count": len(chunk),
        "b64": base64.b64encode(chunk).decode("ascii"),
    }


class Runner:
    def __init__(self, hub: str, token: str, client_id: str, rid: str, work_root: str = "",
                 secret: str = "", tags: list[str] | None = None, key: str = "",
                 capability_grants=None, max_concurrent: int = MAX_CONCURRENT_LIMIT,
                 journal_runner_id: str = ""):
        base = str(hub or "").rstrip("/")
        # Retain the HTTP Hub base for personal-plugin MCP ticket exchange.
        self.http_base = ("https://" + base[len("wss://"):] if base.startswith("wss://")
                          else "http://" + base[len("ws://"):] if base.startswith("ws://")
                          else base)
        if base.startswith("https://"):
            base = "wss://" + base[len("https://"):]
        elif base.startswith("http://"):
            base = "ws://" + base[len("http://"):]
        self.url = base + "/api/v1/runner"
        self.client_id = client_id
        self.secret = secret
        self.token = token
        self.key = str(key or "")          # Prefer the standalone machine key over a legacy shared token.
        self.id = rid
        # A reconnect keeps this process identity; a restart changes it.
        # The Hub uses it to distinguish lost state from an authoritative negative ACK.
        self.boot_id = uuid.uuid4().hex
        self.work_root = str(work_root or "")
        self.tags = _tags(tags)
        self.capability_grants = capability_grants
        # This is a safety ceiling, not a number users need to tune.  The actual launch
        # budget is continuously derived from CPU and available memory.
        self.concurrency_ceiling = _max_concurrent(max_concurrent, MAX_CONCURRENT_LIMIT)
        self.max_concurrent = self.concurrency_ceiling
        self._resource_budget = runner_admission.AdaptiveResourceBudget(
            ceiling=self.concurrency_ceiling)
        self._resource_snapshot = runner_admission.ResourceSnapshot(
            limit=self.concurrency_ceiling, cpu_count=max(1, os.cpu_count() or 1))
        from app.services.local_base import _data_root
        from app.services.runner_admission_journal import Journal
        from app.services.runner_event_outbox import Outbox
        self._event_outbox = Outbox(os.path.join(_data_root(), "runner-events"),
                                   self.url + "|" + self.id + "|" + self.client_id)
        self._session_ack = None
        self._delivery_attempts = {}
        self._outbox_blocked = self._event_outbox.at_capacity()
        self._admission = runner_admission.AdmissionQueue(
            task_capacity=runner_admission.DEFAULT_TASK_CAPACITY,
            journal=Journal(os.path.join(_data_root(), "runner-queue"),
                            self.url + "|" + (journal_runner_id or self.id) + "|" + self.client_id,
                            exclusive=True))
        self._admission_wake = asyncio.Event()
        self._admission_task = None
        self._admission_workers: set[asyncio.Task] = set()
        self.ws = None
        self.loop = None
        # The desktop client owns this Runner process. A shutdown signal lets
        # the client release the Runner identity cleanly before it replaces or
        # closes the process wrapper on Windows.
        self._shutdown_event = asyncio.Event()
        self.bin = False       # Binary-frame capability negotiated again on every connection.
        # Heartbeats, live session pushes and RPC replies share one WebSocket. Keep
        # frames ordered so a busy Runner cannot corrupt or starve its control channel.
        self._send_lock = asyncio.Lock()
        # Serialize heartbeat and live-event snapshot collection.
        # Concurrent collection would send duplicate deltas unnecessarily.
        self._snap_lock = asyncio.Lock()
        # A long workspace clone must not block status/stop/probe messages. Each RPC is
        # handled in its own bounded task and keeps the socket generation it arrived on.
        self._rpc_tasks: set[asyncio.Task] = set()
        self._send_target = contextvars.ContextVar(
            "soduwork_runner_send_target_%s" % self.id, default=None)
        # Collection cursors move only with the disk outbox transaction. They
        # are distinct from the Hub's durable delivery/event ACK watermarks.
        self._session_marks: dict[str, tuple[int, str]] = self._event_outbox.marks()
        self._deployment_marks: dict[str, int] = {}
        # Refs accepted by this process but not durable in ai_local._RUNS yet.
        # This protects slow workspace/skill preflight from a false "not started" result.
        self._dispatching_refs: set[str] = set()
        # A slow workspace/plugin preflight must not block the websocket control plane.
        # Keep strong references until background dispatch handlers finish.
        self._dispatch_tasks: set[asyncio.Task] = set()
        # CLI probing can launch commands, so refresh only during connection or heartbeat work.
        # Frequent live snapshots read the cached inventory.
        self._agent_inventory: list[dict] = []
        self._skill_inventory: list[str] = []
        self._skill_catalog: list[dict] = []
        self._skill_inventory_at = 0.0
        self._agent_inventory_at = 0.0
        self._agent_refresh_lock = asyncio.Lock()
        self._skill_refresh_lock = asyncio.Lock()
        # Refresh inventory once when an installation job completes and immediately send a heartbeat.
        # Do not leave scheduling unaware of a successfully installed runtime until the next periodic heartbeat.
        self._refreshed_agent_jobs: set[str] = set()

    # Hub connection lifecycle.
    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        self._ensure_admission_loop()
        from app.services import pty_term
        self._term_sweep = asyncio.create_task(pty_term.sweep_loop())
        # Electron owns stdin/stdout and exposes only a narrow local RPC
        # whitelist. New conversation therefore reuses the exact task runtime
        # without an avoidable Hub round trip.
        self._local_rpc_task = asyncio.create_task(self._local_rpc_loop())
        if hasattr(self, "_event_outbox"):
            # Continue collecting while disconnected; terminal packets remain
            # independently replayable even after native archive cleanup.
            self._telemetry_task = asyncio.create_task(self._capture_loop())
        # Admission reclaims native archives before launching any durable queue
        # item, so a surviving child process cannot race a replacement launch.
        while not self._shutdown_event.is_set():
            try:
                runner_connection_status.report(self, "connecting")
                headers = {}
                if self.client_id and self.secret:
                    headers.update({"X-Soduwork-Device": self.client_id, "X-Soduwork-Secret": self.secret})
                if self.key and self.id:
                    # Send machine identity with its key; Hub verifies it matches the hello identity.
                    headers.update({"X-SoduWork-Runner-Id": self.id,
                                    "X-SoduWork-Runner-Key": self.key})
                if self.token:
                    headers["X-SoduWork-Runner-Token"] = self.token
                async with websockets.connect(self.url, max_size=8 * 1024 * 1024,
                                              additional_headers=headers, proxy=None) as ws:
                    self.ws = ws
                    prefetched = await self._hello()
                    # Open the control channel before scanning local CLIs/Skills. A large
                    # or temporarily locked skill root must not make this Runner look offline.
                    initial = asyncio.create_task(self._report_beat())

                    beat = asyncio.create_task(self._beat())
                    push = asyncio.create_task(self._push_loop())
                    try:
                        await self._pump(prefetched)
                    finally:
                        for job in (initial, beat, push):
                            job.cancel()
                        await asyncio.gather(initial, beat, push, return_exceptions=True)
            except RunnerIdentityConflict:
                runner_connection_status.report(self, "error", "IDENTITY_CONFLICT")
                scope = getattr(self, "desktop_identity_scope", None)
                if scope:
                    from app.services.runner_desktop_identity import select
                    try:
                        select(*scope, rejected_id=self.id)
                    except OSError:
                        runner_connection_status.report(self, "error", "IDENTITY_STORAGE_FAILED")
                        raise
                    except ValueError:
                        runner_connection_status.report(self, "error", "IDENTITY_RECOVERY_FAILED")
                        raise
                    log.warning("本机执行机身份已恢复，等待客户端重新连接")
                    self._shutdown_event.set()
                    return
                log.warning("执行机身份冲突，请检查独立执行机的登记配置")
            except Exception as e:  # noqa: BLE001
                runner_connection_status.report(self, "error", runner_connection_status.error_code(e))
                log.warning("连不上后台（%s: %s），%d 秒后重试",
                            type(e).__name__, str(e)[:100], RETRY_S)
            self.ws = None
            if self._shutdown_event.is_set():
                break
            # Keep terminals alive across connection loss for later reattachment.
            try:
                await asyncio.wait_for(self._shutdown_event.wait(), RETRY_S)
            except asyncio.TimeoutError:
                pass

    async def _local_rpc_loop(self) -> None:
        """Serve one-line JSON RPC from the parent Electron process only."""
        from app.services.runner_lifecycle import parent_lines
        async for line in parent_lines(sys.stdin.buffer):
            if not line:
                if getattr(self, "desktop_owned", False):
                    self._shutdown_event.set()
                return
            try:
                text = line.decode("utf-8", "replace").rstrip("\r\n")
            except Exception:  # noqa: BLE001
                continue
            if not text.startswith(LOCAL_RPC_PREFIX):
                continue
            rpc_id = ""
            try:
                request = json.loads(text[len(LOCAL_RPC_PREFIX):])
                rpc_id = str(request.get("id") or "")[:80]
                result = await self._local_rpc_dispatch(dict(request.get("message") or {}))
                reply = {"id": rpc_id, "ok": True, "result": result}
            except Exception as exc:  # noqa: BLE001
                reply = {"id": rpc_id, "ok": False,
                         "error": str(exc)[:600] or type(exc).__name__}
            blob = LOCAL_RPC_PREFIX + json.dumps(
                reply, ensure_ascii=False, separators=(",", ":")) + "\n"
            try:
                await asyncio.to_thread(self._write_local_rpc, blob)
            except Exception:  # noqa: BLE001
                return

    @staticmethod
    def _write_local_rpc(blob: str) -> None:
        sys.stdout.buffer.write(blob.encode("utf-8"))
        sys.stdout.buffer.flush()

    async def _conversation_content_store(self, realm):
        import re
        if not isinstance(realm, str) or not re.fullmatch(r"[a-f0-9]{64}", realm):
            raise ValueError("Invalid local content realm")
        if not hasattr(self, "_content_init_lock"):
            self._content_init_lock = asyncio.Lock()
            self._content_stores = {}
        async with self._content_init_lock:
            if realm not in self._content_stores:
                from app.services.runner_content_store import Store
                from app.services.local_base import _data_root
                self._content_stores[realm] = await asyncio.to_thread(Store,
                    os.path.join(_data_root(), "conversation-content", realm))
            return self._content_stores[realm]

    async def _local_rpc_dispatch(self, message: dict) -> dict:
        if message.get("op") == "runtime.content.read":
            store = await self._conversation_content_store(message.get("realm"))
            return await asyncio.to_thread(store.handle, {**message, "op": "content.read"})
        op = str(message.get("op") or "")
        if op == "desktop.capability.reply":
            bridge = getattr(self, "_desktop_capabilities", None)
            return bridge.reply(message) if bridge else {"ok": False}
        if op == "runtime.catalog.apply":
            from app.services import custom_agent_catalog
            try:
                result = custom_agent_catalog.apply(message.get("agents"))
            except (ValueError, TypeError) as exc:
                return {"ok": False, "error": str(exc), "code": "INVALID_CUSTOM_AGENT"}
            # Registration itself never executes software. The normal inventory
            # refresh performs discovery later and reports it to the Hub.
            self._agent_inventory_at = 0
            return {"ok": True, "data": result}
        if op == "runtime.ping":
            return {"ok": True, "data": {"version": RUNNER_VERSION, "pid": os.getpid()}}
        if op == "runtime.detect":
            from app.services import agent_setup
            key = str(message.get("key") or "")
            if key not in agent_setup._SPECS:
                return {"ok": False, "error": "\u4e0d\u8ba4\u8bc6\u7684\u6267\u884c\u5e95\u5ea7\uff1a" + key}
            item = await asyncio.to_thread(agent_setup.detect, key, has_model=True)
            from app.services import access_policy
            item["accessControl"] = access_policy.capability(key)
            return {"ok": True, "data": item}
        if op == "runtime.sessions":
            from app.services import ai_local
            return {"ok": True, "data": await asyncio.to_thread(
                ai_local.console_list_sync, {}, None)}
        if op == "runtime.session.forget":
            from app.services import local_stream
            ref = str((message.get("data") or {}).get("ref") or message.get("ref") or "")
            if not ref:
                return {"ok": False, "error": "没有指定要移除的会话"}
            return {"ok": True, "data": await asyncio.to_thread(
                local_stream.forget_sync, {}, ref)}
        if op == "runtime.shutdown":
            self._shutdown_event.set()
            ws = self.ws
            if ws is not None:
                try:
                    await ws.close(code=1000, reason="desktop client stopped")
                except Exception:  # noqa: BLE001 - shutdown is best effort
                    pass
            return {"ok": True}
        allowed = {
            "job.dispatch", "job.has", "job.status", "job.info", "job.session",
            "job.open_dir", "job.stop", "job.comment", "job.authorize", "job.permission", "job.access",
        }
        if op not in allowed:
            return {"ok": False, "error": "\u672c\u673a\u63a7\u5236\u901a\u9053\u4e0d\u5141\u8bb8\u8fd9\u4e2a\u64cd\u4f5c"}
        local_message = dict(message)
        local_message["_localParent"] = True
        return await self._job(local_message)

    def _ensure_admission_loop(self) -> None:
        if self._admission_task is not None and not self._admission_task.done():
            return
        self._admission_task = asyncio.create_task(self._admission_loop())

    @staticmethod
    async def _drop_message_transfers(message, keep: set[str] | None = None) -> None:
        """Delete only uploaded Runner packets, preserving user-owned parent file paths. Perform
        directory deletion in a worker so large packets do not block the event loop.
        """
        payload = dict(message or {})
        preserved = {str(item) for item in (keep or set()) if str(item)}
        for packet in (payload.get("files"), payload.get("skills")):
            transfer = str((packet or {}).get("transfer") or "") if isinstance(packet, dict) else ""
            if not transfer or transfer in preserved:
                continue
            await _drop_input_transfer(transfer)

    def _reap_admission(self) -> None:
        """Fold real Agent terminal states back into the admission ledger."""
        from app.services import ai_local
        with ai_local._LOCK:
            states = {ref: str(run.get("state") or "")
                      for ref, run in ai_local._RUNS.items()}
        for item in self._admission.active_items():
            if item.state != "running":
                continue
            state = states.get(item.ref)
            if state == "running":
                continue
            if state == "done":
                self._admission.finish(item.key, "completed")
            elif state in {"interrupted", "stopped", "cancelled", "canceled"}:
                self._admission.finish(item.key, "cancelled")
            elif state:
                self._admission.finish(item.key, "failed")
            elif time.time() - item.started_at > 10:
                self._admission.finish(item.key, "failed",
                                       "\u6267\u884c\u8fdb\u7a0b\u6ca1\u6709\u767b\u8bb0\u6210\u529f")

    def _admission_report(self, force: bool = False) -> dict:
        self._resource_snapshot = self._resource_budget.snapshot(force=force)
        self.max_concurrent = self._resource_snapshot.limit
        return {
            "busy": _busy_count(),
            "maxConcurrent": self.max_concurrent,
            "concurrencyCeiling": self.concurrency_ceiling,
            **self._admission.metrics(),
            **self._resource_snapshot.public(),
        }

    async def _stop_admitted(self, item) -> None:
        """Retain ownership until the native executor acknowledges its stop."""
        from app.services import local_stream
        try:
            stopped = await asyncio.to_thread(local_stream.stop_sync, {}, item.ref)
        except Exception as exc:  # noqa: BLE001
            log.warning("admitted stop failed for %s: %s", item.ref, exc)
            return
        if stopped.get("ok"):
            self._admission.finish(item.key, "cancelled")
        else:
            # Keep running/cancel_requested in the durable ledger. The real
            # terminal state or a later stop retry is authoritative; a refusal
            # must not free this session's lane while its process still runs.
            log.warning("admitted stop not acknowledged for %s: %s",
                        item.ref, stopped.get("error") or "unknown native state")

    async def _run_admitted(self, item) -> None:
        payload = dict(item.payload or {})
        payload["_admitted"] = True
        payload["_admissionKey"] = item.key
        try:
            result = await self._job(payload)
        except Exception as exc:  # noqa: BLE001
            result = {"ok": False, "error": str(exc)[:1000] or type(exc).__name__}
        if result.get("ok"):
            self._admission.mark_running(item.key, dict(result.get("data") or {}))
            if item.cancel_requested:
                await self._stop_admitted(item)
        else:
            self._admission.finish(
                item.key, "cancelled" if item.cancel_requested else "failed",
                str(result.get("error") or "Agent launch failed"), result)
        self._admission_wake.set()

    async def _admission_loop(self) -> None:
        from app.services import ai_local
        await asyncio.to_thread(ai_local.reclaim)
        with ai_local._LOCK:
            recovered = {ref: dict(run) for ref, run in ai_local._RUNS.items()}
        self._admission.recover(recovered)
        for item in self._admission.active_items():
            if item.cancel_requested and item.state == "running":
                await self._stop_admitted(item)
        while True:
            self._reap_admission()
            resource = self._resource_budget.snapshot()
            self._resource_snapshot = resource
            self.max_concurrent = resource.limit
            while True:
                from app.services import ai_local
                with ai_local._LOCK:
                    running_refs = {ref for ref, run in ai_local._RUNS.items()
                                    if run.get("state") == "running"}
                active = _busy_count() + self._admission.starting_count()
                item = self._admission.claim_next(
                    active, resource.limit,
                    resource.can_start and not getattr(self, "_outbox_blocked", False),
                    blocked_refs=running_refs)
                if item is None:
                    break
                task = asyncio.create_task(self._run_admitted(item))
                self._admission_workers.add(task)
                task.add_done_callback(self._admission_workers.discard)
            self._admission_wake.clear()
            try:
                async with asyncio.timeout(0.75):
                    await self._admission_wake.wait()
            except asyncio.TimeoutError:
                pass

    async def _admit(self, message: dict, *, key: str, ref: str,
                     category: str, operation: str) -> dict:
        try:
            accepted, reason, item = self._admission.submit(
                key, ref, category, operation, message)
        except (OSError, ValueError):
            # An atomic replace may have succeeded before a later disk error.
            # Do not ACK or drop inputs, and never invite a duplicate send.
            import traceback as _tb
            log.error("RUNNER_QUEUE_STORAGE diagnostic:\n" + _tb.format_exc())
            return {"ok": False, "uncertain": True, "code": "RUNNER_QUEUE_STORAGE",
                    "error": "执行机未能确认队列已安全保存，请检查磁盘后核对回执，不要重复发送"}
        if not accepted:
            metrics = self._admission.metrics()
            await self._drop_message_transfers(message)
            return {
                "ok": False, "code": "RUNNER_QUEUE_FULL", "retryable": True,
                "error": "\u6267\u884c\u673a\u540e\u53f0\u961f\u5217\u5df2\u6ee1\uff08100/100\uff09\uff0c\u8bf7\u7b49\u5f85\u5df2\u6709\u4efb\u52a1\u5b8c\u6210",
                "data": metrics,
            }
        if reason == "duplicate":
            original = dict(item.payload or {})
            keep = {
                str((packet or {}).get("transfer") or "")
                for packet in (original.get("files"), original.get("skills"))
                if isinstance(packet, dict) and packet.get("transfer")
            }
            await self._drop_message_transfers(message, keep)
        self._ensure_admission_loop()
        self._admission_wake.set()
        # Let an idle scheduler claim the item, but never wait for preflight or launch.
        await asyncio.sleep(0)
        return {"ok": True, "data": self._admission.receipt(
            item, duplicate=reason == "duplicate")}

    async def _send_raw(self, payload) -> None:
        ws = self._send_target.get() or self.ws
        if ws is None:
            raise ConnectionError("尚未连接")
        async with self._send_lock:
            async with asyncio.timeout(30):
                await ws.send(payload)

    async def _send(self, msg: dict) -> None:
        try:
            await self._send_raw(json.dumps(msg, ensure_ascii=False))
        except Exception:  # noqa: BLE001
            pass

    async def _send_frame(self, kind: int, meta: dict, payload: bytes) -> None:
        """Handle a binary frame only after bin1 negotiation succeeds."""
        ws = self.ws
        if ws is None:
            return
        try:
            from app.services import ws_frames
            await self._send_raw(ws_frames.encode(kind, meta, payload))
        except Exception:  # noqa: BLE001
            pass

    async def _hello(self) -> list[dict]:
        from app.services import ws_frames
        admission = self._admission_report(force=True)
        payload = {
            "op": "hello", "runnerId": self.id, "clientId": self.client_id,
            "bootId": self.boot_id,
            "host": socket.gethostname(), "os": platform.platform()[:60],
            "version": RUNNER_VERSION, "agents": self._agent_inventory,
            # Do not block initial control-channel connection on CLI discovery.
            # Report whether the inventory is scanned so pending-empty and confirmed-empty states remain distinct.
            "inventoryReady": self._agent_inventory_at > 0,
            "workRoot": self.work_root,
            **admission,
            "skills": self._skill_inventory,
            "skillCatalog": _skill_report(self._skill_catalog),
            "tags": self.tags, "caps": [ws_frames.CAP_BIN1, "handoff1", "executionSelection1", "sessionAck1", "turnFiles1", "turnSkills1", "conversationContent1"],
        }
        if getattr(self, "desktop_owned", False):
            payload["caps"].append("desktopCapabilities1")
            payload["caps"].extend(["desktopPluginTurn1", "desktopPluginStart1"])
            payload["caps"].append("desktopLibrary1")
            payload["caps"].append("desktopHistory1")
        if getattr(getattr(self, "_admission", None), "_journal", None) is not None:
            payload["caps"].append("admit1")
        message, prefetched = await _negotiate_hello(
            self.ws, self._send_raw, payload, timeout=HELLO_TIMEOUT_S)
        self.bin = ws_frames.CAP_BIN1 in (message.get("caps") or [])
        self._session_ack = "sessionAck1" in (message.get("caps") or [])
        self._delivery_attempts = {}
        self._legacy_delivery_cursor = 0
        if self._session_ack and hasattr(self, "_event_outbox"):
            async with self._snap_lock:
                self._session_marks = await asyncio.to_thread(self._event_outbox.marks)
        runner_connection_status.report(self, "online")
        log.info("已上线：%s%s", json.dumps(message, ensure_ascii=False)[:160],
                 "（二进制帧）" if self.bin else "")
        return prefetched

    async def _beat(self) -> None:
        while True:
            await asyncio.sleep(BEAT_S)
            await self._report_beat()

    async def _refresh_agents(self, force: bool = False) -> None:
        """Reuse CLI and skill discovery caches for immediate status reports."""
        now = time.monotonic()
        stale = (force or self._agent_inventory_at <= 0 or
                 now - self._agent_inventory_at >= AGENT_REFRESH_S)
        if not stale:
            return
        async with self._agent_refresh_lock:
            now = time.monotonic()
            stale = (force or self._agent_inventory_at <= 0 or
                     now - self._agent_inventory_at >= AGENT_REFRESH_S)
            if not stale:
                return
            try:
                agents, catalog = await asyncio.gather(
                    asyncio.to_thread(_agents), asyncio.to_thread(_scan_skills))
            except Exception as exc:  # noqa: BLE001 - inventory must not kill control plane
                self._agent_inventory_at = time.monotonic()
                log.warning("刷新 Agent 清单失败：%s", type(exc).__name__)
                return
            self._agent_inventory = agents
            self._skill_catalog, self._skill_inventory = catalog, _skill_names(catalog)
            self._skill_inventory_at = time.monotonic()
            self._agent_inventory_at = time.monotonic()

    async def _refresh_skills(self, force: bool = False) -> None:
        """Refresh only Skill roots; never rerun slow CLI/auth detection."""
        now = time.monotonic()
        if not (force or self._skill_inventory_at <= 0 or
                now - self._skill_inventory_at >= SKILL_REFRESH_S):
            return
        async with self._skill_refresh_lock:
            now = time.monotonic()
            if not (force or self._skill_inventory_at <= 0 or
                    now - self._skill_inventory_at >= SKILL_REFRESH_S):
                return
            try:
                catalog = await asyncio.to_thread(_scan_skills)
                self._skill_catalog = catalog
                self._skill_inventory = _skill_names(catalog)
            except Exception as exc:  # noqa: BLE001
                log.warning("刷新 Skill 清单失败：%s", type(exc).__name__)
            finally:
                self._skill_inventory_at = time.monotonic()

    async def _report_beat(self) -> None:
        await self._refresh_agents()
        await self._refresh_skills()
        # Capability discovery launches bounded local version probes. Keep those probes
        # out of both the hello deadline and the event loop; the first post-welcome
        # heartbeat supplies the authoritative report while the Hub fails closed.
        capabilities = await asyncio.to_thread(
            _capabilities, self.work_root, self.capability_grants)
        admission = self._admission_report()
        async with self._snap_lock:
            if getattr(self, "_session_ack", False):
                sessions, advances = [], []
            else:
                sessions, advances = await asyncio.to_thread(self._session_snapshots)
            await self._send_strict({"op": "beat", **admission,
                              "agents": self._agent_inventory,
                              "skills": self._skill_inventory,
                              "skillCatalog": _skill_report(self._skill_catalog),
                              "capabilities": capabilities,
                              "workRoot": self.work_root, "tags": self.tags,
                              "sessions": sessions})
            self._apply_marks(advances)

    async def _capture_loop(self) -> None:
        """Retain transport facts without depending on a live control channel."""
        while not self._shutdown_event.is_set():
            try:
                if self._session_ack is not False:
                    await self._capture_sessions()
            except Exception as exc:  # storage failure must not acknowledge or launch new work
                self._outbox_blocked = True
                log.warning("Runner event retention paused: %s", type(exc).__name__)
            await asyncio.sleep(0.5 if not self._outbox_blocked else 5)

    async def _capture_sessions(self) -> None:
        async with self._snap_lock:
            sessions, advances = await asyncio.to_thread(self._session_snapshots)
            stored = False
            for snapshot, mark in zip(sessions, advances):
                if not snapshot.get("taskId"):
                    continue
                await asyncio.to_thread(self._event_outbox.append, snapshot, mark)
                self._apply_marks([mark])
                stored = True
            if stored:
                self._outbox_blocked = await asyncio.to_thread(self._event_outbox.at_capacity)

    async def _deliver_sessions(self) -> None:
        """Retain packets until ACK; replay every packet on legacy connections."""
        if self._session_ack:
            packets = [(None, packet) for packet in await asyncio.to_thread(
                self._event_outbox.pending, 12, getattr(self, "_delivery_after_ref", ""))]
        else:
            packets = await asyncio.to_thread(self._event_outbox.replay_pending, 12,
                                               getattr(self, "_legacy_delivery_cursor", 0))
        now = time.monotonic()
        for replay_cursor, packet in packets:
            # A rejected or temporarily forbidden historical ref cannot starve
            # later sessions behind the first bounded transmission window.
            if self._session_ack:
                self._delivery_after_ref = packet["ref"]
            else:
                self._legacy_delivery_cursor = replay_cursor
            key = (packet["streamId"], packet["deliverySeq"])
            attempt, retry_at = self._delivery_attempts.get(key, (0, 0))
            if now < retry_at:
                continue
            self._delivery_attempts[key] = (attempt + 1, now + min(30, 2 ** min(attempt + 1, 5)))
            if self._session_ack:
                await self._send_strict({"op": "session.deliver", "version": 1,
                                        "runnerId": self.id, "bootId": self.boot_id, **packet})
            else:
                # Legacy Hubs can display retained facts but cannot authorize
                # their deletion from the durable outbox.
                await self._send_strict({"op": "session.event", "sessions": [packet["snapshot"]]})

    async def _push_loop(self) -> None:
        """Deliver durable session packets and retain the legacy deployment path."""
        while True:
            await asyncio.sleep(0.5)
            try:
                if hasattr(self, "_event_outbox"):
                    await self._deliver_sessions()
                async with self._snap_lock:
                    if getattr(self, "_session_ack", False):
                        sessions, advances = [], []
                    else:
                        sessions, advances = await asyncio.to_thread(self._session_snapshots)
                    from app.services import runner_deploy
                    deployments, deployment_advances = await asyncio.to_thread(
                        runner_deploy.snapshots, self._deployment_marks)
                    if not sessions and not deployments:
                        continue
                    await self._send_strict({"op": "session.event", "sessions": sessions,
                                             "deployments": deployments})
                    self._apply_marks(advances)
                    for run_id, rev in deployment_advances:
                        self._deployment_marks[run_id] = rev
            except Exception:  # noqa: BLE001 - Keep marks unchanged on disconnect so reconnect can resend.
                pass

    async def _send_strict(self, msg: dict) -> None:
        """Propagate transport failure; sending alone never acknowledges durable packets."""
        await self._send_raw(json.dumps(msg, ensure_ascii=False))

    def _apply_marks(self, advances: list) -> None:
        """Advance collection cursors after disk append, or legacy send on old Hubs."""
        for ref, seq, state in advances:
            self._session_marks[ref] = (seq, state)
            if not hasattr(self, "_session_collected_at"):
                self._session_collected_at = {}
            self._session_collected_at[ref] = time.monotonic()

    def _session_snapshots(self) -> tuple[list[dict], list[tuple]]:
        """Collect bounded archived-session deltas for heartbeat or live push, prioritizing active
        sessions fairly. Return proposed cursors without advancing them; reliable
        delivery commits each cursor atomically with its disk packet.
        """
        from app.services import ai_local

        runs = list((ai_local.console_list_sync({}, None) or {}).get("runs") or [])
        agents = {str(item.get("key") or ""): item for item in self._agent_inventory}
        collected = getattr(self, "_session_collected_at", {})
        runs.sort(key=lambda x: (collected.get(str(x.get("ref") or ""), 0),
                                 x.get("state") != "running", -(x.get("started") or 0)))
        out: list[dict] = []
        advances: list[tuple] = []
        for run in runs:
            # Native-only conversations have no Hub execution to authorize.
            # They must not consume the bounded collection window forever.
            if not run.get("taskId"):
                continue
            if len(out) >= 12:
                break
            ref = str(run.get("ref") or "")
            if not ref:
                continue
            state, seq = str(run.get("state") or ""), int(run.get("seq") or 0)
            # A silent Agent launch changes neither output sequence nor state
            # (preflight may already say running). Report its marker once too.
            state_mark = ":".join((state, str(run.get("executionStartedAt") or 0),
                                   str(run.get("round") or 1), str(run.get("admissionKey") or "")))
            cli = str(run.get("cli") or "")
            agent = agents.get(cli) or {}
            last_seq, last_state = self._session_marks.get(ref, (0, ""))
            if seq <= last_seq and state_mark == last_state:
                continue
            live = ai_local.session_sync({}, ref, last_seq, 300)
            state = str(live.get("status") or live.get("state") or state)
            seq = int(live.get("seq") or seq)
            items = []
            item_bytes = 0
            for item in (live.get("items") or []):
                if not isinstance(item, dict):
                    continue
                # Bound workbench events rather than storing complete files or oversized model responses in server replay.
                clean = {"seq": int(item.get("seq") or 0),
                         "kind": str(item.get("kind") or "out")[:32],
                         "tool": str(item.get("tool") or "")[:120],
                         "text": str(item.get("text") or "")[:50000 if item.get("streamId") else 4000],
                         "at": str(item.get("at") or "")[:64],
                         "seg": int(item.get("seg") or 0)}
                if item.get("full"):
                    full = str(item["full"])
                    full_limit = 20000 if clean["kind"] == "say" else 4000
                    clean["full"] = full[:full_limit]
                    if clean["kind"] == "say" and len(full) > full_limit:
                        clean["textTruncated"] = True
                if clean["kind"] == "say" and len(str(item.get("text") or "")) > len(clean["text"]):
                    clean["textTruncated"] = True
                source_id = item.get("_sourceId") or item.get("sourceId")
                if source_id:
                    clean["sourceId"] = str(source_id)[:360]
                round_no = item.get("_round") or item.get("round")
                if round_no is not None:
                    try:
                        clean["round"] = max(1, int(round_no or 1))
                    except (TypeError, ValueError):
                        pass
                from app.services.runtime_messages import public_fields
                clean.update(public_fields(item))
                from app.services.runner_event_outbox import snapshot_bytes
                size = len(snapshot_bytes(clean))
                if item_bytes + size > 384 * 1024:
                    break
                items.append(clean)
                item_bytes += size
            sent_seq = int(items[-1]["seq"]) if items else last_seq
            out.append({
                "ref": ref, "taskId": run.get("taskId") or "", "title": run.get("title") or "",
                "cli": cli, "cliName": run.get("cliName") or agent.get("name") or cli,
                "cliVersion": agent.get("version") or "",
                "cliSessionId": run.get("cliSid") or "", "runnerVersion": RUNNER_VERSION,
                "state": state, "status": state,
                "seq": seq, "items": items, "started": run.get("started") or 0,
                "executionStartedAt": run.get("executionStartedAt") or 0,
                "ended": run.get("ended") or 0, "workDir": run.get("workDir") or "",
                "segment": live.get("segment") or run.get("segment") or 1,
                "round": live.get("round") or run.get("round") or 1,
                "admissionKey": live.get("admissionKey") or "", "admissionStartSeq": live.get("admissionStartSeq"),
                "turnCorrelationVersion": 1,
                "detached": bool(run.get("detached")),
                "tokens": dict(run.get("tokens") or {}), "ctxPct": run.get("ctxPct") or 0,
                # Include cumulative usage, first-start time, and selected model.
                # Model identity is required for model-specific usage and cost attribution.
                "usage": dict(run.get("usage") or {}),
                "firstStarted": run.get("firstStarted") or run.get("started") or 0,
                "model": run.get("model") or "",
                "reasoningEffort": (live.get("activeExecutionSelection") or {}).get("reasoningEffort", ""),
                "ctxWindow": run.get("ctxWindow") or 0,
                "ctxWindowKnown": bool(run.get("ctxWindowKnown")), "error": run.get("error") or "",
                "failureKind": run.get("failureKind") or "",
                "failurePath": run.get("failurePath") or "",
            })
            # Advance only through events actually sent; leave state pending while a backlog remains.
            more = sent_seq < seq
            advances.append((ref, sent_seq, last_state if more else state_mark))
        return out, advances

    async def _handle_message(self, message: dict, connection=None) -> None:
        """Handle one Hub command and reply on the socket generation that received it."""
        token = self._send_target.set(connection) if connection is not None else None
        try:
            await self._on(message)
        except Exception as exc:  # noqa: BLE001
            log.exception("处理 %s 失败", message.get("op"))
            if message.get("id"):
                await self._send({
                    "op": "reply", "id": message["id"], "ok": False,
                    "error": "%s: %s" % (type(exc).__name__, str(exc)[:120]),
                })
        finally:
            if token is not None:
                self._send_target.reset(token)

    async def _queue_message(self, message: dict, connection) -> None:
        op = str(message.get("op") or "")
        if op in {"session.ack", "session.nack"}:
            if (not getattr(self, "_session_ack", False) or connection is not self.ws
                    or message.get("version") != 1
                    or type(message.get("deliverySeq")) is not int
                    or message.get("runnerId") != self.id or message.get("bootId") != self.boot_id):
                return
            if op == "session.ack":
                if await asyncio.to_thread(self._event_outbox.acknowledge, message):
                    self._delivery_attempts.pop((message.get("streamId"), message.get("deliverySeq")), None)
                    self._outbox_blocked = await asyncio.to_thread(self._event_outbox.at_capacity)
                    self._admission_wake.set()
            else:
                log.warning("Runner event delivery awaits reconciliation: %s", str(message.get("code") or "")[:80])
            return
        if op in {"runner.probe", "job.dispatch"}:
            log.info("收到后台指令：%s", op)
        if not message.get("id"):
            await self._handle_message(message, connection)
            return
        if len(self._rpc_tasks) >= MAX_INFLIGHT_RPC:
            admission_ops = {"job.dispatch", "job.comment"}
            control_ops = {
                "runner.probe", "job.has", "job.status", "job.info",
                "job.session", "job.stop",
            }
            if op in admission_ops:
                # Admission is a product promise: messages wait behind control-plane
                # pressure but are never rejected as "machine full".
                await asyncio.wait(
                    tuple(self._rpc_tasks), return_when=asyncio.FIRST_COMPLETED)
            elif op not in control_ops:
                token = self._send_target.set(connection)
                try:
                    await self._send({
                        "op": "reply", "id": message["id"], "ok": False,
                        "code": "RUNNER_BACKPRESSURE", "retryable": True,
                        "error": "执行机控制通道繁忙，请稍后重试",
                    })
                finally:
                    self._send_target.reset(token)
                return
        task = asyncio.create_task(self._handle_message(message, connection))
        self._rpc_tasks.add(task)
        task.add_done_callback(self._rpc_tasks.discard)
        background_ops = {
            "runner.probe", "job.dispatch", "job.has", "job.status",
            "job.info", "job.session", "job.file", "job.open_dir",
            "git.probe", "git.inspect", "git.merge",
        }
        if op in background_ops:
            self._dispatch_tasks.add(task)
            task.add_done_callback(self._dispatch_tasks.discard)
        if op == "job.dispatch":
            # Give dispatch a turn to register its deterministic ref before status follows.
            await asyncio.sleep(0)

    async def _pump(self, prefetched: list[dict] | None = None) -> None:
        connection = self.ws
        log.info("后台控制通道已就绪")
        for message in prefetched or []:
            await self._queue_message(message, connection)
        async for raw in connection:
            try:
                message = json.loads(raw)
            except Exception:  # noqa: BLE001
                continue
            await self._queue_message(message, connection)

    # RPC execution handlers.
    # Task execution handlers.
    async def _input(self, m: dict) -> dict:
        """Receive input-attachment chunks at exact offsets so retries cannot silently corrupt file
        assembly.
        """
        op = str(m.get("op") or "")
        transfer = str(m.get("transfer") or "")
        root = _input_root(transfer)
        if op == "input.drop":
            await asyncio.to_thread(shutil.rmtree, root, True)
            return {"ok": True}
        if op != "input.chunk":
            return {"ok": False, "error": "不认识的附件操作"}
        import base64
        idx, offset = int(m.get("index") or 0), int(m.get("offset") or 0)
        path = _input_path(transfer, idx)
        os.makedirs(root, exist_ok=True)
        size = os.path.getsize(path) if os.path.isfile(path) else 0
        if offset != size:
            return {"ok": False, "error": "附件分片顺序不对（期望 %d，收到 %d）" % (size, offset)}
        try:
            chunk = base64.b64decode(str(m.get("b64") or ""), validate=True)
        except Exception:
            return {"ok": False, "error": "附件分片不是有效的 base64"}
        with open(path, "ab") as f:
            f.write(chunk)
        return {"ok": True, "data": {"size": size + len(chunk)}}

    async def _job(self, m: dict) -> dict:
        """Translate dispatch, status, and artifact RPCs into the shared ai_local implementation,
        preserving streaming, persistence, watchdog, compaction, and output behavior.
        """
        op = str(m.get("op") or "")
        if op in {"git.probe", "git.inspect", "git.merge"}:
            blocked = _capability_gate(
                self.work_root, ["repository", "terminal"], self.capability_grants)
            if blocked:
                return blocked
            from app.services import runner_scm
            func = {"git.probe": runner_scm.probe_sync,
                    "git.inspect": runner_scm.inspect_sync,
                    "git.merge": runner_scm.merge_sync}[op]
            result = await asyncio.to_thread(func, dict(m.get("payload") or {}))
            return {"ok": bool(result.get("ok")), "data": result,
                    "error": str(result.get("error") or "")}
        from app.services import ai_local

        if op == "job.dispatch":
            t = _Task(m.get("task") or {})
            cfg = dict(m.get("cfg") or {})
            cfg["_admissionKey"] = str(m.get("_admissionKey") or "")
            cfg["local_cli"] = m.get("cli") or cfg.get("local_cli") or "opencode"
            ctx = dict(m.get("ctx") or {})
            from app.services import dispatch_identity, execution_capabilities
            dispatch_id = dispatch_identity.clean_dispatch_id(m.get("dispatchId"))
            if not dispatch_id:
                dispatch_id = "runner:" + uuid.uuid4().hex
                m = dict(m)
                m["dispatchId"] = dispatch_id
            ctx["dispatchId"] = dispatch_id
            required = execution_capabilities.normalize(
                m.get("requiredCapabilities") or ctx.get("requiredAgentCapabilities") or [])
            requested_root = str(
                dict(ctx.get("workspace") or {}).get("workRoot") or self.work_root or "")
            blocked = _capability_gate(requested_root, required, self.capability_grants)
            if blocked:
                return blocked
            packet = m.get("files") or {}
            ctx["requiredAgentCapabilities"] = list(required)
            skill_packet = m.get("skills") or {}
            transfers = {str(x.get("transfer") or "") for x in (packet, skill_packet)
                         if isinstance(x, dict) and x.get("transfer")}
            async def drop_transfers() -> None:
                for transfer in transfers:
                    await _drop_input_transfer(transfer)
            expected_ref = dispatch_identity.execution_ref(dispatch_id)
            dispatch_key = expected_ref
            with ai_local._LOCK:
                persisted = bool(expected_ref in ai_local._RUNS)
            if not m.get("_admitted"):
                if persisted:
                    await drop_transfers()
                    status = await asyncio.to_thread(ai_local.status_sync, {}, expected_ref)
                    state = runner_admission.standard_state(status.get("status"))
                    return {"ok": True, "data": {
                        "ref": expected_ref, "state": state,
                        "queued": state == "queued", "queuePosition": 0,
                        "queueClass": runner_admission.classify(m),
                        "dispatchId": dispatch_id, "duplicate": True,
                        "identifier": status.get("identifier") or "",
                        "error": status.get("error") or "",
                    }}
                return await self._admit(
                    m, key="dispatch:" + expected_ref, ref=expected_ref,
                    category=runner_admission.classify(m), operation="dispatch")
            if expected_ref and expected_ref in self._dispatching_refs:
                # This delivery was never accepted. Its transfer ids belong only to the
                # duplicate request, so keeping them cannot help the original dispatch.
                await drop_transfers()
                return {
                    "ok": False, "uncertain": True, "code": "DISPATCH_IN_PROGRESS",
                    "error": "同一派活正在这台执行机上准备，等待会话登记即可",
                    "data": {"ref": expected_ref, "bootId": self.boot_id},
                }
            self._dispatching_refs.add(dispatch_key)
            try:
                bundled = []
                skill_files = _read_packet(skill_packet, "插件技能包")
                if len(skill_files) > 1:
                    raise ValueError("一次派活只能携带一个插件技能包")
                if skill_files:
                    from app.services import runner_skills
                    meta, data = skill_files[0]
                    bundled = await asyncio.to_thread(
                        runner_skills.install, data, str(meta.get("sha256") or ""))
                if bundled:
                    ctx["skills"] = [x for x in (ctx.get("skills") or [])
                                     if isinstance(x, dict) and not x.get("bundled")] + bundled
                requested_skills = {
                    str(item.get("name") or "") for item in (ctx.get("skills") or [])
                    if isinstance(item, dict) and item.get("name") and not item.get("bundled")}
                if requested_skills - set(self._skill_inventory):
                    # A Skill may have been installed by Pi/Codex moments ago. Refresh
                    # only on a cache miss so ordinary dispatch never rescans every root.
                    await self._refresh_skills(force=True)
                _localize_skills(ctx, self._skill_catalog)
                if (ctx.get("personalPlugin") or {}).get("key"):
                    # Resolve personal-plugin context and optional MCP tickets on this device.
                    # Fail explicitly if loading fails rather than omitting the requested method.
                    from app.services import personal_plugin_runtime
                    try:
                        await asyncio.to_thread(
                            personal_plugin_runtime.apply, ctx,
                            {"base": self.http_base, "clientId": self.client_id,
                             "secret": self.secret}, t.id)
                    except ValueError as exc:
                        return {"ok": False, "error": str(exc)}
                if isinstance(ctx.get("mcpConfig"), dict):
                    # Server filesystem paths are not portable; keep actual dispatch configuration in memory and subprocess environment.
                    ctx["mcpServers"] = ""
                workspace = dict(ctx.pop("workspace", {}) or {})
                if workspace and not ctx.get("workspaceHandoff"):
                    from app.services import workdirs
                    repo_data = dict(workspace.get("repo") or {})
                    repo = _Repo(repo_data) if repo_data else None
                    root = str(workspace.get("workRoot") or self.work_root or "").strip()
                    workspace_policy = dict(ctx.get("workspacePolicy") or {})
                    prepared = await asyncio.to_thread(
                        workdirs.plan, root, repo, t.id,
                        str(workspace.get("devicePath") or ""), cfg.get("git"),
                        execution_key=(str(workspace_policy.get("isolationKey") or "")
                                       if workspace_policy.get("isolated") else ""),
                        base_ref=str(workspace_policy.get("baseRef") or ""))
                    if not prepared.get("ok"):
                        return {"ok": False, "error": prepared.get("detail") or "工作目录没准备好"}
                    ctx["workDir"] = prepared.get("dir") or ""
                    ctx["workspacePrepared"] = True
                    ctx["workspaceManaged"] = bool(prepared.get("isolated"))
                    if repo is not None:
                        repo_ctx = dict(ctx.get("repo") or repo_data)
                        repo_ctx["path"] = prepared.get("dir") or ""
                        ctx["repo"] = repo_ctx
                    if root:
                        cfg["local_workspace_root"] = root
                personal_resources = ctx.pop('_personalPluginResources', [])
                if personal_resources:
                    from app.services import plugin_resources
                    bundle = await asyncio.to_thread(
                        plugin_resources.materialize, personal_resources,
                        str(ctx.get('workDir') or self.work_root),
                        str(dict(ctx.get('personalPluginMeta') or {}).get('key') or ''))
                    from app.services.skill_read_scope import ReadScope
                    ctx['_resourceReadScope'] = ReadScope.capture([bundle['directory']])
                    ctx['personalPluginContext'] = str(ctx.get('personalPluginContext') or '') + '\n\n' + plugin_resources.guidance(bundle)
                source_files = (_read_local_files(m.get("localFiles") or [], "\u8f93\u5165\u9644\u4ef6")
                                if m.get("_localParent") and m.get("localFiles")
                                else _read_packet(packet, "\u8f93\u5165\u9644\u4ef6"))
                inputs = [(str(meta.get("filename") or "\u9644\u4ef6"), data,
                           str(meta.get("contentType") or "application/octet-stream"))
                          for meta, data in source_files]
                if ctx.get("workspaceHandoff"):
                    from app.services import handoff_restore
                    try:
                        ctx, inputs = await asyncio.to_thread(
                            handoff_restore.restore_inputs, ctx, inputs, self.work_root)
                    except (ValueError, OSError) as exc:
                        return {"ok": False, "error": str(exc)}
                if ctx.get("pluginTurn"):
                    from app.services import runner_turn_plugins
                    try:
                        await runner_turn_plugins.prepare_start(self, expected_ref, ctx, cfg)
                    except (ValueError, KeyError, TimeoutError) as exc:
                        return {"ok": False, "error": str(exc)}
                r = await asyncio.to_thread(
                    ai_local.dispatch_sync, cfg, t, inputs,
                    {"id": "local:" + cfg["local_cli"]}, ctx,
                    capability_grants=self.capability_grants)
            finally:
                self._dispatching_refs.discard(dispatch_key)
                await drop_transfers()
            if not r.get("ok"):
                return {"ok": False, "error": r.get("error") or "起不来"}
            # Reply as soon as the process is accepted. The 500 ms push loop persists
            # seq=0 and live events; a full inventory scan must never hold this ACK.
            return {"ok": True, "data": {"ref": r.get("issueId", ""),
                                         "state": "running", "queued": False,
                                         "queuePosition": 0,
                                         "queueClass": runner_admission.classify(m),
                                         "identifier": r.get("identifier", ""),
                                         "agentSessionId": r.get("agentSessionId", ""),
                                         "model": r.get("model", ""),
                                         "reasoningEffort": r.get("reasoningEffort", ""),
                                         "dispatchId": dispatch_id,
                                         "duplicate": bool(r.get("duplicate")),
                                         "pluginSnapshot": dict(ctx.get("personalPluginMeta") or {}),
                                         "files": r.get("files", 0),
                                         "contextReport": dict(r.get("contextReport") or {})}}
        if op == "job.has":
            ref = str(m.get("ref") or "")
            admission_key = str(m.get("admissionKey") or "")
            queued_item = (self._admission.get(admission_key) if admission_key
                           else self._admission.latest_for_ref(ref, include_terminal=True))
            if queued_item is not None and queued_item.ref != ref:
                return {"ok": False, "code": "ADMISSION_REF_MISMATCH",
                        "error": "Admission key does not belong to this execution"}
            inflight = (not admission_key and ref in self._dispatching_refs) or bool(
                queued_item and queued_item.state in runner_admission.ACTIVE_STATES)
            if not admission_key and not inflight and ref not in ai_local._RUNS:
                # Recover historical execution refs from local archives even when only Hub restarted.
                await asyncio.to_thread(ai_local.reclaim)
            persisted = queued_item is not None or (not admission_key and ref in ai_local._RUNS)
            data = {
                "has": inflight or persisted,
                "inflight": inflight,
                "persisted": persisted,
                "bootId": self.boot_id,
                "admissionDurable": getattr(self._admission, "_journal", None) is not None,
                "admissionKey": admission_key,
            }
            if queued_item is not None:
                data.update(self._admission.receipt(queued_item))
            return {"ok": True, "data": data}
        if op == "job.access":
            if not m.get("_localParent"):
                return {"ok": False, "error": "Only the local desktop can change session permissions"}
            from app.services import access_policy
            from app.services import access_transition
            change = access_transition.apply if m.get("applyDuringTurn") else access_policy.schedule
            result = await asyncio.to_thread(change,
                str(m.get("ref") or ""), m.get("accessPolicy"), m.get("expectedRevision"))
            return {"ok": bool(result.get("ok")), "data": result,
                    "error": result.get("error", ""), "code": result.get("code", "")}
        if op == "job.permission":
            from app.services import access_broker
            result = access_broker.respond(
                str(m.get("ref") or ""), str(m.get("requestId") or ""),
                str(m.get("decision") or ""), m.get("policyRevision"))
            return {"ok": bool(result.get("ok")), "data": result,
                    "error": result.get("error", ""), "code": result.get("code", "")}
        if op == "job.status":
            ref = str(m.get("ref") or "")
            item = self._admission.latest_for_ref(ref, include_terminal=True)
            with ai_local._LOCK:
                local_exists = ref in ai_local._RUNS
            if runner_admission.owns_status(item, local_exists):
                return {"ok": True, "data": runner_admission.status_data(
                    item, self._admission.position(item.key))}
            return {"ok": True, "data": await asyncio.to_thread(
                ai_local.status_sync, {}, ref)}
        if op == "job.info":
            ref = str(m.get("ref") or "")
            item = self._admission.latest_for_ref(ref, include_terminal=True)
            with ai_local._LOCK:
                local_exists = ref in ai_local._RUNS
            if runner_admission.owns_status(item, local_exists):
                return {"ok": True, "data": runner_admission.info_data(
                    item, self._admission.position(item.key))}
            return {"ok": True, "data": await asyncio.to_thread(
                ai_local.runner_info_sync, {}, ref)}
        if op == "job.authorize":
            # Model credentials may be refreshed only by this desktop's private
            # parent/child control pipe.  The Hub websocket must never become a
            # generic credential injection endpoint.
            if not m.get("_localParent"):
                return {"ok": False, "error": "只允许本机 SoduWork 恢复会话授权"}
            from app.services import local_stream
            result = await asyncio.to_thread(
                local_stream.authorize_sync, dict(m.get("cfg") or {}),
                str(m.get("ref") or ""))
            return {"ok": bool(result.get("ok")), "data": result,
                    "error": str(result.get("error") or "")}
        if op == "job.session":
            # Return the same incremental session shape as backend-local execution.
            # Status alone would leave the remote console without activity.
            ref = str(m.get("ref") or "")
            item = self._admission.latest_for_ref(ref, include_terminal=True)
            with ai_local._LOCK:
                local_exists = ref in ai_local._RUNS
            if runner_admission.owns_status(item, local_exists):
                queued = runner_admission.queued_session(
                    item, self._admission.position(item.key), max(0, int(m.get("since") or 0)))
                if item.operation == "comment" and item.state in {"failed", "cancelled"} and not item.launched:
                    native = await asyncio.to_thread(ai_local.session_sync, {}, ref,
                        max(0, int(m.get("since") or 0)), min(1000, max(1, int(m.get("limit") or 400))))
                    queued = runner_admission.with_native_history(queued, native)
                return {"ok": True, "data": queued}
            data = await asyncio.to_thread(
                ai_local.session_sync, {}, ref,
                max(0, int(m.get("since") or 0)),
                min(1000, max(1, int(m.get("limit") or 400))))
            from app.services import local_stream
            data["authorizationRequired"] = await asyncio.to_thread(
                local_stream.authorization_required_sync, ref)
            return {"ok": True, "data": data}
        if op == "job.open_dir":
            ref = str(m.get("ref") or "")
            info = await asyncio.to_thread(ai_local.runner_info_sync, {}, ref)
            path = str((info or {}).get("workDirAbs") or "")
            if not path or not os.path.isdir(path):
                return {"ok": False, "error": "这条活的工作目录不存在"}
            try:
                await asyncio.to_thread(_open_dir, path)
            except Exception as e:  # noqa: BLE001
                return {"ok": False, "error": "打不开目录（%s）" % type(e).__name__}
            return {"ok": True, "data": {"dir": path, "host": socket.gethostname()}}
        if op == "job.file":
            ref = str(m.get("ref") or "")
            aid = str(m.get("fileId") or m.get("attachmentId") or "")
            offset = max(0, int(m.get("offset") or 0))
            limit = min(1024 * 1024, max(1, int(m.get("limit") or 512 * 1024)))
            root, rel = "", ""
            if ref:
                log.info("产出分片开始 ref=%s file=%s offset=%d", ref[:12], aid[:160], offset)
                try:
                    run = await asyncio.to_thread(_run_snapshot, ai_local, ref)
                except Exception as e:  # noqa: BLE001
                    log.warning("读取会话状态失败 ref=%s: %s", ref[:12], e)
                    return {"ok": False, "error": str(e)[:500] or type(e).__name__}
                root, rel = _artifact_location(run, aid) if run else ("", "")
            if not root:
                # The legacy unscoped fallback handles small files only; normal ingestion uses execution-scoped retrieval.
                b = await asyncio.to_thread(ai_local.fetch_attachment_sync, {}, aid) if not ref else None
                if b is None:
                    log.warning("找不到产出文件 ref=%s file=%s run=%s ws=%s",
                                ref[:12], aid[:160], bool(run), str((run or {}).get("ws") or "")[:300])
                    return {"ok": False, "error": "读不到这个产出"}
                chunk, size = b[offset:offset + limit], len(b)
            else:
                try:
                    piece = await asyncio.wait_for(
                        asyncio.to_thread(_read_file_chunk, root, rel, offset, limit), timeout=35)
                except Exception as e:  # noqa: BLE001
                    log.warning("读取产出分片失败 ref=%s file=%s: %s", ref[:12], aid[:160], e)
                    return {"ok": False, "error": str(e)[:500] or type(e).__name__}
                log.info("产出分片完成 ref=%s file=%s bytes=%d/%d",
                         ref[:12], aid[:160], piece["count"], piece["size"])
                size, count = piece["size"], piece["count"]
                if offset > size:
                    return {"ok": False, "error": "产出分片位置超出文件大小"}
                import base64
                return {"ok": True, "data": {
                    "__bytes__": base64.b64decode(piece["b64"]) if piece.get("b64") else b"",
                    "offset": offset, "size": size,
                    "eof": offset + count >= size,
                }}
            return {"ok": True, "data": {
                "__bytes__": bytes(chunk),
                "offset": offset, "size": size, "eof": offset + len(chunk) >= size,
            }}
        if op == "job.stop":
            from app.services import local_stream
            ref = str(m.get("ref") or "")
            mode, item, payload = self._admission.cancel_ref(ref)
            if payload:
                await self._drop_message_transfers(payload)
            if item is not None:
                self._admission_wake.set()
                if mode == "cancelled" or mode == "starting":
                    return {"ok": True, "data": runner_admission.status_data(
                        item, self._admission.position(item.key))}
            stopped = await asyncio.to_thread(local_stream.stop_sync, {}, ref)
            if item is not None and stopped.get("ok"):
                self._admission.finish(item.key, "cancelled")
            return {"ok": True, "data": stopped}
        if op == "job.comment":
            from app.services.runner_comments import comment
            return await comment(self, m, _read_local_files, _read_packet, _drop_input_transfer)
        return {"ok": False, "error": "不认识的 job 操作: " + op}

    async def _mcp(self, m: dict) -> dict:
        """Run trusted personal/local MCP beside the employee, never on Hub."""
        from app.services import mcp_http, mcp_servers
        op = str(m.get("op") or "")
        spec = dict(m.get("spec") or {})
        timeout = max(3, min(120, int(m.get("timeout") or 25)))
        name = str(m.get("name") or "mcp")[:128]
        try:
            if op == "mcp.probe":
                result = await asyncio.to_thread(
                    mcp_servers.probe_sync, spec, timeout)
                if not result.get("ok") and not result.get("connectionState"):
                    raise ValueError(result.get("error") or "MCP 连接失败")
                from app.services import connector_health
                return {"ok": True, "data": {
                    **connector_health.metadata(result),
                    "tools": [str(tool)[:200] for tool in
                              (result.get("tools") or [])][:100],
                    "discoveredTools": [str(tool)[:200] for tool in
                                        (result.get("discoveredTools") or
                                         result.get("tools") or [])][:100],
                    "blockedTools": [str(tool)[:200] for tool in
                                     (result.get("blockedTools") or [])][:100],
                    "at": int(time.time()),
                }}
            if op == "mcp.list":
                if spec.get("type") == "http":
                    tools = await asyncio.to_thread(
                        mcp_http.list_tools, spec, timeout)
                else:
                    tools = await asyncio.to_thread(
                        mcp_servers.bridge_list_sync, name, spec,
                        timeout=timeout)
                tools = [item for item in tools if mcp_servers.tool_allowed(
                    spec, str(item.get("name") or ""))]
                return {"ok": True, "data": {"tools": tools}}
            if op == "mcp.call":
                tool = str(m.get("tool") or "").strip()[:200]
                if not tool:
                    raise ValueError("MCP 工具名不能为空")
                if not mcp_servers.tool_allowed(spec, tool):
                    raise ValueError("这个工具不在当前 MCP 连接的授权范围内")
                arguments = m.get("arguments") or {}
                if not isinstance(arguments, dict):
                    raise ValueError("MCP 工具参数必须是对象")
                if spec.get("type") == "http":
                    result = await asyncio.to_thread(
                        mcp_http.call, spec, tool, arguments, timeout)
                else:
                    result = await asyncio.to_thread(
                        mcp_servers.bridge_call_sync, name, spec, tool,
                        arguments, timeout=timeout)
                return {"ok": True, "data": {"result": result}}
        except Exception as exc:  # noqa: BLE001 - RPC boundary must redact
            return {"ok": False, "error": mcp_servers.redact_diagnostic(
                f"{type(exc).__name__}: {exc}", spec)[:600]}
        return {"ok": False, "error": "不认识的 MCP 操作: " + op}

    async def _agent(self, m: dict) -> dict:
        """Discover, install, and configure agents on the execution machine rather than
        accidentally modifying Hub.
        """
        from app.services import agent_setup
        op = str(m.get("op") or "")
        key = str(m.get("key") or "")
        if op == "agent.setup":
            return {"ok": True, "data": {
                "env": agent_setup.node_env(),
                "agents": agent_setup.detect_all(has_model=bool(m.get("hasModel"))),
            }}
        if op == "agent.job":
            job_id = str(m.get("jobId") or "")
            job = agent_setup.job(job_id, owner_id=str(m.get("ownerId") or ""))
            if (job is not None and job.get("state") == "done"
                    and job_id not in self._refreshed_agent_jobs):
                self._refreshed_agent_jobs.add(job_id)
                await self._refresh_agents(force=True)
                await self._report_beat()
            return ({"ok": True, "data": job} if job is not None
                    else {"ok": False, "error": "没有这个作业（runner 可能重启过）"})
        if key not in agent_setup._SPECS:
            return {"ok": False, "error": "没有这个 AI 助手"}
        if op == "agent.install":
            action = str(m.get("action") or "install")
            if action not in ("install", "update", "uninstall", "check", "login", "login-isolated", "login-cancel") or (action.startswith("login") and key != "codex"):
                return {"ok": False, "error": "不认识的操作"}
            if action == "login-cancel":
                try:
                    return {"ok": True, "data": agent_setup.cancel_login(str(m.get("jobId") or ""),
                                                                        owner_id=str(m.get("ownerId") or ""))}
                except ValueError as exc:
                    return {"ok": False, "error": str(exc)}
            installer = str((agent_setup._SPECS.get(key) or {}).get("installer") or "npm")
            if not action.startswith("login") and not agent_setup.is_bundled(key) and installer == "npm":
                env = agent_setup.node_env(key)
                if not env.get("ok"):
                    return {"ok": False, "error": env.get("why") or "这台电脑没有 Node.js"}
            jid = (agent_setup.start_install(key, action, owner_id=str(m.get("ownerId") or ""))
                   if action.startswith("login") else agent_setup.start_install(key, action))
            return {"ok": True, "data": {"jobId": jid}}
        if op == "agent.probe":
            return {"ok": True, "data": {"jobId": agent_setup.start_probe(key, dict(m.get("llm") or {}))}}
        if op == "agent.configure":
            return {"ok": True, "data": agent_setup.configure(key, dict(m.get("llm") or {}))}
        return {"ok": False, "error": "不认识的助手操作: " + op}

    async def _component(self, m: dict) -> dict:
        """Install only components from the Runner's reviewed manifest; Hub cannot provide
        arbitrary installation commands.
        """
        from app.services import runtime_components
        op = str(m.get("op") or "")
        if op == "component.list":
            return {"ok": True, "data": runtime_components.status()}
        if op == "component.install":
            try:
                jid = runtime_components.start_install(str(m.get("key") or ""))
            except ValueError as exc:
                return {"ok": False, "error": str(exc)}
            return {"ok": True, "data": {"jobId": jid}}
        if op == "component.job":
            item = runtime_components.job(str(m.get("jobId") or ""))
            if item is None:
                return {"ok": False, "error": "没有这个安装作业（Runner 可能重启过）"}
            if item.get("state") == "done":
                item["capabilities"] = _capabilities(
                    self.work_root, self.capability_grants)
                item["components"] = runtime_components.status()
            return {"ok": True, "data": item}
        return {"ok": False, "error": "不认识的能力组件操作: " + op}

    async def _deploy(self, m: dict) -> dict:
        """Deploy in dedicated Runner worktrees from declarative parameters, without a Hub shell."""
        from app.services import runner_deploy
        op = str(m.get("op") or "")
        required = []
        if op == "deploy.start":
            required = ["repository", "terminal"]
        elif op == "deploy.preflight":
            from app.services import execution_capabilities
            required = execution_capabilities.normalize(
                m.get("requiredCapabilities") or ["files", "terminal"])
        if required:
            blocked = _capability_gate(self.work_root, required, self.capability_grants)
            if blocked:
                return blocked
        if op == "deploy.start":
            return await asyncio.to_thread(runner_deploy.start, dict(m.get("spec") or {}), self.work_root)
        if op == "deploy.status":
            return await asyncio.to_thread(runner_deploy.status, str(m.get("runId") or ""))
        if op == "deploy.preflight":
            return await asyncio.to_thread(
                runner_deploy.preflight, dict(m.get("spec") or {}), self.work_root)
        return {"ok": False, "error": "不认识的部署操作: " + op}

    async def _quality(self, m: dict) -> dict:
        """Quality gates share the authorized work root and accept structured argv only."""
        from app.services import runner_quality
        op = str(m.get("op") or "")
        if op == "quality.start":
            blocked = _capability_gate(
                self.work_root, ["repository", "terminal"], self.capability_grants)
            if blocked:
                return blocked
            return await asyncio.to_thread(
                runner_quality.start, dict(m.get("spec") or {}), self.work_root)
        if op == "quality.status":
            return await asyncio.to_thread(
                runner_quality.status, str(m.get("runId") or ""))
        return {"ok": False, "error": "不认识的质量门禁操作: " + op}

    async def _on(self, m: dict) -> None:
        # This entry is network-owned. Only _local_rpc_dispatch may confer the
        # parent-process marker; remote JSON must never impersonate that pipe.
        m = dict(m)
        m.pop("_localParent", None)
        op = str(m.get("op") or "")
        if op.startswith("content."):
            try:
                # Both ingress paths share one store initialization and lock.
                # Hub realms still have separate account/record namespaces.
                import hashlib
                realm = hashlib.sha256(self.http_base.encode()).hexdigest()
                store = await self._conversation_content_store(realm)
                result = await asyncio.to_thread(store.handle, m)
            except Exception as exc:
                result = {"ok": False, "error": str(exc)}
            await self._send({**result, "op": "reply", "id": m.get("id")})
            return
        if op.startswith("desktop.capability"):
            try:
                if op != "desktop.capability" or not getattr(self, "desktop_owned", False):
                    raise ValueError("此操作仅支持由桌面客户端启动的本人电脑")
                from app.services.runner_desktop_capabilities import DesktopCapabilities
                if not hasattr(self, "_desktop_capabilities"):
                    self._desktop_capabilities = DesktopCapabilities(self._write_local_rpc)
                result = await self._desktop_capabilities.call({
                    key: m.get(key) for key in ("requestId", "operation", "args", "targetClientId", "ownerUserId", "authorization")})
            except Exception as exc:
                result = {"ok": False, "error": str(exc) or "电脑未及时响应，请核对原操作结果"}
            await self._send({**result, "op": "reply", "id": m.get("id")})
            return
        if op == "runtime.catalog.apply":
            await self._send({"op": "reply", "id": m.get("id"), "ok": False,
                              "code": "LOCAL_PARENT_REQUIRED",
                              "error": "Custom Agents can only be added by this desktop"})
            return
        if op == "runner.probe":
            # A manual probe can arrive between the fast WebSocket handshake and the first
            # heartbeat. Refresh the cache so the UI does not report a false empty Agent list.
            await self._refresh_agents()
            admission = self._admission_report(force=True)
            # Run command-based agent discovery in workers so heartbeats and activity remain responsive.
            def probe() -> dict:
                root = os.path.abspath(os.path.expanduser(self.work_root or os.getcwd()))
                disk_at = root if os.path.exists(root) else os.path.dirname(root)
                try:
                    usage = shutil.disk_usage(disk_at if os.path.exists(disk_at) else os.getcwd())
                    free = int(usage.free)
                except OSError:
                    free = 0
                return {
                    "ok": True,
                    "data": {
                        "runnerId": self.id,
                        "host": socket.gethostname(),
                        "version": RUNNER_VERSION,
                        **admission,
                        # Heartbeats own the relatively expensive CLI/auth scan. A manual
                        # probe reads that <=20s snapshot instead of racing local cache files.
                        "agents": [dict(item) for item in self._agent_inventory],
                        "skills": list(self._skill_inventory),
                        "skillCatalog": _skill_report(self._skill_catalog),
                        "capabilities": _capabilities(self.work_root, self.capability_grants),
                        "workRoot": self.work_root,
                        "tags": self.tags,
                        "freeBytes": free,
                        "at": int(time.time()),
                    },
                }
            res = await asyncio.to_thread(probe)
            await self._send({**res, "op": "reply", "id": m.get("id")})
            return
        if op == "skills.refresh":
            await self._refresh_skills(force=True)
            await self._send({
                "ok": True, "op": "reply", "id": m.get("id"),
                "data": {
                    "skills": list(self._skill_inventory),
                    "skillCatalog": _skill_report(self._skill_catalog),
                    "at": int(time.time()),
                },
            })
            return
        if op.startswith("mcp."):
            res = await self._mcp(m)
            await self._send({**res, "op": "reply", "id": m.get("id")})
            return
        if op.startswith("input."):
            res = await self._input(m)
            await self._send({**res, "op": "reply", "id": m.get("id")})
            return
        if op.startswith("job.") or op.startswith("git."):
            res = await self._job(m)
            payload = (res.get("data") or {}).pop("__bytes__", None) if isinstance(
                res.get("data"), dict) else None
            if payload is not None and self.bin:
                # Use negotiated binary frames for artifact chunks to avoid base64 expansion.
                from app.services import ws_frames
                await self._send_frame(ws_frames.KIND_REPLY_CHUNK, {
                    "id": m.get("id"), "ok": bool(res.get("ok")),
                    **({"error": res["error"]} if res.get("error") else {}),
                    "data": res.get("data") or {},
                }, payload)
                return
            if payload is not None:
                # Retain base64 JSON replies for older Hubs without bin1.
                import base64
                res["data"]["b64"] = base64.b64encode(payload).decode("ascii")
            await self._send({**res, "op": "reply", "id": m.get("id")})
            return
        if op.startswith("agent."):
            res = await self._agent(m)
            await self._send({**res, "op": "reply", "id": m.get("id")})
            return
        if op.startswith("component."):
            res = await self._component(m)
            await self._send({**res, "op": "reply", "id": m.get("id")})
            return
        if op.startswith("deploy."):
            res = await self._deploy(m)
            await self._send({**res, "op": "reply", "id": m.get("id")})
            return
        if op.startswith("quality."):
            res = await self._quality(m)
            # Business results can contain their own IDs.
            # Write the transport correlation ID last so the server can resolve its waiter.
            await self._send({**res, "op": "reply", "id": m.get("id")})
            return
        if op == "term.open":
            await self._term_open(m)
        elif op == "term.in":
            t = _TERMS.get(str(m.get("task") or ""))
            if t is not None:
                t.write(str(m.get("d") or ""))
        elif op == "term.resize":
            t = _TERMS.get(str(m.get("task") or ""))
            if t is not None:
                t.resize(int(m.get("cols") or 100), int(m.get("rows") or 30))
        elif op == "term.close":
            task = str(m.get("task") or "")
            t = _TERMS.pop(task, None)
            cb = _TERM_SUBS.pop(task, None)
            if t is not None and cb is not None:
                t.unsubscribe(cb)
            if t is not None:
                await asyncio.to_thread(t.close)
            await self._report_beat()
        elif op == "term.detach":
            task = str(m.get("task") or "")
            t, cb = _TERMS.get(task), _TERM_SUBS.pop(task, None)
            if t is not None and cb is not None:
                t.unsubscribe(cb)
            await self._report_beat()
        elif op == "ping":
            await self._send({"op": "reply", "id": m.get("id"), "ok": True})

    async def _term_open(self, m: dict) -> None:
        """Open the shared real PTY implementation on this machine and continuously relay output to
        Hub.
        """
        from app.services import pty_term
        from app.services.terminal_environment import runner_environment
        task = str(m.get("task") or "")
        okk, why = pty_term.available()
        if not okk:
            await self._send({"op": "reply", "id": m.get("id"), "ok": False, "error": why})
            return
        try:
            env = await asyncio.to_thread(
                runner_environment, task, str(m.get("ref") or ""),
                str(m.get("cli") or ""), self.work_root)
        except (ValueError, RuntimeError):
            await self._send({"op": "reply", "id": m.get("id"), "ok": False,
                              "error": "终端环境未就绪，请在原执行机重新连接会话"})
            return
        term = await asyncio.to_thread(
            pty_term.open_term, task, str(m.get("ws") or ""),
            int(m.get("cols") or 100), int(m.get("rows") or 30),
            env, str(m.get("mode") or "session"),
            str(m.get("sid") or ""), str(m.get("cli") or ""))
        _TERMS[task] = term

        loop = self.loop

        def on_data(d):
            """PTY callbacks run in reader threads; use call_soon_threadsafe to reach the event
            loop.
            """
            try:
                if d is None:
                    loop.call_soon_threadsafe(
                        asyncio.ensure_future, self._send({"op": "term.end", "task": task}))
                elif self.bin:
                    # Send terminal payloads as binary frames while retaining JSON control messages for terminal closure.
                    from app.services import ws_frames
                    loop.call_soon_threadsafe(
                        asyncio.ensure_future,
                        self._send_frame(ws_frames.KIND_TERM_OUT, {"task": task},
                                         d.encode("utf-8") if isinstance(d, str) else bytes(d)))
                else:
                    loop.call_soon_threadsafe(
                        asyncio.ensure_future,
                        self._send({"op": "term.out", "task": task, "d": d}))
            except Exception:  # noqa: BLE001
                pass

        old_cb = _TERM_SUBS.pop(task, None)
        if old_cb is not None:
            term.unsubscribe(old_cb)
        _TERM_SUBS[task] = on_data
        backlog = term.subscribe(on_data)
        await self._send({"op": "reply", "id": m.get("id"), "ok": True,
                          "info": term.info(), "backlog": backlog})


def _lock_path(rid: str) -> str:
    root = os.environ.get("SODUWORK_DATA_ROOT") or os.path.join(
        os.path.expanduser("~"), ".soduwork")
    try:
        os.makedirs(root, exist_ok=True)
    except OSError:
        root = os.path.expanduser("~")
    return os.path.join(root, "runner-%s.lock" % re.sub(r"[^A-Za-z0-9_.-]", "_", rid)[:40])


def _single_instance(rid: str):
    """Acquire a per-machine, per-Runner-ID singleton lock. Duplicate processes would replace each
    other's connections and orphan active jobs; return the lock handle or None.
    """
    path = _lock_path(rid)
    try:
        handle = open(path, "a+", encoding="utf-8")
    except OSError:
        return None                      # If the lock file cannot be created, preserve the existing startup fallback.
    try:
        if os.name == "nt":
            import msvcrt
            # Seek to byte zero before msvcrt.locking.
            # Append mode starts at EOF and could let competing processes lock different bytes.
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return None
    try:
        handle.seek(1)          # Reserve byte zero for the lock.
        handle.truncate(1)
        handle.write(" %s %s\n" % (os.getpid(), time.strftime("%Y-%m-%d %H:%M:%S")))
        handle.flush()
    except OSError:
        pass
    return handle


def _release(handle) -> None:
    try:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)          # Unlock the same byte-zero region used during acquisition.
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        handle.close()
    except Exception:  # noqa: BLE001 - Cleanup failures must not prevent exit.
        pass


def main() -> None:
    if len(sys.argv) > 2 and sys.argv[1] == '--soduwork-spool-worker':
        from app.services import local_spool_worker
        raise SystemExit(local_spool_worker.main(sys.argv[2]))

    if len(sys.argv) > 1 and sys.argv[1] == "--acp-bridge":
        sys.argv = [sys.argv[0], *sys.argv[2:]]
        from app.services import acp_bridge
        raise SystemExit(acp_bridge.main())

    if len(sys.argv) > 1 and sys.argv[1] == "--harness2-native":
        from app.services import harness2_native
        raise SystemExit(harness2_native.main())

    if len(sys.argv) > 1 and sys.argv[1] == "--harness2-bridge":
        sys.argv = [sys.argv[0], *sys.argv[2:]]
        from app.services import harness2_bridge
        raise SystemExit(harness2_bridge.main())

    ap = argparse.ArgumentParser(description="SoduWork 执行机")
    ap.add_argument("--doctor", action="store_true", help="检查 CLI、真终端和内置技能后退出")
    ap.add_argument("--config", default="", help="runner JSON 配置文件（独立部署兼容入口）")
    ap.add_argument("--config-stdin", action="store_true", help="通过桌面私有管道接收启动配置")
    ap.add_argument("--hub", default=os.environ.get("SODUWORK_HUB") or "",
                    help="后端地址，如 ws://192.0.2.230:9080")
    ap.add_argument("--token", default=os.environ.get("SODUWORK_RUNNER_TOKEN") or "")
    ap.add_argument("--key", default=os.environ.get("SODUWORK_RUNNER_KEY") or "",
                    help="一机一钥（管理端→终端管理里发的这台机器专属钥匙；配了就别再用共享 token）")
    ap.add_argument("--secret", default=os.environ.get("SODUWORK_DEVICE_SECRET") or "")
    ap.add_argument("--client", default=os.environ.get("SODUWORK_CLIENT_ID") or "",
                    help="属于哪台 SoduWork（桌宠）——派活时「桌宠在线优先用桌宠那台」靠它匹配")
    ap.add_argument("--work-root", default=os.environ.get("SODUWORK_WORK_ROOT") or "",
                    help="这台执行机自己的工作根目录；临时活和首次 clone 都落在这里")
    ap.add_argument("--data-root", default=os.environ.get("SODUWORK_DATA_ROOT") or "",
                    help="runner 自己的会话/日志目录（默认跟配置文件放在一起）")
    ap.add_argument("--id", default=os.environ.get("SODUWORK_RUNNER_ID") or "")
    ap.add_argument("--tags", default=os.environ.get("SODUWORK_RUNNER_TAGS") or "",
                    help="执行机标签，逗号分隔，如 linux,intranet")
    ap.add_argument("--max-concurrent", default=os.environ.get("SODUWORK_RUNNER_MAX_CONCURRENT") or "",
                    help="自适应并发的安全上限（1-20；默认 20，实际值由 CPU 和内存自动决定）")
    a = ap.parse_args()
    conf = {}
    if a.config_stdin:
        if a.config:
            ap.error("--config and --config-stdin are mutually exclusive")
        try:
            from app.services.runner_lifecycle import read_config
            conf = read_config(sys.stdin.buffer)
        except (OSError, ValueError, UnicodeError) as exc:
            log.error("Runner startup configuration rejected (%s)", type(exc).__name__)
            raise SystemExit(2)
    if a.config:
        try:
            # Read configuration as utf-8-sig to accept Windows tools that write a BOM.
            # A BOM must not turn a valid configuration into a parse failure.
            with open(os.path.abspath(a.config), encoding="utf-8-sig") as f:
                conf = json.load(f) or {}
        except Exception as e:  # noqa: BLE001
            log.error("读不到 runner 配置（%s）", type(e).__name__)
            raise SystemExit(2)
    data_root = a.data_root or str(conf.get("dataRoot") or "")
    if not data_root and a.config:
        data_root = os.path.join(os.path.dirname(os.path.abspath(a.config)), "data")
    if data_root:
        # Set data-root configuration before importing local_base because archive paths initialize at import time.
        os.environ["SODUWORK_DATA_ROOT"] = os.path.abspath(os.path.expanduser(data_root))
    from app.services import agent_npm_runtime
    agent_npm_runtime.activate_environment(data_root)
    try:
        from app.services.custom_agent_catalog import restore as restore_custom_agents
        restore_custom_agents(conf, desktop_owned=bool(a.config_stdin))
    except (ValueError, TypeError) as exc:
        log.error("Custom Agent startup configuration rejected: %s", str(exc))
        raise SystemExit(2)
    # Activate component paths before runtime discovery or task execution, reading active.json only.
    # Invalid component metadata marks capabilities unavailable without blocking connection.
    try:
        from app.services import runtime_components
        runtime_components.activate_environment()
    except Exception as exc:  # noqa: BLE001
        log.warning("激活能力组件失败: %s", type(exc).__name__)
    # Add bundled PortableGit only when no native usable bash exists.
    # Pi resolves the shell from configured paths and PATH.
    # Prepare that environment before dispatch so fresh installations can execute shell tools.
    os.environ["PATH"] = _with_bundled_shell(
        os.environ.get("PATH", ""), os.environ.get("SODUWORK_BUNDLED_SHELL", ""))
    # Provide an Electron-backed Node shim when a suitable system Node is absent.
    # MCP and browser/research helpers invoke Node directly.
    os.environ["PATH"] = _ensure_node_shim(
        os.environ.get("PATH", ""), os.environ.get("SODUWORK_BUNDLED_NODE", ""),
        os.environ.get("SODUWORK_DATA_ROOT", ""))
    capability_grants = (conf.get("capabilityGrants")
                         if "capabilityGrants" in conf else None)
    if a.doctor:
        from app.services import pty_term, skills
        agents = _agents()
        terminal, terminal_reason = pty_term.available()
        found_skills = skills.scan()
        doctor_tags = _tags(a.tags or conf.get("tags") or [])
        doctor_default = MAX_CONCURRENT_LIMIT
        report = {
            "ok": bool(agents and terminal),
            "version": RUNNER_VERSION,
            "maxConcurrent": _configured_concurrency(
                a.max_concurrent, conf, doctor_default),
            "agents": agents,
            "capabilities": _capabilities(
                a.work_root or str(conf.get("workRoot") or ""), capability_grants),
            "terminal": {"ok": terminal, "reason": terminal_reason},
            # Expose the bundled shell to Pi on machines without Git.
            "bash": shutil.which("bash") or "",
            # Expose the Node shim to MCP and browser/research helpers.
            "node": shutil.which("node") or "",
            "skills": [{"name": s.get("name"), "path": s.get("path")} for s in found_skills],
            "dataRoot": os.environ.get("SODUWORK_DATA_ROOT") or "",
            "frozen": bool(getattr(sys, "frozen", False)),
        }
        print(json.dumps(report, ensure_ascii=False, indent=2))
        raise SystemExit(0 if report["ok"] else 1)
    hub = a.hub or str(conf.get("hub") or "") or "http://127.0.0.1:9080"
    token = a.token or str(conf.get("token") or "")
    key = a.key or str(conf.get("key") or "")
    secret = a.secret or str(conf.get("secret") or "")
    # These credentials authenticate the Runner control channel, not the work
    # it launches.  Remove them before any agent/terminal subprocess is born;
    # otherwise Pi/OpenCode and arbitrary task commands inherit control-plane
    # credentials and can impersonate this machine.
    for env_key in ("SODUWORK_DEVICE_SECRET", "SODUWORK_RUNNER_KEY", "SODUWORK_RUNNER_TOKEN"):
        os.environ.pop(env_key, None)
    client_id = a.client or str(conf.get("clientId") or "")
    work_root = a.work_root or str(conf.get("workRoot") or "")
    tags = _tags(a.tags or conf.get("tags") or [])
    default_capacity = MAX_CONCURRENT_LIMIT
    # ``maxConcurrent`` in old desktop configs was the fixed process count (normally 1).
    # Reusing it as the new adaptive ceiling silently recreates the 1/1 bottleneck forever.
    # Only a new explicit ceiling or CLI/env override may cap the adaptive scheduler.
    max_concurrent = _configured_concurrency(
        a.max_concurrent, conf, default_capacity)
    rid = _runner_id(a.id or str(conf.get("runnerId") or ""))
    if key and not (a.id or conf.get("runnerId")):
        # Standalone keys bind to a fixed explicit Runner ID; hostname-derived changes would invalidate them.
        log.error("配了 --key 就必须显式配 --id（钥匙与执行机 id 绑定）")
        raise SystemExit(2)
    # Derive an internal managed-runtime download source from the connected Hub.
    # Preserve an explicitly configured SODUWORK_HUB_HTTP_BASE via setdefault.
    http_base = hub.rstrip("/")
    if http_base.startswith("wss://"):
        http_base = "https://" + http_base[len("wss://"):]
    elif http_base.startswith("ws://"):
        http_base = "http://" + http_base[len("ws://"):]
    if http_base.startswith(("http://", "https://")):
        os.environ.setdefault("SODUWORK_HUB_HTTP_BASE", http_base)
    log.info("执行机 %s @ %s → %s（并发上限 %d）",
             rid, socket.gethostname(), hub, max_concurrent)
    lock = _single_instance(rid)
    if lock is None:
        log.error("这台机器上已经有一个执行机 %s 在跑了——第二个不启动。\n"
                  "  ★为什么必须拦：两份用的是同一个执行机 id，会在后台互相顶替连接，"
                  "被顶下线那份手上正跑着的活会被判成「会话没了」，真机上因此白烧过两轮 AI。\n"
                  "  要换一份跑：先把在跑的那个停掉。", rid)
        raise SystemExit(3)
    try:
        from app.services.runner_lifecycle import run_until_stopped
        desktop_identity_scope = None
        if a.config_stdin and client_id and secret and not key and not a.id and not conf.get("runnerId"):
            from app.services.local_base import _data_root
            from app.services.runner_desktop_identity import select
            desktop_identity_scope = (_data_root(), hub, client_id, rid)
            try:
                rid = select(*desktop_identity_scope)
            except (OSError, ValueError) as exc:
                runner_connection_status.report_identity_startup_failure(
                    exc, desktop_owned=bool(a.config_stdin))
                raise
        runner = Runner(
            hub, token, client_id, rid, work_root, secret, tags, key=key,
            capability_grants=capability_grants,
            max_concurrent=max_concurrent,
            # Keep this device's queued work reachable after an identity repair;
            # the authenticated client and Hub still isolate every journal.
            journal_runner_id=desktop_identity_scope[3] if desktop_identity_scope else "")
        runner.desktop_owned = bool(a.config_stdin)
        runner.desktop_identity_scope = desktop_identity_scope
        asyncio.run(run_until_stopped(runner))
    except KeyboardInterrupt:
        log.info("收工")
    finally:
        _release(lock)


if __name__ == "__main__":
    main()
