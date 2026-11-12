'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const run = require('node:child_process').spawnSync(electron,[__filename],{env,windowsHide:true,stdio:'inherit',timeout:45000});process.exit(run.status??1);
}
const {app,BrowserWindow,WebContentsView,ipcMain}=electron;
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'sw-conditional-native-'));
app.setPath('userData',path.join(root,'profile'));app.on('window-all-closed',()=>{});
let server,host,owner='account-a',allowed=true,full=0,conditional=0,legacy=0;
const windows=[],views=[];
const wait=async check=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,25));}throw Error('Native conditional package timed out');};
app.whenReady().then(async()=>{
 const definition={ui:{contributions:[{id:'main',title:'Conditional',slot:'workspace.navigation',source:{type:'package',entry:'ui/index.html',bridge:{version:1,capabilities:[]}}}]},resources:[
  {path:'ui/index.html',kind:'ui',encoding:'utf8',content:'<title>Conditional fixture</title><link rel="stylesheet" href="style.css"><script src="app.js"></script>'},
  {path:'ui/style.css',kind:'ui',encoding:'utf8',content:'body{color:rgb(12,34,56)}'},
  {path:'ui/app.js',kind:'ui',encoding:'utf8',content:'fetch("data.json").then(r=>r.json()).then(v=>{window.nativeReady=v.ok})'},
  {path:'ui/data.json',kind:'ui',encoding:'utf8',content:'{"ok":true}'}]};
 server=http.createServer((req,res)=>{
  if (!req.headers.authorization?.startsWith('Device ')) { legacy++; res.writeHead(401);res.end();return; }
  if(!allowed){res.writeHead(403);res.end();return;}
  if(req.headers['if-none-match']==='"fixture-v1"'){conditional++;res.writeHead(304,{ETag:'"fixture-v1"'});res.end();return;}
  full++;res.writeHead(200,{'Content-Type':'application/json',ETag:'"fixture-v1"'});res.end(JSON.stringify(definition));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const hub='http://127.0.0.1:'+server.address().port;
 require('../main/app-settings-store.cjs').configure({app,ownerOf:()=>owner});
 require('../main/work-preview').install({app,ipcMain,identityOf:()=>({hub,clientId:'fixture',secret:'isolated-device-secret'}),
  authenticatedIdentityOf:async()=>({hub,clientId:'fixture',session:'isolated-session'}),
  BrowserWindow:Object.assign(function(options){const win=new BrowserWindow(options);windows.push(win);return win;},{fromWebContents:wc=>BrowserWindow.fromWebContents(wc)}),
  WebContentsView:function(options){const view=new WebContentsView(options);views.push(view);return view;},shell:{openExternal:async()=>{}}
 });
 fs.writeFileSync(path.join(root,'host.html'),'<title>Conditional host</title>');
 host=new BrowserWindow({show:false,webPreferences:{preload:path.resolve(__dirname,'../preload.js'),contextIsolation:true,sandbox:true}});await host.loadFile(path.join(root,'host.html'));
 const payload={tabId:'conditional',label:'Conditional app',package:{pluginId:'remote-conditional',contributionId:'main'}};
 const open=()=>host.webContents.executeJavaScript('soduWorkAPI.workPreview.showDetached('+JSON.stringify(payload)+')');
 assert.equal((await open()).ok,true);
 const page=views[0];await wait(()=>page.webContents.getTitle()==='Conditional fixture'&&!page.webContents.isLoading());
 await wait(()=>page.webContents.executeJavaScript('window.nativeReady===true'));
 assert.equal(full,1);assert.ok(conditional>=4,'every native resource uses authorized conditional requests');
 assert.equal((await open()).reused,true);assert.equal(windows.length,1);
 allowed=false;
 assert.equal(await page.webContents.executeJavaScript('fetch("data.json").then(r=>r.status)'),403);
 allowed=true;owner='account-b';
 const reopened=await open();assert.equal(reopened.ok,true);assert.equal(reopened.reused,undefined);
 assert.equal(windows.length,2,'same package bytes cannot reuse the previous account partition');
 assert.equal(windows[0].isDestroyed(),true);
 assert.ok(full>=2,'new account loads its own verified package snapshot');
 assert.equal(legacy,0,'all resource requests carry account authentication, never device-secret compatibility headers');
 console.log(JSON.stringify({ok:true,full,conditional,legacy,boundary:'Production native HTTPS resource protocol, Node fetch and strict real HTTP loopback authentication rejecting legacy device headers. Fixture account ownership only; no real Hub or model.'}));
}).catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{
 host?.destroy();for(const win of windows)if(!win.isDestroyed())win.destroy();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}app.exit(process.exitCode||0);
});
