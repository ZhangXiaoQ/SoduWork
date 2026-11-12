"""Model definitions preserve strict edits and tolerant historic-row reads."""
import copy
import os
import unittest
from sqlalchemy import select

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from test_model_runtime import IsolatedDatabase
from app import models
from app.services import model_catalog, model_definition_contracts as contracts


class ModelDefinitionContractsTests(unittest.TestCase):
    def test_chat_thinking_and_capability_contract_does_not_mutate_input(self):
        raw = {"thinkingMode": "always", "thinkingFormat": "openai",
               "thinkingLevelMap": {"off": "provider-off", "high": "provider-high"},
               "supportsReasoningEffort": True, "imageRouting": "native",
               "capabilities": {"imageInput": "supported"}, "maxOutputTokens": 2048}
        before = copy.deepcopy(raw)
        expected = {**raw, "reasoning": True,
                    "thinkingLevelMap": {"off": None, "high": "provider-high"}}
        self.assertEqual(contracts.clean_model_config(raw), expected)
        self.assertEqual(model_catalog.clean_model_config(raw), expected)
        self.assertEqual(raw, before)

    def test_media_paths_and_defaults_keep_only_the_declared_generation_fields(self):
        raw = {"statusPath": "/jobs/{id}", "resultPath": "/jobs/{id}/output",
               "defaults": {"duration": 5, "model": "cannot override", "stream": True}}
        expected = {"endpointPath": "/videos/generations", "statusPath": "/jobs/{id}",
                    "resultPath": "/jobs/{id}/output", "defaults": {"duration": 5}}
        self.assertEqual(contracts.clean_model_config(raw, "video"), expected)
        self.assertEqual(model_catalog.model_config(raw, "video"), expected)
        self.assertEqual(contracts.clean_model_config({}, "image"),
                         {"endpointPath": "/images/generations", "defaults": {}})

    def test_invalid_edits_raise_but_legacy_reads_fall_back_per_modality(self):
        cases = [("chat", {"thinkingMode": "unsupported"}),
                 ("chat", {"imageRouting": "native", "capabilities": {"imageInput": "unsupported"}}),
                 ("video", {"statusPath": "/jobs/no-id"}),
                 ("image", {"endpointPath": "https://another.invalid/generate"}),
                 ("video", {"defaults": {"large": "x" * 13000}})]
        for modality, raw in cases:
            with self.subTest(modality=modality, raw=raw):
                with self.assertRaises(ValueError):
                    contracts.clean_model_config(raw, modality)
                self.assertEqual(contracts.model_config(raw, modality),
                                 contracts.clean_model_config({}, modality))
        self.assertEqual(contracts.normalize_image_routing("native-first"), "vision-fallback")


