'use strict';
// Production sidebar, confirmation dialog, preload, history IPC and worker
// outbox against an isolated HTTP source. Never opens the user's profile.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit', timeout: 90000 });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), http = require('node:http');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-account-delete-e2e-'));
const output = path.resolve(process.argv[2] || path.join(__dirname, '../../outputs/account-history-delete'));
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
const report = { ok: false, cases: [], boundary: 'Actual Electron sidebar, preload, confirmation and IPC; real worker SQLite outbox; isolated HTTP Hub fixture; no user data or model calls.' };
const record = { id: 'acct-empty-source', title: '需求执行误建会话', sourceClientId: 'device',
  sourceSessionId: 'empty-native', state: 'idle', deleted: false, revision: 1, lifecycleRevision: 0 };
const requirement = { id: 'cloud-execution:retained', title: '原需求与交付记录', state: 'completed', cloud: true };
let revision = 1, writes = 0, win, sync, server, shared, online = true;
const js = code => win.webContents.executeJavaScript(code, true);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code) {
  for (let i = 0; i < 150; i++) { if (await js(code)) return; await delay(40); }
  throw Error('UI did not settle: ' + code);
}
async function click(selector) {
  const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) });
  await delay(100);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 });
}
async function showDelete() {
  await click('[data-chat-id="acct-empty-source"] + .ws-chat-actions .ws-chat-more');
  await until('!!document.querySelector(".ws-chat-menu:not([hidden])")');
  await click('.ws-chat-menu:not([hidden]) .ws-chat-delete');
  await until('!!document.querySelector(".app-confirm-dialog[open]")');
}
app.whenReady().then(async () => {
  require('../main/native-locale.cjs').setLocale('zh-CN');
  fs.writeFileSync(path.join(root, 'native.jsonl'), 'native archive retained');
  fs.writeFileSync(path.join(root, 'delivery.txt'), 'requirement output retained');
  server = http.createServer(async (request, response) => {
    let data;
    if (request.method === 'POST' && request.url === '/api/v1/account-conversations/acct-empty-source/lifecycle') {
      let text = ''; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text); writes++;
      assert.deepEqual(body, { action: 'delete', expectedRevision: revision }); revision++;
      Object.assign(record, { deleted: true, archived: false, revision, lifecycleRevision: revision });
      data = { ok: true, conversation: record };
    } else if (request.method === 'GET' && request.url.endsWith('/source')) {
      data = { conversation: record, sourceEpoch: 'empty-native:desktop', sourceRevision: revision };
    } else if (request.method === 'GET' && request.url.startsWith('/api/v1/account-conversations?')) {
      data = { items: [record], cursor: revision, hasMore: false };
    } else { response.writeHead(404); response.end('{}'); return; }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let actor = { ...require('../tests/helpers/platform-session-fixture.cjs').identity(), hub: 'http://127.0.0.1:' + server.address().port };
  // Authentication is isolated; the production lifecycle and transport remain intact.
  const access = require('../main/conversation/history-access'), baseActor = access.actor;
  let captured = baseActor(app, actor);
  access.actor = () => captured;
  require('../main/conversation/requirement-context').cachedIdentity = () => actor;
  const create = () => {
    sync = require('../main/conversation/account-sync').create({ app,
      store: require('../main/conversation/account-sync-store').createWorker(path.join(root, 'outbox')),
      identityOf: async () => actor, fetch: (_identity, url, options) => fetch(url, options) });
    sync.onChange((id, _row, presence) => win?.webContents.send('pi-session-event', { sessionId: id, presence }));
  };
  create();
  const localSession = { findBySessionId: () => null, historyEntry: async () => ({ ok: false, notFound: true }),
    archivedConversation: async () => null, forgetRunner: () => assert.fail('must not delete native records'),
    archivedHistory: async () => ({ ok: true, chats: await shared.indexedRows(true, 100) }) };
  const openShared = () => { shared = require('../main/conversation/shared-history.cjs').create({ app, session: localSession }); };
  openShared();
  const localHistory = Object.fromEntries(['resolve', 'lifecycle'].map(method => [method, (...args) => shared[method](...args)]));
  ipcMain.handle('recent-workspace-get', () => ({ ok: true, items: [] }));
  ipcMain.handle('pi-session-history', require('./fixtures/history-ipc.cjs').create(async (_event, options) => ({ ok: true, chats: [
    ...(online ? (await sync.history({ force: true, source: options?.source })).chats : []), requirement,
    ...(options?.source === 'account' ? [] : await shared.indexedRows(false, 100))] }),
  { local: options => shared.page(options) }));
  require('../main/pi-session/history-ipc').install({ app, ipcMain,
    accountHistory: { resolveLifecycle: (...args) => sync.resolveLifecycle(...args), setLifecycle: (...args) => sync.setLifecycle(...args) },
    BrowserWindow, sharedHistory: localHistory, session: localSession });
  win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: {
    preload: path.join(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false,
    offscreen: true, backgroundThrottling: false } });
  const load = async () => {
    await win.loadFile(path.join(__dirname, 'fixtures/sidebar-projects.html'));
    await win.webContents.insertCSS(fs.readFileSync(path.join(__dirname, '../components/shared/app-confirm-dialog.css'), 'utf8'));
    await js(fs.readFileSync(path.join(__dirname, '../components/shared/app-confirm-dialog.js'), 'utf8'));
    await until('!!row("cloud-execution:retained")');
  };
  await load(); await until('!!row("acct-empty-source")');
  await showDelete();
  assert.equal(await js('document.querySelector(".app-confirm-submit").textContent'), '删除会话');
  assert.equal(await js('document.querySelector(".app-confirm-detail").textContent'),
    '该会话将从当前账号的会话列表中删除，其他设备也会同步；需求和成果文件不会删除。');
  assert.equal(writes, 0); await click('.app-confirm-cancel');
  await until('!document.querySelector(".app-confirm-dialog")');
  assert.equal(await js('!!row("acct-empty-source")'), true); assert.equal(writes, 0);
  report.cases.push('Cancel through the real sidebar/dialog performs no write and retains the row.');
  await showDelete();
  fs.writeFileSync(path.join(output, 'confirmation.png'), (await win.webContents.capturePage()).toPNG());
  await click('.app-confirm-submit');
  await until('!row("acct-empty-source")');
  assert.equal(writes, 1); assert.equal(await js('!!row("cloud-execution:retained")'), true);
  report.cases.push('Confirm through preload and production IPC deletes only the synchronized projection.');
  await sync.close(); create();
  sync.bind({ sessionId: 'empty-native', snapshot: () => ({ status: 'idle', messages: [] }) }, actor);
  await sync.flush(); await load();
  assert.equal(await js('!!row("acct-empty-source")'), false); assert.equal(writes, 1);
  assert.equal(fs.readFileSync(path.join(root, 'native.jsonl'), 'utf8'), 'native archive retained');
  assert.equal(fs.readFileSync(path.join(root, 'delivery.txt'), 'utf8'), 'requirement output retained');
  assert.deepEqual(await js('errors'), []);
  fs.writeFileSync(path.join(output, 'after-reopen.png'), (await win.webContents.capturePage()).toPNG());
  report.cases.push('Service restart, native source rebind and real page reload retain the deletion and preserve requirement/output records.');
  await sync.close(); online = false;
  const [local] = await shared.register([{ id: 'shared-copy', cached: true, title: 'Shared local copy',
    source: { id: 'cloud-original', account: 'old-account' } }]);
  await shared.store.cache(local.id, [{ role: 'assistant', text: 'Complete local transcript' }], { expectedRevision: local.replicaRevision });
  actor = require('../tests/helpers/platform-session-fixture.cjs').identity('two');
  captured = baseActor(app, actor);
  await load(); await until('!!row("shared-copy")');
  const view = await shared.open(local.id);
  assert.equal(view.snapshot().messages[0].text, 'Complete local transcript');
  assert.equal(view.readOnly, true); await view.close();
  await click('[data-chat-id="shared-copy"] + .ws-chat-actions .ws-chat-more');
  await click('.ws-chat-menu:not([hidden]) .ws-chat-archive');
  await until('!row("shared-copy")');
  assert.equal((await shared.resolve(local.id)).archived, true);
  assert.equal((await js('soduWorkAPI.piSession.archivedHistory()')).chats.some(row => row.id === local.id), true);
  assert.equal((await js('soduWorkAPI.piSession.restoreHistory("shared-copy")')).ok, true);
  await load(); await until('!!row("shared-copy")');
  report.cases.push('A second account reads and archives a local copy offline; the archive entry and restore IPC remain available.');
  await click('[data-chat-id="shared-copy"] + .ws-chat-actions .ws-chat-more');
  await click('.ws-chat-menu:not([hidden]) .ws-chat-delete');
  await until('!!document.querySelector(".app-confirm-dialog[open]")');
  assert.match(await js('document.querySelector(".app-confirm-detail").textContent'), /不删除云端原会话/);
  await click('.app-confirm-submit'); await until('!row("shared-copy")');
  await shared.close(); openShared();
  await shared.register([{ id: local.id, cached: true, title: 'Late source replay' }]);
  await load();
  assert.equal(await js('!!row("shared-copy")'), false);
  assert.equal((await shared.resolve(local.id)).deleted, true);
  assert.equal((await shared.store.messages(local.id)).unavailable, true);
  assert.equal(writes, 1);
  assert.equal(await js('!!row("cloud-execution:retained")'), true);
  assert.deepEqual(await js('errors'), []);
  fs.writeFileSync(path.join(output, 'local-copy-after-restart.png'), (await win.webContents.capturePage()).toPNG());
  report.cases.push('Deleting through the real sidebar persists across SQLite worker restart and late re-registration, with no Hub deletion or original/output removal.');
  report.ok = true;
}).catch(async error => {
  report.error = error.stack;
  if (win && !win.isDestroyed()) {
    report.renderer = await js('({notice:window.lastNotice,errors:window.errors,confirm:!!document.querySelector(".app-confirm-dialog"),menu:document.querySelector(".ws-chat-menu:not([hidden])")?.outerHTML})');
    fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  }
}).finally(async () => {
  await sync?.close(); await shared?.close(); win?.destroy(); server?.close();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
});
