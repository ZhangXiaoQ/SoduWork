"""Device-native automation: immutable run envelope and ordinary conversation.

Every automation occurrence is represented by its conversation and run receipt;
it never creates a Task or requirement record.
"""
from datetime import datetime, timezone
from sqlalchemy import select
from fastapi import HTTPException
from .. import models
from ..agent_catalog import AGENTS
from . import schedule_access
from .schedule_execution import required_skill_names
from .schedule_run_contracts import (
    automation_conversation_title,
    clean_required_capabilities,
    personal_plugin_spec,
)

PROTOCOL = 'soduwork.automation-conversation/v1'
RESERVATION_LEASE_SECONDS = 300
# Keep the Hub's ordinary-conversation contract in lockstep with the reviewed
# Agent catalog used by the client and Runner.  The editor persists a portable
# ``local:<agent>`` kind, while the desktop opens the matching runtime id.  A
# hand-maintained allowlist here silently made newly catalogued bases (Qwen,
# DSH, Harness²) look selectable but impossible to dispatch.
ADAPTERS = {
    key: key for key, spec in AGENTS.items()
    if spec.get('transport') in {'direct', 'runner'}
}


def _adapter_id(cli: str) -> str:
    """Resolve a selected Agent against the live catalog, including custom ACP Agents."""
    key = str(cli or '').strip().lower()
    spec = AGENTS.get(key)
    if spec and spec.get('transport') in {'direct', 'runner'}:
        return key
    # Keep the exported mapping useful for callers that inspect the built-in
    # contract, while custom Agent registrations remain visible immediately.
    return ADAPTERS.get(key, '')


def adapter_for(schedule, client):
    # Every automation is a normal conversation. The capability flag is
    # negotiated by ``inbox`` and must never route a schedule to a Task or
    # workflow fallback.
    aid = str(schedule.assignee_id or '')
    if aid.startswith('runner:'):
        from . import runner_hub
        parts = aid.split(':', 2)
        if len(parts) != 3:
            return ''
        _, runner_id, cli = parts
        runner = runner_hub.get(runner_id)
        owner = str(getattr(client, "user_ref", "") or "")
        if (runner is None or
                (runner.client_id != client.id and
                 (not owner or str(getattr(runner, "owner_user_id", "") or "") != owner))):
            return ''
    elif aid.startswith('local:'):
        cli = aid.split(':', 1)[1]
    else:
        return ''
    return _adapter_id(cli)


def reserve_run(run, instance: str) -> bool:
    """Reserve a freshly-created manual run for the UI device before dispatch.

    The desktop automation worker polls the same inbox every 250ms.  Without a
    reservation it can claim the row between ``execute_one`` and the UI's
    follow-up ``claim`` request, leaving the immediate button without the
    immutable conversation envelope.  The reservation is written in the same
    transaction as the run, so the worker sees a busy lease only after the
    complete envelope is durable.
    """
    instance = str(instance or '').strip()
    if not instance or len(instance) > 80:
        raise ValueError('缺少有效的执行端标识')
    receipt = dict(run.receipt or {})
    now = datetime.now(timezone.utc).timestamp()
    owner = str(receipt.get('worker') or '')
    lease_until = float(receipt.get('leaseUntil') or 0)
    if owner and owner != instance and lease_until > now:
        return False
    receipt.update(worker=instance, leaseUntil=now + RESERVATION_LEASE_SECONDS)
    run.receipt = receipt
    return True


