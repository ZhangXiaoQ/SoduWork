"""Archive verified cloud output into the same cross-device delivery library.

The task and execution session remain authoritative. The library object is an
immutable delivery snapshot, never a second task or execution queue.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace

from fastapi import HTTPException
from sqlalchemy import func, literal, select, update

from ..automation_models import ExecutionSession
from ..conversation_handoff_models import ConversationHandoff
from ..models import Attachment, Task
from . import delivery_bundle, delivery_collections as collections, delivery_manifest, task_requirements


async def _context(session, task_id):
    task = await session.get(Task, task_id)
    handoff = await session.scalar(select(ConversationHandoff).where(ConversationHandoff.task_id == task_id))
    if task is None:
        raise HTTPException(404, "找不到这条执行会话")
    if handoff is None:
        # Requirements already own their execution and attachments. Reuse the
        # same verified collection pipeline without inventing a cloud handoff.
        if task.kind not in task_requirements.KINDS or not task.owner_user_id:
            raise HTTPException(404, "找不到这条执行会话")
        handoff = SimpleNamespace(owner_user_id=task.owner_user_id,
            source={"sessionId": "requirement-" + task.id, "entryKind": "requirement"})
    elif (handoff.source or {}).get("entryKind") != "cloud":
        raise HTTPException(404, "找不到这条执行会话")
    execution = await session.scalar(select(ExecutionSession).where(ExecutionSession.task_id == task_id)
        .order_by(ExecutionSession.started_at.desc().nullslast(), ExecutionSession.created_at.desc()).limit(1))
    return task, handoff, execution


async def _authorized(session, client, task_id):
    context = await _context(session, task_id)
    if not client.user_ref or client.user_ref != context[1].owner_user_id:
        raise HTTPException(404, "找不到这条执行会话")
    return context


async def _mark(session, execution, state, *, delivery_id="", error="", revision="", round_no=None):
    meta = dict(execution.metadata_ or {})
    round_no = round_no or int(meta.get("round") or 1)
    mark = {"state": state, "deliveryId": delivery_id, "error": error,
        "revision": revision, "round": round_no, "executionRef": execution.ref,
        "updatedAt": datetime.now(timezone.utc).isoformat()}
    # Patch only this derived field. A new message can advance the execution
    # while object storage is slow; never restore its old round/status/cursor.
    value = json.dumps(mark, ensure_ascii=False)
    if session.bind.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import JSONB, array
        replacement = func.jsonb_set(ExecutionSession.metadata_.cast(JSONB),
                                    array(["deliverySync"]), literal(value).cast(JSONB))
    else:
        replacement = func.json_set(ExecutionSession.metadata_, "$.deliverySync", func.json(value))
    result = await session.execute(update(ExecutionSession).where(
        ExecutionSession.id == execution.id,
        func.coalesce(ExecutionSession.metadata_["round"].as_integer(), 1) == round_no
    ).values(metadata_=replacement).execution_options(synchronize_session=False))
    if result.rowcount:
        from .cloud_sync_notifications import mark as mark_cloud_sync
        mark_cloud_sync(session, execution.task_id)
    await session.commit()
    await session.refresh(execution)
    return mark if result.rowcount else {"state": "pending"}


def _current_mark(execution):
    meta = dict(execution.metadata_ or {})
    mark = dict(meta.get("deliverySync") or {})
    if mark.get("round") != int(meta.get("round") or 1):
        return {}
    return mark


def _response(mark, delivery=None, *, artifact_url="", execution=None):
    state = mark.get("state") or "pending"
    meta = (execution.metadata_ or {}) if execution is not None else {}
    # A commit/refresh can observe a newer turn after the mark was persisted.
    # Keep the receipt bound to its mark instead of relabeling it with that turn.
    return {"ok": True, "state": state, "delivery": delivery,
            "executionRef": mark.get("executionRef") or (execution.ref if execution is not None else ""),
            "round": int(mark.get("round") or meta.get("round") or (1 if execution is not None else 0)),
            "artifactUrl": str(artifact_url or "")[:600],
            "error": mark.get("error") or "", "retryable": state in {"pending", "failed"}}


async def status(session, client, task_id):
    task, handoff, execution = await _authorized(session, client, task_id)
    artifact_url = getattr(task, "artifact_url", "") or ""
    if execution is None:
        return _response({"state": "pending"}, artifact_url=artifact_url, execution=execution)
    mark = _current_mark(execution)
    if execution.state not in {"done", "failed", "cancelled", "canceled", "error", "stopped"}:
        return _response({"state": "running"}, artifact_url=artifact_url, execution=execution)
    if execution.state != "done":
        return _response({"state": "incomplete", "error": "本轮未完成，已保留的过程文件不作为最终成果同步"}, artifact_url=artifact_url, execution=execution)
    delivery = None
    if mark.get("deliveryId"):
        try:
            row = await collections.get(session, handoff.owner_user_id, mark["deliveryId"])
            delivery = collections.public(row)
        except HTTPException:
            mark = {"state": "removed", "error": "成果已从资料库删除，可在回收站恢复"}
    return _response(mark, delivery, artifact_url=artifact_url, execution=execution)


async def _collect(session, task, handoff, execution):
    settlement = dict((execution.metadata_ or {}).get("terminalSettlement") or {})
    if (settlement.get("round") == int((execution.metadata_ or {}).get("round") or 1)
            and (settlement.get("missing") or settlement.get("state") == "incomplete")):
        raise HTTPException(409, "本轮仍有成果文件未收齐，不能保存不完整成果")
    rows = list((await session.scalars(select(Attachment).where(
        Attachment.task_id == task.id, Attachment.source_ref == execution.ref)
        .order_by(Attachment.created_at, Attachment.id))).all())
    manifest = delivery_manifest.build(rows, source_ref=execution.ref)
    current = list(manifest.get("primary") or []) + list(manifest.get("supporting") or [])
    if not current:
        return None, None
    if manifest.get("problems"):
        raise HTTPException(422, "成果尚未通过完整性校验，暂时不能同步")
    latest_round = max((int((row.evidence_meta or {}).get("round") or 0) for row in rows), default=0)
    current_round = int((execution.metadata_ or {}).get("round") or 1)
    if latest_round and latest_round != current_round:
        raise HTTPException(409, "本轮成果尚未收集完成，请稍后重试")
    by_id = {row.id: row for row in rows}
    chosen = [by_id[item["id"]] for item in current]
    payload = await delivery_bundle.collect(chosen,
        primary_ids=[item["id"] for item in manifest.get("primary", [])])
    files, raw, kind = payload["files"], payload["bytes"], payload["kind"]
    primary = next((item for item in files if item["role"] == "primary"), files[0])
    context = (task.work_routing or {}).get("executionContext") or {}
    local = handoff.source.get("entryKind") == "requirement" and bool((context.get("runner") or {}).get("clientId"))
    manifest = {"schemaVersion": 1, "source": "local" if local else "cloud", "sessionId": handoff.source["sessionId"],
        "revision": "pending", "title": collections.display_title(task.title), "entryPath": primary["path"],
        "kind": kind, "files": files,
        "externalDependencies": payload["externalDependencies"]}
    manifest = collections.clean_manifest(manifest)
    manifest["revision"] = collections.content_digest(manifest)
    return manifest, raw


async def archive_task(session, task_id, *, propagate=False):
    """Save on user request; failure never turns task success into failure."""
    task, handoff, execution = await _context(session, task_id)
    artifact_url = getattr(task, "artifact_url", "") or ""
    if execution is None or execution.state not in {"done", "failed", "cancelled", "canceled", "error", "stopped"}:
        return _response({"state": "running"}, artifact_url=artifact_url, execution=execution)
    if execution.state != "done":
        return _response({"state": "incomplete", "error": "本轮未完成，已保留的过程文件不作为最终成果同步"}, artifact_url=artifact_url, execution=execution)
    settlement = dict((execution.metadata_ or {}).get("terminalSettlement") or {})
    if (settlement.get("round") != int((execution.metadata_ or {}).get("round") or 1)
            or settlement.get("state") not in {"done", "done_no_output", "incomplete"}):
        return _response({"state": "pending", "error": "正在收集本轮的完整成果"}, artifact_url=artifact_url, execution=execution)
    old = _current_mark(execution)
    if old.get("state") == "synced" and old.get("deliveryId"):
        try:
            row = await collections.get(session, handoff.owner_user_id, old["deliveryId"])
            return _response(old, collections.public(row), artifact_url=artifact_url, execution=execution)
        except HTTPException:
            return _response({"state": "removed", "error": "成果已从资料库删除，可在回收站恢复"}, artifact_url=artifact_url, execution=execution)
    execution_id = execution.id
    round_no = int((execution.metadata_ or {}).get("round") or 1)
    try:
        manifest, data = await _collect(session, task, handoff, execution)
        if manifest is None:
            mark = await _mark(session, execution, "empty", round_no=round_no)
            return _response(mark, artifact_url=artifact_url, execution=execution)
        row, _ = await collections.persist(session, handoff.owner_user_id, manifest, data)
        mark = await _mark(session, execution, "synced", delivery_id=row.id,
                           revision=manifest["revision"], round_no=round_no)
        return _response(mark, collections.public(row) if mark.get("state") == "synced" else None,
                         artifact_url=artifact_url, execution=execution)
    except Exception as exc:
        await session.rollback()
        execution = await session.get(ExecutionSession, execution_id, populate_existing=True)
        reason = str(exc.detail) if isinstance(exc, HTTPException) and isinstance(exc.detail, str) else "成果同步失败，请稍后重试"
        mark = await _mark(session, execution, "failed", error=reason[:240], round_no=round_no)
        if propagate:
            raise
        return _response(mark, artifact_url=artifact_url, execution=execution)


async def retry(session, client, task_id):
    _task, _handoff, execution = await _authorized(session, client, task_id)
    from . import artifact_version_guard
    await artifact_version_guard.reconcile_identical_pending(session, task_id)
    await session.commit()
    # A Hub restart can leave a completed Runner row with its durable
    # attachments intact but without the derived terminalSettlement marker.
    # Reconcile that marker before applying the user-requested retry; otherwise
    # Every retry would otherwise remain stuck waiting for the complete output set.
    # Only a successful terminal execution can have a missing settlement
    # marker that is recoverable from persisted attachments.  Failed/cancelled
    # executions must keep the normal incomplete/retry semantics; attempting
    # to reconcile them would also require a task-event row that may not exist
    # for older executions.
    if execution is not None and execution.state == "done":
        current = _current_mark(execution)
        settlement = dict((execution.metadata_ or {}).get("terminalSettlement") or {})
        round_no = int((execution.metadata_ or {}).get("round") or 1)
        has_current_settlement = settlement.get("round") == round_no and bool(settlement.get("state"))
        if not current.get("state") and not has_current_settlement:
            from . import execution_settlement
            try:
                await execution_settlement.settle_terminal(
                    session, task_id, execution.ref, include_task=False)
            except Exception:  # noqa: BLE001 - retry must remain idempotent
                # Legacy isolated executions may not have dispatch-event rows.
                # Keep the normal pending response instead of failing the retry.
                await session.rollback()
    return await archive_task(session, task_id)
