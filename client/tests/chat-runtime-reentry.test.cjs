'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-chat.js'), 'utf8');
function section(start, end) {
  if (start.includes('function _ensure(')) return require('./renderer-source.cjs')
    .factoryFunction('chat-session-controller.js', 'ChatSessionController', '_ensure');
  if (end.includes('function _paintOpening')) end = '  function reset()';
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}

// Execute the production navigation, handle reuse and public identity methods.
// UI mounting and the IPC open response are the external boundaries here.
function fixture(runtime = 'opencode') {
  const opened = [], reset = [];
  const ctx = {
    global: {}, document: { getElementById: () => null }, setTimeout: () => 1, clearTimeout() {},
    _ref: '', _sessionId: '', _draftKey: 'new', _busy: false, _viewEpoch: 1,
    _openingTask: null, _openingEpoch: -1, _sessionOptions: {}, _snap: null,
    _wd: {}, _mode: 'full', _sessionCaps: [], _sessionInputs: [], _activeCollabTaskId: '', _workModel: () => 'selected-model',
    _collabEntries: () => [], _mount() {}, _render() {}, _paintOpening() {},
    _pending: '', _pendingPlugins: [], _pendingAttachmentNames: [], _restoreFailedDraft() {},
    _rememberConversationDraft() {}, _clearConversationDraft() {}, _restoreConversationDraft() {},
    _restoreRetainedConversationFailure() {},
    async _ensureOnce(chatId) {
      opened.push({ id: chatId, options: { ...ctx._sessionOptions } });
      ctx._ref = 'ref-' + chatId; ctx._sessionId = chatId;
      ctx._snap = { adapterId: runtime, status: 'idle' };
      ctx._sessionOptions = { ...ctx._sessionOptions, adapterId: runtime,
        accessControl: { supported: true }, modelName: 'selected-model' };
      ctx._wd = { dir: 'D:/isolated/' + chatId, name: 'Existing workspace' };
      ctx._sessionCaps = ['files']; ctx._sessionInputs = [{ name: 'material.md' }];
      return true;
    },
    reset() {
      reset.push(ctx._sessionId); ctx._ref = ''; ctx._sessionId = ''; ctx._snap = null;
      ctx._sessionOptions = {}; ctx._viewEpoch++; ctx._busy = false;
    },
  };
  ctx.ctx = ctx;
  vm.createContext(ctx);
  vm.runInContext(section('  async function _ensure(chatId)', '  async function _ensureOnce(') +
    section('  function _fail(', '  async function refreshHistory') +
    section('  async function enter(first, chatId, options)', '  function _paintOpening()') +
    section('  function sessionInfo()', '  function hasSession()'), ctx);
  return { ctx, opened, reset };
}

