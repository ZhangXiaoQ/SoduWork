'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs'), path = require('node:path'), vm = require('node:vm');
async function fixture(bridge = {}) {
  const values = new Map([['soduwork_work_hub_url', 'https://fixture.invalid']]), requests = [];
  const context = { console, URL, URLSearchParams, AbortController, FormData,
    navigator: {platform: 'test'}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    dispatchEvent() {}, addEventListener() {},
    localStorage: {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key)},
    soduWorkAPI: {getAppVersion: async () => 'test', getSysInfo: async () => ({}),
      deviceAuthBootstrap: async () => ({ok: true, stored: true, authState: 'active', user: {id: 'alice'},
        clientId: 'desktop', session: 'fixture', expiresIn: 1800}), configureRunner: async () => ({ok: true}), ...bridge},
    fetch: async (url, options) => { requests.push({url, options}); return {ok: true, status: 200,
      text: async () => JSON.stringify({id: 'project-one', name: 'Saved', revision: 1})}; },
  };
  context.window = context; vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8'), context);
  await context.SoduWorkAPI.registerClient();
  return {api: context.SoduWorkAPI, context, requests};
}
test('a committed project write remains successful when cache invalidation IPC is unavailable', async () => {
  const f = await fixture({clientDomainInvalidate: async () => { throw Error('IPC temporarily unavailable'); }});
  assert.equal((await f.api.saveConversationProject('project-one', {name: 'Saved', revision: 0})).revision, 1);
  assert.equal(f.requests.filter(row => row.options.method === 'PUT').length, 1);
});
test('project GET uses the shared host snapshot without changing its response shape', async () => {
  let calls = 0;
  const f = await fixture({clientDomainRead: async (domain, scope) => {
    calls++; assert.equal(domain, 'conversation-projects'); assert.equal(scope.userId, 'alice');
    return {ok: true, value: {items: [{id: 'project-one', name: 'Saved'}]}};
  }});
  assert.equal((await f.api.conversationProjects()).items[0].id, 'project-one');
  assert.equal(calls, 1); assert.equal(f.requests.length, 0);
});
test('browser callers without the new bridge retain the original HTTP request', async () => {
  const f = await fixture(); await f.api.conversationProjects();
  assert.ok(f.requests.at(-1).url.endsWith('/api/v1/conversation-projects'));
});

