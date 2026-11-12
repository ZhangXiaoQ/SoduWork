'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const contract=require('../main/soduwork-app-bridge-contract.cjs');
function host(){let scope='a';const listeners={};const window={btoa,addEventListener:(n,f)=>listeners[n]=f,SoduWorkAPI:{taskStorageKey:()=>scope}};vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../components/panels/app-host-data.js'),'utf8'),{window,Uint8Array,String,Object,Error});return {window,api:window.SoduWorkAPI,run:(m,p={})=>window.SoduWorkAppHostData.handle(m,p),switch:()=>{scope='b';listeners['soduwork-data-scope-changed']();}};}
test('public methods are explicitly permissioned, reject foreign account and unbounded queries',()=>{
 for(const [method,cap]of Object.entries({'user.getCurrent':'context.read','notifications.list':'messages.read','library.list':'library.read','library.read':'library.read','conversations.list':'messages.read','conversations.messages':'messages.read'})){
  assert.equal(contract.METHOD_CAPABILITY[method],cap);assert.throws(()=>contract.normalizeRequest({id:'r',method,params:{account:'foreign'}}));
 }
 for(const params of [{limit:101},{offset:-1},{storage:'arbitrary'},{limit:1.5}])assert.throws(()=>contract.normalizeRequest({id:'r',method:'library.list',params}));
 assert.throws(()=>contract.normalizeRequest({id:'r',method:'library.read',params:{id:'x',format:'binary'}}));
});
test('identity is the authenticated user, not directory order; credentials never leave host',async()=>{
 const h=host();h.api.clientAuthMe=async()=>({user:{id:'me',displayName:'Me',token:'private',email:'private'},device:{secret:'private'}});
 const r=await h.run('user.getCurrent');assert.equal(r.user.id,'me');assert.doesNotMatch(JSON.stringify(r),/private|device|token/);
 let release;h.api.clientAuthMe=()=>new Promise(resolve=>release=resolve);const pending=h.run('user.getCurrent');h.switch();release({user:{id:'old'}});await assert.rejects(pending,/变化/);
});
test('notifications and both library origins preserve full content, page markers and deny stale binary replies',async()=>{
 const h=host();h.api.mateMessages=async(folder,limit,before)=>{assert.equal(folder,'sent');assert.equal(before,'prior');return {items:[{id:'n',text:'完整通知',secret:'private'}],nextCursor:'next'};};
 const n=await h.run('notifications.list',{folder:'sent',before:'prior'});assert.equal(n.items[0].text,'完整通知');assert.equal(n.nextCursor,'next');assert.doesNotMatch(JSON.stringify(n),/private/);
 h.api.listLibrary=async p=>({items:[{id:'a',title:p.storage,path:'private'},{id:'b'}],folders:[]});for(const storage of ['local','minio','nfs']){const r=await h.run('library.list',{storage,limit:1});assert.equal(r.items[0].title,storage);assert.equal(r.nextOffset,1);assert.doesNotMatch(JSON.stringify(r),/private/);}
 h.api.readLibraryContent=async()=>({content:'abcdef',preview:{truncated:false}});assert.equal((await h.run('library.read',{id:'a',offset:2,length:2})).content,'cd');
 h.api.readLibraryBinary=async()=>({blob:new Blob([Uint8Array.from([0,1,255,2])])});const b=await h.run('library.read',{id:'a',format:'base64',offset:1,length:2});assert.equal(b.data,'Af8=');assert.equal(b.nextOffset,3);
 h.api.readLibraryContent=async()=>({content:'partial',preview:{truncated:true}});await assert.rejects(h.run('library.read',{id:'a'}),/预览/);
});
test('history reads archives without opening a model or exposing system/tool content and enforces ownership',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'app-history-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const dir=path.join(root,'pi-agent');fs.mkdirSync(dir);
 const file=path.join(dir,'session.jsonl');fs.writeFileSync(file,[{type:'session',id:'s'},...['system','user','toolResult','assistant'].map((role,i)=>({type:'message',id:String(i),message:{role,content:[{type:'text',text:role==='user'?'Hello':role==='assistant'?'Answer':'private'}]}}))].map(JSON.stringify).join('\n'));
 let current=true;const access={actor:()=>({owner:'a'}),assertCurrent:()=>{if(!current)throw Error('changed');},assertOwner:(_a,id)=>{if(id==='foreign')throw Error('denied');}};
 const session={history:async()=>({ok:true,chats:[{id:'s',path:file},{id:'foreign'}]}),archivedConversation:async()=>({id:'s',adapterId:'pi'}),historyEntry:async()=>({ok:true,entry:{path:file}})};
 const run=require('../main/app-readonly-history.cjs').create({app:{getPath:()=>root},session,access,runner:{rpc:()=>assert.fail('must not start runner for Pi archives')}});
 assert.equal((await run('conversations.list',{})).items.length,1);const a=await run('conversations.messages',{id:'s',limit:1});assert.equal(a.items[0].text,'Hello');assert.equal(a.nextOffset,1);const b=await run('conversations.messages',{id:'s',limit:1,offset:1});assert.equal(b.items[0].text,'Answer');assert.equal(b.nextOffset,null);assert.doesNotMatch(JSON.stringify([a,b]),/private|jsonl/);
 await assert.rejects(run('conversations.messages',{id:'foreign'}),/denied/);current=false;await assert.rejects(run('conversations.list',{}),/changed/);
});
test('SDK exposes actual readonly bridge calls and bilingual single-theme authoring is explicit',async()=>{
 const calls=[],window={crypto:require('node:crypto').webcrypto,addEventListener(){},soduWorkAppBridge:{request:async(m,p)=>{calls.push(m);return {ok:true};},events:{onTurnSettled(){}}}};window.parent=window;
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../sdk/soduwork-app.js'),'utf8'),{window,location:{origin:'https://test.invalid'},document:{referrer:'',querySelectorAll:()=>[]},URL,Set,Map,Promise});
 await window.soduWorkApp.user.getCurrent();await window.soduWorkApp.notifications.list();await window.soduWorkApp.conversations.list();await window.soduWorkApp.conversations.messages({id:'s'});await window.soduWorkApp.library.list();await window.soduWorkApp.library.read({id:'f'});assert.equal(calls.length,6);
 const app={isPackaged:false},body=require('../main/app-developer-plugin.cjs').body(app);assert.equal(body.version,'1.7.1');assert.ok(body.resources.some(x=>x.path.endsWith('app-files.md')));assert.ok(body.resources.some(x=>x.path.endsWith('host-data-sdk.md')));assert.match(body.instructions,/不强制亮暗双模式/);
});

