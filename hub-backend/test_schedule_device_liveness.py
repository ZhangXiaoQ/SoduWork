"""Device liveness, durable automation receipts and cross-session expiry races.

Use a private file-backed SQLite database so separate Hub sessions do not share
an identity map or connection. No Agent, Runner RPC or model is contacted.
"""
import asyncio
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "isolated-device-liveness-test-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-device-liveness-admin-password")
os.environ["CLUSTER_REDIS_URL"] = ""

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.services import schedule_conversations as chats, schedules
from app.services import schedule_device_liveness as liveness


class ScheduleDeviceLivenessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory(prefix="soduwork-schedule-liveness-")
        self.engine = create_async_engine(
            "sqlite+aiosqlite:///" + (Path(self.tmp.name) / "receipts.db").as_posix(),
            connect_args={"timeout": 20},
        )
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.now = datetime.now(timezone.utc)
        async with self.engine.begin() as connection:
            for table in (models.User.__table__, models.Client.__table__,
                          models.AiSchedule.__table__, models.AiScheduleRun.__table__):
                await connection.run_sync(table.create)
        async with self.sessions() as session:
            session.add_all([
                models.User(id="alice", username="alice", is_active=True),
                models.User(id="bob", username="bob", is_active=True),
                models.Client(id="device", user_ref="alice", auth_state="active",
                              last_seen_at=self.now, config={"automationConversationV1": 1}),
                models.Client(id="peer", user_ref="alice", auth_state="active",
                              last_seen_at=self.now),
                models.Client(id="other", user_ref="bob", auth_state="active",
                              last_seen_at=self.now),
            ])
            await session.commit()
            session.add_all([
                models.AiSchedule(id="plan", title="Device automation", note="Private instruction",
                                  owner_client_id="device", created_by="alice", assignee_id="local:pi",
                                  every="daily", enabled=False, required_capabilities=[]),
                models.AiSchedule(id="other-plan", title="Other account",
                                  owner_client_id="other", created_by="bob", assignee_id="local:pi",
                                  every="daily", enabled=False),
            ])
            await session.commit()

    async def asyncTearDown(self):
        await self.engine.dispose()
        self.tmp.cleanup()

    async def add_run(self, rid="run", *, age=0, state="waiting", receipt=None,
                      plan="plan", device="device", error=""):
        async with self.sessions() as session:
            session.add(models.AiScheduleRun(
                id=rid, schedule_id=plan, owner_client_id=device, state=state,
                started_at=self.now - timedelta(seconds=age), error=error,
                receipt={"executionMode": chats.PROTOCOL, "phase": "device",
                         "conversationInput": {"runId": rid, "text": "Private instruction"},
                         **(receipt or {})},
            ))
            await session.commit()

    async def read_run(self, rid="run"):
        async with self.sessions() as session:
            return await session.get(models.AiScheduleRun, rid)

    async def test_cached_principal_inbox_commits_expiry_without_loading_device_config(self):
        from app.services.auth_principals import DevicePrincipal
        from app.services import device_auth
        await self.add_run("expired", age=liveness.ACCEPT_TIMEOUT_SECONDS + 30)
        await self.add_run("fresh")
        await self.add_run("other-expired", age=liveness.ACCEPT_TIMEOUT_SECONDS + 30,
                           plan="other-plan", device="other")
        principal = DevicePrincipal("device", "alice", "active", 1, True)
        with patch.object(device_auth, "_load_verified_client",
                          AsyncMock(side_effect=AssertionError("Warm identity must not load device config"))):
            async with self.sessions() as session:
                self.assertEqual(await chats.inbox(session, principal),
                                 [{"id": "fresh", "state": "waiting"}])
                # Closing the request session must not roll back the expiry.
        self.assertEqual((await self.read_run("expired")).state, "failed")
        self.assertEqual((await self.read_run("fresh")).state, "waiting")
        self.assertEqual((await self.read_run("other-expired")).state, "waiting")

    def claimed(self, *, lease=None, cid="chat", worker="worker"):
        return {"worker": worker, "conversationId": cid,
                "leaseUntil": lease if lease is not None else self.now.timestamp() + 30}

    async def ack(self, rid="run", *, state="running", worker="worker", cid="chat"):
        async with self.sessions() as session:
            client = await session.get(models.Client, "device")
            return await chats.acknowledge(session, client, rid, {
                "instanceId": worker, "conversationId": cid, "state": state,
            })

    def test_device_activity_is_required_and_uses_utc_for_sqlite_timestamps(self):
        for value in (None, self.now - timedelta(seconds=liveness.DEVICE_ONLINE_SECONDS + 1)):
            with self.subTest(last_seen_at=value):
                self.assertFalse(liveness.device_available(SimpleNamespace(last_seen_at=value), self.now))
        self.assertTrue(liveness.device_available(SimpleNamespace(
            last_seen_at=(self.now - timedelta(seconds=1)).replace(tzinfo=None)), self.now))

    async def test_offline_local_dispatch_never_creates_a_device_envelope(self):
        await self.add_run()
        for seen in (None, self.now - timedelta(seconds=liveness.DEVICE_ONLINE_SECONDS + 1)):
            with self.subTest(last_seen_at=seen):
                async with self.sessions() as session:
                    client = await session.get(models.Client, "device")
                    client.last_seen_at = seen
                    await session.commit()
                    plan = await session.get(models.AiSchedule, "plan")
                    with patch.object(schedules, "resolve_repo", AsyncMock(return_value=None)), \
                            patch.object(schedules, "validate_execution", AsyncMock()), \
                            patch.object(chats, "prepare", AsyncMock()) as prepare:
                        result = await schedules.run_one(session, plan, schedule_run_id="run")
                    self.assertFalse(result["ok"])
                    self.assertEqual(result["code"], "AUTOMATION_TARGET_OFFLINE")
                    prepare.assert_not_awaited()

    async def test_expired_unclaimed_runs_close_on_history_inbox_and_claim_without_replay(self):
        age = liveness.ACCEPT_TIMEOUT_SECONDS + 30
        for entry in ("history", "inbox", "claim"):
            with self.subTest(entry=entry):
                await self.add_run(entry, age=age)
                async with self.sessions() as session:
                    client = await session.get(models.Client, "device")
                    if entry == "history":
                        rows = await schedules.list_runs(session, "plan", owner_client_id="device",
                                                         owner_user_id="alice")
                        self.assertEqual(next(row for row in rows if row["id"] == entry)["state"], "failed")
                    elif entry == "inbox":
                        self.assertNotIn(entry, [row["id"] for row in await chats.inbox(session, client)])
                    else:
                        result = await chats.claim(session, client, entry, "new-worker")
                        self.assertTrue(result.get("terminal"), result)
                        self.assertEqual(result["state"], "failed")
                        self.assertNotIn("input", result)
                    await session.commit()
                run = await self.read_run(entry)
                self.assertEqual(run.state, "failed")
                self.assertEqual(run.receipt.get("errorCode"), "AUTOMATION_DEVICE_TIMEOUT")
                self.assertIsNotNone(run.finished_at)

    async def test_grace_period_and_long_running_renewal_do_not_use_total_run_age(self):
        lease = self.now.timestamp() - liveness.RECEIPT_GRACE_SECONDS + 15
        await self.add_run(age=6 * 3600, state="running", receipt=self.claimed(lease=lease))
        async with self.sessions() as session:
            client = await session.get(models.Client, "device")
            client.last_seen_at = None
            await session.commit()
            run = await session.get(models.AiScheduleRun, "run")
            self.assertFalse(await liveness.expire_run(session, run, now=self.now))
            await session.commit()
        await self.ack()
        renewed = await self.read_run()
        self.assertEqual(renewed.state, "running")
        self.assertGreater(renewed.receipt["leaseUntil"], self.now.timestamp() + 200)
        async with self.sessions() as session:
            run = await session.get(models.AiScheduleRun, "run")
            self.assertFalse(await liveness.expire_run(session, run, now=self.now + timedelta(seconds=150)))

    async def test_another_worker_only_observes_an_existing_conversation(self):
        original = self.claimed(lease=self.now.timestamp() + 30)
        await self.add_run(age=3600, state="running", receipt=original)
        async with self.sessions() as session:
            client = await session.get(models.Client, "device")
            result = await chats.claim(session, client, "run", "replacement-worker")
        self.assertTrue(result.get("observeOnly"), result)
        self.assertNotIn("input", result)
        current = await self.read_run()
        for key in ("worker", "leaseUntil", "conversationId"):
            self.assertEqual(current.receipt[key], original[key])

    async def test_receipt_timeout_cannot_restart_but_original_success_can_settle_it(self):
        await self.add_run(age=3600, state="running", receipt=self.claimed(
            lease=self.now.timestamp() - liveness.RECEIPT_GRACE_SECONDS - 30))
        result = await self.ack(state="running")
        self.assertEqual(result["state"], "failed")
        timed_out = await self.read_run()
        self.assertEqual(timed_out.receipt.get("errorCode"), "AUTOMATION_RECEIPT_TIMEOUT")
        self.assertIsNotNone(timed_out.finished_at)
        with self.assertRaises(HTTPException):
            await self.ack(state="succeeded", worker="intruder")
        with self.assertRaises(HTTPException):
            await self.ack(state="succeeded", cid="another-chat")
        self.assertEqual((await self.read_run()).state, "failed")
        self.assertEqual((await self.ack(state="succeeded"))["state"], "succeeded")
        completed = await self.read_run()
        self.assertEqual(completed.state, "succeeded")
        self.assertEqual(completed.error, "")
        self.assertEqual(completed.receipt["conversationId"], "chat")

    async def test_real_execution_failure_is_not_promoted_by_a_late_success(self):
        await self.add_run(state="failed", receipt=self.claimed(), error="Real execution failure")
        self.assertEqual((await self.ack(state="succeeded"))["state"], "failed")
        run = await self.read_run()
        self.assertEqual((run.state, run.error), ("failed", "Real execution failure"))

    async def test_stale_reconciler_cannot_overwrite_a_renewed_receipt(self):
        await self.add_run(age=3600, state="running", receipt=self.claimed(
            lease=self.now.timestamp() + 10))
        async with self.sessions() as stale:
            snapshot = await stale.get(models.AiScheduleRun, "run")
            await stale.commit()  # Retain the old identity map without holding a SQLite read lock.
            await self.ack(state="running")
            self.assertFalse(await liveness.expire_run(
                stale, snapshot, now=self.now + timedelta(seconds=liveness.RECEIPT_GRACE_SECONDS + 20)))
            await stale.commit()
        current = await self.read_run()
        self.assertEqual(current.state, "running")
        self.assertGreater(current.receipt["leaseUntil"], self.now.timestamp() + 200)
        self.assertIsNone(current.finished_at)

    async def test_stale_reconciler_cannot_overwrite_a_completed_receipt(self):
        await self.add_run(age=3600, state="running", receipt=self.claimed(
            lease=self.now.timestamp() + 10))
        async with self.sessions() as stale:
            snapshot = await stale.get(models.AiScheduleRun, "run")
            await stale.commit()
            await self.ack(state="succeeded")
            self.assertFalse(await liveness.expire_run(
                stale, snapshot, now=self.now + timedelta(seconds=liveness.RECEIPT_GRACE_SECONDS + 20)))
            await stale.commit()
        self.assertEqual((await self.read_run()).state, "succeeded")

    async def test_stale_reconciler_cannot_restore_old_identity_when_lease_is_unchanged(self):
        for key, replacement in (("worker", "replacement-worker"),
                                 ("conversationId", "replacement-chat")):
            with self.subTest(changed_field=key):
                receipt = self.claimed(
                    lease=self.now.timestamp() - liveness.RECEIPT_GRACE_SECONDS - 30)
                await self.add_run(key, age=3600, state="running", receipt=receipt)
                async with self.sessions() as stale:
                    snapshot = await stale.get(models.AiScheduleRun, key)
                    await stale.commit()
                    # Model an older client's handoff or a migration that changes
                    # identity metadata without issuing a new renewable lease.
                    async with self.sessions() as writer:
                        current = await writer.get(models.AiScheduleRun, key)
                        current.receipt = {**current.receipt, key: replacement}
                        await writer.commit()
                    self.assertFalse(await liveness.expire_run(stale, snapshot, now=self.now))
                    await stale.commit()
                current = await self.read_run(key)
                self.assertEqual(current.state, "running")
                self.assertIsNone(current.finished_at)
                self.assertNotIn("errorCode", current.receipt)
                self.assertEqual(current.receipt["leaseUntil"], receipt["leaseUntil"])
                for identity in ("worker", "conversationId"):
                    self.assertEqual(current.receipt[identity],
                                     replacement if identity == key else receipt[identity])

    async def test_concurrent_reconcilers_only_expire_the_same_snapshot_once(self):
        await self.add_run(age=liveness.ACCEPT_TIMEOUT_SECONDS + 30)
        async with self.sessions() as first, self.sessions() as second:
            snapshots = [await first.get(models.AiScheduleRun, "run"),
                         await second.get(models.AiScheduleRun, "run")]
            await first.commit()
            await second.commit()

            async def expire(session, run):
                changed = await liveness.expire_run(session, run, now=self.now)
                await session.commit()
                return changed

            results = await asyncio.gather(expire(first, snapshots[0]), expire(second, snapshots[1]))
        self.assertEqual(sum(bool(value) for value in results), 1)
        self.assertEqual((await self.read_run()).state, "failed")

    async def test_legacy_expiry_preserves_edited_calendar_summary_and_retry(self):
        for index, changes in enumerate(({}, {"end_date": "2030-01-31"},
                                         {"every": "monthly", "month_days": [31]},
                                         {"every": "weekly", "weekdays": [1, 3]})):
            with self.subTest(changes=changes):
                run_id = "legacy-expiry-" + str(index)
                await self.add_run(run_id, age=liveness.ACCEPT_TIMEOUT_SECONDS + 30 - index,
                                   receipt={"timing": {"every": "daily"}})
                async with self.sessions() as session:
                    schedule = await session.get(models.AiSchedule, "plan")
                    schedule.every, schedule.weekdays, schedule.month_days = "daily", [], []
                    schedule.start_date, schedule.end_date = None, None
                    for field, value in changes.items():
                        setattr(schedule, field, value)
                    schedule.last_error = "Current configuration status"
                    schedule.retry_count, schedule.next_retry_at = 0, None
                    await session.commit()
                    run = await session.get(models.AiScheduleRun, run_id)
                    self.assertTrue(await liveness.expire_run(session, run, now=self.now))
                    await session.commit()
                    await session.refresh(schedule)
                    self.assertEqual(run.state, "failed")
                    if changes:
                        self.assertEqual(schedule.last_error, "Current configuration status")
                    else:
                        self.assertIn("执行端未在规定时间内接收", schedule.last_error)
                    self.assertEqual(schedule.retry_count, 0)
                    self.assertIsNone(schedule.next_retry_at)

    async def test_scoped_expiry_selects_oldest_expired_native_not_cloud_or_other_accounts(self):
        await self.add_run("oldest", age=7200)
        await self.add_run("next", age=3600)
        await self.add_run("fresh")
        await self.add_run("cloud", age=14400, state="running",
                           receipt={"executionMode": schedules.CLOUD_PROTOCOL})
        await self.add_run("other", age=18000, plan="other-plan", device="other")
        async with self.sessions() as session:
            await liveness.reconcile_expired(session, owner_user_id="alice", limit=1, now=self.now)
            await session.commit()
        self.assertEqual((await self.read_run("oldest")).state, "failed")
        for rid, state in (("next", "waiting"), ("fresh", "waiting"),
                           ("cloud", "running"), ("other", "waiting")):
            self.assertEqual((await self.read_run(rid)).state, state, rid)

    async def test_switched_account_and_same_account_peer_cannot_read_claim_or_ack_device_run(self):
        await self.add_run(age=3600, state="running", receipt=self.claimed(
            lease=self.now.timestamp() - liveness.RECEIPT_GRACE_SECONDS - 30))
        async with self.sessions() as session:
            device = await session.get(models.Client, "device")
            device.user_ref = "bob"
            await session.commit()
        for client_id in ("device", "peer", "other"):
            with self.subTest(client=client_id):
                async with self.sessions() as session:
                    client = await session.get(models.Client, client_id)
                    self.assertEqual(await chats.inbox(session, client), [])
                    for operation in (
                        lambda: chats.claim(session, client, "run", "worker"),
                        lambda: chats.acknowledge(session, client, "run", {
                            "instanceId": "worker", "conversationId": "chat", "state": "succeeded"}),
                    ):
                        with self.assertRaises(HTTPException) as caught:
                            await operation()
                        self.assertEqual(caught.exception.status_code, 404)
        self.assertEqual((await self.read_run()).state, "running")

    async def test_cloud_dispatch_and_history_do_not_depend_on_origin_device_liveness(self):
        from app.services import cloud_conversations, runner_hub
        await self.add_run(age=3600, state="running")
        runner = SimpleNamespace(id="cloud", client_id="", host="Isolated cloud")
        async with self.sessions() as session:
            client = await session.get(models.Client, "device")
            client.last_seen_at = None
            plan = await session.get(models.AiSchedule, "plan")
            plan.assignee_id = "runner:cloud:pi"
            await session.commit()
            with patch.object(schedules, "resolve_repo", AsyncMock(return_value=None)), \
                    patch.object(schedules, "validate_execution", AsyncMock()), \
                    patch.object(runner_hub, "get", return_value=runner), \
                    patch.object(cloud_conversations, "create", AsyncMock(return_value={"ref": "isolated"})) as create:
                result = await schedules.run_one(session, plan, schedule_run_id="run")
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["executionMode"], schedules.CLOUD_PROTOCOL)
            create.assert_awaited_once()
            await session.commit()
            await schedules.reconcile_runs(session, schedule_id="plan")
            await session.commit()
        self.assertEqual((await self.read_run()).state, "running")


if __name__ == "__main__":
    unittest.main()
