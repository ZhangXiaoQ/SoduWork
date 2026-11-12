"""Configuration and packet security tests do not need Redis or a database."""
import os
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""
import unittest
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from cryptography.exceptions import InvalidTag
from app.config import Settings
from app.services.cluster_bus import ClusterBus, ClusterUnavailable, PacketCodec


class BroadcastTests(unittest.IsolatedAsyncioTestCase):
    async def test_durable_broadcast_reports_partial_failure_after_attempting_all_nodes(self):
        bus = ClusterBus(ConfigTests().settings())
        bus.node = "local"
        bus.redis = SimpleNamespace(zrangebyscore=AsyncMock(return_value=[b"local", b"healthy", b"full"]))
        async def send(node, _packet):
            if node == "full":
                raise ClusterUnavailable("test inbox full")
        bus.send = AsyncMock(side_effect=send)
        with self.assertLogs("uvicorn.error", level="WARNING"):
            await bus.broadcast({"kind": "publish"})  # Existing best-effort callers retain their contract.
        self.assertEqual({c.args[0] for c in bus.send.await_args_list}, {"healthy", "full"})
        bus.send.reset_mock()
        with self.assertLogs("uvicorn.error", level="WARNING"):
            with self.assertRaises(ClusterUnavailable):
                await bus.broadcast({"kind": "publish"}, strict=True)
        self.assertEqual({c.args[0] for c in bus.send.await_args_list}, {"healthy", "full"})


class TerminalRelayTests(unittest.IsolatedAsyncioTestCase):
    async def test_overflow_jobs_are_owned_and_joined_before_transport_shutdown(self):
        from app.services import cluster_runtime as runtime
        queue = asyncio.Queue(maxsize=1)
        queue.put_nowait(("node", {"kind": "terminal"}))
        blocked = asyncio.Event()
        entered, cancelled = [], []
        async def send(_node, packet):
            entered.append(packet["event"]["task"])
            try:
                await blocked.wait()
            finally:
                cancelled.append(packet["event"]["task"])
        async def stopped():
            self.assertEqual(len(cancelled), 100)
            self.assertFalse(runtime._RELAY_CLOSE_JOBS)
        runner = SimpleNamespace(id="runner", cluster_token="test-token", term_subs={str(i): None for i in range(100)})
        with patch.object(runtime, "_STOPPING", False), patch.object(runtime, "_RELAY", queue), patch.object(runtime.bus, "send", side_effect=send), \
                patch.object(runtime.bus, "stop", side_effect=stopped):
            for i in range(100):
                runtime._relay("node", runner, str(i), b"private terminal bytes")
            for _ in range(1000):
                runtime._relay("node", runner, "0", b"late bytes")
            self.assertEqual(len(runtime._RELAY_CLOSE_JOBS), 100)
            await asyncio.sleep(0)
            self.assertEqual(len(entered), 100)
            self.assertFalse(runner.term_subs)
            await runtime.stop()
            runner.term_subs["late"] = None
            runtime._relay("node", runner, "late", b"shutdown bytes")
            self.assertFalse(runtime._RELAY_CLOSE_JOBS)
            await asyncio.wait_for(queue.join(), 1)
            self.assertTrue(queue.empty())

    async def test_overflow_failure_is_observed_and_recovery_errors_do_not_escape(self):
        from app.services import cluster_runtime as runtime
        queue = asyncio.Queue(maxsize=1)
        queue.put_nowait(("node", {}))
        runner = SimpleNamespace(id="runner", cluster_token="test-token", term_subs={"task": None})
        with patch.object(runtime, "_STOPPING", False), patch.object(runtime, "_RELAY", queue), \
                patch.object(runtime.bus, "send", side_effect=RuntimeError("private transport content")), \
                patch.object(runtime, "on_failure", side_effect=RuntimeError("private recovery content")) as recovery:
            with self.assertLogs("uvicorn.error", level="WARNING") as captured:
                runtime._relay("node", runner, "task", b"private terminal bytes")
                await asyncio.gather(*runtime._RELAY_CLOSE_JOBS)
                await asyncio.sleep(0)
            self.assertFalse(runtime._RELAY_CLOSE_JOBS)
            recovery.assert_awaited_once()
            self.assertTrue(all("private" not in line for line in captured.output))


class PacketTests(unittest.TestCase):
    def setUp(self):
        self.codec = PacketCodec("test-signing-secret", "isolated")

    def test_encrypted_binary_roundtrip(self):
        value = {"content": b"\x00\xffraw bytes", "text": "进展", "credential": "test-secret"}
        packet = self.codec.encode(value)
        self.assertNotIn(b"test-secret", packet)
        self.assertNotIn(b"raw bytes", packet)
        self.assertEqual(value, self.codec.decode(packet))
        self.assertNotEqual(packet, self.codec.encode(value))
        literal = {"nested": [{"$soduworkBytes": "not-a-binary-field"}, b"real"]}
        self.assertEqual(literal, self.codec.decode(self.codec.encode(literal)))

    def test_tampering_rejected(self):
        packet = bytearray(self.codec.encode({"ok": True}))
        packet[-1] ^= 1
        with self.assertRaises(InvalidTag):
            self.codec.decode(bytes(packet))

    def test_other_deployment_cannot_decode(self):
        packet = self.codec.encode({"ok": True})
        with self.assertRaises(InvalidTag):
            PacketCodec("test-signing-secret", "other").decode(packet)
        with self.assertRaises(InvalidTag):
            PacketCodec("other-secret", "isolated").decode(packet)

    def test_large_packet_rejected(self):
        with self.assertRaises(ValueError):
            self.codec.encode({"text": "x" * (16 * 1024 * 1024)})
        with self.assertRaises(ValueError):
            self.codec.decode(b"x" * (16 * 1024 * 1024 + 29))


class ConfigTests(unittest.TestCase):
    def settings(self, **changes):
        values = dict(_env_file=None, database_url="postgresql+asyncpg://test@localhost/test",
                      cluster_redis_url="redis://127.0.0.1:16389",
                      db_migration_mode="check", cluster_shared_files=True)
        values.update(changes)
        return Settings(**values)

    def test_good_configuration(self):
        ClusterBus(self.settings()).validate()

    def test_unsafe_cluster_configurations(self):
        for invalid in (
            {"database_url": "sqlite+aiosqlite:///:memory:"},
            {"db_migration_mode": "auto"},
            {"cluster_shared_files": False},
            {"cluster_namespace": "tenant:*"},
            {"db_pool_size": 1},
            {"cluster_refresh_seconds": 10, "cluster_lease_seconds": 10},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                ClusterBus(self.settings(**invalid)).validate()

    def test_single_instance_needs_no_broker(self):
        bus = ClusterBus(self.settings(cluster_redis_url=""))
        self.assertFalse(bus.enabled)
        self.assertTrue(bus.healthy)

    def test_pool_limits_validated(self):
        for invalid in ({"db_pool_size": 0}, {"db_max_overflow": -1},
                        {"db_pool_timeout": 0}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.settings(**invalid)


if __name__ == "__main__":
    unittest.main()
