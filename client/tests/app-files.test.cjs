'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const files=require('../main/app-files.cjs'),store=require('../main/app-settings-store.cjs'),pages=require('../main/app-package-pages.cjs'),personal=require('../main/personal-plugins'),resources=require('../main/plugin-resources');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sw-app-files-')),app={getPath:()=>root};let account='account-a',route;
  store.configure({app,ownerOf:()=>account});
  const out=path.join(root,'source');require('../../skills/app-developer/scripts/scaffold.cjs').scaffold({out,key:'file-space',name:'Files'});
  const draftPath=path.join(out,'soduwork-plugin-draft.json'),draft=JSON.parse(fs.readFileSync(draftPath,'utf8'));
  draft.jiyong={version:1,storage:{location:'local'},parameters:[],collections:[{key:'records',indexes:[]}]};draft.ui.contributions[0].source.bridge={version:1,capabilities:['data.read','data.write']};
  const pluginId=personal.create(app,resources.collect(draft,draftPath,out)).plugin.pluginId;
  const binding={pluginId,origin:require('../core/plugin-package-page.cjs').origin(pluginId)};
  const session={setPermissionRequestHandler(){},setPermissionCheckHandler(){},protocol:{handle(_scheme,handler){route=handler;}}};
  const deps={app,session:{fromPartition:()=>session}};
  t.after(()=>{store.configure(undefined);fs.rmSync(root,{recursive:true,force:true});});
  return {root,app,binding,deps,open:()=>pages.prepare(deps,{pluginId,contributionId:'main'}),switchAccount:()=>{account='account-b';},request:r=>route(r),call:(method,p)=>files.execute(app,binding,method,p),item:()=>{const item={appBridge:{appId:'plugin:'+pluginId,origin:binding.origin,contributionId:'main'},view:{webContents:{getURL:()=>binding.origin+'/ui/index.html',isDestroyed:()=>false}}};require('../main/work-preview-app-owner.cjs').capture(item,deps);return item;}};
}
async function upload(f,projectId='project-1',type='image/png',bytes=Buffer.from('sample-image')) {
  const start=await f.call('files.begin',{projectId,name:'图片.png',type,size:bytes.length});
  await f.call('files.append',{id:start.id,offset:0,data:bytes});
  return {start,file:(await f.call('files.finish',{id:start.id})).file,bytes};
}
test('plain project files have stable direct URLs, immutable bytes, HEAD, cache validators and byte ranges',async t=>{
  const f=fixture(t);await f.open();const {start,file,bytes}=await upload(f);
  assert.match(file.url,/\/_app-files\/p_[a-f0-9]{64}\/file_[a-f0-9]{32}/);
  assert.equal((await f.call('files.finish',{id:start.id})).file.url,file.url,'uncertain finish retry returns the same file');
  let r=await f.request({url:file.url,method:'GET'});assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);assert.equal(r.headers.get('content-type'),'image/png');
  const tag=r.headers.get('etag');r=await f.request({url:file.url,method:'HEAD'});assert.equal(r.headers.get('content-length'),String(bytes.length));assert.equal(await r.text(),'');
  r=await f.request({url:file.url,method:'GET',headers:{'if-none-match':tag}});assert.equal(r.status,304);
  r=await f.request({url:file.url,method:'GET',headers:{range:'bytes=2-5'}});assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),'bytes 2-5/'+bytes.length);assert.equal(await r.text(),bytes.subarray(2,6).toString());
  r=await f.request({url:file.url,method:'GET',headers:{range:'bytes=-3'}});assert.equal(await r.text(),bytes.subarray(-3).toString());
  for(const range of ['bytes=999-','bytes=8-2','bytes=0-1,3-4','bytes=-0'])assert.equal((await f.request({url:file.url,method:'GET',headers:{range}})).status,416);
  assert.equal((await f.call('files.getUrl',{projectId:'project-1',id:file.id})).file.url,file.url);
  await assert.rejects(()=>f.call('files.getUrl',{projectId:'another',id:file.id}));
  const all=fs.readdirSync(path.join(f.root,'jiyong-files'),{recursive:true}).filter(n=>String(n).endsWith('.png'));assert.equal(all.length,1);assert.deepEqual(fs.readFileSync(path.join(f.root,'jiyong-files',all[0])),bytes,'ordinary image file contains no binary metadata header');
  const p2=await upload(f,'project-2');assert.notEqual(p2.file.url.split('/')[4],file.url.split('/')[4]);
});
test('file bridge validates chunk order, quotas, cancellation, installed capability and source',async t=>{
  const f=fixture(t);await f.open();const start=await f.call('files.begin',{projectId:'p',name:'x.png',type:'image/png',size:5});
  await assert.rejects(()=>f.call('files.append',{id:start.id,offset:1,data:Buffer.from('a')}),/顺序/);
  await assert.rejects(()=>f.call('files.finish',{id:start.id}),/完整/);
  await f.call('files.cancel',{id:start.id});await assert.rejects(()=>f.call('files.finish',{id:start.id}),/不存在/);
  const contract=require('../main/soduwork-app-bridge-contract.cjs');assert.equal(contract.METHOD_CAPABILITY['files.getUrl'],'data.read');assert.equal(contract.METHOD_CAPABILITY['files.begin'],'data.write');
  assert.throws(()=>contract.normalizeRequest({id:'a',method:'files.append',params:{id:'upload_'+'a'.repeat(32),offset:0,data:new Uint8Array(512*1024+1)}}),/512KiB/);
  assert.throws(()=>contract.normalizeRequest({id:'a',method:'files.getUrl',params:{projectId:'p',id:'../../private'}}));
  const r=await files.handle({item:f.item()},{method:'files.begin',params:{projectId:'p',name:'file.mp4',type:'video/mp4',size:0}},f.deps);assert.ok(r.ok);await files.handle({item:f.item()},{method:'files.cancel',params:{id:r.id}},f.deps);
  const missing=await files.handle({item:f.item()},{method:'files.getUrl',params:{projectId:'missing',id:'file_'+'a'.repeat(32)}},f.deps);assert.equal(missing.ok,false);assert.ok(!missing.reason.includes(f.root));
  const bad=f.item();bad.appBridge.origin='https://external.invalid';await assert.rejects(()=>files.handle({item:bad},{method:'files.begin',params:{projectId:'p',name:'a',type:'image/png',size:1}},f.deps),{code:'APP_ACCOUNT_CHANGED'});
});
test('account change, disabled app and active content cannot bypass file resource guards',async t=>{
  const f=fixture(t);await f.open();const {file}=await upload(f,'p','text/html',Buffer.from('<script>attack()</script>'));
  let r=await f.request({url:file.url,method:'GET'});assert.equal(r.headers.get('content-type'),'application/octet-stream');assert.match(r.headers.get('content-disposition'),/^attachment/);assert.match(r.headers.get('content-security-policy'),/sandbox/);await r.arrayBuffer();
  const handlers=new Map();personal.install({app:f.app,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)}});
  await handlers.get('personal-plugin-enable')(null,f.binding.pluginId,false);assert.equal((await f.request({url:file.url,method:'GET'})).status,403);
  await handlers.get('personal-plugin-enable')(null,f.binding.pluginId,true);f.switchAccount();assert.equal((await f.request({url:file.url,method:'GET',headers:{'if-none-match':'"'+file.sha256+'"'}})).status,403);
  await assert.rejects(()=>f.call('files.getUrl',{projectId:'p',id:file.id}));
});
test('SDK file import is chunked and returns a resource URL without reading binary data back',async()=>{
  const calls=[],window={addEventListener(){},soduWorkAppBridge:{async request(method,p){calls.push({method,p});if(method==='files.begin')return {ok:true,id:'upload_'+'a'.repeat(32),chunkBytes:512*1024};if(method==='files.append')return {ok:true,offset:p.offset+p.data.length};return {ok:true,file:{id:'file_'+'b'.repeat(32),url:'https://app.invalid/_app-files/p/f/a.png'}};}}};
  window.parent=window;vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../sdk/soduwork-app.js'),'utf8'),{window,location:{origin:'https://app.invalid'},document:{referrer:''},URL,setTimeout,Uint8Array});
  const progress=[],blob=new Blob([new Uint8Array(1100000)],{type:'image/png'});const result=await window.soduWorkApp.files.importFile(blob,{projectId:'p',onProgress:r=>progress.push(r.loaded)});
  assert.ok(result.file.url);assert.equal(calls.filter(r=>r.method==='files.append').length,3);assert.equal(progress.at(-1),blob.size);assert.ok(!calls.some(r=>r.method==='data.assetGet'));
});

