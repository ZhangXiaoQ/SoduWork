'use strict';

// Real Electron + real Pi SDK + local SSE/tool execution. The production app
// entrypoint, account store, business Hub and paid models are never opened.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env, PI_TELEMETRY: '0' };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  const args = [__filename, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
  if (process.platform === 'linux' && !env.DISPLAY) args.push('--ozone-platform=headless');
  const result = require('node:child_process').spawnSync(electron, args, {
    env, windowsHide: true, stdio: 'inherit', timeout: 180000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const assert = require('node:assert/strict');
// Windows TEMP can use an 8.3 alias; permission targets use canonical paths.
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runtime-process-e2e-')));
const profile = path.join(root, 'profile'), cwd = path.join(root, 'workspace');
fs.mkdirSync(profile); fs.mkdirSync(cwd);
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
process.env.PI_TELEMETRY = '0';
const report = { ok: false, cases: [], root,
  boundary: 'Real isolated Electron main, BrowserWindow, utilityProcess, production Pi session/SDK and write tool. Auth/config and model SSE are loopback fixtures. No production app, account, business data or paid model.' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let runtime, bridge, win, server, handle, heartbeat, ticks = 0, mode = 'normal';
const requests = [], held = new Set(), serverErrors = [], rendererErrors = [], authCalls = [];
const grantCounts = { connectors: { issued: 0, cleaned: 0 }, plugins: { issued: 0, cleaned: 0 } };
const fixtureProcesses = new Map(), cleanupObservations = [];
const failCleanupOnce = new Set();
const approvalTarget = path.join(root, 'approval-outside-workspace.txt');
const parentEnvironment = Object.fromEntries(['SODUWORK_PROXY_KEY', 'SODUWORK_MCP_KEY', 'PI_CODING_AGENT_DIR', 'NO_PROXY', 'no_proxy']
  .map(key => [key, process.env[key]]));
const originalSpawn = require('node:child_process').spawn;
function stage(name) { report.stage = name; console.log('[runtime-process] ' + name); }
async function processIdentity(pid) {
  if (process.platform === 'linux') {
    try {
      const value = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      const fields = value.slice(value.lastIndexOf(')') + 1).trim().split(/\s+/);
      return ['Z', 'X'].includes(fields[0]) ? null : fields[19];
    } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
  }
  try { return (await require('../main/pi-session/mcp-process-tree').snapshot(pid)).find(row => row.pid === pid)?.created || null; }
  catch (error) { if (error.code === 1) return null; throw error; }
}
async function ownFixtureProcess(pid) {
  assert.ok(Number.isInteger(pid) && pid > 1 && pid !== process.pid);
  const identity = await processIdentity(pid); assert.ok(identity, 'fixture process must be alive before ownership is recorded');
  fixtureProcesses.set(pid, identity);
}
async function until(check, label, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  throw Error('Timed out: ' + label);
}
async function bounded(promise, label, timeoutMs = 15000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('Timed out: ' + label)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
function text(snapshot) {
  return (snapshot.messages || []).map(message => message.text ||
    (message.blocks || []).filter(block => block.kind === 'text').map(block => block.text || '').join('')).join('\n');
}
function assertMainHasNoSdk() {
  const loaded = Object.keys(require.cache).filter(file =>
    /[/\\]pi-session[/\\](?:session|session-open|sdk-loader)\.js$/.test(file) ||
    /[/\\]@earendil-works[/\\]pi-(?:coding-agent|ai|agent-core)[/\\]/.test(file));
  assert.deepEqual(loaded, [], 'SDK and execution modules must not load into Electron main');
  for (const [key, value] of Object.entries(parentEnvironment))
    assert.equal(process.env[key], value, 'worker must not mutate main environment: ' + key);
  assert.equal(require('node:child_process').spawn, originalSpawn, 'SDK process wrappers must remain in the worker');
}
function frame(response, delta, finish_reason = null, usage) {
  response.write('data: ' + JSON.stringify({ id: 'isolated-runtime-model', object: 'chat.completion.chunk',
    model: 'runtime-fixture', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) }) + '\n\n');
}
async function createServer() {
  server = http.createServer((request, response) => {
    let raw = '', tooLarge = false;
    request.on('data', part => {
      raw += part;
      if (raw.length > 8 * 1024 * 1024) { tooLarge = true; response.writeHead(413); response.end(); request.destroy(); }
    });
    request.on('end', async () => {
      if (tooLarge) return;
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname === '/api/v1/ai-proxy/config') {
          authCalls.push(url.pathname);
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ ok: true, key: 'loopback-only-model-ticket', model: 'runtime-fixture',
            label: 'Isolated local fixture', expiresIn: 3600, path: '/api/v1/ai-proxy/v1',
            contextWindow: 128000, maxOutputTokens: 4096, input: ['text'], reasoning: false }));
          return;
        }
        if (/^\/api\/v1\/conversations\/[^/]+\/media$/.test(url.pathname)) {
          authCalls.push(url.pathname);
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end('{"items":[]}'); return;
        }
        assert.equal(url.pathname, '/api/v1/ai-proxy/v1/chat/completions', 'fixture must not serve undeclared routes');
        assert.equal(request.method, 'POST');
        assert.equal(request.headers.authorization, 'Bearer loopback-only-model-ticket');
        assert.equal(request.headers['x-soduwork-secret'], undefined, 'model transport must not receive device secret');
        const body = JSON.parse(raw);
        // Gateway warmup is a non-streaming request, separate from model probes and turns.
        if (body.max_tokens === 1 && !body.stream && body.messages?.length === 1 &&
            body.messages[0].role === 'user' && body.messages[0].content === 'ping') {
          report.warmups = (report.warmups || 0) + 1;
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
          return;
        }
        if (!body.tools && body.messages?.length === 1 && body.messages[0].content === 'ping') {
          report.modelProbes = (report.modelProbes || 0) + 1;
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          frame(response, { role: 'assistant', content: 'Ready.' });
          frame(response, {}, 'stop', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
          response.end('data: [DONE]\n\n'); return;
        }
        requests.push({ mode, body });
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        if (mode === 'cancel' || mode === 'crash' || mode === 'watchdog') {
          frame(response, { role: 'assistant', content: mode === 'cancel' ? 'Cancelable fixture stream.' : 'Pending before runtime exit.' });
          held.add(response);
          response.on('close', () => held.delete(response));
          return;
        }
        if (mode === 'tool-tree') {
          assert.ok(body.tools.some(tool => tool.function.name === 'bash'));
          frame(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'runtime_long_tool', type: 'function',
            function: { name: 'bash', arguments: JSON.stringify({ command: 'node ' + JSON.stringify(path.join(cwd, 'runtime-long-tool.cjs')), timeout: 15 }) } }] });
          frame(response, {}, 'tool_calls', { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 });
          response.end('data: [DONE]\n\n'); return;
        }
        const latest = body.messages.at(-1);
        if (mode === 'approval' && latest.role !== 'tool') {
          assert.ok(body.tools.some(tool => tool.function.name === 'write'));
          frame(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'runtime_denied_write', type: 'function',
            function: { name: 'write', arguments: JSON.stringify({ path: approvalTarget, content: 'This write must be denied.' }) } }] });
          frame(response, {}, 'tool_calls', { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 });
          response.end('data: [DONE]\n\n'); return;
        }
        if (mode === 'normal' && latest.role !== 'tool') {
          assert.ok(body.tools.some(tool => tool.function.name === 'write'), 'real SDK write tool must be available');
          frame(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'runtime_write_once', type: 'function',
            function: { name: 'write', arguments: JSON.stringify({ path: 'final-report.txt', content: 'written by the isolated Pi runtime\n' }) } }] });
          frame(response, {}, 'tool_calls', { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 });
        } else {
          frame(response, { role: 'assistant', content: mode === 'approval'
            ? 'The requested write was denied; no file was created. ' : 'Created final-report.txt ' });
          await delay(80);
          if (response.destroyed) return;
          frame(response, { content: mode === 'approval' ? 'The existing workspace is preserved.' : 'with the requested content.' });
          frame(response, {}, 'stop', { prompt_tokens: 35, completion_tokens: 10, total_tokens: 45 });
        }
        response.end('data: [DONE]\n\n');
      } catch (error) {
        serverErrors.push(String(error.stack || error));
        if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Local fixture assertion failed' } }));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return 'http://127.0.0.1:' + server.address().port;
}

