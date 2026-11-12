"""SoduWork Hub FastAPI entry point."""
import asyncio
import contextlib
import logging
import math
import re
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api import admin, agents, ai_proxy, aidesk, approvals, attachments, capabilities, client_updates, client_release_notes, clients, delivery, download, environments, evolution, identity, ingest, library, repomap, updates
from .api import admin_cloud_runners, client_auth, cloud_environments, cloud_conversations, conversation_handoffs, deliveries, memory_records, session_memory
from .api import account_profile, admin_mail, client_email_auth, quotas, legal_documents
from .api import remote_screen
from .api import conversation_projects
from .api import account_conversations
from .api import conversation_content_migrations
from .api import cloud_execution_sync, personal_conversation_relay
from .api import model_runtime as model_runtime_api
from .api import model_capabilities as model_capabilities_api
from .api import jiyong_data
from .api import config as config_api
from .api import retired_endpoints, operations, plugin_activity, plugin_client_catalog, plugin_client_runs, plugin_permissions, plugin_publishers, plugins, release, reports, repositories, repository_issues, runner_ws, task_mcp, task_options, tasks, term, trace, usage, ws
from .api import work_catalog as work_catalog_api
from .api import im as im_api
from .config import get_settings
from .db import SessionLocal, init_db
from .log_safety import install_log_redaction
from .models import TaskOwnershipChanged
from .services import rbac, work_catalog as work_catalog_service
from .services.database_telemetry import DatabaseTimingMiddleware
from .services.shared_auth_cache import AuthCacheUnavailable
from .services.poller import poller_loop

settings = get_settings()
install_log_redaction()
log = logging.getLogger("uvicorn.error")


