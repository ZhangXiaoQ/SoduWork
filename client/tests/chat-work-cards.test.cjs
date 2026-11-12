'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { File } = require('node:buffer');

function boot(shared = new Map()) {
  let account = 'alice', serial = 0, captured = null;
  const calls = { reserve: 0, opened: [], saved: [], errors: [], selections: [] };
  const selectionKey = id => account + id + ':selection';
  const api = {
    async reserveWorkConversation({title, draftSelection}) {
      calls.reserve++; const sessionId = 'chat-' + ++serial;
      const saved = {draftSelection: structuredClone(draftSelection), draftSelectionRevision: 1};
      shared.set(selectionKey(sessionId), saved);
      return {ok: true, sessionId, title, ...saved};
    },
    async workCards(id) { return {ok: true, workOnly: true, cards: [...(shared.get(account + id)?.values() || [])],
      ...(shared.get(selectionKey(id)) || {draftSelection:null, draftSelectionRevision:0})}; },
    async saveWorkDraftSelection(id, {selection, revision}) {
      const previous = shared.get(selectionKey(id));
      if (revision !== (previous?.draftSelectionRevision || 0)) return {ok:false, code:'STALE_DRAFT_SELECTION', reason:'选择已更新'};
      const saved = {draftSelection: structuredClone(selection), draftSelectionRevision: revision + 1};
      shared.set(selectionKey(id), saved); calls.selections.push({id, selection: saved.draftSelection});
      return {ok:true, ...saved};
    },
    async saveWorkCard(id, card) {
      const key = account + id;
      if (!shared.has(key)) shared.set(key, new Map());
      const result = structuredClone({...card, revision: (card.revision || 0) + 1});
      shared.get(key).set(card.id, result); calls.saved.push(result);
      return {ok: true, card: result};
    },
  };
  const ctx = {_sessionId: '', _ref: '', _draftKey: 'new', _sessionOptions: {}, _viewEpoch: 0, _snap: null,
    _api: () => api, _mount: () => null, refreshHistory() {}, _render() {},
    async _openWorkAction(command, options) { calls.opened.push({command, options}); return true; }};
  const g = {console, setTimeout, clearTimeout, File, Uint8Array, crypto: require('node:crypto').webcrypto,
    btoa: value => Buffer.from(value, 'binary').toString('base64'), atob: value => Buffer.from(value, 'base64').toString('binary'),
    SoduWorkAPI: {taskStorageKey: () => account,
      getTask: async id => ({id, title:'已保存需求', status:'todo', triageStage:'ready'})}, petSay: value => calls.errors.push(value),
    WorkEntrySheet: {capture: () => captured, close() {}, active: () => null},
    document: {createElement() { throw Error('unexpected DOM'); }}};
  g.window = g; vm.createContext(g);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-work-cards.js'), 'utf8'), g);
  const cards = g.ChatWorkCards.create(ctx);
  return {ctx, api, cards, calls, shared, g, capture: value => {captured = value;}, account: value => {account = value;}};
}
const command = {id: 'work.requirement.create', text: '写一篇400字作文'};

test('stalled card recovery terminates and late replies cannot replace a newer conversation', async () => {
  const h = boot(); h.ctx.OPEN_TIMEOUT_MS = 20;
  let release;
  const read = h.api.workCards;
  h.api.workCards = id => id === 'stalled' ? new Promise(resolve => { release = resolve; }) : read(id);
  const result = await h.cards.restore('stalled');
  assert.equal(result.blocked, true);
  assert.ok(result.reason);
  assert.equal(h.ctx._sessionId, '');
  assert.equal((await h.cards.restore('next')).ok, true);
  release({ok: true, workOnly: true, cards: [], draftSelection: null, draftSelectionRevision: 0});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.ctx._sessionId, 'next');
  assert.equal(h.ctx._draftKey, 'next');
});

test('switching away from pending recovery stays independent of the earlier request', async () => {
  const h = boot(); h.ctx.OPEN_TIMEOUT_MS = 20;
  const read = h.api.workCards;
  h.api.workCards = id => id === 'stalled' ? new Promise(() => {}) : read(id);
  const pending = h.cards.restore('stalled');
  h.ctx._viewEpoch++;
  assert.equal((await h.cards.restore('next')).ok, true);
  assert.equal((await pending).stale, true);
  assert.equal(h.ctx._sessionId, 'next');
});

test('rejected card IPC is a blocked result, while obsolete rejections remain silent', async () => {
  const h = boot();
  h.api.workCards = async () => { throw Error('IPC failed'); };
  assert.equal((await h.cards.restore('unreadable')).blocked, true);
  let reject;
  h.api.workCards = () => new Promise((_resolve, fail) => { reject = fail; });
  const pending = h.cards.restore('previous');
  await new Promise(resolve => setImmediate(resolve));
  h.ctx._viewEpoch++;
  reject(Error('Obsolete IPC failed'));
  assert.equal((await pending).stale, true);
});

test('本会话创建回执查询不会把其他账号、会话、未成功或已删除的需求当作新建需求', async () => {
  const h=boot(), seed=await h.cards.prepare(command);
  const id=h.ctx._sessionId;
  assert.equal(h.cards.hasCreatedTask('created',id),false);
  seed.onCardState({phase:'succeeded',ownerScope:'alice',receipt:{id:'created'}});
  assert.equal(h.cards.hasCreatedTask('created',id),true);
  assert.equal(h.cards.hasCreatedTask('other',id),false);
  assert.equal(h.cards.hasCreatedTask('created','another-session'),false);
  h.account('bob'); assert.equal(h.cards.hasCreatedTask('created',id),false); h.account('alice');
  seed.onCardState({phase:'succeeded',ownerScope:'bob',receipt:{id:'created'}});
  assert.equal(h.cards.hasCreatedTask('created',id),false);
  seed.onCardState({phase:'succeeded',receipt:{id:'created',gone:true}});
  assert.equal(h.cards.hasCreatedTask('created',id),false);
  await h.cards.flush();
});

