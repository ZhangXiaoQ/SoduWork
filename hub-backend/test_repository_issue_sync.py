"""Isolated SQLite + real admin HTTP router tests for repository Issue sync.

Only upstream GitLab scan/start requests are mocked. No application lifespan,
business database, user client, scheduler daemon, or model is started.
"""
from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
from unittest.mock import patch

_module_temp = tempfile.TemporaryDirectory(prefix="soduwork-repository-issues-import-")
os.environ.update({
    "DATABASE_URL": "sqlite+aiosqlite:///" + (Path(_module_temp.name) / ".smoke-unused.db").as_posix(),
    "AUTH_SECRET": "isolated-repository-issues-test-signing-secret",
    "ADMIN_PASS": "isolated-repository-issues-bootstrap-password",
    "SODUWORK_ENV": "development", "CLUSTER_REDIS_URL": "",
    "POLL_INTERVAL_SECONDS": "0", "REPOSITORY_SYNC_INTERVAL_SECONDS": "0", "REPORT_AUTO": "false",
})

import httpx
from sqlalchemy import create_engine, event, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.auth import sign_token
from app.db import Base, get_session
from app.main import app
from app.repository_issue_models import RepositoryIssueLink as Link, RepositoryIssueMember as Member, RepositoryIssueSync as Sync
from app.services import aggregation, repository_issue_access as access, repository_issue_sync as sync, repository_issue_worker as worker, resource_leases

T0 = datetime(2026, 10, 23, 3, 0, tzinfo=timezone.utc)


def upstream(iid=1, *, created=None, **changes):
    return {"id": 1000 + iid, "iid": iid, "project_id": 149, "state": "opened",
        "created_at": (created or T0 + timedelta(seconds=1)).isoformat(),
        "title": "Issue " + str(iid), "description": "Original upstream description",
        "labels": ["type::bug"], "author": {"id": 42, "username": "bound.actor", "name": "External Author"},
        "assignees": [{"id": 114, "username": "external.same"}],
        "web_url": "https://git.example/Industrialagents/soduwork/-/issues/" + str(iid), **changes}


class RepositoryIssueSyncTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        # Build the complete real schema once, then copy it for each isolated
        # database. No test can observe another test's rows or transaction.
        cls.template_folder = tempfile.TemporaryDirectory(prefix="soduwork-issue-schema-")
        cls.template_path = Path(cls.template_folder.name) / "template.db"
        engine = create_engine("sqlite:///" + cls.template_path.as_posix())
        try:
            Base.metadata.create_all(engine)
        finally:
            engine.dispose()

    @classmethod
    def tearDownClass(cls):
        cls.template_folder.cleanup()

    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="soduwork-repository-issues-db-")
        self.db_path = Path(self.folder.name) / "fixture.db"
        shutil.copyfile(self.template_path, self.db_path)
        self.engine = create_async_engine("sqlite+aiosqlite:///" + self.db_path.as_posix())
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.sessions() as session:
            session.add_all([
                models.OrgUnit(id="org-a", name="A"), models.OrgUnit(id="org-b", name="B"),
                models.Role(id="role-manage", name="Fixture manager", permissions=["integration.manage", "task.view"]),
                models.Role(id="role-read", name="Fixture reader", permissions=["task.view"]),
                models.User(id="manager", username="manager", org_id="org-a", role_id="role-manage", is_active=True),
                models.User(id="other-manager", username="other-manager", org_id="org-b", role_id="role-manage", is_active=True),
                models.User(id="same-name", username="external.same", org_id="org-a", role_id="role-read", is_active=True),
                models.User(id="trusted", username="different.local", org_id="org-a", role_id="role-read", is_active=True),
                models.User(id="inactive", username="inactive", org_id="org-a", role_id="role-read", is_active=False),
                models.Client(id="trusted-device", name="Fixture", user_ref="trusted", auth_state="active"),
                models.Integration(id="integration", name="Fixture GitLab", type="gitlab", enabled=True,
                    config={"base_url": "https://git.example", "orgId": "org-a", "pullAuth": {
                        "user": "fixture-account", "secret": "fixture-secret", "kind": "token"}}),
                models.IntegrationBinding(id="binding", integration_id="integration", external_actor="bound.actor", client_id="trusted-device"),
                am.ScmRepository(id="catalog", integration_id="integration", org_id="org-a", provider="gitlab",
                    external_id="149", full_name="Industrialagents/soduwork", display_name="soduwork", active=True, archived=False),
                am.ScmRepository(id="other-catalog", integration_id="integration", org_id="org-b", provider="gitlab",
                    external_id="150", full_name="Other/private", display_name="private", active=True, archived=False),
            ])
            await session.commit()
        self.members = [{"id": 114, "username": "external.same", "name": "Same external name", "state": "active"},
            {"id": 42, "username": "bound.actor", "name": "Different local identity", "state": "active"}]
        self.issues = []
        self.clock = T0
        self.scan_patch = patch.object(sync.remote, "scan", side_effect=lambda *args: {"issues": deepcopy(self.issues), "members": deepcopy(self.members)})
        self.scanner = self.scan_patch.start()
        self.started_patch = patch.object(sync.remote, "started", return_value={"ok": True})
        self.started = self.started_patch.start()
        self.time_patch = patch.object(sync, "now", side_effect=lambda: self.clock)
        self.time_patch.start()
        self.session_patch = patch.object(worker, "SessionLocal", self.sessions)
        self.session_patch.start()
        self.old_overrides = dict(app.dependency_overrides)

        async def isolated_session():
            async with self.sessions() as session:
                yield session
        app.dependency_overrides[get_session] = isolated_session
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture.test")
        self.headers = {"Authorization": "Bearer " + sign_token("manager")}
        self.path = "/api/v1/admin/repository-catalog/catalog/issue-sync"

    async def asyncTearDown(self):
        await self.http.aclose()
        app.dependency_overrides.clear()
        app.dependency_overrides.update(self.old_overrides)
        self.session_patch.stop()
        self.time_patch.stop()
        self.scan_patch.stop()
        self.started_patch.stop()
        await self.engine.dispose()
        self.folder.cleanup()

    async def configure(self, enabled=True, label="处理中"):
        response = await self.http.put(self.path, headers=self.headers, json={"enabled": enabled, "startedLabel": label})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def run_once(self):
        response = await self.http.post(self.path + "/run", headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def counts(self):
        async with self.sessions() as session:
            return (await session.scalar(select(func.count()).select_from(models.Task)),
                    await session.scalar(select(func.count()).select_from(Link)))

    async def first_import(self):
        await self.configure()
        self.clock = T0 + timedelta(seconds=10)
        self.issues = [upstream()]
        await self.run_once()
        async with self.sessions() as session:
            return await session.scalar(select(Link.task_id))

    async def test_github_and_gitlab_subscriptions_keep_identity_members_and_outbox_separate(self):
        async with self.sessions() as session:
            session.add(models.Integration(id="github-integration", name="Fixture GitHub", type="github",
                enabled=True, config={"orgId": "org-a", "pullAuth": {
                    "user": "github-account", "secret": "github-fixture-token", "kind": "token"}}))
            session.add(am.ScmRepository(id="github-catalog", integration_id="github-integration", org_id="org-a",
                provider="github", external_id="149", full_name="example/soduwork", display_name="soduwork",
                active=True, archived=False))
            await session.commit()
        path = "/api/v1/admin/repository-catalog/github-catalog/issue-sync"
        github_issues = []
        with patch.object(sync.github_remote, "scan", side_effect=lambda *args: {
                "issues": deepcopy(github_issues), "members": []}) as github_scan, \
                patch.object(sync.github_remote, "started", return_value={"ok": True}) as github_started:
            await self.configure()
            configured = await self.http.put(path, headers=self.headers,
                json={"enabled": True, "startedLabel": "处理中"})
            self.assertEqual(configured.status_code, 200, configured.text)
            self.clock += timedelta(seconds=10)
            self.issues = [upstream()]
            github_issues.append(upstream(web_url="https://github.com/example/soduwork/issues/1"))
            await self.run_once()
            response = await self.http.post(path + "/run", headers=self.headers)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["created"], 1)
            self.assertEqual(github_scan.call_args.args[0]["_auth_secret"], "github-fixture-token")
            self.assertEqual(self.scanner.call_args.args[0]["_auth_secret"], "fixture-secret")
            async with self.sessions() as session:
                gl = await session.scalar(select(models.Task).where(models.Task.origin == "gitlab_issue"))
                gh = await session.scalar(select(models.Task).where(models.Task.origin == "github_issue"))
                self.assertNotEqual(gl.id, gh.id)
                self.assertEqual((gh.status, gh.triage_stage, gh.owner_client_id), ("todo", "intake", None))
                self.assertEqual(gl.created_by, "trusted")
                self.assertIsNone(gh.created_by)  # GitLab's equal external actor never grants GitHub access.
                self.assertIsNone(await session.get(Member, ("github-catalog", "42")))
                # GitHub local organization visibility needs no remote identity binding.
                self.assertTrue(await access.is_member(session, await session.get(models.Client, "trusted-device"), gh))
                gh.title = "Local preparation stays authoritative"
                await session.commit()
            response = await self.http.post(path + "/run", headers=self.headers)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["created"], 0)
            self.assertEqual(await self.counts(), (2, 2))
            async with self.sessions() as session:
                gh = await session.scalar(select(models.Task).where(models.Task.origin == "github_issue"))
                self.assertEqual(gh.title, "Local preparation stays authoritative")
                self.assertIsNone(await session.get(Member, ("github-catalog", "42")))
                self.assertTrue(await access.record_started(session, gh))
                gh_link = await session.scalar(select(Link).where(Link.catalog_id == "github-catalog"))
                gh_link.next_retry_at = self.clock - timedelta(seconds=1)
                await session.commit()
                self.assertEqual(await worker.writebacks(session, "github-catalog"), 1)
                self.assertEqual(await worker.writebacks(session, "github-catalog"), 0)
                gl_link = await session.scalar(select(Link).where(Link.catalog_id == "catalog"))
                self.assertEqual((gl_link.writeback_state, gl_link.writeback_attempts), ("waiting", 0))
            github_started.assert_called_once()
            self.started.assert_not_called()
            self.assertEqual(github_started.call_args.args[0]["_auth_secret"], "github-fixture-token")
            invalid = await self.http.put(path, headers=self.headers,
                json={"enabled": True, "startedLabel": "x" * 51})
            self.assertEqual(invalid.status_code, 422)
            github_scan.side_effect = sync.github_remote.GitHubHTTPError(403, "GET")
            failure = await self.http.post(path + "/run", headers=self.headers)
            self.assertEqual(failure.status_code, 409)
            self.assertIn("GitHub", failure.json()["detail"])
            self.assertNotIn("github-fixture-token", failure.text)

    async def test_github_catalog_requires_own_token_and_preserves_saved_probe_fields(self):
        from app.connectors import get_connector
        from app.services import repository_catalog
        async with self.sessions() as session:
            row = models.Integration(id="github-integration", name="Fixture GitHub", type="github", enabled=True,
                config={"orgId": "org-a", "credentialClientId": "trusted-device"})
            session.add(row)
            await session.commit()
            with self.assertRaisesRegex(ValueError, "GitHub"):
                await repository_catalog._runtime_config(session, row)
            with self.assertRaisesRegex(ValueError, "访问令牌"):
                await repository_catalog.set_pull_account(session, row.id, user="github-user",
                    secret="github-fixture-token", kind="password")
            await repository_catalog.set_pull_account(session, row.id, user="github-user",
                secret="github-fixture-token", kind="token")
            draft, _ = await repository_catalog._runtime_config(session, row,
                override={"user": "github-draft", "secret": ""})
            self.assertEqual((draft["_auth_user"], draft["_auth_secret"], draft["_auth_kind"]),
                ("github-draft", "github-fixture-token", "token"))
            self.assertEqual(row.config["pullAuth"]["user"], "github-user")
            connector = get_connector("github")
            self.assertIsNotNone(connector)
            with patch.object(connector, "list_repositories", return_value=[{
                    "externalId": "149", "fullName": "example/soduwork", "displayName": "soduwork",
                    "cloneUrl": "https://github.com/example/soduwork.git", "webUrl": "https://github.com/example/soduwork",
                    "defaultBranch": "main", "visibility": "private"}]) as listing:
                result = await repository_catalog.sync_integration(session, row.id)
                self.assertEqual(result["created"], 1)
                self.assertEqual(listing.call_args.args[0]["_auth_secret"], "github-fixture-token")
            visible = await repository_catalog.list_catalog(session, scope={"org-a"})
            self.assertEqual({r["provider"] for r in visible}, {"github", "gitlab"})
            github_rows = [r for r in visible if r["provider"] == "github"]
            self.assertEqual(len(github_rows), 1)
            self.assertNotIn("github-fixture-token", str(visible))

    async def steal_lease(self):
        async with self.sessions() as other:
            result = await other.execute(update(am.ResourceLease).where(
                am.ResourceLease.resource_kind == "repository-issues",
                am.ResourceLease.resource_key == "catalog",
            ).values(token="replacement-owner", lease_until=datetime.now(timezone.utc) + timedelta(minutes=5)))
            self.assertEqual(result.rowcount, 1)
            await other.commit()

    async def assert_replacement_lease_retained(self):
        async with self.sessions() as session:
            token = await session.scalar(select(am.ResourceLease.token).where(
                am.ResourceLease.resource_kind == "repository-issues",
                am.ResourceLease.resource_key == "catalog"))
            self.assertEqual(token, "replacement-owner")

    async def test_lost_import_lease_fences_task_members_and_cursor_commit(self):
        await self.configure()
        self.clock += timedelta(seconds=10)
        self.issues = [upstream()]
        self.members.append({"id": 55, "username": "new-member", "state": "active"})
        refresh = sync.refresh_members

        async def takeover_before_writes(session, repo, members):
            await self.steal_lease()
            await refresh(session, repo, members)

        with patch.object(sync, "refresh_members", side_effect=takeover_before_writes):
            response = await self.http.post(self.path + "/run", headers=self.headers)
        self.assertEqual(response.status_code, 423, response.text)
        self.assertEqual(await self.counts(), (0, 0))
        async with self.sessions() as session:
            row = await session.get(Sync, "catalog")
            self.assertEqual(sync.utc(row.cursor_at), T0)
            self.assertIsNone(row.last_polled_at)
            self.assertIsNone(row.last_success_at)
            self.assertEqual(row.last_error, "")
            self.assertIsNone(await session.get(Member, ("catalog", "55")))
        await self.assert_replacement_lease_retained()

    async def test_lost_writeback_lease_cannot_commit_sent_or_release_new_owner(self):
        task_id = await self.first_import()
        async with self.sessions() as session:
            await access.record_started(session, await session.get(models.Task, task_id))
            await session.commit()
            link = await session.scalar(select(Link))
            link.next_retry_at = self.clock - timedelta(seconds=1)
            await session.commit()
        remote_call = sync.call_remote

        async def takeover_after_http(*args):
            result = await remote_call(*args)
            await self.steal_lease()
            return result

        with patch.object(sync, "call_remote", side_effect=takeover_after_http):
            async with self.sessions() as session:
                with self.assertRaises(resource_leases.LeaseBusy):
                    await worker.writebacks(session, "catalog")
        async with self.sessions() as session:
            link = await session.scalar(select(Link))
            self.assertEqual((link.writeback_state, link.writeback_attempts), ("pending", 1))
            self.assertIsNone(link.sent_at)
            self.assertEqual(link.last_error, "")
        self.assertEqual(self.started.call_count, 1)
        await self.assert_replacement_lease_retained()

    async def test_expired_import_lease_rolls_back_even_when_token_is_unchanged(self):
        await self.configure()
        self.clock += timedelta(seconds=10)
        self.issues = [upstream()]
        refresh = sync.refresh_members

        async def expire_before_writes(session, repo, members):
            async with self.sessions() as other:
                await other.execute(update(am.ResourceLease).where(
                    am.ResourceLease.resource_kind == "repository-issues",
                    am.ResourceLease.resource_key == "catalog",
                ).values(lease_until=datetime.now(timezone.utc) - timedelta(seconds=1)))
                await other.commit()
            await refresh(session, repo, members)

        with patch.object(sync, "refresh_members", side_effect=expire_before_writes):
            response = await self.http.post(self.path + "/run", headers=self.headers)
        self.assertEqual(response.status_code, 423, response.text)
        self.assertEqual(await self.counts(), (0, 0))
        async with self.sessions() as session:
            self.assertEqual(sync.utc((await session.get(Sync, "catalog")).cursor_at), T0)

    async def test_worker_tick_observes_minute_due_boundary_and_pause(self):
        await self.configure()
        self.clock += timedelta(seconds=10)
        self.issues = [upstream()]
        await worker.tick()
        self.assertEqual(await self.counts(), (1, 1))
        async with self.sessions() as session:
            setting = await session.get(Sync, "catalog")
            self.assertEqual(sync.utc(setting.next_poll_at), T0 + timedelta(seconds=60))
        calls = self.scanner.call_count
        await worker.tick()
        self.assertEqual(self.scanner.call_count, calls)
        self.clock = T0 + timedelta(seconds=59)
        await worker.tick()
        self.assertEqual(self.scanner.call_count, calls)
        self.clock = T0 + timedelta(seconds=60)
        self.issues = [upstream(2, created=self.clock - timedelta(seconds=1))]
        await worker.tick()
        self.assertEqual(self.scanner.call_count, calls + 1)
        self.assertEqual(await self.counts(), (2, 2))
        await self.configure(False)
        self.clock += timedelta(seconds=60)
        await worker.tick()
        self.assertEqual(self.scanner.call_count, calls + 1)

    async def test_managed_repository_excludes_legacy_ingestion_even_while_paused(self):
        task_id = await self.first_import()
        async with self.sessions() as session:
            task = await session.get(models.Task, task_id)
            task.title, task.status = "Local title", "doing"
            await session.commit()
        for enabled in (True, False):
            if not enabled:
                await self.configure(False)
            async with self.sessions() as session:
                integration = await session.get(models.Integration, "integration")
                for iid in (1, 2):
                    result = await aggregation.ingest_one(session, integration, {
                        "external_id": str(iid), "title": "Legacy overwrite", "status": "done",
                        "external_url": "https://git.example/Industrialagents/soduwork/-/issues/" + str(iid),
                    })
                    self.assertEqual(result.get("skipped"), "repository_issue_subscription")
                task = await session.get(models.Task, task_id)
                self.assertEqual((task.title, task.status), ("Local title", "doing"))
            self.assertEqual(await self.counts(), (1, 1))
        async with self.sessions() as session:
            integration = await session.get(models.Integration, "integration")
            result = await aggregation.ingest_one(session, integration, {
                "external_id": "3", "title": "Unmanaged repository", "status": "todo",
                "external_url": "https://git.example/Other/unmanaged/-/issues/3",
            })
            self.assertTrue(result["created"])
        self.assertEqual(await self.counts(), (2, 1))

    async def test_first_enable_holds_shared_lease_against_legacy_import(self):
        entered, release = threading.Event(), threading.Event()

        def blocked_scan(*args):
            entered.set()
            if not release.wait(30):
                raise RuntimeError("fixture synchronization timed out")
            return {"issues": [], "members": deepcopy(self.members)}

        self.scanner.side_effect = blocked_scan
        pending = asyncio.create_task(self.http.put(self.path, headers=self.headers,
            json={"enabled": True, "startedLabel": "处理中"}))
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 15))
            async with self.sessions() as session:
                self.assertIsNone(await session.get(Sync, "catalog"))
                integration = await session.get(models.Integration, "integration")
                with self.assertRaises(resource_leases.LeaseBusy):
                    await aggregation.ingest_one(session, integration, {
                        "external_id": "1", "external_project_id": 149, "title": "Old importer race"})
            self.assertEqual(await self.counts(), (0, 0))
        finally:
            release.set()
        response = await pending
        self.assertEqual(response.status_code, 200, response.text)
        async with self.sessions() as session:
            integration = await session.get(models.Integration, "integration")
            result = await aggregation.ingest_one(session, integration, {
                "external_id": "1", "external_project_id": 149, "title": "Old importer retry"})
            self.assertEqual(result.get("skipped"), "repository_issue_subscription")
        self.assertEqual(await self.counts(), (0, 0))

    async def test_legacy_guard_resolves_stable_project_and_subpath_work_item_urls(self):
        await self.configure()
        async with self.sessions() as session:
            integration = await session.get(models.Integration, "integration")
            integration.config = {**integration.config, "base_url": "https://git.example/nested/gitlab"}
            await session.commit()
            for fields in (
                {"external_project_id": 149, "external_url": "https://git.example/Renamed/repository/-/issues/1"},
                {"external_url": "https://git.example/nested/gitlab/Industrialagents/soduwork/-/issues/1"},
                {"external_url": "https://git.example/nested/gitlab/Industrialagents/soduwork/-/work_items/1"},
                {"ext_repo": "Industrialagents/soduwork"},
            ):
                with self.subTest(fields=fields):
                    result = await aggregation.ingest_one(session, integration,
                        {"external_id": "1", "title": "Must not import", **fields})
                    self.assertEqual(result.get("skipped"), "repository_issue_subscription")
            result = await aggregation.ingest_one(session, integration, {
                "external_id": "100", "external_project_id": 150,
                "external_url": "https://git.example/nested/gitlab/Industrialagents/soduwork/-/issues/100",
                "title": "Stable project identity wins",
            })
            self.assertTrue(result["created"])
        self.assertEqual(await self.counts(), (1, 0))

    async def test_membership_expiry_includes_today_and_excludes_author_grant(self):
        self.members[1]["expires_at"] = T0.date().isoformat()
        self.members[0]["expires_at"] = (T0 + timedelta(days=1)).date().isoformat()
        result = await self.configure()
        members = {row["externalUserId"]: row for row in result["members"]}
        self.assertFalse(members["42"]["active"])
        self.assertTrue(members["114"]["active"])
        response = await self.http.put(self.path + "/members/42", headers=self.headers, json={"userId": "trusted"})
        self.assertEqual(response.status_code, 409, response.text)
        self.clock += timedelta(seconds=10)
        self.issues = [upstream()]
        await self.run_once()
        async with self.sessions() as session:
            task = await session.scalar(select(models.Task))
            self.assertIsNone(task.created_by)

    async def test_awaiting_membership_never_grants_mapping_projection_or_claim(self):
        self.members[1]["membership_state"] = "awaiting"
        self.members[0]["state"] = "awaiting"
        result = await self.configure()
        self.assertTrue(all(not row["active"] for row in result["members"]))
        mapped = await self.http.put(self.path + "/members/42", headers=self.headers, json={"userId": "trusted"})
        self.assertEqual(mapped.status_code, 409, mapped.text)
        self.clock += timedelta(seconds=10)
        self.issues = [upstream()]
        await self.run_once()
        async with self.sessions() as session:
            task = await session.scalar(select(models.Task))
            client = await session.get(models.Client, "trusted-device")
            self.assertIsNone(task.created_by)
            projection = (await access.projection(session, client, [task]))[task.id]
            self.assertFalse(projection["member"])
            self.assertEqual(projection["source"]["relatedUsers"], [])
            self.assertEqual((await access.claim(session, client, task.id))["reason"], "out_of_scope")
            self.assertIsNone(task.owner_client_id)

    async def test_integration_binding_cannot_map_user_from_another_company(self):
        async with self.sessions() as session:
            session.add(models.Client(id="foreign-device", name="Foreign", user_ref="other-manager", auth_state="active"))
            session.add(models.IntegrationBinding(id="foreign-binding", integration_id="integration",
                external_actor="foreign.actor", client_id="foreign-device"))
            await session.commit()
        self.members.append({"id": 55, "username": "foreign.actor", "state": "active"})
        result = await self.configure()
        member = next(row for row in result["members"] if row["externalUserId"] == "55")
        self.assertIsNone(member["userId"])
        self.assertEqual(member["mappingSource"], "")

    async def test_enable_only_imports_new_issues_and_repeat_preserves_manual_fields(self):
        self.issues = [upstream(99, created=T0 - timedelta(days=30))]
        enabled = await self.configure()
        self.assertEqual(enabled["enabledAt"], T0.isoformat())
        self.assertEqual(await self.counts(), (0, 0), "enable probes members, never backfills historical Issues")
        self.clock = T0 + timedelta(seconds=10)
        self.issues = [upstream(99, created=T0 - timedelta(seconds=1)), upstream(), upstream(2, confidential=True)]
        first = await self.run_once()
        self.assertEqual((first["created"], first["skippedConfidential"]), (1, 1))
        async with self.sessions() as session:
            task = await session.scalar(select(models.Task))
            self.assertEqual((task.origin, task.kind, task.status, task.triage_stage), ("gitlab_issue", "requirement", "todo", "intake"))
            self.assertEqual(task.created_by, "trusted")
            self.assertIsNone(task.owner_client_id, "external assignee must not silently become the executor")
            task.title, task.note, task.status = "Local edited title", "Local edited body", "doing"
            await session.commit()
        self.clock += timedelta(seconds=10)
        self.issues = [upstream(title="Upstream changed", description="Upstream changed", state="closed")]
        second = await self.run_once()
        self.assertEqual(second["created"], 0)
        self.assertEqual(await self.counts(), (1, 1))
        async with self.sessions() as session:
            task = await session.scalar(select(models.Task))
            self.assertEqual((task.title, task.note, task.status), ("Local edited title", "Local edited body", "doing"))

    async def test_failed_scan_never_advances_cursor_or_exposes_secret(self):
        await self.configure()
        self.clock += timedelta(seconds=20)
        self.scanner.side_effect = RuntimeError("fixture-secret-must-not-leak")
        response = await self.http.post(self.path + "/run", headers=self.headers)
        self.assertEqual(response.status_code, 409)
        self.assertNotIn("fixture-secret", response.text)
        async with self.sessions() as session:
            row = await session.get(Sync, "catalog")
            self.assertEqual(sync.utc(row.cursor_at), T0)
            self.assertIsNone(row.last_success_at)
            self.assertTrue(row.last_error)
            self.assertNotIn("fixture-secret", row.last_error)
        self.assertEqual(await self.counts(), (0, 0))

    async def test_invalid_second_issue_rolls_back_entire_import_batch(self):
        await self.configure()
        self.clock += timedelta(seconds=10)
        malformed = upstream(2)
        del malformed["id"]
        self.issues = [upstream(), malformed]
        response = await self.http.post(self.path + "/run", headers=self.headers)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(await self.counts(), (0, 0))
        async with self.sessions() as session:
            self.assertEqual(sync.utc((await session.get(Sync, "catalog")).cursor_at), T0)

    async def test_http_failure_status_and_hint_survive_api_and_persisted_error(self):
        await self.configure()
        self.clock += timedelta(seconds=10)
        for code, hint in ((401, "账号认证失效"), (403, "账号权限不足"),
                           (404, "当前账号不可见"), (429, "限流"), (503, "服务暂时异常")):
            with self.subTest(code=code):
                self.scanner.side_effect = sync.remote.GitLabHTTPError(code, "GET")
                response = await self.http.post(self.path + "/run", headers=self.headers)
                self.assertEqual(response.status_code, 409, response.text)
                message = response.json()["detail"]
                self.assertIn(f"HTTP {code}", message)
                self.assertIn(hint, message)
                self.assertNotIn("fixture-secret", message)
                async with self.sessions() as session:
                    row = await session.get(Sync, "catalog")
                    self.assertEqual(row.last_error, message)
                    self.assertEqual(sync.utc(row.cursor_at), T0)
                    self.assertIsNone(row.last_success_at)
        self.assertEqual(await self.counts(), (0, 0))

    async def test_writeback_http_failure_retains_permission_hint_and_retry_state(self):
        task_id = await self.first_import()
        async with self.sessions() as session:
            await access.record_started(session, await session.get(models.Task, task_id))
            link = await session.scalar(select(Link))
            link.next_retry_at = self.clock - timedelta(seconds=1)
            await session.commit()
        self.started.side_effect = sync.remote.GitLabHTTPError(403, "PUT")
        async with self.sessions() as session:
            self.assertEqual(await worker.writebacks(session, "catalog"), 0)
            link = await session.scalar(select(Link))
            self.assertEqual((link.writeback_state, link.writeback_attempts), ("error", 1))
            self.assertIsNotNone(link.next_retry_at)
            self.assertIn("HTTP 403", link.last_error)
            self.assertIn("账号权限不足", link.last_error)
            self.assertIn("执行继续，回写等待重试", link.last_error)
            self.assertNotIn("游标未推进", link.last_error)

    async def test_pause_resume_preserves_original_start_and_catches_paused_interval(self):
        await self.first_import()
        paused_cursor = self.clock
        await self.configure(False)
        calls = self.scanner.call_count
        paused = await self.http.post(self.path + "/run", headers=self.headers)
        self.assertEqual(paused.status_code, 409)
        self.assertEqual(self.scanner.call_count, calls)
        self.clock += timedelta(minutes=5)
        restored = await self.configure(True)
        self.assertEqual(restored["enabledAt"], T0.isoformat())
        async with self.sessions() as session:
            self.assertEqual(sync.utc((await session.get(Sync, "catalog")).cursor_at), paused_cursor)
        self.issues = [upstream(2, created=paused_cursor + timedelta(minutes=1))]
        self.assertEqual((await self.run_once())["created"], 1)
        self.assertEqual(await self.counts(), (2, 2))

    async def test_explicit_identity_mapping_never_uses_name_equality(self):
        response = await self.configure()
        members = {item["externalUserId"]: item for item in response["members"]}
        self.assertIsNone(members["114"]["userId"])
        self.assertEqual((members["42"]["userId"], members["42"]["mappingSource"]), ("trusted", "integration"))
        mapped = await self.http.put(self.path + "/members/114", headers=self.headers, json={"userId": "same-name"})
        self.assertEqual(mapped.status_code, 200, mapped.text)
        self.clock += timedelta(seconds=10)
        await self.run_once()
        async with self.sessions() as session:
            member = await session.get(Member, ("catalog", "114"))
            self.assertEqual((member.user_id, member.mapping_source), ("same-name", "manual"))
        self.members = [self.members[1]]
        await self.run_once()
        async with self.sessions() as session:
            self.assertFalse((await session.get(Member, ("catalog", "114"))).active)

    async def test_http_requires_permission_and_rejects_cross_org_catalog_and_mapping(self):
        await self.configure()
        methods = [("get", self.path, None), ("put", self.path, {"enabled": False}),
            ("post", self.path + "/run", None), ("put", self.path + "/members/114", {"userId": "trusted"})]
        for user_id, status in [(None, 401), ("same-name", 403), ("other-manager", 403)]:
            headers = {} if user_id is None else {"Authorization": "Bearer " + sign_token(user_id)}
            for method, url, body in methods:
                with self.subTest(user=user_id, method=method, url=url):
                    response = await self.http.request(method, url, headers=headers, json=body)
                    self.assertEqual(response.status_code, status, response.text)
        foreign = self.path.replace("/catalog/", "/other-catalog/")
        self.assertEqual((await self.http.get(foreign, headers=self.headers)).status_code, 403)
        for target in ["other-manager", "inactive", "missing"]:
            response = await self.http.put(self.path + "/members/114", headers=self.headers, json={"userId": target})
            self.assertEqual(response.status_code, 409, response.text)
        async with self.sessions() as session:
            self.assertIsNone((await session.get(Member, ("catalog", "114"))).user_id)

    async def test_http_validation_does_not_enable_or_contact_source(self):
        for body in [{"enabled": "true"}, {"enabled": True, "startedLabel": "status::doing"},
                     {"enabled": True, "startedLabel": "a,b"}, {"enabled": True, "startedLabel": ""}]:
            response = await self.http.put(self.path, headers=self.headers, json=body)
            self.assertEqual(response.status_code, 422)
        self.scanner.assert_not_called()
        async with self.sessions() as session:
            self.assertIsNone(await session.get(Sync, "catalog"))

    async def test_manual_and_automatic_runs_share_lease_and_database_unique_identity(self):
        await self.configure()
        entered, release = threading.Event(), threading.Event()
        def blocked_scan(*args):
            entered.set()
            if not release.wait(8):
                raise RuntimeError("fixture synchronization timed out")
            return {"issues": [upstream()], "members": deepcopy(self.members)}
        self.clock += timedelta(seconds=10)
        self.scanner.side_effect = blocked_scan
        pending = asyncio.create_task(self.http.post(self.path + "/run", headers=self.headers))
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 5))
            async with self.sessions() as session:
                with self.assertRaises(resource_leases.LeaseBusy):
                    await sync.run(session, "catalog")
            response = await self.http.post(self.path + "/run", headers=self.headers)
            self.assertEqual(response.status_code, 423, response.text)
        finally:
            release.set()
        response = await pending
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(await self.counts(), (1, 1))
        async with self.sessions() as session:
            original = await session.scalar(select(Link))
            session.add(Link(catalog_id="catalog", issue_iid=original.issue_iid,
                issue_id="another-id", task_id="another-task"))
            with self.assertRaises(IntegrityError):
                await session.commit()
            await session.rollback()
        async with self.sessions() as session:
            result = await sync.run(session, "catalog")
            self.assertEqual(result["skipped"], "not_due")

    async def test_source_uses_one_fresh_query_per_operation_under_pressure(self):
        queries = []
        def record(_connection, _cursor, statement, _parameters, _context, _many):
            if statement.lstrip().upper().startswith("SELECT"):
                queries.append(statement)
        event.listen(self.engine.sync_engine, "before_cursor_execute", record)
        try:
            async with self.sessions() as session:
                for _ in range(100):
                    repo, cfg = await sync.source(session, "catalog")
                    self.assertEqual(repo.external_id, "149")
                    self.assertEqual(cfg["_auth_user"], "fixture-account")
                self.assertEqual(len(queries), 100)
        finally:
            event.remove(self.engine.sync_engine, "before_cursor_execute", record)

    async def test_source_observes_revocation_and_rotation_despite_retained_identity_map(self):
        async with self.sessions() as session:
            repo, cfg = await sync.source(session, "catalog")
            integration = await session.get(models.Integration, "integration")
            await session.commit()
            async with self.sessions() as other:
                row = await other.get(models.Integration, "integration")
                row.config = {**row.config, "pullAuth": {"user": "rotated", "secret": "new-test-secret"}}
                await other.commit()
            _, cfg = await sync.source(session, "catalog")
            self.assertEqual(cfg["_auth_user"], "rotated")
            await session.commit()
            async with self.sessions() as other:
                await other.execute(update(am.ScmRepository).where(am.ScmRepository.id == repo.id).values(archived=True))
                await other.commit()
            with self.assertRaises(ValueError):
                await sync.source(session, "catalog")
            self.assertTrue(repo.archived)
            self.assertEqual(integration.config["pullAuth"]["user"], "rotated")

    async def test_writeback_stops_new_remote_writes_after_subscription_paused_mid_batch(self):
        await self.first_import()
        async with self.sessions() as session:
            first = await session.scalar(select(Link))
            first.started_at = self.clock
            first.writeback_state = "pending"
            session.add(Link(id="next-writeback", catalog_id="catalog", issue_id="1002", issue_iid=2,
                task_id=first.task_id + "-second", started_at=self.clock + timedelta(seconds=1), writeback_state="pending"))
            session.add(models.Task(id=first.task_id + "-second", title="Second isolated issue"))
            await session.commit()
        original = sync.call_remote
        async def remote_then_pause(session, lease, method, *args):
            result = await original(session, lease, method, *args)
            async with self.sessions() as other:
                await other.execute(update(Sync).where(Sync.catalog_id == "catalog").values(enabled=False))
                await other.commit()
            return result
        with patch.object(sync, "call_remote", side_effect=remote_then_pause):
            async with self.sessions() as session:
                self.assertEqual(await worker.writebacks(session, "catalog"), 1)
                second = await session.get(Link, "next-writeback")
                self.assertEqual(second.writeback_state, "error")
                self.assertIsNone(second.sent_at)
        self.assertEqual(self.started.call_count, 1)

    async def test_first_start_is_transactional_frozen_and_retries_to_sent_once(self):
        task_id = await self.first_import()
        async with self.sessions() as session:
            task = await session.get(models.Task, task_id)
            self.assertTrue(await access.record_started(session, task))
            await session.rollback()
        async with self.sessions() as session:
            self.assertEqual((await session.scalar(select(Link))).writeback_state, "waiting")
            task = await session.get(models.Task, task_id)
            self.assertTrue(await access.record_started(session, task))
            await session.commit()
            link = await session.scalar(select(Link))
            link.next_retry_at = self.clock - timedelta(seconds=1)
            first_start = link.started_at
            self.assertEqual(link.writeback_label, "处理中")
            config = await session.get(Sync, "catalog")
            config.started_label = "Changed after start"
            await session.commit()
        self.started.side_effect = RuntimeError("fixture-secret")
        async with self.sessions() as session:
            self.assertEqual(await worker.writebacks(session, "catalog"), 0)
            link = await session.scalar(select(Link))
            self.assertEqual((link.writeback_state, link.writeback_attempts), ("error", 1))
            self.assertNotIn("fixture-secret", link.last_error)
        self.clock += timedelta(seconds=61)
        self.started.side_effect = None
        self.started.return_value = {"ok": True}
        async with self.sessions() as session:
            self.assertEqual(await worker.writebacks(session, "catalog"), 1)
            task = await session.get(models.Task, task_id)
            task.status = "done"
            self.assertFalse(await access.record_started(session, task))
            await session.commit()
        async with self.sessions() as session:
            self.assertEqual(await worker.writebacks(session, "catalog"), 0)
            link = await session.scalar(select(Link))
            self.assertEqual((link.writeback_state, link.writeback_attempts, link.started_at), ("sent", 2, first_start))
            self.assertEqual((await session.get(models.Task, task_id)).status, "done")
        self.assertEqual(self.started.call_count, 2)
        self.assertEqual(self.started.call_args.args[-1], "处理中")

    async def test_closed_upstream_manual_and_pause_never_rewrite_local_later_state(self):
        task_id = await self.first_import()
        await self.configure(False)
        async with self.sessions() as session:
            task = await session.get(models.Task, task_id)
            task.status = "doing"
            self.assertTrue(await access.record_started(session, task))
            await session.commit()
            link = await session.scalar(select(Link))
            link.next_retry_at = self.clock - timedelta(seconds=1)
            await session.commit()
            self.assertEqual(await worker.writebacks(session, "catalog"), 0)
        self.started.assert_not_called()
        await self.configure(True)
        self.started.return_value = {"ok": False, "manual": True, "reason": "issue_closed"}
        async with self.sessions() as session:
            self.assertEqual(await worker.writebacks(session, "catalog"), 0)
            self.assertEqual((await session.scalar(select(Link))).writeback_state, "manual")
            self.assertEqual((await session.get(models.Task, task_id)).status, "doing")
        async with self.sessions() as session:
            self.assertEqual(await worker.writebacks(session, "catalog"), 0)
        self.assertEqual(self.started.call_count, 1)

    async def test_unconfirmed_writeback_retries_then_enters_manual_at_limit(self):
        task_id = await self.first_import()
        async with self.sessions() as session:
            await access.record_started(session, await session.get(models.Task, task_id))
            await session.commit()
        self.started.return_value = {"ok": False}
        for attempt in range(1, 6):
            async with self.sessions() as session:
                link = await session.scalar(select(Link))
                link.next_retry_at = self.clock - timedelta(seconds=1)
                await session.commit()
                await worker.writebacks(session, "catalog")
                await session.refresh(link)
                self.assertEqual(link.writeback_attempts, attempt)
                self.assertEqual(link.writeback_state, "manual" if attempt == 5 else "error")
        async with self.sessions() as session:
            await worker.writebacks(session, "catalog")
        self.assertEqual(self.started.call_count, 5)


class RepositoryIssueWorkerSchedulingTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_repository_stays_single_flight_while_next_tick_runs_completed_repository(self):
        # Exercise the actual loop with controlled minute boundaries. Only its
        # repository job and catalog lookup are replaced; no wall-clock wait.
        release_next_tick = asyncio.Event()
        first_fast_done = asyncio.Event()
        second_fast_done = asyncio.Event()
        slow_cancelled = asyncio.Event()
        never = asyncio.Event()
        calls = {"slow": 0, "fast": 0}
        waits = []

        async def minute_boundary(delay):
            waits.append(delay)
            if len(waits) == 1:
                await release_next_tick.wait()
            else:
                await never.wait()

        async def repository_job(catalog_id, limit):
            async with limit:
                calls[catalog_id] += 1
                if catalog_id == "slow":
                    try:
                        await never.wait()
                    finally:
                        slow_cancelled.set()
                elif calls["fast"] == 1:
                    first_fast_done.set()
                else:
                    second_fast_done.set()

        with patch.object(worker, "enabled_ids", return_value=["slow", "fast"]), \
             patch.object(worker, "one", side_effect=repository_job), \
             patch.object(worker.asyncio, "sleep", side_effect=minute_boundary):
            loop = asyncio.create_task(worker.tick_loop())
            try:
                await asyncio.wait_for(first_fast_done.wait(), timeout=5)
                self.assertEqual(calls, {"slow": 1, "fast": 1})
                release_next_tick.set()
                await asyncio.wait_for(second_fast_done.wait(), timeout=5)
                self.assertEqual(calls, {"slow": 1, "fast": 2})
                self.assertEqual(len(waits), 2)
                self.assertTrue(all(1 <= delay <= 60 for delay in waits))
            finally:
                loop.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await loop
            self.assertTrue(slow_cancelled.is_set(), "loop cancellation must drain its in-flight jobs")


if __name__ == "__main__":
    unittest.main()
