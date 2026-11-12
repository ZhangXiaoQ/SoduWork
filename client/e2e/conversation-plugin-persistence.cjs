'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], { env, windowsHide: true, stdio: 'inherit', timeout: 90000 });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
const client = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-e2e-'));
const out = path.resolve(client, '../outputs/conversation-plugin-persistence'); fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(root, 'profile')); app.on('window-all-closed', () => {});
app.disableHardwareAcceleration();
const read = file => fs.readFileSync(path.join(client, file), 'utf8');
const report = { ok: false, cases: [], boundary: 'Electron + production preload, NativeChat, slash picker, send IPC, Pi SDK and HTTP/tool execution. Model endpoint and plugin grants are local fixtures; no live Tencent Meeting service or user profile.' };
const stage = name => { report.stage = name; console.log(name); };
const requests = [], results = [], resolutions = [], executions = [], grants = new Set(), errors = [];
let win, fixture, handle, off, ready = false, restoreLoader;
const js = code => win.webContents.executeJavaScript(code, true);
async function until(check, label) {
  const end = Date.now() + 12000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw Error('Timed out: ' + label);
}
function publish(_windows, _session, event, snapshot) {
  if (ready) win.webContents.send('pi-session-event', { ref: handle.ref, ...event, snapshot: snapshot || handle.uiSnapshot() });
}
async function click(selector) {
  const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded control');return{x,y};})()`);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
}
async function type(text) {
  await click('#nchatInput');
  await until(() => js("document.activeElement === document.querySelector('#nchatInput')"), 'native composer focus');
  await win.webContents.insertText(text);
}
async function send(text, count) {
  await type(text); await click('#nchatSend');
  await until(() => results.length === count, 'turn ' + count);
  assert.equal(results.at(-1).ok, true, results.at(-1).reason);
  await until(() => !handle.inFlight(), 'settled turn');
  await until(() => js(`(()=>{const text=document.querySelector('#nchatList')?.textContent||'';return text.includes(${JSON.stringify(text)})&&(text.match(/已查询到 2 场会议/g)||[]).length>=${count};})()`), 'rendered answer ' + count);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await js("document.querySelector('#nchatInput').value"), '');
  assert.equal(await js("document.querySelectorAll('.nplugin-chip').length"), 0);
}
async function reopen() {
  off?.(); handle?.close();
  handle = await fixture.open({ resolvePlugins: async ids => {
    const grant = String(resolutions.length + 1); grants.add(grant); resolutions.push(ids.slice());
    return { items: ids.map(pluginId => ({ pluginId, name: '会议查询 · 回归验证', context: 'Use plugin_probe.' })),
      grant: { servers: [], guide: 'PLUGIN-GRANT-' + grant, cleanup() { grants.delete(grant); } } };
  } });
  off = handle.on(event => publish(null, handle, event, handle.uiSnapshot()));
}
function installSend() {
  const source = read('main/pi-session/ipc.js');
  const code = source.slice(source.indexOf('  async function sendConversation('), source.indexOf("  ipcMain.handle('pi-session-send',"));
  const context = vm.createContext({ app, BrowserWindow, path, Promise, Date,
    _uiWindow: require('../main/pi-session/ui-window').create(),
    _cloudHandoff: { guard: () => false },
    require: require('node:module').createRequire(path.join(client, 'main/pi-session/ipc.js')),
    updateWorkloads: { guard: () => ({ ok: true }) }, session: { get: ref => ref === handle.ref ? handle : null },
    sendIdentityOf: async () => ({}), identityOf: async () => ({}), memories: { assertOwner() {} },
    pluginDebug: { guard: () => null }, workDir: () => root,
    attachments: require('../main/pi-session/attachments'), _publish: publish, _scheduleRelease() {},
  });
  vm.runInContext(source.slice(source.indexOf('function _contextSnapshot('), source.indexOf('function _send(')) + '\n' + code, context);
  ipcMain.handle('pi-session-send', (_event, ref, text, files, options) => {
    requests.push({ ref, text, options });
    return context.sendConversation(ref, text, files, options, completion => completion.then(result => results.push(result)));
  });
}
app.whenReady().then(async () => {
  stage('Prepare local runtime');
  fixture = await require('./fixtures/resumed-pi.cjs').create(root);
  const loader = require('../main/pi-session/sdk-loader'), load = loader.load;
  restoreLoader = () => { loader.load = load; };
  loader.load = async (...loadArgs) => {
    const sdk = await load(...loadArgs);
    return { ...sdk, createAgentSession: args => sdk.createAgentSession({ ...args, tools: ['plugin_probe'], customTools: [{
      name: 'plugin_probe', label: 'Meeting fixture', description: 'Read isolated meetings using the current grant',
      parameters: { type: 'object', properties: { grant: { type: 'string' } }, required: ['grant'] },
      async execute(_id, args) {
        assert.ok(grants.has(args.grant), 'plugin requires a fresh live grant'); executions.push(args.grant);
        return { content: [{ type: 'text', text: 'Fixture meetings: 2' }], details: {} };
      },
    }] }) };
  };
  fixture.reply(body => {
    const user = body.messages.findLast(message => message.role === 'user');
    const grant = /PLUGIN-GRANT-(\d+)/.exec(JSON.stringify(user?.content))?.[1];
    if (grant && body.messages.at(-1).role !== 'tool') return { tool: 'plugin_probe', args: { grant } };
    return { text: '已查询到 2 场会议（本地验证数据）。' };
  });
  await reopen();
  stage('Load renderer');
  win = new BrowserWindow({ show: true, title: 'SoduWork 插件连续对话验证', width: 1100, height: 850, webPreferences: {
    preload: path.join(client, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false,
    backgroundThrottling: false } });
  win.webContents.on('render-process-gone', (_event, details) => console.error('Renderer exited', details));
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  installSend();
  ipcMain.handle('pi-session-open', () => ({ ok: true, ref: handle.ref, sessionId: handle.sessionId, adapterId: 'pi',
    cwd: fixture.cwd, model: { label: 'Local regression model' }, snapshot: handle.uiSnapshot() }));
  ipcMain.handle('pi-session-snapshot', () => ({ ok: true, snapshot: handle.uiSnapshot() }));
  for (const [channel, value] of Object.entries({ 'pi-session-history': { ok: true, chats: [] }, 'pi-session-outputs': { ok: true, items: [] },
    'pi-session-release': { ok: true }, 'pi-session-runtime-models': { ok: true, items: [] },
    'work-preview-hide': { ok: true }, 'work-preview-destroy': { ok: true },
    'work-preview-reset-embedded': { ok: true } })) ipcMain.handle(channel, () => value);
  const source = path.join(__dirname, 'fixtures/workbench-annotations.html'), scripts = [];
  const html = fs.readFileSync(source, 'utf8').replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_, attrs, body) => {
    const src = attrs.match(/src=["']([^"']+)/); scripts.push(src ? fs.readFileSync(path.resolve(path.dirname(source), src[1]), 'utf8') : body); return '';
  });
  const page = path.join(out, 'native-chat.html');
  fs.writeFileSync(page, html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="' + pathToFileURL(path.dirname(source) + path.sep).href + '">')
    .replace('</style>', '</style><link rel="stylesheet" href="../../components/panels/chat-plugin-mention.css">'));
  await win.loadFile(page);
  stage('Load production components');
  for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
  for (const file of ['core/i18n-dom.js', 'core/i18n.js', 'components/panels/compose-candidate-navigation.js',
    'components/panels/chat-plugin-mention-model.js', 'components/panels/chat-plugin-mention.js']) await js(read(file) + '\nvoid 0;');
  for (const script of scripts) await js(script + '\nvoid 0;');
  await js(`SoduWorkAPI.pluginCatalog=async()=>({items:[{pluginId:'meeting-fixture',key:'meeting-fixture',name:'会议查询 · 回归验证',personal:true,enabled:true,
    inputs:[{key:'format',label:'Format',type:'text',default:'qa-format-marker'}]}]});void 0;`);
  ready = true;
  stage('Open conversation');
  await js(`SoduWorkI18n.setLocale('zh-CN');NativeChat.enter('',${JSON.stringify(handle.sessionId)},{adapterId:'pi'});`);
  await until(() => js("document.querySelector('#nchatList')?.textContent.includes('Previous report is preserved.')"), 'history');
  await type('/会议');
  await until(() => js("Boolean(document.querySelector('.nplugin-menu .nplugin-option:not(.is-action)'))"), 'slash picker');
  await click('.nplugin-menu .nplugin-option:not(.is-action)');
  await until(() => js("document.querySelectorAll('.nplugin-chip').length === 1"), 'selected chip');
  fs.writeFileSync(path.join(out, 'before-send.png'), (await win.webContents.capturePage()).toPNG());
  await send('查询最近的会议', 1);
  assert.deepEqual(resolutions, [['meeting-fixture']]); assert.deepEqual(executions, ['1']);
  assert.equal(requests[0].text, '查询最近的会议');
  assert.equal(requests[0].options.plugins[0].inputValues.format, 'qa-format-marker');
  assert.ok(fixture.requests.some(body => JSON.stringify(body.messages).includes('qa-format-marker')),
    'the actual model request receives structured parameters');
  assert.doesNotMatch(JSON.stringify(handle.uiSnapshot().messages), /qa-format-marker|本轮参数/,
    'visible history never includes private parameter data');
  report.cases.push('Slash selection sends its plugin, actually calls the tool, and clears the composer chip.');
  await send('再查询一次会议', 2);
  assert.equal(requests[1].options.plugins.length, 0, 'follow-up sends no picker selection');
  assert.deepEqual(resolutions, [['meeting-fixture'], ['meeting-fixture']]); assert.deepEqual(executions, ['1', '2']);
  report.cases.push('Follow-up without slash selection executes the inherited plugin with a fresh grant.');
  fs.writeFileSync(path.join(out, 'follow-up.png'), (await win.webContents.capturePage()).toPNG());
  await reopen();
  await js(`NativeChat.reset();NativeChat.enter('',${JSON.stringify(handle.sessionId)},{adapterId:'pi'});`);
  await until(() => js("document.querySelector('#nchatList')?.textContent.includes('已查询到 2 场会议')"), 'reopened history');
  await until(() => js('NativeChat.hasSession()'), 'reopened session ready');
  assert.equal(await js("document.querySelectorAll('.nplugin-chip').length"), 0, 'reopening must not repopulate composer');
  await send('重新打开后再次查询', 3);
  assert.deepEqual(executions, ['1', '2', '3']); assert.equal(grants.size, 0);
  report.cases.push('Reopened archive retains plugin use, keeps the composer empty and releases each turn grant.');
  const draftResult = await js(`(async()=>{
    const host=document.createElement('div'),input=document.createElement('textarea');host.append(input);document.body.append(host);
    const previous=window.PluginInputSheet;let forms=0;
    window.PluginInputSheet={open(o){forms++;o.onApply('',{roomId:'room-123'});return{};},close(){}};
    const picker=ChatPluginMention.create({input,host,catalog:async()=>({items:[
      {pluginId:'required-input',name:'Required input',personal:true,enabled:true,inputs:[{key:'roomId',label:'Room ID',type:'text',required:true}]},
      {pluginId:'later-draft',name:'Later draft',personal:true,enabled:true}
    ]})});
    try {
      await picker.select('required-input');const first=await picker.resolve('test','','query');const saved=picker.draft();
      await picker.select('later-draft');picker.consume(first.items);const remaining=picker.selected().map(p=>p.pluginId);
      picker.clear();picker.restore(saved);await picker.resolve('test','','query');const afterRetry=forms;
      picker.consume(saved);await picker.select('required-input');await picker.resolve('test','','new query');
      return{remaining,afterRetry,afterNew:forms,savedValue:saved[0].inputValues.roomId};
    }finally{picker.destroy();host.remove();window.PluginInputSheet=previous;}
  })()`);
  assert.deepEqual(draftResult, { remaining: ['later-draft'], afterRetry: 1, afterNew: 2, savedValue: 'room-123' });
  report.cases.push('Picker consumption preserves later picks, restores required inputs on retry, and does not reuse old parameters on a new selection.');
  assert.deepEqual(await js('window.errors'), []); assert.deepEqual(errors, []);
  report.ok = true;
}).catch(async error => {
  report.error = error.stack || String(error);
  if (win && !win.isDestroyed()) report.ui = await js('({text:document.body.innerText,menu:document.querySelector(".nplugin-menu")?.outerHTML,input:document.querySelector("#nchatInput")?.value,selection:document.querySelector("#nchatInput")?.selectionStart,focus:document.activeElement?.id,errors:window.errors})').catch(() => null);
}).finally(async () => {
  ready = false; off?.(); await fixture?.close(); restoreLoader?.(); win?.destroy();
  report.toolCalls = executions.length;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, cases: report.cases, error: report.error, report: path.join(out, 'report.json') }));
  app.exit(report.ok ? 0 : 1);
});
