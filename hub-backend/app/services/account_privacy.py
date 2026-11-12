"""Durable, owner-scoped privacy jobs. Failed storage cleanup is never completion."""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import re
import secrets
import zipfile
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from sqlalchemy import delete, or_, select, update

from ..account_models import EmailChallenge, UserConsent
from ..account_privacy_models import AccountActionGrant, AccountPrivacyRequest
from ..automation_models import PluginInstallation, RunnerNode
from ..config import get_settings
from .. import im_models as im
from ..library_models import LibraryFolder, LibraryItem
from ..mail_models import MailOutbox
from ..memory_record_models import MemoryRecord
from ..models import AppSetting, DailyReport, IdentityLink, User
from ..session_memory_models import SessionMemory
from . import library_storage

log = logging.getLogger(__name__)
MAX_EXPORT_BYTES = 64 * 1024 * 1024
SCOPE_SUMMARY = (
    "导出包含账号资料、协议记录、个人资料库文件与个人记忆，下载有效期24小时，单次上限64MB。"
    "注销会清理这些个人数据并撤销登录；组织需求、已共享材料和必要审计记录保留。"
    "设备本地对话、文件及第三方服务的数据需在对应设备或服务中管理。"
)
DELETION_SCOPE_SUMMARY = (
    "注销会清理账号资料、个人资料库文件与个人记忆，并撤销登录；组织需求、已共享材料和必要审计记录保留。"
    "设备本地对话、文件及第三方服务的数据需在对应设备或服务中管理。"
)


def now():
    return datetime.now(timezone.utc)


def aware(value):
    return value.replace(tzinfo=timezone.utc) if value and value.tzinfo is None else value


def cipher():
    key = get_settings().auth_secret
    derived = HKDF(algorithm=hashes.SHA256(), length=32, salt=b"soduwork-privacy-v1",
                   info=b"account-export").derive(key.encode())
    return Fernet(base64.urlsafe_b64encode(derived))


def public_request(row):
    result = {"id": row.id, "kind": row.kind, "status": row.status,
              "createdAt": row.created_at.isoformat(), "errorCode": row.error_code,
              "expiresAt": row.expires_at.isoformat() if row.expires_at else None}
    if row.kind == "export" and row.status == "completed":
        result.update(filename="SoduWork-personal-data.zip",
                      downloadUrl=f"/api/v1/client-auth/me/exports/{row.id}/download")
    return result


def _json(value):
    return json.dumps(value, ensure_ascii=False, indent=2, default=str).encode("utf-8")


def _fields(row, names):
    return {name: getattr(row, name) for name in names.split()}


async def build_export(session, user):
    """Explicit field lists avoid exporting tokens, device credentials or team data."""
    manifest = {"scope": SCOPE_SUMMARY, "generatedAt": now(),
                "profile": _fields(user, "id username display_name email email_verified_at avatar_url created_at"),
                "consents": [], "library": [], "folders": [], "memories": [], "sessionMemories": []}
    for model, predicate, key, fields in [
        (UserConsent, UserConsent.user_id == user.id, "consents", "document version accepted_at"),
        (LibraryFolder, LibraryFolder.owner_key == user.id, "folders", "id parent_id name"),
        (MemoryRecord, (MemoryRecord.owner_user_id == user.id) & (MemoryRecord.scope != "org"),
         "memories", "id scope title summary fields source_meta created_at updated_at"),
        (SessionMemory, SessionMemory.owner_user_id == user.id, "sessionMemories",
         "id title scope fields events created_at updated_at"),
    ]:
        rows = (await session.execute(select(model).where(predicate))).scalars().all()
        manifest[key] = [_fields(row, fields) for row in rows]
    from .legal_publications import receipt_details
    manifest["legalReceipts"] = await receipt_details(session, user.id, include_notices=True)
    total = len(_json(manifest))
    if total > MAX_EXPORT_BYTES:
        raise ValueError("EXPORT_TOO_LARGE")
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        items = (await session.execute(select(LibraryItem).where(
            LibraryItem.owner_key == user.id))).scalars().all()
        for item in items:
            record = _fields(item, "id folder_id kind title filename content_type size deleted_at")
            if item.storage_key:
                remaining = MAX_EXPORT_BYTES - total
                if remaining < 1 or (item.size or 0) > remaining:
                    raise ValueError("EXPORT_TOO_LARGE")
                try:
                    data = await asyncio.to_thread(library_storage.read_bytes, item.storage_key,
                                                   limit=remaining, backend=item.backend)
                except ValueError:
                    raise ValueError("EXPORT_TOO_LARGE") from None
                safe = re.sub(r"[^\w.\- ]", "_", str(item.filename or item.title))[:100].strip(" .") or "file"
                path = "library/" + re.sub(r"[^\w-]", "_", item.id) + "/" + safe
                archive.writestr(path, data)
                total += len(data)
                record["archivePath"] = path
            manifest["library"].append(record)
        document = _json(manifest)
        if total + len(document) > MAX_EXPORT_BYTES:
            raise ValueError("EXPORT_TOO_LARGE")
        archive.writestr("personal-data.json", document)
    return cipher().encrypt(output.getvalue()).decode()


