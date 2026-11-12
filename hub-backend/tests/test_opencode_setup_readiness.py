"""Managed execution dependency readiness without installs, network or user state."""
from __future__ import annotations

import sys
import unittest
from unittest.mock import patch

from app.services import agent_setup, claude_runtime, harness2_lifecycle, harness2_runtime, local_base, managed_agents


MISSING = "受管 OpenCode 运行依赖不完整，请点「重装 / 升到最新」补齐。"


class OpenCodeSetupReadinessTests(unittest.TestCase):
    def detect(self, key, issue):
        with (patch.object(managed_agents, "runtime_issue", return_value=issue, create=True),
              patch.object(harness2_lifecycle, "disabled_issue", return_value=""),
              patch.object(harness2_runtime, "is_bundled", return_value=True),
              patch.object(local_base, "_opencode_bin", return_value=sys.executable),
              patch.object(agent_setup, "_bin_of", return_value=sys.executable),
              patch.object(agent_setup, "_version_of", return_value=("fixture", "managed", "")),
              patch.object(agent_setup, "_short", side_effect=AssertionError("Discovery launched a process")),
              patch.object(managed_agents, "install", side_effect=AssertionError("Discovery installed software"))):
            return agent_setup.detect(key, probes={})

    def test_missing_managed_dependencies_are_not_advertised_as_installed_or_ready(self):
        for key in ("opencode", "harness2"):
            with self.subTest(key=key):
                result = self.detect(key, MISSING)
                if key == 'harness2':
                    self.assertTrue(result['installed'])
                    self.assertEqual(result['state'], 'ready')
                    self.assertEqual(result['runtimeIssue'], '')
                    continue
                self.assertFalse(result["installed"])
                self.assertEqual(result["state"], "missing")
                self.assertEqual(result["setupState"], "broken")
                self.assertTrue(result["present"])
                self.assertEqual(result["runtimeIssue"], MISSING)
                self.assertEqual(result["why"], MISSING)
                self.assertEqual(result["warnNow"], MISSING)

    def test_no_managed_dependency_issue_preserves_ready_discovery(self):
        for key in ("opencode", "harness2"):
            with self.subTest(key=key):
                result = self.detect(key, "")
                self.assertTrue(result["installed"])
                self.assertEqual(result["state"], "ready")

    def test_global_executor_without_managed_binary_keeps_existing_readiness(self):
        with (patch.object(managed_agents, "managed_binary", return_value=""),
              patch.object(managed_agents, "_root", side_effect=AssertionError("Global CLI read managed state")),
              patch.object(harness2_lifecycle, "disabled_issue", return_value=""),
              patch.object(harness2_runtime, "is_bundled", return_value=True),
              patch.object(local_base, "_opencode_bin", return_value=sys.executable)):
            self.assertEqual(agent_setup._runtime_issue("opencode"), "")
            self.assertEqual(harness2_runtime.runtime_issue(), "")
            for check in ("runtime_issue", "runtime_probe"):
                self.assertEqual(local_base._PROFILES["opencode"][check](), "")

    def test_dispatch_and_probe_profiles_block_before_starting_incomplete_executor(self):
        for key in ("opencode", "harness2"):
            for check in ("runtime_issue", "runtime_probe"):
                with (self.subTest(key=key, check=check),
                      patch.object(managed_agents, "runtime_issue", return_value=MISSING, create=True),
                      patch.object(harness2_lifecycle, "disabled_issue", return_value=""),
                      patch.object(harness2_runtime, "is_bundled", return_value=True),
                      patch.object(local_base, "_opencode_bin", return_value=sys.executable),
                      patch.object(agent_setup, "_short", return_value="fixture") as run,
                      patch("app.services.agent_setup_runtime._short", return_value="fixture") as version):
                    callback = local_base._PROFILES[key].get(check)
                    self.assertTrue(callable(callback), (key, check))
                    self.assertEqual(callback(), "" if key == "harness2" else MISSING)
                    run.assert_not_called()
                    version.assert_not_called()

    def test_disabled_harness_stays_disabled_before_shared_dependency_check(self):
        with (patch.object(harness2_lifecycle, "disabled_issue", return_value="Harness² 已卸载"),
              patch.object(managed_agents, "runtime_issue", return_value=MISSING, create=True) as check):
            self.assertEqual(harness2_runtime.runtime_issue(), "Harness² 已卸载")
            check.assert_not_called()

    def test_missing_executor_keeps_original_install_guidance(self):
        with (patch.object(harness2_lifecycle, "disabled_issue", return_value=""),
              patch.object(harness2_runtime, "is_bundled", return_value=True),
              patch.object(local_base, "_opencode_bin", return_value=""),
              patch.object(managed_agents, "runtime_issue", return_value=MISSING, create=True) as check):
            self.assertEqual(harness2_runtime.runtime_issue(), "")
            check.assert_not_called()

    def test_other_cli_readiness_does_not_consume_opencode_dependency_state(self):
        with (patch.object(managed_agents, "runtime_issue", side_effect=AssertionError("Unrelated CLI check"),
                           create=True),
              patch.object(claude_runtime, "runtime_issue", return_value="") as claude_check):
            for key in ("pi", "qwen", "claude", "custom"):
                with self.subTest(key=key):
                    self.assertEqual(agent_setup._runtime_issue(key), "")
            claude_check.assert_called_once()

    def test_claude_reports_its_own_runtime_issue_without_opencode_state(self):
        with (patch.object(managed_agents, "runtime_issue", side_effect=AssertionError("Unrelated CLI check")),
              patch.object(claude_runtime, "runtime_issue", return_value="Claude adapter missing")):
            self.assertEqual(agent_setup._runtime_issue("claude"), "Claude adapter missing")


if __name__ == "__main__":
    unittest.main()
