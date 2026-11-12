"""Turn identity survives backlog, later desktop turns and archive recovery without a model."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from test_handoff_target_diagnostics import TargetDiagnosticsTests as _Base
from app import db, models
from app.automation_models import ExecutionEvent, ExecutionSession, RunnerNode
from app.services import ai_local, execution_sessions, im_execution, local_base, local_ctx, local_stream, turn_correlation
from runner_main import Runner
from sqlalchemy import select


class RuntimeCorrelationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-turn-correlation-")
        self.addCleanup(self.temp.cleanup)
        self.store = patch.object(local_base, "_STORE", self.temp.name)
        self.store.start()
        self.addCleanup(self.store.stop)
        self.ref = "correlation-fixture"
        self.addCleanup(local_base._RUNS.pop, self.ref, None)
        self.run = {"state":"running", "round":2, "segment":1, "seq":0, "lines":[],
                    "admissionKey":"comment:mobile-turn", "admissionStartSeq":0, "taskId":"task", "cli":"pi", "ws":self.temp.name}
        local_base._RUNS[self.ref] = self.run

    def test_stream_events_and_terminal_marker_remain_bound_after_later_turn(self):
        local_stream._on_line(self.ref, json.dumps({"type":"text", "part":{"text":"mobile answer"}}), {})
        self.assertTrue(self.run["lines"])
        self.assertTrue(all(item["round"] == 2 and item["admissionKey"] == "comment:mobile-turn" for item in self.run["lines"]))
        self.run["state"] = "done"
        local_base._save_meta(self.ref)
        boundary = self.run["seq"]
        local_base._save_meta(self.ref)
        self.assertEqual(self.run["seq"], boundary, "terminal marker must be idempotent")
        self.run.update(state="running", round=3, admissionKey="comment:desktop-turn")
        local_base._record_event(self.ref, {"kind":"say", "text":"desktop answer"})
        archived = local_base._read_events(self.ref)
        ends = [item for item in archived if item["kind"] == "turn-end"]
        self.assertEqual(len(ends), 1)
        self.assertEqual((ends[0]["round"], ends[0]["admissionKey"], ends[0]["turnState"]), (2,"comment:mobile-turn","done"))
        self.assertEqual(archived[-1]["admissionKey"], "comment:desktop-turn")
        self.assertEqual(archived[-1]["round"], 3)

    def test_heartbeat_pagination_keeps_old_turn_identity_and_late_terminal_marker(self):
        for i in range(305):
            local_base._record_event(self.ref, {"kind":"say", "text":str(i)})
        self.run["state"] = "done"
        local_base._save_meta(self.ref)
        machine = object.__new__(Runner)
        machine._agent_inventory = []
        machine._session_marks = {}
        first, advances = machine._session_snapshots()
        self.assertEqual(first[0]["turnCorrelationVersion"], 1)
        self.assertEqual(first[0]["admissionKey"], "comment:mobile-turn")
        self.assertEqual(len(first[0]["items"]), 300)
        self.assertFalse(any(item["kind"] == "turn-end" for item in first[0]["items"]))
        machine._apply_marks(advances)
        self.run.update(state="running", round=3, admissionKey="comment:desktop-turn")
        local_base._record_event(self.ref, {"kind":"say", "text":"desktop output"})
        second, _ = machine._session_snapshots()
        old = [item for item in second[0]["items"] if item["admissionKey"] == "comment:mobile-turn"]
        self.assertEqual(old[-1]["kind"], "turn-end")
        self.assertTrue(all(item["round"] == 2 for item in old))
        self.assertEqual(second[0]["admissionKey"], "comment:desktop-turn")

    def test_archive_restore_does_not_duplicate_end_or_accept_unbounded_identity(self):
        self.run["state"] = "failed"
        local_base._save_meta(self.ref)
        stored = json.loads(Path(local_base._store_dir(self.ref), "meta.json").read_text(encoding="utf-8"))
        self.assertEqual(stored["admissionStartSeq"], 0)
        self.assertIsNone(turn_correlation.terminal(stored))
        for bad in ["token secret", "comment:" + "x" * 200, "comment:\nsecret", {}, None]:
            self.assertEqual(turn_correlation.public({"admissionKey":bad}), {})

    def test_resume_preserves_a_terminal_turn_before_delayed_metadata_save(self):
        from app.services import access_policy, codex_account_acp, skill_read_scope
        self.run.update(state="stopped", cfg={})
        with patch.object(skill_read_scope, "for_run"), \
             patch.object(access_policy, "prepare", return_value=None), \
             patch.object(codex_account_acp, "legacy_policy_issue", return_value=""), \
             patch.object(codex_account_acp, "retained_config", return_value={}), \
             patch.dict(local_base._PROFILES, {"pi":{"bin":lambda:None}}):
            result = local_ctx.prepare_resume(self.ref, "next turn", {"_admissionKey":"comment:desktop-turn"})
        self.assertFalse(result["ok"], "the fixture must not launch a process")
        events = local_base._read_events(self.ref)
        old = [item for item in events if item.get("admissionKey") == "comment:mobile-turn"]
        self.assertEqual(len(old), 1)
        self.assertEqual((old[0]["kind"], old[0]["round"], old[0]["turnState"]), ("turn-end", 2, "stopped"))
        self.assertEqual(events[-1]["admissionKey"], "comment:desktop-turn")
        self.assertEqual(events[-1]["admissionStartSeq"], 1)
        self.assertEqual(self.run["admissionStartSeq"], 1)

    def test_automatic_recovery_keeps_the_admitted_turn_start(self):
        from app.services import access_policy, codex_account_acp, skill_read_scope
        local_base._record_event(self.ref, {"kind":"say", "text":"before recovery"})
        self.run.update(cfg={}, cliSid="fixture-session", turnStartSeq=1)
        with patch.object(skill_read_scope, "for_run"), \
             patch.object(access_policy, "prepare", return_value=None), \
             patch.object(codex_account_acp, "legacy_policy_issue", return_value=""), \
             patch.object(codex_account_acp, "retained_config", return_value={}), \
             patch.object(local_stream, "_spawn"), \
             patch.dict(local_base._PROFILES, {"pi":{"bin":lambda:"fixture", "resume":lambda *args:[]}}):
            self.assertTrue(local_ctx.prepare_resume(self.ref, "recover", None, recovery=True)["ok"])
        self.assertEqual(self.run["admissionStartSeq"], 0)
        self.run["state"] = "done"
        local_base._save_meta(self.ref)
        self.assertEqual(local_base._read_events(self.ref)[-1]["admissionStartSeq"], 0)


class HubCorrelationTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = _Base.asyncSetUp
    asyncTearDown = _Base.asyncTearDown

    async def test_native_answers_keep_full_text_through_heartbeat_and_im_reply(self):
        shapes = {
            "pi": lambda text: {"type":"message_update","assistantMessageEvent":{"type":"text_end","content":text}},
            "opencode": lambda text: {"type":"text","part":{"text":text}},
            "codex": lambda text: {"type":"item.completed","item":{"type":"agent_message","text":text}},
            "claude": lambda text: {"type":"assistant","message":{"content":[{"type":"text","text":text}]}},
            "stream": lambda text: {"type":"item.completed","item":{"id":"answer-stream","type":"agent_message","text":text}},
        }
        runner = SimpleNamespace(id=self.prefix + "-runner", client_id=self.client_id, org_id="", host="Fixture")
        with tempfile.TemporaryDirectory(prefix="soduwork-im-output-") as directory, \
             patch.object(local_base, "_STORE", directory), patch.dict(local_base._RUNS, clear=True):
            for name, shape in shapes.items():
                for size in (8000, 60000):
                    with self.subTest(provider=name, size=size):
                        task_id = self.prefix + "-" + name + str(size)
                        ref = task_id + "-ref"
                        answer = "A" * size + "END"
                        admission = "comment:" + name + str(size)
                        local_base._RUNS.clear()
                        run = {"state":"running","round":2,"segment":1,"seq":0,"lines":[],
                            "admissionKey":admission,"admissionStartSeq":0,"taskId":task_id,"cli":"pi","ws":directory}
                        local_base._RUNS[ref] = run
                        local_stream._on_line(ref, json.dumps(shape(answer)), {})
                        run["state"] = "done"
                        local_base._save_meta(ref)
                        machine = object.__new__(Runner)
                        machine._agent_inventory, machine._session_marks = [], {}
                        snapshots, _ = machine._session_snapshots()
                        async with db.SessionLocal() as session:
                            session.add(models.Task(id=task_id, title="Full answer", owner_client_id=self.client_id, status="doing"))
                            session.add(models.TaskEvent(task_id=task_id, kind="ai.dispatched", actor="fixture", detail={"ref":ref,"runnerId":runner.id}))
                            await session.commit()
                            await execution_sessions.ingest_runner_snapshots(session, runner, snapshots)
                            await session.commit()
                            row = await session.scalar(select(ExecutionSession).where(ExecutionSession.ref == ref))
                            result = await im_execution.final_text(session, row, SimpleNamespace(admission_key=admission))
                            if size == 8000:
                                self.assertEqual(result, answer, "a display preview must not replace the actual answer")
                            else:
                                self.assertIn("部分内容", result)
                                self.assertLessEqual(len(result), 14000)
                                events = list((await session.scalars(select(ExecutionEvent).where(ExecutionEvent.session_id == row.id))).all())
                                self.assertTrue(any(event.detail.get("textTruncated") for event in events))

    async def test_ingestion_preserves_per_event_turn_in_a_later_round_snapshot(self):
        task_id, ref = self.prefix + "-task", self.prefix + "-ref"
        runner = SimpleNamespace(id=self.prefix + "-runner", client_id=self.client_id, org_id="", host="Fixture")
        async with db.SessionLocal() as session:
            # Live read-through resolves identity from the durable Runner registry.
            session.add(RunnerNode(id=runner.id, client_id=self.client_id, auth_state="active"))
            session.add(models.Task(id=task_id, title="Bound output", owner_client_id=self.client_id, status="doing"))
            session.add(models.TaskEvent(task_id=task_id, kind="ai.dispatched", actor="fixture", detail={"ref":ref,"runnerId":runner.id}))
            await session.commit()
            await execution_sessions.ingest_runner_snapshots(session, runner, [{"ref":ref,"taskId":task_id,
                "round":3,"status":"running","admissionKey":"comment:desktop-turn","turnCorrelationVersion":1,"seq":3,
                "items":[{"seq":1,"kind":"say","text":"mobile output","round":2,"admissionKey":"comment:mobile-turn"},
                         {"seq":2,"kind":"turn-end","text":"","round":2,"admissionKey":"comment:mobile-turn","turnState":"done"},
                         {"seq":3,"kind":"say","text":"desktop output","round":3,"admissionKey":"comment:desktop-turn"}]}])
            await session.commit()
            row = await session.scalar(select(ExecutionSession).where(ExecutionSession.ref == ref))
            events = list((await session.scalars(select(ExecutionEvent).where(ExecutionEvent.session_id == row.id).order_by(ExecutionEvent.seq))).all())
            self.assertEqual(row.metadata_["admissionKey"], "comment:desktop-turn")
            self.assertEqual(events[0].detail["round"], 2)
            self.assertEqual(events[1].detail["admissionKey"], "comment:mobile-turn")
            self.assertEqual(events[1].detail["turnState"], "done")
            self.assertEqual(events[1].kind, "turn-end")
            task = await session.get(models.Task, task_id)
            live = await execution_sessions.ingest_live_snapshot(session, task, ref, {"ok":True,"runnerId":runner.id,
                "round":4,"status":"running","admissionKey":"comment:read-through","turnCorrelationVersion":1,"items":[]})
            self.assertIsNotNone(live)
            self.assertEqual(row.metadata_["admissionKey"], "comment:read-through")
            await execution_sessions.ingest_runner_snapshots(session, runner, [{"ref":ref,"taskId":task_id,"round":5,"status":"running","items":[]}])
            self.assertNotIn("admissionKey", row.metadata_, "an old Runner must not inherit a previous turn identity")


if __name__ == "__main__":
    unittest.main()
