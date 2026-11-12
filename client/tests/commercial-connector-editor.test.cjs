'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=['connector-config.js','connector-auth.js','connector-editor.js','panels-capability-editors.js'].map(f=>fs.readFileSync(path.join(__dirname,'../components/panels/'+f),'utf8')).join('\n');
function setup(initial, options = {}) {
 const template={key:'connector-test',name:'Test service',configurable:true,permissions:[],officialDocs:['https://example.com/docs'],limitations:[],tools:[{name:'read'}],connectionFields:[{key:'TENANT',label:'Tenant',required:true},{key:'TOKEN',label:'Token',secret:true,required:true},{key:'ALLOW_WRITES',label:'Write',type:'boolean'}]};
 const doc={createElement(tag){return {tag,children:[],textContent:'',append(...nodes){this.children.push(...nodes)},replaceChildren(...nodes){this.children=nodes},get innerHTML(){return this.textContent+this.children.map(n=>'<'+n.tag+'>'+n.innerHTML+'</'+n.tag+'>').join('')},set innerHTML(x){this.textContent=x;this.children=[]}};}};
 const nodes=new Map(),notices=[],calls={save:0,probe:0,preflight:0,catalog:0,state:0,close:0,render:0,onSaved:0};
 let html='',saved,owner='owner-a',revision=0;
 const decode=s=>s.replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&amp;/g,'&');
 const layer={hidden:false,isConnected:true,querySelector:s=>nodes.get(s)||null,querySelectorAll:s=>s==='[data-connector-field]'?[...nodes.values()].filter(x=>x.dataset.connectorField):s==='#capModalBody input, #capModalBody textarea, #capModalBody select'?[...nodes.values()].filter(x=>x.tag==='input'||x.tag==='textarea'||x.tag==='select'):[...nodes.values()]};
 function open(_title,_sub,body,foot){
  revision++;layer.hidden=false;nodes.clear();html=body+foot;
  for(const m of html.matchAll(/<(input|button|textarea|div|select)\b([^>]*)(?:>([^<]*))?/g)){
   const attrs=m[2],id=/id="([^"]+)"/.exec(attrs)?.[1],key=/data-connector-field="([^"]+)"/.exec(attrs)?.[1];if(!id&&!key)continue;
   nodes.set(id?'#'+id:'field:'+key,{...doc.createElement(m[1]),ownerDocument:doc,tag:m[1],disabled:/ disabled/.test(attrs),value:decode(/value="([^"]*)"/.exec(attrs)?.[1]||m[3]||''),checked:/ checked/.test(attrs),type:/type="([^"]*)"/.exec(attrs)?.[1],dataset:{connectorField:key},events:{},focus(){},addEventListener(e,fn){const prev=this.events[e];this.events[e]=prev?function(...args){prev.apply(this,args);return fn.apply(this,args);}:fn;}});
  }for(const n of nodes.values())Object.defineProperty(n,'innerHTML',{get(){return this.textContent+this.children.map(c=>'<'+c.tag+'>'+c.innerHTML+'</'+c.tag+'>').join('')},set(x){this.textContent=x;this.children=[]}});return layer;
 }
 const window={crypto:require('node:crypto')};vm.runInNewContext(source,{window,Set,Array,Object,JSON,URL,setTimeout:fn=>fn()});
 if(options.database){
   const def=require('../../skills/mcp-tools/connectors/providers/'+options.database+'.json');
   Object.assign(template,{key:'connector-'+def.id,template:{command:'soduwork-connector'},connectionFields:def.fields});
 }
 const directQuery=layer.querySelector;
 layer.querySelector=selector=>directQuery(selector)||nodes.get('field:'+/^\[data-connector-field="([^"]+)"\]$/.exec(selector)?.[1])||null;
 const data={mcpTemplates:[template]};
 const api={
  taskStorageKey:()=>owner,
  saveMyMcpServer:async (row,original)=>{calls.save++;saved=[row];calls.original=original;return options.save?options.save([row]):{personal:[row]};},
  capabilityCatalog:async()=>{calls.catalog++;return options.catalog?options.catalog():data;},
  preflightMyMcpServer:async spec=>{calls.preflight++;return options.preflight?options.preflight(spec):{ok:true};},
  probeMyMcpServer:async spec=>{calls.probe++;return options.probe?options.probe(spec):{ok:true,tools:['read'],toolCount:1,authenticationTested:true};},
 };
 const ctx={api,h:s=>String(s??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;'),say:s=>notices.push(s),errorText:(e,f)=>e.message||f,
  openModal:open,closeModal(){calls.close++;revision++;layer.hidden=true;},viewRevision:()=>revision,
  load(){},render(){calls.render++;},mcp:{personal:initial?[initial]:[]},companyMcp:new Set(),data,
  setState(mcp,data){calls.state++;ctx.mcp=mcp;ctx.data=data;}};
 function reopen(value=initial){window.SoduWorkCapabilityEditors.create(ctx).openMcpEditor(value,value?null:template,{onSaved(){calls.onSaved++;return options.onSaved?.();}});}
 reopen();
 if(!initial&&!options.database){nodes.get('field:TENANT').value='company';nodes.get('field:TOKEN').value='private-token';}
 return {nodes,layer,calls,api,reopen,get saved(){return saved;},get html(){return html;},get notice(){return notices.at(-1)||'';},
  close:()=>ctx.closeModal(),leave(){revision++;},switchOwner(){owner='owner-b';},
  change(id,value,event='input'){const node=nodes.get(id);if(node.type==='checkbox')node.checked=value;else node.value=value;node.events[event]?.call(node);},
  async click(id){const node=nodes.get(id);await node.events.click.call(node);}};
}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
async function settle(){await new Promise(resolve=>setImmediate(resolve));}

for (const [database,key,expected] of [['postgres','PG_PORT','5432'],['mysql','MYSQL_PORT','3306'],
  ['mongodb','MONGO_PORT','27017'],['redis','REDIS_PORT','6379']]) test(database+' shows its declared editable port next to the host',()=>{
  const f=setup(null,{database}), basic=f.html.split('<details')[0];
  assert.ok(basic.includes('data-connector-field="'+key+'"'));
  assert.equal(f.nodes.get('field:'+key).value,expected);
});
test('Redis preserves custom ports, masked ACL credentials and explicit local TLS choices on retry',async()=>{
 const env={REDIS_HOST:'localhost',REDIS_PORT:'16379',REDIS_USER:'reader',REDIS_PASSWORD:'••••••••',REDIS_TLS:'false',REDIS_DB:'0'};
 const f=setup({id:'local',name:'Cache',templateKey:'connector-redis',type:'stdio',env},{database:'redis'});
 assert.equal(f.nodes.get('field:REDIS_TLS').checked,false);
 await f.click('#capMcpSave');for(const [key,value] of Object.entries(env))assert.equal(f.saved[0].env[key],value);
});
test('invalid Redis settings block probes, while an empty port restores the visible catalog default',async()=>{
 const f=setup(null,{database:'redis'}); f.change('field:REDIS_HOST','cache.example.invalid');
 f.change('field:REDIS_PORT','65536');await f.click('#capMcpCheck');assert.equal(f.calls.preflight,0);
 f.change('field:REDIS_PORT','');f.change('field:REDIS_TLS',false);await f.click('#capMcpCheck');assert.equal(f.calls.probe,0);
 assert.equal(f.nodes.get('field:REDIS_PORT').value,'6379');
 f.change('field:REDIS_HOST','::1');f.change('field:REDIS_USER','reader');await f.click('#capMcpCheck');assert.equal(f.calls.probe,0);
 f.change('field:REDIS_USER','');await f.click('#capMcpSave');assert.equal(f.saved[0].env.REDIS_TLS,'false');assert.equal(f.saved[0].env.REDIS_PORT,'6379');
});

test('one connection action validates and enables, while writes stay off',async()=>{
 const f=setup();assert.match(f.html,/type="password"/);assert.equal(f.nodes.has('#capMcpEnabled'),false);assert.equal(f.nodes.has('#capMcpApprove'),false);assert.equal(f.nodes.get('field:ALLOW_WRITES').checked,false);
 f.nodes.get('field:TENANT').value='company';f.nodes.get('field:TOKEN').value='private-token';
 await f.click('#capMcpSave');assert.equal(f.saved[0].env.TOKEN,'private-token');assert.equal(f.saved[0].env.ALLOW_WRITES,'false');assert.equal(f.saved[0].enabled,true);assert.equal(f.calls.probe,1);assert.equal(f.calls.preflight,1);assert.match(f.saved[0].id,/^[0-9a-f-]{36}$/);assert.equal(f.calls.original,null);
});
test('editing rehydrates the catalog and preserves masked credential and write permission',async()=>{
 const f=setup({id:'one',name:'saved',type:'stdio',templateKey:'connector-test',canEdit:true,env:{TOKEN:'••••••••',TENANT:'company',ALLOW_WRITES:'true'},enabled:true});
 assert.equal(f.nodes.get('field:TOKEN').value,'••••••••');assert.equal(f.nodes.get('field:ALLOW_WRITES').checked,true);
 await f.click('#capMcpSave');assert.equal(f.saved[0].env.ALLOW_WRITES,'true');assert.equal(f.saved[0].env.TENANT,'company');assert.equal(f.calls.original.id,'one');assert.equal(f.calls.original.env.TOKEN,'••••••••');
});
test('tool list validation does not claim vendor authorization or successful business use',async()=>{
 const f=setup(null,{probe:async()=>({ok:true,tools:['read'],authenticationTested:false})});await f.click('#capMcpCheck');assert.match(f.nodes.get('#capMcpProbe').innerHTML,/业务授权尚未验证/);
 await f.click('#capMcpSave');assert.match(f.notice,/业务授权待验证/);
});

for(const ending of ['success','failure'])test('late save '+ending+' never closes or refreshes a replacement dialog',async()=>{
 const wait=deferred(),f=setup(null,{save:()=>wait.promise});
 const pending=f.click('#capMcpSave');await settle();f.close();f.reopen();f.change('field:TENANT','new-draft');
 const current=f.nodes.get('#capMcpSave');if(ending==='success')wait.resolve({personal:[]});else wait.reject(Error('old-error'));await pending;
 assert.equal(f.layer.hidden,false);assert.equal(f.nodes.get('#capMcpSave'),current);assert.equal(f.nodes.get('field:TENANT').value,'new-draft');
 assert.equal(f.calls.close,1);assert.equal(f.calls.state,0);assert.equal(f.calls.catalog,0);assert.equal(f.calls.render,0);assert.equal(f.calls.onSaved,0);assert.equal(f.notice,'');
});
for(const exit of ['closed','replaced','account','navigation'])test('late preflight after '+exit+' never starts device probing',async()=>{
 const wait=deferred(),f=setup(null,{preflight:()=>wait.promise});
 const pending=f.click('#capMcpCheck');if(exit==='closed')f.close();else if(exit==='replaced')f.reopen();else if(exit==='account')f.switchOwner();else f.leave();
 const current=f.nodes.get('#capMcpProbe'),before=current.innerHTML;wait.resolve({ok:true});await pending;
 assert.equal(f.calls.probe,0);assert.equal(current.innerHTML,before);
});
test('changing configuration invalidates pending probe and stale response cannot replace a newer result',async()=>{
 const old=deferred(),fresh=deferred();let n=0;const f=setup(null,{probe:()=>++n===1?old.promise:fresh.promise});
 const first=f.click('#capMcpCheck');await settle();
 f.change('field:TOKEN','new-token');assert.equal(f.nodes.get('#capMcpCheck').disabled,false);
 assert.match(f.nodes.get('#capMcpProbe').innerHTML,/配置已更新/);
 const second=f.click('#capMcpCheck');await settle();fresh.resolve({tools:['new_tool'],toolCount:1});await second;
 const shown=f.nodes.get('#capMcpProbe').innerHTML;old.reject(Error('old-probe-error'));await first;
 assert.equal(f.calls.probe,2);assert.equal(f.nodes.get('#capMcpProbe').innerHTML,shown);assert.match(shown,/连接配置已就绪/);
});
test('configuration fingerprint catches programmatic changes even without an input event',async()=>{
 const wait=deferred(),f=setup(null,{preflight:()=>wait.promise});
 const pending=f.click('#capMcpCheck');await settle();f.nodes.get('field:TOKEN').value='changed-without-event';wait.resolve({ok:true});await pending;
 assert.equal(f.calls.probe,0);assert.equal(f.nodes.get('#capMcpCheck').disabled,false);assert.match(f.nodes.get('#capMcpProbe').innerHTML,/配置已更新/);
});
test('explicit negative probe response is not displayed as successful discovery',async()=>{
 const f=setup(null,{probe:async()=>({ok:false,error:'rejected'})});await f.click('#capMcpCheck');
 assert.match(f.nodes.get('#capMcpProbe').innerHTML,/rejected/);assert.match(f.nodes.get('#capMcpProbe').className,/bad/);
 assert.equal(f.nodes.get('#capMcpCheck').disabled,false);
});
test('late catalog refresh after saving cannot overwrite another dialog or resume old plugin flow',async()=>{
 const wait=deferred(),f=setup(null,{catalog:()=>wait.promise});
 const pending=f.click('#capMcpSave');await settle();assert.equal(f.calls.state,1);assert.equal(f.calls.close,1);
 f.reopen();f.change('field:TENANT','new-draft');wait.resolve({mcpTemplates:[]});await pending;
 assert.equal(f.calls.state,1);assert.equal(f.calls.render,0);assert.equal(f.calls.onSaved,0);assert.equal(f.layer.hidden,false);
 assert.equal(f.nodes.get('field:TENANT').value,'new-draft');
});
test('save runs once on rapid clicks, locks submitted fields and still allows closing',async()=>{
 const wait=deferred(),f=setup(null,{save:()=>wait.promise});
 const one=f.click('#capMcpSave'),two=f.click('#capMcpSave');await settle();assert.equal(f.calls.save,1);assert.equal(f.nodes.get('field:TOKEN').disabled,true);
 assert.equal(f.nodes.get('#capModalCancel').disabled,false);wait.resolve({personal:[]});await Promise.all([one,two]);
 assert.equal(f.calls.close,1);assert.equal(f.calls.render,1);assert.equal(f.calls.onSaved,1);
});
test('failed save keeps the current draft and unlocks fields for a safe retry',async()=>{
 let n=0;const f=setup(null,{save:async rows=>{if(++n===1)throw Error('save-failed');return{personal:rows};}});
 f.change('field:TENANT','company');await f.click('#capMcpSave');
 assert.equal(f.layer.hidden,false);assert.equal(f.nodes.get('field:TENANT').value,'company');assert.equal(f.nodes.get('field:TOKEN').disabled,false);
 assert.equal(f.nodes.get('#capMcpSave').disabled,false);const submittedId=f.saved[0].id;await f.click('#capMcpSave');assert.equal(f.saved[0].id,submittedId);assert.equal(f.calls.save,2);assert.equal(f.calls.onSaved,1);
});
test('catalog failure after committed save states that save succeeded instead of suggesting resubmission',async()=>{
 const f=setup(null,{catalog:async()=>{throw Error('catalog-unavailable');}});await f.click('#capMcpSave');
 assert.equal(f.calls.save,1);assert.equal(f.calls.state,1);assert.equal(f.calls.close,1);assert.match(f.notice,/连接已经保存/);assert.equal(f.calls.onSaved,1);
});
test('changing account while saving cannot apply old account state or notification',async()=>{
 const wait=deferred(),f=setup(null,{save:()=>wait.promise});
 const pending=f.click('#capMcpSave');await settle();f.switchOwner();wait.resolve({personal:[]});await pending;
 assert.equal(f.calls.state,0);assert.equal(f.calls.close,0);assert.equal(f.notice,'');
});
test('pending probe cannot update replacement dialog or bypass connection checks',async()=>{
 const wait=deferred(),f=setup(null,{probe:()=>wait.promise});
 const probe=f.click('#capMcpCheck');await settle();await f.click('#capMcpSave');f.reopen();
 const current=f.nodes.get('#capMcpProbe'),before=current.innerHTML;wait.resolve({tools:['old_tool'],toolCount:1});await probe;
 assert.equal(current.innerHTML,before);assert.equal(f.calls.save,0);
});

test('post-save continuation failure does not claim that the committed connection was lost',async()=>{
 const f=setup(null,{onSaved:async()=>{throw Error('next-step-failed');}});
 await f.click('#capMcpSave');assert.equal(f.calls.save,1);assert.equal(f.calls.onSaved,1);assert.match(f.notice,/连接已保存/);assert.match(f.notice,/next-step-failed/);
});
test('connect cannot bypass a pending check, and draft save does not probe or enable',async()=>{
 const wait=deferred(),f=setup(null,{probe:()=>wait.promise});
 const probe=f.click('#capMcpCheck');await settle();await f.click('#capMcpSave');assert.equal(f.calls.save,0);
 wait.resolve({ok:false,error:'needs-auth'});await probe;await f.click('#capMcpDraft');
 assert.equal(f.calls.save,1);assert.equal(f.saved[0].enabled,false);assert.equal(f.calls.probe,1);
});
test('failed business authorization never saves or enables the connector',async()=>{
 const f=setup(null,{probe:async()=>({ok:false,connectionState:'needs_auth',error:'授权已失效'})});
 await f.click('#capMcpSave');assert.equal(f.calls.save,0);assert.equal(f.nodes.get('field:TOKEN').value,'private-token');
 assert.equal(f.nodes.get('field:TOKEN').disabled,false);assert.match(f.nodes.get('#capMcpProbe').innerHTML,/授权已失效/);
});
test('missing required credentials are focused without any remote calls',async()=>{
 const f=setup();f.change('field:TOKEN','');await f.click('#capMcpSave');assert.equal(f.calls.preflight,0);assert.equal(f.calls.probe,0);assert.equal(f.calls.save,0);
});
