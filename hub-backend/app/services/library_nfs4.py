"""Linux NFSv4.1 object storage via nfs-rs 0.8.6 (Apache-2.0).

The pinned SDK uses NFS LOOKUP/OPEN without resolving symlinks. Explicit
component checks reject non-directory parents and non-regular objects. Paths
remain relative to the export; its Hub-owned namespace must not be writable by
untrusted external clients (the Python SDK has no handle-relative open API).
"""
from contextlib import contextmanager
import io
import os
import platform
import re
from uuid import uuid4

from .library_nfs import _error, _key_parts

CHUNK_SIZE = 65536


def _mapped(exc):
    from .library_storage import LibraryStorageError
    if isinstance(exc, (LibraryStorageError, FileNotFoundError)):
        return exc
    pending = [exc]
    for _ in range(16):
        if not pending:
            break
        current = pending.pop()
        outcome = getattr(current, "outcome", None)
        if getattr(outcome, "value", outcome) == "uncertain":
            return _error("OUTCOME_UNKNOWN", "NFS 操作结果尚未确认，请先核对文件状态再重试", False)
        children = getattr(current, "errors", ())
        if isinstance(children, (tuple, list)):
            pending.extend(children[:16])
    code = getattr(exc, "code", None)
    if isinstance(exc, PermissionError) or code in (1, 13, 30):
        return _error("ACCESS_DENIED", "NFS 拒绝访问，请检查导出权限、UID/GID 及保留源端口权限", False)
    if isinstance(exc, (IsADirectoryError, NotADirectoryError)) or code in (10029, 10083):
        return _error("UNSAFE_OBJECT", "NFS 对象不是普通文件或目录，拒绝跟随符号链接", False)
    if code == 10016:
        return _error("AUTH_UNSUPPORTED", "NFS 导出未允许 AUTH_SYS 认证，请检查导出认证配置", False)
    if code in (10004, 10021):
        return _error("PROTOCOL_UNSUPPORTED", "NFS 服务器未支持所配置的 NFSv4.1 协议", False)
    return _error()


def _connect(config):
    if platform.system() != "Linux" or platform.machine().lower() not in ("x86_64", "amd64"):
        raise _error("PLATFORM_UNSUPPORTED", "NFSv4.1 直连需要 Linux x86_64 Hub，当前系统不受支持", False)
    # nfs-rs parses the URL with Rust url::Url but does not percent-decode its
    # export path. Reject paths it would silently change instead of mounting a
    # different export; the configured /srv/soduwork-shared/uploads is supported.
    if not re.fullmatch(r"/[A-Za-z0-9._~/-]*", config["export"]):
        raise _error("NOT_CONFIGURED", "当前 NFSv4.1 客户端要求导出路径使用 ASCII 字母、数字或 /._~-", False)
    try:
        from nfs_rs import Client
    except (ImportError, OSError) as exc:
        raise _error("DEPENDENCY_MISSING", "NFSv4.1 客户端依赖不可用，请更新 Linux Hub 服务依赖", False) from exc
    host = config["host"]
    authority = f"[{host}]" if ":" in host else host
    try:
        return Client.connect(
            f"nfs://{authority}{config['export']}?version=4.1", versions=["4.1"],
            uid=config["uid"], gid=config["gid"], nfs_port=config["port"],
            noresvport=not config.get("reserved_port", True),
            connect_timeout=config["timeout"], operation_timeout=config["timeout"],
        )
    except ImportError as exc:
        # The native extension is loaded lazily inside Client.connect().
        # Network OSError must retain its normal transport error mapping.
        raise _error("DEPENDENCY_MISSING", "NFSv4.1 客户端依赖不可用，请更新 Linux Hub 服务依赖", False) from exc


def _close(resources, suppress=False):
    first_error = None
    for resource in resources:
        if resource is not None:
            try:
                resource.close()
            except Exception as exc:
                first_error = first_error or exc
    if first_error and not suppress:
        raise _mapped(first_error) from first_error


def _check_root(client, *, check_access=False):
    # nfs-rs 0.8.6 public stat/access normalize the root to '.', which its
    # NFSv4.1 LOOKUP sends as a name and the server rejects with BADNAME.
    # The contextual native proxy accepts '' for the mounted root handle.
    # Keep this pinned-SDK workaround root-only; object paths use public APIs.
    info = client._inner.stat("")
    if info.get("type") != "directory":
        raise _error("UNSAFE_OBJECT", "NFS 对象不是普通文件或目录，拒绝跟随符号链接", False)
    if check_access and not client._inner.access("", os.R_OK | os.W_OK | os.X_OK):
        raise _error("ACCESS_DENIED", "NFS 导出目录缺少资料读写权限，请检查 UID/GID", False)


@contextmanager
def _session(config, *, check_access=False):
    client, failed = None, False
    try:
        client = _connect(config)
        _check_root(client, check_access=check_access)
        yield client
    except BaseException as exc:
        failed = True
        if isinstance(exc, Exception):
            mapped = _mapped(exc)
            if mapped is not exc:
                raise mapped from exc
        raise
    finally:
        _close((client,), suppress=failed)


def _attributes(client, path, kind):
    info = client.stat(path)
    if info.type != kind:
        raise _error("UNSAFE_OBJECT", "NFS 对象不是普通文件或目录，拒绝跟随符号链接", False)
    return info


