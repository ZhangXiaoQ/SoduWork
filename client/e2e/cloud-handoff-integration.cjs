'use strict';
// Real Electron -> HTTP/Device authentication -> migrated Hub -> real Runner ->
// synthetic vendor process -> artifact ingestion -> native preview IPC. Only
// the Runner websocket transport and paid model CLI boundary are substituted.
const { app, BrowserWindow, ipcMain, net } = require('electron');
const fs = require('node:fs/promises'), sync = require('node:fs');
const path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { create } = require('../main/conversation/cloud-handoff');
const catalog = require('../main/agent-runtime/runtime-catalog');
const repo = path.resolve(__dirname, '../..'), output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute output directory required');
const report = { ok: false, checks: [], errors: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let root, backend, backendLog, backendError, win, current, cloud, identity;
app.on('window-all-closed', () => {});
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await pause(60); }
  throw Error('Timed out: ' + label);
}
const js = code => win.webContents.executeJavaScript(code, true);
async function request(route) {
  const response = await fetch(identity.hub + '/api/v1' + route,
    { headers: { Authorization: 'Device ' + identity.session } });
  assert.ok(response.ok, route + ': ' + await response.clone().text());
  return response.json();
}
async function click(selector) {
  const point = await js('(()=>{const r=document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
}
app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-cloud-integrated-'));
  app.setPath('userData', path.join(root, 'profile'));
  backendLog = sync.openSync(path.join(output, 'hub.log'), 'w');
  backend = spawn(process.env.SODUWORK_TEST_PYTHON || path.join(repo, process.platform === 'win32'
    ? 'hub-backend/.venv/Scripts/python.exe' : 'hub-backend/.venv/bin/python'),
    [path.join(repo, 'hub-backend/tests/handoff_http_fixture.py'), root],
    { cwd: path.join(repo, 'hub-backend'), windowsHide: true, stdio: ['ignore', backendLog, backendLog] });
  backend.once('error', error => { backendError = error; });
  await until(() => {
    if (backendError) throw backendError;
    if (backend.exitCode !== null) throw Error('Isolated Hub stopped before ready: ' + backend.exitCode);
    return sync.existsSync(path.join(root, 'ready.json'));
  }, 'isolated Hub ready', 45000);
  identity = JSON.parse(await fs.readFile(path.join(root, 'ready.json'), 'utf8'));
  cloud = create({ app, identityOf: async () => identity, interval: 100 });
  ipcMain.handle('handoff-e2e-attachments', (_event, taskId) => request('/tasks/' + encodeURIComponent(taskId) + '/attachments'));
  require('../main/attachment-files').install({ app, net, ipcMain, BrowserWindow,
    identityOf: () => identity, shell: { openPath: () => assert.fail('must preview inside the workspace') },
    dialog: { showErrorBox: (_title, error) => report.errors.push(error) } });
  for (const agent of catalog.runtimes()) {
    const cwd = path.join(root, agent.id); await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, 'input.txt'), 'portable input');
    await fs.writeFile(path.join(cwd, '.env'), 'must-stay-local');
    let localStarts = 0;
    current = { sessionId: crypto.randomUUID(), adapterId: agent.id, ref: 'preview-fixture', cwd, ui: {},
      inFlight: () => false, snapshot: () => ({ status: 'idle', queue: [],
        messages: [{ role: 'user', text: 'Keep the report title unchanged.' }] }),
      historyRow: () => ({ title: 'Integrated cloud delivery' }), bindTask: async () => ({ ok: true }), close() {},
      cancel() {}, submit() { localStarts++; return { accepted: true }; }, appendTaskMessage() {}, appendTaskTool() {} };
    const reviewed = await cloud.preview(current);
    const target = reviewed.targets.find(item => item.agentId === agent.id);
    assert.ok(target, agent.id + ' must be discovered from the real Hub');
    const committed = await cloud.confirm(current, { previewId: reviewed.previewId,
      instruction: 'WAIT_FOR_DISCONNECT: continue the report', model: agent.modelMode === 'managed' ? 'fixture-model' : '' });
    const taskId = committed.handoff.taskId, sessionId = current.sessionId;
    assert.equal(committed.handoff.phase, 'committed');
    assert.equal(committed.handoff.target.agentId, agent.id, 'automatic selection retains the source Agent');
    assert.equal(current.submit('duplicate local work').accepted, false);
    current.close(); current = null;
    await pause(1300); // The independent Runner continues with no desktop view.
    current = await cloud.reopen(sessionId, 'preview-fixture');
    assert.ok(current, agent.id + ': archived cloud session reopens without a local SDK');
    let files;
    await until(async () => {
      files = await request('/tasks/' + taskId + '/attachments');
      return files.some(row => row.role === 'output' && row.filename === 'delivery.md');
    }, agent.id + ': Runner output automatically collected');
    assert.equal(files.filter(row => row.role === 'handoff').length, 1);
    assert.ok(current.snapshot().messages.some(row => row.text === 'Keep the report title unchanged.'));
    const thought = 'Inspect restored workspace before delivering.';
    await until(() => current.snapshot().messages.some(row => row.blocks?.some(block =>
      block.kind === 'thinking' && block.text === thought)), agent.id + ': native thought replay');
    const thoughtBlocks = current.snapshot().messages.flatMap(row => row.blocks || []).filter(block => block.kind === 'thinking');
    // Harness2 emits its own refinement progress before the vendor's reasoning.
    // Keep that separate phase while asserting the final vendor thought replaces
    // all of its streamed fragments, rather than counting unrelated progress.
    const refinement = thoughtBlocks.filter(block => agent.id === 'harness2' && block.text.startsWith('Harness²：'));
    assert.equal(refinement.length, agent.id === 'harness2' ? 1 : 0);
    const nativeThoughts = thoughtBlocks.filter(block => !refinement.includes(block));
    assert.equal(nativeThoughts.length, 1, agent.id + ': final thought must replace delta chunks');
    assert.equal(nativeThoughts[0].text, thought);
    assert.equal(nativeThoughts[0].done, true);
    assert.equal(current.snapshot().tools.length, 0, agent.id + ': reasoning cannot invent tool calls');
    const page = await request('/tasks/' + taskId + '/ai-session');
    assert.ok(page.items.some(row => row.kind === 'thinking'));
    // The vendor fixture emits model tokens for native/fallback runtimes, and
    // Harness2 reports refinement tokens. These four ACP peers emit occupancy only.
    const billed = !['codex-harness', 'qwen', 'opencode', 'dsh'].includes(agent.id);
    assert.equal(page.items.some(row => row.kind === 'usage'), billed,
      agent.id + ': bill reported model tokens, never ACP context occupancy');
    win = new BrowserWindow({ show: false, width: 1200, height: 820, webPreferences: { sandbox: true,
      contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false,
      preload: path.join(__dirname, 'fixtures/cloud-workspace-preload.cjs') } });
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
    await win.loadFile(path.join(__dirname, 'fixtures/output-preview.html'));
    // executeJavaScript crosses an IPC boundary: setup expressions must not
    // return the function-valued renderer module they install on window.
    await js('window.esc=value=>String(value??"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;"}[c]));void 0;');
    await js(await fs.readFile(path.join(repo, 'client/components/panels/task-execution-stream.js'), 'utf8') + '\nvoid 0;');
    const runtimeView = await js(`(()=>{const rows=TaskExecutionStream.rows(${JSON.stringify(page.items)},'done');
      const host=document.createElement('div');host.innerHTML=TaskExecutionStream.rowsHtml(${JSON.stringify(page.items)},'done');
      return{thoughts:rows.filter(x=>x.type==='thinking').map(x=>x.item.text),
        usageRows:rows.filter(x=>x.type==='usage').length,outputCards:[...host.querySelectorAll('.ntool-name')].filter(x=>x.textContent==='输出').length,
        expanded:host.querySelector('.dks-thinking button')?.getAttribute('aria-expanded')}})()`);
    assert.deepEqual(runtimeView.thoughts, [...refinement.map(block => block.text), thought],
      agent.id + ": persisted renderer keeps refinement separate and deduplicates native reasoning");
    assert.equal(runtimeView.outputCards, 0); assert.equal(runtimeView.usageRows, 0);
    assert.equal(runtimeView.expanded, 'false');
    await js(`window.SoduWorkAPI={listAttachments:cloudFixture.attachments,attachmentUrl:row=>${JSON.stringify(identity.hub)}+row.url};
      (async()=>{const files=await ChatOutputLinks.load(soduWorkAPI.conversationSession,'preview-fixture',[${JSON.stringify(taskId)}],[],SoduWorkAPI);
      window.previewMarkdown='已生成 [交付报告](delivery.md)。';configure(files);window.loadedOutputs=files;})()`);
    await until(() => js('!!document.querySelector("[data-open-app]")'), 'clickable filename');
    assert.equal(await js('loadedOutputs.some(row=>row.name.includes("workspace.zip"))'), false);
    await click('[data-open-app]');
    await until(() => js('document.querySelector(".ncw")?.textContent.includes("Delivered from independent cloud workspace")'), 'right workspace Markdown');
    assert.equal(await js('ChatWorkbench.state().open'), true);
    assert.deepEqual(await js('errors'), []);
    await pause(200); // Allow the Chromium compositor to present the verified DOM.
    await fs.writeFile(path.join(output, agent.id + '-workspace.png'), (await win.webContents.capturePage()).toPNG());
    const followup = await cloud.send(current, 'Keep the report title unchanged. Verify delivery again.', [], { submissionId: 'verify-' + agent.id });
    assert.equal(followup.ok, true, JSON.stringify(followup));
    await until(() => current.snapshot().messages.some(row => row.role === 'user' && row.text?.includes('Verify delivery again.')), 'cloud followup reflected in original chat');
    assert.equal(localStarts, 0);
    current.close(); current = null; win.destroy(); win = null;
    report.checks.push({ agent: agent.id, authenticatedHandoff: true, closeAndReopen: true,
      artifactCollected: true, filenameClickable: true, rightWorkspacePreview: true, followup: true, localReplays: localStarts,
      nativeReasoning: true, noThoughtToolCards: true, nativeUsageOrUnbilledAcpOccupancy: true });
  }
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors)); report.ok = true;
}).catch(error => { report.failure = error.stack || String(error); }).finally(async () => {
  current?.close(); if (win && !win.isDestroyed()) win.destroy();
  if (root) await fs.writeFile(path.join(root, 'stop'), '');
  if (backend) {
    await until(() => backend.exitCode !== null, 'fixture stopped', 20000).catch(() => backend.kill());
    if (root && sync.existsSync(path.join(root, 'calls.json'))) report.runnerCalls = JSON.parse(await fs.readFile(path.join(root, 'calls.json'), 'utf8'));
  }
  if (backendLog !== undefined) sync.closeSync(backendLog);
  await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, agents: report.checks.length, report: path.join(output, 'report.json'), failure: report.failure }));
  app.emit('before-quit'); app.exit(report.ok ? 0 : 1);
});
