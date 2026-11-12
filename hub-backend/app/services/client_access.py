"""Employee client sign-in policy and monthly AI token quota.

The device key proves possession of one installation. A password proves the
human identity. Keeping these concerns separate lets SoduWork remember a trusted
device without persisting a password or a long-lived user bearer token.
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import AIUsageDaily, AIUsageEvent, AppSetting, OrgUnit, Role, User


POLICY_KEY = "client_auth_policy_v1"
USER_QUOTA_PREFIX = "client_token_quota:"
MAX_TOKEN_LIMIT = 10_000_000_000_000
DEFAULT_POLICY = {
    "allowSelfRegistration": True,
    "defaultOrgId": "",
    "defaultRoleId": "",
    "tokenLimitEnabled": False,
    "monthlyTokenLimit": 0,
}
_ACCOUNT_RE = re.compile(r"^[^\s]{3,64}$")
_CHINA_TZ = timezone(timedelta(hours=8))
_CACHE_TTL_SECONDS = 30.0
_policy_cache: tuple[float, dict] | None = None


class ClientAccessError(ValueError):
    def __init__(
        self,
        message: str,
        *,
        code: str,
        status: int = 403,
        meta: dict | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.status = status
        self.meta = dict(meta or {})

    def detail(self) -> dict:
        return {"code": self.code, "message": str(self), **self.meta}


def normalize_account(value: str) -> str:
    account = str(value or "").strip().lower()
    if not _ACCOUNT_RE.fullmatch(account):
        raise ClientAccessError(
            "\u8d26\u53f7\u5e94\u4e3a 3-64 \u4e2a\u5b57\u7b26\uff0c\u4e14\u4e0d\u80fd\u5305\u542b\u7a7a\u683c",
            code="ACCOUNT_INVALID",
            status=422,
        )
    return account


def validate_password(value: str, *, new_account: bool = False) -> str:
    password = str(value or "")
    if not password:
        raise ClientAccessError(
            "\u8bf7\u8f93\u5165\u5bc6\u7801",
            code="PASSWORD_REQUIRED",
            status=422,
        )
    if new_account and not 8 <= len(password) <= 128:
        raise ClientAccessError(
            "\u9996\u6b21\u6ce8\u518c\u5bc6\u7801\u81f3\u5c11 8 \u4f4d",
            code="PASSWORD_TOO_SHORT",
            status=422,
        )
    if len(password) > 128:
        raise ClientAccessError(
            "\u5bc6\u7801\u957f\u5ea6\u4e0d\u80fd\u8d85\u8fc7 128 \u4f4d",
            code="PASSWORD_INVALID",
            status=422,
        )
    return password


async def policy(session: AsyncSession, *, fresh: bool = False) -> dict:
    global _policy_cache
    now = time.monotonic()
    if not fresh and _policy_cache and _policy_cache[0] > now:
        return dict(_policy_cache[1])
    row = await session.get(AppSetting, POLICY_KEY, populate_existing=fresh)
    stored: dict = {}
    if row and row.value:
        try:
            parsed = json.loads(row.value)
            if isinstance(parsed, dict):
                stored = parsed
        except (TypeError, ValueError):
            stored = {}
    result = {**DEFAULT_POLICY, **stored}
    result["allowSelfRegistration"] = bool(
        result.get("allowSelfRegistration", True)
    )
    result["tokenLimitEnabled"] = bool(
        result.get("tokenLimitEnabled", False)
    )
    result["defaultOrgId"] = str(result.get("defaultOrgId") or "")[:36]
    result["defaultRoleId"] = str(result.get("defaultRoleId") or "")[:36]
    result["monthlyTokenLimit"] = max(
        0, int(result.get("monthlyTokenLimit") or 0)
    )
    _policy_cache = (now + _CACHE_TTL_SECONDS, dict(result))
    return dict(result)


async def update_policy(session: AsyncSession, body: dict) -> dict:
    global _policy_cache
    query = select(AppSetting).where(AppSetting.key == POLICY_KEY).with_for_update().execution_options(populate_existing=True)
    row = (await session.scalars(query)).one_or_none()
    if row is None:
        try:
            async with session.begin_nested():
                session.add(AppSetting(key=POLICY_KEY, value="{}"))
                await session.flush()
        except IntegrityError:
            pass
        row = (await session.scalars(query)).one()
    current = {**DEFAULT_POLICY, **_stored_json(row.value)}
    for key in DEFAULT_POLICY:
        if key in body:
            current[key] = body[key]
    current["allowSelfRegistration"] = bool(
        current.get("allowSelfRegistration")
    )
    current["tokenLimitEnabled"] = bool(current.get("tokenLimitEnabled"))
    current["monthlyTokenLimit"] = max(
        0,
        min(
            10_000_000_000_000,
            int(current.get("monthlyTokenLimit") or 0),
        ),
    )
    current["defaultOrgId"] = str(
        current.get("defaultOrgId") or ""
    ).strip()[:36]
    current["defaultRoleId"] = str(
        current.get("defaultRoleId") or ""
    ).strip()[:36]
    if current["tokenLimitEnabled"] and current["monthlyTokenLimit"] <= 0:
        raise ClientAccessError("开启额度限制后，请填写大于 0 的月度 Token 上限",
                                code="TOKEN_LIMIT_INVALID", status=422)
    if (
        current["defaultOrgId"]
        and await session.get(OrgUnit, current["defaultOrgId"]) is None
    ):
        raise ClientAccessError(
            "\u9ed8\u8ba4\u90e8\u95e8\u4e0d\u5b58\u5728",
            code="DEFAULT_ORG_INVALID",
            status=400,
        )
    if (
        current["defaultRoleId"]
        and await session.get(Role, current["defaultRoleId"]) is None
    ):
        raise ClientAccessError(
            "\u9ed8\u8ba4\u89d2\u8272\u4e0d\u5b58\u5728",
            code="DEFAULT_ROLE_INVALID",
            status=400,
        )
    encoded = json.dumps(
        current,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    row.value = encoded
    await session.commit()
    _policy_cache = (
        time.monotonic() + _CACHE_TTL_SECONDS,
        dict(current),
    )
    invalidate_quota()
    return dict(current)


async def find_user(session: AsyncSession, account: str) -> User | None:
    return (
        await session.execute(
            select(User)
            .where(func.lower(User.username) == account.lower())
            .limit(1)
        )
    ).scalar_one_or_none()


async def find_login_user(session: AsyncSession, account: str, *, legacy_lookup=None) -> User | None:
    """Resolve current verified email before compatible, non-retired usernames.

    Keep find_user unchanged for registration and identity collision checks.
    Email changes retire an email-shaped login alias without renaming identity.
    """
    from . import email_auth
    raw, email = str(account or ""), None
    try:
        email = email_auth.normalize_email(raw)
    except ClientAccessError:
        pass  # Established usernames need not be valid email addresses.
    if email is not None:
        current = await email_auth.verified_user(session, email)
        if current is not None:
            return current
    lookup = legacy_lookup or find_user
    legacy = await lookup(session, raw if legacy_lookup else raw.strip())
    if (legacy is not None and email is not None and legacy.email_verified_at and
            legacy.email_normalized and legacy.email_normalized != email):
        return None
    return legacy


async def default_org_id(
    session: AsyncSession,
    configured: str = "",
) -> str | None:
    if configured and await session.get(OrgUnit, configured) is not None:
        return configured
    root = (
        await session.execute(
            select(OrgUnit)
            .where(OrgUnit.parent_id.is_(None))
            .order_by(OrgUnit.sort, OrgUnit.created_at)
            .limit(1)
        )
    ).scalar_one_or_none()
    if root is None:
        root = (
            await session.execute(
                select(OrgUnit)
                .order_by(OrgUnit.sort, OrgUnit.created_at)
                .limit(1)
            )
        ).scalar_one_or_none()
    return root.id if root else None


def _month_start_utc(now: datetime | None = None) -> datetime:
    current = now or datetime.now(timezone.utc)
    local = current.astimezone(_CHINA_TZ)
    return local.replace(
        day=1,
        hour=0,
        minute=0,
        second=0,
        microsecond=0,
    ).astimezone(timezone.utc)


def invalidate_quota(user_id: str = "") -> None:
    """Compatibility hook; quota reads now use committed daily facts directly."""


def user_quota(value: dict | None) -> dict:
    """Normalize an explicit override; zero is an intentional pause, not unlimited."""
    value = value or {}
    mode = value.get("mode", "inherit")
    limit = value.get("limit", 0)
    if (mode not in {"inherit", "limited", "unlimited"} or type(limit) is not int
            or not 0 <= limit <= MAX_TOKEN_LIMIT):
        raise ClientAccessError("个人额度设置无效", code="TOKEN_LIMIT_INVALID", status=422)
    return {"mode": mode, "limit": limit if mode == "limited" else 0}


def _stored_json(value: str) -> dict:
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        return {}


async def user_quotas(session: AsyncSession, user_ids) -> dict:
    """Load account overrides in batches, without one query per user in admin lists."""
    keys = [USER_QUOTA_PREFIX + str(uid) for uid in user_ids if uid]
    result = {}
    for offset in range(0, len(keys), 500):
        rows = await session.execute(select(AppSetting.key, AppSetting.value).where(
            AppSetting.key.in_(keys[offset:offset + 500])))
        result.update({key[len(USER_QUOTA_PREFIX):]: user_quota(_stored_json(value))
                       for key, value in rows})
    return result


async def save_user_quota(session: AsyncSession, user_id: str, value: dict) -> dict:
    """Join the caller's user transaction; never commit a partial user edit."""
    result = user_quota(value)
    key = USER_QUOTA_PREFIX + str(user_id)
    row = await session.get(AppSetting, key)
    if result["mode"] == "inherit":
        if row is not None:
            await session.delete(row)
    elif row is None:
        session.add(AppSetting(key=key, value=json.dumps(result)))
    else:
        row.value = json.dumps(result)
    return result


