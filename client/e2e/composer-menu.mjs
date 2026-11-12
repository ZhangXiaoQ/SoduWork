// Real UI modules in an isolated Chrome profile. No backend, agents or user data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {CdpPage,listPages,delay} from './lib/cdp.mjs';
const output=path.resolve(process.argv[2]||fileURLToPath(new URL('../../outputs/composer-toolbar-order',import.meta.url)));
fs.mkdirSync(output,{recursive:true});
const clientRoot=fileURLToPath(new URL('../',import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.webp':'image/webp','.ico':'image/x-icon'};
// Serve the production bytes through a local, read-only asset server; Chrome
// file:// reads are not supported by every managed Windows environment.
const server=http.createServer((request,response)=>{
 if(request.url==='/favicon.ico'){response.writeHead(204);response.end();return;}
 const file=path.resolve(clientRoot,'.'+decodeURIComponent(new URL(request.url,'http://fixture').pathname));
 if(!file.startsWith(clientRoot)||!mime[path.extname(file)]||!fs.existsSync(file)){response.writeHead(404);response.end();return;}
 response.writeHead(200,{'Content-Type':mime[path.extname(file)]});response.end(fs.readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-composer-menu-'));
const child=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',[
 '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
 '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,
 '--window-size=1440,1000','about:blank'],{windowsHide:true,stdio:'ignore'});
let page;const checks=[];
try{
 let port;
 for(let i=0;i<80;i++){try{port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);if(port)break;}catch{}await delay(100);}
 assert.ok(port);page=await CdpPage.connect((await listPages(port))[0]);
 page.ws.addEventListener('message',event=>{const msg=JSON.parse(event.data);if(msg.method!=='Fetch.requestPaused')return;
  const p=msg.params;void page.call(p.request.url.startsWith(origin+'/')?'Fetch.continueRequest':'Fetch.failRequest',
   p.request.url.startsWith(origin+'/')?{requestId:p.requestId}:{requestId:p.requestId,errorReason:'BlockedByClient'}).catch(()=>{});});
 await page.call('Fetch.enable',{patterns:[{urlPattern:'http://*'},{urlPattern:'https://*'}]});
 await page.call('Page.navigate',{url:origin+'/tests/composer-menu.html'});
 await page.waitFor(()=>!!document.querySelector('#cpMore'),null,10000);
 await page.call('Page.bringToFront');await page.call('Emulation.setFocusEmulationEnabled',{enabled:true});await delay(200);
 async function click(selector){
  const p=await page.run(s=>{const e=document.querySelector(s);if(!e)throw Error('Missing '+s);
   e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.width||e.disabled||!e.checkVisibility())throw Error('Hidden/disabled '+s);
   const x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded '+s);
   return{x,y};},selector);
  await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',...p});await delay(150);
  for(const type of ['mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});
  await delay(100);
 }
 async function key(key){for(const type of ['keyDown','keyUp'])await page.call('Input.dispatchKeyEvent',{type,key});await delay(60);}
 async function shot(name){const s=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(s.data,'base64'));}
 async function open(){if(await page.run(()=>document.querySelector('#cpMorePop').hidden))await click('#cpMore');
  await page.waitFor(()=>document.querySelectorAll('[data-more-plugin]').length>0||!!document.querySelector('[data-more-retry]'));}
 async function audit(name){
  const result=await page.run(()=>{
   const root=document.querySelector('#cpMorePop'),r=root.getBoundingClientRect();
   const small=[...root.querySelectorAll('*')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&
    [...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())&&parseFloat(getComputedStyle(e).fontSize)<12)
    .map(e=>({cls:e.className,text:e.textContent,font:getComputedStyle(e).fontSize}));
   return{small,overflow:root.scrollWidth>root.clientWidth+1,bounds:{left:r.left,right:r.right,bottom:r.bottom,top:r.top},width:innerWidth,height:innerHeight};
  });
  assert.deepEqual(result.small,[],name+' font floor');assert.equal(result.overflow,false,name+' horizontal overflow');
  assert.ok(result.bounds.left>=8&&result.bounds.right<=result.width-8,name+' horizontal placement '+JSON.stringify(result.bounds));
  assert.ok(result.bounds.top>=8&&result.bounds.bottom<=result.height-8,name+' vertical placement');checks.push({name,...result});
 }
 async function toolbar(name){
  const result=await page.run(()=>{
   const box=document.querySelector('.cp-box').getBoundingClientRect();
   const selectors=['#cpMore','#cpPermission','#cpWorkspace','#cpModelBtn','#cpRuntime','#cpMic','#cpGo'];
   const controls=selectors.map(selector=>{const el=document.querySelector(selector),r=el.getBoundingClientRect();
    return{selector,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,
     clickable:el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),visible:el.checkVisibility()};});
   const overlaps=[];for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++){
    const a=controls[i],b=controls[j];if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)overlaps.push([a.selector,b.selector]);}
   return{controls,overlaps,box:{left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width},width:innerWidth,
    overflow:document.documentElement.scrollWidth>innerWidth+1,goalInMenu:!!document.querySelector('#cpMorePop #cpIntentMenu'),
    draft:document.querySelector('#cpInput').value,acceptance:document.querySelector('#cpIntentAcceptance').value};
  });
  checks.push({name,...result});assert.deepEqual(result.overlaps,[],name+' overlap');
  for(const row of result.controls){assert.ok(row.visible&&row.clickable,name+' inaccessible '+row.selector);
   assert.ok(row.left>=result.box.left-1&&row.right<=result.box.right+1&&row.top>=result.box.top-1&&row.bottom<=result.box.bottom+1,name+' outside composer '+JSON.stringify(row));}
  assert.equal(result.overflow,false,name+' page overflow');assert.ok(result.goalInMenu,name+' goal is inside plus menu');
  const c=result.controls;assert.ok(c[0].right<=c[1].left+1&&c[1].right<=c[2].left+1,name+' left group order');
  for(let i=3;i<6;i++)assert.ok(c[i].right<=c[i+1].left+1&&Math.abs(c[i].top-c[i+1].top)<3,name+' right group order');
  assert.ok(c[3].width<=120.5,name+' model trigger exceeds 120px');
 }
 assert.equal(await page.run(()=>document.querySelectorAll('#cpRuntime .wc-chevron').length),0);
 await click('#cpRuntime');await page.waitFor(()=>document.querySelector('#cpRuntimePop').classList.contains('show'));
 await click('[data-runtime="codex-harness"]');assert.equal(await page.run(()=>ComposeRuntime.value()),'codex-harness');
 assert.equal(await page.run(()=>document.querySelector('#cpRuntimePop').classList.contains('show')),false);
 await click('#cpRuntime');await click('[data-runtime="pi"]');checks.push({name:'Agent remains selectable without chevron'});
 await click('#cpInput');await page.call('Input.insertText',{text:'请结合附件，整理产品方案 /保留这段原文'});
 // File input uses the real attachment controller; File is local in-memory test data.
 await page.run(()=>{const dt=new DataTransfer();dt.items.add(new File(['完整的任务材料'],'需求说明.txt',{type:'text/plain'}));
  const e=document.querySelector('#cpFile');e.files=dt.files;e.dispatchEvent(new Event('change',{bubbles:true}));});await delay(150);
 const draft=await page.run(()=>({text:document.querySelector('#cpInput').value,attachments:document.querySelector('#cpAtts').textContent}));
 assert.match(draft.attachments,/需求说明/);
 await open();await click('#cpIntentMenu');
 assert.equal(await page.run(()=>document.querySelector('#cpIntentMenu').getAttribute('aria-pressed')),'true');
 assert.ok(await page.run(()=>document.querySelector('#cpMorePop').hidden&&document.querySelector('#cpIntentBrief').checkVisibility()));
 await click('#cpIntentAcceptance');await page.call('Input.insertText',{text:'保留完成标准，附验证证据'});
 await open();await click('#cpIntentMenu');
 assert.equal(await page.run(()=>document.querySelector('#cpIntentMenu').getAttribute('aria-pressed')),'false');
 assert.equal(await page.run(()=>document.querySelector('#cpIntentAcceptance').value),'保留完成标准，附验证证据');
 await open();await click('#cpIntentMenu');
 assert.ok(await page.run(()=>document.querySelector('#cpIntentBrief').checkVisibility()));
 assert.equal(await page.run(()=>document.querySelector('#cpIntentAcceptance').value),'保留完成标准，附验证证据');
 await open();await click('#cpIntentMenu');
 assert.deepEqual(await page.run(()=>({text:document.querySelector('#cpInput').value,attachments:document.querySelector('#cpAtts').textContent})),draft);
 assert.equal(await page.run(()=>fixtureCalls.filter(c=>c[0]==='send').length),0);
 checks.push({name:'Goal toggles through real plus-menu clicks; acceptance, prompt and attachments survive disable/re-enable; no send'});
 await toolbar('initial toolbar');
 await open();await shot('menu-initial');await audit('initial menu');
 assert.equal(await page.run(()=>document.querySelectorAll('[data-more-plugin]').length),10);
 assert.equal(await page.run(()=>!!document.querySelector('[data-more-plugin="not-installed"]')),false);
 assert.ok(await page.run(()=>document.querySelector('[data-more-plugin="disabled"]').disabled));
 assert.ok(await page.run(()=>document.querySelector('[data-more-plugin="task-only"]').disabled));
 await click('[data-more-plugin="plugin-0"]');
 await page.waitFor(()=>!document.querySelector('.nplugin-strip').hidden);
 assert.deepEqual(await page.run(()=>({text:document.querySelector('#cpInput').value,attachments:document.querySelector('#cpAtts').textContent})),draft);
 assert.equal(await page.run(()=>fixtureCalls.filter(c=>['send','route'].includes(c[0])).length),0);
 assert.match(await page.run(()=>document.querySelector('.nplugin-strip').textContent),/产品创新引擎/);
 assert.equal(await page.run(()=>Boolean(document.querySelector('.nplugin-strip .cap-plugin-custom-icon'))),true);
 await shot('plugin-selected');checks.push({name:'Clicked plugin selected in place; text, slash text and attachment preserved; no send or navigation'});
 await open();assert.equal(await page.run(()=>document.querySelector('[data-more-plugin="plugin-0"]').getAttribute('aria-pressed')),'true');
 assert.equal(await page.run(()=>Boolean(document.querySelector('[data-more-plugin="plugin-0"] .cap-plugin-custom-icon'))),true);
 await click('[data-more-plugin="plugin-0"]');
 assert.equal(await page.run(()=>document.querySelectorAll('.nplugin-strip .nplugin-chip').length),1);
 checks.push({name:'Duplicate plugin selection is idempotent'});
 await open();await click('#cpMoreAllPlugins');
 assert.ok(await page.run(()=>fixtureCalls.some(c=>c[0]==='route'&&c[1]==='skills')));
 assert.equal(await page.run(()=>document.querySelector('#cpInput').value),draft.text);
 checks.push({name:'All plugins uses workspace skills route and keeps draft'});
 await click('#cpPermission');await page.waitFor(()=>document.querySelector('#cpPermissionPop').classList.contains('show'));
 await click('#cpPermissionPop [data-mode="readonly"]');
 assert.equal(await page.run(()=>document.querySelector('#cpPermissionName').textContent),'只读');
 await click('#cpPermission');await click('#cpPermissionPop [data-mode="standard"]');
 await open();await key('Escape');assert.ok(await page.run(()=>document.querySelector('#cpMorePop').hidden));
 assert.equal(await page.run(()=>document.activeElement.id),'cpMore');
 await key('ArrowDown');assert.equal(await page.run(()=>document.activeElement.id),'cpMoreFile');
 await key('ArrowDown');assert.equal(await page.run(()=>document.activeElement.id),'cpMoreExecution');
 await key('ArrowDown');assert.equal(await page.run(()=>document.activeElement.id),'cpIntentMenu');
 await key('Escape');checks.push({name:'Keyboard open, navigate, Escape and focus return'});
 await page.run(()=>catalogFails=true);await click('#cpMore');await page.waitFor(()=>!!document.querySelector('[data-more-retry]'));
 await shot('menu-retry');await page.run(()=>catalogFails=false);await click('[data-more-retry]');
 await page.waitFor(()=>document.querySelectorAll('[data-more-plugin]').length===10);checks.push({name:'Catalog failure is visible and retry recovers'});
 await click('#cpAbility');await audit('capability submenu');await key('Escape');
 const skins=await page.run(()=>SkinRegistry.getSkins().map(s=>({id:s.id,theme:s.palette,skin:s.material})));
 for(const skin of skins){
  await page.run(s=>{document.documentElement.dataset.theme=s.theme;document.documentElement.dataset.skin=s.skin},skin);await delay(300);
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await open();await audit(skin.id);if(['bear-cnbm','flat-azure','soduwork-signature'].includes(skin.id))await shot(skin.id+'-menu');
  await click('#cpMore');
 }
 // A desktop window also contains the 272px navigation/history shell. Measure
 // 320/560px at the actual composer, not a 320px entire desktop window.
 for(const layout of [{composer:320},{composer:560},{viewport:1000},{viewport:1440}]){
  const name=layout.composer?'composer-'+layout.composer:'viewport-'+layout.viewport;
  let width=layout.viewport||layout.composer+360;
  for(let attempt=0;attempt<5;attempt++){
   await page.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await delay(250);
   if(!layout.composer)break;
   const actual=await page.run(()=>document.querySelector('.cp-box').getBoundingClientRect().width);
   if(Math.abs(actual-layout.composer)<1)break;
   width=Math.round(width+layout.composer-actual);
  }
  if(layout.composer)assert.ok(Math.abs(await page.run(()=>document.querySelector('.cp-box').getBoundingClientRect().width)-layout.composer)<1,name+' actual width');
  await toolbar(name);
  await open();await audit(name+' menu');await shot(name+'-menu');await click('#cpMore');
  assert.equal(await page.run(()=>document.querySelector('#cpInput').value),draft.text);
  await click('#cpRuntime');await page.waitFor(()=>document.querySelector('#cpRuntimePop').classList.contains('show'));
  await click('[data-runtime="codex-harness"]');assert.equal(await page.run(()=>ComposeRuntime.value()),'codex-harness');
  assert.equal(await page.run(()=>document.querySelector('#cpRuntimePop').classList.contains('show')),false);
  await toolbar(name+'-harness');await shot(name+'-toolbar');
  await click('#cpRuntime');await click('[data-runtime="pi"]');
 }
 const chatRow=await page.run(()=>{const r=document.querySelector('.ws-chat-row').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});
 await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',...chatRow});await delay(180);
 assert.equal(await page.run(()=>document.querySelector('.ws-chat-row .ws-chat-delete').hidden),false);
 await click('.ws-chat-row .ws-chat-more');
 await click('.ws-chat-row .ws-chat-delete');
 assert.ok(await page.run(()=>fixtureCalls.some(c=>c[0]==='delete'&&c[1]==='fixture-a')));
 await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',...chatRow});await delay(180);
 await click('.ws-chat-row .ws-chat-more');await click('.ws-chat-row .ws-chat-archive');
 assert.ok(await page.run(()=>fixtureCalls.some(c=>c[0]==='archive'&&c[1]==='fixture-a')));
 assert.equal(await page.run(()=>fixtureCalls.filter(c=>c[0]==='route').length),1);
 assert.ok(await page.run(()=>!!document.querySelector('[data-chat-id="fixture-a"]')));
 checks.push({name:'Recent chat menu exposes delete and archive without chat navigation; cancelled mutations preserve the row'});
 await shot('sidebar-archive');
 assert.deepEqual(await page.run(()=>fixtureErrors),[]);assert.deepEqual(page.takeRuntimeErrors(),[]);
 // Existing real new-conversation smoke also exercises ordinary message sending and history routing.
 await page.call('Page.navigate',{url:origin+'/tests/new-conversation.html'});
 await page.waitFor(()=>/new conversation smoke:.*failed/.test(document.querySelector('#out')?.textContent||''),null,10000);
 const smoke=await page.run(()=>document.querySelector('#out').textContent);assert.match(smoke,/0 failed/);checks.push({name:'Existing ordinary conversation smoke',result:smoke});
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:true,checks},null,2));
 console.log(JSON.stringify({passed:true,checks:checks.length,output}));
}catch(error){
 if(page){try{const s=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'failure.png'),Buffer.from(s.data,'base64'));
  console.error(JSON.stringify({runtimeErrors:page.takeRuntimeErrors(),page:await page.run(()=>({errors:window.fixtureErrors||[],active:document.activeElement?.id,base:document.baseURI,url:location.href}))}))}catch{}}
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:false,error:String(error),checks},null,2));throw error;
}finally{if(page){try{await page.call('Browser.close')}catch{}page.close()}if(!child.killed)child.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
