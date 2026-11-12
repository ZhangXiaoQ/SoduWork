const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepare } = require('../main/pi-session/acceptance-turn');
test.beforeEach(() => require('../main/native-locale.cjs').setLocale('zh-CN'));

function fixture(t, overrides = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-turn-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const context = { task: { id: 't', title: '作文', note: '写一篇400字作文' },
    approvalId: 'approval', artifactVersionId: 'v1', requirementVersion: 2,
    criteria: [{ id: 'c1', label: '字数400字' }], evidence: [{ id: 'file-a' }],
    attachmentIds: ['file-a'], canDecide: true, ...overrides };
  const calls = [], notices = [];
  const runtime = { handle: { cwd, sessionId: 'chat', adapterId: 'pi',
    appendTaskMessage: (...args) => notices.push(args) } };
  const request = async (identity, route, body) => {
    calls.push({ route, body });
    return body ? { ok: true, verdict: body.report.verdict === 'approve' ? 'approved' : 'rejected', closed: true } : context;
  };
  return { context, calls, notices, runtime, request, cwd };
}

test('人工分析使用验收提示与固定版本，完成后不提交决策或执行原需求', async t => {
  const f = fixture(t);
  const turn = await prepare({ identity: {}, taskId: 't', instruction: '检查文风',
    requested: {}, runtime: f.runtime, request: f.request });
  assert.match(turn.text, /验收分析/); assert.match(turn.text, /检查文风/);
  assert.match(turn.text, /不.*重新执行|不要.*重新执行/);
  assert.match(turn.text, /交付成果/);
  assert.match(turn.text, /验收确认卡/);
  assert.deepEqual(turn.attachmentIds, ['file-a']);
  assert.equal(turn.afterTurn, undefined);
  assert.ok(f.calls.every(c => !c.body));
});

test('自动验收仅在本轮成功并提供完整报告后提交当前固定版本', async t => {
  const f = fixture(t);
  const turn = await prepare({ identity: {}, taskId: 't', requested: { acceptanceMode: 'auto' },
    runtime: f.runtime, request: f.request });
  assert.match(turn.text, /字数400字/);
  await turn.beforeTurn();
  fs.writeFileSync(turn.reportPath, JSON.stringify({ verdict: 'approve', summary: '正文共400字',
    checks: [{ criterion: 'c1', result: 'pass', evidence: '结果.md正文400字，按汉字统计' }] }));
  await turn.afterTurn('completed');
  const post = f.calls.find(c => c.body);
  assert.equal(post.route, '/tasks/t/auto-review');
  assert.equal(post.body.artifactVersionId, 'v1');
  assert.equal(post.body.requirementVersion, 2);
  assert.equal(post.body.execution.conversationId, 'chat');
  assert.equal(post.body.report.checks[0].criterion, 'c1');
  assert.match(f.notices[0][1], /验收通过/);
  assert.match(f.notices[0][1], /字数400字/);
  assert.doesNotMatch(f.notices[0][1], /c1:/);
});

test('停止、失败、缺报告和标准不足都不自动批准', async t => {
  const f = fixture(t);
  const turn = await prepare({ identity: {}, taskId: 't', requested: { acceptanceMode: 'auto' },
    runtime: f.runtime, request: f.request });
  await turn.afterTurn('stopped'); await turn.afterTurn('failed');
  await assert.rejects(turn.afterTurn('completed'), /验收报告/);
  assert.ok(f.calls.every(c => !c.body));
  f.context.criteria = [];
  await assert.rejects(prepare({ identity: {}, taskId: 't', requested: { acceptanceMode: 'auto' },
    runtime: f.runtime, request: f.request }), /验收标准/);
});

test('manual-only deliveries reject automatic review before execution, including queued and older Hub contexts', async t => {
  const f = fixture(t, { readiness: { requiresHumanConfirmation: true } });
  const options = { identity: {}, taskId: 't', requested: { acceptanceMode: 'auto' }, runtime: f.runtime, request: f.request };
  await assert.rejects(prepare(options), /手动验收/);
  const analysis = await prepare({ ...options, requested: {} });
  assert.equal(analysis.afterTurn, undefined);
  f.context.readiness.requiresHumanConfirmation = false;
  const queued = await prepare(options);
  f.context.readiness.requiresHumanConfirmation = true;
  await assert.rejects(queued.beforeTurn(), /手动验收/);
  delete f.context.readiness;
  f.context.artifact = { kind: 'manual', manifest: { manual: true } };
  await assert.rejects(prepare(options), /手动验收/);
  assert.ok(f.calls.every(call => !call.body));
});