async def _erase_im(session, user_id):
    """Erase personal transport data without following reassigned device ownership."""
    connection_ids = select(im.IMConnection.id).where(im.IMConnection.owner_user_id == user_id)
    inbox_ids = select(im.IMInbox.id).where(im.IMInbox.connection_id.in_(connection_ids))
    # Routes are shared task gates. Release only references to this account's messages.
    await session.execute(update(im.IMRoute).where(im.IMRoute.active_inbox_id.in_(inbox_ids)).values(
        active_inbox_id="", lease_token="", lease_until=None))
    for model in (im.IMOutbox, im.IMPairing, im.IMWebhookReceipt, im.IMBinding, im.IMInbox):
        await session.execute(delete(model).where(model.connection_id.in_(connection_ids)))
    # Keep the owner predicate authoritative until all dependent rows are removed.
    await session.execute(delete(im.IMConnection).where(im.IMConnection.owner_user_id == user_id))


async def erase_private(session, user):
    # Delete storage before metadata. A failure leaves enough evidence to retry.
    items = (await session.execute(select(LibraryItem).where(
        LibraryItem.owner_key == user.id))).scalars().all()
    for item in items:
        if item.storage_key:
            await asyncio.to_thread(library_storage.delete, item.storage_key, backend=item.backend)
        await session.delete(item)
    await _erase_im(session, user.id)
    # Clear pending mail for this account before removing the challenge rows.
    challenge_ids = select(EmailChallenge.id).where(or_(
        EmailChallenge.user_id == user.id,
        EmailChallenge.email_normalized == (user.email_normalized or "__none__")))
    await session.execute(update(MailOutbox).where(MailOutbox.challenge_id.in_(challenge_ids)).values(
        payload_encrypted="", state="expired", error_code="MAIL_EXPIRED", lease_id="", lease_until=None))
    for model, predicate in [
        (LibraryFolder, LibraryFolder.owner_key == user.id),
        (MemoryRecord, (MemoryRecord.owner_user_id == user.id) & (MemoryRecord.scope != "org")),
        (SessionMemory, SessionMemory.owner_user_id == user.id),
        (PluginInstallation, PluginInstallation.user_id == user.id),
        (IdentityLink, IdentityLink.user_id == user.id),
        (AccountActionGrant, AccountActionGrant.user_id == user.id),
        (EmailChallenge, or_(EmailChallenge.user_id == user.id,
                            EmailChallenge.email_normalized == (user.email_normalized or "__none__"))),
    ]:
        await session.execute(delete(model).where(predicate))
    # Reports can be organizational evidence, so anonymize attribution rather than erase them.
    await session.execute(update(DailyReport).where(DailyReport.user_id == user.id).values(user_name="已注销用户"))
    from . import connector_oauth
    records = (await session.execute(select(AppSetting).where(
        AppSetting.key.like(connector_oauth.PREFIX + "%")))).scalars().all()
    for row in records:
        # Registry/config rows have different prefixes. Only encrypted connection records
        # are considered; unknown ciphertext blocks completion for manual recovery.
        if not re.fullmatch(r"connector_oauth_(?:attempt|token)_[A-Za-z0-9_-]{32,64}", row.key):
            continue
        record = connector_oauth.unpack(row)
        if record.get("userId") == user.id:
            await session.delete(row)
    await session.execute(update(AccountPrivacyRequest).where(
        AccountPrivacyRequest.user_id == user.id, AccountPrivacyRequest.kind == "export"
    ).values(status="expired", result_encrypted="", expires_at=now(), claim_token=""))
    user.username = "deleted_" + user.id.replace("-", "")
    user.display_name = "已注销用户"
    user.email = None
    user.email_normalized = None
    user.email_verified_at = None
    user.avatar_url = ""
    user.password_hash = ""
    user.role_id = None
    user.is_super = False


