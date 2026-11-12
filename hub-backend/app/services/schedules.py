"""自动化节奏由服务端负责，每次触发保留独立运行记录。

每次自动化触发都发送到一条新建的普通对话，不额外创建任务或需求记录。
设备离线时记录启动失败；未接收和失联的运行有界收尾，不伪装成已经执行。

触发精度：`schedule_loop` 独立巡检（默认 120 秒一轮），不等待代码或产出巡检。
到点后的两分钟内检查计划；实际派发仍使用数据库租约与唯一运行记录去重。
"""
from __future__ import annotations

import logging
import hashlib
import calendar
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from . import resource_leases
from . import schedule_timing
from .schedule_execution import (
    CAPABILITY_SKILLS, _capability_remediation, capability_save_blocker,
    preflight_execution, required_skill_names, validate_direct_execution,
    validate_execution, normalize_conversation_schedule,
)
from .schedule_repo_scope import resolve_repo
from .schedule_run_contracts import (
    DIRECT_CAPABILITIES, PERSONAL_PLUGIN_VERSION_POLICIES,
    RUN_ACTIVE, RUN_TRIGGERS, derive_run_state,
    _run_iso, _run_time, apply_attempt_outcome, apply_outcome,
    automation_conversation_title, begin_run, claim_run,
    clean_personal_plugin_checksum, clean_personal_plugin_key,
    clean_personal_plugin_version, clean_personal_plugin_version_policy,
    clean_plugin_inputs, clean_required_capabilities,
    error_text, normalize_personal_plugin_snapshot, personal_plugin_spec,
)

log = logging.getLogger("uvicorn.error")
_SCHEDULE_OWNER = resource_leases.default_owner("schedule")
_SCHEDULE_LEASE_SECONDS = 10 * 60
CLOUD_PROTOCOL = 'soduwork.cloud-automation/v1'


EVERY = schedule_timing.EVERY


DEFAULT_TIME_ZONE = "Asia/Shanghai"


def clean_time_zone(value: str | None) -> str:
    """Return a validated IANA timezone name.

    The client sends its browser timezone with the schedule. Asia/Shanghai is
    the migration default for schedules created before this field existed.
    """
    name = str(value or DEFAULT_TIME_ZONE).strip()[:64] or DEFAULT_TIME_ZONE
    try:
        ZoneInfo(name)
    except ZoneInfoNotFoundError:
        if name not in (DEFAULT_TIME_ZONE, "UTC", "Etc/UTC"):
            return DEFAULT_TIME_ZONE
    return name


def schedule_zone(s):
    name = clean_time_zone(getattr(s, "time_zone", DEFAULT_TIME_ZONE))
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        # Keep development usable before requirements are refreshed on Windows.
        # Production installs tzdata and therefore supports the full IANA set.
        return timezone(timedelta(hours=8), DEFAULT_TIME_ZONE)


def _utc(value: datetime) -> datetime:
    """Normalize database instants.

    SQLite drops tzinfo even for DateTime(timezone=True). Those values were
    written as UTC, so treating a naive value as server-local time makes a
    daily schedule remain due for every two-minute sweep after its wall time.
    """
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _now_local(s=None) -> datetime:
    return datetime.now(timezone.utc).astimezone(schedule_zone(s))


def format_trigger_time(s, instant: datetime) -> str:
    """Readable run time in the schedule's zone, independent of the Hub's clock zone."""
    local = _utc(instant).astimezone(schedule_zone(s))
    zone_name = clean_time_zone(getattr(s, "time_zone", DEFAULT_TIME_ZONE))
    offset = local.strftime("%z")
    zone_label = "北京时间" if zone_name == DEFAULT_TIME_ZONE else f"UTC{offset[:3]}:{offset[3:]}"
    return f"{local:%Y-%m-%d %H:%M:%S}（{zone_label}）"


def _wall_candidate(day: date, hh: int, mm: int, zone) -> datetime:
    candidate = datetime(day.year, day.month, day.day, hh, mm, tzinfo=zone)
    # A nonexistent DST wall time (for example 02:30 during spring-forward)
    # is normalized to the first real local instant after the jump.
    return candidate.astimezone(timezone.utc).astimezone(zone)


def _date_allowed(day: date, start: date | None, end: date | None) -> bool:
    return (start is None or day >= start) and (end is None or day <= end)


