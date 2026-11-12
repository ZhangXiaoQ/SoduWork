'use strict';
// Actual Electron, production preload and renderer. History and directory picker
// are isolated fixtures: no business data, model calls or settings are changed.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence path required');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-sidebar-projects-')));
const report = { ok: false, cases: [], screenshots: [] };
let win, picks = 0, finishArchive, accountUnavailable = false, localRevision = 0;
let localRows = [];
// These account-directory fixtures exercise private grouping and late account
// replies. Runtime labels do not imply a native transcript in this empty profile.
const rows = Array.from({ length: 50 }, (_, i) => ({ id: 'chat-' + i,
  title: ['合同审核与修改建议', '本周产品进展', '讨论客户需求', '整理交付资料'][i % 4] + (i > 3 ? ' ' + i : ''),
  adapterId: ['pi', 'codex', 'opencode'][i % 3], accountProjection: true,
  at: 1000 - i, state: i === 0 ? 'running' : 'completed' }));
ipcMain.handle('pi-session-history', require('./fixtures/history-ipc.cjs').create(() =>
  accountUnavailable ? { ok: false, reason: 'Fixture account unavailable' } : { ok: true, chats: rows }, {
  local: options => ({ ok: true, chats: localRows, next: null,
    localCatalog: { workspace: 'sidebar-project-fixture', revision: localRevision,
      ...(options.catalogRevision === localRevision ? {} : { items: localRows.map(row => ({ id: row.id,
        historyAliasIds: row.historyAliasIds || [], originIds: row.source?.id ? [row.source.id] : [] })) }) } }),
}));
ipcMain.handle('pi-session-pick-cwd', () => { picks++; return { ok: true, dir: 'C:\\Work\\paperclip', name: 'paperclip' }; });
ipcMain.handle('pi-session-history-delete', (_, id) => {
  const i = rows.findIndex(r => r.id === id); if (i >= 0) rows.splice(i, 1); return { ok: true };
});
ipcMain.handle('pi-session-history-archive', () => new Promise(resolve => { finishArchive = () => resolve({ ok: true }); }));
ipcMain.handle('pi-session-history-restore', () => ({ ok: true }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code, true);
async function reload() {
  const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  win.webContents.reload(); await loaded;
}
async function until(code) { for (let i = 0; i < 100; i++) { if (await js(code)) return; await delay(40); } throw Error('Timed out: ' + code); }
async function shot(name) { const file = path.join(output, name + '.png'); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); report.screenshots.push(file); }
async function run() {
  win = new BrowserWindow({ show: false, width: 1080, height: 820, webPreferences: {
    preload: path.join(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false,
    offscreen: true, backgroundThrottling: false,
  } });
  await win.loadFile(path.join(__dirname, 'fixtures/sidebar-projects.html'));
  await until('document.querySelectorAll(".ws-chat-row").length===50');
  assert.equal(await js('!!document.querySelector("#wsAccountChatsBox,#wsAccountChats")'), false,
    'All eligible history uses the existing project, pinned and recent organization');
  await js(`window.marqueeRow=row('chat-0').querySelector('.ws-chat');window.marqueeTitle=marqueeRow.querySelector('.ws-chat-title');window.originalTitle=marqueeTitle.textContent;marqueeTitle.textContent='这是需要完整阅读的长会话标题，用于确认悬停后可以缓慢滚动看到最后的内容';marqueeRow.dispatchEvent(new MouseEvent('mouseenter'))`);
  await until('marqueeTitle.scrollLeft > 8');
  await js("marqueeRow.dispatchEvent(new MouseEvent('mouseleave'))");
  assert.equal(await js('marqueeTitle.scrollLeft'), 0);
  await js("marqueeTitle.textContent='短标题';marqueeRow.dispatchEvent(new MouseEvent('mouseenter'))");
  await delay(850); assert.equal(await js('marqueeTitle.scrollLeft'), 0);
  await js("marqueeRow.dispatchEvent(new MouseEvent('mouseleave'));marqueeTitle.textContent=originalTitle");
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await js("marqueeTitle.textContent='减少动画时保留完整标题提示，不自动滚动很长很长的会话标题';marqueeRow.dispatchEvent(new MouseEvent('mouseenter'))");
  await delay(850); assert.equal(await js('marqueeTitle.scrollLeft'), 0);
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:true});
  await js("marqueeRow.dispatchEvent(new MouseEvent('mouseleave'));marqueeRow.blur();marqueeRow.focus()");
  await until('marqueeTitle.scrollLeft > 8');
  await js('marqueeRow.blur()'); assert.equal(await js('marqueeTitle.scrollLeft'), 0);
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:false});
  win.webContents.debugger.detach();
  await shot('00-long-title-hover');
  await js('marqueeTitle.textContent=originalTitle');
  report.cases.push('overflowing titles scroll on hover and reset on leave; short titles and reduced motion stay still; keyboard focus scrolls');
  assert.equal(await js('getComputedStyle(document.querySelector("[data-view=schedules]")).color'),
    await js('getComputedStyle(document.querySelector(".ws-chat")).color'));
  await js('document.querySelector("#wsProjectAdd").click()');
  await until('!!document.querySelector(".ws-project-dialog[open]")');
  assert.equal(await js('document.activeElement.id'), 'wsProjectName');
  assert.equal(await js('getComputedStyle(document.querySelector("#wsProjectName")).outlineStyle'), 'none');
  assert.equal(await js('getComputedStyle(document.querySelector("#wsProjectName")).boxShadow'), 'none');
  assert.notEqual(await js('getComputedStyle(document.querySelector(".ws-project-name")).boxShadow'), 'none');
  assert.ok(await js('Math.abs(document.querySelector(".ws-project-name>span").getBoundingClientRect().height-document.querySelector("#wsProjectName").getBoundingClientRect().height)<1'));
  await shot('01-create-project');
  await js('document.querySelector(".ws-project-form").requestSubmit()');
  assert.equal(await js('document.querySelector(".ws-project-error").hidden'), false);
  await js('document.querySelector(".ws-project-folder-add").click()');
  await until('document.querySelector("#wsProjectName").value==="paperclip"');
  assert.equal(picks, 1);
  await js('document.querySelector(".ws-project-save").click()');
  assert.equal(await js('document.querySelector(".ws-project-toggle span").textContent'), 'paperclip');
  report.cases.push('create project, validate empty name, choose source folder through IPC without changing workdir');
  await js('document.querySelector(".ws-project-edit").click();document.querySelector("#wsProjectName").value="产品孵化";document.querySelector(".ws-project-save").click()');
  assert.equal(await js('document.querySelector(".ws-project-toggle span").textContent'), '产品孵化');
  await js('window.firstProject=projectId();drag("chat-1",firstProject);drag("chat-2",firstProject,"chat-1")');
  assert.deepEqual(await js('[...document.querySelectorAll(".ws-project-chats .ws-chat")].map(el=>el.dataset.chatId)'), ['chat-2', 'chat-1']);
  assert.equal(await js('opens.length'), 0);
  await js('drag("chat-0","pinned");drag("chat-2","pinned","chat-0")');
  assert.deepEqual(await js('[...document.querySelectorAll("#wsPinnedChats .ws-chat")].map(el=>el.dataset.chatId)'), ['chat-2', 'chat-0']);
  await js('drag("chat-2","recent","chat-3")');
  assert.equal(await js('row("chat-2").parentElement.id'), 'wsChats');
  assert.equal(await js('document.querySelectorAll(".ws-chat-row").length'), 50);
  assert.equal(await js('document.querySelectorAll("[data-chat-dragging],.is-drop-target,.is-drop-before").length'), 0);
  report.cases.push('real DOM drag handlers move/reorder between project, pinned and recent; no duplicates or accidental navigation');
  await delay(350);
  await js('row("chat-3").querySelector(".ws-chat-move").click()');
  await until('!!document.querySelector(".ws-project-move-dialog[open]")');
  await js('document.querySelector("[data-move-to=\\""+firstProject+"\\"]").click()');
  assert.equal(await js('row("chat-3").closest(".ws-project").dataset.projectId'), await js('firstProject'));
  await js('row("chat-0").querySelector(".ws-chat-pin").click()');
  assert.equal(await js('row("chat-0").parentElement.id'), 'wsChats');
  await js('row("chat-0").querySelector(".ws-chat-pin").click()');
  assert.equal(await js('row("chat-0").parentElement.id'), 'wsPinnedChats');
  report.cases.push('keyboard-accessible move dialog and existing pin button share the same placement state');
  await js('document.querySelector(".ws-project-toggle").click()');
  assert.equal(await js('document.querySelector(".ws-project-chats").hidden'), true);
  await reload(); await until('document.querySelectorAll(".ws-chat-row").length===50');
  assert.equal(await js('document.querySelector(".ws-project-toggle span").textContent'), '产品孵化');
  assert.equal(await js('document.querySelector(".ws-project-chats").hidden'), true);
  assert.equal(await js('row("chat-0").parentElement.id'), 'wsPinnedChats');
  await js('document.querySelector(".ws-project-toggle").click();document.querySelector("#wsSideScroll").scrollTop=180');
  await shot('02-organized-sidebar');
  const newer = Array.from({ length: 50 }, (_, i) => ({ id: 'new-' + i, title: '新会话 ' + i, at: 3000 - i }));
  await js('WorkspaceShell.setChats(' + JSON.stringify(newer) + ')');
  assert.ok(await js('!!row("chat-1")&&!!row("chat-3")'));
  report.cases.push('project name, collapsed state, pin placement persist after reload; grouped old chats outlive latest-50 history window');
  await js('document.querySelector(".ws-project-edit").click()');
  assert.equal(await js('document.querySelector(".ws-project-folder span").textContent'), 'paperclip');
  await js('document.documentElement.dataset.theme="warm"');
  await shot('03-edit-project-warm');
  assert.equal(await js('getComputedStyle(document.querySelector(".ws-project-dialog")).backgroundColor'), 'rgb(255, 253, 250)');
  win.setSize(760, 560);
  report.smallWindow = { bounds: win.getBounds(), content: win.getContentSize(),
    viewport: await js('({width:innerWidth,height:innerHeight,ratio:devicePixelRatio})') };
  // Hidden offscreen Windows bounds may round up by one device-independent pixel.
  await until(`innerWidth <= ${report.smallWindow.bounds.width} && innerHeight <= ${report.smallWindow.bounds.height}`);
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.ok(await js('document.querySelector(".ws-project-dialog").getBoundingClientRect().right<=innerWidth'));
  assert.ok(await js('document.querySelector(".ws-project-dialog").getBoundingClientRect().bottom<=innerHeight'));
  await shot('04-small-window');
  await js('document.querySelector(".ws-project-remove").click();document.querySelector(".ws-project-remove-confirm button").click()');
  assert.equal(await js('document.querySelectorAll(".ws-project").length'), 0);
  assert.equal(await js('row("chat-1").parentElement.id'), 'wsChats');
  assert.equal(await js('row("chat-3").parentElement.id'), 'wsChats');
  report.cases.push('theme-aware editor fits short windows; confirmed removal only ungroups and preserves conversations');
  // This imported account group remains private; new UI-created groups above
  // now belong to the device and intentionally survive account switches.
  await js(`window.archiveProjectId='project-account-archive-scope';WorkspaceSidebarState.create(WorkspaceSidebarState.accountOptions({storage:localStorage,api:SoduWorkAPI}))
    .applyRemoteProject({id:archiveProjectId,name:'Archive scope',folders:[],chatIds:['chat-1']});WorkspaceShell.setChats(${JSON.stringify(rows)});`);
  await js(`window.firstKey=WorkspaceSidebarState.accountOptions({storage:localStorage,api:SoduWorkAPI}).key;fixtureAccount='second-employee';window.secondKey=WorkspaceSidebarState.accountOptions({storage:localStorage,api:SoduWorkAPI}).key;fixtureAccount='employee';
    window.secondState=JSON.parse(localStorage.getItem(firstKey));secondState.projects[0].name='Other account project';localStorage.setItem(secondKey,JSON.stringify(secondState));
    window.confirm=()=>true;document.querySelector('.ws-project-edit').click();document.querySelector('.ws-project-archive').click();void 0;
  `);
  for(let i=0;i<100&&!finishArchive;i++)await delay(20);
  assert.equal(typeof finishArchive,'function');
  await js('fixtureAccount="second-employee";void 0;');
  finishArchive();
  await until('!document.querySelector(".ws-project-dialog")');
  const scoped=await js('({before:JSON.parse(localStorage.getItem(firstKey)),after:JSON.parse(localStorage.getItem(secondKey))})');
  assert.equal(scoped.before.projects.length,0);
  assert.equal(scoped.before.archivedProjects[0].name,'Archive scope');
  assert.equal(scoped.after.projects[0].name,'Other account project');
  assert.equal(scoped.after.archivedProjects.length,0);
  assert.equal(await js('document.querySelector(".ws-project-toggle span").textContent'),'Other account project');
  report.cases.push('project archive completed after account switch only changes originating storage; other account keeps its project');

  const appIcon = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '../assets/rail-icons/home.png')).toString('base64');
  await js(`window.iconState=WorkspaceSidebarState.create({storage:localStorage,key:WorkspaceSidebarState.storageKey(SoduWorkAPI)});
    iconState.recordAppChat('local:artwork','应用图标测试',{id:'chat-2',title:'应用对话'},${JSON.stringify(appIcon)});
    iconState.recordAppChat('local:fallback','无图应用',{id:'chat-4',title:'无图对话'},'https://example.invalid/icon.png');
    window.iconGroups=iconState.get().projects;WorkspaceShell.setChats(${JSON.stringify(rows)});`);
  await delay(350); // Let the prior drag's deliberate click-suppression window expire.
  await js('row("chat-3").querySelector(".ws-chat-move").click()');
  await until('!!document.querySelector(".ws-project-move-dialog[open]")');
  await until('document.querySelector(".ws-move-option>img")?.naturalWidth>0');
  const icons = await js(`iconGroups.map(p=>{const option=[...document.querySelectorAll('[data-move-to]')].find(el=>el.dataset.moveTo===p.id),image=option.querySelector('img'),head=[...document.querySelectorAll('.ws-project')].find(el=>el.dataset.projectId===p.id).querySelector('.ws-project-toggle');
    return {appId:p.appId||'',src:image?.getAttribute('src')||'',width:image?.getBoundingClientRect().width,
      rects:option.querySelectorAll('svg rect').length,paths:option.querySelectorAll('svg path').length,
      matchesHeading:option.querySelector('svg,img').outerHTML===head.querySelector('svg,img').outerHTML}})`);
  assert.equal(icons.find(p=>p.appId==='local:artwork').src, appIcon);
  assert.equal(icons.find(p=>p.appId==='local:artwork').width, 18);
  assert.equal(icons.find(p=>p.appId==='local:fallback').src, '');
  assert.equal(icons.find(p=>p.appId==='local:fallback').rects, 4, 'invalid artwork falls back to the app glyph');
  assert.equal(icons.find(p=>!p.appId).paths, 1, 'ordinary projects retain their folder');
  assert.equal(icons.every(p=>p.matchesHeading), true, 'move options and sidebar use the same group icon');
  await shot('05-move-application-icons');
  await js(`document.querySelector('[data-move-to="'+iconGroups.find(p=>p.appId==='local:artwork').id+'"]').click()`);
  assert.equal(await js('row("chat-3").closest(".ws-project").dataset.projectId'), await js('iconGroups.find(p=>p.appId==="local:artwork").id'));
  report.cases.push('Move dialog reuses each application group PNG or safe app-glyph fallback, ordinary folders stay unchanged, and selecting an app group still moves the chat through the existing state.');

  const originalRows = rows.slice();
  localRows = [
    { id: 'native-one', title: 'Native one', at: 4000, historyAliasIds: ['retired-native'] },
    { id: 'downloaded-copy', title: 'Local replay', at: 3500, cached: true, localReplica: true, source: { id: 'account-original' } },
    { id: 'native-two', title: 'Native two', at: 2000 },
  ];
  rows.splice(0, rows.length,
    { id: 'account-newest', title: 'Newest account conversation', at: 5000, accountConversation: true },
    { id: 'account-original', title: 'Executable account original', at: 4500, accountConversation: true, accountCanSend: true },
    { id: 'account-older', title: 'Older account conversation', at: 3000, accountConversation: true },
    { id: 'retired-native', title: 'Retired native alias', at: 4000 });
  localRevision++;
  await js('localStorage.clear()'); await reload();
  await until('document.querySelectorAll("#wsChats .ws-chat").length===6');
  const recentIds = '[...document.querySelectorAll("#wsChats .ws-chat")].map(el=>el.dataset.chatId)';
  assert.deepEqual(await js(recentIds), ['account-newest', 'account-original', 'native-one', 'downloaded-copy', 'account-older', 'native-two']);
  assert.equal(await js('!!document.querySelector("#wsAccountChatsBox,#wsAccountChats")'), false);
  assert.equal(await js('!!row("retired-native")'), false);
  assert.equal(await js('!!row("downloaded-copy")&&!!row("account-original")'), true,
    'The downloaded replay cannot replace its independently executable account original');
  report.cases.push('Mixed local and account history uses one chronological recent list, hides native aliases and preserves original/copy identities');
  await js('drag("account-older","recent","native-one");drag("native-two","recent","account-original")');
  const mixedOrder = ['account-newest', 'native-two', 'account-original', 'account-older', 'native-one', 'downloaded-copy'];
  assert.deepEqual(await js(recentIds), mixedOrder);
  await reload(); await until('document.querySelectorAll("#wsChats .ws-chat").length===6');
  assert.deepEqual(await js(recentIds), mixedOrder);
  await js('drag("native-one","pinned");drag("account-original","pinned","native-one")');
  assert.deepEqual(await js('[...document.querySelectorAll("#wsPinnedChats .ws-chat")].map(el=>el.dataset.chatId)'), ['account-original', 'native-one']);
  await reload(); await until('document.querySelectorAll(".ws-chat-row").length===6');
  assert.deepEqual(await js('[...document.querySelectorAll("#wsPinnedChats .ws-chat")].map(el=>el.dataset.chatId)'), ['account-original', 'native-one']);
  report.cases.push('Mixed-source recent and pinned drag order survives a real renderer reload');
  accountUnavailable = true;
  await js('WorkspaceShell.refreshConversationHistory()');
  assert.equal(await js('document.querySelector("#wsAccountHistoryStatus").hidden'), false);
  assert.equal(await js('document.querySelector("#wsAccountHistoryStatus").parentElement.id'), 'wsChatsBox');
  assert.equal(await js('document.querySelector("#wsAccountHistoryStatus").textContent'), '部分会话暂时无法读取');
  assert.equal(await js('document.querySelectorAll(".ws-chat-row").length'), 6);
  await shot('06-unified-history');
  accountUnavailable = false;
  await js('WorkspaceShell.refreshConversationHistory()');
  assert.equal(await js('document.querySelector("#wsAccountHistoryStatus").hidden'), true);
  report.cases.push('An account read failure preserves visible history and uses a compact recoverable status inside the original recent section');
  rows.splice(0, rows.length, ...originalRows); localRows = []; localRevision++;
  await js('localStorage.clear()'); await reload();
  await until('document.querySelectorAll(".ws-chat-row").length===50');

  assert.deepEqual(await js('errors'), []);
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Page.enable');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
    source: 'Storage.prototype.getItem=function(){throw Error("fixture denied")};Storage.prototype.setItem=function(){throw Error("fixture denied")};',
  });
  await reload(); await until('document.querySelectorAll(".ws-chat-row").length===50');
  await js('document.querySelector("#wsProjectAdd").click()');
  report.storageDiagnostics = await js('({notice:window.lastNotice,dialog:!!document.querySelector(".ws-project-dialog"),injected:Storage.prototype.getItem.toString().includes("fixture denied"),errors})');
  await js('document.querySelector("#wsProjectName").value="不会假装已保存";document.querySelector(".ws-project-save").click()');
  assert.equal(await js('document.querySelector(".ws-project-error").hidden'), false);
  assert.equal(await js('document.querySelectorAll(".ws-project").length'), 0);
  assert.deepEqual(await js('errors'), []);
  win.webContents.debugger.detach();
  report.cases.push('unavailable local storage does not block ordinary chat rendering and prevents false project-save success');
  report.ok = true;
}
app.whenReady().then(run).catch(async error => {
  if (win) report.ui = await js('({errors:window.errors,notice:window.lastNotice,add:!!document.querySelector("#wsProjectAdd"),state:typeof WorkspaceSidebarState,projects:typeof WorkspaceSidebarProjects,dialogs:document.querySelectorAll("dialog").length,body:document.body.innerText.slice(-900)})').catch(() => null);
  report.error = error.stack; console.error(error.stack); if (win) await shot('failure').catch(() => {});
}).finally(() => {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); win?.destroy(); app.exit(report.ok ? 0 : 1);
});
