'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const window = {};
  window.window = window;
  window.document = { createElement: tag => ({ tagName: tag, dataset: {} }) };
  window.Event = class { constructor(type, options) { this.type = type; this.bubbles = options.bubbles; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,
    '../components/panels/chat-acceptance-results.js'), 'utf8'), window);
  const ctx = { _snap: {}, _sessionOptions: {}, _loadCollabTask: async () => {}, esc: String };
  let invalidations = 0;
  const create = () => window.ChatAcceptanceResults.create(ctx, {
    rich: String, render() {}, invalidate() { invalidations++; },
  });
  return { window, ctx, create, invalidations: () => invalidations };
}

test('another reviewer decision never becomes an executor operation receipt', () => {
  const f = fixture();
  f.window.__teamCap = {meId:'executor'};
  f.window.TaskTraceApproval = {html:() => ''};
  const entry = {taskId:'task',task:{canReview:false,createdBy:'reviewer'},trace:{approvals:[
    {id:'review',action:'review',status:'approved',createdAt:20,
      decisions:[{userId:'reviewer',decision:'approve',note:'Verified',at:30}]},
  ]}};
  const helper = f.create(), messages = [{role:'assistant',sentAt:10}];
  assert.equal(helper.resultsHtml(entry), '');
  assert.equal(helper.timeline([entry], messages).length, 0);
  helper.reset();
  assert.equal(helper.resultsHtml(entry), '', 'reopening the executor session must not create a receipt');
  f.window.__teamCap = {meId:'reviewer'};
  assert.match(helper.resultsHtml(entry), /已确认验收/);
  assert.match(helper.resultsHtml(entry), /Verified/);
  assert.equal(helper.timeline([entry], messages).length, 1);
  f.window.__teamCap = {};
  helper.reset();
  assert.equal(helper.resultsHtml(entry), '', 'unknown identity must not claim another person\'s decision');
});

test('each approval retains its own position through decisions, follow-ups and reopening', () => {
  const f = fixture();
  f.window.TaskTraceApproval = { html: (_rows, _opts, id) => '<button>' + id + '</button>' };
  f.ctx._collabEntryStatus = () => 'completed';
  const message = sentAt => ({ role: 'assistant', sentAt });
  f.ctx._snap = { messages: [message(10), message(20)] };
  const entry = { taskId: 't', task: { title: 'Result' }, trace: { approvals: [
    { id: 'a', action: 'review', status: 'pending', createdAt: 25 },
  ] } };
  const helper = f.create();
  assert.equal(helper.timeline([entry], f.ctx._snap.messages)[0].index, 2);
  entry.trace.approvals[0].status = 'rejected';
  entry.trace.approvals[0].myDecision = {decision:'reject'};
  f.ctx._snap.messages.push(message(30), message(40));
  entry.trace.approvals.push({ id: 'b', action: 'review', status: 'rejected', createdAt: 45, myDecision:{decision:'reject'} });
  assert.deepEqual(Array.from(helper.timeline([entry], f.ctx._snap.messages), row => row.index), [2, 4]);
  f.ctx._snap.messages.push(message(50), message(60));
  assert.deepEqual(Array.from(helper.timeline([entry], f.ctx._snap.messages), row => row.index), [2, 4]);
  helper.reset();
  assert.deepEqual(Array.from(helper.timeline([entry], f.ctx._snap.messages), row => row.index), [2, 4]);
  assert.equal(helper.timeline([{ ...entry, executionElsewhere: true }], f.ctx._snap.messages).length, 0);
});