def _spawn_bg(coro, name: str):
    """Start a background task and log uncaught failures through its completion callback."""
    t = asyncio.create_task(coro)
    def _on_done(task):
        if task.cancelled():
            return
        exc = task.exception()
        if exc:
            log.error("后台任务 %s 异常退出: %s: %s", name, type(exc).__name__, exc)
    t.add_done_callback(_on_done)
    return t


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Uvicorn may rebuild handlers while booting; install again idempotently so
    # WebSocket query credentials can never reach the formatted access log.
    install_log_redaction()
    settings.validate_security()  # Reject missing or default credentials outside development.
    await init_db()
    from .services import cluster_control, cluster_runtime
    from .services.cluster_bus import bus
    if bus.enabled:
        bus.validate()
    async with cluster_control.bootstrap_lock():
        async with SessionLocal() as session:  # Initialize the root department, default roles, and bootstrap administrator when needed.
            await rbac.bootstrap(session)
            await rbac.seed_positions(session)   # Seed default professional roles idempotently.
            await work_catalog_service.bootstrap(session)  # Seed professional profiles and work scenarios idempotently.
            await rbac.seed_domains(session)     # Seed editable example domains only when the domain table is empty.
        async with SessionLocal() as session:  # Add credential-free provider templates; administrators own all model entries.
            from .services import model_catalog
            try:
                await model_catalog.bootstrap(session)
            except Exception as e:  # noqa: BLE001  Provider initialization failure must not prevent service startup.
                log.warning("模型目录初始化失败: %s", e)
        async with SessionLocal() as session:  # Initialize approval policies and declarative legacy environment configuration idempotently.
            from .services import release_control
            await release_control.bootstrap(session)
        async with SessionLocal() as session:  # Import sample plugins into quarantine; administrators must review them before enabling.
            from .services import plugin_service
            await plugin_service.bootstrap_example(session)
    # Recover local CLI sessions after restart: monitor surviving processes and settle exited ones.
    # Preserve cancellation, continuation, and artifact recovery across backend updates.
    try:
        from .services import ai_local
        if not bus.enabled:
            await asyncio.to_thread(ai_local.reclaim)
    except Exception as e:  # noqa: BLE001  Session recovery failure must not prevent service startup.
        log.warning("本机会话认领失败: %s: %s", type(e).__name__, e)
    # Warm the ref-to-Runner cache so routing works immediately after restart.
    try:
        from .services import execution_sessions, runner_registry
        # Recovery writes must also be serialized across simultaneous replica boots.
        async with cluster_control.bootstrap_lock():
            async with SessionLocal() as session:
                local_n = 0 if bus.enabled else await execution_sessions.reconcile_local_sessions(session)
                lost_n = await execution_sessions.reconcile_lost_dispatches(session)
                offline_n = await runner_registry.reconcile_stale_busy(
                    session, settings.offline_after_seconds)
                n = await execution_sessions.warm_remote_cache(session)
                await session.commit()
        if local_n:
            log.info("已收敛 %d 条本机执行单", local_n)
        if lost_n:
            log.info("已按会话实况接回 %d 条派活回执丢失的任务", lost_n)
        if offline_n:
            log.info("Recovered %d stale offline Runner load records", offline_n)
        if n:
            log.info("已从执行单预热 %d 条 ref→runner 路由", n)
    except Exception as e:  # noqa: BLE001
        log.warning("ref→runner 缓存预热失败: %s: %s", type(e).__name__, e)
    # Use an event-loop watchdog to capture stacks during prolonged blocking.
    # Event-loop stalls can disrupt Runner heartbeats and desktop connectivity.
    # Runtime stack evidence identifies blocking work that static inspection may miss.
    await cluster_runtime.start()
    from .services import automation_inbox_events, cloud_sync_notifications, client_domain_events
    automation_inbox_events.start()
    cloud_sync_notifications.start()
    client_domain_events.start()
    from .services import loop_watch
    watch = loop_watch.start()

    from .services import cloud_recovery, cloud_message_recovery, dispatch_reconcile, pty_term, repository_catalog, repository_issue_worker
    term_sweep = _spawn_bg(pty_term.sweep_loop(), "term_sweep")  # Reap idle terminals.
    # Periodic report generation can be disabled while manual generation remains available.
    # REPORT_AUTO=false disables scheduling without disabling generation endpoints.
    # Automatic bug batching is off by default; the coroutine exits immediately when disabled.
    from .services import autobatch
    # Reconcile completed, pushed code into immutable review candidates; never merge or publish automatically here.
    from .services import code_delivery
    from .services import schedule_loop
    from .services import deployments
    from .services import workflow_engine
    # Supervise automatic milestone progression using each task's ms_auto flag.
    from .services import ms_auto
    from .services import org_memory
    # Retry pending rework delivery after Runner outages or Hub restarts; exhausted attempts require manual action.
    from .services import task_rework
    from .services import account_mail, account_privacy, task_notifications
    from .services import im_worker
    factories = [
        ("account_mail", account_mail.worker_loop),
        ("account_privacy", account_privacy.tick_loop),
        ("task_notifications", task_notifications.loop),
        ("organization_memory", org_memory.loop),
        ("poller", poller_loop),
        ("repository_catalog", repository_catalog.sync_loop),
        ("repository_issues", repository_issue_worker.tick_loop),
        ("dispatch_reconcile", dispatch_reconcile.tick_loop),
        ("cloud_recovery", cloud_recovery.tick_loop),
        ("cloud_messages", cloud_message_recovery.tick_loop),
        ("rework_retry", task_rework.retry_loop),
        ("autobatch", autobatch.tick_loop),
        ("delivery_sweep", code_delivery.sweep_loop),
        ("automation_scheduler", schedule_loop.tick_loop),
        ("deployment_sweep", deployments.sweep_loop),
        ("plugin_workflow", workflow_engine.tick_loop),
        ("ms_auto", ms_auto.tick_loop),
    ]
    if settings.im_enabled:
        factories.append(("im_transport", im_worker.loop))
    if settings.report_auto:
        from .services.daily_report import report_loop
        factories.append(("daily_report", report_loop))
    bg = [watch, term_sweep]
    if bus.enabled:
        bg.append(_spawn_bg(cluster_control.supervise(factories), "cluster-supervisor"))
    else:
        bg.extend(_spawn_bg(factory(), name) for name, factory in factories)
    try:
        yield
    finally:
        try:
            from .services import model_transport
            from .services import jiyong_cloud_database
            from .services import shared_auth_cache
            from .services.shutdown import shutdown
            await shutdown(bg, [("automation-inbox-hints", automation_inbox_events.stop),
                                ("cloud-sync-hints", cloud_sync_notifications.stop),
                                ("client-domain-hints", client_domain_events.stop),
                                ("cluster", cluster_runtime.stop),
                                ("models", model_transport.shutdown),
                                ("cloud-database", jiyong_cloud_database.close),
                                ("auth-cache", shared_auth_cache.close)])
        finally:
            # Legacy local execution can own login jobs on the Hub. Drain them
            # even when an unrelated shutdown step fails, without stopping chats.
            from .services import codex_login_flow
            if not await asyncio.to_thread(codex_login_flow.shutdown):
                log.warning("Codex authorization cleanup exceeded the Hub shutdown deadline")


