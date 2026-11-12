'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/chat-task-controller.js'), 'utf8');
const controlled = require('../main/pi-session/controlled-task-turn');

function fixture(task, settings = {}) {
  const opened = [], sent = [], removed = [], notices = [], bound = [];
  const store = { findByTask: () => settings.mapped ? { conversationId: settings.mapped } : null,
    findByProject: () => null, isQueueRemoved: () => false, upsertTask() {},
    removeTask: (...args) => removed.push(args), setQueueRemoved: () => true };
  const window = { SoduWorkAPI: { getTask: async () => task }, ChatCollaborationStore: store, petSay: text => notices.push(text) };
  window.RequirementSessionContext = require('../core/requirement-session-context');
  vm.runInNewContext(source, { window, SoduWorkAPI: window.SoduWorkAPI, ChatCollaborationStore: store,
    petSay: window.petSay, document: { getElementById: () => null }, setTimeout: () => 1 });
  const ctx = { _collabTasks: new Map(), _collabStarts: new Set(), _collabPicker: {},
    _sessionId: '', _ref: '', _viewEpoch: 1, _taskOpenSeq: 0, _sessionOptions: {},
    _snap: null, _collabPollTimer: 1, _render() {}, refreshHistory() {},
    _workModel: () => ctx.actualModel || '',
    sessionInfo: () => ({ adapterId: ctx._sessionOptions.adapterId || 'pi', projectId: ctx._sessionOptions.projectId || '' }),
    _api: () => ({ bindTask: async (...args) => { bound.push(args); return { ok: true }; } }),
    _send: async (text, options) => { sent.push({ text, options }); return true; },
    reset() { ctx._ref = ''; ctx._sessionId = ''; ctx._snap = null; ctx._sessionOptions = {}; ctx._collabTasks.clear(); },
    async _ensure(id) {
      if (ctx._ref) return true;
      opened.push({ id: id || '', options: { ...ctx._sessionOptions } });
      if (id && settings.missing !== undefined) {
        ctx._snap = { status: 'error', statusText: 'archive unavailable', sessionNotFound: settings.missing };
        return false;
      }
      ctx._ref = 'native-ref'; ctx._sessionId = 'native-conversation';
      ctx._snap = { status: 'idle', messages: [] };
      ctx.actualModel = settings.actualModel || ctx._sessionOptions.modelName || 'default-model';
      if (settings.actualAdapter) ctx._sessionOptions.adapterId = settings.actualAdapter;
      return true;
    },
  };
  const api = window.ChatTaskController.create(ctx);
  return { ctx, api, opened, sent, removed, notices, bound, window };
}

// Keep the real renderer fallback from _ensure('') to _sessionId. The basic
// fixture above stops at _ensure and cannot detect accidental archive reuse.
function nativeOpeningFixture(task, settings = {}) {
  const f = fixture(task, settings), nativeOpens = [];
  f.window.ChatCollaborationStore.get = () => null;
  f.window.ChatCollaborationStore.setActive = () => {};
  f.ctx.OPEN_TIMEOUT_MS = 1000;
  f.ctx._api = () => ({ open: async options => {
    nativeOpens.push({ ...options });
    // This test checks the native opening boundary; it starts no real runtime.
    return settings.open ? settings.open(options, nativeOpens.length) :
      { ok: false, reason: 'Isolated test stopped at native open' };
  }, bindTask: async (...args) => { f.bound.push(args); return {ok: true}; }, onEvent: () => () => {} });
  f.ctx._fail = (title, reason) => {
    f.ctx._taskOpenPending = false;
    f.ctx._snap = {...f.ctx._snap, status: 'unreachable', statusText: title + ': ' + (reason || '')};
  };
  Object.assign(f.ctx, { _isEmptyStalledSnapshot: f.api._isEmptyStalledSnapshot,
    _bindCollaborationTask: f.api._bindCollaborationTask, _selectCollabTask: f.api._selectCollabTask,
    _restoreCollaboration: f.api._restoreCollaboration, _rememberConversationSnapshot() {}, _paintBar() {}, _pullOuts() {},
    _workModel: () => f.ctx._model?.id || f.ctx._sessionOptions.modelName || '' });
  const reset = f.ctx.reset;
  f.ctx.reset = () => {
    reset(); f.ctx._viewEpoch++; f.ctx._model = null; f.ctx._openingTask = null; f.ctx._openingEpoch = -1;
    f.ctx._taskOpenPending = false; f.ctx._taskOpenError = ''; f.ctx._boundFromServer = false;
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-session-controller.js'), 'utf8'),
    { window: f.window, ChatCollaborationStore: f.window.ChatCollaborationStore, setTimeout, clearTimeout });
  f.ctx._ensure = f.window.ChatSessionController.create(f.ctx)._ensure;
  f.window.NativeChat = f.api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/requirements/requirement-session-choice.js'), 'utf8'),
    { window: f.window });
  return { ...f, nativeOpens };
}

function openedNative(options) {
  return {ok: true, ref: 'fresh-native-ref', sessionId: 'fresh-native-conversation', adapterId: options.adapterId,
    model: {id: options.modelName || 'default-model'}, snapshot: {status: 'idle', messages: []},
    taskBindings: options.taskRef ? [{taskId: options.taskRef}] : []};
}

