"""Immutable automation input survives migration, retry and plan changes."""
import asyncio
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy import select

from tests import test_account_conversations as fixtures
from app import models
from app.db import Base
from app.api import desktop_capabilities
from app.services import conversation_content, runner_hub, schedule_content
from app.services import conversation_content_migration as migration
from app.services import conversation_content_inventory as inventory
from app.services.runner_content_store import Store


class ScheduleContentTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = fixtures.AccountConversationTests.asyncTearDown

    async def asyncSetUp(self):
        await fixtures.AccountConversationTests.asyncSetUp(self)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[
                models.AiSchedule.__table__, models.AiScheduleRun.__table__]))
        async with self.sessions() as session:
            session.add(models.AiSchedule(id="plan", title="configuration", note="plan version one",
                owner_client_id=self.client.id, owner_user_id=self.client.user_ref))
            await session.flush()
            session.add(models.AiScheduleRun(id="run", schedule_id="plan", owner_client_id=self.client.id,
                receipt={"conversationInput": {"runId": "run", "text": "original expanded input", "modelName": "selected"}}))
            await session.commit()
        self.root = tempfile.TemporaryDirectory(prefix="schedule-content-")
        self.addCleanup(self.root.cleanup)
        self.store = Store(self.root.name)
        async def call(op, body, **options):
            return await asyncio.to_thread(self.store.handle, {"op": op, **body})
        self.runner = SimpleNamespace(id="pc-runner", caps=["conversationContent1"], alive=lambda: True, call=call)
        for target, name, replacement in (
            (runner_hub, "get", lambda *args: self.runner),
            (runner_hub, "for_client", lambda *args: self.runner),
            (desktop_capabilities, "resolve", AsyncMock(return_value=(self.client, self.runner))),
        ):
            mocked = patch.object(target, name, replacement)
            mocked.start()
            self.addCleanup(mocked.stop)

    async def test_migration_and_restart_keep_original_input_without_hub_body(self):
        async with self.sessions() as session:
            row = await session.get(models.AiScheduleRun, "run")
            self.assertTrue((await migration.schedule(session, self.client, row))["ok"])
            self.assertNotIn("original expanded input", str(row.receipt))
            plan = await session.get(models.AiSchedule, "plan")
            plan.note = "edited later"
            await session.commit()
        self.store = Store(self.root.name)
        async with self.sessions() as session:
            row = await session.get(models.AiScheduleRun, "run")
            envelope = await schedule_content.load(session, self.client, row, row.receipt["conversationInput"])
            self.assertEqual(envelope["text"], "original expanded input")
            self.assertEqual(envelope["modelName"], "selected")
            _, query = inventory.query("schedule", self.client.user_ref)
            self.assertEqual(list((await session.scalars(query)).all()), [])
            self.assertTrue((await migration.schedule(session, self.client, row))["alreadyMigrated"])

    async def test_offline_migration_retains_body_and_strict_writer_does_not_fallback(self):
        with patch.object(desktop_capabilities, "resolve", AsyncMock(side_effect=HTTPException(409, "offline"))), \
             patch.object(conversation_content, "metadata_only", return_value=True):
            async with self.sessions() as session:
                row = await session.get(models.AiScheduleRun, "run")
                with self.assertRaises(HTTPException):
                    await migration.schedule(session, self.client, row)
                with self.assertRaises(HTTPException):
                    await schedule_content.save(session, self.client, row, {"text": "new material"})
                await session.rollback()
            async with self.sessions() as session:
                self.assertEqual((await session.get(models.AiScheduleRun, "run")).receipt["conversationInput"]["text"], "original expanded input")

    async def test_late_receipt_change_and_wrong_account_prevent_removal(self):
        original = self.runner.call
        async def change(op, body, **options):
            result = await original(op, body, **options)
            if op == "content.seal":
                async with self.sessions() as session:
                    row = await session.get(models.AiScheduleRun, "run")
                    row.receipt = {**row.receipt, "conversationId": "accepted-in-the-meantime"}
                    await session.commit()
            return result
        self.runner.call = change
        async with self.sessions() as session:
            row = await session.get(models.AiScheduleRun, "run")
            with self.assertRaises(HTTPException):
                await migration.schedule(session, self.client, row)
            self.assertEqual(row.receipt["conversationInput"]["text"], "original expanded input")
            self.client.user_ref = "other-account"
            with self.assertRaises(HTTPException) as error:
                await migration.schedule(session, self.client, row)
            self.assertEqual(error.exception.status_code, 403)
