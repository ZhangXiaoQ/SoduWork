"""Cross-platform installation contracts; fixture hosts do not prove native execution."""
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from app.services import agent_npm_runtime as npm, agent_setup, local_base, managed_agents


class AgentPlatformInstallationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agent platform ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_all_platforms_install_in_owned_directory_with_matching_layout(self):
        for platform in ("win32", "darwin", "linux"):
            with self.subTest(platform=platform), patch.object(npm.sys, "platform", platform), \
                    patch.object(local_base, "_data_root", return_value=str(self.root)):
                prefix = self.root / "agent-runtimes/npm"
                directory = prefix if platform == "win32" else prefix / "bin"
                modules = prefix / ("node_modules" if platform == "win32" else "lib/node_modules")
                self.assertEqual(Path(npm.private_prefix()), prefix)
                self.assertEqual(Path(npm.private_root()), modules)
                self.assertEqual(Path(npm.private_bin_dir()), directory)
                with patch.dict(os.environ, {"NPM_CONFIG_PREFIX": "/system/readonly",
                                             "npm_config_arch": "wrong-arch", "NPM_CONFIG_PLATFORM": "foreign"}):
                    env = npm.environment({"nodePath": str(self.root / "node")}, install=True)
                    self.assertEqual(os.environ["NPM_CONFIG_PREFIX"], "/system/readonly")
                self.assertEqual(Path(env["NPM_CONFIG_PREFIX"]), prefix)
                self.assertEqual(Path(env["NPM_CONFIG_CACHE"]), prefix / "cache")
                self.assertIn(str(directory), env["PATH"].split(os.pathsep))
                self.assertNotIn("npm_config_arch", env)
                self.assertNotIn("NPM_CONFIG_PLATFORM", env)

    def test_windows_uses_cmd_launcher_instead_of_posix_shell_shim(self):
        for suffix in ("", ".cmd", ".ps1"):
            (self.root / ("codex-acp" + suffix)).write_text("fixture", encoding="utf-8")
        with patch.object(npm.sys, "platform", "win32"), patch.object(npm, "private_prefix", return_value=str(self.root)):
            self.assertEqual(npm.private_bin(["codex-acp"]), str(self.root / "codex-acp.cmd"))

    def test_windows_codex_account_uses_owned_native_binary_for_each_architecture(self):
        for machine, arch, triple in (("AMD64", "x64", "x86_64"), ("ARM64", "arm64", "aarch64")):
            with self.subTest(machine=machine):
                binary = self.root / f"@openai/codex/node_modules/@openai/codex-win32-{arch}/vendor/{triple}-pc-windows-msvc/bin/codex.exe"
                binary.parent.mkdir(parents=True)
                binary.write_bytes(b"native fixture")
                # Keep the native architecture assertion tied to a real personal package.
                (self.root / "@openai/codex/package.json").write_text(
                    '{"name":"@openai/codex"}', encoding="utf-8")
                with patch.object(local_base, "_WIN", True), patch("platform.machine", return_value=machine), \
                        patch.object(npm, "runtime_target", return_value=("win32", arch)), \
                        patch.object(npm, "private_root", return_value=str(self.root)), \
                        patch.object(local_base, "_npm_root", return_value=""), \
                        patch.object(npm, "private_bin", side_effect=AssertionError("Native account cannot launch .cmd")):
                    self.assertEqual(local_base._codex_bin(), str(binary))

    def test_native_packages_follow_node_architecture_under_rosetta(self):
        from app.services import agent_setup_runtime
        for python_arch, node_arch in (("x86_64", "arm64"), ("arm64", "x64")):
            pair = {"platform": "darwin", "arch": node_arch}
            with self.subTest(node_arch=node_arch), patch.object(npm.sys, "platform", "darwin"), \
                    patch("platform.machine", return_value=python_arch), \
                    patch.object(npm, "resolve", return_value=pair):
                self.assertEqual(npm.runtime_target(), ("darwin", node_arch))
                self.assertEqual(agent_setup_runtime._codex_native_name(), "@openai/codex-darwin-" + node_arch)
                env = npm.environment(pair, install=True)
                self.assertEqual(env["npm_config_cpu"], node_arch)
                self.assertEqual(env["npm_config_os"], "darwin")

    def test_pi_cannot_be_removed_with_missing_or_external_payload(self):
        for bundled in (True, False):
            with self.subTest(bundled=bundled), patch.object(agent_setup, "is_bundled", return_value=bundled), \
                    patch.object(agent_setup, "_spawn") as spawn, patch.object(agent_setup, "_stream") as stream:
                jid = agent_setup.start_install("pi", "uninstall")
                self.assertFalse(agent_setup.job(jid)["ok"])
                self.assertFalse(agent_setup.can_uninstall("pi"))
                agent_setup._run_npm(jid, "pi", "uninstall")
                spawn.assert_not_called()
                stream.assert_not_called()

    def test_linux_install_overrides_foreign_libc_without_guessing_unknown_hosts(self):
        for libc in ("glibc", "musl", ""):
            with self.subTest(libc=libc), patch.object(npm.sys, "platform", "linux"), \
                    patch.object(npm, "private_prefix", return_value=str(self.root)), \
                    patch.dict(os.environ, {"npm_config_libc": "foreign-libc"}):
                env = npm.environment({"platform": "linux", "arch": "x64", "libc": libc}, install=True)
                self.assertEqual(os.environ["npm_config_libc"], "foreign-libc")
                if libc:
                    self.assertEqual(env["NPM_CONFIG_LIBC"], libc)
                    self.assertEqual(env["npm_config_libc"], libc)
                else:
                    self.assertNotIn("npm_config_libc", env)

    def test_cpu_guard_uses_real_flag_records_and_all_processors(self):
        for cpuinfo, unsupported in (("", False), ("model name : ssse3\nflags : sse2\n", True),
                ("flags : sse2 ssse3\n", True), ("flags : sse2 ssse3 sse4_2\n", False),
                ("flags : sse2 ssse3 sse4_2\nflags : sse2\n", True)):
            with self.subTest(cpuinfo=cpuinfo), patch.object(managed_agents.sys, "platform", "linux"), \
                    patch("platform.machine", return_value="x86_64"), patch.object(Path, "read_text", return_value=cpuinfo):
                self.assertEqual(bool(managed_agents._cpu_compatibility_issue()), unsupported)

    def test_cpu_capabilities_never_use_model_names_or_cross_empty_flag_lines(self):
        cases = (
            ("flags :\nmodel name : ssse3 sse4_2 avx avx2\n", False, False),
            ("flags : \t\nprocessor : 1\nmodel name : avx2\n", False, False),
            ("model name : avx avx2\nflags : ssse3 sse4_2\n", False, False),
            ("model name : ssse3 sse4_2\nflags : sse2\n", True, False),
            ("\tflags\t: ssse3 sse4_2 avx avx2\n", False, True),
        )
        for cpuinfo, blocked, optimized in cases:
            with self.subTest(cpuinfo=cpuinfo), patch.object(managed_agents, "sys", SimpleNamespace(platform="linux")), \
                    patch.object(managed_agents, "os", SimpleNamespace(name="posix")), \
                    patch("platform.system", return_value="Linux"), patch("platform.machine", return_value="x86_64"), \
                    patch.object(Path, "read_text", return_value=cpuinfo), \
                    patch.object(managed_agents, "_is_musl", return_value=False):
                self.assertEqual(bool(managed_agents._cpu_compatibility_issue()), blocked)
                self.assertEqual(managed_agents.platform_key(), "linux-x64" if optimized else "linux-x64-baseline")

    def test_optimized_artifact_requires_avx_on_every_known_processor_without_unknown_records(self):
        supported = "flags : ssse3 sse4_2 avx avx2\n"
        for other, optimized in ((supported, True), ("flags : ssse3 sse4_2\n", False),
                ("flags : ssse3 sse4_2 avx2\n", False), ("flags :\n", False), ("model name : unknown\n", False)):
            cpuinfo = "processor : 0\n" + supported + "processor : 1\n" + other
            with self.subTest(other=other), patch.object(managed_agents, "sys", SimpleNamespace(platform="linux")), \
                    patch.object(managed_agents, "os", SimpleNamespace(name="posix")), \
                    patch("platform.machine", return_value="x86_64"), patch.object(Path, "read_text", return_value=cpuinfo):
                self.assertEqual(managed_agents._has_avx2(), optimized)
                self.assertEqual(managed_agents._cpu_compatibility_issue(), "")

    def test_missing_cpu_records_are_unknown_and_unreadable_cpuinfo_uses_baseline(self):
        with patch.object(managed_agents, "sys", SimpleNamespace(platform="linux")), \
                patch.object(managed_agents, "os", SimpleNamespace(name="posix")), \
                patch("platform.system", return_value="Linux"), patch("platform.machine", return_value="x86_64"), \
                patch.object(Path, "read_text", side_effect=OSError("fixture unavailable")), \
                patch.object(managed_agents, "_is_musl", return_value=False):
            self.assertEqual(managed_agents._cpu_compatibility_issue(), "")
            self.assertEqual(managed_agents.platform_key(), "linux-x64-baseline")

    def test_sse42_preflight_blocks_install_update_and_check_before_native_execution(self):
        with patch.object(managed_agents, "sys", SimpleNamespace(platform="linux")), \
                patch("platform.machine", return_value="x86_64"), \
                patch.object(Path, "read_text", return_value="flags : sse2 ssse3\n"), \
                patch.object(managed_agents, "binary_version") as version, \
                patch.object(managed_agents, "_download") as download:
            issue = managed_agents._cpu_compatibility_issue()
            self.assertIn("SSE4.2", issue)
            self.assertNotIn("SSSE3", issue)
            self.assertEqual(managed_agents.install("check", lambda _: None), (False, issue))
            for action in ("install", "update"):
                with self.subTest(action=action), self.assertRaisesRegex(RuntimeError, "SSE4.2"):
                    managed_agents.install(action, lambda _: None)
            version.assert_not_called()
            download.assert_not_called()

    def test_unsupported_cpu_can_remove_without_launching_binary(self):
        with patch.object(managed_agents, "_cpu_compatibility_issue", return_value="unsupported"), \
                patch.object(managed_agents, "binary_version", side_effect=AssertionError("Unsafe native launch")), \
                patch.object(managed_agents, "_remove_managed", return_value=(True, "removed")) as remove:
            self.assertEqual(managed_agents.install("uninstall", lambda _: None), (True, "removed"))
        remove.assert_called_once()

    def test_opencode_artifact_selection_covers_mac_linux_and_windows(self):
        for system, machine, avx, musl, expected in (
            ("Darwin", "arm64", False, False, "darwin-arm64"),
            ("Darwin", "x86_64", True, False, "darwin-x64"),
            ("Darwin", "x86_64", False, False, "darwin-x64-baseline"),
            ("Linux", "aarch64", False, False, "linux-arm64"),
            ("Linux", "aarch64", False, True, "linux-arm64-musl"),
            ("Linux", "x86_64", False, True, "linux-x64-baseline-musl"),
            ("Linux", "x86_64", True, False, "linux-x64"),
            ("Windows", "AMD64", False, False, "windows-x64-baseline"),
            ("Windows", "ARM64", False, False, "windows-arm64"),
        ):
            with self.subTest(expected=expected), patch("platform.system", return_value=system), \
                    patch("platform.machine", return_value=machine), \
                    patch.object(managed_agents, "_has_avx2", return_value=avx), \
                    patch.object(managed_agents, "_is_musl", return_value=musl):
                self.assertEqual(managed_agents.platform_key(), expected)
                self.assertEqual(len(managed_agents.OPENCODE_ARTIFACTS[expected][1]), 64)


if __name__ == "__main__":
    unittest.main()
