"""Compose-surface plugin recommendations: placement slots, patching and client listing."""
import os
import unittest

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am
from app.api import plugin_client_catalog, plugins
from app.db import Base, get_session
from app.deps import current_client, current_user
from app.models import AppSetting, AuditLog, Client, OrgUnit, User
from app.services import plugin_marketplace, plugin_service


def _plugin(plugin_id, name, *, org_id=None, enabled=True):
    return am.Plugin(id=plugin_id, org_id=org_id, key="key-" + plugin_id,
                     name=name, description="desc of " + name, enabled=enabled)


def _approved_version(plugin_id, cover=""):
    return am.PluginVersion(
        id="ver-" + plugin_id, plugin_id=plugin_id, version="1.0.0", enabled=True,
        trust_state="approved", checksum="chk-" + plugin_id,
        manifest={"coverUrl": cover} if cover else {})


class RecommendationServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(lambda connection: Base.metadata.create_all(connection, tables=[
                am.Plugin.__table__, am.PluginVersion.__table__,
                am.PluginCatalogPolicy.__table__, am.PluginRecommendation.__table__,
                am.PluginInstallation.__table__, am.PluginAudience.__table__,
                am.PluginBinding.__table__, am.PluginEvaluationRun.__table__,
                User.__table__, OrgUnit.__table__, AppSetting.__table__]))

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def seed(self, *rows):
        async with self.sessions() as session:
            session.add_all(rows)
            await session.commit()

    async def test_sync_creates_updates_and_removes_in_place(self):
        await self.seed(_plugin("p1", "日报助手"))
        async with self.sessions() as session:
            row = await plugin_marketplace.sync_app_recommendation(
                session, "p1", None, True, "admin-1")
            first_id = row.id
            again = await plugin_marketplace.sync_app_recommendation(
                session, "p1", None, True, "admin-1")
            self.assertEqual(again.id, first_id)  # idempotent: enabling twice adds no row
            self.assertTrue(await plugin_marketplace.app_recommended_on(session, "p1"))
            await plugin_marketplace.sync_app_recommendation(
                session, "p1", None, False, "admin-1")
            self.assertFalse(await plugin_marketplace.app_recommended_on(session, "p1"))
            remaining = list((await session.execute(
                select(am.PluginRecommendation))).scalars())
            self.assertEqual(remaining, [])

    async def test_active_recommendations_filter_chain(self):
        await self.seed(
            _plugin("sys-on", "系统启用"),
            _plugin("sys-off", "系统停用", enabled=False),
            _plugin("org-1", "部门甲", org_id="org-1"),
            _plugin("org-2", "部门乙", org_id="org-2"),
            _plugin("future", "未开始的"),
            _plugin("ended", "已结束的"),
        )
        async with self.sessions() as session:
            await plugin_marketplace.sync_app_recommendation(session, "sys-on", None, True, "a")
            await plugin_marketplace.sync_app_recommendation(session, "sys-off", None, True, "a")
            await plugin_marketplace.sync_app_recommendation(session, "org-1", "org-1", True, "a")
            await plugin_marketplace.sync_app_recommendation(session, "org-2", "org-2", True, "a")
            await plugin_marketplace.sync_app_recommendation(session, "future", None, True, "a")
            await plugin_marketplace.sync_app_recommendation(session, "ended", None, True, "a")
            session.add_all([
                # one row per target (concurrency guard keeps the first by (sort,id))
                am.PluginRecommendation(id="dup-b", surface="compose", kind="app",
                                        target_type="plugin", target_id="sys-on", sort=5),
            ])
            # time window: not-started/ended rows are hidden
            await session.execute(select(am.PluginRecommendation))  # keep types loaded
            rows = {r.target_id: r for r in (await session.execute(
                select(am.PluginRecommendation))).scalars()}
            from datetime import datetime, timedelta, timezone
            now = datetime.now(timezone.utc)
            rows["future"].start_at = now + timedelta(days=1)
            rows["ended"].end_at = now - timedelta(days=1)
            await session.commit()
            visible = await plugin_marketplace.active_recommendations(
                session, {"org-1", "org-3"}, "compose")
            self.assertEqual(sorted(r["targetId"] for r in visible),
                             ["org-1", "sys-on"])  # disabled/unauthorized/out-of-window stay hidden; system and visible org rows co-exist
            self.assertEqual([r["targetId"] for r in visible].count("sys-on"), 1)  # per-target dedup
            top = await plugin_marketplace.active_recommendations(session, set(), "compose", limit=1)
            self.assertEqual([r["targetId"] for r in top], ["sys-on"])  # org-less view sees the system row only
            none_surface = await plugin_marketplace.active_recommendations(
                session, set(), "other-surface")
            self.assertEqual(none_surface, [])


class RecommendationEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(lambda connection: Base.metadata.create_all(connection, tables=[
                am.Plugin.__table__, am.PluginVersion.__table__,
                am.PluginCatalogPolicy.__table__, am.PluginRecommendation.__table__,
                am.PluginInstallation.__table__, am.PluginAudience.__table__,
                am.PluginBinding.__table__, am.PluginEvaluationRun.__table__,
                am.WorkflowRun.__table__,
                User.__table__, OrgUnit.__table__, AppSetting.__table__,
                AuditLog.__table__, Client.__table__]))
        async with self.sessions() as session:
            session.add_all([
                OrgUnit(id="org-1", name="部门甲"),
                User(id="admin-1", username="admin", is_super=True, role_id="", is_active=True),
                User(id="emp-1", username="emp", is_super=False, role_id="", is_active=True,
                     org_id="org-1", display_name="员工甲"),
                Client(id="desk-1", name="员工甲桌面", user_ref="emp-1"),
                _plugin("p-compose", "只开对话页"),
                _plugin("p-apps", "只进应用页"),
                _plugin("p-both", "两处都推"),
                _plugin("p-gone", "已停用的", enabled=False),
                _plugin("p-other-org", "别的部门的", org_id="org-2"),
                _approved_version("p-compose", cover="https://cdn.example.com/c.jpg"),
                _approved_version("p-apps", cover="https://cdn.example.com/a.jpg"),
                _approved_version("p-both"),
                _approved_version("p-gone"),
                _approved_version("p-other-org"),
            ])
            await session.commit()
        self.app = FastAPI()
        self.app.include_router(plugins.router)
        self.app.include_router(plugin_client_catalog.router)

        async def session_override():
            async with self.sessions() as session:
                yield session

        async def admin_override():
            return await self._user("admin-1")

        async def client_override():
            return Client(id="desk-1", user_ref="emp-1")

        self.app.dependency_overrides[get_session] = session_override
        self.app.dependency_overrides[current_user] = admin_override
        self.app.dependency_overrides[current_client] = client_override
        import ssl
        transport = httpx.ASGITransport(app=self.app)
        self.client = httpx.AsyncClient(transport=transport,
                                        base_url="http://test", headers={"accept": "application/json"})
        self._ssl = ssl

    async def _user(self, user_id):
        async with self.sessions() as session:
            user = await session.get(User, user_id)
            user._perms = {"plugin.manage"}
            return user

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.engine.dispose()

    async def patch_policy(self, plugin_id, body):
        return await self.client.patch(f"/api/v1/admin/plugins/{plugin_id}/catalog-policy",
                                       json=body)

    async def test_four_position_combinations_and_default_untouched(self):
        # composer page only: no cover validation, no catalog policy requirements
        r = await self.patch_policy("p-compose", {"composeRecommended": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["composeRecommended"])
        self.assertFalse(r.json()["featured"])
        # apps page only: existing semantics, cover required (via manifest coverUrl fallback)
        r = await self.patch_policy("p-apps", {"featured": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["featured"])
        self.assertFalse(r.json()["composeRecommended"])
        # both pages: one transaction writes both (apps-page featured needs a cover; supplied with the request)
        r = await self.patch_policy("p-both", {"featured": True, "composeRecommended": True,
                                               "coverUrl": "https://cdn.example.com/b.jpg"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["featured"])
        self.assertTrue(r.json()["composeRecommended"])
        # all off: both deleted in one transaction
        r = await self.patch_policy("p-both", {"featured": False, "composeRecommended": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["featured"])
        self.assertFalse(r.json()["composeRecommended"])
        # absent = untouched: legacy callers without composeRecommended must not affect composer placement
        r = await self.patch_policy("p-compose", {"installation": "installed_by_default"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["composeRecommended"])
        # non-boolean values rejected (same strict validation as featured)
        r = await self.patch_policy("p-compose", {"composeRecommended": "yes"})
        self.assertEqual(r.status_code, 422, r.text)
        # audit records before/after values for both placements
        async with self.sessions() as session:
            logs = list((await session.execute(select(AuditLog).where(
                AuditLog.action == "plugin.catalog_policy"))).scalars())
        self.assertTrue(all("afterComposeRecommended" in (log.detail or {}) for log in logs))
        self.assertEqual(logs[-1].target_id, "p-compose")

    async def test_featured_true_requires_cover(self):
        async with self.sessions() as session:
            session.add(_approved_version("p-nocover", cover=""))
            session.add(_plugin("p-nocover", "没有封面的"))
            await session.commit()
        r = await self.patch_policy("p-nocover", {"featured": True, "composeRecommended": True})
        self.assertEqual(r.status_code, 422)
        # composer placement unaffected by cover validation
        r = await self.patch_policy("p-nocover", {"featured": False, "composeRecommended": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["composeRecommended"])

    async def test_client_recommendations_listing(self):
        async with self.sessions() as session:
            await plugin_marketplace.sync_app_recommendation(session, "p-compose", None, True, "admin-1", commit=False)
            await plugin_marketplace.sync_app_recommendation(session, "p-both", None, True, "admin-1", commit=False)
            await plugin_marketplace.sync_app_recommendation(session, "p-gone", None, True, "admin-1", commit=False)
            await plugin_marketplace.sync_app_recommendation(session, "p-other-org", "org-2", True, "admin-1", commit=False)
            await session.commit()
        r = await self.client.get("/api/v1/plugins/recommendations?surface=compose")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(sorted(item["targetId"] for item in r.json()["items"]),
                         ["p-both", "p-compose"])  # Filter disabled plugins through liveness checks; rows from other organizations remain invisible.
        self.assertTrue(all(item["kind"] == "app" and item["surface"] == "compose"
                            for item in r.json()["items"]))
        r = await self.client.get("/api/v1/plugins/recommendations?surface=unknown")
        self.assertEqual(r.status_code, 422)

    async def test_recommendation_echo_endpoint(self):
        r = await self.client.get("/api/v1/admin/plugins/p-compose/recommendation")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["composeRecommended"])
        await self.patch_policy("p-compose", {"composeRecommended": True})
        r = await self.client.get("/api/v1/admin/plugins/p-compose/recommendation")
        self.assertTrue(r.json()["composeRecommended"])

    async def test_sidebar_is_an_independent_admin_placement(self):
        r = await self.patch_policy("p-compose", {"sidebarRecommended": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["sidebarRecommended"])
        self.assertFalse(r.json()["composeRecommended"])
        r = await self.client.get("/api/v1/admin/plugins/p-compose/recommendation")
        self.assertTrue(r.json()["sidebarRecommended"])
        r = await self.patch_policy("p-compose", {"composeRecommended": True})
        self.assertTrue(r.json()["sidebarRecommended"], "legacy callers preserve sidebar placement")
        r = await self.client.get("/api/v1/plugins/recommendations?surface=sidebar")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([row["targetId"] for row in r.json()["items"]], ["p-compose"])
        r = await self.patch_policy("p-compose", {"sidebarRecommended": "yes", "composeRecommended": False})
        self.assertEqual(r.status_code, 422)
        r = await self.client.get("/api/v1/admin/plugins/p-compose/recommendation")
        self.assertTrue(r.json()["composeRecommended"], "invalid requests cannot partially save")
        r = await self.patch_policy("p-compose", {"sidebarRecommended": False})
        self.assertFalse(r.json()["sidebarRecommended"])
        self.assertTrue(r.json()["composeRecommended"])
        r = await self.client.get("/api/v1/plugins/recommendations?surface=sidebar")
        self.assertEqual(r.json()["items"], [])

    async def test_employee_cannot_recommend_to_sidebar(self):
        async def employee():
            user = await self._user("emp-1")
            user._perms = set()
            return user
        self.app.dependency_overrides[current_user] = employee
        r = await self.patch_policy("p-compose", {"sidebarRecommended": True})
        self.assertEqual(r.status_code, 403)

    async def test_delete_plugin_cleans_recommendation_rows(self):
        async with self.sessions() as session:
            await plugin_marketplace.sync_app_recommendation(
                session, "p-compose", None, True, "admin-1", commit=False)
            plugin = await session.get(am.Plugin, "p-compose")
            from app.services import plugin_service
            await plugin_service.delete_plugin(session, plugin, force=True, actor_id="admin-1")
            remaining = list((await session.execute(
                select(am.PluginRecommendation))).scalars())
            self.assertEqual(remaining, [])


if __name__ == "__main__":
    unittest.main()
