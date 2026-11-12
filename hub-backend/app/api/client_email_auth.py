"""Explicit email registration and dual login; device credentials remain mandatory."""
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import hash_password, verify_password
from ..db import get_session
from ..models import Client, User
from ..services import client_access, device_connections, email_auth
from ..services import legal_publications
from .client_auth import _access_error, _device_with_key, complete_login


router = APIRouter(prefix="/api/v1/client-auth", tags=["client-auth"])


class DeviceEmail(BaseModel):
    model_config = ConfigDict(extra="ignore")
    device: str = Field(min_length=3, max_length=64)
    email: str = Field(min_length=3, max_length=254)
    name: str = Field(default="", max_length=64)
    platform: str = Field(default="", max_length=32)
    version: str = Field(default="", max_length=32)
    workRoot: str = Field(default="", max_length=400)


class ChallengeRequest(DeviceEmail):
    purpose: str = Field(max_length=32)


class EmailProof(DeviceEmail):
    challengeId: str = Field(min_length=1, max_length=36)
    code: str = Field(pattern=r"^\d{6}$")


class Registration(EmailProof):
    password: str = Field(min_length=8, max_length=128)
    displayName: str = Field(default="", max_length=64)
    consents: dict[str, str] = Field(default_factory=dict)
    consentLocales: dict[str, str] = Field(default_factory=dict)


class PasswordLogin(DeviceEmail):
    password: str = Field(min_length=1, max_length=128)


class PasswordReset(EmailProof):
    newPassword: str = Field(min_length=8, max_length=128)


def _invalid_credentials():
    return client_access.ClientAccessError("邮箱或登录凭据不正确", code="ACCOUNT_OR_PASSWORD_INVALID", status=401)


async def _consume(session, body, purpose):
    return await email_auth.consume_challenge(session, challenge_id=body.challengeId,
        email=body.email, purpose=purpose, device_id=body.device, code=body.code)


@router.post("/email-challenges")
async def challenge(body: ChallengeRequest, request: Request,
                    x_device_key: str | None = Header(default=None, alias="X-Device-Key"),
                    session: AsyncSession = Depends(get_session)):
    await _device_with_key(session, body.device, x_device_key or "")
    try:
        if body.purpose not in email_auth.PUBLIC_PURPOSES:
            raise client_access.ClientAccessError("此验证码用途需要登录验证", code="CHALLENGE_PURPOSE_INVALID", status=422)
        if body.purpose == "register" and not (await client_access.policy(session))["allowSelfRegistration"]:
            raise client_access.ClientAccessError("自助注册已关闭", code="SELF_REGISTRATION_DISABLED", status=403)
        # Identical response and mail shape for existing and unknown accounts.
        return await email_auth.request_challenge(session, email=body.email, purpose=body.purpose,
            device_id=body.device, remote_ip=request.client.host if request.client else "")
    except client_access.ClientAccessError as exc:
        await session.rollback()
        raise _access_error(exc) from exc


@router.get("/email-challenges/{challenge_id}")
async def challenge_status(challenge_id: str, response: Response,
                           device: str = Query(min_length=3, max_length=64),
                           x_device_key: str | None = Header(default=None, alias="X-Device-Key"),
                           session: AsyncSession = Depends(get_session)):
    await _device_with_key(session, device, x_device_key or "")
    response.headers["Cache-Control"] = "no-store"
    try:
        return await email_auth.challenge_delivery(session, challenge_id=challenge_id, device_id=device)
    except client_access.ClientAccessError as exc:
        raise _access_error(exc) from exc


