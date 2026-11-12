'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function renderer() {
  let now = 1000, observer;
  const callbacks = [], listeners = {}, dom = {};
  const window = { performance: { now: () => now }, crypto: { randomUUID: () => '12345678-1234-4123-8123-123456789abc' },
    document: { visibilityState: 'visible', addEventListener: (name, fn) => { dom[name] = fn; } },
    requestAnimationFrame: callback => callbacks.push(callback), addEventListener: (name, fn) => { listeners[name] = fn; },
    PerformanceObserver: class { constructor(callback) { observer = callback; } observe() {} },
  };
  const context = vm.createContext({ window, Date: { now: () => now }, console, setTimeout, clearTimeout, URL, URLSearchParams,
    AbortController, FormData, Response, navigator: { platform: 'test' }, User: { id: 'private-device' } });
  vm.runInContext(read('core/page-performance.js'), context);
  return { window, context, api: window.SoduWorkPagePerformance, dom, listeners,
    advance: ms => { now += ms; }, frames: () => { callbacks.splice(0).forEach(fn => fn()); },
    longTask: entries => observer({ getEntries: () => entries }) };
}

test('navigation separates queued input, synchronous work and first frame without changing return values', async () => {
  const s = renderer(); let calls = 0;
  s.dom.click({ timeStamp: 980, target: { closest: () => ({ dataset: { view: 'settings' } }) } });
  assert.equal(s.api.navigate('settings', () => { calls++; s.advance(5); return 42; }), 42);
  s.advance(16); s.frames(); s.advance(16); s.frames();
  const [row] = (await s.api.snapshot()).events;
  assert.equal(calls, 1); assert.equal(row.inputDelayMs, 20); assert.equal(row.handlerMs, 5);
  assert.equal(row.firstFrameMs, 37); assert.equal(row.background, false);
  assert.throws(() => s.api.navigate('settings', () => { throw Error('private text'); }), /private text/);
  assert.equal((await s.api.snapshot()).events.at(-1).ok, false);
  assert.doesNotMatch(JSON.stringify(await s.api.snapshot()), /private text/);
});

test('request evidence only retains allowlisted paths and numeric server timings', async () => {
  const s = renderer();
  assert.equal(s.api.beginRequest('https://user:password@example.test/private'), null);
  const span = s.api.beginRequest('/plugins/catalog?token=private-token', 'GET');
  s.advance(120);
  span.response(new Response('private body', { headers: { 'X-Request-ID': span.requestId,
    'Server-Timing': 'app;dur=65;desc="private SQL", db-acquire;dur=40, db-sql;dur=5, db-hold;dur=15, secret;dur=2' } }));
  span.finish(true); span.finish(false);
  const report = await s.api.snapshot(), [row] = report.events;
  assert.equal(report.events.length, 1); assert.equal(row.name, '/plugins/catalog');
  assert.equal(row.durationMs, 120); assert.equal(row.correlated, true);
  assert.deepEqual(JSON.parse(JSON.stringify(row.server)), { app: 65, 'db-acquire': 40, 'db-sql': 5, 'db-hold': 15 });
  assert.doesNotMatch(JSON.stringify(report), /private|token|password|example\.test|secret/);
});

test('scope invalidation fences old requests, queued frames and buffered long tasks', async () => {
  const s = renderer(), span = s.api.beginRequest('/team/capability');
  s.api.navigate('settings', () => {}); s.advance(20); s.listeners['soduwork-data-scope-changed']();
  span.finish(true); s.frames(); s.frames();
  s.longTask([{ startTime: 1000, duration: 100, attribution: [{ name: 'private path' }] }]);
  assert.equal((await s.api.snapshot()).events.length, 0);
  s.longTask([{ startTime: 1020, duration: 75, name: 'private path' }]);
  const [row] = (await s.api.snapshot()).events;
  assert.equal(row.kind, 'longtask'); assert.equal(row.name, 'renderer'); assert.equal(row.durationMs, 75);
});

test('buffers have a hard cap and expire; snapshots cannot mutate retained records', async () => {
  const s = renderer();
  for (let i = 0; i < 250; i++) { const span = s.api.beginRequest('/library'); span.finish(true); }
  const report = await s.api.snapshot(); assert.equal(report.events.length, 200);
  report.events[0].name = 'mutated'; assert.equal((await s.api.snapshot()).events[0].name, '/library');
  s.advance(600001); assert.equal((await s.api.snapshot()).events.length, 0);
});

test('detail interaction phases retain no task IDs, content or mutable stage references', async () => {
  const s = renderer(), span = s.api.interaction('requirement-detail');
  s.advance(5); span.mark('shell'); s.advance(1000); span.mark('ready');
  const request = s.api.beginRequest('/tasks/private-id?token=secret', 'GET'); request.finish(true);
  assert.equal(s.api.interaction('private-title'), null);
  const report = await s.api.snapshot();
  assert.doesNotMatch(JSON.stringify(report), /private-id|secret|private-title/);
  assert.equal(report.events[0].stages.shell, 5);
  report.events[0].stages.shell = 999;
  assert.equal((await s.api.snapshot()).events[0].stages.shell, 5);
  s.api.clear(); span.mark('failed');
  assert.equal((await s.api.snapshot()).events.length, 0);
});

