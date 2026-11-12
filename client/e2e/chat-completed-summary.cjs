'use strict';
// Production presentation and bindings in isolated Chromium; deterministic snapshots, no model/network calls.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('error', error => { console.error(error); process.exitCode = 1; }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), output = path.resolve(client, '../outputs/chat-completed-summary');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-completed-summary-'))); app.disableHardwareAcceleration();
  fs.mkdirSync(output, { recursive: true });
  const report = { ok: false, scope: 'Production renderer, completion helper, status metrics, crew, Markdown, delivery decorators, CSS and input bindings',
    limits: ['Deterministic snapshots; no model/network calls.', 'Work/workflow controls are fixture buttons in production slots; no Hub actions.',
      'Clipboard writes captured at browser API boundary; system clipboard unchanged.', 'Real delivery decorators use fixture file metadata; no file open/download.'], results: [], layouts: [] };
  const scripts = ['vendor/markdown/marked.umd.js', 'vendor/markdown/purify.min.js',
    ...['agent-brand', 'chat-crew', 'chat-thinking-collapse', 'chat-dom-patch', 'chat-decorate-carry',
      'chat-plugin-draft-placement', 'chat-output-links', 'chat-deliveries', 'panels-chat-tools', 'chat-context-meter',
      'panels-chat-status', 'chat-scroll-follow', 'chat-markdown', 'chat-acceptance-results', 'chat-turn-summary',
      'chat-message-renderer', 'chat-composer-bindings'].map(name => 'components/panels/' + name + '.js')];
  const styles = ['theme/variables.css', ...['panels-chat', 'agent-brand', 'chat-crew', 'chat-deliveries'].map(name => 'components/panels/' + name + '.css')];
  const fixture = path.join(output, 'fixture.html');
  fs.writeFileSync(fixture, `<!doctype html><html lang="zh-CN" data-theme="azure"><meta charset="utf-8">
    <base href="${pathToFileURL(client + path.sep).href}"><title>Completed conversation regression</title>
    ${styles.map(file => '<link rel="stylesheet" href="' + file + '">').join('\n')}
    <style>body{margin:0;color:var(--ink);background:var(--bg-0);font:14px var(--font-ui)}#cpChat{height:100vh}</style>
    <div id="cpChat" class="nchat"><div class="nchat-main"><div id="nchatScroll" class="nchat-scroll"><div id="nchatList" class="nchat-inner"></div></div>
      <div hidden><textarea id="nchatInput"></textarea><button id="nchatSend"></button><div id="nchatQueue"></div><div id="nchatTaskSuggest"></div><button id="nchatWd"></button></div></div></div>
    <script>window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));</script>
    ${scripts.map(file => '<script src="' + file + '"></script>').join('\n')}
    <script>
      const noop=()=>{};window.SoduWorkAPI={taskStorageKey:()=> 'completed-summary-fixture'};
      window.ctx={_ref:'completed-summary',_sessionOptions:{},_collabTasks:new Map(),_collabEntries:()=>[],
        _openTool:new Set(),_openThink:new Set(),_closedThink:new Set(),_openToolGroup:new Set(),_pending:'',_pendingSentAt:0,
        _pendingPlugins:[],_pendingAttachmentNames:[],_outs:[],_api:()=>({}),_mount:()=>document.querySelector('#cpChat'),
        _messageWindowSize:80,_renderQueue:noop,_renderTaskStartPrompt:noop,_syncSlowStatusTicker:noop,_paintBar:noop,esc:ChatTools.esc,
        _snap:{status:'idle',execution:{running:false},tools:[],messages:[]}};
      window.metrics=ChatStatus.createThinking(()=>({snap:ctx._snap,ref:ctx._ref,pending:ctx._pending,document,esc:ctx.esc,tokenText:n=>Number(n).toLocaleString('en-US')}));
      ctx._syncThinkingClock=metrics.syncThinkingClock;ctx._turnMetricsHtml=metrics.metricsHtml;ctx._thinkingStatusHtml=metrics.statusHtml;ctx._refreshTurnMetrics=metrics.refreshThinkingUi;
      window.renderer=ChatMessageRenderer.create(ctx);ctx._render=renderer._render;ChatComposerBindings.create(ctx)._bind(ctx._mount());
      window.clipboardWrites=[];Object.defineProperty(navigator,'clipboard',{value:{async write(items){const item=items[0];
        clipboardWrites.push({plain:await(await item.getType('text/plain')).text(),html:item.types.includes('text/html')?await(await item.getType('text/html')).text():''});
      },async writeText(plain){clipboardWrites.push({plain,html:''})}}});
      window.visible=e=>Boolean(e&&e.checkVisibility({visibilityProperty:true,contentVisibilityAuto:true})&&e.getBoundingClientRect().height>0);
      window.fixtureReady=true;
    </script></html>`);
  let win;
  const js = async code => {
    new (require('node:vm').Script)(code);
    try { return await win.webContents.executeJavaScript(code, true); }
    catch (error) { throw Error(error.message + '\nFixture expression: ' + code); }
  }, delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const at = Date.parse('2026-10-23T02:00:00Z');
  const source = (agentId = 'pi', runId = 'run-one') => ({ agentId, runId, nodeKey: agentId + '-node' });
  const thought = (text, index = 0) => ({ kind: 'thinking', index, text, done: true });
  const text = (value, index = 1) => ({ kind: 'text', index, text: value, done: true });
  const call = (id, index) => ({ kind: 'toolcall', index, done: true, toolCall: { id, name: 'read' } });
  const answer = (blocks, extra = {}) => ({ role: 'assistant', blocks, sourceAgent: source(), done: true,
    stopReason: 'stop', completedAt: at + 23000, usage: { output: 25 }, ...extra });
  const user = (value, sentAt = at) => ({ role: 'user', text: value, sentAt });
  const tool = (id, after, extra = {}) => ({ id, name: 'read', toolKind: 'read', args: { path: id + '.md' },
    state: 'done', after, result: 'Local fixture content: ' + id, sourceAgent: source(), ...extra });
  const snapshot = (messages, tools = [], extra = {}) => ({ messages, tools, status: 'idle', execution: { running: false, elapsedMs: 23000 }, ...extra });
  const finalText = '结论：两份材料内容一致。', preface = '我会读取材料并核对。';
  const doneState = () => snapshot([user('核对两份材料并输出报告'), answer([thought('先确认材料范围。'), text(preface), call('read-one', 2)],
    { stopReason: 'toolUse', usage: { output: 15 }, completedAt: at + 9000 }), answer([thought('材料已齐，比较完成。'), text(finalText)])], [tool('read-one', 1)]);
  async function until(check) { for (let i = 0; i < 100; i++) { if (await js(check)) return; await delay(30); } throw Error('Timed out: ' + check); }
  async function publish(value, reset = false) {
    await js(`(()=>{${reset ? "metrics.stopThinkingClock();renderer.reset();ctx._openThink.clear();ctx._closedThink.clear();ctx._openToolGroup.clear();ctx._outs=[];ctx._workCards=null;ctx._pending='';ctx._sessionOptions={};document.querySelector('#nchatList').replaceChildren();" : ''}
      ctx._snap=${JSON.stringify(value)};renderer._render();})()`); await delay(170);
  }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!visible(e))throw Error('Hidden target: '+${JSON.stringify(selector)});
      e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 }); await delay(180);
  }
  async function key(selector, keyCode) {
    win.webContents.focus();
    await js(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    win.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Space' ? ' ' : '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await delay(180);
  }
  const visibleTexts = () => js(`Array.from(document.querySelectorAll('#nchatList .ntext')).filter(visible).map(e=>e.textContent.trim())`);
  async function closed(finals, heads = 1) {
    assert.deepEqual(await visibleTexts(), finals, 'only final reply prose remains visible');
    assert.equal(await js('Array.from(document.querySelectorAll("#nchatList .nthink,#nchatList .ntool")).filter(visible).length'), 0, 'thinking/tools stay mounted but folded');
    assert.equal(await js('Array.from(document.querySelectorAll("#nchatList .nchat-agent-source")).filter(visible).length'), heads, 'Harness identity remains visible');
  }
  async function screenshot(name) { await js('document.querySelector("#nchatScroll").scrollTop=0'); await delay(120);
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
  async function viewport(width) { win.setContentSize(width, 820); await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',
    { width, height: 820, deviceScaleFactor: 1, mobile: false }); await delay(120); }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1100, height: 820, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, done) => done({ cancel: true }));
    await win.loadFile(fixture); await until('window.fixtureReady===true'); win.webContents.debugger.attach('1.3'); await viewport(1100);
    assert.deepEqual(await js('window.errors'), []);
    const complete = doneState(), live = structuredClone(complete);
    live.status = 'streaming'; live.execution.running = true; live.messages[2].done = false;
    live.messages[2].blocks.forEach(block => block.done = false);
    await publish(live, true);
    assert.equal(await js('document.querySelectorAll("[data-turn-toggle],[data-turn-hidden],[data-turn-process]").length'), 0);
    assert.deepEqual(await visibleTexts(), [preface, finalText]); assert.equal(await js('visible(document.querySelector(".ntool"))'), true);
    await js(`window.liveText=document.querySelector('[data-chat-node="message:2"] .ntext')`);
    live.messages[2].blocks[1].text += ' 正在整理报告。'; await publish(live);
    assert.equal(await js(`document.querySelector('[data-chat-node="message:2"] .ntext')===window.liveText`), true);
    report.results.push('Live thought, intermediate prose and tools remain visible; token updates preserve the text DOM and create no completion summary');
    complete.turnMetrics = [{ fromMessage: 0, toMessage: 2, elapsedMs: 23000, tokens: 311 }];
    await publish(complete); await closed([finalText]);
    assert.equal(await js('document.querySelectorAll(".nturn-summary").length'), 1);
    assert.equal(await js('document.querySelectorAll(".nturn-metrics").length'), 0);
    assert.match(await js('document.querySelector(".nturn-summary").innerText'), /23s/);
    assert.doesNotMatch(await js('document.querySelector(".nturn-summary").innerText'), /311|tokens/);
    assert.equal(await js('document.querySelectorAll(".nthink").length'), 2); assert.equal(await js('document.querySelectorAll(".ntool").length'), 1);
    await js(`window.processNode=document.querySelector('[data-chat-node="message:1"]');window.finalNode=document.querySelector('[data-chat-node="message:2"]')`);
    report.results.push('Completion folds process and preserves the final answer while keeping usage metadata out of the message summary');
    const delayed = structuredClone(complete); delayed.execution.elapsedMs = 323000;
    await publish(delayed);
    assert.match(await js('document.querySelector(".nturn-summary").innerText'), /23s/);
    assert.doesNotMatch(await js('document.querySelector(".nturn-summary").innerText'), /311|tokens/);
    await js("ctx._ref='duration-other'"); await publish(snapshot([user('Other request'), answer([text('Other answer')], { completedAt: at + 7000 })]));
    assert.match(await js('document.querySelector(".nturn-summary").innerText'), /7s/);
    await js("ctx._ref='completed-summary'"); await publish(delayed);
    assert.match(await js('document.querySelector(".nturn-summary").innerText'), /23s/);
    assert.doesNotMatch(await js('document.querySelector(".nturn-summary").innerText'), /311|tokens/);
    await publish(delayed, true);
    assert.match(await js('document.querySelector(".nturn-summary").innerText'), /23s/);
    assert.doesNotMatch(await js('document.querySelector(".nturn-summary").innerText'), /311|tokens/);
    const unknownTiming = snapshot([{ role: 'user', text: 'Legacy request' },
      { role: 'assistant', done: true, blocks: [text('Legacy answer')] }], [], { execution: { running: false, elapsedMs: 0 } });
    await publish(unknownTiming, true);
    assert.match(await js('document.querySelector(".nturn-summary").innerText'), /用时\s*—/);
    await publish(complete, true);
    await js(`window.processNode=document.querySelector('[data-chat-node="message:1"]');window.finalNode=document.querySelector('[data-chat-node="message:2"]')`);
    report.results.push('Completed duration stays 23s when an idle counter advances, across conversation switches and remount; another turn keeps 7s and unknown historical timing stays —');
    await click('[data-turn-toggle]'); assert.equal(await js('document.querySelector("[data-turn-toggle]").getAttribute("aria-expanded")'), 'true');
    assert.equal(await js('Array.from(document.querySelectorAll(".nthink,.ntool")).filter(visible).length'), 3); assert.deepEqual(await visibleTexts(), [preface, finalText]);
    await click('[data-chat-node="message:1"] .nthink-head'); assert.equal(await js(`visible(document.querySelector('[data-chat-node="message:1"] .nthink-body'))`), true);
    await publish(complete); assert.equal(await js('document.querySelector("[data-turn-toggle]").getAttribute("aria-expanded")'), 'true');
    assert.equal(await js(`document.querySelector('[data-chat-node="message:1"]')===window.processNode&&document.querySelector('[data-chat-node="message:2"]')===window.finalNode`), true);
    await key('[data-turn-toggle]', 'Enter'); await closed([finalText]); await key('[data-turn-toggle]', 'Space');
    assert.equal(await js('document.querySelector("[data-turn-toggle]").getAttribute("aria-expanded")'), 'true');
    await js("ctx._ref='another-completed-session'"); await publish(complete); await closed([finalText]);
    await js("ctx._ref='completed-summary'"); await publish(complete); await closed([finalText]);
    report.results.push('Mouse and Enter/Space expand/collapse; expanded state and message DOM survive rerender and reset on session change');
    complete.tools[0].sourceAgent = source('claude', 'run-tool'); complete.messages[2].sourceAgent = source('codex', 'run-final');
    complete.messages[2].blocks[1].text = finalText + '成果见 [核对报告](report.pdf)。';
    await js("ctx._outs=[{artifactId:'summary-report',path:'report.pdf',relative:'report.pdf',name:'核对报告.pdf',kind:'document',primary:true,changedInTurn:true,at:1,size:2048}]");
    await publish(complete);
    assert.equal(await js('document.querySelectorAll(".nchat-agent-source").length'), 1);
    assert.deepEqual(await js('Array.from(document.querySelectorAll(".nchat-agent-source .agent-brand"),e=>Array.from(e.classList).find(c=>c.startsWith("agent-brand-")).slice(12)).sort()'), ['claude', 'codex', 'pi']);
    assert.equal(await js('Array.from(document.querySelectorAll(".ndelivery")).filter(visible).length'), 1);
    assert.equal(await js('document.querySelector(".ndelivery").closest(".nmsg").dataset.messageOwner'), '2');
    await js('window.savedDelivery=document.querySelector(".ndelivery")'); await click('[data-turn-toggle]'); await click('[data-turn-toggle]');
    assert.equal(await js('document.querySelector(".ndelivery")===window.savedDelivery&&visible(window.savedDelivery)'), true);
    report.results.push('Pi/Claude/Codex share one visible stack; production delivery card stays with final owner and preserves identity through both fold directions');
    for (const width of [1100, 360]) {
      await viewport(width);
      const layout = await js(`(()=>{const elements=[document.documentElement,document.body,document.querySelector('#nchatScroll'),document.querySelector('#nchatList'),
        ...document.querySelectorAll('.nturn-summary,.nchat-agent-source,.ndelivery')];return{width:innerWidth,rows:elements.map(e=>({tag:e.id||e.className||e.tagName,
          width:e.clientWidth,scrollWidth:e.scrollWidth,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right}))}})()`);
      assert.equal(layout.width, width); for (const row of layout.rows) {
        assert.ok(row.scrollWidth <= row.width + 1, 'no horizontal overflow: ' + JSON.stringify(row));
        assert.ok(row.left >= -1 && row.right <= width + 1, 'content fits viewport: ' + JSON.stringify(row));
      }
      report.layouts.push(layout); await screenshot('completed-' + width);
    }
    await viewport(1100); report.results.push('Crew, metrics, final reply and real delivery card fit 1100 px and 360 px viewports');
    // Match the submission baseline captured by the production send path.
    await js("ctx._pending='继续下一轮';ctx._pendingBaseline={messageCount:ctx._snap.messages.length}"); await publish(complete);
    assert.equal(await js('document.querySelectorAll("[data-turn-toggle]").length'), 1);
    assert.equal(await js('visible(window.savedDelivery)&&document.querySelector(".ndelivery")===window.savedDelivery'), true);
    const nextLive = structuredClone(complete); nextLive.messages.push(user('继续下一轮', at + 60000),
      answer([thought('新一轮正在分析。'), text('新一轮正在执行。')], { done: false, stopReason: '', usage: null, completedAt: 0 }));
    nextLive.status = 'streaming'; nextLive.execution.running = true;
    await publish(nextLive);
    assert.equal(await js('ctx._pending'), '', 'native user echo consumes optimistic turn');
    assert.equal(await js('document.querySelectorAll("[data-turn-toggle]").length'), 1, 'only prior completed turn has a summary');
    assert.equal(await js(`visible(document.querySelector('[data-chat-node="message:1"] .ntext'))`), false);
    assert.equal(await js(`visible(document.querySelector('[data-chat-node="message:4"] .ntext'))`), true);
    assert.equal(await js('visible(window.savedDelivery)&&document.querySelector(".ndelivery")===window.savedDelivery'), true);
    report.results.push('Optimistic submit and confirmed next live turn preserve the prior collapsed final answer and same delivery DOM; current process remains visible');
    for (const reference of ['[网页截图](screenshot.png)', '![网页截图](screenshot.png)']) {
      const website = snapshot([user('制作网站并展示截图'),
        answer([text('检查完成：' + reference), call('capture', 2)], { stopReason: 'toolUse' }),
        answer([text('网站已完成。[打开网站](index.html)')])], [tool('capture', 1)]);
      await publish(website, true);
      await js(`ctx._outs=[{artifactId:'site',name:'index.html',relative:'index.html',kind:'website',primary:true,changedInTurn:true,at:1},
        {artifactId:'shot',name:'screenshot.png',relative:'screenshot.png',kind:'image',primary:false,processEvidence:true,changedInTurn:true,at:2},
        {artifactId:'private-shot',name:'other-test.png',relative:'other-test.png',kind:'image',primary:false,processEvidence:true,changedInTurn:true,at:3}]`);
      await publish(website);
      assert.equal(await js('Array.from(document.querySelectorAll("[data-output-image=shot]")).filter(visible).length'), 1,
        'explicit intermediate screenshot keeps one actionable entry after completion');
      assert.equal(await js('document.querySelector("[data-output-image=shot]").closest(".nmsg").dataset.messageOwner'), '2');
      assert.equal(await js('document.querySelectorAll("[data-output-image=private-shot]").length'), 0,
        'unmentioned evidence stays hidden');
      assert.equal(await js('Array.from(document.querySelectorAll(".ndelivery")).filter(visible).length'), 1);
      await js('window.screenshotEntry=document.querySelector("[data-output-image=shot]")');
      await click('[data-turn-toggle]'); await click('[data-turn-toggle]'); await publish(website);
      assert.equal(await js('visible(window.screenshotEntry)&&document.querySelector("[data-output-image=shot]")===window.screenshotEntry'), true);
      website.messages.push(user('下一轮只回复文字', at + 60000), answer([text('下一轮已完成。')]));
      await publish(website);
      assert.equal(await js('document.querySelectorAll("[data-output-image=shot]").length'), 1);
      assert.equal(await js('document.querySelector("[data-output-image=shot]").closest(".nmsg").dataset.messageOwner'), '2',
        'screenshot ownership cannot cross the next user turn');
    }
    report.results.push('Intermediate screenshot links and Markdown images remain visible above the final-turn delivery; no unmentioned evidence or next-turn reassignment');
    const history = doneState(); history.messages.push(user('检查下一轮', at + 60000), answer([text('第二轮结论。', 0)], { usage: { output: 222 }, completedAt: at + 64000 }));
    history.execution.elapsedMs = 4000; history.history = { messageStart: 40, messageIndices: [40, 43, 49, 55, 58], truncated: true };
    history.turnMetrics = [{ fromMessage: 40, toMessage: 49, elapsedMs: 23000, tokens: 111 }, { fromMessage: 55, toMessage: 58, elapsedMs: 4000, tokens: 222 }];
    // Opening persisted history has its own ref; replacing unrelated snapshots
    // inside one live ref would incorrectly retain that ref's monotonic clock.
    await js("ctx._ref='historical-summary-session'");
    await publish(history, true); await closed([finalText, '第二轮结论。'], 2);
    const summaries = await js('Array.from(document.querySelectorAll("[data-turn-toggle]"),e=>({key:e.dataset.turnToggle,text:e.innerText}))');
    assert.deepEqual(summaries.map(row => row.key), ['reply:49', 'reply:58']);
    assert.doesNotMatch(summaries[0].text, /111|222|tokens/);
    assert.match(summaries[0].text, /23s/); assert.match(summaries[1].text, /4s/);
    assert.doesNotMatch(summaries[1].text, /23s/);
    assert.doesNotMatch(summaries[1].text, /222|tokens/); await click('[data-turn-toggle="reply:49"]');
    const sliding = structuredClone(history); sliding.messages.shift(); sliding.tools[0].after = 0; sliding.history.messageStart = 43; sliding.history.messageIndices.shift();
    await publish(sliding); assert.equal(await js(`document.querySelector('[data-turn-toggle="reply:49"]').getAttribute('aria-expanded')`), 'true');
    assert.equal(await js(`document.querySelector('[data-turn-toggle="reply:58"]').getAttribute('aria-expanded')`), 'false');
    assert.doesNotMatch(await js(`document.querySelector('[data-turn-toggle="reply:49"]').innerText`), /111|tokens/);
    await publish(history); await click('[data-turn-toggle="reply:49"]'); await screenshot('two-turns-1100');
    const unknown = structuredClone(history); delete unknown.turnMetrics; await publish(unknown);
    assert.doesNotMatch(await js(`document.querySelector('[data-turn-toggle="reply:49"]').innerText`), /40|222|tokens/);
    report.results.push('Raw owner IDs preserve independent expansion and metrics across history remapping; legacy snapshots recover their own per-message output usage without borrowing the latest count');
    const nativeMissing = snapshot([user('First native turn'), answer([thought('先确认'), text('完成')],
      { usage: null, sourceAgent: source('harness2') }), user('Second native turn', at + 60000),
      answer([text('第二轮完成。')], { usage: { output: 19 }, sourceAgent: source('harness2'), completedAt: at + 64000 })], [],
      { usage: { output: 999999 }, contextUsage: { input: 80000 } });
    await publish(nativeMissing, true);
    const nativeValues = () => js('Array.from(document.querySelectorAll(".nturn-summary"),node=>node.innerText)');
    const beforeSwitch = await nativeValues();
    assert.doesNotMatch(beforeSwitch.join(' '), /5|19|tokens/);
    assert.doesNotMatch(beforeSwitch.join(' '), /—|999999|80000/);
    await js("ctx._ref='another-conversation'"); await publish(doneState(), true);
    await js("ctx._ref='native-missing-reopened'"); await publish(JSON.parse(JSON.stringify(nativeMissing)), true);
    assert.deepEqual(await nativeValues(), beforeSwitch, 'reopening estimates exactly the same retained output');
    nativeMissing.turnMetrics = [{ fromMessage: 0, toMessage: 1, tokens: 7, elapsedMs: 23000 },
      { fromMessage: 2, toMessage: 3, tokens: 19, elapsedMs: 4000 }];
    await publish(nativeMissing);
    assert.doesNotMatch((await nativeValues())[0], /7|≈|—|tokens/);
    await screenshot('native-usage-reconciled');
    report.results.push('Google Harness2 missing native usage shows a marked thinking/text estimate per round, remains stable after switching/reopening and reconciles a late authoritative receipt without using context/session totals');
    const merged = snapshot([user('继续并整理最终回复'), answer([thought('先核对上下文。'), text('这是工具前的过程说明。'), call('merged-tool', 2),
      thought('核对已完成。', 3), text('这是最终结论。', 4)])], [tool('merged-tool', 1)]);
    await publish(merged, true); await closed(['这是最终结论。']);
    assert.equal(await js('document.querySelector(".nmsg.ai [data-copy-message]").dataset.copyMessage'), '这是最终结论。');
    await click('.nmsg.ai [data-copy-message]'); await until('window.clipboardWrites.length>0');
    assert.equal(await js('window.clipboardWrites.at(-1).plain.trim()'), '这是最终结论。'); assert.doesNotMatch(await js('window.clipboardWrites.at(-1).html'), /工具前/);
    await click('[data-turn-toggle]'); await click('.nmsg.ai [data-copy-message]');
    assert.equal(await js('window.clipboardWrites.at(-1).plain.trim()'), '这是最终结论。', 'expanded process remains excluded from final-answer copy');
    report.results.push('Merged continuation shows/copies only text after the last tool; actual rich/plain clipboard payload excludes process in both fold states');
    for (const [name, patch] of [['failed', { status: 'no-output', statusText: '服务失败，请重试。', reason: 'error' }],
      ['aborted', { status: 'idle', reason: 'aborted' }], ['incomplete', { status: 'incomplete', statusText: '回复尚未完成。', reason: 'length' }],
      ['waiting', { status: 'waiting-user', pendingUi: { method: 'confirm', title: '需要你确认', message: '继续当前操作？' } }]]) {
      const state = doneState(); Object.assign(state, patch); delete state.reason; if (patch.reason) state.messages[2].stopReason = patch.reason;
      if (name === 'failed') state.tools[0].state = 'error'; await publish(state, true);
      assert.equal(await js('document.querySelectorAll("[data-turn-toggle]").length'), 0, name + ' cannot present as successful completion');
      assert.equal(await js('Array.from(document.querySelectorAll(".nthink,.ntool")).filter(visible).length'), 3, name + ' preserves process');
      assert.deepEqual(await visibleTexts(), [preface, finalText]);
      if (name === 'waiting') assert.equal(await js('visible(document.querySelector("[data-ui-answer]"))'), true);
      if (name === 'failed' || name === 'incomplete') assert.equal(await js('visible(document.querySelector(".nbad.show"))'), true);
    }
    report.results.push('Failed, aborted, incomplete and waiting-user turns retain process; runtime errors and production confirmation buttons remain visible');
    const goal = doneState(); await publish(goal, true); await js("ctx._sessionOptions={intent:'goal'};renderer._render()");
    await closed([finalText]); assert.equal(await js('document.querySelectorAll(".nprocess").length'), 1, 'goal fixture actually mounts its narrated process row');
    assert.equal(await js('Array.from(document.querySelectorAll(".nprocess")).filter(visible).length'), 0);
    await click('[data-turn-toggle]'); assert.equal(await js('visible(document.querySelector(".ntool"))'), true);
    assert.equal(await js('Array.from(document.querySelectorAll(".nprocess")).filter(visible).length'), 1);
    report.results.push('Completed goal mode folds narrated process rows along with tools while preserving the Harness');
    const pausedText = '协作暂停：本次运行已停止。请在输入框上方处理，后续步骤尚未执行。';
    const stoppedWorkflow = snapshot([user('Run a multi-step workflow'),
      ...Array.from({ length: 20 }, (_, index) => answer([thought('Inspect step ' + index), text('Step ' + index + ' finished')],
        { taskOutputKey: 'workflow:step:' + index })),
      answer([text(pausedText)], { taskOutputKey: 'workflow:paused' })]);
    const pausedGap = () => js(`(()=>{const summary=document.querySelector('.nturn-summary').getBoundingClientRect(),
      final=document.querySelector('[data-chat-node="message:21"] .ntext').getBoundingClientRect();
      return {gap:final.top-summary.bottom,emptyProcessRows:Array.from(document.querySelectorAll('[data-turn-process]')).filter(visible).length}})()`);
    for (const width of [1100, 360]) {
      await viewport(width); await publish(stoppedWorkflow, true);
      await closed([pausedText]);
      const bounds = await pausedGap(); report.layouts.push({ width, pausedWorkflow: bounds });
      assert.ok(bounds.gap <= 24, 'Collapsed empty workflow slots must not accumulate blank spacing: ' + JSON.stringify(bounds));
      assert.equal(bounds.emptyProcessRows, 0, 'Empty workflow slots retain their DOM without layout boxes');
      await screenshot('paused-workflow-' + width);
    }
    await viewport(1100);
    await js(`window.workflowSlot=document.querySelector('[data-workflow-message-key="workflow:step:5"]');
      window.pausedAction=document.createElement('button');pausedAction.textContent='Resume workflow';
      pausedAction.onclick=()=>window.pausedActionClicks=(window.pausedActionClicks||0)+1;workflowSlot.append(pausedAction);`);
    assert.ok(await js('visible(pausedAction)'), 'Late workflow actions must appear even inside a folded process row');
    await click('[data-workflow-message-key="workflow:step:5"] button');
    assert.equal(await js('pausedActionClicks'), 1);
    await publish(stoppedWorkflow);
    assert.ok(await js('workflowSlot.firstChild===pausedAction&&visible(pausedAction)'), 'Rerender retains actionable workflow controls');
    await js('pausedAction.hidden=true');
    assert.ok((await pausedGap()).gap <= 24, 'Hidden workflow controls must not keep an empty process row visible');
    await click('[data-turn-toggle]');
    assert.equal((await visibleTexts()).length, 21, 'Expanding still shows every workflow step');
    await click('[data-turn-toggle]'); await closed([pausedText]);
    assert.ok((await pausedGap()).gap <= 24, 'Collapsing again removes every empty process row');
    await publish(stoppedWorkflow, true);
    assert.ok((await pausedGap()).gap <= 24, 'Reopening a paused workflow keeps compact spacing');
    report.results.push('Stopped workflow with 20 empty process slots stays compact at 1100/360px; late actions remain clickable and retain DOM; hidden actions, recollapse and reopen remove empty spacing');
    const controls = doneState(); controls.messages[1].taskOutputKey = 'workflow:waiting'; await publish(controls, true);
    await js(`ctx._workCards={timeline:()=>[{id:'retained-work',index:2}],paint(){const slot=document.querySelector('[data-work-card-slot="retained-work"]');
      if(slot&&!slot.firstChild){const button=document.createElement('button');button.textContent='需求回执';button.dataset.fixtureWork='';slot.append(button)}}};renderer._render();
      const action=document.createElement('button');action.textContent='确认继续';action.dataset.fixtureWorkflow='';document.querySelector('.nworkflow-message-slot').append(action);
      window.savedWorkflow=action;window.savedWork=document.querySelector('[data-fixture-work]');`);
    assert.equal(await js('visible(window.savedWorkflow)&&visible(window.savedWork)'), true); await publish(controls);
    assert.equal(await js('document.querySelector("[data-fixture-work]")===window.savedWork&&visible(window.savedWork)'), true);
    assert.equal(await js('document.querySelector("[data-fixture-workflow]")===window.savedWorkflow&&visible(window.savedWorkflow)'), true);
    await click('[data-turn-toggle]'); await click('[data-turn-toggle]'); assert.equal(await js('visible(window.savedWorkflow)&&visible(window.savedWork)'), true);
    report.results.push('Production work/workflow slots retain visible fixture controls and DOM identity through rerender, expand and collapse');
    assert.deepEqual(await js('window.errors'), []); report.ok = true;
  }).catch(async error => {
    report.error = error.stack || String(error);
    if (win && !win.isDestroyed()) try { report.diagnostics = await js('({errors:window.errors,html:document.querySelector("#nchatList")?.innerHTML})'); await screenshot('failure'); } catch (_) {}
  }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, diagnostics: report.diagnostics ? { errors: report.diagnostics.errors } : undefined }, null, 2));
    if (win && !win.isDestroyed()) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
