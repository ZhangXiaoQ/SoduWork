'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=name=>fs.readFileSync(path.join(__dirname,'../components/panels',name),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function element(){
 const e={dataset:{},nodes:new Map(),attributes:new Map(),events:{},disabled:false,hidden:false,isConnected:false,textContent:'',value:'',innerHTML:'',
  classList:{toggle(){},add(){},remove(){}},setAttribute(k,v){this.attributes.set(k,v)},getAttribute(k){return this.attributes.get(k)},removeAttribute(k){this.attributes.delete(k)},
  addEventListener(k,fn){(this.events[k]||=[]).push(fn)},removeEventListener(k,fn){this.events[k]=(this.events[k]||[]).filter(x=>x!==fn)},
  querySelector(k){return this.nodes.get(k)||this.nodes.set(k,element()).get(k)},querySelectorAll(){return[]},getClientRects:()=>[{}],
  close(){this.open=false},showModal(){this.open=true},remove(){this.isConnected=false}};
 return e;
}
function cloudFixture(){
 let owner='alice',ref='one',busy=false,target='',latestDialog;const notices=[],opened=[],continued=[],legacy=[],listeners={};
 const snapshot={status:'idle',cloudHandoff:{phase:'committed'}},foreign=element();foreign.isConnected=true;
 const document={querySelectorAll:()=>[foreign],createElement:()=>element(),body:{append:d=>{d.isConnected=true;latestDialog=d}}};
 const cloud={preview:async()=>({ok:true,targets:[],files:[]})};
 const window={document,petSay:t=>notices.push(t),SoduWorkAPI:{taskStorageKey:()=>owner},
  NativeChat:{sessionInfo:()=>({ref}),isBusy:()=>busy},WorkspaceHost:{open:async(...a)=>{opened.push(a);return true}},
  ChatDeliveries:{localContinuation:input=>input===ref?target:'',continueLocal:async(...a)=>continued.push(a),handle:async()=>legacy.push('unscoped')},
  soduWorkAPI:{conversationSession:{cloud}},addEventListener:(k,fn)=>(listeners[k]||=[]).push(fn),removeEventListener:(k,fn)=>{listeners[k]=(listeners[k]||[]).filter(x=>x!==fn)}};
 vm.runInNewContext(read('chat-cloud-handoff.js'),{window,document});
 return {window,cloud,notices,opened,continued,legacy,snapshot,get dialog(){return latestDialog},
  context:()=>({ref,snapshot}),select:()=>window.ChatCloudHandoff.select('local',{ref,snapshot}),
  switchOwner(){owner='bob';for(const fn of listeners['soduwork-data-scope-changed']||[])fn()},switchSession(){ref='two'},
  setBusy(v){busy=v},target(v){target=v},async submit(){for(const fn of latestDialog.querySelector('form').events.submit||[])await fn({preventDefault(){}})}};
}
test('cloud local action explains a new local conversation and never selects unrelated visible delivery',async()=>{
 const f=cloudFixture();await f.select();assert.match(f.dialog.innerHTML,/新的本机会话/);assert.doesNotMatch(f.dialog.innerHTML,/带成果在本机继续/);
 await f.submit();assert.equal(f.opened.length,1);assert.equal(f.opened[0][0],'create');assert.equal(f.opened[0][1].newSession,true);assert.equal(f.continued.length,0);
});
test('cloud local action uses formal current-conversation delivery metadata',async()=>{
 const f=cloudFixture();f.target('current-delivery');await f.select();assert.match(f.dialog.innerHTML,/云端会话和记录会保留/);assert.match(f.dialog.innerHTML,/新的本机工作区/);
 await f.submit();assert.equal(f.continued.length,1);assert.equal(f.continued[0][0],'one');assert.equal(f.continued[0][1],'current-delivery');assert.equal(f.opened.length,0);
});
for(const invalidation of ['switchOwner','switchSession'])test('pending local continuation cannot run after '+invalidation,async()=>{
 const f=cloudFixture();f.target('delivery');await f.select();f[invalidation]();await f.submit();assert.equal(f.continued.length,0);assert.equal(f.opened.length,0);assert.equal(f.legacy.length,0);
});
test('cloud resumes while confirmation is open: local continuation is fenced again on submit',async()=>{
 const f=cloudFixture();f.target('delivery');await f.select();f.setBusy(true);await f.submit();assert.equal(f.continued.length,0);assert.equal(f.opened.length,0);assert.equal(f.legacy.length,0);
});
test('delivery changed while confirmation is open never falls back to an empty local session',async()=>{
 const f=cloudFixture();f.target('old-delivery');await f.select();f.target('new-delivery');await f.submit();assert.equal(f.continued.length,0);assert.equal(f.opened.length,0);assert.equal(f.legacy.length,0);
});
test('cloud continuation initially busy refuses the action',async()=>{
 const f=cloudFixture();f.snapshot.status='streaming';f.setBusy(true);await f.select();assert.equal(f.dialog,undefined);assert.equal(f.opened.length,0);
});
for(const invalidation of ['switchOwner','switchSession'])test('late cloud preview cannot disclose old workspace files after '+invalidation,async()=>{
 const f=cloudFixture(),wait=deferred();f.cloud.preview=()=>wait.promise;
 const pending=f.window.ChatCloudHandoff.open('one');f[invalidation]();wait.resolve({ok:true,targets:[{}],files:[{path:'old-private-file.txt',size:20}],total:20});await pending;
 assert.equal(f.dialog.querySelector('[data-cloud-body]').innerHTML.includes('old-private-file.txt'),false);
});
test('snapshot painting disables local continuation during streaming and runtime switching',()=>{
 const f=cloudFixture(),root=element(),local=element(),cloud=element();local.dataset.chatExecution='local';cloud.dataset.chatExecution='cloud';
 root.querySelector=()=>null;root.querySelectorAll=()=>[local,cloud];
 for(const status of ['streaming','running','queued']){f.window.ChatCloudHandoff.sync(root,{status,cloudHandoff:{phase:'committed'}},{ref:'one'});assert.equal(local.disabled,true);assert.equal(cloud.getAttribute('aria-pressed'),'true');}
 f.window.ChatCloudHandoff.sync(root,{status:'idle',cloudHandoff:{phase:'committed'},runtimeSwitching:true},{ref:'one'});assert.equal(local.disabled,true);assert.equal(cloud.disabled,true);
 f.window.ChatCloudHandoff.sync(root,{status:'idle',cloudHandoff:{phase:'committed'}},{ref:'one'});assert.equal(local.disabled,false);
});