test('需求卡按创建位置保存在消息之间，新增消息及恢复不会把卡片移到末尾', async () => {
  const h = boot(); h.ctx._sessionId = 'existing';
  h.ctx._snap = {messages:[{role:'user',taskOutputKey:'u1'}, {role:'assistant',taskOutputKey:'a1'}]};
  await h.cards.prepare(command); await h.cards.flush();
  h.ctx._snap.messages.push({role:'user',taskOutputKey:'u2'}, {role:'assistant',taskOutputKey:'a2'});
  assert.equal(h.cards.timeline(h.ctx._snap.messages)[0].index, 2);
  const fresh=boot(h.shared); fresh.ctx._ref='native-ref'; fresh.ctx._snap=h.ctx._snap;
  await fresh.cards.restore('existing');
  assert.equal(fresh.cards.timeline(fresh.ctx._snap.messages)[0].index, 2);
  assert.equal(fresh.cards.timeline(fresh.ctx._snap.messages,3).length, 0, 'older card waits for its history window');
});

test('首轮卡片固定在执行消息之前；旧卡片用原创建时间恢复顺序', async () => {
  const h=boot(); await h.cards.prepare(command); await h.cards.flush();
  h.ctx._snap.messages=[{role:'user',sentAt:200},{role:'assistant',completedAt:300}];
  assert.equal(h.cards.timeline(h.ctx._snap.messages)[0].index,0);
  const card=h.shared.get('alicechat-1').values().next().value;
  delete card.seed.transcriptAnchor; card.createdAt=250;
  const fresh=boot(h.shared); fresh.ctx._ref='native-ref'; fresh.ctx._snap=h.ctx._snap;
  await fresh.cards.restore('chat-1');
  assert.equal(fresh.cards.timeline(fresh.ctx._snap.messages)[0].index,1);
});

test('多张需求卡使用原生消息索引，历史分页加载后回到各自锚点', async () => {
  const h=boot(); h.ctx._sessionId='paged'; h.ctx._ref='native-ref';
  const messages=[{role:'user'}, {role:'assistant'}, {role:'user'}];
  h.ctx._snap={messages:messages.slice(0,2),history:{messageIndices:[100,103]}};
  const first=await h.cards.prepare(command);
  h.ctx._snap={messages,history:{messageIndices:[100,103,110]}};
  const second=await h.cards.prepare(command);
  const third=await h.cards.prepare(command);
  await h.cards.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(h.cards.timeline(messages))),
    [{id:first.cardId,index:2},{id:second.cardId,index:3},{id:third.cardId,index:3}]);
  h.ctx._snap={messages:[{role:'assistant'}],history:{messageIndices:[111]}};
  assert.deepEqual(JSON.parse(JSON.stringify(h.cards.timeline(h.ctx._snap.messages))),
    [{id:second.cardId,index:0},{id:third.cardId,index:0}], 'older card is outside the loaded history');
  h.ctx._snap={messages:[...messages,{role:'assistant'}],history:{messageIndices:[100,103,110,111]}};
  assert.deepEqual(JSON.parse(JSON.stringify(h.cards.timeline(h.ctx._snap.messages))),
    [{id:first.cardId,index:2},{id:second.cardId,index:3},{id:third.cardId,index:3}]);
});

test('已启动会话先恢复消息再激活卡片，读取卡片不会提前重建表单', async () => {
  const h=boot(), seed=await h.cards.prepare(command); await h.cards.flush();
  h.cards.detach(); h.ctx._ref='native-ref'; h.calls.opened.length=0;
  const read=h.api.workCards;
  h.api.workCards=async id=>({...await read(id),workOnly:false});
  await h.cards.restore(h.ctx._sessionId);
  assert.equal(h.calls.opened.length,0);
  await h.cards.restoreActive();
  assert.equal(h.calls.opened.length,1);
  assert.equal(h.calls.opened[0].options.cardRecord.id,seed.cardId);
});

function restoredSessionInfo(h) {
  const intentFile = path.join(__dirname, '../components/panels/chat-work-intent.js');
  vm.runInContext(fs.readFileSync(intentFile, 'utf8'), h.g, {filename: intentFile});
  h.g._workModel = h.g.ChatWorkIntent.create(h.ctx)._workModel;
  h.g._collabEntries = () => [];
  h.g.global = h.g;
  for (const key of ['_ref', '_sessionId', '_sessionOptions', '_snap', '_wd', '_activeCollabTaskId']) {
    Object.defineProperty(h.g, key, {get: () => h.ctx[key]});
  }
  // Use NativeChat's public projection unchanged. Stubbing sessionInfo or its
  // _workModel getter hides the null model produced by real work-card restore.
  const panelFile = path.join(__dirname, '../components/panels/panels-chat.js');
  const source = fs.readFileSync(panelFile, 'utf8');
  const start = source.indexOf('  function sessionInfo() {');
  const end = source.indexOf('  function hasSession()', start);
  assert(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), h.g,
    {filename: panelFile, lineOffset: source.slice(0, start).split('\n').length - 1});
  return h.g.sessionInfo();
}

test('restored default and explicit work-card models remain readable through the real sessionInfo getter', async () => {
  for (const modelName of ['', 'chosen-model']) {
    const h = boot();
    h.shared.set('alicemodel-draft:selection', {draftSelection: {adapterId:'pi', modelName,
      modelLabel:modelName, reasoningEffort:'', thinkingLevel:''}, draftSelectionRevision:1});
    await h.cards.restore('model-draft');
    assert.equal(h.ctx._snap.modelSelection.name, modelName);
    if (!modelName) assert.equal(h.ctx._snap.modelSelection.model, null);
    else assert.equal(h.ctx._snap.modelSelection.model.id, modelName);
    const info = restoredSessionInfo(h);
    assert.equal(info.sessionId, 'model-draft');
    assert.equal(info.model, modelName, 'default remains empty; explicit selection remains unchanged');
    assert.equal(h.calls.reserve, 0);
    assert.equal(h.calls.opened.length, 0);
  }
});

