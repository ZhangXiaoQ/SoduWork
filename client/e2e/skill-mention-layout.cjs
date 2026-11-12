'use strict';
// Exercise the production skill picker in isolated Chromium without user data or network.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[name];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..');
  const output = path.resolve(process.argv[2] || path.join(client, '../outputs/client-history-skills-layout-20261110/skills-current'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-mention-'));
  fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', path.join(temporary, 'profile'));
  app.disableHardwareAcceleration();
  const report = { ok: false, cases: [], errors: [], networkRequests: 0 };
  let win;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = source => win.webContents.executeJavaScript(source, true);
  async function until(source) {
    for (let index = 0; index < 100; index++) { if (await js(source)) return; await pause(20); }
    throw Error('Timed out: ' + source);
  }
  async function key(keyCode, count = 1) {
    for (let index = 0; index < count; index++) {
      for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode });
      await pause(10);
    }
  }
  async function open(text = '#') {
    await js("picker.clear();localStorage.clear();input.value='';input.focus();");
    await win.webContents.insertText(text);
    await until('document.querySelector(".cp-skill-menu.show")');
    await pause(150);
  }
  async function bounds() {
    return js(`(() => {
      const menu = document.querySelector('.cp-skill-menu'), active = menu.querySelector('.active');
      const rect = menu.getBoundingClientRect(), anchor = host.getBoundingClientRect(), row = active?.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        width: innerWidth, height: innerHeight, anchorTop: anchor.top, anchorBottom: anchor.bottom,
        count: menu.querySelectorAll('[role="option"]').length, scroll: menu.scrollTop,
        scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight,
        active: active?.dataset.skillName, activeVisible: !!row && row.top >= rect.top && row.bottom <= rect.bottom,
        page: document.querySelector('#outer').scrollTop };
    })()`);
  }
  function contained(value) {
    assert.ok(value.left >= 7 && value.top >= 7 && value.right <= value.width - 7 &&
      value.bottom <= value.height - 7, 'Popup must stay in the viewport: ' + JSON.stringify(value));
  }
  async function verify(name, action) {
    try { await action(); report.cases.push({ name, ok: true }); }
    catch (error) {
      report.cases.push({ name, ok: false, error: error.stack, bounds: await bounds() });
      fs.writeFileSync(path.join(output, name + '-failed.png'), (await win.webContents.capturePage()).toPNG());
    }
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1000, height: 680,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
      (_request, callback) => { report.networkRequests++; callback({ cancel: true }); });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    const styles = ['theme/variables.css', 'components/workspace/workspace-shell.css',
      'components/panels/work-composer.css', 'components/panels/panels-compose-skills.css'];
    const html = '<!doctype html><meta charset="utf-8">' + styles.map(file =>
      '<link rel="stylesheet" href="' + pathToFileURL(path.join(client, file)).href + '">').join('') +
      '<style>body{margin:0;font-family:Arial}#outer{height:100vh;overflow:auto}.spacer{height:800px}' +
      '#host{position:relative;box-sizing:border-box;width:min(700px,calc(100vw - 32px));height:140px;margin:0 16px}' +
      'textarea{box-sizing:border-box;width:100%;height:110px}button{font:inherit}</style>' +
      '<div id="outer" class="compose-panel" data-stage="compose"><div class="spacer"></div>' +
      '<div id="host" class="work-composer cp-box"><textarea id="input" class="wc-input"></textarea></div><div class="spacer"></div></div>';
    const file = path.join(temporary, 'picker.html'); fs.writeFileSync(file, html);
    await win.loadFile(file);
    for (const file of ['compose-candidate-navigation.js', 'panels-compose-skills.js']) {
      await js(fs.readFileSync(path.join(client, 'components/panels', file), 'utf8') + '\nvoid 0;');
    }
    await js(`window.input=document.querySelector('#input');window.host=document.querySelector('#host');
      window.skills=Array.from({length:14},(_,index)=>({name:'skill-'+String(index).padStart(2,'0'),
        description:'Team skill '+index,installed:true,selectable:index!==2}));
      window.picker=ComposeSkills.create({input,host,loading:false});picker.setItems(skills);
      document.querySelector('#outer').scrollTop=800-(innerHeight-200);`);
    await verify('compose-bottom-full-catalog', async () => {
      await open(); const value = await bounds();
      assert.equal(value.count, 14, 'The catalog must not be truncated');
      contained(value); assert.ok(value.bottom < value.anchorTop, 'Bottom composer must open above');
      fs.writeFileSync(path.join(output, 'bottom-popup.png'), (await win.webContents.capturePage()).toPNG());
    });
    await verify('keyboard-final-skill-and-disabled-row', async () => {
      await open(); await key('Up'); const value = await bounds();
      contained(value); assert.equal(value.active, 'skill-13'); assert.ok(value.activeVisible);
      await key('Return'); assert.deepEqual(await js('picker.selected()'), ['skill-13']);
      await open(); await key('Down', 2); assert.equal((await bounds()).active, 'skill-03');
      await key('Escape'); assert.equal(await js('input.getAttribute("aria-expanded")'), 'false');
    });
    await verify('wheel-refresh-final-click', async () => {
      await open(); const before = await bounds(); contained(before);
      const point = { x: Math.round((before.left + before.right) / 2), y: Math.round((before.top + before.bottom) / 2) };
      win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      win.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaY: -2500, deltaX: 0 });
      await until('document.querySelector(".cp-skill-menu").scrollTop > 0');
      for (let index = 0; index < 10; index++) {
        await pause(80);
        const value = await bounds();
        if (value.scroll + value.clientHeight >= value.scrollHeight) break;
        win.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaY: -2500, deltaX: 0 });
      }
      const scrolled = await bounds();
      assert.ok(scrolled.scroll + scrolled.clientHeight >= scrolled.scrollHeight);
      await js('picker.setItems(skills)'); assert.equal((await bounds()).scroll, scrolled.scroll);
      const target = await js(`(() => {const option=document.querySelector('[data-skill-name="skill-13"]');
        const rect=option.getBoundingClientRect(),x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2);
        if(!option.contains(document.elementFromPoint(x,y)))throw Error('Last skill is clipped or occluded');return{x,y};})()`);
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...target, button: 'left', clickCount: 1 });
      await until('picker.selected().includes("skill-13")');
      assert.equal((await bounds()).page, before.page, 'Wheel scrolling must not move the page');
    });
    await verify('top-anchor-and-window-resize', async () => {
      await js('document.querySelector("#outer").scrollTop=780'); await open();
      let value = await bounds(); contained(value); assert.ok(value.top > value.anchorBottom);
      win.setContentSize(390, 420); await pause(160); value = await bounds(); contained(value);
      assert.equal(value.count, 14); await key('Up'); assert.ok((await bounds()).activeVisible);
      await js('document.querySelector("#outer").scrollTop=540'); await pause(120);
      value = await bounds(); contained(value); assert.ok(value.bottom < value.anchorTop);
    });
    await verify('short-window-tall-composer', async () => {
      win.setContentSize(390, 240);
      await js("host.style.height='240px';host.style.maxHeight='none';document.querySelector('#outer').scrollTop=800;");
      await open(); contained(await bounds());
      await key('Up'); assert.equal((await bounds()).active, 'skill-13');
      assert.ok((await bounds()).activeVisible);
      await key('Escape');
      win.setContentSize(390, 420);
      await js("host.style.height='';host.style.maxHeight='';document.querySelector('#outer').scrollTop=540;");
    });
    await verify('search-keeps-markers-and-permissions', async () => {
      await open('#skill-13'); assert.equal((await bounds()).count, 1);
      await key('Tab'); assert.deepEqual(await js('picker.selected()'), ['skill-13']);
      await open('#skill-02'); await key('Return'); assert.deepEqual(await js('picker.selected()'), []);
      assert.equal(await js('input.value'), '#skill-02');
      await js("input.value='Keep #1 and /skill:example unchanged';input.dispatchEvent(new Event('input',{bubbles:true}));");
      assert.equal(await js('input.getAttribute("aria-expanded")'), 'false');
      assert.equal(await js('input.value'), 'Keep #1 and /skill:example unchanged');
    });
    report.ok = report.cases.every(row => row.ok) && report.errors.length === 0 && report.networkRequests === 0;
  }).catch(error => { report.errors.push(error.stack); }).finally(() => {
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
