'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

function runtime() {
  const values = new Map(), calls = [], events = [];
  let answer = async () => new Response('{"ok":true}');
  const window = { __SODUWORK_TEST_HUB_CONFIG__: { allowSwitch: true },
    CustomEvent: class { constructor(type) { this.type = type; } },
    dispatchEvent(event) { events.push(event.type); },
    SoduWorkLocalLibraryAPI: { install(api) { assert.equal(typeof api.pluginCatalog, 'function'); } },
  };
  const context = vm.createContext({ window, User: { id: 'plugin-fixture' }, navigator: { platform: 'test' },
    localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    fetch: (url, options) => { calls.push({ url, options }); return answer(url, options); },
    URL, URLSearchParams, Response, AbortController, FormData, console: { log() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {},
  });
  // Load physical production scripts separately: concatenated source-contract
  // fixtures cannot prove that the shared renderer global is registered in time.
  for (const file of ['core/api-work-plugins.js', 'api.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  return { window, api: window.SoduWorkAPI, calls, events, answer: value => { answer = value; } };
}

test('both renderers load the plugin factory before constructing the shared API object', () => {
  for (const file of ['desk.html', 'index.html']) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(match => match[1]);
    assert.ok(scripts.indexOf('core/api-work-plugins.js') >= 0);
    assert.ok(scripts.indexOf('core/api-work-plugins.js') < scripts.indexOf('api.js'));
  }
  const { window, api } = runtime();
  for (const name of ['SoduWorkAPI', 'SoduWorkAPI', 'SoduWorkAPI']) assert.equal(window[name], api);
  const replacement = async () => ({ items: [] });
  window.SoduWorkAPI.pluginCatalog = replacement;
  assert.equal(api.pluginCatalog, replacement, 'existing caller patches still affect the one public object');
});

test('plugin methods read the current native bridge and task queue after initialization', async () => {
  const { window, api, calls } = runtime();
  window.soduWorkAPI = { personalPlugins: { get: async id => ({ id, version: 'first' }) } };
  assert.equal((await api.personalPlugin('local:one')).version, 'first');
  window.soduWorkAPI = { personalPlugins: { get: async id => ({ id, version: 'replacement' }) } };
  assert.equal((await api.personalPlugin('local:one')).version, 'replacement');
  const queued = [];
  window.NativeChat = { enqueueTask: async (id, options) => { queued.push({ id, options }); return { ok: true }; } };
  await api.startTaskPlugin('task-1', { instruction: 'do the work', execution: { agentKind: 'local:pi' } });
  assert.equal(calls.length, 0);
  assert.equal(queued[0].options.reuseConversation, false);
  assert.equal(queued[0].options.executionContext.strategy, 'workflow');
  await api.startTaskPlugin('task-1', { resumeFromRunId: 'run-1' });
  assert.equal(calls.length, 1, 'resuming continues through the shared Hub transport');
});

test('a plugin mutation cannot publish invalidation after the shared Hub scope changes', async () => {
  const f = runtime();
  let finish;
  f.answer(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.api.setEnterprisePluginInstalled('plugin-1', true, 'version-1', {});
  f.api.setHubEnvironment('development', 'http://127.0.0.1:34567');
  finish(new Response('{"ok":true}'));
  await assert.rejects(pending, error => error.code === 'STALE_TASK_SCOPE');
  assert.equal(f.events.includes('soduwork:plugins-changed'), false);
});
