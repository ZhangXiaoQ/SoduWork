# -*- coding: utf-8 -*-
"""Regression checks for public module contracts."""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-tasktrace.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from datetime import datetime, timedelta, timezone  # noqa: E402

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.realtime import hub as realtime_hub  # noqa: E402
from app.services import deployments, task_execution_contract, task_trace  # noqa: E402

ok = fail = 0
SHA = "b1e7297a3c4d5e6f70819a2b3c4d5e6f70819a2b"
T0 = datetime(2026, 8, 5, 12, 0, 0, tzinfo=timezone.utc)


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:260] if extra else ""))


def at(minutes: int) -> datetime:
    return T0 + timedelta(minutes=minutes)


WORKFLOW = {"nodes": [
    {"key": "implement", "type": "ai", "name": "修改并推送评审",
     "outputs": [{"key": "code", "kind": "git", "required": True}]},
    {"key": "quality", "type": "quality", "name": "推送前工程门禁", "dependsOn": ["implement"]},
    {"key": "review", "type": "ai_review", "name": "AI 评审并投票", "dependsOn": ["quality"]},
    {"key": "merge", "type": "merge", "name": "合并进目标分支", "dependsOn": ["review"]},
    {"key": "publish", "type": "publish", "name": "建版本并部署", "dependsOn": ["merge"]},
    {"key": "verify", "type": "validate", "name": "核对上线事实",
     "dependsOn": ["publish", "merge"]},
]}


