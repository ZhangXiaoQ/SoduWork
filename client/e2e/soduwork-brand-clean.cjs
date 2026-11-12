'use strict';

// Real Electron context isolation and IPC, using temporary storage and inert handlers.
const electron = require('electron');
if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electron, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env });
  process.exit(result.status === null ? 1 : result.status);
}
const { app, BrowserWindow, ipcMain } = electron;
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-brand-electron-'));
app.setPath('userData', path.join(root, 'profile'));
const calls = [], report = { ok: false, cases: [] };
let win, plugin;
ipcMain.handle('pi-session-probe', (_event, adapter) => { calls.push(adapter); return { ok: true, adapter }; });
ipcMain.handle('personal-plugin-preflight', (_event, body) => ({ ok: true, body }));

async function run() {
  win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
  } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  await win.loadURL('data:text/html,<html lang="zh"><title>SoduWork bridge test</title></html>');
  const js = (source) => win.webContents.executeJavaScript(source);
  const probes = await js(`Promise.all([soduWorkAPI.conversationSession.probe('pi'), soduWorkAPI.conversationSession.probe('pi')])`);
  assert.deepEqual(probes[0], probes[1]);
  assert.deepEqual(calls, ['pi', 'pi']);
  report.cases.push('the canonical desktop bridge reaches the IPC handler');
  await js(`window.received=[]; window.off=soduWorkAPI.conversationSession.onEvent(x=>received.push(x.ref)); void 0;`);
  win.webContents.send('pi-session-event', { ref: 'fixture-event' });
  for (let i = 0; i < 100 && await js('received.length') < 1; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(await js('received'), ['fixture-event']);
  await js('off(); void 0;');
  win.webContents.send('pi-session-event', { ref: 'after-unsubscribe' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(await js('received'), ['fixture-event']);
  report.cases.push('the canonical event subscription receives once and unsubscribes cleanly');

  const bridgeCalls = [];
  ipcMain.handle('work-preview-app-request', (event, body) => {
    assert.equal(event.sender, plugin.webContents);
    bridgeCalls.push(body);
    return { ok: true, result: { conversationId: 'fixture-conversation' } };
  });
  plugin = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(__dirname, '../main/work-preview-app-preload.cjs'),
    contextIsolation: true, nodeIntegration: false, sandbox: true,
  } });
  await plugin.loadURL('data:text/html,<title>SoduWork web plugin</title>');
  const bridgeResult = await plugin.webContents.executeJavaScript(`(async () => ({
    first: await soduWorkAppBridge.conversation.open({ title: 'web plugin' }),
    second: await soduWorkAppBridge.context.get(),
    node: typeof require, ipc: typeof ipcRenderer,
    methods: Object.keys(soduWorkAppBridge).sort()
  }))()`);
  assert.deepEqual(bridgeResult.first, bridgeResult.second);
  assert.equal(bridgeResult.node, 'undefined');
  assert.equal(bridgeResult.ipc, 'undefined');
  assert.deepEqual(bridgeResult.methods,
    ['composer', 'context', 'conversation', 'directory', 'events', 'mcp',
      'notifications', 'request', 'requirements', 'settings', 'version']);
  assert.deepEqual(bridgeCalls.map((row) => row.method), ['conversation.open', 'context.get']);
  assert(bridgeCalls.every((row) => row.version === 1));
  assert.notEqual(bridgeCalls[0].id, bridgeCalls[1].id);
  report.cases.push('the web plugin receives one restricted SoduWork bridge under context isolation');
  report.ok = true;
}

app.whenReady().then(run).catch((error) => { report.error = error.stack; }).finally(() => {
  console.log(JSON.stringify(report));
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  if (win) win.destroy();
  if (plugin) plugin.destroy();
  app.exit(report.ok ? 0 : 1);
});