test('same-person dispatch prefers the original conversation and preserves controlled execution choices', async () => {
  const task = {id:'same-owner', title:'Delivery', status:'todo', createdBy:'u', assigneeUserId:'u',
    workRouting:{selectedStrategy:'direct', selectedAgentId:'pi', executionContext:{strategy:'direct', agent:{id:'pi'}, runner:{mode:'local'}}}};
  const f = fixture(task);
  f.window.TaskConversationNavigation = {preferredConversation: async () => 'creation-chat'};
  assert.equal((await f.api.enqueueTask(task.id, {source:'task-dispatch'})).ok, true);
  assert.equal(f.opened[0].id, 'creation-chat');
  assert.equal(f.sent.length, 1);
  assert.notEqual(f.sent[0].options.reuseConversation, true);
});

test('a preferred original archive opens as an ordinary chat and binds before dispatch when it has no prior execution', async () => {
  const task = {id:'created-here',title:'Existing conversation',status:'todo'};
  const f = nativeOpeningFixture(task, {open: options => ({...openedNative(options), sessionId:options.chatId})});
  assert.equal(await f.api._openTask(task.id, task.title, {task,source:'task-dispatch',
    chatId:'original-with-messages',preferredConversation:true}), true);
  assert.equal(f.nativeOpens.length, 1);
  assert.equal(f.nativeOpens[0].chatId, 'original-with-messages');
  assert.equal(f.nativeOpens[0].requireTaskBinding, false);
  assert.equal(f.bound.length, 1);
  assert.equal(f.bound[0][1], task.id);
  assert.equal(f.ctx._sessionId, 'original-with-messages');
});

for (const mode of ['manual', 'auto']) for (const missing of [true, false]) {
  test(`review ${mode} creates a replacement only after authoritative absence (${missing})`, async () => {
    const task = {id:'review', status:'reviewing', workRouting:{conversationTurn:{conversationId:'original'}}};
    const f = fixture(task, {missing});
    f.ctx._mount = () => null;
    const ok = await f.api._openTask(task.id, 'Review', {task, chatId:'original', source:'acceptance',
      acceptanceExecutionSession:true, acceptanceMode:mode, approvalId:'approval'});
    assert.equal(ok, missing);
    assert.equal(f.opened.length, missing ? 2 : 1);
    if (missing) {
      assert.equal(f.opened[1].id, '');
      assert.equal(f.opened[1].options.acceptanceSession, true);
      assert.equal(f.ctx._sessionOptions.acceptanceExecutionSession, false);
      assert.equal(f.ctx._sessionOptions.approvalId, 'approval');
    }
    assert.equal(f.sent.length, 0);
  });
}

test('adding an existing task opens the work-only archive normally then validates its binding', async () => {
  for (const bindOk of [true, false]) {
    const task = {id: 'existing', title: 'Existing task', status: 'todo', triageStage: 'ready'};
    const f = nativeOpeningFixture(task, {open: async options => ({...openedNative(options), sessionId: options.chatId})});
    let selections = 0, receiptChecks = 0;
    Object.assign(f.ctx, {_sessionId: 'draft', _snap: {workOnly: true, messages: []},
      _sessionOptions: {adapterId: 'pi', modelName: 'chosen'},
      _workCards: {ensureDraftSelectionSaved: async () => { selections++; return true; },
        hasCreatedTask: () => false,
        flush: async options => { receiptChecks++; assert.equal(options.taskId, undefined); return {ok: true}; }}});
    const native = f.ctx._api();
    f.ctx._api = () => ({...native, bindTask: async (...args) => {
      f.bound.push(args); return {ok: bindOk, reason: 'Hub rejected task binding'};
    }});
    assert.equal(await f.api._openTask(task.id, task.title, {source: 'task-add', reuseCurrent: true}), bindOk);
    assert.equal(selections, 1);
    assert.equal(receiptChecks, 1, 'save the draft without requiring a creation receipt');
    assert.equal(f.nativeOpens.length, 1);
    assert.equal(f.nativeOpens[0].chatId, 'draft');
    assert.equal(f.nativeOpens[0].taskRef || '', '');
    assert.equal(f.nativeOpens[0].requireTaskBinding, false);
    assert.equal(f.nativeOpens[0].modelName, 'chosen');
    assert.equal(f.bound.length, 1, 'existing tasks must still pass the native binding gate');
    assert.equal(f.ctx._collabTasks.has(task.id), bindOk);
    assert.equal(f.sent.length, 0);
  }
});

test('adding an existing task stops on selection save failure or navigation during first open', async () => {
  for (const failure of ['selection', 'navigation']) {
    const task = {id: 'existing', status: 'todo'};
    const f = nativeOpeningFixture(task, {open: async options => {
      f.ctx._viewEpoch++;
      return {...openedNative(options), sessionId: options.chatId};
    }});
    Object.assign(f.ctx, {_sessionId: 'draft', _snap: {workOnly: true, messages: []},
      _sessionOptions: {adapterId: 'pi'},
      _workCards: {hasCreatedTask: () => false, flush: async () => ({ok: true}),
        ensureDraftSelectionSaved: async () => failure !== 'selection'}});
    assert.equal(await f.api._openTask(task.id, '', {source: 'task-add', reuseCurrent: true}), false);
    assert.equal(f.nativeOpens.length, failure === 'selection' ? 0 : 1);
    assert.equal(f.bound.length, 0);
    assert.equal(f.sent.length, 0);
  }
});

