"""Stable data contracts for scheduled automation.

The scheduling loop and dispatch policy stay in schedules.py. This module owns the portable
values that remain verifiable across Hub restarts and Runner changes: public inputs, abstract
capabilities, personal-plugin snapshots and truthful run receipts.
"""
from __future__ import annotations

import math
import re
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models


DIRECT_CAPABILITIES = ("browser", "computer", "office")
_INPUT_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
# Match the client's personal-plugin key shape; Hub stores identity and verification metadata while content remains on the device.
_PERSONAL_PLUGIN_KEY = re.compile(r"^[a-z][a-z0-9-]{1,62}$")
_PERSONAL_PLUGIN_VERSION = re.compile(
    r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$")
_PERSONAL_PLUGIN_CHECKSUM = re.compile(r"^[a-f0-9]{64}$")
PERSONAL_PLUGIN_VERSION_POLICIES = ("latest", "pinned")


def clean_personal_plugin_key(raw) -> str:
    key = str(raw or "").strip()
    if not key:
        return ""
    if not _PERSONAL_PLUGIN_KEY.fullmatch(key):
        raise ValueError("个人插件标识不合法")
    return key


def clean_personal_plugin_version_policy(raw) -> str:
    value = str(raw or "").strip().lower()
    if not value:
        return "latest"
    if value not in PERSONAL_PLUGIN_VERSION_POLICIES:
        raise ValueError("个人插件版本策略不合法")
    return value


def clean_personal_plugin_version(raw) -> str:
    value = str(raw or "").strip()
    if value and not _PERSONAL_PLUGIN_VERSION.fullmatch(value):
        raise ValueError("个人插件版本不合法")
    return value


def clean_personal_plugin_checksum(raw) -> str:
    value = str(raw or "").strip().lower()
    if value and not _PERSONAL_PLUGIN_CHECKSUM.fullmatch(value):
        raise ValueError("个人插件校验值不合法")
    return value


def personal_plugin_spec(s) -> dict:
    """Return the portable schedule snapshot without exposing plugin content."""
    key = clean_personal_plugin_key(
        getattr(s, "personal_plugin_key", "") or "")
    if not key:
        return {}
    policy = clean_personal_plugin_version_policy(
        getattr(s, "personal_plugin_version_policy", "") or "")
    version = clean_personal_plugin_version(
        getattr(s, "personal_plugin_version", "") or "")
    checksum = clean_personal_plugin_checksum(
        getattr(s, "personal_plugin_checksum", "") or "")
    if policy == "pinned" and (not version or not checksum):
        raise ValueError("固定个人插件版本需要同时保存版本号和校验值，请重新选择该插件")
    if policy == "latest":
        version, checksum = "", ""
    return {
        "key": key, "versionPolicy": policy,
        "version": version, "checksum": checksum,
    }


def normalize_personal_plugin_snapshot(s) -> dict:
    spec = personal_plugin_spec(s)
    s.personal_plugin_key = str(spec.get("key") or "")
    s.personal_plugin_version_policy = str(spec.get("versionPolicy") or "latest")
    s.personal_plugin_version = str(spec.get("version") or "")
    s.personal_plugin_checksum = str(spec.get("checksum") or "")
    return spec


RUN_ACTIVE = ("starting", "running", "waiting")
RUN_TERMINAL = ("succeeded", "failed", "cancelled")
RUN_TRIGGERS = ("timer", "manual", "retry")


def clean_plugin_inputs(raw) -> dict:
    """Keep scheduled inputs small, typed and non-secret.

    Secret material is never accepted here; enterprise credentials remain SecretReference
    values on the approved binding and are resolved only for the executing node.
    """
    if not isinstance(raw, dict):
        return {}
    if len(raw) > 50:
        raise ValueError("插件输入最多 50 项；输入没有被截断保存")
    clean = {}
    for key, value in raw.items():
        key = str(key or "").strip()
        if not _INPUT_KEY.fullmatch(key):
            continue
        if isinstance(value, bool):
            clean[key] = value
        elif isinstance(value, (int, float)) and math.isfinite(value):
            clean[key] = value
        elif value is None:
            clean[key] = ""
        else:
            text = str(value)
            if len(text) > 8000:
                raise ValueError("插件输入 %s 超过 8000 字符；请缩短该参数，输入没有被截断保存" % key)
            clean[key] = text
    return clean


def clean_required_capabilities(raw) -> list[str]:
    from . import execution_capabilities
    supported = set(DIRECT_CAPABILITIES)
    return [key for key in execution_capabilities.normalize(raw) if key in supported]


def error_text(val) -> str:
    """Normalize structured dispatch failures to readable messages for storage and notifications
    rather than exposing Python dictionary representations.
    """
    if isinstance(val, dict):
        msg = str(val.get("message") or "").strip()
        return msg or str(val.get("code") or "").strip()
    return str(val or "").strip()


def apply_outcome(s, out: dict, now: datetime | None = None) -> dict:
    """Persist one attempt and schedule a bounded retry for direct automation."""
    current = now or datetime.now(timezone.utc)
    s.last_run_at = current
    if out.get("taskId"):
        s.last_task_id = str(out.get("taskId") or "")[:36]
    elif out.get("executionMode") == 'soduwork.automation-conversation/v1':
        s.last_task_id = ''
    if out.get("ok"):
        s.last_error = ""
        s.retry_count = 0
        s.next_retry_at = None
        return {"retrying": False}
    s.last_error = (error_text(out.get("error")) or "执行失败")[:400]
    plugin_mode = bool(str(getattr(s, "plugin_binding_id", "") or ""))
    limit = max(0, min(10, int(getattr(s, "retry_limit", 0) or 0)))
    count = max(0, int(getattr(s, "retry_count", 0) or 0))
    if not plugin_mode and count < limit:
        delay = max(1, min(1440, int(
            getattr(s, "retry_delay_minutes", 5) or 5)))
        s.retry_count = count + 1
        s.next_retry_at = current + timedelta(minutes=delay)
        return {"retrying": True, "retryCount": s.retry_count,
                "nextRetryAt": s.next_retry_at}
    s.retry_count = 0
    s.next_retry_at = None
    return {"retrying": False}


def derive_run_state(task_status: str = "", workflow_state: str = "",
                     ai_state: str = "", waiting_human: bool = False,
                     has_task: bool = True) -> str:
    """Map substrate-specific states to the stable automation receipt contract."""
    workflow_state = str(workflow_state or "").lower()
    task_status = str(task_status or "").lower()
    ai_state = str(ai_state or "").lower()
    if workflow_state == "succeeded":
        return "succeeded"
    if workflow_state == "failed":
        return "failed"
    if workflow_state in ("cancelled", "canceled"):
        return "cancelled"
    if task_status == "cancel":
        return "cancelled"
    if task_status == "done":
        return "succeeded"
    if ai_state == "failed":
        return "failed"
    if waiting_human or ai_state == "done":
        return "waiting"
    if workflow_state in ("queued", "running") or ai_state in (
            "dispatching", "running") or task_status == "doing":
        return "running"
    return "starting" if has_task else "starting"


def _run_time(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _run_iso(value: datetime | None) -> str:
    value = _run_time(value)
    return value.astimezone(timezone.utc).isoformat() if value else ""


def automation_conversation_title(schedule, started_at: datetime | None) -> str:
    """Return the stable title shared by manual and scheduled automation runs."""
    title = " ".join(str(getattr(schedule, "title", "") or "自动化").split()) or "自动化"
    zone_name = str(getattr(schedule, "time_zone", "") or "Asia/Shanghai").strip()
    try:
        zone = ZoneInfo(zone_name)
    except ZoneInfoNotFoundError:
        zone = ZoneInfo("Asia/Shanghai")
    started = _run_time(started_at) or datetime.now(timezone.utc)
    local = started.astimezone(zone)
    suffix = f" · {local:%Y-%m-%d %H:%M}"
    prefix = "自动化 · "
    title = title[:max(1, 200 - len(prefix) - len(suffix))]
    return f"{prefix}{title}{suffix}"


def _new_run(s, trigger: str, idempotency_key: str = ""):
    from .schedule_timing import snapshot
    trigger = trigger if trigger in RUN_TRIGGERS else "timer"
    retrying = trigger == "retry" and bool(getattr(s, "next_retry_at", None))
    attempt = max(1, int(getattr(s, "retry_count", 0) or 0) + 1) if retrying else 1
    # Every schedule run is an ordinary conversation. A personal plugin is a
    # local conversation lock, not a task/workflow association.
    try:
        plugin = personal_plugin_spec(s)
    except ValueError:
        # Keep the attempt durable; run_one() will return the actionable
        # validation error instead of losing the execution record.
        plugin = {}
    if plugin:
        plugin = {"scope": "personal", **plugin}
    mode = "personal" if plugin else "direct"
    requested = {
        "assigneeId": str(getattr(s, "assignee_id", "") or ""),
        "assigneeType": str(getattr(s, "assignee_type", "") or "agent"),
        "modelName": str(getattr(s, "model_name", "") or ""),
        "requiredCapabilities": clean_required_capabilities(
            getattr(s, "required_capabilities", None)),
    }
    origin = ({"triggerOrigin": "timer" if trigger == "timer" or (
        trigger == "retry" and bool(getattr(s, "once_fired", False))) else "manual"}
        if getattr(s, "every", "") == "once" else {})
    started_at = datetime.now(timezone.utc)
    return models.AiScheduleRun(
        idempotency_key=(str(idempotency_key or "")[:180]
                         or "manual:" + uuid.uuid4().hex),
        schedule_id=str(getattr(s, "id", "") or ""),
        org_id=getattr(s, "org_id", None),
        owner_client_id=str(getattr(s, "owner_client_id", "") or ""),
        owner_user_id=getattr(s, "owner_user_id", None),
        trigger=trigger, attempt=attempt, state="starting",
        receipt={"schema": "soduwork.automation-receipt/v1", "mode": mode,
                 "conversationTitle": automation_conversation_title(s, started_at),
                 "plugin": plugin, "inputSnapshot": clean_plugin_inputs(
                     getattr(s, "plugin_inputs", {}) or {}),
                 "route": {"requested": requested}, "timing": snapshot(s), **origin},
        started_at=started_at,
    )


async def begin_run(session: AsyncSession, s, trigger: str = "timer",
                    idempotency_key: str = ""):
    """Create a run inside the caller's transaction (manual/backward-compatible path)."""
    run = _new_run(s, trigger, idempotency_key)
    session.add(run)
    await session.flush()
    return run


async def claim_run(session: AsyncSession, s, trigger: str,
                    idempotency_key: str):
    """Atomically claim one timer/retry occurrence and persist it before side effects.

    The unique database index is authoritative. A losing Hub reads the winner's receipt;
    an expired outer lease may resume a still-starting receipt after a crash.
    """
    key = str(idempotency_key or "").strip()[:180]
    if not key:
        raise ValueError("scheduled run idempotency key is required")
    run = _new_run(s, trigger, key)
    session.add(run)
    try:
        await session.flush()
        await session.commit()
        return run, True
    except IntegrityError:
        await session.rollback()
        existing = await session.scalar(select(models.AiScheduleRun).where(
            models.AiScheduleRun.idempotency_key == key).limit(1))
        if existing is None:
            raise
        return existing, False


def apply_attempt_outcome(run, out: dict, now: datetime | None = None) -> None:
    """Record hand-off truth. An accepted dispatch is running, never succeeded."""
    current = now or datetime.now(timezone.utc)
    run.task_id = str(out.get("taskId") or "")[:36]
    run.workflow_run_id = str(out.get("workflowRunId") or "")[:36]
    receipt = dict(getattr(run, "receipt", None) or {})
    if out.get('code') and not out.get('ok'):
        receipt['errorCode'] = str(out['code'])[:100]
    for key in ("identifier", "warning", "deferredSchedule", "executionMode", "conversationId", "conversationTitle"):
        if key in out and out.get(key) not in (None, ""):
            receipt[key] = out.get(key)
    if isinstance(out.get("pluginSnapshot"), dict):
        receipt["plugin"] = {
            **dict(receipt.get("plugin") or {}), **dict(out["pluginSnapshot"]),
        }
    resolved = {
        "provider": str(out.get("provider") or ""),
        "assigneeId": str(out.get("assigneeId") or ""),
        "assigneeName": str(out.get("assigneeName") or ""),
        "agent": str(out.get("assigneeCli") or out.get("agentCli") or ""),
        "model": str(out.get("model") or ""),
        "runnerId": str(out.get("runnerId") or ""),
        "host": str(out.get("host") or ""),
    }
    if any(resolved.values()):
        route = dict(receipt.get("route") or {})
        route["resolved"] = resolved
        receipt["route"] = route
    run.receipt = receipt
    if out.get("ok"):
        run.state, run.error, run.finished_at = "running", "", None
        if out.get('waitingForDevice'):
            run.state = 'waiting'
    else:
        run.state = "failed"
        run.error = (error_text(out.get("error")) or "执行失败")[:1200]
        run.finished_at = current
