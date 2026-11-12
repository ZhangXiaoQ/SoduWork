"""Host isolation with real scoped discovery/API and stubbed execution transport.

Imports the existing migrated temporary-DB fixture before app modules. No live
service, business database, vendor process or model credential is used.
"""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import test_handoff_target_diagnostics as fixture
from fastapi import HTTPException
from app import db, models
from app.api import cloud_environments as environments_api
from app.api import cloud_conversations as conversations_api
from app.automation_models import RunnerNode
from app.config import Settings, get_settings
from app.services import (ai_exec, ai_local, ai_remote, cloud_conversations,
                          conversation_handoffs as handoffs, execution_host_policy as policy,
                          runner_hub)


class HostPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # Tests start with explicit compatibility settings, never the deployment
        # .env. Per-case restrictions stack on this patch; cleanup restores the
        # original process settings even if fixture setup or an assertion fails.
        self.restrict(local=True)
        await fixture.TargetDiagnosticsTests.asyncSetUp(self)

    asyncTearDown = fixture.TargetDiagnosticsTests.asyncTearDown
    live = fixture.TargetDiagnosticsTests.live
    catalog = fixture.TargetDiagnosticsTests.catalog
    enroll_personal = fixture.TargetDiagnosticsTests.enroll_personal

    def restrict(self, *runner_ids, local=False):
        gate = patch.multiple(get_settings(), cloud_execution_runner_ids=','.join(runner_ids),
                              hub_local_execution_enabled=local)
        gate.start()
        self.addCleanup(gate.stop)

    async def test_defaults_and_exact_list_parsing(self):
        settings = Settings(_env_file=None, cloud_execution_runner_ids='', hub_local_execution_enabled=True)
        with patch.object(policy, 'get_settings', return_value=settings):
            self.assertTrue(policy.cloud_runner_allowed('any-shared-node'))
            self.assertTrue(policy.hub_local_allowed())
            settings.cloud_execution_runner_ids = ' cloud-fixture, second , '
            self.assertTrue(policy.cloud_runner_allowed('cloud-fixture'))
            self.assertTrue(policy.cloud_runner_allowed('second'))
            self.assertFalse(policy.cloud_runner_allowed('cloud-fixture-extra'))
            self.assertFalse(policy.cloud_runner_allowed('CLOUD-fixture'))
            self.assertTrue(policy.cloud_runner_allowed('employee', 'my-device'))
            settings.cloud_execution_runner_ids = ' , , '
            self.assertFalse(policy.cloud_runner_allowed('any-shared-node'))

    async def test_allowlist_filters_targets_diagnostics_and_user_cloud_inventory(self):
        self.app.include_router(environments_api.router)
        allowed, infra = self.live('fixture'), self.live('trial-infra')
        self.restrict(allowed.id)
        await self.enroll_personal(allowed)
        async with db.SessionLocal() as session:
            session.add(RunnerNode(id=infra.id, host=infra.host, org_id=self.org))
            await session.commit()
        for suffix in ('', '?agentId=codex'):
            reply = await self.http.get('/api/v1/conversation-handoffs/targets' + suffix)
            self.assertEqual(reply.status_code, 200, reply.text)
            data = reply.json()
            self.assertEqual([n['runnerId'] for n in data['targets']], [allowed.id])
            self.assertEqual([n['runnerId'] for n in data['diagnostics']['nodes']], [allowed.id])
            self.assertNotIn(infra.id, reply.text)
        listing = await self.http.get('/api/v1/cloud-environments')
        self.assertEqual(listing.status_code, 200, listing.text)
        self.assertEqual([n['id'] for n in listing.json()['environments']], [allowed.id])
        # Management keeps the owned environment visible even when deployment
        # policy pauses its use; diagnostics explain the restriction without
        # exposing shared infrastructure.
        with patch.object(get_settings(), 'cloud_execution_runner_ids', infra.id):
            restricted = await self.catalog()
            self.assertEqual(restricted['targets'], [])
            self.assertEqual([(n['runnerId'], n['code']) for n in restricted['diagnostics']['nodes']],
                             [(allowed.id, 'deployment_restricted')])
            inventory = await self.http.get('/api/v1/cloud-environments')
            self.assertEqual([n['id'] for n in inventory.json()['environments']], [allowed.id])
            self.assertNotIn(infra.id, inventory.text)
        runner_hub._RUNNERS.pop(allowed.id)
        self.assertEqual((await self.catalog())['targets'], [])
        offline = await self.http.get('/api/v1/cloud-environments')
        self.assertEqual([n['id'] for n in offline.json()['environments']], [allowed.id])

    async def test_automatic_selection_rechecks_list_and_never_falls_back_to_infra(self):
        allowed, infra = self.live('142'), self.live('149-infra')
        await self.enroll_personal(allowed)
        candidates = (await self.catalog())['targets']
        self.assertEqual([n['runnerId'] for n in candidates], [allowed.id])
        # A stale catalog entry must still fail the final deployment allowlist.
        candidates.append({'id': 'runner:' + infra.id + ':codex',
                           'runnerId': infra.id, 'agentId': 'codex'})
        self.restrict(allowed.id)
        self.assertEqual([n['runnerId'] for n in handoffs._automatic_targets(candidates)], [allowed.id])
        with patch.object(runner_hub, 'has_capacity', side_effect=lambda node: node is infra):
            self.assertEqual(handoffs._automatic_targets(candidates), [])
        runner_hub._RUNNERS.pop(allowed.id)
        self.assertEqual(handoffs._automatic_targets(candidates), [])

    async def test_final_destination_rejects_stale_or_explicit_disallowed_target(self):
        allowed, infra = self.live('fixture'), self.live('trial-infra')
        self.restrict(allowed.id)
        async with db.SessionLocal() as session:
            client = await session.get(models.Client, self.client_id)
            with self.assertRaises(HTTPException) as caught:
                await handoffs.destination(session, client, {'assigneeId': 'runner:' + infra.id + ':codex'})
            self.assertEqual(caught.exception.status_code, 409)
            # Even a stale pre-selection cannot bypass the final live-host gate.
            stale = {'id': 'runner:' + infra.id + ':codex', 'runnerId': infra.id, 'agentId': 'codex'}
            with patch.object(handoffs, 'targets', AsyncMock(return_value=[stale])), \
                 patch.object(ai_exec, 'load', new_callable=AsyncMock) as load:
                with self.assertRaises(HTTPException) as caught:
                    await handoffs.destination(session, client, {'assigneeId': stale['id']})
                self.assertEqual(caught.exception.status_code, 409)
                load.assert_not_awaited()

    async def test_direct_cloud_entry_without_allowed_host_has_no_dispatch(self):
        self.app.include_router(conversations_api.router)
        self.live('trial-infra')
        self.restrict('cloud-fixture')
        async with db.SessionLocal() as session:
            client = await session.get(models.Client, self.client_id)
            with patch.object(handoffs, 'commit', new_callable=AsyncMock) as commit:
                with self.assertRaises(HTTPException) as caught:
                    await cloud_conversations.create(session, client, 'no-fallback',
                        {'sessionId': 'cloud-session', 'agentId': 'codex', 'title': 'Cloud task',
                         'text': 'Write a report', 'model': '', 'requiredSkills': []}, [])
                self.assertEqual(caught.exception.status_code, 409)
                commit.assert_not_awaited()

    async def test_scope_and_employee_devices_are_not_broadened_or_disabled(self):
        own = self.live('owned-desktop', client_id=self.other_id)
        foreign = self.live('foreign', org_id=self.foreign_org)
        self.restrict(foreign.id)
        async with db.SessionLocal() as session:
            session.add(RunnerNode(id=own.id, org_id=self.org, client_id=self.other_id))
            await session.commit()
        data = await self.catalog()
        self.assertEqual([n['runnerId'] for n in data['targets']], [own.id])
        auto = await self.http.get('/api/v1/conversation-handoffs/targets?agentId=codex')
        self.assertEqual([n['runnerId'] for n in auto.json()['targets']], [own.id])
        self.assertNotIn(foreign.id, auto.text)

    async def test_hub_disabled_blocks_fallback_explicit_and_default_dispatch(self):
        self.restrict()
        ctx = {'name': 'local', 'cfg': {}}
        with patch.object(ai_local, 'resolve_assignee_sync') as resolve, \
             patch.object(ai_local, 'dispatch_sync') as dispatch:
            self.assertIsNone(ai_exec.resolve_kind(ctx, 'local:codex'))
            self.assertIsNone(ai_exec.resolve_assignee_sync(ctx, 'local:codex'))
            for target in ({'id': 'local:codex'}, None):
                result = ai_exec.dispatch_sync(ctx, SimpleNamespace(id='isolated-task'), assignee=target)
                self.assertFalse(result['ok'])
                self.assertEqual(result['code'], 'HUB_LOCAL_EXECUTION_DISABLED')
            resolve.assert_not_called()
            dispatch.assert_not_called()
        with patch.object(ai_local, 'configured', return_value=True):
            self.assertFalse(ai_exec.available(ctx))

    async def test_hub_disable_preserves_runner_routing_and_operational_dispatch(self):
        worker, infra = self.live('fixture'), self.live('trial-deployment')
        self.restrict(worker.id)
        ctx = {'name': 'local', 'cfg': {}}
        selected = ai_exec.resolve_kind(ctx, 'local:codex', prefer_runner=worker.id)
        self.assertEqual(selected['id'], 'runner:' + worker.id + ':codex')
        with patch.object(ai_remote, 'dispatch_sync', return_value={'ok': True, 'issueId': 'remote'}) as dispatch:
            result = ai_exec.dispatch_sync(ctx, SimpleNamespace(id='deploy'),
                assignee={'id': 'runner:' + infra.id + ':codex'})
            self.assertTrue(result['ok'])
            dispatch.assert_called_once()
            dispatch.reset_mock()
            denied = ai_exec.dispatch_sync({**ctx, '_cloudExecution': True}, SimpleNamespace(id='cloud'),
                assignee={'id': 'runner:' + infra.id + ':codex', 'clientId': 'forged-personal'})
            self.assertEqual(denied['code'], 'CLOUD_RUNNER_NOT_ALLOWED')
            dispatch.assert_not_called()
            accepted = ai_exec.dispatch_sync({**ctx, '_cloudExecution': True}, SimpleNamespace(id='cloud'),
                assignee={'id': 'runner:' + worker.id + ':codex'})
            self.assertTrue(accepted['ok'])

    async def test_hub_disabled_leaves_standalone_adapter_and_historical_reads_available(self):
        self.restrict()
        ctx = {'name': 'local', 'cfg': {}}
        with patch.object(ai_local, '_dispatch_sync_once', return_value={'ok': True}) as start:
            self.assertTrue(ai_local.dispatch_sync({}, SimpleNamespace(id='runner-task'))['ok'])
            start.assert_called_once()
        with patch.object(ai_exec, '_by_ref', return_value=ai_local), \
             patch.object(ai_local, 'status_sync', return_value={'ok': True, 'state': 'done'}) as status, \
             patch.object(ai_local, 'session_sync', return_value={'ok': True, 'items': ['past']}) as history, \
             patch.object(ai_local, 'fetch_attachment_for_sync', return_value=b'past-file') as artifact, \
             patch.object(ai_local, 'comment_sync') as comment:
            self.assertTrue(ai_exec.status_sync(ctx, 'old')['ok'])
            self.assertEqual(ai_exec.session_sync(ctx, 'old')['items'], ['past'])
            self.assertEqual(ai_exec.fetch_attachment_for_sync(ctx, 'old', 'file'), b'past-file')
            self.assertEqual(ai_exec.say_sync(ctx, 'old', 'run again')['code'], 'HUB_LOCAL_EXECUTION_DISABLED')
            status.assert_called_once()
            history.assert_called_once()
            artifact.assert_called_once()
            comment.assert_not_called()

    async def test_default_settings_keep_hub_execution_but_require_personal_cloud_ownership(self):
        self.restrict(local=True)
        legacy = self.live('legacy-cloud')
        async with db.SessionLocal() as session:
            session.add(RunnerNode(id=legacy.id, org_id=self.org))
            await session.commit()
        self.assertEqual((await self.catalog())['targets'], [])
        node = self.live('personal-cloud')
        await self.enroll_personal(node)
        data = await self.catalog()
        self.assertEqual([n['runnerId'] for n in data['targets']], [node.id])
        self.assertNotIn(legacy.id, str(data))
        runner_hub._RUNNERS.clear()
        ctx = {'name': 'local', 'cfg': {}}
        with patch.object(ai_local, 'resolve_assignee_sync', return_value={'id': 'local:codex'}), \
             patch.object(ai_local, 'dispatch_sync', return_value={'ok': True}) as dispatch:
            self.assertEqual(ai_exec.resolve_kind(ctx, 'local:codex')['id'], 'local:codex')
            self.assertTrue(ai_exec.dispatch_sync(ctx, SimpleNamespace(id='legacy'), assignee={'id': 'local:codex'})['ok'])
            dispatch.assert_called_once()


if __name__ == '__main__':
    unittest.main()
