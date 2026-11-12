"""Legal publishing and consent evidence; no region comes from the caller."""
import hashlib
import json
import re
from html.parser import HTMLParser
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import func, select, update

from ..account_models import UserConsent
from ..legal_models import LegalDraft, LegalReceipt, LegalVersion
from ..models import AppSetting, AuditLog
from .client_access import ClientAccessError

MARKER = "account_legal_publications_v1"
KINDS = ("terms", "privacy")


def has_html_text(content):
    """Check visible legal text; clients independently sanitize markup on render."""
    class Text(HTMLParser):
        hidden = 0
        visible = False

        def handle_starttag(self, tag, attrs):
            if tag in ("script", "style", "iframe", "object", "template", "svg", "math"):
                self.hidden += 1

        def handle_endtag(self, tag):
            if tag in ("script", "style", "iframe", "object", "template", "svg", "math"):
                self.hidden = max(0, self.hidden - 1)

        def handle_data(self, data):
            if not self.hidden and data.strip():
                self.visible = True

    parser = Text(convert_charrefs=True)
    parser.feed(content)
    return parser.visible


def now():
    return datetime.now(timezone.utc)


def aware(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def fail(message, code="LEGAL_INVALID", status=422):
    raise ClientAccessError(message, code=code, status=status)


def kind_check(kind):
    if kind not in KINDS:
        fail("协议类型不存在", "LEGAL_NOT_FOUND", 404)


def normalize(kind, raw, publishing=False):
    kind_check(kind)
    if not isinstance(raw, dict):
        fail("协议内容格式不正确")
    # Drafts never reserve a publication number, including older saved drafts.
    action = raw.get("action", "notice")
    if action not in ("notice", "accept") or (kind == "privacy" and action != "notice"):
        fail("隐私政策更新应告知用户；特定处理目的的同意须在对应功能单独取得")
    translations = raw.get("translations", {})
    if not isinstance(translations, dict) or len(translations) > 20:
        fail("请提供有效的语言版本（最多 20 种）")
    clean = {}
    for locale, row in translations.items():
        if not re.fullmatch(r"[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-\d{3})?", str(locale)) or not isinstance(row, dict):
            fail("语言标识或正文格式不正确")
        item = {key: str(row.get(key) or "").strip() for key in ("title", "content", "summary")}
        item["content"] = str(row.get("content") or "")
        item["format"] = row.get("format", raw.get("format", "text"))
        if item["format"] not in ("text", "markdown", "html"):
            fail("正文格式不支持")
        if len(item["title"]) > 200 or len(item["content"]) > 200000 or len(item["summary"]) > 2000:
            fail("标题、正文或更新说明超出长度限制")
        if publishing and (not item["title"] or not item["content"].strip() or not item["summary"]):
            fail("发布前请补全每个语言版本的标题、正文和更新说明")
        if publishing and item["format"] == "html" and not has_html_text(item["content"]):
            fail("发布前请补全每个语言版本的标题、正文和更新说明")
        clean[locale] = item
    default = str(raw.get("defaultLocale") or "")
    if default and default not in clean:
        fail("默认原文语言必须有对应正文")
    if publishing and (not clean or not default):
        fail("发布前请设置默认原文语言并补全协议正文")
    format_name = raw.get("format", "text")
    if format_name not in ("text", "markdown", "html"):
        fail("正文格式不支持")
    return {"version": "", "action": action, "defaultLocale": default, "translations": clean, "format": format_name}


def digest(payload):
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode()).hexdigest()


def version_info(row, content=False):
    result = {"id": row.id, "key": row.kind, "version": row.version, "digest": row.digest,
              "action": row.action, "effectiveAt": aware(row.effective_at).isoformat(),
              "publishedAt": aware(row.published_at).isoformat(), "publishedBy": row.published_by,
              "canceledAt": aware(row.canceled_at).isoformat() if row.canceled_at else None,
              "locales": list(row.payload["translations"]), "defaultLocale": row.payload["defaultLocale"]}
    if content:
        result["payload"] = row.payload
    return result


def public_documents(row):
    return [{"key": row.kind, "version": row.version, "revisionId": row.id,
             "locale": locale, "defaultLocale": locale == row.payload["defaultLocale"],
             "title": value["title"], "content": value["content"], "summary": value["summary"],
             "format": value.get("format", row.payload.get("format", "text")), "updatedAt": aware(row.published_at).isoformat(),
             "effectiveAt": aware(row.effective_at).isoformat(), "digest": digest(value)}
            for locale, value in sorted(row.payload["translations"].items(),
                                        key=lambda item: item[0] != row.payload["defaultLocale"])]


async def enabled(session):
    # The marker permits a safe legacy fallback before the first explicit publication.
    return await session.get(AppSetting, MARKER) is not None


async def active_versions(session):
    if not await enabled(session):
        return {}
    result = {}
    for kind in KINDS:
        row = await session.scalar(select(LegalVersion).where(LegalVersion.kind == kind,
            LegalVersion.canceled_at.is_(None), LegalVersion.effective_at <= now())
            .order_by(LegalVersion.effective_at.desc(), LegalVersion.published_at.desc()).limit(1))
        if row:
            result[kind] = row
    return result