function existingTaskDraft(settings = {}) {
  const task = {id:'existing', title:'Already saved', status:'todo', triageStage:'ready'};
  const f = nativeOpeningFixture(task, {open: options => ({...openedNative(options), sessionId:options.chatId})});
  const saved = [];
  let owner = 'account-a';
  f.window.SoduWorkAPI.taskStorageKey = () => owner;
  Object.assign(f.ctx, {_sessionId:'work-draft', _snap:{status:'idle', workOnly:true},
    _sessionOptions:{adapterId:'pi', modelName:'', reasoningEffort:''}});
  f.ctx._workCards = {
    hasCreatedTask: () => settings.created === true,
    ensureDraftSelectionSaved: async () => true,
    flush: async options => {
      saved.push({...options});
      if (settings.flush) return settings.flush(options, f);
      return options.taskId && !settings.created ? {ok:false,reason:'No creation receipt'} : {ok:true};
    },
  };
  return {...f, task, saved, owner:value=>{owner=value;}};
}

test('adding an existing task to a work-only draft opens the same ordinary archive then binds', async () => {
  const f = existingTaskDraft();
  assert.equal(await f.api._openTask(f.task.id, f.task.title, {task:f.task,source:'task-add',reuseCurrent:true}), true);
  assert.deepEqual(f.saved, [{sessionId:'work-draft'}]);
  assert.equal(f.nativeOpens.length, 1);
  assert.equal(f.nativeOpens[0].chatId, 'work-draft');
  assert.equal(f.nativeOpens[0].modelName, '');
  assert.equal(f.nativeOpens[0].taskRef || '', '');
  assert.equal(f.nativeOpens[0].requireTaskBinding, false);
  assert.equal(f.bound.length, 1);
  assert.equal(f.bound[0][1], f.task.id);
  assert.equal(f.ctx._sessionOptions.taskRef, f.task.id);
  assert.equal(f.ctx._sessionId, 'work-draft');
});

test('a created task keeps receipt persistence and strict native binding validation even from the plus picker', async () => {
  const f = existingTaskDraft({created:true});
  assert.equal(await f.api._openTask(f.task.id, f.task.title, {task:f.task,source:'task-add',reuseCurrent:true}), true);
  assert.deepEqual(f.saved, [{sessionId:'work-draft',taskId:f.task.id}]);
  assert.equal(f.nativeOpens[0].taskRef, f.task.id);
  assert.equal(f.nativeOpens[0].requireTaskBinding, true);
});

test('failed draft persistence blocks ordinary opening and binding for an existing task', async () => {
  const f = existingTaskDraft({flush:async()=>({ok:false,reason:'disk unavailable'})});
  assert.equal(await f.api._openTask(f.task.id, f.task.title, {task:f.task,source:'task-add'}), false);
  assert.equal(f.nativeOpens.length, 0); assert.equal(f.bound.length, 0);
  assert.match(f.ctx._taskOpenError, /disk unavailable/);
  assert.equal(f.ctx._taskOpenPending, false);
});

for (const change of ['session','account']) test('pending existing-task draft save cannot open after a ' + change + ' change', async () => {
  const f = existingTaskDraft({flush:async(_options, h)=>{
    if (change === 'session') h.ctx._sessionId='other-draft';
    else h.window.SoduWorkAPI.taskStorageKey = () => 'account-b';
    return {ok:true};
  }});
  assert.equal(await f.api._openTask(f.task.id, f.task.title, {task:f.task,source:'task-add'}), false);
  assert.equal(f.nativeOpens.length,0); assert.equal(f.bound.length,0);
});

for (const patch of [{source:'task-open'},{source:'task-add',navigation:true},{source:'task-add',acceptanceSession:true},
  {source:'task-add',reworkSession:true},{source:'task-add',chatId:'another-archive'}]) {
  test('existing-task draft shortcut is excluded from ' + JSON.stringify(patch), async () => {
    const f=existingTaskDraft();
    assert.equal(await f.api._openTask(f.task.id,f.task.title,{task:f.task,...patch}),false);
    assert.equal(f.bound.length,0);
    assert.equal(f.saved[0]?.taskId,f.task.id);
  });
}

test('a receipt completed during draft persistence still takes the strict receipt path', async () => {
  const f=existingTaskDraft({flush:async(_options,h)=>{
    h.ctx._workCards.hasCreatedTask=()=>true;
    return {ok:true};
  }});
  assert.equal(await f.api._openTask(f.task.id,f.task.title,{task:f.task,source:'task-add'}),true);
  assert.deepEqual(f.saved,[{sessionId:'work-draft'},{sessionId:'work-draft',taskId:f.task.id}]);
  assert.equal(f.nativeOpens[0].requireTaskBinding,true);
});

test('failed existing-task binding never submits the requirement after opening its draft', async () => {
  const f=existingTaskDraft(), native=f.ctx._api();
  f.ctx._api=()=>({...native,bindTask:async()=>({ok:false,reason:'binding rejected'})});
  const result=await f.api.enqueueTask(f.task.id,{source:'task-add',reuseCurrent:true});
  assert.equal(result.ok,false);
  assert.equal(f.nativeOpens.length,1); assert.equal(f.sent.length,0);
  assert.match(f.ctx._taskOpenError,/binding rejected/);
});

test('saved canonical Agent and model reach each native substrate through the actual enqueue controller', async () => {
  for (const cli of [...new Set([...require('../main/agent-runtime/runtime-catalog').runtimes().map(row => row.id), 'claude'])]) {
    const model = cli === 'claude' ? '' : cli === 'codex' ? 'gpt-5.3-codex' : 'company-selected';
    const task = { id: cli, title: 'Saved task', status: 'todo', executionContext: {
      agent: { id: 'local:' + cli, cli }, model, runner: { mode: 'local' }, strategy: 'direct' } };
    const f = fixture(task);
    assert.equal((await f.api.enqueueTask(cli)).ok, true, cli);
    assert.equal(f.opened[0].options.adapterId, cli);
    assert.equal(f.opened[0].options.modelName, model);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].options.taskExecution.agentId, 'local:' + cli);
    assert.equal(f.sent[0].options.taskExecution.model, model);
    assert.equal(controlled.executionSpec(task, f.sent[0].options.taskExecution).mode, 'native');
  }
});

