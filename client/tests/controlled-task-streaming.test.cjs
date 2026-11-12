'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../main/agent-runtime/runtime-catalog');
const controlled = require('../main/pi-session/controlled-task-turn');
const stream = require('../main/pi-session/event-stream');
const taskStream = require('../main/conversation/task-message-stream.cjs');
const context = require('../core/requirement-session-context');

function fixture() {
  const acc = stream.create(), saved = [], states = [];
  const messages = taskStream.create(acc.state, row => saved.push(row));
  const handle = { taskMessageStreaming: true,
    appendTaskMessage(role, text) {
      if (role === 'assistant') assert.fail('A streamed answer must retain its original row: ' + text);
    },
    appendTaskRuntimeEvent(item, taskId) {
      if (item.kind === 'task-stream-end') messages.finish(item.streamPrefix);
      else messages.apply(item, taskId);
    }, appendTaskTool(event) { acc.push(event); }, taskExecutionChanged(value) { states.push(value); } };
  return { acc, saved, states, handle };
}

for (const { id } of catalog.runtimes()) {
  test(id + ': controlled dispatch keeps the chosen runtime, coalesces overlap, and restores the complete answer', async () => {
    const f = fixture(); let reads = 0, dispatches = 0;
    const chunks = ['我会', '先查看工作目录', '，再创作并核', '验散文文件。'];
    const events = chunks.map((text, index) => ({ seq: index + 1, kind: 'say', streamId: 'answer', delta: true, text }));
    const turn = controlled.create({ task: { id: 'task' }, scope: {},
      spec: { mode: 'dispatch', context: {}, agentId: 'runner:device:' + id }, wait: async () => {},
      request: async (url, body) => {
        if (body) { dispatches++; assert.equal(body.assigneeId, 'runner:device:' + id); return { ref: 'ref' }; }
        reads++;
        if (reads === 2) throw Error('temporary connection loss');
        const end = reads > 2;
        return { ref: 'ref', engine: id, status: end ? 'done' : 'running', seq: 4,
          last: end ? 4 : 2, items: end ? events : events.slice(0, 2) };
      } });
    assert.equal((await turn.execute(f.handle, 'request', [])).ok, true);
    assert.equal(dispatches, 1); assert.equal(reads, 3); assert.equal(f.saved.length, 1);
    assert.equal(f.saved[0].text, chunks.join('')); assert.equal(f.saved[0].sourceAgent.agentId, id);
    assert.equal(f.acc.snapshot().messages.length, 1); assert.equal(f.acc.snapshot().messages[0].done, true);
    const native = f.saved.map(row => taskStream.nativeMessage(row, { api: 'openai-completions', provider: 'fixture', id: 'fixture' }));
    const restored = stream.create();
    require('../main/pi-session/history-seed').seed(restored, { state: { messages: native },
      sessionManager: { getEntries: () => native.map(message => ({ type: 'message', message })) } });
    assert.equal(restored.snapshot().messages.length, 1);
    assert.equal(restored.snapshot().messages[0].blocks[0].text, chunks.join(''));
    assert.equal(restored.snapshot().messages[0].sourceAgent.agentId, id);
  });

  test(id + ': assigned conversation controls reflect the bound executor without changing the archive host', () => {
    const task = { id: 'task', executionContext: { agent: { id: 'runner:device:' + id } },
      workRouting: { conversationTurn: { conversationId: 'chat', executor: 'dispatch' } } };
    assert.equal(context.executionRuntime(task, 'chat', []), id);
    assert.equal(context.executionRuntime(task, 'other', []), '');
    assert.equal(context.executionRuntime({ ...task, workRouting: {} }, 'chat', []), '');
    assert.equal(context.executionRuntime(task, 'chat', [{ taskId: 'other', executor: 'dispatch', run: { engine: 'pi' } }]), id);
    assert.equal(context.executionRuntime(task, 'chat', [{ taskId: 'task', executor: 'dispatch', run: { engine: 'qwen' } }]), 'qwen');
    assert.equal(context.executionRuntime({ ...task, workRouting: { conversationTurn: { conversationId: 'chat', executor: 'native' } } }, 'chat', []), '');
  });
}

