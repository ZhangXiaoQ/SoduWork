'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

const rendererSource = fs.readFileSync(
  path.join(__dirname, '../components/panels/chat-message-renderer.js'), 'utf8');
const taskControllerSource = fs.readFileSync(
  path.join(__dirname, '../components/panels/chat-task-controller.js'), 'utf8');
const markdownSource = fs.readFileSync(
  path.join(__dirname, '../components/panels/chat-markdown.js'), 'utf8');
const markedSource = fs.readFileSync(
  path.join(__dirname, '../vendor/markdown/marked.umd.js'), 'utf8');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function setup() {
  const sandbox = { console };
  sandbox.window = sandbox;
  for (const helper of ['chat-context-meter', 'chat-scroll-follow', 'chat-markdown']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/' + helper + '.js'), 'utf8'), sandbox);
  }
  vm.runInNewContext(rendererSource, sandbox);
  const ctx = {
    esc: escapeHtml,
    _ref: 'markdown-test',
    _snap: { status: 'idle' },
    _liveTextKey: '',
    _openThink: new Set(),
    _openTool: new Set(),
    _hotToolBodies: new Set(),
  };
  return { sandbox, ctx, renderer: sandbox.ChatMessageRenderer.create(ctx) };
}

function body(html) {
  return html.slice(0, html.indexOf('<button'));
}

test('timestamps use the local calendar, retain historical dates and reveal the complete event time', () => {
  const { renderer, sandbox } = setup();
  const today = new Date(); today.setHours(13, 7, 9, 0);
  const render = date => renderer._messageFooter({ role: 'user', sentAt: date.getTime() }, 'Question');
  assert.match(render(today), />13:07<\/time>/);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const past = render(yesterday);
  assert.match(past, /tabindex="0"/);
  assert.match(past, /title="\d{4}-\d{2}-\d{2} 13:07:09"/);
  assert.doesNotMatch(past, />13:07<\/time>/);
  const older = new Date(today); older.setFullYear(older.getFullYear() - 1);
  assert.ok(render(older).includes(older.getFullYear() + '年'));
  sandbox.SoduWorkI18n = { getLocale: () => 'en-US' };
  const label = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric',
    ...(yesterday.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) }).format(yesterday);
  assert.ok(render(yesterday).includes(label + ' 13:07'));
  assert.doesNotMatch(renderer._messageFooter({ role: 'assistant', done: false, completedAt: today.getTime() }, ''), /<time/);
  assert.doesNotMatch(renderer._messageFooter({ role: 'assistant', done: true }, ''), /<time/);
});

test('read-aloud controls belong only to completed assistant footers', () => {
  const { sandbox, renderer } = setup();
  sandbox.SoduWorkReadAloud = { button: () => '<button data-speech-play>Read aloud</button>' };
  assert.match(renderer._messageFooter({ role: 'assistant', done: true }, 'Answer', -1, 2), /data-speech-play/);
  const footer = renderer._messageFooter({ role: 'assistant', done: true, completedAt: 1700000000000 }, 'Answer', -1, 2);
  assert(footer.indexOf('nmessage-time') < footer.indexOf('data-speech-play'));
  assert(footer.indexOf('data-speech-play') < footer.indexOf('data-copy-message'));
  assert.doesNotMatch(renderer._messageFooter({ role: 'user' }, 'Question'), /data-speech-play/);
  assert.doesNotMatch(renderer._messageFooter({ role: 'assistant', done: false }, 'Partial'), /data-speech-play/);
  assert.doesNotMatch(renderer._messageFooter({ role: 'assistant', done: true }, '  '), /data-speech-play/);
});

test('reasoning closes when a later block starts despite a stale done flag', () => {
  for (const kind of ['text', 'toolCall', 'thinking']) {
    const { renderer, ctx } = setup();
    const thought = { kind: 'thinking', text: 'Plan', done: false };
    ctx._snap = { status: 'streaming', messages: [{ role: 'assistant', done: false, blocks: [thought] }] };
    assert.match(renderer._blockHtml(0, thought, 0), /nthink open is-live/);
    ctx._snap.messages[0].blocks.push({ kind, text: 'Next phase' });
    assert.doesNotMatch(renderer._blockHtml(0, thought, 0), /nthink open|is-live/);
    ctx._openThink.add('0:0');
    assert.match(renderer._blockHtml(0, thought, 0), /nthink open/,
      'readers can reopen completed reasoning');
  }
});

test('manual acceptance analysis is shown as a pending human review result', () => {
  const { renderer } = setup();
  const html = renderer._blockHtml(0, {
    kind: 'text',
    text: '【验收分析结果】\n需求：写荷花作文\n建议结果：通过\n待人工确认：用途与文风',
  }, 0);
  assert.match(html, /nacceptance-result/);
  assert.match(html, /is-analysis/);
  assert.match(html, /验收分析结果/);
  assert.match(html, /待人工确认/);
  assert.doesNotMatch(html, /自动验收通过/);
});

test('manual analysis result exposes only the final reject and confirm actions', () => {
  const { renderer, ctx } = setup();
  ctx._collaborationTrace = {approvals:[{id:'review-1',action:'review',status:'pending'}]};
  ctx._sessionOptions = { taskRef: 'task-1', approvalId: 'review-1', acceptanceSession: true };
  const html = renderer._blockHtml(0, {
    kind: 'text', text: '【验收分析结果】\n需求：写荷花作文\n建议结果：通过',
  }, 0);
  assert.match(html, /data-acceptance-result-action="reject"/);
  assert.match(html, /data-acceptance-result-action="approve"/);
  assert.doesNotMatch(html, /data-tfd-acceptance-mode/);
});

test('manual analysis result keeps actions when the model adds a preface and the task id is restored from the binding', () => {
  const { renderer, ctx } = setup();
  ctx._sessionOptions = { acceptanceSession: true };
  ctx._activeCollabTaskId = 'task-restored';
  ctx._collabTasks = new Map([['task-restored', {
    trace: { approvals: [{ id: 'review-restored', action: 'review', status: 'pending' }] },
  }]]);
  const html = renderer._blockHtml(0, {
    kind: 'text',
    text: '我已逐项核对交付物，下面给出结果。\n\n### 【验收分析结果】\n建议结果：通过',
  }, 0);
  assert.match(html, /nacceptance-result/);
  assert.match(html, /data-acceptance-result-task="task-restored"/);
  assert.match(html, /data-acceptance-result-approval="review-restored"/);
  assert.match(html, /data-acceptance-result-action="approve"/);
});

