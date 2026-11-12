'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const Requirements = require('../core/requirements.js');
const TaskSync = require('../core/task-sync.js');
const source = fs.readFileSync(path.join(__dirname, '../components/requirements/requirements-detail.js'), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; };
const task = id => ({id, title: 'Requirement ' + id, status: 'todo', triageStage: 'ready',
  canViewExecution: true, canEditRequirement: false});

test('cached detail is read-only while Hub is delayed and close aborts its request', async () => {
  const pending = deferred(); let signal;
  const f = fixture({ getTask: (_id, options) => { signal = options.signal; return pending.promise; } });
  f.context.AbortController = AbortController;
  f.context.Store = { taskState: 'ready', tasks: [{ ...task('a'), title: '<Cached title>', canEditRequirement: true }] };
  const opening = f.api.open('a');
  const content = f.active().querySelector('.rq-detail-content');
  assert.match(content.innerHTML, /Cached title/);
  assert.doesNotMatch(content.innerHTML, /data-rq-edit|data-rq-execute|data-rq-accept/);
  f.api.close();
  assert.equal(signal.aborted, true);
  pending.resolve(task('a')); await opening;
  assert.equal(f.active(), undefined);
});
function fixture(overrides = {}) {
  const roots = [], calls = [], events = {};
  class Node {
    constructor() { this.children = new Map(); this.appended = []; this.listeners = {}; this.dataset = {}; this.isConnected = true; this.html = ''; this.classList = {toggle() {}}; }
    set innerHTML(value) { this.html = value; this.children.clear(); }
    get innerHTML() { return this.html; }
    querySelector(selector) {
      if (selector === '[data-rq-trace]' && !this.html.includes('data-rq-trace')) return null;
      if (selector === '[data-rq-extension-error]' && !this.children.has(selector)) return null;
      if (!this.children.has(selector)) this.children.set(selector, new Node());
      return this.children.get(selector);
    }
    querySelectorAll() { return []; }
    replaceChildren(...items) { this.appended = items; }
    append(...items) { this.appended.push(...items); }
    prepend(...items) { this.appended.unshift(...items); }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    setAttribute() {}
    focus() {}
    remove() { this.isConnected = false; }
  }
  const context = {Requirements, TaskSync, document: {activeElement: null, querySelectorAll: () => [],
    createElement: () => new Node(), body: {appendChild: node => roots.push(node)}},
    addEventListener: (name, fn) => {const previous = events[name]; events[name] = event => {previous?.(event); fn(event);};},
    SoduWorkAPI: {getTask: async id => task(id), listAttachments: async () => [], getTaskEvents: async () => [], getTaskComments: async () => [],
      attachmentUrl: file => '/authorized/' + file.id, ...overrides},
    RequirementsBoard: {context: () => ({}), refresh: async () => {}},
    TaskExecutionJourney: {mount: (node, options) => calls.push(['mount', options]),
      unmount: () => calls.push(['unmount'])},
    soduWorkAPI: {downloadAttachment: async file => {calls.push(['download', file]); return {ok: true};}},
    ConversationAttachments: {openTaskAttachment: async file => calls.push(['preview', file])},
    petSay: message => calls.push(['notice', message]), detailId: null,
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/task-trace-view.js'), 'utf8'), context);
  Object.assign(context.TaskExecutionJourney, {mount: (node, options) => calls.push(['mount', options]), unmount: () => calls.push(['unmount'])});
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/requirements/requirement-fields.js'), 'utf8'), context);
  vm.runInNewContext(source, context);
  const active = () => roots.filter(node => node.isConnected).at(-1);
  const click = (selector, dataset) => active().listeners.click({target: {closest: query =>
    query.split(',').includes(selector) ? {dataset, hasAttribute: name => selector === '[' + name + ']'} : null}});
  return {context, api: context.RequirementsDetail, calls, events, active, roots, click,
    content: () => active().querySelector('.rq-detail-content')};
}

test('intake details offer preparation instead of execution and show the real delivery state', async () => {
  const f = fixture({getTask: async id => ({...task(id),triageStage:'intake',canEditRequirement:true})});
  await f.api.open('intake');
  const footer = f.active().querySelector('.rq-detail-footer').innerHTML;
  assert.match(footer, /data-rq-ready/);
  assert.doesNotMatch(footer, /data-rq-chat|data-rq-assign/);
  assert.match(f.content().innerHTML, /尚未开始/);
  assert.doesNotMatch(f.content().innerHTML, /rq-delivery-state is-active/);
});

test('delivery badge follows execution evidence even before the task stage catches up', async () => {
  const cases = [
    [{ai:{state:'running'}}, '处理中'],
    [{ai:{state:'dispatching'}}, '处理中'],
    [{ai:{state:'failed'}}, '执行异常'],
    [{maintenanceBlocked:true}, '处理中'],
    [{workRouting:{conversationTurn:{state:'queued'}}}, '处理中'],
    [{requirementStage:'reviewing',ai:{state:'running'}}, '待验收'],
    [{archivedAt:1,ai:{state:'running'}}, '已归档'],
    [{}, '尚未开始'],
  ];
  for (const [fields, expected] of cases) {
    const f = fixture({getTask:async id => ({...task(id),...fields})});
    await f.api.open('state');
    const badge = f.content().innerHTML.match(/class="rq-delivery-state ([^"]+)"[^>]*>([^<]+)</);
    assert.ok(badge, JSON.stringify(fields));
    assert.equal(badge[2], expected, JSON.stringify(fields));
    if (expected === '尚未开始' || expected === '已归档') assert.equal(badge[1], 'is-idle');
  }
});

test('only the latest requirement response can populate the single drawer', async () => {
  const a = deferred(), b = deferred();
  const f = fixture({getTask: id => id === 'a' ? a.promise : b.promise});
  const first = f.api.open('a'), second = f.api.open('b');
  b.resolve(task('b')); await second;
  a.resolve(task('a')); await first;
  assert.equal(f.roots.filter(node => node.isConnected).length, 1);
  assert.equal(f.content().dataset.taskId, 'b');
  assert.match(f.content().innerHTML, /Requirement b/);
  assert.doesNotMatch(f.content().innerHTML, /Requirement a/);
});

test('live refresh preserves the drawer and scroll while updating lifecycle actions', async () => {
  let value = {...task('live'), canEditRequirement:true};
  const f = fixture({getTask:async()=>({...value})});
  await f.api.open('live');
  const drawer = f.active(), content = f.content(); content.scrollTop = 240;
  value = {...value,status:'done',canEditRequirement:false,myRoles:['assignee']};
  await f.api.refresh('live');
  assert.equal(f.active(), drawer);
  assert.equal(f.content().scrollTop, 240);
  assert.match(f.content().innerHTML,/待验收/);
  assert.doesNotMatch(drawer.querySelector('.rq-detail-footer').innerHTML,/data-rq-edit|data-rq-chat/);
});

test('late live refresh cannot overwrite another drawer or a newer response', async () => {
  const stale = deferred(); let reads = 0;
  const f = fixture({getTask:async id => ++reads === 2 ? stale.promise : {...task(id), title:'Latest ' + id}});
  await f.api.open('a'); const update = f.api.refresh('a');
  const latest = f.api.refresh('a');
  stale.resolve({...task('a'),title:'Stale'}); await Promise.all([update, latest]);
  assert.match(f.content().innerHTML,/Latest a/); assert.doesNotMatch(f.content().innerHTML,/Stale/);
  const late = deferred(); f.context.SoduWorkAPI.getTask = id => id === 'a' ? late.promise : Promise.resolve(task(id));
  const pending = f.api.refresh('a'); await f.api.open('b'); late.resolve(task('a')); await pending;
  assert.match(f.content().innerHTML,/Requirement b/);
});

