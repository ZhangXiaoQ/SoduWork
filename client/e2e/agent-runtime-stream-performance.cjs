'use strict';

// Opt-in comparative benchmark. Each mode gets a fresh Electron main process,
// isolated profile, real Pi SDK, real BrowserWindow and independent Node SSE
// server. DOM/rAF acknowledgement is measured; physical painting is not.
// Includes native batching and the shared production IPC scheduler.
// --legacy-transport isolates the effect of the former 100 ms transport delay.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const stamp = () => performance.timeOrigin + performance.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CHUNKS = 240, INTERVAL = 10, RUNS = 3;
const piece = index => 'TH' + String(index).padStart(4, '0') + '|reasoning increment;';
const expectedThinking = Array.from({ length: CHUNKS }, (_, index) => piece(index + 1)).join('');
function stats(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const at = fraction => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] || 0;
  return { n: sorted.length, p50: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2),
    max: +(sorted.at(-1) || 0).toFixed(2), min: +(sorted[0] || 0).toFixed(2) };
}
function frame(response, delta, finish_reason = null) {
  response.write('data: ' + JSON.stringify({ id: 'runtime-stream-perf', object: 'chat.completion.chunk',
    model: 'perf-thinking-model', choices: [{ index: 0, delta, finish_reason }],
    ...(finish_reason ? { usage: { prompt_tokens: 200, completion_tokens: 600, total_tokens: 800 } } : {}) }) + '\n\n');
}
async function fixtureServer() {
  const http = require('node:http');
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', part => { body += part; });
    request.on('end', async () => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname === '/api/v1/ai-proxy/config') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ ok: true, key: 'loopback-performance-ticket', model: 'perf-thinking-model',
            expiresIn: 3600, path: '/api/v1/ai-proxy/v1', contextWindow: 256000, maxOutputTokens: 8192,
            input: ['text'], reasoning: true, thinkingMode: 'controllable', thinkingFormat: 'openai', supportsReasoningEffort: true }));
          return;
        }
        if (/^\/api\/v1\/conversations\/[^/]+\/media$/.test(url.pathname)) {
          response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"items":[]}'); return;
        }
        assert.equal(url.pathname, '/api/v1/ai-proxy/v1/chat/completions');
        assert.equal(request.headers.authorization, 'Bearer loopback-performance-ticket');
        const parsed = JSON.parse(body), latest = [...parsed.messages].reverse().find(row => row.role === 'user');
        // The actual model-config path probes its fresh loopback credential.
        // Keep the probe separate from measured requests and reject every
        // other unexpected model instruction exactly as before.
        if (parsed.messages.length === 1 && latest?.content === 'ping' && parsed.max_tokens === 1) {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ id: 'fixture-probe', object: 'chat.completion',
            model: 'perf-thinking-model', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
          return;
        }
        const runId = JSON.stringify(latest?.content).match(/BENCH_RUN:([a-z0-9-]+)/)?.[1];
        assert.ok(runId, 'only benchmark instructions may invoke this fixture: ' + JSON.stringify(latest?.content).slice(0, 200));
        const sent = [];
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        response.flushHeaders(); frame(response, { role: 'assistant' });
        for (let index = 1; index <= CHUNKS; index++) {
          await sleep(INTERVAL);
          const at = stamp(); frame(response, { reasoning_content: piece(index) }); sent.push({ seq: index, at });
        }
        frame(response, { content: 'FINAL_COMPLETE:' + runId }); frame(response, {}, 'stop');
        response.end('data: [DONE]\n\n');
        process.send({ type: 'stream', runId, sent, inputMessages: parsed.messages.length,
          inputBytes: Buffer.byteLength(body), effort: parsed.reasoning_effort });
      } catch (error) {
        process.send({ type: 'fixture-error', message: String(error.stack || error) });
        if (!response.headersSent) response.writeHead(500); response.end();
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.send({ type: 'ready', hub: 'http://127.0.0.1:' + server.address().port });
  process.on('disconnect', () => { server.closeAllConnections(); server.close(() => process.exit()); });
}

