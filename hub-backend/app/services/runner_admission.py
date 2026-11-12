"""Admission and adaptive resource budget for one SoduWork Runner.

Conversation admission is deliberately unbounded: accepting a message and launching
another Agent process are different decisions. Background work has a bounded backlog.
The Runner supplies a private journal so an accepted queued operation survives
restart. Unit callers may omit storage; scheduling rules remain identical.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
import platform
import threading
import time
from typing import Callable


INTERACTIVE = "interactive"
MANUAL = "task"
AUTOMATION = "automation"
PRIORITY = {INTERACTIVE: 0, MANUAL: 1, AUTOMATION: 2}
ACTIVE_STATES = {"queued", "starting", "running"}
TERMINAL_STATES = {"completed", "failed", "cancelled"}
DEFAULT_TASK_CAPACITY = 100
MIN_CONCURRENCY = 1
MAX_CONCURRENCY = 20
_GIB = 1024 ** 3


def standard_state(value) -> str:
    raw = str(value or "").strip().lower()
    if raw in {"queued"}:
        return "queued"
    if raw in {"starting", "dispatching", "running", "waiting-permission"}:
        return "running"
    if raw in {"done", "completed", "succeeded", "success", "idle"}:
        return "completed"
    if raw in {"stopped", "interrupted", "cancelled", "canceled", "aborted"}:
        return "cancelled"
    return "failed" if raw else "queued"


def _bounded_number(value, low: float, high: float, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = default
    return max(low, min(high, number))


def classify(message: dict) -> str:
    """Classify one launch without depending on a particular Agent substrate."""
    payload = dict(message or {})
    task = dict(payload.get("task") or {})
    ctx = dict(payload.get("ctx") or {})
    dispatch_id = str(payload.get("dispatchId") or "").lower()
    source = str(task.get("source") or "").lower()
    if (dispatch_id.startswith("chat:") or source == "soduwork \u65b0\u5efa\u4f1a\u8bdd" or
            bool(ctx.get("conversationMode")) or bool(ctx.get("conversationUserText"))):
        return INTERACTIVE
    trigger = " ".join(str(ctx.get(key) or "").lower() for key in (
        "trigger", "triggerType", "scheduleId", "automationRunId", "scheduleRunId"))
    if ("\u5b9a\u65f6" in source or "schedule" in source or "automation" in source or
            "scheduled" in trigger or bool(ctx.get("scheduleId")) or
            bool(ctx.get("scheduleRunId"))):
        return AUTOMATION
    return MANUAL


@dataclass
class ResourceSnapshot:
    cpu_percent: float = 0.0
    memory_percent: float = 0.0
    memory_available: int = 0
    cpu_count: int = 1
    limit: int = 1
    pressure: str = "normal"
    can_start: bool = True
    sampled_at: float = field(default_factory=time.time)

    def public(self) -> dict:
        return {
            "cpuPercent": round(self.cpu_percent, 1),
            "memoryPercent": round(self.memory_percent, 1),
            "memoryAvailableBytes": max(0, int(self.memory_available)),
            "cpuCount": max(1, int(self.cpu_count)),
            "adaptiveLimit": max(MIN_CONCURRENCY, min(MAX_CONCURRENCY, int(self.limit))),
            "resourcePressure": self.pressure,
            "resourceStartAllowed": bool(self.can_start),
            "resourceSampledAt": int(self.sampled_at),
        }


class _WindowsSampler:
    class _MemoryStatus(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    def __init__(self):
        self._last_cpu: tuple[int, int] | None = None

    @staticmethod
    def _filetime(value) -> int:
        return (int(value.dwHighDateTime) << 32) | int(value.dwLowDateTime)

    def __call__(self) -> dict:
        kernel32 = ctypes.windll.kernel32
        idle = wintypes.FILETIME()
        kernel = wintypes.FILETIME()
        user = wintypes.FILETIME()
        cpu = 0.0
        if kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)):
            idle_now = self._filetime(idle)
            total_now = self._filetime(kernel) + self._filetime(user)
            if self._last_cpu:
                idle_delta = max(0, idle_now - self._last_cpu[0])
                total_delta = max(1, total_now - self._last_cpu[1])
                cpu = 100.0 * max(0.0, min(1.0, 1.0 - idle_delta / total_delta))
            self._last_cpu = (idle_now, total_now)
        memory = self._MemoryStatus()
        memory.dwLength = ctypes.sizeof(self._MemoryStatus)
        available = total = 0
        if kernel32.GlobalMemoryStatusEx(ctypes.byref(memory)):
            available, total = int(memory.ullAvailPhys), int(memory.ullTotalPhys)
        return {"cpuPercent": cpu, "memoryAvailableBytes": available,
                "memoryTotalBytes": total}


class _ProcSampler:
    def __init__(self):
        self._last_cpu: tuple[int, int] | None = None

    def __call__(self) -> dict:
        cpu = 0.0
        available = total = 0
        try:
            with open("/proc/stat", encoding="ascii") as handle:
                fields = [int(x) for x in handle.readline().split()[1:]]
            idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
            aggregate = sum(fields)
            if self._last_cpu:
                idle_delta = max(0, idle - self._last_cpu[0])
                total_delta = max(1, aggregate - self._last_cpu[1])
                cpu = 100.0 * max(0.0, min(1.0, 1.0 - idle_delta / total_delta))
            self._last_cpu = (idle, aggregate)
        except (OSError, ValueError, IndexError):
            try:
                cpu = min(100.0, os.getloadavg()[0] * 100.0 / max(1, os.cpu_count() or 1))
            except (AttributeError, OSError):
                pass
        try:
            values = {}
            with open("/proc/meminfo", encoding="ascii") as handle:
                for line in handle:
                    key, raw = line.split(":", 1)
                    values[key] = int(raw.strip().split()[0]) * 1024
            total = values.get("MemTotal", 0)
            available = values.get("MemAvailable", values.get("MemFree", 0))
        except (OSError, ValueError, IndexError):
            pass
        return {"cpuPercent": cpu, "memoryAvailableBytes": available,
                "memoryTotalBytes": total}


def _system_sampler() -> Callable[[], dict]:
    return _WindowsSampler() if platform.system().lower() == "windows" else _ProcSampler()


class AdaptiveResourceBudget:
    """Convert machine pressure into a stable 1..20 process launch budget."""

    def __init__(self, ceiling: int = MAX_CONCURRENCY, sampler: Callable[[], dict] | None = None,
                 cache_seconds: float = 1.0):
        self.ceiling = max(MIN_CONCURRENCY, min(MAX_CONCURRENCY, int(ceiling or MAX_CONCURRENCY)))
        self.sampler = sampler or _system_sampler()
        self.cache_seconds = max(0.0, float(cache_seconds))
        self._lock = threading.Lock()
        self._snapshot = ResourceSnapshot(limit=1, cpu_count=max(1, os.cpu_count() or 1))
        self._sampled_mono = 0.0

    def snapshot(self, force: bool = False) -> ResourceSnapshot:
        now = time.monotonic()
        with self._lock:
            if not force and self._sampled_mono and now - self._sampled_mono < self.cache_seconds:
                return self._snapshot
            try:
                raw = dict(self.sampler() or {})
            except Exception:
                raw = {}
            cpu_count = max(1, int(raw.get("cpuCount") or os.cpu_count() or 1))
            cpu = _bounded_number(raw.get("cpuPercent"), 0.0, 100.0)
            available = max(0, int(raw.get("memoryAvailableBytes") or 0))
            total = max(0, int(raw.get("memoryTotalBytes") or 0))
            memory = _bounded_number(
                raw.get("memoryPercent"), 0.0, 100.0,
                (100.0 * (1.0 - available / total) if total else 0.0))
            cpu_slots = max(1, min(MAX_CONCURRENCY, (cpu_count + 1) // 2))
            memory_slots = (max(1, min(MAX_CONCURRENCY, available // int(1.25 * _GIB)))
                            if available else MAX_CONCURRENCY)
            limit = max(1, min(self.ceiling, cpu_slots, memory_slots))
            pressure, can_start = "normal", True
            if cpu >= 95.0 or memory >= 92.0 or (available and available < int(0.75 * _GIB)):
                pressure, can_start, limit = "critical", False, 1
            elif cpu >= 82.0 or memory >= 84.0 or (available and available < int(1.5 * _GIB)):
                pressure, limit = "busy", max(1, limit // 2)
            elif cpu >= 70.0 or memory >= 76.0:
                pressure, limit = "busy", max(1, (limit * 3) // 4)
            self._snapshot = ResourceSnapshot(
                cpu_percent=cpu, memory_percent=memory, memory_available=available,
                cpu_count=cpu_count, limit=limit, pressure=pressure,
                can_start=can_start, sampled_at=time.time())
            self._sampled_mono = now
            return self._snapshot


@dataclass
class AdmissionItem:
    key: str
    ref: str
    category: str
    operation: str
    payload: dict | None
    sequence: int
    accepted_at: float
    state: str = "queued"
    started_at: float = 0.0
    finished_at: float = 0.0
    error: str = ""
    cancel_requested: bool = False
    result: dict = field(default_factory=dict)
    launched: bool = False
    request_digest: str = ""
    accepted_selection: dict | None = None


def comment_digest(ref: str, payload: dict) -> str:
    """Keep immutable intent, without retaining prompts or renewable credentials."""
    value = {"ref": str(ref), "text": str(payload.get("text") or ""),
             "executionSelection": payload.get("executionSelection")}
    if payload.get("pluginTurn"):
        value["plugins"] = (payload["pluginTurn"].get("args") or {}).get("plugins")
    if payload.get("turnSkills"):
        value["skills"] = payload["turnSkills"]
    packet = payload.get("files") or {}
    if packet.get("items"):
        # Transfers can be re-uploaded after a proven negative receipt. Bind
        # the business ID to content, not a temporary transfer directory.
        value["files"] = [{key: item.get(key) for key in ("filename", "size", "sha256", "contentType")}
                          for item in packet["items"]]
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":")).encode()).hexdigest()


class AdmissionQueue:
    """Priority admission queue. Methods are called on the Runner event loop."""

    def __init__(self, task_capacity: int = DEFAULT_TASK_CAPACITY,
                 terminal_ttl: float = 3600.0, terminal_cap: int = 2000, journal=None):
        self.task_capacity = max(1, int(task_capacity or DEFAULT_TASK_CAPACITY))
        self.terminal_ttl = max(60.0, float(terminal_ttl))
        self.terminal_cap = max(100, int(terminal_cap))
        self._items: dict[str, AdmissionItem] = {}
        self._sequence = 0
        self._journal = journal
        if journal is not None:
            self._sequence = journal.last_sequence()
            for data in journal.read():
                item = AdmissionItem(**data)
                if item.state not in ACTIVE_STATES | TERMINAL_STATES or item.category not in PRIORITY:
                    raise ValueError("Invalid Runner queue journal state")
                self._items[item.key] = item
                self._sequence = max(self._sequence, item.sequence)
            self.prune()

    def _update(self, item, **changes):
        updated = replace(item, **changes)
        if self._journal is not None:
            self._journal.write(updated)
        item.__dict__.update(updated.__dict__)
        return item

    def recover(self, runs: dict) -> None:
        """Reconcile claimed work after native archives have been reclaimed.

        Only definitely queued work can launch automatically. A crash around
        process creation is not proof that an external operation did not happen.
        """
        for item in self.active_items():
            if item.state == "queued":
                continue
            run = runs.get(item.ref)
            matches = run and (item.operation == "dispatch" or run.get("admissionKey") == item.key)
            if matches:
                self.mark_running(item.key, item.result)
            else:
                self.finish(item.key, "failed", "执行机在启动临界点重启，无法确认本轮是否已执行；"
                            "已保留工作现场，请核对后再继续，系统不会自动重复发送。",
                            {"uncertain": True, "code": "RUNNER_START_UNCONFIRMED"})

    def submit(self, key: str, ref: str, category: str, operation: str,
               payload: dict) -> tuple[bool, str, AdmissionItem | None]:
        self.prune()
        key, ref = str(key or ""), str(ref or "")
        current = self.get(key)
        # A business key represents one operation for its whole lifetime. Replayed
        # transport messages must return the original receipt after completion too.
        if current:
            return True, "duplicate", current
        category = category if category in PRIORITY else MANUAL
        if category != INTERACTIVE and self.background_outstanding() >= self.task_capacity:
            return False, "capacity", None
        self._sequence += 1
        item = AdmissionItem(
            key=key, ref=ref, category=category, operation=str(operation or "dispatch"),
            payload=dict(payload or {}), sequence=self._sequence, accepted_at=time.time(),
            request_digest=comment_digest(ref, payload or {}) if operation == "comment" else "",
            accepted_selection=(payload or {}).get("_acceptedSelection"))
        if self._journal is not None:
            self._journal.write(item)
        self._items[key] = item
        return True, "accepted", item

    def _ordered_waiting(self) -> list[AdmissionItem]:
        return sorted((item for item in self._items.values() if item.state == "queued"),
                      key=lambda item: (PRIORITY[item.category], item.sequence))

    def position(self, key: str) -> int:
        for index, item in enumerate(self._ordered_waiting(), 1):
            if item.key == key:
                return index
        return 0

    def get(self, key: str) -> AdmissionItem | None:
        key = str(key or "")
        item = self._items.get(key)
        if item is None and key and self._journal is not None:
            row = self._journal.read_receipt(key)
            if row is not None:
                item = AdmissionItem(**row)
        return item

    def active_items(self) -> list[AdmissionItem]:
        return [item for item in self._items.values() if item.state in ACTIVE_STATES]

    def latest_for_ref(self, ref: str, include_running: bool = True,
                       include_terminal: bool = False) -> AdmissionItem | None:
        states = {"queued", "starting"} | ({"running"} if include_running else set())
        if include_terminal:
            states |= TERMINAL_STATES
        rows = [item for item in self._items.values()
                if item.ref == str(ref or "") and item.state in states]
        return max(rows, key=lambda item: item.sequence) if rows else None

    def claim_next(self, active: int, limit: int, can_start: bool,
                   blocked_refs: set[str] | None = None) -> AdmissionItem | None:
        limit = max(MIN_CONCURRENCY, min(MAX_CONCURRENCY, int(limit or 1)))
        if not can_start or int(active or 0) >= limit:
            return None
        waiting = self._ordered_waiting()
        if not waiting:
            return None
        active_refs = {item.ref for item in self._items.values()
                       if item.state in {"starting", "running"}}
        active_refs |= {str(ref) for ref in (blocked_refs or set()) if str(ref)}
        # A follow-up waiting behind its own still-running conversation is not runnable.
        # It must keep that conversation serial, but it must not freeze unrelated
        # background work when another execution slot is available.
        interactive_runnable = any(
            item.category == INTERACTIVE and item.ref not in active_refs
            for item in waiting)
        for item in waiting:
            if item.ref in active_refs:
                continue
            if item.category != INTERACTIVE:
                if interactive_runnable:
                    continue
                if limit > 1 and int(active or 0) >= limit - 1:
                    continue
            return self._update(item, state="starting", started_at=time.time())
        return None

    def mark_running(self, key: str, result: dict | None = None) -> AdmissionItem | None:
        item = self.get(key)
        if not item:
            return None
        return self._update(item, state="running", launched=True, payload=None,
                            result=dict(result or {}))

    def finish(self, key: str, state: str, error: str = "",
               result: dict | None = None) -> AdmissionItem | None:
        item = self.get(key)
        if not item:
            return None
        return self._update(item, state=state if state in TERMINAL_STATES else "failed",
                            error=str(error or "")[:1000], result=dict(result or item.result or {}),
                            payload=None, finished_at=time.time())

    def cancel_ref(self, ref: str) -> tuple[str, AdmissionItem | None, dict | None]:
        item = self.latest_for_ref(ref)
        if not item:
            return "missing", None, None
        if item.state == "queued":
            payload = item.payload
            self.finish(item.key, "cancelled")
            return "cancelled", item, payload
        self._update(item, cancel_requested=True)
        return item.state, item, None

    def background_outstanding(self) -> int:
        return sum(1 for item in self._items.values()
                   if item.category != INTERACTIVE and item.state in ACTIVE_STATES)

    def starting_count(self) -> int:
        return sum(1 for item in self._items.values() if item.state == "starting")

    def metrics(self) -> dict:
        queued = [item for item in self._items.values() if item.state == "queued"]
        return {
            "queueDepth": len(queued),
            "queuedConversations": sum(1 for item in queued if item.category == INTERACTIVE),
            "queuedTasks": sum(1 for item in queued if item.category != INTERACTIVE),
            "taskOutstanding": self.background_outstanding(),
            "taskQueueCapacity": self.task_capacity,
        }

    def receipt(self, item: AdmissionItem, duplicate: bool = False) -> dict:
        queued = item.state == "queued"
        state = ("queued" if queued else
                 ("running" if item.state in {"starting", "running"} else item.state))
        out = {
            "ref": item.ref, "state": state, "queued": queued,
            "admissionKey": item.key, "turnCorrelationVersion": 1,
            "queuePosition": self.position(item.key) if queued else 0,
            "queueClass": item.category, "operation": item.operation,
            "duplicate": bool(duplicate),
        }
        if item.error:
            out["error"] = item.error
        if item.accepted_selection is not None:
            out.update(acceptedSelection=item.accepted_selection,
                       acceptedSelectionRevision=item.sequence)
        return out

    def prune(self) -> None:
        now = time.time()
        terminal = sorted(
            (item for item in self._items.values() if item.state in TERMINAL_STATES),
            key=lambda item: item.finished_at or item.accepted_at, reverse=True)
        keep = {item.key for item in terminal[:self.terminal_cap]
                if now - (item.finished_at or item.accepted_at) <= self.terminal_ttl}
        for key, item in list(self._items.items()):
            if item.state in TERMINAL_STATES and key not in keep:
                if self._journal is not None:
                    self._journal.archive(item)
                self._items.pop(key, None)


def owns_status(item: AdmissionItem | None, local_exists: bool) -> bool:
    """Only pre-launch admission can replace an existing native session.

    A stop ACK cancels the ledger before the process has fully exited. Once a
    follow-up launched, the actual stream owns terminal state and final events.
    """
    return bool(item and (item.state in {"queued", "starting"} or not local_exists or
        (item.operation == "comment" and item.state in {"failed", "cancelled"} and not item.launched)))


def queued_session(item: AdmissionItem, position: int, since: int = 0) -> dict:
    """Return the broad shape of ai_local.session_sync while an operation waits."""
    status = ("queued" if item.state == "queued" else
              ("running" if item.state in {"starting", "running"} else item.state))
    return {
        "ok": True, "items": [], "status": status, "state": status,
        "admissionKey": item.key, "turnCorrelationVersion": 1,
        "last": max(0, int(since or 0)), "seq": 0, "segment": 1, "round": 1,
        "detached": False, "tokens": {}, "ctxPct": 0.0, "ctxWindow": 128000,
        "ctxWindowKnown": True, "ctxWindowEstimated": True,
        "ctxWindowSource": "safe-default", "error": item.error, "usage": {},
        "firstStarted": item.started_at or 0, "canStop": item.state in ACTIVE_STATES,
        "executionStartedAt": 0,
        "queued": item.state == "queued",
        "queuePosition": position if item.state == "queued" else 0,
        "queueClass": item.category,
    }


def with_native_history(queued: dict, native: dict) -> dict:
    """A refused follow-up changes its outcome, never erases prior turns.

    ``ok`` is successful snapshot retrieval; a failed turn is represented by
    status/error so clients do not retry a permanent preflight error as a
    temporary transport disconnect.
    """
    if not native.get("ok"):
        return queued
    if (native.get("status") == "running" and
            native.get("failureKind") == "access_reauthorization_cleanup"):
        # A refused follow-up cannot certify that its previous process exited.
        return dict(native)
    result = dict(native)
    for key in ("status", "state", "error", "canStop", "queued", "queuePosition", "queueClass",
                "admissionKey", "turnCorrelationVersion"):
        result[key] = queued[key]
    # The transcript belongs to previous turns; this admission never launched.
    result["executionStartedAt"] = 0
    return result


def status_data(item: AdmissionItem, position: int = 0) -> dict:
    state = standard_state(item.state)
    return {
        "ok": state != "failed", "status": state, "state": state,
        "admissionKey": item.key, "turnCorrelationVersion": 1,
        "running": state == "running", "done": state in TERMINAL_STATES,
        "queued": state == "queued", "queuePosition": position if state == "queued" else 0,
        "queueClass": item.category, "error": item.error,
        "canStop": item.state in ACTIVE_STATES,
    }


def info_data(item: AdmissionItem, position: int = 0) -> dict:
    status = status_data(item, position)
    return {
        "taskStatus": status["status"], "done": status["done"],
        "failed": status["status"] == "failed", "error": status["error"],
        "queued": status["queued"], "queuePosition": status["queuePosition"],
        "queueClass": status["queueClass"],
    }
