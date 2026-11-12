"""SoduWork-managed Agent runtimes.

OpenCode is distributed as an official native executable. Installing it through
npm global mode made every employee machine depend on Node, global directory
permissions, registry reachability and PATH refreshes. This module instead pins
an audited upstream release, installs it below the Runner data directory and only
activates a version after checksum and executable probes pass.

OpenCode is optional and is never installed by discovery or client startup.
Only an explicit install/update action activates a per-Runner installation;
locally installed global executables remain discoverable by local_base.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path
from typing import Callable

from .local_base import _data_root
from . import managed_agent_network


OPENCODE_VERSION = "1.18.18"
_RELEASE_BASE = (
    "https://github.com/anomalyco/opencode/releases/download/v" + OPENCODE_VERSION
)
_MAX_ARCHIVE_BYTES = 150 * 1024 * 1024
_INSTALL_LOCK = threading.RLock()


def _release_bases() -> list[str]:
    """Try download sources in order: an explicit mirror, the connected Hub, then official GitHub releases.
    
    The Hub provides a fallback for runners without direct GitHub access. runner_main derives
    SODUWORK_HUB_HTTP_BASE from --hub at startup. Changing the transport does not change integrity checks:
    OPENCODE_ARTIFACTS still pins the required SHA-256 digest.
    """
    bases: list[str] = []
    explicit = str(os.environ.get("SODUWORK_OPENCODE_RELEASE_BASE") or "").strip().rstrip("/")
    if explicit:
        bases.append(explicit)
    hub = str(os.environ.get("SODUWORK_HUB_HTTP_BASE") or "").strip().rstrip("/")
    if hub:
        bases.append(hub + "/api/v1/download/opencode")
    bases.append(_RELEASE_BASE)
    seen: set[str] = set()
    return [b for b in bases if not (b in seen or seen.add(b))]

# Official immutable release assets from anomalyco/opencode v1.18.18.
# An enterprise mirror may replace only the base URL; it cannot replace the
# expected digest.
OPENCODE_ARTIFACTS: dict[str, tuple[str, str]] = {
    "windows-arm64": (
        "opencode-windows-arm64.zip",
        "0d34d837ea3b5e10349d8550318083040a8b4c061d3faaa4eabd339984aa49b0",
    ),
    "windows-x64": (
        "opencode-windows-x64.zip",
        "c6d265376fdb93164013671b0cf402410184f73c34fc15d82d40a16a745b15f4",
    ),
    "windows-x64-baseline": (
        "opencode-windows-x64-baseline.zip",
        "66ad3d31bdc48d7cf16e212da21449bdfe34656cf83a56f682a211c8b78d30ba",
    ),
    "linux-arm64": (
        "opencode-linux-arm64.tar.gz",
        "dcb1b5ec5687b43f87749560021f9203f3809e0ce5ae44ff9be8ae17083fe4ba",
    ),
    "linux-arm64-musl": (
        "opencode-linux-arm64-musl.tar.gz",
        "38a7504dab35007c70d2cdf89870b4be63faa60667318a90338798d34f53eab1",
    ),
    "linux-x64": (
        "opencode-linux-x64.tar.gz",
        "0cddc222418b8553669905a8980c0cda7088f00da24d83d6ac76b01c9fdb2aaf",
    ),
    "linux-x64-baseline": (
        "opencode-linux-x64-baseline.tar.gz",
        "05914655854c1dab48f0d52a8af8f74967e4e26daf87dfe6534f57e799a853d7",
    ),
    "linux-x64-musl": (
        "opencode-linux-x64-musl.tar.gz",
        "60279c62d2182aa4279cea4d5a84d23437f8074042cbbed4a2bfa70e5acbd193",
    ),
    "linux-x64-baseline-musl": (
        "opencode-linux-x64-baseline-musl.tar.gz",
        "f5fe814ac3f94daa4374b7e882b9f0dabe492f63e6b3bbbe7d1e23c95c149a2b",
    ),
    "darwin-arm64": (
        "opencode-darwin-arm64.zip",
        "7d668bf26496fec8686d4e51ebb1ac2bd2e393f0c1620aa696c4c242a9e5806a",
    ),
    "darwin-x64": (
        "opencode-darwin-x64.zip",
        "9581bd7683a7528456179fb11e3377d9ef568e10a935611a2c6722e349454d83",
    ),
    "darwin-x64-baseline": (
        "opencode-darwin-x64-baseline.zip",
        "c029941795f9cf55cfdbc5b0e105db4300413718d489e8e47c950d1a2e126eed",
    ),
}


def _root() -> Path:
    return Path(_data_root()) / "agents" / "opencode"


def _active_file() -> Path:
    return _root() / "active.json"


def _binary_name() -> str:
    return "opencode.exe" if os.name == "nt" else "opencode"


def _read_active() -> str:
    try:
        raw = json.loads(_active_file().read_text(encoding="utf-8"))
        version = str(raw.get("version") or "")
        valid = version and all(c.isalnum() or c in ".+-" for c in version)
        return version if valid else ""
    except (OSError, ValueError):
        return ""


def managed_binary() -> str:
    version = _read_active()
    path = _root() / version / _binary_name() if version else Path()
    return str(path) if version and path.is_file() else ""


def opencode_binary() -> str:
    return managed_binary()


def runtime_issue() -> str:
    """Read-only readiness for managed installs; global CLIs keep their contract."""
    if issue := _cpu_compatibility_issue():
        return issue
    binary = managed_binary()
    if not binary:
        return ""
    from .opencode_dependencies import issue
    return issue(str(_root().parent.parent), Path(binary).parent.name)


def _prepare_dependencies(binary: str, say: Callable[[str], None]):
    from .opencode_dependencies import transaction
    return transaction(binary, OPENCODE_VERSION, str(_root().parent.parent), say)


def _atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".next-" + uuid.uuid4().hex[:8])
    try:
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, path)
    finally:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass


def _linux_cpu_flags() -> list[set[str]]:
    """Read exact per-processor flags; empty records preserve unknown CPUs."""
    try:
        cpuinfo = Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="ignore").lower()
    except OSError:
        return []
    processors = 0
    capabilities: list[set[str]] = []
    for line in cpuinfo.splitlines():
        if re.fullmatch(r"[ \t]*processor[ \t]*:[ \t]*\d+[ \t]*", line):
            processors += 1
        # Parse one line at a time: whitespace after an empty flags field must
        # never consume a model name or another processor's field.
        match = re.fullmatch(r"[ \t]*flags[ \t]*:[ \t]*(.*)", line)
        if match is not None:
            capabilities.append(set(match.group(1).split()))
    capabilities.extend(set() for _ in range(max(0, processors - len(capabilities))))
    return capabilities


def _has_avx2() -> bool:
    if platform.machine().lower() not in {"amd64", "x86_64", "x64"}:
        return True
    try:
        if os.name == "nt":
            # PF_AVX2_INSTRUCTIONS_AVAILABLE
            return bool(ctypes.windll.kernel32.IsProcessorFeaturePresent(40))
        if sys.platform == "darwin":
            result = subprocess.run(
                ["sysctl", "-n", "hw.optional.avx2_0"], capture_output=True,
                text=True, timeout=5, check=False,
            )
            return result.stdout.strip() == "1"
        capabilities = _linux_cpu_flags()
        return bool(capabilities) and all({"avx", "avx2"}.issubset(flags) for flags in capabilities)
    except Exception:  # noqa: BLE001 - baseline is the safe fallback
        return False


def _is_musl() -> bool:
    if sys.platform != "linux":
        return False
    if Path("/etc/alpine-release").is_file():
        return True
    try:
        done = subprocess.run(
            ["ldd", "--version"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", timeout=5, check=False,
        )
        return "musl" in str(done.stdout or "").lower()
    except Exception:  # noqa: BLE001
        return False


def platform_key() -> str:
    system = {"windows": "windows", "linux": "linux", "darwin": "darwin"}.get(
        platform.system().lower(), "")
    machine = platform.machine().lower()
    arch = "arm64" if machine in {"arm64", "aarch64"} else (
        "x64" if machine in {"amd64", "x86_64", "x64"} else "")
    if not system or not arch:
        raise RuntimeError("OpenCode \u6682\u4e0d\u652f\u6301\u8fd9\u53f0\u673a\u5668\u7684\u7cfb\u7edf\u6216\u67b6\u6784\u3002")
    parts = [system, arch]
    if arch == "x64" and not _has_avx2():
        parts.append("baseline")
    if system == "linux" and _is_musl():
        parts.append("musl")
    key = "-".join(parts)
    if key not in OPENCODE_ARTIFACTS:
        raise RuntimeError("OpenCode \u6ca1\u6709\u9002\u914d\u5f53\u524d\u5e73\u53f0\uff1a" + key)
    return key


def _cpu_compatibility_issue() -> str:
    """Return a clear reason before starting an incompatible native binary.

    OpenCode 1.18.18 uses Bun 1.3.14, whose x64 baseline requires SSE4.2.
    https://github.com/oven-sh/bun/blob/bun-v1.3.14/docs/installation.mdx#cpu-requirements
    Reject known missing instructions before probing, avoiding SIGILL and
    repeated core dumps on older or restricted virtual CPUs.
    """
    if sys.platform != "linux" or platform.machine().lower() not in {"amd64", "x86_64", "x64"}:
        return ""
    capabilities = _linux_cpu_flags()
    # Unknown records select the baseline artifact but are not proof of a
    # missing instruction. Every known processor must satisfy the baseline.
    missing = [label for flag, label in (("ssse3", "SSSE3"), ("sse4_2", "SSE4.2"))
               if any(flags and flag not in flags for flags in capabilities)]
    if missing:
        return ("所选 Linux 执行机的 CPU 缺少 " + "、".join(missing)
                + " 指令集，无法运行 OpenCode。请选择兼容的执行机，或由管理员调整该虚拟机的 CPU 配置。")
    return ""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _download(url: str, target: Path, expected: str,
              say: Callable[[str], None]) -> None:
    if target.is_file() and _sha256(target) == expected:
        say("\u5b89\u88c5\u5305\u5df2\u4e0b\u8f7d\u5e76\u901a\u8fc7\u5b8c\u6574\u6027\u6821\u9a8c")
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + ".part")
    last_error = ""
    for attempt in range(1, 4):
        try:
            offset = partial.stat().st_size if partial.is_file() else 0
            headers = {"User-Agent": "SoduWork-Agent-Runtime/1"}
            if offset:
                headers["Range"] = "bytes=%d-" % offset
            request = urllib.request.Request(url, headers=headers)
            with managed_agent_network.open_download(request, timeout=45) as response:
                append = bool(offset and getattr(response, "status", 200) == 206)
                if not append:
                    offset = 0
                length = int(response.headers.get("Content-Length") or 0)
                total = offset + length if length else 0
                if total and total > _MAX_ARCHIVE_BYTES:
                    raise RuntimeError("\u4e0b\u8f7d\u6587\u4ef6\u8d85\u8fc7\u5b89\u5168\u5927\u5c0f\u9650\u5236")
                mode = "ab" if append else "wb"
                received, next_notice = offset, 10
                with partial.open(mode) as stream:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        received += len(chunk)
                        if received > _MAX_ARCHIVE_BYTES:
                            raise RuntimeError("\u4e0b\u8f7d\u5185\u5bb9\u8d85\u8fc7\u5b89\u5168\u5927\u5c0f\u9650\u5236")
                        stream.write(chunk)
                        if total:
                            percent = int(received * 100 / total)
                            if percent >= next_notice:
                                say("\u4e0b\u8f7d\u8fdb\u5ea6 %d%%" % min(percent, 100))
                                next_notice = (percent // 10 + 1) * 10
            if _sha256(partial) != expected:
                partial.unlink(missing_ok=True)
                raise RuntimeError("\u5b89\u88c5\u5305 SHA-256 \u6821\u9a8c\u5931\u8d25")
            os.replace(partial, target)
            return
        except (OSError, ValueError, urllib.error.URLError, RuntimeError) as exc:
            last_error = managed_agent_network.error_label(exc)
            missing = isinstance(exc, urllib.error.HTTPError) and exc.code in {404, 410}
            if isinstance(exc, urllib.error.HTTPError):
                exc.close()
            retry = not missing and attempt < 3
            say("第 %d 次下载失败：%s%s" % (
                attempt, last_error, "，准备重试" if retry else ""))
            if not retry:
                break
            time.sleep(min(attempt * 2, 5))
    raise RuntimeError("OpenCode \u4e0b\u8f7d\u5931\u8d25\uff1a" + (last_error or "\u7f51\u7edc\u9519\u8bef"))


def _extract_binary(archive: Path, target: Path) -> None:
    wanted = _binary_name().lower()
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as package:
            matches = [item for item in package.infolist()
                       if not item.is_dir() and Path(item.filename).name.lower() == wanted]
            if len(matches) != 1:
                raise RuntimeError("\u5b89\u88c5\u5305\u4e2d\u6ca1\u6709\u627e\u5230\u552f\u4e00\u7684 OpenCode \u53ef\u6267\u884c\u6587\u4ef6")
            with package.open(matches[0]) as reader, target.open("wb") as writer:
                shutil.copyfileobj(reader, writer)
    else:
        with tarfile.open(archive, "r:gz") as package:
            matches = [item for item in package.getmembers()
                       if item.isfile() and Path(item.name).name.lower() == wanted]
            if len(matches) != 1:
                raise RuntimeError("\u5b89\u88c5\u5305\u4e2d\u6ca1\u6709\u627e\u5230\u552f\u4e00\u7684 OpenCode \u53ef\u6267\u884c\u6587\u4ef6")
            source = package.extractfile(matches[0])
            if source is None:
                raise RuntimeError("\u65e0\u6cd5\u8bfb\u53d6\u5b89\u88c5\u5305\u4e2d\u7684\u7a0b\u5e8f")
            with source, target.open("wb") as writer:
                shutil.copyfileobj(source, writer)
    if not target.is_file() or target.stat().st_size < 1024 * 1024:
        raise RuntimeError("\u89e3\u538b\u51fa\u7684 OpenCode \u6587\u4ef6\u4e0d\u5b8c\u6574")
    try:
        target.chmod(0o755)
    except OSError:
        pass


def binary_version(path: str, timeout: int = 20) -> str:
    if not path or not os.path.isfile(path) or _cpu_compatibility_issue():
        return ""
    try:
        done = subprocess.run(
            [path, "--version"], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", timeout=timeout,
            check=False,
            **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}),
        )
        text = str(done.stdout or "").strip()
        return (text.splitlines() or [""])[0].strip()[:80] if done.returncode == 0 else ""
    except Exception:  # noqa: BLE001
        return ""


def _activate(version: str) -> None:
    _atomic_json(_active_file(), {
        "schemaVersion": 1, "version": version, "updatedAt": int(time.time()),
    })


def _remove_managed() -> tuple[bool, str]:
    active = _read_active()
    try:
        _active_file().unlink(missing_ok=True)
        if active:
            shutil.rmtree(_root() / active, ignore_errors=False)
        return True, "SoduWork 管理的 OpenCode 已移除；系统中独立安装的版本未受影响。"
    except OSError as exc:
        return False, "OpenCode \u79fb\u9664\u5931\u8d25\uff1a" + str(exc)[:140]


def install(action: str, say: Callable[[str], None]) -> tuple[bool, str]:
    """Install/check/remove the pinned runtime; never touch a global package."""
    # Both setup cards share this runtime. Do not replace it while the other
    # card is preparing dependencies or changing the active version.
    with _INSTALL_LOCK:
        return _install(action, say)


def _install(action: str, say: Callable[[str], None]) -> tuple[bool, str]:
    if action not in {"install", "update", "uninstall", "check"}:
        raise ValueError("Unsupported OpenCode installation action")
    # Removing an incompatible runtime must never attempt to execute it first.
    if action == "uninstall":
        return _remove_managed()
    cpu_issue = _cpu_compatibility_issue()
    if cpu_issue:
        if action == "check":
            return False, cpu_issue
        raise RuntimeError(cpu_issue)
    current = binary_version(opencode_binary())
    if action == "check":
        if issue := runtime_issue():
            return False, issue
        if current == OPENCODE_VERSION:
            return True, "\u5df2\u7ecf\u662f SoduWork \u7ba1\u7406\u7248 %s" % current
        if current:
            return True, "\u5f53\u524d\u662f %s\uff1bSoduWork \u56fa\u5b9a\u7248\u672c\u4e3a %s" % (current, OPENCODE_VERSION)
        return True, "SoduWork 将安装固定版本 %s，并自动准备执行依赖。" % OPENCODE_VERSION
    key = platform_key()
    filename, expected = OPENCODE_ARTIFACTS[key]
    target = _root() / OPENCODE_VERSION
    existing = target / _binary_name()
    if binary_version(str(existing)) == OPENCODE_VERSION:
        with _prepare_dependencies(str(existing), say):
            _activate(OPENCODE_VERSION)
        return True, "OpenCode %s \u5df2\u6fc0\u6d3b" % OPENCODE_VERSION

    archive = _root() / "downloads" / filename
    say("正在安装 OpenCode %s（%s）" % (OPENCODE_VERSION, key))
    bases, last_error = _release_bases(), None
    for index, base in enumerate(bases):
        try:
            if len(bases) > 1:
                say("下载源 %d/%d：%s" % (
                    index + 1, len(bases), managed_agent_network.source_label(base)))
            _download(base + "/" + filename, archive, expected, say)
            last_error = None
            break
        except RuntimeError as exc:
            last_error = exc
    if last_error is not None:
        raise RuntimeError("所有下载源都失败：%s" % last_error)

    staging = _root() / (".staging-" + uuid.uuid4().hex[:10])
    backup = None
    try:
        staging.mkdir(parents=True, exist_ok=False)
        candidate = staging / _binary_name()
        say("\u6b63\u5728\u89e3\u538b\u5e76\u6267\u884c\u771f\u5b9e\u7248\u672c\u81ea\u68c0")
        _extract_binary(archive, candidate)
        actual = binary_version(str(candidate), 30)
        if actual != OPENCODE_VERSION:
            raise RuntimeError("\u7248\u672c\u81ea\u68c0\u5931\u8d25\uff1a%s" % (actual or "\u65e0\u8f93\u51fa"))
        with _prepare_dependencies(str(candidate), say):
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                backup = target.with_name(target.name + ".replaced-" + uuid.uuid4().hex[:8])
                os.replace(target, backup)
            moved = False
            try:
                os.replace(staging, target)
                moved = True
                _activate(OPENCODE_VERSION)
            except Exception:
                if moved:
                    os.replace(target, staging)
                if backup and backup.exists() and not target.exists():
                    os.replace(backup, target)
                raise
        if backup and backup.exists():
            shutil.rmtree(backup, ignore_errors=True)
        return True, "OpenCode %s 已安装，执行依赖已就绪并通过自检" % OPENCODE_VERSION
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)


__all__ = [
    "OPENCODE_VERSION", "OPENCODE_ARTIFACTS",
    "managed_binary", "opencode_binary", "binary_version", "platform_key", "install",
    "runtime_issue",
]
