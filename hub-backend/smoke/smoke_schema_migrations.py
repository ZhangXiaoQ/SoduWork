"""Deterministic smoke test for clean bootstrap and pre-Alembic adoption."""
from __future__ import annotations

import os
import hashlib
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from contextlib import closing

from alembic.config import Config
from alembic.script import ScriptDirectory


ROOT = Path(__file__).resolve().parent.parent
PYTHON = sys.executable
_cfg = Config(str(ROOT / "alembic.ini"))
_cfg.set_main_option("script_location", str(ROOT / "migrations"))
EXPECTED_REVISION = ScriptDirectory.from_config(_cfg).get_current_head()
checks = 0
PLUGIN_IDENTITY_INDEXES = {
    "uq_automation_plugin_platform_key",
    "uq_automation_plugin_org_key",
}
PLUGIN_VERSION_INDEXES = {
    "uq_automation_plugin_version_name",
    "uq_automation_plugin_version_checksum",
}

def ok(condition: bool, message: str) -> None:
    global checks
    if not condition:
        raise AssertionError(message)
    checks += 1


def database_url(path: Path) -> str:
    return "sqlite+aiosqlite:///" + path.resolve().as_posix()


def run_python(code: str, path: Path, *, mode: str = "auto", expect_ok: bool = True) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url(path)
    env["DB_MIGRATION_MODE"] = mode
    result = subprocess.run(
        [PYTHON, "-c", code],
        cwd=ROOT,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=600,
    )
    if expect_ok and result.returncode != 0:
        raise AssertionError(result.stdout + result.stderr)
    if not expect_ok and result.returncode == 0:
        raise AssertionError("command unexpectedly succeeded")
    return result


def revision(path: Path) -> str:
    with closing(sqlite3.connect(path)) as connection:
        try:
            row = connection.execute("SELECT version_num FROM alembic_version").fetchone()
        except sqlite3.OperationalError:
            return ""
        return str(row[0] if row else "")


def table_count(path: Path) -> int:
    with closing(sqlite3.connect(path)) as connection:
        row = connection.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchone()
        return int(row[0] if row else 0)


def table_names(path: Path) -> set[str]:
    with closing(sqlite3.connect(path)) as connection:
        return {str(row[0]) for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()}


def column_names(path: Path, table: str) -> set[str]:
    with closing(sqlite3.connect(path)) as connection:
        return {str(row[1]) for row in connection.execute(
            'PRAGMA table_info("%s")' % table.replace('"', '""')
        ).fetchall()}


def unique_indexes(path: Path, table: str) -> set[str]:
    with closing(sqlite3.connect(path)) as connection:
        return {str(row[1]) for row in connection.execute(
            'PRAGMA index_list("%s")' % table.replace('"', '""')
        ).fetchall() if bool(row[2])}


INIT = """
import asyncio
from app.db import engine, init_db
async def main():
    await init_db()
    await engine.dispose()
asyncio.run(main())
"""
INIT_TWICE = """
import asyncio
from app.db import engine, init_db
async def main():
    await init_db()
    await init_db()
    await engine.dispose()
asyncio.run(main())
"""
CREATE_LEGACY = """
import asyncio
from app import automation_models, models, memory_record_models
from app.db import Base, engine
async def main():
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.execute(automation_models.RunnerNode.__table__.insert().values(
            id="legacy-runner", host="preserved-host", dispatch_mode="draining"))
    await engine.dispose()
asyncio.run(main())
"""


# asyncpg infers one placeholder from every SQL context in which it appears.
# Reusing the VARCHAR state parameter in a text comparison caused a real
# PostgreSQL startup failure even though SQLite accepted it. Keep the boolean
# activation decision as a distinct, unambiguous bind in both migration paths.
for migration in ScriptDirectory.from_config(_cfg).walk_revisions():
    ok(len(migration.revision) <= 64,
       f"migration ID exceeds PostgreSQL version-table width: {migration.revision}")

for migration_source in (
    ROOT / "app" / "db.py",
    ROOT / "migrations" / "versions" / "0005_device_security.py",
):
    source = migration_source.read_text(encoding="utf-8")
    ok(":state='active'" not in source,
       f"{migration_source.name} reuses a VARCHAR bind in the activation predicate")
    ok(":activate" in source and "COALESCE(activated_at,CURRENT_TIMESTAMP)" in source,
       f"{migration_source.name} does not preserve a stable activation timestamp")


