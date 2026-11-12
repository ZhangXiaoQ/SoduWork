"""Integration checks for the account conversation checkpoint contract."""
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "isolated-account-conversation-test-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-account-conversation-test-password")

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import account_conversation_models  # noqa: F401
from app.account_conversation_models import (
    AccountConversation,
    AccountConversationCursor,
    AccountConversationMessage,
)
from app.api import account_conversations
from app.db import Base, get_session
from app.deps import current_client
from app.models import Client, Task


class AccountConversationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        notifications = patch.object(account_conversations, "SessionLocal", self.sessions)
        notifications.start()
        self.addCleanup(notifications.stop)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(
                sync,
                tables=[
                    Client.__table__, AccountConversationCursor.__table__,
                    AccountConversation.__table__, AccountConversationMessage.__table__,
                    Task.__table__,
                ],
            ))
        self.client = Client(
            id="desktop-1", name="desktop", user_ref="user-1", auth_state="active",
        )
        async with self.sessions() as session:
            session.add(self.client)
            await session.commit()

        app = FastAPI()
        self.app = app
        app.include_router(account_conversations.router)

        async def session_override():
            async with self.sessions() as session:
                yield session

        async def client_override():
            return self.client

        app.dependency_overrides[get_session] = session_override
        app.dependency_overrides[current_client] = client_override
        self.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test",
        )

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    @staticmethod
    def checkpoint(revision, messages, **extra):
        return {
            "sourceClientId": "desktop-1",
            "sourceSessionId": "native-1",
            "sourceEpoch": "native-1:desktop",
            "sourceRevision": revision,
            "title": "test",
            "state": "idle",
            "messages": messages,
            "snapshotComplete": True,
            **extra,
        }

    async def create_conversation(self, **extra):
        response = await self.http.post("/api/v1/account-conversations/sync",
            json=self.checkpoint(1, [], **extra))
        self.assertEqual(response.status_code, 200, response.text)
        conversation_id = response.json()["conversationId"]
        source = await self.http.get(f"/api/v1/account-conversations/{conversation_id}/source")
        return source.json()["conversation"]

    async def lifecycle(self, row, action, **extra):
        return await self.http.post(f"/api/v1/account-conversations/{row['id']}/lifecycle",
            json={"action": action, "expectedRevision": row["revision"], **extra})

    async def test_real_device_auth_and_new_source_push_remain_compatible_with_lifecycle(self):
        from app.models import User
        from app.services import client_domain_events, device_auth
        from app.services.auth_cache_transactions import AuthSession

        # Keep the production authentication dependency and transaction hooks;
        # only the database is private. With Redis disabled, identities read SQL.
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False,
                                          sync_session_class=AuthSession)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(
                sync, tables=[User.__table__]))
        async with self.sessions() as session:
            session.add_all([User(id="user-1", username="alice", is_active=True),
                             User(id="user-other", username="bob", is_active=True)])
            second = Client(id="desktop-2", user_ref="user-1", auth_state="active", auth_version=1)
            stranger = Client(id="desktop-other", user_ref="user-other", auth_state="active", auth_version=1)
            session.add_all([second, stranger])
            source = await session.get(Client, "desktop-1")
            headers = {value.id: {"Authorization": "Device " + device_auth.issue_session(value)[0]}
                       for value in (source, second, stranger)}
            await session.commit()
        self.app.dependency_overrides.pop(current_client)

        with patch.object(account_conversations, "_publish_account_update", new=AsyncMock()) as publish, \
                patch.object(client_domain_events, "account_changed", new=AsyncMock()) as project_change, \
                patch.object(device_auth, "_LAST_SEEN_WRITES", {}):
            created = await self.http.post("/api/v1/account-conversations/sync",
                headers=headers["desktop-1"], json=self.checkpoint(1, []))
            self.assertEqual(created.status_code, 200, created.text)
            self.assertEqual(project_change.await_count, 1)
            self.assertEqual(project_change.await_args.args[1:], ("user-1", "conversation-projects"))
            listed = await self.http.get("/api/v1/account-conversations", headers=headers["desktop-2"])
            self.assertEqual(listed.status_code, 200, listed.text)
            row = listed.json()["items"][0]
            endpoint = f"/api/v1/account-conversations/{row['id']}/lifecycle"
            archived = await self.http.post(endpoint, headers=headers["desktop-2"],
                json={"action": "archive", "expectedRevision": row["revision"]})
            self.assertEqual(archived.status_code, 200, archived.text)
            self.assertTrue(archived.json()["conversation"]["archived"])
            self.assertEqual(project_change.await_count, 1, "lifecycle changes do not create another source")
            self.assertEqual(publish.await_count, 2)

            replay = await self.http.post("/api/v1/account-conversations/sync",
                headers=headers["desktop-1"], json=self.checkpoint(2, []))
            self.assertEqual(replay.status_code, 200, replay.text)
            self.assertEqual(project_change.await_count, 1)
            current = (await self.http.get("/api/v1/account-conversations",
                headers=headers["desktop-2"])).json()["items"][0]
            self.assertTrue(current["archived"], "ordinary source sync preserves account intent")
            forbidden = await self.http.post(endpoint, headers=headers["desktop-other"],
                json={"action": "restore", "expectedRevision": current["revision"]})
            self.assertEqual(forbidden.status_code, 404)
            self.assertEqual(publish.await_count, 3)

            async with self.sessions() as session:
                device_auth.revoke(await session.get(Client, "desktop-2"))
                await session.commit()
            for response in [
                await self.http.get("/api/v1/account-conversations", headers=headers["desktop-2"]),
                await self.http.post(endpoint, headers=headers["desktop-2"],
                    json={"action": "restore", "expectedRevision": current["revision"]}),
            ]:
                self.assertEqual(response.status_code, 403, response.text)
            self.assertEqual(publish.await_count, 3, "revoked devices cannot publish lifecycle updates")

    async def test_creation_time_survives_later_sync_updates(self):
        with patch.object(account_conversations, "_publish_account_update", new=AsyncMock()):
            for revision in (1, 2):
                response = await self.http.post("/api/v1/account-conversations/sync",
                    json=self.checkpoint(revision, [], title=f"title-{revision}"))
                self.assertEqual(response.status_code, 200)
                page = (await self.http.get("/api/v1/account-conversations")).json()
                row = page["items"][0]
                self.assertTrue(row["createdAt"])
                if revision == 1:
                    created = row["createdAt"]
                else:
                    self.assertEqual(row["createdAt"], created)
                    self.assertEqual(row["title"], "title-2")

    async def test_complete_checkpoint_tombstones_messages_missing_from_source(self):
        first = self.checkpoint(1, [
            {"id": "m1", "position": 0, "role": "user", "text": "hello",
             "createdAt": "2026-11-01T00:00:00Z", "done": True},
            {"id": "m2", "position": 1, "role": "assistant", "text": "reply",
             "createdAt": "2026-11-01T00:00:01Z", "done": True},
        ])
        second = self.checkpoint(2, [first["messages"][0]])
        with patch.object(account_conversations, "_publish_account_update", new=AsyncMock()):
            self.assertEqual((await self.http.post(
                "/api/v1/account-conversations/sync", json=first)).status_code, 200)
            self.assertEqual((await self.http.post(
                "/api/v1/account-conversations/sync", json=second)).status_code, 200)

        data = await self.http.get(
            "/api/v1/account-conversations",
            params={"limit": 100},
        )
        self.assertEqual(data.status_code, 200)
        self.assertEqual(data.json()["items"][0]["messageCount"], 1)
        self.assertEqual(data.json()["items"][0]["lifecycleRevision"], 0)
        conversation_id = data.json()["items"][0]["id"]
        transcript = await self.http.get(
            f"/api/v1/account-conversations/{conversation_id}/messages",
            params={"limit": 100},
        )
        self.assertEqual(transcript.status_code, 200)
        rows = {row["id"]: row for row in transcript.json()["items"]}
        self.assertFalse(rows["m1"]["deleted"])
        self.assertTrue(rows["m2"]["deleted"])

    async def test_task_projection_identity_is_authorized_and_backward_compatible(self):
        async with self.sessions() as session:
            session.add_all([
                Task(id="mine", title="same title", owner_client_id="desktop-1",
                     owner_user_id="user-1", created_by="user-1"),
                Task(id="other", title="same title", owner_client_id="desktop-2",
                     owner_user_id="user-2", created_by="user-2"),
            ])
            await session.commit()
        with patch.object(account_conversations, "_publish_account_update", new=AsyncMock()):
            denied = await self.http.post("/api/v1/account-conversations/sync",
                json=self.checkpoint(1, [], taskProjectionId="other"))
            self.assertEqual(denied.status_code, 404)
            payload = self.checkpoint(1, [], taskProjectionId="mine")
            for _ in range(2):
                self.assertEqual((await self.http.post(
                    "/api/v1/account-conversations/sync", json=payload)).status_code, 200)
            # Older clients omit this field rather than erasing the binding.
            self.assertEqual((await self.http.post("/api/v1/account-conversations/sync",
                json=self.checkpoint(2, []))).status_code, 200)
        data = (await self.http.get("/api/v1/account-conversations")).json()
        self.assertEqual(len(data["items"]), 1)
        self.assertEqual(data["items"][0]["taskProjectionId"], "mine")
        self.assertEqual(data["items"][0]["messageCount"], 0)

    @patch.object(account_conversations, "_publish_account_update", new_callable=AsyncMock)
    async def test_account_device_can_archive_and_restore_without_changing_source(self, publish):
        row = await self.create_conversation()
        # Authenticated to the same account, but not the source device.
        self.client = Client(id="desktop-2", user_ref="user-1", auth_state="active")
        archived = await self.lifecycle(row, "archive")
        self.assertEqual(archived.status_code, 200, archived.text)
        changed = archived.json()["conversation"]
        self.assertTrue(changed["archived"])
        self.assertFalse(changed["deleted"])
        self.assertGreater(changed["revision"], row["revision"])
        self.assertEqual(changed["lifecycleRevision"], changed["revision"])
        self.assertEqual(changed["sourceClientId"], "desktop-1")
        self.assertEqual(changed["sourceRevision"], 1)
        self.assertFalse(changed["canSend"])
        delta = (await self.http.get("/api/v1/account-conversations",
            params={"after": row["revision"]})).json()
        self.assertEqual(delta["items"][0]["lifecycleRevision"], changed["revision"])
        restored = await self.lifecycle(changed, "restore")
        self.assertEqual(restored.status_code, 200, restored.text)
        final = restored.json()["conversation"]
        self.assertFalse(final["archived"])
        self.assertEqual(final["lifecycleRevision"], final["revision"])
        self.assertGreater(final["revision"], changed["revision"])
        self.assertEqual(publish.await_count, 3)  # source checkpoint, archive, restore

    @patch.object(account_conversations, "_publish_account_update", new_callable=AsyncMock)
    async def test_lifecycle_does_not_reveal_other_accounts_or_accept_unbound_devices(self, publish):
        row = await self.create_conversation()
        self.client = Client(id="desktop-other", user_ref="user-other", auth_state="active")
        for action in ("archive", "restore", "delete"):
            with self.subTest(action=action):
                denied = await self.lifecycle(row, action)
                absent = await self.lifecycle({**row, "id": "missing"}, action)
                self.assertEqual(denied.status_code, 404)
                self.assertEqual(denied.json(), absent.json())
        self.client = Client(id="unbound", user_ref="", auth_state="active")
        self.assertEqual((await self.lifecycle(row, "archive")).status_code, 403)
        self.assertEqual(publish.await_count, 1)

    @patch.object(account_conversations, "_publish_account_update", new_callable=AsyncMock)
    async def test_lifecycle_validates_action_and_revision_before_mutation(self, publish):
        row = await self.create_conversation()
        bad_bodies = [
            {}, {"action": "archive"},
            *({"action": action, "expectedRevision": row["revision"]}
              for action in ("remove", "", None, {}, [])),
            *({"action": "archive", "expectedRevision": value}
              for value in (None, True, False, 0, -1, "1", 1.5)),
        ]
        for body in bad_bodies:
            with self.subTest(body=body):
                response = await self.http.post(
                    f"/api/v1/account-conversations/{row['id']}/lifecycle", json=body)
                self.assertEqual(response.status_code, 422, response.text)
        current = (await self.http.get(
            f"/api/v1/account-conversations/{row['id']}/source")).json()["conversation"]
        self.assertEqual(current, row)
        self.assertEqual(publish.await_count, 1)

    @patch.object(account_conversations, "_publish_account_update", new_callable=AsyncMock)
    async def test_lifecycle_cas_and_lost_receipts_cannot_reverse_later_intent(self, publish):
        row = await self.create_conversation()
        archived = (await self.lifecycle(row, "archive")).json()["conversation"]
        duplicate = await self.lifecycle(row, "archive")  # lost success receipt
        self.assertEqual(duplicate.status_code, 200)
        self.assertEqual(duplicate.json()["conversation"], archived)
        self.assertEqual(publish.await_count, 2)
        # A second device acting on the old directory cannot reverse archive.
        stale_restore = await self.lifecycle(row, "restore")
        self.assertEqual(stale_restore.status_code, 409)
        self.assertEqual(stale_restore.json()["detail"]["code"], "ACCOUNT_CONVERSATION_CHANGED")
        self.assertEqual(stale_restore.json()["detail"]["conversation"], archived)
        restored = (await self.lifecycle(archived, "restore")).json()["conversation"]
        old_archive = await self.lifecycle(row, "archive")
        self.assertEqual(old_archive.status_code, 409)
        self.assertEqual(old_archive.json()["detail"]["conversation"], restored)
        self.assertEqual((await self.lifecycle(row, "delete")).status_code, 409)
        self.assertEqual(publish.await_count, 3)

    @patch.object(account_conversations, "_publish_account_update", new_callable=AsyncMock)
    async def test_first_explicit_intent_requires_cas_even_when_state_already_matches(self, publish):
        for action, flags in (("restore", {}), ("archive", {"archived": True}),
                              ("delete", {"deleted": True})):
            with self.subTest(action=action):
                row = await self.create_conversation(sourceSessionId="native-" + action, **flags)
                self.assertEqual(row["lifecycleRevision"], 0)
                stale = await self.lifecycle(row, action, expectedRevision=row["revision"] + 1)
                self.assertEqual(stale.status_code, 409)
                explicit = await self.lifecycle(row, action)
                self.assertEqual(explicit.status_code, 200)
                changed = explicit.json()["conversation"]
                self.assertGreater(changed["revision"], row["revision"])
                self.assertEqual(changed["lifecycleRevision"], changed["revision"])
                self.assertEqual(changed["archived"], row["archived"])
                self.assertEqual(changed["deleted"], row["deleted"])
                duplicate = await self.lifecycle(row, action)
                self.assertEqual(duplicate.json()["conversation"], changed)

    @patch.object(account_conversations, "_publish_account_update", new_callable=AsyncMock)
    async def test_source_checkpoints_preserve_lifecycle_but_continue_updating_content(self, publish):
        row = await self.create_conversation()
        for revision, action, flags in (
            (2, "archive", {"archived": False, "deleted": False}),
            (3, "restore", {"archived": True, "deleted": True}),
            (4, "delete", {"archived": False, "deleted": False}),
        ):
            with self.subTest(action=action):
                changed = (await self.lifecycle(row, action)).json()["conversation"]
                message = {"id": "m1", "position": 0, "role": "user", "text": str(revision),
                           "createdAt": "2026-11-01T00:00:00Z", "done": True}
                payload = self.checkpoint(revision, [message], title="updated " + str(revision), **flags)
                synced = await self.http.post("/api/v1/account-conversations/sync", json=payload)
                self.assertEqual(synced.status_code, 200, synced.text)
                transcript = (await self.http.get(
                    f"/api/v1/account-conversations/{row['id']}/messages")).json()
                row = transcript["conversation"]
                self.assertEqual(row["archived"], changed["archived"])
                self.assertEqual(row["deleted"], changed["deleted"])
                self.assertEqual(row["lifecycleRevision"], changed["lifecycleRevision"])
                self.assertGreater(row["revision"], changed["revision"])
                self.assertEqual(row["sourceRevision"], revision)
                self.assertEqual(row["title"], "updated " + str(revision))
                self.assertEqual(transcript["items"][0]["text"], str(revision))
        self.assertFalse(row["canContinue"])
        self.assertFalse(row["canSend"])
        for action in ("archive", "restore"):
            closed = await self.lifecycle(row, action)
            self.assertEqual(closed.status_code, 410)
            self.assertEqual(closed.json()["detail"]["code"], "ACCOUNT_CONVERSATION_DELETED")
        repeated_delete = await self.lifecycle(row, "delete", expectedRevision=1)
        self.assertEqual(repeated_delete.status_code, 200)
        self.assertEqual(repeated_delete.json()["conversation"], row)

    @patch.object(account_conversations, "_publish_account_update", new_callable=AsyncMock)
    async def test_sync_cannot_clear_legacy_lifecycle_flags_or_bypass_source_fences(self, publish):
        initial = self.checkpoint(1, [], archived=True)
        row = await self.create_conversation(archived=True)
        payload = self.checkpoint(2, [], archived=False, deleted=False)
        synced = await self.http.post("/api/v1/account-conversations/sync", json=payload)
        self.assertEqual(synced.status_code, 200)
        current = (await self.http.get(
            f"/api/v1/account-conversations/{row['id']}/source")).json()["conversation"]
        self.assertTrue(current["archived"])
        self.assertEqual(current["lifecycleRevision"], 0)
        deleted = (await self.lifecycle(current, "delete")).json()["conversation"]
        # A repeated source receipt stays idempotent without rewinding directory state.
        duplicate = await self.http.post("/api/v1/account-conversations/sync", json=payload)
        self.assertEqual(duplicate.status_code, 200)
        self.assertTrue(duplicate.json()["idempotent"])
        self.assertEqual(duplicate.json()["revision"], deleted["revision"])
        for conflict in (initial, {**payload, "title": "changed"},
                         {**payload, "sourceRevision": 3, "sourceEpoch": "different"}):
            with self.subTest(conflict=conflict):
                response = await self.http.post("/api/v1/account-conversations/sync", json=conflict)
                self.assertEqual(response.status_code, 409)
        current = (await self.http.get(
            f"/api/v1/account-conversations/{row['id']}/source")).json()["conversation"]
        self.assertEqual(current, deleted)


if __name__ == "__main__":
    unittest.main()
