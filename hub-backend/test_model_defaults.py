"""Real HTTP/SQLite picker defaults agree with execution; no provider requests."""
import json
import os
import unittest
from types import SimpleNamespace

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

import httpx
from fastapi import FastAPI
from app.api import ai_proxy, tasks, task_options
from app.db import get_session
from app.models import Client, ModelDef, ModelProvider, User
from app.services import device_auth, model_catalog
from app.services.model_defaults import public_defaults
from test_model_runtime import IsolatedDatabase


# All shipped managed runtimes, including Kimi, must satisfy the same gateway contract.
AGENTS = {"pi", "opencode", "qwen", "codex-harness", "dsh", "harness2", "kimi"}


class MetadataTests(unittest.TestCase):
    def test_projection_only_exposes_names_and_known_managed_agents(self):
        rows = [{"name": "first", "key": "do-not-project", "baseUrl": "private"},
                {"name": "second"}]
        client = SimpleNamespace(agent_models={"pi": " second ", "codex": "second",
                                              "claude": "first", "unknown": "first"})
        result = public_defaults(rows, client)
        self.assertEqual(result["defaultModel"], "first")
        self.assertEqual(result["defaultModels"]["pi"], "second")
        self.assertEqual(set(result["defaultModels"]), AGENTS)
        self.assertEqual(result["defaultModelErrors"], {})
        self.assertNotIn("private", json.dumps(result))
        self.assertNotIn("do-not-project", json.dumps(result))
        self.assertEqual(client.agent_models["pi"], " second ")
        self.assertEqual(rows[0]["key"], "do-not-project")

    def test_alias_preferences_use_the_execution_canonical_name(self):
        old, current = next(iter(model_catalog.MEDIA_MODEL_ALIASES.items()))
        result = public_defaults([{"name": current}],
                                 SimpleNamespace(agent_models={"qwen": old}))
        self.assertEqual(result["defaultModels"]["qwen"], current)
        self.assertEqual(result["defaultModelErrors"], {})


