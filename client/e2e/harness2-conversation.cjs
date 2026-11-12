'use strict';
// Real Runner adapter, NativeChat, preload, approval IPC and artifact pipeline.
// Runner RPC is deterministic and local; no account, model or installation is used.
const electron = require('electron');
if (typeof electron === 'string') {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-harness2-conversation-')));
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  env.SODUWORK_CONVERSATION_FIXTURE_ROOT = root;
  const child = require('node:child_process').spawn(electron, [__filename], {
    env, windowsHide: true, stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => {
    clearTimeout(timer); process.exitCode = code ?? 1;
    // Chromium still owns its profile while the Electron process is alive.
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), root);
    if (!relative.startsWith('..') && !path.isAbsolute(relative) &&
        path.basename(root).startsWith('soduwork-harness2-conversation-')) {
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
      catch (error) { console.error('Fixture cleanup failed:', error.code); process.exitCode = 1; }
    }
  });
} else {
  const { app, BrowserWindow, ipcMain, nativeImage } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..');
  const root = fs.realpathSync.native(process.env.SODUWORK_CONVERSATION_FIXTURE_ROOT);
  const out = path.resolve(client, '../outputs/harness2-conversation');
  const artifacts = require('../main/conversation/artifact-runtime');
  const rules = require('../main/access-control/policy');
  const catalog = require('../main/agent-runtime/runtime-catalog');
  const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
  const handles = new Map(), sessions = [], artifactActions = [], report = {
    ok: false, cases: [], errors: [],
    boundary: 'Synthetic Runner RPC through real adapter and Electron UI; Pi uses its documented snapshot shape as a renderer control. No actual model behavior is claimed.',
  };
  const prompt = '制作一个单页 HTML，保存为 index.html，并检查页面。';
  const support = { supported: true, schema: rules.SCHEMA, modes: [...rules.MODES],
    canChangeDuringSession: true, changeTakesEffect: 'current-turn' };
  let win, activeFixture;
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(check, label) {
    for (let n = 0; n < 200; n++) {
      if (await (typeof check === 'string' ? js(check) : check())) return;
      await delay(25);
    }
    throw Error('Timed out: ' + label);
  }
  async function click(selector) {
    const point = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
      assertFixture(el&&el.checkVisibility()&&!el.disabled,'Unavailable control');
      el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();
      const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
      assertFixture(el.contains(document.elementFromPoint(x,y)),'Occluded control');return{x,y};})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({
      type, ...point, button: 'left', clickCount: 1,
    });
    await delay(50);
  }
  function css(file) {
    return fs.readFileSync(file, 'utf8').replace(/@import\s+url\(["']?([^"')]+)["']?\)\s*;/g,
      (_, relative) => css(path.resolve(path.dirname(file), relative)))
      .replace(/url\(["']?([^"')]+)["']?\)/g, (match, relative) =>
        /^(?:data:|https?:|file:)/.test(relative) ? match :
          'url("' + pathToFileURL(path.resolve(path.dirname(file), relative)).href + '")');
  }
  function request(cwd, id) {
    const operation = rules.operation(rules.create('standard', cwd), 'bash',
      { command: 'node verify-page.cjs' }, cwd);
    assert.equal(operation.verdict, 'ask', 'Use a real standard-mode approval boundary');
    return { ...operation, method: 'permission', requestId: id,
      createdAt: Date.now(), expiresAt: Date.now() + 60000, allowSession: true };
  }
  function publish(ref, event, snapshot) {
    if (!win.isDestroyed()) win.webContents.send('pi-session-event', { ref, ...event, snapshot });
  }
  async function runner(adapterId) {
    const cwd = path.join(root, adapterId);
    fs.mkdirSync(cwd);
    const policy = rules.create('standard', cwd), calls = [], terminal = [];
    let status = 'done', pending = [], items = [], seq = 0, finishing = false;
    const add = item => items.push({ seq: ++seq, at: Date.now(), ...item });
    const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime(adapterId),
      modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture-only' } }) },
      runnerRuntime: { async rpc(op, payload) {
        calls.push({ op, payload });
        if (op === 'runtime.detect') return { ok: true, data: { installed: true, state: 'ready', accessControl: support } };
        if (op === 'job.session') return { ok: true, data: { status, accessPolicy: policy,
          accessControl: support, nextAccessPolicy: null, pendingPermissions: pending,
          items: items.filter(item => item.seq > payload.since), round: 1 } };
        if (op === 'job.comment') {
          assert.equal(payload.text, prompt);
          status = 'running';
          add({ kind: 'user', text: payload.text });
          add({ kind: 'thinking', streamId: 'reasoning', delta: true, text: '检查页面结构和验证步骤。' });
          add({ kind: 'do', tool: 'Plan', callId: 'plan', arguments: { command: 'Plan the requested page' }, text: 'Plan the requested page' });
          pending = [request(cwd, 'verify-' + adapterId)];
          return { ok: true, data: { ok: true } };
        }
        if (op === 'job.permission') {
          assert.equal(payload.requestId, 'verify-' + adapterId);
          assert.equal(payload.policyRevision, 1);
          assert.equal(payload.decision, 'once');
          assert.equal(pending.length, 1);
          pending = [];
          add({ kind: 'do', tool: 'write', toolKind: 'write', callId: 'write',
            arguments: { path: path.join(cwd, 'index.html') }, text: 'Write index.html' });
          add({ kind: 'out', callId: 'write', text: 'index.html written', isError: false });
          return { ok: true, data: { ok: true } };
        }
        if (op === 'job.stop') { status = 'stopped'; return { ok: true, data: { ok: true } }; }
        throw Error('Unexpected fixture RPC: ' + op);
      } },
    });
    const session = await adapter.resumeSession({ native: { runner: { openOptions: {
      ref: 'conversation-' + adapterId, resumePath: 'fixture-run', cwd,
    } } } });
    sessions.push(session);
    const handle = getRunnerSessionDetails(session).handle;
    handle.attachedWindow = win;
    handles.set(handle.ref, handle);
    handle.on((event, snapshot) => {
      if (finishing && event.kind === 'settled') terminal.push(snapshot);
      publish(handle.ref, event, snapshot);
    });
    await until(() => handle.snapshot().accessControl?.supported, 'Runner access capability');
    return { handle, session, cwd, calls, terminal, finish() {
      fs.writeFileSync(path.join(cwd, 'index.html'), '<!doctype html><title>Completed page</title><main>Completed page</main>');
      const pixels = Buffer.alloc(480 * 240 * 4, 180);
      for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255;
      const screenshot = nativeImage.createFromBitmap(pixels, { width: 480, height: 240 }).toPNG();
      for (const name of ['verify-shot1.png', 'verify-shot2.png']) fs.writeFileSync(path.join(cwd, name), screenshot);
      add({ kind: 'thinking', streamId: 'reasoning', text: '', done: true });
      add({ kind: 'text', streamId: 'answer', text: '已完成 [index.html](index.html)。验证图片：[verify-shot1.png](verify-shot1.png)、[verify-shot2.png](verify-shot2.png)。', done: true });
      // A terminal receipt must settle a Plan tool even when no "out" arrived.
      finishing = true; status = 'done';
    } };
  }
  app.disableHardwareAcceleration();
  app.setPath('userData', path.join(root, 'profile'));
  app.setPath('temp', root);
  app.whenReady().then(async () => {
    fs.mkdirSync(out, { recursive: true });
    win = new BrowserWindow({ show: false, width: 1050, height: 800, webPreferences: {
      preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, offscreen: true,
    } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
      (_request, callback) => callback({ cancel: true }));
    win.webContents.on('console-message', event => {
      if (event.level === 'error') report.errors.push(event.message);
    });
    require('../main/file-type-icons.cjs').install({ app, ipcMain });
    ipcMain.handle('pi-session-open', (_event, options) => {
      const handle = handles.get(options.chatId);
      assert.ok(handle, 'Only explicitly registered fixture sessions can open');
      return { ok: true, ref: handle.ref, sessionId: handle.sessionId, adapterId: handle.adapterId,
        displayName: handle.displayName, cwd: handle.cwd, accessControl: support,
        model: { label: 'Isolated fixture' }, snapshot: handle.snapshot() };
    });
    ipcMain.handle('pi-session-snapshot', (_event, ref) => ({ ok: true, snapshot: handles.get(ref).snapshot() }));
    ipcMain.handle('pi-session-answer-ui', require('../main/access-control/ipc').answerHandler({ get: ref => handles.get(ref) }));
    ipcMain.handle('pi-session-outputs', (_event, ref) => {
      const handle = handles.get(ref);
      if (!handle.cwd) return { ok: true, artifacts: [] };
      const { got, delivery, items } = artifacts.snapshot(handle);
      return { ok: true, files: got.files, delivery,
        deliverables: delivery.items, artifacts: artifacts.decorate(ref, { items }) };
    });
    ipcMain.handle('pi-session-artifact-action', async (event, ref, artifactId, action) => {
      assert.equal(event.sender, win.webContents, 'Only the isolated conversation may request its artifacts');
      const handle = handles.get(ref);
      assert.ok(handle?.cwd, 'Artifact access requires a registered fixture workspace');
      assert.ok(['image', 'image-full', 'preview', 'location', 'status', 'stop', 'read'].includes(action),
        'This fixture cannot invoke external file or clipboard actions');
      const result = await artifacts.action(handle, ref, artifactId, action, { nativeImage });
      artifactActions.push({ ref, artifactId, action, ok: result.ok });
      return result;
    });
    for (const [channel, value] of Object.entries({
      'pi-session-history': { ok: true, chats: [] }, 'pi-session-release': { ok: true },
      'pi-session-runtime-models': { ok: true, items: [] },
      'pi-session-runtimes': { ok: true, runtimes: [] },
      'access-preferences-get': { ok: true, mode: 'standard', revision: 0 },
      // Packaging and native preview are covered by their own integration fixtures.
      'conversation-delivery-inspect': { ok: false, reason: 'Not exercised by this renderer fixture' },
      'work-preview-show': { ok: true }, 'work-preview-hide': { ok: true },
      'work-preview-destroy': { ok: true }, 'work-preview-reset-embedded': { ok: true },
    })) ipcMain.handle(channel, () => value);
    const source = path.join(client, 'e2e/fixtures/workbench-annotations.html'), scripts = [];
    const html = fs.readFileSync(source, 'utf8').replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_, attrs, body) => {
      const src = attrs.match(/src=["']([^"']+)/);
      if (src?.[1].endsWith('chat-message-renderer.js')) {
        scripts.push(read('components/panels/library-file-icons.js'),
          read('components/panels/chat-deliveries.js'), read('components/panels/library-transfer.js'));
      }
      scripts.push(src ? fs.readFileSync(path.resolve(path.dirname(source), src[1]), 'utf8') : body);
      return '';
    });
    const document = path.join(root, 'chat.html');
    fs.writeFileSync(document, html.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/gi, '')
      .replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '">'));
    await win.loadFile(document);
    for (const file of ['theme/variables.css', 'components/panels/work-composer.css',
      'components/panels/panels-chat.css', 'components/panels/chat-collaboration.css',
      'components/panels/conversation-attachments.css', 'components/panels/access-controls.css',
      'components/panels/agent-brand.css', 'components/panels/chat-deliveries.css']) {
      await win.webContents.insertCSS(css(path.join(client, file)));
    }
    for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
    for (const file of ['core/i18n-dom.js', 'core/i18n.js', 'components/panels/agent-brand.js',
      'components/panels/access-controls.js', 'components/panels/compose-candidate-navigation.js',
      'components/panels/chat-plugin-mention-model.js', 'components/panels/chat-plugin-mention.js'])
      await js(read(file) + '\nvoid 0;');
    for (const script of scripts) await js(script + '\nvoid 0;');
    await js(`window.assertFixture=(condition,message)=>{if(!condition)throw Error(message)};
      SoduWorkAPI.taskStorageKey=()=> 'isolated-conversation';
      SoduWorkI18n.setLocale('zh-CN');void 0;`);
    const deletedMedia = await js(`(()=>{
      const files=['image','video'].map((kind,index)=>({artifactId:'deleted-'+kind,
        kind,name:index?'clip.mp4':'image.png',primary:true,deleted:true,changedInTurn:true}));
      const html=ChatOutputLinks.decorate('<div class="nmsg ai" data-delivery-final="true" data-delivery-current="true">已移除旧预览。</div>',
        files,'deleted-fixture',{status:'idle',execution:{},messages:[],tools:[]});
      const doc=new DOMParser().parseFromString(html,'text/html');
      return doc.querySelectorAll('.noutput-image,.noutput-video').length;
    })()`);
    assert.equal(deletedMedia, 0, 'Deleted primary media must not reappear through automatic current-turn placement');
    report.cases.push('Deleted current-turn primary image/video never become inline media');

    // A Pi-shaped control exercises the same public permission card contract.
    const piData = { status: 'waiting-user', messages: [], tools: [], adapterId: 'pi', displayName: 'Pi',
      accessControl: support, accessPolicy: rules.create('standard', root),
      pendingPermissions: [request(root, 'pi-control')] };
    piData.pendingUi = piData.pendingPermissions[0];
    handles.set('pi-control', { ref: 'pi-control', sessionId: 'pi-control', adapterId: 'pi',
      displayName: 'Pi', attachedWindow: win, snapshot: () => structuredClone(piData) });
    await js(`NativeChat.enter('','pi-control',{adapterId:'pi'});`);
    await until('Boolean(document.querySelector(".access-request")?.checkVisibility())', 'Pi permission control');
    const permissionShape = await js(`[...document.querySelectorAll('.access-request [data-ui-value]')].map(el=>({choice:el.dataset.uiValue,label:el.textContent}))`);
    // The shared policy exposes explicit full-access escalation, not an implicit
    // session grant. Verify all bases keep the current common permission UI.
    assert.deepEqual(permissionShape.map(row => row.choice), ['deny', 'once', 'full']);

    for (const adapterId of ['opencode', 'harness2']) {
      const fixture = await runner(adapterId), { handle, session } = fixture;
      activeFixture = fixture;
      await js(`NativeChat.enter('',${JSON.stringify(handle.ref)},{adapterId:${JSON.stringify(adapterId)}});`);
      await until(`NativeChat.sessionInfo().ref===${JSON.stringify(handle.ref)}`, 'open ' + adapterId);
      const turn = session.send({ text: prompt });
      await until('Boolean(document.querySelector(".access-request")?.checkVisibility())', 'permission ' + adapterId);
      assert.deepEqual(await js(`[...document.querySelectorAll('.access-request [data-ui-value]')].map(el=>({choice:el.dataset.uiValue,label:el.textContent}))`), permissionShape);
      assert.equal(await js('document.querySelectorAll(".access-request").length'), 1);
      assert.equal(await js('document.querySelectorAll("#nchatList .access-request").length'), 0);
      await click('.access-request [data-ui-value=once]');
      await until('!document.querySelector(".access-request")?.checkVisibility()', 'approval settled');
      assert.equal(fixture.calls.filter(row => row.op === 'job.permission').length, 1);
      assert.equal(fixture.calls.find(row => row.op === 'job.permission').payload.decision, 'once');
      fixture.finish();
      await turn.completion;
      await until(() => fixture.terminal.length > 0, 'terminal snapshot');
      assert.ok(fixture.terminal[0].tools.every(tool => tool.state !== 'running'),
        'The first completed snapshot must settle all process tools');
      assert.ok(fixture.terminal[0].messages.filter(row => row.role === 'assistant')
        .every(row => row.done && row.blocks.every(block => block.done === true)),
      'Completed Runner blocks must have the same completion contract as Pi');
      assert.equal(fixture.calls.filter(row => row.op === 'job.comment').length, 1,
        'Approval and completion must not resubmit the explicit user request');
      await until('Boolean(document.querySelector(".ndelivery"))', 'HTML delivery card');
      assert.equal(await js('document.querySelectorAll(".ndelivery").length'), 1);
      assert.equal(await js('document.querySelectorAll(".nthink.open,.ntool-batch.open,.ntool.running").length'), 0,
        'Completed reasoning and process groups must be folded');
      const card = await js('document.querySelector(".ndelivery").textContent');
      assert.match(card, /index\.html/);
      assert.doesNotMatch(card, /verify-shot/);
      const listed = artifacts.decorate(handle.ref, artifacts.snapshot(handle));
      assert.equal(listed.find(file => file.name === 'index.html').primary, true);
      for (const name of ['verify-shot1.png', 'verify-shot2.png']) {
        assert.equal(listed.find(file => file.name === name).processEvidence, true);
        assert.equal(listed.find(file => file.name === name).primary, false);
        assert.equal(await js(`[...document.querySelectorAll('#nchatList .ntext [data-open-app]')]
          .some(el=>el.textContent===${JSON.stringify(name)}&&el.checkVisibility())`), true,
        'Verification evidence must remain an addressable link');
      }
      await until(`(()=>{const images=[...document.querySelectorAll('#nchatList .noutput-image img')];
        return images.length===2&&images.every(image=>image.complete&&image.naturalWidth===480&&image.naturalHeight===240);})()`,
      'trusted inline screenshot pixels');
      assert.equal(await js('document.querySelectorAll("#nchatList .noutput-image").length'), 2,
        'Each referenced verification screenshot renders once above the delivery');
      assert.equal(await js('document.querySelectorAll("#nchatList .noutput-video,#nchatList .ntext img,.ndelivery-preview,.ndelivery-preview-only").length'), 0,
        'Evidence must not create duplicate preview cards or untrusted prose images');
      assert.equal(await js(`(()=>{const delivery=document.querySelector('.ndelivery');
        return [...document.querySelectorAll('#nchatList .noutput-image')].every(image=>
          image.parentElement===delivery.parentElement&&Boolean(image.compareDocumentPosition(delivery)&Node.DOCUMENT_POSITION_FOLLOWING)&&
          image.dataset.imageState==='ready'&&!image.querySelector('.noutput-image-caption')?.checkVisibility());})()`), true,
      'Loaded screenshot evidence stays above its delivery without the filename/footer strip');
      for (const name of ['verify-shot1.png', 'verify-shot2.png']) {
        const file = listed.find(item => item.name === name);
        assert.equal(await js(`document.querySelectorAll('[data-output-image="${file.artifactId}"]').length`), 1);
        assert.ok(artifactActions.some(row => row.ref === handle.ref && row.artifactId === file.artifactId && row.action === 'image' && row.ok),
          'Inline evidence must load through the real session-scoped artifact action');
      }
      for (const width of [1050, 390]) {
        if (width === 390 && await js('Boolean(document.querySelector("[data-wb-close]")?.checkVisibility())')) {
          await click('[data-wb-close]');
        }
        win.setSize(width, 800); await delay(100);
        assert.equal(await js('document.documentElement.scrollWidth>innerWidth'), false);
        assert.equal(await js(`(()=>{
          const card=document.querySelector('.ndelivery'),r=card.getBoundingClientRect();
          return card.checkVisibility()&&r.width>0&&r.left>=0&&r.right<=innerWidth;
        })()`), true, 'Delivery card must remain visible in the conversation at ' + width + 'px');
        fs.writeFileSync(path.join(out, adapterId + '-' + width + '.png'),
          (await win.webContents.capturePage()).toPNG());
      }
      report.cases.push(adapterId + ': Pi permission controls, one approval/submission, settled process blocks, HTML primary delivery with two trusted inline screenshots above it and no caption footer');
      await session.dispose();
    }
    assert.deepEqual(await js('errors'), []);
    assert.deepEqual(report.errors, []);
    report.ok = true;
  }).catch(async error => {
    report.error = error.stack || String(error);
    if (activeFixture) {
      report.fixtureSnapshot = activeFixture.handle.snapshot();
      report.fixtureArtifacts = artifacts.decorate(activeFixture.handle.ref, artifacts.snapshot(activeFixture.handle));
      try { report.fixtureDom = await js(`({
        messages:[...document.querySelectorAll('.nmsg.ai')].map(el=>({final:el.dataset.deliveryFinal,current:el.dataset.deliveryCurrent,text:el.textContent})),
        links:[...document.querySelectorAll('#nchatList a,#nchatList [data-open-app]')].map(el=>({text:el.textContent,href:el.getAttribute('href'),artifact:el.dataset.openApp})),
        notices,errors})`); } catch (_) {}
    }
    try { fs.writeFileSync(path.join(out, 'failure.png'), (await win.webContents.capturePage()).toPNG()); } catch (_) {}
  }).finally(async () => {
    for (const session of sessions) await session.dispose();
    artifacts.closeAll();
    if (win && !win.isDestroyed()) win.destroy();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    app.exit(report.ok ? 0 : 1);
  });
}
