'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {create}=require('../main/pi-session/app-mcp-proxy.cjs');
test('MCP changed metadata is scoped, bounded and notification-only',async t=>{
 let revision=1,mode='saved',notifications=[];
 const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{
  let result={content:[],_meta:{'soduwork.app/data-changed':{spaceId:mode==='foreign'?'other':'team',topicId:'topic',token:'must-not-forward'}}};
  if(mode==='read')result={content:[]};if(mode==='error')result={isError:true,...result};
  if(mode==='oversize')result.content=[{text:'x'.repeat(270000)}];
  if(mode==='revoke')revision++;
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:1,result}));
 });});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const lease=await create({url:'http://127.0.0.1:'+server.address().port+'/mcp',revision:1,token:'fixture',context:{spaceId:'team'},readCurrent:()=>({revision,token:'fixture'}),notifyChanged:value=>notifications.push(value)});
 t.after(()=>{lease.cleanup();server.closeAllConnections();server.close();});
 async function call(){const r=await fetch(lease.url,{method:'POST',headers:{Authorization:'Bearer '+lease.token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call'})});return {status:r.status,body:await r.json()};}
 const first=await call();assert.equal(first.status,200);assert.deepEqual(notifications,[{topic:'content',spaceId:'team',topicId:'topic'}]);assert.equal(first.body.result._meta['soduwork.app/data-changed'].token,'must-not-forward','Upstream response is not rewritten by observing it');
 for(mode of ['read','foreign','error','oversize']){assert.equal((await call()).status,200);assert.equal(notifications.length,1,mode);}
 mode='revoke';await call();assert.equal(notifications.length,1,'Changed authority suppresses a late notification');
});
