"""Legacy cloud bodies migrate even when their execution engines are disabled."""
import asyncio
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from tests import test_account_conversations as fixtures
from app.db import Base
from app.models import Task, TaskEvent, Attachment
from app.automation_models import RunnerNode
from app.conversation_handoff_models import ConversationHandoff, ConversationMessageReceipt
from app.services import conversation_content, conversation_content_migration as migration, runner_hub
from app.services.runner_content_store import Store


class CloudContentMigrationTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = fixtures.AccountConversationTests.asyncTearDown

    async def asyncSetUp(self):
        await fixtures.AccountConversationTests.asyncSetUp(self)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[
                TaskEvent.__table__, Attachment.__table__, RunnerNode.__table__,
                ConversationHandoff.__table__, ConversationMessageReceipt.__table__]))
        async with self.sessions() as session:
            session.add(RunnerNode(id="cloud", owner_user_id=self.client.user_ref, management_state="disabled", auth_state="active"))
            session.add(Task(id="task", title="directory", origin="cloud-conversation", note="legacy task copy", owner_user_id=self.client.user_ref))
            session.add(ConversationHandoff(id="handoff", owner_client_id=self.client.id, owner_user_id=self.client.user_ref,
                transfer_id="transfer", task_id="task", sha256="", request_hash="hash", storage_key="", backend="",
                options={"assigneeId": "runner:cloud:codex", "instruction": "original instruction"}, source={"goal": "original goal"}, phase="committed"))
            session.add(TaskEvent(id="brief", task_id="task", kind="dispatched", detail={"carried": {"brief": "legacy brief"}}))
            session.add(ConversationMessageReceipt(id="message", task_id="task", owner_client_id=self.client.id,
                message_id="message", content_hash="hash", payload={"schema": 1, "ownerUserId": self.client.user_ref,
                    "runnerId": "cloud", "ref": "execution", "text": "pending next turn"}))
            await session.commit()
        self.root = tempfile.TemporaryDirectory(prefix="cloud-content-migration-")
        self.addCleanup(self.root.cleanup)
        self.store = Store(self.root.name)
        async def call(op, payload, **options):
            return await asyncio.to_thread(self.store.handle, {"op": op, **payload})
        self.runner = SimpleNamespace(id="cloud", owner_user_id=self.client.user_ref, client_id="",
            caps=["conversationContent1"], alive=lambda: True, call=call)
        mocked = patch.object(runner_hub, "get", return_value=self.runner)
        mocked.start();self.addCleanup(mocked.stop)

    async def test_storage_does_not_require_an_agent_login_or_accepting_dispatch(self):
        async with self.sessions() as session:
            handoff = await session.get(ConversationHandoff, "handoff")
            self.assertTrue((await migration.handoff(session, self.client, handoff))["ok"])
            body = await conversation_content.load_options(self.client.user_ref, "handoff:handoff", handoff.options)
            self.assertEqual(body["instruction"], "original instruction")
            self.assertEqual(body["legacyTaskNote"], "legacy task copy")
            self.assertEqual(body["legacySourceGoal"], "original goal")
            self.assertEqual(body["legacyDispatchBriefs"], [{"id": "brief", "brief": "legacy brief"}])
            self.assertEqual((await session.get(Task, "task")).note, "")
            self.assertEqual((await session.get(TaskEvent, "brief")).detail["carried"]["brief"], "")
            self.assertNotIn("original", str(handoff.options))
            pending = await session.get(ConversationMessageReceipt, "message")
            self.assertTrue((await migration.pending_message(session, self.client, pending))["ok"])
            self.assertNotIn("pending next turn", str(pending.payload))
            self.assertEqual((await conversation_content.get_json(pending.payload["contentRef"], self.client.user_ref,
                "message:message"))["text"], "pending next turn")

    async def test_changed_endpoint_owner_never_receives_legacy_content(self):
        async with self.sessions() as session:
            node = await session.get(RunnerNode, "cloud")
            node.owner_user_id = "different-account"
            await session.commit()
            with self.assertRaises(HTTPException) as rejected:
                await migration.handoff(session, self.client, await session.get(ConversationHandoff, "handoff"))
            self.assertEqual(rejected.exception.status_code, 403)
            self.assertEqual((await session.get(Task, "task")).note, "legacy task copy")