def _next_hourly(s, base_utc: datetime, zone, minute: int,
                 start: date | None, end: date | None) -> datetime | None:
    probe = base_utc.replace(second=0, microsecond=0)
    local_probe = probe.astimezone(zone)
    if start and local_probe.date() < start:
        probe = _wall_candidate(start, 0, 0, zone).astimezone(timezone.utc)
    elif probe <= base_utc:
        probe += timedelta(minutes=1)
    for _ in range(181):
        local_probe = probe.astimezone(zone)
        if end and local_probe.date() > end:
            return None
        if _date_allowed(local_probe.date(), start, end) and local_probe.minute == minute and probe > base_utc:
            return probe
        probe += timedelta(minutes=1)
    raise RuntimeError("无法计算下一次小时计划")


def _next_calendar_run(s, base_utc: datetime, zone, every: str,
                       start: date | None, end: date | None) -> datetime | None:
    local = base_utc.astimezone(zone)
    hh = max(0, min(23, int(s.at_hour or 0)))
    mm = max(0, min(59, int(s.at_minute or 0)))
    first_day = max(local.date(), start) if start else local.date()
    if end and first_day > end:
        return None

    if every == "daily":
        for offset in range(0, 3):
            day = first_day + timedelta(days=offset)
            if end and day > end:
                return None
            candidate = _wall_candidate(day, hh, mm, zone).astimezone(timezone.utc)
            if candidate > base_utc:
                return candidate
        return None

    if every == "weekly":
        weekdays = schedule_timing.clean_weekdays(getattr(s, "weekdays", None))
        if not weekdays:
            weekdays = schedule_timing.clean_weekdays(getattr(s, "weekday", None))
        for offset in range(0, 14):
            day = first_day + timedelta(days=offset)
            if end and day > end:
                return None
            if day.isoweekday() not in weekdays:
                continue
            candidate = _wall_candidate(day, hh, mm, zone).astimezone(timezone.utc)
            if candidate > base_utc:
                return candidate
        return None

    month_days = schedule_timing.clean_month_days(getattr(s, "month_days", None))
    if not month_days:
        return None
    policy = str(getattr(s, "month_day_policy", "skip") or "skip")
    cursor = date(first_day.year, first_day.month, 1)
    for _ in range(3):
        last_day = calendar.monthrange(cursor.year, cursor.month)[1]
        candidates = set()
        for month_day in month_days:
            if month_day <= last_day:
                candidates.add(month_day)
            elif policy == "last_day":
                candidates.add(last_day)
        for month_day in sorted(candidates):
            day = date(cursor.year, cursor.month, month_day)
            if not _date_allowed(day, start, end):
                continue
            candidate = _wall_candidate(day, hh, mm, zone).astimezone(timezone.utc)
            if candidate > base_utc:
                return candidate
        if end and cursor > date(end.year, end.month, 1):
            return None
        if cursor.year == 9999 and cursor.month == 12:
            return None
        cursor = date(cursor.year + (cursor.month // 12), cursor.month % 12 + 1, 1)
    return None


def next_run_instant(s, after: datetime | None = None) -> datetime | None:
    """Return the next occurrence as an aware UTC instant."""
    if getattr(s, "every", "") == "once":
        return schedule_timing.next_once(s)
    base_utc = _utc(after) if after is not None else datetime.now(timezone.utc)
    zone = schedule_zone(s)
    every = s.every if getattr(s, "every", "") in EVERY else "daily"
    if every == "custom":
        return schedule_timing.next_custom_run(s, base_utc)
    start, end = schedule_timing.schedule_dates(s)

    try:
        if every == "hourly":
            return _next_hourly(s, base_utc, zone, max(0, min(59, int(s.at_minute or 0))), start, end)
        return _next_calendar_run(s, base_utc, zone, every, start, end)
    except OverflowError:
        return None


def next_run_after(s, after: datetime | None = None) -> datetime | None:
    """兼容界面与测试：naive 输入/输出表示计划当地墙上时间；aware 输入保持 aware。"""
    naive = after is not None and after.tzinfo is None
    if naive:
        after_utc = after.replace(tzinfo=schedule_zone(s)).astimezone(timezone.utc)
    else:
        after_utc = after
    instant = next_run_instant(s, after_utc)
    if instant is None:
        return None
    result = instant.astimezone(schedule_zone(s))
    return result.replace(tzinfo=None) if naive else result


def calendar_window_allows(s, current: datetime, occurrence: datetime | None = None) -> bool:
    """Allow the final dated occurrence one polling interval to be dispatched."""
    start, end = schedule_timing.schedule_dates(s)
    zone = schedule_zone(s)
    today = current.astimezone(zone).date()
    if _date_allowed(today, start, end):
        return True
    if end is None or today <= end or occurrence is None:
        return False
    if occurrence.astimezone(zone).date() != end:
        return False
    from ..config import get_settings
    gap = max(60, int(getattr(get_settings(), "delivery_sweep_seconds", 120)))
    lateness = (current - occurrence).total_seconds()
    return 0 <= lateness <= gap


def due(s, now: datetime | None = None) -> bool:
    """Whether the next scheduled instant or bounded retry is due now."""
    current = _utc(now) if now is not None else datetime.now(timezone.utc)
    if getattr(s, "every", "") == "once":
        target = schedule_timing.next_once(s)
        return target is not None and target <= current
    retry_at = getattr(s, "next_retry_at", None)
    if retry_at is not None:
        if getattr(s, "every", "") != "custom":
            start, end = schedule_timing.schedule_dates(s)
            if not _date_allowed(current.astimezone(schedule_zone(s)).date(), start, end):
                return False
        return _utc(retry_at) <= current

    base = s.last_run_at or s.created_at
    if base is None:
        return False
    next_at = next_run_instant(s, _utc(base))
    if next_at is None or next_at > current:
        return False
    return getattr(s, "every", "") == "custom" or calendar_window_allows(s, current, next_at)


def trigger_identity(s, trigger: str = "timer") -> str:
    """Stable identity for one automatic occurrence, independent of the Hub process."""
    trigger = "retry" if trigger == "retry" else "timer"
    if trigger == "retry" and getattr(s, "next_retry_at", None) is not None:
        instant = _utc(s.next_retry_at)
    elif getattr(s, "every", "") == "once":
        instant = getattr(s, "run_at", None)
        if not isinstance(instant, datetime):
            raise ValueError("一次性执行缺少固定日期时间")
        instant = _utc(instant)
    else:
        base = getattr(s, "last_run_at", None) or getattr(s, "created_at", None)
        if base is None:
            raise ValueError("plan has no scheduling origin")
        instant = next_run_instant(s, _utc(base))
        if instant is None:
            raise ValueError("计划已超出有效日期范围")
    stamp = instant.astimezone(timezone.utc).isoformat(
        timespec="microseconds" if getattr(s, "every", "") == "once" else "seconds")
    owner = (hashlib.sha256(str(getattr(s, "owner_client_id", "") or "").encode()).hexdigest() + ":"
             if getattr(s, "every", "") == "once" else "")
    return f"{trigger}:{str(getattr(s, 'id', '') or '')}:{owner}{stamp}"[:180]

# 自动化启动失败要当场告诉人，避免用户只看到没有会话而不知道原因。
# 同一计划同一类错误半天只推一次——hourly 的计划失败一天最多也就吵两回。
_FAIL_NOTIFIED: dict[str, tuple[int, float]] = {}
_FAIL_REPEAT_S = 12 * 3600


def _failure_hint(error: str) -> str:
    """按已知失败类别补一句「怎么办」，让人对着通知就能动手，不用猜。"""
    if "尚未获得本机授权" in error:
        return ("到 Agent 管理 → Runner → 管理本机能力里授权后，"
                "在自动化里点「立即执行」即可补跑。")
    if "版本过旧" in error:
        return "升级这台电脑的 SoduWork 客户端后，重新启用这条自动化。"
    if "免费办公文档引擎" in error or "缺少" in error:
        return "到 Agent 管理 → Runner 查看能力探测详情，补齐环境后点「立即执行」。"
    return ""


async def _account_can_run(session: AsyncSession, s, client) -> bool:
    from .schedule_access import is_owner
    # Administrator delegation is frozen to the target account at creation.
    # The creator's role cannot grant a later login access to private work.
    return is_owner(s, client)


async def _notify_failure(session: AsyncSession, s, out: dict) -> None:
    import time as _time
    error = error_text(out.get("error")) or str(s.last_error or "").strip()
    if not error or not getattr(s, "owner_client_id", ""):
        return
    client = await session.get(models.Client, s.owner_client_id, populate_existing=True)
    if client is None or not await _account_can_run(session, s, client):
        return
    key = str(s.id)
    mark = _FAIL_NOTIFIED.get(key)
    now = _time.time()
    if mark and mark[0] == hash(error) and now - mark[1] < _FAIL_REPEAT_S:
        return
    _FAIL_NOTIFIED[key] = (hash(error), now)
    text = "⏰自动化「%s」没能启动：%s" % (
        (s.title or "定时任务")[:60], error[:200])
    hint = _failure_hint(error)
    if hint:
        text += " " + hint
    try:
        from ..realtime import hub
        message = {"type": "notice", "text": text, "kind": "flow_failed"}
        await hub.publish(s.owner_client_id, message, user_id=client.user_ref or "")
    except Exception as exc:  # noqa: BLE001 - 推送失败不影响结算
        log.warning("推送自动化失败通知失败：%s", type(exc).__name__)


async def execute_one(session: AsyncSession, s, trigger: str = "timer",
                      who: str = "SoduWork（自动化）",
                      idempotency_key: str = "",
                      execution_instance: str = "") -> dict:
    """Create an immutable attempt before handing work to a substrate."""
    # Normalize before claiming the occurrence.  Otherwise a legacy row could
    # leak plugin/workflow fields into the immutable receipt before run_one()
    # reaches the ordinary-conversation adapter.
    normalize_conversation_schedule(s)
    if getattr(s, "every", "") == "once" and trigger != "manual" and not s.enabled:
        return {"ok": True, "deduplicated": True, "scheduleRunState": "paused"}
    if idempotency_key:
        run, claimed = await claim_run(session, s, trigger, idempotency_key)
        # The claim is committed before external work. Reload both rows so crash recovery
        # observes the winner's durable receipt without async lazy-loading surprises.
        await session.refresh(s)
        await session.refresh(run)
        if not claimed and (
                run.state != "starting" or run.task_id or run.workflow_run_id or
                dict(run.receipt or {}).get("executionMode")):
            recovered = {}
            handed_off = bool(run.task_id or run.workflow_run_id or dict(run.receipt or {}).get("executionMode") or
                              run.state in ("running", "waiting", "succeeded"))
            if (getattr(s, "every", "") == "once" or
                    dict(run.receipt or {}).get("timing", {}).get("every") == "once"):
                # Recovery writes the same consumption marker as normal settlement.
                # Refresh under its row lock before checking a possibly replaced plan.
                s = await schedule_timing.locked_schedule(session, s.id)
            if (s is not None and getattr(s, "every", "") == "once" and not s.once_fired and run.trigger == "timer" and
                    schedule_timing.matches(s, run) and (run.state != "cancelled" or handed_off)):
                recovered = schedule_timing.settle(s, run, {"ok": handed_off, "error": run.error},
                                                   outcome_of=apply_outcome)
                await session.flush()
            return {
                "ok": run.state != "failed", "deduplicated": True,
                "error": run.error or "",
                "scheduleRunId": run.id, "scheduleRunState": run.state, **recovered,
            }
    else:
        run = await begin_run(session, s, trigger)
    if execution_instance:
        # Manual UI launches reserve the occurrence before the local inbox
        # worker can observe the committed run.  This removes the race between
        # the button response and the worker's 250ms polling loop.
        from . import schedule_conversations
        if not schedule_conversations.reserve_run(run, execution_instance):
            return {"ok": False, "error": "本次自动化正在另一台执行端启动，请稍后查看执行记录",
                    "scheduleRunId": run.id, "scheduleRunState": run.state}
    if not schedule_timing.matches(s, run):
        run.state, run.error = "cancelled", "预约日期或归属已变更，本次原预约未继续派发"
        run.finished_at = datetime.now(timezone.utc)
        await session.flush()
        return {"ok": True, "deduplicated": True, "scheduleRunId": run.id,
                "scheduleRunState": run.state, "staleTiming": True}
    if getattr(s, "every", "") == "once" and trigger != "manual" and not s.enabled:
        run.receipt = {**dict(run.receipt or {}), "phase": "paused_before_dispatch"}
        await session.flush()
        return {"ok": True, "deduplicated": True, "scheduleRunId": run.id,
                "scheduleRunState": run.state}
    if dict(run.receipt or {}).get("phase") == "paused_before_dispatch":
        receipt = dict(run.receipt)
        receipt.pop("phase", None)
        run.receipt = receipt
    once_attempt = (getattr(s, "every", "") == "once" or
                    dict(run.receipt or {}).get("timing", {}).get("every") == "once")
    schedule_id, plan_exists = s.id, True
    # Adapter failures may roll back the transaction and expire both ORM rows.
    # Capture display/diagnostic values before crossing that boundary.
    run_id = run.id
    conversation_title = automation_conversation_title(s, run.started_at)
    try:
        out = await run_one(session, s, who=who, schedule_run_id=run_id,
                            conversation_title=conversation_title)
    except Exception as exc:  # noqa: BLE001 - the receipt must survive adapter failures
        log.exception("自动化启动异常：schedule=%s run=%s", schedule_id, run_id)
        out = {"ok": False, "error": str(exc)[:300]}
    out.setdefault('conversationTitle', conversation_title)
    # The conversation handoff may commit while preparing the local receipt.
    # Refresh both rows before settling so async ORM never lazy-loads expired state.
    try:
        if once_attempt:
            fresh = await schedule_timing.locked_schedule(session, schedule_id)
            if fresh is not None:
                s = fresh
            else:
                plan_exists = False
        else:
            await session.refresh(s)
    except Exception:  # noqa: BLE001 - 计划行可能刚被删除；结算尽力而为
        if once_attempt:
            plan_exists = False
    try:
        await session.refresh(run)
    except Exception:  # noqa: BLE001
        # begin_run 只 flush 未 commit：内层 rollback 会把回执行整个吞掉，
        # 这次失败就从执行记录里凭空消失。把对象加回去重插（id/started_at 还在），
        # 失败也必须留痕。
        session.add(run)
    retry = schedule_timing.settle(s, run, out, outcome_of=apply_outcome) if plan_exists else {"retrying": False}
    apply_attempt_outcome(run, out)
    await session.flush()
    return {**out, **retry, "scheduleRunId": run.id,
            "scheduleRunState": run.state}


async def reconcile_runs(session: AsyncSession, *, schedule_id: str = "",
                         owner_client_id: str = "", owner_user_id: str | None = None,
                         limit: int = 200) -> list:
    """Reconcile active ordinary-conversation receipts without task truth."""
    from . import schedule_device_liveness
    await schedule_device_liveness.reconcile_expired(
        session, schedule_id=schedule_id, owner_client_id=owner_client_id,
        owner_user_id=owner_user_id, limit=limit)
    cloud_mode = models.AiScheduleRun.receipt["executionMode"].as_string() == CLOUD_PROTOCOL
    damaged_cloud = cloud_mode & (
        models.AiScheduleRun.receipt["migratedFrom"].as_string() == "legacy-task-workflow")
    state_filter = or_(models.AiScheduleRun.state.in_(RUN_ACTIVE), damaged_cloud)
    # Include every old task/workflow-linked row when a schedule's history is
    # opened. It is migrated below in one place, so the UI never exposes a
    # retired task status or attempts to recover the old workflow.
    legacy_links = or_(models.AiScheduleRun.workflow_run_id != "",
                       models.AiScheduleRun.task_id != "")
    if schedule_id:
        state_filter = or_(state_filter, legacy_links)
    q = select(models.AiScheduleRun).where(state_filter)
    if schedule_id:
        q = q.where(models.AiScheduleRun.schedule_id == schedule_id)
    if owner_client_id:
        q = q.where(models.AiScheduleRun.owner_client_id == owner_client_id)
    if owner_user_id is not None:
        q = q.where(models.AiScheduleRun.owner_user_id == owner_user_id if owner_user_id
                    else models.AiScheduleRun.owner_user_id.is_(None))
    active = list((await session.execute(
        q.order_by(models.AiScheduleRun.started_at.desc()).limit(
            max(1, min(500, int(limit or 200)))).execution_options(populate_existing=True))).scalars().all())
    if not active:
        return active
    now = datetime.now(timezone.utc)
    # Repair only cloud links accidentally cleared by the legacy migration.
    # The immutable handoff must confirm both the run identity and its owner.
    from ..conversation_handoff_models import ConversationHandoff
    for item in active:
        receipt = dict(item.receipt or {})
        if (receipt.get("executionMode") != CLOUD_PROTOCOL or item.task_id or
                receipt.get("migratedFrom") != "legacy-task-workflow"):
            continue
        occurrence = str(item.schedule_id) + ':' + str(item.id)
        request_id = 'schedule-' + hashlib.sha256(occurrence.encode('utf-8')).hexdigest()
        if receipt.get("conversationId") != request_id:
            continue
        handoff = await session.scalar(select(ConversationHandoff).where(
            ConversationHandoff.transfer_id == request_id,
            ConversationHandoff.owner_client_id == item.owner_client_id,
            ConversationHandoff.owner_user_id == item.owner_user_id,
            ConversationHandoff.task_id == str(receipt.get("taskId") or "")))
        if handoff is None:
            continue
        item.task_id = handoff.task_id
        item.error, item.finished_at = "", None
        receipt.pop("migratedFrom", None)
        item.receipt = receipt
    # Cloud automation runs are owned by the Hub task/AI session after the
    # handoff is accepted. Project that authoritative state into the compact
    # automation receipt so history does not remain permanently "running" and
    # failure notifications retain the real remote reason.
    cloud_runs = [item for item in active
                  if dict(item.receipt or {}).get("executionMode") == CLOUD_PROTOCOL
                  and str(item.task_id or "")]
    if cloud_runs:
        from . import tasks as task_service
        task_ids = list({str(item.task_id) for item in cloud_runs})
        task_rows = list((await session.execute(
            select(models.Task).where(models.Task.id.in_(task_ids))
        )).scalars().all())
        task_by_id = {str(item.id): item for item in task_rows}
        ai_by_task = await task_service.ai_states(session, task_ids)
        for item in cloud_runs:
            task = task_by_id.get(str(item.task_id))
            report = dict(ai_by_task.get(str(item.task_id)) or {})
            if task is None:
                continue
            task_status = str(getattr(task, "status", "") or "").lower()
            if task_status in {"cancelled", "canceled"}:
                task_status = "cancel"
            remote_state = derive_run_state(
                task_status=task_status,
                ai_state=str(report.get("executionState") or report.get("state") or ""),
                has_task=True,
            )
            # A cloud automation is a conversation, with no requirement acceptance gate.
            if (str(report.get("executionState") or report.get("state") or "") == "done"
                    and task_status != "cancel"):
                remote_state = "succeeded"
            # A newly-created cloud Task can briefly be todo before its first
            # dispatch event. Preserve accepted/running instead of regressing
            # the receipt to starting during that short interval.
            if remote_state == "starting" and item.state in {"running", "waiting"}:
                remote_state = item.state
            receipt = dict(item.receipt or {})
            receipt["remoteState"] = remote_state
            receipt["taskStatus"] = task_status
            if report.get("executionState"):
                receipt["executionState"] = str(report["executionState"])
            item.receipt = receipt
            if remote_state in {"succeeded", "failed", "cancelled"}:
                item.state = remote_state
                item.error = (str(report.get("error") or "")[:1200]
                              if remote_state == "failed" else "")
                item.finished_at = item.finished_at or now
            elif remote_state in {"running", "waiting"}:
                item.state = remote_state
                item.finished_at = None
    for item in active:
        receipt = dict(item.receipt or {})
        if receipt.get("executionMode") == CLOUD_PROTOCOL:
            continue  # Cloud state was projected above; never retire its task link.
        if item.task_id or item.workflow_run_id:
            # A legacy run cannot be turned into an ordinary chat after the
            # fact. Remove its task/workflow ownership and leave a truthful
            # terminal record that asks the user to run the automation again.
            item.task_id = ""
            item.workflow_run_id = ""
            receipt.pop("taskStatus", None)
            receipt.pop("workflowState", None)
            receipt["migratedFrom"] = "legacy-task-workflow"
            item.receipt = receipt
            item.state = "failed"
            item.error = "旧版自动化已迁移为普通会话，请重新执行"
            item.finished_at = item.finished_at or now
            continue
        if await schedule_timing.reconcile_pending(session, item, now):
            continue
        if receipt.get('executionMode') in {
                'soduwork.automation-conversation/v1', CLOUD_PROTOCOL}:
            continue  # The ordinary conversation reports its own state.
        # Ordinary conversation workers own their own state transitions. A
        # starting row without a receipt remains visible until the worker
        # claims it; no task/workflow lookup is performed here.
    return active


def run_to_api(run) -> dict:
    started = _run_time(run.started_at)
    finished = _run_time(run.finished_at)
    duration = max(0, int((finished - started).total_seconds())) if started and finished else None
    return {
        "id": run.id, "scheduleId": run.schedule_id, "trigger": run.trigger,
        "state": run.state, "attempt": int(run.attempt or 1),
        "startedAt": _run_iso(run.started_at),
        "finishedAt": _run_iso(run.finished_at), "durationSeconds": duration,
        "error": run.error, "receipt": dict(run.receipt or {}),
        "conversationId": dict(run.receipt or {}).get('conversationId', ''),
        "conversationTitle": dict(run.receipt or {}).get('conversationTitle', ''),
    }


async def list_runs(session: AsyncSession, schedule_id: str, *,
                    owner_client_id: str = "", owner_user_id: str | None = None,
                    limit: int = 20) -> list[dict]:
    await reconcile_runs(session, schedule_id=schedule_id,
                         owner_client_id=owner_client_id, owner_user_id=owner_user_id)
    q = select(models.AiScheduleRun).where(
        models.AiScheduleRun.schedule_id == schedule_id)
    if owner_client_id:
        q = q.where(models.AiScheduleRun.owner_client_id == owner_client_id)
    if owner_user_id is not None:
        q = q.where(models.AiScheduleRun.owner_user_id == owner_user_id if owner_user_id
                    else models.AiScheduleRun.owner_user_id.is_(None))
    rows = list((await session.execute(
        q.order_by(models.AiScheduleRun.started_at.desc()).limit(
            max(1, min(100, int(limit or 20)))))).scalars().all())
    return [run_to_api(item) for item in rows]


async def run_one(session: AsyncSession, s, who: str = "SoduWork（定时）",
                  schedule_run_id: str = "", conversation_title: str = "") -> dict:
    """Run one automation occurrence as an ordinary conversation."""
    if not s.owner_client_id:
        return {"ok": False, "error": "没配自动化落在哪台 SoduWork 上"}
    client = await session.get(models.Client, s.owner_client_id, populate_existing=True)
    if client is None:
        return {"ok": False, "error": "配的那台 SoduWork 不在了"}
    if not await _account_can_run(session, s, client):
        return {"ok": False, "code": "SCHEDULE_OWNER_CHANGED",
                "error": "执行设备的登录账号已变更，请原账号登录后再执行"}
    normalize_conversation_schedule(s)
    try:
        repo = await resolve_repo(session, s, client=client)
        await validate_execution(session, s)
        personal = personal_plugin_spec(s)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)[:300]}

    from . import schedule_conversations
    # Mobile/Web schedules may target another personal desktop or an
    # independent cloud Runner. Use the account-scoped cloud conversation path
    # directly so the target does not depend on the creator device's inbox.
    # The request id is deterministic per occurrence, so retrying resumes one
    # handoff instead of dispatching twice.
    aid = str(s.assignee_id or '')
    if aid.startswith('runner:'):
        from . import cloud_conversations, runner_hub
        parts = aid.split(':', 2)
        runner = runner_hub.get(parts[1]) if len(parts) == 3 else None
        if runner is None:
            return {'ok': False, 'code': 'AUTOMATION_TARGET_OFFLINE',
                    'error': '所选执行机不在线，本次未执行；恢复连接后重试，不会改派其他电脑或云端'}
        cross_device = bool(runner and (
            str(getattr(runner, 'client_id', '') or '') != str(client.id or '') or
            not str(getattr(runner, 'client_id', '') or '')))
        if cross_device:
            if not schedule_run_id:
                return {'ok': False, 'code': 'AUTOMATION_RUN_REQUIRED',
                        'error': '自动化运行记录尚未建立，请从自动化入口重新执行'}
            run = await session.get(models.AiScheduleRun, schedule_run_id,
                                    populate_existing=True)
            if run is None:
                return {'ok': False, 'code': 'AUTOMATION_RUN_REQUIRED',
                        'error': '自动化运行记录尚未建立，请从自动化入口重新执行'}
            if personal or str(getattr(s, 'plugin_binding_id', '') or ''):
                return {'ok': False, 'code': 'CLOUD_AUTOMATION_UNSUPPORTED_BINDING',
                        'error': '云端自动化当前只支持普通会话；个人插件和企业工作流请选择已授权的执行端'}
            cli = parts[2]
            # Cloud handoff identifiers allow only letters, digits and hyphens.
            occurrence = str(s.id) + ':' + str(schedule_run_id)
            request_id = 'schedule-' + hashlib.sha256(occurrence.encode('utf-8')).hexdigest()
            title = str(s.title or '自动化')
            instruction = title + '\n\n' + str(s.note or '')
            if repo:
                instruction += '\n\n工程：' + str(repo.name or '')
            # Retrying an occurrence must keep the cloud request digest stable.
            instruction_prefix = instruction + '\n\n自动化触发时间：'
            instruction = instruction_prefix + format_trigger_time(s, run.started_at)
            from .schedule_instruction import for_run
            required = clean_required_capabilities(s.required_capabilities)
            runner_kind = 'work-computer' if runner.client_id else 'cloud'
            request = {
                'sessionId': request_id, 'agentId': cli,
                'model': str(getattr(s, 'model_name', '') or ''),
                'title': title, 'text': for_run(instruction), 'userText': instruction,
                'requiredSkills': required_skill_names(required),
                'targetRunnerId': runner.id, 'targetRunnerKind': runner_kind,
            }
            try:
                result = await cloud_conversations.create(session, client, request_id, request, [])
            except HTTPException as exc:
                if exc.status_code != 409 or exc.detail != (
                        '此云端会话请求编号已用于另一条消息或附件，请使用原请求重试'):
                    raise
                # A pre-upgrade handoff may have committed before its run receipt.
                # Resume only if the original ISO text still matches its digest.
                legacy_instruction = instruction_prefix + _utc(run.started_at).astimezone(schedule_zone(s)).isoformat()
                result = await cloud_conversations.create(session, client, request_id, {
                    **request, 'text': legacy_instruction, 'userText': legacy_instruction,
                }, [])
            await session.refresh(run)
            receipt = dict(run.receipt or {})
            receipt.update({
                'executionMode': CLOUD_PROTOCOL, 'conversationId': request_id,
                'conversationTitle': conversation_title,
                'taskId': result.get('taskId', ''), 'ref': result.get('ref', ''),
                'targetRunnerId': runner.id, 'targetRunnerKind': runner_kind,
                'phase': 'cloud',
            })
            run.receipt = receipt
            await session.flush()
            return {'ok': True, 'executionMode': CLOUD_PROTOCOL,
                    'conversationId': request_id, 'taskId': result.get('taskId', ''),
                    'conversationTitle': conversation_title,
                    'runnerId': runner.id, 'host': runner.host}
    # Normalize legacy rows before selecting the execution adapter.  This is
    # deliberately repeated at the dispatch boundary so an old database row
    # cannot route one more run through the task/workflow engine.
    normalize_conversation_schedule(s)
    adapter = schedule_conversations.adapter_for(s, client)
    if not adapter:
        return {"ok": False, "code": "AUTOMATION_CONVERSATION_UNAVAILABLE",
                "error": "当前执行设备没有可用的普通会话执行端，请升级客户端后重试"}
    from .schedule_device_liveness import device_available
    if not device_available(client):
        return {"ok": False, "code": "AUTOMATION_TARGET_OFFLINE",
                "error": "执行端不在线，本次未执行。请启动原执行设备上的客户端后重试；不会自动改派其他设备。"}
    return await schedule_conversations.prepare(
        session, s, client, repo, schedule_run_id, adapter, personal)