async def monthly_tokens(session: AsyncSession, user_id: str, *, month_start=None) -> int:
    key = str(user_id or "")
    if not key:
        return 0
    start = month_start or _month_start_utc()
    local_start = start.astimezone(_CHINA_TZ)
    next_month = (local_start.replace(day=28) + timedelta(days=4)).replace(day=1)
    month, end_day = local_start.date().isoformat(), next_month.date().isoformat()
    # Quotas protect admission, so another worker's committed usage must be
    # visible immediately. Process-local TTLs cannot provide that guarantee.
    daily = select(func.coalesce(func.sum(AIUsageDaily.total_tokens), 0)).where(
        AIUsageDaily.quota_scope != "personal",
        AIUsageDaily.billing_user_id == key, AIUsageDaily.day_key >= month,
        AIUsageDaily.day_key < end_day).scalar_subquery()
    # Compatibility for events written by older integrations without daily rows.
    # Exclude any event that already has daily facts to avoid counting it twice.
    legacy = select(func.coalesce(func.sum(AIUsageEvent.total_tokens), 0)).where(
        AIUsageEvent.billing_user_id == key, AIUsageEvent.occurred_at >= start,
        AIUsageEvent.occurred_at < next_month.astimezone(timezone.utc),
        ~select(AIUsageDaily.id).where(AIUsageDaily.usage_event_id == AIUsageEvent.id).exists(),
    ).scalar_subquery()
    return int(await session.scalar(select(daily + legacy)) or 0)


