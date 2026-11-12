"""ai-proxy upstream-open keepalive tests. No database, credentials or network.

The company access layer cuts responses that emit no bytes for ~60s — shorter
than hub's 300s upstream readTimeout — so long prefills used to surface as the
access layer's own 504 HTML page. The open wait now streams SSE comment
heartbeats (HTTP 200 immediately), and open-phase failures become in-stream
error events with the stable product message shape.
"""
import asyncio
import json
import unittest
from unittest.mock import patch
from starlette.requests import ClientDisconnect

from app.api import ai_proxy
from app.services import model_errors, model_runtime
from model_test_support import FakeResponse


class OpenKeepaliveTests(unittest.IsolatedAsyncioTestCase):
    async def _drain(self, response, first=None, limit=64):
        it = response.body_iterator.__aiter__()
        chunks = [first] if first is not None else []
        async for chunk in it:
            chunks.append(chunk)
            if len(chunks) >= limit:
                break
        return chunks

    async def test_first_heartbeat_leaves_before_upstream_answers(self):
        gate = asyncio.Event()
        started = asyncio.Event()

        async def slow_open():
            started.set()
            await gate.wait()
            return FakeResponse(b'data: {"choices":[]}\n\ndata: [DONE]\n\n')

        response = await ai_proxy._open_then_stream(None, slow_open)
        it = response.body_iterator.__aiter__()
        first = await asyncio.wait_for(anext(it), 1)
        self.assertEqual(first, ai_proxy.OPEN_KEEPALIVE_COMMENT,
                         "the SSE head must leave before upstream even answers")
        gate.set()
        chunks = await self._drain(response, first=first)
        body = b"".join(chunks)
        self.assertIn(b'data: {"choices":[]}', body)
        self.assertIn(b"[DONE]", body)
        await response.background()

    async def test_heartbeats_flow_during_upstream_silence(self):
        async def slow_open():
            await asyncio.sleep(0.05)
            return FakeResponse(b"data: [DONE]\n\n")

        with patch.object(ai_proxy, "OPEN_KEEPALIVE_INTERVAL", 0.01):
            response = await ai_proxy._open_then_stream(None, slow_open)
            it = response.body_iterator.__aiter__()
            first = await asyncio.wait_for(anext(it), 1)
            chunks = await self._drain(response, first=first)
            await response.background()
        body = b"".join(chunks)
        self.assertGreaterEqual(body.count(b": soduwork-keepalive"), 2,
                                "a 50ms open must not starve the client of bytes")
        self.assertIn(b"data: [DONE]", body)

    async def test_open_failure_becomes_in_stream_error_event(self):
        async def boom():
            raise model_errors.UpstreamError(504, "<html>upstream raw</html>")

        response = await ai_proxy._open_then_stream(None, boom)
        chunks = await self._drain(response)
        await response.background()
        body = b"".join(chunks)
        self.assertTrue(body.startswith(b": soduwork-keepalive"))
        data_frames = [line for line in body.split(b"\n") if line.startswith(b"data: ")]
        self.assertEqual(len(data_frames), 1, "exactly one error event, no token passthrough")
        payload = json.loads(data_frames[0][len("data: "):])
        self.assertEqual(payload["error"]["type"], "soduwork_proxy_error")
        self.assertEqual(payload["error"]["code"], 504)
        self.assertNotIn(b"<html>", data_frames[0], "raw upstream body must not leak")
        self.assertTrue(payload["error"]["message"])

    async def test_responses_not_found_uses_stable_copy(self):
        async def boom():
            raise model_errors.UpstreamError(404, "model gone")

        response = await ai_proxy._open_then_stream(None, boom, responses=True)
        chunks = await self._drain(response)
        await response.background()
        data_frames = [line for line in b"".join(chunks).split(b"\n") if line.startswith(b"data: ")]
        payload = json.loads(data_frames[0][len("data: "):])
        self.assertEqual(payload["error"]["code"], 404)
        self.assertNotIn(b"model gone", data_frames[0])

    async def test_billing_failures_are_safe_permanent_json_and_stream_diagnostics(self):
        for upstream in ({"error": {"code": "1113", "message": "private-fixture-secret"}},
                         {"error": {"type": "insufficient_quota", "message": "https://private.invalid"}}):
            error = model_errors.UpstreamError(429, json.dumps(upstream))
            error.retry_after = 2

            async def boom():
                raise error

            ordinary = ai_proxy._proxy_error(error)
            expected = json.loads(ordinary.body)
            self.assertEqual(expected["error"]["code"], "upstream_billing_error")
            self.assertEqual(expected["error"]["status"], 429)
            self.assertIn("billing_required", expected["error"]["message"])
            self.assertNotIn("retry-after", ordinary.headers)
            self.assertNotIn("retry_after_ms", expected["error"])
            self.assertEqual(expected["error"].get("providerCode"),
                             "1113" if "code" in upstream["error"] else None)
            self.assertIn("余额", model_errors.public_failure(upstream))
            for responses in (False, True):
                streamed = await ai_proxy._open_then_stream(None, boom, responses=responses)
                body = b"".join(await self._drain(streamed))
                await streamed.background()
                frames = [line[6:] for line in body.split(b"\n") if line.startswith(b"data: ")]
                self.assertEqual([json.loads(frame) for frame in frames], [expected])
                self.assertNotIn(b"private-fixture-secret", body)
                self.assertNotIn(b"private.invalid", body)

    async def test_unknown_429_remains_transient_without_echoing_arbitrary_codes(self):
        error = model_errors.UpstreamError(429, json.dumps({
            "error": {"code": "11130-private", "message": "private-fixture-secret"}}))
        error.retry_after = 2
        response = ai_proxy._proxy_error(error)
        payload = json.loads(response.body)["error"]
        self.assertEqual(payload["code"], 429)
        self.assertEqual(payload["retry_after_ms"], 2000)
        self.assertEqual(response.headers["retry-after"], "2")
        self.assertNotIn("11130", response.body.decode())
        self.assertNotIn("private-fixture-secret", response.body.decode())

    async def test_generator_close_cancels_pending_open(self):
        # Closing the generator must cancel a pending upstream open to prevent socket or lease leaks.
        # Cancellation before coroutine startup marks the task cancelled without executing its body.
        # Assert final task state rather than callback execution; both cancellation paths avoid leaks.
        ref = {}

        async def hanging_open():
            ref["task"] = asyncio.current_task()
            await asyncio.sleep(0)  # Allow the coroutine to start and suspend in the event loop.
            await asyncio.Event().wait()

        response = await ai_proxy._open_then_stream(None, hanging_open)
        it = response.body_iterator.__aiter__()
        await asyncio.wait_for(anext(it), 1)
        await asyncio.sleep(0)  # Start the open task to simulate an issued upstream request.
        await it.aclose()
        task = ref.get("task")
        self.assertIsNotNone(task, "the open task must have started")
        for _ in range(50):
            if task.done():
                break
            await asyncio.sleep(0.01)
        self.assertTrue(task.done())
        self.assertTrue(task.cancelled())

    async def test_close_reclaims_response_that_arrived_before_handoff(self):
        opened = FakeResponse(b"data: [DONE]\n\n")
        arrived = asyncio.Event()

        async def open_now():
            arrived.set()
            return opened

        response = await ai_proxy._open_then_stream(None, open_now)
        await anext(response.body_iterator)
        await arrived.wait()
        await response.body_iterator.aclose()
        self.assertTrue(opened.closed, "disconnect must reclaim a completed, unclaimed open")

    async def test_asgi_send_failure_closes_generator_before_request_returns(self):
        opened = FakeResponse(b"data: [DONE]\n\n")
        arrived = asyncio.Event()
        disconnected = OSError("client socket closed")

        async def open_now():
            arrived.set()
            return opened

        async def send(message):
            if message["type"] == "http.response.body":
                await arrived.wait()
                raise disconnected

        async def receive():
            await asyncio.Event().wait()

        response = await ai_proxy._open_then_stream(None, open_now)
        try:
            with self.assertRaises((ClientDisconnect, OSError, ExceptionGroup)) as raised:
                await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
            # Older Starlette uses an AnyIO group even for ASGI 2.4; newer
            # versions translate send errors to ClientDisconnect, with either
            # an explicit cause or implicit context. Keep the socket identity
            # check and reject extra failures.
            error = raised.exception
            if isinstance(error, ClientDisconnect):
                self.assertIs(error.__cause__ or error.__context__, disconnected)
            elif isinstance(error, ExceptionGroup):
                self.assertEqual(error.exceptions, (disconnected,))
            else:
                self.assertIs(error, disconnected)
            self.assertTrue(opened.closed, "ASGI send failure must close even when background is skipped")
        finally:
            await response.body_iterator.aclose()

    async def test_asgi_disconnect_during_send_closes_generator(self):
        opened = FakeResponse(b"data: [DONE]\n\n")
        arrived, sending = asyncio.Event(), asyncio.Event()

        async def open_now():
            arrived.set()
            return opened

        async def send(message):
            if message["type"] == "http.response.body":
                await arrived.wait()
                sending.set()
                await asyncio.Event().wait()

        async def receive():
            await sending.wait()
            return {"type": "http.disconnect"}

        response = await ai_proxy._open_then_stream(None, open_now)
        try:
            await response({"type": "http", "asgi": {"spec_version": "2.0"}}, receive, send)
            self.assertTrue(opened.closed, "AnyIO disconnect cancellation must settle the generator")
        finally:
            await response.body_iterator.aclose()

    async def test_close_joins_pending_open_cleanup_before_returning(self):
        entered, cleaning, release, settled = [asyncio.Event() for _ in range(4)]

        async def open_pending():
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaning.set()
                await release.wait()
                settled.set()

        response = await ai_proxy._open_then_stream(None, open_pending)
        await anext(response.body_iterator)
        await entered.wait()
        close = asyncio.create_task(response.body_iterator.aclose())
        try:
            await asyncio.wait_for(cleaning.wait(), 1)
            self.assertFalse(close.done(), "cleanup must finish before the request releases ownership")
        finally:
            release.set()
            await close
        self.assertTrue(settled.is_set())

    async def test_close_during_body_forwarding_settles_upstream(self):
        opened = FakeResponse(b"data: first\n\ndata: [DONE]\n\n")

        async def open_now():
            return opened

        response = await ai_proxy._open_then_stream(None, open_now)
        await anext(response.body_iterator)
        self.assertIn(b"first", await anext(response.body_iterator))
        await response.body_iterator.aclose()
        self.assertTrue(opened.closed, "do not depend on async-generator garbage collection")

    async def test_open_context_overflow_retains_json_error_contract(self):
        error = model_errors.UpstreamError(400, "maximum context length is 8192 tokens; private-fixture")

        async def boom():
            raise error

        response = await ai_proxy._open_then_stream(None, boom)
        frames = [line[6:] for line in b"".join(await self._drain(response)).split(b"\n")
                  if line.startswith(b"data: ")]
        self.assertEqual(json.loads(frames[0]), json.loads(ai_proxy._proxy_error(error).body))
        self.assertEqual(json.loads(frames[0])["error"]["code"], "context_length_exceeded")
        self.assertNotIn(b"private-fixture", frames[0])

    async def test_unexpected_open_failure_does_not_log_secret_payload(self):
        async def boom():
            raise RuntimeError("Bearer private-fixture-secret https://private.invalid")

        with self.assertLogs("uvicorn.error", level="WARNING") as logs:
            response = await ai_proxy._open_then_stream(None, boom)
            body = b"".join(await self._drain(response))
        self.assertNotIn("private-fixture-secret", " ".join(logs.output))
        self.assertNotIn(b"private-fixture-secret", body)

    async def test_capacity_failure_preserves_retry_status_before_and_during_stream(self):
        for status in (429, 503):
            for during_body in (False, True):
                for responses in (False, True):
                    with self.subTest(status=status, during_body=during_body, responses=responses):
                        error = model_runtime.CapacityError("模型并发调度连接中断，请稍后重试", status)
                        error.body = "Bearer private-fixture-secret https://private.invalid"

                        class Interrupted(FakeResponse):
                            async def chunks(self):
                                yield b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
                                raise error

                        opened = Interrupted(b"")

                        async def open_call():
                            if not during_body:
                                raise error
                            return opened

                        response = await ai_proxy._open_then_stream(None, open_call, responses=responses)
                        sent = []

                        async def send(message):
                            sent.append(message)

                        async def receive():
                            await asyncio.Event().wait()

                        await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
                        self.assertEqual(sent[0]["status"], 200)
                        body = b"".join(message.get("body", b"") for message in sent)
                        errors = [json.loads(line[6:])["error"] for line in body.split(b"\n")
                                  if line.startswith(b"data: ") and b'"error"' in line]
                        self.assertEqual(len(errors), 1)
                        self.assertEqual(errors[0]["status"], status)
                        self.assertEqual(errors[0]["code"], status)
                        self.assertIn(f"HTTP {status}", errors[0]["message"])
                        self.assertIn("模型并发调度连接中断", errors[0]["message"])
                        self.assertNotIn(b"private-fixture-secret", body)
                        self.assertNotIn(b"private.invalid", body)
                        self.assertNotIn(b"[DONE]", body, "interrupted streams must not claim completion")
                        if during_body:
                            self.assertIn(b"partial", body)
                            self.assertTrue(opened.closed)
                        ordinary = ai_proxy._proxy_error(error, responses=responses)
                        self.assertEqual(ordinary.status_code, status)
                        self.assertEqual(json.loads(ordinary.body)["error"], errors[0])


if __name__ == "__main__":
    unittest.main()