async def tick(session: AsyncSession) -> dict:
    """Reconcile receipts and claim each due occurrence on exactly one Hub instance."""
    try:
        await reconcile_runs(session)
        await session.commit()
    except Exception:  # Receipt projection failure must not suppress unrelated due work.
        log.exception("自动化执行记录对账失败，继续检查到期计划")
        await session.rollback()
    schedule_ids = list((await session.execute(
        select(models.AiSchedule.id).where(
            models.AiSchedule.enabled.is_(True)))).scalars().all())
    fired = contended = deduplicated = 0
    for schedule_id in schedule_ids:
        lease = None
        identity = ""
        entered_execute = False
        # Include timing and lease acquisition in the per-plan boundary: an old
        # malformed row or transient lease error must not starve later owners.
        try:
            s = await session.get(models.AiSchedule, schedule_id)
            if s is None or not s.enabled or not due(s):
                continue
            trigger = schedule_timing.trigger_for(s)
            identity = trigger_identity(s, trigger)
            lease = await resource_leases.acquire(
                session, "schedule-trigger", identity, owner=_SCHEDULE_OWNER,
                ttl_seconds=_SCHEDULE_LEASE_SECONDS,
                detail={"scheduleId": schedule_id, "trigger": trigger})
            await session.refresh(s)
            if not s.enabled or not due(s):
                continue
            fresh_trigger = schedule_timing.trigger_for(s)
            fresh_identity = trigger_identity(s, fresh_trigger)
            if fresh_identity != identity:
                # Another owner completed the stale occurrence before this lease was acquired.
                continue
            entered_execute = True
            out = await execute_one(
                session, s, trigger=fresh_trigger, idempotency_key=fresh_identity)
            await session.commit()
        except resource_leases.LeaseBusy:
            contended += 1
            continue
        except Exception as exc:  # noqa: BLE001
            log.exception("定时派活单条异常：schedule=%s", schedule_id)
            await session.rollback()
            # Pre-claim infrastructure errors have not consumed an occurrence.
            # Keep its clock and retry budget intact so the same identity resumes.
            try:
                s = await session.get(models.AiSchedule, schedule_id)
                if s is None:
                    continue
                await session.refresh(s)
                claimed = None
                if entered_execute and identity:
                    claimed = await session.scalar(select(models.AiScheduleRun.id).where(
                        models.AiScheduleRun.idempotency_key == identity).limit(1))
                if getattr(s, "every", "") == "once" or claimed is None:
                    # Unclaimed work remains due. Once plans also preserve their
                    # durable claim until recovery verifies any external effects.
                    s.last_error = str(exc)[:300]
                else:
                    apply_outcome(s, {"ok": False, "error": str(exc)[:300]})
                await session.commit()
                await _notify_failure(session, s, {"error": str(exc)[:300]})
            except Exception:  # noqa: BLE001
                await session.rollback()
            continue
        finally:
            if lease is not None:
                try:
                    await resource_leases.release(session, lease)
                except Exception as exc:  # noqa: BLE001
                    await session.rollback()
                    log.warning("释放定时触发租约失败：%s", type(exc).__name__)
        if out.get("deduplicated"):
            deduplicated += 1
        elif out.get("ok"):
            fired += 1
            log.info("自动化「%s」已交付普通会话（记录 %s）",
                     s.title, out.get("scheduleRunId"))
        else:
            log.warning("自动化启动失败「%s」：%s", s.title, s.last_error)
            await _notify_failure(session, s, out)
    return {"checked": len(schedule_ids), "fired": fired,
            "contended": contended, "deduplicated": deduplicated}
