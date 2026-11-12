# -*- coding: utf-8 -*-
"""Built-in requirement/bug delivery workflows over the real engine and evidence model.

All durable state is disposable. AI, Git and environment execution are controlled boundary
adapters, while scheduling, human baseline approval, immutable artifacts, AI review attestation,
merge authorization, release verification, retry semantics and the client trace are production
code paths.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import sys
import uuid


DB = os.path.abspath(".smoke-builtin-delivery-e2e.db")
DATA = os.path.abspath(".smoke-builtin-delivery-e2e-data")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
shutil.rmtree(DATA, ignore_errors=True)
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
os.environ["SODUWORK_DATA_ROOT"] = DATA
sys.path.insert(0, ".")

from sqlalchemy import select  # noqa: E402

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import (code_delivery, delivery_truth, deployments, plugin_packages,  # noqa: E402
                          release_control, storage, task_trace, workflow_contracts,
                          workflow_engine, workflow_runs)


ROOT = os.path.dirname(os.path.dirname(__file__))
MODEL = "dev-coding-large-agent-soduwork"
passed = failed = 0
lines: list[str] = []
flow_state: dict[str, dict] = {}
flow_identity: dict[str, dict] = {}


def check(name: str, condition, detail="") -> None:
    global passed, failed
    if condition:
        passed += 1
        lines.append("  PASS  " + name)
    else:
        failed += 1
        lines.append("  FAIL  " + name + ("  << " + str(detail)[:500] if detail else ""))


def _now():
    return workflow_engine._now()


async def _attachment(session, task, run, node, filename: str, raw: bytes,
                      content_type: str, role: str = "output", evidence=None):
    key = "smoke/builtin/%s/%s/%s" % (task.id, node.id, filename)
    row = models.Attachment(
        id=str(uuid.uuid4()), task_id=task.id, filename=filename,
        content_type=content_type, size=len(raw), storage_key=key,
        uploaded_by="agent:runner-smoke", role=role,
        source_ref="smoke:" + node.id, workflow_run_id=run.id, node_run_id=node.id,
        evidence_meta=dict(evidence or {}))
    row.backend = storage.put(key, raw, content_type)
    session.add(row)
    await session.flush()
    return row


async def _fake_ai(session, run, node_run, definition, task, _version) -> None:
    identity = flow_identity[task.id]
    key = node_run.node_key
    node_run.started_at = node_run.started_at or _now()
    node_run.executor = {
        "kind": "ai", "provider": "runner", "runnerId": "runner-smoke",
        "requested": {"agentKind": "local:codex", "model": MODEL},
        "resolved": {"agentKind": "local:codex", "model": MODEL},
    }
    if key in {"analyze", "scope"}:
        title = "完整产品需求" if key == "analyze" else "稳定复现缺陷"
        requirements = (
            "# %s\n\n## 范围\n- 覆盖客户端、服务端、权限与发布边界\n\n"
            "## 验收标准\n- 用户入口完成完整主路径\n- 错误、空状态和权限边界可验证\n"
            "- 固定提交通过真实自测和独立审查\n- 发布版本与合并版本一致且健康检查通过\n\n"
            "## 风险\n- 发布通道不可用时只重试发布关\n" % title).encode("utf-8")
        decision = json.dumps({
            "schemaVersion": 1, "outcome": "proceed", "summary": "输入和环境已就绪",
            "reasonCode": "ready", "evidence": ["需求、仓库和发布链已配置"],
            "nextAction": "进入工程实现",
        }, ensure_ascii=False).encode("utf-8")
        req = await _attachment(
            session, task, run, node_run, "requirements.md", requirements, "text/markdown")
        dec = await _attachment(
            session, task, run, node_run, "workflow-decision.json", decision,
            "application/json")
        node_run.output = {
            "attachments": [{"id": req.id, "filename": req.filename},
                            {"id": dec.id, "filename": dec.filename}],
            "decision": {"outcome": "proceed", "reasonCode": "ready"},
        }
    elif key == "implement":
        artifact, _ = await release_control.ensure_code_candidate(session, task, {
            "branch": "soduwork/%s" % task.id, "target": "main",
            "commits": [{"sha": identity["commit"], "subject": identity["subject"]}],
            "files": identity["files"],
        }, who="Codex")
        node_run.output = {
            "gitBranch": artifact.branch, "gitHead": artifact.commit_sha,
            "gitDelivery": {"stage": "committed", "artifactVersionId": artifact.id,
                            "branch": artifact.branch, "target": artifact.target,
                            "commit": artifact.commit_sha},
        }
    elif key == "review":
        artifact = await release_control.latest_artifact(
            session, task.id, stream="delivery")
        report = json.dumps({
            "schemaVersion": 1, "verdict": "pass", "summary": "独立审查通过",
            "findings": [], "checks": ["需求覆盖", "权限边界", "测试证据"],
        }, ensure_ascii=False).encode("utf-8")
        attachment = await _attachment(
            session, task, run, node_run, "code-review.json", report, "application/json",
            role="verification", evidence={"kind": "ai_review",
                                            "verification": {"state": "passed"}})
        attestation = await release_control.record_ai_review(session, task, artifact, {
            "verdict": "pass", "reportChecksum": hashlib.sha256(report).hexdigest(),
            "attachmentId": attachment.id, "summary": "独立审查通过",
            "findings": [], "checks": ["需求覆盖", "权限边界", "测试证据"],
        }, source={"runId": run.id, "nodeId": node_run.id,
                   "runnerId": "runner-smoke"})
        node_run.output = {
            "attachments": [{"id": attachment.id, "filename": attachment.filename}],
            "artifactVersionId": artifact.id, "attestation": attestation,
        }
    else:
        raise AssertionError("unexpected AI node: " + key)
    received = [str(item.get("filename") or "")
                for item in (node_run.output or {}).get("attachments") or []
                if item.get("filename")]
    raw_receipt = {"received": received, "valid": received,
                   "deliverables": received, "evidence": []}
    node_run.output = {**dict(node_run.output or {}),
                       "outputReceipt": workflow_contracts.evaluate(
                           definition, node_run.output or {}, raw_receipt)}
    node_run.state, node_run.finished_at = "succeeded", _now()


async def _fake_quality(session, _run, task, node_run, _definition) -> None:
    artifact = await release_control.latest_artifact(session, task.id, stream="delivery")
    node_run.output = {
        "state": "succeeded", "commit": artifact.commit_sha,
        "checks": [{"name": "Git 提交完整性", "ok": True},
                   {"name": "工程真实自测", "ok": True}],
        "log": "all authoritative checks passed",
    }
    node_run.executor = {"kind": "quality", "runnerId": "runner-smoke"}
    node_run.state, node_run.finished_at = "succeeded", _now()


async def _fake_merge(session, task, who="SoduWork") -> dict:
    artifact = await release_control.latest_artifact(session, task.id, stream="delivery")
    await release_control.mark_merged(session, task, artifact.commit_sha, who)
    return {"ok": True, "stage": "merged", "commit": artifact.commit_sha,
            "branch": artifact.branch, "target": artifact.target}


async def _fake_queue(_session, task, _who) -> dict:
    state = flow_state[task.id]
    state["queues"] += 1
    state["phaseCalls"] = 0
    return {"ok": True, "runs": [{"id": "deploy-%s-%s" %
                                    (task.id, state["queues"])}]}


async def _fake_chain(session, task) -> dict:
    state = flow_state[task.id]
    state["phaseCalls"] += 1
    artifact = await release_control.latest_artifact(session, task.id, stream="delivery")
    attempt = state["queues"]
    run_id = "deploy-%s-%s" % (task.id, attempt)
    waiting = state["phaseCalls"] == 1
    if attempt <= state["failAttempts"]:
        if waiting:
            return {"ok": True, "complete": False, "failed": False,
                    "artifactVersionId": artifact.id, "environments": [
                        {"name": "项目声明环境", "deployed": False,
                         "acceptance": "not_started", "marksDelivery": True}],
                    "runs": [{"id": run_id, "state": "running",
                              "commit": artifact.commit_sha}]}
        return {"ok": True, "complete": False, "failed": True,
                "failureKind": "infrastructure", "error": "部署通道暂时不可达，已回滚",
                "artifactVersionId": artifact.id,
                "environments": [{"name": "项目声明环境", "deployed": False,
                                  "acceptance": "not_started", "marksDelivery": True}],
                "runs": [{"id": run_id, "state": "rolled_back",
                          "commit": artifact.commit_sha,
                          "verification": {"state": "failed", "checks": []}}]}
    if waiting:
        return {"ok": True, "complete": False, "failed": False,
                "artifactVersionId": artifact.id,
                "environments": [{"name": "项目声明环境", "deployed": False,
                                  "acceptance": "not_started", "marksDelivery": True}],
                "runs": [{"id": run_id, "state": "running",
                          "commit": artifact.commit_sha}]}
    if not state.get("screenshotId"):
        release_node = (await session.execute(select(am.NodeRun).where(
            am.NodeRun.run_id == flow_identity[task.id]["run"].id,
            am.NodeRun.node_key == "releaseChain").order_by(
                am.NodeRun.attempt.desc()).limit(1))).scalar_one()
        shot = await _attachment(
            session, task, flow_identity[task.id]["run"], release_node,
            "发布后验收截图.png", b"verified-screenshot", "image/png", role="verification",
            evidence={"kind": "screenshot", "verification": {"state": "passed"}})
        state["screenshotId"] = shot.id
    artifact.state = "released"
    await session.flush()
    checks = [{"name": "服务健康检查", "type": "http", "ok": True,
               "detail": "HTTP 200"},
              {"name": "发布后核心路径", "type": "browser", "ok": True,
               "detail": "关键路径通过", "evidence": state["screenshotId"]}]
    return {"ok": True, "complete": True, "failed": False,
            "artifactVersionId": artifact.id,
            "environments": [{"name": "项目声明环境", "deployed": True,
                              "acceptance": "approved", "marksDelivery": True}],
            "runs": [{"id": run_id, "targetName": "项目声明环境",
                      "state": "succeeded", "commit": artifact.commit_sha,
                      "verification": {"state": "passed", "planned": len(checks),
                                       "completed": len(checks), "checks": checks}}]}


async def _approve_baseline(session, run, actor) -> None:
    rows = list((await session.execute(select(am.NodeRun).where(
        am.NodeRun.run_id == run.id, am.NodeRun.node_type == "spec",
        am.NodeRun.state == "waiting_human"))).scalars().all())
    for node in rows:
        request = await session.get(
            am.ApprovalRequest, str((node.output or {}).get("requestId") or ""))
        if request is None or request.status != "pending":
            continue
        result = await release_control.decide(
            session, await session.get(models.Task, run.task_id), actor,
            action="baseline", decision="approve", note="范围和验收标准已确认",
            artifact_version_id=request.artifact_version_id)
        if not result.get("ok"):
            raise AssertionError("baseline approval failed: " + str(result))


async def _drive(session, run, actor, limit=40) -> str:
    for _ in range(limit):
        await workflow_engine.tick(session)
        await session.refresh(run)
        await _approve_baseline(session, run, actor)
        await session.refresh(run)
        if run.state in {"succeeded", "failed", "cancelled"}:
            return run.state
    raise AssertionError("workflow did not reach a terminal state: " + run.id)


def _load_plugin(filename: str):
    with open(os.path.join(ROOT, "plugins", filename), encoding="utf-8") as stream:
        return plugin_packages.normalize(json.load(stream))


async def _seed(session):
    user = models.User(id="u-builtin-e2e", username="builtin-e2e",
                       display_name="流程验收人", is_super=True, is_active=True)
    client = models.Client(id="c-builtin-e2e", name="验收电脑", user_ref=user.id)
    project = models.Project(id="p-builtin-e2e", name="流程验证工程",
                             owner_user_id=user.id, created_by=user.id)
    repo = models.Repo(id="r-builtin-e2e", project_id=project.id, name="主工程",
                       git_url="https://example.invalid/soduwork.git", default_branch="main",
                       merge_branch="main")
    session.add_all([user, client, project, repo])
    await session.flush()
    cases = [
        ("software-delivery.json", "requirement", "新增完整用户功能", "a", 0,
         ["api.py", "admin.tsx", "client.js", "tests/test_delivery.py"]),
        ("project-validation-release.json", "bugfix", "修复稳定回归缺陷", "b", 2,
         ["dispatch.py", "dispatch.test.py"]),
    ]
    seeded = {}
    for filename, suffix, title, commit_char, failures, files in cases:
        manifest, workflow, report = _load_plugin(filename)
        plugin = am.Plugin(id="plugin-" + suffix, key=manifest["key"],
                           name=manifest["name"], enabled=True)
        version = am.PluginVersion(
            id="version-" + suffix, plugin_id=plugin.id, version=manifest["version"],
            checksum="checksum-" + suffix, manifest=manifest, workflow=workflow,
            capability_report=report, trust_state="approved", enabled=True)
        binding = am.PluginBinding(
            id="binding-" + suffix, plugin_id=plugin.id, version_id=version.id,
            project_id=project.id, enabled=True)
        task = models.Task(
            id="task-" + suffix, title=title, note="完整可复核的业务输入",
            status="todo", owner_client_id=client.id, created_by=user.id,
            created_by_name=user.display_name, requester_user_id=user.id,
            assignee_user_id=user.id, project_id=project.id, repo_id=repo.id)
        session.add_all([plugin, version, binding, task])
        seeded[suffix] = (task, binding)
        flow_state[task.id] = {"queues": 0, "phaseCalls": 0,
                               "failAttempts": failures, "screenshotId": ""}
        flow_identity[task.id] = {
            "commit": commit_char * 40, "subject": title, "files": files,
            "run": None,
        }
    await session.commit()
    return user, seeded


async def _assert_success(session, label: str, run, task, expected_keys: list[str]) -> None:
    await session.refresh(run)
    await session.refresh(task)
    detail = await workflow_engine.run_api(session, run)
    latest = {}
    for row in detail["nodes"]:
        latest[row["key"]] = row
    check(label + "真实内置节点全部成功且顺序不变",
          run.state == "succeeded" and list(x["key"] for x in detail["workflow"]) == expected_keys
          and all(latest[key]["state"] == "succeeded" for key in expected_keys), detail)
    truth = await delivery_truth.evaluate(session, task)
    check(label + "最终交付事实允许任务办结", truth.get("canComplete") is True, truth)
    check(label + "流程成功后任务自动办结", task.status == "done",
          {"status": task.status, "truth": truth})
    verify = latest["verifyRelease"]["output"]
    check(label + "部署版本、健康检查和发布后路径证据已核对",
          verify.get("shaMatch") is True and verify.get("assertions", 0) >= 2
          and all(item.get("ok") for item in verify.get("checks") or []), verify)
    trace = await task_trace.trace(session, task)
    check(label + "客户端公共全链路能看到流程与截图证据",
          any(item.get("filename") == "发布后验收截图.png"
              for item in trace.get("attachments") or [])
          and any(item.get("id") == run.id for item in trace.get("runs") or []),
          trace.get("summary"))


async def main() -> None:
    await init_db()
    original_ready = workflow_runs._ensure_start_ready
    original_ai = workflow_engine._execute_ai
    original_quality = workflow_engine._start_quality
    original_merge = code_delivery.merge_approved
    original_queue = deployments.queue_automatic
    original_chain = deployments.chain_status

    async def ready(*_args, **_kwargs):
        return {"ok": True, "blockers": []}

    workflow_runs._ensure_start_ready = ready
    workflow_engine._execute_ai = _fake_ai
    workflow_engine._start_quality = _fake_quality
    code_delivery.merge_approved = _fake_merge
    deployments.queue_automatic = _fake_queue
    deployments.chain_status = _fake_chain
    try:
        async with SessionLocal() as session:
            actor, seeded = await _seed(session)
            requirement, requirement_binding = seeded["requirement"]
            requirement_run = await workflow_engine.start(
                session, requirement, requirement_binding, {"businessGoal": "完整交付"},
                actor_id=actor.id, execution={"agentKind": "local:codex", "model": MODEL,
                                              "reasoningEffort": "high"}, notify=False)
            flow_identity[requirement.id]["run"] = requirement_run
            await session.commit()
            check("运行偏好固定为本机 Codex 与高质量模型",
                  requirement_run.context["execution"].get("agentKind") == "local:codex"
                  and requirement_run.context["execution"].get("model") == MODEL
                  and requirement_run.context["execution"].get("reasoningEffort") == "high",
                  requirement_run.context)
            check("新需求流程进入运行即联动任务进行中",
                  requirement.status == "doing", requirement.status)
            state = await _drive(session, requirement_run, actor)
            check("新需求到发布流程跑到终态", state == "succeeded", state)
            await _assert_success(session, "新需求到发布", requirement_run, requirement, [
                "analyze", "baseline", "implement", "quality", "review", "merge",
                "releaseChain", "verifyRelease", "publish"])

            bugfix, bugfix_binding = seeded["bugfix"]
            bugfix_run = await workflow_engine.start(
                session, bugfix, bugfix_binding, {"verificationFocus": "任务派活回归"},
                actor_id=actor.id, execution={"agentKind": "local:codex", "model": MODEL,
                                              "reasoningEffort": "high"}, notify=False)
            flow_identity[bugfix.id]["run"] = bugfix_run
            await session.commit()
            failed_state = await _drive(session, bugfix_run, actor)
            release_rows = list((await session.execute(select(am.NodeRun).where(
                am.NodeRun.run_id == bugfix_run.id,
                am.NodeRun.node_key == "releaseChain").order_by(am.NodeRun.attempt))).scalars())
            implementation_rows = list((await session.execute(select(am.NodeRun).where(
                am.NodeRun.run_id == bugfix_run.id,
                am.NodeRun.node_key == "implement"))).scalars())
            check("Bug 发布通道连续失败后流程明确失败并保留回滚事实",
                  failed_state == "failed" and len(release_rows) == 2
                  and all((row.output or {}).get("failureKind") == "infrastructure"
                          and (row.output or {}).get("runs", [{}])[-1].get("state") == "rolled_back"
                          for row in release_rows), [(x.attempt, x.state, x.output) for x in release_rows])
            check("发布基础设施失败只重试发布关，不重复调用 Codex 开发",
                  len(implementation_rows) == 1 and implementation_rows[0].attempt == 1,
                  [(x.attempt, x.state) for x in implementation_rows])
            check("失败流程把任务恢复为可处理待办", bugfix.status == "todo", bugfix.status)

            retry = await workflow_engine.retry_failed_gate(
                session, bugfix_run, actor=actor.id, node_key="releaseChain")
            await session.refresh(bugfix)
            check("人工原地重试发布关时任务同步回到进行中",
                  retry.attempt == 3 and bugfix.status == "doing",
                  (retry.attempt, bugfix.status))
            final_state = await _drive(session, bugfix_run, actor)
            check("发布通道恢复后从失败关原地完成", final_state == "succeeded", final_state)
            implementation_rows = list((await session.execute(select(am.NodeRun).where(
                am.NodeRun.run_id == bugfix_run.id,
                am.NodeRun.node_key == "implement"))).scalars())
            check("原地恢复后仍未重放已通过的开发和审查证据",
                  len(implementation_rows) == 1, implementation_rows)
            await _assert_success(session, "Bug 到发布后验证", bugfix_run, bugfix, [
                "scope", "implement", "quality", "review", "merge",
                "releaseChain", "verifyRelease", "publish"])
    finally:
        workflow_runs._ensure_start_ready = original_ready
        workflow_engine._execute_ai = original_ai
        workflow_engine._start_quality = original_quality
        code_delivery.merge_approved = original_merge
        deployments.queue_automatic = original_queue
        deployments.chain_status = original_chain


async def run() -> None:
    try:
        await main()
    finally:
        await engine.dispose()


try:
    asyncio.run(run())
finally:
    for suffix in ("", "-shm", "-wal"):
        try:
            os.remove(DB + suffix)
        except FileNotFoundError:
            pass
    shutil.rmtree(DATA, ignore_errors=True)

print("\n".join(lines))
print("\nbuiltin delivery e2e: %d passed, %d failed" % (passed, failed))
raise SystemExit(1 if failed else 0)
