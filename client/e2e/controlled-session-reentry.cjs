'use strict';

// Real Electron input and DOM with production status/queue renderers. Runtime
// snapshots are isolated controller fixtures; no account or model is contacted.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..');
  const out = path.resolve(client, '../../outputs/session-reentry-20261108');
  fs.mkdirSync(out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-reentry-ui-'));
  app.setPath('userData', profile);
  const report = { ok: false, cases: [], errors: [], boundary: 'Isolated Electron mouse input and production renderer modules; controlled snapshots, no authentication, business data or external model.' };
  let win;
  const js = source => win.webContents.executeJavaScript(source, true);
  async function click(id) {
    const point = await js(`(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1100, height: 740,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) report.errors.push(message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }));
    const base = require('node:url').pathToFileURL(client + path.sep).href;
    const fixture = path.join(out, 'controlled-reentry.html');
    fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><base href="' + base + '">' +
      '<link rel="stylesheet" href="theme/variables.css"><link rel="stylesheet" href="components/panels/panels-chat.css">' +
      '<style>body{font:16px sans-serif;padding:24px}button{padding:12px;margin-right:12px}#nchatList{margin-top:30px;min-height:180px}</style>' +
      '<button id="chat-a">Conversation A</button><button id="chat-b">Conversation B</button>' +
      '<div id="nchatList"></div><div id="nchatQueue"></div>');
    await win.loadFile(fixture);
    for (const file of ['components/panels/panels-chat-status.js', 'components/panels/chat-send-queue.js'])
      await js(fs.readFileSync(path.join(client, file), 'utf8'));
    const projected = require('../main/pi-session/controlled-execution-snapshot.cjs').project({
      taskId: 'fixture-task', status: 'running', timing: { startedAt: 1000000, updatedAt: 1000000 } }, 'fixture-turn', 1013000);
    await js(`window.now=1013000;Date.now=()=>window.now;
      window.a=${JSON.stringify(projected)};a.messages=[{role:'user',text:'Isolated requirement',sentAt:1000000}];
      a.execution.turnQueue={activeQueueId:'fixture-turn',activeTaskId:'fixture-task',tasks:[]};a.execution.queue=[];
      a.execution.taskExecutions=[{taskId:'fixture-task',status:'running'}];
      window.entry={taskId:'fixture-task',task:{id:'fixture-task',title:'Isolated requirement',status:'doing'}};
      window.ctx={_ref:'',_sessionId:'',_snap:null,_localQueue:[],_collabEntries:()=>[entry],_collabTasks:new Map([['fixture-task',entry]]),_collabEntryStatus:()=>'',esc:s=>String(s).replaceAll('<','&lt;')};
      window.view=ChatStatus.createThinking(()=>({ref:ctx._ref,sessionId:ctx._sessionId,snap:ctx._snap,document}));
      window.queue=ChatSendQueue.create(ctx);
      window.openView=id=>{view.stopThinkingClock();ctx._ref=id;ctx._sessionId=id;ctx._snap=id==='a'?a:{status:'idle',messages:[],execution:{}};
        const busy=ChatStatus.runtimeBusy(ctx._snap);view.syncThinkingClock(busy);
        document.getElementById('nchatList').innerHTML=view.metricsHtml(busy)+view.statusHtml(busy);queue._renderQueue(document);};
      document.getElementById('chat-a').onclick=()=>openView('a');document.getElementById('chat-b').onclick=()=>openView('b');openView('a');`);
    const elapsed = () => js("document.querySelector('[data-thinking-elapsed]').textContent");
    assert.equal(await elapsed(), '13s');
    await click('chat-b'); await js('now+=2000;a.execution.elapsedMs=15000'); await click('chat-a');
    assert.equal(await elapsed(), '15s');
    report.cases.push('Mouse switching A to B to A restores the same active-turn elapsed time.');
    await js("a.status='waiting-user';a.statusText='正在重新连接执行记录；后续需求继续等待';a.execution.running=false;a.execution.controlled.status='waiting';a.execution.controlled.waitingReason='connection';a.execution.taskExecutions[0]={taskId:'fixture-task',status:'waiting',waitingReason:'connection'};openView('a')");
    await click('chat-b'); await js('now+=20000'); await click('chat-a');
    assert.equal(await elapsed(), '15s');
    await js('view.setDialogFocused(false);view.setDialogFocused(true)');
    const waiting = await js("document.getElementById('nchatList').innerText+' '+document.getElementById('nchatQueue').innerText");
    assert.match(waiting, /重新连接执行记录/); assert.match(waiting, /等待连接/);
    assert.doesNotMatch(waiting, /正在理解|等待输入|处理中|团队协作/);
    assert.equal(await js("document.querySelectorAll('[data-chat-node=runtime-status] .ndot').length"), 0);
    report.cases.push('Reconnect reason survives navigation; waiting neither animates thinking nor asks for chat input.');
    fs.writeFileSync(path.join(out, 'waiting-ui.png'), (await win.webContents.capturePage()).toPNG());
    await js("a.status='streaming';a.statusText='';a.execution.running=true;a.execution.elapsedMs=35000;a.execution.controlled.status='running';a.execution.taskExecutions[0]={taskId:'fixture-task',status:'running'};openView('a')");
    await click('chat-b'); await click('chat-a'); assert.equal(await elapsed(), '35s');
    assert.doesNotMatch(await js("document.getElementById('nchatList').innerText"), /重新连接/);
    report.cases.push('Recovered execution returns to live progress with no stale reconnect text.');
    assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(error => { report.errors.push(error.stack || String(error)); process.exitCode = 1; }).finally(() => {
    fs.writeFileSync(path.join(out, 'electron-ui-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
