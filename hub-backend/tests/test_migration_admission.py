"""Concurrent migration requests yield capacity to normal Hub traffic."""
import asyncio
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from tests import test_account_conversations as fixtures
from app.api import conversation_content_migrations as api
from app.services import conversation_migration_admission as admission


class MigrationAdmissionTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixtures.AccountConversationTests.asyncSetUp
    asyncTearDown = fixtures.AccountConversationTests.asyncTearDown

    async def test_parallel_requests_are_bounded_without_waiting_or_mutating_history(self):
        # Match the production event loop. Debug traceback capture for every
        # ASGI task is measured separately, not charged to the service budget.
        loop = asyncio.get_running_loop()
        previous_debug = loop.get_debug()
        loop.set_debug(False)
        self.addCleanup(loop.set_debug, previous_debug)
        self.app.include_router(api.router)
        release, started = asyncio.Event(), asyncio.Event()
        active = 0
        async def transfer(*args):
            nonlocal active
            active += 1
            if active == admission.MAX_ACTIVE:
                started.set()
            await release.wait()
            return {"ok": True}
        with patch.object(api, "_migrate", transfer):
            accepted = [asyncio.create_task(self.http.post(
                f"/api/v1/conversation-content-migrations/account/{i}", json={})) for i in range(admission.MAX_ACTIVE)]
            try:
                await asyncio.wait_for(started.wait(), 3)
                rejected = await asyncio.wait_for(asyncio.gather(*[self.http.post(
                    f"/api/v1/conversation-content-migrations/account/{i + 10}", json={}) for i in range(200)]), 5)
                self.assertEqual({response.status_code for response in rejected}, {429})
                self.assertTrue(all(response.headers["retry-after"] == "5" for response in rejected))
                self.assertEqual(active, admission.MAX_ACTIVE)
            finally:
                release.set()
                finished = await asyncio.gather(*accepted)
            self.assertTrue(all(response.status_code == 200 for response in finished))
            retry = await self.http.post("/api/v1/conversation-content-migrations/account/next", json={})
            self.assertEqual(retry.status_code, 200)

    async def test_duplicate_and_cancelled_transfer_release_their_capacity(self):
        entered = asyncio.Event()
        async def transfer():
            with admission.reserve("account", "same"):
                entered.set()
                await asyncio.Event().wait()
        task = asyncio.create_task(transfer())
        await entered.wait()
        try:
            with self.assertRaises(HTTPException) as duplicate:
                with admission.reserve("account", "same"):
                    self.fail("Duplicate migration entered")
            self.assertEqual(duplicate.exception.status_code, 429)
        finally:
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        with admission.reserve("account", "same"):
            pass
