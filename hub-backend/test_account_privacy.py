"""Isolated account privacy HTTP, storage and authorization regression tests."""
import asyncio
import base64
import io
import json
import hashlib
import unittest
import zipfile
import threading
from datetime import timedelta
from unittest.mock import AsyncMock, patch

# Reuse the isolated account fixture's environment before importing application modules.
import test_email_auth as auth_fixture
from PIL import Image
from fastapi import Depends
from sqlalchemy import delete, event, select, update
from sqlalchemy.orm import Session
from app.account_models import EmailChallenge
from app.account_privacy_models import AccountActionGrant, AccountPrivacyRequest
from app.api import account_profile, admin as admin_api
from app.auth import verify_password
from app.automation_models import PluginInstallation, RunnerNode
from app.db import Base, SessionLocal, engine
from app import im_models as im
from app.library_models import LibraryFolder, LibraryItem
from app.memory_record_models import MemoryRecord
from app.models import AiSchedule, AuditLog, Client, DailyReport, IdentityLink, Task, User
from app.session_memory_models import SessionMemory
from app.services import account_mail, account_privacy, account_security, device_auth, device_connections, email_auth, runner_hub

auth_fixture.app.include_router(account_profile.router)
auth_fixture.app.include_router(account_profile.admin_router)
auth_fixture.app.include_router(admin_api.router)


@auth_fixture.app.get("/_test/account-owner")
async def authenticated_account_owner(user=Depends(auth_fixture.current_user)):
    return {"id": user.id}


EXTRA = [AccountActionGrant.__table__, AccountPrivacyRequest.__table__, LibraryFolder.__table__,
         LibraryItem.__table__, MemoryRecord.__table__, SessionMemory.__table__, PluginInstallation.__table__,
         IdentityLink.__table__, DailyReport.__table__, AiSchedule.__table__, RunnerNode.__table__, Task.__table__]
EXTRA += [model.__table__ for model in (im.IMConnection, im.IMPairing, im.IMWebhookReceipt,
                                      im.IMBinding, im.IMRoute, im.IMInbox, im.IMOutbox)]


class AccountPrivacyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await auth_fixture.EmailAuthTests.asyncSetUp(self)
        async with engine.begin() as conn:
            await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=EXTRA))
            for table in reversed(EXTRA):
                await conn.execute(delete(table))
        self.result, self.proof_used = await auth_fixture.EmailAuthTests.register(self)
        self.uid = self.result["user"]["id"]
        self.headers = {"Authorization": "Device " + self.result["session"]}

    async def asyncTearDown(self):
        await auth_fixture.EmailAuthTests.asyncTearDown(self)

    post = auth_fixture.EmailAuthTests.post
    proof = auth_fixture.EmailAuthTests.proof

    async def call(self, method, path, body=None, headers=None):
        return await self.http.request(method, "/api/v1/client-auth" + path,
            headers=headers or self.headers, **({"json": body} if body is not None else {}))

    async def verify(self, purpose):
        response = await self.call("POST", "/me/verification", {
            "purpose": purpose, "password": "Original-password-123"})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["verificationToken"]

    async def challenge(self, purpose, email=None):
        response = await self.call("POST", "/me/email-challenges", {"purpose": purpose, **({"email":email} if email else {})})
        self.assertEqual(response.status_code, 200, response.text)
        challenge_id = response.json()["challengeId"]
        async with SessionLocal() as session:
            mail = await session.scalar(select(auth_fixture.MailOutbox).where(
                auth_fixture.MailOutbox.challenge_id == challenge_id))
            code = account_mail.unseal(mail.payload_encrypted)["code"]
        return {"challengeId": challenge_id, "code": code}

    async def password_grant(self):
        proof = await self.challenge("reauthentication")
        response = await self.call("POST", "/me/verification", {"purpose": "change_password", **proof})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["verificationToken"]

    async def assert_password_grant_unused(self, token):
        async with SessionLocal() as session:
            grant = await session.scalar(select(AccountActionGrant).where(
                AccountActionGrant.token_hash == hashlib.sha256(token.encode()).hexdigest()))
            self.assertIsNone(grant.consumed_at)
            user = await session.get(User, self.uid)
            self.assertTrue(verify_password("Original-password-123", user.password_hash))
        self.assertEqual((await self.call("GET", "/me")).status_code, 200)

    async def test_email_code_password_change_does_not_require_original_password(self):
        proof = await self.proof(purpose="login")
        login = await self.post("/login/email-code", proof)
        self.assertEqual(login.status_code, 200, login.text)
        self.assertTrue(login.json()["user"]["hasPassword"])
        self.headers = {"Authorization": "Device " + login.json()["session"]}
        other = await self.post("/login/password", {"email": "person@example.test",
            "password": "Original-password-123"}, device=2)
        self.assertEqual(other.status_code, 200, other.text)
        token = await self.password_grant()
        changed = await self.call("POST", "/change-password", {
            "verificationToken": token, "newPassword": "Changed-password-456"})
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertTrue(changed.json()["logoutRequired"])
        self.assertEqual(changed.json()["signedOutDevices"], 2)
        for session_token in (login.json()["session"], other.json()["session"]):
            response = await self.call("GET", "/me", headers={"Authorization": "Device " + session_token})
            self.assertIn(response.status_code, (401, 403))
        old = await self.post("/login/password", {"email": "person@example.test",
            "password": "Original-password-123"})
        self.assertEqual(old.status_code, 401)
        fresh = await self.post("/login/password", {"email": "person@example.test",
            "password": "Changed-password-456"})
        self.assertEqual(fresh.status_code, 200, fresh.text)
        self.headers = {"Authorization": "Device " + fresh.json()["session"]}
        replay = await self.call("POST", "/change-password", {
            "verificationToken": token, "newPassword": "Another-password-789"})
        self.assertEqual(replay.status_code, 403, replay.text)
        async with SessionLocal() as session:
            grant = await session.scalar(select(AccountActionGrant).where(
                AccountActionGrant.token_hash == hashlib.sha256(token.encode()).hexdigest()))
            self.assertIsNotNone(grant.consumed_at)
            audit = await session.scalar(select(AuditLog).where(AuditLog.action == "client.password.change"))
            self.assertEqual(audit.detail, {"signedOutDevices": 2})

    async def test_email_code_account_without_hash_can_set_password(self):
        async with SessionLocal() as session:
            await session.execute(update(User).where(User.id == self.uid).values(password_hash=""))
            await session.commit()
        self.assertFalse((await self.call("GET", "/me")).json()["user"]["hasPassword"])
        token = await self.password_grant()
        changed = await self.call("POST", "/change-password", {
            "verificationToken": token, "newPassword": "First-password-456"})
        self.assertEqual(changed.status_code, 200, changed.text)
        login = await self.post("/login/password", {"email": "person@example.test",
            "password": "First-password-456"})
        self.assertEqual(login.status_code, 200, login.text)
        self.assertTrue(login.json()["user"]["hasPassword"])

    async def test_password_validation_does_not_consume_identity_grant(self):
        token = await self.password_grant()
        for password in ("Ab1", "Original-password-123"):
            with self.subTest(password=password):
                response = await self.call("POST", "/change-password", {
                    "verificationToken": token, "newPassword": password})
                self.assertEqual(response.status_code, 422, response.text)
                await self.assert_password_grant_unused(token)
        changed = await self.call("POST", "/change-password", {
            "verificationToken": token, "newPassword": "Changed-password-456"})
        self.assertEqual(changed.status_code, 200, changed.text)

    async def test_password_change_requires_exactly_one_identity_proof(self):
        token = await self.verify("export")
        for proof in ({}, {"currentPassword": "Original-password-123", "verificationToken": token}):
            response = await self.call("POST", "/change-password", {
                **proof, "newPassword": "Changed-password-456"})
            self.assertEqual(response.status_code, 422, response.text)
            await self.assert_password_grant_unused(token)

    async def test_invalid_password_grant_cannot_probe_the_current_password(self):
        for guessed_password in ("Original-password-123", "Different-password-456"):
            response = await self.call("POST", "/change-password", {
                "verificationToken": "invalid-verification-token-with-enough-length",
                "newPassword": guessed_password})
            self.assertEqual(response.status_code, 403, response.text)
            self.assertEqual(response.json()["detail"]["code"], "VERIFICATION_EXPIRED")
        self.assertEqual((await self.call("GET", "/me")).status_code, 200)

    async def test_password_change_rejects_other_purpose_device_and_account_grants(self):
        wrong_purpose = await self.verify("export")
        rejected = await self.call("POST", "/change-password", {
            "verificationToken": wrong_purpose, "newPassword": "Changed-password-456"})
        self.assertEqual(rejected.status_code, 403, rejected.text)
        await self.assert_password_grant_unused(wrong_purpose)
        token = await self.password_grant()
        second = await self.post("/login/password", {"email": "person@example.test",
            "password": "Original-password-123"}, device=2)
        response = await self.call("POST", "/change-password", {
            "verificationToken": token, "newPassword": "Changed-password-456"},
            headers={"Authorization": "Device " + second.json()["session"]})
        self.assertEqual(response.status_code, 403, response.text)
        await self.assert_password_grant_unused(token)
        other, _ = await auth_fixture.EmailAuthTests.register(self, email="other@example.test", device=2)
        response = await self.call("POST", "/change-password", {
            "verificationToken": token, "newPassword": "Changed-password-456"},
            headers={"Authorization": "Device " + other["session"]})
        self.assertEqual(response.status_code, 403, response.text)
        await self.assert_password_grant_unused(token)

    async def test_password_change_rejects_expired_and_stale_version_grants(self):
        token = await self.password_grant()
        async with SessionLocal() as session:
            grant = await session.scalar(select(AccountActionGrant).where(
                AccountActionGrant.token_hash == hashlib.sha256(token.encode()).hexdigest()))
            original = (grant.expires_at, grant.user_auth_version, grant.client_auth_version)
        for values in ({"expires_at": email_auth.now()-timedelta(seconds=1)},
                       {"user_auth_version": original[1]+1}, {"client_auth_version": original[2]+1}):
            async with SessionLocal() as session:
                await session.execute(update(AccountActionGrant).values(expires_at=original[0],
                    user_auth_version=original[1], client_auth_version=original[2]))
                await session.execute(update(AccountActionGrant).values(**values))
                await session.commit()
            response = await self.call("POST", "/change-password", {
                "verificationToken": token, "newPassword": "Changed-password-456"})
            self.assertEqual(response.status_code, 403, response.text)
            await self.assert_password_grant_unused(token)

    async def test_password_change_audit_failure_rolls_back_password_grant_and_devices(self):
        token = await self.password_grant()
        def fail_password_audit(session, flush_context, instances):
            if any(isinstance(row, AuditLog) and row.action == "client.password.change" for row in session.new):
                raise RuntimeError("isolated password audit failure")
        event.listen(Session, "before_flush", fail_password_audit)
        try:
            with self.assertRaisesRegex(RuntimeError, "isolated password audit failure"):
                await self.call("POST", "/change-password", {
                    "verificationToken": token, "newPassword": "Changed-password-456"})
        finally:
            event.remove(Session, "before_flush", fail_password_audit)
        await self.assert_password_grant_unused(token)

    async def test_password_change_channel_failure_does_not_report_committed_change_as_failed(self):
        token = await self.password_grant()
        with patch.object(device_connections, "disconnect", side_effect=RuntimeError("isolated channel failure")):
            response = await self.call("POST", "/change-password", {
                "verificationToken": token, "newPassword": "Changed-password-456"})
        self.assertEqual(response.status_code, 200, response.text)
        login = await self.post("/login/password", {"email": "person@example.test",
            "password": "Changed-password-456"})
        self.assertEqual(login.status_code, 200, login.text)

    async def test_profile_changes_allowlisted_and_avatar_sanitized(self):
        image = Image.new("RGB", (30, 40), "red")
        data = io.BytesIO(); image.save(data, format="PNG", comment=b"private comment")
        result = await self.call("PATCH", "/me", {"displayName": "新昵称",
            "avatarDataUrl": "data:image/png;base64," + base64.b64encode(data.getvalue()).decode()})
        self.assertEqual(result.status_code, 200, result.text)
        user = result.json()["user"]
        self.assertEqual(user["displayName"], "新昵称")
        raw = base64.b64decode(user["avatarUrl"].split(",")[1])
        with Image.open(io.BytesIO(raw)) as sanitized:
            self.assertEqual(sanitized.size, (256, 256))
            self.assertNotIn("comment", sanitized.info)
        self.assertEqual((await self.call("PATCH", "/me", {"isSuper": True})).status_code, 422)
        self.assertEqual((await self.call("PATCH", "/me", {"avatarDataUrl": "data:image/svg+xml;base64,abcd"})).status_code, 422)
        self.assertEqual((await self.call("PATCH", "/me", {"displayName": "  "})).status_code, 422)

    async def test_inflight_profile_cannot_restore_deleted_identity(self):
        entered, release = threading.Event(), threading.Event()
        def slow_avatar(_):
            entered.set()
            if not release.wait(10):
                raise RuntimeError("test synchronization timed out")
            return "data:image/png;base64,old-profile"
        with patch.object(account_security, "sanitize_avatar", side_effect=slow_avatar):
            pending = asyncio.create_task(self.call("PATCH", "/me", {"displayName":"old request", "avatarDataUrl":""}))
            self.assertTrue(await asyncio.to_thread(entered.wait, 10))
            try:
                async with SessionLocal() as session:
                    await session.execute(update(User).where(User.id == self.uid).values(
                        is_active=False, account_deleted_at=account_privacy.now(),
                        auth_version=User.auth_version+1, display_name="已注销用户", avatar_url=""))
                    await session.commit()
            finally:
                release.set()
            self.assertEqual((await pending).status_code, 401)
        async with SessionLocal() as session:
            user = await session.get(User, self.uid)
            self.assertEqual(user.display_name, "已注销用户")
            self.assertEqual(user.avatar_url, "")

    async def test_wrong_password_and_purpose_grant_reuse_are_rejected(self):
        bad = await self.call("POST", "/me/verification", {"purpose": "export", "password": "incorrect"})
        self.assertEqual(bad.status_code, 403)
        token = await self.verify("devices")
        self.assertEqual((await self.call("POST", "/me/exports", {"verificationToken": token})).status_code, 403)
        token = await self.verify("export")
        self.assertEqual((await self.call("POST", "/me/exports", {"verificationToken": token})).status_code, 202)
        self.assertEqual((await self.call("POST", "/me/exports", {"verificationToken": token})).status_code, 403)

    async def test_email_identity_verification_is_one_time(self):
        proof = await self.challenge("reauthentication")
        body = {"purpose": "export", **proof}
        self.assertEqual((await self.call("POST", "/me/verification", body)).status_code, 200)
        self.assertNotEqual((await self.call("POST", "/me/verification", body)).status_code, 200)

    async def test_expired_and_cross_device_grants_rejected(self):
        token = await self.verify("export")
        async with SessionLocal() as session:
            await session.execute(update(AccountActionGrant).values(expires_at=account_privacy.now()-timedelta(seconds=1)))
            await session.commit()
        self.assertEqual((await self.call("POST", "/me/exports", {"verificationToken": token})).status_code, 403)
        token = await self.verify("export")
        login = await self.post("/login/password", {"email": "person@example.test", "password": "Original-password-123"}, device=2)
        self.assertEqual(login.status_code, 200, login.text)
        h = {"Authorization":"Device " + login.json()["session"]}
        self.assertEqual((await self.call("POST", "/me/exports", {"verificationToken": token}, headers=h)).status_code, 403)

    async def test_devices_only_current_owner_and_revoke(self):
        login = await self.post("/login/password", {"email": "person@example.test", "password": "Original-password-123"}, device=2)
        self.assertEqual(login.status_code, 200, login.text)
        async with SessionLocal() as session:
            target = await session.get(Client, "email-device-2")
            version = target.auth_version
            proxy_ticket = device_auth.issue_proxy_ticket(target)[0]
            mcp_ticket = device_auth.issue_mcp_ticket(target)[0]
            target.config = {"retained": "device settings"}
            session.add(Task(id="retained-device-work", title="Retained work", owner_client_id=target.id))
            await session.commit()
        rows = (await self.call("GET", "/me/devices")).json()["items"]
        self.assertEqual(len(rows), 2)
        self.assertEqual(sum(x["current"] for x in rows), 1)
        token = await self.verify("devices")
        self.assertEqual((await self.call("DELETE", "/me/devices/not-mine", {"verificationToken": token})).status_code, 404)
        terminal = AsyncMock()
        await device_connections.register_terminal("email-device-2", terminal)
        try:
            response = await self.call("DELETE", "/me/devices/email-device-2", {"verificationToken": token})
            terminal.close.assert_awaited_once_with(code=4401)
        finally:
            await device_connections.unregister_terminal("email-device-2", terminal)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["logoutRequired"])
        refreshed = await self.call("GET", "/me/devices")
        self.assertEqual(refreshed.status_code, 200, refreshed.text)
        self.assertEqual([item["id"] for item in refreshed.json()["items"]], ["email-device-1"])
        self.assertEqual((await self.call("GET", "/me", headers={"Authorization":"Device "+login.json()["session"]})).status_code, 403)
        async with SessionLocal() as session:
            target = await session.get(Client, "email-device-2")
            self.assertIsNone(target.user_ref)
            self.assertEqual(target.auth_state, "pending")
            self.assertEqual(target.auth_version, version + 1)
            self.assertEqual(target.config, {"retained": "device settings"})
            self.assertIsNotNone(await session.get(Task, "retained-device-work"))
            self.assertIsNotNone(await session.scalar(select(AuditLog.id).where(
                AuditLog.actor_id == self.uid, AuditLog.action == "account.device.revoke",
                AuditLog.target_id == "email-device-2")))
            with self.assertRaises(device_auth.DeviceAuthError):
                await device_auth.client_from_proxy_ticket(session, proxy_ticket)
            with self.assertRaises(device_auth.DeviceAuthError):
                await device_auth.principal_from_mcp_ticket(session, mcp_ticket)

    async def test_device_removal_rejects_current_device_without_spending_grant(self):
        token = await self.verify("devices")
        response = await self.call("DELETE", "/me/devices/email-device-1", {"verificationToken": token})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], "CURRENT_DEVICE_REMOVAL_FORBIDDEN")
        self.assertEqual((await self.call("GET", "/me")).status_code, 200)
        login = await self.post("/login/password", {"email": "person@example.test", "password": "Original-password-123"}, device=2)
        self.assertEqual(login.status_code, 200, login.text)
        response = await self.call("DELETE", "/me/devices/email-device-2", {"verificationToken": token})
        self.assertEqual(response.status_code, 200, response.text)

    async def test_device_removal_rejects_another_accounts_device(self):
        other, _ = await auth_fixture.EmailAuthTests.register(self, email="other@example.test", device=2)
        token = await self.verify("devices")
        response = await self.call("DELETE", "/me/devices/email-device-2", {"verificationToken": token})
        self.assertEqual(response.status_code, 404, response.text)
        rows = (await self.call("GET", "/me/devices")).json()["items"]
        self.assertEqual([item["id"] for item in rows], ["email-device-1"])
        other_headers = {"Authorization": "Device " + other["session"]}
        self.assertEqual((await self.call("GET", "/me", headers=other_headers)).status_code, 200)
        async with SessionLocal() as session:
            self.assertEqual((await session.get(Client, "email-device-2")).user_ref, other["user"]["id"])
            self.assertIsNone((await session.scalar(select(AccountActionGrant))).consumed_at)

    async def test_device_removal_requires_device_purpose_and_one_use_grant(self):
        login = await self.post("/login/password", {"email": "person@example.test", "password": "Original-password-123"}, device=2)
        self.assertEqual(login.status_code, 200, login.text)
        wrong_purpose = await self.verify("export")
        response = await self.call("DELETE", "/me/devices/email-device-2", {"verificationToken": wrong_purpose})
        self.assertEqual(response.status_code, 403, response.text)
        token = await self.verify("devices")
        self.assertEqual((await self.call("DELETE", "/me/devices/email-device-2", {"verificationToken": token})).status_code, 200)
        login = await self.post("/login/password", {"email": "person@example.test", "password": "Original-password-123"}, device=2)
        self.assertEqual(login.status_code, 200, login.text)
        response = await self.call("DELETE", "/me/devices/email-device-2", {"verificationToken": token})
        self.assertEqual(response.status_code, 403, response.text)

    async def test_device_removal_unbinds_inactive_target_without_reactivating_it(self):
        async with SessionLocal() as session:
            target = await session.get(Client, "email-device-2")
            target.user_ref, target.auth_state = self.uid, "revoked"
            target.revoked_at = account_privacy.now()
            await session.commit()
            version, revoked_at = target.auth_version, account_privacy.aware(target.revoked_at)
        token = await self.verify("devices")
        response = await self.call("DELETE", "/me/devices/email-device-2", {"verificationToken": token})
        self.assertEqual(response.status_code, 200, response.text)
        async with SessionLocal() as session:
            target = await session.get(Client, "email-device-2")
            self.assertIsNone(target.user_ref)
            self.assertEqual(target.auth_state, "revoked")
            self.assertEqual(target.auth_version, version + 1)
            self.assertEqual(account_privacy.aware(target.revoked_at), revoked_at)

    async def test_device_removal_rechecks_owner_and_preserves_grant_when_target_rebound(self):
        async with SessionLocal() as session:
            session.add(User(id="new-device-owner", username="new-device-owner", is_active=True))
            await session.execute(update(Client).where(Client.id == "email-device-2")
                .values(user_ref=self.uid, auth_state="active"))
            await session.commit()
        token = await self.verify("devices")
        original = account_security.consume_grant

        async def rebind_before_grant(session, user, client, token, purpose):
            async with SessionLocal() as other:
                await other.execute(update(Client).where(Client.id == "email-device-2")
                    .values(user_ref="new-device-owner", auth_version=Client.auth_version + 1))
                await other.commit()
            return await original(session, user, client, token, purpose)

        with patch.object(account_security, "consume_grant", side_effect=rebind_before_grant):
            response = await self.call("DELETE", "/me/devices/email-device-2", {"verificationToken": token})
        self.assertEqual(response.status_code, 404, response.text)
        async with SessionLocal() as session:
            self.assertEqual((await session.get(Client, "email-device-2")).user_ref, "new-device-owner")
            self.assertIsNone((await session.scalar(select(AccountActionGrant))).consumed_at)
            self.assertIsNone(await session.scalar(select(AuditLog.id).where(
                AuditLog.action == "account.device.revoke")))

    async def test_device_removal_audit_failure_rolls_back_binding_and_grant(self):
        login = await self.post("/login/password", {"email": "person@example.test", "password": "Original-password-123"}, device=2)
        self.assertEqual(login.status_code, 200, login.text)
        token = await self.verify("devices")

        def reject_audit(session, *_):
            if any(isinstance(row, AuditLog) and row.action == "account.device.revoke" for row in session.new):
                raise RuntimeError("isolated device audit write failure")

        event.listen(Session, "before_flush", reject_audit)
        try:
            with patch.object(self.http._transport, "raise_app_exceptions", False):
                response = await self.call("DELETE", "/me/devices/email-device-2", {"verificationToken": token})
            self.assertEqual(response.status_code, 500, response.text)
        finally:
            event.remove(Session, "before_flush", reject_audit)
        async with SessionLocal() as session:
            target = await session.get(Client, "email-device-2")
            self.assertEqual(target.user_ref, self.uid)
            self.assertEqual(target.auth_state, "active")
            self.assertIsNone((await session.scalar(select(AccountActionGrant))).consumed_at)
        self.assertEqual((await self.call("GET", "/me", headers={"Authorization": "Device " + login.json()["session"]})).status_code, 200)
        self.assertEqual((await self.call("DELETE", "/me/devices/email-device-2", {"verificationToken": token})).status_code, 200)

    async def test_device_removal_survives_post_commit_channel_failure(self):
        login = await self.post("/login/password", {"email": "person@example.test", "password": "Original-password-123"}, device=2)
        self.assertEqual(login.status_code, 200, login.text)
        token = await self.verify("devices")
        with patch.object(device_connections, "disconnect", side_effect=RuntimeError("isolated channel failure")), \
                patch.object(self.http._transport, "raise_app_exceptions", False):
            response = await self.call("DELETE", "/me/devices/email-device-2", {"verificationToken": token})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([item["id"] for item in (await self.call("GET", "/me/devices")).json()["items"]], ["email-device-1"])
        async with SessionLocal() as session:
            self.assertIsNotNone(await session.scalar(select(AuditLog.id).where(
                AuditLog.action == "account.device.revoke", AuditLog.target_id == "email-device-2")))

    async def test_change_email_revokes_sessions_and_keeps_admin_device_revocation(self):
        async with SessionLocal() as session:
            d = await session.get(Client, "email-device-2")
            d.user_ref, d.auth_state = self.uid, "revoked"
            await session.commit()
        proof = await self.challenge("change_email", "new@example.test")
        token = await self.verify("change_email")
        response = await self.call("POST", "/me/email-change", {**proof, "email":"new@example.test", "verificationToken":token})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["logoutRequired"])
        self.assertEqual((await self.call("GET", "/me")).status_code, 403)
        async with SessionLocal() as session:
            self.assertEqual((await session.get(User, self.uid)).email_normalized, "new@example.test")
            self.assertEqual((await session.get(Client, "email-device-2")).auth_state, "revoked")
        login = await self.post("/login/password", {"email":"new@example.test", "password":"Original-password-123"})
        self.assertEqual(login.status_code, 200, login.text)

    async def test_email_change_retires_old_login_alias_and_preserves_identity_and_data(self):
        second = await self.post("/login/password", {"email": "person@example.test",
            "password": "Original-password-123"}, device=2)
        self.assertEqual(second.status_code, 200, second.text)
        old_code = await self.proof("person@example.test", "login", device=2)
        async with SessionLocal() as session:
            user = await session.get(User, self.uid)
            before = (user.username, user.display_name, user.avatar_url, user.org_id, user.role_id)
            bearer = auth_fixture.sign_token(user.id, user.auth_version)
            session.add_all([
                LibraryItem(id="email-owner-file", owner_key=self.uid, title="Preserved file", kind="file", storage_key="preserved"),
                SessionMemory(id="email-owner-chat", owner_user_id=self.uid, source_hash="preserved", title="Preserved conversation"),
                Task(id="email-owner-task", title="Preserved requirement", owner_client_id="email-device-1", owner_user_id=self.uid),
                IdentityLink(id="email-owner-link", provider_id="provider", subject="stable-subject", user_id=self.uid),
            ])
            await session.commit()
            self.assertEqual((await session.get(Task, "email-owner-task")).owner_user_id, self.uid)
        self.assertEqual((await self.http.get("/_test/account-owner", headers={"Authorization": "Bearer " + bearer})).status_code, 200)
        proof = await self.challenge("change_email", "new@example.test")
        token = await self.verify("change_email")
        changed = await self.call("POST", "/me/email-change", {**proof, "email": "new@example.test", "verificationToken": token})
        self.assertEqual(changed.status_code, 200, changed.text)
        for old_session in (self.result["session"], second.json()["session"]):
            self.assertIn((await self.call("GET", "/me", headers={"Authorization": "Device " + old_session})).status_code, (401, 403))
        self.assertEqual((await self.http.get("/_test/account-owner", headers={"Authorization": "Bearer " + bearer})).status_code, 401)
        for route, key in (("/login/password", "email"), ("/login", "account")):
            with self.subTest(route=route, address="retired"):
                rejected = await self.post(route, {key: "PERSON@EXAMPLE.TEST", "password": "Original-password-123"})
                self.assertEqual(rejected.status_code, 401, rejected.text)
            with self.subTest(route=route, address="current"):
                current = await self.post(route, {key: "NEW@EXAMPLE.TEST", "password": "Original-password-123"})
                self.assertEqual(current.status_code, 200, current.text)
                self.assertEqual(current.json()["user"]["id"], self.uid)
        retired_code = await self.post("/login/email-code", old_code, device=2)
        self.assertEqual(retired_code.status_code, 404, retired_code.text)
        current_code = await self.proof("new@example.test", "login")
        current = await self.post("/login/email-code", current_code)
        self.assertEqual(current.status_code, 200, current.text)
        self.assertEqual(current.json()["user"]["id"], self.uid)
        self.headers = {"Authorization": "Device " + current.json()["session"]}
        self.assertEqual((await self.call("GET", "/me")).json()["user"]["email"], "new@example.test")
        replay = await self.call("POST", "/me/email-change", {**proof, "email": "new@example.test", "verificationToken": token})
        self.assertEqual(replay.status_code, 400, replay.text)
        async with SessionLocal() as session:
            user = await session.get(User, self.uid)
            self.assertEqual((user.username, user.display_name, user.avatar_url, user.org_id, user.role_id), before)
            self.assertEqual((await session.get(LibraryItem, "email-owner-file")).owner_key, self.uid)
            self.assertEqual((await session.get(SessionMemory, "email-owner-chat")).owner_user_id, self.uid)
            self.assertEqual((await session.get(Task, "email-owner-task")).owner_user_id, self.uid)
            self.assertEqual((await session.get(IdentityLink, "email-owner-link")).user_id, self.uid)
            self.assertIsNotNone(await session.scalar(select(AuditLog.id).where(AuditLog.action == "account.email.change")))

    async def test_email_change_retires_admin_login_alias_without_renaming_the_user(self):
        before = await self.http.post("/api/v1/admin/login", json={"user": "person@example.test", "pass": "Original-password-123"})
        self.assertEqual(before.status_code, 200, before.text)
        self.assertEqual(before.json()["user"]["id"], self.uid)
        proof = await self.challenge("change_email", "new@example.test")
        token = await self.verify("change_email")
        changed = await self.call("POST", "/me/email-change", {**proof, "email": "new@example.test", "verificationToken": token})
        self.assertEqual(changed.status_code, 200, changed.text)
        expired = await self.http.get("/api/v1/admin/me", headers={"Authorization": "Bearer " + before.json()["token"]})
        self.assertEqual(expired.status_code, 401, expired.text)
        rejected = await self.http.post("/api/v1/admin/login", json={"user": "person@example.test", "pass": "Original-password-123"})
        self.assertEqual(rejected.status_code, 401, rejected.text)
        current = await self.http.post("/api/v1/admin/login", json={"user": "NEW@EXAMPLE.TEST", "pass": "Original-password-123"})
        self.assertEqual(current.status_code, 200, current.text)
        self.assertEqual(current.json()["user"]["id"], self.uid)
        async with SessionLocal() as session:
            self.assertEqual((await session.get(User, self.uid)).username, "person@example.test")

    async def test_admin_legacy_usernames_keep_exact_case_and_whitespace_matching(self):
        async with SessionLocal() as session:
            session.add_all([
                User(id="admin-case-upper", username="Alice", is_active=True,
                    password_hash=auth_fixture.hash_password("Upper-password-123"), email="upper@example.test",
                    email_normalized="upper@example.test", email_verified_at=email_auth.now()),
                User(id="admin-case-lower", username="alice", is_active=True,
                    password_hash=auth_fixture.hash_password("Lower-password-456"), email="lower@example.test",
                    email_normalized="lower@example.test", email_verified_at=email_auth.now()),
            ])
            await session.commit()
        for username, password, uid in (("Alice", "Upper-password-123", "admin-case-upper"),
                                        ("alice", "Lower-password-456", "admin-case-lower")):
            response = await self.http.post("/api/v1/admin/login", json={"user": username, "pass": password})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["user"]["id"], uid)
        for username, password in (("alice", "Upper-password-123"), ("Alice", "Lower-password-456"),
                                   ("ALICE", "Upper-password-123"), (" Alice ", "Upper-password-123")):
            response = await self.http.post("/api/v1/admin/login", json={"user": username, "pass": password})
            self.assertEqual(response.status_code, 401, response.text)

    async def test_email_change_wrong_code_and_legacy_collision_preserve_proofs(self):
        async with SessionLocal() as session:
            session.add(User(id="legacy-email-owner", username="claimed@example.test", is_active=True))
            await session.commit()
        proof = await self.challenge("change_email", "claimed@example.test")
        token = await self.verify("change_email")
        wrong = "000000" if proof["code"] != "000000" else "000001"
        rejected = await self.call("POST", "/me/email-change", {**proof, "code": wrong,
            "email": "claimed@example.test", "verificationToken": token})
        self.assertEqual(rejected.status_code, 400, rejected.text)
        collision = await self.call("POST", "/me/email-change", {**proof, "email": "claimed@example.test", "verificationToken": token})
        self.assertEqual(collision.status_code, 409, collision.text)
        self.assertEqual(collision.json()["detail"]["code"], "EMAIL_UNAVAILABLE")
        async with SessionLocal() as session:
            self.assertEqual((await session.get(User, self.uid)).email_normalized, "person@example.test")
            self.assertIsNone((await session.get(EmailChallenge, proof["challengeId"])).consumed_at)
            grant = await session.scalar(select(AccountActionGrant).where(AccountActionGrant.token_hash == hashlib.sha256(token.encode()).hexdigest()))
            self.assertIsNone(grant.consumed_at)
            self.assertEqual((await session.get(Client, "email-device-1")).user_ref, self.uid)
            await session.delete(await session.get(User, "legacy-email-owner"))
            await session.commit()
        changed = await self.call("POST", "/me/email-change", {**proof, "email": "claimed@example.test", "verificationToken": token})
        self.assertEqual(changed.status_code, 200, changed.text)

    async def test_email_change_rejects_wrong_purpose_and_other_device_grants(self):
        proof = await self.challenge("change_email", "new@example.test")
        wrong = await self.verify("export")
        rejected = await self.call("POST", "/me/email-change", {**proof, "email": "new@example.test", "verificationToken": wrong})
        self.assertEqual(rejected.status_code, 403, rejected.text)
        second = await self.post("/login/password", {"email": "person@example.test", "password": "Original-password-123"}, device=2)
        token = await self.verify("change_email")
        async with SessionLocal() as session:
            second_proof = await email_auth.request_challenge(session, email="second-new@example.test", purpose="change_email", device_id="email-device-2", user_id=self.uid)
            mail = await session.scalar(select(auth_fixture.MailOutbox).where(auth_fixture.MailOutbox.challenge_id == second_proof["challengeId"]))
            code = account_mail.unseal(mail.payload_encrypted)["code"]
        rejected = await self.call("POST", "/me/email-change", {"email": "second-new@example.test", "challengeId": second_proof["challengeId"], "code": code, "verificationToken": token},
            headers={"Authorization": "Device " + second.json()["session"]})
        self.assertEqual(rejected.status_code, 403, rejected.text)
        accepted = await self.call("POST", "/me/email-change", {**proof, "email": "new@example.test", "verificationToken": token})
        self.assertEqual(accepted.status_code, 200, accepted.text)

    async def test_email_change_verified_address_collision_preserves_both_accounts(self):
        other, _ = await auth_fixture.EmailAuthTests.register(self, email="other@example.test", device=2)
        proof = await self.challenge("change_email", "other@example.test")
        token = await self.verify("change_email")
        response = await self.call("POST", "/me/email-change", {**proof, "email": "other@example.test", "verificationToken": token})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], "EMAIL_UNAVAILABLE")
        async with SessionLocal() as session:
            self.assertEqual((await session.get(User, self.uid)).email_normalized, "person@example.test")
            self.assertEqual((await session.get(User, other["user"]["id"])).email_normalized, "other@example.test")
            self.assertEqual((await session.get(Client, "email-device-1")).user_ref, self.uid)
            self.assertEqual((await session.get(Client, "email-device-2")).user_ref, other["user"]["id"])
            self.assertIsNone((await session.get(EmailChallenge, proof["challengeId"])).consumed_at)
            grant = await session.scalar(select(AccountActionGrant).where(AccountActionGrant.token_hash == hashlib.sha256(token.encode()).hexdigest()))
            self.assertIsNone(grant.consumed_at)

    async def test_email_change_audit_failure_rolls_back_address_proofs_and_devices(self):
        proof = await self.challenge("change_email", "new@example.test")
        token = await self.verify("change_email")
        def fail_audit(session, flush_context, instances):
            if any(isinstance(row, AuditLog) and row.action == "account.email.change" for row in session.new):
                raise RuntimeError("isolated email audit failure")
        event.listen(Session, "before_flush", fail_audit)
        try:
            with patch.object(self.http._transport, "raise_app_exceptions", False):
                response = await self.call("POST", "/me/email-change", {**proof, "email": "new@example.test", "verificationToken": token})
        finally:
            event.remove(Session, "before_flush", fail_audit)
        self.assertEqual(response.status_code, 500, response.text)
        async with SessionLocal() as session:
            self.assertEqual((await session.get(User, self.uid)).email_normalized, "person@example.test")
            self.assertIsNone((await session.get(EmailChallenge, proof["challengeId"])).consumed_at)
            grant = await session.scalar(select(AccountActionGrant).where(AccountActionGrant.token_hash == hashlib.sha256(token.encode()).hexdigest()))
            self.assertIsNone(grant.consumed_at)
            self.assertEqual((await session.get(Client, "email-device-1")).user_ref, self.uid)
        self.assertEqual((await self.call("GET", "/me")).status_code, 200)

    async def test_email_change_channel_failure_does_not_report_committed_change_as_failed(self):
        proof = await self.challenge("change_email", "new@example.test")
        token = await self.verify("change_email")
        with patch.object(device_connections, "disconnect", side_effect=RuntimeError("isolated channel failure")), \
                patch.object(self.http._transport, "raise_app_exceptions", False):
            response = await self.call("POST", "/me/email-change", {**proof, "email": "new@example.test", "verificationToken": token})
        self.assertEqual(response.status_code, 200, response.text)
        async with SessionLocal() as session:
            self.assertEqual((await session.get(User, self.uid)).email_normalized, "new@example.test")
            self.assertIsNotNone(await session.scalar(select(AuditLog.id).where(AuditLog.action == "account.email.change")))

    async def test_email_change_channel_cleanup_has_a_bounded_wait(self):
        proof = await self.challenge("change_email", "new@example.test")
        token = await self.verify("change_email")
        real_wait_for = asyncio.wait_for
        cleanup_cancelled = asyncio.Event()
        async def slow_disconnect(*args, **kwargs):
            try:
                await asyncio.Event().wait()
            finally:
                cleanup_cancelled.set()
        async def short_cleanup(awaitable, timeout):
            self.assertEqual(timeout, 5)
            return await real_wait_for(awaitable, timeout=0.01)
        # The short cleanup deadline tests cancellation; the outer guard also includes database I/O.
        response = None
        with patch.object(device_connections, "disconnect", side_effect=slow_disconnect), \
                patch.object(account_profile.asyncio, "wait_for", side_effect=short_cleanup):
            try:
                response = await real_wait_for(self.call("POST", "/me/email-change", {
                    **proof, "email": "new@example.test", "verificationToken": token}), timeout=30)
            except asyncio.TimeoutError:
                pass
        self.assertIsNotNone(response, "channel cleanup cannot indefinitely hold a committed email change")
        self.assertEqual(response.status_code, 200, response.text)

        self.assertTrue(cleanup_cancelled.is_set(), "timed-out channel cleanup must be cancelled")

    async def test_export_contains_own_storage_and_excludes_other_user_and_secrets(self):
        async with SessionLocal() as session:
            session.add(LibraryItem(id="mine", owner_key=self.uid, title="my file", filename="../private.txt", kind="file",
                storage_key="owner-file", size=5, backend="local"))
            session.add(LibraryItem(id="other", owner_key="someone-else", title="not exported", kind="file", storage_key="other-file"))
            session.add(MemoryRecord(scope="org", owner_user_id="", org_id="configured", memory_key="org", title="organization secret", summary="not exported"))
            await session.commit()
        token = await self.verify("export")
        response = await self.call("POST", "/me/exports", {"verificationToken":token})
        rid = response.json()["id"]
        with patch.object(account_privacy.library_storage, "read_bytes", return_value=b"hello") as read:
            self.assertTrue(await account_privacy.process_once())
            self.assertEqual(read.call_count, 1)
            self.assertEqual(read.call_args.args, ("owner-file",))
        download = await self.call("GET", f"/me/exports/{rid}/download")
        self.assertEqual(download.status_code, 200, download.text if download.status_code !=200 else "")
        self.assertEqual(download.headers["cache-control"], "no-store")
        with zipfile.ZipFile(io.BytesIO(download.content)) as archive:
            self.assertFalse(any(name.startswith("../") or "/../" in name for name in archive.namelist()))
            payload = archive.read("personal-data.json").decode()
            self.assertIn("my file", payload)
            self.assertNotIn("not exported", payload)
            self.assertNotIn("password_hash", payload)
            self.assertNotIn("secret_hash", payload)
        async with SessionLocal() as session:
            row=await session.get(AccountPrivacyRequest,rid)
            self.assertNotIn("hello",row.result_encrypted)
            row.user_id="someone-else"
            await session.commit()
        self.assertEqual((await self.call("GET", f"/me/exports/{rid}/download")).status_code,404)

    async def test_export_storage_failure_and_size_limit_never_return_partial_success(self):
        async with SessionLocal() as session:
            session.add(LibraryItem(id="mine", owner_key=self.uid, title="large", kind="file", storage_key="large", size=account_privacy.MAX_EXPORT_BYTES+1))
            await session.commit()
        token=await self.verify("export")
        rid=(await self.call("POST", "/me/exports", {"verificationToken":token})).json()["id"]
        await account_privacy.process_once()
        result=(await self.call("GET", f"/me/exports/{rid}")).json()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["errorCode"], "EXPORT_TOO_LARGE")
        self.assertEqual((await self.call("GET", f"/me/exports/{rid}/download")).status_code,409)

    async def test_export_expiry_clears_cached_data(self):
        token=await self.verify("export")
        rid=(await self.call("POST", "/me/exports", {"verificationToken":token})).json()["id"]
        await account_privacy.process_once()
        async with SessionLocal() as session:
            row=await session.get(AccountPrivacyRequest,rid)
            row.expires_at=account_privacy.now()-timedelta(seconds=1)
            await session.commit()
        self.assertEqual((await self.call("GET", f"/me/exports/{rid}/download")).status_code,409)
        async with SessionLocal() as session:
            self.assertEqual((await session.get(AccountPrivacyRequest,rid)).result_encrypted, "")

    async def test_deletion_disables_immediately_and_retries_storage_before_completion(self):
        async with SessionLocal() as session:
            session.add(LibraryItem(id="mine",owner_key=self.uid,kind="file",storage_key="mine"))
            session.add(LibraryItem(id="other",owner_key="other",kind="file",storage_key="other"))
            session.add(Task(id="retained-task",title="Team requirement",status="done",owner_client_id="email-device-1"))
            session.add(AiSchedule(id="schedule",created_by=self.uid,owner_client_id="email-device-1",enabled=True))
            await session.commit()
        token=await self.verify("delete_account")
        response=await self.call("POST", "/me/deletion", {"verificationToken":token,"confirmation":"注销账号"})
        self.assertEqual(response.status_code,202,response.text)
        rid=response.json()["requestId"]
        self.assertEqual((await self.call("GET", "/me")).status_code,403)
        with patch.object(account_privacy.library_storage,"delete",side_effect=OSError("offline")):
            await account_privacy.process_once()
        async with SessionLocal() as session:
            row=await session.get(AccountPrivacyRequest,rid)
            self.assertEqual(row.status,"queued")
            self.assertIsNotNone(await session.get(LibraryItem,"mine"))
            row.next_attempt_at=None
            await session.commit()
        with patch.object(account_privacy.library_storage,"delete") as remove:
            await account_privacy.process_once()
            remove.assert_called_once_with("mine",backend="local")
        async with SessionLocal() as session:
            self.assertEqual((await session.get(AccountPrivacyRequest,rid)).status,"completed")
            user=await session.get(User,self.uid)
            self.assertFalse(user.is_active)
            self.assertIsNone(user.email)
            self.assertEqual(user.password_hash,"")
            self.assertIsNone(await session.get(LibraryItem,"mine"))
            self.assertIsNotNone(await session.get(LibraryItem,"other"))
            self.assertIsNotNone(await session.get(Task,"retained-task"))
            self.assertFalse((await session.get(AiSchedule,"schedule")).enabled)

    async def test_deletion_erases_only_owned_im_data_with_atomic_retry(self):
        models = (im.IMConnection, im.IMPairing, im.IMWebhookReceipt, im.IMBinding, im.IMInbox, im.IMOutbox)
        async with SessionLocal() as session:
            session.add(User(id="im-retained-owner", username="im-retained-owner", is_active=True))
            session.add(Task(id="im-retained-task", title="Shared task evidence", status="done"))
            for prefix, owner in (("erase", self.uid), ("retain", "im-retained-owner")):
                # The same reassigned device must not transfer ownership of IM credentials.
                session.add(im.IMConnection(id=prefix, owner_user_id=owner, owner_client_id="email-device-1",
                    user_version=1, client_version=1, provider="telegram", name="Private connection",
                    enabled=True, credentials=prefix + "-encrypted-credentials", config={"bot_username": prefix}))
                session.add(im.IMPairing(code_hash=prefix, connection_id=prefix,
                    task_id="im-retained-task", runner_id="runner", options={"model": "selected"},
                    expires_at=account_privacy.now()+timedelta(minutes=5)))
                session.add(im.IMWebhookReceipt(connection_id=prefix, verification_key=prefix,
                    content_hash=prefix, created_at=account_privacy.now()))
                session.add(im.IMBinding(id=prefix, connection_id=prefix, identity_key=prefix,
                    external_identity={"chat": prefix}, task_id="im-retained-task", runner_id="runner"))
                session.add(im.IMInbox(id=prefix, connection_id=prefix, event_id=prefix,
                    content_hash=prefix, binding_id=prefix, task_id="im-retained-task",
                    text=prefix + " private message", reply_context={"chat": prefix},
                    status="waiting", available_at=account_privacy.now()))
                session.add(im.IMOutbox(id=prefix, inbox_id=prefix, connection_id=prefix,
                    binding_id=prefix, kind="done", text=prefix + " private reply", status="sending",
                    available_at=account_privacy.now(), lease_token=prefix,
                    lease_until=account_privacy.now()+timedelta(minutes=1)))
            session.add_all([
                im.IMRoute(task_id="erased-message-route", active_inbox_id="erase",
                    lease_token="erase", lease_until=account_privacy.now()+timedelta(minutes=1)),
                im.IMRoute(task_id="im-retained-task", active_inbox_id="retain",
                    lease_token="retain", lease_until=account_privacy.now()+timedelta(minutes=1)),
            ])
            await session.commit()
        token = await self.verify("delete_account")
        response = await self.call("POST", "/me/deletion", {
            "verificationToken": token, "confirmation": "注销账号"})
        self.assertEqual(response.status_code, 202, response.text)
        request_id = response.json()["requestId"]
        original = account_privacy._erase_im
        async def interrupted(session, user_id):
            await original(session, user_id)
            raise OSError("isolated failure after IM cleanup")
        with patch.object(account_privacy, "_erase_im", side_effect=interrupted):
            self.assertTrue(await account_privacy.process_once())
        async with SessionLocal() as session:
            request = await session.get(AccountPrivacyRequest, request_id)
            self.assertEqual(request.status, "queued")
            self.assertEqual(request.error_code, "PRIVACY_STORAGE_UNAVAILABLE")
            for model in models:
                key = ("erase", "erase") if model is im.IMWebhookReceipt else "erase"
                self.assertIsNotNone(await session.get(model, key), model.__name__)
            self.assertEqual((await session.get(im.IMRoute, "erased-message-route")).active_inbox_id, "erase")
            request.next_attempt_at = None
            await session.commit()
        self.assertTrue(await account_privacy.process_once())
        async with SessionLocal() as session:
            self.assertEqual((await session.get(AccountPrivacyRequest, request_id)).status, "completed")
            for model in models:
                own_key = ("erase", "erase") if model is im.IMWebhookReceipt else "erase"
                other_key = ("retain", "retain") if model is im.IMWebhookReceipt else "retain"
                self.assertIsNone(await session.get(model, own_key), model.__name__)
                self.assertIsNotNone(await session.get(model, other_key), model.__name__)
            route = await session.get(im.IMRoute, "erased-message-route")
            self.assertEqual((route.active_inbox_id, route.lease_token, route.lease_until), ("", "", None))
            retained = await session.get(im.IMRoute, "im-retained-task")
            self.assertEqual((retained.active_inbox_id, retained.lease_token), ("retain", "retain"))
            self.assertIsNotNone(await session.get(Task, "im-retained-task"))
            self.assertEqual((await session.get(im.IMConnection, "retain")).credentials, "retain-encrypted-credentials")
            # A repeated cleanup is safe after a worker retry or a lost completion response.
            await account_privacy.erase_private(session, await session.get(User, self.uid))
            await session.commit()
            self.assertIsNotNone(await session.get(im.IMConnection, "retain"))
        self.assertFalse(await account_privacy.process_once())

    async def test_deletion_requires_confirmation_and_handover(self):
        token=await self.verify("delete_account")
        self.assertEqual((await self.call("POST", "/me/deletion", {"verificationToken":token,"confirmation":"yes"})).status_code,422)
        async with SessionLocal() as session:
            session.add(Task(id="running",title="running",status="doing",owner_client_id="email-device-1"))
            await session.commit()
        response=await self.call("POST", "/me/deletion", {"verificationToken":token,"confirmation":"注销账号"})
        self.assertEqual(response.status_code,409)
        async with SessionLocal() as session:
            self.assertTrue((await session.get(User,self.uid)).is_active)

    async def test_deletion_commits_audit_and_survives_channel_cleanup_failure(self):
        login = await self.post("/login/password", {"email": "person@example.test",
            "password": "Original-password-123"}, device=2)
        self.assertEqual(login.status_code, 200, login.text)
        async with SessionLocal() as session:
            session.add(RunnerNode(id="deletion-runner", owner_user_id=self.uid,
                auth_state="active", dispatch_mode="accepting"))
            await session.commit()
        token = await self.verify("delete_account")
        with patch.object(account_profile.device_connections, "disconnect",
                          new=AsyncMock(side_effect=OSError("socket teardown unavailable"))) as disconnect, \
             patch.object(runner_hub, "disconnect_runner", new=AsyncMock()) as disconnect_runner:
            response = await self.call("POST", "/me/deletion", {
                "verificationToken": token, "confirmation": "注销账号"})
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(disconnect.await_count, 2)
        disconnect_runner.assert_awaited_once_with("deletion-runner", 4401)
        async with SessionLocal() as session:
            evidence = (await session.scalars(select(AuditLog).where(
                AuditLog.action == "account.deletion.request", AuditLog.actor_id == self.uid))).all()
            self.assertEqual(len(evidence), 1)
            self.assertEqual(evidence[0].detail["requestId"], response.json()["requestId"])
            self.assertFalse((await session.get(User, self.uid)).is_active)

    async def test_deletion_audit_failure_rolls_back_account_and_one_use_grant(self):
        token = await self.verify("delete_account")
        def reject_audit(session, _context, _instances):
            if any(isinstance(row, AuditLog) and row.action == "account.deletion.request"
                   for row in session.new):
                raise RuntimeError("isolated audit write failure")
        event.listen(Session, "before_flush", reject_audit)
        try:
            with self.assertRaisesRegex(RuntimeError, "isolated audit write failure"):
                await self.call("POST", "/me/deletion", {
                    "verificationToken": token, "confirmation": "注销账号"})
        finally:
            event.remove(Session, "before_flush", reject_audit)
        async with SessionLocal() as session:
            self.assertTrue((await session.get(User, self.uid)).is_active)
            self.assertIsNone((await session.get(User, self.uid)).account_deleted_at)
            self.assertEqual((await session.get(Client, "email-device-1")).user_ref, self.uid)
            self.assertIsNone(await session.scalar(select(AccountPrivacyRequest.id).where(
                AccountPrivacyRequest.user_id == self.uid, AccountPrivacyRequest.kind == "deletion")))
            grant = await session.scalar(select(AccountActionGrant).where(
                AccountActionGrant.user_id == self.uid, AccountActionGrant.purpose == "delete_account"))
            self.assertIsNone(grant.consumed_at)
        retried = await self.call("POST", "/me/deletion", {
            "verificationToken": token, "confirmation": "注销账号"})
        self.assertEqual(retried.status_code, 202, retried.text)

    async def test_deletion_revokes_all_sessions_and_cleans_only_owner_data(self):
        login = await self.post("/login/password", {"email": "person@example.test",
            "password": "Original-password-123"}, device=2)
        self.assertEqual(login.status_code, 200, login.text)
        other_session = {"Authorization": "Device " + login.json()["session"]}
        async with SessionLocal() as session:
            session.add(Client(id="email-device-3", secret_hash=device_auth.hash_secret("3" * 48),
                auth_state="pending", auth_version=1))
            user = await session.get(User, self.uid)
            bearer = auth_fixture.sign_token(user.id, user.auth_version)
            proxy_ticket = device_auth.issue_proxy_ticket(await session.get(Client, "email-device-1"))[0]
            await session.commit()
        other, _ = await auth_fixture.EmailAuthTests.register(self, email="other@example.test", device=3)
        other_uid = other["user"]["id"]
        other_headers = {"Authorization": "Device " + other["session"]}
        proof = await self.proof(email="person@example.test", purpose="login")
        async with SessionLocal() as session:
            session.add_all([
                LibraryItem(id="deleted-owner-file", owner_key=self.uid, kind="file", storage_key="private-file"),
                LibraryItem(id="remaining-owner-file", owner_key=other_uid, kind="file", storage_key="other-file"),
                MemoryRecord(id="deleted-memory", scope="private", owner_user_id=self.uid,
                    memory_key="private", title="Private memory"),
                MemoryRecord(id="retained-org-memory", scope="org", owner_user_id=self.uid,
                    memory_key="shared", title="Shared business memory"),
                MemoryRecord(id="other-memory", scope="private", owner_user_id=other_uid,
                    memory_key="other", title="Other memory"),
                SessionMemory(id="deleted-session", owner_user_id=self.uid, source_hash="own", title="Private session"),
                SessionMemory(id="other-session", owner_user_id=other_uid, source_hash="other", title="Other session"),
                Task(id="retained-evidence", title="Business delivery", status="done", owner_user_id=self.uid),
                DailyReport(id="retained-report", user_id=self.uid, user_name="Original identity", date="2026-10-24"),
            ])
            await session.commit()
        wrong_purpose = await self.verify("export")
        self.assertEqual((await self.call("POST", "/me/deletion", {
            "verificationToken": wrong_purpose, "confirmation": "注销账号"})).status_code, 403)
        token = await self.verify("delete_account")
        self.assertEqual((await self.call("POST", "/me/deletion", {
            "verificationToken": token, "confirmation": "注销账号"}, headers=other_session)).status_code, 403)
        self.assertEqual((await self.call("POST", "/me/deletion", {
            "verificationToken": token, "confirmation": "注销账号"}, headers=other_headers)).status_code, 403)
        response = await self.call("POST", "/me/deletion", {
            "verificationToken": token, "confirmation": "注销账号"})
        self.assertEqual(response.status_code, 202, response.text)
        for headers in (self.headers, other_session):
            self.assertEqual((await self.call("GET", "/me", headers=headers)).status_code, 403)
        self.assertEqual((await self.call("GET", "/me", headers=other_headers)).status_code, 200)
        self.assertEqual((await self.post("/login/password", {"email": "person@example.test",
            "password": "Original-password-123"})).status_code, 403)
        self.assertEqual((await self.post("/login/email-code", proof)).status_code, 403)
        async with SessionLocal() as session:
            from fastapi import HTTPException
            with self.assertRaises(HTTPException):
                await auth_fixture.current_user("Bearer " + bearer, session)
            with self.assertRaises(device_auth.DeviceAuthError):
                await device_auth.client_from_proxy_ticket(session, proxy_ticket)
        with patch.object(account_privacy.library_storage, "delete") as remove:
            self.assertTrue(await account_privacy.process_once())
            remove.assert_called_once_with("private-file", backend="local")
        async with SessionLocal() as session:
            self.assertEqual((await session.get(AccountPrivacyRequest, response.json()["requestId"])).status, "completed")
            user = await session.get(User, self.uid)
            self.assertFalse(user.is_active)
            self.assertIsNotNone(user.account_deleted_at)
            self.assertIsNone(user.email_normalized)
            self.assertEqual(user.password_hash, "")
            self.assertIsNone(await session.get(LibraryItem, "deleted-owner-file"))
            self.assertIsNone(await session.get(MemoryRecord, "deleted-memory"))
            self.assertIsNone(await session.get(SessionMemory, "deleted-session"))
            for model, key in [(LibraryItem, "remaining-owner-file"), (MemoryRecord, "other-memory"),
                               (MemoryRecord, "retained-org-memory"), (SessionMemory, "other-session"),
                               (Task, "retained-evidence")]:
                self.assertIsNotNone(await session.get(model, key))
            self.assertEqual((await session.get(DailyReport, "retained-report")).user_name, "已注销用户")
            self.assertIsNotNone(await session.scalar(select(AuditLog.id).where(
                AuditLog.actor_id == self.uid, AuditLog.action == "account.deletion.request")))
        self.assertEqual((await self.post("/login/password", {"email": "person@example.test",
            "password": "Original-password-123"})).status_code, 401)
        other_login = await self.post("/login/password", {"email": "other@example.test",
            "password": "Original-password-123"}, device=3)
        self.assertEqual(other_login.status_code, 200, other_login.text)
        self.assertEqual(other_login.json()["user"]["id"], other_uid)

    async def test_deletion_preserves_new_owner_runner_and_schedule(self):
        async with SessionLocal() as session:
            session.add(User(id="review-other", username="review-other", is_active=True))
            await session.execute(update(Client).where(Client.id == "email-device-2")
                .values(user_ref=self.uid, auth_state="active"))
            await session.commit()
        token = await self.verify("delete_account")
        original = account_security.consume_grant
        async def rebind_after_device_snapshot(session, user, client, token, purpose):
            async with SessionLocal() as other:
                await other.execute(update(Client).where(Client.id == "email-device-2")
                    .values(user_ref="review-other", auth_version=Client.auth_version+1))
                other.add(RunnerNode(id="review-new-runner", owner_user_id="review-other",
                    client_id="email-device-2", auth_state="active", dispatch_mode="accepting"))
                other.add(AiSchedule(id="review-new-schedule", created_by="review-other",
                    owner_client_id="email-device-2", enabled=True))
                await other.commit()
            return await original(session, user, client, token, purpose)
        with patch.object(account_security, "consume_grant", side_effect=rebind_after_device_snapshot):
            response = await self.call("POST", "/me/deletion", {
                "verificationToken":token, "confirmation":"注销账号"})
        self.assertEqual(response.status_code, 202, response.text)
        async with SessionLocal() as session:
            self.assertEqual((await session.get(Client,"email-device-2")).user_ref,"review-other")
            self.assertEqual((await session.get(RunnerNode,"review-new-runner")).auth_state,"active")
            self.assertTrue((await session.get(AiSchedule,"review-new-schedule")).enabled)

    async def test_deletion_does_not_inherit_previous_device_account_work(self):
        async with SessionLocal() as session:
            session.add(User(id="previous-owner", username="previous-owner", is_active=True))
            await session.execute(update(Client).where(Client.id == "email-device-1")
                .values(user_ref="previous-owner"))
            await session.commit()
            session.add(Task(id="previous-running", title="Private running work", status="doing",
                owner_client_id="email-device-1", created_by="previous-owner"))
            session.add_all([
                AiSchedule(id="previous-schedule", created_by="previous-owner",
                    owner_client_id="email-device-1", enabled=True),
                AiSchedule(id="own-schedule", created_by=self.uid,
                    owner_client_id="email-device-1", enabled=True),
                RunnerNode(id="previous-runner", owner_user_id="previous-owner",
                    client_id="email-device-1", auth_state="active", dispatch_mode="accepting"),
                RunnerNode(id="own-runner", owner_user_id=self.uid,
                    client_id="email-device-1", auth_state="active", dispatch_mode="accepting"),
            ])
            await session.commit()
            self.assertEqual((await session.get(Task, "previous-running")).owner_user_id, "previous-owner")
            await session.execute(update(Client).where(Client.id == "email-device-1")
                .values(user_ref=self.uid))
            await session.commit()
            session.add(AiSchedule(id="delegated-to-current", created_by="previous-owner",
                owner_client_id="email-device-1", enabled=True))
            await session.commit()
        token = await self.verify("delete_account")
        response = await self.call("POST", "/me/deletion", {
            "verificationToken": token, "confirmation": "注销账号"})
        self.assertEqual(response.status_code, 202, response.text)
        async with SessionLocal() as session:
            self.assertEqual((await session.get(Task, "previous-running")).status, "doing")
            self.assertTrue((await session.get(AiSchedule, "previous-schedule")).enabled)
            self.assertFalse((await session.get(AiSchedule, "own-schedule")).enabled)
            self.assertFalse((await session.get(AiSchedule, "delegated-to-current")).enabled)
            self.assertEqual((await session.get(RunnerNode, "previous-runner")).auth_state, "active")
            self.assertEqual((await session.get(RunnerNode, "own-runner")).auth_state, "revoked")

    async def test_deletion_still_requires_handover_after_device_changes_account(self):
        async with SessionLocal() as session:
            session.add(Task(id="owned-running", title="Own ongoing work", status="doing",
                owner_client_id="email-device-1"))
            await session.commit()
            self.assertEqual((await session.get(Task, "owned-running")).owner_user_id, self.uid)
            # Move the execution device to another account, while authenticating
            # the original owner on a different device to request deletion.
            session.add(User(id="later-owner", username="later-owner", is_active=True))
            await session.execute(update(Client).where(Client.id == "email-device-1")
                .values(user_ref="later-owner"))
            await session.execute(update(Client).where(Client.id == "email-device-2")
                .values(user_ref=self.uid, auth_state="active"))
            await session.commit()
            active = await session.get(Client, "email-device-2")
            self.headers = {"Authorization": "Device " + device_auth.issue_session(active)[0]}
        token = await self.verify("delete_account")
        response = await self.call("POST", "/me/deletion", {
            "verificationToken": token, "confirmation": "注销账号"})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn("ACTIVE_WORK_REQUIRES_HANDOVER", response.text)
        async with SessionLocal() as session:
            self.assertTrue((await session.get(User, self.uid)).is_active)

    async def test_legal_documents_available_without_login_and_consent_history(self):
        response=await self.http.get("/api/v1/client-auth/legal-documents")
        self.assertEqual(response.status_code,200,response.text)
        payload = response.json()
        documents = payload["documents"]
        expected = {(kind, locale) for kind in ("terms", "privacy")
                    for locale in ("zh-CN", "en-US", "ja-JP", "ko-KR")}
        self.assertCountEqual([(doc["key"], doc["locale"]) for doc in documents], expected)
        for doc in documents:
            self.assertEqual(doc["version"], payload["requiredConsentVersions"][doc["key"]])
            self.assertTrue(doc["title"].strip())
            self.assertTrue(doc["content"].strip())
        privacy=(await self.call("GET", "/me/privacy")).json()
        self.assertEqual(len(privacy["consents"]),2)
        self.assertEqual({item["document"]: item["version"] for item in privacy["consents"]},
                         payload["requiredConsentVersions"])
        self.assertTrue(privacy["scopeSummary"])
        self.assertIn("注销会清理账号资料", privacy["deletionScopeSummary"])
        self.assertNotIn("导出", privacy["deletionScopeSummary"])
        denied=await self.http.get("/api/v1/admin/account-legal",headers=self.headers)
        self.assertIn(denied.status_code,(401,403))


if __name__ == "__main__":
    unittest.main(verbosity=2)
