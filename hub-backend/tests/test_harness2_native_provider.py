"""Native provider contracts, independent of paid services or installed CLIs."""
import io
import json
import time
import unittest
import urllib.error
from unittest.mock import patch

from app.services import harness2_provider as provider, harness2_streaming as streaming
from app.services.harness2_errors import StructuredFailure, failure_message


MODEL = {'base': 'https://fixture.invalid/v1', 'key': 'private-key', 'model': 'fixture'}
MESSAGES = [{'role': 'system', 'content': 'Use current permissions'}, {'role': 'user', 'content': 'Test'}]


class Response(io.BytesIO):
    def __init__(self, payload, content_type='application/json'):
        super().__init__(payload if isinstance(payload, bytes) else json.dumps(payload).encode())
        self.headers = {'Content-Type': content_type}


def event(value):
    return 'data: ' + json.dumps(value) + '\n\n'


class NativeProviderTests(unittest.TestCase):
    def test_provider_usage_keeps_cache_and_reasoning_without_double_counting(self):
        tokens = provider.normalize_usage({'prompt_tokens': 100, 'completion_tokens': 20,
            'prompt_tokens_details': {'cached_tokens': 80},
            'completion_tokens_details': {'reasoning_tokens': 12}})
        self.assertEqual((tokens['input'], tokens['output'], tokens['cacheRead'], tokens['reasoning']),
                         (100, 20, 80, 12))
        self.assertEqual(tokens['totalTokens'], 120)
        anthropic = provider.normalize_usage({'input_tokens': 20, 'output_tokens': 5,
            'cache_read_input_tokens': 80, 'cache_creation_input_tokens': 10})
        self.assertEqual((anthropic['input'], anthropic['cacheRead'], anthropic['cacheWrite']), (110, 80, 10))
        self.assertEqual(anthropic['totalTokens'], 115)
        self.assertEqual(provider.normalize_usage({'prompt_tokens': 4, 'prompt_tokens_details': None})['input'], 4)

    def test_refinement_and_execution_keep_the_same_provider_usage_details(self):
        from app.services import harness2_bridge
        payload = {'choices': [{'message': {'content': 'verified'}, 'finish_reason': 'stop'}],
                   'usage': {'prompt_tokens': 100, 'completion_tokens': 20,
                             'prompt_tokens_details': {'cached_tokens': 80},
                             'completion_tokens_details': {'reasoning_tokens': 12}}}
        observed = []
        with patch.object(provider.urllib.request.OpenerDirector, 'open', return_value=Response(payload)):
            self.assertEqual(harness2_bridge.complete(MODEL, MESSAGES, observed.append), 'verified')
        self.assertEqual(observed, [{'input_tokens': 100, 'output_tokens': 20,
                                    'cacheRead': 80, 'inputIncludesCache': True, 'reasoning': 12}])

    def test_truncated_response_preserves_real_usage_without_false_completion(self):
        value = {'choices': [{'message': {'content': 'partial'}, 'finish_reason': 'length'}],
                 'usage': {'prompt_tokens': 11, 'completion_tokens': 7}}
        usages = []
        with patch.object(provider.urllib.request.OpenerDirector, 'open', return_value=Response(value)):
            with self.assertRaises(StructuredFailure) as caught:
                provider.request(MODEL, MESSAGES, [], on_usage=usages.append)
        self.assertEqual(caught.exception.code, 'response_truncated')
        self.assertEqual(len(usages), 1)
        self.assertEqual((usages[0]['input'], usages[0]['output']), (11, 7))

    def test_broken_stream_keeps_reported_usage_but_never_completes(self):
        raw = event({'choices': [{'delta': {'content': 'partial'}, 'finish_reason': None}],
                     'usage': {'prompt_tokens': 3, 'completion_tokens': 2}})
        usages, texts = [], []
        with patch.object(provider.urllib.request.OpenerDirector, 'open', return_value=Response(raw.encode(), 'text/event-stream')):
            with self.assertRaises(StructuredFailure) as caught:
                provider.request(MODEL, MESSAGES, [], on_usage=usages.append, on_text=texts.append)
        self.assertEqual(caught.exception.code, 'response_truncated')
        self.assertEqual(texts, ['partial'])
        self.assertEqual(len(usages), 1)
        self.assertEqual(usages[0]['output'], 2)

    def test_safe_http_diagnosis_preserves_context_recovery_and_no_raw_secrets(self):
        for status, code, expected in [(400, 'context_length_exceeded', 'context_overflow'),
                                       (401, 'private-key', 'model_http'), (429, 'quota', 'model_http')]:
            with self.subTest(status=status):
                error = urllib.error.HTTPError(MODEL['base'], status, 'private-key', {},
                    io.BytesIO(json.dumps({'error': {'code': code, 'message': 'private-key confidential'}}).encode()))
                with patch.object(provider.urllib.request.OpenerDirector, 'open', side_effect=error):
                    with self.assertRaises(StructuredFailure) as caught:
                        provider.request(MODEL, MESSAGES, [])
                self.assertEqual(caught.exception.code, expected)
                self.assertNotIn('private-key', failure_message(caught.exception, 'session/prompt'))
                self.assertNotIn('confidential', failure_message(caught.exception, 'session/prompt'))

    def test_anthropic_sse_retains_signed_thinking_tool_arguments_and_images(self):
        rows = [
            {'type': 'message_start', 'message': {'usage': {'input_tokens': 10}}},
            {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'thinking', 'thinking': ''}},
            {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'thinking_delta', 'thinking': 'inspect'}},
            {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'signature_delta', 'signature': 'signed'}},
            {'type': 'content_block_stop', 'index': 0},
            {'type': 'content_block_start', 'index': 1, 'content_block': {'type': 'tool_use', 'id': 'read-1', 'name': 'read_file', 'input': {}}},
            {'type': 'content_block_delta', 'index': 1, 'delta': {'type': 'input_json_delta', 'partial_json': '{"path":'}},
            {'type': 'content_block_delta', 'index': 1, 'delta': {'type': 'input_json_delta', 'partial_json': '"/fixture"}'}},
            {'type': 'content_block_stop', 'index': 1},
            {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use'}, 'usage': {'output_tokens': 5}},
            {'type': 'message_stop'},
        ]
        usages = []
        raw = ''.join(event(row) for row in rows).encode()
        with patch.object(provider.urllib.request.OpenerDirector, 'open', return_value=Response(raw, 'text/event-stream')):
            message, tokens = provider.request({**MODEL, 'kind': 'anthropic'}, MESSAGES, [], on_usage=usages.append)
        self.assertEqual(len(usages), 1)
        self.assertEqual(tokens['output'], 5)
        self.assertEqual(json.loads(message['tool_calls'][0]['function']['arguments']), {'path': '/fixture'})
        image = {'role': 'user', 'content': [{'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,eA=='}}]}
        translated = provider._anthropic_messages([image, message,
            {'role': 'tool', 'tool_call_id': 'read-1', 'content': 'verified'}])
        self.assertEqual(translated[0]['content'][0]['source']['media_type'], 'image/png')
        self.assertEqual(translated[1]['content'][0], {'type': 'thinking', 'thinking': 'inspect', 'signature': 'signed'})
        self.assertEqual(translated[2]['content'][0]['tool_use_id'], 'read-1')

    def test_protocol_violations_never_become_successful_tool_calls(self):
        call = {'id': 'duplicate', 'type': 'function', 'function': {'name': 'write_file', 'arguments': '{}'}}
        for message, reason in [({'content': ''}, 'stop'), ({'content': 'x'}, 'content_filter'),
                                ({'tool_calls': [call, call]}, 'tool_calls'),
                                ({'tool_calls': [{**call, 'function': {'name': 'write_file', 'arguments': '[]'}}]}, 'tool_calls')]:
            with self.subTest(message=message, reason=reason):
                payload = {'choices': [{'message': message, 'finish_reason': reason}]}
                with patch.object(provider.urllib.request.OpenerDirector, 'open', return_value=Response(payload)):
                    with self.assertRaises(StructuredFailure):
                        provider.request(MODEL, MESSAGES, [])
        with self.assertRaises(StructuredFailure):
            streaming.read(io.BytesIO(b'data: [DONE]\n\n'), time.monotonic() + 2, True, None)

    def test_invalid_endpoint_is_rejected_before_contacting_network(self):
        for base in ['https://user:private@fixture.invalid', 'https://fixture.invalid?key=private', 'file:///tmp/model']:
            with self.subTest(base=base), patch.object(provider.urllib.request.OpenerDirector, 'open') as request:
                with self.assertRaises(StructuredFailure):
                    provider.request({**MODEL, 'base': base}, MESSAGES, [])
                request.assert_not_called()
