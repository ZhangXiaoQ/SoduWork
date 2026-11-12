import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from fastapi import HTTPException
from app.api import tasks
from app.services import ai_exec, execution_sessions, local_stream, runtime_messages


class LiveOutputTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # These tests isolate transcript routing; acceptance/access have their
        # own integration coverage and require real database models.
        from app.services import cloud_acceptance, task_access
        acceptance = patch.object(cloud_acceptance, 'status', AsyncMock(return_value=None))
        access = patch.object(task_access, 'can_continue_execution', return_value=True)
        acceptance.start()
        access.start()
        self.addCleanup(acceptance.stop)
        self.addCleanup(access.stop)

    async def test_foreign_execution_is_rejected_before_runner_access(self):
        session = SimpleNamespace(execute=AsyncMock(return_value=Mock(scalar_one_or_none=Mock(return_value=None))))
        with patch.object(tasks, '_view_task', AsyncMock(return_value=SimpleNamespace(id='t'))), patch.object(ai_exec, 'load', AsyncMock()) as load:
            with self.assertRaises(HTTPException) as error:
                await tasks.ai_session_task(tid='t', ref='another-task-ref', since=0, client=None, session=session)
            self.assertEqual(error.exception.status_code, 404)
            load.assert_not_called()

    async def test_exact_ref_and_incremental_cursor_survive_read_through(self):
        row = SimpleNamespace(runner_id='runner', engine='pi', model='test')
        session = SimpleNamespace(execute=AsyncMock(return_value=Mock(scalar_one_or_none=Mock(return_value=row))), commit=AsyncMock())
        with patch.object(tasks, '_view_task', AsyncMock(return_value=SimpleNamespace(id='t'))), patch.object(ai_exec, 'load', AsyncMock(return_value={})), patch.object(ai_exec, 'session_sync', return_value={'ok': True}) as read, patch.object(execution_sessions, 'ingest_live_snapshot', AsyncMock()), patch.object(execution_sessions, 'read_task', AsyncMock(return_value={'ok': True, 'ref': 'r', 'items': []})) as cached:
            await tasks.ai_session_task(tid='t', ref='r', since=401, client=None, session=session)
            read.assert_called_once_with({}, 'r', 401)
            cached.assert_awaited_once_with(session, 't', 'r', 401, limit=400)

    def test_pi_tool_identity_error_and_complete_output_are_preserved(self):
        rows = local_stream._items_from({'type': 'tool_execution_end', 'toolCallId': 'call', 'toolName': 'bash', 'isError': True,
            'result': {'content': [{'type': 'text', 'text': 'result' * 900}]}})
        self.assertEqual(rows[0]['callId'], 'call')
        self.assertTrue(rows[0]['isError'])
        self.assertEqual(len(rows[0]['full']), 5400)
        value = execution_sessions._event_api(SimpleNamespace(seq=1, kind='out', tool='bash', text='preview', at=None, detail=rows[0]))
        self.assertEqual(value['full'], rows[0]['full'])
        self.assertEqual(value['callId'], 'call')

    def test_structured_cloud_preview_metadata_is_public(self):
        value = execution_sessions._event_api(SimpleNamespace(
            seq=2, kind='out', tool='bash', text='ready', at=None,
            detail={'serviceUrl': 'http://192.0.2.20:4173/', 'host': '192.0.2.20',
                    'port': 4173, 'services': [{'url': 'http://192.0.2.20:4173/'}]}))
        self.assertEqual(value['serviceUrl'], 'http://192.0.2.20:4173/')
        self.assertEqual(value['host'], '192.0.2.20')
        self.assertEqual(value['port'], 4173)
        self.assertEqual(value['services'][0]['url'], 'http://192.0.2.20:4173/')
        projected = runtime_messages.public_fields({
            'serviceUrl': 'http://192.0.2.20:4173/', 'host': '192.0.2.20',
            'port': 4173, 'services': [{'url': 'http://192.0.2.20:4173/'}]})
        self.assertEqual(projected['serviceUrl'], 'http://192.0.2.20:4173/')
        self.assertEqual(projected['port'], 4173)


if __name__ == '__main__': unittest.main()
