"""Alembic environment for SoduWork's async SQLAlchemy database."""
from __future__ import annotations

import asyncio

from alembic import context
from sqlalchemy import Column, MetaData, String, Table, inspect, pool, text
from sqlalchemy.ext.asyncio import async_engine_from_config

from app import (automation_models, models, session_memory_models, project_context_models,  # noqa: F401
                 memory_record_models, library_models, conversation_handoff_models,
                 account_models, account_privacy_models, mail_models, legal_models,
                 account_conversation_models,
                 remote_screen_models,
                 repository_issue_models, release_note_models,
                 task_notification_models, im_models, model_runtime_models)  # register metadata
from app.config import get_settings
from app.db import Base
from app.schema_migrations import normalize_sqlite_merge_revision


config = context.config
target_metadata = Base.metadata


def _database_url() -> str:
    return get_settings().database_url


def _include_object(obj, name: str, type_: str, reflected: bool, compare_to) -> bool:
    """Allow deterministic baseline generation by bounded domain.

    Normal upgrades do not pass ``-x scope`` and therefore include everything.
    """
    scope = context.get_x_argument(as_dictionary=True).get("scope", "all")
    if scope == "all":
        return True
    table_name = name if type_ == "table" else getattr(getattr(obj, "table", None), "name", "")
    is_automation = str(table_name).startswith("automation_")
    if scope == "core":
        return not is_automation
    if scope == "automation":
        return is_automation
    raise ValueError(f"Unknown Alembic metadata scope: {scope}")


def run_migrations_offline() -> None:
    url = _database_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        render_as_batch=url.lower().startswith("sqlite"),
        include_object=_include_object,
    )
    with context.begin_transaction():
        context.run_migrations()


def _run_migrations(connection) -> None:
    if connection.dialect.name == "postgresql":
        # A published main revision exceeds Alembic's default 32 characters.
        # Retain its identity on both fresh installations and existing databases.
        version = Table("alembic_version", MetaData(),
                        Column("version_num", String(64), primary_key=True))
        version.create(connection, checkfirst=True)
        column = next(item for item in inspect(connection).get_columns("alembic_version")
                      if item["name"] == "version_num")
        if getattr(column["type"], "length", 0) and column["type"].length < 64:
            connection.execute(text("ALTER TABLE alembic_version ALTER COLUMN version_num TYPE VARCHAR(64)"))
        # Alembic must own the migration transaction after this schema preflight.
        connection.commit()
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        render_as_batch=connection.dialect.name == "sqlite",
        include_object=_include_object,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    section = config.get_section(config.config_ini_section) or {}
    section["sqlalchemy.url"] = _database_url()
    connectable = async_engine_from_config(
        section,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    try:
        async with connectable.connect() as connection:
            await connection.run_sync(_run_migrations)
    finally:
        await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