test('cold remote requirement navigation restores work cards before opening its original execution', async t => {
  const fsp = require('node:fs/promises');
  const root = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'soduwork-requirement-entry-'));
  const app = {getPath: () => root};
  let actor = {hub:'http://127.0.0.1:18989', clientId:'desktop', session:
    Buffer.from(JSON.stringify({typ:'device',uid:'alice',cid:'desktop',iat:1,exp:9999999999}))
      .toString('base64url') + '.' + 'a'.repeat(64)};
  let refused = false;
  const executionContext = {location:{mode:'remote'},runner:{runnerId:'cloud-runner',host:'Isolated cloud'}};
  const requests = [], events = [];
  const cloud = require('../main/conversation/cloud-handoff').create({app,identityOf:async()=>actor,
    interval:60000, remoteDirectory:true, request:async (_identity, route, options) => {
      requests.push({route,options});
      if(refused) throw Error('remote access denied');
      if(route==='/tasks/req') return {id:'req',kind:'requirement',status:'done',title:'Requirement',
        workRouting:{executionContext}};
      if(route.includes('/ai-session?')) return {ok:true,taskId:'req',ref:'original-run',
        runnerId:'cloud-runner',engine:'pi',executionContext,status:'done',canSend:true,items:[],last:0};
      if(route.endsWith('/attachments')) return [];
      if(route.startsWith('/cloud-conversations')) return {ok:true,chats:[]};
      assert.fail(route);
    }});
  const bridge = require('../main/agent-runtime/pi-session-bridge').createPiSessionBridge({
    app,runnerAdapters:[],sessionModule:{probe:async()=>({ok:true}),history:async()=>({ok:true,chats:[]}),
      historyEntry:async()=>({ok:false,notFound:true}),open:async()=>assert.fail('must not start a local Agent')}});
  // Install the actual composite provider, which must forward exact lookups.
  const ipc = fs.readFileSync(path.join(__dirname,'../main/pi-session/ipc.js'),'utf8');
  const start = ipc.indexOf('  session.setExternalHistory?.({');
  vm.runInNewContext(ipc.slice(start,ipc.indexOf('\n  });',start)+6), {
    session:bridge,_cloudHandoff:cloud,_accountSync:{history:async()=>({ok:true,chats:[]})}});
  const cards = require('../main/conversation/work-conversation-cards').create({app,session:bridge,identityOf:async()=>actor});
  const {ctx} = fixture('pi');
  ctx.window=ctx.global;ctx.global.SoduWorkAPI={taskStorageKey:()=> 'isolated-owner'};
  ctx._api=()=>({workCards:async id=>{events.push('cards');return cards.read(id);}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../components/panels/chat-work-cards.js'),'utf8'),ctx);
  ctx._workCards=ctx.global.ChatWorkCards.create(ctx);
  const views=[];
  ctx._ensureOnce=async id=>{
    events.push('open');
    const view=await cloud.reopen(id,'remote-view-'+views.length);views.push(view);
    ctx._sessionId=id;ctx._ref=view.ref;ctx._snap=view.snapshot();
    return true;
  };
  t.after(async()=>{for(const view of views) await view.close();bridge.dispose();
    await fsp.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  assert.equal(await ctx.enter('','task-execution:req'),true,ctx._snap?.statusText);
  assert.deepEqual(events,['cards','open']);
  assert.equal(ctx._snap.cloudHandoff.ref,'original-run');
  assert.equal(ctx._snap.cloudHandoff.target.runnerId,'cloud-runner');
  assert.equal(ctx._snap.cwd || '', '');
  assert.ok(requests.every(row=>!row.options?.method || row.options.method==='GET'));
  assert.equal((await cards.read('unknown-local')).ok,false,'unknown local archives still fail closed');
  assert.equal(await bridge.findRunnerRow('task-execution:req',{nativeOnly:true}),null);
  refused=true;
  const denied=await cards.read('task-execution:req');
  assert.equal(denied.ok,false);assert.match(denied.reason,/remote access denied/);
  assert.equal(views.length,1,'metadata validation must not start a second view');
});

test('re-entering an already open conversation preserves every runtime and its fixed session resources', async () => {
  for (const runtime of ['pi', 'opencode', 'qwen', 'codex-harness', 'codex', 'claude', 'dsh']) {
    const { ctx, opened, reset } = fixture(runtime);
    assert.equal(await ctx.enter('', 'saved-chat', { taskSession: true, taskRef: 'task' }), true);
    const options = ctx._sessionOptions, workspace = ctx._wd, caps = ctx._sessionCaps, inputs = ctx._sessionInputs;
    assert.equal(ctx.sessionInfo().adapterId, runtime);
    // Compose navigation adds sidebar metadata but does not reopen the handle.
    assert.equal(await ctx.enter('', 'saved-chat', { sidebarProjectId: '' }), true);
    assert.equal(ctx.sessionInfo().adapterId, runtime);
    assert.equal(ctx._sessionOptions, options, 'navigation cannot erase the adapter/model/task contract');
    assert.equal(ctx._wd, workspace); assert.equal(ctx._sessionCaps, caps); assert.equal(ctx._sessionInputs, inputs);
    assert.equal(opened.length, 1); assert.equal(reset.length, 0);
  }
});

test('same-conversation navigation cannot relabel a live adapter or pretend to switch its model', async () => {
  const { ctx, opened } = fixture();
  await ctx.enter('', 'saved-chat');
  await ctx.enter('', 'saved-chat', { adapterId: 'pi', modelName: 'different-model', accessMode: 'full', cwd: 'D:/other' });
  assert.equal(ctx.sessionInfo().adapterId, 'opencode');
  assert.equal(ctx._sessionOptions.adapterId, 'opencode');
  assert.equal(ctx._sessionOptions.modelName, 'selected-model');
  assert.equal(ctx._sessionOptions.accessMode, undefined);
  assert.equal(ctx._wd.dir, 'D:/isolated/saved-chat');
  assert.equal(opened.length, 1);
  ctx._sessionOptions.adapterId = 'pi';
  assert.equal(ctx.sessionInfo().adapterId, 'opencode', 'the active runtime snapshot remains authoritative');
});

test('re-entering the same work-only conversation preserves its choices for the first ordinary send', async () => {
  const { ctx, opened, reset } = fixture('qwen');
  ctx.window = ctx.global;
  ctx.global.SoduWorkAPI = { taskStorageKey: () => 'isolated-work-owner' };
  ctx._api = () => ({ workCards: async () => ({ ok: true, workOnly: true, cards: [] }),
    saveWorkDraftSelection: async (_id, {selection, revision}) => ({ok:true, draftSelection:selection, draftSelectionRevision:revision+1}) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-work-cards.js'), 'utf8'), ctx);
  ctx._workCards = ctx.global.ChatWorkCards.create(ctx);
  ctx._sessionId = 'work-chat'; ctx._draftKey = 'work-chat';
  ctx._snap = { status: 'idle', messages: [], tools: [], workOnly: true };
  const choices = ctx._sessionOptions = { adapterId: 'qwen', modelName: 'chosen-model', modelLabel: 'Chosen model',
    reasoningEffort: 'high', thinkingLevel: 'medium', accessMode: 'full',
    accessDraftId: 'original-draft', accessConsentId: 'original-consent', cwd: 'D:/isolated/work-chat' };
  ctx._model = { id: choices.modelName, label: choices.modelLabel };
  const workspace = ctx._wd = { dir: choices.cwd, name: 'Selected workspace' };
  const caps = ctx._sessionCaps = ['files'], inputs = ctx._sessionInputs = [{ name: 'retained.md' }];
  const navigation = { sidebarProjectId: '', adapterId: 'pi', modelName: 'navigation-model',
    reasoningEffort: '', thinkingLevel: 'off', accessMode: 'standard', cwd: 'D:/other' };
  assert.equal(await ctx.enter('', 'work-chat', navigation), true);
  assert.equal(ctx._sessionOptions, choices, 'navigation must retain the work-only execution choices');
  assert.equal(ctx._wd, workspace); assert.equal(ctx._sessionCaps, caps); assert.equal(ctx._sessionInputs, inputs);
  assert.equal(ctx._snap.workOnly, true); assert.equal(ctx._snap.modelSelection.name, 'chosen-model');
  assert.equal(opened.length, 0, 'restoring a form must not open an Agent'); assert.equal(reset.length, 0);
  assert.equal(await ctx._ensure(), true);
  assert.deepEqual(opened, [{ id: 'work-chat', options: choices }]);
});

test('a work-only view reconnects to the authoritative runtime started by another window', async () => {
  const {ctx,opened}=fixture('pi');let started=false;
  ctx.window=ctx.global;ctx.global.SoduWorkAPI={taskStorageKey:()=> 'isolated-owner'};
  const selection={adapterId:'qwen',modelName:'draft-model',modelLabel:'Draft',reasoningEffort:'high',thinkingLevel:'medium'};
  ctx._api=()=>({workCards:async()=>({ok:true,workOnly:!started,cards:[],
    draftSelection:started?null:selection,draftSelectionRevision:started?0:1}),
    saveWorkDraftSelection:async()=>({ok:false,code:'WORK_CONVERSATION_STARTED',reason:'already running elsewhere'})});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../components/panels/chat-work-cards.js'),'utf8'),ctx);
  ctx._workCards=ctx.global.ChatWorkCards.create(ctx);
  assert.equal(await ctx.enter('','shared-work'),true);assert.equal(opened.length,0);
  ctx._sessionOptions.modelName='local-unsaved';started=true;
  assert.equal(await ctx._workCards.ensureDraftSelectionSaved(),false);
  assert.equal(await ctx.enter('','shared-work'),true);
  assert.equal(opened.length,1);assert.equal(opened[0].id,'shared-work');
  for (const key of Object.keys(selection)) assert.equal(opened[0].options[key],undefined,
    'pending draft selections cannot override the runtime that has already started');
  assert.equal(ctx._ref,'ref-shared-work');assert.equal(ctx._snap.workOnly,undefined);
});

test('returning to a work-only archive restores pending requirements without starting an Agent', async () => {
  const {ctx, opened} = fixture(); const restored = [];
  ctx._workCards = {restore:async id => {
    ctx._sessionId = id; ctx._snap = {workOnly:true, status:'idle', messages:[]};
    return {ok:true, workOnly:true, cards:[]};
  }};
  ctx._restoreCollaboration = id => restored.push(id);
  assert.equal(await ctx.enter('', 'pending-work'), true);
  assert.deepEqual(restored, ['pending-work']);
  assert.equal(opened.length, 0, '恢复待办不初始化或发送执行');
});

test('the default work-only model remains usable when the model picker has no concrete model yet', () => {
  const ctx = {_snap:{workOnly:true, modelSelection:{name:'', model:null}}, _sessionOptions:{modelName:''}};
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-work-intent.js'), 'utf8'), {window});
  const intent = window.ChatWorkIntent.create(ctx);
  assert.equal(intent._workModel(), '');
  ctx._snap.modelSelection = {name:'', model:{id:'resolved-default'}};
  assert.equal(intent._workModel(), 'resolved-default');
});

test('opening a different archive resets the old runtime context and uses its new open response', async () => {
  const { ctx, opened, reset } = fixture('qwen');
  await ctx.enter('', 'first', { taskRef: 'first-task', cwd: 'D:/old' });
  await ctx.enter('', 'second', { taskRef: 'second-task' });
  assert.deepEqual(reset, ['first']); assert.equal(opened.length, 2);
  assert.deepEqual(opened[1], { id: 'second', options: { taskRef: 'second-task' } });
  assert.equal(ctx.sessionInfo().adapterId, 'qwen');
  assert.equal(ctx._wd.dir, 'D:/isolated/second');
});

test('空白页面连续点开历史时，迟到的首次卡片读取不能启动旧会话', async () => {
  const {ctx, opened, reset} = fixture(); let finishOld;
  ctx._workCards = {restore: id => id === 'old' ? new Promise(resolve => {finishOld=resolve;}) : Promise.resolve(null)};
  const old = ctx.enter('', 'old');
  assert.equal(await ctx.enter('', 'new'), true);
  finishOld(null); assert.equal(await old, false);
  assert.deepEqual(opened.map(row=>row.id), ['new']); assert.equal(reset.length,0);
  assert.equal(ctx._sessionId,'new');
});

test('卡片存档读取失败时保留错误边界，不把空表单会话当成普通执行启动', async () => {
  const {ctx,opened}=fixture();ctx._workCards={restore:async()=>({blocked:true})};
  assert.equal(await ctx.enter('','broken'),false);assert.equal(opened.length,0);
  assert.equal(ctx._snap?.status, 'unreachable');
  assert.equal(ctx._snap?.openBlocked, true);
  assert.match(ctx._snap?.statusText, /工作卡片.*重新打开/);
});

test('归属拦截以持久错误替换加载动画和缓存正文，重新打开通过后恢复同一会话', async () => {
  const {ctx, opened} = fixture(); const states = [];
  const reason = '这条会话属于另一个账号或服务，请切回原账号';
  ctx._render = () => states.push(ctx._snap?.status);
  ctx._paintOpening = () => states.push('opening');
  ctx._cachedConversationSnapshot = () => ({status:'idle', messages:[{role:'assistant', text:'cached transcript'}]});
  ctx._workCards = {restore: async () => ({blocked:true, reason})};
  assert.equal(await ctx.enter('', 'protected-chat'), false);
  assert.equal(states.at(-1), 'unreachable');
  assert.equal(ctx._snap.openBlocked, true);
  assert.equal(ctx._snap.messages.length, 0, 'refused archives must not retain cached transcript content');
  assert.match(ctx._snap.statusText, /请切回原账号/);
  assert.equal(opened.length, 0);
  ctx._workCards.restore = async () => null;
  assert.equal(await ctx.enter('', 'protected-chat'), true);
  assert.equal(opened[0].id, 'protected-chat');
  assert.equal(ctx._snap.openBlocked, undefined);
});

test('工作卡片 IPC 异常也结束打开状态，不调用 native open', async () => {
  const {ctx, opened} = fixture();
  ctx._workCards = {restore: async () => { throw Error('工作卡片连接中断'); }};
  assert.equal(await ctx.enter('', 'disconnected-chat'), false);
  assert.equal(ctx._snap?.status, 'unreachable');
  assert.match(ctx._snap?.statusText, /连接中断/);
  assert.equal(ctx._snap?.openBlocked, true);
  assert.equal(opened.length, 0);
});

test('已打开会话重新读取被拒绝时释放旧句柄，成功重开仍核对同一 chatId', async () => {
  const {ctx, opened, reset} = fixture();
  await ctx.enter('', 'protected-chat');
  ctx._workCards = {restore: async () => ({blocked:true, reason:'登录已失效，请重新登录'})};
  assert.equal(await ctx.enter('', 'protected-chat'), false);
  assert.equal(ctx._ref, '');
  assert.deepEqual(reset, ['protected-chat']);
  assert.equal(ctx._draftKey, 'protected-chat');
  ctx._workCards.restore = async () => null;
  assert.equal(await ctx.enter('', 'protected-chat'), true);
  assert.deepEqual(opened.map(row => row.id), ['protected-chat', 'protected-chat']);
  assert.equal(ctx._snap.openBlocked, undefined);
});

test('切换会话后迟到的工作卡片拒绝或异常不能覆盖当前流式回复', async () => {
  for (const rejected of [false, true]) {
    const {ctx, opened} = fixture(); let resolve, reject;
    ctx._workCards = {restore: id => id === 'old' ? new Promise((yes, no) => {resolve=yes; reject=no;}) : Promise.resolve(null)};
    const old = ctx.enter('', 'old');
    assert.equal(await ctx.enter('', 'current'), true);
    const snapshot = ctx._snap = {status:'streaming', messages:[{role:'assistant', text:'current reply'}]};
    if (rejected) reject(Error('old failure'));
    else resolve({blocked:true, reason:'old owner'});
    assert.equal(await old, false);
    assert.equal(ctx._snap, snapshot);
    assert.deepEqual(opened.map(row => row.id), ['current']);
  }
});

test('an input preview waiting for session readiness cannot open in a subsequently selected conversation', async () => {
  const { ctx } = fixture(); let ready;
  const previews = [];
  ctx.global.ChatWorkbench = { openInput: file => previews.push(file) };
  // The native open finishes before navigation, but the renderer continuation
  // is still pending. The outer entry operation must check its own lifetime.
  ctx._ensure = () => new Promise(resolve => { ready = resolve; });
  const entering = ctx.enter('', 'file-session', { previewInput: { path: 'C:/old/private.md' } });
  for (let n = 0; n < 10 && !ready; n++) await Promise.resolve();
  assert.equal(typeof ready, 'function');
  ctx.reset(); ctx._sessionId = 'selected-session'; ctx._ref = 'selected-ref';
  ready(true);
  assert.equal(await entering, false);
  assert.deepEqual(previews, []);
  assert.equal(ctx._sessionId, 'selected-session');
});
