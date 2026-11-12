"""Authenticated Runner WebSocket and scoped management endpoints."""
from __future__ import annotations

import asyncio
import json
import logging
import hmac
import time

from fastapi import (APIRouter, Body, Depends, HTTPException, Request, WebSocket,
                     WebSocketDisconnect)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from ..db import SessionLocal, get_session
from ..deps import current_client, require_perm, identity_only
from ..models import AppSetting, Client, User
from ..realtime import hub as realtime_hub
from ..services import (audit, execution_capabilities,
                        execution_sessions, device_auth, runner_enroll,
                        runner_hub, runner_registry, runner_release, ws_frames)
from ..services.runner_inventory_scope import scope_for

from ..services.runner_admin_scope import (admin_allowed as _admin_allowed,
    admin_orgs as _admin_orgs, org_options as _org_options, row_in_scope as _row_in_scope,
    assigned_org as _assigned_org, admin_runner as _admin_runner)
from ..services.runner_access_policy import require_generic_admin_mutation, authenticated_identity
from ..services.runner_identity_error import RunnerIdentityConflict

log = logging.getLogger("uvicorn.error")
router = APIRouter(tags=["runner"])

_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}
_INSTALLABLE_COMPONENTS = {"office"}
_SETTLEMENT_KEYS: set[tuple[str, str]] = set()
_SETTLEMENT_JOBS: set[asyncio.Task] = set()
_TELEMETRY_JOBS: set[asyncio.Task] = set()
# Legacy telemetry remains best effort. Reliable frames receive an explicit
# retry response under pressure and stay in the Runner's durable outbox.
_TELEMETRY_QUEUE_MAX = 64
# Current Runners send hello before local capability probes. Released Runners do
# the probes first, with several serial 2.5-second command budgets. Keep a bounded
# rolling-upgrade window that covers that legacy path as well as slow machines.
_HELLO_TIMEOUT_S = 30


async def _receive_hello(websocket: WebSocket, peer: str,
                         timeout: float = _HELLO_TIMEOUT_S) -> dict | None:
    """Receive the first protocol frame within a bounded post-auth window.

    Current Runners send identity and cached inventory immediately; released
    Runners may still perform their bounded local capability scan first. The
    compatibility timeout covers both while reclaiming silent peers.
    """
    try:
        return await asyncio.wait_for(websocket.receive_json(), timeout=timeout)
    except asyncio.TimeoutError:
        await websocket.close(code=4408)
        log.warning("执行机握手超时未发送 hello: %s", peer)
        return None


def _enqueue_telemetry(queue: "asyncio.Queue", item) -> bool:
    """Keep the control loop responsive; reliable callers retain rejected frames."""
    try:
        queue.put_nowait(item)
        return True
    except asyncio.QueueFull:
        log.warning("Runner telemetry queue full: capacity=%d reliable=%s",
                    queue.maxsize, isinstance(item, dict))
        return False


def _stop_telemetry(queue: "asyncio.Queue") -> None:
    """Enqueue the worker shutdown sentinel, evicting one item if necessary to guarantee shutdown.

    """
    while True:
        try:
            queue.put_nowait(None)
            return
        except asyncio.QueueFull:
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                return


async def _persist_runner_heartbeat(runner, *, force: bool = False) -> bool:
    """Persist one heartbeat without letting transient storage failures drop the socket.

    ``runner_registry.record`` advances the in-memory write throttle before the
    surrounding transaction commits. Restore the prior value whenever either
    step fails so the next heartbeat retries immediately. Identity and lifecycle
    rejections remain connection-level failures and must reach the WebSocket
    handler.
    """
    previous_write = getattr(runner, "_registry_write", 0.0)
    try:
        async with SessionLocal() as session:
            if force:
                await runner_registry.record(session, runner, force=True)
            else:
                await runner_registry.record(session, runner)
            await session.commit()
    except (RunnerIdentityConflict, ValueError):
        runner._registry_write = previous_write
        raise
    except Exception as exc:  # noqa: BLE001 - transient persistence must not drop control channel
        runner._registry_write = previous_write
        log.warning("执行机 %s 心跳落库暂失败，下个心跳周期重试：%s",
                    runner.id, type(exc).__name__)
        return False
    return True


def _update_runner_capabilities(runner, value, *, persisted: bool) -> bool:
    """Apply a heartbeat report and say whether its first durable write is due."""
    if not isinstance(value, dict):
        return False
    runner.capabilities = execution_capabilities.clean_report(value)
    return not persisted and bool(runner.capabilities.get("reportedAt"))


async def _heartbeat_write(runner, websocket, *, force: bool) -> bool:
    """Keep registry writes off the reply reader while preserving revocation."""
    try:
        return await _persist_runner_heartbeat(runner, force=force)
    except RunnerIdentityConflict:
        await websocket.send_json({"op": "bye", "code": RunnerIdentityConflict.code,
                                   "error": str(RunnerIdentityConflict())})
        await websocket.close(code=4409)
    except ValueError:
        await websocket.close(code=1011, reason="执行机登记失败，请稍后重试")
    return False


