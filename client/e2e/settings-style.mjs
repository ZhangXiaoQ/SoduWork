/**
 * Real settings markup, styles and event handlers, isolated from Hub/IPC/user profiles.
 * node e2e/settings-style.mjs --output <evidence-directory>
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CdpPage, listPages } from './lib/cdp.mjs';
const client=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const outputIndex=process.argv.indexOf('--output');
assert(outputIndex>=0&&process.argv[outputIndex+1],'--output is required');
const output=path.resolve(process.argv[outputIndex+1]);fs.mkdirSync(output,{recursive:true});
const desk=fs.readFileSync(path.join(client,'desk.html'),'utf8');
const panelStart=desk.indexOf('<div class="panel" id="settingsPanel">');
assert(panelStart>=0,'settings panel markup is present');
let panelEnd=-1,depth=0;
for(const tag of desk.slice(panelStart).matchAll(/<!--[\s\S]*?-->|<\/?div\b[^>]*>/gi)){
 if(tag[0].startsWith('<!--'))continue;
 depth+=/^<\/div/i.test(tag[0])?-1:1;
 if(depth===0){panelEnd=panelStart+tag.index+tag[0].length;break;}
}
assert(panelEnd>panelStart,'settings panel has a balanced closing tag');
const panel=desk.slice(panelStart,panelEnd);
assert(panel.trimEnd().endsWith('</div>'));
assert.equal((desk.match(/href="components\/settings\/settings.css"/g)||[]).length,1);
const links=[...desk.matchAll(/<link rel=["']stylesheet["'] href=["']([^"']+)["']>/g)].map(([,src])=>'<link rel="stylesheet" href="/client/'+src+'">').join('\n');
const authSource=fs.readFileSync(path.join(client,'components/client-auth/client-auth.js'),'utf8');
const account=new Function(authSource.match(/function accountCardHtml\(\) \{([\s\S]*?)\n  \}/)[1])();
const mock=String.raw`
window.testCalls=[];window.testErrors=[];
addEventListener('error',e=>testErrors.push(e.message));
addEventListener('unhandledrejection',e=>testErrors.push(String(e.reason)));
window.cfg={remind:'light',uiScale:'medium',fontScale:'medium',petVisible:true,dockVisible:true,trayVisible:true};
window.saveCfg=()=>testCalls.push('saveCfg');window.petSay=text=>testCalls.push(['toast',text]);
window.User={name:'示例',id:'isolated-settings-device',setName:async v=>{User.name=v;testCalls.push(['name',v]);}};
window.currentSkinId=()=>'test';window.SkinRegistry={getSkin:()=>({name:'SoduWork · 经典'})};
window.openSkinEntry=()=>testCalls.push('openSkin');
window.soduWorkAPI={
 openDeskWindow:()=>{},getDefaultWorkRoot:async()=>'C:/Isolated/SoduWork',
 clientUpdateStatus:async()=>({state:'current',currentVersion:'1.12.28'}),
 checkClientUpdate:async()=>{testCalls.push('checkUpdate');return{state:'current',currentVersion:'1.12.28'};},
  onClientUpdateStatus:cb=>{window.paintUpdate=cb;}
};
window.SoduWorkAPI={
 getTeamCapability:async()=>({assigned:true,meName:'示例',orgName:'产品团队',canManage:false}),
  registerClient:async()=>testCalls.push('register')
};
`;
const html='<!doctype html><html lang="zh-CN" data-desk-panel="workspace" data-workspace-view="settings"><head><meta charset="utf-8">'+links+
 '<style>html,body{margin:0;height:100%;overflow:hidden;background:var(--bg-1)}body{font-family:var(--font-ui)}'+
 '.test-nav{position:fixed;left:0;top:0;bottom:0;width:220px;padding:30px 20px;box-sizing:border-box;color:var(--ink-3)}'+
 '.test-nav b{font-size:22px;color:var(--ink)}.test-nav p{font-size:14px;margin-top:30px}</style></head>'+
 '<body><aside class="test-nav"><b>SoduWork</b><p>自动化</p><p>设置</p></aside>'+
 panel.replace('class="panel"','class="panel show"').replace('<div class="set-group">','<div class="set-group soduwork-account-settings">'+account+'</div><div class="set-group">')+
 '<script>'+mock+'</script><script src="/client/components/settings/settings.js"></script>'+
 '<script>openSettings();document.querySelector(".soduwork-account-name").textContent="林舟";document.querySelector(".soduwork-account-id").textContent="lin.zhou";document.querySelector(".soduwork-account-avatar").textContent="林";document.querySelector(".soduwork-account-quota").textContent="未启用额度限制";</script></body></html>';
const server=http.createServer((req,res)=>{
 if(req.url==='/'){res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);return;}
 const requested=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
 const file=path.resolve(client,requested.replace(/^\/client\//,''));
 if(!requested.startsWith('/client/')||!file.startsWith(client+path.sep)||
  !(/\.(css|woff2?|ttf|png|svg)$/.test(file)||file===path.join(client,'components/settings/settings.js'))){res.writeHead(403).end();return;}
 try{res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'application/octet-stream');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browserPath=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
assert(browserPath,'Chrome or Edge required');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-settings-check-'));
const browser=spawn(browserPath,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let page;const checks=[];const check=(value,label)=>{assert(value,label);checks.push(label);};
try{
 const portFile=path.join(profile,'DevToolsActivePort');
 for(let i=0;i<100&&!fs.existsSync(portFile);i++)await pause(100);
 const port=Number(fs.readFileSync(portFile,'utf8').split('\n')[0]);
 page=await CdpPage.connect((await listPages(port))[0]);
 await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
 await page.call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/'});
 await page.waitFor(()=>document.querySelector('#clientUpdateBadge')?.textContent==='已是最新',null,15000);
 async function click(selector){
  const pos=await page.run(s=>{const e=document.querySelector(s);if(!e||e.disabled)throw Error('Unavailable '+s);e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Obscured '+s);return{x,y};},selector);
  for(const type of ['mouseMoved','mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,...pos,button:type==='mouseMoved'?'none':'left',clickCount:1});await pause(70);
 }
 async function fill(selector,text){await click(selector);await page.run(s=>document.querySelector(s).select(),selector);await page.call('Input.insertText',{text});}
 async function shot(name){const r=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));}
 async function layout(label){
  await pause(180);
  const m=await page.run(()=>{const p=document.querySelector('#settingsPanel'),head=p.querySelector('.set-page-head');
   const text=[...p.querySelectorAll('*')].filter(e=>e.checkVisibility()&&[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()));
   return{width:innerWidth,panel:[p.clientWidth,p.scrollWidth],radius:getComputedStyle(p).borderRadius,head:head.getBoundingClientRect().height,
    tiny:text.filter(e=>parseFloat(getComputedStyle(e).fontSize)<12).map(e=>e.className),
    groups:[...p.querySelectorAll(':scope > .set-group')].map(e=>({w:e.clientWidth,scroll:e.scrollWidth})),errors:window.testErrors};});
  check(m.panel[1]<=m.panel[0]+1,label+' no horizontal overflow: '+JSON.stringify(m));
  check(m.groups.every(g=>g.scroll<=g.w+1),label+' cards fit columns');
  check(!m.tiny.length,label+' text >=12px: '+m.tiny.join(','));
  check(!m.errors.length,label+' no runtime errors: '+m.errors.join(','));
  check(m.radius==='22px',label+' automation frame');return m;
 }
 await layout('desktop');await page.run(()=>document.querySelector('#settingsPanel').scrollTop=0);await shot('01-settings-desktop');
 await fill('#boxNameInput','隔离验收名称');await click('#boxNameSave');
 check(await page.run(()=>User.name==='隔离验收名称'&&testCalls.includes('register')),'name save/register hooks');
 await fill('#workRootInput','C:/Isolated/Project/');await click('#workRootSave');
 check(await page.run(()=>workRoot()==='C:/Isolated/Project'),'work root save trims trailing slash');
 await fill('#workRootInput','');await click('#workRootSave');await pause(100);
 check(await page.run(()=>workRoot()==='C:/Isolated/SoduWork'),'empty work root restores default');
 for(const id of ['dockVisibleChk','petVisibleChk','trayVisibleChk']){
  await click('#'+id);check(await page.run(id=>!document.getElementById(id).checked,id),id+' toggles off');await click('#'+id);
 }
 await click('#remindSeg [data-remind="strong"]');check(await page.run(()=>cfg.remind==='strong'),'reminder selector');
 await click('#skinOpenBtn');check(await page.run(()=>testCalls.includes('openSkin')),'appearance entry');
 check(await page.run(()=>!document.querySelector('[data-hub-env],#hubUrlInput,#hubUrlSave')),'retired environment controls are absent');
 await shot('02-settings-current-controls');
 await click('#clientUpdateAction');check(await page.run(()=>testCalls.includes('checkUpdate')),'update callback');
 await page.run(()=>paintUpdate({state:'downloading',progress:45,targetVersion:'test'}));check(await page.run(()=>document.querySelector('#clientUpdateAction').disabled),'updating prevents duplicate clicks');
 await page.run(()=>paintUpdate({state:'current',currentVersion:'1.12.28'}));
 for(const[name,width,accent,font]of[['wide-red',1920,'#e44455','large'],['compact-blue',1024,'#397fe9','small'],['narrow-red',760,'#e44455','large']]){
  await page.call('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:false});
  await page.run(a=>document.documentElement.style.setProperty('--accent',a),accent);
  await click('#fontSeg [data-font="'+font+'"]');
  await pause(200); // Wait for the theme color transition before comparing computed colors.
  check(await page.run(()=>getComputedStyle(document.querySelector('#boxNameSave')).backgroundColor===getComputedStyle(document.querySelector('#petVisibleChk')).accentColor),'theme shared by buttons/checks: '+name);
  await layout(name);await page.run(()=>document.querySelector('#settingsPanel').scrollTop=0);await shot('03-'+name);
 }
 await page.run(()=>document.querySelector('#boxNameInput').focus());
 for(const type of ['keyDown','keyUp'])await page.call('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
 check(await page.run(()=>document.activeElement.id==='boxNameSave'&&getComputedStyle(document.activeElement).outlineStyle!=='none'),'keyboard focus visible');
 await page.run(()=>closeSettings());check(await page.run(()=>getComputedStyle(document.querySelector('#settingsPanel')).display==='none'),'closed settings cannot cover other pages');
 await page.run(()=>openSettings());await layout('reopened');
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,passed:checks.length,network:'isolated local fixtures only'},null,2));
 console.log(JSON.stringify({passed:checks.length,output}));
}catch(error){
 if(page){const r=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'failure.png'),Buffer.from(r.data,'base64'));
  console.log(JSON.stringify(await page.run(()=>{const p=document.querySelector('#settingsPanel'),h=p?.querySelector('.set-page-head');return {errors:window.testErrors,padding:p&&getComputedStyle(p).padding,gutter:p&&getComputedStyle(p).getPropertyValue('--settings-gutter'),head:h&&getComputedStyle(h).justifyContent};})));}
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,error:String(error)},null,2));throw error;
}finally{
 if(page){try{await page.call('Browser.close');}catch{}page.close();}
 browser.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
