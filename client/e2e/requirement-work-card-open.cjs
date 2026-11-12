'use strict';

// Real native work-card storage, production openConversation, and Pi runtime in
// Electron utilityProcess. Only UI hosts, optional memory/capabilities and the
// loopback Hub responses are fixtures. No inference request or user profile
// is opened, including implicit gateway warmup.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env, PI_TELEMETRY: '0'};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)],
    {env, windowsHide: true, stdio: 'inherit', timeout: 120000});
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const {app} = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), vm = require('node:vm'), assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-requirement-open-'));
const profile = path.join(root, 'profile'), cwd = path.join(root, 'workspace');
fs.mkdirSync(profile); fs.mkdirSync(cwd);
const output = path.resolve(process.argv[2] || path.join(__dirname, '../../outputs/requirement-work-card-open'));
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', profile); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const report = {ok: false, root, cases: [], requests: [], modelRequests: 0,
  boundary: 'Production reserve/save, openConversation and utilityProcess Pi session; real temporary JSONL archive and loopback Hub/model configuration. No inference request, implicit warmup, user profile or business data is permitted.'};
const originalFetch = global.fetch;
let server, hub, current, runtime, bridge, controller, archive, sessionId, sharedHistory;
const taskId = 'isolated-created-requirement';
function identity() {
  const now = Math.floor(Date.now() / 1000);
  return {hub, clientId: 'work-card-fixture-device',
    session: Buffer.from(JSON.stringify({typ: 'device', uid: 'work-card-fixture-user',
      cid: 'work-card-fixture-device', iat: now - 10, exp: now + 3600})).toString('base64url') + '.' + 'a'.repeat(64)};
}
async function bounded(promise, label, timeout = 45000) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error('Timed out: ' + label)), timeout);
  })]); } finally { clearTimeout(timer); }
}
function entries() { return fs.readFileSync(archive, 'utf8').trim().split('\n').map(JSON.parse); }
function bindings() { return entries().filter(row => row.type === 'custom' && row.customType === 'soduwork.task.binding'); }
function createRuntime() {
  const {createHostAuth} = require('../main/agent-runtime/process-auth');
  runtime = require('../main/agent-runtime/process-session').createProcessSession({
    authFactory: options => createHostAuth({...options, identityOf: async () => current,
      deviceAuth: {ensureSession: async () => current.session},
      fetchImpl: (url, init) => global.fetch(url, init)}),
  });
  bridge = require('../main/agent-runtime/pi-session-bridge').createPiSessionBridge({
    app, sessionModule: runtime, runnerAdapters: [],
  });
  sharedHistory = require('../main/conversation/shared-history.cjs').create({app, session: bridge});
  bridge.setReplicaHistory(sharedHistory);
  controller = require('../main/conversation/work-conversation-cards').create({app,
    identityOf: async () => current, newCwd: () => cwd,
    session: {...runtime, archivedConversation: async (targetApp, id) =>
      (await runtime.historyEntry(targetApp, id)).entry || null},
  });
}
function openHarness() {
  // Same production function extraction used by access-open.test.cjs. Runtime,
  // archive/owner/task validation and session-open remain production modules.
  const ipcPath = path.resolve(__dirname, '../main/pi-session/ipc.js');
  const localRequire = createRequire(ipcPath), source = fs.readFileSync(ipcPath, 'utf8');
  const start = source.indexOf('  async function openConversation(');
  const end = source.indexOf("  ipcMain.handle('pi-session-open',", start);
  assert(start >= 0 && end > start);
  const sender = {mainFrame: {}, isDestroyed: () => false,
    getURL: () => require('node:url').pathToFileURL(path.resolve(__dirname, '../desk.html')).href};
  const event = {sender, senderFrame: sender.mainFrame};
  const context = vm.createContext({app, path, console, setTimeout, clearTimeout,
    require: name => {
      const value = localRequire(name);
      // Only the account transport is a fixture; retain production ownership checks.
      return name === '../conversation/history-access' ? {...value, actor: target => value.actor(target, current)} : value;
    }, session: bridge, identityOf: async () => current, sendIdentityOf: null,
    _sharedHistory: sharedHistory, _sessionOwners: null,
    taskInput: localRequire('./task-input'), skillTurn: localRequire('./skill-turn'),
    sessionSpec: localRequire('../conversation/session-spec'),
    memories: {context: async () => ({}), attach: async () => {},
      assertOwner: (owner, id) => localRequire('../conversation/session-memory').binding(app, id, owner)},
    updateWorkloads: {guard: () => ({ok: true})},
    capabilities: {resolve: async () => ({catalog: {}, selectedSkills: [], capabilityIds: [], skills: [], capabilities: []})},
    capabilityGrantsOf: null, _skillDirs: () => [], _newSessionCwd: () => cwd, _defaultCwd: () => cwd,
    workDir: () => cwd, attachments: {stage: async () => ({files: [], warnings: []})},
    _conf: () => ({mode: 'readonly'}), BrowserWindow: {fromWebContents: () => null},
    confirmFullAccess: async () => {throw Error('This readonly fixture must not request full access');},
    _entryContextPrompts: () => [], _awaitBounded: value => value, OPEN_TIMEOUT_MS: 45000,
    _bindUsage() {}, _attach() {}, _detach() {}, _wire() {}, _cloudHandoff: {observe() {}},
    _openReply: handle => ({ok: true, ref: handle.ref, sessionId: handle.sessionId,
      taskIds: handle.taskIds, taskBindings: handle.taskBindings, snapshot: handle.snapshot()}),
  });
  vm.runInContext(source.slice(start, end), context, {filename: ipcPath});
  return taskRef => context.openConversation(event, {chatId: sessionId, adapterId: 'pi',
    taskRef, taskTitle: 'Isolated created requirement', taskSession: true,
    requireTaskBinding: true, accessMode: 'readonly', loadExtensions: false});
}

