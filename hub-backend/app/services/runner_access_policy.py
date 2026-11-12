"""Durable final authorization for personal Runner transport operations.

Administration takes effect before the next heartbeat and on every Hub. A
disabled computer may finish existing work and return its results, but cannot
receive another prompt, shell input, package install, or configuration change.
"""
from __future__ import annotations
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar

from sqlalchemy import select, text

class RunnerAccessDenied(RuntimeError):
    pass


_content_transaction = ContextVar("runner_content_transaction", default=None)
_CONTENT_OPS = frozenset({"content.put", "content.seal", "content.read", "content.status"})


@contextmanager
def content_transaction(session):
    """Reuse the caller's transaction only for immutable content operations.

    An event ingest already owns database locks. A second local connection
    would wait on its own caller before sending the persistence acknowledgement.
    This does not bypass the final ownership/policy check or commit caller work.
    Remote Hub processes still perform their own transport authorization.
    """
    token = _content_transaction.set(session)
    try:
        yield
    finally:
        _content_transaction.reset(token)


async def acquire_runner_policy_lock(session, runner_id):
    """SQLite ignores FOR UPDATE; take its writer lock before reading policy.

    The lock belongs to this transaction and works across Hub processes. A raw
    no-op leaves telemetry timestamps untouched. Lock failures propagate; never
    continue an administrative action or send using an earlier ORM snapshot.
    PostgreSQL callers retain their existing row-level FOR UPDATE locks.
    """
    if session.get_bind().dialect.name == "sqlite":
        await session.execute(text(
            "UPDATE automation_runner_node SET id=id WHERE id=:runner_id"
        ), {"runner_id": str(runner_id)})


_DISABLED_ALLOWED = frozenset({
    "welcome", "ping", "session.ack", "session.nack", "runner.probe", "job.has", "job.status", "job.info",
    "job.session", "job.file", "job.stop", "input.drop",
    "content.put", "content.seal", "content.read", "content.status",
    "agent.setup", "agent.job", "component.list", "component.job",
    "deploy.status", "quality.status", "term.close", "term.detach",
})


def denial(row, runner, op):
    """No caller-supplied owner or workspace is treated as authorization."""
    if row is None:
        return "执行机登记已失效，请重新接入"
    state = str(getattr(row, "management_state", "") or "")
    if state in {"retired", "pending_setup"}:
        return "云端电脑已回收或正在重新接入，暂不能使用"
    if row.auth_state == "revoked":
        return "执行机接入凭据已撤销"
    if (str(row.owner_user_id or "") != str(getattr(runner, "owner_user_id", "") or "")
            or str(row.client_id or "") != str(getattr(runner, "client_id", "") or "")
            or str(row.org_id or "") != str(getattr(runner, "org_id", "") or "")):
        return "执行机归属已变更，请刷新后重试"
    if state and op not in _DISABLED_ALLOWED:
        return "云端电脑已被管理员停用，不能启动或修改工作"
    if op in {"job.dispatch", "job.comment"} and row.dispatch_mode != "accepting":
        return "执行机已暂停接单，不能启动新的工作"
    return ""


@asynccontextmanager
async def authorize_send(runner, op):
    """Check personal machines on single-instance and clustered Hubs alike.

    Other Runner classes retain their existing admission checks. Their frequent
    terminal/status messages do not acquire an unrelated new database read.
    """
    if not (getattr(runner, "owner_user_id", "") or
            getattr(runner, "management_state", "")):
        yield
        return
    from ..automation_models import RunnerNode
    from ..db import SessionLocal
    async def check_policy(session):
        await acquire_runner_policy_lock(session, runner.id)
        row = await session.scalar(select(RunnerNode).where(
            RunnerNode.id == runner.id).with_for_update().execution_options(populate_existing=True))
        reason = denial(row, runner, op)
        if reason:
            raise RunnerAccessDenied(reason)

    caller = _content_transaction.get() if op in _CONTENT_OPS else None
    if caller is not None:
        await check_policy(caller)
        yield
        return
    async with SessionLocal() as session:
        async with session.begin():
            await check_policy(session)
            # Keep the same row lock as administrative state transitions until
            # bytes leave this Hub; a transfer cannot pass the last check.
            yield


async def check(runner, op):
    async with authorize_send(runner, op):
        pass


async def authenticated_identity(session, runner_id, keyed_id, key):
    """Shared tokens/device identities cannot claim an enrolled identity."""
    from ..automation_models import RunnerNode
    from .runner_registry import verify_key
    row = await session.get(RunnerNode, runner_id)
    if row and (row.owner_user_id or row.secret_hash or row.auth_state == "revoked" or
                row.management_state):
        return bool(keyed_id == runner_id and key and await verify_key(session, runner_id, key))
    return True


def require_personal_mutation(row):
    from fastapi import HTTPException
    if str(getattr(row, "management_state", "") or ""):
        raise HTTPException(409, "此云端电脑由管理员停用或正在交接，请联系管理员处理")


def require_generic_admin_mutation(row):
    from fastapi import HTTPException
    if row and (row.owner_user_id or str(getattr(row, "management_state", "") or "")):
        raise HTTPException(409, "请通过云端电脑的启用或重新分配流程管理此节点")
