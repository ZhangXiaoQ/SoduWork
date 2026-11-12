'use strict';
// Production menu, WorkspaceShell, preload and app-info/quit handlers. Navigation,
// external launch and native quit confirmation are isolated to protect user work.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), out = path.resolve(client, '../outputs/window-menu-20261001');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-window-menu-'));
  const report = { ok: false, boundary: 'Real Electron pointer/keyboard, production renderer/preload/main menu handlers. Test-only navigation/external launch/quit confirmation; no business calls.', cases: [], errors: [] };
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(tmp, 'profile'));
  let win, server, quitCount = 0, confirmCount = 0, answer = 0; const external = [], titlebarThemes = [];
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) { for (let i = 0; i < 100; i++) { if (await js(code)) return; await delay(30); } throw Error('Timed out: '+code); }
  async function click(selector) {
    const p = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.checkVisibility())throw Error('Unavailable '+${JSON.stringify(selector)});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded '+${JSON.stringify(selector)});return{x,y}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...p });
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...p, button: 'left', clickCount: 1 });
    await delay(90);
  }
  function key(keyCode, modifiers = []) { keyCode = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' }[keyCode] || keyCode; for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode, modifiers }); }
  async function shot(name) { await delay(120); fs.writeFileSync(path.join(out, name+'.png'), (await win.webContents.capturePage()).toPNG()); }
  async function showHelp(kind) { await click('[data-window-menu="help"]'); await click('[data-window-command="'+kind+'"]'); await until(`document.querySelector('.wm-dialog').open && !document.querySelector('.wm-dialog [role=status]')`); }
  async function geometry() {
    return js(`(()=>{const r=s=>{const e=document.querySelector(s),b=e.getBoundingClientRect();return{left:b.left,right:b.right,top:b.top,bottom:b.bottom,visible:e.checkVisibility()}};return{bar:r('.window-menu'),side:r('.ws-side'),content:r('#composePanel'),rail:r('.ws-rail'),resizer:r('#wsResizer'),draft:document.querySelector('#draft').value,scroll:document.querySelector('#wsSideScroll').scrollTop,overflow:document.documentElement.scrollWidth>innerWidth+1}})()`);
  }
  app.whenReady().then(async () => {
    require('../main/work-preview').install({ ipcMain, BrowserWindow, WebContentsView, shell: { openExternal: async () => {} } });
    server = require('node:http').createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Menu preview fixture</title><h1>网页预览</h1><input id="previewDraft" value="页面内容保留"><script>window.loadedOnce=Date.now()</script>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const previewUrl = 'http://127.0.0.1:' + server.address().port + '/preview';
    ipcMain.handle('pi-session-history', require('./fixtures/history-ipc.cjs').create(() => ({ ok: true, chats: [] })));
    ipcMain.handle('open-external', (_e, url) => { external.push(url); return { ok: true }; });
    const testApp = { getAppPath: () => tmp, getVersion: () => require('../package.json').version,
      isPackaged: false, getPath: key => key === 'userData' ? path.join(tmp, 'profile') : tmp };
    const hubEndpoint = require('../main/hub-endpoint.cjs');
    hubEndpoint.initialize(testApp, {});
    assert.equal(hubEndpoint.prepare(testApp, 'https://isolated-menu-hub.example:8443').ok, true);
    const titlebar = require('../main/workspace-titlebar.cjs').create({ app: testApp, ipcMain, BrowserWindow, Menu: electron.Menu });
    require('../main/app-menu-info.cjs').install({ app: testApp, ipcMain, BrowserWindow,
      dialog: { showMessageBox: async (_parent, options) => { confirmCount++; assert.equal(options.defaultId, 0); return { response: answer }; } }, quit: reason => { assert.equal(reason, 'app-menu'); quitCount++; } });
    const base = pathToFileURL(client+path.sep).href;
    const fixture = '<!doctype html><html data-desk-panel="workspace" data-workspace-view="create" data-workspace-layout="conversation" data-theme="azure"><meta charset="utf-8"><base href="'+base+'">'+
      ['theme/variables.css','components/workspace/workspace-shell.css','components/workspace/window-menu.css'].map(file=>'<link rel="stylesheet" href="'+file+'">').join('')+
      '<style>*{box-sizing:border-box}body{margin:0;font:14px var(--font-ui)}#composePanel{padding:24px}#draft{width:90%;height:140px;margin-top:30px;border:1px solid var(--line);border-radius:14px;padding:16px;font:inherit;background:var(--bg-0);color:var(--ink)}</style><div id="composePanel" class="show"><h2>对话</h2><p>正在编辑的会话保持原位</p><textarea id="draft" aria-label="草稿"></textarea></div></html>';
    fs.writeFileSync(path.join(tmp, 'desk.html'), fixture);
    const windowChrome = titlebar.windowOptions(client);
    win = new BrowserWindow({ show: false, width: 1280, height: 800, ...windowChrome, webPreferences: { preload: path.join(client, 'preload.js'), offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    titlebar.attach(win, windowChrome);
    const setNativeTheme = win.setTitleBarOverlay.bind(win);
    win.setTitleBarOverlay = options => { titlebarThemes.push(options); return setNativeTheme(options); };
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*'] }, (r, cb) => cb({ cancel: r.url !== previewUrl }));
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    await win.loadFile(path.join(tmp, 'desk.html'));
    await js(`window.errors=[];window.notices=[];window.navigation=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));window.petSay=v=>notices.push(v);window.SoduWorkAPI={online:true,hubBase:()=>''};window.WorkspaceHost={open:(key,payload)=>navigation.push({key,payload})};void 0;`);
    for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/'+file));
    for (const file of ['core/i18n-dom.js','core/i18n.js','components/workspace/workspace-chat-history.js','components/workspace/workspace-chat-list.js','components/workspace/workspace-shell.js','components/workspace/window-menu.js']) await js(read(file)+'\nvoid 0;');
    await js("SoduWorkI18n.setLocale('zh-CN');void 0;");
    await until(`document.documentElement.dataset.windowTitlebar==='overlay'`);
    assert.equal((await js('soduWorkAPI.getWindowTitlebar()')).mode, 'overlay');
    assert.equal(await js(`getComputedStyle(document.querySelector('.window-menu')).webkitAppRegion`), 'drag');
    assert.equal(await js(`getComputedStyle(document.querySelector('[data-window-menu="file"]')).webkitAppRegion`), 'no-drag');
    assert.equal(await js(`document.querySelector('.window-menu nav').hidden`), false);
    assert.equal(await js(`document.querySelectorAll('.wm-title-brand').length`), 0);
    report.cases.push('Production titlebar options expose native Windows captions and draggable empty space without duplicating the sidebar brand; menu buttons remain non-draggable.');
    await js(`document.documentElement.style.setProperty('--bg-0','#17191f');document.documentElement.style.setProperty('--ink-3','#dadde4');void 0;`);
    for (let i = 0; i < 100 && titlebarThemes.at(-1)?.color !== '#17191f'; i++) await delay(20);
    assert.deepEqual(titlebarThemes.at(-1), { color: '#17191f', symbolColor: '#dadde4', height: 34 });
    await shot('titlebar-dark');
    await js(`document.documentElement.style.removeProperty('--ws-side');document.documentElement.style.removeProperty('--ink-3');void 0;`);
    for (let i = 0; i < 100 && titlebarThemes.at(-1)?.color !== initialCaptionColor; i++) await delay(20);
    assert.equal(titlebarThemes.at(-1).color, initialCaptionColor);
    report.cases.push('Changing and restoring skin colors reaches the real native caption controls without changing their fixed height.');
    await js(`WorkspaceShell.mount();WorkspaceShell.setActive('create');WorkspaceShell.setChats(Array.from({length:30},(_,i)=>({id:'chat-'+i,title:'历史会话 '+i,at:Date.now()-i*1000})));void 0;`);
    await js('soduWorkAPI.deskContentReady();void 0;');
    win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await click('#draft'); win.webContents.insertText('未发送草稿 / unsent draft');
    await js(`document.querySelector('#wsSideScroll').scrollTop=120;window.savedDraft=document.querySelector('#draft');window.savedList=document.querySelector('#wsChats');void 0;`);
    const original = await geometry(); assert.equal(original.bar.bottom, 34); assert.equal(original.content.top, original.bar.bottom + 2);
    assert.equal(await js(`getComputedStyle(document.querySelector('#workspaceShell'), '::before').backgroundColor`), 'rgb(253, 253, 253)');
    assert.equal(await js('innerHeight') - original.content.bottom, 15);
    await click('[data-window-sidebar]'); const hidden = await geometry();
    assert.equal(hidden.side.visible, false); assert.equal(hidden.resizer.visible, false); assert.equal(hidden.rail.visible, true);
    assert.equal(hidden.content.left, 52); assert.equal(hidden.draft, original.draft); assert.ok(hidden.content.right > hidden.content.left);
    await click('[data-window-menu="view"]'); await click('[data-window-command="sidebar"]'); const restored = await geometry();
    assert.equal(restored.content.left, original.content.left); assert.equal(restored.scroll, original.scroll); assert.equal(restored.side.visible, true);
    assert.equal(await js(`savedDraft===document.querySelector('#draft')&&savedList===document.querySelector('#wsChats')`), true);
    report.cases.push('Icon and View menu share sidebar state; content gains width while draft, history DOM and sidebar scroll remain unchanged.');
    await click('[data-window-menu="file"]'); await shot('file-menu'); await click('[data-window-command="new"]');
    assert.equal(await js('navigation.length'), 1); assert.equal(await js('navigation[0].key'), 'create'); assert.equal(await js('navigation[0].payload.newSession'), true);
    await click('#draft'); key('n', ['control']); await until('navigation.length===2');
    key('b', ['control']); await delay(120); assert.equal((await geometry()).side.visible, false);
    await js(`document.documentElement.dataset.workspaceView='schedules';WorkspaceShell.setActive('schedules');void 0;`); await delay(100);
    assert.equal(await js(`document.querySelector('[data-window-sidebar]').disabled`), true);
    await js(`document.documentElement.dataset.workspaceView='settings';WorkspaceShell.setActive('settings');void 0;`); await delay(100);
    assert.equal((await geometry()).side.visible, true);
    await js(`document.documentElement.dataset.workspaceView='create';WorkspaceShell.setActive('create');void 0;`); await delay(100);
    assert.equal((await geometry()).side.visible, false);
    report.cases.push('New chat and Ctrl+N call the established new-session navigation. Ctrl+B works; pages without a sidebar disable it; chat and settings remember separate visibility.');
    await click('[data-window-menu="file"]'); key('ArrowRight'); await delay(90);
    assert.equal(await js(`document.querySelector('[data-window-menu="view"]').getAttribute('aria-expanded')`), 'true');
    key('ArrowRight'); await delay(90); key('End'); await delay(60);
    assert.equal(await js(`document.activeElement.dataset.windowCommand`), 'about');
    key('ESC'); await delay(100); assert.equal(await js(`document.querySelector('#windowMenuPopup').hidden`), true);
    assert.equal(await js(`document.activeElement.dataset.windowMenu`), 'help');
    report.cases.push('Menu keyboard Left/Right/End/Escape works and returns focus to its trigger.');
    await showHelp('about');
    assert.ok(await js(`document.querySelector('.wm-about-details').textContent.includes(${JSON.stringify(require('../package.json').version)})`));
    await shot('about'); await click('[data-window-website]'); assert.deepEqual(external, ['https://isolated-menu-hub.example:8443']);
    assert.equal(hubEndpoint.prepare(testApp, 'https://switched-menu-hub.example:9443').ok, true);
    await click('[data-window-website]');
    assert.equal(external.at(-1), 'https://switched-menu-hub.example:9443');
    key('ESC'); await until(`!document.querySelector('.wm-dialog').open`);
    await showHelp('about');
    assert.equal(await js(`document.querySelector('[data-window-website]').textContent`), 'switched-menu-hub.example:9443');
    await click('[data-window-dialog-close]');
    await click('[data-window-menu="help"]'); await click('[data-window-command="website"]');
    assert.deepEqual(external, ['https://isolated-menu-hub.example:8443', 'https://switched-menu-hub.example:9443', 'https://switched-menu-hub.example:9443']);
    await showHelp('history'); assert.equal(await js(`document.querySelectorAll('.wm-releases section').length`), require('../main/release-history.json').releases.length);
    assert.equal(await js(`document.querySelector('.wm-withdrawn').textContent`), '已撤回'); await shot('release-history'); await click('[data-window-dialog-close]');
    report.cases.push('About displays actual installed version; Website dispatches exactly the confirmed address; release history shows the withdrawn version explicitly.');
    for (const width of [1280, 800, 360]) for (const locale of ['zh-CN','en-US']) {
      win.setContentSize(width, 760); await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)});document.documentElement.dataset.theme=${JSON.stringify(locale==='zh-CN'?'azure':'ruby')};`); await delay(80);
      assert.equal(await js(`document.querySelector('[data-window-menu="file"]').textContent`), locale==='zh-CN'?'文件':'File');
      const barGeometry = await js(`(()=>{const bar=document.querySelector('.window-menu').getBoundingClientRect(),last=document.querySelector('[data-window-menu="help"]').getBoundingClientRect();return{barRight:bar.right,menuRight:last.right,width:innerWidth}})()`);
      assert.ok(barGeometry.menuRight <= barGeometry.barRight && barGeometry.barRight < barGeometry.width, JSON.stringify(barGeometry));
      await showHelp('history');
      assert.equal(await js(`document.querySelector('#windowHelpTitle').textContent`), locale==='zh-CN'?'版本历史':'Version history');
      const bounds = await js(`(()=>{const e=document.querySelector('.wm-dialog'),r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:e.scrollWidth>e.clientWidth+1}})()`);
      assert.ok(bounds.left>=0&&bounds.right<=bounds.width&&bounds.top>=0&&bounds.bottom<=bounds.height&&!bounds.overflow, JSON.stringify(bounds));
      if(width===360) await shot('history-'+locale+'-360'); await click('[data-window-dialog-close]');
    }
    report.cases.push('Top menus and release dialog fit 360/800/1280px, Chinese/English and two themes without overflow.');
    win.setContentSize(1280, 800);
    await js(`SoduWorkI18n.setLocale('zh-CN');document.documentElement.dataset.theme='azure';
      for(const href of ['components/panels/panels-chat.css','components/panels/chat-workspace-split.css']){const link=document.createElement('link');link.rel='stylesheet';link.href=href;document.head.append(link);}
      const root=document.createElement('div');root.id='previewChat';root.className='nchat';root.style='position:absolute;inset:50px 20px 20px 70px;z-index:200;background:white';root.innerHTML='<div class="nchat-stage"><div class="nchat-main">保留的对话</div></div>';document.body.append(root);void 0;`);
    for (const file of ['components/panels/chat-dom-patch.js', 'components/panels/panels-chat-tools.js','components/panels/chat-output-links.js','components/panels/chat-workspace-info.js','components/panels/chat-workspace-split.js','components/workspace/native-preview-overlays.js','components/panels/chat-workspace-controls.js', 'components/panels/panels-chat-workspace.js']) await js(read(file)+'\nvoid 0;');
    await js(`ChatWorkbench.bind(document.querySelector('#previewChat'),()=>({ref:'menu-preview'}));ChatWorkbench.openLink(${JSON.stringify(previewUrl)});ChatWorkbench.maximize(true);void 0;`);
    const nativeView = () => win.contentView.children.find(v => v.webContents && v.webContents !== win.webContents);
    for (let i = 0; i < 100 && !nativeView(); i++) await delay(30);
    assert.ok(nativeView());
    const view = nativeView();
    for (let i = 0; i < 100 && !(await view.webContents.executeJavaScript(`Boolean(document.querySelector('#previewDraft'))`)); i++) await delay(30);
    assert.equal(await view.webContents.executeJavaScript(`document.querySelector('#previewDraft').value`), '页面内容保留');
    const loadedOnce = await view.webContents.executeJavaScript('loadedOnce');
    assert.equal(view.getVisible(), true);
    await click('[data-window-menu="help"]'); await delay(80); assert.equal(view.getVisible(), false);
    await click('[data-window-command="about"]'); await until(`document.querySelector('.wm-dialog').open && !document.querySelector('.wm-dialog [role=status]')`);
    assert.equal(view.getVisible(), false); await shot('about-over-native-preview');
    await click('[data-window-dialog-close]');
    for (let i = 0; i < 100 && !view.getVisible(); i++) await delay(30);
    assert.equal(view.getVisible(), true); assert.equal(nativeView(), view);
    assert.equal(await view.webContents.executeJavaScript('loadedOnce'), loadedOnce);
    assert.equal(await view.webContents.executeJavaScript(`document.querySelector('#previewDraft').value`), '页面内容保留');
    assert.ok(view.getBounds().y >= 34);
    await js(`ChatWorkbench.reset();document.querySelector('#previewChat').remove();void 0;`);
    report.cases.push('Real sandboxed WebContentsView yields to menus and About in maximized preview; closing restores the same view, page load and form state below the titlebar.');
    await click('[data-window-menu="file"]'); await click('[data-window-command="quit"]'); assert.equal(confirmCount, 1); assert.equal(quitCount, 0);
    answer = 1; await click('[data-window-menu="file"]'); await click('[data-window-command="quit"]'); assert.equal(confirmCount, 2); assert.equal(quitCount, 1);
    report.cases.push('Quit traverses production preload/main guard; cancellation preserves work and confirmation calls the shared exit once (test callback only).');
    assert.deepEqual(await js('errors'), []); assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(async error => { report.error = error.stack; try { await shot('failure'); } catch {} }).finally(() => {
    if (server) server.close(); if (win && !win.isDestroyed()) win.destroy(); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  });
}
