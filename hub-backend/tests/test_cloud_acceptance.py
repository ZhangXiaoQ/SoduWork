"""Isolated mobile review orchestration; uses the actual approval service."""
import hashlib
import json
import unittest
import tempfile
from types import SimpleNamespace
from unittest.mock import patch, AsyncMock

from fastapi import HTTPException
from sqlalchemy import select

from app import models, automation_models as am
from app.conversation_handoff_models import ConversationHandoff
from app.services import cloud_acceptance as svc, cloud_conversations, conversation_message_receipts, execution_settlement
from tests.test_task_acceptance_review import AcceptanceReviewTests


class MobileAcceptanceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fixture = AcceptanceReviewTests('test_context_is_read_only_and_carries_fixed_version')
        # This composed fixture is not run by unittest; register cleanup on the owning test.
        self.fixture.addCleanup = self.addCleanup
        self.fixture.addAsyncCleanup = self.addAsyncCleanup
        await self.fixture.asyncSetUp()
        f = self.fixture
        self.session = f.session
        f.client.auth_state = 'active'
        self.binding = {'taskId': f.task.id, 'approvalId': f.request.id,
                        'artifactVersionId': f.artifact.id, 'requirementVersion': 1}
        self.task = models.Task(id='review-chat', title='Mobile review', origin='cloud-conversation',
            owner_client_id=f.client.id, owner_user_id=f.actor.id, created_by=f.actor.id)
        self.handoff = ConversationHandoff(id='review-start', task_id=self.task.id,
            transfer_id='review-start', owner_client_id=f.client.id, owner_user_id=f.actor.id,
            phase='committed', source={'entryKind': 'cloud'}, receipt={'ref': 'ref-review'},
            options={'acceptance': self.binding, 'instruction': 'Check the result',
                     'targetSnapshot': {'runnerId': 'runner-review'}})
        self.execution = am.ExecutionSession(id='review-execution', task_id=self.task.id,
            ref='ref-review', runner_id='runner-review', state='done', engine='pi', metadata_={'round': 1})
        self.data = json.dumps(f.body()['report']).encode()
        self.file = models.Attachment(id='review-report', task_id=self.task.id,
            filename=svc.report_name(self.handoff), source_ref=self.execution.ref,
            uploaded_by='agent:runner', role='output', size=len(self.data),
            storage_key='isolated/report', backend='local',
            evidence_meta={'round': 1, 'sha256': hashlib.sha256(self.data).hexdigest()})
        self.session.add_all([self.task, self.handoff, self.execution, self.file])
        await self.session.commit()
        self.storage = patch.object(svc.storage, 'get', side_effect=lambda *args: self.data)
        self.storage.start()

    async def asyncTearDown(self):
        self.storage.stop()
        await self.fixture.asyncTearDown()

    async def settle(self):
        return await svc.settle(self.session, self.task, self.execution)

    async def test_review_directory_uses_fixed_delivery_identity_without_prompt(self):
        from app.services import conversation_review_projection
        api = {'id': self.task.id, 'title': self.task.title, 'note': ''}
        await conversation_review_projection.decorate_many(self.session, [self.task], [api])
        self.assertEqual(api['conversationReview']['artifactVersionId'], self.binding['artifactVersionId'])
        self.assertEqual(api['conversationReview']['approvalId'], self.binding['approvalId'])
        self.assertEqual(api['title'], f'自动验收 · {self.fixture.task.title} · 第{self.fixture.artifact.seq}版')
        self.assertEqual(self.task.title, 'Mobile review', 'projection must not mutate saved history')
        self.handoff.options = {**self.handoff.options, 'acceptance': {**self.binding, 'taskId': 'unrelated'}}
        await self.session.flush()
        other = {'title': 'Original'}
        await conversation_review_projection.decorate_many(self.session, [self.task], [other])
        self.assertEqual(other, {'title': 'Original'})

    async def test_success_persists_actual_decision_and_reopens_without_resubmission(self):
        result = await self.settle()
        self.assertTrue(result['closed'])
        self.assertEqual(result['verdict'], 'approved')
        self.assertEqual(await self.settle(), result)
        self.assertEqual((await svc.status(self.session, self.task.id))['result'], result)
        self.assertEqual(len((await self.session.scalars(select(am.ApprovalDecision))).all()), 1)

    async def test_rejection_uses_original_rework_chain(self):
        self.data = json.dumps(self.fixture.body('reject')['report']).encode()
        self.file.size = len(self.data)
        self.file.evidence_meta = {'round': 1, 'sha256': hashlib.sha256(self.data).hexdigest()}
        await self.session.commit()
        result = await self.settle()
        self.assertEqual(result['verdict'], 'rejected')
        self.assertTrue(result['rework']['waitingForExecutor'])
        self.assertEqual(result['rework']['fallback'], 'rework_pending')
        self.assertFalse(result['rework']['started'])
        pending = self.fixture.task.work_routing['reworkPending']
        self.assertEqual(pending['state'], 'awaiting_executor')
        self.assertEqual(pending['versionId'], self.fixture.artifact.id)
        self.assertEqual(pending['requestId'], self.fixture.request.id)
        self.assertEqual(self.fixture.task.status, 'doing')
        self.assertEqual(await self.settle(), result)
        from app.services import task_rework, ai_exec
        with patch.object(ai_exec, 'say_sync') as send:
            self.assertEqual((await task_rework.retry_once(self.session))['sent'], 0)
            send.assert_not_called()
        self.assertEqual(self.fixture.task.work_routing['reworkPending'], pending)

    async def test_recovery_after_decision_commit_uses_only_its_own_report(self):
        result = await self.settle()
        self.handoff.options = {k: v for k, v in self.handoff.options.items() if k != 'acceptanceResult'}
        await self.session.commit()
        recovered = await self.settle()
        self.assertEqual(recovered['checks'], result['checks'])
        self.assertTrue(recovered['closed'])
        self.assertEqual(len((await self.session.scalars(select(am.ApprovalDecision))).all()), 1)

    async def test_other_review_cannot_be_claimed_as_this_automatic_result(self):
        await svc.review.apply(self.session, self.fixture.client, self.fixture.task.id, self.fixture.body())
        with self.assertRaises(HTTPException) as raised:
            await self.settle()
        self.assertEqual(raised.exception.status_code, 409)
        self.assertNotIn('acceptanceResult', self.handoff.options)
        self.assertEqual(len((await self.session.scalars(select(am.ApprovalDecision))).all()), 1)

    async def test_wrong_version_or_revoked_reviewer_never_submits(self):
        self.fixture.task.requirement_version = 2
        await self.session.commit()
        with self.assertRaises(HTTPException):
            await self.settle()
        self.assertEqual(self.fixture.request.status, 'pending')
        self.fixture.task.requirement_version = 1
        self.fixture.actor.is_active = False
        await self.session.commit()
        with self.assertRaises(HTTPException):
            await self.settle()
        self.assertIsNone(self.fixture.task.reviewed_at)

    async def test_only_exact_completed_first_execution_can_submit(self):
        for field, bad in [('state', 'failed'), ('ref', 'other'), ('runner_id', 'other'), ('metadata_', {'round': 2})]:
            original = getattr(self.execution, field)
            setattr(self.execution, field, bad)
            with self.assertRaises(HTTPException):
                await self.settle()
            setattr(self.execution, field, original)
        self.assertIsNone(self.fixture.task.reviewed_at)

    async def test_input_upload_and_corrupt_or_missing_reports_cannot_approve(self):
        for field, bad in [('uploaded_by', self.fixture.client.id), ('source_ref', 'other'),
                           ('filename', 'ordinary.json'), ('evidence_meta', {'round': 2}), ('size', 0)]:
            original = getattr(self.file, field)
            setattr(self.file, field, bad)
            await self.session.flush()
            with self.assertRaises(HTTPException):
                await self.settle()
            setattr(self.file, field, original)
            await self.session.flush()
        self.data = b'{broken'
        with self.assertRaises(HTTPException):
            await self.settle()
        self.assertIsNone(self.fixture.task.reviewed_at)

    async def test_account_change_during_report_read_is_rechecked(self):
        self.fixture.client.user_ref = 'other'
        await self.session.commit()
        with self.assertRaises(HTTPException):
            await self.settle()
        self.assertIsNone(self.fixture.task.reviewed_at)

    async def test_terminal_settlement_applies_report_without_a_connected_phone(self):
        self.session.add(models.TaskEvent(task_id=self.task.id, kind='ai.dispatched',
            detail={'ref': self.execution.ref, 'runnerId': self.execution.runner_id}))
        await self.session.commit()
        with patch('app.services.ai_exec.load', AsyncMock(return_value={})), \
             patch('app.services.ai_exec.status_sync', return_value={'ok': True, 'done': True}), \
             patch('app.services.code_delivery.repo_for', AsyncMock(return_value=None)), \
             patch('app.services.project_context.record_completion', AsyncMock()):
            result = await execution_settlement.settle_terminal(self.session, self.task.id,
                self.execution.ref, include_task=False)
            self.assertTrue(result['ok'])
            self.assertEqual(self.handoff.options['acceptanceResult']['verdict'], 'approved')
            self.assertIsNotNone(self.fixture.task.reviewed_at)
            repeated = await execution_settlement.settle_terminal(self.session, self.task.id,
                self.execution.ref, include_task=False)
            self.assertTrue(repeated['idempotent'])

    async def test_prompt_is_built_from_authorized_fixed_context_and_no_followup(self):
        files, prompt = await svc.inputs(self.session, self.handoff,
                                       instruction=self.handoff.options['instruction'])
        self.assertEqual(files, [])
        self.assertIn(svc.report_name(self.handoff), prompt)
        self.assertIn('criterion-1', prompt)
        self.assertIn('不修改原交付物', prompt)
        self.assertIn('不得直接调用审批', prompt)
        with self.assertRaises(HTTPException):
            await conversation_message_receipts.send(self.session, self.fixture.client,
                self.task.id, self.execution.ref, 'replace the result', 'later', {})

    async def test_start_contract_rejects_malformed_reference_and_foreign_actor(self):
        for value in [{}, {**self.binding, 'report': {}}, {**self.binding, 'taskId': '../other'},
                      {**self.binding, 'requirementVersion': True}]:
            with self.assertRaises(HTTPException):
                svc.clean(value)
        self.assertEqual(svc.clean(self.binding), self.binding)
        self.fixture.client.user_ref = 'other'
        with self.assertRaises(HTTPException):
            await svc.validate(self.session, self.fixture.client, self.binding)

    async def test_cloud_dispatch_uses_server_review_context(self):
        self.handoff.options = {**self.handoff.options, 'requiredSkills': [], 'inputs': [],
                                'userText': 'Review', 'agentId': 'pi'}
        files, body = await cloud_conversations.dispatch_inputs(self.session, self.handoff, {})
        self.assertEqual(files, [])
        self.assertIn(svc.report_name(self.handoff), body['brief'])

    async def test_endpoint_only_instruction_is_used_without_restoring_hub_body(self):
        from app.services import conversation_content, runner_hub
        from app.services.runner_content_store import Store

        with tempfile.TemporaryDirectory() as directory:
            store = Store(directory)

            async def call(op, body, timeout):
                return store.handle({'op': op, **body})

            runner = SimpleNamespace(caps=['conversationContent1'], alive=lambda: True, call=call)
            with patch.object(runner_hub, 'get', return_value=runner):
                self.handoff.options = await conversation_content.save_options(
                    'runner-review', self.handoff.owner_user_id, 'handoff:' + self.handoff.id,
                    {**self.handoff.options, 'userText': 'Review the fixed version'},
                    session=self.session)
                await self.session.commit()
                self.assertNotIn('instruction', self.handoff.options)
                for _ in range(2):
                    files, body = await cloud_conversations.dispatch_inputs(self.session, self.handoff, {})
                    self.assertEqual(files, [])
                    self.assertIn('Check the result', body['brief'])
                    self.assertIn('criterion-1', body['brief'])
                    self.assertIn(svc.report_name(self.handoff), body['brief'])
                    self.assertEqual(body['conversationUserText'], 'Review the fixed version')
                await self.session.refresh(self.handoff)
                self.assertNotIn('instruction', self.handoff.options)
                self.assertNotIn('userText', self.handoff.options)
                self.assertEqual(self.fixture.request.status, 'pending')


if __name__ == '__main__':
    unittest.main()
