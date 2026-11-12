'use strict';
// Mouse and keyboard interaction with production composer modules; IPC is isolated.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), out = path.resolve(client, '../outputs/session-controls');
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-session-controls-')));
  let win; const report = { ok: false, cases: [], errors: [] };
  const read = f => fs.readFileSync(path.join(client, f), 'utf8');
  const js = code => win.webContents.executeJavaScript(code, true), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) { for (let i = 0; i < 100; i++) { if (await js(code)) return; await delay(30); } throw Error('Timed out: ' + code); }
  async function click(selector) {
    const p = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.checkVisibility())throw Error('Unavailable '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...p, button: 'left', clickCount: 1 }); await delay(60);
  }
  async function shot(name) { await delay(100); await win.webContents.capturePage(); await delay(70); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1100, height: 740, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', (_e, level, text) => { if (level >= 3) report.errors.push(text); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_r, cb) => cb({ cancel: true }));
    const fixture = path.join(out, 'fixture.html'), base = require('node:url').pathToFileURL(client + path.sep).href;
    fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><base href="' + base + '"><link rel="stylesheet" href="theme/variables.css"><link rel="stylesheet" href="components/panels/work-composer.css"><link rel="stylesheet" href="components/panels/chat-session-controls.css"><link rel="stylesheet" href="components/panels/panels-chat.css"><link rel="stylesheet" href="components/panels/agent-brand.css"><style>*{box-sizing:border-box}body{margin:0;font:14px var(--font-ui);background:var(--bg-1)}main{height:100vh;display:flex;flex-direction:column;justify-content:flex-end;max-width:850px;margin:auto;padding:16px}article{flex:1;padding:18px;color:var(--ink-3)}.nbox{width:100%}#nchatInput{height:96px}</style><main><article data-user-content>Preserved conversation</article><div id="nchatQueue"></div><div id="old"><button id="nchatMeta" class="nmeta"></button></div></main>');
    await win.loadFile(fixture);
    for (const f of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + f));
    for (const f of ['core/i18n-dom.js', 'core/i18n.js', 'components/panels/agent-brand.js', 'components/panels/work-composer.js', 'components/panels/chat-session-controls.js', 'components/panels/chat-composer-controls.js']) await js(read(f) + '\nvoid 0;');
    await js(`window.support={supported:true,canChangeDuringSession:true,schema:'soduwork.access-policy/v1',modes:['standard','full','readonly']};
      window.state={ref:'chat-a',adapterId:'codex-harness',displayName:'Codex Harness',accessControl:support,accessPolicy:{mode:'readonly',revision:1},model:{label:'dev-coding-large-agent'},selection:{name:''}};
      window.calls=[];window.waiters=[];window.changes=[];window.notices=[];
      window.soduWorkAPI={conversationSession:{setAccessMode:(ref,mode,revision)=>new Promise(resolve=>{calls.push({ref,mode,revision});waiters.push(resolve);})}};
      WorkComposer.upgradeChat(document.querySelector('#old'));document.querySelector('#nchatWdName').textContent='chat-test-workspace';
      window.controls=ChatComposerControls.create(document.querySelector('main'),{state:()=>state,say:s=>notices.push(s),accessChanged:r=>{const s=r.snapshot||r;state={...state,accessPolicy:s.accessPolicy,nextAccessPolicy:s.nextAccessPolicy};changes.push(r);},renderQueue(){},updateQueue(){}});controls.render();void 0;`);
    assert.equal(await js('document.querySelector("#nchatRuntimeName").textContent'), 'Codex Harness');
    assert.equal(await js('document.querySelector("#nchatMode").disabled'), false);
    await click('#nchatMode'); await click('[data-access-mode=standard]');
    assert.deepEqual(await js('calls[0]'), { ref: 'chat-a', mode: 'standard', revision: 1 });
    assert.equal(await js('state.accessPolicy.mode'), 'readonly');
    assert.equal(await js('document.querySelectorAll("[data-access-mode]:disabled").length'), 3);
    await js('window.gateResult=null;controls.waitForAccess().then(r=>gateResult=r);void 0;');
    assert.equal(await js('gateResult'), null);
    await js('waiters.shift()({ok:true,accessPolicy:state.accessPolicy,nextAccessPolicy:{mode:"standard",revision:2}});void 0;');
    await until('gateResult===true');
    assert.equal(await js('document.querySelector("#nchatModeName").textContent'), '默认权限');
    assert.equal(await js('document.querySelector(".nchat-access-pending").hidden'), false);
    report.cases.push('Live permission selection uses policy revision, waits for backend acknowledgement and labels the next-turn policy');
    await click('#nchatMode'); await click('[data-access-mode=full]');
    await js('waiters.shift()({ok:false,cancelled:true});void 0;'); await until('document.querySelector("#nchatMode").getAttribute("aria-busy")==="false"');
    assert.equal(await js('state.nextAccessPolicy.mode'), 'standard');
    assert.ok(await js('document.querySelector(".nchat-access-status").textContent.includes("已取消")'));
    await click('[data-access-mode=readonly]');
    await js('waiters.shift()({ok:false,reason:"权限更新失败，当前设置未改变"});void 0;'); await delay(80);
    assert.equal(await js('state.nextAccessPolicy.mode'), 'standard');
    report.cases.push('Full-access cancellation and backend failure retain the previously acknowledged permissions');
    await click('[data-access-mode=readonly]');
    await js('state={...state,ref:"chat-b",adapterId:"qwen",displayName:"Qwen Code",accessPolicy:{mode:"standard",revision:7},nextAccessPolicy:null};controls.render();waiters.shift()({ok:true,accessPolicy:{mode:"readonly",revision:3}});void 0;'); await delay(80);
    assert.equal(await js('state.accessPolicy.revision'), 7);
    assert.equal(await js('document.querySelector("#nchatRuntimeName").textContent'), 'Qwen Code');
    report.cases.push('Late updates from another conversation cannot change the current chat or its Agent label');
    await js("support.changeTakesEffect='current-turn';state.nextAccessPolicy={mode:'full',revision:8};controls.render();");
    for (const width of [1100, 640, 360]) {
      win.setSize(width, 740); await delay(80);
      for (const locale of ['en-US', 'zh-CN']) {
        await js('SoduWorkI18n.setLocale(' + JSON.stringify(locale) + ');'); await click('#nchatMode');
        const geometry = await js(`(()=>{const pop=document.querySelector('#nchatAccessPop').getBoundingClientRect(),badge=document.querySelector('#nchatRuntime').getBoundingClientRect(),icon=document.querySelector('#nchatRuntime .agent-brand').getBoundingClientRect();return{folderWidth:document.querySelector('#nchatWd').getBoundingClientRect().width,pending:document.querySelector('.nchat-access-pending').textContent,note:document.querySelector('.nchat-access-note').textContent,overflow:document.documentElement.scrollWidth>innerWidth,inside:pop.left>=0&&pop.right<=innerWidth&&pop.top>=0&&pop.bottom<=innerHeight,badgeVisible:badge.width>=28&&badge.left>=0&&badge.right<=innerWidth&&icon.width>=14,label:document.querySelector('#nchatRuntimeName').textContent,rows:[...document.querySelectorAll('[data-access-mode] b')].map(n=>n.textContent)}})()`);
        assert.equal(geometry.overflow, false, JSON.stringify({ width, locale, geometry })); assert.equal(geometry.inside, true, JSON.stringify({ width, locale, geometry })); assert.equal(geometry.badgeVisible, true, JSON.stringify({ width, locale, geometry }));
        assert.ok(geometry.folderWidth<=161,JSON.stringify(geometry));
        assert.equal(geometry.pending,locale==='en-US'?'Updating':'切换中');
        assert.ok(geometry.note.includes(locale==='en-US'?'this turn':'本轮'));
        assert.equal(geometry.label, 'Qwen Code'); assert.equal(geometry.rows[0], locale === 'en-US' ? 'Default access' : '默认权限');
        await shot('access-' + width + '-' + locale);
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await delay(60);
        assert.equal(await js('document.querySelector("#nchatAccessPop").hidden'), true);
      }
    }
    report.cases.push('Both locales work at 360/640/1100px with a folder at most 160px wide, current-turn transition text, visible Agent identity and keyboard dismissal');
    await js('state={...state,accessControl:{supported:false}};controls.render();'); await click('#nchatMode');
    assert.equal(await js('document.querySelectorAll("[data-access-mode]:disabled").length'), 3);
    assert.ok(await js('document.querySelector(".nchat-access-status").textContent.includes("暂不支持")'));
    assert.equal(await js('document.querySelector("article").textContent'), 'Preserved conversation');
    await js('state.accessControl=support;controls.render();');
    assert.equal(await js('document.querySelectorAll("[data-access-mode]:disabled").length'), 0);
    assert.equal(await js('document.querySelector(".nchat-access-status").hidden'), true);
    await js('controls.destroy();');
    report.cases.push('Unsupported runtimes explain their limitation without disabling the entry or touching conversation content');
    // Mount the complete conversation renderer, including the actual send path.
    const conversationFile = path.join(client, 'e2e/fixtures/workbench-annotations.html');
    const scripts = [];
    const html = fs.readFileSync(conversationFile, 'utf8').replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_, attrs, body) => {
      const src = attrs.match(/src=["']([^"']+)/); scripts.push(src ? fs.readFileSync(path.resolve(path.dirname(conversationFile), src[1]), 'utf8') : body); return '';
    });
    const nativeFixture = path.join(out, 'native-chat.html');
    fs.writeFileSync(nativeFixture, html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="' + require('node:url').pathToFileURL(path.dirname(conversationFile) + path.sep).href + '">'));
    win.setSize(1100, 740); await win.loadFile(nativeFixture);
    await js(`window.support={supported:true,canChangeDuringSession:true,schema:'soduwork.access-policy/v1',modes:['standard','full','readonly']};
      window.saved={status:'idle',messages:[{role:'assistant',blocks:[{kind:'text',text:'Original history'}]}],tools:[],usage:null,adapterId:'opencode',displayName:'OpenCode',accessControl:support,accessPolicy:{mode:'readonly',revision:1}};
      window.submits=[];window.permissionReply=null;window.soduWorkAPI={conversationSession:{
        open:async()=>({ok:true,ref:'native-ref',sessionId:'native-chat',adapterId:'opencode',displayName:'OpenCode',accessControl:support,cwd:'C:/fixture',model:{label:'Fixture model'},snapshot:structuredClone(saved)}),
        history:async()=>({ok:true,chats:[]}),outputs:async()=>({ok:true,items:[]}),snapshot:async()=>({ok:true,snapshot:structuredClone(saved)}),release:async()=>({ok:true}),
        onEvent:callback=>{window.publish=callback;return()=>{};},
        setAccessMode:(ref,mode,revision)=>new Promise(resolve=>{window.permissionReply=()=>{saved.nextAccessPolicy={mode,revision:revision+1};resolve({ok:true,snapshot:structuredClone(saved)});};}),
        send:async(ref,text)=>{submits.push({ref,text,policy:saved.nextAccessPolicy||saved.accessPolicy});saved.accessPolicy=saved.nextAccessPolicy||saved.accessPolicy;delete saved.nextAccessPolicy;saved.messages.push({role:'user',text});publish({ref,kind:'settled',snapshot:structuredClone(saved)});return{ok:true,snapshot:structuredClone(saved)};}
      }};void 0;`);
    await js(read('components/panels/agent-brand.js'));
    for (const script of scripts) await js(script + '\nvoid 0;');
    await js('NativeChat.enter("", "native-chat", {adapterId:"pi"});');
    await until('NativeChat.hasSession()');
    assert.equal(await js('NativeChat.sessionInfo().adapterId'), 'opencode');
    assert.equal(await js('document.querySelector("#nchatRuntimeName").textContent'), 'OpenCode');
    await click('#nchatMode'); await click('[data-access-mode=standard]');
    await js('document.querySelector("#nchatInput").value="Next turn";document.querySelector("#nchatInput").dispatchEvent(new Event("input",{bubbles:true}));');
    await click('#nchatSend'); await delay(80);
    assert.equal(await js('submits.length'), 0);
    await js('permissionReply();void 0;'); await until('submits.length===1');
    assert.equal(await js('submits[0].policy.mode'), 'standard');
    assert.equal(await js('document.querySelector(".nchat-access-pending").hidden'), true);
    assert.ok(await js('document.querySelector("#nchatList").textContent.includes("Original history")'));
    assert.equal(await js('NativeChat.sessionInfo().sessionId'), 'native-chat');
    report.cases.push('Complete NativeChat honors restored Agent metadata and waits for the permission reply before sending in the same chat with history retained');
    assert.deepEqual(await js('errors'), []);
    assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(e => { report.error = e.stack; }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); if (win) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
