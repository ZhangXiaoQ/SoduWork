"""Run the real shell lifecycle with synthetic security/notary commands."""
import base64
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
git_bash = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
BASH = str(git_bash) if git_bash.is_file() else shutil.which("bash")


@unittest.skipUnless(BASH, "Bash is required for the macOS signing shell lifecycle")
class MacSigningLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-signing-test space-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.search = self.root / "search-list"
        self.original = ["/Users/fixture/Library/Keychains/login.keychain-db",
                         "/Users/fixture/Keychains/extra keys.keychain-db"]
        self.search.write_text("\n".join(self.original) + "\n", encoding="utf-8")
        self.bootstrap = self.root / "mock-commands.sh"
        self.bootstrap.write_text(r"""security() {
  case "DOLLAR1" in
    list-keychains)
      if [[ "DOLLAR{4:-}" == -s ]]; then
        shift 4
        if [[ "DOLLAR{MOCK_FAIL_RESTORE:-}" == 1 && "DOLLAR*" != *signing.keychain-db* ]]; then
          return 29
        fi
        printf '%s\n' "DOLLAR@" > "DOLLARMOCK_SEARCH"
      else
        while IFS= read -r line; do printf '    "%s"\n' "DOLLARline"; done < "DOLLARMOCK_SEARCH"
      fi ;;
    create-keychain)
      for last in "DOLLAR@"; do :; done
      : > "DOLLARlast" ;;
    delete-keychain) rm -f "DOLLAR2" ;;
  esac
}
xcrun() {
  if [[ "DOLLAR{MOCK_NOTARY_FAILURE:-}" == 1 ]]; then return 17; fi
  if [[ "DOLLAR{MOCK_NOTARY_SIGNAL:-}" == 1 ]]; then kill -TERM "DOLLARDOLLAR"; fi
}
printf() {
  if [[ "DOLLAR{MOCK_EXPORT_WRITE_FAILURE:-}" == 1 && "DOLLAR*" == *SODUWORK_MAC_SIGNING_STATE=* ]]; then
    return 23
  fi
  builtin printf "DOLLAR@"
}
""".replace("DOLLAR", "$"), encoding="utf-8")
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith("SODUWORK_MAC_")}
        self.env.update({
            "BASH_ENV": self.bootstrap.as_posix(), "RUNNER_TEMP": self.root.as_posix(),
            "GITHUB_ENV": (self.root / "github-env").as_posix(),
            "MOCK_SEARCH": self.search.as_posix(),
            "SODUWORK_MAC_CERTIFICATE_B64": base64.b64encode(b"synthetic certificate fixture").decode("ascii"),
            "SODUWORK_MAC_CERTIFICATE_PASSWORD": "fixture",
            "SODUWORK_MAC_KEYCHAIN_PASSWORD": "fixture",
            "SODUWORK_MAC_SIGN_IDENTITY": "Developer ID Application: Fixture (TEST)",
            "SODUWORK_MAC_NOTARY_KEY_ID": "FIXTURE",
            "SODUWORK_MAC_NOTARY_ISSUER": "fixture-issuer",
            "SODUWORK_MAC_NOTARY_PRIVATE_KEY_B64": base64.b64encode(b"synthetic notary fixture").decode("ascii"),
        })

    def run_script(self, name, extra=None):
        return subprocess.run([BASH, (ROOT / "tools/ci" / name).as_posix()],
                              env=self.env | (extra or {}), capture_output=True,
                              text=True, encoding="utf-8", timeout=15)

    def exports(self):
        return dict(line.split("=", 1) for line in
                    Path(self.env["GITHUB_ENV"]).read_text(encoding="utf-8").splitlines())

    def test_success_preserves_login_then_restores_and_removes_owned_material(self):
        Path(self.env["GITHUB_ENV"]).write_text("EXISTING_VARIABLE=retained\n", encoding="utf-8")
        result = self.run_script("prepare-macos-signing.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        exports = self.exports()
        self.assertEqual(exports["EXISTING_VARIABLE"], "retained")
        state = Path(exports["SODUWORK_MAC_SIGNING_STATE"])
        current = self.search.read_text(encoding="utf-8").splitlines()
        self.assertEqual(current, self.original + [exports["SODUWORK_MAC_KEYCHAIN"]])
        self.assertFalse((state / "certificate.p12").exists())
        self.assertFalse((state / "notary.p8").exists())
        self.assertTrue((state / "signing.keychain-db").exists())
        result = self.run_script("cleanup-macos-signing.sh", exports)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.search.read_text(encoding="utf-8").splitlines(), self.original)
        self.assertFalse(state.exists())
        self.assertEqual(self.run_script("cleanup-macos-signing.sh", exports).returncode, 0)

    def test_notary_failure_restores_search_list_and_removes_partial_material(self):
        result = self.run_script("prepare-macos-signing.sh", {"MOCK_NOTARY_FAILURE": "1"})
        self.assertEqual(result.returncode, 17, result.stderr)
        self.assertEqual(self.search.read_text(encoding="utf-8").splitlines(), self.original)
        self.assertEqual(list(self.root.glob("soduwork-macos-signing.*")), [])

    def test_termination_restores_search_list_and_removes_partial_material(self):
        result = self.run_script("prepare-macos-signing.sh", {"MOCK_NOTARY_SIGNAL": "1"})
        self.assertEqual(result.returncode, 143, result.stderr)
        self.assertEqual(self.search.read_text(encoding="utf-8").splitlines(), self.original)
        self.assertEqual(list(self.root.glob("soduwork-macos-signing.*")), [])

    def test_failed_environment_export_also_restores_the_search_list(self):
        result = self.run_script("prepare-macos-signing.sh", {"GITHUB_ENV": self.root.as_posix()})
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn("Unable to export macOS signing state", result.stderr)
        self.assertEqual(self.search.read_text(encoding="utf-8").splitlines(), self.original)
        self.assertEqual(list(self.root.glob("soduwork-macos-signing.*")), [])

    def test_environment_write_error_also_rolls_back_after_redirect_succeeds(self):
        result = self.run_script("prepare-macos-signing.sh", {"MOCK_EXPORT_WRITE_FAILURE": "1"})
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn("Unable to export macOS signing state", result.stderr)
        self.assertTrue(Path(self.env["GITHUB_ENV"]).is_file(), "redirection succeeded before the write failed")
        self.assertEqual(self.exports(), {})
        self.assertEqual(self.search.read_text(encoding="utf-8").splitlines(), self.original)
        self.assertEqual(list(self.root.glob("soduwork-macos-signing.*")), [])

    def test_failed_restore_retains_state_for_a_successful_retry(self):
        self.assertEqual(self.run_script("prepare-macos-signing.sh").returncode, 0)
        exports = self.exports()
        state = Path(exports["SODUWORK_MAC_SIGNING_STATE"])
        result = self.run_script("cleanup-macos-signing.sh", exports | {"MOCK_FAIL_RESTORE": "1"})
        self.assertEqual(result.returncode, 29, result.stderr)
        self.assertTrue((state / "search-list").exists())
        self.assertTrue((state / "signing.keychain-db").exists())
        result = self.run_script("cleanup-macos-signing.sh", exports)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(state.exists())
        self.assertEqual(self.search.read_text(encoding="utf-8").splitlines(), self.original)

    def test_empty_search_list_is_preserved_without_a_blank_keychain(self):
        self.search.write_text("", encoding="utf-8")
        result = self.run_script("prepare-macos-signing.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        exports = self.exports()
        self.assertEqual(self.search.read_text(encoding="utf-8").splitlines(),
                         [exports["SODUWORK_MAC_KEYCHAIN"]])
        result = self.run_script("cleanup-macos-signing.sh", exports)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.search.read_text(encoding="utf-8").strip(), "")


if __name__ == "__main__":
    unittest.main()
