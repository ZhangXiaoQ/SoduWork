"""Structured refinement failures retain their first safe cause across upstream fallback."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from app.services import harness2_engine as engine, harness2_errors as errors


class RefinementErrorTests(unittest.TestCase):
    private = "fixture-secret provider-private-body user-private-prompt"

    def fault(self, code, **fields):
        self.assertTrue(hasattr(errors, "StructuredFailure"), "Structured failures must exist")
        return errors.StructuredFailure(code, **fields)

    @staticmethod
    def reply(messages):
        if "SODUWORK_HARNESS2_EDIT" in messages[0]["content"]:
            return '{"files":{},"notes":""}'
        return "Plan."

    def test_structured_rendering_validates_fields_and_ignores_exception_text(self):
        fault = self.fault("model_http", phase="inv1.a1", http_status=429)
        fault.args = (self.private,)
        rendered = errors.failure_message(fault, "refine")
        self.assertIn("提出通用方法改进", rendered)
        self.assertIn("HTTP 429", rendered)
        self.assertIn("限流", rendered)
        self.assertNotIn(self.private, rendered)
        for code, phase, status in ((self.private, self.private, self.private), ([], {}, True)):
            fault = self.fault(code, phase=phase, http_status=status)
            self.assertEqual(fault.code, "unknown")
            self.assertEqual(fault.phase, "")
            self.assertIsNone(fault.http_status)
            self.assertNotIn(self.private, str(fault))
        fault = self.fault("model_timeout", phase="base1", http_status=999999)
        self.assertIsNone(fault.http_status)
        fault.code, fault.phase, fault.http_status = self.private, self.private, self.private
        self.assertNotIn(self.private, errors.failure_message(fault, "refine"))

    def test_model_failure_keeps_code_phase_status_and_stops_later_model_calls(self):
        for target in ("base1", "inv1.a1", "c1.a1", "c1"):
            for code, status in (("model_timeout", None), ("model_http", 429)):
                with self.subTest(target=target, code=code), tempfile.TemporaryDirectory() as temp:
                    calls = []
                    def complete(messages):
                        label = messages[0]["content"].split("stage=", 1)[1].splitlines()[0]
                        calls.append(label)
                        if label == target:
                            raise self.fault(code, http_status=status)
                        return self.reply(messages)
                    with self.assertRaises(engine.Harness2RefinementError) as caught:
                        engine.refine("Fixture task", complete, Path(temp) / "turn", lambda _: None)
                    fault = caught.exception
                    self.assertEqual(getattr(fault, "code", None), code)
                    self.assertEqual(fault.phase, target)
                    self.assertEqual(fault.http_status, status)
                    self.assertEqual(calls[-1], target)
                    self.assertEqual(calls.count(target), 1)
                    self.assertFalse((Path(temp) / "turn/refinement.json").exists())

    def test_proposal_json_schema_scope_and_limits_remain_distinct_and_strict(self):
        cases = (
            ('```json\n{"files":{},"notes":""}\n```', "proposal_json"),
            ('{"files":{}}', "proposal_schema"),
            ('{"files":[],"notes":""}', "proposal_schema"),
            ('{"files":{"systemprompt.md":null},"notes":""}', "proposal_schema"),
            ('{"files":{"../escape.md":"no"},"notes":""}', "proposal_scope"),
            (json.dumps({"files": {"systemprompt.md": "x" * 12001}, "notes": ""}), "proposal_limit"),
            (json.dumps({"files": {}, "notes": "x" * 4001}), "proposal_limit"),
        )
        for response, code in cases:
            with self.subTest(code=code), tempfile.TemporaryDirectory() as temp:
                def complete(messages):
                    return response if "stage=inv1.a1\n" in messages[0]["content"] else self.reply(messages)
                with self.assertRaises(engine.Harness2RefinementError) as caught:
                    engine.refine("Fixture task", complete, Path(temp) / "turn", lambda _: None)
                self.assertEqual(getattr(caught.exception, "code", None), code)
                self.assertEqual(caught.exception.phase, "inv1.a1")
                self.assertFalse((Path(temp) / "escape.md").exists())

    def test_unknown_errors_never_trust_an_exception_name_or_its_private_text(self):
        self.assertTrue(hasattr(errors, "Harness2Error"))
        for failure in (RuntimeError(self.private), errors.Harness2Error(self.private)):
            with self.subTest(kind=type(failure).__name__), tempfile.TemporaryDirectory() as temp:
                with self.assertRaises(engine.Harness2RefinementError) as caught:
                    engine.refine("Fixture task", lambda _: (_ for _ in ()).throw(failure),
                                  Path(temp) / "turn", lambda _: None)
                self.assertEqual(getattr(caught.exception, "code", None), "unknown")
                self.assertNotIn(self.private, str(caught.exception))
                for path in (Path(temp) / "turn").rglob("*"):
                    if path.is_file():
                        self.assertNotIn(self.private, path.read_text(encoding="utf-8"))

    def test_structured_subclass_cannot_override_safe_rendering_or_persist_private_text(self):
        private = self.private
        class HostileFailure(errors.StructuredFailure):
            def __str__(self):
                return private
        failure = HostileFailure("model_timeout")
        self.assertNotIn(private, errors.failure_message(failure, "refine"))
        with tempfile.TemporaryDirectory() as temp:
            def complete(messages):
                if "stage=inv1.a1\n" in messages[0]["content"]:
                    raise failure
                return self.reply(messages)
            with self.assertRaises(engine.Harness2RefinementError) as caught:
                engine.refine("Task", complete, Path(temp) / "turn", lambda _: None)
            self.assertEqual(caught.exception.code, "model_timeout")
            self.assertEqual(caught.exception.phase, "inv1.a1")
            for path in (Path(temp) / "turn").rglob("*"):
                if path.is_file():
                    self.assertNotIn(private, path.read_text(encoding="utf-8"))

    def test_empty_oversized_and_unwritable_plan_do_not_become_successful_rollouts(self):
        for answer, code in (("", "response_empty"), ("x" * 24001, "response_limit")):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as temp:
                with self.assertRaises(engine.Harness2RefinementError) as caught:
                    engine.refine("Task", lambda _: answer, Path(temp) / "turn", lambda _: None)
                self.assertEqual(caught.exception.code, code)
                self.assertEqual(caught.exception.phase, "base1")
        original_write = Path.write_text
        def write(path, data, *args, **kwargs):
            if path.name == "plan.md":
                raise PermissionError(self.private)
            return original_write(path, data, *args, **kwargs)
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(Path, "write_text", write):
                with self.assertRaises(engine.Harness2RefinementError) as caught:
                    engine.refine("Task", self.reply, Path(temp) / "turn", lambda _: None)
            self.assertEqual(caught.exception.code, "workspace_io")
            self.assertEqual(caught.exception.phase, "base1")
            self.assertNotIn(self.private, str(caught.exception))
            self.assertFalse((Path(temp) / "turn/refinement.json").exists())

    def test_progress_cancellation_workspace_io_and_evidence_limits_are_distinct(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(engine.Harness2RefinementError) as caught:
                engine.refine("Task", self.reply, Path(temp) / "turn",
                              lambda _: (_ for _ in ()).throw(RuntimeError(self.private)))
            self.assertEqual(getattr(caught.exception, "code", None), "cancelled")
            self.assertEqual(caught.exception.phase, "base1")
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(engine.tree, "write_tree", side_effect=PermissionError(self.private)):
                with self.assertRaises(engine.Harness2RefinementError) as caught:
                    engine.refine("Task", self.reply, Path(temp) / "turn", lambda _: None)
            self.assertEqual(getattr(caught.exception, "code", None), "workspace_io")
            self.assertNotIn(self.private, str(caught.exception))
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(engine, "MAX_EVIDENCE_CHARS", 1):
                with self.assertRaises(engine.Harness2RefinementError) as caught:
                    engine.refine("Task", self.reply, Path(temp) / "turn", lambda _: None)
            self.assertEqual(getattr(caught.exception, "code", None), "evidence_limit")
            self.assertEqual(caught.exception.phase, "inv1.a1")


if __name__ == "__main__":
    unittest.main()
