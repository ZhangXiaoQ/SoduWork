'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sessions = require('../main/pi-session/session');
const memories = require('../main/conversation/session-memory');
const { scope } = require('../main/platform-connections/runtime.cjs');

function identity(uid = 'account-a', clientId = 'device-a', hub = 'https://fixture.invalid') {
  const now = Math.floor(Date.now() / 1000);
  return { hub, clientId,
    session: Buffer.from(JSON.stringify({ typ: 'device', uid, cid: clientId, iat: now - 10, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
}
const card = (patch = {}) => ({ id: 'draft-1', actionId: 'work.requirement.create', prompt: '记录完整需求',
  seed: { instruction: '记录完整需求' }, state: { note: '完整原文末尾', checklist: ['真实验收'] },
  files: [{ name: '原材料.txt', type: 'text/plain', lastModified: 12, data: Buffer.from('原材料完整末尾').toString('base64') }], closed: false, ...patch });

async function fixture(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'soduwork-work-cards-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, live = new Map();
  let current = identity(), imported = 0;
  const native = await import(pathToFileURL(path.resolve(__dirname, '../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js')).href);
  const module = require('../main/conversation/work-conversation-cards');
  const dependencies = { app, identityOf: async () => current,
    session: { findBySessionId: id => live.get(id), archivedConversation: async (_app, id) => (await sessions.historyEntry(app, id)).entry || null },
    newCwd: () => { const cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd, { recursive: true }); return cwd; },
    loadStorageSdk: async () => { imported++; return native; }, ...options };
  const store = module.create(dependencies);
  return { root, app, store, module, dependencies, native, live, current: () => current,
    changeIdentity: value => { current = value; }, imported: () => imported };
}

test('creation lookup uses owned durable receipts and ignores deleted or unrelated archives', async t => {
  const f=await fixture(t), made=await f.store.reserve({title:'Origin'});
  await f.store.save(made.sessionId,card({state:{phase:'succeeded',receipt:{id:'task',title:'Task'}},files:[]}));
  assert.deepEqual(await f.store.findTaskCreation('task'),{ok:true,sessionId:made.sessionId});
  assert.deepEqual(await f.store.findTaskCreation('other'),{ok:true,sessionId:''});
  f.changeIdentity(identity('account-b'));
  assert.deepEqual(await f.store.findTaskCreation('task'),{ok:true,sessionId:''});
  f.changeIdentity(identity());
  const archive=(await sessions.historyEntry(f.app,made.sessionId)).entry;
  await fsp.unlink(archive.path);
  assert.deepEqual(await f.store.findTaskCreation('task'),{ok:true,sessionId:''});
});

test('仅表单会话写入真实 Pi 存档、列入历史并可由 SDK 恢复，无模型消息', async t => {
  const f = await fixture(t);
  const created = await f.store.reserve({ title: '【需求】修复导出' });
  assert.equal(created.ok, true, created.reason);
  assert.equal(created.workOnly, true);
  assert.equal(created.presence.id, created.sessionId);
  assert.equal(f.imported(), 1);
  const history = await sessions.history(f.app, 50);
  const row = history.chats.find(item => item.id === created.sessionId);
  assert.ok(row, '真实历史必须包括尚未启动 Agent 的工作表单');
  assert.equal(row.title, '【需求】修复导出');
  assert.equal(row.workOnly, true);
  const manager = f.native.SessionManager.open(row.path);
  assert.equal(manager.getSessionId(), created.sessionId);
  assert.deepEqual(manager.buildSessionContext().messages, []);
  assert.doesNotThrow(() => memories.binding(f.app, created.sessionId, f.current()));
  assert.throws(() => memories.binding(f.app, created.sessionId, identity('other')), /另一个账号/);
});

test('卡片与二进制材料跨存储实例完整恢复，修改与关闭状态保持', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '自动化草稿' });
  const first = await f.store.save(made.sessionId, card());
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.card.revision, 1);
  const next = await f.store.save(made.sessionId, { ...first.card, closed: true, state: { note: '手动确认原文' } });
  assert.equal(next.ok, true, next.reason);
  const restored = await f.module.create(f.dependencies).read(made.sessionId);
  assert.equal(restored.ok, true, restored.reason);
  assert.equal(restored.workOnly, true);
  assert.equal(restored.cards.length, 1);
  assert.deepEqual(restored.cards[0], next.card);
  assert.equal(Buffer.from(restored.cards[0].files[0].data, 'base64').toString(), '原材料完整末尾');
});

const draftSelection = (patch = {}) => ({ adapterId: 'qwen', modelName: 'chosen-model', modelLabel: 'Selected model',
  reasoningEffort: 'high', thinkingLevel: 'medium', ...patch });

const requirementScope = (hub = 'https://fixture.invalid', device = 'device-a', uid = 'account-a') =>
  ['soduwork_work_task_ops_v1', ...[hub, device, uid].map(encodeURIComponent)].join('@');
const requirementState = (patch = {}) => ({ version: 1, cardId: 'draft-1', ownerScope: requirementScope(), phase: 'draft',
  draft: { title: '保留标题', note: '保留原文', check: ['保留验收'], who: { kind: 'me' } }, receipt: null, error: '', ...patch });

test('同账号同服务设备重登记后仅恢复未提交需求草稿副本，不改写磁盘原档', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '设备重登记草稿' });
  for (const phase of ['draft', 'loading', 'error']) {
    const saved = await f.store.save(made.sessionId, card({ state: requirementState({ phase }) }));
    const file = f.module.location(f.app, made.sessionId), before = await fsp.readFile(file, 'utf8');
    f.changeIdentity(identity('account-a', 'device-new'));
    const restored = await f.module.create(f.dependencies).read(made.sessionId);
    assert.equal(restored.ok, true, restored.reason);
    assert.deepEqual(restored.cards[0], { ...saved.card, state: { ...saved.card.state,
      ownerScope: requirementScope('https://fixture.invalid', 'device-new') } });
    assert.equal(await fsp.readFile(file, 'utf8'), before);
    f.changeIdentity(identity());
  }
});

