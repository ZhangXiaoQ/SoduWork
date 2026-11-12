"""A resumed CLI ref must retire old errors and deliver each round's files.

Uses a migrated temporary database, actual artifact ingestion/local storage,
and a deterministic remote file provider. No business DB or model is contacted.
"""
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from test_handoff_target_diagnostics import TargetDiagnosticsTests as _Base, WORK
from app import db, models
from app.automation_models import ExecutionSession
from app.services import (ai_exec, artifact_ingest, code_delivery,
                          execution_sessions, execution_settlement,
                          project_context, storage, tasks)
from sqlalchemy import select


class ExecutionSessionRoundsTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = _Base.asyncSetUp
    asyncTearDown = _Base.asyncTearDown

    async def test_stopped_then_resumed_chat_updates_list_and_live_task_projection(self):
        await self.seed(state="stopped")
        with self.provider({"round": 2, "data": b"# Successful continuation"}):
            async with db.SessionLocal() as session:
                await execution_settlement.settle_terminal(session, self.tid, self.ref)
                stopped = (await tasks.ai_states(session, [self.tid]))[self.tid]
                self.assertEqual(stopped["state"], "stopped")
                await self.ingest(session, 2, "running", 1)
                task = await session.get(models.Task, self.tid)
                running = (await tasks.task_to_api_live(session, task))["ai"]
                self.assertEqual(running["state"], "running")
                self.assertNotIn("error", running)
                await self.ingest(session, 2, "done", 2)
                settled = await execution_settlement.settle_terminal(session, self.tid, self.ref)
                self.assertEqual(settled["task"]["ai"]["state"], "done")
                self.assertNotIn("error", settled["task"]["ai"])
                self.assertEqual((await tasks.ai_states(session, [self.tid]))[self.tid]["state"], "done")

    async def seed(self, *, round_no=1, state="failed", settlement=None):
        self.tid, self.ref = self.prefix + "-task", self.prefix + "-ref"
        self.runner = SimpleNamespace(id=self.prefix + "-runner", client_id=self.client_id,
                                      org_id="", host="Isolated test runner", version="1.0")
        async with db.SessionLocal() as session:
            task = models.Task(id=self.tid, title="Round recovery", owner_client_id=self.client_id,
                               status="doing")
            meta = {"round": round_no, "error": "" if state == "done" else "model unreachable"}
            if settlement:
                meta["terminalSettlement"] = settlement
            session.add_all([task, ExecutionSession(task_id=self.tid, ref=self.ref, state=state,
                            runner_id=self.runner.id, runner_client_id=self.client_id,
                            engine="pi", metadata_=meta), models.TaskEvent(task_id=self.tid,
                            kind="ai.dispatched", actor="test", detail={
                                "ref": self.ref, "provider": "fixture", "runnerId": self.runner.id})])
            await session.commit()

    async def ingest(self, session, round_no, state, seq, *, error=""):
        return await execution_sessions.ingest_runner_snapshots(session, self.runner, [{
            "ref": self.ref, "taskId": self.tid, "cli": "pi", "round": round_no,
            "status": state, "seq": seq, "error": error,
            "items": [{"seq": seq, "round": round_no,
                       "kind": "error" if error else "text", "text": error or "Round completed"}]}])

    def provider(self, state):
        stack = ExitStack()
        stack.enter_context(patch.object(storage, "_LOCAL_DIR", str(WORK / "round-artifacts")))
        fake = SimpleNamespace(fetch_attachment_for_sync=lambda *args: state["data"])
        stack.enter_context(patch.object(artifact_ingest, "_p", return_value=fake))
        stack.enter_context(patch.object(artifact_ingest, "_cfg_of", return_value={}))
        stack.enter_context(patch.object(artifact_ingest, "runner_info_sync", return_value={}))
        stack.enter_context(patch.object(ai_exec, "load", AsyncMock(return_value={})))
        stack.enter_context(patch.object(ai_exec, "status_sync", side_effect=lambda *args: {
            "ok": True, "done": True, "round": state["round"],
            "attachments": [{"id": "cloud-proof.md", "filename": "cloud-proof.md"}]}))
        stack.enter_context(patch.object(code_delivery, "check", AsyncMock(return_value={"applies": True})))
        stack.enter_context(patch.object(project_context, "record_completion", AsyncMock()))
        return stack

    async def test_user_plugin_badges_survive_sync_without_instructions_or_grants(self):
        await self.seed(state="done")
        async with db.SessionLocal() as session:
            execution = await session.scalar(select(ExecutionSession).where(ExecutionSession.task_id == self.tid))
            await execution_sessions.ingest_event_page(session, execution, [{
                "seq":1,"kind":"user","text":"summarize", "plugins":[{
                    "pluginId":"local:summary","name":"Summary","version":"1", "scopeLabel":"本人电脑",
                    "instructions":"private method", "authorization":"private grant", "path":"private/path"}]}])
            await session.commit()
            page = await execution_sessions.read_task(session,self.tid,self.ref)
            self.assertEqual(page['items'][0]['plugins'], [{
                "pluginId":"local:summary","name":"Summary","version":"1","scopeLabel":"本人电脑"}])

    async def test_failure_resume_success_then_same_filename_updated_without_duplicates(self):
        await self.seed()
        content = {"round": 2, "data": b"# Cloud proof\nROUND-TWO\n"}
        with self.provider(content):
            async with db.SessionLocal() as session:
                await self.ingest(session, 1, "failed", 1, error="model unreachable")
                await session.commit()
                failed = await execution_settlement.settle_terminal(session, self.tid, self.ref)
                self.assertEqual(failed["settlement"]["state"], "failed")
                self.assertEqual(failed["settlement"]["round"], 1)
                await self.ingest(session, 2, "running", 2)
                current = await execution_sessions.read_task(session, self.tid, self.ref)
                self.assertEqual(current["error"], "")
                self.assertEqual(current["finishedAt"], "")
                self.assertTrue(any(e["text"] == "model unreachable" for e in current["items"]))
                changed = await self.ingest(session, 2, "done", 3)
                self.assertEqual(changed[0]["settleTerminal"], "done")
                settled = await execution_settlement.settle_terminal(session, self.tid, self.ref)
                self.assertEqual(settled["settlement"]["files"], 1)
                self.assertTrue((await execution_settlement.settle_terminal(
                    session, self.tid, self.ref))["idempotent"])
                content.update(round=3, data=content["data"] + b"CLOUD-FOLLOWUP-OK\n")
                # Polling can miss the running phase entirely between turns.
                changed = await self.ingest(session, 3, "done", 4)
                self.assertEqual(changed[0]["settleTerminal"], "done")
                settled = await execution_settlement.settle_terminal(session, self.tid, self.ref)
                self.assertEqual(settled["settlement"]["round"], 3)
                self.assertEqual(settled["settlement"]["files"], 1)
                await execution_settlement.settle_terminal(session, self.tid, self.ref)
                attachments = (await session.execute(select(models.Attachment).where(
                    models.Attachment.task_id == self.tid).order_by(models.Attachment.created_at))).scalars().all()
                self.assertEqual(len(attachments), 2)
                self.assertEqual([a.evidence_meta["round"] for a in attachments], [2, 3])
                self.assertNotIn(b"CLOUD-FOLLOWUP-OK", storage.get(attachments[0].storage_key, attachments[0].backend))
                self.assertIn(b"CLOUD-FOLLOWUP-OK", storage.get(attachments[1].storage_key, attachments[1].backend))
                current = await execution_sessions.read_task(session, self.tid, self.ref)
                self.assertEqual(current["error"], "")
                self.assertEqual(len(current["items"]), 4)
                self.assertFalse((await self.ingest(session, 3, "done", 4))[0].get("settleTerminal"))

    async def test_existing_bad_historical_state_recovers_without_new_turn(self):
        await self.seed(round_no=3, state="done", settlement={"state": "failed", "error": "old failure"})
        with self.provider({"round": 3, "data": b"# Cloud proof\nRecovered before upgrade\n"}):
            async with db.SessionLocal() as session:
                current = await execution_sessions.read_task(session, self.tid, self.ref)
                self.assertEqual(current["error"], "")
                changed = await self.ingest(session, 3, "done", 4)
                self.assertEqual(changed[0]["settleTerminal"], "done")
                settled = await execution_settlement.settle_terminal(session, self.tid, self.ref)
                self.assertEqual(settled["settlement"]["files"], 1)
                self.assertEqual(settled["settlement"]["round"], 3)

    def test_legacy_failure_is_visible_but_explicit_clear_and_success_do_not_revive_it(self):
        row = ExecutionSession(ref="unit", task_id="unit", state="failed", metadata_={
            "terminalSettlement": {"state": "failed", "error": "legacy failure"}})
        self.assertEqual(execution_sessions.session_api(row)["error"], "legacy failure")
        row.metadata_ = {**row.metadata_, "error": ""}
        self.assertEqual(execution_sessions.session_api(row)["error"], "")
        row.metadata_ = {"terminalSettlement": {"state": "failed", "error": "legacy failure"}}
        row.state = "done"
        self.assertEqual(execution_sessions.session_api(row)["error"], "")
        row.state = "failed"
        row.metadata_ = {"round": 2, "error": "current failure", "terminalSettlement": {
            "state": "failed", "round": 1, "error": "previous failure"}}
        self.assertEqual(execution_sessions.session_api(row)["error"], "current failure")


if __name__ == "__main__":
    unittest.main()
