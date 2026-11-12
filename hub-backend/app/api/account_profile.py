"""Account self-service uses identity authentication, never an AI quota check."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..account_models import UserConsent
from ..account_privacy_models import AccountPrivacyRequest
from ..automation_models import RunnerNode
from ..db import get_session
from ..deps import authenticated_client, require_perm
from ..models import AiSchedule, AuditLog, Client, Task, User
from ..services import account_legal, account_privacy, account_security, audit, device_connections, email_auth
from .client_auth import _safe_user, _access_error
from ..services.client_access import ClientAccessError
from ..services import client_access

log = logging.getLogger(__name__)

class AccountRoute(APIRoute):
    conflict_code = "ACCOUNT_CONFLICT"
    conflict_message = "账号信息发生冲突，请刷新后重试"
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def handle(request):
            try:
                response = await handler(request)
                response.headers["Cache-Control"] = "no-store"
                return response
            except ClientAccessError as exc:
                raise _access_error(exc) from exc
            except IntegrityError:
                raise account_security.error(409, self.conflict_code, self.conflict_message) from None
        return handle


router = APIRouter(prefix="/api/v1/client-auth", tags=["account"], route_class=AccountRoute)
admin_router = APIRouter(prefix="/api/v1/admin", tags=["account administration"])


class StrictBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProfileUpdate(StrictBody):
    displayName: str | None = Field(None, min_length=1, max_length=64)
    avatarDataUrl: str | None = Field(None, max_length=750_000)


class Challenge(StrictBody):
    purpose: Literal["reauthentication", "change_email"]
    email: str | None = Field(None, max_length=254)


class Verification(StrictBody):
    purpose: Literal["change_email", "change_password", "export", "delete_account", "devices"]
    password: str | None = Field(None, max_length=128)
    challengeId: str | None = Field(None, max_length=36)
    code: str | None = Field(None, pattern=r"^\d{6}$")


class VerifiedAction(StrictBody):
    verificationToken: str = Field(min_length=32, max_length=128)


class EmailChange(VerifiedAction):
    email: str = Field(max_length=254)
    challengeId: str = Field(max_length=36)
    code: str = Field(pattern=r"^\d{6}$")


class Deletion(VerifiedAction):
    confirmation: Literal["注销账号"]


class LegalSettings(StrictBody):
    operatorName: str = Field(min_length=1, max_length=120)
    contactEmail: str = Field(min_length=3, max_length=254)


@router.get("/legal-documents")
async def legal_documents(session: AsyncSession = Depends(get_session)):
    return await account_legal.documents(session)


@router.patch("/me")
async def update_profile(body: ProfileUpdate, client: Client = Depends(authenticated_client),
                         session: AsyncSession = Depends(get_session)):
    user = await account_security.owner(session, client)
    values = {}
    if body.displayName is not None:
        name = body.displayName.strip()
        if not name or any(ord(c) < 32 for c in name):
            raise account_security.error(422, "INVALID_NAME", "昵称不能为空或包含控制字符")
        values["display_name"] = name
    if body.avatarDataUrl is not None:
        values["avatar_url"] = await asyncio.to_thread(account_security.sanitize_avatar, body.avatarDataUrl)
    if values:
        result = await session.execute(update(User).where(
            User.id == user.id, User.is_active.is_(True), User.account_deleted_at.is_(None),
            User.auth_version == user.auth_version
        ).values(**values).execution_options(synchronize_session=False))
        if result.rowcount != 1:
            raise account_security.error(401, "ACCOUNT_UNAVAILABLE", "账号状态已变化，请重新登录")
    await session.commit()
    await session.refresh(user)
    await audit.log(session, user, "account.profile.update", "user", user.id,
                    detail={"fields": list(body.model_fields_set)})
    return {"user": _safe_user(user)}


@router.post("/me/email-challenges")
async def sensitive_challenge(body: Challenge, client: Client = Depends(authenticated_client),
                              session: AsyncSession = Depends(get_session)):
    user = await account_security.owner(session, client)
    email = user.email if body.purpose == "reauthentication" else body.email
    if body.purpose == "reauthentication" and not user.email_verified_at:
        raise account_security.error(409, "EMAIL_NOT_VERIFIED", "请先使用密码验证身份")
    return await email_auth.request_challenge(session, email=email or "", purpose=body.purpose,
                                              device_id=client.id, user_id=user.id)


@router.post("/me/verification")
async def verify_identity(body: Verification, client: Client = Depends(authenticated_client),
                          session: AsyncSession = Depends(get_session)):
    user = await account_security.owner(session, client)
    return await account_security.grant(session, user, client, body.model_dump())


@router.get("/me/devices")
async def devices(client: Client = Depends(authenticated_client), session: AsyncSession = Depends(get_session)):
    rows = (await session.execute(select(Client).where(Client.user_ref == client.user_ref,
                                                        Client.auth_state == "active"))).scalars().all()
    return {"items": [{"id": row.id, "name": row.name, "platform": row.platform,
                        "lastSeenAt": row.last_seen_at.isoformat() if row.last_seen_at else None,
                        "current": row.id == client.id, "active": row.auth_state == "active"} for row in rows]}


@router.delete("/me/devices/{device_id}")
async def revoke_device(device_id: str, body: VerifiedAction, client: Client = Depends(authenticated_client),
                        session: AsyncSession = Depends(get_session)):
    user = await account_security.owner(session, client)
    target = await session.get(Client, device_id)
    if not target or target.user_ref != user.id:
        raise account_security.error(404, "DEVICE_NOT_FOUND", "设备不存在")
    if device_id == client.id:
        raise account_security.error(409, "CURRENT_DEVICE_REMOVAL_FORBIDDEN", "不能删除当前登录设备")
    await account_security.consume_grant(session, user, client, body.verificationToken, "devices")
    ids = await account_security.revoke_devices(session, user, device_id=device_id)
    if device_id not in ids:
        # The device may have changed owners after the initial lookup. Reject
        # without committing the one-use grant or disconnecting its new owner.
        raise account_security.error(404, "DEVICE_NOT_FOUND", "设备不存在")
    session.add(AuditLog(actor_id=user.id, actor_name=user.display_name or user.username,
        actor_org_id=user.org_id, action="account.device.revoke", target_type="client", target_id=device_id))
    await session.commit()
    # Authentication is already revoked durably. A stale channel must not turn
    # a committed removal into an apparent failure or prevent the list refresh.
    try:
        await asyncio.wait_for(device_connections.disconnect(device_id, 4401), timeout=5)
    except Exception as exc:
        log.warning("Account device removal channel cleanup incomplete: %s", type(exc).__name__)
    return {"ok": True, "logoutRequired": False}


@router.post("/me/email-change")
async def change_email(body: EmailChange, client: Client = Depends(authenticated_client),
                       session: AsyncSession = Depends(get_session)):
    user = await account_security.owner(session, client)
    email = email_auth.normalize_email(body.email)
    try:
        # Wrong OTP attempts remain durable; successful proofs join the change transaction.
        await email_auth.consume_challenge(session, challenge_id=body.challengeId, email=email,
            purpose="change_email", device_id=client.id, code=body.code, user_id=user.id)
        await account_security.consume_grant(session, user, client, body.verificationToken, "change_email")
        if email == user.email_normalized:
            raise account_security.error(409, "EMAIL_UNCHANGED", "请输入新的邮箱地址")
        registered = await session.scalar(select(User.id).where(User.email_normalized == email, User.id != user.id))
        if registered:
            raise account_security.error(409, "EMAIL_UNAVAILABLE", "此邮箱无法绑定，请使用其他邮箱")
        legacy = await client_access.find_user(session, email)
        if legacy and legacy.id != user.id:
            raise account_security.error(409, "EMAIL_UNAVAILABLE", "此邮箱无法绑定，请使用其他邮箱")
        result = await session.execute(update(User).where(
            User.id == user.id, User.is_active.is_(True), User.account_deleted_at.is_(None),
            User.auth_version == user.auth_version
        ).values(email=email, email_normalized=email, email_verified_at=datetime.now(timezone.utc),
                 auth_version=User.auth_version+1).execution_options(synchronize_session=False))
        if result.rowcount != 1:
            raise account_security.error(401, "ACCOUNT_UNAVAILABLE", "账号状态已变化，请重新登录")
        await session.refresh(user)
        ids = await account_security.revoke_devices(session, user)
        session.add(AuditLog(actor_id=user.id, actor_name=user.display_name or user.username,
            actor_org_id=user.org_id, action="account.email.change", target_type="user", target_id=user.id))
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise account_security.error(409, "EMAIL_UNAVAILABLE", "此邮箱无法绑定，请使用其他邮箱") from None
    except Exception:
        await session.rollback()
        raise
    try:
        results = await asyncio.wait_for(asyncio.gather(
            *(device_connections.disconnect(item, 4401) for item in ids), return_exceptions=True), timeout=5)
        if any(isinstance(result, BaseException) for result in results):
            log.warning("Email change channel cleanup incomplete")
    except Exception as exc:
        log.warning("Email change channel cleanup incomplete: %s", type(exc).__name__)
    return {"ok": True, "logoutRequired": True}


@router.get("/me/privacy")
async def privacy(client: Client = Depends(authenticated_client), session: AsyncSession = Depends(get_session)):
    from ..services.legal_publications import receipt_details
    evidence = {(item["document"], item["version"]): item for item in await receipt_details(session, client.user_ref)}
    consents = (await session.execute(select(UserConsent).where(UserConsent.user_id == client.user_ref)
                                      .order_by(UserConsent.accepted_at.desc()))).scalars().all()
    requests = (await session.execute(select(AccountPrivacyRequest).where(
        AccountPrivacyRequest.user_id == client.user_ref).order_by(AccountPrivacyRequest.created_at.desc())
        .limit(30))).scalars().all()
    return {"consents": [{"document": row.document, "version": row.version,
                           "acceptedAt": row.accepted_at.isoformat(), **evidence.get((row.document, row.version), {})} for row in consents],
            "documents": (await account_legal.documents(session))["documents"],
            "requests": [account_privacy.public_request(row) for row in requests],
            "scopeSummary": account_privacy.SCOPE_SUMMARY,
            "deletionScopeSummary": account_privacy.DELETION_SCOPE_SUMMARY}


@router.post("/me/exports", status_code=202)
async def request_export(body: VerifiedAction, client: Client = Depends(authenticated_client),
                         session: AsyncSession = Depends(get_session)):
    user = await account_security.owner(session, client)
    await account_security.consume_grant(session, user, client, body.verificationToken, "export")
    existing = (await session.execute(select(AccountPrivacyRequest).where(
        AccountPrivacyRequest.user_id == user.id, AccountPrivacyRequest.kind == "export",
        AccountPrivacyRequest.status.in_(["queued", "processing"])).limit(1))).scalar_one_or_none()
    if existing:
        await session.commit()
        return account_privacy.public_request(existing)
    row = AccountPrivacyRequest(user_id=user.id, kind="export", status="queued")
    session.add(row)
    await session.commit()
    return account_privacy.public_request(row)


async def owned_export(session, client, request_id):
    row = await session.get(AccountPrivacyRequest, request_id)
    if not row or row.user_id != client.user_ref or row.kind != "export":
        raise account_security.error(404, "EXPORT_NOT_FOUND", "导出记录不存在")
    if row.expires_at and account_privacy.aware(row.expires_at) <= account_privacy.now():
        row.status = "expired"
        row.result_encrypted = ""
        await session.commit()
    return row


@router.get("/me/exports/{request_id}")
async def export_status(request_id: str, client: Client = Depends(authenticated_client),
                        session: AsyncSession = Depends(get_session)):
    return account_privacy.public_request(await owned_export(session, client, request_id))


@router.get("/me/exports/{request_id}/download")
async def export_download(request_id: str, client: Client = Depends(authenticated_client),
                          session: AsyncSession = Depends(get_session)):
    row = await owned_export(session, client, request_id)
    if row.status != "completed" or not row.result_encrypted:
        raise account_security.error(409, "EXPORT_NOT_READY", "导出尚未完成或已过期，请重新导出")
    try:
        content = await asyncio.to_thread(account_privacy.cipher().decrypt, row.result_encrypted.encode())
    except Exception:
        raise account_security.error(503, "EXPORT_UNAVAILABLE", "导出暂时不可读取，请重新导出") from None
    return Response(content, media_type="application/zip", headers={
        "Cache-Control": "no-store", "Content-Disposition": 'attachment; filename="SoduWork-personal-data.zip"'})


@router.post("/me/deletion", status_code=202)
async def delete_account(body: Deletion, client: Client = Depends(authenticated_client),
                         session: AsyncSession = Depends(get_session)):
    user = await account_security.owner(session, client)
    if user.is_super:
        # Even when another super exists, ownership handover should be explicit.
        raise account_security.error(409, "ADMIN_HANDOVER_REQUIRED", "请先由其他管理员移交并取消你的超级管理员身份")
    doing = (await session.execute(select(Task.id).where(Task.status == "doing", or_(
        Task.assignee_user_id == user.id, Task.owner_user_id == user.id))
        .limit(1))).scalar_one_or_none()
    if doing:
        raise account_security.error(409, "ACTIVE_WORK_REQUIRES_HANDOVER", "请先停止或移交正在执行的任务，再注销账号")
    await account_security.consume_grant(session, user, client, body.verificationToken, "delete_account")
    result = await session.execute(update(User).where(
        User.id == user.id, User.is_active.is_(True), User.account_deleted_at.is_(None),
        User.auth_version == user.auth_version
    ).values(is_active=False, account_deleted_at=datetime.now(timezone.utc),
             auth_version=User.auth_version+1).execution_options(synchronize_session=False))
    if result.rowcount != 1:
        raise account_security.error(401, "ACCOUNT_UNAVAILABLE", "账号状态已变化，请重新登录")
    await session.refresh(user)
    ids = await account_security.revoke_devices(session, user, erase_private=True)
    # A device may have hosted other accounts. Deleting its current account
    # must not disable the previous account's automations or execution nodes.
    await session.execute(update(AiSchedule).where(or_(
        AiSchedule.created_by == user.id, AiSchedule.owner_user_id == user.id)).values(enabled=False))
    runners = (await session.execute(select(RunnerNode).where(
        RunnerNode.owner_user_id == user.id))).scalars().all()
    for runner in runners:
        runner.auth_state = "revoked"
        runner.secret_hash = ""
        runner.dispatch_mode = "disabled"
        runner.management_state = "disabled"
    await session.execute(update(AccountPrivacyRequest).where(AccountPrivacyRequest.user_id == user.id,
        AccountPrivacyRequest.kind == "export").values(status="expired", result_encrypted="", claim_token=""))
    row = AccountPrivacyRequest(user_id=user.id, kind="deletion", status="queued")
    session.add(row)
    await session.flush()
    request_id = row.id
    # Keep the identity revocation, durable cleanup request and its audit evidence
    # atomic. A failed audit write must leave the account and proof retryable.
    session.add(AuditLog(actor_id=user.id, actor_name=user.display_name or user.username,
        actor_org_id=user.org_id, action="account.deletion.request", target_type="user",
        target_id=user.id, detail={"requestId": request_id}))
    await session.commit()
    from ..services import runner_hub
    # Sessions are already invalid in the database. A stale socket or unavailable
    # cluster peer must not turn an accepted deletion into an apparent failure,
    # nor prevent cleanup of the remaining devices and runners.
    closing = [device_connections.disconnect(item, 4401) for item in ids]
    closing.extend(runner_hub.disconnect_runner(runner.id, 4401) for runner in runners)
    results = await asyncio.gather(*(asyncio.wait_for(action, timeout=5) for action in closing),
                                   return_exceptions=True)
    for result in results:
        if isinstance(result, BaseException):
            log.warning("Account deletion channel cleanup incomplete: %s", type(result).__name__)
    return {"ok": True, "status": "processing", "logoutRequired": True, "requestId": request_id}


@admin_router.get("/account-legal")
async def admin_legal(session: AsyncSession = Depends(get_session), admin=Depends(require_perm("identity.manage"))):
    return {**await account_legal.settings(session), "canEdit": bool(admin.is_super)}


@admin_router.put("/account-legal")
async def save_legal(body: LegalSettings, session: AsyncSession = Depends(get_session),
                     admin=Depends(require_perm("identity.manage"))):
    if not admin.is_super:
        raise HTTPException(status_code=403, detail="需要超级管理员权限")
    try:
        result = await account_legal.save_settings(session, body.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    await session.commit()
    await audit.log(session, admin, "account.legal.configure", "setting", "account_legal_v1")
    return result


@admin_router.get("/account-privacy-requests")
async def admin_privacy(session: AsyncSession = Depends(get_session), admin=Depends(require_perm("identity.manage"))):
    # Cross-organization records are only for the existing global administrator.
    if not admin.is_super:
        raise HTTPException(status_code=403, detail="需要超级管理员权限")
    rows = (await session.execute(select(AccountPrivacyRequest).order_by(
        AccountPrivacyRequest.created_at.desc()).limit(100))).scalars().all()
    return {"items": [account_privacy.public_request(row) for row in rows]}


@admin_router.post("/account-privacy-requests/{request_id}/retry")
async def retry_privacy(request_id: str, session: AsyncSession = Depends(get_session),
                        admin=Depends(require_perm("identity.manage"))):
    if not admin.is_super:
        raise HTTPException(status_code=403, detail="需要超级管理员权限")
    row = await session.get(AccountPrivacyRequest, request_id)
    if not row or row.kind != "deletion" or row.status != "failed":
        raise HTTPException(status_code=409, detail="此请求无需重试")
    row.status, row.attempts, row.next_attempt_at, row.error_code = "queued", 0, None, ""
    await session.commit()
    await audit.log(session, admin, "account.deletion.retry", "privacy_request", row.id)
    return account_privacy.public_request(row)
