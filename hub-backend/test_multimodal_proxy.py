"""Isolated gateway boundary tests. No database, credentials or external model."""
import asyncio
import copy
import io
import json
import threading
import unittest
from unittest.mock import patch, AsyncMock

from app.services import multimodal_proxy as proxy, model_errors, model_transport
from model_test_support import FakeResponse


CONF = {"base": "http://127.0.0.1:9", "key": "fixture", "imageRouting": "native"}
IMAGE = "data:image/png;base64,aW1hZ2U="


def payload(path):
    field = "messages" if path == "/chat/completions" else "input"
    image = {"type": "image_url", "image_url": {"url": IMAGE}} if field == "messages" else {
        "type": "input_image", "image_url": IMAGE}
    return {"model": "arbitrary-alias", "stream": True, field: [
        {"role": "user", "content": [{"type": "text" if field == "messages" else "input_text",
                                    "text": "Describe the original image"}, image]}],
        "tools": [{"type": "function", "function": {"parameters": {"type": "object",
                   "properties": {"image": {"type": "image"}}}}}]}


def rejection(status=400, message="This model does not support image input"):
    return model_errors.UpstreamError(status, json.dumps({"error": {"message": message}}))


class MultimodalProxyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        adapter = patch.object(proxy, "adapter_configured", return_value=True)
        adapter.start()
        self.addCleanup(adapter.stop)

    async def test_unconfigured_adapter_rejects_non_native_images_without_any_model_call(self):
        for path in ("/chat/completions", "/responses"):
            for route in (None, "vision-fallback"):
                body = payload(path)
                before = copy.deepcopy(body)
                observe = AsyncMock()
                with patch.object(proxy, "adapter_configured", return_value=False), \
                     patch.object(model_transport, "open_response") as send:
                    with self.assertRaisesRegex(model_errors.UpstreamError, "原图已保留"):
                        await proxy.open_request({**CONF, "imageRouting": route,
                            "visionFallbackAvailable": True}, path, body, observe)
                send.assert_not_called()
                observe.assert_not_called()
                self.assertEqual(body, before)

    async def test_native_model_without_adapter_keeps_pixels_and_never_changes_model_on_rejection(self):
        for path in ("/chat/completions", "/responses"):
            body = payload(path)
            observe = AsyncMock()
            with patch.object(proxy, "adapter_configured", return_value=False), \
                 patch.object(model_transport, "open_response", return_value=FakeResponse()) as send:
                await proxy.open_request(CONF, path, body, observe)
                self.assertEqual(json.loads(send.call_args.args[2]), body)
            with patch.object(proxy, "adapter_configured", return_value=False), \
                 patch.object(model_transport, "open_response", side_effect=rejection()) as send:
                with self.assertRaisesRegex(model_errors.UpstreamError, "未自动更换模型"):
                    await proxy.open_request(CONF, path, body, observe)
                self.assertEqual(send.call_count, 1)
            observe.assert_not_called()

    async def test_text_and_tool_schemas_do_not_require_an_adapter(self):
        body = payload('/responses')
        body['input'] = 'text only'
        with patch.object(proxy, "adapter_configured", return_value=False), \
             patch.object(model_transport, "open_response", return_value=FakeResponse()) as send:
            observe = AsyncMock()
            await proxy.open_request({**CONF, "imageRouting": "vision-fallback"}, '/responses', body, observe)
        self.assertEqual(json.loads(send.call_args.args[2]), body)
        observe.assert_not_called()

    async def test_stream_cancellation_does_not_close_a_running_generator(self):
        """A cancelled SSE request must not turn into generator re-entrancy."""
        from app.api import ai_proxy

        class BlockingResponse(FakeResponse):
            def __init__(self):
                super().__init__()
                self.entered = asyncio.Event()
            async def chunks(self):
                self.entered.set()
                await asyncio.Event().wait()
                yield b"unreachable"

        response = BlockingResponse()
        stream = ai_proxy._stream_upstream_response(response)
        read = asyncio.create_task(anext(stream))
        await asyncio.wait_for(response.entered.wait(), 1)
        read.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await read
        self.assertTrue(response.closed)
        await stream.aclose()

    async def test_native_images_are_unchanged_for_both_protocols(self):
        for path in ("/chat/completions", "/responses"):
            with self.subTest(path=path):
                body = payload(path)
                before = copy.deepcopy(body)
                observe = AsyncMock()
                response = FakeResponse(b"data: [DONE]\n\n")
                with patch.object(model_transport, "open_response", return_value=response) as send:
                    got = await proxy.open_request(CONF, path, body, observe)
                self.assertIs(got, response)
                self.assertEqual(response.tell(), 0, "do not buffer or consume streaming tokens")
                self.assertEqual(json.loads(send.call_args.args[2]), before)
                self.assertEqual(body, before)
                observe.assert_not_called()

    async def test_vision_fallback_route_transcribes_before_first_upstream_call(self):
        for path in ("/chat/completions", "/responses"):
            with self.subTest(path=path):
                body = payload(path)
                observe = AsyncMock(return_value={
                    "ok": True, "imageCount": 1,
                    "observation": {"summary": "red circle"},
                })
                response = FakeResponse()
                with patch.object(model_transport, "open_response", return_value=response) as send:
                    got = await proxy.open_request(
                        {**CONF, "imageRouting": "vision-fallback"}, path, body, observe)
                self.assertIs(got, response)
                self.assertEqual(send.call_count, 1)
                forwarded = json.loads(send.call_args.args[2])
                field = "messages" if path == "/chat/completions" else "input"
                converted = forwarded[field][0]["content"][1]
                self.assertEqual(converted["type"], "text" if field == "messages" else "input_text")
                self.assertIn("red circle", converted["text"])
                self.assertEqual(forwarded["tools"], body["tools"])
                self.assertIn(IMAGE, json.dumps(body), "the original payload remains available to history")
                observe.assert_awaited_once()

    async def test_explicit_image_rejection_falls_back_once_in_the_correct_protocol(self):
        for path in ("/chat/completions", "/responses"):
            with self.subTest(path=path):
                body = payload(path)
                observe = AsyncMock(return_value={"ok": True, "imageCount": 1, "observation": {"summary": "red circle"}})
                response = FakeResponse()
                with patch.object(model_transport, "open_response", side_effect=[rejection(), response]) as send:
                    self.assertIs(await proxy.open_request(CONF, path, body, observe), response)
                self.assertEqual(send.call_count, 2)
                retry = json.loads(send.call_args.args[2])
                field = "messages" if path == "/chat/completions" else "input"
                converted = retry[field][0]["content"][1]
                self.assertEqual(converted["type"], "text" if field == "messages" else "input_text")
                self.assertIn("red circle", converted["text"])
                self.assertEqual(retry["tools"], body["tools"], "tool schemas are not image input")
                self.assertIn(IMAGE, json.dumps(body), "history retains the original for later model switches")
                observe.assert_awaited_once()

    async def test_image_count_rejection_falls_back_once_when_provider_reports_a_limit(self):
        body = payload('/responses')
        body['input'][0]['content'].extend(
            {'type': 'input_image', 'image_url': IMAGE + str(index)} for index in range(5))
        observe = AsyncMock(side_effect=lambda images, _context: {
            'ok': True, 'imageCount': len(images), 'observation': {'summary': 'all pages'}})
        response = FakeResponse()
        error = rejection(400, 'This model supports up to 4 images per request')
        with patch.object(model_transport, 'open_response', side_effect=[error, response]) as send:
            self.assertIs(await proxy.open_request(CONF, '/responses', body, observe), response)
        self.assertEqual(send.call_count, 2)
        converted = json.loads(send.call_args.args[2])['input'][0]['content']
        self.assertTrue(all(item.get('type') == 'input_text' for item in converted[1:]))
        self.assertEqual(observe.await_count, 2)

    async def test_auth_transient_and_invalid_images_are_not_downgraded(self):
        errors = [rejection(status) for status in (401,403,429,500,502,504)]
        errors += [rejection(400,"Invalid image format"), rejection(400,"Image too large"),
                   rejection(400,"This image format is not supported"),
                   rejection(400,"Content must be a string")]
        for error in errors:
            with self.subTest(error=error.body):
                observe = AsyncMock()
                with patch.object(model_transport, "open_response", side_effect=error) as send:
                    with self.assertRaises(model_errors.UpstreamError):
                        await proxy.open_request(CONF,"/responses",payload("/responses"),observe)
                self.assertEqual(send.call_count,1)
                observe.assert_not_called()

    async def test_failed_vision_does_not_silently_discard_the_image(self):
        for result in ({"ok": False}, {"ok": True, "observation": {}, "imageCount": 0}):
            with patch.object(model_transport,"open_response",side_effect=rejection()) as send:
                with self.assertRaisesRegex(model_errors.UpstreamError,"原图已保留"):
                    await proxy.open_request(CONF,"/responses",payload("/responses"),AsyncMock(return_value=result))
                self.assertEqual(send.call_count,1)

    async def test_too_many_or_remote_images_do_not_get_partially_transcribed(self):
        for remote in (False,True):
            body=payload("/responses")
            content=body["input"][0]["content"]
            if remote:
                content[1]["image_url"]="https://example.invalid/private-image.png"
            else:
                content.extend({"type":"input_image","image_url":IMAGE+str(i)} for i in range(5))
            observe=AsyncMock()
            with patch.object(model_transport,"open_response",side_effect=rejection()) as send:
                with self.assertRaises(model_errors.UpstreamError):
                    await proxy.open_request(CONF,"/responses",body,observe)
            self.assertEqual(send.call_count,1)
            if remote:
                observe.assert_not_called()
            else:
                # More than four images are now processed in bounded batches;
                # a failed batch still prevents a partial upstream retry.
                self.assertEqual(observe.await_count, 2)

    async def test_vision_fallback_retries_with_all_image_batches(self):
        body = payload('/responses')
        content = body['input'][0]['content']
        content.extend({'type': 'input_image', 'image_url': IMAGE + str(i)} for i in range(5))
        async def observe(images, _context):
            return {'ok': True, 'model': 'vision', 'imageCount': len(images),
                    'observation': {'summary': 'batch-' + str(len(images))}}
        response = FakeResponse()
        with patch.object(model_transport, 'open_response', side_effect=[rejection(), response]) as send:
            got = await proxy.open_request(CONF, '/responses', body, observe)
        self.assertIs(got, response)
        self.assertEqual(send.call_count, 2)
        forwarded = json.loads(send.call_args.args[2])
        converted = forwarded['input'][0]['content']
        self.assertTrue(all(item.get('type') == 'input_text' for item in converted[1:]))
        self.assertIn('已分批完成 6 张图片', converted[1]['text'])

    async def test_text_requests_and_a_second_rejection_never_loop(self):
        with patch.object(model_transport,"open_response",side_effect=rejection()) as send:
            with self.assertRaises(model_errors.UpstreamError):
                await proxy.open_request(CONF,"/responses",{"input":"hello"},AsyncMock())
            self.assertEqual(send.call_count,1)
        with patch.object(model_transport,"open_response",side_effect=rejection()) as send:
            with self.assertRaises(model_errors.UpstreamError):
                await proxy.open_request(CONF,"/responses",payload("/responses"),
                    AsyncMock(return_value={"ok":True,"observation":{},"imageCount":1}))
            self.assertEqual(send.call_count,2)

    async def test_asgi_routes_pass_native_images_and_config_declares_the_transport_contract(self):
        from app.models import Client
        import httpx
        from fastapi import FastAPI
        from app.api import ai_proxy
        client = Client(id="isolated-client", user_ref="isolated-user", auth_version=1)
        app = FastAPI()
        app.include_router(ai_proxy.router)
        app.dependency_overrides[ai_proxy._client_by_bearer] = lambda: client
        app.dependency_overrides[ai_proxy.current_model_client] = lambda: client
        app.dependency_overrides[ai_proxy.get_session] = lambda: None
        conf = {**CONF,"kind":"openai-compat","model":"arbitrary-alias"}
        with patch.object(ai_proxy.model_catalog,"usable",AsyncMock(return_value=[{"name":"arbitrary-alias"}])), \
             patch.object(ai_proxy.model_catalog,"resolve",AsyncMock(return_value=conf)), \
             patch("app.deps.enforce_client_access",AsyncMock()), \
             patch("app.services.client_access.assert_quota",AsyncMock()) as admission, \
             patch.object(ai_proxy.device_auth,"issue_proxy_ticket",return_value=("fixture-proxy",60)), \
             patch.object(ai_proxy.device_auth,"issue_mcp_ticket",return_value=("fixture-mcp",60)), \
             patch.object(ai_proxy.vision_router,"analyze",AsyncMock()) as observe:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://fixture") as http:
                config = (await http.get("/api/v1/ai-proxy/config")).json()
                self.assertEqual(config["input"],["text", "image"])
                self.assertEqual(config["imageRouting"],"native")
                self.assertIs(config["visionFallbackAvailable"], False)
                admission.assert_awaited_once_with(None, "isolated-user",
                    policy_rows=None, provider=conf.get("provider", ""), model="arbitrary-alias", personal=False)
                for route in ("/chat/completions","/responses"):
                    for streaming in (True,False):
                        body=payload(route)
                        body["stream"]=streaming
                        raw=b'data: [DONE]\n\n' if streaming else b'{"ok":true}'
                        with patch.object(model_transport,"open_response",return_value=FakeResponse(raw)) as send:
                            reply=await http.post("/api/v1/ai-proxy/v1"+route,json=body)
                        self.assertEqual(reply.status_code,200,reply.text)
                        # streamed replies start with the open-phase keepalive comment
                        expected=(b': soduwork-keepalive\n\n'+raw) if streaming else raw
                        self.assertEqual(reply.content,expected)
                        self.assertEqual(json.loads(send.call_args.args[2]),body)
                observe.assert_not_called()

    async def test_asgi_non_native_images_without_adapter_return_actionable_errors(self):
        from types import SimpleNamespace
        import httpx
        from fastapi import FastAPI
        from app.api import ai_proxy
        app = FastAPI()
        app.include_router(ai_proxy.router)
        app.dependency_overrides[ai_proxy._client_by_bearer] = lambda: SimpleNamespace(id="isolated-client")
        app.dependency_overrides[ai_proxy.get_session] = lambda: None
        conf = {**CONF, "kind": "openai-compat", "model": "arbitrary-alias", "imageRouting": "vision-fallback"}
        with patch.object(ai_proxy.model_catalog, "resolve", AsyncMock(return_value=conf)), \
             patch.object(ai_proxy.model_catalog, "usable", AsyncMock(return_value=[{"name": "arbitrary-alias"}])), \
             patch.object(proxy, "adapter_configured", return_value=False), \
             patch.object(model_transport, "open_response") as send, \
             patch.object(ai_proxy.vision_router, "analyze", AsyncMock()) as observe:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as http:
                for route in ("/chat/completions", "/responses"):
                    for streaming in (False, True):
                        body = payload(route)
                        body["stream"] = streaming
                        reply = await http.post("/api/v1/ai-proxy/v1" + route, json=body)
                        self.assertEqual(reply.status_code, 200 if streaming else 400, reply.text)
                        self.assertIn("原图已保留", reply.text)
                        self.assertIn("未自动更换模型", reply.text)
                        self.assertNotIn("503", reply.text)
            send.assert_not_called()
            observe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
