"""Offline real-process regression for an independent Harness² executor."""
import contextlib
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from app.services import harness2_bridge, harness2_runtime


class NativeExecutorTests(unittest.TestCase):
    def test_session_initialization(self):
        from app.services.harness2_native import Peer
        with tempfile.TemporaryDirectory() as folder:
            events = []
            peer = Peer({}, folder, {}, events.append)
            with patch('app.services.harness2_native.failure_message', side_effect=lambda exc, *_: repr(exc)):
                peer.receive({'id': 1, 'method': 'session/new', 'params': {'cwd': folder}})
            try:
                self.assertNotIn('error', events[0], events)
            finally:
                if peer.session:
                    peer.session.close()

    @contextlib.contextmanager
    def endpoint(self, respond):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append(body)
                data = json.dumps(respond(body)).encode()
                try:
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except ConnectionError:
                    # Cancellation deliberately closes the fixture connection.
                    pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield {'base': f'http://127.0.0.1:{server.server_port}/v1',
                   'key': 'fixture-private-model-key', 'model': 'fixture'}, requests
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    @staticmethod
    def response(text='', calls=None):
        return {'choices': [{'finish_reason': 'tool_calls' if calls else 'stop',
                             'message': {'role': 'assistant', 'content': text, 'tool_calls': calls or []}}],
                'usage': {'prompt_tokens': 11, 'completion_tokens': 7}}

    @staticmethod
    def call(name, arguments, identity='call-1'):
        return {'id': identity, 'type': 'function', 'function': {
            'name': name, 'arguments': json.dumps(arguments)}}

    def test_real_files_terminal_and_resume_without_any_opencode(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            target = root / 'result.txt'
            commands = [self.call('write_file', {'path': str(target), 'content': 'independent'}),
                        self.call('read_file', {'path': str(target)}, 'read-1'),
                        self.call('run_command', {'command': sys.executable,
                            'args': ['-c', 'import os; print("native-terminal", bool(os.environ.get("SODUWORK_HARNESS2_MODEL")))']}, 'cmd-1')]
            def respond(body):
                results = [m for m in body['messages'] if m['role'] == 'tool']
                if len(results) < len(commands):
                    return self.response(calls=[commands[len(results)]])
                return self.response('Native execution complete')
            with self.endpoint(respond) as (model, requests):
                events = []
                with patch('app.services.local_base._opencode_bin', side_effect=AssertionError('OpenCode must not be consulted')):
                    self.assertEqual(harness2_runtime.runtime_issue(), '')
                    self.assertEqual(harness2_bridge.execute('Create and verify a file', folder, '', 'work', True,
                        'nonexistent-opencode.exe', model=model, root=root / 'archive', output=events.append), 0)
                    sid = next(e['sessionID'] for e in events if e.get('sessionID'))
                    self.assertTrue(sid.startswith('h2_'))
                    self.assertEqual(harness2_bridge.execute('Continue', folder, sid, 'work', True,
                        model=model, root=root / 'archive', output=events.append), 0)
                self.assertEqual(target.read_text(), 'independent')
                results = [m['content'] for m in requests[-1]['messages'] if m['role'] == 'tool']
                self.assertIn('native-terminal False', results[-1])
                self.assertIn('independent', results[1])
                transcript = (root / 'archive/sessions' / (sid + '.json')).read_text()
                self.assertNotIn(model['key'], transcript)
                self.assertFalse(any(e.get('error') for e in events))

    def test_readonly_rejects_write_and_outside_read(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'forbidden.txt'
            def respond(body):
                if any(m['role'] == 'tool' for m in body['messages']):
                    return self.response('Write was denied')
                return self.response(calls=[self.call('write_file', {'path': str(target), 'content': 'bad'})])
            with self.endpoint(respond) as (model, requests):
                self.assertEqual(harness2_bridge.execute('Attempt writing', folder, '', 'plan', True,
                    model=model, root=Path(folder) / 'archive', output=lambda _: None), 0)
                self.assertFalse(target.exists())
                self.assertNotIn('write_file', [t['function']['name'] for t in requests[0]['tools']])

    def test_native_anthropic_tool_cycle(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'input.txt'
            target.write_text('read through Anthropic')
            def respond(body):
                results = [b for m in body['messages'] for b in m['content'] if b['type'] == 'tool_result']
                if results:
                    self.assertIn('read through Anthropic', results[0]['content'])
                    return {'stop_reason': 'end_turn', 'content': [{'type': 'text', 'text': 'Verified'}], 'usage': {'input_tokens': 4, 'output_tokens': 2}}
                return {'stop_reason': 'tool_use', 'content': [{'type': 'tool_use', 'id': 'read-1',
                    'name': 'read_file', 'input': {'path': str(target)}}], 'usage': {'input_tokens': 4, 'output_tokens': 2}}
            with self.endpoint(respond) as (model, requests):
                model['kind'] = 'anthropic'
                self.assertEqual(harness2_bridge.execute('Read the file', folder, '', 'plan', False,
                    model=model, root=Path(folder) / 'archive', output=lambda _: None), 0)
                self.assertEqual(len(requests), 2)
