"""Owner-only API actions stay stricter than participant task visibility."""
import os

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""

import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import conversation_handoff_models, models
from app.api import delivery, evolution, tasks, trace
from app.db import Base
from app.services import ai_exec, task_access, task_events


class TaskOwnerAccessTests(unittest.IsolatedAsyncioTestCase):
    async def test_pc_local_requirement_can_continue_from_same_account_phone(self):
        runner = {"mode": "local", "runnerId": "own-pc", "clientId": "pc"}
        task = models.Task(id="requirement", kind="ticket", origin="local", owner_client_id="pc",
                           owner_user_id="alice", created_by="alice", work_routing={"executionContext": {
                               "runner": runner, "agent": {"id": "runner:own-pc:pi"}}})
        phone = models.Client(id="phone", user_ref="alice")
        self.assertTrue(task_access.can_continue_execution(task, phone))
        self.assertFalse(task_access.is_owner(task, phone))
        self.assertFalse(task_access.can_continue_execution(task, models.Client(id="other", user_ref="bob")))
        self.assertFalse(task_access.can_continue_execution(task, models.Client(id="guest")))
        for change in ({"runnerId": ""}, {"runnerId": "other-pc"}, {"clientId": "another-device"}):
            task.work_routing = {"executionContext": {"runner": {**runner, **change},
                "agent": {"id": "runner:own-pc:pi"}}}
            self.assertFalse(task_access.can_continue_execution(task, phone), change)

    async def test_requirement_execution_is_same_account_only_and_remains_pinned(self):
        task = models.Task(id="requirement", kind="requirement", origin="local", owner_client_id="phone",
                           owner_user_id="alice", created_by="alice", work_routing={"executionContext": {
                               "runner": {"mode": "remote", "runnerId": "own-pc", "clientId": "pc"}}})
        own_pc = models.Client(id="pc", user_ref="alice")
        foreign = models.Client(id="other", user_ref="bob")
        self.assertTrue(task_access.can_continue_execution(task, own_pc))
        self.assertFalse(task_access.is_owner(task, own_pc), "execution does not grant owner-only mutations")
        self.assertFalse(task_access.can_continue_execution(task, foreign))
        task.work_routing = {}
        self.assertFalse(task_access.can_continue_execution(task, own_pc), "never choose a fallback runner")
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        self.owner = models.Client(id="owner")
        self.participant = models.Client(id="participant", user_ref="requester")
        self.foreign = models.Client(id="foreign")
        self.task = models.Task(id="task", owner_client_id="owner",
                                requester_user_id="requester")
        self.session.add_all([self.owner, self.participant, self.foreign, self.task])
        await self.session.commit()

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()

    async def assert_hidden(self, action):
        with self.assertRaises(HTTPException) as denied:
            await action
        self.assertEqual(denied.exception.status_code, 404)
        self.assertEqual(denied.exception.detail, "需求不存在")

    def owner_actions(self, tid, client):
        yield tasks.ai_stop_task(tid, client, self.session)
        yield delivery.get_delivery(tid, client, self.session)
        yield evolution.save_my_evaluation(tid, {}, client, self.session)
        yield trace.my_task_handoff(tid, {}, client, self.session)

    async def test_compatibility_lookups_return_owner_row(self):
        for api in (tasks, delivery, evolution, trace):
            with self.subTest(api=api.__name__):
                self.assertIs(await api._my_task(self.session, self.owner, "task"), self.task)

    async def test_foreign_and_missing_actions_are_hidden_before_services(self):
        with patch.object(ai_exec, "load", new_callable=AsyncMock) as load, \
             patch.object(delivery.cd, "read_state", new_callable=AsyncMock) as read, \
             patch.object(evolution.task_evolution, "evaluate", new_callable=AsyncMock) as evaluate, \
             patch.object(trace.handoff, "to_human", new_callable=AsyncMock) as handoff:
            for tid, client in (("task", self.foreign), ("missing", self.owner)):
                for action in self.owner_actions(tid, client):
                    await self.assert_hidden(action)
            for service in (load, read, evaluate, handoff):
                service.assert_not_awaited()

    async def test_participant_visibility_does_not_grant_owner_actions(self):
        self.assertIs(await task_access.view_task(
            self.session, self.participant, "task"), self.task)
        for api in (tasks, delivery, evolution, trace):
            with self.subTest(api=api.__name__):
                await self.assert_hidden(api._my_task(self.session, self.participant, "task"))
        for action in self.owner_actions("task", self.participant):
            await self.assert_hidden(action)

    async def test_owner_actions_still_reach_their_domain_services(self):
        with patch.object(tasks, "_dispatch_ref", new=AsyncMock(return_value="execution")), \
             patch.object(ai_exec, "load", new=AsyncMock(return_value={})), \
             patch.object(ai_exec, "stop_sync", return_value={"ok": True}) as stop, \
             patch.object(task_events, "record"), \
             patch.object(delivery.cd, "read_state", new=AsyncMock(return_value={})), \
             patch.object(delivery.cd, "repo_for", new=AsyncMock(return_value=None)), \
             patch.object(delivery.release_control, "view", new=AsyncMock(return_value={})), \
             patch.object(evolution.task_evolution, "evaluate", new=AsyncMock(return_value={"ok": True})) as evaluate, \
             patch.object(trace.handoff, "to_human", new=AsyncMock(return_value={"ok": True})) as handoff:
            results = [await action for action in self.owner_actions("task", self.owner)]
        self.assertEqual(results, [{"ok": True}, {"applies": False, "delivered": False,
                                               "release": {}}, {"ok": True}, {"ok": True}])
        stop.assert_called_once_with({}, "execution")
        self.assertIs(evaluate.await_args.args[1], self.task)
        self.assertIs(handoff.await_args.args[1], self.task)


if __name__ == "__main__":
    unittest.main()
