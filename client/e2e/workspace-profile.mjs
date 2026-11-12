// Isolated browser only: no running SoduWork window, user data or backend is touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {CdpPage,listPages,delay} from './lib/cdp.mjs';
const client=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.resolve(process.argv[2]||path.join(os.tmpdir(),'soduwork-profile-evidence'));
fs.mkdirSync(output,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-profile-browser-'));
const browser='C:/Program Files/Google/Chrome/Application/chrome.exe';
const child=spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,
  '--window-size=1120,780','about:blank'],{windowsHide:true,stdio:'ignore'});
let page;const checks=[];
try{
  let port;
  for(let i=0;i<80;i++){try{port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);if(port)break;}catch{}await delay(100);}
  assert.ok(port,'isolated browser starts');
  page=await CdpPage.connect((await listPages(port))[0]);
  await page.call('Page.navigate',{url:new URL('../tests/workspace-profile.html',import.meta.url).href});
  await page.waitFor(()=>document.querySelector('#wsMine b')?.textContent==='张三',null,10000);
  await page.call('Page.bringToFront');
  await page.call('Emulation.setFocusEmulationEnabled',{enabled:true});
  const skins=await page.run(()=>SkinRegistry.getSkins().map(s=>({id:s.id,name:s.name,theme:s.palette,skin:s.material})));
  for(const skin of skins){
    const result=await page.run(s=>{
      document.documentElement.dataset.theme=s.theme;document.documentElement.dataset.skin=s.skin;
      const b=document.querySelector('#wsMine'),a=b.querySelector('.ws-avatar'),t=b.querySelector('small');
      const color=getComputedStyle(a).color,bg=getComputedStyle(a).backgroundImage;
      return {initial:a.textContent,avatar:a.getBoundingClientRect().width,font:parseFloat(getComputedStyle(t).fontSize),
        overflow:b.scrollWidth>b.clientWidth+1,color,bg,flatShadow:getComputedStyle(a).boxShadow};
    },skin);
    assert.equal(result.initial,'张');assert.equal(result.avatar,40);assert.ok(result.font>=12);assert.equal(result.overflow,false);
    if(skin.skin==='flat'){assert.equal(result.bg,'none');assert.equal(result.flatShadow,'none');}
    checks.push({skin:skin.id,...result});
  }
  assert.notEqual(checks.find(s=>s.skin==='bear-vivid').color,checks.find(s=>s.skin==='bear-cnbm').color);
  const identity=async user=>page.run(u=>window.dispatchEvent(new CustomEvent('soduwork-device-auth',{detail:{state:'active',user:u}})),user);
  for(const [user,initial] of [[{displayName:' Alice Example '},'A'],[{displayName:' ',username:'bob'},'B'],[{},'我'],[{displayName:'𠮷田'},'𠮷'],[{displayName:'<img src=x onerror=alert(1)>'},'<']]){
    await identity(user);
    assert.deepEqual(await page.run(()=>({text:document.querySelector('[data-soduwork-user-initial]').textContent,images:document.querySelectorAll('#wsMine img').length})),{text:initial,images:0});
  }
  await identity({displayName:'张三'});
  const state=await page.run(()=>{
    WorkspaceShell.setConnected(false);const b=document.querySelector('#wsMine');
    const before={state:b.dataset.connection,text:b.querySelector('small').textContent,color:getComputedStyle(b.querySelector('.ws-avatar'),'::after').backgroundColor};
    WorkspaceShell.setConnected(true);return {before,after:{state:b.dataset.connection,text:b.querySelector('small').textContent,color:getComputedStyle(b.querySelector('.ws-avatar'),'::after').backgroundColor}};
  });
  assert.equal(state.before.state,'connecting');assert.equal(state.after.state,'connected');assert.notEqual(state.before.color,state.after.color);
  for(const width of [168,220,320,440]){
    await identity({displayName:'这是一个很长的同事姓名测试缩略显示'});
    const r=await page.run(w=>{
      document.querySelector('#workspaceShell').style.width=w+'px';WorkspaceShell.setUpdateState({state:'ready',version:'test-only'});
      const b=document.querySelector('#wsMine'),a=b.querySelector('.ws-avatar'),u=document.querySelector('#wsUpdate');
      return {overflow:b.scrollWidth>b.clientWidth+1,avatar:a.getBoundingClientRect().width,overlap:b.getBoundingClientRect().right>u.getBoundingClientRect().left};
    },width);
    assert.deepEqual(r,{overflow:false,avatar:40,overlap:false});
  }
  await identity({displayName:'张三'});await page.run(()=>{document.querySelector('#workspaceShell').style.width='280px';WorkspaceShell.setUpdateState({state:'idle'});document.querySelector('#wsMine').focus()});
  assert.equal(await page.run(()=>document.activeElement.id),'wsMine');
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13});
  await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  assert.equal(await page.run(()=>profileCalls.filter(c=>c[0]==='account').length),1);
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',text:' ',windowsVirtualKeyCode:32});
  await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
  assert.equal(await page.run(()=>profileCalls.filter(c=>c[0]==='account').length),2);
  const pos=await page.run(()=>{const r=document.querySelector('#wsMine').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});
  const before=await page.run(()=>{const r=document.querySelector('#wsMine').getBoundingClientRect();return{width:r.width,height:r.height}});
  await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',...pos});
  await delay(200);
  assert.deepEqual(await page.run(()=>{const r=document.querySelector('#wsMine').getBoundingClientRect();return{width:r.width,height:r.height}}),before);
  for(const type of ['mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,...pos,button:'left',clickCount:1});
  assert.equal(await page.run(()=>profileCalls.filter(c=>c[0]==='account').length),3);
  await page.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await page.run(()=>getComputedStyle(document.querySelector('#wsMine')).transitionDuration),'0s');
  assert.deepEqual(await page.run(()=>profileErrors),[]);
  await page.run(skins=>{
    const root=document.querySelector('#workspaceShell'),gallery=document.querySelector('#profileGallery');
    for(const skin of skins){
      const article=document.createElement('section');article.className='sample';article.dataset.theme=skin.theme;article.dataset.skin=skin.skin;
      const h=document.createElement('h2');h.textContent=skin.name;article.appendChild(h);
      const row=root.querySelector('.ws-profile-row').cloneNode(true);row.querySelectorAll('[id]').forEach(e=>e.removeAttribute('id'));
      article.appendChild(row);gallery.appendChild(article);
    }
    root.hidden=true;
  },skins);
  await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:1100,y:760});
  const shot=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
  fs.writeFileSync(path.join(output,'profile-skins.png'),Buffer.from(shot.data,'base64'));
  const result={ok:true,skins:checks.length,checks:['identity Chinese/Latin/empty/Unicode/XSS','real connection-state transitions','168–440px with update badge','Enter, Space and pointer open personal account security','hover geometry stable','reduced motion'],skinResults:checks};
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
  if(page){try{await page.call('Browser.close')}catch{}page.close();}
  if(child.exitCode===null)child.kill();
  // Keep the temporary isolated profile for failure diagnosis; never touch the user's profile.
}
