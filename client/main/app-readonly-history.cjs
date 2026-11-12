'use strict';
const fs=require('node:fs'),path=require('node:path');
const defaultAccess=require('./conversation/history-access');
async function plainArchivePath(base, file) {
 // The application supplies the archive root. Its parent may use a trusted OS
 // alias (for example /var on macOS); links inside the archive remain forbidden.
 if ((await fs.promises.lstat(base)).isSymbolicLink()) throw Error('会话存档路径不能经过链接或联接点');
 // The archive index returns native canonical paths; Windows userData may
 // still contain an 8.3 alias. Compare both in the same filesystem namespace.
 const [root, real] = await Promise.all([fs.promises.realpath(base), fs.promises.realpath(file)]);
 const relative = path.relative(root, real);
 if (!relative || relative === '..' || relative.startsWith('..' + path.sep) ||
     path.isAbsolute(relative) || path.extname(real).toLowerCase() !== '.jsonl') throw Error('会话存档路径不受信任');
 // Inspect the original spelling too, so resolving a junction cannot hide a
 // linked archive subtree. Stop at the same root even when Windows uses 8.3 names.
 for (let cursor = path.resolve(file);;) {
  if ((await fs.promises.lstat(cursor)).isSymbolicLink()) throw Error('会话存档路径不能经过链接或联接点');
  if (!path.relative(root, await fs.promises.realpath(cursor))) break;
  const parent = path.dirname(cursor);
  if (parent === cursor) throw Error('会话存档路径不受信任');
  cursor = parent;
 }
 require('./plugin-resources').assertNoLinks(root, real);
 return real;
}
function publicRow(row){return {id:String(row.id||row.sessionId||''),title:String(row.title||row.name||''),adapterId:String(row.adapterId||'pi'),cloud:row.cloud===true,at:row.at||0};}
function eventsPage(data,p,segments){
 const events=Array.isArray(data.items)?data.items:[],end=events.reduce((n,x)=>Math.max(n,Number(x.seq)||0),p.after||0),latest=Number(data.seq??data.last??end);
 if(!events.length&&latest>end)throw Error('消息分页未前进，请稍后重试');
 return {ok:true,format:'events',items:events.filter(x=>['user','say','text'].includes(x.kind)).map(x=>({id:String(x.seq),role:x.kind==='user'?'user':'assistant',text:String(x.full??x.text??''),delta:x.full==null&&x.delta===true,streamId:[x.round||x._round||1,x.seg||1,x.kind,x.streamId||x.seq].join(':'),done:x.done===true})),segments,cursor:end,nextAfter:latest>end?end:null};
}
function create({app,session=require('./agent-runtime/pi-session-bridge'),access=defaultAccess,runner=require('./runner-runtime'),readCloud,localOnly=false}){
 const readNativePage=require('./conversation/native-transcript-pages.cjs').create();
 return async function handle(method,p,assertCurrent=()=>{}){
  const captured=access.actor(app);const guard=()=>{access.assertCurrent(app,captured);assertCurrent();};guard();
  if(method==='conversations.list'){
   const r=await (p.archived?session.archivedHistory(app,Number.MAX_SAFE_INTEGER):session.history(app,Number.MAX_SAFE_INTEGER));guard();
   if(r.ok===false)throw Error(r.reason);const rows=(r.chats||[]).filter(row=>{try{access.assertOwner(app,row.id,captured,row);return true;}catch{return false;}});
   const end=(p.offset||0)+(p.limit||50);return {ok:true,items:rows.slice(p.offset||0,end).map(publicRow),nextOffset:end<rows.length?end:null};
  }
  const row=await session.archivedConversation(app,p.id,localOnly?{nativeOnly:true,strict:true}:{});guard();if(!row)throw Error('会话不存在');access.assertOwner(app,p.id,captured,row);
  if(row.remoteProjection===true&&row.cloud===true){
   if(localOnly)throw Error('云端正文尚未保存到本机');
   const taskId=String(row.taskId||''),ref=String(row.ref||'');
   if(!taskId||!ref)throw Error('云端会话执行标识不完整，暂无正文');
   let data;
   if(readCloud)data=await readCloud(captured.identity,{sessionId:p.id,taskId,ref,owner:row.owner,phase:'committed'},p);
   else{
    const route='/api/v1/tasks/'+encodeURIComponent(taskId)+'/ai-session?ref='+encodeURIComponent(ref)+'&since='+(p.after||0)+'&limit='+(p.limit||50);
    const response=await require('./device-auth-request').fetchWithDeviceAuthRetry(captured.identity,String(captured.identity?.hub||'').replace(/\/+$/,'')+route,{redirect:'error',signal:AbortSignal.timeout(15000)});
    data=await response.json();if(!response.ok||data.ok===false)throw Error(data.detail||data.reason||'云端会话读取失败');
   }
   guard();if(data.ref&&data.ref!==ref)throw Error('云端会话执行标识不匹配');
   return eventsPage(data,p,[]);
  }
  const cloudFile=path.join(app.getPath('userData'),'conversation-handoffs',require('node:crypto').createHash('sha256').update(p.id).digest('hex')+'.json');
  if(!localOnly&&fs.existsSync(cloudFile)){
   require('./plugin-resources').assertNoLinks(app.getPath('userData'),cloudFile);
   const cloud=JSON.parse(await fs.promises.readFile(cloudFile,'utf8'));guard();
   if(cloud.sessionId!==p.id||cloud.owner!==require('./platform-connections/runtime.cjs').connectionScope(captured.identity))throw Error('云端会话归属记录无效');
   if(cloud.phase!=='aborted'){
    if(!cloud.taskId||!cloud.ref)throw Error('云端会话尚未接收，暂无正文');
    if(p.segmentId&&p.segmentId!==p.id)throw Error('云端会话不接受其他本地分段');
    let data;
    if(readCloud)data=await readCloud(captured.identity,cloud,p);
    else{
     const route='/api/v1/tasks/'+encodeURIComponent(cloud.taskId)+'/ai-session?ref='+encodeURIComponent(cloud.ref)+'&since='+(p.after||0)+'&limit='+(p.limit||50);
     const response=await require('./device-auth-request').fetchWithDeviceAuthRetry(captured.identity,String(captured.identity?.hub||'').replace(/\/+$/,'')+route,{redirect:'error',signal:AbortSignal.timeout(15000)});
     data=await response.json();if(!response.ok||data.ok===false)throw Error(data.detail||data.reason||'云端会话读取失败');
    }
    guard();if(data.ref&&data.ref!==cloud.ref)throw Error('云端会话执行标识不匹配');
    return eventsPage(data,p,[]);
   }
  }
  const record=require('./conversation/runtime-segments').read(app,p.id);
  const parts=record?[...record.segments,record.active].filter(Boolean):[{sessionId:p.id,adapterId:row.adapterId||'pi'}];
  const segments=[...new Map(parts.map(x=>[x.sessionId,{id:x.sessionId,adapterId:x.adapterId}])).values()];
  if(record&&!p.segmentId)return {ok:true,items:[],segments,requiresSegment:true,nextOffset:null};
  const selected=p.segmentId?segments.find(x=>x.id===p.segmentId):segments[0];if(!selected)throw Error('会话分段不属于所选会话');
  if(selected.adapterId!=='pi'){
   const reply=await runner.rpc('job.session',{ref:selected.id,since:p.after||0,limit:p.limit||50},15000);guard();const data=reply?.data;
   if(reply?.ok===false||!data||data.ok===false)throw Error(reply?.error||data?.error||'执行底座无法读取消息');
   return eventsPage(data,p,segments);
  }
  const found=await session.historyEntry(app,selected.id);guard();if(!found?.ok||!found.entry?.path)throw Error(found?.reason||'会话存档不可用');
  const base=path.join(app.getPath('userData'),'pi-agent'),file=found.entry.path;
  const real=await plainArchivePath(base,file);guard();
  const stat=await fs.promises.stat(real);if(!stat.isFile()||stat.size>128*1024*1024)throw Error('会话存档过大或不是普通文件');
  const page=await readNativePage(real,p,guard);
  return {ok:true,format:'messages',...page,segments};
 };
}
async function handle(app,method,params,guard){return create({app})(method,params,guard);}
module.exports={create,handle};
