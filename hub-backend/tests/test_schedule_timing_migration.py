"""Verify new recurrence migrations preserve legacy rows and block lossy rollbacks."""
import importlib
import io
import json
import time
import unittest

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


CALENDAR = importlib.import_module("migrations.versions.0083_schedule_timing_rules")
CUSTOM = importlib.import_module("migrations.versions.0084_schedule_custom_rule")


class TimingMigrationTests(unittest.TestCase):
    def test_large_legacy_upgrade_and_lossless_rollback(self):
        engine = sa.create_engine("sqlite:///:memory:")
        self.addCleanup(engine.dispose)
        with engine.begin() as connection:
            connection.execute(sa.text("CREATE TABLE ai_schedule (id TEXT PRIMARY KEY, every TEXT, weekday INTEGER, title TEXT)"))
            connection.execute(sa.text("INSERT INTO ai_schedule VALUES (:id,'weekly',:day,'Retained')"),
                               [{"id":str(index), "day":index % 7 + 1} for index in range(10000)])
            context = MigrationContext.configure(connection)
            updates = []
            def record(_connection, _cursor, statement, _parameters, _context, _many):
                if statement.startswith("UPDATE"):
                    updates.append(statement)
            sa.event.listen(connection, "before_cursor_execute", record)
            started = time.perf_counter()
            with Operations.context(context):
                CALENDAR.upgrade()
                CUSTOM.upgrade()
            elapsed = time.perf_counter() - started
            print(f"timing migration pressure: 10000 rows in {elapsed:.3f}s, {len(updates)} grouped updates")
            self.assertEqual(len(updates), 7)
            self.assertEqual(connection.scalar(sa.text("SELECT count(*) FROM ai_schedule")), 10000)
            for row in connection.execute(sa.text("SELECT weekday,weekdays,title,custom_rule,start_date,end_date FROM ai_schedule")):
                self.assertEqual(json.loads(row.weekdays), [row.weekday])
                self.assertEqual((row.title, row.custom_rule, row.start_date, row.end_date), ("Retained", "", None, None))
            rule = "DTSTART:20990101T090000Z\nRRULE:FREQ=DAILY;COUNT=1"
            connection.execute(sa.text("UPDATE ai_schedule SET every='custom',custom_rule=:rule WHERE id='0'"), {"rule":rule})
            with Operations.context(context), self.assertRaisesRegex(RuntimeError, "custom"):
                CUSTOM.downgrade()
            self.assertEqual(connection.scalar(sa.text("SELECT custom_rule FROM ai_schedule WHERE id='0'")), rule)
            connection.execute(sa.text("UPDATE ai_schedule SET every='weekly',custom_rule='' WHERE id='0'"))
            with Operations.context(context):
                CUSTOM.downgrade()
            for assignment, pattern in (("every='monthly'", "calendar"), ("start_date='2099-01-01'", "calendar"),
                                        ("weekdays='[1,3]'", "multi-weekday")):
                connection.execute(sa.text("UPDATE ai_schedule SET " + assignment + " WHERE id='0'"))
                with Operations.context(context), self.assertRaisesRegex(RuntimeError, pattern):
                    CALENDAR.downgrade()
                connection.execute(sa.text("UPDATE ai_schedule SET every='weekly',start_date=NULL,weekdays='[1]' WHERE id='0'"))
            with Operations.context(context):
                CALENDAR.downgrade()
            self.assertEqual({item["name"] for item in sa.inspect(connection).get_columns("ai_schedule")},
                             {"id", "every", "weekday", "title"})

    def test_postgresql_upgrade_ddl_is_portable_and_does_not_read_all_rows(self):
        stream = io.StringIO()
        context = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql":True, "output_buffer":stream})
        with Operations.context(context):
            CALENDAR.upgrade()
            CUSTOM.upgrade()
        sql = stream.getvalue()
        self.assertIn("custom_rule TEXT DEFAULT '' NOT NULL", sql)
        self.assertEqual(sql.count("UPDATE ai_schedule"), 7)
        self.assertNotIn("SELECT", sql)