test('sessionInfo uses a resolved model object and never invents a model for an unresolved default', async () => {
  const h = boot();
  await h.cards.restore('default-draft');
  h.ctx._sessionOptions.modelName = 'stale-previous-choice';
  assert.equal(restoredSessionInfo(h).model, '', 'the default snapshot must not inherit an older selection');
  h.ctx._snap.modelSelection.model = {id: 'resolved-default-model'};
  assert.equal(h.g.sessionInfo().model, 'resolved-default-model');
  h.ctx._snap.modelSelection.name = 'explicit-selection';
  assert.equal(h.g.sessionInfo().model, 'explicit-selection');
});

test('创建回执尚在防抖队列时首次需求打开必须等它写入会话', async () => {
  const h = boot();
  const seed = await h.cards.prepare(command, {});
  const sessionId = h.ctx._sessionId;
  await h.cards.flush();
  seed.onCardState({ phase: 'succeeded', receipt: { id: 'created-task' } });
  assert.notEqual(h.calls.saved.at(-1).state.phase, 'succeeded');
  let release;
  const originalSave = h.api.saveWorkCard;
  h.api.saveWorkCard = async (...args) => {
    await new Promise(resolve => { release = resolve; });
    return originalSave(...args);
  };
  const opened = [], failures = [];
  const boundaryReason = 'Isolated test stopped at native open';
  h.api.open = async options => {
    opened.push({ options: structuredClone(options), receipt: h.calls.saved.at(-1).state.receipt });
    return { ok: false, reason: boundaryReason };
  };
  Object.assign(h.ctx, { _workCards: h.cards, _sessionOptions: { taskRef: 'created-task' },
    _openingTask: null, _openingEpoch: -1, _busy: false, OPEN_TIMEOUT_MS: 1000,
    _fail: (...args) => failures.push(args) });
  // Keep both _ensure and _ensureOnce real: the API boundary must not be
  // reached until the successful work-card receipt has actually been saved.
  const controllerFile = path.join(__dirname, '../components/panels/chat-session-controller.js');
  vm.runInContext(fs.readFileSync(controllerFile, 'utf8'), h.g, { filename: controllerFile });
  const controller = h.g.ChatSessionController.create(h.ctx);
  const pending = controller._ensure();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(opened.length, 0, 'runtime must remain unopened while receipt persistence is pending');
  } finally { release(); }
  assert.equal(await pending, false, 'stop at the isolated native API boundary');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].receipt.id, 'created-task', 'native open must observe the saved receipt');
  assert.equal(opened[0].options.chatId, sessionId);
  assert.equal(opened[0].options.taskRef, 'created-task');
  assert.equal(opened[0].options.requireTaskBinding, true);
  assert.deepEqual(failures, [['开不了对话', boundaryReason, null, {ok:false,reason:boundaryReason}]]);
});

test('首次需求打开在回执保存失败时显示实际错误，重试成功后才进入 native open', async () => {
  const h = boot(), seed = await h.cards.prepare(command, {});
  assert.equal((await h.cards.flush()).ok, true);
  seed.onCardState({phase:'succeeded', receipt:{id:'created-task'}});
  const save = h.api.saveWorkCard;
  h.api.saveWorkCard = async () => ({ok:false, reason:'磁盘写入失败，请释放空间'});
  const opened = [], failures = [];
  h.api.open = async options => {
    opened.push({options, receipt:h.calls.saved.at(-1).state.receipt});
    return {ok:false, reason:'isolated native boundary'};
  };
  Object.assign(h.ctx, {_workCards:h.cards, _sessionOptions:{taskRef:'created-task'},
    OPEN_TIMEOUT_MS:1000, _fail:(...args)=>failures.push(args)});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-session-controller.js'), 'utf8'), h.g);
  const controller = h.g.ChatSessionController.create(h.ctx);
  assert.equal(await controller._ensure(), false);
  assert.equal(opened.length, 0);
  assert.deepEqual(failures, [['需求回执尚未保存', '磁盘写入失败，请释放空间']]);
  assert.notEqual(h.calls.saved.at(-1).state.phase, 'succeeded');
  h.api.saveWorkCard = save;
  assert.equal(await controller._ensure(), false, 'stop at the isolated native boundary');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].receipt.id, 'created-task');
  assert.deepEqual(failures.at(-1), ['开不了对话', 'isolated native boundary', null, {ok:false,reason:'isolated native boundary'}]);
});

test('定向回执保存不等待其他卡片，普通全量保存仍报告它们的失败', async () => {
  const h = boot(), other = await h.cards.prepare(command, {});
  other.onCardState({phase:'draft', draft:{title:'其他卡片'}});
  const target = await h.cards.prepare({...command,text:''}, {proposal:{title:'目标'}});
  await h.cards.flush();
  const save = h.api.saveWorkCard;
  h.api.saveWorkCard = async (id, card) => card.id === other.cardId
    ? {ok:false, reason:'其他卡片保存失败'} : save(id, card);
  other.onCardState({phase:'draft', draft:{title:'其他卡片的新修改'}});
  target.onCardState({phase:'succeeded', receipt:{id:'target-task'}});
  const result = await h.cards.flush({sessionId:h.ctx._sessionId, taskId:'target-task'});
  assert.equal(result.ok, true);
  assert.equal(h.calls.saved.at(-1).state.receipt.id, 'target-task');
  const missing = await h.cards.flush({sessionId:h.ctx._sessionId, taskId:'another-task'});
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /创建回执尚未准备好/);
  const all = await h.cards.flush();
  assert.equal(all.ok, false);
  assert.equal(all.reason, '其他卡片保存失败');
});

