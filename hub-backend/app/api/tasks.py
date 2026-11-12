"""Client task API contract; X-Soduwork-Device identifies the device and supports initial registration.

"""
import logging
import re
from types import SimpleNamespace

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, Request, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..db import get_session
from ..deps import current_ai_client, authenticated_client, current_client, enforce_client_quota
from ..models import Client, Task, User
from ..realtime import hub
from ..schemas import BatchUpdate, TaskCreate, TaskUpdate, task_to_api
from ..services import audit, task_access
from ..services import task_access as _task_access
from ..services import tasks as svc
from ..services.task_dispatch_context import (
    _ext_project_id, _repo_ctx, _resolve_repo,
    _attach_dev_flow, _attach_skills, _fill_repo_wire, _settle_work_dir,
    _aio_thread, _link_task_repo, _stale_runner_hint, _push_task,
)

router = APIRouter(prefix="/api/v1", tags=["tasks"])
log = logging.getLogger("uvicorn.error")


async def _actor_user(session: AsyncSession, client: Client) -> User | None:
    """Return the client owner for audit attribution, or None when unassigned."""
    return await session.get(User, client.user_ref) if client.user_ref else None


def _actor_label(u: User | None, client: Client) -> str:
    """Prefer the owner's display name for timeline attribution, then the client name or device ID.

    """
    if u:
        return u.display_name or u.username
    return client.name or client.id[:8]


# Personal skill selection is intersected with the Hub's published availability policy.
# Removing a skill from that policy immediately prevents its resolution for this client.
@router.get("/skills")
async def my_skills(client: Client = Depends(current_client),
                    session: AsyncSession = Depends(get_session)):
    from ..services import skills as sk
    try:
        cfg, found = await sk.catalog_with_policy(session, client)
    except sk.PolicyChanged as exc:
        raise HTTPException(409, detail=str(exc)) from exc
    allowed = set(cfg["allowed"])
    from ..services import skill_preferences
    visible = {s["name"] for s in found
               if s["name"] in allowed or s["name"] in sk.BASELINE_SKILLS or (
                   s.get("scope") == "personal" and s.get("ownerClientId") == client.id)
               or s.get("scope") == "local"}
    mine = skill_preferences.selected_names(client, [s for s in found if s["name"] in visible])
    # Never leak Hub-local paths to a client. Availability on the Hub is not
    # the same thing as installation on this SoduWork/Runner; the client combines
    # this portable contract with its verified local cache.
    out = [sk.public_view(s, enabled=s["name"] in mine)
           for s in found if s["name"] in visible]
    return {"skills": out, "enabled": sorted(mine & visible),
            # Identify previously selected skills that administrators no longer allow.
            "revoked": sorted(mine - visible)}


@router.put("/skills")
async def set_my_skills(body: dict = Body(default_factory=dict),
                        client: Client = Depends(current_client),
                        session: AsyncSession = Depends(get_session)):
    from ..services import skills as sk
    try:
        cfg, found = await sk.catalog_with_policy(session, client)
    except sk.PolicyChanged as exc:
        raise HTTPException(409, detail=str(exc)) from exc
    allowed = set(cfg["allowed"])
    own = {s["name"] for s in found
           if ((s.get("scope") == "personal" and
                s.get("ownerClientId") == client.id) or s.get("scope") == "local")}
    want = [str(x)[:64] for x in (body.get("enabled") or [])][:200]
    from ..services import skill_preferences
    await session.refresh(client, with_for_update=True)
    skill_preferences.save_selection(client, want, found, allowed | sk.BASELINE_SKILLS | own)
    await session.commit()
    return {"ok": True, "enabled": client.skills}


# Personal schedules.
from .personal_schedules import (
    _my_sch, _my_sch_api,
    acknowledge_automation_conversation, automation_conversation_inbox,
    claim_automation_conversation, create_my_schedule, delete_my_schedule,
    my_schedule_runs, my_schedule_templates, my_schedules,
    preflight_my_schedule, run_my_schedule, update_my_schedule,
    router as personal_schedule_router,
)

router.include_router(personal_schedule_router)


@router.get("/tasks")
async def get_tasks(client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    return await svc.list_tasks(session, client.id, include_related=True)


@router.post("/tasks")
async def create_task(
    body: TaskCreate, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)
):
    return await svc.create_task(session, client.id, body.model_dump(), origin="local")


@router.post("/tasks/parse")
async def parse_task(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_ai_client),
    session: AsyncSession = Depends(get_session),
    request: Request = None,
):
    """Parse natural language into task fields using this user's effective model, preferring
    body.model. On missing configuration or parsing failure, return empty fields for the title
    fallback.
    """
    from ..services import task_parse_materials, task_parse_response
    # Validate before streaming headers so malformed attachments still get 422.
    task_parse_materials.user_input(str(body.get("text") or "").strip(), body.get("attachments"))

    async def parse():
        return await svc.parse_task_text(session, str(body.get("text") or ""),
                                       client=client, model=str(body.get("model") or ""),
                                       **({"attachments": body["attachments"]} if "attachments" in body else {}),
                                       **({"instruction": str(body.get("instruction") or "")} if "instruction" in body else {}),
                                       **({"automation": body} if body.get("kind") == "automation" else {}))
    if body.get("keepalive") is True or (request is not None and request.headers.get("accept") == task_parse_response.ACCEPT):
        return task_parse_response.response(parse, requirement=body.get("kind") != "automation")
    fields = await parse()
    return {"ok": bool(fields), "fields": fields}


@router.post("/tasks/batch-update")
async def batch_update(
    body: BatchUpdate, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)
):
    return await svc.batch_update(session, client.id, body.ids, body.patch.model_dump(exclude_unset=True))


@router.post("/tasks/clear-done")
async def clear_done(client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    return await svc.clear_done(session, client.id)


@router.get("/tasks/{tid}")
async def get_task(
    tid: str, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)
):
    r = await svc.get_task(session, client.id, tid, include_related=True)
    if r is None:
        raise HTTPException(status_code=404, detail="需求不存在")
    return r


@router.post("/tasks/{tid}/prepare-execution")
async def prepare_requirement_execution(
    tid: str, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)
):
    from ..services import task_execution_claim
    return await task_execution_claim.prepare(session, client, tid)


@router.get("/tasks/{tid}/delivery-state")
async def get_delivery_state(
    tid: str, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)
):
    """Expose the shared delivery-state projection from task status, delivery facts, and approvals.
    Client detail views, boards, and chat receipts must use this projection consistently.
    """
    task = await _view_task(session, client, tid)
    from sqlalchemy import select as _sel
    from .. import automation_models as _am
    from ..services import delivery_truth, task_requirements
    truth = await delivery_truth.evaluate(session, task)
    approvals = []
    rows = (await session.execute(
        _sel(_am.ApprovalRequest).where(_am.ApprovalRequest.task_id == tid)
        .order_by(_am.ApprovalRequest.created_at))).scalars().all()
    for row in rows:
        approvals.append({"id": row.id, "action": row.action, "status": row.status,
                          "artifactVersionId": row.artifact_version_id})
    contract = dict((task.work_routing or {}).get("outputContract") or {})
    blocker_codes = [str(x.get("code") or "") for x in truth.get("blockers") or []]
    # Project association distinguishes post-acceptance merge/release waits from completion failures.
    # Accepted work awaiting a later project gate is a valid intermediate state.
    # Do not render that state as a contradictory blocked task.
    has_engineering = bool(getattr(task, "project_id", None)
                           or str(getattr(task, "repo_id", "") or "").strip())
    awaiting_workflow = has_engineering and blocker_codes == ["managed_workflow_required"]
    if truth.get("state") == "complete":
        phase = "closed"
    elif task.status == "done":
        phase = "accepted"   # Submitted for acceptance; completion may still require another gate.
    elif any(str(x.get("code") or "") == "review_pending" for x in truth.get("blockers") or []):
        phase = "awaiting_acceptance"
    elif any(str(x.get("code") or "") == "review_rejected" for x in truth.get("blockers") or []):
        phase = "rejected_rework"
    elif truth.get("blockers"):
        phase = "blocked"
    elif task.status == "doing":
        phase = "executing"
    else:
        phase = "drafting"
    return {
        "taskId": tid, "phase": phase,
        "status": task.status,
        "requirementStage": task_requirements.stage(task),
        "canComplete": truth.get("canComplete"),
        "state": truth.get("state"),
        "blockers": truth.get("blockers") or [],
        "approvals": approvals,
        "outputContract": contract,
        "reviewedAt": task.reviewed_at.isoformat() if task.reviewed_at else None,
        "engineering": {
            "projectId": getattr(task, "project_id", None),
            "repoId": str(getattr(task, "repo_id", "") or "").strip(),
            "hasEngineering": has_engineering,
            "awaitingWorkflow": awaiting_workflow,
            "phase": ("awaiting_workflow" if awaiting_workflow and phase == "accepted"
                      else "node_pending" if has_engineering and phase == "awaiting_acceptance"
                      else phase),
        },
    }


@router.put("/tasks/{tid}")
async def put_task(
    tid: str, body: TaskCreate,
    client: Client = Depends(current_client), session: AsyncSession = Depends(get_session),
):
    """Create tasks idempotently using client-generated IDs so offline replay cannot create
    duplicates.
    """
    if not re.fullmatch(r"[A-Za-z0-9_-]{3,36}", tid):
        raise HTTPException(status_code=400, detail="需求编号格式不正确")
    result = await svc.put_local_task(session, client.id, tid, body.model_dump(exclude_unset=True))
    if result is None:
        from ..services import task_requirements
        existing = await session.get(Task, tid)
        if existing is None or not await task_requirements.can_read(session, client, existing):
            raise HTTPException(status_code=404, detail="需求不存在")
        raise HTTPException(status_code=409, detail="需求编号已被占用")
    return result


@router.get("/projects")
async def list_projects_for_box(
    client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)
):
    """List projects visible through the user's department and ancestors, managed subtrees, or
    public organization-free projects, matching team-inbox scope.
    """
    from sqlalchemy import or_, select as _sel
    from ..models import Project
    from ..services import inbox as inbox_svc
    u, scope = await inbox_svc._me_scope(session, client)
    q = _sel(Project).where(Project.status == "active")
    q = q.where(or_(Project.org_id.in_(scope), Project.org_id.is_(None))) if scope \
        else q.where(Project.org_id.is_(None))
    rows = (await session.execute(q.order_by(Project.created_at.desc()))).scalars().all()
    return [{"id": p.id, "name": p.name, "desc": p.desc or ""} for p in rows]