test('manual analysis result provides a separate supplemental-analysis handoff', () => {
  const { renderer, ctx } = setup();
  ctx._collaborationTrace = {approvals:[{id:'review-1',action:'review',status:'pending'}]};
  ctx._sessionOptions = { taskRef: 'task-1', approvalId: 'review-1', acceptanceSession: true };
  const html = renderer._blockHtml(0, {
    kind: 'text', text: '【验收分析结果】\n建议结果：通过',
  }, 0);
  assert.match(html, /data-acceptance-result-analysis/);
  assert.match(html, /data-acceptance-result-action="analyze"/);
  assert.match(html, /补充分析项/);
  assert.match(rendererSource, /data-acceptance-result-action.*analyze/);
  assert.match(rendererSource, /#nchatInput/);
  assert.match(rendererSource, /已填入对话框，请按需选择插件后发送/);
});

test('manual analysis result keeps the human review entry when the active task is known outside session options', () => {
  const { renderer, ctx } = setup();
  ctx._collaborationTrace = {approvals:[{id:'review-1',action:'review',status:'pending'}]};
  // Re-opening the execution conversation can restore the native task binding
  // before the transient acceptance flags.  The result must still expose the
  // reviewer note and approve/reject controls instead of falling back to plain
  // Markdown with no way to finish the acceptance round.
  ctx._sessionOptions = { approvalId: 'review-1', acceptanceExecutionSession: true };
  ctx._activeCollabTaskId = 'task-1';
  const html = renderer._blockHtml(0, {
    kind: 'text', text: '【验收分析结果】\n需求：写荷花作文\n建议结果：通过\n待人工确认：用途与文风',
  }, 0);
  assert.match(html, /data-acceptance-result-note/);
  assert.match(html, /data-acceptance-result-action="reject"/);
  assert.match(html, /data-acceptance-result-action="approve"/);
});

test('automatic acceptance output keeps the audit-result label', () => {
  const { renderer } = setup();
  const html = renderer._blockHtml(0, {
    kind: 'text',
    text: '【验收确认卡】\n需求：写荷花作文\n结果：验收通过',
  }, 0);
  assert.match(html, /自动验收审核结果/);
  assert.match(html, /已确认/);
});

test('opening an acceptance session suppresses the stale pending card on the source chat', () => {
  const harness = setupRender();
  const { renderer, ctx, list, sandbox } = harness;
  const entry = {
    taskId: 'task-acceptance',
    task: { title: '写荷花作文' },
    nativeTurn: true,
    trace: { approvals: [{ id: 'approval-1', action: 'review', status: 'pending' }] },
  };
  const root = {
    dataset: {},
    getAttribute(name) { return name === 'data-task-confirmation' ? entry.taskId : ''; },
    addEventListener() {},
    querySelectorAll() { return []; },
  };
  ctx._collabEntries = () => [entry];
  ctx._collabTasks.set(entry.taskId, entry);
  list.querySelectorAll = selector => selector === '[data-task-confirmation]' ? [root] : [];
  let onAcceptanceOpened;
  sandbox.TaskTraceApproval = {
    html() { return '<section data-acceptance-marker="1"></section>'; },
    bind(_root, state) { onAcceptanceOpened = state.opts.onAcceptanceOpened; },
  };
  renderer._render();
  assert.match(list.innerHTML, /data-acceptance-marker/);
  assert.equal(typeof onAcceptanceOpened, 'function');
  onAcceptanceOpened('approval-1');
  renderer._render();
  assert.doesNotMatch(list.innerHTML, /data-acceptance-marker/);
});

test('operation receipts remain between their delivery and the next conversation turn', () => {
  const { renderer, ctx, list, sandbox } = setupRender();
  sandbox.TaskTraceApproval = { html: () => '', bind() {} };
  ctx._pending = '';
  ctx._sessionOptions = {};
  const entry = { taskId: 'task', task: { title: 'Delivery' }, nativeTurn: true,
    trace: { approvals: [{ id: 'r1', action: 'review', status: 'rejected', createdAt: 25, myDecision:{decision:'reject'} }] } };
  ctx._collabEntries = () => [entry];
  ctx._snap = { status: 'idle', tools: [], messages: [
    { role: 'user', text: 'Execute', sentAt: 10 },
    { role: 'assistant', sentAt: 20, done: true, blocks: [{ kind: 'text', text: 'First delivery', done: true }] },
  ] };
  renderer._render();
  ctx._snap.messages.push({ role: 'user', text: 'Rework', sentAt: 30 },
    { role: 'assistant', sentAt: 40, done: true, blocks: [{ kind: 'text', text: 'Revised delivery', done: true }] });
  entry.trace.approvals.push({ id: 'r2', action: 'review', status: 'approved', createdAt: 45, myDecision:{decision:'approve'} });
  renderer._render();
  ctx._snap.messages.push({ role: 'user', text: 'Continue', sentAt: 50 });
  for (const reopen of [false, true]) {
    if (reopen) renderer.reset();
    renderer._render();
    const tokens = ['data-chat-node="message:1"', 'data-acceptance-operation="r1"',
      'data-chat-node="message:2"', 'data-chat-node="message:3"', 'data-acceptance-operation="r2"', 'data-chat-node="message:4"'];
    const positions = tokens.map(token => list.innerHTML.indexOf(token));
    assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1])), positions.join(','));
    assert.equal((list.innerHTML.match(/data-acceptance-operation=/g) || []).length, 2);
  }
});

test('same-person pending acceptance follows the native task delivery in the transcript', () => {
  const harness = setupRender();
  const { renderer, ctx, list, sandbox } = harness;
  sandbox.__teamCap = { meId: 'self' };
  sandbox.TaskTraceApproval = { html: () => '<section data-acceptance-marker="1"></section>', bind() {} };
  ctx._pending = '';
  ctx._sessionOptions = {};
  const entry = { taskId: 'task', task: { title: 'Delivery', createdBy: 'self' }, nativeTurn: true,
    trace: { approvals: [{ id: 'direct:task', action: 'review', status: 'pending', createdAt: 10 }] } };
  ctx._collabEntries = () => [entry];
  ctx._collabTasks.set(entry.taskId, entry);
  ctx._collabEntryStatus = () => 'completed';
  ctx._snap = { status: 'idle', tools: [], messages: [
    { role: 'user', text: 'Execute', sentAt: 5 },
    { role: 'assistant', taskId: 'task', taskOutputKey: 'task:result', sentAt: 20, done: true,
      blocks: [{ kind: 'text', text: 'Delivery output', done: true }] },
  ], execution: { running: false, harness: { phases: [] }, quality: {} } };
  renderer._render();
  const output = list.innerHTML.indexOf('Delivery output');
  const approval = list.innerHTML.indexOf('data-acceptance-marker="1"');
  assert.ok(output >= 0 && approval > output, `${output},${approval}`);
});

test('legacy projected delivery precedes its receipt and a pending follow-up', () => {
  const { renderer, ctx, list, sandbox } = setupRender();
  sandbox.TaskTraceApproval = { html: () => '', bind() {} };
  sandbox.TaskExecutionStream = { rowsHtml: () => '<p>Legacy delivery</p>' };
  const entry = { taskId: 'legacy', task: {},
    trace: { approvals: [{ id: 'legacy-review', action: 'review', status: 'approved', myDecision:{decision:'approve'} }] },
    controller: { snapshot: () => ({ status: 'completed', events: [{ kind: 'text' }] }) } };
  ctx._collabEntries = () => [entry];
  renderer._render();
  const delivery = list.innerHTML.indexOf('Legacy delivery');
  const receipt = list.innerHTML.indexOf('data-acceptance-operation="legacy-review"');
  const followUp = list.innerHTML.indexOf('data-chat-node="message:pending"');
  assert.ok(delivery >= 0 && receipt > delivery && followUp > receipt);
  ctx._pending = '';
  ctx._snap.messages = [{ role: 'user', text: 'Follow-up', sentAt: 50 }];
  renderer._render();
  const persisted = list.innerHTML.indexOf('data-chat-node="message:0"');
  assert.ok(list.innerHTML.indexOf('Legacy delivery') < list.innerHTML.indexOf('data-acceptance-operation="legacy-review"'));
  assert.ok(list.innerHTML.indexOf('data-acceptance-operation="legacy-review"') < persisted);
  assert.equal((list.innerHTML.match(/Legacy delivery/g) || []).length, 1);
});

