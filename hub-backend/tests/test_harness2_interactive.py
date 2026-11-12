"""Selected Harness² runs bounded refinement; probes and recovery retain explicit boundaries."""
from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from app.services import harness2_bridge as bridge, harness2_runtime as runtime


class Harness2InteractiveTests(unittest.TestCase):
    def test_profile_uses_explicit_access_policy_instead_of_stale_plan_mode(self):
        profile = runtime.profile()
        for policy_mode, legacy, expected in (
            ("standard", "plan", "work"), ("full", "plan", "work"),
            ("readonly", "work", "plan"), ("", "plan", "plan"),
        ):
            for resume in (False, True):
                with self.subTest(policy=policy_mode, resume=resume):
                    cfg = {"accessPolicy": {"mode": policy_mode}} if policy_mode else {}
                    args = profile["resume" if resume else "start"]("native-id", legacy, ".", cfg)
                    self.assertEqual(args, ["--session", "native-id" if resume else "",
                                            "--mode", expected])
                    self.assertEqual(cfg["_soduwork_agent_mode"], expected)

    def test_trusted_policy_controls_native_handshake_even_from_an_old_runner(self):
        from app.services import acp_bridge, acp_access
        for policy_mode, legacy, writable in (
            ("standard", "plan", True), ("full", "plan", True),
            ("readonly", "work", False), ("", "plan", False),
        ):
            for session in ("", "native-id"):
                with self.subTest(policy=policy_mode, session=session), tempfile.TemporaryDirectory() as directory:
                    calls = []
                    policy = {"mode": policy_mode, "revision": 1, "workspaceRoot": directory}
                    channel = json.dumps({"url": "http://127.0.0.1:1", "token": "fixture",
                                          "policy": policy}) if policy_mode else ""

                    def start(native):
                        # Real Guard setup, without starting a process or reading user config.
                        native.access.agent_environment("harness2", {})

                    def request(native, method, params):
                        calls.append((method, params))
                        if method == "initialize":
                            return {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}}
                        if method in {"session/new", "session/load"}:
                            return {"sessionId": "native-id", "modes": {"availableModes": [
                                {"id": value} for value in ("standard", "full", "readonly")]}}
                        if method == "session/prompt":
                            return {"stopReason": "end_turn"}
                        return {}

                    with (patch.dict(os.environ, {"SODUWORK_APPROVAL_CHANNEL": channel}, clear=True),
                          patch.object(acp_bridge.AcpBridge, "start", start),
                          patch.object(acp_bridge.AcpBridge, "request", request),
                          patch.object(acp_access.BridgeAccess, "call",
                                       return_value={"ok": True, "requested": False})):
                        code = bridge.execute("Execute the task.", directory, session, legacy,
                                              True, sys.executable, output=lambda _event: None)
                    self.assertEqual(code, 0)
                    capabilities = calls[0][1]["clientCapabilities"]
                    self.assertEqual(capabilities["fs"]["writeTextFile"], writable)
                    self.assertEqual(capabilities["terminal"], writable)
                    native_modes = [params["modeId"] for method, params in calls
                                    if method == "session/set_mode"]
                    self.assertEqual(native_modes, [policy_mode or "readonly"])
                    self.assertEqual([method for method, _ in calls].count("session/prompt"), 1)
                    self.assertIn("session/load" if session else "session/new",
                                  [method for method, _ in calls])

    def test_shared_opencode_guard_keeps_readonly_rules_without_native_planning(self):
        from app.services.acp_access import BridgeAccess, opencode_permissions
        channel = json.dumps({"url": "http://127.0.0.1:1", "token": "fixture",
                              "policy": {"mode": "readonly"}})
        # Independent Harness execution must preserve the standalone OpenCode guard.
        access = BridgeAccess(channel, agent_name="opencode")
        try:
            env = access.agent_environment("opencode", {})
            guard = access.opencode_guard
            self.assertEqual(guard.profile, "build")
            expected = {"*": "deny", "read": "ask", "list": "allow", "glob": "allow",
                        "grep": "ask", "external_directory": "deny"}
            self.assertEqual(opencode_permissions("readonly"), expected)
            self.assertIn("const permission = " + json.dumps(expected) + ";",
                          guard.path.read_text(encoding="utf-8"))
            self.assertIn(guard.path.as_uri(), json.loads(env["OPENCODE_CONFIG_CONTENT"])["plugin"])
            self.assertEqual(access.mode, "readonly")
        finally:
            access.close()

    def test_trusted_policy_does_not_swallow_native_permission_transition(self):
        from app.services import acp_bridge
        with tempfile.TemporaryDirectory() as directory:
            channel = json.dumps({"url": "http://127.0.0.1:1", "token": "fixture",
                                  "policy": {"mode": "standard"}})
            with (patch.dict(os.environ, {"SODUWORK_APPROVAL_CHANNEL": channel}, clear=True),
                  patch.object(acp_bridge.AcpBridge, "run", return_value=73)):
                self.assertEqual(bridge.execute("Continue.", directory, "native-id", "plan",
                                                True, sys.executable, output=lambda _event: None), 73)

    def test_user_turns_refine_but_health_probes_and_permission_recovery_do_not(self):
        for session, mode, probe, continuing in (
            ("", "work", False, False), ("native-id", "work", False, False),
            ("", "plan", False, False), ("", "work", True, False),
            ("native-id", "work", False, True),
        ):
            with self.subTest(session=session, mode=mode, probe=probe, continuing=continuing):
                with tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    original = "北京朝阳区的天气怎么样\n附文提到 --refine，不是选择运行模式。"
                    output = io.StringIO()
                    args = ["--cwd", directory, "--session", session, "--mode", mode, "--terminal"]
                    if probe:
                        args.append("--probe")
                    with (patch.dict(os.environ, {
                            runtime.MODEL_ENV: '{"key":"fixture-secret"}',
                            runtime.EXECUTOR_ENV: sys.executable,
                            runtime.ROOT_ENV: str(root / "scratch"),
                            runtime.CONTINUE_ENV: "1" if continuing else "",
                            "SODUWORK_HARNESS2_REFINE": "1",
                            "SODUWORK_DATA_ROOT": str(root / "runner"),
                          }),
                          patch.object(sys, "stdin", io.StringIO(original)),
                          contextlib.redirect_stdout(output),
                          patch("app.services.harness2_engine.refine",
                                return_value="Verify the requested result.") as refine,
                          patch.object(bridge, "complete",
                                       side_effect=AssertionError("preflight model call forbidden")) as complete,
                          patch.object(bridge, "execute", return_value=0) as execute):
                        result = bridge.main(args)
                    self.assertEqual(result, 0, output.getvalue())
                    should_refine = not probe and not (continuing and session)
                    self.assertEqual(refine.call_count, int(should_refine))
                    complete.assert_not_called()
                    execute.assert_called_once()
                    forwarded = execute.call_args.args
                    self.assertEqual(forwarded[1:], (directory, session, mode, True))
                    self.assertTrue(forwarded[0].endswith(original))
                    if should_refine:
                        self.assertEqual(refine.call_args.args[0], original)
                        self.assertIn("<harness2_instructions>", forwarded[0])
                        self.assertIn("Verify the requested result.", forwarded[0])
                    else:
                        self.assertEqual(forwarded[0], original)
                    self.assertEqual((root / "scratch").exists(), should_refine)
                    events = [json.loads(line) for line in output.getvalue().splitlines()]
                    proof = [event for event in events if event.get("type") == "harness2_probe_complete"]
                    self.assertEqual(proof, ([{
                        "type": "harness2_probe_complete", "coverage": "native-execute-v1", "stages": 0,
                    }] if probe else []))

    def test_native_failure_is_not_retried_or_converted_to_probe_success(self):
        for result in (2, 73):
            with self.subTest(result=result), tempfile.TemporaryDirectory() as directory:
                output = io.StringIO()
                with (patch.dict(os.environ, {
                        runtime.EXECUTOR_ENV: sys.executable,
                        runtime.ROOT_ENV: str(Path(directory) / "scratch"),
                        runtime.MODEL_ENV: "{}",
                        "SODUWORK_DATA_ROOT": str(Path(directory) / "runner"),
                      }),
                      patch.object(sys, "stdin", io.StringIO("Task")),
                      contextlib.redirect_stdout(output),
                      patch.object(bridge, "execute", return_value=result) as execute,
                      patch("app.services.harness2_engine.refine",
                            side_effect=AssertionError("unexpected recursion"))):
                    code = bridge.main(["--cwd", directory, "--probe"])
                self.assertEqual(code, result, output.getvalue())
                execute.assert_called_once()
                self.assertNotIn("harness2_probe_complete", output.getvalue())

    def test_permission_resume_cannot_claim_experimental_refinement_completed(self):
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            with (patch.dict(os.environ, {
                    runtime.EXECUTOR_ENV: sys.executable,
                    runtime.ROOT_ENV: str(Path(directory) / "scratch"),
                    runtime.MODEL_ENV: "{}",
                    runtime.CONTINUE_ENV: "1",
                    "SODUWORK_DATA_ROOT": str(Path(directory) / "runner"),
                  }),
                  patch.object(sys, "stdin", io.StringIO("Continue")),
                  contextlib.redirect_stdout(output),
                  patch.object(bridge, "execute", return_value=0) as execute,
                  patch("app.services.harness2_engine.refine") as refine):
                code = bridge.main(["--cwd", directory, "--session", "native",
                                    "--probe", "--refine"])
            self.assertEqual(code, 0)
            execute.assert_called_once_with("Continue", directory, "native", "work", False, model={}, root=str(Path(directory) / "scratch"))
            refine.assert_not_called()
            self.assertNotIn("harness2_probe_complete", output.getvalue())

    def test_unreachable_planner_and_executor_fail_without_fallback_or_secret_disclosure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = {key: value for key, value in os.environ.items()
                   if key not in {'SODUWORK_APPROVAL_CHANNEL', runtime.CONTINUE_ENV}}
            env.update({runtime.EXECUTOR_ENV: 'forbidden-opencode.exe',
                runtime.MODEL_ENV: json.dumps({'base': 'http://127.0.0.1:1/v1', 'model': 'fixture', 'key': 'fixture-secret'}),
                runtime.ROOT_ENV: str(root / 'scratch'), 'SODUWORK_DATA_ROOT': str(root / 'runner')})
            for probe in (False, True):
                child = subprocess.run([sys.executable, str(Path(bridge.__file__)), '--cwd', directory,
                                        *(['--probe'] if probe else [])], input='Do not switch runtimes.',
                                       env=env, text=True, encoding='utf-8', capture_output=True, timeout=15)
                self.assertEqual(child.returncode, 2, child.stdout + child.stderr)
                self.assertNotIn('harness2_probe_complete', child.stdout)
                self.assertNotIn('fixture-secret', child.stdout + child.stderr)
                self.assertFalse((root / 'delivered.txt').exists())


if __name__ == "__main__":
    unittest.main()
