// Run: node e2e/account-history-lifecycle-http.cjs
// Real account-sync + worker SQLite store -> loopback FastAPI router -> SQLite.
// No Electron/UI, production configuration, credentials, or user data are used.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { create } = require('../main/conversation/account-sync');
const { createWorker } = require('../main/conversation/account-sync-store');
const { accountScopeKey, fetchWithDeviceAuthRetry } = require('../main/device-auth-request');

const repo = path.resolve(__dirname, '../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-http-'));
const syncs = new Set(), requests = [], checks = [];
let child, connection, hub;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = label => { checks.push(label); console.log('PASS ' + label); };

async function startHub() {
  const python = path.join(repo, 'hub-backend/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  assert.ok(fs.existsSync(python), 'Repository backend virtual environment is required');
  // Intentionally allowlist OS essentials: never inherit production DB, proxy,
  // cloud credentials, Python import overrides or application configuration.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/i.test(key)));
  Object.assign(env, { PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' });
  child = spawn(python, ['-B', path.join(__dirname, 'fixtures/account_history_lifecycle_hub.py'), '--root', root],
    { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  connection = await new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timer = setTimeout(() => reject(Error('Isolated Hub startup timed out: ' + errors)), 30000);
    child.stderr.on('data', part => { errors = (errors + part).slice(-4000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(Error('Isolated Hub exited during startup: ' + code + ' ' + errors)); });
    child.stdout.on('data', part => {
      output += part;
      const match = output.match(/HISTORY_FIXTURE_READY (\{[^\n]+\})/);
      if (!match) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(match[1])); } catch (_) { reject(Error('Invalid fixture startup response')); }
      output = '';
    });
  });
  hub = 'http://127.0.0.1:' + connection.port;
}

async function http(identity, url, options = {}) {
  const target = new URL(url);
  assert.equal(target.origin, hub, 'Every request must remain on the isolated loopback Hub');
  const response = await fetchWithDeviceAuthRetry(identity, url, options);
  requests.push({ method: options.method || 'GET', path: target.pathname,
    query: Object.fromEntries(target.searchParams), status: response.status });
  return response;
}

function client(name, profile = name) {
  const identity = { ...connection.identities[name], hub };
  const dir = path.join(root, profile);
  fs.mkdirSync(dir, { recursive: true });
  const app = { getPath: () => dir };
  const store = createWorker(path.join(dir, 'account-sync.json'));
  const sync = create({ app, store, identityOf: async () => identity, localIdentityOf: () => identity,
    fetch: http, realtime: false, retryMs: 60000 });
  syncs.add(sync);
  const scope = JSON.stringify([hub, accountScopeKey(identity), identity.clientId]);
  return { sync, store, identity, scope, async close() { await sync.close(); syncs.delete(sync); } };
}

async function main() {
  await startHub();
  const source = client('source'), second = client('second');
  const initial = await source.sync.history(); // No caller-supplied limit or options.
  assert.equal(initial.ok, true, 'Default history() must pass the real FastAPI query validator');
  assert.deepEqual(initial.chats, []);
  assert.deepEqual(requests[0], { method: 'GET', path: '/api/v1/account-conversations',
    query: { after: '0', limit: '100' }, status: 200 });
  // Negative control proves this is the real bounded query contract, not a
  // fixture accepting the old incompatible client limit of 200.
  const invalid = await http(source.identity, hub + '/api/v1/account-conversations?limit=200');
  assert.equal(invalid.status, 422); await invalid.body.cancel();
  record('default history() sends limit=100 and returns HTTP 200; limit=200 is rejected');

  const messages = [{ id: 'u1', role: 'user', text: 'Synthetic conversation', sentAt: 1700000000000, done: true }];
  const handle = { sessionId: 'native-http-contract', snapshot: () => ({ title: 'HTTP lifecycle fixture', status: 'completed', messages }) };
  const bound = source.sync.bind(handle, source.identity);
  await bound.ready;
  assert.equal((await source.sync.flush()).ok, true);
  assert.equal((await source.store.jobs()).length, 0, 'Real SQLite outbox must receive the Hub ACK');
  const created = await source.sync.history({ force: true });
  assert.equal(created.ok, true); assert.equal(created.chats.length, 1);
  const id = created.chats[0].id;
  assert.equal(created.chats[0].sourceSessionId, handle.sessionId);
  const otherView = await second.sync.history();
  assert.equal(otherView.chats[0].id, id);
  assert.equal(otherView.chats[0].sourceClientId, source.identity.clientId);
  record('real source checkpoint and durable ACK appear on a second device in the same account');

  const archived = await second.sync.setLifecycle(id, 'archive');
  assert.equal(archived.ok, true, archived.reason); assert.equal(archived.archived, true);
  assert.ok(archived.lifecycleRevision > 0);
  assert.equal((await source.sync.history({ force: true })).chats.length, 0);
  messages.push({ id: 'a1', role: 'assistant', text: 'Checkpoint after archive', sentAt: 1700000001000, done: true });
  assert.equal((await source.sync.flush()).ok, true);
  const archivedAgain = await source.sync.history({ archived: true, force: true });
  assert.equal(archivedAgain.chats[0].id, id);
  assert.equal(archivedAgain.chats[0].lifecycleRevision, archived.lifecycleRevision);
  assert.equal((await source.sync.history()).chats.length, 0);
  record('archive propagates across devices; ordinary source sync cannot restore it');

  const restored = await second.sync.setLifecycle(id, 'restore');
  assert.equal(restored.ok, true, restored.reason); assert.equal(restored.archived, false);
  assert.ok(restored.lifecycleRevision > archived.lifecycleRevision);
  assert.equal((await source.sync.history({ force: true })).chats[0].id, id);
  assert.equal((await source.sync.history({ archived: true })).chats.length, 0);
  record('explicit restore returns the conversation to active history');

  const deleted = await second.sync.setLifecycle(id, 'delete');
  assert.equal(deleted.ok, true, deleted.reason); assert.equal(deleted.deleted, true);
  messages.push({ id: 'a2', role: 'assistant', text: 'Late checkpoint after delete', sentAt: 1700000002000, done: true });
  assert.equal((await source.sync.flush()).ok, true);
  const afterDelete = await source.sync.history({ force: true });
  assert.equal(afterDelete.chats.length, 0);
  assert.equal((await source.sync.history({ archived: true })).chats.length, 0);
  assert.equal(afterDelete.lifecycle.find(row => row.id === id).deleted, true);
  assert.equal(afterDelete.lifecycle.find(row => row.id === id).lifecycleRevision, deleted.lifecycleRevision);
  record('delete creates a persistent tombstone; late source sync cannot resurrect it');

  const fresh = client('reinstalled');
  const freshHistory = await fresh.sync.history();
  assert.equal(freshHistory.ok, true); assert.equal(freshHistory.chats.length, 0);
  assert.equal(freshHistory.lifecycle.find(row => row.id === id).deleted, true);
  assert.equal((await fresh.sync.history({ archived: true })).chats.length, 0);
  const saved = await fresh.store.directory(fresh.scope);
  assert.equal(saved.items.find(row => row.id === id).deleted, true);
  await fresh.close();
  const restarted = client('reinstalled');
  assert.equal((await restarted.store.directory(restarted.scope)).items.find(row => row.id === id).deleted, true);
  assert.equal((await restarted.sync.history()).chats.length, 0);
  record('empty-profile/reinstalled device and reopened SQLite store retain the deletion tombstone');

  const stranger = client('stranger');
  assert.equal((await stranger.sync.history()).chats.length, 0);
  for (const suffix of ['source', 'messages', 'lifecycle']) {
    const response = await http(stranger.identity, hub + '/api/v1/account-conversations/' + id + '/' + suffix,
      suffix === 'lifecycle' ? { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restore', expectedRevision: deleted.conversation.revision }) } : {});
    assert.ok([403, 404].includes(response.status), 'Different account must not access ' + suffix);
    await response.body.cancel();
  }
  record('different account cannot list, read or mutate the conversation (403/404)');
  const directoryRequests = requests.filter(row => row.path === '/api/v1/account-conversations' && row.query.limit !== '200');
  assert.ok(directoryRequests.length >= 5);
  assert.ok(directoryRequests.every(row => row.query.limit === '100' && row.status === 200));
  assert.equal(requests.filter(row => row.status === 422).length, 1, 'Only the explicit negative control may return 422');
  return { passed: checks.length, httpRequests: requests.length, defaultDirectoryRequests: directoryRequests.length,
    database: 'temporary SQLite', boundary: 'real HTTP/router/store; synthetic identities; no UI or production environment' };
}

async function cleanup() {
  await Promise.allSettled([...syncs].map(sync => sync.close()));
  if (child && child.exitCode === null && child.signalCode === null) {
    if (connection) {
      try { await fetch(hub + '/__fixture__/shutdown', { method: 'POST',
        headers: { 'X-Fixture-Key': connection.key }, signal: AbortSignal.timeout(2000) }); } catch (_) {}
    }
    for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await delay(50);
    if (child.exitCode === null && child.signalCode === null) {
      // Only the exact child created by this test, never process names or ports.
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill(); await Promise.race([exited, delay(2000)]);
    }
  }
  const resolved = path.resolve(root), parent = path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolved), parent);
  assert.ok(path.basename(resolved).startsWith('soduwork-history-http-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

(async () => {
  try { const report = await main(); await cleanup(); console.log(JSON.stringify(report)); }
  catch (error) {
    try { await cleanup(); } catch (cleanupError) { console.error('Cleanup failed: ' + cleanupError.message); }
    console.error(error.stack || String(error)); process.exitCode = 1;
  }
})();