class CatalogInitializationTests(IsolatedDatabase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        async with self.engine.begin() as connection:
            await connection.run_sync(models.Milestone.__table__.create)
            await connection.run_sync(models.User.__table__.create)

    async def test_new_catalog_has_only_credential_free_provider_templates(self):
        async with self.sessions() as session:
            await model_catalog.bootstrap(session)
            await model_catalog.bootstrap(session)
            self.assertEqual((await session.execute(select(models.ModelDef))).scalars().all(), [])
            self.assertEqual((await session.execute(select(models.AppSetting))).scalars().all(), [])
            providers = (await session.execute(select(models.ModelProvider))).scalars().all()
            self.assertEqual({row.id for row in providers},
                             {row["id"] for row in model_catalog.BUILTIN_PROVIDERS})
            self.assertTrue(all(not row.api_key for row in providers))
            self.assertEqual((await session.get(models.ModelProvider, "company")).base_url, "")

    async def test_admin_models_preserve_the_thinking_proxy_contract(self):
        from app.api.ai_proxy import proxy_config
        async with self.sessions() as session:
            await model_catalog.bootstrap(session)
            for name in ("glm-5.3", "glm-5.3-flash", "kimi-k3"):
                definition = copy.deepcopy(next(row for row in model_catalog.BUILTIN_MODELS
                                                if row["name"] == name))
                session.add(models.ModelDef(id=definition["provider_id"] + ":" + name,
                                           builtin=False, enabled=True, **definition))
            session.add(models.User(id="catalog-user", username="catalog-user"))
            client = models.Client(id="catalog-fixture", auth_state="active", user_ref="catalog-user")
            session.add(client)
            for provider in ("zhipu", "moonshot"):
                row = await session.get(models.ModelProvider, provider)
                row.api_key = "isolated-fixture-key"
            await session.commit()
            for name in ("glm-5.3", "kimi-k3"):
                response = await proxy_config(model=name, agent="pi", client=client, session=session)
                self.assertTrue(response["ok"], response)
                self.assertTrue(response["reasoning"])
                self.assertTrue(response["thinkingAlwaysOn"])
                self.assertTrue(response["supportsReasoningEffort"])
                self.assertEqual(response["thinkingFormat"], "openai" if name == "kimi-k3" else "zai")
                levels = response["thinkingLevelMap"]
                self.assertEqual({key for key, value in levels.items() if value is not None},
                                 {"low", "high", "max"})
                self.assertIsNone(levels["off"])
            # Administrator-selected controllable thinking must reach the client unchanged.
            response = await proxy_config(model="glm-5.3-flash", agent="pi", client=client, session=session)
            self.assertTrue(response["ok"], response)
            self.assertTrue(response["reasoning"])
            self.assertNotIn("thinkingAlwaysOn", response)
            self.assertEqual(response["thinkingMode"], "controllable")
            levels = response["thinkingLevelMap"]
            self.assertEqual({key for key, value in levels.items() if value is not None},
                             {"low", "high", "max"})

    async def test_bootstrap_preserves_existing_rows_and_administrator_overrides(self):
        async with self.sessions() as session:
            await model_catalog.bootstrap(session)
            row = models.ModelDef(id="zhipu:glm-5.3", provider_id="zhipu", name="glm-5.3",
                                  config={"thinkingMode": "none"}, enabled=False)
            session.add(row)
            provider = await session.get(models.ModelProvider, "zhipu")
            provider.base_url = "http://fixture.invalid/v1"
            provider.enabled = False
            for provider_id, name in (("moonshot", "kimi-k2-thinking"), ("openai", "gpt-6.1-sol")):
                session.add(models.ModelDef(id=provider_id + ":" + name,
                            provider_id=provider_id, name=name, enabled=True))
            await session.commit()
            await model_catalog.bootstrap(session)
            self.assertEqual(row.config, {"thinkingMode": "none"})
            self.assertFalse(row.enabled)
            self.assertFalse(provider.enabled)
            self.assertEqual(provider.base_url, "http://fixture.invalid/v1")
            for mid in ("moonshot:kimi-k2-thinking", "openai:gpt-6.1-sol"):
                self.assertTrue((await session.get(models.ModelDef, mid)).enabled)

    async def test_legacy_defaults_do_not_import_credentials_or_restore_deleted_models(self):
        legacy = {"llm_base_url": "https://legacy-fixture.invalid/v1",
                  "llm_api_key": "isolated-legacy-credential", "llm_model": "removed-fixture-model"}
        target = "company:" + legacy["llm_model"]
        async with self.sessions() as session:
            session.add_all([models.AppSetting(key=key, value=value) for key, value in legacy.items()])
            await session.commit()
            await model_catalog.bootstrap(session)
            self.assertIsNone(await session.get(models.ModelDef, target))
            provider = await session.get(models.ModelProvider, "company")
            self.assertEqual(provider.base_url, "")
            self.assertEqual(provider.api_key, "")
            session.add(models.ModelDef(id=target, provider_id="company", name=legacy["llm_model"],
                                        builtin=False, enabled=True))
            await session.commit()
            await session.delete(await session.get(models.ModelDef, target))
            provider.enabled = False
            await session.commit()
        for _ in range(2):
            async with self.sessions() as session:
                await model_catalog.bootstrap(session)
                self.assertIsNone(await session.get(models.ModelDef, target))
                provider = await session.get(models.ModelProvider, "company")
                self.assertFalse(provider.enabled)
                self.assertEqual(provider.base_url, "")
                self.assertEqual(provider.api_key, "")
                actual = {row.key: row.value for row in
                          (await session.execute(select(models.AppSetting))).scalars().all()}
                self.assertEqual(actual, legacy, "Report settings remain; no startup markers are written")

    async def test_startup_does_not_rename_repair_or_enable_existing_catalog_without_markers(self):
        old_name = next(iter(model_catalog.MODEL_ALIASES))
        async with self.sessions() as session:
            session.add(models.ModelProvider(id="company", name="Admin company", builtin=True,
                                             enabled=False, base_url="", api_key="isolated-kept-key"))
            session.add_all([
                models.ModelDef(id="company:" + old_name, provider_id="company", name=old_name,
                                builtin=False, enabled=False, label="Admin model", note="Keep this row"),
                models.ModelDef(id="volcengine:doubao-seedance-2-0", provider_id="volcengine",
                                name="doubao-seedance-2-0", builtin=True, enabled=False, modality="video",
                                config={"endpointPath": "/videos/generations", "defaults": {}}),
                models.ModelDef(id="zhipu:glm-5.3-flash", provider_id="zhipu", name="glm-5.3-flash",
                                builtin=True, enabled=False, config=model_catalog.clean_model_config(
                                    model_catalog._always_thinking_config("zai"), "chat")),
                models.AppSetting(key="llm_base_url", value="https://legacy-fixture.invalid/v1"),
                models.AppSetting(key="llm_api_key", value="isolated-replaced-key"),
                models.AppSetting(key="llm_model", value=old_name),
            ])
            await session.commit()

        async def snapshot(session, entity):
            return {row.id if hasattr(row, "id") else row.key:
                    {column.name: copy.deepcopy(getattr(row, column.name))
                     for column in entity.__table__.columns}
                    for row in (await session.execute(select(entity))).scalars().all()}

        async with self.sessions() as session:
            before = {entity: await snapshot(session, entity)
                      for entity in (models.ModelDef, models.ModelProvider, models.AppSetting)}
        for _ in range(2):
            async with self.sessions() as session:
                await model_catalog.bootstrap(session)
            async with self.sessions() as session:
                self.assertEqual(await snapshot(session, models.ModelDef), before[models.ModelDef])
                self.assertEqual(await snapshot(session, models.AppSetting), before[models.AppSetting])
                providers = await snapshot(session, models.ModelProvider)
                self.assertEqual(providers["company"], before[models.ModelProvider]["company"])


if __name__ == "__main__":
    unittest.main()