async def admin_state(session, kind):
    kind_check(kind)
    row = await session.get(LegalDraft, kind)
    versions = (await session.scalars(select(LegalVersion).where(LegalVersion.kind == kind)
        .order_by(LegalVersion.published_at.desc()).limit(100))).all()
    current = (await active_versions(session)).get(kind)
    return {"revision": row.revision if row else 0,
            "draft": {**row.payload, "version": ""} if row else normalize(kind, {}),
            "updatedAt": aware(row.updated_at).isoformat() if row else None,
            "currentId": current.id if current else None,
            "history": [version_info(item) for item in versions]}


async def save_draft(session, kind, revision, payload, actor):
    clean = normalize(kind, payload)
    if revision == 0:
        session.add(LegalDraft(kind=kind, revision=1, payload=clean, updated_by=actor.id, updated_at=now()))
        await session.flush()
    else:
        result = await session.execute(update(LegalDraft).where(LegalDraft.kind == kind,
            LegalDraft.revision == revision).values(revision=revision + 1, payload=clean,
                updated_by=actor.id, updated_at=now()).execution_options(synchronize_session=False))
        if result.rowcount != 1:
            fail("草稿已被其他管理员更新，请重新加载后再编辑", "LEGAL_CONFLICT", 409)
    return {"revision": revision + 1, "draft": clean}


async def insert_once(session, model, values, keys):
    if session.bind.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    await session.execute(insert(model).values(**values).on_conflict_do_nothing(index_elements=keys))


def audit_event(session, actor, action, target, detail):
    session.add(AuditLog(actor_id=actor.id, actor_name=actor.display_name or actor.username,
        actor_org_id=actor.org_id, action=action, target_type="legal_document", target_id=target, detail=detail))


async def publish(session, kind, revision, effective_at, actor):
    kind_check(kind)
    draft = await session.get(LegalDraft, kind, populate_existing=True)
    if draft is None or draft.revision != revision:
        fail("草稿已更新，请重新预览后再发布", "LEGAL_CONFLICT", 409)
    payload = normalize(kind, draft.payload, publishing=True)
    timestamp = now()
    effective = aware(effective_at) if effective_at else timestamp
    if effective_at and effective < timestamp:
        fail("生效时间不能早于当前时间")
    # Serialize save, publish and scheduled cancellation for this document.
    updated = await session.execute(update(LegalDraft).where(LegalDraft.kind == kind,
        LegalDraft.revision == revision).values(revision=revision + 1)
        .execution_options(synchronize_session=False))
    if updated.rowcount != 1:
        fail("草稿已更新，请重新预览后再发布", "LEGAL_CONFLICT", 409)
    latest = await session.scalar(select(LegalVersion).where(LegalVersion.kind == kind,
        LegalVersion.canceled_at.is_(None)).order_by(LegalVersion.effective_at.desc()).limit(1))
    if latest and aware(latest.effective_at) >= effective:
        fail("已有更晚生效的版本，请先取消该定时发布", "LEGAL_SCHEDULE_CONFLICT", 409)
    # The draft CAS above serializes number allocation per document on both
    # PostgreSQL and SQLite. Include canceled snapshots and skip legacy names;
    # the existing unique constraint remains the final integrity boundary.
    number = 1 + await session.scalar(select(func.count()).select_from(LegalVersion)
                                      .where(LegalVersion.kind == kind))
    while await session.scalar(select(LegalVersion.id).where(
            LegalVersion.kind == kind, LegalVersion.version == f"v{number}")):
        number += 1
    payload["version"] = f"v{number}"
    row = LegalVersion(id=str(uuid4()), kind=kind, version=payload["version"], payload=payload,
        digest=digest(payload), action=payload["action"], effective_at=effective,
        published_at=timestamp, published_by=actor.id)
    session.add(row)
    await insert_once(session, AppSetting, {"key": MARKER, "value": "{}"}, ["key"])
    audit_event(session, actor, "legal.publish", row.id, {"kind": kind, "version": row.version,
        "digest": row.digest, "effectiveAt": effective.isoformat(), "action": row.action})
    await session.flush()
    return {"revision": revision + 1, "publication": version_info(row, True)}


async def cancel(session, version_id, actor):
    row = await session.get(LegalVersion, version_id)
    if row is None:
        fail("版本不存在", "LEGAL_NOT_FOUND", 404)
    await session.execute(update(LegalDraft).where(LegalDraft.kind == row.kind)
                          .values(revision=LegalDraft.revision + 1))
    result = await session.execute(update(LegalVersion).where(LegalVersion.id == version_id,
        LegalVersion.canceled_at.is_(None), LegalVersion.effective_at > now())
        .values(canceled_at=now()).execution_options(synchronize_session=False))
    if result.rowcount != 1:
        fail("仅未生效的定时发布可以取消", "LEGAL_CONFLICT", 409)
    audit_event(session, actor, "legal.cancel", row.id, {"version": row.version})


