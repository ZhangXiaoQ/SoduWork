// Isolated Electron + real preload + real connection IPC. Platform replies are fixtures.
// Set SODUWORK_E2E_FEISHU_PREFIX to a disposable npm prefix containing the exact
// packages in runtime.provider('feishu'); never read an installed user's tools.
const {app,BrowserWindow,ipcMain,safeStorage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const evidence=process.argv[2];if(!evidence||!path.isAbsolute(evidence))throw Error('Explicit evidence directory required');
fs.mkdirSync(evidence,{recursive:true});
const profile=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'soduwork-platform-session-e2e-'));
app.setPath('userData',profile);
const runtime=require('../main/platform-connections/runtime.cjs');
const feishu=require('../main/platform-connections/feishu.cjs');
const auth=require('../main/platform-connections/feishu-auth.cjs');
const realPaths=runtime.paths,realExecute=runtime.execute,realFetch=global.fetch;
let toolPrefix,sdk,sdkVersion;
try{
 toolPrefix=process.env.SODUWORK_E2E_FEISHU_PREFIX;
 assert.ok(toolPrefix&&path.isAbsolute(toolPrefix),'Set SODUWORK_E2E_FEISHU_PREFIX to an absolute isolated npm prefix');
 const declared=runtime.provider('feishu');
 const lock=JSON.parse(fs.readFileSync(path.join(toolPrefix,'package-lock.json'),'utf8'));
 for(const expected of [declared,declared.registrationSdk]){
  const installed=JSON.parse(fs.readFileSync(path.join(toolPrefix,'node_modules',expected.package,'package.json'),'utf8'));
  assert.equal(installed.version,expected.version,expected.package+': unexpected installed version');
  const locked=lock.packages?.['node_modules/'+expected.package];
  assert.equal(locked?.version,expected.version,expected.package+': unexpected locked version');
  assert.equal(locked?.integrity,expected.npmIntegrity,expected.package+': registry integrity differs from runtime declaration');
 }
 sdk=require(path.join(toolPrefix,'node_modules',declared.registrationSdk.package));
 sdkVersion=declared.registrationSdk.version;
}catch(error){
 const message='Platform E2E dependency preflight failed: '+error.message;
 fs.writeFileSync(path.join(evidence,'failure.txt'),message+'\n');
 console.error(message);
 // Exit before creating a BrowserWindow; uncaught Electron startup errors open
 // a modal dialog and leave headless CI waiting for a user who cannot dismiss it.
 process.exit(1);
}
let opened=0,cancelled=0,registrationAllowed=false,userAllowed=false,registrations=0,loginAttempts=0;
let mcpConfig=null,probeTools=[],refreshes=0;
const ownedPorts=new Set();
runtime.paths=(...args)=>{const p=realPaths(...args);if(args[1]==='feishu')p.prefix=toolPrefix;return p;};
runtime.execute=(command,args,options)=>{
 assert.equal(args[args.indexOf('--token-mode')+1],'user_access_token');
 assert.equal(options.env.USER_ACCESS_TOKEN,refreshes ? 'fixture-rotated-access' : 'fixture-personal-access');
 return realExecute(command,['--require',path.join(__dirname,'fixtures/feishu-mcp-http.cjs'),...args],
  {...options,env:{...options.env,SODUWORK_E2E_MCP_ROOT:path.join(toolPrefix,'node_modules/@larksuiteoapi/lark-mcp')}});
};
sdk.defaultHttpInstance.post=async(url,body)=>{
 assert.equal(url,'https://accounts.feishu.cn/oauth/v1/app/registration');
 const form=new URLSearchParams(body);
 if(form.get('action')==='begin'){
  registrations++;assert.equal(form.get('archetype'),'PersonalAgent');
  return{verification_uri_complete:'https://accounts.feishu.cn/oauth/app/registration?user_code=APP-FIXTURE',device_code:'fixture-registration-private',expires_in:600,interval:0.05};
 }
 assert.equal(form.get('device_code'),'fixture-registration-private');
 return registrationAllowed?{client_id:'cli_fixture',client_secret:'fixture-secret',user_info:{tenant_brand:'feishu'}}:{error:'authorization_pending'};
};
async function rpc(selected,method,params={}){
 const result=await realFetch(selected.url,{method:'POST',headers:{...selected.headers,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 assert.equal(result.status,200);const raw=await result.text();
 const payload=raw.startsWith('event:')?JSON.parse(raw.split('\n').find(x=>x.startsWith('data:')).slice(5)):JSON.parse(raw);
 if(payload.error)throw Error(JSON.stringify(payload.error));return payload.result;
}
runtime.inspect=async(_app,key)=>({status:'installed',label:runtime.LABELS[key]});
let dingtalkAuthorized=false, finishDingtalk;
runtime.launch=async(_app,key,_scope,args,options)=>{
 if(args[1]==='show'||args[1]==='status')return{completion:Promise.resolve({code:0,output:key==='wecom'?'unauthorized':JSON.stringify({success:true,authenticated:dingtalkAuthorized})})};
 let finish;const completion=new Promise(resolve=>{finish=resolve});
 if(key==='dingtalk')finishDingtalk=()=>{dingtalkAuthorized=true;finish({code:0,output:'{"success":true}'})};
 setTimeout(()=>options.onOutput(key==='wecom'?'https://work.weixin.qq.com/ai/qc/gen?scode=fixture':'https://login.dingtalk.com/device user_code: ABCD-EFGH'),30);
 return{completion,cancel(){cancelled++;finish({code:1,output:''})}};
};
const fixtures=require('../tests/helpers/platform-session-fixture.cjs').backendSessions();
const deviceAuth=require('../main/device-auth');
const hub='https://fixture.invalid';
let activeSession=fixtures.one,enrollmentAllowed=true,enrollments=0;
// Hub responses are local fixtures, but tokens use the real Python Hub issuer.
global.fetch=async(url,options)=>{
 const reply=data=>({ok:true,status:200,json:async()=>data});
 if(url==='https://accounts.feishu.cn/oauth/v1/device_authorization'){
  loginAttempts++;assert.equal(options.headers.Authorization,'Basic '+Buffer.from('cli_fixture:fixture-secret').toString('base64'));
  return reply({device_code:'fixture-user-device-private',user_code:'USER-CODE',verification_uri_complete:'https://accounts.feishu.cn/oauth/device?user_code=USER-CODE',expires_in:600,interval:0.05});
 }
 if(url==='https://open.feishu.cn/open-apis/authen/v2/oauth/token'){
  const form=new URLSearchParams(options.body);assert.equal(form.get('client_secret'),'fixture-secret');
  if(form.get('grant_type')==='refresh_token'){refreshes++;return reply({access_token:'fixture-rotated-access',refresh_token:'fixture-rotated-refresh',expires_in:7200});}
  assert.equal(form.get('device_code'),'fixture-user-device-private');
  return reply(userAllowed?{access_token:'fixture-personal-access',refresh_token:'fixture-refresh',expires_in:7200}:{error:'authorization_pending'});
 }
 if(url==='https://open.feishu.cn/open-apis/authen/v1/user_info'){
  assert.ok(['Bearer fixture-personal-access','Bearer fixture-rotated-access'].includes(options.headers.Authorization));
  return reply({code:0,data:{open_id:'ou_fixture',name:'测试账号（隔离环境）'}});
 }
 if(url===hub+'/api/v1/mcp-servers/probe'){
  const selected=JSON.parse(options.body);
  if(selected.headers.Authorization==='••••'){
    assert.equal(selected.id,mcpConfig.id);selected.headers={...mcpConfig.headers};
  }
  const init=await rpc(selected,'initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'soduwork-qa',version:'1'}});
  assert.ok(init.serverInfo.name.includes('Feishu'));probeTools=(await rpc(selected,'tools/list')).tools;
  assert.ok(probeTools.length>0);return reply({ok:true,tools:probeTools});
 }
 if(url===hub+'/api/v1/mcp-servers/upsert'){
  const body=JSON.parse(options.body);assert.equal(options.method,'POST');assert.equal(body.original?.id||null,mcpConfig?.id||null);
  mcpConfig=body.server;ownedPorts.add(Number(new URL(mcpConfig.url).port));return reply({ok:true});
 }
 if(url===hub+'/api/v1/mcp-servers')return reply({personal:mcpConfig?[{...mcpConfig,headers:{Authorization:'••••'}}]:[],company:[],enabledCompany:[]});
 if(String(url).startsWith('http://127.0.0.1:'))return realFetch(url,options);
 assert.equal(url,hub+'/api/v1/clients/enroll');
 assert.equal(JSON.parse(options.body).device,'device');
 enrollments++;
 return{ok:enrollmentAllowed,status:enrollmentAllowed?200:401,text:async()=>JSON.stringify(enrollmentAllowed?
  {authState:'active',session:activeSession,expiresIn:1800}:{detail:'Isolated session revoked'})};
};
deviceAuth.install({app,ipcMain,safeStorage});
async function identityOf(){
 const id=deviceAuth.identity(app);if(!id)return null;
 try{return{...id,session:await deviceAuth.ensureSession(app,id)}}catch(_){return id}
}
const service=require('../main/platform-connections/index.cjs').install({app,ipcMain,safeStorage,identityOf,shell:{async openExternal(url){assert.match(url,/^https:\/\/(work\.weixin\.qq\.com|login\.dingtalk\.com|accounts\.feishu\.cn)\//);opened++;}}});
const checks=[];let win;
const labels={wecom:'企业微信',dingtalk:'钉钉',feishu:'飞书'};
const run=code=>win.webContents.executeJavaScript(code,true);
async function until(code){for(let i=0;i<80;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,100));}
 const note=await run("document.getElementById('capPlatformNote')?.textContent");
 throw Error('UI state timeout: '+code+' ('+String(note||'')+')');}
async function click(id){const pos=await run(`(()=>{const b=document.getElementById(${JSON.stringify(id)});if(!b||b.disabled)throw Error('Disabled button');const r=b.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...pos});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...pos});}
async function ownUI(key){
 const visible=await run("document.querySelector('.modal').innerText");
 assert.ok(visible.includes(labels[key]),key+': displays own platform');
 for(const other of Object.keys(labels).filter(k=>k!==key))assert.ok(!visible.includes(labels[other]),key+': must not request '+labels[other]+' authorization');
 assert.equal(await run("!!document.getElementById('capPlatformAppSecret')"),false);
 assert.equal(await run("document.documentElement.scrollWidth>window.innerWidth"),false);
}
app.whenReady().then(async()=>{
 win=new BrowserWindow({width:700,height:740,show:false,webPreferences:{preload:path.resolve(__dirname,'../preload.js'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
 await win.loadFile(path.join(__dirname,'fixtures/platform-connections.html'));
 const login=await run("soduWorkAPI.deviceAuthBootstrap({hub:'https://fixture.invalid',clientId:'device',legacySecret:'isolated-device-key-at-least-32-chars'})");
 assert.equal(login.ok,true,login.error);assert.equal(login.session,fixtures.one);
 assert.equal((await run("soduWorkAPI.deviceAuthStatus() ")).sessionReady,true);
 checks.push('real Hub issuer + desktop enrollment/session cache + preload/IPC connection chain');
 for(const key of ['wecom','dingtalk']){
  await run(`testOpen('${key}')`);await until("document.getElementById('capPlatformState').dataset.state==='needs_auth'");
  await ownUI(key);
  await new Promise(r=>setTimeout(r,500));
  fs.writeFileSync(path.join(evidence,key+'-connection.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  await click('capPlatformStart');await until("!document.getElementById('capPlatformAuth').hidden");
  await ownUI(key);
  fs.writeFileSync(path.join(evidence,key+'-authorization.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  assert.equal(await run("document.getElementById('capPlatformStart').disabled"),true);
  // Closing and reopening must resume polling the same authorization job.
  await click('capPlatformClose');await run(`testOpen('${key}')`);
  await until("!document.getElementById('capPlatformAuth').hidden");
  await ownUI(key);
  await click('capPlatformAuthOpen');await new Promise(r=>setTimeout(r,50));
  if(key==='dingtalk')assert.equal(await run("document.getElementById('capPlatformCode').textContent"),'ABCD-EFGH');
  await click('capPlatformCancel');await until("document.getElementById('capPlatformState').dataset.state==='needs_auth'");
  checks.push(key+': real preload/IPC, official link button, duplicate guard, cancel');
 }
 assert.equal(opened,2);assert.equal(cancelled,2);
 await run("testOpen('feishu')");await until("document.getElementById('capPlatformState').dataset.state==='needs_auth'");
 await ownUI('feishu');
 await new Promise(r=>setTimeout(r,500));
 fs.writeFileSync(path.join(evidence,'feishu-connection.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
 await click('capPlatformStart');await until("document.getElementById('capPlatformAuthOpen').textContent==='前往飞书扫码创建应用'&&!document.getElementById('capPlatformAuth').hidden");
 await ownUI('feishu');
 fs.writeFileSync(path.join(evidence,'feishu-app-registration.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
 const appStage=await service.status('feishu');
 const officialUrl=new URL(appStage.authUrl);assert.equal(officialUrl.searchParams.get('createOnly'),'true');assert.ok(officialUrl.searchParams.get('addons'));
 assert.ok(!JSON.stringify(appStage).includes('private'));await click('capPlatformAuthOpen');
 registrationAllowed=true;
 await until("document.getElementById('capPlatformAuthOpen').textContent==='前往飞书扫码授权'&&!document.getElementById('capPlatformAuth').hidden");
 fs.writeFileSync(path.join(evidence,'feishu-user-authorization.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
 win.setSize(420,760);await new Promise(r=>setTimeout(r,400));await ownUI('feishu');
 assert.equal(await run("Array.from(document.querySelectorAll('.footer button')).filter(b=>!b.hidden).every(b=>{const r=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})"),true);
 fs.writeFileSync(path.join(evidence,'feishu-user-authorization-narrow.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
 checks.push('Feishu authorization at 420px: no horizontal overflow and all action buttons visible');
 win.setSize(700,740);await new Promise(r=>setTimeout(r,300));
 await click('capPlatformCancel');await until("document.getElementById('capPlatformState').dataset.state==='needs_auth'");
 await click('capPlatformStart');await until("document.getElementById('capPlatformAuthOpen').textContent==='前往飞书扫码授权'&&!document.getElementById('capPlatformAuth').hidden");
 assert.equal(registrations,1);assert.equal(loginAttempts,2);
 await click('capPlatformClose');await run("testOpen('feishu')");await until("!document.getElementById('capPlatformAuth').hidden");
 await click('capPlatformAuthOpen');userAllowed=true;
 await until("document.getElementById('capPlatformState').dataset.state==='connected'");
 const state=await run("soduWorkAPI.platformConnections.status('feishu')");assert.equal(state.connected,true);
 for(const secret of ['fixture-secret','fixture-personal-access','fixture-refresh'])assert.ok(!JSON.stringify(state).includes(secret));
 assert.ok(probeTools.every(t=>!t.name.includes('message_create')));
 const docTool=probeTools.find(t=>t.name.includes('rawContent'));assert.ok(docTool,'user document tool available');
 const doc=await rpc(mcpConfig,'tools/call',{name:docTool.name,arguments:{path:{document_id:'doc-fixture'}}});
 assert.ok(JSON.stringify(doc).includes('Isolated personal document'),JSON.stringify(doc));
 const scope=runtime.platformScope(app,await identityOf(),'feishu'),saved=feishu.read(app,scope,safeStorage);
 assert.ok(saved,'environment-bound Feishu credentials must be encrypted and persisted');
 assert.equal(saved.port,Number(new URL(mcpConfig.url).port));
 saved.expiresAt=1;feishu.save(app,scope,saved,safeStorage);
 await feishu.ensureToken(app,scope,saved,safeStorage,identityOf);
 assert.equal(refreshes,1);
 const rotated=await rpc(mcpConfig,'tools/call',{name:docTool.name,arguments:{path:{document_id:'doc-fixture'}}});
 assert.ok(JSON.stringify(rotated).includes('Isolated document after token refresh'),JSON.stringify(rotated));
 fs.writeFileSync(path.join(evidence,'feishu-connected.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
 checks.push('feishu: actual official SDK registration + cancel/retry reuse + personal device OAuth + OS-encrypted persistence');
 checks.push('official MCP child initialize/tools/list/read document using personal token, refresh rotation and no credential IPC exposure');
 for(const key of ['wecom','dingtalk']){await run(`testOpen('${key}')`);await until("document.getElementById('capPlatformState').dataset.state==='needs_auth'");await ownUI(key);}
 checks.push('switching away from connected Feishu preserves independent CLI platform states');
 await click('capPlatformStart');await until("!document.getElementById('capPlatformAuth').hidden");
 finishDingtalk();await until("document.getElementById('capPlatformState').dataset.state==='connected'");
 checks.push('DingTalk browser completion triggers CLI status verification and updates the open dialog');
 const localScope=runtime.platformScope(app,await identityOf(),'feishu');
 mcpConfig.id='previous-'+localScope.slice(0,23);
 feishu.closeScope(localScope);
 await run("testOpen('feishu')");await until("document.getElementById('capPlatformState').dataset.state==='connected'");
 assert.equal(mcpConfig.id,'previous-'+localScope.slice(0,23));
 checks.push('Feishu reuses the older scoped ID only after a masked credential reaches the authenticated loopback proxy');
 const originalScope=runtime.scope(await identityOf());
 activeSession=fixtures.renewed;
 await run('soduWorkAPI.deviceAuthClearSession()');
 assert.equal((await run("soduWorkAPI.platformConnections.status('feishu')")).connected,true);
 assert.equal(runtime.scope(await identityOf()),originalScope);
 assert.equal(enrollments,2);
 checks.push('session refresh uses real ensureSession; same user retains existing platform account');
 activeSession=fixtures.two;
 await run('soduWorkAPI.deviceAuthClearSession()');
 const switched=await run("soduWorkAPI.platformConnections.status('feishu')");
 assert.equal(switched.ok,true);assert.equal(switched.connected,false);
 assert.notEqual(runtime.scope(await identityOf()),originalScope);
 checks.push('account switch cannot inherit previous user connection state');
 enrollmentAllowed=false;
 await run('soduWorkAPI.deviceAuthClearSession()');
 await run("testOpen('wecom')");await until("document.getElementById('capPlatformState').dataset.state==='error'");
 assert.ok((await run("document.getElementById('capPlatformNote').textContent")).includes('登录 SoduWork'));
 assert.equal((await run("soduWorkAPI.platformConnections.connect('dingtalk')")).ok,false);
 checks.push('revoked SoduWork session blocks connection through real UI/IPC');
 assert.equal((await run("soduWorkAPI.platformConnections.connect('../escape')")).ok,false);
 checks.push('unrecognized provider rejected at real IPC boundary');
 await new Promise(r=>setTimeout(r,500));
 fs.writeFileSync(path.join(evidence,'connection-form.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
 fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({ok:true,mode:'isolated platform replies; real Electron preload/IPC/UI',checks,officialSdk:sdkVersion,officialMcp:runtime.provider('feishu').version,toolCount:probeTools.length,ownedPorts:[...ownedPorts]},null,2));
 console.log(JSON.stringify({ok:true,checks:checks.length}));service.close();app.quit();
}).catch(error=>{fs.writeFileSync(path.join(evidence,'failure.txt'),error.stack);console.error(error.message);service.close();app.exit(1)});
setTimeout(()=>{fs.writeFileSync(path.join(evidence,'failure.txt'),'UI test timeout\n');console.error('UI test timeout');service.close();app.exit(1)},55000).unref();
