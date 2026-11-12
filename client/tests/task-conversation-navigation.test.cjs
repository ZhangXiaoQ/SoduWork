const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../core/task-conversation-navigation.js'),'utf8');
function fixture(extra={}) {
  const calls=[], notices=[], listeners={};
  const window={__deskPanel:'workspace',SoduWorkAPI:{getTask:async id=>({id,workRouting:{conversationTurn:{conversationId:'original'}}})},
    addEventListener:(name,fn)=>{listeners[name]=fn;},
    WorkspaceHost:{open:async(view,payload)=>{calls.push({view,payload});return true;}},petSay:m=>notices.push(m),...extra};
  vm.runInNewContext(source,{window});return {api:window.TaskConversationNavigation,calls,notices,listeners};
}

function remoteRequirement() {
 return {id:'remote-req',kind:'requirement',status:'done',workRouting:{executionContext:{
  location:{mode:'remote'},runner:{runnerId:'isolated-cloud'}}}};
}

test('fresh navigation reuses only the persisted matching review and approval',async()=>{
 const rows=[
  {id:'execution',taskId:'req',title:'Same'},
  {id:'wrong',at:30,acceptanceReview:{taskRef:'req',approvalId:'old',acceptanceMode:'manual'}},
  {id:'review',at:10,acceptanceReview:{taskRef:'req',approvalId:'approval',acceptanceMode:'manual'}}];
 const f=fixture({SoduWorkAPI:{getTask:async()=>({id:'req'})},
  soduWorkAPI:{conversationSession:{history:async()=>({ok:true,chats:rows})}}});
 await f.api.open('req','Same',{source:'acceptance',acceptanceSession:true,approvalId:'approval'});
 assert.equal(f.calls[0].payload.chatId,'review');
 assert.equal(f.calls[0].payload.forceNew,false);
});
test('remote requirement viewing bypasses local review history and stale task mappings',async()=>{
 const task=remoteRequirement();
 const f=fixture({SoduWorkAPI:{getTask:async()=>task},
  NativeChat:{sessionInfo:()=>({sessionId:'local-review',taskIds:[task.id]})},
  soduWorkAPI:{conversationSession:{history:async()=>assert.fail('remote navigation must not probe local history')}}});
 await f.api.open(task.id,'',{source:'task-list',chatId:'local-review'});
 assert.equal(f.calls[0].payload.chatId,'task-execution:remote-req');
 assert.equal(f.calls[0].payload.forceNew,false);
 assert.equal(f.calls[0].payload.navigation,true);
});
test('remote navigation does not replace explicit review, dispatch, or local execution',()=>{
 const f=fixture(),task=remoteRequirement();
 for(const source of ['acceptance','rework','task-add','task-create','task-dispatch']) {
  const result=f.api.resolve({taskId:task.id,source,chatId:'chosen'},task,{},[],null);
  assert.equal(result.chatId,'chosen',source);
 }
 task.workRouting.executionContext.location.mode='local';
 assert.equal(f.api.resolve({taskId:task.id,chatId:'local'},task,{},[],null).chatId,'local');
});

test('释放未执行需求后，旧存档和本地索引不再抢占新会话', () => {
 const f=fixture();
 const store={isQueueRemoved:(chat,id)=>chat==='released'&&id==='a',
  findByTask:()=>({conversationId:'released'}),findByProject:()=>({conversationId:'released'})};
 const out=f.api.resolve({taskId:'a'}, {id:'a',status:'todo',projectId:'p'},
  {sessionId:'released',taskIds:['a']},[{id:'released',taskId:'a'}],store);
 assert.equal(out.chatId,''); assert.equal(out.forceNew,true);
});

test('释放标记不能覆盖服务端仍在执行的轮次', () => {
 const f=fixture(); const out=f.api.resolve({taskId:'a'},
  {id:'a',status:'doing',workRouting:{conversationTurn:{conversationId:'running',state:'running'}}},
  {},[],{isQueueRemoved:()=>true});
 assert.equal(out.chatId,'running'); assert.notEqual(out.forceNew,true);
});

