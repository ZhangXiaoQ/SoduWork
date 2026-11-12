"""Async, pooled model HTTP transport with lifetime-bound admission leases."""
from __future__ import annotations

import asyncio
import logging
import time
import weakref
import re

import anyio
import httpx
from fastapi import HTTPException

from . import model_runtime
from .model_errors import UpstreamError

log = logging.getLogger("uvicorn.error")
_clients = weakref.WeakKeyDictionary()


def _safe_error_text(error) -> str:
    """Retain network failure type and reason while stripping URLs, credentials, and oversized
    responses.
    """
    text = str(error or "").replace("\r", " ").replace("\n", " ").strip()
    text = re.sub(r"https?://\S+", "<url>", text, flags=re.IGNORECASE)
    text = re.sub(r"(?i)(bearer|authorization|api[-_ ]?key|token|secret|password)[=: ]+\S+",
                  r"\1=<redacted>", text)
    return text[:240]


def _endpoint(url) -> str:
    """Return an audit-safe endpoint without query strings or userinfo."""
    try:
        scheme = str(url.scheme or "")
        host = str(url.host or "")
        port = url.port
        suffix = (":" + str(port)) if port and not ((scheme == "https" and port == 443) or
                                                     (scheme == "http" and port == 80)) else ""
        return (scheme + "://" + host + suffix + str(url.path or ""))[:300]
    except Exception:  # noqa: BLE001
        return "<unknown>"


def _client():
    loop = asyncio.get_running_loop()
    client = _clients.get(loop)
    if client is None or client.is_closed:
        client = httpx.AsyncClient(trust_env=False, follow_redirects=False,
                                   limits=httpx.Limits(max_connections=256, max_keepalive_connections=32))
        _clients[loop] = client
    return client


async def shutdown():
    client = _clients.pop(asyncio.get_running_loop(), None)
    if client:
        await client.aclose()


class Response:
    def __init__(self, response, lease, endpoint="<unknown>", timing=None):
        self.response, self.lease = response, lease
        self.endpoint = endpoint
        self.headers = response.headers
        self.closed = False
        self._close_task = None
        self.outcome = "completed"
        self.timing = dict(timing or {})
        self.guard = asyncio.create_task(self._guard_lifetime())

    async def _guard_lifetime(self):
        # Enforce total lifetime even when a slow downstream stops requesting
        # chunks. Socket close must not depend on the next generator iteration.
        try:
            async with asyncio.timeout(max(0, self.lease.deadline - time.monotonic())):
                await self.lease.lost.wait()
            self.outcome = "failed"
        except TimeoutError:
            self.outcome = "timeout"
        # If a consumer already owns cleanup, it may be about to cancel and
        # join this guard. Do not join that same cleanup barrier from here.
        # There is no await between this ownership check and aclose's claim.
        if self._close_task is None:
            await self.aclose()

    async def chunks(self):
        iterator = self.response.aiter_bytes().__aiter__()
        try:
            if self.closed:
                raise UpstreamError(504 if self.outcome == "timeout" else 503, "",
                                    "模型响应已超时或中断，请稍后重试")
            while True:
                try:
                    chunk = await self.lease.run(anext(iterator))
                except StopAsyncIteration:
                    break
                yield chunk
        except (TimeoutError, httpx.TimeoutException) as exc:
            self.outcome = "timeout"
            raise UpstreamError(504, "", "等待模型响应超时，请稍后重试") from exc
        except asyncio.CancelledError:
            self.outcome = "cancelled"
            raise
        except GeneratorExit:
            self.outcome = "cancelled"
            raise
        except httpx.HTTPError as exc:
            if self.outcome == "timeout":
                raise UpstreamError(504, "", "等待模型响应超时，请稍后重试") from exc
            self.outcome = "failed"
            log.warning("[model-transport] stream failed endpoint=%s error=%s detail=%s",
                        self.endpoint, type(exc).__name__, _safe_error_text(exc))
            raise UpstreamError(502, "", "模型连接中断，请稍后重试") from exc
        except UpstreamError:
            if self.outcome == "completed":
                self.outcome = "failed"
            raise
        finally:
            await self.aclose()

    async def read(self, cap=8 * 1024 * 1024):
        parts, size = [], 0
        body_started = time.perf_counter()
        try:
            async for part in self.chunks():
                size += len(part)
                if size > cap:
                    self.outcome = "failed"
                    raise UpstreamError(502, "", "模型返回内容超过大小限制")
                parts.append(part)
            result = b"".join(parts)
            body_ms = (time.perf_counter() - body_started) * 1000
            self.timing["bodyMs"] = round(body_ms, 1)
            self.timing["totalMs"] = round(float(self.timing.get("openMs") or 0) + body_ms, 1)
            return result
        finally:
            await self.aclose()

    async def aclose(self):
        if self._close_task is None:
            self.closed = True
            # Both the deadline guard and the response consumer can close at
            # once. Closed means no more reads; settlement still belongs to one
            # shared task, which every caller must await before returning.
            cancel_guard = self.guard is not asyncio.current_task()
            self._close_task = asyncio.create_task(self._close_resources(cancel_guard))
        cancelled = False
        with anyio.CancelScope(shield=True):
            while not self._close_task.done():
                try:
                    await asyncio.shield(self._close_task)
                except asyncio.CancelledError:
                    # A second raw asyncio cancellation must not orphan socket
                    # or admission cleanup. Preserve it after bounded cleanup.
                    cancelled = True
        if cancelled:
            raise asyncio.CancelledError
        return self._close_task.result()

    async def _close_resources(self, cancel_guard):
        try:
            with anyio.move_on_after(5, shield=True):
                if cancel_guard:
                    self.guard.cancel()
                    await asyncio.gather(self.guard, return_exceptions=True)
                await self.response.aclose()
        finally:
            await self.lease.close(self.outcome)


