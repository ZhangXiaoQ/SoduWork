# -*- coding: utf-8 -*-
"""Test unified session ingestion, idempotency, access scope, offline replay, and lost-dispatch
reconciliation.
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

DB = os.path.abspath(".smoke-execution-sessions.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import (ai_exec, ai_local, dispatch_attempts,  # noqa: E402
                          execution_sessions, execution_settlement,
                          tasks as task_service)

CID = "u-smoke-execution-session"
OTHER = "u-smoke-execution-other"
TID = "t-smoke-execution-session"
TID_DIRECT = "t-smoke-execution-direct-failure"
TID_RACE = "t-smoke-execution-race"
TID_QUEUE = "t-smoke-execution-queue"
REF = "ref-smoke-execution-session"
REF_DIRECT = "ref-smoke-execution-direct-failure"
REF_RACE = "ref-smoke-execution-race"
REF_QUEUE = "ref-smoke-execution-queue"
ok = fail = 0
lines = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        lines.append("  PASS  " + name)
    else:
        fail += 1
        lines.append("  FAIL  " + name + ("  << " + str(extra)[:400] if extra else ""))


class Runner:
    def __init__(self, client_id=CID):
        self.id = "runner-smoke-session"
        self.client_id = client_id
        self.host = "会话测试机"
        self.version = "1.8.7"
        self.boot_id = "boot-current"
        self.agents = [{"key": "pi", "name": "Pi", "version": "0.49.0"}]


async def purge():
    async with SessionLocal() as s:
        for task_id in (TID, TID_DIRECT, TID_RACE, TID_QUEUE):
            sessions = list((await s.execute(select(am.ExecutionSession).where(
                am.ExecutionSession.task_id == task_id))).scalars().all())
            for row in sessions:
                events = list((await s.execute(select(am.ExecutionEvent).where(
                    am.ExecutionEvent.session_id == row.id))).scalars().all())
                for event in events:
                    await s.delete(event)
                await s.delete(row)
            for event in list((await s.execute(select(models.TaskEvent).where(
                    models.TaskEvent.task_id == task_id))).scalars().all()):
                await s.delete(event)
            task = await s.get(models.Task, task_id)
            if task is not None:
                await s.delete(task)
        for cid in (CID, OTHER):
            client = await s.get(models.Client, cid)
            if client is not None:
                await s.delete(client)
        runner = await s.get(am.RunnerNode, "runner-smoke-session")
        if runner is not None:
            await s.delete(runner)
        await s.commit()


async def main():
    await init_db()
    await purge()
    async with SessionLocal() as s:
        s.add_all([models.Client(id=CID, secret="smoke"),
                   models.Client(id=OTHER, secret="smoke"),
                   models.Task(id=TID, title="统一执行会话冒烟", owner_client_id=CID),
                   models.Task(id=TID_DIRECT, title="直接派活失败冒烟",
                               owner_client_id=CID),
                   models.Task(id=TID_RACE, title="执行会话并发冒烟",
                               owner_client_id=CID),
                   models.Task(id=TID_QUEUE, title="排队重启恢复冒烟",
                               owner_client_id=CID)])
        await s.commit()
        task = await s.get(models.Task, TID)
        # Live reads resolve executor identity from the durable registry.
        s.add(am.RunnerNode(id="runner-smoke-session", client_id=CID,
                           auth_state="active"))
        await s.commit()
        await execution_sessions.record_dispatch(
            s, task, {"issueId": REF, "runnerId": "runner-smoke-session", "host": "会话测试机",
                      "agentCli": "pi", "agentCliName": "Pi", "agentCliVersion": "0.49.0",
                      "runnerVersion": "1.8.7", "model": "company/coder",
                      "assigneeId": "runner:runner-smoke-session:pi",
                      "selection": {"source": "scheduler",
                                    "reason": "任务归属人的在线客户端优先"},
                      "apiKey": "never-persist-this"},
            workflow_run_id="workflow-smoke", node_run_id="node-smoke")
        task.status = "doing"
        s.add(models.TaskEvent(
            task_id=TID,
            kind="ai.dispatched",
            actor="测试",
            detail={
                "ref": REF,
                "provider": "runner",
                "runnerId": "runner-smoke-session",
                "assigneeName": "会话测试机 · Pi",
            },
        ))

        await s.commit()
        linked = (await s.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.ref == REF))).scalars().one()
        chk("派活时精确关联工作流节点，后续证据不靠时间猜",
            linked.workflow_run_id == "workflow-smoke" and linked.node_run_id == "node-smoke",
            (linked.workflow_run_id, linked.node_run_id))
        identity = execution_sessions.session_api(linked)["identity"]
        chk("派活当刻冻结 Runner、Agent CLI、版本、模型与选择原因且不夹带密钥",
            identity.get("runnerVersion") == "1.8.7"
            and identity.get("agentCli") == "pi"
            and identity.get("agentVersion") == "0.49.0"
            and identity.get("model") == "company/coder"
            and identity.get("selectionSource") == "scheduler"
            and "never-persist-this" not in str(identity), identity)

        queued_task = await s.get(models.Task, TID_QUEUE)
        await execution_sessions.record_dispatch(s, queued_task, {
            "issueId": REF_QUEUE, "runnerId": "runner-smoke-session",
            "runnerBootId": "boot-original", "agentCli": "pi", "state": "queued",
            "queuePosition": 4, "queueClass": "task",
        })
        await s.commit()
        queued_row = (await s.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.ref == REF_QUEUE))).scalars().one()
        queued_view = execution_sessions.session_api(queued_row)
        chk("排队执行单保留队列位置并允许用户取消",
            queued_view.get("status") == "queued" and queued_view.get("queued") is True
            and queued_view.get("queuePosition") == 4 and queued_view.get("canStop") is True,
            queued_view)
        moved = await execution_sessions.ingest_live_snapshot(
            s, queued_task, REF_QUEUE, {
                "ok": True, "runnerId": "runner-smoke-session", "status": "queued",
                "queued": True, "queuePosition": 2, "queueClass": "task",
                "items": [], "seq": 0,
            })
        await s.commit()
        chk("排队位置随实时查询持续更新到公共执行组件",
            moved and moved.get("status") == "queued"
            and moved.get("queuePosition") == 2, moved)
        unknown = await execution_sessions.ingest_live_snapshot(
            s, queued_task, REF_QUEUE, {
                "ok": True, "runnerId": "unregistered-runner", "status": "queued",
                "queuePosition": 1, "items": [], "seq": 0,
            })
        chk("Unregistered runners cannot overwrite queue identity or position",
            unknown is None and execution_sessions.session_api(queued_row).get("queuePosition") == 2)
        same_process = Runner()
        same_process.boot_id = "boot-original"
        same_boot = await execution_sessions.reconcile_runner_restart(s, same_process)
        chk("Runner 仅断线重连时保留仍有效的内存队列", same_boot == [], same_boot)
        restarted = Runner()
        restarted.boot_id = "boot-new"
        recovered = await execution_sessions.reconcile_runner_restart(s, restarted)
        await s.commit()
        chk("Runner 进程重启后排队幽灵单收敛为可重试的中断态",
            len(recovered) == 1 and recovered[0]["session"]["status"] == "interrupted"
            and "重新安排执行" in recovered[0]["session"]["error"], recovered)

    inserted = asyncio.Event()

    async def dispatch_writer():
        async with SessionLocal() as s:
            task = await s.get(models.Task, TID_RACE)
            await execution_sessions.record_dispatch(s, task, {
                "issueId": REF_RACE, "runnerId": "runner-smoke-session",
                "assigneeId": "runner:runner-smoke-session:pi", "agentCli": "pi",
            })
            inserted.set()
            await asyncio.sleep(0.1)
            await s.commit()

    async def heartbeat_writer():
        await inserted.wait()
        async with SessionLocal() as s:
            await execution_sessions.ingest_runner_snapshots(s, Runner(), [{
                "ref": REF_RACE, "taskId": TID_RACE, "cli": "pi",
                "state": "running", "seq": 0, "items": [],
            }])
            await s.commit()

    await asyncio.gather(dispatch_writer(), heartbeat_writer())
    async with SessionLocal() as s:
        raced = list((await s.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.ref == REF_RACE))).scalars().all())
        chk("★派活事务与首个 Runner 心跳并发时只产生一条执行会话",
            len(raced) == 1 and raced[0].task_id == TID_RACE, raced)


    first = {
        "ref": REF, "taskId": TID, "cli": "pi", "state": "running", "seq": 2,
        "cliName": "Pi", "cliVersion": "0.49.0", "cliSessionId": "pi-session-001",
        "runnerVersion": "1.8.7", "model": "company/coder",
        "workDir": r"C:\tmp\smoke-session", "started": 1750000000,
        "items": [
            {"seq": 1, "kind": "step", "text": "正在分析", "at": "2026-08-02T10:00:00"},
            {"seq": 2, "kind": "do", "tool": "write", "text": "index.html",
             "at": "2026-08-02T10:00:01"},
        ],
    }
    async with SessionLocal() as s:
        changed = await execution_sessions.ingest_runner_snapshots(s, Runner(), [first])
        await s.commit()
        chk("首次上报建立会话", len(changed) == 1 and changed[0]["session"]["runnerId"] == Runner().id,
            changed)
        chk("Runner 首次实况补齐底座自己的 CLI 会话号",
            changed[0]["session"]["identity"].get("agentSessionId") == "pi-session-001",
            changed[0]["session"].get("identity"))

    second = {**first, "state": "completed", "seq": 3, "ended": 1750000010,
              "items": [first["items"][1],
                        {"seq": 3, "kind": "say", "text": "已经完成", "at": "2026-08-02T10:00:02"}]}
    async with SessionLocal() as s:
        first_terminal = await execution_sessions.ingest_runner_snapshots(s, Runner(), [second])
        duplicate_terminal = await execution_sessions.ingest_runner_snapshots(s, Runner(), [second])
        await s.commit()
        row = (await s.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.ref == REF))).scalars().one()
        count = (await s.execute(select(func.count(am.ExecutionEvent.id)).where(
            am.ExecutionEvent.session_id == row.id))).scalar() or 0
        chk("重复上报按序号幂等", count == 3, count)
        chk("旧成功终态归一后与执行位置一并留存", row.state == "done" and row.finished_at is not None
            and row.work_dir.endswith("smoke-session"), (row.state, row.finished_at, row.work_dir))
        chk("★终态未结算前重复心跳持续发出补偿信号，服务重启后不会漏收成果",
            first_terminal[0].get("settleTerminal") == "done"
            and duplicate_terminal[0].get("settleTerminal") == "done",
            (first_terminal, duplicate_terminal))
        states = await task_service.ai_states(s, [TID])
        chk("★任务 AI 状态以执行会话为准：文件尚未回流也不再谎称执行中",
            states[TID]["state"] == "done" and states[TID]["executionState"] == "done", states)
        replay = await execution_sessions.read_task(s, TID, REF, since=1)
        chk("离线回放只返回水位之后的事件",
            [x["seq"] for x in replay["items"]] == [2, 3] and replay["persisted"] is True, replay)
        summary = await execution_sessions.list_task(s, TID, event_limit=0)
        chk("轻量任务卡只取会话状态，不顺带搬运执行日志",
            len(summary["sessions"]) == 1 and summary["sessions"][0]["items"] == [], summary)

    async with SessionLocal() as s:
        row = (await s.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.ref == REF))).scalars().one()
        row.state = "failed"
        failed_meta = dict(row.metadata_ or {})
        failed_meta["error"] = "模型额度已耗尽"
        failed_meta.pop("terminalSettlement", None)
        row.metadata_ = failed_meta
        await s.commit()
        failed_states = await task_service.ai_states(s, [TID])
        failed_settlement = await execution_settlement.settle_terminal(s, TID, REF)
        failed_mark = dict((row.metadata_ or {}).get("terminalSettlement") or {})
        chk("★失败终态立即映射到任务卡并保留可理解的失败原因",
            failed_states[TID]["state"] == "failed"
            and failed_states[TID]["error"] == "模型额度已耗尽",
            failed_states)
        chk("★失败终态无需再问 Runner，结算事实可持久审计",
            failed_settlement.get("ok") and failed_mark.get("state") == "failed"
            and failed_mark.get("executionState") == "failed"
            and execution_sessions.session_api(row).get("error") == "模型额度已耗尽",
            (failed_settlement, failed_mark))
        chk("工作流执行终态返回持久化节点身份，事件驱动推进无需重新猜路由",
            failed_settlement.get("workflowTarget") == {
                "workflowRunId": "workflow-smoke", "nodeRunId": "node-smoke", "ref": REF},
            failed_settlement.get("workflowTarget"))
        row.state = "done"
        failed_meta.pop("error", None)
        failed_meta.pop("terminalSettlement", None)
        row.metadata_ = failed_meta
        await s.commit()

    async with SessionLocal() as s:
        direct = await s.get(models.Task, TID_DIRECT)
        direct.status = "doing"
        s.add(am.ExecutionSession(
            task_id=TID_DIRECT, ref=REF_DIRECT, state="failed",
            runner_id="runner-smoke-session", engine="pi",
            metadata_={"error": "CLI 初始化失败"}))
        s.add(models.TaskEvent(
            task_id=TID_DIRECT, kind=ai_exec.EV_DISPATCHED, actor="测试",
            detail={"ref": REF_DIRECT, "provider": "runner",
                    "runnerId": "runner-smoke-session",
                    "assigneeId": "runner:runner-smoke-session:pi",
                    "assigneeName": "会话测试机 · Pi"}))
        await s.commit()
        settled = await execution_settlement.settle_terminal(s, TID_DIRECT, REF_DIRECT)
        again = await execution_settlement.settle_terminal(s, TID_DIRECT, REF_DIRECT)
        direct = await s.get(models.Task, TID_DIRECT)
        failures = list((await s.execute(select(models.TaskEvent).where(
            models.TaskEvent.task_id == TID_DIRECT,
            models.TaskEvent.kind == ai_exec.EV_DISPATCH_FAILED
        ))).scalars().all())
        projected = await task_service.ai_states(s, [TID_DIRECT])
        retry_guard = await dispatch_attempts.existing(s, TID_DIRECT, direct.status)
        chk("★直接任务执行失败后退出进行中，并以失败态展示真实原因",
            direct.status == "todo"
            and projected[TID_DIRECT]["state"] == "failed"
            and projected[TID_DIRECT]["error"] == "CLI 初始化失败",
            (direct.status, projected))
        chk("★执行失败只记一笔可审计事件，重复结算幂等且允许重新派活",
            len(failures) == 1 and failures[0].detail.get("phase") == "execution"
            and failures[0].detail.get("retryable") is True
            and again.get("idempotent") is True and retry_guard is None,
            (len(failures), again, retry_guard))
        chk("★失败结算立即返回刷新后的任务快照",
            settled.get("task", {}).get("status") == "todo"
            and settled.get("task", {}).get("ai", {}).get("state") == "failed",
            settled)

        direct_session = (await s.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.ref == REF_DIRECT))).scalars().one()
        direct_view = execution_sessions.session_api(direct_session)
        chk("★失败且零事件的会话仍向详情页提供可解释原因",
            direct_view.get("error") == "CLI 初始化失败", direct_view)

        historical = am.ExecutionSession(
            task_id=TID_DIRECT, ref="ref-historical-empty-failure", state="failed",
            metadata_={"terminalSettlement": {"state": "failed", "error": "历史执行异常"}})
        chk("旧版只写在结算对象里的失败原因读取时兼容",
            execution_sessions.session_api(historical).get("error") == "历史执行异常",
            execution_sessions.session_api(historical))

    old_load = ai_exec.load
    old_status = ai_exec.status_sync
    old_pull = ai_exec.pull_artifacts
    settlement_calls = {"status": 0, "pull": 0, "settle": None}
    try:
        async def fake_load(_session):
            return {"provider": "runner"}

        def fake_status(_ctx, ref):
            settlement_calls["status"] += 1
            return {
                "ok": True,
                "done": True,
                "attachments": [{"id": "proof.txt", "filename": "proof.txt"}],
            }

        async def fake_pull(_session, task_id, _ctx, _status, ref, settle=True):
            settlement_calls["pull"] += 1
            settlement_calls["settle"] = settle
            return {"files": 1, "missing": [], "received": ["proof.txt"]}

        ai_exec.load = fake_load
        ai_exec.status_sync = fake_status
        ai_exec.pull_artifacts = fake_pull
        async with SessionLocal() as s:
            row = (await s.execute(select(am.ExecutionSession).where(
                am.ExecutionSession.ref == REF))).scalars().one()
            row.workflow_run_id = ""
            row.node_run_id = ""
            await s.commit()
            settled = await execution_settlement.settle_terminal(s, TID, REF)
            again = await execution_settlement.settle_terminal(s, TID, REF)
            row = (await s.execute(select(am.ExecutionSession).where(
                am.ExecutionSession.ref == REF))).scalars().one()
            mark = dict((row.metadata_ or {}).get("terminalSettlement") or {})
        chk("★终态主动结算立即拉成果并返回可实时推送的任务快照",
            settled.get("ok") and settled.get("task", {}).get("ai", {}).get("state") == "done"
            and settlement_calls == {"status": 1, "pull": 1, "settle": True},
            (settled, settlement_calls))
        chk("★终态结算持久幂等：重复回报不再调用 Runner 或重复挂附件",
            again.get("idempotent") is True and mark.get("state") == "done",
            (again, mark))
        async with SessionLocal() as s:
            after_settlement = await execution_sessions.ingest_runner_snapshots(
                s, Runner(), [second])
            await s.commit()
        chk("★结算标记落库后，后续心跳不再发出补偿信号",
            not after_settlement[0].get("settleTerminal"), after_settlement)
    finally:
        ai_exec.load = old_load
        ai_exec.status_sync = old_status
        ai_exec.pull_artifacts = old_pull

    async with SessionLocal() as s:
        rejected = await execution_sessions.ingest_runner_snapshots(
            s, Runner(OTHER), [{**first, "ref": "ref-not-allowed"}])
        await s.rollback()
        chk("别的个人 Runner 不能伪造这条任务的会话", rejected == [], rejected)

    async with SessionLocal() as s:
        legacy = am.ExecutionSession(task_id=TID, ref="ref-legacy-success",
                                     state="succeeded", runner_id="backend-local")
        s.add(legacy)
        await s.flush()
        view = execution_sessions.session_api(legacy)
        chk("历史成功状态读取时统一呈现为 done 且不可叫停",
            view["status"] == "done" and view["canStop"] is False, view)
        await s.rollback()

    old_info = ai_local.runner_info_sync
    try:
        ai_local.runner_info_sync = lambda _cfg, ref: (
            {"taskStatus": "done", "done": True, "workDir": r"C:\done"}
            if ref == "ref-local-done" else {})
        async with SessionLocal() as s:
            task = await s.get(models.Task, TID)
            await execution_sessions.record_dispatch(s, task, {
                "issueId": "ref-local-future", "provider": "local",
                "assigneeId": "local:pi", "assigneeCli": "Pi"})
            s.add_all([
                am.ExecutionSession(task_id=TID, ref="ref-local-legacy", state="running",
                                    engine="Pi"),
                am.ExecutionSession(task_id=TID, ref="ref-local-done", state="running",
                                    runner_id="backend-local", engine="Pi"),
                am.ExecutionSession(task_id=TID, ref="ref-hosted", state="running",
                                    engine="Hosted"),
                models.TaskEvent(task_id=TID, kind="ai.dispatched", actor="测试",
                                 detail={"ref": "ref-local-legacy", "provider": "local",
                                         "assigneeId": "local:pi"}),
                models.TaskEvent(task_id=TID, kind="ai.dispatched", actor="测试",
                                 detail={"ref": "ref-hosted", "provider": "multica"}),
            ])
            await s.commit()
            future = (await s.execute(select(am.ExecutionSession).where(
                am.ExecutionSession.ref == "ref-local-future"))).scalars().one()
            chk("新派的本机执行单带明确 backend-local 身份",
                future.runner_id == "backend-local" and future.runner_client_id == CID,
                (future.runner_id, future.runner_client_id))
            changed = await execution_sessions.reconcile_local_sessions(s)
            await s.commit()
            rows = {row.ref: row for row in list((await s.execute(
                select(am.ExecutionSession).where(am.ExecutionSession.task_id == TID)
            )).scalars().all())}
            chk("启动对账把没有存档的旧本机会话收敛为中断",
                rows["ref-local-legacy"].state == "interrupted"
                and rows["ref-local-future"].state == "interrupted", changed)
            chk("启动对账采用已认领存档的真实终态",
                rows["ref-local-done"].state == "done"
                and rows["ref-local-done"].finished_at is not None)
            chk("启动对账不误伤托管底座的旧执行单",
                rows["ref-hosted"].state == "running", rows["ref-hosted"].state)
    finally:
        ai_local.runner_info_sync = old_info

    # Regression: a runner can fail while reporting dispatch after starting a detached session.
    # A lazy-import failure in that receipt path must not leave the Hub task pending while the session runs.
    # Heartbeats must reconnect the task, record dispatch, and clamp future timestamps caused by timezone errors.
    heal_ref = "ref-smoke-heal"
    async with SessionLocal() as s:
        task = await s.get(models.Task, TID)
        task.status = "todo"
        s.add(models.TaskEvent(task_id=TID, kind="ai.dispatch_failed", actor="测试", detail={
            "error": "ModuleNotFoundError: No module named 'sqlalchemy'"}))
        await s.commit()
    future_at = (datetime.now(timezone.utc) + timedelta(hours=8)).isoformat()
    heal_snap = {"ref": heal_ref, "taskId": TID, "cli": "opencode", "state": "running",
                 "seq": 1, "workDir": r"D:\soduwork\temp", "started": 1750000100,
                 "runnerVersion": "1.8.8",
                 "items": [{"seq": 1, "kind": "step", "text": "开工", "at": future_at}]}
    async with SessionLocal() as s:
        changed = await execution_sessions.ingest_runner_snapshots(s, Runner(), [heal_snap])
        await s.commit()
        task = await s.get(models.Task, TID)
        healed = [e for e in (await s.execute(select(models.TaskEvent).where(
            models.TaskEvent.task_id == TID, models.TaskEvent.kind == "ai.dispatched"
        ))).scalars().all() if str((e.detail or {}).get("ref") or "") == heal_ref]
        chk("★派活回执丢失时，心跳按会话实况把任务接回进行中并随手推整条任务",
            task.status == "doing" and len(healed) == 1 and changed
            and (changed[0].get("task") or {}).get("status") == "doing",
            (task.status, len(healed), changed and list(changed[0])))
        chk("★接回的派活事件带 healed 标记与执行机版本（审计能看出这不是正常回执）",
            healed and healed[0].detail.get("healedFrom") == "session-heartbeat"
            and healed[0].detail.get("runnerVersion") == "1.8.8", healed and healed[0].detail)
        row = (await s.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.ref == heal_ref))).scalars().one()
        lea = row.last_event_at
        lea = lea if (lea is None or lea.tzinfo) else lea.replace(tzinfo=timezone.utc)
        chk("★未来时间戳被钳住：+8 小时时区错乱不再造出全天『正在执行』的僵尸",
            lea is not None and lea <= datetime.now(timezone.utc) + timedelta(minutes=3), lea)
    async with SessionLocal() as s:
        await execution_sessions.ingest_runner_snapshots(s, Runner(), [heal_snap])
        await s.commit()
        count = len([e for e in (await s.execute(select(models.TaskEvent).where(
            models.TaskEvent.task_id == TID, models.TaskEvent.kind == "ai.dispatched"
        ))).scalars().all() if str((e.detail or {}).get("ref") or "") == heal_ref])
        chk("★接回幂等：任务已在进行中，第二个心跳不再重复补记", count == 1, count)

    # Reconcile historical task/session divergence at startup even when a finished session sends no more heartbeats.
    # Verify batch recovery when the same receipt failure affects multiple runners.
    async with SessionLocal() as s:
        task = await s.get(models.Task, TID)
        task.status = "todo"
        later = datetime.now(timezone.utc) + timedelta(seconds=5)
        s.add_all([
            # Use explicitly ordered timestamps to prove reconciliation selects the latest session.
            am.ExecutionSession(task_id=TID, ref="ref-history-lost", state="done",
                                runner_id="runner-smoke-session", engine="opencode",
                                host="历史机器", created_at=later),
            am.ExecutionSession(task_id=TID, ref="ref-history-claimed", state="done",
                                runner_id="runner-smoke-session", engine="pi",
                                created_at=later - timedelta(seconds=1)),
            models.TaskEvent(task_id=TID, kind="ai.dispatched", actor="测试",
                             detail={"ref": "ref-history-claimed", "provider": "runner"}),
        ])
        await s.commit()
        healed = await execution_sessions.reconcile_lost_dispatches(s)
        await s.commit()
        task = await s.get(models.Task, TID)
        events = [e for e in (await s.execute(select(models.TaskEvent).where(
            models.TaskEvent.task_id == TID, models.TaskEvent.kind == "ai.dispatched"
        ))).scalars().all()]
        refs = {str((e.detail or {}).get("ref") or "") for e in events
                if (e.detail or {}).get("healedFrom")}
        chk("★启动对账接回历史脑裂任务（会话已终结、心跳救不了的那些）",
            healed >= 1 and task.status == "doing" and "ref-history-lost" in refs,
            (healed, task.status, refs))
        chk("★对账不碰已被正常派活事件认领的会话（不重复补记）",
            "ref-history-claimed" not in refs, refs)
        chk("★对账只接回进行中，绝不替交付判定说已完成", task.status == "doing", task.status)
    async with SessionLocal() as s:
        again = await execution_sessions.reconcile_lost_dispatches(s)
        await s.commit()
        chk("★对账幂等：任务已不在待办，再跑一次不改动任何东西", again == 0, again)

    await purge()
    async with SessionLocal() as s:
        chk("冒烟数据清理干净", await s.get(models.Task, TID) is None
            and await s.get(models.Task, TID_DIRECT) is None
            and await s.get(models.Task, TID_RACE) is None
            and await s.get(models.Client, CID) is None)
    print("\n".join(lines))
    print("\n%d 通过 / %d 失败" % (ok, fail))
    return 1 if fail else 0


async def guarded():
    try:
        return await main()
    finally:
        await purge()


if __name__ == "__main__":
    sys.exit(asyncio.run(guarded()))
