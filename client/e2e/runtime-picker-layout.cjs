"use strict";
// Real composer markup, CSS and controllers; runtime responses are isolated fixtures.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  app.disableHardwareAcceleration();
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runtime-layout-')));
  const out = path.resolve(__dirname, '../../outputs/runtime-picker-compact-20261103');
  fs.mkdirSync(out, { recursive: true });
  const report = { boundary: 'Isolated Electron rendering with production composer code; fixture runtime catalog, no Agent execution.', checks: [] };
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) {
    for (let i = 0; i < 100; i++) { if (await js(`Boolean(${code})`)) return; await sleep(30); }
    throw Error('Timed out: ' + code);
  }
  async function settle() { await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); }
  async function click(selector) {
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'});void 0`);
    await settle();
    const point = await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
    await settle();
  }
  async function geometry(trigger, popup) {
    return js(`(()=>{
      const b=document.querySelector(${JSON.stringify(trigger)}).getBoundingClientRect(), p=document.querySelector(${JSON.stringify(popup)}), r=p.getBoundingClientRect();
      const rows=[...p.querySelectorAll('[data-runtime]')], last=rows.at(-1), host=p.querySelector('.cp-runtime-rows');
      return {width:r.width,height:r.height,left:r.left,right:r.right,top:r.top,bottom:r.bottom,vw:innerWidth,vh:innerHeight,
        button:{left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width},placement:p.dataset.placement,
        pointer:r.left+parseFloat(p.style.getPropertyValue('--runtime-anchor-x')),
        rowHeights:rows.map(x=>x.getBoundingClientRect().height),
        rightPadding:Math.min(...rows.map(x=>r.right-x.querySelector('.cp-runtime-meta').getBoundingClientRect().right)),
        horizontalOverflow:host.scrollWidth>host.clientWidth, scrollable:host.scrollHeight>host.clientHeight,
        versions:rows.map(x=>{const s=x.querySelector('.cp-runtime-version');return {text:s.textContent,visible:s.checkVisibility()}}),
        footerVisible:p.querySelector('[data-runtime-more]')?.checkVisibility()??p.querySelector('#nchatRuntimeMore')?.checkVisibility()};
    })()`);
  }
  function check(g, count) {
    assert.ok(g.width <= 320.5 && g.height <= 400.5, JSON.stringify(g));
    assert.ok(g.left >= 15 && g.right <= g.vw - 15 && g.top >= 15 && g.bottom <= g.vh - 15, JSON.stringify(g));
    assert.equal(g.rowHeights.length, count);
    assert.ok(g.rowHeights.every(h => h >= 40 && h <= 45), JSON.stringify(g.rowHeights));
    assert.ok(g.rightPadding >= 17, JSON.stringify(g));
    assert.equal(g.horizontalOverflow, false);
    assert.ok(Math.abs(g.pointer - (g.button.left + g.button.width / 2)) <= 1.5, JSON.stringify(g));
    if (g.button.left + g.width <= g.vw - 16) assert.ok(Math.abs(g.left - g.button.left) <= 1.5, JSON.stringify(g));
    if (g.placement === 'above') assert.ok(Math.abs(g.button.top - g.bottom - 10) <= 1.5, JSON.stringify(g));
    else assert.ok(Math.abs(g.top - g.button.bottom - 10) <= 1.5, JSON.stringify(g));
  }
  async function capture(name) {
    await settle();
    const shot = await win.webContents.debugger.sendCommand('Page.captureScreenshot');
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1600, height: 950, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.debugger.attach('1.3');
    for (const surface of ['chat', 'new-chat']) {
      await win.loadFile(path.join(__dirname, surface === 'chat' ? 'fixtures/conversation-runtime-picker.html' : '../tests/composer-menu.html'));
      const trigger = surface === 'chat' ? '#nchatRuntime' : '#cpRuntime', popup = surface === 'chat' ? '.nchat-runtime-pop' : '#cpRuntimePop';
      await until(`document.querySelector(${JSON.stringify(trigger)})`);
      await js(`window.layoutRuntimes=[['pi','Pi','2.5.0'],['codex-harness','Codex Harness','2.5.0'],['opencode','OpenCode','1.18.18'],['codex','Codex','0.164.0'],['qwen','Qwen Code','0.26.1'],['dsh','DeepSeek Harness','0.4.40'],['harness2','Google Harness²','0.1.0']].map(([id,displayName,version],i)=>({id,displayName,version,order:i+1,group:i<2?'recommended':'more',modelMode:id==='codex'?'account':'managed',availability:{ok:true,version}}));
        window.runtimeReply=()=>({ok:true,runtimes:layoutRuntimes,availableRuntimes:layoutRuntimes,missing:[{id:'claude',displayName:'Claude'}]});
        soduWorkAPI.conversationSession.runtimes=async()=>runtimeReply();
        soduWorkAPI.conversationSession.conversationRuntimes=async()=>runtimeReply();
        soduWorkAPI.conversationSession.probe=async id=>({ok:true,version:layoutRuntimes.find(r=>r.id===id)?.version});
        window.dispatchEvent(new Event('agent-runtimes-changed'));void 0`);
      for (const [width, height, zoom] of [[1600,950,1],[900,700,1],[500,760,1.25]]) {
        win.setSize(width,height);win.webContents.setZoomFactor(zoom);await sleep(100);
        await click(trigger);
        await until(`document.querySelector(${JSON.stringify(popup)})?.querySelectorAll('[data-runtime]').length===7`);
        await settle();
        const g=await geometry(trigger,popup);check(g,7);
        assert.ok(g.versions.every(v=>v.visible && v.text.startsWith('v')),JSON.stringify(g.versions));
        assert.equal(g.footerVisible,true);
        report.checks.push({surface,width,height,zoom,...g});
        if(width===1600)await capture(surface+'-seven-runtimes');
        await click(trigger);
      }
      win.webContents.setZoomFactor(1);win.setSize(1600,950);await sleep(80);
      await click(trigger);await settle();
      win.setSize(900,700);await sleep(100);await settle();
      check(await geometry(trigger,popup),7);
      await click(popup+' [data-runtime=harness2]');
      await until(`document.querySelector(${JSON.stringify(trigger)}).textContent.includes('Google')`);
      report.checks.push({surface,case:'resize-open-picker-and-select-last-scrolled-runtime'});
      win.setSize(1600,950);await sleep(80);
      await js('window.layoutRuntimes=layoutRuntimes.slice(0,1);window.dispatchEvent(new Event("agent-runtimes-changed"));void 0');
      await click(trigger);await until(`document.querySelector(${JSON.stringify(popup)}).querySelectorAll('[data-runtime]').length===1`);
      const single=await geometry(trigger,popup);check(single,1);assert.equal(single.footerVisible,true);
      assert.ok(single.height<160,JSON.stringify(single));
      await capture(surface+'-single-runtime');report.checks.push({surface,case:'single-runtime-with-management',...single});
      assert.deepEqual(await js(surface==='chat'?'errors':'fixtureErrors'),[]);
      await click(trigger);
    }
    report.ok=true;fs.writeFileSync(path.join(out,'layout-report.json'),JSON.stringify(report,null,2));
    console.log('PASS: compact runtime picker on both composer surfaces, seven/single runtime, versions, right padding, trigger pointer, viewport clamp and 125% zoom');app.exit(0);
  }).catch(error=>{report.error=error.stack;fs.writeFileSync(path.join(out,'layout-report.json'),JSON.stringify(report,null,2));console.error(error);app.exit(1);});
}
