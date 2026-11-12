"""Read-model regression checks: pagination, tenant scope, latest dispatch, query budget."""
import os
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""
import unittest
import sqlite3
import uuid
from contextlib import closing
from datetime import datetime, timedelta, timezone
from sqlalchemy import event, inspect
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app import models, automation_models, project_context_models
from app.db import Base
from app.api.aidesk import ai_agent_tasks
from test_unified_requirements import _schema_template


class ReadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # Copy the complete schema into a private database for each test. The
        # anchor keeps the named in-memory database alive across async sessions.
        memory_name = "soduwork_read_models_" + uuid.uuid4().hex
        self._schema_anchor = sqlite3.connect(
            f"file:{memory_name}?mode=memory&cache=shared", uri=True,
        )
        self.addCleanup(self._schema_anchor.close)
        with closing(sqlite3.connect(_schema_template())) as source:
            source.backup(self._schema_anchor)
        database_url = f"sqlite+aiosqlite:///file:{memory_name}?mode=memory&cache=shared&uri=true"
        self.engine = create_async_engine(database_url)
        self.addAsyncCleanup(self.engine.dispose)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        now = datetime(2026, 9, 1, tzinfo=timezone.utc)
        async with self.sessions() as session:
            self.client = models.Client(id="mine")
            session.add_all([self.client, models.Client(id="other")])
            await session.flush()
            for i in range(60):
                task = models.Task(id=f"task-{i:03}", title=f"Task {i}",
                                   owner_client_id="mine" if i < 50 else "other",
                                   status="done" if i % 2 == 0 else "doing", note="long context " * 100)
                session.add(task)
                session.add_all([
                    models.TaskEvent(id=f"old-{i:03}", task_id=task.id, kind="ai.dispatched",
                                     detail={"assigneeName": "Old"}, at=now),
                    models.TaskEvent(id=f"new-{i:03}", task_id=task.id, kind="ai.dispatched",
                                     detail={"assigneeName": " Pi ", "ref": "ref"},
                                     at=now + timedelta(seconds=i + 1)),
                    models.TaskEvent(id=f"other-{i:03}", task_id=task.id, kind="task.updated",
                                     detail={"assigneeName": "Wrong"},
                                     at=now + timedelta(days=1)),
                ])
            session.add(models.Task(id="never-dispatched", owner_client_id="mine", status="done"))
            session.add_all([
                models.Attachment(id="output", task_id="task-048", filename="result.txt",
                                  storage_key="result", uploaded_by="agent:pi", size=1),
                models.Attachment(id="input", task_id="task-048", filename="input.txt",
                                  storage_key="input", uploaded_by="person", size=1),
            ])
            await session.commit()
        self.queries = 0
        event.listen(self.engine.sync_engine, "before_cursor_execute", self.count)

    def count(self, *_):
        self.queries += 1

    async def read(self, **kwargs):
        async with self.sessions() as session:
            return await ai_agent_tasks(client=self.client, session=session, **{
                "agent": "", "scope": "done", "offset": 0, "limit": 20, **kwargs})

    async def test_query_budget_and_artifact_count(self):
        result = await self.read()
        self.assertEqual(self.queries, 3)
        self.assertEqual(result["total"], 25)
        self.assertEqual(result["items"][0]["id"], "task-048")
        self.assertEqual(result["items"][0]["artifacts"], 1)
        self.assertTrue(result["items"][0]["delivered"])
        self.assertTrue(result["hasMore"])

    async def test_latest_agent_only(self):
        self.assertEqual((await self.read(agent="Old"))["total"], 0)
        self.assertEqual((await self.read(agent="Wrong"))["total"], 0)
        self.assertEqual((await self.read(agent="Pi"))["total"], 25)

    async def test_scope_and_pagination(self):
        done = await self.read(offset=20)
        self.assertEqual(len(done["items"]), 5)
        self.assertFalse(done["hasMore"])
        live = await self.read(scope="live", limit=100)
        self.assertEqual(live["total"], 25)
        self.assertTrue(all(item["status"] == "doing" for item in live["items"]))
        all_items = await self.read(scope="all", limit=100)
        self.assertEqual(all_items["total"], 50)
        self.assertTrue(all(int(item["id"].split("-")[1]) < 50 for item in all_items["items"]))

    async def test_out_of_range_keeps_total(self):
        result = await self.read(offset=9999)
        self.assertEqual(result["items"], [])
        self.assertEqual(result["total"], 25)
        self.assertEqual(self.queries, 2)

    async def test_authenticated_account_cannot_inherit_previous_device_rows(self):
        # Existing rows belong to the earlier anonymous device identity. A newly
        # authenticated human on that device must not inherit its execution data.
        self.client.user_ref = "new-account"
        result = await self.read(scope="all")
        self.assertEqual(result["items"], [])
        self.assertEqual(result["total"], 0)
        self.assertEqual(self.queries, 2)

    async def test_wrong_device_actor_is_rejected_without_querying_tasks(self):
        from app.services.task_read_models import agent_task_page
        async with self.sessions() as session:
            result = await agent_task_page(session, "other", "", "all", 0, 20,
                                           client=self.client)
        self.assertEqual(result, ([], 0, {}))
        self.assertEqual(self.queries, 0)

    async def test_deterministic_same_time_dispatch(self):
        async with self.sessions() as session:
            row = await session.get(models.TaskEvent, "new-048")
            session.add(models.TaskEvent(id="zzz-last", task_id="task-048",
                                        kind="multica.dispatched", at=row.at,
                                        detail={"assigneeName": "Latest"}))
            await session.commit()
        self.assertEqual((await self.read(agent="Latest"))["total"], 1)
        self.assertEqual((await self.read(agent="Pi"))["total"], 24)

    async def test_composite_indexes_exist(self):
        async with self.engine.connect() as conn:
            names = await conn.run_sync(lambda c: {
                index["name"] for table in Base.metadata.tables
                for index in inspect(c).get_indexes(table)})
        self.assertTrue({"ix_task_event_timeline", "ix_task_owner_state_updated",
                         "ix_workflow_outbox_due", "ix_execution_runner_active",
                         "ix_node_run_attempt", "ix_execution_task_latest",
                         "ix_task_comment_timeline", "ix_workflow_task_latest"} <= names)


if __name__ == "__main__":
    unittest.main()
