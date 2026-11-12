"""Authorize each remote turn and enter the existing dispatch/message receipt paths."""
from fastapi import HTTPException
from sqlalchemy import select

from .. import automation_models as am
from . import ai_exec, im_connections as connections, runner_hub, task_status


async def execution(session, task_id):
    event = await ai_exec.last_dispatch_event(session, task_id)
    if event is None:
        return None
    ref = str((event.detail or {}).get("ref") or (event.detail or {}).get("issueId") or "")
    return (await session.scalars(select(am.ExecutionSession).where(
        am.ExecutionSession.task_id == task_id, am.ExecutionSession.ref == ref))).first()


async def preflight(session, connection, binding):
    client, task, runner = await connections.target(session, connection, binding.task_id, binding.runner_id, quota=True)
    if task.status == "cancel" or task.archived_at:
        raise HTTPException(409, "任务已关闭，请在 SoduWork 恢复后重新发送")
    if await task_status.engine_owns(session, [task.id]):
        raise HTTPException(409, "工作流正在接管此任务，请在原会话处理")
    approval = await session.scalar(select(am.ApprovalRequest.id).where(
        am.ApprovalRequest.task_id == task.id, am.ApprovalRequest.status == "pending").limit(1))
    if approval:
        raise HTTPException(409, "任务等待审批，请先在 SoduWork 完成审批")
    row = await execution(session, task.id)
    if row and row.runner_id != binding.runner_id:
        raise HTTPException(409, "会话执行机已变更，请重新绑定")
    live = runner_hub.get(binding.runner_id)
    if not live or runner.dispatch_mode != "accepting" or runner.management_state:
        return client, row, "执行机离线或暂停接单，正在等待恢复"
    if row and row.state in {"queued", "dispatching", "running"}:
        return client, row, "原会话正在执行，等待当前轮次结束"
    if row is None:
        if await ai_exec.last_dispatch_event(session, task.id):
            return client, row, "等待执行机同步现有会话，未重复启动任务"
        from . import managed_work_route
        if managed_work_route.is_managed(task):
            raise HTTPException(409, "工程任务请先在 SoduWork 按审批流程启动")
        if not binding.options.get("allowStart"):
            raise HTTPException(409, "尚未授权远程启动此任务")
        from . import im_targets
        await im_targets.validate_start(session, client, task, runner, binding.options)
    return client, row, ""


async def submit(session, client, binding, inbox):
    if inbox.ref:
        # This route retains task access, cloud-selection checks and durable message receipts.
        from ..api.tasks import ai_say_task
        return await ai_say_task(binding.task_id, {"text": inbox.text, "messageId": "im-" + inbox.id}, client, session)
    from ..models import Task
    from . import managed_work_route
    task = await session.get(Task, binding.task_id, with_for_update=True, populate_existing=True)
    if task is None or managed_work_route.is_managed(task):
        raise HTTPException(409, "任务流程已变更，请在 SoduWork 检查后重新绑定")
    from .task_dispatch import dispatch
    return await dispatch(binding.task_id, {"brief": inbox.text,
        "assigneeId": "runner:" + binding.runner_id + ":" + binding.options["agentId"],
        "assigneeType": "agent", "model": binding.options.get("model", ""),
        "executionContext": {"strategy": "direct"}}, client, session)


async def final_text(session, row, inbox, binding=None):
    from . import execution_sessions
    if not inbox.admission_key:
        raise HTTPException(409, "执行机缺少消息关联回执，请升级执行机并核对原会话")
    matching = am.ExecutionEvent.detail["admissionKey"].as_string() == inbox.admission_key
    terminal = (await session.scalars(select(am.ExecutionEvent).where(
        am.ExecutionEvent.session_id == row.id, matching, am.ExecutionEvent.kind == "turn-end")
        .order_by(am.ExecutionEvent.seq.desc()).limit(1))).first()
    if terminal is None:
        if binding is not None:
            from . import im_archive
            await im_archive.recover_terminal(session, row, inbox, binding)
        return None
    terminal_state = (terminal.detail or {}).get("turnState")
    if not execution_sessions.is_terminal(terminal_state):
        return None
    start = (terminal.detail or {}).get("admissionStartSeq")
    if type(start) is not int or not 0 <= start < terminal.seq:
        raise HTTPException(409, "执行机缺少完整轮次边界，请升级执行机并核对原会话")
    from . import im_archive
    missing = await im_archive.first_missing(session, row, start, terminal.seq)
    if missing is not None and (binding is None or not await im_archive.repair(
            session, row, inbox, binding, start, terminal.seq, missing)):
        return None
    events = list((await session.scalars(select(am.ExecutionEvent).where(
        am.ExecutionEvent.session_id == row.id, matching, am.ExecutionEvent.seq > start,
        am.ExecutionEvent.seq <= terminal.seq,
        am.ExecutionEvent.kind == "say").order_by(am.ExecutionEvent.seq.desc()).limit(401))).all())
    truncated = len(events) > 400
    events = events[:400]
    from . import endpoint_events
    events = await endpoint_events.hydrate(events, session=session)
    parts, streams = [], {}
    for event in reversed(events):
        detail = event.detail or {}
        text = event.text or ""
        stream = detail.get("streamId")
        truncated = truncated or detail.get("textTruncated") is True
        if stream:
            if stream not in streams:
                streams[stream] = len(parts)
                parts.append("")
            position = streams[stream]
            parts[position] = parts[position] + text if detail.get("delta") else text
        elif detail.get("full") or text:
            parts.append(str(detail.get("full") or text))
    answer = "\n\n".join(part for part in parts if part).strip()
    if len(answer) > 13700:
        truncated = True
        answer = answer[-13700:]
    if truncated and answer:
        answer = "本轮输出较长，以下仅为部分内容；完整结果请在原会话查看。\n\n" + answer
    if terminal_state != "done":
        return "本轮执行未正常完成，请在 SoduWork 原会话查看原因。" + ("\n\n" + answer if answer else "")
    if not answer:
        return "本轮已结束，未收到可回传的文字结果。请在 SoduWork 原会话查看执行记录与成果。"
    return answer


async def diagnose(binding, inbox):
    """Read the existing admission ledger when an accepted turn never created a run."""
    import asyncio
    live = runner_hub.get(binding.runner_id)
    if not live:
        return "offline"
    try:
        if hasattr(inbox, "_im_archive_probe"):
            result = inbox._im_archive_probe or {}
        else:
            async with asyncio.timeout(20):
                result = await live.call("job.session", {"ref": inbox.ref, "since": 0, "limit": 32}, timeout=15)
        data = result.get("data") or {}
        if result.get("ok") and isinstance(data, dict) and data.get("admissionKey") == inbox.admission_key:
            state = data.get("state") or data.get("status")
            if state in {"failed", "cancelled", "canceled", "stopped", "interrupted"}:
                return "failed"
            if data.get("queued"):
                return "queued"
    except (Exception, TimeoutError):
        pass
    return "pending"