test('approval positions respect native and renderer history windows and untimed live snapshots', () => {
  const f = fixture();
  f.window.TaskTraceApproval = { html: () => 'Pending' };
  f.ctx._collabEntryStatus = () => 'completed';
  const entry = { taskId: 't', task: {}, trace: { approvals: [
    { id: 'a', action: 'review', status: 'approved', createdAt: 25, myDecision:{decision:'approve'} },
  ] } };
  const helper = f.create();
  assert.equal(helper.timeline([entry], [])[0].index, 0);
  f.ctx._snap = { history: { messageStart: 4, messageIndices: [8, 10] } };
  assert.equal(helper.timeline([entry], [{ sentAt: 50 }, { sentAt: 60 }]).length, 0);
  f.ctx._snap.history = { messageStart: 0, messageIndices: [0, 2, 4, 6, 8, 10] };
  const messages = [10, 20, 30, 40, 50, 60].map(sentAt => ({ sentAt }));
  assert.equal(helper.timeline([entry], messages)[0].index, 2);
  assert.equal(helper.timeline([entry], messages, 3).length, 0);
  helper.reset();
  delete entry.trace.approvals[0].createdAt;
  f.ctx._snap.history = {};
  assert.equal(helper.timeline([entry], [{}, {}])[0].index, 2);
  assert.equal(helper.timeline([entry], [{}, {}, {}, {}])[0].index, 2);
});

test('direct and requirement-pool approvals follow a completed task output when the gate predates it', () => {
  const f = fixture();
  f.window.__teamCap = { meId: 'self' };
  f.window.TaskTraceApproval = { html: (_rows, _opts, id) => '<button>' + id + '</button>' };
  f.ctx._collabEntryStatus = () => 'completed';
  const entries = [
    { taskId: 'direct-task', nativeTurn: true, task: { createdBy: 'self' }, trace: { approvals: [
      { id: 'direct:direct-task', action: 'review', status: 'pending', createdAt: 10 },
    ] } },
    { taskId: 'pool-task', controlledTurn: true, task: { createdBy: 'self', assigneeUserId: 'self' }, trace: { approvals: [
      { id: 'pool-review', action: 'review', status: 'pending', createdAt: 25, assignment: { userId: 'self' } },
    ] } },
  ];
  const messages = [
    { role: 'user', sentAt: 5 },
    { role: 'assistant', taskId: 'direct-task', taskOutputKey: 'task:direct:result', done: true, sentAt: 20 },
    { role: 'user', sentAt: 25 },
    { role: 'assistant', taskId: 'pool-task', taskOutputKey: 'task:pool:result', done: true, sentAt: 40 },
  ];
  const helper = f.create();
  assert.deepEqual(Array.from(helper.timeline(entries, messages), row => row.index), [2, 4]);
});

test('a pending approval anchor moves after a task output that arrives during streaming', () => {
  const f = fixture();
  f.window.__teamCap = { meId: 'self' };
  f.window.TaskTraceApproval = { html: () => 'Pending' };
  f.ctx._collabEntryStatus = () => 'completed';
  const entry = { taskId: 'task', task: { createdBy: 'self' }, trace: { approvals: [
    { id: 'direct:task', action: 'review', status: 'pending', createdAt: 10 },
  ] } };
  const messages = [{ role: 'user', sentAt: 5 }];
  const helper = f.create();
  assert.equal(helper.timeline([entry], messages)[0].index, 1);
  messages.push({ role: 'assistant', taskId: 'task', taskOutputKey: 'task:result', done: true, sentAt: 20 });
  assert.equal(helper.timeline([entry], messages)[0].index, 2);
});

test('a review assigned to another executor keeps timestamp ordering', () => {
  const f = fixture();
  f.window.__teamCap = { meId: 'reviewer' };
  f.window.TaskTraceApproval = { html: () => 'Pending' };
  f.ctx._collabEntryStatus = () => 'completed';
  const entry = { taskId: 'task', task: { createdBy: 'reviewer', assigneeUserId: 'executor' }, trace: { approvals: [
    { id: 'review', action: 'review', status: 'pending', createdAt: 10 },
  ] } };
  const messages = [
    { role: 'user', sentAt: 5 },
    { role: 'assistant', taskId: 'task', taskOutputKey: 'task:result', done: true, sentAt: 20 },
  ];
  assert.equal(f.create().timeline([entry], messages)[0].index, 1);
});