test('execution starting during editing keeps the draft and blocks writes', async () => {
  let value = {...task('draft'),canEditRequirement:true}; const writes = [];
  const f = fixture({getTask:async()=>({...value}),patchTask:async(...args)=>writes.push(args)});
  await f.api.open('draft'); const form = editForm(f,'draft',assigneeSelect(''));
  f.click('[data-rq-edit]'); form.elements.note.value = 'Keep my draft';
  const button = {disabled:false}; f.active().querySelectorAll = () => [button];
  value = {...value,status:'doing',canEditRequirement:false,requirementEditBlockReason:'需求已开始执行'};
  await f.api.refresh('draft');
  assert.equal(form.elements.note.value,'Keep my draft'); assert.equal(button.disabled,true);
  assert.match(f.active().querySelector('[data-rq-error]').textContent,/已开始执行/);
  assert.match(f.active().querySelector('[data-rq-header-meta]').textContent,/进行中/);
  assert.equal(f.active().querySelector('[form="rqEditForm"][type="submit"]').textContent,'不可编辑');
  f.active().listeners.submit({preventDefault(){},target:form}); await new Promise(setImmediate);
  assert.equal(writes.length,0);
  f.click('[data-rq-edit-cancel]'); assert.equal(f.active().querySelector('[data-rq-confirm]').hidden,false);
});

test('locked definitions retain separately authorized review and material operations', async () => {
  const f = fixture({getTask:async id=>({...task(id),status:'doing',canEditRequirement:false,
    canSubmitReview:true,canManageRequirementMaterials:true}),submitTaskReview:async()=>({ok:true})});
  await f.api.open('manual');
  assert.match(f.active().querySelector('.rq-detail-footer').innerHTML,/data-rq-submit-review>提交验收/);
  assert.doesNotMatch(f.content().innerHTML,/data-rq-submit-review/);
  assert.match(f.content().innerHTML,/data-rq-add-files/);
  assert.doesNotMatch(f.active().querySelector('.rq-detail-footer').innerHTML,/data-rq-edit/);
  f.click('[data-rq-submit-review]'); await new Promise(setImmediate);
  assert.ok(f.calls.some(row=>row[0]==='notice' && /已提交验收/.test(row[1])));
});

test('no-delivery work exposes manual submission in More even with a stale auto mode', async () => {
  const f = fixture({getTask: async id => ({...task(id), status: 'doing',
    canSubmitReview: true, workRouting: {executionSubmissionMode: 'auto'},
  }), submitTaskReview: async () => ({ok: true})});
  await f.api.open('manual-no-output');
  assert.match(f.active().querySelector('.rq-detail-footer').innerHTML, /data-rq-submit-review>提交验收/);
});

test('contract kind without deliverables still exposes manual completion', async () => {
  const f = fixture({getTask: async id => ({...task(id), status: 'doing',
    canSubmitReview: true,
    workRouting: {executionSubmissionMode: 'auto', outputContract: {kind: 'office-artifact'}},
  }), submitTaskReview: async () => ({ok: true})});
  await f.api.open('kind-only-contract');
  assert.match(f.active().querySelector('.rq-detail-footer').innerHTML, /data-rq-submit-review>提交验收/);
});

test('live updates do not replace the optimistic version of an open editing draft', async () => {
  let value = {...task('versioned'),canEditRequirement:true,requirementVersion:3}; const writes = [];
  const f = fixture({getTask:async()=>({...value}),patchTask:async(_id,patch)=>{writes.push(patch); return {};}});
  await f.api.open('versioned'); const form = editForm(f,'versioned',assigneeSelect(''));
  f.click('[data-rq-edit]'); form.elements.note.value = 'My change';
  value = {...value,requirementVersion:4,note:'Concurrent edit'};
  await f.api.refresh('versioned');
  f.active().listeners.submit({preventDefault(){},target:form}); await new Promise(setImmediate);
  assert.equal(writes.length,1); assert.equal(writes[0].requirementVersion,3);
});

test('a rejected save cannot unlock a draft after execution starts during the request', async () => {
  let value = {...task('race'),canEditRequirement:true}; let rejectPatch;
  const pending = new Promise((_resolve,reject)=>{rejectPatch=reject;});
  const f = fixture({getTask:async()=>({...value}),patchTask:()=>pending});
  await f.api.open('race'); const form = editForm(f,'race',assigneeSelect(''));
  f.click('[data-rq-edit]'); form.elements.note.value = 'Draft';
  const save = {disabled:false,hasAttribute:()=>false}; f.active().querySelectorAll = () => [save];
  f.active().listeners.submit({preventDefault(){},target:form});
  value = {...value,status:'doing',canEditRequirement:false}; await f.api.refresh('race');
  rejectPatch(Object.assign(new Error('需求已进入执行'),{status:409})); await new Promise(setImmediate);
  assert.equal(save.disabled,true); assert.equal(form.elements.note.value,'Draft');
});

test('a task update during material upload is presented when the upload settles', async () => {
  let value = {...task('upload'),canEditRequirement:true,canManageRequirementMaterials:true};
  const upload = deferred();
  const f = fixture({getTask:async()=>({...value}),uploadAttachment:()=>upload.promise});
  await f.api.open('upload');
  f.active().listeners.change({target:{id:'rqFileInput',files:[{name:'evidence.md'}],value:'file'}});
  value = {...value,status:'doing',canEditRequirement:false}; await f.api.refresh('upload');
  upload.resolve({ok:true}); await new Promise(setImmediate); await new Promise(setImmediate);
  assert.match(f.active().querySelector('[data-rq-header-meta]').textContent,/进行中/);
  assert.doesNotMatch(f.active().querySelector('.rq-detail-footer').innerHTML,/data-rq-edit/);
  assert.match(f.content().innerHTML,/data-rq-add-files/);
});

test('详情验收卡传入任务标识，并向验收人展示独立会话入口', async () => {
  const f = fixture({getTask: async id => ({...task(id), status: 'done', createdBy: 'me'})});
  f.context.__teamCap = {meId: 'me'};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/task-trace-approval.js'), 'utf8'), f.context);
  await f.api.open('review-task');
  assert.match(f.content().innerHTML, /data-tfd-acceptance-mode/);
  assert.match(f.content().innerHTML, /data-tfd-acceptance-session/);
  assert.doesNotMatch(f.active().querySelector('.rq-detail-footer').innerHTML, /data-rq-acceptance/);
});

test('creator-direct acceptance uses the Hub capability when local team state is late', async () => {
  const f = fixture({getTask: async id => ({...task(id), status: 'done', createdBy: 'me', canReview: true})});
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/task-trace-approval.js'), 'utf8'), f.context);
  await f.api.open('review-capability');
  assert.match(f.content().innerHTML, /data-tfd-acceptance-mode/);
});

test('a pending review on a doing task restores both acceptance modes only for its reviewer', async () => {
  for (const canReview of [true,false]) {
    const f = fixture({getTask:async id=>({...task(id),status:'doing',requirementStage:'reviewing',canReview})});
    f.context.RequirementsBoard.context = ()=>({approvals:new Map([['pending-review',{
      id:'review-ticket',taskId:'pending-review',action:'review',status:'pending',
    }]])});
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components/panels/task-trace-approval.js'),'utf8'),f.context);
    await f.api.open('pending-review');
    const html = f.content().innerHTML;
    if (canReview) {
      for (const label of ['手动验收','自动验收','在会话中分析','退回修改','确认验收','开始自动验收']) assert.ok(html.includes(label),label);
    } else assert.doesNotMatch(html,/data-tfd-acceptance-mode|data-tfd-acceptance-session/);
  }
});

test('ready tasks have no incomplete take-over shortcut and busy tasks cannot submit review', async () => {
  for (const fields of [{status:'todo'}, {status:'doing',maintenanceBlocked:true},
    {status:'doing',canSubmitReview:false},{status:'doing',workRouting:{conversationTurn:{state:'running'}}}]) {
    const f = fixture({getTask:async id=>({...task(id),canSubmitReview:true,...fields})});
    await f.api.open('permission-check');
    const html = f.active().querySelector('.rq-detail-footer').innerHTML;
    assert.doesNotMatch(html,/我来处理|data-rq-submit-review/);
  }
});

test('an approval arriving after task details restores its card without repeated draft resets', async () => {
  let reads = 0;
  const approvals = new Map();
  const f = fixture({getTask:async id=>{reads++;return {...task(id),status:'doing',requirementStage:'reviewing',canReview:true};}});
  f.context.RequirementsBoard.context = ()=>({approvals});
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components/panels/task-trace-approval.js'),'utf8'),f.context);
  await f.api.open('late-ticket');
  assert.doesNotMatch(f.content().innerHTML,/data-tfd-approval-action/,'A pending ticket must not fall back to direct acceptance');
  approvals.set('late-ticket',{id:'new-review',taskId:'late-ticket',action:'review',status:'pending'});
   f.events['soduwork-approvals-changed']();await new Promise(setImmediate);
  assert.match(f.content().innerHTML,/data-tfd-acceptance-mode/);
  const after = reads;
   f.events['soduwork-approvals-changed']();await new Promise(setImmediate);
  assert.equal(reads,after,'Unchanged inbox updates must preserve the approval draft');
});

