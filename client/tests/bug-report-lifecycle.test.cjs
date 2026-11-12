'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { supervise } = require('../main/runner-process-lifecycle.cjs');
const recovery = require('../main/pi-session/model-recovery');
const plugins = require('../main/pi-session/plugin-context');
const mention = require('../components/panels/chat-plugin-mention-model');

test('Runner shutdown waits for graceful exit and verified descendant cleanup exactly once', async () => {
  const child = new EventEmitter(), calls = []; child.pid = 123; child.exitCode = null;
  let finishCleanup;
  child.stdin = { writable: true, write: value => calls.push(JSON.parse(value.split('@@SODUWORK_LOCAL_RPC@@')[1]).message.op), end() {} };
  const service = supervise(child, { graceMs: 1000, createGuard: () => ({
    start: async () => calls.push('start'), refresh: async () => calls.push('refresh'),
    stop: () => { calls.push('tree-stop'); return new Promise(resolve => { finishCleanup = resolve; }); },
    dispose: () => calls.push('dispose'),
  }) });
  let done = false; const stop = service.stop(); stop.then(() => { done = true; });
  assert.equal(service.stop(), stop);
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['start', 'refresh', 'runtime.shutdown']);
  assert.equal(done, false);
  child.emit('exit', 0); await new Promise(setImmediate);
  assert.equal(done, false, 'a launcher exit is not proof that its children exited');
  finishCleanup(); await stop;
  assert.deepEqual(calls, ['start', 'refresh', 'runtime.shutdown', 'tree-stop', 'dispose']);
});

test('Runner shutdown reaches owned-tree fallback after the grace period', async () => {
  const child = new EventEmitter(); child.pid = 123; child.exitCode = null;
  let attempts = 0, disposed = 0;
  const service = supervise(child, { graceMs: 5, createGuard: () => ({
    start: async () => {}, refresh: async () => {}, dispose: () => disposed++,
    stop: async () => { if (++attempts === 1) throw Error('transient snapshot failure'); },
  }) });
  await service.stop(); assert.equal(attempts, 2); assert.equal(disposed, 1);
});

test('rejected or throwing recovery admission retains the original recovery token', () => {
  const state = recovery.create(), turn = { id: 'turn-a', options: { taskId: 'a' } };
  state.remember(turn, { snapshot: { completion: { reason: 'error', retryable: true } } });
  assert.equal(state.take('turn-a', () => false), null);
  assert.equal(state.view().id, 'turn-a');
  assert.throws(() => state.take('turn-a', () => { throw Error('queue unavailable'); }), /unavailable/);
  assert.equal(state.view().id, 'turn-a');
  assert.ok(state.take('turn-a', () => true)); assert.equal(state.view(), null);
});

test('plugin inputs reach the execution context without entering visible history', () => {
  const input = [{ pluginId: 'p', inputValues: { format: 'md', enabled: false, count: 0 } },
    { pluginId: 'foreign', inputValues: { private: 'not selected' } }];
  const selected = plugins.inputSelections(input, ['p']);
  const prompt = plugins.augment('Write a report', [{ pluginId: 'p', name: 'Writer', context: 'Check the evidence' }], '', selected);
  assert.match(prompt, /"enabled":false/); assert.match(prompt, /"count":0/); assert.match(prompt, /"format":"md"/);
  assert.doesNotMatch(prompt, /not selected/);
  assert.equal(plugins.parse(prompt).text, 'Write a report');
  assert.doesNotMatch(JSON.stringify(plugins.parse(prompt)), /inputValues|format|enabled/);
  assert.throws(() => plugins.inputSelections([{ pluginId: 'p', inputValues: { value: 'x'.repeat(21000) } }], ['p']), /参数过长/);
});

test('plugin input markers cannot escape their hidden context', () => {
  const prompt = plugins.augment('Visible', [{ pluginId: 'p', context: 'method' }], '',
    [{ pluginId: 'p', inputValues: { goal: plugins.START + 'nested' + plugins.END } }]);
  assert.equal(plugins.parse(prompt).text, 'Visible'); assert.equal(plugins.parse(prompt).plugins.length, 1);
});

test('composer translation changes builtin presentation without renaming personal plugins', () => {
  const translate = text => text === '插件开发助手' ? 'Plugin Builder' : text;
  const rows = mention.normalizeCatalog({ items: [
    { pluginId: 'builtin', name: '插件开发助手', builtIn: true, locales: { 'zh-CN': { name: '插件开发助手' } } },
    { pluginId: 'personal', name: '插件开发助手' },
  ] });
  assert.equal(mention.displayText(rows[0], 'name', translate), 'Plugin Builder');
  assert.equal(mention.displayText(rows[1], 'name', translate), '插件开发助手');
  assert.equal(rows[0].name, '插件开发助手');
});

test('plugin setup from a conversation routes through the workspace host', async () => {
  const calls = [], context = { window: { addEventListener() {}, WorkspaceHost: { open: async (...args) => calls.push(args) } },
    document: { documentElement: { getAttribute: () => 'create' } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-capabilities.js'), 'utf8'), context);
  await context.window.openCapabilityPanel();
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'skills');
});

test('hidden starter controls cannot restore a consumed chip into the new-chat draft', () => {
  let remembered = 0; const panel = { dataset: { stage: 'chat' } };
  const context = { window: { NativeChat: { rememberComposerDraft: () => remembered++ } },
    document: { getElementById: id => id === 'composePanel' ? panel : {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/compose-surface.js'), 'utf8'), context);
  const surface = context.window.ComposeSurface.create({});
  surface._rememberComposeDraft(); assert.equal(remembered, 0);
  panel.dataset.stage = 'compose'; surface._rememberComposeDraft(); assert.equal(remembered, 1);
});
