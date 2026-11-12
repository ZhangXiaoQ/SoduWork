'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const status = require('../components/panels/panels-chat-status.js');

test('paused queues do not claim thinking; an active ordinary turn and a new send still do', () => {
  const snapshot = {status:'unreachable',execution:{running:false,queue:[],turnQueue:{paused:true}}};
  assert.equal(status.runtimeBusy(snapshot, '', 0), false);
  snapshot.execution.queue.push({id:'waiting',text:'后续工作'});
  assert.equal(status.runtimeBusy(snapshot, '', 0), false, 'waiting work is still paused');
  assert.equal(status.runtimeBusy(snapshot, '用户新提交', Date.now()), true);
  snapshot.execution.turnQueue={activeQueueId:'active-ordinary-turn'};
  assert.equal(status.runtimeBusy(snapshot, '', 0), true);
});

test('retry status shows the reported backoff countdown and returns to reconnecting when it expires', () => {
  const original = Date.now;
  let now = 100000;
  Date.now = () => now;
  try {
    const snap = { modelRetry: { active: true, attempt: 2, max: 3, delayMs: 4000, retryAt: 104000 } };
    assert.match(status.work(snap), /4 秒后重连（2\/3）/);
    now += 1500;
    assert.match(status.work(snap), /3 秒后重连（2\/3）/);
    now = 105000;
    assert.match(status.work(snap), /正在重连（2\/3）/);
    assert.doesNotMatch(status.work(snap), /秒后/);
    snap.modelRetry.active = false;
    assert.doesNotMatch(status.work(snap), /重连/);
    assert.match(status.work({ modelRetry: { active: true, attempt: 1, max: 3 } }), /正在重连（1\/3）/);
  } finally { Date.now = original; }
});

test('provider backoff timing crosses the snapshot boundary without inventing timings for legacy events', () => {
  const acc = require('../main/pi-session/event-stream').create();
  const original = Date.now;
  Date.now = () => 100000;
  try {
    acc.push({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 4000 });
    assert.deepEqual(acc.uiSnapshot().modelRetry, { active: true, attempt: 2, max: 3, delayMs: 4000, retryAt: 104000 });
    acc.push({ type: 'auto_retry_end', success: true });
    assert.equal(acc.uiSnapshot().modelRetry.active, false);
    for (const delayMs of [undefined, -1, NaN, Infinity]) {
      acc.push({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs });
      assert.deepEqual(acc.uiSnapshot().modelRetry, { active: true, attempt: 1, max: 3 });
    }
  } finally { Date.now = original; }
});

test('the existing status timer refreshes the countdown without another runtime snapshot', () => {
  const original = Date.now;
  let now = 100000, view;
  const copy = { textContent: '' };
  const current = { ref: 'retry-chat', snap: { status: 'streaming',
    modelRetry: { active: true, attempt: 1, max: 3, retryAt: 104000 } },
    document: { querySelector: selector => selector.includes('runtime-status')
      ? { querySelector: () => copy } : null } };
  Date.now = () => now;
  try {
    view = status.createThinking(() => current);
    view.syncThinkingClock(true);
    view.refreshThinkingUi();
    assert.match(copy.textContent, /4 秒后重连/);
    now += 2000;
    view.refreshThinkingUi();
    assert.match(copy.textContent, /2 秒后重连/);
    now += 2000;
    view.refreshThinkingUi();
    assert.match(copy.textContent, /正在重连（1\/3）/);
  } finally { view?.stopThinkingClock(); Date.now = original; }
});

test('long-running copy is stable for the same conversation and elapsed slot', () => {
  const execution = { elapsedMs: 180000 };
  assert.equal(status.longWork('chat-1', execution), status.longWork('chat-1', execution));
  assert.ok(status.longWork('chat-1', execution).length > 10);
});