async def prepare(session, schedule, client, repo, run_id, adapter, personal):
    from . import schedules, workdirs
    # This function is also called by focused workers and older clients that
    # bypass schedules.run_one(). Keep the protocol boundary self-contained:
    # every automation is a prompt, selected base, selected model, and optional
    # device-local personal plugin.
    from .schedule_execution import normalize_conversation_schedule
    normalize_conversation_schedule(schedule)
    run = await session.get(models.AiScheduleRun, run_id)
    if run is None:
        raise ValueError('自动化运行记录尚未建立')
    existing = dict(run.receipt or {})
    conversation_title = str(existing.get('conversationTitle') or
                              automation_conversation_title(schedule, run.started_at))
    if existing.get('executionMode') == PROTOCOL:
        return {'ok': True, 'executionMode': PROTOCOL, 'conversationId': existing.get('conversationId', ''),
                'conversationTitle': conversation_title, 'waitingForDevice': True}
    cwd = ''
    if repo:
        cwd, _ = workdirs.auto_dir(client, repo)
        if not cwd:
            raise ValueError('工程尚未配置工作目录，请先选择本机已有的工程文件夹')
    title = str(schedule.title or '自动化')
    instruction = title + '\n\n' + str(schedule.note or '')
    inputs = dict(schedule.plugin_inputs or {})
    if inputs:
        import json
        instruction += '\n\n本次输入参数：\n' + json.dumps(inputs, ensure_ascii=False, indent=2)
    if repo:
        instruction += '\n\n工程：' + str(repo.name or '')
    instruction += '\n\n自动化触发时间：' + schedules.format_trigger_time(schedule, run.started_at)
    from .schedule_instruction import for_run
    instruction = for_run(instruction)
    capabilities = clean_required_capabilities(schedule.required_capabilities)
    # Older focused workers call this helper with an empty ``personal`` value
    # instead of going through schedules.run_one(). Derive the persisted lock
    # here as well so that bypassing the scheduler cannot silently drop the
    # selected personal plugin before the desktop opens the chat.
    personal_spec = dict(personal or {}) or personal_plugin_spec(schedule)
    envelope = {'runId': run.id, 'title': title, 'conversationTitle': conversation_title,
                'text': instruction, 'attachments': [],
                'adapterId': adapter, 'cwd': cwd,
                'capabilities': capabilities, 'skills': required_skill_names(capabilities),
                # An explicit schedule selection is part of the execution
                # contract. Empty means the selected runtime resolves its own
                # normal default; do not silently reuse a model attached to
                # the Agent or to the ordinary chat composer.
                'modelName': str(getattr(schedule, 'model_name', '') or ''),
                'personalPlugin': personal_spec}
    if repo:
        # Keep project context as conversation metadata. It scopes plugin
        # resolution and workspace history without creating a task or
        # requirement record.
        envelope['repoId'] = str(getattr(repo, 'id', '') or '')
        envelope['projectId'] = str(getattr(repo, 'project_id', '') or '')
    from . import schedule_content
    envelope = await schedule_content.save(session, client, run, envelope)
    run.receipt = {**existing, 'executionMode': PROTOCOL, 'conversationTitle': conversation_title,
                   'conversationInput': envelope, 'phase': 'device'}
    await session.flush()
    return {'ok': True, 'executionMode': PROTOCOL, 'conversationTitle': conversation_title, 'waitingForDevice': True}


async def inbox(session, client):
    from .auth_principals import DevicePrincipal
    # Capability registration is authenticated and confined to this device.
    changed = False
    if not isinstance(client, DevicePrincipal) or not client.automation_conversation_v1:
        if isinstance(client, DevicePrincipal):
            from .device_auth import _load_verified_client
            record = await _load_verified_client(session, client)
        else:
            record = client
        if record is None:
            raise HTTPException(401, '设备授权已变更，请重新连接')
        config = dict(record.config or {})
        if config.get('automationConversationV1') != 1:
            record.config = {**config, 'automationConversationV1': 1}
            changed = True
    query = select(models.AiScheduleRun.id, models.AiScheduleRun.state).where(
        schedule_access.owner_clause(client, models.AiScheduleRun),
        # Account scope permits managing the plan from another device, while
        # the ordinary conversation itself remains pinned to its original
        # desktop. Cloud runs use CLOUD_PROTOCOL and never enter this inbox.
        models.AiScheduleRun.owner_client_id == str(client.id or ""),
        models.AiScheduleRun.receipt['executionMode'].as_string() == PROTOCOL,
        models.AiScheduleRun.state.in_(['starting', 'running', 'waiting'])
    ).order_by(models.AiScheduleRun.started_at).limit(200)
    rows = (await session.execute(query)).all()
    # An empty inbox cannot contain expired native runs. Preserve the cached
    # identity polling path's single projection read and zero empty commits.
    expired = []
    if rows:
        from . import schedule_device_liveness
        expired = await schedule_device_liveness.reconcile_expired(
            session, owner_client_id=str(client.id or ''),
            owner_user_id=str(client.user_ref or ''))
        if expired:
            rows = (await session.execute(query)).all()
    items = [{'id': row.id, 'state': row.state} for row in rows]
    if changed or expired:
        await session.commit()
    return items


