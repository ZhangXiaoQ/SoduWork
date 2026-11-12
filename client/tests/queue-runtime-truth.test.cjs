const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const sandbox={window:{},document:{activeElement:null}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../components/panels/chat-send-queue.js'),'utf8'),sandbox);
 const entries=[1,2,3,4].map(n=>({taskId:'t'+n,nativeTurn:true,queueState:'doing',task:{id:'t'+n,title:'任务'+n,status:'doing'}}));
 const host={dataset:{},classList:{add(){},toggle(){}}};
 const ctx={_sessionId:'chat',_snap:{status:'idle',execution:{running:false,queue:[],turnQueue:{activeTaskId:'',tasks:[]}}},_localQueue:[],
  _collabEntries:()=>entries,_collabEntryStatus:e=>e.queueState,_collabTasks:new Map(entries.map(e=>[e.taskId,e])),esc:String};
 const queue=sandbox.window.ChatSendQueue.create(ctx);return{ctx,entries,queue,render:()=>{queue._renderQueue({querySelector:()=>host});return host.innerHTML;}};
}
test('four associated business tasks do not become pending turns when runtime is idle',()=>{
 const f=fixture(),html=f.render();assert.doesNotMatch(html,/nqueue-progress|执行中|data-queue-action="start"/);
 assert.doesNotMatch(html,/等待确认|data-queue-row=/);
 assert.equal(f.ctx._collabTasks.size,4);
});
test('single active task overrides stale rows; pending entries are explicitly queued',()=>{
 const f=fixture(),e=f.ctx._snap.execution;e.running=true;e.turnQueue.activeTaskId='t2';
 e.queue=[{id:'pending-3',taskId:'t3',status:'running'},{id:'pending-4',taskId:'t4',status:'running'}];
 const html=f.render();assert.equal((html.match(/class="nqueue-progress"/g)||[]).length,1);
 assert.equal((html.match(/data-queue-state="queued"/g)||[]).length,2);
});
test('waiting approval and failed model never masquerade as running',()=>{
 const f=fixture(),e=f.ctx._snap.execution;e.turnQueue.activeTaskId='t2';f.ctx._snap.status='waiting-user';
 assert.doesNotMatch(f.render(),/nqueue-progress/);assert.match(f.render(),/等待输入/);
 f.ctx._snap.status='unreachable';assert.doesNotMatch(f.render(),/nqueue-progress/);assert.match(f.render(),/执行失败/);
});
test('controller reconnect and authorization waits do not ask for an unrelated chat reply',()=>{
 const f=fixture(),e=f.ctx._snap.execution;e.turnQueue.activeTaskId='t2';f.ctx._snap.status='waiting-user';
 for(const [waitingReason,label] of [['connection','等待连接'],['auth','需要重新登录'],['permission','等待授权'],['stop','停止中']]){
  e.taskExecutions=[{taskId:'t2',status:'waiting',waitingReason}];
  const html=f.render();assert.match(html,new RegExp(label));assert.doesNotMatch(html,/nqueue-progress|等待输入/);
 }
 e.taskExecutions=[];assert.match(f.render(),/等待输入/);
});
test('live completion wins over stale running receipt; other conversation receipts cannot take over',()=>{
 const f=fixture(),e=f.ctx._snap.execution;e.turnQueue.tasks=[{taskId:'t1',status:'completed'}];
 f.entries[0].task.workRouting={conversationTurn:{conversationId:'chat',state:'running'}};
 f.entries[1].task.workRouting={conversationTurn:{conversationId:'another-chat',state:'running'}};
 const html=f.render();assert.doesNotMatch(html,/nqueue-progress/);assert.match(html,/已完成 · 1/);
 assert.doesNotMatch(html,/data-queue-row="task:t1"/);
});
test('failed model offers same-turn recovery instead of skipping to next task',()=>{
 const f=fixture(),e=f.ctx._snap.execution;e.turnQueue.paused=true;e.modelRecovery={id:'retry-1',available:true,taskId:'t1'};
 e.turnQueue.tasks=[{taskId:'t1',status:'failed'}];
 const html=f.render();assert.match(html,/data-queue-action="retry-model"/);assert.doesNotMatch(html,/data-queue-action="resume"/);
});

test('a settled failed request with no queued work never offers Resume queue',()=>{
 const f=fixture(),e=f.ctx._snap.execution;
 e.turnQueue.paused=true;e.turnQueue.reason='图片输入未启用';
 e.turnQueue.failure={queueId:'failed-image',reason:'图片输入未启用'};
 f.ctx._snap.status='unreachable';
 assert.doesNotMatch(f.render(),/nqueue-paused|data-queue-action="resume"/);
 // Completed/failed business associations are not pending native messages.
 e.turnQueue.tasks=[{taskId:'t1',status:'failed'}];
 assert.doesNotMatch(f.render(),/data-queue-action="resume"/);
 e.queue=[{id:'waiting-text',text:'后续消息',submissionId:'next'}];
 assert.match(f.render(),/data-queue-action="resume"/);
 assert.match(f.render(),/后续消息/);
});


