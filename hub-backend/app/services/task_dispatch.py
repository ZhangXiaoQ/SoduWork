"""One dispatch pipeline for device and administrator entry points.

Routes authorize their caller before entering this service. ``client`` is always
the task owner whose model, credentials and workspace are used; ``actor`` is the
separately authorized operator recorded in audit and workflow receipts.
"""
import logging
from types import SimpleNamespace
from fastapi import HTTPException
from ..models import Task
from ..schemas import task_to_api
from . import audit, task_access, task_requirements, tasks as svc
from .task_dispatch_context import (
    _ext_project_id, _repo_ctx, _resolve_repo, _attach_dev_flow, _attach_skills,
    _settle_work_dir, _link_task_repo, _stale_runner_hint, _push_task,
    _remote_execution_context,
)

log = logging.getLogger("uvicorn.error")


async def _active_workflow(session, tid):
    from sqlalchemy import select
    from ..automation_models import WorkflowRun
    from .workflow_runs import _ACTIVE_RUN_STATES
    return (await session.execute(select(WorkflowRun).where(
        WorkflowRun.task_id == tid, WorkflowRun.state.in_(tuple(_ACTIVE_RUN_STATES)),
    ).order_by(WorkflowRun.created_at.desc()).limit(1))).scalar_one_or_none()


