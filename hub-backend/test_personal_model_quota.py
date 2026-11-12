"""Authenticated HTTP/SQLite coverage for Pi personal funding and immutable usage."""
import importlib.util
import json
import secrets
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import test_token_quota as quota_fixture
from sqlalchemy import create_engine, func, select, text
from alembic.migration import MigrationContext
from alembic.operations import Operations
from app import models
from app.auth import sign_claims, verify_claims
from app.services import client_access, device_auth, model_catalog, model_runtime, model_transport, quota_plans
from app.services.model_errors import UpstreamError


class PersonalModelQuotaTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = quota_fixture.TokenQuotaTests.asyncTearDown
    policy = quota_fixture.TokenQuotaTests.policy
    override = quota_fixture.TokenQuotaTests.override
    report = quota_fixture.TokenQuotaTests.report

    async def asyncSetUp(self):
        await quota_fixture.TokenQuotaTests.asyncSetUp(self)
        async with self.sessions() as session:
            session.add(models.ModelProvider(id="shared", name="Shared", kind="openai-compat",
                base_url="http://127.0.0.1:1/v1", api_key=secrets.token_urlsafe(24), enabled=True))
            session.add(models.ModelDef(id="shared:shared-model", provider_id="shared",
                name="shared-model", label="Shared model", enabled=True))
            await session.commit()
        before = await self.http.get("/api/v1/my-models", headers=self.headers)
        saved = await self.http.put("/api/v1/my-models", headers=self.headers, json={
            "expectedRevision": before.json()["revision"],
            "providers": [{"id": "custom-local", "name": "Local", "kind": "openai-compat",
                "baseUrl": "http://127.0.0.1:1/v1", "authMode": "none"}],
            "models": [{"providerId": "custom-local", "name": "local-model"}]})
        self.assertEqual(saved.status_code, 200, saved.text)
        await self.policy(100)

    async def config(self, model="local-model", agent="pi"):
        return await self.http.get("/api/v1/ai-proxy/config", headers=self.headers,
                                   params={"model": model, "agent": agent})

    async def receipt(self, count, *, key="mixed", token="", provider="shared", model="shared-model", **fields):
        return await self.http.post("/api/v1/usage/events", headers=self.headers, json={
            "sourceId": key, "provider": provider, "model": model, "agent": "pi",
            "quotaUsageToken": token, "usage": {"input": count}, **fields})

    async def test_exhaustion_allows_local_and_byok_but_not_shared_or_old_runtime(self):
        self.assertEqual((await self.config()).status_code, 200)
        await self.report(100)
        listed = await self.http.get("/api/v1/my-models", headers=self.headers)
        self.assertEqual(listed.status_code, 200)
        self.assertIn("local-model", [m["name"] for m in listed.json()["usable"]])
        private = await self.config()
        self.assertEqual(private.status_code, 200, private.text)
        self.assertEqual(private.json()["quotaScope"], "personal")
        self.assertTrue(private.json()["quotaUsageToken"])
        self.assertEqual((await self.config("shared-model")).status_code, 403)
        self.assertEqual((await self.config(agent="harness2")).status_code, 403)
        allowed = await self.http.get("/api/v1/client-auth/authorize-ai?agent=pi&model=local-model", headers=self.headers)
        self.assertEqual(allowed.status_code, 200, allowed.text)
        self.assertFalse(allowed.json()["quota"]["exceeded"])
        self.assertTrue(allowed.json()["platformQuota"]["exceeded"])
        for query in ("", "?agent=codex&model=local-model"):
            self.assertEqual((await self.http.get("/api/v1/client-auth/authorize-ai" + query,
                                                headers=self.headers)).status_code, 403)
        with patch.object(model_catalog, "probe_sync", return_value={"ok": True, "probe": "models"}) as probe:
            result = await self.http.post("/api/v1/my-models/test", headers=self.headers,
                                          json={"providerId": "custom-local"})
            self.assertEqual(result.status_code, 200, result.text)
            self.assertTrue(result.json()["ok"])
            probe.assert_called_once()
        # A caller's personal usage receipt cannot authorize a shared provider.
        with patch.object(model_transport, "open_response", new=AsyncMock()) as upstream:
            result = await self.http.post("/api/v1/ai-proxy/v1/chat/completions",
                headers={"Authorization": "Bearer " + private.json()["key"]},
                json={"model": "shared-model", "messages": [], "quotaUsageToken": private.json()["quotaUsageToken"]})
            self.assertEqual(result.status_code, 409, result.text)
            upstream.assert_not_awaited()
        # Own keys on an organization provider also count as personally funded.
        saved = await self.http.put("/api/v1/my-models", headers=self.headers,
            json={"keys": {"shared": secrets.token_urlsafe(24)}})
        self.assertEqual(saved.status_code, 200, saved.text)
        own = await self.config("shared-model")
        self.assertEqual(own.status_code, 200, own.text)
        self.assertEqual(own.json()["keyFrom"], "mine")
        self.assertEqual(own.json()["quotaScope"], "personal")

    async def test_zero_trial_and_allowlist_remain_authoritative(self):
        await self.override("limited", 0)
        self.assertEqual((await self.config()).status_code, 403)
        await self.override("inherit")
        async with self.sessions() as session:
            session.add(models.AppSetting(key=quota_plans.GRANT_PREFIX + self.user.id,
                value=json.dumps({"mode": "custom", "custom": {"totalLimit": 10, "restrictModels": True,
                    "models": [{"provider": "shared", "model": "shared-model", "limit": 100}]}})))
            await session.commit()
        await self.report(10)
        result = await self.config()
        self.assertEqual(result.status_code, 403, result.text)
        self.assertEqual(result.json()["detail"]["quota"]["reason"], "model_not_allowed")
        # A zero selected-model allowance is an explicit pause even without a total cap.
        async with self.sessions() as session:
            row = await session.get(models.AppSetting, quota_plans.GRANT_PREFIX + self.user.id)
            row.value = json.dumps({"mode": "custom", "custom": {"totalLimit": None, "restrictModels": True,
                "models": [{"provider": "custom-local", "model": "local-model", "limit": 0}]}})
            await session.commit()
        self.assertEqual((await self.config()).status_code, 403)
        async with self.sessions() as session:
            row = await session.get(models.AppSetting, quota_plans.GRANT_PREFIX + self.user.id)
            row.value = json.dumps({"mode": "custom", "custom": {"totalLimit": None, "restrictModels": True,
                "models": [{"provider": "custom-local", "model": "local-model", "limit": 5}]}})
            await session.commit()
        self.assertEqual((await self.config()).status_code, 200)
        async with self.sessions() as session:
            row = await session.get(models.AppSetting, quota_plans.GRANT_PREFIX + self.user.id)
            await session.delete(row)
            await session.flush()
            await quota_plans.register_trial(session, self.user.id,
                now=datetime.now(timezone.utc) - timedelta(days=8))
            await session.commit()
        expired = await self.config()
        self.assertEqual(expired.status_code, 403, expired.text)
        self.assertEqual(expired.json()["detail"]["quota"]["reason"], "trial_expired")

    async def test_compat_headers_work_without_waiving_disabled_accounts(self):
        from app import deps
        secret = secrets.token_urlsafe(36)
        async with self.sessions() as session:
            client = await session.get(models.Client, self.devices[0].id)
            client.secret_hash = device_auth.hash_secret(secret)
            await session.commit()
        headers = {"X-Soduwork-Device": self.devices[0].id, "X-Soduwork-Secret": secret}
        with patch.object(deps.settings, "device_auth_compat", True):
            result = await self.http.get("/api/v1/ai-proxy/config?agent=pi&model=local-model", headers=headers)
            self.assertEqual(result.status_code, 200, result.text)
            async with self.sessions() as session:
                user = await session.get(models.User, self.user.id)
                user.is_active = False
                await session.commit()
            result = await self.http.get("/api/v1/ai-proxy/config?agent=pi&model=local-model", headers=headers)
            self.assertEqual(result.status_code, 403, result.text)

    async def test_signed_receipts_only_exempt_new_verified_deltas(self):
        private = (await self.config()).json()
        token = private["quotaUsageToken"]
        await self.receipt(10)
        await self.receipt(15, token=token, provider="custom-local", model="local-model")
        await self.receipt(18)
        # Metadata replay cannot relabel immutable original platform increments.
        await self.receipt(18, token=token, provider="custom-local", model="local-model",
                           credentialScope="personal", billingMode="free")
        async with self.sessions() as session:
            self.assertEqual(await client_access.monthly_tokens(session, self.user.id), 13)
            personal = await session.scalar(select(func.sum(models.AIUsageDaily.total_tokens)).where(
                models.AIUsageDaily.quota_scope == "personal"))
            self.assertEqual(personal, 5)
        claims = verify_claims(token, token_type="model-quota-usage")
        invalid = ["", "not-a-token", token + "broken"]
        for field in ("uid", "cid", "provider", "model", "ver"):
            invalid.append(sign_claims({**claims, field: "wrong"}, token_type="model-quota-usage", ttl_seconds=100))
        invalid.append(sign_claims(claims, token_type="model-quota-usage", ttl_seconds=1,
                                   issued_at=int(time.time()) - 10))
        for i, bad in enumerate(invalid):
            result = await self.receipt(1, key="invalid-" + str(i), token=bad,
                provider="custom-local", model="local-model", credentialScope="personal", billingMode="free")
            self.assertEqual(result.status_code, 200, result.text)
        for runtime in ("", "codex-harness", "codex"):
            result = await self.receipt(1, key="runtime-" + runtime, token=token,
                provider="custom-local", model="local-model", agent=runtime)
            self.assertEqual(result.status_code, 200, result.text)
        async with self.sessions() as session:
            self.assertEqual(await client_access.monthly_tokens(session, self.user.id), 16 + len(invalid))

    async def test_legacy_event_without_daily_keeps_unknown_usage_charged(self):
        private = (await self.config()).json()
        async with self.sessions() as session:
            session.add(models.AIUsageEvent(idempotency_key="client:" + self.devices[0].id + ":legacy",
                billing_user_id=self.user.id, client_id=self.devices[0].id,
                provider="shared", model="shared-model", input_tokens=42, total_tokens=42,
                credential_scope="personal", billing_mode="free", occurred_at=datetime.now(timezone.utc)))
            await session.commit()
        result = await self.receipt(47, key="legacy", token=private["quotaUsageToken"],
                                    provider="custom-local", model="local-model")
        self.assertEqual(result.status_code, 200, result.text)
        async with self.sessions() as session:
            self.assertEqual(await client_access.monthly_tokens(session, self.user.id), 42)
            baseline = (await session.execute(select(models.AIUsageDaily).where(
                models.AIUsageDaily.is_baseline.is_(True)))).scalar_one()
            self.assertEqual((baseline.total_tokens, baseline.provider, baseline.quota_scope),
                             (42, "shared", "platform"))

    async def test_personal_credentials_revoked_during_capacity_wait_never_call_upstream(self):
        saved = await self.http.put("/api/v1/my-models", headers=self.headers,
            json={"keys": {"shared": secrets.token_urlsafe(24)}})
        self.assertEqual(saved.status_code, 200)
        async with self.sessions() as session:
            client = await session.get(models.Client, self.devices[0].id)
            conf = await model_catalog.resolve(session, client, "shared-model")
            conf["quotaScope"] = "personal"
        lease = SimpleNamespace(close=AsyncMock())
        async def acquired(_conf):
            async with self.sessions() as session:
                client = await session.get(models.Client, self.devices[0].id)
                client.model_keys = {}
                await session.commit()
            return lease
        with patch.object(model_runtime, "acquire", side_effect=acquired), \
             patch.object(model_runtime, "SessionLocal", self.sessions), \
             patch.object(model_transport, "_client") as upstream:
            with self.assertRaises(UpstreamError) as denied:
                await model_transport.open_response(conf, "/chat/completions", b"{}")
            self.assertEqual(denied.exception.status, 409)
            upstream.assert_not_called()
            lease.close.assert_awaited_once()

    async def test_proxy_ticket_rejects_funding_changes_while_platform_budget_remains(self):
        platform = (await self.config("shared-model")).json()
        await self.http.put("/api/v1/my-models", headers=self.headers,
            json={"keys": {"shared": secrets.token_urlsafe(24)}})
        personal = (await self.config("shared-model")).json()
        with patch.object(model_transport, "open_response", new=AsyncMock()) as upstream:
            response = await self.http.post("/api/v1/ai-proxy/v1/chat/completions",
                headers={"Authorization": "Bearer " + platform["key"]},
                json={"model": "shared-model", "messages": []})
            self.assertEqual(response.status_code, 409, response.text)
            await self.http.put("/api/v1/my-models", headers=self.headers, json={"keys": {"shared": None}})
            response = await self.http.post("/api/v1/ai-proxy/v1/chat/completions",
                headers={"Authorization": "Bearer " + personal["key"]},
                json={"model": "shared-model", "messages": []})
            self.assertEqual(response.status_code, 409, response.text)
            upstream.assert_not_awaited()
        # A real earlier personal increment may still settle after the key changes.
        result = await self.receipt(5, token=personal["quotaUsageToken"])
        self.assertEqual(result.status_code, 200)
        async with self.sessions() as session:
            self.assertEqual(await client_access.monthly_tokens(session, self.user.id), 0)

    async def test_old_daily_migration_never_infers_personal_from_event(self):
        spec = importlib.util.spec_from_file_location("quota_migration",
            Path(__file__).parent / "migrations/versions/0086_usage_quota_scope.py")
        migration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration)
        engine = create_engine("sqlite:///:memory:")
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE ai_usage_daily (id INTEGER PRIMARY KEY, total_tokens INTEGER)"))
            connection.execute(text("INSERT INTO ai_usage_daily VALUES (1, 42)"))
            with patch.object(migration, "op", Operations(MigrationContext.configure(connection))):
                migration.upgrade()
                self.assertEqual(connection.execute(text("SELECT quota_scope FROM ai_usage_daily")).scalar(), "platform")
                connection.execute(text("INSERT INTO ai_usage_daily VALUES (2, 3, 'personal')"))
                with self.assertRaises(RuntimeError):
                    migration.downgrade()
        engine.dispose()


if __name__ == "__main__":
    unittest.main()
