'use strict';
// Native wheel and keyboard regression with the production shell, CSS and chat renderer.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], {env, windowsHide: true, stdio: 'inherit', timeout: 120000});
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const {app, BrowserWindow, ipcMain} = electron;
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const client = path.resolve(__dirname, '..'), output = path.resolve(client, '../outputs/chat-shell-scroll');
fs.mkdirSync(output, {recursive: true});
const temporary = fs.mkdtempSync(path.join(output, 'run-'));
app.setPath('userData', path.join(temporary, 'profile'));
const report = {ok: false, cases: [], layouts: [], errors: [],
  boundary: 'Hidden native Electron; production WorkspaceShell, ComposeSurface parent hierarchy, NativeChat and full desktop CSS; synthetic IPC session, no model/network/business data'};
const read = name => fs.readFileSync(path.join(client, name), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const js = code => win.webContents.executeJavaScript(code, true);
async function until(code) {
  for (let i = 0; i < 100; i++) { if (await js(code)) return; await wait(40); }
  throw Error('Timed out: ' + code);
}
async function resize(width, height, zoom) {
  win.setContentSize(width, height); win.webContents.setZoomFactor(zoom);
  await until(`Math.abs(innerWidth-${width/zoom})<2&&Math.abs(innerHeight-${height/zoom})<2`);
  await wait(100);
}
async function point(selector) {
  return js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');
    const r=e.getBoundingClientRect(),p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
    if(!e.contains(document.elementFromPoint(p.x,p.y)))throw Error('Covered control '+${JSON.stringify(selector)});return p})()`);
}
async function click(selector) {
  const p = await point(selector), zoom = win.webContents.getZoomFactor();
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type,
    x: Math.round(p.x * zoom), y: Math.round(p.y * zoom), ...(type === 'mouseMove' ? {} : {button: 'left', clickCount: 1})});
  await wait(80);
}
async function shot(name) { fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
async function sample(label) {
  const value = await js('window.shellGeometry()'); report.layouts.push({label, ...value}); return value;
}
function check(value, baseline) {
  const by = name => value.rows.find(row => row.name === name);
  const header = by('.nchat-head'), footer = by('.nchat-foot'), main = by('.nchat-main'), scroll = by('#nchatScroll');
  assert.ok(header.top >= main.top - 1 && header.bottom <= main.bottom, 'Header remains inside the chat shell');
  assert.ok(footer.top >= header.bottom && footer.bottom <= main.bottom + 1, 'Composer remains inside the chat shell');
  assert.ok(scroll.top >= header.bottom - 1 && scroll.bottom <= footer.top + value.overlap + 1, 'Only the transcript occupies the middle scroll region');
  assert.ok(value.headerHit && value.inputHit && value.sendHit, 'Header and composer remain visible and clickable');
  assert.equal(value.runtimeError, '', 'The synthetic conversation remains healthy throughout the interaction');
  for (const row of value.rows.filter(row => row.name !== '#nchatScroll')) assert.equal(row.scrollTop, 0, row.name + ' must not scroll');
  if (baseline) {
    for (const name of ['.nchat-head', '.nchat-foot']) {
      const previous = baseline.rows.find(row => row.name === name), current = by(name);
      assert.ok(Math.abs(current.top - previous.top) <= 1 && Math.abs(current.bottom - previous.bottom) <= 1, name + ' stays stationary during wheel input');
    }
  }
}
async function wheel(direction, label) {
  const baseline = await sample(label + '-before'); check(baseline);
  const p = await point('#nchatScroll'), zoom = win.webContents.getZoomFactor();
  await js('window.shellFrames=[];window.captureShell=true;void 0');
  for (let i = 0; i < 5; i++) {
    win.webContents.sendInputEvent({type: 'mouseWheel', x: Math.round(p.x * zoom), y: Math.round(p.y * zoom), deltaY: direction * 180, deltaX: 0});
    await wait(55);
  }
  await wait(120);
  const frames = await js('captureShell=false;shellFrames');
  assert.ok(frames.length > 5);
  for (const frame of frames) check(frame, baseline);
  const after = await sample(label + '-after');
  const beforeTop = baseline.rows.find(row => row.name === '#nchatScroll').scrollTop;
  const afterTop = after.rows.find(row => row.name === '#nchatScroll').scrollTop;
  assert.ok(direction > 0 ? afterTop < beforeTop : afterTop > beforeTop, 'Native wheel moves the transcript in the requested direction');
  report.cases.push(label + ': native wheel keeps header/composer fixed across ' + frames.length + ' frames');
}
async function wheelOutsideTranscript(selector, label) {
  const baseline = await sample(label + '-before'); check(baseline);
  const p = await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return{x:r.left+8,y:r.top+r.height/2}})()`), zoom = win.webContents.getZoomFactor();
  await js('window.shellFrames=[];window.captureShell=true;void 0');
  for (const deltaY of [-600, 600]) {
    win.webContents.sendInputEvent({type:'mouseWheel', x:Math.round(p.x*zoom), y:Math.round(p.y*zoom), deltaY, deltaX:0});
    await wait(130);
  }
  const frames=await js('captureShell=false;shellFrames');
  assert.ok(frames.length>5);
  for(const frame of frames) check(frame, baseline);
  report.cases.push(label + ': wheel chaining cannot scroll the shell');
}
async function pressKey(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({type: 'keyDown', keyCode, modifiers});
  await wait(55);
  win.webContents.sendInputEvent({type: 'keyUp', keyCode, modifiers});
  await wait(120);
}
async function keyboardHistory() {
  await js(`window.historyKeys=[];document.addEventListener('keydown',event=>historyKeys.push({key:event.key,code:event.code,target:event.target.id||event.target.tagName}),true);void 0`);
  const snapshot = () => js(`(()=>{const s=document.querySelector('#nchatScroll');return {
    top:s.scrollTop,gap:s.scrollHeight-s.clientHeight-s.scrollTop,
    follow:s.getAttribute('data-scroll-follow')==='latest',focus:document.activeElement.id||document.activeElement.tagName,
    input:document.querySelector('#nchatInput').value,keys:historyKeys.slice(-2)}})()`);
  const render = async () => {
    state.messages.at(-1).blocks[0].text += ' A later streamed token.';
    win.webContents.send('pi-session-event', {ref: 'shell-fixture', kind: 'snapshot', snapshot: structuredClone(state)});
    await wait(40);
  };
  await click('#nchatInput');
  await win.webContents.insertText('First draft line\nSecond draft line\nThird draft line');
  await pressKey('Up');
  report.keyboardComposer = await snapshot();
  assert.equal(report.keyboardComposer.focus, 'nchatInput', 'editing keeps focus in the composer');
  assert.equal(report.keyboardComposer.follow, true, 'composer arrow keys do not pause transcript following');
  await js(`document.querySelector('#nchatInput').value='';document.querySelector('#nchatInput').dispatchEvent(new Event('input',{bubbles:true}));
    const text=[...document.querySelectorAll('#nchatList .ntext p')].at(-1);text.dataset.keyboardHistoryTarget='';void 0`);
  await click('[data-keyboard-history-target]');
  report.keyboardBefore = await snapshot();
  report.keyboardUp = [];
  for (let i = 0; i < 6; i++) {
    await pressKey('Up');
    await render(); await wait(100);
    report.keyboardUp.push(await snapshot());
  }
  assert.equal(report.keyboardBefore.focus, 'nchatScroll', 'clicking history gives its scroll container keyboard focus');
  for (let i = 0; i < report.keyboardUp.length; i++) {
    const previous = i ? report.keyboardUp[i - 1] : report.keyboardBefore;
    assert.equal(report.keyboardUp[i].follow, false, 'ArrowUp pauses following before a render');
    assert.ok(report.keyboardUp[i].top < previous.top - 5, 'repeated ArrowUp keeps moving through older history');
  }
  const reading = await snapshot();
  for (let i = 0; i < 4; i++) { await render(); await wait(60); }
  assert.ok(Math.abs((await snapshot()).top - reading.top) <= 2, 'stream/status updates cannot pull keyboard reading to the bottom');
  await pressKey('PageUp'); await render(); await wait(100);
  report.keyboardPageUp = await snapshot();
  assert.ok(report.keyboardPageUp.top < reading.top - 100, 'PageUp continues browsing history');
  await pressKey('Home'); await render(); await wait(100);
  report.keyboardHome = await snapshot();
  assert.ok(report.keyboardHome.top <= 2, 'Home reaches the start of the transcript');
  await pressKey('End'); await render(); await wait(150);
  report.keyboardEnd = await snapshot();
  assert.equal(report.keyboardEnd.follow, true, 'End at the bottom resumes latest following');
  assert.ok(report.keyboardEnd.gap <= 2, 'End reaches the actual transcript bottom');
  report.cases.push('Native ArrowUp, PageUp and Home browse production history without forced focus or wheel input; renders preserve reading, End resumes following and composer arrows keep editing.');
}
const state = {status: 'streaming', adapterId: 'pi', displayName: 'Pi',
  messages: Array.from({length: 220}, (_, i) => i % 2 ? {role: 'assistant', done: true, blocks: [{kind: 'text', done: true,
    text: '## 第 ' + i + ' 段执行结果\n\n' + '正文、清单与验证记录保留在消息区域，标题和输入框应当固定。\n\n'.repeat(5) + '- 检查布局\n- 保留阅读位置'}]}
    : {role: 'user', done: true, text: '第 ' + i + ' 条需求：查看过程并保留完整交付证据。'}), tools: [],
  execution: {running: true, queue: [], turnQueue: {}}};