async def needs_acceptance(session, user_id, versions=None, *, publications_enabled=None):
    if versions is not None and "terms" not in versions:
        return False
    if versions is None and not (publications_enabled if publications_enabled is not None else await enabled(session)):
        return False
    threshold = await session.scalar(select(LegalVersion.effective_at).where(LegalVersion.kind == "terms",
        LegalVersion.canceled_at.is_(None), LegalVersion.effective_at <= now(), LegalVersion.action == "accept")
        .order_by(LegalVersion.effective_at.desc()).limit(1))
    if not threshold:
        return False
    accepted = await session.scalar(select(LegalReceipt.id).join(LegalVersion,
        LegalReceipt.version_id == LegalVersion.id).where(LegalReceipt.user_id == user_id,
        LegalReceipt.action == "accept", LegalVersion.kind == "terms",
        LegalVersion.effective_at >= threshold).limit(1))
    return not bool(accepted)


async def receipt_details(session, user_id, *, include_notices=False):
    if not await enabled(session):
        return []
    query = (select(LegalReceipt, LegalVersion.kind, LegalVersion.version)
        .join(LegalVersion, LegalReceipt.version_id == LegalVersion.id)
        .where(LegalReceipt.user_id == user_id).order_by(LegalReceipt.created_at.desc()))
    if not include_notices:
        query = query.where(LegalReceipt.action == "accept")
    rows = (await session.execute(query)).all()
    return [{"document": kind, "version": version, "revisionId": row.version_id, "locale": row.locale,
             "digest": row.digest, "action": row.action, "recordedAt": aware(row.created_at).isoformat(),
             **({"acceptedAt": aware(row.created_at).isoformat()} if row.action == "accept" else {})}
            for row, kind, version in rows]


async def status(session, user_id):
    from .account_legal import documents
    versions = await active_versions(session)
    required = await needs_acceptance(session, user_id, versions)
    # Only current publication IDs matter here; historical receipts remain available
    # through the dedicated evidence/export path without inflating every status poll.
    seen = set((await session.scalars(select(LegalReceipt.version_id).where(
        LegalReceipt.user_id == user_id,
        LegalReceipt.version_id.in_([row.id for row in versions.values()])))).all()) if versions else set()
    return {**await documents(session, active=versions), "acceptanceRequired": required,
            "updates": [{"key": kind, "revisionId": row.id, "version": row.version,
                         "action": "accept" if kind == "terms" and required else "notice"}
                        for kind, row in versions.items() if row.id not in seen or (kind == "terms" and required)]}


async def receipt(session, user_id, device_id, row, action, locale):
    # Older clients did not report the viewed language. Keep that evidence unknown.
    chosen = locale or ""
    if chosen and chosen not in row.payload["translations"]:
        fail("正文语言已变化，请重新阅读协议", "LEGAL_LANGUAGE_INVALID", 409)
    await insert_once(session, LegalReceipt, {"id": str(uuid4()), "user_id": user_id,
        "device_id": device_id, "version_id": row.id, "action": action, "locale": chosen,
        "digest": digest(row.payload["translations"][chosen]) if chosen else row.digest, "created_at": now()},
        ["user_id", "version_id", "action"])
    if action == "accept":
        await insert_once(session, UserConsent, {"id": str(uuid4()), "user_id": user_id,
            "device_id": device_id, "document": row.kind, "version": row.version, "accepted_at": now()},
            ["user_id", "document", "version"])


async def respond(session, user_id, device_id, kind, version_id, action, locale):
    kind_check(kind)
    row = (await active_versions(session)).get(kind)
    if not row or row.id != version_id:
        fail("协议版本已更新，请重新阅读后确认", "LEGAL_VERSION_CHANGED", 409)
    if action == "accept" and kind != "terms":
        fail("此更新无需重新同意")
    if action == "notice" and kind == "terms" and await needs_acceptance(session, user_id):
        fail("请明确同意更新后的用户协议", "LEGAL_ACCEPTANCE_REQUIRED", 428)
    await receipt(session, user_id, device_id, row, action, locale)


async def assert_ai_access(session, user_id, *, publications_enabled=None):
    if await needs_acceptance(session, user_id, publications_enabled=publications_enabled):
        fail("请先查看并确认更新后的用户协议", "LEGAL_ACCEPTANCE_REQUIRED", 428)


async def validate_registration(session, consents, active=None):
    from .account_legal import required_versions
    active = active if active is not None else await active_versions(session)
    versions = {**required_versions(), **{kind: row.version for kind, row in active.items()}}
    if not isinstance(consents, dict) or any(consents.get(key) != value for key, value in versions.items()):
        fail("请阅读并同意最新用户协议与隐私政策", "CONSENT_REQUIRED", 422)
    return versions


async def register_receipts(session, user_id, device_id, consents, locales):
    active = await active_versions(session)
    # Validate and record the very same snapshots. A concurrent publication must
    # never replace the document the user actually accepted with a newer one.
    await validate_registration(session, consents, active)
    for kind, version in consents.items():
        if kind not in KINDS:
            continue
        if kind in active:
            await receipt(session, user_id, device_id, active[kind], "accept", locales.get(kind, ""))
        else:
            session.add(UserConsent(user_id=user_id, device_id=device_id, document=kind, version=version))
