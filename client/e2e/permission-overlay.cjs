'use strict';
// Production NativeChat + preload + approval IPC, with isolated snapshots and a real local Pi tool turn.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const executionLayoutOnly = process.argv.includes('--execution-layout-only');
  const client = path.resolve(__dirname, '..'), out = path.resolve(client,
    executionLayoutOnly ? '../outputs/chat-execution-layout' : '../outputs/default-access/interaction');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-permission-overlay-'));
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(root, 'profile'));
  const report = { ok: false, cases: [], errors: [] }, sessions = new Map(), replies = [], answers = [];
  const support = { supported: true, canChangeDuringSession: true, schema: 'soduwork.access-policy/v1', modes: ['standard', 'readonly', 'full'] };
  let win, fixture, hold = false, cancelled = 0, failNext = false;
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  function css(file) {
    return fs.readFileSync(file, 'utf8').replace(/@import\s+url\(["']?([^"')]+)["']?\)\s*;/g, (_match, relative) => css(path.resolve(path.dirname(file), relative)))
      .replace(/url\(["']?([^"')]+)["']?\)/g, (match, relative) => /^(?:data:|https?:|file:)/.test(relative) ? match : 'url("' + pathToFileURL(path.resolve(path.dirname(file), relative)).href + '")');
  }
  const js = code => win.webContents.executeJavaScript(code, true), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(check, description = 'condition') {
    for (let i = 0; i < 200; i++) { const value = typeof check === 'string' ? await js(check) : await check(); if (value) return value; await delay(25); }
    throw Error('Timed out: ' + description);
  }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.checkVisibility())throw Error('Unavailable '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded '+${JSON.stringify(selector)});return{x,y};})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(70);
  }
  async function shot(name) {
    await delay(100); await win.webContents.capturePage(); await delay(120);
    fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  const base = () => ({ status: 'idle', messages: [{ role: 'assistant', blocks: [{ kind: 'text', text: 'Original history retained.' }] }], tools: [], usage: null,
    adapterId: 'pi', displayName: 'Pi', accessControl: support, accessPolicy: { mode: 'standard', revision: 1 }, pendingUi: null, pendingPermissions: [] });
  function publish(ref) {
    const state = sessions.get(ref);
    if (win && !win.isDestroyed() && state) win.webContents.send('pi-session-event', { ref, kind: 'snapshot', snapshot: state.snapshot() });
  }
  function add(ref) {
    const state = { data: base(), attachedWindow: win, snapshot() { return structuredClone(this.data); }, async answerUi(value) {
      answers.push({ ref, value });
      if (hold) await new Promise(resolve => replies.push(resolve));
      if (failNext) { failNext = false; return { ok: false, reason: '权限确认失败，请重试' }; }
      const request = this.data.pendingPermissions.find(row => row.requestId === value.requestId && row.policyRevision === value.policyRevision);
      if (!request) return { ok: false, reason: '这条权限请求已失效，请使用当前请求' };
      this.data.pendingPermissions = this.data.pendingPermissions.filter(row => row.requestId !== request.requestId);
      this.data.pendingUi = this.data.pendingPermissions[0] || null;
      this.data.status = this.data.pendingUi ? 'waiting-user' : 'idle'; publish(ref);
      return { ok: true };
    } };
    sessions.set(ref, state); return state;
  }
  const request = (id, target = 'C:/fixture/outside/report.md') => ({ method: 'permission', requestId: id, policyRevision: 1,
    action: 'file.write', tool: 'write', target, arguments: { path: target, content: 'Preserved operation payload', apiKey: 'must-remain-hidden' },
    createdAt: Date.now(), expiresAt: Date.now() + 600000, allowSession: true });
  async function pending(ref, rows, overrides = {}) {
    const state = sessions.get(ref); Object.assign(state.data, { status: rows.length ? 'waiting-user' : 'idle', pendingUi: rows[0] || null, pendingPermissions: rows }, overrides); publish(ref);
    await delay(100);
    if (rows.length) await until('Boolean(document.querySelector(".access-request [data-ui-value=once]")?.checkVisibility())&&document.querySelector(".access-request [data-ui-value=once]").dataset.permissionRequest===' + JSON.stringify(rows[0].requestId), 'pending ' + rows[0].requestId);
  }
  async function enter(ref) {
    await js('NativeChat.enter("",' + JSON.stringify(ref) + ',{adapterId:"pi"});');
    await until('NativeChat.sessionInfo().ref===' + JSON.stringify(ref), 'enter ' + ref); await delay(120);
  }
  const overlayVisible = 'Boolean(document.querySelector(".nchat-access-overlay .access-request")?.checkVisibility())';
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: {
      preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
    add('overlay-a'); add('overlay-b');
    ipcMain.handle('pi-session-open', (_event, options) => {
      const ref = options.chatId, state = sessions.get(ref);
      return { ok: true, ref, sessionId: ref, adapterId: 'pi', displayName: 'Pi', cwd: root, workspaceName: 'Fixture', accessControl: support, model: { label: 'Fixture model' }, snapshot: state.snapshot() };
    });
    ipcMain.handle('pi-session-snapshot', (_event, ref) => ({ ok: true, snapshot: sessions.get(ref).snapshot() }));
    ipcMain.handle('pi-session-answer-ui', require('../main/access-control/ipc').answerHandler({ get: ref => sessions.get(ref) }));
    for (const [channel, value] of Object.entries({ 'pi-session-history': { ok: true, chats: [] }, 'pi-session-outputs': { ok: true, items: [] },
      'pi-session-release': { ok: true }, 'pi-session-runtime-models': { ok: true, items: [], models: [] },
      'pi-session-runtimes': { ok: true, runtimes: [{ id: 'pi', label: 'Pi', available: true, accessControl: support }] },
      'access-preferences-get': { ok: true, mode: 'standard', revision: 0 },
      'work-preview-reset-embedded': { ok: true }, 'work-preview-hide': { ok: true }, 'work-preview-destroy': { ok: true } })) {
      ipcMain.handle(channel, () => value);
    }
    ipcMain.on('pi-session-cancel', (_event, ref) => { cancelled++; void pending(ref, []); });
    const source = path.join(client, 'e2e/fixtures/workbench-annotations.html'), scripts = [];
    const html = fs.readFileSync(source, 'utf8').replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_match, attrs, body) => {
      const src = attrs.match(/src=["']([^"']+)/); scripts.push(src ? fs.readFileSync(path.resolve(path.dirname(source), src[1]), 'utf8') : body); return '';
    });
    const documentFile = path.join(out, 'native-chat.html');
    fs.writeFileSync(documentFile, html.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/gi, '').replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '">'));
    await win.loadFile(documentFile);
    for (const file of ['theme/variables.css', 'components/panels/work-composer.css', 'components/panels/panels-chat.css',
      'components/panels/chat-collaboration.css', 'components/panels/conversation-attachments.css', 'components/panels/access-controls.css', 'components/panels/agent-brand.css']) {
      await js('(()=>{const style=document.createElement("style");style.textContent=' + JSON.stringify(css(path.join(client, file))) + ';document.head.appendChild(style);})();');
    }
    for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
    for (const file of ['core/i18n-dom.js', 'core/i18n.js', 'components/panels/agent-brand.js', 'components/panels/access-controls.js',
      'components/panels/compose-candidate-navigation.js', 'components/panels/chat-plugin-mention-model.js',
      'components/panels/chat-plugin-mention.js']) await js(read(file) + '\nvoid 0;');
    for (const script of scripts) await js(script + '\nvoid 0;');
    await js('SoduWorkI18n.setLocale("zh-CN");'); await enter('overlay-a');
    const longTarget = 'C:/资料/' + 'Detailed-workspace-folder/'.repeat(8) + 'Settings.md';
    const thought = { kind: 'thinking', index: 7, text: '正在分析输入中的条件。', done: false };
    const assistant = { role: 'assistant', blocks: [thought], done: false, usage: { input: 0, output: 0, totalTokens: 0 } };
    const feedback = { status: 'streaming', messages: [{ role: 'user', text: 'Fixture request' }, assistant], tools: [], execution: { running: true, elapsedMs: 17000 } };
    await pending('overlay-a', [], feedback);
    await until('document.querySelector(".nthink.is-live.open")&&document.querySelector("[data-thinking-tokens]").textContent!=="0"', 'live reasoning opens and counts');
    let live = await js(`(()=>{const metric=document.querySelector('[data-chat-node=turn-metrics]'),m=metric.getBoundingClientRect(),body=document.querySelector('.nthink-body'),r=body.getBoundingClientRect();window.reasoningBody=body;return{above:m.bottom<=document.querySelector('.nthink').getBoundingClientRect().top+1,height:r.height,estimated:!metric.querySelector('[data-thinking-estimate]').hidden,header:document.querySelector('.nthink-head span').textContent,elapsed:metric.querySelector('[data-thinking-elapsed]').textContent,body:body.textContent};})()`);
    assert.equal(live.above,true);assert.ok(live.height>25&&live.height<70, 'short reasoning uses its natural height');assert.equal(live.estimated,true);assert.equal(live.header,'深度思考');assert.match(live.elapsed,/17s|18s/);
    report.reasoningHeights = { short: live.height };
    await shot('deep-thinking-short');
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 }); await delay(180);
    assert.deepEqual(await js(`(()=>{const box=document.querySelector('.nthink'),head=box.querySelector('.nthink-head'),icon=head.querySelector('.nthink-icon'),caret=head.querySelector('.nthink-caret');return{border:getComputedStyle(box).borderLeftWidth,order:[...head.children].map(e=>e.tagName),after:caret.previousElementSibling.tagName,hidden:Number(getComputedStyle(caret).opacity),iconTransform:getComputedStyle(icon).transform};})()`),
      { border: '0px', order: ['svg', 'SPAN', 'svg'], after: 'SPAN', hidden: 0, iconTransform: 'none' });
    const hoverPoint = await js(`(()=>{const r=document.querySelector('.nthink-head').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...hoverPoint });
    await until('Number(getComputedStyle(document.querySelector(".nthink-caret")).opacity)===1', 'reasoning hover animation settles');
    await shot('reasoning-header-hover');
    const countBeforeThinking=await js('document.querySelector("[data-thinking-tokens]").textContent');
    thought.text += '\n逐项核对约束及证据。'.repeat(70);
    await pending('overlay-a', [], feedback);
    await until('document.querySelector("[data-thinking-tokens]").textContent!=='+JSON.stringify(countBeforeThinking),'reasoning count advances');
    assert.equal(await js('window.reasoningBody===document.querySelector(".nthink-body")'),true);
    report.reasoningHeights.long = await js('document.querySelector(".nthink-body").getBoundingClientRect().height');
    assert.equal(report.reasoningHeights.long, 144, 'long reasoning caps at the previous fixed height');
    assert.equal(await js('(()=>{const e=document.querySelector(".nthink-body");return e.scrollHeight-e.scrollTop-e.clientHeight<4})()'),true);
    await click('.nthink-head'); await pending('overlay-a', [], feedback);
    assert.equal(await js('document.querySelector(".nthink").classList.contains("open")'),false);
    await click('.nthink-head');
    await shot('deep-thinking-live');
    thought.done=true;assistant.blocks.push({kind:'text',index:8,text:'Final answer is arriving.',done:false});
    await pending('overlay-a', [], feedback);
    await until('!document.querySelector(".nthink").classList.contains("open")','reasoning closes before answer finishes');
    assert.equal(await js('document.querySelector(".nthink-head").getAttribute("aria-expanded")'),'false');
    assert.equal(await js('getComputedStyle(document.querySelector(".nthink-head")).fontSize===getComputedStyle(document.querySelector(".ntext")).fontSize'), true);
    assert.equal(await js('getComputedStyle(document.querySelector(".nthink-icon")).transform'), 'none');
    await click('.nthink-head');await pending('overlay-a', [], feedback);
    assert.equal(await js('document.querySelector(".nthink").classList.contains("open")'),true);
    assert.equal(await js('document.querySelector(".nthink-body").getBoundingClientRect().height'),144, 'completed reasoning retains the same height cap when reopened');
    assert.equal(await js('getComputedStyle(document.querySelector(".nthink-body")).paddingLeft'),'0px', 'reasoning content shares the prose left edge');
    assistant.done=true;assistant.blocks[1].done=true;assistant.usage={input_tokens:100,output_tokens:80,total_tokens:180,completion_tokens_details:{reasoning_tokens:60}};
    feedback.status='idle';feedback.execution.running=false;
    await pending('overlay-a', [], feedback);
    await until('document.querySelector("[data-thinking-tokens]").textContent==="80"','reported usage replaces live estimate');
    assert.equal(await js('document.querySelector("[data-thinking-tokens]").textContent'),'80');
    assert.equal(await js('document.querySelector("[data-thinking-estimate]").hidden'),true);
    await until('document.querySelector("[data-thinking-label]").textContent==="已处理"','turn settles');
    await js('SoduWorkI18n.setLocale("en-US")');await delay(100);
    assert.equal(await js('document.querySelector(".nthink-head span").textContent'),'Deep thinking');
    assert.equal(await js('document.querySelector("[data-thinking-label]").textContent'),'Processed');
    await js('SoduWorkI18n.setLocale("zh-CN")');await delay(100);
    assert.equal(await js('document.querySelector(".nthink-head span").textContent'),'深度思考');
    for(const [adapterId,name,args,kind] of [
      ['pi','bash',{command:'pwd'},'command'],['opencode','write',{filePath:'report.md'},'write'],
      ['codex-harness','exec_command',{cmd:'pwd'},'command'],['qwen-code','write_file',{file_path:'report.md'},'write'],
      ['claude-code','Edit',{file_path:'report.md',old_string:'a',new_string:'b'},'edit'],
      ['codex','read_file',{path:'report.md'},'read'],['deepseek-harness','read',{path:'report.md'},'read']
    ]){
      feedback.adapterId=adapterId;feedback.tools=[{id:'icon-'+adapterId,name,args,state:'done',result:'fixture',after:1}];
      await pending('overlay-a', [], feedback);
      await until('document.querySelector("[data-tool-node=icon-'+adapterId+'] .ntool-icon")','tool icon rendered');
      assert.equal(await js('document.querySelector("[data-tool-node] .ntool-icon").dataset.toolKind'),kind);
      assert.equal(await js('getComputedStyle(document.querySelector(".ntool-name")).fontSize===getComputedStyle(document.querySelector(".ntext")).fontSize'),true);
    }
    feedback.tools = ['read', 'write', 'edit'].map((name, index) => ({id:'file-icon-'+index,name,args:{path:'report.md',content:'Result',oldText:'Old',newText:'New'},state:'done',result:'Fixture',after:1}));
    await pending('overlay-a', [], feedback);
    await click('.nthink-head');
    await click('.ntool-batch-head');
    report.executionLayout = [];
    for (const locale of ['zh-CN', 'en-US']) {
      await js('SoduWorkI18n.setLocale(' + JSON.stringify(locale) + ')');
      for (const theme of ['azure', 'warm']) {
        await js('document.documentElement.setAttribute("data-theme",' + JSON.stringify(theme) + ')');
        for (const width of [1100, 420]) {
          win.setSize(width, 800); await delay(120);
          const layout = await js(`(()=>{
            const text=document.querySelector('.ntext'),left=text.getBoundingClientRect().left,size=getComputedStyle(text).fontSize;
            const icons=[...document.querySelectorAll('.nthink-icon,.ntool-icon')];
            const labels=[...document.querySelectorAll('.nthink-head span,.ntool-name,.ntool-args,.ntool-batch-title,.ntool-batch-detail,.ntool-batch-count')];
            return {left,size,icons:icons.map(e=>e.getBoundingClientRect().left),sizes:labels.map(e=>getComputedStyle(e).fontSize),
              textColor:getComputedStyle(text).color,toolColor:getComputedStyle(document.querySelector('.ntool-batch-title')).color,
              borderless:[...document.querySelectorAll('.ntool,.ntool-batch,.ntool-batch-body,.ntool-body')].every(e=>{
                const s=getComputedStyle(e);return [s.borderTopWidth,s.borderBottomWidth,s.borderLeftWidth,s.borderRightWidth].every(w=>w==='0px')&&s.boxShadow==='none';}),
              overflow:document.querySelector('#nchatScroll').scrollWidth>document.querySelector('#nchatScroll').clientWidth+1};
          })()`);
          assert.ok(layout.icons.length>=4, 'group and individual icons are present');
          assert.ok(layout.icons.every(left=>Math.abs(left-layout.left)<1), 'thinking, tool groups, tool cards and prose share a left edge');
          assert.ok(layout.sizes.every(size=>size===layout.size), 'tool labels and arguments match prose size');
          assert.notEqual(layout.toolColor,layout.textColor, 'tool text uses the muted theme color');
          assert.equal(layout.borderless,true, 'tool groups and rows have no frames or dividing lines');
          assert.equal(layout.overflow,false, 'larger tool type does not overflow narrow chats');
          report.executionLayout.push({locale,theme,width,...layout});
        }
        win.setSize(1100,800); await delay(120);
        const toolHover = await js(`(()=>{const r=document.querySelector('.ntool-batch-head').getBoundingClientRect();return {x:Math.round(r.x+20),y:Math.round(r.y+r.height/2)}})()`);
        win.webContents.sendInputEvent({type:'mouseMove',...toolHover}); await delay(180);
        assert.equal(await js('getComputedStyle(document.querySelector(".ntool-batch")).boxShadow'),'none', 'hover never draws a card frame');
        await shot('thinking-file-icons-' + locale + '-' + theme);
      }
    }
    await js('SoduWorkI18n.setLocale("zh-CN");document.documentElement.setAttribute("data-theme","azure")');
    report.cases.push('Reasoning has an unrotated brain icon, no left rail, a trailing hover caret and body-sized label; live thinking stays bounded and folds on completion; both locales/themes and seven runtime tool aliases pass');
    if (executionLayoutOnly) {
      assert.deepEqual(await js('errors'), []); assert.deepEqual(report.errors, []);
      report.ok = true; return;
    }
    await pending('overlay-a', [], base());
    const before = await js('document.querySelector("#nchatScroll").scrollHeight');

    const first = request('first', longTarget), second = request('second');
    first.arguments.content = Array.from({ length: 40 }, (_, index) => 'Read-only preview line ' + index).join('\n');
    await pending('overlay-a', [first, second]);
    await until(overlayVisible, 'initial approval overlay');
    const modalBlock = await js(`(()=>{const dock=document.querySelector('.nchat-entry-dock'), mode=document.querySelector('#nchatMode'), send=document.querySelector('#nchatSend'); return {
      blocked:dock?.dataset.permissionBlocked==='true', dockBusy:dock?.getAttribute('aria-busy')==='true',
      modeInert:!!mode?.inert, sendInert:!!send?.inert,
      modeHit:!!(mode&&mode.contains(document.elementFromPoint((mode.getBoundingClientRect().left+mode.getBoundingClientRect().right)/2,(mode.getBoundingClientRect().top+mode.getBoundingClientRect().bottom)/2)))
    };})()`);
    assert.deepEqual(modalBlock, { blocked:true, dockBusy:true, modeInert:true, sendInert:true, modeHit:false }, 'permission approval blocks lower composer controls');
    assert.equal(await js('document.querySelector("#nchatMode")?.getAttribute("aria-expanded")'), 'false');
    assert.equal(await js('document.querySelector(".access-request").getAttribute("role")'), 'dialog');
    assert.equal(await js('document.querySelector("#nchatScroll").scrollHeight'), before, 'approval does not enlarge message scroll range');
    assert.equal(await js('document.querySelectorAll(".access-request").length'), 1);
    assert.equal(await js('document.body.textContent.includes("must-remain-hidden")'), false);
    await click('.access-request summary');
    for (const width of [1100, 360, 300]) {
      win.setSize(width, 800); await delay(130);
      for (const locale of ['en-US', 'zh-CN']) {
        await js('SoduWorkI18n.setLocale(' + JSON.stringify(locale) + ');'); await delay(100);
        const geometry = await js(`(()=>{const dialog=document.querySelector('.access-request'),popup=document.querySelector('.nchat-access-overlay').getBoundingClientRect(),box=document.querySelector('.nbox').getBoundingClientRect();return{center:Math.abs((popup.left+popup.right-box.left-box.right)/2)<2,width:popup.width>=box.width-26&&popup.width<=box.width,inside:popup.left>=-1&&popup.right<=innerWidth+1&&popup.top>=-1&&popup.bottom<=innerHeight+1,above:popup.bottom<=box.top+1,dialogOverflow:dialog.scrollWidth>dialog.clientWidth+1,bodyOverflow:document.documentElement.scrollWidth>innerWidth+1,label:document.querySelector('.access-request [data-ui-value=once]').textContent,path:document.querySelector('.access-target').textContent,open:dialog.querySelector('details').open}})()`);
        assert.equal(geometry.inside, true, JSON.stringify({ width, locale, geometry }));
        assert.equal(geometry.center,true);assert.equal(geometry.width,true);
        assert.equal(geometry.above, true, JSON.stringify({ width, locale, geometry }));
        assert.equal(geometry.dialogOverflow, false); assert.equal(geometry.bodyOverflow, false);
        assert.equal(geometry.label, locale === 'en-US' ? 'Allow once' : '允许一次'); assert.equal(geometry.path, longTarget); assert.equal(geometry.open, true);
        const decisions = await js(`(()=>{const buttons=[...document.querySelectorAll('.access-request .nask-btns button')],rects=buttons.map(b=>b.getBoundingClientRect());return{order:buttons.map(b=>b.dataset.uiValue),sameRow:rects.every(r=>Math.abs(r.top-rects[0].top)<1&&Math.abs(r.height-rects[0].height)<1),fits:buttons.every(b=>b.scrollWidth<=b.clientWidth+1),full:buttons.find(b=>b.dataset.uiValue==='full').textContent}})()`);
        assert.deepEqual(decisions.order, ['deny', 'once', 'full']);
        assert.equal(decisions.sameRow, true); assert.equal(decisions.fits, true);
        assert.equal(decisions.full, locale === 'en-US' ? 'Always allow' : '始终允许');
        await shot('permission-' + width + '-' + locale);
      }
    }
    report.cases.push('Complete NativeChat mounts one permission dialog above the input, outside message history, with no scroll growth; long details and both languages fit 300/360/1100px');
    win.setSize(1100, 800); await delay(100);
    await click('.access-request summary');
    await shot('permission-compact-zh-CN');
    await js('document.documentElement.setAttribute("data-theme","warm")');
    await shot('permission-compact-warm');
    await js('document.documentElement.setAttribute("data-theme","azure")');
    await pending('overlay-a', [{ ...request('short-screen', 'C:/Documents/report.md'), allowSession: false }]);
    win.setSize(360, 480); await delay(150);
    await js('SoduWorkI18n.setLocale("en-US");'); await delay(100);
    assert.equal(await js('document.querySelectorAll(".access-remember").length'), 0, 'session grants are absent when the adapter does not allow them');
    await js('document.querySelector(".access-request [data-ui-value=once]").focus();');
    const shortScreen = await js(`(()=>{const popup=document.querySelector('.access-request'),p=popup.getBoundingClientRect(),button=popup.querySelector('[data-ui-value=once]'),b=button.getBoundingClientRect();return{inside:p.top>=0&&p.bottom<=innerHeight,focusVisible:b.top>=p.top&&b.bottom<=p.bottom,overflow:popup.scrollWidth>popup.clientWidth+1,english:popup.querySelector('b').textContent==='Allow modifying this file?'}})()`);
    assert.deepEqual(shortScreen, { inside: true, focusVisible: true, overflow: false, english: true });
    await shot('permission-short-en-US');
    win.setSize(1100, 800); await delay(100);
    await pending('overlay-a', [first, second]);
    await js('SoduWorkI18n.setLocale("zh-CN");'); await delay(100);
    assert.equal(await js('document.querySelector(".access-count").textContent'), '+1');
    assert.equal(await js('document.querySelector(".access-count").getAttribute("aria-label")'), '还有 1 项待确认');
    report.cases.push('Compact request supports a 360×480 window with keyboard-reachable decisions, optional session grants, and localized accessible queue count');
    const countBefore = answers.length;
    // A pending permission request is modal: a programmatic click on the
    // composer is ignored just like a real pointer click behind the dialog.
    await js('document.querySelector("#nchatInput").click();');
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Escape' });
    await delay(60); assert.equal(answers.length, countBefore); assert.equal(await js(overlayVisible), true);
    hold = true; await click('.access-request [data-ui-value=once]');
    await until(() => replies.length === 1, 'approval awaiting IPC response');
    assert.equal(await js('[...document.querySelectorAll(".access-request [data-ui-answer]")].every(button=>button.disabled)'), true);
    await js('document.querySelector(".access-request [data-ui-value=deny]").click();'); await delay(50);
    assert.equal(answers.length, countBefore + 1);
    hold = false; replies.shift()();
    await until('document.querySelector(".access-request [data-ui-value=deny]")?.dataset.permissionRequest==="second"', 'next queued request');
    await click('.access-request [data-ui-value=deny]');
    await until('!' + overlayVisible, 'queue completed');
    assert.equal(await js('document.querySelector(".nchat-entry-dock")?.dataset.permissionBlocked || ""'), '');
    assert.equal(await js('document.querySelector("#nchatMode")?.inert'), false);
    assert.deepEqual(answers.slice(-2).map(row => row.value.decision), ['once', 'deny']);
    report.cases.push('Outside click and Escape never authorize; one reply disables every action and queued requests advance only after acknowledgement');
    await pending('overlay-a', [request('retry-request')]); failNext = true;
    await click('.access-request [data-ui-value=once]');
    await until('document.querySelector(".access-error")?.checkVisibility()', 'failed approval stays visible');
    assert.equal(await js('document.querySelector(".access-request [data-ui-value=once]").disabled'), false);
    assert.equal(sessions.get('overlay-a').data.pendingPermissions[0].requestId, 'retry-request');
    await click('.access-request [data-ui-value=once]'); await until('!' + overlayVisible, 'retry approval succeeded');
    report.cases.push('A failed approval keeps the original request visible, displays the error and permits an explicit retry');
    await pending('overlay-a', [request('old-request')]);
    hold = true; await click('.access-request [data-ui-value=once]'); await until(() => replies.length === 1);
    sessions.get('overlay-b').data.pendingPermissions = [request('new-chat-request')];
    sessions.get('overlay-b').data.pendingUi = sessions.get('overlay-b').data.pendingPermissions[0]; sessions.get('overlay-b').data.status = 'waiting-user';
    await enter('overlay-b');
    hold = false; replies.shift()(); await delay(120);
    assert.equal(await js('document.querySelector(".access-request [data-ui-value=once]").dataset.permissionRequest'), 'new-chat-request');
    assert.equal(await js('document.querySelector(".access-request [data-ui-value=once]").disabled'), false);
    await pending('overlay-b', []); await until('!' + overlayVisible, 'expired/cancelled authoritative snapshot');
    await pending('overlay-b', [request('stop-request')], { execution: { running: true } });
    const cancelledBeforePermission = cancelled;
    await js('document.querySelector("#nchatSend").click();'); await delay(60);
    assert.equal(cancelled, cancelledBeforePermission, 'stop/send is blocked while permission is pending');
    assert.equal(await js(overlayVisible), true);
    await click('.access-request [data-ui-value=deny]'); await until('!' + overlayVisible, 'permission clears before stop');
    await pending('overlay-b', [], { execution: { running: true } });
    await js('document.querySelector("#nchatSend").click();'); await until(() => cancelled === cancelledBeforePermission + 1, 'stop IPC');
    await pending('overlay-b', [request('reset-request')]);
    await js('NativeChat.reset();'); assert.equal(await js('document.querySelectorAll(".nchat-access-overlay").length'), 0);
    report.cases.push('A late reply cannot overwrite a newly opened chat; pending permission blocks Stop until acknowledgement, then Stop and reset clear the overlay');

    // Real SDK tool authorization through the same production dialog, preload and IPC handler.
    const real = add('overlay-real');
    fixture = await require('./fixtures/access-sdk.cjs').create(path.join(root, 'sdk'), 'standard', () => publish('overlay-real'));
    real.snapshot = () => ({ ...base(), ...fixture.access.snapshot(), status: fixture.access.broker.pending().length ? 'waiting-user' : 'idle' });
    real.answerUi = value => fixture.access.broker.answer(value);
    await enter('overlay-real');
    const outside = path.join(root, 'approved-outside.txt');
    let turn = fixture.send('write', { path: outside, content: 'approved through floating dialog' });
    await until(overlayVisible, 'real Pi write awaiting approval'); assert.equal(fs.existsSync(outside), false);
    await click('.access-request [data-ui-value=once]'); await turn;
    assert.equal(fs.readFileSync(outside, 'utf8'), 'approved through floating dialog');
    await until('!' + overlayVisible, 'real approval cleared');
    const denied = path.join(root, 'denied-outside.txt');
    turn = fixture.send('write', { path: denied, content: 'must not write' });
    await until(overlayVisible, 'real Pi write awaiting denial');
    await click('.access-request [data-ui-value=deny]'); await turn; assert.equal(fs.existsSync(denied), false);
    await until('!' + overlayVisible, 'real denial cleared');
    const remembered = path.join(root, 'remembered-outside.txt');
    turn = fixture.send('write', { path: remembered, content: 'Scoped session grant' });
    await until(overlayVisible, 'real Pi write awaiting session decision');
    assert.equal(await js('document.querySelector(".access-request [data-ui-value=session]")===null'), true);
    const legacyRequest = fixture.access.broker.pending()[0];
    await js('soduWorkAPI.conversationSession.answerUi("overlay-real",'+JSON.stringify({...legacyRequest,decision:'session'})+')'); await turn;
    assert.equal(fs.readFileSync(remembered, 'utf8'), 'Scoped session grant');
    await fixture.send('write', { path: remembered, content: 'Scoped session grant' });
    assert.equal(fixture.access.broker.pending().length, 0);
    await fixture.send('write', { path: remembered, content: 'Updated content for the approved target' });
    assert.equal(fixture.access.broker.pending().length, 0);
    assert.equal(fs.readFileSync(remembered, 'utf8'), 'Updated content for the approved target');
    const unapproved = path.join(root, 'unapproved-session-target.txt');
    turn = fixture.send('write', { path: unapproved, content: 'A different target requires approval' });
    await until(overlayVisible, 'another file target is outside the session grant');
    assert.equal(fs.existsSync(unapproved), false);
    await click('.access-request [data-ui-value=deny]'); await turn;
    assert.equal(fs.existsSync(unapproved), false);
    assert.equal(fs.readFileSync(remembered, 'utf8'), 'Updated content for the approved target');
    report.cases.push('Three aligned decisions fit 300/360/1100px in both locales and follow the selected theme; explicit session allowance covers later writes to the same target, while another target asks again and denial leaves no file');
    report.cases.push('Real mouse → production NativeChat overlay → preload → production approval IPC → real Pi SDK: allow-once writes only the approved temporary file; deny leaves no file');
    assert.deepEqual(await js('errors'), []); assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(async error => { report.error = error.stack || String(error); try {
    report.failureGeometry = await js(`['.nchat','.nchat-main','.nchat-stage','.nchat-entry-dock','.nbox','.nchat-access-overlay','.access-request','.access-body','.access-request summary'].map(selector=>{const el=document.querySelector(selector);return{selector,rect:el?.getBoundingClientRect().toJSON(),display:el&&getComputedStyle(el).display,overflow:el&&getComputedStyle(el).overflow}})`);
    report.failureRequest = await js('({session:NativeChat.sessionInfo(),button:document.querySelector(".access-request [data-ui-value=once]")?.outerHTML})');
    await shot('failure');
  } catch (_) {} }).finally(async () => {
    try { await fixture?.close(); } catch (error) { report.cleanupError = String(error); report.ok = false; }
    if (win && !win.isDestroyed()) win.destroy();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    app.exit(report.ok ? 0 : 1);
  });
}