test('设备重登记不重绑提交或回执、跨服务账号及不完整的需求归属', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '恢复隔离边界' });
  const rejected = [
    { phase: 'submitting' }, { phase: 'succeeded' }, { phase: 'unexpected' }, { version: 2 },
    { submission: {} }, { submission: { id: 'pending-create', createStarted: true } }, { receipt: { id: 'remote-task' } },
    { ownerScope: requirementScope('https://other.invalid') },
    { ownerScope: requirementScope('https://fixture.invalid', 'device-a', 'account-b') },
    { ownerScope: requirementScope() + '@extra' }, { ownerScope: requirementScope().replace('device-a', '%ZZ') },
    { ownerScope: requirementScope().replace('device-a', '') }, { ownerScope: 'malformed-scope' },
    { ownerScope: '' }, { ownerScope: null },
  ];
  for (const patch of rejected) {
    f.changeIdentity(identity());
    const saved = await f.store.save(made.sessionId, card({ state: requirementState(patch) }));
    f.changeIdentity(identity('account-a', 'device-new'));
    const restored = await f.store.read(made.sessionId);
    assert.equal(restored.ok, true, restored.reason);
    assert.deepEqual(restored.cards, [saved.card], '仅返回旧状态，不赋予新设备提交权限');
  }
  f.changeIdentity(identity());
  const automation = await f.store.save(made.sessionId, card({ actionId: 'work.automation.create', state: requirementState() }));
  f.changeIdentity(identity('account-a', 'device-new'));
  assert.deepEqual((await f.store.read(made.sessionId)).cards, [automation.card]);
  f.changeIdentity(identity('account-b', 'device-new'));
  assert.equal((await f.store.read(made.sessionId)).ok, false, '外层授权先拒绝异账号');
});

test('恢复草稿归属的最后身份检查拒绝读取期间设备或账号切换', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '恢复末检' });
  await f.store.save(made.sessionId, card({ state: requirementState() }));
  for (const changed of [identity('account-a', 'device-other'), identity('account-b', 'device-new')]) {
    f.changeIdentity(identity('account-a', 'device-new'));
    let checks = 0;
    const racing = f.module.create({ ...f.dependencies, identityOf: async () => {
      if (++checks === 7) f.changeIdentity(changed);
      return f.current();
    } });
    const restored = await racing.read(made.sessionId);
    assert.equal(restored.ok, false);
    assert.match(restored.reason, /账号或服务已切换/);
  }
});

test('恢复身份末检等待期间已启动会话不能返回草稿执行选项', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '恢复末检启动', draftSelection: draftSelection() });
  await f.store.save(made.sessionId, card({ state: requirementState() }));
  let checks = 0;
  const racing = f.module.create({ ...f.dependencies, identityOf: async () => {
    if (++checks === 7) f.live.set(made.sessionId, { historyRow: () => ({ id: made.sessionId, workOnly: true }) });
    return f.current();
  } });
  const restored = await racing.read(made.sessionId);
  assert.equal(restored.ok, true, restored.reason);
  assert.equal(restored.workOnly, false);
  assert.equal(restored.presence.workOnly, false);
  assert.equal(restored.draftSelection, null);
  assert.equal(restored.draftSelectionRevision, 0);
});

test('仅表单会话独立保存执行选择，跨实例恢复且不读取表单 seed', async t => {
  const f = await fixture(t), selection = draftSelection();
  const made = await f.store.reserve({ title: '保存执行选择', draftSelection: selection });
  assert.equal(made.ok, true, made.reason);
  assert.deepEqual(made.draftSelection, selection);
  assert.equal(made.draftSelectionRevision, 1);
  const saved = await f.store.save(made.sessionId, card({ seed: { model: 'different-parser-model', adapterId: 'pi' } }));
  assert.equal(saved.ok, true, saved.reason);
  const loaded = await f.module.create(f.dependencies).read(made.sessionId);
  assert.deepEqual(loaded.draftSelection, selection);
  assert.equal(loaded.draftSelectionRevision, 1);
  assert.equal(loaded.cards[0].seed.model, 'different-parser-model');
  const entry = (await sessions.historyEntry(f.app, made.sessionId)).entry;
  assert.deepEqual(f.native.SessionManager.open(entry.path).buildSessionContext().messages, []);
});

test('旧表单会话无选择记录时明确返回空值，不把 card seed 当成执行选择', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '旧草稿' });
  await f.store.save(made.sessionId, card({ seed: { model: 'parser-model', adapterId: 'codex' } }));
  const loaded = await f.store.read(made.sessionId);
  assert.equal(loaded.draftSelection, null);
  assert.equal(loaded.draftSelectionRevision, 0);
});

test('部分或空草稿选项完全替换后输出五个字段，可直接交给界面恢复', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '部分选项', draftSelection: { modelName: 'chosen-model' } });
  assert.deepEqual(made.draftSelection, { adapterId: 'pi', modelName: 'chosen-model', modelLabel: '', reasoningEffort: '', thinkingLevel: '' });
  const cleared = await f.store.saveDraftSelection(made.sessionId, { selection: {}, revision: 1 });
  assert.equal(cleared.ok, true, cleared.reason);
  assert.deepEqual(cleared.draftSelection, { adapterId: 'pi', modelName: '', modelLabel: '', reasoningEffort: '', thinkingLevel: '' });
  assert.deepEqual((await f.module.create(f.dependencies).read(made.sessionId)).draftSelection, cleared.draftSelection);
  const explicitDefault = await f.store.saveDraftSelection(made.sessionId, { selection: { adapterId: ' ' }, revision: 2 });
  assert.deepEqual(explicitDefault.draftSelection, cleared.draftSelection);
});