test('saved remote substrate retains machine, model, repository and reasoning on controlled HTTP dispatch', async () => {
  for (const cli of [...new Set([...require('../main/agent-runtime/runtime-catalog').runtimes().map(row => row.id), 'claude'])]) {
    const id = 'runner:machine-1:' + cli;
    const task = { id: cli, title: 'Remote task', status: 'todo', executionContext: {
      agent: { id, cli }, model: cli === 'claude' ? '' : 'selected-model', reasoningEffort: cli === 'codex' ? 'high' : '',
      repo: { id: 'repository', branch: 'feature-task' }, runner: { mode: 'remote', id: 'machine-1' } } };
    const f = fixture(task);
    assert.equal((await f.api.enqueueTask(cli)).ok, true, cli);
    const spec = controlled.executionSpec(task, f.sent[0].options.taskExecution);
    assert.equal(spec.mode, 'dispatch'); assert.equal(spec.agentId, id);
    let dispatched;
    const turn = controlled.create({ task, spec, scope: { conversationId: 'c', turnId: 't' }, request: async (route, body) => {
      if (route.endsWith('/ai-dispatch')) { dispatched = body; return { ref: 'run' }; }
      return { ref: 'run', status: 'done', items: [] };
    } });
    await turn.execute({ appendTaskMessage() {}, taskExecutionChanged() {} }, 'full task material', []);
    assert.equal(dispatched.assigneeId, id);
    assert.equal(dispatched.model, task.executionContext.model);
    assert.equal(dispatched.repo.id, 'repository'); assert.equal(dispatched.repo.branch, 'feature-task');
    assert.equal(dispatched.reasoningEffort, task.executionContext.reasoningEffort);
    assert.equal(dispatched.executionContext.runner.id, 'machine-1');
  }
});

test('an explicit default model overrides a stale saved choice in native and controlled execution', async () => {
  const task = { id: 't', title: 'Default', status: 'todo', executionContext: { agent: { id: 'local:pi' }, model: 'removed-model' } };
  const f = fixture(task);
  assert.equal((await f.api.enqueueTask('t', { model: '' })).ok, true);
  assert.equal(f.opened[0].options.modelName, '');
  assert.equal(controlled.executionSpec(task, { model: '' }).model, '');
});

test('existing native conversations reject saved model and substrate mismatches before submission', async () => {
  for (const mismatch of ['model', 'runtime']) {
    const task = { id: 't', title: 'Saved', status: 'todo', executionContext: { agent: { id: 'local:opencode' }, model: 'selected-model' } };
    const f = fixture(task);
    Object.assign(f.ctx, { _ref: 'existing', actualModel: mismatch === 'model' ? 'wrong-model' : 'selected-model',
      _sessionOptions: { adapterId: mismatch === 'runtime' ? 'pi' : 'opencode' } });
    assert.equal((await f.api.enqueueTask('t')).ok, false);
    assert.equal(f.sent.length, 0); assert.equal(f.opened.length, 0);
  }
});

test('a resumed archive cannot silently execute on a different model or substrate', async () => {
  for (const settings of [{ actualModel: 'wrong-model' }, { actualAdapter: 'pi' }]) {
    const task = { id: 't', title: 'Saved', status: 'todo', executionContext: { agent: { id: 'local:opencode' }, model: 'selected-model' } };
    const f = fixture(task, { ...settings, mapped: 'archive' });
    const result = await f.api.enqueueTask('t');
    assert.equal(result.ok, false); assert.equal(f.sent.length, 0);
    assert.match(result.reason, /不同/);
  }
});

test('task-detail dispatch opens the chosen runtime independently of an unrelated Pi conversation', async () => {
  for (const mapped of ['', 'task-archive']) {
    const task = { id: 'new-task', title: 'Independent', status: 'todo', projectId: 'shared',
      executionContext: { agent: { id: 'local:opencode' }, model: 'selected-model' } };
    const f = fixture(task, { mapped });
    Object.assign(f.ctx, { _ref: 'old-ref', _sessionId: 'old-pi', actualModel: 'pi-model',
      _collaborationTaskId: 'other-task', _snap: { status: 'idle', messages: [{ role: 'assistant' }] },
      _sessionOptions: { adapterId: 'pi', projectId: 'shared', cwd: 'D:/prior-chat' } });
    f.ctx._collabTasks.set('other-task', { taskId: 'other-task', queueState: 'completed', nativeTurn: true });
    const result = await f.api.enqueueTask(task.id, { source: 'task-dispatch' });
    assert.equal(result.ok, true, result.reason);
    assert.equal(f.opened.length, 1); assert.equal(f.opened[0].id, '');
    assert.equal(f.opened[0].options.adapterId, 'opencode');
    assert.equal(f.opened[0].options.cwd, undefined); assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].options.taskExecution.agentId, 'local:opencode');
  }
});

test('首次派发待开始需求即使残留本地映射也必须新建会话', async () => {
  const task = { id: 'first-task', title: 'First execution', status: 'todo',
    executionContext: { agent: { id: 'local:pi' }, model: '' } };
  const f = fixture(task, { mapped: 'stale-task-archive' });
  const result = await f.api.enqueueTask(task.id, { source: 'task-dispatch', agentId: 'local:pi' });
  assert.equal(result.ok, true, result.reason);
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0].id, '', 'first execution must not resume a stale task mapping');
});

