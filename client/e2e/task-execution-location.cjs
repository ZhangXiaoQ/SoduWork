'use strict';
// Production task projection and composer controls in Chromium. Hub responses
// are isolated fixtures matching the reported owner-client/runner distinction.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)],
    {env, windowsHide:true, stdio:'inherit', timeout:60000});
  if (child.error) console.error(child.error.message);
  process.exit(child.status ?? 1);
}
const {app,BrowserWindow}=electron,fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const assert=require('node:assert/strict'),{pathToFileURL}=require('node:url');
const client=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-task-location-'));
const out=path.resolve(process.argv[2] || path.join(client,'../outputs/task-execution-location'));
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(temporary,'profile'));app.disableHardwareAcceleration();
const report={ok:false,cases:[],boundary:'Actual task resolver, cloud view, open-reply, composer location/permission controls and workspace paint in Chromium; isolated Hub fixture, no model or business writes.'};
let win;const views=[];
const js=code=>win.webContents.executeJavaScript(code,true);
app.whenReady().then(async()=>{
  const desk=fs.readFileSync(path.join(client,'desk.html'),'utf8');
  const css=[...desk.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(m=>m[1]);
  const html=path.join(temporary,'fixture.html');
  fs.writeFileSync(html,'<!doctype html><meta charset="utf-8">'+css.map(file=>
    '<link rel="stylesheet" href="'+pathToFileURL(path.join(client,file)).href+'">').join('')+
    '<main style="padding:48px"><h2>需求执行位置回归</h2><p>隔离检查，不调用模型</p><div id="composer"></div></main>');
  win=new BrowserWindow({show:false,width:1200,height:600,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  await win.loadFile(html);
  for(const name of ['work-composer.js','chat-session-controls.js','chat-cloud-handoff.js'])
    await js(fs.readFileSync(path.join(client,'components/panels',name),'utf8'));
  const source=fs.readFileSync(path.join(client,'components/panels/panels-chat.js'),'utf8'),start=source.indexOf('  function _paintBar()');
  await js(`window.global=window;window._snap={};window._wd={};window._mode='full';window._sessionCaps=[];
    window.SoduWorkAPI={taskStorageKey:()=> 'isolated-owner'};
    document.querySelector('#composer').innerHTML=WorkComposer.html({className:'nbox',inputId:'nchatInput',sendId:'nchatSend',
      tools:WorkComposer.executionMode('data-chat-execution'),context:'<div class="wc-context" id="nchatContext">'+
      WorkComposer.contextButton({id:'nchatMode',valueId:'nchatModeName',icon:'shield',label:'权限',value:'兼容权限',popup:true,chevron:false})+
      WorkComposer.contextButton({id:'nchatWd',valueId:'nchatWdName',icon:'folder',label:'工作位置',value:'工作区'})+'</div>'});
    window.root=document.querySelector('.work-composer');
    window._composerControls=ChatSessionControls.create(root,{state:()=>({..._snap,ref:'view',mode:_mode})});
    ${source.slice(start,source.indexOf('  function _thinkingStatusHtml',start))}
    window.paint=_paintBar;void 0;`);
  const actor={hub:'http://127.0.0.1:18989',clientId:'viewer',session:Buffer.from(JSON.stringify({typ:'device',uid:'test',cid:'viewer',iat:1,exp:9999999999})).toString('base64url')+'.'+'a'.repeat(64)};
  for(const personal of [false,true]){
    const executionContext={location:{mode:'remote'},runner:{mode:'remote',runnerId:'runner',host:'Selected runner',...(personal?{clientId:'actual-pc'}:{})}};
    const controller=require('../main/conversation/cloud-handoff').create({app,identityOf:async()=>actor,interval:60000,
      request:async(_,route,options)=>{
        assert.ok(!options?.method || options.method==='GET');
        if(route==='/tasks/req')return{id:'req',kind:'requirement',title:'Requirement',status:'done',workRouting:{executionContext}};
        if(route.includes('/ai-session?'))return{ok:true,taskId:'req',ref:'original-run',runnerId:'runner',runnerClientId:'requesting-mobile',executionContext,status:'done',canSend:true,engine:'pi',items:[],last:0};
        if(route.endsWith('/attachments'))return[];
        assert.fail(route);
      }});
    const view=await controller.reopen('task-execution:req','view');views.push(view);
    const reply=require('../main/pi-session/open-reply').openReply(app,view);
    reply.snapshot=controller.view(view,reply.snapshot);
    assert.equal(reply.snapshot.cloudHandoff.target.runnerKind,personal?'work-computer':'cloud');
    assert.equal(reply.snapshot.cloudHandoff.ref,'original-run');
    await js(`window._snap=${JSON.stringify(reply.snapshot)};window._wd=${JSON.stringify({dir:reply.cwd,name:reply.workspaceName})};
      paint();ChatCloudHandoff.sync(root,_snap,{ref:'view'});void 0;`);
    const actual=await js(`({location:root.querySelector('[data-execution-menu]').dataset.location,
      permission:document.querySelector('#nchatModeName').textContent,workspace:document.querySelector('#nchatWdName').textContent,
      hint:document.querySelector('#nchatWd').title,disabled:document.querySelector('#nchatMode').disabled})`);
    assert.equal(actual.location,personal?'local':'cloud');
    assert.equal(actual.permission,personal?'电脑权限':'云端权限');
    assert.equal(actual.workspace,personal?'电脑成果':'云端成果');
    assert.equal(actual.disabled,true);assert.equal(actual.hint,reply.cwd || actual.workspace);assert.doesNotMatch(actual.hint,/点击打开/);
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    fs.writeFileSync(path.join(out,personal?'personal-pc.png':'cloud.png'),(await win.webContents.capturePage()).toPNG());
    report.cases.push({name:personal?'personal PC retains its own classification':'cloud execution ignores requesting mobile owner',ok:true,...actual});
    await view.close();
  }
  await js(`window._snap={};window._wd={dir:'C:/original-work',name:'Original workspace'};paint();
    ChatCloudHandoff.sync(root,_snap,{ref:'view'});void 0;`);
  assert.equal(await js("document.querySelector('#nchatWdName').textContent"),'Original workspace');
  assert.equal(await js("document.querySelector('#nchatWd').title"),'C:/original-work');
  report.cases.push({name:'ordinary local workspace remains unchanged',ok:true});report.ok=true;
}).catch(error=>{report.error=error.stack;}).finally(async()=>{
  for(const view of views)await view.close();win?.destroy();
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));app.exit(report.ok?0:1);
});
