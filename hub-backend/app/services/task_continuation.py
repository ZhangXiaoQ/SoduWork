"""Restore a direct task's model authorization without changing its execution target."""
from __future__ import annotations

from sqlalchemy import select

from .. import automation_models as am, models
from . import agent_execution_options, environment_service, runner_hub, task_execution_model


class ContinuationError(ValueError):
    def __init__(self, message: str, code: str = ""):
        super().__init__(message)
        self.code = code


async def prepare(session, task, ctx: dict, ref: str) -> dict:
    execution = await session.scalar(select(am.ExecutionSession).where(
        am.ExecutionSession.ref == ref))
    if execution is None:
        # Legacy providers own their continuation configuration.
        return ctx
    if execution.task_id != task.id:
        raise ContinuationError("原执行记录不属于这条需求，未继续执行")
    rid = str(execution.runner_id or "")
    if not rid or rid == "backend-local":
        return ctx
    meta = dict(execution.metadata_ or {})
    identity = dict(meta.get("executionIdentity") or {})
    if identity.get("runnerId") and identity["runnerId"] != rid:
        raise ContinuationError("原执行机记录不一致，未继续执行")
    # The compatibility read-through projection used the requesting task
    # owner's device in runner_client_id. Dispatch identity is frozen and is
    # the authority when present; do not rewrite history or infer a new owner.
    original_client = str((identity.get("runnerClientId") or "") if identity.get("runnerId")
                          else execution.runner_client_id or "")
    context = dict(meta.get("executionContext") or {})
    original_runner = dict(context.get("runner") or {})
    # Older read-through snapshots filled an empty cloud client with the
    # requesting device, including the display identity. Only the frozen,
    # server-resolved dispatch context can disambiguate this known projection.
    if (original_client and original_client == task.owner_client_id
            and identity.get("runnerId") == rid
            and original_runner.get("mode") == "remote"
            and original_runner.get("id") == rid
            and original_runner.get("runnerId") == rid
            and (context.get("agent") or {}).get("id") == "runner:" + rid + ":" + execution.engine):
        original_client = str(original_runner.get("clientId") or "")
    owner = await session.get(models.Client, task.owner_client_id)
    if (owner is None or owner.auth_state != "active"
            or (task.owner_user_id and task.owner_user_id != owner.user_ref)):
        raise ContinuationError("原需求的授权设备已失效，请登录原账号后重试")
    node = await session.get(am.RunnerNode, rid)
    if (node is None or node.auth_state == "revoked"
            or node.management_state in {"retired", "pending_setup"}
            or str(node.client_id or "") != original_client):
        raise ContinuationError("原执行机归属已变化，未继续执行")
    runner = runner_hub.get(rid)
    if runner is None:
        raise ContinuationError("原执行机不在线，请恢复连接后重试", "RUNNER_OFFLINE")
    if (str(runner.client_id or "") != str(node.client_id or "")
            or str(runner.owner_user_id or "") != str(node.owner_user_id or "")
            or str(runner.org_id or "") != str(node.org_id or "")):
        raise ContinuationError("原执行机身份已变化，未继续执行")
    target_client = await session.get(models.Client, node.client_id) if node.client_id else None
    same_account = bool(owner.user_ref) and (
        node.owner_user_id == owner.user_ref or
        (target_client is not None and target_client.auth_state == "active"
         and target_client.user_ref == owner.user_ref))
    if node.owner_user_id and node.owner_user_id != owner.user_ref:
        raise ContinuationError("当前账号无权继续原执行机上的工作")
    if not same_account:
        clients = await environment_service.task_runner_clients(session, task)
        orgs = await environment_service.task_runner_orgs(session, task)
        if not runner_hub.in_scope(runner, clients, orgs):
            raise ContinuationError("当前需求已无权使用原执行机")
    cli = str(execution.engine or (context.get("agent") or {}).get("cli") or "")
    if not cli:
        raise ContinuationError("原执行底座记录不完整，请重新安排执行")
    model = str(context.get("model") or execution.model or "")
    if "local:" + cli in agent_execution_options.GATEWAY_MODEL_KINDS and not model:
        raise ContinuationError("原执行模型记录不完整，请重新安排执行")
    effort = str((context.get("execution") or {}).get("reasoningEffort") or "")
    try:
        out, native = await task_execution_model.prepare(
            session, owner, ctx, {"id": "runner:" + rid + ":" + cli}, model, effort)
    except ValueError as exc:
        raise ContinuationError(str(exc)) from exc
    # The provider consumes this before RPC. It must never search another Runner
    # for the same ref, nor transmit this server-side routing guard to a process.
    out = dict(out)
    out["_continuationRunnerId"] = rid
    for key in ("cfg", "localCfg"):
        config = dict(out.get(key) or {})
        config.update(_continuationRunnerId=rid, local_cli=cli)
        config["_continuationRunnerIdentity"] = {
            "client_id": str(node.client_id or ""),
            "owner_user_id": str(node.owner_user_id or ""),
            "org_id": str(node.org_id or ""),
        }
        if cli == "codex":
            config.update(codex_model=native.get("model", ""),
                          codex_reasoning_effort=native.get("reasoningEffort", ""))
        out[key] = config
    return out