async def _auth(token: str, peer: str, device: str = "", secret: str = "",
                runner_id: str = "", runner_key: str = "") -> tuple[bool, str]:
    """Return authorization and denial reason. Prefer device-specific secrets or per-Runner keys;
    retain deprecated shared tokens for migration. Without configured credentials, accept only
    loopback connections.
    """
    async with SessionLocal() as s:
        if device:
            try:
                await device_auth.client_from_secret(s, device, secret)
                return True, ""
            except device_auth.DeviceAuthError:
                return False, "SoduWork 设备身份或密钥不对"
        if runner_id and runner_key:
            if await runner_registry.verify_key(s, runner_id, runner_key):
                return True, ""
            return False, "执行机钥匙不对或已被吊销"
        row = (await s.execute(
            select(AppSetting).where(AppSetting.key == "runner_token"))).scalars().first()
    want = ((row.value if row else "") or "").strip()
    if want:
        matched = bool(token) and hmac.compare_digest(token, want)
        return (matched, "" if matched else "执行机令牌不对")
    # Without configured credentials, permit only loopback connections for local development Runners.
    if peer in _LOCAL_HOSTS:
        return True, ""
    return False, "还没配执行机令牌（管理端→设置里配 runner_token），远程执行机连不进来"


@router.get("/api/v1/runners")
@identity_only
async def list_runners(client: Client = Depends(current_client),
                       session: AsyncSession = Depends(get_session)):
    """List online execution machines for dispatch visibility and diagnostics."""
    # The desktop Runner view is a personal control surface. Shared and
    # organization-wide nodes remain available to admin/dispatch APIs, but
    # must not appear as another user's machine in this client.
    items = await runner_registry.list_nodes(
        session, {client.id}, set(),
        {str(client.user_ref)} if client.user_ref else set())
    # Versions and environments can share a physical hostname. Their actual
    # client/Runner identities must remain distinct, including while online.
    items = [{**item, "scope": scope_for(client, item)} for item in items
             if scope_for(client, item)]
    for item in items:
        item["owned"] = True
        item["manageable"] = True
        item["isCurrentDevice"] = item["scope"] == "current-instance"
    return {"runners": items}


async def _client_runner(session: AsyncSession, client: Client, runner_id: str):
    row = await session.get(am.RunnerNode, runner_id)
    if row is None or not scope_for(client, row):
        raise HTTPException(status_code=404, detail="执行节点不存在")
    # Cached IDs and elevated account roles cannot expand the desktop inventory.
    # Check both records before changing policy or sending an RPC to a live node.
    live = runner_hub.get(runner_id)
    if live is not None and not scope_for(client, live):
        raise HTTPException(status_code=404, detail="执行节点不存在")
    return row


@router.post("/api/v1/runners/{runner_id}/mode")
async def runner_mode(runner_id: str, body: dict = Body(default_factory=dict),
                      client: Client = Depends(current_client),
                      session: AsyncSession = Depends(get_session)):
    current = await _client_runner(session, client, runner_id)
    if scope_for(client, current) == "personal-cloud":
        # Retain the existing owner lock, administrative-state gate and audit.
        from ..services import cloud_environments
        result = await cloud_environments.update(session, client, runner_id,
                                                {"mode": str(body.get("mode") or "").strip().lower()})
        return {"ok": True, "runnerId": runner_id, "mode": result["environment"]["mode"]}
    try:
        row = await runner_registry.set_mode(session, runner_id, str(body.get("mode") or ""))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await session.commit()
    return {"ok": True, "runnerId": runner_id, "mode": row.dispatch_mode}


@router.post("/api/v1/runners/{runner_id}/probe")
async def runner_probe(runner_id: str, client: Client = Depends(current_client),
                       session: AsyncSession = Depends(get_session)):
    await _client_runner(session, client, runner_id)
    runner = runner_hub.get(runner_id)
    if runner is None:
        return {"ok": False, "runnerId": runner_id, "error": "执行节点当前离线"}
    started = time.perf_counter()
    result = await runner.call("runner.probe", {}, timeout=12)
    result["latencyMs"] = int((time.perf_counter() - started) * 1000)
    return result


async def _owned_embedded_runner(session: AsyncSession, client: Client, runner_id: str):
    """Employees may manage only their embedded Runner; administrators govern server and shared
    nodes.
    """
    await _client_runner(session, client, runner_id)
    live = runner_hub.get(runner_id)
    if live is None:
        raise HTTPException(status_code=409, detail="本机 Runner 当前不在线")
    if scope_for(client, live) != "current-instance":
        raise HTTPException(status_code=403, detail="独立和共享执行机请由管理员统一维护")
    return live


def _component_key(value: str) -> str:
    key = str(value or "").strip().lower()
    if key not in _INSTALLABLE_COMPONENTS:
        raise HTTPException(status_code=404, detail="这项能力不支持自动安装")
    return key