with tempfile.TemporaryDirectory(prefix="soduwork-schema-") as directory:
    folder = Path(directory)

    clean = folder / "clean.db"
    run_python(INIT_TWICE, clean)
    ok(revision(clean) == EXPECTED_REVISION, "clean database did not reach head")
    names = table_names(clean)
    ok({"identity_provider", "identity_link", "alembic_version"}.issubset(names),
       "clean database is missing enterprise identity tables")
    ok({"model_runtime_lease", "model_runtime_metric"}.issubset(names),
       "clean database is missing indexed model runtime state tables")
    ok("ai_schedule_run" in names,
       "clean database is missing the immutable automation run ledger")
    ok("ai_usage_daily" in names,
       "clean database is missing the daily usage delta ledger")
    ok({"task_notification_outbox", "automation_plugin_recommendation"}.issubset(names),
       "merged feature migrations are missing notification or recommendation tables")
    ok({"dimension_key", "cost_known", "billing_user_id"}.issubset(
        column_names(clean, "ai_usage_daily")),
       "merged feature migrations are missing attributed usage fields")
    ok({"usage_event_id", "day_key", "total_tokens"}.issubset(
        column_names(clean, "ai_usage_daily")),
       "daily usage ledger is missing its event/date/counter columns")
    ok("idempotency_key" in column_names(clean, "ai_schedule_run"),
       "clean database is missing the scheduled-occurrence identity")
    ok("gate_snapshot" in column_names(clean, "automation_approval_decision"),
       "clean database cannot freeze approval evidence")
    with closing(sqlite3.connect(clean)) as connection:
        schedule_run_indexes = {row[1]: bool(row[2]) for row in connection.execute(
            "PRAGMA index_list(ai_schedule_run)")}
    ok(schedule_run_indexes.get("uq_ai_schedule_run_idempotency_key") is True,
       "clean database does not protect scheduled-occurrence identities")
    ok(PLUGIN_IDENTITY_INDEXES.issubset(unique_indexes(clean, "automation_plugin")),
       "clean database does not protect scoped plugin identities")
    ok(PLUGIN_VERSION_INDEXES.issubset(unique_indexes(clean, "automation_plugin_version")),
       "clean database does not protect immutable plugin versions")
    schedule_columns = column_names(clean, "ai_schedule")
    ok({"personal_plugin_version_policy", "personal_plugin_version",
        "personal_plugin_checksum"}.issubset(schedule_columns),
       "clean database is missing the verifiable personal-plugin schedule snapshot")
    ok(table_count(clean) >= 49, "clean database lost expected domain tables")
    run_python(INIT, clean, mode="check")
    ok(True, "check mode accepts a current database")

    empty = folder / "empty.db"
    result = run_python(INIT, empty, mode="check", expect_ok=False)
    ok("Database schema is not ready" in result.stderr, "check mode did not reject an empty database")

    legacy = folder / "legacy.db"
    run_python(CREATE_LEGACY, legacy)
    with closing(sqlite3.connect(legacy)) as connection:
        connection.execute("ALTER TABLE automation_runner_node DROP COLUMN management_state")
        connection.execute("DROP INDEX uq_memory_record_org_current")
        for rid, org, key in (("memory-current", "org-a", "default"),
                              ("memory-legacy", "org-a", "legacy"),
                              ("memory-child", "org-b", "default")):
            connection.execute(
                "INSERT INTO memory_record "
                "(id,scope,owner_user_id,org_id,memory_key,workspace_key,project_key,session_key,"
                "title,summary,fields,source_meta,archived,revision) "
                "VALUES (?,'org','',?,?,'','','',?,?,'{\"summary\":\"preserved\"}','{}',false,1)",
                (rid, org, key, rid, rid),
            )
        for run_id in ("legacy-run-a", "legacy-run-b"):
            connection.execute(
                "INSERT INTO ai_schedule_run "
                "(id,idempotency_key,schedule_id,org_id,owner_client_id,task_id,"
                "workflow_run_id,trigger,state,attempt,error,receipt,started_at,finished_at) "
                "VALUES (?,?,'legacy-schedule',NULL,'','','','timer','accepted',1,'','{}',"
                "CURRENT_TIMESTAMP,NULL)",
                (run_id, "old:" + run_id),
            )
        connection.execute(
            "DROP INDEX uq_ai_schedule_run_idempotency_key")
        connection.execute(
            "ALTER TABLE ai_schedule_run DROP COLUMN idempotency_key")
        connection.execute("ALTER TABLE task DROP COLUMN progress")
        connection.execute(
            "ALTER TABLE task ADD COLUMN flow_id VARCHAR(36) NOT NULL DEFAULT ''")
        connection.execute("DROP INDEX ix_client_auth_state")
        for column in ("secret_hash", "auth_state", "auth_version", "activated_at", "revoked_at"):
            connection.execute(f"ALTER TABLE client DROP COLUMN {column}")
        connection.execute("ALTER TABLE app_user DROP COLUMN auth_version")
        connection.execute("DROP TABLE daily_report")
        connection.execute(
            "CREATE TABLE daily_report ("
            "id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(36) NOT NULL, "
            "user_name VARCHAR(64) NOT NULL DEFAULT '', org_id VARCHAR(36), "
            "date VARCHAR(10) NOT NULL, content TEXT NOT NULL DEFAULT '', "
            "source VARCHAR(16) NOT NULL DEFAULT 'template', "
            "done_count INTEGER NOT NULL DEFAULT 0, "
            "progress_count INTEGER NOT NULL DEFAULT 0, "
            "active_count INTEGER NOT NULL DEFAULT 0, "
            "items JSON NOT NULL DEFAULT '[]', "
            "created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)"
        )
        connection.execute("CREATE INDEX ix_daily_report_date ON daily_report (date)")
        connection.execute("CREATE INDEX ix_daily_report_org_id ON daily_report (org_id)")
        connection.execute("CREATE INDEX ix_daily_report_user_id ON daily_report (user_id)")
        connection.execute(
            "INSERT INTO daily_report "
            "(id,user_id,user_name,date,content,source,done_count,progress_count,active_count,items) "
            "VALUES ('legacy-report','legacy-user','Legacy','2026-08-11','work','template',1,0,1,'[]')"
        )
        connection.execute(
            "INSERT INTO client "
            "(id, secret, user_ref, config, skills, model_keys, models, agent_models, git_creds, work_root) "
            "VALUES ('legacy-device', 'legacy-device-secret', 'legacy-user', '{}', '[]', '{}', '[]', '{}', '{}', '')")
        connection.execute("INSERT INTO app_setting (key, value) VALUES ('adoption-proof', 'preserved')")
        connection.commit()
    ok(revision(legacy) == "", "legacy fixture should not already have a migration version")
    run_python(INIT_TWICE, legacy)
    ok(revision(legacy) == EXPECTED_REVISION, "legacy database was not stamped at head")
    with closing(sqlite3.connect(legacy)) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(task)")}
        client_columns = {row[1] for row in connection.execute("PRAGMA table_info(client)")}
        report_columns = {row[1] for row in connection.execute(
            "PRAGMA table_info(daily_report)")}
        report_indexes = {row[1]: bool(row[2]) for row in connection.execute(
            "PRAGMA index_list(daily_report)")}
        migrated_report = connection.execute(
            "SELECT period_type, updated_at FROM daily_report WHERE id='legacy-report'"
        ).fetchone()
        migrated_device = connection.execute(
            "SELECT secret_hash, auth_state, secret FROM client WHERE id='legacy-device'"
        ).fetchone()
        migrated_runner = connection.execute(
            "SELECT host, dispatch_mode, management_state FROM automation_runner_node "
            "WHERE id='legacy-runner'"
        ).fetchone()
        runner_columns = {row[1]: row for row in connection.execute(
            "PRAGMA table_info(automation_runner_node)")}
        schedule_run_columns = {row[1] for row in connection.execute(
            "PRAGMA table_info(ai_schedule_run)")}
        decision_columns = {row[1] for row in connection.execute(
            "PRAGMA table_info(automation_approval_decision)")}
        schedule_run_indexes = {row[1]: bool(row[2]) for row in connection.execute(
            "PRAGMA index_list(ai_schedule_run)")}
        legacy_run_keys = connection.execute(
            "SELECT id,idempotency_key FROM ai_schedule_run ORDER BY id").fetchall()
        duplicate_schedule_run_rejected = False
        try:
            connection.execute(
                "UPDATE ai_schedule_run SET idempotency_key='legacy:legacy-run-a' "
                "WHERE id='legacy-run-b'")
            connection.commit()
        except sqlite3.IntegrityError:
            connection.rollback()
            duplicate_schedule_run_rejected = True
        value = connection.execute(
            "SELECT value FROM app_setting WHERE key='adoption-proof'"
        ).fetchone()
        memory_rows = connection.execute(
            "SELECT id,archived,revision,summary FROM memory_record ORDER BY id"
        ).fetchall()
        memory_duplicate_rejected = False
        try:
            connection.execute("UPDATE memory_record SET archived=false WHERE id='memory-legacy'")
            connection.commit()
        except sqlite3.IntegrityError:
            connection.rollback()
            memory_duplicate_rejected = True
    ok("progress" in columns, "legacy missing column was not reconciled")
    ok("flow_id" not in columns, "legacy retired task flow_id column was not removed")
    ok({"secret_hash", "auth_state", "auth_version"}.issubset(client_columns),
       "legacy device security columns were not reconciled")
    ok({"period_type", "updated_at"}.issubset(report_columns),
       "legacy periodic report columns were not reconciled")
    ok(report_indexes.get("ix_daily_report_period_type") is False,
       "legacy periodic report lookup index was not created")
    ok(report_indexes.get("uq_personal_report_period") is True,
       "legacy periodic report uniqueness was not created")
    ok(bool(migrated_report and migrated_report[0] == "daily" and migrated_report[1]),
       "legacy daily report was not preserved and backfilled")
    ok(migrated_device == (
        hashlib.sha256(b"legacy-device-secret").hexdigest(), "active", None),
       "legacy plaintext device key was not migrated to a digest")
    ok(migrated_runner == ("preserved-host", "draining", ""),
       "legacy adoption lost runner facts or changed existing dispatch policy")
    ok(runner_columns["management_state"][3] == 1,
       "legacy runner management policy must not be nullable")
    ok("gate_snapshot" in decision_columns,
       "legacy database cannot freeze approval evidence")
    ok("idempotency_key" in schedule_run_columns,
       "legacy schedule ledger did not gain occurrence identities")
    ok(schedule_run_indexes.get("uq_ai_schedule_run_idempotency_key") is True,
       "legacy schedule ledger did not gain occurrence uniqueness")
    ok(PLUGIN_IDENTITY_INDEXES.issubset(unique_indexes(legacy, "automation_plugin")),
       "legacy adoption does not protect scoped plugin identities")
    ok(PLUGIN_VERSION_INDEXES.issubset(unique_indexes(legacy, "automation_plugin_version")),
       "legacy adoption does not protect immutable plugin versions")
    ok(legacy_run_keys == [
        ("legacy-run-a", "legacy:legacy-run-a"),
        ("legacy-run-b", "legacy:legacy-run-b"),
    ], "legacy schedule receipts were not preserved and backfilled")
    ok(duplicate_schedule_run_rejected,
       "legacy schedule occurrence identities are not unique")
    ok(value == ("preserved",), "legacy data was not preserved during adoption")
    ok(memory_rows == [("memory-child", 0, 1, "memory-child"),
                       ("memory-current", 0, 1, "memory-current"),
                       ("memory-legacy", 1, 2, "memory-legacy")],
       "legacy adoption lost organization memory content or merged distinct organizations")
    ok("uq_memory_record_org_current" in unique_indexes(legacy, "memory_record"),
       "legacy adoption skipped the current organization memory index")
    ok(memory_duplicate_rejected, "legacy organization memory can reappear beside the current summary")

    provisional = folder / "provisional.db"
    run_python(CREATE_LEGACY, provisional)
    with closing(sqlite3.connect(provisional)) as connection:
        connection.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
        connection.execute(
            "INSERT INTO alembic_version (version_num) VALUES ('0001_commercial_baseline')")
        connection.execute(
            "INSERT INTO app_setting (key, value) VALUES ('provisional-proof', 'preserved')")
        connection.commit()
    run_python(INIT_TWICE, provisional)
    ok(revision(provisional) == EXPECTED_REVISION,
       "pre-v1 provisional revision was not safely adopted at head")
    with closing(sqlite3.connect(provisional)) as connection:
        proof = connection.execute(
            "SELECT value FROM app_setting WHERE key='provisional-proof'").fetchone()
    ok(proof == ("preserved",), "provisional adoption did not preserve business data")

    retired_flow = folder / "retired-flow.db"
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url(retired_flow)
    before = subprocess.run(
        [PYTHON, "-m", "alembic", "upgrade", "0013_client_full_updates"],
        cwd=ROOT, env=env, text=True, encoding="utf-8", errors="replace",
        capture_output=True, timeout=600,
    )
    ok(before.returncode == 0, "could not build the retired-flow fixture: "
       + before.stdout + before.stderr)
    with closing(sqlite3.connect(retired_flow)) as connection:
        connection.execute(
            "ALTER TABLE task ADD COLUMN flow_id VARCHAR(36) NOT NULL DEFAULT ''")
        connection.commit()
    run_python(INIT_TWICE, retired_flow)
    with closing(sqlite3.connect(retired_flow)) as connection:
        retired_columns = {row[1] for row in connection.execute("PRAGMA table_info(task)")}
    ok(revision(retired_flow) == EXPECTED_REVISION,
       "versioned database with retired flow_id did not reach head")
    ok("flow_id" not in retired_columns,
       "versioned migration did not remove retired task flow_id")

    duplicate = folder / "duplicate-node.db"
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url(duplicate)
    before = subprocess.run(
        [PYTHON, "-m", "alembic", "upgrade", "0010_schedule_creator"],
        cwd=ROOT, env=env, text=True, encoding="utf-8", errors="replace",
        capture_output=True, timeout=600,
    )
    ok(before.returncode == 0, "could not build the pre-idempotency fixture: "
       + before.stdout + before.stderr)
    with closing(sqlite3.connect(duplicate)) as connection:
        values = (
            "run-duplicate", "implement", "ai", 1, "cancelled",
            "{}", "{}", "{}", "run-duplicate:implement:1", "", "",
        )
        connection.execute(
            "INSERT INTO automation_node_run "
            "(id,run_id,node_key,node_type,attempt,state,input,output,executor,"
            "idempotency_key,lease_owner,error) VALUES ('node-a',?,?,?,?,?,?,?,?,?,?,?)",
            values)
        connection.execute(
            "INSERT INTO automation_node_run "
            "(id,run_id,node_key,node_type,attempt,state,input,output,executor,"
            "idempotency_key,lease_owner,error) VALUES ('node-b',?,?,?,?,?,?,?,?,?,?,?)",
            values)
        connection.commit()
    run_python(INIT, duplicate)
    ok(revision(duplicate) == EXPECTED_REVISION,
       "database with historical duplicate nodes did not reach head")
    with closing(sqlite3.connect(duplicate)) as connection:
        keys = [row[0] for row in connection.execute(
            "SELECT idempotency_key FROM automation_node_run ORDER BY id").fetchall()]
        preserved = connection.execute(
            "SELECT COUNT(*) FROM automation_node_run").fetchone()[0]
        duplicate_rejected = False
        try:
            connection.execute(
                "UPDATE automation_node_run SET idempotency_key=? WHERE id='node-b'", (keys[0],))
            connection.commit()
        except sqlite3.IntegrityError:
            connection.rollback()
            duplicate_rejected = True
    ok(preserved == 2 and len(set(keys)) == 2,
       "migration did not preserve and disambiguate historical node attempts")
    ok(duplicate_rejected, "node idempotency key is not protected by database uniqueness")

    duplicate_plugin = folder / "duplicate-plugin.db"
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url(duplicate_plugin)
    before = subprocess.run(
        [PYTHON, "-m", "alembic", "upgrade", "0034_ai_usage_ledger"],
        cwd=ROOT, env=env, text=True, encoding="utf-8", errors="replace",
        capture_output=True, timeout=600,
    )
    ok(before.returncode == 0, "could not build the pre-plugin-identity fixture: "
       + before.stdout + before.stderr)
    with closing(sqlite3.connect(duplicate_plugin)) as connection:
        for plugin_id in ("duplicate-plugin-a", "duplicate-plugin-b"):
            connection.execute(
                "INSERT INTO automation_plugin "
                "(id,org_id,key,name,description,source_kind,enabled,created_by) "
                "VALUES (?,NULL,'duplicate-key','Duplicate','','soduwork',0,'smoke')",
                (plugin_id,),
            )
        connection.commit()
    failed = run_python(INIT, duplicate_plugin, expect_ok=False)
    failure = failed.stdout + failed.stderr
    ok("duplicate records exist" in failure,
       "plugin identity migration did not explain duplicate legacy records")
    ok(revision(duplicate_plugin) == "0034_ai_usage_ledger",
       "failed plugin identity migration advanced the schema revision")

    env = os.environ.copy()
    env["DATABASE_URL"] = database_url(clean)
    drift = subprocess.run(
        [PYTHON, "-m", "alembic", "check"],
        cwd=ROOT,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=600,
    )
    ok(drift.returncode == 0, "metadata drift detected: " + drift.stdout + drift.stderr)

print(f"schema migrations: {checks} checks passed")