test('review bubbles preserve business text while machine identifiers remain in model context', async t => {
  const f = fixture(t, { artifact: { id: 'artifact-secret-id', checksum: 'digest', manifest: { complete: true } },
    attachments: [{ id: 'file-a', filename: '交付物.md' }] });
  const turn = await prepare({ identity: {}, taskId: 't', instruction: '检查文风', requested: { acceptanceMode: 'auto' },
    runtime: f.runtime, request: f.request });
  assert.match(turn.displayText, /作文/); assert.match(turn.displayText, /字数400字/);
  assert.match(turn.displayText, /交付物.md/); assert.match(turn.displayText, /检查文风/);
  assert.doesNotMatch(turn.displayText, /artifact-secret-id|file-a|digest|criterion|checks|验收报告-/);
  assert.match(turn.text, /artifact-secret-id/); assert.match(turn.text, /file-a/);
  assert.match(turn.text, /criterion/); assert.match(turn.text, /验收报告-/);
});

test('排队期间产出更新或审核权收回时拒绝使用旧快照', async t => {
  const f = fixture(t);
  const turn = await prepare({ identity: {}, taskId: 't', requested: { acceptanceMode: 'auto' },
    runtime: f.runtime, request: f.request });
  f.context.artifactVersionId = 'v2';
  await assert.rejects(turn.beforeTurn(), /版本.*变化/);
  assert.ok(f.calls.every(c => !c.body));
});

test('自动验收不会从上轮报告或不完整检查项中推断通过', async t => {
  const f = fixture(t);
  const options = { identity: {}, taskId: 't', requested: { acceptanceMode: 'auto' }, runtime: f.runtime, request: f.request };
  const a = await prepare(options), b = await prepare(options);
  assert.notEqual(a.reportPath, b.reportPath);
  fs.writeFileSync(b.reportPath, JSON.stringify({ verdict: 'approve', summary: '有附件', checks: [] }));
  await assert.rejects(b.afterTurn('completed'), /验收报告/);
  assert.ok(f.calls.every(c => !c.body));
});

test('过程文件默认不进入验收上下文，明确选择后才按附件 ID 读取', async t => {
  const f = fixture(t, {
    attachmentIds: ['file-a'],
    attachments: [{id: 'file-a', filename: '交付物.md'}],
    optionalAttachments: [
      {id: 'process-a', filename: '过程记录.md', role: 'process', size: 120},
      {id: 'verify-a', filename: '核验截图.png', role: 'verification', size: 240},
      {id: 'old-output', filename: '上一轮交付.md', role: 'output', size: 320},
    ],
  });
  const base = await prepare({ identity: {}, taskId: 't', requested: {}, runtime: f.runtime, request: f.request });
  assert.deepEqual(base.attachmentIds, ['file-a']);
  assert.doesNotMatch(base.text, /过程记录\.md/);
  assert.doesNotMatch(base.text, /上一轮交付\.md/);
  const selected = await prepare({ identity: {}, taskId: 't',
    requested: { acceptanceAttachmentIds: ['process-a'] }, runtime: f.runtime, request: f.request });
  assert.deepEqual(selected.attachmentIds, ['file-a', 'process-a']);
  assert.match(selected.text, /过程记录\.md/);
  assert.match(selected.displayText, /交付成果\n- 交付物\.md\n\n过程与验证材料\n- 过程记录\.md/);
  assert.doesNotMatch(selected.displayText, /上一轮交付\.md|核验截图\.png|process-a/);
  await assert.rejects(prepare({ identity: {}, taskId: 't',
    requested: { acceptanceAttachmentIds: ['missing'] }, runtime: f.runtime, request: f.request }), /过程文件已变化/);
});

test('requirement references are mandatory read-only review inputs, separate from optional evidence', async t => {
  const reference = { id: 'reference-a', filename: '原始参考.md', role: 'input', size: 8 };
  const f = fixture(t, { attachments: [{ id: 'file-a', filename: '交付物.md' }],
    optionalAttachments: [reference, { id: 'process-a', filename: '过程.md', role: 'process' },
      { id: 'old-a', filename: '旧交付.md', role: 'output' }] });
  for (const acceptanceMode of ['manual', 'auto']) {
    const turn = await prepare({ identity: {}, taskId: 't',
      requested: { acceptanceMode, acceptanceAttachmentIds: ['reference-a'] },
      runtime: f.runtime, request: f.request });
    assert.deepEqual(turn.attachmentIds, ['file-a', 'reference-a']);
    assert.deepEqual(turn.referenceAttachmentIds, ['reference-a']);
    assert.deepEqual(turn.optionalAttachmentIds, []);
    assert.match(turn.text, /原始参考\.md.*只读参考，不是交付物/);
    assert.match(turn.displayText, /交付成果\n- 交付物\.md\n\n需求附件\n- 原始参考\.md/);
    assert.doesNotMatch(turn.displayText, /reference-a|过程\.md|旧交付\.md/);
    await turn.beforeTurn();
    reference.id = 'reference-replaced';
    await assert.rejects(turn.beforeTurn(), /验收版本已变化/);
    reference.id = 'reference-a';
  }
  assert.ok(f.calls.every(call => !call.body), 'preparation must never decide or execute the requirement');
});