test('业务状态尚未回流时，执行回执和已归档标志仍禁止新建执行会话', () => {
 for(const state of [{ai:{executionState:'running'}},{archivedAt:'2026-10-16'},{requirementStage:'reviewing'}]) {
  const out=fixture().api.resolve({taskId:'a'},{id:'a',status:'todo',...state},{},[],null);
  assert.notEqual(out.forceNew,true);
 }
});

test('shared metadata never opens private execution even with stale privileged payload',async()=>{
 let history=0,details=[];
 const f=fixture({SoduWorkAPI:{getTask:async id=>({id,canViewExecution:false})},
  RequirementsDetail:{open:async id=>details.push(id)},
  soduWorkAPI:{conversationSession:{history:async()=>{history++;return{chats:[]}}}}});
 await f.api.open('shared','',{task:{id:'shared',canViewExecution:true},chatId:'private'});
 assert.deepEqual(details,['shared']);assert.equal(history,0);assert.equal(f.calls.length,0);
});

test('account switch discards late task lookup and allows the same id to be reopened safely',async()=>{
 let finish,reads=0;
 const f=fixture({SoduWorkAPI:{getTask:id=>++reads===1?new Promise(r=>finish=r):Promise.resolve({id})}});
 const old=f.api.open('same');f.listeners['soduwork-data-scope-changed']();
 await f.api.open('same');finish({id:'same',workRouting:{conversationTurn:{conversationId:'private-old'}}});
 assert.equal(await old,false);assert.equal(f.calls.length,1);assert.equal(f.calls[0].payload.chatId,'');
});

test('account switch while reading history cannot route the old account conversation',async()=>{
 let finish;
 const f=fixture({SoduWorkAPI:{getTask:async id=>({id})},soduWorkAPI:{conversationSession:{history:()=>new Promise(r=>finish=r)}}});
 const work=f.api.open('a');await new Promise(setImmediate);assert.equal(typeof finish,'function');f.listeners['soduwork-data-scope-changed']();
 finish({chats:[{id:'old',taskId:'a'}]});assert.equal(await work,false);assert.equal(f.calls.length,0);
});

test('missing task object does not manufacture a new chat',async()=>{
 const f=fixture({SoduWorkAPI:{getTask:async()=>null}});assert.equal(await f.api.open('missing'),false);
 assert.equal(f.calls.length,0);assert.equal(f.notices.length,1);
});
test('exact server task conversation wins over current project and stale cache',()=>{
 const f=fixture();const out=f.api.resolve({taskId:'a'}, {id:'a',projectId:'p',workRouting:{conversationTurn:{conversationId:'correct'}}},
  {sessionId:'unrelated',projectId:'p',collaboration:true},[],{findByTask:()=>({conversationId:'stale'}),findByProject:()=>({conversationId:'wrong'})});
 assert.equal(out.chatId,'correct');assert.equal(out.navigation,true);assert.equal(out.reuseCurrent,undefined);
});
test('durable multiple task bindings restore a non-active task without project guessing',()=>{
 const f=fixture();const out=f.api.resolve({taskId:'a'}, {id:'a',projectId:'p'},{},
  [{id:'chat',taskBindings:[{taskId:'a'},{taskId:'b'}]}],{findByProject:()=>({conversationId:'wrong'})});assert.equal(out.chatId,'chat');
 assert.equal(f.api.resolve({taskId:'x'},{id:'x',projectId:'p'},{},[],{findByProject:()=>({conversationId:'wrong'})}).chatId,'');
});
test('intentional add task preserves the explicitly selected ordinary chat',()=>{
 const f=fixture();const out=f.api.resolve({taskId:'a',source:'task-add',reuseCurrent:true},{id:'a'},
  {sessionId:'ordinary'},[],null);assert.equal(out.chatId,'ordinary');assert.equal(out.navigation,false);
});

test('待开始需求显式加入当前会话时不被新建兜底覆盖',()=>{
 const out=fixture().api.resolve({taskId:'a',source:'task-add',reuseCurrent:true},
  {id:'a',status:'todo'},{sessionId:'chosen'},[],null);
 assert.equal(out.chatId,'chosen');assert.notEqual(out.forceNew,true);
});