async def dispatch(tid, body, client, session, *, actor=None):
    import asyncio as _aio

    from ..services import ai_exec, dispatch_attempts
    from ..services import task_events as ev
    from ..services import task_access
    await task_access.reserve_task_write(session, tid, client.id)
    t = await session.get(Task, tid, with_for_update=True, populate_existing=True)
    if t is None or not task_access.is_owner(t, client):
        raise HTTPException(status_code=404, detail="需求不存在")
    from . import client_access
    try:
        await client_access.assert_quota(session, str(t.assignee_user_id or client.user_ref or ""))
    except client_access.ClientAccessError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail()) from exc
    from ..services.conversation_turns import ensure_available, execution_instruction
    from ..services import conversation_handoffs
    handoff, body = await conversation_handoffs.dispatch_body(session, client, t, body)
    if handoff and actor is not None:
        raise HTTPException(409, "云端交接需由会话本人在原会话中确认，不能从管理端重新派发")
    try:
        ensure_available(t, body.get("conversationTurn"), "dispatch")
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if t.status == "done":
        raise HTTPException(status_code=400, detail="需求已完成，不用再交给 AI")
    if t.status == "cancel":
        raise HTTPException(409, "需求已关闭，请先恢复需求，再安排执行")
    submission_mode = str(body.get("submissionMode") or body.get("executionSubmissionMode") or "").strip().lower()
    if submission_mode or "executionSubmissionMode" not in (t.work_routing or {}):
        from .conversation_turns import default_submission_mode, normalize_submission_mode
        routing = dict(t.work_routing or {})
        routing["executionSubmissionMode"] = normalize_submission_mode(
            submission_mode, fallback=default_submission_mode(t))
        t.work_routing = routing
    # Runtime ownership must not depend on today's project/default-plugin settings.
    # A settings change or an explicit direct choice cannot create a second executor.
    running = await _active_workflow(session, tid)
    if running is not None:
        return {"ok": True, "identifier": running.id, "runId": running.id,
                "provider": "plugin", "reused": True, "assigneeName": "进行中的工作流",
                "task": await svc.task_to_api_live(session, t)}
    from .conversation_turns import _workflow_starting
    if await _workflow_starting(session, tid):
        raise HTTPException(409, "这项需求正在启动工作流，请等待当前执行确认")
    active_dispatch = await dispatch_attempts.existing(session, tid, t.status)
    if active_dispatch is not None:
        return {**active_dispatch, "task": await svc.task_to_api_live(session, t)}
    conversation_brief = execution_instruction(body.get("brief"), body.get("conversationTurn"))
    aid = str(body.get("assigneeId") or "").strip()
    atype = str(body.get("assigneeType") or "").strip().lower()
    if atype not in ("agent", "squad"):
        atype = ""
    me = actor if actor is not None else await task_requirements.identity(session, client)
    who = (me.display_name or me.username) if me else "承办人"
    # Personal-plugin requests carry identity and parameters only; the owner's device resolves the body.
    personal_plugin = None
    if isinstance(body.get("personalPlugin"), dict) and str(
            (body.get("personalPlugin") or {}).get("key") or "").strip():
        from ..services import schedules as sch_service
        try:
            raw_plugin = body["personalPlugin"]
            personal_plugin = sch_service.personal_plugin_spec(SimpleNamespace(
                personal_plugin_key=raw_plugin.get("key"),
                personal_plugin_version_policy=raw_plugin.get("versionPolicy"),
                personal_plugin_version=raw_plugin.get("version"),
                personal_plugin_checksum=raw_plugin.get("checksum"),
            ))
            personal_plugin["inputs"] = sch_service.clean_plugin_inputs(
                raw_plugin.get("inputs"))
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
    # Project work must enter the approved project workflow. This is the final
    # server-side guard for old clients and pages that forgot to send a binding.
    from ..services import managed_work_route
    explicit_direct = managed_work_route.direct_requested(body)
    if managed_work_route.is_managed(t) and not explicit_direct:
        if personal_plugin:
            raise HTTPException(
                status_code=409,
                detail="\u9879\u76ee需求\u5fc5\u987b\u8d70\u5df2\u5ba1\u6279\u7684\u9879\u76ee\u5de5\u4f5c\u6d41\uff0c\u4e0d\u80fd\u4e34\u65f6\u5207\u6362\u4e2a\u4eba\u63d2\u4ef6")
        repo_body = body.get("repo") if isinstance(body.get("repo"), dict) else {}
        repo_id = str(body.get("repoId") or repo_body.get("id") or t.repo_id or "")
        execution = managed_work_route.execution_from_assignee(
            aid, str(body.get("model") or ""))
        try:
            routed = await managed_work_route.start(
                session, t, binding_id=str(body.get("bindingId") or ""),
                execution=execution, repo_id=repo_id,
                instruction=str(body.get("brief") or ""),
                actor_id=str(me.id) if me else "", actor_name=who)
        except managed_work_route.ManagedWorkflowError as route_error:
            raise HTTPException(
                status_code=409,
                detail="\u9879\u76ee\u5de5\u4f5c\u6d41\u6ca1\u6709\u542f\u52a8\uff1a" + str(route_error)) from route_error
        except Exception as route_error:  # noqa: BLE001 - fail closed
            log.exception("\u9879\u76ee\u5de5\u4f5c\u6d41\u542f\u52a8\u5931\u8d25")
            raise HTTPException(
                status_code=502,
                detail="\u9879\u76ee\u5de5\u4f5c\u6d41\u542f\u52a8\u5931\u8d25\uff0c需求\u6ca1\u6709\u964d\u7ea7\u4e3a\u666e\u901a AI \u76f4\u6d3e") from route_error
        task_api = await _push_task(session, t, created=False)
        return {**routed, "task": task_api or task_to_api(t)}




    try:
        from ..services import zero_work_route
        routed = None if personal_plugin or explicit_direct else await zero_work_route.try_route(
            session, t, aid=aid, atype=atype, model=str(body.get("model") or ""),
            brief=str(body.get("brief") or ""), actor_id=str(me.id) if me else "",
            actor_name=who)
    except Exception as route_error:  # noqa: BLE001
        log.warning("零活路由异常，退回直派：%s", type(route_error).__name__)
        routed = None
    if routed is not None:
        task_api = await _push_task(session, t, created=False)
        return {**routed, "task": task_api or task_to_api(t)}
    from sqlalchemy import select as _select
    await task_access.reserve_task_write(session, tid, client.id)
    t = (await session.execute(
        _select(Task).where(
            Task.id == tid, task_access.owner_clause(client)
        ).with_for_update().execution_options(populate_existing=True)
    )).scalar_one_or_none()
    if t is None:
        raise HTTPException(status_code=404, detail="需求不存在")
    try:
        ensure_available(t, body.get("conversationTurn"), "dispatch")
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    active_dispatch = await dispatch_attempts.existing(session, tid, t.status)
    if active_dispatch is not None:
        active_dispatch["task"] = await svc.task_to_api_live(session, t)
        return active_dispatch
    if explicit_direct:
        from ..services.execution_context import public as public_execution_context
        routing = dict(t.work_routing or {})
        routing["selectedStrategy"] = "direct"
        routing["workflowBindingId"] = ""
        routing["executionContext"] = public_execution_context(body.get("executionContext"))
        t.work_routing = routing
    attempt_id = await dispatch_attempts.start(
        session, tid, who, aid, atype, str(body.get("model") or ""),
        stable_id=conversation_handoffs.dispatch_id(handoff) if handoff else "")
    picked = None

    async def _fail(stage: str, message, status: int = 502,
                    retryable: bool = True):
        message = await _stale_runner_hint(session, stage, message, picked)
        detail = await dispatch_attempts.failed(
            session, tid, who, attempt_id, stage, message, aid, picked, retryable)
        fresh = await session.get(Task, tid)
        if (fresh is not None and fresh.status == "doing"
                and await ai_exec.last_dispatch_event(session, tid) is None):
            from ..services import task_status
            if await task_status.mark(
                    session, fresh, "todo", why="首次 AI 安排执行失败"):
                await session.commit()
        if fresh is not None:
            try:
                await _push_task(session, fresh, created=False)
            except Exception as push_error:  # noqa: BLE001 - Push failure must not undo persisted failure facts.
                log.warning("推送派活失败状态失败：%s", type(push_error).__name__)
        raise HTTPException(status_code=status, detail={
            "message": detail["error"], "code": "AI_DISPATCH_FAILED",
            "phase": detail["phase"], "phaseName": detail["phaseName"],
            "retryable": detail["retryable"], "attemptId": attempt_id,
        })


    async def _pending(message, receipt: dict):
        """Keep an indeterminate Runner ACK visible without starting a duplicate."""
        pending_pick = dict(picked or {})
        for key in ("runnerId", "runnerBootId", "runnerClientId", "host"):
            value = str((receipt or {}).get(key) or "")
            if value:
                pending_pick[key] = value
        detail = dispatch_attempts.uncertain(
            session, tid, who, attempt_id, message, aid, pending_pick)
        if t.status == "todo":
            from ..services import task_status
            await task_status.mark(session, t, "doing", why="等待 Runner 回执确认")
        from ..services import execution_sessions as _es
        confirmed_ref = await _es.confirm_uncertain_dispatch(
            session, t, detail["expectedRef"],
            str(detail.get("runnerId") or ""))
        final_ref = confirmed_ref or detail["expectedRef"]
        if me:
            await audit.log(
                session, me, "task.ai_dispatch_pending", "task", tid, t.title,
                {"attemptId": attempt_id, "expectedRef": detail["expectedRef"],
                 "runnerId": str(detail.get("runnerId") or "")})
        await session.commit()
        task_api = None
        try:
            task_api = await _push_task(session, t, created=False)
        except Exception as push_error:  # noqa: BLE001 - durable state remains authoritative
            log.warning("推送派活待确认状态失败：%s", type(push_error).__name__)
        out = dict(receipt or {})
        out.update({
            "ok": True, "pending": not bool(confirmed_ref),
            "uncertain": not bool(confirmed_ref),
            "state": "running" if confirmed_ref else "confirming",
            "retryable": False, "attemptId": attempt_id,
            "issueId": final_ref, "expectedRef": detail["expectedRef"],
            "task": task_api or task_to_api(t),
        })
        return out

    try:
        ctx = await ai_exec.load(session, force=True)
    except Exception as error:  # noqa: BLE001
        await _fail("configuration", "读取 Agent 配置失败：" + str(error), 502)
    # Apply the task owner's Git credentials when configured, otherwise retain executor defaults.
    try:
        ctx = await ai_exec.with_task_git(session, ctx, t, lock_to_client=not bool(handoff))
        if handoff:
            ctx = await conversation_handoffs.dispatch_scope(session, client, ctx, handoff)
    except Exception as error:  # noqa: BLE001
        await _fail("configuration", "读取需求归属人的代码账号失败：" + str(error), 502)
    if personal_plugin:
        # Personal-plugin execution must stay on the owner's online Runner.
        # Do not migrate or silently fall back when its device-local plugin library is unavailable.
        ctx = ai_exec.with_client_runner_scope(ctx, client.id)
    # Honor explicit selection first, then project defaults, resolving a real agent on the responsible user's device.
    # Do not pass an empty assignee and silently fall back to the server.
    try:
        if not handoff:
            ctx, aid = await _remote_execution_context(
                session, client, ctx, body, aid, t, personal_plugin)
        if aid:
            picked = await _aio.to_thread(
                ai_exec.resolve_requested_sync, ctx, aid, atype, client.id, "",
                ai_exec.required_capabilities(t))
        else:
            from ..services import task_assignment
            project_defaults = await task_assignment.project_route(session, t.project_id)
            picked = await _aio.to_thread(
                ai_exec.resolve_default_sync, ctx, client.id,
                project_defaults.get("agentKind") or "",
                ai_exec.required_capabilities(t))
    except HTTPException as error:
        await _fail("routing", error.detail, error.status_code)
    except Exception as error:  # noqa: BLE001
        await _fail("routing", "选择执行机失败：" + str(error), 502)
    if picked is None:
        await _fail(
            "routing",
            "当前电脑没有可接这条需求的在线 Agent，请检查底座安装、Runner 状态和能力授权",
            409,
        )
    try:
        from ..services import task_execution_model
        ctx, agent_execution = await task_execution_model.prepare(
            session, client, ctx, picked, str(body.get("model") or ""),
            str(body.get("reasoningEffort") or ""))
    except ValueError as error:
        await _fail("configuration", str(error), 409, False)
    except Exception as error:  # noqa: BLE001 - never launch with an unrelated model
        await _fail("configuration", "读取执行模型配置失败：" + type(error).__name__, 502)
    try:
        files = await ai_exec.collect_task_files(session, tid)   # Include requirement documents and screenshots in the AI context.

        extra = await ai_exec.collect_task_context(session, tid)
    except Exception as error:  # noqa: BLE001
        await _fail("context", "整理需求说明和附件失败：" + str(error), 502)
    extra["brief"] = conversation_brief
    extra["dispatchId"] = attempt_id
    if agent_execution:
        extra["agentExecution"] = agent_execution
    if personal_plugin:
        extra["personalPlugin"] = personal_plugin
    routing = dict(getattr(t, "work_routing", None) or {})
    extra["requiredSkills"] = [
        str(x) for x in (routing.get("requiredSkills") or []) if str(x)]

    # Use the execution device's supplied repository workspace path.
    extra["repo"] = _repo_ctx(body)
    try:
        _repo = await _resolve_repo(session, extra["repo"])
        # Use the configured work root, cloning project code when needed and isolating temporary tasks beneath temp.
        _remote = str((picked or {}).get("id") or "").startswith(ai_exec.REMOTE_PREFIX)
        _wd = await _settle_work_dir(session, client, _repo, extra["repo"], tid, remote=_remote)
    except HTTPException as error:
        await _fail("workspace", error.detail, error.status_code, error.status_code >= 500)
    except Exception as error:  # noqa: BLE001
        await _fail("workspace", "准备工作目录失败：" + str(error), 502)
    if not _wd.get("ok"):
        await _fail("workspace", _wd.get("detail") or "工作目录没准备好", 409)
    extra["workDir"] = _wd.get("dir", "")
    extra["workRoot"] = _wd.get("workRoot", "")
    # Fill missing project association so code-delivery checks can resolve the repository.
    try:
        _link_task_repo(t, _repo)
        await _attach_dev_flow(session, extra["repo"], _repo)   # Merge global development-flow defaults with repository overrides.
        await _attach_skills(session, extra, extra["repo"], client)   # Resolve selected skills against their availability policy.
        # Use the provider's project association when the task project has an explicit binding.
        extra["extProjectId"] = await _ext_project_id(session, t)
        extra = await ai_exec.with_project_context(session, extra, t, _repo)
    except Exception as error:  # noqa: BLE001
        await _fail("workflow", "加载工程流程和能力失败：" + str(error), 502)
    try:
        if handoff:
            files, extra = await conversation_handoffs.dispatch_inputs(session, handoff, extra)
        # Content reads can retain the personal Runner policy lock in this
        # transaction. Release preparation locks before transport authorization
        # acquires its own lock; the durable attempt above still fences retries.
        # The transport rechecks current ownership and policy before sending.
        await session.commit()
        r = await _aio.to_thread(ai_exec.dispatch_sync, ctx, t, files, picked, extra)
    except Exception as error:  # noqa: BLE001
        await _fail("dispatch", "Runner 启动 Agent 失败：" + str(error), 502)
    if not r.get("ok"):
        if r.get("uncertain"):
            return await _pending(r.get("error") or "执行机回执暂未确认", r)
        await _fail("dispatch", r.get("error") or "Runner 没有接受这条需求", 502)
    # Mark dispatched work as in progress so scheduled tasks reflect the execution state.
    if t.status == "todo":
        from ..services import task_status
        await task_status.mark(session, t, "doing", why="直派 AI")
    # Record who dispatched to which agent, its runtime, and the supplied context.
    # This supports later diagnosis of incorrect or incomplete outputs.
    _prog = [p for p in (getattr(t, "progress", None) or [])
             if isinstance(p, dict) and (p.get("text") or "").strip()]
    ev.record(session, tid, ai_exec.EV_DISPATCHED,
               {**dispatch_attempts.success_detail(attempt_id, aid, picked),
                "ref": r.get("issueId", ""), "issueId": r.get("issueId", ""),
                "identifier": r.get("identifier", ""),
                "url": r.get("url", ""), "by": who, "provider": r.get("provider", ""),
                "runnerId": r.get("runnerId", ""), "host": r.get("host", ""),
                "assigneeId": r.get("assigneeId", "") or aid,
                "assigneeType": r.get("assigneeType", "agent"),
               "assigneeName": r.get("assigneeName", ""), "assigneeCli": r.get("assigneeCli", ""),
               "files": r.get("files", 0),
               "pluginSnapshot": dict(r.get("pluginSnapshot") or {}),
               "carried": {"note": bool((t.note or "").strip()),
                           "tags": len(getattr(t, "tags", None) or []),
                           "progress": len(_prog), "comments": len(extra.get("comments") or []),
                           "files": [f[0] for f in files][:r.get("files", 0)],
                           "brief": "" if handoff and handoff.options.get("contentRef") else extra["brief"].strip()[:300]}}, actor=who)
    from ..services import execution_sessions as _es
    await _es.record_dispatch(session, t, r)   # Persist the execution at dispatch so routing does not depend on event details alone.
    await audit.log(session, me, "task.ai_dispatch", "task", tid, t.title,
                    {"identifier": r.get("identifier", "")}) if me else None
    await session.commit()
    # Send throttled upgrade guidance after successful dispatch to an outdated Runner.
    try:
        from ..services import update_nudges
        version = str(r.get("runnerVersion") or "")
        if not version and r.get("runnerId"):
            from ..automation_models import RunnerNode
            node = await session.get(RunnerNode, str(r.get("runnerId")))
            version = str(getattr(node, "version", "") or "")
        await update_nudges.nudge_stale_runner(
            str(t.owner_client_id or ""), version, str(r.get("host") or ""))
    except Exception as nudge_error:  # noqa: BLE001
        log.warning("执行机升级提醒失败：%s", type(nudge_error).__name__)
    # Push the final server task snapshot immediately after dispatch.
    # Clients should not wait for a full refresh to display progress.
    task_api = await _push_task(session, t, created=False)
    out = dict(r)
    out["task"] = task_api or task_to_api(t)
    return out
