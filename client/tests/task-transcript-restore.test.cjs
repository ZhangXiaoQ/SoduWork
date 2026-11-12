'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(read) {
  const timers = [], calls = [], window = { ChatTaskStart: { create: () => ({}) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,
    '../components/panels/chat-task-controller.js'), 'utf8'), {
    window, get SoduWorkAPI() { return window.SoduWorkAPI; },
    setTimeout: fn => { timers.push(fn); return timers.length; },
  });
  window.SoduWorkAPI = { aiSession: async (...args) => { calls.push(args); return read(...args); } };
  const entry = { taskId: 'task', task: {}, controlledTurn: true, nativeTurn: true,
    queueState: 'completed', trace: { execution: { sessions: [{ ref: 'run', seq: 3,
      items: [{ seq: 3, kind: 'say', text: 'A clipped tail is not history' }] }] } } };
  const ctx = { _sessionId: 'chat', _viewEpoch: 1, _ref: 'native', _sessionOptions: {}, _snap: { messages: [] },
    _collabTasks: new Map([['task', entry]]), _render: () => {} };
  const controller = window.ChatTaskController.create(ctx);
  return { entry, ctx, calls, timers, controller, window,
    restore: guard => controller._restoreTaskTranscript(entry, guard || (() => true)) };
}

test('completed controlled history drains exact-ref pages instead of the trace tail', async () => {
  const f = fixture(async (task, since, ref) => ({ ok:true, ref, last:since + 1, seq:3,
    status:'done', items:[{seq:since + 1, kind:'say', streamId:'a', delta:true, text:'part'}] }));
  await f.restore();
  assert.deepEqual(f.calls, [['task',0,'run'], ['task',1,'run'], ['task',2,'run']]);
  assert.deepEqual(Array.from(f.entry.transcripts.get('run').items, row => row.seq), [1,2,3]);
  assert.equal(f.entry.transcriptPending, false);
  await f.restore(); assert.equal(f.calls.length, 3, 'completed history reuses its exact-ref cursor');
});

test('read budgets yield and resume without losing history or repeating old pages', async () => {
  const f = fixture(async (task,since,ref) => ({ ok:true, ref, last:since+1, seq:10,
    items:[{seq:since+1,kind:'say',text:'x'}], status:'done' }));
  f.entry.trace.execution.sessions[0].seq = 10;
  await f.restore(); assert.equal(f.calls.length,8); assert.equal(f.entry.transcriptPending,true);
  assert.equal(f.timers.length,1);
  await f.restore(); assert.equal(f.calls.length,10); assert.equal(f.entry.transcriptPending,false);
  assert.equal(f.entry.transcripts.get('run').items.length,10);
});

test('failed or nonadvancing reads remain retryable without an unbounded request loop', async () => {
  for (const reply of [{ok:false,httpStatus:503}, {ok:true,ref:'run',last:0,seq:3,items:[]}]) {
    const f=fixture(async()=>reply);
    await f.restore(); assert.equal(f.calls.length,1); assert.equal(f.entry.transcriptPending,true);
    await f.restore(); assert.equal(f.calls.length,2); assert.equal(f.entry.transcripts.get('run').items.length,0);
  }
});

test('late navigation responses and foreign execution content cannot enter a transcript', async () => {
  let done, current=true;
  const f=fixture(()=>new Promise(resolve=>{done=resolve;}));
  const pending=f.restore(()=>current);current=false;
  done({ok:true,ref:'run',last:3,seq:3,items:[{seq:3,text:'late'}]});
  await pending;assert.equal(f.entry.transcripts.get('run').items.length,0);
  for (const fields of [{ref:'other'}, {ref:'run',conversationId:'other'}]) {
    const foreign=fixture(async()=>({ok:true,last:3,seq:3,items:[{seq:3,text:'foreign'}],...fields}));
    await foreign.restore();assert.equal(foreign.entry.transcripts.get('run').items.length,0);
  }
  const scoped=fixture(async()=>({ok:true,ref:'run',last:3,seq:3,items:[
    {seq:1,text:'foreign',scope:{conversationId:'other'}}, {seq:2,text:'owned',conversationId:'chat'}]}));
  await scoped.restore();assert.deepEqual(Array.from(scoped.entry.transcripts.get('run').items,row=>row.text),['owned']);
});

test('active native streams and another conversation never trigger fallback replay', async () => {
  for(const change of [f=>{f.entry.executionElsewhere=true;},
    f=>{f.entry.controlledExecution={sameMessageStream:true};},
    f=>{f.ctx._snap.messages=[{taskId:'task',taskOutputKey:'saved-answer'}];}]) {
    const f=fixture(()=>assert.fail('unnecessary history read'));change(f);await f.restore();
    assert.equal(f.calls.length,0);
  }
});

test('workflow and retry runs keep independent cursors and preserve previous output', async () => {
  const f=fixture(async(task,since,ref)=>({ok:true,ref,last:1,seq:1,status:'done',items:[{seq:1,text:ref}]}));
  f.entry.trace.execution.sessions=[{ref:'first',seq:1},{ref:'second',seq:1}];
  await f.restore();
  assert.deepEqual(f.calls,[['task',0,'first'],['task',0,'second']]);
  assert.equal(f.entry.transcripts.get('first').items[0].text,'first');
  assert.equal(f.entry.transcripts.get('second').items[0].text,'second');
});

test('task metadata restoration observes account and navigation guards before reading bodies', async () => {
  let resolveTrace, owner='a';
  const f=fixture(()=>assert.fail('stale body read'));
  f.window.SoduWorkAPI.taskStorageKey=()=>owner;
  f.window.SoduWorkAPI.getTask=async()=>({id:'task',title:'Fixture',
    workRouting:{conversationTurn:{conversationId:'chat',executor:'dispatch',state:'completed'}}});
  f.window.SoduWorkAPI.taskTrace=()=>new Promise(resolve=>{resolveTrace=resolve;});
  const pending=f.controller._loadCollabTask('task');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof resolveTrace,'function');owner='b';
  resolveTrace(f.entry.trace);await pending;assert.equal(f.calls.length,0);
});