@router.get("/repos")
async def list_repos_for_box(
    client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)
):
    """List project repositories without credentials. Return relative localDir values; each device
    resolves its own absolute workspace path.
    """
    from sqlalchemy import or_, select as _sel

    from ..models import Project, Repo
    from ..services import inbox as inbox_svc
    u, scope = await inbox_svc._me_scope(session, client)
    q = _sel(Project).where(Project.status == "active")
    q = q.where(or_(Project.org_id.in_(scope), Project.org_id.is_(None))) if scope \
        else q.where(Project.org_id.is_(None))
    projs = {p.id: p for p in (await session.execute(q)).scalars().all()}
    if not projs:
        return {"repos": []}
    rows = (await session.execute(
        _sel(Repo).where(Repo.project_id.in_(list(projs.keys()))).order_by(Repo.created_at)
    )).scalars().all()
    return {"repos": [{"id": r.id, "projectId": r.project_id,
                       "projectName": projs[r.project_id].name if r.project_id in projs else "",
                       "name": r.name, "kind": r.kind, "gitUrl": r.git_url,
                       "branch": r.default_branch, "localDir": r.local_dir,
                       "note": r.note} for r in rows]}


@router.get("/daily-report")
async def get_daily_report(
    date: str = "", client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)
):
    """Read the user's report for the requested date, defaulting to today; return report=None and
    source counts when absent.
    """
    from ..services import daily_report as dr
    u = await _actor_user(session, client)
    if u is None:
        raise HTTPException(status_code=400, detail="本 SoduWork 未绑定用户，请让管理员分配归属")
    day = (date or "").strip() or dr.today_str()
    from sqlalchemy import select as _sel
    from ..models import DailyReport
    rep = (await session.execute(
        _sel(DailyReport).where(DailyReport.user_id == u.id, DailyReport.date == day,
                                DailyReport.period_type == "daily")
    )).scalars().first()
    mat = await dr.collect(session, u.id, day)
    return {"date": day, "report": (dr.to_api(rep) if rep else None),
            "hasMaterial": bool(mat["items"] or mat.get("open")), "activeCount": len(mat["items"]),
            "progressCount": mat["progressCount"], "doneCount": len(mat["done"])}


@router.post("/daily-report/generate")
async def gen_daily_report(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)
):
    """Generate or regenerate the user's report immediately for the requested day."""
    from ..services import daily_report as dr
    u = await _actor_user(session, client)
    if u is None:
        raise HTTPException(status_code=400, detail="本 SoduWork 未绑定用户，请让管理员分配归属")
    day = (body.get("date") or "").strip() or dr.today_str()
    rep = await dr.generate_for(session, u, day, notify=False)
    if rep is None:
        raise HTTPException(status_code=400, detail="今天还没有进展记录，先在需求里写一条再生成")
    return {"ok": True, "report": dr.to_api(rep)}


@router.get("/tasks/{tid}/events")
async def task_events_timeline(
    tid: str, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)
):
    """Return owned-task timeline events covering creation, claiming, assignment, transfers,
    workflow transitions, and completion receipts.
    """
    from ..services import task_access, task_events as ev
    await task_access.view_task(session, client, tid)
    return {"events": await ev.timeline(session, tid)}


