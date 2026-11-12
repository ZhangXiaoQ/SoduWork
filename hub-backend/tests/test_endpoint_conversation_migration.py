"""Real database checks around endpoint migration and late source updates."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from tests import test_account_conversations as fixtures
from app.api import desktop_capabilities, conversation_content_migrations
from app.account_conversation_models import AccountConversation, AccountConversationMessage
from app.services import conversation_content, conversation_content_migration as migration
from sqlalchemy import select
from fastapi import HTTPException


class EndpointMigrationTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixtures.AccountConversationTests.asyncSetUp
    asyncTearDown = fixtures.AccountConversationTests.asyncTearDown
    checkpoint = staticmethod(fixtures.AccountConversationTests.checkpoint)

    async def seed(self):
        body = self.checkpoint(1, [{"id": "message-a", "position": 0, "role": "user", "text": "sole old Hub copy", "createdAt": "2026-11-07T00:00:00Z"}])
        response = await self.http.post("/api/v1/account-conversations/sync", json=body)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["conversationId"]

    async def test_new_local_directory_does_not_store_messages_or_accept_old_body_writers(self):
        body = self.checkpoint(1, [], storageMode="endpoint", snapshotComplete=False, messageCount=12345)
        response = await self.http.post("/api/v1/account-conversations/sync", json=body)
        self.assertEqual(response.status_code, 200, response.text)
        identity = response.json()["conversationId"]
        directory = await self.http.get("/api/v1/account-conversations")
        self.assertEqual(directory.json()["items"][0]["messageCount"], 12345)
        old = self.checkpoint(2, [{"id": "x", "position": 0, "role": "user", "text": "must not persist", "createdAt": "2026-11-07T00:00:00Z"}])
        response = await self.http.post("/api/v1/account-conversations/sync", json=old)
        self.assertEqual(response.status_code, 409)
        async with self.sessions() as session:
            self.assertEqual((await session.get(AccountConversation, identity)).storage_mode, "endpoint")
            self.assertEqual(list((await session.scalars(select(AccountConversationMessage))).all()), [])

    async def test_wrong_receipt_keeps_sole_copy_then_verified_retry_clears_only_the_body(self):
        identity = await self.seed()
        pointer = {"sha256": "a" * 64, "size": 30, "scope": "b" * 64, "runnerId": "runner", "schema": 1}
        endpoint = SimpleNamespace(caps=["desktopHistory1"])
        with patch.object(desktop_capabilities, "resolve", AsyncMock(return_value=(None, endpoint))), \
             patch.object(conversation_content, "put_json", AsyncMock(return_value=pointer)), \
             patch.object(desktop_capabilities, "request", AsyncMock(return_value={"ok": True, "durable": True, "sha256": "wrong", "size": 30})) as imported:
            endpoint.id = "runner"
            async with self.sessions() as session:
                row = await session.get(AccountConversation, identity)
                with self.assertRaises(HTTPException) as rejected:
                    await migration.account(session, self.client, row, self.client.id)
                self.assertEqual(rejected.exception.status_code, 409)
                await session.rollback()
                message = await session.get(AccountConversationMessage, "message-a")
                self.assertEqual(message.text, "sole old Hub copy")
            imported.return_value = {"ok": True, "durable": True, "id": "migrated-" + "c" * 64, "sha256": pointer["sha256"], "size": 30}
            async with self.sessions() as session:
                row = await session.get(AccountConversation, identity)
                result = await migration.account(session, self.client, row, self.client.id)
                self.assertTrue(result["ok"])
                self.assertEqual((await session.get(AccountConversationMessage, "message-a")).text, "")
                self.assertEqual(row.content_ref["sha256"], pointer["sha256"])
                self.assertEqual(row.storage_mode, "endpoint")

    async def test_source_change_during_import_prevents_cleanup(self):
        identity = await self.seed()
        pointer = {"sha256": "a" * 64, "size": 30}
        async def import_and_change(*args):
            async with self.sessions() as changed:
                row = await changed.get(AccountConversation, identity)
                row.source_revision += 1
                await changed.commit()
            return {"ok": True, "durable": True, "id": "migrated-" + "c" * 64, **pointer}
        with patch.object(desktop_capabilities, "resolve", AsyncMock(return_value=(None, SimpleNamespace(id="runner", caps=["desktopHistory1"])))), \
             patch.object(conversation_content, "put_json", AsyncMock(return_value=pointer)), \
             patch.object(desktop_capabilities, "request", import_and_change):
            async with self.sessions() as session:
                row = await session.get(AccountConversation, identity)
                with self.assertRaises(HTTPException) as rejected:
                    await migration.account(session, self.client, row, self.client.id)
                self.assertEqual(rejected.exception.status_code, 409)
                await session.rollback()
                self.assertEqual((await session.get(AccountConversationMessage, "message-a")).text, "sole old Hub copy")

    async def test_other_account_cannot_start_migration_or_enumerate_candidates(self):
        identity = await self.seed()
        self.app.include_router(conversation_content_migrations.router)
        self.client.user_ref = "different-user"
        response = await self.http.post("/api/v1/conversation-content-migrations/account/" + identity, json={})
        self.assertEqual(response.status_code, 404)
        response = await self.http.get("/api/v1/conversation-content-migrations?kind=account")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["items"], [])

    async def test_lifecycle_change_during_import_keeps_hub_body(self):
        identity = await self.seed()
        pointer = {"sha256": "a" * 64, "size": 30}
        async def import_and_delete(*args):
            async with self.sessions() as changed:
                row = await changed.get(AccountConversation, identity)
                row.deleted, row.revision = True, row.revision + 1
                await changed.commit()
            return {"ok": True, "durable": True, "id": "migrated-" + "c" * 64, **pointer}
        with patch.object(desktop_capabilities, "resolve", AsyncMock(return_value=(None, SimpleNamespace(id="runner", caps=["desktopHistory1"])))), \
             patch.object(conversation_content, "put_json", AsyncMock(return_value=pointer)), \
             patch.object(desktop_capabilities, "request", import_and_delete):
            async with self.sessions() as session:
                row = await session.get(AccountConversation, identity)
                with self.assertRaises(HTTPException) as rejected:
                    await migration.account(session, self.client, row, self.client.id)
                self.assertEqual(rejected.exception.status_code, 409)
                await session.rollback()
                self.assertEqual((await session.get(AccountConversationMessage, "message-a")).text, "sole old Hub copy")

    async def test_final_mode_rejects_new_legacy_body_writers(self):
        with patch.object(conversation_content, "metadata_only", return_value=True):
            legacy = self.checkpoint(1, [])
            response = await self.http.post("/api/v1/account-conversations/sync", json=legacy)
            self.assertEqual(response.status_code, 409)
            response = await self.http.post("/api/v1/account-conversations/sync", json={**legacy, "storageMode": "endpoint", "snapshotComplete": False})
            self.assertEqual(response.status_code, 200, response.text)

    async def test_same_revision_upgrade_retains_the_only_body_until_migration(self):
        identity = await self.seed()
        upgrade = self.checkpoint(1, [], storageMode="endpoint", snapshotComplete=False, messageCount=1)
        first = await self.http.post("/api/v1/account-conversations/sync", json=upgrade)
        self.assertEqual(first.status_code, 200, first.text)
        retry = await self.http.post("/api/v1/account-conversations/sync", json=upgrade)
        self.assertTrue(retry.json()["idempotent"])
        async with self.sessions() as session:
            self.assertEqual((await session.get(AccountConversation, identity)).storage_mode, "endpoint")
            self.assertEqual((await session.get(AccountConversationMessage, "message-a")).text, "sole old Hub copy")

    async def test_revoked_login_during_import_cannot_authorize_hub_body_removal(self):
        identity = await self.seed()
        pointer = {"sha256": "a" * 64, "size": 30}
        async def import_and_revoke(*args):
            from app.models import Client
            async with self.sessions() as changed:
                row = await changed.get(Client, self.client.id)
                row.auth_version += 1
                await changed.commit()
            return {"ok": True, "durable": True, "id": "migrated-" + "c" * 64, **pointer}
        with patch.object(desktop_capabilities, "resolve", AsyncMock(return_value=(None, SimpleNamespace(id="runner", caps=["desktopHistory1"])))), \
             patch.object(conversation_content, "put_json", AsyncMock(return_value=pointer)), \
             patch.object(desktop_capabilities, "request", import_and_revoke):
            async with self.sessions() as session:
                row = await session.get(AccountConversation, identity)
                with self.assertRaises(HTTPException) as rejected:
                    await migration.account(session, self.client, row, self.client.id)
                self.assertEqual(rejected.exception.status_code, 409)
                await session.rollback()
                self.assertEqual((await session.get(AccountConversationMessage, "message-a")).text, "sole old Hub copy")

    async def test_global_gate_counts_orphaned_and_other_account_bodies_without_exposing_text(self):
        from app.db import Base
        from app.models import User, Task, TaskEvent, Attachment, AiScheduleRun
        from app.conversation_handoff_models import ConversationHandoff, ConversationMessageReceipt
        from app.account_conversation_models import PersonalConversationRelay
        from app.automation_models import ExecutionSession, ExecutionEvent
        from app.services import conversation_content_inventory as inventory
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[
                User.__table__, TaskEvent.__table__, Attachment.__table__, ConversationHandoff.__table__,
                ConversationMessageReceipt.__table__, PersonalConversationRelay.__table__,
                ExecutionSession.__table__, ExecutionEvent.__table__, AiScheduleRun.__table__]))
        await self.seed()
        async with self.sessions() as session:
            session.add(User(id=self.client.user_ref, username="isolated-migration-owner", is_active=True))
            session.add(ConversationMessageReceipt(id="orphan-receipt", task_id="gone", owner_client_id="gone",
                message_id="one", content_hash="a" * 64, payload={"instruction": "private orphan"}))
            for i, payload in enumerate([None, {}]):
                session.add(ConversationMessageReceipt(id="empty-receipt-" + str(i), task_id="gone", owner_client_id="gone",
                    message_id="empty-" + str(i), content_hash="b" * 64, payload=payload))
            session.add(ExecutionSession(id="orphan-execution", task_id="gone", ref="orphan-ref"))
            session.add(ExecutionEvent(id="orphan-event", session_id="orphan-execution", seq=1, text="private event"))
            session.add(ExecutionEvent(id="missing-execution-event", session_id="missing-execution", seq=1, text="private detached event"))
            session.add(Task(id="orphan-task", title="metadata", origin="cloud-conversation", note="private note"))
            session.add(TaskEvent(id="orphan-brief", task_id="orphan-task", kind="dispatched", detail={"carried": {"brief": "private brief"}}))
            await session.commit()
            owned = await inventory.counts(session, self.client.user_ref)
            self.assertEqual(owned["account"], 1)
            self.assertEqual(owned["message"], 0)
            report = await inventory.audit(session)
            self.assertFalse(report["complete"])
            self.assertEqual(report["pending"]["message"], 1)
            self.assertEqual(report["pending"]["execution"], 1)
            self.assertEqual(report["blocked"]["messageUnowned"], 1)
            self.assertEqual(report["blocked"]["executionUnowned"], 1)
            self.assertEqual(report["blocked"]["orphanConversationNotes"], 1)
            self.assertEqual(report["blocked"]["orphanExecutionEvents"], 1)
            self.assertEqual(report["blocked"]["orphanConversationBriefs"], 1)
            self.assertNotIn("private", str(report))


if __name__ == "__main__":
    unittest.main()
