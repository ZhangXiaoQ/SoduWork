"""Asynchronous database engine, sessions, metadata, and migration entry point."""
import os
import sys
import tempfile

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import get_settings
from .services.database_telemetry import ObservedAsyncAdaptedQueuePool, install as observe_database

settings = get_settings()


def _smoke_db_guard(url: str) -> None:
    """Reject automated tests against databases that are not visibly disposable.

    Integration tests against a live database require an explicit
    SMOKE_ALLOW_LIVE_DB opt-in. Ordinary tests must use an isolated database.
    """
    entry = str(sys.argv[0] or "").replace("\\", "/").lower()
    name = entry.rsplit("/", 1)[-1]
    testing = (name.startswith(("smoke_", "e2e_", "test_"))
               or name in {"pytest", "pytest.exe", "py.test", "py.test.exe"}
               or "/unittest/" in entry or "/pytest/" in entry
               or bool(os.environ.get("PYTEST_CURRENT_TEST")))
    if not testing:
        return
    if os.environ.get("SMOKE_ALLOW_LIVE_DB"):
        return
    low = url.lower()
    temp_root = os.path.abspath(tempfile.gettempdir()).replace("\\", "/").lower().rstrip("/") + "/"
    if any(x in low for x in (":memory:", ".smoke", "smoke-", "test.db", "/tmp/", temp_root)):
        return
    raise RuntimeError(
        "自动测试不许直连业务库：当前 DATABASE_URL 指向 %s。\n"
        "请在脚本开头设自己的临时库（os.environ['DATABASE_URL']='sqlite+aiosqlite:///.smoke-xxx.db'），"
        "或确实要打真库时显式加环境变量 SMOKE_ALLOW_LIVE_DB=1。"
        % (low.split("@")[-1] or low))


_smoke_db_guard(settings.database_url)


class Base(DeclarativeBase):
    pass


# Pool PostgreSQL connections with health checks; retain SQLite's dialect defaults.
_engine_kwargs = {"future": True, "echo": False}
if "postgresql" in settings.database_url.lower():
    _engine_kwargs.update(
        poolclass=ObservedAsyncAdaptedQueuePool,
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
        pool_timeout=settings.db_pool_timeout,
        connect_args={"server_settings": {
            "application_name": ("soduwork-hub:" + settings.hub_node_id)[:63],
            "statement_timeout": str(settings.db_statement_timeout_ms),
        }},
        pool_pre_ping=True,   # Check connection health before reuse to detect server-side disconnects.
        pool_recycle=settings.db_pool_recycle,    # Recycle connections every 30 minutes to avoid server or middleware idle timeouts.
    )
    # Smoke and E2E scripts may call asyncio.run repeatedly, creating a new loop each time.
    # Pooled asyncpg connections remain bound to their original loop.
    # Reusing them after that loop closes raises event-loop errors.
    # Disable pooling in script processes; the long-lived service loop retains its pool.
    if os.path.basename(str(sys.argv[0] or "")).lower().startswith(("smoke_", "e2e_")):
        from sqlalchemy.pool import NullPool
        _engine_kwargs = {"future": True, "echo": False, "poolclass": NullPool}

engine = create_async_engine(settings.database_url, **_engine_kwargs)
observe_database(engine)
from .services.auth_cache_transactions import AuthSession
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession,
                                  sync_session_class=AuthSession)


async def init_db() -> None:
    """Run versioned schema migration or verification, including one-time adoption of pre-Alembic
    databases.
    """
    from . import models  # noqa: F401  Register ORM models in Base.metadata.
    from . import automation_models  # noqa: F401  Register environment, approval, and plugin runtime models.
    from . import session_memory_models  # noqa: F401
    from . import project_context_models  # noqa: F401  Register versioned project context and accepted memory.
    from . import memory_record_models  # noqa: F401  Register multidimensional memory records.
    from . import library_models  # noqa: F401  Register document-library models.
    from . import conversation_handoff_models  # noqa: F401  durable transfer fences
    from . import account_conversation_models  # noqa: F401  cross-device conversation projection
    from . import remote_screen_models  # noqa: F401  read-only screen grants
    from . import account_models, account_privacy_models, mail_models, legal_models  # noqa: F401
    from . import repository_issue_models  # noqa: F401
    from . import task_notification_models  # noqa: F401
    from . import im_models  # noqa: F401  opt-in IM transport receipts
    from . import model_runtime_models  # noqa: F401  indexed model admission leases and metrics
    from .schema_migrations import migrate_database

    await migrate_database(
        engine,
        Base.metadata,
        _ensure_columns,
        _backfill_data,
        mode=settings.db_migration_mode,
    )


