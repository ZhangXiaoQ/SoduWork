"""Calendar-aware recurring schedule timing tests."""
from datetime import datetime, timezone
from types import SimpleNamespace
import unittest
import time
from unittest.mock import patch

from app.services import schedule_timing, schedules


UTC = timezone.utc


def plan(**overrides):
    values = dict(
        every="daily",
        at_hour=9,
        at_minute=0,
        weekday=1,
        weekdays=[],
        month_days=[],
        month_day_policy="skip",
        start_date=None,
        end_date=None,
        time_zone="Asia/Shanghai",
        run_at=None,
        once_fired=False,
        next_retry_at=None,
    )
    values.update(overrides)
    return SimpleNamespace(**values)


def utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class ScheduleTimingRuleTests(unittest.TestCase):
  def test_weekly_multiple_days_and_legacy_scalar_are_supported(self):
      schedule = plan(every="weekly", weekdays=[1, 3, 5], at_hour=10, at_minute=30)
      after = utc("2030-10-07T02:00:00Z")
      self.assertEqual(schedules.next_run_instant(schedule, after), utc("2030-10-07T02:30:00Z"))
      schedule.weekdays = []
      schedule.weekday = 4
      self.assertEqual(schedules.next_run_instant(schedule, after), utc("2030-10-10T02:30:00Z"))


  def test_monthly_30_and_31_skip_missing_days_by_default(self):
      schedule = plan(every="monthly", month_days=[30, 31], at_hour=9)
      after = utc("2030-02-01T00:00:00Z")
      self.assertEqual(schedules.next_run_instant(schedule, after), utc("2030-03-30T01:00:00Z"))


  def test_monthly_missing_days_can_map_to_month_end_once(self):
      schedule = plan(every="monthly", month_days=[30, 31], month_day_policy="last_day", at_hour=9)
      after = utc("2030-02-01T00:00:00Z")
      self.assertEqual(schedules.next_run_instant(schedule, after), utc("2030-02-28T01:00:00Z"))


  def test_start_and_end_dates_bound_all_periodic_modes(self):
      daily = plan(every="daily", start_date="2030-10-10", end_date="2030-10-11", at_hour=9)
      after = utc("2030-10-08T00:00:00Z")
      self.assertEqual(schedules.next_run_instant(daily, after), utc("2030-10-10T01:00:00Z"))
      self.assertIsNone(schedules.next_run_instant(daily, utc("2030-10-11T02:00:00Z")))

      hourly = plan(every="hourly", start_date="2030-10-10", end_date="2030-10-10", at_minute=15)
      self.assertEqual(schedules.next_run_instant(hourly, utc("2030-10-09T23:59:00Z")), utc("2030-10-10T00:15:00Z"))
      self.assertIsNone(schedules.next_run_instant(hourly, utc("2030-10-10T16:00:00Z")))


  def test_apply_normalizes_new_fields_and_rejects_invalid_ranges(self):
      schedule = plan()
      schedule_timing.apply(schedule, {
        "every": "monthly",
        "monthDays": [31, 30, 31],
        "monthDayPolicy": "last_day",
        "startDate": "2030-01-01",
        "endDate": "2030-12-31",
        "atHour": 8,
        "atMinute": 45,
    })
      self.assertEqual(schedule.month_days, [30, 31])
      self.assertEqual(schedule.month_day_policy, "last_day")
      self.assertEqual(schedule.start_date, "2030-01-01")
      self.assertEqual(schedule.end_date, "2030-12-31")
      self.assertEqual(schedule_timing.snapshot(schedule)["monthDays"], [30, 31])

      with self.assertRaisesRegex(ValueError, "开始日期不能晚于结束日期"):
        schedule_timing.apply(plan(), {
            "every": "daily",
            "startDate": "2030-12-31",
            "endDate": "2030-01-01",
            "atHour": 8,
            "atMinute": 0,
        })


  def test_monthly_plan_without_selected_days_is_rejected(self):
      with self.assertRaisesRegex(ValueError, "至少一个月度日期"):
        schedule_timing.validate(plan(every="monthly"))
      with self.assertRaisesRegex(ValueError, "至少一个星期"):
        schedule_timing.apply(plan(), {"every": "weekly", "weekdays": [], "atHour": 9, "atMinute": 0})

  def test_far_future_start_and_calendar_upper_bound_are_bounded(self):
      for mode in ("hourly", "daily", "weekly", "monthly"):
          schedule = plan(every=mode, start_date="2099-01-01", weekdays=[1, 3, 5], month_days=[31], time_zone="UTC")
          result = schedules.next_run_instant(schedule, utc("2030-01-01T00:00:00Z"))
          self.assertEqual(result.year, 2099)
          schedule.start_date = None
          self.assertIsNone(schedules.next_run_instant(schedule, utc("9999-12-31T23:59:59Z")))

  def test_expired_date_range_does_not_backfill_after_reconnection(self):
      for mode in ("hourly", "daily", "weekly", "monthly"):
          schedule = plan(every=mode, start_date="2030-01-01", end_date="2030-01-31",
                          weekdays=[1, 3, 5], month_days=[30, 31], last_run_at=None,
                          created_at=utc("2029-01-01T00:00:00Z"))
          self.assertTrue(schedules.due(schedule, utc("2030-01-31T15:59:00Z")))
          self.assertFalse(schedules.due(schedule, utc("2030-01-31T16:00:00Z")))
          schedule.next_retry_at = utc("2030-02-01T00:00:00Z")
          self.assertFalse(schedules.due(schedule, schedule.next_retry_at))

  def test_final_minute_occurrence_survives_one_scheduler_poll_after_midnight(self):
      for mode in ("hourly", "daily", "weekly", "monthly"):
          schedule = plan(every=mode, time_zone="UTC", start_date="2030-01-01", end_date="2030-01-31",
                          weekdays=[4], month_days=[31], at_hour=23, at_minute=59,
                          last_run_at=utc("2030-01-31T23:58:00Z"))
          with patch("app.config.get_settings", return_value=SimpleNamespace(delivery_sweep_seconds=120)):
              self.assertTrue(schedules.due(schedule, utc("2030-02-01T00:00:00Z")), mode)
              self.assertTrue(schedules.due(schedule, utc("2030-02-01T00:01:00Z")), mode)
              self.assertFalse(schedules.due(schedule, utc("2030-02-01T00:01:01Z")), mode)

  def test_retry_bounds_preserve_unbounded_once_and_custom_behavior(self):
      now = utc("2030-02-01T00:00:00Z")
      for mode in ("hourly", "daily", "weekly", "monthly", "once", "custom"):
          schedule = plan(every=mode, next_retry_at=now, once_fired=True)
          with self.subTest(mode=mode):
              self.assertTrue(schedules.due(schedule, now))
              self.assertFalse(schedules.due(schedule, utc("2030-01-31T23:59:59Z")))
      for mode in ("hourly", "daily", "weekly", "monthly"):
          schedule = plan(every=mode, start_date="2030-02-01", end_date="2030-02-01",
                          next_retry_at=utc("2030-01-31T00:00:00Z"))
          with self.subTest(mode=mode):
              self.assertFalse(schedules.due(schedule, utc("2030-01-31T15:59:59Z")))
              self.assertTrue(schedules.due(schedule, now))
              self.assertTrue(schedules.due(schedule, utc("2030-02-01T15:59:59Z")))
              self.assertFalse(schedules.due(schedule, utc("2030-02-01T16:00:00Z")))

  def test_settle_does_not_advertise_a_retry_outside_the_date_window(self):
      from app.services.schedule_run_contracts import apply_outcome
      now = utc("2030-01-31T15:58:00Z")  # 23:58 in the schedule timezone.
      for mode in ("hourly", "daily", "weekly", "monthly", "once", "custom"):
          for bounded, delay in ((True, 5), (True, 1), (False, 5)):
              schedule = plan(every=mode, end_date="2030-01-31" if bounded else None,
                              owner_client_id="device", owner_user_id="user",
                              retry_limit=2, retry_count=0, retry_delay_minutes=delay)
              run = SimpleNamespace(trigger="timer", owner_client_id="device", owner_user_id="user",
                                    receipt={"timing": schedule_timing.snapshot(schedule)})
              with self.subTest(mode=mode, bounded=bounded, delay=delay):
                  result = schedule_timing.settle(schedule, run, {"ok": False, "error": "offline"},
                      outcome_of=lambda s, out: apply_outcome(s, out, now))
                  expected = not (bounded and delay == 5 and mode not in ("once", "custom"))
                  self.assertEqual(result["retrying"], expected)
                  self.assertEqual(schedule.next_retry_at is not None, expected)
                  self.assertEqual(schedule.retry_count, 1 if expected else 0)
                  self.assertEqual(schedule.last_error, "offline")

  def test_timing_edit_fences_old_result_and_queued_retry(self):
      from app.api.schedule_contract import apply_schedule_update
      schedule = plan(every="monthly", month_days=[30, 31], owner_client_id="device", owner_user_id="user",
                      retry_count=1, next_retry_at=utc("2030-02-01T00:00:00Z"))
      run = SimpleNamespace(owner_client_id="device", owner_user_id="user", receipt={"timing":schedule_timing.snapshot(schedule)})
      apply_schedule_update(schedule, {"endDate":"2030-01-31"})
      self.assertIsNone(schedule.next_retry_at)
      self.assertFalse(schedule_timing.matches(schedule, run))

  def test_legacy_receipts_keep_unchanged_basic_schedules_and_owner_fences(self):
      for mode in ("hourly", "daily", "weekly"):
          schedule = plan(every=mode, weekdays=[1] if mode == "weekly" else [],
                          owner_client_id="device", owner_user_id="user")
          for receipt in ({}, {"timing": {}}, {"timing": {"every": mode}}):
              with self.subTest(mode=mode, receipt=receipt):
                  run = SimpleNamespace(owner_client_id="device", owner_user_id="user", receipt=receipt)
                  self.assertTrue(schedule_timing.matches(schedule, run))
                  run.owner_user_id = "other-user"
                  self.assertFalse(schedule_timing.matches(schedule, run))
                  run.owner_user_id, run.owner_client_id = "user", "other-device"
                  self.assertFalse(schedule_timing.matches(schedule, run))

  def test_legacy_receipts_cannot_settle_new_calendar_rules(self):
      changes = ({"start_date": "2030-01-01"}, {"end_date": "2030-01-31"},
                 {"every": "monthly", "month_days": [31]},
                 {"every": "weekly", "weekdays": [1, 3]})
      for change in changes:
          for receipt in ({}, {"timing": {"every": "daily"}}):
              with self.subTest(change=change, receipt=receipt):
                  schedule = plan(owner_client_id="device", owner_user_id="user", **change)
                  run = SimpleNamespace(owner_client_id="device", owner_user_id="user", receipt=receipt)
                  self.assertFalse(schedule_timing.matches(schedule, run))
      schedule = plan(every="daily", owner_client_id="device", owner_user_id="user")
      for old_mode in ("once", "weekly", "custom"):
          run = SimpleNamespace(owner_client_id="device", owner_user_id="user",
                                receipt={"timing": {"every": old_mode}})
          self.assertFalse(schedule_timing.matches(schedule, run))

  def test_legacy_failure_cannot_restore_retry_cleared_by_calendar_edit(self):
      from app.api.schedule_contract import apply_schedule_update
      for edit in ({"endDate": "2030-01-31"}, {"every": "monthly", "monthDays": [31]}):
          with self.subTest(edit=edit):
              schedule = plan(owner_client_id="device", owner_user_id="user", retry_limit=2,
                              retry_count=1, retry_delay_minutes=5, plugin_binding_id="",
                              last_run_at=utc("2030-01-01T00:00:00Z"), last_error="New configuration")
              schedule.next_retry_at = utc("2030-02-01T00:00:00Z")
              run = SimpleNamespace(owner_client_id="device", owner_user_id="user", trigger="timer",
                                    receipt={"timing": {"every": "daily"}})
              apply_schedule_update(schedule, edit)
              self.assertEqual(schedule.retry_count, 0)
              self.assertIsNone(schedule.next_retry_at)
              before = (schedule.last_run_at, schedule.last_error)
              result = schedule_timing.settle(schedule, run, {"ok": False, "error": "Old failure"})
              self.assertEqual(result, {"retrying": False, "staleTiming": True})
              self.assertEqual((schedule.last_run_at, schedule.last_error), before)
              self.assertEqual(schedule.retry_count, 0)
              self.assertIsNone(schedule.next_retry_at)

  def test_final_minute_grace_uses_the_configured_scheduler_interval(self):
      schedule = plan(time_zone="UTC", end_date="2030-01-31", at_hour=23, at_minute=59,
                      last_run_at=utc("2030-01-31T23:58:00Z"))
      with patch("app.config.get_settings", return_value=SimpleNamespace(delivery_sweep_seconds=180)):
          self.assertTrue(schedules.due(schedule, utc("2030-02-01T00:02:00Z")))
          self.assertFalse(schedules.due(schedule, utc("2030-02-01T00:02:01Z")))

  def test_expired_periodic_checks_remain_bounded_with_polling_grace(self):
      values = [plan(every=mode, time_zone="UTC", end_date="2030-01-31", weekdays=[4],
                     month_days=[31], at_hour=23, at_minute=59, last_run_at=utc("2030-01-31T23:58:00Z"))
                for mode in ("hourly", "daily", "weekly", "monthly")]
      current = utc("2040-01-01T00:00:00Z")
      started = time.perf_counter()
      for index in range(20000):
          self.assertFalse(schedules.due(values[index % 4], current))
      elapsed = time.perf_counter() - started
      print(f"expired calendar pressure: 20000 checks in {elapsed:.3f}s")
      self.assertLess(elapsed, 8, "The end-date polling allowance must keep expired checks bounded")

  def test_payload_keeps_the_final_eligible_occurrence_visible_until_grace_expires(self):
      from app import models
      from app.api.schedule_contract import schedule_payload
      schedule = models.AiSchedule(id="final-minute", title="Final minute", note="Keep the last valid occurrence",
          every="daily", time_zone="UTC", end_date="2030-01-31", at_hour=23, at_minute=59,
          created_at=utc("2030-01-31T23:58:00Z"))
      current = utc("2030-02-01T00:00:00Z")
      class Clock(datetime):
          @classmethod
          def now(cls, tz=None):
              return current.astimezone(tz) if tz else current.replace(tzinfo=None)
      with patch("datetime.datetime", Clock), patch("app.config.get_settings",
              return_value=SimpleNamespace(delivery_sweep_seconds=120)):
          payload = schedule_payload(schedule, timestamp=lambda value: value.isoformat() if value else None)
          self.assertEqual(payload["nextRunAt"], "2030-01-31T23:59:00+00:00")
          current = utc("2030-02-01T00:01:01Z")
          self.assertIsNone(schedule_payload(schedule, timestamp=lambda value: value)["nextRunAt"])


if __name__ == "__main__":
    unittest.main()
