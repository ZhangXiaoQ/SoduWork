'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const resolver = require('../main/conversation/task-execution-view');
const { create } = require('../main/conversation/cloud-handoff');
const identity = uid => ({ hub: 'http://127.0.0.1:18989', clientId: 'desktop',
  session: Buffer.from(JSON.stringify({ typ: 'device', uid, cid: 'desktop', iat: 1, exp: 9999999999 }))
    .toString('base64url') + '.' + 'a'.repeat(64) });
function fixture() {
  const context = { location: { mode: 'remote' }, runner: { runnerId: 'cloud-runner', host: 'Isolated cloud' } };
  return { task: { id: 'req', kind: 'requirement', status: 'done', title: 'Requirement',
    workRouting: { executionContext: context } },
    page: { ok: true, taskId: 'req', ref: 'original-run', runnerId: 'cloud-runner', engine: 'pi',
      executionContext: context, status: 'done', canSend: true, last: 2, persistedThrough: 2,
      items: [{ kind: 'user', seq: 1, text: 'Original requirement' }, { kind: 'say', seq: 2, text: 'Delivered' }] } };
}
test('exact task execution lookup fails closed for local, missing, mismatched, and unauthorized records',async()=>{
 for(const change of [f=>f.task.canViewExecution=false,f=>f.task.id='other',f=>f.task.kind='task',
  f=>f.task.workRouting.executionContext={location:{mode:'local'}},
  f=>f.page.taskId='other',f=>f.page.runnerId='another-runner',f=>f.page.ref='',
  f=>f.page.executionContext={location:{mode:'local'}},f=>f.page.ok=false]) {
  const f=fixture();change(f);
  await assert.rejects(resolver.resolve('task-execution:req',{},async(_,route)=>route.endsWith('/req')?f.task:f.page));
 }
 await assert.rejects(resolver.resolve('task-execution:../req',{},async()=>assert.fail()));
 assert.equal(await resolver.resolve('native-chat',{},async()=>assert.fail()),null);
});
test('formal remote requirement replays and continues its original task without cloud discovery or local execution',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'soduwork-task-view-'));
 const f=fixture(), requests=[];let current=identity('alice');
 const controller=create({app:{getPath:()=>root},identityOf:async()=>current,remoteDirectory:true,interval:60000,
  request:async(_,route,options)=>{
   requests.push({route,options});
   if(route==='/tasks/req') return f.task;
   if(route.includes('/ai-session?')) return f.page;
   if(route.endsWith('/attachments')) return [];
   if(route.endsWith('/ai-say')) return {ok:true,accepted:true};
   if(route.startsWith('/cloud-conversations')) return {chats:[]};
   assert.fail(route);
  }});
 let view;
 t.after(async()=>{await view?.close();await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 view=await controller.reopen('task-execution:req','desktop-view');
 assert.equal(view.passiveCloudView,true);
 assert.equal(view.taskRef,'req');
 assert.equal(view.snapshot().cloudHandoff.ref,'original-run');
 assert.equal(view.snapshot().cloudHandoff.target.runnerId,'cloud-runner');
 assert.equal(view.snapshot().cwd || '', '');
 for(let n=0;n<50&&!view.snapshot().messages.length;n++) await new Promise(r=>setTimeout(r,10));
 assert.ok(view.snapshot().messages.some(row=>row.text==='Original requirement'));
 assert.ok(view.snapshot().messages.some(row=>row.blocks?.some(block=>block.text==='Delivered')));
 await controller.history(); // An empty ordinary-chat directory cannot erase this view.
 assert.equal((await view.send('Continue')).ok,true);
 assert.equal(requests.filter(row=>row.route.endsWith('/ai-say')).length,1);
 assert.equal(requests.find(row=>row.route.endsWith('/ai-say')).route,'/tasks/req/ai-say');
 assert.equal(requests.filter(row=>row.options?.method==='POST').length,1,'opening never creates or dispatches work');
 await controller.refreshTaskExecution('task-execution:req',true);
 f.page.ref='new-run';
 await assert.rejects(view.send('Do not reroute'),/新的执行记录/);
 assert.equal(requests.filter(row=>row.route.endsWith('/ai-say')).length,1);
 f.page.ref='original-run';
 f.page.canSend=false;
 await assert.rejects(view.send('No permission'),/暂不能继续/);
 assert.equal(requests.filter(row=>row.route.endsWith('/ai-say')).length,1);
 f.page.canSend=true;
 current=identity('bob');
 await assert.rejects(controller.reopen('task-execution:req','wrong-owner'));
 current=identity('alice');
 f.task.canViewExecution=false;
 await assert.rejects(controller.refreshTaskExecution('task-execution:req',true));
});
test('offline known remote requirement does not fall back to an unknown local archive',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'soduwork-task-offline-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
 const controller=create({app:{getPath:()=>root},identityOf:async()=>identity('alice'),
  request:async()=>{throw Error('offline');}});
 await assert.rejects(controller.reopen('task-execution:req','view'),/offline/);
});
test('read-only and workflow executions cannot be continued through a viewing projection',async()=>{
 for(const fields of [{canSend:false},{workflowRunId:'workflow'}]) {
  const f=fixture();Object.assign(f.page,fields);
  const row=await resolver.resolve('task-execution:req',{},async(_,route)=>route.endsWith('/req')?f.task:f.page);
  assert.equal(row.canSend,false);
 }
});

test('remote requirement machine kind comes from its frozen runner, not execution owner client',async()=>{
 const f=fixture();f.page.runnerClientId='requesting-mobile-device';
 const request=async(_,route)=>route.endsWith('/req')?f.task:f.page;
 assert.equal((await resolver.resolve('task-execution:req',{},request)).target.runnerKind,'cloud');
 f.page.executionContext.runner.clientId='actual-pc-device';
 assert.equal((await resolver.resolve('task-execution:req',{},request)).target.runnerKind,'work-computer');
});
