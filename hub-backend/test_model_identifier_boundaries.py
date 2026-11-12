"""Admin model catalog identifiers must match the columns that store them.

Provider rows key on id[:48] silently: an overlong identifier is stored truncated, so
the create succeeds while later reads and replays keyed on the caller's identifier
miss the row (second PUT with "new" hits the primary key and 500s). These tests pin
strict validation at the HTTP boundary instead.
"""
import asyncio
import importlib
import os
from pathlib import Path
import secrets
import socket
import unittest

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
import uvicorn
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import admin
from app.auth import hash_password, sign_token
from app.db import Base, get_session

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


class ModelIdentifierBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add(models.User(id="admin", username="admin", display_name="Admin",
                                    is_super=True, is_active=True, auth_version=1,
                                    password_hash=hash_password(secrets.token_urlsafe(24))))
            await session.commit()
        self.app = FastAPI()
        self.app.include_router(admin.router)

        async def db():
            async with self.sessions() as session:
                yield session

        self.app.dependency_overrides[get_session] = db
        # Exercise the production admin routes over real loopback HTTP. The SQLite
        # schema and account are isolated; no application lifespan jobs are started.
        self.socket = socket.socket()
        self.socket.bind(("127.0.0.1", 0))
        self.port = self.socket.getsockname()[1]
        self.server = uvicorn.Server(uvicorn.Config(self.app, lifespan="off", log_level="critical"))
        self.server_task = asyncio.create_task(self.server.serve(sockets=[self.socket]))
        async with asyncio.timeout(10):
            while not self.server.started:
                if self.server_task.done():
                    await self.server_task
                    self.fail("isolated HTTP server stopped before startup")
                await asyncio.sleep(0.01)
        self.http = httpx.AsyncClient(base_url=f"http://127.0.0.1:{self.port}", trust_env=False)

    async def asyncTearDown(self):
        await self.http.aclose()
        self.server.should_exit = True
        try:
            await asyncio.wait_for(self.server_task, 5)
        finally:
            self.socket.close()
        await self.engine.dispose()
        with socket.socket() as probe:
            self.assertNotEqual(probe.connect_ex(("127.0.0.1", self.port)), 0)

    async def request(self, method, path, **kwargs):
        headers = {"Authorization": "Bearer " + sign_token("admin", 1)}
        return await self.http.request(method, "/api/v1/admin" + path, headers=headers, **kwargs)

    async def test_overlong_provider_identifier_is_rejected_not_truncated(self):
        long_id = "p" * 60
        created = await self.request("PUT", f"/model-providers/{long_id}", json={
            "expectedRevision": "new", "name": "Overlong", "kind": "openai-compat",
            "baseUrl": "https://example.com/v1", "apiKey": "k", "enabled": True})
        self.assertEqual(created.status_code, 400, created.text)

        catalog = await self.request("GET", "/model-catalog")
        stored = [p["id"] for p in catalog.json()["providers"]]
        self.assertNotIn("p" * 48, stored)
        self.assertNotIn(long_id, stored)

    async def test_replayed_create_of_short_identifier_conflicts_cleanly(self):
        body = {"expectedRevision": "new", "name": "Once", "kind": "openai-compat",
                "baseUrl": "https://example.com/v1", "apiKey": "k", "enabled": True}
        first = await self.request("PUT", "/model-providers/once", json=body)
        self.assertEqual(first.status_code, 200, first.text)
        replay = await self.request("PUT", "/model-providers/once", json=body)
        self.assertEqual(replay.status_code, 409, replay.text)

    async def test_model_composite_identifier_is_within_column_limit(self):
        provider = await self.request("PUT", "/model-providers/edge", json={
            "expectedRevision": "new", "name": "Edge", "kind": "openai-compat",
            "baseUrl": "https://example.com/v1", "apiKey": "k", "enabled": True})
        self.assertEqual(provider.status_code, 200, provider.text)
        overflow = await self.request("PUT", "/model-defs", json={
            "expectedRevision": "new", "providerId": "edge",
            "name": "m" * 60, "enabled": True})
        self.assertEqual(overflow.status_code, 400, overflow.text)

        catalog = await self.request("GET", "/model-catalog")
        self.assertNotIn("edge:" + "m" * 60, [m["id"] for m in catalog.json()["models"]])

    async def test_overlong_api_key_is_rejected_without_creating_a_provider(self):
        created = await self.request("PUT", "/model-providers/longkey", json={
            "expectedRevision": "new", "name": "LongKey", "kind": "openai-compat",
            "baseUrl": "https://example.com/v1", "apiKey": "k" * 420, "enabled": True})
        self.assertEqual(created.status_code, 400, created.text)
        async with self.sessions() as session:
            self.assertIsNone(await session.get(models.ModelProvider, "longkey"))

    async def test_rejected_key_update_preserves_the_entire_existing_provider(self):
        original_key = secrets.token_hex(200)
        created = await self.request("PUT", "/model-providers/exact", json={
            "expectedRevision": "new", "name": "Original", "apiKey": original_key,
            "baseUrl": "https://example.com/v1", "enabled": True})
        self.assertEqual(created.status_code, 200, created.text)
        catalog = (await self.request("GET", "/model-catalog")).json()
        row = next(p for p in catalog["providers"] if p["id"] == "exact")
        rejected = await self.request("PUT", "/model-providers/exact", json={
            "expectedRevision": row["revision"], "name": "Must not persist", "enabled": False,
            "apiKey": "k" * 401})
        self.assertEqual(rejected.status_code, 400, rejected.text)
        async with self.sessions() as session:
            stored = await session.get(models.ModelProvider, "exact")
            self.assertEqual((stored.name, stored.api_key, stored.enabled), ("Original", original_key, True))
        unchanged = await self.request("PUT", "/model-providers/exact", json={
            "expectedRevision": row["revision"], "apiKey": "", "name": "Renamed"})
        self.assertEqual(unchanged.status_code, 200, unchanged.text)
        async with self.sessions() as session:
            self.assertEqual((await session.get(models.ModelProvider, "exact")).api_key, original_key)
        self.assertNotIn(original_key, (await self.request("GET", "/model-catalog")).text)

    async def test_exact_identifier_limits_round_trip_and_replay_without_collisions(self):
        pid, name = "p" * 48, "m" * 15
        body = {"expectedRevision": "new", "name": "Boundary", "enabled": True}
        self.assertEqual((await self.request("PUT", f"/model-providers/{pid}", json=body)).status_code, 200)
        self.assertEqual((await self.request("PUT", f"/model-providers/{pid}x", json=body)).status_code, 400)
        definition = {"expectedRevision": "new", "providerId": pid, "name": name, "enabled": True}
        created = await self.request("PUT", "/model-defs", json=definition)
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["id"], pid + ":" + name)
        self.assertEqual((await self.request("PUT", "/model-defs", json=definition)).status_code, 409)
        definition["name"] += "x"
        self.assertEqual((await self.request("PUT", "/model-defs", json=definition)).status_code, 400)
        async with self.sessions() as session:
            self.assertIsNotNone(await session.get(models.ModelDef, pid + ":" + name))
            self.assertIsNone(await session.get(models.ModelDef, pid + ":" + name + "x"))

    async def test_legacy_sqlite_model_keeps_its_identity_and_remains_manageable(self):
        # Older SQLite installations accepted composite IDs beyond the SQL column
        # width. Preserve explicit revision-guarded maintenance, not a silent rename.
        mid = "legacy:" + "m" * 64
        async with self.sessions() as session:
            session.add(models.ModelProvider(id="legacy", name="Legacy", builtin=False))
            session.add(models.ModelDef(id=mid, provider_id="legacy", name="m" * 64, builtin=False))
            await session.commit()
        catalog = (await self.request("GET", "/model-catalog")).json()
        row = next(m for m in catalog["models"] if m["id"] == mid)
        body = {"providerId": "legacy", "name": "m" * 64, "enabled": False,
                "expectedRevision": row["revision"]}
        updated = await self.request("PUT", "/model-defs", json=body)
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["id"], mid)
        self.assertEqual((await self.request("PUT", "/model-defs", json=body)).status_code, 409)
        catalog = (await self.request("GET", "/model-catalog")).json()
        row = next(m for m in catalog["models"] if m["id"] == mid)
        self.assertFalse(row["enabled"])
        deleted = await self.request("DELETE", f"/model-defs/{mid}", params={"expectedRevision": row["revision"]})
        self.assertEqual(deleted.status_code, 200, deleted.text)
        async with self.sessions() as session:
            self.assertIsNone(await session.get(models.ModelDef, mid))

    async def test_unauthenticated_catalog_mutation_is_denied(self):
        response = await self.http.put("/api/v1/admin/model-providers/no-auth", json={"expectedRevision": "new"})
        self.assertEqual(response.status_code, 401, response.text)

    async def test_wellformed_provider_and_model_round_trip(self):
        created = await self.request("PUT", "/model-providers/good", json={
            "expectedRevision": "new", "name": "Good", "kind": "openai-compat",
            "baseUrl": "https://example.com/v1", "apiKey": "k" * 300, "enabled": True})
        self.assertEqual(created.status_code, 200, created.text)
        self.assertFalse(created.json().get("keyTruncated"), created.text)
        model = await self.request("PUT", "/model-defs", json={
            "expectedRevision": "new", "providerId": "good", "name": "gpt-mini",
            "enabled": True, "modality": "chat"})
        self.assertEqual(model.status_code, 200, model.text)

        catalog = await self.request("GET", "/model-catalog")
        self.assertIn("good", [p["id"] for p in catalog.json()["providers"]])
        self.assertIn("good:gpt-mini", [m["id"] for m in catalog.json()["models"]])

        row = next(p for p in catalog.json()["providers"] if p["id"] == "good")
        deleted = await self.request("DELETE", f"/model-providers/good?expectedRevision={row['revision']}")
        self.assertEqual(deleted.status_code, 200, deleted.text)


if __name__ == "__main__":
    unittest.main()
