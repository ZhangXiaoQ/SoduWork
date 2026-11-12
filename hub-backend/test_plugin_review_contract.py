"""File reviewers use typed decisions; code reviewers still pin Git evidence."""
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from app.services import workflow_contracts as contract, workflow_inputs


class MissingDeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_finished_agent_with_missing_delivery_records_contract_failure(self):
        from contextlib import ExitStack
        from app.services import workflow_engine as workflow
        task = SimpleNamespace(id="task")
        session = SimpleNamespace(get=AsyncMock(return_value=task))
        run = SimpleNamespace(id="run", task_id=task.id, context={})
        node = SimpleNamespace(id="node", node_key="write", node_type="ai", state="running",
                               executor={}, output={}, error="", started_at=None, finished_at=None)
        version = SimpleNamespace(workflow={"nodes": [{"key": "write", "type": "ai",
            "outputs": [{"kind": "file", "path": "report.pdf", "required": True}]}]})
        with ExitStack() as stack:
            for name in ("_forget_ai_unreachable", "_forget_output_settle", "_event"):
                stack.enter_context(patch.object(workflow, name))
            stack.enter_context(patch.object(workflow, "_restore_ai_route", return_value=("ref", "runner")))
            stack.enter_context(patch.object(workflow, "_node_timed_out", return_value=(False, 0)))
            stack.enter_context(patch.object(workflow, "_wait_for_output_settle", return_value=False))
            stack.enter_context(patch.object(workflow, "_node_config", AsyncMock(return_value={})))
            stack.enter_context(patch.object(workflow, "_version", AsyncMock(return_value=version)))
            stack.enter_context(patch.object(workflow, "_begin_rework", AsyncMock(return_value=False)))
            stack.enter_context(patch.object(workflow, "_rework_evidence", return_value="missing delivery"))
            stack.enter_context(patch.object(workflow.ai_exec, "load", AsyncMock(return_value={})))
            stack.enter_context(patch.object(workflow.ai_exec, "status_sync", return_value={
                "ok": True, "done": True, "running": False, "text": "Agent claims completion"}))
            decision = stack.enter_context(patch.object(workflow, "_completion_decision", AsyncMock()))
            await workflow._poll_node(session, run, node)
        self.assertEqual(node.state, "failed")
        self.assertEqual(node.output["failureKind"], "contract")
        self.assertTrue(node.output["outputReceipt"]["missing"])
        self.assertIsNotNone(node.finished_at)
        decision.assert_not_awaited()


class ReviewModeTests(unittest.TestCase):
    def test_all_bundled_office_reviews_are_file_reviews(self):
        keys = ['deep-research', 'diagram-studio', 'document-studio', 'knowledge-synthesis',
                'meeting-to-action', 'pdf-toolbox', 'presentation-studio', 'product-prototype',
                'spreadsheet-analyst', 'web-collect']
        for key in keys:
            manifest = json.loads((Path(__file__).parent/'plugins'/f'{key}.json').read_text(encoding='utf-8-sig'))
            for node in manifest['workflow']['nodes']:
                if node['type'] == 'ai_review':
                    self.assertFalse(contract.ai_review_requires_code(manifest['workflow'], node), key)
                    self.assertIn('UTF-8 JSON', contract.decision_prompt(node))
                    self.assertTrue(any(x.get('required') and x['kind'] == 'decision' for x in node['outputs']))

    def test_bundled_code_delivery_reviews_remain_code_reviews(self):
        keys = ['engineering-delivery', 'software-delivery',
                'soduwork-bugfix-149', 'delivery-req-184', 'autonomous-dev-iterator']
        for key in keys:
            manifest = json.loads((Path(__file__).parent/'plugins'/f'{key}.json').read_text(encoding='utf-8-sig'))
            for node in manifest['workflow']['nodes']:
                if node['type'] == 'ai_review':
                    self.assertTrue(contract.ai_review_requires_code(manifest['workflow'], node), key)

    def test_legacy_and_auto_code_review_cannot_fall_back_to_file_review(self):
        for node in [{}, {'config': {'mode': 'auto'}, 'outputs': [{'kind': 'decision'}]},
                     {'outputs': [{'kind': 'file', 'path': 'code-review.json'}]}]:
            self.assertTrue(contract.ai_review_requires_code({}, node))

    def test_transitive_git_output_requires_fixed_code_review(self):
        node = {'key': 'review', 'dependsOn': ['check'], 'outputs': [{'kind': 'decision'}]}
        graph = {'nodes': [{'key': 'work', 'outputs': [{'kind': 'git'}]},
                           {'key': 'check', 'dependsOn': ['work']}, node]}
        self.assertTrue(contract.ai_review_requires_code(graph, node))

    def test_decision_prompt_preserves_declared_path_and_no_fake_pass(self):
        prompt = contract.decision_prompt({'outputs': [{'kind': 'decision', 'path': 'reviews/old-review.md'}]})
        for value in ['reviews/old-review.md', 'schemaVersion=1', 'blocked', 'nextAction', '不得']:
            self.assertIn(value, prompt)
        self.assertEqual(contract.decision_prompt({'outputs': [{'kind': 'file'}]}), '')


class FileDecisionTests(unittest.IsolatedAsyncioTestCase):
    async def parse(self, data, node_id='current'):
        row = SimpleNamespace(id='evidence', filename='reviews/meeting-review.md',
                              node_run_id=node_id, size=80, storage_key='private', backend='test')
        result = Mock()
        result.scalars.return_value.all.return_value = [row]
        session = SimpleNamespace(execute=AsyncMock(return_value=result))
        raw = json.dumps(data).encode() if isinstance(data, dict) else data
        with patch.object(workflow_inputs.storage, 'get', return_value=raw):
            return await workflow_inputs.node_decision(session, 'test-task', row.filename, node_run_id='current')

    async def test_strict_pass_and_blocked_results_are_preserved(self):
        data = {'schemaVersion': 1, 'outcome': 'proceed', 'summary': 'Compared source and both files',
                'reasonCode': 'ready', 'evidence': ['minutes paragraph 2', 'sheet row 3']}
        self.assertEqual((await self.parse(data))['outcome'], 'proceed')
        data.update(outcome='blocked', reasonCode='missing_input', nextAction='Provide original meeting notes')
        self.assertEqual((await self.parse(data))['outcome'], 'blocked')

    async def test_markdown_or_unstructured_report_does_not_pass(self):
        for invalid in [b'# Review\nLooks good', {'verdict': 'pass'},
                        {'schemaVersion': 1, 'outcome': 'proceed', 'summary': ''}]:
            with self.assertRaises(contract.WorkflowContractError):
                await self.parse(invalid)

    async def test_previous_attempt_cannot_supply_current_decision(self):
        with self.assertRaises(contract.WorkflowContractError):
            await self.parse({'schemaVersion': 1, 'outcome': 'proceed', 'summary': 'Old pass'}, 'old')


if __name__ == '__main__':
    unittest.main()