@router.post("/register")
async def register(body: Registration,
                   x_device_key: str | None = Header(default=None, alias="X-Device-Key"),
                   session: AsyncSession = Depends(get_session)):
    client = await _device_with_key(session, body.device, x_device_key or "")
    try:
        policy = await client_access.policy(session)
        if not policy["allowSelfRegistration"]:
            raise client_access.ClientAccessError("自助注册已关闭", code="SELF_REGISTRATION_DISABLED", status=403)
        await legal_publications.validate_registration(session, body.consents)
        password = client_access.validate_password(body.password, new_account=True)
        email = await _consume(session, body, "register")
        if await session.scalar(select(User.id).where(User.email_normalized == email)):
            raise client_access.ClientAccessError("此邮箱已注册，请直接登录", code="EMAIL_ALREADY_REGISTERED", status=409)
        # An email-shaped legacy username is not proof of ownership of that old account.
        if await client_access.find_user(session, email):
            raise client_access.ClientAccessError("此邮箱对应已有账号，请用原密码登录后绑定邮箱", code="LEGACY_EMAIL_BINDING_REQUIRED", status=409)
        org_id = await client_access.default_org_id(session, policy.get("defaultOrgId") or "")
        if not org_id:
            raise client_access.ClientAccessError("请管理员先配置默认组织", code="DEFAULT_ORG_REQUIRED", status=503)
        user = User(id=str(uuid4()), username=email if len(email) <= 64 else "email_" + uuid4().hex,
                    email=email, email_normalized=email, email_verified_at=datetime.now(timezone.utc),
                    password_hash=hash_password(password), display_name=body.displayName.strip() or email.split("@", 1)[0],
                    org_id=org_id, role_id=policy.get("defaultRoleId") or None, is_active=True, is_super=False)
        session.add(user)
        await legal_publications.register_receipts(session, user.id, client.id, body.consents, body.consentLocales)
        await session.flush()
        return await complete_login(session, client, user, body, created=True)
    except IntegrityError as exc:
        await session.rollback()
        raise _access_error(client_access.ClientAccessError("此邮箱已注册，请直接登录", code="EMAIL_ALREADY_REGISTERED", status=409)) from exc
    except client_access.ClientAccessError as exc:
        await session.rollback()
        raise _access_error(exc) from exc


@router.post("/login/password")
async def password_login(body: PasswordLogin,
                         x_device_key: str | None = Header(default=None, alias="X-Device-Key"),
                         session: AsyncSession = Depends(get_session)):
    client = await _device_with_key(session, body.device, x_device_key or "")
    try:
        email = email_auth.normalize_email(body.email)
        await email_auth.password_budget(session, email, client.id)
        user = await client_access.find_login_user(session, body.email)
        if user is None or not verify_password(body.password, user.password_hash):
            raise _invalid_credentials()
        return await complete_login(session, client, user, body)
    except client_access.ClientAccessError as exc:
        await session.rollback()
        raise _access_error(exc) from exc


@router.post("/login/email-code")
async def email_code_login(body: EmailProof,
                          x_device_key: str | None = Header(default=None, alias="X-Device-Key"),
                          session: AsyncSession = Depends(get_session)):
    client = await _device_with_key(session, body.device, x_device_key or "")
    try:
        email = await _consume(session, body, "login")
        user = await email_auth.verified_user(session, email)
        if user is None:
            # Ownership is proved before offering explicit registration; no account is created.
            await session.commit()
            raise client_access.ClientAccessError("此邮箱尚未注册，请先创建账号", code="ACCOUNT_NOT_REGISTERED", status=404)
        return await complete_login(session, client, user, body)
    except client_access.ClientAccessError as exc:
        await session.rollback()
        raise _access_error(exc) from exc


@router.post("/password/reset")
async def password_reset(body: PasswordReset,
                         x_device_key: str | None = Header(default=None, alias="X-Device-Key"),
                         session: AsyncSession = Depends(get_session)):
    await _device_with_key(session, body.device, x_device_key or "")
    try:
        password = client_access.validate_password(body.newPassword, new_account=True)
        email = await _consume(session, body, "reset_password")
        user = await email_auth.verified_user(session, email)
        if user is not None:
            await session.refresh(user, with_for_update=True)
        if user is None or not user.is_active or user.account_deleted_at:
            await session.commit()
            raise _invalid_credentials()
        if user.email_normalized != email or not user.email_verified_at:
            await session.commit()
            raise _invalid_credentials()
        active_devices = (Client.user_ref == user.id, Client.auth_state == "active")
        await session.execute(update(User).where(User.id == user.id).values(
            password_hash=hash_password(password), auth_version=User.auth_version + 1))
        ids = list((await session.scalars(update(Client).where(*active_devices).values(
            user_ref=None, auth_state="pending", auth_version=Client.auth_version + 1,
            activated_at=None, revoked_at=None).returning(Client.id)
            .execution_options(synchronize_session=False))).all())
        await session.commit()
        for device_id in ids:
            await device_connections.disconnect(device_id, 4401)
        return {"ok": True, "logoutRequired": True, "signedOutDevices": len(ids)}
    except client_access.ClientAccessError as exc:
        await session.rollback()
        raise _access_error(exc) from exc