async function runElectron(electron, mode, output, nodeExe) {
  const { app, BrowserWindow, ipcMain } = electron;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-stream-' + mode + '-'));
  const profile = path.join(root, 'profile'), cwd = path.join(root, 'workspace');
  fs.mkdirSync(profile); fs.mkdirSync(cwd); app.setPath('userData', profile); app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const legacyTransport = process.argv.includes("--legacy-transport");
  const report = { ok: false, mode, legacyTransport, transportDelayMs: legacyTransport ? 100 : 16, root, runs: [], source: { chunks: CHUNKS, intervalMs: INTERVAL, runsPerLoad: RUNS },
    boundary: 'Fresh isolated Electron/real Pi SDK and native session, independent loopback Node SSE, real BrowserWindow DOM and requestAnimationFrame acknowledgement. Native 50 ms snapshot batching and the production one-frame IPC stream scheduler are included. Minimal thinking view, not the full product renderer; rAF does not prove physical screen paint.' };
  let server, runtime, bridge, win, heartbeat;
  const source = new Map(), active = new Map(), fixtureErrors = [], heartbeatGaps = [];
  let previousBeat;
  const check = async (fn, label, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { const value = fn(); if (value) return value; await sleep(10); }
    throw Error('Timed out: ' + label);
  };
  function observe(kind, payload) {
    const row = active.get(payload.runId); if (!row) return;
    const target = row[kind];
    if (!Number.isInteger(payload.seq) || payload.seq <= target.last || payload.seq > CHUNKS) return;
    for (let index = target.last + 1; index <= payload.seq; index++) target.at[index] = payload.at;
    target.last = payload.seq; target.events++;
    if (kind === 'main') row.lastText = payload.text;
  }
  try {
    await app.whenReady();
    server = require('node:child_process').fork(__filename, ['--fixture-server'], { execPath: nodeExe,
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, PI_TELEMETRY: '0' },
      execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    let hub;
    server.on('exit', (code, signal) => { report.fixtureExit = { code, signal }; });
    server.on('error', error => { report.fixtureProcessError = String(error.message); });
    server.on('message', value => {
      if (value.type === 'ready') hub = value.hub;
      else if (value.type === 'stream') source.set(value.runId, value);
      else if (value.type === 'fixture-error') fixtureErrors.push(value.message);
    });
    await check(() => hub, 'independent fixture server');
    const now = Math.floor(Date.now() / 1000), claims = { typ: 'device', uid: 'stream-performance-user', cid: 'stream-performance-device', iat: now - 10, exp: now + 3600 };
    const identity = { hub, clientId: claims.cid, secret: 'isolated-stream-fixture-secret',
      session: Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + 'a'.repeat(64) };
    if (mode === 'process') {
      const { createHostAuth } = require('../main/agent-runtime/process-auth');
      runtime = require('../main/agent-runtime/process-session').createProcessSession({ authFactory: options => createHostAuth({
        ...options, identityOf: async () => identity, deviceAuth: { ensureSession: async () => identity.session },
        fetchImpl: (url, init) => { assert.equal(new URL(url).origin, hub); return fetch(url, init); },
      }) });
    } else runtime = require('../main/pi-session/session');
    bridge = require('../main/agent-runtime/pi-session-bridge').createPiSessionBridge({ app, sessionModule: runtime, runnerAdapters: [] });
    const agentDir = path.join(profile, 'pi-agent'); fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, enableInstallTelemetry: false }));
    const preload = path.join(root, 'preload.cjs');
    fs.writeFileSync(preload, "const {ipcRenderer}=require('electron');const clock=()=>performance.timeOrigin+performance.now();" +
      "ipcRenderer.on('bench-stream',(_event,value)=>{const node=document.querySelector('#thinking');node.textContent=value.text;node.dataset.run=value.runId;" +
      "ipcRenderer.send('bench-dom',{runId:value.runId,seq:value.seq,at:clock()});requestAnimationFrame(()=>{if(node.dataset.run!==value.runId)return;" +
      "const all=[...node.textContent.matchAll(/TH(\\d{4})\\|/g)];ipcRenderer.send('bench-frame',{runId:value.runId,seq:Number(all.at(-1)?.[1]||0),at:clock()});});});");
    win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { preload,
      sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }));
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><title>Thinking stream benchmark</title><pre id="thinking"></pre>'));
    ipcMain.on('bench-dom', (_event, value) => observe('dom', value));
    ipcMain.on('bench-frame', (_event, value) => observe('frame', value));
    const publications = require('../main/pi-session/event-publication');
    for (const load of ['short-history', 'long-history']) {
      const opened = await bridge.open({ app, identity, ref: 'benchmark-' + load, cwd, skillDirs: [], noExtensions: true,
        thinkingLevel: 'medium', accessPolicy: { schema: 'soduwork.access-policy/v1', mode: 'full', revision: 1, workspaceRoot: cwd } });
      assert.equal(opened.ok, true, opened.reason);
      const handle = opened.session;
      if (load === 'long-history') {
        for (let index = 0; index < 300; index++) await handle.appendTaskMessage(index % 2 ? 'assistant' : 'user',
          'Historical context ' + index + ': ' + 'Retain the complete requirement and evidence. '.repeat(8));
        for (let index = 0; index < 4; index++) {
          const toolCallId = 'historical-tool-' + index;
          await handle.appendTaskTool({ type: 'tool_execution_start', toolCallId, toolName: 'write',
            args: { path: 'historical-' + index + '.txt', content: 'source-body '.repeat(45000) } }, 'history-fixture');
          await handle.appendTaskTool({ type: 'tool_execution_end', toolCallId, toolName: 'write',
            result: { content: [{ type: 'text', text: 'result-body '.repeat(45000) }] } }, 'history-fixture');
        }
      }
      let currentRun = '';
      const publication = publications.create(() => {
        if (!currentRun) return;
        const snapshot = handle.uiSnapshot();
        const userIndex = snapshot.messages.findLastIndex(message => message.role === 'user' &&
          JSON.stringify(message).includes('BENCH_RUN:' + currentRun));
        const assistantIndex = snapshot.messages.findLastIndex(message => message.role === 'assistant');
        if (userIndex < 0 || assistantIndex <= userIndex) return;
        const latest = snapshot.messages[assistantIndex];
        const text = (latest?.blocks || []).filter(block => block.kind === 'thinking').map(block => block.text || '').join('');
        const matches = [...text.matchAll(/TH(\d{4})\|/g)], seq = Number(matches.at(-1)?.[1] || 0);
        const row = active.get(currentRun); if (!seq || !row || seq <= row.main.last) return;
        observe('main', { runId: currentRun, seq, text, at: stamp() });
        win.webContents.send('bench-stream', { runId: currentRun, seq, text });
      });
      const transport = publications.createStreamScheduler((context, event, snapshot) =>
        publication.push(handle.ref, event, snapshot, context), legacyTransport ? { delay: 100 } : {});
      const detach = handle.on((event, snapshot) => transport.push(handle.ref, event, snapshot, handle));
      for (let iteration = 0; iteration < RUNS; iteration++) {
        currentRun = load + '-' + iteration;
        const row = { main: { at: [], last: 0, events: 0 }, dom: { at: [], last: 0, events: 0 }, frame: { at: [], last: 0, events: 0 } };
        active.set(currentRun, row);
        const beatStart = heartbeatGaps.length; previousBeat = stamp();
        heartbeat = setInterval(() => { const at = stamp(); heartbeatGaps.push(at - previousBeat); previousBeat = at; }, 10);
        const accepted = await handle.submit('BENCH_RUN:' + currentRun + ' Think carefully and then return the complete final marker.', [], { submissionId: currentRun });
        assert.equal(accepted.accepted, true);
        const result = await accepted.completion; assert.equal(result.ok, true, result.reason);
        await check(() => row.frame.last === CHUNKS && source.has(currentRun), 'complete thinking reaches DOM and rAF');
        clearInterval(heartbeat); heartbeat = null;
        const original = source.get(currentRun);
        assert.equal(row.lastText, expectedThinking); assert.equal(original.sent.length, CHUNKS);
        const final = handle.snapshot().messages.at(-1);
        assert.ok(JSON.stringify(final).includes('FINAL_COMPLETE:' + currentRun));
        const metrics = {};
        for (const kind of ['main', 'dom', 'frame']) {
          const values = original.sent.map(({ seq, at }) => row[kind].at[seq] - at);
          assert.ok(values.every(value => Number.isFinite(value) && value >= -2), 'all emitted tokens must have a first-visible timestamp');
          metrics[kind] = { firstMs: +values[0].toFixed(2), tokenLatencyMs: stats(values), events: row[kind].events,
            interUpdateGapMs: stats([...new Set(row[kind].at.filter(Number.isFinite))].map((at, index, all) => index ? at - all[index - 1] : 0).slice(1)) };
        }
        report.runs.push({ load, iteration, ...metrics, sourceGapMs: stats(original.sent.slice(1).map((item, index) => item.at - original.sent[index].at)),
          mainHeartbeatGapMs: stats(heartbeatGaps.slice(beatStart)), inputMessages: original.inputMessages, inputBytes: original.inputBytes,
          reasoningEffort: original.effort, fullThinkingPreserved: true, finalTextPreserved: true });
        console.log('[stream-performance] ' + mode + ' ' + currentRun + ' main p95=' + metrics.main.tokenLatencyMs.p95 + ' DOM p95=' + metrics.dom.tokenLatencyMs.p95 + ' rAF p95=' + metrics.frame.tokenLatencyMs.p95);
        active.delete(currentRun); currentRun = ''; await sleep(80);
      }
      detach(); transport.clear(); publication.clear(); await handle.close();
    }
    assert.deepEqual(fixtureErrors, []);
    report.mainLoadsSdk = Object.keys(require.cache).some(file => /[/\\]pi-session[/\\]session\.js$/.test(file));
    assert.equal(report.mainLoadsSdk, mode === 'baseline');
    report.process = mode === 'process' ? runtime.diagnostics(app) : { mainPid: process.pid, transport: 'in-process' };
    report.ok = true;
  } catch (error) { report.error = String(error.stack || error); }
  finally {
    clearInterval(heartbeat); await bridge?.dispose().catch(error => { report.cleanupError = String(error.message || error); report.ok = false; });
    await runtime?.dispose?.().catch(error => { report.cleanupError = String(error.message || error); report.ok = false; });
    win?.destroy(); if (server?.connected) server.disconnect();
    fs.writeFileSync(output, JSON.stringify(report, null, 2)); app.exit(report.ok ? 0 : 1);
  }
}

