'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { appInfo, install } = require('../main/app-menu-info.cjs');
// These assertions exercise Chinese native dialogs explicitly; the product
// default remains English and has independent locale coverage.
test.beforeEach(() => require('../main/native-locale.cjs').setLocale('zh-CN'));

function fixture({ version = '1.12.52', showMessageBox, quit, getRendererRoot, shell, openNewConversation, releaseNotes } = {}) {
  const root = path.resolve(__dirname, '..'), handlers = new Map(), owners = new Map();
  const dialogs = [], exits = [];
  const app = { getAppPath: () => root, getVersion: () => version };
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const controller = install({ app, ipcMain, getRendererRoot, shell, openNewConversation, releaseNotes, BrowserWindow: { fromWebContents: wc => owners.get(wc) },
    dialog: { showMessageBox: async (owner, options) => {
      dialogs.push({ owner, options });
      return showMessageBox ? showMessageBox(owner, options) : { response: 0 };
    } }, quit: reason => { exits.push(reason); if (quit) quit(reason); } });
  function owner(file = pathToFileURL(path.join(root, 'desk.html')).href) {
    const wc = { url: file, destroyed: false, getURL() { return this.url; }, isDestroyed() { return this.destroyed; } };
    wc.mainFrame = { url: file };
    const window = { webContents: wc, destroyed: false, isDestroyed() { return this.destroyed; } };
    owners.set(wc, window);
    return { window, event: { sender: wc, senderFrame: wc.mainFrame } };
  }
  return { handlers, dialogs, exits, owner, app, controller };
}

test('application metadata uses the running version and only bundled published history at or below it', () => {
  const current = appInfo({ getVersion: () => '1.12.52' });
  assert.equal(current.name, 'SoduWork');
  assert.equal(current.version, '1.12.52');
  assert.equal(current.website, require('../main/distribution.cjs').current().hubOrigin);
  assert.deepEqual(current.releaseHistory.map(row => row.version), ['1.12.52', '1.12.51']);
  assert.equal(current.releaseHistory[1].status, 'withdrawn');
  assert.ok(current.releaseHistory.every(row => row.date === '2026-10-01' && !('source' in row)));
  const old = appInfo({ getVersion: () => '1.12.51' });
  assert.deepEqual(old.releaseHistory.map(row => row.version), ['1.12.51']);
  assert.deepEqual(appInfo({ getVersion: () => '1.12.50' }).releaseHistory, []);
  assert.deepEqual(appInfo({ getVersion: () => 'unversioned' }).releaseHistory, []);
  current.releaseHistory[0].notes.push('renderer-local modification');
  assert.equal(appInfo({ getVersion: () => '1.12.52' }).releaseHistory[0].notes.includes('renderer-local modification'), false);
});

test('real preload exposes only the two narrow menu invocations and reaches the production handlers', async () => {
  const f = fixture(), requester = f.owner(), exposed = {}, calls = [];
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invoke = async (channel, ...args) => {
    calls.push({ channel, args }); return f.handlers.get(channel)(requester.event, ...args);
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../preload.js'), 'utf8'), {
    require: id => { assert.equal(id, 'electron'); return { ipcRenderer, webUtils: {},
      contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } } }; },
  });
  assert.equal((await exposed.soduWorkAPI.getAppInfo('ignored-url')).website, require('../main/distribution.cjs').current().hubOrigin);
  assert.deepEqual(await exposed.soduWorkAPI.requestAppQuit({ force: true }), { ok: true, canceled: true });
  assert.deepEqual(calls, [{ channel: 'app-info', args: [] }, { channel: 'app-request-quit', args: [] }]);
  assert.deepEqual(f.exits, []);
});

test('quit defaults to continuing work and requires an explicit confirmation response', async () => {
  const f = fixture(), requester = f.owner();
  assert.deepEqual(await f.handlers.get('app-request-quit')(requester.event), { ok: true, canceled: true });
  const { options, owner } = f.dialogs[0];
  assert.equal(owner, requester.window);
  assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0);
  assert.match(options.detail, /本机.*后台工作会停止/);
  assert.deepEqual(f.exits, []);
});

test('renderer and native help follow the current installation Hub without crossing profiles', async () => {
  const endpoint = require('../main/hub-endpoint.cjs'), urls = [];
  const f = fixture({ shell: { openExternal: async url => urls.push(url) } });
  const other = fixture(), requester = f.owner();
  f.app.isPackaged = other.app.isPackaged = true;
  endpoint.initialize(f.app, {}, { hubOrigin: 'https://tenant-a.invalid:9443' });
  endpoint.initialize(other.app, {}, { hubOrigin: 'https://tenant-b.invalid' });
  assert.equal(f.handlers.get('app-info')(requester.event).website, 'https://tenant-a.invalid:9443');
  await f.controller.nativeCommand('website', requester.window);
  endpoint.initialize(f.app, {}, { hubOrigin: 'http://127.0.0.1:8765' });
  await f.controller.nativeCommand('website', requester.window);
  assert.deepEqual(urls, ['https://tenant-a.invalid:9443', 'http://127.0.0.1:8765']);
  assert.equal(appInfo(other.app).website, 'https://tenant-b.invalid');
});