test('草稿选择与卡片使用同一会话串行写入，旧 revision 不能覆盖且允许清空模型', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '并发草稿' });
  const [savedCard, selected] = await Promise.all([f.store.save(made.sessionId, card()),
    f.store.saveDraftSelection(made.sessionId, { selection: draftSelection(), revision: 0 })]);
  assert.equal(savedCard.ok, true, savedCard.reason); assert.equal(selected.ok, true, selected.reason);
  const [first, stale] = await Promise.all([
    f.store.saveDraftSelection(made.sessionId, { selection: draftSelection({ modelName: '', modelLabel: '' }), revision: 1 }),
    f.store.saveDraftSelection(made.sessionId, { selection: draftSelection({ modelName: 'stale' }), revision: 1 }),
  ]);
  assert.equal(first.ok, true, first.reason); assert.equal(first.draftSelectionRevision, 2);
  assert.equal(stale.ok, false); assert.equal(stale.code, 'STALE_DRAFT_SELECTION');
  const loaded = await f.store.read(made.sessionId);
  assert.deepEqual(loaded.cards, [savedCard.card]);
  assert.equal(loaded.draftSelection.modelName, '');
  assert.equal(loaded.draftSelectionRevision, 2);
});

test('草稿选择只允许五个有界选项，不存权限、插件、令牌或无版本写入', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '选项白名单' });
  for (const selection of [null, [], { ...draftSelection(), accessMode: 'full' }, { ...draftSelection(), accessConsentId: 'consent' },
    { ...draftSelection(), plugins: ['plugin'] }, { ...draftSelection(), token: 'secret' }, { adapterId: {} },
    { modelName: 'm'.repeat(301) }, { modelLabel: 'l'.repeat(301) }, { reasoningEffort: 'x'.repeat(41) }, { thinkingLevel: 2 }]) {
    assert.equal((await f.store.saveDraftSelection(made.sessionId, { selection, revision: 0 })).ok, false);
  }
  for (const value of [{ selection: draftSelection() }, { selection: draftSelection(), revision: -1 },
    { selection: draftSelection(), revision: 0, accessMode: 'full' }]) {
    assert.equal((await f.store.saveDraftSelection(made.sessionId, value)).ok, false);
  }
  assert.equal((await f.store.reserve({ title: '禁止权限写入', draftSelection: { accessMode: 'full' } })).ok, false);
  assert.equal((await f.store.read(made.sessionId)).draftSelection, null);
});

test('草稿选择跨账号拒绝，已初始化或已有 live runtime 不再读写旧选择', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '原会话', draftSelection: draftSelection() });
  f.changeIdentity(identity('account-b'));
  assert.equal((await f.store.read(made.sessionId)).ok, false);
  assert.equal((await f.store.saveDraftSelection(made.sessionId, { selection: {}, revision: 1 })).ok, false);
  f.changeIdentity(identity());
  const entry = (await sessions.historyEntry(f.app, made.sessionId)).entry;
  f.native.SessionManager.open(entry.path).appendCustomEntry('soduwork.access.policy', { mode: 'readonly' });
  const loaded = await f.store.read(made.sessionId);
  assert.equal(loaded.workOnly, false); assert.equal(loaded.draftSelection, null); assert.equal(loaded.draftSelectionRevision, 0);
  const rejected = await f.store.saveDraftSelection(made.sessionId, { selection: {}, revision: 1 });
  assert.equal(rejected.ok, false); assert.equal(rejected.code, 'WORK_CONVERSATION_STARTED');
  const live = await f.store.reserve({ title: 'live 零消息', draftSelection: draftSelection() });
  f.live.set(live.sessionId, { historyRow: () => ({ id: live.sessionId, workOnly: true, count: 0 }) });
  assert.equal((await f.store.read(live.sessionId)).draftSelection, null);
  assert.equal((await f.store.saveDraftSelection(live.sessionId, { selection: {}, revision: 1 })).code, 'WORK_CONVERSATION_STARTED');
});

test('草稿选择落盘前已开始运行时拒绝，保留原选择', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '迟到草稿选择', draftSelection: draftSelection() });
  const entry = (await sessions.historyEntry(f.app, made.sessionId)).entry;
  let finds = 0;
  const racing = f.module.create({ ...f.dependencies, session: { ...f.dependencies.session,
    archivedConversation: async (_app, id) => {
      if (++finds === 2) f.native.SessionManager.open(entry.path).appendCustomEntry('soduwork.access.policy', { mode: 'readonly' });
      return (await sessions.historyEntry(f.app, id)).entry || null;
    } } });
  const rejected = await racing.saveDraftSelection(made.sessionId, { selection: { modelName: 'late' }, revision: 1 });
  assert.equal(rejected.ok, false); assert.equal(rejected.code, 'WORK_CONVERSATION_STARTED');
  const raw = JSON.parse(await fsp.readFile(f.module.location(f.app, made.sessionId), 'utf8'));
  assert.equal(raw.draftSelection.modelName, 'chosen-model');
  assert.equal(raw.draftSelectionRevision, 1);
});

test('读取选项期间已初始化的会话不能返回旧草稿选择', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '读取中开始', draftSelection: draftSelection() });
  const entry = (await sessions.historyEntry(f.app, made.sessionId)).entry;
  let identities = 0;
  const racing = f.module.create({ ...f.dependencies, identityOf: async () => {
    if (++identities === 4) f.native.SessionManager.open(entry.path).appendCustomEntry('soduwork.access.policy', { mode: 'readonly' });
    return f.current();
  } });
  const read = await racing.read(made.sessionId);
  assert.equal(read.workOnly, false); assert.equal(read.draftSelection, null); assert.equal(read.draftSelectionRevision, 0);
});

