"""Exercise automation dispatch with a private DB and an isolated Runner RPC.

Keep provider loading, executor selection, model resolution and run receipts real.
The RPC boundary never starts an Agent or contacts a model service.
"""
import hashlib
import importlib
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "isolated-schedule-runner-test-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-test-password")

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.api import personal_schedules
from app.db import Base
from app.services import (
    ai_exec, ai_local, ai_remote, client_access, dispatch_identity,
    model_catalog, runner_hub, schedule_conversations, schedules,
)
from app.services import cloud_conversations, conversation_handoffs, task_dispatch, tasks as task_service
from app.conversation_handoff_models import ConversationHandoff
from tests.sqlite_schema import create_fresh_sqlite_schema

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


class ScheduleRunnerDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as connection:
            await create_fresh_sqlite_schema(connection, Base.metadata)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.owner = models.User(id="owner", username="owner", is_active=True)
        self.client = models.Client(id="device", user_ref="owner", auth_state="active", config={},
                                    last_seen_at=datetime.now(timezone.utc))
        self.session.add_all([self.owner, self.client])
        await self.session.flush()
        self.schedule = models.AiSchedule(
            id="schedule", owner_client_id="device", owner_user_id="owner",
            title="Scheduled instruction", note="Keep the complete instruction and acceptance criteria",
            assignee_id="local:codex", assignee_type="agent", enabled=False,
            every="daily", time_zone="Asia/Shanghai", required_capabilities=[],
        )
        self.session.add(self.schedule)
        await self.session.commit()
        self.runner = runner_hub._Runner(None, {
            "runnerId": "desktop", "clientId": "device", "host": "isolated-device",
            "version": "1.13.3", "bootId": "test-boot", "inventoryReady": True,
            "agents": [{"key": "codex", "name": "Codex", "auth": "authed"}],
            "tags": [runner_hub.CLIENT_TAG],
            "skills": ["office"], "workRoot": "X:/isolated-workspace",
        })
        self.runner.ready = True
        self.runner.dispatch_mode = "accepting"
        self.calls = []

        def rpc(runner, op, data, **kwargs):
            if runner is not self.runner or op != "job.dispatch":
                raise AssertionError("Unexpected external Runner RPC: " + op)
            self.calls.append(data)
            return {"ok": True, "data": {
                "ref": dispatch_identity.execution_ref(data["dispatchId"]),
                "identifier": "isolated-job", "state": "running", "dispatchId": data["dispatchId"],
            }}

        self.patches = [
            patch.object(ai_local, "_HUB_CLUSTER_MODE", True),
            patch.object(runner_hub, "_RUNNERS", {self.runner.id: self.runner}),
            patch.object(runner_hub, "call_sync", side_effect=rpc),
            patch.object(ai_remote, "_WHERE", ai_remote.OrderedDict()),
            patch.object(client_access, "_policy_cache", None),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()

    async def cloud_target(self):
        self.runner = runner_hub._Runner(None, {
            "runnerId": "cloud", "host": "Cloud fixture", "version": "999.0.0", "inventoryReady": True,
            "workRoot": "X:/isolated-cloud", "agents": [{"key": "codex", "auth": "authed"}],
            "caps": ["handoff1"], "skills": [],
            "capabilities": {"schemaVersion": 3, "available": ["files", "terminal"]},
        })
        self.runner.owner_user_id = "owner"
        self.runner.org_id = "team"
        self.runner.ready = True
        self.runner.dispatch_mode = "accepting"
        runner_hub._RUNNERS.clear()
        runner_hub._RUNNERS["cloud"] = self.runner
        self.session.add(models.OrgUnit(id="team", name="Team"))
        self.owner.org_id = "team"
        self.session.add(am.RunnerNode(id="cloud", owner_user_id="owner", org_id="team"))
        self.schedule.assignee_id = "runner:cloud:codex"
        await self.session.commit()

    async def preflight(self, client=None):
        return await personal_schedules.preflight_my_schedule(
            {"scheduleId": "schedule"}, client or self.client, self.session)

    async def test_cloud_preflight_uses_authorized_target_without_launching(self):
        await self.cloud_target()
        result = await self.preflight()
        self.assertEqual(result["state"], "ready", result)
        self.assertEqual(result["executionMode"], schedules.CLOUD_PROTOCOL)
        self.assertEqual(result["machine"]["id"], "cloud")
        self.assertEqual(self.calls, [])
        self.assertIsNone(await self.session.scalar(select(models.AiScheduleRun)))

    async def test_cross_device_occurrence_has_execution_intent_without_rewriting_user_note(self):
        await self.cloud_target()
        note = '创建晨报，每天09:00，工作内容：只回复 AUTO-OK，不读写文件，先暂停保存。'
        self.schedule.note = note
        async def dispatch(task_id, body, client, session):
            return {"ok": True, "ref": "fixture-ref"}
        with patch.object(task_dispatch, "dispatch", side_effect=dispatch):
            result = await personal_schedules.run_my_schedule(
                "schedule", body={}, client=self.client, session=self.session)
        self.assertTrue(result['ok'], result)
        run = await self.session.get(models.AiScheduleRun, result['scheduleRunId'])
        handoff = await self.session.get(ConversationHandoff,
            conversation_handoffs.identity(self.client.id, run.receipt['conversationId']))
        self.assertTrue(handoff.options['instruction'].startswith('【执行已有自动化的本轮工作】'))
        self.assertIn(note, handoff.options['instruction'])
        self.assertIn('不要再次创建本自动化', handoff.options['instruction'])
        self.assertNotIn('【执行已有自动化的本轮工作】', handoff.options['userText'])
        self.assertEqual(self.schedule.note, note)
        self.assertFalse(self.schedule.enabled)

    async def test_cloud_occurrence_creates_valid_handoff_and_retries_without_dispatching_twice(self):
        await self.cloud_target()
        dispatched = []

        async def dispatch(task_id, body, client, session):
            dispatched.append(task_id)
            return {"ok": True, "ref": "fixture-ref"}

        # Keep cloud creation, validation and persistence real; isolate execution.
        with patch.object(task_dispatch, "dispatch", side_effect=dispatch):
            result = await personal_schedules.run_my_schedule(
                "schedule", body={}, client=self.client, session=self.session)
            self.assertTrue(result["ok"], result)
            run = await self.session.get(models.AiScheduleRun, result["scheduleRunId"])
            request_id = run.receipt["conversationId"]
            row_id = conversation_handoffs.identity(self.client.id, request_id)
            handoff = await self.session.get(ConversationHandoff, row_id)
            self.assertIsNotNone(handoff)
            self.assertEqual(handoff.options["targetRunnerId"], "cloud")
            self.assertEqual(run.receipt["executionMode"], schedules.CLOUD_PROTOCOL)
            self.assertFalse(self.schedule.enabled)
            self.assertEqual(dispatched, [handoff.task_id])
            original_hash = handoff.request_hash
            retried = await schedules.run_one(self.session, self.schedule,
                schedule_run_id=run.id, conversation_title=run.receipt["conversationTitle"])
            self.assertTrue(retried["ok"], retried)
            self.assertEqual(retried["taskId"], handoff.task_id)
            self.assertEqual(handoff.request_hash, original_hash)
            self.assertEqual(dispatched, [handoff.task_id])
            with patch.object(task_service, "ai_states", return_value={
                    handoff.task_id: {"executionState": "running"}}):
                await schedules.reconcile_runs(self.session, schedule_id="schedule")
                self.assertEqual(run.task_id, handoff.task_id)
                self.assertEqual(run.state, "running")
                self.assertNotIn("migratedFrom", run.receipt)
            # Reproduce the damaged receipt left by the previous implementation.
            run.task_id, run.state, run.error = "", "failed", "Legacy migration error"
            run.receipt = {**run.receipt, "migratedFrom": "legacy-task-workflow"}
            await self.session.commit()
            original_owner = run.owner_user_id
            run.owner_user_id = "another-account"
            with patch.object(task_service, "ai_states", return_value={
                    handoff.task_id: {"executionState": "done"}}):
                await schedules.reconcile_runs(self.session, schedule_id="schedule")
                self.assertEqual(run.task_id, "", "Recovery must validate the original account")
                run.owner_user_id = original_owner
                await schedules.reconcile_runs(self.session)
                self.assertEqual(run.task_id, handoff.task_id)
                self.assertEqual(run.state, "succeeded")
                self.assertEqual(run.error, "")
                self.assertNotIn("migratedFrom", run.receipt)
                await schedules.reconcile_runs(self.session, schedule_id="schedule")
                self.assertEqual(run.state, "succeeded")
            self.assertEqual(dispatched, [handoff.task_id])

    async def test_new_cloud_occurrence_sends_readable_stable_trigger_time(self):
        await self.cloud_target()
        run = await schedules.begin_run(self.session, self.schedule, "timer")
        run.started_at = datetime(2026, 11, 5, 6, 55, 14, 655257, tzinfo=timezone.utc)
        await self.session.commit()
        dispatch = AsyncMock(return_value={"ok": True, "ref": "readable-time-ref"})
        with patch.object(task_dispatch, "dispatch", dispatch):
            result = await schedules.run_one(self.session, self.schedule, schedule_run_id=run.id)
            self.assertTrue(result["ok"], result)
            handoff = await self.session.scalar(select(ConversationHandoff))
            expected = (self.schedule.title + "\n\n" + self.schedule.note +
                        "\n\n自动化触发时间：2026-11-05 14:55:14（北京时间）")
            # Execution includes the saved-run intent guard; the display text
            # retains the exact business instruction and stable trigger time.
            from app.services.schedule_instruction import for_run
            self.assertEqual(handoff.options["instruction"], for_run(expected))
            self.assertEqual(handoff.options["userText"], expected)
            original_hash = handoff.request_hash
            retried = await schedules.run_one(self.session, self.schedule, schedule_run_id=run.id)
        self.assertTrue(retried["ok"], retried)
        self.assertEqual(retried["taskId"], result["taskId"])
        self.assertEqual(handoff.request_hash, original_hash)
        dispatch.assert_awaited_once()
        self.assertEqual(self.calls, [])

    async def test_cloud_old_iso_handoff_recovers_before_run_receipt_without_duplicate_task(self):
        await self.cloud_target()
        run = await schedules.begin_run(self.session, self.schedule, "timer")
        run.started_at = datetime(2026, 11, 5, 6, 55, 14, 655257, tzinfo=timezone.utc)
        await self.session.commit()
        request_id = "schedule-" + hashlib.sha256(
            (self.schedule.id + ":" + run.id).encode("utf-8")).hexdigest()
        old_text = (self.schedule.title + "\n\n" + self.schedule.note +
                    "\n\n自动化触发时间：2026-11-05T14:55:14.655257+08:00")
        dispatch = AsyncMock(return_value={"ok": True, "ref": "legacy-time-ref"})
        with patch.object(task_dispatch, "dispatch", dispatch):
            original = await cloud_conversations.create(self.session, self.client, request_id, {
                "sessionId": request_id, "agentId": "codex", "model": "",
                "title": self.schedule.title, "text": old_text, "userText": old_text,
                "requiredSkills": [], "targetRunnerId": "cloud", "targetRunnerKind": "cloud",
            }, [])
            # A crash here has committed the handoff, but not linked the run.
            await self.session.refresh(run)
            self.assertEqual(run.state, "starting")
            self.assertFalse(run.task_id)
            self.assertNotIn("executionMode", run.receipt)
            handoff = await self.session.scalar(select(ConversationHandoff))
            original_hash = handoff.request_hash
            with patch.object(cloud_conversations, "create", wraps=cloud_conversations.create) as create:
                recovered = await schedules.run_one(self.session, self.schedule, schedule_run_id=run.id)
            self.assertEqual(create.await_count, 2)
            self.assertTrue(create.await_args_list[0].args[3]["text"].endswith(
                "2026-11-05 14:55:14（北京时间）"))
            self.assertEqual(create.await_args_list[1].args[3]["text"], old_text)
            self.assertEqual(create.await_args_list[1].args[3]["userText"], old_text)
            # Legacy formatting must not authorize a changed instruction.
            self.schedule.note += " Changed after the original submission."
            await self.session.commit()
            with self.assertRaises(HTTPException) as changed:
                await schedules.run_one(self.session, self.schedule, schedule_run_id=run.id)
            self.assertEqual(changed.exception.status_code, 409)
            self.assertEqual(changed.exception.detail,
                             "此云端会话请求编号已用于另一条消息或附件，请使用原请求重试")
        self.assertTrue(recovered["ok"], recovered)
        self.assertEqual(recovered["taskId"], original["taskId"])
        self.assertEqual(run.receipt["conversationId"], request_id)
        self.assertEqual(run.receipt["executionMode"], schedules.CLOUD_PROTOCOL)
        self.assertEqual(handoff.request_hash, original_hash)
        self.assertEqual(handoff.options["instruction"], old_text)
        self.assertEqual(len((await self.session.scalars(select(models.Task))).all()), 1)
        self.assertEqual(len((await self.session.scalars(select(ConversationHandoff))).all()), 1)
        dispatch.assert_awaited_once()
        self.assertEqual(self.calls, [])

    async def test_cloud_other_conflicts_never_retry_with_legacy_trigger_time(self):
        await self.cloud_target()
        run = await schedules.begin_run(self.session, self.schedule, "timer")
        await self.session.commit()
        conflict = HTTPException(409, "暂时没有匹配 Agent、技能且可接单的云端环境")
        with patch.object(cloud_conversations, "create", AsyncMock(side_effect=conflict)) as create:
            with self.assertRaises(HTTPException) as caught:
                await schedules.run_one(self.session, self.schedule, schedule_run_id=run.id)
        self.assertIs(caught.exception, conflict)
        create.assert_awaited_once()
        self.assertIsNone(await self.session.scalar(select(ConversationHandoff)))
        self.assertIsNone(await self.session.scalar(select(models.Task)))
        self.assertEqual(self.calls, [])

    async def test_unavailable_or_reassigned_cloud_target_cannot_pass_preflight(self):
        await self.cloud_target()
        for change in ("offline", "owner", "skills"):
            with self.subTest(change=change):
                self.runner.dispatch_mode = "draining" if change == "offline" else "accepting"
                row = await self.session.get(am.RunnerNode, "cloud")
                row.owner_user_id = "another" if change == "owner" else "owner"
                if change == "owner":
                    self.session.add(models.User(id="another", username="another"))
                self.schedule.required_capabilities = ["computer"] if change == "skills" else []
                await self.session.commit()
                result = await self.preflight()
                self.assertNotEqual(result["state"], "ready", result)
                self.assertNotIn("executionMode", result)
                self.assertEqual(self.calls, [])

    async def test_remote_personal_plugin_is_blocked_before_local_consumer(self):
        await self.cloud_target()
        self.schedule.personal_plugin_key = "private-method"
        await self.session.commit()
        result = await self.preflight()
        self.assertEqual(result["state"], "blocked", result)
        self.assertNotIn("executionMode", result)

    async def test_offline_explicit_target_never_queues_on_the_creator_device(self):
        await self.cloud_target()
        runner_hub._RUNNERS.clear()
        result = await self.preflight()
        self.assertEqual(result['state'], 'waiting')
        self.assertIn('不在线', result['message'])
        result = await schedules.run_one(self.session, self.schedule)
        self.assertEqual(result['code'], 'AUTOMATION_TARGET_OFFLINE')
        self.assertEqual(self.calls, [])
        self.assertIsNone(await self.session.scalar(select(models.AiScheduleRun)))

    async def test_phone_schedule_pins_own_online_pc_through_the_same_handoff(self):
        await self.cloud_target()
        pc = models.Client(id='own-pc', user_ref='owner', auth_state='active')
        self.session.add(pc)
        node = await self.session.get(am.RunnerNode, 'cloud')
        node.client_id = 'own-pc'
        self.runner.client_id = 'own-pc'
        self.runner.tags = [runner_hub.CLIENT_TAG]
        await self.session.commit()
        result = await self.preflight()
        self.assertEqual(result['state'], 'ready', result)
        async def dispatch(task_id, body, client, session):
            return {'ok': True, 'ref': 'fixture-own-pc'}
        with patch.object(task_dispatch, 'dispatch', dispatch):
            result = await personal_schedules.run_my_schedule('schedule', body={}, client=self.client, session=self.session)
        self.assertTrue(result['ok'], result)
        handoff = await self.session.scalar(select(ConversationHandoff))
        self.assertEqual(handoff.options['targetRunnerId'], 'cloud')
        self.assertEqual(handoff.options['targetRunnerKind'], 'work-computer')

    async def test_due_phone_timer_keeps_offline_pc_target_even_with_available_cloud(self):
        await self.cloud_target()
        cloud = self.runner
        cloud.owner_user_id = ''
        (await self.session.get(am.RunnerNode, 'cloud')).owner_user_id = None
        await self.session.flush()
        pc = models.Client(id='own-pc', user_ref='owner', auth_state='active')
        self.session.add_all([pc, am.RunnerNode(
            id='offline-pc', client_id=pc.id, owner_user_id='owner', org_id='team')])
        self.schedule.assignee_id = 'runner:offline-pc:codex'
        self.schedule.every = 'once'
        self.schedule.run_at = datetime.now(timezone.utc) - timedelta(seconds=10)
        self.schedule.enabled = True
        self.schedule.once_fired = False
        self.schedule.retry_limit = 1
        self.schedule.retry_delay_minutes = 1
        await self.session.commit()
        self.assertTrue(cloud.ready)
        self.assertTrue(schedules.due(self.schedule))
        key = schedules.trigger_identity(self.schedule, 'timer')
        first = await schedules.execute_one(self.session, self.schedule, trigger='timer', idempotency_key=key)
        await self.session.commit()
        self.assertFalse(first['ok'])
        self.assertEqual(first['code'], 'AUTOMATION_TARGET_OFFLINE')
        self.assertTrue(self.schedule.once_fired)
        self.assertIsNotNone(self.schedule.next_retry_at)
        duplicate = await schedules.execute_one(self.session, self.schedule, trigger='timer', idempotency_key=key)
        self.assertTrue(duplicate['deduplicated'])
        self.schedule.next_retry_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await self.session.commit()
        retry = await schedules.execute_one(self.session, self.schedule, trigger='retry',
                                            idempotency_key=schedules.trigger_identity(self.schedule, 'retry'))
        await self.session.commit()
        self.assertFalse(retry['ok'])
        self.assertEqual(retry['code'], 'AUTOMATION_TARGET_OFFLINE')
        self.assertFalse(self.schedule.enabled)
        self.assertIsNone(self.schedule.next_retry_at)
        self.assertEqual(self.schedule.assignee_id, 'runner:offline-pc:codex')
        self.assertEqual(self.calls, [], 'The available cloud Runner must never receive the PC timer')
        self.assertIsNone(await self.session.scalar(select(ConversationHandoff)))
        self.assertIsNone(await self.session.scalar(select(models.Task)))
        runs = list((await self.session.scalars(select(models.AiScheduleRun))).all())
        self.assertEqual(len(runs), 2)
        self.assertEqual([run.state for run in runs], ['failed', 'failed'])

    async def test_peer_device_preflight_retains_the_original_execution_identity(self):
        self.schedule.assignee_id = "runner:desktop:codex"
        peer = models.Client(id="peer", user_ref="owner", auth_state="active")
        self.session.add(peer)
        await self.session.commit()
        result = await self.preflight(peer)
        self.assertEqual(result["state"], "ready", result)
        self.assertNotIn("executionMode", result, "the original desktop still consumes this plan")
        self.assertEqual(self.schedule.owner_client_id, "device")
        self.client.user_ref = "changed-account"
        await self.session.commit()
        result = await self.preflight(peer)
        self.assertEqual(result["state"], "blocked", result)

    async def run_schedule(self):
        result = await personal_schedules.run_my_schedule(
            "schedule", body={}, client=self.client, session=self.session)
        self.assertTrue(result["ok"])
        self.assertEqual(result["executionMode"], schedule_conversations.PROTOCOL)
        self.assertEqual(self.calls, [], "Hub must not launch task RPC for an ordinary conversation")
        self.assertIsNone(await self.session.scalar(select(models.Task)))
        self.assertIsNone(await self.session.scalar(select(am.ExecutionSession)))
        run = await self.session.get(models.AiScheduleRun, result["scheduleRunId"])
        self.assertEqual(run.state, "waiting")
        self.assertEqual(run.owner_user_id, "owner")
        self.assertFalse(run.task_id or run.workflow_run_id)
        return run, run.receipt["conversationInput"]

    async def test_desktop_native_account_queues_without_a_hub_local_cli(self):
        ctx = await ai_exec.load(self.session, force=True)
        self.assertFalse(ai_exec.configured(ctx))
        run, envelope = await self.run_schedule()
        self.assertEqual(envelope["adapterId"], "codex")
        self.assertIn(self.schedule.note, envelope["text"])
        self.assertEqual(envelope["runId"], run.id)
        self.assertEqual(envelope["modelName"], "")

    async def test_personal_plugin_keeps_pinned_identity_and_inputs_for_owner_device(self):
        self.schedule.personal_plugin_key = "personal-method"
        self.schedule.personal_plugin_version_policy = "pinned"
        self.schedule.personal_plugin_version = "2.0.0"
        self.schedule.personal_plugin_checksum = "a" * 64
        self.schedule.plugin_inputs = {"instruction": "Keep this plugin input", "count": 2}
        await self.session.commit()
        run, envelope = await self.run_schedule()
        self.assertEqual(envelope["personalPlugin"], {
            "key": "personal-method", "versionPolicy": "pinned", "version": "2.0.0",
            "checksum": "a" * 64})
        self.assertIn("Keep this plugin input", envelope["text"])
        self.assertIn('"count": 2', envelope["text"])
        claimed = await schedule_conversations.claim(self.session, self.client, run.id, "owner-worker")
        self.assertEqual(claimed["input"], envelope)

    async def test_gateway_agent_uses_explicit_schedule_model_without_forwarding_credentials(self):
        self.schedule.assignee_id, self.schedule.model_name = "local:pi", "selected-model"
        self.client.agent_models = {"pi": "different-composer-model"}
        self.session.add_all([
            models.ModelProvider(id="private", base_url="https://model.invalid/v1", api_key="fixture-key"),
            models.ModelDef(id="private:selected-model", provider_id="private", name="selected-model")])
        await self.session.commit()
        _, envelope = await self.run_schedule()
        self.assertEqual(envelope["modelName"], "selected-model")
        self.assertEqual(envelope["adapterId"], "pi")
        self.assertNotIn("fixture-key", json.dumps(envelope))
        self.assertNotIn("https://model.invalid", json.dumps(envelope))

    async def test_unavailable_explicit_model_fails_with_durable_receipt(self):
        self.schedule.assignee_id, self.schedule.model_name = "local:pi", "removed-model"
        await self.session.commit()
        with self.assertRaises(HTTPException) as caught:
            await personal_schedules.run_my_schedule("schedule", body={}, client=self.client, session=self.session)
        self.assertIn("removed-model", caught.exception.detail)
        self.assertEqual(self.calls, [])
        run = await self.session.scalar(select(models.AiScheduleRun))
        self.assertEqual(run.state, "failed")
        self.assertIn("removed-model", run.error)
        self.assertFalse(run.task_id)

    async def test_disabled_explicit_model_cannot_reuse_legacy_credentials(self):
        self.schedule.assignee_id, self.schedule.model_name = "local:pi", "disabled-model"
        self.session.add_all([
            models.AppSetting(key="llm_base_url", value="https://disabled-model.invalid/v1"),
            models.AppSetting(key="llm_api_key", value="disabled-fixture-key"),
            models.AppSetting(key="llm_model", value="disabled-model"),
            models.ModelProvider(id="company", base_url="https://disabled-model.invalid/v1",
                                 api_key="disabled-fixture-key", enabled=False),
            models.ModelDef(id="company:disabled-model", provider_id="company",
                            name="disabled-model", enabled=False)])
        await self.session.commit()
        with self.assertRaises(HTTPException):
            await personal_schedules.run_my_schedule("schedule", body={}, client=self.client, session=self.session)
        run = await self.session.scalar(select(models.AiScheduleRun))
        self.assertEqual(run.state, "failed")
        self.assertNotIn("disabled-fixture-key", json.dumps(run.receipt))
        self.assertEqual(self.calls, [])

    async def test_empty_schedule_model_follows_runtime_default_not_saved_composer_model(self):
        self.schedule.assignee_id = "local:pi"
        self.client.agent_models = {"pi": "removed-composer-model"}
        await self.session.commit()
        _, envelope = await self.run_schedule()
        self.assertEqual(envelope["modelName"], "")

    async def test_runner_offline_or_logged_out_waits_for_owner_device_instead_of_task_fallback(self):
        for case in ("other-device", "draining", "logged-out", "missing-agent"):
            with self.subTest(case=case):
                self.runner.client_id = "other" if case == "other-device" else "device"
                self.runner.dispatch_mode = "draining" if case == "draining" else "accepting"
                self.runner.agents = ([] if case == "missing-agent" else [
                    {"key": "codex", "name": "Codex", "auth": "unauthed" if case == "logged-out" else "authed"}])
                run, _ = await self.run_schedule()
                self.assertIsNone(run.finished_at)
        runs = (await self.session.scalars(select(models.AiScheduleRun))).all()
        self.assertEqual(len(runs), 4)
        self.assertEqual([run.state for run in runs], ["waiting"] * 4)

    async def test_capability_contract_reaches_device_and_actual_failure_is_retained(self):
        self.schedule.required_capabilities = ["browser"]
        await self.session.commit()
        run, envelope = await self.run_schedule()
        self.assertEqual(envelope["capabilities"], ["browser"])
        self.assertEqual(envelope["skills"], ["browser-use"])
        await schedule_conversations.claim(self.session, self.client, run.id, "capability-worker")
        await schedule_conversations.acknowledge(self.session, self.client, run.id, {
            "instanceId": "capability-worker", "state": "failed", "error": "本次所需能力尚未安装或授权"})
        await schedules.reconcile_runs(self.session, schedule_id="schedule")
        self.assertEqual(run.state, "failed")
        self.assertEqual(run.error, "本次所需能力尚未安装或授权")
        self.assertFalse(run.task_id)
        self.assertIsNone(await self.session.scalar(select(models.TaskEvent)))

    async def test_exhausted_quota_is_enforced_at_conversation_execution_and_failure_is_durable(self):
        self.session.add(models.AppSetting(key=client_access.POLICY_KEY, value=json.dumps({
            "tokenLimitEnabled": True, "monthlyTokenLimit": 10})))
        self.session.add(models.AIUsageEvent(
            idempotency_key="fixture-usage", billing_user_id="owner", total_tokens=10))
        await self.session.commit()
        run, _ = await self.run_schedule()
        await schedule_conversations.claim(self.session, self.client, run.id, "quota-worker")
        with self.assertRaises(client_access.ClientAccessError) as caught:
            await client_access.assert_quota(self.session, "owner")
        self.assertEqual(caught.exception.code, "TOKEN_QUOTA_EXCEEDED")
        await schedule_conversations.acknowledge(self.session, self.client, run.id, {
            "instanceId": "quota-worker", "state": "failed", "error": caught.exception.code})
        await schedules.reconcile_runs(self.session, schedule_id="schedule")
        self.assertEqual(run.state, "failed")
        self.assertEqual(run.error, "TOKEN_QUOTA_EXCEEDED")
        self.assertEqual(self.calls, [])

    async def test_account_change_does_not_reassign_saved_automation(self):
        self.client.user_ref = "another-account"
        await self.session.commit()
        with self.assertRaises(HTTPException) as caught:
            await personal_schedules.run_my_schedule("schedule", body={}, client=self.client, session=self.session)
        self.assertEqual(caught.exception.status_code, 404)
        self.assertIsNone(await self.session.scalar(select(models.AiScheduleRun)))

    async def test_other_device_or_changed_account_cannot_claim_private_prompt(self):
        run, _ = await self.run_schedule()
        for client in (models.Client(id="other", user_ref="owner"),
                       models.Client(id="device", user_ref="different-account")):
            with self.subTest(device=client.id, account=client.user_ref):
                with self.assertRaises(HTTPException) as caught:
                    await schedule_conversations.claim(self.session, client, run.id, "intruder")
                self.assertEqual(caught.exception.status_code, 404)
        self.assertNotIn("worker", run.receipt)

    async def test_conversation_handoff_works_with_and_without_legacy_capability_flag(self):
        for config in ({}, {"automationConversationV1": 1}):
            self.client.config = config
            await self.session.commit()
            run, envelope = await self.run_schedule()
            self.assertEqual(envelope["runId"], run.id)


if __name__ == "__main__":
    unittest.main()