test('目标回执保存期间切换账号或会话不能继续打开执行内核', async () => {
  for (const change of ['account', 'navigation']) {
    const h = boot(), seed = await h.cards.prepare(command, {});
    await h.cards.flush();
    seed.onCardState({phase:'succeeded', receipt:{id:'created-task'}});
    const gate = deferred(), save = h.api.saveWorkCard;
    let saving = false, opens = 0;
    const failures = [];
    h.api.saveWorkCard = async (...args) => {saving=true; await gate.promise; return save(...args);};
    h.api.open = async () => {opens++; return {ok:false};};
    Object.assign(h.ctx, {_workCards:h.cards, _sessionOptions:{taskRef:'created-task'},
      OPEN_TIMEOUT_MS:1000, _fail:(...args)=>failures.push(args)});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-session-controller.js'), 'utf8'), h.g);
    const opening = h.g.ChatSessionController.create(h.ctx)._ensure();
    while (!saving) await new Promise(resolve => setImmediate(resolve));
    if (change === 'account') {h.account('bob'); h.cards.clearScope();}
    else {h.ctx._viewEpoch++; h.ctx._sessionId='another-session';}
    gate.resolve();
    assert.equal(await opening, false, change);
    assert.equal(opens, 0, change);
    assert.equal(failures.length, 0, change + ' must not paint into the new scope');
  }
});

test('工作会话保存独立执行选择，跨实例恢复且不从解析模型或权限推断', async () => {
  const h=boot(); Object.assign(h.ctx._sessionOptions, {adapterId:'qwen', modelName:'chosen', modelLabel:'所选模型',
    reasoningEffort:'high', thinkingLevel:'medium', accessMode:'full', accessConsentId:'never-store'});
  await h.cards.prepare(command, {model:'parser-model'}); await h.cards.flush();
  const fresh=boot(h.shared); await fresh.cards.restore('chat-1');
  assert.equal(fresh.ctx._sessionOptions.adapterId, 'qwen');
  assert.equal(fresh.ctx._sessionOptions.modelName, 'chosen');
  assert.equal(fresh.ctx._sessionOptions.modelLabel, '所选模型');
  assert.equal(fresh.ctx._sessionOptions.reasoningEffort, 'high');
  assert.equal(fresh.ctx._sessionOptions.thinkingLevel, 'medium');
  assert.equal(fresh.ctx._sessionOptions.accessMode, undefined);
  assert.equal(fresh.ctx._sessionOptions.accessConsentId, undefined);
  assert.deepEqual(Object.keys(h.shared.get('alicechat-1:selection').draftSelection).sort(),
    ['adapterId','modelName','modelLabel','reasoningEffort','thinkingLevel'].sort());
});

test('底栏改选立即保存，发送等待最新选择落盘；保存失败保留选择并拒绝按默认发送', async () => {
  const h=boot(); h.ctx._sessionOptions.modelName='original'; await h.cards.prepare(command, {});
  const save=h.api.saveWorkDraftSelection; let finish;
  h.api.saveWorkDraftSelection=async (...args)=>{await new Promise(resolve=>{finish=resolve;});return save(...args);};
  h.ctx._sessionOptions.modelName='second'; const first=h.cards.saveDraftSelection(); await tick();
  h.ctx._sessionOptions.modelName='latest'; const ready=h.cards.ensureDraftSelectionSaved();
  finish(); await tick(); finish();
  assert.equal(await first,true); assert.equal(await ready,true);
  assert.equal(h.shared.get('alicechat-1:selection').draftSelection.modelName,'latest');
  h.api.saveWorkDraftSelection=async()=>({ok:false,reason:'磁盘不可写'});
  h.ctx._sessionOptions.modelName='unsaved';
  assert.equal(await h.cards.ensureDraftSelectionSaved(),false);
  assert.equal(h.ctx._sessionOptions.modelName,'unsaved');
  assert.match(h.calls.errors.join(' '),/磁盘不可写/);
  h.api.saveWorkDraftSelection=save;
  assert.equal(await h.cards.ensureDraftSelectionSaved(),true);
});

test('未初始化会话读取失败阻止默认回退，已运行会话不采用旧草稿选择', async () => {
  const h=boot(); h.ctx._sessionOptions.modelName='selected'; await h.cards.prepare(command,{}); await h.cards.flush();
  h.api.workCards=async()=>({ok:false,reason:'选择读取失败'});
  assert.equal((await h.cards.restore('chat-1')).blocked,true);
  assert.equal(h.ctx._sessionOptions.modelName,'selected');
  h.ctx._ref='live-ref'; h.ctx._snap={modelSelection:{name:'live-model'}};
  h.ctx._sessionOptions={adapterId:'pi',modelName:'live-model'};
  h.api.workCards=async()=>({ok:true,workOnly:false,cards:[],draftSelection:{adapterId:'qwen',modelName:'stale'}});
  await h.cards.restore('chat-1');
  assert.equal(h.ctx._sessionOptions.modelName,'live-model');
  assert.equal(await h.cards.ensureDraftSelectionSaved(),true);
});

test('旧会话模型保存迟到或失败不改变新页面；旧账号响应不能恢复选择', async () => {
  const h=boot(); await h.cards.prepare(command,{}); let finish;
  h.api.saveWorkDraftSelection=()=>new Promise(resolve=>{finish=resolve;});
  h.ctx._sessionOptions.modelName='old'; const saving=h.cards.saveDraftSelection(); await tick();
  h.cards.detach(); h.ctx._viewEpoch++; h.ctx._sessionId='new'; h.ctx._sessionOptions={modelName:'new'};
  finish({ok:false,reason:'old error'}); assert.equal(await saving,false);
  assert.equal(h.ctx._sessionOptions.modelName,'new'); assert.equal(h.calls.errors.length,0);
  h.api.workCards=()=>new Promise(resolve=>{finish=resolve;});
  const restore=h.cards.restore('other'); await tick(); h.cards.clearScope();h.account('bob');
  finish({ok:true,workOnly:true,cards:[],draftSelection:{adapterId:'pi',modelName:'old'},draftSelectionRevision:1});
  assert.equal((await restore).stale,true); assert.equal(h.ctx._sessionOptions.modelName,'new');
});