test('goal phases use concise deterministic status copy', () => {
  assert.match(status.work({ execution: { quality: { phase: 'implementing' } } }, '', 'chat'), /实现与运行验证/);
  assert.match(status.work({ execution: {
    quality: { phase: 'repairing' }, harness: { focus: { reason: '补齐登录页验收证据' } },
  } }, '', 'chat'), /补齐登录页验收证据/);
  assert.match(status.work({ execution: {
    quality: { phase: 'reviewing' }, harness: { score: { total: 91, threshold: 85 } },
  } }, '', 'chat'), /91\/85/);
});

test('stalled tools retain real tool and idle information', () => {
  const previous = global.ChatTools;
  global.ChatTools = { render: () => ({ title: '正在构建', sub: '前端' }) };
  try {
    const copy = status.work({
      tools: [{ state: 'running', name: 'bash' }],
      execution: { stalled: true, idleMs: 31000 },
    }, '', 'chat');
    assert.match(copy, /正在构建\s+前端/);
    assert.match(copy, /31 秒/);
  } finally {
    global.ChatTools = previous;
  }
});


test('thinking status follows live blocks and then reconciles provider usage', () => {
  const assistant = { role: 'assistant', blocks: [{ kind: 'text', text: 'ssss' }] };
  const view = status.createThinking(() => ({ snap: { messages: [{ role: 'user' }, assistant] } }));
  assert.match(view.metricsHtml(true), /data-thinking-tokens>1<\/b>/);
  assistant.blocks[0].text = ' \t\n    ';
  assert.match(view.metricsHtml(true), /data-thinking-tokens>—<\/b>/);
  assistant.done = true;
  assistant.usage = { output_tokens: 0 };
  assert.match(view.metricsHtml(false), /data-thinking-tokens>0<\/b>/);
  assistant.usage = { output_tokens: 17 };
  assert.match(view.metricsHtml(true), /data-thinking-tokens>17<\/b>/);
  assistant.usage = { input_tokens: 100, output_tokens: 20, reasoning_tokens: 40, total_tokens: 160 };
  assert.match(view.metricsHtml(true), /data-thinking-tokens>60<\/b>/);
  assistant.usage = { reasoning_tokens: 12 };
  assert.match(view.metricsHtml(true), /data-thinking-tokens>12<\/b>/);
});

test('missing model usage is distinct from a reported zero-token result', () => {
  const current = {
    snap: { status: 'streaming', messages: [{ role: 'user', text: 'continue' }] },
  };
  const view = status.createThinking(() => current);
  assert.match(view.metricsHtml(true), /data-thinking-tokens>0<\/b><em>tokens<\/em>/);

  current.snap = {
    status: 'idle',
    messages: [{ role: 'user', text: 'continue' }, { role: 'assistant', done: true, blocks: [] }],
  };
  assert.match(view.metricsHtml(false), /data-thinking-tokens>—<\/b><em>tokens<\/em>/);

  current.snap = {
    status: 'idle',
    messages: [
      { role: 'user', text: 'continue' },
      { role: 'assistant', done: true, blocks: [], usage: { output_tokens: 0 } },
    ],
  };
  assert.match(view.metricsHtml(false), /data-thinking-tokens>0<\/b><em>tokens<\/em>/);
});

