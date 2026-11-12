"""Public requirement stages derived from current review facts in one SQL query.

This is a read model, never a second status machine or an approval permission.
Only the latest delivery version's latest review can place work in review.
"""
from datetime import datetime, timezone

from sqlalchemy import and_, func, or_, select

from .. import automation_models as am, models


async def _legacy_rework_contexts(session, pairs, rejected_rows):
    """Recover only provable native feedback for old reviews that stored no pending card.

    The immutable reviewed files establish provenance. Later work or a deliberate pool
    return settles that review; this projection never updates the task or review history.
    """
    from . import ai_exec, delivery_manifest

    eligible = {}
    for task, api in pairs:
        row = rejected_rows.get(task.id)
        if not row or (api.get("workRouting") or {}).get("reworkPending"):
            continue
        ref = delivery_manifest.unique_output_source(row["manifest"])
        if not ref.startswith("conversation:") or not ref.removeprefix("conversation:"):
            continue
        if row["source_ref"] and row["source_ref"] != ref:
            continue
        eligible[row["request_id"]] = {"task_id": task.id, "ref": ref,
            "versionId": row["artifact_id"]}
    if not eligible:
        return {}

    decisions = (await session.scalars(select(am.ApprovalDecision).where(
        am.ApprovalDecision.request_id.in_(eligible), am.ApprovalDecision.decision == "reject",
    ).order_by(am.ApprovalDecision.created_at.desc(), am.ApprovalDecision.id.desc()))).all()
    contexts, anchors = {}, []
    for decision in decisions:
        proof = eligible[decision.request_id]
        task_id = proof["task_id"]
        if task_id in contexts or not (decision.note or "").strip():
            continue
        contexts[task_id] = {"ref": proof["ref"], "versionId": proof["versionId"],
            "requestId": decision.request_id, "feedback": decision.note[:1000],
            "actor": decision.user_id or "", "state": "failed",
            "error": "原执行保存在客户端会话，请按验收意见继续修正。"}
        anchors.append(and_(models.TaskEvent.task_id == task_id,
                            models.TaskEvent.at >= decision.created_at))
    if not anchors:
        return {}
    # Do not count task.execution_started: rejection itself may reopen a done task.
    # A failed automatic retry or an old turn's late completion leaves human
    # rework outstanding. Only new execution or an explicit pool return settles it.
    settled_kinds = ("ai.rework", "ai.rework_taken", "review.returned_to_backlog",
                     *ai_exec.KINDS_DISPATCHED, "conversation.turn")
    events = (await session.scalars(select(models.TaskEvent).where(
        models.TaskEvent.kind.in_(settled_kinds), or_(*anchors),
    ))).all()
    settled = {event.task_id for event in events if event.kind != "conversation.turn"
               or (event.detail or {}).get("state") == "queued"}
    return {task_id: context for task_id, context in contexts.items() if task_id not in settled}


async def decorate_many(session, tasks, apis):
    from .task_requirements import stage
    from . import requirement_edit_policy, task_maintenance

    pairs = list(zip(tasks, apis))
    if not pairs:
        return apis
    from . import conversation_review_projection
    await conversation_review_projection.decorate_many(session, tasks, apis)
    await task_maintenance.decorate_many(session, tasks, apis)
    await requirement_edit_policy.decorate_many(session, tasks, apis)
    candidates = [task.id for task, _ in pairs if stage(task) not in {"closed", "delivered"}]
    reviewing, rejected = set(), set()
    timestamps, rejected_rows = {}, {}
    if candidates:
        artifact = am.ArtifactVersion
        request = am.ApprovalRequest
        versions = select(
            artifact.id.label("id"), artifact.task_id.label("task_id"), artifact.state.label("state"),
            artifact.source_ref.label("source_ref"), artifact.manifest.label("manifest"),
            func.row_number().over(partition_by=artifact.task_id,
                order_by=(artifact.seq.desc(), artifact.created_at.desc(), artifact.id.desc())).label("position"),
        ).where(artifact.task_id.in_(candidates), artifact.kind != "requirement").subquery()
        reviews = select(
            request.task_id.label("task_id"), request.artifact_version_id.label("artifact_id"),
            request.status.label("status"), request.expires_at.label("expires_at"),
            request.id.label("request_id"),
            func.row_number().over(partition_by=(request.task_id, request.artifact_version_id),
                order_by=(request.created_at.desc(), request.id.desc())).label("position"),
        ).where(request.task_id.in_(candidates), request.action == "review").subquery()
        latest = select(
            reviews.c.task_id.label("task_id"), reviews.c.status.label("status"),
            reviews.c.expires_at.label("expires_at"),
            versions.c.state.label("artifact_state"),
            versions.c.id.label("artifact_id"), versions.c.source_ref, versions.c.manifest,
            reviews.c.request_id,
        ).join(versions, and_(versions.c.id == reviews.c.artifact_id,
                             versions.c.task_id == reviews.c.task_id)).where(
            reviews.c.position == 1, versions.c.position == 1,
        ).subquery()
        pending = select(latest.c.task_id).where(
            latest.c.status == "pending",
            latest.c.artifact_state.not_in({"rejected", "superseded"}),
            or_(latest.c.expires_at.is_(None), latest.c.expires_at > datetime.now(timezone.utc)),
        ).subquery()
        rejected_now = select(latest).where(
            latest.c.status == "rejected", latest.c.artifact_state != "superseded").subquery()
        query = select(models.Task.id, models.Task.updated_at,
                       pending.c.task_id.label("reviewing"),
                       rejected_now.c.task_id.label("rejected"), rejected_now.c.artifact_id,
                       rejected_now.c.source_ref, rejected_now.c.manifest,
                       rejected_now.c.request_id).outerjoin(
            pending, pending.c.task_id == models.Task.id,
        ).outerjoin(
            rejected_now, rejected_now.c.task_id == models.Task.id,
        ).where(models.Task.id.in_([task.id for task, _ in pairs]))
    else:
        query = select(models.Task.id, models.Task.updated_at).where(
            models.Task.id.in_([task.id for task, _ in pairs]))
    for row in (await session.execute(query)).mappings():
        timestamps[row["id"]] = row["updated_at"]
        if row.get("reviewing"):
            reviewing.add(row["id"])
        if row.get("rejected"):
            rejected.add(row["id"])
            rejected_rows[row["id"]] = row
    rework_contexts = await _legacy_rework_contexts(session, pairs, rejected_rows)
    from ..schemas import _ms
    for task, api in pairs:
        api["requirementStage"] = "reviewing" if task.id in reviewing else stage(task)
        if task.id in rejected and task.id not in reviewing:
            # Show rejected acceptance when the latest request was rejected and no newer pending request exists.
            api["reviewRejected"] = True
        if task.id in rework_contexts:
            api["workRouting"] = {**(api.get("workRouting") or {}),
                                  "reworkPending": rework_contexts[task.id]}
        if task.id in timestamps:
            api["updatedAt"] = _ms(timestamps[task.id])
    return apis
