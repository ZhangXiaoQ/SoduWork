# -*- coding: utf-8 -*-
"""Force-delete verification for plugin management; isolated DB, no real data."""
from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile

from fastapi import HTTPException
from sqlalchemy import delete, select

sys.path.insert(0, ".")
_TEMP = tempfile.TemporaryDirectory(prefix="soduwork-force-delete-",
                                     ignore_cleanup_errors=True)
DB = os.path.join(_TEMP.name, "test.db")
DATA = os.path.join(_TEMP.name, "data")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
os.environ["SODUWORK_DATA_ROOT"] = DATA

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.api import plugins as plugin_api  # noqa: E402
from app.services import plugin_marketplace, plugin_service  # noqa: E402

ORG = "o-force-delete"
USER = "u-force-delete"
CLIENT = "c-force-delete"
PLUGIN = "plg-force-delete"
VERSION = "plv-force-delete"
BINDING = "plb-force-delete"
RUN = "wfr-force-delete"
ok = fail = 0


def chk(name, condition, extra=""):
    global ok, fail
    if condition:
        ok += 1
        print("  PASS  " + name, flush=True)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""),
              flush=True)


async def purge():
    async with SessionLocal() as session:
        await session.execute(delete(am.WorkflowRun).where(
            am.WorkflowRun.id == RUN))
        await session.execute(delete(am.PluginInstallation).where(
            am.PluginInstallation.plugin_id == PLUGIN))
        await session.execute(delete(am.PluginCatalogPolicy).where(
            am.PluginCatalogPolicy.plugin_id == PLUGIN))
        await session.execute(delete(am.PluginBinding).where(
            am.PluginBinding.id == BINDING))
        await session.execute(delete(am.PluginVersion).where(
            am.PluginVersion.id == VERSION))
        await session.execute(delete(am.Plugin).where(am.Plugin.id == PLUGIN))
        await session.execute(delete(models.Client).where(
            models.Client.id == CLIENT))
        await session.execute(delete(models.User).where(models.User.id == USER))
        await session.execute(delete(models.OrgUnit).where(
            models.OrgUnit.id == ORG))
        await session.commit()


async def seed_published():
    """A fully published plugin: approved version, binding, install, listed."""
    async with SessionLocal() as session:
        session.add(models.OrgUnit(id=ORG, name="强制删除测试组织"))
        session.add(models.User(id=USER, username="force-delete-user",
                                display_name="管理员", org_id=ORG, is_active=True))
        session.add(models.Client(id=CLIENT, name="员工终端",
                                  auth_state="active", user_ref=USER))
        session.add(am.Plugin(
            id=PLUGIN, org_id=ORG, key="force-delete-target",
            name="已发布插件", description="验证强制删除",
            enabled=True, source_kind="soduwork"))
        session.add(am.PluginVersion(
            id=VERSION, plugin_id=PLUGIN, version="1.0.0",
            checksum="force-delete-v1",
            manifest={"name": "已发布插件",
                      "entrypoints": {"conversation": True, "task": True}},
            workflow={},
            capability_report={"hasWorkflow": False, "skills": [],
                               "mcpServers": [], "runtime": [], "network": False},
            trust_state="approved", visibility="organization", enabled=True))
        session.add(am.PluginBinding(
            id=BINDING, plugin_id=PLUGIN, version_id=VERSION,
            org_id=ORG, enabled=True))
        session.add(am.PluginInstallation(
            plugin_id=PLUGIN, version_id=VERSION, user_id=USER,
            enabled=True, config={}))
        await plugin_marketplace.upsert(
            session, PLUGIN, {"installation": "available"}, "seed",
            commit=False)
        await session.commit()


async def catalog_visible():
    async with SessionLocal() as session:
        client = await session.get(models.Client, CLIENT)
        from app.api.plugin_client_catalog import _client_actor, \
            client_plugin_catalog
        snapshot = await client_plugin_catalog(client=client, session=session)
        ids = [item.get("pluginId") for item in snapshot.get("items") or []]
        return PLUGIN in ids


async def main():
    await init_db()
    await purge()
    await seed_published()
    async with SessionLocal() as session:
        user = await session.get(models.User, USER)

        # 1. strict delete (no force) still refuses a published plugin.
        blocked = False
        try:
            await plugin_api.delete_plugin(PLUGIN, user, session, False)
        except HTTPException as exc:
            blocked = exc.status_code == 409
        chk("未加 force 时已发布插件仍被拒绝删除", blocked)
    chk("拒绝后插件仍然存在", await _plugin_exists())

    # 2. an active workflow run blocks even force delete.
    async with SessionLocal() as session:
        session.add(am.WorkflowRun(
            id=RUN, task_id="t-force-delete", plugin_id=PLUGIN,
            plugin_version_id=VERSION, state="running", input={}))
        await session.commit()
    refused = False
    async with SessionLocal() as sess:
        try:
            await plugin_api.delete_plugin(PLUGIN, user, sess, True)
        except HTTPException as exc:
            refused = exc.status_code == 409 and "运行中" in str(exc.detail)
    chk("运行中的任务使 force 删除仍被拒绝", refused, "expected 409 运行中")
    async with SessionLocal() as session:
        await session.execute(delete(am.WorkflowRun).where(
            am.WorkflowRun.id == RUN))
        await session.commit()

    # 3. force delete succeeds in one step and wipes client visibility.
    async with SessionLocal() as sess:
        result = await plugin_api.delete_plugin(PLUGIN, user, sess, True)
    chk("force 删除成功", bool(result.get("ok")), result)
    chk("返回了停用的绑定与安装计数",
        result.get("bindingsDisabled") == 1
        and result.get("installationsDisabled") == 1, result)
    chk("管理端查不到插件", not await _plugin_exists())
    chk("客户端目录不可见", not await catalog_visible())

    # 4. strict path still works for an already-idle plugin (regression).
    await purge()
    await seed_published()
    async with SessionLocal() as session:
        plugin = await session.get(am.Plugin, PLUGIN)
        await plugin_marketplace.upsert(
            session, PLUGIN, {"installation": "not_available"}, "admin",
            commit=False)
        version = await session.get(am.PluginVersion, VERSION)
        await plugin_service.approve_version(session, version, False, "admin",
                                             commit=False)
        binding = await session.get(am.PluginBinding, BINDING)
        if binding is not None:
            binding.enabled = False
        installs = list((await session.execute(select(am.PluginInstallation).where(
            am.PluginInstallation.plugin_id == PLUGIN))).scalars().all())
        for installation in installs:
            installation.enabled = False
        await session.commit()
        plugin = await session.get(am.Plugin, PLUGIN)
        await plugin_service.delete_plugin(session, plugin)
    chk("严格路径（手工清理后）仍可删除", not await _plugin_exists())

    await purge()
    from app.db import engine
    await engine.dispose()
    shutil.rmtree(DATA, ignore_errors=True)
    print(f"PASS={ok} FAIL={fail}")
    sys.exit(1 if fail else 0)


async def _plugin_exists():
    async with SessionLocal() as session:
        return await session.get(am.Plugin, PLUGIN) is not None


if __name__ == "__main__":
    asyncio.run(main())
