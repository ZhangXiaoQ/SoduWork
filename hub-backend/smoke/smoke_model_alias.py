# -*- coding: utf-8 -*-
"""Test model renaming: remove old selector names, migrate current preferences, and retain
historical aliases.
"""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-model-alias.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from sqlalchemy import select  # noqa: E402

from app import models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import model_catalog as catalog  # noqa: E402

PID = "smoke-model-rename"
OLD = "smoke-agent-old"
NEW = "smoke-agent-new"
CID = "u-smoke-model-rename"
MID = "smoke-model-rename-milestone"
DONE_MID = "smoke-model-rename-done-milestone"
FLAG = "smoke_model_rename_20260825"

passed = failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print("  PASS ", name)
    else:
        failed += 1
        print("  FAIL ", name, detail)


async def purge(session):
    for milestone_id in (MID, DONE_MID):
        milestone = await session.get(models.Milestone, milestone_id)
        if milestone is not None:
            await session.delete(milestone)
    client = await session.get(models.Client, CID)
    if client is not None:
        await session.delete(client)
    for model_id in (PID + ":" + OLD, PID + ":" + NEW):
        row = await session.get(models.ModelDef, model_id)
        if row is not None:
            await session.delete(row)
    provider = await session.get(models.ModelProvider, PID)
    if provider is not None:
        await session.delete(provider)
    flag = await session.get(models.AppSetting, FLAG)
    if flag is not None:
        await session.delete(flag)
    await session.commit()


async def main():
    await init_db()
    async with SessionLocal() as session:
        await purge(session)
        session.add(models.ModelProvider(
            id=PID, name="冒烟模型服务", kind="openai-compat",
            base_url="https://smoke.invalid/v1", api_key="smoke-key",
            builtin=False, enabled=True,
        ))
        session.add(models.ModelDef(
            id=PID + ":" + OLD, provider_id=PID, name=OLD,
            label=OLD, builtin=False, enabled=True,
        ))
        session.add(models.Client(
            id=CID, name="模型改名冒烟", auth_state="active",
            agent_models={"pi": OLD, "opencode": "keep-me"},
            models=[{"providerId": PID, "name": OLD, "label": OLD}],
        ))
        session.add(models.Milestone(
            id=MID, task_id="smoke-model-rename-task", seq=0,
            title="模型改名冒烟", model=OLD,
        ))
        session.add(models.Milestone(
            id=DONE_MID, task_id="smoke-model-rename-task", seq=1,
            title="已办结模型改名冒烟", model=OLD, status="done",
        ))
        await session.commit()

        changed = await catalog._migrate_model_renames(
            session, [(PID, OLD, NEW)], FLAG)
        await session.commit()
        old_row = await session.get(models.ModelDef, PID + ":" + OLD)
        new_row = await session.get(models.ModelDef, PID + ":" + NEW)
        client = await session.get(models.Client, CID)
        milestone = await session.get(models.Milestone, MID)
        done_milestone = await session.get(models.Milestone, DONE_MID)
        check("创建新模型并停用旧模型",
              changed >= 4 and new_row is not None and new_row.enabled
              and old_row is not None and not old_row.enabled)
        check("Agent 当前偏好跟随新模型",
              client.agent_models == {"pi": NEW, "opencode": "keep-me"},
              client.agent_models)
        check("个人模型引用跟随新模型",
              client.models == [{"providerId": PID, "name": NEW, "label": NEW}],
              client.models)
        check("未完成里程碑覆盖跟随新模型", milestone.model == NEW, milestone.model)
        check("已办结里程碑保留历史模型", done_milestone.model == OLD,
              done_milestone.model)
        check("迁移有一次性标记", await session.get(models.AppSetting, FLAG) is not None)
        check("重复执行不再改数据",
              await catalog._migrate_model_renames(session, [(PID, OLD, NEW)], FLAG) == 0)
        check("产品旧模型名映射为 SoduWork 新名",
              catalog.canonical_model_name("dev-coding-large-agent-hugengyong")
              == "dev-coding-large-agent-soduwork")
        await purge(session)
    await engine.dispose()


asyncio.run(main())
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
print(f"PASS={passed} FAIL={failed}")
sys.exit(1 if failed else 0)
