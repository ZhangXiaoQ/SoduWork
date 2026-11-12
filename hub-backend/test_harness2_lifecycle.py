"""Harness2 discovery and explicit setup without downloads or live model calls."""
from __future__ import annotations

import copy
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


class Harness2LifecycleTest(unittest.TestCase):
    def setUp(self):
        self.data = tempfile.TemporaryDirectory(prefix="soduwork-harness2-lifecycle-")
        self.addCleanup(self.data.cleanup)
        environment = patch.dict(os.environ, {"SODUWORK_DATA_ROOT": self.data.name})
        environment.start()
        self.addCleanup(environment.stop)

    def disabled_marker(self):
        return Path(self.data.name) / "agents" / "harness2" / "disabled.json"

    def test_catalog_exposes_a_bundled_managed_runner_with_existing_access_contract(self):
        from app.agent_catalog import AGENTS, gateway_model_kinds
        self.assertIn("harness2", AGENTS)
        row = AGENTS["harness2"]
        self.assertEqual(row["transport"], "runner")
        self.assertEqual(row["install"]["installer"], "bundled")
        self.assertIn("local:harness2", gateway_model_kinds())
        from app.services import access_policy, local_base
        self.assertIn("harness2", local_base._PROFILES)
        self.assertTrue(access_policy.capability("harness2")["supported"])
        with tempfile.TemporaryDirectory() as workspace:
            policy = access_policy.prepare("harness2", {
                "schema": "soduwork.access-policy/v1", "mode": "readonly", "revision": 1,
                "workspaceRoot": workspace,
            }, workspace)
        self.assertEqual(policy["mode"], "readonly")

    def test_unreviewed_agent_cannot_claim_a_bundled_installer(self):
        from app.agent_catalog import AGENTS, validate_catalog
        row = copy.deepcopy(AGENTS["opencode"])
        row["install"]["installer"] = "bundled"
        with self.assertRaises(ValueError):
            validate_catalog({"schemaVersion": 1, "agents": [row]})

    def test_discovery_reports_missing_executor_without_installing_it(self):
        from app.services import agent_setup, harness2_runtime, local_base, managed_agents
        with (patch.object(harness2_runtime, "runtime_issue", return_value="执行组件缺失，请点装上"),
              patch.object(harness2_runtime, "is_bundled", return_value=True),
              patch.object(local_base, "_opencode_bin", return_value=""),
              patch.object(harness2_runtime, "version", return_value="0.1.0"),
              patch.object(managed_agents, "install", side_effect=AssertionError("discovery installed software"))):
            item = agent_setup.detect("harness2", probes={})
        self.assertTrue(item["bundled"])
        self.assertFalse(item["installed"])
        self.assertEqual(item["state"], "missing")
        self.assertEqual(item["setupState"], "broken")
        self.assertTrue(item["present"])
        self.assertIn("执行组件缺失", item["why"])
        self.assertEqual(item["version"], "0.1.0")

    def test_ready_core_distinguishes_model_availability_and_probe_result(self):
        from app.services import agent_setup, harness2_runtime
        with (patch.object(harness2_runtime, "runtime_issue", return_value=""),
              patch.object(harness2_runtime, "is_bundled", return_value=True),
              patch.object(agent_setup, "_bin_of", return_value=sys.executable),
              patch.object(agent_setup, "_cached_version_probe", return_value="1.18.18"),
              patch.object(harness2_runtime, "version", return_value="0.1.0")):
            ready = agent_setup.detect("harness2", probes={})
            nollm = agent_setup.detect("harness2", has_model=False, probes={})
        self.assertTrue(ready["installed"])
        self.assertEqual(ready["state"], "ready")
        self.assertEqual(ready["probe"], {})
        self.assertEqual(nollm["state"], "nollm")

    def run_job(self, action, issue=''):
        from app.services import agent_setup, harness2_runtime, managed_agents
        with (patch.object(agent_setup, '_spawn', side_effect=lambda jid, fn, *args: fn(jid, *args)),
              patch.object(managed_agents, 'install', side_effect=AssertionError('Harness must not install another runtime')),
              patch.object(harness2_runtime, 'runtime_issue', return_value=issue),
              patch.object(harness2_runtime, 'is_bundled', return_value=True)):
            return agent_setup.job(agent_setup.start_install('harness2', action))

    def test_explicit_enable_verifies_bundled_runtime_and_reports_real_outcome(self):
        job = self.run_job("install")
        self.assertEqual(job["state"], "done")
        self.assertTrue(job["ok"])
        self.assertIn("独立执行器", job["detail"])
        self.assertFalse(self.run_job("install", issue="内置核心缺失")["ok"])
        self.assertFalse(self.run_job("update", issue="组件自检失败")["ok"])

    def test_bundled_uninstall_does_not_remove_shared_executor(self):
        shared = Path(self.data.name) / "agents" / "opencode" / "active.json"
        shared.parent.mkdir(parents=True)
        shared.write_text('{"version":"fixture-shared"}', encoding="utf-8")
        job = self.run_job("uninstall")
        self.assertEqual(job["state"], "done")
        self.assertTrue(job["ok"])
        self.assertIn("停用", job["detail"])
        self.assertTrue(self.disabled_marker().is_file())
        self.assertEqual(shared.read_text(encoding="utf-8"), '{"version":"fixture-shared"}')

    def test_uninstall_persists_across_module_reload_and_discovery(self):
        from app.services import agent_setup, harness2_lifecycle, harness2_runtime
        self.assertTrue(self.run_job("uninstall")["ok"])
        importlib.reload(harness2_lifecycle)
        self.assertIn("装上", harness2_lifecycle.disabled_issue())
        with (patch.object(harness2_runtime, "runtime_issue", return_value=""),
              patch.object(harness2_runtime, "is_bundled", return_value=True)):
            item = agent_setup.detect("harness2", probes={"harness2": {"ok": True}})
        self.assertFalse(item["installed"])
        self.assertEqual(item["state"], "missing")
        self.assertEqual(item["setupState"], "disabled")
        self.assertIn("停用", item["why"])

    def test_reinstall_only_reenables_after_bundled_runtime_validation_succeeds(self):
        self.assertTrue(self.run_job("uninstall")["ok"])
        self.assertFalse(self.run_job("install", issue="内置核心缺失")["ok"])
        self.assertTrue(self.disabled_marker().is_file())
        self.assertFalse(self.run_job("update", issue="组件自检失败")["ok"])
        self.assertTrue(self.disabled_marker().is_file())
        self.assertTrue(self.run_job("install")["ok"])
        self.assertFalse(self.disabled_marker().exists())

    def test_failed_state_write_does_not_report_uninstall_success_or_leave_partial_state(self):
        from app.services import harness2_lifecycle
        with patch.object(harness2_lifecycle.os, "replace", side_effect=PermissionError("fixture write denied")):
            job = self.run_job("uninstall")
        self.assertFalse(job["ok"])
        self.assertFalse(self.disabled_marker().exists())
        self.assertEqual(list(self.disabled_marker().parent.iterdir()), [])
        self.assertTrue(self.run_job("uninstall")["ok"])
        before = self.disabled_marker().read_bytes()
        with patch.object(harness2_lifecycle.os, "replace", side_effect=PermissionError("fixture write denied")):
            self.assertFalse(self.run_job("uninstall")["ok"])
        self.assertEqual(self.disabled_marker().read_bytes(), before)

    def test_runner_source_graph_packages_the_persistent_lifecycle_module(self):
        from app.services import runner_sources
        backend = Path(__file__).resolve().parent
        self.assertIn(backend / "app/services/harness2_lifecycle.py",
                      runner_sources.build_inputs(backend, backend.parent))

    def test_check_reports_independent_runtime_without_enabling_or_installing(self):
        from app.services import agent_setup, harness2_runtime, managed_agents
        self.assertTrue(self.run_job('uninstall')['ok'])
        before = self.disabled_marker().read_bytes()
        with (patch.object(agent_setup, '_spawn', side_effect=lambda jid, fn, *args: fn(jid, *args)),
              patch.object(managed_agents, 'install', side_effect=AssertionError('Unexpected install')),
              patch.object(managed_agents, 'binary_version', side_effect=AssertionError('Unexpected OpenCode version query')),
              patch.object(harness2_runtime, 'is_bundled', return_value=True)):
            job = agent_setup.job(agent_setup.start_install('harness2', 'check'))
        self.assertTrue(job['ok'], job)
        self.assertIn(harness2_runtime.version(), job['detail'])
        self.assertIn('无需安装其他底座', job['detail'])
        self.assertEqual(self.disabled_marker().read_bytes(), before)

    def test_environment_does_not_fall_through_to_opencode_or_lose_runtime_identity(self):
        from app.services import harness2_runtime, local_base
        seen = {}
        def environment(env, cfg, runtime_ref=""):
            seen.update(cfg=cfg, ref=runtime_ref)
            return {**env, "HARNESS2_FIXTURE": "routed"}
        cfg = {"local_cli": "harness2", "llm": {"base": "https://fixture.invalid/v1",
               "key": "fixture-secret", "model": "fixture"}, "networkAllowed": False}
        with patch.object(harness2_runtime, "environment", side_effect=environment):
            env = local_base._env_for(local_base._PROFILES["harness2"], cfg, "fixture-ref")
        self.assertEqual(env.get("HARNESS2_FIXTURE"), "routed")
        self.assertEqual(seen["ref"], "fixture-ref")
        self.assertEqual(seen["cfg"]["local_cli"], "harness2")

    def test_probe_uses_the_bounded_probe_entry(self):
        from app.services import agent_setup
        self.assertIn("--probe", agent_setup._probe_args("harness2", ["--session", "fixture"]))

    def test_version_probe_runs_harness2_instead_of_the_python_interpreter(self):
        from app.services import agent_setup, harness2_runtime, local_base
        profile = local_base._PROFILES["harness2"]
        self.assertTrue(callable(profile.get("argv_prefix")))
        version = agent_setup._short(profile["bin"](), [*profile["argv_prefix"](), "--version"])
        self.assertEqual(version, harness2_runtime.version())

    def test_runner_entry_dispatches_bundled_bridge_without_starting_a_runner(self):
        result = subprocess.run([
            sys.executable, str(Path(__file__).with_name("runner_main.py")),
            "--harness2-bridge", "--version",
        ], capture_output=True, text=True, encoding="utf-8", timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "0.2.0")

    def test_runner_native_entry_speaks_acp_without_starting_a_hub_connection(self):
        from app.services import harness2_runtime
        with tempfile.TemporaryDirectory() as folder:
            env = dict(os.environ)
            env.update({harness2_runtime.ROOT_ENV: folder, harness2_runtime.MODEL_ENV: '{}',
                        'SODUWORK_MCP_SERVERS_JSON': '{}', 'SODUWORK_MCP_SERVERS': ''})
            messages = [{'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {}},
                        {'jsonrpc': '2.0', 'id': 2, 'method': 'session/new', 'params': {'cwd': folder}}]
            child = subprocess.run([sys.executable, str(Path(__file__).with_name('runner_main.py')),
                '--harness2-native'], input=''.join(json.dumps(row) + '\n' for row in messages),
                env=env, capture_output=True, text=True, encoding='utf-8', timeout=15)
            self.assertEqual(child.returncode, 0, child.stderr)
            replies = [json.loads(line) for line in child.stdout.splitlines()]
            self.assertEqual([row['id'] for row in replies], [1, 2])
            self.assertTrue(replies[0]['result']['agentCapabilities']['loadSession'])
            sid = replies[1]['result']['sessionId']
            self.assertTrue(sid.startswith('h2_'))
            self.assertTrue((Path(folder) / 'sessions' / (sid + '.json')).is_file())


if __name__ == "__main__":
    unittest.main()
