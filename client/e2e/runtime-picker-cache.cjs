'use strict';

// Real Electron rendering uses production composer code and an isolated,
// controllable inventory service. No account, runtime or model is contacted.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const electron = require('electron');

if (typeof electron === 'string') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-picker-cache-'));
  const env = { ...process.env, SODUWORK_PICKER_CACHE_ROOT: root };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], {
    env, windowsHide: true, stdio: 'inherit',
  });
  const cleanup = () => {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('Invalid fixture root');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  child.once('error', error => { cleanup(); console.error(error); process.exitCode = 1; });
  child.once('exit', code => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const assert = require('node:assert/strict');
  const root = process.env.SODUWORK_PICKER_CACHE_ROOT;
  if (!root) throw Error('Launch this test through Node to own its isolated profile');
  app.disableHardwareAcceleration();
  app.setPath('userData', root);
  const output = path.resolve(__dirname, '../../outputs/runtime-picker-cache');
  fs.mkdirSync(output, { recursive: true });
  const report = { ok: false, boundary: 'Actual Electron input, DOM, CSS and paint with production composer controls. Runtime inventory is a deferred fixture; no native runtime health probes, live accounts or model execution.' };
  let win;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  const settle = () => js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  async function until(code) {
    for (let i = 0; i < 120; i++) { if (await js('Boolean(' + code + ')')) return; await sleep(25); }
    throw Error('Timed out: ' + code);
  }
  async function click(selector) {
    const point = await js(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
    }
    await settle();
  }
  async function capture(name) {
    await settle();
    const data = await win.webContents.debugger.sendCommand('Page.captureScreenshot');
    fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(data.data, 'base64'));
  }
  const timer = setTimeout(() => { console.error('Runtime picker cache fixture exceeded 60 seconds'); app.exit(1); }, 60000);
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1000, height: 820, webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false,
    } });
    win.webContents.debugger.attach('1.3');
    await win.loadFile(path.join(__dirname, 'fixtures/conversation-runtime-picker.html'));
    await until('window.fixtureReady');
    await js(`window.fixtureOwner='cache-owner-a';SoduWorkAPI.taskStorageKey=()=>fixtureOwner;
      window.inventoryRequests=[];
      soduWorkAPI.conversationSession.conversationRuntimes=(ref,options)=>new Promise(resolve=>inventoryRequests.push({ref,force:options?.force===true,resolve}));
      window.cacheRows=[['pi','Pi','2.5.0'],['codex-harness','Codex Harness','2.5.0'],['opencode','OpenCode','1.18.18'],['codex','Codex','0.164.0'],['qwen','Qwen Code','0.26.1'],['dsh','DeepSeek Harness','0.4.40'],['harness2','Google Harness²','0.1.0']].map(([id,displayName,version],i)=>({id,displayName,version,order:i+1,group:i<2?'recommended':'more',modelMode:id==='codex'?'account':'managed',availability:{ok:true,version}}));
      window.resolveInventory=(index,rows=cacheRows)=>inventoryRequests[index].resolve({ok:true,checkedAt:Date.now(),runtimes:structuredClone(rows),availableRuntimes:structuredClone(rows),missing:[{id:'claude',displayName:'Claude Code'}]});
      document.querySelector('#nchatInput').value='Keep the existing draft';
      document.querySelector('#nchatInput').dispatchEvent(new Event('input'));
      controls.render();void 0`);
    await until('inventoryRequests.length===1');
    assert.equal(await js('inventoryRequests[0].force'), false);
    await click('#nchatRuntime');
    assert.equal(await js('document.querySelectorAll(".nchat-runtime-pop [data-runtime]").length'), 0);
    for (let i = 0; i < 3; i++) { await click('#nchatRuntime'); await click('#nchatRuntime'); }
    assert.equal(await js('inventoryRequests.length'), 1, 'close/reopen must share the pending prefetch');
    await js('resolveInventory(0);void 0');
    await until('document.querySelectorAll(".nchat-runtime-pop [data-runtime]").length===7');
    await capture('cached-picker-zh-desktop');
    await click('#nchatRuntime');
    report.cachedOpens = await js(`(()=>{
      const samples=[],button=document.querySelector('#nchatRuntime'),pop=document.querySelector('.nchat-runtime-pop');
      for(let i=0;i<50;i++){
        const start=performance.now();button.click();
        samples.push({elapsedMs:performance.now()-start,rows:pop.querySelectorAll('[data-runtime]').length,hidden:pop.hidden,loading:pop.textContent.includes('正在读取')});
        button.click();
      }
      return samples;
    })()`);
    assert.ok(report.cachedOpens.every(row => row.rows === 7 && !row.hidden && !row.loading),
      'cached DOM rows must be available synchronously before any inventory response');
    assert.equal(await js('inventoryRequests.length'), 1, '50 cached opens must add zero inventory requests');
    assert.equal(await js('state.ref'), 'same-conversation');
    assert.equal(await js('document.querySelector("#nchatInput").value'), 'Keep the existing draft');
    assert.equal(await js('calls.length'), 0, 'opening the menu must not switch or execute a runtime');
    const elapsed = report.cachedOpens.map(row => row.elapsedMs).sort((a, b) => a - b);
    report.cacheTiming = { samples: elapsed.length, p95Ms: elapsed[Math.ceil(elapsed.length * 0.95) - 1], maxMs: elapsed.at(-1) };
    delete report.cachedOpens;
    win.setSize(390, 820);
    await js('locale="en-US";window.dispatchEvent(new Event("soduwork-locale-change"));void 0');
    await settle();
    await click('#nchatRuntime');
    report.narrowLayout = await js(`(()=>{const pop=document.querySelector('.nchat-runtime-pop'),r=pop.getBoundingClientRect(),rows=pop.querySelector('.cp-runtime-rows');return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,vw:innerWidth,vh:innerHeight,horizontalOverflow:rows.scrollWidth>rows.clientWidth,rows:pop.querySelectorAll('[data-runtime]').length,heading:pop.querySelector('.cp-runtime-heading').textContent}})()`);
    const g = report.narrowLayout;
    assert.ok(g.left >= 15 && g.right <= g.vw - 15 && g.top >= 15 && g.bottom <= g.vh - 15, JSON.stringify(g));
    assert.ok(g.width <= 320.5 && g.height <= 400.5, JSON.stringify(g));
    assert.equal(g.horizontalOverflow, false);
    assert.equal(g.rows, 7);
    assert.doesNotMatch(g.heading, /选择执行底座/);
    assert.equal(await js('inventoryRequests.length'), 1, 'locale and viewport changes reuse the same inventory');
    await capture('cached-picker-en-narrow');
    await click('#nchatRuntime');
    await js('window.dispatchEvent(new Event("agent-runtimes-changed"));void 0');
    assert.equal(await js('inventoryRequests.length'), 1, 'closed-menu invalidation remains lazy');
    await click('#nchatRuntime');
    await until('inventoryRequests.length===2');
    assert.equal(await js('inventoryRequests[1].force'), true);
    await js('for(let i=0;i<100;i++)window.dispatchEvent(new Event("agent-runtimes-changed"));void 0');
    assert.equal(await js('inventoryRequests.length'), 2, 'notification burst must not start parallel probes');
    await js('resolveInventory(1);void 0');
    await until('inventoryRequests.length===3');
    assert.equal(await js('document.querySelectorAll(".nchat-runtime-pop [data-runtime]").length'), 0,
      'a superseded response cannot restore stale rows');
    await js('resolveInventory(2,cacheRows.slice(0,2));void 0');
    await until('document.querySelectorAll(".nchat-runtime-pop [data-runtime]").length===2');
    assert.equal(await js('inventoryRequests[2].force'), true);
    await click('#nchatRuntime');
    await js('fixtureOwner="cache-owner-b";window.dispatchEvent(new Event("soduwork-data-scope-changed"));void 0');
    await click('#nchatRuntime');
    await until('inventoryRequests.length===4');
    assert.equal(await js('document.querySelectorAll(".nchat-runtime-pop [data-runtime]").length'), 0,
      'another account must not see the prior scoped inventory');
    assert.equal(await js('inventoryRequests[3].force'), false);
    await js('resolveInventory(3,cacheRows.slice(0,1));void 0');
    await until('document.querySelectorAll(".nchat-runtime-pop [data-runtime]").length===1');
    assert.deepEqual(await js('errors'), []);
    report.inventoryRequests = await js('inventoryRequests.map(({ref,force})=>({ref,force}))');
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); console.error(error); }).finally(() => {
    clearTimeout(timer);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    app.exit(report.ok ? 0 : 1);
  });
}