test('Runner and cloud history use readonly event pages, cursor continuity and owned receipts',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'app-cloud-history-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const identity={hub:'https://fixture.invalid',clientId:'device',session:require('./helpers/platform-session-fixture.cjs').sessions().renewed};
 const access={actor:()=>({identity,owner:'me'}),assertCurrent(){},assertOwner(){}};
 const session={archivedConversation:async()=>({id:'s',adapterId:'codex'})};let calls=0;
 const run=require('../main/app-readonly-history.cjs').create({app:{getPath:()=>root},session,access,runner:{rpc:async(method,p)=>{assert.equal(method,'job.session');assert.equal(p.since,4);calls++;return {ok:true,data:{seq:9,items:[{seq:5,kind:'tool',text:'private'},{seq:6,kind:'text',text:'Visible',delta:true,streamId:'a'}]}};}}});
 const r=await run('conversations.messages',{id:'s',after:4});assert.equal(calls,1);assert.equal(r.items[0].text,'Visible');assert.equal(r.nextAfter,6);assert.doesNotMatch(JSON.stringify(r),/private/);
 const folder=path.join(root,'conversation-handoffs');fs.mkdirSync(folder);const file=path.join(folder,require('node:crypto').createHash('sha256').update('s').digest('hex')+'.json');
 const owner=require('../main/platform-connections/runtime.cjs').connectionScope(identity);fs.writeFileSync(file,JSON.stringify({sessionId:'s',owner,taskId:'t',ref:'remote',phase:'committed'}));
 const cloud=require('../main/app-readonly-history.cjs').create({app:{getPath:()=>root},session,access,runner:{rpc:()=>assert.fail('cloud must not read local runner')},readCloud:async()=>({ref:'remote',last:8,items:[{seq:8,kind:'user',text:'Cloud text'}]})});
 assert.equal((await cloud('conversations.messages',{id:'s'})).items[0].text,'Cloud text');
 fs.writeFileSync(file,JSON.stringify({sessionId:'s',owner:'foreign'}));await assert.rejects(cloud('conversations.messages',{id:'s'}),/归属/);
});

