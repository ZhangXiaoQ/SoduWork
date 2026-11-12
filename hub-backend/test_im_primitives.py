"""Offline verification of the IM schema, protocol boundaries and credential redaction."""
import asyncio
import importlib
import io
import json
import logging
import os
import time
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "isolated-im-primitives-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-im-primitives-admin")

import httpx
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from fastapi import HTTPException
from sqlalchemy import create_engine, inspect

from app import im_models
from app.db import Base
from app.log_safety import SensitiveLogFilter, redact_log_text
from app.services import im_adapters, im_transport
from app.services.im_ingress import text_chunks


class IMPrimitiveTests(unittest.TestCase):
    def test_migration_matches_models_and_merges_existing_heads(self):
        migration = importlib.import_module("migrations.versions.0065_im_transport")
        merged = importlib.import_module("migrations.versions.0066_merge_im_transport")
        integrated = importlib.import_module("migrations.versions.0068_merge_notification_account")
        public_merge = importlib.import_module("migrations.versions.0069_merge_public_main")
        release_merge = importlib.import_module("migrations.versions.0070_merge_release_notes_schedule_model")
        script = ScriptDirectory.from_config(Config(str(Path(__file__).with_name("alembic.ini"))))
        source_app = importlib.import_module("migrations.versions.0071_schedule_source_app")
        heads = script.get_heads()
        self.assertEqual(len(heads), 1, "Migration branches must be merged before release")
        # Later migrations may advance the head, but must retain this complete
        # IM/account/notification/release merge lineage.
        ancestors = {item.revision for item in script.walk_revisions(base="base", head=heads[0])}
        self.assertTrue({source_app.revision, release_merge.revision, integrated.revision,
                         merged.revision, migration.revision}.issubset(ancestors))
        for revision, parent in {
                "0074_cloud_execution_durability": "0073_remote_screen_grants",
                "0073_remote_screen_grants": "0072_account_conversations",
                "0072_account_conversations": source_app.revision}.items():
            with self.subTest(revision=revision):
                self.assertEqual(script.get_revision(revision).down_revision, parent)
        self.assertEqual(source_app.down_revision, release_merge.revision)
        self.assertEqual(set(release_merge.down_revision),
                         {"0069_client_release_notes", "0069_schedule_model_selection"})
        for parent in release_merge.down_revision:
            self.assertEqual(script.get_revision(parent).down_revision, integrated.revision)
        self.assertEqual(set(public_merge.down_revision),
                         {"0065_merge_feature_branches", integrated.revision})
        self.assertEqual(set(integrated.down_revision),
                         {merged.revision, "0067_merge_release_account_ownership"})
        self.assertEqual(set(merged.down_revision),
                         {migration.revision, "0065_merge_recommendation_usage"})
        self.assertEqual(set(migration.down_revision),
                         {"0064_usage_attribution", "0063_plugin_recommendation"})
        # Keep the published main revision intact while new revisions fit the
        # original 32-character boundary; PostgreSQL widens its version column.
        self.assertEqual({item.revision for item in script.walk_revisions() if len(item.revision) > 32},
                         {"0067_merge_release_account_ownership"})
        self.assertTrue(all(len(item.revision) <= 64 for item in script.walk_revisions()))
        engine = create_engine("sqlite://")
        self.addCleanup(engine.dispose)
        with engine.begin() as connection:
            with Operations.context(MigrationContext.configure(connection)):
                migration.upgrade()
            schema = inspect(connection)
            expected = [table for name, table in Base.metadata.tables.items() if name.startswith("im_")]
            self.assertEqual(set(schema.get_table_names()), {table.name for table in expected})
            for table in expected:
                with self.subTest(table=table.name):
                    actual = {column["name"]: column for column in schema.get_columns(table.name)}
                    self.assertEqual(set(actual), set(table.columns.keys()))
                    for column in table.columns:
                        self.assertEqual(actual[column.name]["nullable"], column.nullable)
                    self.assertEqual({item["name"] for item in schema.get_indexes(table.name)}, {item.name for item in table.indexes})
            with Operations.context(MigrationContext.configure(connection)):
                migration.downgrade()
            self.assertEqual(inspect(connection).get_table_names(), [])
        stream = io.StringIO()
        with Operations.context(MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": stream})):
            migration.upgrade()
        self.assertEqual(stream.getvalue().count("CREATE TABLE"), 7)
        self.assertIn("TIMESTAMP WITH TIME ZONE", stream.getvalue())
        self.assertIn("uq_im_inbox_event", stream.getvalue())

    def test_telegram_malformed_nested_messages_fail_closed(self):
        credentials, config = {"webhook_secret": "fixture-secret"}, {"bot_id": "1", "bot_username": "FixtureBot"}
        headers = {"x-telegram-bot-api-secret-token": "fixture-secret"}
        base = {"update_id": 1, "message": {"date": int(time.time()), "from": {"id": 42},
            "chat": {"id": 42, "type": "private"}, "text": "run"}}
        for key, value in (("from", [1]), ("chat", "invalid"), ("message_thread_id", {"id": 1})):
            body = json.loads(json.dumps(base))
            body["message"][key] = value
            with self.subTest(key=key), self.assertRaises(HTTPException) as caught:
                im_adapters.parse("telegram", credentials, config, headers, json.dumps(body).encode())
            self.assertEqual(caught.exception.status_code, 400)
        base["message"]["chat"]["type"] = "supergroup"
        self.assertIsNone(im_adapters.parse("telegram", credentials, config, headers, json.dumps(base).encode())[0])
        base["message"]["text"] = "/soduwork@FixtureBot do work"
        self.assertEqual(im_adapters.parse("telegram", credentials, config, headers, json.dumps(base).encode())[0]["text"], "do work")

    def test_emoji_chunks_and_platform_credentials_stay_safe(self):
        content = "文字" + "😀" * 5000
        chunks = list(text_chunks(content))
        self.assertEqual("".join(chunks), content)
        self.assertTrue(all(len(chunk.encode("utf-16-le")) // 2 <= 3500 for chunk in chunks))
        token = "123456789:fixture_secret_token"
        record = logging.LogRecord("httpx", logging.INFO, "", 0, "HTTP Request: %s %s", ("POST",
            httpx.URL("https://api.telegram.org/bot" + token + "/sendMessage")), None)
        SensitiveLogFilter().filter(record)
        self.assertNotIn(token, record.getMessage())
        self.assertIn("sendMessage", record.getMessage())
        for key in ("bot_token", "webhook_secret", "verification_token", "encrypt_key"):
            self.assertNotIn("sensitive", redact_log_text(json.dumps({key: "sensitive"})))


class IMTokenTests(unittest.IsolatedAsyncioTestCase):
    async def test_token_singleflight_cache_and_strict_business_code(self):
        credentials = {"app_id": "fixture-app", "app_secret": "fixture-secret"}
        with patch.object(im_transport, "request", return_value={"code": 0, "tenant_access_token": "token", "expire": 7200}) as request:
            self.assertEqual(await asyncio.gather(*(im_transport.feishu_token(credentials) for _ in range(8))), ["token"] * 8)
            self.assertEqual(request.await_count, 1)
        with patch.object(im_transport, "request", return_value={"code": False, "tenant_access_token": "bad"}):
            with self.assertRaises(im_transport.TransportError):
                await im_transport.feishu_token({**credentials, "app_secret": "different"})


if __name__ == "__main__":
    unittest.main()
