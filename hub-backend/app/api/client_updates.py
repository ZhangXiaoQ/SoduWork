"""Full-client update API.

Device endpoints use the short-lived Device session.  Administrative requests
create durable attempts first, then use WebSocket only as a wake-up signal; an
offline client therefore receives the same request on its next check-in.
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Body, Depends, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth
from .. import automation_models as am
from ..config import get_settings
from ..db import get_session
from ..deps import current_client, require_perm
from ..models import Client, ClientRelease, ClientUpdateAttempt, User
from ..realtime import hub
from ..services import audit
from ..services import client_updates as contract
from ..services import client_release_files
from ..services import rbac
from ..services import update_safety


router = APIRouter(prefix="/api/v1/client-updates", tags=["client-updates"])
deployment_router = APIRouter(
    prefix="/api/v1/deployment-client-releases",
    tags=["deployment-client-releases"],
)
admin_router = APIRouter(prefix="/api/v1/admin", tags=["admin-client-updates"])
settings = get_settings()
ACTIVE_ATTEMPT_STATES = {
    "queued", "available", "downloading", "downloaded", "waiting", "installing", "deferred",
}


def _time(value) -> str:
    return value.isoformat().replace("+00:00", "Z") if value else ""


def _attempt_api(row: ClientUpdateAttempt) -> dict:
    return {
        "id": row.id,
        "clientId": row.client_id,
        "releaseId": row.release_id,
        "currentVersion": row.current_version,
        "targetVersion": row.target_version,
        "state": row.state,
        "progress": int(row.progress or 0),
        "error": row.error or "",
        "detail": row.detail or {},
        "requestedAt": _time(row.requested_at),
        "updatedAt": _time(row.updated_at),
        "completedAt": _time(row.completed_at),
    }


def _release_api(row: ClientRelease, *, include_manifest: bool = False) -> dict:
    data = {
        "id": row.id,
        "version": row.version,
        "channel": row.channel,
        "platform": row.platform,
        "arch": row.arch,
        "artifactName": row.artifact_name,
        "artifactSize": int(row.artifact_size or 0),
        "sha256": row.sha256,
        "keyId": row.key_id,
        "notes": row.notes or "",
        "mandatory": bool(row.mandatory),
        "minVersion": row.min_version or "",
        "enabled": bool(row.enabled),
        "createdAt": _time(row.created_at),
    }
    if include_manifest:
        contract.assert_trusted_release(row)
        data["manifest"] = contract.signed_manifest(row)
    return data


def _update_channel(channel: str, current: str) -> str:
    # Older Stage installers hardcoded stable. Scope compatibility to a beta
    # client on a Hub explicitly configured to publish beta downloads.
    version = contract.parse_version(current)
    if (channel == "stable" and os.environ.get("SODUWORK_PUBLIC_DOWNLOAD_CHANNEL") == "beta"
            and version is not None and version[3] == 0):
        return "beta"
    return channel


async def _release_rows(session: AsyncSession, channel: str, platform: str, arch: str,
                        package_format: str = "", current_version: str = ""):
    rows = (await session.execute(
        select(ClientRelease).where(
            ClientRelease.enabled.is_(True),
            ClientRelease.channel == channel,
            ClientRelease.platform == platform,
            ClientRelease.arch == arch,
        )
    )).scalars().all()
    trusted = []
    for row in rows:
        if not contract.automatic_update_candidate(row):
            continue
        if package_format and not row.artifact_name.lower().endswith("." + package_format):
            continue
        if current_version and not contract.installer_supported_by_client(row.artifact_name, current_version):
            continue
        try:
            contract.assert_trusted_release(row)
        except contract.UpdateContractError:
            continue
        trusted.append(row)
    # Sort versions descending and package formats by preference, with deb first, for deterministic update selection.
    return sorted(trusted,
                  key=lambda row: (contract.parse_version(row.version) or (-1, -1, -1),
                                   -contract.format_rank(row.artifact_name),
                                   -contract.installer_brand_rank(row.artifact_name)),
                  reverse=True)


async def _pending_attempt(session: AsyncSession, client_id: str):
    rows = (await session.execute(
        select(ClientUpdateAttempt).where(
            ClientUpdateAttempt.client_id == client_id,
            ClientUpdateAttempt.state.in_(ACTIVE_ATTEMPT_STATES),
        ).order_by(ClientUpdateAttempt.requested_at.desc())
    )).scalars().all()
    for attempt in rows:
        release = await session.get(ClientRelease, attempt.release_id)
        if release is not None and release.enabled:
            return attempt, release
    return None, None


def _deployment_claims(authorization: str | None) -> dict:
    scheme, _, token = str(authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="缺少安装包发布令牌")
    claims = auth.verify_claims(token.strip(), token_type="deployment-client-upload")
    if claims is None:
        raise HTTPException(status_code=401, detail="安装包发布令牌无效或已过期")
    return claims


@deployment_router.post("/{run_id}")
async def upload_deployment_client_release(
    run_id: str,
    bundle_file: UploadFile = File(..., alias="bundle"),
    installer: UploadFile = File(...),
    authorization: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
):
    """Accept one signed installer from the exact deployment run that built it."""
    claims = _deployment_claims(authorization)
    run = await session.get(am.DeploymentRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="发布运行不存在")
    target = await session.get(am.DeploymentTarget, run.target_id)
    if target is None:
        raise HTTPException(status_code=404, detail="安装包发布目标不存在")
    upload_config = dict(target.config or {}).get("clientReleaseUpload")
    enabled = bool(upload_config.get("enabled", True)) if isinstance(upload_config, dict) \
        else bool(upload_config)
    if not enabled:
        raise HTTPException(status_code=403, detail="该发布目标未授权上传客户端安装包")
    expected = {
        "runId": run.id,
        "targetId": run.target_id,
        "artifactVersionId": run.artifact_version_id,
        "commit": str(run.commit_sha or ""),
    }
    if any(str(claims.get(key) or "") != value for key, value in expected.items()):
        raise HTTPException(status_code=403, detail="安装包发布令牌与本次发布不匹配")
    terminal_release = None
    if run.state not in {"queued", "running"}:
        terminal_release = dict(run.result or {}).get("clientRelease")
        if not isinstance(terminal_release, dict):
            raise HTTPException(status_code=409, detail="本次发布已经结束，不能再上传安装包")

    bundle_raw = await bundle_file.read(256 * 1024 + 1)
    if len(bundle_raw) > 256 * 1024:
        raise HTTPException(status_code=413, detail="安装包签名清单过大")
    try:
        bundle = json.loads(bundle_raw.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="安装包签名清单不是有效 UTF-8 JSON") from exc
    filename = Path(str(installer.filename or "")).name
    if not filename or filename != str(installer.filename or ""):
        raise HTTPException(status_code=400, detail="安装包文件名无效")

    incoming_dir = (await client_release_files.disk_call(contract.release_root)) / ".incoming" / (run.id + "-" + uuid.uuid4().hex)
    incoming = incoming_dir / filename
    limit = max(64, min(4096, int(settings.client_update_upload_max_mb or 1024))) * 1024 * 1024
    try:
        try:
            await client_release_files.disk_call(
                client_release_files.copy_upload, installer.file, incoming, limit)
        except client_release_files.UploadTooLarge as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from exc
        if terminal_release is not None:
            # A Runner may finish before an exact uploader retry arrives.
            # Verify it, but never mutate an active release back to staged.
            try:
                candidate = await client_release_files.disk_call(
                    contract.release_from_bundle, bundle, incoming)
                release = await session.get(
                    ClientRelease, str(terminal_release.get("id") or ""))
                if (release is None or release.id != candidate.id
                        or contract.signed_manifest(release) != bundle):
                    raise contract.UpdateContractError(
                        "terminal upload retry does not match the staged release")
                await contract.assert_artifact_integrity_async(release)
            except contract.UpdateContractError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            return {"ok": True, "created": False,
                    "release": terminal_release}
        try:
            release, created = await contract.import_signed_release(
                session, bundle, incoming, enabled=False, created_by=run.id)
        except contract.UpdateContractError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        run = await session.get(am.DeploymentRun, run.id)
        result = dict(run.result or {})
        result["clientRelease"] = {
            "id": release.id,
            "version": release.version,
            "channel": release.channel,
            "platform": release.platform,
            "arch": release.arch,
            "artifactName": release.artifact_name,
            "sha256": release.sha256,
            "state": "staged",
            "enabled": bool(release.enabled),
            "uploadedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        run.result = result
        from ..services import task_events
        task_events.record(session, run.task_id, "release.client_staged", {
            "runId": run.id, "targetId": run.target_id,
            "releaseId": release.id, "version": release.version,
            "created": created,
        }, actor="SoduWork")
        await session.commit()
        return {"ok": True, "created": created, "release": result["clientRelease"]}
    finally:
        await client_release_files.disk_call(client_release_files.remove_incoming, incoming)




async def _ensure_attempt(
    session: AsyncSession,
    client: Client,
    release: ClientRelease,
    *,
    requested_by: str,
) -> ClientUpdateAttempt:
    existing = (await session.execute(
        select(ClientUpdateAttempt).where(
            ClientUpdateAttempt.client_id == client.id,
            ClientUpdateAttempt.release_id == release.id,
            ClientUpdateAttempt.state != "installed",
        ).order_by(ClientUpdateAttempt.requested_at.desc())
    )).scalars().first()
    if existing is not None:
        return existing
    row = ClientUpdateAttempt(
        client_id=client.id,
        release_id=release.id,
        requested_by=requested_by,
        current_version=str(client.app_version or ""),
        target_version=release.version,
        state="queued",
        progress=0,
    )
    session.add(row)
    await session.flush()
    return row


def _valid_target(value: str, allowed: set[str], label: str) -> str:
    clean = str(value or "").strip().lower()
    if clean not in allowed:
        raise HTTPException(status_code=400, detail=f"不支持的{label}")
    return clean


async def _verified_artifact_path(release: ClientRelease) -> Path:
    def verify():
        path = contract.safe_artifact_path(release.artifact_path)
        contract.assert_trusted_release(release)
        # Integrity uses the bounded inode/ctime/mtime/size/digest cache. Run
        # cold hashing in a worker so large installers cannot stall heartbeats.
        contract.assert_artifact_integrity(release, path)
        return path

    try:
        return await asyncio.to_thread(verify)
    except contract.UpdateContractError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/check")
async def check_update(
    current: str = Query(..., max_length=32),
    platform: str = Query("win32", max_length=16),
    arch: str = Query("x64", max_length=16),
    channel: str = Query("stable", max_length=16),
    package_format: str = Query("", alias="format", max_length=16),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Return one signed manifest.  Invalid versions never trigger a downgrade."""
    current = str(current or "").strip()
    current_v = contract.parse_version(current)
    if current_v is None:
        raise HTTPException(status_code=400, detail="客户端版本必须是 x.y.z")
    platform = _valid_target(platform, {"win32", "darwin", "linux"}, "平台")
    arch = _valid_target(arch, {"x64", "arm64"}, "架构")
    channel = _valid_target(channel, {"stable", "beta"}, "更新通道")
    channel = _update_channel(channel, current)
    if package_format:
        if platform != "linux":
            raise HTTPException(status_code=400, detail="安装包格式参数仅适用于 Linux")
        package_format = _valid_target(package_format, {"deb", "rpm", "tar.gz", "appimage"}, "安装包格式")

    await update_safety.expire_for_client(session, client.id)
    attempt, release = await _pending_attempt(session, client.id)
    if release is not None:
        try:
            contract.assert_trusted_release(release)
        except contract.UpdateContractError:
            attempt = release = None
    if release is not None:
        target_v = contract.parse_version(release.version)
        if (not contract.automatic_update_candidate(release) or
                release.channel != channel or release.platform != platform or
                not contract.installer_supported_by_client(release.artifact_name, current) or
                release.arch != arch or (package_format and not
                release.artifact_name.lower().endswith("." + package_format))):
            attempt = release = None
        elif target_v is not None and current_v >= target_v:
            await update_safety.release(session, attempt)
            attempt.state = "installed"
            attempt.progress = 100
            attempt.completed_at = datetime.now(timezone.utc)
            client.app_version = current
            await session.commit()
            attempt = release = None
    rows = await _release_rows(session, channel, platform, arch, package_format, current)
    latest = next((row for row in rows if contract.newer(row.version, current)), None)
    supersedable = {"queued", "available", "downloaded", "deferred"}
    if (attempt is not None and release is not None and latest is not None
            and attempt.state in supersedable
            and contract.newer(latest.version, release.version)):
        await update_safety.release(session, attempt)
        attempt.state = "failed"
        attempt.progress = 0
        attempt.error = f"Superseded by SoduWork {latest.version}"
        attempt.completed_at = datetime.now(timezone.utc)
        attempt = release = None

    if release is None:
        release = latest
        if release is None:
            client.app_version = current
            await session.commit()
            return {"hasUpdate": False, "current": current, "channel": channel}
    # A shared release row does not prove this node has the immutable bytes.
    # Fail explicitly instead of advertising an installer that cannot download.
    await _verified_artifact_path(release)
    if attempt is None:
        attempt = await _ensure_attempt(session, client, release, requested_by="auto")

    minimum = contract.parse_version(release.min_version) if release.min_version else None
    manual = bool(minimum and current_v < minimum)
    if attempt.state in {"queued", "failed"} and not manual:
        attempt.state = "available"
        attempt.error = ""
    attempt.current_version = current
    client.app_version = current
    await session.commit()
    await session.refresh(attempt)
    return {
        "hasUpdate": True,
        "manualInstallRequired": manual,
        "attemptId": attempt.id,
        "current": current,
        "manifest": contract.signed_manifest(release),
    }