test('自动验收退回时输出返修卡并显示实际返修去向', async t => {
  const f = fixture(t);
  const originalRequest = f.request;
  f.request = async (identity, route, body) => {
    const result = await originalRequest(identity, route, body);
    return body ? { ...result, rework: { started: true } } : result;
  };
  const turn = await prepare({ identity: {}, taskId: 't', requested: { acceptanceMode: 'auto' },
    runtime: f.runtime, request: f.request });
  fs.writeFileSync(turn.reportPath, JSON.stringify({ verdict: 'reject', summary: '字数不足',
    checks: [{ criterion: 'c1', result: 'fail', evidence: '正文只有 280 字' }] }));
  await turn.afterTurn('completed');
  assert.match(f.notices[0][1], /验收退回卡/);
  assert.match(f.notices[0][1], /原 AI 已继续修改/);
});

test('rejected delivery reports executor confirmation without claiming a missing session or automatic rework', async t => {
  const f = fixture(t);
  const request = async (identity, route, body) => {
    const result = await f.request(identity, route, body);
    return body ? { ...result, rework: { started: false, waitingForExecutor: true } } : result;
  };
  const turn = await prepare({ identity: {}, taskId: 't', requested: { acceptanceMode: 'auto' },
    runtime: f.runtime, request });
  fs.writeFileSync(turn.reportPath, JSON.stringify({ verdict: 'reject', summary: '字数不足',
    checks: [{ criterion: 'c1', result: 'fail', evidence: '正文只有 280 字' }] }));
  await turn.afterTurn('completed');
  await turn.afterTurn('completed');
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0][1], /等待执行人根据返修意见继续修正/);
  assert.doesNotMatch(f.notices[0][1], /未找到可续跑会话|原 AI 已继续修改/);
  assert.equal(f.calls.filter(call => call.body).length, 1);
});

test('同人复用原执行会话只允许绑定的执行设备和需求进入验收轮次', async t => {
  const f = fixture(t, { task: {
    id: 't', title: '作文', note: '写一篇400字作文', ownerClientId: 'client-1',
    workRouting: { conversationTurn: { conversationId: 'chat' } },
  }});
  f.runtime.handle.taskIds = ['t'];
  const turn = await prepare({ identity: { clientId: 'client-1' }, taskId: 't',
    requested: { acceptanceExecutionSession: true }, runtime: f.runtime, request: f.request });
  assert.equal(turn.acceptanceOnly, true);
  await assert.rejects(prepare({ identity: { clientId: 'other-client' }, taskId: 't',
    requested: { acceptanceExecutionSession: true }, runtime: f.runtime, request: f.request }), /执行设备/);
  await assert.rejects(prepare({ identity: { clientId: 'client-1' }, taskId: 't',
    requested: { acceptanceExecutionSession: true }, runtime: { ...f.runtime,
      handle: { ...f.runtime.handle, sessionId: 'another-chat' } }, request: f.request }), /原执行会话/);
  await assert.rejects(prepare({ identity: { clientId: 'client-1' }, taskId: 't',
    requested: { acceptanceExecutionSession: true }, runtime: { ...f.runtime,
      handle: { ...f.runtime.handle, taskIds: ['other-task'] } }, request: f.request }), /尚未绑定/);
});

test('验收上下文失去当前验收权限时不能借用普通执行会话', async t => {
  const f = fixture(t, { canDecide: false, task: {
    id: 't', ownerClientId: 'client-1', workRouting: { conversationTurn: { conversationId: 'chat' } },
  }});
  f.runtime.handle.taskIds = ['t'];
  await assert.rejects(prepare({ identity: { clientId: 'client-1' }, taskId: 't',
    requested: { acceptanceExecutionSession: true }, runtime: f.runtime, request: f.request }), /指定验收人/);
});

test('同执行人与验收人复用原执行会话时，验收轮次必须绑定会话、设备和需求', async t => {
  const f = fixture(t, {
    task: {
      id: 't', title: '作文', note: '写一篇400字作文', ownerClientId: 'device-1',
      workRouting: { conversationTurn: { conversationId: 'chat' } },
    },
  });
  f.runtime.handle.taskRef = 't';
  const turn = await prepare({
    identity: { clientId: 'device-1' }, taskId: 't',
    requested: { acceptanceExecutionSession: true }, runtime: f.runtime, request: f.request,
  });
  assert.match(turn.text, /验收分析/);
  await turn.beforeTurn();
  assert.equal(f.calls.length, 2);
});

