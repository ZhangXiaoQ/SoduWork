"""The embedded Harness² method must run real stages without business side effects."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from app.services import harness2_engine as H


class Harness2EngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "turn"
        self.calls = []
        self.progress = []

    def complete(self, messages):
        self.calls.append(messages)
        system = messages[0]["content"]
        if "SODUWORK_HARNESS2_EDIT" in system:
            return json.dumps({
                "files": {"systemprompt.md": "Check source units, then produce the requested result."},
                "notes": "The contrast shows that an explicit units check improves the plan.",
            })
        return "Plan: inspect the supplied figures, check units, calculate, and verify the result."

    def test_upstream_sequence_uses_four_probes_and_three_real_edit_stages(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            result = H.refine("核对数字并制作报告", self.complete, self.root, self.progress.append)
        self.assertIn("Check source units", result)
        self.assertNotIn("Plan: inspect", result)
        self.assertEqual(stdout.getvalue(), "")
        stages = [message[0]["content"].split("stage=", 1)[1].splitlines()[0]
                  for message in self.calls]
        self.assertEqual(stages, ["base1", "inv1.a1", "dom1.a1", "inv1", "dom1", "c1.a1", "c1"])
        report = json.loads((self.root / "refinement.json").read_text(encoding="utf-8"))
        self.assertEqual(report["ledger"]["R"], 4)
        self.assertEqual(report["ledger"]["P"], 3)
        self.assertEqual(report["finals"], ["c1"])
        self.assertEqual(report["fell_back"], [])
        self.assertEqual(len(self.progress), 7)
        proposal = next(m for m in self.calls if "stage=c1.a1" in m[0]["content"])
        self.assertIn("context/pool/inv1/rollout.md", proposal[1]["content"])
        self.assertIn("context/pool/dom1/rollout.md", proposal[1]["content"])
        self.assertTrue((self.root / "context/c1/harness/systemprompt.md").is_file())

    def test_rejects_scripts_paths_and_non_string_edits_without_running_them(self):
        for files in (
            {"scripts/helper.py": "raise RuntimeError('never execute')"},
            {"../escape.md": "outside"},
            {"C:\\outside.md": "outside"},
            {"systemprompt.md": {"not": "text"}},
        ):
            with self.subTest(files=files), tempfile.TemporaryDirectory() as temp:
                def invalid(messages):
                    if "SODUWORK_HARNESS2_EDIT" in messages[0]["content"]:
                        return json.dumps({"files": files, "notes": ""})
                    return "A planning result."
                with self.assertRaises(H.Harness2RefinementError):
                    H.refine("Make a report", invalid, Path(temp) / "turn", lambda _: None)
                self.assertFalse((Path(temp) / "escape.md").exists())

    def test_inline_evidence_deduplicates_only_identical_text_and_is_lossless(self):
        plan = 'Keep every constraint. Literal data: {"same_as":"context/task.md"}.\n' * 30
        proposals = {}

        def complete(messages):
            if "SODUWORK_HARNESS2_EDIT" in messages[0]["content"]:
                stage = messages[0]["content"].split("stage=", 1)[1].splitlines()[0].split(".a", 1)[0]
                proposals[stage] = json.loads(messages[1]["content"])["evidence"]
                return '{"files":{},"notes":"Preserve all evidence."}'
            return plan

        H.refine("Preserve the entire original task.", complete, self.root, lambda _: None)
        aliases = 0
        saved = 0
        self.assertEqual(set(proposals), {"inv1", "dom1", "c1"})
        for stage, evidence in proposals.items():
            context = self.root / "context" / stage
            paths = {"context/" + path.relative_to(context).as_posix(): path
                     for path in context.rglob("*") if path.is_file()}
            self.assertEqual(set(evidence), set(paths))
            for name, value in evidence.items():
                if isinstance(value, dict):
                    self.assertEqual(set(value), {"same_as"})
                    original = evidence[value["same_as"]]
                    self.assertIsInstance(original, str, "References must be one hop and acyclic")
                    aliases += 1
                    saved += len(original.encode("utf-8")) - len(json.dumps(value).encode("utf-8"))
                else:
                    original = value
                self.assertEqual(original, paths[name].read_text(encoding="utf-8"))
        self.assertGreaterEqual(aliases, 4)
        self.assertGreater(saved, 5000)

    def test_transport_errors_do_not_return_credentials_or_silent_base_fallback(self):
        secret = "sk-test-should-never-appear"
        stages = []
        def broken(messages):
            stages.append(messages[0]["content"].split("stage=", 1)[1].splitlines()[0])
            if "SODUWORK_HARNESS2_EDIT" in messages[0]["content"]:
                raise RuntimeError(f"Authorization: Bearer {secret}")
            return "A planning result."
        with self.assertRaises(H.Harness2RefinementError) as caught:
            H.refine("Make a report", broken, self.root, self.progress.append)
        self.assertNotIn(secret, str(caught.exception))
        self.assertEqual(stages, ["base1", "inv1.a1"])
        for path in self.root.rglob("*"):
            if path.is_file():
                self.assertNotIn(secret, path.read_text(encoding="utf-8"))

    def test_rejects_markdown_json_and_oversized_edits(self):
        for response in (
            '```json\n{"files":{"systemprompt.md":"ok"},"notes":""}\n```',
            json.dumps({"files": {"systemprompt.md": "x" * 50000}, "notes": ""}),
        ):
            with self.subTest(response=response[:20]), tempfile.TemporaryDirectory() as temp:
                def bad(messages):
                    return response if "SODUWORK_HARNESS2_EDIT" in messages[0]["content"] else "Plan."
                with self.assertRaises(H.Harness2RefinementError):
                    H.refine("Report", bad, Path(temp) / "turn", lambda _: None)

    def test_existing_turn_is_not_reused_and_progress_cancellation_stops_calls(self):
        self.root.mkdir()
        (self.root / "previous.txt").write_text("retained", encoding="utf-8")
        with self.assertRaises(H.Harness2RefinementError):
            H.refine("Report", self.complete, self.root, self.progress.append)
        self.assertEqual(self.calls, [])
        self.assertEqual((self.root / "previous.txt").read_text(encoding="utf-8"), "retained")
        with tempfile.TemporaryDirectory() as temp:
            def cancel(_message):
                raise RuntimeError("cancelled")
            with self.assertRaises(H.Harness2RefinementError):
                H.refine("Report", self.complete, Path(temp) / "turn", cancel)
        self.assertEqual(self.calls, [])

    def test_vendor_normalizes_windows_tree_keys(self):
        from app.services.harness2_vendor.core import tree
        surface = H.text_surface()
        sample = {"systemprompt.md": "Inspect inputs.",
                  "tool_descriptions/tool_guidance.md": "Inspect supplied evidence."}
        tree.write_tree(surface, sample, self.root, stubs=False)
        actual = tree.read_tree(surface, self.root)
        self.assertIn("tool_descriptions/tool_guidance.md", actual)
        self.assertTrue(all("\\" not in name for name in actual))
        self.assertEqual(tree.validate(surface, actual)["n_files"], 4)

    def test_import_does_not_load_cwd_env_or_require_external_packages(self):
        marker = "SODUWORK_HARNESS2_IMPORT_SENTINEL"
        self.root.mkdir()
        (self.root / ".env").write_text(f"{marker}=must-not-load\n", encoding="utf-8")
        env = dict(os.environ)
        env.pop(marker, None)
        env["PYTHONPATH"] = str(Path(__file__).resolve().parent)
        script = (
            "import os; from app.services import harness2_engine; "
            f"assert {marker!r} not in os.environ; print('isolated import ok')"
        )
        result = subprocess.run(
            [sys.executable, "-S", "-c", script], cwd=self.root, env=env,
            capture_output=True, text=True, timeout=20, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "isolated import ok")

    def test_ordinary_json_fields_work_without_disabling_default_benchmark_guard(self):
        from app.services.harness2_vendor.core import context
        fields = 'Return a JSON report with "pass_rate" and "passed_count".'

        def ordinary_task(messages):
            answer = self.complete(messages)
            if "SODUWORK_HARNESS2_EDIT" in messages[0]["content"]:
                payload = json.loads(answer)
                payload["files"]["systemprompt.md"] += " " + fields
                return json.dumps(payload)
            return answer + " " + fields

        result = H.refine(fields, ordinary_task, self.root, self.progress.append)
        self.assertIn('"pass_rate"', result)
        self.assertIn('"passed_count"', result)
        self.assertEqual(len(self.calls), 7)
        with self.assertRaises(ValueError):
            context.assert_tree_has_no_grader_verdicts({"systemprompt.md": fields})
        with self.assertRaises(ValueError):
            context.assert_no_grader_verdicts(self.root)


if __name__ == "__main__":
    unittest.main()
