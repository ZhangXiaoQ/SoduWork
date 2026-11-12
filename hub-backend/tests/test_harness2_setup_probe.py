"""Harness² daily-execution probe coverage and migration without live models."""
from __future__ import annotations

import json
import sys
import unittest
from unittest.mock import patch

from app.services import agent_setup, local_base


def protocol(*events):
    return "\n".join(json.dumps(event, ensure_ascii=False) for event in events)


def answer():
    return {"type": "text", "part": {"text": agent_setup._TOKEN, "done": True}}


def proof(**changes):
    return {"type": "harness2_probe_complete", "coverage": "native-execute-v1", "stages": 0, **changes}


class Harness2SetupProbeTests(unittest.TestCase):
    def run_probe(self, output, code=0, key="harness2"):
        result, logs = {}, []
        profile = {"name": "Google Harness²", "needs_llm": False, "start": lambda *_args: []}
        with (patch.dict(agent_setup._PROFILES, {key: profile}),
              patch.object(agent_setup, "_bin_of", return_value=sys.executable),
              patch.object(agent_setup, "_short", return_value="0.1.0"),
              patch.object(agent_setup, "_probe_ws", return_value="."),
              patch.object(agent_setup, "_command_argv", return_value=[sys.executable]),
              patch.object(local_base, "_env_for", return_value={}),
              patch.object(agent_setup, "_stream", return_value=(code, output)) as stream,
              patch.object(agent_setup, "_say", side_effect=lambda _jid, line: logs.append(line)),
              patch.object(agent_setup, "_save_probe", side_effect=lambda _key, record: result.update(record)),
              patch.object(agent_setup, "_done")):
            agent_setup._run_probe("fixture-job", key, {})
        return result, logs, stream.call_args.kwargs

    def test_token_without_daily_execution_proof_is_not_a_pass(self):
        for evidence in (None, proof(stages=7), proof(stages=False), proof(stages=0.0),
                         proof(coverage="executor-only"), proof(coverage="execute-v2"), proof(coverage="refine-v1", stages=7)):
            with self.subTest(evidence=evidence):
                result, _, _ = self.run_probe(protocol(answer(), *([evidence] if evidence else [])))
                self.assertFalse(result["ok"])
                self.assertIn("独立执行器", result["detail"])

    def test_complete_proof_token_and_zero_exit_are_all_required(self):
        result, logs, options = self.run_probe(protocol(answer(), proof()))
        self.assertTrue(result["ok"])
        self.assertEqual(result["coverage"], "native-execute-v1")
        self.assertEqual(options["timeout"], 180)
        self.assertNotIn("progress_line", options)
        self.assertTrue(any("独立执行器" in line and "额度" in line and "3 分钟" in line for line in logs))
        self.assertFalse(any("7 轮" in line or "10 分钟" in line for line in logs))
        self.assertIn("独立执行器", result["detail"])
        self.assertIn("不包含推演", result["detail"])
        for output, code in [(protocol(proof()), 0), (protocol(answer(), proof()), 124),
                             (protocol(answer(), proof(), {"error": {"message": "execution failed"}}), 0)]:
            with self.subTest(output=output, code=code):
                self.assertFalse(self.run_probe(output, code)[0]["ok"])

    def test_other_cli_timeout_result_logs_and_record_shape_are_unchanged(self):
        for key in ("opencode", "qwen", "pi", "codex"):
            with self.subTest(key=key):
                result, logs, options = self.run_probe(protocol(answer()), key=key)
                self.assertTrue(result["ok"])
                self.assertNotIn("coverage", result)
                self.assertEqual(options["timeout"], 180)
                self.assertNotIn("progress_line", options)
                self.assertFalse(any("7 轮" in line or "推演" in line for line in logs))

    def test_malformed_or_nested_proofs_cannot_claim_daily_execution(self):
        from app.services import harness2_probe
        for output in ("{invalid json", protocol({"error": proof()}), protocol([proof()]),
                       protocol(proof(type="text")), protocol(proof(stages="0"))):
            with self.subTest(output=output):
                self.assertFalse(harness2_probe.completed(output))

    def test_daily_probe_keeps_protocol_and_model_prose_out_of_display_logs(self):
        progress = {"type": "message_update", "assistantMessageEvent": {
            "type": "thinking_delta", "delta": "Harness²：生成初始执行计划\n"}}
        private = {"type": "message_update", "assistantMessageEvent": {
            "type": "thinking_delta", "delta": "private-model-body"}}
        payload = protocol(progress, private)
        options = self.run_probe(protocol(answer(), proof()))[2]
        options.pop("stdin_text", None)
        options["timeout"] = 10
        source = "import sys;sys.stdout.reconfigure(encoding='utf-8');print(" + repr(payload) + ")"
        with patch.object(agent_setup, "_say") as say:
            code, raw = agent_setup._stream("fixture", [sys.executable, "-c", source],
                **options)
        self.assertEqual(code, 0)
        logged = [call.args[1] for call in say.call_args_list][1:]  # command heading is separate
        self.assertFalse(any("1/7" in line for line in logged))
        self.assertFalse(any("private-model-body" in line for line in logged))
        self.assertIn("private-model-body", raw)

    def test_old_probe_success_is_unverified_without_rewriting_history_or_other_agents(self):
        from app.services import harness2_runtime
        old = {"ok": True, "at": 123, "detail": "old executor success", "steps": []}
        historical = {**old, "coverage": "refine-v1"}
        current = {**old, "coverage": "native-execute-v1"}
        with (patch.object(agent_setup, "_bin_of", return_value=sys.executable),
              patch.object(agent_setup, "_runtime_issue", return_value=""),
              patch.object(agent_setup, "_version_of", return_value=("0.1.0", "bundled", "")),
              patch.object(harness2_runtime, "is_bundled", return_value=True)):
            result = agent_setup.detect("harness2", probes={"harness2": old})
            refined = agent_setup.detect("harness2", probes={"harness2": historical})
            fresh = agent_setup.detect("harness2", probes={"harness2": current})
            other = agent_setup.detect("opencode", probes={"opencode": old})
            failed = agent_setup.detect("harness2", probes={"harness2": {**historical, "ok": False}})
        self.assertIsNone(result["probe"]["ok"])
        self.assertNotIn("at", result["probe"])
        self.assertEqual(result["probe"]["previous"], old)
        self.assertIn("执行组件", result["probe"]["detail"])
        self.assertEqual(result["setupState"], "ready")
        self.assertNotEqual(result["why"], result["probe"]["detail"])
        self.assertIsNone(refined["probe"]["ok"])
        self.assertEqual(refined["probe"]["previous"], historical)
        self.assertEqual(fresh["probe"], {**current, "historical": True})
        self.assertEqual(other["probe"], {**old, "historical": True})
        self.assertEqual(failed["probe"], {**historical, "ok": False, "historical": True})
        self.assertNotIn("historical", current)
        self.assertNotIn("historical", old)
        self.assertTrue(old["ok"])
        self.assertTrue(historical["ok"])


if __name__ == "__main__":
    unittest.main()
