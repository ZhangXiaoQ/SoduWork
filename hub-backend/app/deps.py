"""FastAPI authentication dependencies for devices, users and integrations."""
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import verify_user_claims
from .config import get_settings
from .db import get_session
from .models import Client, Integration, Role, User
from .permissions import ALL_KEYS
from .services import client_access, device_auth
from .services.auth_principals import DevicePrincipal

settings = get_settings()


def identity_only(endpoint):
    """Opt read routes into a small principal; other routes retain full Client.

    Keeping the common dependency preserves request-scoped reuse and existing
    integration overrides. Business code must explicitly load any extra data.
    """
    endpoint.__soduwork_identity_only__ = True
    return endpoint


def quota_prefetch(endpoint):
    """Prefetch fresh policy for an endpoint that resolves admission itself."""
    endpoint.__soduwork_quota_prefetch__ = True
    return endpoint


def _needs_ai_quota(request):
    """Keep quota prefetch scoped to the server-declared AI dependency graph."""
    route = request.scope.get("route") if request is not None else None
    if route is None:
        return False
    if getattr(getattr(route, "endpoint", None), "__soduwork_quota_prefetch__", False):
        return True
    if not hasattr(route, "_auth_prefetch_quota"):
        pending = [getattr(route, "dependant", None)]
        needed = False
        while pending:
            dependency = pending.pop()
            if dependency is None:
                continue
            if dependency.call in (current_ai_client, current_model_client):
                needed = True
                break
            pending.extend(dependency.dependencies)
        route._auth_prefetch_quota = needed
    return route._auth_prefetch_quota


async def authenticated_client(
    authorization: str | None = Header(default=None),
    x_soduwork_device: str | None = Header(default=None, alias="X-Soduwork-Device"),
    x_soduwork_secret: str | None = Header(default=None, alias="X-Soduwork-Secret"),
    session: AsyncSession = Depends(get_session),
    request: Request = None,
) -> Client:
    """Authenticate a device session, with a bounded hash-only rollout bridge."""
    include_quota = _needs_ai_quota(request)
    if authorization and authorization.startswith("Device "):
        try:
            endpoint = request.scope.get("endpoint") if request is not None else None
            if getattr(endpoint, "__soduwork_identity_only__", False) and not include_quota:
                from .services.auth_principals import from_token
                client, _ = await from_token(session, authorization[7:].strip())
            else:
                client = await device_auth.client_from_session(session, authorization[7:].strip(),
                                                               include_quota=include_quota)
        except device_auth.DeviceAuthError as exc:
            raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    elif settings.device_auth_compat and x_soduwork_device and x_soduwork_secret:
        try:
            client = await device_auth.client_from_secret(session, x_soduwork_device, x_soduwork_secret,
                                                          include_quota=include_quota)
        except device_auth.DeviceAuthError as exc:
            raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    else:
        raise HTTPException(status_code=401, detail="需要有效的 SoduWork 设备会话")
    if device_auth.should_write_last_seen(client.id):
        if isinstance(client, DevicePrincipal):
            result = await session.execute(update(Client).where(
                Client.id == client.id, Client.user_ref == client.user_ref,
                Client.auth_state == "active", Client.auth_version == client.auth_version,
            ).values(last_seen_at=datetime.now(timezone.utc)))
            if result.rowcount != 1:
                raise HTTPException(401, "设备授权已变更，请重新连接")
        else:
            client.last_seen_at = datetime.now(timezone.utc)
        await session.commit()
    return client


async def enforce_client_access(session: AsyncSession, client: Client):
    from .services.legal_publications import assert_ai_access
    published = client.__dict__.pop("_legal_publications_enabled", None)
    await assert_ai_access(session, str(client.user_ref or ""), publications_enabled=published)


