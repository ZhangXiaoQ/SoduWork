from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import build
import hub
import postgres


class Response(io.BytesIO):
    def __init__(self, body, kind):
        super().__init__(body)
        self.headers = {'Content-Type': kind}


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.ctx = {'component': 'hub', 'version': '1.2.3', 'commit': 'a' * 40, 'runId': '123'}

    def test_download_rejects_a_replaced_dependency(self):
        with patch.object(build.urllib.request, 'urlopen', return_value=io.BytesIO(b'replaced')):
            with self.assertRaisesRegex(ValueError, 'digest differs'):
                build.download('https://example.test/file', self.root / 'file', hashlib.sha256(b'expected').hexdigest())

    def test_android_requires_reviewed_mobile_source(self):
        with patch.object(build, 'ROOT', self.root), patch.object(build.platform, 'system', return_value='Linux'), \
                self.assertRaisesRegex(ValueError, 'reviewed mobile'):
            build.android(self.ctx | {'component': 'client'}, self.root, self.root)

    def test_public_macos_build_requires_developer_id_and_notarization(self):
        with self.assertRaisesRegex(ValueError, 'SODUWORK_MAC_SIGN_IDENTITY'):
            build.configure_macos_signing({})
        with self.assertRaisesRegex(ValueError, 'cannot skip notarization'):
            build.configure_macos_signing({
                'SODUWORK_MAC_SIGN_IDENTITY': 'Developer ID Application: SoduWork (TEAM123)',
                'SODUWORK_MAC_SKIP_NOTARIZE': 'true',
            })
        env = {'SODUWORK_MAC_SIGN_IDENTITY': 'Developer ID Application: SoduWork (TEAM123)'}
        self.assertIs(build.configure_macos_signing(env), env)
        self.assertEqual(env['SODUWORK_MAC_RELEASE'], '1')
        self.assertEqual(env['SODUWORK_MAC_REAL_KEYCHAIN'], '1')

    def test_validation_macos_build_keeps_ad_hoc_signing_isolated(self):
        env = {}
        self.assertIs(build.configure_macos_signing(env, validation=True), env)
        self.assertNotIn('SODUWORK_MAC_RELEASE', env)
        self.assertNotIn('SODUWORK_MAC_REAL_KEYCHAIN', env)

    def test_postgres_refuses_non_fixture_databases_before_running_commands(self):
        for url in ['postgresql+asyncpg://user:fixture@db.example.test/soduwork_ci',
                    'postgresql+asyncpg://user:fixture@127.0.0.1/production']:
            with patch.dict(postgres.os.environ, DATABASE_URL=url), patch.object(postgres.subprocess, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'local disposable'):
                    postgres.main()
                run.assert_not_called()

    def exercise_hub(self, fault=None):
        calls = []
        inspections = 0
        def docker(*args, **kwargs):
            nonlocal inspections
            calls.append(args)
            if args[:2] == ('image', 'inspect'):
                inspections += 1
                return 'sha256:' + ('b' if fault == 'export' and inspections == 2 else 'a') * 64
            if args[0] == 'inspect':
                return 'sha256:' + 'a' * 64
            if args[0] == 'port':
                return '127.0.0.1:12345'
            return ''
        def response(url, **kwargs):
            if url.endswith('/readyz'):
                return Response(b'{"ready":true}', 'application/json')
            if url.endswith('/healthz'):
                return Response(json.dumps({'ok': True, 'version': '1.2.3',
                    'commit': 'bad' if fault == 'identity' else self.ctx['commit']}).encode(), 'application/json')
            if url.endswith('/assets/index.js'):
                return Response(b'fixture JS' if fault != 'asset' else b'<html>',
                                'application/javascript' if fault != 'asset' else 'text/html')
            return Response(b'<script type="module" src="/assets/index.js"></script>', 'text/html')
        process = type('Process', (), {'stdout': io.BytesIO(b'image export fixture'), 'wait': lambda self: 0})()
        with patch.object(hub, 'docker', side_effect=docker), patch.object(hub, 'wait', side_effect=lambda fn: fn()), \
                patch.object(hub.urllib.request, 'urlopen', side_effect=response), \
                patch.object(hub.subprocess, 'Popen', return_value=process):
            try:
                return hub.build_and_accept(self.ctx, self.root), calls
            finally:
                self.assertEqual(len([c for c in calls if c[:3] == ('rm', '-f', '-v')]), 2)
                self.assertTrue(any(c[:2] == ('network', 'rm') for c in calls))

    def test_hub_accepts_and_exports_only_the_running_image(self):
        result, calls = self.exercise_hub()
        self.assertTrue(result['ok'])
        self.assertIn('image-export-load', result['checks'])
        self.assertTrue(any(c[0] == 'restart' for c in calls))
        self.assertTrue((self.root / 'SoduWork-1.2.3-hub-image.tar.gz').exists())

    def test_wrong_health_identity_missing_script_and_replaced_export_fail(self):
        for fault in ['identity', 'asset', 'export']:
            with self.subTest(fault=fault), self.assertRaises(ValueError):
                self.exercise_hub(fault)