test('验收动作关闭需求详情后，刷新回调不会把抽屉重新打开', async () => {
  let bound;
  const f = fixture({getTask: async id => ({...task(id), status: 'done', createdBy: 'me'})});
  f.context.__teamCap = {meId: 'me'};
  f.context.TaskTraceApproval = {
    html: () => '<button data-tfd-acceptance-session="1">在会话中分析</button>',
    bind: (_slot, state) => { bound = state; },
  };
  await f.api.open('review-close');
  assert.ok(bound?.opts?.onAcceptanceClosed);
  bound.opts.onAcceptanceClosed();
  await bound.refresh(true);
  assert.equal(f.active(), undefined);
});

test('closing or changing identity prevents a pending drawer load from returning', async () => {
  for (const action of ['close', 'identity']) {
    const pending = deferred(), f = fixture({getTask: () => pending.promise});
    const request = f.api.open('a');
    if (action === 'close') f.api.close(); else f.events['soduwork-data-scope-changed']();
    pending.resolve(task('a')); await request;
    assert.equal(f.active(), undefined, action);
  }
});

test('late materials cannot overwrite the next requirement', async () => {
  const pending = deferred();
  const f = fixture({listAttachments: id => id === 'a' ? pending.promise : Promise.resolve([{id: 'b-file', filename: 'B report'}])});
  const first = f.api.open('a'); await new Promise(r => setImmediate(r));
  await f.api.open('b');
  pending.resolve([{id: 'a-file', filename: 'Private A report'}]); await first;
  assert.match(f.active().querySelector('#rqAttachments').innerHTML, /B report/);
  assert.doesNotMatch(f.active().querySelector('#rqAttachments').innerHTML, /Private A/);
});

test('rework reference files stay outside the delivery material list', async () => {
  const f = fixture({listAttachments: async () => [
    {id: 'delivery', filename: '交付说明.md', role: 'output', size: 1200},
    {id: 'rework', filename: '交付说明.md', role: 'rework_input', size: 900},
  ]});
  await f.api.open('rework-materials');
  const html = f.active().querySelector('#rqAttachments').innerHTML;
  assert.match(html, /rq-material-rework/);
  assert.match(html, /仅供返修使用，不计入交付产物/);
  assert.match(html, /data-rq-file-id="rework"/);
  assert.match(html, /data-rq-file-id="delivery"/);
});

test('material groups preserve filenames and supporting files do not trigger automatic archives', async () => {
  const f = fixture({listAttachments: async () => [
    {id: 'input', filename: '需求说明.md', role: 'input', size: 120},
    {id: 'evidence', filename: '验收截图.png', role: 'verification', size: 240},
    {id: 'output-a', filename: 'index.html', role: 'output', sourceRef: 'conversation:current', size: 320},
    {id: 'output-b', filename: 'style.css', role: 'output', category: 'supporting', sourceRef: 'conversation:current', size: 180},
    {id: 'output-c', filename: 'app.js', role: 'output', category: 'supporting', sourceRef: 'conversation:current', size: 460},
    {id: 'rework', filename: '返修说明.md', role: 'rework_input', size: 90},
  ]});
  await f.api.open('material-groups');
  const html = f.active().querySelector('#rqAttachments').innerHTML;
  for (const [group, label] of [['input', '需求资料'], ['evidence', '过程证据'], ['output', '交付物'], ['rework', '返修参考资料']]) {
    const match = html.match(new RegExp('<details[^>]*data-rq-material-group="' + group + '"[^>]*>'));
    assert.ok(match, group + ' group must be collapsible');
    assert.doesNotMatch(match[0], /\bopen(?:\s|=|>)/, group + ' group is collapsed by default');
    assert.match(html, new RegExp(label));
  }
  assert.doesNotMatch(html, /data-rq-bundle-download/);
  assert.doesNotMatch(html, /自动压缩包\.zip/);
  for (const id of ['a', 'b', 'c']) assert.ok(html.includes('data-rq-file-id="output-' + id + '"'));
  assert.match(html, /交付物 · 3 份/);
});