test('同一表单读取期间的新改选不会被迟到旧快照覆盖', async () => {
  const h=boot();h.ctx._sessionOptions.modelName='first';await h.cards.prepare(command,{});await h.cards.flush();
  const old=await h.api.workCards('chat-1');let finish;
  h.api.workCards=()=>new Promise(resolve=>{finish=resolve;});
  const restoring=h.cards.restore('chat-1');await tick();
  h.ctx._sessionOptions.modelName='latest';await h.cards.saveDraftSelection();
  finish(old);await restoring;
  assert.equal(h.ctx._sessionOptions.modelName,'latest');
  h.ctx._sessionOptions.modelName='next';assert.equal(await h.cards.ensureDraftSelectionSaved(),true);
  assert.equal(h.shared.get('alicechat-1:selection').draftSelection.modelName,'next');
});

test('损坏的会话选择显式阻止恢复，不降级成空模型或默认 Agent', async () => {
  const h=boot();h.ctx._sessionOptions.modelName='retained';
  h.api.workCards=async()=>({ok:true,workOnly:true,cards:[],draftSelection:{adapterId:'qwen',modelName:42},draftSelectionRevision:1});
  const result=await h.cards.restore('broken');
  assert.equal(result.blocked,true);assert.match(result.reason,/选择.*格式/);
  assert.equal(h.ctx._sessionId,'');assert.equal(h.ctx._sessionOptions.modelName,'retained');
});

test('跨窗口冲突拒绝覆盖，但重新打开可采用权威选择或已经启动的会话', async () => {
  for (const started of [false,true]) {
    const h=boot();await h.cards.prepare(command,{});await h.cards.flush();
    h.ctx._sessionOptions.modelName='local-unsaved';
    h.api.saveWorkDraftSelection=async()=>({ok:false,code:started?'WORK_CONVERSATION_STARTED':'STALE_DRAFT_SELECTION',reason:'会话已变化'});
    assert.equal(await h.cards.ensureDraftSelectionSaved(),false);
    h.api.workCards=async()=>({ok:true,workOnly:!started,cards:[],draftSelection:started?null:{adapterId:'qwen',
      modelName:'remote',modelLabel:'remote',reasoningEffort:'',thinkingLevel:''},draftSelectionRevision:started?0:5});
    const restored=await h.cards.restore('chat-1');
    assert.equal(restored.blocked,undefined);assert.equal(restored.workOnly,!started);
    if (!started) assert.equal(h.ctx._sessionOptions.modelName,'remote');
  }
});

test('新表单先建立真实历史会话；不打开 Agent，需求与自动化共用会话', async () => {
  const h = boot();
  const a = await h.cards.prepare(command, {});
  assert.equal(h.ctx._sessionId, 'chat-1'); assert.ok(a.cardId);
  a.onCardState({phase: 'draft', draft: {title: '手改标题'}, files: []});
  h.cards.detach();
  const b = await h.cards.prepare({id: 'work.automation.create', text: '明天提醒'}, {});
  assert.notEqual(a.cardId, b.cardId); assert.equal(h.calls.reserve, 1);
  await h.cards.flush();
});

test('创建完成保留当前会话结果卡，只在主动打开时进入需求', async () => {
  const h=boot(); let opened=0;
  const seed=await h.cards.prepare(command,{bridge:{onPersisted(){opened++;},onCreated(){opened++;},onOpen(){opened++;}}});
  seed.bridge.onPersisted?.(); seed.bridge.onCreated?.();
  assert.equal(opened,0); seed.bridge.onOpen(); assert.equal(opened,1);
  await h.cards.flush();
});

test('成功创建自己的需求加入当前待办，转交和自动化不会加入，也不调用旧导航回调', async () => {
  for (const kind of ['own', 'handed-off', 'automation']) {
    const h=boot(), bound=[];
    h.ctx._bindCollaborationTask=(...args)=>bound.push(args);
    h.ctx._collabTasks=new Map();
    const seed=await h.cards.prepare(kind==='automation'?{id:'work.automation.create',text:'提醒'}:command,
      {bridge:{onCreated(){throw Error('legacy navigation must not run');},onPersisted(){throw Error('legacy launch must not run');}}});
    seed.onCardState({phase:'succeeded',receipt:{id:'task-1',title:'已保存需求',gone:kind==='handed-off'}});
    await seed.onCreated('task-1','已保存需求',{handedOff:kind==='handed-off'});
    assert.equal(bound.length,kind==='own'?1:0);
    if (kind==='own') {
      assert.equal(bound[0][0],'task-1'); assert.equal(bound[0][2].persist,false);
    }
    assert.equal(h.calls.opened.length,0);
  }
});

test('创建时切走只保存来源回执，回来恢复待办且不重复覆盖已有需求', async () => {
  const h=boot(), bound=[]; h.ctx._bindCollaborationTask=(...args)=>bound.push(args);
  h.ctx._collabTasks=new Map();
  const seed=await h.cards.prepare(command,{});
  h.cards.detach();h.ctx._viewEpoch++;h.ctx._sessionId='other-chat';
  seed.onCardState({phase:'succeeded',receipt:{id:'task-1',title:'来源需求',gone:false}});
  seed.onCreated('task-1','来源需求',{});
  await h.cards.flush(); assert.equal(bound.length,0);
  await h.cards.restore('chat-1'); await h.cards.restoreRequirements();
  assert.equal(bound.length,1); assert.equal(bound[0][0],'task-1');
  h.ctx._collabTasks.set('task-1',{taskId:'task-1',queueState:'completed'});
  await h.cards.restore('chat-1'); await h.cards.restoreRequirements();
  assert.equal(bound.length,1,'已有执行/移除状态不因回执恢复而重绑');
  assert.equal(h.ctx._ref,'');
});

test('a creation receipt stays a reference when execution belongs to another chat', async () => {
  const h=boot(),bound=[];h.ctx._collabTasks=new Map();h.ctx._bindCollaborationTask=(...args)=>bound.push(args);
  const seed=await h.cards.prepare(command);
  seed.onCardState({phase:'succeeded',receipt:{id:'task',title:'Task'}});
  await h.cards.flush();
  h.g.SoduWorkAPI.getTask=async()=>({id:'task',status:'doing',workRouting:{conversationTurn:{conversationId:'execution-chat'}}});
  await h.cards.restoreRequirements();
  assert.equal(bound.length,0);
  assert.equal(h.cards.hasCreatedTask('task',h.ctx._sessionId),true);
});

