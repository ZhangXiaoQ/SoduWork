"""Real isolated HTTP/DB authorization; fake sockets never contact a host."""
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import test_cloud_personal_environments as fixtures
from app import auth, db, models
from app.api import runner_ws
from app.automation_models import RunnerNode
from app.services import cluster_runtime, runner_hub, runner_registry
from app.services.runner_access_policy import (RunnerAccessDenied, authenticated_identity,
    acquire_runner_policy_lock, require_personal_mutation)


class PersonalRunnerAccessTests(unittest.IsolatedAsyncioTestCase):
    live = fixtures.PersonalCloudEnvironmentTests.live

    async def asyncSetUp(self):
        await fixtures.PersonalCloudEnvironmentTests.asyncSetUp(self)
        self.app.include_router(runner_ws.router)
        async with db.SessionLocal() as session:
            role = models.Role(id=self.prefix + "-role", name="Host manager", permissions=["runner.manage"])
            session.add(role)
            (await session.get(models.User, self.user_id)).role_id = role.id
            await session.commit()
        self.admin_headers = {"Authorization": "Bearer " + auth.sign_token(self.user_id)}
        response = await self.http.post("/api/v1/cloud-environments", json={
            "name": "Personal test host", "hub": "https://soduwork.example.test"})
        self.assertEqual(response.status_code, 200, response.text)
        self.rid, self.key = response.json()["environment"]["id"], response.json()["setup"]["key"]

    async def asyncTearDown(self):
        await fixtures.PersonalCloudEnvironmentTests.asyncTearDown(self)

    async def state(self, value):
        async with db.SessionLocal() as session:
            row = await session.get(RunnerNode, self.rid)
            row.management_state = value
            row.dispatch_mode = "disabled" if value else "accepting"
            await session.commit()

    def connected(self):
        node = self.live("connected")
        runner_hub._RUNNERS.pop(node.id)
        node.id, node.owner_user_id = self.rid, self.user_id
        node.ws = AsyncMock()
        async def send(packet):
            if packet.get("id"):
                node.resolve(packet["id"], {"ok": True, "data": {"delivered": True}})
        node.ws.send_json.side_effect = send
        runner_hub._RUNNERS[self.rid] = node
        return node

    async def test_owner_cannot_undo_admin_state_or_delete_tombstone(self):
        path = "/api/v1/cloud-environments/" + self.rid
        for state in ("disabled", "pending_setup", "retired"):
            await self.state(state)
            self.assertEqual((await self.http.patch(path, json={"mode": "accepting"})).status_code, 409)
            self.assertEqual((await self.http.post(path + "/credentials", json={})).status_code, 409)
            self.assertEqual((await self.http.delete(path)).status_code, 409)
            listed = (await self.http.get("/api/v1/cloud-environments")).json()["environments"][0]
            self.assertEqual(listed["managementState"], state)
            self.assertFalse(listed["canManage"])
            self.assertFalse(listed["credential"]["canRotate"])
            self.assertFalse(listed["eligible"])

    async def test_generic_admin_routes_cannot_bypass_reprovision(self):
        for state in ("disabled", "pending_setup", "retired"):
            await self.state(state)
            path = "/api/v1/admin/runners/" + self.rid
            for suffix in ("/issue-key", "/mode"):
                response = await self.http.post(path + suffix, headers=self.admin_headers,
                                                json={"mode": "accepting", "orgId": self.org})
                self.assertIn(response.status_code, (404, 409), response.text)
            response = await self.http.delete(path, headers=self.admin_headers)
            self.assertIn(response.status_code, (404, 409), response.text)
        async with db.SessionLocal() as session:
            self.assertIsNotNone(await session.get(RunnerNode, self.rid))

    async def test_single_hub_blocks_stale_cache_before_sending_bytes(self):
        node = self.connected()
        await self.state("disabled")
        # Deliberately retain stale accepting mode/empty management on the socket.
        self.assertEqual(node.management_state, "")
        for op in ("job.dispatch", "job.comment", "agent.install", "mcp.call", "term.open"):
            result = await node.call(op, {"ref": "old-session"}, timeout=.1)
            self.assertFalse(result["ok"], op)
            self.assertFalse(result.get("uncertain"), op)
        node.ws.send_json.assert_not_called()
        with self.assertRaises(RunnerAccessDenied):
            await node.send({"op": "term.in", "data": "unwanted command"})
        for op in ("session.ack", "session.nack", "job.status", "job.session", "job.file", "job.stop", "runner.probe",
                   "content.put", "content.seal", "content.read"):
            self.assertTrue((await node.call(op, {}, timeout=.1))["ok"], op)

    async def test_retired_socket_cannot_read_or_receive_any_operation(self):
        node = self.connected()
        await self.state("retired")
        for op in ("job.status", "job.file", "job.comment", "job.stop", "runner.probe", "content.put", "content.seal", "content.read"):
            self.assertFalse((await node.call(op, {}, timeout=.1))["ok"], op)
        node.ws.send_json.assert_not_called()
        async with db.SessionLocal() as session:
            self.assertFalse(await runner_registry.verify_key(session, self.rid, self.key))
            with self.assertRaises(ValueError):
                await runner_registry.issue_key(session, self.rid, org_id=self.org)
            with self.assertRaises(ValueError):
                await runner_registry.record(session, node, force=True)
            with self.assertRaises(ValueError):
                await runner_registry.set_mode(session, self.rid, "accepting")

    async def test_pending_identity_cannot_connect_or_reissue_key(self):
        async with db.SessionLocal() as session:
            self.assertFalse(await authenticated_identity(session, self.rid, "", ""))
            self.assertFalse(await authenticated_identity(session, self.rid, "another-runner", self.key))
            self.assertTrue(await authenticated_identity(session, self.rid, self.rid, self.key))
        await self.state("pending_setup")
        async with db.SessionLocal() as session:
            self.assertFalse(await runner_registry.verify_key(session, self.rid, self.key))
            with self.assertRaises(ValueError):
                await runner_registry.issue_key(session, self.rid, owner_user_id=self.user_id)
            self.assertFalse(await authenticated_identity(session, self.rid, self.rid, self.key))

    async def test_inventory_admin_scope_and_retired_live_backfill(self):
        node = self.connected()
        foreign_id = self.prefix + "-foreign-runner"
        async with db.SessionLocal() as session:
            session.add(RunnerNode(id=foreign_id, org_id=self.foreign_org,
                owner_user_id=self.prefix + "-foreign-owner"))
            await session.commit()
        response = await self.http.get("/api/v1/admin/runners", headers=self.admin_headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn(self.rid, response.text)
        self.assertNotIn(foreign_id, response.text)
        self.assertNotIn(self.key, response.text)
        async with db.SessionLocal() as session:
            legacy = await runner_registry.list_nodes(session, {self.client_id}, {self.org})
            self.assertNotIn(self.rid, [x["runnerId"] for x in legacy])
        await self.state("retired")
        # Tombstone remains omitted even when an old cache calls it shared.
        node.owner_user_id = ""
        response = await self.http.get("/api/v1/admin/runners", headers=self.admin_headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn(self.rid, response.text)

    async def test_desktop_inventory_is_personal_even_for_an_administrator(self):
        foreign_owner = self.prefix + "-foreign-owner"
        async with db.SessionLocal() as session:
            (await session.get(models.User, self.user_id)).is_super = True
            session.add_all([
                RunnerNode(id=self.prefix + "-desktop-own", client_id=self.client_id,
                           org_id=self.org, tags=[runner_hub.CLIENT_TAG]),
                RunnerNode(id=self.prefix + "-desktop-other", client_id=self.foreign_client_id,
                           org_id=self.org, tags=[runner_hub.CLIENT_TAG]),
                RunnerNode(id=self.prefix + "-shared", client_id="", org_id=self.org),
                RunnerNode(id=self.prefix + "-foreign-owner", client_id=self.client_id,
                           owner_user_id=foreign_owner, org_id=self.org,
                           tags=[runner_hub.CLIENT_TAG]),
            ])
            await session.commit()
        response = await self.http.get("/api/v1/runners")
        self.assertEqual(response.status_code, 200, response.text)
        rows = response.json()["runners"]
        self.assertEqual({row["runnerId"] for row in rows},
                         {self.rid, self.prefix + "-desktop-own"})
        self.assertTrue(all(row["owned"] and row["manageable"] for row in rows))
        self.assertNotIn(self.foreign_client_id, response.text)
        self.assertNotIn(foreign_owner, response.text)

    async def test_cluster_envelope_rejects_previous_owner(self):
        node = self.connected()
        node.cluster_token = "fixture-token"
        payload = {"runner": self.rid, "token": node.cluster_token,
                   "client": "", "org": self.org, "owner": "previous-owner",
                   "op": "job.comment", "data": {}, "timeout": .1}
        with patch.object(cluster_runtime, "check_owner", new=AsyncMock()):
            result = await cluster_runtime.on_request("runner.call", payload, "other-hub")
            self.assertEqual(result["code"], "RUNNER_SCOPE_CHANGED")
            payload["owner"] = self.user_id
            await self.state("disabled")
            result = await cluster_runtime.on_request("runner.call", payload, "other-hub")
            self.assertEqual(result["code"], "RUNNER_MANAGEMENT_RESTRICTED")
            payload.update(op="$policy", data={"mode": "accepting", "managementState": ""})
            result = await cluster_runtime.on_request("runner.call", payload, "other-hub")
            self.assertTrue(result["ok"])
            self.assertEqual(node.management_state, "disabled")
            self.assertEqual(node.dispatch_mode, "disabled")
        node.ws.send_json.assert_not_called()

    async def test_remote_proxy_transports_personal_owner(self):
        proxy = cluster_runtime.RemoteRunner("other-hub", {
            "runnerId": self.rid, "clusterToken": "fixture-token", "orgId": self.org,
            "ownerUserId": self.user_id, "managementState": "disabled"})
        with patch.object(cluster_runtime.bus, "request", new=AsyncMock(return_value={"ok": True})) as request:
            self.assertTrue((await proxy.call("runner.probe", {}))["ok"])
            self.assertEqual(request.call_args.args[2]["owner"], self.user_id)
        self.assertEqual(proxy.management_state, "disabled")

    async def test_sqlite_policy_lock_refreshes_an_earlier_owner_snapshot(self):
        from app.services.cloud_environments import _own_row
        async with db.SessionLocal() as session:
            stale = await session.get(RunnerNode, self.rid)
            self.assertEqual(stale.management_state, "")
            await self.state("disabled")
            current = await _own_row(session, self.user_id, self.rid, lock=True)
            self.assertIs(current, stale)
            self.assertEqual(current.management_state, "disabled")
            with self.assertRaises(HTTPException) as error:
                require_personal_mutation(current)
            self.assertEqual(error.exception.status_code, 409)

    async def test_sqlite_busy_policy_lock_never_sends_to_socket(self):
        node = self.connected()
        blocked_engine = create_async_engine(db.engine.url, connect_args={"timeout": .01})
        blocked_sessions = async_sessionmaker(blocked_engine, expire_on_commit=False)
        try:
            async with db.SessionLocal() as holder:
                await acquire_runner_policy_lock(holder, self.rid)
                with patch.object(db, "SessionLocal", blocked_sessions):
                    with self.assertRaises(OperationalError):
                        await node.send({"op": "term.in", "data": "must not be sent"})
                node.ws.send_json.assert_not_called()
        finally:
            await blocked_engine.dispose()


if __name__ == "__main__":
    unittest.main()
