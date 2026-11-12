"""Custom timing contract, occurrence counts, compatibility, and bounded workload."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import time
import unittest
import asyncio
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import models
from app.api import personal_schedules, schedule_contract
from app.services import schedule_custom, schedule_timing, schedules

UTC = timezone.utc


def instant(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def plan(rule="FREQ=DAILY", start="20300101T090000", zone="Asia/Shanghai"):
    return SimpleNamespace(id="custom", every="custom", time_zone=zone,
                           custom_rule=f"DTSTART;TZID={zone}:{start}\nRRULE:{rule}",
                           last_run_at=None, created_at=instant("2029-12-01T00:00:00Z"),
                           owner_client_id="device", owner_user_id="user", next_retry_at=None)


class CustomRuleTests(unittest.TestCase):
    def test_count_one_matches_reference_and_never_repeats(self):
        s = plan("FREQ=DAILY;COUNT=1")
        target = instant("2030-01-01T01:00:00Z")
        self.assertEqual(schedules.next_run_instant(s, target - timedelta(minutes=1)), target)
        self.assertIsNone(schedules.next_run_instant(s, target))
        self.assertTrue(schedules.due(s, target))
        s.last_run_at = target
        self.assertFalse(schedules.due(s, target + timedelta(days=100)))

    def test_weekly_count_excludes_days_before_dtstart(self):
        s = plan("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=4", "20300102T090000")
        after = instant("2029-12-01T00:00:00Z")
        expected = ["2030-01-02", "2030-01-04", "2030-01-14", "2030-01-16"]
        for day in expected:
            after = schedules.next_run_instant(s, after)
            self.assertEqual(after, instant(day + "T01:00:00Z"))
        self.assertIsNone(schedules.next_run_instant(s, after))
        self.assertIsNone(schedules.next_run_instant(s, instant("2031-01-01T00:00:00Z")))

    def test_monthly_count_ignores_missing_days_and_partial_first_month(self):
        s = plan("FREQ=MONTHLY;BYMONTHDAY=1,30,31;COUNT=5", "20300130T090000")
        after = instant("2029-12-01T00:00:00Z")
        for day in ["2030-01-30", "2030-01-31", "2030-02-01", "2030-03-01", "2030-03-30"]:
            after = schedules.next_run_instant(s, after)
            self.assertEqual(after, instant(day + "T01:00:00Z"))
        self.assertIsNone(schedules.next_run_instant(s, after))

    def test_monthly_count_cycles_match_enumerated_calendar(self):
        import calendar
        for step in (1, 2, 3, 12, 17, 48, 49):
            s = plan(f"FREQ=MONTHLY;INTERVAL={step};BYMONTHDAY=29,30,31;COUNT=500", "20000130T090000", "UTC")
            expected = []
            for period in range(700):
                year, month = 2000 + period * step // 12, period * step % 12 + 1
                expected.extend(datetime(year, month, day, 9, tzinfo=UTC) for day in (29, 30, 31)
                                if day <= calendar.monthrange(year, month)[1] and (period or day >= 30))
            expected = expected[:500]
            for index in (0, 1, 29, 120, 499):
                self.assertEqual(schedules.next_run_instant(s, expected[index] - timedelta(minutes=1)), expected[index])
            self.assertIsNone(schedules.next_run_instant(s, expected[-1]))

    def test_until_is_inclusive_and_finite(self):
        s = plan("FREQ=DAILY;INTERVAL=2;UNTIL=20300105T010000Z")
        self.assertEqual(schedules.next_run_instant(s, instant("2030-01-03T01:00:00Z")), instant("2030-01-05T01:00:00Z"))
        self.assertIsNone(schedules.next_run_instant(s, instant("2030-01-05T01:00:00Z")))

    def test_hourly_is_elapsed_time_and_calendar_uses_existing_dst_policy(self):
        s = plan("FREQ=HOURLY;INTERVAL=3;COUNT=2", "20300310T003000", "America/New_York")
        first = schedules.next_run_instant(s, instant("2030-03-09T00:00:00Z"))
        second = schedules.next_run_instant(s, first)
        self.assertEqual(second - first, timedelta(hours=3))
        self.assertIsNone(schedules.next_run_instant(s, second))
        s = plan("FREQ=DAILY;COUNT=3", "20300309T023000", "America/New_York")
        self.assertEqual(schedules.next_run_instant(s, instant("2030-03-10T06:00:00Z")), instant("2030-03-10T07:30:00Z"))

    def test_invalid_rules_fail_without_truncation_or_ignored_fields(self):
        rule = plan().custom_rule
        invalid = ["", rule.replace("20300101", "20300230"), rule + ";INTERVAL=0", rule + ";COUNT=-1",
                   rule + ";COUNT=5;UNTIL=20310101T000000Z", rule + ";UNTIL=20290101T000000Z",
                   rule + ";BYHOUR=3", rule + ";BYDAY=MO", rule + ";FREQ=DAILY", rule + "\nEXDATE:20300101T090000",
                   rule.replace("090000", "090001"), rule.replace("090000", "090000+08:00"),
                   rule.replace("090000", "090000Z"), rule.replace("Asia/Shanghai", "Bad/Zone"),
                   plan(start="20300310T023000", zone="America/New_York").custom_rule,
                   plan(start="20301103T013000", zone="America/New_York").custom_rule,
                   rule + " " * 4100 + "X"]
        for raw in invalid:
            with self.subTest(raw=raw[:100]), self.assertRaises(ValueError):
                schedule_timing.apply(SimpleNamespace(every="daily"), {"every":"custom", "customRule":raw})

    def test_partial_update_keeps_rule_and_edit_clears_retry(self):
        s = plan("FREQ=MONTHLY;BYMONTHDAY=31;COUNT=4")
        rule = s.custom_rule
        s.retry_count, s.next_retry_at = 2, instant("2030-02-02T00:00:00Z")
        schedule_contract.apply_schedule_update(s, {"enabled":False})
        self.assertEqual(s.custom_rule, rule)
        self.assertEqual(s.retry_count, 2)
        schedule_contract.apply_schedule_update(s, {"customRule":rule.replace("COUNT=4", "COUNT=8")})
        self.assertIsNone(s.next_retry_at)
        self.assertEqual(s.retry_count, 0)

    def test_custom_timezone_and_payload_round_trip(self):
        s = models.AiSchedule(id="custom", time_zone="Asia/Shanghai")
        rule = "DTSTART:20990101T090000Z\nRRULE:FREQ=DAILY;COUNT=1"
        schedule_contract.apply_schedule_update(s, {"every":"custom", "customRule":rule})
        self.assertEqual(s.time_zone, "UTC")
        data = schedule_contract.schedule_payload(s, timestamp=lambda d:d.isoformat() if d else None)
        self.assertEqual(data["customRule"], rule)
        self.assertEqual(data["nextRunLocal"], "2099-01-01 09:00")

    def test_pending_final_custom_occurrence_stays_visible_until_dispatched(self):
        target = instant("2030-01-01T09:00:00Z")
        current = target + timedelta(minutes=1)
        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                return current.astimezone(tz) if tz else current.replace(tzinfo=None)

        for suffix in ("COUNT=1", "UNTIL=20300101T090000Z"):
            with self.subTest(suffix=suffix):
                schedule = models.AiSchedule(id="pending-final", every="custom", time_zone="UTC",
                    custom_rule="DTSTART:20300101T090000Z\nRRULE:FREQ=DAILY;" + suffix,
                    created_at=target - timedelta(hours=1), last_run_at=None)
                with patch("datetime.datetime", Clock), patch.object(schedules, "datetime", Clock), \
                        patch.object(schedule_custom, "datetime", Clock):
                    payload = schedule_contract.schedule_payload(schedule,
                        timestamp=lambda value: value.isoformat() if value else None)
                    self.assertTrue(schedules.due(schedule, current))
                    self.assertEqual(payload["nextRunAt"], target.isoformat())
                    self.assertEqual(payload["nextRunLocal"], "2030-01-01 09:00")
                    schedule.last_run_at = target
                    completed = schedule_contract.schedule_payload(schedule,
                        timestamp=lambda value: value.isoformat() if value else None)
                    self.assertFalse(schedules.due(schedule, current))
                    self.assertIsNone(completed["nextRunAt"])
                    self.assertEqual(completed["nextRunLocal"], "")

    def test_floating_timezone_change_and_leaving_custom_clear_old_retry(self):
        s = plan()
        s.custom_rule = "DTSTART:20300101T090000\nRRULE:FREQ=DAILY"
        s.retry_count, s.next_retry_at = 2, instant("2030-02-02T00:00:00Z")
        schedule_contract.apply_schedule_update(s, {"timeZone":"UTC"})
        self.assertIsNone(s.next_retry_at)
        self.assertEqual(s.retry_count, 0)
        s.retry_count, s.next_retry_at = 1, instant("2030-02-02T00:00:00Z")
        schedule_contract.apply_schedule_update(s, {"every":"daily"})
        self.assertIsNone(s.next_retry_at)
        self.assertEqual(s.custom_rule, "")

    def test_old_custom_result_cannot_restore_new_rules_retry(self):
        s = plan("FREQ=DAILY;COUNT=1")
        run = SimpleNamespace(owner_client_id="device", owner_user_id="user", receipt={"timing":schedule_timing.snapshot(s)})
        self.assertTrue(schedule_timing.matches(s, run))
        schedule_timing.apply(s, {"customRule":s.custom_rule.replace("COUNT=1", "COUNT=2")})
        self.assertFalse(schedule_timing.matches(s, run))

    def test_extreme_interval_and_datetime_upper_bound_terminate(self):
        for frequency in ("HOURLY", "DAILY", "WEEKLY", "MONTHLY"):
            s = plan(f"FREQ={frequency};INTERVAL=100000", "99991231T235900", "UTC")
            self.assertIsNone(schedules.next_run_instant(s, instant("9999-12-31T23:59:00Z")))

    def test_repeated_next_run_lookup_has_bounded_cost(self):
        rules = [plan("FREQ=HOURLY", "01000101T090000", "UTC"),
                 plan("FREQ=MONTHLY;BYMONTHDAY=29,30,31;COUNT=1000000", "01000130T090000", "UTC"),
                 plan("FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=1000000", "01000106T090000", "UTC")]
        after = instant("2030-01-01T00:00:00Z")
        started = time.perf_counter()
        for index in range(20000):
            self.assertIsNotNone(schedules.next_run_instant(rules[index % 3], after))
        elapsed = time.perf_counter() - started
        print(f"custom timing pressure: 20000 lookups in {elapsed:.3f}s")
        self.assertLess(elapsed, 8, "Historical periods must be skipped arithmetically")

    def test_distinct_historical_rules_bound_cold_cache_work_and_memory(self):
        schedule_custom._parse.cache_clear()
        schedule_custom._month_counts.cache_clear()
        after = instant("2030-01-01T00:00:00Z")
        expected = instant("2030-01-01T09:00:00Z")
        started = time.perf_counter()
        try:
            for index in range(1000):
                year, month = 100 + index // 372, index // 31 % 12 + 1
                days = ",".join(str(day) for day in sorted({1, index % 31 + 1}))
                value = plan(f"FREQ=MONTHLY;BYMONTHDAY={days};COUNT=1000000",
                             f"{year:04d}{month:02d}01T090000", "UTC")
                self.assertEqual(schedules.next_run_instant(value, after), expected)
            elapsed = time.perf_counter() - started
            parsed = schedule_custom._parse.cache_info()
            counted = schedule_custom._month_counts.cache_info()
            self.assertEqual(parsed.misses, 1000)
            self.assertEqual(counted.misses, 1000)
            self.assertLessEqual(parsed.currsize, 256)
            self.assertLessEqual(counted.currsize, 64)
            print(f"custom timing cold-cache pressure: 1000 distinct rules in {elapsed:.3f}s")
            self.assertLess(elapsed, 8, "Cache eviction must not cause historical period enumeration")
        finally:
            schedule_custom._parse.cache_clear()
            schedule_custom._month_counts.cache_clear()


class CustomPreflightTests(unittest.IsolatedAsyncioTestCase):
    async def test_preflight_reports_authoritative_occurrence_without_writing(self):
        rule = plan("FREQ=DAILY;COUNT=1", "20990101T090000").custom_rule
        client = SimpleNamespace(id="device", user_ref="user")
        with patch.object(schedules, "preflight_execution", AsyncMock(return_value={"state":"ready"})):
            result = await personal_schedules.preflight_my_schedule({"every":"custom", "customRule":rule}, client, None)
        self.assertEqual(result["nextRunAt"], "2099-01-01T01:00:00+00:00")
        self.assertEqual(result["timeZone"], "Asia/Shanghai")

    async def test_concurrent_custom_occurrence_claims_share_one_durable_receipt(self):
        from sqlalchemy import func, select
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
        from app.services.schedule_run_contracts import claim_run
        with tempfile.TemporaryDirectory(prefix="soduwork-custom-pressure-") as folder:
            engine = create_async_engine("sqlite+aiosqlite:///" + (Path(folder) / "fixture.db").as_posix(),
                                         pool_size=32, max_overflow=0)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(models.Client.__table__.create)
                    await connection.run_sync(models.AiSchedule.__table__.create)
                    await connection.run_sync(models.AiScheduleRun.__table__.create)
                factory = async_sessionmaker(engine, expire_on_commit=False)
                rule = plan("FREQ=MONTHLY;BYMONTHDAY=30,31;COUNT=10").custom_rule
                async with factory() as session:
                    session.add(models.Client(id="device", user_ref="user"))
                    await session.commit()
                async with factory() as session:
                    session.add(models.AiSchedule(id="pressure", owner_client_id="device", every="custom",
                        custom_rule=rule, created_at=instant("2029-12-01T00:00:00Z")))
                    await session.commit()
                ready = 0
                gate = asyncio.Event()
                async def contender():
                    nonlocal ready
                    async with factory() as session:
                        schedule = await session.get(models.AiSchedule, "pressure")
                        ready += 1
                        if ready == 32:
                            gate.set()
                        await gate.wait()
                        row, claimed = await claim_run(session, schedule, "timer", schedules.trigger_identity(schedule))
                        return row.id, claimed
                started = time.perf_counter()
                results = await asyncio.wait_for(asyncio.gather(*(contender() for _ in range(32))), 30)
                print(f"custom ledger pressure: 32 simultaneous claims in {time.perf_counter()-started:.3f}s")
                self.assertEqual(len({row[0] for row in results}), 1)
                self.assertEqual(sum(row[1] for row in results), 1)
                async with factory() as session:
                    self.assertEqual(await session.scalar(select(func.count()).select_from(models.AiScheduleRun)), 1)
                    self.assertEqual((await session.get(models.AiSchedule, "pressure")).custom_rule, rule)
            finally:
                await engine.dispose()


if __name__ == "__main__":
    unittest.main()
