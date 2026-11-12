'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const errors = require('../main/pi-session/model-errors');
const stream = require('../main/pi-session/event-stream');
const secretBody = '<html><body><h1>504 Gateway Time-out</h1>' +
  "The server didn't respond in time. http://192.0.2.40:8181/private?token=fixture-secret" +
  '<p>Authorization: Bearer fixture-secret</p></body></html>';

test('gateway HTTP status lines and HTML bodies produce stable safe summaries', () => {
  for (const value of ['504 ' + secretBody, 'HTTP/1.1 504 Gateway Time-out\n' + secretBody,
    'HTTP/2 504', '504', 'Error: 504 ' + secretBody, secretBody,
    new Error('504 ' + secretBody), { status: 504, message: secretBody }]) {
    const info = errors.describe(value);
    assert.equal(info.status, 504);
    assert.equal(info.retryable, true);
    assert.equal(errors.forDisplay(value), '模型服务暂时不可用（HTTP 504）');
  }
  for (const value of ['Gateway Time-out', 'Gateway Timeout', 'Bad Gateway',
    "The server didn't respond in time.", 'The server didnt respond in time.']) {
    assert.equal(errors.describe(value).retryable, true);
    assert.equal(errors.forDisplay(value), '模型服务暂时不可用');
  }
});

test('unknown upstream HTML, structured bodies and private addresses never leak into chat', () => {
  for (const value of ['<html><body>unexpected response from http://192.0.2.40/?token=fixture-secret</body></html>',
    '&lt;html&gt;fixture-secret&lt;/html&gt;', 'Unexpected response from http://gateway.internal/private',
    'Invalid endpoint 192.0.2.40:8181', 'Authorization: Bearer fixture-secret',
    '{"unexpected":"fixture-secret"}', { message: 'unexpected', detail: 'fixture-secret' }]) {
    assert.equal(errors.describe(value).retryable, false);
    assert.equal(errors.forDisplay(value), '模型服务返回了暂时无法处理的错误');
  }
  assert.equal(errors.forDisplay('请选择模型后继续'), '请选择模型后继续');
  assert.equal(errors.forDisplay(''), '');
});

test('permanent gateway errors remain non-retryable and both proxy envelope generations are safe', () => {
  for (const status of [400, 401, 403, 404, 413, 422]) {
    const value = status + ' ' + secretBody;
    assert.equal(errors.describe(value).retryable, false);
    assert.match(errors.forDisplay(value), new RegExp('HTTP ' + status));
    assert.doesNotMatch(errors.forDisplay(value), /html|fixture-secret|192\.0\.2\.40/i);
  }
  for (const type of ['soduwork_proxy_error', 'soduwork_work_proxy_error']) {
    assert.equal(errors.describe(JSON.stringify({ error: { type, message: 'fixture-secret' } })).retryable, true);
    assert.doesNotMatch(errors.forDisplay({ error: { type, message: 'fixture-secret' } }), /fixture-secret|proxy_error/);
  }
  assert.equal(errors.describe('429: insufficient_quota').retryable, false);
});

test('expired model proxy tickets can refresh while generic 401 credentials stay permanent', () => {
  for (const value of [
    '401 AI proxy ticket expired',
    '401 session expired',
    '401 密钥不对或已过期',
    { error: { type: 'soduwork_proxy_error', status: 401, message: 'AI proxy ticket is required' } },
  ]) {
    const info = errors.describe(value);
    assert.equal(info.authExpired, true);
    assert.equal(info.retryable, true);
  }
  const generic = errors.describe({ status: 401, message: 'invalid credentials' });
  assert.equal(generic.authExpired, false);
  assert.equal(generic.retryable, false);
});

test('billing exhaustion is actionable and permanent without exposing the provider envelope', async () => {
  for (const value of [
    { error: { status: 429, code: '1113', message: '余额不足 Bearer fixture-secret https://private.invalid' } },
    { error: { status: 429, code: 'upstream_billing_error', providerCode: '1113', type: 'soduwork_proxy_error' } },
    '429 模型服务余额不足（billing_required；供应商错误码 1113）',
    '429 余额不足或无可用资源包',
    { error: { status: 429, code: 'insufficient_quota', message: 'fixture-secret' } },
  ]) {
    const info = errors.describe(value);
    assert.equal(info.retryable, false);
    assert.equal(info.code, 'upstream_billing_error');
    assert.match(info.publicText, /余额不足.*账单.*接口地址/);
    assert.doesNotMatch(info.publicText, /fixture-secret|private.invalid|Bearer/);
  }
  assert.match(errors.forDisplay({ error: { status: 429, code: '1113' } }), /供应商错误码 1113/);
  assert.equal(errors.describe({ error: { status: 429, code: '11130', message: 'rate limited' } }).retryable, true);
  const sdk = await import('@earendil-works/pi-ai');
  assert.equal(sdk.isRetryableAssistantError({ stopReason: 'error', errorMessage:
    '429 模型服务余额不足或计费额度不可用（billing_required；供应商错误码 1113）' }), false);
});

