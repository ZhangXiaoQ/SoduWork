"""Isolated database/API permissions regression; no real Hub or model calls.

For UI verification: python test_plugin_access.py --serve [port]. This exposes
fixture-only authentication on loopback and never imports the production app.
"""
import asyncio
import base64
from datetime import datetime, timedelta, timezone
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

# Set this before any app import so --serve cannot inherit the developer's .env.
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

import httpx
from fastapi import FastAPI, Header
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.db import Base, get_session
from app.deps import current_client, current_user
from app.api import plugin_client_catalog, plugin_client_runs, plugin_permissions, plugins
from app.services import (plugin_access, plugin_audience, plugin_catalog,
                          plugin_drafts, plugin_installed, plugin_mcp_gateway,
                          plugin_packages, plugin_service, rbac)
from tests.sqlite_schema import create_fresh_sqlite_schema


def draft(**values):
    return {"template": "method", "key": "permission-fixture", "name": "权限验证插件",
            "description": "仅用于隔离环境验证插件权限", "version": "1.0.0",
            "instructions": "按用户请求整理资料。", **values}


async def fixture():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await create_fresh_sqlite_schema(conn, Base.metadata)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    temporary = tempfile.TemporaryDirectory(prefix="soduwork-plugin-access-")
    temporary._storage_patch = patch.object(plugin_packages, "package_root", return_value=temporary.name)
    temporary._storage_patch.start()
    content = plugin_drafts.build(draft())
    parsed = plugin_packages.parse(content)
    package = Path(temporary.name) / "fixture.zip"
    package.write_bytes(content)
    async with factory() as session:
        session.add_all([
            models.OrgUnit(id="company", name="演示公司"),
            models.OrgUnit(id="team", name="设计团队", parent_id="company"),
            models.OrgUnit(id="subteam", name="体验小组", parent_id="team"),
            models.OrgUnit(id="other", name="其他公司"),
            models.Role(id="manager", name="插件管理员", permissions=["plugin.manage", "plugin.run"]),
            models.User(id="admin", username="fixture-admin", display_name="测试管理员",
                        org_id="company", role_id="manager"),
            models.User(id="author", username="fixture-author", display_name="原作者", org_id="company"),
            models.User(id="employee", username="fixture-employee", display_name="测试员工", org_id="subteam"),
            models.User(id="outside", username="fixture-outsider", display_name="外部员工", org_id="other"),
            models.User(id="disabled", username="fixture-disabled", org_id="company", is_active=False),
            *[models.Client(id="device-" + key, user_ref=key, auth_state="active")
              for key in ("admin", "author", "employee", "outside")],
            am.Plugin(id="permission-plugin", key="permission-fixture", name="权限验证插件",
                      org_id="company", enabled=True, created_by="author"),
            am.PluginVersion(id="permission-v1", plugin_id="permission-plugin", version="1.0.0",
                             checksum=parsed["checksum"], enabled=True, trust_state="approved",
                             manifest=parsed["manifest"], workflow=parsed["workflow"],
                             capability_report=parsed["capabilities"], package_path=str(package),
                             created_by="author"),
            am.PluginInstallation(plugin_id="permission-plugin", version_id="permission-v1",
                                  user_id="employee", enabled=True),
            am.PluginBinding(id="permission-binding", plugin_id="permission-plugin",
                             version_id="permission-v1", org_id="company", enabled=True),
        ])
        await session.commit()
    app = FastAPI()
    app.add_middleware(CORSMiddleware, allow_origins=["http://127.0.0.1:5173", "http://127.0.0.1:5175"],
                       allow_methods=["*"], allow_headers=["*"])

    async def database():
        async with factory() as session:
            yield session

    async def admin():
        async with factory() as session:
            user = await session.get(models.User, "admin")
            user._perms = {"plugin.manage", "plugin.run"}
            return user

    async def client(x_test_user: str = Header(default="employee")):
        async with factory() as session:
            return await session.get(models.Client, "device-" + x_test_user)

    app.dependency_overrides.update({get_session: database, current_user: admin, current_client: client})
    for router in (plugins.router, plugin_client_catalog.router, plugin_client_runs.router,
                   plugin_permissions.router, plugin_permissions.admin_router):
        app.include_router(router)
    return engine, factory, temporary, app


class PluginAccessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine, self.factory, self.temporary, self.app = await fixture()
        self.session = self.factory()
        self.plugin = await self.session.get(am.Plugin, "permission-plugin")
        self.version = await self.session.get(am.PluginVersion, "permission-v1")
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://fixture")

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.session.close()
        await self.engine.dispose()
        self.temporary._storage_patch.stop()
        self.temporary.cleanup()

    async def save(self, **rules):
        return await plugin_access.save(self.session, self.plugin, rules, "admin")

    async def visible(self, user="employee"):
        allowed = await plugin_audience.allowed_version_ids(self.session, [self.version.id], user)
        return plugin_audience.visible(self.version, allowed)

    async def test_inherit_preserves_version_audience_and_only_author_or_manager_edits(self):
        self.assertTrue(await self.visible())
        self.version.visibility = "users"
        await self.session.commit()
        self.assertFalse(await self.visible())
        for user, expected in (("employee", False), ("author", True), ("admin", True), ("outside", False)):
            decision = (await plugin_access.decisions(self.session, [self.plugin], user))[self.plugin.id]
            self.assertEqual(decision["canEdit"], expected)

    async def test_use_and_edit_are_independent_and_apply_to_all_versions(self):
        await self.save(use={"mode": "none"}, edit={"mode": "users", "userIds": ["employee"]})
        self.assertFalse(await self.visible())
        result = (await plugin_access.decisions(self.session, [self.plugin], "employee"))[self.plugin.id]
        self.assertTrue(result["canEdit"])
        rows = await plugin_catalog.client_catalog(self.session, "subteam", "employee", "employee",
                                                    visible_org_ids={"company", "team", "subteam"})
        item = next(x for x in rows["items"] if x["pluginId"] == self.plugin.id)
        self.assertEqual(item["permissions"], {"canUse": False, "canEdit": True})
        self.assertFalse(item["conversationUse"]["available"])
        self.assertFalse(item["taskReady"])
        await self.save(use={"mode": "organization"}, edit={"mode": "none"})
        self.assertTrue(await self.visible())
        self.version.visibility = "users"
        self.assertTrue(await self.visible())

    async def test_organization_policy_reaches_catalog_installation_and_employee_api(self):
        """The live plugin policy must override a restricted version everywhere."""
        self.version.visibility = "users"
        await self.session.commit()
        await self.save(use={"mode": "organization"}, edit={"mode": "organization"})

        catalog = await plugin_catalog.client_catalog(
            self.session, "subteam", "employee", "employee",
            visible_org_ids={"company", "team", "subteam"})
        item = next(row for row in catalog["items"]
                    if row["pluginId"] == self.plugin.id)
        self.assertEqual(item["permissions"], {"canUse": True, "canEdit": True})
        self.assertTrue(item["conversationUse"]["available"])
        self.assertEqual((await self.http.get(
            "/api/v1/plugins/permission-plugin/permissions")).json(), {
                "pluginId": self.plugin.id, "canUse": True, "canEdit": True})
        resolved = await plugin_installed.resolve(
            self.session, "subteam", "employee", [self.plugin.id])
        self.assertEqual(resolved[0][1].id, self.version.id)

        await self.save(use={"mode": "none"})
        denied = await plugin_catalog.client_catalog(
            self.session, "subteam", "employee", "employee",
            visible_org_ids={"company", "team", "subteam"})
        item = next(row for row in denied["items"]
                    if row["pluginId"] == self.plugin.id)
        self.assertFalse(item["permissions"]["canUse"])
        with self.assertRaises(ValueError):
            await plugin_installed.resolve(
                self.session, "subteam", "employee", [self.plugin.id])

    async def test_organization_policy_reaches_same_company_sibling_department(self):
        """Company-wide access must not stop at the plugin owner's department."""
        peer_org = models.OrgUnit(id="peer-team", name="市场团队", parent_id="company")
        peer = models.User(id="peer", username="fixture-peer", display_name="同公司员工",
                           org_id="peer-team")
        peer_client = models.Client(id="device-peer", user_ref="peer", auth_state="active")
        peer_installation = am.PluginInstallation(
            plugin_id=self.plugin.id, version_id=self.version.id,
            user_id="peer", enabled=True)
        self.session.add_all([peer_org, peer, peer_client, peer_installation])
        self.version.visibility = "users"
        await self.session.commit()
        await self.save(use={"mode": "organization"}, edit={"mode": "organization"})

        decision = (await plugin_access.decisions(
            self.session, [self.plugin], "peer"))[self.plugin.id]
        self.assertEqual(decision, {"useOverride": True, "canEdit": True})
        scope = await rbac.company_org_ids(self.session, peer)
        catalog = await plugin_catalog.client_catalog(
            self.session, "peer-team", "peer", "peer", visible_org_ids=scope)
        item = next(row for row in catalog["items"]
                    if row["pluginId"] == self.plugin.id)
        self.assertEqual(item["permissions"], {"canUse": True, "canEdit": True})
        self.assertEqual((await self.http.get(
            "/api/v1/plugins/permission-plugin/permissions",
            headers={"x-test-user": "peer"})).json(), {
                "pluginId": self.plugin.id, "canUse": True, "canEdit": True})
        resolved = await plugin_installed.resolve(
            self.session, "peer-team", "peer", [self.plugin.id],
            provision_defaults=False)
        self.assertEqual(resolved[0][1].id, self.version.id)

    async def test_granted_team_includes_descendants_but_never_foreign_orgs(self):
        await self.save(use={"mode": "org_units", "orgUnitIds": ["team"]},
                        edit={"mode": "org_units", "orgUnitIds": ["team"]})
        self.assertTrue(await self.visible())
        self.assertFalse(await self.visible("author"))
        self.assertFalse(await self.visible("outside"))
        with self.assertRaises(ValueError):
            await self.save(use={"mode": "users", "userIds": ["outside"]})
        with self.assertRaises(ValueError):
            await self.save(edit={"mode": "org_units", "orgUnitIds": ["other"]})
        with self.assertRaises(ValueError):
            await self.save(edit={"mode": "users", "userIds": ["disabled"]})

    async def test_revocation_blocks_existing_installation_and_old_signed_version_grant(self):
        client = await self.session.get(models.Client, "device-employee")
        await plugin_installed.resolve(self.session, "subteam", "employee", [self.plugin.id])
        await plugin_mcp_gateway._installed_names(self.session, client, {"pvids": [self.version.id]})
        await self.save(use={"mode": "none"})
        with self.assertRaises(ValueError):
            await plugin_installed.resolve(self.session, "subteam", "employee", [self.plugin.id])
        with self.assertRaises(ValueError):
            await plugin_mcp_gateway._installed_names(self.session, client, {"pvids": [self.version.id]})
        with self.assertRaises(ValueError):
            await plugin_mcp_gateway._remote_grants(self.session, client, {"bids": ["permission-binding"]})

    async def test_packaged_page_reads_installed_bytes_and_rechecks_access(self):
        ui = {"contributions": [{"id": "main", "title": "静态页面", "slot": "workspace.navigation",
            "source": {"type": "package", "entry": "ui/index.html", "openMode": "workspace"}}]}
        resources = [{"path": path, "kind": kind, "encoding": "base64",
                      "content": base64.b64encode(content).decode()}
                     for path, kind, content in [("ui/index.html", "ui", b"<!doctype html><title>Static</title>"),
                                                  ("assets/logo.svg", "asset", b"<svg/>"),
                                                  ("references/private.txt", "reference", b"Not a page resource")]]
        content = plugin_drafts.build(draft(template="app", ui=ui, resources=resources))
        parsed = plugin_packages.parse(content)
        Path(self.version.package_path).write_bytes(content)
        self.version.checksum = parsed["checksum"]
        self.version.manifest = parsed["manifest"]
        self.version.capability_report = parsed["capabilities"]
        await self.session.commit()
        path = "/api/v1/plugins/permission-plugin/ui-package"
        response = await self.http.get(path)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["ui"], parsed["manifest"]["ui"])
        self.assertEqual({row["path"] for row in response.json()["resources"]},
                         {"ui/index.html", "assets/logo.svg"})
        etag = response.headers["etag"]
        conditional = await self.http.get(path, headers={"If-None-Match": etag})
        self.assertEqual(conditional.status_code, 304)
        self.assertEqual(conditional.content, b"")
        self.assertEqual((await self.http.get(path, headers={"If-None-Match": "W/" + etag})).status_code, 304)
        self.assertEqual((await self.http.get(path, headers={"x-test-user": "outside", "If-None-Match": etag})).status_code, 409)
        self.assertEqual((await self.http.get(path, headers={"x-test-user": "outside"})).status_code, 409)
        installation = (await self.session.execute(select(am.PluginInstallation).where(
            am.PluginInstallation.user_id == "employee", am.PluginInstallation.plugin_id == self.plugin.id))).scalar_one()
        installation.enabled = False
        await self.session.commit()
        self.assertEqual((await self.http.get(path)).status_code, 409)
        self.assertEqual((await self.http.get(path, headers={"If-None-Match": etag})).status_code, 409)
        installation.enabled = True
        await self.session.commit()
        await self.save(use={"mode": "none"})
        self.assertEqual((await self.http.get(path)).status_code, 409)
        self.assertEqual((await self.http.get(path, headers={"If-None-Match": etag})).status_code, 409)
        await self.save(use={"mode": "organization"})
        changed = [{**row, "content": base64.b64encode(b"<title>Changed page</title>").decode()}
                   if row["path"] == "ui/index.html" else row for row in resources]
        Path(self.version.package_path).write_bytes(plugin_drafts.build(draft(template="app", ui=ui, resources=changed)))
        self.assertEqual((await self.http.get(path)).status_code, 409, "modified immutable packages are rejected")
        self.assertEqual((await self.http.get(path, headers={"If-None-Match": etag})).status_code, 409)

    async def test_revocation_blocks_task_start_even_with_known_binding_id(self):
        task = SimpleNamespace(id="", repo_id=None, project_id=None, owner_client_id="device-employee")
        await plugin_service.resolve_binding(self.session, task, binding_id="permission-binding")
        await self.save(use={"mode": "none"})
        with self.assertRaises(ValueError):
            await plugin_service.resolve_binding(self.session, task, binding_id="permission-binding")

    async def test_permission_api_and_draft_are_immediate_without_relogin(self):
        path = "/api/v1/plugins/permission-plugin"
        self.assertEqual((await self.http.get(path + "/draft")).status_code, 403)
        result = await self.http.patch("/api/v1/admin/plugins/permission-plugin/access-policy", json={
            "use": {"mode": "none"}, "edit": {"mode": "users", "userIds": ["employee"]},
            "expectedUpdatedAt": 0})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual((await self.http.get(path + "/permissions")).json()["canEdit"], True)
        response = await self.http.get(path + "/draft")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["draft"]["sourcePluginId"], self.plugin.id)
        self.assertEqual((await self.http.put(path + "/installation", json={
            "enabled": True, "expectedVersionId": self.version.id})).status_code, 403)
        await self.save(edit={"mode": "none"})
        self.assertEqual((await self.http.get(path + "/draft")).status_code, 403)
        self.assertEqual((await self.http.get(path + "/permissions")).json()["canEdit"], False)

    async def test_http_grants_reach_catalog_without_granting_admin_authority(self):
        response = await self.http.patch("/api/v1/admin/plugins/permission-plugin/access-policy", json={
            "use": {"mode": "organization"}, "edit": {"mode": "users", "userIds": ["employee"]},
            "expectedUpdatedAt": 0})
        self.assertEqual(response.status_code, 200, response.text)
        catalog = await self.http.get("/api/v1/plugins/catalog")
        self.assertEqual(catalog.status_code, 200, catalog.text)
        item = next(row for row in catalog.json()["items"] if row["pluginId"] == self.plugin.id)
        self.assertEqual(item["permissions"], {"canUse": True, "canEdit": True})
        self.assertEqual((await self.http.get("/api/v1/plugins/permission-plugin/draft")).status_code, 200)

        async def employee_admin_identity():
            async with self.factory() as session:
                user = await session.get(models.User, "employee")
                user._perms = set()
                return user

        self.app.dependency_overrides[current_user] = employee_admin_identity
        response = await self.http.patch("/api/v1/admin/plugins/permission-plugin/access-policy",
                                         json={"use": {"mode": "none"}})
        self.assertEqual(response.status_code, 403, response.text)
        self.assertTrue((await self.http.get("/api/v1/plugins/permission-plugin/permissions")).json()["canUse"])

    async def test_admin_management_scope_and_member_use_remain_independent(self):
        await self.save(use={"mode": "none"}, edit={"mode": "none"})
        response = await self.http.get("/api/v1/plugins/permission-plugin/permissions",
                                       headers={"X-Test-User": "admin"})
        self.assertEqual(response.json(), {"pluginId": self.plugin.id, "canUse": False, "canEdit": True})
        admin = await self.session.get(models.User, "admin")
        admin.org_id = "team"
        await self.session.commit()
        before = await plugin_access.get(self.session, self.plugin.id)
        response = await self.http.patch("/api/v1/admin/plugins/permission-plugin/access-policy", json={
            "use": {"mode": "organization"}, "expectedUpdatedAt": before["updatedAt"]})
        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(await plugin_access.get(self.session, self.plugin.id), before)

    async def test_stale_policy_save_conflicts_and_candidate_list_is_scoped(self):
        result = await self.save(use={"mode": "none"}, expectedUpdatedAt=0)
        with self.assertRaises(plugin_access.PolicyConflict):
            await self.save(use={"mode": "organization"}, expectedUpdatedAt=0)
        self.assertEqual((await plugin_access.get(self.session, self.plugin.id))["updatedAt"], result["updatedAt"])
        response = (await self.http.get("/api/v1/admin/plugins/permission-plugin/access-candidates")).json()
        self.assertEqual({u["id"] for u in response["items"]}, {"admin", "author", "employee"})
        self.assertEqual({o["id"] for o in response["orgUnits"]}, {"company", "team", "subteam"})

    async def test_foreign_client_cannot_inspect_permission_or_source_draft(self):
        for route in ("permissions", "draft"):
            response = await self.http.get("/api/v1/plugins/permission-plugin/" + route,
                                           headers={"X-Test-User": "outside"})
            self.assertEqual(response.status_code, 404)

    async def test_saved_draft_cannot_submit_or_sign_after_edit_revoke(self):
        body = draft(sourcePluginId=self.plugin.id, version="1.0.1")
        await self.save(edit={"mode": "users", "userIds": ["employee"]})
        self.assertEqual((await self.http.post("/api/v1/plugins/drafts/preflight", json=body)).status_code, 200)
        await self.save(edit={"mode": "none"})
        for route, payload in (("drafts/preflight", body), ("drafts", body),
                               ("personal-publish", {"draft": body}),
                               ("drafts/signing-payload", {"draft": body})):
            response = await self.http.post("/api/v1/plugins/" + route, json=payload)
            self.assertEqual(response.status_code, 403, response.text)
        # Removing the optional source ID cannot bypass same-key authorization.
        employee = await self.session.get(models.User, "employee")
        employee.org_id = "company"
        await self.session.commit()
        body.pop("sourcePluginId")
        self.assertEqual((await self.http.post("/api/v1/plugins/drafts", json=body)).status_code, 403)
        archive = plugin_drafts.build(body)
        response = await self.http.post("/api/v1/plugins/submissions", files={"file": ("plugin.zip", archive)})
        self.assertEqual(response.status_code, 403, response.text)

    async def test_policy_notification_only_reaches_related_online_devices(self):
        from app.realtime import hub
        with patch.object(hub, "online_devices", return_value={"device-employee", "device-outside"}), \
                patch.object(hub, "publish", AsyncMock()) as publish:
            await plugin_access.notify(self.session, self.plugin, 123)
        publish.assert_awaited_once_with("device-employee", {
            "type": "plugins.policy", "pluginId": self.plugin.id, "updatedAt": 123})

    async def test_corrupt_configured_policy_fails_closed_and_admin_can_repair(self):
        self.session.add(models.AppSetting(key=plugin_access.PREFIX + self.plugin.id, value="not json"))
        await self.session.commit()
        self.assertFalse(await self.visible())
        await self.save(use={"mode": "organization"})
        self.assertTrue(await self.visible())

    async def test_revoke_blocks_queued_dispatch_and_retry_before_side_effects(self):
        from app.services import workflow_engine, workflow_runs
        task = models.Task(id="fixture-task", owner_client_id="device-employee", title="权限测试")
        run = am.WorkflowRun(id="fixture-run", task_id=task.id, plugin_id=self.plugin.id,
                             plugin_version_id=self.version.id, binding_id="permission-binding", state="failed")
        self.session.add_all([task, run])
        await self.session.commit()
        await self.save(use={"mode": "none"})
        with self.assertRaisesRegex(ValueError, "权限已被管理员收回"):
            await workflow_runs.retry_failed_quality(self.session, run)
        run.state = "running"
        with self.assertRaisesRegex(ValueError, "权限已被管理员收回"):
            await workflow_runs.redispatch_running_gate(self.session, run)
        self.version.workflow = {"nodes": [{"key": "work", "type": "ai"}]}
        node = am.NodeRun(id="fixture-node", run_id=run.id, node_key="work", node_type="ai", state="queued",
                         idempotency_key="permission-fixture-node")
        outbox = am.WorkflowOutbox(id="fixture-outbox", run_id=run.id, node_run_id=node.id, topic="node.execute")
        self.session.add_all([node, outbox])
        await self.session.commit()
        with self.assertRaisesRegex(ValueError, "权限已被管理员收回"):
            await workflow_engine._execute_node(self.session, outbox)
        self.assertEqual(node.state, "queued")

    async def test_authorized_child_member_submits_new_version_to_original_plugin(self):
        await self.save(edit={"mode": "users", "userIds": ["employee"]})
        response = await self.http.post("/api/v1/plugins/drafts", json=draft(
            sourcePluginId=self.plugin.id, version="1.0.1", instructions="改进后的工作方法。"))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["plugin"]["id"], self.plugin.id)
        self.assertEqual(response.json()["plugin"]["orgId"], "company")
        version = response.json()["plugin"]["latestVersion"]
        self.assertEqual(version["version"], "1.0.1")
        self.assertEqual(version["trustState"], "quarantined")
        self.assertFalse(version["enabled"])
        denied = await self.http.post("/api/v1/plugins/drafts", json=draft(
            sourcePluginId=self.plugin.id, key="switched-identity", version="1.0.2"))
        self.assertEqual(denied.status_code, 400)

    async def test_same_timestamp_versions_use_semver_in_detail_and_catalog(self):
        stamp = datetime(2026, 10, 20, tzinfo=timezone.utc)
        self.version.created_at = stamp
        self.session.add_all([
            am.PluginVersion(id=vid, plugin_id=self.plugin.id, version=version,
                             checksum=vid, created_at=stamp, trust_state="quarantined",
                             enabled=False, manifest=self.version.manifest,
                             workflow=self.version.workflow)
            for vid, version in (("zz-older-semver", "1.0.9"),
                                 ("00-newer-semver", "1.0.10"))
        ])
        await self.session.commit()
        detail = await plugin_service.plugin_api(self.session, self.plugin, True)
        catalog = await plugin_service.list_plugins(self.session, {"company"})
        self.assertEqual(detail["latestVersion"]["version"], "1.0.10")
        self.assertEqual(catalog[0]["latestVersion"]["version"], "1.0.10")
        self.assertEqual([row["version"] for row in detail["versions"]],
                         ["1.0.10", "1.0.9", "1.0.0"])
        self.assertEqual(detail["latestVersion"]["compatibility"]["fromVersion"], "1.0.9")
        self.assertEqual(detail["latestVersion"]["trustState"], "quarantined")
        self.assertFalse(detail["latestVersion"]["enabled"])

    async def test_submission_time_still_precedes_semver_for_management_history(self):
        stamp = datetime(2026, 10, 20, tzinfo=timezone.utc)
        self.version.created_at = stamp + timedelta(seconds=1)
        self.session.add(am.PluginVersion(
            id="older-high-semver", plugin_id=self.plugin.id, version="2.0.0",
            checksum="older-high-semver", created_at=stamp,
            manifest=self.version.manifest, workflow=self.version.workflow))
        await self.session.commit()
        detail = await plugin_service.plugin_api(self.session, self.plugin, True)
        catalog = await plugin_service.list_plugins(self.session, {"company"})
        self.assertEqual(detail["latestVersion"]["id"], self.version.id)
        self.assertEqual(catalog[0]["latestVersion"]["id"], self.version.id)

    async def test_governance_latest_items_and_action_queues_agree(self):
        stamp = datetime(2026, 10, 20, tzinfo=timezone.utc)
        expected_latest = {}
        for kind, trust, blocker in (("revoked", "revoked", ""),
                                     ("quality", "approved", ""),
                                     ("dependency", "approved", "Current dependency"),
                                     ("newer-time", "revoked", "")):
            plugin_id = "governance-" + kind
            self.session.add(am.Plugin(id=plugin_id, key=plugin_id, name=kind,
                                       org_id="company", enabled=True, created_by="author"))
            for current in (False, True):
                version_id = ("00-current-" if current else "zz-previous-") + kind
                version = ("1.0.10" if current else "1.0.9")
                created = stamp
                if kind == "newer-time":
                    version = "1.0.0" if current else "2.0.0"
                    created = stamp if current else stamp - timedelta(seconds=1)
                report = {"hasWorkflow": False}
                if kind == "dependency":
                    report["adapterBlockers"] = [blocker if current else "Obsolete dependency"]
                state = trust if current else "approved"
                self.session.add(am.PluginVersion(
                    id=version_id, plugin_id=plugin_id, version=version,
                    checksum=version_id, created_at=created, trust_state=state,
                    enabled=state == "approved", capability_report=report,
                    manifest={**self.version.manifest, "key": plugin_id, "version": version},
                    workflow={"nodes": []}))
                if current:
                    expected_latest[plugin_id] = version_id
                if kind == "quality":
                    self.session.add(am.PluginEvaluationRun(
                        id="evaluation-" + version_id, plugin_id=plugin_id,
                        version_id=version_id, org_id="company", case_key="acceptance",
                        state="failed", verdict="failed", created_at=stamp,
                        case_snapshot={"name": "Current quality" if current else "Obsolete quality"}))
        await self.session.commit()

        # Exercise the real scoped admin API and all overview queries against SQLite.
        response = await self.http.get("/api/v1/admin/plugins/governance")
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        items = {item["id"]: item for item in result["items"]}
        for plugin_id, version_id in expected_latest.items():
            self.assertEqual(items[plugin_id]["latestVersion"]["id"], version_id)
        self.assertEqual(result["summary"]["available"], 3)
        self.assertEqual(result["counts"], {"review": 0, "quality": 1,
                         "dependency": 1, "runtime": 0, "revoked": 2})
        self.assertEqual({row["versionId"] for row in result["queues"]["revoked"]},
                         {expected_latest["governance-revoked"], expected_latest["governance-newer-time"]})
        quality = result["queues"]["quality"]
        self.assertEqual([row["versionId"] for row in quality],
                         [expected_latest["governance-quality"]])
        self.assertEqual(quality[0]["detail"], "Current quality")
        dependencies = result["queues"]["dependency"]
        self.assertEqual([row["versionId"] for row in dependencies],
                         [expected_latest["governance-dependency"]])
        self.assertEqual(dependencies[0]["detail"], "Current dependency")
        self.assertEqual(result["summary"]["attention"], 4)

    async def test_edit_grant_does_not_replace_older_usable_version_with_restricted_new_one(self):
        self.session.add(am.PluginVersion(
            id="restricted-v2", plugin_id=self.plugin.id, version="2.0.0", checksum="restricted-v2",
            trust_state="approved", enabled=True, visibility="users", manifest=self.version.manifest,
            workflow=self.version.workflow, capability_report=self.version.capability_report))
        await self.session.commit()
        await self.save(edit={"mode": "users", "userIds": ["employee"]})
        result = await plugin_catalog.client_catalog(
            self.session, "subteam", "employee", "employee", visible_org_ids={"company", "team", "subteam"})
        item = result["items"][0]
        self.assertEqual(item["versionId"], self.version.id)
        self.assertTrue(item["permissions"]["canUse"])
        self.assertTrue(item["permissions"]["canEdit"])
        self.assertTrue(item["conversationUse"]["available"])


async def serve(port):
    import uvicorn
    engine, _, temporary, app = await fixture()
    print(json.dumps({"url": f"http://127.0.0.1:{port}", "pluginId": "permission-plugin",
                      "adminToken": "isolated-fixture-only", "employee": "employee"}), flush=True)
    try:
        await uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port,
                                           log_level="warning")).serve()
    finally:
        await engine.dispose()
        temporary._storage_patch.stop()
        temporary.cleanup()


if __name__ == "__main__":
    if "--serve" in sys.argv:
        asyncio.run(serve(int(sys.argv[-1]) if sys.argv[-1].isdigit() else 9096))
    else:
        unittest.main()
