# -*- coding: utf-8 -*-
"""Enterprise plugin marketplace policy smoke; isolated DB, fully cleaned."""
from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile

import httpx
from fastapi import HTTPException
from sqlalchemy import delete, select

sys.path.insert(0, ".")
_TEMP = tempfile.TemporaryDirectory(prefix="soduwork-smoke-plugin-marketplace-")
DB = os.path.join(_TEMP.name, "test.db")
DATA = os.path.join(_TEMP.name, "data")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
shutil.rmtree(DATA, ignore_errors=True)
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
os.environ["SODUWORK_DATA_ROOT"] = DATA

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.services import (device_auth, plugin_marketplace,  # noqa: E402
                          plugin_service)

ORG = "o-plugin-marketplace"
USER = "u-plugin-marketplace"
SECOND_USER = "u-plugin-marketplace-second"
CLIENT = "c-plugin-marketplace"
SECOND_CLIENT = "c-plugin-marketplace-second"
PLUGIN = "plg-plugin-marketplace"
VERSION = "plv-plugin-marketplace"
BINDING = "plb-plugin-marketplace"
TOKENS = {}
ok = fail = 0


def chk(name, condition, extra=""):
    global ok, fail
    if condition:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:400] if extra else ""))


def headers(client_id=CLIENT):
    return {"Authorization": "Device " + TOKENS[client_id]}


async def purge():
    async with SessionLocal() as session:
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
            models.Client.id.in_((CLIENT, SECOND_CLIENT))))
        await session.execute(delete(models.User).where(
            models.User.id.in_((USER, SECOND_USER))))
        await session.execute(delete(models.OrgUnit).where(
            models.OrgUnit.id == ORG))
        await session.commit()


async def seed():
    async with SessionLocal() as session:
        session.add(models.OrgUnit(id=ORG, name="目录策略测试组织"))
        session.add_all([
            models.User(id=USER, username="marketplace-user",
                        display_name="目录员工", org_id=ORG, is_active=True),
            models.User(id=SECOND_USER, username="marketplace-user-second",
                        display_name="新员工", org_id=ORG, is_active=True),
        ])
        session.add_all([
            models.Client(id=CLIENT, name="目录员工终端",
                          auth_state="active", user_ref=USER),
            models.Client(id=SECOND_CLIENT, name="新员工终端",
                          auth_state="active", user_ref=SECOND_USER),
        ])
        session.add(am.Plugin(
            id=PLUGIN, org_id=ORG, key="marketplace-policy",
            name="企业连接能力", description="验证目录分发策略",
            enabled=True, source_kind="soduwork"))
        session.add(am.PluginVersion(
            id=VERSION, plugin_id=PLUGIN, version="1.0.0",
            checksum="marketplace-policy-v1",
            manifest={
                "name": "企业连接能力",
                "entrypoints": {
                    "conversation": True, "task": True, "automation": False,
                },
            },
            workflow={},
            capability_report={
                "hasWorkflow": False, "executionMode": "direct",
                "skills": [],
                "mcpServers": ["missing-company-connection"],
                "runtime": [], "network": True,
            },
            trust_state="approved", visibility="organization", enabled=True))
        session.add(am.PluginBinding(
            id=BINDING, plugin_id=PLUGIN, version_id=VERSION,
            org_id=ORG, enabled=True))
        await session.commit()
        for client_id in (CLIENT, SECOND_CLIENT):
            row = await session.get(models.Client, client_id)
            TOKENS[client_id] = device_auth.issue_session(row)[0]


async def set_policy(**values):
    async with SessionLocal() as session:
        return plugin_marketplace.public_policy(
            await plugin_marketplace.upsert(
                session, PLUGIN, values, "marketplace-admin"))


