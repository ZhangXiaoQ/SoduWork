"""Enroll standalone Runners with stable IDs, per-machine revocable keys, and persistent platform
installation. Return plaintext keys only at issuance and store hashes server-side. Public
installers contain no keys; generate a reachable Hub address or honor an explicit override.
"""
from __future__ import annotations

import os
import ipaddress
import re
import secrets
import shutil
import socket
import tarfile
import time
import threading
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from . import runner_registry, runner_sources

# hub-backend/
_BACKEND = Path(__file__).resolve().parent.parent.parent
_PROJECT = _BACKEND.parent
_CACHE = _BACKEND / "downloads" / "cache"
INSTALLERS = _BACKEND / "installers"

# Serialize installer builds so concurrent downloads share the cached package.
# Avoid repeating a full directory scan and compression for every request.
_BUILD_LOCK = threading.Lock()

# Do not embed loopback addresses in commands intended for another machine.
_LOOPBACK = {"127.0.0.1", "localhost", "::1", "0.0.0.0", "::"}


def validate_hub_url(value: str) -> str:
    """A download origin/path must also be safe in both generated shells."""
    if not isinstance(value, str) or len(value) > 500:
        raise ValueError("服务地址格式不正确")
    value = value.strip().rstrip("/")
    try:
        parsed = urlsplit(value)
        host, port = parsed.hostname or "", parsed.port
        if (parsed.scheme not in {"http", "https"} or not host or parsed.username is not None
                or parsed.password is not None or parsed.query or parsed.fragment
                or not re.fullmatch(r"[A-Za-z0-9/_.:~\[\]-]+", value)
                or (port is not None and not 1 <= port <= 65535)):
            raise ValueError()
        if ":" in host:
            ipaddress.IPv6Address(host)
        elif not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", host):
            raise ValueError()
    except ValueError as exc:
        raise ValueError("服务地址只能是 http 或 https 地址，不能包含账号、查询参数或特殊字符") from exc
    return value


