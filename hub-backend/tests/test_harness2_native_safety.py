"""Native permission, MCP, cancellation, recovery and bounded-load contracts."""
import concurrent.futures
import contextlib
import io
import json
import os
import sys
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from app.services import harness2_bridge, harness2_native, harness2_session, harness2_streaming
from tests import test_harness2_native_executor as fixtures


class NativeSafetyTests(unittest.TestCase):
    def test_legacy_dispatch_keeps_explicit_network_permission(self):
        helper = fixtures.NativeExecutorTests()
        from app.services.harness2_runtime import NETWORK_ENV
        with tempfile.TemporaryDirectory() as folder:
            for allowed in (False, True):
                with self.subTest(allowed=allowed):
                    def respond(body):
                        names = [tool['function']['name'] for tool in body['tools']]
                        self.assertEqual('webfetch' in names, allowed)
                        return helper.response('Capabilities checked')
                    env = dict(os.environ)
                    env.pop('SODUWORK_APPROVAL_CHANNEL', None)
                    env[NETWORK_ENV] = '1' if allowed else '0'
                    with (helper.endpoint(respond) as (model, _), patch.dict(os.environ, env, clear=True)):
                        self.assertEqual(harness2_bridge.execute('Check network scope', folder, '', 'work', False,
                            model=model, root=Path(folder) / 'archive', output=lambda _: None), 0)

    def test_stdio_mcp_runs_directly_and_preserves_tool_policy(self):
        from app.services import harness2_mcp
        with tempfile.TemporaryDirectory() as folder:
            peer = Path(folder) / 'mcp_peer.py'
            peer.write_text('''import json, os, sys
assert not os.environ.get("SODUWORK_HARNESS2_MODEL")
for line in sys.stdin:
    message = json.loads(line)
    if "id" not in message:
        continue
    method = message["method"]
    result = ({"protocolVersion": "2025-11-25", "capabilities": {"tools": {}}, "serverInfo": {"name": "fixture", "version": "1"}}
              if method == "initialize" else
              {"tools": [{"name": "echo", "inputSchema": {"type": "object"}}]}
              if method == "tools/list" else
              {"content": [{"type": "text", "text": "Direct stdio MCP: " + message["params"]["arguments"]["text"]}]})
    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
''', encoding='utf-8')
            spec = {'command': sys.executable, 'args': [str(peer)], 'allowedTools': ['echo']}
            cancel = threading.Event()
            with patch.dict(os.environ, {'SODUWORK_HARNESS2_MODEL': 'private-model'}):
                rows = harness2_mcp.list_tools('fixture', spec, cancel)
                self.assertEqual([row['name'] for row in rows], ['echo'])
                result = harness2_mcp.call_tool('fixture', spec, 'echo', {'text': 'verified'}, cancel)
                self.assertEqual(result, 'Direct stdio MCP: verified')
            with patch.object(harness2_mcp, '_stdio', side_effect=AssertionError('Denied tool started')):
                with self.assertRaises(ValueError):
                    harness2_mcp.call_tool('fixture', {**spec, 'allowedTools': []}, 'echo', {}, cancel)
                with self.assertRaises(ValueError):
                    harness2_mcp.call_tool('fixture', {**spec, 'disabledTools': ['echo']}, 'echo', {}, cancel)
            self.assertEqual(harness2_mcp._timeout({'toolTimeoutSeconds': 60,
                'soduWorkPolicy': {'timeoutSeconds': 10}, 'soduworkPolicy': {'timeoutSeconds': 5}}, 'call'), 5)

    def test_tool_loop_stops_at_the_budget_before_an_extra_side_effect(self):
        with tempfile.TemporaryDirectory() as folder:
            events = []
            peer = harness2_native.Peer({}, folder, {}, events.append)
            peer.session = harness2_session.Session(folder, folder)
            count = 0
            def inference(*args, **kwargs):
                nonlocal count
                count += 1
                calls = [fixtures.NativeExecutorTests.call('read_file', {'path': '/fixture'}, f'{count}:{i}')
                         for i in range(4)]
                return {'role': 'assistant', 'content': '', 'tool_calls': calls}, {}
            try:
                with (patch.object(peer, '_inference', inference),
                      patch.object(peer.tools, 'call', return_value={'content': 'fixture'}) as tool):
                    peer.turn(1, [{'type': 'text', 'text': 'Bounded task'}])
                    self.assertEqual(tool.call_count, harness2_native.MAX_CALLS)
                    self.assertIn('error', events[-1])
                    self.assertLessEqual(count, harness2_native.MAX_ROUNDS)
            finally:
                peer.session.close()

    def test_mcp_http_requires_exact_permission_and_retains_results(self):
        helper = fixtures.NativeExecutorTests()
        for allowed in (False, True):
            with self.subTest(allowed=allowed), tempfile.TemporaryDirectory() as folder:
                rpc, grants = [], []
                def respond(body):
                    if body.get('method'):
                        rpc.append(body['method'])
                        result = ({'protocolVersion': '2025-11-25', 'capabilities': {'tools': {}},
                                   'serverInfo': {'name': 'fixture', 'version': '1'}}
                                  if body['method'] == 'initialize' else
                                  {'tools': [{'name': 'echo', 'description': 'Fixture echo',
                                              'inputSchema': {'type': 'object', 'properties': {'text': {'type': 'string'}}}},
                                             {'name': 'forbidden', 'inputSchema': {'type': 'object'}}]}
                                  if body['method'] == 'tools/list' else
                                  {'content': [{'type': 'text', 'text': 'MCP verified'}]})
                        return {'jsonrpc': '2.0', 'id': body.get('id'), 'result': result}
                    results = [m for m in body['messages'] if m['role'] == 'tool']
                    if not results:
                        return helper.response(calls=[helper.call('list_mcp_tools', {'server': 'fixture'})])
                    if len(results) == 1 and allowed:
                        self.assertIn('echo', results[0]['content'])
                        self.assertNotIn('forbidden', results[0]['content'])
                        return helper.response(calls=[helper.call('call_mcp_tool', {
                            'server': 'fixture', 'tool': 'echo', 'arguments': {'text': 'hello'}}, 'call-2')])
                    if allowed:
                        self.assertIn('MCP verified', results[-1]['content'])
                    return helper.response('MCP boundary checked')
                def permission(_self, path, payload):
                    if path == '/request':
                        grants.append(payload)
                        return {'decision': 'once' if allowed else 'deny'}
                    return {'ok': True, 'requested': False}
                with helper.endpoint(respond) as (model, requests):
                    channel = json.dumps({'url': 'http://127.0.0.1:1', 'token': 'private-channel',
                        'policy': {'mode': 'standard', 'workspaceRoot': folder}})
                    config = {'servers': {'fixture': {'type': 'http', 'url': model['base'] + '/mcp',
                                                       'disabledTools': ['forbidden']}}}
                    with (patch.dict(os.environ, {'SODUWORK_APPROVAL_CHANNEL': channel,
                                                  'SODUWORK_MCP_SERVERS_JSON': json.dumps(config)}),
                          patch('app.services.acp_access.BridgeAccess.call', permission)):
                        self.assertEqual(harness2_bridge.execute('Use configured MCP', folder, '', 'work', False,
                            model=model, root=Path(folder) / 'archive', output=lambda _: None), 0)
                self.assertEqual(grants[0]['arguments'], {'server': 'fixture'})
                if allowed:
                    self.assertEqual(grants[-1]['arguments'], {'server': 'fixture', 'tool': 'echo', 'arguments': {'text': 'hello'}})
                    self.assertEqual(rpc.count('tools/call'), 1)
                else:
                    self.assertEqual(rpc, [], 'Denied discovery must not contact the server')

    def test_external_file_approval_and_readonly_are_enforced_by_host(self):
        helper = fixtures.NativeExecutorTests()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            workspace = root / 'work'
            workspace.mkdir()
            target = root / 'outside.txt'
            target.write_text('outside evidence')
            for mode, granted in [('standard', False), ('standard', True), ('readonly', False)]:
                with self.subTest(mode=mode, granted=granted):
                    grants = []
                    def respond(body):
                        results = [m for m in body['messages'] if m['role'] == 'tool']
                        if not results:
                            return helper.response(calls=[helper.call('read_file', {'path': str(target)})])
                        self.assertEqual('outside evidence' in results[0]['content'], granted)
                        return helper.response('Permission checked')
                    def permission(_self, path, payload):
                        if path == '/request':
                            grants.append(payload)
                            return {'decision': 'once' if granted else 'deny'}
                        return {'ok': True, 'requested': False}
                    channel = json.dumps({'url': 'http://127.0.0.1:1', 'token': 'private-channel',
                                          'policy': {'mode': mode, 'workspaceRoot': str(workspace)}})
                    with (helper.endpoint(respond) as (model, requests),
                          patch.dict(os.environ, {'SODUWORK_APPROVAL_CHANNEL': channel}),
                          patch('app.services.acp_access.BridgeAccess.call', permission)):
                        self.assertEqual(harness2_bridge.execute('Read outside', str(workspace), '', 'work', True,
                            model=model, root=root / 'archive', output=lambda _: None), 0)
                    self.assertEqual(grants[0]['action'], 'file.read')
                    self.assertEqual(grants[0]['target'], str(target.resolve()))

    def test_cancellation_during_model_call_cannot_execute_late_tools(self):
        with tempfile.TemporaryDirectory() as folder:
            events, entered, release = [], threading.Event(), threading.Event()
            peer = harness2_native.Peer({}, folder, {}, events.append)
            peer.session = harness2_session.Session(folder, folder)
            def inference(*args, **kwargs):
                entered.set()
                release.wait(5)
                return {'role': 'assistant', 'content': '', 'tool_calls': [fixtures.NativeExecutorTests.call(
                    'write_file', {'path': str(Path(folder) / 'late.txt'), 'content': 'bad'})]}, {}
            try:
                with (patch('app.services.harness2_native.request', inference),
                      patch.object(peer.tools, 'call', side_effect=AssertionError('Late tool executed')) as tool):
                    worker = threading.Thread(target=peer.turn, args=(1, [{'type': 'text', 'text': 'Wait'}]))
                    worker.start()
                    self.assertTrue(entered.wait(3))
                    started = time.monotonic()
                    peer.cancel.set()
                    worker.join(1)
                    self.assertFalse(worker.is_alive())
                    self.assertLess(time.monotonic() - started, 1)
                    release.set()
                    tool.assert_not_called()
                self.assertEqual(events[-1]['result']['stopReason'], 'cancelled')
                self.assertFalse((Path(folder) / 'late.txt').exists())
            finally:
                release.set()
                peer.session.close()

    def test_real_native_permission_transition_resumes_the_same_session(self):
        helper = fixtures.NativeExecutorTests()
        with tempfile.TemporaryDirectory() as folder:
            entered, release = threading.Event(), threading.Event()
            controls, applied, events = [], [], []
            def respond(body):
                entered.set()
                release.wait(4)
                return helper.response('Continued with the current policy')
            def permission(_self, path, payload):
                if path == '/applied':
                    applied.append(payload['mode'])
                    return {'ok': True}
                if path == '/control':
                    controls.append(payload)
                    return {'requested': entered.is_set(), 'id': 'transition-fixture'}
                return {'decision': 'deny'}
            with helper.endpoint(respond) as (model, requests):
                channel = {'url': 'http://127.0.0.1:1', 'token': 'private',
                           'policy': {'mode': 'standard', 'workspaceRoot': folder}}
                try:
                    with (patch.dict(os.environ, {'SODUWORK_APPROVAL_CHANNEL': json.dumps(channel)}),
                          patch('app.services.acp_access.BridgeAccess.call', permission)):
                        self.assertEqual(harness2_bridge.execute('Work', folder, '', 'work', True,
                            model=model, root=Path(folder) / 'archive', output=events.append), 73)
                finally:
                    release.set()
                sid = next(e['sessionID'] for e in events if e.get('sessionID'))
                ready = next(c for c in controls if c.get('stage') == 'ready')
                self.assertEqual(ready['sessionId'], sid)
                self.assertFalse(ready['completed'])
                channel['policy']['mode'] = 'readonly'
                def settled(_self, path, payload):
                    if path == '/applied':
                        applied.append(payload['mode'])
                    return {'ok': True, 'requested': False}
                with (patch.dict(os.environ, {'SODUWORK_APPROVAL_CHANNEL': json.dumps(channel)}),
                      patch('app.services.acp_access.BridgeAccess.call', settled)):
                    self.assertEqual(harness2_bridge.execute('Continue safely', folder, sid, 'work', True,
                        model=model, root=Path(folder) / 'archive', output=events.append), 0)
                self.assertEqual({e['sessionID'] for e in events if e.get('sessionID')}, {sid})
                self.assertEqual(applied, ['standard', 'readonly'])
                self.assertNotIn('write_file', [t['function']['name'] for t in requests[-1]['tools']])

    def test_cancelled_stream_cannot_emit_into_a_following_turn(self):
        with tempfile.TemporaryDirectory() as folder:
            events, entered, release, finished = [], threading.Event(), threading.Event(), threading.Event()
            peer = harness2_native.Peer({}, folder, {}, events.append)
            peer.session = harness2_session.Session(folder, folder)
            def inference(*args, **kwargs):
                entered.set()
                release.wait(5)
                kwargs['on_text']('stale text')
                kwargs['on_usage']({'input': 999})
                finished.set()
                return {'role': 'assistant', 'content': 'stale final'}, {}
            try:
                with patch('app.services.harness2_native.request', inference):
                    worker = threading.Thread(target=peer.turn, args=(1, [{'type': 'text', 'text': 'Wait'}]))
                    worker.start()
                    self.assertTrue(entered.wait(3))
                    peer.cancel.set()
                    worker.join(2)
                    self.assertFalse(worker.is_alive())
                    peer.cancel = threading.Event()
                    before = list(events)
                    release.set()
                    self.assertTrue(finished.wait(2))
                    self.assertEqual(events, before)
                    self.assertEqual(peer.session.messages, [{'role': 'user', 'content': [{'type': 'text', 'text': 'Wait'}]}])
            finally:
                release.set()
                peer.session.close()

    def test_same_peer_repairs_an_interrupted_tool_result_before_next_user(self):
        with tempfile.TemporaryDirectory() as folder:
            peer = harness2_native.Peer({}, folder, {}, lambda _: None)
            peer.session = harness2_session.Session(folder, folder)
            peer.session.messages = [{'role': 'assistant', 'content': '', 'tool_calls': [
                fixtures.NativeExecutorTests.call('write_file', {'path': '/uncertain', 'content': 'x'})]}]
            def inference(messages):
                self.assertEqual(messages[-2]['role'], 'tool')
                self.assertIn('do not assume success or repeat', messages[-2]['content'])
                self.assertEqual(messages[-1]['role'], 'user')
                return {'role': 'assistant', 'content': 'Inspecting current state'}, {}
            try:
                with (patch.object(peer, '_inference', inference),
                      patch.object(peer.tools, 'call', side_effect=AssertionError('Action replayed'))):
                    peer.turn(1, [{'type': 'text', 'text': 'Continue'}])
            finally:
                peer.session.close()

    def test_session_lock_atomicity_identity_and_interrupted_result_recovery(self):
        with tempfile.TemporaryDirectory() as folder:
            session = harness2_session.Session(folder, folder)
            sid = session.id
            try:
                session.messages = [{'role': 'assistant', 'content': '', 'tool_calls': [fixtures.NativeExecutorTests.call('write_file', {'path': '/not-run', 'content': 'x'})]}]
                session.save()
                before = session.path.read_bytes()
                with self.assertRaises(OSError):
                    harness2_session.Session(folder, folder, sid)
                with patch('app.services.harness2_session.os.replace', side_effect=OSError('fixture atomic failure')):
                    with self.assertRaises(OSError):
                        session.save()
                self.assertEqual(session.path.read_bytes(), before)
            finally:
                session.close()
            restored = harness2_session.Session(folder, folder, sid)
            try:
                self.assertEqual(restored.messages[-1]['role'], 'tool')
                self.assertIn('do not assume success or repeat', restored.messages[-1]['content'])
                restored.save()
            finally:
                restored.close()
            with self.assertRaises(ValueError):
                harness2_session.Session(folder, str(Path(folder) / 'other'), sid)
            for invalid in ('../escape', 'ses_old', 'h2_' + '../' * 11):
                with self.assertRaises(ValueError):
                    harness2_session.Session(folder, folder, invalid)

    def test_concurrent_archives_have_no_cross_session_messages(self):
        with tempfile.TemporaryDirectory() as folder:
            def write(index):
                session = harness2_session.Session(folder, folder)
                try:
                    for turn in range(20):
                        session.messages.append({'role': 'user', 'content': f'{index}:{turn}'})
                        session.save()
                    return index, session.id
                finally:
                    session.close()
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                rows = list(pool.map(write, range(32)))
            self.assertEqual(len({sid for _, sid in rows}), 32)
            for index, sid in rows:
                session = harness2_session.Session(folder, folder, sid)
                try:
                    self.assertEqual([m['content'] for m in session.messages], [f'{index}:{turn}' for turn in range(20)])
                finally:
                    session.close()

    def test_stream_requires_terminal_marker_and_reassembles_split_tool_json(self):
        def chunk(delta, finish=None):
            return 'data: ' + json.dumps({'choices': [{'delta': delta, 'finish_reason': finish}]}) + '\n\n'
        payload = chunk({'tool_calls': [{'index': 0, 'id': 't', 'function': {'name': 'read_file', 'arguments': '{"pa'}}]})
        payload += chunk({'tool_calls': [{'index': 0, 'function': {'arguments': 'th":"/fixture"}'}}]}, 'tool_calls')
        with self.assertRaises(harness2_bridge.StructuredFailure):
            harness2_streaming.read(io.BytesIO(payload.encode()), time.monotonic() + 3, False, None)
        data = harness2_streaming.read(io.BytesIO((payload + 'data: [DONE]\n\n').encode()), time.monotonic() + 3, False, None)
        call = data['choices'][0]['message']['tool_calls'][0]
        self.assertEqual(json.loads(call['function']['arguments']), {'path': '/fixture'})