state.messages.push({role: 'assistant', done: false, blocks: [{kind: 'text', done: false, text: '正在生成最后一段结果。'}]});
app.whenReady().then(async () => {
  try {
    ipcMain.handle('pi-session-open', () => ({ok: true, ref: 'shell-fixture', sessionId: 'shell-fixture', cwd: temporary, snapshot: structuredClone(state)}));
    for (const [name, value] of Object.entries({'pi-session-history': {ok: true, chats: []},
      'pi-session-outputs': {ok: true, files: [], artifacts: []}, 'pi-session-runtimes': {ok: true, runtimes: []},
      'pi-session-snapshot': {ok: true, snapshot: state}, 'pi-session-release': {ok: true},
      'pi-session-read-output': {ok:true,text:'# Isolated result'}, 'recent-workspace-get':{ok:true,dir:''},
      'access-preferences-get': {ok: true}})) ipcMain.handle(name, name === 'pi-session-history'
        ? require('./fixtures/history-ipc.cjs').create(() => value) : () => value);
    const styles = [...read('desk.html').matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)/g)]
      .map(match => pathToFileURL(path.join(client, match[1])).href);
    const html = '<!doctype html><html lang="zh-CN" data-theme="azure" data-desk-panel="workspace" data-workspace-view="create" data-workspace-layout="conversation" data-window-menu><meta charset="utf-8"><base href="'+pathToFileURL(client+path.sep).href+'"><body></body></html>';
    const fixture = path.join(temporary, 'fixture.html'); fs.writeFileSync(fixture, html);
    win = new BrowserWindow({show: false, width: 1366, height: 900,
      webPreferences: {preload: path.join(client, 'preload.js'), offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false}});
    win.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']}, (_r, done) => done({cancel: true}));
    win.webContents.on('console-message', e => {if (e.level === 'error') report.errors.push(e.message);});
    await win.loadFile(fixture);
    await js(`Promise.all(${JSON.stringify(styles)}.map(href=>new Promise((resolve,reject)=>{const e=document.createElement('link');
      e.rel='stylesheet';e.href=href;e.onload=resolve;e.onerror=()=>reject(Error(href));document.head.appendChild(e)}))).then(()=>true)`);
    await js(`window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      window.petSay=()=>{};window.SoduWorkAPI={online:true,myModels:async()=>({usable:[]}),listTeammates:async()=>[],pluginCatalog:async()=>({items:[]})};void 0;`);
    const scripts = path.join(__dirname, 'fixtures/workbench-annotations.html');
    for (const match of fs.readFileSync(scripts, 'utf8').matchAll(/<script src="([^"]+)"/g)) await js(fs.readFileSync(path.resolve(path.dirname(scripts), match[1]), 'utf8') + '\nvoid 0;');
    for (const name of ['panels-chat-chrome.js', 'compose-surface.js']) await js(read('components/panels/' + name) + '\nvoid 0;');
    await js(`window.WorkspaceNavigation={record:()=>{},chatChanged:()=>{}};void 0;`);
    for (const name of ['workspace-chat-history.js','workspace-chat-list.js','workspace-shell.js']) await js(read('components/workspace/'+name)+'\nvoid 0;');
    await js(`WorkspaceShell.mount();WorkspaceShell.setActive('create');void 0;`);
    await js(`window.composeSurface=ComposeSurface.create({_bind:()=>{}});const panel=composeSurface._panel();panel.classList.add('show');panel.dataset.stage='chat';
      NativeChat.enter('','shell-fixture',{});void 0;`);
    await until(`NativeChat.sessionInfo().ref==='shell-fixture'&&!!document.querySelector('#nchatTitle')`);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled: true});
    await js(`window.shellGeometry=()=>{const selectors=['html','body','#composePanel','.cp-body','#cpChat','.nchat','.nchat-stage','.nchat-main','.nchat-content-area','.nchat-head','#nchatScroll','.nchat-foot'];
      const rows=selectors.map(name=>{const n=document.querySelector(name),r=n.getBoundingClientRect(),s=getComputedStyle(n);return{name,top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height,
        scrollTop:n.scrollTop,scrollHeight:n.scrollHeight,clientHeight:n.clientHeight,overflow:s.overflowY,flex:s.flex,position:s.position}});
      const hit=selector=>{const n=document.querySelector(selector),r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};
      return{rows,headerHit:hit('#nchatTitle'),inputHit:hit('#nchatInput'),sendHit:hit('#nchatSend'),
        runtimeError:document.querySelector('[data-chat-node="runtime-error"]')?.textContent||'',
        overlap:Math.max(0,-parseFloat(getComputedStyle(document.querySelector('.nchat-content-area')).marginBottom)||0)}};
      window.shellFrames=[];window.captureShell=false;function paint(){if(captureShell)shellFrames.push(shellGeometry());requestAnimationFrame(paint)}requestAnimationFrame(paint);void 0;`);
    await wait(400);
    await sample('initial'); await shot('initial');
    await keyboardHistory();
    await wheel(1, 'wide-up'); await wheel(-1, 'wide-down');
    for (const [selector,label] of [['.nchat-head','header-blank'],['.nchat-foot','footer-shoulder'],['#nchatInput','input-blank']]) {
      await wheelOutsideTranscript(selector,label);
    }
    await shot('wide-after-wheel');
    const before = await sample('before-stream');
    for (let i = 0; i < 12; i++) {
      state.messages.at(-1).blocks[0].text += '\n\n流式追加的结果内容。';
      win.webContents.send('pi-session-event', {ref: 'shell-fixture', kind: 'snapshot', snapshot: structuredClone(state)});
      await wait(30); check(await js('shellGeometry()'), before);
    }
    await until(`document.querySelector('#nchatList').textContent.split('流式追加的结果内容。').length===13`);
    report.cases.push('Production streaming patches preserve shell geometry while history is scrolled');
    await wheel(1,'before-history-up');
    const mountedBefore = await js(`document.querySelectorAll('[data-chat-node^="message:"]').length`);
    await js(`document.querySelector('#nchatScroll').scrollTop=0;void 0`); await wait(80);
    await click('[data-load-older]');
    await until(`document.querySelectorAll('[data-chat-node^="message:"]').length>${mountedBefore}`);
    check(await sample('expanded-history'));
    await wheel(-1,'expanded-history-down');
    for (const index of [0,-1]) {
      await js(`Array.from(document.querySelectorAll('[data-chat-node^="message:"]')).at(${index}).scrollIntoView({block:'center'});void 0`);
      await wait(100);check(await sample('scroll-into-view'));
    }
    report.cases.push('Long-history expansion and scrollIntoView keep ancestor scroll positions at zero');
    await js(`document.documentElement.dataset.workspaceView='history';WorkspaceShell.setActive('history');document.querySelector('#composePanel').classList.remove('show');document.querySelector('#composePanel').dataset.stage='compose';void 0`);
    await wait(50);
    await js(`(()=>{document.documentElement.dataset.workspaceView='create';WorkspaceShell.setActive('create');const panel=document.querySelector('#composePanel');panel.classList.add('show');panel.dataset.stage='chat';NativeChat.enter('','shell-fixture',{});})();void 0`);
    await wait(150);check(await sample('returned-to-conversation'));
    await wheel(1,'conversation-reentry-up');
    await js(`ChatWorkbench.openInput({path:'isolated-result.md',name:'isolated-result.md',kind:'file',text:'# Isolated result'});void 0`);
    await wait(250);check(await sample('split-open'));
    await wheel(1,'split-up');await shot('split-after-wheel');
    await js(`document.querySelector('[data-wb-close]').click();void 0`);await wait(250);
    for (const [width, height, zoom] of [[1100, 660, 1], [1100, 760, 1.25], [820, 700, 1]]) {
      await resize(width, height, zoom);
      await js(`document.querySelector('#nchatScroll').scrollTop=document.querySelector('#nchatScroll').scrollHeight;void 0`);
      await wheel(1, width + '-' + height + '-' + zoom + '-up');
      await shot('layout-' + width + '-' + height + '-' + zoom);
    }
    await resize(1366, 900, 1);
    await click('#nchatInput'); await win.webContents.insertText(Array.from({length: 22}, (_, i) => '保留未发送草稿第 ' + i + ' 行。').join('\n'));
    await wait(120);
    await js(`document.querySelector('#nchatScroll').scrollTop=document.querySelector('#nchatScroll').scrollHeight;void 0`);
    await wheel(1, 'expanded-draft-up'); await shot('expanded-draft');
    assert.match(await js(`document.querySelector('#nchatInput').value`), /保留未发送草稿第 21 行/);
    assert.equal(await js('document.querySelector("#nchatWdPick")'), null, 'production composer has no workspace-switch button');
    await resize(1800, 900, 1);
    const headerBefore = await js('document.querySelector(".nchat-head-actions").getBoundingClientRect().toJSON()');
    await click('[data-chat-summary]');
    assert.equal(await js('document.querySelector(".nchat-summary").hidden'), false);
    assert.deepEqual(await js('document.querySelector(".nchat-head-actions").getBoundingClientRect().toJSON()'), headerBefore, 'opening summary leaves the right-hand controls fixed');
    await shot('summary-right-aligned');
    await click('#nchatInput');
    assert.equal(await js('document.querySelector(".nchat-summary").hidden'), true, 'editing dismisses the summary');
    await js(`ChatWorkbench.openInput({path:'isolated-result.md',name:'isolated-result.md',kind:'file',text:'# Isolated result'});void 0`);
    await wait(250);
    await click('[data-chat-summary]');
    const joined = await js(`(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect(),root=rect('.nchat'),panel=rect('.nchat-summary'),stage=rect('.nchat-stage'),preview=rect('.ncw');
      return Math.abs(stage.right-root.right)<1&&Math.abs(preview.right-root.right)<1&&Math.abs(panel.right-(rect('.nchat-head').right-8))<1;})()`);
    assert.equal(joined, true, 'full desktop shell has no unoccupied column after the summary or preview');
    await shot('summary-preview-full-width');
    await click('[data-chat-summary-close]');
    assert.equal(await js(`Math.abs(document.querySelector('.ncw').getBoundingClientRect().right-document.querySelector('.nchat').getBoundingClientRect().right)<1`), true);
    assert.match(await js(`document.querySelector('#nchatInput').value`), /保留未发送草稿第 21 行/);
    report.cases.push('Full source-client shell removes workspace switch, keeps header controls stationary when toggling summary, and fills the right edge with preview without losing the unsent draft.');
    assert.doesNotMatch(await js(`document.querySelector('#nchatList').textContent`), /开对话时出错|is not a function/);
    assert.deepEqual(await js('errors'), []); assert.deepEqual(report.errors, []);
    report.ok = true;
  } catch (error) {
    report.error = String(error.stack || error);
    if (win) { try { report.failure = await js('shellGeometry()'); } catch (_) {} await shot('failure'); }
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ok: report.ok, cases: report.cases, error: report.error, errors: report.errors}));
    app.exit(report.ok ? 0 : 1);
  }
});
