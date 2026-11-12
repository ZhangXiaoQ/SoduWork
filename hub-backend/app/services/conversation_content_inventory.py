"""Metadata-only inventory for resumable transcript migration."""
from fastapi import HTTPException
from sqlalchemy import select, func, or_, cast, String

from ..account_conversation_models import AccountConversation, AccountConversationMessage, PersonalConversationRelay
from ..conversation_handoff_models import ConversationHandoff, ConversationMessageReceipt
from ..automation_models import ExecutionSession, ExecutionEvent
from ..models import Task, TaskEvent, Attachment, User, AiScheduleRun

KINDS = ("account", "handoff", "message", "relay", "execution", "schedule")


def query(kind, owner=None):
    if kind == "account":
        model = AccountConversation
        body = select(AccountConversationMessage.id).where(AccountConversationMessage.conversation_id == model.id,
                                                          AccountConversationMessage.text != "").exists()
        statement, account = select(model.id).where(body), model.owner_user_id
    elif kind == "handoff":
        model = ConversationHandoff
        note = select(Task.id).where(Task.id == model.task_id, Task.origin.in_(["cloud-conversation", "conversation-handoff"]), Task.note != "").exists()
        brief = select(TaskEvent.id).where(TaskEvent.task_id == model.task_id,
            TaskEvent.detail["carried"]["brief"].as_string() != "").exists()
        material = [model.options[key].as_string().is_not(None) for key in ("instruction", "userText", "inputPreparation", "sourceGoal", "legacyBlob")]
        statement = select(model.id).where(or_(*material, model.source["goal"].as_string() != "", model.storage_key != "", note, brief))
        account = model.owner_user_id
    elif kind == "message":
        model = ConversationMessageReceipt
        statement = select(model.id).outerjoin(ConversationHandoff, ConversationHandoff.task_id == model.task_id).where(
            model.payload.is_not(None), func.trim(cast(model.payload, String)).not_in(["null", "{}"]),
            model.payload["contentRef"].as_string().is_(None))
        account = ConversationHandoff.owner_user_id
    elif kind == "relay":
        model = PersonalConversationRelay
        statement, account = select(model.id).where(model.instruction != ""), model.owner_user_id
    elif kind == "execution":
        model = ExecutionSession
        body = select(ExecutionEvent.id).where(ExecutionEvent.session_id == model.id,
            ExecutionEvent.detail["contentRef"].as_string().is_(None)).exists()
        statement = select(model.id).outerjoin(Task, Task.id == model.task_id).where(body)
        account = Task.owner_user_id
    elif kind == "schedule":
        model = AiScheduleRun
        statement = select(model.id).where(model.receipt["conversationInput"]["text"].as_string().is_not(None))
        account = model.owner_user_id
    else:
        raise HTTPException(422, "迁移类别无效")
    return model, statement.where(account == owner) if owner is not None else statement


async def counts(session, owner=None):
    result = {}
    for kind in KINDS:
        _, statement = query(kind, owner)
        result[kind] = await session.scalar(select(func.count()).select_from(statement.subquery()))
    return result


async def audit(session):
    """Count every remaining body, including records an account cannot list.

    Missing ownership never authorizes assigning legacy content to the current
    operator. These blockers keep the completion gate closed until provenance
    is repaired through the existing administrative ownership process.
    """
    pending = await counts(session)
    missing_parent = ~select(AccountConversation.id).where(
        AccountConversation.id == AccountConversationMessage.conversation_id).exists()
    missing_handoff = ~select(ConversationHandoff.id).where(ConversationHandoff.task_id == Task.id).exists()
    missing_attachment = ~select(ConversationHandoff.id).where(ConversationHandoff.task_id == Attachment.task_id).exists()
    statements = {
        "orphanMessages": select(AccountConversationMessage.id).where(missing_parent, AccountConversationMessage.text != ""),
        "orphanConversationNotes": select(Task.id).where(missing_handoff,
            Task.origin.in_(["cloud-conversation", "conversation-handoff"]), Task.note != ""),
        "orphanHandoffArchives": select(Attachment.id).where(missing_attachment,
            Attachment.role == "handoff", Attachment.storage_key != ""),
        "orphanExecutionEvents": select(ExecutionEvent.id).where(
            ~select(ExecutionSession.id).where(ExecutionSession.id == ExecutionEvent.session_id).exists(),
            ExecutionEvent.detail["contentRef"].as_string().is_(None)),
        "orphanConversationBriefs": select(TaskEvent.id).join(Task, Task.id == TaskEvent.task_id).where(
            missing_handoff, Task.origin.in_(["cloud-conversation", "conversation-handoff"]),
            TaskEvent.detail["carried"]["brief"].as_string() != ""),
    }
    blocked = {}
    for kind in KINDS:
        model, remaining = query(kind)
        if kind in {"account", "handoff", "relay", "schedule"}:
            account = model.owner_user_id
        elif kind == "message":
            account = ConversationHandoff.owner_user_id
        else:
            account = Task.owner_user_id
        statements[kind + "Unowned"] = remaining.where(or_(account.is_(None), account == "",
            account.not_in(select(User.id))))
    for name, statement in statements.items():
        blocked[name] = await session.scalar(select(func.count()).select_from(statement.subquery()))
    return {"pending": pending, "blocked": blocked,
            "complete": not any(pending.values()) and not any(blocked.values())}