# Compatibility columns used only during adoption of pre-Alembic databases.
# Existing columns are unchanged; normal versioned upgrades use Alembic.
_WANT_COLUMNS = {
    "attachment": [
        # Associate new evidence with its execution and workflow node while retaining legacy compatibility.
        ("role", "VARCHAR(24) DEFAULT 'input'"),
        ("source_ref", "VARCHAR(180) DEFAULT ''"),
        ("workflow_run_id", "VARCHAR(36) DEFAULT ''"),
        ("node_run_id", "VARCHAR(36) DEFAULT ''"),
        ("evidence_meta", "{json}"),
    ],
    "automation_environment": [
        # Store explicit environment promotion policies rather than infer behavior from names.
        ("promotion_policy", "{json}"),
        ("acceptance_policy_id", "VARCHAR(36) DEFAULT ''"),
    ],
    "automation_runner_node": [
        # Adopt per-Runner authentication fields in legacy databases.
        ("secret_hash", "VARCHAR(64) DEFAULT ''"),
        ("auth_state", "VARCHAR(16) DEFAULT ''"),
        # Pre-Alembic adoption must preserve the same lifecycle boundary as 0060.
        ("management_state", "VARCHAR(24) NOT NULL DEFAULT ''"),
        # Preserve the enrollment display name separately from heartbeat host metadata.
        ("enroll_name", "VARCHAR(80) DEFAULT ''"),
        # Substrate-neutral capabilities reported by the Runner.
        ("capabilities", "{json}"),
        # Advertised process capacity; live reservations stay in Hub memory.
        ("max_concurrent", "INTEGER DEFAULT 1"),
    ],
    "automation_plugin_installation": [
        # Version-bound, non-secret employee preferences and real probe state.
        ("config", "{json}"),
        ("setup_state", "VARCHAR(24) DEFAULT 'ready'"),
        ("verified_at", "{ts}"),
    ],
    "task": [
        ("priority", "VARCHAR(16) DEFAULT 'normal'"),
        ("start_at", "{ts}"),
        ("due_at", "{ts}"),
        ("actual_start_at", "{ts}"),
        ("actual_end_at", "{ts}"),
        ("tags", "{json}"),
        ("created_by", "VARCHAR(36)"),
        ("created_by_name", "VARCHAR(64) DEFAULT ''"),
        ("assignee_user_id", "VARCHAR(36)"),
        ("recur", "VARCHAR(16)"),
        ("recur_at", "{ts}"),
        ("progress", "{json}"),
        ("domain_id", "VARCHAR(64) DEFAULT ''"),
        ("pool_org_id", "VARCHAR(36)"),
        # Output location and reviewer attribution for AI-output acceptance.
        ("artifact_url", "VARCHAR(600) DEFAULT ''"),
        ("reviewed_at", "{ts}"),
        ("reviewed_by", "VARCHAR(36)"),
        ("reviewed_by_name", "VARCHAR(64) DEFAULT ''"),
        ("project_id", "VARCHAR(36)"),
        ("deps", "{json}"),
        ("requester_user_id", "VARCHAR(36)"),
        ("requester_name", "VARCHAR(64) DEFAULT ''"),
        ("requester_contact", "VARCHAR(200) DEFAULT ''"),
        ("remind_at", "{ts}"),
        ("reminded", "BOOLEAN"),
        # Mapped repository identity and the original external repository name.
        ("repo_id", "VARCHAR(36) DEFAULT ''"),
        ("ext_repo", "VARCHAR(200) DEFAULT ''"),
        ("ms_auto", "BOOLEAN"),          # Automatic milestone progression is disabled for NULL or zero.
        ("work_scenario_key", "VARCHAR(80) DEFAULT ''"),
        ("work_scenario_name", "VARCHAR(100) DEFAULT ''"),
        ("work_routing", "{json}"),
    ],
    "ai_schedule": [
        ("start_date", "DATE"),
        ("end_date", "DATE"),
        ("model_name", "VARCHAR(300) NOT NULL DEFAULT ''"),
        ("created_by", "VARCHAR(36)"),
        ("time_zone", "VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai'"),
        ("required_capabilities", "{json} NOT NULL DEFAULT '[]'"),
        ("retry_limit", "INTEGER DEFAULT 2"),
        ("retry_delay_minutes", "INTEGER DEFAULT 5"),
        ("retry_count", "INTEGER DEFAULT 0"),
        ("next_retry_at", "{ts}"),
        ("personal_plugin_key", "VARCHAR(64) NOT NULL DEFAULT ''"),
        ("personal_plugin_version_policy", "VARCHAR(16) NOT NULL DEFAULT 'latest'"),
        ("personal_plugin_version", "VARCHAR(40) NOT NULL DEFAULT ''"),
        ("personal_plugin_checksum", "VARCHAR(64) NOT NULL DEFAULT ''"),
    ],
    "ai_schedule_run": [
        ("idempotency_key", "VARCHAR(180) DEFAULT ''"),
    ],
    "daily_report": [
        ("period_type", "VARCHAR(16) NOT NULL DEFAULT 'daily'"),
        ("updated_at", "{ts} NOT NULL DEFAULT {now}"),
    ],
    # Legacy project grouping and repository URL fields.
    "project": [
        ("grp", "VARCHAR(64) DEFAULT ''"),
        ("repo_url", "VARCHAR(512) DEFAULT ''"),
        ("ext_project_id", "VARCHAR(64) DEFAULT ''"),   # Linked project identity in an external execution system.
    ],
    # Adopt repository columns absent from pre-Alembic schemas.
    "repo": [
        ("source_repository_id", "VARCHAR(36) DEFAULT ''"),
        ("server_dir", "VARCHAR(400) DEFAULT ''"),
        ("merge_branch", "VARCHAR(120) DEFAULT ''"),
        ("deploy_targets", "TEXT DEFAULT '[]'"),
        ("ai_work_dir", "VARCHAR(400) DEFAULT ''"),   # AI execution directory, separate from server_dir.
        ("dev_flow", "{json}"),                       # Repository development overrides; empty settings inherit global defaults.
        ("scm", "VARCHAR(16) DEFAULT 'git'"),         # git or gerrit; Gerrit uses refs/for review flows.
        ("gerrit_base", "VARCHAR(300) DEFAULT ''"),
        ("route_keywords", "{json}"),                 # Keyword and layer-based repository routing.
        ("route_layer", "VARCHAR(16) DEFAULT ''"),
        ("route_priority", "INTEGER DEFAULT 0"),
    ],
    # Include milestone compatibility columns for databases where the table already exists.
    # create_all alone cannot extend an existing table during legacy adoption.
    "milestone": [
        ("src_task_id", "VARCHAR(36) DEFAULT ''"),
        # Per-stage agent and model overrides; empty values inherit task dispatch choices.
        ("agent_id", "VARCHAR(64) DEFAULT ''"),
        ("agent_type", "VARCHAR(16) DEFAULT ''"),
        ("model", "VARCHAR(120) DEFAULT ''"),
    ],
    "client": [
        ("secret", "VARCHAR(64)"),
        ("secret_hash", "VARCHAR(64) DEFAULT ''"),
        ("auth_state", "VARCHAR(16) DEFAULT 'pending'"),
        ("auth_version", "INTEGER DEFAULT 1"),
        ("activated_at", "{ts}"),
        ("revoked_at", "{ts}"),
        # Personal skill selections constrained by the administrative allowlist.
        ("skills", "{json}"),
        # Personal MCP connections are injected only into the owner's tasks; credentials remain write-only.
        ("mcp_servers", "{json}"),
        # Names of organization MCP connections selected by this user.
        ("mcp_enabled", "{json}"),
        # Personal provider keys, custom models, and Git/Gerrit credentials.
        # Store these per client and never return plaintext credentials through APIs.
        ("model_keys", "{json}"),
        ("models", "{json}"),

        ("agent_models", "{json}"),
        ("git_creds", "{json}"),



        ("work_root", "VARCHAR(400) DEFAULT ''"),
    ],
    "position": [
        ("org_id", "VARCHAR(36)"),
        ("category", "VARCHAR(40) DEFAULT ''"),
        ("description", "VARCHAR(400) DEFAULT ''"),
        ("competencies", "{json}"),
    ],
    "app_user": [
        ("auth_version", "INTEGER DEFAULT 1"),
        ("positions", "{json}"),
        ("domains", "{json}"),
    ],
    "integration": [
        ("last_pull_at", "{ts}"),
        ("last_pull_ok", "BOOLEAN"),
        ("last_pull_error", "VARCHAR(512)"),
        ("last_pull_count", "INTEGER DEFAULT 0"),
        ("repository_sync_at", "{ts}"),
        ("repository_sync_ok", "BOOLEAN"),
        ("repository_sync_error", "VARCHAR(512)"),
        ("repository_sync_count", "INTEGER DEFAULT 0"),

        ("last_ingest_at", "{ts}"),
    ],
}










