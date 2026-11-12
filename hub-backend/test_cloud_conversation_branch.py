import types
import unittest
from unittest.mock import AsyncMock, patch

from app.api.cloud_conversations import branch, directory
from app.api.account_conversations import branch_account_conversation


class Session:
    async def get(self, model, key):
        return types.SimpleNamespace(
            id='task-1', origin='cloud-conversation', owner_client_id='desktop-1',
            owner_user_id='user-1', title='old task', note='initial request',
        )


class CloudBranchTests(unittest.IsolatedAsyncioTestCase):
    async def test_cloud_directory_exposes_same_account_remote_projection_only(self):
        tasks = [
            {"id": "task-mobile", "origin": "cloud-conversation", "title": "from mobile",
             "created": 10, "updatedAt": 20, "createdBy": "user-1",
             "workRouting": {"cloudConversation": {"sessionId": "cloud-mobile"}},
             "ai": {"state": "running"}},
            {"id": "task-foreign", "origin": "cloud-conversation", "title": "foreign",
             "created": 11, "createdBy": "user-2", "workRouting": {}, "ai": {"state": "running"}},
        ]
        rows = {
            "task-mobile": types.SimpleNamespace(
                task_id="task-mobile", owner_user_id="user-1", owner_client_id="mobile-1", transfer_id="request-1",
                phase="committed", receipt={"ref": "run-mobile"},
                source={"sessionId": "cloud-mobile", "adapterId": "pi", "title": "from mobile"},
                options={"assigneeId": "runner:office:pi", "model": "m1", "targetSnapshot": {
                    "runnerId": "runner:office", "runnerName": "Office PC", "runnerKind": "work-computer",
                    "agentId": "pi", "model": "m1"}},
            ),
            "task-foreign": types.SimpleNamespace(
                task_id="task-foreign", owner_user_id="user-2", owner_client_id="other", transfer_id="request-2",
                phase="committed", receipt={"ref": "run-foreign"}, source={}, options={},
            ),
        }
        task_rows = [types.SimpleNamespace(
            id=row["id"], origin=row["origin"], owner_user_id="user-1",
            updated_at=None, created_at=None, archived_at=None,
        ) for row in tasks[:1]]
        class Result:
            def __init__(self, values): self.values = values
            def scalars(self): return self
            def all(self): return self.values
        class DirectorySession:
            def __init__(self): self.calls = 0
            async def execute(self, _query):
                self.calls += 1
                return Result(task_rows if self.calls == 1 else list(rows.values()))
            async def scalars(self, _query):
                return Result([rows["task-mobile"]])
        async def decorate_many(_session, _tasks, apis, _client):
            return apis
        with patch("app.api.cloud_conversations.task_svc.task_to_api", side_effect=lambda task: next(row for row in tasks if row["id"] == task.id)), \
             patch("app.api.cloud_conversations.task_svc.ai_states", new=AsyncMock(return_value={})), \
             patch("app.api.cloud_conversations.task_access.decorate_many", new=AsyncMock(side_effect=decorate_many)):
            result = await directory(types.SimpleNamespace(id="desktop-1", user_ref="user-1"), DirectorySession())
        self.assertEqual([row["id"] for row in result["chats"]], ["cloud-mobile"])
        self.assertEqual(result["chats"][0]["taskId"], "task-mobile")
        self.assertEqual(result["chats"][0]["ref"], "run-mobile")
        self.assertEqual(result["chats"][0]["location"], "work-computer")
        self.assertFalse(result["chats"][0]["readOnly"])
        self.assertTrue(result["chats"][0]["canSend"])
        self.assertFalse(result["chats"][0].get("conversationReview"))

    async def test_branch_rechecks_owner_and_carries_bounded_context_to_new_runner(self):
        handoff = types.SimpleNamespace(
            phase='committed', owner_client_id='desktop-1', owner_user_id='user-1',
            receipt={'activeExecutionSelection': {'agentId': 'pi', 'modelName': 'm1'}},
            options={'agentId': 'pi', 'model': 'm1', 'requiredSkills': []},
            source={'title': 'old task'},
        )
        created = {}
        async def create(_session, _client, request_id, options, files):
            created.update(request_id=request_id, options=options, files=files)
            return {'ok': True, 'taskId': 'new-task', 'ref': 'new-ref'}
        with patch('app.services.conversation_handoffs.dispatch_record', new=AsyncMock(return_value=handoff)), \
             patch('app.services.ai_exec.last_dispatch_event', new=AsyncMock(return_value=types.SimpleNamespace(detail={'ref': 'old-ref'}))), \
             patch('app.services.execution_sessions.read_task', new=AsyncMock(return_value={'items': [
                 {'kind': 'user', 'text': 'old context'}, {'kind': 'assistant', 'text': 'old answer'}
             ]})), \
             patch('app.api.cloud_conversations.svc.create', new=AsyncMock(side_effect=create)):
            result = await branch('task-1', {
                'requestId': 'mobile-branch-1', 'instruction': 'continue on desktop',
                'targetRunnerId': 'desktop-2',
            }, types.SimpleNamespace(id='desktop-1', user_ref='user-1'), Session())
        self.assertEqual(result['taskId'], 'new-task')
        self.assertEqual(result['branch']['targetRunnerId'], 'desktop-2')
        self.assertEqual(created['files'], [])
        self.assertIn('old context', created['options']['text'])
        self.assertIn('continue on desktop', created['options']['text'])
        self.assertEqual(created['options']['targetRunnerId'], 'desktop-2')

    async def test_account_projection_can_continue_from_another_owned_device(self):
        row = types.SimpleNamespace(
            id='account-conversation-1', owner_user_id='user-1',
            source_client_id='desktop-1', deleted=False, revision=7,
            title='电脑上的工作', source_session_id='desktop-session', storage_mode='legacy',
        )

        class Result:
            def all(self):
                return []

        class Session:
            async def scalar(self, _query):
                return row

            async def scalars(self, _query):
                return Result()

        created = {}

        async def create(_session, client, request_id, options, files):
            created.update(client=client, request_id=request_id, options=options, files=files)
            return {'ok': True, 'taskId': 'branched-task', 'ref': 'branched-ref'}

        with patch('app.services.cloud_conversations.create', new=AsyncMock(side_effect=create)):
            result = await branch_account_conversation(
                'branch-from-phone', {
                    'accountConversationId': row.id,
                    'expectedRevision': 7,
                    'instruction': '在我的电脑上继续整理',
                    'agentId': 'pi',
                    'targetRunnerId': 'desktop-1',
                }, types.SimpleNamespace(id='mobile-1', user_ref='user-1'), Session())

        self.assertEqual(result['taskId'], 'branched-task')
        self.assertEqual(created['client'].id, 'mobile-1')
        self.assertEqual(created['options']['targetRunnerId'], 'desktop-1')
        self.assertEqual(created['options']['userText'], '在我的电脑上继续整理')
        self.assertEqual(created['files'], [])


if __name__ == '__main__':
    unittest.main()
