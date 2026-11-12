"""Account lifecycle migration on a private SQLite database and offline PG DDL."""
import importlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from alembic.migration import MigrationContext
from alembic.operations import Operations


BACKEND = Path(__file__).resolve().parents[1]
CHECK = r'''
import os
from pathlib import Path
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
import sqlalchemy as sa
filename = Path(os.environ["LIFECYCLE_MIGRATION_DB"]).resolve()
assert filename.parent.name.startswith("soduwork-lifecycle-migration-") and filename.name == "fixture.db"
cfg = Config("alembic.ini")
command.upgrade(cfg, "0079_native_discovery")
engine = sa.create_engine("sqlite:///" + filename.as_posix())
with engine.begin() as connection:
    assert "lifecycle_revision" not in {row["name"] for row in sa.inspect(connection).get_columns("account_conversation")}
    connection.execute(sa.text("INSERT INTO account_conversation_cursor (owner_user_id, revision) VALUES ('fixture-user', 3)"))
    for number, archived, deleted in ((1, 0, 0), (2, 1, 0), (3, 1, 1)):
        connection.execute(sa.text("INSERT INTO account_conversation "
            "(id, owner_user_id, source_client_id, source_session_id, title, archived, deleted, revision) "
            "VALUES (:id, 'fixture-user', 'fixture-device', :source, :title, :archived, :deleted, :revision)"),
            dict(id='fixture-' + str(number), source='native-' + str(number), title='retained-' + str(number),
                 archived=archived, deleted=deleted, revision=number))
command.upgrade(cfg, "head")
with engine.connect() as connection:
    rows = connection.execute(sa.text("SELECT title, archived, deleted, revision, lifecycle_revision "
        "FROM account_conversation ORDER BY id")).all()
    assert rows == [('retained-1', 0, 0, 1, 0), ('retained-2', 1, 0, 2, 0), ('retained-3', 1, 1, 3, 0)]
    column = next(row for row in sa.inspect(connection).get_columns("account_conversation") if row['name'] == 'lifecycle_revision')
    assert column['nullable'] is False
    assert connection.scalar(sa.text("SELECT revision FROM account_conversation_cursor")) == 3
    assert connection.scalar(sa.text("SELECT version_num FROM alembic_version")) == ScriptDirectory.from_config(cfg).get_current_head()
command.downgrade(cfg, "0079_native_discovery")
with engine.connect() as connection:
    assert "lifecycle_revision" not in {row["name"] for row in sa.inspect(connection).get_columns("account_conversation")}
    assert connection.execute(sa.text("SELECT title, archived, deleted, revision FROM account_conversation ORDER BY id")).all() == [row[:4] for row in rows]
command.upgrade(cfg, "head")
with engine.connect() as connection:
    assert connection.execute(sa.text("SELECT lifecycle_revision FROM account_conversation")).scalars().all() == [0, 0, 0]
engine.dispose()
print("lifecycle migration round trip preserved active, archived and deleted conversations")
'''


class AccountConversationLifecycleMigrationTests(unittest.TestCase):
    def test_alembic_round_trip_preserves_existing_lifecycle_and_directory(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-lifecycle-migration-") as folder:
            filename = Path(folder).resolve() / "fixture.db"
            environment = dict(os.environ, DATABASE_URL="sqlite+aiosqlite:///" + filename.as_posix(),
                CLUSTER_REDIS_URL="", AUTH_SECRET="isolated-lifecycle-migration-fixture-key",
                ADMIN_PASS="isolated-lifecycle-migration-fixture-password",
                LIFECYCLE_MIGRATION_DB=str(filename))
            result = subprocess.run([sys.executable, "-B", "-c", CHECK], cwd=BACKEND,
                env=environment, capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, (result.stdout + result.stderr)[-7000:])
            self.assertIn("preserved active, archived and deleted conversations", result.stdout)

    def test_postgres_ddl_adds_non_nullable_revision_with_legacy_default(self):
        module = importlib.import_module("migrations.versions.0080_account_lifecycle")
        stream = io.StringIO()
        context = MigrationContext.configure(dialect_name="postgresql",
            opts={"as_sql": True, "output_buffer": stream})
        with Operations.context(context):
            module.upgrade()
        self.assertIn("ADD COLUMN lifecycle_revision INTEGER DEFAULT '0' NOT NULL", stream.getvalue())
        self.assertEqual(module.down_revision, "0079_native_discovery")


if __name__ == "__main__":
    unittest.main()
