"""Real content storage, transport authorization and Hub transaction boundaries."""
import asyncio
import base64
import hashlib
import os
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "isolated-endpoint-rpc-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-endpoint-rpc-password")

from sqlalchemy import update
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from app import db, models
from app.automation_models import RunnerNode
from app.services import runner_hub, cluster_runtime, endpoint_events, conversation_content, runner_access_policy
from app.services.runner_content_store import Store, CHUNK


class EndpointRpcTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_history_probe_cannot_hold_socket_while_waiting_for_content_transaction(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-content-lock-order-") as root:
            engine = create_async_engine("sqlite+aiosqlite:///" + str(Path(root) / "test.db"),
                                         connect_args={"timeout": .3})
            sessions = async_sessionmaker(engine, expire_on_commit=False)
            pending = None
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(lambda sync: db.Base.metadata.create_all(sync, tables=[
                        models.Task.__table__, models.Client.__table__, models.User.__table__, RunnerNode.__table__]))
                async with sessions() as session:
                    session.add(models.User(id="owner", username="isolated-lock-owner"))
                    session.add(RunnerNode(id="runner", owner_user_id="owner", org_id="", client_id="",
                                           auth_state="active", management_state="disabled"))
                    await session.commit()
                store = Store(str(Path(root) / "content"))
                socket = SimpleNamespace()
                node = runner_hub._Runner(socket, {"runnerId": "runner", "caps": ["conversationContent1"]})
                node.owner_user_id, node.management_state, node.ready = "owner", "disabled", True
                sent, waiting = [], asyncio.Event()

                async def send(packet):
                    sent.append(packet["op"])
                    if packet["op"] == "job.session":
                        return
                    node.resolve(packet["id"], await asyncio.to_thread(store.handle, packet))

                socket.send_json = send
                with patch.object(db, "SessionLocal", sessions), patch.object(runner_hub, "get", return_value=node), \
                     patch.object(cluster_runtime, "check_owner", AsyncMock()):
                    async with sessions() as writer:
                        await runner_access_policy.acquire_runner_policy_lock(writer, node.id)
                        lock = runner_access_policy.acquire_runner_policy_lock

                        async def acquire(session, runner_id):
                            if session is not writer:
                                waiting.set()
                            await lock(session, runner_id)

                        with patch.object(runner_access_policy, "acquire_runner_policy_lock", acquire):
                            pending = asyncio.create_task(node.send({"op": "job.session"}))
                            await asyncio.wait_for(waiting.wait(), 1)
                            pointer = await asyncio.wait_for(conversation_content.put_json(
                                "runner", "owner", "history", {"text": "retained"}, session=writer), 2)
                            # The content owner must make progress before releasing its
                            # transaction; the unrelated probe must still wait for it.
                            self.assertFalse(pending.done())
                            self.assertNotIn("job.session", sent)
                            await writer.rollback()
                            await asyncio.wait_for(pending, 1)
                    self.assertEqual(await conversation_content.get_json(pointer, "owner", "history"),
                                     {"text": "retained"})
                    self.assertEqual(sent.count("job.session"), 1)
            finally:
                if pending is not None:
                    pending.cancel()
                    await asyncio.gather(pending, return_exceptions=True)
                await engine.dispose()

    async def test_runner_pipe_and_network_share_realm_store_initialization(self):
        import runner_main
        from app.services import local_base, runner_content_store
        with tempfile.TemporaryDirectory(prefix="soduwork-content-ingress-") as root, ExitStack() as cleanup:
            with patch.object(local_base, "_data_root", return_value=root):
                runner = runner_main.Runner("https://isolated.example/", "", "pc", "runner")
            cleanup.callback(runner._admission._journal.close)
            replies = []
            async def sent(packet):
                replies.append(packet)
            runner._send = sent
            body = b"only the endpoint owns this transcript"
            packet = {"op": "content.put", "scope": "a" * 64,
                      "sha256": hashlib.sha256(body).hexdigest(), "size": len(body),
                      "offset": 0, "b64": base64.b64encode(body).decode()}
            with patch.object(local_base, "_data_root", return_value=root), \
                 patch.object(runner_content_store, "Store", wraps=Store) as factory:
                await asyncio.gather(*(runner._on({**packet, "id": str(i)}) for i in range(32)))
                self.assertTrue(all(reply["ok"] for reply in replies), replies)
                self.assertEqual(factory.call_count, 1)
                await runner._on({**packet, "op": "content.seal", "id": "seal"})
                realm = hashlib.sha256(b"https://isolated.example").hexdigest()
                reads = await asyncio.gather(*(runner._local_rpc_dispatch({**packet,
                    "op": "runtime.content.read", "realm": realm}) for _ in range(32)))
                self.assertTrue(all(reply["data"]["b64"] == packet["b64"] for reply in reads))
                self.assertEqual(factory.call_count, 1)
                with self.assertRaisesRegex(ValueError, "realm"):
                    await runner._local_rpc_dispatch({**packet, "op": "runtime.content.read", "realm": "../other"})
                other = await runner._conversation_content_store("b" * 64)
                self.assertNotEqual(other.file, runner._content_stores[realm].file)
                with self.assertRaisesRegex(ValueError, "durably"):
                    other.handle({**packet, "op": "content.read"})

    async def test_real_runner_roundtrip_restart_and_realm_isolation(self):
        import runner_main
        from app.services import local_base
        for hub, base in (("http://isolated.example/", "http://isolated.example"),
                          ("ws://isolated.example/", "http://isolated.example"),
                          ("https://isolated.example/", "https://isolated.example"),
                          ("wss://isolated.example/", "https://isolated.example")):
            with self.subTest(hub=hub), tempfile.TemporaryDirectory(prefix="soduwork-content-transport-") as root, \
                 ExitStack() as cleanup, patch.object(local_base, "_data_root", return_value=root):
                endpoint = runner_main.Runner(hub, "", "pc", "runner")
                cleanup.callback(endpoint._admission._journal.close)
                socket = SimpleNamespace()
                node = runner_hub._Runner(socket, {"runnerId": "runner", "caps": ["conversationContent1"]})
                node.ready = True
                sent = []

                async def send(packet):
                    sent.append(packet["op"])
                    await endpoint._handle_message(packet, socket)

                async def reply(packet):
                    self.assertIs(endpoint._send_target.get(), socket)
                    node.resolve(packet["id"], packet)

                socket.send_json, endpoint._send = send, reply
                values = [{"index": index, "text": "retained output " + str(index)} for index in range(9)]
                values[0]["text"] *= CHUNK // 2
                with patch.object(runner_hub, "get", return_value=node), \
                     patch.object(cluster_runtime, "check_owner", AsyncMock()):
                    pointers = await asyncio.gather(*(conversation_content.put_json(
                        "runner", "owner", str(index), value) for index, value in enumerate(values)))
                    before = len(sent)
                    retry = await conversation_content.put_json("runner", "owner", "0", values[0], resume=True)
                    self.assertEqual(retry, pointers[0])
                    self.assertEqual(sent[before:], ["content.status"])
                    endpoint._admission._journal.close()
                    endpoint = runner_main.Runner(hub, "", "pc", "runner")
                    cleanup.callback(endpoint._admission._journal.close)
                    endpoint._send = reply
                    restored = await asyncio.gather(*(conversation_content.get_json(pointer, "owner", str(index))
                        for index, pointer in enumerate(pointers)))
                    self.assertEqual(restored, values)
                    realm = hashlib.sha256(base.encode()).hexdigest()
                    local = await endpoint._local_rpc_dispatch({"op": "runtime.content.read", "realm": realm,
                        "scope": pointers[1]["scope"], "sha256": pointers[1]["sha256"], "offset": 0})
                    self.assertIn(b"retained output", base64.b64decode(local["data"]["b64"]))
                    from fastapi import HTTPException
                    with self.assertRaises(HTTPException) as wrong_owner:
                        await conversation_content.get_json(pointers[1], "another-owner", "1")
                    self.assertEqual(wrong_owner.exception.status_code, 409)
                    with self.assertRaisesRegex(ValueError, "durably"):
                        await endpoint._local_rpc_dispatch({"op": "runtime.content.read", "realm": "b" * 64,
                            "scope": pointers[1]["scope"], "sha256": pointers[1]["sha256"], "offset": 0})
                    self.assertFalse(any(op.startswith("job.") for op in sent))

    async def test_personal_runner_persists_events_inside_hub_transaction_without_locking_itself(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-endpoint-rpc-") as root:
            engine = create_async_engine("sqlite+aiosqlite:///" + str(Path(root) / "test.db"), connect_args={"timeout": .1})
            sessions = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(lambda sync: db.Base.metadata.create_all(sync, tables=[
                        models.Task.__table__, models.Client.__table__, models.User.__table__, RunnerNode.__table__]))
                async with sessions() as session:
                    session.add(models.User(id="owner", username="isolated-content-owner"))
                    session.add(models.Client(id="pc", user_ref="owner", auth_state="active"))
                    await session.flush()
                    session.add(models.Task(id="task", owner_client_id="pc", title="original"))
                    session.add(RunnerNode(id="runner", owner_user_id="owner", org_id="", client_id="",
                        auth_state="active", management_state="disabled"))
                    await session.commit()
                store = Store(str(Path(root) / "content"))
                socket = SimpleNamespace()
                node = runner_hub._Runner(socket, {"runnerId": "runner", "caps": ["conversationContent1"]})
                node.owner_user_id, node.management_state, node.ready = "owner", "disabled", True
                sent = []
                async def send(packet):
                    sent.append(packet["op"])
                    response = await asyncio.to_thread(store.handle, packet)
                    node.resolve(packet["id"], response)
                socket.send_json = send
                execution = SimpleNamespace(id="execution", task_id="task", runner_id="runner")
                values = [{"seq": 1, "text": "private event", "detail": {}, "kind": "say", "tool": "", "at": None}]
                with patch.object(db, "SessionLocal", sessions), patch.object(runner_hub, "get", return_value=node), \
                     patch.object(cluster_runtime, "check_owner", AsyncMock()):
                    async with sessions() as session:
                        await session.execute(update(models.Task).where(models.Task.id == "task").values(title="in progress"))
                        stored = await asyncio.wait_for(endpoint_events.externalize(session, execution, values), 3)
                        self.assertEqual(stored[0]["text"], "")
                        self.assertNotIn("private", str(stored[0]["detail"]))
                        # Content persistence must not commit unrelated Hub work.
                        await session.rollback()
                    async with sessions() as session:
                        self.assertEqual((await session.get(models.Task, "task")).title, "original")
                    rows = [SimpleNamespace(**stored[0])]
                    self.assertEqual((await endpoint_events.hydrate(rows))[0].text, "private event")
                    # A cached live socket cannot authorize a revoked endpoint,
                    # including when immutable storage borrows a caller session.
                    async with sessions() as session:
                        await session.execute(update(RunnerNode).where(RunnerNode.id == "runner").values(auth_state="revoked"))
                        await session.commit()
                    before = len(sent)
                    from fastapi import HTTPException
                    async with sessions() as session:
                        await session.execute(update(models.Task).where(models.Task.id == "task").values(title="must roll back"))
                        with self.assertRaises(HTTPException):
                            await endpoint_events.externalize(session, execution, [{**values[0], "seq": 2}])
                        await session.rollback()
                    self.assertEqual(len(sent), before)
                    async with sessions() as session:
                        self.assertEqual((await session.get(models.Task, "task")).title, "original")
            finally:
                await engine.dispose()
