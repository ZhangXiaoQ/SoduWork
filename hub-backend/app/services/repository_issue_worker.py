"""One-minute subscription polling and durable first-start delivery."""
import asyncio
import logging
import time
from datetime import timedelta

from sqlalchemy import or_, select

from ..db import SessionLocal
from ..repository_issue_models import RepositoryIssueLink as Link, RepositoryIssueSync as Sync
from . import repository_issue_sync as sync, resource_leases

log = logging.getLogger("uvicorn.error")


async def writebacks(session, catalog_id):
    lease = await resource_leases.acquire(session, "repository-issues", catalog_id, ttl_seconds=120)
    try:
        setting = await session.get(Sync, catalog_id, populate_existing=True)
        if not setting or not setting.enabled:
            return 0
        ids = list((await session.scalars(select(Link.id).where(Link.catalog_id == catalog_id,
            Link.writeback_state.in_(("pending", "error")),
            or_(Link.next_retry_at.is_(None), Link.next_retry_at <= sync.now()))
            .order_by(Link.started_at).limit(100))).all())
        sent = 0
        for link_id in ids:
            link = await session.get(Link, link_id, populate_existing=True)
            if link is None:
                continue
            if link.task_id is None:
                link.writeback_state = "manual"
                link.last_error = "需求已删除，请人工核对源 Issue"
                link.next_retry_at = None
                await sync.fence(session, lease)
                await session.commit()
                continue
            if not link.started_at:
                continue
            if link.writeback_attempts >= 5:
                link.writeback_state = "manual"
                link.last_error = "开始处理回写已达到重试上限，请人工核对源 Issue"
                link.next_retry_at = None
                await sync.fence(session, lease)
                await session.commit()
                continue
            link.writeback_attempts += 1
            link.writeback_label = link.writeback_label or setting.started_label
            await sync.fence(session, lease)
            await session.commit()
            try:
                repo, cfg = await sync.source(session, catalog_id, require_enabled=True)
                result = await sync.call_remote(session, lease, sync.adapter(repo).started, cfg,
                    repo.external_id, link.issue_iid, link.writeback_label)
                if result.get("ok"):
                    link.writeback_state = "sent"
                    link.sent_at = sync.now()
                    link.next_retry_at = None
                    link.last_error = ""
                    sent += 1
                elif result.get("manual"):
                    link.writeback_state = "manual"
                    link.last_error = "Issue 已人工关闭或需要核对，未自动重开或修改后续状态"
                    link.next_retry_at = None
                else:
                    raise ValueError("Unconfirmed repository issue first-start response")
            except resource_leases.LeaseBusy:
                raise
            except Exception as exc:
                link.writeback_state = "manual" if link.writeback_attempts >= 5 else "error"
                link.next_retry_at = (None if link.writeback_state == "manual" else
                    sync.now() + timedelta(seconds=60 * 2 ** (link.writeback_attempts - 1)))
                link.last_error = sync.safe_error(exc).replace("游标未推进", "执行继续，回写等待重试")
            await sync.fence(session, lease)
            await session.commit()
        return sent
    except BaseException:
        await session.rollback()
        raise
    finally:
        await resource_leases.release(session, lease)


async def enabled_ids():
    async with SessionLocal() as session:
        return list((await session.scalars(select(Sync.catalog_id).where(Sync.enabled.is_(True)))).all())

async def one(catalog_id, limit):
    async with limit, SessionLocal() as session:
        try:
            await sync.run(session, catalog_id)
        except resource_leases.LeaseBusy:
            return
        except Exception as exc:
            log.warning("repository issue scan failed repository=%s type=%s", catalog_id, type(exc).__name__)
        try:
            await writebacks(session, catalog_id)
        except resource_leases.LeaseBusy:
            pass
        except Exception as exc:
            await session.rollback()
            log.warning("repository issue outbox failed repository=%s type=%s", catalog_id, type(exc).__name__)


async def tick():
    """Await one complete cycle for explicit probes and regression tests."""
    limit = asyncio.Semaphore(4)
    await asyncio.gather(*(one(cid, limit) for cid in await enabled_ids()))


async def tick_loop():
    limit = asyncio.Semaphore(4)
    running = {}
    try:
        while True:
            started = time.monotonic()
            try:
                ids = await enabled_ids()
                running = {cid: task for cid, task in running.items() if not task.done()}
                for cid in ids:
                    if cid not in running:
                        running[cid] = asyncio.create_task(one(cid, limit))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("repository issue tick failed type=%s", type(exc).__name__)
            # Slow repositories retain their own in-flight job. They do not
            # delay the next minute's scheduling for completed repositories.
            await asyncio.sleep(max(1, sync.INTERVAL - (time.monotonic() - started)))
    finally:
        for task in running.values():
            task.cancel()
        await asyncio.gather(*running.values(), return_exceptions=True)
