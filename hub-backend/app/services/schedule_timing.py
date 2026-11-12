"""Fixed-date timing shares the schedule ledger; it is not a second job queue."""
from __future__ import annotations

import re
from datetime import date, datetime, timezone
from .schedule_custom import parse_custom_rule, next_custom_run

EVERY = ("hourly", "daily", "weekly", "monthly", "custom", "once")
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def iso(value) -> str:
    return utc(value).isoformat() if isinstance(value, datetime) else ""


def parse_run_at(raw) -> datetime:
    if not isinstance(raw, str) or not _ISO.fullmatch(raw):
        raise ValueError("一次性执行时间必须是带时区的 ISO 日期时间，例如 2030-10-20T12:00:00+08:00")
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, OverflowError) as exc:
        raise ValueError("一次性执行日期时间无效，请重新选择") from exc


def parse_schedule_date(raw, field="日期") -> str | None:
    """Return a canonical local calendar date or raise a user-facing error."""
    if raw in (None, ""):
        return None
    value = str(raw).strip()
    if not _DATE.fullmatch(value):
        raise ValueError(f"{field}必须是 YYYY-MM-DD 格式")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{field}无效，请重新选择") from exc
    return value


def clean_weekdays(raw) -> list[int]:
    values = raw if isinstance(raw, (list, tuple, set)) else ([] if raw in (None, "") else [raw])
    result = set()
    for value in values:
        try:
            number = int(value)
        except (TypeError, ValueError):
            continue
        if 1 <= number <= 7:
            result.add(number)
    return sorted(result)


def clean_month_days(raw) -> list[int]:
    values = raw if isinstance(raw, (list, tuple, set)) else ([] if raw in (None, "") else [raw])
    result = set()
    for value in values:
        try:
            number = int(value)
        except (TypeError, ValueError):
            continue
        if 1 <= number <= 31:
            result.add(number)
    return sorted(result)


def schedule_dates(s) -> tuple[date | None, date | None]:
    start = parse_schedule_date(getattr(s, "start_date", None), "开始日期")
    end = parse_schedule_date(getattr(s, "end_date", None), "结束日期")
    start_date = date.fromisoformat(start) if start else None
    end_date = date.fromisoformat(end) if end else None
    if start_date and end_date and start_date > end_date:
        raise ValueError("开始日期不能晚于结束日期")
    return start_date, end_date


def validate(s) -> None:
    every = getattr(s, "every", "") or "daily"
    if every not in EVERY:
        raise ValueError("请选择支持的执行方式")
    if every == "once" and not isinstance(getattr(s, "run_at", None), datetime):
        raise ValueError("请选择一次性执行的固定日期和时间")
    if every == "once":
        return
    if every == "custom":
        parse_custom_rule(getattr(s, "custom_rule", None),
                          default_zone=getattr(s, "time_zone", "Asia/Shanghai"))
        return
    schedule_dates(s)
    if every == "weekly":
        weekdays = clean_weekdays(getattr(s, "weekdays", None))
        if not weekdays:
            weekdays = clean_weekdays(getattr(s, "weekday", None))
        if not weekdays:
            raise ValueError("请选择至少一个星期")
    if every == "monthly":
        if not clean_month_days(getattr(s, "month_days", None)):
            raise ValueError("请选择至少一个月度日期")
        if str(getattr(s, "month_day_policy", "skip") or "skip") not in ("skip", "last_day"):
            raise ValueError("月度无效日期处理方式无效")