@router.get("/ai-desks")
async def ai_desks(
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Aggregate direct AI assignments and plugin workflows for the workbench; load live details on
    demand.
    """
    import asyncio as _aio
    from ..services import ai_exec, aidesk_view, live_view_cache

    async def _build():
        ctx = await ai_exec.load(session)
        ctx = ai_exec.with_client_runner_scope(ctx, client.id)
        roster = {"agents": [], "squads": []}
        reason = ""
        if ai_exec.available(ctx):
            try:
                roster = await _aio.to_thread(ai_exec.list_assignees_sync, ctx) or roster
            except Exception:  # noqa: BLE001  Roster lookup failure must not prevent the workbench from loading.
                reason = "智能体名单没拉到"
        else:
            reason = "AI 执行还没配好"
        return await aidesk_view.build(session, client, ctx, roster, reason)

    return await live_view_cache.get_or_build("ai-desks", client.id, "", _build, ttl=3.0, actor=client)


@router.post("/ai-desks/cleanup-abnormal")
async def cleanup_ai_desk_abnormal(
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Clear failed AI-team cards without deleting their task evidence.

    The view is rebuilt from the same durable execution tables used by GET
    /ai-desks.  Only tasks projected as ``failed`` are eligible; active,
    dispatching and human-review work is never cancelled by this bulk action.
    """
    from ..services import ai_exec, aidesk_cleanup, aidesk_view, live_view_cache

    ctx = await ai_exec.load(session)
    ctx = ai_exec.with_client_runner_scope(ctx, client.id)
    view = await aidesk_view.build(
        session,
        client,
        ctx,
        {"agents": [], "squads": []},
        "",
    )
    result = await aidesk_cleanup.cleanup_abnormal(session, client, view)
    # Even an idempotent/no-op cleanup must not leave a stale failed snapshot
    # in this client's short-lived workbench cache.
    live_view_cache.invalidate(client.id)
    return result


@router.get("/ai-consoles")
async def ai_consoles(
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Behavior and constraints for this operation."""
    import asyncio as _aio

    from sqlalchemy import select as _sel

    from ..models import Task as _T
    from ..services import ai_exec

    from ..services import execution_sessions

    ctx = await ai_exec.load(session)
    r = await _aio.to_thread(ai_exec.console_list_sync, ctx, None)
    runs = (r or {}).get("runs") or []
    # Include remote Runner sessions because they are absent from this process's in-memory state.

    # Read persisted state for polling; the in-memory session-to-machine map does not survive restarts.
    remote = await execution_sessions.console_rows(
        session, client.id, exclude_refs={x.get("ref") for x in runs if x.get("ref")})
    if not runs and not remote:
        return {"runs": [], "supported": ai_exec.available(ctx)}
    mine = {t.id: t for t in (await session.execute(
        _sel(_T).where(_T.id.in_([x.get("taskId") for x in runs if x.get("taskId")] or ["-"]),
                       _task_access.owner_clause(client)))).scalars().all()}
    out = []
    for x in runs:
        t = mine.get(x.get("taskId") or "")
        if t is None:
            continue                       # Restrict session visibility to owned tasks because output includes workspace paths and source text.
        x["title"] = t.title or x.get("title") or ""
        x["taskStatus"] = t.status
        x.setdefault("local", True)
        out.append(x)
    out.extend(remote)                      # console_rows already applies ownership filtering.
    out.sort(key=lambda x: (x.get("state") != "running", -(x.get("started") or 0)))
    return {"runs": out, "supported": True}


@router.get("/tasks/{tid}/ai-raw")
async def ai_raw_task(
    tid: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Return unmodified terminal output for diagnostics alongside the structured view."""
    import asyncio as _aio

    from ..services import ai_exec
    t = await session.get(Task, tid)
    if t is None or not _task_access.is_owner(t, client):
        raise HTTPException(status_code=404, detail="需求不存在")
    ev_row = await ai_exec.last_dispatch_event(session, tid)
    if ev_row is None:
        return {"ok": False, "text": "", "error": "这条需求还没交给 AI"}
    ctx = await ai_exec.load(session)
    d = ev_row.detail or {}
    return await _aio.to_thread(ai_exec.raw_tail_sync, ctx,
                                d.get("ref") or d.get("issueId", ""), 60000)


@router.get("/ai-agents")
async def list_ai_agents(
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """List dispatchable agents with their CLI types through services.ai_exec, without credentials.
    Unavailable execution services return an empty list and explanatory reason.
    """
    import asyncio as _aio

    from ..services import ai_exec, model_catalog
    ctx = ai_exec.with_client_runner_scope(
        await ai_exec.load(session, force=True), client.id)
    r = await _aio.to_thread(ai_exec.list_assignees_sync, ctx)
    r["provider"] = ai_exec.provider_name(ctx)
    r["default"] = ai_exec.default_assignee(ctx)
    r["kinds"] = ai_exec.agent_kinds()
    # Expose model names for stage selection without gateway addresses or credentials.
    legacy_models = ai_exec.model_choices(ctx)
    mc = await model_catalog.choices(
        session, client, str(legacy_models.get("default") or ""))
    r["defaultModel"] = mc["default"]
    r["models"] = mc["list"]
    r["modelOptions"] = mc["items"]
    if not r["agents"] and not r["squads"]:
        r["reason"] = ("尚未配置托管底座，也没有检测到本机 CLI 或在线 Runner"
                       if not ai_exec.available(ctx) else "当前没有可用的智能体或小队")
    return r


# Personal model configuration.
from .personal_models import (
    my_models, put_my_models, test_my_model, router as personal_model_router,
)

router.include_router(personal_model_router)

def _iso_utc(dt) -> str:
    """Behavior and constraints for this operation."""
    if not dt:
        return ""
    try:
        from datetime import timezone as _tz
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_tz.utc)
        return dt.astimezone(_tz.utc).isoformat()
    except Exception:  # noqa: BLE001  Malformed timestamps must not prevent the workbench from loading.
        return ""


@router.post("/tasks/{tid}/ai-preview")
async def ai_dispatch_preview(
    tid: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Behavior and constraints for this operation."""
    from ..services import ai_exec
    t = await session.get(Task, tid)
    if t is None or not _task_access.is_owner(t, client):
        raise HTTPException(status_code=404, detail="需求不存在")
    ctx = await ai_exec.load(session)
    names = await ai_exec.list_task_file_names(session, tid)
    extra = await ai_exec.collect_task_context(session, tid)
    extra["brief"] = str(body.get("brief") or "")[:2000]
    extra["files"] = names
    extra["repo"] = _repo_ctx(body)
    # Apply the same configuration to preview and dispatch.
    # Include repository overrides so the preview does not incorrectly show global defaults.
    await _attach_dev_flow(session, extra["repo"])
    await _attach_skills(session, extra, extra["repo"], client)   # Include selected skills in the preview as they appear in execution.
    extra["extProjectId"] = await _ext_project_id(session, t)
    p = ai_exec.preview(t, ctx, extra)
    prog = [x for x in (getattr(t, "progress", None) or [])
            if isinstance(x, dict) and (x.get("text") or "").strip()]
    return {"title": p["title"], "description": p["description"],
            "provider": ai_exec.provider_name(ctx),
            "carried": {"note": bool((t.note or "").strip()), "tags": len(getattr(t, "tags", None) or []),
                        "progress": len(prog), "comments": len(extra.get("comments") or []),
                        "files": names, "brief": bool(extra["brief"].strip())}}


@router.post("/tasks/{tid}/conversation-turn")
async def conversation_task_turn(
    tid: str, body: dict = Body(default_factory=dict),
    client: Client = Depends(authenticated_client),
    session: AsyncSession = Depends(get_session),
):
    from sqlalchemy import select
    from ..services import conversation_turns, task_access
    task = (await session.execute(select(Task).where(
        Task.id == tid, _task_access.owner_clause(client)
    ).with_for_update())).scalar_one_or_none()
    if task is None:
        raise HTTPException(404, "需求不存在或不属于当前设备")
    if str(body.get("action") or "prepare") not in {"complete", "fail", "wait", "cancel"}:
        await enforce_client_quota(session, client)
    actor = await _actor_user(session, client)
    receipt = await conversation_turns.apply(session, task, body, _actor_label(actor, client))
    await session.commit()
    task_api = await svc.task_to_api_live(session, task)
    try:
        await task_access.publish_task(session, task, "task.updated", task_api)
    except Exception as error:  # delivery is committed even if realtime is unavailable
        log.warning("推送会话任务变更失败：%s", type(error).__name__)
    return {"ok": True, "turn": receipt, "task": task_to_api(task)}


@router.post("/tasks/{tid}/conversation-delivery")
async def conversation_task_delivery(
    tid: str,
    files: list[UploadFile] = File(...),
    conversation_id: str = Form(default="", alias="conversationId"),
    turn_id: str = Form(default="", alias="turnId"),
    paths: list[str] = Form(default_factory=list),
    categories: list[str] = Form(default_factory=list),
    model: str = Form(default=""),
    outcome: str = Form(default="completed"),
    client: Client = Depends(authenticated_client),
    session: AsyncSession = Depends(get_session),
):
    """Import completed conversation-turn artifacts under the delivery contract, record
    ai.artifacts evidence, freeze candidate versions, and notify the creator for review.
    """
    from sqlalchemy import select
    from ..services import conversation_turns
    # Only completed turns may freeze candidate versions and create review requests.
    # Failed, waiting, stopped, or unknown turn states retain evidence without requesting acceptance.
    # Treat unknown states as incomplete to avoid submitting unfinished outputs.
    normalized_outcome = "completed" if str(outcome or "").strip() == "completed" else "incomplete"
    task = (await session.execute(select(Task).where(
        Task.id == tid, _task_access.owner_clause(client)
    ).with_for_update())).scalar_one_or_none()
    if task is None:
        raise HTTPException(404, "需求不存在或不属于当前设备")
    if len(paths) != len(files):
        raise HTTPException(422, "产出文件名与文件数量不一致")
    if not isinstance(categories, list):
        categories = []
    if categories and (len(categories) != len(files) or
                       any(value not in {"primary", "supporting", "evidence", "internal"} for value in categories)):
        raise HTTPException(422, "产出分类与文件数量不一致")
    prepared = []
    prepared_categories = {}
    from ..services import delivery_manifest
    for index, (path, file) in enumerate(zip(paths, files)):
        data = await file.read()
        max_bytes = get_settings().attach_max_mb * 1024 * 1024
        if len(data) > max_bytes:
            raise HTTPException(413, f"产出 {file.filename} 超过 {get_settings().attach_max_mb}MB 上限")
        if not data:
            continue
        relative = str(path or file.filename or "").replace("\\", "/").strip("/")[:600]
        name = relative or delivery_manifest.normalize_name(file.filename)
        prepared.append((name, data, file.content_type or "application/octet-stream"))
        if categories:
            prepared_categories[name] = categories[index]
    try:
        result = await conversation_turns.deliver_artifacts(
            session, task, conversation_id=conversation_id[:180],
            turn_id=turn_id[:120], provider=model[:80], files=prepared,
            categories=prepared_categories,
            outcome=normalized_outcome)
    except HTTPException:
        raise
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return result


@router.post("/tasks/{tid}/ai-dispatch")
async def ai_dispatch_task(
    tid: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Dispatch an owned requirement through the shared execution pipeline."""
    from ..services.task_dispatch import dispatch
    return await dispatch(tid, body, client, session)


# Long tasks: plan first, then execute one milestone per round.
# The milestone workflow has three actions; see models.Milestone and services.ai_exec.
# ai-plan creates a plan without changing code.
# milestones lets reviewers edit scope, ordering, and acceptance criteria.
# ai-run-milestone resumes the existing execution rather than creating a new one.
# Reusing the execution preserves the prior workspace and session.

async def _my_task(session: AsyncSession, client: Client, tid: str) -> Task:
    return await task_access.require_owned_task(session, client, tid)


async def _view_task(session: AsyncSession, client: Client, tid: str) -> Task:
    from ..services import task_access
    return await task_access.view_task(session, client, tid)


async def _dispatch_ref(session: AsyncSession, tid: str) -> str:
    """Return the task's execution ID, including historical multica.* dispatch events."""
    from ..services import ai_exec
    ev_row = await ai_exec.last_dispatch_event(session, tid)
    if ev_row is None:
        return ""
    d = ev_row.detail or {}
    return d.get("ref") or d.get("issueId", "") or ""


def _ms_api(m) -> dict:
    return {"id": m.id, "seq": m.seq, "title": m.title, "accept": m.accept,
            "repoId": m.repo_id, "status": m.status, "rounds": m.rounds,
            "parallelOk": bool(m.parallel_ok), "note": m.note,
            # Empty agent/model selections inherit the task's dispatch settings.
            "agentId": getattr(m, "agent_id", "") or "",
            "agentType": getattr(m, "agent_type", "") or "",
            "model": getattr(m, "model", "") or ""}


async def _load_milestones(session: AsyncSession, tid: str) -> list:
    from sqlalchemy import select as _sel

    from ..models import Milestone
    rows = (await session.execute(
        _sel(Milestone).where(Milestone.task_id == tid).order_by(Milestone.seq))).scalars().all()
    return list(rows)


@router.post("/tasks/{tid}/ai-plan")
async def ai_plan_task(
    tid: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_ai_client),
    session: AsyncSession = Depends(get_session),
):
    """Create a planning-only execution without code changes so a reviewer can confirm direction
    before implementation.
    """
    import asyncio as _aio

    from ..services import ai_exec
    from ..services import task_events as ev
    t = await _my_task(session, client, tid)
    if t.status == "done":
        raise HTTPException(status_code=400, detail="需求已完成，不用再出计划")
    ctx = await ai_exec.load(session, force=True)
    aid = str(body.get("assigneeId") or "").strip()
    atype = str(body.get("assigneeType") or "").strip().lower()
    if atype not in ("agent", "squad"):
        atype = ""
    if not aid and not ai_exec.enabled(ctx):
        raise HTTPException(status_code=409, detail="AI 执行还没配好，请让管理员在后台配置")
    picked = None
    if aid:
        picked = await _aio.to_thread(
            ai_exec.resolve_requested_sync, ctx, aid, atype, client.id)
        if picked is None:
            raise HTTPException(status_code=400, detail="选中的 AI 已经不在了，请重新选一个")
    extra = await ai_exec.collect_task_context(session, tid)
    extra["brief"] = str(body.get("brief") or "")[:2000]
    extra["repo"] = _repo_ctx(body)
    _repo = await _resolve_repo(session, extra["repo"])
    _remote = str((picked or {}).get("id") or "").startswith(ai_exec.REMOTE_PREFIX)
    _wd = await _settle_work_dir(session, client, _repo, extra["repo"], tid, remote=_remote)
    if not _wd.get("ok"):
        raise HTTPException(status_code=400, detail=_wd.get("detail") or "工作目录没准备好")
    extra["workDir"] = _wd.get("dir", "")
    extra["workRoot"] = _wd.get("workRoot", "")
    # Preparation may await external discovery. Re-authorize under a short
    # write reservation before mutating the task or recording dispatch intent.
    from ..services import conversation_turns, dispatch_attempts
    await task_access.reserve_task_write(session, tid, client.id)
    t = await session.get(Task, tid, with_for_update=True, populate_existing=True)
    if t is None or not task_access.is_owner(t, client):
        raise HTTPException(409, "Task ownership changed; refresh before planning")
    try:
        conversation_turns.ensure_available(t)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    if t.status in {"done", "cancel"}:
        raise HTTPException(409, "Task is already closed; refresh before planning")
    active_dispatch = await dispatch_attempts.existing(session, tid, t.status)
    if active_dispatch is not None:
        return active_dispatch
    _link_task_repo(t, _repo)
    extra["extProjectId"] = await _ext_project_id(session, t)
    extra["mode"] = "plan"
    extra["planRule"] = ai_exec.plan_headline()
    extra["planDeliver"] = ai_exec.PLAN_DELIVER
    # Omit attachments during planning; include them when implementation begins.
    me = await _actor_user(session, client)
    who = (me.display_name or me.username) if me else "operator"
    attempt_id = await dispatch_attempts.start(session, tid, who, aid, atype, str(body.get("model") or ""))
    extra["dispatchId"] = attempt_id
    try:
        r = await _aio.to_thread(ai_exec.dispatch_sync, ctx, t, None, picked, extra)
    except Exception as error:
        # A transport exception cannot prove the Runner did not start. Keep the
        # existing uncertain receipt until reconciliation confirms it.
        dispatch_attempts.uncertain(session, tid, who, attempt_id, error, aid, picked)
        await session.commit()
        raise HTTPException(502, "Runner acknowledgement is pending; check execution history") from error
    if not r.get("ok"):
        if r.get("uncertain"):
            dispatch_attempts.uncertain(session, tid, who, attempt_id, r.get("error"), aid, picked)
            await session.commit()
        else:
            await dispatch_attempts.failed(session, tid, who, attempt_id, "dispatch", r.get("error"), aid, picked, True)
        raise HTTPException(status_code=502, detail="AI planning failed: " + str(r.get("error"))[:120])
    ev.record(session, tid, ai_exec.EV_DISPATCHED,
               {**dispatch_attempts.success_detail(attempt_id, aid, picked),
                "ref": r.get("issueId", ""), "issueId": r.get("issueId", ""),
                "identifier": r.get("identifier", ""), "url": r.get("url", ""),
                "by": who, "provider": r.get("provider", ""), "mode": "plan",
                "runnerId": r.get("runnerId", ""), "host": r.get("host", ""),
                "assigneeId": r.get("assigneeId", "") or aid,
                "assigneeType": r.get("assigneeType", "agent"),
               "assigneeName": r.get("assigneeName", ""), "assigneeCli": r.get("assigneeCli", "")},
              actor=who)
    from ..services import execution_sessions as _es
    await _es.record_dispatch(session, t, r)
    await session.commit()
    return r


@router.post("/tasks/batch-dispatch")
async def batch_dispatch(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Batch same-project tasks into one execution with one milestone per source task. Preserve
    individual commits, acceptance, and traceability, plus retry and repository-concurrency
    limits.
    """
    import asyncio as _aio

    from ..models import Milestone
    from ..services import ai_exec
    from ..services import task_events as ev
    from ..services import tasks as tsvc

    ids = [str(x) for x in (body.get("taskIds") or []) if str(x).strip()][:20]
    if len(ids) < 2:
        raise HTTPException(status_code=400, detail="至少选两条才谈得上合并")
    locked = {}
    for tid in sorted(set(ids)):
        await task_access.reserve_task_write(session, tid, client.id)
        t = await session.get(Task, tid, with_for_update=True, populate_existing=True)
        if t is None or not task_access.is_owner(t, client):
            raise HTTPException(status_code=404, detail="Task is not owned by this account: " + tid)
        if t.status in ("done", "cancel"):
            raise HTTPException(status_code=400, detail=f"Task {t.title!r} is already closed")
        locked[tid] = t
    rows = [locked[tid] for tid in ids]
    # Merge only within one project because execution and parallel work are scoped to a repository.
    # Combining separate repositories would force one agent to switch between unrelated workspaces.
    pids = {getattr(t, "project_id", None) for t in rows}
    if len(pids) > 1:
        raise HTTPException(status_code=400, detail="这些活不在同一个项目里，跨工程合并只会互相干扰")

    ctx = await ai_exec.load(session, force=True)
    aid = str(body.get("assigneeId") or "").strip()
    atype = str(body.get("assigneeType") or "").strip().lower()
    if atype not in ("agent", "squad"):
        atype = ""
    if not aid and not ai_exec.enabled(ctx):
        raise HTTPException(status_code=409, detail="AI 执行还没配好")
    picked = None
    if aid:
        picked = await _aio.to_thread(
            ai_exec.resolve_requested_sync, ctx, aid, atype, client.id)
        if picked is None:
            raise HTTPException(status_code=400, detail="选中的 AI 已经不在了")

    me = await _actor_user(session, client)
    who = (me.display_name or me.username) if me else "承办人"
    # Create a new batch task to own execution and milestones; link original tasks through src_task_id.
    # Retain original tasks, which may be externally owned and read-only.
    title = str(body.get("title") or "").strip()[:200] or \
        f"合并处理 {len(rows)} 条：{rows[0].title[:20]}…"
    batch = Task(owner_client_id=client.id, title=title, status="doing")   # Use the model's default UUID.
    batch.project_id = rows[0].project_id
    # Include every source task's description, not only its title, in dispatch instructions.
    # The composed task title and note must carry reproduction steps and acceptance criteria to the AI.
    # Similar titles alone are insufficient to identify the required fixes.
    # This text appears directly in task details without Markdown rendering.
    # Use plain-text emphasis rather than Markdown bold markers.
    _parts = ["本批合并自以下 %d 条，请「一条一条改、每条单独提交」：" % len(rows)]
    for i, t in enumerate(rows, 1):
        _parts.append(f"\n{i}. {t.title}")
        _d = (t.note or "").strip()
        if _d:
            _parts.append("   " + _d[:800].replace("\n", "\n   "))
        if getattr(t, "external_url", None):
            _parts.append("   原文：" + str(t.external_url))
    batch.note = "\n".join(_parts)[:8000]
    batch.created_by = getattr(me, "id", None)
    batch.created_by_name = who
    session.add(batch)
    await session.flush()
    for i, t in enumerate(rows):
        session.add(Milestone(task_id=batch.id, seq=i, title=t.title[:300],
                              accept=(t.note or "").strip()[:2000], src_task_id=t.id))
    await session.flush()

    extra = await ai_exec.collect_task_context(session, batch.id)
    extra["brief"] = str(body.get("brief") or "")[:2000]
    extra["repo"] = _repo_ctx(body)
    _repo = await _resolve_repo(session, extra["repo"])
    # Use the client's configured workspace; clone the repository on first use.
    _remote = str((picked or {}).get("id") or "").startswith(ai_exec.REMOTE_PREFIX)
    _wd = await _settle_work_dir(session, client, _repo, extra["repo"], batch.id, remote=_remote)
    if not _wd.get("ok"):
        raise HTTPException(status_code=400, detail=_wd.get("detail") or "工作目录没准备好")
    extra["workDir"] = _wd.get("dir", "")
    extra["workRoot"] = _wd.get("workRoot", "")
    # Preserve the inherited project_id and fill it only when missing.
    _link_task_repo(batch, _repo)
    await _attach_dev_flow(session, extra["repo"], _repo)
    await _attach_skills(session, extra, extra["repo"], client)
    extra["extProjectId"] = await _ext_project_id(session, batch)
    extra = await ai_exec.with_project_context(session, extra, batch, _repo)
    # Use the inherited task owner's code credentials for batch commits.
    ctx = await ai_exec.with_task_git(session, ctx, batch)
    from ..services import task_execution_model
    try:
        ctx, extra["agentExecution"] = await task_execution_model.prepare(
            session, client, ctx, picked or ai_exec.default_assignee(ctx),
            str(body.get("model") or ""), str(body.get("reasoningEffort") or ""))
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    # Source-task milestones already define the batch plan; do not generate a second decomposition.
    r = await _aio.to_thread(ai_exec.dispatch_sync, ctx, batch, None, picked, extra)
    if not r.get("ok"):
        raise HTTPException(status_code=502, detail="批量安排执行失败：" + str(r.get("error"))[:120])
    ev.record(session, batch.id, ai_exec.EV_DISPATCHED,
               {"ref": r.get("issueId", ""), "issueId": r.get("issueId", ""),
                "identifier": r.get("identifier", ""), "url": r.get("url", ""), "by": who,
                "provider": r.get("provider", ""), "batch": len(rows),
                "runnerId": r.get("runnerId", ""), "host": r.get("host", ""),
                "assigneeId": r.get("assigneeId", "") or aid,
                "assigneeType": r.get("assigneeType", "agent"),
               "assigneeName": r.get("assigneeName", ""), "assigneeCli": r.get("assigneeCli", "")},
              actor=who)
    from ..services import execution_sessions as _es
    await _es.record_dispatch(session, batch, r)
    ev.record(session, batch.id, "ai.plan_set",
              {"count": len(rows), "skipped": 0, "titles": [t.title for t in rows][:12],
               "batch": True}, actor=who)
    # Record the batch association on each source task for traceability.
    for t in rows:
        ev.record(session, t.id, "ai.batched",
                  {"batchId": batch.id, "batchTitle": title, "n": len(rows)}, actor=who)
        if t.status == "todo":
            from ..services import task_status
            await task_status.mark(session, t, "doing", why="并入合并批次")
    await session.commit()
    # Push both the server-created batch task and changed source tasks to clients.
    # Clients must observe authoritative changes rather than retaining stale task status.
    await _push_task(session, batch, created=True)
    for t in rows:
        await _push_task(session, t, created=False)
    return {"ok": True, "batchId": batch.id, "count": len(rows),
            "identifier": r.get("identifier", "")}


@router.get("/tasks/{tid}/milestones")
async def get_milestones(
    tid: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Return saved milestones and, only when none exist, the draft plan from execution. Never
    overwrite a human-confirmed plan with later AI output.
    """
    import asyncio as _aio

    from ..services import ai_exec
    await _view_task(session, client, tid)
    rows = await _load_milestones(session, tid)
    out = {"items": [_ms_api(m) for m in rows], "draft": None}
    if rows:
        return out
    # Read a draft only after an actual planning round.
    # Ordinary numbered AI responses are not milestone plans.
    # Do not expose milestone UI for unrelated executions.
    ev_row = await ai_exec.last_dispatch_event(session, tid)
    if ev_row is None or (ev_row.detail or {}).get("mode") != "plan":
        return out
    ref = (ev_row.detail or {}).get("ref") or (ev_row.detail or {}).get("issueId", "")
    if not ref:
        return out
    ctx = await ai_exec.load(session)
    d = await _aio.to_thread(ai_exec.plan_draft, ctx, ref)
    if d.get("ok") and (d.get("items") or d.get("raw")):
        out["draft"] = {"items": d.get("items") or [], "raw": d.get("raw") or ""}
    return out


@router.put("/tasks/{tid}/milestones")
async def put_milestones(
    tid: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Replace the human-edited milestone list while preserving state and round counts for
    milestones already executed.
    """
    from ..models import Milestone
    from ..services import task_events as ev
    t = await _my_task(session, client, tid)
    items = body.get("items")
    if not isinstance(items, list):
        raise HTTPException(status_code=400, detail="items 要是一个列表")
    if len(items) > 30:
        raise HTTPException(status_code=400, detail="里程碑太多了（最多 30 个），先拆成几条需求吧")
    old = {m.id: m for m in await _load_milestones(session, tid)}
    keep: set[str] = set()
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            continue
        title = str(it.get("title") or "").strip()[:300]
        if not title:
            continue
        mid = str(it.get("id") or "").strip()
        m = old.get(mid)
        if m is None:
            m = Milestone(task_id=tid)
            session.add(m)
        m.seq = i
        m.title = title
        m.accept = str(it.get("accept") or "").strip()[:2000]
        m.repo_id = str(it.get("repoId") or "")[:36]
        m.parallel_ok = bool(it.get("parallelOk"))
        # Each stage may override its executor and model.
        m.agent_id = str(it.get("agentId") or "")[:64]
        m.agent_type = str(it.get("agentType") or "")[:16]
        m.model = str(it.get("model") or "")[:120]
        st = str(it.get("status") or "").strip()
        # Accept only user-editable states: skipped or planned.
        # Execution determines doing, done, and failed; clients cannot assign those results directly.
        # Preserve current state for other values instead of defaulting to planned.
        # Editing a title must not silently unskip a milestone.
        if st in ("planned", "skipped"):
            m.status = st
        elif not m.status:          # Assign default state only to newly created milestones.
            m.status = "planned"
        await session.flush()
        keep.add(m.id)
    for mid, m in old.items():
        if mid not in keep:
            await session.delete(m)
    rows = await _load_milestones(session, tid)
    me = await _actor_user(session, client)
    ev.record(session, tid, "ai.plan_set",
              {"count": len([m for m in rows if m.status != "skipped"]),
               "skipped": len([m for m in rows if m.status == "skipped"]),
               "titles": [m.title for m in rows][:12]},
              actor=(me.display_name or me.username) if me else "承办人")
    await session.commit()
    rows = await _load_milestones(session, tid)
    return {"items": [_ms_api(m) for m in rows]}


async def _stage_switch(session: AsyncSession, tid: str, m, ref: str) -> dict | None:
    """Return a new agent selection only when the milestone's agent_id differs from the current
    execution; otherwise reuse the existing workspace and session.
    """
    aid = (getattr(m, "agent_id", "") or "").strip()
    if not aid:
        return None
    from ..services import ai_exec
    ev_row = await ai_exec.last_dispatch_event(session, tid)
    cur = ((ev_row.detail or {}) if ev_row else {}).get("assigneeId") or ""
    if cur and cur == aid:
        return None                      # Resume the current executor rather than creating a redundant execution.
    return {"id": aid, "type": (getattr(m, "agent_type", "") or "agent")}


async def _run_stage_with(session: AsyncSession, t, m, idx: int, total: int,
                          repo_ctx: dict, ctx: dict, who_spec: dict, actor: str,
                          brief: str) -> dict:
    """Create a new execution when changing agents and include the previous milestone's outputs,
    branch, and handoff context.
    """
    import asyncio as _aio

    from ..services import ai_exec
    from ..services import task_events as ev

    picked = await _aio.to_thread(
        ai_exec.resolve_requested_sync, ctx, who_spec["id"], who_spec["type"],
        str(t.owner_client_id or ""))
    if picked is None:
        return {"ok": False, "error": "这一环配的执行者已经不在了：" + who_spec["id"]}

    # Include summaries from the three most recent completed milestones in order.
    rows = await _load_milestones(session, t.id)
    done = [x for x in rows if x.status == "done" and x.seq < m.seq]
    hand = ""
    if done:
        hand = "\n【前面几环已经做完了（不是你做的，换人接力）】\n" + "\n".join(
            "- %s：%s" % (x.title, (x.note or "（没留小结）").strip()[:300]) for x in done[-3:])
        hand += "\n动手前先看一眼工作目录里的现状和 `进度.md`，别把已经做好的又重做一遍。\n"

    extra = await ai_exec.collect_task_context(session, t.id)
    extra["brief"] = (brief + hand)[:12000]
    extra["repo"] = repo_ctx or {}
    await _attach_dev_flow(session, extra["repo"])
    await _attach_skills(session, extra, extra["repo"], None)
    extra["extProjectId"] = await _ext_project_id(session, t)
    from ..services import task_execution_model
    owner = await session.get(Client, t.owner_client_id) if t.owner_client_id else None
    try:
        ctx, extra["agentExecution"] = await task_execution_model.prepare(
            session, owner, ctx, picked, str(getattr(m, "model", "") or ""))
    except ValueError as error:
        return {"ok": False, "error": str(error)}
    # Changing agents must preserve the task owner's commit identity.
    # Apply that identity on automatic transitions to AI stages as well.
    ctx = await ai_exec.with_task_git(session, ctx, t)
    extra = await ai_exec.with_project_context(session, extra, t)

    r = await _aio.to_thread(ai_exec.dispatch_sync, ctx, t, None, picked, extra)
    if not r.get("ok"):
        return {"ok": False, "error": r.get("error", "")}
    ev.record(session, t.id, ai_exec.EV_DISPATCHED,
               {"ref": r.get("issueId", ""), "issueId": r.get("issueId", ""),
                "identifier": r.get("identifier", ""), "url": r.get("url", ""), "by": actor,
                "provider": r.get("provider", ""),
                "runnerId": r.get("runnerId", ""), "host": r.get("host", ""),
                "assigneeId": who_spec["id"], "assigneeType": r.get("assigneeType", "agent"),
               "assigneeName": r.get("assigneeName", ""), "assigneeCli": r.get("assigneeCli", ""),
               # Record the milestone associated with the new execution for timeline attribution.
               "stage": {"id": m.id, "title": m.title, "idx": idx, "total": total,
                         "model": (m.model or "")}},
              actor=actor)
    from ..services import execution_sessions as _es
    await _es.record_dispatch(session, t, r)
    return {"ok": True, "ref": r.get("issueId", ""), "name": r.get("assigneeName", "")}


@router.post("/tasks/{tid}/ai-run-milestone")
async def run_milestone(
    tid: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Run the selected or next planned milestone on the existing execution. Require a prior plan,
    stop after two unsuccessful rounds, and prevent overlapping work unless both milestones
    allow parallel execution in different repositories.
    """
    import asyncio as _aio

    from ..services import ai_exec
    from ..services import task_events as ev
    t = await _my_task(session, client, tid)
    ref = await _dispatch_ref(session, tid)
    if not ref:
        raise HTTPException(status_code=409, detail="这条需求还没交给 AI，先让它出个计划")
    rows = await _load_milestones(session, tid)
    live = [m for m in rows if m.status != "skipped"]
    if not live:
        raise HTTPException(status_code=409, detail="还没有里程碑，先确认一份计划")
    mid = str(body.get("id") or "").strip()
    if mid:
        m = next((x for x in live if x.id == mid), None)
        if m is None:
            raise HTTPException(status_code=404, detail="没有这个里程碑")
    else:
        m = next((x for x in live if x.status in ("planned", "failed")), None)
        if m is None:
            raise HTTPException(status_code=409, detail="里程碑都做完了")
    if m.rounds >= 2 and m.status != "done":
        raise HTTPException(
            status_code=409,
            detail=f"「{m.title}」已经跑了 {m.rounds} 轮还没过验收，先看看是不是拆得太大或说得不清楚")
    running = [x for x in live if x.status == "doing" and x.id != m.id]
    if running and not (m.parallel_ok and all(x.parallel_ok for x in running)
                        and m.repo_id and all(x.repo_id != m.repo_id for x in running)):
        raise HTTPException(status_code=409,
                            detail=f"「{running[0].title}」还在做。同一个工程里并行改必冲突，等它回来再开下一个")
    ctx = await ai_exec.load(session, force=True)
    if not ai_exec.available(ctx):
        raise HTTPException(status_code=409, detail="AI 执行还没配好")
    idx = live.index(m) + 1
    # Include the task ID so milestone instructions can select the correct work branch.

    _mrepo = _repo_ctx(body)
    # Resolve the branch with the same configurable template used at initial dispatch.
    await _attach_dev_flow(session, _mrepo)
    text = ai_exec.milestone_brief(_ms_api(m), idx, len(live), _mrepo, t.id)
    me = await _actor_user(session, client)
    who = (me.display_name or me.username) if me else "承办人"

    # An executor change requires a new execution record with the previous stage's handoff.
    # Commenting on the old record would route work back to its original agent.
    switch = await _stage_switch(session, tid, m, ref)
    if switch:
        r = await _run_stage_with(session, t, m, idx, len(live), _mrepo, ctx, switch, who, text)
        if not r.get("ok"):
            raise HTTPException(status_code=502, detail="这一环没派出去：" + str(r.get("error"))[:160])
        ref = r.get("ref") or ref
    else:
        # Apply model overrides even when resuming the same agent.
        # local_stream._resume persists the current cfg; Pi receives --model.
        # OpenCode receives OPENCODE_CONFIG_CONTENT, including the resumed turn's model selection.
        # Without a model override, with_model preserves the original configuration.
        r = await _aio.to_thread(ai_exec.say_sync, ai_exec.with_model(ctx, m.model), ref, text)
        if not r.get("ok"):
            raise HTTPException(status_code=502, detail="没能把这一轮交代下去：" + str(r.get("error"))[:120])
    m.status = "doing"
    m.rounds = (m.rounds or 0) + 1
    ev.record(session, tid, "ai.milestone_run",
              {"id": m.id, "title": m.title, "idx": idx, "total": len(live),
               "round": m.rounds, "ref": ref,
               "agent": (switch or {}).get("name", ""), "model": (m.model or "")}, actor=who)
    if t.status == "todo":
        from ..services import task_status
        await task_status.mark(session, t, "doing", why="里程碑开跑")
    await session.commit()
    return {"ok": True, "milestone": _ms_api(m), "idx": idx, "total": len(live)}


@router.post("/tasks/{tid}/milestones/{mid}/verdict")
async def milestone_verdict(
    tid: str,
    mid: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Record a human acceptance decision against milestone criteria. Include rejection notes in
    the next round's instructions rather than accepting AI self-evaluation.
    """
    from ..models import Milestone
    from ..services import task_events as ev
    await _my_task(session, client, tid)
    m = await session.get(Milestone, mid)
    if m is None or m.task_id != tid:
        raise HTTPException(status_code=404, detail="没有这个里程碑")
    ok = bool(body.get("pass"))
    note = str(body.get("note") or "").strip()[:2000]
    if not ok and not note:
        raise HTTPException(status_code=400, detail="没过验收要写清哪儿不对，下一轮才知道改什么")
    # Reject acceptance of milestones that have never executed.
    # Otherwise the displayed completion count can exceed the work actually performed.
    # False acceptance can also close unresolved source issues in a batch.
    # Use rounds to establish that an execution result exists for review.
    # Use skipped to omit a milestone; acceptance is not a substitute for skipping.
    if (m.rounds or 0) <= 0 and m.status == "planned":
        raise HTTPException(
            status_code=409,
            detail=f"「{m.title}」还没跑过，没有结果可验。要先跑这一条；不做就标「不做」，别用验收通过跳过它")
    # Reject acceptance while the milestone's current execution is still running.
    # Reported progress must reflect completed work rather than premature approvals.
    # The doing state does not yet provide a final result for acceptance.
    # Premature acceptance could also close linked source issues.
    # If execution state cannot be determined, allow the reviewer to decide rather than blocking indefinitely.
    if m.status == "doing":
        import asyncio as _aio2

        from ..services import ai_exec as _ae
        try:
            _ctx = await _ae.load(session)
            _ref = await _dispatch_ref(session, tid)
            _info = (await _aio2.to_thread(_ae.runner_info_sync, _ctx, _ref)) if _ref else {}
            if _info and _info.get("done") is False:
                raise HTTPException(
                    status_code=409,
                    detail=f"「{m.title}」这一轮还在跑，等它跑完再判——现在盖章等于对着没出结果的活验收")
        except HTTPException:
            raise
        except Exception:  # noqa: BLE001  Unavailable execution status must not block human acceptance.
            pass
    m.status = "done" if ok else "failed"
    m.note = note
    me = await _actor_user(session, client)
    actor = (me.display_name or me.username) if me else "承办人"
    # Label automatic decisions explicitly as automatic and not human-reviewed.
    # Automatic progression must not masquerade as acceptance against human criteria.
    # Keep human and automatic decisions distinguishable in the audit trail.
    auto = bool(body.get("auto"))
    if auto:
        actor = "自动模式（未经人工验收）"
    ev.record(session, tid, "ai.milestone_verdict",
              {"id": m.id, "title": m.title, "pass": ok, "note": note, "auto": auto}, actor=actor)
    # After accepting a batch milestone, propagate completion to its linked source task.
    # Keep source tasks from remaining indefinitely active after their batch milestone completes.
    # Update only SoduWork state; externally imported tasks remain read-only in their source systems.
    src = (getattr(m, "src_task_id", "") or "").strip()
    if src and ok:
        st = await session.get(Task, src)
        if st is not None and _task_access.is_owner(st, client) and st.status not in ("done", "cancel"):
            from ..services import task_status
            await task_status.mark(session, st, "done", why="批次里程碑验收回流")
            ev.record(session, src, "ai.batch_done",
                      {"batchId": tid, "title": m.title}, actor=actor)
    await session.commit()
    return {"ok": True, "milestone": _ms_api(m), "srcTaskId": src if ok else ""}


@router.post("/tasks/{tid}/ai-stop")
async def ai_stop_task(
    tid: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Stop the current round when the executor supports cancellation. Local processes can be
    stopped; managed noninteractive executions may have no cancellation API.
    """
    import asyncio as _aio

    from ..services import ai_exec
    from ..services import task_events as ev
    from ..services.cloud_execution_sync import require_account_cloud_task
    t = await require_account_cloud_task(session, client, tid, optional=True)
    if t is None:
        t = await _my_task(session, client, tid)
    ref = await _dispatch_ref(session, tid)
    if not ref:
        raise HTTPException(status_code=409, detail="这条需求还没交给 AI")
    ctx = await ai_exec.load(session)
    r = await _aio.to_thread(ai_exec.stop_sync, ctx, ref)
    if not r.get("ok"):
        raise HTTPException(status_code=409, detail=str(r.get("error") or "没能叫停"))
    me = await _actor_user(session, client)
    who = (me.display_name or me.username) if me else "承办人"
    ev.record(session, tid, "ai.stopped", {"ref": ref, "by": who}, actor=who)
    await session.commit()
    return {"ok": True}


@router.get("/tasks/{tid}/ai-status")
async def ai_status_task(
    tid: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
    ref: str = "",
):
    """Behavior and constraints for this operation."""
    import asyncio as _aio

    from sqlalchemy import func as _f

    from ..models import Attachment
    from ..services import ai_exec
    from ..services import code_delivery as cd
    t = await _view_task(session, client, tid)
    ev_row = await ai_exec.last_dispatch_event(session, tid)   # Recognize historical multica.* events.
    if ev_row is None:
        if ref:
            raise HTTPException(409, "原执行会话已变化，请刷新需求后重试")
        return {"done": False, "dispatched": False}
    ctx = await ai_exec.load(session)
    runner = {}
    d = ev_row.detail or {}
    if ref and ref != str(d.get("ref") or d.get("issueId") or ""):
        raise HTTPException(409, "原执行会话已变化，请刷新需求后重试")
    require_snapshot = bool(ref)
    ref = d.get("ref") or d.get("issueId", "")
    s = await _aio.to_thread(ai_exec.status_sync, ctx, ref)
    if require_snapshot and not s.get("ok"):
        # A continuation must not acknowledge delivery using stale task files
        # when its authoritative Runner snapshot could not be read.
        raise HTTPException(502, "交付结果暂未同步，请恢复本轮重试")
    if s.get("ok") and (s.get("attachments") or s.get("artifactUrl")):
        await ai_exec.pull_artifacts(session, tid, ctx, s, ref)   # Reuse the administrative path's idempotent artifact import.
        await session.refresh(t)
    # Expose the execution machine and workspace so missing outputs can be investigated.
    runner = await _aio.to_thread(ai_exec.runner_info_sync, ctx, ref)
    # Collect final usage even when no console viewer or heartbeat has observed the local run.
    # Read the completed session snapshot and persist its usage idempotently.
    # Usage accounting must not depend on whether someone opened the live session view.
    if runner.get("done"):
        try:
            from ..services import execution_sessions as _es
            _live = await _aio.to_thread(ai_exec.session_sync, ctx, ref, 10 ** 9)
            if _live.get("ok"):
                await _es.ingest_live_snapshot(session, t, ref, _live, d)
                await session.commit()
        except Exception:  # noqa: BLE001  Usage collection failures must not break the status endpoint.
            pass
    # Check code delivery only after execution finishes; intermediate branch states are not delivery evidence.
    # Internal throttling and idempotency prevent repeated polling from duplicating fetch or merge operations.
    code = await cd.read_state(session, tid)
    code["applies"] = (await cd.repo_for(session, t)) is not None
    code["delivered"] = code["applies"] and await cd.is_delivered(session, t, code)
    code["managedByWorkflow"] = await cd.managed_by_active_workflow(session, tid)
    if (code["applies"] and not code["managedByWorkflow"]
            and runner.get("done") and code["stage"] != "merged"):
        try:
            scm_hint = ({"provider": "runner", "runnerId": str(d.get("runnerId") or ""),
                         "ref": ref} if d.get("runnerId") else {})
            code = await cd.check(
                session, t, who="SoduWork",
                branch_hint=str(s.get("gitRemoteBranch") or s.get("gitBranch") or ""),
                head_hint=str(s.get("gitHead") or ""),
                scm_hint=scm_hint)
            await session.refresh(t)
        except Exception as e:  # noqa: BLE001  Merge failures must not break the status endpoint.
            code["error"] = f"交付判定失败（{type(e).__name__}）"
    n_att = (await session.execute(
        _f.count(Attachment.id).select().where(
            Attachment.task_id == tid, Attachment.role.in_(("output", "evidence", "supporting"))))).scalar() or 0
    files_done = bool((getattr(t, "artifact_url", "") or "").strip()) or n_att > 0
    # A direct cloud conversation is complete when its Runner has finished a
    # successful turn, even if the turn intentionally produced no file.  The
    # generic task path historically equated completion with an artifact, so a
    # perfectly valid text-only cloud reply was reported as ``stalled`` and the
    # client kept waiting for delivery that could never exist.
    cloud_turn_done = (
        str(getattr(t, "origin", "") or "") == "cloud-conversation"
        and bool(runner.get("done"))
        and not bool(runner.get("failed"))
    )
    done = cloud_turn_done or (code["delivered"] if code["applies"] else files_done)
    # Distinguish completed execution from missing or pending delivery.
    # Report the specific delivery state rather than treating every incomplete delivery as stalled.
    # none: no branch or returned outputs exist.
    # committed: changes exist and are awaiting merge.
    # conflict: merge requires human conflict resolution.
    stalled = (not done) and bool(runner.get("done")) and not bool(runner.get("failed")) and code.get("stage") in (None, "", "none")
    api_task = None
    if done:
        from ..services import task_access
        api_task = (await task_access.decorate_many(
            session, [t], [task_to_api(t)], client))[0]
    return {"done": done, "dispatched": True, "stalled": stalled, "runner": runner,
            "code": code, "task": api_task}


@router.get("/tasks/{tid}/ai-session")
async def ai_session_task(
    tid: str,
    since: int = 0,
    ref: str = "",
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
    limit: int = Query(default=400, ge=1, le=1000),
):
    """Behavior and constraints for this operation."""
    import asyncio as _aio

    from ..services import ai_exec, execution_sessions
    if not isinstance(limit, int):
        limit = 400
    t = await _view_task(session, client, tid)
    from ..services import task_access

    from ..services import cloud_acceptance
    acceptance = await cloud_acceptance.status(session, tid)

    def with_conversation_access(page):
        result = dict(page or {})
        if acceptance:
            result.update(mobileAcceptance=acceptance, canSend=False,
                          readOnlyReason="自动验收会话保留本轮报告；请回到原需求查看结果或重新发起验收")
            return result
        # Cloud execution is still pinned to its original Runner.  `canSend`
        # only means this account device may append a turn through Hub.
        result["canSend"] = task_access.can_continue_execution(t, client)
        if not result["canSend"]:
            result["readOnlyReason"] = "当前设备只能查看此会话"
        return result
    if ref:
        # Workflow nodes have their own execution refs. Authorize the exact
        # task/ref pair BEFORE asking any Runner for its transcript.
        from ..automation_models import ExecutionSession
        from sqlalchemy import select
        row = (await session.execute(select(ExecutionSession).where(
            ExecutionSession.task_id == tid, ExecutionSession.ref == ref
        ))).scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="找不到这条需求的执行记录")
        d = {"ref": ref, "runnerId": row.runner_id, "assigneeCli": row.engine, "model": row.model}
    else:
        ev_row = await ai_exec.last_dispatch_event(session, tid)
        if ev_row is None:
            return {"ok": False, "items": [], "error": "这条需求还没交给 AI"}
        d = ev_row.detail or {}
        ref = d.get("ref") or d.get("issueId", "")
    ctx = await ai_exec.load(session)
    live = await _aio.to_thread(ai_exec.session_sync, ctx, ref, int(since or 0))
    if live.get("ok"):
        # New Runners push events; older Runners and backend-local execution use read-through persistence during upgrades.
        await execution_sessions.ingest_live_snapshot(session, t, ref, live, d)
        await session.commit()
        cached = await execution_sessions.read_task(session, tid, ref, int(since or 0), limit=limit)
        return with_conversation_access(cached or live)
    cached = await execution_sessions.read_task(session, tid, ref, int(since or 0), limit=limit)
    if cached is not None:
        cached["liveError"] = live.get("error") or "执行机当前不在线"
        cached["canStop"] = False
        return with_conversation_access(cached)
    return with_conversation_access(live)


@router.post("/tasks/{tid}/ai-say")
async def ai_say_task(
    tid: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_ai_client),
    session: AsyncSession = Depends(get_session),
):
    """Send a message to the task's existing execution through the shared runtime. Enforce
    collaboration visibility and personal handoff identity; messageId preserves receipts and
    deduplicates retries.
    """
    import asyncio as _aio
    from datetime import datetime, timezone

    submitted_at = datetime.now(timezone.utc)

    from ..services import ai_exec
    text = str(body.get("text") or "").strip()
    if len(text) > 200000:
        raise HTTPException(413, "消息超过 200000 字符，请拆分后发送")
    if not text:
        raise HTTPException(status_code=400, detail="说点什么再发")
    from ..services.cloud_execution_sync import require_account_cloud_task
    t = await require_account_cloud_task(session, client, tid, optional=True)
    if t is None:
        t = await _view_task(session, client, tid)
    if not _task_access.can_continue_execution(t, client):
        raise HTTPException(403, "当前账号只能查看此执行会话")
    ev_row = await ai_exec.last_dispatch_event(session, tid)
    if ev_row is None:
        raise HTTPException(status_code=400, detail="这条需求还没交给 AI")
    ctx = await ai_exec.load(session)
    d = ev_row.detail or {}
    from ..services import conversation_handoffs, cloud_turn_selection
    handoff = await conversation_handoffs.dispatch_record(session, tid)
    raw_selection = body.get("executionSelection")
    ctx = await cloud_turn_selection.prepare(session, client, ctx, handoff, raw_selection)
    ref = d.get("ref") or d.get("issueId", "")
    expected_ref = body.get("expectedRef")
    controlled_turn = body.get("conversationTurn")
    if expected_ref is not None and expected_ref != ref:
        raise HTTPException(409, "原执行会话已变化，请刷新需求后重试")
    if controlled_turn is not None:
        current = dict((t.work_routing or {}).get("conversationTurn") or {})
        if (not isinstance(controlled_turn, dict) or current.get("state") != "running"
                or current.get("executor") != "dispatch" or current.get("continuationRef") != ref
                or current.get("conversationId") != controlled_turn.get("conversationId")
                or current.get("turnId") != controlled_turn.get("turnId")):
            raise HTTPException(409, "需求执行状态已变化，请从需求入口继续修正")
    if not handoff:
        from ..services import task_continuation
        try:
            ctx = await task_continuation.prepare(session, t, ctx, ref)
        except task_continuation.ContinuationError as exc:
            raise HTTPException(409, str(exc)) from exc
    from ..services import conversation_turn_files
    turn_files, file_manifest = conversation_turn_files.decode(body.get("files", []))
    from ..services import conversation_turn_plugins
    from ..services import conversation_turn_skills
    turn_skills = conversation_turn_skills.normalize(body.get("skills"))
    if turn_skills:
        if body.get("messageId") is None:
            raise HTTPException(422, "技能续聊需要消息回执编号")
        await conversation_turn_skills.validate(session, client, handoff, ref, turn_skills)
        ctx = {**ctx, "_turnSkills": turn_skills}
    turn_plugins = conversation_turn_plugins.normalize(body.get("plugins"))
    if turn_plugins:
        if body.get("messageId") is None:
            raise HTTPException(422, "插件续聊需要消息回执编号")
        await conversation_turn_plugins.validate(session, client, handoff, ref, turn_plugins)
        ctx = {**ctx, "_turnPlugins": turn_plugins}
    if turn_files:
        if (not handoff and not controlled_turn) or body.get("messageId") is None:
            raise HTTPException(409, "追加文件需要支持回执的远程会话；需求材料请从需求入口提交")
        from ..services import ai_remote
        runner = ai_remote._runner_of_ref(ref)
        if not runner or "turnFiles1" not in getattr(runner, "caps", []):
            raise HTTPException(409, "原执行机离线或尚未支持追加文件，请更新并连接执行机后重试")
        ctx = {**ctx, "_turnFiles": turn_files}
    if body.get("messageId") is not None:
        from ..services import conversation_message_receipts
        r = await conversation_message_receipts.send(
            session, client, tid, ref, text, body["messageId"], ctx, execution_selection=raw_selection,
            file_manifest=file_manifest)
        if r.get("pending") or r.get("delivery") == "rejected":
            return r
    else:
        r = await _aio.to_thread(ai_exec.say_sync, ctx, ref, text)
    if not isinstance(r, dict) or not r.get("ok"):
        error = str((r or {}).get("error") or
                    "\u6267\u884c\u5e95\u5ea7\u6ca1\u6709\u63a5\u53d7\u8fd9\u6761\u7559\u8a00")[:120]
        raise HTTPException(status_code=502, detail="\u6ca1\u53d1\u51fa\u53bb：" + error)
    await cloud_turn_selection.accepted(session, handoff, r)
    if ((t.work_routing or {}).get("reworkPending") or controlled_turn) and r.get("delivery") in (None, "accepted"):
        from ..services import task_rework
        if body.get("messageId") is not None:
            from ..conversation_handoff_models import ConversationMessageReceipt
            from sqlalchemy import select, func
            submitted_at = await session.scalar(select(func.min(ConversationMessageReceipt.created_at)).where(
                ConversationMessageReceipt.task_id == tid,
                ConversationMessageReceipt.message_id == body["messageId"],
            ))
        if await task_rework.acknowledge_continuation(session, tid, ref, submitted_at,
                actor=client.user_ref or client.id,
                conversation_id=str((controlled_turn or {}).get("conversationId") or ""),
                turn_id=str((controlled_turn or {}).get("turnId") or ""),
                message_id=str(body.get("messageId") or "")):
            await session.commit()
            await _task_access.publish_task(session, t, "task.updated", await svc.task_to_api_live(session, t))
    from ..services import turn_correlation
    return {"ok": True, "queued": bool(r.get("queued")),
            **turn_correlation.public(r),
            **({"acceptedSelection": r["acceptedSelection"]} if r.get("acceptedSelection") else {}),
            **({"messageId": r["messageId"], "delivery": r["delivery"],
                "duplicate": bool(r.get("duplicate"))} if r.get("messageId") else {}),
            "note": str(r.get("note") or "\u5df2\u9001\u8fbe\u6267\u884c\u4f1a\u8bdd")}


@router.post("/tasks/{tid}/ai-remind")
async def ai_remind_task(
    tid: str,
    client: Client = Depends(current_ai_client),
    session: AsyncSession = Depends(get_session),
):
    """Remind the existing execution to return outputs as SoduWork attachments or accessible URLs;
    files left only in its workspace are not delivered.
    """
    import asyncio as _aio

    from ..services import ai_exec
    t = await session.get(Task, tid)
    if t is None or not _task_access.is_owner(t, client):
        raise HTTPException(status_code=404, detail="需求不存在")
    ev_row = await ai_exec.last_dispatch_event(session, tid)
    if ev_row is None:
        raise HTTPException(status_code=400, detail="这条需求还没交给 AI")
    ctx = await ai_exec.load(session)
    d = ev_row.detail or {}
    r = await _aio.to_thread(ai_exec.remind_sync, ctx,
                             d.get("ref") or d.get("issueId", ""), ai_exec.REMIND_TEXT)
    if not r.get("ok"):
        raise HTTPException(status_code=502, detail="催办没发出去：" + str(r.get("error"))[:120])
    return {"ok": True}


@router.post("/tasks/{tid}/reject-artifact")
async def reject_task_artifact(
    tid: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Reject delivery and retain executor-owned rework; toAI=false returns it to the backlog.
    Workflow-managed tasks retain their graph transitions. Direct tasks wait for continuation.
    """
    from ..services import release_control
    from ..services import task_events as ev
    from ..services import task_rework
    note = str(body.get("note") or "").strip()[:1000]
    if not note:
        raise HTTPException(status_code=400, detail="打回要写清楚哪儿不行，不然对方没法改")
    to_ai = bool(body.get("toAI"))
    t = await session.get(Task, tid)
    if t is None:
        raise HTTPException(status_code=404, detail="需求不存在")
    me = await _actor_user(session, client)
    if me is None:
        raise HTTPException(status_code=403, detail="本 SoduWork 未绑定用户，无法审核")
    creator = getattr(t, "created_by", None)
    if not creator:
        raise HTTPException(status_code=400, detail="这条需求没有记录创建人，无法判定审核权")
    if creator != me.id:
        raise HTTPException(status_code=403, detail="只有这项需求的创建人能打回产出")
    who = me.display_name or me.username
    # Store rework reference materials separately from deliverables and require upload by the same creator.
    # Reference exact attachment IDs in rework instructions to avoid ambiguous filename matches.
    raw_ids = body.get("reworkAttachmentIds")
    ids = []
    for value in raw_ids if isinstance(raw_ids, list) else []:
        value = str(value or "").strip()
        if value and value not in ids:
            ids.append(value)
    if len(ids) > 20:
        raise HTTPException(status_code=400, detail="返修资料最多添加 20 个文件")
    if ids:
        from sqlalchemy import select
        from ..models import Attachment
        rows = list((await session.execute(select(Attachment).where(
            Attachment.task_id == t.id, Attachment.id.in_(ids),
            Attachment.role == "rework_input",
            Attachment.source_ref == "task-rework:" + t.id,
        ))).scalars().all())
        by_id = {str(row.id): row for row in rows}
        if any(value not in by_id for value in ids):
            raise HTTPException(status_code=400, detail="返修资料已失效，请重新添加")
        note = (note + "\n\n【返修参考资料】\n" + "\n".join(
            "- " + str(by_id[value].filename or "返修资料")[:200] +
            "（附件 ID: " + value + "）" for value in ids))[:1800]
    # Freeze the rejected version: Git identifies code candidates; attachment IDs and URLs identify other outputs.
    artifact = await release_control.latest_artifact(session, tid)
    if artifact is None:
        from ..services import code_delivery as _cd
        if await _cd.repo_for(session, t) is not None:
            await _cd.check(session, t, who=who, force=True)
            artifact = await release_control.latest_artifact(session, tid)
        else:
            try:
                artifact, _ = await release_control.ensure_current_output(session, t, who=who)
                await session.commit()
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
    if artifact is None:
        raise HTTPException(status_code=400, detail="还没有可打回的候选版本")
    decided = await release_control.decide(
        session, t, me, action="review", decision="reject", note=note,
        artifact_version_id=artifact.id)
    if not decided.get("ok"):
        reason = decided.get("reason")
        code = 409 if reason in ("stale", "resolved", "duplicate", "invalid_artifact") else 403
        raise HTTPException(status_code=code, detail=decided.get("detail") or "这份产出已变化，请刷新后再操作")
    rework = None
    if to_ai:
        rework = (await task_rework.resume_after_rejection(
            session, t, note, artifact_version_id=artifact.id,
            request_id=str((decided.get("request") or {}).get("id") or ""), actor=who,
            fallback_on_missing_ref=True, wait_for_executor=True))
    else:
        # Return tasks to the backlog on the server, matching approval-inbox rejection semantics.
        # Retain feedback in task details rather than relying on a client-side state patch.
        rework = await task_rework.return_to_backlog(
            session, t, note,
            request_id=str((decided.get("request") or {}).get("id") or ""), actor=who)
    sent_to_ai = bool(rework and rework.get("started"))
    ev.record(session, tid, "artifact.rejected",
              {"by": who, "note": note, "toAI": sent_to_ai}, actor=who)
    await audit.log(session, me, "task.artifact_reject", "task", tid, t.title,
                    {"note": note, "toAI": sent_to_ai})
    await session.commit()
    await session.refresh(t)
    # Notify the producing owner that the work was returned and explain why.
    if t.owner_client_id and not _task_access.is_owner(t, client):
        await _task_access.publish_owner(session, t, {
            "type": "notice",
            "text": f"{who} 认为「{t.title}」的产出还不行：{note[:60]}"
                    + ("（已让 AI 接着改）" if sent_to_ai else ""),
            "taskId": tid})
    from ..services import task_access
    api = await svc.task_to_api_live(session, t)
    await task_access.publish_task(session, t, "task.updated", api)
    return {"ok": True, "toAI": sent_to_ai, "rework": rework, "task": api}


@router.post("/tasks/{tid}/rework-materials")
async def upload_task_rework_material(
    tid: str,
    file: UploadFile = File(...),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Upload reference materials for creator-requested rework without treating them as
    deliverables.
    """
    t = await session.get(Task, tid)
    if t is None:
        raise HTTPException(status_code=404, detail="需求不存在")
    if t.status != "done" or getattr(t, "reviewed_at", None):
        raise HTTPException(status_code=409, detail="当前需求没有待验收的交付结果")
    me = await _actor_user(session, client)
    if me is None or str(getattr(t, "created_by", "") or "") != str(me.id):
        raise HTTPException(status_code=403, detail="只有需求创建人可以添加返修资料")
    data = await file.read()
    limit = get_settings().attach_max_mb * 1024 * 1024
    if not data:
        raise HTTPException(status_code=400, detail="请选择一份返修参考资料")
    if len(data) > limit:
        raise HTTPException(status_code=413, detail=f"文件超过 {get_settings().attach_max_mb}MB 上限")
    name = (file.filename or "rework-material").replace("/", "_").replace("\\", "_").strip()
    name = name[:200] or "rework-material"
    content_type = str(file.content_type or "application/octet-stream")[:120]
    from ..models import Attachment
    from ..schemas import attachment_to_api
    from ..services import storage
    attachment_id = str(__import__("uuid").uuid4())
    row = Attachment(
        id=attachment_id, task_id=t.id, filename=name, content_type=content_type,
        size=len(data), uploaded_by="user:" + me.id, role="rework_input",
        source_ref="task-rework:" + t.id,
        evidence_meta={"kind": "rework_context", "uploadedBy": me.display_name or me.username or me.id},
    )
    row.storage_key = f"att/{t.id}/{attachment_id}/{name}"
    row.backend = storage.put(row.storage_key, data, content_type)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return {"ok": True, "attachment": attachment_to_api(row)}


@router.post("/tasks/{tid}/review")
async def review_task_artifact(
    tid: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Allow the task creator to review the current fixed output version. Let the shared completion
    gate close direct work or continue code/workflow tasks through remaining stages.
    """
    from ..services import code_delivery as _cd
    from ..services import release_control
    from ..services import task_events as ev
    t = await session.get(Task, tid)
    if t is None:
        raise HTTPException(status_code=404, detail="需求不存在")
    me = await _actor_user(session, client)
    if me is None:
        raise HTTPException(status_code=403, detail="本 SoduWork 未绑定用户，无法审核")
    creator = getattr(t, "created_by", None)
    if not creator:
        raise HTTPException(status_code=400, detail="这条需求没有记录创建人，无法判定审核权")
    if creator != me.id:
        raise HTTPException(status_code=403, detail="只有这项需求的创建人能审核产出")
    who = me.display_name or me.username
    note = str(body.get("note") or "").strip()
    # Refresh code candidates or snapshot current artifacts; bind review to an immutable version ID.
    if await _cd.repo_for(session, t) is not None:
        await _cd.check(session, t, who=who, force=True)
        artifact = await release_control.latest_artifact(session, tid)
        if artifact is None:
            raise HTTPException(status_code=400, detail="还没有发现可审阅的代码提交")
    else:
        artifact = await release_control.latest_artifact(session, tid, stream="delivery")
        if artifact is None:
            try:
                artifact, _ = await release_control.ensure_current_output(session, t, who=who)
                await session.commit()
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
    decided = await release_control.decide(
        session, t, me, action="review", decision="approve", note=note,
        artifact_version_id=artifact.id)
    if not decided.get("ok"):
        reason = decided.get("reason")
        code = 409 if reason in ("stale", "resolved", "duplicate") else 403
        raise HTTPException(status_code=code, detail=decided.get("detail") or "这份产出已变化，请刷新后再操作")
    from ..services import receipts, task_status
    before = t.status
    applied = await task_status.mark(session, t, "done", why="当前成果验收通过")
    closed = before != "done" and t.status == "done"
    task_blocked = None
    if not applied and not closed and t.status != "done":
        # Report completion-gate failures explicitly after approval.
        # Distinguish valid merge/release waits from actual blocking failures.
        from ..services import delivery_truth
        truth = await delivery_truth.evaluate(session, t)
        task_blocked = delivery_truth.blocked_summary(t, truth.get("blockers"))
    ev.record(session, tid, "artifact.reviewed",
              {"by": who, "note": note, "taskClosed": closed,
               "taskBlocked": task_blocked}, actor=who)
    await audit.log(session, me, "task.artifact_review", "task", tid, t.title, {"note": note})
    await session.commit()
    await session.refresh(t)
    if closed:
        await receipts.notify_on_close(session, t, t.owner_client_id)
    # Notify the producing owner when the review is complete.
    if t.owner_client_id and not _task_access.is_owner(t, client):
        suffix = ("；任务等待工作流推进：" + task_blocked["reason"] if task_blocked and task_blocked.get("awaitingWorkflow")
                  else "；任务暂未办结：" + task_blocked["reason"] if task_blocked else "")
        await _task_access.publish_owner(session, t, {
            "type": "notice", "text": f"✅ {who} 审核通过了「{t.title}」的产出{suffix}", "taskId": tid})
    from ..services import task_access
    api = await svc.task_to_api_live(session, t)
    await task_access.publish_task(session, t, "task.updated", api)
    return {**api, "taskBlocked": task_blocked}


@router.get("/tasks/{tid}/acceptance-context")
async def task_acceptance_context(
    tid: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Read fixed review outputs, acceptance criteria, and authorized reference materials."""
    from ..services import task_acceptance_review
    return await task_acceptance_review.context(session, client, tid)


@router.post("/tasks/{tid}/auto-review")
async def auto_review_task_artifact(
    tid: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_ai_client),
    session: AsyncSession = Depends(get_session),
):
    """Apply an authorized review agent's verified decision through the shared approval gate."""
    from ..services import task_acceptance_review
    return await task_acceptance_review.apply(session, client, tid, body)


@router.post("/tasks/{tid}/prepare-execution")
async def prepare_task_execution(
    tid: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Let the current assignee explicitly claim idle execution on this device."""
    from ..services import task_execution_claim
    return await task_execution_claim.prepare(session, client, tid)




@router.post("/tasks/{tid}/submit-review")
async def submit_task_for_review(
    tid: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Submit the latest delivery for human verification.

    The requirement board must not synthesize ``requirementStage=reviewing``
    with a task PATCH.  That stage is the read model of a pending review
    request, so this action creates (or reuses) the immutable artifact and its
    review request.  Completion remains a separate decision through
    ``/review`` or the approval inbox.
    """
    from ..services import release_control
    from ..services import task_requirements
    from ..services import task_access
    from ..services import task_events as ev

    # Serialize manual submission with execution starts and approval decisions.
    await session.get(Task, tid, with_for_update=True, populate_existing=True)
    task = await _view_task(session, client, tid)
    if not task_requirements.is_review_submitter(task, client):
        raise HTTPException(status_code=403, detail="只有执行者可以提交验收")
    api = await svc.task_to_api_live(session, task)
    current = api.get("requirementStage")
    if current == "reviewing":
        # Idempotent retry: a delayed response must not manufacture another
        # artifact or review ticket for the same board drop.
        return {"ok": True, "already": True, "task": api}
    if current != "delivering" or task.status != "doing":
        raise HTTPException(status_code=409, detail="只有进行中的需求可以提交验证")

    from ..services import task_maintenance
    await task_maintenance.ensure_allowed(session, [task])

    actor = await _actor_user(session, client)
    who = _actor_label(actor, client)
    note = str(body.get("note") or "").strip()[:1000]
    try:
        turn = dict((task.work_routing or {}).get("conversationTurn") or {})
        artifact, _ = await release_control.ensure_current_output(
            session, task, who=who,
            source_ref=("conversation:" + str(turn["conversationId"])) if turn.get("conversationId") else "",
            allow_empty=True)
        request = await release_control.ensure_request(session, task, artifact, "review")
        if request.status != "pending":
            raise ValueError("本轮交付已验收或退回，请修改交付内容后重新提交")
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error

    routing = dict(task.work_routing or {})
    rework = routing.pop("reworkPending", None)
    if rework:
        # An explicit executor submission settles feedback without starting a model run.
        task.work_routing = routing
        ev.record(session, tid, "ai.rework_taken", {
            "requestId": rework.get("requestId"), "by": "manual_submission",
        }, actor=who)
    ev.record(session, tid, "artifact.submitted_for_review",
              {"requestId": request.id, "versionId": artifact.id, "note": note}, actor=who)
    await session.commit()
    await session.refresh(task)
    api = await svc.task_to_api_live(session, task)
    await task_access.publish_task(session, task, "task.updated", api)
    return {"ok": True, "request": release_control.request_api(request), "task": api}


@router.get("/tasks/{tid}/comments")
async def list_task_comments(
    tid: str, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)
):
    """Task collaboration threads with comments and mention notifications, restricted to task
    holders.
    """
    await _view_task(session, client, tid)
    from ..services import comments
    return await comments.list_comments(session, tid)


@router.post("/tasks/{tid}/comments")
async def add_task_comment(
    tid: str, body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)
):
    """Post a comment and notify mentioned colleagues; body contains body and mentions entries."""
    t = await _view_task(session, client, tid)
    text = (body.get("body") or "").strip()
    mentions = body.get("mentions") or []
    if not text:
        raise HTTPException(status_code=400, detail="评论不能为空")
    u = await _actor_user(session, client)
    from ..services import comments
    return await comments.add_comment(session, t, "user", (u.id if u else None), _actor_label(u, client), text, mentions)


@router.patch("/tasks/{tid}")
async def update_task(
    tid: str, body: TaskUpdate, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)
):
    # exclude_unset preserves explicit null values so dates, project links, and assignees can be cleared.
    r = await svc.update_task(session, client.id, tid, body.model_dump(exclude_unset=True))
    if r is None:
        raise HTTPException(status_code=404, detail="需求不存在")
    return r


@router.delete("/tasks/{tid}")
async def delete_task(
    tid: str, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)
):
    r = await svc.delete_task(session, client.id, tid)
    if not r["ok"]:
        if r["reason"] == "readonly":
            raise HTTPException(status_code=403, detail="聚合/下发需求不可删除，只能改本地状态")
        raise HTTPException(status_code=404, detail="需求不存在")
    return r


# Legacy task-flow, advance, and reject endpoints are retired.
# WorkflowRun plugin nodes now represent gates and human confirmation.
# Route progression and approval through /approvals.
