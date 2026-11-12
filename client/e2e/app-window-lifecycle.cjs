'use strict';
// Native window lifecycle and production preload/IPC; no user profile or model.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 45000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
  const assert = require('node:assert/strict');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-app-lifecycle-'));
  const out = path.resolve(__dirname, '../../outputs/app-window-lifecycle-20261020');
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(temp, 'profile'));
  const report = { ok: false, cases: [], boundary: 'Isolated native Electron windows with production work-preview and preload IPC, loopback apps, minimal composer fixture. Replays the inline reset used by navigation; does not claim native mouse menu input, real accounts or model requests.' };
  const windows = [], views = [];
  let host, server;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label) => { for (let i = 0; i < 200; i++) { if (await check()) return; await delay(20); } throw Error('Timed out: ' + label); };
  const js = (wc, source) => wc.executeJavaScript(source);
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    fs.writeFileSync(path.join(temp, 'host.html'), '<!doctype html><title>Lifecycle owner</title>');
    fs.writeFileSync(path.join(temp, 'composer.html'), '<!doctype html><textarea id="draft"></textarea>');
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Isolated app</title><textarea id="draft"></textarea>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    require('../main/work-preview').install({ ipcMain,
      BrowserWindow: Object.assign(function (opts) {
        const win = new BrowserWindow(opts); windows.push(win); return win;
      }, { fromWebContents: wc => BrowserWindow.fromWebContents(wc) }),
      WebContentsView: function (opts) {
        const view = new WebContentsView(opts); views.push(view);
        const loadFile = view.webContents.loadFile.bind(view.webContents);
        view.webContents.loadFile = (file, query) => loadFile(path.basename(file) === 'desk.html' ? path.join(temp, 'composer.html') : file, query);
        return view;
      }, shell: { openExternal: async () => { throw Error('External navigation forbidden'); } } });
    host = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await host.loadFile(path.join(temp, 'host.html'));
    const invoke = expression => js(host.webContents, 'soduWorkAPI.workPreview.' + expression);
    const open = name => invoke('showDetached(' + JSON.stringify({ tabId: name, url: base + '/' + name, label: name }) + ')');
    const inline = ref => invoke('show(' + JSON.stringify({ tabId: 'inline', ref, url: base + '/inline', bounds: { x: 0, y: 0, width: 400, height: 300 } }) + ')');
    await inline('initial'); const originalInline = views[0].webContents;
    assert.equal((await open('app-one')).ok, true);
    assert.equal((await open('app-two')).ok, true);
    const [one, two] = windows;
    await until(() => windows.length === 2 && windows.every(win => win.isVisible()), 'two native apps visible');
    const [chromeOne, appOne, composerOne] = one.contentView.children;
    const [chromeTwo, appTwo, composerTwo] = two.contentView.children;
    const appOneContents = appOne.webContents, chromeTwoContents = chromeTwo.webContents;
    await until(() => appOne.webContents.getTitle() === 'Isolated app' && appTwo.webContents.getTitle() === 'Isolated app', 'apps loaded');
    await until(() => !composerOne.webContents.isLoading() && !composerTwo.webContents.isLoading(), 'composers loaded');
    for (const composer of [composerOne, composerTwo]) {
      assert.ok(composer.webContents.getURL().endsWith('app-composer-launcher.html'), 'unused composer starts with lightweight launcher');
      await js(composer.webContents, 'document.querySelector("button").click()');
      await until(() => composer.webContents.getURL().includes('/composer.html') && !composer.webContents.isLoading(), 'conversation loads on demand');
      await js(composer.webContents, 'soduWorkAPI.workPreview.composerSetMode({expanded:false})');
    }
    await js(appOne.webContents, 'window.lifecycleMarker="one";draft.value="app-one draft"');
    await js(appTwo.webContents, 'window.lifecycleMarker="two";draft.value="app-two draft"');
    await js(composerOne.webContents, 'draft.value="composer-one draft"');
    await js(composerTwo.webContents, 'draft.value="composer-two draft"');
    for (const page of ['plugins', 'conversation-one', 'home', 'conversation-two', 'apps']) {
      assert.equal((await invoke('resetEmbedded()')).ok, true);
      assert.equal(one.isDestroyed(), false); assert.equal(two.isDestroyed(), false);
      assert.equal(one.isVisible(), true); assert.equal(two.isVisible(), true);
      assert.equal(await js(appOne.webContents, 'lifecycleMarker+":"+draft.value'), 'one:app-one draft');
      assert.equal(await js(appTwo.webContents, 'lifecycleMarker+":"+draft.value'), 'two:app-two draft');
      assert.equal(await js(composerOne.webContents, 'draft.value'), 'composer-one draft');
      assert.equal(await js(composerTwo.webContents, 'draft.value'), 'composer-two draft');
      await inline(page); await invoke('hide()');
    }
    assert.equal(originalInline.isDestroyed(), true);
    report.cases.push('Two real application windows and both composer drafts survive repeated production inline resets/hides; inline previews are reclaimed.');
    const oldCount = views.length;
    assert.equal((await open('app-one')).reused, true);
    assert.equal(windows.length, 2); assert.equal(views.length, oldCount);
    assert.equal(await js(appOne.webContents, 'draft.value'), 'app-one draft');
    report.cases.push('Opening an already open app reuses the exact native window and WebContents without reloading its state.');
    one.close(); await until(() => one.isDestroyed() && appOneContents.isDestroyed(), 'first app closed');
    assert.equal(two.isDestroyed(), false); assert.equal(two.isVisible(), true);
    assert.equal(await js(composerTwo.webContents, 'draft.value'), 'composer-two draft');
    report.cases.push('Closing one native app closes only its surfaces; the second app and composer remain intact.');
    await invoke('destroy("")');
    await until(() => two.isDestroyed() && chromeTwoContents.isDestroyed(), 'explicit full cleanup');
    report.cases.push('Explicit owner teardown still reclaims all remaining apps, chrome and composer surfaces.');
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(async () => {
    if (host && !host.isDestroyed()) host.destroy();
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    for (const view of views) if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  });
}
