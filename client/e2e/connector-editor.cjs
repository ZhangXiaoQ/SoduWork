'use strict';
const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const out=path.resolve(process.argv[2] || path.join(__dirname,'../../outputs/connector-foundation-20261017/browser'));fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
let win;const results=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));const js=x=>win.webContents.executeJavaScript(x,true);
const wait=async x=>{for(let i=0;i<100;i++){if(await js(x))return;await sleep(30)}throw Error('Timeout '+x)};
const click=async selector=>{if(selector.startsWith('[data-template=')&&!await js('!!document.querySelector('+JSON.stringify(selector)+')')){await js('document.querySelector("#capAddButton").click()');await wait('!!document.querySelector("[data-connector-library]")');}return js('document.querySelector('+JSON.stringify(selector)+').click()');};
const fill=(selector,value)=>js('(()=>{const n=document.querySelector('+JSON.stringify(selector)+');n.value='+JSON.stringify(value)+';n.dispatchEvent(new Event("input",{bubbles:true}));n.dispatchEvent(new Event("change",{bubbles:true}))})()');
async function open(){await click('[data-template="connector-figma"]');await wait('!!document.querySelector("#capMcpSave")')}
async function shot(name){await sleep(100);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG())}
app.whenReady().then(async()=>{try{
 win=new BrowserWindow({show:false,width:1120,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false}});await win.loadFile(path.join(__dirname,'fixtures/connector-editor.html'));await wait('document.querySelector("[data-cap-tab=connections]")');await js('window.originalEditorOpen=SoduWorkConnectorEditor.open;SoduWorkConnectorEditor.open=(ctx,...args)=>{window.apiEditorContext=ctx;return originalEditorOpen(ctx,...args)};openConnector()');await open();
 assert.equal(await js('document.querySelector("#capModalBody details").open'),false);assert.equal(await js('[...document.querySelectorAll("#capModalFoot .primary")].length'),1);await shot('client-compact');results.push('compact primary action');
 await click('#capMcpSave');await wait('document.querySelector("#capMcpProbe").textContent.includes("请填写")');assert.equal(await js('document.activeElement.dataset.connectorField'),'FIGMA_TOKEN');results.push('required focus');
 await fill('[data-connector-field="FIGMA_TOKEN"]','fixture-secret');await js('failProbe=true');await click('#capMcpSave');await wait('document.querySelector("#capMcpProbe").textContent.includes("授权已失效")');assert.equal(await js('saved.length'),0);assert.equal(await js('document.querySelector("[data-connector-field=FIGMA_TOKEN]").value'),'fixture-secret');results.push('auth failure preserved');
 await js('failProbe=false');await click('#capMcpSave');await wait('saved.length===1');assert.equal(await js('saved[0].enabled'),true);assert.equal(await js('saved[0].env.ALLOW_WRITES'),'false');results.push('checked and enabled without extra steps');
 await js('openConnector()');await click('#capAddButton');await click('[data-connector-custom]');await wait('document.querySelector("#capMcpQuickConfig")');
 await fill('#capMcpQuickConfig',JSON.stringify({mcpServers:{a:{url:'https://a.example/mcp',headers:{Authorization:'old'},enabled_tools:['read'],disabled_tools:['send'],startup_timeout_sec:33,tool_timeout_sec:99},b:{url:'https://b.example/mcp'}}}));
 await click('#capMcpSave');assert.equal(await js('saved.length'),1);assert.equal(await js('document.querySelector("#capMcpQuickChoice").hidden'),false);
 await fill('#capMcpQuickChoice','0');assert.equal(await js('document.querySelector("#capMcpEnabledTools").value'),'read');assert.equal(await js('document.querySelector("#capMcpToolTimeout").value'),'99');results.push('multi configuration selection retains policies');
 await fill('#capMcpQuickConfig','{broken');await click('#capMcpSave');assert.equal(await js('saved.length'),1);results.push('invalid replacement cannot submit previous target');
 await fill('#capMcpQuickConfig','https://new.example/mcp');assert.equal(await js('document.querySelector("#capMcpHeaders").value'),'');results.push('credentials never follow a different target');
 await click('#capModalCancel');await open();await fill('[data-connector-field="FIGMA_TOKEN"]','draft');await click('#capModalBody details summary');await js('holdProbe=true');await click('#capMcpCheck');await wait('!!window.finishProbe');await fill('[data-connector-field="FIGMA_TOKEN"]','changed');await js('holdProbe=false;finishProbe()');await sleep(80);assert.match(await js('document.querySelector("#capMcpProbe").textContent'),/配置已更新/);results.push('late probe discarded');
 await click('#capModalCancel');await click('[data-template="connector-google-drive"]');await wait('document.querySelector("#capMcpSave").textContent==="登录并连接"');
 assert.equal(await js('document.querySelector("[data-connector-field=GOOGLE_ACCESS_TOKEN]").closest("label").hidden'),true);
 await click('#capMcpSave');await wait('saved.length===2');assert.equal(await js('saved[1].oauth.connectionId'),'fixture-binding');assert.equal(await js('saved[1].env.GOOGLE_ACCESS_TOKEN'),'');assert.equal(await js('saved[1].env.ALLOW_WRITES'),'false');results.push('OAuth binding auto-connect without renderer token');await sleep(1100);assert.equal(await js('oauthCancelled'),1);
 await click('[data-template="connector-google-drive"]');await click('#capModalBody details summary');await click('#capMcpAnother');await wait('document.querySelector("#capMcpSave").textContent==="登录并连接"');await js('oauthState="pending"');await click('#capMcpSave');await sleep(50);await click('#capModalCancel');await sleep(1700);assert.equal(await js('saved.length'),2);assert.equal(await js('oauthCancelled'),2);results.push('closing OAuth cancels pending flow');
 await js('oauthState="connected";failProbe=true');await click('[data-template="connector-google-drive"]');await click('#capModalBody details summary');await click('#capMcpAnother');await wait('document.querySelector("#capMcpSave").textContent==="登录并连接"');await click('#capMcpSave');await wait('document.querySelector("#capMcpProbe").textContent.includes("授权已失效")');await click('#capModalCancel');await sleep(1100);assert.equal(await js('oauthCancelled'),3);assert.equal(await js('saved.length'),2);results.push('unsaved successful OAuth is cleaned after failed check');
 await js('oauthAvailable=false');await click('[data-template="connector-google-drive"]');await click('#capModalBody details summary');await click('#capMcpAnother');await wait('document.querySelector("[data-connector-oauth]").textContent.includes("管理员")');assert.equal(await js('document.querySelector("[data-connector-field=GOOGLE_ACCESS_TOKEN]").closest("label").hidden'),false);results.push('unconfigured login reports setup and preserves token path');await click('#capModalCancel');await open();

 await click('#capModalCancel');
 const {compile}=require('../../skills/mcp-tools/connectors/api-definition.cjs');
 const apiDef=compile({name:'研发系统',baseUrl:'https://api.example.com',securitySchemes:{auth:{type:'apiKey',in:'header',name:'X-API-Key'}},security:[{auth:[]}],endpoints:[{method:'GET',path:'/me',name:'identity'}]});
 await js('window.apiInitial='+JSON.stringify({id:'api-fixture',name:apiDef.name,type:'stdio',command:'soduwork-api',args:[],apiDefinition:apiDef,env:{},enabled:false})+';failProbe=false;originalEditorOpen(apiEditorContext,apiInitial,null)');
 assert.equal(await js('document.querySelector("[data-connector-field=AUTH_AUTH_KEY]").type'),'password');
 assert.equal(await js('document.querySelector("#capMcpQuickConfig")'),null);
 await fill('[data-connector-field=AUTH_AUTH_KEY]','fixture-value');await click('#capMcpSave');await wait('saved.length===3');
 assert.equal(await js('saved[2].command'),'soduwork-api');assert.equal(await js('saved[2].approvedTarget'),'api:'+apiDef.id);assert.equal(await js('saved[2].apiDefinition.tools.length'),1);results.push('imported API definition prefills credential form and survives save');
 const oauthDef=compile({name:'研发系统 OAuth',baseUrl:'https://api.example.com',securitySchemes:{auth:{type:'oauth2',flows:{authorizationCode:{authorizationUrl:'https://login.example.com/authorize',tokenUrl:'https://login.example.com/token',scopes:{read:''}}}}},security:[{auth:['read']}],endpoints:[{method:'GET',path:'/me',name:'identity'},{method:'POST',path:'/projects',name:'create_project'}]});
 await js('window.apiOAuthInitial='+JSON.stringify({id:'api-oauth-fixture',name:oauthDef.name,type:'stdio',command:'soduwork-api',args:[],apiDefinition:oauthDef,env:{},enabled:false})+`;SoduWorkAPI.startConnectorOAuth=async(provider,id,server)=>{window.apiOAuthSent={provider,id,server};return{attemptId:'api-attempt',authorizationUrl:'https://login.example.com/authorize'}};SoduWorkAPI.connectorOAuthStatus=async()=>({state:'connected',oauth:{provider:'api',connectionId:'api-binding'}});originalEditorOpen(apiEditorContext,apiOAuthInitial,null)`);
 await wait('document.querySelector("#capMcpSave").textContent==="登录并连接"');
 assert.equal(await js('document.querySelector("[data-connector-field=AUTH_AUTH_ACCESS_TOKEN]").closest("label").hidden'),true);
 assert.equal(await js('document.querySelector("[data-connector-field=ALLOW_WRITES]").closest("label").hidden'),false);
 await fill('[data-connector-field=AUTH_AUTH_CLIENT_ID]','fixture-id');await fill('[data-connector-field=AUTH_AUTH_CLIENT_SECRET]','fixture-value');await click('#capMcpSave');await wait('saved.length===4');
 assert.equal(await js('apiOAuthSent.provider'),'api');assert.equal(await js('apiOAuthSent.server.apiDefinition.id'),oauthDef.id);assert.equal(await js('saved[3].oauth.provider'),'api');assert.equal(await js('saved[3].env.AUTH_AUTH_ACCESS_TOKEN'),'');results.push('generic OAuth uses document and binding without renderer token');
 await open();
 for(const [w,h]of [[390,740],[900,640]]){win.setContentSize(w,h);await sleep(80);const g=await js('(()=>{const r=document.querySelector(".cap-connector-editor").getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,w:innerWidth,h:innerHeight,scroll:document.documentElement.scrollWidth}})()');assert.ok(g.left>=0&&g.right<=g.w+1&&g.top>=0&&g.bottom<=g.h+1&&g.scroll<=g.w+1,JSON.stringify(g));await shot('client-'+w);results.push('layout '+w)}
 await click('#capModalCancel');
 const definition=require('../../skills/mcp-tools/connectors/providers/redis.json');
 const redis={key:'connector-redis',name:'Redis',configurable:true,template:{command:'soduwork-connector'},connectionFields:definition.fields};
 await js('originalEditorOpen(apiEditorContext,null,'+JSON.stringify(redis)+')');
 const field=key=>'[data-connector-field="'+key+'"]';
 assert.equal(await js('document.querySelector('+JSON.stringify(field('REDIS_PORT'))+').value'),'6379');
 await fill(field('REDIS_HOST'),'127.0.0.1');await fill(field('REDIS_PORT'),'16379');
 const tls=field('REDIS_TLS');assert.equal(await js('document.querySelector('+JSON.stringify(tls)+').checked'),true);
 const point=await js('(()=>{const n=document.querySelector('+JSON.stringify(tls)+');n.scrollIntoView({block:"center"});const r=n.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
 win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
 win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
 await wait('!document.querySelector('+JSON.stringify(tls)+').checked');
 await shot('redis-local');
 await click('#capMcpSave');await wait('saved.length===5');
 assert.equal(await js('saved[4].env.REDIS_TLS'),'false');assert.equal(await js('saved[4].env.REDIS_PORT'),'16379');
 results.push('visible catalog port and native Redis TLS input persist through probe and save');
 for(const name of ['platform-plugin-connect.js','platform-connection-directory.js']){
  await js(fs.readFileSync(path.join(__dirname,'../components/panels',name),'utf8'));
 }
 await js(`window.conflictingRow={id:'other-personal',name:'feishu',type:'http',url:'https://fixture.invalid/mcp',enabled:true,canEdit:true};
 SoduWorkAPI.myMcpServers=async()=>({personal:[conflictingRow],company:[],enabledCompany:[]});
 const platformState=async key=>({ok:true,provider:key,state:key==='feishu'?'error':'needs_setup',
   installed:true,added:key==='feishu',conflictId:key==='feishu'?conflictingRow.id:''});
 soduWorkAPI.platformConnections={status:platformState,refresh:platformState};
 SoduWorkPlatformDirectory.reset();openConnector();void 0`);
 await wait('!!document.querySelector(\'[data-connection-manage="native:feishu"]\')');
 await click('[data-connection-manage="native:feishu"]');
 await wait('document.querySelector("#capPlatformNote + button")?.hidden===false');
 await click('#capPlatformNote + button');
 await wait('document.activeElement.id==="capMcpName"');assert.equal(await js('document.activeElement.value'),'feishu');
 assert.equal(await js('saved.length'),5);
 results.push('foreign Feishu registration opens its existing editor with the name focused and no implicit write');
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({ok:true,results},null,2));console.log(JSON.stringify({ok:true,results}));app.exit(0);
}catch(e){console.error(e.stack);if(win)console.error(await js('({errors:window.errors,body:document.body.innerText.slice(0,700)})'));if(win)await shot('failure');app.exit(1)}});
