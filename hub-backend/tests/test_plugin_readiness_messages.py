"""Readiness messages preserve the legacy API and business values."""
from types import SimpleNamespace
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault('DATABASE_URL', 'sqlite+aiosqlite:///:memory:')
os.environ.setdefault('AUTH_SECRET', 'isolated-plugin-message-test-secret')
from app.services import plugin_readiness, plugin_route_readiness, workflow_inputs, mcp_servers


class PluginReadinessMessagesTests(unittest.IsolatedAsyncioTestCase):
    async def test_simulation_returns_templates_without_translating_project_names(self):
        version = SimpleNamespace(trust_state='approved', enabled=True, workflow={'nodes': []})
        project = SimpleNamespace(id='fixture', name='保存 {count}')
        with patch.object(plugin_readiness, 'binding_readiness', AsyncMock(return_value={'blockers': [], 'warnings': []})), \
             patch.object(workflow_inputs, 'plugin_skills', AsyncMock(return_value=[{'bundled': True}, {'bundled': False}])):
            result = await plugin_readiness.simulate(None, version, project, None)
        self.assertEqual(result['project']['name'], '保存 {count}')
        checks = {row['key']: row for row in result['checks']}
        self.assertEqual(checks['skills']['detailMessage']['params'], {'count': 2, 'bundled': 1})
        self.assertIn('2', checks['skills']['detail'])
        self.assertEqual(checks['trust']['detailMessage']['key'], 'plugin.trust.ready')
        self.assertTrue(all(row['labelMessage']['fallback'] == row['label'] for row in result['checks']))

    async def test_workflow_without_ai_has_a_translatable_route_result(self):
        result = await plugin_route_readiness.check(None, SimpleNamespace(workflow={'nodes': []}))
        self.assertEqual(result['check']['detailMessage']['key'], 'plugin.routes.unneeded')
        self.assertTrue(result['check']['detail'])

    def app_version(self, names=('business',), source_type='external', capabilities=('mcp.connect',)):
        source = {'type': source_type, 'url': 'https://business.invalid/app',
                  'bridge': {'capabilities': list(capabilities)}}
        return SimpleNamespace(trust_state='approved', enabled=True, workflow={'nodes': []},
                               capability_report={'mcpServers': list(names)},
                               manifest={'ui': {'contributions': [
                                   {'id': 'main', 'slot': 'workspace.navigation', 'source': source}]}})

    async def test_app_simulation_does_not_register_company_mcp_or_claim_live_verification(self):
        with patch.object(mcp_servers, 'readiness', AsyncMock()) as company, \
             patch.object(workflow_inputs, 'plugin_skills', AsyncMock(return_value=[])):
            result = await plugin_readiness.simulate(None, self.app_version(), None, None, binding_config={})
        self.assertTrue(result['ok'], result['blockers'])
        company.assert_not_awaited()
        checks = {row['key']: row for row in result['checks']}
        self.assertEqual(checks['app-mcp']['verification'], 'declaration')
        self.assertNotIn('mcp-tools', checks)
        self.assertTrue(any('未验证用户凭据或服务连通性' in warning for warning in result['warnings']))

    async def test_ordinary_hub_workflow_still_requires_company_connection_and_tool_grants(self):
        with patch.object(mcp_servers, 'readiness', AsyncMock(return_value={
                'ok': False, 'available': [], 'missing': ['business']})) as company:
            result = await plugin_readiness.binding_readiness(None, self.app_version(), None, None, binding_config={})
        company.assert_awaited_once_with(None, ['business'])
        self.assertFalse(result['ok'])
        self.assertEqual({row['key'] for row in result['checks']}, {'mcp', 'mcp-tools'})

    async def test_hosted_package_mcp_uses_the_same_owned_declaration_rule(self):
        version = self.app_version(('soduwork-jiyong',), source_type='package')
        version.manifest['jiyong'] = {'mcp': {'server': 'soduwork-jiyong'}}
        with patch.object(mcp_servers, 'readiness', AsyncMock()) as company:
            result = await plugin_readiness.binding_readiness(
                None, version, None, None, binding_config={}, application_context=True)
        company.assert_not_awaited()
        self.assertTrue(result['ok'])
        self.assertEqual(result['checks'][0]['key'], 'app-mcp')

    async def test_ambiguous_or_undeclared_app_connections_do_not_bypass_company_checks(self):
        for version in (self.app_version(('business', 'company')), self.app_version(capabilities=()),
                        self.app_version(source_type='package')):
            names = version.capability_report['mcpServers']
            with self.subTest(names=names, manifest=version.manifest), \
                 patch.object(mcp_servers, 'readiness', AsyncMock(return_value={
                     'ok': False, 'available': [], 'missing': names})) as company:
                result = await plugin_readiness.binding_readiness(
                    None, version, None, None, binding_config={}, application_context=True)
            company.assert_awaited_once_with(None, names)
            self.assertFalse(result['ok'])
