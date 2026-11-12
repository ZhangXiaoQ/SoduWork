"""Version selection must not downgrade a configured NFSv4.1 endpoint."""
import io
import sys
import types
import unittest
from unittest.mock import Mock, patch

from app.config import Settings
from app.services import library_nfs, library_storage


class NfsVersionTests(unittest.TestCase):
    def settings(self, version="4.1"):
        return Settings(_env_file=None, library_storage_backend="remote", library_remote_order="nfs,minio",
                        library_nfs_host="192.0.2.224", library_nfs_port=2049,
                        library_nfs_export="/srv/soduwork-shared/uploads", library_nfs_version=version,
                        library_nfs_uid=65534, library_nfs_gid=65534,
                        library_nfs_reserved_port=True)

    def test_exact_41_configuration_loads_without_integer_validation_failure(self):
        with patch.object(library_nfs, "get_settings", return_value=self.settings()):
            configuration = library_nfs.configuration()
        self.assertEqual(configuration["version"], "4.1")
        self.assertEqual(configuration["host"], "192.0.2.224")
        self.assertEqual(configuration["export"], "/srv/soduwork-shared/uploads")
        self.assertTrue(configuration["reserved_port"])

    def test_legacy_integer_three_retains_existing_adapter_configuration(self):
        with patch.object(library_nfs, "get_settings", return_value=self.settings(3)):
            self.assertEqual(library_nfs.configuration()["version"], 3)

    def test_windows_status_keeps_local_available_and_explains_remote_platform(self):
        settings = self.settings().model_copy(update={"library_storage_backend": "local"})
        with patch.object(library_nfs, "get_settings", return_value=settings), \
             patch.object(library_storage, "get_settings", return_value=settings), \
             patch.object(library_storage, "_ensure_local_ready", return_value=True), \
             patch.object(library_storage, "_client", side_effect=AssertionError("MinIO fallback used")), \
             patch("app.services.library_nfs4.platform.system", return_value="Windows"):
            result = library_storage.status()
        self.assertEqual(result["default"], "local")
        self.assertTrue(result["local"]["available"])
        self.assertEqual(result["remoteBackend"], "nfs")
        self.assertTrue(result["remote"]["configured"])
        self.assertFalse(result["remote"]["available"])
        self.assertEqual(result["remote"]["code"], "LIBRARY_NFS_PLATFORM_UNSUPPORTED")
        self.assertIn("Linux", result["remote"]["message"])

    def test_v41_operations_use_v4_adapter_without_mountd_or_v3_fallback(self):
        driver = types.ModuleType("app.services.library_nfs4")
        driver.ensure_ready = Mock(return_value=True)
        driver.put_stream = Mock(return_value="nfs")
        driver.open_stream = Mock(return_value=io.BytesIO(b"content"))
        driver.delete = Mock()
        key = library_storage.object_key("version-test-user", "item")
        settings = self.settings()
        with patch.object(library_nfs, "get_settings", return_value=settings), \
             patch.object(library_nfs, "_new_connection", side_effect=AssertionError("v3 connection used")), \
             patch.dict(sys.modules, {"app.services.library_nfs4": driver}), \
             patch("app.services.library_nfs4", driver, create=True):
            self.assertTrue(library_nfs.ensure_ready())
            self.assertEqual(library_nfs.put_stream(key, io.BytesIO(b"content"), 7, "text/plain"), "nfs")
            with library_nfs.open_stream(key) as stream:
                self.assertEqual(stream.read(), b"content")
            library_nfs.delete(key)
        for operation in (driver.ensure_ready, driver.put_stream, driver.open_stream, driver.delete):
            operation.assert_called_once()
            config = operation.call_args.kwargs["config"]
            self.assertEqual(config["version"], "4.1")


if __name__ == "__main__":
    unittest.main()
