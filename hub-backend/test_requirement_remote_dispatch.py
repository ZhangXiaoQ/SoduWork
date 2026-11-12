"""Exercise requirement HTTP dispatch with real target authorization and routing.

Only model configuration and the final Runner transport are isolated fixtures.
No live database, model, Runner process, or user workspace is accessed.
"""
import importlib
import os
import sqlite3
import uuid
from contextlib import closing
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

os.environ.update(DATABASE_URL="sqlite+aiosqlite:///:memory:",
                  AUTH_SECRET="requirement-routing-isolated-test-secret",
                  ADMIN_PASS="requirement-routing-fixture-password")

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app import models, automation_models as am
from app.api import tasks
from app.db import get_session
from app.deps import current_client
from app.services import (ai_exec, ai_remote, conversation_handoffs, dispatch_identity,
                          runner_hub, task_dispatch, task_execution_options)
from test_unified_requirements import _schema_template

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


class RequirementRemoteDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # Clone the complete schema into a private database for each test.
        # Avoid rebuilding every table through the async driver on every case.
        memory_name = "soduwork_remote_dispatch_" + uuid.uuid4().hex
        anchor = sqlite3.connect(f"file:{memory_name}?mode=memory&cache=shared", uri=True)
        self.addCleanup(anchor.close)
        with closing(sqlite3.connect(_schema_template())) as source:
            source.backup(anchor)
        self.engine = create_async_engine(
            f"sqlite+aiosqlite:///file:{memory_name}?mode=memory&cache=shared&uri=true")
        self.addAsyncCleanup(self.engine.dispose)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.client = models.Client(id="phone", user_ref="owner", auth_state="active")
        async with self.sessions() as session:
            session.add_all([
                models.OrgUnit(id="team", name="Team"),
                models.User(id="owner", username="owner", org_id="team", is_active=True),
                models.User(id="other", username="other", org_id="team", is_active=True),
                self.client,
                models.Client(id="desktop", user_ref="owner", auth_state="active"),
                models.Client(id="other-device", user_ref="other", auth_state="active"),
                models.Task(id="r3", title="Isolated R3", owner_client_id="phone",
                            owner_user_id="owner", status="todo",
                            work_routing={"requiredAgentCapabilities": ["files", "terminal"]}),
                am.RunnerNode(id="cloud", owner_user_id="owner", org_id="team"),
            ])
            await session.commit()
        self.runner = runner_hub._Runner(None, {
            "runnerId": "cloud", "host": "Cloud fixture", "version": "999.0.0",
            "workRoot": "/isolated/runner", "agents": [{"key": "pi", "name": "Pi"}],
            "skills": [], "caps": ["handoff1"],
            "capabilities": {"schemaVersion": 3, "available": ["files", "terminal"]},
        })
        self.runner.owner_user_id = "owner"
        self.runner.org_id = "team"
        self.runner.ready = True
        self.runner.dispatch_mode = "accepting"
        self.runner.alive = lambda: True
        self.calls = []

        def dispatch(cfg, task, files, picked, extra):
            self.calls.append((cfg, picked, extra))
            return {"ok": True, "issueId": dispatch_identity.execution_ref(extra["dispatchId"]),
                    "runnerId": picked["runnerId"], "runnerClientId": picked["clientId"],
                    "host": picked["host"], "assigneeId": picked["id"],
                    "assigneeCli": "pi", "state": "running"}

        async def model(session, client, ctx, *args, **kwargs):
            return ai_exec.with_llm(ctx, {"base": "http://fixture.invalid", "key": "fixture",
                                          "model": "fixture"}), {}

        self.patches = [
            patch.dict(runner_hub._RUNNERS, {"cloud": self.runner}, clear=True),
            patch("app.services.execution_host_policy.get_settings",
                  return_value=type("Settings", (), {"cloud_execution_runner_ids": "",
                                                       "hub_local_execution_enabled": False})()),
            patch("app.realtime.hub.publish", new_callable=AsyncMock),
            patch.object(ai_exec, "load", new=AsyncMock(return_value={
                "provider": "local", "cfg": {"git": {"token": "fixture-git"}},
            })),
            patch("app.services.task_execution_model.prepare", new=model),
            patch.object(ai_exec, "with_project_context",
                         new=AsyncMock(side_effect=lambda session, extra, *args: extra)),
            patch.object(ai_remote, "dispatch_sync", side_effect=dispatch),
            patch.object(task_dispatch, "_attach_skills", new=AsyncMock()),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        app = FastAPI()
        app.include_router(tasks.router)

        async def db():
            async with self.sessions() as session:
                yield session

        app.dependency_overrides[get_session] = db
        app.dependency_overrides[current_client] = lambda: self.client
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture")
        self.addAsyncCleanup(self.http.aclose)

    def body(self, **runner_fields):
        return {"assigneeId": "local:pi", "assigneeType": "agent",
                "executionContext": {"strategy": "direct", "agent": {"id": "local:pi"},
                    "location": {"mode": "remote"},
                    "runner": {"mode": "remote", "runnerId": "cloud", **runner_fields}}}

    async def post(self, body=None):
        return await self.http.post("/api/v1/tasks/r3/ai-dispatch", json=self.body() if body is None else body)

    async def test_catalog_cloud_selection_dispatches_exact_runner_once(self):
        async with self.sessions() as session:
            targets = await conversation_handoffs.targets(session, self.client)
        catalog = task_execution_options.substrate_options(
            [{**target, "cli": target["agentId"], "online": True, "remote": True} for target in targets],
            ["files", "terminal"], self.client.id)
        self.assertEqual(len(catalog), 1)
        location = catalog[0]["locations"][0]
        self.assertEqual(location["runnerKind"], "cloud")
        body = self.body(runnerId=location["runnerId"])
        body["assigneeId"] = catalog[0]["key"]
        response = await self.post(body)
        self.assertEqual(response.status_code, 200, response.text)
        again = await self.post(body)
        self.assertEqual(again.status_code, 200, again.text)
        self.assertEqual(again.json()["issueId"], response.json()["issueId"])
        self.assertEqual(len(self.calls), 1)
        cfg, picked, extra = self.calls[0]
        self.assertEqual(picked["id"], "runner:cloud:pi")
        self.assertEqual(cfg["allowedRunners"], ["cloud"])
        self.assertNotIn("git", cfg)
        async with self.sessions() as session:
            executions = list((await session.scalars(select(am.ExecutionSession))).all())
            self.assertEqual([row.runner_id for row in executions], ["cloud"])
            self.assertEqual((await session.get(models.Task, "r3")).status, "doing")

    async def test_default_device_scope_is_unchanged_without_remote_choice(self):
        response = await self.post({"assigneeId": "local:pi", "assigneeType": "agent"})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertFalse(self.calls)

    async def test_offline_selected_target_never_falls_back_to_another_runner(self):
        async with self.sessions() as session:
            session.add(am.RunnerNode(id="alternative", client_id="desktop", org_id="team"))
            await session.commit()
        self.runner.id = "alternative"
        self.runner.owner_user_id = ""
        self.runner.client_id = "desktop"
        self.runner.tags = [runner_hub.CLIENT_TAG]
        with patch.dict(runner_hub._RUNNERS, {"alternative": self.runner}, clear=True):
            async with self.sessions() as session:
                targets = await conversation_handoffs.targets(session, self.client)
                self.assertEqual([row["id"] for row in targets], ["runner:alternative:pi"])
            response = await self.post()
        self.assertEqual(response.status_code, 409, response.text)
        self.assertFalse(self.calls)

    async def test_ownership_change_after_catalog_read_is_rejected(self):
        async with self.sessions() as session:
            self.assertTrue(await conversation_handoffs.targets(session, self.client))
            row = await session.get(am.RunnerNode, "cloud")
            row.owner_user_id = "other"
            await session.commit()
        response = await self.post()
        self.assertEqual(response.status_code, 409, response.text)
        self.assertFalse(self.calls)

    async def test_peer_desktop_owned_by_same_account_is_authorized(self):
        async with self.sessions() as session:
            row = await session.get(am.RunnerNode, "cloud")
            row.owner_user_id = None
            row.client_id = "desktop"
            await session.commit()
        self.runner.owner_user_id = ""
        self.runner.client_id = "desktop"
        self.runner.tags = [runner_hub.CLIENT_TAG]
        response = await self.post(self.body(clientId="desktop"))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.calls[0][1]["clientId"], "desktop")

    async def test_conflicting_location_and_agent_are_rejected(self):
        bodies = [self.body(), self.body(), self.body(clientId="other-device")]
        bodies[0]["executionContext"]["location"]["mode"] = "local"
        bodies[1]["assigneeId"] = "runner:other:pi"
        for body in bodies:
            with self.subTest(body=body):
                response = await self.post(body)
                self.assertEqual(response.status_code, 409, response.text)
        self.assertFalse(self.calls)

    async def test_missing_task_capability_is_rejected(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "r3")
            task.work_routing = {"requiredAgentCapabilities": ["files", "terminal", "browser"]}
            await session.commit()
        response = await self.post()
        self.assertEqual(response.status_code, 409, response.text)
        self.assertFalse(self.calls)


if __name__ == "__main__":
    unittest.main()
