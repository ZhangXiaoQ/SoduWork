"""Direct-task rework restores credentials and never moves its pinned execution."""
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app import automation_models as am, models
from app.services import ai_exec, ai_remote, model_catalog, runner_hub, task_continuation, task_rework
from tests.test_rework_lifecycle import _Base
import unittest


class ReadThroughIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def test_remote_reader_uses_registry_and_never_requesting_device(self):
        from app.services import execution_sessions
        task = SimpleNamespace(id="task", owner_client_id="phone", owner_user_id="owner")
        node = SimpleNamespace(client_id="", org_id="org", owner_user_id="owner",
            auth_state="active", management_state="")
        owner = SimpleNamespace(user_ref="owner", auth_state="active")
        session = SimpleNamespace(get=AsyncMock(side_effect=[node, owner]))
        with patch.object(execution_sessions, "ingest_runner_snapshots", AsyncMock(return_value=[])) as ingest:
            await execution_sessions.ingest_live_snapshot(session, task, "ref", {"ok": True, "runnerId": "cloud"})
            self.assertEqual(ingest.call_args.args[1].client_id, "")
            self.assertEqual(ingest.call_args.args[1].org_id, "org")
            node.owner_user_id = "other-user"
            session.get = AsyncMock(side_effect=[node, owner])
            ingest.reset_mock()
            await execution_sessions.ingest_live_snapshot(session, task, "ref", {"ok": True, "runnerId": "cloud"})
            ingest.assert_not_awaited()