async def seed():
    async with SessionLocal() as s:
        s.add(models.Client(id="c-tt", name="桌宠", user_ref="u-tt"))
        s.add(models.Project(id="p-tt", name="生产数据分析", owner_user_id="u-tt"))
        s.add(models.Repo(id="r-tt", project_id="p-tt", name="分析服务", scm="gerrit",
                          git_url="http://gerrit/a/svc", gerrit_base="http://gerrit",
                          default_branch="develop", merge_branch="develop"))
        s.add(models.Task(id="t-tt", title="修一个真 bug", status="doing",
                          owner_client_id="c-tt", project_id="p-tt", repo_id="r-tt"))
        s.add(am.Plugin(id="pl-tt", key="gerrit-autopilot", name="Gerrit 全自动交付"))
        s.add(am.PluginVersion(id="pv-tt", plugin_id="pl-tt", version="1.0.0", checksum="x",
                               trust_state="approved", enabled=True, workflow=WORKFLOW))
        s.add(am.WorkflowRun(id="run-tt", task_id="t-tt", plugin_id="pl-tt",
                             plugin_version_id="pv-tt", binding_id="b-tt", state="running",
                             current_nodes=["publish"], created_at=at(0)))
        # Create five stages: three succeeded, one running, and one pending.
        s.add(am.NodeRun(id="n-imp", run_id="run-tt", node_key="implement", node_type="ai",
                         attempt=1, state="succeeded", idempotency_key="k1",
                         started_at=at(1), finished_at=at(9),
                         executor={"kind": "ai", "ref": "ref-1", "provider": "runner",
                                   "assignee": "张三办公电脑 · Codex"},
                         output={"gitBranch": "fix/t-tt", "gitHead": SHA,
                                 "outputReceipt": {"missing": []}}))
        s.add(am.NodeRun(id="n-qa", run_id="run-tt", node_key="quality", node_type="quality",
                         attempt=1, state="succeeded", idempotency_key="k2",
                         started_at=at(10), finished_at=at(12),
                         output={"state": "succeeded", "commit": SHA, "checks": [
                             {"name": "Git 差异完整性", "ok": True, "detail": "exit=0"}],
                             "log": "everything up to date"}))
        s.add(am.NodeRun(id="n-rv", run_id="run-tt", node_key="review", node_type="ai_review",
                         attempt=1, state="succeeded", idempotency_key="k3",
                         started_at=at(13), finished_at=at(20),
                         output={"change": 168488, "patchset": 2, "verdict": "pass", "vote": 2,
                                 "summary": "改动最小、验收覆盖", "reportChecksum": "abc123def456",
                                 "attachmentId": "att-review"}))
        s.add(am.NodeRun(id="n-mg", run_id="run-tt", node_key="merge", node_type="merge",
                         attempt=1, state="succeeded", idempotency_key="k4",
                         started_at=at(21), finished_at=at(24),
                         output={"stage": "merged", "commit": SHA, "target": "develop",
                                 "submitted": True}))
        s.add(am.NodeRun(id="n-pb", run_id="run-tt", node_key="publish", node_type="publish",
                         attempt=1, state="running", idempotency_key="k5", started_at=at(25)))
        # Bind a report outside the time window by node_run_id; user-uploaded images remain task inputs.
        s.add(models.Attachment(id="att-review", task_id="t-tt", filename="code-review.json",
                                content_type="application/json", size=812,
                                storage_key="k", backend="local", uploaded_by="agent:SoduWork",
                                role="verification", source_ref="ref-1",
                                workflow_run_id="run-tt", node_run_id="n-rv",
                                evidence_meta={"kind": "code_review"}, created_at=at(40)))
        s.add(models.Attachment(id="att-shot", task_id="t-tt", filename="现象.png",
                                content_type="image/png", size=2048,
                                storage_key="k2", backend="local", uploaded_by="c-tt",
                                role="input", created_at=at(19)))
        # Persisted AI sessions must replay planning and execution steps even when the Runner is offline.
        s.add(am.ExecutionSession(id="es-tt", task_id="t-tt", workflow_run_id="run-tt",
                                  node_run_id="n-imp", ref="ref-1", runner_id="fedcba987654",
                                  host="DESKTOP-FIXTURE", engine="codex", model="company/code",
                                  state="done", seq=2, work_dir=r"C:\work\t-tt",
                                  started_at=at(1), finished_at=at(9)))
        s.add(am.ExecutionEvent(session_id="es-tt", seq=1, kind="step", text="分析需求并规划三步",
                                at=at(2)))
        s.add(am.ExecutionEvent(session_id="es-tt", seq=2, kind="do", tool="git",
                                text="提交修复分支", at=at(8)))
        # Create the human approval and its decision.
        s.add(am.ArtifactVersion(id="av-tt", task_id="t-tt", kind="code", seq=1, checksum="cs",
                                 commit_sha=SHA, state="reviewed",
                                 manifest={"aiReview": {"verdict": "pass", "summary": "通过",
                                                        "reportChecksum": "abc123def456"}}))
        s.add(am.ApprovalRequest(id="ar-tt", task_id="t-tt", artifact_version_id="av-tt",
                                 action="merge", status="approved", policy_id="p",
                                 required_count=1,
                                 policy_snapshot={"criteria": ["AI 审查通过", "质量门禁通过"]},
                                 context={"node": "merge"}, created_at=at(22)))
        s.add(am.ApprovalDecision(id="ad-tt", request_id="ar-tt", user_id="u-tt",
                                  user_name="张三", decision="approve", note="看过评审报告",
                                  created_at=at(23)))
        # Create a release record for the company CI/CD route.
        s.add(am.Environment(id="env-tt", key="pre", name="预发环境", enabled=True))
        s.add(am.DeploymentTarget(id="tg-tt", repo_id="r-tt", environment_id="env-tt",
                                  name="示例 CI/CD · 预发", provider="cicd-mcp",
                                  config={"customer": "示例客户测试环境"}))
        s.add(am.DeploymentRun(id="dr-tt", task_id="t-tt", artifact_version_id="av-tt",
                               environment_id="env-tt", target_id="tg-tt", state="running",
                               attempt=1, idempotency_key="dk", commit_sha=SHA,
                               result={"provider": "cicd-mcp", "stage": "submitted",
                                       "customer": "示例客户测试环境",
                                       "expectSha": SHA}))
        # Create timeline and AI dispatch events.
        s.add(models.TaskEvent(task_id="t-tt", kind="ai.dispatched", actor="SoduWork 插件", at=at(1),
                               detail={"ref": "ref-1", "assigneeName": "胡耕永办公电脑 · Codex",
                                       "provider": "runner", "runnerId": "532786f4df13",
                                       "host": "DESKTOP-C28C287",
                                       "plugin": {"runId": "run-tt", "node": "implement"}}))
        s.add(models.TaskEvent(task_id="t-tt", kind="plugin.gerrit_merged", actor="SoduWork AI",
                               at=at(24), detail={"change": 168488, "commit": SHA}))
        await s.commit()


