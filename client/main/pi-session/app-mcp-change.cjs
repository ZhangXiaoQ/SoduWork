"use strict";
// Optional MCP metadata becomes a scoped notification, never an automatic refresh.
function observe(reply,connection,closed){
 if(typeof connection.notifyChanged!=='function'||reply.statusCode!==200||!String(reply.headers['content-type']||'').includes('application/json'))return;
 let chunks=[],size=0;
 reply.on('data',chunk=>{size+=chunk.length;if(size<=262144)chunks.push(chunk);else chunks=[];});
 reply.once('end',()=>{
  if(closed()||size>262144)return;
  try{
   const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(body.error||body.result?.isError)return;
   const change=body.result?._meta?.['soduwork.app/data-changed'];
   if(!change||typeof change.spaceId!=='string'||!change.spaceId||change.spaceId.length>200)return;
   if(connection.context?.spaceId&&change.spaceId!==connection.context.spaceId)return;
   const now=connection.readCurrent();
   if(closed()||now.revision!==connection.revision||now.token!==connection.token)return;
   connection.notifyChanged({topic:'content',spaceId:change.spaceId,...(typeof change.topicId==='string'&&change.topicId.length<=200?{topicId:change.topicId}:{})});
  }catch(_){}
 });
}
module.exports={observe};