app.whenReady().then(async () => {
  server = http.createServer((request, response) => {
    const route = new URL(request.url, 'http://127.0.0.1').pathname;
    report.requests.push({method: request.method, route});
    response.setHeader('Content-Type', 'application/json');
    if (route.includes('/chat/completions')) {
      report.modelRequests++;
      response.statusCode = 500;
      response.end(JSON.stringify({detail: 'Inference requests are forbidden in this fixture'}));
      return;
    }
    if (request.method === 'GET' && /^\/api\/v1\/tasks\/[^/]+$/.test(route)) {
      response.end(JSON.stringify({id: route.split('/').at(-1), status: 'todo', ownerClientId: current.clientId}));
    } else if (request.method === 'GET' && route === '/api/v1/ai-proxy/config') {
      response.end(JSON.stringify({ok: true, key: 'isolated-unused-model-ticket', model: 'work-card-fixture',
        label: 'Isolated no-turn fixture', expiresIn: 3600, path: '/api/v1/ai-proxy/v1',
        contextWindow: 32000, maxOutputTokens: 1024, input: ['text'], reasoning: false}));
    } else if (request.method === 'GET' && /^\/api\/v1\/conversations\/[^/]+\/media$/.test(route)) {
      response.end('{"items":[]}');
    } else {
      response.statusCode = 500; response.end(JSON.stringify({detail: 'Undeclared fixture route: ' + route}));
    }
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  hub = 'http://127.0.0.1:' + server.address().port; current = identity();
  global.fetch = (url, init) => {
    assert.equal(new URL(url).origin, hub, 'Only this test-owned loopback Hub is allowed');
    return originalFetch(url, init);
  };
  createRuntime();
  const made = await bounded(controller.reserve({title: 'Isolated requirement work card'}), 'reserve work card');
  assert.equal(made.ok, true, made.reason); assert.equal(made.workOnly, true);
  sessionId = made.sessionId;
  const found = await runtime.historyEntry(app, sessionId);
  archive = found.entry.path;
  assert.equal(found.entry.workOnly, true); assert.deepEqual(bindings(), []);
  assert.equal(report.requests.length, 0, 'Reservation must not contact the Hub or a model');
  const saved = await controller.save(sessionId, {id: 'isolated-create-card', actionId: 'work.requirement.create',
    prompt: 'Create an isolated requirement', seed: {}, files: [], closed: false,
    state: {phase: 'succeeded', receipt: {id: taskId}}});
  assert.equal(saved.ok, true, saved.reason);
  const persistedCard = (await controller.read(sessionId)).cards[0];
  assert.equal(persistedCard.state.receipt.id, taskId);
  assert.deepEqual(bindings(), [], 'Saving a receipt does not forge a native execution binding');
  report.reservation = {sessionId, archive, workOnly: found.entry.workOnly,
    workOwner: found.entry.workOwner, card: persistedCard};
  report.cases.push('Production reserve/save creates real owner-scoped work-only JSONL and a persisted successful task receipt without a model or native task binding.');

  const before = fs.readFileSync(archive);
  const denied = await bounded(openHarness()('isolated-other-task'), 'reject unrelated task before first open');
  assert.equal(denied.ok, false, 'A successful receipt for task A cannot authorize task B');
  assert.match(denied.reason, /需求|会话|绑定/);
  assert(fs.readFileSync(archive).equals(before), 'Refused open leaves the native archive unchanged');
  report.denied = {ok: denied.ok, reason: denied.reason};
  report.cases.push('The same owned draft rejects a different task before execution; its archive remains byte-identical.');

  const opened = await bounded(openHarness()(taskId), 'first Pi open from successful work card');
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(opened.sessionId, sessionId);
  assert.deepEqual(opened.taskIds, [taskId]);
  assert.equal(bindings().length, 1);
  assert.equal(bindings()[0].data.activeTaskId, taskId);
  assert.deepEqual(bindings()[0].data.tasks.map(task => task.taskId), [taskId]);
  assert(entries().every(row => row.type !== 'message'), 'Opening must not send a model message');
  const worker = runtime.diagnostics(app);
  assert.equal(worker.transport, 'utilityProcess'); assert.notEqual(worker.pid, process.pid);
  report.firstOpen = {sessionId, taskIds: opened.taskIds, workerPid: worker.pid, binding: bindings()[0]};
  fs.copyFileSync(archive, path.join(output, 'first-open-archive.jsonl'));
  report.cases.push('Production IPC first open authorizes the saved receipt against loopback Hub, opens the real Pi archive in utilityProcess and persists exactly one task binding.');

  await bridge.dispose(); await sharedHistory.close(); await runtime.dispose(); createRuntime();
  const reopened = await bounded(openHarness()(taskId), 'cold reopen from persisted binding');
  assert.equal(reopened.ok, true, reopened.reason); assert.equal(reopened.sessionId, sessionId);
  assert.deepEqual(reopened.taskIds, [taskId]);
  // Resume appends an archival binding event; each durable task collection must
  // still contain the original task exactly once, with no unrelated identity.
  assert.deepEqual(bindings().at(-1).data.tasks.map(task => task.taskId), [taskId]);
  assert.equal(bindings().at(-1).data.activeTaskId, taskId);
  await bridge.dispose(); await sharedHistory.close(); await runtime.dispose(); createRuntime();
  const beforeColdDenied = fs.readFileSync(archive);
  const coldDenied = await bounded(openHarness()('isolated-other-task'), 'cold reopen rejects another task');
  assert.equal(coldDenied.ok, false); assert.match(coldDenied.reason, /需求|会话|绑定/);
  assert(fs.readFileSync(archive).equals(beforeColdDenied), 'Denied cold open preserves the bound archive');
  assert.deepEqual(bindings().at(-1).data.tasks.map(task => task.taskId), [taskId]);
  report.coldReopen = {sessionId: reopened.sessionId, taskIds: reopened.taskIds, otherTaskReason: coldDenied.reason};
  report.cases.push('A fresh runtime reopens the original task from its durable binding without duplicates and still rejects another task.');
  assert.equal(report.modelRequests, 0, 'Opening or restoring a task must not submit inference or warmup requests');
  assert(entries().every(row => row.type !== 'message'));
  assert(report.requests.some(row => row.route === '/api/v1/tasks/' + taskId));
  fs.copyFileSync(archive, path.join(output, 'verified-archive.jsonl'));
  report.ok = true;
}).catch(error => {report.error = String(error.stack || error);}).finally(async () => {
  await Promise.resolve(bridge?.dispose()).catch(error => {report.cleanupError = error.message; report.ok = false;});
  await Promise.resolve(sharedHistory?.close()).catch(error => {report.cleanupError = error.message; report.ok = false;});
  await Promise.resolve(runtime?.dispose()).catch(error => {report.cleanupError = error.message; report.ok = false;});
  if (server) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
  if (report.modelRequests !== 0) {
    report.ok = false;
    report.error ||= 'Business model requests reached the loopback fixture: ' + report.modelRequests;
  }
  global.fetch = originalFetch;
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({...report, output}, null, 2));
  app.exit(report.ok ? 0 : 1);
});