test('acceptance session transcript never renders the original pending decision card', () => {
  const harness = setupRender();
  const { renderer, ctx, list, sandbox } = harness;
  ctx._sessionOptions = { acceptanceSession: true, taskRef: 'task-acceptance', approvalId: 'approval-1' };
  const entry = { taskId: 'task-acceptance', task: { title: '写荷花作文' }, trace: {
    approvals: [{ id: 'approval-1', action: 'review', status: 'pending' }],
  }};
  ctx._collabEntries = () => [entry];
  ctx._collabTasks.set(entry.taskId, entry);
  sandbox.TaskTraceApproval = { html() { return '<section data-acceptance-marker="1"></section>'; }, bind() {} };
  renderer._render();
  assert.doesNotMatch(list.innerHTML, /data-acceptance-marker/);
});

test('analysis result keeps the stale same-person acceptance card hidden after a marker refresh', () => {
  const harness = setupRender();
  const { renderer, ctx, list, sandbox } = harness;
  ctx._sessionOptions = { taskRef: 'task-acceptance' };
  ctx._activeCollabTaskId = 'task-acceptance';
  ctx._pending = '';
  ctx._snap = { status: 'idle', messages: [
    { role: 'user', text: '【验收分析】请核对本次交付成果' },
    { role: 'assistant', done: true, blocks: [{ kind: 'text', text: '【验收分析结果】\n建议结果：通过' }] },
  ], tools: [], execution: { running: false, harness: { phases: [] }, quality: {} } };
  const entry = { taskId: 'task-acceptance', task: { title: '写荷花作文' }, trace: {
    approvals: [{ id: 'direct:task-acceptance', action: 'review', status: 'pending' }],
  }};
  ctx._collabEntries = () => [entry];
  ctx._collabTasks.set(entry.taskId, entry);
  sandbox.TaskTraceApproval = {
    html() { return '<section data-acceptance-marker="1"></section>'; },
    bind() {},
  };
  renderer._render();
  assert.match(list.innerHTML, /nacceptance-result/);
  assert.doesNotMatch(list.innerHTML, /data-acceptance-marker/);
});

test('an older analysis result does not hide a new review card after a later rework turn', () => {
  const harness = setupRender();
  const { renderer, ctx, list, sandbox } = harness;
  ctx._sessionOptions = { taskRef: 'task-acceptance' };
  ctx._activeCollabTaskId = 'task-acceptance';
  ctx._pending = '';
  ctx._snap = { status: 'idle', messages: [
    { role: 'user', text: '【验收分析】上一轮核对' },
    { role: 'assistant', done: true, blocks: [{ kind: 'text', text: '【验收分析结果】\n建议结果：退回' }] },
    { role: 'user', text: '请按验收意见修改后重新提交' },
  ], tools: [], execution: { running: false, harness: { phases: [] }, quality: {} } };
  const entry = { taskId: 'task-acceptance', task: { title: '写荷花作文' }, trace: {
    approvals: [{ id: 'direct:task-acceptance', action: 'review', status: 'pending' }],
  }};
  ctx._collabEntries = () => [entry];
  ctx._collabTasks.set(entry.taskId, entry);
  sandbox.TaskTraceApproval = {
    html() { return '<section data-acceptance-marker="1"></section>'; },
    bind() {},
  };
  renderer._render();
  assert.match(list.innerHTML, /data-acceptance-marker/);
});

test('a task completed elsewhere hides the stale source acceptance card before trace refresh', () => {
  const harness = setupRender();
  const { renderer, ctx, list, sandbox } = harness;
  const entry = { taskId: 'task-remote-approval', task: { title: '远端验收任务', reviewedAt: '2026-10-18T23:00:00Z' },
    trace: { approvals: [{ id: 'approval-remote', action: 'review', status: 'pending' }] } };
  ctx._collabEntries = () => [entry];
  ctx._collabTasks.set(entry.taskId, entry);
  sandbox.TaskTraceApproval = { html() { return '<section data-acceptance-marker="1"></section>'; }, bind() {} };
  renderer._render();
  assert.doesNotMatch(list.innerHTML, /data-acceptance-marker/);
});