test('task-detail dispatch keeps a bound conversation and rejects changing its runtime without resubmission', async () => {
  const task = { id: 't', title: 'Bound', status: 'todo', executionContext: {
    agent: { id: 'local:opencode' }, model: 'selected-model' },
    workRouting: { conversationTurn: { conversationId: 'bound-pi' } } };
  const f = fixture(task, { actualAdapter: 'pi' });
  assert.equal((await f.api.enqueueTask('t', { source: 'task-dispatch' })).ok, false);
  assert.equal(f.opened[0].id, 'bound-pi'); assert.equal(f.sent.length, 0);
  assert.equal(f.removed.length, 0);
});

test('another task bound to the current conversation cannot relabel its running native handle', async () => {
  const task = { id: 't', title: 'Shared bound', status: 'todo', executionContext: {
    agent: { id: 'local:opencode' }, model: 'shared-model' },
    workRouting: { conversationTurn: { conversationId: 'shared-chat' } } };
  const f = fixture(task);
  Object.assign(f.ctx, { _ref: 'existing-pi', _sessionId: 'shared-chat', _collaborationTaskId: 'other-task',
    actualModel: 'shared-model', _snap: { status: 'idle', messages: [] }, _sessionOptions: { adapterId: 'pi' } });
  assert.equal((await f.api.enqueueTask('t', { source: 'task-dispatch' })).ok, false);
  assert.equal(f.ctx._sessionOptions.adapterId, 'pi'); assert.equal(f.opened.length, 0);
  assert.equal(f.sent.length, 0);
});

test('ordinary task-history navigation does not inject the previously viewed conversation model', async () => {
  const task = { id: 't', title: 'History', status: 'doing' };
  const f = fixture(task, { mapped: 'history' });
  Object.assign(f.ctx, { _ref: 'old-ref', _sessionId: 'other', _snap: { status: 'idle', messages: [] },
    _sessionOptions: { adapterId: 'pi', modelName: 'unrelated-model', reasoningEffort: 'high' } });
  assert.equal(await f.api._openTask('t', task.title, { task, navigation: true, source: 'task-detail' }), true);
  assert.equal(f.opened[0].id, 'history');
  assert.equal(f.opened[0].options.modelName, undefined);
  assert.equal(f.opened[0].options.reasoningEffort, undefined);
  assert.equal(f.sent.length, 0);
});

test('permission-only task handoff restores archive model choices and preserves an explicitly selected empty default', async () => {
  for (const selection of [{ accessMode: 'full' }, { accessMode: 'readonly', modelName: '', reasoningEffort: '' }]) {
    const task = { id: 't', title: 'Archived task', status: 'todo' };
    const f = fixture(task, { mapped: 'history' });
    Object.assign(f.ctx, { _ref: 'old-ref', _sessionId: 'old-chat', _snap: { status: 'idle', messages: [] },
      _sessionOptions: { adapterId: 'pi', modelName: 'unrelated-model', reasoningEffort: 'high' } });
    assert.equal(await f.api._openTask('t', task.title, { task, navigation: true, source: 'task-create', sessionOptions: selection }), true);
    assert.equal(f.opened[0].id, 'history');
    assert.equal(f.opened[0].options.modelName, selection.modelName);
    assert.equal(f.opened[0].options.reasoningEffort, selection.reasoningEffort);
  }
});

test('opening another project preserves explicit Agent/model across reset without inheriting the prior cwd', async () => {
  const task = { id: 't', title: 'Project B', status: 'todo', projectId: 'b', executionContext: { agent: { id: 'local:qwen' }, model: 'selected-model' } };
  const f = fixture(task);
  Object.assign(f.ctx, { _ref: 'old-ref', _sessionId: 'old-chat', actualModel: 'selected-model', _snap: { status: 'idle', messages: [] },
    _sessionOptions: { adapterId: 'qwen', modelName: 'selected-model', projectId: 'a', cwd: 'D:/old-project' } });
  assert.equal((await f.api.enqueueTask('t')).ok, true);
  assert.equal(f.opened[0].options.adapterId, 'qwen'); assert.equal(f.opened[0].options.modelName, 'selected-model');
  assert.equal(f.opened[0].options.projectId, 'b'); assert.equal(f.opened[0].options.cwd, undefined);
});

test('explicit dispatch recovers only a missing local empty draft and keeps the selected runtime/model', async () => {
  const task = { id: 't', title: 'Pending', status: 'todo', executionContext: { agent: { id: 'local:opencode' }, model: 'selected-model' } };
  const f = fixture(task, { mapped: 'missing-draft', missing: true });
  assert.equal((await f.api.enqueueTask('t')).ok, true);
  assert.deepEqual(f.opened.map(item => item.id), ['missing-draft', '']);
  for (const attempt of f.opened) { assert.equal(attempt.options.adapterId, 'opencode'); assert.equal(attempt.options.modelName, 'selected-model'); }
  assert.deepEqual(f.removed, [['missing-draft', 't']]); assert.equal(f.sent.length, 1);
});

