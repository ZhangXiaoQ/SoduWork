"""Per-turn skill authorization and delivery without a model or real Runner."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from app.services import conversation_turn_skills as turns
from app.services import execution_capabilities, local_base, local_stream
from app.services import runner_comments, runner_hub, skills, skill_read_scope
from app.services.runner_admission import comment_digest


class TurnSkillTests(unittest.IsolatedAsyncioTestCase):
    async def test_hub_requires_original_runner_inventory_policy_and_account(self):
        session = SimpleNamespace(scalar=AsyncMock(return_value=SimpleNamespace(runner_id='original')))
        client = SimpleNamespace(user_ref='owner')
        handoff = SimpleNamespace(phase='committed', owner_user_id='owner', task_id='task')
        runner = SimpleNamespace(caps=['admit1', 'turnSkills1'], skills_known=True, skills=['office'])
        with patch.object(runner_hub, 'get', return_value=runner) as lookup, \
                patch.object(runner_hub, 'supports_capabilities', return_value=True) as caps, \
                patch.object(skills, 'resolve_named', AsyncMock()) as policy:
            await turns.validate(session, client, handoff, 'original-ref', ['office'])
            lookup.assert_called_with('original')
            policy.assert_awaited_once_with(session, ['office'], client)
            for field, value in [('caps', ['admit1']), ('skills_known', False), ('skills', [])]:
                original = getattr(runner, field)
                setattr(runner, field, value)
                with self.assertRaises(HTTPException):
                    await turns.validate(session, client, handoff, 'original-ref', ['office'])
                setattr(runner, field, original)
            caps.return_value = False
            with self.assertRaises(HTTPException):
                await turns.validate(session, client, handoff, 'original-ref', ['office'])
            caps.return_value = True
            policy.side_effect = ValueError('Administrator denied')
            with self.assertRaises(HTTPException) as denied:
                await turns.validate(session, client, handoff, 'original-ref', ['office'])
            self.assertEqual(denied.exception.status_code, 403)
            client.user_ref = 'other'
            with self.assertRaises(HTTPException):
                await turns.validate(session, client, handoff, 'original-ref', ['office'])

    async def test_runner_delivers_selected_local_skill_scope_on_same_ref(self):
        with tempfile.TemporaryDirectory() as root:
            entry = Path(root) / 'SKILL.md'
            entry.write_text('Create documents', encoding='utf-8')
            machine = SimpleNamespace(_refresh_skills=AsyncMock(), work_root=root,
                capability_grants=[], _skill_catalog=[{'name': 'office', 'path': root,
                    'description': 'Create documents'}])
            message = {'ref': 'existing', 'text': 'Write about snow', 'turnId': 'one',
                'turnSkills': ['office'], 'recordUser': True, '_admitted': True}
            with patch.dict(local_base._RUNS, {'existing': {'state': 'done'}}), \
                    patch.object(execution_capabilities, 'runtime_report', return_value={}), \
                    patch.object(execution_capabilities, 'evaluate', return_value={'ok': True}) as available, \
                    patch.object(local_stream, 'comment_sync', return_value={'ok': True}) as send, \
                    patch.object(local_stream, 'record_user_sync') as record:
                result = await runner_comments.comment(machine, message, lambda *_: [])
                self.assertTrue(result['ok'])
                cfg, ref, text = send.call_args.args
                self.assertEqual(ref, 'existing')
                self.assertIn(root, text)
                self.assertIn('office', text)
                record.assert_called_once_with('existing', 'Write about snow', [], None, None)
                scoped = {'ws': root}
                skill_read_scope.for_run(scoped, cfg)
                self.assertTrue(scoped['_skillReadScope'].allows(root, str(entry)))
                send.reset_mock()
                available.return_value = {'ok': False}
                self.assertFalse((await runner_comments.comment(machine, message, lambda *_: []))['ok'])
                send.assert_not_called()
                available.return_value = {'ok': True}
                entry.unlink()
                self.assertFalse((await runner_comments.comment(machine, message, lambda *_: []))['ok'])
                send.assert_not_called()

    def test_invalid_selection_and_duplicate_identity(self):
        for value in ['office', ['../private'], [{'path': 'private'}]]:
            with self.assertRaises(HTTPException):
                turns.normalize(value)
        self.assertEqual(turns.normalize(['office', 'office']), ['office'])
        original = {'text': 'Same text', 'turnSkills': ['office']}
        self.assertNotEqual(comment_digest('ref', original),
            comment_digest('ref', {**original, 'turnSkills': ['browser-use']}))


if __name__ == '__main__':
    unittest.main()