test('草稿选择写盘失败与切账号均不覆盖，恢复后可用同 revision 重试', async t => {
  let fail = false;
  const f = await fixture(t, { replace: async (...args) => {
    if (fail) throw Object.assign(Error('isolated write failure'), { code: 'EACCES' });
    return fsp.rename(...args);
  } });
  const made = await f.store.reserve({ title: '选择保存失败', draftSelection: draftSelection() });
  fail = true;
  assert.equal((await f.store.saveDraftSelection(made.sessionId, { selection: {}, revision: 1 })).ok, false);
  assert.deepEqual((await f.store.read(made.sessionId)).draftSelection, draftSelection());
  fail = false;
  let identities = 0;
  const guarded = f.module.create({ ...f.dependencies, identityOf: async () => {
    if (++identities === 3) f.changeIdentity(identity('account-b'));
    return f.current();
  } });
  assert.equal((await guarded.saveDraftSelection(made.sessionId, { selection: {}, revision: 1 })).ok, false);
  f.changeIdentity(identity());
  const saved = await f.store.saveDraftSelection(made.sessionId, { selection: {}, revision: 1 });
  assert.equal(saved.ok, true, saved.reason); assert.equal(saved.draftSelectionRevision, 2);
});

test('创建草稿选择落盘后切账号，仅清理本次未启动的空存档和选项', async t => {
  let f;
  f = await fixture(t, { replace: async (...args) => {
    await fsp.rename(...args); f.changeIdentity(identity('account-b'));
  } });
  const made = await f.store.reserve({ title: '取消迟到创建', draftSelection: draftSelection() });
  assert.equal(made.ok, false);
  f.changeIdentity(identity());
  assert.deepEqual((await sessions.history(f.app)).chats, []);
  const selectionDir = path.join(f.root, 'conversation-work-cards');
  assert.deepEqual(fs.existsSync(selectionDir) ? fs.readdirSync(selectionDir) : [], []);
});

test('普通消息出现后不再作为仅表单会话恢复', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '后续继续聊天' });
  const entry = (await sessions.historyEntry(f.app, made.sessionId)).entry;
  const manager = f.native.SessionManager.open(entry.path);
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: '开始普通聊天' }], timestamp: Date.now() });
  assert.equal((await f.store.read(made.sessionId)).workOnly, false);
});

test('已初始化但零消息的工作会话保留标题、历史和卡片，恢复时接回运行态', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '首条消息前关闭的会话' });
  await f.store.save(made.sessionId, card());
  const entry = (await sessions.historyEntry(f.app, made.sessionId)).entry;
  f.native.SessionManager.open(entry.path).appendCustomEntry('soduwork.access.policy', { mode: 'readonly' });
  const loaded = await f.store.read(made.sessionId);
  assert.equal(loaded.workOnly, false);
  assert.equal(loaded.cards.length, 1);
  const row = (await sessions.history(f.app, 50)).chats.find(item => item.id === made.sessionId);
  assert.ok(row, '初始化不能让零消息会话从历史消失');
  assert.equal(row.title, '首条消息前关闭的会话');
  assert.equal(row.count, 0);
  // Local history is device-shared; executing or changing its work card still
  // requires the original account through the separate work-action contract.
  assert.deepEqual(f.module.visibleHistory(f.app, [row], identity('other')).map(item => item.id), [made.sessionId]);
  await sessions.archiveHistory(f.app, made.sessionId);
  const archived = (await sessions.archivedHistory(f.app, 50)).chats.find(item => item.id === made.sessionId);
  assert.equal(archived.title, row.title);
  assert.equal(archived.workOnly, false);
});

test('首次 Pi 初始化写入权限不被自身校验误判，已有实际消息仍拒绝首次接入', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '初始化前后校验' });
  const row = (await sessions.historyEntry(f.app, made.sessionId)).entry;
  const work = require('../main/conversation/work-conversation-opening').prepare(f.app,
    { chatId: made.sessionId, adapterId: 'pi', accessMode: 'readonly' }, row, f.current(), true, sessions);
  const other = require('../main/conversation/work-conversation-opening').prepare(f.app,
    { chatId: made.sessionId, adapterId: 'qwen', accessMode: 'readonly' }, row, f.current(), true, sessions);
  const identityOf = async () => f.current();
  await work.validate({ identityOf });
  const manager = f.native.SessionManager.open(row.path);
  manager.appendCustomEntry('soduwork.access.policy', { mode: 'readonly' });
  assert.equal((await f.store.read(made.sessionId)).workOnly, false);
  await work.validate({ identityOf });
  await assert.rejects(other.validate({ identityOf }), /已删除或发生变化/);
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: '另一窗口已开始' }], timestamp: Date.now() });
  await assert.rejects(work.validate({ identityOf }), /已删除或发生变化/);
});

test('真实空存档首次执行在异步前后校验账号、窗口和原存档，切底座清单不干扰核验', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '稍后发送' });
  const row = (await sessions.historyEntry(f.app, made.sessionId)).entry;
  const opening = require('../main/conversation/work-conversation-opening');
  const work = opening.prepare(f.app, { chatId: made.sessionId, adapterId: 'qwen', accessMode: 'readonly' }, row, f.current(), true, sessions);
  assert.equal(work.first, true);
  const identityOf = async () => f.current();
  await work.validate({ identityOf });
  // After runtime switching, validate ownership through the original Pi archive without mistaking the active segment for deletion.
  await require('../main/conversation/runtime-segments').save(f.app, { version: 1, id: made.sessionId,
    owner: scope(f.current()), active: { adapterId: 'qwen', sessionId: 'new-native', path: 'new-native' }, segments: [] });
  await work.validate({ identityOf });
  f.changeIdentity(identity('other'));
  await assert.rejects(work.validate({ identityOf }), /账号或服务已切换/);
  f.changeIdentity(identity());
  const sender = { mainFrame: {}, isDestroyed: () => true, getURL: () => pathToFileURL(path.resolve(__dirname, '../desk.html')).href };
  await assert.rejects(work.validate({ identityOf, event: { sender, senderFrame: sender.mainFrame } }), /窗口已经关闭/);
  await fsp.unlink(row.path);
  await assert.rejects(work.validate({ identityOf }), /已删除或发生变化/);
});

