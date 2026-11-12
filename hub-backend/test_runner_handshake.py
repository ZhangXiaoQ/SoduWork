"""Runner handshake isolation regressions with fake connections and no backend, device
configuration, or real tasks.
"""
import asyncio
import contextvars
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import runner_main
from app.api import runner_ws as runner_ws_api
from app.services import pty_term


class Wire:
    def __init__(self, messages=(), send_error=None):
        self.messages = list(messages)
        self.sent = []
        self.send_error = send_error
        self.closed = False

    async def send(self, payload):
        if self.send_error:
            raise self.send_error
        self.sent.append(json.loads(payload))

    async def recv(self):
        if self.messages:
            return self.messages.pop(0)
        await asyncio.Future()


class RunnerHandshakeTests(unittest.IsolatedAsyncioTestCase):
    def machine(self, wire):
        machine = runner_main.Runner.__new__(runner_main.Runner)
        machine.ws = wire
        machine.id = "fixture-runner"
        machine.client_id = "fixture-device"
        machine.boot_id = "fixture-boot"
        machine.work_root = ""
        machine.capability_grants = []
        machine.tags = []
        machine._agent_inventory = []
        machine._agent_inventory_at = 0
        machine._skill_inventory = []
        machine._skill_catalog = []
        machine._admission_report = lambda **_: {}
        machine._send_target = contextvars.ContextVar("fixture-target", default=None)
        machine._send_lock = asyncio.Lock()
        machine.bin = False
        return machine

    async def asyncSetUp(self):
        self.deadline = patch.object(runner_main, "HELLO_TIMEOUT_S", 0.02, create=True)
        self.capabilities = patch.object(
            runner_main, "_capabilities",
            side_effect=AssertionError("hello must not probe local capabilities"))
        self.platform = patch.object(runner_main.platform, "platform", return_value="fixture-os")
        self.deadline.start()
        self.capabilities.start()
        self.platform.start()
        self.addCleanup(self.deadline.stop)
        self.addCleanup(self.capabilities.stop)
        self.addCleanup(self.platform.stop)

    async def test_missing_welcome_fails_with_bounded_handshake_error(self):
        machine = self.machine(Wire())
        try:
            await asyncio.wait_for(machine._hello(), timeout=0.5)
        except TimeoutError as error:
            self.assertIn("握手", str(error))
        else:
            self.fail("未收到 welcome 不能完成握手")
        self.assertFalse(machine.bin)

    async def test_hello_send_failure_is_not_swallowed(self):
        machine = self.machine(Wire(send_error=ConnectionError("fixture send failed")))
        with self.assertRaisesRegex(ConnectionError, "fixture send failed"):
            await asyncio.wait_for(machine._hello(), timeout=0.5)

    async def test_welcome_preserves_early_commands_and_inventory_state(self):
        command = {"op": "job.status", "id": "fixture-job"}
        wire = Wire([json.dumps(command), '{"op":"welcome","caps":["bin1"]}'])
        machine = self.machine(wire)
        self.assertEqual(await machine._hello(), [command])
        self.assertTrue(machine.bin)
        self.assertFalse(wire.sent[0]["inventoryReady"])
        self.assertEqual(wire.sent[0]["clientId"], "fixture-device")

    async def test_selection_capability_survives_real_hello_and_cluster_refresh(self):
        from app.services.runner_hub import _Runner
        from app.services.cluster_runtime import RemoteRunner
        wire = Wire(['{"op":"welcome","caps":["bin1"]}'])
        await self.machine(wire)._hello()
        registered = _Runner(None, wire.sent[0])
        self.assertIn("executionSelection1", registered.caps)
        report = {**registered.api(), "clusterToken": "fixture-token"}
        proxy = RemoteRunner("fixture-node", report)
        proxy.update(report)
        self.assertEqual(proxy.caps, registered.caps)
        self.assertIn("executionSelection1", proxy.caps)

    async def test_explicit_rejection_stays_an_error(self):
        machine = self.machine(Wire(['{"op":"bye","error":"fixture revoked"}']))
        with self.assertRaisesRegex(ConnectionError, "fixture revoked"):
            await machine._hello()
        self.assertFalse(machine.bin)

    async def test_desktop_plugin_admission_survives_hello_and_cluster_refresh(self):
        from app.services.runner_hub import _Runner
        from app.services.cluster_runtime import RemoteRunner
        wire = Wire(['{"op":"welcome","caps":["bin1"]}'])
        machine = self.machine(wire)
        machine.desktop_owned = True
        machine._admission = SimpleNamespace(_journal=object())
        await machine._hello()
        advertised = wire.sent[0]["caps"]
        self.assertIn("desktopPluginTurn1", advertised)
        self.assertIn("admit1", advertised)
        registered = _Runner(None, wire.sent[0])
        self.assertEqual(registered.caps, advertised)
        report = {**registered.api(), "clusterToken": "fixture-token"}
        proxy = RemoteRunner("fixture-node", report)
        proxy.update(report)
        self.assertEqual(proxy.caps, advertised)

    def test_protocol_caps_remain_bounded_and_reject_malformed_entries(self):
        from app.services.runner_hub import clean_protocol_caps
        self.assertEqual(clean_protocol_caps(None), [])
        self.assertEqual(clean_protocol_caps([None, 1, "", "x" * 65, "admit1", "admit1"]), ["admit1"])
        self.assertEqual(len(clean_protocol_caps([f"cap{i}" for i in range(1000)])), 32)

    async def test_timeout_closes_connection_and_retries_same_identity_before_reporting(self):
        wires = [Wire(), Wire(['{"op":"welcome","caps":["bin1"]}'])]
        connections = []
        reported = []
        machine = self.machine(None)
        machine.url = "ws://fixture.invalid/api/v1/runner"
        machine.secret = "fixture-secret-only-memory"
        machine.key = machine.token = ""
        machine._shutdown_event = asyncio.Event()
        machine._ensure_admission_loop = lambda: None

        async def idle():
            await asyncio.Future()

        async def report():
            reported.append(machine.ws)

        async def pump(_):
            await asyncio.sleep(0)
            machine._shutdown_event.set()

        class Connection:
            def __init__(self, wire):
                self.wire = wire

            async def __aenter__(self):
                return self.wire

            async def __aexit__(self, *_):
                self.wire.closed = True

        def connect(url, **kwargs):
            connections.append((url, dict(kwargs["additional_headers"])))
            return Connection(wires[len(connections) - 1])

        machine._local_rpc_loop = idle
        machine._report_beat = report
        machine._beat = machine._push_loop = idle
        machine._pump = pump
        try:
            with patch.object(runner_main.websockets, "connect", connect), \
                    patch.object(runner_main, "RETRY_S", 0.01), \
                    patch.object(pty_term, "sweep_loop", idle):
                try:
                    await asyncio.wait_for(machine.run(), timeout=0.7)
                except TimeoutError:
                    self.fail("握手停滞后没有关闭连接并重试")
        finally:
            background = [job for job in (getattr(machine, "_term_sweep", None),
                                          getattr(machine, "_local_rpc_task", None)) if job]
            for job in background:
                job.cancel()
            await asyncio.gather(*background, return_exceptions=True)
        self.assertEqual(len(connections), 2)
        self.assertEqual(connections[0], connections[1])
        self.assertTrue(all(wire.closed for wire in wires))
        self.assertEqual(reported, [wires[1]])
        self.assertIsNone(machine.ws)

    async def test_cancel_is_propagated_without_claiming_online(self):
        machine = self.machine(Wire())
        pending = asyncio.create_task(machine._hello())
        await asyncio.sleep(0)
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertFalse(machine.bin)

    async def assert_recovery_failure_is_reported(self, error, code):
        wire = Wire(['{"op":"bye","code":"RUNNER_IDENTITY_CONFLICT"}'])
        machine = self.machine(None)
        machine.url = "ws://fixture.invalid/api/v1/runner"
        machine.secret = "fixture-secret-only-memory"
        machine.key = machine.token = ""
        machine.desktop_owned = True
        machine.desktop_identity_scope = ("fixture-root", "https://fixture.invalid",
                                          "fixture-device", "fixture-runner")
        machine._shutdown_event = asyncio.Event()
        machine._ensure_admission_loop = lambda: None

        async def idle():
            await asyncio.Future()

        class Connection:
            async def __aenter__(self):
                return wire

            async def __aexit__(self, *_):
                wire.closed = True

        machine._local_rpc_loop = idle
        try:
            with patch.object(runner_main.websockets, "connect", return_value=Connection()), \
                    patch("app.services.runner_desktop_identity.select", side_effect=error), \
                    patch.object(runner_main.runner_connection_status, "report") as status, \
                    patch.object(pty_term, "sweep_loop", idle):
                with self.assertRaises(type(error)):
                    await asyncio.wait_for(machine.run(), timeout=0.5)
                self.assertEqual(status.call_args.args, (machine, "error", code))
                self.assertFalse(any(call.args[1] == "online" for call in status.call_args_list))
        finally:
            background = [job for job in (getattr(machine, "_term_sweep", None),
                                          getattr(machine, "_local_rpc_task", None)) if job]
            for job in background:
                job.cancel()
            await asyncio.gather(*background, return_exceptions=True)
        self.assertTrue(wire.closed)

    async def test_unwritable_identity_storage_reports_actionable_failure(self):
        await self.assert_recovery_failure_is_reported(
            PermissionError("fixture write denied"), "IDENTITY_STORAGE_FAILED")

    async def test_rejected_recovered_identity_reports_actionable_failure(self):
        await self.assert_recovery_failure_is_reported(
            ValueError("fixture identity rejected again"), "IDENTITY_RECOVERY_FAILED")

    async def test_too_many_early_commands_are_rejected(self):
        machine = self.machine(Wire(['{"op":"job.status"}'] * 101))
        with self.assertRaisesRegex(ConnectionError, "过多"):
            await machine._hello()
        self.assertFalse(machine.bin)

    async def test_stalled_hello_send_has_the_same_deadline(self):
        class StalledSend(Wire):
            async def send(self, _):
                await asyncio.Future()

        machine = self.machine(StalledSend())
        with self.assertRaisesRegex(TimeoutError, "握手"):
            await asyncio.wait_for(machine._hello(), timeout=0.5)
        self.assertFalse(machine.bin)


