"""Real stream/settlement entrypoints with isolated state; no model or DB calls."""
import json
import os
import subprocess
import sys
import threading
import time
import tempfile
import unittest
from unittest.mock import patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
_data = tempfile.TemporaryDirectory(prefix="soduwork-test-truncated-")
os.environ["SODUWORK_DATA_ROOT"] = _data.name
from app.services import ai_local, local_stream, local_turn_outcome, model_errors
from app.services.local_base import _RUNS


class TurnOutcomeTests(unittest.TestCase):
    def setUp(self):
        self.ref = "isolated-truncated"
        self.run = {"state": "running", "cli": "pi", "ws": _data.name,
                    "seq": 0, "lines": [], "cfg": {}, "artifactMode": "files",
                    "expectedOutputPaths": ["product-source.zip"]}
        _RUNS[self.ref] = self.run
        self.addCleanup(lambda: _RUNS.pop(self.ref, None))

    def event(self, reason):
        terminal = {}
        local_stream._on_line(self.ref, json.dumps({"type": "message_end", "message": {
            "role": "assistant", "content": [], "stopReason": reason}}), terminal)
        return terminal

    def finish(self, terminal, **changes):
        self.run.update(changes)
        with patch.object(local_stream, "_resume", return_value={"ok": True}) as resume:
            local_stream._finish(self.ref, 0, terminal, "")
        return resume

    def test_zero_exit_truncation_resumes_same_node_without_false_done(self):
        terminal = self.event("length")
        self.assertTrue(terminal["outputTruncated"])
        resume = self.finish(terminal)
        self.assertEqual(self.run["state"], "recovering")
        self.assertEqual(self.run["completionRetries"], 1)
        self.assertEqual(resume.call_args.args[0], self.ref)
        self.assertIn("product-source.zip", resume.call_args.args[1])
        self.assertIn("不代替用户审批", resume.call_args.args[1])
        self.assertTrue(any("模型输出被截断" in x["text"] for x in self.run["lines"]))

    def test_second_truncation_fails_and_keeps_existing_progress(self):
        resume = self.finish(self.event("length"), completionRetries=1)
        resume.assert_not_called()
        self.assertEqual(self.run["state"], "failed")
        self.assertEqual(self.run["failureKind"], "execution_incomplete")
        self.assertIn("输出上限", self.run["error"])

    def test_normal_chat_and_queued_user_input_are_not_repeated(self):
        for changes in ({"expectedOutputPaths": []}, {"queue": ["user follow-up"]}):
            with self.subTest(changes=changes):
                self.run.update(state="running", expectedOutputPaths=["product-source.zip"])
                resume = self.finish(self.event("length"), **changes)
                resume.assert_not_called()
                self.assertEqual(self.run["state"], "failed")

    def test_model_error_is_not_hidden_by_zero_exit(self):
        resume = self.finish(self.event("error"))
        resume.assert_not_called()
        self.assertEqual(self.run["state"], "failed")

    def test_pi_model_404_survives_stream_settlement_and_session_projection(self):
        terminal = {}
        message = {"role": "assistant", "content": [], "stopReason": "error",
                   "errorMessage": "404 status code (no body)"}
        for event in ({"type": "message_end", "message": message},
                      {"type": "turn_end", "message": message},
                      {"type": "agent_end", "messages": [message]}):
            local_stream._on_line(self.ref, json.dumps(event), terminal)
        self.finish(terminal).assert_not_called()
        page = ai_local.session_sync({}, self.ref)
        self.assertTrue(page["ok"])
        self.assertEqual(page["status"], "failed")
        self.assertIn("HTTP 404", page["error"])
        self.assertIn("切换可用模型", page["error"])

    def test_model_diagnostics_classify_without_publishing_provider_body(self):
        for value, expected in (
            ('401 {"secret":"private-key"}', "HTTP 401"),
            ({"error": {"status": 403, "message": "Bearer private-key"}}, "HTTP 403"),
            ('404 status code (no body)', "HTTP 404"),
            ('429 {"error":{"code":"limited","message":"private-key"}}', "HTTP 429"),
            ('502 <html>private-key https://internal.test</html>', "HTTP 502"),
            ('Error status_code: 422 private-key', "HTTP 422"),
            ('fetch failed private-key', "暂时不可用"),
            ('unrecognized private-key', "模型调用失败"),
        ):
            with self.subTest(value=value):
                public = model_errors.public_failure(value)
                self.assertIn(expected, public)
                self.assertNotIn("private-key", public)
                self.assertNotIn("internal.test", public)

    def test_pi_error_never_overwrites_an_unrelated_terminal_failure(self):
        terminal = {"isError": True, "result": "execution policy rejected"}
        local_turn_outcome.observe("pi", {"type": "message_end", "message": {
            "role": "assistant", "stopReason": "error", "errorMessage": "404"}}, terminal)
        self.assertEqual(terminal, {"isError": True, "result": "execution policy rejected"})

    def test_latest_success_replaces_earlier_length_inside_one_process(self):
        terminal = {"outputTruncated": True}
        local_turn_outcome.observe("pi", {"type": "message_end", "message": {
            "role": "assistant", "stopReason": "stop"}}, terminal)
        self.assertNotIn("outputTruncated", terminal)
        self.assertTrue(terminal["piFinalResponse"])
        self.finish(terminal).assert_not_called()
        self.assertEqual(self.run["state"], "done")

    def test_agent_end_stop_does_not_preempt_extension_cleanup(self):
        terminal = {}
        local_stream._on_line(self.ref, json.dumps({"type": "agent_end", "messages": [
            {"role": "assistant", "content": [], "stopReason": "stop"}]}), terminal)
        self.assertNotIn("piFinalResponse", terminal)

    def test_later_pi_events_clear_the_candidate_before_the_grace_expires(self):
        terminal = {}
        local_stream._on_line(self.ref, json.dumps({"type": "message_end", "message": {
            "role": "assistant", "stopReason": "stop"}}), terminal)
        self.assertGreater(self.run.get("piFinalResponseAt", 0), 0)
        local_stream._on_line(self.ref, json.dumps({"type": "agent_settled"}), terminal)
        self.assertNotIn("piFinalResponseAt", self.run)

    def test_watchdog_settlement_accepts_the_killed_pi_exit_code(self):
        terminal = self.event("stop")
        self.run["piSettledByWatchdog"] = True
        with patch.object(local_stream, "_resume", return_value={"ok": True}) as resume:
            local_stream._finish(self.ref, -9, terminal, "")
        resume.assert_not_called()
        self.assertEqual(self.run["state"], "done")
        self.assertEqual(self.run["exit"], -9, "retain the actual process exit for diagnostics")
        self.assertNotIn("piSettledByWatchdog", self.run, "cleanup ownership is consumed once")

    def test_watchdog_marker_cannot_hide_real_failures_or_later_events(self):
        cases = [
            ("unmarked kill", {"piSettledByWatchdog": False}, {}, "", "failed"),
            ("other agent", {"cli": "codex"}, {}, "", "failed"),
            ("no current candidate", {"piFinalResponseAt": 0}, {}, "", "failed"),
            ("no final response", {}, {"piFinalResponse": False}, "", "failed"),
            ("model error", {}, {"isError": True, "result": "model rejected"}, "", "failed"),
            ("transport error", {}, {}, "transport failed", "failed"),
            ("truncated output", {}, {"outputTruncated": True}, "", "failed"),
            ("permission denied", {"permissionDenied": True}, {}, "", "failed"),
            ("policy violation", {"executionPolicyViolation": {"reason": "policy blocked"}}, {}, "", "failed"),
            ("explicit stop", {"stopping": True}, {}, "", "stopped"),
            ("timeout exhausted", {"timedOut": "fixture timeout", "stallRetries": 99}, {}, "", "failed"),
        ]
        for name, changes, fields, error, expected in cases:
            with self.subTest(name=name):
                self.run.clear()
                self.run.update(state="running", cli="pi", ws=_data.name, seq=0, lines=[], cfg={},
                                artifactMode="files", expectedOutputPaths=[], piSettledByWatchdog=True)
                terminal = self.event("stop")
                self.run.update(changes)
                terminal.update(fields)
                with patch.object(local_stream, "_resume", return_value={"ok": True}) as resume:
                    local_stream._finish(self.ref, -9, terminal, error)
                resume.assert_not_called()
                self.assertEqual(self.run["state"], expected)
                self.assertNotIn("piSettledByWatchdog", self.run)
        # A subsequent event invalidates the earlier candidate even if the
        # watchdog marker was already set during its cleanup race.
        self.run.update(state="running", cli="pi", piSettledByWatchdog=True,
                        stopping=False, permissionDenied=False, executionPolicyViolation={})
        terminal = self.event("stop")
        local_stream._on_line(self.ref, json.dumps({"type": "agent_settled"}), terminal)
        local_stream._finish(self.ref, -9, terminal, "")
        self.assertEqual(self.run["state"], "failed")

    def test_real_process_final_response_watchdog_cleanup_settles_successfully(self):
        from app.services import local_process
        source = (
            "import json,time; print(json.dumps({'type':'message_end','message':"
            "{'role':'assistant','stopReason':'stop','content':"
            "[{'type':'text','text':'Synthetic final answer'}]}}),flush=True); time.sleep(45)")
        child = subprocess.Popen(
            [sys.executable, "-u", "-c", source], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL, text=True, encoding="utf-8",
            **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt"
               else {"start_new_session": True}))
        observed = []
        ready = threading.Event()
        def read_first_line():
            observed.append(child.stdout.readline())
            ready.set()
        reader = threading.Thread(target=read_first_line, daemon=True)
        reader.start()
        before = set(local_process._THREADS)
        try:
            self.assertTrue(ready.wait(5), "synthetic process must emit its final response")
            self.assertTrue(observed[0], "child exited before emitting a response")
            self.run.update(proc=child, pid=child.pid, started=time.time(), lastOut=time.time(),
                            expectedOutputPaths=[])
            terminal = {}
            local_stream._on_line(self.ref, observed[0], terminal)
            self.assertTrue(terminal["piFinalResponse"])
            local_process._watchdog(self.ref, child, finish=local_stream._finish,
                                    kill_tree=local_stream._kill_tree)
            code = child.wait(timeout=20)
            self.assertNotEqual(code, 0, "the real hung process must be killed by the watchdog")
            for thread in set(local_process._THREADS) - before:
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive(), "watchdog must finish after its owned kill")
            self.assertTrue(self.run.get("piSettledByWatchdog"))
            local_stream._finish(self.ref, code, terminal, "")
            self.assertEqual(self.run["state"], "done")
            self.assertEqual(self.run["error"], "")
            self.assertEqual(self.run["exit"], code)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            child.stdout.close()
            child.stderr.close()
            reader.join(timeout=1)

    def test_progress_and_other_agent_events_do_not_mark_truncation(self):
        for cli, kind in (("pi", "message_update"), ("codex", "message_end")):
            terminal = {}
            local_turn_outcome.observe(cli, {"type": kind, "message": {
                "role": "assistant", "stopReason": "length"}}, terminal)
            self.assertEqual(terminal, {})

    def test_internal_model_retry_success_does_not_keep_stale_failure(self):
        terminal = self.event("error")
        local_turn_outcome.observe("pi", {"type": "message_end", "message": {
            "role": "assistant", "stopReason": "stop"}}, terminal)
        self.assertNotIn("isError", terminal)
        self.assertNotIn("result", terminal)
        self.finish(terminal).assert_not_called()
        self.assertEqual(self.run["state"], "done")

    def test_success_never_clears_unrelated_terminal_failure(self):
        terminal = {"isError": True, "result": "transport failed"}
        local_turn_outcome.observe("pi", {"type": "message_end", "message": {
            "role": "assistant", "stopReason": "stop"}}, terminal)
        self.assertTrue(terminal["isError"])
        self.finish(terminal).assert_not_called()
        self.assertEqual(self.run["state"], "failed")

    def test_claude_result_text_only_becomes_error_on_actual_failure(self):
        for failed in (False, True):
            with self.subTest(failed=failed):
                self.run.update(state="running", cli="claude", queue=[], lines=[])
                terminal = {}
                text = "Provider authentication failed" if failed else "Completed the requested work"
                local_stream._on_line(self.ref, json.dumps({"type": "result",
                    "is_error": failed, "result": text}), terminal)
                self.finish(terminal).assert_not_called()
                self.assertEqual(self.run["state"], "failed" if failed else "done")
                self.assertEqual(self.run["error"], text if failed else "")


if __name__ == "__main__":
    unittest.main()
