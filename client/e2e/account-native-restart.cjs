'use strict';

// Fresh Node processes exercise the production IPC opener, native registry,
// archive and SDK. Only account discovery, optional services and model HTTP
// are fixtures. This does not claim Electron rendering or a live Hub test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const client = path.resolve(__dirname, '..');
const modelId = 'restart-fixture-model';

function identity() {
  const now = Math.floor(Date.now() / 1000);
  const claims = Buffer.from(JSON.stringify({ typ: 'device', uid: 'restart-owner', cid: 'restart-device',
    iat: now - 30, exp: now + 3600 })).toString('base64url');
  return { hub: 'http://fixture.invalid', clientId: 'restart-device', session: claims + '.' + 'a'.repeat(64) };
}

async function child(stage, root, endpoint) {
  const app = { isPackaged: false, getPath: () => root };
  const actor = identity();
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const config = require('../main/pi-session/model-config');
  const agentDir = config.agentDir(app);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const sdk = await import(pathToFileURL(path.join(client, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  const model = { id: modelId, label: 'Restart regression model', contextWindow: 200000,
    baseUrl: endpoint, proxyExpiresAt: Date.now() + 3600000 };
  config.noProxyFor(endpoint);
  const modelsPath = config.writeModels(agentDir, model);
  const previousPrepare = config.prepare, previousCreate = sdk.ModelRuntime.create;
  const previousKey = process.env.SODUWORK_PROXY_KEY;
  const selections = [];
  config.prepare = async (_app, _identity, selected) => {
    selections.push(selected);
    return { ok: true, provider: 'soduwork', agentDir, model };
  };
  sdk.ModelRuntime.create = () => previousCreate.call(sdk.ModelRuntime, { modelsPath,
    authPath: path.join(agentDir, 'auth.json'), modelsStorePath: path.join(agentDir, 'models.db') });
  process.env.SODUWORK_PROXY_KEY = 'isolated-restart-fixture';
  const sessions = require('../main/pi-session/session');
  const bridge = require('../main/agent-runtime/pi-session-bridge').createPiSessionBridge({
    app, sessionModule: sessions, runnerAdapters: [],
  });
  const savedFile = path.join(root, 'native-proof.json');
  const saved = fs.existsSync(savedFile) ? JSON.parse(fs.readFileSync(savedFile, 'utf8')) : null;
  const account = saved && { id: saved.accountId, sourceSessionId: saved.sessionId,
    sourceClientId: actor.clientId, accountConversation: true, accountProjection: true,
    adapterId: 'account-sync', owner: require('../main/platform-connections/runtime.cjs').connectionScope(actor) };
  let projections = 0;
  const sender = { mainFrame: {}, isDestroyed: () => false,
    getURL: () => pathToFileURL(path.join(client, 'desk.html')).href };
  const event = { sender, senderFrame: sender.mainFrame };
  const ipcRequire = require('node:module').createRequire(path.join(client, 'main/pi-session/ipc.js'));
  const context = vm.createContext({
    app, path, session: bridge, identityOf: async () => actor, sendIdentityOf: null,
    _sharedHistory: null,
    _accountSync: {
      isAccountConversation: id => !!account && [account.id, account.sourceSessionId].includes(id),
      row: async () => account,
      async openProjection(id) {
        if (!account || ![account.id, account.sourceSessionId].includes(id)) return null;
        projections++;
        return { ref: 'account-view', sessionId: account.id, adapterId: 'account-sync', readOnly: true,
          historyRow: () => account, close: async () => true,
          snapshot: () => ({ adapterId: 'account-sync', messages: [], readOnly: true }) };
      },
    },
    _cloudHandoff: { observe() {} },
    memories: { context: async () => ({}),
      async attach(handle, auth, _memory, _warnings, options) {
        const memory = require('../main/conversation/session-memory');
        if (!options.resumed) memory.bind(app, handle.sessionId, auth, [], true);
        else memory.binding(app, handle.sessionId, auth);
      },
      assertOwner(auth, id) { require('../main/conversation/session-memory').binding(app, id, auth); } },
    updateWorkloads: { guard: () => ({ ok: true }) },
    capabilities: { resolve: async () => ({ catalog: {}, selectedSkills: [], capabilityIds: [], skills: [], capabilities: [] }) },
    capabilityGrantsOf: null, _skillDirs: () => [],
    _newSessionCwd: () => cwd, _defaultCwd: () => cwd, workDir: () => root,
    attachments: require('../main/pi-session/attachments'),
    sessionSpec: require('../main/conversation/session-spec'),
    skillTurn: require('../main/pi-session/skill-turn'),
    pluginGrant: require('../main/pi-session/plugin-grant'),
    taskInput: { request: async () => { throw Error('Unexpected Hub request'); } },
    _conf: () => ({}), BrowserWindow: { fromWebContents: () => ({}) },
    confirmFullAccess: async () => false, _entryContextPrompts: () => [],
    _awaitBounded: value => value, OPEN_TIMEOUT_MS: 45000,
    _sessionOwners: { bind() {}, quarantine() {}, closed() {} },
    _bindUsage() {}, _attach() {}, _detach() {}, _wire() {}, _discardRenderer() {}, _clearRelease() {},
    _openReply: (handle, extra) => require('../main/pi-session/open-reply').openReply(app, handle, extra),
    require(name) {
      const actual = ipcRequire(name);
      if (name !== '../conversation/history-access') return actual;
      return { ...actual, actor(app, value) { return actual.actor(app, value === undefined ? actor : value); } };
    },
  });
  const source = fs.readFileSync(path.join(client, 'main/pi-session/ipc.js'), 'utf8');
  const openStart = source.indexOf('  async function openConversation(');
  const openEnd = source.indexOf("  ipcMain.handle('pi-session-open',");
  assert.ok(openStart >= 0 && openEnd > openStart, 'the fixture must execute the current production IPC opener');
  vm.runInContext(source.slice(openStart, openEnd), context, { filename: 'production-ipc-open.js' });
  try {
    assert.equal(bridge.list().length, 0, 'each phase starts with a fresh native registry');
    const raw = stage === 'create' ? { adapterId: 'pi', modelName: modelId, accessMode: 'standard', cwd }
      : { chatId: stage === 'account' ? saved.accountId : saved.sessionId,
          adapterId: 'account-sync', accountConversation: true, accountProjection: true };
    const reply = await context.openConversation(event, raw);
    assert.equal(reply.ok, true, reply.reason);
    assert.equal(reply.adapterId, 'pi', 'same-device history must resume its native runtime');
    assert.equal(reply.model?.id, modelId, 'the saved model must remain selected');
    assert.equal(reply.snapshot.accessPolicy.mode, 'standard');
    assert.equal(reply.snapshot.modelSelection.name, modelId);
    assert.equal(projections, 0, 'verified native ownership must bypass account projection creation');
    const handle = bridge.get(reply.ref);
    assert.ok(handle && !handle.localReplica && typeof handle.submit === 'function');
    if (saved) {
      assert.equal(reply.sessionId, saved.sessionId);
      assert.ok(JSON.stringify(reply.snapshot.messages).includes('Saved native answer 1'));
    }
    const text = 'Restart regression ' + stage + ': reply with the saved native answer.';
    const result = await handle.submit(text, [], {}).completion;
    assert.equal(result.ok, true, result.reason);
    const found = await sessions.historyEntry(app, reply.sessionId, { strict: true });
    assert.equal(found.ok, true, found.reason);
    const bytes = fs.readFileSync(found.entry.path, 'utf8');
    assert.ok(bytes.includes(text));
    if (saved) {
      assert.equal(found.entry.path, saved.path, 'continuation appends to the same archive');
      assert.ok(bytes.startsWith(fs.readFileSync(path.join(root, 'initial-archive.jsonl'), 'utf8')));
    } else {
      const proof = { sessionId: reply.sessionId, accountId: 'acct-restart-fixture', path: found.entry.path };
      fs.writeFileSync(savedFile, JSON.stringify(proof));
      fs.writeFileSync(path.join(root, 'initial-archive.jsonl'), bytes);
      const sameProcess = await context.openConversation(event, { chatId: reply.sessionId });
      assert.equal(sameProcess.ref, reply.ref, 'live reattachment must remain a single runtime');
    }
    // An optional default-model prewarm precedes archive hydration. The final
    // preparation and every actual inference must use the persisted selection.
    assert.equal(selections.at(-1), modelId);
    assert.ok(selections.every(value => value === '' || value === modelId));
    const historyMessages = handle.snapshot().messages.length;
    assert.equal(historyMessages, (['create', 'account', 'source'].indexOf(stage) + 1) * 2,
      'each resumed turn must retain prior history and append exactly one user and assistant message');
    fs.writeFileSync(path.join(root, stage + '-result.json'), JSON.stringify({ ok: true,
      stage, pid: process.pid, nativeId: reply.sessionId, adapterId: reply.adapterId,
      model: reply.model.id, permission: reply.snapshot.accessPolicy.mode, projections,
      historyMessages }));
  } finally {
    await bridge.dispose();
    config.prepare = previousPrepare; sdk.ModelRuntime.create = previousCreate;
    if (previousKey === undefined) delete process.env.SODUWORK_PROXY_KEY;
    else process.env.SODUWORK_PROXY_KEY = previousKey;
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-account-native-restart-'));
  const reportPath = process.env.SODUWORK_RESTART_REPORT || path.resolve(client, '../outputs/account-native-restart/report.json');
  const requests = [], sockets = new Set();
  const server = http.createServer((request, response) => {
    let raw = ''; request.setEncoding('utf8'); request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      try {
        const body = JSON.parse(raw); requests.push(body);
        assert.equal(body.model, modelId);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const row = (delta, finish_reason, usage) => 'data: ' + JSON.stringify({
          id: 'restart-' + requests.length, object: 'chat.completion.chunk', model: modelId,
          choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) }) + '\n\n';
        response.write(row({ role: 'assistant', content: 'Saved native answer ' + requests.length + '. The isolated request is complete.' }, null));
        response.end(row({}, 'stop', { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 }) + 'data: [DONE]\n\n');
      } catch (error) { response.writeHead(500); response.end(String(error)); }
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const report = { ok: false, cases: [], boundary: 'Three fresh Node processes, production IPC open/native registry/archive/SDK and loopback model HTTP. Account projection and optional services are fixtures; no Electron renderer, live Hub, business data or paid model.' };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1';
    for (const stage of ['create', 'account', 'source']) {
      await new Promise((resolve, reject) => {
        const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
        for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) delete env[key];
        const proc = spawn(process.execPath, [__filename, '--child', stage, root, endpoint], { env, stdio: 'inherit', windowsHide: true });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; proc.kill(); }, 120000);
        proc.once('error', error => { clearTimeout(timer); reject(error); });
        proc.once('exit', code => {
          clearTimeout(timer);
          if (timedOut) reject(Error(stage + ' exceeded 120 seconds'));
          else if (code === 0) resolve();
          else reject(Error(stage + ' exited ' + code));
        });
      });
      report.cases.push(JSON.parse(fs.readFileSync(path.join(root, stage + '-result.json'), 'utf8')));
    }
    assert.equal(new Set(report.cases.map(row => row.pid)).size, 3);
    assert.equal(new Set(report.cases.map(row => row.nativeId)).size, 1);
    assert.equal(requests.length, 3, 'exactly one model request per explicit user turn');
    assert.ok(JSON.stringify(requests[1].messages).includes('Saved native answer 1'));
    assert.ok(JSON.stringify(requests[2].messages).includes('Saved native answer 2'));
    report.modelRequests = requests.length; report.ok = true;
  } catch (error) { report.error = error.stack || String(error); throw error; }
  finally {
    try {
      server.closeAllConnections(); for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
    } finally {
      assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

(process.argv[2] === '--child' ? child(...process.argv.slice(3)) : main())
  .catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