app = FastAPI(title="SoduWork Hub", version=settings.version, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_list,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID", "Server-Timing"],
    allow_credentials=False,
)


_REQUEST_ID = re.compile(r"^[A-Za-z0-9._:-]{8,64}$")


@app.middleware("http")
async def request_observability(request: Request, call_next):
    """Give every request a correlation id and feed the bounded operations read model."""
    from .services import runtime_telemetry

    from .services.cluster_bus import bus
    offered = str(request.headers.get("X-Request-ID") or "")
    request_id = offered if _REQUEST_ID.fullmatch(offered) else uuid.uuid4().hex
    request.state.request_id = request_id
    started = time.perf_counter()
    try:
        if bus.enabled and not bus.healthy and request.method not in ("GET", "HEAD", "OPTIONS"):
            request.state.exception_type = "cluster_unavailable"
            response = JSONResponse(status_code=503, headers={"Retry-After": "3"},
                                    content={"detail": "服务节点正在恢复连接，请稍后重试"})
        else:
            response = await call_next(request)
    except Exception as exc:
        elapsed = (time.perf_counter() - started) * 1000
        request.state.exception_type = type(exc).__name__
        route = request.scope.get("route")
        route_path = getattr(route, "path", None) or "__unmatched__"
        runtime_telemetry.record(request.method, route_path, 500, elapsed,
                                 request_id, type(exc).__name__,
                                 getattr(request.state, "model_timing", None))
        raise
    elapsed = (time.perf_counter() - started) * 1000
    route = request.scope.get("route")
    route_path = getattr(route, "path", None) or "__unmatched__"
    runtime_telemetry.record(
        request.method, route_path, response.status_code, elapsed, request_id,
        getattr(request.state, "exception_type", ""),
        getattr(request.state, "model_timing", None),
    )
    response.headers["X-Request-ID"] = request_id
    timing = getattr(request.state, "model_timing", None) or {}
    parts = [f"app;dur={elapsed:.1f}"]
    for key, label in (("admissionMs", "model-admission"),
                       ("upstreamHeadersMs", "upstream-headers"),
                       ("bodyMs", "upstream-body"),
                       ("totalMs", "model-total")):
        value = timing.get(key)
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            parts.append(f"{label};dur={float(value):.1f}")
    response.headers["Server-Timing"] = ", ".join(parts)
    return response


# Wrap request middleware too, so DB timing headers retain its app duration/id.
app.add_middleware(DatabaseTimingMiddleware)


@app.get("/healthz", tags=["meta"])
async def healthz():
    import os
    from .services import task_rework
    # SODUWORK_DEPLOY_COMMIT identifies the source revision injected by the deployer.
    # Health verification can compare the running revision with the intended deployment.
    # SODUWORK_DEPLOY_AT supplies an ISO 8601 deployment timestamp; leave it empty when unavailable.
    release = os.environ.get("SODUWORK_DEPLOY_COMMIT", "").strip()
    version = os.environ.get("SODUWORK_HUB_VERSION", "").strip()
    # Monitor rework lastOkAt and pending counts for a stalled retry loop or growing backlog.
    # These health observations are per process in multi-worker deployments.
    return {"ok": True, "service": settings.service_name,
            "version": version if version and version != "dev" else release or settings.version,
            "apiVersion": settings.version,
            "commit": release,
            "releaseTag": os.environ.get("SODUWORK_RELEASE_TAG", "").strip(),
            "deployedAt": os.environ.get("SODUWORK_DEPLOY_AT", ""),
            "rework": task_rework.loop_health}