test('native picker preview and copy use opaque authorized references without renderer bytes',async t=>{
 const f=fixture(t);await f.open();const source=path.join(f.root,'桌面 image.png'),bytes=Buffer.from('desktop-picture');fs.writeFileSync(source,bytes);let picked=0;
 const options={dialog:{async showOpenDialog(){picked++;return {canceled:false,filePaths:[source]};}}};
 const selected=await files.execute(f.app,f.binding,'files.pickLocal',{},()=>{},options);assert.equal(picked,1);const item=selected.items[0];assert.ok(!JSON.stringify(item).includes(f.root));assert.match(item.sourceId,/^source_/);assert.equal(fs.existsSync(path.join(f.root,'jiyong-files')),false,'selection and preview do not write project files');
 assert.deepEqual(Buffer.from(await (await f.request({url:item.url,method:'GET'})).arrayBuffer()),bytes);
 const copy=await f.call('files.copyLocal',{projectId:'native',sourceId:item.sourceId});assert.deepEqual(Buffer.from(await (await f.request({url:copy.file.url,method:'GET'})).arrayBuffer()),bytes);assert.equal((await f.call('files.copyLocal',{projectId:'native',sourceId:item.sourceId})).file.id,copy.file.id,'repeat copy is idempotent');
 const contract=require('../main/soduwork-app-bridge-contract.cjs');assert.equal(contract.METHOD_CAPABILITY['files.copyLocal'],'data.write');assert.throws(()=>contract.normalizeRequest({id:'x',method:'files.copyLocal',params:{projectId:'p',sourceId:item.sourceId,path:source}}));
 await assert.rejects(()=>f.call('files.copyLocal',{projectId:'p',sourceId:'source_'+'0'.repeat(32)}));fs.appendFileSync(source,'changed');await assert.rejects(()=>f.call('files.copyLocal',{projectId:'native',sourceId:item.sourceId}),/变化/);f.switchAccount();assert.equal((await f.request({url:item.url,method:'GET'})).status,403);
});