test('a new turn starts at zero in rendered metrics and timer updates without reporting provider usage', () => {
  const originalNow = Date.now;
  let now = 100000, view;
  const tokenNode = { textContent: '' }, estimateNode = { hidden: true };
  const metrics = { querySelector: selector => selector === '[data-thinking-tokens]' ? tokenNode :
    selector === '[data-thinking-estimate]' ? estimateNode : null };
  const current = {
    ref: 'initial-count', pending: 'new request', pendingSentAt: now,
    snap: { status: 'idle', messages: [{ role: 'user' },
      { role: 'assistant', done: true, usage: { output_tokens: 999 }, blocks: [] }] },
    document: { querySelector: selector => selector.includes('turn-metrics') ? metrics : null },
  };
  const initialZero = () => {
    assert.match(view.metricsHtml(true), /data-thinking-tokens>0<\/b>/);
    now += 1000;
    view.refreshThinkingUi();
    assert.equal(tokenNode.textContent, '0');
    assert.equal(estimateNode.hidden, true);
  };
  Date.now = () => now;
  try {
    view = status.createThinking(() => current);
    view.syncThinkingClock(true);
    initialZero();
    current.pending = '';
    current.snap = { status: 'streaming', messages: [{ role: 'user', text: 'new request' }] };
    initialZero();
    const assistant = { role: 'assistant', done: false, blocks: [] };
    current.snap.messages.push(assistant);
    initialZero();
    assert.equal(assistant.usage, undefined, 'initial display must not synthesize provider usage');
    assistant.blocks.push({ kind: 'thinking', text: '开始分析' });
    now += 1000;
    view.refreshThinkingUi();
    assert.equal(tokenNode.textContent, '4');
    assert.equal(estimateNode.hidden, false);
    assistant.blocks = [];
    assistant.done = true;
    current.snap.status = 'idle';
    view.syncThinkingClock(false);
    assert.match(view.metricsHtml(false), /data-thinking-tokens>—<\/b>/);
    current.snap.status = 'streaming';
    assert.match(view.metricsHtml(true), /data-thinking-tokens>—<\/b>/,
      'missing usage after a completed segment is not initialization');
    current.snap.messages = [{ role: 'assistant', done: false, blocks: [] }];
    assert.match(view.metricsHtml(true), /data-thinking-tokens>—<\/b>/,
      'a bounded historical snapshot without the user turn cannot establish initial usage');
  } finally { view?.stopThinkingClock(); Date.now = originalNow; }
});

test('status copy excludes institution promotion throughout normal and stalled rotations', () => {
  const current = { snap: { execution: { running: true, elapsedMs: 0 } },
    workStatus: () => '先把事情想明白，再动手…' };
  const view = status.createThinking(() => current);
  for (let slot = 0; slot < 120; slot++) {
    current.snap.execution.elapsedMs = slot * 14000;
    const html = view.statusHtml(true);
    assert.match(html, /先把事情想明白，再动手/);
    assert.doesNotMatch(html, /\u5b89\u5fbd|\u7814\u7a76\u9662/);
    assert.doesNotMatch(status.rotating('fixture', (slot + 1) * 14000), /\u5b89\u5fbd|\u7814\u7a76\u9662/);
  }
});

test('terminal agent stalls ignore stale busy facts until a later turn is submitted', () => {
  const terminalAt = 5000;
  const snapshot = {
    status: 'streaming',
    execution: {
      running: true,
      stopKind: 'agent-stall',
      terminalAt,
      queued: 0,
      quality: { phase: 'executing' },
      turnQueue: { paused: true, activeTaskId: 'stale-turn' },
    },
  };

  assert.equal(status.runtimeBusy(snapshot, 'original request', terminalAt - 1), false);
  assert.equal(status.runtimeBusy(snapshot, 'retry', terminalAt), true);
  assert.equal(status.runtimeBusy({
    ...snapshot,
    execution: { ...snapshot.execution, queued: 1 },
  }, '', 0), true);
  assert.equal(status.runtimeBusy({ status: 'idle', execution: { running: false } }, '', 0), false);
});

test('thinking status sums separate assistant segments in one turn', () => {
  const current = { snap: { messages: [
    { role: 'user' },
    { role: 'assistant', usage: { output_tokens: 7 }, blocks: [] },
    { role: 'assistant', usage: { output_tokens: 5, reasoning_tokens: 3 }, blocks: [] },
  ] } };
  const view = status.createThinking(() => current);
  assert.match(view.metricsHtml(true), /data-thinking-tokens>15<\/b>/);
});