test('已写入权限但还未发消息的表单会话恢复原权限，不用新默认覆盖', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '已选权限' });
  const row = (await sessions.historyEntry(f.app, made.sessionId)).entry;
  f.native.SessionManager.open(row.path).appendCustomEntry('soduwork.access.policy', { mode: 'readonly' });
  const opening = require('../main/conversation/work-conversation-opening');
  const work = opening.prepare(f.app, { chatId: made.sessionId, accessMode: 'full' }, row, f.current(), true, sessions);
  assert.equal(work.first, false);
  assert.throws(() => opening.prepare(f.app, { chatId: made.sessionId, adapterId: 'qwen' }, row, f.current(), true, sessions), /先接回会话/);
});

async function createdRequirement(t) {
  const f = await fixture(t), made = await f.store.reserve({ title: '搭建美食网站' });
  const saved = await f.store.save(made.sessionId, card({ state: { phase: 'succeeded', receipt: { id: 'created-task' } } }));
  assert.equal(saved.ok, true, saved.reason);
  const row = (await sessions.historyEntry(f.app, made.sessionId)).entry;
  const prepare = (patch = {}) => require('../main/conversation/work-conversation-opening').prepare(f.app,
    { chatId: made.sessionId, adapterId: 'pi', taskRef: 'created-task', requireTaskBinding: true, ...patch }, row, f.current(), true, sessions);
  const task = { id: 'created-task', status: 'todo', ownerClientId: f.current().clientId };
  return { ...f, made, row, saved, prepare, task, identityOf: async () => f.current() };
}

test('创建成功的三条记录草稿只为本需求授予首次绑定，保留原有运行时拒绝条件', async t => {
  const f = await createdRequirement(t);
  const entries = f.native.SessionManager.open(f.row.path).getEntries();
  assert.deepEqual(entries.map(row => row.type === 'custom' ? row.customType : row.type), ['session_info', 'soduwork.work-entry']);
  assert.equal(fs.readFileSync(f.row.path, 'utf8').trim().split('\n').length, 3);
  // Reproduce the original rejection using the actual runtime and storage SDK;
  // no model loader is needed because the binding guard rejects before it.
  const native = require('../main/pi-session/session-open').create({
    loadSdk: async () => ({ ok: true, sdk: f.native }), _openTiming() {},
    _taskBindingFromEntries: sessions._taskBindingFromEntries,
    goalContract: require('../main/conversation/goal-contract'),
  });
  const rejected = await native.open({ app: f.app, resumePath: f.row.path, taskRef: 'created-task', requireTaskBinding: true });
  assert.deepEqual(rejected, { ok: false, code: 'TASK_BINDING_MISMATCH', reason: '这条会话不是该需求的协作会话' });
  const work = f.prepare(), routes = [];
  assert.equal(work.bindCreatedTask, true);
  await work.validate({ identityOf: f.identityOf, request: async route => { routes.push(route); return f.task; } });
  assert.deepEqual(routes, ['/tasks/created-task']);
  f.native.SessionManager.open(f.row.path).appendCustomEntry('soduwork.access.policy', { mode: 'standard' });
  await work.validate({ identityOf: f.identityOf, request: async () => f.task });
  assert.equal(f.prepare().first, false, 'an initialized archive cannot receive another initial binding');
});

test('其他需求、未保存成功回执、已转交及其他账号卡片都不能授予首次绑定', async t => {
  const f = await createdRequirement(t);
  await assert.rejects(f.prepare({ taskRef: 'other-task' }).validate({ identityOf: f.identityOf,
    request: async () => { throw Error('receipt mismatch must reject before Hub lookup'); } }), /没有该需求的创建回执/);
  for (const state of [{ phase: 'submitting' }, { phase: 'succeeded', receipt: { id: f.task.id, gone: true } }]) {
    const saved = await f.store.save(f.made.sessionId, { ...f.saved.card, state });
    assert.equal(saved.ok, true, saved.reason); f.saved = saved;
    await assert.rejects(f.prepare().validate({ identityOf: f.identityOf, request: async () => f.task }), /没有该需求的创建回执/);
  }
  const file = f.module.location(f.app, f.made.sessionId), stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.owner = scope(identity('someone-else'));
  fs.writeFileSync(file, JSON.stringify(stored));
  await assert.rejects(f.prepare().validate({ identityOf: f.identityOf, request: async () => f.task }), /另一个账号/);
});

test('最新 Hub 归属与待执行状态是首次绑定的必要条件', async t => {
  const f = await createdRequirement(t);
  for (const patch of [{ id: 'other-task' }, { ownerClientId: 'other-device' }, { ownerClientId: '' },
    { readOnly: true }, { canViewExecution: false }, { status: 'doing' }, { archivedAt: 1 },
    { requirementStage: 'reviewing' }, { triageStage: 'intake' }, { triageStage: 'clarifying' },
    { ai: { state: 'running' } }, { ai: { executionState: 'queued' } },
    { workRouting: { conversationTurn: { state: 'queued' } } }]) {
    await assert.rejects(f.prepare().validate({ identityOf: f.identityOf,
      request: async () => ({ ...f.task, ...patch }) }), /无权|状态已变化/, JSON.stringify(patch));
  }
  await assert.rejects(f.prepare().validate({ identityOf: f.identityOf }), /无法确认需求归属/);
});

