'use strict';
// Real native app/composer identity, Chromium localStorage events and production UI.
// Conversation contents/entry are deterministic fixtures; no model, account or business writes.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[name];
  const result = require('node:child_process').spawnSync(electron, [__filename], { env, windowsHide: true, stdio: 'inherit', timeout: 60000 });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, WebContentsView, ipcMain } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-app-history-'));
const output = path.resolve(__dirname, '../../outputs/app-conversation-history-20261023');
// Keep native view rendering active when the desktop test runner is occluded.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(temp, 'profile')); app.disableHardwareAcceleration();
const report = { ok: false, cases: [], boundary: 'Production Electron window/composer/preload identity, sidebar grouping, header/history UI, native view sizing and file-origin storage events. NativeChat archives and history inventory are deterministic fixtures. No real model, business writes, accounts or physical mouse evidence.' };
const windows = [], views = [];
let host, server;
let locationOpens = 0;
let historyRows = Array.from({ length: 50 }, (_, i) => ({ id: 'recent-' + i, title: '普通会话 ' + i, createdAt: Date.now() - i }));
let deferredHistory = null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = async (wc, code) => {
  try { return await wc.executeJavaScript(code, true); }
  catch (error) { throw Error(String(error.message) + '\nExpression: ' + code + '\nRenderer: ' + JSON.stringify(await wc.executeJavaScript('window.errors || []'))); }
};
async function tap(wc, selector) {
  const point = await js(wc, '(()=>{const r=document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  wc.focus();
  wc.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
  wc.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
  await delay(80);
}
async function until(check, label) { for (let i = 0; i < 240; i++) { if (await check()) return; await delay(25); } throw Error('Timed out: ' + label); }
const asset = file => pathToFileURL(path.resolve(__dirname, '..', file)).href;
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  ipcMain.handle('recent-workspace-get', () => ({ ok: true, dir: '', name: '' }));
  ipcMain.handle('pi-session-open-session-workdir', () => { locationOpens++; return {ok:true}; });
  ipcMain.handle('pi-session-history', require('./fixtures/history-ipc.cjs').create(() => deferredHistory || { ok: true, chats: historyRows }));
  const composerFile = path.join(temp, 'composer.html');
  fs.writeFileSync(composerFile, `<!doctype html><html data-desk-panel="chatbar"><head><meta charset="utf-8">
    <link rel="stylesheet" href="${asset('theme/variables.css')}"><link rel="stylesheet" href="${asset('components/workspace/workspace-navigation.css')}"><link rel="stylesheet" href="${asset('components/panels/panels-chat.css')}"><link rel="stylesheet" href="${asset('desk-window.css')}">
    </head><body data-composer-state="pinned"><div id="composePanel" class="compose-panel"><div class="cp-body"><div id="cpChat" class="cp-chat"></div></div></div>
    <script>window.__deskPanel='chatbar';window.errors=[];addEventListener('error',e=>errors.push(e.message));
      window.SoduWorkAPI={hubBase:()=>'https://sidebar-fixture.invalid',clientAuthSnapshot:()=>({user:{id:window.fixtureOwner||'employee'},clientId:'fixture-device'})};
      let info={},count=0;const drafts=new Map();
      function mount(){cpChat.innerHTML='<div class="nchat"><div class="nchat-stage"><div class="nchat-main">'+ChatChrome.header()+'<div class="nchat-content-area"><div class="nchat-scroll"><p>隔离会话预览</p></div></div><textarea id="nchatInput" aria-label="消息"></textarea></div></div></div>';ChatChrome.bind(document.querySelector('.nchat'),()=>({snapshot:{},ref:'fixture'}));}
      window.NativeChat={sessionInfo:()=>info,reset(){drafts.set(info.sessionId||'new',document.getElementById('nchatInput')?.value||'');info={};ChatChrome.reset();},prepare:mount,
        async enter(_text,id,options){info={sessionId:id,title:options.chatTitle};mount();nchatInput.value=drafts.get(id)||'';ChatChrome.resume(info.title);ChatChrome.identify(id);return true;},
        async create(title){await this.enter('','app-chat-'+Date.now()+'-'+(++count),{chatTitle:title});return info.sessionId;},draft:id=>drafts.get(id)};
    </script><script src="${asset('core/plugin-icon.js')}"></script><script src="${asset('components/workspace/workspace-chat-history.js')}"></script><script src="${asset('components/workspace/workspace-sidebar-state.js')}"></script><script src="${asset('components/panels/app-conversation-history.js')}"></script><script src="${asset('components/panels/panels-chat-chrome.js')}"></script>
    <script>NativeChat.prepare();window.historyReady=SoduWorkAppConversations.start(soduWorkAPI.workPreview.composerHello(),Promise.resolve());</script></body></html>`);
  server = http.createServer((_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<title>History fixture</title><h1>即用页面</h1>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  require('../main/work-preview').install({ app, ipcMain,
    BrowserWindow: Object.assign(function (options) { const win = new BrowserWindow(options); windows.push(win); return win; }, { fromWebContents: wc => BrowserWindow.fromWebContents(wc) }),
    WebContentsView: function (options) {
      const view = new WebContentsView(options); views.push(view);
      const load = view.webContents.loadFile.bind(view.webContents);
      view.webContents.loadFile = (file, options) => load(path.basename(file) === 'desk.html' ? composerFile : file, options);
      return view;
    }, shell: { openExternal: async () => {} } });
  host = new BrowserWindow({ show: false, width: 1080, height: 820, webPreferences: { preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false } });
  await host.loadFile(path.resolve(__dirname, 'fixtures/sidebar-projects.html'));
  await js(host.webContents, fs.readFileSync(path.resolve(__dirname,'../core/plugin-icon.js'),'utf8'));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const appIcon='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxqkAAAAASUVORK5CYII=';
  const payload = { tabId: 'history-app', label: '运营应用', url: origin, icon:appIcon,
    appBridge: { appId: 'plugin:local:history-app', contributionId: 'app', origin, version: 1, capabilities: [] } };
  async function open(value = payload) {
    const count = windows.length;
    assert.equal((await js(host.webContents, 'soduWorkAPI.workPreview.showDetached(' + JSON.stringify(value) + ')')).ok, true);
    await until(() => windows.length > count && windows.at(-1).contentView.children.length === 3, 'native surfaces');
    const win = windows.at(-1);
    await until(() => win.contentView.children.some(view => /\/app-composer-launcher\.html(?:\?|$)/.test(view.webContents.getURL()) && !view.webContents.isLoading()),
      'composer launcher loaded');
    const launcher = win.contentView.children.find(view => /\/app-composer-launcher\.html(?:\?|$)/.test(view.webContents.getURL())).webContents;
    await tap(launcher, 'button');
    await until(() => win.contentView.children.some(view => view.webContents.getURL().startsWith(pathToFileURL(composerFile).href)),
      'composer fixture navigation');
    const composer = win.contentView.children.find(view => view.webContents.getURL().startsWith(pathToFileURL(composerFile).href)).webContents;
    await until(() => composer.getURL().startsWith(pathToFileURL(composerFile).href) && !composer.isLoading(), 'composer loaded');
    await until(() => js(composer, 'typeof window.historyReady !== "undefined"'), 'composer history initialized');
    await js(composer, 'historyReady');

    await js(composer, 'soduWorkAPI.workPreview.composerSetMode({expanded:true})');
    await delay(100); // Let the native view apply its expanded bounds before pointer input/capture.
    return { win, composer };
  }
  let { win, composer } = await open();
  assert.equal(await js(composer, 'document.querySelectorAll("[data-app-chat-history],[data-app-chat-new]").length'), 2);
  await until(() => js(composer, 'document.querySelector("[data-app-chat-history-title]").getBoundingClientRect().width>0'), 'title layout ready');
  await tap(composer, '[data-app-chat-history-title]');
  assert.equal(await js(composer, 'document.querySelector("dialog").matches(":popover-open")'), true, 'title opens history');
  assert.equal(await js(composer, 'document.querySelector("[data-app-chat-history-title]").getAttribute("aria-expanded")'), 'true');
  composer.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); composer.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await delay(60);
  assert.equal(await js(composer, '!!document.querySelector("dialog:popover-open")'), false, 'Escape dismisses title history');
  await js(composer, 'document.querySelector("[data-app-chat-history-title]").focus()');
  composer.focus();
  for (const type of ['keyDown', 'char', 'keyUp']) composer.sendInputEvent({ type, keyCode: type === 'char' ? '\r' : 'Return' });
  await delay(60);
  assert.equal(await js(composer, '!!document.querySelector("dialog:popover-open")'), true, 'title supports keyboard activation');
  await js(composer, 'document.querySelector("[data-app-history-close]").click()');
  report.cases.push('Current title opens the same anchored history as the three-bar button, with synchronized expanded state, native Enter activation and Escape dismissal.');
  const first = await js(composer, 'NativeChat.create("第一条运营对话")');
  await until(() => js(host.webContents, 'document.querySelectorAll("#wsProjectsList .ws-chat-row").length===1'), 'main sidebar storage sync');
  assert.equal(await js(host.webContents, 'document.querySelector("#wsProjectsList .ws-project-toggle span").textContent'), '运营应用');
  assert.equal(await js(host.webContents, '!!document.querySelector("#wsAppConversationsBox")'), false, 'applications share the Projects section');
  assert.equal(await js(host.webContents, 'document.querySelector("#wsProjectsList .ws-project-toggle img").getAttribute("src")'), appIcon, 'application project reuses native app artwork');
  await js(composer, 'nchatInput.value="第一条未发送草稿";document.querySelector("[data-app-chat-new]").click()');
  assert.equal(await js(composer, 'NativeChat.sessionInfo().sessionId||""'), '');
  assert.equal(await js(composer, 'nchatInput.value'), '');
  const second = await js(composer, 'NativeChat.create("第二条运营对话")');
  await js(composer, 'document.querySelector("[data-app-chat-history]").click()');
  await until(() => js(composer, 'document.querySelectorAll(".app-chat-history-row").length===2'), 'two history rows');
  await tap(composer, '[data-chat-open-location]');
  assert.equal(locationOpens, 1, 'one pointer click opens the folder even with history visible');
  await js(composer, 'document.querySelector("[data-app-chat-history]").click()');
  assert.equal(await js(composer, '!!document.querySelector("dialog:popover-open")&&!document.querySelector("dialog:modal")&&getComputedStyle(document.querySelector("dialog")).display!=="none"'), true);
  assert.equal(await js(composer, '!!document.querySelector("[data-chat-menu],[data-chat-rename]")'), false, 'app header has no rename/menu entry');
  assert.equal(await js(composer, 'document.querySelector("[data-app-chat-history] svg path").getAttribute("d")'), 'M4 6h16M4 12h16M4 18h16');
  const addStyle=await js(composer,'(()=>{const s=getComputedStyle(document.querySelector("[data-app-chat-new]"));return {radius:s.borderRadius,bg:s.backgroundColor,color:s.color}})()');
  assert.equal(addStyle.radius,'50%'); assert.notEqual(addStyle.bg,'rgba(0, 0, 0, 0)');
  await js(composer, 'document.querySelector(' + JSON.stringify('[data-app-chat-id="' + first + '"]') + ').click()');
  await until(() => js(composer, 'NativeChat.sessionInfo().sessionId===' + JSON.stringify(first)), 'selected old chat');
  assert.equal(await js(composer, 'nchatInput.value'), '第一条未发送草稿');
  await js(composer, 'document.querySelector("[data-app-chat-history]").click()');
  await tap(composer, '[data-app-chat-new]');
  assert.equal(await js(composer,'NativeChat.sessionInfo().sessionId||""'),'','one pointer click starts a new draft while history is open');
  assert.equal(await js(composer,'!!document.querySelector("dialog:popover-open")'),false);
  await js(composer,'NativeChat.enter("",'+JSON.stringify(first)+',{chatTitle:"第一条运营对话"})');
  report.cases.push('Non-modal history allows one Chromium pointer click on open-folder/new; app menu is absent, history uses three bars, new is a gray circular button, and application projects render the exact app PNG.');
  report.cases.push('Trusted native app identity creates one named application group in the main window; header history/new controls switch two conversations, preserve drafts and synchronize through production file-origin storage events.');
  const live = (id, title, state = 'running', status = 'streaming') => ({ id, title, state, status, live: true });
  const publish = row => composer.send('pi-session-event', { sessionId: row.id, presence: row, snapshot: null });
  const cardVisible = () => js(composer, 'document.querySelector("[data-app-active-chats]").checkVisibility()');
  assert.equal(await cardVisible(), false, 'empty card takes no space');
  historyRows = [live(first, '第一条运营对话'), live(second, '第二条运营对话')];
  publish(historyRows[0]); await delay(60);
  assert.equal(await cardVisible(), false, 'only the current conversation is ongoing: card stays hidden');
  await js(composer, 'SoduWorkAppConversations.select(' + JSON.stringify(second) + ')');
  await until(cardVisible, 'one background conversation remains visible after switching topics');
  assert.equal(await js(composer, 'document.querySelectorAll(".app-chat-active-row").length'), 1);
  assert.equal(await js(composer, 'document.querySelector(".app-chat-active-row").dataset.appActiveId'), first);
  composer.invalidate(); await delay(100);
  fs.writeFileSync(path.join(output, 'single-background-conversation.png'), (await composer.capturePage()).toPNG());
  await tap(composer, '[data-app-active-id="' + first + '"]');
  await until(async () => !await cardVisible(), 'returning to the sole active conversation hides the card');
  assert.equal(await js(composer, 'nchatInput.value'), '第一条未发送草稿');
  await js(composer, 'SoduWorkAppConversations.newChat()');
  await until(cardVisible, 'new topic also shows the sole background conversation');
  publish(live(first, '第一条等待确认', 'waiting', 'waiting-user'));
  await until(() => js(composer, 'document.querySelector(".app-chat-active-row small").textContent==="等待确认"'), 'single background waiting status');
  publish(live(first, '第一条已完成', 'completed', 'idle'));
  await until(async () => !await cardVisible(), 'last background conversation completed');
  publish(historyRows[0]); await until(cardVisible, 'background activity resumes');
  await js(composer, 'SoduWorkAppConversations.select(' + JSON.stringify(first) + ')');
  assert.equal(await cardVisible(), false);
  publish(live('unrelated-app', '其他应用对话')); publish({ ...historyRows[1], live: false }); await delay(60);
  assert.equal(await cardVisible(), false, 'other applications and non-live rows do not count');
  publish(historyRows[1]); await until(cardVisible, 'two ongoing conversations');
  assert.equal(await js(composer, 'document.querySelector(".nchat-head").nextElementSibling.matches("[data-app-active-chats]")'), true);
  await tap(composer, '[data-app-active-id="' + second + '"]');
  await until(() => js(composer, 'NativeChat.sessionInfo().sessionId===' + JSON.stringify(second)), 'card switches conversation');
  assert.equal(await js(composer, 'document.querySelector(".app-chat-active-row[aria-current=true]").dataset.appActiveId'), second);
  await js(composer, 'SoduWorkAppConversations.select(' + JSON.stringify(first) + ')');
  assert.equal(await js(composer, 'nchatInput.value'), '第一条未发送草稿', 'active navigation preserves the composer draft');
  report.cases.push('Ongoing card hides at zero or only the current active conversation; switching to another topic or a new chat shows even one background conversation, including waiting status. Returning hides it and completion removes it. Other apps and non-live rows remain excluded; two active conversations still show. Existing NativeChat switching preserves drafts.');
  win.destroy(); await until(() => win.isDestroyed(), 'first app closes');
  ({ win, composer } = await open());
  assert.equal(await js(composer, 'NativeChat.sessionInfo().sessionId'), first);
  await until(cardVisible, 'ongoing card restored from live inventory after reopen');
  await js(composer, 'document.querySelector("[data-app-chat-history]").click()');
  await until(() => js(composer, 'document.querySelectorAll(".app-chat-history-row").length===2'), 'history after reopen');
  assert.equal(await js(composer, '!!document.querySelector(' + JSON.stringify('[data-app-chat-id="' + second + '"]') + ')'), true);
  await js(composer, 'document.querySelector("[data-app-history-close]").click();for(let i=0;i<60;i++)SoduWorkAppConversations.identified("old-app-"+i,"历史运营对话 "+i);document.querySelector("[data-app-chat-history]").click()');
  await until(() => js(composer, 'document.querySelectorAll(".app-chat-history-row").length===62'), 'complete older history');
  if (win.isMaximized()) { win.unmaximize(); await until(() => !win.isMaximized(), 'restore before sidebar sizing'); await delay(80); }
  for (const width of [310, 430, 1000]) {
    win.setContentSize(width + 460, 780);
    await js(composer, 'soduWorkAPI.workPreview.composerSetWidth(' + (width + 10) + ')'); await delay(80);
    assert.equal(await js(composer, '(()=>{const r=document.querySelector("dialog").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()'), true);
    const popup = await js(composer, '(()=>{const p=document.querySelector("dialog"),r=p.getBoundingClientRect(),a=document.querySelector("[data-app-chat-history]").getBoundingClientRect();return {left:r.left,anchorLeft:a.left,width:r.width,viewport:innerWidth,arrow:r.left+parseFloat(getComputedStyle(p).getPropertyValue("--app-history-arrow")),anchorCenter:a.left+a.width/2,top:r.top,anchorBottom:a.bottom,listScroll:document.querySelector("[data-app-history-list]").scrollHeight>document.querySelector("[data-app-history-list]").clientHeight}})()');
    assert.ok(Math.abs(popup.left-popup.anchorLeft)<=1, 'history aligns with its header button after resizing: '+JSON.stringify(popup));
    assert.ok(popup.width<=320 && popup.width<=popup.viewport-24, 'history stays compact in narrow and wide sidebars');
    assert.ok(Math.abs(popup.arrow-popup.anchorCenter)<=1, 'triangle points to the history button');
    assert.ok(popup.top>popup.anchorBottom && popup.listScroll, 'anchored panel keeps long history scrollable');
  }
  await until(() => js(host.webContents, 'document.querySelectorAll("#wsProjectsList .ws-chat-row").length===62'), 'all grouped chats in main');
  report.groupLayout = await js(host.webContents, '(()=>{const p=document.querySelector("#wsProjectsList .ws-project"),c=p.parentElement;return {group:p.getBoundingClientRect().toJSON(),container:c.getBoundingClientRect().toJSON(),display:getComputedStyle(c).display,hidden:c.hidden,visible:p.checkVisibility()}})()');
  assert.equal(report.groupLayout.visible, true);
  assert.ok(report.groupLayout.group.height > 30, 'application group must be visible');
  host.webContents.invalidate(); await delay(150);
  fs.writeFileSync(path.join(output, 'history-popover.png'), (await composer.capturePage()).toPNG());
  fs.writeFileSync(path.join(output, 'main-sidebar.png'), (await host.webContents.capturePage()).toPNG());
  assert.deepEqual(await js(composer, 'errors'), []); assert.deepEqual(await js(host.webContents, 'errors'), []);
  report.cases.push('Closing and reopening the real native app restores the last selected older conversation; all 62 app conversations remain available outside a latest-50 ordinary inventory; compact history aligns with its header button and pointer triangle at narrow/default/wide sidebar sizes while the list scrolls.');
  await js(composer, 'document.querySelector("[data-app-history-close]").click()');
  publish(live('old-app-0', '很长的进行中对话标题 '.repeat(12), 'waiting', 'waiting-user'));
  await until(() => js(composer, 'document.querySelectorAll(".app-chat-active-row").length===3'), 'three active rows');
  assert.equal(await js(composer, '(()=>{const l=document.querySelector("[data-app-active-list]");return l.clientHeight===108&&l.scrollHeight===108})()'), true);
  publish(live('old-app-1', '<img src=x onerror=alert(1)>'));
  await until(() => js(composer, 'document.querySelectorAll(".app-chat-active-row").length===4'), 'four active rows');
  for (const width of [310, 430, 1000]) {
    win.setContentSize(width + 460, 780);
    await js(composer, 'soduWorkAPI.workPreview.composerSetWidth(' + (width + 10) + ')'); await delay(80);
    const layout = await js(composer, '(()=>{const c=document.querySelector("[data-app-active-chats]"),l=c.querySelector("[data-app-active-list]"),r=c.getBoundingClientRect();l.scrollTop=36;return {height:l.clientHeight,scroll:l.scrollTop,overflow:l.scrollHeight>l.clientHeight,inside:r.left>=0&&r.right<=innerWidth,html:c.querySelectorAll("img").length,waiting:c.querySelector("[data-state=waiting] small").textContent}})()');
    assert.equal(layout.height, 108); assert.equal(layout.scroll, 36); assert.equal(layout.overflow, true);
    assert.equal(layout.inside, true); assert.equal(layout.html, 0); assert.equal(layout.waiting, '等待确认');
  }
  await js(composer, 'document.querySelector("[data-app-active-list]").scrollTop=0');
  fs.writeFileSync(path.join(output, 'ongoing-conversations.png'), (await composer.capturePage()).toPNG());
  await js(composer, 'document.documentElement.dataset.composerTheme="dark"'); await delay(100);
  assert.equal(await js(composer, 'getComputedStyle(document.querySelector("[data-app-active-chats]")).backgroundColor'), 'rgb(32, 36, 46)');
  composer.invalidate(); await delay(100);
  fs.writeFileSync(path.join(output, 'ongoing-conversations-dark.png'), (await composer.capturePage()).toPNG());
  // Compare all status indicators against the real main-window sidebar CSS.
  const states = ['starting', 'running', 'waiting', 'failed', 'completed', 'stopped'];
  const statusRows = states.map((state, index) => live('old-app-' + index, '状态 ' + state, state));
  await js(host.webContents, 'for(const row of ' + JSON.stringify(statusRows) + ')WorkspaceShell.upsertChat(row)');
  statusRows.forEach(publish);
  await js(composer, 'void SoduWorkAppConversations.openHistory()');
  await until(() => js(composer, 'document.querySelectorAll(".app-chat-history-row[data-conversation-state=failed]").length===1'), 'history state indicators');
  const indicator = selector => '(()=>{const i=document.querySelector(' + JSON.stringify(selector) + ').querySelector(".st-chat"),s=getComputedStyle(i);return s.display==="none"?{display:s.display}:{display:s.display,width:s.width,height:s.height,color:s.backgroundColor,border:parseFloat(s.borderTopWidth)?s.borderTopColor:"",animation:s.animationName}})()';
  for (const row of statusRows) {
    const popupStyle = await js(composer, indicator('[data-app-chat-id="' + row.id + '"]'));
    const sidebarStyle = await js(host.webContents, indicator('[data-chat-id="' + row.id + '"]'));
    assert.deepEqual(popupStyle, sidebarStyle, 'history indicator matches main sidebar: ' + row.state);
  }
  await js(composer, 'document.querySelector("[data-app-chat-id=old-app-0]").focus()');
  publish(live('old-app-0', '运行中更新', 'running')); await delay(60);
  assert.equal(await js(composer, 'document.activeElement.dataset.appChatId'), 'old-app-0', 'runtime repaint keeps history keyboard focus');
  assert.equal(await js(composer, 'document.activeElement.dataset.conversationState'), 'running');
  await js(composer, 'document.documentElement.dataset.composerTheme="light"'); composer.invalidate(); await delay(100);
  fs.writeFileSync(path.join(output, 'history-status.png'), (await composer.capturePage()).toPNG());
  await js(composer, 'document.querySelector("[data-app-history-close]").click()');
  statusRows.forEach(row => publish({ ...row, state: 'completed', status: 'idle' }));
  await until(() => js(composer, 'document.querySelectorAll(".app-chat-active-row").length===2'), 'status fixtures settled');
  report.cases.push('All six history states use the shared main-sidebar normalization and exact indicator CSS: spinning start/run, amber waiting, red failure, no dot when completed/stopped. Live changes preserve focus; light/dark ongoing cards and history status screenshots retained.');
  publish(live('old-app-0', '已完成', 'completed', 'idle')); publish(live('old-app-1', '已停止', 'stopped', 'aborted'));
  await until(() => js(composer, 'document.querySelectorAll(".app-chat-active-row").length===2'), 'settled rows removed');
  let finishHistory; deferredHistory = new Promise(resolve => { finishHistory = resolve; });
  await js(composer, 'void SoduWorkAppConversations.openHistory()');
  publish(live(second, '第二条已完成', 'completed', 'idle')); await until(async () => !await cardVisible(), 'card hides immediately after completion');
  finishHistory({ ok: true, chats: historyRows }); deferredHistory = null; await delay(100);
  assert.equal(await cardVisible(), false, 'late history cannot overwrite a newer completion event');
  await js(composer, 'document.querySelector("[data-app-history-close]").click();window.fixtureOwner="other-account";dispatchEvent(new Event("soduwork-data-scope-changed"))');
  publish(historyRows[1]); await delay(50);
  assert.equal(await cardVisible(), false, 'scope change clears live projection and rejects old events');
  assert.deepEqual(await js(composer, 'errors'), []);
  report.cases.push('Live inventory restores on reopen; three 36px rows fit, four scroll at 310/430/1000px, titles render as text, waiting is explicit, completion hides immediately, late history cannot revive a completed row, and account changes clear the projection. Light/dark fixture screenshots retained.');
  const market = await open({ ...payload, tabId: 'market-history-app',
    appBridge: { ...payload.appBridge, appId: 'plugin:market-history-app' } });
  const marketContext = require('../main/work-preview').appContextFor(market.composer);
  assert.equal(marketContext?.pluginId, 'market-history-app', 'market application identity must reach conversation execution, not just the sidebar group');
  assert.equal(marketContext.connection, null, 'market plugins retain Hub authorization rather than borrowing a local credential');
  assert.equal(require('../main/work-preview').appContextFor(host.webContents), null, 'ordinary host chat must not inherit an application by its group name');
  report.cases.push('A market app carries its native plugin identity into conversation execution while preserving the Hub grant path; ordinary host chat gains no implicit application authorization.');
  report.ok = true;
}).catch(async error => { report.error = String(error.stack || error);
  report.layout = await Promise.all(views.filter(view => view.webContents && !view.webContents.isDestroyed()).map(async view => ({ bounds: view.getBounds(), layout: await view.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-app-chat-history-title],.nchat-head,.nchat-main,.nchat,.cp-body,#composePanel')).map(el=>({tag:el.className,rect:el.getBoundingClientRect().toJSON(),display:getComputedStyle(el).display}))`).catch(() => []) })));
}).finally(async () => {
  host?.destroy(); for (const win of windows) if (!win.isDestroyed()) win.destroy();
  for (const view of views) if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
});
