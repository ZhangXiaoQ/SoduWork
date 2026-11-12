'use strict';
// Real NativeChat, production preload, controls and pointer splitter. Only IPC
// session/model/file responses are synthetic; no model or user data is touched.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { pathToFileURL } = require('node:url'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), out = path.resolve(client, '../outputs/client-history-skills-layout-20261110/composer-resize');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-composer-resize-'));
  const baseline = process.argv.includes('--baseline'), columnsOnly = process.argv.includes('--columns-only');
  const name = baseline ? 'baseline' : columnsOnly ? 'columns' : 'current';
  const report = { ok: false, baseline, boundary: 'Real renderer/preload/IPC and pointer drag; synthetic session and model catalog; network blocked.', layouts: [], columns: [], cases: [], errors: [] };
  let win, openedWorkdirs = 0;
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(root, 'profile'));
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const js = source => win.webContents.executeJavaScript(source, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(source) {
    for (let i = 0; i < 120; i++) { if (await js(source)) return; await delay(25); }
    throw Error('Timed out: ' + source);
  }
  async function point(selector) {
    return js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.checkVisibility())throw Error('Unavailable: '+${JSON.stringify(selector)});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded: '+${JSON.stringify(selector)});return{x,y}})()`);
  }
  async function click(selector) {
    const p = await point(selector);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...p, button: 'left', clickCount: 1 });
    await delay(100);
  }
  async function shot(suffix) {
    await delay(120); fs.writeFileSync(path.join(out, name + '-' + suffix + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  function key(keyCode) { for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode }); }
  async function drag(ratio, ending = 'release') {
    const p = await point('[data-wb-resize]');
    // The visual grip center is offset from the main pane by its border. Use
    // the real starting pane width, as production's pointer handler does.
    const target = await js(`(()=>{const root=document.querySelector('.nchat').getBoundingClientRect(),main=document.querySelector('.nchat-main').getBoundingClientRect();return Math.round(${p.x}+root.width*${ratio}-main.width)})()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 12; step++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x + (target - p.x) * step / 12), y: p.y, modifiers: ['leftButtonDown'] });
      await delay(12);
    }
    if (ending === 'escape') key('ESC');
    if (ending === 'cancel') await js(`document.querySelector('[data-wb-resize]').dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1}))`);
    if (ending === 'snap') {
      assert.equal(await js(`document.querySelector('.nchat').classList.contains('ncw-snap-ready')`), true);
      await shot('release-to-maximize');
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: target, y: p.y, button: 'left', clickCount: 1 });
    await delay(250);
    assert.equal(await js(`document.querySelector('.nchat').classList.contains('ncw-resizing')`), false);
  }
  async function geometry() {
    return js(`(()=>{const selectors=['#nchatMore','[data-execution-menu]','#nchatRuntime','#nchatWd','#nchatMode','#nchatMeta','.nmodel-button','#nchatSend'];const box=document.querySelector('.nbox').getBoundingClientRect(),main=document.querySelector('.nchat-main').getBoundingClientRect();
      const controls=selectors.map(selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect();return{selector,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),visible:e.checkVisibility(),inside:r.left>=box.left-1&&r.right<=box.right+1&&r.top>=box.top-1&&r.bottom<=box.bottom+1}});
      const overlaps=[];for(let a=0;a<controls.length;a++)for(let b=a+1;b<controls.length;b++){const x=controls[a],y=controls[b];if(Math.min(x.right,y.right)-Math.max(x.left,y.left)>1&&Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top)>1)overlaps.push([x.selector,y.selector]);}
      const permission=document.querySelector('#nchatMode'),label=permission.querySelector('b'),s=getComputedStyle(document.querySelector('.nbox'));return{viewport:innerWidth,mainWidth:main.width,composerWidth:box.width,queryWidth:box.width-parseFloat(s.borderLeftWidth)-parseFloat(s.borderRightWidth),toolbarHeight:document.querySelector('.wc-toolbar').getBoundingClientRect().height,controls,overlaps,overflow:document.documentElement.scrollWidth>innerWidth+1,risk:permission.classList.contains('wc-permission-risk'),permissionClipped:label.scrollWidth>label.clientWidth+1,pendingVisible:document.querySelector('.nchat-access-pending').checkVisibility(),input:document.querySelector('#nchatInput').value};})()`);
  }
  async function checkColumns(scenario) {
    const measured = await js(`(()=>{
      const box=selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect();return{left:r.left,right:r.right,width:r.width,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}};
      const composer=box('.nbox'),list=box('#nchatList'),reply=box('#nchatList .nmsg.ai .ntext'),user=box('#nchatList .nmsg.user');
      const blocks=[...document.querySelectorAll('#nchatList pre,#nchatList table')].map(e=>{const r=e.getBoundingClientRect();return{tag:e.tagName,left:r.left,right:r.right,overflow:getComputedStyle(e).overflowX,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}});
      return{viewport:innerWidth,composer,list,reply,user,blocks,documentOverflow:document.documentElement.scrollWidth>innerWidth+1,streamOverflow:document.querySelector('#nchatScroll').scrollWidth>document.querySelector('#nchatScroll').clientWidth+1};
    })()`);
    report.columns.push({ ...scenario, ...measured });
    for (const key of ['list', 'reply']) {
      assert.ok(Math.abs(measured[key].left - measured.composer.left) < 1, key + ' left edge: ' + JSON.stringify(measured));
      assert.ok(Math.abs(measured[key].right - measured.composer.right) < 1, key + ' right edge: ' + JSON.stringify(measured));
    }
    assert.ok(Math.abs(measured.user.right - measured.composer.right) < 1, 'User bubbles share the right column edge');
    assert.ok(measured.user.left >= measured.composer.left, 'User bubbles remain within the shared column');
    assert.equal(measured.documentOverflow, false); assert.equal(measured.streamOverflow, false);
    assert.equal(measured.blocks.length, 2, 'Production Markdown renders both code and table probes');
    assert.ok(measured.blocks.every(row => row.left >= measured.composer.left - 1 && row.right <= measured.composer.right + 1 && row.overflow === 'auto'), JSON.stringify(measured.blocks));
    assert.ok(measured.blocks.some(row => row.scrollWidth > row.clientWidth), 'Wide content scrolls within its own block');
  }
  function check(g) {
    assert.deepEqual(g.overlaps, [], JSON.stringify(g));
    const box = selector => g.controls.find(row => row.selector === selector);
    const precedes = (a, b) => box(a).right <= box(b).left + 1;
    const centers = g.controls.map(row => (row.top + row.bottom) / 2);
    assert.ok(Math.max(...centers) - Math.min(...centers) <= 1, 'Every control stays on one row: '+JSON.stringify(g));
    assert.ok(g.toolbarHeight <= 52, 'Footer height must not grow after dragging');
    assert.ok(precedes('#nchatMore', '[data-execution-menu]') && precedes('[data-execution-menu]', '#nchatMode') && precedes('#nchatMode', '#nchatWd'), 'Add, execution, access, workspace order');
    assert.ok(precedes('.nmodel-button', '#nchatRuntime') && precedes('#nchatRuntime', '#nchatSend'), 'Model, Agent, send order');
    assert.ok(box('.nmodel-button').width <= 120.5, 'Compact model trigger');
    assert.ok(g.controls.every(row => row.visible && row.inside && row.width >= 15 && row.height >= 15 && row.hit), JSON.stringify(g));
    assert.equal(g.overflow, false); assert.equal(g.risk, true); assert.equal(g.permissionClipped, false);
    assert.equal(g.input, 'Unsent draft stays intact / 未发送的输入保留');
  }
  async function checkLabels() {
    const labels = await js(`(()=>{const visible=s=>document.querySelector(s).checkVisibility();return{width:document.querySelector('.nbox').clientWidth,folder:visible('#nchatWdName'),agent:visible('#nchatRuntimeName'),permission:visible('#nchatModeName'),model:visible('.nmodel-button>span'),modelIcon:visible('.nmodel-icon'),names:['#nchatMode','#nchatWd','.nmodel-button','#nchatRuntime'].map(s=>{const e=document.querySelector(s);return e.title&&e.getAttribute('aria-label')})}})()`);
    assert.ok(labels.names.every(Boolean), 'Icon controls keep full tooltips and accessible names');
    assert.equal(labels.folder, labels.width > 680); assert.equal(labels.agent, labels.width > 680);
    assert.equal(labels.permission, labels.width > 540); assert.equal(labels.model, labels.width > 420);
    assert.equal(labels.modelIcon, labels.width <= 420);
  }
  async function popup(selector) {
    const bounds = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return{visible:e.checkVisibility(),left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:e.scrollWidth>e.clientWidth+1}})()`);
    assert.ok(bounds.visible && bounds.left >= -1 && bounds.right <= bounds.width + 1 && bounds.top >= -1 && bounds.bottom <= bounds.height + 1 && !bounds.overflow, JSON.stringify({ selector, bounds }));
  }
  const model = { name: 'long-model', label: 'dev-coding-large-agent-soduwork-enterprise-long-model-name', contextWindow: 128000, contextWindowKnown: true };
  const capability = { supported: true, schema: 'soduwork.access-policy/v1', modes: ['standard', 'readonly', 'full'], canChangeDuringSession: true, changeTakesEffect: 'next-turn' };
  const state = { status: 'idle', adapterId: 'codex-harness', displayName: 'Codex Harness Enterprise Long Agent',
    messages: [{ role: 'user', text: 'Isolated layout sample', done: true }, { role: 'assistant', done: true, blocks: [{ kind: 'text', text:
      '## Shared conversation column\n\nExisting conversation is preserved.\n\n' +
      '```javascript\nconst example = "' + 'long-code-segment-'.repeat(40) + '";\n```\n\n' +
      '| Name | Description | Result |\n| --- | --- | --- |\n| A | ' + 'wide-table-cell-'.repeat(35) + ' | Preserved |\n\n' +
      Array.from({ length: 8 }, (_, i) => 'Paragraph ' + i + ': streaming, history, and the current draft keep their original contents.').join('\n\n'), done: true }] }], tools: [],
    usage: { input: 28000, output: 200 }, accessPolicy: { mode: 'full', revision: 1 }, accessControl: capability,
    modelSelection: { name: model.name, model }, thinking: { supported: true, enabled: true, canDisable: true }, execution: { running: false, queue: [], turnQueue: {} } };
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1366, height: 900,
      webPreferences: { preload: path.join(client, 'preload.js'), offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_r, cb) => cb({ cancel: true }));
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    ipcMain.handle('pi-session-open', () => ({ ok: true, ref: 'resize-fixture', sessionId: 'resize-fixture', adapterId: state.adapterId, displayName: state.displayName,
      cwd: path.join(root, 'workspace'), workspaceName: 'Enterprise-Workspace-Very-Long-Project-Name', model, snapshot: state }));
    ipcMain.handle('pi-session-snapshot', () => ({ ok: true, snapshot: state }));
    ipcMain.handle('work-preview-show', (_e, options) => ({ ok: true, state: { tabId: options.tabId, url: options.url, loading: false } }));
    for (const [channel, value] of Object.entries({ 'pi-session-history': { ok: true, chats: [] }, 'pi-session-outputs': { ok: true, files: [], artifacts: [] },
      'pi-session-runtimes': { ok: true, runtimes: [{ id: state.adapterId, modelMode: 'managed' }] },
      'pi-session-release': { ok: true }, 'work-preview-hide': { ok: true }, 'work-preview-destroy': { ok: true }, 'access-preferences-get': { ok: true } })) ipcMain.handle(channel, () => value);
    ipcMain.handle('pi-session-open-session-workdir', () => { openedWorkdirs++; return { ok: true }; });
    ipcMain.handle('pi-session-set-access-mode', () => ({ ok: true, snapshot: state }));
    ipcMain.handle('pi-session-artifact-action', (_e, _ref, _id, action) => action === 'read'
      ? { ok: true, text: '# 成果阅读位置\n\n' + Array.from({ length: 70 }, (_, i) => '## Section ' + i + '\n\n内容保留，不因全屏重建。').join('\n\n') }
      : { ok: true });
    ipcMain.handle('pi-session-select-model', (_e, _ref, value) => ({ ok: true, selection: { name: value, model } }));
    // Reuse the full production NativeChat shell, excluding only its fixture
    // bootstrap so the synthetic catalog can be configured here.
    const source = path.join(__dirname, 'fixtures/workbench-annotations.html'), scripts = [];
    let html = fs.readFileSync(source, 'utf8').replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_match, attrs) => {
      const src = attrs.match(/src=["']([^"']+)/); if (src) scripts.push(fs.readFileSync(path.resolve(path.dirname(source), src[1]), 'utf8')); return '';
    });
    html = html.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/gi, '').replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '">');
    const fixture = path.join(root, 'fixture.html'); fs.writeFileSync(fixture, html); await win.loadFile(fixture);
    async function stylesheet(file) {
      await js(`new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href=${JSON.stringify(pathToFileURL(path.join(client, file)).href)};link.onload=()=>resolve(true);link.onerror=()=>reject(Error('Stylesheet failed'));document.head.appendChild(link)})`);
    }
    await stylesheet('theme/variables.css');
    for (const file of ['components/panels/panels-chat.css', 'components/panels/chat-collaboration.css',
      'components/panels/conversation-attachments.css', 'components/panels/agent-brand.css']) await stylesheet(file);
    // Preserve desk.html's stylesheet order, with work-composer after the chat
    // files; replace only its imported controls file when replaying the baseline.
    const controls = baseline ? require('node:child_process').execFileSync('git', ['show', 'HEAD:client/components/panels/chat-session-controls.css'], { cwd: client, encoding: 'utf8', windowsHide: true }) : read('components/panels/chat-session-controls.css');
    await js(`(()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(controls + '\n' + read('components/panels/work-composer.css').replace(/^@import[^;]*;\s*/, ''))};document.head.appendChild(s)})()`);
    await js(`window.errors=[];window.notices=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));window.petSay=value=>notices.push(value);window.SoduWorkAPI={online:true,myModels:async()=>({usable:[${JSON.stringify(model)}]}),listTeammates:async()=>[],pluginCatalog:async()=>({items:[]})};void 0;`);
    for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
    for (const file of ['core/i18n-dom.js', 'core/i18n.js', 'components/panels/agent-brand.js']) await js(read(file) + '\nvoid 0;');
    for (const script of scripts) await js(script + '\nvoid 0;');
    // The add menu uses the same installed-plugin normalizer as the live shell.
    for (const file of ['components/panels/compose-candidate-navigation.js', 'components/panels/chat-plugin-mention-model.js',
      'components/panels/chat-plugin-mention.js']) await js(read(file) + '\nvoid 0;');
    await js(read('components/panels/panels-chat-chrome.js') + '\nvoid 0;');
    await js(`NativeChat.enter('','resize-fixture',{adapterId:'codex-harness'})`); await until(`NativeChat.sessionInfo().ref==='resize-fixture'`);
    assert.equal(await js(`document.querySelector('#nchatMic').checkVisibility()`), false,
      'the existing unsupported voice control stays hidden');
    if (!baseline) {
      await until(`document.querySelector('#nchatList table') && document.querySelector('#nchatList pre')`);
      await js(`document.querySelector('#nchatScroll').dataset.scrollFollow='paused';void 0;`);
      for (const [width, zoom] of [[1366,1],[900,1],[480,1],[390,1],[320,1],[1366,1.25],[900,1.25],[480,1.5]]) {
        win.setContentSize(width, 900); win.webContents.setZoomFactor(zoom); await delay(180);
        await checkColumns({ width, zoom, surface: 'conversation' });
        if (width === 1366 && zoom === 1 || width === 390) await shot('column-' + width);
      }
      win.webContents.setZoomFactor(1); win.setContentSize(1366, 900); await delay(180);
      const response = state.messages.at(-1);
      for (const streaming of [true, false]) {
        state.status = streaming ? 'streaming' : 'idle'; state.execution.running = streaming;
        response.done = !streaming; response.blocks[0].done = !streaming;
        if (streaming) response.blocks[0].text += '\n\nThe live reply continues in the same column.';
        win.webContents.send('pi-session-event', { ref: 'resize-fixture', kind: 'snapshot', snapshot: structuredClone(state) });
        await until(`document.querySelector('#nchatList').textContent.includes('The live reply continues')`);
        await delay(150); await checkColumns({ width: 1366, zoom: 1, surface: streaming ? 'streaming' : 'settled' });
      }
      report.cases.push('Transcript, Markdown and right-aligned user messages share the composer edges at desktop/narrow widths and 100/125/150% zoom; code and tables retain internal scrolling.');
      if (columnsOnly) { assert.deepEqual(await js('errors'), []); assert.deepEqual(report.errors, []); report.ok = true; return; }
    }
    await js(`ChatWorkbench.openLink('https://isolated.invalid/preview');void 0;`);
    await until(`document.querySelector('[data-wb-resize]')?.checkVisibility()`);
    win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await click('#nchatInput'); win.webContents.insertText('Unsent draft stays intact / 未发送的输入保留'); await delay(120);
    if (baseline) {
      await drag(.3); const g = await geometry(); report.layouts.push(g); await shot('overlap');
      assert.ok(g.toolbarHeight > 52, 'Original rules must reproduce the reported two-row footer');
      report.cases.push('Previous production CSS reproduces the two-row footer after an actual pointer drag.'); report.ok = true; return;
    }
    for (const width of [1100, 1366, 1920]) for (const locale of ['zh-CN', 'en-US']) for (const pending of [false, true]) {
      win.setContentSize(width, 900); await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)});document.documentElement.dataset.theme=${JSON.stringify(locale === 'zh-CN' ? 'azure' : 'ruby')};`);
      if (pending) state.nextAccessPolicy = { mode: 'full', revision: 2 }; else delete state.nextAccessPolicy;
      win.webContents.send('pi-session-event', { ref: 'resize-fixture', kind: 'snapshot', snapshot: structuredClone(state) }); await delay(140);
      for (const ratio of [.5, .3, .7]) {
        await drag(ratio); const g = await geometry(); report.layouts.push({ width, locale, pending, ratio, ...g }); check(g);
        await checkLabels(); await checkColumns({ width, locale, pending, ratio, surface: 'split' });
        assert.equal(g.pendingVisible, pending);
        if (ratio === .3 || width === 1920 && ratio === .7) await shot(`${width}-${locale}-${pending ? 'pending' : 'full'}-${ratio}`);
      }
    }
    report.cases.push('36 real splitter drags at 1100/1366/1920px: 30/50/70%, full/pending access, long labels, Chinese/English and two themes; no overlap, clipping or covered control.');
    win.setContentSize(1366, 900); await delay(250);
    for (const locale of ['zh-CN', 'en-US']) {
      await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)});`);
      for (const targetWidth of [418, 420, 422, 538, 540, 542, 678, 680, 682]) {
        const ratio = await js(`(()=>{const f=getComputedStyle(document.querySelector('.nchat-foot')),s=getComputedStyle(document.querySelector('.nbox'));return(${targetWidth}+parseFloat(f.paddingLeft)+parseFloat(f.paddingRight)+parseFloat(s.borderLeftWidth)+parseFloat(s.borderRightWidth))/document.querySelector('.nchat').getBoundingClientRect().width})()`);
        await drag(ratio); const g = await geometry(); check(g);
        report.layouts.push({ locale, pending: true, breakpoint: targetWidth, ...g });
        assert.ok(Math.abs(g.queryWidth - targetWidth) < 1.5, JSON.stringify({ targetWidth, actual: g.queryWidth }));
      }
    }
    report.cases.push('18 additional actual drags cover both sides of the 420/540/680px container breakpoints in Chinese and English with pending access.');
    win.setContentSize(1100, 900); await drag(.3);
    await click('#nchatMode'); await popup('#nchatAccessPop');
    assert.equal(await js(`document.querySelectorAll('#nchatAccessPop [data-access-mode]').length`), 3); await shot('permission-menu');
    await click('#nchatAccessPop [data-access-mode="full"]'); await until(`document.querySelector('#nchatAccessPop').hidden`);
    await click('.nmodel-button'); await until(`document.querySelectorAll('[data-model-name]').length===1`); await popup('.nmodel-pop'); await shot('model-menu');
    await click('[data-model-name="long-model"]'); await until(`document.querySelector('.nmodel-pop').hidden`);
    await click('#nchatMore'); await popup('#nchatMorePop'); await shot('add-menu'); await click('#nchatMore');
    assert.deepEqual(await js(`(()=>{const e=document.querySelector('#nchatWd');return{tag:e.tagName,tabIndex:e.tabIndex,cursor:getComputedStyle(e).cursor}})()`),
      { tag: 'SPAN', tabIndex: -1, cursor: 'default' });
    await click('#nchatWd'); assert.equal(openedWorkdirs, 0, 'the existing workspace label is display-only');
    await click('[data-chat-open-location]'); assert.equal(openedWorkdirs, 1, 'the header retains explicit folder access');
    await click('#nchatMeta'); await popup('.nctx-pop'); await click('#nchatMeta');
    report.cases.push('Narrow-column permission, model, add and context controls remain clickable; workspace is a static non-focusable label with no open/change action, while the independent header still opens its original location.');
    await drag(.7); check(await geometry()); await drag(.3); check(await geometry());
    // A real Markdown document gives us a persistent scrollable preview. Only
    // the artifact read boundary is stubbed; rendering and resizing are production.
    win.setContentSize(1366, 900); await delay(150); await drag(.5);
    await js(`window.testFiles=[{artifactId:'layout-md',name:'成果验收.md',path:'C:/isolated/成果验收.md',kind:'document',at:1}];ChatWorkbench.render(document.querySelector('.nchat'),{},testFiles);ChatWorkbench.openOutput('layout-md');void 0;`);
    await until(`!!document.querySelector('.ncw-markdown h1')`);
    await js(`window.savedPreview=document.querySelector('.ncw-body').firstElementChild;window.savedTabs=document.querySelector('.ncw-tabs').firstElementChild;window.savedInput=document.querySelector('#nchatInput');window.savedScroll=document.querySelector('.ncw-markdown');savedScroll.scrollTop=420;window.savedScrollTop=savedScroll.scrollTop;void 0;`);
    const starting = (await geometry()).mainWidth;
    async function preserved(maximized) {
      const result = await js(`(()=>{const r=document.querySelector('.nchat'),w=r.querySelector('.ncw');return{maximized:ChatWorkbench.state().maximized,same:savedPreview===document.querySelector('.ncw-body').firstElementChild&&savedTabs===document.querySelector('.ncw-tabs').firstElementChild&&savedInput===document.querySelector('#nchatInput'),draft:savedInput.value,scroll:savedScroll.scrollTop,expectedScroll:savedScrollTop,fullWidth:Math.abs(w.getBoundingClientRect().width-r.getBoundingClientRect().width)<2,mainVisible:document.querySelector('.nchat-main').checkVisibility()}})()`);
      assert.equal(result.maximized, maximized); assert.equal(result.same, true, 'No preview, tabs or editor remount');
      assert.equal(result.draft, 'Unsent draft stays intact / 未发送的输入保留');
      assert.ok(result.expectedScroll > 0 && Math.abs(result.scroll - result.expectedScroll) < 2, JSON.stringify(result));
      assert.equal(result.mainVisible, !maximized); if (maximized) assert.equal(result.fullWidth, true);
    }
    for (const ending of ['escape', 'cancel']) {
      await drag(.15, ending); await preserved(false);
      assert.ok(Math.abs((await geometry()).mainWidth-starting)<2, 'Cancelled drag restores original width');
    }
    await drag(.15, 'snap'); await preserved(true); await shot('maximized');
    await click('[data-wb-maximize]'); await preserved(false); check(await geometry());
    assert.ok(Math.abs((await geometry()).mainWidth-starting)<2, 'Return restores the useful pre-drag width');
    await click('[data-wb-maximize]'); await preserved(true); key('ESC'); await delay(250); await preserved(false);
    await click('[data-wb-resize]'); key('Home'); await delay(250); await preserved(true);
    key('ESC'); await delay(250); await preserved(false);
    report.cases.push('Pointer snap, drag cancellation/Escape, keyboard Home and restore button preserve editor, document/tab DOM, scroll position and previous width.');
    for (const width of [850, 360]) {
      win.setContentSize(width, 900); await delay(180); await click('[data-wb-maximize]'); await preserved(true);
      await shot('maximized-'+width); await click('[data-wb-maximize]'); await preserved(false);
    }
    report.cases.push('Maximized output fills the full content width at 360/850px; return control remains reachable.');
    assert.deepEqual(await js('errors'), []); assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(async error => { report.error = error.stack || String(error); try { await shot('failure'); } catch {} }).finally(async () => {
    if (win && !win.isDestroyed()) win.destroy();
    fs.writeFileSync(path.join(out, name + '-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, baseline, layouts: report.layouts.length, cases: report.cases.length, error: report.error, report: path.join(out, name + '-report.json') }));
    app.exit(report.ok ? 0 : 1);
  });
}
