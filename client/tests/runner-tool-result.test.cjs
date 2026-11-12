'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const catalog = require('../main/agent-runtime/runtime-catalog');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const adapterId of ['codex', 'dsh', 'qwen', 'opencode', 'codex-harness']) {
  test(adapterId + ' honors explicit tool results even when a successful command contains Error', async t => {
    const outcomes = [
      { tool: "$ErrorActionPreference = 'Stop'; Write-Output 'ok'", isError: false },
      { tool: 'stderr', isError: false },
      { tool: 'Run command', isError: true },
      { tool: 'error' }
    ];
    const rows = outcomes.flatMap((result, i) => [
      { seq: i * 2 + 1, kind: 'do', callId: String(i), tool: result.tool },
      { seq: i * 2 + 2, kind: 'out', callId: String(i), text: 'result', ...result }
    ]);
    const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime(adapterId),
      modelConfig: { fetchModel: async () => ({ ok: true, model: { id: "fixture", key: "fixture" } }) },
      runnerRuntime: { async rpc(op) {
        if (op === 'job.session') return { ok: true, data: { status: 'done', items: rows } };
        return { ok: true, data: {} };
      } }
    });
    const session = await adapter.resumeSession({ native: { runner: { openOptions: {
      cwd: os.tmpdir(), resumePath: 'tool-outcome-' + adapterId
    } } } });
    t.after(() => session.dispose());
    const handle = getRunnerSessionDetails(session).handle;
    for (let n = 0; n < 300 && handle.snapshot().tools.length < outcomes.length; n++) await delay(10);
    assert.deepEqual(handle.snapshot().tools.map(tool => [tool.state, tool.isError]), [
      ['done', false], ['done', false], ['error', true], ['error', true]
    ]);
  });
}

test('resumed Harness2 errors show guidance while successful JSON and unknown diagnostics stay intact', async t => {
  const errors = require('../main/access-control/errors');
  const message = 'Model response timed out. Check the selected model service and retry.';
  const envelope = JSON.stringify({ name: 'Harness2Error', message, code: 'model_timeout', phase: 'dom1.a1' });
  const unknown = JSON.stringify({ name: 'ProviderError', message: 'Provider diagnostic', code: 'native_code' });
  const truncated = envelope.slice(0, -2);
  const rows = [
    { seq: 1, kind: 'out', tool: 'error', text: envelope },
    { seq: 2, kind: 'out', tool: 'output', text: envelope, isError: false },
    { seq: 3, kind: 'out', tool: 'error', text: unknown },
    { seq: 4, kind: 'out', tool: 'error', text: truncated },
    { seq: 5, kind: 'do', tool: 'request', callId: 'failed-request' },
    { seq: 6, kind: 'out', tool: 'request', callId: 'failed-request', text: envelope, isError: true },
  ];
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime('harness2'),
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
    runnerRuntime: { async rpc(op) {
      return { ok: true, data: op === 'job.session' ? { status: 'done', items: rows } : {} };
    } },
  });
  const session = await adapter.resumeSession({ native: { runner: { openOptions: {
    cwd: os.tmpdir(), resumePath: 'harness2-structured-errors',
  } } } });
  t.after(() => session.dispose());
  const handle = getRunnerSessionDetails(session).handle;
  for (let n = 0; n < 300 && handle.snapshot().tools.length < 5; n++) await delay(10);
  assert.deepEqual(handle.snapshot().tools.map(tool => [tool.result, tool.isError]), [
    [message, true], [envelope, false], [unknown, true], [truncated, true], [message, true],
  ]);
  assert.equal(errors.message(envelope), message);
  for (const raw of [unknown, truncated, '{"name":"Harness2Error","message":{}}',
    '{"name":"Harness2Error","message":""}', '{"name":"Harness2Error","message":"' + 'x'.repeat(65536) + '"}'])
    assert.equal(errors.message(raw), raw);
});