test('执行者显式新建对话时不被未开始的旧绑定带回，且仍核对最新任务状态', async () => {
  const task = {id:'t', title:'Ready', status:'todo'};
  const f = fixture(task, {mapped:'released-draft'});
  Object.assign(f.ctx, {_ref:'old-ref',_sessionId:'released-draft',_collaborationTaskId:'t',
    _sessionOptions:{adapterId:'qwen'},_snap:{status:'idle',messages:[]}});
  assert.equal((await f.api.enqueueTask('t',{source:'task-dispatch',forceNew:true,agentId:'local:pi'})).ok,true);
  assert.equal(f.opened.length,1); assert.equal(f.opened[0].id,'');
  assert.equal(f.opened[0].options.adapterId,'pi'); assert.equal(f.sent.length,1);
  const active=fixture({...task,status:'doing',workRouting:{conversationTurn:{state:'running',conversationId:'busy'}}});
  assert.equal((await active.api.enqueueTask('t',{forceNew:true,agentId:'local:pi'})).ok,false);
  assert.equal(active.sent.length,0);
});

test('explicit native choice clears reserved and released archive identities before the real session open', async () => {
  for (const state of ['reserved-work-card', 'released-ordinary-chat', 'live-chat']) {
    const f = nativeOpeningFixture({ id: 't', title: 'Ready', status: 'todo' });
    Object.assign(f.ctx, { _ref: state === 'live-chat' ? 'old-ref' : '', _sessionId: 'old-chat',
      _sessionOptions: { adapterId: 'qwen', cwd: 'D:/old-workspace', modelName: 'old-model' },
      _snap: { status: 'idle', messages: [], workOnly: state === 'reserved-work-card' } });
    await assert.rejects(f.window.RequirementSessionChoice.executeNative('t', 'Use a new Pi conversation'),
      /Isolated test stopped at native open/);
    assert.equal(f.nativeOpens.length, 1, state);
    const options = f.nativeOpens[0];
    assert.equal(options.chatId, undefined, state + ' must not resume the old archive');
    assert.equal(options.requireTaskBinding, undefined, state);
    assert.equal(options.cwd, undefined, state + ' must not inherit the old workspace');
    assert.equal(options.adapterId, 'pi');
    assert.equal(options.modelName, '');
    assert.equal(options.taskRef, 't');
    assert.equal(f.sent.length, 0);
  }
});

test('ordinary first send still resumes the reserved work-card archive and saves its draft selection', async () => {
  const f = nativeOpeningFixture({ id: 't', title: 'Ready', status: 'todo' });
  let savedSelection = 0;
  Object.assign(f.ctx, { _ref: '', _sessionId: 'work-card-draft',
    _sessionOptions: { adapterId: 'pi', cwd: 'D:/draft-workspace' },
    _snap: { status: 'idle', messages: [], workOnly: true },
    _workCards: { ensureDraftSelectionSaved: async () => { savedSelection++; return true; } } });
  assert.equal(await f.ctx._ensure(), false);
  assert.equal(savedSelection, 1);
  assert.equal(f.nativeOpens.length, 1);
  assert.equal(f.nativeOpens[0].chatId, 'work-card-draft');
  assert.equal(f.nativeOpens[0].cwd, 'D:/draft-workspace');
  assert.equal(f.nativeOpens[0].requireTaskBinding, false);
  assert.equal(f.ctx._sessionId, 'work-card-draft');
  assert.equal(f.sent.length, 0);
});

test('首次显式派发不探测弱任务映射，直接新建会话并发送一次', async () => {
  for (const model of ['selected-model', '']) {
    const task = {id: 't', title: 'New requirement', status: 'todo',
      executionContext: {agent: {id: 'local:opencode'}, model: 'saved-model'}};
    const f = nativeOpeningFixture(task, {mapped: 'source-chat', open: async options => openedNative(options)});
    Object.assign(f.ctx, {_sessionId: 'source-chat', _snap: {status: 'idle', messages: []},
      _sessionOptions: {adapterId: 'pi', modelName: 'source-model', cwd: 'D:/source-project'}});
    let reads = 0;
    f.window.SoduWorkAPI.getTask = async () => { reads++; return task; };
    const result = await f.api.enqueueTask('t', {source: 'task-dispatch', agentId: 'local:opencode', model});
    assert.equal(result.ok, true, result.reason);
    assert.equal(reads >= 1, true, 'first dispatch must revalidate task authority');
    assert.equal(f.nativeOpens.length, 1);
    assert.equal(f.nativeOpens[0].chatId, undefined);
    assert.equal(f.nativeOpens[0].requireTaskBinding, undefined);
    assert.equal(f.nativeOpens[0].cwd, undefined, 'the source conversation workspace must not leak into a new task');
    assert.equal(f.nativeOpens[0].adapterId, 'opencode');
    assert.equal(f.nativeOpens[0].modelName, model);
    assert.equal(f.nativeOpens[0].taskRef, 't');
    assert.deepEqual(f.removed, []);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].options.taskExecution.agentId, 'local:opencode');
    assert.equal(f.sent[0].options.taskExecution.model, model);
  }
});

test('typed binding recovery stays closed for explicit reuse, server receipts and non-dispatch navigation', async () => {
  const base = {id: 't', title: 'New requirement', status: 'todo'};
  const cases = [
    {options: {chatId: 'source-chat'}}, {options: {reuseConversation: true}}, {options: {reuseCurrent: true}},
    {options: {source: 'task-open'}}, {options: {source: 'task-retry'}}, {options: {source: 'task-detail'}},
    {options: {acceptanceSession: true}}, {options: {reworkSession: true}},
    {task: {...base, workRouting: {conversationTurn: {conversationId: 'server-chat'}}}},
    {task: {...base, status: 'doing'}}, {task: {...base, ai: {state: 'running'}}},
  ];
  for (const row of cases) {
    const task = row.task || base;
    const f = nativeOpeningFixture(task, {mapped: 'source-chat', open: async () =>
      ({ok: false, code: 'TASK_BINDING_MISMATCH', reason: 'Bound to another task'})});
    const result = await f.api._openTask('t', task.title, {task, source: 'task-dispatch', ...row.options});
    assert.equal(result, false, JSON.stringify(row));
    assert.equal(f.nativeOpens.length, 1); assert.equal(f.removed.length, 0); assert.equal(f.sent.length, 0);
  }
});