test('focused chat input keeps the runtime status copy visible', () => {
  const current = {
    ref: 'chat-1',
    snap: { status: 'streaming', execution: { running: true, elapsedMs: 26000 } },
    workStatus: () => 'BASE_STATUS',
  };
  const view = status.createThinking(() => current);
  const copy = html => html.match(/nstatus-copy">([^<]*)/)[1];
  assert.notEqual(copy(view.statusHtml(true)), 'BASE_STATUS');
  view.setDialogFocused(true);
  assert.notEqual(copy(view.statusHtml(true)), '');
  view.setDialogFocused(false);
  assert.notEqual(copy(view.statusHtml(true)), 'BASE_STATUS');
});

test('thinking clock restores runtime elapsed time when a busy conversation is reopened', () => {
  const originalNow = Date.now;
  let now = 1000000;
  const current = {
    ref: 'chat-1',
    snap: { status: 'streaming', execution: { running: true, elapsedMs: 15000 } },
  };
  Date.now = () => now;
  let view;
  try {
    view = status.createThinking(() => current);
    const elapsed = () => view.metricsHtml(true).match(/data-thinking-elapsed>([^<]+)/)[1];

    assert.equal(elapsed(), '15s');
    view.syncThinkingClock(true);
    now += 3000;
    assert.equal(elapsed(), '18s');

    current.ref = 'chat-2';
    current.snap.execution.elapsedMs = 42000;
    view.syncThinkingClock(true);
    assert.equal(elapsed(), '42s');
    now += 2000;
    assert.equal(elapsed(), '44s');
  } finally {
    if (view) view.stopThinkingClock();
    Date.now = originalNow;
  }
});

test('thinking clock resets for a new turn in the same conversation', () => {
  const originalNow = Date.now;
  let now = 5000000;
  const current = {
    ref: 'chat-1', pending: 'first', pendingSentAt: now,
    snap: { status: 'streaming', execution: { running: true, elapsedMs: 0 }, messages: [{ role: 'user', sentAt: now, text: 'first' }] },
  };
  Date.now = () => now;
  let view;
  try {
    view = status.createThinking(() => current);
    view.syncThinkingClock(true);
    now += 6500;
    assert.match(view.metricsHtml(true), /data-thinking-elapsed>6s<\/b>/);

    current.pending = 'second';
    current.pendingSentAt = now;
    current.snap.execution.elapsedMs = 120000;
    current.snap.messages.push({ role: 'user', sentAt: now, text: 'second' });
    view.syncThinkingClock(true);
    assert.match(view.metricsHtml(true), /data-thinking-elapsed>0s<\/b>/);
    now += 1100;
    assert.match(view.metricsHtml(true), /data-thinking-elapsed>1s<\/b>/);
  } finally {
    if (view) view.stopThinkingClock();
    Date.now = originalNow;
  }
});

test('thinking clock does not reuse an idle snapshot duration for a pending turn', () => {
  const originalNow = Date.now;
  let now = 2000000;
  const current = {
    ref: 'chat-1', pending: 'new request',
    snap: { status: 'idle', execution: { running: false, elapsedMs: 120000 } },
  };
  Date.now = () => now;
  let view;
  try {
    view = status.createThinking(() => current);
    assert.match(view.metricsHtml(true), /data-thinking-elapsed>0s<\/b>/);
    view.syncThinkingClock(true);
    now += 1000;
    assert.match(view.metricsHtml(true), /data-thinking-elapsed>1s<\/b>/);

    now += 4000;
    current.pending = '';
    current.snap = { status: 'streaming', execution: { running: true, elapsedMs: 2000 } };
    view.syncThinkingClock(true);
    // The provider's timer starts after local preparation. A smaller runtime
    // value must not rewind the visible submit-to-response clock.
    assert.match(view.metricsHtml(true), /data-thinking-elapsed>5s<\/b>/);
    now += 1000;
    assert.match(view.metricsHtml(true), /data-thinking-elapsed>6s<\/b>/);
  } finally {
    if (view) view.stopThinkingClock();
    Date.now = originalNow;
  }
});

test('thinking clock keeps the final duration after the response settles', () => {
  const originalNow = Date.now;
  let now = 3000000;
  const current = {
    ref: 'chat-1', pending: 'request',
    snap: { status: 'streaming', execution: { running: true, elapsedMs: 0 } },
  };
  Date.now = () => now;
  let view;
  try {
    view = status.createThinking(() => current);
    view.syncThinkingClock(true);
    now += 4200;
    assert.match(view.metricsHtml(true), /data-thinking-elapsed>4s<\/b>/);
    current.pending = '';
    current.snap = { status: 'idle', execution: { running: false, elapsedMs: 0 } };
    view.syncThinkingClock(false);
    assert.match(view.metricsHtml(false), /data-thinking-elapsed>4s<\/b>/);
  } finally {
    if (view) view.stopThinkingClock();
    Date.now = originalNow;
  }
});

test('thinking clock does not carry a settled duration into another conversation', () => {
  const originalNow = Date.now;
  let now = 4000000;
  const current = {
    ref: 'chat-1', pending: 'request',
    snap: { status: 'streaming', execution: { running: true, elapsedMs: 0 } },
  };
  Date.now = () => now;
  let view;
  try {
    view = status.createThinking(() => current);
    view.syncThinkingClock(true);
    now += 3500;
    current.pending = '';
    current.snap = { status: 'idle', execution: { running: false, elapsedMs: 0 } };
    view.syncThinkingClock(false);
    assert.match(view.metricsHtml(false), /data-thinking-elapsed>3s<\/b>/);

    current.ref = 'chat-2';
    view.syncThinkingClock(false);
    assert.match(view.metricsHtml(false), /data-thinking-elapsed>0s<\/b>/);
  } finally {
    if (view) view.stopThinkingClock();
    Date.now = originalNow;
  }
});

test('live SDK zero usage never masks growing reasoning, final nested reasoning is not counted twice', () => {
  const message={role:'assistant',done:false,blocks:[{kind:'thinking',text:'逐项检查'}],usage:{input:0,output:0,totalTokens:0}};
  const current={snap:{status:'streaming',messages:[{role:'user'},message]}};
  const view=status.createThinking(()=>current);
  assert.match(view.metricsHtml(true),/data-thinking-tokens>4<\/b>/);
  assert.match(view.metricsHtml(true),/data-thinking-estimate aria-label/);
  message.blocks[0].text+='新的证据';
  assert.match(view.metricsHtml(true),/data-thinking-tokens>8<\/b>/);
  message.done=true;message.usage={input_tokens:100,output_tokens:60,total_tokens:160,completion_tokens_details:{reasoning_tokens:40}};
  assert.match(view.metricsHtml(false),/data-thinking-tokens>60<\/b>/);
  assert.match(view.metricsHtml(false),/data-thinking-estimate hidden/);
});
test('cached prompt usage does not reduce the reported output count', () => {
  const view=status.createThinking(()=>({snap:{messages:[{role:'user'},{role:'assistant',done:true,usage:{input_tokens:100,cached_input_tokens:80,output_tokens:60,reasoning_tokens:40,total_tokens:160}}]}}));
  assert.match(view.metricsHtml(false),/data-thinking-tokens>60<\/b>/);
});
test('reopened completed turn uses the saved execution duration', () => {
  const view=status.createThinking(()=>({snap:{status:'idle',execution:{running:false,elapsedMs:185000},messages:[{role:'user'},{role:'assistant',done:true}]}}));
  assert.match(view.metricsHtml(false),/data-thinking-elapsed>3m 05s<\/b>/);
});

test('a user-only history archive has unknown duration until delegated timing arrives', () => {
  const current = { snap: { status: 'idle', messages: [{ role: 'user', text: 'Restore my work' }] } };
  const view = status.createThinking(() => current);
  assert.match(view.metricsHtml(false), /data-thinking-elapsed>未记录<\/b>/);
  current.snap.execution = { controlled: true, running: false, elapsedMs: 47000 };
  assert.match(view.metricsHtml(false), /data-thinking-elapsed>47s<\/b>/);
});

test('completed clock uses the persisted turn boundary after waiting, switching and reopening', () => {
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  const done = { status: 'idle', execution: { running: false, elapsedMs: 90000 },
    history: { messageIndices: [8, 9] }, turnMetrics: [{ fromMessage: 8, toMessage: 9, elapsedMs: 4000 }],
    messages: [{ role: 'user', sentAt: 1000 }, { role: 'assistant', done: true, completedAt: 5000 }] };
  const current = { ref: 'first', snap: done };
  const view = status.createThinking(() => current);
  try {
    view.syncThinkingClock(false);
    assert.match(view.metricsHtml(false), /data-thinking-elapsed>4s<\/b>/);
    now += 60000; done.execution.elapsedMs += 60000;
    view.syncThinkingClock(false);
    assert.match(view.metricsHtml(false), /data-thinking-elapsed>4s<\/b>/);
    current.ref = 'second'; current.snap = { messages: [] };
    view.syncThinkingClock(false);
    current.ref = 'first'; current.snap = done;
    view.syncThinkingClock(false);
    assert.match(view.metricsHtml(false), /data-thinking-elapsed>4s<\/b>/);
    const reopened = status.createThinking(() => current);
    assert.match(reopened.metricsHtml(false), /data-thinking-elapsed>4s<\/b>/);
    delete done.turnMetrics;
    assert.match(reopened.metricsHtml(false), /data-thinking-elapsed>4s<\/b>/, 'message timestamps are a stable legacy fallback');
  } finally { view.stopThinkingClock(); Date.now = originalNow; }
});

test('completion while away discards the local open-panel clock and unknown history is not zero', () => {
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  const current = { ref: 'first', pendingSentAt: now, snap: { status: 'streaming', execution: { running: true, elapsedMs: 0 },
    messages: [{ role: 'user', sentAt: now }] } };
  const view = status.createThinking(() => current);
  try {
    view.syncThinkingClock(true);
    now += 120000;
    current.snap.execution = { running: false, elapsedMs: 120000 };
    current.snap.status = 'idle';
    current.snap.messages.push({ role: 'assistant', done: true, completedAt: 104000 });
    view.syncThinkingClock(false);
    assert.match(view.metricsHtml(false), /data-thinking-elapsed>4s<\/b>/);
    current.ref = 'unknown'; current.pendingSentAt = 0;
    current.snap = { status: 'idle', execution: { running: false, elapsedMs: 0 },
      messages: [{ role: 'user' }, { role: 'assistant', done: true }] };
    view.syncThinkingClock(false);
    assert.match(view.metricsHtml(false), /data-thinking-elapsed>未记录<\/b>/);
  } finally { view.stopThinkingClock(); Date.now = originalNow; }
});


test('cloud timer ignores an old local submit and resets for the authoritative remote turn', () => {
  const originalNow = Date.now;
  let now = 1792810800000;
  Date.now = () => now;
  const current = { ref: 'cloud', pendingSentAt: now - 2700000000,
    snap: { status: 'streaming', messages: [{role:'assistant',done:false}],
      execution: { cloud:true,running:true,elapsedMs:14000,timingTurn:'run:1' } } };
  const view = status.createThinking(() => current);
  try {
    view.syncThinkingClock(true);
    assert.match(view.metricsHtml(true), /data-thinking-elapsed>14s</);
    now += 1000;
    assert.match(view.metricsHtml(true), /data-thinking-elapsed>15s</);
    current.snap.execution = { cloud:true,running:true,elapsedMs:2000,timingTurn:'run:2' };
    view.syncThinkingClock(true);
    assert.match(view.metricsHtml(true), /data-thinking-elapsed>2s</);
    current.snap.status = 'idle';
    current.snap.execution = { cloud:true,running:false,elapsedMs:5000,timingTurn:'run:2' };
    view.syncThinkingClock(false);
    now += 86400000;
    assert.match(view.metricsHtml(false), /data-thinking-elapsed>5s</);
    current.snap.execution.elapsedMs = null;
    assert.match(view.metricsHtml(false), /data-thinking-elapsed>未记录</);
  } finally { view.stopThinkingClock(); Date.now = originalNow; }
});
