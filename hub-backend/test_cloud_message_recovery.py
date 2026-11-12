"""Continuation recovery at commit, RPC and acknowledgement failure boundaries."""
import asyncio
import base64
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from app import db, models
from app.automation_models import ExecutionSession, ResourceLease
from app.automation_models import ApprovalRequest, RunnerNode
from app.conversation_handoff_models import ConversationHandoff as Handoff, ConversationMessageReceipt as Receipt
from app.db import Base
from app.services import cloud_message_recovery as recovery, cloud_recovery
from app.services import conversation_message_receipts as messages
from app.services.runner_admission import AdmissionQueue, INTERACTIVE
from app.services.runner_admission_journal import Journal


class CloudMessageRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='smoke-cloud-messages-')
        root = Path(self.temp.name)
        self.engine = create_async_engine('sqlite+aiosqlite:///' + (root/'test.db').as_posix())
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda conn: Base.metadata.create_all(conn, tables=[
                model.__table__ for model in (models.User, models.Client, models.Task,
                    models.TaskEvent, ApprovalRequest, ExecutionSession, ResourceLease, Handoff, Receipt, RunnerNode)]))
        async with self.sessions() as session:
            session.add(models.User(id='user', username='cloud-message-user', is_active=True))
            self.client = models.Client(id='device', user_ref='user', auth_state='active')
            self.second = models.Client(id='second-device', user_ref='user', auth_state='active')
            session.add_all([self.client, self.second])
            await session.flush()
            session.add(models.Task(id='task', owner_client_id='device', owner_user_id='user',
                title='Cloud work', status='doing', created_by='user'))
            session.add(Handoff(id='handoff', owner_client_id='device', owner_user_id='user',
                transfer_id='transfer', task_id='task', phase='committed', options={
                    'agentId':'codex', 'model':'', 'assigneeId':'runner:cloud:codex',
                    'targetSnapshot': {'runnerId':'cloud', 'agentId':'codex'}}, receipt={'ref':'execution'}))
            session.add(ExecutionSession(id='execution-row', task_id='task', ref='execution', runner_id='cloud'))
            await session.commit()
        self.queue = AdmissionQueue(journal=Journal(root/'runner', 'cloud'))
        self.comment_calls = 0
        self.failure = ''
        self.runner = SimpleNamespace(id='cloud', boot_id='boot-one', caps=['admit1', 'executionSelection1'],
                                      alive=lambda: True, call=AsyncMock(side_effect=self.rpc))
        self.ctx = {'name':'local', 'cfg': {'local_cli':'codex', 'llm': {'key':'secret-not-to-persist'},
            '_executionSelection': {'agentId':'codex', 'modelName':'', 'reasoningEffort':''}}}
        self.real_accepted = recovery.cloud_turn_selection.accepted
        self.real_prepare = recovery.cloud_turn_selection.prepare
        patches = [patch.object(recovery, 'SessionLocal', self.sessions),
            patch.object(cloud_recovery, 'SessionLocal', self.sessions),
            patch.object(recovery.runner_hub, 'get', return_value=self.runner),
            patch.object(recovery.ai_exec, 'load', AsyncMock(return_value=self.ctx)),
            patch.object(recovery.cloud_turn_selection, 'prepare', AsyncMock(return_value=self.ctx)),
            patch.object(recovery.cloud_turn_selection, 'accepted', AsyncMock())]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    async def asyncTearDown(self):
        await self.engine.dispose()
        self.temp.cleanup()

    async def rpc(self, op, data, timeout=60):
        if op == 'job.has':
            item = self.queue.get(data['admissionKey'])
            return {'ok':True, 'data': {'has': bool(item), 'admissionDurable':True,
                'bootId':self.runner.boot_id, 'admissionKey':data['admissionKey'],
                **(self.queue.receipt(item, duplicate=True) if item else {})}}
        self.assertEqual(op, 'job.comment')
        self.comment_calls += 1
        if self.failure == 'before':
            self.failure = ''
            raise ConnectionError('before remote receipt')
        _, _, item = self.queue.submit('comment:'+data['turnId'], data['ref'], INTERACTIVE, 'comment',
            {**data, '_acceptedSelection': data.get('executionSelection')})
        if self.failure == 'after':
            self.failure = ''
            raise ConnectionError('receipt lost after durable acceptance')
        return {'ok':True, 'data':self.queue.receipt(item)}

    async def send(self, client=None, text='Continue the same cloud task', message_id='stable-message'):
        async with self.sessions() as session:
            return await messages.send(session, client or self.client, 'task', 'execution', text,
                                       message_id, self.ctx)

    async def receipt(self):
        async with self.sessions() as session:
            return await session.scalar(select(Receipt))

    async def test_endpoint_backed_image_releases_policy_lock_before_upload_and_receipt_probe(self):
        from app.services import runner_hub, cluster_runtime
        from app.services.runner_content_store import Store
        async with self.sessions() as session:
            session.add(RunnerNode(id='cloud', owner_user_id='user', client_id='', org_id='',
                                   auth_state='active', management_state='', dispatch_mode='accepting'))
            await session.commit()
        socket = SimpleNamespace()
        runner = runner_hub._Runner(socket, {'runnerId': 'cloud', 'bootId': 'boot-one',
            'caps': ['admit1', 'executionSelection1', 'turnFiles1', 'conversationContent1']})
        runner.owner_user_id, runner.ready = 'user', True
        store = Store(str(Path(self.temp.name) / 'content'))
        operations, chunks = [], []

        async def wire(packet):
            op = packet['op']
            operations.append(op)
            if op.startswith('content.'):
                reply = await asyncio.to_thread(store.handle, packet)
            elif op == 'input.chunk':
                chunks.append(base64.b64decode(packet['b64']))
                reply = {'ok': True, 'data': {}}
            else:
                reply = await self.rpc(op, packet)
            runner.resolve(packet['id'], reply)

        socket.send_json = wire
        self.runner = runner
        self.ctx['_turnFiles'] = [('image.png', b'isolated image bytes', 'image/png')]
        with patch.object(db, 'SessionLocal', self.sessions), \
             patch.object(runner_hub, 'get', return_value=runner), \
             patch.object(runner_hub, '_LOOP', asyncio.get_running_loop()), \
             patch.object(cluster_runtime, 'check_owner', AsyncMock()):
            with patch.object(recovery, 'attempt', side_effect=asyncio.CancelledError):
                with self.assertRaises(asyncio.CancelledError):
                    await self.send()
            row = await self.receipt()
            self.assertIn('contentRef', row.payload)
            self.assertNotIn('files', row.payload)
            self.failure = 'after'
            await recovery.attempt(row.id)
            self.assertEqual(self.comment_calls, 1)
            self.assertEqual((await self.receipt()).phase, 'uncertain')
            self.assertEqual(b''.join(chunks), b'isolated image bytes')
            await recovery.attempt(row.id)
            self.assertEqual((await self.receipt()).phase, 'accepted')
            self.assertEqual(self.comment_calls, 1)
            self.assertEqual(operations.count('input.chunk'), 1)
            self.assertEqual(operations.count('job.has'), 1)
            self.assertEqual(len(self.queue.active_items()), 1)

    async def test_skill_selection_survives_restart_and_lost_ack_on_original_execution(self):
        from app.services import conversation_turn_skills
        self.ctx['_turnSkills'] = ['office']
        with patch.object(recovery, 'attempt', side_effect=asyncio.CancelledError):
            with self.assertRaises(asyncio.CancelledError):
                await self.send()
        row = await self.receipt()
        self.assertEqual(row.payload['skills'], ['office'])
        self.failure = 'after'
        with patch.object(conversation_turn_skills, 'validate', AsyncMock()) as validate:
            await recovery.attempt(row.id)
            await recovery.attempt(row.id)
        validate.assert_awaited_once()
        item = self.queue.active_items()[0]
        self.assertEqual(item.payload['turnSkills'], ['office'])
        self.assertEqual(item.ref, 'execution')
        self.assertEqual(self.comment_calls, 1)
        self.assertEqual((await self.receipt()).phase, 'accepted')
        self.ctx['_turnSkills'] = ['browser-use']
        with self.assertRaises(HTTPException) as conflict:
            await self.send()
        self.assertEqual(conflict.exception.status_code, 409)

    async def test_revoked_skill_is_not_delivered_as_plain_text(self):
        from app.services import conversation_turn_skills
        self.ctx['_turnSkills'] = ['office']
        with patch.object(conversation_turn_skills, 'validate',
                          AsyncMock(side_effect=HTTPException(403, 'Skill revoked'))):
            await self.send()
        self.assertEqual((await self.receipt()).phase, 'rejected')
        self.assertEqual(self.comment_calls, 0)

    async def test_commit_survives_caller_exit_and_worker_finishes_without_observer(self):
        with patch.object(recovery, 'attempt', side_effect=asyncio.CancelledError):
            with self.assertRaises(asyncio.CancelledError):
                await self.send()
        row = await self.receipt()
        self.assertEqual(row.phase, 'queued')
        self.assertNotIn('secret-not-to-persist', json.dumps(row.payload))
        self.assertEqual(self.comment_calls, 0)
        await recovery.recover()
        self.assertEqual((await self.receipt()).phase, 'accepted')
        self.assertEqual(self.comment_calls, 1)
        self.assertIsNone((await self.receipt()).payload)

    async def reject_for_rework(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, 'task')
            session.add(ApprovalRequest(id='review', task_id=task.id, artifact_version_id='version',
                action='review', status='rejected', resolved_at=recovery.now()))
            task.work_routing = {'reworkPending': {'state': 'awaiting_executor',
                'ref': 'execution', 'requestId': 'review', 'feedback': 'Revise'}}
            await session.commit()

    async def test_accepted_rework_survives_caller_exit_and_consumes_feedback_once(self):
        await self.reject_for_rework()
        with patch.object(recovery, 'attempt', side_effect=asyncio.CancelledError):
            with self.assertRaises(asyncio.CancelledError):
                await self.send()
        async with self.sessions() as session:
            self.assertIn('reworkPending', (await session.get(models.Task, 'task')).work_routing)
        await recovery.recover()
        await recovery.recover()
        async with self.sessions() as session:
            self.assertNotIn('reworkPending', (await session.get(models.Task, 'task')).work_routing)
            events = list(await session.scalars(select(models.TaskEvent).where(models.TaskEvent.kind == 'ai.rework')))
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].detail['requestId'], 'review')
        self.assertEqual(self.comment_calls, 1)
        self.assertIsNone((await self.receipt()).payload)

    async def test_delayed_receipt_from_before_rejection_cannot_consume_new_feedback(self):
        self.failure = 'after'
        await self.send()
        await self.reject_for_rework()
        await recovery.attempt((await self.receipt()).id)
        self.assertEqual((await self.receipt()).phase, 'accepted')
        async with self.sessions() as session:
            self.assertIn('reworkPending', (await session.get(models.Task, 'task')).work_routing)
            self.assertIsNone(await session.scalar(select(models.TaskEvent).where(models.TaskEvent.kind == 'ai.rework')))
        self.assertEqual(self.comment_calls, 1)

    async def test_saved_selection_recovers_with_negotiated_runner_capabilities(self):
        from app.services import cloud_execution_sync, conversation_handoffs, task_execution_model
        from app.services.runner_hub import _Runner
        registered = _Runner(None, {'runnerId': 'cloud', 'clientId': 'device',
            'caps': ['bin1', 'handoff1', 'executionSelection1', 'sessionAck1', 'turnFiles1', 'admit1']})
        self.runner.caps = registered.caps
        self.runner.client_id = registered.client_id
        with patch.object(recovery, 'attempt', side_effect=asyncio.CancelledError):
            with self.assertRaises(asyncio.CancelledError):
                await self.send()
        row = await self.receipt()
        with patch.object(recovery.cloud_turn_selection, 'prepare', self.real_prepare), \
                patch.object(cloud_execution_sync, 'require_account_cloud_task', AsyncMock()), \
                patch.object(conversation_handoffs, 'committed_destination', AsyncMock(return_value={})), \
                patch.object(task_execution_model, 'prepare', AsyncMock(return_value=(self.ctx, {}))):
            self.assertEqual(await recovery.deliver(row.id), 'accepted')
            self.assertEqual(await recovery.deliver(row.id), 'stale')
        self.assertEqual(self.comment_calls, 1)
        self.assertEqual((await self.receipt()).phase, 'accepted')

    async def test_files_survive_caller_exit_and_lost_ack_without_text_only_replay(self):
        self.runner.caps.append('turnFiles1')
        self.ctx['_turnFiles'] = [('proof.txt', b'actual content', 'text/plain')]
        with patch.object(recovery, 'attempt', side_effect=asyncio.CancelledError):
            with self.assertRaises(asyncio.CancelledError):
                await self.send()
        row = await self.receipt()
        self.assertEqual(row.payload['files'][0]['data'], 'YWN0dWFsIGNvbnRlbnQ=')
        self.assertNotIn('secret-not-to-persist', json.dumps(row.payload))
        packet = {'transfer':'temporary-upload', 'items':[
            {'filename':'proof.txt', 'size':14, 'sha256':'content-digest', 'contentType':'text/plain'}]}
        self.failure = 'after'
        with patch.object(recovery.ai_remote, '_upload_inputs', return_value=(packet, '')) as upload:
            await recovery.attempt(row.id)
            self.assertEqual(upload.call_args.args[1], [('proof.txt', b'actual content', 'text/plain')])
            self.assertEqual(self.queue.active_items()[0].payload['files'], packet)
            await recovery.attempt(row.id)
            self.assertEqual(upload.call_count, 1)
        self.assertEqual(self.comment_calls, 1)
        self.assertEqual((await self.receipt()).phase, 'accepted')
        self.assertIsNone((await self.receipt()).payload)

    async def test_lost_remote_ack_is_confirmed_without_executing_again(self):
        self.failure = 'after'
        result = await self.send()
        self.assertTrue(result['uncertain'])
        row = await self.receipt()
        await recovery.attempt(row.id)
        self.assertEqual((await self.receipt()).phase, 'accepted')
        self.assertEqual(self.comment_calls, 1)
        self.assertEqual(len(self.queue.active_items()), 1)

    async def test_same_boot_proven_negative_retries_original_turn_id(self):
        self.failure = 'before'
        await self.send()
        row = await self.receipt()
        await recovery.attempt(row.id)
        self.assertEqual((await self.receipt()).phase, 'accepted')
        self.assertEqual(self.comment_calls, 2)
        self.assertEqual(self.queue.active_items()[0].key, 'comment:'+row.id)

    async def test_negative_after_runner_rebuild_never_guesses_no_effect(self):
        self.failure = 'before'
        await self.send()
        row = await self.receipt()
        self.runner.boot_id = 'different-boot'
        await recovery.attempt(row.id)
        self.assertEqual((await self.receipt()).phase, 'uncertain')
        self.assertEqual(self.comment_calls, 1)

    async def test_positive_receipt_after_runner_restart_remains_authoritative(self):
        self.failure = 'after'
        await self.send()
        self.runner.boot_id = 'different-boot'
        await recovery.attempt((await self.receipt()).id)
        self.assertEqual((await self.receipt()).phase, 'accepted')
        self.assertEqual(self.comment_calls, 1)

    async def test_account_key_prevents_duplicate_send_from_another_device(self):
        first = await self.send()
        second = await self.send(client=self.second)
        self.assertTrue(first['ok'])
        self.assertTrue(second['duplicate'])
        self.assertEqual(self.comment_calls, 1)
        with self.assertRaises(HTTPException) as error:
            await self.send(client=self.second, text='Different input')
        self.assertEqual(error.exception.status_code, 409)

    async def test_legacy_uncertain_record_is_never_automatically_replayed(self):
        async with self.sessions() as session:
            session.add(Receipt(id='legacy', owner_client_id='device', task_id='task', message_id='old',
                content_hash='old', phase='uncertain'))
            await session.commit()
        self.assertEqual(await recovery.recover(), 0)
        self.assertEqual(self.comment_calls, 0)

    async def test_revoked_account_cannot_execute_queued_work(self):
        with patch.object(recovery, 'attempt', side_effect=asyncio.CancelledError):
            with self.assertRaises(asyncio.CancelledError):
                await self.send()
        async with self.sessions() as session:
            user = await session.get(models.User, 'user')
            user.is_active = False
            await session.commit()
        await recovery.recover()
        self.assertEqual((await self.receipt()).phase, 'rejected')
        self.assertEqual(self.comment_calls, 0)

    async def test_receipt_and_active_selection_commit_atomically(self):
        async def interrupted(session, handoff, result, **kwargs):
            await self.real_accepted(session, handoff, result, **kwargs)
            raise RuntimeError('Hub interrupted before acceptance transaction commits')
        with patch.object(recovery.cloud_turn_selection, 'accepted', interrupted):
            with self.assertRaises(RuntimeError):
                await self.send()
        row = await self.receipt()
        self.assertEqual(row.phase, 'sending')
        self.assertIsNotNone(row.payload)
        async with self.sessions() as session:
            handoff = await session.get(Handoff, 'handoff')
            self.assertNotIn('activeExecutionSelection', handoff.receipt)
        with patch.object(recovery.cloud_turn_selection, 'accepted', self.real_accepted):
            await recovery.attempt(row.id)
        self.assertEqual(self.comment_calls, 1)
        self.assertEqual((await self.receipt()).phase, 'accepted')
        async with self.sessions() as session:
            handoff = await session.get(Handoff, 'handoff')
            self.assertEqual(handoff.receipt['activeExecutionSelection']['agentId'], 'codex')
            self.assertGreater(handoff.receipt['activeExecutionSelectionRevision'], 0)

    async def test_stale_preparation_cannot_overwrite_newer_terminal_receipt(self):
        async def accept_elsewhere(session, caller, ctx, handoff, selection):
            from sqlalchemy import update
            async with self.sessions() as other:
                await other.execute(update(Receipt).values(phase='rejected', receipt={'error':'revoked'}))
                await other.commit()
            return self.ctx
        with patch.object(recovery.cloud_turn_selection, 'prepare', accept_elsewhere):
            result = await self.send()
        self.assertFalse(result['ok'])
        self.assertEqual((await self.receipt()).phase, 'rejected')
        self.assertEqual(self.comment_calls, 0)


    async def test_plugin_turn_retries_keep_same_task_and_version_conflicts_do_not_resend(self):
        from app.services import conversation_turn_plugins
        self.ctx['_turnPlugins'] = [{'pluginId':'local:plugin-builder','checksum':'a'*64}]
        def authorize(client, runner, ref, selections, turn_id):
            return {'operation':'plugin.prepare','args':{'ref':ref,'plugins':selections},'authorization':'temporary'}
        with patch.object(conversation_turn_plugins,'validate',AsyncMock()), \
             patch.object(conversation_turn_plugins,'authorization',authorize):
            self.failure='after'
            first=await self.send()
            self.assertTrue(first['uncertain'])
            row=await self.receipt()
            self.assertEqual(row.payload['plugins'],self.ctx['_turnPlugins'])
            self.assertNotIn('temporary',json.dumps(row.payload))
            await recovery.attempt(row.id)
            second=await self.send()
            self.assertTrue(second['ok'])
            self.assertEqual(self.comment_calls,1)
            self.ctx['_turnPlugins']=[{'pluginId':'local:plugin-builder','checksum':'b'*64}]
            with self.assertRaises(HTTPException):
                await self.send()
            self.assertEqual(self.comment_calls,1)


if __name__ == '__main__':
    unittest.main()
