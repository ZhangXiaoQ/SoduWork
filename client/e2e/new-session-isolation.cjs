'use strict';
// Real Electron renderer navigation + production workspace allocation. Agent
// responses are fixtures; no Hub, model or existing user profile is accessed.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename, '--disable-gpu'], {
    env, windowsHide: true, stdio: 'inherit', timeout: 60000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const client = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-new-session-isolation-'));
const profile = path.join(root, 'profile');
fs.mkdirSync(profile);
app.setPath('userData', profile);
app.setPath('sessionData', path.join(profile, 'session'));
app.disableHardwareAcceleration();
const report = { ok: false, electron: process.versions.electron, cases: [],
  boundary: 'Isolated Electron with production renderer modules and cwd allocator; fixture chat responses, no model execution.' };
let win;
app.whenReady().then(async () => {
  const config = require('../main/pi-session/environment-ipc').createConfiguration(() => app);
  config._saveConf({ workDir: path.join(root, 'work') });
  const allocations = [];
  ipcMain.handle('fixture-workspace', (_event, options) => {
    if (options.chatId) return path.join(root, 'existing');
    const cwd = config._newSessionCwd(app, 'fixture-' + allocations.length, options);
    allocations.push({ options, cwd });
    return cwd;
  });
  let html = fs.readFileSync(path.join(client, 'tests/new-conversation.html'), 'utf8');
  html = html.replace('<head>', '<head><base href="' + pathToFileURL(path.join(client, 'tests') + path.sep).href + '">');
  const marker = "return {ok:true,ref,sessionId:options.chatId||'fixture-'+seq,model:{},snapshot:snap()};";
  assert.ok(html.includes(marker), 'Fixture chat open boundary must be explicit');
  html = html.replace(marker, "const cwd=await require('electron').ipcRenderer.invoke('fixture-workspace',options);\n" + marker.replace('ok:true,ref,', 'ok:true,cwd,ref,'));
  fs.writeFileSync(path.join(root, 'fixture.html'), html);
  win = new BrowserWindow({ show: false, webPreferences: {
    nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false,
  } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_r, done) => done({ cancel: true }));
  await win.loadFile(path.join(root, 'fixture.html'));
  let result = '';
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    result = await win.webContents.executeJavaScript("document.getElementById('out')?.textContent || ''");
    if (/new conversation smoke:/.test(result)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  report.renderer = result;
  assert.match(result, /new conversation smoke: \d+ passed, 0 failed/, result);
  assert.ok(allocations.length >= 3, 'Real renderer must open at least three new conversations');
  assert.equal(new Set(allocations.map(row => row.cwd)).size, allocations.length);
  for (const row of allocations) {
    assert.equal(row.options.cwd, '');
    assert.equal(path.dirname(row.cwd), path.join(root, 'work', 'temp'));
    assert.deepEqual(fs.readdirSync(row.cwd), []);
  }
  fs.writeFileSync(path.join(allocations[0].cwd, 'previous-work.txt'), 'previous session only');
  assert.equal(fs.existsSync(path.join(allocations[1].cwd, 'previous-work.txt')), false);
  report.cases.push('Sidebar/menu/new-chat routes allocate different, empty native directories; previous output stays in its own directory.');
  const project = path.join(root, 'explicit-project');
  fs.mkdirSync(project);
  const payload = await win.webContents.executeJavaScript('WorkspaceShell.newSessionPayload(' +
    JSON.stringify({ cwd: project, workspaceLabel: 'Explicit project', sidebarProjectId: 'project-1' }) + ')');
  assert.equal(config._newSessionCwd(app, 'explicit', payload), project);
  assert.equal(payload.sidebarProjectId, 'project-1');
  report.cases.push('Explicit project context retains its chosen directory and project association.');
  for (const action of ['deleteHistoryChat', 'archiveHistoryChat']) {
    const result = await win.webContents.executeJavaScript(`(async () => {
      const navigation = [];
      const empty = document.createElement('div');
      empty.innerHTML = '<div id="wsSideScroll"></div><div id="wsChatsBox"></div><div id="wsPinnedBox"></div><div id="wsChats"></div><div id="wsPinnedChats"></div>';
      const ctx = { activeChatId: 'old', chatItems: [{id:'old', cwd:'old-private-directory'}],
        MAX_CHAT_ITEMS: 50, mount() {}, root: empty, chatNames: new Map(), _empty() {},
        chats: empty.querySelector('#wsChats'), pinnedChats: empty.querySelector('#wsPinnedChats'),
        newSessionContext: () => ({cwd:'old-private-directory', sidebarProjectId:'old-project'}) };
      const original = WorkspaceHost.open;
      WorkspaceHost.open = (view,payload) => navigation.push({view,payload});
      soduWorkAPI.conversationSession.deleteHistory = async () => ({ok:true});
      soduWorkAPI.conversationSession.archiveHistory = async () => ({ok:true});
      try {
        await WorkspaceChatList.create(ctx)[${JSON.stringify(action)}]('old');
        return navigation;
      } finally { WorkspaceHost.open = original; }
    })()`);
    assert.deepEqual(result, [{ view: 'create', payload: { newSession: true, tab: 'chat' } }]);
  }
  report.cases.push('Deleting or archiving the active chat opens a clean draft without previous cwd or project.');
  // Exercise page admission with the production composer and session controller.
  await win.webContents.executeJavaScript(`(() => {
    NativeChat.reset(); NativeChat.prepare();
    window.__deskPanel = 'chatbar'; window.__soduWorkChatbarReady = true;
    window.pageReceipts = []; window.releasedTopics = [];
    soduWorkAPI.conversationSession.release = async ref => { releasedTopics.push(ref); return {ok:true}; };
    soduWorkAPI.workPreview = {
      onComposerSession() {}, onComposerPut() {}, onComposerMode() {},
      onComposerSubmit(fn) { window.submitPage = fn; },
      composerHello() {}, composerSetMode() {}, composerSent() {},
      composerSubmitResult(row) { pageReceipts.push(row); }
    };
  })()`);
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(client, 'components/panels/chatbar-embed.js'), 'utf8'));
  const admission = await win.webContents.executeJavaScript(`(async () => {
    await submitPage({id:'page-idle',text:'page first'});
    const first = NativeChat.sessionInfo();
    const draft = document.getElementById('nchatInput');
    draft.value = 'keep old draft'; draft.dispatchEvent(new Event('input',{bubbles:true}));
    eventSink({ref:first.ref,snapshot:{...snap(),status:'streaming',execution:{running:true}}});
    if (!NativeChat.isBusy()) throw Error('Fixture must have a running conversation');
    const closedBefore = closed.length;
    await submitPage({id:'page-busy',text:'page second'});
    const second = NativeChat.sessionInfo();
    await NativeChat.enter('',first.sessionId);
    return {first:first.ref,second:second.ref,closedDelta:closed.length-closedBefore,
      released:releasedTopics.slice(),receipts:pageReceipts.slice(),
      draft:document.getElementById('nchatInput').value,
      sent:sent.filter(row=>row.text.startsWith('page '))};
  })()`);
  assert.notEqual(admission.first, admission.second);
  assert.equal(admission.closedDelta, 0, 'Busy navigation must release views rather than close execution');
  assert.ok(admission.released.includes(admission.first));
  assert.equal(admission.draft, 'keep old draft');
  assert.deepEqual(admission.sent, [{ref:admission.first,text:'page first'},{ref:admission.second,text:'page second'}]);
  assert.ok(admission.receipts.length === 2 && admission.receipts.every(row => row.ok));
  report.cases.push('Page sends reuse idle topics and create a separate topic for a busy run; view release preserves the old draft and never closes execution.');
  report.ok = true;
}).catch(error => { report.error = String(error.stack || error); process.exitCode = 1; }).finally(() => {
  const output = path.join(client, '..', 'outputs', 'session-isolation-20261020');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'new-session.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(report.ok ? 0 : 1);
});
