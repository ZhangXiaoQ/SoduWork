"""Hub migration, real Runner bytes and real desktop SQLite across processes."""
import asyncio
import base64
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from tests import test_account_conversations as fixtures
from app.account_conversation_models import AccountConversation, AccountConversationMessage
from app.api import desktop_capabilities
from app.services import conversation_content_migration as migration, runner_hub
from app.services.runner_content_store import Store, CHUNK


class AccountEndpointImportTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixtures.AccountConversationTests.asyncSetUp
    asyncTearDown = fixtures.AccountConversationTests.asyncTearDown
    checkpoint = staticmethod(fixtures.AccountConversationTests.checkpoint)

    async def test_process_restart_and_native_tombstones_preserve_durable_migration(self):
        for deleted, paged in ((False, False), (True, False), (False, True)):
            with self.subTest(deleted=deleted, paged=paged), tempfile.TemporaryDirectory(prefix="endpoint-import-") as root:
                message_id = "message-" + str(deleted) + str(paged)
                body = self.checkpoint(1, [{"id": message_id, "position": 0, "role": "assistant",
                    "text": "retained original", "createdAt": "2026-11-07T00:00:00Z"}])
                body["sourceSessionId"] = "native-" + str(deleted) + str(paged)
                response = await self.http.post("/api/v1/account-conversations/sync", json=body)
                self.assertEqual(response.status_code, 200, response.text)
                identity = response.json()["conversationId"]
                if paged:
                    async with self.sessions() as session:
                        for index in range(1, 102):
                            session.add(AccountConversationMessage(id=f"paged-{index}", conversation_id=identity,
                                position=index, role="assistant", text=f"{index}:" + "x" * 60000, revision=1))
                        await session.commit()
                store = Store(str(Path(root) / "runner"))
                async def call(op, payload, **options):
                    return await asyncio.to_thread(store.handle, {"op": op, **payload})
                runner = SimpleNamespace(id="runner", caps=["conversationContent1", "desktopHistory1"], alive=lambda: True, call=call)
                results = []
                async def import_content(target, packet, client, session):
                    pointer = packet["args"]["pointer"]
                    chunks = [store.handle({"op": "content.read", **pointer, "offset": offset})["data"]
                              for offset in range(0, max(1, pointer["size"]), CHUNK)]
                    manifest = json.loads(b"".join(base64.b64decode(chunk["b64"]) for chunk in chunks))
                    if paged:
                        self.assertEqual(manifest["format"], "soduwork.account-history.pages.v1")
                        self.assertGreater(len(manifest["pages"]), 1)
                        for page in manifest["pages"]:
                            chunks.extend(store.handle({"op": "content.read", **page, "offset": offset})["data"]
                                for offset in range(0, max(1, page["size"]), CHUNK))
                    process = await asyncio.create_subprocess_exec(shutil.which("node"),
                        str(Path(__file__).with_name("endpoint_import_fixture.cjs")),
                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                    payload = {"root": root, "pointer": pointer, "metadata": packet["args"]["metadata"],
                        "chunks": chunks, "deletedSource": deleted,
                        "identity": {"hub": "https://fixture.invalid", "clientId": client.id, "user": {"id": client.user_ref}}}
                    try:
                        output, error = await asyncio.wait_for(process.communicate(json.dumps(payload).encode() + b"\n"), 15)
                    finally:
                        if process.returncode is None:
                            process.kill()
                            await process.wait()
                    self.assertEqual(process.returncode, 0, error.decode(errors="replace"))
                    results.append(json.loads(output))
                    return results[-1]["receipt"]
                with patch.object(runner_hub, "get", return_value=runner), \
                     patch.object(desktop_capabilities, "resolve", AsyncMock(return_value=(self.client, runner))), \
                     patch.object(desktop_capabilities, "request", import_content):
                    async with self.sessions() as session:
                        row = await session.get(AccountConversation, identity)
                        self.assertTrue((await migration.account(session, self.client, row, self.client.id))["ok"])
                        self.assertEqual((await session.get(AccountConversationMessage, message_id)).text, "")
                        # A new Node process reopens the exact worker database;
                        # a lost receipt is acknowledged without republishing.
                        await import_content(self.client.id, {"args": {"pointer": row.content_ref,
                            "metadata": {"id": identity, "sourceClientId": self.client.id,
                                "sourceSessionId": body["sourceSessionId"]}}}, self.client, session)
                    self.assertTrue(all(item["receipt"]["durable"] for item in results))
                    self.assertEqual(results[-1]["row"]["deleted"], deleted)
                    texts = [item["text"] for item in results[-1]["messages"]["items"]]
                    if paged:
                        self.assertEqual(texts[0], "retained original")
                        self.assertEqual(results[-1]["total"], 102)
                        self.assertTrue(results[-1]["lastText"].startswith("101:"))
                    else:
                        self.assertEqual(texts, [] if deleted else ["retained original"])