test('验收入口在当前验收会话中重复点击只回到同一会话',()=>{
 const f=fixture();
 const out=f.api.resolve({taskId:'a',source:'acceptance',acceptanceSession:true,approvalId:'gate-1'},
  {id:'a',status:'done'},
  {sessionId:'accept-chat',acceptanceSession:true,acceptanceTaskId:'a',acceptanceApprovalId:'gate-1'},[],null);
 assert.equal(out.chatId,'accept-chat');
 assert.notEqual(out.forceNew,true);
 assert.equal(out.navigation,false);
});

test('验收入口跨聊天列表和需求详情重复点击复用已缓存会话', async () => {
 let currentSession = '';
 const f = fixture({
  SoduWorkAPI: {getTask: async id => ({id, status:'done'})},
  NativeChat: {sessionInfo: () => ({sessionId:currentSession, acceptanceSession:Boolean(currentSession),
    acceptanceTaskId:'a', acceptanceApprovalId:'gate-1'})},
 });
 await f.api.open('a','交付结果',{source:'acceptance', acceptanceSession:true, approvalId:'gate-1'});
 currentSession = 'accept-chat';
 await f.api.open('a','交付结果',{source:'acceptance', acceptanceSession:true, approvalId:'gate-1'});
 assert.equal(f.calls.length, 2);
 assert.equal(f.calls[0].payload.forceNew, true);
 assert.equal(f.calls[0].payload.chatId, '');
 assert.equal(f.calls[1].payload.forceNew, false);
 assert.equal(f.calls[1].payload.chatId, 'accept-chat');
});

test('同执行人与验收人时验收入口复用原执行会话并标记为一次性验收轮次', () => {
 const f = fixture();
 const out = f.api.resolve({taskId:'a', source:'acceptance', acceptanceSession:true,
   reuseExecutionSession:true, approvalId:'gate-1'},
   {id:'a', status:'done', workRouting:{conversationTurn:{conversationId:'original'}}},
   {sessionId:'other'}, [{id:'original', taskId:'a'}], null);
 assert.equal(out.chatId, 'original');
 assert.equal(out.forceNew, false);
 assert.equal(out.acceptanceSession, false);
 assert.equal(out.acceptanceExecutionSession, true);
});

test('a missing history row cannot prove the original review archive was deleted', () => {
 const f = fixture();
 const out = f.api.resolve({taskId:'a', source:'acceptance', acceptanceSession:true,
   reuseExecutionSession:true, approvalId:'gate-1'},
   {id:'a', status:'done', workRouting:{conversationTurn:{conversationId:'deleted'}}},
   {sessionId:'other'}, [], null);
 assert.equal(out.chatId, 'deleted');
 assert.equal(out.forceNew, false);
 assert.equal(out.acceptanceSession, false);
 assert.equal(out.acceptanceExecutionSession, true);
});

for (const acceptanceMode of ['manual', 'auto']) test(`a confirmed missing original reuses its ${acceptanceMode} review replacement`, async () => {
 const calls=[];
 let info={}, original='deleted-original';
 const f=fixture({
  SoduWorkAPI:{getTask:async id=>({id,status:'done',workRouting:{conversationTurn:{conversationId:original}}})},
  NativeChat:{sessionInfo:()=>info},
  WorkspaceHost:{open:async(_view,payload)=>{
   calls.push(payload);
   info={sessionId:'replacement',acceptanceSession:true,acceptanceExecutionSession:false,
    acceptanceTaskId:'a',acceptanceApprovalId:'gate-1',acceptanceFallbackFrom:original};
   return true;
  }},
 });
 const options=()=>({source:'acceptance',chatId:original,reuseExecutionSession:true,
  acceptanceExecutionSession:true,acceptanceSession:false,approvalId:'gate-1',acceptanceMode});
 await f.api.open('a','Delivery',options());
 info={};
 await f.api.open('a','Delivery',options());
 assert.equal(calls[0].chatId,'deleted-original');
 assert.equal(calls[1].chatId,'replacement');
 assert.equal(calls[1].acceptanceSession,true);
 assert.equal(calls[1].acceptanceExecutionSession,false);
 assert.equal(calls[1].forceNew,false);
 assert.equal(calls[1].acceptanceMode,acceptanceMode);
 original='new-execution'; info={};
 await f.api.open('a','Delivery',options());
 assert.equal(calls[2].chatId,'new-execution','new execution authority supersedes a missing-archive fallback');
  f.listeners['soduwork-data-scope-changed']();info={};
 await f.api.open('a','Delivery',options());
 assert.equal(calls[3].chatId,'new-execution','fallback identity cannot cross account scope');
});

