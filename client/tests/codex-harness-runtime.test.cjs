const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createRunnerRuntimeAdapter,
  getRunnerSessionDetails,
  _skillRows,
  _uuidV5,
} = require('../main/agent-runtime/runner-adapter');
const runtimeCatalog = require('../main/agent-runtime/runtime-catalog');
const attachmentContract = require('../main/pi-session/attachment-contract');

const NAMESPACE = '9af442c8-cd1d-4b91-a668-22da2b2635bf';

function timeout(value, ms = 2000) {
  return Promise.race([
    Promise.resolve(value),
    new Promise((_, reject) => setTimeout(() => reject(new Error('test timeout')), ms)),
  ]);
}

async function until(check, ms = 1000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= end) throw new Error('condition timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function skillDir(root, name = 'frontend-design') {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'),
    '---\nname: ' + name + '\ndescription: Design polished interfaces for real users.\n---\n',
    'utf8');
  return dir;
}

test('Codex Harness sends complete Skill metadata and rejects malformed Skills', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-harness-skill-'));
  try {
    const valid = skillDir(root);
    const broken = path.join(root, 'broken');
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, 'SKILL.md'), '---\nname: broken\n---\n', 'utf8');
    assert.deepEqual(_skillRows([valid, broken]), [{
      name: 'frontend-design',
      description: 'Design polished interfaces for real users.',
      path: valid,
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Runner stages byte-only image attachments for non-Pi runtimes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runner-byte-attachment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const alias = 'byte-attachment';
  const ref = _uuidV5(NAMESPACE, 'chat:' + alias + ':qwen');
  const calls = [];
  const runtime = { async rpc(op, payload) {
    calls.push({ op, payload });
    if (op === 'job.dispatch') return { ok: true, data: { ref } };
    if (op === 'job.session') return { ok: true, data: {
      ok: true, status: 'done', items: [{ seq: 1, kind: 'say', text: '完成' }],
    } };
    return { ok: true, data: { ok: true } };
  } };
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: runtimeCatalog.runtime('qwen'),
    runnerRuntime: runtime,
    modelConfig: { fetchModel: async () => ({ ok: true, model: {
      id: 'fixture', baseUrl: 'http://fixture.invalid', key: 'secret', input: ['text', 'image'],
    } }) } });
  const session = await adapter.createSession({ runtimeId: 'test', identity: { clientId: 'test' },
    native: { runner: { openOptions: { ref, cwd: root } } } });
  t.after(() => session.dispose());
  const sent = session.send({ text: '分析下', attachments: [{
    name: '人才盘点封面.png', type: 'image/png', size: 4,
    data: new Uint8Array([137, 80, 78, 71]),
  }] });
  await sent.completion;
  const dispatch = calls.find(row => row.op === 'job.dispatch');
  assert.equal(dispatch.payload.localFiles.length, 1);
  assert.equal(dispatch.payload.localFiles[0].contentType, 'image/png');
  assert.ok(path.isAbsolute(dispatch.payload.localFiles[0].path));
  assert.match(dispatch.payload.localFiles[0].path, /\.soduwork-inputs[\\/]/);
  assert.equal(session.snapshot().messages[0].attachments[0].name, '人才盘点封面.png');
  assert.match(session.snapshot().messages[0].attachments[0].previewRef, /^att1\./);
});

test('conversation IPC exposes only safe model metadata and guards optional controls', () => {
  const source = ['ipc.js', 'goal-actions.js', 'open-reply.js'].map(name =>
    fs.readFileSync(path.join(__dirname, '../main/pi-session', name), 'utf8')).join('\n');
  assert.doesNotMatch(source, /model:\s*handle\.model/);
  assert.match(source, /contextWindowKnown:\s*rawModel\.modality === 'image' \? false : resolved\.contextWindowKnown/);
  assert.match(source, /access-control\/ipc/);
  assert.match(fs.readFileSync(path.join(__dirname, '../main/access-control/ipc.js'), 'utf8'), /typeof handle\.answerUi !== 'function'/);
  assert.match(source, /typeof s\.continueGoal !== 'function'/);
  assert.match(source, /typeof s\.pauseGoal === 'function'/);
  assert.match(source, /typeof s\.disableGoal === 'function'/);
});

test('Runner substrate is selectable only when installation and authentication are ready', async () => {
  const states = [
    [{ installed: true, state: 'ready', version: '1.2.3', bin: 'agent.exe' }, true],
    [{ installed: true, state: 'unauthed', why: '请先登录' }, false],
    [{ installed: true, state: 'nollm', why: '没有企业模型' }, false],
    [{ installed: false, state: 'missing', why: '还没安装' }, false],
  ];
  for (const [data, expected] of states) {
    const adapter = createRunnerRuntimeAdapter({
      runtimeSpec: runtimeCatalog.runtime('codex'),
      runnerRuntime: { rpc: async () => ({ ok: true, data }) },
    });
    const result = await adapter.detect();
    assert.equal(result.ok, expected, data.state);
    assert.equal(result.state, data.state);
  }
});

