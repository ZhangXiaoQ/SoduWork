'use strict';

// Use real Electron, Pi UtilityProcess, Runner, and installed Qwen CLI; only model and authentication services use loopback fixtures.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env, PI_TELEMETRY: '0' };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron,
    [__filename, ...process.argv.slice(2), '--no-sandbox', '--disable-gpu'],
    { env, windowsHide: true, stdio: 'inherit', timeout: 180000 });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app } = electron;
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const personal = require('../main/personal-plugins');
const core = require('../main/personal-plugin-debug');
const policy = require('../main/access-control/policy');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-multi-agent-')));
const profile = path.join(root, 'profile'), cwd = path.join(root, 'work');
const evidence = path.resolve(process.argv.slice(2).find(value => !value.startsWith('--')) ||
  path.join(__dirname, '../../outputs/multi-runtime-plugin-20261020/native-execution'));
for (const dir of [profile, cwd, evidence, path.join(root, 'runner-home')]) fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', profile); app.setPath('documents', root); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const report = { ok: false, checks: [], boundary: 'Real Electron Pi SDK UtilityProcess, production plugin install/resolve/preflight/controller/runner executor, source Python Runner, installed Qwen Code CLI and actual file tools. Loopback model/auth fixtures only; no user profile, paid model or external business operation.' };
const marker = 'HANDOFF-' + crypto.randomUUID();
let child, server, session, controller, record, qwenInput = '', rpcBuffer = '', rpcSeq = 0;
const calls = [], modelCalls = [], pending = new Map(), errors = [];
const prefix = '@@SODUWORK_LOCAL_RPC@@';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    if (record && ['blocked', 'failed'].includes(record.status)) throw Error(record.reason);
    await wait(30);
  }
  throw Error('Timeout: ' + label);
}
function rpc(op, payload = {}, timeout = 60000) {
  calls.push({ op, agent: payload.cli || payload.key });
  if (op === 'job.dispatch') {
    assert.equal(payload.cli, 'qwen');
    assert.equal(payload.cfg.llm.model, 'qwen-fixture');
    assert.notEqual(payload.ctx.workDir, cwd);
    assert.equal(payload.localFiles.length, 1);
    qwenInput = payload.localFiles[0].path;
    assert.ok(qwenInput.startsWith(payload.ctx.workDir + path.sep));
    assert.equal(fs.readFileSync(qwenInput, 'utf8'), marker);
    assert.ok(payload.task.note.includes(qwenInput.replace(/\\/g, '\\\\')));
    report.checks.push('Qwen dispatch receives an integrity-checked copy of the actual Pi output within its own node directory.');
  }
  return new Promise((resolve, reject) => {
    const id = String(++rpcSeq), timer = setTimeout(() => { pending.delete(id); reject(Error('Runner timeout: ' + op)); }, timeout);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(prefix + JSON.stringify({ id, message: { op, ...payload } }) + '\n');
  });
}
function chunk(response, model, delta, finish = null) {
  response.write('data: ' + JSON.stringify({ id: 'fixture-' + model, object: 'chat.completion.chunk', model,
    choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
}
function tool(response, body, name, values) {
  const definition = body.tools.find(item => item.function.name === name)?.function;
  assert.ok(definition, 'real CLI must offer the requested file tool: ' + name);
  chunk(response, body.model, { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture_' + name + '_' + modelCalls.length,
    type: 'function', function: { name, arguments: JSON.stringify(values) } }] });
  chunk(response, body.model, {}, 'tool_calls');
}
async function serve() {
  server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', value => { raw += value; });
    request.on('end', () => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname === '/api/v1/ai-proxy/config') {
          const agent = url.searchParams.get('agent') || 'pi';
          assert.ok(['pi', 'qwen'].includes(agent));
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ ok: true, key: 'loopback-fixture-ticket', model: agent + '-fixture',
            expiresIn: 3600, path: '/api/v1/ai-proxy/v1', contextWindow: 128000, maxOutputTokens: 4096,
            input: ['text'], reasoning: false })); return;
        }
        if (/^\/api\/v1\/conversations\/[^/]+\/media$/.test(url.pathname)) {
          response.setHeader('Content-Type', 'application/json'); response.end('{"items":[]}'); return;
        }
        if (url.pathname === '/api/v1/skills') {
          response.setHeader('Content-Type', 'application/json');
          response.end('{"items":[],"skills":[],"personal":[],"company":[]}'); return;
        }
        if (url.pathname === '/api/v1/ai-proxy/v1/models') {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ object: 'list', data: ['pi-fixture', 'qwen-fixture']
            .map(id => ({ id, object: 'model', owned_by: 'isolated-fixture' })) })); return;
        }
        assert.equal(url.pathname, '/api/v1/ai-proxy/v1/chat/completions');
        assert.equal(request.headers.authorization, 'Bearer loopback-fixture-ticket');
        const body = JSON.parse(raw);
        // Production warms the gateway before the tool-bearing model turn.
        // Keep the fixture strict while honoring that separate wire contract.
        if (body.max_tokens === 1 && !body.stream && body.messages?.length === 1 &&
            body.messages[0].role === 'user' && body.messages[0].content === 'ping') {
          report.warmups = (report.warmups || 0) + 1;
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
          return;
        }
        const tools = body.tools.map(item => item.function.name);
        modelCalls.push({ model: body.model, tools });
        assert.ok(['pi-fixture', 'qwen-fixture'].includes(body.model));
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        const last = body.messages.at(-1);
        if (body.model === 'pi-fixture' && last.role !== 'tool') {
          tool(response, body, 'write', { path: 'plan.md', content: marker });
        } else if (body.model === 'qwen-fixture') {
          if (!body.messages.some(message => message.role === 'tool')) {
            // The runner embeds the input manifest as JSON in its prompt; the
            // OpenAI transport adds another escaping layer on Windows paths.
            assert.ok(JSON.stringify(body.messages).includes(path.basename(qwenInput)));
            tool(response, body, 'read_file', { file_path: qwenInput });
          } else if (!body.messages.some(message => message.tool_calls?.some(call => call.function.name === 'write_file'))) {
            // Qwen may append memory context after a tool result. Match the
            // actual read by its call id rather than assuming it is last.
            const readCall = body.messages.flatMap(message => message.tool_calls || [])
              .find(call => call.function.name === 'read_file');
            assert.equal(JSON.parse(readCall.function.arguments).file_path, qwenInput);
            const readResult = body.messages.find(message => message.role === 'tool' && message.tool_call_id === readCall.id);
            assert.ok(readResult, 'Qwen must return the actual read result before writing');
            const readText = typeof readResult.content === 'string' ? readResult.content
              : readResult.content.filter(part => part.type === 'text').map(part => part.text).join('');
            assert.equal(readText, marker, 'Qwen must actually read the verified Pi input before writing');
            const node = record.nodes.find(item => item.key === 'work');
            tool(response, body, 'write_file', { file_path: path.join(cwd, node.workDir, 'result.md'), content: marker + '\nQWEN-VERIFIED' });
          } else {
            chunk(response, body.model, { role: 'assistant', content: 'Qwen completed result.md using the verified plan.' });
            chunk(response, body.model, {}, 'stop');
          }
        } else {
          chunk(response, body.model, { role: 'assistant', content: 'Pi created plan.md for the next node.' });
          chunk(response, body.model, {}, 'stop');
        }
        response.end('data: [DONE]\n\n');
      } catch (error) {
        errors.push(error.stack); if (!response.headersSent) response.writeHead(500);
        response.end(JSON.stringify({ error: { message: 'Local fixture assertion failed' } }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}

app.whenReady().then(async () => {
  try {
    const hub = await serve();
    const claims = { typ: 'device', uid: 'fixture-user', cid: 'fixture-device',
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
    const identity = { hub, clientId: claims.cid, secret: 'fixture-only-device-secret',
      session: Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + 'a'.repeat(64) };
    const { createHostAuth } = require('../main/agent-runtime/process-auth');
    session = require('../main/agent-runtime/process-session').createProcessSession({
      authFactory: options => createHostAuth({ ...options, identityOf: async () => identity,
        deviceAuth: { ensureSession: async () => identity.session }, fetchImpl: (url, init) => {
          assert.equal(new URL(url).origin, hub); return fetch(url, init);
        } }),
    });
    const backend = path.resolve(__dirname, '../../hub-backend');
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
      HOME: path.join(root, 'runner-home'), USERPROFILE: path.join(root, 'runner-home') };
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const python = process.env.SODUWORK_TEST_PYTHON || path.join(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    assert.ok(fs.existsSync(python), 'Set SODUWORK_TEST_PYTHON to the backend virtualenv interpreter');
    child = spawn(python,
      [path.join(__dirname, 'fixtures/plugin-runner-local.py'), backend, root],
      { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', value => {
      rpcBuffer += value; let at;
      while ((at = rpcBuffer.indexOf('\n')) >= 0) {
        const line = rpcBuffer.slice(0, at).trim(); rpcBuffer = rpcBuffer.slice(at + 1);
        if (!line.startsWith(prefix)) continue;
        const result = JSON.parse(line.slice(prefix.length)), item = pending.get(result.id);
        if (!item) continue;
        clearTimeout(item.timer); pending.delete(result.id);
        result.ok ? item.resolve(result.result) : item.reject(Error(result.error));
      }
    });
    let runnerLog = '';
    child.stderr.on('data', value => { runnerLog = (runnerLog + value).slice(-8000); });
    child.on('exit', code => { for (const item of pending.values()) {
      clearTimeout(item.timer); item.reject(Error('Runner exited: ' + code));
    } pending.clear(); });
    child.on('error', error => { for (const item of pending.values()) {
      clearTimeout(item.timer); item.reject(error);
    } pending.clear(); });
    await rpc('runtime.ping');
    const example = personal.get(app, personal.BUILDER_ID).localDraft.instructions.split('\n')
      .find(line => line.startsWith('最小双底座流程示例'));
    const raw = JSON.parse(example.slice(example.indexOf('{')));
    personal.preflight(raw);
    const plugin = personal.create(app, raw).plugin;
    assert.equal(personal.resolve(app, [plugin.pluginId]).items[0].pluginId, plugin.pluginId);
    const policyValue = policy.create('full', cwd), messages = [], tools = [];
    const handle = { cwd, sessionId: 'native-collaboration', adapterId: 'pi', model: { id: 'pi-fixture' },
      snapshot: () => ({ accessPolicy: policyValue }),
      appendTaskMessage: async (...args) => messages.push(args), appendTaskTool: async (...args) => tools.push(args) };
    record = core.createRecord(plugin, handle.sessionId, 'Execute the isolated Pi plan and Qwen result.');
    const executor = require('../main/personal-plugin-debug-runner').create({ app, handle, plugin,
      identityOf: async () => identity, runtime: { rpc }, piSession: session, skillDirs: [], deviceGrants: [], interval: 50 });
    const ready = await executor.preflight(record);
    assert.equal(ready.ok, true, JSON.stringify(ready.issues));
    assert.deepEqual(ready.nodes.map(node => node.agent), ['pi', 'qwen']);
    report.checks.push('Authored Pi/Qwen display names install, resolve and preflight as distinct canonical runtimes with separate models.');
    const journal = core.store(path.join(root, 'journal'), handle.sessionId);
    controller = core.create({ record, ...executor, save: value => journal.write(value) });
    const completion = controller.execute();
    await until(() => record.status === 'waiting', 'Pi and Qwen complete and reach human approval', 90000);
    assert.equal(record.nodes[0].agent, 'pi'); assert.equal(record.nodes[1].agent, 'qwen');
    assert.ok(session.diagnostics(app).pid !== process.pid);
    const output = record.nodes[1].outputsFound[0];
    assert.equal(fs.readFileSync(path.join(cwd, output.path), 'utf8'), marker + '\nQWEN-VERIFIED');
    assert.equal(record.nodes[3].status, 'pending');
    const toolEnds = tools.map(args => args[0]).filter(event => event.type === 'tool_execution_end');
    report.toolResults = toolEnds.map(event => ({ name: event.toolName, isError: Boolean(event.isError) }));
    assert.deepEqual(toolEnds.filter(event => event.isError).map(event => event.toolName), []);
    // Qwen's ACP titles are ReadFile/WriteFile although its model tool names
    // are read_file/write_file; the Pi SDK keeps its lowercase write name.
    for (const name of ['write', 'ReadFile', 'WriteFile']) assert.ok(toolEnds.some(event => event.toolName === name),
      name + ' must finish through the real runtime event projection');
    await controller.action('approve', record.revision, 'accept');
    assert.equal((await completion).ok, true);
    assert.equal(record.status, 'completed');
    assert.deepEqual(record.nodes.map(node => node.attempt), [1, 1, 0, 0]);
    assert.equal(journal.read().status, 'completed');
    assert.deepEqual(errors, []);
    report.checks.push('Actual Pi SDK write → real Qwen ACP read/write → verified result → explicit approval → persisted completion, with no duplicate dispatch.');
    report.calls = calls; report.modelCalls = modelCalls; report.workflow = core.view(record);
    report.ok = true;
  } catch (error) {
    report.error = error.stack; report.errors = errors; report.calls = calls; report.modelCalls = modelCalls;
    if (record) report.workflow = core.view(record);
    console.error(error.stack);
  } finally {
    if (controller && !core.terminal.has(record.status)) await controller.cancel().catch(() => {});
    await session?.dispose?.().catch(() => {});
    child?.stdin.end();
    if (process.platform === 'win32' && child?.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, timeout: 5000, stdio: 'ignore' });
    else child?.kill();
    server?.closeAllConnections(); server?.close();
    report.fixtureRoot = root;
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks, evidence }));
    app.exit(report.ok ? 0 : 1);
  }
});