def _directory(client, parts, create=False):
    path = ""
    for component in parts:
        path = path + "/" + component if path else component
        try:
            _attributes(client, path, "directory")
        except FileNotFoundError:
            if not create:
                raise
            try:
                client.mkdir(path, mode=0o700)
            except FileExistsError:
                pass
            _attributes(client, path, "directory")
    return path


def _regular_or_missing(client, path):
    try:
        return _attributes(client, path, "file")
    except FileNotFoundError:
        return None


def _staging_directory(client, parent):
    # MKDIR is exclusive even though the SDK's file OPEN lacks an 'x' mode.
    for _ in range(3):
        path = parent + "/.soduwork-upload-" + uuid4().hex
        try:
            client.mkdir(path, mode=0o700)
        except FileExistsError:
            continue
        try:
            _attributes(client, path, "directory")
        except BaseException:
            try:
                client.rmdir(path)
            except Exception:
                pass
            raise
        return path
    raise _error("INCOMPLETE_UPLOAD", "无法创建 NFS 上传临时目录，请重试")


def ensure_ready(config):
    with _session(config, check_access=True):
        pass
    return True


def _write_file(client, path, handle, size):
    target, failed = None, False
    try:
        target = client.open(path, "wb")
        client.chmod(path, 0o600)
        _attributes(client, path, "file")
        handle.seek(0)
        offset = 0
        while offset < size:
            content = handle.read(min(CHUNK_SIZE, size - offset))
            if not isinstance(content, bytes) or not content or len(content) > min(CHUNK_SIZE, size - offset):
                raise _error("INCOMPLETE_UPLOAD", "上传内容与声明的文件大小不一致")
            position = 0
            while position < len(content):
                written = target.write(content[position:])
                if type(written) is not int or written <= 0 or written > len(content) - position:
                    raise _error("INCOMPLETE_UPLOAD", "NFS 未完整写入文件")
                position += written
                offset += written
        if handle.read(1):
            raise _error("INCOMPLETE_UPLOAD", "上传内容与声明的文件大小不一致")
        # nfs-rs write completes COMMIT for UNSTABLE replies; flush/close must
        # also succeed before the final name can become visible.
        target.flush()
    except BaseException:
        failed = True
        raise
    finally:
        _close((target,), suppress=failed)


def put_stream(key, handle, size, content_type, config):
    parts = _key_parts(key)
    if type(size) is not int or size < 0:
        raise _error("INVALID_SIZE", "资料大小无效", False)
    with _session(config) as client:
        parent = _directory(client, parts[:-1], create=True)
        path = "/".join(parts)
        _regular_or_missing(client, path)
        staging = _staging_directory(client, parent)
        temporary = staging + "/object"
        try:
            _write_file(client, temporary, handle, size)
            if _attributes(client, temporary, "file").size != size:
                raise _error("INCOMPLETE_UPLOAD", "NFS 写入文件大小不一致")
            _directory(client, parts[:-1])
            _regular_or_missing(client, path)
            client.rename(temporary, path)
        finally:
            # Never remove the final name: a timed-out RENAME may have applied.
            try:
                client.unlink(temporary)
            except Exception:
                pass
            try:
                client.rmdir(staging)
            except Exception:
                pass
    return "nfs"


class Nfs4Stream(io.RawIOBase):
    def __init__(self, client, handle, size):
        super().__init__()
        self.client, self.handle = client, handle
        self.size, self.offset = size, 0

    def readable(self):
        return True

    def read(self, size=-1):
        if self.closed:
            raise ValueError("I/O operation on closed NFS stream")
        remaining = self.size - self.offset if size is None or size < 0 else min(size, self.size - self.offset)
        result = bytearray()
        try:
            while remaining > 0:
                count = min(CHUNK_SIZE, remaining)
                data = self.handle.read(count)
                if not isinstance(data, bytes) or not data or len(data) > count:
                    raise _error("INCOMPLETE_READ", "NFS 文件读取不完整，请重新下载")
                result.extend(data)
                self.offset += len(data)
                remaining -= len(data)
            return bytes(result)
        except BaseException as exc:
            self._finish(suppress=True)
            if isinstance(exc, Exception):
                mapped = _mapped(exc)
                if mapped is not exc:
                    raise mapped from exc
            raise

    def _finish(self, suppress=False):
        if not self.closed:
            try:
                _close((self.handle, self.client), suppress=suppress)
            finally:
                super().close()

    def close(self):
        self._finish()


def open_stream(key, config):
    parts = _key_parts(key)
    client, handle = None, None
    try:
        client = _connect(config)
        _check_root(client)
        _directory(client, parts[:-1])
        path = "/".join(parts)
        info = _attributes(client, path, "file")
        if type(info.size) is not int or info.size < 0:
            raise _error("INCOMPLETE_READ", "NFS 文件大小无效")
        handle = client.open(path, "rb")
        return Nfs4Stream(client, handle, info.size)
    except BaseException as exc:
        _close((handle, client), suppress=True)
        if isinstance(exc, Exception):
            mapped = _mapped(exc)
            if mapped is not exc:
                raise mapped from exc
        raise


def delete(key, config):
    parts = _key_parts(key)
    try:
        with _session(config) as client:
            _directory(client, parts[:-1])
            path = "/".join(parts)
            _attributes(client, path, "file")
            client.unlink(path)
    except FileNotFoundError:
        pass