test('an unassigned pool review does not infer the creator as reviewer', () => {
  const f = fixture();
  f.window.__teamCap = { meId: 'self' };
  f.window.TaskTraceApproval = { html: () => 'Pending' };
  f.ctx._collabEntryStatus = () => 'completed';
  const entry = { taskId: 'pool-task', task: { createdBy: 'self', assigneeUserId: 'self' }, trace: { approvals: [
    { id: 'pool-review', action: 'review', status: 'pending', createdAt: 10 },
  ] } };
  const messages = [
    { role: 'user', sentAt: 5 },
    { role: 'assistant', taskId: 'pool-task', taskOutputKey: 'task:result', done: true, sentAt: 20 },
  ];
  assert.equal(f.create().timeline([entry], messages)[0].index, 1);
});

test('an approval slot follows a stable projected message key when native indices change', () => {
  const f = fixture();
  f.window.TaskTraceApproval = { html: () => '' };
  const entry = { taskId: 't', task: {}, trace: { approvals: [{ id: 'a', action: 'review', status: 'approved', myDecision:{decision:'approve'} }] } };
  const helper = f.create();
  assert.equal(helper.timeline([entry], [{ taskOutputKey: 'run:result' }])[0].index, 1);
  assert.equal(helper.timeline([entry], [{}, {}, { taskOutputKey: 'run:result' }, {}])[0].index, 3);
});

test('approvals sharing a message boundary keep chronological order as their statuses change', () => {
  const f = fixture();
  f.window.TaskTraceApproval = { html: () => 'Pending' };
  f.ctx._collabEntryStatus = () => 'completed';
  const entry = { taskId: 't', task: {}, trace: { approvals: [
    { id: 'new', action: 'review', status: 'pending', createdAt: 40 },
    { id: 'old', action: 'review', status: 'rejected', createdAt: 30, myDecision:{decision:'reject'} },
  ] } };
  const helper = f.create(), messages = [{ sentAt: 20 }, { sentAt: 50 }];
  const ids = () => Array.from(helper.timeline([entry], messages), row => JSON.parse(row.key)[1]);
  assert.deepEqual(ids(), ['old', 'new']);
  entry.trace.approvals[0].status = 'approved';
  entry.trace.approvals[0].myDecision = {decision:'approve'};
  assert.deepEqual(ids(), ['old', 'new']);
  helper.reset();
  delete entry.trace.approvals[0].createdAt;
  entry.trace.approvals[0].resolvedAt = 40;
  assert.deepEqual(ids(), ['old', 'new']);
});

