'use strict';

// Production home composer -> requirement action -> NativeChat, in desk.html
// script order. Only public service APIs use isolated, controllable fixtures.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawnSync(electron,
    [__filename, ...process.argv.slice(2), '--disable-gpu'],
    { env, windowsHide: true, stdio: 'inherit', timeout: 180000 });
  if (child.error) console.error(child.error.message);
  process.exit(child.status ?? 1);
}
const { app, BrowserWindow } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
const client = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-requirement-model-'));
const out = path.resolve(process.argv.slice(2).find(value => !value.startsWith('--')) ||
  path.join(client, '../outputs/requirement-draft-model-handoff'));
const onlyCase = process.argv.find(value => value.startsWith('--case='))?.slice('--case='.length) || '';
const workCardsSource = process.argv.find(value => value.startsWith('--work-cards-source='))?.slice('--work-cards-source='.length) || '';
const workStoreSource = process.argv.find(value => value.startsWith('--work-store-source='))?.slice('--work-store-source='.length) || '';
const composerControlsSource = process.argv.find(value => value.startsWith('--composer-controls-source='))?.slice('--composer-controls-source='.length) || '';
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(temp, 'profile')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
let win, page;
const report = { ok: false, cases: [], phases: [], network: [], navigationTimings: [],
  onlyCase, workCardsSource, workStoreSource, composerControlsSource,
  boundary: 'Actual Electron and production Compose, ModelPicker, Runtime, work card and NativeChat modules; controlled public APIs, no model calls or real user data.' };
const js = code => win.webContents.executeJavaScript(code, true)
  .catch(error => { throw Error(error.message + '\nScript: ' + code); });
