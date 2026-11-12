"""Offline contract tests for the bundled Harness² process boundary."""
from __future__ import annotations

import contextlib
import importlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch


class Harness2BridgeTests(unittest.TestCase):
    def bridge(self):
        spec = importlib.util.find_spec("app.services.harness2_bridge")
        self.assertIsNotNone(spec, "The bundled Harness² process bridge must exist")
        return importlib.import_module("app.services.harness2_bridge")

    @contextlib.contextmanager
    def endpoint(self, response, *, status=200):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append((self.path, self.headers.get("Authorization"),
                                 json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                encoded = json.dumps(response).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield {"base": f"http://127.0.0.1:{server.server_port}/v1",
                   "key": "private-test-key", "model": "fixture"}, requests
        finally:
            server.shutdown()
            server.server_close()
            worker.join(2)

    def test_completion_uses_managed_model_without_tools(self):
        bridge = self.bridge()
        with self.endpoint({"choices": [{"message": {"content": "draft"}, "finish_reason": "stop"}],
                            "usage": {"prompt_tokens": 12, "completion_tokens": 4}}) as (model, requests):
            usage = []
            answer = bridge.complete(model, [{"role": "user", "content": "Hello"}], usage.append)
        self.assertEqual(answer, "draft")
        self.assertEqual(requests[0][0], "/v1/chat/completions")
        self.assertEqual(requests[0][1], "Bearer private-test-key")
        self.assertEqual(requests[0][2]["model"], "fixture")
        self.assertNotIn("tools", requests[0][2])
        self.assertEqual(usage, [{"input_tokens": 12, "output_tokens": 4}])

    def test_completion_rejects_truncation_and_redacts_server_errors(self):
        bridge = self.bridge()
        with self.endpoint({"choices": [{"message": {"content": "partial"}, "finish_reason": "length"}]}) as (model, _):
            with self.assertRaisesRegex(bridge.Harness2Error, "截断"):
                bridge.complete(model, [{"role": "user", "content": "Hello"}])
        with self.endpoint({"error": {"message": "private-test-key confidential server details"}},
                           status=401) as (model, _):
            with self.assertRaises(bridge.Harness2Error) as caught:
                bridge.complete(model, [{"role": "user", "content": "Hello"}])
        self.assertNotIn("private-test-key", str(caught.exception))
        self.assertNotIn("confidential", str(caught.exception))
        self.assertIn("401", str(caught.exception))

    def test_planning_honors_declared_reasoning_protocol_without_model_name_guesses(self):
        bridge = self.bridge()
        response = {"choices": [{"message": {"content": "plan"}, "finish_reason": "stop"}]}
        contracts = (
            ({"reasoning": True, "thinkingFormat": "zai", "supportsReasoningEffort": True,
              "thinkingLevelMap": {"off": None, "low": "low"}}, "max_tokens", "low"),
            ({"reasoning": True, "thinkingFormat": "openai", "supportsReasoningEffort": True,
              "thinkingLevelMap": {"low": "medium"}}, "max_completion_tokens", "medium"),
            ({"reasoning": True, "thinkingFormat": "zai", "supportsReasoningEffort": False,
              "thinkingLevelMap": {"low": "low"}}, "max_tokens", None),
            ({"reasoning": True, "thinkingFormat": "zai", "supportsReasoningEffort": True,
              "thinkingLevelMap": {"low": None}}, "max_tokens", None),
            ({"reasoning": True, "thinkingFormat": "unknown", "supportsReasoningEffort": True,
              "thinkingLevelMap": {"low": "low"}}, "max_tokens", None),
            ({}, "max_tokens", None),
        )
        for contract, key, effort in contracts:
            with self.subTest(contract=contract), self.endpoint(response) as (model, requests):
                bridge.complete({**model, **contract, "maxOutputTokens": 8192},
                                [{"role": "user", "content": "Task"}])
                body = requests[0][2]
                self.assertEqual(body["model"], "fixture")
                self.assertEqual(body[key], 8192)
                self.assertNotIn("max_tokens" if key == "max_completion_tokens" else "max_completion_tokens", body)
                self.assertEqual(body.get("reasoning_effort"), effort)
                self.assertNotIn("thinking", body)
                self.assertNotIn("tools", body)

    def test_model_output_limits_and_anthropic_cached_usage_are_preserved(self):
        bridge = self.bridge()
        response = {"content": [{"type": "text", "text": "plan"}], "stop_reason": "end_turn",
                    "usage": {"input_tokens": 10, "output_tokens": 4,
                              "cache_read_input_tokens": 20, "cache_creation_input_tokens": 5}}
        with self.endpoint(response) as (model, requests):
            usage = []
            bridge.complete({**model, "kind": "anthropic", "maxOutputTokens": 2048},
                            [{"role": "system", "content": "Rules"}, {"role": "user", "content": "Task"}],
                            usage.append)
        self.assertEqual(requests[0][2]["max_tokens"], 2048)
        self.assertEqual(usage[0]["input_tokens"], 35)
        self.assertEqual(usage[0]["cacheRead"], 20)
        self.assertEqual(usage[0]["cacheWrite"], 5)
        self.assertTrue(usage[0]["inputIncludesCache"])
        with self.endpoint({"choices": [{"message": {"content": "plan"}, "finish_reason": "stop"}]}) as (model, requests):
            bridge.complete({**model, "maxOutputTokens": 1024}, [{"role": "user", "content": "Task"}])
        self.assertEqual(requests[0][2]["max_tokens"], 1024)

    def test_empty_native_prompt_result_cannot_report_completion(self):
        bridge = self.bridge()
        from app.services import acp_bridge
        with tempfile.TemporaryDirectory() as directory:
            with (patch.dict(os.environ, {"SODUWORK_APPROVAL_CHANNEL": ""}),
                  patch.object(acp_bridge.AcpBridge, "start"),
                  patch.object(acp_bridge.AcpBridge, "close"),
                  patch.object(acp_bridge.AcpBridge, "request", side_effect=[
                      {"protocolVersion": 1}, {"sessionId": "native"}, {}, {}])):
                with self.assertRaisesRegex(bridge.Harness2Error, "完成"):
                    bridge.execute("Task", directory, "", "work", False, sys.executable,
                                   output=lambda _event: None)

    def test_native_failure_keeps_stage_and_safe_cause_even_if_cleanup_fails(self):
        bridge = self.bridge()
        from app.services import acp_bridge
        with tempfile.TemporaryDirectory() as directory:
            with (patch.dict(os.environ, {"SODUWORK_APPROVAL_CHANNEL": ""}),
                  patch.object(acp_bridge.AcpBridge, "start"),
                  patch.object(acp_bridge.AcpBridge, "request", side_effect=[
                      {"protocolVersion": 1}, {"sessionId": "native"},
                      acp_bridge.BridgeError("HTTP 401: private-key confidential-body")]),
                  patch.object(acp_bridge.AcpBridge, "close",
                               side_effect=acp_bridge.BridgeError("cleanup private-key"))):
                with self.assertRaises(bridge.Harness2Error) as raised:
                    bridge.execute("Task", directory, "", "work", False, sys.executable,
                                   output=lambda _event: None)
        self.assertIn("401", str(raised.exception))
        self.assertIn("调用模型", str(raised.exception))
        self.assertNotIn("private-key", str(raised.exception))
        self.assertNotIn("confidential-body", str(raised.exception))
        self.assertNotIn("cleanup", str(raised.exception))

    def test_successful_answer_with_failed_cleanup_is_not_success(self):
        bridge = self.bridge()
        from app.services import acp_bridge
        with tempfile.TemporaryDirectory() as directory:
            with (patch.dict(os.environ, {"SODUWORK_APPROVAL_CHANNEL": ""}),
                  patch.object(acp_bridge.AcpBridge, "run", return_value=0),
                  patch.object(acp_bridge.AcpBridge, "close",
                               side_effect=acp_bridge.BridgeError("ACP cleanup failed: private-key"))):
                with self.assertRaises(bridge.Harness2Error) as raised:
                    bridge.execute("Task", directory, "", "work", False, sys.executable,
                                   output=lambda _event: None)
        self.assertIn("清理", str(raised.exception))
        self.assertNotIn("private-key", str(raised.exception))

    def test_executor_config_ignores_personal_global_config_without_moving_sessions(self):
        from app.services import harness2_runtime as runtime, local_base
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            personal = root / 'personal.json'
            original = b'private user configuration'
            personal.write_bytes(original)
            injected = {'SODUWORK_DATA_ROOT': str(root / 'untrusted'),
                        'XDG_CONFIG_HOME': str(root / 'personal'),
                        'XDG_DATA_HOME': str(root / 'existing'),
                        'OPENCODE_CONFIG': str(personal), 'OPENCODE_DB': 'private.db',
                        'OPENCODE_CONFIG_CONTENT': '{"model":"private"}',
                        runtime.EXECUTOR_ENV: 'forbidden-opencode'}
            cfg = {'llm': {'base': 'http://127.0.0.1/v1', 'key': 'fixture', 'model': 'fixture'}}
            with (patch.object(local_base, '_env_for', side_effect=AssertionError('No executor delegation')),
                  patch.object(local_base, '_opencode_bin', side_effect=AssertionError('No OpenCode discovery')),
                  patch.object(local_base, '_data_root', return_value=str(root / 'runner'))):
                result = runtime.environment(injected, cfg)
            self.assertEqual(result['SODUWORK_DATA_ROOT'], str(root / 'runner'))
            self.assertEqual(result['XDG_CONFIG_HOME'], injected['XDG_CONFIG_HOME'])
            self.assertEqual(result['XDG_DATA_HOME'], injected['XDG_DATA_HOME'])
            self.assertFalse(any(key.startswith('OPENCODE_') for key in result))
            self.assertNotIn(runtime.EXECUTOR_ENV, result)
            self.assertEqual(json.loads(result[runtime.MODEL_ENV]), cfg['llm'])
            self.assertEqual(personal.read_bytes(), original)

    def test_bridge_prepares_executor_config_even_for_an_already_running_parent(self):
        bridge = self.bridge()
        from app.services import harness2_runtime as runtime, local_base
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            captured = {}
            def execute(*_args, **_kwargs):
                captured.update(os.environ)
                return 0
            with (patch.dict(os.environ, {
                    runtime.MODEL_ENV: '{"key":"fixture"}',
                    runtime.EXECUTOR_ENV: sys.executable,
                    runtime.ROOT_ENV: str(root / "evidence"),
                    "XDG_CONFIG_HOME": str(root / "personal"),
                    "SODUWORK_DATA_ROOT": str(root / "runner"),
                  }),
                  patch.object(local_base, "_data_root", return_value=str(root / "runner")),
                  patch.object(sys, "stdin", io.StringIO("minimal probe")),
                  patch("app.services.harness2_engine.refine", return_value="Verified fixture instructions."),
                  patch.object(bridge, "execute", side_effect=execute)):
                code = bridge.main(["--cwd", str(root), "--probe"])
            self.assertEqual(code, 0)
            self.assertEqual(captured["XDG_CONFIG_HOME"], str(root / "personal"))
            self.assertNotIn("OPENCODE_CONFIG_CONTENT", captured)
            self.assertNotIn(runtime.EXECUTOR_ENV, captured)

    def test_scratch_directory_is_bound_to_runner_session(self):
        bridge = self.bridge()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = bridge.new_work_dir(root / "session-a")
            second = bridge.new_work_dir(root / "session-a")
            other = bridge.new_work_dir(root / "session-b")
            self.assertNotEqual(first, second)
            self.assertEqual(first.parent, second.parent)
            self.assertNotEqual(first.parent, other.parent)

    def test_protocol_keeps_native_session_identity_and_rejects_errors(self):
        bridge = self.bridge()
        captured = []
        events = bridge.ExecutionEvents(captured.append)
        events.consume(json.dumps({"type": "session", "sessionID": "native-session"}))
        events.consume(json.dumps({"type": "text", "sessionID": "native-session",
                                   "part": {"text": "done", "done": True}}))
        self.assertEqual(events.child_session, "native-session")
        self.assertEqual(captured[0]["sessionID"], "native-session")
        self.assertFalse(events.succeeded(0), "Text alone must not prove a completed run")
        events.mark_completed()
        self.assertTrue(events.succeeded(0))
        self.assertFalse(events.succeeded(2))
        events.consume(json.dumps({"error": {"message": "execution failed"}}))
        self.assertFalse(events.succeeded(0))

    def test_version_probe_runs_the_component_not_its_python_interpreter(self):
        from app.services import harness2_runtime as runtime
        profile = runtime.profile()
        self.assertIn("argv_prefix", profile)
        result = subprocess.run([profile["bin"](), *profile["argv_prefix"](), "--version"],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), runtime.version())
        with patch.object(sys, "frozen", True, create=True):
            self.assertEqual(profile["argv_prefix"](), ["--harness2-bridge"])

    def test_permission_recovery_skips_refinement_only_for_trusted_transition(self):
        from app.services import harness2_runtime as runtime, local_base
        policy = {"policyHash": "new-policy", "mode": "readonly"}
        cfg = {"llm": {"base": "http://127.0.0.1/v1", "key": "fixture", "model": "fixture"},
               "accessPolicy": policy}
        key = "harness2-test-permission-restart"
        with tempfile.TemporaryDirectory() as root:
            with (patch.dict(local_base._RUNS, {key: {"_accessTransition": {
                    "phase": "applying", "targetPolicy": policy}}}),
                  patch.object(local_base, "_env_for", return_value={"SODUWORK_HARNESS2_CONTINUE": "inherited"}),
                  patch.object(local_base, "_store_dir", return_value=root),
                  patch.object(local_base, "_opencode_bin", return_value=sys.executable)):
                env = runtime.environment({}, cfg, key)
                self.assertEqual(env.get("SODUWORK_HARNESS2_CONTINUE"), "1")
                local_base._RUNS[key]["_accessTransition"]["phase"] = "waiting"
                self.assertNotIn("SODUWORK_HARNESS2_CONTINUE", runtime.environment({}, cfg, key))
                local_base._RUNS[key]["_accessTransition"]["phase"] = "applying"
                mismatch = {**cfg, "accessPolicy": {"policyHash": "different"}}
                self.assertNotIn("SODUWORK_HARNESS2_CONTINUE", runtime.environment({}, mismatch, key))

    def test_full_process_refines_then_executes_once_and_resumes_native_session(self):
        from tests.test_harness2_native_executor import NativeExecutorTests
        from app.services import harness2_runtime as runtime
        helper = NativeExecutorTests()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'delivered.txt'
            def respond(body):
                if not body.get('tools'):
                    system = body['messages'][0]['content']
                    text = (json.dumps({'files': {'systemprompt.md': 'Verify fixture result precisely.'},
                                        'notes': 'Check real results.'})
                            if 'SODUWORK_HARNESS2_EDIT' in system else 'Inspect the request, produce the output, and verify it.\n' * 20)
                    value = helper.response(text)
                    value['usage'] = {'prompt_tokens': sum(len(row['content'].encode('utf-8'))
                        for row in body['messages']) // 3, 'completion_tokens': 637}
                    return value
                last_user = max(i for i, m in enumerate(body['messages']) if m['role'] == 'user')
                results = [m for m in body['messages'][last_user:] if m['role'] == 'tool']
                writable = any(t['function']['name'] == 'write_file' for t in body['tools'])
                if writable and not results:
                    return helper.response(calls=[helper.call('write_file', {
                        'path': str(target), 'content': 'actual native write'}, 'write-' + str(last_user))])
                return helper.response('Verified native result')
            with helper.endpoint(respond) as (model, requests):
                model.update(reasoning=True, thinkingFormat='zai', supportsReasoningEffort=True,
                             thinkingLevelMap={'low': 'low', 'high': 'max'})
                env = {k: v for k, v in os.environ.items() if k != 'SODUWORK_APPROVAL_CHANNEL'}
                env.update({runtime.MODEL_ENV: json.dumps(model), runtime.ROOT_ENV: str(root / 'private'),
                            runtime.EXECUTOR_ENV: 'must-never-be-started.exe', 'PYTHONUTF8': '1'})
                command = [sys.executable, str(Path(runtime.__file__).with_name('harness2_bridge.py')), '--cwd', directory]
                prompt = ('Only operate in the fixture workspace.\n'
                          + '保留用户约束、会话权限与完整原文。Verify the evidence.\n' * 500
                          + 'Create the requested fixture result.\nKeep this final constraint intact.')
                self.assertGreater(len(prompt.encode('utf-8')), 33000)
                sid = ''
                for turn in range(3):
                    readonly = turn == 2
                    args = command + (['--mode', 'plan', '--probe', '--refine'] if readonly else
                                      ['--session', sid] if sid else [])
                    before = len(requests)
                    child = subprocess.run(args, input=prompt, env=env, text=True, encoding='utf-8',
                                           capture_output=True, timeout=30)
                    self.assertEqual(child.returncode, 0, child.stdout + child.stderr)
                    events = [json.loads(line) for line in child.stdout.splitlines()]
                    current = next(e['sessionID'] for e in events if e.get('sessionID'))
                    if turn == 1:
                        self.assertEqual(current, sid)
                    sid = current
                    batch = requests[before:]
                    planning = [r for r in batch if not r.get('tools')]
                    self.assertEqual(len(planning), 7)
                    self.assertGreater(max(len(json.dumps(row['messages'], ensure_ascii=False).encode('utf-8'))
                                           for row in planning), 48000)
                    self.assertTrue(all(row['max_tokens'] == (8192 if 'SODUWORK_HARNESS2_EDIT' in row['messages'][0]['content'] else 4096)
                                        and row['reasoning_effort'] == 'low' and row['stream'] is True
                                        and row['model'] == 'fixture' for row in planning))
                    self.assertEqual(len([r for r in batch if r.get('tools')]), 1 if readonly else 2)
                    native = next(r for r in batch if r.get('tools'))
                    text = next(m for m in reversed(native['messages']) if m['role'] == 'user')['content'][0]['text']
                    self.assertTrue(text.endswith(prompt))
                    self.assertIn('Verify fixture result precisely.', text)
                    usage = [e for e in events if e.get('type') == 'step_finish' and e.get('part', {}).get('tokens')]
                    self.assertEqual(len(usage), len(batch))
                    self.assertGreater(sum(row['part']['tokens'].get('input_tokens', 0)
                                           + row['part']['tokens'].get('output_tokens', 0) for row in usage), 12000)
                    self.assertNotIn(model['key'], child.stdout + child.stderr)
                    self.assertEqual(target.read_text(), 'actual native write')
                for path in (root / 'private').rglob('*'):
                    if path.is_file():
                        self.assertNotIn(model['key'], path.read_text(encoding='utf-8'))


if __name__ == "__main__":
    unittest.main()
