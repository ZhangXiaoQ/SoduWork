'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const status = require('../components/panels/panels-chat-status');
const controlled = require('../main/pi-session/controlled-task-turn');
const catalog = require('../main/agent-runtime/runtime-catalog');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');

async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('Fixture did not reach the expected boundary');
}

for (const { id } of catalog.runtimes()) test(id + ': delegated turn survives view switching and reconnects without dispatch replay',
  { timeout: 30000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-controlled-reentry-'));
    const clock = Date.now;
    let now = clock(), release, phase = 'running', reads = 0, dispatches = 0, completed;
    let fixture, nativeSession, view;
    t.after(async () => {
      phase = 'done'; release?.();
      await completed?.catch(() => {});
      view?.stopThinkingClock(); Date.now = clock;
      await fixture?.close(); await nativeSession?.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    });
    let handle;
    if (id === 'pi') {
      fixture = await require('../e2e/fixtures/resumed-pi.cjs').create(root);
      handle = await fixture.open();
    } else {
      const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime(id),
        app: { getPath: () => root },
        modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
        runnerRuntime: { async rpc() { return { ok: true, data: {} }; } } });
      nativeSession = await adapter.createSession({ native: { runner: { openOptions: { cwd: root } } } });
      handle = getRunnerSessionDetails(nativeSession).handle;
    }
    Date.now = () => now;
    const controller = controlled.create({ task: { id: 'isolated-task' }, scope: { turnId: 'isolated-turn' },
      spec: { mode: 'dispatch', context: {}, agentId: 'runner:fixture:' + id },
      wait: () => new Promise(resolve => { release = resolve; }),
      request: async (url, body) => {
        if (body) { dispatches++; return { ref: 'fixture-execution' }; }
        reads++;
        if (phase === 'offline') throw Error('Isolated network failure');
        return { ref: 'fixture-execution', engine: id, status: phase === 'done' ? 'done' : 'running',
          seq: 0, items: [] };
      } });
    const sent = handle.submit('Isolated delegated requirement', [], { taskId: 'isolated-task', controlled: controller });
    assert.equal(sent.accepted, true); completed = sent.completion;
    await until(() => reads === 1 && release);
    // A stale composer timestamp must not override an admitted executor clock.
    const current = { ref: handle.ref, snap: handle.snapshot(), pendingSentAt: now - 9000 };
    const render = () => { current.snap = handle.snapshot(); view.syncThinkingClock(status.runtimeBusy(current.snap)); };
    const elapsed = () => view.metricsHtml(true).match(/data-thinking-elapsed>([^<]*)/)[1];
    view = status.createThinking(() => current);
    render(); now += 13000; render(); assert.equal(elapsed(), '13s');
    const queueId = current.snap.execution.turnQueue.activeQueueId;
    assert.ok(queueId); assert.equal(current.snap.execution.elapsedMs, 13000);
    view.stopThinkingClock();
    current.ref = 'another-conversation'; current.snap = { status: 'idle', messages: [] };
    current.pendingSentAt = 0;
    view.syncThinkingClock(false);
    now += 2000; current.ref = handle.ref; render();
    assert.equal(elapsed(), '15s');
    assert.equal(current.snap.execution.turnQueue.activeQueueId, queueId);
    const stressStart = performance.now();
    for (let i = 0; i < 1000; i++) {
      view.stopThinkingClock();
      current.ref = 'other-' + i; current.snap = { status: 'idle', messages: [] };
      view.syncThinkingClock(false);
      current.ref = handle.ref; render();
      assert.equal(elapsed(), '15s');
      assert.equal(current.snap.execution.turnQueue.activeQueueId, queueId);
    }
    t.diagnostic(JSON.stringify({ switches: 1000, elapsedMs: +(performance.now() - stressStart).toFixed(1), dispatches }));
    phase = 'offline'; release();
    await until(() => reads === 2);
    render(); assert.equal(status.runtimeBusy(current.snap), false);
    assert.match(view.statusHtml(false), /重新连接执行记录/);
    assert.doesNotMatch(view.statusHtml(false), /正在理解|ndot|团队协作/);
    const frozen = elapsed(); now += 8000; render(); assert.equal(elapsed(), frozen);
    release(); await until(() => reads === 3); render();
    assert.equal(elapsed(), frozen, 'repeated failed polls cannot advance a paused clock');
    phase = 'running'; release(); await until(() => reads === 4); render();
    assert.equal(status.runtimeBusy(current.snap), true);
    assert.equal(current.snap.statusText, '', 'a successful receipt clears the previous reconnect reason');
    assert.equal(elapsed(), '23s');
    phase = 'done'; release(); await completed;
    assert.equal(handle.inFlight(), false); assert.equal(dispatches, 1);
    assert.equal(handle.snapshot().messages.filter(row => row.role === 'user' && row.taskId === 'isolated-task').length, 1);
    if (fixture) assert.equal(fixture.requests.length, 0, 'the native Pi model never executes a delegated turn');
  });

test('actual user approval overrides an occupied queue and never displays a thinking indicator', () => {
  const snap = { status: 'waiting-user', pendingUi: { method: 'confirm', title: 'Fixture confirmation' },
    execution: { running: true, elapsedMs: 12000, turnQueue: { activeTaskId: 'task' } } };
  assert.equal(status.runtimeBusy(snap), false);
  const view = status.createThinking(() => ({ ref: 'approval', snap }));
  assert.match(view.statusHtml(false), /等待输入/);
  assert.doesNotMatch(view.statusHtml(false), /正在理解|ndot/);
});