@app.get("/readyz", tags=["meta"])
async def readyz():
    from sqlalchemy import text
    from .services.cluster_bus import bus
    database_ready = False
    try:
        async def ping():
            async with SessionLocal() as session:
                await session.execute(text("SELECT 1"))
        await asyncio.wait_for(ping(), 3)
        database_ready = True
    except Exception:
        pass
    ready = database_ready and bus.healthy
    return JSONResponse(status_code=200 if ready else 503, content={
        "ready": ready, "database": database_ready, "cluster": bus.healthy,
        "mode": "multi-instance" if bus.enabled else "single-instance"})


@app.exception_handler(TaskOwnershipChanged)
async def task_ownership_conflict_handler(request: Request, exc: TaskOwnershipChanged):
    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.exception_handler(AuthCacheUnavailable)
async def auth_cache_unavailable(_request: Request, _exc: AuthCacheUnavailable):
    return JSONResponse(status_code=503, content={"detail": "权限同步暂时不可用，请稍后重试"})


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Log uncaught exceptions and return a generic HTTP 500 without exposing internal stack
    traces.
    """
    request.state.exception_type = type(exc).__name__
    request_id = getattr(request.state, "request_id", "")
    log.error("未捕获异常 request_id=%s %s %s: %s", request_id,
              request.method, request.url.path, exc, exc_info=True)
    return JSONResponse(status_code=500, content={"detail": "服务器内部错误"})


for _r in (cloud_execution_sync.router, legal_documents.router, legal_documents.admin_router, account_profile.router, account_profile.admin_router, admin_mail.router, client_email_auth.router, account_conversations.router, conversation_projects.router, remote_screen.router, im_api.router, admin_cloud_runners.router, cloud_environments.router, cloud_conversations.router, conversation_handoffs.router, session_memory.router, memory_records.router, memory_records.admin_router, client_auth.router, clients.router, tasks.router, retired_endpoints.router, task_options.router, approvals.router, delivery.router, aidesk.router, config_api.router,
           admin.router, quotas.router, model_runtime_api.router, model_capabilities_api.router, work_catalog_api.router, work_catalog_api.admin_router,
           release.router, environments.router, repomap.router, repositories.router, repository_issues.router, attachments.router, ingest.router,
           library.router, deliveries.router,
           plugins.router, plugins.run_router, plugin_publishers.router, plugin_client_catalog.router, plugin_client_runs.router, plugin_activity.router, plugin_permissions.router, plugin_permissions.admin_router, updates.router, download.router,
           client_updates.router, client_updates.admin_router, client_updates.deployment_router,
           client_release_notes.router, client_release_notes.admin_router,
           ws.router, term.router, agents.router, runner_ws.router, usage.router, ai_proxy.router,
           trace.router, trace.admin_router, evolution.router, evolution.admin_router, task_mcp.router,
           operations.router, identity.router, reports.router,
           capabilities.router, capabilities.admin_router, jiyong_data.router):
    app.include_router(_r)
app.include_router(personal_conversation_relay.router)
app.include_router(conversation_content_migrations.router)
from .api import desktop_capabilities
app.include_router(desktop_capabilities.router)


def _mount_frontend() -> None:
    """Serve hub-frontend/dist when built, after API and documentation routes. Development without
    built assets continues using the Vite server.
    """
    from pathlib import Path

    from fastapi.staticfiles import StaticFiles

    class _FrontendStaticFiles(StaticFiles):
        """Revalidate index.html on every request; cache content-hashed assets immutably."""

        def file_response(self, full_path, *args, **kwargs):
            response = super().file_response(full_path, *args, **kwargs)
            name = Path(full_path).name
            if name == "index.html" or "." not in name:
                response.headers["Cache-Control"] = "no-cache"
            else:
                response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            return response

    dist = Path(__file__).resolve().parent.parent.parent / "hub-frontend" / "dist"
    if (dist / "index.html").is_file():
        # The state-driven admin UI needs static root and asset serving without client-side route fallback.
        app.mount("/", _FrontendStaticFiles(directory=str(dist), html=True), name="frontend")


_mount_frontend()