async def main():
    await init_db()
    await purge()
    await seed()
    # OpenAPI expands included routers on both eager and lazy FastAPI versions.
    routes = {(path, frozenset(method.upper() for method in operations))
              for path, operations in app.openapi()["paths"].items()}
    chk("管理端暴露独立的员工目录策略接口",
        any(path == "/api/v1/admin/plugins/{plugin_id}/catalog-policy"
            and "PATCH" in methods for path, methods in routes))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
            transport=transport, base_url="http://test", timeout=30) as client:
        initial = await client.get("/api/v1/plugins/catalog", headers=headers())
        item = initial.json()["items"][0]
        chk("未配置目录政策时保持员工按需安装",
            initial.status_code == 200
            and item["marketPolicy"]["configured"] is False
            and item["installationState"] == "available"
            and item["conversationUse"]["code"] == "install_required"
            and item["dependencyReadiness"]["ok"] is False
            and item["dependencyReadiness"]["missingMcp"]
                == ["missing-company-connection"], initial.text)

        policy = await set_policy(
            category="connector", installation="installed_by_default",
            authentication="on_use", featured=True, sort=-10)
        automatic = await client.get("/api/v1/plugins/catalog", headers=headers())
        item = automatic.json()["items"][0]
        chk("企业默认策略为首次使用的员工安装当前不可变版本",
            policy["configured"] is True and item["installed"] is True
            and item["installedVersion"] == "1.0.0"
            and item["installationState"] == "default"
            and item["conversationUse"]["code"] == "connection_required",
            automatic.text)

        disabled = await client.put(
            f"/api/v1/plugins/{PLUGIN}/installation",
            headers=headers(), json={"enabled": False})
        again = await client.get("/api/v1/plugins/catalog", headers=headers())
        item = again.json()["items"][0]
        chk("员工明确停用后企业默认策略不会强行恢复",
            disabled.status_code == 200 and item["installed"] is False
            and item["installationState"] == "default_disabled", again.text)

        await set_policy(
            category="connector", installation="installed_by_default",
            authentication="on_install", featured=True, sort=-10)
        blocked_default = await client.get(
            "/api/v1/plugins/catalog", headers=headers(SECOND_CLIENT))
        blocked_default_chat = await client.post(
            "/api/v1/plugins/conversation-context", headers=headers(SECOND_CLIENT),
            json={"pluginIds": [PLUGIN], "conversationId": "blocked-default"})
        blocked_item = blocked_default.json()["items"][0]
        chk("企业默认安装同样服从安装时连接检查",
            blocked_item["installed"] is False
            and blocked_item["installationState"] == "default_blocked"
            and blocked_item["dependencyReadiness"]["missingMcp"]
                == ["missing-company-connection"]
            and blocked_default_chat.status_code == 409
            and "missing-company-connection" in blocked_default_chat.text,
            (blocked_default.text, blocked_default_chat.text))
        await set_policy(
            category="connector", installation="installed_by_default",
            authentication="on_use", featured=True, sort=-10)
        newcomer, newcomer_parallel = await asyncio.gather(*[
            client.get("/api/v1/plugins/catalog", headers=headers(SECOND_CLIENT))
            for _ in range(2)])
        second_item = newcomer.json()["items"][0]
        chk("以后首次进入目录的新员工仍会得到企业默认插件",
            newcomer_parallel.status_code == 200 and second_item["installed"] is True
            and second_item["installationState"] == "default", newcomer.text)

        await set_policy(
            category="connector", installation="not_available",
            authentication="on_use", featured=False, sort=0)
        task_only = await client.get("/api/v1/plugins/catalog", headers=headers())
        item = task_only.json()["items"][0]
        blocked_install = await client.put(
            f"/api/v1/plugins/{PLUGIN}/installation",
            headers=headers(), json={"enabled": True, "expectedVersionId": VERSION})
        blocked_chat = await client.post(
            "/api/v1/plugins/conversation-context", headers=headers(),
            json={"pluginIds": [PLUGIN], "conversationId": "task-only"})
        chk("任务专用策略会立即从个人对话工具箱移除",
            item["installed"] is False and item["installationState"] == "task_only"
            and item["conversationUse"]["code"] == "task_only",
            task_only.text)
        chk("任务专用插件不能通过安装接口或旧安装态绕过",
            blocked_install.status_code == 409
            and blocked_chat.status_code == 409
            and "受控需求" in blocked_chat.text,
            (blocked_install.text, blocked_chat.text))
        async with SessionLocal() as session:
            task = type("TaskView", (), {
                "owner_client_id": CLIENT, "project_id": None, "repo_id": None,
            })()
            choices = await plugin_service.available_bindings(session, task)
        chk("个人安装政策不影响任务和自动化绑定",
            len(choices) == 1 and choices[0]["bindingId"] == BINDING, choices)

        await set_policy(
            category="connector", installation="available",
            authentication="on_install", featured=False, sort=0)
        manual_blocked = await client.get(
            "/api/v1/plugins/catalog", headers=headers())
        manual_item = manual_blocked.json()["items"][0]
        missing = await client.put(
            f"/api/v1/plugins/{PLUGIN}/installation",
            headers=headers(), json={"enabled": True, "expectedVersionId": VERSION})
        chk("目录会在点击安装前展示精确的连接阻断原因",
            manual_item["installationState"] == "blocked"
            and manual_item["dependencyReadiness"]["missingMcp"]
                == ["missing-company-connection"], manual_blocked.text)
        chk("安装时认证策略会在进入个人工具箱前检查企业连接",
            missing.status_code == 409 and "missing-company-connection" in missing.text,
            missing.text)

        await set_policy(
            category="connector", installation="available",
            authentication="on_use", featured=False, sort=0)
        lazy_install = await client.put(
            f"/api/v1/plugins/{PLUGIN}/installation",
            headers=headers(), json={"enabled": True, "expectedVersionId": VERSION})
        lazy_catalog = await client.get(
            "/api/v1/plugins/catalog", headers=headers())
        lazy_item = lazy_catalog.json()["items"][0]
        lazy_use = await client.post(
            "/api/v1/plugins/conversation-grant", headers=headers(),
            json={"pluginIds": [PLUGIN], "conversationId": "on-use"})
        chk("使用时认证允许先安装但在真实调用前仍会阻止缺失连接",
            lazy_install.status_code == 200 and lazy_use.status_code == 409
            and lazy_item["installed"] is True
            and lazy_item["dependencyReadiness"]["ok"] is False
            and "missing-company-connection" in lazy_use.text,
            (lazy_install.text, lazy_catalog.text, lazy_use.text))

    async with SessionLocal() as session:
        import io
        from starlette.datastructures import UploadFile
        from app.api import plugins as plugin_api
        from app.services import plugin_starter
        user = await session.get(models.User, USER)
        package = plugin_starter.build()
        denied = await plugin_api.bulk_import_plugins(
            [UploadFile(file=io.BytesIO(package), filename="external.soduwork-plugin")],
            False, "外部市场", user, session)
        chk("没有许可证或企业导入授权的外部包不会入库",
            denied["imported"] == 0 and denied["failed"] == 1
            and "rights" in denied["items"][0]["error"].lower(),
            denied)
        accepted = await plugin_api.bulk_import_plugins(
            [UploadFile(file=io.BytesIO(package), filename="owned.soduwork-plugin")],
            True, "企业自有插件库", user, session)
        imported_version = (
            await session.get(am.PluginVersion, accepted["items"][0]["versionId"])
            if accepted["imported"] == 1 else None)
        chk("确认拥有导入权后可批量入库但不会绕过管理员审核上架",
            accepted["imported"] == 1 and accepted["failed"] == 0
            and imported_version is not None
            and imported_version.trust_state == "quarantined"
            and imported_version.enabled is False,
            accepted)

    async with SessionLocal() as session:
        defaults = await plugin_marketplace.categories(
            session, include_disabled=True)
        configured = await plugin_marketplace.replace_categories(
            session, defaults + [{
                "key": "knowledge", "name": "企业知识",
                "description": "企业知识与研究", "sort": 15, "enabled": True,
            }], "marketplace-admin")
        policy = plugin_marketplace.public_policy(
            await plugin_marketplace.upsert(
                session, PLUGIN, {"category": "knowledge"},
                "marketplace-admin"))
        catalog_with_custom_category = await plugin_service.client_catalog(
            session, ORG, USER, USER, visible_org_ids={ORG})
        chk("后台可配置员工插件分类并供目录策略立即使用",
            any(item["key"] == "knowledge" and item["name"] == "企业知识"
                for item in configured)
            and policy["category"] == "knowledge"
            and any(item["key"] == "knowledge"
                    and item["name"] == "企业知识"
                    for item in catalog_with_custom_category["categories"]),
            (configured, policy, catalog_with_custom_category["categories"]))
        disabled_configured = await plugin_marketplace.replace_categories(
            session, [dict(item, enabled=False) if item["key"] == "knowledge" else item
                      for item in configured], "marketplace-admin")
        catalog_with_disabled_category = await plugin_service.client_catalog(
            session, ORG, USER, USER, visible_org_ids={ORG})
        preserved = plugin_marketplace.public_policy(
            await plugin_marketplace.upsert(
                session, PLUGIN, {"featured": True}, "marketplace-admin"))
        chk("disabled categories keep existing policies editable",
            any(item["key"] == "knowledge" and not item["enabled"]
                for item in disabled_configured)
            and preserved["category"] == "knowledge"
            and preserved["featured"] is True
            and any(item["key"] == "knowledge"
                    and not item["enabled"]
                    for item in catalog_with_disabled_category["categories"]),
            (disabled_configured, preserved,
             catalog_with_disabled_category["categories"]))
        protected = False
        try:
            await plugin_marketplace.replace_categories(
                session, defaults, "marketplace-admin")
        except ValueError:
            protected = True
        chk("正在使用的分类只能停用不能直接删除", protected)

    async with SessionLocal() as session:
        version = await session.get(am.PluginVersion, VERSION)
        version.trust_state = "quarantined"
        version.enabled = False
        await session.commit()
        user = await session.get(models.User, USER)
        approved = await plugin_api.trust_version(
            VERSION, {"enabled": True, "note": "企业内部审核"},
            user, session)
    chk("企业内部插件无需发布评测即可由管理员审核上架",
            approved["trustState"] == "approved"
            and approved["enabled"] is True,
            approved)

    async with SessionLocal() as session:
        user = await session.get(models.User, USER)
        await plugin_marketplace.upsert(
            session, PLUGIN, {"installation": "not_available"}, "marketplace-admin")
        blocked_delete = False
        try:
            from app.api import plugins as plugin_api
            await plugin_api.delete_plugin(PLUGIN, user, session)
        except HTTPException as exc:
            blocked_delete = exc.status_code == 409 and (
                "已审核启用" in str(exc.detail) or "绑定" in str(exc.detail))
        except Exception as exc:
            blocked_delete = "已审核启用" in str(exc) or "绑定" in str(exc)
        chk("已下架但仍有启用版本或绑定时拒绝删除", blocked_delete)
        binding = await session.get(am.PluginBinding, BINDING)
        if binding:
            binding.enabled = False
        version = await session.get(am.PluginVersion, VERSION)
        if version:
            await plugin_service.approve_version(session, version, False, "smoke")
        installs = list((await session.execute(select(am.PluginInstallation).where(
            am.PluginInstallation.plugin_id == PLUGIN))).scalars().all())
        for install in installs:
            install.enabled = False
        await session.commit()
        deleted = await plugin_api.delete_plugin(PLUGIN, user, session)
        remaining = await session.get(am.Plugin, PLUGIN)
        chk("下架且没有运行引用时可以删除插件及版本", deleted.get("ok") and remaining is None,
            deleted)

    rejected = False
    async with SessionLocal() as session:
        try:
            await plugin_marketplace.upsert(
                session, PLUGIN, {"installation": "force_everyone"}, "bad-admin")
        except ValueError:
            rejected = True
    chk("服务端拒绝未知目录策略而不是静默降级", rejected)


async def guarded():
    try:
        await main()
    finally:
        await purge()
        await engine.dispose()


asyncio.run(guarded())
print("PASS=%d FAIL=%d" % (ok, fail))
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
shutil.rmtree(DATA, ignore_errors=True)
sys.exit(1 if fail else 0)