test('执行人与验收人相同且原会话仍在存档时，验收上下文复用原执行会话', async () => {
 const f=fixture({
  SoduWorkAPI:{getTask:async id=>({id,status:'done',workRouting:{conversationTurn:{conversationId:'original'}}})},
  soduWorkAPI:{conversationSession:{history:async()=>({chats:[{id:'original',taskId:'a'}]})}},
 });
 await f.api.open('a','交付结果',{source:'acceptance',acceptanceSession:false,
   acceptanceExecutionSession:true,reuseExecutionSession:true,approvalId:'gate-1'});
 assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].payload.chatId,'original');
 assert.equal(f.calls[0].payload.forceNew,false);
 assert.equal(f.calls[0].payload.acceptanceExecutionSession,true);
 assert.equal(f.calls[0].payload.acceptanceSession,false);
});

test('review navigation preserves the exact archive identity until the controller confirms absence', async () => {
 const f=fixture({
  SoduWorkAPI:{getTask:async id=>({id,status:'done',workRouting:{conversationTurn:{conversationId:'deleted'}}})},
  soduWorkAPI:{conversationSession:{history:async()=>({chats:[]})}},
 });
 await f.api.open('a','交付结果',{source:'acceptance',acceptanceSession:false,
   acceptanceExecutionSession:true,reuseExecutionSession:true,approvalId:'gate-1'});
 assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].payload.chatId,'deleted');
 assert.equal(f.calls[0].payload.forceNew,false);
 assert.equal(f.calls[0].payload.acceptanceSession,false);
 assert.equal(f.calls[0].payload.acceptanceExecutionSession,true);
});

test('same-owner navigation resolves creation provenance and prefers an existing execution receipt', async () => {
 let reads=0;
 const f=fixture({__teamCap:{meId:'me'},soduWorkAPI:{conversationSession:{findTaskCreation:async()=>{reads++;return {ok:true,sessionId:'origin'};}}}});
 const task={id:'task',createdBy:'me',assigneeUserId:'me'};
 assert.equal(await f.api.preferredConversation(task),'origin');
 assert.equal(await f.api.preferredConversation({...task,workRouting:{conversationTurn:{conversationId:'execution'}}}),'execution');
 assert.equal(await f.api.preferredConversation({...task,assigneeUserId:'colleague'}),'');
 assert.equal(await f.api.preferredConversation({...task,createdBy:'colleague'}),'');
 assert.equal(reads,1);
});

test('provenance lookup failure or an account switch must not authorize a replacement chat', async () => {
 const f=fixture({__teamCap:{meId:'me'},soduWorkAPI:{conversationSession:{findTaskCreation:async()=>({ok:false,reason:'unavailable'})}}});
 await assert.rejects(f.api.preferredConversation({id:'task',createdBy:'me',assigneeUserId:'me'}),/unavailable/);
 let resolve;
 const late=fixture({__teamCap:{meId:'me'},soduWorkAPI:{conversationSession:{findTaskCreation:()=>new Promise(done=>{resolve=done;})}}});
 const pending=late.api.preferredConversation({id:'task',createdBy:'me',assigneeUserId:'me'});
  await new Promise(setImmediate);late.listeners['soduwork-data-scope-changed']();resolve({ok:true,sessionId:'origin'});
 await assert.rejects(pending);
});