class HubHelloDeadlineTests(unittest.IsolatedAsyncioTestCase):
    async def test_authenticated_silent_peer_is_closed_with_hello_timeout_code(self):
        class SilentSocket:
            def __init__(self):
                self.closed = []

            async def receive_json(self):
                await asyncio.Future()

            async def close(self, code):
                self.closed.append(code)

        socket = SilentSocket()
        hello = await runner_ws_api._receive_hello(socket, "fixture-peer", timeout=0.01)
        self.assertIsNone(hello)
        self.assertEqual(socket.closed, [4408])

    async def test_legacy_runner_capability_scan_fits_compatibility_window(self):
        self.assertGreaterEqual(runner_ws_api._HELLO_TIMEOUT_S, 30)

        class SlowLegacySocket:
            def __init__(self):
                self.closed = []

            async def receive_json(self):
                await asyncio.sleep(0.02)
                return {"op": "hello", "capabilities": {"reportedAt": 1}}

            async def close(self, code):
                self.closed.append(code)

        socket = SlowLegacySocket()
        hello = await runner_ws_api._receive_hello(
            socket, "legacy-runner", timeout=0.1)
        self.assertEqual(hello["op"], "hello")
        self.assertEqual(socket.closed, [])


if __name__ == "__main__":
    unittest.main()