test('需求回执不能重新加入已移除待办或越过原卡片账号边界', async () => {
  for (const reason of ['removed','wrong-owner']) {
    const h=boot(), bound=[];h.ctx._bindCollaborationTask=(...args)=>bound.push(args);
    h.g.ChatCollaborationStore={isQueueRemoved:()=>reason==='removed'};
    const seed=await h.cards.prepare(command,{});
    seed.onCardState({phase:'succeeded',ownerScope:reason==='wrong-owner'?'other-hub':'alice',
      receipt:{id:'task-1',title:'需求',gone:false}});
    seed.onCreated('task-1','需求',{}); await h.cards.flush();
    await h.cards.restoreRequirements();
    assert.equal(bound.length,0,reason);
  }
});

test('恢复历史回执先核对需求仍存在且可访问，失效或离线不绑定，重试后可恢复', async () => {
  for (const failure of [403,404,410,'offline','readonly','archived','no-execution','wrong-id']) {
    const h=boot(), bound=[]; h.ctx._bindCollaborationTask=(...args)=>bound.push(args);
    const seed=await h.cards.prepare(command,{});
    seed.onCardState({phase:'succeeded',receipt:{id:'task-1',title:'旧需求'}});
    await h.cards.flush(); await h.cards.restore('chat-1');
    h.ctx._ref='initialized-ref';
    h.g.SoduWorkAPI.getTask=async id=>{
      if (typeof failure==='number' || failure==='offline') throw Object.assign(Error('unavailable'),{status:failure});
      return {id:failure==='wrong-id'?'other-task':id,readOnly:failure==='readonly',
        archivedAt:failure==='archived'?'2026-10-21':'',canViewExecution:failure!=='no-execution'};
    };
    await h.cards.restoreRequirements();
    assert.equal(bound.length,0,String(failure));
    h.g.SoduWorkAPI.getTask=async id=>({id,title:'可恢复',status:'todo',triageStage:'ready'});
    await h.cards.restoreRequirements();
    assert.equal(bound.length,1); assert.equal(bound[0][2].persist,true);
    assert.equal(bound[0][2].taskMeta.id,'task-1');
  }
});

test('需求恢复读取迟到时不跨会话、登录周期或已移除待办重绑', async () => {
  for (const change of ['navigation','account','removed','already-bound']) {
    const h=boot(), bound=[]; h.ctx._collabTasks=new Map();
    h.ctx._bindCollaborationTask=(...args)=>bound.push(args);
    const seed=await h.cards.prepare(command,{});
    seed.onCardState({phase:'succeeded',receipt:{id:'task-1',title:'旧需求'}});
    let finish;
    h.g.SoduWorkAPI.getTask=()=>new Promise(resolve=>{finish=resolve;});
    const restoring=h.cards.restoreRequirements(); await tick();
    if(change==='navigation'){h.cards.detach();h.ctx._viewEpoch++;h.ctx._sessionId='elsewhere';}
    if(change==='account'){h.cards.clearScope();h.account('bob');}
    if(change==='removed')h.g.ChatCollaborationStore={isQueueRemoved:()=>true};
    if(change==='already-bound')h.ctx._collabTasks.set('task-1',{taskId:'task-1'});
    assert.equal(typeof finish,'function','恢复必须等待真实需求读取');
    finish({id:'task-1',title:'迟到需求',status:'todo',triageStage:'ready'});
    await restoring;
    assert.equal(bound.length,0,change);
  }
});

for (const [label, established, taskScope] of [
  ['cleared project', {projectId:'p1',repoId:''}, {projectId:'',repoId:''}],
  ['new project', {projectId:'',repoId:''}, {projectId:'p1',repoId:''}],
  ['cleared repository', {projectId:'p1',repoId:'r1'}, {projectId:'p1',repoId:''}],
  ['new repository', {projectId:'p1',repoId:''}, {projectId:'p1',repoId:'r1'}],
]) test('历史回执不越过已初始化会话的严格工程边界: ' + label, async () => {
  const h=boot(), bound=[];
  h.g.RequirementSessionContext=require('../core/requirement-session-context');
  h.ctx._bindCollaborationTask=(...args)=>bound.push(args);
  const seed=await h.cards.prepare(command,{});
  seed.onCardState({phase:'succeeded',receipt:{id:'task-1',title:'旧需求'}});
  h.ctx._ref='initialized-ref';
  h.ctx._snap={status:'idle',requirementContext:established};
  h.g.SoduWorkAPI.getTask=async id=>({id,title:'已改变工程的需求',status:'todo',...taskScope});
  await h.cards.restoreRequirements();
  assert.equal(bound.length,0,'main-process binding rejects empty/nonempty scope changes too');
  await h.cards.flush();
});

test('相同工程回执及没有固定工程边界的草稿仍可恢复待办', async () => {
  for (const mode of ['same','context-repo','task-repo','unbound-draft']) {
    const h=boot(), bound=[];
    h.g.RequirementSessionContext=require('../core/requirement-session-context');
    h.ctx._bindCollaborationTask=(...args)=>bound.push(args);
    const seed=await h.cards.prepare(command,{});
    seed.onCardState({phase:'succeeded',receipt:{id:'task-1',title:'同工程需求'}});
    if(mode!=='unbound-draft') {
      h.ctx._ref='initialized-ref';h.ctx._snap={status:'idle',requirementContext:{projectId:'p1',repoId:'r1'}};
    }
    h.g.SoduWorkAPI.getTask=async id=>({id,title:'同工程需求',status:'todo',projectId:'p1',
      ...(mode==='context-repo'?{workRouting:{executionContext:{repo:{id:'r1'}}}}
        :mode==='task-repo'?{repo:{id:'r1'}}:{repoId:'r1'})});
    await h.cards.restoreRequirements();
    assert.equal(bound.length,1,mode);
    await h.cards.flush();
  }
});

