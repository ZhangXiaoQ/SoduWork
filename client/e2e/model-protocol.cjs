'use strict';
// electron e2e/model-protocol.cjs <absolute evidence directory>
// Production renderer/styles/input handlers with synthetic catalog API responses.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw Error('Absolute evidence directory required');
fs.mkdirSync(root, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-protocol-ui-')));
const report = { ok: false, cases: [], errors: [] };
let win;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = source => win.webContents.executeJavaScript(source);
async function until(source) {
  for (let i = 0; i < 100; i++) { if (await js(source)) return; await wait(30); }
  throw Error('Timed out: ' + source);
}
async function click(selector) {
  const point = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
    el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
    if(!el.contains(document.elementFromPoint(x,y)))throw Error('Click target obscured');return {x,y}})()`);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
}
async function run() {
  const isolated = session.fromPartition('model-protocol-isolated');
  isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  win = new BrowserWindow({ show: false, width: 1440, height: 950, webPreferences: {
    session: isolated, nodeIntegration: false, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, 'fixtures/model-settings.html'));
  await until('document.querySelectorAll(".md-nav-item").length===6');
  await js(`SoduWorkI18n.setLocale('zh-CN',{persist:false,broadcast:false});
    fixture.providers.find(p=>p.id==='claude').personal=true;
    SoduWorkAPI.testMyModel=async id=>{testCalls.push(id);return {ok:true,probe:'models',protocol:'anthropic',gatewayCompatible:false,
      detail:'模型列表可访问；尚未验证聊天生成、余额或当前 Agent 的协议兼容性'}};
    _mdLoad();void 0`);
  await click('[data-mdselect="claude"]');
  await until('document.querySelector("[data-pkind]")?.value==="anthropic"');
  assert.match(await js('document.querySelector(".cfg-detail").textContent'), /Anthropic 协议.*OpenAI 兼容/);
  assert.match(await js('document.querySelector(".cfg-detail").textContent'), /最小聊天请求，可能产生用量/);
  report.cases.push('Anthropic editor explains gateway boundary and connection-test usage before testing');
  await click('[data-ptest]');
  await until('document.querySelector(".md-test-r.is-ok")');
  assert.match(await js('document.querySelector(".md-test-r").textContent'), /尚未验证聊天生成、余额/);
  assert.match(await js('document.querySelector("[role=note]").textContent'), /不能用于当前企业模型对话通道/);
  report.cases.push('successful discovery remains explicitly limited and does not remove protocol warning');
  await js('document.querySelector("[data-pkind]").focus()');
  for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Home' });
  await until('document.querySelector("[data-pkind]")?.value==="openai-compat"');
  assert.equal(await js('!!document.querySelector("[role=note]")'), false);
  assert.equal(await js('document.querySelector("#mdSave").disabled'), false);
  report.cases.push('native keyboard protocol selection updates warning and preserves save action');
  await click('#mdSave');
  await until('saved.length>0 && document.querySelector("#mdSave").disabled');
  assert.equal(await js('saved.at(-1).providers.find(p=>p.id==="claude").kind'), 'openai-compat');
  await js('document.querySelector("[data-pkind]").focus()');
  for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'End' });
  await until('!!document.querySelector("[role=note]")');
  win.setSize(820, 700); await wait(100);
  await click('[data-ptest]'); await until('document.querySelector(".md-test-r.is-ok")');
  assert.equal(await js('document.querySelector("#mdBody").scrollWidth<=document.querySelector("#mdBody").clientWidth+1'), true);
  report.cases.push('820px layout retains reachable test button and no horizontal overflow');
  await js('document.querySelector("[role=note]").scrollIntoView({block:"center"})');
  await wait(250);
  win.webContents.invalidate();
  await wait(250);
  fs.writeFileSync(path.join(root, 'anthropic-warning.png'), (await win.webContents.capturePage()).toPNG());
  await js("SoduWorkI18n.setLocale('en-US',{persist:false,broadcast:false});void 0");
  assert.match(await js('document.querySelector("[role=note]").textContent'), /OpenAI-compatible/);
  report.cases.push('English protocol guidance is translated in the real renderer');
  await js(fs.readFileSync(path.join(__dirname, '../components/panels/panels-agents.js'), 'utf8'));
  await js(`SoduWorkI18n.setLocale('zh-CN',{persist:false,broadcast:false});
    window.defaultWrites=[];
    window.agentFixture={modelCount:2,models:[{name:'openai-model',providerKind:'openai-compat'},
      {name:'anthropic-model',providerKind:'anthropic'}],machines:[{runnerId:'fixture-runner',scope:'current-instance',
      label:'Isolated computer',env:{ok:true},agents:[{key:'pi',name:'Pi',state:'ready',setupState:'ready',installed:true,
        present:true,bundled:true,modelPick:true,model:'openai-model',modelEffective:'openai-model'}]}]};
    SoduWorkAPI.localAgentSetup=async()=>structuredClone(agentFixture);
    SoduWorkAPI.setAgentModel=async(key,value)=>{
      const note=document.querySelector('.ag-model [role=note]'),r=note?.getBoundingClientRect();
      defaultWrites.push({key,value,warning:note?.textContent,visible:!!r&&r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight});
      agentFixture.machines[0].agents[0].model=value;return {ok:true};};
    closeModelsPanel();WorkspaceShell.setActive('agents');openAgentsPanel();void 0`);
  win.setSize(1100, 1000);
  await until('!!document.querySelector("[data-atoggle]")');
  await click('[data-atoggle="fixture-runner~pi"]');
  await until('!!document.querySelector("[data-amodel]")');
  await js('document.querySelector(".ag-model [role=note]").scrollIntoView({block:"center"})');
  assert.equal(await js('defaultWrites.length'), 0);
  assert.match(await js('document.querySelector(".ag-model [role=note]").textContent'), /只支持 OpenAI 兼容协议/);
  await js('document.querySelector("[data-amodel]").focus()');
  for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'End' });
  await until('defaultWrites.length===1 && document.querySelector("[data-amodel]")?.value==="anthropic-model" && !document.querySelector("[data-amodel]").disabled');
  const savedDefault = await js('defaultWrites[0]');
  assert.equal(savedDefault.key, 'pi'); assert.equal(savedDefault.value, 'anthropic-model');
  assert.equal(savedDefault.visible, true);
  assert.match(savedDefault.warning, /只支持 OpenAI 兼容协议/);
  report.cases.push('managed Agent default warning is visible before native selection and before autosave; chosen default persists');
  await js("SoduWorkI18n.setLocale('en-US',{persist:false,broadcast:false});void 0");
  assert.match(await js('document.querySelector(".ag-model [role=note]").textContent'), /OpenAI-compatible protocols only/);
  report.cases.push('pre-save Agent default guidance translates to English');
  assert.deepEqual(await js('errors'), []);
  report.ok = true;
}
app.whenReady().then(run).catch(error => { report.error = error.stack; }).finally(async () => {
  if (win && !win.isDestroyed()) { report.errors = await js('errors').catch(() => []); win.destroy(); }
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
});
