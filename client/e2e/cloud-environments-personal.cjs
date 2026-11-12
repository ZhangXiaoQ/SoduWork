'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');
require('./lib/isolated-profile.cjs').isolateProfile(app, 'cloud-environments-personal');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute output directory required');
let win;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = source => win.webContents.executeJavaScript(source, true);
async function until(source) { for (let i = 0; i < 160; i++) { if (await js('Boolean(' + source + ')')) return; await sleep(30); } throw Error('Timed out: ' + source); }
async function resize(width, height) {
  win.setSize(width, height);
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
}
async function click(selector) {
  const pt = await js('(async()=>{const e=document.querySelector(' + JSON.stringify(selector) + ');if(!e||e.disabled)throw Error("Unavailable click target");e.scrollIntoView({block:"nearest",inline:"nearest",behavior:"instant"});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error("Click target is occluded: " + ' + JSON.stringify(selector) + ');return{x,y}})()');
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...pt });
  await sleep(70);
}
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1100, height: 820, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, 'fixtures/cloud-environments.html'));
  win.webContents.debugger.attach('1.3');
  await resize(1100, 820);
  await until('document.querySelector("#cloudEnvironmentPanel")');
  assert.equal(await js('document.querySelector(".ce-routing")'), null);
  assert.equal(await js('getComputedStyle(document.querySelector(".ce-server")).backgroundImage'), 'none');
  await js('window.originalServer=document.querySelector(".ce-server"); document.querySelector(".ce-server-details").open=true; fixture.nodes[0].lastSeen=123; CloudEnvironments.refresh(); void 0');
  await until('!document.querySelector("[data-ce-refresh]").disabled');
  assert.equal(await js('window.originalServer === document.querySelector(".ce-server") && document.querySelector(".ce-server-details").open'), true);
  await js('fixture.nodes=[]; CloudEnvironments.refresh(); void 0');
  await until('document.querySelector(".ce-empty") && !document.querySelector("[data-ce-add]").disabled');
  await click('[data-ce-add]');
  await until('document.querySelector("dialog")');
  await js('document.querySelector("input[name=name]").value="我的专属电脑"; document.querySelector("input[name=host]").value="192.0.2.8"; document.querySelector("input[name=username]").value="runner"; document.querySelector("input[name=password]").value="synthetic-password"; document.querySelector("input[name=hub]").value="https://soduwork.example.test"; document.querySelector("input[name=workRoot]").value="/srv/work"; void 0');
  await js('SoduWorkAPI.addCloudEnvironment = async input => ({ok:true, environment:{id:"personal",name:input.name,canManage:true,status:"pending",workRoot:input.workRoot,credential:{configured:true,canRotate:true}}, setup:{runnerId:"personal", key:"first-secret-123456789", hub:"https://soduwork.example.test", commands:{linux:"curl https://soduwork.example.test/api/v1/download/runner-install.sh --id personal --key first-secret-123456789"}}}); void 0');
  await js('document.querySelector("dialog [type=submit]").click(); void 0');
  await until('!document.querySelector("dialog").hasAttribute("aria-busy")');
  const cloudCalls = await js('fixture.cloudCalls');
  const testCall = cloudCalls.find(call => call[0] === 'test');
  const saveCall = cloudCalls.find(call => call[0] === 'save');
  const installCall = cloudCalls.find(call => call[0] === 'install');
  // The remote install command still uses the public/recommended Hub, but the
  // local encrypted credential profile must stay scoped to the active Hub
  // origin. This is what lets a development client use a LAN-reachable Hub
  // address without failing the first SSH test before enrollment.
  assert.equal(testCall?.[1]?.credential?.hub, 'http://127.0.0.1:9080');
  assert.equal(saveCall?.[1]?.credential?.hub, 'http://127.0.0.1:9080');
  assert.equal(installCall?.[1]?.credential?.hub, 'http://127.0.0.1:9080');
  assert.equal(await js('localStorage.length'), 0);
  assert.match(await js('document.querySelector("dialog .ce-onetime h3").textContent'), /Runner 安装已完成/);
  assert.equal(await js('document.querySelector("dialog").dataset.created'), 'true');
  assert.equal(await js('document.querySelector("dialog [type=submit]").disabled'), false);
  await js('document.querySelector("dialog [type=submit]").click(); void 0');
  await until('!document.querySelector("dialog")');
  await js('fixture.successfulInstall=soduWorkAPI.cloudComputer.install; fixture.enroll=SoduWorkAPI.addCloudEnvironment; void 0');
  for (const failure of ['result', 'rejection']) {
    const message = failure === 'result' ? '请从当前云端环境向导重新获取一次性安装指令' : 'fixture SSH 安装连接中断';
    await js(`(() => {
      fixture.nodes=[]; fixture.enrollmentCount=0;
      SoduWorkAPI.addCloudEnvironment=async input => {
        fixture.enrollmentCount++;
        const result=await fixture.enroll(input); fixture.nodes=[result.environment]; return result;
      };
      soduWorkAPI.cloudComputer.install=async () => {
        if (${JSON.stringify(failure)} === 'rejection') throw Error(${JSON.stringify(message)});
        return {ok:false,code:'SETUP_RESPONSE_REQUIRED',error:${JSON.stringify(message)}};
      };
      CloudEnvironments.refresh();
    })()`);
    await until('document.querySelector(".ce-empty") && !document.querySelector("[data-ce-add]").disabled');
    await click('[data-ce-add]');
    await js('document.querySelector("input[name=name]").value="安装待完成"; document.querySelector("input[name=host]").value="192.0.2.8"; document.querySelector("input[name=username]").value="runner"; document.querySelector("input[name=password]").value="synthetic-password"; void 0');
    await click('dialog [type=submit]');
    await until('document.querySelector("dialog")?.dataset.created === "true" && !document.querySelector("dialog").hasAttribute("aria-busy")');
    assert.equal(await js('document.querySelector("dialog .ce-onetime h3").textContent'), '连接测试通过，但 Runner 安装未完成');
    assert.equal(await js('document.querySelector("dialog .ce-onetime p").textContent'), message);
    assert.match(await js('document.querySelector("dialog pre").textContent'), /--id personal --key first-secret-123456789/);
    assert.equal(await js('document.querySelector("dialog [data-ce-copy]").textContent'), '复制安装命令');
    await until('document.querySelector("[data-ce-server=personal]")');
    assert.equal(await js('localStorage.length'), 0);
    await click('dialog [type=submit]');
    await until('!document.querySelector("dialog")');
    assert.equal(await js('fixture.enrollmentCount'), 1, 'finishing a partial setup must not enroll twice');
  }
  await js('soduWorkAPI.cloudComputer.install=fixture.successfulInstall; SoduWorkAPI.addCloudEnvironment=fixture.enroll; void 0');
  await js('fixture.nodes=[{id:"personal",name:"我的专属电脑",canManage:true,status:"offline",workRoot:"/srv/work",credential:{configured:true,canRotate:true}}]; SoduWorkAPI.cloudEnvironments=async()=>({ok:true,environments:fixture.nodes,ownership:"personal",permissions:{canCreate:false,limit:1,canManage:true},service:{recommendedHub:"https://soduwork.example.test"}}); CloudEnvironments.refresh(); void 0');
  await until('document.querySelector("[data-ce-server=personal]")');
  await click('[data-ce-connection="personal"]');
  await until('document.querySelector("dialog")');
  await js('document.querySelector("input[name=host]").value="192.0.2.9"; document.querySelector("input[name=username]").value="runner"; document.querySelector("input[name=password]").value="synthetic-password-2"; void 0');
  await click('dialog [type=submit]');
  await until('!document.querySelector("dialog").hasAttribute("aria-busy")');
  assert.match(await js('document.querySelector("dialog .ce-onetime h3").textContent'), /连接信息已保存/);
  assert.match(await js('document.querySelector("dialog [data-ce-connection]").textContent'), /尚未连接/);
  assert.equal(await js('localStorage.length'), 0);
  // Finish the one-time connection dialog before exercising the page actions;
  // a native modal otherwise intentionally blocks clicks on the remove button.
  await js('document.querySelector("dialog [type=submit]").click(); void 0');
  await until('!document.querySelector("dialog")');
  // Existing SSH credentials restore Runner setup without a copy/paste round trip.
  await js(`fixture.reconnectCalls=[];
    soduWorkAPI.cloudComputer.get=async()=>({ok:true,configured:true});
    fixture.savedProbe=soduWorkAPI.cloudComputer.test;
    soduWorkAPI.cloudComputer.test=async()=>{fixture.reconnectCalls.push('probe');return {ok:false,error:'SSH unavailable'};};
    fixture.savedRotate=SoduWorkAPI.rotateCloudEnvironmentCredential;
    SoduWorkAPI.rotateCloudEnvironmentCredential=async(...args)=>{fixture.reconnectCalls.push('rotate');return fixture.savedRotate(...args);};
    fixture.savedInstall=soduWorkAPI.cloudComputer.install;
    soduWorkAPI.cloudComputer.install=async args=>{fixture.reconnectCalls.push('install');return fixture.savedInstall(args);};
    CloudEnvironmentSetup.rotate(fixture.nodes[0],()=>{}, {recommendedHub:'https://soduwork.example.test'}); void 0`);
  await click('dialog [type=submit]');
  await until('!document.querySelector("dialog").hasAttribute("aria-busy")');
  assert.deepEqual(await js('fixture.reconnectCalls'), ['probe'], 'failed SSH must not revoke the current Runner key');
  assert.match(await js('document.querySelector("dialog [role=alert]").textContent'), /SSH unavailable/);
  await js("soduWorkAPI.cloudComputer.test=async()=>{fixture.reconnectCalls.push('probe');return {ok:true};}; void 0");
  await click('dialog [type=submit]');
  await until('document.querySelector("dialog").dataset.created && !document.querySelector("dialog").hasAttribute("aria-busy")');
  assert.deepEqual(await js('fixture.reconnectCalls'), ['probe', 'probe', 'rotate', 'install']);
  assert.equal(await js('document.querySelector("dialog [data-ce-copy]")'), null);
  await click('dialog [type=submit]');
  await until('!document.querySelector("dialog")');
  await js('soduWorkAPI.cloudComputer.test=fixture.savedProbe; soduWorkAPI.cloudComputer.install=fixture.savedInstall; SoduWorkAPI.rotateCloudEnvironmentCredential=fixture.savedRotate; void 0');
  // Verify the actual user path for preparing a cloud Harness, including
  // narrow-window layout and the asynchronous install state transition.
  await js(`(() => {
    const row = fixture.nodes[0];
    Object.assign(row, { online: true, status: 'ready', statusText: '已连接', availableAgents: [
      { id: 'codex-harness', name: 'Codex Harness', summary: '适合代码任务', installable: true, ready: false },
      { id: 'opencode', name: 'OpenCode', summary: '通用智能体底座', installable: true, ready: false }
    ] });
    fixture.agentInstallCalls = [];
    fixture.agentPolls = 0;
    SoduWorkAPI.cloudEnvironments = async () => ({ ok: true, environments: fixture.nodes, ownership: 'personal', permissions: { canCreate: false, limit: 1, canManage: true }, service: { recommendedHub: 'https://soduwork.example.test' } });
    SoduWorkAPI.agentInstall = async (key, action, runnerId) => { fixture.agentInstallCalls.push([key, action, runnerId]); return { ok: true, jobId: 'fixture-agent-job' }; };
    SoduWorkAPI.agentJob = async () => {
      fixture.agentPolls += 1;
      if (fixture.agentPolls > 1) fixture.nodes[0].availableAgents[0].ready = true;
      return fixture.agentPolls > 1 ? { state: 'done', ok: true } : { state: 'running', ok: false };
    };
    CloudEnvironments.refresh();
  })()`);
  await until('document.querySelectorAll(".ce-harness").length === 2');
  assert.equal(await js('document.querySelectorAll(".ce-harness").length'), 2);
  assert.equal(await js('document.querySelector(".ce-harnesses h3").textContent'), '云端底座');
  assert.equal(await js('(() => { const p=document.querySelector(".ce-server"); return p.scrollWidth <= p.clientWidth && [...document.querySelectorAll(".ce-harness")].every(x => x.getBoundingClientRect().width > 0); })()'), true);
  await js('window.originalServer=document.querySelector(".ce-server"); document.querySelector(".ce-server-details").open=true; void 0');
  await js('document.querySelector("[data-ce-install-agent][data-ce-agent-key=\\"codex-harness\\"]").click(); void 0');
  await until("document.querySelector('[data-ce-harness=\\\"codex-harness\\\"] .ce-harness-status.is-ready')");
  assert.deepEqual(await js('fixture.agentInstallCalls[0]'), ['codex-harness', 'install', 'personal']);
  assert.ok(await js('fixture.agentPolls') >= 2);
  assert.equal(await js('document.querySelector(".ce-server-details").open'), true);
  await resize(390, 820);
  await sleep(80);
  assert.equal(await js('(() => { const p=document.querySelector(".ce-server"); return p.scrollWidth <= p.clientWidth && [...document.querySelectorAll(".ce-harness")].every(x => x.getBoundingClientRect().width <= p.clientWidth); })()'), true);
  const fs=require('node:fs'); fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'cloud-narrow.png'),(await win.webContents.capturePage()).toPNG());
  await resize(1100, 820);
  await sleep(80);
  fs.writeFileSync(path.join(output,'cloud-wide.png'),(await win.webContents.capturePage()).toPNG());
  // Keep controls visible with scaled fonts, long device names, and narrow windows while respecting theme backgrounds.
  const layoutOriginal = await js('JSON.parse(JSON.stringify(fixture.nodes[0]))');
  await js('fixture.nodes[0].os="Linux-4.19.91-26.an8.x86_64-x86_64-with-glibc2.28"; fixture.nodes[0].host=fixture.nodes[0].name; CloudEnvironments.refresh(); void 0');
  await until('!document.querySelector("[data-ce-refresh]").disabled');
  assert.equal(await js('document.querySelector(".ce-server-facts").textContent'), 'Linux · x86_64');
  assert.match(await js('document.querySelector(".ce-server-details").textContent'), /Linux-4\.19\.91/);

  await js('fixture.nodes[0].name="研发环境 / research-team-shared-cloud-environment"; fixture.nodes[0].host="research-cloud-long-host.internal.example.test"; document.documentElement.style.setProperty("--font-scale","1.25"); CloudEnvironments.refresh(); void 0');
  await until('!document.querySelector("[data-ce-refresh]").disabled');
  for (const width of [360, 760, 1400]) {
    await resize(width, 820); await sleep(80);
    assert.equal(await js('(() => { const p=document.querySelector(".ce-server"); return p.scrollWidth <= p.clientWidth + 1 && [...p.querySelectorAll("button")].every(x => x.getBoundingClientRect().right <= p.getBoundingClientRect().right + 1); })()'), true, 'no clipped controls at width ' + width);
  }
  await js('document.documentElement.style.setProperty("--bg-0","rgb(28, 30, 34)"); document.documentElement.style.setProperty("--bg-1","rgb(33, 36, 40)"); void 0');
  assert.equal(await js('getComputedStyle(document.querySelector(".ce-server")).backgroundColor'), 'rgb(28, 30, 34)');
  assert.equal(await js('getComputedStyle(document.querySelector(".ce-server-overview")).backgroundColor'), 'rgb(33, 36, 40)');
  await js('document.documentElement.style.removeProperty("--bg-0"); document.documentElement.style.removeProperty("--bg-1"); document.documentElement.style.removeProperty("--font-scale"); fixture.nodes[0]=' + JSON.stringify(layoutOriginal) + '; CloudEnvironments.refresh(); void 0');
  await until('!document.querySelector("[data-ce-refresh]").disabled');
  await resize(1100, 820); await sleep(80);
  // A failed installation must remain actionable and retry the same Harness,
  // instead of leaving a disabled or silently reset card.
  await js(`(() => {
    window.originalServer = document.querySelector('.ce-server');
    fixture.nodes[0].availableAgents[1].ready = false;
    fixture.agentPolls = 0; fixture.failOnce = true;
    SoduWorkAPI.agentJob = async () => {
      fixture.agentPolls += 1;
      if (fixture.failOnce) { fixture.failOnce = false; return { state: 'done', ok: false, detail: 'Runner 安装失败（fixture）' }; }
      fixture.nodes[0].availableAgents[1].ready = true;
      return { state: 'done', ok: true };
    };
  })()`);
  await js('document.querySelector("[data-ce-agent-key=\\"opencode\\"]").click(); void 0');
  await until('document.querySelector("[data-ce-harness=\\"opencode\\"] .ce-harness-error")');
  assert.equal(await js('window.originalServer === document.querySelector(".ce-server")'), true, 'job progress only replaces its own agent row');
  assert.equal(await js('document.querySelector("[data-ce-harness=\\"opencode\\"] [data-ce-install-agent]").textContent'), '重试');
  await js('document.querySelector("[data-ce-agent-key=\\"opencode\\"]").click(); void 0');
  await until("document.querySelector('[data-ce-harness=\\\"opencode\\\"] .ce-harness-status.is-ready')");
  // A stale installed record is not executable while its Runner is offline.
  await js('fixture.nodes[0].online=false; CloudEnvironments.refresh(); void 0');
  await until('!document.querySelector("[data-ce-refresh]").disabled');
  assert.equal(await js('document.querySelectorAll(".ce-harness[data-state=ready]").length'), 0);
  assert.equal(await js('[...document.querySelectorAll("[data-ce-install-agent]")].every(x=>x.disabled)'), true);
  await js('document.querySelector(".ce-more").open=true; void 0');
  await click('[data-ce-remove="personal"]');
  await until('document.querySelector("dialog .ce-remove-zone")');
  await click('dialog [type=submit]');
  await until('!document.querySelector("dialog") && document.querySelector(".ce-empty")');
  assert.deepEqual(await js('fixture.requests.find(x => x[0] === "delete")'), ['delete', 'personal']);
  // An old account's delayed local-credential lookup cannot repaint the new account.
  await js(`(() => {
    fixture.nodes = [{id:'stale-account',name:'Old account',online:true}];
    let first = true;
    soduWorkAPI.cloudComputer.status = () => first
      ? (first=false, new Promise(resolve => { fixture.resolveOldStatus=resolve; }))
      : Promise.resolve({ok:true,configured:false});
    CloudEnvironments.refresh();
  })()`);
  await until('fixture.resolveOldStatus');
  await js('fixture.owner="account-b"; fixture.nodes=[]; window.dispatchEvent(new Event("soduwork-data-scope-changed")); void 0');
  await until('document.querySelector(".ce-empty")');
  await js('fixture.resolveOldStatus({ok:true,configured:true}); void 0');
  await sleep(80);
  assert.equal(await js('document.querySelector("[data-ce-server=stale-account]")'), null);
  console.log(JSON.stringify({ok:true,cases:["personal environment SSH setup and automatic Runner install","failed and rejected SSH installs retain one-time commands without duplicate enrollment","cloud Harness card install job and narrow layout","connection settings update and no plaintext persistence"]}));
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error.stack || error); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); });

