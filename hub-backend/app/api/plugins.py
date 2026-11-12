"""Plugin APIs for quarantined imports, version trust, organizational bindings, and task execution.

"""
from __future__ import annotations

import json

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from ..db import get_session
from ..deps import require_any_perm, require_perm
from ..models import Task, User
from ..services import (audit, plugin_audience, plugin_evaluations,
                        plugin_governance, plugin_marketplace, plugin_mcp_gateway,
                        plugin_packages, plugin_rollout, plugin_service, plugin_signatures,
                        plugin_starter, rbac,
                        workflow_control, workflow_engine)
from .scope import task_or_404, visible_clients

router = APIRouter(prefix="/api/v1/admin/plugins", tags=["plugins"])
run_router = APIRouter(prefix="/api/v1/admin", tags=["plugin-runs"])


def _conflict(error: ValueError) -> HTTPException:
    return HTTPException(status_code=409, detail=str(error))


async def _scope(session: AsyncSession, user: User) -> set[str] | None:
    return await rbac.scope_org_ids(session, user)


async def _plugin(session: AsyncSession, user: User, plugin_id: str) -> am.Plugin:
    row = await session.get(am.Plugin, plugin_id)
    if row is None:
        raise HTTPException(status_code=404, detail="插件不存在")
    scope = await _scope(session, user)
    if scope is not None and row.org_id is not None and row.org_id not in scope:
        raise HTTPException(status_code=403, detail="这个插件不在你的组织范围内")
    return row


@router.get("")
async def plugins(
    user: User = Depends(require_any_perm("plugin.manage", "plugin.run")),
    session: AsyncSession = Depends(get_session),
):
    return {"items": await plugin_service.list_plugins(session, await _scope(session, user))}