def _lan_ip() -> str:
    """Determine the Hub's LAN source address through a UDP route lookup without sending
    application packets.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return ""
    finally:
        s.close()


def hub_url(prefer: str = "", request_base: str = "") -> str:
    """Choose the Hub URL from an explicit override, the current non-loopback administration URL,
    then the local LAN address.
    """
    for candidate in (prefer, request_base):
        url = str(candidate or "").strip().rstrip("/")
        if not url:
            continue
        if url.startswith(("ws://", "wss://")):
            url = ("https://" if url.startswith("wss://") else "http://") + url.split("://", 1)[1]
        elif "://" not in url:
            url = "http://" + url
        url = validate_hub_url(url)
        host = urlsplit(url).hostname
        local = host in _LOOPBACK
        try:
            address = ipaddress.ip_address(host)
            local = local or address.is_loopback or address.is_unspecified
        except ValueError:
            pass
        if not local:
            return url
    ip = _lan_ip()
    port = os.environ.get("PORT") or "9080"
    return validate_hub_url("http://%s:%s" % (ip or "127.0.0.1", port))


def new_runner_id(host: str = "") -> str:
    """Generate a stable standalone Runner ID independent of the editable machine name."""
    slug = re.sub(r"[^a-z0-9-]+", "-", str(host or "").strip().lower()).strip("-")[:20]
    # Non-ASCII names may produce unhelpful slugs.
    # Use a random unique ID; display the machine name separately.
    return ("rn-%s-%s" % (slug, secrets.token_hex(3))) if len(slug) >= 3 \
        else ("rn-%s" % secrets.token_hex(5))


def _quote_ps(value: str) -> str:
    return "'" + str(value or "").replace("'", "''") + "'"


def _quote_sh(value: str) -> str:
    return "'" + str(value or "").replace("'", "'\\''") + "'"


def install_commands(hub: str, runner_id: str, key: str, tags: list[str] | None = None,
                     work_root: str = "") -> dict:
    """Build platform installation commands that download the public script and pass the key as an
    argument.
    """
    hub = validate_hub_url(hub)
    tag_text = ",".join(tags or [])
    ps_args = ["-Hub", _quote_ps(hub), "-Id", _quote_ps(runner_id), "-Key", _quote_ps(key)]
    sh_args = ["--hub", _quote_sh(hub), "--id", _quote_sh(runner_id), "--key", _quote_sh(key)]
    if tag_text:
        ps_args += ["-Tags", _quote_ps(tag_text)]
        sh_args += ["--tags", _quote_sh(tag_text)]
    if work_root:
        ps_args += ["-WorkRoot", _quote_ps(work_root)]
        sh_args += ["--work-root", _quote_sh(work_root)]
    # Convert downloaded PowerShell into a script block so installation arguments can be supplied.
    windows = ("powershell -NoProfile -ExecutionPolicy Bypass -Command \"& {"
               "$s=[scriptblock]::Create((iwr %s/api/v1/download/runner-install.ps1"
               " -UseBasicParsing).Content); & $s %s}\"" % (hub, " ".join(ps_args)))
    # Minimal Ubuntu images may have neither curl nor sudo (when already root).
    # Download to a file so a failed curl cannot become a successful empty bash.
    bootstrap = '''set -euo pipefail
download_hub="$1"; shift
if ! command -v curl >/dev/null 2>&1 || { [ ! -s /etc/ssl/certs/ca-certificates.crt ] && [ ! -s /etc/pki/tls/certs/ca-bundle.crt ]; }; then
  if command -v apt-get >/dev/null 2>&1; then
    . /etc/os-release
    if [ "${ID:-}" = ubuntu ]; then
      mirror_scheme=https
      [ -s /etc/ssl/certs/ca-certificates.crt ] || mirror_scheme=http
      for source_file in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
        [ -f "$source_file" ] || continue
        [ -f "$source_file.soduwork-backup" ] || cp -p "$source_file" "$source_file.soduwork-backup"
        sed -E -i "s@https?://(([a-zA-Z0-9.-]+\\\\.)?(archive|security)\\\\.ubuntu\\\\.com|mirrors\\\\.tuna\\\\.tsinghua\\\\.edu\\\\.cn)/ubuntu/?@$mirror_scheme://mirrors.tuna.tsinghua.edu.cn/ubuntu/@g" "$source_file"
      done
    fi
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y curl ca-certificates
  elif command -v yum >/dev/null 2>&1; then
    yum install -y curl ca-certificates
  else
    echo "请先安装 curl 和 CA 证书" >&2; exit 1
  fi
fi
installer_file="$(mktemp)"
trap 'rm -f "$installer_file"' EXIT
curl -fsSL "$download_hub/api/v1/download/runner-install.sh" -o "$installer_file"
bash "$installer_file" "$@"
'''
    privilege = ('if [ "$(id -u)" = 0 ]; then exec bash "$@"; '
                 'else exec sudo -n bash "$@"; fi')
    linux = ("bash -c %s -- -c %s -- %s %s" %
             (_quote_sh(privilege), _quote_sh(bootstrap), _quote_sh(hub), " ".join(sh_args)))
    return {"windows": windows, "linux": linux}


async def enroll(session: AsyncSession, *, runner_id: str = "", host: str = "",
                 tags: list[str] | None = None, hub: str = "", request_base: str = "",
                 work_root: str = "", org_id: str | None = None,
                 owner_user_id: str | None = None) -> dict:
    """Register a standalone Runner and issue its key, or rotate an existing key. Prepopulate
    display fields so issued-but-not-connected machines are visible; authenticated machine
    reports update factual host metadata later.
    """
    host = str(host or "").strip()[:100]
    tags = runner_registry._clean_tags(tags)
    # Validate before issuing/rotating credentials. Failed configuration must
    # leave an already connected server's credential unchanged.
    url = hub_url(hub, request_base)
    rid = str(runner_id or "").strip()[:80] or new_runner_id(host)
    existed = await session.get(am.RunnerNode, rid)
    key = await runner_registry.issue_key(session, rid, host=host, org_id=org_id,
                                          owner_user_id=owner_user_id)
    row = await session.get(am.RunnerNode, rid)
    if row is not None:
        if host:
            row.host = host
            # Preserve the user-assigned label separately from reported hostnames.
            # Multiple Runners on one host otherwise receive indistinguishable names.
            row.enroll_name = host[:80]
        if tags:
            row.tags = tags
        row.client_id = row.client_id or ""      # Shared Runner without an owning desktop client.
    return {
        "runnerId": rid,
        "orgId": str((row.org_id if row else org_id) or ""),
        "key": key,
        "hub": url,
        "rotated": existed is not None,
        "tags": tags,
        "commands": install_commands(url, rid, key, tags, work_root),
        "packages": packages_info(),
        "note": "钥匙只显示这一次。装完那台机器会自己连回来，在这张表里变成「在线」。",
    }


# ---------------------------------------------------------------- Runner installation packages
# Windows: a PyInstaller one-file executable that does not require Python on the target host.
# Linux: a source archive (runner_main.py, app/, and skills/) run in a system-python3 virtual environment.
# Preserve that source layout for runners that mount the extracted package as their application directory.

def _newest(paths: list[Path]) -> float:
    latest = 0.0
    for p in paths:
        try:
            latest = max(latest, p.stat().st_mtime)
        except OSError:
            pass
    return latest


def _fresh(target: Path, sources: list[Path]) -> bool:
    """Check whether the cached package is newer than the latest source modification."""
    if not target.is_file():
        return False
    try:
        return target.stat().st_mtime >= _newest(sources)
    except OSError:
        return False


def _publish_package(tmp: Path, out: Path) -> None:
    """Publish a generated package while tolerating concurrent download requests.

    Windows cannot replace an open destination file.  If another request won
    the race, its complete package is the right result; discard this request's
    temporary archive and reuse the winner instead of returning HTTP 500.
    """
    try:
        shutil.move(str(tmp), str(out))
    except (FileExistsError, PermissionError):
        if not out.is_file():
            raise
        try:
            tmp.unlink()
        except OSError:
            pass


def _win_sources() -> list[Path]:
    exe = _PROJECT / "client" / "runner" / "soduwork-runner.exe"
    return [exe] if exe.is_file() else []


def _current_windows_package(path: Path) -> bool:
    """Reject cached onedir bundles even when their timestamp looks current."""
    try:
        with zipfile.ZipFile(path) as bundle:
            return bundle.namelist() == ["soduwork-runner.exe"]
    except (OSError, zipfile.BadZipFile):
        return False


def _src_sources() -> list[Path]:
    out = [_BACKEND / "runner_main.py", _BACKEND / "requirements-runner.txt", _PROJECT / "LICENSE"]
    out += [p for p in (_BACKEND / "app").rglob("*.py") if "__pycache__" not in p.parts]
    out += runner_sources.runtime_resources(_BACKEND)
    skills = _PROJECT / "skills"
    if skills.is_dir():
        out += [p for p in skills.rglob("*") if p.is_file()]
    return [p for p in out if p.exists()]


def windows_package() -> Path | None:
    """Return the Windows installer ZIP, preferring an administrator-uploaded package when source
    builds are unavailable.
    """
    ready = _BACKEND / "downloads" / "soduwork-runner-win.zip"
    if ready.is_file():
        return ready
    src = _PROJECT / "client" / "runner"
    if not (src / "soduwork-runner.exe").is_file():
        return None
    _CACHE.mkdir(parents=True, exist_ok=True)
    out = _CACHE / "soduwork-runner-win.zip"
    sources = _win_sources()
    if _fresh(out, sources) and _current_windows_package(out):
        return out
    with _BUILD_LOCK:
        # Recheck the cache after acquiring the build lock because another request may have completed it.
        if _fresh(out, sources) and _current_windows_package(out):
            return out
        tmp = _CACHE / f"soduwork-runner-win.{os.getpid()}.{threading.get_ident()}.zip.tmp"
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            z.write(src / "soduwork-runner.exe", arcname="soduwork-runner.exe")
        _publish_package(tmp, out)
    return out


def source_package() -> Path | None:
    """Build the source tarball with hub-backend/runner_main.py at the expected extracted path."""
    ready = _BACKEND / "downloads" / "soduwork-runner-src.tar.gz"
    if ready.is_file():
        return ready
    sources = _src_sources()
    if not sources:
        return None
    _CACHE.mkdir(parents=True, exist_ok=True)
    out = _CACHE / "soduwork-runner-src.tar.gz"
    if _fresh(out, sources):
        return out
    with _BUILD_LOCK:
        if _fresh(out, sources):   # Another request may have built the package while this one waited.
            return out
        tmp = _CACHE / f"soduwork-runner-src.{os.getpid()}.{threading.get_ident()}.tar.tmp"

        def _skip(info: tarfile.TarInfo):
            parts = info.name.split("/")
            if "__pycache__" in parts or info.name.endswith((".pyc", ".pyo")):
                return None
            return info

        with tarfile.open(tmp, "w:gz") as t:
            if (_PROJECT / "LICENSE").is_file():
                t.add(_PROJECT / "LICENSE", arcname="LICENSE")
            t.add(_BACKEND / "runner_main.py", arcname="hub-backend/runner_main.py")
            t.add(_BACKEND / "requirements-runner.txt",
                  arcname="hub-backend/requirements-runner.txt")
            t.add(_BACKEND / "app", arcname="hub-backend/app", filter=_skip)
            if (_PROJECT / "skills").is_dir():
                t.add(_PROJECT / "skills", arcname="skills", filter=_skip)
        _publish_package(tmp, out)
    return out


def _pkg_info(path: Path | None) -> dict:
    if path is None or not path.is_file():
        return {"available": False}
    st = path.stat()
    return {"available": True, "size": st.st_size,
            "sizeText": "%.1f MB" % (st.st_size / 1024 / 1024),
            "updatedAt": time.strftime("%Y-%m-%d %H:%M", time.localtime(st.st_mtime))}


def packages_info() -> dict:
    """Check existing installer availability without building packages during a list request."""
    win = _BACKEND / "downloads" / "soduwork-runner-win.zip"
    if not win.is_file():
        win = _CACHE / "soduwork-runner-win.zip"
    src = _BACKEND / "downloads" / "soduwork-runner-src.tar.gz"
    if not src.is_file():
        src = _CACHE / "soduwork-runner-src.tar.gz"
    info = {"windows": _pkg_info(win if win.is_file() else None),
            "source": _pkg_info(src if src.is_file() else None)}
    # Source availability allows building on download even when no cached package exists yet.
    exe = _PROJECT / "client" / "runner" / "soduwork-runner.exe"
    info["windows"].setdefault("buildable", exe.is_file())
    info["source"].setdefault("buildable", (_BACKEND / "runner_main.py").is_file())
    # Executable packages do not automatically reflect source changes.
    # An older package may omit recent runtime fixes.
    # Expose package staleness so administrators know to rebuild it.
    if exe.is_file() and (_BACKEND / "runner.spec").is_file():
        info["windows"]["stale"] = exe.stat().st_mtime < runner_sources.latest_input_stamp(
            _BACKEND, _PROJECT)
    return info
