"""NFSv4.1 adapter contract tests with an isolated SDK fake, not a live NFS server."""
import importlib
import io
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services.library_storage import LibraryStorageError

KEY = "library/users/" + "a" * 64 + "/item/object"
CONFIG = dict(host="192.0.2.224", port=2049, export="/srv/soduwork-shared/uploads",
              version="4.1", uid=65534, gid=65534, timeout=10, reserved_port=True)


class UncertainError(RuntimeError):
    outcome = "uncertain"


class BadNameError(RuntimeError):
    code = 10041


class SdkRoot:
    """nfs-rs 0.8.6 native root calls bypass public '.' normalization."""
    def __init__(self, client):
        self.client = client

    def stat(self, path):
        if path != "":
            raise AssertionError("native compatibility is limited to the export root")
        self.client.sdk.calls.append(("root_stat", path))
        node = self.client.sdk.nodes["."]
        return {"type": node["type"], "size": len(node.get("data", b""))}

    def access(self, path, mode):
        if path != "":
            raise AssertionError("native compatibility is limited to the export root")
        self.client.sdk.calls.append(("root_access", path, mode))
        return self.client.sdk.access_allowed


class SdkFile:
    def __init__(self, client, path):
        self.client, self.path, self.offset, self.closed = client, path, 0, False

    def read(self, size):
        if self.client.sdk.read_error:
            raise self.client.sdk.read_error
        size = min(size, self.client.sdk.read_chunk)
        data = bytes(self.client.sdk.nodes[self.path]["data"][self.offset:self.offset + size])
        self.offset += len(data)
        return data

    def write(self, data):
        if self.client.sdk.write_error:
            raise self.client.sdk.write_error
        count = min(len(data), self.client.sdk.write_chunk)
        self.client.sdk.nodes[self.path]["data"].extend(data[:count])
        self.offset += count
        return count

    def flush(self):
        if self.client.sdk.flush_error:
            raise self.client.sdk.flush_error

    def close(self):
        self.closed = True
        if self.client.sdk.file_close_error:
            raise self.client.sdk.file_close_error


class SdkClient:
    def __init__(self, sdk):
        self.sdk, self.closed = sdk, False
        self.files = []
        self._inner = SdkRoot(self)

    def stat(self, path):
        self.sdk.calls.append(("stat", path))
        if path in ("", "/", "."):
            raise BadNameError("NFS4ERR_BADNAME: LOOKUP '.'")
        if path not in self.sdk.nodes:
            raise FileNotFoundError(path)
        node = self.sdk.nodes[path]
        return SimpleNamespace(type=node["type"], size=len(node.get("data", b"")))

    def access(self, path, mode):
        self.sdk.calls.append(("access", path, mode))
        if path in ("", "/", "."):
            raise BadNameError("NFS4ERR_BADNAME: LOOKUP '.'")
        return self.sdk.access_allowed

    def mkdir(self, path, mode=0o777, *, parents=False, exist_ok=False):
        self.sdk.calls.append(("mkdir", path, mode))
        if path in self.sdk.nodes:
            raise FileExistsError(path)
        self.sdk.nodes[path] = {"type": "directory", "mode": mode}

    def chmod(self, path, mode):
        self.sdk.nodes[path]["mode"] = mode

    def open(self, path, mode):
        self.sdk.calls.append(("open", path, mode))
        if mode == "wb":
            self.sdk.nodes[path] = {"type": "file", "data": bytearray(), "mode": 0o666}
        elif path not in self.sdk.nodes:
            raise FileNotFoundError(path)
        result = SdkFile(self, path)
        self.files.append(result)
        return result

    def rename(self, source, destination):
        self.sdk.calls.append(("rename", source, destination))
        if self.sdk.rename_error:
            raise self.sdk.rename_error
        self.sdk.nodes[destination] = self.sdk.nodes.pop(source)

    def unlink(self, path):
        self.sdk.calls.append(("unlink", path))
        if path not in self.sdk.nodes:
            raise FileNotFoundError(path)
        del self.sdk.nodes[path]

    def rmdir(self, path):
        self.sdk.calls.append(("rmdir", path))
        if any(p.startswith(path + "/") for p in self.sdk.nodes):
            raise OSError("directory is not empty")
        del self.sdk.nodes[path]

    def close(self):
        self.closed = True
        if self.sdk.client_close_error:
            raise self.sdk.client_close_error


