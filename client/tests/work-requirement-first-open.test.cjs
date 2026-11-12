'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const sessions = require('../main/pi-session/session');
const modelConfig = require('../main/pi-session/model-config');
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
const { openReply } = require('../main/pi-session/open-reply');

const source = fs.readFileSync(path.join(__dirname, '../main/pi-session/ipc.js'), 'utf8');
const handler = source.slice(source.indexOf('  async function openConversation('),
  source.indexOf("  ipcMain.handle('pi-session-open',"));

function identity(account = 'isolated-account') {
  const now = Math.floor(Date.now() / 1000), clientId = 'isolated-device';
  const claims = Buffer.from(JSON.stringify({ typ: 'device', uid: account,
    cid: clientId, iat: now - 10, exp: now + 3600 })).toString('base64url');
  return { hub: 'http://fixture.invalid', clientId, session: claims + '.' + 'a'.repeat(64) };
}

function ipcFixture({ app, bridge, owner, cwd, task, legacy = false }) {
  const sender = { mainFrame: {}, isDestroyed: () => false,
    getURL: () => pathToFileURL(path.join(__dirname, '../desk.html')).href };
  const event = { sender, senderFrame: sender.mainFrame }, calls = [];
  const context = vm.createContext({ app, path, identityOf: async () => owner, sendIdentityOf: null,
    _sessionOwners: null, _sharedHistory: null, _discardRenderer() {},
    taskInput: { request: async (requestOwner, route) => {
      assert.equal(requestOwner.clientId, owner.clientId);
      assert.equal(requestOwner.hub, owner.hub);
      assert.equal(route, '/tasks/' + encodeURIComponent(task.id));
      return { ...task };
    } },
    session: { ...bridge, open: async options => { calls.push(options); return bridge.open(options); } },
    memories: { context: async () => ({}), attach: async () => {} },
    updateWorkloads: { guard: () => ({ ok: true }) },
    capabilities: { resolve: async () => ({ catalog: {}, selectedSkills: [], capabilityIds: [] }) },
    capabilityGrantsOf: null, _skillDirs: () => [], _newSessionCwd: () => cwd, _defaultCwd: () => cwd,
    workDir: () => cwd, attachments: { stage: async () => ({ files: [], warnings: [] }) },
    sessionSpec: require('../main/conversation/session-spec'), _conf: () => ({}),
    skillTurn: require('../main/pi-session/skill-turn'),
    BrowserWindow: { fromWebContents: () => null }, confirmFullAccess: async () => false,
    _entryContextPrompts: () => [], _awaitBounded: value => value, OPEN_TIMEOUT_MS: 45000,
    _bindUsage() {}, _attach() {}, _detach() {}, _wire() {}, _cloudHandoff: { observe() {} },
    _openReply: (handle, extra) => openReply(app, handle, extra),
    require: name => {
      const actual = require(path.join(__dirname, '../main/pi-session', name));
      if (name !== '../conversation/history-access') return actual;
      return { ...actual, actor: (app, identity = owner) => actual.actor(app, identity),
        assertCurrent: (app, captured, identity = owner) => actual.assertCurrent(app, captured, identity) };
    },
  });
  const code = legacy ? handler.replace('Boolean(opts.requireTaskBinding) && !work.bindCreatedTask',
    'Boolean(opts.requireTaskBinding)') : handler;
  if (legacy) assert.notEqual(code, handler, 'negative control must restore the original binding precondition');
  vm.runInContext(code, context, { filename: 'pi-session/ipc.openConversation.js' });
  return { calls, open: options => context.openConversation(event, options) };
}