test('首次绑定的 Hub 查询期间切账号、删除或初始化原存档均拒绝', async t => {
  const f = await createdRequirement(t), original = f.current();
  await assert.rejects(f.prepare().validate({ identityOf: f.identityOf, request: async () => {
    f.changeIdentity(identity('other')); return f.task;
  } }), /账号或服务已切换/);
  f.changeIdentity(original);
  const contents = fs.readFileSync(f.row.path);
  await assert.rejects(f.prepare().validate({ identityOf: f.identityOf, request: async () => {
    fs.unlinkSync(f.row.path); return f.task;
  } }), /已删除或发生变化/);
  fs.writeFileSync(f.row.path, contents);
  await assert.rejects(f.prepare().validate({ identityOf: f.identityOf, request: async () => {
    f.native.SessionManager.open(f.row.path).appendCustomEntry('soduwork.access.policy', { mode: 'standard' }); return f.task;
  } }), /已删除或发生变化/);
});

test('已有任务绑定的草稿和普通存档不获首次绑定例外', async t => {
  const f = await createdRequirement(t);
  f.native.SessionManager.open(f.row.path).appendCustomEntry('soduwork.task.binding', { taskId: 'other-task' });
  assert.equal(f.prepare().bindCreatedTask, false);
  const opening = require('../main/conversation/work-conversation-opening').prepare(f.app,
    { taskRef: f.task.id, requireTaskBinding: true }, { ...f.row, workOnly: false }, f.current(), true, sessions);
  assert.equal(opening.first, false); assert.equal(opening.bindCreatedTask, undefined);
});

test('另一需求已初始化的会话返回类型化拒绝且不改写已有绑定或权限', async t => {
  const f = await createdRequirement(t), manager = f.native.SessionManager.open(f.row.path);
  manager.appendCustomEntry('soduwork.access.policy', { mode: 'readonly' });
  manager.appendCustomEntry('soduwork.task.binding', { schemaVersion: 2,
    tasks: [{ taskId: 'previous-task', taskTitle: '旧需求' }], activeTaskId: 'previous-task' });
  assert.equal(f.prepare().first, false);
  const before = fs.readFileSync(f.row.path, 'utf8');
  const native = require('../main/pi-session/session-open').create({
    loadSdk: async () => ({ ok: true, sdk: f.native }), _openTiming() {},
    _taskBindingFromEntries: sessions._taskBindingFromEntries,
    goalContract: require('../main/conversation/goal-contract'),
  });
  const result = await native.open({ app: f.app, resumePath: f.row.path,
    taskRef: 'created-task', requireTaskBinding: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TASK_BINDING_MISMATCH');
  assert.equal(fs.readFileSync(f.row.path, 'utf8'), before);
});

test('跨账号读取与保存拒绝，原账号仍能取回', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '私人草稿' });
  await f.store.save(made.sessionId, card());
  f.changeIdentity(identity('account-b'));
  assert.equal((await f.store.read(made.sessionId)).ok, false);
  assert.equal((await f.store.save(made.sessionId, card({ prompt: '覆盖' }))).ok, false);
  f.changeIdentity(identity());
  assert.equal((await f.store.read(made.sessionId)).cards[0].prompt, '记录完整需求');
});

test('会话删除后迟到保存不能复活历史或卡片', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '将被删除' });
  await f.store.save(made.sessionId, card());
  const entry = (await sessions.historyEntry(f.app, made.sessionId)).entry;
  await fsp.unlink(entry.path);
  assert.equal((await f.store.save(made.sessionId, card())).ok, false);
  assert.equal((await f.store.read(made.sessionId)).ok, false);
  assert.equal((await sessions.historyEntry(f.app, made.sessionId)).notFound, true);
});

test('旧窗口卡片 revision 不能覆盖较新修改', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '多窗口' });
  const first = (await f.store.save(made.sessionId, card())).card;
  assert.equal((await f.store.save(made.sessionId, { ...first, prompt: '最新修改' })).ok, true);
  const stale = await f.store.save(made.sessionId, { ...first, prompt: '旧窗口' });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /已.*更新|版本/);
  assert.equal((await f.store.read(made.sessionId)).cards[0].prompt, '最新修改');
});

test('已有 Runner 与云端会话也能持久化卡片，不初始化对应底座', async t => {
  const f = await fixture(t);
  for (const adapterId of ['codex', 'cloud']) {
    const id = 'existing-' + adapterId;
    memories.bind(f.app, id, f.current(), [], true);
    f.live.set(id, { sessionId: id, adapterId, usageIdentity: { hub: f.current().hub, clientId: f.current().clientId },
      historyRow: () => ({ id, adapterId, count: 2 }) });
    assert.equal((await f.store.save(id, card())).ok, true);
    const got = await f.store.read(id);
    assert.equal(got.cards.length, 1);
    assert.equal(got.workOnly, false);
  }
  assert.equal(f.imported(), 0);
});

test('没有卡片的既有会话返回空列表，不伪报丢失', async t => {
  const f = await fixture(t);
  f.live.set('legacy', { sessionId: 'legacy', usageIdentity: { hub: f.current().hub, clientId: f.current().clientId },
    historyRow: () => ({ id: 'legacy', count: 3 }) });
  assert.deepEqual((await f.store.read('legacy')).cards, []);
});

test('导入存储 SDK 期间切账号不建立旧账号会话', async t => {
  let loaded;
  const wait = new Promise(resolve => { loaded = resolve; });
  const f = await fixture(t, { loadStorageSdk: () => wait });
  const pending = f.store.reserve({ title: '迟到创建' });
  await new Promise(resolve => setImmediate(resolve));
  f.changeIdentity(identity('account-b')); loaded(f.native);
  assert.equal((await pending).ok, false);
  assert.deepEqual((await sessions.history(f.app)).chats, []);
});

