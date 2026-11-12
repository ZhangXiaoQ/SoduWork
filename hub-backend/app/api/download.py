"""Serve unauthenticated public installers from signed release channels, with legacy downloads/
fallback where supported. Keep full installers separate from renderer OTA assets; verify signed
release artifacts before download.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path
import re

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from sqlalchemy import select

from ..config import get_settings
from ..deps import get_session
from ..models import ClientRelease
from ..services import client_updates as client_contract
from ..services import runner_enroll

router = APIRouter(prefix="/api/v1/download", tags=["download"])

# hub-backend/downloads/
_DIR = Path(__file__).resolve().parent.parent.parent / "downloads"
_DISPLAY_NAME = "SoduWork-Setup.exe"
_LEGACY_FILENAME = "soduwork.exe"
_VERSIONED_PACKAGE = re.compile(r"^SoduWork-(\d+)\.(\d+)\.(\d+)-Setup\.exe$")
_MOBILE_DISPLAY_NAME = "SoduWork-Mobile.apk"


# Public Linux downloads from the release channel.
_LINUX_FORMAT_SUFFIXES = (("deb", ".deb"), ("rpm", ".rpm"), ("tar.gz", ".tar.gz"))

# The public homepage lists the production channel by default. The staging
# deployment points this at "beta" so testers download exactly the version
# under acceptance; production keeps serving the stable channel.
def _public_channel() -> str:
    import os
    return os.environ.get("SODUWORK_PUBLIC_DOWNLOAD_CHANNEL", "stable")


def _linux_format(artifact_name: str) -> str:
    lowered = str(artifact_name or "").lower()
    for fmt, suffix in _LINUX_FORMAT_SUFFIXES:
        if lowered.endswith(suffix):
            return fmt
    return ""


async def _linux_release_rows(session):
    """List enabled stable/linux/x64 artifacts, preferring trusted entries, newer versions, and
    preferred formats.
    """
    rows = await _stable_release_rows(session, "linux", "x64")
    return [row for row in rows if _linux_format(row.artifact_name)]


async def _mac_release_rows(session):
    """List enabled stable/darwin artifacts by descending version, preferring arm64 within a
    version.
    """
    rows = await _stable_release_rows(session, "darwin")
    return [row for row in rows
            if str(row.artifact_name or "").lower().endswith((".dmg", ".zip"))]


async def _windows_release_rows(session):
    """List enabled stable/win32/x64 EXE installers by descending version; prefer release channels
    over downloads/ fallback.
    """
    rows = await _stable_release_rows(session, "win32", "x64")
    return [row for row in rows
            if str(row.artifact_name or "").lower().endswith(".exe")]


async def _stable_release_rows(session, platform: str, arch: str | None = None):
    """List trusted public artifacts, preferring explicit candidates on the beta channel."""
    channel = _public_channel()
    filters = [
        ClientRelease.enabled.is_(True),
        ClientRelease.channel == channel,
        ClientRelease.platform == platform,
    ]
    if arch:
        filters.append(ClientRelease.arch == arch)
    rows = (await session.execute(
        select(ClientRelease).where(*filters)
    )).scalars().all()
    trusted = []
    for row in rows:
        try:
            client_contract.assert_trusted_release(row)
        except client_contract.UpdateContractError:
            continue
        trusted.append(row)
    def order(row):
        version = client_contract.parse_version(row.version)
        # Historical beta-channel uploads can have an unsuffixed version. Keep
        # them downloadable, but do not let them hide actual beta candidates.
        candidate = channel == "beta" and version is not None and version[3] == 0
        return (candidate, version or (0, 0, 0, 0, 0),
                -client_contract.format_rank(row.artifact_name),
                -client_contract.installer_brand_rank(row.artifact_name))

    return sorted(trusted, key=order, reverse=True)


def _verified_row(row):
    """Return the artifact path only if existence, signature, and integrity checks pass."""
    try:
        path = client_contract.safe_artifact_path(row.artifact_path)
        client_contract.assert_artifact_integrity(row, path)
    except client_contract.UpdateContractError:
        return None
    if not path.is_file() or path.stat().st_size != int(row.artifact_size or 0):
        return None
    return path


async def _verified_row_async(row):
    """Verify artifacts on a worker thread to avoid blocking requests and heartbeats during
    full-file hashing. Reuse the stat-fingerprint verification cache.
    """
    return await asyncio.to_thread(_verified_row, row)


@router.get("/client/releases/{release_id}")
async def client_release_download(release_id: str, session=Depends(get_session)):
    """Permanent Release links serve only enabled, signed installers from the public channel."""
    row = await session.get(ClientRelease, release_id)
    if row is None or not row.enabled or row.channel != _public_channel():
        raise HTTPException(status_code=404, detail="安装包不存在或尚未发布")
    try:
        client_contract.assert_trusted_release(row)
    except client_contract.UpdateContractError as exc:
        raise HTTPException(status_code=503, detail="安装包签名不可用") from exc
    path = await _verified_row_async(row)
    if path is None:
        raise HTTPException(status_code=503, detail="安装包完整性校验失败")
    return FileResponse(path, filename=row.artifact_name,
                        media_type=_release_media_type(row.artifact_name))


def _release_media_type(artifact_name: str) -> str:
    lowered = artifact_name.lower()
    if lowered.endswith(".apk"):
        return "application/vnd.android.package-archive"
    if lowered.endswith(".deb"):
        return "application/vnd.debian.binary-package"
    if lowered.endswith(".rpm"):
        return "application/x-rpm"
    if lowered.endswith(".tar.gz"):
        return "application/gzip"
    return "application/octet-stream"


@router.get("/client/linux/info")
async def client_linux_info(session=Depends(get_session)):
    """Return the latest available Linux installer per deb, rpm, and tar.gz format; omit
    unavailable formats.
    """
    rows = await _linux_release_rows(session)
    if not rows:
        return {"available": False, "version": "", "formats": {}}
    version = str(rows[0].version)
    formats: dict[str, dict] = {}
    for row in rows:  # Rows are sorted by version and format preference; retain the first row per format.
        if row.version != version:
            continue
        fmt = _linux_format(row.artifact_name)
        if fmt in formats:
            continue
        path = await _verified_row_async(row)
        if path is None:
            continue
        size = int(row.artifact_size or 0)
        formats[fmt] = {
            "filename": row.artifact_name,
            "version": row.version,
            "size": size,
            "sizeText": f"{size / 1024 / 1024:.1f} MB",
            "sha256": row.sha256,
            "updatedAt": (row.created_at.astimezone(timezone.utc).isoformat()
                          if row.created_at else ""),
        }
    return {"available": bool(formats), "version": version, "formats": formats}


@router.get("/client/linux/{fmt}")
async def client_linux_download(fmt: str, session=Depends(get_session)):
    """Serve public Linux installers without authentication, subject to artifact integrity checks.

    """
    if str(fmt or "").lower() not in {name for name, _ in _LINUX_FORMAT_SUFFIXES}:
        raise HTTPException(status_code=404, detail="不支持的安装包格式")
    for row in await _linux_release_rows(session):
        if _linux_format(row.artifact_name) != fmt:
            continue
        path = await _verified_row_async(row)
        if path is None:
            raise HTTPException(status_code=503, detail="安装包不可用，请联系管理员重新发布")
        return FileResponse(path, media_type=_release_media_type(row.artifact_name),
                            filename=row.artifact_name)
    raise HTTPException(status_code=404, detail="该格式的安装包尚未发布")


@router.get("/client/mac/info")
async def client_mac_info(session=Depends(get_session)):
    """Return the latest macOS installer metadata for each available arm64/x64 architecture."""
    rows = await _mac_release_rows(session)
    if not rows:
        return {"available": False, "version": "", "arches": {}}
    version = str(rows[0].version)
    arches: dict[str, dict] = {}
    for row in rows:  # Rows are sorted by version and architecture preference; retain the first row per architecture.
        if row.version != version or row.arch not in {"arm64", "x64"}:
            continue
        if row.arch in arches:
            continue
        path = await _verified_row_async(row)
        if path is None:
            continue
        size = int(row.artifact_size or 0)
        arches[row.arch] = {
            "filename": row.artifact_name,
            "version": row.version,
            "size": size,
            "sizeText": f"{size / 1024 / 1024:.1f} MB",
            "sha256": row.sha256,
            "updatedAt": (row.created_at.astimezone(timezone.utc).isoformat()
                          if row.created_at else ""),
        }
    return {"available": bool(arches), "version": version, "arches": arches}


@router.get("/client/mac/{arch}")
async def client_mac_download(arch: str, session=Depends(get_session)):
    if str(arch or "").lower() not in {"arm64", "x64"}:
        raise HTTPException(status_code=404, detail="不支持的架构")
    for row in await _mac_release_rows(session):
        if row.arch != arch:
            continue
        path = await _verified_row_async(row)
        if path is None:
            raise HTTPException(status_code=503, detail="安装包不可用，请联系管理员重新发布")
        media = ("application/x-apple-diskimage"
                 if row.artifact_name.lower().endswith(".dmg") else "application/zip")
        return FileResponse(path, media_type=media, filename=row.artifact_name)
    raise HTTPException(status_code=404, detail="该架构的安装包尚未发布")


# Windows release-channel downloads with directory fallback, and Android downloads.
def _pkg() -> Path:
    # Do not infer release order from mtime, which changes during copies and restores.
    versioned = []
    for package in _DIR.glob("SoduWork-*-Setup.exe"):
        match = _VERSIONED_PACKAGE.fullmatch(package.name)
        if match:
            versioned.append((tuple(map(int, match.groups())), package))
    if versioned:
        return max(versioned, key=lambda item: item[0])[1]
    branded = _DIR / "SoduWork-Setup.exe"
    if branded.is_file():
        return branded
    return _DIR / _LEGACY_FILENAME


def _package_version(package: Path) -> str:
    """Return the immutable semantic version encoded in a release filename."""
    match = _VERSIONED_PACKAGE.fullmatch(package.name)
    return ".".join(match.groups()) if match else ""


@router.get("/client/info")
async def client_info(session=Depends(get_session)):
    """Return public installer metadata, preferring enabled release-channel artifacts and falling
    back to downloads/. Missing files return available=False rather than an error.
    """
    for row in await _windows_release_rows(session):
        path = await _verified_row_async(row)
        if path is None:
            continue
        size = int(row.artifact_size or 0)
        return {
            "available": True,
            "filename": _DISPLAY_NAME,
            "artifactFilename": row.artifact_name,
            "version": row.version,
            "size": size,
            "sizeText": f"{size / 1024 / 1024:.1f} MB",
            "sha256": row.sha256,
            "updatedAt": (row.created_at.astimezone(timezone.utc).isoformat()
                          if row.created_at else ""),
        }
    p = _pkg()
    if not p.is_file():
        return {"available": False, "filename": _DISPLAY_NAME, "version": ""}
    st = p.stat()
    return {
        "available": True,
        "filename": _DISPLAY_NAME,
        "artifactFilename": p.name,
        "version": _package_version(p),
        "size": st.st_size,
        "sizeText": f"{st.st_size / 1024 / 1024:.1f} MB",
        "updatedAt": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
    }


@router.get("/client")
async def client_download(session=Depends(get_session)):
    for row in await _windows_release_rows(session):
        path = await _verified_row_async(row)
        if path is None:
            raise HTTPException(status_code=503, detail="安装包不可用，请联系管理员重新发布")
        return FileResponse(path, media_type="application/octet-stream",
                            filename=row.artifact_name)
    p = _pkg()
    if not p.is_file():
        raise HTTPException(status_code=404, detail="安装包尚未上传，请联系管理员")
    return FileResponse(
        p,
        media_type="application/octet-stream",
        filename=_DISPLAY_NAME,
    )


@router.get("/mobile/info")
async def mobile_info():
    """Keep existing metadata callers working without advertising excluded mobile artifacts."""
    return {
        "available": False,
        "filename": _MOBILE_DISPLAY_NAME,
        "version": "",
        "webUrl": "",
    }


@router.get("/mobile/android")
async def mobile_android_download():
    raise HTTPException(status_code=404, detail="移动端安装包未在此服务发布")


@router.get("/mobile/android/{filename}")
async def mobile_android_version_download(filename: str):
    raise HTTPException(status_code=404, detail="移动端安装包未在此服务发布")


# Standalone Runner installation.
# Installer downloads are public because the target machine is not yet enrolled.
# Scripts and packages contain no credentials; the installer supplies credentials separately.

def _installer(name: str) -> PlainTextResponse:
    p = runner_enroll.INSTALLERS / name
    if not p.is_file():
        raise HTTPException(status_code=404, detail="装机脚本不见了，请联系管理员")
    text = p.read_text(encoding="utf-8")
    # Use LF endings so Bash does not interpret CR characters as command content.
    return PlainTextResponse(text.replace("\r\n", "\n"),
                             media_type="text/plain; charset=utf-8")


@router.get("/runner-install.ps1")
async def runner_install_ps1():
    return _installer("runner-install.ps1")


@router.get("/runner-install.sh")
async def runner_install_sh():
    return _installer("runner-install.sh")


@router.get("/runner/info")
async def runner_info():
    """Report existing installer availability without building packages during the status request.

    """
    return runner_enroll.packages_info()


@router.get("/runner")
async def runner_download(os: str = "win"):
    """Return the cached Windows executable ZIP or Linux source package, building and caching a
    source package when needed.
    """
    kind = str(os or "win").strip().lower()
    # Cold packaging scans and compresses app/ and skills/, which can take seconds.
    # Run packaging on a worker thread to keep the event loop available for heartbeats and dispatch.
    if kind in {"win", "windows", "exe", "zip"}:
        p = await asyncio.to_thread(runner_enroll.windows_package)
        name, media = "soduwork-runner-win.zip", "application/zip"
    elif kind in {"src", "source", "linux", "tar", "tgz"}:
        p = await asyncio.to_thread(runner_enroll.source_package)
        name, media = "soduwork-runner-src.tar.gz", "application/gzip"
    else:
        raise HTTPException(status_code=422, detail="os 只能是 win 或 src")
    if p is None or not p.is_file():
        raise HTTPException(status_code=404,
                            detail="这台后端上没有执行机安装包，请管理员放到 hub-backend/downloads/")
    return FileResponse(p, media_type=media, filename=name)


# Hosted OpenCode runtime assets.
# Provide a mirror for Runners that cannot reach GitHub directly, retaining official asset names.
# Store assets in hub-backend/downloads/opencode/ and obtain them with fetch_opencode_assets.py.
# Downloads require no authentication; integrity is enforced independently of the transport.
# Runners verify the exact SHA-256 pinned in managed_agents.OPENCODE_ARTIFACTS.

_OPENCODE_ASSET = re.compile(r"^opencode-[a-z0-9][a-z0-9.-]*(\.zip|\.tar\.gz)$")


@router.get("/opencode/info")
async def opencode_info():
    """Report available OpenCode assets by platform for administration and installation checks."""
    from ..services import managed_agents
    assets = []
    for platform, (filename, digest) in sorted(managed_agents.OPENCODE_ARTIFACTS.items()):
        p = _DIR / "opencode" / filename
        assets.append({
            "platform": platform, "filename": filename, "sha256": digest,
            "available": p.is_file(), "size": p.stat().st_size if p.is_file() else 0,
        })
    return {"version": managed_agents.OPENCODE_VERSION, "assets": assets}


@router.get("/opencode/{asset}")
async def opencode_download(asset: str):
    name = str(asset or "").strip()
    if not _OPENCODE_ASSET.fullmatch(name):
        raise HTTPException(status_code=422, detail="不认识的 OpenCode 资产名")
    p = _DIR / "opencode" / name
    if not p.is_file():
        raise HTTPException(status_code=404,
                            detail="OpenCode 资产尚未上传：hub-backend/downloads/opencode/" + name)
    return FileResponse(p, media_type="application/octet-stream", filename=name)