test('history is escaped and read-only; trace opens lazily and unmounts on collapse', async () => {
  const f = fixture({getTask: async id => ({...task(id), progress: [{text: '<img onerror=alert(1)>', at: 0}]})});
  await f.api.open('a');
  assert.match(f.content().innerHTML, /&lt;img onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(f.content().innerHTML, /contenteditable|dthread|replyInput|<img onerror/);
  assert.equal(f.calls.filter(row => row[0] === 'mount').length, 0);
  const journey = {};
  const target = {open: true, matches: query => query === '[data-rq-execution]', querySelector: () => journey};
  f.active().listeners.toggle({target});
  assert.equal(f.calls.at(-1)[1].taskId, 'a'); assert.equal(f.calls.at(-1)[1].compact, true);
  for (const key of ['suppressInlineApproval', 'suppressTimeline', 'force']) assert.equal(f.calls.at(-1)[1][key], true, key);
  target.open = false; f.active().listeners.toggle({target});
  assert.equal(f.calls.at(-1)[0], 'unmount');
  target.open = true; f.active().listeners.toggle({target});
  assert.equal(f.calls.filter(row => row[0] === 'mount').length, 2);
  for (const key of ['suppressInlineApproval', 'suppressTimeline', 'force']) assert.equal(f.calls.at(-1)[1][key], true, 'reopen: ' + key);
});

test('execution-restricted viewers cannot mount evidence even from a forged toggle', async () => {
  const f = fixture({getTask: async id => ({...task(id), canViewExecution: false})});
  await f.api.open('a');
  assert.doesNotMatch(f.content().innerHTML, /data-rq-execution|data-rq-chat|data-rq-comments/);
  f.active().listeners.toggle({target: {open: true, matches: query => query === '[data-rq-execution]',
    querySelector: () => ({})}});
  assert.equal(f.calls.filter(row => row[0] === 'mount').length, 0);
});

test('shared requirement editors can edit the source without an unauthorized execution deadline field', async () => {
  const f = fixture({getTask: async id => ({...task(id), readOnly: true,
    canEditRequirement: true, canViewExecution: false})});
  await f.api.open('shared');
  assert.match(f.content().innerHTML, /rq-detail-overview/);
  assert.doesNotMatch(f.content().innerHTML, /id="rqEditForm"/);
  f.click('[data-rq-edit]');
  assert.match(f.content().innerHTML, /id="rqEditForm"/);
  assert.match(f.content().innerHTML, /name="title"/);
  assert.doesNotMatch(f.content().innerHTML, /name="due"/);
});

test('editing is explicit and cancelling returns to the readable source without writing', async () => {
  let writes = 0;
  const f = fixture({getTask: async id => ({...task(id), canEditRequirement: true,
    note: '<original>', acceptanceCriteria: ['Visible criterion']}), patchTask: async () => {writes++;}});
  await f.api.open('editable');
  assert.match(f.content().innerHTML, /&lt;original&gt;/);
  assert.match(f.content().innerHTML, /Visible criterion/);
  f.click('[data-rq-edit]'); assert.match(f.content().innerHTML, /rqEditForm/);
  f.click('[data-rq-edit-cancel]');
  assert.doesNotMatch(f.content().innerHTML, /rqEditForm/);
  assert.equal(writes, 0);
});

test('styled discard dialog preserves unsaved fields when the user declines discarding', async () => {
  const f = fixture({getTask: async id => ({...task(id), canEditRequirement: true,
    note: 'Saved background', kind: 'requirement', priority: 'normal', acceptanceCriteria: []})});
  await f.api.open('editable'); f.click('[data-rq-edit]');
  f.active().querySelector('#rqEditForm').elements = {
    title: {value:'Requirement editable'}, note: {value:'Unsaved draft'},
    kind: {value:'requirement'}, priority: {value:'normal'}, acceptance:{value:''},
  };
  const drawer = f.active(); f.click('[data-rq-edit-cancel]');
  assert.equal(drawer.querySelector('[data-rq-confirm]').hidden, false);
  f.click('[data-rq-confirm-cancel]'); await new Promise(r => setImmediate(r));
  assert.match(f.content().innerHTML, /rqEditForm/);
  const closing = f.api.close(); assert.equal(typeof closing?.then, 'function');
  assert.equal(drawer.querySelector('[data-rq-confirm]').hidden, false);
  f.click('[data-rq-confirm-cancel]'); assert.equal(await closing, false); assert.equal(f.active(), drawer);
  assert.equal(drawer.querySelector('#rqEditForm').elements.note.value, 'Unsaved draft');
  f.click('[data-rq-edit-cancel]'); f.click('[data-rq-confirm-discard]'); await new Promise(r => setImmediate(r));
  assert.doesNotMatch(f.content().innerHTML, /rqEditForm/);assert.match(f.content().innerHTML, /Saved background/);
});

test('low-frequency collaboration and plugin evidence opens from the More menu', async () => {
  const comments = deferred();
  const f = fixture({getTask: async id => task(id), getTaskComments: () => comments.promise});
  f.context.PluginUIHost = {contributions: async () => [{title: '插件信息'}], openContribution: async () => {}};
  await f.api.open('evidence');
  assert.doesNotMatch(f.content().innerHTML, /data-rq-comments|data-rq-extensions/);
  assert.match(f.active().querySelector('.rq-detail-footer').innerHTML, /更多/);
  f.click('[data-rq-comments-open]');
  assert.equal(f.active().querySelector('[data-rq-evidence-modal]').hidden, false);
  comments.resolve([{authorName: '成员', body: '反馈', createdAt: 0}]); await new Promise(r => setImmediate(r));
  assert.match(f.active().querySelector('[data-rq-comment-list]').innerHTML, /反馈/);
  f.click('[data-rq-evidence-close]'); assert.equal(f.active().querySelector('[data-rq-evidence-modal]').hidden, true);
  f.click('[data-rq-extensions-open]'); assert.equal(f.active().querySelector('[data-rq-evidence-modal]').hidden, false);
  assert.equal(f.active().querySelector('[data-rq-evidence-modal]').dataset.panel, 'extensions');
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  f.context.PluginUIHost.openContribution = async () => { throw new Error('插件打开失败'); };
  const extensionList = f.active().querySelector('[data-rq-extension-list]');
  assert.equal(extensionList.appended.length, 1);
  await extensionList.appended.find(item => item.onclick)?.onclick();
  assert.match(extensionList.appended.find(item => Object.hasOwn(item.dataset, 'rqExtensionError'))?.textContent, /打开插件扩展失败/);
});

test('activity combines discussion and task history and retries only failed reads', async () => {
  let broken = true;
  const f = fixture({getTaskEvents: async () => [{kind: 'release.candidate', at: 10}],
    getTaskComments: async () => {if (broken) throw Error('Offline'); return [{body: 'Newest discussion', createdAt: 20}];}});
  await f.api.open('activity'); f.click('[data-rq-comments-open]'); await new Promise(setImmediate);
  const node = f.active().querySelector('[data-rq-comment-list]');
  assert.match(node.innerHTML, /交付版本已生成/); assert.match(node.innerHTML, /部分记录未能加载/);
  assert.doesNotMatch(node.innerHTML, /暂无活动记录/);
  broken = false; f.click('[data-rq-activity-retry]'); await new Promise(setImmediate);
  assert.match(node.innerHTML, /Newest discussion/); assert.doesNotMatch(node.innerHTML, /部分记录未能加载/);
  assert.ok(node.innerHTML.indexOf('Newest discussion') < node.innerHTML.indexOf('交付版本已生成'));
});

test('empty activity and missing plugin contributions have explicit explanations', async () => {
  const f = fixture(); await f.api.open('empty'); f.click('[data-rq-comments-open]'); await new Promise(setImmediate);
  assert.match(f.active().querySelector('[data-rq-comment-list]').innerHTML, /暂无活动记录/);
  f.click('[data-rq-extensions-open]');
  assert.match(f.active().querySelector('[data-rq-extension-list]').textContent, /不影响执行与验收/);
  f.context.PluginUIHost = {contributions: async () => []}; f.click('[data-rq-extensions-open]'); await new Promise(setImmediate);
  assert.match(f.active().querySelector('[data-rq-extension-list]').textContent, /不影响执行与验收/);
});

test('an unavailable history is not presented as no activity when discussion is empty', async () => {
  const f = fixture({getTaskEvents: async () => null});
  await f.api.open('unavailable'); f.click('[data-rq-comments-open]'); await new Promise(setImmediate);
  const html = f.active().querySelector('[data-rq-comment-list]').innerHTML;
  assert.match(html, /部分记录未能加载/); assert.match(html, /data-rq-activity-retry/);
  assert.doesNotMatch(html, /暂无活动记录/);
});

test('late activity cannot populate another task, closed dialog or account', async () => {
  for (const change of ['task', 'close', 'account']) {
    const pending = deferred(); const f = fixture({getTaskEvents: () => pending.promise});
    await f.api.open('old'); f.click('[data-rq-comments-open]');
    const node = f.active().querySelector('[data-rq-comment-list]');
    if (change === 'task') await f.api.open('new');
    if (change === 'close') f.click('[data-rq-evidence-close]');
    if (change === 'account') f.events['soduwork-data-scope-changed']();
    pending.resolve([{kind: 'created', detail: {note: 'Late secret'}}]); await new Promise(setImmediate);
    assert.doesNotMatch(node.innerHTML, /Late secret/);
  }
});

test('revoking execution visibility closes evidence and invalidates pending activity', async () => {
  const pending = deferred(); let visible = true;
  const f = fixture({getTask: async id => ({...task(id), canViewExecution: visible}), getTaskEvents: () => pending.promise});
  await f.api.open('restricted'); f.click('[data-rq-comments-open]');
  visible = false; await f.api.refresh('restricted');
  assert.equal(f.active().querySelector('[data-rq-evidence-modal]').hidden, true);
  pending.resolve([{kind: 'created', detail: {note: 'Revoked detail'}}]); await new Promise(setImmediate);
  assert.doesNotMatch(f.active().querySelector('[data-rq-comment-list]').innerHTML, /Revoked detail/);
});

test('automation uses fresh authorized requirements and opens the exact existing schedule', async () => {
  let value = {...task('a'), canEditRequirement: true, title: 'Opened snapshot'};
  const f = fixture({getTask: async () => value}), seeds = [], routes = [];
  f.context.WorkAutomationSheet = {open: async seed => seeds.push(seed)};
  f.context.openSchedulesEntry = options => routes.push(options);
  await f.api.open('a');
  value = {...value, title: 'Updated by teammate', acceptanceCriteria: ['Fresh criterion']};
  f.click('[data-rq-automation]'); await new Promise(setImmediate);
  assert.equal(seeds[0].proposal.title, value.title);
  assert.deepEqual(Array.from(seeds[0].proposal.acceptance), ['Fresh criterion']);
  await f.api.open('a'); value = {...value, automationScheduleId: 'schedule-existing'};
  f.click('[data-rq-automation]'); await new Promise(setImmediate);
  assert.equal(routes[0].scheduleId, 'schedule-existing'); assert.equal(seeds.length, 1);
});

test('automation rechecks revoked edit permission and ignores a late response after account change', async () => {
  const pending = deferred(); let reads = 0, launches = 0;
  const f = fixture({getTask: async id => ++reads === 1 ? {...task(id), canEditRequirement: true} : pending.promise});
  f.context.WorkAutomationSheet = {open: async () => {launches++;}};
  await f.api.open('a'); f.click('[data-rq-automation]');
  f.events['soduwork-data-scope-changed'](); pending.resolve({...task('a'), canEditRequirement: true});
  await new Promise(setImmediate); assert.equal(launches, 0);
  const revoked = fixture({getTask: async id => ({...task(id), canEditRequirement: ++reads === 3})});
  revoked.context.WorkAutomationSheet = f.context.WorkAutomationSheet;
  await revoked.api.open('a'); revoked.click('[data-rq-automation]'); await new Promise(setImmediate);
  assert.equal(launches, 0); assert.match(revoked.active().querySelector('[data-rq-error]').textContent, /无法管理.*自动化/);
});

test('material actions resolve the listed attachment and use narrow authenticated commands', async () => {
  const f = fixture({listAttachments: async () => [{id: 'file', filename: 'report.md'}]});
  await f.api.open('a');
  f.click('[data-rq-file]', {rqFile: 'file'});
  f.click('[data-rq-download]', {rqDownload: 'file'});
  f.click('[data-rq-download]', {rqDownload: 'forged'});
  await new Promise(r => setImmediate(r));
  for (const kind of ['preview', 'download']) {
    const rows = f.calls.filter(row => row[0] === kind);
    assert.equal(rows.length, 1); assert.equal(rows[0][1].url, '/authorized/file');
  }
});

test('missing requirements show an escaped error and a working retry action', async () => {
  let available = false;
  const f = fixture({getTask: async id => {
    if (!available) throw new Error('<server unavailable>');
    return task(id);
  }});
  await f.api.open('a');
  assert.match(f.content().innerHTML, /role="alert"/);
  assert.match(f.content().innerHTML, /&lt;server unavailable&gt;/);
  assert.match(f.content().innerHTML, /rqLoadRetry/);
  available = true;
  await f.active().querySelector('#rqLoadRetry').onclick();
  assert.match(f.content().innerHTML, /Requirement a/);
  assert.equal(f.roots.filter(node => node.isConnected).length, 1);
});

test('closing a loaded requirement suspends only its plugin input before removing the drawer', async () => {
  const f = fixture(), calls = [];
  f.context.TaskPluginInput = {resume: id => calls.push(['resume', id]), suspend: id => {
    assert.ok(f.active(), 'attached surface must close before its host disappears');
    calls.push(['suspend', id]);
  }};
  await f.api.open('a'); f.api.close();
  assert.deepEqual(calls, [['resume', 'a'], ['suspend', 'a']]);
  assert.equal(f.active(), undefined);
});

test('待开始详情隐藏执行会话，陈旧入口也不能打开已有会话', async () => {
  for (const fields of [{triageStage: undefined}, {triageStage: 'ready'},
    {triageStage: 'intake', requirementStage: 'ready'}, {ai: {state: 'failed'}}, {ai: {state: 'running'}}]) {
    const f = fixture({clientId: 'device-mine', getTask: async id => ({...task(id), ...fields,
      ownerClientId: 'device-mine', workRouting: {conversationTurn: {conversationId: 'existing-chat', state: 'done'}}})});
    let opened = 0;
    f.context.openTaskConversation = async () => { opened++; };
    await f.api.open('waiting');
    assert.doesNotMatch(f.active().querySelector('.rq-detail-footer').innerHTML, /data-rq-chat/, JSON.stringify(fields));
    f.click('[data-rq-chat]');
    await new Promise(setImmediate);
    assert.equal(opened, 0);
  }
});

test('execution conversation remains available locally except while delivery awaits review', async () => {
  for (const fields of [{status: 'doing'}, {status: 'paused'}, {requirementStage: 'reviewing'},
    {status: 'done'}, {status: 'done', reviewedAt: 1}]) {
    for (const canViewExecution of [true, false]) {
      const f = fixture({clientId: 'device-mine', getTask: async id => ({...task(id), ...fields, canViewExecution,
        ownerClientId: 'device-mine', workRouting: {conversationTurn: {conversationId: 'existing-chat', state: 'done'}}})});
      await f.api.open('linked');
      const footer = f.active().querySelector('.rq-detail-footer').innerHTML;
      if (canViewExecution && Requirements.stage({...task('linked'),...fields}) !== 'reviewing') assert.match(footer, /data-rq-chat/, JSON.stringify(fields));
      else assert.doesNotMatch(footer, /data-rq-chat/, JSON.stringify(fields));
    }
  }
});

test('the conversation entry only renders on the device that executed the requirement', async () => {
  // Hide execution-conversation links on devices without the local archive.
  const remote = fixture({getTask: async id => ({...task(id), status: 'doing', ownerClientId: 'device-other'}),
    clientId: 'device-mine'});
  await remote.api.open('a');
  const footer = node => node.querySelector('.rq-detail-footer').innerHTML;
  assert.doesNotMatch(footer(remote.active()), /data-rq-chat/);

  // Keep the link on the execution device.
  const mine = fixture({getTask: async id => ({...task(id), status: 'doing', ownerClientId: 'device-mine'}),
    clientId: 'device-mine'});
  await mine.api.open('a');
  assert.match(footer(mine.active()), /data-rq-chat/);

  // Preserve legacy visibility for requirements without device ownership.
  const shared = fixture({getTask: async id => ({...task(id), status: 'doing', ownerClientId: ''}),
    clientId: 'device-mine'});
  await shared.api.open('a');
  assert.match(footer(shared.active()), /data-rq-chat/);
});

test('started requirements hide editing even when an older capability snapshot allows it', async () => {
  for (const status of ['doing', 'paused', 'reviewing', 'done', 'cancel']) {
    const f = fixture({getTask: async id => ({...task(id), canEditRequirement: true, readOnly: true, status})});
    await f.api.open('running');
    const footer = f.active().querySelector('.rq-detail-footer').innerHTML;
    assert.doesNotMatch(footer, /data-rq-edit/);
    f.click('[data-rq-edit]');
    assert.doesNotMatch(f.content().innerHTML, /id="rqEditForm"/);
    assert.doesNotMatch(f.active().querySelector('.rq-detail-footer').innerHTML, /type="submit" form="rqEditForm"/);
  }
  // Retain editing before execution starts.
  const before = fixture({getTask: async id => ({...task(id), canEditRequirement: true, status: 'todo'})});
  await before.api.open('editable');
  assert.match(before.active().querySelector('.rq-detail-footer').innerHTML, /data-rq-edit/);
});

test('completed requirement tags remain visible and escaped but cannot be edited', async () => {
  const f = fixture({getTask: async id => ({...task(id), readOnly: true, canEditRequirement: true,
    status: 'done', reviewedAt: 1, tags: ['需求标签', '<img src=x>'], ownerClientId: 'other-device'})});
  await f.api.open('tagged');
  assert.match(f.content().innerHTML, /data-rq-detail-tags/);
  assert.match(f.content().innerHTML, /需求标签/);
  assert.match(f.content().innerHTML, /&lt;img src=x&gt;/);
  f.click('[data-rq-edit]');
  assert.doesNotMatch(f.content().innerHTML, /id="rqTagsInput"/);
});

test('详情隐藏尚未结束流程的归档删除，陈旧点击也不发送操作', async () => {
  for (const archivedAt of [null, 1]) {
    const f = fixture({getTask: async id => ({...task(id), readOnly: true, canEditRequirement: true,
      canArchiveRequirement: true, canDeleteRequirement: true, ownerClientId: 'other-device', archivedAt,
      maintenanceBlocked: true, maintenanceBlockReason: '关联流程尚未结束，请结束流程后再操作'})});
    let mutations = 0;
    f.context.RequirementsBoard.maintain = async () => {mutations++; return true;};
    await f.api.open('blocked');
    const footer = f.active().querySelector('.rq-detail-footer').innerHTML;
    assert.doesNotMatch(footer, /data-rq-delete/);
    if (archivedAt) {
      assert.match(footer, /data-rq-archive disabled/);
      assert.match(footer, /关联流程尚未结束/);
    } else assert.doesNotMatch(footer, /data-rq-archive/);
    f.click('[data-rq-delete]'); f.click('[data-rq-archive]');
    assert.equal(mutations, 0);
  }
});

test('详情归档和删除均经过统一维护入口并完成后更新抽屉', async () => {
  for (const action of ['archive', 'restore', 'delete']) {
    const item = {...task('maintained'), canEditRequirement: true, readOnly: true,
      archivedAt: action === 'restore' ? 1 : null, maintenanceBlocked: false};
    const f = fixture({getTask: async () => ({...item})});
    f.context.RequirementsBoard.maintain = async (id, value) => {
      f.calls.push(['maintain', id, value]); item.archivedAt = value === 'archive' ? 1 : null; return true;
    };
    await f.api.open(item.id);
    f.click(action === 'delete' ? '[data-rq-delete]' : '[data-rq-archive]');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls.find(row => row[0] === 'maintain'), ['maintain', item.id, action]);
    if (action === 'delete') assert.equal(f.active(), undefined);
    else assert.ok(f.active());
  }
});

