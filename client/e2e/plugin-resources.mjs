// Real catalog/import UI + main-process local store + real resource resolution.
// Publication preview uses fixture audience/identity; no enterprise upload or model run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {CdpPage,waitForPage,delay} from './lib/cdp.mjs';
const require=createRequire(import.meta.url);
const nativePicker=process.argv.includes('--native-picker');
const personal=require('../main/personal-plugins');
const resources=require('../main/plugin-resources');
const grant=require('../main/pi-session/plugin-grant');
const client=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const evidence=path.resolve(process.argv[2] || path.join(os.tmpdir(),'soduwork-plugin-resource-evidence'));
fs.mkdirSync(evidence,{recursive:true});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-resource-ui-'));
const app={getPath:()=>path.join(root,'store')}, cwd=path.join(root,'work');
fs.mkdirSync(cwd);
const draft={template:'method',key:'report-template',name:'简报模板助手',version:'1.0.0',
  description:'用随包模板整理本周进展、风险与下一步。',instructions:'复制模板后填写，参考示例并交付报告。',
  ui:{contributions:[{id:'report-reference',title:'参考面板',slot:'task.detail.tab',source:{type:'external',url:'https://example.invalid/report'}}]},
  resources:[
    {path:'templates/周报模板.md',kind:'template',encoding:'utf8',content:'# {{title}}\n\n## 本周进展\n{{progress}}'},
    {path:'examples/产品团队周报.json',kind:'example',encoding:'utf8',content:'{"title":"产品周报","progress":"资源链路验证"}'},
    {path:'scripts/render.py',kind:'script',encoding:'utf8',content:'print("Resource fixture; not executed during installation")'},
    {path:'references/说明与验收标准.md',kind:'reference',encoding:'utf8',content:'输出必须保留标题、事实和下一步。'},
    {path:'assets/这是一个用于验证窄屏下换行且不能丢失文件名称的特别长的素材文件名.txt',kind:'asset',encoding:'utf8',content:'readable resource'}
  ]};
const source=path.join(root,'template.json');fs.writeFileSync(source,JSON.stringify(draft));
if(nativePicker){
 for(const item of draft.resources){const file=path.join(root,item.path);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,item.content)}
 fs.writeFileSync(source,JSON.stringify({...draft,resources:draft.resources.map(({path,kind})=>({path,kind}))}));
}
const scripts=['panels-plugin-maker-utils','plugin-route-directory','panels-plugin-maker-skills','plugin-presentation','panels-plugin-maker-fields','panels-plugin-maker','plugin-publication-ux','plugin-catalog-format',
  'plugin-dependency-ux','plugin-install-setup','plugin-lifecycle','plugin-ui-host','plugin-access','panels-capability-plugins','panels-capabilities'];