test('复用原执行会话时拒绝会话、设备或需求绑定不一致', async t => {
  const cases = [
    {
      label: '会话',
      runtime: { sessionId: 'other', taskRef: 't' },
      identity: { clientId: 'device-1' },
      expected: /原执行会话已不存在/,
    },
    {
      label: '设备',
      runtime: { sessionId: 'chat', taskRef: 't' },
      identity: { clientId: 'device-2' },
      expected: /原执行会话不属于当前执行设备/,
    },
    {
      label: '需求',
      runtime: { sessionId: 'chat', taskRef: 'other-task' },
      identity: { clientId: 'device-1' },
      expected: /原执行会话尚未绑定这项需求/,
    },
  ];
  for (const item of cases) {
    const f = fixture(t, {
      task: {
        id: 't', title: '作文', note: '写一篇400字作文', ownerClientId: 'device-1',
        workRouting: { conversationTurn: { conversationId: 'chat' } },
      },
    });
    Object.assign(f.runtime.handle, item.runtime);
    await assert.rejects(prepare({
      identity: item.identity, taskId: 't', requested: { acceptanceExecutionSession: true },
      runtime: f.runtime, request: f.request,
    }), item.expected, item.label);
  }
});

test('验收准备与排队前复核都要求 Hub 明确授予当前账号决策权', async t => {
  const f = fixture(t, { canDecide: false });
  await assert.rejects(prepare({ identity: {}, taskId: 't', requested: {},
    runtime: f.runtime, request: f.request }), /当前账号不是本次指定验收人/);

  const linked = fixture(t, {
    canDecide: true,
    task: { id: 't', title: '作文', ownerClientId: 'device-1',
      workRouting: { conversationTurn: { conversationId: 'chat' } } },
  });
  linked.runtime.handle.taskRef = 't';
  const turn = await prepare({ identity: { clientId: 'device-1' }, taskId: 't',
    requested: { acceptanceExecutionSession: true }, runtime: linked.runtime, request: linked.request });
  linked.context.canDecide = false;
  await assert.rejects(turn.beforeTurn(), /本次验收权限已变化/);

  const missingTask = fixture(t, {
    task: { id: 't', title: '作文', ownerClientId: 'device-1',
      workRouting: { conversationTurn: { conversationId: 'chat' } } },
  });
  missingTask.runtime.handle.taskRef = 't';
  let initialContext = true;
  const linkedTurn = await prepare({ identity: { clientId: 'device-1' }, taskId: 't',
    requested: { acceptanceExecutionSession: true }, runtime: missingTask.runtime,
    request: async (identity, route, body) => {
      if (body) return missingTask.request(identity, route, body);
      const result = { ...missingTask.context };
      if (!initialContext) result.task = undefined;
      initialContext = false;
      return result;
    } });
  await assert.rejects(linkedTurn.beforeTurn(), /原执行会话已不存在/);
});
test('oversized acceptance context is compacted without losing review metadata', async t => {
  const f = fixture(t, {
    task: { id: 't', title: 'Large task', note: 'note-' + 'x'.repeat(70000) },
    artifact: { version: 'v1', gallery: 'g'.repeat(70000) },
    evidence: [{ id: 'evidence-1', detail: 'e'.repeat(70000) }],
    optionalAttachments: [{ id: 'optional-proof', filename: 'verification.txt', size: 42 }],
    criteria: [
      { id: 'criterion-one', label: 'criterion-one-' + 'c'.repeat(70000) },
      { id: 'criterion-two', label: 'criterion-two' },
    ],
  });
  const turn = await prepare({ identity: {}, taskId: 't',
    requested: { acceptanceMode: 'auto', acceptanceAttachmentIds: ['optional-proof'] }, runtime: f.runtime, request: f.request });
  assert.ok(turn.text.length < 50000);
  assert.match(turn.text, /需求：Large task/);
  assert.match(turn.text, /本次固定交付版本：v1/);
  assert.match(turn.text, /optional-proof/);
  assert.equal(turn.text.split('已有证据：').length, 2);
  assert.match(turn.text, /criterion-one/);
  assert.match(turn.text, /criterion-two/);
  assert.match(turn.text, /Some content omitted/);
  assert.ok(turn.displayText.length < 16000);
  assert.doesNotMatch(turn.displayText, /Some content omitted|Read the bound attachments|optional-proof/);
  assert.ok(turn.reportPath);
  await turn.beforeTurn();
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(c => !c.body));
});