@router.get("/artifacts/{release_id}")
async def download_artifact(
    release_id: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    release = await session.get(ClientRelease, release_id)
    if release is None or not release.enabled:
        raise HTTPException(status_code=404, detail="客户端版本不存在")
    # Only check whether an upgrade attempt exists for this device and release.
    # The client_id/release_id pair is not unique: retries and re-upgrades create additional attempts.
    # Avoid scalar_one_or_none(), which raises MultipleResultsFound for valid retry history.
    # That exception would prevent further upgrades to the same release.
    attempt = (await session.execute(select(ClientUpdateAttempt.id).where(
        ClientUpdateAttempt.client_id == client.id,
        ClientUpdateAttempt.release_id == release_id,
    ).limit(1))).scalars().first()
    if not attempt:
        raise HTTPException(status_code=403, detail="这台设备没有该版本的升级任务")
    path = await _verified_artifact_path(release)
    if not path.is_file() or path.stat().st_size != int(release.artifact_size or 0):
        raise HTTPException(status_code=503, detail="安装包不可用，请联系管理员重新发布")
    lowered = release.artifact_name.lower()
    if lowered.endswith(".dmg"):
        media_type = "application/x-apple-diskimage"
    elif lowered.endswith(".zip"):
        media_type = "application/zip"
    elif lowered.endswith(".deb"):
        media_type = "application/vnd.debian.binary-package"
    elif lowered.endswith(".rpm"):
        media_type = "application/x-rpm"
    elif lowered.endswith(".tar.gz"):
        media_type = "application/gzip"
    elif lowered.endswith(".appimage"):
        media_type = "application/x-executable"
    else:
        media_type = "application/vnd.microsoft.portable-executable"
    return FileResponse(path, filename=release.artifact_name, media_type=media_type)


@router.get("/status")
async def own_update_status(
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    row = (await session.execute(
        select(ClientUpdateAttempt).where(ClientUpdateAttempt.client_id == client.id)
        .order_by(ClientUpdateAttempt.requested_at.desc())
    )).scalars().first()
    return {"attempt": _attempt_api(row) if row else None}


@router.post("/attempts/{attempt_id}/prepare")
async def prepare_update_install(
    attempt_id: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Stop new local dispatch and report every workload blocking installation."""
    row = await session.get(ClientUpdateAttempt, attempt_id)
    if row is None or row.client_id != client.id:
        raise HTTPException(status_code=404, detail="升级任务不存在")
    if row.state not in {"downloaded", "waiting"}:
        raise HTTPException(status_code=409, detail="安装包尚未准备好，不能进入安全升级")
    if row.state == "downloaded":
        try:
            contract.validate_transition(row.state, "waiting")
        except contract.UpdateContractError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    local_blockers = body.get("blockers") if isinstance(body.get("blockers"), list) else []
    result = await update_safety.prepare(
        session, row, client,
        [item for item in local_blockers[:12] if isinstance(item, dict)],
    )
    await session.commit()
    await session.refresh(row)
    return {**result, "attempt": _attempt_api(row)}


@router.post("/attempts/{attempt_id}/events")
async def report_update_event(
    attempt_id: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(ClientUpdateAttempt, attempt_id)
    if row is None or row.client_id != client.id:
        raise HTTPException(status_code=404, detail="升级任务不存在")
    state = str(body.get("state") or "").strip()
    try:
        contract.validate_transition(row.state, state)
    except contract.UpdateContractError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    progress = max(0, min(100, int(body.get("progress") or 0)))
    current = str(body.get("currentVersion") or "").strip()
    if state == "installed":
        current_v, target_v = contract.parse_version(current), contract.parse_version(row.target_version)
        if current_v is None or target_v is None or current_v < target_v:
            raise HTTPException(status_code=409, detail="启动版本与目标版本不一致")
        row.completed_at = datetime.now(timezone.utc)
        row.progress = 100
        client.app_version = current
    else:
        row.progress = max(row.progress or 0, progress)
    detail = body.get("detail") if isinstance(body.get("detail"), dict) else {}
    maintenance = (row.detail or {}).get(update_safety.DETAIL_KEY)
    if isinstance(maintenance, dict) and update_safety.DETAIL_KEY not in detail:
        detail = {**detail, update_safety.DETAIL_KEY: maintenance}
    if len(json.dumps(detail, ensure_ascii=False)) > 8192:
        raise HTTPException(status_code=400, detail="升级详情过大")
    row.state = state
    row.error = str(body.get("error") or "")[:600] if state == "failed" else ""
    row.detail = detail
    if state in {"installed", "failed", "deferred"}:
        await update_safety.release(session, row)
    await session.commit()
    await session.refresh(row)
    return {"ok": True, "attempt": _attempt_api(row)}


def _device_platform(raw: str) -> str | None:
    """Map a client.platform string to a release target; '' stays win32 (legacy)."""
    target = str(raw or "").strip().lower()
    if not target or any(mark in target for mark in ("win", "windows")):
        return "win32"
    if any(mark in target for mark in ("darwin", "mac")):
        return "darwin"
    if "linux" in target:
        return "linux"
    return None


async def _assert_client_scope(session: AsyncSession, user: User, client: Client) -> None:
    scope = await rbac.scope_org_ids(session, user)
    if scope is None:
        return
    users = await rbac.scoped_user_ids(session, scope) or set()
    if client.user_ref is not None and client.user_ref not in users:
        raise HTTPException(status_code=403, detail="无权管理该 SoduWork")


@admin_router.get("/client-releases")
async def list_client_releases(
    _user: User = Depends(require_perm("client.update")),
    session: AsyncSession = Depends(get_session),
):
    rows = (await session.execute(
        select(ClientRelease).order_by(ClientRelease.created_at.desc())
    )).scalars().all()
    return {"releases": [_release_api(row) for row in rows]}


@admin_router.post("/client-releases/upload")
async def upload_manual_client_release(
    bundle_file: UploadFile = File(..., alias="bundle"),
    installer: UploadFile = File(...),
    user: User = Depends(require_perm("client.update")),
    session: AsyncSession = Depends(get_session),
):
    """Stage a signed installer directly without a deployment run; manual release channels are
    disabled by default.
    """
    bundle_raw = await bundle_file.read(256 * 1024 + 1)
    if len(bundle_raw) > 256 * 1024:
        raise HTTPException(status_code=413, detail="安装包签名清单过大")
    try:
        bundle = json.loads(bundle_raw.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="安装包签名清单不是有效 UTF-8 JSON") from exc
    filename = Path(str(installer.filename or "")).name
    if not filename or filename != str(installer.filename or ""):
        raise HTTPException(status_code=400, detail="安装包文件名无效")
    incoming_dir = (await client_release_files.disk_call(contract.release_root)) / ".incoming" / uuid.uuid4().hex
    incoming = incoming_dir / filename
    limit = max(64, min(4096, int(settings.client_update_upload_max_mb or 1024))) * 1024 * 1024
    try:
        try:
            await client_release_files.disk_call(
                client_release_files.copy_upload, installer.file, incoming, limit)
        except client_release_files.UploadTooLarge as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from exc
        try:
            release, created = await contract.import_signed_release(
                session, bundle, incoming, enabled=False, created_by=user.id)
        except contract.UpdateContractError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        await audit.log(session, user, "client.release.upload", "client_release",
                        release.id, release.artifact_name,
                        {"releaseId": release.id, "version": release.version,
                         "channel": release.channel, "platform": release.platform,
                         "arch": release.arch, "created": created})
        await session.commit()
        return {"ok": True, "created": created, "release": _release_api(release)}
    finally:
        await client_release_files.disk_call(client_release_files.remove_incoming, incoming)


@admin_router.get("/client-releases/{release_id}/download")
async def download_admin_client_release(
    release_id: str,
    _user: User = Depends(require_perm("client.update")),
    session: AsyncSession = Depends(get_session),
):
    """Administrators can inspect even disabled packages; public access stays gated."""
    release = await session.get(ClientRelease, release_id)
    if release is None:
        raise HTTPException(status_code=404, detail="客户端版本不存在")
    path = await _verified_artifact_path(release)
    from .download import _release_media_type
    return FileResponse(path, filename=release.artifact_name,
                        media_type=_release_media_type(release.artifact_name))


@admin_router.patch("/client-releases/{release_id}")
async def set_client_release_enabled(
    release_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("client.update")),
    session: AsyncSession = Depends(get_session),
):
    release = await session.get(ClientRelease, release_id)
    if release is None:
        raise HTTPException(status_code=404, detail="客户端版本不存在")
    enabled = bool(body.get("enabled"))
    if enabled and not release.enabled:
        try:
            contract.assert_trusted_release(release)
            await contract.assert_artifact_integrity_async(release)
        except contract.UpdateContractError as exc:
            raise HTTPException(status_code=409, detail=f"安装包校验失败：{exc}") from exc
    release.enabled = enabled
    await audit.log(session, user, "client.release.toggle", "client_release",
                    release.id, release.artifact_name,
                    {"releaseId": release.id, "enabled": enabled})
    await session.commit()
    return {"ok": True, "release": _release_api(release)}


@admin_router.get("/client-update-attempts")
async def list_all_update_attempts(
    release_id: str = Query("", alias="releaseId", max_length=64),
    state: str = Query("all", max_length=16),
    limit: int = Query(50, ge=1, le=200),
    _user: User = Depends(require_perm("client.view")),
    session: AsyncSession = Depends(get_session),
):
    """List device upgrade attempts, filtered by all, active, or an exact state. Counts follow the
    current filters to show release coverage.
    """
    filters = []
    if release_id:
        if await session.get(ClientRelease, release_id) is None:
            raise HTTPException(status_code=404, detail="客户端版本不存在")
        filters.append(ClientUpdateAttempt.release_id == release_id)
    if state == "active":
        filters.append(ClientUpdateAttempt.state.in_(ACTIVE_ATTEMPT_STATES))
    elif state != "all":
        _valid_target(state, {"queued", "available", "downloading", "downloaded",
                              "waiting", "installing", "deferred", "installed", "failed"},
                       "升级状态")
        filters.append(ClientUpdateAttempt.state == state)

    base = (select(ClientUpdateAttempt, Client, ClientRelease)
            .join(Client, Client.id == ClientUpdateAttempt.client_id)
            .join(ClientRelease, ClientRelease.id == ClientUpdateAttempt.release_id))
    if filters:
        base = base.where(*filters)
    rows = (await session.execute(
        base.order_by(ClientUpdateAttempt.requested_at.desc()).limit(limit))).all()
    attempts = []
    for attempt, client, release in rows:
        attempts.append({
            **_attempt_api(attempt),
            "clientName": (client.name or client.id) if client else "",
            "clientPlatform": str(client.platform or "") if client else "",
            "clientOnline": hub.is_online(attempt.client_id) if client else False,
            "releaseVersion": release.version if release else "",
            "releaseChannel": release.channel if release else "",
            "releasePlatform": release.platform if release else "",
            "requestedBy": str(attempt.requested_by or ""),
        })
    count_rows = (await session.execute(
        select(ClientUpdateAttempt.state, func.count())
        .where(*(filters or [true()]))
        .group_by(ClientUpdateAttempt.state))).all()
    counts_out = {}
    for state_name, state_count in count_rows:
        counts_out[str(state_name)] = int(state_count)
    return {"attempts": attempts, "counts": counts_out}


@admin_router.get("/clients/{client_id}/updates")
async def list_client_attempts(
    client_id: str,
    user: User = Depends(require_perm("client.view")),
    session: AsyncSession = Depends(get_session),
):
    client = await session.get(Client, client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="SoduWork 不存在")
    await _assert_client_scope(session, user, client)
    rows = (await session.execute(
        select(ClientUpdateAttempt).where(ClientUpdateAttempt.client_id == client_id)
        .order_by(ClientUpdateAttempt.requested_at.desc()).limit(20)
    )).scalars().all()
    return {"attempts": [_attempt_api(row) for row in rows]}


@admin_router.post("/clients/{client_id}/updates")
async def request_client_update(
    client_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("client.update")),
    session: AsyncSession = Depends(get_session),
):
    client = await session.get(Client, client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="SoduWork 不存在")
    await _assert_client_scope(session, user, client)
    current = str(client.app_version or "")
    if contract.parse_version(current) is None:
        raise HTTPException(status_code=409, detail="设备没有上报有效版本，请先启动一次客户端")
    target_platform = _device_platform(str(client.platform or ""))
    if target_platform is None:
        raise HTTPException(status_code=409, detail="这台设备的平台暂不支持在线升级")
    target_arch = "arm64" if "arm64" in str(client.platform or "").lower() else "x64"
    release_id = str(body.get("releaseId") or "").strip()
    if release_id:
        release = await session.get(ClientRelease, release_id)
        if release is None or not release.enabled:
            raise HTTPException(status_code=404, detail="客户端版本不存在或已停用")
        try:
            contract.assert_trusted_release(release)
        except contract.UpdateContractError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if not contract.automatic_update_candidate(release):
            raise HTTPException(status_code=409, detail="历史无 beta 后缀的测试包不支持在线升级，请选择 beta 版本")
        if release.platform != target_platform or release.arch != target_arch:
            raise HTTPException(status_code=409, detail="目标版本与这台设备的平台或架构不匹配")
        if not contract.installer_supported_by_client(release.artifact_name, current):
            raise HTTPException(status_code=409, detail="旧客户端无法识别此安装包名，请选择兼容安装包")
    else:
        rows = await _release_rows(session, _update_channel("stable", current),
                                   target_platform, target_arch, current_version=current)
        release = next((row for row in rows if contract.newer(row.version, current)), None)
        if release is None:
            return {"ok": True, "alreadyCurrent": True, "current": current}
    if not contract.newer(release.version, current):
        raise HTTPException(status_code=409, detail="目标版本必须高于设备当前版本")
    attempt = await _ensure_attempt(session, client, release, requested_by=user.id)
    await session.commit()
    await session.refresh(attempt)
    delivered = hub.is_online(client.id)
    if delivered:
        await hub.publish(client.id, {
            "type": "command", "action": "apply-update",
            "payload": {"attemptId": attempt.id, "targetVersion": release.version},
        })
    await audit.log(session, user, "client.update.request", "client", client.id,
                    client.name or client.id,
                    {"attemptId": attempt.id, "currentVersion": current,
                     "targetVersion": release.version,
                     "delivered": delivered})
    return {
        "ok": True,
        "queued": True,
        "delivered": delivered,
        "attempt": _attempt_api(attempt),
        "release": _release_api(release),
    }
