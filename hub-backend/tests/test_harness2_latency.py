"""Latency contracts retain all research stages and authoritative completion."""
from concurrent.futures import ThreadPoolExecutor
import contextlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from app.services import harness2_bridge as bridge, harness2_engine as engine
from app.services import harness2_provider as provider
from app.services.harness2_budget import RefinementBudget
from app.services.harness2_errors import StructuredFailure
from tests.test_harness2_native_provider import Response, event, MODEL, MESSAGES


@contextlib.contextmanager
def streaming_endpoint(respond, *, single_slot=False, capacity=None):
    """Keep every completed fixture stream open until the caller releases it."""
    release = threading.Event()
    requests, exhausted = [], []
    lock = threading.Lock()
    slot = threading.Semaphore(1)
    capacity = capacity if capacity is not None else {}
    capacity.update(active=0, peak=0, rejected=0)
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            with lock:
                requests.append(body)
            if single_slot and not slot.acquire(blocking=False):
                with lock:
                    capacity['rejected'] += 1
                data = b'{"error":{"message":"Fixture model waiting queue is full"}}'
                self.send_response(429)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            try:
                with lock:
                    capacity['active'] += 1
                    capacity['peak'] = max(capacity['peak'], capacity['active'])
                if single_slot:
                    time.sleep(.05)
                value = respond(body)
            finally:
                with lock:
                    capacity['active'] -= 1
                if single_slot:
                    slot.release()
            if value is None:
                release.wait(45)
                return
            choice = value['choices'][0]
            message = choice['message']
            delta = {'content': message.get('content', '')}
            if message.get('tool_calls'):
                delta['tool_calls'] = [{'index': index, **call}
                                       for index, call in enumerate(message['tool_calls'])]
            raw = event({'choices': [{'delta': delta, 'finish_reason': choice['finish_reason']}]})
            raw += event({'choices': [], 'usage': value['usage']}) + 'data: [DONE]\n\n: keepalive'
            try:
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                self.wfile.write(raw.encode())
                self.wfile.flush()
                if not release.wait(45):
                    with lock:
                        exhausted.append(body)
            except ConnectionError:
                # The client closes the transport after authoritative completion.
                pass
        def log_message(self, *_args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    model = {**MODEL, 'base': f'http://127.0.0.1:{server.server_port}/v1',
             'model': 'GLM3.5flash', 'reasoning': True, 'thinkingFormat': 'zai',
             'thinkingMode': 'controllable', 'supportsReasoningEffort': True,
             'thinkingLevelMap': {'low': 'low', 'high': 'high'}, 'maxOutputTokens': 32768}
    try:
        yield model, requests, exhausted
    finally:
        release.set()
        server.shutdown()
        server.server_close()
        worker.join(3)


class Harness2LatencyTests(unittest.TestCase):
    def process_turn(self, root, model, *, timeout_fixture=False):
        from app.services import harness2_runtime as runtime
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(('SODUWORK_', 'OPENCODE_'))}
        env.update({runtime.MODEL_ENV: json.dumps(model), runtime.ROOT_ENV: str(root / 'archive'),
                    runtime.EXECUTOR_ENV: 'opencode-must-never-run.exe',
                    'SODUWORK_DATA_ROOT': str(root / 'runner'), 'PYTHONUTF8': '1',
                    'PYTHONPATH': str(Path(runtime.__file__).resolve().parents[2]),
                    'NO_PROXY': 'localhost,127.0.0.1', 'no_proxy': 'localhost,127.0.0.1'})
        command = [sys.executable, '-B']
        if timeout_fixture:
            # Shorten only the test deadline; exercise the real HTTP timeout and
            # full bridge failure path without waiting the production deadline.
            command += ['-c', 'from app.services import harness2_budget as b, harness2_bridge as h; '
                        'b.MAX_REQUEST_SECONDS = 0.35; raise SystemExit(h.main())']
        else:
            command += [str(Path(runtime.__file__).with_name('harness2_bridge.py'))]
        return subprocess.run(command + ['--cwd', str(root)], input='今天天气怎么样？请先处理本地测试数据。',
                              cwd=root, env=env, text=True, encoding='utf-8', capture_output=True, timeout=30)

    def test_full_glm_single_slot_streaming_turn_refines_all_stages_then_executes_native_tools(self):
        from tests.test_harness2_native_executor import NativeExecutorTests
        helper = NativeExecutorTests()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            target = root / 'weather-fixture.txt'
            def respond(body):
                if not body.get('tools'):
                    system = body['messages'][0]['content']
                    return helper.response(json.dumps({'files': {'systemprompt.md': 'Verify actual local tool results.'},
                                                       'notes': 'Preserve all user constraints.'})
                                           if 'SODUWORK_HARNESS2_EDIT' in system else 'Inspect local data and verify results.')
                results = [message for message in body['messages'] if message['role'] == 'tool']
                if not results:
                    return helper.response(calls=[helper.call('write_file', {
                        'path': str(target), 'content': 'verified local weather fixture'}, 'write-weather')])
                if len(results) == 1:
                    return helper.response(calls=[helper.call('read_file', {'path': str(target)}, 'read-weather')])
                return helper.response('Verified the weather fixture through native tools.')
            capacity = {}
            with streaming_endpoint(respond, single_slot=True, capacity=capacity) as (model, requests, exhausted):
                child = self.process_turn(root, model)
                self.assertEqual(child.returncode, 0, child.stdout + child.stderr)
                events = [json.loads(line) for line in child.stdout.splitlines()]
                self.assertFalse(any(row.get('error') for row in events), events)
                planning = [body for body in requests if not body.get('tools')]
                phases = [body['messages'][0]['content'].split('stage=', 1)[1].splitlines()[0]
                          for body in planning]
                self.assertEqual(phases, ['base1', 'inv1.a1', 'dom1.a1', 'inv1', 'dom1', 'c1.a1', 'c1'])
                self.assertEqual(len(requests), 10)
                self.assertTrue(all(body.get('tools') for body in requests[7:]))
                self.assertTrue(all(body['stream'] and body['model'] == 'GLM3.5flash'
                                    and body['thinking'] == {'type': 'disabled'} for body in requests))
                self.assertTrue(all(body['max_tokens'] == (4096 if '.a1' in phase else 2048)
                                    for phase, body in zip(phases, planning)))
                self.assertEqual(target.read_text(), 'verified local weather fixture')
                results = [message['content'] for message in requests[-1]['messages'] if message['role'] == 'tool']
                self.assertEqual(len(results), 2)
                self.assertIn('verified local weather fixture', results[-1])
                self.assertIn('Verified the weather fixture through native tools.', child.stdout)
                self.assertTrue(any(row.get('sessionID', '').startswith('h2_') for row in events))
                usage = [row['part']['tokens'] for row in events
                         if row.get('type') == 'step_finish' and row.get('part', {}).get('tokens')]
                self.assertEqual(len(usage), 10)
                self.assertEqual(sum(row.get('input_tokens', row.get('input', 0)) for row in usage), 110)
                self.assertEqual(sum(row.get('output_tokens', row.get('output', 0)) for row in usage), 70)
                self.assertEqual(exhausted, [], 'no response needed socket EOF to complete')
                self.assertEqual(capacity, {'active': 0, 'peak': 1, 'rejected': 0})
                self.assertNotIn(model['key'], child.stdout + child.stderr)

    def test_full_glm_dom1_http_timeout_preserves_phase_and_never_starts_execution(self):
        from tests.test_harness2_native_executor import NativeExecutorTests
        helper = NativeExecutorTests()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            def respond(body):
                if body.get('tools'):
                    return helper.response('Unexpected native execution')
                system = body['messages'][0]['content']
                phase = system.split('stage=', 1)[1].splitlines()[0]
                if phase == 'dom1.a1':
                    return None
                return helper.response('{"files":{},"notes":"verified"}' if '.a1' in phase else 'Inspect the request.')
            with streaming_endpoint(respond) as (model, requests, _exhausted):
                child = self.process_turn(root, model, timeout_fixture=True)
                self.assertEqual(child.returncode, 2, child.stdout + child.stderr)
                events = [json.loads(line) for line in child.stdout.splitlines()]
                failures = [row['error'] for row in events if row.get('error')]
                self.assertEqual(len(failures), 1)
                self.assertEqual((failures[0]['code'], failures[0]['phase']), ('model_timeout', 'dom1.a1'))
                self.assertFalse(any(body.get('tools') for body in requests))
                self.assertEqual({body['messages'][0]['content'].split('stage=', 1)[1].splitlines()[0]
                                  for body in requests}, {'base1', 'inv1.a1', 'dom1.a1'})
                self.assertFalse((root / 'archive' / 'sessions').exists())
                self.assertFalse(any(row.get('sessionID') for row in events))
                self.assertNotIn(model['key'], child.stdout + child.stderr)

    def test_terminal_event_accepts_partial_comment_but_rejects_trailing_data(self):
        terminal = (event({'choices': [{'delta': {'content': 'complete'}, 'finish_reason': 'stop'}]})
                    + 'data: [DONE]\n\n').encode()
        class Packets(Response):
            def __init__(self, packets):
                super().__init__(b'', 'text/event-stream')
                self.packets = list(packets)
                self.reads = 0
            def read1(self, _size):
                self.reads += 1
                return self.packets.pop(0) if self.packets else b''
        for tail in [b': kee', b': ' + '\u4e2d'.encode()[:1]]:
            with self.subTest(tail=tail):
                response = Packets([terminal + tail, b'palive\n\n'])
                with patch.object(provider.urllib.request.OpenerDirector, 'open', return_value=response):
                    message, _ = provider.request(MODEL, MESSAGES, [])
                self.assertEqual(message['content'], 'complete')
                self.assertEqual(response.reads, 1, 'completed inference must not wait for comment EOF')
        for tail in [b'data: {', event({'choices': []}).encode()]:
            with self.subTest(tail=tail), patch.object(provider.urllib.request.OpenerDirector,
                    'open', return_value=Packets([terminal + tail])):
                with self.assertRaises(StructuredFailure):
                    provider.request(MODEL, MESSAGES, [])

    def test_off_budget_requires_a_supported_declared_wire_switch(self):
        model = {**MODEL, 'reasoning': True, 'thinkingMode': 'controllable',
                 'thinkingFormat': 'openai', 'supportsReasoningEffort': True,
                 'thinkingLevelMap': {'off': 'none', 'low': 'low'}}
        self.assertTrue(provider.can_disable_reasoning(model))
        self.assertEqual(provider.thinking_options(model, planning=True), {'reasoning_effort': 'none'})
        for override in [{'thinkingFormat': 'unknown'}, {'supportsReasoningEffort': False},
                         {'thinkingLevelMap': {'off': None, 'low': 'low'}},
                         {'thinkingLevelMap': {'off': 'minimal', 'low': 'low'}},
                         {'thinkingMode': 'always'}, {'thinkingAlwaysOn': True}]:
            with self.subTest(override=override):
                unsupported = {**model, **override}
                self.assertFalse(provider.can_disable_reasoning(unsupported))
                captured = []
                def complete(bounded, *_args, **_kwargs):
                    captured.append(bounded['maxOutputTokens'])
                    return 'verified'
                RefinementBudget().run(unsupported, MESSAGES, complete)
                self.assertEqual(captured, [4096])

    def test_native_execution_preserves_explicit_reasoning_and_cannot_disable_always_on(self):
        model = {**MODEL, 'reasoning': True, 'thinkingFormat': 'zai',
                 'thinkingMode': 'controllable', 'supportsReasoningEffort': True,
                 'thinkingLevelMap': {'low': 'low', 'high': 'high'}}
        self.assertEqual(provider.thinking_options(model), {'thinking': {'type': 'disabled'}})
        self.assertEqual(provider.thinking_options({**model, 'thinkingLevel': 'high'}),
                         {'thinking': {'type': 'enabled', 'clear_thinking': False}, 'reasoning_effort': 'high'})
        self.assertEqual(provider.thinking_options({**model, 'thinkingMode': 'always', 'thinkingLevel': 'off'}),
                         {'thinking': {'type': 'enabled', 'clear_thinking': False}, 'reasoning_effort': 'low'})
        self.assertEqual(provider.thinking_options({**model, 'thinkingFormat': 'unknown'}), {})

    def test_real_http_terminal_event_returns_while_peer_keeps_stream_open(self):
        release = threading.Event()
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                raw = event({'choices': [{'delta': {'content': 'complete'}, 'finish_reason': 'stop'}]})
                self.wfile.write((raw + 'data: [DONE]\n\n').encode())
                self.wfile.flush()
                release.wait(3)
            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            model = {**MODEL, 'base': f'http://127.0.0.1:{server.server_port}/v1'}
            self.assertEqual(bridge.complete(model, MESSAGES, timeout=1), 'complete')
            self.assertFalse(release.is_set())
        finally:
            release.set()
            server.shutdown()
            server.server_close()
            thread.join(3)

    def test_concurrent_budget_reserves_no_more_than_seven_requests_and_accounts_all_usage(self):
        budget = RefinementBudget()
        gate = threading.Event()
        calls, usage = [], []
        def complete(_model, _messages, report, *, timeout):
            calls.append(timeout)
            gate.wait(3)
            report({'input_tokens': 7, 'output_tokens': 3})
            return 'plan'
        def invoke():
            try:
                budget.run(MODEL, MESSAGES, complete, usage.append)
            except StructuredFailure:
                pass
        with ThreadPoolExecutor(max_workers=30) as pool:
            jobs = [pool.submit(invoke) for _ in range(30)]
            gate.set()
            for job in jobs:
                job.result(timeout=5)
        self.assertEqual(budget.calls, 7)
        self.assertEqual(len(calls), 7)
        self.assertEqual(len(usage), 7)
        self.assertEqual(budget.reported_tokens, 70)

    def test_failed_proposal_retains_its_phase_and_stops_following_calls(self):
        started = []
        def complete(messages):
            label = messages[0]['content'].split('stage=', 1)[1].splitlines()[0]
            started.append(label)
            if label in {'inv1.a1', 'dom1.a1'}:
                if label == 'dom1.a1':
                    raise StructuredFailure('model_http', http_status=429)
                return '{"files":{},"notes":"verified"}'
            return 'Plan.'
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(engine.Harness2RefinementError) as caught:
                engine.refine('Task', complete, Path(temp)/'turn', lambda _: None)
        self.assertEqual((caught.exception.code, caught.exception.phase, caught.exception.http_status),
                         ('model_http', 'dom1.a1', 429))
        self.assertEqual(started, ['base1', 'inv1.a1', 'dom1.a1'])
    def test_planning_consumes_sse_with_accounted_usage(self):
        raw = event({'choices': [{'delta': {'content': 'Verified plan'}, 'finish_reason': 'stop'}]})
        raw += event({'choices': [], 'usage': {'prompt_tokens': 10, 'completion_tokens': 4}})
        raw += 'data: [DONE]\n\n'
        usage = []
        with patch.object(provider.urllib.request.OpenerDirector, 'open',
                          return_value=Response(raw.encode(), 'text/event-stream')) as opened:
            self.assertEqual(bridge.complete(MODEL, MESSAGES, usage.append), 'Verified plan')
        self.assertTrue(json.loads(opened.call_args.args[0].data)['stream'])
        self.assertEqual(usage, [{'input_tokens': 10, 'output_tokens': 4}])

    def test_controllable_thinking_uses_supported_off_but_never_disables_always_on(self):
        payload = {'choices': [{'message': {'content': 'plan'}, 'finish_reason': 'stop'}]}
        contracts = [
            ({'thinkingMode': 'controllable'}, {'type': 'disabled'}, None),
            ({'thinkingMode': 'always'}, None, 'low'),
            ({'thinkingMode': 'controllable', 'thinkingLevelMap': {'off': None, 'low': 'low'}}, None, 'low'),
        ]
        for override, thinking, effort in contracts:
            model = {**MODEL, 'reasoning': True, 'thinkingFormat': 'zai',
                     'supportsReasoningEffort': True, 'thinkingLevelMap': {'low': 'low'}, **override}
            with self.subTest(override=override), patch.object(provider.urllib.request.OpenerDirector,
                    'open', return_value=Response(payload)) as opened:
                bridge.complete(model, MESSAGES)
                body = json.loads(opened.call_args.args[0].data)
                self.assertEqual(body.get('thinking'), thinking)
                self.assertEqual(body.get('reasoning_effort'), effort)

    def test_planning_output_allowance_is_phase_bounded_without_overriding_smaller_model_limit(self):
        for stage, expected in [('base1', 2048), ('dom1.a1', 4096)]:
            for configured in [1024, 32768]:
                captured = []
                model = {**MODEL, 'maxOutputTokens': configured, 'reasoning': True,
                         'thinkingMode': 'controllable', 'thinkingFormat': 'zai'}
                def complete(bounded, _messages, _usage, *, timeout):
                    captured.append((bounded['maxOutputTokens'], timeout))
                    return 'plan'
                marker = 'SODUWORK_HARNESS2_EDIT' if '.a1' in stage else 'SODUWORK_HARNESS2_PROBE'
                RefinementBudget().run(model, [{'role': 'system', 'content': marker + '\nstage=' + stage}], complete)
                self.assertEqual(captured[0][0], min(configured, expected))
                self.assertLessEqual(captured[0][1], 300)

    def test_all_seven_stages_preserve_order_without_overlapping_model_requests(self):
        started, finished = [], []
        def complete(messages):
            label = messages[0]['content'].split('stage=', 1)[1].splitlines()[0]
            self.assertEqual(started, finished)
            started.append(label)
            if label in {'inv1.a1', 'dom1.a1'}:
                self.assertIn('base1', finished)
            if label == 'c1.a1':
                self.assertTrue({'inv1', 'dom1'} <= set(finished))
            finished.append(label)
            return '{"files":{},"notes":"verified"}' if '.a1' in label else 'Verified plan.'
        with tempfile.TemporaryDirectory() as temp:
            engine.refine('Weather request', complete, Path(temp) / 'turn', lambda _: None)
        self.assertEqual(started, ['base1', 'inv1.a1', 'dom1.a1', 'inv1', 'dom1', 'c1.a1', 'c1'])

    def test_finished_sse_does_not_wait_for_connection_eof(self):
        class Keepalive(Response):
            def read1(self, _size):
                if self.tell():
                    raise TimeoutError('The peer keeps its connection open after the terminal event')
                return self.read()
        raw = event({'choices': [{'delta': {'content': 'complete'}, 'finish_reason': 'stop'}]}) + 'data: [DONE]\n\n'
        with patch.object(provider.urllib.request.OpenerDirector, 'open',
                          return_value=Keepalive(raw.encode(), 'text/event-stream')):
            message, _ = provider.request(MODEL, MESSAGES, [])
        self.assertEqual(message['content'], 'complete')


if __name__ == '__main__':
    unittest.main()
