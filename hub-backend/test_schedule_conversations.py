"""Automation conversation protocol, isolated from the real Hub/Runner and DB."""
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from fastapi import HTTPException
from app import models
from app.agent_catalog import AGENTS
from app.services import schedule_conversations as chats, schedules, schedule_execution
from app.services.schedule_run_contracts import personal_plugin_spec
from app.api.schedule_contract import apply_schedule_update, schedule_payload


class ConversationProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine('sqlite+aiosqlite:///:memory:')
        async with self.engine.begin() as conn:
            for table in [models.Client.__table__, models.AiSchedule.__table__, models.AiScheduleRun.__table__]:
                await conn.run_sync(table.create)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.client = models.Client(id='device', last_seen_at=datetime.now(timezone.utc),
                                    config={'automationConversationV1': 1}, agent_models={'pi': 'chosen-model'})
        self.schedule = models.AiSchedule(id='schedule', owner_client_id='device', title='自动化标题',
            note='完整需求与验收\n材料说明', assignee_id='local:pi', enabled=False,
            plugin_inputs={'question': '全部保留'}, required_capabilities=[])
        self.run = models.AiScheduleRun(id='run', schedule_id='schedule', owner_client_id='device',
            state='waiting', receipt={})
        self.session.add_all([self.client, self.schedule, self.run]); await self.session.commit()

    async def asyncTearDown(self):
        await self.session.close(); await self.engine.dispose()

    async def prepare(self):
        return await chats.prepare(self.session, self.schedule, self.client, None, 'run', 'pi',
                                   personal_plugin_spec(self.schedule))

    async def test_direct_execution_does_not_create_task(self):
        with patch.object(schedules, 'validate_execution', AsyncMock()):
            result = await schedules.run_one(self.session, self.schedule, schedule_run_id='run')
        self.assertEqual(result['executionMode'], chats.PROTOCOL)
        self.assertNotIn('taskId', result); self.assertNotIn('workflowRunId', result)
        self.assertEqual(self.run.task_id, ''); self.assertEqual(self.run.workflow_run_id, '')

    async def test_envelope_uses_prompt_without_reusing_client_model_and_reuses_occurrence(self):
        self.run.started_at = datetime(2026, 10, 26, 2, 20, tzinfo=timezone.utc)
        await self.session.commit()
        await self.prepare()
        envelope = self.run.receipt['conversationInput']
        self.assertIn(self.schedule.note, envelope['text']); self.assertIn('全部保留', envelope['text'])
        self.assertEqual(envelope['personalPlugin'], {})
        self.assertEqual(envelope['modelName'], ''); self.assertEqual(envelope['adapterId'], 'pi')
        self.assertNotIn('projectId', envelope)
        self.assertEqual(envelope['conversationTitle'], '自动化 · 自动化标题 · 2026-10-26 10:20')
        self.assertEqual(self.run.receipt['conversationTitle'], envelope['conversationTitle'])
        self.schedule.note = 'later edit'
        await self.prepare(); self.assertEqual(self.run.receipt['conversationInput'], envelope)

    async def test_saved_creation_request_executes_work_instead_of_recreating_plan(self):
        note = '创建晨报，每天09:00，只回复 AUTO-OK，不调用工具、不读写文件、不联网，先暂停保存。'
        self.schedule.note = note
        self.schedule.enabled = False
        await self.prepare()
        text = self.run.receipt['conversationInput']['text']
        self.assertTrue(text.startswith('【执行已有自动化的本轮工作】'))
        self.assertIn('不要再次创建本自动化', text)
        self.assertIn('不修改计划的启停状态', text)
        self.assertIn(note, text)
        self.assertFalse(self.schedule.enabled)
        self.assertEqual(self.schedule.note, note)
        self.assertEqual(self.run.receipt['conversationInput']['personalPlugin'], {})

    async def test_envelope_prefers_model_selected_on_schedule_over_client_default(self):
        self.schedule.model_name = 'schedule-model'
        await self.prepare()
        self.assertEqual(self.run.receipt['conversationInput']['modelName'], 'schedule-model')

    async def test_schedule_contract_round_trips_selected_model(self):
        schedule = models.AiSchedule(title='automation', assignee_id='local:pi')
        apply_schedule_update(schedule, {'modelName': 'selected-model'})
        payload = schedule_payload(schedule, timestamp=lambda value: None)
        self.assertEqual(schedule.model_name, 'selected-model')
        self.assertEqual(payload['modelName'], 'selected-model')

    async def test_schedule_contract_round_trips_selected_personal_plugin(self):
        checksum = 'b' * 64
        schedule = models.AiSchedule(title='automation', assignee_id='local:pi')
        apply_schedule_update(schedule, {
            'personalPluginKey': 'daily-report',
            'personalPluginVersionPolicy': 'pinned',
            'personalPluginVersion': '1.0.0',
            'personalPluginChecksum': checksum,
            'pluginInputs': {'region': '华东'},
        })
        payload = schedule_payload(schedule, timestamp=lambda value: None)
        self.assertEqual(payload['executionMode'], 'personal')
        self.assertEqual(payload['personalPluginKey'], 'daily-report')
        self.assertEqual(payload['personalPluginVersionPolicy'], 'pinned')
        self.assertEqual(payload['personalPluginVersion'], '1.0.0')
        self.assertEqual(payload['personalPluginChecksum'], checksum)
        self.assertEqual(payload['pluginInputs'], {'region': '华东'})
        apply_schedule_update(schedule, {'enabled': False})
        self.assertEqual(schedule.personal_plugin_key, 'daily-report')
        self.assertEqual(schedule.plugin_inputs, {'region': '华东'})
        apply_schedule_update(schedule, {'personalPluginKey': 'weekly-report'})
        self.assertEqual(schedule.personal_plugin_key, 'weekly-report')
        self.assertEqual(schedule.personal_plugin_version_policy, 'latest')
        self.assertEqual(schedule.personal_plugin_version, '')
        self.assertEqual(schedule.personal_plugin_checksum, '')
        self.assertEqual(schedule.plugin_inputs, {})
        apply_schedule_update(schedule, {'personalPluginKey': ''})
        self.assertEqual(schedule.personal_plugin_key, '')
        self.assertEqual(schedule.plugin_inputs, {})

    async def test_save_validation_rejects_model_not_open_for_selected_agent(self):
        self.schedule.model_name = 'closed-model'
        with patch('app.services.ai_exec.load', new=AsyncMock(return_value={})), \
                patch('app.services.agent_route_selection.model_readiness',
                      return_value={'ok': False, 'detail': '模型未开放'}):
            with self.assertRaisesRegex(ValueError, '模型未开放'):
                await schedule_execution.validate_execution(self.session, self.schedule)

    async def test_save_validation_accepts_explicit_model_for_selected_agent(self):
        self.schedule.model_name = 'selected-model'
        with patch('app.services.ai_exec.load', new=AsyncMock(return_value={})), \
                patch('app.services.agent_route_selection.model_readiness',
                      return_value={'ok': True, 'detail': '可用'}):
            await schedule_execution.validate_execution(self.session, self.schedule)

    async def test_personal_plugin_selection_round_trips_into_ordinary_chat_envelope(self):
        self.schedule.personal_plugin_key = 'daily-report'
        self.schedule.personal_plugin_version_policy = 'pinned'
        self.schedule.personal_plugin_version = '1.0.0'
        self.schedule.personal_plugin_checksum = 'a' * 64
        await self.prepare()
        envelope = self.run.receipt['conversationInput']
        self.assertEqual(envelope['personalPlugin'], {
            'key': 'daily-report', 'versionPolicy': 'pinned',
            'version': '1.0.0', 'checksum': 'a' * 64,
        })

    async def test_associated_repo_stays_conversation_metadata_and_workspace_scope(self):
        repo = SimpleNamespace(id='repo-1', project_id='project-1', name='日报工程')
        with patch('app.services.workdirs.auto_dir', return_value=('C:/work/repo-1', None)):
            await chats.prepare(self.session, self.schedule, self.client, repo, 'run', 'pi', {})
        envelope = self.run.receipt['conversationInput']
        self.assertEqual(envelope['repoId'], 'repo-1')
        self.assertEqual(envelope['projectId'], 'project-1')
        self.assertIn('工程：日报工程', envelope['text'])
        self.assertEqual(envelope['cwd'], 'C:/work/repo-1')
        self.assertNotIn('taskId', envelope)
        self.assertNotIn('workflowRunId', envelope)

    async def test_save_validation_uses_current_catalog_for_new_gateway_model(self):
        self.schedule.model_name = 'new-catalog-model'
        with patch('app.services.ai_exec.load', new=AsyncMock(return_value={})), \
                patch('app.services.model_catalog.choices', new=AsyncMock(return_value={
                    'default': 'new-catalog-model', 'list': [], 'items': [
                        {'name': 'new-catalog-model', 'providerId': 'company'}]})), \
                patch('app.services.agent_route_selection.model_readiness',
                      return_value={'ok': False, 'detail': '旧模型清单中不存在'}):
            await schedule_execution.validate_execution(self.session, self.schedule)

    async def test_existing_conversation_title_is_stable_when_the_device_reclaims_a_run(self):
        self.run.started_at = datetime(2026, 10, 26, 2, 20, tzinfo=timezone.utc)
        self.run.receipt = {'conversationTitle': '自动化 · 自动化标题 · 2026-10-26 10:20', 'executionMode': chats.PROTOCOL}
        await self.session.commit()
        result = await self.prepare()
        self.assertEqual(result['conversationTitle'], '自动化 · 自动化标题 · 2026-10-26 10:20')

    async def test_all_automation_modes_use_the_plain_conversation_route(self):
        self.assertEqual(chats.adapter_for(self.schedule, self.client), 'pi')
        self.client.config = {}; self.assertEqual(chats.adapter_for(self.schedule, self.client), 'pi')
        self.schedule.flow = True
        self.assertEqual(chats.adapter_for(self.schedule, self.client), 'pi')
        self.schedule.flow = False
        self.schedule.plugin_binding_id = 'binding'
        self.assertEqual(chats.adapter_for(self.schedule, self.client), 'pi')
        self.schedule.plugin_binding_id = ''
        self.schedule.assignee_id = 'runner:invalid'
        self.assertEqual(chats.adapter_for(self.schedule, self.client), '')
        self.schedule.assignee_id = 'runner:remote:pi'
        with patch('app.services.runner_hub.get', return_value=SimpleNamespace(client_id='other')):
            self.assertEqual(chats.adapter_for(self.schedule, self.client), '')
        self.client.user_ref = 'account-owner'
        with patch('app.services.runner_hub.get', return_value=SimpleNamespace(
                client_id='other', owner_user_id='different-account')):
            self.assertEqual(chats.adapter_for(self.schedule, self.client), '')
        with patch('app.services.runner_hub.get', return_value=SimpleNamespace(
                client_id='other', owner_user_id='account-owner')):
            self.assertEqual(chats.adapter_for(self.schedule, self.client), 'pi')

    async def test_every_catalog_runner_is_a_supported_ordinary_conversation_adapter(self):
        """The editor exposes every catalog Agent, so dispatch must accept each same id."""
        for agent_id, spec in AGENTS.items():
            self.schedule.assignee_id = 'local:' + agent_id
            self.assertEqual(
                chats.adapter_for(self.schedule, self.client), agent_id,
                f'catalog Agent {agent_id} must open its matching conversation adapter',
            )

    async def test_changed_base_reaches_the_ordinary_conversation_envelope(self):
        self.schedule.assignee_id = 'local:qwen'
        with patch.object(schedules, 'validate_execution', AsyncMock()):
            result = await schedules.run_one(self.session, self.schedule, schedule_run_id='run')
        self.assertEqual(result['executionMode'], chats.PROTOCOL)
        self.assertEqual(self.run.receipt['conversationInput']['adapterId'], 'qwen')

    async def test_legacy_enterprise_binding_is_normalized_but_personal_plugin_survives(self):
        """Legacy enterprise routing is retired; local conversation plugins remain valid."""
        self.schedule.plugin_binding_id = 'legacy-binding'
        self.schedule.personal_plugin_key = 'legacy-method'
        self.schedule.personal_plugin_version_policy = 'pinned'
        self.schedule.personal_plugin_version = '1.0.0'
        self.schedule.personal_plugin_checksum = 'a' * 64
        self.schedule.flow = True
        apply_schedule_update(self.schedule, {'title': self.schedule.title})
        self.assertEqual(self.schedule.plugin_binding_id, '')
        self.assertEqual(self.schedule.personal_plugin_key, 'legacy-method')
        self.assertEqual(self.schedule.personal_plugin_version, '1.0.0')
        self.assertEqual(self.schedule.personal_plugin_checksum, 'a' * 64)
        self.assertFalse(self.schedule.flow)

        with patch.object(schedules, 'validate_execution', AsyncMock()):
            result = await schedules.run_one(self.session, self.schedule, schedule_run_id='run')
        self.assertEqual(result['executionMode'], chats.PROTOCOL)
        self.assertNotIn('taskId', result)
        self.assertNotIn('workflowRunId', result)

    async def test_schedule_payload_advertises_personal_plugin_without_task_execution(self):
        self.schedule.plugin_binding_id = 'legacy-binding'
        self.schedule.personal_plugin_key = 'legacy-method'
        payload = schedule_payload(self.schedule, timestamp=lambda value: None)
        self.assertEqual(payload['executionMode'], 'personal')
        self.assertEqual(payload['pluginBindingId'], '')
        self.assertEqual(payload['personalPluginKey'], 'legacy-method')

    async def test_schedule_payload_drops_orphaned_personal_plugin_snapshot(self):
        self.schedule.personal_plugin_key = ''
        self.schedule.personal_plugin_version_policy = 'pinned'
        self.schedule.personal_plugin_version = '1.0.0'
        self.schedule.personal_plugin_checksum = 'a' * 64
        payload = schedule_payload(self.schedule, timestamp=lambda value: None)
        self.assertEqual(payload['executionMode'], 'direct')
        self.assertEqual(payload['personalPluginVersionPolicy'], 'latest')
        self.assertEqual(payload['personalPluginVersion'], '')
        self.assertEqual(payload['personalPluginChecksum'], '')

    async def test_owner_inbox_opts_in_without_exposing_other_devices(self):
        await self.prepare(); self.client.config = {'otherSetting': 'keep'}
        items = await chats.inbox(self.session, self.client)
        self.assertEqual(items, [{'id': 'run', 'state': 'waiting'}])
        self.assertEqual(self.client.config['otherSetting'], 'keep')
        self.assertEqual(self.client.config['automationConversationV1'], 1)

    async def test_claim_is_owner_scoped_and_exclusive(self):
        await self.prepare()
        with self.assertRaises(HTTPException) as error:
            await chats.claim(self.session, SimpleNamespace(id='other'), 'run', 'worker')
        self.assertEqual(error.exception.status_code, 404)
        first = await chats.claim(self.session, self.client, 'run', 'worker')
        self.assertEqual(first['input']['runId'], 'run')
        second = await chats.claim(self.session, self.client, 'run', 'other-worker')
        self.assertTrue(second['busy'])

    async def test_manual_ui_reservation_wins_before_worker_poll(self):
        await self.prepare()
        self.assertTrue(chats.reserve_run(self.run, 'ui-instance'))
        await self.session.commit()
        worker = await chats.claim(self.session, self.client, 'run', 'background-worker')
        self.assertTrue(worker['busy'])
        ui = await chats.claim(self.session, self.client, 'run', 'ui-instance')
        self.assertEqual(ui['input']['runId'], 'run')

    async def test_claim_reports_authoritative_trigger_even_when_envelope_claims_manual(self):
        await self.prepare()
        self.run.trigger = 'timer'
        receipt = dict(self.run.receipt)
        receipt['conversationInput'] = {**receipt['conversationInput'], 'trigger': 'manual', 'accessMode': 'full'}
        self.run.receipt = receipt
        await self.session.commit()
        result = await chats.claim(self.session, self.client, 'run', 'worker')
        self.assertEqual(result.get('trigger'), 'timer')

    async def test_completion_is_not_task_acceptance_and_is_idempotent(self):
        await self.prepare(); await chats.claim(self.session, self.client, 'run', 'worker')
        body = {'instanceId': 'worker', 'conversationId': 'ordinary-chat', 'state': 'succeeded'}
        await chats.acknowledge(self.session, self.client, 'run', body)
        self.assertEqual(self.run.state, 'succeeded'); self.assertIsNotNone(self.run.finished_at)
        self.assertEqual(self.run.task_id, ''); self.assertEqual(self.run.workflow_run_id, '')
        await chats.acknowledge(self.session, self.client, 'run', {**body, 'state': 'running'})
        self.assertEqual(self.run.state, 'succeeded')
        result = schedules.run_to_api(self.run)
        self.assertEqual(result['conversationId'], 'ordinary-chat')

    async def test_starting_handshake_publishes_the_created_conversation_before_prompt_ack(self):
        await self.prepare(); await chats.claim(self.session, self.client, 'run', 'worker')
        await chats.acknowledge(self.session, self.client, 'run',
            {'instanceId': 'worker', 'conversationId': 'ordinary-chat', 'state': 'starting'})
        self.assertEqual(self.run.state, 'starting')
        self.assertEqual(self.run.receipt.get('conversationId'), 'ordinary-chat')
        self.assertEqual(self.run.receipt.get('phase'), 'device')
        await chats.acknowledge(self.session, self.client, 'run',
            {'instanceId': 'worker', 'conversationId': 'ordinary-chat', 'state': 'running'})
        self.assertEqual(self.run.state, 'running')
        self.assertEqual(self.run.receipt.get('conversationId'), 'ordinary-chat')
        self.assertNotIn('phase', self.run.receipt)

    async def test_missing_chat_invalid_state_wrong_worker_and_replacement_are_rejected(self):
        await self.prepare(); await chats.claim(self.session, self.client, 'run', 'worker')
        valid = {'instanceId': 'worker', 'conversationId': 'chat', 'state': 'running'}
        for body in [{**valid, 'state': 'unknown'}, {**valid, 'conversationId': ''}, {**valid, 'instanceId': 'intruder'}]:
            with self.assertRaises(HTTPException):
                await chats.acknowledge(self.session, self.client, 'run', body)
        await chats.acknowledge(self.session, self.client, 'run', valid)
        with self.assertRaises(HTTPException):
            await chats.acknowledge(self.session, self.client, 'run', {**valid, 'conversationId': 'different'})

    async def test_waiting_input_and_failure_record_truthful_state(self):
        await self.prepare(); await chats.claim(self.session, self.client, 'run', 'worker')
        await chats.acknowledge(self.session, self.client, 'run',
            {'instanceId': 'worker', 'conversationId': 'chat', 'state': 'waiting'})
        self.assertEqual(self.run.state, 'running')
        self.assertIsNone(self.run.finished_at)
        await chats.acknowledge(self.session, self.client, 'run',
            {'instanceId': 'worker', 'conversationId': 'chat', 'state': 'failed', 'error': 'failure'})
        self.assertEqual(self.run.error, 'failure'); self.assertIsNotNone(self.run.finished_at)

    async def test_cancelled_worker_state_is_projected_as_failure(self):
        await self.prepare(); await chats.claim(self.session, self.client, 'run', 'worker')
        await chats.acknowledge(self.session, self.client, 'run',
            {'instanceId': 'worker', 'conversationId': 'chat', 'state': 'cancelled'})
        self.assertEqual(self.run.state, 'failed')
        self.assertIsNotNone(self.run.finished_at)

if __name__ == '__main__':
    unittest.main()
