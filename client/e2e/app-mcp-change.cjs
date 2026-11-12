'use strict';
const electron=require('electron');
if(typeof electron==='string'){
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
 const result=require('node:child_process').spawnSync(electron,[__filename,'--disable-gpu'],{env,windowsHide:true,stdio:'inherit',timeout:45000});process.exit(result.status??1);
}else{
 const {app,BrowserWindow}=electron,fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-stage-event-'));app.setPath('userData',root);app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
 let upstream,pageServer,win,lease,ok=false;
 app.whenReady().then(async()=>{
  pageServer=http.createServer((req,res)=>{if(req.url==='/sdk.js'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(path.resolve(__dirname,'../sdk/soduwork-app.js')));}res.setHeader('Content-Type','text/html');res.end('<!doctype html><body><script src="/sdk.js"></script><script>window.notices=[];soduWorkApp.events.onDataChanged(value=>notices.push(value));</script></body>');});await new Promise(r=>pageServer.listen(0,'127.0.0.1',r));
  win=new BrowserWindow({show:false,webPreferences:{preload:path.resolve(__dirname,'../main/work-preview-app-preload.cjs'),contextIsolation:true,sandbox:true}});await win.loadURL('http://127.0.0.1:'+pageServer.address().port+'/');
  upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[],_meta:{'soduwork.app/data-changed':{spaceId:'team',topicId:'topic'}}}}));});});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const current={token:'fixture',revision:1};lease=await require('../main/pi-session/app-mcp-proxy.cjs').create({...current,url:'http://127.0.0.1:'+upstream.address().port+'/mcp',context:{spaceId:'team'},readCurrent:()=>current,notifyChanged:value=>win.webContents.send('app-data-changed',value)});
  const reply=await fetch(lease.url,{method:'POST',headers:{Authorization:'Bearer '+lease.token},body:'{}'});assert.equal(reply.status,200);await reply.text();
  let notices=[];for(let i=0;i<40;i++){notices=await win.webContents.executeJavaScript('notices');if(notices.length)break;await new Promise(r=>setTimeout(r,25));}
  assert.deepEqual(notices,[{topic:'content',spaceId:'team',topicId:'topic'}]);ok=true;console.log('PASS: real Electron proxy -> native IPC -> context-isolated preload -> public SDK content notice. Isolated profile; no model, live session or business writes.');
 }).catch(e=>console.error(e)).finally(()=>{lease?.cleanup();win?.destroy();for(const server of [upstream,pageServer]){server?.closeAllConnections();server?.close();}app.exit(ok?0:1);});
}
