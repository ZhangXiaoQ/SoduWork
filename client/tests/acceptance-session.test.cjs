'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const acceptance = require('../main/conversation/acceptance-session');

function identity(uid = 'verifier', hub = 'https://hub.example.test', clientId = 'device') {
  const now = Math.floor(Date.now() / 1000);
  const claims = { typ: 'device', uid, cid: clientId, iat: now - 1, exp: now + 3600 };
  return { hub, clientId, session: Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + '0'.repeat(64) };
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-session-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('acceptance-session-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, app: { getPath: () => directory }, handle: { sessionId: 'review-chat', taskRef: 'task-1' } };
}
const options = { acceptanceSession: true, taskRef: 'task-1', acceptanceMode: 'auto', approvalId: 'review-1', resumed: false };
const metadataFile = fixture => path.join(fixture.directory, 'acceptance-session-context',
  crypto.createHash('sha256').update('review-chat').digest('hex') + '.json');

test('history labels distinguish persisted review purpose without renaming the execution', async t => {
  const f = fixture(t);
  await acceptance.attach(f.app, f.handle, {...options, acceptanceMode: 'manual'}, identity());
  const original = {id: 'review-chat', title: 'Requirement', at: Date.now()};
  const row = acceptance.projectHistory(f.app, original);
  assert.match(row.title, /^验收分析 · Requirement · /);
  assert.equal(row.acceptanceReview.approvalId, 'review-1');
  assert.equal(acceptance.projectHistory(f.app, row).title, row.title);
  assert.equal(original.title, 'Requirement');
  assert.equal(acceptance.projectHistory(f.app, {...original, id: 'execution'}).title, 'Requirement');
});

test('自动验收模式、需求和审批单随原会话恢复，不依赖渲染层重新传参', async t => {
  const f = fixture(t);
  await acceptance.attach(f.app, f.handle, options, identity());
  const restored = { sessionId: 'review-chat' };
  await acceptance.attach(f.app, restored, { resumed: true }, identity());
  assert.deepEqual(acceptance.get(restored), {
    acceptanceSession: true, taskRef: 'task-1', acceptanceMode: 'auto', approvalId: 'review-1',
  });
  assert.deepEqual(restored.acceptanceSession, acceptance.get(restored));
  assert.equal(restored.taskRef, undefined, '只恢复验收元数据，不触发普通需求绑定');
  assert.equal(fs.readFileSync(metadataFile(f), 'utf8').includes(identity().session), false, '不保存登录令牌');
});

test('按需选择的过程文件随验收会话恢复，空选择不污染旧协议', async t => {
  const f = fixture(t);
  await acceptance.attach(f.app, f.handle, {...options, acceptanceAttachmentIds: ['process-a', 'process-b']}, identity());
  const restored = {sessionId: 'review-chat'};
  await acceptance.attach(f.app, restored, {resumed: true}, identity());
  assert.deepEqual(acceptance.get(restored).acceptanceAttachmentIds, ['process-a', 'process-b']);
  await assert.rejects(acceptance.attach(f.app, {sessionId: 'review-chat'},
    {...options, resumed: true, acceptanceAttachmentIds: ['other']}, identity()), /不一致/);
});

test('普通历史会话和已打开的普通会话不能通过 rawOptions 升级为自动验收', async t => {
  const f = fixture(t);
  await assert.rejects(acceptance.attach(f.app, f.handle, { ...options, resumed: true }, identity()), /普通会话/);
  await acceptance.attach(f.app, f.handle, { resumed: false }, identity());
  await assert.rejects(acceptance.attach(f.app, f.handle, options, identity()), /普通会话/);
  assert.equal(acceptance.get(f.handle), null);
});

test('恢复普通历史会话时 chatId 同样构成历史标志', async t => {
  const f = fixture(t);
  await assert.rejects(acceptance.attach(f.app, f.handle, { ...options, chatId: 'review-chat' }, identity()), /普通会话/);
});

test('恢复验收会话不能更换需求、审批单或自动验收授权', async t => {
  const f = fixture(t);
  await acceptance.attach(f.app, f.handle, { ...options, acceptanceMode: 'manual' }, identity());
  for (const overrides of [{ taskRef: 'task-2' }, { approvalId: 'review-2' }, { acceptanceMode: 'auto' }]) {
    await assert.rejects(acceptance.attach(f.app, { sessionId: 'review-chat' },
      { ...options, acceptanceMode: 'manual', resumed: true, ...overrides }, identity()), /不一致|不能更换/);
  }
  assert.equal(acceptance.get(f.handle).acceptanceMode, 'manual');
});

test('验收会话隔离账号与 Hub，同一账号重注册设备可恢复', async t => {
  const f = fixture(t);
  await acceptance.attach(f.app, f.handle, options, identity());
  await assert.rejects(acceptance.attach(f.app, { sessionId: 'review-chat' }, { resumed: true }, identity('other')), /账号或服务/);
  await assert.rejects(acceptance.attach(f.app, { sessionId: 'review-chat' }, { resumed: true },
    identity('verifier', 'https://other.example.test')), /账号或服务/);
  const restored = { sessionId: 'review-chat' };
  await acceptance.attach(f.app, restored, { resumed: true }, identity('verifier', 'https://hub.example.test/', 'new-device'));
  assert.equal(acceptance.get(restored).taskRef, 'task-1');
});

// Synthetic RFC1918 fixture: no network request is made by these metadata tests.
test('未打包源码客户端允许同一端口的本地 Hub 地址迁移并更新会话归属', async t => {
  const f = fixture(t), app = { ...f.app, isPackaged: false };
  await acceptance.attach(app, f.handle, options, identity('verifier', 'http://127.0.0.1:9080'));
  const restored = { sessionId: 'review-chat' };
  await acceptance.attach(app, restored, { resumed: true }, identity('verifier', 'http://10.0.0.1:9080', 'new-device'));
  assert.equal(acceptance.get(restored).taskRef, 'task-1');
  assert.equal(JSON.parse(fs.readFileSync(metadataFile(f), 'utf8')).hub, 'http://10.0.0.1:9080');
});

test('本地 Hub 迁移不会跨端口或进入已打包客户端', async t => {
  const local = fixture(t), localApp = { ...local.app, isPackaged: false };
  await acceptance.attach(localApp, local.handle, options, identity('verifier', 'http://127.0.0.1:9080'));
  await assert.rejects(acceptance.attach(localApp, { sessionId: 'review-chat' }, { resumed: true },
    identity('verifier', 'http://10.0.0.1:9081')), /账号或服务/);
  await assert.rejects(acceptance.attach(localApp, { sessionId: 'review-chat' }, { resumed: true },
    identity('verifier', 'http://192.0.2.20:9080')), /账号或服务/);
  const packaged = fixture(t), packagedApp = { ...packaged.app, isPackaged: true };
  await acceptance.attach(packagedApp, packaged.handle, options, identity('verifier', 'http://127.0.0.1:9080'));
  await assert.rejects(acceptance.attach(packagedApp, { sessionId: 'review-chat' }, { resumed: true },
    identity('verifier', 'http://10.0.0.1:9080')), /账号或服务/);
});

test('损坏或不可读的元数据必须阻断打开，不能降级为普通任务执行', async t => {
  const f = fixture(t);
  await acceptance.attach(f.app, f.handle, options, identity());
  fs.writeFileSync(metadataFile(f), '{broken');
  const restored = { sessionId: 'review-chat' };
  await assert.rejects(acceptance.attach(f.app, restored, { resumed: true }, identity()), /无法读取/);
  assert.equal(acceptance.get(restored), null);
});

test('新建和恢复均拒绝已有其他需求的会话，后续绑定也检查同一需求', async t => {
  const f = fixture(t);
  await assert.rejects(acceptance.attach(f.app, { ...f.handle, taskIds: ['task-2'] }, options, identity()), /其他需求/);
  await acceptance.attach(f.app, f.handle, options, identity());
  await assert.rejects(acceptance.attach(f.app, { sessionId: 'review-chat', taskBindings: [{ taskId: 'task-2' }] },
    { resumed: true }, identity()), /其他需求/);
  assert.equal(acceptance.assertTask(f.handle, 'task-1').taskRef, 'task-1');
  assert.throws(() => acceptance.assertTask(f.handle, 'task-2'), /其他需求/);
  assert.equal(acceptance.assertTask(f.handle, '').taskRef, 'task-1');
});

test('元数据落盘失败时不能留下可发送的自动验收授权', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'acceptance-session-context'), 'blocked');
  await assert.rejects(acceptance.attach(f.app, f.handle, options, identity()), /保存|读取/);
  assert.equal(acceptance.get(f.handle), null);
});