test('finished Hub task cannot be resurrected by an older waiting receipt',()=>{
 const f=fixture(),entry=f.entries[0];
 entry.task.status='done';entry.queueState='waiting';
 entry.task.workRouting={conversationTurn:{conversationId:'chat',state:'waiting'}};
 const html=f.render();
 assert.doesNotMatch(html,/data-queue-row="task:t1"/);
 assert.match(html,/已完成 · 1/);
 assert.equal(entry.task.status,'done');
});
test('delivery awaiting acceptance is a result record, never an unsent queue item',()=>{
 const f=fixture(),entry=f.entries[0];
 entry.task.ai={executionState:'done'};entry.queueState='waiting';
 entry.task.workRouting={conversationTurn:{conversationId:'chat',state:'waiting'}};
 const html=f.render();
 assert.doesNotMatch(html,/data-queue-row="task:t1"/);
 assert.match(html,/已完成 · 1/);
 assert.equal(entry.task.status,'doing','display must not accept the business task');
});
test('a retained task association with no active or pending turn does not invent a confirmation',()=>{
 const f=fixture();f.entries[0].queueState='idle';
 const html=f.render();
 assert.doesNotMatch(html,/data-queue-row=|等待确认|已完成 ·/);
 assert.equal(f.ctx._collabTasks.size,4,'association and task history remain available');
});
test('a stored running receipt cannot regress a completed task-specific controller receipt',()=>{
 const f=fixture(),entry=f.entries[0];entry.queueState='completed';
 entry.task.workRouting={conversationTurn:{conversationId:'chat',state:'running'}};
 const html=f.render();assert.doesNotMatch(html,/data-queue-row="task:t1"/);assert.match(html,/已完成 · 1/);
});
test('task preparation and real requests for user input remain visible',()=>{
 const f=fixture();f.ctx._collabStarts=new Set(['t1']);f.entries[1].queueState='waiting-user';
 const html=f.render();assert.match(html,/data-queue-row="task:t1"[^>]*data-queue-state="starting"/);
 assert.match(html,/data-queue-row="task:t2"[^>]*data-queue-state="waiting/);
 assert.doesNotMatch(html,/data-queue-row="task:t3"/);
});
test('completed task then two messages: only the second is pending and it starts once after the first',async()=>{
 const {createTurnQueue}=require('../main/pi-session/turn-queue');
 const q=createTurnQueue(),f=fixture(),seen=[];
 q.add({text:'Make the website',options:{taskId:'t1'}});
 await q.run(q.take(),async()=>({ok:true}));
 const render=()=>{
  f.ctx._snap.execution={running:!!q.active(),queue:q.view(),turnQueue:q.state()};return f.render();
 };
 q.add({text:'First refinement'});let finish;
 const first=q.run(q.take(),()=>{seen.push('first');return new Promise(r=>{finish=r})});
 q.add({text:'Second follow-up'});
 let html=render();assert.equal((html.match(/data-queue-row=/g)||[]).length,1);
 assert.match(html,/Second follow-up/);assert.doesNotMatch(html,/data-queue-row="task:t1"/);
 assert.deepEqual(seen,['first']);finish({ok:true});await first;
 await q.run(q.take(),async()=>{seen.push('second');assert.doesNotMatch(render(),/data-queue-row=/);return{ok:true}});
 assert.doesNotMatch(render(),/data-queue-row=/);assert.deepEqual(seen,['first','second']);assert.equal(q.size(),0);
});
test('a manually stopped task is history rather than a pending queue row',()=>{
 const f=fixture(),e=f.ctx._snap.execution;
 e.turnQueue.tasks=[{taskId:'t1',status:'stopped'}];
 f.entries[0].queueState='stopped';
 const html=f.render();
 assert.doesNotMatch(html,/data-queue-row="task:t1"/);
 assert.doesNotMatch(html,/data-queue-action="resume"/);
});

test('local send placeholders stay hidden until the runtime confirms a queued turn',()=>{
 const f=fixture();
 f.ctx._localQueue=[{id:'local-1',text:'Immediate',visible:false}];
 assert.deepEqual(f.queue._queueRows(),[]);
 f.ctx._localQueue[0].visible=true;
 assert.equal(JSON.stringify(f.queue._queueRows()),JSON.stringify([{id:'local-1',text:'Immediate',attachments:[],taskId:'',taskTitle:'',position:1,local:true}]));
});

test('验收会话自动展开已完成需求记录供核对',()=>{
 const f=fixture();
 f.ctx._sessionOptions={acceptanceSession:true};
 f.entries[0].queueState='completed';
 f.entries[0].task.status='done';
 const html=f.render();
 assert.match(html,/nqueue-history/);
 assert.match(html,/任务1/);
 assert.match(html,/data-task-receipt="t1"/);
});
