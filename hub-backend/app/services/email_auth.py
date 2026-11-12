"""Single-use email proof and database-shared authentication throttles."""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..account_models import EmailChallenge, EmailRateLimit
from ..config import get_settings
from ..models import User
from ..mail_models import MailOutbox
from .client_access import ClientAccessError


CODE_TTL = 300
RESEND_SECONDS = 60
ATTEMPT_LIMIT = 5
PUBLIC_PURPOSES = {"register", "login", "reset_password"}
SENSITIVE_PURPOSES = {"reauthentication", "change_email", "set_password", "delete_account"}
DELIVERY_STATES = {"queued", "sending", "retry", "sent", "failed", "unknown", "expired"}
DELIVERY_ERRORS = {
    "MAIL_NOT_READY", "MAIL_EXPIRED", "MAIL_DELIVERY_UNAVAILABLE", "MAIL_INTERNAL_ERROR",
    "SMTP_AUTH_FAILED", "SMTP_TLS_FAILED", "SMTP_REJECTED", "SMTP_RECIPIENT_REJECTED",
    "SMTP_CONNECTION_FAILED", "SMTP_RESULT_UNKNOWN",
}


def now():
    return datetime.now(timezone.utc)


def normalize_email(value: str) -> str:
    raw = str(value or "").strip()
    if len(raw) > 254 or raw.count("@") != 1 or any(ord(c) < 33 for c in raw):
        raise ClientAccessError("请输入有效的邮箱地址", code="EMAIL_INVALID", status=422)
    local, domain = raw.rsplit("@", 1)
    try:
        domain = domain.encode("idna").decode("ascii").lower()
    except UnicodeError:
        domain = ""
    if (not re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}", local)
            or local.startswith(".") or local.endswith(".") or ".." in local
            or not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", domain)
            or "." not in domain or any(not label or len(label) > 63 or label.startswith("-")
                                      or label.endswith("-") for label in domain.split("."))):
        raise ClientAccessError("请输入有效的邮箱地址", code="EMAIL_INVALID", status=422)
    normalized = local.lower() + "@" + domain
    if len(normalized) > 254:
        raise ClientAccessError("邮箱地址过长", code="EMAIL_INVALID", status=422)
    return normalized


def _digest(value: str) -> str:
    return hmac.new(get_settings().auth_secret.encode(), value.encode(), hashlib.sha256).hexdigest()


def _code_hash(challenge_id, email, purpose, device_id, code):
    return _digest("email-proof\0" + "\0".join((challenge_id, email, purpose, device_id, code)))


async def _take_limit(session, identity: str, limit: int, seconds: int, current) -> None:
    key = _digest("account-rate\0" + identity)
    end = current + timedelta(seconds=seconds)
    dialect = session.get_bind().dialect.name
    insert = pg_insert if dialect == "postgresql" else sqlite_insert
    await session.execute(insert(EmailRateLimit).values(key=key, count=0, expires_at=end)
                          .on_conflict_do_nothing(index_elements=["key"]))
    await session.execute(update(EmailRateLimit).where(
        EmailRateLimit.key == key, EmailRateLimit.expires_at <= current
    ).values(count=0, expires_at=end).execution_options(synchronize_session=False))
    result = await session.execute(update(EmailRateLimit).where(
        EmailRateLimit.key == key, EmailRateLimit.count < limit,
        EmailRateLimit.expires_at > current,
    ).values(count=EmailRateLimit.count + 1).execution_options(synchronize_session=False))
    if result.rowcount != 1:
        expiry = await session.scalar(select(EmailRateLimit.expires_at).where(EmailRateLimit.key == key))
        if expiry and expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        retry = max(1, int((expiry - current).total_seconds()) + 1) if expiry else seconds
        raise ClientAccessError("操作过于频繁，请稍后重试", code="AUTH_RATE_LIMITED", status=429,
                                meta={"retryAfter": retry})


async def take_limits(session, limits):
    """Commit attempt budgets before an operation that may fail or be rolled back.

    Call before modifying account data; all counters are changed as one transaction.
    """
    try:
        current = now()
        for identity, limit, seconds in limits:
            await _take_limit(session, identity, limit, seconds, current)
        await session.commit()
    except ClientAccessError:
        await session.rollback()
        raise


async def password_budget(session, account, device_id):
    await take_limits(session, [("password-account:" + account.lower(), 10, 300),
                               ("password-device:" + device_id, 30, 300)])


