"""Managed OpenCode config stays separate from personal config and native data."""
from __future__ import annotations

import json
import ntpath
import os
from pathlib import Path
import posixpath
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from app.services import acp_bridge, harness2_runtime, local_base, runner_sources


class OpenCodeRuntimeConfigTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="soduwork-opencode-config-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.personal = self.root / "personal" / "opencode" / "opencode.json"
        self.personal.parent.mkdir(parents=True)
        self.personal.write_bytes(b"invalid personal config: PRIVATE-FIXTURE")
        self.environment = {
            "SODUWORK_DATA_ROOT": str(self.root / "runner"),
            "XDG_CONFIG_HOME": str(self.personal.parent.parent),
            "HOME": str(self.root / "home"),
            "XDG_DATA_HOME": str(self.root / "native-data"),
            "XDG_STATE_HOME": str(self.root / "native-state"),
            "XDG_CACHE_HOME": str(self.root / "native-cache"),
            "OPENCODE_DB": str(self.root / "native.db"),
            "OPENCODE_CONFIG_CONTENT": '{"model":"company/fixture","permission":{"edit":"deny"}}',
            "SODUWORK_APPROVAL_CHANNEL": "",
            "PYTHONDONTWRITEBYTECODE": "1",
        }

    def assert_config(self, env):
        expected = self.root / "runner" / "agents" / "opencode" / "config"
        self.assertEqual(Path(env["XDG_CONFIG_HOME"]), expected)
        self.assertTrue(expected.is_dir())
        self.assertEqual(list(expected.iterdir()), [])
        for key in ("HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCODE_DB"):
            self.assertEqual(env[key], self.environment[key], key)
        self.assertEqual(self.personal.read_bytes(), b"invalid personal config: PRIVATE-FIXTURE")

    def test_parent_environment_ignores_personal_config_and_keeps_native_state(self):
        cfg = {"llm": {"base": "http://127.0.0.1/v1", "key": "fixture", "model": "fixture"},
               "runtimeSecrets": {"XDG_CONFIG_HOME": "FIXTURE_CONFIG_OVERRIDE"}}
        with patch.dict(os.environ, {**self.environment,
                                     "FIXTURE_CONFIG_OVERRIDE": str(self.personal.parent.parent)}):
            env = local_base._env_for(local_base._PROFILES["opencode"], cfg)
        self.assert_config(env)
        self.assertEqual(json.loads(env["OPENCODE_CONFIG_CONTENT"])["model"], "company/fixture")
        self.assertNotIn("agent", json.loads(env["OPENCODE_CONFIG_CONTENT"]))

    def child_environment(self, agent, *, guarded=False):
        keys = [*self.environment]
        program = ("import json,os; print(json.dumps({k:os.environ.get(k) for k in "
                   + repr(keys) + "}),flush=True)")
        env = dict(self.environment)
        if guarded:
            env["SODUWORK_APPROVAL_CHANNEL"] = json.dumps({
                "url": "http://127.0.0.1:9", "token": "fixture",
                "policy": {"mode": "readonly", "workspaceRoot": str(self.root)},
            })
        with patch.dict(os.environ, env):
            bridge = acp_bridge.AcpBridge(
                [sys.executable, "-u", "-c", program], str(self.root), agent, "workspace")
            try:
                bridge.start()
                kind, result = bridge.inbox.get(timeout=5)
                self.assertEqual(kind, "message")
                return result
            finally:
                bridge.close()

    def test_child_entry_repairs_old_parent_environment_and_keeps_guard(self):
        env = self.child_environment("opencode", guarded=True)
        self.assert_config(env)
        config = json.loads(env["OPENCODE_CONFIG_CONTENT"])
        self.assertEqual(config["model"], "company/fixture")
        self.assertTrue(config["plugin"])
        self.assertEqual(config["permission"]["edit"], "deny")
        self.assertIsNone(env["SODUWORK_APPROVAL_CHANNEL"])

    def test_other_acp_agents_keep_their_own_config_environment(self):
        from app.services import opencode_runtime_config
        for agent in ("codex", "codex-harness", "qwen", "pi", "dsh"):
            with self.subTest(agent=agent), patch.object(opencode_runtime_config, "prepare_environment") as prepare:
                env = self.child_environment(agent)
                prepare.assert_not_called()
                self.assertEqual(env["XDG_CONFIG_HOME"], self.environment["XDG_CONFIG_HOME"])
                self.assertEqual(env["OPENCODE_CONFIG_CONTENT"], self.environment["OPENCODE_CONFIG_CONTENT"])
                self.assertFalse((self.root / "runner").exists())

    def test_harness_uses_native_config_without_accepting_injected_lifecycle_root(self):
        cfg = {"llm": {"base": "http://127.0.0.1/v1", "key": "fixture", "model": "fixture"}}
        injected = {**self.environment, "SODUWORK_DATA_ROOT": str(self.root / "untrusted")}
        with (patch.dict(os.environ, self.environment),
              patch.object(local_base, "_env_for", side_effect=AssertionError("No nested agent environment")),
              patch.object(local_base, "_opencode_bin", side_effect=AssertionError("No OpenCode lookup"))):
            env = harness2_runtime.environment(injected, cfg)
        self.assertEqual(env["SODUWORK_DATA_ROOT"], self.environment["SODUWORK_DATA_ROOT"])
        self.assertEqual(json.loads(env[harness2_runtime.MODEL_ENV]), cfg["llm"])
        self.assertFalse(any(key.startswith("OPENCODE_") for key in env))
        self.assertEqual(env["XDG_CONFIG_HOME"], self.environment["XDG_CONFIG_HOME"])
        self.assertFalse((self.root / "runner" / "agents" / "opencode").exists())
        self.assertEqual(self.personal.read_bytes(), b"invalid personal config: PRIVATE-FIXTURE")

    def test_harness_identity_is_private_and_native_environment_is_idempotent(self):
        from copy import deepcopy
        config = {
            "model": "company/private-route",
            "provider": {"company": {"options": {"apiKey": "{env:SODUWORK_LLM_KEY}"}}},
            "permission": {"edit": "deny", "webfetch": "ask"},
            "plugin": ["file:///fixture/policy.mjs"],
            "agent": {"build": {"temperature": 0.2}, "review": {"prompt": "Review only."}},
        }
        original = deepcopy(config)
        env = {**self.environment, "OPENCODE_CONFIG_CONTENT": json.dumps(config)}
        with patch.object(local_base, "_data_root", return_value=str(self.root / "runner")):
            harness2_runtime.prepare_executor_config(env)
            first = dict(env)
            harness2_runtime.prepare_executor_config(env)
        self.assertEqual(env, first)
        self.assertEqual(config, original)
        self.assertFalse(any(key.startswith("OPENCODE_") for key in env))
        self.assertEqual(env["SODUWORK_DATA_ROOT"], str(self.root / "runner"))
        identity = harness2_runtime.EXECUTOR_PROMPT
        self.assertIn("Google Harness²", identity)
        self.assertIn("not a foundation-model identity", identity)
        self.assertIn("internal model", identity)
        self.assertIn("No other agent CLI executes this turn", identity)
        self.assertNotIn("private-route", identity)
        self.assertNotIn("apiKey", identity)
        self.assertEqual(self.personal.read_bytes(), b"invalid personal config: PRIVATE-FIXTURE")
        self.assertNotIn("agent", json.loads(self.environment["OPENCODE_CONFIG_CONTENT"]))

    def test_harness_native_executor_preserves_model_scope_and_private_configuration(self):
        from copy import deepcopy
        config = {"llm": {"base": "http://127.0.0.1/v1", "key": "fixture",
                          "model": "company/private-route"}, "networkAllowed": False}
        original = deepcopy(config)
        inherited = {**self.environment, harness2_runtime.EXECUTOR_ENV: "untrusted-cli"}
        with (patch.dict(os.environ, self.environment),
              patch.object(local_base, "_data_root", return_value=str(self.root / "runner")),
              patch.object(local_base, "_store_dir", return_value=str(self.root / "session"))):
            env = harness2_runtime.environment(inherited, config, runtime_ref="native-session")
            repeated = harness2_runtime.environment(env, config, runtime_ref="native-session")
        self.assertEqual(env, repeated)
        self.assertEqual(config, original)
        self.assertEqual(json.loads(env[harness2_runtime.MODEL_ENV]), config["llm"])
        self.assertEqual(env[harness2_runtime.ROOT_ENV], str(self.root / "session" / "harness2"))
        self.assertEqual(env[harness2_runtime.NETWORK_ENV], "0")
        self.assertNotIn(harness2_runtime.EXECUTOR_ENV, env)
        self.assertFalse(any(key.startswith("OPENCODE_") for key in env))
        self.assertEqual(env["XDG_CONFIG_HOME"], self.environment["XDG_CONFIG_HOME"])
        self.assertEqual(env["SODUWORK_DATA_ROOT"], str(self.root / "runner"))
        self.assertEqual(inherited[harness2_runtime.EXECUTOR_ENV], "untrusted-cli")
        self.assertEqual(self.personal.read_bytes(), b"invalid personal config: PRIVATE-FIXTURE")
        identity = harness2_runtime.EXECUTOR_PROMPT
        self.assertIn("Google Harness²", identity)
        self.assertIn("not a foundation-model identity", identity)
        self.assertIn("internal model", identity)
        self.assertIn("No other agent CLI executes this turn", identity)
        self.assertNotIn("private-route", identity)
        self.assertNotIn("apiKey", identity)
        self.assertNotIn("agent", json.loads(self.environment["OPENCODE_CONFIG_CONTENT"]))

    def test_source_bridge_redacts_opencode_invalid_config_diagnostic(self):
        diagnostic = "ConfigJsonError: EndOfFileExpected PRIVATE-FIXTURE apiKey=fixture-secret"
        peer = "import sys; print(" + repr(diagnostic) + ",file=sys.stderr)"
        command = [sys.executable, str(Path(acp_bridge.__file__)),
                   "--agent-name", "opencode", "--cwd", str(self.root),
                   "--", sys.executable, "-u", "-c", peer]
        done = subprocess.run(command, input="fixture", env={**os.environ, **self.environment},
                              capture_output=True, text=True, encoding="utf-8", timeout=10)
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertNotIn("PRIVATE-FIXTURE", done.stdout)
        self.assertNotIn("fixture-secret", done.stdout)
        self.assertIn("配置无法解析", done.stdout)
        self.assertEqual(self.personal.read_bytes(), b"invalid personal config: PRIVATE-FIXTURE")

    def test_other_agents_keep_native_config_errors(self):
        message = "ConfigJsonError: EndOfFileExpected fixture"
        for agent in ("codex", "qwen", "pi", "dsh", "codex-harness"):
            self.assertEqual(acp_bridge._friendly_bridge_error(agent, message), message)

    def test_truncated_opencode_config_dump_is_redacted_without_general_json_matching(self):
        messages = [
            "Config file at C:/fixture/opencode.json is not valid JSON(C): "
            "| fixture-secret PRIVATE-FIXTURE",
            "--- JSONC Input --- | fixture-secret PRIVATE-FIXTURE \x00\ufffd",
        ]
        for message in messages:
            with self.subTest(message=message):
                result = acp_bridge._friendly_bridge_error("opencode", message)
                self.assertIn("配置无法解析", result)
                self.assertNotIn("fixture-secret", result)
                self.assertNotIn("PRIVATE-FIXTURE", result)
                for agent in ("codex", "qwen", "pi", "dsh", "codex-harness"):
                    self.assertEqual(acp_bridge._friendly_bridge_error(agent, message), message)
        for message in ("Model response is not valid JSON(C): fixture",
                        "Model response is not valid JSON: fixture",
                        "Could not parse JSON model output: fixture"):
            self.assertEqual(acp_bridge._friendly_bridge_error("opencode", message), message)

    def test_shared_helper_is_in_runner_source_closure(self):
        backend = Path(__file__).resolve().parent
        expected = backend / "app" / "services" / "opencode_runtime_config.py"
        self.assertTrue(expected in runner_sources.build_inputs(backend, backend.parent),
                        "The standalone Runner must package the shared config boundary")

    def test_source_child_default_roots_match_all_three_platform_conventions(self):
        from app.services import opencode_runtime_config as config
        cases = [
            ("nt", "win32", ntpath, r"C:\Users\fixture", {"LOCALAPPDATA": r"C:\AppData"}, r"C:\AppData\soduwork"),
            ("posix", "darwin", posixpath, "/Users/fixture", {}, "/Users/fixture/Library/Application Support/soduwork"),
            ("posix", "linux", posixpath, "/home/fixture", {}, "/home/fixture/.local/share/soduwork"),
            ("posix", "linux", posixpath, "/home/fixture", {"XDG_DATA_HOME": "/data"}, "/data/soduwork"),
        ]
        for name, platform, paths, home, env, expected in cases:
            with self.subTest(platform=platform, env=env):
                path_api = Mock(wraps=paths)
                path_api.expanduser.return_value = home
                fake_os = SimpleNamespace(name=name, environ=env, path=path_api)
                with patch.object(config, "os", fake_os), patch.object(config.sys, "platform", platform):
                    self.assertEqual(config.runner_data_root(), expected)


if __name__ == "__main__":
    unittest.main()