test('real Pi first requirement opens the same work archive, persists its binding and retains the selected model', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-first-task-pi-'));
  const cwd = path.join(root, 'workspace'), agentDir = path.join(root, 'pi-agent');
  fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
  const app = { isPackaged: false, getPath: () => root }, owner = identity();
  const requests = [], models = [], prepareOptions = [];
  let rejectStaleDefault = false;
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', bytes => { raw += bytes; });
    req.on('end', () => {
      const body = JSON.parse(raw); requests.push(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ id: 'isolated-model', object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Fixture requirement complete.' }, finish_reason: null }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ id: 'isolated-model', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sdk = await import(pathToFileURL(path.join(__dirname,
    '../node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  const storageSdk = await import(pathToFileURL(path.join(__dirname,
    '../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js')).href);
  const bridge = createPiSessionBridge({ app, sessionModule: sessions, runnerAdapters: [] });
  const previous = { prepare: modelConfig.prepare, fetch: modelConfig.fetchSelection,
    create: sdk.ModelRuntime.create, key: process.env.SODUWORK_PROXY_KEY };
  let modelPath;
  const model = name => ({ id: name || 'fixture-default', label: name || 'Fixture default', contextWindow: 32000,
    input: ['text'], key: 'fixture', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    proxyExpiresAt: Date.now() + 60000 });
  process.env.SODUWORK_PROXY_KEY = 'fixture';
  modelConfig.prepare = async (_app, _owner, name, options) => {
    models.push(name);
    prepareOptions.push({ name, options: options || {} });
    if (name === 'stale-model') return { ok: false, reason: 'selected model is unavailable' };
    if (!name && rejectStaleDefault && options?.ignoreAgentPreference !== true)
      return { ok: false, reason: '你选择的模型「dev-coding-large-agent-soduwork」现在不可用，请重新选择' };
    if (name === 'mismatch-model') return { ok: true, provider: 'soduwork', agentDir,
      model: model('server-default-model') };
    const selected = model(name); modelPath = modelConfig.writeModels(agentDir, selected);
    return { ok: true, provider: 'soduwork', agentDir, model: selected };
  };
  modelConfig.fetchSelection = async (_owner, name) => ({ ok: true, model: model(name) });
  sdk.ModelRuntime.create = () => previous.create.call(sdk.ModelRuntime,
    { modelsPath: modelPath, authPath: path.join(agentDir, 'auth.json') });
  t.after(async () => {
    await bridge.dispose();
    modelConfig.prepare = previous.prepare; modelConfig.fetchSelection = previous.fetch;
    sdk.ModelRuntime.create = previous.create;
    if (previous.key === undefined) delete process.env.SODUWORK_PROXY_KEY; else process.env.SODUWORK_PROXY_KEY = previous.key;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = require('../main/conversation/work-conversation-cards').create({ app, identityOf: async () => owner,
    session: bridge, newCwd: () => cwd, loadStorageSdk: async () => storageSdk });
  const created = await store.reserve({ title: 'Isolated requirement conversation',
    draftSelection: { adapterId: 'pi', modelName: 'selected-model', modelLabel: 'Selected model' } });
  assert.equal(created.ok, true, created.reason);
  const initial = (await sessions.historyEntry(app, created.sessionId)).entry;
  assert.equal(initial.workOnly, true);
  const options = { chatId: created.sessionId, taskRef: 'first-requirement', taskTitle: 'First requirement',
    taskSession: true, requireTaskBinding: true, modelName: 'selected-model' };
  const task = { id: options.taskRef, title: options.taskTitle, ownerClientId: owner.clientId,
    status: 'todo', triageStage: 'ready' };
  const savedReceipt = await store.save(created.sessionId, { id: 'created-requirement-card',
    actionId: 'work.requirement.create', prompt: task.title, files: [],
    state: { version: 1, phase: 'succeeded', receipt: { id: task.id, title: task.title } } });
  assert.equal(savedReceipt.ok, true, savedReceipt.reason);
  const storedCards = await store.read(created.sessionId);
  assert.equal(storedCards.ok, true, storedCards.reason);
  assert.equal(storedCards.cards[0].state.receipt.id, task.id);
  const before = fs.readFileSync(initial.path);
  const old = ipcFixture({ app, bridge, owner, cwd, task, legacy: true });
  const rejected = await old.open(options);
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /这条会话不是该需求的协作会话/);
  assert.deepEqual(fs.readFileSync(initial.path), before, 'the rejected open must preserve the work archive');
  assert.equal(requests.length, 0);

  const current = ipcFixture({ app, bridge, owner, cwd, task });
  const opened = await current.open(options);
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(opened.sessionId, created.sessionId);
  assert.deepEqual(opened.taskIds, ['first-requirement']);
  assert.equal(opened.snapshot.modelSelection.name, 'selected-model');
  assert.equal(current.calls[0].resumePath, initial.path);
  const persisted = await sessions.historyEntry(app, created.sessionId);
  assert.equal(persisted.entry.path, initial.path);
  assert.deepEqual(persisted.entry.taskIds, ['first-requirement']);
  assert.equal(persisted.entry.workOnly, false);
  const saved = sdk.SessionManager.open(initial.path);
  assert.equal(saved.getSessionId(), created.sessionId);
  assert.equal(saved.getEntries().findLast(row => row.customType === 'soduwork.model.selection').data.name,
    'selected-model');
  const handle = bridge.get(opened.ref);
  const turn = handle.submit('Complete this isolated fixture requirement.', [],
    { taskId: 'first-requirement', modelName: 'selected-model' });
  assert.equal((await turn.completion).ok, true);
  assert.deepEqual(requests.map(row => row.model), ['selected-model']);
  const answer = handle.snapshot().messages.findLast(row => row.role === 'assistant');
  assert.equal(answer.done, true);
  assert.equal(answer.blocks.filter(block => block.kind === 'text').map(block => block.text).join(''),
    'Fixture requirement complete.');
  await handle.close();
  const { modelName: _selection, ...resumeOptions } = options;
  const resumed = await current.open(resumeOptions);
  assert.equal(resumed.ok, true, resumed.reason);
  assert.equal(resumed.sessionId, created.sessionId);
  assert.deepEqual(resumed.taskIds, ['first-requirement']);
  assert.equal(resumed.snapshot.modelSelection.name, 'selected-model');
  assert.equal(current.calls.at(-1).requireTaskBinding, true, 'initialized archives retain the binding guard');
  assert.equal(models.at(-1), 'selected-model', 'the resumed runtime resolves its persisted choice after prewarming');

  await bridge.get(resumed.ref).close();
  const stale = sdk.SessionManager.create(cwd, path.join(agentDir, 'sessions', 'stale'));
  // The SDK intentionally keeps metadata-only drafts in memory until the first
  // assistant response. A resume regression needs an actual persisted archive.
  stale.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Earlier fixture response.' }],
    api: 'openai-completions', provider: 'soduwork', model: 'stale-model', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  stale.appendCustomEntry('soduwork.model.selection', { name: 'stale-model' });
  const recovered = await bridge.open({ app, identity: owner, cwd,
    resumePath: stale.getSessionFile(), modelName: 'stale-model' });
  assert.equal(recovered.ok, true, recovered.reason);
  assert.deepEqual(models.slice(-2), ['stale-model', ''],
    'resuming an archive retries a stale explicit model with the current default');
  assert.equal(prepareOptions.at(-1).options.ignoreAgentPreference, true,
    'historical fallback bypasses only the stale Agent preference');
  assert.equal(sdk.SessionManager.open(stale.getSessionFile()).getEntries().findLast(row =>
    row.customType === 'soduwork.model.selection').data.name, '');
  await recovered.session.close();

  // Older archives may have no model-selection entry at all. The Hub can still
  // reject its retired Agent default, so historical recovery must retry with
  // the default preference explicitly ignored.
  rejectStaleDefault = true;
  const noSelection = sdk.SessionManager.create(cwd, path.join(agentDir, 'sessions', 'no-selection'));
  noSelection.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Archive predates model selection metadata.' }],
    api: 'openai-completions', provider: 'soduwork', model: 'legacy-model', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const noSelectionOpened = await bridge.open({ app, identity: owner, cwd,
    resumePath: noSelection.getSessionFile(), modelName: '' });
  assert.equal(noSelectionOpened.ok, true, noSelectionOpened.reason);
  assert.deepEqual(models.slice(-2), ['', ''],
    'a historical archive without model metadata retries the rejected Agent default');
  assert.equal(prepareOptions.at(-1).options.ignoreAgentPreference, true,
    'the empty historical fallback must bypass the stale Agent preference');
  await noSelectionOpened.session.close();

  const rejectedModel = await bridge.open({ app, identity: owner, cwd, modelName: 'stale-model' });
  assert.equal(rejectedModel.ok, false);
  assert.equal(models.at(-1), 'stale-model', 'new chats keep strict explicit model selection');
  assert.equal(Boolean(prepareOptions.at(-1).options.ignoreAgentPreference), false,
    'new chats never bypass an explicit model choice');

  const mismatched = sdk.SessionManager.create(cwd, path.join(agentDir, 'sessions', 'mismatch'));
  mismatched.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'A model changed on the server.' }],
    api: 'openai-completions', provider: 'soduwork', model: 'mismatch-model', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  mismatched.appendCustomEntry('soduwork.model.selection', { name: 'mismatch-model' });
  const mismatchOpened = await bridge.open({ app, identity: owner, cwd,
    resumePath: mismatched.getSessionFile(), modelName: 'mismatch-model' });
  assert.equal(mismatchOpened.ok, true, mismatchOpened.reason);
  assert.deepEqual(models.slice(-2), ['mismatch-model', ''],
    'a resumed model that resolves to another server model also falls back to the current default');
  await mismatchOpened.session.close();

  const ordinary = sdk.SessionManager.create(cwd, path.join(agentDir, 'sessions', 'ordinary'));
  ordinary.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'An existing conversation.' }],
    api: 'openai-completions', provider: 'soduwork', model: 'selected-model', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const ordinaryBefore = fs.readFileSync(ordinary.getSessionFile());
  const ordinaryOptions = { ...options, chatId: ordinary.getSessionId() };
  const unowned = await current.open(ordinaryOptions);
  assert.equal(unowned.ok, false);
  // Main migrates a native ownerless archive to its first authenticated reader,
  // but migration must not turn an unrelated conversation into this task.
  assert.match(unowned.reason, /这条会话不是该需求的协作会话/);
  assert.deepEqual(fs.readFileSync(ordinary.getSessionFile()), ordinaryBefore);

  // Native SDK archives do not persist the application's account ownership.
  // Use the real binding writer so this fixture reaches task-binding checks.
  require('../main/conversation/session-memory').bind(app, ordinary.getSessionId(), owner, [], true);
  const otherAccount = ipcFixture({ app, bridge, owner: identity('another-account'), cwd, task });
  const foreign = await otherAccount.open(ordinaryOptions);
  assert.equal(foreign.ok, false);
  assert.match(foreign.reason, /无法确认这条会话属于当前账号/);
  assert.equal(otherAccount.calls.length, 0, 'another account on this device cannot open the archived runtime');
  assert.deepEqual(fs.readFileSync(ordinary.getSessionFile()), ordinaryBefore);

  const incompatible = await current.open(ordinaryOptions);
  assert.equal(incompatible.ok, false);
  assert.match(incompatible.reason, /这条会话不是该需求的协作会话/);
  assert.deepEqual(fs.readFileSync(ordinary.getSessionFile()), ordinaryBefore);
  assert.equal(requests.length, 1, 'rejected unrelated history must never call the model');
});
