'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE','ELECTRON_NO_ATTACH_CONSOLE','CHROME_DEVEL_SANDBOX']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], { env, stdio: 'inherit', windowsHide: true });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-access-ui-'));
app.setPath('userData', path.join(root, 'profile'));
const out = path.resolve(__dirname, '../../outputs/access-e2e'); fs.mkdirSync(out, { recursive: true });
let win, fixture;
const report = { ok: false, cases: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function pending() { for (let n=0;n<300;n++) { const r=fixture.access.broker.pending()[0];if(r)return r;await delay(10); }throw Error('Approval did not appear'); }
async function click(decision) {
  const rect = await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('[data-ui-value="${decision}"]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', ...rect, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...rect, button: 'left', clickCount: 1 });
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 800, height: 660, webPreferences: {
    preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  fixture = await require('./fixtures/access-sdk.cjs').create(root);
  const handle = { attachedWindow: win, cwd: fixture.workspace, answerUi: value => fixture.access.broker.answer(value),
    snapshot: () => ({ ...fixture.access.snapshot(), accessControl: { supported: true, canChangeDuringSession: true,
      modes: ['standard','readonly','full'] } }),
    setAccessPolicy(policy) { fixture.access.upgradeToFull(policy); return { ok: true, effective: 'current-turn' }; } };
  let fullConfirmations = 0;
  function HiddenConsent(options) {
    const dialog = new BrowserWindow({ ...options, webPreferences: { ...options.webPreferences, backgroundThrottling: false } });
    dialog.show = () => {}; dialog.focus = () => {}; return dialog;
  }
  const nativeConsent = require('../main/access-control/full-access-consent').create({ ...electron, BrowserWindow: HiddenConsent,
    themeSource: { snapshot: () => ({ theme: 'azure', tokens: {} }), subscribe: () => () => {} } });
  const dialogReady = async () => {
    for (let n = 0; n < 300; n++) {
      const dialog = BrowserWindow.getAllWindows().find(row => row.getParentWindow() === win);
      if (dialog && await dialog.webContents.executeJavaScript('document.body.dataset.ready === "true"')) return dialog;
      await delay(15);
    }
    throw Error('Full access native confirmation did not load');
  };
  const clickConsent = async (dialog, selector) => {
    const rect = await dialog.webContents.executeJavaScript('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');e.scrollIntoView({block:"nearest"});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
    for (const type of ['mouseDown', 'mouseUp']) dialog.webContents.sendInputEvent({ type, ...rect, button: 'left', clickCount: 1 });
    await delay(80);
  };
  ipcMain.handle('pi-session-set-access-mode', require('../main/access-control/ipc').changeHandler({
    session: { get: ref => ref === 'access-e2e' ? handle : null }, BrowserWindow,
    confirmFullAccess: async (...args) => { fullConfirmations++; return nativeConsent(...args); },
  }));
  ipcMain.handle('pi-session-answer-ui', require('../main/access-control/ipc').answerHandler({ get: ref => ref === 'access-e2e' ? handle : null }));
  await win.loadFile(path.join(__dirname, 'fixtures/access-controls.html'));
  await fixture.send('write', { path: 'normal.txt', content: 'normal write' });
  assert.equal(fs.readFileSync(path.join(fixture.workspace, 'normal.txt'), 'utf8'), 'normal write');
  report.cases.push('ordinary write completes without confirmation');
  const outside = path.join(root, 'outside.txt');
  let turn = fixture.send('write', { path: outside, content: 'denied' });
  let request = await pending(); assert.equal(fs.existsSync(outside), false);
  await win.webContents.executeJavaScript('draw('+JSON.stringify(request)+')');
  await click('deny'); await turn; assert.equal(fs.existsSync(outside), false);
  report.cases.push('real mouse → production UI → preload → production IPC → Pi denial leaves no file');
  turn = fixture.send('write', { path: outside, content: 'approved' }); request = await pending();
  await win.webContents.executeJavaScript('draw('+JSON.stringify(request)+',"en-US")');
  const approvalText = await win.webContents.executeJavaScript('document.body.innerText');
  assert.match(approvalText, /Allow modifying this file\?/);
  assert.doesNotMatch(approvalText, /Allow for chat/);
  assert.match(approvalText, /Allow once/);
  fs.writeFileSync(path.join(out,'approval-en.png'),(await win.webContents.capturePage()).toPNG());
  await click('once'); await turn; assert.equal(fs.readFileSync(outside,'utf8'),'approved');
  const stale = await win.webContents.executeJavaScript('soduWorkAPI.conversationSession.answerUi("access-e2e",'+JSON.stringify({...request,decision:'once'})+')');
  assert.equal(stale.ok,false); report.cases.push('allow once resumes real write; replay denied');
  turn=fixture.send('write',{path:outside,content:'session grant'});request=await pending();
  win.setSize(390,660);await win.webContents.executeJavaScript('draw('+JSON.stringify(request)+',"zh-CN")');await delay(100);
  assert.equal(await win.webContents.executeJavaScript('document.documentElement.scrollWidth<=innerWidth'),true);
  fs.writeFileSync(path.join(out,'approval-zh-small.png'),(await win.webContents.capturePage()).toPNG());
  assert.equal(await win.webContents.executeJavaScript('document.querySelector("[data-ui-value=session]")===null'), true);
  // Keep regression coverage for older clients' grants through the existing IPC.
  await win.webContents.executeJavaScript('soduWorkAPI.conversationSession.answerUi("access-e2e",'+JSON.stringify({...request,decision:'session'})+')');await turn;
  await fixture.send('write',{path:outside,content:'session grant'});assert.equal(fixture.access.broker.pending().length,0);
  await fixture.send('write',{path:outside,content:'session grant changed'});assert.equal(fixture.access.broker.pending().length,0);
  assert.equal(fs.readFileSync(outside,'utf8'),'session grant changed');
  report.cases.push('session grant UI removed; existing backend grants remain compatible; Chinese small window fits');
  const cancelled = path.join(root, 'outside-cancel.txt');
  turn=fixture.send('write',{path:cancelled,content:'cancelled'});await pending();await fixture.session.abort();await turn;
  assert.equal(fs.readFileSync(outside,'utf8'),'session grant changed');assert.equal(fs.existsSync(cancelled),false);assert.equal(fixture.access.broker.pending().length,0);
  await fixture.send('write',{path:'after-cancel.txt',content:'continues'});
  assert.equal(fs.existsSync(path.join(fixture.workspace,'after-cancel.txt')),true);
  report.cases.push('stop while waiting denies write; following turn works');
  const fullTarget = path.join(root, 'full-access.txt');
  turn = fixture.send('write', { path: fullTarget, content: 'full consent' }); request = await pending();
  for (const lang of ['zh-CN', 'en-US']) {
    win.setSize(390, 660);
    await win.webContents.executeJavaScript('draw(' + JSON.stringify(request) + ',' + JSON.stringify(lang) +
      ',{ref:"access-e2e",fullRevision:' + fixture.access.policy.revision + '})');
    await delay(100);
    assert.equal(await win.webContents.executeJavaScript('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("[data-ui-value=full]").textContent'), lang === 'zh-CN' ? '始终允许' : 'Always allow');
    const group = await win.webContents.executeJavaScript('(()=>{const g=document.querySelector(".nask-btns"),buttons=[...g.children],r=buttons.map(b=>b.getBoundingClientRect());return{order:buttons.map(b=>b.dataset.uiValue),sameRow:r.every(x=>Math.abs(x.top-r[0].top)<1&&Math.abs(x.height-r[0].height)<1),gap:getComputedStyle(g).gap,overflow:g.scrollWidth>g.clientWidth+1}})()');
    assert.deepEqual(group.order, ['deny', 'once', 'full']);
    assert.equal(group.sameRow, true); assert.equal(group.gap, '8px'); assert.equal(group.overflow, false);
    const fullStyle = await win.webContents.executeJavaScript('(()=>{const b=document.querySelector("[data-ui-value=full]"),s=getComputedStyle(b);return {background:s.backgroundColor,color:s.color}})()');
    assert.equal(fullStyle.background, 'rgb(24, 24, 27)'); assert.equal(fullStyle.color, 'rgb(255, 255, 255)');
    fs.writeFileSync(path.join(out, 'approval-full-' + lang + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  await click('full'); let dialog = await dialogReady();
  assert.equal(await dialog.webContents.executeJavaScript('document.querySelector("#consentAllow").disabled'), true);
  await clickConsent(dialog, '#consentCancel'); await delay(100);
  assert.equal(fullConfirmations, 1); assert.equal(fixture.access.policy.mode, 'standard');
  assert.equal(fs.existsSync(fullTarget), false); assert.equal(fixture.access.broker.pending().length, 1);
  assert.equal(await win.webContents.executeJavaScript('document.querySelector("[data-ui-value=once]").disabled'), false);
  await click('full'); dialog = await dialogReady();
  await clickConsent(dialog, '#consentAcknowledged'); await clickConsent(dialog, '#consentAllow'); await turn;
  assert.equal(fullConfirmations, 2); assert.equal(fixture.access.policy.mode, 'full');
  assert.equal(fs.readFileSync(fullTarget, 'utf8'), 'full consent');
  await fixture.send('write', { path: path.join(root, 'full-next.txt'), content: 'no repeat approval' });
  assert.equal(fixture.access.broker.pending().length, 0);
  report.cases.push('Full access calls production access-change IPC and consent hook: cancellation preserves pending tool; consent resumes it once and permits subsequent operations');
  win.setSize(640,660);await win.webContents.executeJavaScript('drawComposer()');await delay(400);
  assert.equal(await win.webContents.executeJavaScript('document.documentElement.scrollWidth<=innerWidth'),true);
  assert.equal(await win.webContents.executeJavaScript("!document.querySelector('#cpMorePop').contains(document.querySelector('#cpPermission'))"),true);
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#cpPermissionPop [data-mode=standard]').textContent.includes('默认权限')"),true);
  fs.writeFileSync(path.join(out,'composer-access-small.png'),(await win.webContents.capturePage()).toPNG());
  report.cases.push('production new-chat composer exposes permission choice and fits a narrow window');
  report.ok=true;
}).catch(error=>{report.error=error.stack||String(error);}).finally(async()=>{
  try{if(fixture)await fixture.close();}catch(error){report.cleanupError=String(error);report.ok=false;}
  if(win&&!win.isDestroyed())win.destroy();
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
  try { fs.rmSync(root,{recursive:true,force:true}); } catch (_) { /* Chromium holds the isolated profile until exit on Windows. */ }
  app.exit(report.ok?0:1);
});