async def locked_run(session, client, run_id):
    run = (await session.execute(select(models.AiScheduleRun).where(
        models.AiScheduleRun.id == run_id,
        schedule_access.owner_clause(client, models.AiScheduleRun),
        models.AiScheduleRun.owner_client_id == str(client.id or "")
    ).with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()
    if run is None or dict(run.receipt or {}).get('executionMode') != PROTOCOL:
        raise HTTPException(404, '这条自动化会话不属于当前设备')
    return run


async def claim(session, client, run_id, instance):
    if not instance or len(instance) > 80:
        raise HTTPException(400, '缺少有效的执行端标识')
    run = await locked_run(session, client, run_id)
    from .schedule_device_liveness import expire_run
    await expire_run(session, run)
    receipt = dict(run.receipt or {})
    if run.state in ('succeeded', 'failed', 'cancelled'):
        await session.commit()
        return {'ok': True, 'terminal': True, 'state': run.state,
                'errorCode': receipt.get('errorCode', ''),
                'conversationId': receipt.get('conversationId', '')}
    now = datetime.now(timezone.utc).timestamp()
    if receipt.get('conversationId') and receipt.get('worker') != instance:
        # A restarted client without the executing session only observes it.
        # Claiming its lease and acknowledging "running" would keep a vanished
        # execution alive indefinitely, including after uninstall/reinstall.
        return {'ok': True, 'observeOnly': True, 'state': run.state,
                'conversationId': receipt['conversationId']}
    if receipt.get('worker') != instance and float(receipt.get('leaseUntil') or 0) > now:
        return {'ok': False, 'busy': True}
    from . import schedule_content
    envelope = await schedule_content.load(session, client, run, dict(receipt.get('conversationInput') or {}))
    previous_worker = str(receipt.get('worker') or '')
    if previous_worker and previous_worker != instance:
        # Preserve the handoff edge so the original worker can publish the
        # terminal result for the same conversation after a lease takeover.
        # This is intentionally one hop only; a later takeover replaces it.
        receipt['previousWorker'] = previous_worker
    else:
        receipt.pop('previousWorker', None)
    receipt.update(worker=instance, leaseUntil=now + RESERVATION_LEASE_SECONDS)
    run.receipt = receipt
    await session.commit()
    return {'ok': True, 'input': envelope,
            'trigger': run.trigger,
            'conversationId': receipt.get('conversationId', '')}


async def acknowledge(session, client, run_id, body):
    run = await locked_run(session, client, run_id)
    from .schedule_device_liveness import expire_run
    await expire_run(session, run)
    receipt = dict(run.receipt or {})
    requested_state = str(body.get('state') or '')
    # The conversation surface has four states. Keep accepting legacy worker
    # values while projecting them onto the same contract.
    state = {'waiting': 'running', 'cancelled': 'failed', 'canceled': 'failed'}.get(
        requested_state, requested_state)
    # ``starting`` is the id-less handshake used while the device has opened
    # the ordinary chat but has not submitted its first prompt yet.  Keeping
    # the receipt in this state prevents inbox consumers from opening an empty
    # conversation during that short gap.
    if state not in ('starting', 'running', 'succeeded', 'failed'):
        raise HTTPException(400, '执行状态无效')
    cid = str(body.get('conversationId') or '')[:120]
    if receipt.get('conversationId') and cid != receipt['conversationId']:
        raise HTTPException(409, '同一次自动化不能替换为另一条对话')
    # A stale worker can legitimately finish after a replacement client adopted
    # the durable conversation receipt.  The previous implementation rejected
    # that terminal acknowledgement after the replacement had already painted
    # the run failed with the cross-client handoff message, leaving a completed
    # conversation permanently red in execution history.  Permit only this
    # narrow, monotonic recovery: same owner/run and same conversation, plus
    # either the recorded previous worker after a lease handoff or the legacy
    # handoff error that is known to be a false dispatch failure.
    ack_worker = str(body.get('instanceId') or '')
    current_worker = str(receipt.get('worker') or '')
    previous_worker = str(receipt.get('previousWorker') or '')
    same_conversation = bool(cid and cid == receipt.get('conversationId'))
    receipt_timeout = (run.state == 'failed' and
                       receipt.get('errorCode') == 'AUTOMATION_RECEIPT_TIMEOUT' and
                       ack_worker and ack_worker == current_worker)
    legacy_false_failure = (run.state == 'failed' and
                            '另一客户端创建对话' in str(run.error or ''))
    stale_owner_completion = (run.state in ('starting', 'running', 'waiting') and
                              ack_worker == previous_worker and
                              ack_worker and ack_worker != current_worker)
    if (state == 'succeeded' and same_conversation and
            (receipt_timeout or stale_owner_completion or
             (legacy_false_failure and ack_worker and ack_worker != current_worker))):
        run.state = 'succeeded'
        run.error = ''
        run.finished_at = datetime.now(timezone.utc)
        receipt.pop('previousWorker', None)
        receipt.pop('errorCode', None)
        run.receipt = receipt
        latest = await session.scalar(select(models.AiScheduleRun.id).where(
            models.AiScheduleRun.schedule_id == run.schedule_id
        ).order_by(models.AiScheduleRun.started_at.desc()).limit(1))
        if latest == run.id:
            from . import schedule_timing
            schedule = await schedule_timing.locked_schedule(session, run.schedule_id)
            if schedule is not None and schedule_timing.matches(schedule, run):
                schedule.last_error = ''
        await session.commit()
        return {'ok': True, 'state': 'succeeded'}
    if receipt.get('worker') != str(body.get('instanceId') or ''):
        raise HTTPException(409, '本次执行已由另一个客户端接管')
    if run.state in ('succeeded', 'failed', 'cancelled'):
        await session.commit()
        return {'ok': True, 'state': run.state}
    if state in ('running', 'succeeded') and not cid:
        raise HTTPException(400, '缺少普通会话标识')
    receipt.update(conversationId=cid, leaseUntil=datetime.now(timezone.utc).timestamp() + 300)
    if state != 'starting':
        receipt.pop('phase', None)
    if state in ('succeeded', 'failed', 'cancelled'):
        # A takeover marker is only needed while the run is still live. Once
        # the current worker settles the run, discard the old owner edge so a
        # later stale acknowledgement cannot be mistaken for a valid handoff.
        receipt.pop('previousWorker', None)
    run.receipt = receipt
    run.state = state
    run.error = str(body.get('error') or '')[:1200] if state == 'failed' else ''
    run.finished_at = datetime.now(timezone.utc) if state in ('succeeded', 'failed', 'cancelled') else None
    # Only the latest occurrence controls the compact schedule card. Older
    # completions must not overwrite the state of a newer invocation.
    latest = await session.scalar(select(models.AiScheduleRun.id).where(
        models.AiScheduleRun.schedule_id == run.schedule_id
    ).order_by(models.AiScheduleRun.started_at.desc()).limit(1))
    if latest == run.id:
        from . import schedule_timing
        schedule = await schedule_timing.locked_schedule(session, run.schedule_id)
        if schedule is not None and schedule_timing.matches(schedule, run):
            schedule.last_error = run.error[:400]
    await session.commit()
    return {'ok': True, 'state': state}