test('切走再回恢复手改字段与附件原件，不重新解析；结果也可跨实例恢复', async () => {
  const h = boot();
  const a = await h.cards.prepare(command, {});
  a.onCardState({phase: 'draft', draft: {title: '手改', kind: 'bug', check: ['尾部约束']}, files: [new File(['原件'], '原型.html', {type:'text/html'})]});
  await h.cards.flush(); h.cards.detach(); h.ctx._viewEpoch++;
  await h.cards.restore('chat-1');
  const restored = h.calls.opened.at(-1).options.cardRecord;
  assert.equal(restored.state.draft.kind, 'bug'); assert.equal(await restored.files[0].text(), '原件');
  a.onCardState({phase: 'succeeded', receipt: {id: 'task-1', title: '手改'}});
  await h.cards.flush();
  const fresh = boot(h.shared); await fresh.cards.restore('chat-1');
  assert.equal(fresh.calls.opened.at(-1).options.cardRecord.state.receipt.id, 'task-1');
});

test('保存中切到另一会话，迟到结果只写原会话，账号变化后丢弃旧响应', async () => {
  const h = boot();
  const a = await h.cards.prepare(command, {});
  h.cards.detach(); h.ctx._viewEpoch++; h.ctx._sessionId = 'chat-2';
  a.onCardState({phase: 'succeeded', receipt: {id: 'task-old'}});
  await h.cards.flush();
  assert.equal(h.shared.get('alicechat-1').get(a.cardId).state.receipt.id, 'task-old');
  assert.equal(h.shared.has('alicechat-2'), false);
  h.account('bob'); a.onCardState({phase:'succeeded', receipt:{id:'wrong'}}); await h.cards.flush();
  assert.equal(h.shared.has('bobchat-1'), false);
});

test('保存失败明确提示，保留内存草稿并支持重试', async () => {
  const h = boot(); const save = h.api.saveWorkCard;
  const a = await h.cards.prepare(command, {});
  h.api.saveWorkCard = async () => ({ok:false, reason:'磁盘不可写'});
  a.onCardState({phase:'draft', draft:{title:'不能丢'}}); await h.cards.flush();
  assert.match(h.calls.errors.join(' '), /磁盘不可写/);
  h.api.saveWorkCard = save; await h.cards.flush();
  assert.equal(h.shared.get('alicechat-1').get(a.cardId).state.draft.title, '不能丢');
});

test('会话读取被归属校验拒绝时向导航返回原始原因且不载入卡片', async () => {
  const h = boot();
  const reason = '这条会话属于另一个账号或服务，请切回原账号';
  h.api.workCards = async () => ({ok:false, reason});
  const result = await h.cards.restore('protected-chat');
  assert.equal(result.blocked, true);
  assert.equal(result.reason, reason);
  assert.equal(h.ctx._sessionId, '');
  assert.equal(h.calls.opened.length, 0);
});

test('账号切走再切回也不能接受上一个登录周期的迟到结果', async () => {
  const h=boot(); const seed=await h.cards.prepare(command,{}); await h.cards.flush();
  h.cards.clearScope(); h.account('bob'); h.cards.clearScope(); h.account('alice');
  seed.onCardState({phase:'succeeded',receipt:{id:'stale'}}); await h.cards.flush();
  assert.equal(h.shared.get('alicechat-1').get(seed.cardId).state.receipt,undefined);
});

test('显式收起后记录仍保留，可从历史继续打开；导航不会调用关闭钩子', async () => {
  const h=boot(); const seed=await h.cards.prepare(command,{});
  seed.onCardState({phase:'draft',draft:{title:'保留'}});seed.onCardClose();await h.cards.flush();
  h.cards.detach();await h.cards.restore('chat-1');
  assert.equal(h.calls.opened.length,0);
  assert.equal(h.shared.get('alicechat-1').get(seed.cardId).state.draft.title,'保留');
  assert.equal(h.shared.get('alicechat-1').get(seed.cardId).closed,true);
});

test('普通消息首次发送沿用工作卡占用的会话，切换会话先保存卡片', () => {
  const src = fs.readFileSync(path.join(__dirname, '../components/panels/chat-session-controller.js'),'utf8');
  assert.match(src, /chatId\s*\|\|\s*ctx\._sessionId/);
  const panel = fs.readFileSync(path.join(__dirname, '../components/panels/panels-chat.js'),'utf8');
  assert.ok(panel.indexOf('_workCards?.detach()') < panel.indexOf('_ref = \'\'; _sessionId = \'\'; _snap = null'));
});

test('需求解析期间保留会话挂载槽位，用户提示和思考状态先显示，完成后再渲染聊天卡片', () => {
  const src = fs.readFileSync(path.join(__dirname, '../components/panels/chat-work-cards.js'), 'utf8');
  assert.match(src, /record\.state\?\.phase === 'loading'/);
  assert.match(src, /!cardHost\(record\)\?\.querySelector\('\.pui-surface'\)/);
  const sheet = fs.readFileSync(path.join(__dirname, '../components/panels/panels-compose-draft.js'), 'utf8');
  assert.match(sheet, /cp-loading-thinking/);
  assert.doesNotMatch(sheet, /_deferInitialCard/);
  const host = fs.readFileSync(path.join(__dirname, '../components/panels/work-entry-sheet.js'), 'utf8');
  assert.doesNotMatch(host, /is-preparing/);
  const actions = fs.readFileSync(path.join(__dirname, '../components/panels/panels-chat-work-actions.js'), 'utf8');
  assert.match(actions, /showPending/);
  assert.match(actions, /data-work-action-pending/);
  assert.match(actions, /cp-loading-chat cp-loading-thinking/);
  const intent = fs.readFileSync(path.join(__dirname, '../components/panels/chat-work-intent.js'), 'utf8');
  assert.match(intent, /ChatWorkActions\.showPending/);
  assert.match(intent, /pending\?\.fail/);
  const css = fs.readFileSync(path.join(__dirname, '../components/panels/panels-chat.css'), 'utf8');
  assert.match(css, /:has\(\.nchat-work-action-pending\)/);
});