test('验收会话语义变化时不复用旧的本地去重缓存', async () => {
 let current = '';
 const f = fixture({
  SoduWorkAPI:{getTask:async id=>({id,status:'done',workRouting:{conversationTurn:{conversationId:'execution-chat'}}})},
  soduWorkAPI:{conversationSession:{history:async()=>({chats:[{id:'execution-chat',taskId:'a'}]})}},
  NativeChat:{sessionInfo:()=>({sessionId:current, acceptanceSession:false, acceptanceTaskId:'a', acceptanceApprovalId:'gate-1'})},
 });
 await f.api.open('a','交付结果',{source:'acceptance',acceptanceSession:false,
   acceptanceExecutionSession:true,reuseExecutionSession:true,approvalId:'gate-1'});
 current = 'execution-chat';
 /* Fresh authorization requiring a separate review session overrides cached execution-session reuse. */
 await f.api.open('a','交付结果',{source:'acceptance',acceptanceSession:true,approvalId:'gate-1'});
 assert.equal(f.calls.length,2);
 assert.equal(f.calls[1].payload.chatId,'');
 assert.equal(f.calls[1].payload.forceNew,true);
 assert.equal(f.calls[1].payload.acceptanceSession,true);
});

test('临时复用会话与独立验收会话模式不交叉复用当前会话', () => {
 const f=fixture();
 const out=f.api.resolve({taskId:'a',source:'acceptance',acceptanceSession:true,approvalId:'gate-1'},
   {id:'a',status:'done',workRouting:{conversationTurn:{conversationId:'execution-chat'}}},
   {sessionId:'execution-chat',acceptanceSession:true,acceptanceExecutionSession:true,
     acceptanceTaskId:'a',acceptanceApprovalId:'gate-1'},[{id:'execution-chat',taskId:'a'}],null);
 assert.equal(out.chatId,'');
 assert.equal(out.forceNew,true);
 assert.equal(out.acceptanceSession,true);
});

test('原执行会话仍在当前窗口但未出现在历史列表时，验收分析和自动验收都复用它', async () => {
 for (const acceptanceMode of ['manual', 'auto']) {
  const f=fixture({
   SoduWorkAPI:{getTask:async id=>({id,status:'done',workRouting:{conversationTurn:{conversationId:'execution-chat'}}})},
   soduWorkAPI:{conversationSession:{history:async()=>({chats:[]})}},
   NativeChat:{sessionInfo:()=>({sessionId:'execution-chat',acceptanceSession:false,acceptanceExecutionSession:false})},
  });
  await f.api.open('a','交付结果',{source:'acceptance',acceptanceSession:false,
   acceptanceExecutionSession:true,reuseExecutionSession:true,acceptanceMode,approvalId:'gate-'+acceptanceMode});
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].payload.chatId,'execution-chat');
  assert.equal(f.calls[0].payload.forceNew,false);
  assert.equal(f.calls[0].payload.acceptanceSession,false);
  assert.equal(f.calls[0].payload.acceptanceExecutionSession,true);
 }
});

test('返修不以有限历史命中判定原会话删除，保留原会话供精确打开',()=>{
 const f=fixture();
 const out=f.api.resolve({taskId:'a',source:'rework',reworkSession:true,navigation:true},
  {id:'a',status:'doing',workRouting:{reworkPending:{feedback:'补充边界处理'},conversationTurn:{conversationId:'gone'}}},
  {},[],{findByTask:()=>({conversationId:'gone'})});
 assert.equal(out.chatId,'gone');
 assert.notEqual(out.forceNew,true);
 assert.equal(out.reworkSession,true);
 assert.equal(out.navigation,true);
});

test('返修没有服务端收据时仍尝试本机映射，由打开结果判定是否已删除',()=>{
 const f=fixture();
 const out=f.api.resolve({taskId:'a',source:'rework',reworkSession:true,navigation:true},
  {id:'a',status:'doing',workRouting:{reworkPending:{feedback:'补充边界处理'}}},
  {},[],{findByTask:()=>({conversationId:'mapped-old'})});
 assert.equal(out.chatId,'mapped-old');
 assert.notEqual(out.forceNew,true);
 assert.equal(out.reworkSession,true);
});

test('返修历史探测未命中时仍把原收据交给精确打开', async () => {
 const f = fixture({
  SoduWorkAPI: { getTask: async id => ({ id, status: 'doing', canContinueExecution: true, workRouting: {
    conversationTurn: { conversationId: 'old-rework-session' },
    reworkPending: { feedback: '补充边界处理' },
  } }) },
  soduWorkAPI: { conversationSession: { history: async () => ({ ok: true, chats: [] }) } },
 });
 await f.api.open('a', '返修任务', { source: 'rework', navigation: true, reworkSession: true });
 assert.equal(f.calls.length, 1);
 assert.equal(f.calls[0].payload.chatId, 'old-rework-session');
 assert.notEqual(f.calls[0].payload.forceNew, true);
 assert.equal(f.calls[0].payload.reworkSession, true);
});

