'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element() {
  return {
    nodes: new Map(), attributes: new Map(), events: new Map(), dataset: {}, style: {},
    innerHTML: '', textContent: '', value: '', hidden: false, disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(key, value) { this.attributes.set(key, String(value)); },
    getAttribute(key) { return this.attributes.get(key); },
    removeAttribute(key) { this.attributes.delete(key); },
    querySelector(selector) {
      if (!this.nodes.has(selector)) this.nodes.set(selector, element());
      return this.nodes.get(selector);
    },
    querySelectorAll() { return []; },
    addEventListener(type, callback, options) {
      const entries = this.events.get(type) || [];
      entries.push({ callback, signal: options?.signal }); this.events.set(type, entries);
    },
    before() {}, appendChild() {}, insertAdjacentHTML() {},
  };
}

function fixture(t, status = 'done', restored) {
  const root = element(), document = element(), window = element();
  document.createElement = element;
  document.getElementById = id => root.querySelector('#' + id);
  window.window = window; window.document = document; window.AbortController = AbortController;
  const task = { id: 'bound-task', status, requirementStage: 'reviewing',
    executionContext: { agent: { id: 'runner:device:pi' } }, workRouting: {
      conversationTurn: { conversationId: 'public-chat', executor: 'dispatch', state: 'completed' },
      reworkPending: { feedback: 'Revise the original deliverable' },
    } };
  const snapshot = restored || { adapterId: 'pi', displayName: 'Pi', status: 'idle',
    accessControl: {}, accessPolicy: { mode: 'readonly' },
    messages: [{ role: 'assistant', text: 'Original answer', sourceAgent: { agentId: 'pi' } }],
    execution: { taskExecutions: [{ taskId: task.id, executor: 'dispatch', status: 'completed',
      run: { engine: 'pi' } }], turnQueue: { activeTaskId: '' } } };
  const ctx = {
    _ref: 'same-ref', _sessionId: 'public-chat', _viewEpoch: 1,
    _sessionOptions: { adapterId: snapshot.adapterId, displayName: snapshot.displayName },
    _mode: 'readonly', _model: null, _snap: snapshot,
    _activeCollabTaskId: task.id, _collabTasks: new Map([[task.id, { task }]]),
    _runtimeBusy() { return this._snap.status === 'streaming'; },
    _render() { this._composerControls?.render(); },
    _paintBar() { this._composerControls?.render(); },
    _renderQueue() {}, _rememberConversationDraft() {},
  };
  let options;
  const sandbox = vm.createContext(window);
  for (const name of ['core/requirement-session-context.js', 'components/panels/agent-brand.js',
    'components/panels/work-composer.js', 'components/panels/chat-session-controls.js',
    'components/panels/chat-composer-bindings.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), sandbox, { filename: name });
  }
  // Exercise production state projection, selection callbacks, and badge rendering.
  // Native picker click handling and parsed DOM are covered by the Electron suite.
  window.ChatComposerControls = { create(host, value) {
    options = value; return window.ChatSessionControls.create(host, value);
  } };
  window.ChatComposerBindings.create(ctx)._bind(root);
  t.after(() => ctx._composerControls.destroy());
  return { ctx, task, root, window,
    state: () => options.state(),
    select(id) {
      const displayName = window.AgentBrand.LABELS[id];
      options.runtimeSelected({ ok: true, adapterId: id, displayName,
        snapshot: { ...ctx._snap, adapterId: id, displayName } });
    },
    assertBadge(id) {
      assert.equal(root.querySelector('#nchatRuntimeName').textContent, window.AgentBrand.LABELS[id]);
      assert.equal(root.querySelector('#nchatRuntimeIcon').innerHTML,
        window.AgentBrand.html(id, { className: 'runtime-brand' }));
      assert.ok(root.querySelector('#nchatRuntimeIcon').innerHTML.includes('class="agent-monogram"'));
      assert.ok(root.querySelector('#nchatRuntimeIcon').innerHTML.includes('>' + window.AgentBrand.MONOGRAMS[id] + '</span>'));
    },
  };
}

for (const status of ['done', 'cancel']) {
  test(status + ': completed task receipts cannot override successful repeated runtime selections', t => {
    const f = fixture(t, status);
    const preserved = JSON.stringify({ task: f.task, messages: f.ctx._snap.messages,
      execution: f.ctx._snap.execution });
    f.root.querySelector('#nchatInput').value = 'Keep this unsent draft';
    for (const id of ['harness2', 'qwen', 'pi', 'harness2']) {
      f.select(id); f.assertBadge(id);
      assert.equal(f.state().adapterId, id);
      assert.equal(f.state().taskRuntime, '');
      assert.equal(f.ctx._sessionOptions.adapterId, id);
      assert.equal(f.root.querySelector('#nchatInput').value, 'Keep this unsent draft');
      assert.equal(f.ctx._ref, 'same-ref');
      assert.equal(JSON.stringify({ task: f.task, messages: f.ctx._snap.messages,
        execution: f.ctx._snap.execution }), preserved);
    }
    f.ctx._snap.status = 'streaming'; f.ctx._composerControls.render(); f.assertBadge('harness2');
    assert.equal(f.state().busy, true, 'ordinary streaming does not revive a finished task runtime');
    const reopened = fixture(t, status, JSON.parse(JSON.stringify(f.ctx._snap)));
    reopened.assertBadge('harness2');
    assert.equal(reopened.state().taskRuntime, '');
    assert.equal(reopened.ctx._snap.messages[0].sourceAgent.agentId, 'pi');
  });
}

test('unfinished controlled review and rework keep their original dispatch identity while idle or running', t => {
  const f = fixture(t, 'doing');
  f.ctx._snap.adapterId = 'harness2'; f.ctx._snap.displayName = 'Google Harness\u00b2';
  f.ctx._composerControls.render(); f.assertBadge('pi');
  assert.equal(f.state().taskRuntime, 'pi');
  f.ctx._snap.execution.taskExecutions[0].run.engine = 'qwen';
  for (const status of ['idle', 'streaming']) {
    f.ctx._snap.status = status; f.ctx._composerControls.render(); f.assertBadge('qwen');
    assert.equal(f.state().adapterId, 'harness2');
    assert.equal(f.state().taskRuntime, 'qwen');
  }
});