test('previously closed successful requirement receipts reopen, without resurrecting dismissed drafts or automation', async () => {
  for (const [actionId, phase, expected] of [
    ['work.requirement.create', 'succeeded', 1],
    ['work.requirement.create', 'draft', 0],
    ['work.automation.create', 'succeeded', 0],
  ]) {
    const h = boot(), seed = await h.cards.prepare({ ...command, id: actionId }, {});
    seed.onCardState({ phase, receipt: phase === 'succeeded' ? { id: 'saved-task' } : null });
    seed.onCardClose(); await h.cards.flush(); h.cards.detach();
    await h.cards.restore('chat-1');
    assert.equal(h.calls.opened.length, expected, actionId + ' ' + phase);
  }
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('空白新建不会覆盖同会话的旧草稿，只有文字补充才复用原卡', async () => {
  const h = boot(); h.g.WorkEntrySheet.active = () => 'work.requirement.create';
  const a = await h.cards.prepare(command, {});
  a.onCardState({phase:'draft', draft:{title:'原草稿'}});
  const refine = await h.cards.prepare({...command,text:'补充要求'}, {});
  assert.equal(refine.cardId, a.cardId);
  const b = await h.cards.prepare({...command,text:''}, {proposal:{title:''}});
  assert.notEqual(b.cardId, a.cardId);
  b.onCardState({phase:'draft', draft:{title:'新草稿'}});
  await h.cards.flush();
  assert.equal(h.shared.get('alicechat-1').get(a.cardId).state.draft.title,'原草稿');
});

test('已有写入未完成时提交必须等提交状态本身落盘，不能提前放行业务请求', async () => {
  const h=boot(); const first=deferred(), second=deferred(); let writes=0, passed=false;
  const save=h.api.saveWorkCard;
  h.api.saveWorkCard=async (...args)=>{ const gate=++writes===1?first:second; await gate.promise;return save(...args); };
  const seed=await h.cards.prepare(command,{});
  seed.onCardState({phase:'draft',draft:{title:'等待'}});const flushing=h.cards.flush();await tick();
  const submitting=seed.onBeforeSubmit({phase:'submitting',submission:{id:'stable-task'}}).then(()=>{passed=true;});
  first.resolve();await tick();
  assert.equal(writes,2);assert.equal(passed,false);
  second.resolve();await Promise.all([flushing,submitting]);
  assert.equal(h.shared.get('alicechat-1').get(seed.cardId).state.submission.id,'stable-task');
});

test('落盘失败拒绝提交握手，重试确认存储后才允许提交', async () => {
  const h=boot();const seed=await h.cards.prepare(command,{});const save=h.api.saveWorkCard;
  h.api.saveWorkCard=async()=>({ok:false,reason:'磁盘已满'});
  await assert.rejects(seed.onBeforeSubmit({phase:'submitting',submission:{id:'task'}}),/磁盘已满/);
  h.api.saveWorkCard=save;
  await seed.onBeforeSubmit({phase:'submitting',submission:{id:'task'}});
  assert.equal(h.shared.get('alicechat-1').get(seed.cardId).state.submission.id,'task');
});

test('同一空白视图连续打开历史，迟到的旧历史不能覆盖后一次选择', async () => {
  const h=boot();const old=deferred();
  h.api.workCards=async id=>id==='old'?old.promise:{ok:true,workOnly:true,cards:[]};
  const pending=h.cards.restore('old');await tick();await h.cards.restore('new');
  old.resolve({ok:true,workOnly:true,cards:[]});const stale=await pending;
  assert.equal(stale.stale,true);assert.equal(h.ctx._sessionId,'new');
});

test('账号切走再切回不能接受上一登录周期的会话读取或占位响应', async () => {
  for(const kind of ['restore','reserve']) {
    const h=boot();const gate=deferred();
    if(kind==='restore')h.api.workCards=()=>gate.promise;else h.api.reserveWorkConversation=()=>gate.promise;
    const pending=kind==='restore'?h.cards.restore('old'):h.cards.prepare(command,{});await tick();
    h.cards.clearScope();h.account('bob');h.cards.clearScope();h.account('alice');
    gate.resolve({ok:true,workOnly:true,cards:[],sessionId:'old'});await pending;
    assert.equal(h.ctx._sessionId,'');
  }
});


test('app schedule saves a visible creation record before network creation and restores its receipt without replay',async()=>{
 const h=boot();let creates=0;
 h.g.WorkAutomationDirect={create:async(params,options)=>{
   await options.onBeforeCreate({title:'test',note:params.text,every:'daily'});
   const saved=h.calls.saved.at(-1);assert.equal(saved.state.phase,'submitting');
   await options.authorize();creates++;return {ok:true,schedule:{id:'schedule-1',title:'test'}};
 }};
 const receipt=await h.cards.runAutomation({text:'每天9点处理素材'},async()=>{});
 assert.equal(receipt.ok,true);assert.equal(creates,1);
 assert.equal(h.cards.timeline([]).length,1,'app automation is in the visible transcript, not the hidden draft area');
 const saved=h.calls.saved.at(-1);assert.equal(saved.state.phase,'succeeded');assert.equal(saved.state.createdId,'schedule-1');
 const fresh=boot(h.shared);await fresh.cards.restore('chat-1');
 assert.equal(fresh.calls.opened.length,0,'a reopened app shows the receipt in its transcript without opening a duplicate form');assert.equal(fresh.cards.timeline([]).length,1);assert.equal(creates,1);
});
test('app schedule never submits when its before-create history save fails; errors are retained',async()=>{
 const h=boot();let creates=0;
 h.api.saveWorkCard=async()=>({ok:false,reason:'磁盘写入失败'});
 h.g.WorkAutomationDirect={create:async(params,options)=>{await options.onBeforeCreate({title:'task'});creates++;}};
 await assert.rejects(h.cards.runAutomation({text:'每天9点处理素材'},async()=>{}),/写入失败/);assert.equal(creates,0);
});