app.whenReady().then(async () => {
  stage('Prepare local auth/model and isolated BrowserWindow');
  const hub = await createServer();
  const claims = { typ: 'device', uid: 'isolated-test-user', cid: 'isolated-test-device',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const identity = { hub, clientId: claims.cid, secret: 'isolated-device-secret-never-in-worker',
    session: Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + 'a'.repeat(64) };
  const { createHostAuth } = require('../main/agent-runtime/process-auth');
  const { createProcessSession } = require('../main/agent-runtime/process-session');
  runtime = createProcessSession({ stallTimeoutMs: 2000,
    treeFactory(config) {
      const guard = require('../main/agent-runtime/process-tree').createProcessTreeGuard(config);
      return { start: () => guard.start(), async stop() {
        const observation = { pid: config.pid, blockedBeforeConfirmation: runtime.maintenanceWorkloads().length > 0 };
        cleanupObservations.push(observation);
        if (failCleanupOnce.delete(config.pid)) {
          observation.injectedFailure = true;
          throw Error('Isolated transient cleanup snapshot failure');
        }
        try {
          const result = await guard.stop(); observation.confirmed = true; return result;
        } catch (error) {
          observation.error = String(error.message);
          observation.causes = (error.errors || []).map(cause => ({ message: cause.message, code: cause.code }));
          observation.report = error.report;
          throw error;
        }
      } };
    },
    authFactory: options => createHostAuth({ ...options,
    identityOf: async () => identity, deviceAuth: { ensureSession: async () => identity.session },
    fetchImpl: (url, init) => {
      assert.equal(new URL(url).origin, hub, 'fixture refuses non-loopback authenticated requests');
      return fetch(url, init);
    } }) });
  bridge = require('../main/agent-runtime/pi-session-bridge').createPiSessionBridge({
    app, sessionModule: runtime, runnerAdapters: [],
  });
  const agentDir = path.join(profile, 'pi-agent');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
    compaction: { enabled: false }, retry: { enabled: false }, enableInstallTelemetry: false,
  }));
  win = new BrowserWindow({ show: false, width: 700, height: 450, webPreferences: {
    contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false,
  } });
  win.webContents.on('render-process-gone', (_event, details) => rendererErrors.push(details.reason));
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_req, done) => done({ cancel: true }));
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><meta charset="utf-8"><title>Isolated Runtime Host</title><body><p id="alive">Host ready</p><script>window.runtimeProbe=0;</script></body></html>'));
  heartbeat = setInterval(() => ticks++, 20);
  const options = { app, identity, cwd, skillDirs: [], noExtensions: true,
    accessPolicy: { schema: 'soduwork.access-policy/v1', mode: 'full', revision: 1, workspaceRoot: cwd },
    activePluginIds: ['isolated-process-plugin'],
    async resolveConnectors(turn) {
      assert.equal(await turn.cancelled(), false, 'connector cancellation callback crosses back into the worker');
      grantCounts.connectors.issued++;
      return require('../main/agent-runtime/process-grants').attach({
        guide: 'This isolated connector fixture supplies no external tools.', servers: [],
        cleanup() { grantCounts.connectors.cleaned++; },
      });
    },
    async resolvePlugins(ids) {
      assert.deepEqual(ids, ['isolated-process-plugin']); grantCounts.plugins.issued++;
      return { items: [{ pluginId: ids[0], name: 'Isolated process fixture', context: 'Follow the user instruction; this fixture authorizes no external operation.' }],
        grant: require('../main/agent-runtime/process-grants').attach({ guide: '', servers: [],
          cleanup() { grantCounts.plugins.cleaned++; } }) };
    },
  };
  assertMainHasNoSdk();

  stage('Open real Pi session in utilityProcess');
  const opened = await bounded(bridge.open({ ...options, ref: 'process-e2e-first' }), 'session open', 60000);
  assert.equal(opened.ok, true, opened.reason);
  handle = opened.session;
  const diagnostics = runtime.diagnostics(app);
  assert.ok(Number.isInteger(diagnostics.pid) && diagnostics.pid > 0);
  assert.notEqual(diagnostics.pid, process.pid);
  assert.equal(diagnostics.transport, 'utilityProcess');
  report.process = { mainPid: process.pid, ...diagnostics };
  assertMainHasNoSdk();
  report.cases.push('Real Pi SDK and session are created in a different utility-process PID; Electron main loads no SDK/execution module.');

  stage('Stream response and execute the real write tool');
  const updates = [];
  const off = handle.on(event => updates.push({ event, text: text(handle.snapshot()) }));
  const initialHandle = handle;
  let captures = 0, finishedCaptures = 0, completionObserved = false;
  handle.captureDelivery = async () => {
    captures++;
    assert.equal(completionObserved, false, 'delivery capture must finish before completion');
    assert.ok(initialHandle.snapshot().tools.some(tool => tool.name === 'write' || tool.tool === 'write'));
    const outputs = await initialHandle.outputSnapshotAsync();
    assert.ok(outputs.files.some(file => file.name === 'final-report.txt' || file.relative === 'final-report.txt'));
    assert.equal(fs.readFileSync(path.join(cwd, 'final-report.txt'), 'utf8'), 'written by the isolated Pi runtime\n');
    finishedCaptures++;
  };
  const submitted = await handle.submit('Create final-report.txt in this isolated workspace.', [], { submissionId: 'process-e2e-write',
    afterTurn: async status => {
      assert.equal(status, 'completed');
      const payload = await require('../main/pi-session/task-delivery.cjs').capture(handle, status);
      assert.deepEqual(payload.files.map(file => file.name), ['final-report.txt']);
      assert.equal(Buffer.from(payload.files[0].data, 'base64').toString(), 'written by the isolated Pi runtime\n');
      report.taskDeliveryCaptured = true;
    } });
  assert.equal(submitted.accepted, true);
  submitted.completion.then(() => { completionObserved = true; });
  assert.equal(completionObserved, false, 'admission must not wait for model completion');
  const completed = await bounded(submitted.completion, 'real write turn');
  assert.equal(completed.ok, true, completed.reason);
  assert.equal(report.taskDeliveryCaptured, true, 'task settlement captures files through the real worker boundary');
  await until(() => !handle.inFlight(), 'write turn settles');
  assert.equal(handle.status(), 'idle');
  assert.equal(fs.readFileSync(path.join(cwd, 'final-report.txt'), 'utf8'), 'written by the isolated Pi runtime\n');
  assert.equal(requests.length, 2, 'one tool call and one completion, without replay');
  assert.ok(updates.some(row => row.text.includes('Created final-report.txt ')), 'stream updates reach the main-process projection');
  const snapshot = handle.snapshot();
  assert.match(text(snapshot), /with the requested content/);
  const writeTool = snapshot.tools.find(tool => tool.tool === 'write' || tool.name === 'write' || tool.toolName === 'write');
  assert.ok(writeTool, 'write receipt is projected');
  const detail = await handle.toolDetail(writeTool.id || writeTool.toolCallId);
  assert.ok(detail, 'lazy tool details come from the runtime');
  const outputs = await handle.outputSnapshotAsync();
  assert.ok(outputs.files.some(file => file.name === 'final-report.txt' || file.relative === 'final-report.txt'));
  const archive = handle.resumeLocation(), sessionId = handle.sessionId;
  assert.ok(path.isAbsolute(archive) && fs.existsSync(archive));
  assert.equal(JSON.stringify(snapshot).includes(identity.secret), false);
  assert.equal(captures, 1, 'capture callback installed on the bridge facade must cross into the worker turn boundary');
  assert.equal(finishedCaptures, 1, 'optional capture failures must not hide a failed fixture assertion');
  await until(() => grantCounts.connectors.cleaned === 1 && grantCounts.plugins.cleaned === 1 &&
    runtime.diagnostics(app).leases === 0, 'plugin and connector grant leases are cleaned after the real turn');
  off();
  report.cases.push('A real SSE tool call writes the isolated file exactly once, streamed text reaches the projection, and lazy tool/output queries succeed.');
  report.cases.push('Public bridge delivery capture runs in main, reads the synchronized worker projection and lazy outputs, and finishes before the independent completion.');
  report.cases.push('Plugin and connector grants cross their capability codec, call the worker cancellation probe, and clean their main-process leases after the real model turn.');

  stage('Close and restore actual SDK archive');
  await handle.bindTask('interrupted-requirement', 'Recovery fixture');
  assert.equal(await handle.claimInterruptedTask('interrupted-requirement'), null,
    'a fresh session cannot claim interrupted work');
  await handle.close();
  const beforeResume = requests.length;
  const restored = await bounded(bridge.open({ ...options, ref: 'process-e2e-restored',
    resumePath: archive, resumeCwd: cwd }), 'archive restore', 45000);
  assert.equal(restored.ok, true, restored.reason);
  handle = restored.session;
  assert.equal(handle.sessionId, sessionId);
  assert.match(text(handle.snapshot()), /with the requested content/);
  assert.equal(requests.length, beforeResume, 'history restoration does not execute the model');
  assert.equal(await handle.claimInterruptedTask('unrelated-requirement'), null);
  const recoveryToken = await handle.claimInterruptedTask('interrupted-requirement');
  assert.equal(typeof recoveryToken, 'string');
  assert.ok(recoveryToken.length > 0);
  assert.equal(await handle.claimInterruptedTask('interrupted-requirement'), null);
  assert.equal(await handle.releaseInterruptedTask('interrupted-requirement', 'stale-token'), false);
  assert.equal(await handle.releaseInterruptedTask('interrupted-requirement', recoveryToken), true);
  const reclaimedToken = await handle.claimInterruptedTask('interrupted-requirement');
  assert.equal(typeof reclaimedToken, 'string');
  assert.notEqual(reclaimedToken, recoveryToken);
  await handle.releaseInterruptedTask('interrupted-requirement', reclaimedToken);
  report.cases.push('Interrupted requirement claims and token-checked release cross the real utility process; only restored task bindings are eligible.');
  report.cases.push('Closing and reopening the real JSONL archive preserves transcript and conversation identity without executing another model turn.');

  stage('Execute a controlled task through the public bridge and bidirectional callback facade');
  const controlledHandle = handle, callbackSteps = [], requestsBeforeControlled = requests.length;
  let enterControlled, finishControlled, controlledComplete = false, controlledCaptures = 0;
  const enteredControlled = new Promise(resolve => { enterControlled = resolve; });
  const controlledGate = new Promise(resolve => { finishControlled = resolve; });
  handle.captureDelivery = async () => {
    controlledCaptures++;
    assert.equal(controlledComplete, false, 'controlled capture precedes completion');
    assert.match(text(controlledHandle.snapshot()), /CONTROLLED_RESULT_VISIBLE/);
    assert.ok(controlledHandle.snapshot().tools.some(tool => tool.id === 'controlled-read'));
    callbackSteps.push('capture');
  };
  const controlled = await handle.submit('Controlled workflow in the existing queue.', [], {
    submissionId: 'process-e2e-controlled', taskId: 'isolated-controlled-task', executor: 'workflow',
    beforeTurn: async () => { callbackSteps.push('before'); },
    controlled: {
      async execute(nativeHandle, instruction, files) {
        assert.equal(process.pid, report.process.mainPid, 'controlled executor stays in main');
        assert.equal(nativeHandle.sessionId, controlledHandle.sessionId);
        assert.equal(instruction, 'Controlled workflow in the existing queue.'); assert.deepEqual(files, []);
        await nativeHandle.appendTaskMessage('user', instruction, [], 'isolated-controlled-task');
        await nativeHandle.appendTaskTool({ type: 'tool_execution_start', toolCallId: 'controlled-read',
          toolName: 'read', args: { path: 'final-report.txt' } }, 'isolated-controlled-task');
        await nativeHandle.appendTaskTool({ type: 'tool_execution_end', toolCallId: 'controlled-read',
          toolName: 'read', result: { content: [{ type: 'text', text: 'CONTROLLED_RECEIPT' }] } }, 'isolated-controlled-task');
        await nativeHandle.appendTaskMessage('assistant', 'CONTROLLED_RESULT_VISIBLE', [], 'isolated-controlled-task', 'controlled-result');
        await nativeHandle.taskExecutionChanged({ taskId: 'isolated-controlled-task', status: 'running', executor: 'workflow' });
        callbackSteps.push('execute'); enterControlled(); await controlledGate;
        return { ok: true };
      },
      async cancel() { assert.fail('successful controlled task must not be cancelled'); },
    },
    afterTurn: async status => { assert.equal(status, 'completed'); callbackSteps.push('after'); },
  });
  assert.equal(controlled.accepted, true);
  controlled.completion.then(() => { controlledComplete = true; });
  await bounded(enteredControlled, 'controlled callback enters main and writes receipts');
  assert.equal(controlledComplete, false);
  assert.match(text(controlledHandle.snapshot()), /CONTROLLED_RESULT_VISIBLE/);
  assert.ok((await controlledHandle.toolDetail('controlled-read')).result.includes('CONTROLLED_RECEIPT'));
  assert.equal(requests.length, requestsBeforeControlled, 'controlled execution must not start a competing model turn');
  finishControlled();
  assert.equal((await bounded(controlled.completion, 'controlled completion')).ok, true);
  assert.deepEqual(callbackSteps, ['before', 'execute', 'after', 'capture']);
  assert.equal(controlledCaptures, 1);
  await until(() => !handle.inFlight(), 'controlled queue settles');
  handle.captureDelivery = undefined;
  report.cases.push('A controlled task stays in the existing queue, executes in main through a process facade, and projects real message/tool receipts; afterTurn and delivery capture retain their existing order and both finish before completion.');

  stage('Project workflow output through the actual utility-process batch interface');
  assert.equal(handle.taskMessageStreaming, true);
  const workflowOutput = require('../main/conversation/task-live-output').create(handle, '', {
    coalesceText: true, sourceAgent: { agentId: 'qwen', nodeKey: 'relay', runId: 'isolated-output' },
  });
  const workflowRequests = requests.length;
  await workflowOutput.consume('isolated-relay', [{ seq: 1, kind: 'say', text: 'WORKFLOW_STREAM', streamId: 'reply' }]);
  let workflowMessage = handle.snapshot().messages.find(row => row.taskOutputKey?.includes('isolated-relay'));
  assert.ok(workflowMessage); assert.equal(workflowMessage.done, false);
  assert.equal(workflowMessage.sourceAgent.agentId, 'qwen');
  await workflowOutput.consume('isolated-relay', [{ seq: 2, kind: 'say', text: 'WORKFLOW_STREAM_ACK', streamId: 'reply' }]);
  await workflowOutput.finish('isolated-relay');
  workflowMessage = handle.snapshot().messages.find(row => row.taskOutputKey?.includes('isolated-relay'));
  assert.equal(workflowMessage.done, true); assert.equal(workflowMessage.blocks[0].text, 'WORKFLOW_STREAM_ACK');
  await handle.rememberWorkflowPlugin('');
  assert.equal(requests.length, workflowRequests); assertMainHasNoSdk();
  report.cases.push('Workflow partial text, actual Agent attribution and final storage acknowledgement cross the real utility-process batch interface without another model request.');

  stage('Persist and reopen a long controlled answer through the actual native process');
  const longOpened = await bridge.open({ ...options, ref: 'process-e2e-long-answer' });
  assert.equal(longOpened.ok, true, longOpened.reason);
  let longHandle = longOpened.session;
  const longChunks = Array.from({ length: 100 }, (_, i) => i + ':' + 'Complete answer \u4f60\u597d\ud83d\ude42\n'.repeat(200));
  const longAnswer = longChunks.join(''), longStart = performance.now(), beforeLong = requests.length;
  try {
    const turn = require('../main/pi-session/controlled-task-turn').create({
      task: { id: 'long-native-task' }, scope: {}, spec: { mode: 'dispatch', context: {}, agentId: 'local:codex-harness' },
      request: async (_route, body) => body ? { ref: 'long-native-ref' } : {
        ref: 'long-native-ref', engine: 'codex-harness', status: 'done', seq: longChunks.length,
        items: longChunks.map((text, i) => ({ seq: i + 1, kind: 'say', streamId: 'answer', delta: true, text })),
      },
    });
    assert.equal((await turn.execute(longHandle, 'Isolated long answer', [])).ok, true);
    const answer = value => value.messages.filter(row => row.taskOutputKey?.includes('long-native-ref'));
    assert.equal(answer(longHandle.snapshot()).length, 1);
    assert.equal(answer(longHandle.snapshot())[0].blocks[0].text, longAnswer);
    const longArchive = longHandle.resumeLocation();
    await longHandle.close();
    const longRestored = await bridge.open({ ...options, ref: 'process-e2e-long-restored', resumePath: longArchive, resumeCwd: cwd });
    assert.equal(longRestored.ok, true, longRestored.reason);
    longHandle = longRestored.session;
    assert.equal(answer(longHandle.snapshot()).length, 1);
    assert.equal(answer(longHandle.snapshot())[0].blocks[0].text, longAnswer);
    assert.equal(answer(longHandle.snapshot())[0].sourceAgent.agentId, 'codex-harness');
    assert.equal(requests.length, beforeLong, 'controlled replay and reopening never execute a model');
    report.longAnswer = { characters: longAnswer.length, chunks: longChunks.length,
      elapsedMs: +(performance.now() - longStart).toFixed(1), nativeArchiveRestored: true };
    report.cases.push('A long controlled answer crosses the unchanged native RPC budget, persists once, and reopens completely with its original runtime identity.');
  } finally { await longHandle.close(); }

  stage('Run a personal Pi workflow in the existing process-backed conversation queue');
  const personal = require('../main/personal-plugins');
  const seed = personal.create(app, { template: 'workflow', key: 'isolated-relay', name: 'Isolated Pi relay',
    description: 'Only the temporary model and workspace are used.', version: '1.0.0',
    instructions: 'Write final-report.txt in the current node workspace, then report the actual result.' }).plugin;
  const workflow = seed.localDraft.workflow;
  for (const node of workflow.nodes) if (['ai', 'ai_review'].includes(node.type)) {
    node.config.agentKind = 'local:pi';
    node.outputs = [{ key: node.outputs[0].key, kind: 'file', path: 'final-report.txt',
      label: 'Isolated proof', required: true }];
  }
  const workflowPlugin = personal.create(app, { ...seed.localDraft, version: '1.0.1', workflow }).plugin;
  const debugMethods = new Map(), caps = require('../main/conversation/capabilities');
  const originalCapabilities = caps.resolve;
  // The fixture authorizes no optional capabilities; execution uses the real SDK,
  // permission engine, plugin resource resolver and utility-process transport.
  caps.resolve = async () => ({ capabilityIds: [], skills: [], skillDirs: [] });
  try {
    const debug = require('../main/personal-plugin-debug-ipc').install({
      app, ipcMain: { handle: (key, fn) => debugMethods.set(key, fn) }, session: { get: ref => ref === handle.ref ? handle : null },
      identityOf: async () => identity, skillDirs: () => [], deviceGrants: () => [], managedInputsRoot: () => cwd,
      createExecutor: value => require('../main/personal-plugin-debug-runner').create({ ...value, piSession: runtime }),
    });
    handle.attachedWindow = win;
    const accepted = await debug.submitConversation(handle, 'Complete the isolated two-node file relay.', [],
      { submissionId: 'isolated-workflow-request-0001' }, [{ pluginId: workflowPlugin.pluginId }]);
    assert.equal(accepted.accepted, true);
    const journal = require('../main/personal-plugin-debug').store(path.join(profile, 'plugin-debug-runs'), handle.sessionId);
    const waiting = await until(() => {
      const record = journal.read();
      if (['failed', 'blocked'].includes(record?.status)) throw Error(record.reason);
      return record?.status === 'waiting' ? record : null;
    }, 'real Pi workflow pauses for human approval', 60000);
    const aiNodes = waiting.nodes.filter(node => node.type === 'ai');
    assert.equal(aiNodes.length, 2);
    for (const node of aiNodes) {
      assert.equal(node.attempt, 1); assert.equal(node.agent, 'pi'); assert.equal(node.status, 'completed');
      const bytes = fs.readFileSync(path.join(cwd, node.outputsFound[0].path));
      assert.equal(bytes.toString(), 'written by the isolated Pi runtime\n');
      assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'), node.outputsFound[0].sha256);
    }
    const staged = path.join(cwd, aiNodes[1].workDir, '.soduwork-inputs', 'upstream');
    assert.equal(fs.readdirSync(staged).length, 1);
    assert.equal(fs.readFileSync(path.join(staged, fs.readdirSync(staged)[0]), 'utf8'), 'written by the isolated Pi runtime\n');
    const publicHistory = await runtime.history(app);
    assert.ok(!JSON.stringify(publicHistory).includes('workflow-pi:'), 'ephemeral children must not become sidebar conversations');
    const gate = waiting.nodes.find(node => node.type === 'human_review');
    const approved = await debugMethods.get('personal-plugin-debug')({ sender: { id: win.webContents.id } }, handle.ref,
      { command: 'approve', runId: waiting.id, revision: waiting.revision, nodeKey: gate.key });
    assert.equal(approved.ok, true, approved.reason);
    assert.equal((await bounded(accepted.completion, 'workflow completion with stored parent output')).ok, true);
    assert.equal(journal.read().status, 'completed');
    assert.ok(handle.snapshot().messages.some(row => row.sourceAgent?.runId === waiting.id));
    assertMainHasNoSdk();
    report.cases.push('A real two-node Pi workflow uses the existing queue, ephemeral utility-process children, native write tools, hashed local file handoff and explicit human approval, then stores the attributed parent transcript.');

    stage('Interrupt a workflow child in the shared utility process and explicitly cancel its parent');
    mode = 'crash';
    const beforeWorkflowCrash = requests.length;
    const interrupted = await debug.submitConversation(handle, 'Wait on the isolated model before writing.', [],
      { submissionId: 'isolated-workflow-request-0002' }, [{ pluginId: workflowPlugin.pluginId }]);
    const interruptedOutcome = interrupted.completion.then(value => ({ value }), error => ({ error }));
    await until(() => requests.length === beforeWorkflowCrash + 1 && held.size > 0,
      'the real workflow child starts its model stream');
    const crashedWorker = runtime.diagnostics(app);
    process.kill(crashedWorker.pid, 'SIGKILL');
    assert.ok((await bounded(interruptedOutcome, 'workflow parent is interrupted')).error);
    const failedWorkflow = await until(() => {
      const value = journal.read(); return value?.status === 'failed' ? value : null;
    }, 'interrupted workflow retains its failed node');
    const failedNode = failedWorkflow.nodes.find(node => node.status === 'failed');
    await until(() => runtime.get(failedNode.ref)?.executionStopped(), 'exact worker resources are reclaimed');
    assert.ok(runtime.maintenanceWorkloads().length, 'the accepted parent callback still blocks recovery');
    const cancelled = await debugMethods.get('personal-plugin-debug')({ sender: { id: win.webContents.id } }, handle.ref,
      { command: 'cancel', runId: failedWorkflow.id, revision: failedWorkflow.revision });
    assert.equal(cancelled.ok, true, cancelled.reason);
    assert.equal(journal.read().status, 'cancelled');
    await until(() => !runtime.maintenanceWorkloads().length, 'explicit cancellation releases the parent callback');
    assert.equal(requests.length, beforeWorkflowCrash + 1, 'neither the failed node nor its successor is replayed');
    mode = 'normal';
    const reopened = await bounded(bridge.open({ ...options, ref: 'process-e2e-after-workflow-crash',
      resumePath: archive, resumeCwd: cwd }), 'explicit reopen after workflow cancellation', 45000);
    assert.equal(reopened.ok, true, reopened.reason); handle = reopened.session;
    assert.notEqual(runtime.diagnostics(app).generation, crashedWorker.generation);
    assertMainHasNoSdk();
    report.cases.push('A workflow child crash interrupts the shared parent, preserves failed evidence and blocks recovery until resource reclamation and explicit cancellation release the accepted host callback, without replaying any node.');
  } finally {
    caps.resolve = originalCapabilities;
    if (!handle.snapshot().runtimeUnavailable) await handle.rememberWorkflowPlugin('isolated-process-plugin');
  }

  stage('Exercise callback lease cleanup across repeated controlled turns');
  const leaseBaseline = runtime.diagnostics(app), requestsBeforeStress = requests.length;
  for (let index = 0; index < 24; index++) {
    const accepted = await handle.submit('Callback lease stress ' + index, [], {
      submissionId: 'lease-' + index, executor: 'workflow', beforeTurn: async () => {}, afterTurn: async () => {},
      controlled: { execute: async () => ({ ok: true }), cancel: async () => {} },
    });
    assert.equal(accepted.accepted, true);
    assert.equal((await bounded(accepted.completion, 'callback lease turn ' + index)).ok, true);
    await until(() => !handle.inFlight(), 'lease turn settles');
  }
  const leaseAfter = await until(() => {
    const value = runtime.diagnostics(app);
    return value.capabilities <= leaseBaseline.capabilities + 1 && value.rpc.exported <= leaseBaseline.rpc.exported + 1 ? value : null;
  }, 'completed turn callbacks are released on both peers');
  assert.equal(leaseAfter.auths, leaseBaseline.auths, 'turn callbacks cannot create fresh auth records');
  assert.equal(leaseAfter.leases, 0); assert.equal(requests.length, requestsBeforeStress);
  report.callbackLeases = { turns: 24, before: leaseBaseline, after: leaseAfter };
  report.cases.push('Twenty-four real controlled turns release their callback leases after completion without additional model requests, grant leases or authentication records.');

  stage('Verify reverse connector callback leases across repeated native model turns');
  mode = 'lease-native';
  await until(() => runtime.diagnostics(app).rpc.functions === 0, 'reverse connector probe is released after its resolver');
  const reverseBaseline = runtime.diagnostics(app), nativeRequestsBefore = requests.length;
  for (let index = 0; index < 6; index++) {
    const accepted = await handle.submit('Read the preserved local result without changing it: lease ' + index,
      [], { submissionId: 'native-lease-' + index });
    assert.equal(accepted.accepted, true);
    assert.equal((await bounded(accepted.completion, 'native callback lease turn ' + index)).ok, true);
    await until(() => !handle.inFlight() && runtime.diagnostics(app).leases === 0 &&
      runtime.diagnostics(app).rpc.functions === 0, 'native callback and grant leases are released');
  }
  const reverseAfter = runtime.diagnostics(app);
  assert.equal(reverseAfter.auths, reverseBaseline.auths);
  assert.ok(reverseAfter.capabilities <= reverseBaseline.capabilities + 1);
  assert.ok(reverseAfter.rpc.exported <= reverseBaseline.rpc.exported + 1);
  assert.equal(requests.length, nativeRequestsBefore + 6, 'one local model request for each fresh native turn');
  report.reverseCallbackLeases = { turns: 6, before: reverseBaseline, after: reverseAfter };
  report.cases.push('Six additional native SDK turns release reverse cancellation callbacks and plugin/connector grants without accumulating capability or authentication references.');

  stage('Cancel active SSE and observe no automatic retry');
  mode = 'cancel';
  const beforeCancel = requests.length;
  const cancelSubmission = await handle.submit('Wait on this cancelable local fixture.', [], { submissionId: 'process-e2e-cancel' });
  assert.equal(cancelSubmission.accepted, true);
  await until(() => requests.length === beforeCancel + 1 && held.size > 0 && handle.inFlight(), 'active cancel stream');
  await handle.cancel();
  const cancelled = await bounded(cancelSubmission.completion, 'cancel completion');
  assert.equal(cancelled.cancelled, true, JSON.stringify(cancelled));
  await until(() => !handle.inFlight(), 'cancel projection settles');
  await delay(250);
  assert.equal(requests.length, beforeCancel + 1, 'cancelled turn must never replay');
  report.cases.push('Cancellation crosses the process boundary, settles the active submission and does not automatically replay its request.');

  stage('Kill only runtime worker while a submission is pending');
  mode = 'crash';
  const beforeCrash = requests.length;
  const crashSubmission = await handle.submit('Keep this local stream pending for the crash test.', [], { submissionId: 'process-e2e-crash' });
  assert.equal(crashSubmission.accepted, true);
  const outcome = crashSubmission.completion.then(value => ({ value }), error => ({ error }));
  await until(() => requests.length === beforeCrash + 1 && handle.inFlight(), 'active crash stream');
  const beforeKill = runtime.diagnostics(app), tickAtKill = ticks;
  assert.notEqual(beforeKill.pid, process.pid);
  failCleanupOnce.add(beforeKill.pid);
  process.kill(beforeKill.pid, 'SIGKILL');
  const failed = await bounded(outcome, 'worker exit rejects pending completion');
  assert.ok(failed.error, 'worker loss must reject the pending completion');
  await until(() => !handle.inFlight(), 'dead worker projection settles');
  await until(() => ticks > tickAtKill + 3, 'main event loop survives');
  assert.equal(await win.webContents.executeJavaScript('++window.runtimeProbe'), 1, 'renderer survives runtime exit');
  await delay(700);
  assert.equal(requests.length, beforeCrash + 1, 'crashed submission must not run again automatically');
  assert.equal(fs.readFileSync(path.join(cwd, 'final-report.txt'), 'utf8'), 'written by the isolated Pi runtime\n');
  assertMainHasNoSdk();
  report.cases.push('Killing the isolated runtime rejects its pending completion while Electron main and renderer remain responsive; no submission or completed write is replayed.');

  await until(() => runtime.maintenanceWorkloads().some(row => row.status === 'cleanup-failed'),
    'injected cleanup failure remains blocked before explicit recovery');

  stage('Explicitly reopen the archive in a fresh process generation');
  mode = 'explicit-recovery';
  const recovered = await bounded(bridge.open({ ...options, ref: 'process-e2e-after-crash',
    resumePath: archive, resumeCwd: cwd }), 'explicit recovery after worker exit', 45000);
  assert.equal(recovered.ok, true, recovered.reason);
  handle = recovered.session;
  const nextProcess = runtime.diagnostics(app);
  assert.notEqual(nextProcess.pid, beforeKill.pid);
  assert.notEqual(nextProcess.generation, beforeKill.generation);
  const recoveryCleanup = cleanupObservations.filter(row => row.pid === beforeKill.pid);
  assert.ok(recoveryCleanup.some(row => row.injectedFailure));
  assert.ok(recoveryCleanup.some(row => row.confirmed && row.blockedBeforeConfirmation));
  assert.equal(handle.sessionId, sessionId);
  assert.equal(requests.length, beforeCrash + 1, 'explicit reopen restores history without replaying the interrupted submission');
  const fresh = await handle.submit('Explain the preserved isolated output.', [], { submissionId: 'process-e2e-explicit-recovery' });
  assert.equal(fresh.accepted, true);
  const freshResult = await bounded(fresh.completion, 'explicit new turn after worker recovery');
  assert.equal(freshResult.ok, true, freshResult.reason);
  await until(() => !handle.inFlight(), 'recovered turn settles');
  assert.equal(requests.length, beforeCrash + 2, 'only the fresh user instruction executes');
  assert.equal(fs.readFileSync(path.join(cwd, 'final-report.txt'), 'utf8'), 'written by the isolated Pi runtime\n');
  assertMainHasNoSdk();
  report.recoveredProcess = nextProcess;
  report.cases.push('An explicit reopen starts a fresh process generation and restores history; only the subsequent fresh user instruction executes.');
  report.cases.push('A transient cleanup failure is rechecked on explicit reopen without restarting Electron; the real process guard confirms retirement before a new generation can start.');

  if (process.platform === 'win32') report.skipped = ['SIGSTOP watchdog injection: POSIX signal is unavailable on Windows.'];
  else {
    stage('Freeze the runtime with SIGSTOP and observe automatic watchdog cleanup');
    mode = 'watchdog';
    const beforeWatchdog = requests.length, tickBeforeFreeze = ticks;
    const frozen = await handle.submit('Hold this loopback stream for watchdog verification.', [], { submissionId: 'process-e2e-watchdog' });
    assert.equal(frozen.accepted, true);
    const frozenOutcome = frozen.completion.then(value => ({ value }), error => ({ error }));
    await until(() => requests.length === beforeWatchdog + 1 && handle.inFlight(), 'watchdog stream is active');
    const watched = runtime.diagnostics(app); await ownFixtureProcess(watched.pid);
    process.kill(watched.pid, 'SIGSTOP');
    assert.equal(await win.webContents.executeJavaScript('++window.runtimeProbe'), 2);
    const interrupted = await bounded(frozenOutcome, 'watchdog rejects frozen completion', 20000);
    assert.ok(interrupted.error);
    await until(() => runtime.diagnostics(app).dead && !handle.inFlight(), 'watchdog marks runtime unavailable');
    await until(async () => !(await processIdentity(watched.pid)) && !runtime.maintenanceWorkloads().length,
      'frozen worker exit and maintenance cleanup confirmation', 15000);
    const cleanup = cleanupObservations.find(row => row.pid === watched.pid);
    assert.equal(cleanup?.blockedBeforeConfirmation, true); assert.equal(cleanup?.confirmed, true);
    assert.ok(ticks > tickBeforeFreeze + 10, 'main event loop remains responsive throughout freeze and cleanup');
    await delay(250); assert.equal(requests.length, beforeWatchdog + 1, 'watchdog cannot replay the interrupted turn');
    report.watchdog = { pid: watched.pid, thresholdMs: 2000, cleanup };
    report.cases.push('POSIX SIGSTOP freezes only the runtime; the watchdog rejects its submission, preserves main/renderer responsiveness, blocks maintenance until exact process cleanup is confirmed, and performs no replay.');
    const reopened = await bounded(bridge.open({ ...options, ref: 'process-e2e-after-watchdog',
      resumePath: archive, resumeCwd: cwd }), 'explicit reopen after watchdog', 45000);
    assert.equal(reopened.ok, true, reopened.reason); handle = reopened.session;
  }

  stage('Run a real Bash/Node descendant tree and reclaim it after utility-process death');
  mode = 'tool-tree';
  const pidFile = path.join(cwd, 'runtime-tool-processes.json');
  fs.writeFileSync(path.join(cwd, 'runtime-long-tool.cjs'), [
    "'use strict';", "const fs = require('node:fs'), cp = require('node:child_process');",
    "const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'soduwork-isolated-runtime-descendant'], { stdio: 'ignore' });",
    "child.once('spawn', () => fs.writeFileSync(" + JSON.stringify(pidFile) + ", JSON.stringify({ parent: process.pid, child: child.pid })));",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const beforeTree = requests.length;
  const longTool = await handle.submit('Run the isolated runtime-long-tool.cjs once for process-tree verification.', [], { submissionId: 'process-e2e-tool-tree' });
  assert.equal(longTool.accepted, true);
  const treeOutcome = longTool.completion.then(value => ({ value }), error => ({ error }));
  const toolPids = await until(() => {
    if (!fs.existsSync(pidFile)) return null;
    try { return JSON.parse(fs.readFileSync(pidFile, 'utf8')); } catch (_) { return null; }
  }, 'the real Bash tool spawns the isolated Node parent and child');
  await ownFixtureProcess(toolPids.parent); await ownFixtureProcess(toolPids.child);
  const treeWorker = runtime.diagnostics(app); await ownFixtureProcess(treeWorker.pid);
  assert.notEqual(toolPids.parent, treeWorker.pid); assert.notEqual(toolPids.child, treeWorker.pid);
  await delay(1600); // More than three production 500 ms ownership samples.
  assert.ok(await processIdentity(toolPids.parent)); assert.ok(await processIdentity(toolPids.child));
  process.kill(treeWorker.pid, 'SIGKILL');
  const treeFailed = await bounded(treeOutcome, 'worker loss rejects a long-tool completion');
  assert.ok(treeFailed.error);
  await until(async () => !(await processIdentity(toolPids.parent)) && !(await processIdentity(toolPids.child)) &&
    !runtime.maintenanceWorkloads().length, 'utility host confirms descendant exit and releases maintenance', 15000);
  const treeCleanup = cleanupObservations.find(row => row.pid === treeWorker.pid);
  assert.equal(treeCleanup?.blockedBeforeConfirmation, true); assert.equal(treeCleanup?.confirmed, true);
  assert.equal(requests.length, beforeTree + 1, 'the killed tool is never restarted or followed by a model replay');
  assert.equal(await win.webContents.executeJavaScript('++window.runtimeProbe'), process.platform === 'win32' ? 2 : 3);
  report.toolTree = { workerPid: treeWorker.pid, ...toolPids, cleanup: treeCleanup };
  report.cases.push('A real SDK Bash tool starts Node and a nested child; after utility-process SIGKILL the production ownership guard reclaims both exact processes and maintenance stays blocked until their exit is confirmed.');

  stage('Request and deny a real Pi write permission through the process facade');
  mode = 'approval';
  const approvalCwd = path.join(root, 'approval-workspace'); fs.mkdirSync(approvalCwd);
  const approvalOpen = await bounded(bridge.open({ ...options, ref: 'process-e2e-approval', cwd: approvalCwd,
    accessPolicy: { schema: 'soduwork.access-policy/v1', mode: 'standard', revision: 1, workspaceRoot: approvalCwd },
  }), 'standard-permission session open', 45000);
  assert.equal(approvalOpen.ok, true, approvalOpen.reason); handle = approvalOpen.session;
  const approvalEvents = [], rawApprovalEvents = [];
  const runtimeSession = bridge.runtimeSession(handle.ref);
  const offApproval = runtimeSession.subscribe(event => approvalEvents.push(event.type));
  const offRawApproval = handle.on(event => rawApprovalEvents.push(event.kind));
  const beforeApproval = requests.length;
  const deniedTurn = await handle.submit('Request one write outside this workspace, then respect the answer.', [],
    { submissionId: 'process-e2e-approval-denied' });
  assert.equal(deniedTurn.accepted, true);
  const permission = await until(() => handle.snapshot().pendingPermissions?.[0], 'real SDK write tool requests approval');
  assert.equal(permission.action, 'file.write'); assert.equal(permission.target, approvalTarget);
  assert.equal(handle.snapshot().status, 'waiting-user'); assert.equal(runtimeSession.snapshot().status, 'waiting');
  assert.equal(fs.existsSync(approvalTarget), false);
  const answer = await handle.answerUi({ requestId: permission.requestId, policyRevision: permission.policyRevision, decision: 'deny' });
  assert.equal(answer.ok, true);
  const deniedResult = await bounded(deniedTurn.completion, 'denied write turn settles');
  assert.equal(deniedResult.ok, true, deniedResult.reason);
  await until(() => !handle.inFlight() && !handle.snapshot().pendingPermissions?.length &&
    approvalEvents.includes('approval.resolved'), 'approval state and resolved event reach the public runtime');
  assert.equal(fs.existsSync(approvalTarget), false, 'denied tool must never create its target');
  assert.ok(approvalEvents.includes('approval.requested')); assert.ok(rawApprovalEvents.includes('permission'));
  assert.equal(requests.length, beforeApproval + 2, 'one requested write and one truthful explanation, without retrying the denied operation');
  assert.match(text(handle.snapshot()), /write was denied/);
  mode = 'approval-followup';
  const following = await handle.submit('Confirm the workspace remains available.', [], { submissionId: 'process-e2e-after-approval' });
  assert.equal(following.accepted, true); assert.equal((await bounded(following.completion, 'turn after permission denial')).ok, true);
  await until(() => !handle.inFlight(), 'follow-up after denied approval settles');
  assert.equal(fs.existsSync(approvalTarget), false);
  offApproval(); offRawApproval(); await handle.close();
  assertMainHasNoSdk();
  report.approval = { target: approvalTarget, decision: 'deny', events: approvalEvents, permissionKind: permission.action,
    fileExists: fs.existsSync(approvalTarget), followupCompleted: true };
  report.cases.push('The actual SDK write tool requests standard-policy approval outside its workspace but inside the fixture root; facade.answerUi denies it, requested/resolved events arrive, no file is written, and a fresh follow-up turn and close both complete.');
  assert.deepEqual(rendererErrors, []);
  assert.deepEqual(serverErrors, []);
  assert.ok(authCalls.some(route => route === '/api/v1/ai-proxy/config'));
  report.requests = { model: requests.length, authenticated: authCalls.length };
  await until(() => grantCounts.connectors.issued === grantCounts.connectors.cleaned &&
    grantCounts.plugins.issued === grantCounts.plugins.cleaned, 'all normal, cancelled and crashed grant leases are released');
  report.grants = grantCounts;
  report.ok = true;
}).catch(async error => {
  report.error = String(error.stack || error);
  report.failureDiagnostics = runtime?.diagnostics(app);
  report.failureWorkloads = runtime?.maintenanceWorkloads();
  report.failureProcesses = await Promise.all([...fixtureProcesses].map(async ([pid, identity]) =>
    ({ pid, ownedIdentity: identity, currentIdentity: await processIdentity(pid) })));
}).finally(async () => {
  clearInterval(heartbeat);
  await Promise.resolve(bridge?.dispose()).catch(error => { report.bridgeCleanupError = String(error.message || error); report.ok = false; });
  await Promise.resolve(runtime?.dispose()).catch(error => { report.cleanupError = String(error.message || error); report.ok = false; });
  for (const [pid, identity] of fixtureProcesses) {
    try { if (await processIdentity(pid) === identity) process.kill(pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') { report.fixtureCleanupError = String(error.message || error); report.ok = false; } }
  }
  win?.destroy();
  for (const response of held) response.destroy();
  if (server) {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections(); await closed;
  }
  const output = path.join(root, 'report.json');
  report.cleanupObservations = cleanupObservations;
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, report: output }, null, 2));
  // Keep only isolated artifacts and the report in OS temp for inspection.
  app.exit(report.ok ? 0 : 1);
});