test('personal PC receipts show their actual location and never create a local copy',async()=>{
 const f=cloudFixture(),root=element(),local=element(),cloud=element(),trigger=element();
 local.dataset.chatExecution='local';cloud.dataset.chatExecution='cloud';
 root.querySelectorAll=s=>s==='[data-chat-execution]'?[local,cloud]:s==='[data-execution-menu]'?[trigger]:[];
 let location;
 f.window.WorkComposer={syncExecutionMenu:(_root,value)=>{location=value}};
 f.snapshot.cloudHandoff.target={runnerKind:'work-computer',runnerName:'My test PC'};
 f.window.ChatCloudHandoff.sync(root,f.snapshot,{ref:'one'});
 assert.equal(location,'local');assert.equal(cloud.getAttribute('aria-pressed'),'false');
 assert.equal(local.getAttribute('aria-pressed'),'true');
 assert.equal(trigger.getAttribute('aria-label'),'执行位置：我的电脑');
 assert.equal(local.querySelector('span').textContent,'');
 f.cloud.preview=async()=>({ok:true,handoff:f.snapshot.cloudHandoff});
 await f.select();
 assert.equal(f.dialog.querySelector('#ncloudTitle').textContent,'我的电脑会话');
 assert.match(f.dialog.querySelector('[data-cloud-body]').innerHTML,/My test PC/);
 assert.match(f.dialog.querySelector('[data-cloud-body]').innerHTML,/权限由该电脑/);
 assert.doesNotMatch(f.dialog.querySelector('[data-cloud-body]').innerHTML,/权限由云端/);
 assert.equal(f.opened.length,0);assert.equal(f.continued.length,0);
});

test('permission label distinguishes personal PC without enabling local permission changes',()=>{
 const root=element(),doc=element(),window=element();
 doc.createElement=()=>{const e=element();e.appendChild=()=>{};e.insertAdjacentHTML=()=>{};return e};
 root.querySelector('#nchatMode').before=()=>{};
 root.querySelector('#nchatMode').appendChild=()=>{};
 window.WorkComposer={permissionLabel:()=> '默认权限',permissionAppearance(){}};
 let state={ref:'same-session',accessControl:{},cloudHandoff:{phase:'committed',target:{runnerKind:'work-computer'}}};
 vm.runInNewContext(read('chat-session-controls.js'),{window,document:doc,AbortController});
 const controls=window.ChatSessionControls.create(root,{state:()=>state});
 const label=root.querySelector('#nchatModeName'),button=root.querySelector('#nchatMode');
 assert.equal(label.textContent,'电脑权限');assert.equal(button.disabled,true);
 assert.equal(button.title,'权限由所选本人电脑的执行环境管理');
 assert.equal(button.getAttribute('aria-label'),'电脑权限：权限由所选本人电脑的执行环境管理');
 state={...state,cloudHandoff:{phase:'committed',target:{runnerKind:'cloud'}}};controls.render();
 assert.equal(label.textContent,'云端权限');assert.equal(button.disabled,true);
 assert.equal(button.getAttribute('aria-label'),'云端权限：权限由云端执行环境管理');
 state={...state,cloudHandoff:null};controls.render();
 assert.equal(label.textContent,'默认权限');assert.equal(button.disabled,false);
 controls.destroy();
});
function composeFixture(){
 let owner='alice',place='local',current=true;const panel=element(),local=element(),cloud=element(),notices=[],starts=[],enters=[];
 local.dataset.execution='local';cloud.dataset.execution='cloud';panel.querySelectorAll=()=>[local,cloud];
 const runtime={setLocation:v=>place=v,value:()=>place==='cloud'?'qwen':'pi',availability:()=>({ok:true}),refreshAccess:async()=>{},ready:async()=>true};
 const window={ComposeRuntime:runtime,ComposeModelPicker:{ready:async()=>true,value:()=>({})},petSay:t=>notices.push(t),SoduWorkAPI:{taskStorageKey:()=>owner},crypto:require('node:crypto'),
  NativeChat:{enter:async(...a)=>{enters.push(a);return true}},soduWorkAPI:{conversationSession:{cloud:{start:async a=>{starts.push(a);return{ok:true,sessionId:'new-cloud'}}}}}};
 vm.runInNewContext(read('compose-execution.js'),{window});window.ComposeExecution.bind(panel,()=>{});
 return {window,panel,local,cloud,runtime,notices,starts,enters,
  click(v){const button=v==='cloud'?cloud:local;for(const fn of panel.events.click||[])fn({target:{closest:s=>s==='[data-execution]'?button:null}})},
  changeOwner(){owner='bob'},leave(){current=false},start:options=>window.ComposeExecution.start({text:'draft',attachments:[],isCurrent:()=>current,...options})};
}