async def quota_status(
    session: AsyncSession,
    user_id: str,
    current_policy: dict | None = None,
    *, policy_rows: dict | None = None, provider: str = "", model: str = "",
) -> dict:
    # Read scalar values rather than cached ORM rows or process-local policy TTLs.
    # A change committed by any Hub worker applies to the next admission.
    from . import quota_plans
    keys = [USER_QUOTA_PREFIX + str(user_id or ""),
            quota_plans.GRANT_PREFIX + str(user_id or "")]
    if current_policy is None:
        keys.append(POLICY_KEY)
    rows = policy_rows if policy_rows is not None else dict((await session.execute(
        select(AppSetting.key, AppSetting.value).where(AppSetting.key.in_(keys)))).all())
    try:
        assigned = await quota_plans.status(session, user_id, rows, provider=provider, model=model)
    except (ValueError, KeyError, TypeError) as exc:
        raise ClientAccessError("额度配置暂时不可用，请联系管理员检查套餐",
                                code="TOKEN_QUOTA_UNAVAILABLE", status=503) from exc
    if assigned is not None:
        from .model_quota import describe
        return describe(assigned)
    current_policy = current_policy if current_policy is not None else {
        **DEFAULT_POLICY, **_stored_json(rows.get(POLICY_KEY, ""))}
    override = user_quota(_stored_json(rows.get(keys[0], "")))
    enabled = override["mode"] == "limited" or (
        override["mode"] == "inherit" and bool(current_policy.get("tokenLimitEnabled")))
    limit = (override["limit"] if override["mode"] == "limited" else
             max(0, int(current_policy.get("monthlyTokenLimit") or 0))) if enabled else 0
    start = _month_start_utc()
    used = (
        await monthly_tokens(session, user_id, month_start=start)
        if enabled
        else 0
    )
    exceeded = bool(enabled and used >= limit)
    result = {
        "enabled": enabled,
        "limit": limit,
        "used": used,
        "remaining": (
            max(0, limit - used)
            if enabled
            else None
        ),
        "exceeded": exceeded,
        "period": start.astimezone(_CHINA_TZ).strftime("%Y-%m"),
        "mode": override["mode"],
    }
    from .model_quota import describe
    return describe(result)


async def assert_quota(session: AsyncSession, user_id: str, *, policy_rows=None,
                        provider: str = "", model: str = "", personal: bool = False) -> dict:
    status = await quota_status(session, user_id, policy_rows=policy_rows, provider=provider, model=model)
    from .model_quota import admission
    platform_status = status
    status = admission(status, personal=personal)
    if status["exceeded"]:
        messages = {
            "trial_expired": "试用已结束，联系管理员分配套餐后即可继续",
            "model_exhausted": "当前模型的额度已用完，可以选择其他可用模型或联系管理员调整额度",
            "model_not_allowed": "当前套餐未包含此模型，请选择套餐内的模型或联系管理员",
        }
        raise ClientAccessError(
            messages.get(status.get("reason"), "当前 AI 额度已用完，联系管理员调整后即可继续"),
            code="TOKEN_QUOTA_EXCEEDED",
            status=403,
            meta={"quota": status},
        )
    return {**status, "platformQuota": platform_status} if personal else status