const styles=['panels-base','panels-schedules','panels-capabilities','panels-capability-plugins','plugin-presentation','panels-plugin-maker','capability-type-scale'];
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>插件资源链路验证</title>
${styles.map(x=>'<link rel="stylesheet" href="/components/panels/'+x+'.css">').join('')}
<style>:root{--ink:#202a3a;--ink-2:#344256;--ink-3:#53637b;--ink-4:#687990;--accent:#3e79ed;--line:#e2e8f0;--line-2:#dce4ef;--line-3:#c8d4e3;--bg-0:#fff;--bg-1:#f7f9fc;--bg-2:#edf3fa}
*{box-sizing:border-box}body{margin:0;background:#f7f9fc;color:var(--ink);font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif}
main{max-width:900px;margin:50px auto;padding:24px}h1{font-size:26px}main p{color:var(--ink-3)}
button{cursor:pointer;font:inherit}#status{margin-top:20px;white-space:pre-wrap}.cap-modal-foot button{font-size:12px}
</style><main><p>本机插件 · 隔离测试</p><h1>简报模板助手</h1><p>复用实际安装、详情和上传预览组件。测试不连接企业、不调用模型、不改用户插件。</p>
<button class="btn-mini primary" id="import">导入测试插件</button>
<button class="btn-mini" id="detail" disabled>查看已安装插件</button><button class="btn-mini" id="submissions">查看提交回执</button><div id="status" role="status"></div><section id="catalog"></section></main>
<script>
const call=async(op,args=[])=>{const r=await fetch('/api/'+op,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args)});const x=await r.json();if(!r.ok)throw Error(x.error);return x};
window.SoduWorkAPI={
 preflightPluginDraft:body=>call('preflight',[body]),createPluginDraft:body=>call('install',[body]),
 pluginCatalog:async()=>{const r=await call('catalog');return {...r,submissions:window.reviewFixture?[window.reviewFixture]:[]}},personalPlugin:id=>call('get',[id]),
 pluginAudienceCandidates:async()=>({items:[],orgUnits:[]}),
 personalPluginPublisherIdentity:async()=>({identity:{keyId:'fixture-public-identity',fingerprint:'00000000000000000000000000000000'}})
};
${nativePicker?"window.soduWorkAPI={personalPlugins:{choosePackage:()=>call('choose-package')}};":''}
</script><script src="/core/plugin-platforms.js"></script>${scripts.map(x=>'<script src="/components/panels/'+x+'.js"></script>').join('')}
<script>
// Capture the production action context without opening a draft or touching a session.
// The real modal owner supplies creation, cleanup, sizing reset and focus restoration.
let modalContext;
const openDraft=SoduWorkPluginMakerUtils.openConversationDraft;
try{
 SoduWorkPluginMakerUtils.openConversationDraft=(_ref,_target,_button,context)=>{modalContext=context};
 openConversationPluginDraft('fixture-modal-context','',null);
}finally{SoduWorkPluginMakerUtils.openConversationDraft=openDraft}
if(!modalContext?.openModal||!modalContext?.closeModal)throw Error('Production plugin modal context unavailable');
const ctx={openModal:modalContext.openModal,closeModal:modalContext.closeModal,
say(text){document.getElementById('status').textContent=text},
errorText:e=>e.message,refresh(){document.getElementById('detail').disabled=false},
async tryPlugin(item){ctx.closeModal();try{const x=await call('try',[item.pluginId]);ctx.say('已安装，当前轮次可读取 '+x.count+' 个资源文件。');window.trial=x}catch(e){ctx.say(e.message)}}};
document.getElementById('submissions').onclick=async()=>{await SoduWorkCapabilityPlugins.load();SoduWorkCapabilityPlugins.render(document.getElementById('catalog'),'',ctx)};
document.getElementById('import').onclick=()=>SoduWorkCapabilityPlugins.choosePackage(ctx);
document.getElementById('detail').onclick=async()=>{await SoduWorkCapabilityPlugins.load();const item=SoduWorkCapabilityPlugins.snapshot().items.find(x=>x.key==='report-template');SoduWorkCapabilityPlugins.open(item.pluginId,ctx)};
</script></html>`;
const server=http.createServer(async(req,res)=>{
 try{
  if(req.url.startsWith('/api/')){
   let bytes=0,data='';for await(const chunk of req){bytes+=chunk.length;if(bytes>24*1024*1024)throw Error('size');data+=chunk;}
   const [a]=JSON.parse(data||'[]');let result;
   switch(req.url.slice(5)){
    case 'choose-package':result=await require('../main/plugin-package-picker').choose({showOpenDialog:async()=>({filePaths:[source]})});break;
    case 'preflight':result=personal.preflight(a);break;
    case 'install':result=personal.create(app,a);break;
    case 'catalog':result={items:personal.catalog(app,true),submissions:[]};break;
    case 'get':result={plugin:personal.get(app,a)};break;
    case 'try':{
      const trial=await grant.resolve({app,cwd,pluginIds:[a],identityOf:()=>{throw Error('No network allowed')}});
      const exported=personal.exportDraft(app,a);
      const bundle=resources.materialize(exported.resources,cwd,exported.key);
      for(const item of exported.resources)assert.equal(fs.readFileSync(path.join(bundle.directory,item.path)).toString('base64'),item.content);
      result={count:bundle.items.length,context:trial.items[0].context,hashes:bundle.items};break;
    }
    default:throw Error('No production endpoint in isolated fixture');
   }
   res.setHeader('content-type','application/json');res.end(JSON.stringify(result));return;
  }
  if(req.url==='/'){res.setHeader('content-type','text/html; charset=utf-8');res.end(html);return}
  const relative=decodeURIComponent(req.url.split('?')[0]).slice(1);
  if(relative!=='core/plugin-platforms.js'&&!/^components\/panels\/[a-z-]+\.(css|js)$/.test(relative)){res.statusCode=404;res.end();return}
  res.setHeader('content-type',relative.endsWith('.css')?'text/css':'text/javascript');
  res.end(fs.readFileSync(path.join(client,relative)));
 }catch(e){res.statusCode=400;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:e.message}));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(path.join(client,'node_modules/electron/dist/electron.exe'),
 [path.join(client,'e2e/fixtures/plugin-resource-window.cjs'),path.join(root,'profile'),'http://127.0.0.1:'+server.address().port,'--remote-debugging-port='+port],
 {windowsHide:true,env,stdio:'ignore'});
let page;const checks=[];
async function click(selector){
 await page.waitFor(s=>{const e=document.querySelector(s);return Boolean(e&&!e.disabled&&e.getClientRects().length)},selector);
 // Flush the offscreen compositor before sending native pointer coordinates.
 // A DOM-ready element can otherwise precede the first hit-test frame.
 await page.call('Page.captureScreenshot',{format:'png'});
 const pos=await page.run(s=>{const e=document.querySelector(s);if(!e||e.disabled)throw Error('Unavailable '+s);e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}},selector);
 for(const type of ['mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,...pos,button:'left',clickCount:1});
}
async function shot(name){
 const result=await page.call('Page.captureScreenshot',{format:'png'});
 fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(result.data,'base64'));
}
async function geometry(){
 if(!await page.run(()=>document.querySelector('.cap-resource-pack').open)) {
  await click('.cap-resource-pack summary');
  await page.waitFor(()=>document.querySelector('.cap-resource-pack').open,null);
 }
 const result=await page.run(()=>{
  const pack=document.querySelector('.cap-resource-pack'),r=pack.getBoundingClientRect();
  const text=[...pack.querySelectorAll('*')].filter(e=>e.textContent.trim()&&e.getClientRects().length);
  return {fits:r.x>=0&&r.right<=innerWidth&&pack.scrollWidth<=pack.clientWidth+1,
    unclipped:pack.querySelector('p').getBoundingClientRect().bottom<=r.bottom+1 && pack.querySelector('.cap-resource-list').clientHeight>=100,
    minFont:Math.min(...text.map(e=>parseFloat(getComputedStyle(e).fontSize)))};
 });
 assert.ok(result.fits);assert.ok(result.unclipped,'Resource panel must not shrink inside flex dialogs');assert.ok(result.minFont>=12);return result;
}
try{
 for(let i=0;i<60;i++){try{page=await CdpPage.connect(await waitForPage(port,x=>x.url.startsWith('http://127.0.0.1:'),1000));break}catch{await delay(150)}}
 assert.ok(page,'isolated Electron ready');
 await page.waitFor(()=>document.readyState==='complete' && window.SoduWorkCapabilityPlugins && document.querySelector('#import'),null);
 await page.call('Page.enable');await page.call('DOM.enable');
 await page.call('Emulation.setFocusEmulationEnabled',{enabled:true});
 let chooser=null;const receive=page.onMessage.bind(page);page.onMessage=e=>{const m=JSON.parse(e.data);if(m.method==='Page.fileChooserOpened')chooser=m.params;receive(e)};
 await page.call('Page.setInterceptFileChooserDialog',{enabled:true});
 await click('#import');
 if(!nativePicker){
  for(let i=0;i<50&&!chooser;i++)await delay(100);
  /* Chromium can miss Page.fileChooserOpened when the modal is opened while
     another isolated Electron window is closing. Resolve the real input as a
     deterministic fallback instead of reporting a false product failure. */
  if(!chooser){
   const documentNode=await page.call('DOM.getDocument',{depth:-1});
   const input=await page.call('DOM.querySelector',{nodeId:documentNode.root.nodeId,selector:'input[type="file"]'});
   if(input.nodeId){
    const described=await page.call('DOM.describeNode',{nodeId:input.nodeId});
    chooser={backendNodeId:described.node.backendNodeId,fallback:true};
   }
  }
  assert.ok(chooser);await page.call('DOM.setFileInputFiles',{files:[source],backendNodeId:chooser.backendNodeId});
 }else checks.push('native picker controller: adjacent resources collected from selected directory (dialog selection fixture)');
 await page.waitFor(()=>document.querySelector('#capLocalInstall'),null);
 assert.equal(await page.run(()=>document.querySelectorAll('.cap-resource-row').length),5);
 checks.push({install:await geometry()});await shot('01-install-resources');
 await click('.cap-resource-pack summary');
 assert.equal(await page.run(()=>document.querySelector('.cap-resource-pack').open),false);
 await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13});
 await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await page.waitFor(()=>document.querySelector('.cap-resource-pack').open,null);
 checks.push('mouse/keyboard collapse and expand');
 await click('#capLocalInstall');await page.waitFor(()=>window.trial?.count===5,null);
 const items=personal.catalog(app,true).filter(x=>x.key==='report-template');assert.equal(items.length,1);
 checks.push('real local installation and grant resolution preserve all five resources');
 await click('#detail');await page.waitFor(()=>document.querySelector('#capPersonalPublish'),null);
 await click('#capDetailResourcesTab');
 await page.run(()=>document.querySelector('.cap-resource-pack').scrollIntoView({block:'center'}));
 checks.push({detail:await geometry()});await shot('02-installed-detail');
 await click('.cap-plugin-more summary');await click('#capPersonalPublish');await page.waitFor(()=>document.querySelector('#capPublishDo'),null);
 assert.equal(await page.run(()=>document.querySelectorAll('.cap-resource-row').length),5);
 checks.push({publicationPreview:await geometry()});await shot('03-publication-resources');
 await page.call('Emulation.setDeviceMetricsOverride',{width:520,height:850,deviceScaleFactor:1,mobile:false});
 await page.run(()=>{document.querySelector('.cap-modal-body').scrollTop=0});
 checks.push({narrow:await geometry()});await shot('04-narrow-resources');
 await click('#capPublishCancel');assert.equal(await page.run(()=>document.querySelector('#capModalLayer').hidden),true);
 await page.call('Emulation.setDeviceMetricsOverride',{width:1280,height:940,deviceScaleFactor:1,mobile:false});
 await click('#detail');await click('.cap-plugin-more summary');await click('#capPersonalEdit');
 await page.waitFor(()=>document.querySelector('#capMakerDo'),null);
 assert.equal(await page.run(()=>document.querySelectorAll('.cap-resource-row').length),5);
 await click('[data-maker-group="dependencies"] > summary');
 await page.waitFor(()=>document.querySelector('#capPluginSoduWorkMedia'),null);
 await click('#capPluginSoduWorkMedia');
 assert.equal(await page.run(()=>document.querySelector('#capPluginSoduWorkMedia').checked),true);
 await click('#capMakerDo');
 await page.waitFor(()=>document.querySelector('#capMakerDo')?.textContent==='保存新版本',null);
 await click('#capMakerDo');
 await page.waitFor(()=>document.querySelector('#capModalLayer').hidden,null);
 const edited=personal.get(app,items[0].pluginId);
 assert.equal(edited.version,'1.0.1');
 assert.equal(edited.localVersions.length,2);
 assert.deepEqual(edited.localDraft.mcpServers,['soduwork-media']);
 assert.deepEqual(edited.localDraft.ui,personal.build(draft).body.ui);
 assert.deepEqual(edited.capabilities.resources,resources.summary(resources.normalize(draft.resources)));
 checks.push('real editor can enable built-in video generation without an external connection; UI and resource hashes remain intact');
 await page.run(()=>{window.reviewFixture={pluginId:'enterprise-fixture',key:'report-template',
   name:'简报模板助手',version:'1.0.1',scope:'organization',trustState:'quarantined',
   provenance:{signatureState:'verified'},visibility:'users',audienceCount:1}});
 await click('#submissions');await click('#capPluginSubmissions');
 await click('#capRecordSearch');await page.call('Input.insertText',{text:'1.0.1'});
 await click('.cap-record');
 assert.equal(await page.run(()=>document.querySelectorAll('.cap-publication-progress li').length),3);
 assert.equal(await page.run(()=>document.querySelector('.cap-publication-current b').textContent),'管理员审核');
 assert.doesNotMatch(await page.run(()=>document.getElementById('capModalBody').innerText),/发布评测|预检、模拟/);
 async function publicationGeometry(){
   const g=await page.run(()=>{
     const modal=document.querySelector('.cap-modal'),r=modal.getBoundingClientRect();
     const texts=[...modal.querySelectorAll('*')].filter(e=>e.getClientRects().length&&
       [...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()));
     return {minFont:Math.min(...texts.map(e=>parseFloat(getComputedStyle(e).fontSize))),
       fits:r.left>=0&&r.right<=innerWidth&&modal.scrollWidth<=modal.clientWidth+1,
       compact:innerWidth<720||r.width<=660};
   });assert.ok(g.minFont>=12,JSON.stringify(g));assert.ok(g.fits);assert.ok(g.compact,'Publication must not inherit the full-screen editor');return g;
 }
 async function returnToApplications(expectedQuery=''){
   assert.equal(await page.run(()=>document.querySelector('#capSubmissionClose').textContent),'返回我的申请');
   await click('#capSubmissionClose');
   await page.waitFor(()=>document.querySelector('#capModalTitle').textContent==='我的申请'&&
     !document.querySelector('#capModalLayer').hidden,null);
   assert.equal(await page.run(()=>document.querySelector('#capRecordSearch').value),expectedQuery);
   assert.equal(await page.run(()=>document.querySelectorAll('.cap-record').length),1);
   assert.equal(await page.run(()=>document.querySelector('.cap-modal').classList.contains('cap-record-modal')),true);
   assert.equal(await page.run(()=>document.querySelector('.cap-publication-progress')),null);
   await click('#capModalClose');
   await page.waitFor(()=>document.querySelector('#capModalLayer').hidden&&
     document.activeElement.id==='capPluginSubmissions',null);
 }
 checks.push({pendingReview:await publicationGeometry()});await shot('05-pending-review');
 await returnToApplications('1.0.1');
 checks.push('return to applications retains search; closing restores focus to the applications entry');
 await page.run(()=>{Object.assign(window.reviewFixture,{reviewDecision:'reject',reviewNote:'请补充真实材料与验收标准。'})});
 await click('#submissions');await click('#capPluginSubmissions');await click('.cap-record');
 assert.equal(await page.run(()=>document.querySelector('.cap-publication-current').classList.contains('is-bad')),true);
 await page.call('Emulation.setDeviceMetricsOverride',{width:520,height:850,deviceScaleFactor:1,mobile:false});
 checks.push({rejectedReviewNarrow:await publicationGeometry()});await shot('06-rejected-review');
 await click('#capSubmissionImprove');await page.waitFor(()=>document.querySelector('#capPersonalEdit'),null);
 assert.equal(await page.run(()=>document.getElementById('capModalTitle').textContent),'简报模板助手');
 checks.push('rejected submission opens matching personal plugin through the real catalog callback');
 await click('#capModalClose');
 await page.run(()=>{Object.assign(window.reviewFixture,{reviewDecision:'approve',trustState:'approved',
   reviewNote:'验收已通过',enabled:true,catalogReady:true,bindingCount:0,qualitySummary:{caseCount:0}})});
 await page.call('Emulation.setDeviceMetricsOverride',{width:1280,height:940,deviceScaleFactor:1,mobile:false});
 await click('#submissions');await click('#capPluginSubmissions');await click('.cap-record');
 assert.equal(await page.run(()=>document.querySelectorAll('.cap-publication-progress .is-done').length),3);
 assert.match(await page.run(()=>document.querySelector('.cap-publication-current').innerText),/开放使用/);
 checks.push({approvedReview:await publicationGeometry()});await shot('07-approved-review');
 await returnToApplications();
 const errors=page.takeRuntimeErrors().filter(x=>!x.includes('favicon'));assert.deepEqual(errors,[]);
 const report={ok:true,scope:'Isolated real UI/local-store integration; no model execution, enterprise upload or approval',checks,errors};
 fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){
 if(page){
  await shot('failure').catch(()=>{});
  console.error(JSON.stringify({error:String(error),runtimeErrors:page.takeRuntimeErrors(),
   page:await page.run(()=>document.body.innerText).catch(()=>''),checks}));
 }
 throw error;
}finally{
 let closed = child.exitCode !== null || child.signalCode !== null;
 const stopped = closed ? Promise.resolve() : new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
 if(page) await page.call('Browser.close').catch(() => {});
 await Promise.race([stopped, delay(5000)]);
 if(!closed) { child.kill(); await Promise.race([stopped, delay(5000)]); }
 if(page)page.close();server.close();
 assert.ok(closed, 'The isolated Electron fixture must exit before removing its profile');
 // Only the mkdtemp directory created by this test; never a user profile.
 assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
 assert.ok(path.basename(root).startsWith('soduwork-resource-ui-'));
 fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:150});
}