test('remote conversation bar identifies downloaded results without relabeling the cache as an execution workspace',()=>{
 const root=element(),workspace={dir:'C:/profile/cloud-results/private-hash',name:'private-hash'};
 const ctx={document:{getElementById:id=>root.querySelector('#'+id)},global:{ChatChrome:{setWorkspace(){}}},
  _wd:workspace,_snap:{cloudHandoff:{phase:'committed',target:{runnerKind:'cloud'}}},_mode:'full',
  _sessionCaps:[],_composerControls:null};
 ctx.ChatChrome=ctx.global.ChatChrome;
 const source=read('panels-chat.js'),start=source.indexOf('  function _paintBar()');
 vm.runInNewContext(source.slice(start,source.indexOf('  function _thinkingStatusHtml',start))+'\n_paintBar();',ctx);
 assert.equal(root.querySelector('#nchatWdName').textContent,'云端成果');
 assert.equal(root.querySelector('#nchatWd').title,workspace.dir);
 assert.doesNotMatch(root.querySelector('#nchatWd').title,/AI 就在/);
 assert.equal(workspace.name,'private-hash','display changes cannot mutate the output cache identity');
 ctx._snap.cloudHandoff.target.runnerKind='work-computer';ctx._paintBar();
 assert.equal(root.querySelector('#nchatWdName').textContent,'电脑成果');
 ctx._snap={};ctx._paintBar();
 assert.equal(root.querySelector('#nchatWdName').textContent,'private-hash');
 assert.equal(root.querySelector('#nchatWd').title,workspace.dir);
 assert.doesNotMatch(root.querySelector('#nchatWd').title,/点击打开/);
});
test('new drafts default local; a pending cloud check cannot switch back after the user selects local',async()=>{
 const f=composeFixture(),wait=deferred();assert.equal(f.window.ComposeExecution.value(),'local');f.runtime.refreshAccess=()=>wait.promise;
 f.click('cloud');f.click('local');wait.resolve();await tick();assert.equal(f.window.ComposeExecution.value(),'local');assert.equal(f.local.getAttribute('aria-pressed'),'true');assert.equal(f.starts.length,0);
});
test('reset cancels the old cloud availability error for the next local draft',async()=>{
 const f=composeFixture(),wait=deferred();f.runtime.refreshAccess=()=>wait.promise;f.click('cloud');f.window.ComposeExecution.reset();wait.reject(Error('old-check-failed'));await tick();
 assert.equal(f.window.ComposeExecution.value(),'local');assert.equal(f.notices.length,0);
});
test('in-flight send disables both mode buttons; identity change cancels dispatch and restores default mode',async()=>{
 const f=composeFixture(),wait=deferred();f.click('cloud');await tick();const pending=f.start({prepare:()=>wait.promise});
 assert.equal(f.local.disabled,true);assert.equal(f.cloud.disabled,true);f.click('local');assert.equal(f.window.ComposeExecution.value(),'cloud');
 f.window.ComposeExecution.reset();f.changeOwner();wait.resolve({attachments:[]});await pending;assert.equal(f.starts.length,0);assert.equal(f.window.ComposeExecution.value(),'local');assert.equal(f.local.disabled,false);
});
for(const exit of ['changeOwner','leave'])test('late send error after '+exit+' cannot appear in the new context',async()=>{
 const f=composeFixture(),wait=deferred();f.click('cloud');await tick();const pending=f.start({prepare:()=>wait.promise});f[exit]();wait.reject(Error('old-private-error'));await pending;
 assert.equal(f.notices.length,0);assert.equal(f.starts.length,0);assert.equal(f.local.disabled,false);
});
