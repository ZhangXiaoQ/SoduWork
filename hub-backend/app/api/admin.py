"""Administrative APIs for authentication, RBAC, organizational scope, tasks, integrations, and
device management. Superusers see all records; other users see their department subtree and
unassigned devices. Client.user_ref determines device ownership.
"""
from datetime import datetime, timedelta, timezone
import logging

from fastapi import APIRouter, Body, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy import case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..auth import sign_token, verify_password
from ..config import get_settings
from ..db import get_session
from ..deps import current_user, has_perm, require_perm
from ..models import Attachment, Client, Role, Task, TaskEvent, User
from ..permissions import ALL_KEYS, PERMISSIONS
from ..realtime import hub
from ..schemas import (
    AdminLogin,
    AssignBody,
    AssignUserBody,
    BindingCreate,
    DispatchCreate,
    IntegrationCreate,
    IntegrationUpdate,
    OrgCreate,
    OrgUpdate,
    RoleCreate,
    RoleUpdate,
    UserCreate,
    UserUpdate,
    attachment_to_api,
    client_to_api,
    task_to_api,
)

from ..services import aggregation as agg
from ..services import audit
from ..services.task_access import publish_owner
from ..services import inbox as inbox_svc
from ..services import poller
from ..services import rbac
from ..services import client_access
from ..services import storage
from ..services import tasks as svc
from ..services import work_catalog
from ..services import device_auth
from ..services import device_connections
from ..services import environment_service

log = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/api/v1/admin", tags=["admin"])
settings = get_settings()


# Authentication and current user.

async def _me_payload(session: AsyncSession, user: User) -> dict:
    if user.is_super:
        perms = list(ALL_KEYS)
    elif user.role_id:
        r = await session.get(Role, user.role_id)
        perms = list(r.permissions or []) if r else []
    else:
        perms = []
    d = rbac.user_to_api(user)
    d["permissions"] = perms
    return d


@router.post("/login")
async def login(body: AdminLogin, session: AsyncSession = Depends(get_session)):
    user = await client_access.find_login_user(session, body.user, legacy_lookup=rbac.get_user_by_username)
    if user is None or not user.is_active or user.account_deleted_at or not verify_password(body.pw, user.password_hash):
        raise HTTPException(status_code=401, detail="账号或密码不正确")
    user.last_login_at = datetime.now(timezone.utc)
    await session.commit()
    return {"token": sign_token(user.id, user.auth_version),
            "user": await _me_payload(session, user)}


