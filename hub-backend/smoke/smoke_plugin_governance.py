# -*- coding: utf-8 -*-
"""Plugin-governance overview tests for real schema, organization isolation, action queues, and
bounded queries.
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from sqlalchemy import event

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(BASE, ".smoke-plugin-governance.db")


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
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import plugin_governance  # noqa: E402


checks = 0


def ok(condition, message, extra=""):
    global checks
    if not condition:
        raise AssertionError(message + (": " + str(extra)[:400] if extra else ""))
    checks += 1


async def main():
    await init_db()
    now = datetime.now(timezone.utc)
    plugins = [
        am.Plugin(id="p-review", org_id="org-a", key="review", name="待审插件",
                  enabled=False, source_kind="codex"),
        am.Plugin(id="p-ready", org_id="org-a", key="ready", name="待绑定插件",
                  enabled=True, source_kind="soduwork"),
        am.Plugin(id="p-quality", org_id="org-a", key="quality", name="质量插件",
                  enabled=True, source_kind="claude"),
        am.Plugin(id="p-runtime", org_id="org-a", key="runtime", name="运行插件",
                  enabled=True, source_kind="soduwork"),
        am.Plugin(id="p-other", org_id="org-b", key="other", name="其他组织插件",
                  enabled=True, source_kind="soduwork"),
    ]
    versions = [
        am.PluginVersion(
            id="v-review", plugin_id="p-review", version="1.0.0", checksum="r",
            trust_state="quarantined", enabled=False,
            provenance={"signatureState": "unknown-key"}, created_at=now),
        am.PluginVersion(
            id="v-ready", plugin_id="p-ready", version="1.0.0", checksum="d",
            trust_state="approved", enabled=True,
            workflow={"nodes": [{"key": "work", "type": "ai"}]},
            capability_report={"hasWorkflow": True}, created_at=now),
        am.PluginVersion(
            id="v-quality-old", plugin_id="p-quality", version="0.9.0", checksum="qo",
            trust_state="approved", enabled=False, workflow={"nodes": []},
            capability_report={"hasWorkflow": False},
            created_at=now - timedelta(days=2)),
        am.PluginVersion(
            id="v-quality", plugin_id="p-quality", version="1.0.0", checksum="qn",
            trust_state="approved", enabled=True, workflow={"nodes": []},
            capability_report={"hasWorkflow": False}, created_at=now),
        am.PluginVersion(
            id="v-runtime", plugin_id="p-runtime", version="1.0.0", checksum="x",
            trust_state="approved", enabled=True, workflow={"nodes": []},
            capability_report={"hasWorkflow": False}, created_at=now),
        am.PluginVersion(
            id="v-other", plugin_id="p-other", version="1.0.0", checksum="o",
            trust_state="approved", enabled=True, workflow={"nodes": []},
            capability_report={"hasWorkflow": False}, created_at=now),
    ]
    evaluations = [
        am.PluginEvaluationRun(
            id="ev-old", plugin_id="p-quality", version_id="v-quality-old",
            case_key="acceptance", state="failed", verdict="failed",
            case_snapshot={"name": "旧版本验收"}, error="旧版本失败",
            created_at=now - timedelta(days=2)),
        am.PluginEvaluationRun(
            id="ev-current", plugin_id="p-quality", version_id="v-quality",
            case_key="acceptance", state="failed", verdict="failed",
            case_snapshot={"name": "当前版本验收"}, error="当前版本失败",
            created_at=now),
    ]
    runs = [
        am.WorkflowRun(
            id="run-fail", task_id="task-fail", plugin_id="p-runtime",
            plugin_version_id="v-runtime", state="failed", error="执行失败",
            created_at=now, finished_at=now, updated_at=now),
        am.WorkflowRun(
            id="run-ok", task_id="task-ok", plugin_id="p-runtime",
            plugin_version_id="v-runtime", state="succeeded",
            created_at=now, finished_at=now, updated_at=now),
    ]
    async with SessionLocal() as session:
        session.add_all(plugins + versions + evaluations + runs)
        await session.commit()

    selects = []

    def capture(_conn, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            selects.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", capture)
    try:
        async with SessionLocal() as session:
            result = await plugin_governance.overview(
                session, org_ids={"org-a"}, task_ids=None)
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", capture)

    ok(result["summary"]["total"] == 4,
       "治理总览必须按组织隔离插件", result["summary"])
    ok(result["summary"]["available"] == 3,
       "只有已信任且启用的最新版本才算可用", result["summary"])
    ok(result["counts"] == {
        "review": 1, "quality": 1, "dependency": 1,
        "runtime": 1, "revoked": 0,
    }, "五类治理队列分类不正确", result["counts"])
    ok(result["summary"]["attention"] == 4,
       "待处理总数必须等于动作队列总和", result["summary"])
    ok(result["summary"]["successRate"] == 50.0,
       "30 天成功率必须基于已决运行", result["summary"])
    ok(result["queues"]["quality"][0]["versionId"] == "v-quality"
       and "当前版本验收" in result["queues"]["quality"][0]["detail"],
       "旧版本失败不能污染当前版本治理队列", result["queues"]["quality"])
    ok(result["queues"]["dependency"][0]["pluginId"] == "p-ready",
       "已发布流程但没有绑定必须进入配置队列",
       result["queues"]["dependency"])
    ok(result["queues"]["runtime"][0]["runId"] == "run-fail",
       "运行失败必须能直达真实运行详情", result["queues"]["runtime"])
    ok(len(selects) <= 10,
       "治理总览查询数必须有界，不能随插件数量线性增长", len(selects))

    print(f"plugin governance: {checks} checks passed; {len(selects)} SELECTs")


try:
    asyncio.run(main())
finally:
    asyncio.run(engine.dispose())
    cleanup()
