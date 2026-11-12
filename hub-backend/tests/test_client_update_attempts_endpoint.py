"""Release-history endpoint: platform-wide upgrade attempts for the admin console."""
import os
import unittest

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

import httpx
from fastapi import FastAPI, Request
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import client_updates
from app.db import Base, get_session
from app.deps import current_client, current_user
from app.models import Client, ClientRelease, ClientUpdateAttempt, User


def _release(release_id: str, version: str, platform: str = "win32") -> ClientRelease:
    return ClientRelease(
        id=release_id, version=version, channel="stable", platform=platform,
        arch="x64", artifact_name=f"SoduWork-{version}-Setup.exe", artifact_size=1,
        sha256="a" * 64, key_id="soduwork-client-release-2026b", signature="s" * 88,
        artifact_path="releases/x", enabled=True)


def _attempt(client_id: str, release_id: str, version: str,
             state: str, **kw) -> ClientUpdateAttempt:
    return ClientUpdateAttempt(
        client_id=client_id, release_id=release_id, target_version=version,
        state=state, progress=kw.get("progress", 0),
        current_version=kw.get("current", "1.12.64"),
        requested_by=kw.get("by", "auto"), error=kw.get("error", ""))


class UpdateAttemptsEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(lambda connection: Base.metadata.create_all(connection, tables=[
                Client.__table__, ClientRelease.__table__, ClientUpdateAttempt.__table__,
                User.__table__]))
        async with self.sessions() as session:
            session.add_all([
                Client(id="desk-1", name="研发桌面", platform="win32", app_version="1.12.64"),
                Client(id="desk-2", name="测试机", platform="linux", app_version="1.12.63"),
                _release("rel-65", "1.12.65"),
                _release("rel-66", "1.12.66"),
                _attempt("desk-1", "rel-66", "1.12.66", "installed", progress=100),
                _attempt("desk-2", "rel-66", "1.12.66", "failed", error="disk full"),
                _attempt("desk-1", "rel-65", "1.12.65", "installed", progress=100),
            ])
            await session.commit()
        self.app = FastAPI()
        self.app.include_router(client_updates.admin_router)

        async def session_override():
            async with self.sessions() as session:
                yield session

        async def user_override():
            admin = User(id="admin-1", username="admin", is_super=True,
                         role_id="", is_active=True)
            admin._perms = {"client.view", "client.update"}
            return admin

        async def client_override():
            return Client(id="desk-1")

        self.app.dependency_overrides[get_session] = session_override
        self.app.dependency_overrides[current_user] = user_override
        self.app.dependency_overrides[current_client] = client_override
        self.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def test_lists_all_attempts_with_device_and_release_info(self):
        data = (await self.http.get("/api/v1/admin/client-update-attempts")).json()
        self.assertEqual(len(data["attempts"]), 3)
        top = data["attempts"][0]  # Place the newest release first.
        self.assertIn(top["clientName"], {"研发桌面", "测试机"})
        self.assertIn(top["releaseVersion"], {"1.12.65", "1.12.66"})
        counts = data["counts"]
        self.assertEqual(counts.get("installed"), 2)
        self.assertEqual(counts.get("failed"), 1)

    async def test_release_filter_and_state_filter(self):
        data = (await self.http.get(
            "/api/v1/admin/client-update-attempts",
            params={"releaseId": "rel-66", "state": "failed"})).json()
        self.assertEqual(len(data["attempts"]), 1)
        row = data["attempts"][0]
        self.assertEqual(row["clientId"], "desk-2")
        self.assertEqual(row["error"], "disk full")
        self.assertEqual(data["counts"], {"failed": 1})
        active = (await self.http.get(
            "/api/v1/admin/client-update-attempts", params={"state": "active"})).json()
        self.assertEqual(active["attempts"], [])

    async def test_unknown_release_is_404_and_bad_state_is_400(self):
        missing = await self.http.get(
            "/api/v1/admin/client-update-attempts", params={"releaseId": "nope"})
        self.assertEqual(missing.status_code, 404)
        bad = await self.http.get(
            "/api/v1/admin/client-update-attempts", params={"state": "bogus"})
        self.assertEqual(bad.status_code, 400)


if __name__ == "__main__":
    unittest.main()