@router.get("/governance")
async def plugin_governance_overview(
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    visible = await visible_clients(session, user)
    task_ids = None
    if visible is not None:
        task_ids = set((await session.execute(select(Task.id).where(
            Task.owner_client_id.in_(visible or {"__none__"})
        ))).scalars().all())
    return await plugin_governance.overview(
        session, await _scope(session, user), task_ids)


@router.get("/categories")
async def plugin_categories(
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    items = await plugin_marketplace.categories(session, include_disabled=True)
    usage = await plugin_marketplace.category_usage(session)
    return {"items": [{**item, "usageCount": usage.get(item["key"], 0)}
                       for item in items]}


@router.put("/categories")
async def update_plugin_categories(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    before = await plugin_marketplace.categories(session, include_disabled=True)
    try:
        rows = await plugin_marketplace.replace_categories(
            session, body.get("items"), str(user.id))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await audit.log(
        session, user, "plugin.categories_update", "plugin_catalog",
        "categories", "Employee plugin categories",
        {"before": before, "after": rows})
    usage = await plugin_marketplace.category_usage(session)
    return {"items": [{**item, "usageCount": usage.get(item["key"], 0)}
                       for item in rows]}


@router.post("/bulk-import")
async def bulk_import_plugins(
    files: list[UploadFile] = File(...),
    rightsConfirmed: bool = Form(False),
    sourceLabel: str = Form(""),
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Import owned or permissively licensed packages without scraping."""
    if not files or len(files) > 30:
        raise HTTPException(status_code=422, detail="Select between 1 and 30 packages")
    results = []
    source_label = str(sourceLabel or "External package import").strip()[:80]
    for file in files:
        filename = str(file.filename or "plugin.zip")[:180]
        try:
            data = await file.read(10 * 1024 * 1024 + 1)
            if len(data) > 10 * 1024 * 1024:
                raise ValueError("Plugin package exceeds 10 MB")
            parsed = plugin_packages.parse(data)
            proof = await plugin_signatures.inspect(session, parsed, user.org_id)
            plugin_signatures.assert_importable(proof)
            open_source = dict(parsed["manifest"].get("openSource") or {})
            if not open_source and not rightsConfirmed:
                raise ValueError(
                    "No verifiable permissive license. Confirm enterprise import rights")
            out = await plugin_service.install(
                session, data, user, user.org_id,
                source_channel="external-batch",
                source_name=source_label + " / " + filename)
            plugin = out["plugin"]
            results.append({
                "filename": filename, "ok": True,
                "created": bool(out["created"]),
                "pluginId": plugin["id"], "name": plugin["name"],
                "versionId": out["versionId"],
                "license": str(open_source.get("license") or
                               ("enterprise-rights-confirmed" if rightsConfirmed else "")),
            })
        except (ValueError, RuntimeError) as exc:
            results.append({"filename": filename, "ok": False,
                            "error": str(exc)[:500]})
    imported = sum(1 for item in results if item["ok"])
    await audit.log(
        session, user, "plugin.bulk_import", "plugin_catalog", "external",
        source_label, {"packages": len(results), "imported": imported,
                       "failed": len(results) - imported,
                       "rightsConfirmed": bool(rightsConfirmed),
                       "files": [{"filename": item["filename"], "ok": item["ok"]}
                                 for item in results]})
    return {"ok": imported == len(results), "imported": imported,
            "failed": len(results) - imported, "items": results}


@router.get("/starter")
async def starter_plugin(
    user: User = Depends(require_perm("plugin.manage")),
):
    """Download a deterministic package that passes the same parser as real imports."""
    return Response(
        plugin_starter.build(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{plugin_starter.FILENAME}"',
            "Cache-Control": "no-store",
        },
    )


@router.post("/preflight")
async def preflight_plugin(
    file: UploadFile = File(...),
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Inspect an upload without persisting a plugin or creating a version."""
    data = await file.read(10 * 1024 * 1024 + 1)
    try:
        parsed = plugin_packages.parse(data)
        proof = await plugin_signatures.inspect(session, parsed, user.org_id)
        plugin_signatures.assert_importable(proof)
        return plugin_packages.public_summary(parsed, proof)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{plugin_id}")
async def plugin_detail(
    plugin_id: str,
    user: User = Depends(require_any_perm("plugin.manage", "plugin.run")),
    session: AsyncSession = Depends(get_session),
):
    return await plugin_service.plugin_api(session, await _plugin(session, user, plugin_id), True)


@router.get("/{plugin_id}/rollout")
async def plugin_rollout_plan(
    plugin_id: str,
    targetVersionId: str,
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    plugin = await _plugin(session, user, plugin_id)
    try:
        return await plugin_rollout.plan(
            session, plugin, targetVersionId, await _scope(session, user))
    except ValueError as exc:
        raise _conflict(exc) from exc


@router.post("/{plugin_id}/rollout")
async def apply_plugin_rollout(
    plugin_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    plugin = await _plugin(session, user, plugin_id)
    target_version_id = str(body.get("targetVersionId") or "")
    binding_ids = list(body.get("bindingIds") or [])
    expected_versions = dict(body.get("expectedVersions") or {})
    try:
        result = await plugin_rollout.execute(
            session, plugin, target_version_id,
            binding_ids, expected_versions,
            await _scope(session, user),
            confirm_breaking=bool(body.get("confirmBreaking")),
        )
    except ValueError as exc:
        raise _conflict(exc) from exc
    await audit.log(
        session, user, "plugin.rollout", "plugin", plugin.id, plugin.name,
        {"targetVersionId": target_version_id,
         "targetVersion": dict(result.get("plan") or {}).get("target", {}).get("version"),
         "bindingIds": result["bindingIds"],
         "fromVersionIds": sorted({str(expected_versions.get(item) or "")
                                   for item in result["bindingIds"]
                                   if str(expected_versions.get(item) or "")}),
         "changed": result["changed"]})
    return result


@router.patch("/{plugin_id}/catalog-policy")
async def update_catalog_policy(
    plugin_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Control employee installation without changing immutable versions or bindings.

    Optional ``composeRecommended`` and ``sidebarRecommended`` update their
    independent placements in the same transaction. Missing keys stay untouched.
    """
    plugin = await _plugin(session, user, plugin_id)
    if plugin.org_id is None and not user.is_super:
        raise HTTPException(status_code=403, detail="系统级插件只能由超级管理员配置目录策略")
    before = plugin_marketplace.public_policy(
        await plugin_marketplace.get(session, plugin_id))
    before_compose = await plugin_marketplace.app_recommended_on(session, plugin_id)
    before_sidebar = await plugin_marketplace.app_recommended_on(session, plugin_id, "sidebar")
    for key in ("composeRecommended", "sidebarRecommended"):
        if key in body and not isinstance(body[key], bool):
            raise HTTPException(422, f"{key} 必须是布尔值")
    if body.get("featured", before["featured"]) is True:
        from ..services import plugin_covers, plugin_catalog
        versions = list((await session.execute(select(am.PluginVersion).where(
            am.PluginVersion.plugin_id == plugin_id,
            am.PluginVersion.enabled.is_(True),
            am.PluginVersion.trust_state == "approved",
        ))).scalars())
        versions.sort(key=plugin_catalog._version_key, reverse=True)
        try:
            declared = (versions[0].manifest or {}).get("coverUrl") if versions else ''
            cover = plugin_covers.normalize(body.get("coverUrl", before.get("coverUrl")) or declared)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        if not cover:
            raise HTTPException(422, "推荐前请填写封面地址，或在应用配置中声明 coverUrl")
        body = {**body, "coverUrl": cover}
    try:
        row = await plugin_marketplace.upsert(
            session, plugin_id, body, str(user.id), commit=False)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if "composeRecommended" in body:
        if not isinstance(body["composeRecommended"], bool):
            raise HTTPException(422, "composeRecommended 必须是布尔值")
        await plugin_marketplace.sync_app_recommendation(
            session, plugin_id, plugin.org_id,
            body["composeRecommended"], str(user.id), commit=False)
    if "sidebarRecommended" in body:
        await plugin_marketplace.sync_app_recommendation(
            session, plugin_id, plugin.org_id,
            body["sidebarRecommended"], str(user.id), commit=False, surface="sidebar")
    await session.commit()
    await session.refresh(row)
    after = plugin_marketplace.public_policy(row)
    after_compose = await plugin_marketplace.app_recommended_on(session, plugin_id)
    after_sidebar = await plugin_marketplace.app_recommended_on(session, plugin_id, "sidebar")
    await audit.log(
        session, user, "plugin.catalog_policy", "plugin", plugin.id, plugin.name,
        {"before": before, "after": after,
         "beforeComposeRecommended": before_compose,
         "afterComposeRecommended": after_compose,
         "beforeSidebarRecommended": before_sidebar,
         "afterSidebarRecommended": after_sidebar,
         "taskBindingsUnaffected": True})
    return {**after, "composeRecommended": after_compose, "sidebarRecommended": after_sidebar}


@router.get("/{plugin_id}/recommendation")
async def get_plugin_recommendation(
    plugin_id: str,
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Echo current application placements for the recommendation dialog."""
    plugin = await _plugin(session, user, plugin_id)
    return {"composeRecommended": await plugin_marketplace.app_recommended_on(session, plugin.id),
            "sidebarRecommended": await plugin_marketplace.app_recommended_on(session, plugin.id, "sidebar")}


@router.delete("/{plugin_id}")
async def delete_plugin(
    plugin_id: str,
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
    force: bool = False,
):
    """Remove a plugin; ``force=true`` first delists, revokes versions and
    disables bindings/installations so a published plugin can be removed in
    one step. In-flight runs are always protected."""
    plugin = await _plugin(session, user, plugin_id)
    if plugin.org_id is None and not user.is_super:
        raise HTTPException(status_code=403, detail="系统级插件只能由超级管理员删除")
    name = plugin.name
    try:
        result = await plugin_service.delete_plugin(
            session, plugin, force=force, actor_id=str(user.id))
    except ValueError as exc:
        raise _conflict(exc) from exc
    await audit.log(
        session, user, "plugin.delete", "plugin", plugin_id, name,
        {"versionsDeleted": result.get("versionsDeleted", 0),
         "forced": bool(force),
         "catalogWasNotAvailable": True})
    return {"ok": True, **result}


@router.get("/versions/{version_id}/mcp-tools")
async def plugin_mcp_tools(
    version_id: str,
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    version = await session.get(am.PluginVersion, version_id)
    if version is None:
        raise HTTPException(status_code=404, detail="插件版本不存在")
    await _plugin(session, user, version.plugin_id)
    names = list(dict(version.capability_report or {}).get("mcpServers") or [])[:20]
    try:
        return {"servers": await plugin_mcp_gateway.catalog(session, names)}
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/import")
async def import_plugin(
    file: UploadFile = File(...),
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    data = await file.read(10 * 1024 * 1024 + 1)
    try:
        out = await plugin_service.install(
            session, data, user, user.org_id,
            source_channel="admin-import", source_name=file.filename or "")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    plugin = out["plugin"]
    await audit.log(session, user, "plugin.import", "plugin", plugin["id"], plugin["name"],
                    {"created": out["created"], "filename": file.filename or ""})
    return out


@router.get("/versions/{version_id}/publisher-candidate")
async def version_publisher_candidate(
    version_id: str,
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Show the proof-of-possession checked public key only to plugin managers."""
    version = await session.get(am.PluginVersion, version_id)
    if version is None:
        raise HTTPException(status_code=404, detail="插件版本不存在")
    await _plugin(session, user, version.plugin_id)
    candidate = plugin_signatures.publisher_candidate(version)
    if not candidate:
        raise HTTPException(status_code=404, detail="这个版本没有待登记的发布身份")
    return candidate


@router.post("/versions/{version_id}/publisher-candidate/trust")
async def trust_version_publisher_candidate(
    version_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Explicitly register a submitted public key after re-verifying the package."""
    version = await session.get(am.PluginVersion, version_id)
    if version is None:
        raise HTTPException(status_code=404, detail="插件版本不存在")
    plugin = await _plugin(session, user, version.plugin_id)
    if plugin.org_id is None and not user.is_super:
        raise HTTPException(status_code=403, detail="系统级发布身份只能由超级管理员登记")
    try:
        row, proof = await plugin_signatures.register_candidate(
            session, version, plugin, user, body)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await audit.log(
        session, user, "plugin.publisher_candidate_trust",
        "plugin_publisher_key", row.id, row.publisher_name,
        {"pluginId": plugin.id, "versionId": version.id,
         "keyId": row.key_id, "fingerprint": row.fingerprint,
         "signatureState": proof.get("state")})
    return {
        "ok": True,
        "publisher": plugin_signatures.key_api(row),
        "version": plugin_service.version_api(version),
    }


@router.post("/versions/{version_id}/trust")
async def trust_version(
    version_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    version = await session.get(am.PluginVersion, version_id)
    if version is None:
        raise HTTPException(status_code=404, detail="插件版本不存在")
    plugin = await _plugin(session, user, version.plugin_id)
    if plugin.org_id is None and not user.is_super:
        raise HTTPException(status_code=403, detail="系统级插件只能由超级管理员审批")
    enabled = bool(body.get("enabled"))
    previous_state = str(version.trust_state or "quarantined")
    decision = ("approve" if enabled else
                "reject" if previous_state == "quarantined" else "revoke")
    note = str(body.get("note") or "").strip()[:1200]
    if not note and decision == "reject":
        note = "管理员退回修改"
    elif not note and decision == "revoke":
        note = "管理员撤销该版本"
    gate = None
    review_mode = "platform-strict" if plugin.org_id is None else "internal-light"
    if enabled and review_mode == "platform-strict":
        await plugin_evaluations.accept_ready_with_release_review(
            session, version, str(user.id))
        gate = await plugin_evaluations.publication_gate(
            session, version,
            confirm_without_evaluation=bool(body.get("confirmWithoutEvaluation")))
        if not gate["ok"]:
            raise HTTPException(
                status_code=409,
                detail="发布评测尚未通过：" + "；".join(gate.get("blockers") or []))
    elif enabled:
        gate = {
            "ok": True,
            "mode": review_mode,
            "advisory": dict(
                (version.capability_report or {}).get("qualitySummary") or {}),
        }
    await plugin_service.approve_version(
        session, version, enabled, user.display_name or user.username)
    await audit.log(session, user, "plugin." + decision,
                    "plugin_version", version.id, f"{plugin.name} {version.version}",
                    {"pluginId": plugin.id, "versionId": version.id,
                     "version": version.version, "decision": decision, "note": note,
                     "checksum": version.checksum, "capabilities": version.capability_report or {},
                     "evaluationGate": gate or {},
                     "reviewMode": review_mode})
    return plugin_service.version_api(version)


@router.post("/versions/{version_id}/simulate")
async def simulate_version(
    version_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    version = await session.get(am.PluginVersion, version_id)
    if version is None:
        raise HTTPException(status_code=404, detail="插件版本不存在")
    plugin = await _plugin(session, user, version.plugin_id)
    from .. import models
    project_id = str(body.get("projectId") or "")
    project = await session.get(models.Project, project_id) if project_id else None
    if project_id and project is None:
        raise HTTPException(status_code=404, detail="模拟项目不存在")
    scope = await _scope(session, user)
    if project is not None and scope is not None and project.org_id not in scope:
        raise HTTPException(status_code=403, detail="这个项目不在你的组织范围内")
    org_id = project.org_id if project is not None else (plugin.org_id or user.org_id)
    try:
        return await plugin_service.simulate(
            session, version, project, org_id, str(body.get("agentKind") or ""),
            dict(body.get("config") or {}), dict(body.get("secretRefs") or {}))
    except ValueError as exc:
        raise _conflict(exc) from exc


@router.get("/versions/{version_id}/evaluations")
async def version_evaluations(
    version_id: str,
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    version = await session.get(am.PluginVersion, version_id)
    if version is None:
        raise HTTPException(status_code=404, detail="插件版本不存在")
    await _plugin(session, user, version.plugin_id)
    return await plugin_evaluations.list_runs(session, version)


@router.get("/versions/{version_id}/audience")
async def version_audience(
    version_id: str,
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    version = await session.get(am.PluginVersion, version_id)
    if version is None:
        raise HTTPException(status_code=404, detail="插件版本不存在")
    await _plugin(session, user, version.plugin_id)
    return {
        "visibility": plugin_audience.normalize(version.visibility),
        "items": await plugin_audience.members(session, version.id),
    }


@router.post("/versions/{version_id}/evaluations/{case_key}/start")
async def start_version_evaluation(
    version_id: str,
    case_key: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    version = await session.get(am.PluginVersion, version_id)
    if version is None:
        raise HTTPException(status_code=404, detail="插件版本不存在")
    plugin = await _plugin(session, user, version.plugin_id)
    if plugin.org_id is None and not user.is_super:
        raise HTTPException(status_code=403, detail="系统级插件只能由超级管理员评测")
    try:
        row = await plugin_evaluations.start(session, version, case_key, user, body)
    except ValueError as exc:
        raise _conflict(exc) from exc
    await audit.log(
        session, user, "plugin.evaluation_start", "plugin_evaluation", row.id,
        f"{plugin.name} {version.version}",
        {"versionId": version.id, "caseKey": row.case_key,
         "agentKind": row.agent_kind, "state": row.state})
    return plugin_evaluations.run_api(row)


@router.post("/evaluation-runs/{run_id}/review")
async def review_version_evaluation(
    run_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(am.PluginEvaluationRun, run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="发布评测不存在")
    version = await session.get(am.PluginVersion, row.version_id)
    if version is None:
        raise HTTPException(status_code=404, detail="插件版本不存在")
    plugin = await _plugin(session, user, version.plugin_id)
    try:
        row = await plugin_evaluations.review(
            session, row, str(body.get("decision") or ""),
            str(user.id), str(body.get("note") or ""))
    except ValueError as exc:
        raise _conflict(exc) from exc
    await audit.log(
        session, user, "plugin.evaluation_review", "plugin_evaluation", row.id,
        f"{plugin.name} {version.version}",
        {"versionId": version.id, "caseKey": row.case_key,
         "decision": row.verdict, "note": row.review_note})
    return plugin_evaluations.run_api(row)


@router.post("/evaluation-runs/{run_id}/cancel")
async def cancel_version_evaluation(
    run_id: str,
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(am.PluginEvaluationRun, run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="发布评测不存在")
    version = await session.get(am.PluginVersion, row.version_id)
    if version is None:
        raise HTTPException(status_code=404, detail="插件版本不存在")
    plugin = await _plugin(session, user, version.plugin_id)
    row = await plugin_evaluations.cancel(
        session, row, user.display_name or user.username)
    await audit.log(
        session, user, "plugin.evaluation_cancel", "plugin_evaluation", row.id,
        f"{plugin.name} {version.version}",
        {"versionId": version.id, "caseKey": row.case_key})
    return plugin_evaluations.run_api(row)


@router.post("/{plugin_id}/bindings")
async def create_binding(
    plugin_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    plugin = await _plugin(session, user, plugin_id)
    safe = dict(body)
    binding_org = body.get("orgId") if user.is_super else user.org_id
    # Infer the binding organization from the target project when a superuser has no org_id.
    # Keep project bindings organizational rather than unintentionally global.
    if user.is_super and not binding_org and body.get("projectId"):
        from .. import models
        project = await session.get(models.Project, str(body.get("projectId")))
        if project is None:
            raise HTTPException(status_code=404, detail="绑定的项目不存在")
        binding_org = project.org_id
    safe["orgId"] = binding_org
    try:
        row = await plugin_service.save_binding(session, plugin, safe)
    except ValueError as e:
        raise _conflict(e) from e
    await audit.log(session, user, "plugin.bind", "plugin_binding", row.id, plugin.name,
                    {"pluginId": plugin.id, "projectId": row.project_id,
                     "versionId": row.version_id, "enabled": row.enabled})
    return {**plugin_service.binding_api(row),
            "readiness": await _binding_readiness(session, row)}


@router.patch("/bindings/{binding_id}")
async def update_binding(
    binding_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    binding = await session.get(am.PluginBinding, binding_id)
    if binding is None:
        raise HTTPException(status_code=404, detail="插件绑定不存在")
    plugin = await _plugin(session, user, binding.plugin_id)
    scope = await _scope(session, user)
    if scope is not None and binding.org_id is not None and binding.org_id not in scope:
        raise HTTPException(status_code=403, detail="这个绑定不在你的组织范围内")
    before = {"enabled": binding.enabled, "versionId": binding.version_id,
              "projectId": binding.project_id}
    try:
        row = await plugin_service.save_binding(session, plugin, body, binding)
    except ValueError as e:
        raise _conflict(e) from e
    await audit.log(session, user, "plugin.binding_update", "plugin_binding", row.id,
                    plugin.name, {"pluginId": plugin.id, "before": before,
                                  "after": {"enabled": row.enabled,
                                            "versionId": row.version_id,
                                            "projectId": row.project_id}})
    return {**plugin_service.binding_api(row),
            "readiness": await _binding_readiness(session, row)}


async def _binding_readiness(session: AsyncSession, binding: am.PluginBinding) -> dict:
    """Behavior and constraints for this operation."""
    from .. import models
    version = await session.get(am.PluginVersion, binding.version_id)
    project = await session.get(models.Project, binding.project_id) \
        if binding.project_id else None
    if version is None:
        return {"ok": True, "blockers": [], "warnings": []}
    return await plugin_service.binding_readiness(
        session, version, project, binding.org_id, secret_refs=binding.secret_refs,
        binding_config=binding.config)


@run_router.get("/plugin-runs")
async def runs(
    taskId: str = "",
    user: User = Depends(require_any_perm("plugin.manage", "plugin.run")),
    session: AsyncSession = Depends(get_session),
):
    if taskId:
        await task_or_404(session, user, taskId)
        return {"items": await workflow_engine.list_runs(session, taskId)}
    visible = await visible_clients(session, user)
    if visible is None:
        return {"items": await workflow_engine.list_runs(session)}
    task_ids = set((await session.execute(select(Task.id).where(
        Task.owner_client_id.in_(visible or {"__none__"})))).scalars().all())
    return {"items": await workflow_engine.list_runs(session, task_ids=task_ids)}


@run_router.get("/plugin-runs/{run_id}")
async def run_detail(
    run_id: str,
    user: User = Depends(require_any_perm("plugin.manage", "plugin.run")),
    session: AsyncSession = Depends(get_session),
):
    run = await session.get(am.WorkflowRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="插件运行不存在")
    await task_or_404(session, user, run.task_id)
    return await workflow_engine.run_api(session, run)


@run_router.post("/plugin-runs/{run_id}/cancel")
async def cancel_run(
    run_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("plugin.run")),
    session: AsyncSession = Depends(get_session),
):
    run = await session.get(am.WorkflowRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="插件运行不存在")
    task = await task_or_404(session, user, run.task_id)
    reason = str(body.get("reason") or "由管理员结束本次流程").strip()[:500]
    try:
        result = await workflow_control.cancel_run(
            session, run, actor=user.display_name or user.username, reason=reason)
    except ValueError as e:
        raise _conflict(e) from e
    await audit.log(session, user, "plugin.run_cancel", "workflow_run", run.id, task.title,
                    {"taskId": task.id, "reason": reason})
    return {**result, "run": await workflow_engine.run_api(session, run)}


@run_router.post("/plugin-runs/{run_id}/retry-quality")
async def admin_retry_quality(
    run_id: str,
    user: User = Depends(require_perm("plugin.run")),
    session: AsyncSession = Depends(get_session),
):
    """Retry only the quality gate while preserving verified code evidence."""
    run = await session.get(am.WorkflowRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="插件运行不存在")
    task = await task_or_404(session, user, run.task_id)
    try:
        node = await workflow_engine.retry_failed_quality(
            session, run, actor=user.display_name or user.username)
    except ValueError as e:
        raise _conflict(e) from e
    await audit.log(session, user, "plugin.retry_quality", "workflow_run", run.id, task.title,
                    {"node": node.node_key, "attempt": node.attempt})
    return {"ok": True, "node": workflow_engine.node_api(node),
            "run": await workflow_engine.run_api(session, run)}


@run_router.post("/plugin-runs/{run_id}/retry-gate")
async def admin_retry_gate(
    run_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("plugin.run")),
    session: AsyncSession = Depends(get_session),
):
    """Retry an administrative workflow gate after transient or configuration failures without
    rerunning completed development work.
    """
    run = await session.get(am.WorkflowRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="插件运行不存在")
    task = await task_or_404(session, user, run.task_id)
    try:
        node = await workflow_engine.retry_failed_gate(
            session, run, actor=user.display_name or user.username,
            node_key=str(body.get("nodeKey") or ""),
            execution=dict(body.get("execution") or {}) or None,
            resume_rework=bool(body.get("resumeRework")))
    except ValueError as e:
        raise _conflict(e) from e
    await audit.log(session, user, "plugin.retry_gate", "workflow_run", run.id, task.title,
                    {"node": node.node_key, "attempt": node.attempt,
                     "executionChanged": bool(body.get("execution")),
                     "resumeRework": bool(body.get("resumeRework"))})
    return {"ok": True, "node": workflow_engine.node_api(node),
            "run": await workflow_engine.run_api(session, run)}


@run_router.post("/plugin-runs/{run_id}/redispatch")
async def admin_redispatch_gate(
    run_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("plugin.run")),
    session: AsyncSession = Depends(get_session),
):
    """Allow administrators to stop and redispatch an active AI node to another executor."""
    run = await session.get(am.WorkflowRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="插件运行不存在")
    task = await task_or_404(session, user, run.task_id)
    try:
        node = await workflow_engine.redispatch_running_gate(
            session, run, actor=user.display_name or user.username,
            node_key=str(body.get("nodeKey") or ""),
            execution=dict(body.get("execution") or {}) or None)
    except ValueError as e:
        raise _conflict(e) from e
    await audit.log(session, user, "plugin.redispatch_gate", "workflow_run", run.id, task.title,
                    {"node": node.node_key, "attempt": node.attempt})
    return {"ok": True, "node": workflow_engine.node_api(node),
            "run": await workflow_engine.run_api(session, run)}


@run_router.post("/tasks/{task_id}/plugin-runs")
async def start_run(
    task_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("plugin.run")),
    session: AsyncSession = Depends(get_session),
):
    task = await task_or_404(session, user, task_id)
    inputs = body.get("inputs") or {}
    if not isinstance(inputs, dict) or len(json.dumps(inputs, ensure_ascii=False)) > 100_000:
        raise HTTPException(status_code=400, detail="插件输入必须是小于 100KB 的对象")
    try:
        binding = await plugin_service.resolve_binding(
            session, task, binding_id=str(body.get("bindingId") or ""),
            plugin_id=str(body.get("pluginId") or ""), org_ids=await _scope(session, user))
        source_id = str(body.get("resumeFromRunId") or "")
        source = await session.get(am.WorkflowRun, source_id) if source_id else None
        if source_id and source is None:
            raise ValueError("要续接的历史流程不存在")
        starter = workflow_engine.start_from_evidence if source else workflow_engine.start
        extra = ({"source_run": source, "target_key": str(body.get("startAtNode") or "")}
                 if source else {})
        run = await starter(
            session, task, binding, inputs, actor_id=str(user.id),
            execution=body.get("execution"), instruction=str(body.get("instruction") or ""),
            repo_id=str(body.get("repoId") or ""), **extra)
    except ValueError as e:
        raise _conflict(e) from e
    await audit.log(session, user, "plugin.run", "workflow_run", run.id, task.title,
                    {"taskId": task.id, "pluginId": run.plugin_id,
                     "pluginVersionId": run.plugin_version_id,
                     "resumeFromRunId": str(body.get("resumeFromRunId") or ""),
                     "startAtNode": str(body.get("startAtNode") or "")})
    return await workflow_engine.run_api(session, run)