test('delivery badge distinguishes accepted-but-stalled from fully closed', async () => {
  // Distinguish accepted review from final task closure when completion gates remain unresolved.
  const stalled = fixture({getTask: async id => ({...task(id), status: 'doing',
    reviewedAt: 1730000000000})});
  await stalled.api.open('stalled');
  assert.match(stalled.content().innerHTML, /已验收 · 办结受阻/);

  const closed = fixture({getTask: async id => ({...task(id), status: 'done',
    reviewedAt: 1730000000000})});
  await closed.api.open('closed');
  const closedHtml = closed.content().innerHTML;
  assert.match(closedHtml, /已验收/);
  assert.doesNotMatch(closedHtml, /办结受阻/);
});

test('pending rework feedback is rendered as a visible card', async () => {
  const f = fixture({getTask: async id => ({...task(id), status: 'doing', canContinueExecution: true,
    workRouting: {reworkPending: {feedback: '驳回：地图边界穿帮', error: '这个本地会话已经不在了'}}})});
  await f.api.open('rework');
  const html = f.content().innerHTML;
  assert.match(html, /返修待处理/);
  assert.match(html, /地图边界穿帮/);
  assert.match(html, /这个本地会话已经不在了/);
  assert.match(html, /data-rq-rework>/);
  assert.match(html, /继续修正/);
  assert.doesNotMatch(html, /data-rq-rework-resume|data-rq-rework-new/);
  assert.doesNotMatch(f.active().querySelector('.rq-detail-footer').innerHTML, /data-rq-chat/);
});