async def main():
    await init_db()
    text_evidence = task_execution_contract.node_evidence({
        "id": "n-text", "type": "ai", "state": "succeeded",
        "output": {"outputReceipt": {"text": "final office result", "missing": []}},
    }, [])
    chk("text deliverable is visible as passed output evidence",
        any(item.get("meta", {}).get("type") == "text_result"
            and item.get("verification", {}).get("state") == "passed"
            and item.get("summary") == "final office result" for item in text_evidence),
        text_evidence)
    await seed()
    async with SessionLocal() as s:
        task = await s.get(models.Task, "t-tt")
        card = await task_trace.card(s, task)
        full = await task_trace.trace(s, task)

    # Verify the card shared by all three entry points.
    chk("★卡片说得清「卡在哪一关」（当前在跑的那一关，不是最后一条记录）",
        card["stage"]["key"] == "publish" and card["stage"]["name"] == "建版本并部署"
        and card["stage"]["state"] == "running", card["stage"])
    chk("★进度按插件声明的关数算（跑一关开一关，不能显示 4/4 像马上完）",
        card["progress"] == {"done": 4, "total": 6}, card["progress"])
    chk("★卡片带谁在干（执行器/执行机），审批时也就看得见 AI 是谁",
        "Codex" in str(card.get("executor") or {}) or card["aiSessions"] == 1,
        (card.get("executor"), card.get("aiSessions")))
    chk("卡片带工程与流程名，点进去之前就知道是什么活",
        card["projectName"] == "生产数据分析" and card["repoName"] == "分析服务"
        and card["pluginName"] == "Gerrit 全自动交付", card)
    chk("★能点什么写在卡片上：在跑 → 可结束；没失败的关 → 不给重试",
        card["canCancel"] is True and card["canRetry"] is False, card)

    # Verify per-stage details and evidence.
    nodes = {x["key"]: x for x in full["runs"][0]["nodes"]}
    chk("六关的定义都在（还没开跑的关也要能看见，否则看不出后面还有什么）",
        len(full["runs"][0]["workflow"]) == 6 and len(nodes) == 5, list(nodes))
    ev_rv = {(x["kind"], x["title"]) for x in nodes["review"]["evidence"]}
    chk("★评审关的证据：报告附件 + 结论 + 投票 + 报告指纹，全归到这一关",
        ("file", "code-review.json") in ev_rv and ("text", "评审结论") in ev_rv
        and ("text", "评审投票") in ev_rv and ("text", "评审报告指纹") in ev_rv, ev_rv)
    chk("★证据按节点精确归属：时间窗外的报告仍在，人传输入图不会误挂到评审关",
        any(x["title"] == "code-review.json" for x in nodes["review"]["evidence"])
        and not any(x["title"] == "现象.png" for x in nodes["review"]["evidence"]))
    chk("质检关的证据是逐条检查 + 日志尾巴",
        any(x["kind"] == "check" for x in nodes["quality"]["evidence"])
        and any(x["kind"] == "log" for x in nodes["quality"]["evidence"]),
        nodes["quality"]["evidence"])
    chk("开发关的证据是代码提交（分支 + commit）",
        any(x["kind"] == "commit" and SHA[:12] in x["value"]
            for x in nodes["implement"]["evidence"]), nodes["implement"]["evidence"])
    chk("合并关的证据带合并版本与目标分支",
        {("text", "合并版本"), ("text", "目标分支")} <=
        {(x["kind"], x["title"]) for x in nodes["merge"]["evidence"]},
        nodes["merge"]["evidence"])
    chk("每一关都报证据条数（前端能显示证据齐全度）",
        all(isinstance(x.get("evidenceCount"), int) for x in nodes.values()))

    # Verify approvals, AI sessions, releases, versions, and timeline.
    chk("★审批票与决定都在（审批中心那张卡要的就是这份）",
        len(full["approvals"]) == 1 and full["approvals"][0]["action"] == "merge"
        and full["approvals"][0]["decisions"][0]["userName"] == "张三",
        full["approvals"])
    chk("★AI 会话可追（ref/执行器/执行机/属于哪个流程节点）",
        len(full["ai"]) == 1 and full["ai"][0]["ref"] == "ref-1"
        and full["ai"][0]["plugin"].get("node") == "implement", full["ai"])
    chk("★持久化会话进入对应执行阶段，Runner 离线也能回放步骤与工作目录",
        full["stages"][0]["sessions"][0]["items"][0]["text"] == "分析需求并规划三步"
        and full["stages"][0]["sessions"][0]["workDir"].endswith("t-tt"), full["stages"][0])
    dep = (full["deployments"] or [{}])[0]
    chk("★发布记录带**通路**（一眼看出走的是公司 CICD 还是 trial 就地部署）",
        dep.get("provider") == "cicd-mcp" and "公司 CICD" in str(dep.get("channel")), dep)
    chk("发布记录带提交时就落盘的那份事实（重启后也能凭它核对）",
        (dep.get("result") or {}).get("stage") == "submitted"
        and (dep.get("result") or {}).get("expectSha") == SHA, dep.get("result"))
    pushed = []

    async def fake_publish(device, event, *, user_id=None):
        pushed.append((device, event))

    old_publish = realtime_hub.publish
    realtime_hub.publish = fake_publish
    try:
        async with SessionLocal() as s:
            deployment = await s.get(am.DeploymentRun, "dr-tt")
            deployment.result = {**dict(deployment.result or {}), "checksPlanned": 2, "checks": [
                {"name": "首页可访问", "type": "http", "ok": True,
                 "detail": "GET → HTTP 200"},
            ]}
            await s.commit()
            await deployments._publish_update(s, deployment)
    finally:
        realtime_hub.publish = old_publish
    pushed_deployment = ((pushed[0][1] if pushed else {}).get("deployment") or {})
    chk("★发布检查变化通过统一实时协议推给任务归属客户端",
        pushed and pushed[0][0] == "c-tt"
        and pushed[0][1].get("type") == "execution.updated"
        and pushed[0][1].get("taskId") == "t-tt"
        and pushed_deployment.get("verification", {}).get("completed") == 1
        and pushed_deployment.get("verification", {}).get("state") == "running",
        pushed)

    async def broken_publish(_device, _event):
        raise RuntimeError("模拟通知通道中断")

    realtime_hub.publish = broken_publish
    notification_isolated = True
    try:
        async with SessionLocal() as s:
            await deployments._publish_update(s, await s.get(am.DeploymentRun, "dr-tt"))
    except Exception:  # pragma: no cover - Reaching this branch indicates a release reliability regression.
        notification_isolated = False
    finally:
        realtime_hub.publish = old_publish
    chk("★客户端通知失败不会反向破坏真实发布状态", notification_isolated)
    class FakeRunner:
        id = "runner-proof"

    async with SessionLocal() as s:
        deployment = await s.get(am.DeploymentRun, "dr-tt")
        deployment.runner_id = FakeRunner.id
        await s.commit()
        live_updates = await deployments.ingest_runner_snapshots(s, FakeRunner(), [{
            "id": "dr-tt", "state": "running", "stage": "check", "result": {
                "checksPlanned": 2, "checks": [
                    {"name": "首页可访问", "type": "http", "ok": True,
                     "detail": "GET → HTTP 200"},
                    {"name": "经验分享可点击", "type": "http", "ok": True,
                     "detail": "POST → HTTP 200"},
                ],
            },
        }, {"id": "dr-tt", "state": "failed", "error": "伪造", "result": {}}])
    chk("★Runner 主动发布快照半秒级入库，重复项只取一份且带客户端归属",
        len(live_updates) == 1 and live_updates[0].get("clientId") == "c-tt"
        and live_updates[0]["deployment"]["verification"]["state"] == "passed"
        and live_updates[0]["deployment"]["verification"]["completed"] == 2,
        live_updates)
    async with SessionLocal() as s:
        forged = await deployments.ingest_runner_snapshots(
            s, type("OtherRunner", (), {"id": "runner-other"})(),
            [{"id": "dr-tt", "state": "failed", "error": "伪造失败"}])
        unchanged = await s.get(am.DeploymentRun, "dr-tt")
    chk("★其他 Runner 不能伪造不属于它的发布结果",
        forged == [] and unchanged.state == "running" and unchanged.error != "伪造失败",
        (forged, unchanged.state, unchanged.error))
    chk("固定代码版本与 AI 审查存证在（凭什么放行，事后问得出来）",
        len(full["artifacts"]) == 1
        and full["artifacts"][0]["aiReview"]["verdict"] == "pass", full["artifacts"])
    chk("时间线与附件都在同一份响应里（详情页不用再查四五个接口）",
        len(full["timeline"]) >= 2 and len(full["attachments"]) == 2,
        (len(full["timeline"]), len(full["attachments"])))
    chk("★版本化通用协议齐全：标准阶段、六段旅程、证据覆盖和当前动作一次返回",
        full["schemaVersion"] == "1.0" and len(full["stages"]) == 6
        and len(full["phases"]) == 6 and full["summary"]["currentStageName"] == "建版本并部署",
        (full.get("schemaVersion"), full.get("summary"), full.get("phases")))
    chk("★人工确认带验收条件与锁定版本，不再只有一个通过按钮",
        full["approvals"][0]["confirmation"]["lockedArtifact"]["id"] == "av-tt"
        and "质量门禁通过" in full["approvals"][0]["confirmation"]["criteria"],
        full["approvals"][0])

    # A completed workflow must not appear blocked at a previously failed stage.
    # A fully successful run must not expose stale failure text or a retry action.
    # Retries leave failed and successful rows; final run state must override stale failures.
    async with SessionLocal() as s:
        s.add(models.Task(id="t-ok", title="重试后成功的活", status="done",
                          owner_client_id="c-tt"))
        s.add(am.WorkflowRun(id="run-ok", task_id="t-ok", plugin_id="pl-tt",
                             plugin_version_id="pv-tt", binding_id="b-tt", state="succeeded",
                             current_nodes=[], created_at=at(0), finished_at=at(40)))
        s.add(am.NodeRun(id="n-ok1", run_id="run-ok", node_key="publish", node_type="publish",
                         attempt=1, state="failed", idempotency_key="ok1",
                         started_at=at(25), finished_at=at(26), error="制品还没构建好"))
        s.add(am.NodeRun(id="n-ok-stale", run_id="run-ok", node_key="publish",
                         node_type="publish", attempt=2, state="running",
                         idempotency_key="ok-stale", started_at=at(28)))
        s.add(am.NodeRun(id="n-ok2", run_id="run-ok", node_key="publish", node_type="publish",
                         attempt=3, state="succeeded", idempotency_key="ok2",
                         started_at=at(30), finished_at=at(33),
                         output={"version": "jsai-dev-v0.1.33", "deployStatus": "SUCCESS"}))
        await s.commit()
    async with SessionLocal() as s:
        done_card = await task_trace.card(s, await s.get(models.Task, "t-ok"))
    chk("★流程整条成功后，旧失败和旧 running 都不能复活成当前关卡",
        (done_card["stage"] or {}).get("state") == "succeeded", done_card["stage"])
    chk("★成功的流程不给「重试这一关」（重试没有意义，只会让人误点）",
        done_card["canRetry"] is False, done_card)
    retry_projection = {
        "state": "failed",
        "workflow": [{"key": "publish", "type": "publish"}],
        "nodes": [
            {"id": "new", "key": "publish", "attempt": 2, "state": "failed"},
            {"id": "old", "key": "publish", "attempt": 1, "state": "succeeded"},
        ],
    }
    chk("★返工后的当前尝试失败时，旧成功不计入当前进度",
        task_execution_contract.current_node(retry_projection)["id"] == "new"
        and task_execution_contract.run_progress(retry_projection) == {"done": 0, "total": 1},
        retry_projection)
    retryable_stage = task_execution_contract.build_stages({}, [{
        "id": "run-retryable", "state": "failed",
        "workflow": [{"key": "publish", "name": "发布", "type": "publish"}],
        "nodes": [{"id": "node-retryable", "runId": "run-retryable", "key": "publish",
                   "name": "发布", "type": "publish", "attempt": 1, "state": "failed",
                   "error": "发布通道离线", "diagnosis": {"kind": "infrastructure",
                    "title": "执行通道暂不可用", "retryable": True}}],
    }], [], [], [], [], [])[0]
    blocked_stage = task_execution_contract.build_stages({}, [{
        "id": "run-blocked", "state": "failed",
        "workflow": [{"key": "decision", "name": "人工判断", "type": "condition"}],
        "nodes": [{"id": "node-blocked", "runId": "run-blocked", "key": "decision",
                   "name": "人工判断", "type": "condition", "attempt": 1, "state": "failed",
                   "error": "需要负责人决定", "diagnosis": {"kind": "escalation",
                    "title": "需要人工判断", "retryable": False}}],
    }], [], [], [], [], [])[0]
    chk("★公共阶段保留后端诊断，只有真实可恢复的失败关才允许重试",
        retryable_stage["diagnosis"]["retryable"] is True
        and retryable_stage["error"]["retryable"] is True
        and blocked_stage["diagnosis"]["retryable"] is False
        and blocked_stage["error"]["retryable"] is False,
        {"retryable": retryable_stage, "blocked": blocked_stage})
    from app.services import workflow_contracts as _wc
    chk("★AI 报 blocked 的失败类别按 reasonCode 分家（复现不了≠配置没配好）",
        _wc.blocked_failure_kind("no_reproducible_issue") == "escalation"
        and _wc.blocked_failure_kind("unsafe_change") == "escalation"
        and _wc.blocked_failure_kind("other") == "escalation"
        and _wc.blocked_failure_kind("") == "escalation"
        and _wc.blocked_failure_kind("missing_credentials") == "authorization"
        and _wc.blocked_failure_kind("missing_toolchain") == "configuration"
        and _wc.blocked_failure_kind("missing_input") == "configuration")
    parallel_projection = {
        "state": "waiting_human", "currentNodes": ["build", "accept"],
        "workflow": [{"key": "build"}, {"key": "accept"}],
        "nodes": [
            {"id": "building", "key": "build", "attempt": 1, "state": "running"},
            {"id": "accepting", "key": "accept", "attempt": 1, "state": "waiting_human"},
        ],
    }
    parallel_summary = task_execution_contract.summary(
        parallel_projection["nodes"], [], [], [], [], [], [])
    chk("★并行分支一边执行一边等人时，摘要优先把真正需要人处理的关口顶出来",
        task_execution_contract.current_node(parallel_projection)["id"] == "accepting"
        and parallel_summary["currentStageId"] == "accepting"
        and parallel_summary["currentState"] == "waiting_human",
        {"projection": parallel_projection, "summary": parallel_summary})
    blocked_projection = {"state": "failed", "output": {
        "failureKind": "configuration", "decision": {
            "outcome": "blocked", "summary": "执行机缺少工具链",
            "reasonCode": "missing_toolchain", "nextAction": "安装并探活 JDK 与 Maven",
        }}}
    chk("结构化前置阻断在公共任务协议中显示为有阻断而不是泛化失败",
        task_execution_contract.node_state(blocked_projection) == "blocked"
        and task_execution_contract.is_failure("blocked"), blocked_projection)
    plugin_node = {
        "id": "node-plugin-proof", "runId": "run-plugin-proof", "key": "verify",
        "output": {"evidence": [
            {"kind": "check", "title": "业务页面可用", "detail": "核心入口返回正常",
             "ok": True, "code": "homepage-ready"},
            {"kind": "image", "title": "上线页面截图", "attachmentId": "att-plugin-proof"},
        ]},
    }
    plugin_attachments = [{
        "id": "att-plugin-proof", "taskId": "t-plugin-proof",
        "workflowRunId": "run-plugin-proof", "nodeRunId": "node-plugin-proof",
        "filename": "上线页面.png", "contentType": "image/png", "size": 2048,
        "url": "/api/v1/attachments/att-plugin-proof", "isImage": True,
        "role": "verification", "uploadedBy": "agent:browser-use", "byAgent": True,
    }]
    plugin_evidence = task_execution_contract.node_evidence(plugin_node, plugin_attachments)
    chk("★未来导入的工作流插件按通用契约展示结构化检查与图片证据",
        any(x.get("kind") == "check" and
            dict(x.get("verification") or {}).get("state") == "passed"
            for x in plugin_evidence)
        and any(x.get("kind") == "image" and x.get("attachmentId") == "att-plugin-proof"
                for x in plugin_evidence), plugin_evidence)

    # Direct conversations and AI dispatches use the same task projection without a plugin.
    async with SessionLocal() as s:
        s.add(models.Task(id="t-direct", title="直接让 AI 做一张原型", status="doing",
                          owner_client_id="c-tt"))
        s.add(am.ExecutionSession(id="es-direct", task_id="t-direct", ref="ref-direct",
                                  runner_id="r-direct", host="149-runner", engine="pi",
                                  state="running", seq=1, work_dir="/srv/soduwork/t-direct",
                                  started_at=at(50)))
        s.add(am.ExecutionEvent(session_id="es-direct", seq=1, kind="step",
                                text="正在生成可点击原型", at=at(51)))
        s.add(models.Attachment(id="att-direct", task_id="t-direct", filename="首页.png",
                                content_type="image/png", size=4096, storage_key="direct",
                                backend="local", uploaded_by="agent:pi", role="output",
                                source_ref="ref-direct", created_at=at(51)))
        await s.commit()
    async with SessionLocal() as s:
        direct = await task_trace.trace(s, await s.get(models.Task, "t-direct"))
    chk("★直接派 AI 的任务也生成标准阶段，不要求先绑定插件工作流",
        [x["key"] for x in direct["stages"]] == ["intake", "execute", "verify", "deliver"],
        direct["stages"])
    execute = direct["stages"][1]
    chk("★直接任务的会话与图片产出进入执行阶段，图片保留可预览类型",
        execute["sessions"][0]["ref"] == "ref-direct"
        and execute["evidence"][0]["kind"] == "image", execute)

    # Historical running sessions remain evidence but cannot override a newer terminal state.
    async with SessionLocal() as s:
        s.add(am.ExecutionSession(id="es-direct-done", task_id="t-direct", ref="ref-direct-done",
                                  runner_id="r-direct", host="149-runner", engine="pi",
                                  state="done", seq=2, work_dir="/srv/soduwork/t-direct",
                                  started_at=at(60), finished_at=at(70)))
        await s.commit()
    async with SessionLocal() as s:
        direct_task = await s.get(models.Task, "t-direct")
        retried = await task_trace.trace(s, direct_task)
        retried_card = await task_trace.card(s, direct_task)
    chk("★更新的完成会话决定当前执行态，旧 running 不再制造幽灵运行任务",
        retried["stages"][1]["state"] == "succeeded"
        and retried["card"]["canCancel"] is False
        and retried_card["stage"]["state"] == "succeeded"
        and retried_card["canCancel"] is False,
        {"stage": retried["stages"][1], "traceCard": retried["card"],
         "cheapCard": retried_card})

    async with SessionLocal() as s:
        s.add(am.ExecutionSession(id="es-direct-unknown", task_id="t-direct",
                                  ref="ref-direct-unknown", state="unknown", engine="pi",
                                  started_at=at(80), finished_at=at(90)))
        await s.commit()
    async with SessionLocal() as s:
        direct_task = await s.get(models.Task, "t-direct")
        interrupted = await task_trace.trace(s, direct_task)
        interrupted_card = await task_trace.card(s, direct_task)
    chk("★只能确认进程结束时，阶段、摘要与操作统一显示中断而不是伪造成功",
        interrupted["stages"][1]["state"] == "interrupted"
        and interrupted["summary"]["currentState"] == "interrupted"
        and interrupted["card"]["canCancel"] is False
        and interrupted_card["stage"]["state"] == "interrupted"
        and interrupted_card["canCancel"] is False,
        {"summary": interrupted["summary"], "traceCard": interrupted["card"],
         "cheapCard": interrupted_card})

    print("\n%d PASS / %d FAIL" % (ok, fail))
    return fail


if __name__ == "__main__":
    sys.exit(1 if asyncio.run(main()) else 0)