test('finished requirements cannot relabel the selected conversation runtime with persisted dispatch metadata', () => {
  for (const { id } of catalog.runtimes()) {
    for (const status of ['done', 'cancel']) {
      const task = { id: 'task', status, executionContext: { agent: { id: 'runner:device:' + id } },
        workRouting: { conversationTurn: { conversationId: 'chat', executor: 'dispatch', state: 'completed' } } };
      const executions = [{ taskId: 'task', executor: 'dispatch', status: 'completed', run: { engine: id } }];
      const before = JSON.stringify({ task, executions });
      assert.equal(context.executionRuntime(task, 'chat', executions), '', id + ': ' + status);
      assert.equal(JSON.stringify({ task, executions }), before, 'display selection must preserve task receipts');
    }
  }
});

test('unfinished review and rework retain the assigned executor after a completed dispatch turn', () => {
  for (const status of ['todo', 'doing', undefined]) {
    const task = { id: 'task', status, requirementStage: 'reviewing',
      executionContext: { agent: { id: 'runner:device:harness2' } }, workRouting: {
        conversationTurn: { conversationId: 'chat', executor: 'dispatch', state: 'completed' },
        reworkPending: { feedback: 'Revise the original deliverable' },
      } };
    assert.equal(context.executionRuntime(task, 'chat', []), 'harness2');
    assert.equal(context.executionRuntime(task, 'chat', [{ taskId: 'task', executor: 'dispatch',
      status: 'completed', run: { engine: 'qwen' } }]), 'qwen');
  }
});

test('custom runtime identifiers stay explicit while malformed routing metadata cannot become a runtime choice', () => {
  const task = { id: 'task', workRouting: { conversationTurn: { conversationId: 'chat', executor: 'dispatch' } } };
  for (const id of ['custom-reviewer', 'local:custom-reviewer', 'runner:device:custom-reviewer'])
    assert.equal(context.executionRuntime({ ...task, agentId: id }, 'chat', []), 'custom-reviewer');
  for (const id of ['runner:device:', '<b>pi</b>', 'x'.repeat(41)])
    assert.equal(context.executionRuntime({ ...task, agentId: id }, 'chat', []), '');
});

test('stopped and failed executions persist partial text without a false success reply', async () => {
  for (const status of ['failed', 'stopped']) {
    const f = fixture();
    const turn = controlled.create({ task: { id: 't' }, scope: {}, spec: { mode: 'dispatch', context: {}, agentId: 'local:codex-harness' },
      request: async (url, body) => body ? { ref: 'ref' } : { ref: 'ref', engine: 'codex-harness', status, seq: 1,
        items: [{ seq: 1, kind: 'say', text: 'Partial answer', streamId: 'answer', delta: true }] } });
    const result = await turn.execute(f.handle, 'request', []);
    assert.equal(result.ok, status !== 'failed'); assert.equal(result.cancelled, status === 'stopped');
    assert.equal(f.saved.length, 1); assert.equal(f.saved[0].text, 'Partial answer');
  }
});

test('late execution identity updates a partial row and survives metadata-free terminal pages', async () => {
  const f = fixture(); let page = 0;
  const turn = controlled.create({ task: { id: 't' }, scope: {}, spec: { mode: 'dispatch', context: {} }, wait: async () => {},
    request: async (url, body) => {
      if (body) return { ref: 'ref' };
      page++;
      return { ref: 'ref', ...(page === 2 ? { engine: 'codex-harness' } : {}), status: page === 3 ? 'done' : 'running',
        last: page, seq: 3, items: [{ seq: page, kind: 'say', text: String(page), streamId: 'answer', delta: true }] };
    } });
  await turn.execute(f.handle, 'request', []);
  assert.equal(f.saved[0].text, '123');
  assert.equal(f.saved[0].sourceAgent.agentId, 'codex-harness');
  assert.equal(f.acc.snapshot().messages[0].sourceAgent.agentId, 'codex-harness');
});

