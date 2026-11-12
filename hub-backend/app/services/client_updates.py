"""Signed, immutable full-client release contracts.

The legacy ``release`` domain only replaced renderer files.  A client release is
different: it is one complete installer, addressed by its digest and signed by
an Ed25519 deployment key.  Keeping canonicalisation here makes publishing,
serving and smoke tests share one protocol implementation.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path, PureWindowsPath
from types import SimpleNamespace
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import ClientRelease, ClientUpdateAttempt
from ..config import get_settings
from . import client_release_files


# Stable releases stay canonical X.Y.Z; staging candidates append -beta.N
# and always order before the same stable version (1.13.7-beta.2 < 1.13.7).
VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(1|[1-9]\d*))?$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
KEY_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$")
TERMINAL_STATES = {"installed"}
UPDATE_STATES = {
    "queued", "available", "downloading", "downloaded", "installing",
    "waiting", "installed", "deferred", "failed",
}
TRANSITIONS = {
    "queued": {"available", "downloading", "deferred", "failed", "installed"},
    "available": {"downloading", "deferred", "failed", "installed"},
    "downloading": {"downloaded", "deferred", "failed", "installed"},
    "downloaded": {"waiting", "installing", "deferred", "failed", "installed"},
    "waiting": {"downloading", "downloaded", "installing", "deferred", "failed", "installed"},
    "installing": {"installed", "failed"},
    "deferred": {"available", "downloading", "failed", "installed"},
    "failed": {"available", "downloading", "failed", "installed"},
    "installed": set(),
}


class UpdateContractError(ValueError):
    pass


_ARTIFACT_VERIFIED: dict[str, tuple[int, int, int, int, str]] = {}


def parse_version(value: str) -> tuple[int, int, int, int, int] | None:
    match = VERSION_RE.fullmatch(str(value or "").strip())
    if not match:
        return None
    # A prerelease sorts before the same stable version; beta indexes compare
    # numerically (beta.10 > beta.9).
    stable = 0 if match.group(4) else 1
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)),
            stable, int(match.group(4) or 0))


def newer(latest: str, current: str) -> bool:
    left, right = parse_version(latest), parse_version(current)
    return bool(left and right and left > right)


def automatic_update_candidate(release: ClientRelease) -> bool:
    """Historical unsuffixed beta uploads remain downloadable, never auto-upgrade targets."""
    version = parse_version(release.version)
    return bool(version and (release.channel != "beta" or version[3] == 0))


def canonical_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")


def sha256_file(path: str | os.PathLike[str]) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _decode_key(raw: str, *, length: int, label: str) -> bytes:
    try:
        value = base64.b64decode(str(raw or "").strip(), validate=True)
    except Exception as exc:
        raise UpdateContractError(f"{label}不是合法 Base64") from exc
    if len(value) != length:
        raise UpdateContractError(f"{label}必须是 {length} 字节")
    return value


def private_key(raw: str) -> Ed25519PrivateKey:
    return Ed25519PrivateKey.from_private_bytes(
        _decode_key(raw, length=32, label="升级签名私钥"))


def public_key(raw: str) -> Ed25519PublicKey:
    return Ed25519PublicKey.from_public_bytes(
        _decode_key(raw, length=32, label="升级签名公钥"))


def sign(payload: dict[str, Any], raw_private_key: str) -> str:
    signature = private_key(raw_private_key).sign(canonical_bytes(payload))
    return base64.b64encode(signature).decode("ascii")


def verify(payload: dict[str, Any], signature: str, raw_public_key: str) -> bool:
    try:
        sig = _decode_key(signature, length=64, label="升级签名")
        public_key(raw_public_key).verify(sig, canonical_bytes(payload))
        return True
    except Exception:
        return False


def trusted_public_keys() -> dict[str, str]:
    raw = str(get_settings().client_update_public_keys or "").strip()
    try:
        data = json.loads(raw) if raw else json.loads(
            (Path(__file__).resolve().parents[2] / "client-update-trust.json")
            .read_text(encoding="utf-8")
        )
    except Exception as exc:
        raise UpdateContractError("client update trust store is invalid") from exc
    keys = data.get("keys") if isinstance(data, dict) and "keys" in data else data
    if not isinstance(keys, dict) or not keys:
        raise UpdateContractError("client update trust store is empty")
    result: dict[str, str] = {}
    for key_id, value in keys.items():
        clean_id, clean_value = str(key_id), str(value or "").strip()
        if not KEY_ID_RE.fullmatch(clean_id):
            raise UpdateContractError("client update trust store has an invalid key id")
        public_key(clean_value)
        result[clean_id] = clean_value
    return result


def assert_trusted_release(release: Any) -> dict[str, Any]:
    payload = manifest_payload(release)
    key = trusted_public_keys().get(str(release.key_id or ""))
    if not key or not verify(payload, str(release.signature or ""), key):
        raise UpdateContractError("client release signature is not trusted")
    return payload


def assert_artifact_integrity(release: Any, path: Path) -> None:
    if not path.is_file():
        raise UpdateContractError("client release artifact is missing")
    stat_result = path.stat()
    expected_size = int(release.artifact_size or 0)
    expected_sha = str(release.sha256 or "").lower()
    if stat_result.st_size != expected_size:
        raise UpdateContractError("client release artifact size changed")
    cache_key = str(path)
    marker = (
        stat_result.st_ino,
        stat_result.st_ctime_ns,
        stat_result.st_mtime_ns,
        stat_result.st_size,
        expected_sha,
    )
    if _ARTIFACT_VERIFIED.get(cache_key) == marker:
        return
    if sha256_file(path) != expected_sha:
        raise UpdateContractError("client release artifact digest changed")
    if len(_ARTIFACT_VERIFIED) >= 128:
        _ARTIFACT_VERIFIED.clear()
    _ARTIFACT_VERIFIED[cache_key] = marker


async def assert_artifact_integrity_async(release: Any) -> None:
    # Snapshot loaded attributes here: a worker must never access ORM/session state.
    snapshot = SimpleNamespace(artifact_size=release.artifact_size, sha256=release.sha256)
    relative = str(release.artifact_path)

    def verify():
        path = safe_artifact_path(relative)
        with client_release_files.artifact_lock(path):
            assert_artifact_integrity(snapshot, path)

    await client_release_files.disk_call(verify)


# Allow multiple package formats for the same channel, platform, architecture, and version.
# Update checks choose one in deterministic order: deb, rpm, tar.gz, then appimage.
# Other packages remain alternative downloads; incompatible silent-update plans require manual installation.
_FORMAT_RANK: tuple[tuple[str, int], ...] = (
    (".deb", 0), (".rpm", 1), (".tar.gz", 2), (".appimage", 3),
)


def format_rank(artifact_name: str) -> int:
    lowered = str(artifact_name or "").lower()
    for suffix, rank in _FORMAT_RANK:
        if lowered.endswith(suffix):
            return rank
    return len(_FORMAT_RANK)


def installer_brand_rank(artifact_name: str) -> int:
    """Rank the canonical public filename."""
    name = str(artifact_name or "").lower()
    for rank, prefix in enumerate(("soduwork-",)):
        if name.startswith(prefix):
            return rank
    return 1


def installer_supported_by_client(artifact_name: str, current: str) -> bool:
    """Accept only the canonical SoduWork installer for the current client."""
    version = parse_version(current)
    if installer_brand_rank(artifact_name) > 0:
        return False
    minimum = (1, 12, 81)
    return version is not None and minimum is not None and version >= minimum


def release_root() -> Path:
    configured = str(get_settings().client_update_dir or "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path(__file__).resolve().parents[2] / "client-releases").resolve()


def _artifact_path_namespace(path: Path) -> Path:
    """Keep resolved Windows roots and descendants in one explicit namespace."""
    if not isinstance(path, PureWindowsPath) or not path.is_absolute():
        return path
    value = str(path)
    if value.startswith("\\\\?\\"):
        return path
    if re.fullmatch(r"[A-Za-z]:", path.drive):
        return type(path)("\\\\?\\" + value)
    if value.startswith("\\\\") and not value.startswith("\\\\.\\"):
        return type(path)("\\\\?\\UNC\\" + value[2:])
    return path


def safe_artifact_path(relative: str) -> Path:
    raw = str(relative or "").replace("\\", "/").strip("/")
    if not raw or any(part in {"", ".", ".."} for part in raw.split("/")):
        raise UpdateContractError("安装包路径无效")
    # Parent creation can change realpath's missing-path error and prefix choice.
    root = _artifact_path_namespace(release_root())
    target = (root / Path(*raw.split("/"))).resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise UpdateContractError("安装包路径越界") from exc
    return target


def manifest_payload(release: Any) -> dict[str, Any]:
    version = str(release.version or "")
    if parse_version(version) is None:
        raise UpdateContractError("发布版本必须是 x.y.z")
    sha = str(release.sha256 or "").lower()
    if not SHA256_RE.fullmatch(sha):
        raise UpdateContractError("安装包摘要无效")
    key_id = str(release.key_id or "")
    if not KEY_ID_RE.fullmatch(key_id):
        raise UpdateContractError("升级签名 key id 无效")
    created = release.created_at
    if created and created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    published = (created.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
                 if created else "")
    return {
        "schema": 1,
        "releaseId": str(release.id),
        "version": version,
        "channel": str(release.channel or "stable"),
        "platform": str(release.platform or "win32"),
        "arch": str(release.arch or "x64"),
        "artifact": {
            "name": str(release.artifact_name or ""),
            "size": int(release.artifact_size or 0),
            "sha256": sha,
            "url": "/api/v1/client-updates/artifacts/" + str(release.id),
        },
        "mandatory": bool(release.mandatory),
        "minVersion": str(release.min_version or ""),
        "notes": str(release.notes or ""),
        "publishedAt": published,
        "keyId": key_id,
    }


def signed_manifest(release: Any) -> dict[str, Any]:
    return {**manifest_payload(release), "signature": str(release.signature or "")}


def _text(value, limit: int) -> str:
    return str(value or "").strip()[:limit]


RELEASE_ARCHES = frozenset({"x64", "arm64"})
# Platform -> allowed installer suffixes. Filenames stay the identity of a
# target: win keeps the historical -Setup.exe name, mac/linux accept the
# electron-builder artifact with or without the arch segment.
RELEASE_PLATFORM_SUFFIXES: dict[str, frozenset[str]] = {
    "win32": frozenset({".exe"}),
    "darwin": frozenset({".dmg", ".zip"}),
    # tar.gz is a double suffix: Path.suffix alone would only see ".gz".
    "linux": frozenset({".appimage", ".deb", ".rpm", ".tar.gz"}),
    "android": frozenset({".apk"}),
}


# Accept only current SoduWork packages.
_INSTALLER_STEM = r"SoduWork"


def _expected_installer_names(platform: str, arch: str, version: str) -> set[str]:
    if platform == "android":
        return {f"SoduWork-Mobile-{version}.apk"}
    base = "mac" if platform == "darwin" else platform
    if platform == "win32":
        return {f"SoduWork-{version}-Setup.exe"}
    names = set()
    for inner in (f"SoduWork-{version}-{base}-{arch}", f"SoduWork-{version}-{base}"):
        for suffix in RELEASE_PLATFORM_SUFFIXES[platform]:
            names.add(f"{inner}{suffix}")
    return names


def release_from_bundle(bundle: dict, installer: Path) -> SimpleNamespace:
    """Validate one signed immutable bundle against the exact installer bytes."""
    if not isinstance(bundle, dict):
        raise UpdateContractError("unsupported client release bundle schema")
    try:
        schema = int(bundle.get("schema") or 0)
        artifact = bundle.get("artifact") if isinstance(bundle.get("artifact"), dict) else {}
        artifact_size = int(artifact.get("size") or 0)
    except (TypeError, ValueError) as exc:
        raise UpdateContractError("client release bundle has invalid numeric fields") from exc
    if schema != 1:
        raise UpdateContractError("unsupported client release bundle schema")
    published = _text(bundle.get("publishedAt"), 64)
    try:
        created_at = datetime.fromisoformat(published.replace("Z", "+00:00"))
    except Exception as exc:
        raise UpdateContractError("client release publishedAt is invalid") from exc
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    candidate = SimpleNamespace(
        id=_text(bundle.get("releaseId"), 36),
        version=_text(bundle.get("version"), 32),
        channel=_text(bundle.get("channel") or "stable", 16),
        platform=_text(bundle.get("platform") or "win32", 16),
        arch=_text(bundle.get("arch") or "x64", 16),
        artifact_name=_text(artifact.get("name"), 160),
        artifact_path="",
        artifact_size=artifact_size,
        sha256=_text(artifact.get("sha256"), 64).lower(),
        signature=_text(bundle.get("signature"), 128),
        key_id=_text(bundle.get("keyId"), 64),
        notes=_text(bundle.get("notes"), 20000),
        mandatory=bool(bundle.get("mandatory")),
        min_version=_text(bundle.get("minVersion"), 32),
        enabled=False,
        created_by="deployment",
        created_at=created_at.astimezone(timezone.utc),
    )
    try:
        uuid.UUID(candidate.id)
    except Exception as exc:
        raise UpdateContractError("client release id is invalid") from exc
    if parse_version(candidate.version) is None:
        raise UpdateContractError("client release version is invalid")
    if candidate.min_version and parse_version(candidate.min_version) is None:
        raise UpdateContractError("client release minimum version is invalid")
    if candidate.channel not in {"stable", "beta"}:
        raise UpdateContractError("client release channel is invalid")
    suffixes = RELEASE_PLATFORM_SUFFIXES.get(candidate.platform)
    arches = {"universal"} if candidate.platform == "android" else RELEASE_ARCHES
    if suffixes is None or candidate.arch not in arches:
        raise UpdateContractError("client release target is invalid")
    expected_names = _expected_installer_names(
        candidate.platform, candidate.arch, candidate.version)

    def _name_ok(name: str) -> bool:
        if name in expected_names:
            return True
        # AppImage is emitted capitalized; compare the suffix case-insensitively
        stem, dot, ext = name.rpartition(".")
        return bool(dot) and f"{stem}.{ext.lower()}" in expected_names

    if not _name_ok(candidate.artifact_name) or not _name_ok(installer.name):
        raise UpdateContractError("installer filename does not match the signed version")
    lowered_installer = installer.name.lower()
    if (not installer.is_file()
            or not any(lowered_installer.endswith(suffix) for suffix in suffixes)):
        raise UpdateContractError(
            "installer must be an existing " + "/".join(sorted(suffixes)))
    if candidate.artifact_size < 1024 * 1024:
        raise UpdateContractError("installer is too small")
    if installer.stat().st_size != candidate.artifact_size:
        raise UpdateContractError("installer size does not match the signed bundle")
    if sha256_file(installer) != candidate.sha256:
        raise UpdateContractError("installer digest does not match the signed bundle")
    payload = assert_trusted_release(candidate)
    if bundle != {**payload, "signature": candidate.signature}:
        raise UpdateContractError("bundle contains unsigned or unknown fields")
    return candidate


def _same_release(row: ClientRelease, bundle: dict) -> bool:
    try:
        return signed_manifest(row) == bundle
    except UpdateContractError:
        return False

async def _find_release(session: AsyncSession, candidate) -> ClientRelease | None:
    """Deduplicate by release identity including artifact_name, allowing different package formats
    for one version.
    """
    existing_id = await session.get(ClientRelease, candidate.id)
    if existing_id is not None:
        return existing_id
    return (await session.execute(select(ClientRelease).where(
        ClientRelease.channel == candidate.channel,
        ClientRelease.platform == candidate.platform,
        ClientRelease.arch == candidate.arch,
        ClientRelease.version == candidate.version,
        ClientRelease.artifact_name == candidate.artifact_name,
    ))).scalar_one_or_none()




def _store_release_artifact(candidate: SimpleNamespace, source: Path) -> str:
    relative = (
        f"{candidate.channel}/{candidate.platform}/{candidate.arch}/"
        f"{candidate.version}/{candidate.artifact_name}"
    )
    target = safe_artifact_path(relative)
    with client_release_files.artifact_lock(target):
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            if target.stat().st_size != candidate.artifact_size or sha256_file(target) != candidate.sha256:
                raise UpdateContractError("immutable client artifact path already contains other bytes")
        else:
            temp = target.with_name(uuid.uuid4().hex + ".incoming")
            try:
                shutil.copyfile(source, temp)
                # os.replace / os.link would be cleaner, but filesystem filter
                # drivers (e.g. Esafenet on Windows) reject MoveFileExW and
                # hard-link onto *.tar.gz targets. A plain exclusive write is the
                # only portable primitive; the DB row is only committed after the
                # integrity check below, so a partial file stays unreachable.
                if not target.exists():
                    with open(target, "xb") as out, open(temp, "rb") as stream:
                        shutil.copyfileobj(stream, out)
                        out.flush()
                        os.fsync(out.fileno())
            except FileExistsError:
                # Another exact retry won the artifact race.
                pass
            finally:
                temp.unlink(missing_ok=True)
            if (target.stat().st_size != candidate.artifact_size
                    or sha256_file(target) != candidate.sha256):
                raise UpdateContractError(
                    "immutable client artifact path already contains other bytes")
    return relative


async def import_signed_release(
    session: AsyncSession,
    bundle: dict,
    installer: Path,
    *,
    enabled: bool = False,
    created_by: str = "deployment",
) -> tuple[ClientRelease, bool]:
    """Import a verified installer once; exact retries are idempotent."""
    source = await client_release_files.disk_call(Path(installer).resolve)
    candidate = await client_release_files.disk_call(release_from_bundle, bundle, source)
    existing = await _find_release(session, candidate)
    if existing is not None:
        if not _same_release(existing, bundle):
            raise UpdateContractError("immutable client release artifact already exists")
        await assert_artifact_integrity_async(existing)
        return existing, False

    relative = await client_release_files.disk_call(_store_release_artifact, candidate, source)

    row = ClientRelease(
        id=candidate.id,
        version=candidate.version,
        channel=candidate.channel,
        platform=candidate.platform,
        arch=candidate.arch,
        artifact_name=candidate.artifact_name,
        artifact_path=relative,
        artifact_size=candidate.artifact_size,
        sha256=candidate.sha256,
        signature=candidate.signature,
        key_id=candidate.key_id,
        notes=candidate.notes,
        mandatory=candidate.mandatory,
        min_version=candidate.min_version,
        enabled=bool(enabled),
        created_by=_text(created_by, 36),
        created_at=candidate.created_at,
    )
    session.add(row)
    try:
        await session.commit()
        await session.refresh(row)
    except Exception as exc:
        await session.rollback()
        collision = None
        try:
            collision = await _find_release(session, candidate)
            if collision is not None and _same_release(collision, bundle):
                await assert_artifact_integrity_async(collision)
                return collision, False
            # A completed immutable file can be reused on retry. Do not unlink
            # after a DB failure: another request/replica may have committed a
            # reference while this transaction was rolling back.
        except Exception:
            # Prefer a harmless orphan over deleting an artifact a concurrent
            # committed release may already reference.
            pass
        if collision is not None:
            raise UpdateContractError(
                "immutable client release artifact already exists") from exc
        raise
    return row, True


async def discard_staged_release(session: AsyncSession, release_id: str) -> bool:
    """Delete a disabled, unused release after a failed build/deploy attempt."""
    row = await session.get(ClientRelease, str(release_id or ""))
    if row is None or row.enabled:
        return False
    attempts = int((await session.execute(select(func.count(ClientUpdateAttempt.id)).where(
        ClientUpdateAttempt.release_id == row.id))).scalar_one() or 0)
    if attempts:
        return False
    target = safe_artifact_path(row.artifact_path)
    tombstone = target.with_name(target.name + ".discard-" + uuid.uuid4().hex)
    moved = False
    try:
        if target.is_file():
            target.replace(tombstone)
            moved = True
        await session.delete(row)
        await session.commit()
    except Exception:
        await session.rollback()
        if moved and tombstone.exists() and not target.exists():
            tombstone.replace(target)
        raise
    tombstone.unlink(missing_ok=True)
    return True


def validate_transition(before: str, after: str) -> None:
    old, new = str(before or "queued"), str(after or "")
    if new not in UPDATE_STATES:
        raise UpdateContractError("未知升级状态")
    if new == old:
        return
    if new not in TRANSITIONS.get(old, set()):
        raise UpdateContractError(f"升级状态不能从 {old} 变为 {new}")
