"""Endpoint persistence, interrupted transfer and wrong-owner regression tests."""
import asyncio
import base64
import hashlib
import tempfile
import sqlite3
import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from unittest.mock import patch

from app.services.runner_content_store import Store, CHUNK
from app.services import conversation_content as content


class EndpointContentTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="soduwork-content-")
        self.addCleanup(self.directory.cleanup)
        self.store = Store(self.directory.name)
        self.scope = content.scope("owner-a", "record-a")

    def packet(self, data, offset=0):
        return {"op": "content.put", "scope": self.scope,
                "sha256": hashlib.sha256(data).hexdigest(), "size": len(data),
                "offset": offset, "b64": base64.b64encode(data[offset:offset + CHUNK]).decode()}

    def test_gap_and_restart_never_acknowledge_an_incomplete_object(self):
        data = b"x" * (CHUNK * 2 + 7)
        packet = self.packet(data)
        self.store.handle(packet)
        self.store.handle(self.packet(data, CHUNK * 2))
        seal = {**packet, "op": "content.seal"}
        with self.assertRaisesRegex(ValueError, "gap"):
            self.store.handle(seal)
        reopened = Store(self.directory.name)
        with self.assertRaisesRegex(ValueError, "durably"):
            reopened.handle({**packet, "op": "content.read"})
        reopened.handle(self.packet(data, CHUNK))
        self.assertTrue(reopened.handle(seal)["data"]["durable"])
        self.assertEqual(reopened.handle(seal)["data"]["sha256"], packet["sha256"])

    def test_retry_wrong_content_wrong_owner_and_quota_are_fenced(self):
        packet = self.packet(b"first")
        self.store.handle(packet)
        self.store.handle(packet)
        with self.assertRaisesRegex(ValueError, "changed"):
            self.store.handle({**packet, "b64": base64.b64encode(b"other").decode()})
        self.store.handle({**packet, "op": "content.seal"})
        with self.assertRaisesRegex(ValueError, "durably"):
            self.store.handle({**packet, "op": "content.read", "scope": content.scope("owner-b", "record-a")})
        constrained = Store(self.directory.name, quota=5)
        with self.assertRaisesRegex(ValueError, "quota"):
            constrained.handle(self.packet(b"second"))

    def test_operator_capacity_increase_preserves_sealed_history_and_rejects_invalid_limits(self):
        packet = self.packet(b"retained")
        self.store.handle(packet)
        self.store.handle({**packet, "op": "content.seal"})
        with patch.dict(os.environ, {"SODUWORK_CONVERSATION_CONTENT_QUOTA_MIB": "8192"}):
            reopened = Store(self.directory.name)
            self.assertEqual(reopened.quota, 8 * 1024 ** 3)
            self.assertEqual(reopened.handle({**packet, "op": "content.read"})["data"]["sha256"], packet["sha256"])
        for value in ("0", "unlimited", "-1", "16777217"):
            with patch.dict(os.environ, {"SODUWORK_CONVERSATION_CONTENT_QUOTA_MIB": value}):
                with self.assertRaisesRegex(ValueError, "QUOTA_MIB"):
                    Store(self.directory.name)

    def test_checksum_and_bounded_inputs(self):
        packet = {**self.packet(b"first"), "sha256": "0" * 64}
        self.store.handle(packet)
        with self.assertRaisesRegex(ValueError, "checksum"):
            self.store.handle({**packet, "op": "content.seal"})
        for update in ({"scope": "../escape"}, {"offset": -1}, {"offset": True}, {"size": 129 * 1024 * 1024}, {"b64": "x" * (CHUNK * 2)}):
            with self.assertRaises(ValueError):
                self.store.handle({**packet, **update})

    def test_concurrent_duplicate_chunk_writes_are_idempotent(self):
        packet = self.packet(b"x" * CHUNK)
        with ThreadPoolExecutor(max_workers=16) as workers:
            replies = list(workers.map(self.store.handle, [packet] * 128))
        self.assertTrue(all(reply["ok"] for reply in replies))
        self.assertTrue(self.store.handle({**packet, "op": "content.seal"})["data"]["durable"])

    def test_old_engine_uses_durable_rollback_journal_for_independent_store_instances(self):
        with patch.object(sqlite3, "sqlite_version_info", (3, 49, 1)):
            stores = [Store(self.directory.name) for _ in range(4)]
        with closing(sqlite3.connect(self.store.file)) as connection:
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "delete")
        packets = [self.packet((str(index) + "-isolated").encode() * 2000) for index in range(40)]
        def write(index):
            store = stores[index % len(stores)]
            packet = packets[index]
            store.handle(packet)
            return store.handle({**packet, "op": "content.seal"})
        with ThreadPoolExecutor(max_workers=8) as workers:
            replies = list(workers.map(write, range(len(packets))))
        self.assertTrue(all(reply["data"]["durable"] for reply in replies))
        with patch.object(sqlite3, "sqlite_version_info", (3, 49, 1)):
            reopened = Store(self.directory.name)
        for packet in packets:
            saved = reopened.handle({**packet, "op": "content.read"})["data"]
            self.assertEqual(saved["b64"], packet["b64"])
        with closing(sqlite3.connect(self.store.file)) as connection:
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_patched_engine_uses_wal_without_rewriting_sealed_content(self):
        packet = self.packet(b"retained across journal upgrade")
        self.store.handle(packet)
        self.store.handle({**packet, "op": "content.seal"})
        for version in ((3, 44, 6), (3, 50, 7), (3, 51, 3), (3, 52, 0)):
            with patch.object(sqlite3, "sqlite_version_info", version):
                reopened = Store(self.directory.name)
            self.assertEqual(reopened.handle({**packet, "op": "content.read"})["data"]["b64"], packet["b64"])
            with closing(sqlite3.connect(self.store.file)) as connection:
                self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")

    def test_newer_store_schema_is_rejected_without_modifying_or_deleting_content(self):
        packet = self.packet(b"retained after downgrade attempt")
        self.store.handle(packet)
        self.store.handle({**packet, "op": "content.seal"})
        with closing(sqlite3.connect(self.store.file)) as connection:
            connection.execute("PRAGMA user_version=99")
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            Store(self.directory.name)
        with closing(sqlite3.connect(self.store.file)) as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 99)
            self.assertEqual(connection.execute("SELECT sealed FROM objects").fetchone()[0], 1)

    def test_transport_roundtrip_restart_and_scope_validation(self):
        store = self.store
        class Runner:
            caps = ["conversationContent1"]
            def alive(self):
                return True
            async def call(self, op, body, timeout):
                return await asyncio.to_thread(store.handle, {**body, "op": op})
        async def run():
            value = {"messages": ["private message" * 100000]}
            with patch.object(content.runner_hub, "get", return_value=Runner()):
                pointer = await content.put_json("runner-a", "owner-a", "record-a", value)
                self.assertNotIn("private", str(pointer))
                self.assertEqual(await content.get_json(pointer, "owner-a", "record-a"), value)
                from fastapi import HTTPException
                with self.assertRaises(HTTPException) as denied:
                    await content.get_json(pointer, "owner-b", "record-a")
                self.assertEqual(denied.exception.status_code, 409)
        asyncio.run(run())

    def test_migration_retry_checks_a_seal_without_retransmitting_complete_pages(self):
        calls, store = [], self.store
        class Runner:
            caps = ["conversationContent1"]
            def alive(self):
                return True
            async def call(self, op, body, timeout):
                calls.append(op)
                return await asyncio.to_thread(store.handle, {**body, "op": op})
        async def run():
            value = {"messages": ["retained"]}
            with patch.object(content.runner_hub, "get", return_value=Runner()):
                first = await content.put_json("runner", "owner", "record", value, resume=True)
                self.assertIn("content.put", calls)
                calls.clear()
                retry = await content.put_json("runner", "owner", "record", value, resume=True)
                self.assertEqual(retry, first)
                self.assertEqual(calls, ["content.status"])
                self.assertEqual(await content.get_json(retry, "owner", "record"), value)
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
