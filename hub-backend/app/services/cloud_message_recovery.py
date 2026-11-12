"""Durable continuation intents for an existing, account-owned cloud execution.

Only Runners with durable admission are eligible. Retries keep the original
turnId; a negative receipt from a different Runner boot never proves no effect.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update

from .. import models
from ..automation_models import ExecutionSession
from ..conversation_handoff_models import ConversationHandoff as Handoff
from ..conversation_handoff_models import ConversationMessageReceipt as Receipt
from ..db import SessionLocal
from . import ai_exec, ai_remote, cloud_turn_selection, runner_hub

log = logging.getLogger(__name__)
PENDING = ("queued", "sending", "uncertain")


def now():
    return datetime.now(timezone.utc)


async def envelope(session, client, task_id, ref, text, ctx):
    """Capture immutable routing and selection, excluding renewable secrets."""
    handoff = await session.scalar(select(Handoff).where(Handoff.task_id == task_id))
    execution = await session.scalar(select(ExecutionSession).where(
        ExecutionSession.task_id == task_id, ExecutionSession.ref == ref))
    if (handoff is None or handoff.phase != "committed" or not client.user_ref
            or handoff.owner_user_id != client.user_ref or execution is None):
        return None
    runner = runner_hub.get(execution.runner_id)
    if not runner or "admit1" not in getattr(runner, "caps", []):
        return None
    cfg = ai_exec._cfg_of(ctx, ai_remote)
    from .execution_selection import normalize
    chosen = cfg.get("_executionSelection") or (handoff.receipt or {}).get("activeExecutionSelection") or {
        "agentId": cfg.get("local_cli") or (handoff.options or {}).get("agentId") or
                   ((handoff.options or {}).get("targetSnapshot") or {}).get("agentId"),
        "modelName": (handoff.options or {}).get("model", ""), "reasoningEffort": ""}
    result = {"schema": 1, "ownerUserId": client.user_ref, "ref": ref,
            "runnerId": runner.id, "runnerBootId": "", "text": text,
            "executionSelection": normalize(chosen)}
    if ctx.get("_turnPlugins"):
        result["plugins"] = ctx["_turnPlugins"]
    if ctx.get("_turnSkills"):
        result["skills"] = ctx["_turnSkills"]
    if ctx.get("_turnFiles"):
        # Keep bounded user material with the pending intent so a Hub restart
        # cannot deliver text without its files. Acceptance clears the payload.
        result["files"] = [{"name": name, "data": base64.b64encode(data).decode("ascii"), "contentType": mime}
                           for name, data, mime in ctx["_turnFiles"]]
    return result


def public(row):
    result = dict(row.receipt or {})
    if row.phase == "accepted":
        return {**result, "ok": True, "messageId": row.message_id,
                "delivery": "accepted", "duplicate": bool(result.get("duplicate"))}
    if row.phase == "rejected":
        return {**result, "ok": False, "messageId": row.message_id, "delivery": "rejected"}
    if row.phase == "uncertain":
        return {**result, "ok": False, "pending": True, "uncertain": True,
                "messageId": row.message_id, "delivery": "uncertain",
                "error": "云端已保存这条消息，正在核对执行机回执，请不要重复发送"}
    return {"ok": True, "queued": True, "messageId": row.message_id,
            "delivery": "queued", "note": "云端已接收，等待执行机确认"}


async def _save(session, row, attempts, phase, result, *, retry=True, commit=True):
    values = {"phase": phase, "receipt": dict(result),
              "retry_after": (now() + timedelta(seconds=min(900, 10 * 2 ** min(attempts, 6))))
              if retry and phase in PENDING else None}
    if phase == "accepted":
        values["payload"] = None
    changed = await session.execute(update(Receipt).where(
        Receipt.id == row.id, Receipt.phase.in_(PENDING),
        Receipt.recovery_attempts == attempts,
    ).values(**values).execution_options(synchronize_session=False))
    if changed.rowcount:
        from .cloud_sync_notifications import mark
        mark(session, row.task_id)
    if commit:
        await session.commit()
    return bool(changed.rowcount)


async def _accept(session, row, attempts, handoff, receipt):
    # The next default turn must see the choice belonging to this receipt,
    # even if the Hub dies immediately after committing acceptance.
    ref = str((row.payload or {}).get("ref") or "")
    changed = await _save(session, row, attempts, "accepted", receipt, commit=False)
    if changed:
        await cloud_turn_selection.accepted(session, handoff, receipt, commit=False)
        from . import task_rework
        await task_rework.acknowledge_continuation(session, row.task_id,
            ref, row.created_at,
            actor=row.owner_client_id)
    await session.commit()
    return changed


async def deliver(row_id):
    async with SessionLocal() as session:
        row = await session.get(Receipt, row_id)
        if not row or row.phase not in PENDING or not isinstance(row.payload, dict) or not row.payload:
            return "stale"
        payload = dict(row.payload)
        attempts = int(row.recovery_attempts or 0) + 1
        row.recovery_attempts = attempts
        row.retry_after = now() + timedelta(seconds=min(900, 10 * 2 ** min(attempts, 6)))
        await session.commit()
        caller = await session.get(models.Client, row.owner_client_id)
        user = await session.get(models.User, payload.get("ownerUserId", ""))
        task = await session.get(models.Task, row.task_id)
        handoff = await session.scalar(select(Handoff).where(Handoff.task_id == row.task_id))
        if (not caller or caller.user_ref != payload.get("ownerUserId") or not user or not user.is_active
                or not handoff or handoff.owner_user_id != user.id or not task or task.status == "cancel"):
            await _save(session, row, attempts, "rejected", {"error": "任务状态或账号授权已变更，请核对后继续"})
            return "rejected"
        execution = await session.scalar(select(ExecutionSession).where(
            ExecutionSession.task_id == row.task_id, ExecutionSession.ref == payload["ref"],
            ExecutionSession.runner_id == payload["runnerId"]))
        if execution is None:
            await _save(session, row, attempts, "uncertain", {"error": "原执行会话待核对"}, retry=False)
            return "uncertain"
        runner = runner_hub.get(payload["runnerId"])
        if not runner or not runner.alive() or "admit1" not in getattr(runner, "caps", []):
            return "waiting"
        durable_payload = dict(payload)
        if payload.get("contentRef"):
            from . import conversation_content
            try:
                saved = await conversation_content.get_json(payload["contentRef"], user.id, "message:" + row.id, session=session)
            except Exception:
                return "waiting"
            if any(saved.get(key) != payload.get(key) for key in ("ownerUserId", "ref", "runnerId")):
                await _save(session, row, attempts, "uncertain", {"error": "已保存消息的执行归属不匹配"}, retry=False)
                return "uncertain"
            payload = {**saved, "runnerBootId": durable_payload.get("runnerBootId", "")}
        # Hydration borrows this transaction's personal Runner policy lock.
        # Admission probes and file uploads authorize in their own transaction;
        # release the read lock before either RPC can wait on its own caller.
        # The attempt was already persisted; the sending claim below still
        # fences concurrent recovery and commits before job.comment.
        await session.commit()
        boot = str(getattr(runner, "boot_id", "") or "")
        key = "comment:" + row.id
        if row.phase != "queued":
            try:
                probe = await runner.call("job.has", {"ref": payload["ref"], "admissionKey": key}, timeout=15)
            except Exception:
                return "waiting"
            data = probe.get("data") or {}
            if (not probe.get("ok") or data.get("admissionDurable") is not True
                    or data.get("admissionKey") != key):
                return "waiting"
            if data.get("has"):
                receipt = {**data, "ok": True, "duplicate": True}
                await _accept(session, row, attempts, handoff, receipt)
                return "confirmed"
            if not boot or boot != payload.get("runnerBootId") or boot != str(data.get("bootId") or ""):
                await _save(session, row, attempts, "uncertain", {"error": "执行机已重启，原消息执行结果待核对"})
                return "uncertain"
        try:
            ctx = await ai_exec.load(session, force=True)
            ctx = await cloud_turn_selection.prepare(session, caller, ctx, handoff, payload.get("executionSelection"))
        except Exception as error:
            # Capacity and authorization can be repaired without losing intent.
            log.warning("Cloud message %s awaits preparation: %s", row.id, type(error).__name__)
            return "waiting"
        cfg = dict(ai_exec._cfg_of(ctx, ai_remote))
        selection = cfg.pop("_executionSelection", None)
        plugin_turn = None
        if payload.get("skills"):
            from . import conversation_turn_skills
            try:
                await conversation_turn_skills.validate(session, caller, handoff,
                    payload["ref"], payload["skills"])
            except Exception as error:
                await _save(session, row, attempts, "rejected", {"error": str(getattr(error, "detail", error))})
                return "rejected"
        if payload.get("plugins"):
            from . import conversation_turn_plugins
            try:
                await conversation_turn_plugins.validate(session, caller, handoff, payload["ref"], payload["plugins"])
                plugin_turn = conversation_turn_plugins.authorization(caller, runner,
                    payload["ref"], payload["plugins"], row.id)
            except Exception as error:
                await _save(session, row, attempts, "rejected", {"error": str(getattr(error, "detail", error))})
                return "rejected"
        packet = {}
        if payload.get("files"):
            if "turnFiles1" not in getattr(runner, "caps", []):
                return "waiting"
            from fastapi import HTTPException
            from . import conversation_turn_files
            try:
                files, _ = conversation_turn_files.decode(payload["files"])
            except HTTPException:
                await _save(session, row, attempts, "rejected", {"error": "已保存的补充文件无效，请重新选择"})
                return "rejected"
            packet, error = await asyncio.to_thread(ai_remote._upload_inputs, runner, files)
            if error:
                return "waiting"
        payload["runnerBootId"] = boot
        durable_payload = {**durable_payload, "runnerBootId": boot} if durable_payload.get("contentRef") else payload
        changed = await session.execute(update(Receipt).where(
            Receipt.id == row.id, Receipt.phase.in_(PENDING), Receipt.recovery_attempts == attempts,
        ).values(phase="sending", payload=durable_payload).execution_options(synchronize_session=False))
        if changed.rowcount:
            from .cloud_sync_notifications import mark
            mark(session, row.task_id)
        await session.commit()
        if not changed.rowcount:
            await asyncio.to_thread(ai_remote._drop_packet, runner, packet)
            return "stale"
        try:
            reply = await runner.call("job.comment", {
                "ref": payload["ref"], "text": payload["text"], "cfg": cfg,
                "recordUser": True, "turnId": row.id,
                **({"turnSkills": payload["skills"]} if payload.get("skills") else {}),
                **({"pluginTurn": plugin_turn} if plugin_turn else {}),
                **({"files": packet} if packet else {}),
                **({"executionSelection": selection} if selection is not None else {}),
            }, timeout=60)
        except Exception:
            await _save(session, row, attempts, "uncertain", {"uncertain": True})
            return "uncertain"
        if reply.get("ok"):
            result = {**(reply.get("data") or {}), "ok": True}
            await _accept(session, row, attempts, handoff, result)
            return "accepted"
        phase = "uncertain" if reply.get("uncertain") else "rejected"
        if phase == "rejected":
            await asyncio.to_thread(ai_remote._drop_packet, runner, packet)
        await _save(session, row, attempts, phase, reply)
        return phase


async def attempt(row_id):
    from .cloud_recovery import _leased
    return await _leased("cloud-message", row_id, lambda: deliver(row_id))


async def recover(limit=30):
    async with SessionLocal() as session:
        ids = list(await session.scalars(select(Receipt.id).where(
            Receipt.phase.in_(PENDING), Receipt.retry_after <= now(),
        ).order_by(Receipt.retry_after, Receipt.created_at, Receipt.id).limit(limit)))
    for row_id in ids:
        try:
            await attempt(row_id)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            log.warning("Cloud message recovery %s: %s", row_id, type(error).__name__)
    return len(ids)


async def tick_loop():
    while True:
        if os.environ.get("CLOUD_RECOVERY_ENABLED", "true").lower() not in {"0", "false", "off"}:
            try:
                await recover()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                log.warning("Cloud message recovery unavailable: %s", type(error).__name__)
        await asyncio.sleep(10)
