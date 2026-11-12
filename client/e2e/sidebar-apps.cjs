'use strict';
// Isolated native app views + production rail/open/permission joining. No user data or models.
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-sidebar-apps-'));
  app.setPath('userData', path.join(temp, 'profile')); app.on('window-all-closed', () => {});
  const windows = [], views = [], handlers = {};
  let host, server;
  const js = source => host.webContents.executeJavaScript(source.includes('await ') ? '(async()=>{' + source + '})()' : source);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async check => { for (let i = 0; i < 250; i++) { if (await check()) return; await delay(20); } throw Error('Sidebar app timed out'); };
  app.whenReady().then(async () => {
    server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>App fixture</title><textarea id="draft"></textarea><a id="popup" href="/second" target="_blank">Second page</a>'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    const plugin = require('../main/personal-plugins').create(app, { key: 'sidebar-app', name: '侧栏应用', description: 'Isolated fixture', version: '0.1.0', template: 'app', instructions: 'Fixture only',
      ui: { contributions: [{ id: 'app', title: '侧栏应用', slot: 'workspace.navigation', source: { type: 'external', url } }] } }).plugin;
    fs.writeFileSync(path.join(temp, 'host.html'), '<!doctype html><style>body{margin:0}#workspaceAppPanel{position:fixed;left:52px;right:0;top:0;bottom:0;display:none}#workspaceAppPanel.show{display:block}</style><div id="wsSidebarApps"></div>');
    fs.writeFileSync(path.join(temp, 'composer.html'), '<!doctype html><textarea id="draft">Composer draft</textarea>');
    require('../main/work-preview').install({ app,
      ipcMain: { handle(name, fn) { handlers[name] = fn; ipcMain.handle(name, fn); }, on: (...args) => ipcMain.on(...args) },
      BrowserWindow: Object.assign(function(options) { const win = new BrowserWindow(options); windows.push(win); return win; }, { fromWebContents: wc => BrowserWindow.fromWebContents(wc) }),
      WebContentsView: function(options) { const view = new WebContentsView(options); views.push(view); const load = view.webContents.loadFile.bind(view.webContents); view.webContents.loadFile = (file, options) => load(path.basename(file) === 'desk.html' ? path.join(temp, 'composer.html') : file, options); return view; },
      shell: { openExternal: async () => {} },
    });
    host = new BrowserWindow({ show: false, width: 1100, height: 750, webPreferences: { preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, sandbox: true } });
    host.webContents.on('console-message', details => console.log('renderer:', details.message));
    await host.loadFile(path.join(temp, 'host.html'));
    for (const file of ['components/panels/plugin-ui-host.js', 'components/panels/panels-apps.js', 'components/workspace/workspace-apps.js']) await js(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8') + '\n;void 0;');
    await js(`window.item=${JSON.stringify(plugin)};item.personal=false;item.installed=true;item.listed=true;item.permissions={canUse:true};
      window.fixtureScope='account-a';window.allowed=true;window.placed=true;window.installs=0;
      window.SoduWorkAPI={taskStorageKey:()=>fixtureScope,sidebarRecommendations:async()=>({items:placed?[{targetId:item.pluginId,surface:'sidebar',kind:'app'}]:[]}),pluginCatalog:async()=>{if(window.catalogGate)await catalogGate;return {items:[{...item,permissions:{canUse:allowed}},{...item,pluginId:'denied',permissions:{canUse:false}}]}}};
      SoduWorkAPI.setEnterprisePluginInstalled=async()=>{installs++;item.installed=true;return {ok:true}};
      window.WorkspaceHost={view:'',open(view,payload){this.view=view;return view==='sidebarapp'?WorkspaceSidebarApps.open(payload):WorkspaceSidebarApps.close()}};
      WorkspaceSidebarApps.mount();await WorkspaceSidebarApps.refresh();`);
    assert.equal(await js('document.querySelectorAll("[data-sidebar-app]").length'), 1);
    await js('document.querySelector("[data-sidebar-app]").click()');
    await until(() => views.length === 3 && views[0].getVisible());
    assert.equal(windows.length, 0, 'sidebar opening creates no new BrowserWindow');
    const [page, chrome, composer] = views;
    assert.equal(page.getBounds().x, 62, 'page respects host rail and app margin');
    assert.equal(chrome.getBounds().x, 52);
    assert.equal(await chrome.webContents.executeJavaScript('document.documentElement.dataset.embedded'), 'true');
    await until(() => !composer.webContents.isLoading());
    assert.ok(composer.webContents.getURL().endsWith('app-composer-launcher.html'));
    await handlers['work-preview-composer-mode-set']({ sender: composer.webContents }, { expanded: true });
    await handlers['work-preview-composer-mode-set']({ sender: composer.webContents }, { expanded: false });
    await page.webContents.executeJavaScript('draft.value="Page draft"');
    const tab = 'sidebar-app-' + plugin.pluginId.replace(/[^a-zA-Z0-9_-]+/g, '-') + '-app';
    await js('WorkspaceSidebarApps.close()');
    assert.ok(views.every(view => !view.getVisible()), 'all native app siblings hide on navigation');
    await js('soduWorkAPI.workPreview.resetEmbedded()');
    assert.equal(page.webContents.isDestroyed(), false, 'chat preview reset preserves cached application');
    await js('WorkspaceHost.open("sidebarapp",{pluginId:item.pluginId})');
    assert.equal(views.length, 3);
    assert.equal(await page.webContents.executeJavaScript('draft.value'), 'Page draft');
    assert.equal(await composer.webContents.executeJavaScript('draft.value'), 'Composer draft');
    await js('soduWorkAPI.workPreview.resetEmbedded()');
    assert.ok(views.every(view => !view.getVisible()), 'preview reset hides every retained application surface');
    await js('WorkspaceHost.open("sidebarapp",{pluginId:item.pluginId})');
    await js('soduWorkAPI.workPreview.setOcclusion({blocked:true})');
    assert.ok(views.every(view => !view.getVisible()), 'DOM modal covers all native siblings');
    await js('soduWorkAPI.workPreview.setOcclusion({blocked:false})');
    assert.equal(page.getVisible(), true);
    await handlers['work-preview-composer-mode-set']({ sender: composer.webContents }, { expanded: true });
    assert.ok(page.getBounds().x + page.getBounds().width <= composer.getBounds().x, 'pinned composer does not overlap app');
    host.setContentSize(900, 600);
    await until(() => chrome.getBounds().width === 848);
    assert.ok(composer.getBounds().x + composer.getBounds().width <= 900, 'resize stays inside content region');
    await page.webContents.executeJavaScript('popup.click()');
    await until(() => views.length === 4 && views[3].getVisible());
    assert.equal(windows.length, 0, 'popup stays in application tabs');
    await js('window.allowed=false;await WorkspaceSidebarApps.refresh()');
    await until(() => views.every(view => !view.webContents || view.webContents.isDestroyed()));
    assert.equal(host.isDestroyed(), false, 'permission removal never destroys main window');
    assert.equal(await js('document.querySelectorAll("[data-sidebar-app]").length'), 0);
    await js('allowed=true;item.installed=false;await WorkspaceSidebarApps.refresh();await WorkspaceHost.open("sidebarapp",{pluginId:item.pluginId})');
    assert.equal(await js('installs'), 1, 'uninstalled sidebar app uses the existing installation chain');
    const chrome2 = views[5];
    await until(() => !chrome2.webContents.isLoading());
    const state = await handlers['work-preview-chrome-action']({ sender: chrome2.webContents }, { action: 'state' });
    await handlers['work-preview-chrome-action']({ sender: chrome2.webContents }, { action: 'close', tabId: state.state.activeId });
    assert.equal(host.isDestroyed(), false, 'closing last tab preserves host');
    const beforeLateOpen = views.length;
    await js('window.catalogGate=new Promise(resolve=>window.releaseCatalog=resolve);window.pendingOpen=WorkspaceHost.open("sidebarapp",{pluginId:item.pluginId});void 0;');
    await js('WorkspaceSidebarApps.close();releaseCatalog();await pendingOpen;window.catalogGate=null;');
    assert.equal(views.length, beforeLateOpen, 'late directory response cannot open an app after navigation');
    await js('window.catalogGate=new Promise(resolve=>window.releaseCatalog=resolve);window.pendingRefresh=WorkspaceSidebarApps.refresh();void 0;');
    await js('fixtureScope="account-b";dispatchEvent(new Event("soduwork-data-scope-changed"))');
    await js('releaseCatalog();await pendingRefresh;window.catalogGate=null;');
    assert.equal(await js('document.querySelectorAll("[data-sidebar-app]").length'), 0);
    console.log(JSON.stringify({ ok: true, evidence: temp, cases: ['authorized administrator placements', 'in-place native open without windows', 'navigation and composer draft retention', 'modal occlusion', 'resize and pinned conversation', 'popup tabs', 'permission removal and last-tab cleanup', 'scope reset'], boundary: 'Fixture catalogs and renderer DOM actions, production application opening/native views/preloads. No real accounts, admin publication, models or native mouse claims.' }));
    host.destroy(); server.close(); app.quit();
  }).catch(error => { console.error(error.stack); try { host?.destroy(); server?.close(); } catch (_) {} app.exit(1); });
}