async def open_response(conf, path, body, *, stream=False, timeout=None):
    """The caller owns Response until close, including the entire SSE body."""
    opened_at = time.perf_counter()
    lease = await model_runtime.acquire(conf)
    admission_ms = (time.perf_counter() - opened_at) * 1000
    response = None
    outcome = "failed"
    delivered = False
    try:
        # Capacity queues can outlive a quota change or another device's usage.
        # Recheck after admission and release the DB before opening upstream.
        if conf.get("quotaUserId"):
            from . import client_access
            async with model_runtime.SessionLocal() as quota_session:
                try:
                    from .model_quota import revalidate_selection
                    await revalidate_selection(quota_session, conf)
                    await client_access.assert_quota(quota_session, conf["quotaUserId"],
                                                     provider=conf.get("provider", ""),
                                                     model=conf.get("model", ""),
                                                     personal=conf.get("quotaScope") == "personal")
                except client_access.ClientAccessError as exc:
                    error = UpstreamError(exc.status, "", str(exc))
                    error.quota_detail = exc.detail()
                    raise error from exc
        if timeout is not None:
            lease.deadline = min(lease.deadline, time.monotonic() + timeout)
        settings = lease.policy
        headers = {"Authorization": "Bearer " + conf["key"],
                   "Accept": "text/event-stream" if stream else "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        http = _client()
        request = http.build_request("POST" if body is not None else "GET",
                                     conf["base"].rstrip("/") + path, content=body, headers=headers,
                                     timeout=httpx.Timeout(settings["readTimeout"],
                                                           connect=settings["connectTimeout"],
                                                           pool=settings["connectTimeout"]))
        endpoint = _endpoint(request.url)
        upstream_started = time.perf_counter()
        response = await lease.run(http.send(request, stream=True))
        wrapped = Response(response, lease, endpoint, {
            "admissionMs": round(admission_ms, 1),
            "upstreamHeadersMs": round((time.perf_counter() - upstream_started) * 1000, 1),
            "openMs": round((time.perf_counter() - opened_at) * 1000, 1),
        })
        if response.status_code >= 300:
            wrapped.outcome = "rateLimited" if response.status_code == 429 else "failed"
            raw = bytearray()
            try:
                async for chunk in wrapped.chunks():
                    raw.extend(chunk[:4000 - len(raw)])
                    if len(raw) >= 4000:
                        break
            finally:
                await wrapped.aclose()
            error = UpstreamError(response.status_code, raw.decode("utf-8", "replace"))
            retry = response.headers.get("retry-after", "")
            if retry.isdigit():
                error.retry_after = min(3600, max(1, int(retry)))
            raise error
        delivered = True
        return wrapped
    except asyncio.CancelledError:
        outcome = "cancelled"
        raise
    except (httpx.TimeoutException, TimeoutError) as exc:
        outcome = "timeout"
        raise UpstreamError(504, "", "等待模型响应超时，请稍后重试") from exc
    except httpx.HTTPError as exc:
        log.warning("[model-transport] request failed endpoint=%s error=%s detail=%s",
                    locals().get("endpoint", "<unbuilt>"), type(exc).__name__, _safe_error_text(exc))
        raise UpstreamError(502, "", "暂时无法连接模型服务，请稍后重试") from exc
    except UpstreamError:
        raise
    finally:
        # On success ownership moves to Response. On every failed/cancelled
        # open, close both the socket and its lease (including header wait).
        if not delivered:
            try:
                if response is not None:
                    with anyio.move_on_after(5, shield=True):
                        await response.aclose()
            finally:
                await lease.close(outcome)


async def until_disconnect(request, operation):
    """Also cancel queued/header/non-streaming requests before SSE takes over."""
    stopping = False
    async def watch():
        # Request.is_disconnected uses an AnyIO cancellation scope, which can
        # consume task cancellation. An explicit flag also terminates this loop.
        while not stopping and not await request.is_disconnected():
            await asyncio.sleep(.1)
    work = asyncio.create_task(operation)
    disconnect = asyncio.create_task(watch())
    delivered = False
    try:
        done, _ = await asyncio.wait((work, disconnect), return_when=asyncio.FIRST_COMPLETED)
        if disconnect in done:
            raise HTTPException(499, "客户端已断开连接")
        result = await work
        delivered = True
        return result
    finally:
        stopping = True
        work.cancel()
        disconnect.cancel()
        with anyio.CancelScope(shield=True):
            await asyncio.gather(work, disconnect, return_exceptions=True)
            # A response can arrive in the same event-loop tick as disconnect.
            if not delivered and work.done() and not work.cancelled():
                result = None if work.exception() else work.result()
                if isinstance(result, Response):
                    result.outcome = "cancelled"
                    await result.aclose()