test('image rejection errors explain the safe recovery path without offering a blind retry', () => {
  const value = { error: { code: 'image_input_rejected', message: 'Image input rejected.', status: 400 } };
  const info = errors.describe(value);
  assert.equal(info.retryable, false);
  assert.equal(errors.forDisplay(value), '当前模型不接受图片输入，请切换支持图片的模型或启用视觉适配（HTTP 400）');
});

test('public stream snapshots hide gateway bodies but retain interrupted state and completed work', () => {
  const acc = stream.create(), raw = '504 ' + secretBody;
  acc.push({ type: 'agent_start' });
  acc.push({ type: 'message_start', message: { role: 'assistant', content: [] } });
  acc.push({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: raw,
    content: [{ type: 'text', text: '文件已保存，正在完成总结。' }] } });
  acc.push({ type: 'tool_execution_start', toolCallId: 'saved', toolName: 'write' });
  acc.push({ type: 'tool_execution_end', toolCallId: 'saved', toolName: 'write', result: { content: [{ type: 'text', text: 'saved' }] } });
  acc.push({ type: 'auto_retry_start', attempt: 1, maxAttempts: 1, errorMessage: raw });
  acc.push({ type: 'auto_retry_end', success: false, attempt: 1, finalError: raw });
  acc.push({ type: 'agent_settled' });
  for (const snapshot of [acc.snapshot(), acc.uiSnapshot()]) {
    assert.equal(snapshot.status, 'unreachable');
    assert.equal(snapshot.completion.reason, 'error');
    assert.equal(snapshot.completion.retryable, true);
    assert.equal(snapshot.completion.error, '模型服务暂时不可用（HTTP 504）');
    assert.match(snapshot.statusText, /已有内容和工具结果已保留，可恢复这一轮继续/);
    assert.equal(snapshot.tools.length, 1);
    assert.doesNotMatch(JSON.stringify(snapshot), /html|fixture-secret|192\.0\.2\.40/i);
    assert.match(snapshot.messages[0].blocks[0].text, /文件已保存/);
  }
  assert.equal(acc.state.lastAssistantError, raw, 'raw failure remains only in internal diagnostic state');
});

test('legacy Hub capacity messages retain retryability without guessing unrelated localized errors', () => {
  for (const raw of ['模型并发调度连接中断，请稍后重试', '模型并发调度暂时不可用，请稍后重试']) {
    assert.equal(errors.describe(raw).status, 503);
    assert.equal(errors.describe(raw).retryable, true);
    assert.equal(errors.forDisplay(raw), '模型服务暂时不可用（HTTP 503）');
  }
  for (const raw of ['模型等待队列已满，请稍后重试', '等待模型服务超时，请稍后重试']) {
    assert.equal(errors.describe(raw).status, 429);
    assert.equal(errors.describe(raw).retryable, true);
  }
  assert.equal(errors.describe('模型未授权，请稍后重试').retryable, false);
  assert.equal(errors.describe({status: 403, message: '模型并发调度连接中断，请稍后重试'}).retryable, false);
  const acc = stream.create();
  acc.push({type: 'agent_start'});
  acc.push({type: 'message_end', message: {role: 'assistant', stopReason: 'error',
    errorMessage: '模型并发调度连接中断，请稍后重试'}});
  acc.push({type: 'agent_settled'});
  assert.equal(acc.snapshot().completion.retryable, true);
  assert.match(acc.snapshot().statusText, /可恢复这一轮继续/);
});

test('premature provider streams remain recoverable after bounded SDK retries', () => {
  for (const raw of ['terminated', 'other side closed', 'Connection lost',
    'OpenAI Completions stream ended without a stop reason',
    'Anthropic stream ended before message_stop',
    'OpenAI Responses stream ended before a terminal response event',
    'WebSocket closed', 'socket connection was closed']) {
    assert.equal(errors.describe(raw).retryable, true, raw);
    assert.equal(errors.forDisplay(raw), '模型服务暂时不可用');
    assert.equal(errors.describe('403: ' + raw).retryable, false);
    assert.equal(errors.describe('429: insufficient_quota ' + raw).retryable, false);
  }
  for (const raw of ['Request was aborted', 'Access denied by user or policy.', 'Process terminated with exit code 1']) {
    assert.equal(errors.describe(raw).retryable, false, raw);
  }
});
