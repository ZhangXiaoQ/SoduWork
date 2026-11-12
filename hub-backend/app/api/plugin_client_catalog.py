"""Employee plugin catalog, conversation grants and personal publication APIs."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, File, HTTPException, UploadFile, Request, Response
from starlette.concurrency import run_in_threadpool
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from ..auth import verify_claims
from ..db import get_session
from ..deps import current_client
from ..models import Client, OrgUnit, User
from ..services import (audit, device_auth, mcp_servers, plugin_audience,
                        plugin_access, plugin_conversation, plugin_drafts, plugin_installations,
                        plugin_marketplace, plugin_mcp_gateway, plugin_mcp_limits, plugin_packages,
                        plugin_service, plugin_setup_contracts, plugin_builtin,
                        plugin_signatures, rbac, plugin_application_mcp)

router = APIRouter(prefix="/api/v1", tags=["plugins"])


def _external_mcp_names(names) -> list[str]:
    """Return connector names that require administrator/client setup.

    SoduWork-owned MCP capabilities use the same signed grant as connectors, but
    they are resolved by the Hub and must never be looked up in the external
    MCP registry.  Keep this boundary in one place for both remote plugin
    declarations and personal connection requests.
    """
    return sorted({
        str(name or "").strip()
        for name in (names or [])
        if str(name or "").strip() and not plugin_builtin.is_virtual_mcp(name)
    })


async def _client_actor(session: AsyncSession, client: Client):
    """Resolve an account-bound device to an organizational plugin submitter."""
    from types import SimpleNamespace

    user = await session.get(User, str(client.user_ref or "")) if client.user_ref else None
    if user is None or not user.is_active or not user.org_id:
        raise HTTPException(status_code=403, detail="当前 SoduWork 尚未绑定企业账号和组织，不能提交企业插件")
    return SimpleNamespace(
        id=user.id, user_id=user.id, client_id=client.id,
        display_name=user.display_name or user.username,
        username=user.username, org_id=user.org_id, is_super=bool(user.is_super),
        is_active=bool(user.is_active),
    )


async def _cloud_data_ready(item):
    """Read-only storage admission for the exact catalog version being installed."""
    if (item.get('jiyong') or {}).get('storage', {}).get('location') != 'cloud':
        return
    from ..services import jiyong_cloud_database
    try:
        await jiyong_cloud_database.check()
    except jiyong_cloud_database.CloudError as exc:
        raise HTTPException(exc.status, {'code': exc.code, 'message': str(exc)}) from exc


async def _client_plugin_bytes(file: UploadFile) -> bytes:
    data = await file.read(10 * 1024 * 1024 + 1)
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="插件包不能超过 10MB")
    return data


async def _catalog_item(session: AsyncSession, actor, plugin_id: str) -> dict:
    visible_orgs = await rbac.company_org_ids(session, actor)
    client = await session.get(Client, actor.client_id)
    snapshot = await plugin_service.client_catalog(
        session, actor.org_id, "", actor.user_id,
        visible_org_ids=visible_orgs, client=client)
    item = next((
        row for row in snapshot.get("items") or []
        if str(row.get("pluginId") or "") == str(plugin_id)
    ), None)
    if item is None:
        raise HTTPException(
            status_code=404,
            detail="插件不存在或没有授权给当前用户")
    if dict(item.get("permissions") or {}).get("canUse") is False:
        raise HTTPException(403, "你没有这个插件的使用权限，或权限已被管理员收回")
    return item


@router.get("/plugins/catalog")
async def client_plugin_catalog(
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    actor = await _client_actor(session, client)
    visible_orgs = await rbac.company_org_ids(session, actor)
    return await plugin_service.client_catalog(
        session, actor.org_id, actor.id, actor.user_id,
        visible_org_ids=visible_orgs, client=client)


@router.get("/plugins/recommendations")
async def client_plugin_recommendations(
    surface: str = "compose",
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Thin application placement list for compose or the main sidebar.

    Returns rows only; the client derives display material by joining the
    catalog it already fetched. Starting a plugin re-checks permissions hard,
    so this read needs no catalog assembly.
    """
    actor = await _client_actor(session, client)
    if surface not in plugin_marketplace.RECOMMENDATION_SURFACES:
        raise HTTPException(status_code=422, detail="未知的推荐位置")
    visible_orgs = await rbac.company_org_ids(session, actor)
    items = await plugin_marketplace.active_recommendations(
        session, visible_orgs, surface)
    return {"items": items}


