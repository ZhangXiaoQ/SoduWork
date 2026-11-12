"""Validated, bounded custom recurrence rules for the existing schedule ledger."""
from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from bisect import bisect_right
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from math import gcd
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

UTC = timezone.utc
WEEKDAYS = {name: index for index, name in enumerate(("MO", "TU", "WE", "TH", "FR", "SA", "SU"))}
STAMP = re.compile(r"^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$", re.I)
HEADER = re.compile(r"^(DTSTART|RRULE)(?:;TZID=([^:;]+))?:(.+)$", re.I)
MONTH_LENGTHS = tuple(calendar.monthrange(2000 + index // 12, index % 12 + 1)[1] for index in range(4800))


@dataclass(frozen=True)
class CustomRule:
    start: datetime
    zone_name: str
    frequency: str
    interval: int
    count: int | None
    until: datetime | None
    weekdays: tuple[int, ...]
    month_days: tuple[int, ...]


def _timestamp(raw, zone, field):
    if re.search(r"[+-]\d{2}:?\d{2}$", raw):
        raise ValueError("自定义规则请使用 TZID 或 Z 指定时区")
    match = STAMP.fullmatch(raw)
    try:
        if not match:
            raise ValueError()
        parts = match.groups()
        wall = datetime(*(int(value or 0) for value in parts[:6]))
        if wall.year < 100:
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError("自定义规则的 DTSTART 日期时间无效" if field == "DTSTART" else "RRULE 的 UNTIL 日期时间无效") from None
    if wall.second:
        raise ValueError("自定义规则的时间须精确到分钟，秒数应为 00")
    if parts[6]:
        return wall.replace(tzinfo=UTC)
    candidates = set()
    for fold in (0, 1):
        try:
            instant = wall.replace(tzinfo=zone, fold=fold).astimezone(UTC)
        except OverflowError:
            raise ValueError("自定义规则的 DTSTART 日期时间无效" if field == "DTSTART" else "RRULE 的 UNTIL 日期时间无效") from None
        if instant.astimezone(zone).replace(tzinfo=None) == wall:
            candidates.add(instant)
    if len(candidates) != 1:
        raise ValueError("自定义规则的日期时间因夏令时无效或不明确，请调整后重试")
    return candidates.pop()


def parse_custom_rule(raw, *, default_zone="Asia/Shanghai") -> CustomRule:
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("请填写自定义规则")
    text = raw.strip()
    if len(text) > 4096:
        raise ValueError("自定义规则最多 4096 个字符")
    return _parse(text, str(default_zone or "Asia/Shanghai"))


@lru_cache(maxsize=256)
def _parse(text, default_zone):
    headers = {}
    for line in filter(None, (line.strip() for line in text.splitlines())):
        match = HEADER.fullmatch(line)
        if not match or match[1].upper() in headers or (match[1].upper() == "RRULE" and match[2]):
            raise ValueError("自定义规则仅支持一行 DTSTART 和一行 RRULE")
        headers[match[1].upper()] = (match[3].strip(), match[2])
    if "DTSTART" not in headers:
        raise ValueError("自定义规则需要包含 DTSTART")
    if "RRULE" not in headers:
        raise ValueError("自定义规则需要包含 RRULE")
    stamp, explicit_zone = headers["DTSTART"]
    zone_name = "UTC" if stamp.upper().endswith("Z") else explicit_zone or default_zone
    if explicit_zone and stamp.upper().endswith("Z"):
        raise ValueError("自定义规则请使用 TZID 或 Z 指定时区")
    try:
        zone = ZoneInfo(zone_name)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError("自定义规则的时区无效") from None
    start = _timestamp(stamp, zone, "DTSTART").astimezone(zone)
    fields = {}
    for token in headers["RRULE"][0].split(";"):
        pair = token.split("=")
        if len(pair) != 2 or not all(part.strip() for part in pair) or pair[0].strip().upper() in fields:
            raise ValueError("RRULE 包含重复或无效的字段")
        fields[pair[0].strip().upper()] = pair[1].strip().upper()
    frequency = fields.get("FREQ")
    if frequency not in ("HOURLY", "DAILY", "WEEKLY", "MONTHLY"):
        raise ValueError("RRULE 的 FREQ 支持 HOURLY、DAILY、WEEKLY 或 MONTHLY")
    if fields.keys() - {"FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY"}:
        raise ValueError("RRULE 包含不支持的字段")
    interval = fields.get("INTERVAL", "1")
    count = fields.get("COUNT")
    if not re.fullmatch(r"[0-9]+", interval) or not 1 <= int(interval) <= 100000:
        raise ValueError("RRULE 的 INTERVAL 应为 1 至 100000 的整数")
    if count is not None and (not re.fullmatch(r"[0-9]+", count) or not 1 <= int(count) <= 1000000):
        raise ValueError("RRULE 的 COUNT 应为 1 至 1000000 的整数")
    if count is not None and "UNTIL" in fields:
        raise ValueError("RRULE 的 COUNT 与 UNTIL 不能同时使用")
    until = _timestamp(fields["UNTIL"], zone, "UNTIL") if "UNTIL" in fields else None
    if until is not None and until < start.astimezone(UTC):
        raise ValueError("RRULE 的 UNTIL 不能早于 DTSTART")
    byday = fields.get("BYDAY")
    if byday and (frequency != "WEEKLY" or any(day not in WEEKDAYS for day in byday.split(","))):
        raise ValueError("BYDAY 仅用于 WEEKLY，使用 MO、TU、WE、TH、FR、SA、SU")
    weekdays = tuple(sorted({WEEKDAYS[day] for day in byday.split(",")})) if byday else (start.weekday(),)
    bymonthday = fields.get("BYMONTHDAY")
    if bymonthday and (frequency != "MONTHLY" or any(not re.fullmatch(r"[0-9]+", day) or not 1 <= int(day) <= 31 for day in bymonthday.split(","))):
        raise ValueError("BYMONTHDAY 仅用于 MONTHLY，日期范围为 1 至 31")
    month_days = tuple(sorted({int(day) for day in bymonthday.split(",")})) if bymonthday else (start.day,)
    return CustomRule(start, zone_name, frequency, int(interval), int(count) if count else None,
                      until, weekdays, month_days)


def _wall(rule, day):
    # Match the existing calendar scheduler: advance gaps and use the first fold.
    return datetime(day.year, day.month, day.day, rule.start.hour, rule.start.minute,
                    tzinfo=rule.start.tzinfo).astimezone(UTC)


@lru_cache(maxsize=64)
def _month_counts(year, month, interval, days):
    # Gregorian month lengths repeat every 400 years. Count whole cycles in O(1).
    counts = [0]
    for index in range(4800 // gcd(interval, 4800)):
        number = year * 12 + month - 1 + index * interval
        counts.append(counts[-1] + bisect_right(days, MONTH_LENGTHS[number % 4800]))
    return tuple(counts)


def next_custom_run(s, after=None):
    rule = parse_custom_rule(getattr(s, "custom_rule", ""), default_zone=getattr(s, "time_zone", None))
    base = after or datetime.now(UTC)
    base = base.replace(tzinfo=UTC) if base.tzinfo is None else base.astimezone(UTC)
    start = rule.start.astimezone(UTC)
    if rule.until and base >= rule.until:
        return None
    try:
        local = base.astimezone(rule.start.tzinfo)
    except OverflowError:
        return None
    if rule.frequency == "HOURLY":
        index = max(0, (base - start) // timedelta(hours=rule.interval) + 1)
        if rule.count is not None and index >= rule.count:
            return None
        try:
            result = start + timedelta(hours=index * rule.interval)
        except OverflowError:
            return None
        return result if not rule.until or result <= rule.until else None
    if rule.frequency == "DAILY":
        period = max(0, (local.date() - rule.start.date()).days // rule.interval)
    elif rule.frequency == "WEEKLY":
        origin = rule.start.date() - timedelta(days=rule.start.weekday())
        period = max(0, (local.date() - origin).days // (7 * rule.interval))
    else:
        months = (local.year - rule.start.year) * 12 + local.month - rule.start.month
        period = max(0, months // rule.interval)
    # At most one full Gregorian cycle is needed to find a valid month day.
    limit = 4800 // gcd(rule.interval, 4800) + 1 if rule.frequency == "MONTHLY" else 3
    for index in range(period, period + limit):
        try:
            if rule.frequency == "DAILY":
                days = [rule.start.date() + timedelta(days=index * rule.interval)]
                ordinal = index
            elif rule.frequency == "WEEKLY":
                week = origin + timedelta(weeks=index * rule.interval)
                days = [week + timedelta(days=day) for day in rule.weekdays]
                ordinal = index * len(days) - sum(day < rule.start.weekday() for day in rule.weekdays)
            else:
                number = rule.start.month - 1 + index * rule.interval
                year, month = rule.start.year + number // 12, number % 12 + 1
                if year > 9999:
                    return None
                last = calendar.monthrange(year, month)[1]
                days = [date(year, month, day) for day in rule.month_days if day <= last]
                ordinal = 0
                if rule.count is not None:
                    if index < 24:
                        origin_month = rule.start.year * 12 + rule.start.month - 1
                        ordinal = sum(bisect_right(rule.month_days, MONTH_LENGTHS[(origin_month + offset * rule.interval) % 4800]) for offset in range(index))
                    else:
                        counts = _month_counts(rule.start.year, rule.start.month, rule.interval, rule.month_days)
                        cycles, remainder = divmod(index, len(counts) - 1)
                        ordinal = cycles * counts[-1] + counts[remainder]
                    ordinal -= sum(day < rule.start.day for day in rule.month_days)
            for day in days:
                result = _wall(rule, day)
                position = ordinal
                ordinal += 1
                if result < start:
                    continue
                if rule.count is not None and position >= rule.count:
                    return None
                if rule.until and result > rule.until:
                    return None
                if result > base:
                    return result
        except (OverflowError, ValueError):
            return None
    return None