for (const [label, invalid] of [
  ['未知动作', () => card({ actionId: 'shell.execute' })],
  ['无效标识', () => card({ id: '../../escape' })],
  ['函数状态', () => card({ state: { callback() {} } })],
  ['过多附件', () => card({ files: Array.from({ length: 33 }, () => card().files[0]) })],
  ['损坏 Base64', () => card({ files: [{ ...card().files[0], data: 'not-base64!' }] })],
  ['路径注入', () => card({ files: [{ ...card().files[0], path: 'C:/secret' }] })],
]) test(label + '显式拒绝，不能静默裁剪或保存半份', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: label });
  const result = await f.store.save(made.sessionId, invalid());
  assert.equal(result.ok, false);
  assert.ok(result.reason);
  assert.deepEqual((await f.store.read(made.sessionId)).cards, []);
});

test('写盘失败显式报告并保留上次完整卡片，下一次可重试', async t => {
  let fail = false;
  const f = await fixture(t, { replace: async (...args) => {
    if (fail) throw Object.assign(Error('isolated disk failure'), { code: 'EACCES' });
    return fsp.rename(...args);
  } });
  const made = await f.store.reserve({ title: '写盘恢复' });
  const first = await f.store.save(made.sessionId, card());
  fail = true;
  const rejected = await f.store.save(made.sessionId, { ...first.card, prompt: '不可丢掉的旧卡片' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /isolated disk failure/);
  assert.deepEqual((await f.store.read(made.sessionId)).cards, [first.card]);
  fail = false;
  assert.equal((await f.store.save(made.sessionId, { ...first.card, prompt: '重试成功' })).ok, true);
});

test('保存进入等待后切账号，拒绝旧请求且原账号卡片不变', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '身份竞态' });
  const first = await f.store.save(made.sessionId, card());
  let calls = 0;
  const guarded = f.module.create({ ...f.dependencies, identityOf: async () => {
    calls++;
    if (calls === 3) f.changeIdentity(identity('account-b'));
    return f.current();
  } });
  assert.equal((await guarded.save(made.sessionId, { ...first.card, prompt: '迟到覆盖' })).ok, false);
  f.changeIdentity(identity());
  assert.deepEqual((await f.store.read(made.sessionId)).cards, [first.card]);
});

test('落盘前原会话已删除时拒绝保存，不靠旧索引恢复档案', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '删除竞态' });
  const entry = (await sessions.historyEntry(f.app, made.sessionId)).entry;
  let finds = 0;
  const guarded = f.module.create({ ...f.dependencies, session: { ...f.dependencies.session,
    archivedConversation: async (_app, id) => {
      if (++finds === 2) await fsp.unlink(entry.path);
      return (await sessions.historyEntry(f.app, id)).entry || null;
    } } });
  assert.equal((await guarded.save(made.sessionId, card())).ok, false);
  assert.equal(fs.existsSync(f.module.location(f.app, made.sessionId)), false);
});

test('损坏存档显式报错，不能用新卡片覆盖损坏数据', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '损坏数据' });
  await f.store.save(made.sessionId, card());
  const file = f.module.location(f.app, made.sessionId);
  await fsp.writeFile(file, '{broken');
  assert.equal((await f.store.read(made.sessionId)).ok, false);
  assert.equal((await f.store.save(made.sessionId, card())).ok, false);
  assert.equal(await fsp.readFile(file, 'utf8'), '{broken');
});

test('local form and ordinary history are shared while cloud ownership stays isolated', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '账号专属历史' });
  require('../main/conversation/session-memory').bind(f.app, 'ordinary', identity('account-b'), [], true);
  const rows = (await sessions.history(f.app, 50)).chats.concat({ id: 'ordinary', count: 1 });
  assert.deepEqual(new Set(f.module.visibleHistory(f.app, rows, identity('account-b')).map(item => item.id)), new Set([made.sessionId, 'ordinary']));
  const cloud = { id: 'cloud-private', cloud: true, remoteProjection: true,
    owner: scope(f.current()), count: 1 };
  assert.deepEqual(f.module.visibleHistory(f.app, [cloud], identity('account-b')), []);
  const own = f.module.visibleHistory(f.app, rows, f.current());
  assert.ok(own.some(item => item.id === made.sessionId));
  assert.ok(own.every(item => !Object.hasOwn(item, 'workOwner')));
});

test('较大附件及长正文保留完整字节，不受正则回溯或隐式截断影响', async t => {
  const f = await fixture(t), made = await f.store.reserve({ title: '长材料' });
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x57);
  const note = '完整原文。'.repeat(600) + '最后约束';
  const result = await f.store.save(made.sessionId, card({ state: { note },
    files: [{ name: 'binary.dat', type: 'application/octet-stream', lastModified: 1, data: bytes.toString('base64') }] }));
  assert.equal(result.ok, true, result.reason);
  const got = (await f.store.read(made.sessionId)).cards[0];
  assert.equal(got.state.note, note);
  assert.deepEqual(Buffer.from(got.files[0].data, 'base64'), bytes);
});