test('Codex Harness queues follow-ups FIFO, keeps transcript order and supports cancellation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-harness-runtime-'));
  const skill = skillDir(root);
  const alias = 'queue-contract';
  const expectedRef = _uuidV5(NAMESPACE, 'chat:' + alias + ':codex-harness');
  const calls = [];
  let releaseFirst;
  const firstPoll = new Promise((resolve) => { releaseFirst = resolve; });
  let polls = 0;
  const runtime = {
    async rpc(op, payload) {
      calls.push({ op, payload });
      if (op === 'job.dispatch') return { ok: true, data: { ref: expectedRef } };
      if (op === 'job.comment') return { ok: true, data: { ok: true } };
      if (op === 'job.session') {
        polls += 1;
        if (polls === 1) return firstPoll;
        return { ok: true, data: {
          ok: true, status: 'done', round: polls,
          items: [{ seq: polls, kind: 'say', text: '第二轮完成' }],
        } };
      }
      if (op === 'job.stop') return { ok: true, data: { ok: true } };
      throw new Error('unexpected rpc: ' + op);
    },
  };
  const adapter = createRunnerRuntimeAdapter({
    runnerRuntime: runtime,
    modelConfig: { fetchModel: async () => ({ ok: true, model: {
      id: 'fixture-coding-large-model', baseUrl: 'http://model.invalid', key: 'secret',
      input: ['text', 'image'], imageRouting: 'native',
    } }) },
  });
  let session;
  try {
    session = await adapter.createSession({
      runtimeId: 'test',
      identity: { clientId: 'test' },
      native: { runner: { openOptions: {
        ref: alias, cwd: root, identity: { clientId: 'test' }, skillDirs: [skill],
      } } },
    });
    const screenshot = path.join(root, '证据.png');
    fs.writeFileSync(screenshot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const first = session.send({ text: '第一轮', attachments: [{
      name: '证据.png', mimeType: 'image/png', size: 4, path: screenshot,
    }] });
    await until(() => calls.some((row) => row.op === 'job.session'));
    const followup = path.join(root, '补充.txt');
    fs.writeFileSync(followup, '补充材料', 'utf8');
    const second = session.send({ text: '第二轮', attachments: [{
      name: '补充.txt', mimeType: 'text/plain', size: 4, path: followup,
    }] });
    const removed = session.send({ text: '取消这一轮' });
    assert.equal(first.queued, false);
    assert.equal(second.queued, true);
    assert.match(second.queueId, /^turn-/);
    assert.equal(removed.position, 2);

    const details = getRunnerSessionDetails(session);
    assert.ok(details && details.handle);
    const cancelled = details.handle.cancelQueued(removed.queueId);
    assert.equal(cancelled.ok, true);
    assert.deepEqual(await removed.completion, { ok: true, cancelled: true, queued: true });
    assert.deepEqual(session.snapshot().execution.queue.map((row) => row.text), ['第二轮']);

    const dispatched = calls.find((row) => row.op === 'job.dispatch');
    assert.equal(dispatched.payload.localFiles[0].contentType, 'image/png',
      'staged desktop attachments must preserve mimeType across the Runner boundary');
    assert.equal(dispatched.payload.ctx.conversationMode, 'adaptive');
    assert.deepEqual(dispatched.payload.cfg.llm.input, ['text', 'image']);
    assert.equal(dispatched.payload.cfg.llm.imageRouting, 'native');
    assert.match(dispatched.payload.task.note, /不要把每条消息默认当成任务/);
    assert.match(dispatched.payload.task.note, /【用户原话】\s*第一轮/);
    assert.match(dispatched.payload.task.note, /<soduwork-conversation-input-understanding>/);
    assert.match(dispatched.payload.task.note, /证据\.png/);
    assert.equal(dispatched.payload.ctx.skills[0].description,
      'Design polished interfaces for real users.');
    releaseFirst({ ok: true, data: {
      ok: true, status: 'done', round: 1,
      items: [{ seq: 1, kind: 'say', text: '第一轮完成' }],
    } });
    assert.equal((await timeout(first.completion)).ok, true);
    assert.equal((await timeout(second.completion)).ok, true);

    const commented = calls.find((row) => row.op === 'job.comment');
    assert.equal(commented.payload.text, '第二轮');
    assert.equal(commented.payload.localFiles[0].contentType, 'text/plain',
      'follow-up attachments must preserve staged mimeType too');
    assert.match(commented.payload.promptText, /不要把每条消息默认当成任务/);
    assert.match(commented.payload.promptText, /【用户原话】\s*第二轮/);
    assert.equal(commented.payload.cfg.local_cli, 'codex-harness');
    assert.deepEqual(commented.payload.cfg.llm, {
      base: 'http://model.invalid', key: 'secret', model: 'fixture-coding-large-model',
      maxOutputTokens: 65536,
      input: ['text', 'image'], imageRouting: 'native',
      contextWindow: 128000, contextWindowKnown: true,
      contextWindowEstimated: true, contextWindowSource: 'safe-default',
    });
    assert.deepEqual(calls.filter((row) => row.op === 'job.comment')
      .map((row) => row.payload.text), ['第二轮']);
    assert.deepEqual(session.snapshot().messages.map((row) =>
      row.role === 'user' ? row.text : row.blocks[0].text),
    ['第一轮', '第一轮完成', '第二轮', '第二轮完成']);
    assert.deepEqual(session.snapshot().messages[0].attachments, [{
      name: '证据.png', type: 'image/png', size: 4,
      previewRef: attachmentContract.previewRef(screenshot),
    }]);
    assert.equal(JSON.stringify(session.snapshot().messages[0]).includes(root), false);
    assert.equal(session.snapshot().queued, 0);
  } finally {
    if (session) await session.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Runner admission queue is tracked as live work until resources start the Agent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runner-admission-'));
  const alias = 'admission-contract';
  const expectedRef = _uuidV5(NAMESPACE, 'chat:' + alias + ':codex-harness');
  let polls = 0;
  const runtime = {
    async rpc(op) {
      if (op === 'job.dispatch') return { ok: true, data: {
        ref: expectedRef, state: 'queued', queued: true,
        queuePosition: 3, queueClass: 'interactive',
      } };
      if (op === 'job.session') {
        polls += 1;
        if (polls === 1) return { ok: true, data: {
          ok: true, status: 'queued', queuePosition: 2,
          queueClass: 'interactive', items: [],
        } };
        if (polls === 2) return { ok: true, data: {
          ok: true, status: 'running', round: 1,
          items: [{ seq: 1, kind: 'say', text: '资源已释放，开始执行。' }],
        } };
        return { ok: true, data: {
          ok: true, status: 'completed', round: 1,
          items: [{ seq: 2, kind: 'say', text: '执行完成。' }],
        } };
      }
      if (op === 'job.stop') return { ok: true, data: { state: 'cancelled' } };
      throw new Error('unexpected rpc: ' + op);
    },
  };
  const adapter = createRunnerRuntimeAdapter({
    runnerRuntime: runtime,
    modelConfig: { fetchModel: async () => ({ ok: true, model: {
      id: 'fixture-coding-large-model', baseUrl: 'http://model.invalid', key: 'secret',
    } }) },
  });
  let session;
  try {
    session = await adapter.createSession({
      runtimeId: 'test', identity: { clientId: 'test' },
      native: { runner: { openOptions: {
        ref: alias, cwd: root, identity: { clientId: 'test' },
      } } },
    });
    const sent = session.send({ text: '即使忙也要先接住' });
    await until(() => session.snapshot().status === 'queued');
    const queued = session.snapshot();
    assert.equal(queued.running, true);
    assert.equal(queued.execution.queuePosition, 2);
    assert.equal(queued.execution.queueClass, 'interactive');
    assert.match(queued.statusText, /前面 2 项/);
    const result = await timeout(sent.completion, 4000);
    assert.equal(result.ok, true);
    assert.equal(polls, 3);
    assert.equal(session.snapshot().status, 'idle');
    assert.deepEqual(session.snapshot().messages.map((row) =>
      row.role === 'user' ? row.text : row.blocks[0].text),
    ['即使忙也要先接住', '资源已释放，开始执行。', '执行完成。']);
  } finally {
    if (session) await session.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Runner polling reconnects after a transient transport break without losing output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-harness-reconnect-'));
  const alias = 'reconnect-contract';
  const expectedRef = _uuidV5(NAMESPACE, 'chat:' + alias + ':codex-harness');
  let polls = 0;
  const runtime = {
    async rpc(op) {
      if (op === 'job.dispatch') return { ok: true, data: { ref: expectedRef } };
      if (op === 'job.session') {
        polls += 1;
        if (polls === 1) throw new Error('runner websocket restarted');
        if (polls === 2) return { ok: true, data: {
          ok: true, status: 'running', round: 1,
          items: [{ seq: 1, kind: 'say', text: '第一段已经接回' }],
        } };
        return { ok: true, data: {
          ok: true, status: 'done', round: 1,
          items: [{ seq: 2, kind: 'say', text: '任务正常完成' }],
        } };
      }
      if (op === 'job.stop') return { ok: true, data: { ok: true } };
      throw new Error('unexpected rpc: ' + op);
    },
  };
  const adapter = createRunnerRuntimeAdapter({
    runnerRuntime: runtime,
    modelConfig: { fetchModel: async () => ({ ok: true, model: {
      id: 'fixture-coding-large-model', baseUrl: 'http://model.invalid', key: 'secret',
    } }) },
  });
  let session;
  try {
    session = await adapter.createSession({
      runtimeId: 'test', identity: { clientId: 'test' },
      native: { runner: { openOptions: {
        ref: alias, cwd: root, identity: { clientId: 'test' },
      } } },
    });
    const sent = session.send({ text: '请完成并持续回传' });
    const result = await timeout(sent.completion, 4000);
    assert.equal(result.ok, true);
    assert.equal(polls, 3);
    assert.equal(session.snapshot().status, 'idle');
    assert.deepEqual(session.snapshot().messages.map((row) =>
      row.role === 'user' ? row.text : row.blocks[0].text),
    ['请完成并持续回传', '第一段已经接回', '任务正常完成']);
  } finally {
    if (session) await session.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

let scriptedTurnId = 0;

async function runScriptedHarnessTurn(agentText, sessionData = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-harness-scripted-'));
  const alias = 'scripted-' + (++scriptedTurnId);
  const expectedRef = _uuidV5(NAMESPACE, 'chat:' + alias + ':codex-harness');
  const runtime = {
    async rpc(op) {
      if (op === 'job.dispatch') return { ok: true, data: { ref: expectedRef } };
      if (op === 'job.session') return { ok: true, data: {
        ok: true, status: 'done', round: 1,
        items: [{ seq: 1, kind: 'say', text: agentText }],
        ...sessionData,
      } };
      if (op === 'job.stop') return { ok: true, data: { ok: true } };
      throw new Error('unexpected rpc: ' + op);
    },
  };
  const adapter = createRunnerRuntimeAdapter({
    runnerRuntime: runtime,
    modelConfig: { fetchModel: async () => ({ ok: true, model: {
      id: 'fixture-coding-large-model', baseUrl: 'http://model.invalid', key: 'secret',
    } }) },
  });
  let session;
  try {
    session = await adapter.createSession({
      runtimeId: 'test', identity: { clientId: 'test' },
      native: { runner: { openOptions: {
        ref: alias, cwd: root, identity: { clientId: 'test' },
      } } },
    });
    const sent = session.send({ text: '最小探针' });
    const result = await timeout(sent.completion);
    return { result, snapshot: session.snapshot() };
  } finally {
    if (session) await session.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test('Codex Harness exposes current context tokens separately from cumulative usage', async () => {
  const { result, snapshot } = await runScriptedHarnessTurn('CONTEXT_OK', {
    tokens: { input: 56000, output: 8000, total: 64000 },
    usage: { input: 900000, output: 10000, total: 910000 },
    ctxWindow: 100000,
    ctxWindowKnown: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(snapshot.contextUsage, { input: 56000, output: 8000, total: 64000 });
  assert.equal(snapshot.contextWindow, 100000);
  assert.equal(snapshot.contextWindowKnown, true);
  assert.deepEqual(snapshot.usage, { input: 900000, output: 10000, total: 910000 });
  assert.deepEqual(snapshot.tokens, snapshot.contextUsage);
  assert.deepEqual(snapshot.execution.tokens, snapshot.contextUsage);
});
test('Runner cumulative billing is unavailable as a context watermark', async () => {
  const { result, snapshot } = await runScriptedHarnessTurn('已完成', {
    usage: { input: 900000, output: 10000, total: 910000 },
  });
  assert.equal(result.ok, true);
  assert.equal(snapshot.contextUsage, null);
  assert.equal(snapshot.usage.input, 900000);
});
test('stopped Runner sessions distinguish the legacy initial counters from a measured zero', async () => {
  for (const [tokens, expected] of [
    [{ input: 0, output: 0, total: 0 }, null],
    [{}, null],
    [{ input: 0, inputIncludesCache: true }, { input: 0, inputIncludesCache: true }],
  ]) {
    const { snapshot } = await runScriptedHarnessTurn('stopped', { tokens, status: 'stopped' });
    assert.deepEqual(snapshot.contextUsage, expected);
  }
});
test('Codex Harness turns proxy JSON failures into a product error, not an answer', async () => {
  const raw = JSON.stringify({
    error: {
      message: 'HTTP 400',
      type: 'soduwork_work_proxy_error',
      code: 400,
      upstream: JSON.stringify({
        error: { message: 'deepseek-v4-flash is not a multimodal model' },
      }),
    },
  });
  const { result, snapshot } = await runScriptedHarnessTurn(raw);
  assert.equal(result.ok, false);
  assert.match(result.reason, /\u5f53\u524d\u6a21\u578b\u4e0d\u80fd\u76f4\u63a5\u8bfb\u53d6\u56fe\u7247/);
  assert.equal(snapshot.status, 'unreachable');
  assert.deepEqual(snapshot.messages.map((row) => row.role), ['user']);
});

test('Codex Harness exposes the same long-tool and stall signals as Pi', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-harness-status-'));
  const alias = 'status-contract';
  const expectedRef = _uuidV5(NAMESPACE, 'chat:' + alias + ':codex-harness');
  const old = new Date(Date.now() - 100000).toISOString();
  const calls = [];
  const runtime = {
    async rpc(op, payload) {
      calls.push({ op, payload });
      if (op === 'job.dispatch') return { ok: true, data: { ref: expectedRef } };
      if (op === 'job.session') return { ok: true, data: {
        ok: true, status: 'running', round: 1,
        items: Number(payload.since || 0) ? [] : [
          { seq: 1, kind: 'do', tool: 'browser check', text: 'inspect page', at: old },
        ],
      } };
      if (op === 'job.stop') return { ok: true, data: { ok: true } };
      throw new Error('unexpected rpc: ' + op);
    },
  };
  const adapter = createRunnerRuntimeAdapter({
    runnerRuntime: runtime,
    modelConfig: { fetchModel: async () => ({ ok: true, model: {
      id: 'fixture-coding-large-model', baseUrl: 'http://model.invalid', key: 'secret',
    } }) },
  });
  let session;
  try {
    session = await adapter.createSession({
      runtimeId: 'test', identity: { clientId: 'test' },
      native: { runner: { openOptions: {
        ref: alias, cwd: root, identity: { clientId: 'test' },
      } } },
    });
    const sent = session.send({ text: 'inspect' });
    await until(() => session.snapshot().tools.length === 1);
    const execution = session.snapshot().execution;
    assert.equal(execution.longRunning, true);
    assert.equal(execution.stalled, true);
    assert.ok(execution.idleMs >= 90000);
    assert.ok(execution.tool && execution.tool.elapsedMs >= 90000);
    session.cancel();
    assert.equal((await timeout(sent.completion)).cancelled, true);
  } finally {
    if (session) await session.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('Codex Harness removes protocol metadata warnings from assistant output', async () => {
  const { result, snapshot } = await runScriptedHarnessTurn(
    'Warning: Model metadata for `fixture-coding-large-model` not found. ' +
    'Defaulting to fallback metadata; this can degrade performance and cause issues.\n\nSODUWORK_OK');
  assert.equal(result.ok, true);
  assert.equal(snapshot.status, 'idle');
  assert.equal(snapshot.messages[1].blocks[0].text, 'SODUWORK_OK');
});

test('Codex Harness reports fatal protocol responses as failures, not assistant answers', async () => {
  const { result, snapshot } = await runScriptedHarnessTurn(
    'unexpected status 405 Method Not Allowed, url: http://model.invalid/v1/responses');
  assert.equal(result.ok, false);
  assert.match(result.reason, /405 Method Not Allowed/);
  assert.equal(snapshot.status, 'unreachable');
  assert.deepEqual(snapshot.messages.map((row) => row.role), ['user']);
});

test('Codex Harness explains an unsupported Responses endpoint without pretending another runtime ran', async () => {
  const { result, snapshot } = await runScriptedHarnessTurn(
    'unexpected status 404 Not Found, url: https://base-ai.mdiri.com/v1/responses');
  assert.equal(result.ok, false);
  assert.match(result.reason, /不支持 Codex Harness 所需的 Responses 接口/);
  assert.equal(snapshot.status, 'unreachable');
  assert.deepEqual(snapshot.messages.map((row) => row.role), ['user']);
});

test('Codex Harness persists user turns, deduplicates live events and rebuilds history', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-harness-transcript-'));
  const alias = 'transcript-contract';
  const expectedRef = _uuidV5(NAMESPACE, 'chat:' + alias + ':codex-harness');
  const calls = [];
  const events = [];
  const runtime = {
    async rpc(op, payload) {
      calls.push({ op, payload });
      if (op === 'job.dispatch') {
        events.push(
          { seq: 1, kind: 'user', text: payload.ctx.conversationUserText },
          { seq: 2, kind: 'say', text: 'FIRST_OK' },
        );
        return { ok: true, data: { ref: expectedRef } };
      }
      if (op === 'job.comment') {
        events.push(
          { seq: 3, kind: 'user', text: payload.text },
          { seq: 4, kind: 'say', text: 'SECOND_OK' },
        );
        return { ok: true, data: { ok: true } };
      }
      if (op === 'job.session') return { ok: true, data: {
        ok: true, status: 'done', round: events.length > 2 ? 2 : 1,
        items: events.filter((row) => row.seq > Number(payload.since || 0)),
      } };
      if (op === 'job.stop') return { ok: true, data: { ok: true } };
      throw new Error('unexpected rpc: ' + op);
    },
  };
  const adapter = createRunnerRuntimeAdapter({
    runnerRuntime: runtime,
    modelConfig: { fetchModel: async () => ({ ok: true, model: {
      id: 'fixture-coding-large-model', baseUrl: 'http://model.invalid', key: 'secret',
    } }) },
  });
  let live;
  let resumed;
  try {
    live = await adapter.createSession({
      runtimeId: 'test', identity: { clientId: 'test' },
      native: { runner: { openOptions: {
        ref: alias, cwd: root, identity: { clientId: 'test' },
      } } },
    });
    assert.equal((await timeout(live.send({ text: 'FIRST' }).completion)).ok, true);
    assert.equal((await timeout(live.send({ text: 'SECOND' }).completion)).ok, true);
    assert.deepEqual(live.snapshot().messages.map((row) =>
      row.role === 'user' ? row.text : row.blocks[0].text),
    ['FIRST', 'FIRST_OK', 'SECOND', 'SECOND_OK']);
    const dispatched = calls.find((row) => row.op === 'job.dispatch');
    const commented = calls.find((row) => row.op === 'job.comment');
    assert.equal(dispatched.payload.ctx.conversationUserText, 'FIRST');
    assert.equal(commented.payload.recordUser, true);
    await live.dispose();
    live = null;

    resumed = await adapter.resumeSession({
      runtimeId: 'test', identity: { clientId: 'test' },
      native: { runner: { openOptions: {
        ref: 'restored-alias', resumePath: expectedRef, cwd: root,
        identity: { clientId: 'test' },
      } } },
    });
    await until(() => resumed.snapshot().status === 'idle' &&
      resumed.snapshot().messages.length === 4);
    assert.deepEqual(resumed.snapshot().messages.map((row) =>
      row.role === 'user' ? row.text : row.blocks[0].text),
    ['FIRST', 'FIRST_OK', 'SECOND', 'SECOND_OK']);
  } finally {
    if (live) await live.dispose();
    if (resumed) await resumed.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex Harness latches an immediate cancel until dispatch returns its real session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-harness-cancel-race-'));
  const alias = 'cancel-race-contract';
  const expectedRef = _uuidV5(NAMESPACE, 'chat:' + alias + ':codex-harness');
  const calls = [];
  let releaseDispatch;
  const dispatchReply = new Promise((resolve) => { releaseDispatch = resolve; });
  const runtime = {
    async rpc(op, payload) {
      calls.push({ op, payload });
      if (op === 'job.dispatch') return dispatchReply;
      if (op === 'job.stop') return { ok: true, data: { ok: true } };
      if (op === 'job.comment') return { ok: true, data: { ok: true } };
      if (op === 'job.session') return { ok: true, data: {
        ok: true, status: 'done', items: [{ seq: 1, kind: 'say', text: 'AFTER_STOP_OK' }],
      } };
      throw new Error('unexpected rpc: ' + op);
    },
  };
  const adapter = createRunnerRuntimeAdapter({
    runnerRuntime: runtime,
    modelConfig: { fetchModel: async () => ({ ok: true, model: {
      id: 'fixture-coding-large-model', baseUrl: 'http://model.invalid', key: 'secret',
    } }) },
  });
  let session;
  try {
    session = await adapter.createSession({
      runtimeId: 'test', identity: { clientId: 'test' },
      native: { runner: { openOptions: {
        ref: alias, cwd: root, identity: { clientId: 'test' },
      } } },
    });
    const sent = session.send({ text: 'create a file that must never be written' });
    assert.equal(sent.queued, false);
    assert.equal(session.snapshot().status, 'streaming');

    assert.deepEqual(session.cancel(), { ok: true });
    assert.equal(session.snapshot().status, 'aborted');
    assert.equal(calls.filter((row) => row.op === 'job.stop').length, 0);
    const completion = await timeout(sent.completion);
    assert.equal(completion.ok, true);
    assert.equal(completion.cancelled, true);
    assert.equal(completion.snapshot.status, 'aborted');

    releaseDispatch({ ok: true, data: { ref: expectedRef } });
    await until(() => calls.some((row) => row.op === 'job.stop'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.filter((row) => row.op === 'job.stop').length, 1);
    assert.equal(calls.some((row) => row.op === 'job.session'), false);
    assert.equal(session.snapshot().status, 'aborted');

    const next = session.send({ text: 'send directly after stop' });
    assert.equal(next.queued, false);
    assert.equal((await timeout(next.completion)).ok, true);
    assert.equal(calls.filter((row) => row.op === 'job.comment').length, 1);
    assert.equal(calls.find((row) => row.op === 'job.comment').payload.text,
      'send directly after stop');
  } finally {
    if (session) await session.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex Harness restores its in-memory model grant after Runner restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-harness-reauthorize-'));
  const alias = 'reauthorize-contract';
  const expectedRef = _uuidV5(NAMESPACE, 'chat:' + alias + ':codex-harness');
  const calls = [];
  let polls = 0;
  const runtime = {
    async rpc(op, payload) {
      calls.push({ op, payload });
      if (op === 'job.dispatch') return { ok: true, data: { ref: expectedRef } };
      if (op === 'job.authorize') return { ok: true, data: { ok: true, accepted: true } };
      if (op === 'job.session') {
        polls += 1;
        if (polls === 1) return { ok: true, data: {
          ok: true, status: 'running', round: 1, authorizationRequired: true,
          items: [{ seq: 1, kind: 'say', text: '已经完成第一阶段。' }],
        } };
        return { ok: true, data: {
          ok: true, status: 'done', round: 1, authorizationRequired: false,
          items: [{ seq: 2, kind: 'say', text: '恢复后继续完成。' }],
        } };
      }
      if (op === 'job.stop') return { ok: true, data: { ok: true } };
      throw new Error('unexpected rpc: ' + op);
    },
  };
  const adapter = createRunnerRuntimeAdapter({
    runnerRuntime: runtime,
    modelConfig: { fetchModel: async () => ({ ok: true, model: {
      id: 'dev-think-large-agent-soduwork', baseUrl: 'http://model.invalid', key: 'secret',
    } }) },
  });
  let session;
  try {
    session = await adapter.createSession({
      runtimeId: 'test', identity: { clientId: 'test' },
      native: { runner: { openOptions: {
        ref: alias, cwd: root, identity: { clientId: 'test' },
        capabilityIds: ['terminal', 'files'],
      } } },
    });
    const sent = session.send({ text: '完成完整目标' });
    assert.equal((await timeout(sent.completion)).ok, true);
    const authorization = calls.find((row) => row.op === 'job.authorize');
    assert.ok(authorization, 'active reclaimed run should be re-authorized once');
    assert.deepEqual(authorization.payload.cfg, {
      local_cli: 'codex-harness',
      requiredCapabilities: ['terminal', 'files'],
      llm: {
        base: 'http://model.invalid', key: 'secret', model: 'dev-think-large-agent-soduwork',
        maxOutputTokens: 65536,
        contextWindow: 128000, contextWindowKnown: true,
        contextWindowEstimated: true, contextWindowSource: 'safe-default',
      },
    });
    assert.ok(calls.some((row) => row.op === 'runtime.detect'), 'legacy session probes optional permission support');
    assert.deepEqual(calls.filter((row) => row.op !== 'runtime.detect').map((row) => row.op), [
      'job.dispatch', 'job.session', 'job.authorize', 'job.session',
    ]);
    assert.deepEqual(session.snapshot().messages.map((row) =>
      row.role === 'user' ? row.text : row.blocks[0].text),
    ['完成完整目标', '已经完成第一阶段。', '恢复后继续完成。']);
  } finally {
    if (session) await session.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const runtimeSpec of runtimeCatalog.runnerRuntimes()) {
  test(runtimeSpec.displayName + ' dispatches with the correct credential mode', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runtime-mode-'));
    const alias = 'mode-' + runtimeSpec.id;
    const expectedRef = _uuidV5(NAMESPACE, 'chat:' + alias + ':' + runtimeSpec.id);
    const calls = [];
    let modelFetches = 0;
    const runtime = {
      async rpc(op, payload) {
        calls.push({ op, payload });
        if (op === 'job.dispatch') return { ok: true, data: { ref: expectedRef } };
        if (op === 'job.session') return { ok: true, data: {
          ok: true, status: 'done', round: 1,
          items: [{ seq: 1, kind: 'say', text: 'RUNTIME_OK' }],
        } };
        if (op === 'job.stop') return { ok: true, data: { ok: true } };
        throw new Error('unexpected rpc: ' + op);
      },
    };
    const adapter = createRunnerRuntimeAdapter({
      runtimeSpec,
      runnerRuntime: runtime,
      modelConfig: { fetchModel: async () => {
        modelFetches += 1;
        return { ok: true, model: {
          id: 'enterprise-model', baseUrl: 'http://model.invalid', key: 'secret',
          maxOutputTokens: 65536, runtimeRevision: 'fixture-runtime-v2',
          capabilityProfile: { imageInput: { state: 'supported', source: 'verified' } },
        } };
      } },
    });
    let session;
    try {
      session = await adapter.createSession({
        runtimeId: 'test', identity: { clientId: 'test' },
        native: { runner: { openOptions: { ref: alias, cwd: root } } },
      });
      assert.equal((await timeout(session.send({ text: 'RUN' }).completion)).ok, true);
      const dispatched = calls.find((row) => row.op === 'job.dispatch').payload;
      assert.equal(dispatched.cli, runtimeSpec.id);
      assert.equal(dispatched.cfg.local_cli, runtimeSpec.id);
      if (runtimeSpec.modelMode === 'account') {
        assert.equal(modelFetches, 0);
        assert.equal(Object.hasOwn(dispatched.cfg, 'llm'), false);
      } else {
        assert.equal(modelFetches, 1);
        assert.deepEqual(dispatched.cfg.llm, {
          base: 'http://model.invalid', key: 'secret', model: 'enterprise-model',
          maxOutputTokens: 65536, runtimeRevision: 'fixture-runtime-v2',
          capabilityProfile: { imageInput: { state: 'supported', source: 'verified' } },
          contextWindow: 128000, contextWindowKnown: true,
          contextWindowEstimated: true, contextWindowSource: 'safe-default',
        });
      }
    } finally {
      if (session) await session.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('Runner goal pause keeps the native session and resumes without a fake user turn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runner-goal-'));
  const alias = 'goal-native-loop';
  const expectedRef = _uuidV5(NAMESPACE, 'chat:' + alias + ':codex-harness');
  const calls = [];
  let resumed = false;
  const runtime = {
    async rpc(op, payload) {
      calls.push({ op, payload });
      if (op === 'job.dispatch') return { ok: true, data: { ref: expectedRef } };
      if (op === 'job.stop') return { ok: true, data: { ok: true } };
      if (op === 'job.comment') {
        resumed = true;
        return { ok: true, data: { ok: true } };
      }
      if (op === 'job.session') return { ok: true, data: {
        ok: true, status: resumed ? 'done' : 'running', round: resumed ? 2 : 1,
        items: resumed ? [{ seq: 1, kind: 'say', text: 'GOAL_DONE' }] : [],
      } };
      throw new Error('unexpected rpc: ' + op);
    },
  };
  const adapter = createRunnerRuntimeAdapter({
    runnerRuntime: runtime,
    modelConfig: { fetchModel: async () => ({ ok: true, model: {
      id: 'enterprise-model', baseUrl: 'http://model.invalid', key: 'secret',
    } }) },
  });
  let session;
  try {
    session = await adapter.createSession({
      runtimeId: 'test', identity: { clientId: 'test' },
      native: { runner: { openOptions: {
        ref: alias, cwd: root, intent: 'goal',
        goal: 'deliver a complete result', acceptance: 'verified',
      } } },
    });
    const first = session.send({ text: 'START' });
    await until(() => calls.some((row) => row.op === 'job.session'));
    const queued = session.send({ text: 'QUEUED_AFTER_START' });
    assert.equal(queued.queued, true);
    assert.equal(session.controlGoal('pause').ok, true);
    assert.equal((await timeout(first.completion)).paused, true);
    await until(() => calls.some((row) => row.op === 'job.stop'));
    assert.equal(session.snapshot().execution.paused, true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls.filter((row) => row.op === 'job.comment').length, 0);
    assert.equal(session.snapshot().queued, 1);
    const handle = getRunnerSessionDetails(session).handle;
    assert.equal(handle.cancelQueued(queued.queueId).ok, true);

    const continued = session.controlGoal('continue');
    assert.equal(continued.ok, true);
    assert.equal((await timeout(continued.completion)).ok, true);
    const comment = calls.find((row) => row.op === 'job.comment').payload;
    assert.equal(comment.recordUser, false);
    assert.match(comment.promptText, /原目标/);
    assert.deepEqual(session.snapshot().messages.map((row) => row.role),
      ['user', 'assistant']);

    const next = session.send({ text: 'RUN_AGAIN' });
    assert.equal(next.queued, false);
    assert.equal(session.controlGoal('pause').ok, true);
    assert.equal((await timeout(next.completion)).paused, true);
    await until(() => calls.filter((row) => row.op === 'job.stop').length === 2);
  } finally {
    if (session) await session.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