test('analysis result card recognizes a list-prefixed protocol heading', () => {
  const f = fixture();
  const html = f.create().html('- ### 【验收分析结果】\n\n建议结果：通过', 'analysis-1');
  assert.match(html, /nacceptance-result is-analysis/);
  assert.doesNotMatch(html, /- ### 【验收分析结果】/);
  assert.match(html, /建议结果：通过/);
});

test('review cards hide internal attachment metadata without changing source evidence or file links', () => {
  const f = fixture();
  const id = '739efe68-1a27-59fd-a2a5-b466f33cdf51';
  const link = '[初冬短文.md](soduwork://attachment/' + id + ')';
  for (const kind of ['验收分析结果', '验收确认卡', '验收退回卡']) {
    const source = '【' + kind + '】\n实际读取 ' + link + '（附件 ID: ' + id + '，1866 字节）全文。\n' +
      '- criterion-1：通过；' + link + ' (Attachment ID: ' + id + ')\n' +
      '业务编号：order-123，校验值：abc123。\n`(附件 ID: example-in-code)`';
    const html = f.create().html(source, '1:0');
    assert.ok(html.includes(link));
    assert.match(html, /（1866 字节）/);
    assert.match(html, /验收标准 1：通过/);
    assert.doesNotMatch(html, /附件 ID: 739|Attachment ID:|criterion-1|\(\s*\)/);
    assert.match(html, /业务编号：order-123/);
    assert.match(html, /`\(附件 ID: example-in-code\)`/);
    assert.ok(source.includes('附件 ID: ' + id), 'stored source text is not rewritten');
  }
});

test('supplemental analysis preserves the draft and uses a text node without submitting work', () => {
  const f = fixture();
  let sends = 0, listener, bindings = 0, inputEvent, focused = false;
  const prompt = '核对 <img src=x onerror=alert(1)> 的原始文字';
  const input = { value: '已有草稿', dispatchEvent(event) { inputEvent = event; }, focus() { focused = true; } };
  const actions = { children: [], replaceChildren(...nodes) { this.children = nodes; },
    set innerHTML(_) { throw Error('验收提示必须使用 DOM 文本'); } };
  f.ctx._mount = () => ({ querySelector: selector => selector === '#nchatInput' ? input : null });
  f.ctx._send = () => { sends++; };
  f.window.SoduWorkAPI = { decideApproval() { sends++; } };
  const card = Object.assign(actions, {
    getAttribute(name) { return name === 'data-acceptance-result-task' ? 'task-1' : 'review-1'; },
    querySelector(selector) {
      if (selector === '[data-acceptance-result-analysis]') return { value: prompt };
      return null; // querySelector searches descendants; this card is the actions container itself.
    },
  });
  const button = { closest: () => card, getAttribute: () => 'analyze' };
  const list = { dataset: {}, addEventListener(_name, callback) { listener = callback; bindings++; } };
  const helper = f.create(); helper.bind(list); helper.bind(list);
  listener({ target: { closest: () => button }, preventDefault() {} });
  assert.equal(bindings, 1);
  assert.equal(input.value, '已有草稿\n\n请补充验收分析：\n' + prompt);
  assert.equal(inputEvent.type, 'input'); assert.equal(inputEvent.bubbles, true);
  assert.equal(focused, true); assert.equal(sends, 0);
  assert.equal(actions.children.length, 1);
  assert.equal(actions.children[0].tagName, 'p');
  assert.equal(actions.children[0].className, 'nacceptance-result-followup');
  assert.equal(actions.children[0].textContent, '已填入对话框，请按需选择插件后发送。');
});

test('acceptance handoff state belongs to its renderer and resets with that conversation', () => {
  const f = fixture(); let options;
  f.window.TaskTraceApproval = { bind(_root, state) { options = state.opts; } };
  const entry = { taskId: 'task-1', task: {}, trace: { approvals: [{ id: 'review-1', status: 'pending' }] } };
  const first = f.create(), second = f.create();
  first.bindApproval({}, 'task-1', entry);
  options.onAcceptanceOpened('review-1');
  assert.equal(first.pendingApprovals(entry).length, 0);
  assert.equal(second.pendingApprovals(entry).length, 1);
  assert.equal(f.invalidations(), 1);
  first.reset();
  assert.equal(first.pendingApprovals(entry).length, 1);
});

test('resolved and historical analysis cards stay expanded and cannot acquire a new review round', () => {
  const f = fixture();
  const analysis = '【验收分析结果】\nThe revised HTML meets the criteria.';
  f.ctx._sessionOptions.taskRef = 'task-1';
  f.ctx._snap.messages = [{role:'user',sentAt:20},{role:'assistant',sentAt:30}];
  f.ctx._collaborationTask = {id:'task-1',status:'doing',canReview:true};
  const review = {id:'review-1',action:'review',status:'pending',createdAt:10,artifactVersionId:'v1'};
  f.ctx._collaborationTrace = {approvals:[review]};
  const helper = f.create();
  assert.match(helper.html(analysis,'1:0'),/data-acceptance-result-action="reject"/);
  review.status = 'rejected';
  assert.match(helper.html(analysis,'1:0'),/^<section[^>]*>/);
  assert.doesNotMatch(helper.html(analysis,'1:0'),/data-acceptance-result-action|<details/);
  f.ctx._collaborationTrace.approvals = [{...review,id:'review-2',status:'pending',artifactVersionId:'v2',createdAt:40}];
  assert.doesNotMatch(helper.html(analysis,'1:0'),/data-acceptance-result-action/);
  helper.reset();
  assert.doesNotMatch(helper.html(analysis,'1:0'),/data-acceptance-result-action/,'reopening must not revive older analysis');
  f.ctx._snap.messages.push({role:'user',sentAt:50},{role:'assistant',sentAt:60});
  assert.doesNotMatch(helper.html(analysis,'1:0'),/data-acceptance-result-action/);
  assert.match(helper.html(analysis,'3:0'),/data-acceptance-result-action="approve"/);
  f.ctx._collaborationTask.reviewedAt = 70;
  assert.doesNotMatch(helper.html(analysis,'3:0'),/data-acceptance-result-action/);
});

test('chat approval receipts replace controls before refresh and survive a new review round', () => {
  const f = fixture(); let options;
  f.window.TaskTraceApproval = { bind(_root, state) { options = state.opts; } };
  const entry = {taskId:'task-1',task:{title:'Delivery'},trace:{approvals:[{id:'r1',action:'review',status:'pending'}]}};
  const helper = f.create();
  helper.bindApproval({},entry.taskId,entry);
  const closed = options.onAcceptanceClosed({getAttribute:()=> 'r1'}, {decision:'approve',status:'pending',note:'Checked'});
  assert.equal(closed,true);
  assert.equal(helper.pendingApprovals(entry).length,0,'stale pending trace cannot revive submitted controls');
  let html = helper.resultsHtml(entry);
  assert.match(html,/操作结果/); assert.match(html,/等待其他审批人/); assert.match(html,/Checked/);
  assert.doesNotMatch(html,/<details|<button|<textarea|<input/);
  entry.trace.approvals[0].status='approved';
  html = helper.resultsHtml(entry);
  assert.match(html,/已确认验收/); assert.doesNotMatch(html,/等待其他审批人/);
  assert.match(html,/Checked/,'a list refresh without notes preserves the successful local receipt');
  entry.trace.approvals.push({id:'r2',action:'review',status:'pending'});
  assert.deepEqual(Array.from(helper.pendingApprovals(entry),row=>row.id),['r2']);
  entry.trace.approvals[0].myDecision={decision:'approve'};
  helper.reset();
  assert.match(helper.resultsHtml(entry),/已确认验收/,'authoritative resolved reviews remain readable after reopen');
  assert.equal(options.onAcceptanceClosed({getAttribute:()=> 'r2'},{decision:'reject'}),false,'old callbacks cannot change another conversation');
});

for (const status of ['approved', 'rejected']) test(`a ${status} Hub receipt survives a delayed pending trace`, () => {
  const f = fixture(); let options;
  f.window.TaskTraceApproval = {bind(_root, state) { options = state.opts; }};
  const approval = {id:'review', action:'review', status:'pending'};
  const entry = {taskId:'task', task:{title:'Delivery'}, trace:{approvals:[approval]}};
  const helper = f.create();
  helper.bindApproval({}, entry.taskId, entry);
  assert.equal(options.onAcceptanceClosed({getAttribute:()=>approval.id}, {
    decision:status === 'approved' ? 'approve' : 'reject', status, note:'Recorded by Hub',
  }), true);
  for (const delayedStatus of ['pending', undefined]) {
    approval.status = delayedStatus;
    const html = helper.resultsHtml(entry);
    assert.match(html, status === 'approved' ? /已确认验收/ : /已退回修改/);
    assert.doesNotMatch(html, /等待其他审批人|<button|<textarea|<input/);
    assert.equal(approval.status, delayedStatus, 'presentation must not rewrite the Hub snapshot');
  }
  entry.trace.approvals.push({id:'next-review', action:'review', status:'pending'});
  assert.deepEqual(Array.from(helper.pendingApprovals(entry), row=>row.id), ['next-review']);
});

test('generic workflow approvals retain their existing dismissal behavior', () => {
  const f=fixture(); let options;
  f.window.TaskTraceApproval={bind(_root,state){options=state.opts;}};
  const entry={taskId:'t',task:{},trace:{approvals:[{id:'gate',action:'deploy',status:'pending'}]}};
  const helper=f.create(); helper.bindApproval({},'t',entry);
  assert.equal(options.onAcceptanceClosed({getAttribute:()=> 'gate'},{decision:'approve'}),false);
  assert.equal(helper.resultsHtml(entry),'');
});

test('opening analysis leaves a receipt without disabling the resulting analysis decision', () => {
  const f = fixture(); let options;
  f.window.TaskTraceApproval={bind(_root,state){options=state.opts;}};
  const entry={taskId:'t',task:{status:'doing',canReview:true},trace:{approvals:[{id:'r',action:'review',status:'pending'}]}};
  f.ctx._sessionOptions={taskRef:'t'}; f.ctx._snap.messages=[{role:'user'},{role:'assistant'}];
  f.ctx._collabTasks=new Map([['t',entry]]);
  const helper=f.create(); helper.bindApproval({},'t',entry);
  options.onAcceptanceOpened('r','manual');
  assert.match(helper.resultsHtml(entry),/已转入会话分析/);
  assert.equal(helper.pendingApprovals(entry).length,0);
  assert.match(helper.html('【验收分析结果】\nChecked','1:0'),/data-acceptance-result-action="approve"/);
});

for (const decision of ['approve','reject']) test(`analysis ${decision} becomes immutable even if task refresh fails`, async () => {
  const f=fixture(); let listener, resolveDecision, calls=0;
  f.ctx._sessionOptions={taskRef:'t',approvalId:'r',acceptanceExecutionSession:true};
  f.ctx._snap.messages=[{role:'user'},{role:'assistant'}];
  f.ctx._collaborationTask={id:'t',status:'doing',canReview:true};
  f.ctx._collaborationTrace={approvals:[{id:'r',action:'review',status:'pending'}]};
  f.ctx._loadCollabTask=async()=>{throw Error('offline');};
  f.window.SoduWorkAPI={decideApproval:()=>{calls++;return new Promise(resolve=>{resolveDecision=resolve;});}};
  const helper=f.create(), text='【验收分析结果】\nVerified content';
  assert.match(helper.html(text,'42:0',1),/data-acceptance-result-action/);
  const controls=[{disabled:false}];
  const attributes={'data-acceptance-result-task':'t','data-acceptance-result-approval':'r',
    'data-acceptance-result-key':'t:r:analysis:42:0','data-acceptance-message-key':'42:0'};
  const card={getAttribute:name=>attributes[name],setAttribute(){},removeAttribute(){},
    querySelector:s=>s==='[data-acceptance-result-note]'?{value:'Review note'}:null,
    querySelectorAll:()=>controls,replaceChildren(...nodes){this.children=nodes;}};
  const button={closest:()=>card,getAttribute:()=>decision};
  helper.bind({dataset:{},addEventListener(_type,fn){listener=fn;}});
  const click=()=>listener({target:{closest:()=>button},preventDefault(){}});
  click(); click(); assert.equal(calls,1,'in-flight operations cannot submit twice');
  resolveDecision({ok:true,request:{status:decision==='approve'?'approved':'rejected'}});
  await new Promise(resolve=>setImmediate(resolve));
  const html=helper.html(text,'42:0',1);
  assert.match(html,/Verified content/); assert.match(html,/Review note/); assert.match(html,/操作结果/);
  assert.doesNotMatch(html,/<details|<button|<textarea|<input/);
  assert.equal(f.ctx._sessionOptions.acceptanceExecutionSession,false);
  click(); assert.equal(calls,1);
  f.ctx._snap.messages.unshift({role:'user'},{role:'assistant'});
  assert.doesNotMatch(helper.html(text,'42:0',3),/data-acceptance-result-action/,'projected history indices do not change the receipt identity');
  f.ctx._snap.messages.push({role:'assistant'});
  assert.doesNotMatch(helper.html(text,'44:0',4),/data-acceptance-result-action/,'the same submitted approval cannot be reused by a new result');
});

test('a stale acceptance session cannot apply its analysis to a different approval', () => {
  const f = fixture();
  f.ctx._sessionOptions = {taskRef:'task-1',approvalId:'old-review'};
  f.ctx._snap.messages = [{role:'user'},{role:'assistant'}];
  f.ctx._collaborationTrace = {approvals:[{id:'new-review',action:'review',status:'pending'}]};
  assert.doesNotMatch(f.create().html('【验收分析结果】\nOld conclusion','1:0'),/data-acceptance-result-action/);
});
