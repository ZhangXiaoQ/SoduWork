"""Employee sign-in, self-registration and trusted-device binding."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import exists, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import hash_password, verify_password
from ..db import get_session
from ..deps import authenticated_client, current_ai_client, enforce_client_quota, has_perm, quota_prefetch, require_perm
from ..models import AuditLog, Client, User
from ..schemas import client_to_api
from ..services import (
    audit,
    account_security,
    client_access,
    device_auth,
    device_connections,
    rbac,
)


router = APIRouter(prefix="/api/v1", tags=["client-auth"])
log = logging.getLogger(__name__)


class ClientLogin(BaseModel):
    model_config = ConfigDict(extra="ignore")
    device: str
    account: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)
    displayName: str = Field(default="", max_length=64)
    name: str = Field(default="", max_length=64)
    platform: str = Field(default="", max_length=32)
    version: str = Field(default="", max_length=32)
    workRoot: str = Field(default="", max_length=400)


class ClientLogout(BaseModel):
    model_config = ConfigDict(extra="ignore")
    device: str


class ClientPasswordChange(BaseModel):
    model_config = ConfigDict(extra="ignore")
    currentPassword: str | None = Field(default=None, min_length=1, max_length=128)
    verificationToken: str | None = Field(default=None, min_length=32, max_length=128)
    newPassword: str = Field(min_length=1, max_length=128)

    @model_validator(mode="after")
    def exactly_one_identity_proof(self):
        if (self.currentPassword is None) == (self.verificationToken is None):
            raise ValueError("请提供当前密码或身份验证凭据，且只能选择一种验证方式")
        return self


class ClientPolicyUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    allowSelfRegistration: bool | None = None
    defaultOrgId: str | None = None
    defaultRoleId: str | None = None
    tokenLimitEnabled: bool | None = None
    monthlyTokenLimit: int | None = Field(
        default=None,
        ge=0,
        le=10_000_000_000_000,
    )


def _access_error(exc: client_access.ClientAccessError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.detail())


def _device_error(exc: device_auth.DeviceAuthError) -> HTTPException:
    return HTTPException(
        status_code=exc.status,
        detail={"code": "DEVICE_AUTH_FAILED", "message": str(exc)},
    )


def _safe_user(user: User) -> dict:
    result = rbac.user_to_api(user)
    result.pop("isSuper", None)
    result.update(email=user.email or "", emailVerified=bool(user.email_verified_at),
                  avatarUrl=user.avatar_url or "", hasPassword=bool(user.password_hash))
    return result


async def _device_with_key(
    session: AsyncSession,
    device: str,
    key: str,
) -> Client:
    try:
        device_id = device_auth.validate_device_id(device)
        secret = device_auth.validate_secret(key)
    except device_auth.DeviceAuthError as exc:
        raise _device_error(exc) from exc
    client = await session.get(Client, device_id)
    if client is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "DEVICE_NOT_ENROLLED",
                "message": (
                    "\u8fd9\u53f0 SoduWork \u5c1a\u672a\u767b\u8bb0\uff0c"
                    "\u8bf7\u91cd\u8bd5"
                ),
            },
        )
    if client.auth_state == "revoked":
        raise HTTPException(
            status_code=403,
            detail={
                "code": "DEVICE_REVOKED",
                "message": (
                    "\u8fd9\u53f0 SoduWork \u5df2\u88ab\u505c\u7528\uff0c"
                    "\u8bf7\u8054\u7cfb\u7ba1\u7406\u5458"
                ),
            },
        )
    if not device_auth.secret_matches(client, secret):
        raise HTTPException(
            status_code=401,
            detail={
                "code": "DEVICE_KEY_INVALID",
                "message": "\u8bbe\u5907\u5bc6\u94a5\u4e0d\u6b63\u786e",
            },
        )
    return client


def _update_device(client: Client, body: ClientLogin) -> None:
    if body.name:
        client.name = body.name
    if body.platform:
        client.platform = body.platform
    if body.version:
        client.app_version = body.version
    if body.workRoot:
        client.work_root = body.workRoot.strip()[:400]
    client.last_seen_at = datetime.now(timezone.utc)


@router.get("/client-auth/policy")
async def public_policy(
    session: AsyncSession = Depends(get_session),
):
    from ..services import account_mail, email_auth
    current = await client_access.policy(session)
    mail_ready = await account_mail.mail_ready(session)
    return {
        "allowSelfRegistration": current["allowSelfRegistration"],
        "tokenLimitEnabled": current["tokenLimitEnabled"],
        "passwordMinLength": 8,
        "mailReady": mail_ready,
        "loginMethods": ["password", "email-code"] if mail_ready else ["password"],
        **await email_auth.public_policy(session),
    }


async def complete_login(session, client, user, body, *, created=False):
    expected_key = client.secret_hash
    expected_version = user.auth_version
    from ..services import desktop_login_policy
    await desktop_login_policy.lock_assignment(session, client, user)
    if client.auth_state == "revoked" or client.secret_hash != expected_key:
        raise client_access.ClientAccessError("设备授权已变更，请重新登录", code="DEVICE_AUTH_FAILED", status=403)
    if user.auth_version != expected_version:
        raise client_access.ClientAccessError("账号授权已变更，请重新登录", code="ACCOUNT_AUTH_CHANGED", status=401)
    if not user.is_active or user.account_deleted_at:
        raise client_access.ClientAccessError("账号已被停用", code="ACCOUNT_DISABLED", status=403)
    changed_binding = client.auth_state != "active" or str(client.user_ref or "") != user.id
    if changed_binding:
        device_auth.activate(client, user)
    _update_device(client, body)
    replaced_desktops = await desktop_login_policy.replace_previous(session, client, user)
    user.last_login_at = datetime.now(timezone.utc)
    await session.commit()
    if changed_binding:
        await device_connections.disconnect(client.id, 4401)
    for previous_id in replaced_desktops:
        await device_connections.disconnect(previous_id, 4401)
    token, expires_in = device_auth.issue_session(client)
    return {"ok": True, "created": created, "session": token, "expiresIn": expires_in,
            "device": client_to_api(client), "user": _safe_user(user),
            "quota": await client_access.quota_status(session, user.id)}


@router.post("/client-auth/login")
async def login(body: ClientLogin,
                x_device_key: str | None = Header(default=None, alias="X-Device-Key"),
                session: AsyncSession = Depends(get_session)):
    """Compatibility password login for established usernames; registration is explicit."""
    from ..services import email_auth
    client = await _device_with_key(session, body.device, x_device_key or "")
    try:
        account = client_access.normalize_account(body.account)
        await email_auth.password_budget(session, account, client.id)
        user = await client_access.find_login_user(session, account)
        if user is None or not verify_password(body.password, user.password_hash):
            raise client_access.ClientAccessError("账号或密码不正确", code="ACCOUNT_OR_PASSWORD_INVALID", status=401)
        return await complete_login(session, client, user, body)
    except client_access.ClientAccessError as exc:
        await session.rollback()
        raise _access_error(exc) from exc


@router.post("/client-auth/logout")
async def logout(
    body: ClientLogout,
    x_device_key: str | None = Header(
        default=None,
        alias="X-Device-Key",
    ),
    session: AsyncSession = Depends(get_session),
):
    client = await _device_with_key(
        session,
        body.device,
        x_device_key or "",
    )
    changed = await session.execute(update(Client).where(
        Client.id == client.id, Client.secret_hash == client.secret_hash,
        Client.auth_version == client.auth_version, Client.auth_state != "revoked",
    ).values(user_ref=None, auth_state="pending", auth_version=Client.auth_version+1,
             activated_at=None, revoked_at=None).execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        raise HTTPException(status_code=403, detail={"code": "DEVICE_AUTH_CHANGED",
            "message": "设备授权已变更，请重新检查登录状态"})
    await session.commit()
    await device_connections.disconnect(client.id, 4401)
    return {"ok": True, "activationRequired": True}


@router.post("/client-auth/change-password")
async def change_password(
    body: ClientPasswordChange,
    client: Client = Depends(authenticated_client),
    session: AsyncSession = Depends(get_session),
):
    """Change the authenticated user's password after checking the current password or a one-time identity proof. Updating the hash invalidates every device and administrator bearer session for this account."""
    user = await session.get(User, str(client.user_ref or ""))
    if user is None or not user.is_active or user.account_deleted_at:
        raise HTTPException(
            status_code=401,
            detail={"code": "ACCOUNT_UNAVAILABLE", "message": "当前账号不可用"},
        )
    from ..services import email_auth
    if body.currentPassword is not None:
        try:
            await email_auth.password_budget(session, "changepw:" + user.id, client.id)
        except client_access.ClientAccessError as exc:
            raise _access_error(exc) from exc
        if not verify_password(body.currentPassword, user.password_hash):
            raise HTTPException(
                status_code=403,
                detail={"code": "PASSWORD_MISMATCH", "message": "当前密码不正确"},
            )
    try:
        new_password = client_access.validate_password(
            body.newPassword,
            new_account=True,
        )
    except client_access.ClientAccessError as exc:
        raise _access_error(exc) from exc
    try:
        # Validate identity before comparing against the stored password, so an
        # invalid token cannot turn the unchanged check into a password oracle.
        if body.verificationToken is not None:
            await account_security.consume_grant(session, user, client,
                body.verificationToken, "change_password")
        if verify_password(new_password, user.password_hash):
            raise HTTPException(
                status_code=422,
                detail={"code": "PASSWORD_UNCHANGED", "message": "新密码不能与当前密码相同"},
            )
        changed = await session.execute(update(User).where(
            User.id == user.id, User.is_active.is_(True), User.account_deleted_at.is_(None),
            User.auth_version == user.auth_version, User.password_hash == user.password_hash,
            exists(select(Client.id).where(Client.id == client.id, Client.user_ref == user.id,
                Client.auth_state == "active", Client.auth_version == client.auth_version)),
        ).values(password_hash=hash_password(new_password), auth_version=User.auth_version+1)
            .execution_options(synchronize_session=False))
        if changed.rowcount != 1:
            raise HTTPException(status_code=401, detail={"code": "ACCOUNT_AUTH_CHANGED",
                "message": "账号授权已变更，请重新登录后修改密码"})
        # Retain enrolled device keys while expiring all account sessions.
        affected = list((await session.scalars(update(Client).where(
            Client.user_ref == user.id, Client.auth_state == "active"
        ).values(user_ref=None, auth_state="pending", auth_version=Client.auth_version+1,
                 activated_at=None, revoked_at=None).returning(Client.id)
            .execution_options(synchronize_session=False))).all())
        session.add(AuditLog(actor_id=user.id, actor_name=user.display_name or user.username,
            actor_org_id=user.org_id, action="client.password.change", target_type="user",
            target_id=user.id, target_label="修改登录密码", detail={"signedOutDevices": len(affected)}))
        await session.commit()
    except Exception:
        # Password, proof, device associations and audit must succeed together.
        await session.rollback()
        raise
    try:
        results = await asyncio.wait_for(asyncio.gather(
            *(device_connections.disconnect(cid, 4401) for cid in affected),
            return_exceptions=True), timeout=5)
        if any(isinstance(result, BaseException) for result in results):
            log.warning("Password change channel cleanup incomplete")
    except Exception as exc:
        log.warning("Password change channel cleanup incomplete: %s", type(exc).__name__)
    return {"ok": True, "logoutRequired": True, "signedOutDevices": len(affected)}


