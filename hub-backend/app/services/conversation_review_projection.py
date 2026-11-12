"""Name review conversations from immutable receipts, without changing history."""
from sqlalchemy import select

from .. import models, automation_models as am
from ..conversation_handoff_models import ConversationHandoff


async def decorate_many(session, tasks, apis):
    pairs = {task.id: (task, api) for task, api in zip(tasks, apis)
             if task.origin == "cloud-conversation"}
    if not pairs:
        return
    rows = (await session.scalars(select(ConversationHandoff).where(
        ConversationHandoff.task_id.in_(pairs)))).all()
    bindings = [(row, (row.options or {}).get("acceptance")) for row in rows]
    bindings = [(row, binding) for row, binding in bindings if isinstance(binding, dict)]
    if not bindings:
        return
    sources = {task.id: task for task in (await session.scalars(select(models.Task).where(
        models.Task.id.in_([b.get("taskId") for _, b in bindings])))).all()}
    versions = {v.id: v for v in (await session.scalars(select(am.ArtifactVersion).where(
        am.ArtifactVersion.id.in_([b.get("artifactVersionId") for _, b in bindings])))).all()}
    for row, binding in bindings:
        task, api = pairs[row.task_id]
        source = sources.get(binding.get("taskId"))
        version = versions.get(binding.get("artifactVersionId"))
        if (not source or not version or version.task_id != source.id or
                row.owner_user_id != task.owner_user_id):
            continue
        api["conversationReview"] = {**binding, "mode": "auto", "artifactSeq": version.seq}
        api["title"] = f"自动验收 · {source.title} · 第{version.seq}版"