_LEGACY_DROP = {
    "task": ["skill_id", "executor", "candidates", "agent_state", "attempts",
             "escalated", "plan", "needs_plan", "flow_id"],
}


def _ensure_columns(conn) -> None:
    from sqlalchemy import inspect, text
    is_pg = conn.dialect.name == "postgresql"
    ts = "TIMESTAMP WITH TIME ZONE" if is_pg else "DATETIME"
    json_t = "JSONB" if is_pg else "TEXT"
    now = "CURRENT_TIMESTAMP" if is_pg else "'1970-01-01 00:00:00'"
    insp = inspect(conn)
    for table, cols in _WANT_COLUMNS.items():
        try:
            existing = {c["name"] for c in insp.get_columns(table)}
        except Exception:
            continue  # The table may be absent in an incomplete legacy schema.
        for name, ddl in cols:
            if name in existing:
                continue
            typ = ddl.format(ts=ts, json=json_t, now=now)
            conn.execute(text(f'ALTER TABLE {table} ADD COLUMN {name} {typ}'))
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_client_auth_state ON client (auth_state)"))
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_daily_report_period_type "
        "ON daily_report (period_type)"))
    if is_pg:
        unique_names = {str(item.get("name") or "")
                        for item in insp.get_unique_constraints("daily_report")}
        if "uq_personal_report_period" not in unique_names:
            conn.execute(text(
                "ALTER TABLE daily_report ADD CONSTRAINT uq_personal_report_period "
                "UNIQUE (user_id, period_type, date)"))
    else:
        conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_personal_report_period "
            "ON daily_report (user_id, period_type, date)"))
    # A pre-Alembic database is stamped at head after this one-time adapter.
    # Enforce the same plugin identities as revision 0035 before that stamp.
    if (insp.has_table("automation_plugin")
            and insp.has_table("automation_plugin_version")):
        duplicate_checks = (
            ("platform plugin key",
             'SELECT "key", COUNT(*) FROM automation_plugin '
             'WHERE org_id IS NULL GROUP BY "key" HAVING COUNT(*) > 1 LIMIT 1'),
            ("organization plugin key",
             'SELECT org_id, "key", COUNT(*) FROM automation_plugin '
             'WHERE org_id IS NOT NULL GROUP BY org_id, "key" '
             'HAVING COUNT(*) > 1 LIMIT 1'),
            ("plugin semantic version",
             'SELECT plugin_id, version, COUNT(*) FROM automation_plugin_version '
             'GROUP BY plugin_id, version HAVING COUNT(*) > 1 LIMIT 1'),
            ("plugin package checksum",
             'SELECT plugin_id, checksum, COUNT(*) FROM automation_plugin_version '
             'GROUP BY plugin_id, checksum HAVING COUNT(*) > 1 LIMIT 1'),
        )
        for label, statement in duplicate_checks:
            duplicate = conn.execute(text(statement)).first()
            if duplicate:
                raise RuntimeError(
                    f"Database contains duplicate {label}: {tuple(duplicate)}. "
                    "Resolve it explicitly before adopting the current schema.")
        for statement in (
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_plugin_platform_key "
            "ON automation_plugin (key) WHERE org_id IS NULL",
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_plugin_org_key "
            "ON automation_plugin (org_id, key) WHERE org_id IS NOT NULL",
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_plugin_version_name "
            "ON automation_plugin_version (plugin_id, version)",
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_plugin_version_checksum "
            "ON automation_plugin_version (plugin_id, checksum)",
        ):
            conn.execute(text(statement))
    # Legacy adoption is stamped at head: create the same additive performance
    # indexes here too, otherwise those databases would silently miss revision 0037.
    hot_indexes = {
        "ix_task_owner_state_updated",
        "ix_task_event_timeline",
        "ix_task_comment_timeline",
        "ix_workflow_outbox_due",
        "ix_workflow_task_latest",
        "ix_node_run_attempt",
        "ix_execution_task_latest",
        "ix_execution_runner_active",
    }
    for table in Base.metadata.tables.values():
        for index in table.indexes:
            if index.name in hot_indexes:
                index.create(conn, checkfirst=True)
    for table, names in _LEGACY_DROP.items():
        try:
            existing = {c["name"] for c in insp.get_columns(table)}
        except Exception:
            continue
        for name in names:
            if name not in existing:
                continue
            try:
                conn.execute(text(f'ALTER TABLE {table} DROP COLUMN {name}'))
            except Exception:
                pass  # SQLite versions before 3.35 lack DROP COLUMN; unsupported legacy constraints require separate migration.
    # create_all does not widen existing VARCHAR columns; older task_event.kind fields may be too short.
    # Widen only undersized fields so long approval-event names can be persisted idempotently.
    if is_pg:
        try:
            columns = {c["name"]: c for c in insp.get_columns("task_event")}
            length = getattr(columns.get("kind", {}).get("type"), "length", None)
            if length is not None and length < 64:
                conn.execute(text(
                    "ALTER TABLE task_event ALTER COLUMN kind TYPE VARCHAR(64)"))
        except Exception:
            raise  # Fail migration rather than start with audit fields that cannot record approval events.