async def request_challenge(session, *, email, purpose, device_id, user_id=None, remote_ip=""):
    from . import account_mail
    email = normalize_email(email)
    if purpose not in PUBLIC_PURPOSES | SENSITIVE_PURPOSES:
        raise ClientAccessError("验证码用途不正确", code="CHALLENGE_PURPOSE_INVALID", status=422)
    if purpose in SENSITIVE_PURPOSES and not user_id:
        raise ClientAccessError("此操作需要登录", code="AUTH_REQUIRED", status=401)
    if not await account_mail.mail_ready(session):
        raise ClientAccessError("邮件服务尚未配置，请联系管理员", code="MAIL_NOT_READY", status=503)
    limits = [("send-cooldown:" + purpose + ":" + email, 1, RESEND_SECONDS),
              ("send-email:" + email, 10, 3600), ("send-device:" + device_id, 30, 3600)]
    if remote_ip:
        limits.append(("send-ip:" + remote_ip, 60, 3600))
    await take_limits(session, limits)
    current = now()
    # A resend invalidates earlier proofs in this exact context, including unsent mail.
    await session.execute(update(EmailChallenge).where(
        EmailChallenge.email_normalized == email, EmailChallenge.purpose == purpose,
        EmailChallenge.device_id == device_id, EmailChallenge.user_id == user_id,
        EmailChallenge.consumed_at.is_(None),
    ).values(consumed_at=current).execution_options(synchronize_session=False))
    challenge_id = str(uuid4())
    code = f"{secrets.randbelow(1_000_000):06d}"
    expiry = current + timedelta(seconds=CODE_TTL)
    row = EmailChallenge(id=challenge_id, email_normalized=email, purpose=purpose,
                         device_id=device_id, user_id=user_id,
                         code_hash=_code_hash(challenge_id, email, purpose, device_id, code),
                         expires_at=expiry, attempts=0)
    session.add(row)
    try:
        await account_mail.enqueue_mail(session, recipient=email, purpose=purpose, code=code,
                                        expires_at=expiry, challenge_id=challenge_id)
        await session.commit()
    except account_mail.MailConfigurationError as exc:
        await session.rollback()
        raise ClientAccessError("邮件服务暂不可用，请稍后重试", code="MAIL_NOT_READY", status=503) from exc
    return {"ok": True, "challengeId": challenge_id, "expiresIn": CODE_TTL,
            "retryAfter": RESEND_SECONDS, "queued": True, "deliveryState": "queued"}


async def challenge_delivery(session, *, challenge_id, device_id):
    """Expose delivery state only to the device that requested a public proof."""
    challenge = await session.scalar(select(EmailChallenge).where(
        EmailChallenge.id == challenge_id, EmailChallenge.device_id == device_id,
        EmailChallenge.purpose.in_(PUBLIC_PURPOSES), EmailChallenge.user_id.is_(None),
    ))
    if challenge is None:
        raise ClientAccessError("未找到此验证码请求，请重新获取", code="EMAIL_CHALLENGE_NOT_FOUND", status=404)
    expiry = challenge.expires_at
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    if expiry <= now():
        state, error = "expired", "MAIL_EXPIRED"
    else:
        mail = await session.scalar(select(MailOutbox).where(MailOutbox.challenge_id == challenge.id))
        if mail is None:
            state, error = "failed", "MAIL_DELIVERY_UNAVAILABLE"
        else:
            state = mail.state if mail.state in DELIVERY_STATES else "unknown"
            # Persisted diagnostics are not public text: never return provider replies.
            error = mail.error_code if mail.error_code in DELIVERY_ERRORS else ""
            if not error and (mail.error_code or state in {"failed", "unknown", "expired"}):
                error = "MAIL_INTERNAL_ERROR"
    return {"challengeId": challenge.id, "deliveryState": state, "errorCode": error}


async def consume_challenge(session, *, challenge_id, email, purpose, device_id, code, user_id=None):
    """Consume proof atomically in the caller's account transaction.

    Wrong guesses are committed before raising, so rollback cannot restore attempts.
    Call before any other mutation. Concurrent correct submissions can win only once.
    """
    email = normalize_email(email)
    current = now()
    conditions = (
        EmailChallenge.id == challenge_id, EmailChallenge.email_normalized == email,
        EmailChallenge.purpose == purpose, EmailChallenge.device_id == device_id,
        EmailChallenge.user_id == user_id, EmailChallenge.consumed_at.is_(None),
        EmailChallenge.expires_at > current, EmailChallenge.attempts < ATTEMPT_LIMIT,
    )
    digest = _code_hash(str(challenge_id), email, purpose, device_id, str(code))
    success = await session.execute(update(EmailChallenge).where(
        *conditions, EmailChallenge.code_hash == digest,
    ).values(consumed_at=current, attempts=EmailChallenge.attempts + 1)
        .execution_options(synchronize_session=False))
    if success.rowcount == 1:
        return email
    await session.execute(update(EmailChallenge).where(*conditions).values(
        attempts=EmailChallenge.attempts + 1).execution_options(synchronize_session=False))
    await session.commit()
    raise ClientAccessError("验证码不正确、已过期或已使用，请重新获取", code="EMAIL_CODE_INVALID", status=400)


async def verified_user(session, email):
    return await session.scalar(select(User).where(User.email_normalized == normalize_email(email),
                                                   User.email_verified_at.is_not(None)))


async def public_policy(session):
    from .account_legal import documents
    legal = await documents(session)
    return {"codeExpiresIn": CODE_TTL, "codeRetryAfter": RESEND_SECONDS,
            "requiredConsentVersions": legal["requiredConsentVersions"],
            "legalDocuments": legal["documents"]}
