'use strict';
// Real Agent management components with isolated API fixtures; no model or install is invoked.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], {
    env, windowsHide: true, stdio: 'inherit',
  }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { pathToFileURL } = require('node:url'), assert = require('node:assert/strict');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-harness2-ui-'));
  const clientRoot = path.resolve(__dirname, '..');
  const catalog = JSON.parse(fs.readFileSync(path.join(clientRoot, '../hub-backend/app/agent_catalog.json'), 'utf8'));
  const agents = catalog.agents.map(row => ({ key: row.id, name: row.displayName,
    bundled: row.install.installer === 'bundled', modelPick: row.modelMode === 'managed',
    installed: row.id !== 'harness2', state: row.id === 'harness2' ? 'missing' : 'ready',
    version: row.id === 'harness2' ? '0.1.0' : '', blurb: row.install.blurb, configHow: row.install.config_how }));
  const fixture = path.join(root, 'agents.html');
  const styles = ['theme/variables.css', 'components/panels/panels-base.css',
    'components/panels/panels-schedules.css', 'components/panels/agent-brand.css',
    'components/panels/panels-agents.css', 'theme/cursor.css'];
  fs.writeFileSync(fixture, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <base href="${pathToFileURL(clientRoot + path.sep).href}">
    ${styles.map(file => `<link rel="stylesheet" href="${file}">`).join('')}
    <style>body{margin:0;background:var(--bg-0);font:15px var(--font-ui);color:var(--ink)}
    main{padding:20px}.fixture-note{font-size:13px;color:var(--ink-4)}</style></head>
    <body><main id="agPanel" class="cfg-panel show"><p class="fixture-note">隔离界面验收 · 状态来自测试夹具</p><div id="agBody"></div></main>
    <script>window.errors=[];addEventListener('error',e=>errors.push(e.message));
    addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    window.esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
    window.calls=[];window.probeCalls=[];window.machine={runnerId:'fixture-device',scope:'current-instance',label:'测试电脑',env:{ok:true,node:'24',npm:'11'},agents:${JSON.stringify(agents)}};
    window.SoduWorkAPI={agentInstall:async(...args)=>{calls.push(args);return{jobId:'fixture-job'}},
      agentProbe:async(...args)=>{probeCalls.push(args);return{jobId:'fixture-probe',model:'fixture-model',keyFrom:'mine'}},
      agentJob:async id=>id==='fixture-probe'
        ? {state:'running',lines:['验证 Harness² 独立执行器；不运行推演，会使用所选模型额度，最多 3 分钟。']}
        : {state:'done',ok:false,detail:'隔离验收没有执行真实安装',lines:[]},
      localAgentSetup:async()=>({machines:[machine],models:[{name:'fixture-model',label:'验收模型'}],modelCount:1})};
    </script><script src="components/panels/agent-brand.js"></script>
    <script src="components/panels/panels-agents.js"></script>
    <script>_agLoad(true).then(()=>{window.ready=true;});</script></body></html>`, 'utf8');
  app.disableHardwareAcceleration(); app.setPath('userData', path.join(root, 'profile'));
  let win;
  const js = text => win.webContents.executeJavaScript(text, true).catch(error => {
    throw Error('Renderer evaluation failed: ' + text.slice(0, 180), { cause: error });
  });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(expression) {
    for (let i = 0; i < 100; i++) { if (await js('Boolean(' + expression + ')')) return; await sleep(30); }
    throw Error('Timed out: ' + expression);
  }
  async function click(selector) {
    const point = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
      el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({
      type, button: 'left', clickCount: 1, ...point,
    });
    await sleep(80);
  }
  const output = path.resolve(process.env.SODUWORK_AGENT_UI_OUTPUT ||
    path.join(clientRoot, '../outputs/harness2-interactive-latency-ui-20261020'));
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1180, height: 900,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } });
    await win.loadFile(fixture); await until('window.ready');
    await until('[...document.images].every(img=>img.complete&&img.naturalWidth>0)');
    fs.mkdirSync(output, { recursive: true });
    const card = '[data-ak="fixture-device~harness2"]';
    assert.equal(await js(`document.querySelector(${JSON.stringify(card)}).querySelector('[data-agent-brand]').dataset.agentBrand`), 'harness2');
    assert.equal(await js(`document.querySelector(${JSON.stringify(card)}).querySelector('.ag-ver').textContent`), '0.1.0');
    assert.match(await js(`document.querySelector(${JSON.stringify(card)}).textContent`), /Google Harness²/);
    for (const width of [1180, 390]) {
      win.setSize(width, 900); await sleep(100);
      const layout = await js(`({overflow:document.documentElement.scrollWidth>innerWidth,
        cards:[...document.querySelectorAll('.ag-row')].map(el=>{const r=el.getBoundingClientRect();return{left:r.left,right:r.right}}),width:innerWidth})`);
      assert.equal(layout.overflow, false, JSON.stringify(layout));
      assert.ok(layout.cards.every(r => r.left >= 0 && r.right <= layout.width), JSON.stringify(layout));
      if (width === 390) await js(`document.querySelector(${JSON.stringify(card)}).scrollIntoView({block:'center'});void 0`);
      fs.writeFileSync(path.join(output, 'agents-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
      await click(card + ' .ag-more');
      await until('document.querySelector(".ag-drawer")');
      assert.equal(await js('document.querySelector(".ag-drawer-head .ag-ver").textContent'), '0.1.0');
      await js('Promise.all(document.querySelector(".ag-drawer").getAnimations().map(animation=>animation.finished))');
      const bounds = await js('(()=>{const r=document.querySelector(".ag-drawer").getBoundingClientRect();return{left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}})()');
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height, JSON.stringify(bounds));
      assert.match(await js('document.querySelector(".ag-drawer").textContent'), /独立执行器.*无需安装其他底座/);
      assert.equal(await js('Boolean(document.querySelector(".ag-drawer [data-aunin]"))'), false);
      fs.writeFileSync(path.join(output, 'details-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
      await click('.ag-drawer-x');
    }
    await click(card + ' [data-ainstall]');
    assert.deepEqual(await js('calls[0]'), ['harness2', 'install', 'fixture-device']);
    await js("clearInterval(_agTimer);_agTimer=null;_agJobs={};_agOpen='';Object.assign(machine.agents.find(a=>a.key==='harness2'),{installed:true,state:'ready'});_agRender();void 0");
    await click(card + ' .ag-more');
    for (const width of [1180, 390]) {
      win.setSize(width, 900); await sleep(100);
      await js('Promise.all(document.querySelector(".ag-drawer").getAnimations().map(animation=>animation.finished))');
      assert.deepEqual(await js(`[...document.querySelectorAll('.ag-drawer .ag-ops button')].map(el=>el.textContent)`),
        ['看看有没有新版', '重装 / 升到最新', '卸载']);
      const layout = await js(`(()=>{const r=document.querySelector('.ag-drawer').getBoundingClientRect();
        return{overflow:document.documentElement.scrollWidth>innerWidth,left:r.left,right:r.right,width:innerWidth}})()`);
      assert.equal(layout.overflow, false, JSON.stringify(layout));
      assert.ok(layout.left >= 0 && layout.right <= layout.width, JSON.stringify(layout));
      fs.writeFileSync(path.join(output, 'lifecycle-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
    }
    await click('.ag-drawer [data-acheck]');
    assert.deepEqual(await js('calls[1]'), ['harness2', 'check', 'fixture-device']);
    await js("clearInterval(_agTimer);_agTimer=null;_agJobs={};_agRender();void 0");
    await click('.ag-drawer [data-ainstall]');
    assert.deepEqual(await js('calls[2]'), ['harness2', 'install', 'fixture-device']);
    await js("clearInterval(_agTimer);_agTimer=null;_agJobs={};_agRender();void 0");
    await click('.ag-drawer [data-aunin]');
    assert.match(await js('document.querySelector(".sch-confirm").textContent'), /保留内置文件和任务记录/);
    assert.equal(await js('calls.length'), 3, 'uninstall must wait for inline confirmation');
    fs.writeFileSync(path.join(output, 'uninstall-confirm-390.png'), (await win.webContents.capturePage()).toPNG());
    await click('.ag-drawer [data-acancel]');
    assert.equal(await js('calls.length'), 3, 'cancel must not call uninstall');
    await click('.ag-drawer [data-aunin]');
    await click('.ag-drawer [data-adoun]');
    assert.deepEqual(await js('calls[3]'), ['harness2', 'uninstall', 'fixture-device']);
    await js("clearInterval(_agTimer);_agTimer=null;_agJobs={};_agOpen='';_agRender();void 0");
    await click(card + ' [data-aprobe]');
    assert.deepEqual(await js('probeCalls[0]'), ['harness2', '', 'fixture-device']);
    await until('document.querySelector(".ag-log").textContent.includes("独立执行器")');
    assert.match(await js('document.querySelector(".ag-job-h").textContent'), /验证 Harness² 独立执行器.*不运行推演.*模型额度.*最多 3 分钟/);
    assert.doesNotMatch(await js('document.querySelector(".ag-job-h").textContent'), /7 轮推演|10 分钟/);
    assert.match(await js('document.querySelector(".ag-log").textContent'), /用的模型：fixture-model/);
    fs.writeFileSync(path.join(output, 'execution-probe-running-390.png'), (await win.webContents.capturePage()).toPNG());
    await js(`clearInterval(_agTimer);_agTimer=null;_agJobs={};_agOpen='';
      Object.assign(machine.agents.find(a=>a.key==='dsh'),{installed:false,state:'missing',bin:'fixture-dsh.cmd',
        why:'DeepSeek Harness 执行组件未准备好，请点「修复安装」。',warnNow:'运行组件缺失'});_agRender();void 0`);
    const dshCard = '[data-ak="fixture-device~dsh"]';
    for (const width of [1180, 390]) {
      win.setSize(width, 900); await sleep(100);
      assert.match(await js(`document.querySelector(${JSON.stringify(dshCard)}).textContent`), /需要修复.*修复安装/s);
      await click(dshCard + ' .ag-more');
      await until('document.querySelector(".ag-drawer")');
      await js('Promise.all(document.querySelector(".ag-drawer").getAnimations().map(animation=>animation.finished))');
      assert.equal(await js('document.querySelector(".ag-drawer [data-ainstall]").textContent'), '修复安装');
      assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false);
      fs.writeFileSync(path.join(output, 'dsh-repair-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
      await click('.ag-drawer-x');
    }
    await click(dshCard + ' [data-ainstall]');
    assert.deepEqual(await js('calls.at(-1)'), ['dsh', 'install', 'fixture-device']);
    assert.equal(await js('document.querySelector(".ag-drawer [data-ainstall]").disabled'), true);
    await until('document.querySelector(".ag-job-h").textContent.includes("安装未完成")');
    assert.equal(await js('document.querySelector(".ag-drawer [data-ainstall]").disabled'), false);
    const beforeRetry = await js('calls.length');
    await js(`SoduWorkAPI.agentJob=async()=>{
      Object.assign(machine.agents.find(a=>a.key==='dsh'),{installed:true,state:'ready',warnNow:'',why:'安装就绪'});
      return{state:'done',ok:true,detail:'隔离安装结果',lines:[]}};void 0`);
    await click('.ag-drawer [data-ainstall]');
    assert.equal(await js('calls.length'), beforeRetry + 1);
    await until(`document.querySelector(${JSON.stringify(dshCard + ' [data-aprobe]')})`);
    assert.equal(await js('document.querySelector(".ag-drawer [data-ainstall]").textContent'), '重装 / 升到最新');
    assert.match(await js('document.querySelector(".ag-job-h").textContent'), /完成/);
    assert.deepEqual(await js('errors'), []);
    console.log('PASS: Harness² grid, lifecycle and probe notices; DeepSeek repair at 1180/390, exact host routing, busy controls, failed repair retry and successful status refresh. All APIs isolated. Screenshots: ' + output);
    app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
}