test('返修原会话仍在时继续使用原会话',()=>{
 const f=fixture();
 const out=f.api.resolve({taskId:'a',source:'rework',reworkSession:true,navigation:true},
  {id:'a',status:'doing',workRouting:{reworkPending:{feedback:'补充边界处理'},conversationTurn:{conversationId:'old'}}},
  {},[{id:'old',taskId:'a'}],{findByTask:()=>({conversationId:'old'})});
 assert.equal(out.chatId,'old');
 assert.notEqual(out.forceNew,true);
});

test('a stale rework entry cannot open a conversation without current execution permission', async () => {
 for (const permission of [false, undefined]) {
  const f = fixture({ SoduWorkAPI: { getTask: async id => ({ id, status: 'doing',
   canViewExecution: true, canContinueExecution: permission }) } });
  await f.api.open('a', 'Shared requirement', { source: 'rework', navigation: true });
  assert.equal(f.calls.length, 0);
 }
});
test('double click opens once and uses only ordinary compose navigation',async()=>{
 const f=fixture();await Promise.all([f.api.open('a'),f.api.open('a')]);assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].view,'create');assert.equal(f.calls[0].payload.chatId,'original');
});

test('returning to an earlier Issue while its stale lookup is pending honors the latest click',async()=>{
 const lookups=[];
 const f=fixture({SoduWorkAPI:{getTask:id=>new Promise(resolve=>lookups.push({id,resolve}))}});
 const oldA=f.api.open('a'), oldB=f.api.open('b'), latestA=f.api.open('a');
 assert.equal(lookups.length,3);
 lookups[2].resolve({id:'a',workRouting:{conversationTurn:{conversationId:'latest-a'}}});
 await latestA;
 lookups[0].resolve({id:'a'});lookups[1].resolve({id:'b'});await Promise.all([oldA,oldB]);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].payload.chatId,'latest-a');
});
test('failed lookup cannot create a blank replacement or dispatch work',async()=>{
 const f=fixture({SoduWorkAPI:{getTask:async()=>{throw Error('offline')}}});assert.equal(await f.api.open('a'),false);
 assert.equal(f.calls.length,0);assert.equal(f.notices.length,1);
});
test('a slower earlier click cannot overwrite the newer navigation',async()=>{
 let finish;const f=fixture({SoduWorkAPI:{getTask:id=>id==='a'?new Promise(r=>{finish=r}):Promise.resolve({id,workRouting:{conversationTurn:{conversationId:'b-chat'}}})}});
 const first=f.api.open('a');await f.api.open('b');finish({id:'a'});await first;
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].payload.taskId,'b');
});
test('all AI workbench conversation entries avoid the legacy task chat',()=>{
 const office=fs.readFileSync(path.join(__dirname,'../components/panels/panels-aidesk-office.js'),'utf8');
 const bind=office.slice(office.indexOf('function _dkOfficeBindScene'),office.indexOf('function _dkOfficePatchScene'));
 assert.match(bind,/openTaskConversation/);assert.doesNotMatch(bind,/_dkView = 'task'/);
 const boot=fs.readFileSync(path.join(__dirname,'../desk-boot.js'),'utf8');
 assert.doesNotMatch(boot,/function _taskConversationPayload/);
});

test('Escape dismisses an active popover without a workspace close action',()=>{
 const boot=fs.readFileSync(path.join(__dirname,'../desk-boot.js'),'utf8');
 const esc=boot.slice(boot.indexOf("if (e.key !== 'Escape') return;"));
 assert.ok(esc.includes("'[popover]:popover-open'"));
 assert.doesNotMatch(esc,/closeWindow\(\)/);
 assert.match(esc,/e\.preventDefault\(\); e\.stopImmediatePropagation\(\)/);
 assert.match(esc,/TaskApprovalInbox\.close\(\)/);
});

