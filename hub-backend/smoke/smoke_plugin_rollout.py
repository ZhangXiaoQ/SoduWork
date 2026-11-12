# -*- coding: utf-8 -*-
"""Plugin-release tests for organization isolation, impact analysis, atomic switching, concurrency,
and rollback.
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from sqlalchemy import event, select

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(BASE, ".smoke-plugin-rollout.db")


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
from app.services import plugin_rollout, plugin_service  # noqa: E402


checks = 0


def ok(condition, message, extra=""):
    global checks
    if not condition:
        raise AssertionError(message + (": " + str(extra)[:500] if extra else ""))
    checks += 1


def workflow(include_deliver=True):
    nodes = [{
        "key": "work", "type": "ai", "name": "完成工作",
        "outputs": [{"key": "draft", "kind": "file", "required": True}],
    }]
    if include_deliver:
        nodes.append({
            "key": "deliver", "type": "publish", "name": "交付结果",
            "dependsOn": ["work"],
            "inputs": [{
                "key": "draft", "fromNode": "work",
                "outputKey": "draft", "required": True,
            }],
        })
    return {"nodes": nodes}


async def versions_of(*binding_ids):
    async with SessionLocal() as session:
        rows = list((await session.execute(select(am.PluginBinding).where(
            am.PluginBinding.id.in_(binding_ids)
        ).order_by(am.PluginBinding.id))).scalars().all())
        return {row.id: row.version_id for row in rows}


async def main():
    await init_db()
    now = datetime.now(timezone.utc)
    plugin = am.Plugin(
        id="plugin-rollout", org_id="org-a", key="rollout",
        name="版本发布插件", enabled=True, source_kind="soduwork")
    versions = [
        am.PluginVersion(
            id="rollout-v1", plugin_id=plugin.id, version="1.0.0",
            checksum="v1", trust_state="approved", enabled=True,
            manifest={"entrypoints": {"task": True}},
            workflow=workflow(), capability_report={"hasWorkflow": True},
            created_at=now - timedelta(days=2)),
        am.PluginVersion(
            id="rollout-v2", plugin_id=plugin.id, version="1.1.0",
            checksum="v2", trust_state="approved", enabled=True,
            manifest={"entrypoints": {"task": True}},
            workflow=workflow(), capability_report={"hasWorkflow": True},
            created_at=now - timedelta(days=1)),
        am.PluginVersion(
            id="rollout-v3", plugin_id=plugin.id, version="2.0.0",
            checksum="v3", trust_state="approved", enabled=True,
            manifest={"entrypoints": {"task": True}},
            workflow=workflow(False), capability_report={"hasWorkflow": True},
            created_at=now),
    ]
    projects = [
        models.Project(id="project-rollout-a1", name="产品一部", org_id="org-a"),
        models.Project(id="project-rollout-a2", name="产品二部", org_id="org-a"),
        models.Project(id="project-rollout-b", name="其他企业", org_id="org-b"),
    ]
    bindings = [
        am.PluginBinding(
            id="binding-rollout-a1", plugin_id=plugin.id, version_id="rollout-v1",
            org_id="org-a", project_id="project-rollout-a1",
            config={}, secret_refs={}, enabled=True),
        am.PluginBinding(
            id="binding-rollout-a2", plugin_id=plugin.id, version_id="rollout-v1",
            org_id="org-a", project_id="project-rollout-a2",
            config={}, secret_refs={}, enabled=True),
        am.PluginBinding(
            id="binding-rollout-b", plugin_id=plugin.id, version_id="rollout-v1",
            org_id="org-b", project_id="project-rollout-b",
            config={}, secret_refs={}, enabled=True),
    ]
    async with SessionLocal() as session:
        session.add_all([plugin] + versions + projects + bindings)
        await session.commit()

    selects = []

    def capture(_conn, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            selects.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", capture)
    try:
        async with SessionLocal() as session:
            plan = await plugin_rollout.plan(
                session, plugin, "rollout-v2", {"org-a"})
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", capture)

    ok(plan["summary"]["bindings"] == 2,
       "发布清单必须按组织隔离", plan["summary"])
    ok({item["id"] for item in plan["items"]} == {
        "binding-rollout-a1", "binding-rollout-a2"},
       "不能把其他企业绑定带进发布清单", plan["items"])
    ok(plan["summary"]["eligible"] == 2 and plan["summary"]["breaking"] == 0,
       "兼容版本应默认可切换", plan["summary"])
    ok(all(item["compatibility"]["level"] == "safe" for item in plan["items"]),
       "相同契约版本必须判定为兼容", plan["items"])
    ok(len(selects) <= 3,
       "影响清单查询必须有界，不能随绑定数量线性增长", len(selects))

    original_readiness = plugin_service.binding_readiness

    async def ready(*_args, **_kwargs):
        return {"ok": True, "blockers": [], "warnings": []}

    plugin_service.binding_readiness = ready
    try:
        async with SessionLocal() as session:
            result = await plugin_rollout.execute(
                session, plugin, "rollout-v2",
                ["binding-rollout-a1", "binding-rollout-a2"],
                {
                    "binding-rollout-a1": "rollout-v1",
                    "binding-rollout-a2": "rollout-v1",
                },
                {"org-a"},
            )
        ok(result["changed"] == 2,
           "一次操作必须切换全部选中绑定", result)
        ok(await versions_of("binding-rollout-a1", "binding-rollout-a2") == {
            "binding-rollout-a1": "rollout-v2",
            "binding-rollout-a2": "rollout-v2",
        }, "批量切换没有持久化")

        stale_failed = False
        try:
            async with SessionLocal() as session:
                await plugin_rollout.execute(
                    session, plugin, "rollout-v1",
                    ["binding-rollout-a1"],
                    {"binding-rollout-a1": "rollout-v1"},
                    {"org-a"},
                )
        except ValueError as exc:
            stale_failed = "已经变化" in str(exc)
        ok(stale_failed, "乐观锁必须拒绝过期影响清单")

        original_save = plugin_service.save_binding
        calls = 0

        async def fail_second(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise ValueError("模拟第二条写入失败")
            return await original_save(*args, **kwargs)

        plugin_service.save_binding = fail_second
        atomic_failed = False
        try:
            async with SessionLocal() as session:
                await plugin_rollout.execute(
                    session, plugin, "rollout-v1",
                    ["binding-rollout-a1", "binding-rollout-a2"],
                    {
                        "binding-rollout-a1": "rollout-v2",
                        "binding-rollout-a2": "rollout-v2",
                    },
                    {"org-a"},
                )
        except ValueError as exc:
            atomic_failed = "第二条写入失败" in str(exc)
        finally:
            plugin_service.save_binding = original_save
        ok(atomic_failed, "中途写入异常必须清晰失败")
        ok(await versions_of("binding-rollout-a1", "binding-rollout-a2") == {
            "binding-rollout-a1": "rollout-v2",
            "binding-rollout-a2": "rollout-v2",
        }, "批量切换失败时必须完整回滚，不能留下半批数据")

        breaking_blocked = False
        try:
            async with SessionLocal() as session:
                await plugin_rollout.execute(
                    session, plugin, "rollout-v3",
                    ["binding-rollout-a1"],
                    {"binding-rollout-a1": "rollout-v2"},
                    {"org-a"},
                )
        except ValueError as exc:
            breaking_blocked = "破坏性变更" in str(exc)
        ok(breaking_blocked, "破坏性版本必须要求明确确认")

        async with SessionLocal() as session:
            changed = await plugin_rollout.execute(
                session, plugin, "rollout-v3",
                ["binding-rollout-a1"],
                {"binding-rollout-a1": "rollout-v2"},
                {"org-a"}, confirm_breaking=True)
        ok(changed["changed"] == 1 and
           (await versions_of("binding-rollout-a1"))["binding-rollout-a1"] ==
           "rollout-v3",
           "明确确认后必须允许受控切换破坏性版本", changed)

        out_of_scope = False
        try:
            async with SessionLocal() as session:
                await plugin_rollout.execute(
                    session, plugin, "rollout-v2",
                    ["binding-rollout-b"],
                    {"binding-rollout-b": "rollout-v1"},
                    {"org-a"},
                )
        except ValueError as exc:
            out_of_scope = "管理范围" in str(exc)
        ok(out_of_scope, "不能通过绑定 id 越权切换其他企业版本")
    finally:
        plugin_service.binding_readiness = original_readiness

    print("plugin rollout: " + str(checks) + " checks passed; " +
          str(len(selects)) + " SELECTs for plan")


try:
    asyncio.run(main())
finally:
    asyncio.run(engine.dispose())
    cleanup()