def apply(s, body: dict, now: datetime | None = None) -> None:
    """Only an actual future date change rearms an appointment; clients cannot set its marker."""
    old_every = getattr(s, "every", None) or "daily"
    every = body.get("every", old_every)
    every = every if every in EVERY else "daily"  # Preserve legacy enum fallback.
    original = getattr(s, "run_at", None)
    if every == "once":
        target = parse_run_at(body["runAt"]) if "runAt" in body else original
        if not isinstance(target, datetime):
            raise ValueError("请选择一次性执行的固定日期和时间")
        target = utc(target)
        changed = old_every != "once" or not isinstance(original, datetime) or utc(original) != target
        if changed and target <= (utc(now) if now is not None else datetime.now(timezone.utc)):
            raise ValueError("一次性执行时间必须晚于当前时间，请重新选择未来日期")
        s.every, s.run_at = "once", target
        s.weekdays, s.month_days = [], []
        s.month_day_policy, s.start_date, s.end_date = "skip", None, None
        s.custom_rule = ""
        if changed:
            s.once_fired = False
            s.retry_count, s.next_retry_at = 0, None
        elif bool(getattr(s, "once_fired", False)) and not getattr(s, "next_retry_at", None):
            s.enabled = False  # Enabling the same consumed appointment never replays it.
    else:
        if body.get("runAt") not in (None, "") and "every" not in body:
            raise ValueError("固定执行日期只适用于一次性自动化，请先选择 once 频率")
        s.every, s.run_at, s.once_fired = every, None, False
        if every == "custom":
            value = body.get("customRule", getattr(s, "custom_rule", ""))
            parsed = parse_custom_rule(value, default_zone=getattr(s, "time_zone", None))
            changed = old_every != every or value.strip() != getattr(s, "custom_rule", "")
            s.custom_rule = value.strip()
            s.time_zone = parsed.zone_name
            s.start_date, s.end_date = None, None
            s.weekdays, s.month_days = [], []
            s.month_day_policy = "skip"
            if changed:
                s.retry_count, s.next_retry_at = 0, None
            return
        s.custom_rule = ""
        start = parse_schedule_date(body.get("startDate"), "开始日期") if "startDate" in body else getattr(s, "start_date", None)
        end = parse_schedule_date(body.get("endDate"), "结束日期") if "endDate" in body else getattr(s, "end_date", None)
        s.start_date, s.end_date = start, end
        weekdays = clean_weekdays(body.get("weekdays")) if "weekdays" in body else clean_weekdays(getattr(s, "weekdays", None))
        if "weekday" in body and "weekdays" not in body:
            weekdays = clean_weekdays(body.get("weekday"))
        if every == "weekly" and not weekdays and "weekdays" not in body:
            weekdays = clean_weekdays(getattr(s, "weekday", None))
        month_days = clean_month_days(body.get("monthDays")) if "monthDays" in body else clean_month_days(getattr(s, "month_days", None))
        policy = str(body.get("monthDayPolicy", getattr(s, "month_day_policy", "skip")) or "skip")
        if every == "weekly" and "weekdays" in body and not weekdays:
            raise ValueError("请选择至少一个星期")
        s.weekdays, s.month_days, s.month_day_policy = weekdays, month_days, policy
        if weekdays:
            s.weekday = weekdays[0]
        validate(s)
        if old_every == "once":
            s.retry_count, s.next_retry_at = 0, None


def next_once(s) -> datetime | None:
    retry = getattr(s, "next_retry_at", None)
    target = getattr(s, "run_at", None)
    pending = [utc(retry)] if isinstance(retry, datetime) else []
    if not bool(getattr(s, "once_fired", False)) and isinstance(target, datetime):
        pending.append(utc(target))
    return min(pending) if pending else None


def trigger_for(s, now: datetime | None = None) -> str:
    current = utc(now) if now is not None else datetime.now(timezone.utc)
    target = getattr(s, "run_at", None)
    if (getattr(s, "every", "") == "once" and not bool(getattr(s, "once_fired", False)) and
            isinstance(target, datetime) and utc(target) <= current):
        return "timer"
    return "retry" if getattr(s, "next_retry_at", None) else "timer"


def snapshot(s) -> dict:
    every = str(getattr(s, "every", "") or "daily")
    if every == "once":
        return {"every": every, "runAt": iso(getattr(s, "run_at", None))}
    if every == "custom":
        return {"every": every,
                "customRule": str(getattr(s, "custom_rule", "") or ""),
                "timeZone": str(getattr(s, "time_zone", "") or "")}
    weekdays = clean_weekdays(getattr(s, "weekdays", None))
    if every == "weekly" and not weekdays:
        weekdays = clean_weekdays(getattr(s, "weekday", None))
    return {"every": every, "atHour": int(getattr(s, "at_hour", 0) or 0),
            "atMinute": int(getattr(s, "at_minute", 0) or 0),
            "weekdays": weekdays, "monthDays": clean_month_days(getattr(s, "month_days", None)),
            "monthDayPolicy": str(getattr(s, "month_day_policy", "skip") or "skip"),
            "startDate": str(getattr(s, "start_date", None) or ""),
            "endDate": str(getattr(s, "end_date", None) or ""),
            "timeZone": str(getattr(s, "time_zone", "") or "")}


def execution_snapshot(s) -> tuple:
    personal = str(getattr(s, "personal_plugin_key", "") or "")
    version = ((str(getattr(s, "personal_plugin_version_policy", "") or "latest"),
                str(getattr(s, "personal_plugin_version", "") or ""),
                str(getattr(s, "personal_plugin_checksum", "") or "")) if personal else ())
    return (str(getattr(s, "assignee_id", "") or ""),
            str(getattr(s, "model_name", "") or ""),
            str(getattr(s, "plugin_binding_id", "") or ""),
            personal, version, tuple(getattr(s, "required_capabilities", None) or []))


async def locked_schedule(session, schedule_id):
    from sqlalchemy import select
    from ..models import AiSchedule
    return await session.scalar(select(AiSchedule).where(AiSchedule.id == schedule_id)
                                .with_for_update().execution_options(populate_existing=True))


