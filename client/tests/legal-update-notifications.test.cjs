'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const source=read('components/client-auth/legal-updates.js'),store=read('core/store.js');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(storage=new Map()){
  let owner='one',hub='https://fixture.test';const calls=[],readers=[],events=new Map();
  const documentRow=(kind,revisionId)=>({key:kind,revisionId,locale:'zh-CN',content:'正式原文'});
  const context={console,Date,Math,Promise,document:{body:{},hidden:false},setInterval(){},
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},
    _taskStorageKey:kind=>hub+'|'+owner+'|'+kind,LS_KEY:()=>hub+'|'+owner+'|tasks',
    addEventListener:(key,callback)=>events.set(key,callback),
    SoduWorkI18n:{getLocale:()=> 'zh-CN',translateText:value=>value},
    SoduWorkAPI:{hubBase:()=>hub,clientAuthSnapshot:()=>({user:owner?{id:owner}:null}),
      clientAccountRequest:async(op,payload)=>{calls.push({op,payload});return context.reply(op,payload);}},
    AccountUI:{check:result=>result,legalSelection:rows=>({document:rows[0]}),
      legal:(_parent,rows,kind)=>{const reader={rows,kind,active:()=>true,mask:{addEventListener(){}},close(){}};readers.push(reader);return reader;}},
    reply:()=>({documents:[documentRow('terms','t1'),documentRow('privacy','p1')],updates:[{key:'terms',revisionId:'t1',action:'accept'},{key:'privacy',revisionId:'p1',action:'notice'}]})};
  context.window=context;vm.createContext(context);
  // Exercise the production notice store, including persistence and tombstones.
  vm.runInContext(store.slice(store.indexOf('const LS_NOTICES='),store.indexOf('/* Recurring scheduled tasks. */')),context);
  vm.runInContext(source,context);
  return {context,calls,storage,readers,events,api:context.LegalUpdates,
    rows:()=>vm.runInContext('notices',context),
    scope:(user,nextHub=hub)=>{owner=user;hub=nextHub;vm.runInContext('notices=_readNotices()',context);},
    documentRow};
}
test('legal revisions share the scoped persisted inbox, retain references, and deduplicate after restart',async()=>{
  const f=fixture();await f.api.refresh(true);await f.api.refresh(true);
  assert.equal(f.rows().length,2);
  assert.deepEqual(JSON.parse(JSON.stringify(f.rows().map(row=>row.legalUpdate))),[
    {kind:'privacy',revisionId:'p1',action:'notice'},{kind:'terms',revisionId:'t1',action:'accept'}]);
  assert.ok(f.rows().every(row=>row.recipientId==='one'&&row.kind==='legal_update'&&!row.read));
  f.context.markNoticeRead('legal_update_terms_t1');
  const next=fixture(f.storage);await next.api.refresh(true);
  assert.equal(next.rows().length,2);assert.equal(next.rows().find(row=>row.id==='legal_update_terms_t1').read,true);
  assert.ok(f.calls.every(call=>call.op==='legalStatus'));
});
test('cleared revisions stay cleared while a new revision generates a fresh notice',async()=>{
  const f=fixture();await f.api.refresh(true);
  f.storage.set('https://fixture.test|one|notices:sync',JSON.stringify({ids:f.rows().map(row=>row.id)}));f.context.clearNotices();
  await f.api.refresh(true);assert.equal(f.rows().length,0);
  f.context.reply=()=>({updates:[{key:'terms',revisionId:'t2',action:'accept'}]});await f.api.refresh(true);
  assert.equal(f.rows().length,1);assert.equal(f.rows()[0].id,'legal_update_terms_t2');
  assert.ok(f.calls.every(call=>call.op==='legalStatus'));
});
test('scopes isolate accounts and hubs, and a late response cannot write to the next account',async()=>{
  const f=fixture();let complete;f.context.reply=()=>new Promise(resolve=>{complete=resolve;});
  const request=f.api.refresh(true);await settle();f.scope('two');complete({updates:[{key:'terms',revisionId:'old',action:'accept'}]});await request;
  assert.equal(f.rows().length,0);
  f.context.reply=()=>({updates:[{key:'privacy',revisionId:'p1',action:'notice'}]});await f.api.refresh(true);
  assert.equal(f.rows()[0].recipientId,'two');f.scope('two','https://another.test');await f.api.refresh(true);
  assert.equal(f.rows().length,1);assert.equal(f.storage.size,2);
});
test('coalesced checks recover after synchronous API failure and ignore a queued scope change',async()=>{
  const f=fixture();f.context.SoduWorkAPI.clientAccountRequest=()=>{throw Error('offline');};
  assert.equal(await f.api.refresh(true),null);
  let count=0;f.context.SoduWorkAPI.clientAccountRequest=async()=>{count++;return {updates:[]};};
  const first=f.api.refresh(true);assert.equal(first,f.api.refresh(true));await first;assert.equal(count,1);
  const queued=f.api.refresh(true);f.scope('two');assert.equal(await queued,null);assert.equal(count,1);
});
test('read history opens its immutable revision without creating consent or substituting a newer version',async()=>{
  const f=fixture();await f.api.refresh(true);const notice=f.rows()[0];
  f.context.reply=op=>op==='legalStatus'?{documents:[f.documentRow('privacy','p2')],updates:[]}
    :{documents:[f.documentRow('privacy','p1'),f.documentRow('terms','t1')]};
  assert.equal(await f.api.openNotice(notice),true);assert.equal(f.readers.length,1);
  assert.equal(f.readers[0].rows.length,1);assert.equal(f.readers[0].rows[0].revisionId,'p1');
  assert.equal(f.calls.at(-1).op,'legalVersion');assert.equal(f.calls.at(-1).payload.id,'p1');
  assert.ok(f.calls.every(call=>call.op!=='legalResponse'));
});
test('failed refresh, foreign recipients, and missing historical versions never consume or accept a notice',async()=>{
  const f=fixture();await f.api.refresh(true);const notice=f.rows()[0];
  assert.equal(await f.api.openNotice({...notice,recipientId:'two'}),false);
  f.context.reply=()=>{throw Error('offline');};await assert.rejects(f.api.openNotice(notice),/协议内容暂未加载/);
  f.context.reply=()=>({documents:[],updates:[]});await assert.rejects(f.api.openNotice(notice),/协议内容暂未加载/);
  f.context.reply=op=>{if(op==='legalStatus')return {documents:[],updates:[]};throw Error('private transport failure');};
  await assert.rejects(f.api.openNotice(notice),/协议内容暂未加载/);
  assert.equal(f.readers.length,0);assert.ok(f.rows().every(row=>!row.read));
  assert.ok(f.calls.every(call=>call.op!=='legalResponse'));
});