if (process.argv.includes('--fixture-server')) void fixtureServer();
else {
  const electron = require('electron');
  if (typeof electron !== 'string') {
    const arg = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
    void runElectron(electron, arg('mode'), arg('report'), arg('node-exe'));
  } else {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-stream-comparison-'));
    const reports = {};
    for (const mode of ['baseline', 'process']) {
      const output = path.join(root, mode + '.json'), env = { ...process.env, PI_TELEMETRY: '0' };
      for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
      const args = [__filename, '--mode=' + mode, '--report=' + output, '--node-exe=' + process.execPath,
        '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        ...(process.argv.includes('--legacy-transport') ? ['--legacy-transport'] : [])];
      if (process.platform === 'linux' && !env.DISPLAY) args.push('--ozone-platform=headless');
      const result = require('node:child_process').spawnSync(electron, args, { env, stdio: 'inherit', windowsHide: true, timeout: 120000 });
      reports[mode] = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : { ok: false, error: String(result.error || result.status) };
      if (!reports[mode].ok) { console.error(JSON.stringify(reports[mode], null, 2)); break; }
    }
    const report = { ok: Boolean(reports.baseline?.ok && reports.process?.ok), root,
      units: 'milliseconds; per-token first observation includes native batching and production IPC stream scheduling', reports };
    const output = path.join(root, 'comparison.json'); fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, report: output }, null, 2)); process.exitCode = report.ok ? 0 : 1;
  }
}
