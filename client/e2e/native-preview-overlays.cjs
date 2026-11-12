'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timeout = setTimeout(() => { child.kill(); process.exitCode = 1; }, 45000);
  child.on('exit', code => { clearTimeout(timeout); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
  const { pathToFileURL } = require('node:url'), assert = require('node:assert/strict');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-overlay-preview-'));
  const out = path.resolve(__dirname, '../../outputs/native-preview-overlays-20261014'); fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', path.join(root, 'profile')); app.on('window-all-closed', () => {});
  const report = { ok: false, cases: [], errors: [], occlusionUpdates: 0 }, views = [], visibility = [];
  let win, server;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  const visible = () => views.filter(view => view.webContents && !view.webContents.isDestroyed() && view.getVisible());
  const until = async (fn, label) => { for (let i = 0; i < 150; i++) { if (await fn()) return; await sleep(30); } throw Error('Timed out: ' + label); };
  app.whenReady().then(async () => {
    require('../main/work-preview').install({ BrowserWindow,
      ipcMain: { handle(name, handler) { ipcMain.handle(name, (...args) => {
        if (name === 'work-preview-occlusion') report.occlusionUpdates++;
        return handler(...args);
      }); }, on: (...args) => ipcMain.on(...args) },
      WebContentsView: function(options) {
        const view = new WebContentsView(options), set = view.setVisible.bind(view);
        view.setVisible = value => { visibility.push([views.indexOf(view), value]); set(value); };
        views.push(view); return view;
      }, shell: { openExternal: async () => { throw Error('No external navigation'); } } });
    ipcMain.handle('pi-session-plugin-draft', async () => ({ ok: true, body: { name: 'Fixture plugin', version: '1.0.0' } }));
    server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Live preview</title><input id="editor" value="retained"><p>Native browser</p>'); });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + server.address().port;
    const client = path.resolve(__dirname, '..'), href = name => pathToFileURL(path.join(client, name)).href;
    const css = ['theme/variables.css','components/panels/panels-chat.css','components/panels/code-workbench.css',
      'components/panels/panels-capabilities.css','components/panels/panels-capability-plugins.css'];
    const scripts = ['components/panels/chat-output-links.js','components/panels/chat-dom-patch.js', 'components/panels/panels-chat-tools.js',
      'components/panels/chat-workspace-info.js','components/panels/chat-workspace-split.js',
      'components/workspace/native-preview-overlays.js','components/panels/chat-workspace-controls.js', 'components/panels/panels-chat-workspace.js',
      'components/panels/panels-chat-chrome.js','components/panels/plugin-catalog-format.js','components/panels/panels-plugin-maker-utils.js',
      'components/panels/panels-capability-plugins.js','components/panels/panels-capabilities.js'];
    const host = path.join(root, 'host.html');
    fs.writeFileSync(host, '<!doctype html><meta charset="utf-8">' + css.map(file => '<link rel="stylesheet" href="' + href(file) + '">').join('') +
      '<style>body{margin:0}.nchat{height:100vh}.nchat-stage{height:100%;display:flex}.nchat-main{flex:1;min-width:0} .fixture-popup{position:fixed;inset:120px 30px auto auto;width:400px;height:170px;background:white;z-index:2500}.fixture-hidden{display:none!important}</style>' +
      '<main class="nchat" id="chat"><div class="nchat-stage"><div class="nchat-main"><input id="composer"><div id="stream"></div></div></div></main>' +
      '<script>window.SoduWorkAPI={preflightPluginDraft:async body=>({manifest:body,capabilities:{hasWorkflow:false},workflow:{nodes:[]}})};window.errors=[];addEventListener("error",e=>errors.push(e.message));</script>' +
      scripts.map(file => '<script src="' + href(file) + '"></script>').join(''));
    win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: {
      preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await win.loadFile(host);
    await js('chat.querySelector(".nchat-main").insertAdjacentHTML("afterbegin",ChatChrome.header());ChatChrome.bind(chat,()=>({ref:"fixture"}));ChatWorkbench.bind(chat,()=>({ref:"fixture"}));ChatWorkbench.openLink(' + JSON.stringify(url) + ');void 0;');
    await until(() => visible().length === 1 && visible()[0].webContents.getTitle() === 'Live preview', 'native page');
    const browser = visible()[0];
    await browser.webContents.executeJavaScript('editor.value="unsaved input"');
    const click = async selector => {
      const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
      await sleep(250);
    };
    const boundsMatch = async () => {
      const expected = await js(`(()=>{const r=document.querySelector('[data-wb-native]').getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}})()`);
      return JSON.stringify(browser.getBounds()) === JSON.stringify(expected);
    };
    const settleSplit = () => js(`Promise.all([...document.querySelectorAll('.nchat-main,.ncw')]
      .flatMap(element=>element.getAnimations()).map(animation=>animation.finished.catch(()=>{})))`);
    await settleSplit();
    await until(boundsMatch, 'initial native preview bounds after split animation');
    const originalWidth = browser.getBounds().width;
    await click('[data-chat-summary]');
    await until(boundsMatch, 'summary keeps native preview bounds aligned');
    assert.equal(browser.getBounds().width, originalWidth, 'summary must not reserve a blank column');
    report.summaryGeometry = await js(`Array.from(document.querySelectorAll('.nchat,.nchat-stage,.nchat-summary,[data-wb-native]'),e=>({name:e.className,rect:e.getBoundingClientRect().toJSON(),position:getComputedStyle(e).position}))`);
    await until(() => browser.getVisible(), 'summary under chat controls leaves adjacent native preview visible');
    assert.equal(await js('document.querySelector(".nchat-summary").hidden'), false);
    win.setSize(920, 800);
    await until(() => !browser.getVisible(), 'narrow summary overlay hides intersecting native preview');
    await click('[data-chat-summary-close]');
    await until(() => browser.getVisible(), 'closing overlay restores native preview');
    win.setSize(1200, 800);
    await settleSplit();
    await until(boundsMatch, 'native preview retains its full width after summary closes');
    assert.equal(browser.getBounds().width, originalWidth);
    assert.equal(await browser.webContents.executeJavaScript('editor.value'), 'unsaved input');
    assert.equal(views.length, 1, 'summary toggles preserve the mounted native page');
    report.cases.push('Summary reserves no preview width; narrow overlay hides only the intersecting native page and closing it restores bounds and unsaved input.');
    await js('openConversationPluginDraft("fixture","plugin.json")');
    await until(() => visible().length === 0, 'production plugin install modal');
    assert.equal(await js('capModalLayer.hidden'), false);
    assert.equal(await js('capModalTitle.textContent'), '安装插件');
    await js('capLocalOnly.focus();void 0;');
    const updates = report.occlusionUpdates, changes = visibility.length;
    await js('for(let i=0;i<100;i++){stream.append(document.createElement("span"));stream.lastChild.textContent="tick "+i;}void 0;');
    await sleep(120);
    assert.equal(visibility.length, changes); assert.equal(report.occlusionUpdates, updates);
    assert.equal(await js('document.activeElement.id'), 'capLocalOnly');
    report.cases.push('The actual plugin-install dialog hides the native page; 100 unrelated mutations cause no visibility IPC, flicker or DOM focus loss');
    await js('window.nested=document.createElement("dialog");nested.innerHTML="<button>Confirm</button>";document.body.append(nested);nested.showModal();capModalClose.click();void 0;');
    await sleep(80); assert.equal(visible().length, 0);
    await js('nested.close();nested.remove();void 0;');
    await until(() => browser.getVisible(), 'last modal closes');
    assert.equal(await browser.webContents.executeJavaScript('editor.value'), 'unsaved input');
    const beforeReopen = views.length;
    await js('openConversationPluginDraft("fixture","plugin.json")');
    await until(() => !browser.getVisible(), 'persistent hidden layer reopened');
    await js('capLocalCancel.click();void 0;'); await until(() => browser.getVisible(), 'plugin canceled');
    assert.equal(views.length, beforeReopen);
    report.cases.push('Nested dialogs and reopening the same hidden plugin layer restore the existing page exactly once and keep unsaved input');
    await js('window.popup=document.createElement("div");popup.className="fixture-popup fixture-hidden";popup.setAttribute("role","dialog");popup.innerHTML="<button>Settings</button>";document.body.append(popup);void 0;');
    await sleep(60); assert.equal(browser.getVisible(), true);
    await js('popup.classList.remove("fixture-hidden");void 0;'); await until(() => !browser.getVisible(), 'CSS popup');
    await js('popup.removeAttribute("role");void 0;'); await until(() => browser.getVisible(), 'popup role removed');
    await js('popup.setAttribute("data-native-preview-overlay","");void 0;'); await until(() => !browser.getVisible(), 'explicit overlay marker');
    await js('popup.removeAttribute("data-native-preview-overlay");void 0;'); await until(() => browser.getVisible(), 'explicit overlay marker removed');
    await js('popup.classList.add("wc-popover");void 0;'); await until(() => !browser.getVisible(), 'legacy composer popup');
    await js('popup.style.left="0";popup.style.right="auto";popup.style.width="100px";void 0;');
    await until(() => browser.getVisible(), 'non-overlapping popup leaves preview visible');
    await js('popup.removeAttribute("style");popup.classList.remove("wc-popover");void 0;');
    await js('popup.setAttribute("role","dialog");void 0;'); await until(() => !browser.getVisible(), 'popup role restored');
    await js('popup.style.visibility="hidden";void 0;'); await until(() => browser.getVisible(), 'CSS popup hidden');
    await js('popup.remove();document.documentElement.setAttribute("data-window-menu-overlay","");void 0;');
    await until(() => !browser.getVisible(), 'window menu');
    await js('document.documentElement.removeAttribute("data-window-menu-overlay");window.drawer=document.createElement("div");drawer.className="ntool-drawer fixture-popup";document.body.append(drawer);void 0;');
    await sleep(60); assert.equal(browser.getVisible(), false);
    await js('drawer.remove();void 0;'); await until(() => browser.getVisible(), 'drawer removed');
    report.cases.push('CSS visibility, non-modal overlapping popups, window menus and tool drawers share the same occlusion behavior');
    await js('window.plugin=document.createElement("div");plugin.className="pui-layer fixture-popup";const pluginSlot=document.createElement("div");pluginSlot.dataset.nativePreviewTab="plugin-native";pluginSlot.style.cssText="width:300px;height:130px";plugin.append(pluginSlot);document.body.append(plugin);void 0;');
    await sleep(60);
    assert.equal((await js('soduWorkAPI.workPreview.show(' + JSON.stringify({ tabId: 'plugin-native', url,
      bounds: { x: 760, y: 120, width: 300, height: 130 } }) + ')')).ok, true);
    await until(() => visible().length === 1 && visible()[0] !== browser, 'plugin owns native browser');
    await js('window.confirmation=document.createElement("dialog");confirmation.textContent="Confirm";document.body.append(confirmation);confirmation.showModal();void 0;');
    await until(() => visible().length === 0, 'nested native plugin confirmation');
    await js('confirmation.close();confirmation.remove();void 0;'); await until(() => visible().length === 1, 'nested confirmation closes');
    await js('plugin.remove();soduWorkAPI.workPreview.destroy("plugin-native");void 0;'); await until(() => browser.getVisible(), 'plugin removed restores workspace');
    report.cases.push('A plugin overlay can host its own native browser; a nested confirmation hides it and closing restores the workspace browser');
    await js('openConversationPluginDraft("fixture","plugin.json")'); await until(() => !browser.getVisible(), 'modal before closing panel');
    await js('document.querySelector("[data-wb-close]").click();capLocalCancel.click();void 0;'); await sleep(100);
    assert.equal(visible().length, 0); assert.equal(await js('ChatWorkbench.state().open'), false);
    report.cases.push('Closing the right panel while a dialog is open cannot resurrect the browser when the dialog closes');
    report.errors = await js('errors'); assert.deepEqual(report.errors, []); report.visibilityChanges = visibility.length; report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    win?.destroy(); server?.close(); app.exit(report.ok ? 0 : 1);
  });
}
