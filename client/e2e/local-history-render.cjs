'use strict';

// Exercise the passive history contract with real SQLite, Electron DOM and
// mouse navigation. All storage and identities belong to this isolated fixture.
const electron = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
if (typeof electron === 'string') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-render-'));
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  for (const phase of ['seed', 'reopen']) {
    const result = require('node:child_process').spawnSync(electron, [__filename, root, phase],
      { env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
    if (result.error || result.status !== 0) {
      console.error(result.error || 'History rendering phase failed: ' + phase);
      process.exit(1);
    }
  }
  console.log(JSON.stringify({ ok: true, root, processes: 2 }));
} else {
  const { app, BrowserWindow } = electron;
  const root = process.argv[2], phase = process.argv[3], client = path.resolve(__dirname, '..');
  app.setPath('userData', path.join(root, 'profile'));
  app.on('window-all-closed', () => {});
  const report = { ok: false, phase, cases: [], errors: [],
    boundary: 'Isolated source SQLite and native Pi archive, production passive reader and message renderer, real Electron mouse input; no user account, network or model.' };
  let win, history;
  const js = code => win.webContents.executeJavaScript(code, true);
  async function click(id) {
    const point = await js(`(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  }
  app.whenReady().then(async () => {
    global.fetch = async () => { throw Error('Passive history must not contact a server'); };
    const file = path.join(app.getPath('userData'), 'pi-agent', 'sessions', 'native.jsonl');
    const row = { id: 'native', path: file, adapterId: 'pi', title: 'Native history', count: 2 };
    const store = require('../main/conversation/replica-store.cjs').createWorker(path.join(root, 'history.sqlite'));
    history = require('../main/conversation/shared-history.cjs').create({ app, store,
      session: { archivedConversation: async () => row, historyEntry: async () => ({ ok: true, entry: row }),
        findBySessionId: () => null } });
    if (phase === 'seed') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, [
        { type: 'session', id: 'native' },
        { type: 'message', id: 'u', message: { role: 'user', content: 'Native question' } },
        { type: 'message', id: 'a', message: { role: 'assistant', content: [{ type: 'text', text: 'Native saved answer' }] } },
      ].map(value => JSON.stringify(value)).join('\n'));
      await history.projectRows([row]);
      const [cached] = await store.register([{ id: 'copy', cached: true, adapterId: 'account-sync', title: 'Cached history' }]);
      const messages = Array.from({ length: 5 }, (_, i) => [
        { id: 'u' + i, role: 'user', text: 'Saved question ' + i, done: true },
        ...(i > 0 ? [{ id: 'usage' + i, role: 'assistant', text: '', done: true }] : []),
        { id: 'a' + i, role: 'assistant', text: 'Saved answer ' + i + ' <script>window.historyInjected=true</script>', done: true },
      ]).flat();
      await store.cache('copy', messages, { expectedRevision: cached.replicaRevision, complete: true });
    }
    const original = fs.readFileSync(file);
    const saved = JSON.stringify(await store.messages('copy'));
    const snapshots = {};
    for (const id of ['copy', 'native']) {
      const view = await history.open(id);
      snapshots[id] = view.snapshot();
      assert.equal((await view.send('Do not execute')).accepted, false);
      await view.close();
    }
    win = new BrowserWindow({ show: false, width: 1050, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }));
    const fixture = path.join(root, 'fixture.html');
    fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><style>body{font:16px sans-serif}.nbubble{padding:10px}.user{text-align:right}button{padding:16px}</style>' +
      '<button id="copy">Cached history</button><button id="native">Native history</button><div id="nchatScroll"><div id="nchatList"></div></div>');
    await win.loadFile(fixture);
    for (const module of ['chat-context-meter', 'chat-scroll-follow', 'chat-markdown', 'chat-acceptance-results', 'chat-turn-summary', 'chat-message-renderer'])
      await js(fs.readFileSync(path.join(client, 'components/panels/' + module + '.js'), 'utf8'));
    await js(`window.snapshots=${JSON.stringify(snapshots)};
      window.ChatTools={patchList:(host,html)=>{host.innerHTML=html},paintSendButton(){},
        goalProgressRows:()=>[],appendTimeline(){},appendGoalProgress(){}};
      window.ctx={esc:s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
        _ref:'history',_pending:'',_sessionOptions:{},_messageWindowSize:80,_liveTextKey:'',
        _openThink:new Set(),_openTool:new Set(),_hotToolBodies:new Set(),_openToolGroup:new Set(),
        _outs:[],_pendingAttachmentNames:[],_pendingPlugins:[],_collabTasks:new Map(),_collabStarts:new Set(),
        _mount:()=>document,_collabEntries:()=>[],_renderQueue(){},_syncThinkingClock(){},_syncSlowStatusTicker(){},
        _turnMetricsHtml:()=>'',_thinkingStatusHtml:()=>'',_renderTaskStartPrompt(){}};
      window.renderer=ChatMessageRenderer.create(ctx);
      window.openView=id=>{ctx._ref=id;ctx._snap=snapshots[id];renderer.reset();renderer._render()};
      for(const id of ['copy','native'])document.getElementById(id).onclick=()=>openView(id);openView('copy');`);
    for (let i = 0; i < 5; i++) {
      await click('copy');
      assert.equal(await js('document.querySelectorAll(".nmsg.ai").length'), 5);
      for (let answer = 0; answer < 5; answer++)
        assert.ok(await js(`document.getElementById('nchatList').innerText.includes('Saved answer ${answer}')`));
      assert.equal(await js('window.historyInjected === true'), false);
      await click('native');
      assert.equal(await js('document.querySelectorAll(".nmsg.ai").length'), 1);
      assert.ok(await js('document.getElementById("nchatList").innerText.includes("Native saved answer")'));
    }
    assert.deepEqual(fs.readFileSync(file), original);
    assert.equal(JSON.stringify(await store.messages('copy')), saved);
    report.cases.push('Five cached answers and one native answer render during repeated mouse navigation.');
    report.cases.push('Stored text remains unchanged and untrusted markup does not execute.');
    if (phase === 'reopen') report.cases.push('A new Electron process reopens the same persisted history.');
    assert.deepEqual(report.errors, []);
    report.ok = true;
  }).catch(error => { report.errors.push(error.stack || String(error)); }).finally(async () => {
    await history?.close();
    fs.writeFileSync(path.join(root, phase + '.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