test('authorized executor can continue rework from a permitted device', async () => {
  const calls = [];
  const f = fixture({clientId: 'device-other', getTask: async id => ({...task(id), status: 'doing', canContinueExecution: true,
    ownerClientId: 'device-owner', workRouting: {reworkPending: {feedback: '修正文案'}}})});
  f.context.openTaskConversation = (...args) => { calls.push(args); return Promise.resolve(true); };
  await f.api.open('remote-rework');
  f.click('[data-rq-rework]');
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].source, 'rework');
  assert.equal(calls[0][2].forceNew, false);
  assert.equal(calls[0][2].reworkSession, true);
});

test('shared viewers and creators cannot invoke rework through a stale detail button', async () => {
  for (const permission of [false, undefined]) {
    const calls = [];
    const f = fixture({getTask: async id => ({...task(id), status: 'doing', canViewExecution: true,
      canContinueExecution: permission, workRouting: {reworkPending: {feedback: 'Revise the output'}}})});
    f.context.openTaskConversation = (...args) => { calls.push(args); return Promise.resolve(true); };
    await f.api.open('shared-rework');
    assert.doesNotMatch(f.content().innerHTML, /data-rq-rework>/);
    f.click('[data-rq-rework]');
    await new Promise(setImmediate);
    assert.equal(calls.length, 0);
  }
});

test('跨执行会话的同名产物按最新交付批次展示，旧批次进入过程留档', async () => {
  const f = fixture({listAttachments: async () => [
    {id: 'old', filename: '报告.md', role: 'output', sourceRef: 'conversation:old', createdAt: '2026-10-17T10:00:00Z', evidenceMeta: {round: 1, verification: {state: 'passed'}}},
    {id: 'new', filename: '报告.md', role: 'output', sourceRef: 'conversation:new', createdAt: '2026-10-18T10:00:00Z', evidenceMeta: {round: 1, verification: {state: 'passed'}}},
  ]});
  await f.api.open('versioned');
  const html = f.active().querySelector('#rqAttachments').innerHTML;
  const archive = html.indexOf('rq-material-archive');
  assert.ok(archive > 0);
  assert.ok(html.indexOf('data-rq-file-id="new"') < archive);
  assert.ok(html.indexOf('data-rq-file-id="old"') > archive);
});

test('project tasks show awaiting-merge as a legal intermediate state, not stalled', async () => {
  // Waiting for project merge or release is a valid post-review intermediate state.
  const project = fixture({getTask: async id => ({...task(id), status: 'doing',
    projectId: 'proj-1', reviewedAt: 1730000000000})});
  await project.api.open('proj');
  const projHtml = project.content().innerHTML;
  assert.match(projHtml, /已验收 · 待合并/);
  assert.doesNotMatch(projHtml, /办结受阻/);

  // A non-project task unable to close after review is genuinely blocked.
  const local = fixture({getTask: async id => ({...task(id), status: 'doing',
    reviewedAt: 1730000000000})});
  await local.api.open('local');
  assert.match(local.content().innerHTML, /已验收 · 办结受阻/);
});