test('a Hub switch during release history loading does not return the retired website', async () => {
  let finish;
  const endpoint = require('../main/hub-endpoint.cjs');
  const f = fixture({ releaseNotes: { list: () => new Promise(resolve => { finish = resolve; }) } });
  f.app.isPackaged = true;
  endpoint.initialize(f.app, {}, { hubOrigin: 'https://tenant-before.invalid' });
  const request = f.handlers.get('app-info')(f.owner().event);
  endpoint.initialize(f.app, {}, { hubOrigin: 'https://tenant-after.invalid:9443' });
  finish({ releases: [] });
  assert.equal((await request).website, 'https://tenant-after.invalid:9443');
});

test('concurrent menu requests share one confirmation and call normal quit once', async () => {
  let respond;
  const f = fixture({ showMessageBox: () => new Promise(resolve => { respond = resolve; }) });
  const request = f.handlers.get('app-request-quit');
  const one = request(f.owner().event), two = request(f.owner().event);
  await Promise.resolve();
  assert.equal(f.dialogs.length, 1);
  respond({ response: 1 });
  assert.deepEqual(await one, { ok: true, canceled: false });
  assert.deepEqual(await two, { ok: true, canceled: false });
  assert.deepEqual(f.exits, ['app-menu']);
  await request(f.owner().event);
  assert.equal(f.dialogs.length, 1); assert.equal(f.exits.length, 1);
});

test('remote pages, previews, subframes and detached windows cannot read or invoke the application menu', async () => {
  const f = fixture(), valid = f.owner();
  const outside = pathToFileURL(path.resolve(__dirname, 'desk.html')).href;
  const remote = f.owner('https://example.com/desk.html').event;
  const preview = f.owner(outside).event;
  const frame = { ...valid.event, senderFrame: { url: valid.event.sender.getURL() } };
  const destroyed = f.owner(); destroyed.window.destroyed = true;
  const detached = f.owner(); detached.window.webContents = {};
  for (const event of [remote, preview, frame, destroyed.event, detached.event]) {
    assert.throws(() => f.handlers.get('app-info')(event), /only available/);
    await assert.rejects(f.handlers.get('app-request-quit')(event), /only available/);
  }
  assert.equal(f.dialogs.length, 0); assert.equal(f.exits.length, 0);
});

test('closing or navigating the requesting window while its confirmation is open cancels exit', async () => {
  for (const invalidate of [
    requester => { requester.window.destroyed = true; },
    requester => { requester.event.sender.url = requester.event.senderFrame.url = 'https://example.com/'; },
  ]) {
    let respond;
    const f = fixture({ showMessageBox: () => new Promise(resolve => { respond = resolve; }) }), requester = f.owner();
    const pending = f.handlers.get('app-request-quit')(requester.event);
    await Promise.resolve(); invalidate(requester); respond({ response: 1 });
    assert.deepEqual(await pending, { ok: true, canceled: true });
    assert.deepEqual(f.exits, []);
  }
});

test('only the current renderer root and packaged entry files are trusted, never retired roots or nested files', async () => {
  const firstRoot = path.resolve(__dirname, 'fixture-renderer-v1'), secondRoot = path.resolve(__dirname, 'fixture-renderer-v2');
  let activeRoot = firstRoot;
  const f = fixture({ getRendererRoot: () => activeRoot }), info = f.handlers.get('app-info');
  const old = f.owner(pathToFileURL(path.join(firstRoot, 'desk.html')).href);
  assert.equal(info(old.event).version, '1.12.52');
  assert.equal(info(f.owner(pathToFileURL(path.join(firstRoot, 'index.html')).href).event).name, 'SoduWork');
  const nested = f.owner(pathToFileURL(path.join(firstRoot, 'preview', 'desk.html')).href);
  assert.throws(() => info(nested.event), /only available/);
  await assert.rejects(f.handlers.get('app-request-quit')(nested.event), /only available/);
  activeRoot = secondRoot;
  assert.throws(() => info(old.event), /only available/);
  await assert.rejects(f.handlers.get('app-request-quit')(old.event), /only available/);
  assert.equal(info(f.owner(pathToFileURL(path.join(secondRoot, 'desk.html')).href).event).name, 'SoduWork');
  assert.equal(info(f.owner().event).name, 'SoduWork');
  activeRoot = 'relative-renderer-root';
  assert.throws(() => info(f.owner(pathToFileURL(path.resolve(activeRoot, 'desk.html')).href).event), /only available/);
  assert.equal(f.dialogs.length, 0);
});