async function until(code, label = code) {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    if (await js(code)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Timed out: ' + label);
}
async function click(selector) {
  await until(`(() => {const node=document.querySelector(${JSON.stringify(selector)});
    if(!node||node.disabled)return false;node.scrollIntoView({block:'nearest'});const r=node.getBoundingClientRect();
    return r.width>0&&r.height>0&&node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`,
  'clickable ' + selector);
  const point = await js(`(() => {const node=document.querySelector(${JSON.stringify(selector)});
    if(!node||node.disabled)throw Error('Missing or disabled control: '+${JSON.stringify(selector)});
    node.scrollIntoView({block:'nearest'});const r=node.getBoundingClientRect();
    const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
    if(!node.contains(document.elementFromPoint(x,y)))throw Error('Occluded control: '+${JSON.stringify(selector)});
    return{x,y};})()`);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
async function type(selector, value) {
  await js(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};
    node.focus();node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function phase(name) {
  const value = await js(`({home:document.querySelector('#cpModelName')?.textContent,
    model:document.querySelector('#nchatModel .nmodel-button span')?.textContent,
    agent:document.querySelector('#nchatRuntimeName')?.textContent,
    form:{title:document.querySelector('#wesTaskDraft #cpTitle')?.value,note:document.querySelector('#wesTaskDraft #cpNote')?.value,
      checks:[...document.querySelectorAll('#wesTaskDraft #cpCheck [data-ck]')].map(node=>node.value)},
    session:NativeChat.sessionInfo(),calls:structuredClone(calls),notices:notices.slice(),errors:errors.slice()})`);
  report.phases.push({ name, ...value });
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
  return value;
}
async function runCase(name, action) {
  if (onlyCase && !name.includes(onlyCase)) return;
  try { await action(); assert.deepEqual(await js('errors'), []); report.cases.push({ name, ok: true }); }
  catch (error) { report.cases.push({ name, ok: false, error: error.stack,
    ui: await js('document.body.innerText').catch(() => ''), calls: await js('calls').catch(() => null),
    queue: await js('document.querySelector("#nchatQueue")?.outerHTML').catch(() => ''),
    collaboration: await js('ChatCollaborationStore.get(NativeChat.sessionInfo().sessionId)').catch(() => null) }); }
}
function fixture() {
  window.errors = []; window.notices = [];
  addEventListener('error', event => errors.push(event.message));
  addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
  window.petSay = text => notices.push(text);
  window.calls = { parse: [], creates: [], opens: [], sends: [], reserve: [], saves: [], selections: [], reads: [], modelSelections: [], binds: [] };
  window.tasks = []; window.save = () => {};
  window.successfulRequirements = false;
  window.delayTaskReads = false; window.pendingTaskReads = [];
  window.Store = { persistTask: async id => { calls.creates.push(id); return successfulRequirements; } };
  window.fixtureOwner = 'fixture-owner'; window.failSelectionSave = false;
  window.delayWorkCards = false; window.pendingWorkCards = null;
  window.workCardsOverride = null;
  window.failWorkCards = false;
  window.rejectWorkCards = false;
  window.delaySelectionSave = false; window.pendingSelectionSave = null;
  const stored = JSON.parse(localStorage.getItem('fixtureWorkArchives') || '{}');
  window.fixtureArchives = stored;
  const archiveKey = id => fixtureOwner + ':' + id;
  const persist = () => localStorage.setItem('fixtureWorkArchives', JSON.stringify(stored));
  const response = archive => ({ ok: true, cards: structuredClone(archive?.cards || []), workOnly: !!archive && !archive.started,
    draftSelection: !archive?.started ? structuredClone(archive?.draftSelection || null) : null,
    draftSelectionRevision: !archive?.started ? archive?.draftSelectionRevision || 0 : 0 });
  window.models = [{ name: 'fixture-default', label: '默认模型' },
    { name: 'fixture-chosen', label: '首页选中的模型' }, { name: 'fixture-history', label: '历史会话模型' }];
  window.catalog = { usable: models, defaultModel: 'fixture-default', defaultModels: { pi: 'fixture-default', qwen: 'fixture-default' } };
  window.runtimeRows = [{ id: 'pi', displayName: 'Pi', modelMode: 'managed', goalMode: 'native', group: 'recommended', order: 10 },
    { id: 'qwen', displayName: 'Qwen Code', modelMode: 'managed', goalMode: 'native', group: 'recommended', order: 20 }];
  window.pendingParse = null; window.pendingCatalog = null; window.slowCatalog = false;
  const catalogResolvers = [];
  let sessionSequence = 0;
  window.fixtureTranscript = [];
  window.fixtureSessions = {};
  window.fixtureListeners = new Set();
  const snap = () => ({ status: 'idle', messages: structuredClone(fixtureTranscript), tools: [], usage: null });
  const model = name => ({ id: name || 'fixture-default', label: models.find(row => row.name === name)?.label || '默认模型' });
  window.SoduWorkAPI = {
    online: true, taskStorageKey: () => fixtureOwner, pluginCatalog: async () => ({ items: [] }),
    getTask: async id => { const task = tasks.find(row => row.id === id); if (!task) throw Error('隔离需求不存在');
      const result = structuredClone(task);
      if (delayTaskReads) return new Promise(resolve => pendingTaskReads.push(() => resolve(result)));
      return result; },
    getTasksSnapshot: async () => ({ online: true, stale: false, items: structuredClone(tasks) }),
    myModels: async () => slowCatalog ? new Promise(resolve => {
      catalogResolvers.push(resolve); pendingCatalog = () => {
        slowCatalog = false; catalogResolvers.splice(0).forEach(done => done(structuredClone(catalog)));
      };
    }) : structuredClone(catalog),
    listTeammates: async () => ({ mates: [] }), getProjects: async () => [],
    parseTaskText: async (text, selectedModel, attachments, options) => {
      calls.parse.push({ text, model: selectedModel, attachments: structuredClone(attachments || []),
        options: structuredClone(options || {}) });
      return new Promise(resolve => { pendingParse = outcome => resolve(outcome === 'failure'
        ? { _parseError: '无法连接模型服务，请核对原文后继续。' }
        : { title: '制作网页需求', note: text, checklist: ['可以打开网页', '交互按钮可以使用', '手机尺寸可以正常浏览'] }); });
    }
  };
  window.soduWorkAPI = { accessPreferences: { get: async () => ({ mode: 'standard' }), onChange: () => () => {} },
    workPreview: { hide: async () => ({ ok: true }), destroy: async () => ({ ok: true }) },
    conversationSession: {
      runtimes: async () => ({ ok: true, runtimes: runtimeRows, availableRuntimes: runtimeRows }), probe: async () => ({ ok: true }),
      cloud: { targets: async adapterId => ({ ok: true, targets: [{ id: 'fixture-cloud', agentId: adapterId }] }) },
      capabilities: async () => ({ ok: true, items: [], skills: [{name:'fixture-skill',installed:true,selectable:true}] }), workdir: async () => ({ ok: true, dir: '/isolated-fixture' }),
      setMode: async () => ({ mode: 'full' }), history: async () => ({ ok: true, chats: [] }),
      onEvent: handler => { fixtureListeners.add(handler); return () => fixtureListeners.delete(handler); },
      release: async () => ({ ok: true }), outputs: async () => ({ ok: true, items: [] }),
      reserveWorkConversation: async options => {
        calls.reserve.push(structuredClone(options)); const sessionId = 'draft-' + (++sessionSequence);
        stored[archiveKey(sessionId)] = { cards: [], draftSelection: options.draftSelection || null,
          draftSelectionRevision: options.draftSelection ? 1 : 0 }; persist();
        return { ...response(stored[archiveKey(sessionId)]), sessionId, snapshot: { ...snap(), workOnly: true } };
      },
      saveWorkCard: async (sessionId, card) => {
        calls.saves.push({ sessionId, card: structuredClone(card) });
        const archive = stored[archiveKey(sessionId)];
        if (!archive) return { ok: false, reason: '会话不属于当前账号' };
        const previous = archive.cards.find(row => row.id === card.id);
        const saved = { ...structuredClone(card), revision: (previous?.revision || 0) + 1 };
        archive.cards = archive.cards.filter(row => row.id !== card.id).concat(saved); persist();
        return { ok: true, card: saved };
      },
      workCards: async sessionId => {
        if (rejectWorkCards) throw Error('Fixture IPC transport rejected');
        if (failWorkCards) return { ok: false, reason: '模拟档案读取失败' };
        if (workCardsOverride?.sessionId === sessionId) return structuredClone(workCardsOverride.result);
        calls.reads.push({ owner: fixtureOwner, sessionId }); const result = response(stored[archiveKey(sessionId)]);
        if (delayWorkCards) { delayWorkCards = false; return new Promise(resolve => { pendingWorkCards = () => resolve(result); }); }
        return result;
      },
      saveWorkDraftSelection: async (sessionId, value) => {
        calls.selections.push({ sessionId, ...structuredClone(value) });
        const requestedOwner = fixtureOwner;
        if (delaySelectionSave) {
          delaySelectionSave = false;
          await new Promise(resolve => { pendingSelectionSave = resolve; });
        }
        if (requestedOwner !== fixtureOwner) return { ok: false, reason: '账号已切换' };
        if (failSelectionSave) return { ok: false, reason: '模拟选择保存失败' };
        const archive = stored[archiveKey(sessionId)];
        if (!archive) return { ok: false, reason: '会话不属于当前账号' };
        if (archive.started) return { ok: false, code: 'WORK_CONVERSATION_STARTED', reason: '会话已经在另一窗口开始执行' };
        if (value.revision !== archive.draftSelectionRevision) return { ok: false, code: 'STALE_DRAFT_SELECTION', reason: '选择已变化' };
        archive.draftSelection = structuredClone(value.selection); archive.draftSelectionRevision++; persist();
        return { ok: true, draftSelection: structuredClone(archive.draftSelection), draftSelectionRevision: archive.draftSelectionRevision };
      },
      runtimeModels: async () => ({ ok: true, models: models.map(row => ({ id: row.name, label: row.label })) }),
      selectModel: async (ref, name) => {
        const result = await window.fixtureModelBridge.selectModel(ref, name);
        calls.modelSelections.push({ ref, name, result }); return result;
      },
      open: async options => {
        calls.opens.push(structuredClone(options)); const historic = options.chatId === 'history-session';
        if (fixtureSessions[options.chatId]) return structuredClone(fixtureSessions[options.chatId]);
        if (historic && !stored[archiveKey(options.chatId)]) {
          stored[archiveKey(options.chatId)] = { cards: [], started: true }; persist();
        }
        const started = !historic && stored[archiveKey(options.chatId)]?.started;
        const selected = started ? 'fixture-default' : historic ? 'fixture-history' : options.modelName;
        const adapterId = started || historic ? 'pi' : options.adapterId || 'pi';
        const task = tasks.find(row => row.id === options.taskRef);
        if (options.requireTaskBinding && !task) return { ok: false, reason: '隔离会话无法绑定不存在的需求' };
        return { ok: true, ref: started ? 'started-ref' : historic ? 'history-ref' : 'draft-ref', sessionId: options.chatId || 'new-session',
          taskBindings: task ? [{ taskId: task.id, title: task.title }] : [],
          adapterId, displayName: runtimeRows.find(row => row.id === adapterId)?.displayName, model: model(selected),
          snapshot: { ...snap(), adapterId, modelSelection: { name: selected || '', model: model(selected) } } };
      },
      bindTask: async (ref, taskId, title) => {
        if (!ref || !tasks.some(row => row.id === taskId)) return { ok: false, reason: '隔离需求绑定参数无效' };
        calls.binds.push({ ref, taskId, title }); return { ok: true };
      },
      send: async (ref, text, attachments, options) => { calls.sends.push({ ref, text, attachments, options }); return { ok: true, accepted: true }; }
    }
  };
}
function buildPage() {
  const desk = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
  // Load the production HTML escape helper without starting the task store.
  const escapeSource = fs.readFileSync(path.join(client, 'core/store.js'), 'utf8').match(/^const esc=.*$/m)?.[0];
  assert.ok(escapeSource, 'production task-stream HTML escaping is available');
  const original = fs.readFileSync(path.join(__dirname, 'fixtures/workbench-annotations.html'), 'utf8');
  const required = new Set([...original.matchAll(/<script\b[^>]*src=["']([^"']+)["']/g)]
    .map(match => path.relative(client, path.resolve(__dirname, 'fixtures', match[1])).replace(/\\/g, '/')));
  for (const file of ['core/model-choice.js', 'core/plugin-icon.js', 'core/requirements.js', 'core/requirement-session-context.js',
    'components/panels/chat-collaboration.js', 'components/panels/chat-task-session.js', 'components/panels/agent-brand.js',
    'components/panels/panels-compose-runtime.js', 'components/panels/compose-execution.js', 'components/panels/panels-compose-model-picker.js',
    'components/panels/compose-candidate-navigation.js', 'components/panels/panels-compose-capabilities.js',
    'components/panels/chat-plugin-mention-model.js', 'components/panels/chat-plugin-mention.js',
    'components/panels/chat-message-plugins.js', 'components/panels/plugin-ui-host.js',
    'components/panels/task-priority.js', 'components/panels/panels-compose-submit.js',
    'components/requirements/requirement-fields.js', 'components/panels/panels-chat-chrome.js',
    'components/panels/work-automation-bindings.js', 'components/panels/work-automation-view.js',
    'components/panels/work-automation-card-state.js', 'components/panels/work-automation-sheet.js',
    'components/panels/compose-selection-position.js', 'components/panels/requirement-routing.js',
    'components/panels/panels-compose-draft.js', 'components/panels/work-entry-sheet.js',
    'components/panels/panels-chat-work-actions.js', 'components/panels/panels-compose-work-actions.js',
    'components/panels/chat-work-cards.js', 'components/panels/compose-surface.js',
    'components/panels/panels-compose.js', 'components/panels/panels-compose-skills.js', 'components/panels/chat-runtime-picker.js',
    'components/workspace/workspace-chat-list.js', 'components/panels/task-execution-stream.js']) required.add(file);
  const scripts = [...desk.matchAll(/<script\b[^>]*src=["']([^"']+)["']/g)].map(match => match[1]).filter(file => required.has(file));
  assert.equal(scripts.length, required.size);
  const styles = [...desk.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["']/g)].map(match => match[1]);
  const url = file => pathToFileURL(file === 'components/panels/chat-composer-controls.js' && composerControlsSource
    ? path.resolve(composerControlsSource) : file === 'components/panels/chat-work-cards.js' && workCardsSource
    ? path.resolve(workCardsSource) : path.join(client, file)).href;
  page = path.join(temp, 'fixture.html');
  fs.writeFileSync(page, '<!doctype html><html data-theme="azure"><head><meta charset="utf-8"><base href="' +
    pathToFileURL(client + path.sep).href + '">' + styles.map(file => '<link rel="stylesheet" href="' + url(file) + '">').join('') +
    '<style>body{margin:0;height:100vh}.compose-panel{inset:0!important;height:100vh!important;width:100vw!important}.cp-body{height:100%}#cpChat{height:100%}.nchat{height:100%}</style></head><body>' +
    '<script>' + escapeSource + '\n(' + fixture.toString() + ')();</script>' + scripts.map(file => '<script src="' + url(file) + '"></script>').join('') + '</body></html>');
}
async function selectRequirement() {
  await type('#cpInput', '/');
  await until("Boolean(document.querySelector('#cpTask .nplugin-option.is-action:not([disabled])'))", 'requirement action picker');
  await click('#cpTask .nplugin-option.is-action');
  await until("Boolean(document.querySelector('#cpTask .nplugin-chip.is-action'))", 'requirement action selected');
  await type('#cpInput', '制作一个可以打开的网页');
}
async function setup(options = {}) {
  await win.loadFile(page); await js("localStorage.removeItem('fixtureWorkArchives');Object.keys(fixtureArchives).forEach(key=>delete fixtureArchives[key]);ChatCollaborationStore.remove('draft-1');ChatCollaborationStore.remove('history-session');openComposePanel({newSession:true});void 0;");
  await until("ComposeModelPicker.value().modelName==='fixture-default'", 'initial home model');
  if (!options.defaults) {
    await click('#cpRuntime'); await click('[data-runtime="qwen"]');
    await until("ComposeRuntime.value()==='qwen' && ComposeRuntime.availability()?.ok", 'Qwen selection');
    await js('Promise.resolve(ComposeModelPicker.ready()).then(()=>true)');
    await click('#cpModelBtn'); await click('[data-model="fixture-chosen"]');
    await until("ComposeModelPicker.value().modelName==='fixture-chosen'", 'explicit model choice');
  }
  await selectRequirement();
}
function assertSelection(state, name) {
  assert.equal(state.model, '首页选中的模型', name + ': model selection survives the work card handoff');
  assert.equal(state.agent, 'Qwen Code', name + ': chosen Agent survives the work card handoff');
}
async function createWorkDraft(options) {
  await setup(options); await click('#cpGo'); await until('Boolean(pendingParse)', 'requirement parsing');
  await js("pendingParse('success');void 0;");
  await until("Boolean(document.querySelector('#wesTaskDraft #cpTitle'))", 'parsed form');
  await until("calls.saves.some(row=>row.card.state?.phase==='draft')", 'work card persisted');
  return js('NativeChat.sessionInfo().sessionId');
}
async function reloadPage() {
  if (!win.webContents.getURL() || win.webContents.getURL() === 'about:blank') {
    await win.loadFile(page); return;
  }
  const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  win.reload(); await loaded;
}
async function restoreFromReenrolledDevice(savedCard, selection, changedHub = false) {
  const storageRoot = fs.mkdtempSync(path.join(temp, 'card-owner-'));
  const isolatedApp = { getPath: () => storageRoot };
  const native = await import(pathToFileURL(path.join(client, 'node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js')).href);
  const sessions = require('../main/pi-session/session');
  const sourceFile = path.join(client, 'main/conversation/work-conversation-cards.js');
  let module = require(sourceFile);
  if (workStoreSource) {
    const Module = require('node:module'), copied = new Module(sourceFile, require.main);
    copied.filename = sourceFile; copied.paths = Module._nodeModulePaths(path.dirname(sourceFile));
    copied._compile(fs.readFileSync(path.resolve(workStoreSource), 'utf8'), sourceFile); module = copied.exports;
  }
  const identity = (clientId, hub = 'https://fixture.invalid') => {
    const now = Math.floor(Date.now() / 1000);
    return { hub, clientId, session: Buffer.from(JSON.stringify({ typ: 'device', uid: 'fixture-account', cid: clientId,
      iat: now - 10, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
  };
  const uiScope = value => 'soduwork_work_task_ops_v1@' + [value.hub, value.clientId, 'fixture-account'].map(encodeURIComponent).join('@');
  let current = identity('device-before-reenrollment'); const previousScope = uiScope(current);
  const dependencies = { app: isolatedApp, identityOf: async () => current,
    session: { findBySessionId: () => null, archivedConversation: async (_app, id) => (await sessions.historyEntry(isolatedApp, id)).entry || null },
    newCwd: () => { const dir = path.join(storageRoot, 'workspace'); fs.mkdirSync(dir, { recursive: true }); return dir; },
    loadStorageSdk: async () => native };
  const store = module.create(dependencies), created = await store.reserve({ title: savedCard.prompt, draftSelection: selection });
  assert.equal(created.ok, true, created.reason);
  const card = structuredClone(savedCard); card.revision = 0; card.state.ownerScope = previousScope;
  const saved = await store.save(created.sessionId, card); assert.equal(saved.ok, true, saved.reason);
  current = identity('device-after-reenrollment', changedHub ? 'https://another-fixture.invalid' : undefined);
  const result = await module.create(dependencies).read(created.sessionId);
  assert.equal(JSON.parse(fs.readFileSync(module.location(isolatedApp, created.sessionId), 'utf8')).cards[0].state.ownerScope,
    previousScope, 'reading never rewrites the persisted owner marker');
  return { sessionId: created.sessionId, result, ownerScope: uiScope(current), previousScope };
}
async function mountAuthenticatedArchive(archive) {
  await reloadPage();
  await js(`fixtureOwner=${JSON.stringify(archive.ownerScope)};workCardsOverride=${JSON.stringify(archive)};
    fixtureArchives[fixtureOwner+':'+workCardsOverride.sessionId]={cards:workCardsOverride.result.cards||[],
      draftSelection:workCardsOverride.result.draftSelection||null,draftSelectionRevision:workCardsOverride.result.draftSelectionRevision||0};void 0;`);
  return js('openComposePanel({chatId:' + JSON.stringify(archive.sessionId) + '}).then(()=>true)');
}
app.whenReady().then(async () => {
  // Exercise the real model-selection handler through isolated preload IPC.
  // The synthetic trusted desk event replaces only the window/auth boundary;
  // there is deliberately no native handle for an empty ref.
  const handlers = new Map(), now = Math.floor(Date.now() / 1000);
  const identity = { hub: 'https://fixture.invalid', clientId: 'fixture-device',
    session: Buffer.from(JSON.stringify({ typ: 'device', uid: 'fixture-account', cid: 'fixture-device',
      iat: now - 10, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
  const modelHandle = { sessionId: 'fixture-live-session', selectModel: name => ({ ok: true,
    selection: { name, model: { id: name, label: name === 'fixture-history' ? '历史会话模型' : name } } }) };
  require('../main/pi-session/runtime-selection-ipc').install({ app,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    session: { get: ref => ref ? modelHandle : null }, identityOf: async () => identity,
    memories: { assertOwner() {} }, cloud: { guard: () => false }, publish() {} });
  const frame = {}, event = { senderFrame: frame, sender: { isDestroyed: () => false, mainFrame: frame,
    getURL: () => pathToFileURL(path.join(client, 'desk.html')).href } };
  electron.ipcMain.handle('fixture-select-model', (_event, ref, name) => handlers.get('pi-session-select-model')(event, ref, name));
  const preload = path.join(temp, 'preload.cjs');
  fs.writeFileSync(preload, "require('electron').contextBridge.exposeInMainWorld('fixtureModelBridge',{selectModel:(ref,name)=>require('electron').ipcRenderer.invoke('fixture-select-model',ref,name)});");
  win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: {
    preload, contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, callback) => {
    report.network.push(request.url); callback({ cancel: true });
  });
  buildPage();
  await runCase('starter requirement plus preserves draft and selections when cancelled and starts only after confirmation', async () => {
    await setup();
    await type('#cpInput', 'Unsent text must survive adding a requirement');
    const before = await js('structuredClone(calls)');
    const geometry = `(()=>{const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();
      return [r.x,r.y,r.width,r.height]};return {hero:rect('#cpTask .cp-hero'),composer:rect('#cpTask .cp-box'),input:rect('#cpInput')}})()`;
    const starterGeometry = await js(geometry);
    const plus = '.cp-requirement-dock [data-queue-action="add"]';
    const centered = await js(`(()=>{const b=document.querySelector(${JSON.stringify(plus)}).getBoundingClientRect();
      const c=document.querySelector('#cpTask .cp-box').getBoundingClientRect();return {delta:Math.abs(b.x+b.width/2-c.x-c.width/2),button:b.toJSON(),composer:c.toJSON()}})()`);
    assert.ok(centered.delta < 1, JSON.stringify(centered));
    await phase('starter-requirement-entry');
    await click(plus);
    await until('Boolean(document.querySelector(".ncollab-picker"))', 'starter picker');
    await phase('starter-requirement-picker');
    assert.deepEqual(await js(geometry), starterGeometry, 'the hero, composer and input keep their exact geometry');
    assert.equal(await js('document.querySelector("#composePanel").dataset.stage'), 'compose');
    assert.equal(await js('document.querySelector("#cpChat").childElementCount'), 0, 'opening a picker does not mount a hidden chat');
    assert.ok(await js(`(()=>{const r=document.querySelector('.ncollab-picker').getBoundingClientRect();
      const a=document.querySelector(${JSON.stringify(plus)}).getBoundingClientRect();return r.height>100&&r.bottom<=a.top-4&&r.top>=0})()`),
      'the same picker is anchored above the original starter');
    assert.equal(await js('NativeChat.hasSession()'), false);
    assert.equal((await js('calls.opens')).length, before.opens.length);
    assert.equal((await js('calls.reserve')).length, before.reserve.length);
    assert.equal(await js('document.querySelector("#cpInput").value'), 'Unsent text must survive adding a requirement');
    await click('[data-collab-picker-close]');
    await until('document.querySelector("#composePanel").dataset.stage==="compose"', 'return to starter');
    assert.deepEqual(await js(geometry), starterGeometry);
    assert.equal(await js('document.querySelector("#cpInput").value'), 'Unsent text must survive adding a requirement');
    assert.equal(await js('ComposeRuntime.value()'), 'qwen');
    assert.equal(await js('ComposeModelPicker.value().modelName'), 'fixture-chosen');
    assert.equal(await js('Boolean(document.querySelector("#cpTask .nplugin-chip.is-action"))'), true);
    await click(plus);
    await until('Boolean(document.querySelector(".ncollab-picker"))', 'reopened starter picker');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until('document.querySelector("#composePanel").dataset.stage==="compose"', 'Escape returns to starter');
    await js("tasks.push({id:'starter-task',title:'Existing ready requirement',status:'todo',note:'Return the test result',triageStage:'ready',workRouting:{}});void 0;");
    await click(plus);
    await until('Boolean(document.querySelector("[data-collab-task-select=starter-task]"))', 'selectable requirement');
    await click('[data-collab-task-select="starter-task"]');
    await click('[data-collab-picker-submit]');
    await until('calls.sends.length>0', 'requirement sent');
    const state = await phase('starter-requirement-added');
    assert.equal(state.calls.opens.length, before.opens.length + 1);
    assert.equal(state.calls.opens.at(-1).adapterId, 'qwen');
    assert.equal(state.calls.opens.at(-1).modelName, 'fixture-chosen');
    assert.equal(state.calls.sends.length, 1);
    assert.equal(await js('document.querySelector("#nchatInput").value'), 'Unsent text must survive adding a requirement');
  });
  await runCase('starter requirement picker ignores late list replies after navigation or account change', async () => {
    for (const accountChange of [false, true]) {
      await setup();
      await js('SoduWorkAPI.getTasksSnapshot=()=>new Promise(resolve=>window.finishStarterTasks=resolve);void 0;');
      await click('.cp-requirement-dock [data-queue-action="add"]');
      await until('typeof finishStarterTasks==="function"', 'delayed starter task list');
      if (accountChange) await js("fixtureOwner='other-account';dispatchEvent(new Event('soduwork-data-scope-changed'));void 0;");
      await js("openComposePanel({chatId:'history-session'}).then(()=>true)");
      await js("finishStarterTasks({online:true,items:[{id:'old-task',status:'todo',title:'Old account task'}]});void 0;");
      assert.equal(await js('NativeChat.sessionInfo().sessionId'), 'history-session');
      assert.equal(await js('Boolean(document.querySelector("[data-collab-task-select=old-task]"))'), false);
      assert.equal(await js('document.querySelector("#composePanel").dataset.stage'), 'chat');
    }
  });
  await runCase('starter requirement cancellation keeps long text files workspace and access without cloud fallback', async () => {
    await setup({ defaults: true });
    await js(`runtimeRows[0].accessControl={supported:true,schema:'soduwork.access-policy/v1',modes:['standard','readonly','full']};
      soduWorkAPI.conversationSession.probe=async()=>({ok:true,accessControl:runtimeRows[0].accessControl});
      soduWorkAPI.conversationSession.pickCwd=async()=>({ok:true,dir:'/isolated-project',name:'Chosen project'});
      ComposeRuntime.refreshAccess();void 0;`);
    await until('ComposeRuntime.accessSupported()', 'access controls ready');
    await click('#cpWorkspace'); await click('[data-workspace="pick"]');
    await until('document.querySelector("#cpWorkspaceName").textContent==="Chosen project"', 'workspace selection');
    await click('#cpPermission'); await click('#cpPermissionPop [data-mode="readonly"]');
    await type('#cpInput', '#');
    await until('Boolean(document.querySelector("#cpTask [data-skill-name=fixture-skill]"))', 'available skill');
    await click('#cpTask [data-skill-name="fixture-skill"]');
    const text = 'Keep every original sentence in this unsent draft. '.repeat(100);
    await type('#cpInput', text);
    await js(`(()=>{const data=new DataTransfer();data.items.add(new File(['fixture attachment'],'starter-evidence.txt',{type:'text/plain'}));
      const input=document.querySelector('#cpFile');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until('document.querySelector("#cpAtts").textContent.includes("starter-evidence.txt")', 'starter attachment');
    await click('.cp-requirement-dock [data-queue-action="add"]');
    await until('Boolean(document.querySelector(".ncollab-picker"))', 'starter long-draft picker');
    assert.equal(await js('document.querySelector("#cpWorkspaceName").textContent'), 'Chosen project');
    assert.equal(await js('document.querySelector("#cpChat").childElementCount'), 0);
    await click('[data-collab-picker-close]');
    assert.equal(await js('NativeChat.getDraft("new")'), text);
    assert.match(await js('document.querySelector("#cpAtts").textContent'), /starter-evidence.txt/);
    assert.equal(await js('document.querySelector("#cpWorkspaceName").textContent'), 'Chosen project');
    assert.match(await js('document.querySelector("#cpPermissionName").textContent'), /只读/);
    assert.deepEqual(await js('NativeChat.getDraftSkills("new")'), ['fixture-skill']);
    assert.equal(await js('Boolean(document.querySelector("#cpTask [data-remove-skill=fixture-skill]"))'), true);
    await click('#cpTask [data-execution-menu]'); await click('#cpTask [data-execution="cloud"]');
    await until('ComposeExecution.value()==="cloud"', 'cloud selection');
    await click('.cp-requirement-dock [data-queue-action="add"]');
    assert.equal(await js('ComposeExecution.value()'), 'cloud');
    assert.equal(await js('document.querySelector("#composePanel").dataset.stage'), 'compose');
    assert.equal(await js('NativeChat.getDraft("new")'), text);
    assert.match(await js('notices.at(-1)'), /云端需求请在需求池安排执行/);
    assert.equal(await js('calls.opens.length+calls.reserve.length+calls.sends.length'), 0);
    const plus = '.cp-requirement-dock [data-queue-action="add"]';
    for (const changed of ['thinkingLevel', 'accessMode', 'cancel']) {
      await setup({ defaults: true });
      await js("tasks.push({id:'guarded-task',title:'Guarded requirement',status:'todo',triageStage:'ready'});window.originalGetTask=SoduWorkAPI.getTask;SoduWorkAPI.getTask=id=>new Promise(resolve=>window.finishTaskLookup=()=>resolve(tasks.find(task=>task.id===id)));void 0;");
      await click(plus); await click('[data-collab-task-select="guarded-task"]');
      await click('[data-collab-picker-submit]');
      await until('typeof finishTaskLookup==="function"', 'fresh task lookup pending');
      if (changed === 'thinkingLevel') await js("window.modelValue=ComposeModelPicker.value;ComposeModelPicker.value=()=>({...modelValue(),thinkingLevel:'high'});void 0;");
      else if (changed === 'accessMode') await js("ComposeRuntime.accessSupported=()=>true;void 0;");
      else await click('[data-collab-picker-close]');
      await js('finishTaskLookup();void 0;');
      await until('!document.querySelector(".ncollab-picker")', 'stale execution settings close the picker');
      assert.equal(await js('document.querySelector("#composePanel").dataset.stage'), 'compose');
      assert.equal(await js('document.querySelector("#cpChat").childElementCount'), 0);
      assert.equal(await js('calls.opens.length+calls.reserve.length+calls.sends.length'), 0);
    }
    try {
      await setup({ defaults: true });
      const longText = await js('NativeChat.getDraft("new")');
      assert.ok(longText.length > 3000, 'the long-text card remains present through every setup transition');
      await js("tasks=Array.from({length:18},(_,i)=>({id:'narrow-'+i,title:'Narrow requirement '+i,status:'todo',triageStage:'ready'}));void 0;");
      win.setSize(360, 600);
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const geometry = `(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.width,r.height]};return [rect('#cpTask .cp-hero'),rect('#cpInput')]})()`;
      const before = await js(geometry);
      await click(plus);
      assert.deepEqual(await js(geometry), before);
      const bounds = await js(`(()=>{const r=document.querySelector('.ncollab-picker').getBoundingClientRect(),a=document.querySelector('.cp-requirement-dock [data-queue-action=add]').getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,anchor:a.top,width:innerWidth,height:innerHeight}})()`);
      assert.ok(bounds.top>=0&&bounds.bottom<=bounds.anchor-4&&bounds.left>=0&&bounds.right<=bounds.width&&bounds.bottom<=bounds.height, JSON.stringify(bounds));
      await click('[data-collab-search]'); await type('[data-collab-search]', 'Narrow requirement 17');
      await click('[data-collab-task-select="narrow-17"]');
      await phase('starter-requirement-narrow');
      await js('document.querySelector("[data-collab-picker-submit]").scrollIntoView({block:"nearest"});void 0;');
      assert.ok(await js('document.querySelector(".ncollab-picker").scrollTop>0'));
      await phase('starter-requirement-narrow-confirm');
      await click('[data-collab-picker-submit]');
      await until('calls.sends.length===1', 'narrow starter requirement confirmed');
      assert.equal(await js('NativeChat.getDraft("new")'), longText);
    } finally { win.setSize(1100, 850); }
  });
  await runCase('starter requirement pending lists can be cancelled and reopened without stale takeover', async () => {
    await setup();
    await js('window.starterLists=[];SoduWorkAPI.getTasksSnapshot=()=>new Promise(resolve=>starterLists.push(resolve));void 0;');
    const plus = '.cp-requirement-dock [data-queue-action="add"]';
    await click(plus); await until('starterLists.length===1', 'first list pending');
    await click('[data-collab-picker-close]');
    await click(plus); await until('starterLists.length===2', 'second list pending');
    await js("starterLists[0]({online:true,items:[{id:'stale-task',title:'Stale task',status:'todo'}]});void 0;");
    assert.equal(await js('Boolean(document.querySelector("[data-collab-task-select=stale-task]"))'), false);
    await click('#cpInput');
    await until('document.querySelector("#composePanel").dataset.stage==="compose"', 'outside click returns to starter');
    await js('starterLists[1]({online:true,items:[]});void 0;');
    assert.equal(await js('document.querySelector("#composePanel").dataset.stage'), 'compose');
    assert.equal(await js('calls.opens.length+calls.reserve.length+calls.sends.length'), 0);
  });
  await runCase('blank chatbar preselects a model without empty-ref IPC and keeps it for the first send', async () => {
    await win.loadFile(page);
    await js("openComposePanel({newSession:true});NativeChat.prepare();document.querySelector('.compose-panel').dataset.stage='chat';void 0;");
    assert.equal(await js("NativeChat.sessionInfo().ref||''"), '');
    assert.equal(await js("NativeChat.sessionInfo().sessionId||''"), '');
    assert.equal(await js("document.querySelector('#nchatModel .nmodel-button').disabled"), false);
    await click('#nchatModel .nmodel-button'); await click('[data-model-name="fixture-chosen"]');
    const selected = await phase('blank-chatbar-selected-model');
    assert.equal(selected.model, '首页选中的模型');
    assert.deepEqual(selected.calls.modelSelections, [], 'a draft has no native handle to switch');
    assert.deepEqual(selected.notices, []); assert.equal(selected.calls.reserve.length, 0);
    assert.equal(selected.calls.selections.length, 0, 'a blank draft has no archive to persist');
    await type('#nchatInput', '使用预选模型继续普通对话'); await click('#nchatSend');
    await until('calls.sends.length===1', 'first send after blank model selection');
    const started = await phase('blank-chatbar-first-send');
    assert.equal(started.calls.opens[0].modelName, 'fixture-chosen');
    assert.equal(started.calls.opens[0].adapterId || 'pi', 'pi');
    assert.equal(started.session.adapterId, 'pi');
    assert.deepEqual(started.calls.modelSelections, []);
    await click('#nchatModel .nmodel-button'); await click('[data-model-name="fixture-history"]');
    await until('calls.modelSelections.length===1', 'running conversation uses model-selection IPC');
    const switched = await phase('blank-chatbar-running-model');
    assert.equal(switched.calls.modelSelections[0].ref, 'draft-ref');
    assert.equal(switched.calls.modelSelections[0].result.ok, true);
    assert.equal(switched.model, '历史会话模型');
  });
  for (const outcome of ['success', 'failure']) {
    await runCase('selected home model and Agent survive requirement parsing ' + outcome, async () => {
      await setup(); await phase(outcome + '-home'); await click('#cpGo');
      await until("Boolean(pendingParse) && Boolean(document.querySelector('#wesTaskDraft .cp-loading'))", 'real requirement parsing');
      const loading = await phase(outcome + '-loading');
      await js('pendingParse(' + JSON.stringify(outcome) + ');void 0;');
      await until("Boolean(document.querySelector('#wesTaskDraft #cpTitle'))", 'requirement parse result');
      const settled = await phase(outcome + '-settled');
      assert.equal(loading.calls.parse[0]?.model, 'fixture-chosen', 'parser receives the selected home model');
      assertSelection(loading, 'loading'); assertSelection(settled, outcome);
      assert.equal(settled.calls.opens.length, 0, 'requirement parsing does not initialize a model session');
      if (outcome === 'failure') {
        assert.equal(await js("Boolean(document.querySelector('#cpParseRetry'))"), false);
        assert.match(await js('document.querySelector(".cp-parse-warning").textContent'), /无法连接模型服务/);
        await type('#wesTaskDraft #cpNote', 'User-edited acceptance context survives the retry');
        // Explicitly select requirement editing; ordinary chat must not mutate an open work draft.
        await type('#nchatInput', '/');
        await until("Boolean(document.querySelector('#cpChat .nplugin-option.is-action:not([disabled])'))", 'explicit requirement retry action');
        await click('#cpChat .nplugin-option.is-action:not([disabled])');
        await type('#nchatInput', '重试');
        await click('#nchatSend');
        await until('calls.parse.length===2', 'explicit chat parse retry');
        assert.deepEqual(await js('calls.parse[1]'), settled.calls.parse[0]);
        const retrying = await phase('retry-loading');
        assertSelection(retrying, 'retry loading');
        assert.equal(retrying.calls.opens.length, 0, 'retrying does not initialize a model session');
        await js("pendingParse('success');void 0;");
        await until("Boolean(document.querySelector('#wesTaskDraft #cpTitle')) && !document.querySelector('#wesTaskDraft .cp-parse-warning')", 'retry result');
        assert.equal(await js("Boolean(document.querySelector('#cpParseRetry'))"), false);
        assert.equal(await js("Boolean(document.querySelector('#wesTaskDraft .cp-parse-warning'))"), false);
        assert.equal(await js('document.querySelector("#wesTaskDraft #cpNote").value'),
          'User-edited acceptance context survives the retry');
        assert.equal(await js('calls.creates.length'), 0);
        assert.equal(await js('calls.opens.length+calls.sends.length'), 0);
        await phase('retry-success');
      }
    });
  }
  await runCase('requirement receipt keeps its original transcript position after history return', async () => {
    const sessionId = await createWorkDraft({ defaults: true });
    await js('successfulRequirements=true;void 0;'); await click('#wesTaskDraft #cpCreate');
    await until('Boolean(document.querySelector("#wesTaskDraft .cp-ok"))', 'created card');
    const taskId = await js('calls.creates[0]');
    await js(`fixtureTranscript=[{role:'user',text:'执行需求',sentAt:Date.now(),taskOutputKey:'u1'},
      {role:'assistant',done:true,blocks:[{kind:'text',text:'第一轮已完成'}],completedAt:Date.now()+1,taskOutputKey:'a1'}];void 0;`);
    await js("openComposePanel({chatId:'history-session'}).then(()=>true)");
    await js('fixtureArchives[fixtureOwner+":"+' + JSON.stringify(sessionId) + '].started=true;void 0;');
    await js('openComposePanel({chatId:' + JSON.stringify(sessionId) + '}).then(()=>true)');
    await until('Boolean(document.querySelector("#wesTaskDraft .cp-ok"))', 'restored created card');
    assert.equal(await js(`Boolean(document.querySelector('[data-work-card-slot]').compareDocumentPosition(
      document.querySelector('[data-chat-node="message:0"]')) & Node.DOCUMENT_POSITION_FOLLOWING)`), true,
      'the original requirement stays before its execution messages');
    assert.equal(await js('WorkEntrySheet.capture().receipt.id'), taskId);
    await phase('receipt-original-position');
  });
  await runCase('requirement created mid-conversation stays between the same messages during streaming and restore', async () => {
    await setup({ defaults: true });
    await js(`fixtureTranscript=[{role:'user',text:'此前的问题',sentAt:100,taskOutputKey:'before-user'},
      {role:'assistant',done:true,blocks:[{kind:'text',text:'此前的回复'}],completedAt:200,taskOutputKey:'before-reply'}];
      fixtureArchives[fixtureOwner+':history-session']={cards:[],started:true};void 0;`);
    await js("openComposePanel({chatId:'history-session'}).then(()=>true)");
    // Parsing intentionally waits for the fixture; do not await it before resolving pendingParse.
    await js("void NativeChat.openWorkAction({id:'work.requirement.create',text:'在对话中途记录需求'})");
    await until('Boolean(pendingParse)', 'mid-conversation parse'); await js("pendingParse('success');successfulRequirements=true;void 0;");
    await until('Boolean(document.querySelector("#wesTaskDraft #cpCreate"))', 'mid-conversation form');
    await click('#wesTaskDraft #cpCreate');
    await until('Boolean(document.querySelector("#wesTaskDraft .cp-ok"))', 'mid-conversation receipt');
    await js(`window.originalMidReceipt=document.querySelector('#wesTaskDraft .cp-ok');
      fixtureTranscript.push({role:'user',text:'之后的问题',sentAt:Date.now(),taskOutputKey:'after-user'},
      {role:'assistant',done:false,blocks:[{kind:'text',text:'正在回答',done:false}],taskOutputKey:'after-reply'});
      fixtureListeners.forEach(fn=>fn({ref:NativeChat.sessionInfo().ref,kind:'snapshot',snapshot:{status:'streaming',messages:structuredClone(fixtureTranscript),tools:[]}}));void 0;`);
    await until(`Boolean(document.querySelector('[data-chat-node="message:3"]'))`, 'later messages visible');
    const anchored = `(()=>{const card=document.querySelector('[data-work-card-slot]');return Boolean(
      document.querySelector('[data-chat-node="message:1"]').compareDocumentPosition(card)&Node.DOCUMENT_POSITION_FOLLOWING)&&
      Boolean(card.compareDocumentPosition(document.querySelector('[data-chat-node="message:2"]'))&Node.DOCUMENT_POSITION_FOLLOWING)})()`;
    assert.equal(await js(anchored), true);
    assert.equal(await js('originalMidReceipt===document.querySelector("#wesTaskDraft .cp-ok")'), true, 'structural streaming keeps the same receipt DOM');
    await js(`fixtureTranscript[3].done=true;fixtureTranscript[3].blocks[0].done=true;
      fixtureListeners.forEach(fn=>fn({ref:NativeChat.sessionInfo().ref,kind:'snapshot',snapshot:{status:'idle',messages:structuredClone(fixtureTranscript),tools:[]}}));void 0;`);
    await js("openComposePanel({chatId:'another-session'}).then(()=>true)");
    await js("openComposePanel({chatId:'history-session'}).then(()=>true)");
    await until('Boolean(document.querySelector("#wesTaskDraft .cp-ok"))', 'mid-conversation receipt restored');
    assert.equal(await js(anchored), true);
    await phase('receipt-middle-position');
  });
  for (const defaults of [true, false]) for (const reopen of [false, true]) {
    await runCase('created requirement sends from its original conversation: ' + (defaults ? 'default Pi' : 'explicit Qwen model') + (reopen ? ' after history return' : ' directly'), async () => {
      const sessionId = await createWorkDraft({ defaults });
      await js('successfulRequirements=true;void 0;'); await click('#wesTaskDraft #cpCreate');
      await until("Boolean(document.querySelector('#wesTaskDraft .cp-ok'))", 'successful requirement receipt');
      const taskId = await js('calls.creates[0]'); assert.ok(taskId);
      await until(`Boolean(document.querySelector('[data-queue-action="start"][data-task-id="${taskId}"]'))`, 'created requirement is ready to send');
      assert.equal(await js('calls.opens.length'), 0, 'saving does not initialize an Agent');
      assert.equal(await js('calls.sends.length'), 0, 'saving does not execute the requirement');
      if (reopen) {
        await js("openComposePanel({chatId:'history-session'}).then(()=>true)");
        // Exercise the real normalized collaboration index before its Hub read settles.
        // A missing model in cached metadata must not erase this work draft's explicit choice.
        await js('delayTaskReads=true;void 0;');
        await js('openComposePanel({chatId:' + JSON.stringify(sessionId) + '}).then(()=>true)');
        await until(`Boolean(document.querySelector('[data-queue-action="start"][data-task-id="${taskId}"]'))`, 'restored created requirement remains ready to send');
        const restored = await phase('created-restored-' + (defaults ? 'default' : 'chosen'));
        assert.equal(restored.model, defaults ? '默认模型' : '首页选中的模型');
        assert.equal(restored.agent, defaults ? 'Pi' : 'Qwen Code');
        assert.equal(restored.session.sessionId, sessionId); assert.equal(restored.session.ref, '');
        assert.equal(restored.calls.creates.length, 1, 'returning never duplicates creation');
      }
      const openCount = await js('calls.opens.length');
      await js('window.savedRequirementReceipt=document.querySelector("#wesTaskDraft .cp-ok");void 0;');
      await click(`[data-queue-action="start"][data-task-id="${taskId}"]`);
      if (reopen) {
        assert.equal(await js('calls.opens.length'), openCount, 'cached task metadata must await the authoritative task before initializing a runtime');
        assert.equal(await js('calls.sends.length'), 0, 'a pending task read cannot start execution');
        await js('delayTaskReads=false;pendingTaskReads.splice(0).forEach(resolve=>resolve());void 0;');
      }
      await until('calls.sends.length===1', 'created requirement accepted by fixture runtime');
      const state = await phase('created-send-' + (defaults ? 'default' : 'chosen') + (reopen ? '-returned' : '-direct'));
      assert.equal(state.calls.opens.length, openCount + 1, 'one runtime is initialized for the original draft');
      assert.equal(state.calls.opens.at(-1).chatId, sessionId);
      assert.equal(state.calls.opens.at(-1).taskRef, taskId);
      assert.equal(state.calls.opens.at(-1).requireTaskBinding, true);
      assert.equal(state.calls.opens.at(-1).adapterId, defaults ? 'pi' : 'qwen');
      assert.equal(state.calls.opens.at(-1).modelName, defaults ? 'fixture-default' : 'fixture-chosen');
      assert.equal(state.calls.sends[0].options.taskId, taskId);
      assert.equal(state.calls.sends[0].ref, 'draft-ref');
      assert.equal(state.session.sessionId, sessionId);
      assert.equal(await js('savedRequirementReceipt.isConnected && savedRequirementReceipt === document.querySelector("#wesTaskDraft .cp-ok")'),
        true, 'executing in the same conversation must retain the original successful requirement card');
      assert.ok(state.calls.binds.some(row => row.taskId === taskId));
      assert.doesNotMatch(await js('document.body.innerText'), /打开不了对话|无法连接协作会话/);
      assert.equal(await js('NativeChat.send("补充说明：请保留验收证据")'), true);
      assert.equal(await js('savedRequirementReceipt.isConnected'), true, 'a following message must keep the receipt too');
      await js("openComposePanel({chatId:'history-session'}).then(()=>true)");
      assert.equal(await js('Boolean(document.querySelector("#wesTaskDraft .cp-ok"))'), false, 'the receipt must not leak into another conversation');
      await js('openComposePanel({chatId:' + JSON.stringify(sessionId) + '}).then(()=>true)');
      await until('Boolean(document.querySelector("#wesTaskDraft .cp-ok"))', 'receipt restored after execution and navigation');
      assert.equal(await js('WorkEntrySheet.capture().receipt.id'), taskId);
      assert.equal(await js('calls.creates.length'), 1, 'keeping or reopening the receipt never creates another requirement');
    });
  }
  await runCase('empty default model archive opens the requirement plus picker and adds a ready task', async () => {
    const sessionId = await createWorkDraft({ defaults: true });
    await js(`const archive=fixtureArchives['fixture-owner:'+NativeChat.sessionInfo().sessionId];
      archive.draftSelection={adapterId:'pi',modelName:'',modelLabel:'',reasoningEffort:'',thinkingLevel:''};
      localStorage.setItem('fixtureWorkArchives',JSON.stringify(fixtureArchives));void 0;`);
    await reloadPage(); await js('openComposePanel({chatId:' + JSON.stringify(sessionId) + '}).then(()=>true)');
    await js(`tasks.push({id:'ready-existing',title:'默认模型下添加的需求',note:'明确执行这条现有需求',status:'todo',triageStage:'ready',
      canViewExecution:true,readOnly:false,acceptanceCriteria:['完成指定需求']});void 0;`);
    await click('#cpChat [data-queue-action="add"]');
    await until("Boolean(document.querySelector('.ncollab-picker-row[data-collab-task-select=\"ready-existing\"]'))", 'default model requirement picker');
    await click('.ncollab-picker-row[data-collab-task-select="ready-existing"]');
    await click('[data-collab-picker-submit]');
    await until('calls.sends.length===1', 'default model selected requirement sent');
    const state = await phase('default-empty-model-add-requirement');
    assert.equal(state.calls.opens.length, 1); assert.equal(state.calls.opens[0].chatId, sessionId);
    assert.equal(state.calls.opens[0].adapterId, 'pi'); assert.equal(state.calls.opens[0].modelName, '');
    assert.equal(state.calls.sends[0].options.taskId, 'ready-existing');
    assert.equal(state.session.sessionId, sessionId); assert.equal(state.calls.creates.length, 0);
  });
  await runCase('normal send after the requirement card opens the selected model and Agent', async () => {
    await setup(); await click('#cpGo'); await until('Boolean(pendingParse)', 'parser request');
    await js("pendingParse('success');void 0;");
    await until("Boolean(document.querySelector('#wesTaskDraft #cpTitle'))", 'parsed form');
    await click('#cpCancel'); await type('#nchatInput', '继续普通对话'); await click('#nchatSend');
    await until('calls.sends.length===1', 'ordinary chat send');
    const state = await phase('ordinary-send');
    assert.equal(state.calls.opens[0].modelName, 'fixture-chosen');
    assert.equal(state.calls.opens[0].adapterId, 'qwen');
    assert.equal(state.calls.sends[0].ref, 'draft-ref');
  });
  await runCase('opening another conversation during parsing retains that conversation selection', async () => {
    await setup(); await click('#cpGo'); await until('Boolean(pendingParse)', 'pending old parse');
    await js("openComposePanel({chatId:'history-session'}).then(()=>true)");
    await until("NativeChat.sessionInfo().ref==='history-ref'", 'history conversation');
    await js("pendingParse('success');void 0;");
    const state = await phase('other-conversation');
    assert.equal(state.model, '历史会话模型'); assert.equal(state.agent, 'Pi');
    assert.equal(state.session.ref, 'history-ref');
  });
  await runCase('first model catalog may finish after the requirement was submitted', async () => {
    await win.loadFile(page); await js('slowCatalog=true;openComposePanel({newSession:true});void 0;');
    await until('Boolean(pendingCatalog)', 'held initial model catalog');
    await selectRequirement(); await click('#cpGo');
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const waiting = await js('({parse:calls.parse.length,reserve:calls.reserve.length,text:document.querySelector("#cpInput").value})');
    await js('pendingCatalog();void 0;');
    await until('Boolean(pendingParse)', 'requirement starts after concrete default resolves');
    const state = await phase('late-catalog-loading');
    assert.deepEqual(waiting, { parse: 0, reserve: 0, text: '制作一个可以打开的网页' }, 'pending catalog must retain the user submission');
    assert.equal(state.calls.parse[0].model, 'fixture-default');
    assert.equal(state.model, '默认模型'); assert.equal(state.agent, 'Pi');
    await js("pendingParse('success');void 0;");
  });
  await runCase('navigation cancels a requirement still waiting for its initial model catalog', async () => {
    await win.loadFile(page); await js('slowCatalog=true;openComposePanel({newSession:true});void 0;');
    await until('Boolean(pendingCatalog)', 'held initial catalog');
    await selectRequirement(); await click('#cpGo');
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await js("openComposePanel({chatId:'history-session'}).then(()=>true)");
    await js('pendingCatalog();void 0;');
    await until("NativeChat.sessionInfo().ref==='history-ref'", 'navigation committed');
    const state = await phase('late-catalog-navigation');
    assert.equal(state.model, '历史会话模型'); assert.equal(state.agent, 'Pi');
    assert.equal(state.calls.parse.length, 0); assert.equal(state.calls.reserve.length, 0);
    assert.equal(await js("Boolean(document.querySelector('#wesTaskDraft'))"), false);
  });
  await runCase('changing Agent cancels the waiting submission and a new send uses the new choice', async () => {
    await win.loadFile(page); await js('slowCatalog=true;openComposePanel({newSession:true});void 0;');
    await until('Boolean(pendingCatalog)', 'held catalog before Agent change');
    await selectRequirement(); await click('#cpGo');
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await click('#cpRuntime'); await click('[data-runtime="qwen"]');
    await until("ComposeRuntime.value()==='qwen'", 'replacement Agent');
    await js('pendingCatalog();Promise.resolve(ComposeModelPicker.ready()).then(()=>true)');
    assert.equal(await js('calls.parse.length'), 0, 'old Agent submission is cancelled');
    assert.equal(await js('document.querySelector("#cpInput").value'), '制作一个可以打开的网页');
    await click('#cpGo'); await until('Boolean(pendingParse)', 'explicit new submission');
    const state = await phase('changed-agent-loading');
    assert.equal(state.calls.parse[0].model, 'fixture-default');
    assert.equal(state.model, '默认模型'); assert.equal(state.agent, 'Qwen Code');
    await js("pendingParse('success');void 0;");
  });
  await runCase('changing execution location cancels the local submission still waiting for a model', async () => {
    await win.loadFile(page); await js('slowCatalog=true;openComposePanel({newSession:true});void 0;');
    await until('Boolean(pendingCatalog)', 'held catalog before location change');
    await selectRequirement(); await click('#cpGo');
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await click('#cpTask [data-execution-menu]'); await click('#cpTask [data-execution="cloud"]');
    await until("ComposeExecution.value()==='cloud'", 'cloud location selection');
    await js('pendingCatalog();Promise.resolve(ComposeModelPicker.ready()).then(()=>true)');
    assert.equal(await js('calls.parse.length'), 0); assert.equal(await js('calls.reserve.length'), 0);
    assert.equal(await js('document.querySelector("#cpInput").value'), '制作一个可以打开的网页');
    assert.equal(await js('document.querySelector("#composePanel").dataset.stage'), 'compose');
  });
  await runCase('reentering the same work-only conversation keeps its selection', async () => {
    const sessionId = await createWorkDraft();
    await js('openComposePanel({chatId:' + JSON.stringify(sessionId) + '}).then(()=>true)');
    assertSelection(await phase('work-only-reenter'), 'same conversation');
    assert.equal(await js('calls.opens.length'), 0);
  });
  await runCase('a changed draft model survives leaving and reopening its conversation', async () => {
    const sessionId = await createWorkDraft();
    await click('#nchatModel .nmodel-button'); await click('[data-model-name="fixture-history"]');
    await until("document.querySelector('#nchatModel .nmodel-button span').textContent==='历史会话模型'", 'draft model changed');
    await js("openComposePanel({chatId:'history-session'}).then(()=>true)");
    await js('openComposePanel({chatId:' + JSON.stringify(sessionId) + '}).then(()=>true)');
    const state = await phase('work-only-reopen-modified');
    assert.equal(state.model, '历史会话模型'); assert.equal(state.agent, 'Qwen Code');
    assert.equal(state.session.ref, '', 'reopening a work-only archive must not initialize its Agent');
  });
  await runCase('a fresh renderer restores persisted draft model and Agent before any model session starts', async () => {
    const sessionId = await createWorkDraft();
    await reloadPage(); await until('Boolean(window.openComposePanel)', 'reloaded production modules');
    await js('openComposePanel({chatId:' + JSON.stringify(sessionId) + '}).then(()=>true)');
    const state = await phase('work-only-reloaded');
    assertSelection(state, 'fresh renderer'); assert.equal(state.calls.opens.length, 0);
  });
  await runCase('a cold renderer restores the requirement title note and three checklist rows in the actual form DOM', async () => {
    const sessionId = await createWorkDraft();
    const expected = { title: '重启后必须保留的需求标题', note: '需求说明包含完整的页面目标和用户交互。'.repeat(6),
      checks: ['可以打开网页', '交互按钮可以使用', '手机尺寸可以正常浏览'] };
    await type('#wesTaskDraft #cpTitle', expected.title); await type('#wesTaskDraft #cpNote', expected.note);
    await until("fixtureArchives['fixture-owner:'+NativeChat.sessionInfo().sessionId]?.cards.some(row=>row.state?.draft?.title==='重启后必须保留的需求标题'&&row.state?.draft?.note.length>100&&row.state?.draft?.check.length===3)", 'complete requirement draft persisted');
    await reloadPage(); await until('Boolean(window.openComposePanel)', 'cold production modules loaded');
    await js('openComposePanel({chatId:' + JSON.stringify(sessionId) + '}).then(()=>true)');
    const form = await js("({title:document.querySelector('#wesTaskDraft #cpTitle')?.value,note:document.querySelector('#wesTaskDraft #cpNote')?.value,checks:[...document.querySelectorAll('#wesTaskDraft #cpCheck [data-ck]')].map(node=>node.value)})");
    await phase('work-only-cold-body');
    assert.deepEqual(form, expected, 'cold restore must mount the actual editable body, not only the sheet header and materials');
    assert.equal(await js('calls.parse.length'), 0, 'saved content restores without calling the model again');
    assert.equal(await js('calls.opens.length'), 0, 'restoring the form does not initialize its Agent');
  });
  await runCase('a same-account reenrolled device restores the complete card from the actual main-process archive read', async () => {
    await createWorkDraft();
    const saved = await js('structuredClone(calls.saves.at(-1).card)');
    const selection = await js("structuredClone(fixtureArchives['fixture-owner:'+NativeChat.sessionInfo().sessionId].draftSelection)");
    const archive = await restoreFromReenrolledDevice(saved, selection);
    assert.equal(archive.result.ok, true, archive.result.reason);
    await mountAuthenticatedArchive(archive);
    const state = await phase('work-only-reenrolled-device');
    assert.deepEqual(state.form, { title: saved.state.draft.title, note: saved.state.draft.note, checks: saved.state.draft.check },
      'the authorized archive restores the complete form after device reenrollment');
    assert.equal(state.calls.parse.length, 0); assert.equal(state.calls.opens.length, 0);
    assert.equal(archive.result.cards[0].state.ownerScope, archive.ownerScope, 'the main process normalizes only its authenticated read copy');
    assertSelection(state, 'reenrolled device');
  });
  await runCase('a different-Hub card scope remains rejected with an inline error and unchanged saved content', async () => {
    await createWorkDraft();
    const saved = await js('structuredClone(calls.saves.at(-1).card)');
    const selection = await js("structuredClone(fixtureArchives['fixture-owner:'+NativeChat.sessionInfo().sessionId].draftSelection)");
    const archive = await restoreFromReenrolledDevice(saved, selection, true);
    assert.equal(archive.result.ok, true, archive.result.reason);
    assert.equal(archive.result.cards[0].state.ownerScope, archive.previousScope, 'cross-Hub scope is not rewritten');
    assert.deepEqual(archive.result.cards[0].state.draft, saved.state.draft, 'rejected content is preserved exactly');
    await mountAuthenticatedArchive(archive);
    // The sheet's 120 ms repair loop must not replace an ownership rejection.
    await js('new Promise(resolve=>setTimeout(resolve,350))');
    const state = await phase('work-only-rejected-scope');
    assert.match(await js("document.querySelector('#wesTaskDraft[role=alert]')?.textContent||''"), /账号或服务已切换/);
    assert.equal(await js("Boolean(document.querySelector('#wesTaskDraft #cpTitle'))"), false, 'an unauthorized form is not editable');
    assert.equal(await js("document.querySelector('#workEntryLayer .wes-attach-zone')?.inert"), true);
    assert.equal(await js('WorkEntrySheet.active()'), null); assert.equal(await js('WorkEntrySheet.capture()'), null);
    assert.equal(state.calls.parse.length, 0); assert.equal(state.calls.creates.length, 0); assert.equal(state.calls.opens.length, 0);
    assert.equal(state.calls.saves.length, 0, 'rejected restore never replaces the saved draft with an empty shell');
    assert.deepEqual(await js('fixtureArchives[fixtureOwner+":"+NativeChat.sessionInfo().sessionId].cards[0].state.draft'),
      saved.state.draft, 'rejected content stays unchanged after the repair loop has run');
  });
  await runCase('changing both draft Agent and model persists the explicit replacement across reload', async () => {
    const sessionId = await createWorkDraft();
    await click('#nchatRuntime');
    assert.deepEqual(await js("[...document.querySelectorAll('[data-session-agent] .agent-monogram')].map(node=>node.textContent)"), ['PI', 'QW']);
    await click('[data-session-agent="pi"]');
    await until("document.querySelector('#nchatRuntimeName').textContent==='Pi'", 'replacement draft Agent');
    await click('#nchatModel .nmodel-button'); await click('[data-model-name="fixture-default"]');
    await until("fixtureArchives['fixture-owner:'+NativeChat.sessionInfo().sessionId]?.draftSelection?.modelName==='fixture-default'", 'replacement choice persisted');
    await reloadPage(); await js('openComposePanel({chatId:' + JSON.stringify(sessionId) + '}).then(()=>true)');
    const state = await phase('work-only-reloaded-replacement');
    assert.equal(state.model, '默认模型'); assert.equal(state.agent, 'Pi'); assert.equal(state.calls.opens.length, 0);
  });
  await runCase('an unreadable work archive blocks sending without falling back to a default model', async () => {
    const sessionId = await createWorkDraft(); await reloadPage();
    await js('failWorkCards=true;openComposePanel({chatId:' + JSON.stringify(sessionId) + '}).then(()=>true)');
    await type('#nchatInput', '档案读取失败时保留这段话'); await click('#nchatSend');
    const state = await phase('work-only-read-failed');
    assert.equal(state.calls.opens.length, 0); assert.equal(state.calls.sends.length, 0);
    assert.equal(await js('document.querySelector("#nchatInput").value'), '档案读取失败时保留这段话');
    assert.match(await js('document.body.innerText'), /模拟档案读取失败/);
    await js('failWorkCards=false;void 0;'); await click('[data-session-retry]');
    await until("Boolean(document.querySelector('#wesTaskDraft #cpTitle'))", 'retry restores the original work archive');
    assertSelection(await phase('work-only-read-retried'), 'archive retry');
    assert.equal(await js('calls.opens.length'), 0, 'retrying an unreadable draft does not start an Agent');
    assert.equal(await js('calls.sends.length'), 0);
    assert.equal(await js('document.querySelector("#nchatInput").value'), '档案读取失败时保留这段话');
  });
  await runCase('a rejected card IPC leaves opening state and restores the same draft on retry', async () => {
    const sessionId = await createWorkDraft(); await reloadPage();
    await js('rejectWorkCards=true;openComposePanel({chatId:' + JSON.stringify(sessionId) + '}).catch(()=>false)');
    assert.match(await js('document.body.innerText'), /工作卡片暂时无法读取/);
    assert.equal(await js('calls.opens.length'), 0);
    await js('rejectWorkCards=false;void 0;'); await click('[data-session-retry]');
    await until("Boolean(document.querySelector('#wesTaskDraft #cpTitle'))", 'rejected IPC retry restores the form');
    assertSelection(await phase('work-only-ipc-retried'), 'rejected IPC retry');
    assert.equal(await js('calls.opens.length'), 0); assert.equal(await js('calls.sends.length'), 0);
  });
  await runCase('selection storage failure preserves the draft choice and blocks sending until saved', async () => {
    await createWorkDraft(); await js('failSelectionSave=true;void 0;');
    await click('#nchatModel .nmodel-button'); await click('[data-model-name="fixture-history"]');
    await until('calls.selections.length>0', 'selection save attempted');
    await until("document.querySelector('#nchatModel .nmodel-button span').textContent==='历史会话模型'", 'unsaved choice retained');
    await click('#cpCancel'); await type('#nchatInput', '保存成功后才继续普通对话'); await click('#nchatSend');
    await until("notices.some(text=>text.includes('模拟选择保存失败'))", 'explicit persistence error');
    const failed = await phase('selection-save-failed');
    assert.equal(failed.calls.opens.length, 0); assert.equal(failed.calls.sends.length, 0);
    assert.equal(failed.model, '历史会话模型'); assert.equal(failed.agent, 'Qwen Code');
    assert.equal(await js('document.querySelector("#nchatInput").value'), '保存成功后才继续普通对话');
    await js('failSelectionSave=false;void 0;'); await click('#nchatSend');
    await until('calls.sends.length===1', 'send after selection storage recovers');
    const retried = await phase('selection-save-retried');
    assert.equal(retried.calls.opens[0].modelName, 'fixture-history');
    assert.equal(retried.calls.opens[0].adapterId, 'qwen');
  });
  await runCase('a draft started in another window reenters its authoritative runtime instead of saving stale draft choices', async () => {
    const sessionId = await createWorkDraft();
    await js("fixtureArchives['fixture-owner:'+NativeChat.sessionInfo().sessionId].started=true;void 0;");
    await click('#nchatModel .nmodel-button'); await click('[data-model-name="fixture-history"]');
    await until("notices.some(text=>text.includes('另一窗口开始执行'))", 'started archive rejects stale draft save');
    const reopened = await js('openComposePanel({chatId:' + JSON.stringify(sessionId) + '}).then(()=>NativeChat.sessionInfo().ref)');
    const state = await phase('work-only-started-elsewhere');
    assert.equal(reopened, 'started-ref', 'authoritative ordinary session is opened after workOnly:false');
    assert.equal(state.calls.opens.length, 1, 'resume is not blocked by another draft selection write');
    assert.equal(state.model, '默认模型'); assert.equal(state.agent, 'Pi');
    for (const field of ['adapterId', 'modelName', 'modelLabel', 'reasoningEffort', 'thinkingLevel']) {
      assert.equal(Object.hasOwn(state.calls.opens[0], field), false, 'stale draft ' + field + ' must not override resume');
    }
    await click('#cpCancel'); await type('#nchatInput', '继续另一窗口已经启动的会话'); await click('#nchatSend');
    await until('calls.sends.length===1', 'normal send uses the restored runtime');
    assert.equal(await js('calls.sends[0].ref'), 'started-ref');
    assert.equal(await js('calls.opens.length'), 1, 'the resumed runtime stays attached');
  });
  await runCase('an old account draft response cannot replace the newly opened account conversation', async () => {
    const sessionId = await createWorkDraft();
    await js('delayWorkCards=true;window.oldNavigation=openComposePanel({chatId:' + JSON.stringify(sessionId) + '});void 0;');
    await until('Boolean(pendingWorkCards)', 'old account archive response held');
    await js("fixtureOwner='other-owner';dispatchEvent(new Event('soduwork-data-scope-changed'));openComposePanel({chatId:'history-session'}).then(()=>true)");
    await until("NativeChat.sessionInfo().ref==='history-ref'", 'new account conversation');
    await js('pendingWorkCards();oldNavigation.then(()=>true)');
    const state = await phase('old-account-read');
    assert.equal(state.model, '历史会话模型'); assert.equal(state.agent, 'Pi');
    assert.equal(state.session.ref, 'history-ref');
    assert.equal(await js("Boolean(document.querySelector('#wesTaskDraft'))"), false);
  });
  await runCase('an old account selection save cannot alter the new conversation or surface an obsolete error', async () => {
    await createWorkDraft(); await js('delaySelectionSave=true;void 0;');
    await click('#nchatModel .nmodel-button'); await click('[data-model-name="fixture-history"]');
    await until('Boolean(pendingSelectionSave)', 'held old account selection save');
    await js("fixtureOwner='other-owner';dispatchEvent(new Event('soduwork-data-scope-changed'));openComposePanel({chatId:'history-session'}).then(()=>true)");
    await until("NativeChat.sessionInfo().ref==='history-ref'", 'new account view');
    await js('notices.length=0;pendingSelectionSave();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const state = await phase('old-account-save');
    assert.equal(state.model, '历史会话模型'); assert.equal(state.agent, 'Pi');
    assert.equal(state.session.ref, 'history-ref');
    assert.deepEqual(await js('notices'), [], 'an old account save failure is not shown in the new account');
  });
  await require('./requirement-session-navigation-cases.cjs')({ runCase, js, click, until, phase, reloadPage,
    recordNavigation: sample => report.navigationTimings.push(sample) });
  report.ok = report.cases.length > 0 && report.cases.every(item => item.ok) && report.network.length === 0;
}).catch(error => { report.error = error.stack; }).finally(() => {
  win?.destroy(); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, cases: report.cases, error: report.error, report: path.join(out, 'report.json') }));
  app.exit(report.ok ? 0 : 1);
});