test('a deleted conversation leaves no hijacking mapping: open conversation falls back to a fresh chat',async()=>{
 // A user deletes an empty conversation; its task binding survives in the store.
 // "Open conversation" must not try to resume the ghost archive.
 const f=fixture({SoduWorkAPI:{getTask:async id=>({id})},soduWorkAPI:{conversationSession:{history:async()=>({chats:[]})}}});
 await f.api.open('sweep','开发扫雷小游戏');
 assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].payload.chatId,''); // no chatId → fresh conversation
 assert.equal(f.calls[0].payload.taskId,'sweep');
});

test('resolve() only trusts a collaboration mapping that is really in the archive',()=>{
 const f=fixture();
 const store={findByTask:()=>({conversationId:'ghost'})};
 // Read the archive, session absent → mapping ignored (fresh chat).
 assert.equal(f.api.resolve({taskId:'a'},{id:'a'},{},[],store).chatId,'');
 // Same mapping but the archive really lists it → resumes.
 assert.equal(f.api.resolve({taskId:'a'},{id:'a'},{},[{id:'ghost',taskId:'a'}],store).chatId,'ghost');
 // Archive not consulted (explicit chatId/turnId path) → legacy behavior intact.
 assert.equal(f.api.resolve({taskId:'a',chatId:'explicit'},{id:'a'},{},null,store).chatId,'explicit');
 // Mapping pointing at the currently bound session survives without history.
 assert.equal(f.api.resolve({taskId:'a'},{id:'a'},{sessionId:'cur',taskIds:['a']},null,store).chatId,'cur');
});

test('cross-device acceptance: hub receipt without local archive degrades to the issue details',async()=>{
 // Open review from a device other than the execution device.
 // A Hub turn receipt without a local archive must fall back to requirement details.
 // Do not open an unavailable conversation ID.
 let details=[];
 const f=fixture({
  soduWorkAPI:{conversationSession:{history:async()=>({chats:[{id:'other-chat',taskId:'x'}]})}},
  RequirementsDetail:{open:async id=>details.push(id)},
 });
 const ok=await f.api.open('req-1','',{source:'approval',navigation:true,focusApproval:true,approvalId:'apr-1'});
 assert.equal(ok,true);
 assert.deepEqual(details,['req-1']);
 assert.equal(f.calls.length,0);          // Do not open a conversation.
 assert.equal(f.notices.length,1);        // Explain the fallback destination.
});

test('same-device acceptance still opens the original conversation with its chat id',async()=>{
 const f=fixture({soduWorkAPI:{conversationSession:{history:async()=>({chats:[{id:'original',taskId:'req-1'}]})}}});
 const ok=await f.api.open('req-1','',{source:'approval',navigation:true,focusApproval:true,approvalId:'apr-1'});
 assert.equal(ok,true);
 assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].payload.chatId,'original');
 assert.equal(f.calls[0].view,'create');
});

test('archive probe failure keeps the legacy path so the real error surfaces',async()=>{
 const f=fixture({soduWorkAPI:{conversationSession:{history:async()=>{throw new Error('io down');}}}});
 const ok=await f.api.open('req-1','',{source:'approval',navigation:true,focusApproval:true});
 assert.equal(ok,true);
 assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].payload.chatId,'original');
});

test('cross-device non-approval navigation falls back to a fresh chat, never the ghost id',async()=>{
 const f=fixture({soduWorkAPI:{conversationSession:{history:async()=>({chats:[]})}}});
 await f.api.open('req-1','重构导出报表',{source:'task-list'});
 assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].payload.chatId,'');
});

test('进行中需求的执行会话找不到时明确回退到新会话', async () => {
 const f=fixture({
  SoduWorkAPI:{getTask:async id=>({id,status:'doing',workRouting:{conversationTurn:{conversationId:'missing-execution'}}})},
  soduWorkAPI:{conversationSession:{history:async()=>({chats:[]})}},
 });
 await f.api.open('req-1','继续处理',{source:'task-live',navigation:true});
 assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].payload.chatId,'');
 assert.equal(f.calls[0].payload.forceNew,true);
});