test('terminal persistence failure retries the same execution without duplicating output or dispatch', async () => {
  const f = fixture(); let writes = 0, dispatches = 0, reads = 0;
  const append = f.handle.appendTaskRuntimeEvent;
  f.handle.appendTaskRuntimeEvent = (item, taskId) => {
    if (item.kind === 'task-stream-end' && ++writes === 1) throw Error('temporary disk failure');
    return append(item, taskId);
  };
  const turn = controlled.create({ task: { id: 't' }, scope: {}, spec: { mode: 'dispatch', context: {} }, wait: async () => {},
    request: async (url, body) => {
      if (body) { dispatches++; return { ref: 'ref' }; }
      reads++;
      return { ref: 'ref', engine: 'codex-harness', status: 'done', seq: 1,
        items: [{ seq: 1, kind: 'say', text: 'Complete answer', streamId: 'answer', delta: true }] };
    } });
  assert.equal((await turn.execute(f.handle, 'request', [])).ok, true);
  assert.equal(dispatches, 1); assert.equal(reads, 2);
  assert.equal(f.saved.length, 1); assert.equal(f.saved[0].text, 'Complete answer');
});

test('an older completed receipt cannot finalize a newer rework stream before its own turn ends', async () => {
  const f = fixture(); let reads = 0, sends = 0, collections = 0;
  const key = 'comment:new-rework';
  const turn = controlled.create({ task: { id: 't' }, scope: { conversationId: 'chat', turnId: 'revision' },
    spec: { mode: 'dispatch', context: {}, continuationRef: 'original-ref' }, wait: async () => {},
    request: async (url, body) => {
      if (url.endsWith('/ai-say')) { sends++; return { delivery: 'accepted', admissionKey: key }; }
      if (url.includes('/ai-status')) { collections++; return {}; }
      assert.equal(body, undefined);
      if (++reads === 2) assert.equal(f.saved.length, 0, 'old completion must leave current text open');
      return { ref: 'original-ref', engine: 'codex-harness', status: 'done', admissionKey: 'comment:old',
        seq: reads === 1 ? 1 : 3, last: reads === 1 ? 1 : 3,
        items: reads === 1 ? [{ seq: 1, kind: 'say', streamId: 'answer', delta: true, text: 'New ', admissionKey: key }] : [
          { seq: 2, kind: 'say', streamId: 'answer', delta: true, text: 'answer', admissionKey: key },
          { seq: 3, kind: 'turn-end', turnState: 'done', admissionKey: key }] };
    } });
  assert.equal((await turn.execute(f.handle, 'fix the output', [])).ok, true);
  assert.equal(sends, 1); assert.equal(reads, 2); assert.equal(collections, 1);
  assert.equal(f.saved.length, 1); assert.equal(f.saved[0].text, 'New answer');
});

test('ten thousand replayed chunks produce one paragraph and one archive write', async t => {
  const f = fixture(), count = 10000;
  const events = Array.from({ length: count }, (_, index) => ({ seq: index + 1, kind: 'say',
    text: String(index % 10), streamId: 'answer', delta: true }));
  let reads = 0, dispatches = 0;
  const start = performance.now();
  const turn = controlled.create({ task: { id: 'load' }, scope: {}, spec: { mode: 'dispatch', context: {} }, wait: async () => {},
    request: async (url, body) => {
      if (body) { dispatches++; return { ref: 'load-ref' }; }
      const last = Math.min(++reads * 100, count);
      return { ref: 'load-ref', engine: 'codex-harness', status: last === count ? 'done' : 'running',
        last, seq: count, items: events.slice(Math.max(0, last - 120), last) };
    } });
  await turn.execute(f.handle, 'request', []);
  assert.equal(dispatches, 1); assert.equal(reads, 100); assert.equal(f.saved.length, 1);
  assert.equal(f.acc.snapshot().messages.length, 1);
  assert.equal(f.saved[0].text, events.map(row => row.text).join(''));
  t.diagnostic(JSON.stringify({ chunks: count, pages: reads, archiveWrites: f.saved.length, elapsedMs: +(performance.now() - start).toFixed(1) }));
});

