"""Opt-in repository issue imports; never mirror external workflow status."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import urllib.error
from urllib.parse import unquote, urlsplit
from types import SimpleNamespace

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from ..repository_issue_models import RepositoryIssueLink as Link, RepositoryIssueMember as Member, RepositoryIssueSync as Sync
from ..connectors import gitlab_repository_issues as remote
from ..connectors import github_repository_issues as github_remote
from . import repository_catalog, resource_leases

INTERVAL = 60
PROVIDERS = {"gitlab", "github"}


def adapter(repo):
    if repo.provider == "github":
        return github_remote
    if repo.provider == "gitlab":
        return remote
    raise ValueError("仅支持 GitLab 和 GitHub 仓库的 Issue 同步")


def now():
    return datetime.now(timezone.utc)


def utc(value):
    if value is None:
        return None
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def stamp(value):
    return utc(value).isoformat() if value else None


def next_poll(value):
    # The worker ticks on a fixed cadence. Anchoring eligibility to a minute
    # boundary avoids skipping alternate ticks when DB work moves scan start
    # a few milliseconds past the scheduler's own start timestamp.
    return datetime.fromtimestamp((int(utc(value).timestamp()) // INTERVAL + 1) * INTERVAL, timezone.utc)


def safe_error(exc):
    if isinstance(exc, (urllib.error.HTTPError, remote.GitLabHTTPError, github_remote.GitHubHTTPError)):
        code = exc.code
        provider = "GitHub" if isinstance(exc, github_remote.GitHubHTTPError) else "GitLab"
        hint = {
            400: "请检查仓库配置和请求参数",
            401: "账号认证失效，请检查拉取账号或令牌",
            403: "账号权限不足，请检查仓库、Issue 和成员访问权限",
            404: "仓库或 Issue 不存在，或当前账号不可见",
            429: f"{provider} 请求限流，请稍后重试",
        }.get(code, f"{provider} 服务暂时异常，请稍后重试" if code >= 500 else "请检查账号权限或服务状态")
        return f"{provider} 请求失败（HTTP {code}），{hint}；游标未推进"
    return f"Issue 同步未完成（{type(exc).__name__}），游标未推进，请检查连接与账号配置"


def validate_label(value, provider="gitlab"):
    value = str(value or "").strip()
    limit = 50 if provider == "github" else 120
    if not value or len(value) > limit or "," in value or "::" in value or any(ord(c) < 32 for c in value):
        raise ValueError(f"开始处理标签须为 1–{limit} 字的普通标签，不能含逗号、:: 或控制字符")
    return value


async def catalog_for_envelope(session, integration, env):
    """Resolve stable project identity, with URL compatibility for old envelopes."""
    if integration.type not in PROVIDERS:
        return None
    query = select(am.ScmRepository).where(am.ScmRepository.integration_id == integration.id)
    project_id = str(env.get("external_project_id") or "")
    if project_id.isascii() and project_id.isdigit():
        return await session.scalar(query.where(am.ScmRepository.external_id == project_id))
    path = unquote(urlsplit(str(env.get("external_url") or "")).path)
    repo_name = ""
    markers = ("/issues/",) if integration.type == "github" else ("/-/issues/", "/-/work_items/")
    for marker in markers:
        if marker in path:
            repo_name = path.split(marker, 1)[0].strip("/")
            break
    base_path = unquote(urlsplit(str((integration.config or {}).get("base_url") or "")).path).strip("/")
    if base_path and repo_name.startswith(base_path + "/"):
        repo_name = repo_name[len(base_path) + 1:]
    repo_name = repo_name or str(env.get("ext_repo") or "").strip("/")
    if not repo_name:
        return None
    return await session.scalar(query.where(am.ScmRepository.full_name == repo_name))


async def owns_envelope(session, integration, env):
    """Ownership persists while paused; legacy state mirrors must stay disabled."""
    repo = await catalog_for_envelope(session, integration, env)
    return bool(repo and await session.scalar(select(Sync.catalog_id).where(
        Sync.catalog_id == repo.id, Sync.enabled_at.isnot(None))))


async def source(session, catalog_id, *, require_enabled=False):
    # Resolve the current authorization snapshot in one query before each side
    # effect. Identity-map hits must not hide revocation between HTTP calls.
    result = (await session.execute(select(am.ScmRepository, models.Integration,
        models.OrgUnit.id, Sync.enabled)
        .select_from(am.ScmRepository)
        .outerjoin(models.Integration, models.Integration.id == am.ScmRepository.integration_id)
        .outerjoin(models.OrgUnit, models.OrgUnit.id == am.ScmRepository.org_id)
        .outerjoin(Sync, Sync.catalog_id == am.ScmRepository.id)
        .where(am.ScmRepository.id == catalog_id)
        .execution_options(populate_existing=True))).first()
    repo, integration, org_id, enabled = result if result else (None, None, None, None)
    if repo is None or repo.provider not in PROVIDERS or not repo.active or repo.archived:
        raise ValueError("仅支持有效且未归档的 GitLab 或 GitHub 仓库")
    if integration is None or not integration.enabled:
        raise ValueError("仓库所属集成已停用")
    if integration.type != repo.provider:
        raise ValueError("仓库平台与集成配置不一致，请重新同步仓库目录")
    if repo.provider == "github" and not org_id:
        raise ValueError("请先为 GitHub 仓库设置所属团队，再开启 Issue 同步")
    if require_enabled and not enabled:
        raise ValueError("Repository issue subscription is disabled")
    cfg, _ = await repository_catalog._runtime_config(session, integration)
    return repo, cfg


async def call_remote(session, lease, method, *args):
    """Keep the database fence live while blocking HTTP runs off the event loop."""
    work = asyncio.create_task(asyncio.to_thread(method, *args))
    try:
        while not work.done():
            await asyncio.wait({work}, timeout=20)
            if not await resource_leases.heartbeat(session, lease, ttl_seconds=120):
                raise resource_leases.LeaseBusy("Issue synchronization lease expired")
        return await work
    finally:
        if not work.done():
            # Thread cancellation cannot retract a sent HTTP request. Imports do
            # no writes upstream; first-start writes only append an idempotent label.
            work.cancel()


async def fence(session, lease):
    """Validate ownership in the same transaction as domain writes, without committing."""
    moment = resource_leases._now()
    with session.no_autoflush:
        result = await session.execute(update(am.ResourceLease).where(
            am.ResourceLease.resource_kind == lease.kind,
            am.ResourceLease.resource_key == lease.key,
            am.ResourceLease.token == lease.token,
            am.ResourceLease.lease_until > moment,
        ).values(heartbeat_at=moment, lease_until=moment + timedelta(seconds=120)))
    if result.rowcount != 1:
        raise resource_leases.LeaseBusy("Issue synchronization lease expired")


async def refresh_members(session, repo, items):
    """Only a complete upstream snapshot can revoke a previous membership."""
    if repo.provider == "github":
        # GitHub requirements use current Hub team membership, never remote
        # collaborators, historical bindings, or a guessed external username.
        return
    rows = list((await session.scalars(select(Member).where(Member.catalog_id == repo.id))).all())
    by_id = {row.external_user_id: row for row in rows}
    from . import rbac
    company = await rbac.company_org_ids(session, SimpleNamespace(org_id=repo.org_id, is_active=True, is_super=False))
    bindings = (await session.execute(select(models.IntegrationBinding.external_actor, models.User.id)
        .join(models.Client, models.Client.id == models.IntegrationBinding.client_id)
        .join(models.User, models.User.id == models.Client.user_ref)
        .where(models.IntegrationBinding.integration_id == repo.integration_id, models.User.is_active.is_(True),
               models.User.org_id.in_(company or {"__none__"})))).all()
    trusted = {}
    for actor, user_id in bindings:
        trusted.setdefault(str(actor), set()).add(user_id)
    seen = set()
    for item in items:
        external_id = str(item["id"])
        seen.add(external_id)
        member = by_id.get(external_id)
        if member is None:
            member = Member(catalog_id=repo.id, external_user_id=external_id, mapping_source="")
            session.add(member)
        member.username = str(item.get("username") or "")[:200]
        member.display_name = str(item.get("name") or member.username)[:200]
        member.active = (item.get("state", "active") == "active"
            and item.get("membership_state", "active") == "active")
        expires = item.get("expires_at")
        if expires and str(expires) <= now().date().isoformat():
            member.active = False
        member.synced_at = now()
        if member.mapping_source != "manual":
            candidates = trusted.get(member.username, set())
            member.user_id = next(iter(candidates)) if len(candidates) == 1 else None
            member.mapping_source = "integration" if member.user_id else ""
    for member in rows:
        if member.external_user_id not in seen:
            member.active = False
            member.synced_at = now()
    await session.flush()


async def summaries(session, ids):
    if not ids:
        return {}
    providers = dict((await session.execute(select(am.ScmRepository.id, am.ScmRepository.provider)
        .where(am.ScmRepository.id.in_(ids)))).all())
    settings = {r.catalog_id: r for r in (await session.scalars(select(Sync).where(Sync.catalog_id.in_(ids)))).all()}
    counts = (await session.execute(select(Member.catalog_id, func.count(), func.count(Member.user_id))
        .where(Member.catalog_id.in_(ids), Member.active.is_(True)).group_by(Member.catalog_id))).all()
    members = {cid: (total, mapped) for cid, total, mapped in counts}
    pending = (await session.execute(select(Link.catalog_id, Link.writeback_state, func.count())
        .where(Link.catalog_id.in_(ids)).group_by(Link.catalog_id, Link.writeback_state))).all()
    states = {(cid, state): n for cid, state, n in pending}
    result = {}
    for cid in ids:
        row = settings.get(cid)
        total, mapped = members.get(cid, (0, 0))
        result[cid] = {
            "provider": providers.get(cid, ""),
            "visibilityMode": "organization" if providers.get(cid) == "github" else "repository_members",
            "enabled": bool(row and row.enabled), "startedLabel": row.started_label if row else "处理中",
            "intervalSeconds": INTERVAL, "enabledAt": stamp(row.enabled_at) if row else None,
            "lastPolledAt": stamp(row.last_polled_at) if row else None,
            "lastSuccessAt": stamp(row.last_success_at) if row else None,
            "nextPollAt": stamp(row.next_poll_at) if row else None,
            "lastError": row.last_error if row else "", "importedCount": row.imported_count if row else 0,
            "lastCreatedCount": row.last_created_count if row else 0,
            "skippedConfidential": row.skipped_confidential if row else 0,
            "pendingWritebacks": states.get((cid, "pending"), 0) + states.get((cid, "error"), 0),
            "manualWritebacks": states.get((cid, "manual"), 0), "totalMembers": total, "mappedMembers": mapped,
        }
    return result


async def detail(session, catalog_id, scope):
    info = (await summaries(session, [catalog_id]))[catalog_id]
    query = select(models.User).where(models.User.is_active.is_(True))
    if scope is not None:
        query = query.where(models.User.org_id.in_(scope or {"__none__"}))
    users = list((await session.scalars(query.order_by(models.User.username))).all())
    names = {u.id: u.display_name or u.username for u in users}
    members = list((await session.scalars(select(Member).where(Member.catalog_id == catalog_id)
        .order_by(Member.username))).all())
    info["members"] = [{"externalUserId": m.external_user_id, "username": m.username,
        "displayName": m.display_name, "userId": m.user_id, "userName": names.get(m.user_id, ""),
        "active": m.active, "mappingSource": m.mapping_source} for m in members]
    info["userOptions"] = [{"id": u.id, "name": names[u.id], "username": u.username} for u in users]
    failures = (await session.scalars(select(Link).where(Link.catalog_id == catalog_id,
        Link.writeback_state.in_(("error", "manual"))).order_by(Link.started_at.desc()).limit(20))).all()
    info["writebacks"] = [{"issueIid": row.issue_iid, "issueUrl": row.issue_url,
        "state": row.writeback_state, "lastError": row.last_error,
        "attempts": row.writeback_attempts, "nextRetryAt": stamp(row.next_retry_at)} for row in failures]
    return info


async def configure(session, catalog_id, *, enabled, started_label, user_id):
    if not isinstance(enabled, bool):
        raise ValueError("enabled 必须是布尔值")
    catalog = await session.get(am.ScmRepository, catalog_id)
    label = validate_label(started_label, catalog.provider if catalog else "gitlab")
    lease = await resource_leases.acquire(session, "repository-issues", catalog_id, ttl_seconds=120)
    try:
        row = await session.get(Sync, catalog_id, populate_existing=True)
        if enabled:
            repo, cfg = await source(session, catalog_id)
            boundary = now()
            snapshot = await call_remote(session, lease, adapter(repo).scan, cfg, repo.external_id, boundary, boundary)
            await refresh_members(session, repo, snapshot["members"])
        if row is None:
            row = Sync(catalog_id=catalog_id, created_by=user_id)
            session.add(row)
        if enabled and row.enabled_at is None:
            row.enabled_at = boundary
            row.cursor_at = boundary
        row.enabled = enabled
        row.started_label = label
        row.next_poll_at = now() if enabled else None
        row.last_error = ""
        await fence(session, lease)
        await session.commit()
    except BaseException:
        await session.rollback()
        raise
    finally:
        await resource_leases.release(session, lease)


async def map_member(session, catalog_id, external_id, user_id, scope):
    repo = await session.get(am.ScmRepository, catalog_id)
    if repo and repo.provider == "github":
        raise ValueError("GitHub 需求默认当前团队全员可见，无需关联仓库成员")
    lease = await resource_leases.acquire(session, "repository-issues", catalog_id, ttl_seconds=120)
    try:
        member = await session.get(Member, (catalog_id, str(external_id)), populate_existing=True)
        if member is None or not member.active:
            raise ValueError("该仓库成员已失效，请先刷新成员")
        target = await session.get(models.User, user_id) if user_id else None
        if user_id and (target is None or not target.is_active or scope is not None and target.org_id not in scope):
            raise ValueError("目标账号不存在、已停用或不在管理范围内")
        member.user_id = target.id if target else None
        member.mapping_source = "manual"
        await fence(session, lease)
        await session.commit()
    except BaseException:
        await session.rollback()
        raise
    finally:
        await resource_leases.release(session, lease)


async def run(session: AsyncSession, catalog_id: str, *, force=False):
    lease = await resource_leases.acquire(session, "repository-issues", catalog_id, ttl_seconds=120)
    try:
        setting = await session.get(Sync, catalog_id, populate_existing=True)
        if setting is None or not setting.enabled:
            raise ValueError("请先开启该仓库的 Issue 同步")
        if not force and setting.next_poll_at and utc(setting.next_poll_at) > now():
            return {"ok": True, "skipped": "not_due", "created": 0}
        repo, cfg = await source(session, catalog_id)
        upper = now()
        lower = utc(setting.cursor_at or setting.enabled_at) - timedelta(seconds=2)
        snapshot = await call_remote(session, lease, adapter(repo).scan, cfg, repo.external_id, lower, upper)
        await refresh_members(session, repo, snapshot["members"])
        issue_ids = list({int(issue["iid"]) for issue in snapshot["issues"]})
        existing = set()
        for offset in range(0, len(issue_ids), 500):
            existing.update((await session.scalars(select(Link.issue_iid).where(
                Link.catalog_id == catalog_id, Link.issue_iid.in_(issue_ids[offset:offset + 500])))).all())
        authors = {m.external_user_id: m.user_id for m in (await session.scalars(select(Member).where(
            Member.catalog_id == catalog_id, Member.active.is_(True), Member.user_id.isnot(None)))).all()} if repo.provider == "gitlab" else {}
        created, skipped = [], 0
        for issue in snapshot["issues"]:
            iid = int(issue["iid"])
            if iid in existing or utc(issue["created_at"]) < utc(setting.enabled_at):
                continue
            if issue.get("confidential"):
                skipped += 1
                continue
            author = issue.get("author") or {}
            task = models.Task(title=str(issue.get("title") or "未命名")[:200],
                note=str(issue.get("description") or ""), kind="requirement", triage_stage="intake",
                status="todo", origin=f"{repo.provider}_issue", source=f"{repo.full_name}#{iid}"[:120],
                integration_id=repo.integration_id, external_id=f"{repo.external_id}:{iid}",
                external_url=str(issue.get("web_url") or "")[:512], ext_repo=repo.full_name[:200],
                created_by=authors.get(str(author.get("id"))),
                created_by_name=str(author.get("name") or author.get("username") or "")[:64],
                tags=[str(x) for x in issue.get("labels", [])], owner_client_id=None,
                requirement_content={"sourceIssue": {"catalogId": catalog_id, "iid": iid}})
            session.add(task)
            await session.flush()
            session.add(Link(catalog_id=catalog_id, issue_id=str(issue["id"]), issue_iid=iid,
                task_id=task.id, issue_url=str(issue.get("web_url") or "")[:700]))
            existing.add(iid)
            created.append(task)
            if len(created) % 100 == 0:
                # Renew inside this transaction; never commit a partial import.
                await fence(session, lease)
        setting.cursor_at = upper
        setting.last_polled_at = upper
        setting.last_success_at = upper
        setting.next_poll_at = next_poll(upper)
        setting.last_created_count = len(created)
        setting.imported_count = (setting.imported_count or 0) + len(created)
        setting.skipped_confidential = skipped
        setting.last_error = ""
        await fence(session, lease)
        await session.commit()
        # A transport failure after commit must never roll the cursor backwards.
        from . import task_access
        for task in created:
            try:
                await session.refresh(task)
                await task_access.publish_task(session, task, "task.created")
            except Exception:
                pass  # authenticated list reload remains the source of truth
        return {"ok": True, "created": len(created), "skippedConfidential": skipped,
                "issueSync": (await summaries(session, [catalog_id]))[catalog_id]}
    except resource_leases.LeaseBusy:
        await session.rollback()
        raise
    except Exception as exc:
        await session.rollback()
        setting = await session.get(Sync, catalog_id, populate_existing=True)
        if setting and setting.enabled:
            setting.last_polled_at = now()
            setting.next_poll_at = next_poll(now())
            setting.last_error = safe_error(exc)
            try:
                await fence(session, lease)
                await session.commit()
            except resource_leases.LeaseBusy:
                await session.rollback()
        raise
    except BaseException:
        await session.rollback()
        raise
    finally:
        await resource_leases.release(session, lease)