test('identity change during an asynchronous snapshot cannot expose the previous scope', async () => {
  const s = renderer(); let resolve;
  s.window.soduWorkAPI = { pagePerformance: { snapshot: () => new Promise(r => { resolve = r; }) } };
  s.api.navigate('settings', () => {});
  const pending = s.api.snapshot(); s.api.clear();
  resolve({ available: true, events: [{ name: 'old' }] });
  const report = await pending;
  assert.equal(report.events.length, 0); assert.equal(report.ipc.events.length, 0);
});

test('a failed animation scheduler cannot change navigation results or errors', () => {
  const s = renderer(); s.window.requestAnimationFrame = () => { throw Error('scheduler'); };
  assert.equal(s.api.navigate('settings', () => 42), 42);
  const failure = Error('original');
  assert.throws(() => s.api.navigate('settings', () => { throw failure; }), error => error === failure);
});

test('the real API carries a correlation id and records total time without retaining bodies', async () => {
  const s = renderer(), values = new Map(); let pending, observedHeaders;
  s.context.localStorage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  s.context.fetch = (_url, options) => { observedHeaders = options.headers; return new Promise(resolve => { pending = resolve; }); };
  for (const file of ['core/api-work-plugins.js', 'api.js']) vm.runInContext(read(file), s.context);
  const request = s.window.SoduWorkAPI.getTeamCapability(); await flush(); s.advance(80);
  pending(new Response('{"assigned":true,"meName":"private-name"}', { headers: { 'X-Request-ID': observedHeaders['X-Request-ID'], 'Server-Timing': 'app;dur=70, db-acquire;dur=50' } }));
  assert.equal((await request).assigned, true);
  const row = (await s.api.snapshot()).events[0];
  assert.equal(row.requestId, observedHeaders['X-Request-ID']); assert.equal(row.durationMs, 80);
  assert.equal(row.server['db-acquire'], 50); assert.equal(row.correlated, true);
  assert.doesNotMatch(JSON.stringify(await s.api.snapshot()), /private-name|private-device/);
});

test('authentication retry stays in one request span and retains the same correlation id', async () => {
  const s = renderer(), ids = [];
  s.context.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  s.context.fetch = async (_url, options) => {
    ids.push(options.headers['X-Request-ID']); s.advance(30);
    return new Response(ids.length === 1 ? '{}' : '{"assigned":true}', { status: ids.length === 1 ? 401 : 200 });
  };
  for (const file of ['core/api-work-plugins.js', 'api.js']) vm.runInContext(read(file), s.context);
  s.window.SoduWorkAPI.registerClient = async () => { s.advance(20); return { ok: true, session: 'private-session' }; };
  assert.equal((await s.window.SoduWorkAPI.getTeamCapability()).assigned, true);
  const report = await s.api.snapshot();
  assert.equal(report.events.length, 1); assert.equal(report.events[0].attempts, 2);
  assert.equal(report.events[0].durationMs, 80); assert.equal(report.events[0].status, 200);
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
});

function preload() {
  let now = 1000;
  const exposed = {}, pending = [];
  const ipcRenderer = { invoke: (name, ...args) => new Promise((resolve, reject) => pending.push({ name, args, resolve, reject })), on() {}, removeListener() {}, send() {} };
  vm.runInNewContext(read('preload.js'), { require: name => {
    assert.equal(name, 'electron'); return { ipcRenderer, contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } } };
  }, Date: { now: () => now }, performance: { now: () => now }, console });
  return { api: exposed.soduWorkAPI, pending, advance: ms => { now += ms; } };
}

test('real preload measures IPC but preserves result/error identity and omits arguments', async () => {
  const s = preload(), result = { privateContent: 'private secret' };
  const request = s.api.personalPlugins.list({ privatePath: '/private/home' }); s.advance(40); s.pending[0].resolve(result);
  assert.equal(await request, result);
  assert.equal(s.api.pagePerformance.snapshot().events[0].durationMs, 40);
  const failure = s.api.clientUpdateStatus(), error = Error('private failure'); s.pending[1].reject(error);
  await assert.rejects(failure, candidate => candidate === error);
  assert.equal(s.api.pagePerformance.snapshot().events[1].ok, false);
  assert.doesNotMatch(JSON.stringify(s.api.pagePerformance.snapshot()), /private|secret/);
});

test('desktop preload explicitly advertises local history and forwards bounded source options', async () => {
  const s = preload(), options = { source: 'local', archived: true, limit: 50,
    after: { at: 12, id: 'local-row' }, workspace: 'local-profile', catalogRevision: 7 };
  assert.equal(s.api.conversationSession.localHistorySupported, true);
  const request = s.api.conversationSession.history(options);
  assert.equal(s.pending[0].name, 'pi-session-history');
  assert.equal(s.pending[0].args[0], options);
  const result = { ok: true, chats: [], localCatalog: { workspace: 'local-profile', revision: 7 } };
  s.pending[0].resolve(result);
  assert.equal(await request, result);
  assert.doesNotMatch(JSON.stringify(s.api.pagePerformance.snapshot()), /local-profile|local-row/);
});

test('preload clears in-flight evidence on identity change and bounds count and age', async () => {
  const s = preload(), old = s.api.clientUpdateStatus(); s.api.pagePerformance.clear();
  s.pending[0].resolve({}); await old; assert.equal(s.api.pagePerformance.snapshot().events.length, 0);
  for (let i = 0; i < 210; i++) { const request = s.api.clientUpdateStatus(); s.pending.at(-1).resolve({}); await request; }
  assert.equal(s.api.pagePerformance.snapshot().events.length, 200);
  s.advance(600001); assert.equal(s.api.pagePerformance.snapshot().events.length, 0);
});