test('long controlled answers retain their beginning and Unicode through persistence and reopening', async t => {
  const f = fixture();
  const expected = 'BEGIN\n' + Array.from({ length: 12000 }, (_, i) => 'Section ' + i + ': complete content \u4f60\u597d\ud83d\ude42\n').join('') + 'END';
  const chunks = [];
  for (let at = 0; at < expected.length; at += 2048) chunks.push(expected.slice(at, at + 2048));
  const events = chunks.map((text, i) => ({ seq: i + 1, kind: 'say', streamId: 'long-answer', delta: true, text }));
  let reads = 0;
  const start = performance.now();
  const turn = controlled.create({ task: { id: 'long' }, scope: {}, spec: { mode: 'dispatch', context: {} }, wait: async () => {},
    request: async (url, body) => {
      if (body) return { ref: 'long-ref' };
      const last = Math.min(++reads * 20, events.length);
      return { ref: 'long-ref', engine: 'codex-harness', status: last === events.length ? 'done' : 'running',
        last, seq: events.length, items: events.slice(Math.max(0, last - 25), last) };
    } });
  assert.equal((await turn.execute(f.handle, 'request', [])).ok, true);
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].text, expected);
  assert.equal(f.acc.snapshot().messages[0].blocks[0].text, expected);
  const native = f.saved.map(row => taskStream.nativeMessage(row, { provider: 'fixture', id: 'fixture' }));
  const restored = stream.create();
  require('../main/pi-session/history-seed').seed(restored, { state: { messages: native },
    sessionManager: { getEntries: () => native.map(message => ({ type: 'message', message })) } });
  assert.equal(restored.snapshot().messages[0].blocks[0].text, expected);
  t.diagnostic(JSON.stringify({ characters: expected.length, chunks: chunks.length, pages: reads,
    archiveWrites: f.saved.length, elapsedMs: +(performance.now() - start).toFixed(1) }));
});

test('a long replay page crosses the unchanged native RPC budget without dropping answer text', async t => {
  const { MessageChannel } = require('node:worker_threads');
  const { createRpcPeer } = require('../main/agent-runtime/process-rpc');
  const { port1, port2 } = new MessageChannel();
  const f = fixture();
  const left = createRpcPeer({ send: packet => port1.postMessage(packet) });
  const right = createRpcPeer({ send: packet => port2.postMessage(packet), handlers: {
    batch: operations => require('../main/conversation/task-output-batch.cjs').apply(f.handle, operations),
  } });
  port1.on('message', left.receive); port2.on('message', right.receive);
  t.after(() => { left.close(); right.close(); port1.close(); port2.close(); });
  const output = require('../main/conversation/task-live-output').create({ taskMessageStreaming: true,
    appendTaskBatch: operations => left.call('batch', [operations]),
  }, 'large-replay', { coalesceText: true });
  const chunks = Array.from({ length: 100 }, (_, i) => i + ':' + 'complete Unicode \u4f60\u597d\ud83d\ude42\n'.repeat(200));
  const events = chunks.map((text, i) => ({ seq: i + 1, kind: 'say', streamId: 'reply', delta: true, text }));
  await output.consume('large-page', events);
  await output.consume('large-page', events);
  await output.finish('large-page');
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].text, chunks.join(''));
  assert.equal(f.acc.snapshot().messages.length, 1);
});

test('snapshot batching preserves tool boundaries, distinct paragraphs and completed receipts', async () => {
  const calls = [];
  const output = require('../main/conversation/task-live-output').create({ taskMessageStreaming: true,
    appendTaskBatch: async operations => calls.push(...operations),
  }, 'ordered', { coalesceText: true });
  await output.consume('ref', [
    { seq: 1, kind: 'say', streamId: 'first', text: 'A', delta: true },
    { seq: 2, kind: 'say', streamId: 'first', text: 'B', delta: true },
    { seq: 3, kind: 'do', callId: 'read', tool: 'read' },
    { seq: 4, kind: 'out', callId: 'read', tool: 'read', text: 'evidence' },
    { seq: 5, kind: 'say', streamId: 'second', text: 'Second', done: true },
    { seq: 6, kind: 'say', streamId: 'first', text: 'C', delta: true, done: true },
  ]);
  assert.deepEqual(calls.map(row => row.method), ['appendTaskRuntimeEvent', 'appendTaskTool',
    'appendTaskTool', 'appendTaskRuntimeEvent', 'appendTaskRuntimeEvent']);
  assert.equal(calls[0].args[0].text, 'AB');
  assert.equal(calls[1].args[0].type, 'tool_execution_start');
  assert.equal(calls[2].args[0].type, 'tool_execution_end');
  assert.equal(calls[3].args[0].text, 'Second');
  assert.equal(calls[3].args[0].done, true);
  assert.equal(calls[4].args[0].text, 'ABC');
  assert.equal(calls[4].args[0].done, true);
  assert.equal(output.text('ref'), 'ABC\n\nSecond');
});