test('fresh task authority and navigation guards are rechecked before replacing a weak mapping', async () => {
  const task = {id: 't', title: 'New requirement', status: 'todo'};
  for (const reason of ['started', 'server-bound', 'read-only', 'denied', 'missing', 'wrong-task', 'offline', 'view-changed', 'request-changed', 'scope-changed', 'mapping-changed']) {
    const f = nativeOpeningFixture(task, {mapped: 'source-chat', open: async () =>
      ({ok: false, code: 'TASK_BINDING_MISMATCH', reason: 'Bound to another task'})});
    let owner = 'owner'; f.window.SoduWorkAPI.taskStorageKey = () => owner;
    f.window.SoduWorkAPI.getTask = async () => {
      if (reason === 'offline') throw Error('Network unavailable');
      if (reason === 'view-changed') f.ctx._viewEpoch++;
      if (reason === 'request-changed') f.ctx._taskOpenSeq++;
      if (reason === 'scope-changed') owner = 'another-owner';
      if (reason === 'mapping-changed') f.window.ChatCollaborationStore.findByTask = () => ({conversationId: 'newly-bound'});
      if (reason === 'started') return {...task, status: 'doing'};
      if (reason === 'server-bound') return {...task, workRouting: {conversationTurn: {conversationId: 'real-execution'}}};
      if (reason === 'read-only') return {...task, readOnly: true};
      if (reason === 'denied') return {...task, canViewExecution: false};
      if (reason === 'missing') return null;
      if (reason === 'wrong-task') return {...task, id: 'other'};
      return task;
    };
    assert.equal(await f.api._openTask('t', task.title, {task, source: 'task-dispatch'}), false, reason);
    assert.equal(f.nativeOpens.length, 1, reason);
    assert.equal(f.removed.length, 0, reason); assert.equal(f.sent.length, 0, reason);
  }
});

test('a project affinity hint is not treated as a rejected weak task mapping', async () => {
  const task = {id: 't', title: 'New requirement', status: 'todo', projectId: 'project'};
  const f = nativeOpeningFixture(task, {open: async () =>
    ({ok: false, code: 'TASK_BINDING_MISMATCH', reason: 'Bound to another task'})});
  f.window.ChatCollaborationStore.findByProject = () => ({conversationId: 'project-chat'});
  assert.equal(await f.api._openTask('t', task.title, {task, source: 'task-dispatch'}), false);
  assert.equal(f.nativeOpens.length, 1);
  assert.equal(f.nativeOpens[0].chatId, 'project-chat');
  assert.equal(f.removed.length, 0); assert.equal(f.sent.length, 0);
});

test('recovery refuses changed execution scope instead of applying the previous opening options', async () => {
  const base = {id: 't', title: 'New requirement', status: 'todo'};
  const changes = [
    {projectId: 'another-project'}, {repoId: 'repository'}, {repo: {path: 'D:/project', branch: 'main'}},
    {workflowBindingId: 'workflow'}, {workRouting: {selectedStrategy: 'workflow'}},
    {executionContext: {agent: {id: 'local:claude'}}}, {executionContext: {model: 'another-model'}},
    {executionContext: {runner: {mode: 'remote', id: 'machine'}}},
    {workRouting: {executionContext: {repoId: 'repository'}}},
    {workRouting: {executionContext: {plugin: {bindingId: 'workflow'}}}},
  ];
  for (const change of changes) {
    const f = nativeOpeningFixture(base, {mapped: 'source-chat', open: async () =>
      ({ok: false, code: 'TASK_BINDING_MISMATCH', reason: 'Bound to another task'})});
    f.window.SoduWorkAPI.getTask = async () => ({...base, ...change});
    assert.equal(await f.api._openTask('t', base.title, {task: base, source: 'task-dispatch',
      sessionOptions: {adapterId: 'pi', modelName: ''}}), false, JSON.stringify(change));
    assert.equal(f.nativeOpens.length, 1);
    assert.equal(f.removed.length, 0); assert.equal(f.sent.length, 0);
    assert.equal(f.ctx._taskOpenError, '需求的执行配置已更新，请刷新后重新安排');
  }
});

test('non-routing task edits do not prevent an otherwise valid typed mapping recovery', async () => {
  const task = {id: 't', title: 'New requirement', status: 'todo', updatedAt: 'old',
    executionContext: {agent: {id: 'local:pi', name: 'Old display name'}}};
  const f = nativeOpeningFixture(task, {mapped: 'source-chat', open: async (options, attempt) => attempt === 1
    ? {ok: false, code: 'TASK_BINDING_MISMATCH', reason: 'Bound to another task'} : openedNative(options)});
  f.window.SoduWorkAPI.getTask = async () => ({...task, title: 'Updated title', note: 'New description', updatedAt: 'new',
    executionContext: {agent: {id: 'local:pi', name: 'Updated display name'}}});
  assert.equal(await f.api._openTask('t', task.title, {task, source: 'task-dispatch', sessionOptions: {adapterId: 'pi', modelName: ''}}), true);
  assert.equal(f.nativeOpens.length, 2);
  assert.equal(f.nativeOpens[1].chatId, undefined);
  assert.deepEqual(f.removed, [['source-chat', 't']]);
});