def _component_reply(runner, result: dict) -> dict:
    if not result.get("ok"):
        raise HTTPException(status_code=409, detail=str(result.get("error") or "执行机没有接受操作"))
    data = dict(result.get("data") or {})
    if data.get("capabilities"):
        runner.capabilities = execution_capabilities.clean_report(data["capabilities"])
    return {"ok": True, "data": data}


@router.post("/api/v1/runners/{runner_id}/components/{key}/install")
async def runner_component_install(
    runner_id: str, key: str, client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    live = await _owned_embedded_runner(session, client, runner_id)
    result = await live.call("component.install", {"key": _component_key(key)}, timeout=60)
    return _component_reply(live, result)


@router.get("/api/v1/runners/{runner_id}/components/jobs/{job_id}")
async def runner_component_job(
    runner_id: str, job_id: str, client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    live = await _owned_embedded_runner(session, client, runner_id)
    result = await live.call("component.job", {"jobId": str(job_id or "")[:64]}, timeout=30)
    return _component_reply(live, result)


async def _kick_runner(runner_id: str, code: int = 4401) -> bool:
    """Atomically stop routing to a node, then close its current channel."""
    live = runner_hub.get(runner_id)
    if live is None:
        return False
    await _drop_runner(runner_id, live.ws)
    try:
        await live.ws.close(code=code)
    except Exception:  # noqa: BLE001 - the peer may already be gone
        return False
    return True


async def _drop_runner(runner_id: str, websocket) -> bool:
    """Remove the exact live channel and clear its persisted volatile load."""
    from ..services import cluster_runtime
    current = runner_hub._RUNNERS.get(runner_id)
    released = False
    try:
        released = await cluster_runtime.release(current) if current and current.ws is websocket else False
    except Exception:
        pass  # Always remove the dead local socket, even during a Redis outage.
    removed = runner_hub.drop(runner_id, websocket)
    if not removed:
        return False
    if not released:
        return True  # A reconnect on another Hub now owns the durable live record.
    try:
        async with SessionLocal() as session:
            await runner_registry.mark_offline(session, runner_id)
            await session.commit()
    except Exception as exc:  # noqa: BLE001 - disconnect cleanup is best effort
        log.warning("Runner offline state cleanup failed %s: %s",
                    runner_id, type(exc).__name__)
    return True


@router.get("/api/v1/admin/runners")
async def admin_runners(user: User = Depends(require_perm("runner.manage")),
                        session: AsyncSession = Depends(get_session)):
    allowed_clients = await _admin_allowed(session, user)
    allowed_orgs = await _admin_orgs(session, user)
    items = await runner_registry.list_nodes(session, allowed_clients, allowed_orgs,
                                            include_personal_admin=True)
    organizations = await _org_options(session, allowed_orgs)
    return {
        **runner_release.enrich(items),
        "packages": runner_enroll.packages_info(),
        "organizations": organizations,
    }


@router.post("/api/v1/admin/runners/{runner_id}/probe")
async def admin_runner_probe(
    runner_id: str,
    user: User = Depends(require_perm("runner.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Run a real, read-only probe on one in-scope Runner."""
    await _admin_runner(session, user, runner_id)
    runner = runner_hub.get(runner_id)
    if runner is None:
        return {"ok": False, "runnerId": runner_id, "error": "执行节点当前离线"}
    started = time.perf_counter()
    result = await runner.call("runner.probe", {}, timeout=12)
    result["latencyMs"] = int((time.perf_counter() - started) * 1000)
    return result


@router.post("/api/v1/admin/runners/enroll")
async def admin_runner_enroll(request: Request, body: dict = Body(default_factory=dict),
                              user: User = Depends(require_perm("runner.manage")),
                              session: AsyncSession = Depends(get_session)):
    """Enroll a standalone machine and return its installation command. Supplying runnerId rotates
    its key and invalidates the old key immediately.
    """
    rid = str(body.get("runnerId") or "").strip()
    row = await session.get(am.RunnerNode, rid) if rid else None
    if row is not None:
        row = await _admin_runner(session, user, rid, lock=True)
        require_generic_admin_mutation(row)
    org_id = await _assigned_org(session, user, str(body.get("orgId") or ""), row)
    try:
        out = await runner_enroll.enroll(
            session, runner_id=rid, host=str(body.get("host") or ""),
            tags=body.get("tags") or [], hub=str(body.get("hub") or ""),
            request_base=str(request.base_url).rstrip("/"),
            work_root=str(body.get("workRoot") or ""), org_id=org_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await session.commit()
    kicked = await _kick_runner(out["runnerId"]) if out["rotated"] else False
    await audit.log(session, user, "runner.enroll", "runner", out["runnerId"],
                    str(body.get("host") or out["runnerId"]),
                    {"rotated": out["rotated"], "kicked": kicked,
                     "tags": out["tags"], "hub": out["hub"], "orgId": org_id})
    return {"ok": True, "kicked": kicked, **out}


@router.post("/api/v1/admin/runners/{runner_id}/issue-key")
async def admin_issue_key(runner_id: str, body: dict = Body(default_factory=dict),
                          user: User = Depends(require_perm("runner.manage")),
                          session: AsyncSession = Depends(get_session)):
    """Issue or rotate a per-machine key, returning plaintext once while storing only its hash."""
    row = await session.get(am.RunnerNode, runner_id)
    if row is not None:
        row = await _admin_runner(session, user, runner_id, lock=True)
        require_generic_admin_mutation(row)
    org_id = await _assigned_org(session, user, str(body.get("orgId") or ""), row)
    try:
        key = await runner_registry.issue_key(session, runner_id,
                                              host=str(body.get("host") or ""), org_id=org_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await session.commit()
    kicked = await _kick_runner(runner_id) if row is not None else False
    await audit.log(session, user, "runner.issue_key", "runner", runner_id, runner_id,
                    {"rotated": row is not None, "kicked": kicked})
    return {"ok": True, "runnerId": runner_id, "orgId": org_id, "key": key,
            "kicked": kicked,
            "note": "钥匙只显示这一次；配到那台机器的 SODUWORK_RUNNER_KEY。"}


@router.post("/api/v1/admin/runners/{runner_id}/revoke-key")
async def admin_revoke_key(runner_id: str,
                           user: User = Depends(require_perm("runner.manage")),
                           session: AsyncSession = Depends(get_session)):
    """Revoke one machine's key and disconnect it without affecting other Runners."""
    row = await _admin_runner(session, user, runner_id, lock=True)
    require_generic_admin_mutation(row)
    await runner_registry.revoke_key(session, runner_id)
    await session.commit()
    kicked = await _kick_runner(runner_id)
    await audit.log(session, user, "runner.revoke_key", "runner", runner_id, runner_id,
                    {"kicked": kicked})
    return {"ok": True, "runnerId": runner_id, "kicked": kicked}


@router.delete("/api/v1/admin/runners/{runner_id}")
async def admin_runner_delete(runner_id: str,
                              user: User = Depends(require_perm("runner.manage")),
                              session: AsyncSession = Depends(get_session)):
    """Delete an offline Runner registration after revoking its key, preserving execution history
    by runner_id. Reject deletion while online to prevent heartbeat recreation.
    """
    row = await _admin_runner(session, user, runner_id, lock=True)
    require_generic_admin_mutation(row)
    blocker = await runner_registry.active_session_blocker(session, runner_id)
    if blocker:
        raise HTTPException(409, blocker)
    if runner_hub.get(runner_id) is not None:
        raise HTTPException(status_code=409,
                            detail="这台还连着。先吊销钥匙或把它停掉，再删这一行。")
    host = row.enroll_name or row.host or runner_id
    await session.delete(row)
    await session.commit()
    await audit.log(session, user, "runner.delete", "runner", runner_id, host, {})
    return {"ok": True, "runnerId": runner_id}


@router.post("/api/v1/admin/runners/{runner_id}/mode")
async def admin_runner_mode(runner_id: str, body: dict = Body(default_factory=dict),
                            user: User = Depends(require_perm("runner.manage")),
                            session: AsyncSession = Depends(get_session)):
    row = await _admin_runner(session, user, runner_id, lock=True)
    require_generic_admin_mutation(row)
    if row.owner_user_id:
        raise HTTPException(409, "个人云端电脑请使用管理员启用或停用操作")
    before = row.dispatch_mode
    try:
        row = await runner_registry.set_mode(session, runner_id, str(body.get("mode") or ""))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await session.commit()
    await audit.log(session, user, "runner.mode", "runner", runner_id, row.host,
                    {"before": before, "after": row.dispatch_mode})
    return {"ok": True, "runnerId": runner_id, "mode": row.dispatch_mode}


async def _admin_component_runner(session: AsyncSession, user: User, runner_id: str):
    row = await _admin_runner(session, user, runner_id)
    live = runner_hub.get(runner_id)
    if live is None:
        raise HTTPException(status_code=409, detail="执行节点当前离线")
    if runner_hub.is_client_runtime(live):
        raise HTTPException(status_code=409, detail="员工电脑上的组件请由机器所有者在客户端安装")
    return row, live


@router.post("/api/v1/admin/runners/{runner_id}/components/{key}/install")
async def admin_runner_component_install(
    runner_id: str, key: str,
    user: User = Depends(require_perm("runner.manage")),
    session: AsyncSession = Depends(get_session),
):
    row, live = await _admin_component_runner(session, user, runner_id)
    result = await live.call("component.install", {"key": _component_key(key)}, timeout=60)
    out = _component_reply(live, result)
    await audit.log(session, user, "runner.component.install", "runner", runner_id,
                    row.enroll_name or row.host or runner_id, {"component": key})
    return out


@router.get("/api/v1/admin/runners/{runner_id}/components/jobs/{job_id}")
async def admin_runner_component_job(
    runner_id: str, job_id: str,
    user: User = Depends(require_perm("runner.manage")),
    session: AsyncSession = Depends(get_session),
):
    _row, live = await _admin_component_runner(session, user, runner_id)
    result = await live.call("component.job", {"jobId": str(job_id or "")[:64]}, timeout=30)
    return _component_reply(live, result)


async def _publish_task_owner(task_id: str, event: dict) -> None:
    # Task cards follow the authorized audience and its per-client projection.
    # Raw execution updates remain restricted to the frozen execution owner.
    from ..models import Task
    from ..services.task_access import publish_owner, publish_task
    async with SessionLocal() as session:
        task = await session.get(Task, task_id)
        if task is not None:
            if event.get("type") == "task.updated":
                await publish_task(session, task, "task.updated", event.get("task"))
            else:
                await publish_owner(session, task, event)


async def _publish_session_updates(updates: list) -> None:
    for item in updates:
        if item.get("clientId"):
            await _publish_task_owner(item["taskId"], {
                "type": "execution.updated", "taskId": item["taskId"],
                "session": item["session"],
            })
            if item.get("task"):
                await _publish_task_owner(item["taskId"], {
                    "type": "task.updated", "task": item["task"],
                })
        if item.get("settleTerminal"):
            _schedule_terminal_settlement(item["taskId"], item["session"].get("ref") or "")


async def _ingest_sessions(r, sessions: list) -> None:
    """Persist session increments and send lightweight notifications to task-owning clients for
    both heartbeat and live updates.
    """
    try:
        async with SessionLocal() as s:
            updates = await execution_sessions.ingest_runner_snapshots(s, r, sessions)
            await s.commit()
        await _publish_session_updates(updates)
    except Exception as e:  # noqa: BLE001  Persistence failures must not disconnect an active Runner.
        log.warning("执行会话留存失败 %s: %s", r.id, type(e).__name__)


async def _ingest_delivery(r, message: dict) -> None:
    from ..services import runner_event_delivery
    try:
        async with SessionLocal() as session:
            ack, updates = await runner_event_delivery.ingest(session, r, message)
            await session.commit()
        # A failed send after commit is safe: the Runner retransmits and the
        # next transaction recognizes the already durable receipt.
        await r.send(ack)
        await _publish_session_updates(updates)
    except runner_event_delivery.DeliveryRejected as exc:
        await r.send({"op": "session.nack", "version": 1, "runnerId": r.id,
                      "bootId": r.boot_id, "ref": message.get("ref"),
                      "streamId": message.get("streamId"),
                      "deliverySeq": message.get("deliverySeq"), "code": exc.code,
                      "expectedDeliverySeq": exc.expected})
    except Exception as exc:  # no ACK before commit; disk replay is the retry path
        log.warning("Runner durable event delivery pending runner=%s error=%s", r.id, type(exc).__name__)


async def _reconcile_runner_restart(r) -> None:
    """Publish authoritative interruption for queued work lost by a process restart."""
    try:
        async with SessionLocal() as session:
            updates = await execution_sessions.reconcile_runner_restart(session, r)
            await session.commit()
        for item in updates:
            if item.get("clientId"):
                await _publish_task_owner(item["taskId"], {
                    "type": "execution.updated", "taskId": item["taskId"],
                    "session": item["session"],
                })
    except Exception as exc:  # noqa: BLE001 - recovery must not reject a healthy Runner
        log.warning("执行机重启排队对账失败 %s: %s", r.id, type(exc).__name__)


def _schedule_terminal_settlement(task_id: str, ref: str) -> None:
    """Settle terminal runs outside the WebSocket receive stack so job.status responses can still
    be consumed.
    """
    key = (str(task_id or ""), str(ref or ""))
    if not all(key) or key in _SETTLEMENT_KEYS:
        return
    _SETTLEMENT_KEYS.add(key)
    job = asyncio.create_task(_settle_terminal_background(*key))
    _SETTLEMENT_JOBS.add(job)
    job.add_done_callback(_SETTLEMENT_JOBS.discard)


async def _settle_terminal_background(task_id: str, ref: str) -> None:
    key = (task_id, ref)
    try:
        # Retry briefly when file listings lag metadata; the 120-second supervisor reconciles remaining failures.
        for delay in (0, 1, 4, 12):
            if delay:
                await asyncio.sleep(delay)
            from ..services import execution_settlement
            try:
                async with SessionLocal() as session:
                    out = await execution_settlement.settle_terminal(session, task_id, ref)
            except Exception as exc:  # noqa: BLE001  Background settlement failures must not disconnect the Runner.
                log.warning(
                    "执行终态结算失败 task=%s ref=%s: %s",
                    task_id, ref[:12], type(exc).__name__)
                out = {"ok": False, "retry": True}
            target = dict(out.get("workflowTarget") or {})
            if out.get("ok") and target:
                from ..services import workflow_engine
                try:
                    async with SessionLocal() as workflow_session:
                        wake = await workflow_engine.reconcile_terminal_execution(
                            workflow_session,
                            target.get("workflowRunId") or "",
                            target.get("nodeRunId") or "",
                            target.get("ref") or ref,
                        )
                except Exception as exc:  # noqa: BLE001 - periodic repair is the fallback
                    log.warning(
                        "执行终态推进工作流失败 task=%s ref=%s: %s",
                        task_id, ref[:12], type(exc).__name__)
                    wake = {"ok": False, "retry": True}
                if not wake.get("ok"):
                    out = {**out, "ok": False,
                           "retry": bool(wake.get("retry", True))}
            if out.get("task") and out.get("clientId"):
                await _publish_task_owner(task_id, {
                    "type": "task.updated",
                    "task": out["task"],
                })
            if out.get("ok") or not out.get("retry"):
                return
        log.warning("执行终态暂未结算，等待巡检补课 task=%s ref=%s", task_id, ref[:12])
    finally:
        _SETTLEMENT_KEYS.discard(key)


async def _ingest_deployments(r, snapshots: list) -> None:
    """Persist release stages and check evidence promptly; the ten-second supervisor reconciles
    disconnected updates.
    """
    try:
        from ..services import deployments
        async with SessionLocal() as s:
            updates = await deployments.ingest_runner_snapshots(s, r, snapshots)
        for item in updates:
            if item.get("clientId"):
                await _publish_task_owner(item["taskId"], {
                    "type": "execution.updated", "taskId": item["taskId"],
                    "deployment": item["deployment"],
                })
    except Exception as e:  # noqa: BLE001  Evidence persistence failures must not interrupt publication.
        log.warning("发布实况留存失败 %s: %s", r.id, type(e).__name__)


async def _telemetry_worker(r, queue: asyncio.Queue) -> None:
    """Persist Runner telemetry in order without blocking control-plane replies."""
    while True:
        item = await queue.get()
        try:
            if item is None:
                return
            if isinstance(item, dict):
                await _ingest_delivery(r, item)
                continue
            sessions, deployments = item
            if sessions:
                await _ingest_sessions(r, sessions)
            if deployments:
                await _ingest_deployments(r, deployments)
        finally:
            queue.task_done()


@router.websocket("/api/v1/runner")
async def runner_ws(websocket: WebSocket, token: str = ""):
    peer = (websocket.client.host if websocket.client else "") or ""
    headers = websocket.headers
    header_token = str(headers.get("x-soduwork-runner-token") or "")
    device = str(headers.get("x-soduwork-device") or "")
    secret = str(headers.get("x-soduwork-secret") or "")
    keyed_id = str(headers.get("x-soduwork-runner-id") or "")
    runner_key = str(headers.get("x-soduwork-runner-key") or "")
    okk, why = await _auth(header_token or token, peer, device, secret, keyed_id, runner_key)
    if not okk:
        await websocket.close(code=4401)
        log.warning("执行机被拒: %s（%s）", peer, why)
        return
    await websocket.accept()
    runner_hub.bind_loop()      # Retain the event loop for provider calls from worker threads; see call_sync.

    r = None
    telemetry_queue = None
    telemetry_job = None
    heartbeat_job = None
    heartbeat_force = False
    try:
        # Bound the handshake phase: an authenticated but silent peer must not
        # pin a coroutine and socket indefinitely. Neither cleanup mechanism
        # covers this window - the connection is not registered in runner_hub
        # yet, so heartbeat-based reaping never sees it.
        hello = await _receive_hello(websocket, peer, _HELLO_TIMEOUT_S)
        if hello is None:
            return
        if str(hello.get("op") or "") != "hello":
            await websocket.send_json({"op": "bye", "error": "第一句必须是 hello"})
            await websocket.close()
            return
        # Require a keyed Runner's reported identity to match the machine associated with its key.
        # Otherwise one machine could impersonate another and corrupt execution attribution.
        if keyed_id and str(hello.get("runnerId") or "") != keyed_id:
            await websocket.send_json({"op": "bye", "error": "执行机身份与钥匙不符"})
            await websocket.close(code=4403)
            return
        hello_client = str(hello.get("clientId") or "")
        if device and hello_client != device:
            await websocket.send_json({"op": "bye", "error": "执行机归属与设备密钥不符"})
            await websocket.close(code=4403)
            return
        if not device and hello_client:
            await websocket.send_json({"op": "bye", "error": "独立执行机不能冒充桌面客户端"})
            await websocket.close(code=4403)
            return
        try:
            r = runner_hub.add(websocket, hello)
        except ValueError as exc:
            await websocket.send_json({"op": "bye", "error": str(exc),
                                       "code": getattr(exc, "code", "RUNNER_REGISTRATION_REJECTED")})
            await websocket.close(code=4409)
            return
        # Revalidate after registration to close the revocation race between authentication and registration.
        valid_after_register = True
        async with SessionLocal() as s:
            if device:
                try:
                    verified_client = await device_auth.client_from_secret(s, device, secret)
                    if verified_client.user_ref:
                        owner = await s.get(User, verified_client.user_ref)
                        r.owner_name = str(
                            (owner.display_name or owner.username) if owner
                            else (verified_client.name or ""))[:80]
                        r.org_id = str(owner.org_id or "")[:36] if owner else ""
                except device_auth.DeviceAuthError:
                    valid_after_register = False
            elif keyed_id and runner_key:
                valid_after_register = await runner_registry.verify_key(s, keyed_id, runner_key)
                keyed_row = await s.get(am.RunnerNode, keyed_id)
                r.org_id = str(keyed_row.org_id or "")[:36] if keyed_row else ""
            valid_after_register = bool(valid_after_register and
                await authenticated_identity(s, r.id, keyed_id, runner_key))
        if not valid_after_register:
            await _drop_runner(r.id, websocket)
            await websocket.send_json({"op": "bye", "error": "执行机授权已失效"})
            await websocket.close(code=4403)
            return
        async with SessionLocal() as s:
            await runner_registry.record(s, r, force=True)
            await s.commit()
        capability_report_persisted = bool(r.capabilities.get("reportedAt"))
        # Advertise Hub capabilities in welcome; send binary frames only after negotiating bin1.
        # Legacy hello messages omit caps and retain the original encoding throughout rolling upgrades.
        # The registry becomes dispatchable only after welcome is on the wire.  Previously
        # a recovery probe could arrive in this gap and the Runner consumed it as welcome.
        from ..services import cluster_runtime
        await cluster_runtime.register(r)
        await r.send({"op": "welcome", "runnerId": r.id,
                      "serverTime": int(time.time()),
                      "caps": [ws_frames.CAP_BIN1, "sessionAck1"]})
        r.ready = True
        await _reconcile_runner_restart(r)
        log.info("执行机上线: %s @ %s（%d 个 agent%s）", r.id, r.host, len(r.agents),
                 "，二进制帧" if r.bin else "")

        # Persisting telemetry can involve database writes and client fan-out.
        # Keep it ordered without making probe/dispatch replies wait behind that I/O.
        telemetry_queue = asyncio.Queue(maxsize=_TELEMETRY_QUEUE_MAX)
        telemetry_job = asyncio.create_task(_telemetry_worker(r, telemetry_queue))
        _TELEMETRY_JOBS.add(telemetry_job)
        telemetry_job.add_done_callback(_TELEMETRY_JOBS.discard)

        while True:
            packet = await websocket.receive()
            if packet.get("type") == "websocket.disconnect":
                break
            if packet.get("bytes") is not None:
                # Binary frames carry only the supported large-payload types; discard malformed frames without closing the connection.
                try:
                    kind, meta, payload = ws_frames.decode(packet["bytes"])
                except Exception:  # noqa: BLE001
                    log.warning("执行机 %s 发来解不开的二进制帧", r.id)
                    continue
                if kind == ws_frames.KIND_TERM_OUT:
                    runner_hub.term_feed(r, str(meta.get("task") or ""),
                                         payload.decode("utf-8", "replace"))
                elif kind == ws_frames.KIND_REPLY_CHUNK:
                    reply = {"op": "reply", "id": str(meta.get("id") or ""),
                             "ok": bool(meta.get("ok", True)),
                             **({"error": meta["error"]} if meta.get("error") else {}),
                             "data": {**dict(meta.get("data") or {}), "bytes": payload}}
                    r.resolve(reply["id"], reply)
                continue
            if packet.get("text") is None:
                continue
            try:
                msg = json.loads(packet["text"])
            except Exception:  # noqa: BLE001
                continue
            op = str(msg.get("op") or "")
            if op == "beat":
                if heartbeat_job is not None and heartbeat_job.done():
                    if heartbeat_job.result() and heartbeat_force:
                        capability_report_persisted = True
                    heartbeat_job = None
                r.last_beat = time.time()
                r.busy = max(0, int(msg.get("busy") or 0))
                if msg.get("maxConcurrent") is not None:
                    r.max_concurrent = runner_hub.clean_max_concurrent(
                        msg.get("maxConcurrent"), r.max_concurrent)
                r.adaptive_limit = runner_hub.clean_max_concurrent(
                    msg.get("adaptiveLimit"), r.max_concurrent)
                r.max_concurrent = r.adaptive_limit
                r.concurrency_ceiling = runner_hub.clean_max_concurrent(
                    msg.get("concurrencyCeiling"), r.concurrency_ceiling)
                r.queue_depth = runner_hub.clean_counter(
                    msg.get("queueDepth"), r.queue_depth)
                r.queued_conversations = runner_hub.clean_counter(
                    msg.get("queuedConversations"), r.queued_conversations)
                r.queued_tasks = runner_hub.clean_counter(
                    msg.get("queuedTasks"), r.queued_tasks)
                r.task_outstanding = runner_hub.clean_counter(
                    msg.get("taskOutstanding"), r.task_outstanding)
                r.task_queue_capacity = runner_hub.clean_counter(
                    msg.get("taskQueueCapacity"), r.task_queue_capacity, 10_000)
                r.cpu_percent = runner_hub.clean_percent(
                    msg.get("cpuPercent"), r.cpu_percent)
                r.memory_percent = runner_hub.clean_percent(
                    msg.get("memoryPercent"), r.memory_percent)
                r.memory_available_bytes = runner_hub.clean_counter(
                    msg.get("memoryAvailableBytes"), r.memory_available_bytes, 1 << 60)
                r.resource_pressure = str(
                    msg.get("resourcePressure") or r.resource_pressure or "normal")[:20]
                if msg.get("workRoot") is not None:
                    r.work_root = str(msg.get("workRoot") or "")[:500]
                if isinstance(msg.get("tags"), list):
                    r.tags = [str(x).strip().lower()[:40] for x in msg["tags"]
                              if str(x).strip()][:20]
                # Refresh installed-agent inventory from heartbeats to reflect changes on the Runner.
                if isinstance(msg.get("agents"), list):
                    r.agents = msg["agents"]
                    r.inventory_ready = True
                if isinstance(msg.get("skills"), list):
                    r.skills = runner_hub.clean_skill_names(msg["skills"])
                    r.skills_known = True
                if isinstance(msg.get("skillCatalog"), list):
                    r.skill_catalog = runner_hub.clean_skill_catalog(
                        msg["skillCatalog"])
                force_capability_write = _update_runner_capabilities(
                    r, msg.get("capabilities"), persisted=capability_report_persisted)
                # Persist node metadata every 45 seconds rather than on each 20-second heartbeat.
                # Use live heartbeat state for availability while reducing redundant database writes.
                # Content RPCs may hold a policy transaction until their reply.
                # Awaiting a registry write here blocks that reply behind the
                # same database lock. Coalesce writes, but keep receiving frames.
                if heartbeat_job is None and (force_capability_write or
                        time.time() - r._registry_write >= runner_registry.PERSIST_EVERY_S):
                    heartbeat_force = force_capability_write
                    heartbeat_job = asyncio.create_task(_heartbeat_write(
                        r, websocket, force=heartbeat_force))
                # Persist session events even when no client is watching, enabling later replay.
                # Notify after persistence; clients refresh by taskId instead of receiving full logs through task WebSockets.
                if isinstance(msg.get("sessions"), list) and msg["sessions"]:
                    _enqueue_telemetry(telemetry_queue, (msg["sessions"], []))
            elif op == "session.deliver":
                if "sessionAck1" not in r.caps:
                    continue
                oversized = len(packet["text"].encode("utf-8")) > 1024 * 1024
                if oversized or not _enqueue_telemetry(telemetry_queue, msg):
                    await r.send({"op": "session.nack", "version": 1,
                                  "runnerId": r.id, "bootId": r.boot_id,
                                  "ref": msg.get("ref"), "streamId": msg.get("streamId"),
                                  "deliverySeq": msg.get("deliverySeq"),
                                  "code": "DELIVERY_TOO_LARGE" if oversized else "DELIVERY_BACKPRESSURE"})
            elif op == "session.event":
                # Push normalized Runner events immediately rather than waiting for the next heartbeat.
                # Live updates and heartbeat sessions share persistence and notification logic, deduplicated by session and sequence.
                # Retain job.session polling for reconnect recovery and reconciliation.
                if isinstance(msg.get("sessions"), list) and msg["sessions"]:
                    sessions = msg["sessions"]
                else:
                    sessions = []
                deployments = msg["deployments"] if isinstance(msg.get("deployments"), list) else []
                _enqueue_telemetry(telemetry_queue, (sessions, deployments))
            elif op == "reply":
                r.resolve(str(msg.get("id") or ""), msg)
            elif op == "term.out":
                runner_hub.term_feed(r, str(msg.get("task") or ""), msg.get("d") or "")
            elif op == "term.end":
                runner_hub.term_feed(r, str(msg.get("task") or ""), None)
            elif op == "event":
                # Record live diagnostics here; task dispatch integration supplies timeline events.
                # Event payloads may contain tool output or future credential-bearing fields.
                # Keep logs useful without serializing the protocol envelope.
                log.debug("runner event id=%s type=%s ref=%s", r.id,
                          str(msg.get("type") or msg.get("kind") or "")[:40],
                          str(msg.get("ref") or msg.get("task") or "")[:40])
            else:
                log.debug("执行机发来不认识的 op: %s", op)
    except RunnerIdentityConflict:
        await websocket.send_json({"op": "bye", "code": RunnerIdentityConflict.code,
                                   "error": str(RunnerIdentityConflict())})
        await websocket.close(code=4409)
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        log.warning("执行机连接异常 %s: %s", getattr(r, "id", "?"), type(e).__name__)
        # An accepted socket must be closed even if registration fails before
        # welcome. Otherwise older clients wait forever and newer ones time out.
        try:
            await websocket.close(code=1011, reason="执行机登记失败，请稍后重试")
        except Exception:
            pass
    finally:
        if heartbeat_job is not None:
            heartbeat_job.cancel()
            await asyncio.gather(heartbeat_job, return_exceptions=True)
        if telemetry_queue is not None:
            _stop_telemetry(telemetry_queue)
        if r is not None:
            # Remove only the matching WebSocket so an old connection's cleanup cannot remove its replacement.
            await _drop_runner(r.id, websocket)
            log.info("执行机下线: %s", r.id)