class ModelDefaultsTests(IsolatedDatabase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        async with self.engine.begin() as connection:
            await connection.run_sync(User.__table__.create)
        async with self.sessions() as session, session.begin():
            session.add_all([
                User(id="fixture-user", username="fixture-user"),
                Client(id="fixture", user_ref="fixture-user", auth_state="active",
                       agent_models={"pi": "second", "qwen": "third", "harness2": "third"}),
                ModelProvider(id="fixture", name="Fixture", api_key="fixture-company-private",
                              base_url="http://fixture.invalid/v1"),
                *[ModelDef(id="fixture:" + name, provider_id="fixture", name=name)
                  for name in ["first", "second", "third"]],
                ModelDef(id="fixture:image", provider_id="fixture", name="picture-only",
                         modality="image"),
            ])
        app = FastAPI()
        app.include_router(tasks.router)
        app.include_router(task_options.router)
        app.include_router(ai_proxy.router)

        async def isolated_session():
            async with self.sessions() as session:
                yield session

        app.dependency_overrides[get_session] = isolated_session
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://fixture")
        async with self.sessions() as session:
            token, _ = device_auth.issue_session(await session.get(Client, "fixture"))
        self.headers = {"Authorization": "Device " + token}

    async def asyncTearDown(self):
        await self.http.aclose()
        await super().asyncTearDown()

    async def get(self, path, **params):
        response = await self.http.get("/api/v1/" + path, params=params, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_assignment_defaults_match_real_dispatch_without_changing_preferences(self):
        from unittest.mock import AsyncMock, patch
        from app.db import Base
        from app.services import ai_exec, task_execution_model
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        # Only Runner discovery/config loading is isolated. Authentication,
        # the HTTP route, catalog queries and final model resolution stay real.
        with patch.object(ai_exec, 'load', new=AsyncMock(return_value={})), \
                patch.object(ai_exec, 'list_assignees_sync', return_value={'agents': []}):
            response = await self.http.post('/api/v1/task-execution-options', json={}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        options = response.json()
        self.assertEqual(options['defaultModels']['pi'], 'second')
        self.assertIn('first', [row['name'] for row in options['modelOptions']])
        self.assertNotIn('fixture-company-private', response.text)
        async with self.sessions() as session:
            client = await session.get(Client, 'fixture')
            context, _ = await task_execution_model.prepare(session, client, {'cfg':{},'localCfg':{}}, {'id':'local:pi'})
            self.assertEqual(options['defaultModels']['pi'], context['cfg']['llm']['model'])
            context, _ = await task_execution_model.prepare(session, client, {'cfg':{},'localCfg':{}}, {'id':'local:pi'}, 'first')
            self.assertEqual(context['cfg']['llm']['model'], 'first')
            self.assertEqual(client.agent_models['pi'], 'second')

    async def test_default_names_match_all_gateway_config_resolutions(self):
        metadata = await self.get("my-models")
        self.assertEqual(metadata["defaultModel"], metadata["usable"][0]["name"])
        self.assertEqual(metadata["defaultModels"]["pi"], "second")
        self.assertEqual(metadata["defaultModels"]["qwen"], "third")
        self.assertEqual(metadata["defaultModels"]["harness2"], "third")
        self.assertEqual(metadata["defaultModelErrors"], {})
        self.assertEqual(set(metadata["defaultModels"]), AGENTS)
        self.assertNotIn("fixture-company-private", json.dumps(metadata))
        self.assertNotIn("picture-only", metadata["defaultModels"].values())
        for agent in AGENTS:
            execution = await self.get("ai-proxy/config", agent=agent)
            self.assertTrue(execution["ok"], execution)
            self.assertEqual(metadata["defaultModels"][agent], execution["model"])

    async def test_removed_agent_preference_remains_blocked_until_explicit_selection(self):
        async with self.sessions() as session, session.begin():
            client = await session.get(Client, "fixture")
            client.agent_models = {"qwen": "removed-model"}
        metadata = await self.get("my-models")
        self.assertEqual(metadata["defaultModels"]["qwen"], "")
        self.assertIn("qwen", metadata["defaultModelErrors"])
        self.assertEqual(metadata["defaultModels"]["pi"], metadata["defaultModel"])
        self.assertFalse((await self.get("ai-proxy/config", agent="qwen"))["ok"])
        chosen = await self.get("ai-proxy/config", agent="qwen", model="second")
        self.assertTrue(chosen["ok"])
        self.assertEqual(chosen["model"], "second")
        async with self.sessions() as session:
            self.assertEqual((await session.get(Client, "fixture")).agent_models,
                             {"qwen": "removed-model"})

    async def test_kimi_preference_and_disabled_model_match_execution_without_fallback(self):
        async with self.sessions() as session, session.begin():
            (await session.get(Client, "fixture")).agent_models = {"kimi": "third"}
        metadata = await self.get("my-models")
        self.assertEqual(metadata["defaultModels"]["kimi"], "third")
        execution = await self.get("ai-proxy/config", agent="kimi")
        self.assertTrue(execution["ok"], execution)
        self.assertEqual(execution["model"], "third")

        async with self.sessions() as session, session.begin():
            (await session.get(ModelDef, "fixture:third")).enabled = False
        metadata = await self.get("my-models")
        self.assertEqual(metadata["defaultModels"]["kimi"], "")
        self.assertIn("kimi", metadata["defaultModelErrors"])
        self.assertNotIn("third", [row["name"] for row in metadata["usable"]])
        self.assertFalse((await self.get("ai-proxy/config", agent="kimi"))["ok"])
        explicit = await self.get("ai-proxy/config", agent="kimi", model="second")
        self.assertTrue(explicit["ok"], explicit)
        self.assertEqual(explicit["model"], "second")
        async with self.sessions() as session:
            self.assertEqual((await session.get(Client, "fixture")).agent_models,
                             {"kimi": "third"})

    async def test_ignore_preference_uses_catalog_default_without_mutating_agent_models(self):
        normal = await self.get("ai-proxy/config", agent="pi")
        ignored = await self.get("ai-proxy/config", agent="pi", ignore_preference=1)
        explicit = await self.get("ai-proxy/config", agent="pi", model="second",
                                  ignore_preference=1)
        self.assertEqual(normal["model"], "second")
        self.assertEqual(ignored["model"], "first")
        self.assertEqual(explicit["model"], "second")
        async with self.sessions() as session:
            self.assertEqual((await session.get(Client, "fixture")).agent_models["pi"], "second")

    async def test_disabled_model_is_not_advertised_as_the_agent_default(self):
        async with self.sessions() as session, session.begin():
            (await session.get(ModelDef, "fixture:second")).enabled = False
        metadata = await self.get("my-models")
        self.assertEqual(metadata["defaultModels"]["pi"], "")
        self.assertIn("pi", metadata["defaultModelErrors"])
        self.assertNotIn("second", [row["name"] for row in metadata["usable"]])
        self.assertFalse((await self.get("ai-proxy/config", agent="pi"))["ok"])

    async def test_empty_catalog_reports_no_default_without_native_account_entries(self):
        async with self.sessions() as session, session.begin():
            (await session.get(ModelProvider, "fixture")).enabled = False
        metadata = await self.get("my-models")
        self.assertEqual(metadata["defaultModel"], "")
        self.assertEqual(metadata["defaultModels"], dict.fromkeys(AGENTS, ""))
        self.assertEqual(set(metadata["defaultModelErrors"]), AGENTS)
        self.assertEqual(metadata["usable"], [])
        self.assertFalse((await self.get("ai-proxy/config", agent="opencode"))["ok"])

    async def test_personal_chat_model_can_be_default_but_image_model_cannot(self):
        async with self.sessions() as session, session.begin():
            for name in ["first", "second", "third"]:
                (await session.get(ModelDef, "fixture:" + name)).enabled = False
            client = await session.get(Client, "fixture")
            client.agent_models = {}
            client.models = [{"providerId": "fixture", "name": "personal-chat"}]
            client.model_keys = {"fixture": "fixture-personal-private"}
        metadata = await self.get("my-models")
        self.assertEqual(metadata["defaultModel"], "personal-chat")
        self.assertEqual(set(metadata["defaultModels"].values()), {"personal-chat"})
        self.assertNotIn("fixture-personal-private", json.dumps(metadata))
        self.assertEqual((await self.get("ai-proxy/config", agent="pi"))["model"],
                         "personal-chat")


if __name__ == "__main__":
    unittest.main()
