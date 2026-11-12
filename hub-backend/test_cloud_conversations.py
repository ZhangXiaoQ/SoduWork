"""Authenticated direct-cloud entry, real isolated Runner and synthetic vendor CLI.

No business DB, daily Runner, desktop SDK or commercial model is used. Reuses
the existing subprocess transport fixture; only the vendor is synthetic.
"""
import asyncio
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import AsyncMock, patch

import test_conversation_handoffs as fixture
from app import db, models
from app.api import attachments, cloud_conversations, deliveries
from app.conversation_handoff_models import ConversationHandoff
from app.services import (ai_remote, cloud_conversations as svc, conversation_handoffs as handoffs,
                          device_auth, execution_settlement, library_storage, model_catalog, runner_hub, storage)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


class CloudConversationTests(unittest.IsolatedAsyncioTestCase):
    async def test_mobile_automatic_review_real_report_transport_and_settlement(self):
        from app import automation_models as am
        from app.services import cloud_acceptance
        task_id = 'mobile-acceptance-source'
        async with db.SessionLocal() as session:
            session.add_all([
                models.Task(id=task_id, title='Synthetic review', status='done',
                    created_by=self.fixture.owner.id, owner_client_id=self.fixture.client.id,
                    acceptance_criteria=['Read the fixed text']),
                am.ArtifactVersion(id='mobile-acceptance-artifact', task_id=task_id, seq=1,
                    kind='output', checksum='isolated', state='candidate',
                    manifest={'schemaVersion': 'soduwork.delivery/1', 'complete': True,
                              'primary': [], 'problems': [], 'text': 'Isolated review output'}),
                am.ApprovalRequest(id='mobile-acceptance-approval', task_id=task_id,
                    artifact_version_id='mobile-acceptance-artifact', action='review', status='pending',
                    required_count=1, policy_snapshot={'separationOfDuties': False},
                    context={'acceptanceCriteria': ['Read the fixed text']}),
                am.ApprovalAssignment(request_id='mobile-acceptance-approval', user_id=self.fixture.owner.id),
            ])
            await session.commit()
        binding = {'taskId': task_id, 'approvalId': 'mobile-acceptance-approval',
                   'artifactVersionId': 'mobile-acceptance-artifact', 'requirementVersion': 1}
        response = await self.create('mobile-automatic-review', text='CLOUD_ACCEPTANCE_TEST', acceptance=binding)
        self.assertEqual(response.status_code, 200, response.text)
        receipt = response.json()
        self.assertEqual(receipt['phase'], 'committed', receipt)
        await self.fixture.complete(receipt['ref'])
        read = await self.http.get('/api/v1/tasks/' + receipt['taskId'] + '/ai-session')
        self.assertEqual(read.status_code, 200, read.text)
        self.assertFalse(read.json()['canSend'])
        async with db.SessionLocal() as session:
            settled = await execution_settlement.settle_terminal(session, receipt['taskId'], receipt['ref'])
            self.assertTrue(settled['ok'], settled)
            state = await cloud_acceptance.status(session, receipt['taskId'])
            self.assertEqual(state['result']['verdict'], 'approved', state)
            source = await session.get(models.Task, task_id)
            self.assertIsNotNone(source.reviewed_at)
        replay = await self.create('mobile-automatic-review', text='CLOUD_ACCEPTANCE_TEST', acceptance=binding)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(replay.json()['ref'], receipt['ref'])
        self.assertEqual(self.fixture.peer.calls.count('job.dispatch'), 1)

    async def asyncSetUp(self):
        self.fixture = fixture.HandoffTests("test_security_two_phase_real_execution_and_restart")
        await self.fixture.asyncSetUp()
        self.http = self.fixture.http
        self.fixture.app.include_router(cloud_conversations.router)
        self.fixture.app.include_router(attachments.router)
        self.fixture.app.include_router(deliveries.router)
        self.library_patch = patch.multiple(library_storage,
            _local_root=lambda: fixture.WORK / "delivery-library", storage_backend=lambda: "local")
        self.library_patch.start()

    async def asyncTearDown(self):
        self.library_patch.stop()
        await self.fixture.asyncTearDown()
        # Each test needs fresh seeded identities; the Runner and DB are closed.
        database = fixture.WORK / "test.db"
        self.assertEqual(Path(db.engine.url.database).resolve(), database.resolve())
        database.unlink(missing_ok=True)

    async def create(self, request_id, *, files=(), options=None, **changes):
        body = {"sessionId": "cloud-" + request_id, "agentId": "codex", "model": "",
                "title": "Direct cloud verification", "text": "CLOUD_NEW_TEST: write a report",
                "requiredSkills": [], **changes}
        return await self.http.post("/api/v1/cloud-conversations/" + request_id,
            data={"options": json.dumps(body if options is None else options)},
            files=[("files", item) for item in files])

    async def test_endpoint_content_releases_policy_lock_before_personal_dispatch(self):
        from types import MethodType, SimpleNamespace
        from app.services.runner_content_store import Store

        runner, peer = self.fixture.runner, self.fixture.peer
        runner.caps.append("conversationContent1")
        store = Store(str(fixture.WORK / "policy-content"))
        loop = asyncio.get_running_loop()
        content_reads = []
        disable_before_dispatch = False

        async def send_json(message):
            op = message["op"]
            if op.startswith("content."):
                reply = await asyncio.to_thread(store.handle, message)
                if op == "content.read":
                    content_reads.append(message["scope"])
            else:
                reply = await asyncio.to_thread(peer.call, runner, op, message)
            runner.resolve(message["id"], reply)

        # Exercise the real transport authorization and its independent database
        # connection; only the socket and vendor process remain fixtures.
        runner.ws = SimpleNamespace(send_json=send_json)
        runner.call = MethodType(runner_hub._Runner.call, runner)

        async def authorized_call(node, op, data, timeout):
            if op == "job.dispatch" and disable_before_dispatch:
                from app.automation_models import RunnerNode
                async with db.SessionLocal() as policy_session:
                    row = await policy_session.get(RunnerNode, node.id)
                    row.management_state = "disabled"
                    await policy_session.commit()
            return await node.call(op, data, timeout)

        def call_sync(node, op, data, timeout=60):
            return asyncio.run_coroutine_threadsafe(
                authorized_call(node, op, data, timeout), loop).result(timeout + 5)

        with patch.object(runner_hub, "call_sync", call_sync):
            response = await self.create("personal-content-lock")
            self.assertEqual(response.status_code, 200, response.text)
            receipt = response.json()
            self.assertEqual(receipt["phase"], "committed", receipt)
            self.assertTrue(content_reads)
            self.assertEqual(peer.calls.count("job.dispatch"), 1)
            await self.fixture.complete(receipt["ref"])
            replay = await self.create("personal-content-lock")
            self.assertEqual(replay.json()["ref"], receipt["ref"])
            self.assertEqual(peer.calls.count("job.dispatch"), 1)

            message = {"text": "Verify delivery again.", "messageId": "content-policy-follow-up"}
            follow = await self.http.post(
                f'/api/v1/tasks/{receipt["taskId"]}/ai-say', json=message)
            self.assertEqual(follow.status_code, 200, follow.text)
            self.assertEqual(follow.json()["delivery"], "accepted", follow.text)
            await self.fixture.complete(receipt["ref"])
            before = peer.calls.count("job.comment")
            repeated = await self.http.post(
                f'/api/v1/tasks/{receipt["taskId"]}/ai-say', json=message)
            self.assertTrue(repeated.json()["duplicate"], repeated.text)
            self.assertEqual(peer.calls.count("job.comment"), before)

            # Releasing preparation locks must not authorize a send using the
            # earlier selection snapshot after an administrator disables it.
            disable_before_dispatch = True
            blocked = await self.create("personal-content-revoked")
            self.assertEqual(blocked.status_code, 200, blocked.text)
            self.assertEqual(blocked.json()["phase"], "prepared", blocked.text)
            self.assertTrue(blocked.json()["error"], blocked.text)
            self.assertEqual(peer.calls.count("job.dispatch"), 1)

    async def test_personal_plugin_first_turn_keeps_hub_conversation_and_deduplication(self):
        from app.automation_models import RunnerNode
        runner = self.fixture.runner
        runner.client_id = "u-plugin-desktop"
        runner.tags = [runner_hub.CLIENT_TAG]
        runner.caps = ["handoff1", "desktopCapabilities1", "desktopPluginTurn1", "desktopPluginStart1", "admit1"]
        async with db.SessionLocal() as session:
            session.add(models.Client(id=runner.client_id, user_ref=self.fixture.owner.id, auth_state="active"))
            node = await session.get(RunnerNode, runner.id)
            node.client_id = runner.client_id
            await session.commit()
        await asyncio.to_thread(self.fixture.peer.call, runner, "fixture.desktop", {})
        selected = [{"pluginId":"local:fixture", "checksum":"a" * 64}]
        args = dict(plugins=selected, targetRunnerId=runner.id, targetRunnerKind="work-computer")
        response = await self.create("plugin-normal-chat", files=(("note.txt",b"material"),), **args)
        self.assertEqual(response.status_code,200,response.text)
        receipt = response.json()
        self.assertEqual(receipt["phase"],"committed",receipt)
        await self.fixture.complete(receipt["ref"])
        read = await self.http.get('/api/v1/tasks/' + receipt['taskId'] + '/ai-session')
        self.assertEqual(read.status_code,200,read.text)
        users = [item for item in read.json()['items'] if item.get('kind') == 'user']
        self.assertEqual(len(users),1)
        self.assertEqual(users[0]['text'],'CLOUD_NEW_TEST: write a report')
        self.assertEqual(users[0]['plugins'][0]['pluginId'],'local:fixture')
        context = json.loads((fixture.WORK / 'plugin-start-context.json').read_text(encoding='utf-8'))
        self.assertEqual(context['ref'],receipt['ref'])
        self.assertTrue(Path(context['cwd']).is_relative_to(fixture.WORK))
        again = await self.create("plugin-normal-chat", files=(("note.txt",b"material"),), **args)
        self.assertEqual(again.status_code,200,again.text)
        self.assertEqual(again.json()['taskId'],receipt['taskId'])
        self.assertEqual(self.fixture.peer.calls.count('job.dispatch'),1)
        changed = await self.create("plugin-normal-chat", files=(("note.txt",b"material"),),
            **{**args,'plugins':[{**selected[0],'checksum':'b' * 64}]})
        self.assertEqual(changed.status_code,409,changed.text)

    async def test_direct_entry_security_idempotency_inputs_and_capacity(self):
        peer, runner = self.fixture.peer, self.fixture.runner
        with self.subTest("validated contract rejects silent downgrades before execution"):
            for key, value in (("agentId", "missing"), ("text", ""), ("sessionId", "../session"),
                               ("workDir", "C:/private"), ("accessPolicy", {"mode": "full"}),
                               ("requiredSkills", ["computer-use"]), ("requiredSkills", ["missing-skill"]),
                               ("personalPlugins", ["local-plugin"]), ("model", "invalid model")):
                response = await self.create("invalid", **{key: value})
                self.assertIn(response.status_code, [400, 409, 422], response.text)
            for files in ((('../escape.txt', b'x'),), (('same.txt', b'x'), ('SAME.TXT', b'y')),
                          (('empty.txt', b''),), (('NUL.txt', b'x'),),
                          tuple((str(i) + '.txt', b'x') for i in range(21))):
                response = await self.create("invalid-files", files=files)
                self.assertIn(response.status_code, [400, 413], response.text)
            with patch.object(svc, "MAX_TOTAL_BYTES", 2):
                response = await self.create("oversize", files=(("file.txt", b"three"),))
                self.assertEqual(response.status_code, 413, response.text)
            self.assertNotIn("job.dispatch", peer.calls)

        with self.subTest("own desktop and foreign organization cannot be selected"):
            runner.client_id = self.fixture.client.id
            self.assertEqual((await self.create("same-device")).status_code, 409)
            runner.client_id, runner.owner_user_id = "", "other-owner"
            self.assertEqual((await self.create("foreign-org")).status_code, 409)
            runner.owner_user_id = self.fixture.owner.id

        with self.subTest("storage failure cleans all new objects and creates no task"):
            original_put = storage.put
            saved = []
            def broken_put(key, data, content_type):
                backend = original_put(key, data, content_type)
                saved.append((key, backend))
                if len(saved) == 2:
                    raise OSError("injected second-object storage failure")
                return backend
            with patch.object(storage, "put", broken_put):
                with self.assertRaisesRegex(OSError, "storage failure"):
                    await self.create("failed-input", files=(("one.txt", b"1"), ("two.txt", b"2")))
            for key, backend in saved:
                with self.assertRaises(FileNotFoundError):
                    storage.get(key, backend)
            async with db.SessionLocal() as session:
                self.assertIsNone(await session.get(ConversationHandoff,
                    handoffs.identity(self.fixture.client.id, "failed-input")))

        with self.subTest("pure text starts without archive, local session, inputs or path"):
            response = await self.create("direct-text")
            self.assertEqual(response.status_code, 200, response.text)
            receipt = response.json()
            self.assertEqual(receipt["phase"], "committed", receipt)
            self.assertEqual(receipt["transferId"], "direct-text")
            self.assertEqual(receipt["source"]["sessionId"], "cloud-direct-text")
            self.assertEqual(receipt["source"]["entryKind"], "cloud")
            self.assertEqual(receipt["target"]["runnerId"], "cloud")
            self.assertEqual(peer.calls.count("input.chunk"), 0)
            await self.fixture.complete(receipt["ref"])
            replay = await self.http.get(f'/api/v1/tasks/{receipt["taskId"]}/ai-session')
            self.assertEqual(replay.status_code, 200, replay.text)
            users = [item for item in replay.json()["items"] if item.get("kind") == "user"]
            self.assertEqual(len(users), 1, replay.text)
            self.assertEqual(users[0]["text"], "CLOUD_NEW_TEST: write a report")
            from app.services import execution_sessions
            original_read = execution_sessions.read_task
            with patch.object(execution_sessions, 'read_task', wraps=original_read) as read:
                larger = await self.http.get(f'/api/v1/tasks/{receipt["taskId"]}/ai-session?limit=1000')
                self.assertEqual(larger.status_code, 200, larger.text)
                self.assertEqual(read.call_args.kwargs['limit'], 1000)
                self.assertEqual(larger.json()['items'], replay.json()['items'])
            excessive = await self.http.get(f'/api/v1/tasks/{receipt["taskId"]}/ai-session?limit=1001')
            self.assertEqual(excessive.status_code, 422)
            async with db.SessionLocal() as session:
                settled = await execution_settlement.settle_terminal(session, receipt["taskId"], receipt["ref"])
                self.assertTrue(settled["ok"], settled)
                phone = models.Client(id="u-cloud-phone", user_ref=self.fixture.owner.id, auth_state="active")
                session.add(phone)
                await session.commit()
            phone_headers = {"Authorization": "Device " + device_auth.issue_session(phone)[0]}
            delivery_url = "/api/v1/deliveries/from-task/" + receipt["taskId"]
            pending = await self.http.get(delivery_url, headers=phone_headers)
            self.assertEqual(pending.status_code, 200, pending.text)
            self.assertEqual(pending.json()["state"], "pending", pending.text)
            self.assertIsNone(pending.json()["delivery"])
            # Completion preserves outputs; saving them requires an explicit user action.
            saved = await self.http.post(delivery_url, headers=phone_headers)
            self.assertEqual(saved.status_code, 200, saved.text)
            self.assertEqual(saved.json()["state"], "synced", saved.text)
            synced = await self.http.get(delivery_url, headers=phone_headers)
            self.assertEqual(synced.status_code, 200, synced.text)
            self.assertEqual(synced.json()["state"], "synced", synced.text)
            delivery = synced.json()["delivery"]
            self.assertEqual([item["path"] for item in delivery["files"]], ["delivery.md"])
            result_bytes = await self.http.get("/api/v1/deliveries/" + delivery["id"] + "/download", headers=phone_headers)
            self.assertEqual(result_bytes.status_code, 200, result_bytes.text)
            self.assertIn(b"independent cloud workspace", result_bytes.content)
            async with db.SessionLocal() as session:
                row = await session.get(ConversationHandoff, handoffs.identity(self.fixture.client.id, "direct-text"))
                self.assertEqual(row.storage_key, "")
                task = await session.get(models.Task, row.task_id)
                self.assertEqual(task.origin, "cloud-conversation")
                all_files = list((await session.scalars(select(models.Attachment).where(
                    models.Attachment.task_id == row.task_id))).all())
                self.assertFalse(any(item.role == "handoff" for item in all_files))
            task_id, ref = receipt["taskId"], receipt["ref"]

        with self.subTest("retry, reopen and conflicting request keep a single execution"):
            await db.engine.dispose()
            ai_remote._WHERE.clear()
            for _ in range(2):
                repeated = await self.create("direct-text")
                self.assertEqual(repeated.json()["ref"], ref, repeated.text)
            self.assertEqual(peer.calls.count("job.dispatch"), 1)
            self.assertEqual((await self.create("direct-text", text="different")).status_code, 409)
            bypass = await self.http.post(f"/api/v1/tasks/{task_id}/ai-dispatch", json={})
            self.assertEqual(bypass.status_code, 409, bypass.text)
            denied = await self.http.get("/api/v1/conversation-handoffs/direct-text",
                headers={"Authorization": "Device " + self.fixture.other_token})
            self.assertEqual(denied.status_code, 404, denied.text)

        with self.subTest("follow-up uses existing session and durable message receipt"):
            message = {"text": "Verify delivery again.", "messageId": "follow-up-1"}
            follow = await self.http.post(f"/api/v1/tasks/{task_id}/ai-say", json=message)
            self.assertEqual(follow.status_code, 200, follow.text)
            self.assertEqual(follow.json()["delivery"], "accepted", follow.text)
            await self.fixture.complete(ref)
            replay = await self.http.get(f'/api/v1/tasks/{task_id}/ai-session?ref={ref}')
            users = [item for item in replay.json()["items"] if item.get("kind") == "user"]
            self.assertEqual([item["text"] for item in users], ["CLOUD_NEW_TEST: write a report", message["text"]])
            repeated = await self.http.post(f"/api/v1/tasks/{task_id}/ai-say", json=message)
            self.assertTrue(repeated.json()["duplicate"], repeated.text)
            self.assertEqual(peer.calls.count("job.dispatch"), 1)

        with self.subTest("explicit first-turn files reach Runner once and remain private"):
            file_args = (("验收输入.txt", b"explicit input bytes", "text/plain"),)
            made = await self.create("direct-file", files=file_args)
            self.assertEqual(made.status_code, 200, made.text)
            file_receipt = made.json()
            self.assertEqual(file_receipt["phase"], "committed", file_receipt)
            await self.fixture.complete(file_receipt["ref"])
            replay = await self.http.get(f'/api/v1/tasks/{file_receipt["taskId"]}/ai-session')
            first = next(item for item in replay.json()["items"] if item.get("kind") == "user")
            self.assertEqual(len(first["attachments"]), 1, first)
            self.assertEqual(first["attachments"], [{"name": "验收输入.txt"}])
            raw = await asyncio.to_thread(peer.call, runner, "job.session", {"ref": file_receipt["ref"]})
            staged = next(item for item in raw["data"]["items"] if item.get("kind") == "user")["attachments"][0]
            self.assertEqual(Path(staged["path"]).read_bytes(), b"explicit input bytes")
            same = await self.create("direct-file", files=file_args)
            self.assertEqual(same.json()["ref"], file_receipt["ref"], same.text)
            changed = await self.create("direct-file", files=(("验收输入.txt", b"changed", "text/plain"),))
            self.assertEqual(changed.status_code, 409, changed.text)
            attachments_reply = await self.http.get(f'/api/v1/tasks/{file_receipt["taskId"]}/attachments')
            self.assertEqual(attachments_reply.status_code, 200, attachments_reply.text)
            input_id = next(item["id"] for item in attachments_reply.json() if item["filename"] == "验收输入.txt")
            denied = await self.http.post("/api/v1/attachments/" + input_id + "/access",
                headers={"Authorization": "Device " + self.fixture.other_token})
            self.assertIn(denied.status_code, [403, 404], denied.text)

        with self.subTest("simultaneous identical uploads create one execution and one input object"):
            before = peer.calls.count("job.dispatch")
            files = (("one.txt", b"same request bytes", "text/plain"),)
            replies = await asyncio.gather(self.create("double-submit", files=files),
                                           self.create("double-submit", files=files))
            self.assertTrue(all(reply.status_code == 200 for reply in replies), [reply.text for reply in replies])
            ready = await self.create("double-submit", files=files)
            self.assertEqual(ready.json()["phase"], "committed", ready.text)
            self.assertEqual(peer.calls.count("job.dispatch"), before + 1)
            await self.fixture.complete(ready.json()["ref"])
            row_id = handoffs.identity(self.fixture.client.id, "double-submit")
            async with db.SessionLocal() as session:
                row = await session.get(ConversationHandoff, row_id)
                self.assertEqual(len(row.options["inputs"]), 1)
            self.assertEqual(len(list(Path(storage._LOCAL_DIR).glob("cloud-inputs__" + row_id + "__*"))), 1)

        with self.subTest("lost database commit ACK preserves referenced inputs for retry"):
            original_commit = AsyncSession.commit
            dropped = False
            async def lost_commit_ack(session):
                nonlocal dropped
                await original_commit(session)
                if not dropped:
                    dropped = True
                    raise RuntimeError("injected database commit acknowledgement loss")
            before = peer.calls.count("job.dispatch")
            files = (("input.txt", b"retain committed bytes", "text/plain"),)
            with patch.object(AsyncSession, "commit", lost_commit_ack):
                with self.assertRaisesRegex(RuntimeError, "acknowledgement loss"):
                    await self.create("db-ack", files=files)
            self.assertEqual(peer.calls.count("job.dispatch"), before)
            restored = await self.create("db-ack", files=files)
            self.assertEqual(restored.json()["phase"], "committed", restored.text)
            self.assertEqual(peer.calls.count("job.dispatch"), before + 1)
            await self.fixture.complete(restored.json()["ref"])

        with self.subTest("managed models must be authorized; no gateway config is invented"):
            runner.agents.append({"key": "pi", "name": "Pi", "auth": "authed"})
            with patch.object(model_catalog, "resolve", AsyncMock(return_value=None)):
                rejected = await self.create("bad-model", agentId="pi", model="missing-provider/model")
                self.assertEqual(rejected.status_code, 409, rejected.text)
            runner.agents.pop()

        with self.subTest("concurrent starts reserve capacity before RPC and cannot oversubscribe"):
            runner.task_outstanding, runner.task_queue_capacity = 0, 1
            entered, release = threading.Event(), threading.Event()
            original = peer.call
            def paused(r, op, body, timeout=60):
                if op == "job.dispatch":
                    entered.set()
                    if not release.wait(10):
                        raise AssertionError("test did not release held dispatch")
                return original(r, op, body, timeout)
            before = peer.calls.count("job.dispatch")
            with patch.object(runner_hub, "call_sync", paused):
                first_request = asyncio.create_task(self.create("capacity-one"))
                try:
                    self.assertTrue(await asyncio.to_thread(entered.wait, 10))
                    blocked = await self.create("capacity-two")
                    self.assertEqual(blocked.status_code, 409, blocked.text)
                finally:
                    release.set()
                accepted = await first_request
            self.assertEqual(accepted.json()["phase"], "committed", accepted.text)
            self.assertEqual(peer.calls.count("job.dispatch"), before + 1)
            await self.fixture.complete(accepted.json()["ref"])
            runner.task_queue_capacity, runner.task_outstanding = 100, 0

        with self.subTest("lost ACK is recovered against the original ref without redispatch"):
            before = peer.calls.count("job.dispatch")
            original = peer.call
            def lost_ack(r, op, body, timeout=60):
                reply = original(r, op, body, timeout)
                return {"ok": False, "uncertain": True, "error": "injected lost ACK"} if op == "job.dispatch" else reply
            with patch.object(runner_hub, "call_sync", lost_ack):
                made = await self.create("lost-ack")
            self.assertEqual(made.json()["phase"], "committing", made.text)
            again = await self.create("lost-ack")
            self.assertEqual(again.json()["phase"], "committed", again.text)
            self.assertEqual(peer.calls.count("job.dispatch"), before + 1)
            await self.fixture.complete(again.json()["ref"])

if __name__ == "__main__":
    unittest.main()
