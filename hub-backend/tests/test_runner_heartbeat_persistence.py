"""Regression coverage for isolated Runner heartbeat persistence failures."""

import asyncio
import json
import time
import unittest
from contextlib import asynccontextmanager, ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.api import runner_ws
from app.services import runner_registry
from app.services.runner_identity_error import RunnerIdentityConflict


def _session_factory(session):
    @asynccontextmanager
    async def factory():
        yield session

    return factory


def _due_write() -> float:
    return time.time() - runner_registry.PERSIST_EVERY_S - 1


class RunnerHeartbeatPersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_record_failure_keeps_connection_path_alive_and_retries(self):
        runner = SimpleNamespace(id="runner-record", _registry_write=_due_write())
        previous_write = runner._registry_write
        attempts = 0

        async def record(_session, target):
            nonlocal attempts
            attempts += 1
            target._registry_write = time.time()
            if attempts == 1:
                raise RuntimeError("record unavailable")

        session = SimpleNamespace(commit=AsyncMock())
        with patch.object(runner_ws, "SessionLocal", _session_factory(session)), \
             patch.object(runner_ws.runner_registry, "record", record), \
             patch.object(runner_ws.log, "warning"):
            self.assertFalse(await runner_ws._persist_runner_heartbeat(runner))
            self.assertEqual(runner._registry_write, previous_write)
            self.assertGreaterEqual(
                time.time() - runner._registry_write,
                runner_registry.PERSIST_EVERY_S,
            )

            self.assertTrue(await runner_ws._persist_runner_heartbeat(runner))

        self.assertEqual(attempts, 2)
        session.commit.assert_awaited_once()

    async def test_commit_failure_restores_throttle_and_retries_immediately(self):
        runner = SimpleNamespace(id="runner-commit", _registry_write=_due_write())
        previous_write = runner._registry_write
        record = AsyncMock(side_effect=lambda _session, target: setattr(
            target, "_registry_write", time.time()))
        session = SimpleNamespace(commit=AsyncMock(
            side_effect=[RuntimeError("commit unavailable"), None]))

        with patch.object(runner_ws, "SessionLocal", _session_factory(session)), \
             patch.object(runner_ws.runner_registry, "record", record), \
             patch.object(runner_ws.log, "warning"):
            self.assertFalse(await runner_ws._persist_runner_heartbeat(runner))
            self.assertEqual(runner._registry_write, previous_write)
            self.assertGreaterEqual(
                time.time() - runner._registry_write,
                runner_registry.PERSIST_EVERY_S,
            )

            self.assertTrue(await runner_ws._persist_runner_heartbeat(runner))

        self.assertEqual(record.await_count, 2)
        self.assertEqual(session.commit.await_count, 2)
        self.assertGreater(runner._registry_write, previous_write)

    async def test_session_exit_failure_restores_throttle_and_retries_immediately(self):
        runner = SimpleNamespace(id="runner-exit", _registry_write=_due_write())
        previous_write = runner._registry_write
        record = AsyncMock(side_effect=lambda _session, target: setattr(
            target, "_registry_write", time.time()))
        session = SimpleNamespace(commit=AsyncMock())
        exits = 0

        @asynccontextmanager
        async def factory():
            nonlocal exits
            yield session
            exits += 1
            if exits == 1:
                raise RuntimeError("session cleanup unavailable")

        with patch.object(runner_ws, "SessionLocal", factory), \
             patch.object(runner_ws.runner_registry, "record", record), \
             patch.object(runner_ws.log, "warning"):
            self.assertFalse(await runner_ws._persist_runner_heartbeat(runner))
            self.assertEqual(runner._registry_write, previous_write)
            self.assertGreaterEqual(
                time.time() - runner._registry_write,
                runner_registry.PERSIST_EVERY_S,
            )
            self.assertTrue(await runner_ws._persist_runner_heartbeat(runner))

        self.assertEqual(exits, 2)
        self.assertEqual(record.await_count, 2)
        self.assertEqual(session.commit.await_count, 2)
        self.assertGreater(runner._registry_write, previous_write)

    async def test_first_capability_report_bypasses_recent_hello_write(self):
        runner = SimpleNamespace(
            id="runner-capability",
            _registry_write=time.time(),
            capabilities={"reportedAt": 0},
        )
        report = {
            "schemaVersion": 3,
            "reportedAt": int(time.time()),
            "available": ["terminal"],
            "items": [],
        }
        force = runner_ws._update_runner_capabilities(
            runner, report, persisted=False)
        self.assertTrue(force)

        calls = []

        async def record(_session, target, *, force=False):
            calls.append(force)
            target._registry_write = time.time()

        session = SimpleNamespace(commit=AsyncMock())
        with patch.object(runner_ws, "SessionLocal", _session_factory(session)), \
             patch.object(runner_ws.runner_registry, "record", record):
            self.assertTrue(await runner_ws._persist_runner_heartbeat(
                runner, force=force))

        self.assertEqual(calls, [True])
        session.commit.assert_awaited_once()
        self.assertFalse(runner_ws._update_runner_capabilities(
            runner, report, persisted=True))

    async def test_identity_and_lifecycle_rejections_still_propagate(self):
        for rejection in (RunnerIdentityConflict(), ValueError("runner retired")):
            with self.subTest(rejection=type(rejection).__name__):
                runner = SimpleNamespace(id="runner-rejected", _registry_write=_due_write())
                previous_write = runner._registry_write

                async def reject(_session, target, rejection=rejection):
                    target._registry_write = time.time()
                    raise rejection

                session = SimpleNamespace(commit=AsyncMock())
                with patch.object(runner_ws, "SessionLocal", _session_factory(session)), \
                     patch.object(runner_ws.runner_registry, "record", reject):
                    with self.assertRaises(type(rejection)):
                        await runner_ws._persist_runner_heartbeat(runner)

                self.assertEqual(runner._registry_write, previous_write)
                session.commit.assert_not_awaited()

    async def test_background_identity_and_lifecycle_rejections_close_the_socket(self):
        for rejection, code in ((RunnerIdentityConflict(), 4409),
                                (ValueError("runner retired"), 1011)):
            with self.subTest(rejection=type(rejection).__name__):
                socket = SimpleNamespace(send_json=AsyncMock(), close=AsyncMock())
                with patch.object(runner_ws, "_persist_runner_heartbeat",
                                  AsyncMock(side_effect=rejection)):
                    self.assertFalse(await runner_ws._heartbeat_write(
                        SimpleNamespace(id="rejected"), socket, force=True))
                self.assertEqual(socket.close.call_args.kwargs["code"], code)
                if code == 4409:
                    self.assertEqual(socket.send_json.call_args.args[0]["code"],
                                     RunnerIdentityConflict.code)

    async def test_waiting_heartbeat_write_does_not_block_content_reply_or_duplicate_writes(self):
        from app.services import runner_hub, cluster_runtime

        write_started, write_cancelled = asyncio.Event(), asyncio.Event()
        incoming = asyncio.Queue()
        resolved = asyncio.get_running_loop().create_future()
        report = {"schemaVersion": 3, "reportedAt": int(time.time()), "items": []}

        class Socket:
            client = SimpleNamespace(host="127.0.0.1")
            headers = {}
            accept = AsyncMock()
            send_json = AsyncMock()
            close = AsyncMock()

            async def receive_json(self):
                return {"op": "hello", "runnerId": "heartbeat-reader"}

            async def receive(self):
                return await incoming.get()

        socket = Socket()
        runner = runner_hub._Runner(socket, {"runnerId": "heartbeat-reader"})
        runner._waiters["history-read"] = resolved
        runner._registry_write = _due_write()
        runner.send = AsyncMock()
        session = SimpleNamespace(commit=AsyncMock())

        async def blocked_write(*args, **kwargs):
            write_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                write_cancelled.set()

        with ExitStack() as stack:
            for target, name, replacement in (
                (runner_ws, "SessionLocal", _session_factory(session)),
                (runner_ws, "_auth", AsyncMock(return_value=(True, ""))),
                (runner_ws, "authenticated_identity", AsyncMock(return_value=True)),
                (runner_hub, "add", lambda *args: runner),
                (runner_registry, "record", AsyncMock()),
                (cluster_runtime, "register", AsyncMock()),
                (runner_ws, "_reconcile_runner_restart", AsyncMock()),
                (runner_ws, "_drop_runner", AsyncMock()),
            ):
                stack.enter_context(patch.object(target, name, replacement))
            persist = stack.enter_context(patch.object(runner_ws, "_persist_runner_heartbeat",
                                                       AsyncMock(side_effect=blocked_write)))
            handler = asyncio.create_task(runner_ws.runner_ws(socket))
            try:
                await incoming.put({"text": json.dumps({"op": "beat", "capabilities": report})})
                await asyncio.wait_for(write_started.wait(), 1)
                await incoming.put({"text": json.dumps({"op": "beat", "busy": 2, "capabilities": report})})
                await incoming.put({"text": json.dumps({"op": "reply", "id": "history-read",
                                                       "ok": True, "data": {"history": "ready"}})})
                reply = await asyncio.wait_for(asyncio.shield(resolved), 1)
                self.assertTrue(reply["ok"])
                self.assertEqual(runner.busy, 2)
                self.assertEqual(persist.await_count, 1)
                self.assertTrue(persist.call_args.kwargs["force"])
                self.assertFalse(write_cancelled.is_set())
                await incoming.put({"type": "websocket.disconnect"})
                await asyncio.wait_for(handler, 1)
                self.assertTrue(write_cancelled.is_set())
            finally:
                handler.cancel()
                await asyncio.gather(handler, return_exceptions=True)
                if not resolved.done():
                    resolved.cancel()


if __name__ == "__main__":
    unittest.main()
