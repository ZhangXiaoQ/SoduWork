'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-bug-ui-'));
  const client = path.resolve(__dirname, '..'), output = path.join(client, '../outputs/bug-report-ui');
  app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
      const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
      if(!e.checkVisibility()||!e.contains(document.elementFromPoint(x,y)))throw Error('Not clickable: '+${JSON.stringify(selector)});return{x,y}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
    await delay(220);
  }
  async function resize(width) {
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await delay(220);
  }
  const hidden = () => js('document.querySelector(".nchat-summary").hidden');
  const geometry = () => js(`(()=>{const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}};
    return{header:box('.nchat-head'),actions:box('.nchat-head-actions'),stage:box('.nchat-stage'),content:box('.nchat-content-area'),footer:box('.nchat-foot'),panel:box('.nchat-summary'),overflow:document.documentElement.scrollWidth>innerWidth}})()`);
  app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive: true });
    const page = path.join(root, 'fixture.html');
    fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><base href="${pathToFileURL(client + path.sep).href}">
      <link rel="stylesheet" href="theme/variables.css"><link rel="stylesheet" href="components/panels/panels-chat.css">
      <link rel="stylesheet" href="components/panels/work-composer.css">
      <style>body{margin:0;font:14px system-ui}.nchat-content-area{padding:24px;box-sizing:border-box}</style>
      <div class="nchat" id="chat"></div><script src="components/panels/panels-chat-chrome.js"></script>
      <script src="components/panels/work-composer.js"></script><script>window.errors=[];addEventListener('error',e=>errors.push(e.message));
      chat.innerHTML='<div class="nchat-stage"><div class="nchat-main">'+ChatChrome.header()+'<div class="nchat-content-area"><button id="answer">A completed result remains readable.</button></div><div class="nchat-foot"><div class="nchat-footin"><div class="nchat-entry-dock"><div class="nbox"></div></div></div></div></div></div>';
      WorkComposer.upgradeChat(chat.querySelector('.nbox'));document.querySelector('#nchatInput').value='Unsent draft';
      ChatChrome.bind(chat,()=>({ref:'isolated'}));
      window.resultState={count:1,has:true,summary:{files:[{name:'result.md',path:'result.md',size:20}]}};
      ChatChrome.workbenchState(resultState);</script>`);
    win = new BrowserWindow({ show: false, width: 1200, height: 800,
      webPreferences: { offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
    await win.loadFile(page); win.webContents.debugger.attach('1.3');
    assert.equal(await js('document.querySelector("#nchatWdPick")'), null);
    const layouts = [];
    for (const width of [1200, 960, 959, 760, 390]) {
      await resize(width);
      const before = await geometry();
      await click('[data-chat-summary]');
      const layout = await geometry();
      assert.equal(layout.overflow, false);
      assert.ok(layout.panel.left >= 0 && layout.panel.right <= width + 1);
      for (const key of ['header', 'actions', 'stage', 'content', 'footer']) {
        assert.deepEqual(layout[key], before[key], key + ' does not move when opening summary');
      }
      assert.equal(Math.round(layout.stage.width), width, 'summary reserves no blank column at any width');
      assert.equal(layout.panel.right, layout.header.right - 8, 'summary sits below the right-hand header controls');
      assert.ok(layout.panel.top >= layout.header.bottom && layout.panel.bottom < 800, 'summary is a compact popover');
      await click('#nchatInput'); assert.equal(await hidden(), true);
      await click('[data-chat-summary]');
      for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Escape' });
      await delay(60); assert.equal(await hidden(), true);
      assert.equal(await js('document.activeElement.hasAttribute("data-chat-summary")'), true);
      await click('[data-chat-summary]');
      layouts.push({ width, ...layout });
      fs.writeFileSync(path.join(output, 'summary-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
      await click('[data-chat-summary-close]'); assert.equal(await hidden(), true);
      assert.equal(await js('Math.round(document.querySelector(".nchat-stage").getBoundingClientRect().width)'), width);
    }
    await resize(1600);
    await js(`chat.classList.add('ncw-open');chat.style.setProperty('--nchat-w','50%');
      chat.querySelector('.nchat-stage').insertAdjacentHTML('beforeend','<aside class="ncw">File preview</aside>');void 0;`);
    const beforeSplit = await geometry();
    await click('[data-chat-summary]');
    const split = await geometry();
    const preview = await js(`(()=>{const r=document.querySelector('.ncw').getBoundingClientRect();return{left:r.left,right:r.right,width:r.width}})()`);
    assert.deepEqual(split.actions, beforeSplit.actions, 'preview header controls stay fixed');
    assert.equal(preview.right, 1600); assert.equal(preview.left, split.content.right);
    assert.equal(Math.round(preview.width), 800); assert.equal(split.panel.right, split.header.right - 8);
    fs.writeFileSync(path.join(output, 'summary-split-preview.png'), (await win.webContents.capturePage()).toPNG());
    for (const hostWidth of [600, 420]) {
      await js(`chat.style.width='${hostWidth}px';chat.style.right='auto';void 0`);
      await delay(220);
      const embedded = await geometry();
      assert.equal(embedded.panel.right, embedded.header.right - 8, 'summary follows the real chat column in a narrow desktop host');
      assert.equal(await js('document.querySelector(".ncw").getBoundingClientRect().right'), hostWidth);
    }
    await js("chat.style.removeProperty('width');chat.style.removeProperty('right');void 0");
    await resize(960);
    assert.equal(await js('Math.round(document.querySelector(".ncw").getBoundingClientRect().width)'), 480);
    await resize(760); assert.equal((await geometry()).stage.width, 760);
    await resize(1600); assert.equal((await geometry()).stage.width, 1600);
    await click('[data-chat-summary]'); assert.equal(await hidden(), true);
    await js('ChatChrome.workbenchState({count:0,has:false,summary:{}});void 0');
    await click('[data-chat-summary]');
    assert.equal(await js('document.querySelectorAll(".nchat-summary-empty").length'), 1);
    assert.equal((await geometry()).stage.width, 1600);
    await click('[data-chat-summary]');
    assert.equal((await geometry()).stage.width, 1600);
    assert.equal(await js('document.querySelector("#nchatInput").value'), 'Unsent draft');
    assert.deepEqual(await js('window.errors'), []);
    const report = { ok: true, layouts, split, preview, scope: 'Production ChatChrome, composer and CSS; isolated Chromium native input, no business session' };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
}
