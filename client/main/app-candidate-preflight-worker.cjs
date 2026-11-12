'use strict';
// Run by app-candidate-preflight.cjs, never as a user's normal desktop client.
const fs=require('node:fs'),path=require('node:path');
const electron=require('electron'),{app,BrowserWindow,WebContentsView,ipcMain}=electron;
const folder=path.resolve(process.env.APP_CANDIDATE_PREFLIGHT_FOLDER||process.argv[2]),report={ok:false,executed:true,isolated:true,checks:[],errors:[],businessTested:false};
let phase='starting';Object.defineProperty(report,'stage',{enumerable:true,get:()=>phase,set:value=>{phase=value;fs.writeFileSync(path.join(folder,'progress.json'),JSON.stringify({stage:value}));}});
app.setPath('userData',path.join(folder,'profile'));app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{});
const windows=[];let host,content;
const check=(key,label,ok,extra={})=>report.checks.push({key,label,ok,...extra});
const recordError=value=>{if(report.errors.length<20)report.errors.push(String(value).slice(0,1200));};
const deadline=setTimeout(()=>{check('app-startup','原生启动超时，尚未完成检查',false);finish();},32000);
let finishing=false;
async function finish(){
  if(finishing)return;finishing=true;clearTimeout(deadline);
  try{for(const win of windows)if(!win.isDestroyed())win.destroy();if(host&&!host.isDestroyed())host.destroy();await require('./jiyong-data.cjs').close();}
  catch(error){recordError(error.message);check('app-check-cleanup','预检进程清理失败',false,{reason:error.message});}
  report.ok=report.checks.length>0&&report.checks.every(row=>row.ok!==false);
  fs.writeFileSync(path.join(folder,'result.json'),JSON.stringify(report),{mode:0o600});app.exit(report.ok?0:1);
}
function observe(wc){
  content=wc;
  wc.on('render-process-gone',(_event,details)=>recordError('页面进程退出：'+details.reason));
  wc.on('console-message',details=>{if(details.level==='error')recordError(details.message);});
  wc.on('did-fail-load',(_e,code,description,_url,mainFrame)=>{if(mainFrame&&code!==-3)recordError('页面加载失败：'+description);});
  wc.debugger.attach('1.3');
  wc.debugger.on('message',(_event,method,params)=>{
    if(method==='Network.responseReceived'&&params.response.status>=400&&['Document','Script','Stylesheet','Font','Image'].includes(params.type)){
      const url=new URL(params.response.url);if(url.hostname.endsWith('.soduwork-app.invalid'))recordError('资源加载失败：'+url.pathname+' ('+params.response.status+')');
    }
    if(method==='Network.loadingFailed'&&['Document','Script','Stylesheet'].includes(params.type))recordError('资源加载失败：'+params.errorText);
    if(method==='Runtime.exceptionThrown')recordError(params.exceptionDetails.exception?.description||params.exceptionDetails.text);
    if(method==='Debugger.paused'){
      // Catch the precise unsupported SDK call even when app code swallows it.
      // Optional feature detection is not an error and does not pause here.
      report.pauses=(report.pauses||0)+1;
      if(report.pauses>100)void wc.debugger.sendCommand('Debugger.setPauseOnExceptions',{state:'none'}).catch(()=>{});
      report.lastPause={reason:params.reason,description:String(params.data?.description||'').slice(0,600)};
      const description=String(params.data?.description || '');
      if(/soduWorkApp\.[\w.]+ is not a function/.test(description))recordError(description);
      void wc.debugger.sendCommand('Debugger.resume').catch(()=>{});
    }
  });
  return Promise.all([wc.debugger.sendCommand('Network.enable'),wc.debugger.sendCommand('Runtime.enable'),wc.debugger.sendCommand('Debugger.enable').then(()=>wc.debugger.sendCommand('Debugger.setPauseOnExceptions',{state:'all'}))]);
}
app.whenReady().then(async()=>{
  const body=JSON.parse(fs.readFileSync(path.join(folder,'candidate.json'),'utf8'));
  const cloud=body.jiyong?.storage?.location==='cloud';
  if(cloud){
    // Explicit isolated transport substitute, never a production cloud test.
    body.jiyong.storage={location:'local'};
    report.cloudBusinessTested=false;
    check('cloud-contract','云端声明与初始化已校验；首屏数据使用隔离本地替身，真实云端读写尚未验收',true,{evidence:'isolated-local-substitute'});
  }
  const personal=require('./personal-plugins');
  require('./app-settings-store.cjs').configure({app,safeStorage:electron.safeStorage,ownerOf:()=>'isolated/app-preflight'});
  report.stage='install';
  const installed=personal.create(app,body).plugin;
  const entry=installed.ui.contributions.find(row=>row.slot==='workspace.navigation');
  fs.writeFileSync(path.join(folder,'host.html'),'<!doctype html><title>App startup check</title>');
  fs.writeFileSync(path.join(folder,'composer.html'),'<!doctype html><meta charset="utf-8"><style>body{margin:0}footer{position:fixed;bottom:6px;left:8px;right:8px;color:#8b8b93;font:12px/16px "Segoe UI",sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style><footer title="AI业务未在隔离预检中执行">AI业务未在隔离预检中执行</footer><script>soduWorkAPI.workPreview.onComposerSubmit(p=>soduWorkAPI.workPreview.composerSubmitResult({id:p.id,ok:false,reason:"隔离预检不执行真实AI，请通过页面操作实测"}));</script>');
  let observed=Promise.resolve(),contentReady=Promise.resolve(),composerReady=Promise.resolve(),composerContent;
  require('./work-preview').install({app,ipcMain,
    BrowserWindow:Object.assign(function(options){const win=new BrowserWindow({...options,show:false,webPreferences:{...options.webPreferences,offscreen:true}});win.show=()=>{};win.maximize=()=>{};windows.push(win);return win;},{fromWebContents:wc=>BrowserWindow.fromWebContents(wc)}),
    WebContentsView:function(options){
      const view=new WebContentsView({...options,webPreferences:{...options.webPreferences,offscreen:true,backgroundThrottling:false}}),load=view.webContents.loadFile.bind(view.webContents);
      view.webContents.loadFile=(file,opts)=>{
        // Both the lazy launcher and expanded conversation use the isolated
        // notice: diagnostics must never load the real conversation surface.
        if(['app-composer-launcher.html','desk.html'].includes(path.basename(file))){
          composerContent=view.webContents;
          return composerReady=load(path.join(folder,'composer.html'),opts);
        }
        return load(file,opts);
      };
      if(path.basename(options.webPreferences?.preload||'')==='work-preview-app-preload.cjs'){
        observed=observe(view.webContents);
        const loadURL=view.webContents.loadURL.bind(view.webContents);
        // Initialize an empty frame so the debugger is ready before any
        // candidate script runs. Awaiting debugger setup on an uninitialized
        // WebContents deadlocks; racing setup against real scripts misses errors.
        view.webContents.loadURL=(...args)=>contentReady=(async()=>{await loadURL('about:blank');await observed;return loadURL(...args);})();
      }
      return view;
    },shell:{openExternal:async()=>{throw Error('隔离预检不打开外部页面');}}});
  host=new BrowserWindow({show:false,webPreferences:{preload:path.resolve(__dirname,'../preload.js'),contextIsolation:true,sandbox:true}});
  report.stage='host-load';
  await host.loadFile(path.join(folder,'host.html'));
  // Context travels through the real preload/IPC/origin/capability checks. This
  // isolated owner has no directory, notification target, model or Hub session.
  await host.webContents.executeJavaScript(`void soduWorkAPI.workPreviewAppHost.onRequest(request=>soduWorkAPI.workPreviewAppHost.respond(request.id,request.method==='context.get'?{ok:true,appId:request.appId,contributionId:request.contributionId,tabId:request.tabId,locale:'zh-CN'}:{ok:false,reason:'隔离预检不连接真实服务'}))`);
  report.stage='open-window';
  const opened=await host.webContents.executeJavaScript(`soduWorkAPI.workPreview.showDetached(${JSON.stringify({tabId:'candidate-preflight',label:body.name,package:{pluginId:installed.pluginId,contributionId:entry.id},windowSettings:body.appWindow})})`);
  if(!opened?.ok)throw Error(opened?.reason||'即用窗口未打开');
  if(!content)throw Error('即用页面未创建');
  report.stage='page-load';
  await contentReady;
  await new Promise(resolve=>setTimeout(resolve,1800));
  await observed;
  report.stage='first-screen'; report.pageState={url:content.getURL(),loading:content.isLoading(),destroyed:content.isDestroyed()};
  await content.debugger.sendCommand('Debugger.setPauseOnExceptions',{state:'none'});
  await content.debugger.sendCommand('Debugger.resume').catch(()=>{});
  const first=await content.executeJavaScript(`(()=>{const visible=el=>!!el.getClientRects().length&&!el.hidden&&getComputedStyle(el).visibility!=='hidden';return {ready:document.readyState,text:document.body?.innerText?.trim().slice(0,240)||'',visual:[...document.querySelectorAll('canvas,img,svg')].some(visible),inputCount:[...document.querySelectorAll('input:not([type=hidden]),textarea,select')].filter(visible).length,sdkVersion:window.soduWorkApp?.version||'',native:typeof window.soduWorkAppBridge?.request==='function'}})()`);
  report.firstScreen=first; report.observationMs=1800;
  if(composerContent){
    await composerReady;
    report.diagnosticNotice=await composerContent.executeJavaScript('(()=>{const el=document.querySelector("footer"),s=getComputedStyle(el),r=el.getBoundingClientRect();return {fontSize:s.fontSize,whiteSpace:s.whiteSpace,color:s.color,bottom:r.bottom,height:innerHeight}})()');
  }
  check('app-first-screen','隔离原生首屏已加载，有可见内容',first.ready!=='loading'&&!!(first.text||first.visual));
  const capabilities=entry.source.bridge?.capabilities||[];
  const transport=await content.executeJavaScript('soduWorkAppBridge.request("context.get",{})');
  const transportReady=capabilities.includes('context.read')?transport?.ok===true:transport?.code==='APP_CAPABILITY_DENIED';
  check('app-bridge',capabilities.length?'原生桥接通信及SDK已就绪':'原生安全窗口已就绪（未请求宿主能力）',first.native&&transportReady&&(!capabilities.length||!!first.sdkVersion));
  if(capabilities.includes('context.read')){
    report.stage='context';
    const context=await content.executeJavaScript('soduWorkApp.context.get()');
    check('app-context','宿主握手通过（context.get）',context?.ok===true&&context.appId==='plugin:'+installed.pluginId);
  }
  if(body.jiyong?.collections?.length){
    if(!capabilities.includes('data.read'))check('app-database','声明数据集合但页面未声明 data.read',false);
    else for(const collection of body.jiyong.collections){
      report.stage='data-read';
      const page=await content.executeJavaScript(`soduWorkApp.data.list(${JSON.stringify({collection:collection.key,limit:1})})`);
      check('app-database-'+collection.key,'隔离SQLite读取通过：'+collection.key,page?.ok===true,{reason:page?.reason||''});
      if(capabilities.includes('data.write')){
        const id='preflight_'+Date.now().toString(36);
        const saved=await content.executeJavaScript(`soduWorkApp.data.batch(${JSON.stringify({collection:collection.key,operations:[{id,expectedRevision:0,value:{preflight:true}}]})})`);
        if(!saved?.ok)throw Error('SQLite写入失败：'+String(saved?.reason));
        const read=await content.executeJavaScript(`soduWorkApp.data.get(${JSON.stringify({collection:collection.key,id})})`);
        check('app-database-write-'+collection.key,'隔离SQLite写入读回通过：'+collection.key,read?.ok===true&&read.item?.value?.preflight===true);
      }
    }
  }
  if(first.inputCount>3)report.warnings=['首屏有'+first.inputCount+'个输入控件，请评估是否能用一句意图替代。'];
  await new Promise(resolve=>setTimeout(resolve,200));
  report.errors=[...new Set(report.errors)].slice(0,20);
  check('app-startup',report.errors.length?'首屏发现脚本、资源或SDK运行错误':'首屏观察期内未发现脚本、资源或SDK运行错误',report.errors.length===0,{reason:report.errors.join('\n')});
  report.stage='screenshot';
  try{
    // Capture the renderer surface directly; native hidden-window capture
    // can fail without a Viz frame or crash during display transitions.
    const shot=await content.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
    const png=Buffer.from(shot.data,'base64');
    if(!png.length)throw Error('首屏截图为空');
    fs.writeFileSync(path.join(folder,'first-screen.png'),png);
  }catch(error){report.warnings=[...(report.warnings||[]),'首屏截图未取得：'+error.message];}
  check('app-check-hidden','隔离诊断窗口保持隐藏',windows.every(win=>win.isDestroyed()||!win.isVisible()));
}).catch(error=>check('app-startup','原生启动检查失败',false,{reason:String(error.stack||error).slice(0,2500)})).finally(finish);