def _backfill_data(conn) -> None:
    """Backfill missing start_at from creation time and completed-task actual_end_at from update
    time. Preserve existing schedules and keep repeated execution idempotent.
    """
    import hashlib
    from importlib import import_module
    from sqlalchemy import text

    # Legacy adoption is stamped at head; preserve the same usage baseline as
    # the versioned migration before accepting new cumulative reports.
    import_module("migrations.versions.0042_usage_daily_deltas").backfill_daily(conn)
    # Legacy adoption skips numbered revisions, so apply the same immutable
    # usage-attribution shape before stamping the database at the integrated head.
    import_module("migrations.versions.0064_usage_attribution").adopt(conn)

    # create_all does not add indexes to existing tables. Adoption skips the
    # numbered revisions, so preserve and retire duplicates before stamping.
    import_module("migrations.versions.0052_org_memory_singleton").consolidate_and_enforce(conn)
    import_module("migrations.versions.0053_unified_requirements").adopt(conn)

    # Pre-Alembic adoption must apply the same one-way device migration as
    # revision 0005 before the legacy database is stamped at the current head.
    rows = conn.execute(text(
        "SELECT id, secret, user_ref, secret_hash FROM client"
    )).mappings().all()
    for row in rows:
        raw = str(row.get("secret") or "")
        digest = str(row.get("secret_hash") or "")
        if raw and not digest:
            digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        state = "active" if digest and row.get("user_ref") else "pending"
        conn.execute(text(
            "UPDATE client SET secret_hash=:digest, auth_state=:state, secret=NULL, "
            "activated_at=CASE WHEN :activate "
            "THEN COALESCE(activated_at,CURRENT_TIMESTAMP) ELSE NULL END "
            "WHERE id=:id"
        ), {"digest": digest, "state": state, "activate": state == "active", "id": row["id"]})
    for sql in (
        "UPDATE task SET start_at = created_at WHERE start_at IS NULL AND created_at IS NOT NULL",
        "UPDATE task SET actual_end_at = updated_at WHERE actual_end_at IS NULL AND status = 'done' AND updated_at IS NOT NULL",
        "UPDATE daily_report SET period_type = 'daily' WHERE period_type IS NULL OR period_type = ''",
        "UPDATE daily_report SET updated_at = COALESCE(created_at, CURRENT_TIMESTAMP) WHERE updated_at IS NULL",
        ("UPDATE ai_schedule SET created_by = (SELECT client.user_ref FROM client "
         "WHERE client.id = ai_schedule.owner_client_id) "
         "WHERE created_by IS NULL OR created_by = ''"),
    ):
        conn.execute(text(sql))

    # Pre-Alembic ledgers predate occurrence identities. Backfill before adding the unique
    # index so adoption remains safe even when the historical table already has many rows.
    # Adoption must fail before stamping if required data or uniqueness repairs fail.
    conn.execute(text(
        "UPDATE ai_schedule_run "
        "SET idempotency_key = 'legacy:' || id "
        "WHERE idempotency_key IS NULL OR idempotency_key = ''"))
    conn.execute(text(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_schedule_run_idempotency_key "
        "ON ai_schedule_run (idempotency_key)"))


async def get_session():
    async with SessionLocal() as session:
        yield session


from .services import automation_inbox_events  # noqa: E402,F401 - post-commit hints on every writer
from .services import cloud_sync_notifications  # noqa: E402
cloud_sync_notifications.install()
