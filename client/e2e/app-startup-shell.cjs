'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const run = require('node:child_process').spawnSync(electron, [__filename], { env, windowsHide:true, stdio:'inherit', timeout:45000 });
  process.exit(run.status ?? 1);
}
const {app,BrowserWindow,WebContentsView,ipcMain}=electron;
// Control only the two-minute startup timer; Chromium and fixture I/O stay real.
const startupTimers=new Map(),nativeSetTimeout=global.setTimeout,nativeClearTimeout=global.clearTimeout;
global.setTimeout=(callback,delay,...args)=>{if(delay!==120000)return nativeSetTimeout(callback,delay,...args);const handle={unref(){}};startupTimers.set(handle,()=>callback(...args));return handle;};
global.clearTimeout=handle=>{if(!startupTimers.delete(handle))nativeClearTimeout(handle);};
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-startup-shell-'));
app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const windows=[];let host,server,release,fail=true;
const report={ok:false,evidence:root,boundary:'Real isolated Electron shell and slow/failing loopback pages. No model, account or business data.'};
const wait=async(fn)=>{for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,25));}throw Error('State timeout');};
app.whenReady().then(async()=>{
  fs.writeFileSync(path.join(root,'host.html'),'<!doctype html>Host');
  fs.writeFileSync(path.join(root,'composer.html'),'<!doctype html><textarea id="draft">keep draft</textarea>');
  server=http.createServer((req,res)=>{
    const send=()=>res.end('<!doctype html><title>Ready</title><h1>应用已打开</h1>');
    if(req.url==='/slow')release=send;
    else if(fail)res.destroy();else send();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  require('../main/work-preview').install({ipcMain,
    BrowserWindow:Object.assign(function(options){const win=new BrowserWindow(options);windows.push(win);return win;},{fromWebContents:wc=>BrowserWindow.fromWebContents(wc)}),
    WebContentsView:function(options){const view=new WebContentsView(options),load=view.webContents.loadFile.bind(view.webContents);view.webContents.loadFile=(file,q)=>load(path.basename(file)==='desk.html'?path.join(root,'composer.html'):file,q);return view;},
    shell:{openExternal:async()=>{throw Error('external forbidden');}}});
  host=new BrowserWindow({show:false,webPreferences:{preload:path.resolve(__dirname,'../preload.js'),contextIsolation:true,sandbox:true}});
  await host.loadFile(path.join(root,'host.html'));
  const icon=electron.nativeImage.createFromPath(path.resolve(__dirname,'../icon.png')).resize({width:64}).toDataURL();
  const open=async id=>host.webContents.executeJavaScript('soduWorkAPI.workPreview.showDetached('+JSON.stringify({tabId:id,label:'启动体验测试',icon,url:'http://127.0.0.1:'+server.address().port+'/'+id})+')');
  await open('slow');
  const win=windows[0],[chrome,content,composer]=win.contentView.children;
  const js=code=>chrome.webContents.executeJavaScript(code);
  await wait(async()=>release&&win.isVisible()&&!chrome.webContents.isLoading());
  assert.equal(content.getVisible(),false);
  assert.equal(await js('startup.hidden'),false);
  assert.equal(await js('document.getElementById("startup-name").textContent'),'启动体验测试');
  assert.equal(await js('document.getElementById("startup-icon").hidden'),false);
  assert.equal(await js('document.getElementById("startup-icon").src'),icon);
  fs.writeFileSync(path.join(root,'loading.png'),(await chrome.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  const fullBounds=chrome.getBounds();
  chrome.setBounds({...fullBounds,height:30});
  await wait(()=>js('innerHeight<=60'));
  assert.equal(await js('getComputedStyle(startup).display'),'none','old title-only hosts cannot show clipped splash artwork');
  chrome.setBounds(fullBounds);await wait(()=>js('innerHeight>60'));
  release();await wait(()=>content.getVisible());
  assert.equal(await js('startup.hidden'),true);
  assert.equal(await js('getComputedStyle(startup).display'),'none','ready pages leave no splash artwork visible');
  await open('failure');
  const [errorChrome,errorContent,errorComposer]=windows[1].contentView.children;
  await wait(()=>!errorComposer.webContents.isLoading());
  await errorComposer.webContents.executeJavaScript('document.querySelector("button").click()');
  await wait(()=>errorComposer.webContents.getURL().includes('/composer.html')&&!errorComposer.webContents.isLoading());
  await wait(()=>errorChrome.webContents.executeJavaScript('soduWorkWindowChrome.action("state").then(r=>r.state.startup==="error")'));
  assert.equal(await errorChrome.webContents.executeJavaScript('document.getElementById("retry").hidden'),true);
  assert.equal(await errorChrome.webContents.executeJavaScript('document.getElementById("startup-note").textContent'),'正在打开…');
  for(const [handle,callback]of [...startupTimers]){startupTimers.delete(handle);callback();}
  await wait(()=>errorChrome.webContents.executeJavaScript('!document.getElementById("retry").hidden'));
  assert.equal(errorContent.getVisible(),false);
  fail=false;
  await errorChrome.webContents.executeJavaScript('document.getElementById("retry").click()');
  await wait(()=>errorContent.getVisible());
  assert.equal(await errorComposer.webContents.executeJavaScript('draft.value'),'keep draft');
  report.ok=true;report.cases=['slow first load shows host identity instead of blank content','content revealed after document paint','load error remains in host shell','retry recovers without replacing composer draft'];
}).catch(error=>{report.error=String(error.stack||error);}).finally(async()=>{
  host?.destroy();for(const win of windows)if(!win.isDestroyed())win.destroy();
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(report.ok?0:1);
});
