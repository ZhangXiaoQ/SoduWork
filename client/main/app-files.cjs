'use strict';
// App/account scoped plain files. Bytes never pass through SQLite or an HTTP server.
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), crypto = require('node:crypto');
const {Readable} = require('node:stream');
const contract = require('../core/app-files-contract.cjs');
const settings = require('./app-settings-store.cjs');
const uploads = new Map(), completed = new Map(),copies=new Map();
const sources=require('./app-local-sources.cjs');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const projectKey = value => 'p_' + hash(value);
const uuid = prefix => prefix + crypto.randomUUID().replace(/-/g,'');
const extension = type => ({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/bmp':'bmp','image/avif':'avif','video/mp4':'mp4','video/webm':'webm','audio/mpeg':'mp3','application/pdf':'pdf'})[type] || 'bin';
async function directory(app, scope, parts, create) {
  let dir = path.resolve(app.getPath('userData'));
  for (const part of ['jiyong-files',scope,...parts]) {
    if (!/^[a-z0-9_.-]+$/i.test(part) || part==='.' || part==='..') throw Error('文件目录无效');
    dir = path.join(dir,part);
    if (create) { try { await fsp.mkdir(dir,{mode:0o700}); } catch(e) { if(e.code!=='EEXIST')throw e; } }
    const st = await fsp.lstat(dir); if (!st.isDirectory() || st.isSymbolicLink()) throw Error('文件目录不可用');
  }
  return dir;
}
function url(binding, file) { return new URL('/_app-files/'+projectKey(file.projectId)+'/'+file.id+'/'+encodeURIComponent(file.name),binding.origin).href; }
async function metadata(app, scope, project, id) {
  const dir = await directory(app,scope,['projects',project,'files'],false);
  const metaPath=path.join(dir,id+'.json'),st=await fsp.lstat(metaPath);
  if(!st.isFile()||st.isSymbolicLink()||st.size>4096)throw Error('文件记录无效');
  const file=JSON.parse(await fsp.readFile(metaPath,'utf8'));
  if(file.id!==id || projectKey(file.projectId)!==project || !contract.ID.test(file.id) || !Number.isSafeInteger(file.size) || file.size<0 || file.size>contract.MAX_BYTES || !/^[a-f0-9]{64}$/.test(file.sha256))throw Error('文件记录无效');
  const binary=path.join(dir,id+'.'+extension(file.type)),stat=await fsp.lstat(binary);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==file.size)throw Error('文件缺失或大小不一致');
  return {file,binary};
}
async function execute(app,binding,method,input,assertCurrent=()=>{},options={}) {
  const p=contract.normalize(method,input),scope=settings.scope(binding);
  const current=()=>{assertCurrent();if(settings.scope(binding)!==scope)throw Error('文件账号已变化');};current();
  if(method==='files.pickLocal')return sources.select(scope,binding,current,options);
  if(method==='files.copyLocal'){
    const source=await sources.resolve(scope,binding,p.sourceId);current();const tag=scope+':'+p.projectId+':'+p.sourceId;
    if(copies.has(tag))return copies.get(tag);
    const work=(async()=>{const dir=await directory(app,scope,['projects',projectKey(p.projectId),'files'],true);current();const id=uuid('file_'),temp=path.join(dir,id+'.part'),binary=path.join(dir,id+'.'+extension(source.type));let published=false;
      try{await fsp.copyFile(source.path,temp,fs.constants.COPYFILE_EXCL);await sources.resolve(scope,binding,p.sourceId);current();
        const digest=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(temp,{highWaterMark:contract.CHUNK_BYTES})){digest.update(chunk);current();}
        const handle=await fsp.open(temp,'r+');try{const st=await handle.stat();if(st.size!==source.size)throw Error('复制文件大小不一致');await handle.sync();}finally{await handle.close();}
        await sources.resolve(scope,binding,p.sourceId);current();await fsp.rename(temp,binary);
        const file={id,projectId:p.projectId,name:source.name,type:source.type,size:source.size,sha256:digest.digest('hex'),createdAt:new Date().toISOString()};
        const meta=await fsp.open(path.join(dir,id+'.json'),'wx',0o600);try{await meta.writeFile(JSON.stringify(file));await meta.sync();}finally{await meta.close();}current();published=true;return {ok:true,file:{...file,url:url(binding,file)}};
      }finally{if(!published){await fsp.rm(temp,{force:true});await fsp.rm(binary,{force:true});await fsp.rm(path.join(dir,id+'.json'),{force:true});}}
    })();copies.set(tag,work);work.catch(()=>copies.delete(tag));return work;
  }
  if(method==='files.getUrl') {const {file}=await metadata(app,scope,projectKey(p.projectId),p.id);current();return {ok:true,file:{...file,url:url(binding,file)}};}
  const key=scope+':'+p.id;
  if(method==='files.finish' && completed.has(key)){current();return {ok:true,file:completed.get(key)};}
  if(method==='files.begin') {
    if([...uploads.values()].filter(r=>r.scope===scope).length>=4)throw Error('文件正在保存，请稍后重试');
    const dir=await directory(app,scope,['uploads'],true);current();
    const id=uuid('upload_'),temp=path.join(dir,id+'.part'),handle=await fsp.open(temp,'wx',0o600);
    function expire(){const row=uploads.get(scope+':'+id);if(!row)return;if(row.busy){row.expiry=setTimeout(expire,10000);row.expiry.unref();return;}uploads.delete(scope+':'+id);row.handle.close().then(()=>fsp.rm(row.temp,{force:true})).catch(()=>{});}
    const expiry=setTimeout(expire,10*60*1000);expiry.unref();
    uploads.set(scope+':'+id,{expiry,scope,id,temp,handle,projectId:p.projectId,name:p.name.replace(/.*[/\\]/,'')||'file',type:p.type.toLowerCase(),size:p.size,written:0,hash:crypto.createHash('sha256'),busy:false});
    return {ok:true,id,chunkBytes:contract.CHUNK_BYTES};
  }
  const row=uploads.get(key);if(!row||row.scope!==scope)throw Error('文件上传不存在或已取消');
  if(row.busy)throw Error('文件分块正在处理');row.busy=true;
  try {
    if(method==='files.cancel'){clearTimeout(row.expiry);uploads.delete(key);await row.handle.close();await fsp.rm(row.temp,{force:true});return {ok:true};}
    if(method==='files.append') {
      if(p.offset!==row.written || row.written+p.data.length>row.size)throw Error('文件分块顺序或大小无效');
      const bytes=Buffer.from(p.data);let offset=0;
      while(offset<bytes.length){const r=await row.handle.write(bytes,offset,bytes.length-offset,row.written+offset);if(!r.bytesWritten)throw Error('文件写入未完成');offset+=r.bytesWritten;}
      row.hash.update(bytes);row.written+=bytes.length;row.expiry.refresh();current();return {ok:true,offset:row.written};
    }
    if(row.written!==row.size)throw Error('文件尚未传输完整');
    await row.handle.sync();await row.handle.close();current();
    const file={id:uuid('file_'),projectId:row.projectId,name:row.name,type:row.type,size:row.size,sha256:row.hash.digest('hex'),createdAt:new Date().toISOString()};
    const dir=await directory(app,scope,['projects',projectKey(row.projectId),'files'],true);current();
    await fsp.rename(row.temp,path.join(dir,file.id+'.'+extension(file.type)));
    const meta=await fsp.open(path.join(dir,file.id+'.json'),'wx',0o600);
    try{await meta.writeFile(JSON.stringify(file));await meta.sync();}finally{await meta.close();}
    clearTimeout(row.expiry);uploads.delete(key);const result={...file,url:url(binding,file)};completed.set(key,result);
    if(completed.size>128)completed.delete(completed.keys().next().value);current();return {ok:true,file:result};
  } finally {row.busy=false;}
}
async function handle({item},request,deps) {
  const capability=['files.getUrl','files.pickLocal'].includes(request.method)?'data.read':'data.write';
  const {bound,installed,assertCurrent}=await require('./work-preview-app-connection.cjs').authorize(item,deps,capability);
  const schema=installed.jiyong||installed.localDraft?.jiyong;
  if(!schema || schema.storage?.location==='cloud')throw Error('受管本地文件需要本地数据应用');
  const origin=require('../core/plugin-package-page.cjs').origin(bound.pluginId);
  if(bound.origin!==origin)throw Error('受管文件 URL 当前仅支持包内应用');
  try{return await execute(deps.app,bound,request.method,request.params,assertCurrent,{dialog:deps.dialog});}
  catch(error){return {ok:false,code:'APP_FILE_IO',reason:error.code==='ENOSPC'?'磁盘空间不足，文件未保存':error.code?'文件不存在或无法读写':error.message};}
}
async function response(app,binding,request,assertCurrent=()=>{}) {
  assertCurrent();const scope=settings.scope(binding),target=new URL(request.url);
  const sourceMatch=/^\/_app-sources\/(source_[a-f0-9]{32})\/[^/]+$/.exec(target.pathname);
  if(sourceMatch&&target.origin===binding.origin&&['GET','HEAD'].includes(request.method)){const row=await sources.resolve(scope,binding,sourceMatch[1]);assertCurrent();if(settings.scope(binding)!==scope)throw Error('文件账号已变化');const headers={'Content-Type':row.type,'Content-Length':String(row.size),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"};if(request.method==='HEAD')return new Response(null,{headers});const body=Readable.from((async function*(){for await(const chunk of fs.createReadStream(row.path)){assertCurrent();if(settings.scope(binding)!==scope)throw Error('文件账号已变化');yield chunk;}})());return new Response(Readable.toWeb(body),{headers});}
  const match=/^\/_app-files\/(p_[a-f0-9]{64})\/(file_[a-f0-9]{32})\/[^/]+$/.exec(target.pathname);
  if(!match || target.origin!==binding.origin || !['GET','HEAD'].includes(request.method))return new Response('',{status:404});
  const {file,binary}=await metadata(app,scope,match[1],match[2]);assertCurrent();if(settings.scope(binding)!==scope)throw Error('文件账号已变化');
  const headers=new Headers({'Content-Type':/^(image|audio|video)\//.test(file.type)?file.type:'application/octet-stream','Content-Length':String(file.size),'Accept-Ranges':'bytes','ETag':'"'+file.sha256+'"','Cache-Control':'private, no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Content-Disposition':(/^(image|audio|video)\//.test(file.type)?'inline':'attachment')+"; filename*=UTF-8''"+encodeURIComponent(file.name)});
  const incoming=new Headers(request.headers||{}),range=incoming.get('range');
  if(!range && incoming.get('if-none-match')===headers.get('ETag')){headers.delete('Content-Length');return new Response(null,{status:304,headers});}
  let start=0,end=file.size-1,status=200;
  if(range && (!incoming.get('if-range') || incoming.get('if-range')===headers.get('ETag'))) {
    const r=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(!r || !file.size || !r[1]&&!r[2]){headers.set('Content-Range','bytes */'+file.size);headers.set('Content-Length','0');return new Response(null,{status:416,headers});}
    if(r[1]){start=Number(r[1]);end=r[2]?Math.min(end,Number(r[2])):end;}else start=Math.max(0,file.size-Number(r[2]));
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=file.size){headers.set('Content-Range','bytes */'+file.size);headers.set('Content-Length','0');return new Response(null,{status:416,headers});}
    status=206;headers.set('Content-Range','bytes '+start+'-'+end+'/'+file.size);headers.set('Content-Length',String(end-start+1));
  }
  if(request.method==='HEAD' || !file.size)return new Response(null,{status,headers});
  const stream=fs.createReadStream(binary,{start,end,highWaterMark:64*1024});
  const guarded=Readable.from((async function*(){for await(const chunk of stream){assertCurrent();if(settings.scope(binding)!==scope)throw Error('文件账号已变化');yield chunk;}})());
  if(request.signal){const stop=()=>guarded.destroy(Error('文件读取已取消'));request.signal.addEventListener('abort',stop,{once:true});guarded.once('close',()=>request.signal.removeEventListener('abort',stop));}
  return new Response(Readable.toWeb(guarded),{status,headers});
}
module.exports={execute,handle,response};