function setupRender({ earlyTool = false } = {}) {
  const list = {
    innerHTML: '', children: [], dataset: {},
    addEventListener() {},
    querySelectorAll() { return []; },
  };
  const el = {
    querySelector(selector) {
      if (selector === '#nchatScroll') return {};
      if (selector === '#nchatList') return list;
      return null;
    },
  };
  const sandbox = {
    console,
    window: null,
    ChatContextMeter: { create() { return { _ctxText() { return ''; }, _tokenText() { return ''; }, _ctxHtml() { return ''; } }; } },
    ChatScrollFollow: { create() { return {
      _releaseScrollFollow() {}, _ensureScrollFollow() { return { follow: true }; },
      _nearBottom() { return true; }, _followLatest() {}, _updateScrollButton() {},
      _preserveReadingPosition() { return () => {}; },
    }; } },
    ChatTools: {
      goalProgressRows() { return [{ progressIndex: 1, html: '<div data-chat-node="goal-progress:phase:understand" class="nprocess ngoal-phase"></div>' }]; },
      appendTimeline(parts, input, _previous, _anchor, _narrated, _itemHtml, _openGroups,
        rows, state) {
        /* An early tool event is the race that used to put goal progress above
           the optimistic prompt.  Consume one progress row here to model the
           real timeline helper before the pending user bubble is persisted. */
        if (earlyTool && input.length && state.index < rows.length) parts.push(rows[state.index++].html);
      },
      appendGoalProgress(parts, rows, state) { while (state.index < rows.length) parts.push(rows[state.index++].html); },
      patchList(host, html) { host.innerHTML = html; },
      paintSendButton() {},
    },
    WorkIntent: {
      userMessage(text, _goal, tail) { return '<div class="nmsg user"><div class="nbubble">' + escapeHtml(text) + '</div>' + tail + '</div>'; },
      showGoal() {},
      phaseView() { return { total: 5, current: 1, completed: 0, phase: { label: '理解目标' } }; },
    },
    document: { body: null, querySelector() { return null; }, addEventListener() {} },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(markdownSource, sandbox);
  vm.runInNewContext(rendererSource, sandbox);
  const ctx = {
    esc: escapeHtml, _ref: 'render-test', _snap: {
      status: 'streaming', messages: [], tools: earlyTool ? [{ id: 'early', state: 'running', after: 0 }] : [], usage: null, pendingUi: null,
      execution: { running: true, harness: { phases: [] }, quality: {} },
    },
    _liveTextKey: '', _openThink: new Set(), _openTool: new Set(), _hotToolBodies: new Set(),
    _openToolGroup: new Set(), _pending: '创建一个象棋小游戏', _pendingSentAt: Date.now(),
    _pendingAttachmentNames: [], _pendingPlugins: [], _sessionOptions: { intent: 'goal', mode: 'goal' },
    _messageWindowSize: 80, _messageAttachments: null, _outs: [], _goalActionPending: '',
    _mount() { return el; }, _turnMetricsHtml() { return '<div data-chat-node="turn-metrics"></div>'; },
    _thinkingStatusHtml() { return '<div data-chat-node="runtime-status"></div>'; },
    _syncThinkingClock() {}, _collabEntries() { return []; }, _collabTasks: new Map(),
    _collabEntryStatus() {}, _pendingIsConfirmed() { return false; }, _collabStarts: new Set(),
    _retryDraft: null, _renderQueue() {}, _goalAction() {}, _removeGoal() {}, _answerUi() {},
    _renderTaskStartPrompt() {}, _syncSlowStatusTicker() {},
  };
  sandbox.SoduWorkPluginIcon = require('../core/plugin-icon');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-message-plugins.js'), 'utf8'), sandbox);
  const renderer = sandbox.ChatMessageRenderer.create(ctx);
  return { renderer, ctx, list, sandbox };
}

function setupPickerRender(getTasksSnapshot) {
  const harness = setupRender();
  const { ctx, list, renderer, sandbox } = harness;
  const views = [];
  let transcript = '', transcriptWrites = 0;
  Object.defineProperty(list, 'innerHTML', {
    get() { return transcript; },
    set(value) { transcript = value; transcriptWrites++; },
  });
  sandbox.SoduWorkAPI = { getTasksSnapshot };
  vm.runInNewContext(taskControllerSource, sandbox);
  Object.assign(ctx, {
    _sessionId: 'streaming-conversation', _viewEpoch: 1,
    _collabPicker: { open: false, tasks: [] },
    _collabView: { render(state) {
      views.push({
        open: state.picker.open, loading: Boolean(state.picker.loading),
        tasks: Array.from(state.picker.tasks, task => task.id),
      });
    } },
    _render: renderer._render,
  });
  const controller = sandbox.ChatTaskController.create(ctx);
  ctx._collabState = controller._collabState;
  return { ...harness, controller, views, transcriptWrites: () => transcriptWrites };
}

test('passive local history renders every saved assistant answer across reopen and stream pages', async () => {
  const { create } = require('../main/conversation/local-history-view.cjs');
  for (const format of ['messages', 'events']) {
    const items = Array.from({ length: 5 }, (_, i) => [
      { id: 'u' + i, role: 'user', text: 'Saved question ' + i },
      ...(format === 'messages' && i > 0 ? [{ id: 'usage' + i, role: 'assistant', text: '', done: true }] : []),
      ...(format === 'events' ? [
        { id: 'a' + i, streamId: 's' + i, role: 'assistant', text: 'Saved ', delta: true },
        { id: 'b' + i, streamId: 's' + i, role: 'assistant', text: 'answer ' + i, delta: true },
      ] : [{ id: 'a' + i, role: 'assistant', text: 'Saved answer ' + i }]),
    ]).flat();
    for (let reopen = 0; reopen < 2; reopen++) {
      const view = await create({ row: { id: 'history' }, read: async (_id, { after }) => ({
        format, items: items.slice(after, after + 2), nextCursor: after + 2 < items.length ? after + 2 : null,
      }) });
      const { renderer, ctx, list } = setupRender();
      ctx._pending = ''; ctx._sessionOptions = {}; ctx._snap = view.snapshot();
      renderer._render();
      for (let i = 0; i < 5; i++) {
        assert.ok(list.innerHTML.includes('Saved question ' + i));
        assert.ok(list.innerHTML.includes('Saved answer ' + i));
      }
      assert.equal((list.innerHTML.match(/class="nmsg ai/g) || []).length, 5);
      assert.equal((await view.send('Do not execute')).accepted, false);
      await view.close();
    }
  }
});

test('new waiting, thinking and tool turns never stream a completed acceptance card', () => {
  for (const kind of ['验收分析结果','验收退回卡','验收确认卡']) {
    const {renderer,ctx,list}=setupRender();
    ctx._pending=''; ctx._sessionOptions={};
    const completed={role:'assistant',done:true,blocks:[{kind:'text',done:true,text:`【${kind}】\nSettled review`} ]};
    ctx._snap.messages=[{role:'user',text:'Review'},completed]; ctx._snap.status='idle';
    renderer._render(); assert.match(list.innerHTML,/nacceptance-result/);
    ctx._snap.status='streaming';
    for (const pending of ['', 'Next request']) {
      ctx._pending=pending; renderer._render();
      assert.equal(ctx._liveTextKey,''); assert.match(list.innerHTML,/nacceptance-result/);
    }
    ctx._pending=''; ctx._snap.messages.push({role:'user',text:'Next request',blocks:[{kind:'text',text:'Next request'}]});
    renderer._render(); assert.equal(ctx._liveTextKey,'');
    const next={role:'assistant',done:false,blocks:[]}; ctx._snap.messages.push(next);
    for (const block of [{kind:'thinking',text:'Thinking'}, {kind:'toolcall',id:'tool'},
      {kind:'text',text:'Finished pre-tool text',done:true}]) {
      next.blocks.push(block); renderer._render(); assert.equal(ctx._liveTextKey,'');
      assert.match(list.innerHTML,/nacceptance-result/); assert.doesNotMatch(list.innerHTML,/<details class="nacceptance-result/);
    }
    next.blocks.push({kind:'text',text:'New answer'}); renderer._render();
    assert.equal(ctx._liveTextKey,'3:3','legacy live text without a done flag still streams');
  }
});

test('expanding streaming history renders the requested window before resuming incremental patches', () => {
  const { renderer, ctx, list, sandbox } = setupRender();
  let writes = 0;
  sandbox.ChatTools.patchList = (host, html) => { host.innerHTML = html; writes++; };
  ctx._pending = '';
  ctx._sessionOptions = {};
  ctx._snap.messages = Array.from({ length: 220 }, (_, index) => ({ role: 'user', text: 'Historical request ' + index }));
  renderer._render();
  assert.equal((list.innerHTML.match(/data-chat-node="message:/g) || []).length, 80);
  ctx._messageWindowSize = 160;
  renderer._render();
  assert.equal((list.innerHTML.match(/data-chat-node="message:/g) || []).length, 160);
  assert.match(list.innerHTML, /Historical request 60</);
  const expandedWrites = writes;
  renderer._render();
  assert.equal(writes, expandedWrites, 'unchanged snapshots keep the expanded DOM instead of replacing it');
});

test('assistant rows expose their absolute history owner even when projected indices have gaps', () => {
  const { renderer, ctx, list } = setupRender();
  ctx._pending = '';
  ctx._snap.messages = [{ role: 'user', text: 'new work' },
    { role: 'assistant', done: false, blocks: [{ kind: 'thinking', text: 'Reading the skill', done: false }] }];
  ctx._snap.history = { messageStart: 100, messageIndices: [100, 105] };
  renderer._render();
  assert.match(list.innerHTML, /data-message-owner="105"[^>]*data-chat-node="message:1"/);
  ctx._snap.history = { messageStart: 200 };
  renderer.reset(); renderer._render();
  assert.match(list.innerHTML, /data-message-owner="201"[^>]*data-chat-node="message:1"/);
});

test('workflow controls have trusted message slots and reconcile after transcript rendering', () => {
  const { renderer, ctx, list, sandbox } = setupRender();
  const reconciled = [];
  sandbox.PluginDebugCard = { reconcile: value => reconciled.push(value) };
  ctx._pending = '';
  ctx._snap.messages = [{ role: 'user', text: 'work', taskOutputKey: 'run-1:start' },
    { role: 'assistant', taskOutputKey: 'plugin-debug:run-1:design:1:failed',
      blocks: [{ kind: 'text', text: 'Paused', done: true }], done: true },
    { role: 'user', text: 'continue' }];
  ctx._snap.history = { messageIndices: [100, 105, 107] };
  renderer._render();
  assert.match(list.innerHTML, /data-chat-node="message:0"[^>]*data-message-owner="100"/);
  assert.match(list.innerHTML, /data-workflow-message-key="run-1:start"/);
  assert.match(list.innerHTML, /data-workflow-message-key="plugin-debug:run-1:design:1:failed"/);
  assert.equal((list.innerHTML.match(/class="nworkflow-message-slot"/g) || []).length, 2);
  assert.match(list.innerHTML, /data-chat-node="workflow-history"[^>]*data-workflow-ref="render-test"/);
  assert.equal(reconciled.at(-1).snapshot, ctx._snap);
  assert.equal(reconciled.at(-1).list, list);
});

test('发送中与恢复历史消息的插件图标都位于正文下方并复用菜单图标', async () => {
  const {renderer,ctx,list,sandbox} = setupRender();
  const plugin = {pluginId:'builder',name:'插件开发助手',kind:'skill'};
  sandbox.SoduWorkAPI = {pluginCatalog:async()=>({items:[plugin]})};
  ctx._pendingPlugins = [{pluginId:plugin.pluginId,name:plugin.name}];
  renderer._render(); await new Promise(resolve=>setImmediate(resolve));
  const icon = sandbox.SoduWorkPluginIcon.markup(plugin);
  assert.ok(list.innerHTML.includes(icon));
  assert.ok(list.innerHTML.indexOf('nmessage-plugins') > list.innerHTML.indexOf('nbubble'));
  ctx._snap.messages = [{role:'user',text:ctx._pending,plugins:ctx._pendingPlugins,sentAt:ctx._pendingSentAt}];
  ctx._pending = ''; ctx._pendingPlugins = []; renderer.reset(); renderer._render();
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(list.innerHTML.includes(icon));
  assert.equal((list.innerHTML.match(/class="nmessage-plugin"/g)||[]).length, 1);
});

test('应用在每轮完成及失败后显示打开卡片，运行中不提前显示本轮卡片', async () => {
  const { renderer, ctx, list, sandbox } = setupRender();
  sandbox.localStorage = { getItem: () => null };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-apps.js'), 'utf8'), sandbox);
  const app = { pluginId: 'local:app', name: '应用卡片', personal: true,
    ui: { contributions: [{ slot: 'workspace.navigation' }] } };
  sandbox.SoduWorkAPI = { pluginCatalog: async () => ({ items: [app] }) };
  ctx._sessionOptions = {}; ctx._pending = ''; ctx._snap.execution = { running: false };
  ctx._snap.status = 'idle';
  ctx._snap.messages = [{ role: 'user', text: '/应用 查询', plugins: [app] },
    { role: 'assistant', blocks: [{ kind: 'text', text: '查询完成' }] }];
  renderer._render(); await new Promise(resolve => setImmediate(resolve)); renderer._render();
  assert.match(list.innerHTML, /data-chat-node="application:1"/);
  assert.ok(list.innerHTML.indexOf('查询完成') < list.innerHTML.indexOf('data-chat-open-app'));
  ctx._snap.status = 'streaming'; ctx._snap.execution.running = true; renderer._render();
  assert.doesNotMatch(list.innerHTML, /data-chat-open-app/);
  ctx._snap.status = 'unreachable'; ctx._snap.execution.running = false;
  ctx._snap.messages = []; ctx._retryDraft = { plugins: [app], text: '请使用应用' };
  renderer._render();
  assert.match(list.innerHTML, /data-chat-node="application:failed"/);
  assert.match(list.innerHTML, /data-chat-open-app="local:app"/);
});

test('late Markdown dependencies invalidate the plain fallback cache', () => {
  const { sandbox, renderer } = setup();
  const source = '# Title\n\n**bold**\n\n- item';
  const fallback = renderer._blockHtml(0, { kind: 'text', text: source }, 0);
  assert.match(body(fallback), /nline/);
  vm.runInNewContext(markedSource, sandbox);
  sandbox.DOMPurify = { sanitize: (html) => html };
  const formatted = renderer._blockHtml(0, { kind: 'text', text: source }, 0);
  assert.match(body(formatted), /class="nmd"/);
  assert.doesNotMatch(body(formatted), /# Title|\*\*bold\*\*/);
});

test('streaming assistant output uses the same Markdown renderer without reparsing every token', () => {
  const { sandbox, ctx, renderer } = setup();
  vm.runInNewContext(markedSource, sandbox);
  sandbox.DOMPurify = { sanitize: (html) => html };
  ctx._snap = { status: 'streaming' };
  ctx._liveTextKey = '0:0';
  const html = renderer._blockHtml(0, { kind: 'text', text: '## Title\n\n**bold**' }, 0);
  assert.match(body(html), /class="nmd"/);
  assert.doesNotMatch(body(html), /## Title|\*\*bold\*\*/);
});

test('streaming text patches preserve the hit target instead of replacing its subtree', () => {
  assert.match(markdownSource, /function _patchStreamNode\(current, next\)/);
  assert.match(rendererSource, /const next = text\.cloneNode\(false\);[\s\S]*?_patchStreamNode\(text, next\);/);
  assert.doesNotMatch(rendererSource, /text\.replaceChildren\(holder\.content\)/);
});

test('desktop loads Markdown dependencies before the chat renderer', () => {
  const html = fs.readFileSync(path.join(__dirname, '../desk.html'), 'utf8');
  const rendererAt = html.indexOf('components/panels/chat-message-renderer.js');
  const markedAt = html.indexOf('vendor/markdown/marked.umd.js');
  const purifierAt = html.indexOf('vendor/markdown/purify.min.js');
  const markdownAt = html.indexOf('components/panels/chat-markdown.js');
  assert.ok(markedAt >= 0 && purifierAt >= 0 && rendererAt > markedAt && rendererAt > purifierAt);
  assert.ok(markdownAt > purifierAt && markdownAt < rendererAt);
});

test('closing a conversation releases its rendered Markdown cache', () => {
  const { sandbox, renderer } = setup(); let parses = 0;
  sandbox.marked = { parse: source => { parses++; return '<p>' + source + '</p>'; } };
  sandbox.DOMPurify = { sanitize: value => value };
  renderer.rich('retained response'); renderer.rich('retained response');
  assert.equal(parses, 1);
  renderer.reset(); renderer.rich('retained response');
  assert.equal(parses, 2, 'reset must release cache even when reopening the same session');
  renderer.reset(); renderer.reset();
});

test('goal send renders its optimistic user message before first progress output', () => {
  const { renderer, list } = setupRender();
  renderer._render();
  const user = list.innerHTML.indexOf('class="nmsg user"');
  const progress = list.innerHTML.indexOf('goal-progress:phase:understand');
  const status = list.innerHTML.indexOf('runtime-status');
  assert.ok(user >= 0, 'optimistic user bubble should be rendered');
  assert.ok(progress >= 0, 'goal progress should be rendered');
  assert.ok(status >= 0, 'processing status should be rendered');
  assert.ok(user < progress, 'goal progress must follow the sent prompt');
  assert.ok(user < status, 'processing status must follow the sent prompt');
});

test('goal send keeps the prompt ahead of progress when a tool arrives first', () => {
  const { renderer, list } = setupRender({ earlyTool: true });
  renderer._render();
  const user = list.innerHTML.indexOf('class="nmsg user"');
  const progress = list.innerHTML.indexOf('goal-progress:phase:understand');
  assert.ok(user >= 0 && progress >= 0, 'optimistic prompt and progress should both render');
  assert.ok(user < progress, 'an early tool must not move goal progress above the prompt');
});

test('a newly echoed prompt consumes its optimistic copy when the echo timestamp is older', () => {
  const { renderer, ctx, list } = setupRender();
  const sentAt = Date.now();
  ctx._pending = 'same request';
  ctx._pendingSentAt = sentAt;
  ctx._pendingBaseline = { messageCount: 1, userCount: 1, historyTotal: 1 };
  ctx._snap = {
    status: 'streaming',
    messages: [
      { role: 'user', text: 'previous request', sentAt: sentAt - 2000 },
      { role: 'user', text: 'same request', sentAt: sentAt - 500 },
    ],
    history: { totalMessages: 2, messageIndices: [0, 1] },
    tools: [], usage: null, pendingUi: null,
    execution: { running: true, harness: { phases: [] }, quality: {} },
  };
  renderer._render();
  assert.equal((list.innerHTML.match(/class="nmsg user"/g) || []).length, 2,
    'the persisted prompt and the prior identical prompt should remain, without a third optimistic copy');
});

test('an older identical prompt does not consume the current optimistic copy', () => {
  const { renderer, ctx, list } = setupRender();
  const sentAt = Date.now();
  ctx._pending = 'same request';
  ctx._pendingSentAt = sentAt;
  ctx._pendingBaseline = { messageCount: 1, userCount: 1, historyTotal: 1 };
  ctx._snap = {
    status: 'streaming',
    messages: [{ role: 'user', text: 'same request', sentAt: sentAt - 5000 }],
    history: { totalMessages: 1, messageIndices: [0] },
    tools: [], usage: null, pendingUi: null,
    execution: { running: true, harness: { phases: [] }, quality: {} },
  };
  renderer._render();
  assert.equal((list.innerHTML.match(/class="nmsg user"/g) || []).length, 2,
    'an older identical prompt must stay separate from the current optimistic prompt');
});

test('a submission identity consumes an optimistic copy when the echoed text and time changed', () => {
  const { renderer, ctx, list } = setupRender();
  ctx._pending = 'original request';
  ctx._pendingSentAt = Date.now();
  ctx._pendingBaseline = { messageCount: 1, historyTotal: 1, submissionId: 'ui-echo-1' };
  ctx._snap = {
    status: 'streaming',
    messages: [{ role: 'user', text: 'rewritten request', sentAt: ctx._pendingSentAt - 3000,
      submissionId: 'ui-echo-1' }],
    history: { totalMessages: 2, messageIndices: [0] },
    tools: [], usage: null, pendingUi: null,
    execution: { running: true, harness: { phases: [] }, quality: {} },
  };
  renderer._render();
  assert.equal((list.innerHTML.match(/class="nmsg user"/g) || []).length, 1,
    'the stable submission identity must remove the optimistic duplicate');
});

for (const hasSnapshot of [true, false]) {
  test('requirement picker renders loading, results and close ' +
    (hasSnapshot ? 'during an unchanged live stream' : 'before the first snapshot'), async () => {
    let resolveTasks;
    const { ctx, renderer, controller, views, transcriptWrites } = setupPickerRender(
      () => new Promise(resolve => { resolveTasks = resolve; }));
    if (!hasSnapshot) ctx._snap = null;
    renderer._render();
    assert.deepEqual(views.at(-1), { open: false, loading: false, tasks: [] });
    const baseline = transcriptWrites();

    const pending = controller._openTaskPicker();
    assert.deepEqual(views.at(-1), { open: true, loading: true, tasks: [] });
    if (hasSnapshot) ctx._snap.usage = { input: 123, output: 456 };
    renderer._render();
    assert.deepEqual(views.at(-1), { open: true, loading: true, tasks: [] });

    resolveTasks({ online: true, items: [{ id: 'requirement-a', title: 'A', status: 'todo' }] });
    await pending;
    assert.deepEqual(views.at(-1), { open: true, loading: false, tasks: ['requirement-a'] });
    controller._collabAction('picker-close');
    assert.deepEqual(views.at(-1), { open: false, loading: false, tasks: [] });
    assert.equal(transcriptWrites(), baseline,
      'picker state changes must not require a full transcript render');
    assert.equal(baseline, hasSnapshot ? 1 : 0);
  });
}

for (const fileRead of [false, true]) test('streaming ' + (fileRead ? 'file reads' : 'commands') + ' leave row DOM intact without reading output', () => {
  const { ctx, renderer, sandbox, list } = setupRender();
  const toolScope = { ChatDomPatch: require('../components/panels/chat-dom-patch') };
  toolScope.window = toolScope;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-chat-tools.js'), 'utf8'), toolScope);
  const tools = toolScope.ChatTools;
  Object.assign(sandbox.ChatTools, { kind: tools.kind, isCommandTool: tools.isCommandTool, render: tools.render });
  let renders = 0;
  sandbox.ChatTools.appendTimeline = (parts, input, _previous, _anchor, _narrated, itemHtml) => {
    renders++; parts.push(...input.map(itemHtml));
  };
  const command = { id: 'live-command', name: fileRead ? 'read' : 'bash', state: 'running', after: 0,
    args: fileRead ? { path: 'notes.md' } : { command: 'npm test' } };
  for (const key of ['partial', 'result']) Object.defineProperty(command, key, {
    get() { throw Error('Streaming summary must not read ' + key); },
  });
  ctx._pending = ''; ctx._sessionOptions = {}; ctx._snap.tools = [command];
  renderer._render();
  assert.match(list.innerHTML, fileRead ? /data-tool-side="1"/ : /正在运行命令/);
  if (!fileRead) assert.doesNotMatch(list.innerHTML, /ntool-body|ntool-caret|npm test|data-tool="live-command"/);
  const before = renders;
  ctx._snap.usage = { input: 10, output: 20 };
  renderer._render();
  assert.equal(renders, before, 'missing command bodies must not trigger a full transcript rerender');
  command.state = 'done'; renderer._render();
  assert.ok(renders > before, 'the completed title must still update at settlement');
  if (fileRead) assert.match(list.innerHTML, /读取/);
  else { assert.match(list.innerHTML, /运行了命令/); assert.doesNotMatch(list.innerHTML, /ntool-body|ntool-caret|npm test|data-tool="live-command"/); }
});


test('workflow nodes share one turn stack with actual Agent labels, including tool-first nodes', () => {
  const {renderer,ctx,list,sandbox} = setupRender();
  sandbox.AgentBrand = require('../components/panels/agent-brand');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-crew.js'), 'utf8'), sandbox);
  sandbox.ChatTools.appendTimeline = (parts,input) => { for(const tool of input) parts.push('<div class="nmsg ai"><span>'+escapeHtml(tool.id)+'</span></div>'); };
  const pi={agentId:'pi',runId:'r1',nodeKey:'first'}, qwen={agentId:'qwen',runId:'r1',nodeKey:'second'};
  ctx._pending='';ctx._sessionOptions={};ctx._snap={status:'idle',messages:[
    {role:'user',text:'run'},
    {role:'assistant',sourceAgent:pi,blocks:[{kind:'text',text:'First result'}],done:true},
    {role:'assistant',sourceAgent:pi,blocks:[{kind:'text',text:'More of first'}],done:true},
    {role:'assistant',sourceAgent:qwen,blocks:[{kind:'text',text:'Second result'}],done:true},
    {role:'assistant',blocks:[{kind:'text',text:'Ordinary historical reply'}],done:true},
  ],tools:[{id:'qwen-tool-start',name:'read',state:'done',after:2,sourceAgent:qwen}]};
  renderer._render();
  assert.equal((list.innerHTML.match(/class="nchat-agent-source/g)||[]).length,1);
  assert.match(list.innerHTML,/data-output-agent="pi"/);assert.match(list.innerHTML,/agent-brand-qwen crew-sub/);
  assert.ok(list.innerHTML.indexOf('data-output-agent="pi"')<list.innerHTML.indexOf('First result'));
  assert.ok(list.innerHTML.indexOf('agent-brand-qwen crew-sub')<list.innerHTML.indexOf('<span>qwen-tool-start'));
  assert.ok(list.innerHTML.includes('aria-label="Qwen Code"'));
  assert.ok(list.innerHTML.includes('>QW</span>'));
  assert.match(list.innerHTML,/class="ntext"/);
  assert.match(list.innerHTML,/与 Qwen Code协作/);
});

test('one turn aggregates different runs and tool-only collaborators without leaking into the next turn', () => {
  const { renderer, ctx, list, sandbox } = setupRender();
  sandbox.AgentBrand = require('../components/panels/agent-brand');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-crew.js'), 'utf8'), sandbox);
  ctx._pending = ''; ctx._sessionOptions = {};
  ctx._snap = { status: 'idle', messages: [
    { role: 'user', text: 'First request' },
    { role: 'assistant', sourceAgent: { agentId: 'pi', runId: 'first' }, blocks: [{ kind: 'thinking', text: 'Reasoning', done: true }, { kind: 'text', text: 'Initial explanation' }], done: true },
    { role: 'assistant', sourceAgent: { agentId: 'qwen', runId: 'second' }, blocks: [{ kind: 'text', text: 'Final answer' }], done: true },
    { role: 'user', text: 'Second request' },
    { role: 'assistant', sourceAgent: { agentId: 'pi' }, blocks: [{ kind: 'text', text: 'Next answer' }], done: true },
  ], tools: [{ id: 'read', name: 'read', after: 1, state: 'done', sourceAgent: { agentId: 'claude' } }] };
  renderer._render();
  assert.equal((list.innerHTML.match(/class="nchat-agent-source/g) || []).length, 2);
  assert.match(list.innerHTML, /agent-brand-qwen crew-sub/);
  assert.match(list.innerHTML, /agent-brand-claude crew-sub/);
  assert.equal((list.innerHTML.match(/Initial explanation/g) || []).length, 1);
  assert.ok(list.innerHTML.indexOf('Initial explanation') < list.innerHTML.indexOf('Final answer'));
  assert.doesNotMatch(list.innerHTML.slice(list.innerHTML.indexOf('Second request')), /crew-sub/);
});

test('an ordinary preface retains the single task run detail link in the shared stack', () => {
  const { renderer, ctx, list, sandbox } = setupRender();
  sandbox.AgentBrand = require('../components/panels/agent-brand');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-crew.js'), 'utf8'), sandbox);
  ctx._pending = ''; ctx._sessionOptions = {};
  ctx._snap = { status: 'idle', messages: [
    { role: 'user', text: 'Work' },
    { role: 'assistant', sourceAgent: { agentId: 'pi' }, blocks: [{ kind: 'text', text: 'Starting' }], done: true },
    { role: 'assistant', sourceAgent: { agentId: 'qwen', runId: 'plugin-run' }, taskId: 'task-1', blocks: [{ kind: 'text', text: 'Done' }], done: true },
  ], tools: [] };
  renderer._render();
  assert.equal((list.innerHTML.match(/class="nchat-agent-source/g) || []).length, 1);
  assert.match(list.innerHTML, /data-output-agent="pi"/);
  assert.match(list.innerHTML, /data-crew-run="plugin-run"/);
  assert.match(list.innerHTML, /data-crew-task="task-1"/);
});

test('a retained running tool from windowed history keeps its own turn identity', () => {
  const { renderer, ctx, list, sandbox } = setupRender();
  sandbox.AgentBrand = require('../components/panels/agent-brand');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-crew.js'), 'utf8'), sandbox);
  sandbox.ChatTools.appendTimeline = (parts, input) => input.forEach(tool => parts.push('<div>' + tool.id + '</div>'));
  ctx._pending = ''; ctx._sessionOptions = {};
  ctx._snap = { status: 'streaming', messages: [
    { role: 'user', text: 'Old turn' },
    { role: 'assistant', sourceAgent: { agentId: 'pi' }, blocks: [{ kind: 'text', text: 'Old response' }], done: true },
    { role: 'user', text: 'New turn' },
    ...Array.from({ length: 81 }, (_, index) => ({ role: 'assistant', sourceAgent: { agentId: 'qwen' }, blocks: [{ kind: 'text', text: 'New response ' + index }], done: true })),
  ], tools: [{ id: 'older-running-tool', name: 'read', after: 1, state: 'running', sourceAgent: { agentId: 'pi' } }] };
  renderer._render();
  assert.equal((list.innerHTML.match(/class="nchat-agent-source/g) || []).length, 2);
  assert.ok(list.innerHTML.indexOf('data-output-agent="pi"') < list.innerHTML.indexOf('<div>older-running-tool'));
  assert.ok(list.innerHTML.indexOf('<div>older-running-tool') < list.innerHTML.indexOf('data-output-agent="qwen"'));
  assert.doesNotMatch(list.innerHTML, /crew-sub/);
});

test('an untrusted or absent Agent never inherits the current selection label', () => {
  const {renderer,ctx,list,sandbox}=setupRender();sandbox.AgentBrand=require('../components/panels/agent-brand');
  ctx._pending='';ctx._sessionOptions={adapterId:'pi'};ctx._snap={status:'idle',messages:[
    {role:'assistant',sourceAgent:{agentId:'<img onerror=x>'},blocks:[{kind:'text',text:'legacy'}],done:true}
  ],tools:[]};renderer._render();assert.doesNotMatch(list.innerHTML,/nchat-agent-source|onerror/);
});

for (const withUser of [true, false]) test('ordinary Agent attribution precedes processing time, withUser=' + withUser, () => {
  const {renderer,ctx,list,sandbox}=setupRender();sandbox.AgentBrand=require('../components/panels/agent-brand');
  ctx._pending='';ctx._sessionOptions={adapterId:'qwen'};
  ctx._snap={status:'idle',messages:[...(withUser?[{role:'user',text:'hello'}]:[]),
    {role:'assistant',sourceAgent:{agentId:'pi'},blocks:[{kind:'text',text:'First paragraph'}],done:true},
    {role:'assistant',sourceAgent:{agentId:'pi'},blocks:[{kind:'text',text:'Second paragraph'}],done:true},
  ],tools:[]};renderer._render();
  assert.equal((list.innerHTML.match(/class="nchat-agent-source"/g)||[]).length,1);
  assert.ok(list.innerHTML.indexOf('data-output-agent="pi"')<list.innerHTML.indexOf('data-chat-node="turn-summary:'));
  assert.ok(list.innerHTML.indexOf('data-chat-node="turn-summary:')<list.innerHTML.indexOf('First paragraph'));
  assert.doesNotMatch(list.innerHTML,/data-output-agent="qwen"/);
});

test('reopened latest completed turn uses persisted timing instead of a reset runtime clock', () => {
  const { renderer, ctx, list } = setupRender();
  ctx._pending = ''; ctx._sessionOptions = {};
  ctx._turnMetricsHtml = () => '<div><b data-thinking-elapsed>0s</b><b data-thinking-tokens>51</b></div>';
  ctx._snap = { status: 'idle', execution: { running: false, elapsedMs: 0 }, tools: [],
    messages: [{ role: 'user', text: 'Saved request', sentAt: 1000 },
      { role: 'assistant', done: true, completedAt: 24000, blocks: [{ kind: 'text', text: 'Saved answer' }] }],
    turnMetrics: [{ fromMessage: 0, toMessage: 1, tokens: 124, elapsedMs: 23000 }] };
  renderer._render();
  assert.match(list.innerHTML, /用时 23s/);
  assert.doesNotMatch(list.innerHTML, /tokens/);
  assert.doesNotMatch(list.innerHTML, /data-thinking-elapsed>0s/);
  ctx._snap.execution.elapsedMs = 3000;
  ctx._turnMetricsHtml = () => '<div><b data-thinking-elapsed>3s</b><b data-thinking-tokens>51</b></div>';
  renderer._render();
  assert.match(list.innerHTML, /data-thinking-elapsed>23s/);
  assert.doesNotMatch(list.innerHTML, /data-thinking-tokens/);
  ctx._snap.execution.elapsedMs = 303000;
  ctx._turnMetricsHtml = () => '<div><b data-thinking-elapsed>5m 03s</b></div>';
  renderer._render();
  assert.match(list.innerHTML, /data-thinking-elapsed>23s/);
  assert.doesNotMatch(list.innerHTML, /5m 03s/);
});

test('consecutive ordinary turns keep their original Agent after a switch', () => {
  const {renderer,ctx,list,sandbox}=setupRender();sandbox.AgentBrand=require('../components/panels/agent-brand');
  ctx._pending='';ctx._sessionOptions={adapterId:'opencode'};
  ctx._snap={status:'idle',messages:[
    {role:'user',text:'first'},
    {role:'assistant',sourceAgent:{agentId:'pi'},blocks:[{kind:'text',text:'Pi answer'}],done:true},
    {role:'user',text:'second'},
    {role:'assistant',sourceAgent:{agentId:'qwen'},blocks:[{kind:'text',text:'Qwen answer'}],done:true},
  ],tools:[]};renderer._render();
  assert.equal((list.innerHTML.match(/class="nchat-agent-source"/g)||[]).length,2);
  assert.ok(list.innerHTML.indexOf('data-output-agent="pi"')<list.innerHTML.indexOf('Pi answer'));
  assert.ok(list.innerHTML.indexOf('data-output-agent="qwen"')<list.innerHTML.lastIndexOf('data-chat-node="turn-summary:'));
  assert.doesNotMatch(list.innerHTML,/data-output-agent="opencode"/);
});

test('an older running collaborator updates its turn stack when it settles beyond the recent tool window', () => {
  const { renderer, ctx, list, sandbox } = setupRender();
  sandbox.AgentBrand = require('../components/panels/agent-brand');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-crew.js'), 'utf8'), sandbox);
  let writes = 0;
  sandbox.ChatTools.patchList = (host, html) => { host.innerHTML = html; writes++; };
  ctx._pending = ''; ctx._sessionOptions = {};
  ctx._snap = { status: 'streaming', messages: [
    { role: 'user', text: 'Run the tool batch' },
    { role: 'assistant', sourceAgent: { agentId: 'pi' }, blocks: [], done: true },
  ], tools: Array.from({ length: 43 }, (_, index) => ({
    id: 'tool-' + index, name: 'read', after: 1,
    state: index === 1 ? 'running' : 'done', sourceAgent: { agentId: index === 1 ? 'qwen' : 'pi' },
  })) };
  const collaborator = ctx._snap.tools[1];
  for (const field of ['partial', 'result']) Object.defineProperty(collaborator, field, {
    get() { throw Error('Turn identity must not read the tool ' + field); },
  });
  renderer._render();
  assert.match(list.innerHTML, /agent-brand-qwen crew-sub is-on/);
  const firstWrites = writes;
  ctx._snap.usage = { input: 10, output: 20 };
  renderer._render();
  assert.equal(writes, firstWrites, 'unchanged running tools retain the streaming fast path');

  collaborator.state = 'done';
  renderer._render();
  assert.doesNotMatch(list.innerHTML, /agent-brand-qwen crew-sub is-on/);
  assert.match(list.innerHTML, /agent-brand-qwen crew-sub/);
  assert.equal((list.innerHTML.match(/class="nchat-agent-source/g) || []).length, 1);
  assert.equal(writes, firstWrites + 1, 'settlement must refresh the crew even outside the last 40 tools');
  renderer._render();
  assert.equal(writes, firstWrites + 1, 'the unchanged settled snapshot resumes incremental rendering');
});


test('quota guidance never renders a red conversation error while genuine failures remain visible', () => {
  const { renderer, ctx, list, sandbox } = setupRender();
  sandbox.SoduWorkQuota = require('../core/token-quota');
  ctx._pending = ''; ctx._sessionOptions = {};
  ctx._snap = { status: 'unreachable', statusText: 'Allowance reached', code: 'TOKEN_QUOTA_EXCEEDED',
    quota: { enabled: true, exceeded: true, reason: 'model_exhausted' }, tools: [],
    messages: [{ role: 'user', text: 'Saved request' }, { role: 'assistant', done: true, blocks: [{ kind: 'text', text: 'Saved answer' }] }] };
  renderer._render();
  assert.doesNotMatch(list.innerHTML, /class="nbad show"/);
  assert.match(list.innerHTML, /Saved answer/);
  ctx._snap = { ...ctx._snap, code: '', quota: null, statusText: 'Provider authentication failed' };
  renderer._render();
  assert.match(list.innerHTML, /class="nbad show"/);
  assert.match(list.innerHTML, /Provider authentication failed/);
});

test('historical open failures offer session reopen instead of a dead model retry', () => {
  const { renderer, ctx, list } = setupRender();
  ctx._ref = '';
  ctx._sessionId = 'history-session';
  ctx._pending = '';
  ctx._snap = { status: 'unreachable', statusText: '打不开对话（当前账号或设备无权在此会话中执行这项需求）',
    sessionOpenCode: 'TASK_ACCESS_DENIED', messages: [], tools: [],
    execution: { running: false, modelRecovery: { id: 'stale-model-retry', available: true } } };
  renderer._render();
  assert.match(list.innerHTML, /data-session-retry/);
  assert.doesNotMatch(list.innerHTML, /data-model-retry/);
});

test('work-card access failures keep the historical session reopen action', () => {
  const { renderer, ctx, list } = setupRender();
  ctx._ref = '';
  ctx._sessionId = 'history-work-card';
  ctx._snap = { status: 'unreachable', openBlocked: true,
    statusText: '打不开对话（当前账号或设备无权在此会话中执行这项需求）', messages: [], tools: [] };
  renderer._render();
  assert.match(list.innerHTML, /data-session-retry/);
  assert.doesNotMatch(list.innerHTML, /data-plugin-retry/);
});

test('permanent plugin capability denials offer a new chat handoff instead of same-session resume', () => {
  const { renderer, ctx, list } = setupRender();
  ctx._pending = '';
  ctx._snap = { status: 'unreachable', statusText: 'stale authorization', tools: [], messages: [] };
  ctx._retryDraft = { text: 'Use the selected plugin', files: [], plugins: [{ pluginId: 'browser-work' }] };
  ctx._pluginAuthorization = { missing: ['browser'] };
  renderer._render();
  assert.match(list.innerHTML, /data-plugin-new-session/);
  assert.doesNotMatch(list.innerHTML, /data-plugin-retry/);
  assert.match(list.innerHTML, /浏览网页/);
});

test('runtime error rows localize native persisted notices without authorization metadata', () => {
  const {renderer,ctx,list,sandbox} = setupRender();
  const source = '当前会话没有授权：浏览网页。请新建会话并开启对应能力后再使用这个插件';
  let received;
  sandbox.ChatStatus = {notice:value => {received=value;return 'This chat requires browser access';}};
  ctx._pending = '';
  ctx._snap = {status:'unreachable',statusText:source,tools:[],messages:[]};
  renderer._render();
  assert.equal(received, source);
  assert.match(list.innerHTML, /This chat requires browser access/);
  assert.doesNotMatch(list.innerHTML, />当前会话没有授权/);
  assert.match(list.innerHTML, /data-runtime-notice="当前会话没有授权/);
  assert.equal(ctx._snap.statusText, source, 'locale changes must not rewrite persisted run diagnostics');
});

test('permanent plugin denials never render a generic resume action', () => {
  const { renderer, ctx, list } = setupRender();
  ctx._pending = '';
  ctx._snap = { status: 'unreachable', statusText: 'read-only authorization', tools: [], messages: [] };
  ctx._retryDraft = { text: 'Use the selected plugin', files: [], plugins: [{ pluginId: 'office-work' }] };
  ctx._pluginAuthorization = { readOnlyConflicts: ['office'] };
  renderer._render();
  assert.doesNotMatch(list.innerHTML, /data-plugin-retry|data-plugin-new-session/);
});