class DirectContinuationTests(_Base):
    async def seed(self, session):
        task = await self._fixture(session, source_ref="original-ref")
        owner = await session.get(models.Client, "dev-1")
        owner.user_ref, owner.auth_state = "u-owner", "active"
        session.add(models.Client(id="pc", user_ref="u-owner", auth_state="active"))
        node = am.RunnerNode(id="original-pc", client_id="pc", auth_state="active")
        session.add(node)
        execution = am.ExecutionSession(id="execution", task_id=task.id,
            ref="original-ref", runner_id=node.id, runner_client_id="pc",
            engine="pi", model="selected-model", state="done")
        session.add(execution)
        await session.commit()
        runner = SimpleNamespace(id=node.id, client_id="pc", owner_user_id="", org_id="")
        return task, owner, node, execution, runner

    async def test_real_rework_rpc_has_original_model_and_owner_credentials(self):
        async with self.sessions() as session:
            task, owner, node, execution, runner = await self.seed(session)
            model = {"base": "https://fixture.invalid", "key": "owner-fixture-key", "model": "selected-model"}
            with patch.object(ai_exec, "load", AsyncMock(return_value={"name": "local", "cfg": {}})), \
                 patch.object(ai_exec, "_by_ref", side_effect=AssertionError("must not rediscover a pinned execution")), \
                 patch.object(runner_hub, "get", return_value=runner), \
                 patch.object(runner_hub, "call_sync", return_value={"ok": True, "data": {"ok": True}}) as rpc, \
                 patch.object(model_catalog, "resolve", AsyncMock(return_value=model)) as resolve:
                result = await task_rework.resume_after_rejection(session, task, "only revise test file",
                    artifact_version_id="t-life-v1", request_id="review-v1")
            self.assertTrue(result["started"])
            self.assertIs(resolve.call_args.args[1], owner)
            self.assertEqual(resolve.call_args.args[2], "selected-model")
            sent = rpc.call_args.args
            self.assertIs(sent[0], runner)
            self.assertEqual(sent[1], "job.comment")
            self.assertEqual(sent[2]["ref"], "original-ref")
            self.assertEqual(sent[2]["turnId"], "rework:review-v1")
            self.assertEqual({key: sent[2]["cfg"]["llm"][key] for key in model}, model)
            self.assertNotIn("_continuationRunnerId", sent[2]["cfg"])
            self.assertNotIn("_continuationRunnerIdentity", sent[2]["cfg"])
            self.assertEqual(execution.metadata_["round"], 2)

    async def test_offline_rework_retains_retry_and_never_resolves_or_sends_credentials(self):
        async with self.sessions() as session:
            task, *_ = await self.seed(session)
            with patch.object(runner_hub, "get", return_value=None), \
                 patch.object(ai_exec, "load", AsyncMock(return_value={"cfg": {}})), \
                 patch.object(ai_exec, "say_sync") as send, \
                 patch.object(model_catalog, "resolve", AsyncMock()) as resolve:
                result = await task_rework.resume_after_rejection(session, task, "revise",
                    artifact_version_id="t-life-v1", request_id="review-v1")
            self.assertFalse(result["started"])
            self.assertTrue(result["retryable"])
            self.assertEqual(task.work_routing["reworkPending"]["state"], "pending")
            send.assert_not_called()
            resolve.assert_not_awaited()

    async def test_invalid_owner_or_changed_runner_fails_before_credentials(self):
        for change in ("logged-out", "other-owner", "reassigned", "revoked", "other-personal", "other-task"):
            async with self.sessions() as session:
                task, owner, node, execution, runner = await self.seed(session)
                if change == "logged-out": owner.auth_state = "pending"
                if change == "other-owner": task.owner_user_id = "someone-else"
                if change == "reassigned": node.client_id = "someone-else"
                if change == "revoked": node.auth_state = "revoked"
                if change == "other-personal": node.owner_user_id = runner.owner_user_id = "someone-else"
                if change == "other-task": execution.task_id = "other-task"
                with patch.object(runner_hub, "get", return_value=runner), \
                     patch.object(model_catalog, "resolve", AsyncMock()) as resolve:
                    with self.assertRaises(task_continuation.ContinuationError, msg=change):
                        await task_continuation.prepare(session, task, {"cfg": {}}, "original-ref")
                    resolve.assert_not_awaited()
                await session.rollback()
                # Each branch uses its own database fixture.
            async with self.engine.begin() as connection:
                from app.db import Base
                await connection.run_sync(Base.metadata.drop_all)
                await connection.run_sync(Base.metadata.create_all)

    async def test_missing_selected_model_never_uses_current_default(self):
        async with self.sessions() as session:
            task, _, _, execution, runner = await self.seed(session)
            with patch.object(runner_hub, "get", return_value=runner), \
                 patch.object(model_catalog, "resolve", AsyncMock(return_value={})) as resolve:
                with self.assertRaisesRegex(task_continuation.ContinuationError, "selected-model"):
                    await task_continuation.prepare(session, task, {"cfg": {}}, "original-ref")
                self.assertEqual(resolve.call_args.args[2], "selected-model")
                execution.model = ""
                resolve.reset_mock()
                with self.assertRaisesRegex(task_continuation.ContinuationError, "记录不完整"):
                    await task_continuation.prepare(session, task, {"cfg": {}}, "original-ref")
                resolve.assert_not_awaited()

    async def test_frozen_dispatch_identity_survives_old_reader_device_projection(self):
        async with self.sessions() as session:
            task, owner, node, execution, runner = await self.seed(session)
            execution.metadata_ = {"executionIdentity": {
                "runnerId": node.id, "runnerClientId": "pc"}}
            execution.runner_client_id = owner.id
            model = {"base": "https://fixture.invalid", "key": "fixture", "model": "selected-model"}
            with patch.object(runner_hub, "get", return_value=runner), \
                 patch.object(model_catalog, "resolve", AsyncMock(return_value=model)):
                result = await task_continuation.prepare(session, task,
                    {"name": "local", "cfg": {}}, "original-ref")
                self.assertEqual(result["cfg"]["_continuationRunnerIdentity"]["client_id"], "pc")
                self.assertEqual(execution.runner_client_id, owner.id)
                execution.metadata_ = {"executionIdentity": {
                    "runnerId": "other-runner", "runnerClientId": "pc"}}
                with self.assertRaises(task_continuation.ContinuationError):
                    await task_continuation.prepare(session, task, {}, "original-ref")

    def test_pinned_runner_disappears_without_global_discovery_or_rpc(self):
        with patch.object(runner_hub, "get", return_value=None), \
             patch.object(ai_remote, "_runner_of_ref") as discovery, \
             patch.object(runner_hub, "call_sync") as rpc:
            result = ai_remote.comment_sync({"_continuationRunnerId": "original-pc",
                "llm": {"key": "fixture"}}, "original-ref", "revise")
        self.assertEqual(result["code"], "RUNNER_OFFLINE")
        discovery.assert_not_called()
        rpc.assert_not_called()

    async def test_cloud_reader_projection_uses_frozen_dispatch_without_changing_history(self):
        async with self.sessions() as session:
            task, owner, node, execution, runner = await self.seed(session)
            node.client_id = runner.client_id = ""
            node.owner_user_id = runner.owner_user_id = owner.user_ref
            execution.runner_client_id = owner.id
            execution.metadata_ = {"executionIdentity": {
                "runnerId": node.id, "runnerClientId": owner.id},
                "executionContext": {"agent": {"id": "runner:" + node.id + ":pi"},
                    "runner": {"mode": "remote", "id": node.id, "runnerId": node.id}}}
            model = {"base": "https://fixture.invalid", "key": "fixture", "model": "selected-model"}
            with patch.object(runner_hub, "get", return_value=runner), \
                 patch.object(model_catalog, "resolve", AsyncMock(return_value=model)) as resolve:
                result = await task_continuation.prepare(session, task, {"cfg": {}}, "original-ref")
                self.assertEqual(result["cfg"]["_continuationRunnerIdentity"]["client_id"], "")
                self.assertEqual(execution.metadata_["executionIdentity"]["runnerClientId"], owner.id)
                resolve.reset_mock()
                node.client_id = runner.client_id = "another-pc"
                with self.assertRaises(task_continuation.ContinuationError):
                    await task_continuation.prepare(session, task, {}, "original-ref")
                resolve.assert_not_awaited()

    def test_empty_cloud_client_is_frozen_instead_of_backfilled_by_reader(self):
        from app.services import execution_identity
        identity = execution_identity.from_dispatch({"runnerId": "cloud", "runnerClientId": ""})
        result = execution_identity.from_snapshot(identity, {},
            SimpleNamespace(id="cloud", client_id="reader-device"))
        self.assertEqual(result["runnerClientId"], "")

    def test_reconnected_foreign_identity_never_receives_credentials(self):
        runner = SimpleNamespace(id="original-pc", client_id="foreign-pc")
        with patch.object(runner_hub, "get", return_value=runner), \
             patch.object(runner_hub, "call_sync") as rpc:
            result = ai_remote.comment_sync({"_continuationRunnerId": "original-pc",
                "_continuationRunnerIdentity": {"client_id": "pc"},
                "llm": {"key": "fixture"}}, "original-ref", "revise")
        self.assertEqual(result["code"], "RUNNER_IDENTITY_CHANGED")
        rpc.assert_not_called()