test('真实 IPC 只接受桌面主帧，创建后广播真实会话 presence', async t => {
  const f = await fixture(t), routes = new Map(), sent = [];
  f.module.install({ ...f.dependencies, ipcMain: { handle: (name, handler) => routes.set(name, handler) },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } }] } });
  const frame = {}, sender = { mainFrame: frame, isDestroyed: () => false,
    getURL: () => pathToFileURL(path.resolve(__dirname, '../index.html')).href };
  const event = { sender, senderFrame: frame };
  const reserve = routes.get('pi-session-reserve-work');
  assert.equal((await reserve({ sender, senderFrame: {} }, { title: '不受信任来源' })).ok, false);
  assert.equal(f.imported(), 0);
  const made = await reserve(event, { title: '真实 IPC 存储' });
  assert.equal(made.ok, true, made.reason);
  assert.equal(sent[0][0], 'pi-session-event');
  assert.equal(sent[0][1].presence.id, made.sessionId);
  assert.equal(sent[0][1].kind, 'work-conversation-created');
  assert.equal((await routes.get('pi-session-save-work-card')(event, made.sessionId, card())).ok, true);
  assert.equal((await routes.get('pi-session-work-cards')(event, made.sessionId)).cards.length, 1);
  const writeSelection = routes.get('pi-session-save-work-draft-selection');
  assert.equal((await writeSelection({ sender, senderFrame: {} }, made.sessionId,
    { selection: draftSelection(), revision: 0 })).ok, false);
  assert.equal((await writeSelection(event, made.sessionId, { selection: draftSelection(), revision: 0 })).ok, true);
  assert.deepEqual((await routes.get('pi-session-work-cards')(event, made.sessionId)).draftSelection, draftSelection());
});

test('真实 preload 只转发草稿选择到专用受信任 IPC', async () => {
  const exposed = {}, calls = [];
  require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
        ipcRenderer: Object.assign(new (require('node:events').EventEmitter)(), {
          invoke: async (...args) => { calls.push(args); return { ok: true }; },
        }) };
    },
  });
  const request = { selection: draftSelection(), revision: 2 };
  await exposed.soduWorkAPI.conversationSession.saveWorkDraftSelection('session-a', request);
  assert.deepEqual(calls, [['pi-session-save-work-draft-selection', 'session-a', request]]);
});

async function workerStorageFixture(t, hooks = {}) {
  const f = await fixture(t), storage = require('../main/agent-runtime/process-storage');
  const calls = { plan: 0, commit: 0, abandon: 0 };
  let planned;
  const worker = { ...f.dependencies.session,
    async reserveArchive(app, cwd, title, owner) {
      calls.plan++; planned = await storage.plan(app, cwd, title, owner);
      await hooks.afterPlan?.(f, planned); return planned;
    },
    async commitArchive(app, reservation) {
      calls.commit++; const result = await storage.commit(app, reservation);
      await hooks.afterCommit?.(f, reservation); return result;
    },
    async abandonArchive(app, reservation) {
      calls.abandon++; await hooks.beforeAbandon?.(f, reservation);
      return storage.abandon(app, reservation);
    },
  };
  const store = f.module.create({ ...f.dependencies, loadStorageSdk: undefined, session: worker });
  return { ...f, store, calls, planned: () => planned };
}

test('生产默认创建通过运行时存储 RPC，不在主进程加载存储 SDK', async t => {
  const f = await workerStorageFixture(t);
  const made = await f.store.reserve({ title: '运行时存储的真实草稿' });
  assert.equal(made.ok, true, made.reason);
  assert.equal(f.imported(), 0);
  assert.deepEqual(f.calls, { plan: 1, commit: 1, abandon: 0 });
  const found = (await sessions.historyEntry(f.app, made.sessionId)).entry;
  assert.equal(found.workOnly, true);
  assert.equal(found.title, '运行时存储的真实草稿');
});

for (const boundary of ['afterPlan', 'afterCommit']) {
  test('运行时' + boundary + '期间换账号会清理本次草稿和记忆绑定', async t => {
    const f = await workerStorageFixture(t, { [boundary]: fixture => fixture.changeIdentity(identity('account-b')) });
    const made = await f.store.reserve({ title: '迟到跨账号草稿' });
    assert.equal(made.ok, false);
    assert.match(made.reason, /账号或服务已切换/);
    assert.equal(fs.existsSync(f.planned().file), false);
    assert.equal((await sessions.history(f.app)).chats.length, 0);
    const bindings = path.join(f.root, 'session-memory-bindings');
    assert.deepEqual(fs.existsSync(bindings) ? fs.readdirSync(bindings) : [], []);
    assert.equal(f.calls.abandon, 1);
  });
}

test('存储提交已落盘但回执丢失仍只清理本次独占创建的草稿', async t => {
  const f = await workerStorageFixture(t, { afterCommit() { throw Error('isolated lost commit receipt'); } });
  const made = await f.store.reserve({ title: '丢失存储回执' });
  assert.equal(made.ok, false);
  assert.match(made.reason, /lost commit receipt/);
  assert.equal(fs.existsSync(f.planned().file), false);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'session-memory-bindings')), []);
});

test('提交后切账号且运行时不可达，主进程仅回收自身独占草稿', async t => {
  const f = await workerStorageFixture(t, {
    afterCommit(fixture) { fixture.changeIdentity(identity('account-b')); },
    beforeAbandon() { throw Error('isolated worker unavailable'); },
  });
  assert.equal((await f.store.reserve({ title: '宿主安全回收' })).ok, false);
  assert.equal(fs.existsSync(f.planned().file), false);
});

test('迟到失败不会删除被其他会话替换或已经出现消息的存档', async t => {
  for (const replacement of ['replace', 'started']) {
    const f = await workerStorageFixture(t, {
      afterCommit(fixture, reservation) {
        if (replacement === 'replace') {
          fs.renameSync(reservation.file, reservation.file + '.original');
          fs.writeFileSync(reservation.file, 'other writer\n');
        } else fixture.native.SessionManager.open(reservation.file).appendMessage({
          role: 'user', content: 'Started elsewhere', timestamp: Date.now(),
        });
        fixture.changeIdentity(identity('account-b'));
      },
    });
    assert.equal((await f.store.reserve({ title: '不可删除另一个写入者' })).ok, false);
    assert.equal(fs.existsSync(f.planned().file), true);
  }
});