@router.get("/client-auth/me")
async def me(
    client: Client = Depends(authenticated_client),
    session: AsyncSession = Depends(get_session),
):
    user = await session.get(User, str(client.user_ref or ""))
    if user is None or not user.is_active or user.account_deleted_at:
        raise HTTPException(
            status_code=401,
            detail={
                "code": "ACCOUNT_UNAVAILABLE",
                "message": "\u5f53\u524d\u8d26\u53f7\u4e0d\u53ef\u7528",
            },
        )
    return {
        "device": client_to_api(client),
        "user": _safe_user(user),
        "quota": await client_access.quota_status(session, user.id,
            policy_rows=client.__dict__.pop("_quota_policy_rows", None)),
    }


@router.get("/client-auth/authorize-ai")
@quota_prefetch
async def authorize_ai(response: Response, model: str = "", agent: str = "",
                       client: Client = Depends(authenticated_client),
                       session: AsyncSession = Depends(get_session)):
    """A fresh admission check for cached personal models and queued desktop turns."""
    response.headers["Cache-Control"] = "private, no-store"
    from ..services import model_catalog, model_quota
    conf = {}
    if agent.strip().lower().removeprefix("local:") == "pi":
        want = model.strip() or model_catalog.agent_model(client, "pi")
        conf = await model_catalog.resolve(session, client, want)
        if not conf:
            raise HTTPException(400, "所选模型不可用，请刷新模型列表后重试")
        conf["quotaScope"] = conf.get("fundingScope", "platform")
    status = await enforce_client_quota(session, client, conf=conf)
    platform = status.pop("platformQuota", status.copy())
    return {"ok": True, "quota": status, "platformQuota": platform,
            "quotaScope": conf.get("quotaScope", "platform"), "quotaVersion": model_quota.VERSION,
            "personalQuotaSupported": agent.strip().lower().removeprefix("local:") == "pi",
            "resolvedModel": conf.get("model", ""), "providerId": conf.get("provider", "")}


@router.get("/admin/client-auth-policy")
async def admin_policy(
    _user: User = Depends(require_perm("client.assign")),
    session: AsyncSession = Depends(get_session),
):
    return await client_access.policy(session, fresh=True)


@router.put("/admin/client-auth-policy")
async def save_admin_policy(
    body: ClientPolicyUpdate = Body(...),
    user: User = Depends(require_perm("client.assign")),
    session: AsyncSession = Depends(get_session),
):
    if (body.tokenLimitEnabled is not None or body.monthlyTokenLimit is not None) and not has_perm(user, "quota.manage"):
        raise HTTPException(status_code=403, detail="请在额度管理中调整使用额度")
    try:
        result = await client_access.update_policy(
            session,
            body.model_dump(exclude_none=True),
        )
    except client_access.ClientAccessError as exc:
        raise _access_error(exc) from exc
    await audit.log(
        session,
        user,
        'client.auth_policy.update',
        'setting',
        client_access.POLICY_KEY,
        '客户端认证策略',
        {'fields': sorted(body.model_dump(exclude_none=True))},
    )
    return result