test('retiring a renderer root while its exit dialog is open invalidates that pending request', async () => {
  let activeRoot = path.resolve(__dirname, 'fixture-renderer-v1'), respond;
  const f = fixture({ getRendererRoot: () => activeRoot,
    showMessageBox: () => new Promise(resolve => { respond = resolve; }) });
  const requester = f.owner(pathToFileURL(path.join(activeRoot, 'desk.html')).href);
  const pending = f.handlers.get('app-request-quit')(requester.event);
  await Promise.resolve();
  activeRoot = path.resolve(__dirname, 'fixture-renderer-v2');
  respond({ response: 1 });
  assert.deepEqual(await pending, { ok: true, canceled: true });
  assert.deepEqual(f.exits, []);
});

test('dialog errors and canceled requests leave the menu able to ask again', async () => {
  let attempt = 0;
  const f = fixture({ showMessageBox: async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('dialog unavailable');
    return { response: attempt === 2 ? 0 : 1 };
  } });
  const request = () => f.handlers.get('app-request-quit')(f.owner().event);
  await assert.rejects(request(), /dialog unavailable/);
  assert.equal((await request()).canceled, true);
  assert.equal((await request()).canceled, false);
  assert.deepEqual(f.exits, ['app-menu']);
});

test('quit failure remains an error and does not permanently mark the application as quitting', async () => {
  let attempt = 0;
  const f = fixture({ showMessageBox: async () => ({ response: 1 }),
    quit: () => { if (++attempt === 1) throw new Error('quit failed'); } });
  const request = () => f.handlers.get('app-request-quit')(f.owner().event);
  await assert.rejects(request(), /quit failed/);
  assert.equal((await request()).canceled, false);
  assert.equal(f.dialogs.length, 2);
});

test('legacy renderer fallback shows real help in its current window and reuses normal navigation and confirmed exit', async () => {
  const urls = []; let newConversations = 0;
  const f = fixture({ shell: { openExternal: async url => urls.push(url) }, openNewConversation: () => { newConversations++; } });
  const requester = f.owner();
  for (const command of ['about', 'history']) assert.equal(await f.controller.nativeCommand(command, requester.window), true);
  assert.equal(newConversations, 0);
  assert.ok(f.dialogs.every(row => row.owner === requester.window));
  assert.match(f.dialogs[0].options.detail, /SoduWork 1\.12\.52/);
  assert.match(f.dialogs[1].options.detail, /1\.12\.51.*已撤回/);
  await f.controller.nativeCommand('website', requester.window);
  assert.deepEqual(urls, [require('../main/distribution.cjs').current().hubOrigin]);
  await f.controller.nativeCommand('new', requester.window); assert.equal(newConversations, 1);
  assert.equal(await f.controller.nativeCommand('arbitrary-command', requester.window), false);
  assert.equal((await f.controller.nativeCommand('quit', requester.window)).canceled, true);
  assert.deepEqual(f.exits, []);
  const remote = f.owner('https://example.com/');
  await assert.rejects(f.controller.nativeCommand('website', remote.window), /only available/);
  assert.equal(urls.length, 1); // Rejected remote sender cannot open another URL.
});

test('native fallback and renderer exit requests share the same confirmation and quit exactly once', async () => {
  let respond;
  const f = fixture({ showMessageBox: () => new Promise(resolve => { respond = resolve; }) }), requester = f.owner();
  const first = f.controller.nativeCommand('quit', requester.window), second = f.handlers.get('app-request-quit')(requester.event);
  await Promise.resolve(); assert.equal(f.dialogs.length, 1);
  respond({ response: 1 });
  assert.equal((await first).canceled, false); assert.equal((await second).canceled, false);
  assert.deepEqual(f.exits, ['app-menu']);
});

test('menu and tray reuse the existing normal quit path including tray cleanup and exit intent', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
  const source = main.match(/function _quitSoduWork\(reason\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source);
  assert.match(main, /app-menu-info\.cjs'\)\.install\(\{ app, ipcMain, BrowserWindow, dialog, shell,[\s\S]*?quit: _quitSoduWork, getRendererRoot: rendererRoot/);
  assert.match(main, /click: \(\) => _quitSoduWork\('tray'\)/);
  const calls = [], ctx = { tray: { destroy: () => calls.push('tray-destroy') },
    _lifecycleDiagnostics: { setExitReason: reason => calls.push(reason) }, app: { quit: () => calls.push('quit') } };
  vm.runInNewContext(source + '\n_quitSoduWork("app-menu");', ctx);
  assert.deepEqual(calls, ['tray-destroy', 'app-menu', 'quit']);
  assert.equal(ctx.tray, null);
});
