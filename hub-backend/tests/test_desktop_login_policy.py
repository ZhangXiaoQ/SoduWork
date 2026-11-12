"""Database checks for desktop replacement without revoking phones or cloud jobs."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app.db import Base
from app.models import Client, User
from app.automation_models import RunnerNode
from app.services import desktop_login_policy as policy


class DesktopLoginTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda db: Base.metadata.create_all(db, tables=[User.__table__, Client.__table__, RunnerNode.__table__]))
        async with self.sessions() as session:
            session.add_all([User(id="one", username="one", is_active=True), User(id="two", username="two", is_active=True)])
            for identity, platform, owner in [("new", "win32", "one"), ("old", "Windows", "one"),
                ("phone", "android", "one"), ("cloud", "linux", "one"), ("foreign", "win32", "two")]:
                session.add(Client(id=identity, name=identity, platform=platform, user_ref=owner, auth_state="active", auth_version=1))
            session.add(RunnerNode(id="cloud-runner", client_id="cloud", owner_user_id="one"))
            await session.commit()

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def test_new_desktop_revokes_only_previous_desktop_and_keeps_provenance(self):
        async with self.sessions() as session:
            client = await session.get(Client, "new")
            user = SimpleNamespace(id="one")
            await policy.lock_devices(session, client, user)
            self.assertEqual(await policy.replace_previous(session, client, user), ["old"])
            await session.commit()
        async with self.sessions() as session:
            old = await session.get(Client, "old")
            self.assertEqual((old.auth_state, old.auth_version, old.user_ref), ("pending", 2, "one"))
            for identity in ("new", "phone", "cloud", "foreign"):
                self.assertEqual((await session.get(Client, identity)).auth_state, "active")

    async def test_phone_and_cloud_login_do_not_replace_desktop(self):
        async with self.sessions() as session:
            for identity in ("phone", "cloud"):
                client = await session.get(Client, identity)
                self.assertEqual(await policy.replace_previous(session, client, SimpleNamespace(id="one")), [])
            await session.commit()
            self.assertEqual((await session.get(Client, "old")).auth_state, "active")

    async def test_administrative_assignment_cannot_bypass_desktop_replacement(self):
        from app.api import admin
        for endpoint in (admin.assign_client, admin.activate_client):
            async with self.sessions() as session:
                user = await session.get(User, "one")
                current = await session.get(Client, "new")
                current.secret_hash = "isolated-existing-key-hash"
                old = await session.get(Client, "old")
                old.auth_state = "active"
                await session.commit()
                with patch.object(admin, "_assert_client_in_scope", AsyncMock()), \
                     patch.object(admin, "_assert_user_in_scope", AsyncMock()), \
                     patch.object(admin.audit, "log", AsyncMock()), \
                     patch.object(admin.device_connections, "disconnect", AsyncMock()) as disconnect:
                    response = await endpoint("new", SimpleNamespace(userId="one"), user, session)
                    self.assertTrue(response["ok"])
                    disconnect.assert_any_await("old", 4401)
                await session.refresh(old)
                self.assertEqual((old.auth_state, old.user_ref), ("pending", "one"))
                for identity in ("phone", "cloud", "foreign"):
                    self.assertEqual((await session.get(Client, identity)).auth_state, "active")


if __name__ == "__main__":
    unittest.main()