async def process_once(factory=None):
    from ..db import SessionLocal
    factory = factory or SessionLocal
    async with factory() as session:
        await session.execute(delete(AccountActionGrant).where(
            AccountActionGrant.expires_at < now()-timedelta(days=1)))
        await session.execute(update(AccountPrivacyRequest).where(
            AccountPrivacyRequest.kind == "export", AccountPrivacyRequest.expires_at <= now(),
            AccountPrivacyRequest.result_encrypted != ""
        ).values(result_encrypted="", status="expired"))
        eligible = or_(AccountPrivacyRequest.status == "queued",
                       (AccountPrivacyRequest.status == "processing") &
                       (AccountPrivacyRequest.lease_expires_at <= now()))
        row = (await session.execute(select(AccountPrivacyRequest).where(
            eligible, or_(AccountPrivacyRequest.next_attempt_at.is_(None),
                          AccountPrivacyRequest.next_attempt_at <= now())
        ).order_by(AccountPrivacyRequest.created_at).limit(1))).scalar_one_or_none()
        if row is None:
            await session.commit()
            return False
        token = secrets.token_hex(16)
        claimed = await session.execute(update(AccountPrivacyRequest).where(
            AccountPrivacyRequest.id == row.id, eligible
        ).values(status="processing", claim_token=token, lease_expires_at=now()+timedelta(minutes=10),
                 attempts=AccountPrivacyRequest.attempts+1))
        await session.commit()
        if claimed.rowcount != 1:
            return False
        request_id, kind, user_id = row.id, row.kind, row.user_id
    try:
        async with factory() as session:
            user = await session.get(User, user_id)
            if user is None:
                raise ValueError("ACCOUNT_MISSING")
            encrypted = ""
            if kind == "export":
                if not user.is_active or user.account_deleted_at:
                    raise ValueError("ACCOUNT_CLOSED")
                encrypted = await asyncio.wait_for(build_export(session, user), timeout=300)
                # Deletion can revoke a job while storage is being read.
                await session.refresh(user)
                if not user.is_active or user.account_deleted_at:
                    raise ValueError("ACCOUNT_CLOSED")
            elif kind == "deletion" and user.account_deleted_at:
                await asyncio.wait_for(erase_private(session, user), timeout=300)
            else:
                raise ValueError("INVALID_PRIVACY_JOB")
            done = await session.execute(update(AccountPrivacyRequest).where(
                AccountPrivacyRequest.id == request_id, AccountPrivacyRequest.claim_token == token,
                AccountPrivacyRequest.status == "processing"
            ).values(status="completed", result_encrypted=encrypted, error_code="",
                     expires_at=now()+timedelta(hours=24) if encrypted else None,
                     lease_expires_at=None, claim_token=""))
            if done.rowcount == 1:
                await session.commit()
            else:
                await session.rollback()
    except Exception as exc:
        code = str(exc) if isinstance(exc, ValueError) and str(exc) in {
            "EXPORT_TOO_LARGE", "ACCOUNT_CLOSED", "ACCOUNT_MISSING", "INVALID_PRIVACY_JOB"
        } else "PRIVACY_STORAGE_UNAVAILABLE"
        async with factory() as session:
            row = await session.get(AccountPrivacyRequest, request_id)
            if row and row.claim_token == token:
                row.status = "failed" if row.attempts >= 5 or code != "PRIVACY_STORAGE_UNAVAILABLE" else "queued"
                row.error_code = code
                row.next_attempt_at = now()+timedelta(seconds=30*2**min(row.attempts, 5))
                row.claim_token = ""
                row.lease_expires_at = None
                await session.commit()
        log.warning("Privacy job %s: %s", request_id, code)
    return True


async def tick_loop():
    while True:
        try:
            processed = await process_once()
        except Exception:
            log.error("Privacy worker temporarily unavailable")
            processed = False
        await asyncio.sleep(0.2 if processed else 3)