@router.get("/me")
async def me(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    return await _me_payload(session, user)


@router.get("/permissions", dependencies=[Depends(require_perm("role.manage"))])
async def permissions():
    return PERMISSIONS


# Visibility scope helpers.

async def _visible_client_ids(session: AsyncSession, user: User) -> set[str] | None:
    """Return visible client IDs: scoped owners plus unassigned devices, or None for superusers."""
    scope = await rbac.scope_org_ids(session, user)
    if scope is None:
        return None
    uids = await rbac.scoped_user_ids(session, scope) or set()
    res = await session.execute(select(Client.id, Client.user_ref))
    return {cid for cid, uref in res.all() if (uref in uids) or (uref is None)}


async def _assert_org_in_scope(session: AsyncSession, user: User, org_id: str | None):
    if user.is_super or not org_id:
        return
    scope = await rbac.scope_org_ids(session, user)
    if scope is not None and org_id not in scope:
        raise HTTPException(status_code=403, detail="只能在自己管辖的部门内操作")


async def _assert_user_in_scope(session: AsyncSession, user: User, target: User):
    if user.is_super:
        return
    scope = await rbac.scope_org_ids(session, user)
    if scope is not None and target.org_id not in scope:
        raise HTTPException(status_code=403, detail="无权管理该用户")


async def _assert_client_in_scope(session: AsyncSession, user: User, client: Client):
    if user.is_super:
        return
    vis = await _visible_client_ids(session, user)
    if vis is not None and client.id not in vis:
        raise HTTPException(status_code=403, detail="无权管理该 SoduWork")


def _org_mutation_error(exc: rbac.OrgMutationError) -> HTTPException:
    status, message = {
        "out_of_scope": (403, "只能在自己管辖的部门内操作"),
        "parent_not_found": (400, "上级部门不存在"),
        "cycle": (400, "部门不能移动到自身或下级部门"),
    }.get(exc.reason, (400, "组织架构操作无效"))
    return HTTPException(status_code=status, detail=message)


# Organizational structure.

@router.get("/orgs")
async def list_orgs(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    return await rbac.list_orgs(session, await rbac.scope_org_ids(session, user))


@router.post("/orgs")
async def create_org(
    body: OrgCreate, user: User = Depends(require_perm("org.manage")),
    session: AsyncSession = Depends(get_session),
):
    scope = await rbac.scope_org_ids(session, user)
    try:
        created = await rbac.create_org(
            session, body.name, body.parentId, body.sort, scope=scope)
    except rbac.OrgMutationError as exc:
        raise _org_mutation_error(exc) from exc
    await audit.log(session, user, "org.create", "org", created["id"],
                    created["name"], {"parentId": created.get("parentId")})
    return created


@router.patch("/orgs/{oid}")
async def update_org(
    oid: str, body: OrgUpdate,
    user: User = Depends(require_perm("org.manage")),
    session: AsyncSession = Depends(get_session),
):
    scope = await rbac.scope_org_ids(session, user)
    try:
        r = await rbac.update_org(
            session, oid, body.name, body.parentId, body.sort, scope=scope)
    except rbac.OrgMutationError as exc:
        raise _org_mutation_error(exc) from exc
    if r is None:
        raise HTTPException(status_code=404, detail="部门不存在")
    await audit.log(session, user, "org.update", "org", oid, r["name"], {
        "parentId": r.get("parentId"), "sort": r.get("sort"),
    })
    return r


@router.delete("/orgs/{oid}")
async def delete_org(
    oid: str, user: User = Depends(require_perm("org.manage")),
    session: AsyncSession = Depends(get_session),
):
    scope = await rbac.scope_org_ids(session, user)
    try:
        r = await rbac.delete_org(session, oid, scope=scope)
    except rbac.OrgMutationError as exc:
        raise _org_mutation_error(exc) from exc
    if not r["ok"]:
        msg = {"has_children": "该部门下还有子部门", "has_users": "该部门下还有用户", "not_found": "部门不存在"}
        raise HTTPException(status_code=400, detail=msg.get(r["reason"], "无法删除"))
    await audit.log(session, user, "org.delete", "org", oid, r.get("name", ""), {})
    return r


# Roles.

@router.get("/roles")
async def list_roles(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    return await rbac.list_roles(session)


@router.post("/roles")
async def create_role(body: RoleCreate,
                      user: User = Depends(require_perm("role.manage")),
                      session: AsyncSession = Depends(get_session)):
    result = await rbac.create_role(session, body.name, body.permissions)
    await audit.log(session, user, "role.create", "role", result.get("id"),
                    result.get("name", ""), {"permissions": result.get("permissions", [])})
    return result


@router.patch("/roles/{rid}")
async def update_role(rid: str, body: RoleUpdate,
                      user: User = Depends(require_perm("role.manage")),
                      session: AsyncSession = Depends(get_session)):
    r = await rbac.update_role(session, rid, body.name, body.permissions)
    if r is None:
        raise HTTPException(status_code=404, detail="角色不存在")
    await audit.log(session, user, "role.update", "role", rid, r.get("name", ""),
                    {"permissions": body.permissions} if body.permissions is not None else {})
    return r


@router.delete("/roles/{rid}")
async def delete_role(rid: str,
                      user: User = Depends(require_perm("role.manage")),
                      session: AsyncSession = Depends(get_session)):
    target = await session.get(Role, rid)
    label = target.name if target else ""
    r = await rbac.delete_role(session, rid)
    if not r["ok"]:
        msg = {"system_role": "系统内置角色不可删", "in_use": "仍有用户在用该角色", "not_found": "角色不存在"}
        raise HTTPException(status_code=400, detail=msg.get(r["reason"], "无法删除"))
    await audit.log(session, user, "role.delete", "role", rid, label, {})
    return r


# Users within the current scope.

@router.get("/users", dependencies=[Depends(require_perm("user.manage"))])
async def list_users(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    return await rbac.list_users(session, await rbac.scope_org_ids(session, user))


@router.post("/users")
async def create_user(
    body: UserCreate,
    user: User = Depends(require_perm("user.manage")),
    session: AsyncSession = Depends(get_session),
):
    if body.tokenQuota is not None and not has_perm(user, "quota.manage"):
        raise HTTPException(status_code=403, detail="请由额度管理员调整用户额度")
    if not body.orgId:
        raise HTTPException(status_code=400, detail="请为用户指定所属部门")
    await _assert_org_in_scope(session, user, body.orgId)
    if await rbac.get_user_by_username(session, body.username):
        raise HTTPException(status_code=400, detail="用户名已存在")
    try:
        position_ids = await work_catalog.validate_profession_ids(
            session, body.orgId, body.positions or [])
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    created = await rbac.create_user(
        session, body.username, body.password, body.displayName,
        body.orgId, body.roleId, position_ids, body.domains,
        token_quota=body.tokenQuota.model_dump() if body.tokenQuota is not None else None)
    await audit.log(session, user, "user.create", "user", created.get("id"), created.get("displayName") or body.username,
                    {"orgId": body.orgId, "roleId": body.roleId})
    return created


@router.patch("/users/{uid}")
async def update_user(
    uid: str,
    body: UserUpdate,
    user: User = Depends(require_perm("user.manage")),
    session: AsyncSession = Depends(get_session),
):
    target = await session.get(User, uid, with_for_update=True, populate_existing=True)
    if target is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    await _assert_user_in_scope(session, user, target)
    if body.orgId is not None:
        await _assert_org_in_scope(session, user, body.orgId)
    if target.is_super and body.isActive is False:
        raise HTTPException(status_code=400, detail="不能停用超级管理员")
    was_active = bool(target.is_active)
    patch = body.model_dump(exclude_none=True)
    target_org_id = body.orgId if body.orgId is not None else target.org_id
    if body.positions is not None or body.orgId is not None:
        try:
            patch["positions"] = await work_catalog.validate_profession_ids(
                session, target_org_id,
                body.positions if body.positions is not None else target.positions)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
    updated = await rbac.update_user(session, uid, patch)
    if was_active and patch.get("isActive") is False:
        bound_clients = list((await session.execute(
            select(Client).where(Client.user_ref == uid)
        )).scalars().all())
        for bound in bound_clients:
            if bound.auth_state != "revoked":
                device_auth.revoke(bound)
        await session.commit()
        client_ids = [bound.id for bound in bound_clients]
        await device_connections.disconnect_many(client_ids)
    await audit.log(session, user, "user.update", "user", uid, target.display_name or target.username,
                    {"fields": [k for k in patch if k != "password"], "pwChanged": "password" in patch})
    return updated


# Professional profiles are independent of permissions; built-in profiles are read-only and organizations may add their own.

@router.get("/positions")
async def list_positions(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    return await rbac.list_positions(
        session, await rbac.scope_org_ids(session, user))


@router.post("/positions")
async def create_position(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("work.catalog.manage")),
    session: AsyncSession = Depends(get_session),
):
    org_id = str(body.get("orgId") or user.org_id or "")
    if not org_id:
        raise HTTPException(status_code=400, detail="请先选择所属组织")
    await _assert_org_in_scope(session, user, org_id)
    try:
        row = await work_catalog.save_profession(session, body, org_id)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    result = work_catalog.profession_api(row)
    await audit.log(session, user, "profession.create", "position",
                    row.id, row.name, {"orgId": org_id})
    return result


@router.patch("/positions/{pid}")
async def update_position(
    pid: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("work.catalog.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(models.Position, pid)
    if row is None:
        raise HTTPException(status_code=404, detail="职业画像不存在")
    if row.is_system or row.org_id is None:
        raise HTTPException(status_code=400, detail="平台职业是只读基线，请新建企业职业")
    await _assert_org_in_scope(session, user, row.org_id)
    try:
        row = await work_catalog.save_profession(
            session, body, row.org_id, row)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    result = work_catalog.profession_api(row)
    await audit.log(session, user, "profession.update", "position",
                    pid, row.name, {"fields": sorted(body)})
    return result


@router.delete("/positions/{pid}")
async def delete_position(
    pid: str,
    user: User = Depends(require_perm("work.catalog.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(models.Position, pid)
    if row is None:
        raise HTTPException(status_code=404, detail="职业画像不存在")
    if row.org_id:
        await _assert_org_in_scope(session, user, row.org_id)
    reason = await work_catalog.delete_profession(session, row)
    if reason:
        raise HTTPException(status_code=400, detail=reason)
    await audit.log(session, user, "profession.delete", "position",
                    pid, row.name, {})
    return {"ok": True}

# Responsibility catalog: readable by authenticated users; mutations require user.manage.

@router.get("/domains")
async def list_domains(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    return await rbac.list_domains(session)


@router.post("/domains")
async def create_domain(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("user.manage")),
    session: AsyncSession = Depends(get_session),
):
    r = await rbac.create_domain(session, (body.get("name") or "").strip(), int(body.get("sort") or 0))
    await audit.log(session, user, "domain.create", "domain", r["id"], r["name"], {})
    return r


@router.patch("/domains/{did}")
async def update_domain(
    did: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("user.manage")),
    session: AsyncSession = Depends(get_session),
):
    r = await rbac.update_domain(session, did, body.get("name"), body.get("sort"))
    if r is None:
        raise HTTPException(status_code=404, detail="领域不存在")
    await audit.log(session, user, "domain.update", "domain", did, r["name"], {})
    return r


@router.delete("/domains/{did}")
async def delete_domain(
    did: str,
    user: User = Depends(require_perm("user.manage")),
    session: AsyncSession = Depends(get_session),
):
    r = await rbac.delete_domain(session, did)
    if not r.get("ok"):
        msg = {"not_found": "领域不存在", "system": "内置领域不可删除"}.get(r.get("reason"), "删除失败")
        raise HTTPException(status_code=404 if r.get("reason") == "not_found" else 400, detail=msg)
    await audit.log(session, user, "domain.delete", "domain", did, did, {})
    return r


# Scoped device fleet and SoduWork ownership.

@router.get("/clients")
async def list_clients(
    paged: bool = Query(default=False),
    q: str = Query(default="", max_length=120),
    state: str = Query(default="all", pattern="^(all|online|offline|pending)$"),
    form: str = Query(default="all", pattern="^(all|desktop|mobile)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, alias="pageSize", ge=10, le=100),
    user: User = Depends(require_perm("client.view")),
    session: AsyncSession = Depends(get_session),
):
    vis = await _visible_client_ids(session, user)
    if not paged:
        res = await session.execute(select(Client).order_by(Client.created_at.desc()))
        return [
            client_to_api(c, settings.offline_after_seconds)
            for c in res.scalars().all()
            if vis is None or c.id in vis
        ]

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=settings.offline_after_seconds)
    scope = [] if vis is None else [Client.id.in_(vis)]
    state_where = {
        "online": [Client.last_seen_at.is_not(None), Client.last_seen_at >= cutoff],
        "offline": [or_(Client.last_seen_at.is_(None), Client.last_seen_at < cutoff)],
        "pending": [Client.auth_state != "active"],
    }.get(state, [])
    # Manage mobile and desktop clients in the same device inventory.
    # Mobile approvals, assignments, and task views reuse these device identities.
    platform_lc = func.lower(func.coalesce(Client.platform, ""))
    is_mobile = or_(platform_lc.like("android%"), platform_lc.like("ios%"),
                    platform_lc.like("harmony%"), platform_lc == "mobile")
    form_where = {"mobile": [is_mobile], "desktop": [~is_mobile]}.get(form, [])
    keyword = q.strip().lower()
    search = []
    if keyword:
        like = f"%{keyword}%"
        search = [or_(
            func.lower(func.coalesce(Client.name, "")).like(like),
            func.lower(Client.id).like(like),
            func.lower(func.coalesce(User.display_name, "")).like(like),
            func.lower(func.coalesce(User.username, "")).like(like),
        )]

    total = int(await session.scalar(
        select(func.count()).select_from(Client).outerjoin(User, User.id == Client.user_ref)
        .where(*scope, *state_where, *form_where, *search)
    ) or 0)
    summary = (await session.execute(
        select(
            func.count(),
            func.sum(case((Client.last_seen_at >= cutoff, 1), else_=0)),
            func.sum(case((Client.auth_state != "active", 1), else_=0)),
            func.sum(case((is_mobile, 1), else_=0)),
        ).select_from(Client).where(*scope)
    )).one()
    all_count = int(summary[0] or 0)
    online_count, pending_count = int(summary[1] or 0), int(summary[2] or 0)
    mobile_count = int(summary[3] or 0)

    query = (
        select(Client, User.display_name, User.username)
        .outerjoin(User, User.id == Client.user_ref)
        .where(*scope, *state_where, *form_where, *search)
        .order_by(
            case((Client.last_seen_at >= cutoff, 1), else_=0).desc(),
            Client.created_at.desc(),
        )
        .offset((page - 1) * page_size).limit(page_size)
    )
    rows = await session.execute(query)
    items = []
    for client, display_name, username in rows.all():
        item = client_to_api(client, settings.offline_after_seconds)
        item["ownerName"] = display_name or username or ""
        items.append(item)
    return {
        "items": items, "total": total, "page": page, "pageSize": page_size,
        "counts": {
            "all": all_count, "online": online_count,
            "offline": all_count - online_count, "pending": pending_count,
            "mobile": mobile_count,
        },
    }

@router.post("/clients/{cid}/assign")
async def assign_client(
    cid: str,
    body: AssignUserBody,
    user: User = Depends(require_perm("client.assign")),
    session: AsyncSession = Depends(get_session),
):
    """Assign a client to Client.user_ref; an empty userId returns it to the unassigned pool."""
    c = await session.get(Client, cid)
    if c is None:
        raise HTTPException(status_code=404, detail="SoduWork 不存在")
    await _assert_client_in_scope(session, user, c)
    connection_changed = False
    replaced_desktops = []
    if body.userId:
        target = await session.get(User, body.userId)
        if target is None or not target.is_active:
            raise HTTPException(status_code=400, detail="目标用户不存在")
        await _assert_user_in_scope(session, user, target)
        from ..services import desktop_login_policy
        await desktop_login_policy.lock_assignment(session, c, target)
        await _assert_client_in_scope(session, user, c)
        await _assert_user_in_scope(session, user, target)
        if not target.is_active or target.account_deleted_at:
            raise HTTPException(status_code=400, detail="目标用户不存在")
        if not c.secret_hash:
            raise HTTPException(status_code=409, detail="这台 SoduWork 还没有提交设备密钥")
        if c.user_ref != target.id or c.auth_state != "active":
            connection_changed = True
            device_auth.activate(c, target)
        replaced_desktops = await desktop_login_policy.replace_previous(session, c, target)
    else:
        connection_changed = bool(c.user_ref or c.auth_state == "active")
        if c.auth_state == "active":
            device_auth.revoke(c)
        c.user_ref = None
    await session.commit()
    if connection_changed:
        await device_connections.disconnect(cid)
    for previous_id in replaced_desktops:
        await device_connections.disconnect(previous_id, 4401)
    await audit.log(session, user, "client.assign", "client", cid, c.name or cid,
                    {"ownerUserId": c.user_ref})
    return {"ok": True, "ownerUserId": c.user_ref, "authState": c.auth_state}


@router.post("/clients/{cid}/activate")
async def activate_client(
    cid: str,
    body: AssignUserBody,
    user: User = Depends(require_perm("client.assign")),
    session: AsyncSession = Depends(get_session),
):
    c = await session.get(Client, cid)
    if c is None:
        raise HTTPException(status_code=404, detail="SoduWork 不存在")
    await _assert_client_in_scope(session, user, c)
    if not c.secret_hash:
        raise HTTPException(status_code=409, detail="这台 SoduWork 还没有提交设备密钥，请先让客户端连接一次")
    target = await session.get(User, body.userId) if body.userId else None
    if target is None or not target.is_active:
        raise HTTPException(status_code=400, detail="请选择一个可用的归属用户")
    await _assert_user_in_scope(session, user, target)
    from ..services import desktop_login_policy
    await desktop_login_policy.lock_assignment(session, c, target)
    await _assert_client_in_scope(session, user, c)
    await _assert_user_in_scope(session, user, target)
    if not target.is_active or target.account_deleted_at or not c.secret_hash:
        raise HTTPException(status_code=409, detail="设备或账号授权已变化，请刷新后重试")
    device_auth.activate(c, target)
    replaced_desktops = await desktop_login_policy.replace_previous(session, c, target)
    await session.commit()
    await device_connections.disconnect(cid)
    for previous_id in replaced_desktops:
        await device_connections.disconnect(previous_id, 4401)
    await audit.log(session, user, "client.activate", "client", cid, c.name or cid,
                    {"ownerUserId": target.id})
    return {"ok": True, "ownerUserId": target.id, "authState": c.auth_state}


@router.post("/clients/{cid}/revoke")
async def revoke_client(
    cid: str,
    user: User = Depends(require_perm("client.control")),
    session: AsyncSession = Depends(get_session),
):
    c = await session.get(Client, cid)
    if c is None:
        raise HTTPException(status_code=404, detail="SoduWork 不存在")
    await _assert_client_in_scope(session, user, c)
    device_auth.revoke(c)
    await session.commit()
    await device_connections.disconnect(cid)
    await audit.log(session, user, "client.revoke", "client", cid, c.name or cid, {})
    return {"ok": True, "authState": c.auth_state}


@router.post("/clients/{cid}/reset-enrollment")
async def reset_client_enrollment(
    cid: str,
    user: User = Depends(require_perm("client.control")),
    session: AsyncSession = Depends(get_session),
):
    c = await session.get(Client, cid)
    if c is None:
        raise HTTPException(status_code=404, detail="SoduWork 不存在")
    await _assert_client_in_scope(session, user, c)
    device_auth.reset_enrollment(c)
    await session.commit()
    await device_connections.disconnect(cid)
    await audit.log(session, user, "client.reset_enrollment", "client", cid, c.name or cid, {})
    return {"ok": True, "authState": c.auth_state}


@router.post("/clients/{cid}/reset-secret")
async def reset_client_secret(
    cid: str,
    user: User = Depends(require_perm("client.control")),
    session: AsyncSession = Depends(get_session),
):
    """Compatibility alias for the secure enrollment reset operation."""
    c = await session.get(Client, cid)
    if c is None:
        raise HTTPException(status_code=404, detail="SoduWork 不存在")
    await _assert_client_in_scope(session, user, c)
    device_auth.reset_enrollment(c)
    await session.commit()
    await device_connections.disconnect(cid)
    await audit.log(session, user, "client.reset_secret", "client", cid, c.name or cid, {})
    return {"ok": True, "authState": c.auth_state}


# Scoped tasks and dispatch.

@router.get("/tasks")
async def list_all_tasks(
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
    origin: str | None = None,
    owner: str | None = None,
):
    q = select(Task).order_by(Task.created_at.desc())
    if origin:
        q = q.where(Task.origin == origin)
    if owner:
        q = q.where(Task.owner_client_id == owner)
    res = await session.execute(q)
    vis = await _visible_client_ids(session, user)
    rows = [t for t in res.scalars().all() if vis is None or t.owner_client_id in vis]
    states = await svc.ai_states(session, [t.id for t in rows])
    # This list uses the same administrative scope as task execution details.
    # Make access explicit for shared selectors; never infer it from visibility.
    out = [{**task_to_api(t), "canViewExecution": True,
             "canRunPlugin": user.is_super or "plugin.run" in getattr(user, "_perms", set()),
             **({"ai": states[t.id]} if t.id in states else {})} for t in rows]
    from ..services import task_requirement_projection
    return await task_requirement_projection.decorate_many(session, rows, out)


async def _assert_task_in_scope(session: AsyncSession, user: User, tid: str) -> Task:
    t = await session.get(Task, tid)
    if t is None:
        raise HTTPException(status_code=404, detail="需求不存在")
    if not user.is_super:
        vis = await _visible_client_ids(session, user)
        if vis is not None and t.owner_client_id not in vis:
            raise HTTPException(status_code=403, detail="无权操作该需求")
    return t


# Legacy task workflow routes are retired: /workflow/tasks, /tasks/{tid}/workflow, advance, and reject.
# Multi-stage work uses plugin WorkflowRun instances, including human approval nodes.
# Direct assignments use /users/{uid}/tasks with ordinary tasks and completion receipts.


@router.get("/daily-reports")
async def list_daily_reports(
    date: str = "", user_id: str = "",
    org_id: str = Query(default="", alias="orgId"),
    user: User = Depends(require_perm("task.view")), session: AsyncSession = Depends(get_session)
):
    """Return the current team's overview, with drill-down into direct subteams and individual
    facts.
    """
    from ..services import daily_report as dr, team_daily_report as tdr
    day = (date or "").strip() or dr.today_str()
    try:
        data = await tdr.overview(session, user, day, org_id)
    except PermissionError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    if user_id:
        data["reports"] = [row for row in data.get("reports") or []
                           if row.get("userId") == user_id]
        data["members"] = [row for row in data.get("members") or []
                           if row.get("userId") == user_id]
    return data


@router.post("/daily-reports/generate")
async def generate_daily_reports(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("task.view")), session: AsyncSession = Depends(get_session)
):
    """Generate today's reports on demand for scoped members, or one specified userId. Skip members
    without tasks; report inactive ongoing work accurately. notify=False prevents repeated
    desktop notifications.
    """
    from ..services import daily_report as dr, team_daily_report as tdr
    day = (body.get("date") or "").strip() or dr.today_str()
    uid = (body.get("userId") or "").strip()

    scope = await rbac.scope_org_ids(session, user)
    uids = await rbac.scoped_user_ids(session, scope)          # None leaves superusers unrestricted.
    q = select(User).where(User.is_active.is_(True))
    if uid:
        q = q.where(User.id == uid)
    targets = (await session.execute(q)).scalars().all()
    if uids is not None:
        targets = [u for u in targets if u.id in uids or u.id == user.id]
    if uid and not targets:
        raise HTTPException(status_code=403, detail="该用户不在你的管理范围内")

    made, skipped = 0, 0
    for t in targets:
        try:
            if await dr.generate_for(session, t, day, notify=False):
                made += 1
            else:
                skipped += 1
        except Exception:                                       # noqa: BLE001  Keep one member's failure from affecting other reports.
            await session.rollback()
            skipped += 1
    teams = await tdr.generate_scope(session, day, scope, force=True)
    await audit.log(session, user, "report.generate", "report", uid or None, day,
                    {"made": made, "skipped": skipped, "teams": len(teams), "date": day})
    return {"date": day, "made": made, "skipped": skipped,
            "total": len(targets), "teamReports": len(teams)}


@router.post("/team-daily-reports/{report_id}/confirm")
async def confirm_team_daily_report(
    report_id: str, body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("task.view")), session: AsyncSession = Depends(get_session)
):
    """Confirm current team facts; source changes invalidate prior confirmation and require a new
    summary.
    """
    from ..models import TeamDailyReport
    from ..services import team_daily_report as tdr
    report = await session.get(TeamDailyReport, report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="团队日报不存在")
    await _assert_org_in_scope(session, user, report.org_id)
    try:
        report = await tdr.confirm(session, user, report_id, str(body.get("note") or ""))
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    await audit.log(session, user, "report.team_confirm", "team_daily_report",
                    report.id, report.org_name, {"date": report.date})
    return tdr.to_api(report)


@router.get("/tasks/{tid}/attachments")
async def task_attachments(
    tid: str, user: User = Depends(require_perm("task.view")), session: AsyncSession = Depends(get_session)
):
    """Return task attachments with short-lived, single-file download tickets."""
    t = await session.get(Task, tid)
    if t is None:
        raise HTTPException(status_code=404, detail="需求不存在")
    vis = await _visible_client_ids(session, user)
    if vis is not None and t.owner_client_id not in vis:
        raise HTTPException(status_code=403, detail="超出作用域")
    res = await session.execute(
        select(Attachment).where(Attachment.task_id == tid).order_by(Attachment.created_at)
    )
    return [attachment_to_api(a) for a in res.scalars().all()]


@router.post("/tasks/{tid}/attachments")
async def upload_task_attachment(
    tid: str,
    file: UploadFile = File(...),
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    """Upload attachments to a scoped task, including tasks assigned to another owner."""
    t = await session.get(Task, tid)
    if t is None:
        raise HTTPException(status_code=404, detail="需求不存在")
    vis = await _visible_client_ids(session, user)
    if vis is not None and t.owner_client_id not in vis:
        raise HTTPException(status_code=403, detail="超出作用域")
    data = await file.read()
    max_bytes = settings.attach_max_mb * 1024 * 1024
    if len(data) > max_bytes:
        raise HTTPException(status_code=413, detail=f"文件超过 {settings.attach_max_mb}MB 上限")
    if not data:
        raise HTTPException(status_code=400, detail="空文件")
    fn = (file.filename or "file").replace("/", "_").replace("\\", "_").strip()[:200] or "file"
    ct = file.content_type or "application/octet-stream"
    a = Attachment(task_id=tid, filename=fn, content_type=ct, size=len(data), uploaded_by="admin:" + user.id)
    a.storage_key = f"att/{tid}/{a.id}/{fn}"
    a.backend = storage.put(a.storage_key, data, ct)
    session.add(a)
    await session.commit()
    await session.refresh(a)
    await audit.log(session, user, "task.attachment.upload", "attachment", a.id, fn,
                    {"taskId": tid, "size": len(data),
                     "contentType": ct[:120]})
    return attachment_to_api(a)


@router.get("/tasks/{tid}")
async def task_detail(
    tid: str,
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    t = await _assert_task_in_scope(session, user, tid)
    from ..services import task_events
    d = await svc.task_to_api_live(session, t)
    d["timeline"] = await task_events.timeline(session, tid)
    return d

@router.post("/tasks/{tid}/nudge")
async def nudge_task(
    tid: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    """Notify the current task holder with a desktop reminder without changing task state."""
    t = await _assert_task_in_scope(session, user, tid)
    if not t.owner_client_id:
        raise HTTPException(status_code=400, detail="需求没有归属 SoduWork，没法催")
    if t.status == "done":
        raise HTTPException(status_code=400, detail="需求已完成，不用催了")
    who = user.display_name or user.username
    note = str(body.get("note") or "").strip()
    text = f"⏰ {who} 催办：「{t.title}」" + (f"——{note}" if note else "，抽空推进一下~")
    delivered = await publish_owner(session, t, {"type": "notice", "text": text, "taskId": tid})
    await audit.log(session, user, "task.nudge", "task", tid, t.title, {"note": note})
    return {"ok": True, "delivered": delivered and hub.is_online(t.owner_client_id)}


@router.post("/tasks/{tid}/agent-run")
async def agent_run_task(
    tid: str,
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    """Start a background SoduWork execution, attach outputs, and record timeline events. Reject
    duplicate starts while execution is active.
    """
    from ..services import agent_runner
    t = await _assert_task_in_scope(session, user, tid)
    if t.status == "done":
        raise HTTPException(status_code=400, detail="需求已完成，不需要执行")
    who = user.display_name or user.username
    try:
        r = await agent_runner.start(session, t, who)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    await audit.log(session, user, "task.agent_run", "task", tid, t.title, {})
    return r


@router.get("/tasks/{tid}/agent-status")
async def agent_run_status(
    tid: str,
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    """Return execution activity and the latest terminal event for drawer polling."""
    from sqlalchemy import select as _sel

    from ..services import agent_runner
    await _assert_task_in_scope(session, user, tid)
    ev = (await session.execute(
        _sel(TaskEvent).where(TaskEvent.task_id == tid, TaskEvent.kind.in_(("agent.done", "agent.failed")))
        .order_by(TaskEvent.at.desc()).limit(1)
    )).scalars().first()
    return {
        "running": agent_runner.is_running(tid),
        "last": ({"kind": ev.kind, "detail": ev.detail or {}} if ev else None),
    }


# Projects and repositories: retain existing Python imports and route order.
from .admin_projects import (
    _project_owner, _repo_api,
    add_project_task, add_repo, create_project, delete_project, delete_repo,
    list_ai_projects, list_projects, list_repos, project_detail,
    project_owner_options, update_project, update_repo,
    router as project_router,
)

router.include_router(project_router)


# Configurable development instructions sent to the AI.
# These settings control AI development instructions, not workflow orchestration.
# Plugins and WorkflowRun control handoffs between people and stages.

@router.get("/dev-flow")
async def get_dev_flow(user: User = Depends(require_perm("task.dispatch")),
                       session: AsyncSession = Depends(get_session)):
    """Return shared development defaults and option metadata for the configuration UI."""
    from ..services import ai_flow_presets, ai_prompts
    return {"cfg": await ai_prompts.load_default(session),
            "defaults": dict(ai_prompts.DEFAULTS),
            # Use the built-in steps to display and initialize an uncustomized workflow.
            "defaultSteps": [dict(s) for s in ai_flow_presets.DEFAULT_STEPS],

            "presets": [{"id": p["id"], "name": p["name"], "desc": p["desc"], "cfg": p["cfg"]}
                        for p in ai_flow_presets.PRESETS],
            # Report the execution environment detected on the Runner; it is not an administrator setting.
            "env": ai_prompts.detect_env(),
            # Expose fixed constraints so administrators can distinguish them from configurable options.
            "locked": ["不许合并到基线分支（合并由 SoduWork 做）",
                       "不许发布上线 / 连生产机 / 重启服务 / 动数据库",
                       "不许 force push、不许改已推历史",
                       "浏览器必须用随机高位端口 + 独立 user-data-dir",
                       "不许在前台跑长驻命令（会被静默看门狗掐掉）"]}


@router.put("/dev-flow")
async def put_dev_flow(body: dict = Body(default_factory=dict),
                       user: User = Depends(require_perm("task.dispatch")),
                       session: AsyncSession = Depends(get_session)):
    from ..services import ai_prompts
    cfg = body.get("cfg") if isinstance(body.get("cfg"), dict) else body
    err = ai_prompts.check(cfg)
    if err:
        raise HTTPException(status_code=400, detail=err)
    merged = await ai_prompts.save_default(session, cfg)
    await session.commit()
    await audit.log(session, user, "devflow.update", "setting", ai_prompts.SETTING_KEY,
                    "研发流程默认配置", {"cfg": merged})
    return {"ok": True, "cfg": merged}


@router.post("/dev-flow/preview")
async def preview_dev_flow(body: dict = Body(default_factory=dict),
                           user: User = Depends(require_perm("task.dispatch")),
                           session: AsyncSession = Depends(get_session)):
    """Render the exact instructions that execution will receive. Include repository overrides when
    repoId is supplied, so the preview matches dispatch.
    """
    from ..models import Repo
    from ..services import ai_prompts
    cfg = body.get("cfg") if isinstance(body.get("cfg"), dict) else None
    rid = str(body.get("repoId") or "").strip()
    repo = await session.get(Repo, rid) if rid else None
    if cfg is None:                       # Without cfg, preview the saved configuration.
        cfg = await ai_prompts.resolve(session, repo)
    else:
        cfg = ai_prompts.normalize(cfg, base=await ai_prompts.load_default(session))
    branch = (getattr(repo, "default_branch", "") or "main") if repo else "main"
    return {"cfg": cfg,
            "text": ai_prompts.dev_flow(branch, local=bool(body.get("local", True)),
                                        task_id=str(body.get("taskId") or "tmsxxxxxxxxx"),
                                        cfg=cfg, unattended=bool(body.get("unattended")),
                                        # Use the executor's actual environment, matching dispatch.
                                        env=ai_prompts.detect_env()),
            "branch": ai_prompts.work_branch(str(body.get("taskId") or "tmsxxxxxxxxx"), cfg)}


# Scheduled assignments use the shared contract with organizational scope.
from .admin_schedules import (
    _sch_api, _sch_apply, _scoped_ai_schedule,
    create_ai_schedule, delete_ai_schedule, list_ai_schedule_runs,
    list_ai_schedules, list_automation_templates, run_ai_schedule,
    save_automation_templates, update_ai_schedule,
    router as schedule_router, template_router,
)


def _iso_utc_dt(dt) -> str:
    """Return an unambiguous UTC ISO timestamp; SQLite naive values are UTC."""
    if not dt:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


router.include_router(template_router)


@router.get("/repos")
async def list_all_repos(user: User = Depends(require_perm("task.view")),
                         session: AsyncSession = Depends(get_session)):
    """List repositories across projects, including project names for the schedule selector."""
    from ..models import Project, Repo
    from ..services import rbac
    scope = await rbac.scope_org_ids(session, user)
    repo_q = select(Repo).order_by(Repo.created_at)
    project_q = select(Project)
    if scope is not None:
        allowed = scope or {"__none__"}
        repo_q = repo_q.where((Repo.org_id.in_(allowed)) | Repo.org_id.is_(None))
        project_q = project_q.where((Project.org_id.in_(allowed)) | Project.org_id.is_(None))
    rows = (await session.execute(repo_q)).scalars().all()
    pnames = {p.id: p.name for p in (await session.execute(project_q)).scalars().all()}
    return [{**_repo_api(r), "projectName": pnames.get(r.project_id, "")} for r in rows]
router.include_router(schedule_router)


# MCP servers provide external tools for the mcp-tools skill.
# Store configuration outside repository servers.json files because env may contain credentials.
# Write runtime configuration outside the repository and pass its path to the bridge through the environment.

def _mcp_mask(r: dict) -> dict:
    """Redact env values, HTTP authentication headers, clientSecret, and passwords. Return
    configured field names without plaintext credentials.
    """
    kc = dict(r.get("keycloak") or {})
    for k in ("clientSecret", "password"):
        if kc.get(k):
            kc[k] = "••••"
    return {**r,
            "env": {k: "••••" if v else "" for k, v in (r.get("env") or {}).items()},
            "headers": {k: "••••" if v else "" for k, v in (r.get("headers") or {}).items()},
            "keycloak": kc}


def _mcp_restore(r: dict, prev: dict) -> dict:
    """Preserve stored values for masked fields so unrelated edits cannot erase credentials."""
    def merge(cur: dict, old: dict) -> dict:
        return {k: (old.get(k, "") if str(v) == "••••" else v) for k, v in (cur or {}).items()}
    out = dict(r)
    out["env"] = merge(r.get("env") if isinstance(r.get("env"), dict) else {},
                       prev.get("env") or {})
    out["headers"] = merge(r.get("headers") if isinstance(r.get("headers"), dict) else {},
                           prev.get("headers") or {})
    kc = dict(r.get("keycloak") or {})
    old_kc = dict(prev.get("keycloak") or {})
    for k in ("clientSecret", "password"):
        if str(kc.get(k) or "") == "••••":
            kc[k] = old_kc.get(k, "")
    out["keycloak"] = kc
    return out


@router.get("/mcp-servers")
async def list_mcp_servers(user: User = Depends(require_perm("integration.manage")),
                           session: AsyncSession = Depends(get_session)):
    from ..services import mcp_servers as mcp
    rows = await mcp.load(session)
    from ..services import mcp_company_write
    return {**mcp_company_write.view(rows), "runtimeFile": mcp.runtime_path()}


@router.put("/mcp-servers")
async def save_mcp_servers(body: dict = Body(default_factory=dict),
                           user: User = Depends(require_perm("integration.manage")),
                           session: AsyncSession = Depends(get_session)):
    from ..services import mcp_company_write, mcp_servers as mcp
    saved = await mcp_company_write.legacy_save(session, body)
    await session.commit()
    await audit.log(session, user, "mcp.update", "setting", mcp.SETTING_KEY, "连接器",
                    {"count": len(saved), "names": [r["name"] for r in saved]})
    return {"ok": True, **mcp_company_write.view(saved)}


@router.post("/mcp-servers/upsert")
async def upsert_mcp_server(body: dict = Body(default_factory=dict),
                            user: User = Depends(require_perm("integration.manage")),
                            session: AsyncSession = Depends(get_session)):
    from ..services import mcp_company_write
    saved = await mcp_company_write.save_one(session, body)
    await session.commit()
    await audit.log(session, user, "mcp.upsert", "mcp", str(body["server"]["id"]), "连接器", {})
    return {"ok": True, **mcp_company_write.view(saved)}


@router.delete("/mcp-servers/{item_id}")
async def delete_mcp_server(item_id: str, body: dict = Body(default_factory=dict),
                            user: User = Depends(require_perm("integration.manage")),
                            session: AsyncSession = Depends(get_session)):
    from ..services import mcp_company_write
    saved = await mcp_company_write.delete_one(session, item_id, body)
    await session.commit()
    await audit.log(session, user, "mcp.delete", "mcp", item_id, "连接器", {})
    return {"ok": True, **mcp_company_write.view(saved)}


@router.post("/mcp-servers/probe")
async def probe_mcp_server(body: dict = Body(default_factory=dict),
                           user: User = Depends(require_perm("integration.manage")),
                           session: AsyncSession = Depends(get_session)):
    """Probe each transport at its actual execution location: HTTP on Hub, stdio on an online
    Runner.
    """
    from ..services import mcp_servers as mcp
    spec = dict(body or {})
    # Resolve masked UI credentials to their stored values before probing.
    if str(spec.get("id") or ""):
        prev = next((r for r in await mcp.load(session) if r["id"] == spec["id"]), None)
        if prev:
            spec = _mcp_restore(spec, prev)
    return await mcp.probe_managed(spec)


# Agent Skills catalog.
# A skill is a directory with SKILL.md. Inject the enabled set into the executor.
# Pi uses --skill arguments; other executors receive an instruction list. Store skill scripts and references on disk.
# Filesystem storage also supports cloned skill repositories.

@router.get("/skills")
async def list_skills(user: User = Depends(require_perm("task.dispatch")),
                      session: AsyncSession = Depends(get_session)):
    """Manage the skills allowlist, leaving personal selections to GET/PUT /api/v1/skills. Include
    current usage before administrators revoke access.
    """
    from sqlalchemy import select as _sel

    from ..models import Client as _C
    from ..services import skills as sk
    cfg = await sk.load_cfg(session)
    found = sk.scan(cfg.get("roots"))
    en = set(cfg["allowed"])
    users: dict[str, int] = {}
    for c in (await session.execute(_sel(_C))).scalars().all():
        for n in (c.skills or []):
            users[str(n)] = users.get(str(n), 0) + 1
    return {"skills": [{**s, "allowed": s["name"] in en, "enabled": s["name"] in en,
                        "inUse": users.get(s["name"], 0)} for s in found],
            "cfg": cfg,
            "homeRoot": sk.home_root(),          # Scan skills placed or cloned into this directory.
            "roots": sk.default_roots() + list(cfg.get("roots") or [])}


@router.put("/skills")
async def put_skills(body: dict = Body(default_factory=dict),
                     user: User = Depends(require_perm("task.dispatch")),
                     session: AsyncSession = Depends(get_session)):
    from ..services import skills as sk
    cfg = await sk.save_cfg(session, body.get("cfg") if isinstance(body.get("cfg"), dict) else body)
    await session.commit()
    # Audit the allowed key, which replaced cfg["enabled"] when the allowlist was introduced.
    # Reading the old key raises KeyError after saving the allowlist.
    # Keep auditing consistent with persistence so a successful commit is not reported as a failed request.
    await audit.log(session, user, "skills.update", "setting", sk.SETTING_KEY, "技能库开放清单",
                    {"allowed": cfg["allowed"], "byRepo": list(cfg["byRepo"])})
    return {"ok": True, "cfg": cfg}


# Legacy flow-template routes are retired: /flows, /flow-options, /flow-health, and /dispatch-rules.
# Plugins define workflows; plugin runs and delivery evidence expose gate health and approvals.







@router.get("/model-catalog", dependencies=[Depends(require_perm("integration.manage"))])
async def get_model_catalog(session: AsyncSession = Depends(get_session)):
    from ..services import model_catalog
    return await model_catalog.catalog(session)


@router.put("/model-providers/{pid}")
async def put_model_provider(
    pid: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Update a provider; built-in providers may be disabled or reconfigured but not deleted. Empty
    apiKey preserves the stored key.
    """
    from ..models import ModelProvider
    from ..services import model_config_guard
    new_key = str(body.get("apiKey") or "").strip()
    if len(new_key) > 400:
        raise HTTPException(status_code=400, detail="模型服务密钥最多 400 个字符，原密钥未更改")
    p = await model_config_guard.catalog(session, ModelProvider, pid, body.get("expectedRevision"))
    if p is None:
        if len(pid) > 48:
            raise HTTPException(status_code=400, detail="模型服务标识最多 48 个字符，请缩短后再保存")
        p = ModelProvider(id=pid, builtin=False)
        session.add(p)
    if "name" in body:
        p.name = str(body.get("name") or "")[:64]
    if "kind" in body:
        p.kind = str(body.get("kind") or "openai-compat")[:24]
    if "baseUrl" in body:
        b = str(body.get("baseUrl") or "").strip()[:400]
        if b and not b.startswith(("http://", "https://")):
            raise HTTPException(status_code=400, detail="接口地址要以 http(s):// 开头")
        p.base_url = b
    if "enabled" in body:
        p.enabled = bool(body.get("enabled"))
    if "note" in body:
        p.note = str(body.get("note") or "")[:300]
    if new_key:
        p.api_key = new_key
    await session.commit()
    from ..services.client_domain_events import models_changed
    await models_changed(session)
    await audit.log(session, user, "model.provider", "setting", pid, p.name,
                    {"baseUrl": p.base_url, "enabled": p.enabled, "keyChanged": bool(new_key)})
    return {"ok": True, "keyChanged": bool(new_key)}


@router.delete("/model-providers/{pid}")
async def del_model_provider(
    pid: str,
    expectedRevision: str | None = None,
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    from sqlalchemy import delete as _del

    from ..models import ModelDef, ModelProvider
    from ..services import model_config_guard
    p = await model_config_guard.catalog(session, ModelProvider, pid, expectedRevision)
    if p is None:
        raise HTTPException(status_code=404, detail="没有这个模型服务")
    if p.builtin:
        raise HTTPException(status_code=400, detail="内置的服务不能删——不想用就停用它")
    await session.execute(_del(ModelDef).where(ModelDef.provider_id == pid))
    await session.delete(p)
    await session.commit()
    from ..services.client_domain_events import models_changed
    await models_changed(session)
    await audit.log(session, user, "model.provider.del", "setting", pid, p.name, {})
    return {"ok": True}


@router.put("/model-defs")
async def put_model_def(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Add a model or change its enabled state. Specify its provider and model ID; credentials
    belong to the provider.
    """
    from ..models import ModelDef, ModelProvider
    from ..services import model_catalog, model_config_guard
    pid = str(body.get("providerId") or "").strip()
    name = str(body.get("name") or "").strip()[:160]
    if not pid or not name:
        raise HTTPException(status_code=400, detail="要选一个模型服务、并填模型标识")
    mid = pid + ":" + name
    m = await model_config_guard.catalog(session, ModelDef, mid, body.get("expectedRevision"))
    # Existing SQLite catalogs may contain longer identifiers from older versions.
    # Keep those exact rows editable; never truncate or rename their identities.
    if m is None and len(mid) > 64:
        raise HTTPException(status_code=400, detail="模型服务标识加模型标识共超过 64 个字符，请缩短模型标识")
    if await session.get(ModelProvider, pid, populate_existing=True) is None:
        raise HTTPException(status_code=400, detail="这个模型服务不存在")
    if m is None:
        m = ModelDef(id=mid, provider_id=pid, name=name, builtin=False)
        session.add(m)
    if "label" in body:
        m.label = str(body.get("label") or "")[:80]
    if "enabled" in body:
        m.enabled = bool(body.get("enabled"))
    if "modality" in body:
        m.modality = model_catalog.normalize_modality(body.get("modality"))
    if "config" in body or "modality" in body:
        try:
            m.config = model_catalog.clean_model_config(
                body.get("config") if "config" in body else m.config,
                m.modality,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    if "note" in body:
        m.note = str(body.get("note") or "")[:300]
    try:
        from ..services.model_capabilities import validate_limits
        m.ctx_window = validate_limits(body.get("ctxWindow", m.ctx_window), m.config or {})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await session.commit()
    from ..services.client_domain_events import models_changed
    await models_changed(session)
    await audit.log(
        session, user, "model.def", "setting", mid, m.label or name,
        {"enabled": m.enabled, "modality": m.modality},
    )
    return {"ok": True, "id": mid}


@router.delete("/model-defs/{mid:path}")
async def del_model_def(
    mid: str,
    expectedRevision: str | None = None,
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    from ..models import ModelDef
    from ..services import model_config_guard
    m = await model_config_guard.catalog(session, ModelDef, mid, expectedRevision)
    if m is None:
        raise HTTPException(status_code=404, detail="没有这个模型")
    if m.builtin:
        raise HTTPException(status_code=400, detail="内置模型不能删——不想开放就停用它")
    await session.delete(m)
    await session.commit()
    from ..services.client_domain_events import models_changed
    await models_changed(session)
    await audit.log(session, user, "model.def.del", "setting", mid, m.label or m.name, {})
    return {"ok": True}


# Subordinate task assignment and visibility.

async def _user_box_ids(session: AsyncSession, uid: str) -> list[str]:
    res = await session.execute(select(Client.id).where(Client.user_ref == uid))
    return [r[0] for r in res.all()]


@router.get("/subordinates")
async def subordinates(user: User = Depends(require_perm("task.view")), session: AsyncSession = Depends(get_session)):
    """List other users in the caller's scope with client availability and task summaries.
    Superusers see all users.
    """
    scope = await rbac.scope_org_ids(session, user)
    uq = select(User)
    if scope is not None:
        uq = uq.where(User.org_id.in_(scope or {"__none__"}))
    users = [u for u in (await session.execute(uq)).scalars().all() if u.id != user.id]
    clients = (await session.execute(select(Client))).scalars().all()
    boxes_by_user: dict[str, list] = {}
    for c in clients:
        if c.user_ref:
            boxes_by_user.setdefault(c.user_ref, []).append(c)
    tasks = (await session.execute(select(Task))).scalars().all()
    tasks_by_client: dict[str, list] = {}
    for t in tasks:
        tasks_by_client.setdefault(t.owner_client_id, []).append(t)
    out = []
    for u in users:
        boxes = boxes_by_user.get(u.id, [])
        allt = [t for b in boxes for t in tasks_by_client.get(b.id, [])]
        d = rbac.user_to_api(u)
        d["boxCount"] = len(boxes)
        d["online"] = any(client_to_api(b, settings.offline_after_seconds)["online"] for b in boxes)
        d["taskOpen"] = sum(1 for t in allt if t.status in ("todo", "doing"))
        d["taskTotal"] = len(allt)
        out.append(d)
    return out


@router.get("/users/{uid}/tasks")
async def subordinate_tasks(
    uid: str, user: User = Depends(require_perm("task.view")), session: AsyncSession = Depends(get_session)
):
    """Combine tasks from all clients belonging to the specified subordinate."""
    target = await session.get(User, uid)
    if target is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    await _assert_user_in_scope(session, user, target)
    boxes = await _user_box_ids(session, uid)
    if not boxes:
        return []
    res = await session.execute(
        select(Task).where(Task.owner_client_id.in_(boxes)).order_by(Task.created_at.desc())
    )
    from ..services import task_requirement_projection
    rows = list(res.scalars().all())
    return await task_requirement_projection.decorate_many(session, rows, [task_to_api(t) for t in rows])


@router.post("/users/{uid}/tasks")
async def create_subordinate_task(
    uid: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    """Dispatch a task to the subordinate's client with origin=dispatch and a live notification."""
    target = await session.get(User, uid)
    if target is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    await _assert_user_in_scope(session, user, target)
    if not (body.get("title") or "").strip():
        raise HTTPException(status_code=400, detail="请填需求标题")
    boxes = await _user_box_ids(session, uid)
    if not boxes:
        raise HTTPException(status_code=400, detail="该下属还没有绑定 SoduWork，无法派需求")
    # Legacy assignment/acceptance templates are retired. Direct assignments use ordinary tasks.
    # The creator becomes the requester through create_task.default_requester and receives completion receipts.
    # Inbox rejection requests rework; mandatory acceptance gates require a plugin workflow.
    leader_name = user.display_name or user.username
    data = {
        "title": body.get("title"),
        "note": body.get("note") or "",
        "status": "todo",
        "urgent": body.get("urgent"),
        "important": body.get("important"),
        "handler": body.get("handler") or "me",
        "priority": body.get("priority") or "normal",
        "due": body.get("due"),
        "tags": body.get("tags") or [],
        "domainId": body.get("domainId") or "",
        "assigneeUserId": uid,   # Assign to the specified subordinate.
        "source": "领导指派 · " + leader_name,
    }
    creator = (user.id, leader_name)
    created = [await svc.create_task(session, bid, data, origin="dispatch", creator=creator) for bid in boxes]
    await audit.log(session, user, "task.dispatch.sub", "user", uid, target.display_name or target.username,
                    {"title": data["title"], "boxes": len(boxes)})
    return {"created": len(created), "tasks": created}


@router.get("/inbox")
async def list_inbox(
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    """List unclaimed, ownerless tasks in the administrator's visible team inboxes."""
    scope = await rbac.scope_org_ids(session, user)
    return await inbox_svc.list_for_orgs(session, scope)


@router.post("/inbox")
async def create_inbox_task(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    """Dispatch to a scoped department's inbox for later member claiming."""
    org_id = body.get("orgId") or user.org_id
    if not (body.get("title") or "").strip():
        raise HTTPException(status_code=400, detail="请填需求标题")
    if not org_id:
        raise HTTPException(status_code=400, detail="请选择目标团队/部门")
    await _assert_org_in_scope(session, user, org_id)
    payload = {
        "title": body.get("title"), "note": body.get("note") or "",
        "priority": body.get("priority") or "normal", "due": body.get("due"),
        "tags": body.get("tags") or [], "urgent": body.get("urgent"), "important": body.get("important"),
        "domainId": body.get("domainId") or "", "source": "平台派团队 · " + (user.display_name or user.username),
    }
    r = await inbox_svc.create_pool_task(session, org_id, payload, creator=(user.id, user.display_name or user.username))
    await audit.log(session, user, "task.inbox", "task", (r.get("task") or {}).get("id"), payload["title"], {"orgId": org_id})
    return r


@router.post("/inbox/{tid}/assign")
async def assign_inbox_task(
    tid: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    """Assign a visible inbox task to an employee in the caller's management scope and notify the
    employee's client.
    """
    uid = (body.get("userId") or "").strip()
    target = await session.get(User, uid) if uid else None
    if target is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    await _assert_user_in_scope(session, user, target)
    scope = await inbox_svc.scope_for_user(session, user)
    r = await inbox_svc.assign_to_user(session, tid, target, scope,
                                       actor_name=user.display_name or user.username, actor_id=user.id)
    if not r.get("ok"):
        code = {"already_claimed": 409, "not_found": 404}.get(r.get("reason"), 400)
        msg = {"not_found": "需求不存在", "already_claimed": "该需求已被认领或已派走",
               "not_in_inbox": "该需求不在收件箱里", "out_of_scope": "该需求不在你的收件箱范围内",
               "no_box": "该员工还没有绑定 SoduWork，无法分配"}.get(r.get("reason"), "分配失败")
        raise HTTPException(status_code=code, detail=msg)
    await audit.log(session, user, "task.assign", "task", tid, (r.get("task") or {}).get("title", ""),
                    {"toUserId": target.id, "toUser": target.display_name or target.username})
    return r


# Administrative inbox views; employees use desktop inbox, report, and board views.

@router.get("/me/inbox")
async def my_inbox(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    """List claimable team tasks; include assignable members when the caller has dispatch
    permission.
    """
    data = await inbox_svc.list_for_user(session, user)
    data["hasBox"] = (await inbox_svc.pick_box(session, user.id)) is not None
    data["canAssign"] = has_perm(user, "task.dispatch")
    if data["canAssign"]:
        scope = await rbac.scope_org_ids(session, user)
        uq = select(User).where(User.is_active.is_(True))
        if scope is not None:
            uq = uq.where(User.org_id.in_(scope or {"__none__"}))
        boxed = {c.user_ref for c in (await session.execute(
            select(Client).where(Client.user_ref.isnot(None))
        )).scalars().all()}
        data["members"] = [{"id": u.id, "name": u.display_name or u.username, "hasBox": u.id in boxed}
                           for u in (await session.execute(uq)).scalars().all()]
    return data


@router.post("/me/inbox/{tid}/claim")
async def claim_my_inbox_task(
    tid: str, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
):
    """Claim an inbox task for the current client, matching the desktop claim action."""
    r = await inbox_svc.claim_for_user(session, user, tid)
    if not r.get("ok"):
        code = {"already_claimed": 409, "not_found": 404}.get(r.get("reason"), 400)
        msg = {"unassigned": "你还未归属组织，无团队收件箱", "not_found": "需求不存在",
               "already_claimed": "该需求已被别人认领", "out_of_scope": "该需求不在你的团队收件箱内",
               "no_box": "你还没有绑定 SoduWork，请让管理员把 SoduWork 分配给你"}.get(r.get("reason"), "认领失败")
        raise HTTPException(status_code=code, detail=msg)
    return r


@router.post("/dispatch")
async def dispatch(
    body: DispatchCreate,
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    """Create one dispatched task per target client, restricted to the caller's scope, and notify
    clients immediately.
    """
    if not body.targets:
        raise HTTPException(status_code=400, detail="请至少选择一个目标 SoduWork")
    vis = await _visible_client_ids(session, user)
    data = body.model_dump(exclude={"targets"})
    data["source"] = "平台下发"
    creator = (user.id, user.display_name or user.username)
    created, skipped = [], []
    for cid in body.targets:
        if await session.get(Client, cid) is None or (vis is not None and cid not in vis):
            skipped.append(cid)
            continue
        created.append(await svc.create_task(session, cid, data, origin="dispatch", creator=creator))
    await audit.log(session, user, "task.dispatch", "task", None, data.get("title", ""),
                    {"dispatched": len(created), "targets": len(body.targets)})
    return {"dispatched": len(created), "skipped": skipped, "tasks": created}


# LLM settings for report generation; credentials are write-only.

_LLM_KEYS = ("llm_base_url", "llm_model", "llm_api_key", "llm_models")


def _llm_models(raw: str) -> list:
    """Parse the JSON model list; malformed settings fall back to an empty list so configuration
    remains accessible.
    """
    import json as _json
    try:
        v = _json.loads(raw or "[]")
    except Exception:  # noqa: BLE001
        return []
    return [str(x).strip() for x in v if str(x).strip()] if isinstance(v, list) else []


@router.get("/team-module-scope", dependencies=[Depends(require_perm("org.manage"))])
async def get_team_module_scope(session: AsyncSession = Depends(get_session)):
    """Control team-view visibility: managers by default, or everyone."""
    from ..services import team as team_svc
    return {"scope": await team_svc.team_module_scope(session)}


@router.put("/team-module-scope")
async def put_team_module_scope(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("org.manage")),
    session: AsyncSession = Depends(get_session),
):
    from ..services import team as team_svc
    scope = await team_svc.set_team_module_scope(session, str(body.get("scope") or ""))
    await audit.log(session, user, "team.module_scope", "setting", None,
                    "团队模块可见范围", {"scope": scope})
    return {"ok": True, "scope": scope}


@router.get("/alert-config", dependencies=[Depends(require_perm("integration.manage"))])
async def get_alert_config(session: AsyncSession = Depends(get_session)):
    """Configure delivery alert channels; an empty configuration keeps alerts in the application."""
    from ..models import AppSetting
    from ..services import notify
    row = (await session.execute(select(AppSetting).where(
        AppSetting.key == notify.ALERT_URL_KEY))).scalars().first()
    return {"url": (row.value if row else "") or ""}


@router.put("/alert-config")
async def put_alert_config(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    from ..models import AppSetting
    from ..services import notify
    url = str(body.get("url") or "").strip()[:600]
    if url and not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=422, detail="告警地址要以 http:// 或 https:// 开头")
    row = (await session.execute(select(AppSetting).where(
        AppSetting.key == notify.ALERT_URL_KEY))).scalars().first()
    if row is None:
        session.add(AppSetting(key=notify.ALERT_URL_KEY, value=url))
    else:
        row.value = url
    await session.commit()
    # Webhook URLs permit message injection if leaked; audit only whether a URL is configured.
    await audit.log(session, user, "alert.config", "setting", None, "告警通道",
                    {"configured": bool(url)})
    return {"ok": True, "configured": bool(url)}


@router.post("/alert-config/test")
async def test_alert_config(
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Send a real test notification to the configured destination."""
    from ..services import notify
    sent = await notify.alert(
        session, "这是一条测试告警：配好了，交付出事时会用这个通道叫人。")
    return {"ok": bool(sent),
            "detail": "发出去了，去群里看看收到没" if sent
            else "没发出去：地址没配，或者这台后端连不上它"}


@router.get("/llm-config", dependencies=[Depends(require_perm("integration.manage"))])
async def get_llm_config(session: AsyncSession = Depends(get_session)):
    """Return redacted LLM settings with key presence and length, never the plaintext key."""
    from ..services import model_config_guard
    cfg = await model_config_guard.setting_values(session, _LLM_KEYS)
    key = cfg.get("llm_api_key", "")
    return {"baseUrl": cfg.get("llm_base_url", ""), "model": cfg.get("llm_model", ""),
            # Expose the model choices available to workflow stages.
            "models": _llm_models(cfg.get("llm_models", "")),
            "keySet": bool(key), "keyLen": len(key), "revision": model_config_guard.fingerprint(cfg)}


@router.put("/llm-config")
async def put_llm_config(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Update LLM settings; omitted or empty apiKey preserves the existing credential."""
    import json as _json

    from ..models import AppSetting
    from ..services import llm, model_config_guard
    await model_config_guard.defaults(session, _LLM_KEYS, body.get("expectedRevision"))
    updates = {"llm_base_url": (body.get("baseUrl") or "").strip(),
               "llm_model": (body.get("model") or "").strip()}
    # Change candidate models only when supplied, preserving compatibility with older callers.
    if isinstance(body.get("models"), list):
        names, seen = [], set()
        for x in body["models"][:40]:
            s = str(x).strip()[:120]
            if s and s not in seen:
                seen.add(s)
                names.append(s)
        updates["llm_models"] = _json.dumps(names, ensure_ascii=False)
    new_key = (body.get("apiKey") or "").strip()
    if new_key:
        updates["llm_api_key"] = new_key
    for k, v in updates.items():
        row = (await session.execute(select(AppSetting).where(AppSetting.key == k))).scalars().first()
        if row is None:
            session.add(AppSetting(key=k, value=v))
        else:
            row.value = v
    await session.commit()
    await llm.load(session, force=True)          # Refresh the process cache immediately without requiring a restart.
    await audit.log(session, user, "llm.config", "setting", None, "LLM 配置",
                    {"baseUrl": updates["llm_base_url"], "model": updates["llm_model"],
                     "keyChanged": bool(new_key)})       # Audit whether the credential changed, never its value.
    return {"ok": True, "keyChanged": bool(new_key)}




@router.get("/ai-agents")
async def list_ai_assignees(
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    """List dispatchable agents and squads with CLI types. Squad leaders select internal assignees;
    SoduWork does not duplicate that routing.
    """
    import asyncio as _aio

    from ..services import ai_exec, model_catalog
    ctx = await ai_exec.load(session, force=True)
    visible = await _visible_client_ids(session, user)
    if visible is not None:
        ctx["_runnerAllowedClients"] = sorted(visible)
        managed = await rbac.scope_org_ids(session, user)
        inherited = await rbac.ancestor_org_ids(session, str(user.org_id or ""))
        ctx["_runnerAllowedOrgs"] = sorted(set(managed or set()) | inherited)
    # Use a recognizable machine/owner label rather than an opaque hostname alone.
    ctx["_clientNames"] = {c.id: (c.name or "") for c in list((await session.execute(
        select(Client))).scalars().all()) if c.name}
    r = await _aio.to_thread(ai_exec.list_assignees_sync, ctx)
    r["provider"] = ai_exec.provider_name(ctx)
    r["default"] = ai_exec.default_assignee(ctx)
    # Workflow stages select an agent type and model, not a machine-specific instance.
    r["kinds"] = ai_exec.agent_kinds()
    legacy_models = ai_exec.model_choices(ctx)
    mc = await model_catalog.choices(
        session, None, str(legacy_models.get("default") or ""))
    r["defaultModel"] = mc["default"]
    r["models"] = mc["list"]
    r["modelOptions"] = mc["items"]
    if not r["agents"] and not r["squads"]:
        r["reason"] = ("尚未配置托管底座，也没有检测到本机 CLI 或在线 Runner"
                       if not ai_exec.available(ctx) else "当前没有可安排执行的 AI 或小队")
    return r


@router.post("/tasks/{tid}/ai-dispatch")
async def admin_ai_dispatch_task(
    tid: str,
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    """Authorize admin scope; execute with the owner's environment and admin audit."""
    from ..services.task_dispatch import dispatch
    task = await _assert_task_in_scope(session, user, tid)
    owner = await session.get(Client, task.owner_client_id) if task.owner_client_id else None
    if owner is None or owner.auth_state != "active":
        raise HTTPException(409, "需求负责人尚未绑定可用设备，请先完成设备连接")
    return await dispatch(tid, {}, owner, session, actor=user)


@router.get("/tasks/{tid}/ai-status")
async def admin_ai_status_task(
    tid: str,
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    """Read the latest dispatched execution's state and import available outputs."""
    import asyncio as _aio

    from ..services import ai_exec
    await _assert_task_in_scope(session, user, tid)
    ev = await ai_exec.last_dispatch_event(session, tid)   # Recognize historical multica.* events as well.
    if ev is None:
        return {"dispatched": False}
    d = ev.detail or {}
    ctx = await ai_exec.load(session)
    s = await _aio.to_thread(ai_exec.status_sync, ctx, d.get("ref") or d.get("issueId", ""))
    # Import available outputs idempotently: avoid duplicate attachments and unchanged URL events.
    # Check output existence directly; running status is not a reliable prerequisite.
    if s.get("ok") and (s.get("attachments") or s.get("artifactUrl")):
        s["pulled"] = await ai_exec.pull_artifacts(session, tid, ctx, s, d.get("ref") or d.get("issueId", ""))
    return {"dispatched": True, "identifier": d.get("identifier", ""), "url": d.get("url", ""), **s}


# Integrations, bindings, and unassigned records.

@router.get("/integrations", dependencies=[Depends(require_perm("integration.manage"))])
async def list_integrations(session: AsyncSession = Depends(get_session)):
    return await agg.list_integrations(session)


@router.post("/integrations")
async def create_integration(body: IntegrationCreate,
                             user: User = Depends(require_perm("integration.manage")),
                             session: AsyncSession = Depends(get_session)):
    from ..services import scm_support
    if str(body.type or "").strip().lower() == "gerrit":
        raise HTTPException(status_code=400, detail=scm_support.GERRIT_RETIRED)
    result = await agg.create_integration(session, body.name, body.type, body.config)
    await audit.log(session, user, "integration.create", "integration",
                    result.get("id"), result.get("name", ""),
                    {"type": result.get("type", "")})
    return result


@router.patch("/integrations/{iid}")
async def update_integration(iid: str, body: IntegrationUpdate,
                             user: User = Depends(require_perm("integration.manage")),
                             session: AsyncSession = Depends(get_session)):
    """Change enabled state and merge integration configuration such as GitLab base_url and
    project.
    """
    from ..services import scm_support
    try:
        r = await agg.update_integration(session, iid, enabled=body.enabled, config=body.config)
    except scm_support.RetiredScmError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if r is None:
        raise HTTPException(status_code=404, detail="集成不存在")
    detail = {"configKeys": sorted(str(key) for key in (body.config or {}).keys())}
    if body.enabled is not None:
        detail["enabled"] = bool(body.enabled)
    await audit.log(session, user, "integration.update", "integration", iid,
                    r.get("name", ""), detail)
    return r


@router.post("/integrations/{iid}/token/rotate")
async def rotate_integration_token(iid: str,
                                   user: User = Depends(require_perm("integration.manage")),
                                   session: AsyncSession = Depends(get_session)):
    """Rotate the access token; reveal plaintext only in this response, never in subsequent reads.

    """
    result = await agg.rotate_integration_token(session, iid)
    if result is None:
        raise HTTPException(status_code=404, detail="集成不存在")
    await audit.log(session, user, "integration.token.rotate", "integration", iid,
                    result.get("name", ""), {"ingestTokenSet": True})
    return result


@router.post("/integrations/{iid}/pull")
async def pull_integration_now(iid: str,
                               user: User = Depends(require_perm("integration.manage")),
                               session: AsyncSession = Depends(get_session)):
    """Run connector.pull immediately and persist the imported records."""
    r = await poller.pull_integration(session, iid)
    if not r.get("ok"):
        reason = r.get("reason", "拉取失败")
        detail = r.get("error") or {
            "not_found": "集成不存在", "disabled": "集成已停用", "no_connector": "该类型不支持拉取",
        }.get(reason, reason)
        raise HTTPException(status_code=404 if reason == "not_found" else 400, detail=detail)
    await audit.log(session, user, "integration.pull", "integration", iid,
                    str(r.get("name") or ""), {"trigger": "manual"})
    return r


@router.delete("/integrations/{iid}")
async def delete_integration(iid: str, user: User = Depends(require_perm("integration.manage")),
                             session: AsyncSession = Depends(get_session)):
    """Delete an integration and its bindings while preserving previously imported tasks."""
    from ..models import Integration, IntegrationBinding
    integ = await session.get(Integration, iid)
    if integ is None:
        raise HTTPException(status_code=404, detail="集成不存在")
    from sqlalchemy import delete as sqldelete
    iname = integ.name
    await session.execute(sqldelete(IntegrationBinding).where(IntegrationBinding.integration_id == iid))
    await session.delete(integ)
    await session.commit()
    await audit.log(session, user, "integration.delete", "integration", iid, iname, {})
    return {"ok": True}


# Audit log.

@router.get("/audit")
async def list_audit(
    action: str | None = None, limit: int = 50, offset: int = 0,
    user: User = Depends(require_perm("audit.view")),
    session: AsyncSession = Depends(get_session),
):
    """List audit events for actors in the department subtree; superusers see all events."""
    return await audit.list_audit(session, user, action=action, limit=min(limit, 200), offset=max(offset, 0))


@router.get("/receipts")
async def list_receipts(
    limit: int = 50, offset: int = 0,
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    """List completion receipts from TaskEvent(kind='receipt'), scoped by visible task clients, to
    trace requests through resolution.
    """
    from ..schemas import _ms
    vis = await _visible_client_ids(session, user)   # None leaves superusers unrestricted.
    rows = (await session.execute(
        select(TaskEvent).where(TaskEvent.kind == "receipt").order_by(TaskEvent.at.desc())
    )).scalars().all()
    # Scope linked tasks and include their titles, owning devices, and completion times.
    tmap = {}
    tids = list({e.task_id for e in rows})
    if tids:
        tres = (await session.execute(select(Task).where(Task.id.in_(tids)))).scalars().all()
        tmap = {t.id: t for t in tres}
    out = []
    for e in rows:
        t = tmap.get(e.task_id)
        if vis is not None and (t is None or t.owner_client_id not in vis):
            continue  # Outside the visible scope.
        d = e.detail or {}
        out.append({
            "id": e.id,
            "taskId": e.task_id,
            "title": d.get("title") or (t.title if t else ""),
            "requesterName": d.get("to") or "",
            "contact": d.get("contact") or "",
            "external": bool(d.get("external")),
            "via": d.get("via") or "",           # box: notify requester; self: self-completion; relay: notify registrar; recorded: retain only.
            "status": (t.status if t else ""),
            "at": _ms(e.at),
        })
    return out[offset:offset + min(limit, 200)]


@router.get("/bindings")
async def list_bindings(user: User = Depends(require_perm("binding.manage")),
                        session: AsyncSession = Depends(get_session)):
    rows = await agg.list_bindings(session)
    visible = await _visible_client_ids(session, user)
    if visible is None:
        return rows
    return [row for row in rows if row.get("clientId") in visible]


@router.post("/bindings")
async def create_binding(body: BindingCreate,
                         user: User = Depends(require_perm("binding.manage")),
                         session: AsyncSession = Depends(get_session)):
    client = await session.get(Client, body.client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="SoduWork 不存在")
    await _assert_client_in_scope(session, user, client)
    result = await agg.create_binding(
        session, body.integration_id, body.external_actor, body.client_id)
    await audit.log(session, user, "binding.upsert", "integration_binding",
                    result.get("id"), body.external_actor,
                    {"integrationId": body.integration_id,
                     "clientId": body.client_id})
    return result


@router.delete("/bindings/{bid}")
async def delete_binding(bid: str,
                         user: User = Depends(require_perm("binding.manage")),
                         session: AsyncSession = Depends(get_session)):
    binding = await session.get(models.IntegrationBinding, bid)
    if binding is not None:
        client = await session.get(Client, binding.client_id)
        if client is not None:
            await _assert_client_in_scope(session, user, client)
    result = await agg.delete_binding(session, bid)
    if result.get("ok"):
        await audit.log(session, user, "binding.delete", "integration_binding",
                        bid, binding.external_actor if binding else "",
                        {"integrationId": binding.integration_id if binding else "",
                         "clientId": binding.client_id if binding else ""})
    return result


@router.get("/unassigned")
async def list_unassigned(user: User = Depends(require_perm("binding.manage")),
                          session: AsyncSession = Depends(get_session)):
    rows = await agg.list_unassigned(session)
    scope = await rbac.scope_org_ids(session, user)
    if scope is None:
        return rows
    return [row for row in rows if not row.get("poolOrgId")
            or row.get("poolOrgId") in scope]


@router.post("/unassigned/{task_id}/assign")
async def assign_unassigned(task_id: str, body: AssignBody,
                            user: User = Depends(require_perm("binding.manage")),
                            session: AsyncSession = Depends(get_session)):
    client = await session.get(Client, body.client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="SoduWork 不存在")
    await _assert_client_in_scope(session, user, client)
    task = await session.get(Task, task_id)
    if task is not None and task.pool_org_id:
        await _assert_org_in_scope(session, user, task.pool_org_id)
    r = await agg.assign_task(session, task_id, body.client_id, body.create_binding)
    if not r["ok"]:
        raise HTTPException(status_code=404, detail="需求不存在")
    assigned = r.get("task") or {}
    await audit.log(session, user, "task.assign", "task", task_id,
                    assigned.get("title", ""),
                    {"clientId": body.client_id,
                     "createBinding": bool(body.create_binding)})
    return r


# Remote client management over WebSocket.

@router.get("/clients/{cid}")
async def client_detail(
    cid: str,
    user: User = Depends(require_perm("client.view")),
    session: AsyncSession = Depends(get_session),
):
    c = await session.get(Client, cid)
    if c is None:
        raise HTTPException(status_code=404, detail="客户端不存在")
    await _assert_client_in_scope(session, user, c)
    total = await session.scalar(select(func.count()).select_from(Task).where(Task.owner_client_id == cid))
    open_ = await session.scalar(
        select(func.count()).select_from(Task).where(Task.owner_client_id == cid, Task.status.in_(["todo", "doing"]))
    )
    d = client_to_api(c, settings.offline_after_seconds)
    d["config"] = c.config or {}
    d["taskTotal"] = int(total or 0)
    d["taskOpen"] = int(open_ or 0)
    d["connected"] = hub.is_online(cid)
    return d


@router.post("/clients/{cid}/push")
async def client_push(
    cid: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("client.control")),
    session: AsyncSession = Depends(get_session),
):
    """Send config.patch, notice, or command messages; persist configuration patches and report
    online delivery.
    """
    c = await session.get(Client, cid)
    if c is None:
        raise HTTPException(status_code=404, detail="客户端不存在")
    await _assert_client_in_scope(session, user, c)
    typ = body.get("type")
    # Hot-update dispatch additionally requires client.update.
    if typ == "command" and body.get("action") == "apply-update" and "client.update" not in getattr(user, "_perms", set()):
        raise HTTPException(status_code=403, detail="无推送热更新权限")
    if typ == "config.patch":
        patch = body.get("patch") or {}
        c.config = {**(c.config or {}), **patch}
        await session.commit()
        from ..services.client_domain_events import device_changed
        await device_changed(c, "config")
        if "modelProviders" in patch:
            await device_changed(c, "models")
        await hub.publish(cid, {"type": "config.patch", "patch": patch})
    elif typ == "notice":
        await hub.publish(cid, {"type": "notice", "text": body.get("text") or ""})
    elif typ == "command":
        await hub.publish(cid, {"type": "command", "action": body.get("action"), "payload": body.get("payload")})
    else:
        raise HTTPException(status_code=400, detail="不支持的 type（config.patch|notice|command）")
    delivered = hub.is_online(cid)
    detail = {"type": str(typ or "")}
    if typ == "command":
        detail["action"] = str(body.get("action") or "")[:80]
    await audit.log(session, user, "client.push", "client", cid,
                    c.name or cid, detail)
    return {"ok": True, "delivered": delivered}