test('验收参数必须有效，默认仅手动分析，公开对象不可修改授权', async t => {
  const f = fixture(t);
  await assert.rejects(acceptance.attach(f.app, f.handle, { ...options, taskRef: '' }, identity()), /需求/);
  await assert.rejects(acceptance.attach(f.app, f.handle, { ...options, acceptanceMode: 'invalid' }, identity()), /方式/);
  await acceptance.attach(f.app, f.handle, { acceptanceSession: true, taskRef: 'task-1', resumed: false }, identity());
  assert.equal(acceptance.get(f.handle).acceptanceMode, 'manual');
  assert.throws(() => { acceptance.get(f.handle).acceptanceMode = 'auto'; }, TypeError);
  assert.equal(acceptance.get(f.handle).acceptanceMode, 'manual');
});

test('缺失或错误的持久验收模式不能静默降级为人工分析', async t => {
  const f = fixture(t);
  await acceptance.attach(f.app, f.handle, options, identity());
  const original = JSON.parse(fs.readFileSync(metadataFile(f), 'utf8'));
  for (const record of [{ ...original, acceptanceMode: undefined }, { ...original, approvalId: undefined },
    { ...original, sessionId: 'another-chat' }]) {
    fs.writeFileSync(metadataFile(f), JSON.stringify(record));
    await assert.rejects(acceptance.attach(f.app, { sessionId: 'review-chat' }, { resumed: true }, identity()), /无法读取/);
  }
});

test('受管磁盘拒绝原子重命名时复用校验替换，重启仍可恢复模式', async t => {
  const f = fixture(t);
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(Error('cross device'), { code: 'EXDEV' }); });
  await acceptance.attach(f.app, f.handle, options, identity());
  const restored = { sessionId: 'review-chat' };
  await acceptance.attach(f.app, restored, { resumed: true }, identity());
  assert.equal(acceptance.get(restored).acceptanceMode, 'auto');
  assert.deepEqual(fs.readdirSync(path.dirname(metadataFile(f))), [path.basename(metadataFile(f))]);
});
