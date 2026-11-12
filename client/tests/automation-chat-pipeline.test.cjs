const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

test('automation and UI really call the same chat open/send pipeline; internal completion stays out of IPC', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-chat-pipeline-test-'));
  const archivePath = path.join(directory, 'pi-agent', 'sessions', 'archived-chat.jsonl');
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, JSON.stringify({ type: 'message', message: {
    role: 'assistant', content: [{ type: 'text', text: 'Shared local history' }] } }) + '\n');
  const file = path.resolve(__dirname, '../main/pi-session/ipc.js'), realRequire = createRequire(file);
  const handlers = new Map(), handles = [], opens = [], submits = [], quit = [], warms = [];
  let identity = { ...require('./helpers/platform-session-fixture.cjs').identity(), hub: 'http://isolated.invalid' };
  const auth = require('../main/device-auth'), savedAuth = {};
  let trustedOwner = require('../main/platform-connections/runtime.cjs').scope(identity);
  for (const key of ['identity', 'session', 'profiles', 'localOwner']) savedAuth[key] = auth[key];
  auth.identity = () => identity; auth.session = () => identity.session; auth.profiles = () => [];
  auth.localOwner = () => trustedOwner;
  const owner = { isDestroyed: () => false, once() {}, removeListener() {} };
  const frame = {}, event = { senderFrame: frame, sender: { mainFrame: frame,
    isDestroyed: () => false, getURL: () => pathToFileURL(path.resolve(__dirname, '../desk.html')).href + '?panel=workspace' } };
  const sessions = { async prewarm(_app, _identity, modelName) { warms.push(modelName); return { ok: true }; }, async open(options) {
    opens.push(options);
    const handle = { ref: options.ref, sessionId: 'ordinary-' + handles.length, cwd: options.cwd,
      on(listener) { this.listener = listener; }, close() {}, snapshot: () => ({ messages: [] }), inFlight: () => false, status: () => 'idle',
      submit(text, files, opts) { submits.push({ text, files, opts }); return { accepted: true, completion: Promise.resolve({ ok: true }) }; } };
    handles.push(handle); return { ok: true, session: handle };
  }, list: () => handles, closeAll() {}, get: ref => handles.find(x => x.ref === ref),
  findBySessionId: id => handles.find(x => x.sessionId === id),
  attachView(view) { handles.push(view); return view; },
  historyEntry: async (_app, id) => ({ ok: true, entry: id === 'archived-chat'
    ? { id, path: archivePath, cwd: directory, at: 42 } : null }),
  history: async () => { throw Error('Opening an identity must not scan the sidebar'); },
  archivedConversation: async (_app, id) => id === 'archived-chat'
    ? { id, path: archivePath, cwd: directory, adapterId: 'pi', at: 42 }
    : id.startsWith('archived-agent:')
      ? { id, path: 'verified.jsonl', cwd: directory, adapterId: id.slice('archived-agent:'.length), at: 42 } : null };
  const mocks = {
    electron: { shell: {}, clipboard: {}, nativeImage: {}, dialog: {} },
    '../agent-runtime/pi-session-bridge': sessions,
    '../conversation/capabilities': { inspect: async () => ({ policyOk: true, items: [], businessSkills: [] }),
      resolve: async () => ({ catalog: { businessSkills: [] }, selectedSkills: [],
      capabilityIds: [], capabilities: [], skills: [], skillDirs: [], warnings: [] }) },
    '../conversation/skill-roots': { discover: () => [], discoverAsync: async () => [] },
    '../agent-runtime/usage-reporter': { createUsageReporter: () => ({ flush: async () => {}, observe() {} }) },
    '../conversation/artifact-runtime': { closeAll() {}, closeRef() {} },
    '../update-workloads': { guard: () => ({ ok: true }) },
    './attachments': { stage: async (_cwd, files) => ({ files: files || [], warnings: [] }), prompt: () => '' },
  };
  // Extracted handlers share test doubles; never boot/download actual Electron in unit tests.
  const environmentFile = path.join(path.dirname(file), 'environment-ipc.js');
  const environment = { exports: {} };
  vm.runInNewContext(fs.readFileSync(environmentFile, 'utf8'), {
    module: environment, exports: environment.exports, setTimeout, clearTimeout,
    require: name => mocks[name] || realRequire(name),
  }, { filename: environmentFile });
  mocks['./environment-ipc'] = environment.exports;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, require: name => mocks[name] || realRequire(name),
    console, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval }, { filename: file });
  try {
    const service = module.exports.install({
      app: { getPath: () => directory, on: (name, listener) => { if (name === 'before-quit') quit.push(listener); } },
      ipcMain: { handle: (name, listener) => handlers.set(name, listener), on() {} },
      BrowserWindow: { fromWebContents: () => owner, getAllWindows: () => [] }, identityOf: async () => identity,
    });
    assert.equal(typeof service.captureAutomationAccess, 'function', 'manual runs must use a main-process preference source');
    assert.equal(typeof service.openAutomation, 'function', 'worker access context needs a dedicated non-IPC entry');
    assert.equal(typeof handlers.get('pi-session-automation-open'), 'function',
      'immediate automation openings need an identity-bound IPC entry');
    const automated = await service.open({ adapterId: 'pi', intent: 'chat', projectId: 'project-1', repoId: 'repo-1' }, identity);
    assert.equal(automated.ok, true, automated.reason); assert.equal(automated.collaboration, false); assert.equal(handles[0].detached, true);
    assert.equal(opens[0].projectId, 'project-1'); assert.equal(opens[0].repoId, 'repo-1');
    const first = await service.send(automated.ref, '完整自动化说明', [], { submissionId: 'automation-run', projectId: 'project-1', repoId: 'repo-1' });
    assert.equal(first.ok, true); assert.equal((await first.completion).ok, true);
    assert.equal(submits[0].opts.projectId, 'project-1'); assert.equal(submits[0].opts.repoId, 'repo-1');
    const ordinary = await handlers.get('pi-session-open')(event, { adapterId: 'pi', intent: 'chat' });
    assert.equal(ordinary.ok, true); assert.equal(handles[1].detached, false); assert.equal(handles[1].attachedWindow, owner);
    assert.doesNotThrow(() => handles[1].listener({ kind: 'settled' }, handles[1].snapshot()),
      'structural runtime events must still publish after IPC module extraction');
    assert.equal(handlers.get('pi-session-goal-action')({}, ordinary.ref, 'continue').ok, false,
      'unsupported goal controls remain safely rejected by the extracted handler');
    const second = await handlers.get('pi-session-send')({ sender: {} }, ordinary.ref, '普通用户消息', [], {});
    assert.equal(second.ok, true); assert.equal(second.completion, undefined);
    const reattached = await handlers.get('pi-session-open')(event, { chatId: automated.sessionId });
    assert.equal(reattached.sessionId, automated.sessionId); assert.equal(handles[0].attachedWindow, owner);
    const followup = await handlers.get('pi-session-send')({ sender: {} }, automated.ref, '继续分析', [], {});
    assert.equal(followup.ok, true); assert.equal(submits.length, 3);
    assert.ok(opens.every(x => !x.taskRef && !x.intent));
    assert.ok(submits.every(x => !x.opts.taskId && !x.opts.controlled));
    assert.equal((await service.open({}, { ...identity, clientId: 'wrong' })).ok, false);
    // An archive can carry an imported-memory binding while the device session
    // is expired. The transcript must still reopen; memory is optional.
    const now = Math.floor(Date.now() / 1000);
    const claims = Buffer.from(JSON.stringify({ typ: 'device', uid: 'user-1', cid: 'device', iat: now - 3600, exp: now + 3600 })).toString('base64url');
    const ownerSession = claims + '.' + 'a'.repeat(64);
    const expiredClaims = Buffer.from(JSON.stringify({ typ: 'device', uid: 'user-1', cid: 'device', iat: now - 7200, exp: now - 60 })).toString('base64url');
    const bindingFile = path.join(directory, 'session-memory-bindings', crypto.createHash('sha256').update('archived-chat').digest('hex') + '.json');
    fs.mkdirSync(path.dirname(bindingFile), { recursive: true });
    const bindingOwner = require('../main/platform-connections/runtime.cjs').scope({ ...identity, session: ownerSession });
    fs.writeFileSync(bindingFile, JSON.stringify({ owner: bindingOwner, ids: ['memory-id'] }));
    trustedOwner = bindingOwner;
    identity = { ...identity, session: expiredClaims + '.' + 'b'.repeat(64) };
    const archived = await handlers.get('pi-session-open')(event, { chatId: 'archived-chat' });
    assert.equal(archived.ok, true, archived.reason);
    assert.equal(archived.resumed, true);
    assert.equal(opens.at(-1).resumePath, archivePath);
    assert.equal(opens.at(-1).resumeAt, 42);
    const count = opens.length;
    const missing = await handlers.get('pi-session-open')(event, { chatId: 'missing-chat' });
    assert.equal(missing.ok, false);
    assert.equal(missing.notFound, true, 'only a verified missing archive permits empty task draft recovery');
    assert.equal(opens.length, count, 'missing history must never create a replacement conversation');
    identity = { ...identity, session: require('./helpers/platform-session-fixture.cjs').sessions().two };
    trustedOwner = require('../main/platform-connections/runtime.cjs').scope(identity);
    const foreign = await handlers.get('pi-session-open')(event, { chatId: 'archived-chat' });
    assert.equal(foreign.ok, true, foreign.reason);
    assert.equal(foreign.localReplica, true);
    assert.equal(handles.at(-1).readOnly, true);
    assert.equal(handles.at(-1).snapshot().messages[0].text, 'Shared local history');
    assert.equal(opens.length, count, 'shared local reads must not resume another account runtime');
    const foreignSend = await handlers.get('pi-session-send')({ sender: {} }, foreign.ref, 'Must not execute', [], {});
    assert.equal(foreignSend.ok, false);
    // Exercise the registered production entry points. Loading a capability
    // menu or opening a Runner-backed chat must not initialize an unrelated Pi.
    const adapters = ['pi', 'opencode', 'codex', 'codex-harness', 'claude', 'qwen', 'dsh', 'custom-example'];
    for (const adapterId of adapters) {
      require('../main/conversation/session-memory').bind({ getPath: () => directory },
        'archived-agent:' + adapterId, identity, [], true);
      let before = warms.length;
      const catalog = await handlers.get('conversation-capabilities')(event,
        { adapterId, modelName: 'selected-model', executionLocation: 'local' });
      assert.equal(catalog.ok, true);
      assert.equal(warms.length - before, adapterId === 'pi' ? 1 : 0, adapterId + ' capability menu');
      if (adapterId === 'pi') assert.equal(warms.at(-1), 'selected-model');

      before = warms.length;
      const newChat = await handlers.get('pi-session-open')(event, { adapterId, modelName: 'selected-model' });
      assert.equal(newChat.ok, true, newChat.reason);
      assert.equal(warms.length - before, adapterId === 'pi' ? 1 : 0, adapterId + ' new chat');

      before = warms.length;
      const history = await handlers.get('pi-session-open')(event,
        { chatId: 'archived-agent:' + adapterId, adapterId: adapterId === 'pi' ? 'opencode' : 'pi' });
      assert.equal(history.ok, true, history.reason);
      assert.equal(opens.at(-1).adapterId, adapterId, 'archived runtime must override stale composer choice');
      assert.equal(warms.length - before, adapterId === 'pi' ? 1 : 0, adapterId + ' archived chat');
    }
    const beforeCatalog = warms.length;
    for (const options of [undefined, { force: true }, { adapterId: 'pi', executionLocation: 'cloud' }]) {
      assert.equal((await handlers.get('conversation-capabilities')(event, options)).ok, true);
    }
    assert.equal(warms.length, beforeCatalog, 'generic settings and cloud menus must not warm local Pi');
    const beforeDefault = warms.length;
    assert.equal((await handlers.get('pi-session-open')(event, {})).ok, true);
    assert.equal(warms.length, beforeDefault + 1, 'legacy unspecified new chats still default to Pi');
  } finally {
    await Promise.all(quit.map(fn => fn()));
    Object.assign(auth, savedAuth); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('automation turns bypass the interactive plugin-debug bridge', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../main/pi-session/ipc.js'), 'utf8');
  assert.match(source, /const automationTurn = rawOptions\?\.source === 'automation'/);
  assert.match(source, /const debugBlocked = automationTurn \? '' : pluginDebug\.guard\(s\)/);
  assert.match(source, /workflowTurn = automationTurn \? null/);
});
