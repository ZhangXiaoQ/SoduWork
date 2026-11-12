"""Regression checks for the release plus account-isolation Alembic line."""
import io
import asyncio
from types import SimpleNamespace
from unittest.mock import Mock
from sqlalchemy.ext.asyncio import create_async_engine
from app import schema_migrations
import unittest
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from unittest.mock import patch

from alembic import command
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext, MigrationStep
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text

from app.config import get_settings
from app.models import Client
from app.schema_migrations import (
    SchemaMigrationError, _config, migrate_database, normalize_sqlite_merge_revision,
)


OLD_MERGE = "0067_merge_release_account_ownership"
CANONICAL_MERGE = "0067_merge_account_ownership"
CURRENT_HEAD = "0086_usage_quota_scope"


class IntegratedMigrationHistoryTests(unittest.TestCase):
    def test_downgrade_cannot_orphan_an_endpoint_only_schedule_input(self):
        import importlib
        migration = importlib.import_module("migrations.versions.0082_endpoint_conversation_content")
        engine = create_engine("sqlite://")
        try:
            with engine.begin() as connection:
                for table, column in (("account_conversation", "content_ref"),
                        ("personal_conversation_relay", "content_ref"),
                        ("automation_execution_event", "detail"), ("conversation_handoff", "options"),
                        ("conversation_message_receipt", "payload"), ("ai_schedule_run", "receipt")):
                    connection.execute(text(f"CREATE TABLE {table} ({column} TEXT)"))
                receipt = '{"conversationInput":{"contentRef":{"sha256":"preserved"}}}'
                connection.execute(text("INSERT INTO ai_schedule_run VALUES (:receipt)"), {"receipt": receipt})
                with Operations.context(MigrationContext.configure(connection=connection)):
                    with self.assertRaisesRegex(RuntimeError, "Restore endpoint content"):
                        migration.downgrade()
                self.assertEqual(connection.scalar(text("SELECT receipt FROM ai_schedule_run")), receipt)
        finally:
            engine.dispose()

    def merge_context(self, dialect, *, downgrade=False, connection=None):
        script = ScriptDirectory.from_config(_config())
        revision = script.get_revision("0067_merge_release_account_ownership")
        step = (MigrationStep.downgrade_from_script if downgrade else MigrationStep.upgrade_from_script)(
            script.revision_map, revision)
        output = io.StringIO()
        options = {"fn": lambda _heads, _context: [step], "script": script}
        if connection is None:
            options.update(as_sql=True, output_buffer=output,
                           starting_rev=revision.revision if downgrade else revision.down_revision)
        context = MigrationContext.configure(connection=connection, dialect_name=dialect, opts=options)
        with Operations.context(context), context.begin_transaction():
            context.run_migrations()
        return output.getvalue()

    def test_postgres_expands_version_column_before_writing_permanent_merge_id(self):
        sql = self.merge_context("postgresql")
        widening = "ALTER TABLE alembic_version ALTER COLUMN version_num TYPE VARCHAR(128)"
        stamp = "UPDATE alembic_version SET version_num='0067_merge_release_account_ownership'"
        self.assertIn(widening, sql)
        self.assertIn(stamp, sql)
        self.assertLess(sql.index(widening), sql.index(stamp), sql)

    def test_postgres_downgrade_keeps_capacity_while_merge_id_is_still_stored(self):
        sql = self.merge_context("postgresql", downgrade=True)
        self.assertNotIn("ALTER TABLE", sql)
        self.assertIn("WHERE alembic_version.version_num = '0067_merge_release_account_ownership'", sql)
        self.assertIn("0065_merge_usage_notifications", sql)
        self.assertIn("0066_schedule_account_ownership", sql)

    def test_sqlite_merge_and_unmerge_preserve_permanent_ids_and_other_data(self):
        engine = create_engine("sqlite://")
        parents = ["0065_merge_usage_notifications", "0066_schedule_account_ownership"]
        try:
            with engine.begin() as connection:
                connection.execute(text("CREATE TABLE alembic_version (version_num VARCHAR(32) PRIMARY KEY)"))
                connection.execute(text("INSERT INTO alembic_version VALUES (:revision)"),
                                   [{"revision": revision} for revision in parents])
                connection.execute(text("CREATE TABLE preserved_data (value TEXT)"))
                connection.execute(text("INSERT INTO preserved_data VALUES ('unchanged')"))
                self.merge_context("sqlite", connection=connection)
                self.assertEqual(list(connection.scalars(text("SELECT version_num FROM alembic_version"))),
                                 ["0067_merge_release_account_ownership"])
                self.merge_context("sqlite", downgrade=True, connection=connection)
                self.assertEqual(sorted(connection.scalars(text("SELECT version_num FROM alembic_version"))), parents)
                self.merge_context("sqlite", connection=connection)
                self.assertEqual(connection.scalar(text("SELECT value FROM preserved_data")), "unchanged")
                self.assertEqual(connection.execute(text("PRAGMA table_info(alembic_version)")).one()[2], "VARCHAR(32)")
        finally:
            engine.dispose()

    def test_release_and_account_lines_have_one_head_and_expected_parents(self):
        script = ScriptDirectory.from_config(_config())
        self.assertEqual(script.get_heads(), [CURRENT_HEAD])
        expected = {
            "0086_usage_quota_scope": "0085_merge_public_schedule",
            "0085_merge_public_schedule": ("0080_merge_public_discovery", "0084_schedule_custom_rule"),
            "0080_merge_public_discovery": ("0079_merge_public_projects", "0079_native_discovery"),
            "0084_schedule_custom_rule": "0083_schedule_timing_rules",
            "0083_schedule_timing_rules": "0082_endpoint_content",
            "0082_endpoint_content": "0081_merge_legal_account",
            "0081_merge_legal_account": ("0080_legal_publications", "0080_account_lifecycle"),
            "0080_legal_publications": "0079_native_discovery",
            "0080_account_lifecycle": "0079_native_discovery",
            "0079_native_discovery": "0078_account_task_projection",
            "0079_merge_public_projects": ("0077_merge_public_runtime", "0078_account_task_projection"),
            "0078_account_task_projection": "0077_conversation_projects",
            "0077_conversation_projects": "0076_merge_model_runtime",
            "0077_merge_public_runtime": (
                "0068_merge_notify_accounts", "0069_merge_public_main", "0076_merge_model_runtime"),
            "0063_plugin_recommendations": "0062_plugin_recommendation_cover",
            "0063_plugin_recommendation": "0063_plugin_recommendations",
            "0065_merge_feature_branches": ("0063_plugin_recommendations", "0064_usage_attribution"),
            "0076_merge_model_runtime": (
                "0074_model_runtime_leases", "0075_merge_cloud_relay"),
            "0075_merge_cloud_relay": (
                "0074_cloud_execution_durability", "0074_personal_conversation_relay"),
            "0074_personal_conversation_relay": "0073_remote_screen_grants",
            "0074_cloud_execution_durability": "0073_remote_screen_grants",
            "0073_remote_screen_grants": "0072_account_conversations",
            "0072_account_conversations": "0071_schedule_source_app",
            "0071_schedule_source_app": "0070_merge_notes_schedule",
            "0069_client_release_notes": "0068_merge_notification_account",
            "0069_schedule_model_selection": "0068_merge_notification_account",
            "0070_merge_notes_schedule": (
                "0069_client_release_notes", "0069_schedule_model_selection"),
            "0063_task_notification_outbox": "0062_plugin_recommendation_cover",
            "0064_usage_attribution": "0063_task_notification_outbox",
            "0065_merge_recommendation_usage": (
                "0064_usage_attribution", "0063_plugin_recommendation"),
            "0063_email_accounts": "0062_plugin_recommendation_cover",
            "0064_repository_issues": "0063_email_accounts",
            "0065_task_account_ownership": "0064_repository_issues",
            "0066_schedule_account_ownership": "0065_task_account_ownership",
            "0067_merge_release_account_ownership": (
                "0065_merge_usage_notifications", "0066_schedule_account_ownership"),
            "0065_merge_usage_notifications": "0065_merge_recommendation_usage",
            "0065_im_transport": ("0064_usage_attribution", "0063_plugin_recommendation"),
            "0066_merge_im_transport": ("0065_im_transport", "0065_merge_recommendation_usage"),
            "0068_merge_notification_account": (
                "0067_merge_release_account_ownership", "0066_merge_im_transport"),
            "0069_merge_public_main": ("0065_merge_feature_branches", "0068_merge_notification_account"),
        }
        for revision, parent in expected.items():
            self.assertEqual(script.get_revision(revision).down_revision, parent, revision)

    def test_both_baselines_can_upgrade_to_the_merge_head(self):
        # The migration tests exercise DDL. This test is intentionally limited
        # to graph traversal so it does not touch a configured business DB.
        script = ScriptDirectory.from_config(_config())
        for baseline in ("0065_merge_recommendation_usage", "0066_schedule_account_ownership",
                         "0065_merge_usage_notifications", "0067_merge_release_account_ownership",
                         "0065_im_transport", "0066_merge_im_transport", "0065_merge_feature_branches",
                         "0068_merge_notification_account", "0077_merge_public_runtime", "0078_account_task_projection",
                         "0080_merge_public_discovery", "0084_schedule_custom_rule"):
            path = list(script.iterate_revisions(CURRENT_HEAD, baseline))
            self.assertTrue(path, baseline)

    def test_existing_branch_databases_preserve_personal_configuration(self):
        for baseline in ("0065_merge_usage_notifications", "0066_merge_im_transport",
                         "0067_merge_release_account_ownership", "0065_merge_feature_branches",
                         "0068_merge_notification_account", "0077_merge_public_runtime", "0078_account_task_projection",
                         "0080_merge_public_discovery", "0084_schedule_custom_rule"):
            with self.subTest(baseline=baseline), tempfile.TemporaryDirectory(prefix="smoke-history-") as temp:
                database = Path(temp) / "test.db"
                with patch.dict(os.environ, {"DATABASE_URL": "sqlite+aiosqlite:///" + database.as_posix()}):
                    get_settings.cache_clear()
                    try:
                        command.upgrade(_config(), baseline)
                        engine = create_engine("sqlite:///" + database.as_posix())
                        try:
                            with engine.begin() as connection:
                                connection.execute(Client.__table__.insert().values(
                                    id="fixture-history-device", name="Preserved device",
                                    git_creds={"token": "fixture-history-token"}))
                        finally:
                            engine.dispose()
                        command.upgrade(_config(), "head")
                        command.upgrade(_config(), "head")
                        with closing(sqlite3.connect(database)) as connection:
                            self.assertEqual(connection.execute(
                                "SELECT version_num FROM alembic_version").fetchall(),
                                [(CURRENT_HEAD,)])
                            name, raw = connection.execute(
                                "SELECT name, git_creds FROM client WHERE id='fixture-history-device'").fetchone()
                            self.assertEqual(name, "Preserved device")
                            self.assertEqual([row[2] for row in connection.execute(
                                "PRAGMA index_info('ix_remote_screen_source_state_expiry')")],
                                ["source_client_id", "state", "expires_at"])
                            self.assertEqual(json.loads(raw), {"token": "fixture-history-token"})
                            self.assertIsNotNone(connection.execute(
                                "SELECT name FROM sqlite_master WHERE type='table' AND name='im_connection'").fetchone())
                            for table in ("legal_draft", "legal_version", "legal_receipt"):
                                self.assertEqual(connection.execute(f"SELECT count(*) FROM {table}").fetchone(), (0,))
                            self.assertIsNotNone(connection.execute(
                                "SELECT name FROM sqlite_master WHERE type='table' AND name='personal_conversation_relay'").fetchone())
                            self.assertIsNotNone(connection.execute(
                                "SELECT name FROM sqlite_master WHERE type='table' AND name='account_conversation_project'").fetchone())
                            columns = {row[1] for row in connection.execute(
                                "PRAGMA table_info(automation_execution_session)")}
                            self.assertTrue({"delivery_stream_id", "delivery_seq", "delivery_digest", "persisted_seq"} <= columns)
                    finally:
                        get_settings.cache_clear()