// Model native select behavior: rebuilding options clears values that no longer exist.
function assigneeSelect(value, ids = [value]) {
  let current = value, available = ids, html = '';
  return {get value() {return current;}, set value(next) {current = available.includes(next) ? next : '';},
    get innerHTML() {return html;}, set innerHTML(next) {html = next; available = [...next.matchAll(/value="([^"]*)"/g)].map(match => match[1]); if (!available.includes(current)) current = available[0] || '';},
    get selectedOptions() {return [{textContent: current === 'sender' ? '原负责人' : '手选成员'}];}};
}
function editForm(f, id, select, values = {}) {
  const form = f.active().querySelector('#rqEditForm');
  form.elements = {title: {value:'Requirement ' + id}, note: {value:'Saved background'},
    kind: {value:'requirement'}, priority: {value:'normal'}, acceptance:{value:''},
    tags: {value:''}, assigneeUserId: select, ...values};
  f.active().children.set('[name="assigneeUserId"]', select);
  return form;
}

test('保存收到单条回执就结束，不等待全量刷新或重新请求详情', async () => {
  const saving = deferred(); let gets = 0, attachments = 0, writes = 0, boardRenders = 0;
  const base = {...task('fast-save'), canEditRequirement:true, requirementVersion:1,
    note:'Saved background', kind:'requirement', priority:'normal', tags:[], acceptanceCriteria:[],
    assigneeUserId:'sender', assigneeName:'原负责人', ownerClientId:'device', ai:{state:'idle',model:'fixture'}};
  const f = fixture({getTask: async () => {gets++; return base;},
    listAttachments: async () => {attachments++; return [];},
    patchTask: async () => {writes++; return saving.promise;}});
  f.context.RequirementsBoard.refresh = () => {assert.fail('保存不得等待全量刷新');};
  f.context.RequirementsBoard.render = () => {boardRenders++;};
  const accepted = [];
  f.context.Store = {acceptTaskSave: value => {
    const merged = TaskSync.mergeSaveReceipt(base, value); accepted.push(merged); return merged;
  }};
  await f.api.open('fast-save');
  f.click('[data-rq-edit]');
  const form = editForm(f, 'fast-save', assigneeSelect('sender'), {title:{value:'Saved title'}});
  f.active().listeners.submit({preventDefault(){}, target:form});
  await new Promise(setImmediate);
  assert.equal(writes, 1);
  assert.match(f.content().innerHTML, /rqEditForm/, '未确认保存时仍保留编辑内容');
  saving.resolve({...base, title:'Saved title', requirementVersion:2, ai:undefined, projectionPending:true});
  await new Promise(setImmediate);
  assert.doesNotMatch(f.content().innerHTML, /rqEditForm/);
  assert.match(f.content().innerHTML, /Saved title/);
  assert.equal(gets, 1); assert.equal(attachments, 1); assert.equal(boardRenders, 1);
  assert.equal(accepted.length, 1);
  assert.deepEqual(accepted[0].ai, {state:'idle',model:'fixture'});
  assert.ok(f.calls.some(row => row[0] === 'notice' && row[1] === '需求已保存'));
});

test('missing directory member remains selected; saving only background does not clear the assignee', async () => {
  const directory = deferred(), writes = [];
  const f = fixture({getTask: async id => ({...task(id), canEditRequirement:true, note:'Saved background',
    kind:'requirement', priority:'normal', tags:[], acceptanceCriteria:[], assigneeUserId:'sender'}),
    listTeammates: () => directory.promise, patchTask: async (id, patch) => {writes.push({id, patch}); return {};}});
  await f.api.open('editable');
  const select = assigneeSelect('sender'), form = editForm(f, 'editable', select);
  f.click('[data-rq-edit]'); directory.resolve({mates:[{id:'other',name:'其他成员'}]});
  await new Promise(setImmediate);
  assert.equal(select.value, 'sender'); assert.match(select.innerHTML, /原负责人/);
  form.elements.note.value = 'Edited background';
  f.active().listeners.submit({preventDefault(){}, target:form}); await new Promise(setImmediate);
  assert.equal(writes.length, 1); assert.equal(writes[0].patch.note, 'Edited background');
  assert.equal(Object.hasOwn(writes[0].patch, 'assigneeUserId'), false);
});

test('late directory retains a user-selected or explicitly cleared assignee', async () => {
  for (const chosen of ['manual', '']) {
    const directory = deferred();
    const f = fixture({getTask: async id => ({...task(id),canEditRequirement:true,assigneeUserId:'sender'}),
      listTeammates: () => directory.promise});
    await f.api.open('a'); const select = assigneeSelect('sender', ['sender','manual','']); editForm(f,'a',select);
    f.click('[data-rq-edit]'); select.value = chosen;
    directory.resolve({mates:[{id:'other',name:'Other'}]}); await new Promise(setImmediate);
    assert.equal(select.value, chosen, 'late directory must keep the actual form selection');
    f.api.close(true);
  }
});

test('late member directory from an old requirement cannot mutate the next editing form', async () => {
  const directory = deferred(); let calls = 0;
  const f = fixture({getTask: async id => ({...task(id),canEditRequirement:true,assigneeUserId:id}),
    listTeammates: () => ++calls === 1 ? directory.promise : new Promise(()=>{})});
  await f.api.open('a'); editForm(f,'a',assigneeSelect('a')); f.click('[data-rq-edit]');
  f.api.close(true); await f.api.open('b');
  const select = assigneeSelect('b'); editForm(f,'b',select); f.click('[data-rq-edit]');
  directory.resolve({mates:[{id:'foreign',name:'Old directory'}]}); await new Promise(setImmediate);
  assert.equal(select.innerHTML, ''); assert.equal(select.value,'b');
});

test('untouched form defaults are not unsaved edits and reverting a draft removes the prompt', async () => {
  const f = fixture({getTask: async id => ({...task(id),canEditRequirement:true,note:'Saved background',assigneeUserId:null})});
  await f.api.open('a'); const form = editForm(f,'a',assigneeSelect(''));
  f.click('[data-rq-edit]'); form.elements.note.value = 'Draft'; form.elements.note.value = 'Saved background';
  f.click('[data-rq-edit-cancel]');
  assert.doesNotMatch(f.content().innerHTML, /rqEditForm/);
  assert.notEqual(f.active().querySelector('[data-rq-confirm]').hidden, false);
});

test('saving reports progress, blocks duplicate submission and closes without discard after success', async () => {
  const pending = deferred(); let writes = 0, reads = 0, refreshes = 0;
  const f = fixture({getTask: async id => {reads++; return {...task(id),canEditRequirement:true};},
    patchTask: () => {writes++; return pending.promise;}});
  f.context.RequirementsBoard.refresh = async () => {refreshes++; await f.api.close();};
  const updates = []; f.context.Store = {applyServerEvent: event => updates.push(event)};
  await f.api.open('a'); const form = editForm(f,'a',assigneeSelect(''));
  f.click('[data-rq-edit]'); form.elements.note.value = 'Changed';
  const drawer = f.active(), submit = () => drawer.listeners.submit({preventDefault(){},target:form});
  submit(); submit();
  assert.equal(writes,1);
  assert.equal(drawer.querySelector('[data-rq-save]').textContent,'正在保存…');
  assert.equal(f.api.close(),false);
  assert.notEqual(drawer.querySelector('[data-rq-confirm]').hidden,false);
  pending.resolve({...task('a'),canEditRequirement:true,note:'Changed',requirementVersion:2});
  await new Promise(setImmediate);
  assert.equal(reads,1); assert.equal(refreshes,0); assert.equal(updates.length,1);
  assert.match(f.content().innerHTML,/Changed/);
  assert.doesNotMatch(f.content().innerHTML,/id="rqEditForm"/);
  assert.equal(f.api.close(),true);
});

test('failed save preserves draft and restores save feedback, including conflict errors', async () => {
  for (const status of [409, 504]) {
    const f = fixture({getTask: async id => ({...task(id),canEditRequirement:true}),
      patchTask: async () => {throw Object.assign(new Error('需求已被同事更新'),{status});}});
    await f.api.open('a'); const form = editForm(f,'a',assigneeSelect(''));
    f.click('[data-rq-edit]'); form.elements.note.value = 'Keep draft';
    f.active().listeners.submit({preventDefault(){},target:form}); await new Promise(setImmediate);
    assert.equal(form.elements.note.value,'Keep draft');
    assert.equal(f.active().querySelector('[data-rq-save]').textContent,'保存修改');
    assert.ok(f.active().querySelector('[data-rq-error]').textContent);
    assert.notEqual(f.active().querySelector('[data-rq-confirm]').hidden,false);
  }
});

test('save response after account change cannot update the store or reopen details', async () => {
  const pending = deferred(), updates = [];
  const f = fixture({getTask: async id => ({...task(id),canEditRequirement:true}),patchTask: () => pending.promise});
  f.context.Store = {applyServerEvent: event => updates.push(event)};
  await f.api.open('a'); const form = editForm(f,'a',assigneeSelect(''));
  f.click('[data-rq-edit]'); form.elements.note.value = 'Old identity';
  f.active().listeners.submit({preventDefault(){},target:form});
  f.events['soduwork-data-scope-changed']();
  pending.resolve({...task('a'),note:'Old identity'}); await new Promise(setImmediate);
  assert.equal(updates.length,0); assert.equal(f.active(),undefined);
});

test('timed-out PATCH is confirmed by exact task read without retrying the write', async () => {
  let reads = 0, writes = 0;
  const confirmed = deferred();
  const f = fixture({getTask: async id => ++reads === 1 ? {...task(id),canEditRequirement:true,requirementVersion:1} : confirmed.promise,
    patchTask: async () => {writes++; throw new Error('请求超时');}});
  await f.api.open('a'); const form = editForm(f,'a',assigneeSelect(''));
  f.click('[data-rq-edit]'); form.elements.note.value='Saved remotely';
  f.active().listeners.submit({preventDefault(){},target:form}); await new Promise(setImmediate);
  assert.equal(f.active().querySelector('[data-rq-save]').textContent,'正在确认保存结果…');
  const update = f.api.refresh('a');
  assert.match(f.content().innerHTML,/id="rqEditForm"/);
  confirmed.resolve({...task('a'),canEditRequirement:true,requirementVersion:2,note:'Saved remotely'});
  await update; await new Promise(setImmediate);
  assert.equal(writes,1); assert.equal(reads,4);
  assert.doesNotMatch(f.content().innerHTML,/id="rqEditForm"/);
  assert.ok(f.calls.some(row=>row[0]==='notice' && row[1]==='需求已保存'));
});

test('late background refresh after an unconfirmed timeout never prompts to discard the draft', async () => {
  const f = fixture({getTask: async id => ({...task(id),canEditRequirement:true,requirementVersion:1}),
    patchTask: async () => {throw new Error('请求超时');}});
  await f.api.open('a'); const form = editForm(f,'a',assigneeSelect(''));
  f.click('[data-rq-edit]'); form.elements.note.value='Keep this draft';
  f.active().listeners.submit({preventDefault(){},target:form}); await new Promise(setImmediate);
  await f.api.refresh('a');
  assert.equal(form.elements.note.value,'Keep this draft');
  assert.notEqual(f.active().querySelector('[data-rq-confirm]').hidden,false);
  assert.equal(f.active().querySelector('[data-rq-save]').textContent,'保存修改');
});

test('background refresh is coalesced and keeps the existing drawer without loading flashes', async () => {
  let reads=0, materialReads=0; const pending=deferred();
  const f=fixture({getTask: async id => ++reads===1 ? task(id) : pending.promise,
    listAttachments: async()=>{materialReads++;return [];}});
  await f.api.open('a'); const drawer=f.active(), content=f.content(); content.scrollTop=150;
  const first=f.api.refresh('a'), second=f.api.refresh('a');
  assert.equal(first,second); assert.equal(reads,2); assert.equal(materialReads,1);
  for (let index=0; index<20; index++) assert.equal(f.api.refresh('a'),first);
  assert.equal(reads,2, 'a burst cannot start parallel detail reads');
  assert.equal(f.active(),drawer); assert.doesNotMatch(content.innerHTML,/正在加载需求/);
  pending.resolve({...task('a'),note:'Updated remotely'}); await first;
  assert.equal(reads,3, 'the burst queues one latest read'); assert.equal(materialReads,2);
  assert.equal(f.active(),drawer); assert.equal(f.roots.length,1);
  assert.equal(content.scrollTop,150); assert.match(content.innerHTML,/Updated remotely/);
  assert.doesNotMatch(content.innerHTML,/正在加载需求/);
});

test('a save receipt invalidates earlier refreshes and preserves newer execution facts', async () => {
  const stale = deferred(); let reads=0;
  const base={...task('saved'),canEditRequirement:true,requirementVersion:1};
  const f=fixture({getTask:async()=>{
    reads++;
    if(reads===1)return base;
    if(reads===2)return stale.promise;
    return {...base,title:'Saved title',status:'doing',canEditRequirement:false,requirementVersion:3};
  },patchTask:async()=>({...base,title:'Saved title',requirementVersion:2})});
  await f.api.open('saved'); const update=f.api.refresh('saved');
  const form=editForm(f,'saved',assigneeSelect('')); f.click('[data-rq-edit]');
  form.elements.title.value='Saved title';
  f.active().listeners.submit({preventDefault(){},target:form}); await new Promise(setImmediate);
  assert.match(f.content().innerHTML,/Saved title/);
  stale.resolve({...base,title:'Stale response'}); await update;
  assert.equal(reads,3);
  assert.match(f.content().innerHTML,/Saved title/);
  assert.doesNotMatch(f.content().innerHTML,/Stale response/);
  assert.match(f.active().querySelector('[data-rq-header-meta]').textContent,/进行中/);
  assert.doesNotMatch(f.active().querySelector('.rq-detail-footer').innerHTML,/data-rq-edit/);
});

test('an older save receipt cannot unlock execution facts already read by the drawer', async () => {
  const pending=deferred();
  let value={...task('receipt-race'),canEditRequirement:true,requirementVersion:1};
  const f=fixture({getTask:async()=>({...value}),patchTask:()=>pending.promise});
  const accepted=[];
  f.context.tasks=[value];
  f.context.Store={acceptTaskSave:receipt=>{accepted.push(receipt);return receipt;}};
  await f.api.open('receipt-race');
  const form=editForm(f,'receipt-race',assigneeSelect('')); f.click('[data-rq-edit]');
  form.elements.note.value='Saved background'; form.elements.title.value='Saved title';
  f.active().listeners.submit({preventDefault(){},target:form});
  value={...value,title:'Saved title',status:'doing',canEditRequirement:false,requirementVersion:3};
  await f.api.refresh('receipt-race');
  pending.resolve({...value,status:'todo',canEditRequirement:true,requirementVersion:2});
  await new Promise(setImmediate);
  assert.match(f.active().querySelector('[data-rq-header-meta]').textContent,/进行中/);
  assert.doesNotMatch(f.active().querySelector('.rq-detail-footer').innerHTML,/data-rq-edit/);
  assert.equal(accepted.length,1); assert.equal(accepted[0].requirementVersion,3);
  assert.equal(accepted[0].canEditRequirement,false);
});

test('background refresh arriving after editing starts cannot replace the form', async()=>{
  let reads=0; const pending=deferred();
  const f=fixture({getTask:async id=>++reads===1?{...task(id),canEditRequirement:true}:pending.promise});
  await f.api.open('a'); const refresh=f.api.refresh('a');
  const form=editForm(f,'a',assigneeSelect('')); f.click('[data-rq-edit]'); form.elements.note.value='Keep draft';
  pending.resolve({...task('a'),note:'Remote value'}); await refresh;
  assert.equal(form.elements.note.value,'Keep draft');
  assert.match(f.content().innerHTML,/id="rqEditForm"/);
  assert.notEqual(f.active().querySelector('[data-rq-confirm]').hidden,false);
});

for (const count of [1,2,3,20]) test('requirement delivery preserves files and adds an archive only above two finals: '+count,async()=>{
  const f=fixture({listAttachments:async()=>[
    ...Array.from({length:count},(_,i)=>({id:'final-'+i,filename:'final-'+i+'.md',role:'output',sourceRef:'conversation:done',createdAt:10,evidenceMeta:{round:2}})),
    {id:'proof',filename:'proof.png',role:'verification',sourceRef:'verification:later',createdAt:20}
  ]});
  await f.api.open('threshold');const html=f.active().querySelector('#rqAttachments').innerHTML;
  assert.equal(html.includes('data-rq-bundle-download'),count>2);
  for (let i=0;i<count;i++) assert.ok(html.includes('data-rq-file-id="final-'+i+'"'));
  assert.ok(html.includes('data-rq-file-id="proof"'));
  assert.ok(!html.includes('历史轮次'));
});

test('stored Runner archives keep the same name as chat and never hide individual deliverables',async()=>{
  const f=fixture({listAttachments:async()=>[
    {id:'archive',filename:'完整产出-fixed.zip',role:'output',category:'primary'},
    {id:'final',filename:'Original-title.md',role:'output',category:'primary'},
    {id:'proof',filename:'verify.json',role:'output',category:'evidence'}
  ]});
  await f.api.open('same-names');
  const html=f.active().querySelector('#rqAttachments').innerHTML;
  assert.match(html,/完整产出-fixed\.zip/);assert.match(html,/Original-title\.md/);
  assert.doesNotMatch(html,/data-rq-bundle-download|Requirement same-names\.zip/);
  const output=html.split('data-rq-material-group="output"')[1];
  assert.doesNotMatch(output,/verify\.json/);
  assert.ok(output.indexOf('完整产出-fixed.zip')<output.indexOf('Original-title.md'));
});

test('archive downloads pin the displayed immutable delivery and reject a changed file set',async()=>{
  const downloads=[];
  let ids=['final-0','final-1'];
  const f=fixture({
    taskTrace:async()=>({delivery:{artifact:{id:'version-2'},manifest:{files:ids.map(id=>({id}))}}}),
    downloadArtifactsZip:async(...args)=>downloads.push(args)
  });
  await f.api.open('pinned');
  f.click('[data-rq-bundle-download]',{rqBundleIds:'["final-0","final-1"]'});
  await new Promise(setImmediate);
  assert.deepEqual(downloads,[['pinned','Requirement pinned','version-2']]);
  ids=['final-0','final-1','new-file'];
  f.click('[data-rq-bundle-download]',{rqBundleIds:'["final-0","final-1"]'});
  await new Promise(setImmediate);
  assert.equal(downloads.length,1);
  assert.match(f.active().querySelector('[data-rq-error]').textContent,/交付版本已变化/);
  assert.equal(f.active().querySelector('[data-rq-error]').hidden,false);
});

test('automatic bundle library actions use the same pinned files without deleting source attachments',async()=>{
  const saved=[];
  const f=fixture({taskTrace:async()=>({delivery:{artifact:{id:'v2'},manifest:{files:[{id:'a'},{id:'b'}]}}}),
    downloadArtifactsZip:async()=>({ok:true})});
  f.context.LibraryTransfer={saveOutput:async(ref,file)=>{saved.push(file);return true;}};
  await f.api.open('bundle');
  f.click('[data-rq-bundle-library]',{rqBundleIds:'["a","b"]'});
  await new Promise(setImmediate);
  assert.equal(saved.length,1); assert.equal(saved[0].artifactVersionId,'v2');
  assert.equal(saved[0].taskId,'bundle'); assert.equal(saved[0].deliveryBundle,true);
  assert.deepEqual(Array.from(saved[0].attachmentIds),['a','b']);
  f.click('[data-rq-bundle-library]',{rqBundleIds:'["old"]'});
  await new Promise(setImmediate);
  assert.equal(saved.length,1);
});