async def enforce_client_quota(session: AsyncSession, client: Client, *, conf=None) -> dict:
    try:
        # Consume only this authentication query's rules, never a prior request's cache.
        rows = client.__dict__.pop("_quota_policy_rows", None)
        await enforce_client_access(session, client)
        conf = conf or {}
        status = await client_access.assert_quota(session, str(client.user_ref or ""), policy_rows=rows,
            provider=conf.get("provider", ""), model=conf.get("model", ""),
            personal=conf.get("quotaScope") == "personal")
    except client_access.ClientAccessError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail()) from exc
    client._token_quota_status = status
    return status


async def current_model_client(
    client: Client = Depends(authenticated_client),
    session: AsyncSession = Depends(get_session),
) -> Client:
    """Authenticate/access-check before resolving a model's server-owned funding."""
    try:
        # This preliminary check waives only positive budgets; the endpoint
        # must resolve real credentials before granting personal admission.
        await enforce_client_quota(session, client, conf={"quotaScope": "personal"})
    except client_access.ClientAccessError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail()) from exc
    return client


async def current_client(
    client: Client = Depends(authenticated_client),
) -> Client:
    """Keep authenticated business data available independently of AI quota."""
    return client


async def current_ai_client(
    client: Client = Depends(authenticated_client),
    session: AsyncSession = Depends(get_session),
) -> Client:
    """Check fresh account quota only when authorizing new AI work or tickets."""
    await enforce_client_quota(session, client)
    return client


# Administrative authentication: signed bearer token to user and permissions.
async def current_user(
    authorization: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="需要登录")
    claims = verify_user_claims(authorization[7:])
    if not claims:
        raise HTTPException(status_code=401, detail="登录已失效，请重新登录")
    user = await session.get(User, str(claims.get("uid") or ""), populate_existing=True)
    if user is None or not user.is_active or user.account_deleted_at:
        raise HTTPException(status_code=401, detail="账号不存在或已停用")
    if int(claims.get("ver") or 0) != int(user.auth_version or 1):
        raise HTTPException(status_code=401, detail="登录授权已变更，请重新登录")
    # Attach effective permissions in memory: all for superusers, otherwise role permissions.
    if user.is_super:
        user._perms = set(ALL_KEYS)
    elif user.role_id:
        from .services.auth_principals import role_permissions
        user._perms = await role_permissions(session, user.role_id)
    else:
        user._perms = set()
    return user


def has_perm(user: User, key: str) -> bool:
    return key in getattr(user, "_perms", set())


def require_perm(key: str):
    """Require a permission on the authenticated user, returning HTTP 403 when absent."""
    async def dep(user: User = Depends(current_user)) -> User:
        if not has_perm(user, key):
            raise HTTPException(status_code=403, detail="无该操作权限")
        return user
    setattr(dep, "__soduwork_permissions__", (key,))
    return dep


def require_any_perm(*keys: str):
    """Allow read models shared by operators and capability users."""
    wanted = tuple(str(key) for key in keys if str(key))

    async def dep(user: User = Depends(current_user)) -> User:
        if not wanted or not any(has_perm(user, key) for key in wanted):
            raise HTTPException(
                status_code=403,
                detail="\u65e0\u8be5\u64cd\u4f5c\u6743\u9650",
            )
        return user
    setattr(dep, "__soduwork_permissions__", wanted)
    return dep


async def current_integration(
    x_ingest_token: str | None = Header(default=None, alias="X-Ingest-Token"),
    session: AsyncSession = Depends(get_session),
) -> Integration:
    """Resolve an integration from its X-Ingest-Token for ingest and webhook authentication."""
    if not x_ingest_token:
        raise HTTPException(status_code=401, detail="缺少 X-Ingest-Token")
    res = await session.execute(select(Integration).where(Integration.ingest_token == x_ingest_token))
    integ = res.scalar_one_or_none()
    if integ is None:
        raise HTTPException(status_code=401, detail="无效的 ingest token")
    if not integ.enabled:
        raise HTTPException(status_code=403, detail="该集成已停用")
    return integ