test('remote directory projections read Hub transcripts without a local receipt', async () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'app-remote-projection-'));
 const identity={hub:'https://fixture.invalid',clientId:'desktop',session:'session'};
 const access={actor:()=>({identity,owner:'me'}),assertCurrent(){},
   assertOwner:(_app,_id,captured,row)=>{
     if(row.remoteProjection!==true||row.cloud!==true||row.owner!==captured.owner||!row.taskId||!row.ref) throw Error('归属');
   }};
 const session={archivedConversation:async()=>({id:'remote-chat',remoteProjection:true,cloud:true,owner:'me',
   taskId:'task-remote',ref:'ref-remote',adapterId:'pi'})};
 let received;
 const run=require('../main/app-readonly-history.cjs').create({app:{getPath:()=>root},session,access,
   readCloud:async(_identity,record,params)=>{received={record,params};return {ok:true,ref:'ref-remote',seq:2,
     items:[{seq:1,kind:'user',text:'跨设备请求'},{seq:2,kind:'say',text:'跨设备回复'}]};}});
 const page=await run('conversations.messages',{id:'remote-chat',after:0,limit:20});
 assert.deepEqual(page.items.map(item=>item.text),['跨设备请求','跨设备回复']);
 assert.equal(received.record.taskId,'task-remote');assert.equal(received.record.ref,'ref-remote');
 fs.rmSync(root,{recursive:true,force:true});
});

test('change hints contain no payload, enforce parent and capability/origin, and release SDK subscriptions',async()=>{
 const delivered=[];const item=(caps,origin='https://owned.invalid')=>({appBridge:{capabilities:caps,origin:'https://owned.invalid'},view:{webContents:{isDestroyed:()=>false,getURL:()=>origin,send:(channel,value)=>delivered.push({channel,value})}}});
 const owners=new Map([[1,{views:new Map([['yes',item(['library.read'])],['no',item([])],['foreign',item(['library.read'],'https://other.invalid')]])}]]),publish=require('../main/app-data-events.cjs').publish;
 assert.equal(publish(owners,{sender:{id:2}},'library').ok,false);assert.equal(publish(owners,{sender:{id:1}},'library').delivered,1);assert.deepEqual(delivered,[{channel:'app-data-changed',value:{topic:'library'}}]);
 let receive;const window={crypto:require('node:crypto').webcrypto,addEventListener(){},soduWorkAppBridge:{request:async()=>({ok:true}),events:{onDataChanged:fn=>receive=fn,onTurnSettled(){}}}};window.parent=window;
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../sdk/soduwork-app.js'),'utf8'),{window,location:{origin:'https://owned.invalid'},document:{referrer:'',querySelectorAll:()=>[]},URL,Set,Map,Promise});
 let seen=0;const off=window.soduWorkApp.events.onDataChanged(()=>seen++);receive({topic:'library',private:'not exposed'});assert.equal(seen,1);off();receive({topic:'library'});assert.equal(seen,1);
});
