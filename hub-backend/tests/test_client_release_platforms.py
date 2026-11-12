"""Platform coverage for the signed client release contract."""

import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.services import client_updates as contract


def _trust_stub():
    """Bypass ed25519 verification; keep bundle<->payload equality checks real."""
    return patch.object(contract, "assert_trusted_release",
                        side_effect=lambda candidate: contract.manifest_payload(candidate))


def _installer(tmp: Path, name: str, size: int = 2 * 1024 * 1024) -> Path:
    path = tmp / name
    data = b"0" * size
    path.write_bytes(data)
    return path


def _bundle(installer: Path, *, platform: str, arch: str = "x64",
            artifact_name: str | None = None) -> dict:
    data = installer.read_bytes()
    return {
        "schema": 1,
        "releaseId": "11111111-1111-4111-8111-111111111111",
        "version": "1.12.58",
        "channel": "stable",
        "platform": platform,
        "arch": arch,
        "artifact": {
            "name": artifact_name or installer.name,
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "url": "/api/v1/client-updates/artifacts/11111111-1111-4111-8111-111111111111",
        },
        "mandatory": False,
        "minVersion": "",
        "notes": "",
        "publishedAt": "2026-10-10T08:00:00Z",
        "keyId": "soduwork-client-release-2026b",
        "signature": "irrelevant",
    }


class InstallerNameConventionTests(unittest.TestCase):
    def test_expected_names_cover_platforms(self):
        # Accept the primary SoduWork- prefix and the legacy SoduWork- transition prefix.
        self.assertEqual(contract._expected_installer_names("win32", "x64", "1.2.3"),
                         {"SoduWork-1.2.3-Setup.exe", "SoduWork-1.2.3-Setup.exe", "SoduWork-1.2.3-Setup.exe"})
        for prefix in ("SoduWork", "SoduWork", "SoduWork"):
            self.assertIn(f"{prefix}-1.2.3-mac-arm64.dmg",
                          contract._expected_installer_names("darwin", "arm64", "1.2.3"))
            self.assertIn(f"{prefix}-1.2.3-mac.dmg",
                          contract._expected_installer_names("darwin", "arm64", "1.2.3"))
            self.assertIn(f"{prefix}-1.2.3-linux-x64.appimage",
                          contract._expected_installer_names("linux", "x64", "1.2.3"))
            self.assertIn(f"{prefix}-1.2.3-linux-x64.deb",
                          contract._expected_installer_names("linux", "x64", "1.2.3"))
        # arch segment must survive into every non-win name variant
        for name in contract._expected_installer_names("linux", "x64", "1.2.3"):
            self.assertTrue(name.startswith("SoduWork-1.2.3-linux")
                            or name.startswith("SoduWork-1.2.3-linux")
                            or name.startswith("SoduWork-1.2.3-linux"))

    def test_legacy_win32_contract_still_rejected_without_exe(self):
        with _trust_stub():
            with tempfile.TemporaryDirectory() as tmp:
                installer = _installer(Path(tmp), "SoduWork-1.12.58-Setup.exe")
                bundle = _bundle(installer, platform="win32")
                with self.assertRaises(contract.UpdateContractError):
                    # signature check runs after integrity; stub verify path by
                    # patching sha256 mismatch via wrong name below
                    bundle["artifact"]["name"] = "SoduWork-1.12.58-mac.dmg"
                    contract.release_from_bundle(bundle, installer)

    def test_unsupported_platform_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            installer = _installer(Path(tmp), "SoduWork-1.12.58-linux-x64.AppImage")
            with self.assertRaises(contract.UpdateContractError):
                contract.release_from_bundle(
                    _bundle(installer, platform="android", artifact_name=installer.name),
                    installer)


class FilenameTargetTests(unittest.TestCase):
    def _accept(self, name: str, platform: str, arch: str = "x64") -> None:
        with _trust_stub():
            with tempfile.TemporaryDirectory() as tmp:
                installer = _installer(Path(tmp), name)
                bundle = _bundle(installer, platform=platform, arch=arch,
                                 artifact_name=name)
                candidate = contract.release_from_bundle(bundle, installer)
                self.assertEqual(candidate.platform, platform)
                self.assertEqual(candidate.arch, arch)

    def _reject(self, name: str, platform: str, arch: str = "x64") -> None:
        with _trust_stub():
            with tempfile.TemporaryDirectory() as tmp:
                installer = _installer(Path(tmp), name)
                bundle = _bundle(installer, platform=platform, arch=arch,
                                 artifact_name=name)
                with self.assertRaises(contract.UpdateContractError):
                    contract.release_from_bundle(bundle, installer)

    def test_win_setup_exe(self):
        self._accept("SoduWork-1.12.58-Setup.exe", "win32", "x64")

    def test_mac_dmg_with_arch(self):
        self._accept("SoduWork-1.12.58-mac-arm64.dmg", "darwin", "arm64")

    def test_mac_zip_without_arch(self):
        self._accept("SoduWork-1.12.58-mac.zip", "darwin", "x64")

    def test_linux_appimage(self):
        self._accept("SoduWork-1.12.58-linux-x64.AppImage", "linux", "x64")

    def test_linux_deb(self):
        self._accept("SoduWork-1.12.58-linux-x64.deb", "linux", "x64")

    def test_linux_rpm(self):
        self._accept("SoduWork-1.12.58-linux-x64.rpm", "linux", "x64")

    def test_linux_tar_gz_double_suffix(self):
        # Path.suffix only sees ".gz"; the contract must match the full name.
        self._accept("SoduWork-1.12.58-linux-x64.tar.gz", "linux", "x64")

    def test_linux_arm64_tar_gz(self):
        self._accept("SoduWork-1.12.58-linux-arm64.tar.gz", "linux", "arm64")

    def test_mac_intel_dmg(self):
        self._accept("SoduWork-1.12.58-mac-x64.dmg", "darwin", "x64")

    def test_mac_zip_without_arch_still_x64(self):
        self._accept("SoduWork-1.12.58-mac.zip", "darwin", "x64")

    def test_bare_gz_rejected_on_linux(self):
        # a bare .gz (not .tar.gz) is not a valid installer
        self._reject("SoduWork-1.12.58-linux-x64.pkg.gz", "linux", "x64")

    def test_dmg_rejected_on_linux(self):
        self._reject("SoduWork-1.12.58-linux-x64.dmg", "linux", "x64")

    def test_mac_exe_rejected(self):
        self._reject("SoduWork-1.12.58-mac-arm64.exe", "darwin", "arm64")


if __name__ == "__main__":
    unittest.main()