test('matching text, unrelated error codes and transport exceptions never trigger binding recovery', async () => {
  const task = {id: 't', title: 'New requirement', status: 'todo'};
  const replies = [
    {ok: false, reason: '这条会话不是该需求的协作会话'},
    {ok: false, code: 'PERMISSION_DENIED', reason: '这条会话不是该需求的协作会话'},
    {ok: false, code: 'NETWORK_UNAVAILABLE', reason: 'TASK_BINDING_MISMATCH'},
    () => { throw Error('TASK_BINDING_MISMATCH'); },
  ];
  for (const reply of replies) {
    const f = nativeOpeningFixture(task, {mapped: 'source-chat', open: async () => typeof reply === 'function' ? reply() : reply});
    f.ctx._snap = {status: 'unreachable', sessionOpenCode: 'TASK_BINDING_MISMATCH'};
    assert.equal((await f.api.enqueueTask('t', {source: 'task-dispatch'})).ok, false);
    assert.equal(f.nativeOpens.length, 1); assert.equal(f.removed.length, 0); assert.equal(f.sent.length, 0);
    assert.notEqual(f.ctx._snap.sessionOpenCode, 'TASK_BINDING_MISMATCH', 'a prior attempt code must be cleared');
  }
});

test('首次派发忽略缺失草稿映射并直接新建会话', async () => {
  const task = {id: 't', title: 'New requirement', status: 'todo'};
  const f = nativeOpeningFixture(task, {mapped: 'missing-draft', open: async options => openedNative(options)});
  Object.assign(f.ctx, {_sessionId: 'missing-draft', _sessionOptions: {adapterId: 'pi', cwd: 'D:/deleted-chat'},
    _snap: {status: 'idle', messages: []}});
  const result = await f.api.enqueueTask('t', {source: 'task-dispatch', agentId: 'local:pi', model: ''});
  assert.equal(result.ok, true, result.reason);
  assert.equal(f.nativeOpens.length, 1);
  assert.equal(f.nativeOpens[0].chatId, undefined);
  assert.equal(f.nativeOpens[0].cwd, undefined);
  assert.equal(f.sent.length, 1);
});

test('进行中需求的旧会话被主进程确认删除后回退到新会话', async () => {
  const task = { id: 'doing-task', title: 'Continue execution', status: 'doing',
    workRouting: { conversationTurn: { conversationId: 'deleted-execution' } } };
  const f = nativeOpeningFixture(task, { open: async (options, attempt) => attempt === 1
    ? { ok: false, notFound: true, reason: 'Archive was deleted' } : openedNative(options) });
  const opened = await f.api._openTask(task.id, task.title, {
    task, source: 'task-live', chatId: 'deleted-execution', navigation: true,
  });
  assert.equal(opened, true, 'the task should continue in a fresh fallback session');
  assert.equal(f.nativeOpens.length, 2);
  assert.equal(f.nativeOpens[1].chatId, undefined);
});

test('显式选择本机对话时不会重新套用旧工作流或远程执行配置', async () => {
  const task={id:'t',title:'旧安排',status:'todo',workflowBindingId:'old-flow',
    executionContext:{strategy:'workflow',runner:{mode:'remote',id:'old-runner'},model:'old-model'},
    workRouting:{selectedStrategy:'workflow',selectedWorkflowBindingId:'old-flow'}};
  const f=fixture(task,{mapped:'old-chat'});
  const result=await f.api.enqueueTask('t',{forceNew:true,executionChoice:'native',agentId:'local:pi'});
  assert.equal(result.ok,true,result.reason);
  assert.equal(f.opened[0].options.adapterId,'pi');
  assert.equal(f.opened[0].options.modelName,'');
  const chosen=f.sent[0].options.taskExecution;
  assert.equal(chosen.bindingId,'');assert.equal(chosen.executionContext.strategy,'direct');
  assert.equal(chosen.executionContext.runner.mode,'local');
  assert.equal(chosen.executionChoice,'native');
  assert.equal(task.workflowBindingId,'old-flow','客户端不能提前改写服务端任务或历史证据');
});

test('待开始保留绑定安全边界，进行中会话缺失时回退到新会话', async () => {
  const base = { id: 't', title: 'Pending', status: 'todo' };
  const cases = [
    { task: { ...base, workRouting: { conversationTurn: { conversationId: 'server-chat' } } }, source: 'task-dispatch', missing: true },
    { task: base, source: 'task-dispatch', chatId: 'explicit-chat', missing: true },
    { task: { ...base, status: 'doing' }, source: 'task-dispatch', missing: true },
    { task: base, source: 'task-live', missing: true },
    { task: base, source: 'task-dispatch', missing: false },
  ];
  for (const row of cases) {
    const f = fixture(row.task, { mapped: 'archive', missing: row.missing });
    const opened = await f.api._openTask('t', 'Pending', { task: row.task, source: row.source, chatId: row.chatId });
    if (row.task.status === 'doing') {
      assert.equal(opened, true);
      assert.equal(f.opened.length, 2);
      assert.equal(f.opened[1].id, '');
      assert.deepEqual(f.removed, [['archive', 't']]);
    } else {
      assert.equal(opened, false);
      assert.equal(f.opened.length, 1); assert.equal(f.removed.length, 0); assert.equal(f.sent.length, 0);
      assert.equal(f.ctx._taskOpenError, 'archive unavailable');
    }
  }
});
