'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: 'inherit',
  }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const output = process.argv[2];
  if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence path required');
  fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-local-pages-')));
  const report = { ok: false, cases: [], screenshots: [] }, calls = [];
  let win, revision = 1;
  const rows = Array.from({ length: 123 }, (_, i) => ({ id: 'saved-' + i, title: 'Saved ' + i, at: 123 - i, adapterId: 'pi' }));
  ipcMain.handle('pi-session-history', (_event, options) => {
    if (options?.source === 'account') return { ok: true, chats: [] };
    assert.equal(options?.source, 'local'); calls.push(options);
    const start = options.after ? rows.findIndex(row => row.id === options.after.id) + 1 : 0;
    const chats = rows.slice(start, start + options.limit), last = chats.at(-1);
    return { ok: true, chats, next: start + chats.length < rows.length ? { id: last.id, at: last.at } : null,
      localCatalog: { workspace: 'pagination-fixture', revision,
        ...(options.catalogRevision === revision ? {} : { items: rows.map(row => ({ id: row.id, historyAliasIds: [] })) }) } };
  });
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) {
    for (let i = 0; i < 150; i++) { if (await js(code)) return; await delay(30); }
    throw Error('Timed out: ' + code);
  }
  const count = 'document.querySelectorAll("#wsChats .ws-chat-row").length';
  const ready = '(()=>{const b=document.querySelector("#wsLocalHistoryActions button");return b&&!b.disabled})()';
  async function clickMore(expected) {
    await until(ready);
    const point = await js(`(()=>{const b=document.querySelector('#wsLocalHistoryActions button');
      b.scrollIntoView({block:'center'});if(!b.checkVisibility()||b.disabled)throw Error('Load more is unavailable');
      const r=b.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    const before = calls.length;
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    for (let i = 0; i < 150 && calls.length === before; i++) await delay(30);
    assert.ok(calls.length > before, 'The visible button must issue a real preload history request');
    await until(ready); await until(count + '===' + expected);
  }
  async function shot(name) {
    const file = path.join(output, name + '.png');
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); report.screenshots.push(file);
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1080, height: 820, webPreferences: {
      preload: path.join(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false,
      offscreen: true, backgroundThrottling: false,
    } });
    await win.loadFile(path.join(__dirname, 'fixtures/sidebar-projects.html'));
    await until(count + '===50'); await clickMore(100); await clickMore(123);
    assert.equal(await js('document.querySelector("#wsLocalHistoryActions").hidden'), true);
    for (let i = 0; i < 20; i++) rows.push({ id: 'older-' + i, title: 'Older import ' + i, at: -i - 1 });
    revision++;
    await js('WorkspaceShell.refreshConversationHistory()');
    await clickMore(123); await clickMore(143);
    assert.equal(await js('document.querySelector("#wsLocalHistoryActions").hidden'), true);
    report.cases.push('An exhausted 123-row history exposes a clickable Load more after older imports and reaches all 143 rows');
    const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.reload(); await loaded; await until(count + '===50'); await clickMore(100);
    rows.splice(25, 0, ...Array.from({ length: 20 }, (_, i) => ({ id: 'middle-' + i, title: 'Middle import ' + i, at: 98.5 - i / 100 })));
    revision++;
    await clickMore(143);
    assert.equal(await js('document.querySelector("#wsLocalHistoryActions").hidden'), false,
      'A restarted traversal remains visible even when the old final page has no next cursor');
    await js('document.querySelector("#wsLocalHistoryActions button").scrollIntoView({block:"center"});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await shot('restart-button');
    await clickMore(163);
    assert.equal(calls.at(-1).after, undefined, 'The actual click restarts from the first page');
    assert.equal(await js('new Set([...document.querySelectorAll("#wsChats .ws-chat")].map(row=>row.dataset.chatId)).size'), 163);
    assert.deepEqual(await js('errors'), []);
    report.cases.push('A catalog revision during append keeps the restart button visible and its mouse click loads records before the old cursor');
    report.ok = true;
  }).catch(async error => {
    report.error = error.stack; console.error(error.stack);
    if (win) await shot('failure').catch(() => {});
  }).finally(() => {
    report.calls = calls;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