@router.put("/plugins/{plugin_id}/installation")
async def set_client_plugin_installation(
    plugin_id: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Install, upgrade or remove one visible enterprise plugin for this employee."""
    actor = await _client_actor(session, client)
    item = await _catalog_item(session, actor, plugin_id)

    before = (await plugin_installations.by_plugin(
        session, actor.user_id, [plugin_id])).get(plugin_id)
    enabled = body.get("enabled", True)
    if not isinstance(enabled, bool):
        raise HTTPException(status_code=422, detail="enabled 必须是布尔值")

    expected_version_id = str(body.get("expectedVersionId") or "").strip()
    if enabled and expected_version_id != str(item.get("versionId") or ""):
        raise HTTPException(
            status_code=409,
            detail=("插件目录已经变化，请刷新后重新查看版本与权限，再确认安装"
                    if expected_version_id else
                    "安装前必须确认当前不可变版本，请刷新插件目录后重试"))
    policy = dict(item.get("marketPolicy") or {})
    if enabled and policy.get("installation") == plugin_marketplace.NOT_AVAILABLE:
        raise HTTPException(
            status_code=409,
            detail="该插件仅供受控需求和自动化使用，不开放个人对话安装")
    missing_mcp = list(dict(
        item.get("dependencyReadiness") or {}).get("missingMcp") or [])
    if (enabled and policy.get("authentication") == plugin_marketplace.ON_INSTALL
            and missing_mcp):
        raise HTTPException(status_code=409, detail="安装前需要管理员先配置企业连接：" +
                            "、".join(missing_mcp))

    if enabled:
        await _cloud_data_ready(item)
        candidate = (
            body.get("config") if "config" in body else
            dict(getattr(before, "config", None) or {}))
        try:
            config = plugin_setup_contracts.validate(
                item.get("setup"), candidate, require_required=True)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        required_mcp = list(dict(
            item.get("dependencyReadiness") or {}).get("requiredMcp") or [])
        verified = not required_mcp
        if policy.get("authentication") == plugin_marketplace.ON_INSTALL:
            probe = await mcp_servers.probe_requirements(
                session, required_mcp, client=client)
            if not probe.get("ok"):
                failed = [
                    f"{row.get('name')}：{row.get('error')}"
                    for row in probe.get("connections") or []
                    if not row.get("ok")]
                raise HTTPException(
                    status_code=409,
                    detail="连接测试没有通过；" +
                    "；".join(failed[:5]))
            verified = True
        action = (
            "plugin.upgrade" if before and before.enabled
            and before.version_id != item["versionId"] else
            "plugin.enable" if before else "plugin.install")
        await plugin_installations.install_current(
            session, actor.user_id, plugin_id, item["versionId"],
            setup=item.get("setup"), config=config, verified=verified)
    else:
        action = "plugin.uninstall"
        await plugin_installations.uninstall(session, actor.user_id, plugin_id)

    state = (await plugin_installations.catalog_states(
        session, actor.user_id, {
            plugin_id: (item["versionId"], item["version"])
        }))[plugin_id]
    await audit.log(
        session, actor, action, "plugin", plugin_id, str(item.get("name") or ""),
        {"versionId": item["versionId"], "version": item["version"],
         "installed": state["installed"],
         "setupFields": sorted(
             str(key) for key in (
                 dict(getattr(before, "config", None) or {})
                 if not enabled else config).keys()),
         "setupState": state.get("setupState"),
         "catalogPolicy": policy})
    return {"ok": True, "pluginId": plugin_id, "installation": state}


@router.post("/plugins/{plugin_id}/installation/probe")
async def probe_client_plugin_installation(
    plugin_id: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Validate preferences and really list tools on every required MCP."""
    actor = await _client_actor(session, client)
    item = await _catalog_item(session, actor, plugin_id)
    expected = str(body.get("expectedVersionId") or "").strip()
    if expected != str(item.get("versionId") or ""):
        raise HTTPException(
            status_code=409,
            detail="插件目录已经变化，请刷新后重新测试")
    await _cloud_data_ready(item)
    try:
        config = plugin_setup_contracts.validate(
            item.get("setup"), body.get("config") or {},
            require_required=True)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    required_mcp = list(dict(
        item.get("dependencyReadiness") or {}).get("requiredMcp") or [])
    result = await mcp_servers.probe_requirements(
        session, required_mcp, client=client)
    await audit.log(
        session, actor, "plugin.installation_probe", "plugin",
        plugin_id, str(item.get("name") or ""),
        {
            "versionId": item.get("versionId"),
            "configFields": sorted(config),
            "connections": [{
                "name": row.get("name"),
                "ok": bool(row.get("ok")),
                "toolCount": int(row.get("toolCount") or 0),
            } for row in result.get("connections") or []],
        })
    return {
        "ok": bool(result.get("ok")),
        "message": (
            "设置与连接均已验证"
            if result.get("ok")
            else "有连接未通过测试"),
        "connections": result.get("connections") or [],
    }


@router.get("/plugins/{plugin_id}/ui-package")
async def client_plugin_ui_package(plugin_id: str, request: Request, response: Response,
    client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    from ..services import plugin_installed, plugin_package_resources
    actor = await _client_actor(session, client)
    try:
        selected = await plugin_installed.resolve(session, actor.org_id, actor.user_id,
                                                  [plugin_id], provision_defaults=False)
        version = selected[0][1]
        # Authorization always precedes a conditional response. The immutable
        # version, manifest and package file identity all participate in the tag.
        etag = plugin_package_resources.cache_tag(version)
        headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
        validators = [value.strip().removeprefix("W/") for value in request.headers.get("if-none-match", "").split(",")]
        if etag in validators or "*" in validators:
            return Response(status_code=304, headers=headers)
        value = await run_in_threadpool(plugin_package_resources.ui_for_version, version)
        if plugin_package_resources.cache_tag(version) != etag:
            raise ValueError("插件包在读取期间发生变化，请重试")
        response.headers.update(headers)
        return value
    except (ValueError, IndexError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/plugins/conversation-context")
async def client_plugin_conversation_context(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Resolve an approved plugin mention without exposing binding config or secrets."""
    actor = await _client_actor(session, client)
    try:
        result = await plugin_conversation.resolve(
            session, actor.org_id, body.get("pluginIds") or [],
            project_id=str(body.get("projectId") or "")[:36], user_id=actor.user_id, client=client)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    result.pop("_bindingIds", None)
    result.pop("_versionIds", None)
    items = list(result.get("items") or [])
    await audit.log(
        session, actor, "plugin.conversation_use", "plugin",
        str(items[0].get("pluginId") or "")[:64] if items else "",
        " | ".join(str(item.get("name") or "") for item in items)[:200],
        {"pluginIds": [item.get("pluginId") for item in items],
         "versions": [item.get("version") for item in items],
         "conversationId": str(body.get("conversationId") or "")[:120],
         "mode": "conversation-guidance"})
    return result


@router.post("/plugins/conversation-grant")
async def client_plugin_conversation_grant(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Resolve trusted turn context and issue a scoped MCP ticket for this turn.

    The response contains no upstream URL, header or SecretReference. The ticket
    can only reach MCP names declared by the resolved immutable plugin versions
    (plus explicitly requested personal connections already enabled by this
    client), and the Hub rechecks those facts on every call.
    """
    actor = await _client_actor(session, client)
    remote_ids = list(dict.fromkeys(
        str(value or "").strip() for value in (body.get("pluginIds") or [])
        if str(value or "").strip()))[:3]
    personal_names = list(dict.fromkeys(
        str(value or "").strip()[:128]
        for value in (body.get("personalMcpServers") or [])
        if str(value or "").strip()))[:20]
    try:
        result = ({"ok": True, "items": [], "_bindingIds": []}
                  if not remote_ids else await plugin_conversation.resolve(
                      session, actor.org_id, remote_ids,
                      project_id=str(body.get("projectId") or "")[:36],
                      user_id=actor.user_id, include_resources=True, client=client))
        binding_ids = list(result.pop("_bindingIds", []) or [])[:3]
        version_ids = list(result.pop("_versionIds", []) or [])[:3]
        items = list(result.get("items") or [])
        application_mcp = {}
        application_binding = body.get("applicationConnection")
        if application_binding is not None:
            if not isinstance(application_binding, dict):
                raise ValueError("应用连接绑定格式无效")
            version_id = application_binding.get("versionId")
            if not isinstance(version_id, str) or version_id not in version_ids:
                raise ValueError("应用连接不属于本轮已安装版本")
            version = await session.get(am.PluginVersion, version_id)
            if version is None:
                raise ValueError("应用安装版本已失效")
            server = plugin_application_mcp.validate(application_binding, version)
            application_mcp[version_id] = [server]
        if body.get("resourceProtocol") != 1 and any(
                dict(item.get("resourceBundle") or {}).get("resources") for item in items):
            raise ValueError("这个插件需要完整文件支持，请先更新 SoduWork 客户端后重试；本轮尚未执行")
        remote_names = sorted({
            str(name) for item in items
            for name in dict(item.get("capabilities") or {}).get("mcpServers") or []
            if str(name).strip() and str(name) not in application_mcp.get(item.get("versionId"), [])
        })
        # SoduWork-owned capabilities are carried in the signed grant, but they
        # are not administrator-managed connector rows.  Keep the dependency
        # check explicitly scoped to external MCP names so a built-in such as
        # ``soduwork-media`` can never be turned into a user binding requirement
        # when the readiness implementation changes.
        remote_real_names = _external_mcp_names(remote_names)
        if remote_real_names:
            readiness = await mcp_servers.readiness(session, remote_real_names, client=client)
            if not readiness.get("ok"):
                raise ValueError(
                    "插件需要但企业尚未启用的 MCP：" +
                    "、".join(readiness.get("missing") or []))
        if remote_names:
            if application_mcp:
                await plugin_mcp_gateway.validate_versions(
                    session, client, version_ids, application_mcp=application_mcp)
            else:
                await plugin_mcp_gateway.validate_versions(session, client, version_ids)
        personal_real_names = _external_mcp_names(personal_names)
        if personal_real_names:
            # This validates the requested names against the client's selected
            # company connections and its approved personal connections. It
            # deliberately returns no materialized file or credential.
            await mcp_servers.runtime_for_dispatch(
                session, personal_real_names, client=client, materialize=False)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    grant = None
    all_names = sorted(set(remote_names) | set(personal_names))
    if all_names:
        ticket, expires_in = device_auth.issue_plugin_mcp_ticket(
            client, binding_ids, personal_names,
            str(body.get("conversationId") or "")[:120],
            plugin_version_ids=version_ids,
            **({"application_mcp": application_mcp} if application_mcp else {}))
        claims = verify_claims(ticket, token_type="plugin-mcp") or {}
        grant = {
            "ticket": ticket,
            "expiresIn": expires_in,
            "servers": all_names,
            "limits": plugin_mcp_limits.public_policy(claims),
        }
    await audit.log(
        session, actor, "plugin.conversation_grant", "plugin",
        str(items[0].get("pluginId") or "")[:64] if items else "",
        " | ".join(str(item.get("name") or "") for item in items)[:200],
        {"pluginIds": [item.get("pluginId") for item in items],
         "versions": [item.get("version") for item in items],
         "personalMcpServers": personal_names,
         "mcpServers": all_names,
         "applicationMcpServers": application_mcp,
         "conversationId": str(body.get("conversationId") or "")[:120],
         "mode": "conversation-runtime"})
    return {"ok": True, "items": items, "mcpGrant": grant}


@router.post("/plugins/preflight")
async def client_preflight_plugin(
    file: UploadFile = File(...),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Identify Codex, Claude Code, or SoduWork packages without storing or executing them."""
    actor = await _client_actor(session, client)
    try:
        parsed = plugin_packages.parse(await _client_plugin_bytes(file))
        proof = await plugin_signatures.inspect(session, parsed, actor.org_id)
        plugin_signatures.assert_importable(proof)
        return plugin_packages.public_summary(parsed, proof)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/plugins/submissions")
async def client_submit_plugin(
    file: UploadFile = File(...),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Import immutable versions into organizational quarantine without granting enablement,
    binding, or execution rights.
    """
    actor = await _client_actor(session, client)
    try:
        out = await plugin_service.install(
            session, await _client_plugin_bytes(file), actor, actor.org_id,
            source_channel="client-package", source_name=file.filename or "")
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    plugin = out["plugin"]
    await audit.log(session, actor, "plugin.submit", "plugin", plugin["id"], plugin["name"],
                    {"created": out["created"], "filename": file.filename or "",
                     "state": "quarantined"})
    return {"ok": True, "created": out["created"], "plugin": plugin,
            "message": "插件已提交隔离区，管理员预检、模拟并发布后才会对团队生效"}


@router.get("/plugins/audience-candidates")
async def client_plugin_audience_candidates(
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Active members and teams in the submitter's organization subtree."""
    actor = await _client_actor(session, client)
    scope = await rbac.subtree_org_ids(session, actor.org_id)
    org_rows = list((await session.execute(select(OrgUnit).where(
        OrgUnit.id.in_(scope or {"__none__"})
    ).order_by(OrgUnit.sort, OrgUnit.created_at))).scalars().all())
    orgs = {row.id: row for row in org_rows}

    def org_path(org_id: str | None) -> str:
        names, seen, current = [], set(), str(org_id or "")
        while current and current not in seen:
            seen.add(current)
            row = orgs.get(current)
            if row is None:
                break
            names.append(str(row.name or "")[:64])
            current = str(row.parent_id or "")
        return " / ".join(reversed([name for name in names if name]))[:240]

    rows = list((await session.execute(select(User).where(
        User.org_id.in_(scope or {"__none__"}), User.is_active.is_(True)
    ).order_by(User.display_name, User.username))).scalars().all())
    return {"items": [{
        "id": row.id,
        "name": str(row.display_name or row.username)[:64],
        "username": str(row.username or "")[:64],
        "orgId": str(row.org_id or ""),
        "orgPath": org_path(row.org_id),
    } for row in rows[:500]], "orgUnits": [{
        "id": row.id,
        "name": str(row.name or "")[:64],
        "parentId": str(row.parent_id or ""),
        "path": org_path(row.id),
    } for row in sorted(org_rows, key=lambda item: (org_path(item.id), item.sort))[:500]]}


@router.post("/plugins/personal-publish")
async def client_publish_personal_plugin(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Upload an explicit personal snapshot into enterprise quarantine with a planned audience."""
    actor = await _client_actor(session, client)
    draft = body.get("draft") if isinstance(body.get("draft"), dict) else {}
    try:
        await plugin_access.assert_draft_edit(session, actor.user_id, actor.org_id, draft)
        visibility = plugin_audience.normalize(body.get("visibility"))
        signature = body.get("signature") if isinstance(body.get("signature"), dict) else None
        publisher = (body.get("publisher")
                     if isinstance(body.get("publisher"), dict) else None)
        package = plugin_drafts.build(draft, signature)
        parsed = plugin_packages.parse(package)
        out = await plugin_service.install(
            session, package, actor, actor.org_id, visibility=visibility,
            audience_user_ids=body.get("userIds") or [],
            audience_org_unit_ids=body.get("orgUnitIds") or [],
            source_channel="personal-publish",
            source_name=str(draft.get("name") or draft.get("key") or "personal-plugin"),
            publisher_candidate=publisher,
            source_plugin_id=str(draft.get("sourcePluginId") or ""))
        proof = await plugin_signatures.inspect(session, parsed, actor.org_id)
        preview = plugin_packages.public_summary(parsed, proof)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    plugin = out["plugin"]
    count = (
        len(plugin_audience.ids(body.get("userIds") or []))
        if visibility == plugin_audience.USERS else
        len(plugin_audience.ids(
            body.get("orgUnitIds") or [], plugin_audience.MAX_ORG_UNITS, "团队或部门"))
        if visibility == plugin_audience.ORG_UNITS else 0)
    await audit.log(
        session, actor, "plugin.personal_publish", "plugin", plugin["id"], plugin["name"],
        {"template": str(draft.get("template") or ""), "state": "quarantined",
         "visibility": visibility, "audienceCount": count,
         "publisherKeyId": str(dict(publisher or {}).get("keyId") or "")[:64],
         "publisherCandidate": bool(publisher)})
    return {"ok": True, "created": out["created"], "plugin": plugin,
            "preview": preview, "visibility": visibility, "audienceCount": count,
            "message": "插件已上传企业隔离区，管理员审核发布后按所选范围可用"}


@router.post("/plugins/drafts/signing-payload")
async def client_plugin_signing_payload(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Create the exact canonical payload that the device signs locally."""
    actor = await _client_actor(session, client)
    draft = body.get("draft") if isinstance(body.get("draft"), dict) else {}
    try:
        await plugin_access.assert_draft_edit(session, actor.user_id, actor.org_id, draft)
        parsed = plugin_packages.parse(plugin_drafts.build(draft))
        payload = plugin_signatures.prepare_payload(
            parsed, body.get("keyId"), body.get("signedAt"))
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "payload": payload,
        "contentChecksum": parsed["contentChecksum"],
        "pluginKey": parsed["manifest"]["key"],
        "version": parsed["manifest"]["version"],
    }


@router.post("/plugins/drafts/preflight")
async def client_preflight_plugin_draft(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Build and inspect the governed draft without persisting a version."""
    actor = await _client_actor(session, client)
    try:
        await plugin_access.assert_draft_edit(session, actor.user_id, actor.org_id, body)
        package = plugin_drafts.build(body)
        return plugin_packages.public_summary(plugin_packages.parse(package))
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/plugins/drafts")
async def client_create_plugin_draft(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Create a standard package from a safe template and submit it through the shared quarantine
    review path.
    """
    actor = await _client_actor(session, client)
    try:
        await plugin_access.assert_draft_edit(session, actor.user_id, actor.org_id, body)
        package = plugin_drafts.build(body)
        preview = plugin_packages.public_summary(plugin_packages.parse(package))
        out = await plugin_service.install(
            session, package, actor, actor.org_id,
            source_channel="client-builder",
            source_name=str(body.get("name") or body.get("key") or "plugin-draft"),
            source_plugin_id=str(body.get("sourcePluginId") or ""))
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    plugin = out["plugin"]
    await audit.log(session, actor, "plugin.draft.submit", "plugin", plugin["id"], plugin["name"],
                    {"template": str(body.get("template") or ""), "state": "quarantined"})
    return {"ok": True, "created": out["created"], "plugin": plugin,
            "preview": preview,
            "message": "插件草稿已提交隔离区，可由管理员继续编排、模拟和发布"}