class SQLiteMergeCompatibilityTests(unittest.TestCase):
    def test_only_the_known_noop_marker_is_normalized(self):
        cases = (
            (["0066_schedule_account_ownership"], False,
             ["0066_schedule_account_ownership"]),
            (["unrecognized_revision"], False, ["unrecognized_revision"]),
            ([OLD_MERGE, "0065_merge_usage_notifications"], True,
             [CANONICAL_MERGE, "0065_merge_usage_notifications"]),
            ([OLD_MERGE, CANONICAL_MERGE], True, [CANONICAL_MERGE]),
        )
        for before, changed, after in cases:
            with self.subTest(before=before):
                engine = create_engine("sqlite://")
                try:
                    with engine.begin() as connection:
                        connection.exec_driver_sql(
                            "CREATE TABLE alembic_version "
                            "(version_num VARCHAR(32) NOT NULL PRIMARY KEY)")
                        for revision in before:
                            connection.exec_driver_sql(
                                "INSERT INTO alembic_version VALUES (?)", (revision,))
                        self.assertEqual(normalize_sqlite_merge_revision(connection), changed)
                        self.assertEqual(set(connection.exec_driver_sql(
                            "SELECT version_num FROM alembic_version").scalars()), set(after))
                        self.assertFalse(normalize_sqlite_merge_revision(connection))
                finally:
                    engine.dispose()

    def test_empty_sqlite_and_postgres_are_untouched(self):
        engine = create_engine("sqlite://")
        try:
            with engine.begin() as connection:
                self.assertFalse(normalize_sqlite_merge_revision(connection))
                self.assertEqual(connection.exec_driver_sql(
                    "SELECT name FROM sqlite_master WHERE type='table'").all(), [])
        finally:
            engine.dispose()
        postgres = Mock(dialect=SimpleNamespace(name="postgresql"))
        self.assertFalse(normalize_sqlite_merge_revision(postgres))
        self.assertEqual(postgres.mock_calls, [])

    def test_old_sqlite_marker_upgrades_to_single_head_without_replaying_business_migrations(self):
        from app.config import get_settings

        with tempfile.TemporaryDirectory(prefix="soduwork-merge-compat-") as directory:
            path = Path(directory) / ".smoke-merge.db"
            environment = {
                "DATABASE_URL": "sqlite+aiosqlite:///" + path.as_posix(),
                "AUTH_SECRET": "isolated-merge-compatibility-secret-20261024",
                "ADMIN_PASS": "isolated-merge-test-password",
                "SODUWORK_ENV": "development", "CLUSTER_REDIS_URL": "",
                "SODUWORK_DATA_ROOT": str(Path(directory) / "data"),
            }
            with patch.dict(os.environ, environment):
                get_settings.cache_clear()
                try:
                    command.upgrade(_config(), CANONICAL_MERGE)
                    with closing(sqlite3.connect(path)) as database, database:
                        database.execute(
                            "INSERT INTO app_user(id,username,password_hash,display_name,"
                            "org_id,role_id,is_super,is_active,positions,domains,auth_version) "
                            "VALUES('preserved-user','preserved-user','existing-hash',"
                            "'Existing person','existing-org','existing-role',0,1,'[]','[]',7)")
                        database.execute("UPDATE alembic_version SET version_num=?", (OLD_MERGE,))
                        before = [statement for statement in database.iterdump()
                                  if "alembic_version" not in statement]
                    for _ in range(2):
                        command.upgrade(_config(), "head")
                        with closing(sqlite3.connect(path)) as database:
                            self.assertEqual(database.execute(
                                "SELECT version_num FROM alembic_version").fetchall(),
                                [(CURRENT_HEAD,)])
                            self.assertEqual(database.execute(
                                "SELECT username FROM app_user WHERE id='preserved-user'").fetchone()[0],
                                "preserved-user")
                            self.assertIsNotNone(database.execute(
                                "SELECT name FROM sqlite_master WHERE type='table' AND name='im_connection'"
                            ).fetchone())
                finally:
                    get_settings.cache_clear()

    def test_legal_account_merge_preserves_data_from_either_installed_branch(self):
        for installed in ("0080_legal_publications", "0080_account_lifecycle", "both"):
            with self.subTest(installed=installed), tempfile.TemporaryDirectory(prefix="soduwork-legal-merge-") as folder:
                filename = Path(folder) / ".smoke-merge.db"
                environment = {"DATABASE_URL": "sqlite+aiosqlite:///" + filename.as_posix(),
                    "AUTH_SECRET": "isolated-legal-merge-secret", "ADMIN_PASS": "isolated-legal-merge-password",
                    "SODUWORK_ENV": "development", "CLUSTER_REDIS_URL": "", "SODUWORK_DATA_ROOT": str(Path(folder) / "data")}
                with patch.dict(os.environ, environment):
                    get_settings.cache_clear()
                    try:
                        config = _config()
                        parents = ("0080_legal_publications", "0080_account_lifecycle") if installed == "both" else (installed,)
                        for parent in parents:
                            command.upgrade(config, parent)
                        with closing(sqlite3.connect(filename)) as database, database:
                            database.execute("INSERT INTO account_conversation "
                                "(id,owner_user_id,source_client_id,source_session_id,title,archived,deleted,revision) "
                                "VALUES ('retained','owner','device','native','Preserved title',1,0,7)")
                            if "0080_account_lifecycle" in parents:
                                database.execute("UPDATE account_conversation SET lifecycle_revision=7")
                            if "0080_legal_publications" in parents:
                                database.execute("INSERT INTO legal_draft (kind,revision,payload,updated_by) "
                                    "VALUES ('terms',3,'{}','publisher')")
                                database.execute("INSERT INTO legal_version "
                                    "(id,kind,version,payload,digest,action,effective_at,published_at,published_by) "
                                    "VALUES ('original','terms','v1','{}','original-digest','accept','2026-01-01','2026-01-01','publisher')")
                                database.execute("INSERT INTO legal_receipt "
                                    "(id,user_id,version_id,action,locale,digest,device_id) "
                                    "VALUES ('receipt','owner','original','accept','en-US','original-digest','device')")
                        command.upgrade(config, "head")
                        command.upgrade(config, "head")
                        with closing(sqlite3.connect(filename)) as database:
                            self.assertEqual(database.execute("SELECT version_num FROM alembic_version").fetchall(), [(CURRENT_HEAD,)])
                            expected_revision = 7 if "0080_account_lifecycle" in parents else 0
                            self.assertEqual(database.execute("SELECT title,archived,deleted,revision,lifecycle_revision "
                                "FROM account_conversation").fetchall(), [("Preserved title", 1, 0, 7, expected_revision)])
                            if "0080_legal_publications" in parents:
                                self.assertEqual(database.execute("SELECT revision FROM legal_draft").fetchone(), (3,))
                                self.assertEqual(database.execute("SELECT digest FROM legal_version").fetchone(), ("original-digest",))
                                self.assertEqual(database.execute("SELECT version_id,action,locale,digest FROM legal_receipt").fetchone(),
                                    ("original", "accept", "en-US", "original-digest"))
                            else:
                                self.assertEqual(database.execute("SELECT count(*) FROM legal_version").fetchone(), (0,))
                    finally:
                        get_settings.cache_clear()


    def test_startup_merges_historical_heads_and_checks_exact_readiness(self):
        from app.config import get_settings

        with tempfile.TemporaryDirectory(prefix="soduwork-startup-merge-") as directory:
            path = Path(directory) / ".smoke-startup.db"
            url = "sqlite+aiosqlite:///" + path.as_posix()
            environment = {
                "DATABASE_URL": url,
                "AUTH_SECRET": "isolated-startup-merge-secret-20261024",
                "ADMIN_PASS": "isolated-merge-test-password",
                "SODUWORK_ENV": "development", "CLUSTER_REDIS_URL": "",
                "SODUWORK_DATA_ROOT": str(Path(directory) / "data"),
            }

            def set_markers(markers):
                with closing(sqlite3.connect(path)) as database, database:
                    database.execute("DELETE FROM alembic_version")
                    database.executemany("INSERT INTO alembic_version VALUES (?)",
                                         [(marker,) for marker in markers])

            def snapshot():
                with closing(sqlite3.connect(path)) as database:
                    markers = set(row[0] for row in database.execute(
                        "SELECT version_num FROM alembic_version"))
                    business = [statement for statement in database.iterdump()
                                if "alembic_version" not in statement]
                    return markers, business

            async def verify_startup():
                engine = create_async_engine(url)
                metadata = Mock(sorted_tables=[])
                ensure, backfill = Mock(), Mock()
                before = snapshot()[1]
                try:
                    markers = (CANONICAL_MERGE, "0065_merge_usage_notifications")
                    set_markers(markers)
                    with self.assertRaises(SchemaMigrationError):
                        await migrate_database(engine, metadata, ensure, backfill, mode="check")
                    self.assertEqual(snapshot()[0], set(markers))
                    for _ in range(2):
                        self.assertEqual(await migrate_database(
                            engine, metadata, ensure, backfill), CURRENT_HEAD)
                        current_markers, business = snapshot()
                        self.assertEqual(current_markers, {CURRENT_HEAD})
                        self.assertTrue(any("CREATE TABLE im_connection" in statement
                                            for statement in business))
                    head_business = snapshot()[1]
                    self.assertEqual(await migrate_database(
                        engine, metadata, ensure, backfill, mode="check"), CURRENT_HEAD)
                    metadata.create_all.assert_not_called()
                    ensure.assert_not_called()
                    backfill.assert_not_called()

                    # check mode must reject an extra marker even when the
                    # correct head is present, without rewriting either one.
                    markers = (CURRENT_HEAD, "0001_commercial_baseline")
                    set_markers(markers)
                    with self.assertRaises(SchemaMigrationError):
                        await migrate_database(engine, metadata, ensure, backfill, mode="check")
                    self.assertEqual(snapshot(), (set(markers), head_business))

                    # A provisional marker mixed with another revision must
                    # take the versioned route, never the schema-adoption path.
                    with patch.object(schema_migrations, "_upgrade_head",
                                      side_effect=RuntimeError("normal upgrade reached")):
                        with self.assertRaisesRegex(RuntimeError, "normal upgrade reached"):
                            await migrate_database(engine, metadata, ensure, backfill)
                    metadata.create_all.assert_not_called()
                    ensure.assert_not_called()
                    backfill.assert_not_called()

                    set_markers(("0001_commercial_baseline",))
                    with patch.object(schema_migrations, "_stamp_adopted_schema",
                                      side_effect=RuntimeError("legacy adoption reached")):
                        with self.assertRaisesRegex(RuntimeError, "legacy adoption reached"):
                            await migrate_database(engine, metadata, ensure, backfill)
                    metadata.create_all.assert_called_once()
                    ensure.assert_called_once()
                    backfill.assert_called_once()
                finally:
                    await engine.dispose()

            with patch.dict(os.environ, environment):
                get_settings.cache_clear()
                try:
                    command.upgrade(_config(), CANONICAL_MERGE)
                    with closing(sqlite3.connect(path)) as database, database:
                        database.execute(
                            "INSERT INTO app_user(id,username,password_hash,display_name,"
                            "org_id,role_id,is_super,is_active,positions,domains,auth_version) "
                            "VALUES('startup-user','startup-user','unchanged-hash',"
                            "'Existing person','existing-org','existing-role',0,1,'[]','[]',7)")
                    asyncio.run(verify_startup())
                finally:
                    get_settings.cache_clear()


if __name__ == "__main__":
    unittest.main()
