# -*- coding: utf-8 -*-
"""Plugin-management tests for mandatory readiness checks and scoped governance history without
invocation payloads.
"""
import asyncio
import os
import sys
from types import SimpleNamespace

from sqlalchemy import select

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(BASE, ".smoke-plugin-admin-guard.db")


def cleanup():
    for suffix in ("", "-shm", "-wal"):
        try:
            os.remove(DB + suffix)
        except FileNotFoundError:
            pass


cleanup()
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, BASE)

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import audit, plugin_service  # noqa: E402


checks = 0


def ok(condition, message, extra=""):
    global checks
    if not condition:
        raise AssertionError(message + (": " + str(extra)[:600] if extra else ""))
    checks += 1


async def main():
    await init_db()
    plugin = am.Plugin(
        id="plugin-admin-guard", org_id="org-a", key="admin-guard",
        name="企业发布插件", enabled=True, source_kind="soduwork")
    version = am.PluginVersion(
        id="plugin-admin-guard-v1", plugin_id=plugin.id, version="1.0.0",
        checksum="admin-guard-v1", trust_state="approved", enabled=True,
        manifest={"entrypoints": {"task": True}},
        workflow={"nodes": [{"key": "work", "type": "ai", "name": "执行"}]},
        capability_report={"hasWorkflow": True})
    project = models.Project(
        id="plugin-admin-project", name="生产数据分析", org_id="org-a")
    binding = am.PluginBinding(
        id="plugin-admin-binding", plugin_id=plugin.id, version_id=version.id,
        org_id="org-a", project_id=project.id, config={}, secret_refs={},
        enabled=False)
    async with SessionLocal() as session:
        session.add_all([plugin, version, project, binding])
        await session.commit()

    original_readiness = plugin_service.binding_readiness

    async def blocked(*_args, **_kwargs):
        return {"ok": False, "blockers": ["当前没有符合条件的在线 Runner"],
                "warnings": [], "checks": []}

    plugin_service.binding_readiness = blocked
    try:
        rejected = ""
        async with SessionLocal() as session:
            row = await session.get(am.PluginBinding, binding.id)
            try:
                await plugin_service.save_binding(
                    session, plugin, {"enabled": True}, row)
            except ValueError as exc:
                rejected = str(exc)
                await session.rollback()
        ok("启用前体检未通过" in rejected and "在线 Runner" in rejected,
           "任何入口启用绑定都必须被后端体检兜住", rejected)
        async with SessionLocal() as session:
            row = await session.get(am.PluginBinding, binding.id)
            ok(row is not None and row.enabled is False,
               "体检失败不能留下已启用的脏绑定", row.enabled if row else None)

        async with SessionLocal() as session:
            row = await session.get(am.PluginBinding, binding.id)
            saved = await plugin_service.save_binding(
                session, plugin, {"enabled": False,
                                  "config": {"fallbackMode": "strict"}}, row)
            ok(saved.enabled is False and saved.config.get("fallbackMode") == "strict",
               "停用状态应允许先修配置再重新体检", saved.config)

        created_rejected = ""
        async with SessionLocal() as session:
            try:
                await plugin_service.save_binding(session, plugin, {
                    "versionId": version.id, "projectId": project.id,
                    "orgId": "org-a", "enabled": True,
                })
            except ValueError as exc:
                created_rejected = str(exc)
                await session.rollback()
        ok("启用前体检未通过" in created_rejected,
           "新建绑定也不能绕过体检", created_rejected)
        async with SessionLocal() as session:
            count = len(list((await session.execute(select(am.PluginBinding))).scalars()))
            ok(count == 1, "失败的新建绑定不能落库", count)
    finally:
        plugin_service.binding_readiness = original_readiness

    logs = [
        models.AuditLog(
            actor_name="插件管理员", actor_org_id="org-a",
            action="plugin.import", target_type="plugin", target_id=plugin.id,
            target_label=plugin.name, detail={"filename": "release.zip"}),
        models.AuditLog(
            actor_name="插件管理员", actor_org_id="org-a",
            action="plugin.approve", target_type="plugin_version", target_id=version.id,
            target_label="企业发布插件 1.0.0",
            detail={"pluginId": plugin.id, "versionId": version.id}),
        models.AuditLog(
            actor_name="插件管理员", actor_org_id="org-a",
            action="plugin.binding_update", target_type="plugin_binding",
            target_id=binding.id, target_label=plugin.name,
            detail={"pluginId": plugin.id, "after": {"enabled": True,
                                                       "versionId": version.id}}),
        models.AuditLog(
            actor_name="插件管理员", actor_org_id="org-a",
            action="plugin.rollout", target_type="plugin", target_id=plugin.id,
            target_label=plugin.name,
            detail={"targetVersionId": version.id, "bindingIds": [binding.id]}),
        models.AuditLog(
            actor_name="插件管理员", actor_org_id="org-a",
            action="plugin.evaluation_review", target_type="plugin_evaluation",
            target_id="evaluation-1", target_label="企业发布插件 1.0.0",
            detail={"versionId": version.id, "decision": "passed"}),
        models.AuditLog(
            actor_name="插件管理员", actor_org_id="org-a",
            action="plugin.run_cancel", target_type="workflow_run",
            target_id="plugin-run-1", target_label="验证发布流程", detail={}),
        models.AuditLog(
            actor_name="成员", actor_org_id="org-a",
            action="plugin.mcp_call", target_type="mcp_server",
            target_id="test", target_label="test",
            detail={"bindingIds": [binding.id], "durationMs": 20}),
        models.AuditLog(
            actor_name="其他插件管理员", actor_org_id="org-b",
            action="plugin.import", target_type="plugin", target_id="plugin-other",
            target_label="其他插件", detail={}),
    ]
    async with SessionLocal() as session:
        session.add_all(logs)
        await session.commit()
        actor = SimpleNamespace(is_super=True)
        activity = await audit.list_plugin_governance_activity(
            session, actor, plugin.id, version_ids={version.id},
            binding_ids={binding.id}, run_ids={"plugin-run-1"})
    actions = {item["action"] for item in activity["items"]}
    expected = {"plugin.import", "plugin.approve", "plugin.binding_update",
                "plugin.rollout", "plugin.evaluation_review", "plugin.run_cancel"}
    ok(actions == expected, "插件治理流水必须覆盖完整生命周期且不串插件", actions)
    ok(activity["total"] == len(expected),
       "治理流水数量不能混入连接调用或其他插件", activity)
    ok("plugin.mcp_call" not in actions,
       "连接调用与治理变更必须分开呈现", actions)

    print(f"plugin admin guard: {checks} checks passed")


try:
    asyncio.run(main())
finally:
    asyncio.run(engine.dispose())
    cleanup()