class Sdk:
    def __init__(self):
        self.Client = SimpleNamespace(connect=self.connect)
        self.nodes = {".": {"type": "directory"}}
        self.clients, self.calls, self.connections = [], [], []
        self.access_allowed = True
        self.read_chunk, self.write_chunk = 17011, 2399
        self.read_error = self.write_error = self.flush_error = self.rename_error = None
        self.file_close_error = self.client_close_error = self.connect_error = None

    def connect(self, url, **options):
        self.connections.append((url, options))
        if self.connect_error:
            raise self.connect_error
        client = SdkClient(self)
        self.clients.append(client)
        return client


class LibraryNfs4Tests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec("app.services.library_nfs4"),
                             "NFSv4.1 adapter must exist")
        self.driver = importlib.import_module("app.services.library_nfs4")
        self.sdk = Sdk()
        self.addCleanup(patch.stopall)
        patch.dict("sys.modules", {"nfs_rs": self.sdk}).start()
        patch.object(self.driver.platform, "system", return_value="Linux").start()
        patch.object(self.driver.platform, "machine", return_value="x86_64").start()

    def put(self, data=b"hello nfs4"):
        return self.driver.put_stream(KEY, io.BytesIO(data), len(data), "text/plain", CONFIG)

    def assert_closed(self):
        self.assertTrue(self.sdk.clients)
        self.assertTrue(all(c.closed and all(f.closed for f in c.files) for c in self.sdk.clients))

    def assert_no_staging(self):
        self.assertFalse(any(".soduwork-upload-" in path for path in self.sdk.nodes))

    def test_binary_round_trip_partial_io_atomic_replacement_and_connection_options(self):
        content = bytes(range(256)) * 1024
        self.assertEqual(self.put(content), "nfs")
        self.assertEqual(self.sdk.nodes[KEY]["mode"], 0o600)
        with self.driver.open_stream(KEY, CONFIG) as stream:
            self.assertEqual(stream.read(50003), content[:50003])
            self.assertEqual(stream.read(), content[50003:])
            self.assertEqual(stream.read(1), b"")
        url, options = self.sdk.connections[0]
        self.assertEqual(url, "nfs://192.0.2.224/srv/soduwork-shared/uploads?version=4.1")
        self.assertEqual(options, dict(versions=["4.1"], uid=65534, gid=65534, nfs_port=2049,
                                      noresvport=False, connect_timeout=10, operation_timeout=10))
        self.put(b"replacement")
        self.assertEqual(bytes(self.sdk.nodes[KEY]["data"]), b"replacement")
        self.assert_no_staging()
        self.assert_closed()

    def test_empty_file_and_idempotent_delete(self):
        self.put(b"")
        with self.driver.open_stream(KEY, CONFIG) as stream:
            self.assertEqual(stream.read(), b"")
        self.driver.delete(KEY, CONFIG)
        self.driver.delete(KEY, CONFIG)
        self.assertNotIn(KEY, self.sdk.nodes)
        with self.assertRaises(FileNotFoundError):
            self.driver.open_stream(KEY, CONFIG)
        self.assert_closed()

    def test_health_uses_native_root_without_mutating_export(self):
        self.assertTrue(self.driver.ensure_ready(CONFIG))
        self.assertEqual(self.sdk.calls, [("root_stat", ""), ("root_access", "", 7)])
        self.assertEqual(self.sdk.nodes, {".": {"type": "directory"}})
        self.assert_closed()

    def test_health_rejects_root_without_read_write_search_access(self):
        self.sdk.access_allowed = False
        with self.assertRaises(LibraryStorageError) as denied:
            self.driver.ensure_ready(CONFIG)
        self.assertEqual(denied.exception.code, "LIBRARY_NFS_ACCESS_DENIED")
        self.assertFalse(denied.exception.retryable)
        self.assertEqual(self.sdk.calls, [("root_stat", ""), ("root_access", "", 7)])
        self.assert_closed()

    def test_health_rejects_non_directory_root_before_access(self):
        for kind in ("file", "symlink", "fifo"):
            self.sdk.nodes["."]["type"] = kind
            self.sdk.calls.clear()
            with self.subTest(kind=kind), self.assertRaises(LibraryStorageError) as unsafe:
                self.driver.ensure_ready(CONFIG)
            self.assertEqual(unsafe.exception.code, "LIBRARY_NFS_UNSAFE_OBJECT")
            self.assertFalse(unsafe.exception.retryable)
            self.assertEqual(self.sdk.calls, [("root_stat", "")])
        self.assert_closed()

    def test_unsupported_windows_or_arch_does_not_import_or_connect_sdk(self):
        for system, machine in (("Windows", "AMD64"), ("Linux", "aarch64")):
            with patch.object(self.driver.platform, "system", return_value=system), \
                 patch.object(self.driver.platform, "machine", return_value=machine):
                with self.assertRaises(LibraryStorageError) as unsupported:
                    self.driver.ensure_ready(CONFIG)
                self.assertEqual(unsupported.exception.code, "LIBRARY_NFS_PLATFORM_UNSUPPORTED")
                self.assertFalse(unsupported.exception.retryable)
        self.assertFalse(self.sdk.connections)

    def test_traversal_and_invalid_size_rejected_before_connection(self):
        for key in ("../outside", KEY + "/../escape", KEY.replace("/item/", "/./"), KEY + "\\other"):
            with self.subTest(key=key), self.assertRaises(LibraryStorageError):
                self.driver.put_stream(key, io.BytesIO(), 0, "text/plain", CONFIG)
        for size in (-1, True, "1"):
            with self.assertRaises(LibraryStorageError):
                self.driver.put_stream(KEY, io.BytesIO(), size, "text/plain", CONFIG)
        self.assertFalse(self.sdk.connections)

    def test_links_and_special_files_never_opened_or_deleted(self):
        self.put()
        for path in (".", "library", KEY.rsplit("/", 1)[0], KEY):
            node = self.sdk.nodes[path]
            for kind in ("symlink", "fifo"):
                old_type, node["type"] = node["type"], kind
                for operation in (lambda: self.driver.open_stream(KEY, CONFIG),
                                  lambda: self.driver.delete(KEY, CONFIG), lambda: self.put()):
                    self.sdk.calls.clear()
                    with self.assertRaises(LibraryStorageError) as unsafe:
                        operation()
                    self.assertEqual(unsafe.exception.code, "LIBRARY_NFS_UNSAFE_OBJECT")
                    self.assertFalse(any(c[0] in {"open", "rename", "unlink"} for c in self.sdk.calls))
                node["type"] = old_type
        self.assert_closed()

    def test_failed_upload_preserves_previous_target_and_cleans_temporary_files(self):
        self.put(b"previous")
        for error in (PermissionError("secret export path"), TimeoutError("server details")):
            self.sdk.write_error = error
            with self.assertRaises(LibraryStorageError) as failed:
                self.put(b"new")
            self.assertNotIn("secret", failed.exception.message)
            self.assertEqual(bytes(self.sdk.nodes[KEY]["data"]), b"previous")
            self.assert_no_staging()
        self.assert_closed()

    def test_declared_length_mismatch_and_zero_writes_fail_without_publication(self):
        for content, declared in ((b"short", 10), (b"long", 2)):
            with self.assertRaises(LibraryStorageError):
                self.driver.put_stream(KEY, io.BytesIO(content), declared, "text/plain", CONFIG)
            self.assertNotIn(KEY, self.sdk.nodes)
            self.assert_no_staging()
        self.sdk.write_chunk = 0
        with self.assertRaises(LibraryStorageError):
            self.put()
        self.assert_no_staging()
        self.assert_closed()

    def test_uncertain_rename_is_not_retried_and_errors_are_safe(self):
        self.sdk.rename_error = UncertainError("sensitive server response")
        with self.assertRaises(LibraryStorageError) as failure:
            self.put()
        self.assertEqual(failure.exception.code, "LIBRARY_NFS_OUTCOME_UNKNOWN")
        self.assertFalse(failure.exception.retryable)
        self.assertEqual(sum(c[0] == "rename" for c in self.sdk.calls), 1)
        self.assert_no_staging()
        self.assert_closed()

    def test_truncated_read_and_read_failure_close_all_resources(self):
        self.put()
        stream = self.driver.open_stream(KEY, CONFIG)
        self.sdk.nodes[KEY]["data"] = bytearray(b"x")
        with self.assertRaises(LibraryStorageError) as failure:
            stream.read()
        self.assertEqual(failure.exception.code, "LIBRARY_NFS_INCOMPLETE_READ")
        self.assertTrue(stream.closed)
        self.put()
        stream = self.driver.open_stream(KEY, CONFIG)
        self.sdk.read_error = TimeoutError("private details")
        with self.assertRaises(LibraryStorageError):
            stream.read()
        self.assertTrue(stream.closed)
        self.assert_closed()

    def test_flush_or_file_close_failure_does_not_publish_and_client_still_closes(self):
        for field in ("flush_error", "file_close_error"):
            setattr(self.sdk, field, TimeoutError("failed durability or close"))
            with self.assertRaises(LibraryStorageError):
                self.put()
            self.assertNotIn(KEY, self.sdk.nodes)
            self.assert_no_staging()
            setattr(self.sdk, field, None)
        self.assert_closed()

    def test_connection_permissions_are_actionable_and_dependency_is_lazy(self):
        self.sdk.connect_error = PermissionError("bind denied")
        with self.assertRaises(LibraryStorageError) as denied:
            self.driver.ensure_ready(CONFIG)
        self.assertEqual(denied.exception.code, "LIBRARY_NFS_ACCESS_DENIED")
        with patch.dict("sys.modules", {"nfs_rs": None}):
            with self.assertRaises(LibraryStorageError) as missing:
                self.driver.ensure_ready(CONFIG)
            self.assertEqual(missing.exception.code, "LIBRARY_NFS_DEPENDENCY_MISSING")

    def test_lazy_native_extension_import_failure_is_a_non_retryable_dependency_error(self):
        self.sdk.connect_error = ImportError("nfs_rs._internal native ABI details")
        with self.assertRaises(LibraryStorageError) as missing:
            self.driver.ensure_ready(CONFIG)
        self.assertEqual(missing.exception.code, "LIBRARY_NFS_DEPENDENCY_MISSING")
        self.assertFalse(missing.exception.retryable)
        self.assertNotIn("ABI", missing.exception.message)

    def test_network_oserror_during_connect_is_not_misclassified_as_dependency_failure(self):
        self.sdk.connect_error = OSError("network transport details")
        with self.assertRaises(LibraryStorageError) as network:
            self.driver.ensure_ready(CONFIG)
        self.assertEqual(network.exception.code, "LIBRARY_NFS_UNAVAILABLE")
        self.assertTrue(network.exception.retryable)
        self.assertNotIn("transport", network.exception.message)

    def test_ipv6_non_reserved_source_port_and_unsafe_export_url_characters(self):
        config = dict(CONFIG, host="2001:db8::1", reserved_port=False, port=12049)
        self.driver.ensure_ready(config)
        url, options = self.sdk.connections[0]
        self.assertEqual(url, "nfs://[2001:db8::1]/srv/soduwork-shared/uploads?version=4.1")
        self.assertTrue(options["noresvport"])
        self.assertEqual(options["nfs_port"], 12049)
        for export in ("/space here", "/%2e%2e", "/uploads?version=3", "/资料"):
            with self.subTest(export=export), self.assertRaises(LibraryStorageError) as invalid:
                self.driver.ensure_ready(dict(CONFIG, export=export))
            self.assertEqual(invalid.exception.code, "LIBRARY_NFS_NOT_CONFIGURED")
        self.assertEqual(len(self.sdk.connections), 1)

    def test_staging_collision_is_bounded_and_existing_directory_is_untouched(self):
        parent = KEY.rsplit("/", 1)[0]
        existing = parent + "/.soduwork-upload-collision"
        self.sdk.nodes[existing] = {"type": "directory"}
        self.sdk.nodes[existing + "/object"] = {"type": "file", "data": bytearray(b"keep")}
        with patch.object(self.driver, "uuid4", return_value=SimpleNamespace(hex="collision")):
            with self.assertRaises(LibraryStorageError):
                self.put()
        self.assertEqual(self.sdk.nodes[existing + "/object"]["data"], bytearray(b"keep"))
        self.assertEqual(sum(c[0] == "mkdir" and c[1] == existing for c in self.sdk.calls), 3)
        self.assertNotIn(KEY, self.sdk.nodes)
        self.assert_closed()

    def test_new_staging_directory_is_cleaned_when_its_stat_fails(self):
        original_stat = SdkClient.stat

        def failing_stat(client, path):
            if "/.soduwork-upload-" in path:
                raise PermissionError("GETATTR denied after MKDIR")
            return original_stat(client, path)

        with patch.object(SdkClient, "stat", failing_stat):
            with self.assertRaises(LibraryStorageError):
                self.put()
        self.assert_no_staging()
        self.assert_closed()

    def test_stream_close_releases_client_even_when_file_close_fails(self):
        self.put()
        stream = self.driver.open_stream(KEY, CONFIG)
        self.sdk.file_close_error = TimeoutError("close failed")
        with self.assertRaises(LibraryStorageError):
            stream.close()
        self.assertTrue(stream.closed)
        self.assert_closed()
        stream.close()

    def test_wrapped_uncertain_error_preserves_non_retryable_outcome(self):
        wrapped = RuntimeError("client close wrapped multiple SDK failures")
        wrapped.errors = (UncertainError("mutation outcome unknown"),)
        self.sdk.client_close_error = wrapped
        with self.assertRaises(LibraryStorageError) as failure:
            self.driver.ensure_ready(CONFIG)
        self.assertEqual(failure.exception.code, "LIBRARY_NFS_OUTCOME_UNKNOWN")
        self.assertFalse(failure.exception.retryable)

    def test_native_protocol_errors_are_translated_without_leaking_server_response(self):
        for code, expected in ((10029, "UNSAFE_OBJECT"), (10083, "UNSAFE_OBJECT"),
                               (10016, "AUTH_UNSUPPORTED"), (10021, "PROTOCOL_UNSUPPORTED"),
                               (13, "ACCESS_DENIED")):
            error = RuntimeError("sensitive server response")
            error.code = code
            self.sdk.connect_error = error
            with self.subTest(code=code), self.assertRaises(LibraryStorageError) as failure:
                self.driver.ensure_ready(CONFIG)
            self.assertEqual(failure.exception.code, "LIBRARY_NFS_" + expected)
            self.assertFalse(failure.exception.retryable)
            self.assertNotIn("sensitive", failure.exception.message)


if __name__ == "__main__":
    unittest.main()