async def owner_change_blocker(session, s, body: dict) -> str:
    requested = str(body.get("ownerClientId") or "")
    if ("ownerClientId" not in body or requested == str(s.owner_client_id or "") or
            getattr(s, "every", "") != "once" or body.get("every", "once") != "once"):
        return ""
    if "runAt" in body:
        try:
            target = parse_run_at(body["runAt"])
        except ValueError:
            return ""  # apply() reports the normal date validation error to the API.
        if target != utc(s.run_at):
            return ""  # A new future appointment has its own identity; apply() validates the date.
    from sqlalchemy import select
    from ..models import AiScheduleRun
    rows = (await session.execute(select(AiScheduleRun).where(
        AiScheduleRun.schedule_id == s.id, AiScheduleRun.state == "starting"))).scalars().all()
    if any(not row.task_id and not row.workflow_run_id and
           not dict(row.receipt or {}).get("executionMode") for row in rows):
        return "原预约已有尚未派发的运行记录，请先处理原预约或重新选择未来日期后再更换归属"
    return ""


def matches(s, run) -> bool:
    if str(getattr(s, "owner_client_id", "") or "") != str(getattr(run, "owner_client_id", "") or ""):
        return False
    if str(getattr(s, "owner_user_id", None) or "") != str(getattr(run, "owner_user_id", None) or ""):
        return False
    recorded = dict(getattr(run, "receipt", None) or {}).get("timing")
    current = snapshot(s)
    if current["every"] == "custom" or isinstance(recorded, dict) and recorded.get("every") == "custom":
        return recorded == current
    if isinstance(recorded, dict) and "startDate" in recorded:
        return recorded == current
    if current["every"] == "once":
        return recorded == current
    # Legacy receipts lack calendar fields. Preserve their original schedule
    # shapes, but never let them settle a newly bounded or expanded recurrence.
    if current["every"] not in ("hourly", "daily", "weekly"):
        return False
    if recorded is not None and not isinstance(recorded, dict):
        return False
    if isinstance(recorded, dict) and recorded.get("every") not in (None, "", current["every"]):
        return False
    if current["startDate"] or current["endDate"]:
        return False
    return current["every"] != "weekly" or len(current["weekdays"]) <= 1


def settle(s, run, out: dict, *, outcome_of=None) -> dict:
    if outcome_of is None:
        from .schedule_run_contracts import apply_outcome as outcome_of
    if not matches(s, run):
        return {"retrying": False, "staleTiming": True}
    independent = run.trigger == "manual" or (run.trigger == "retry" and
                    dict(run.receipt or {}).get("triggerOrigin") == "manual")
    if getattr(s, "every", "") == "once" and bool(getattr(s, "once_fired", False)) and independent:
        # The timer's retry budget and compact status belong to that occurrence.
        # A later manual experiment records its own receipt without altering them.
        pending = getattr(s, "next_retry_at", None)
        return {"retrying": bool(pending), **({"retryCount": int(s.retry_count or 0),
                "nextRetryAt": pending} if pending else {})}
    if getattr(s, "every", "") == "once" and run.trigger == "timer" and not bool(getattr(s, "once_fired", False)):
        s.retry_count, s.next_retry_at = 0, None  # Manual failures never consume the timer's retry budget.
    retry = outcome_of(s, out)
    if getattr(s, "every", "") in ("hourly", "daily", "weekly", "monthly"):
        pending = getattr(s, "next_retry_at", None)
        if pending is not None:
            start, end = schedule_dates(s)
            if start or end:
                from .schedules import schedule_zone
                retry_date = utc(pending).astimezone(schedule_zone(s)).date()
                if (start and retry_date < start) or (end and retry_date > end):
                    # A retry outside the calendar window must not remain pending forever.
                    s.retry_count, s.next_retry_at = 0, None
                    retry = {"retrying": False}
    if getattr(s, "every", "") != "once":
        return retry
    if run.trigger == "timer":
        s.once_fired = True
    if bool(getattr(s, "once_fired", False)):
        if not getattr(s, "next_retry_at", None):
            s.enabled = False
    return retry


async def reconcile_pending(session, run, now: datetime) -> bool:
    receipt = dict(run.receipt or {})
    timing = dict(receipt.get("timing") or {})
    if (timing.get("every") != "once" or run.trigger == "manual" or run.state != "starting" or
            run.task_id or run.workflow_run_id or receipt.get("executionMode")):
        return False
    from ..models import AiSchedule
    plan = await session.get(AiSchedule, run.schedule_id)
    if plan is None or not matches(plan, run):
        run.state, run.finished_at = "cancelled", now
        run.error = "原预约已删除或日期已变更，本次未派发"
        receipt.pop("phase", None)
        run.receipt = receipt
        return True
    return receipt.get("phase") == "paused_before_dispatch"
