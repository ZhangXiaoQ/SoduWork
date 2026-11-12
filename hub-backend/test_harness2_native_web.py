"""Native Harness² web tools, streaming and permissions without an external agent."""
from __future__ import annotations

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

from app.services import harness2_bridge, harness2_runtime, local_base


class _WebFixture:
    def __init__(self):
        self.phase = "fetch"
        self.calls = []
        self.gets = []
        self.dependency_requests = 0
        self.grants = []
        self.applied = []
        self.bad_requests = []
        self.phase_calls = 0
        self.weather_in_history = False
        self.reply_in_history = False
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path.startswith("/npm/"):
                    # Exercise a cold, unavailable optional SDK dependency without
                    # reaching npm or borrowing the user's package cache.
                    fixture.dependency_requests += 1
                    self.reply(404, b'{"error":"Fixture registry has no packages"}')
                    return
                fixture.gets.append(self.path)
                if self.path != "/weather":
                    self.reply(404, b"Unknown fixture")
                    return
                self.reply(200, b"WEATHER-FIXTURE: Beijing Chaoyang, 21 C, clear.",
                           "text/plain; charset=utf-8")

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.path == "/v1/chat/completions":
                    fixture.model(self, body)
                    return
                if self.headers.get("Authorization") != "Bearer fixture-approval":
                    fixture.bad_requests.append("approval authorization")
                    self.reply(403, b"{}")
                    return
                if self.path == "/control":
                    self.reply(200, b'{"requested":false}')
                elif self.path == "/applied":
                    fixture.applied.append(body.get("mode"))
                    self.reply(200, b'{"ok":true}')
                elif self.path == "/request":
                    arguments = body.get("arguments") or {}
                    approved = (
                        fixture.phase == "fetch" and not fixture.grants
                        and body.get("action") == "native.tool"
                        and body.get("kind") == "fetch"
                        and body.get("target") == fixture.weather_url
                        and arguments.get("url") == fixture.weather_url
                        and set(arguments) <= {"url", "format", "timeout"}
                    )
                    fixture.grants.append({"approved": approved,
                                           "kind": body.get("kind"),
                                           "argument_keys": sorted(arguments)})
                    self.reply(200, json.dumps({
                        "decision": "once" if approved else "deny",
                    }).encode())
                else:
                    fixture.bad_requests.append("unknown route")
                    self.reply(404, b"{}")

            def reply(self, code, payload, content_type="application/json"):
                self.send_response(code)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.weather_url = self.url + "/weather"

    def start(self):
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def next_phase(self, phase):
        self.phase = phase
        self.phase_calls = 0

    def model(self, handler, body):
        auxiliary = not body.get("tools")
        if not auxiliary:
            self.phase_calls += 1
        names = {row.get("function", {}).get("name") for row in body.get("tools", [])}
        messages = body.get("messages") or []
        system = "\n".join(str(row.get("content") or "") for row in messages
                           if row.get("role") in {"system", "developer"})
        tool_results = [row for row in messages if row.get("role") == "tool"]
        self.calls.append({"phase": self.phase, "model": body.get("model"),
                           "stream": body.get("stream"), "webfetch": "webfetch" in names,
                           "auxiliary": auxiliary,
                           "harness_identity": "You are the Google Harness² assistant" in system,
                           "executor_identity": "you are opencode" in system.lower()})
        if body.get("stream") is not True or self.phase_calls > 2:
            self.bad_requests.append("unexpected inference")
            handler.reply(400, b'{"error":{"message":"Unexpected fixture request"}}')
            return
        if auxiliary:
            # OpenCode may create its native session title before the tool loop.
            # Record that real inference separately from the two tool-loop calls.
            delta = {"role": "assistant", "content": "Fixture weather"}
            reason = "stop"
        elif self.phase == "resume":
            self.reply_in_history = any(
                "WEATHER-VERIFIED" in str(row.get("content") or "")
                for row in messages if row.get("role") == "assistant")
            delta = {"role": "assistant", "content": "RESUME-VERIFIED"}
            reason = "stop"
        elif self.phase_calls == 1 and (self.phase == "fetch" or "webfetch" in names):
            delta = {"role": "assistant", "tool_calls": [{
                "index": 0, "id": "weather-call-" + self.phase, "type": "function",
                "function": {"name": "webfetch", "arguments": json.dumps({
                    "url": self.weather_url, "format": "text", "timeout": 5,
                })},
            }]}
            reason = "tool_calls"
        else:
            if self.phase == "fetch":
                self.weather_in_history = any(
                    "WEATHER-FIXTURE" in str(row.get("content") or "") for row in tool_results)
            delta = {"role": "assistant", "content": (
                "WEATHER-VERIFIED" if self.phase == "fetch" else "READONLY-BLOCKED")}
            reason = "stop"
        chunks = [
            {"id": "fixture", "object": "chat.completion.chunk", "created": 1,
             "model": "fixture", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
            {"id": "fixture", "object": "chat.completion.chunk", "created": 1,
             "model": "fixture", "choices": [{"index": 0, "delta": {}, "finish_reason": reason}],
             "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}},
        ]
        payload = ("".join("data: " + json.dumps(row) + "\n\n" for row in chunks)
                   + "data: [DONE]\n\n").encode()
        handler.reply(200, payload, "text/event-stream")


class Harness2NativeWebTests(unittest.TestCase):
    def test_native_webfetch_resume_and_readonly_without_refinement(self):
        executable = Path("must-not-launch-opencode.exe")
        fixture = _WebFixture()
        self.fixture = fixture
        fixture.start()
        self.addCleanup(fixture.close)
        with tempfile.TemporaryDirectory(prefix="soduwork-harness2-native-web-") as directory:
            root = Path(directory)
            work = root / "中文 workspace"
            work.mkdir()
            sentinel = work / "unchanged.txt"
            sentinel.write_bytes(b"Unchanged fixture file.")
            original = {path.relative_to(work): path.read_bytes() for path in work.rglob("*")
                        if path.is_file()}
            env, permission = self.environment(root, work, fixture, executable, "standard")
            self.assertEqual(permission["mode"], "standard")
            self.assertFalse(any(key.startswith("OPENCODE_") for key in env))
            first = self.run_turn(work, env,
                                  f"Fetch {fixture.weather_url} using webfetch and report the weather.")
            sid = self.session(first)
            self.assertTrue(sid.startswith("h2_"))
            self.assert_stream(first, "WEATHER-VERIFIED")
            self.assertEqual(fixture.gets, ["/weather"], {
                "grants": fixture.grants,
                "calls": fixture.calls,
                "applied": fixture.applied,
                "types": [row.get("type") for row in first],
                "tools": [row for row in first if row.get("type") == "tool_execution_end"],
            })
            self.assertTrue(fixture.weather_in_history)
            self.assertEqual(len(fixture.grants), 1, fixture.grants)
            self.assertTrue(fixture.grants[0]["approved"], fixture.grants)
            self.assertTrue(any(row.get("type") == "tool_execution_end"
                                and not row.get("isError") for row in first))
            self.assertEqual(len([row for row in fixture.calls if not row["auxiliary"]]), 2)

            fixture.next_phase("resume")
            resumed = self.run_turn(work, env, "Confirm the previous answer without calling tools.", sid)
            self.assertEqual(self.session(resumed), sid)
            self.assert_stream(resumed, "RESUME-VERIFIED")
            self.assertTrue(fixture.reply_in_history)
            self.assertEqual(fixture.gets, ["/weather"])

            fixture.next_phase("readonly")
            readonly, permission = self.environment(root, work, fixture, executable, "readonly")
            self.assertEqual(permission["mode"], "readonly")
            denied = self.run_turn(work, readonly,
                                   f"Fetch {fixture.weather_url} if webfetch is permitted.", sid)
            self.assertEqual(self.session(denied), sid)
            self.assert_stream(denied, "READONLY-BLOCKED")
            self.assertEqual(fixture.gets, ["/weather"], "Readonly must not fetch again")
            readonly_calls = [row for row in fixture.calls if row["phase"] == "readonly"]
            self.assertTrue(readonly_calls)
            if readonly_calls[0]["webfetch"]:
                self.assertTrue(any(row.get("type") == "tool_execution_end"
                                    and row.get("isError") for row in denied))
            self.assertEqual(fixture.applied, ["standard", "standard", "readonly"])
            self.assertTrue(all(row["stream"] and row["model"] == "fixture" for row in fixture.calls))
            execution_calls = [row for row in fixture.calls if not row["auxiliary"]]
            self.assertTrue(all(row["harness_identity"] for row in execution_calls), fixture.calls)
            self.assertFalse(any(row["executor_identity"] for row in execution_calls), fixture.calls)
            self.assertFalse(fixture.bad_requests, fixture.bad_requests)
            self.assertEqual(fixture.dependency_requests, 0)
            self.assertEqual(list((root / "refinement").glob("turn-*")), [])
            self.assertTrue((root / "refinement/sessions").is_dir())
            self.assertEqual(
                {path.relative_to(work): path.read_bytes() for path in work.rglob("*")
                 if path.is_file()}, original)

    def environment(self, root, work, fixture, executable, mode):
        allowed = {"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC",
                   "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"}
        clean = {key: value for key, value in os.environ.items() if key.upper() in allowed}
        for key in ("XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TEMP", "TMP"):
            target = root / key
            target.mkdir(exist_ok=True)
            clean[key] = str(target)
        clean.update({
            "SODUWORK_DATA_ROOT": str(root / "runner"),
            "OPENCODE_DB": str(root / "native.db"),
            "OPENCODE_DISABLE_AUTOUPDATE": "1",
            "OPENCODE_DISABLE_MODELS_FETCH": "1",
            "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
            "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1",
        })
        npmrc = root / "empty.npmrc"
        npmrc.write_text("", encoding="utf-8")
        clean.update({
            "NPM_CONFIG_USERCONFIG": str(npmrc),
            "NPM_CONFIG_GLOBALCONFIG": str(root / "empty-global.npmrc"),
            "NPM_CONFIG_CACHE": str(root / "npm-cache"),
            "NPM_CONFIG_REGISTRY": fixture.url + "/npm/",
            "NPM_CONFIG_FETCH_RETRIES": "0",
            "NPM_CONFIG_FETCH_TIMEOUT": "1000",
        })
        policy = {"mode": mode, "workspaceRoot": str(work), "policyHash": "fixture-" + mode}
        cfg = {"llm": {"base": fixture.url + "/v1", "key": "fixture-key",
                       "model": "fixture", "kind": "openai-compat"},
               "accessPolicy": policy, "workRoot": str(work)}
        with (patch.dict(os.environ, clean, clear=True),
              patch.object(local_base, "_opencode_bin", side_effect=AssertionError("Unexpected OpenCode lookup"))):
            env = harness2_runtime.environment(clean, cfg)
        permission = policy
        env.update({
            harness2_runtime.ROOT_ENV: str(root / "refinement"),
            "SODUWORK_APPROVAL_CHANNEL": json.dumps({
                "url": fixture.url, "token": "fixture-approval", "policy": policy,
            }),
            "HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9",
            "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost",
        })
        return env, permission

    def run_turn(self, work, env, prompt, session=""):
        command = [sys.executable, str(Path(harness2_bridge.__file__)),
                   "--cwd", str(work), "--session", session, "--probe"]
        flags = ({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt"
                 else {"start_new_session": True})
        process = subprocess.Popen(command, env=env, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, encoding="utf-8", errors="replace", **flags)
        try:
            stdout, stderr = process.communicate(prompt, timeout=45)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)],
                               capture_output=True, timeout=10,
                               creationflags=subprocess.CREATE_NO_WINDOW)
            else:
                from app.services.local_stream import _kill_pid_tree
                _kill_pid_tree(process.pid, process)
            stdout, stderr = process.communicate(timeout=5)
            types = []
            for line in stdout.splitlines():
                try:
                    types.append(json.loads(line).get("type", "error"))
                except ValueError:
                    types.append("unparsed")
            self.fail("The local native web fixture timed out: " + repr({
                "events": types, "calls": self.fixture.calls, "gets": self.fixture.gets,
                "grants": self.fixture.grants, "applied": self.fixture.applied,
                "bad_requests": self.fixture.bad_requests, "stderr_bytes": len(stderr),
            }))
        self.assertEqual(process.returncode, 0, stdout + stderr)
        self.assertNotIn("fixture-key", stdout + stderr)
        self.assertNotIn("fixture-approval", stdout + stderr)
        self.assertNotIn("Harness²：", stdout)
        events = [json.loads(line) for line in stdout.splitlines() if line.strip()]
        self.assertFalse(any(row.get("error") for row in events))
        self.assertIn({"type": "harness2_probe_complete", "coverage": "native-execute-v1", "stages": 0}, events)
        return events

    @staticmethod
    def session(events):
        return next((row.get("sessionID") for row in events if row.get("type") == "session"), "")

    def assert_stream(self, events, expected):
        self.assertTrue(any(row.get("type") == "text"
                            and row.get("part", {}).get("delta") == expected
                            and row.get("part", {}).get("done") is False for row in events), events)


if __name__ == "__main__":
    unittest.main()
