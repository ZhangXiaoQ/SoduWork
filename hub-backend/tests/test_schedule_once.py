"""Fixed UTC appointments share the existing scheduler and immutable run ledger."""
import asyncio
import importlib
import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-once-schedule-secret")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app import models, automation_models
from app.api import admin, tasks as api
from app.services import schedules

UTC = timezone.utc
NOW = datetime(2030, 10, 20, 3, 0, tzinfo=UTC)
TARGET = NOW + timedelta(hours=1)


def schedule(**changes):
    values = dict(id="schedule", every="once", run_at=TARGET, once_fired=False,
                  at_hour=9, at_minute=0, weekday=1, time_zone="Asia/Shanghai", enabled=True,
                  created_at=NOW - timedelta(days=1), last_run_at=None, next_retry_at=None,
                  retry_count=0, retry_limit=2, retry_delay_minutes=5,
                  plugin_binding_id="", last_error="", last_task_id="")
    values.update(changes)
    return SimpleNamespace(**values)


class OnceTimingTests(unittest.TestCase):
    def test_recurring_date_range_is_inclusive_in_schedule_timezone(self):
        plan = schedule(every="daily", run_at=None, at_hour=9, start_date=date(2030, 10, 21),
                        end_date=date(2030, 10, 22), time_zone="Asia/Shanghai")
        before = datetime(2030, 10, 20, 23, 0, tzinfo=UTC)  # 07:00 on the start date.
        self.assertEqual(schedules.next_run_instant(plan, before),
                         datetime(2030, 10, 21, 1, 0, tzinfo=UTC))
        self.assertTrue(schedules.due(plan, datetime(2030, 10, 21, 1, 0, tzinfo=UTC)))
        plan.last_run_at = datetime(2030, 10, 22, 1, 0, tzinfo=UTC)
        self.assertIsNone(schedules.next_run_instant(plan, plan.last_run_at))
        self.assertFalse(schedules.due(plan, datetime(2030, 10, 23, 1, 0, tzinfo=UTC)))

    def test_hourly_range_starts_at_first_matching_minute_and_blocks_late_retry(self):
        plan = schedule(every="hourly", run_at=None, at_minute=15,
                        start_date=date(2030, 10, 21), end_date=date(2030, 10, 21),
                        time_zone="Asia/Shanghai")
        before = datetime(2030, 10, 20, 15, 0, tzinfo=UTC)
        self.assertEqual(schedules.next_run_instant(plan, before),
                         datetime(2030, 10, 20, 16, 15, tzinfo=UTC))
        plan.next_retry_at = datetime(2030, 10, 21, 16, 5, tzinfo=UTC)
        self.assertFalse(schedules.due(plan, datetime(2030, 10, 21, 16, 5, tzinfo=UTC)))

    def test_once_due_uses_fixed_instant_and_not_last_manual_run(self):
        s = schedule(last_run_at=TARGET - timedelta(minutes=1))
        self.assertFalse(schedules.due(s, TARGET - timedelta(microseconds=1)))
        self.assertTrue(schedules.due(s, TARGET))
        self.assertTrue(schedules.due(s, TARGET + timedelta(days=20)))
        self.assertEqual(schedules.next_run_instant(s, NOW), TARGET)
        s.once_fired = True
        self.assertFalse(schedules.due(s, TARGET + timedelta(days=20)))
        self.assertIsNone(schedules.next_run_instant(s, NOW))

    def test_timer_identity_is_independent_of_manual_runs_and_preserves_precision(self):
        s = schedule(run_at=TARGET.replace(microsecond=100))
        key = schedules.trigger_identity(s)
        s.last_run_at = TARGET + timedelta(hours=2)
        self.assertEqual(schedules.trigger_identity(s), key)
        s.run_at = TARGET.replace(microsecond=200)
        self.assertNotEqual(schedules.trigger_identity(s), key)

    def test_api_patch_accepts_aware_iso_and_emits_utc(self):
        s = models.AiSchedule(title="appointment", assignee_id="local:pi", owner_client_id="device")
        admin._sch_apply(s, {"every": "once", "runAt": "2035-10-20T12:30:10.123456+08:00"})
        self.assertEqual(s.every, "once")
        self.assertEqual(s.run_at, datetime(2035, 10, 20, 4, 30, 10, 123456, tzinfo=UTC))
        for output in (api._my_sch_api(s), admin._sch_api(s)):
            self.assertEqual(output["runAt"], "2035-10-20T04:30:10.123456+00:00")
            self.assertEqual(output["nextRunAt"], output["runAt"])
            self.assertFalse(output["onceFired"])

    def test_invalid_naive_missing_and_past_new_dates_are_400(self):
        for value in [None, "", "2035-10-20", "2035-10-20T12:30", "garbage", "2020-01-01T00:00:00Z"]:
            with self.subTest(value=value), self.assertRaises(HTTPException) as raised:
                admin._sch_apply(models.AiSchedule(), {"every": "once", "runAt": value})
            self.assertEqual(raised.exception.status_code, 400)

    def test_unchanged_overdue_paused_appointment_can_resume_but_not_rearm(self):
        s = schedule(run_at=datetime(2020, 1, 1, tzinfo=UTC), enabled=False)
        admin._sch_apply(s, {"enabled": True, "runAt": "2020-01-01T00:00:00Z"})
        self.assertTrue(s.enabled)
        self.assertFalse(s.once_fired)
        s.once_fired, s.enabled = True, False
        admin._sch_apply(s, {"enabled": True})
        self.assertFalse(s.enabled, "A consumed appointment needs a new future date to rearm")

    def test_new_future_date_rearms_and_switching_to_periodic_clears_once_state(self):
        s = schedule(once_fired=True, enabled=False, retry_count=1, next_retry_at=TARGET)
        admin._sch_apply(s, {"runAt": "2035-10-21T12:00:00Z", "enabled": True})
        self.assertFalse(s.once_fired)
        self.assertTrue(s.enabled)
        self.assertIsNone(s.next_retry_at)
        self.assertEqual(s.retry_count, 0)
        admin._sch_apply(s, {"every": "weekly"})
        self.assertIsNone(s.run_at)
        self.assertFalse(s.once_fired)

    def test_completed_once_has_no_next_time_in_both_api_views(self):
        s = models.AiSchedule(id="schedule", every="once", run_at=TARGET, once_fired=True,
                             title="once", enabled=False, last_run_at=TARGET)
        for output in (api._my_sch_api(s), admin._sch_api(s)):
            self.assertEqual(output["nextRunAt"], "")
            self.assertEqual(output["nextRunLocal"], "")

    def test_dst_fold_offsets_are_distinct_instants_and_display_zone_does_not_reinterpret(self):
        one, two = models.AiSchedule(), models.AiSchedule()
        admin._sch_apply(one, {"every": "once", "runAt": "2035-11-04T01:30:00-04:00", "timeZone": "UTC"})
        admin._sch_apply(two, {"every": "once", "runAt": "2035-11-04T01:30:00-05:00", "timeZone": "Asia/Shanghai"})
        self.assertEqual(two.run_at - one.run_at, timedelta(hours=1))
        self.assertEqual(api._my_sch_api(one)["nextRunLocal"], "2035-11-04 05:30")
        self.assertEqual(api._my_sch_api(two)["nextRunLocal"], "2035-11-04 14:30")

    def test_past_date_change_is_rejected_but_equivalent_unchanged_offset_is_preserved(self):
        s = schedule(run_at=datetime(2020, 1, 1, tzinfo=UTC))
        admin._sch_apply(s, {"runAt": "2020-01-01T08:00:00+08:00"})
        self.assertEqual(s.run_at, datetime(2020, 1, 1, tzinfo=UTC))
        with self.assertRaises(HTTPException):
            admin._sch_apply(s, {"runAt": "2020-01-02T00:00:00Z"})

    def test_same_execution_fields_on_title_edit_preserve_pending_retry(self):
        s = schedule(once_fired=True, retry_count=1, next_retry_at=TARGET,
                     assignee_id="local:pi", personal_plugin_key="", required_capabilities=[])
        admin._sch_apply(s, {"title": "new wording", "every": "once", "runAt": TARGET.isoformat(),
                             "assigneeId": "local:pi", "pluginBindingId": "", "personalPluginKey": "",
                             "requiredCapabilities": [], "enabled": True})
        self.assertEqual(s.next_retry_at, TARGET)
        self.assertEqual(s.retry_count, 1)
        self.assertTrue(s.enabled)

    def test_once_fired_body_cannot_consume_or_rearm(self):
        s = schedule()
        admin._sch_apply(s, {"onceFired": True})
        self.assertFalse(s.once_fired)
        s.once_fired, s.enabled = True, False
        admin._sch_apply(s, {"onceFired": False, "enabled": True})
        self.assertTrue(s.once_fired)
        self.assertFalse(s.enabled)

    def test_templates_keep_the_existing_periodic_contract(self):
        from app.services import automation_templates
        with self.assertRaises(ValueError):
            automation_templates.normalize({"id": "once-template", "name": "One time", "every": "once"})


class OnceLedgerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-once-test-")
        self.addCleanup(self.temp.cleanup)
        filename = (Path(self.temp.name) / "once.db").as_posix()
        self.engine = create_async_engine("sqlite+aiosqlite:///" + filename)
        self.addAsyncCleanup(self.engine.dispose)
        async with self.engine.begin() as conn:
            for table in [models.Client.__table__, models.AiSchedule.__table__, models.AiScheduleRun.__table__,
                          automation_models.ResourceLease.__table__]:
                await conn.run_sync(table.create)
        self.factory = async_sessionmaker(self.engine, expire_on_commit=False)
        self.session = self.factory()
        self.target = datetime.now(UTC) - timedelta(seconds=10)
        self.client = models.Client(id="device", config={"automationConversationV1": 1})
        self.plan = models.AiSchedule(id="schedule", title="one appointment", every="once", run_at=self.target,
                                     once_fired=False, enabled=True, owner_client_id="device", assignee_id="local:pi",
                                     retry_limit=1, retry_delay_minutes=1, created_at=self.target-timedelta(days=1))
        self.session.add_all([self.client, self.plan])
        await self.session.commit()

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()
        # Duplicate-claim IntegrityError tracebacks can retain SQLite cursors in
        # cycles after dispose; release them before removing the Windows file.
        import gc
        gc.collect()
        self.temp.cleanup()

    async def execute(self, trigger="timer", result=None):
        key = schedules.trigger_identity(self.plan, trigger) if trigger != "manual" else ""
        with patch.object(schedules, "run_one", AsyncMock(return_value=result or {"ok": True})):
            out = await schedules.execute_one(self.session, self.plan, trigger=trigger, idempotency_key=key)
            await self.session.commit()
        return out

    async def test_timer_is_consumed_once_and_repeat_key_has_one_receipt(self):
        key = schedules.trigger_identity(self.plan)
        first = await self.execute()
        self.assertTrue(self.plan.once_fired)
        self.assertFalse(self.plan.enabled)
        self.assertIsNone(schedules.next_run_instant(self.plan))
        with patch.object(schedules, "run_one", AsyncMock()) as dispatch:
            second = await schedules.execute_one(self.session, self.plan, idempotency_key=key)
        dispatch.assert_not_awaited()
        self.assertTrue(second["deduplicated"])
        rows = list((await self.session.execute(select(models.AiScheduleRun))).scalars())
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].receipt["timing"]["runAt"], self.target.isoformat())
        self.assertEqual(first["scheduleRunState"], "running", "Handoff is not completion")

    async def test_manual_before_due_and_manual_retry_do_not_consume_timer(self):
        self.plan.run_at = datetime.now(UTC) + timedelta(hours=1)
        await self.session.commit()
        await self.execute("manual", {"ok": False, "error": "offline"})
        self.assertFalse(self.plan.once_fired)
        self.assertIsNotNone(self.plan.next_retry_at)
        await self.execute("retry")
        self.assertFalse(self.plan.once_fired)
        self.assertTrue(self.plan.enabled)
        self.assertTrue(schedules.due(self.plan, self.plan.run_at))

    async def test_timer_failure_retries_then_stops_without_a_second_timer(self):
        await self.execute(result={"ok": False, "error": "offline"})
        self.assertTrue(self.plan.once_fired)
        self.assertTrue(self.plan.enabled)
        self.assertIsNotNone(self.plan.next_retry_at)
        await self.execute("retry", {"ok": False, "error": "still offline"})
        self.assertFalse(self.plan.enabled)
        self.assertIsNone(self.plan.next_retry_at)
        self.assertFalse(schedules.due(self.plan, datetime.now(UTC)+timedelta(days=100)))

    async def test_manual_failure_after_timer_cannot_create_another_automatic_run(self):
        await self.execute()
        await self.execute("manual", {"ok": False, "error": "manual failed"})
        self.assertTrue(self.plan.once_fired)
        self.assertFalse(self.plan.enabled)
        self.assertIsNone(self.plan.next_retry_at)

    async def test_independent_manual_runs_preserve_an_existing_timer_retry(self):
        await self.execute(result={"ok": False, "error": "timer offline"})
        before = (schedules._utc(self.plan.next_retry_at), self.plan.retry_count, schedules._utc(self.plan.last_run_at),
                  self.plan.last_error, self.plan.enabled)
        await self.execute("manual", {"ok": True})
        await self.execute("manual", {"ok": False, "error": "manual failed"})
        self.assertEqual((schedules._utc(self.plan.next_retry_at), self.plan.retry_count, schedules._utc(self.plan.last_run_at),
                          self.plan.last_error, self.plan.enabled), before)

    async def test_manual_retry_after_or_at_appointment_never_delays_original_timer(self):
        await self.execute("manual", {"ok": False, "error": "manual offline"})
        self.plan.next_retry_at = datetime.now(UTC) + timedelta(minutes=3)
        await self.session.commit()
        self.assertTrue(schedules.due(self.plan, datetime.now(UTC)))
        with patch.object(schedules, "reconcile_runs", AsyncMock()), \
             patch.object(schedules, "run_one", AsyncMock(return_value={"ok": True})):
            self.assertEqual((await schedules.tick(self.session))["fired"], 1)
        rows = list((await self.session.execute(select(models.AiScheduleRun)
                    .order_by(models.AiScheduleRun.started_at))).scalars())
        self.assertEqual([row.trigger for row in rows], ["manual", "timer"])
        self.assertEqual(rows[-1].attempt, 1)
        self.assertTrue(self.plan.once_fired)
        self.assertIsNone(self.plan.next_retry_at)

    async def test_simultaneously_due_manual_retry_and_timer_choose_timer(self):
        await self.execute("manual", {"ok": False, "error": "manual offline"})
        self.plan.next_retry_at = self.target
        await self.session.commit()
        with patch.object(schedules, "reconcile_runs", AsyncMock()), \
             patch.object(schedules, "run_one", AsyncMock(return_value={"ok": True})):
            await schedules.tick(self.session)
        rows = list((await self.session.execute(select(models.AiScheduleRun)
                    .order_by(models.AiScheduleRun.started_at))).scalars())
        self.assertEqual(rows[-1].trigger, "timer")
        self.assertTrue(self.plan.once_fired)

    async def test_pause_race_keeps_one_explicitly_paused_receipt_and_resume_uses_it(self):
        claim = schedules.claim_run
        async def pause_after_claim(*args):
            result = await claim(*args)
            async with self.factory() as editor:
                row = await editor.get(models.AiSchedule, "schedule")
                row.enabled = False
                await editor.commit()
            return result
        with patch.object(schedules, "claim_run", pause_after_claim), patch.object(schedules, "run_one", AsyncMock()) as dispatch:
            output = await schedules.execute_one(self.session, self.plan, idempotency_key=schedules.trigger_identity(self.plan))
            await self.session.commit()
        dispatch.assert_not_awaited()
        run = await self.session.get(models.AiScheduleRun, output["scheduleRunId"])
        self.assertEqual(run.receipt["phase"], "paused_before_dispatch")
        run.started_at = datetime.now(UTC) - timedelta(days=2)
        await self.session.commit()
        await schedules.reconcile_runs(self.session)
        self.assertEqual(run.state, "starting")
        self.plan.enabled = True
        await self.session.commit()
        resumed = await self.execute()
        self.assertEqual(resumed["scheduleRunId"], run.id)
        self.assertNotIn("phase", run.receipt)
        self.assertTrue(self.plan.once_fired)

    async def test_changed_or_deleted_paused_appointment_cancels_only_unstarted_receipt(self):
        run, _ = await schedules.claim_run(self.session, self.plan, "timer", schedules.trigger_identity(self.plan))
        run.receipt = {**run.receipt, "phase": "paused_before_dispatch"}
        admin._sch_apply(self.plan, {"runAt": (datetime.now(UTC)+timedelta(days=2)).isoformat()})
        await self.session.commit()
        await schedules.reconcile_runs(self.session)
        self.assertEqual(run.state, "cancelled")
        self.assertFalse(self.plan.once_fired)
        second, _ = await schedules.claim_run(self.session, self.plan, "timer", schedules.trigger_identity(self.plan))
        second.receipt = {**second.receipt, "phase": "paused_before_dispatch"}
        await self.session.delete(self.plan)
        await self.session.commit()
        await schedules.reconcile_runs(self.session)
        self.assertEqual(second.state, "cancelled")

    async def test_delete_during_handoff_preserves_the_run_outcome(self):
        async def delete_during_dispatch(*_args, **_kwargs):
            async with self.factory() as editor:
                row = await editor.get(models.AiSchedule, "schedule")
                await editor.delete(row)
                await editor.commit()
            return {"ok": True}
        with patch.object(schedules, "run_one", delete_during_dispatch):
            output = await schedules.execute_one(self.session, self.plan,
                idempotency_key=schedules.trigger_identity(self.plan))
            await self.session.commit()
        self.assertTrue(output["ok"])
        self.assertEqual((await self.session.get(models.AiScheduleRun, output["scheduleRunId"])).state, "running")

    async def test_restart_recovers_durable_starting_receipt(self):
        key = schedules.trigger_identity(self.plan)
        run, claimed = await schedules.claim_run(self.session, self.plan, "timer", key)
        self.assertTrue(claimed)
        original_id = run.id
        await self.session.close()
        self.session = self.factory()
        self.plan = await self.session.get(models.AiSchedule, "schedule")
        out = await self.execute()
        self.assertEqual(out["scheduleRunId"], original_id)
        self.assertTrue(self.plan.once_fired)
        self.assertFalse(self.plan.enabled)

    async def test_unknown_scheduler_interruption_keeps_original_receipt_for_resume(self):
        async def interrupted(session, plan, *, trigger, idempotency_key):
            await schedules.claim_run(session, plan, trigger, idempotency_key)
            raise RuntimeError("interrupted before verified handoff")
        with patch.object(schedules, "reconcile_runs", AsyncMock()), \
             patch.object(schedules, "execute_one", interrupted), patch.object(schedules, "_notify_failure", AsyncMock()):
            await schedules.tick(self.session)
        await self.session.refresh(self.plan)
        self.assertFalse(self.plan.once_fired)
        self.assertIsNone(self.plan.next_retry_at)
        run = (await self.session.execute(select(models.AiScheduleRun))).scalar_one()
        self.assertEqual(run.state, "starting")
        with patch.object(schedules, "reconcile_runs", AsyncMock()), \
             patch.object(schedules, "run_one", AsyncMock(return_value={"ok": True})):
            self.assertEqual((await schedules.tick(self.session))["fired"], 1)
        self.assertEqual(len(list((await self.session.execute(select(models.AiScheduleRun))).scalars())), 1)
        self.assertTrue(self.plan.once_fired)

    async def test_durable_handoff_receipt_repairs_missing_consumption_without_redispatch(self):
        run, _ = await schedules.claim_run(self.session, self.plan, "timer", schedules.trigger_identity(self.plan))
        run.state = "waiting"
        run.receipt = {**run.receipt, "executionMode": "soduwork.automation-conversation/v1"}
        await self.session.commit()
        with patch.object(schedules, "reconcile_runs", AsyncMock()), patch.object(schedules, "run_one", AsyncMock()) as dispatch:
            await schedules.tick(self.session)
        dispatch.assert_not_awaited()
        self.assertTrue(self.plan.once_fired)
        self.assertFalse(self.plan.enabled)

    async def test_handoff_recovery_cannot_consume_a_concurrently_rescheduled_appointment(self):
        key = schedules.trigger_identity(self.plan)
        run, _ = await schedules.claim_run(self.session, self.plan, "timer", key)
        run.state = "waiting"
        run.receipt = {**run.receipt, "executionMode": "soduwork.automation-conversation/v1"}
        await self.session.commit()
        replacement = datetime.now(UTC) + timedelta(days=1)
        original_refresh, edited = self.session.refresh, False

        async def refresh_then_edit(instance, *args, **kwargs):
            nonlocal edited
            result = await original_refresh(instance, *args, **kwargs)
            if isinstance(instance, models.AiScheduleRun) and not edited:
                # The old plan is already in the scheduler's identity map. Commit
                # a genuine second-session edit before its recovery settlement.
                edited = True
                async with self.factory() as editor:
                    row = await schedules.schedule_timing.locked_schedule(editor, "schedule")
                    admin._sch_apply(row, {"runAt": replacement.isoformat(), "enabled": True})
                    await editor.commit()
            return result

        with patch.object(self.session, "refresh", refresh_then_edit), \
             patch.object(schedules, "run_one", AsyncMock()) as dispatch:
            result = await schedules.execute_one(self.session, self.plan, idempotency_key=key)
            await self.session.commit()
        dispatch.assert_not_awaited()
        self.assertTrue(result["deduplicated"])
        async with self.factory() as check:
            latest = await check.get(models.AiSchedule, "schedule")
            self.assertEqual(latest.run_at.replace(tzinfo=UTC), replacement)
            self.assertFalse(latest.once_fired, "The old receipt must not consume the replacement appointment")
            self.assertTrue(latest.enabled)
            receipts = list((await check.execute(select(models.AiScheduleRun))).scalars())
            self.assertEqual(len(receipts), 1)
            self.assertEqual(receipts[0].state, "waiting")

    async def test_handoff_recovery_preserves_receipt_when_plan_was_concurrently_deleted(self):
        key = schedules.trigger_identity(self.plan)
        run, _ = await schedules.claim_run(self.session, self.plan, "timer", key)
        run.state = "waiting"
        run.receipt = {**run.receipt, "executionMode": "soduwork.automation-conversation/v1"}
        await self.session.commit()
        original_refresh, deleted = self.session.refresh, False

        async def refresh_then_delete(instance, *args, **kwargs):
            nonlocal deleted
            result = await original_refresh(instance, *args, **kwargs)
            if isinstance(instance, models.AiScheduleRun) and not deleted:
                deleted = True
                async with self.factory() as editor:
                    row = await editor.get(models.AiSchedule, "schedule")
                    await editor.delete(row)
                    await editor.commit()
            return result

        with patch.object(self.session, "refresh", refresh_then_delete), \
             patch.object(schedules, "run_one", AsyncMock()) as dispatch:
            result = await schedules.execute_one(self.session, self.plan, idempotency_key=key)
            await self.session.commit()
        dispatch.assert_not_awaited()
        self.assertTrue(result["deduplicated"])
        async with self.factory() as check:
            self.assertIsNone(await check.get(models.AiSchedule, "schedule"))
            preserved = await check.get(models.AiScheduleRun, run.id)
            self.assertEqual(preserved.state, "waiting")

    async def test_owner_change_after_claim_never_loads_new_owner_content_into_old_run(self):
        claim = schedules.claim_run
        old_key = schedules.trigger_identity(self.plan)
        async def change_after_claim(*args):
            result = await claim(*args)
            async with self.factory() as editor:
                row = await editor.get(models.AiSchedule, "schedule")
                row.owner_client_id = "other-device"
                await editor.commit()
            return result
        with patch.object(schedules, "claim_run", change_after_claim), patch.object(schedules, "run_one", AsyncMock(return_value={"ok": True})) as dispatch:
            first = await schedules.execute_one(self.session, self.plan, idempotency_key=old_key)
            await self.session.commit()
        dispatch.assert_not_awaited()
        self.assertEqual(first["scheduleRunState"], "cancelled")
        self.assertNotEqual(schedules.trigger_identity(self.plan), old_key)
        self.assertLessEqual(len(schedules.trigger_identity(self.plan)), 180)
        out = await self.execute()
        self.assertTrue(out["ok"])
        self.assertTrue(self.plan.once_fired)
        self.assertNotEqual(out["scheduleRunId"], first["scheduleRunId"])

    async def test_owner_transfer_does_not_replay_a_consumed_once(self):
        await self.execute()
        old_key = schedules.trigger_identity(self.plan)
        admin._sch_apply(self.plan, {"ownerClientId": "other-device", "enabled": True})
        await self.session.commit()
        self.assertNotEqual(schedules.trigger_identity(self.plan), old_key)
        self.assertTrue(self.plan.once_fired)
        self.assertFalse(self.plan.enabled)
        self.assertFalse(schedules.due(self.plan, datetime.now(UTC)+timedelta(days=1)))

    async def test_admin_owner_transfer_with_unstarted_receipt_requires_new_appointment(self):
        await schedules.claim_run(self.session, self.plan, "timer", schedules.trigger_identity(self.plan))
        user = SimpleNamespace(id="admin", username="admin", display_name="Admin", is_super=True)
        with self.assertRaises(HTTPException) as error:
            await admin.update_ai_schedule("schedule", {"ownerClientId": "other-device"}, user, self.session)
        self.assertEqual(error.exception.status_code, 409)

    async def test_admin_owner_transfer_with_invalid_date_returns_validation_error(self):
        user = SimpleNamespace(id="admin", username="admin", display_name="Admin", is_super=True)
        with self.assertRaises(HTTPException) as error:
            await admin.update_ai_schedule("schedule", {"ownerClientId": "other-device", "runAt": "not-a-date"},
                                           user, self.session)
        self.assertEqual(error.exception.status_code, 400)

    async def test_late_manual_retry_preserves_timer_retry_using_frozen_origin(self):
        await self.execute("manual", {"ok": False, "error": "manual offline"})
        manual_key = schedules.trigger_identity(self.plan, "retry")
        run, _ = await schedules.claim_run(self.session, self.plan, "retry", manual_key)
        self.assertEqual(run.receipt.get("triggerOrigin"), "manual")
        await self.execute("timer", {"ok": False, "error": "timer offline"})
        retry_at, count = schedules._utc(self.plan.next_retry_at), self.plan.retry_count
        with patch.object(schedules, "run_one", AsyncMock(return_value={"ok": True})):
            await schedules.execute_one(self.session, self.plan, trigger="retry", idempotency_key=manual_key)
        self.assertEqual(schedules._utc(self.plan.next_retry_at), retry_at)
        self.assertEqual(self.plan.retry_count, count)
        self.assertTrue(self.plan.enabled)

    async def test_old_conversation_ack_does_not_paint_new_appointment_status(self):
        from app.services import schedule_conversations as chats
        run, _ = await schedules.claim_run(self.session, self.plan, "timer", schedules.trigger_identity(self.plan))
        await chats.prepare(self.session, self.plan, self.client, None, run.id, "pi", {})
        await chats.claim(self.session, self.client, run.id, "worker")
        admin._sch_apply(self.plan, {"runAt": (datetime.now(UTC)+timedelta(days=3)).isoformat(), "enabled": True})
        await self.session.commit()
        await chats.acknowledge(self.session, self.client, run.id, {"instanceId": "worker", "conversationId": "old-chat",
                                                                "state": "failed", "error": "OLD_OCCURRENCE_FAILED"})
        self.assertEqual(run.state, "failed")
        self.assertEqual(run.error, "OLD_OCCURRENCE_FAILED")
        self.assertEqual(self.plan.last_error, "")

    async def test_same_account_peer_cannot_claim_local_conversation_pinned_to_desktop(self):
        from app.services import schedule_conversations as chats
        run, _ = await schedules.claim_run(self.session, self.plan, "timer",
                                           schedules.trigger_identity(self.plan))
        await chats.prepare(self.session, self.plan, self.client, None, run.id, "pi", {})
        peer = models.Client(id="peer-device", config={"automationConversationV1": 1})
        self.session.add(peer)
        await self.session.commit()
        with self.assertRaises(HTTPException) as error:
            await chats.claim(self.session, peer, run.id, "peer-worker")
        self.assertEqual(error.exception.status_code, 404)

    async def test_stale_worker_can_promote_legacy_cross_client_false_failure(self):
        from app.services import schedule_conversations as chats
        run, _ = await schedules.claim_run(self.session, self.plan, "timer",
                                           schedules.trigger_identity(self.plan))
        await chats.prepare(self.session, self.plan, self.client, None, run.id, "pi", {})
        await chats.claim(self.session, self.client, run.id, "worker-a")
        await chats.acknowledge(self.session, self.client, run.id, {
            "instanceId": "worker-a", "conversationId": "shared-chat", "state": "running"
        })
        run.state = "failed"
        run.error = "此触发已在另一客户端创建对话，请打开原对话确认；本次没有重复执行"
        run.receipt = {**run.receipt, "worker": "worker-b"}
        self.plan.last_error = run.error
        await self.session.commit()
        await chats.acknowledge(self.session, self.client, run.id, {
            "instanceId": "worker-a", "conversationId": "shared-chat", "state": "succeeded"
        })
        self.assertEqual(run.state, "succeeded")
        self.assertEqual(run.error, "")
        self.assertEqual(self.plan.last_error, "")

    async def test_previous_worker_can_finish_after_legacy_cross_client_lease_takeover(self):
        from app.services import schedule_conversations as chats
        run, _ = await schedules.claim_run(self.session, self.plan, "timer",
                                           schedules.trigger_identity(self.plan))
        await chats.prepare(self.session, self.plan, self.client, None, run.id, "pi", {})
        await chats.claim(self.session, self.client, run.id, "worker-a")
        await chats.acknowledge(self.session, self.client, run.id, {
            "instanceId": "worker-a", "conversationId": "shared-chat", "state": "running"
        })
        # Older Hubs allowed this takeover. New Hubs only let another worker
        # observe an existing conversation, but must still accept old receipts.
        run.receipt = {**run.receipt, "worker": "worker-b", "previousWorker": "worker-a"}
        await self.session.commit()
        self.assertEqual(run.receipt["previousWorker"], "worker-a")
        await chats.acknowledge(self.session, self.client, run.id, {
            "instanceId": "worker-a", "conversationId": "shared-chat", "state": "succeeded"
        })
        self.assertEqual(run.state, "succeeded")
        self.assertNotIn("previousWorker", run.receipt)

    async def test_current_worker_completion_clears_takeover_marker(self):
        from app.services import schedule_conversations as chats
        run, _ = await schedules.claim_run(self.session, self.plan, "timer",
                                           schedules.trigger_identity(self.plan))
        await chats.prepare(self.session, self.plan, self.client, None, run.id, "pi", {})
        await chats.claim(self.session, self.client, run.id, "worker-a")
        await chats.acknowledge(self.session, self.client, run.id, {
            "instanceId": "worker-a", "conversationId": "shared-chat", "state": "running"
        })
        run.receipt = {**run.receipt, "worker": "worker-b", "previousWorker": "worker-a"}
        await self.session.commit()
        await chats.acknowledge(self.session, self.client, run.id, {
            "instanceId": "worker-b", "conversationId": "shared-chat", "state": "succeeded"
        })
        self.assertNotIn("previousWorker", run.receipt)

    async def test_edit_while_dispatch_is_pending_cannot_consume_new_appointment(self):
        future = datetime.now(UTC) + timedelta(days=2)
        async def edit_during_dispatch(*_args, **_kwargs):
            async with self.factory() as editor:
                row = await editor.get(models.AiSchedule, "schedule")
                admin._sch_apply(row, {"runAt": future.isoformat(), "enabled": True})
                await editor.commit()
            return {"ok": True}
        with patch.object(schedules, "run_one", edit_during_dispatch):
            await schedules.execute_one(self.session, self.plan, idempotency_key=schedules.trigger_identity(self.plan))
        self.assertEqual(schedules._utc(self.plan.run_at), future)
        self.assertFalse(self.plan.once_fired)
        self.assertTrue(self.plan.enabled)
        self.assertIsNone(self.plan.last_run_at)

    async def test_tick_after_restart_catches_up_once_and_respects_pause(self):
        self.plan.enabled = False
        await self.session.commit()
        with patch.object(schedules, "reconcile_runs", AsyncMock()), \
             patch.object(schedules, "run_one", AsyncMock(return_value={"ok": True})) as dispatch:
            self.assertEqual((await schedules.tick(self.session))["fired"], 0)
            dispatch.assert_not_awaited()
            self.plan.enabled = True
            await self.session.commit()
            self.assertEqual((await schedules.tick(self.session))["fired"], 1)
            self.assertEqual((await schedules.tick(self.session))["fired"], 0)
            self.assertEqual(dispatch.await_count, 1)

    async def test_two_scheduler_sessions_share_one_timer_receipt_and_one_handoff(self):
        calls = []
        async def dispatch(_session, _schedule, **options):
            calls.append(options["schedule_run_id"])
            await asyncio.sleep(0.02)
            return {"ok": True}
        async def sweep():
            async with self.factory() as session:
                return await schedules.tick(session)
        with patch.object(schedules, "reconcile_runs", AsyncMock()), patch.object(schedules, "run_one", dispatch):
            result = await asyncio.gather(sweep(), sweep())
        self.assertEqual(len(calls), 1)
        self.assertEqual(sum(item["fired"] for item in result), 1)
        self.assertEqual(len(list((await self.session.execute(select(models.AiScheduleRun))).scalars())), 1)

    async def test_preflight_saved_overdue_date_is_owner_scoped_and_does_not_edit_the_row(self):
        with patch.object(schedules, "preflight_execution", AsyncMock(return_value={"state": "ready"})):
            existing = await api.preflight_my_schedule({"scheduleId": "schedule", "runAt": self.target.isoformat(),
                                                        "note": "probe only"}, self.client, self.session)
            self.assertEqual(existing["state"], "ready")
            self.assertNotEqual(self.plan.note, "probe only")
            new = await api.preflight_my_schedule({"every": "once", "runAt": self.target.isoformat()},
                                                  self.client, self.session)
            self.assertEqual(new["state"], "blocked")
            with self.assertRaises(HTTPException) as error:
                await api.preflight_my_schedule(
                    {"scheduleId": "schedule"}, SimpleNamespace(id="other", user_ref="other-user"), self.session)
            self.assertEqual(error.exception.status_code, 404)

    async def test_model_server_default_is_a_real_false_boolean(self):
        columns = [column.name for column in models.AiSchedule.__table__.columns
                   if column.name not in {"id", "once_fired"}]
        await self.session.execute(text("INSERT INTO ai_schedule (id, " + ", ".join(columns) + ") "
            "SELECT 'raw-default', " + ", ".join(columns) + " FROM ai_schedule WHERE id='schedule'"))
        await self.session.commit()
        row = await self.session.get(models.AiSchedule, "raw-default")
        self.assertFalse(row.once_fired)


if __name__ == "__main__":
    unittest.main()
