# -*- coding: utf-8 -*-
"""Verify task.updated payloads preserve AI execution state through task_to_api_live, consistently
with list_tasks. Assert no invented state before dispatch, running after dispatch, and done
after output receipt. Use uniquely named fixtures and clean them up.
"""
import asyncio
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, ".")
ok = fail = 0


def chk(n, c, e=""):
    global ok, fail
    if c:
        ok += 1
        print("  PASS  " + n)
    else:
        fail += 1
        print("  FAIL  " + n + ("  << " + str(e)[:200] if e else ""))


CID = "u-smoke-taskai"
TID = "tsmoketaskai01"


async def main():
    from sqlalchemy import delete, select
    from app import automation_models as am, models
    from app.db import SessionLocal, init_db
    from app.services import ai_exec, dispatch_attempts, execution_sessions, task_rework
    from app.services.tasks import get_task, task_to_api, task_to_api_live

    await init_db()   # Create the temporary SQLite schema.

    async def _purge(s):
        session_ids = list((await s.execute(select(am.ExecutionSession.id).where(
            am.ExecutionSession.task_id == TID))).scalars())
        if session_ids:
            await s.execute(delete(am.ExecutionEvent).where(
                am.ExecutionEvent.session_id.in_(session_ids)))
        await s.execute(delete(am.ExecutionSession).where(am.ExecutionSession.task_id == TID))
        await s.execute(delete(am.ArtifactVersion).where(am.ArtifactVersion.task_id == TID))
        await s.execute(delete(models.TaskEvent).where(models.TaskEvent.task_id == TID))
        await s.execute(delete(models.Task).where(models.Task.id == TID))
        await s.execute(delete(models.Client).where(models.Client.id == CID))
        await s.commit()

    async with SessionLocal() as s:
        await _purge(s)   # Remove fixtures left by a previous run.
        s.add(models.Client(id=CID, name="（冒烟）task ai", secret="x"))
        s.add(models.Task(id=TID, title="（冒烟）AI 状态推送", owner_client_id=CID, status="doing"))
        await s.commit()
        t = await s.get(models.Task, TID)

        # Reproduce the baseline: plain task serialization omits AI state.
        base = task_to_api(t)
        chk("根因：task_to_api 本身不带 ai", "ai" not in base, list(base.keys())[:8])

        # Live serialization must not invent AI state before dispatch.
        live0 = await task_to_api_live(s, t)
        chk("没派活时 live 不带 ai（不无中生有）", "ai" not in live0, live0.get("ai"))

        # Persist dispatch intent and failure for restart recovery and in-place client retries.
        attempt_id = await dispatch_attempts.start(
            s, TID, "验收人", "runner:smoke:pi", "agent", "smoke-model")
        live_dispatching = await task_to_api_live(s, t)
        chk("★开始派活立即持久化 ai.state=dispatching",
            (live_dispatching.get("ai") or {}).get("state") == "dispatching",
            live_dispatching.get("ai"))
        failed_detail = await dispatch_attempts.failed(
            s, TID, "验收人", attempt_id, "routing", "没有在线 Runner",
            "runner:smoke:pi", {"cli": "pi", "name": "测试机 · Pi"})
        t = await s.get(models.Task, TID)  # failed() rolls back some dispatch writes and expires existing ORM objects.
        live_failed = await task_to_api_live(s, t)
        chk("★派活失败持久化真实阶段、原因和重试能力",
            (live_failed.get("ai") or {}).get("state") == "failed"
            and (live_failed.get("ai") or {}).get("phase") == "routing"
            and (live_failed.get("ai") or {}).get("error") == "没有在线 Runner"
            and failed_detail.get("retryable") is True,
            (live_failed.get("ai"), failed_detail))
        deep_link = await get_task(s, CID, TID)
        chk("★单任务详情与列表/推送共用失败状态，不等待整表刷新",
            (deep_link.get("ai") or {}).get("state") == "failed", deep_link.get("ai"))

        # A dispatch event produces live running state.
        ref = "local:smoke-direct-rework"
        dispatch_event = models.TaskEvent(
            task_id=TID, kind=ai_exec.KINDS_DISPATCHED[0],
            detail={"assigneeName": "测试机 · Pi", "ref": ref,
                    "provider": "local", "assigneeId": "local:pi"})
        s.add(dispatch_event)
        await s.commit()
        live1 = await task_to_api_live(s, t)
        chk("★修复：dispatched 后 live 带 ai.state=running",
            (live1.get("ai") or {}).get("state") == "running", live1.get("ai"))
        chk("★ai.name 取自事件 assigneeName",
            (live1.get("ai") or {}).get("name") == "测试机 · Pi", live1.get("ai"))
        chk("对照：task_to_api 仍不带 ai（所以推送必须换成 live）", "ai" not in task_to_api(t))

        # An output receipt produces live done state.
        s.add(models.TaskEvent(task_id=TID, kind=ai_exec.KINDS_ARTIFACTS[0], detail={}))
        await s.commit()
        live2 = await task_to_api_live(s, t)
        chk("产出回传后 live 带 ai.state=done",
            (live2.get("ai") or {}).get("state") == "done", live2.get("ai"))

        # After rejection, resume an ordinary direct task with the same reference to retain context.
        execution = am.ExecutionSession(task_id=TID, ref=ref, runner_id="backend-local",
                                        engine="pi", state="done")
        artifact = am.ArtifactVersion(
            id="av-smoke-direct-rework", task_id=TID, seq=1, kind="files",
            source_ref=ref, checksum="a" * 64, manifest={}, state="rejected")
        s.add_all([execution, artifact])
        await s.commit()
        dispatch_event.detail = {**dict(dispatch_event.detail or {}),
                                 "ref": "local:newer-unrelated-dispatch"}
        await s.commit()
        called = {}
        old_load, old_say = ai_exec.load, ai_exec.say_sync

        async def fake_load(_session, force=False):
            return {"name": "local", "cfg": {}, "localCfg": {}}

        def fake_say(_ctx, got_ref, text, *, message_id=""):
            called.update({"ref": got_ref, "text": text, "messageId": message_id})
            return {"ok": True, "queued": False}

        ai_exec.load, ai_exec.say_sync = fake_load, fake_say
        try:
            resumed = await task_rework.resume_after_rejection(
                s, t, "首页按钮仍然不能点击",
                artifact_version_id=artifact.id, request_id="ar-smoke-rework",
                actor="验收人")
        finally:
            ai_exec.load, ai_exec.say_sync = old_load, old_say
        await s.refresh(execution)
        rework_event = (await s.execute(select(models.TaskEvent).where(
            models.TaskEvent.task_id == TID,
            models.TaskEvent.kind == "ai.rework"
        ))).scalars().first()
        chk("★★固定版本引用优先于易歧义的最近派发记录，续跑原会话",
            resumed.get("started") is True and called.get("ref") == ref
            and "首页按钮仍然不能点击" in called.get("text", "")
            and called.get("messageId") == "rework:ar-smoke-rework", (resumed, called))
        chk("★★续跑立即回写执行中并留下审计事件",
            execution.state == "running" and execution.finished_at is None
            and int((execution.metadata_ or {}).get("round") or 0) == 2
            and execution_sessions.session_api(execution).get("round") == 2
            and rework_event is not None
            and (rework_event.detail or {}).get("requestId") == "ar-smoke-rework",
            (execution.state, rework_event.detail if rework_event else None))

        # Verify natural-language task parsing and sanitization without calling an LLM.
        from app.services.tasks import _extract_json, _sanitize_parsed
        chk("抠出 ```json 包裹的 JSON",
            _extract_json('好的\n```json\n{"title":"写周报"}\n```') == {"title": "写周报"})
        chk("前后带话也能抠出 JSON",
            _extract_json('这是结果：{"title":"改bug","priority":"high"} 就这样') == {"title": "改bug", "priority": "high"})
        sp = _sanitize_parsed({"title": "a" * 50, "note": "x", "priority": "high",
                               "kind": "routine", "due": "2026-08-08", "start": "2026-08-06",
                               "recur": "weekly", "remind": "2026-08-08 15:00",
                               "tags": ["前端", "安全", "", "x" * 30], "source": "老板",
                               "requester": "张三", "toAI": True})
        chk("★title 截到 20 字", len(sp["title"]) == 20)
        chk("★priority 合法放行", sp.get("priority") == "high")
        chk("★旧频率与业务类型分开", sp.get("cadence") == "routine" and "kind" not in sp and sp.get("recur") == "weekly")
        chk("★日期格式放行", sp.get("due") == "2026-08-08" and sp.get("start") == "2026-08-06")
        chk("★remind 空格转 T", sp.get("remind") == "2026-08-08T15:00")
        chk("★tags 去空+截断+限量", sp.get("tags") == ["前端", "安全", "x" * 16])
        chk("★toAI True 放行", sp.get("toAI") is True)
        bad = _sanitize_parsed({"priority": "URGENT", "kind": "xxx", "due": "明天",
                                "remind": "下午三点", "toAI": "yes", "junk": "drop"})
        chk("★非法枚举/日期/乱编字段全挡掉",
            all(k not in bad for k in ("priority", "kind", "due", "remind", "toAI", "junk")))

        await _purge(s)


async def isolated():
    try:
        await main()
    finally:
        from app.db import engine
        await engine.dispose()


with tempfile.TemporaryDirectory(prefix="soduwork-task-ai-") as directory:
    os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + (Path(directory) / ".smoke-taskai.db").as_posix()
    asyncio.run(isolated())
print(f"\n{ok} PASS / {fail} FAIL")
sys.exit(1 if fail else 0)