test('execution history binds an encoded task and run while retaining legacy pagination', async () => {
  const f = await fixture();
  await f.api.aiSession('task/slash', 0, 'run:a&b c');
  const first = new URL(f.requests.at(-1).url);
  assert.ok(first.pathname.endsWith('/tasks/task%2Fslash/ai-session'));
  assert.equal(first.searchParams.get('ref'), 'run:a&b c');
  assert.equal(first.searchParams.has('since'), false);
  await f.api.aiSession('task/slash', 400, 'run:a&b c');
  const next = new URL(f.requests.at(-1).url);
  assert.equal(next.searchParams.get('since'), '400');
  assert.equal(next.searchParams.get('ref'), 'run:a&b c');
  await f.api.aiSession('task/slash', 400);
  assert.ok(f.requests.at(-1).url.endsWith('/ai-session?since=400'));
  assert.equal(f.requests.at(-1).options.method, undefined);
});
test('model and config reads use shared snapshots and successful writes invalidate their domain', async () => {
  const invalidated = [], reads = [];
  const f = await fixture({clientDomainRead: async domain => {
    reads.push(domain); return {ok: true, value: domain === 'models' ? {providers: [], usable: [], myModels: []} : {theme: 'dark'}};
  }, clientDomainInvalidate: async domain => { invalidated.push(domain); return {ok: true}; }});
  assert.deepEqual(Array.from((await f.api.myModels()).usable), []);
  assert.equal((await f.api.getConfig()).theme, 'dark');
  await f.api.saveMyModels({keys: {}}); await f.api.setAgentModel('pi', 'model');
  await f.api.checkMyModelCapabilities({providerId: 'provider', model: 'model'}); await f.api.syncConfig({theme: 'light'});
  assert.deepEqual(reads, ['models', 'config']);
  assert.deepEqual(invalidated, ['models', 'models', 'models', 'config']);
});
test('message cache preserves conditional response shape and leaves pagination requests unchanged', async () => {
  const f = await fixture({clientDomainRead: async domain => {
    assert.equal(domain, 'team-messages-received');
    return {ok: true, value: {ok: true, folder: 'received', items: [{id: 'one'}], revision: 'r1', nextCursor: ''}};
  }});
  const unchanged = await f.api.mateMessages('received', 200, '', 'r1');
  assert.equal(unchanged.notModified, true); assert.equal(unchanged.items.length, 0); assert.equal(unchanged.revision, 'r1');
  assert.equal((await f.api.mateMessages('received', 200, '', 'older')).items[0].id, 'one');
  await f.api.mateMessages('received', 200, 'page-two', 'r1');
  assert.ok(f.requests.at(-1).url.includes('before=page-two')); assert.ok(!f.requests.at(-1).url.includes('ifRevision'));
  await f.api.mateMessages('unknown-folder', 200); assert.ok(f.requests.at(-1).url.includes('folder=unknown-folder'));
});
test('old and mixed Hubs retain the original conditional message HTTP request', async () => {
  const f = await fixture({clientDomainRead: async () => ({ok: false, code: 'DOMAIN_POLL_FALLBACK'})});
  await f.api.mateMessages('sent', 200, '', 'r1');
  assert.ok(f.requests.at(-1).url.endsWith('/team/messages?folder=sent&limit=200&ifRevision=r1'));
});
test('host HTTP failures preserve the renderer error metadata and reachability semantics', async () => {
  const f = await fixture({clientDomainRead: async () => ({ok: false, status: 503, online: true,
    body: {detail: {code: 'SERVICE_BUSY', message: 'Busy', retryable: true, phase: 'read', attemptId: 'fixture'}}})});
  await assert.rejects(f.api.myModels(), error => error.status === 503 && error.code === 'SERVICE_BUSY' &&
    error.message === 'Busy' && error.retryable === true && error.phase === 'read' && error.attemptId === 'fixture');
  assert.equal(f.api.online, true);
});
test('quota errors keep their structured authorization behavior and 401 does not force logout', async () => {
  let result = {ok: false, status: 403, online: true,
    body: {detail: {code: 'TOKEN_QUOTA_EXCEEDED', message: 'Quota exceeded', quota: {exceeded: true}}}};
  const f = await fixture({clientDomainRead: async () => result});
  await assert.rejects(f.api.myModels(), error => error.code === 'TOKEN_QUOTA_EXCEEDED' && error.payload.quota.exceeded);
  assert.equal(f.api.clientAuthSnapshot().user.id, 'alice');
  assert.equal(f.api.clientAuthSnapshot().state, 'active');
  assert.equal(f.api.clientAuthSnapshot().quota.exceeded, true);
  result = {ok: false, status: 401, online: true, body: {detail: {code: 'SESSION_EXPIRED'}}};
  await assert.rejects(f.api.myModels(), error => error.status === 401 && error.code === 'SESSION_EXPIRED');
  assert.equal(f.api.clientAuthSnapshot().state, 'active'); assert.equal(f.api.clientAuthSnapshot().user.id, 'alice');
});
test('local snapshots and cached errors cannot change offline status while a fresh HTTP response can', async () => {
  let result = {ok: false, online: false, reason: 'offline'};
  const f = await fixture({clientDomainRead: async () => result});
  await assert.rejects(f.api.myModels()); assert.equal(f.api.online, false);
  result = {ok: true, value: {providers: [], usable: [], myModels: [], items: [], revision: 'r1'}};
  await f.api.myModels(); await f.api.getConfig(); await f.api.mateMessages('received', 200);
  await f.api.conversationProjects(); assert.equal(f.api.online, false);
  result = {ok: false, status: 503, body: {detail: 'Cached unavailable'}};
  await f.api.getConfig(); await f.api.mateMessages('received', 200); assert.equal(f.api.online, false);
  result = {ok: true, online: true, value: {providers: [], usable: [], myModels: []}};
  await f.api.myModels(); assert.equal(f.api.online, true);
});
