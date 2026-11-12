'use strict';
// Production renderer, Store and HTTP API against an isolated Hub database.
// Native file preview and provider execution are explicit test boundaries.
const {app,BrowserWindow,ipcMain}=require('electron');
const {pathToFileURL}=require('node:url'),crypto=require('node:crypto');
const libraryStore=require('../main/library-local-store.cjs'),libraryActions=require('../main/library-local-actions.cjs');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const [output,hub]=process.argv.slice(2);
if(!path.isAbsolute(output||'')||!/^http:\/\/127\.0\.0\.1:\d+$/.test(hub||''))throw Error('Explicit evidence directory and isolated Hub required');
fs.mkdirSync(output,{recursive:true});fs.mkdirSync(path.join(output,'profile'),{recursive:true});const libraryWorkRoot=path.join(output,'workspace');fs.mkdirSync(libraryWorkRoot,{recursive:true});app.setPath('userData',path.join(output,'profile'));
const report={ok:false,scope:'Production renderer/Store/API + isolated HTTP/SQLite and real local library files; fixture identity/IPC boundary, deterministic provider and preview transport',checks:[]};
const windows=[];const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function call(url,method='GET',body){const r=await fetch(hub+url,{method,headers:{'Content-Type':'application/json'},body:body&&JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(JSON.stringify(data));return data;}

// Fixture-only IPC retains real store/actions file operations and account/path validation.
// This fixture does not replace or relax production trusted-window validation in library-local.cjs.
const owners=Object.fromEntries(['sender','recipient','other'].map(id=>[id,crypto.randomBytes(16).toString('hex')]));
const identities=new Map(),fixtureUrl=pathToFileURL(path.join(__dirname,'fixtures/requirements-integration.html')).href;
ipcMain.handle('requirements-fixture-library',async(event,action,payload={})=>{
 const identity=identities.get(event.sender.id),owner=owners[identity];
 const guard=()=>{
  assert.ok(owner&&identities.get(event.sender.id)===identity&&!event.sender.isDestroyed());
  assert.equal(event.senderFrame,event.sender.mainFrame);
  assert.equal(event.sender.getURL().split('?')[0],fixtureUrl);
 if(action!=='context')assert.equal(payload.owner,owner);
 };
 guard();if(action==='context')return{owner,workRoot:payload.workRoot||libraryWorkRoot};
 assert.ok(['upload','list','readContent','readBinary','associateSource','outputStatus'].includes(action));
 const store=libraryStore.create(app,owner,guard,payload.workRoot||libraryWorkRoot);
 return store.run(index=>libraryActions.execute(store,index,action,payload));
});
async function open(identity){
 const win=new BrowserWindow({width:1366,height:1000,show:false,webPreferences:{preload:path.join(__dirname,'fixtures/requirements-library-preload.cjs'),offscreen:true,contextIsolation:true,sandbox:true,partition:'requirements-'+identity+'-'+windows.length}});windows.push(win);identities.set(win.webContents.id,identity);
 const network={failUploadOnce:false,uploadAttempts:0,libraryWrites:0};
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,cb)=>{
  if(!['GET','OPTIONS'].includes(details.method)&&details.url.includes('/api/v1/library/'))network.libraryWrites++;
  const attachment=details.method==='POST'&&/\/tasks\/[^/]+\/attachments$/.test(details.url);
  if(attachment)network.uploadAttempts++;
  if(attachment&&network.failUploadOnce){network.failUploadOnce=false;cb({cancel:true});return;}
  cb({cancel:!details.url.startsWith(hub+'/')});
 });
 const js=async source=>{
  const result=await win.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await (0,eval)(${JSON.stringify(source)})};}catch(error){return {ok:false,error:String(error.stack||error)};}})()`,true);
  if(!result.ok)throw Error(result.error+'; expression: '+source.slice(0,180));
  return result.value;
 };
 const until=async source=>{for(let i=0;i<120;i++){if(await js(source))return;await wait(100);}throw Error('Timed out: '+source+'; notices: '+JSON.stringify(await js('fixtureNotices')));};
 const click=async selector=>{
  let p;
  for(let attempt=0;attempt<30;attempt++){
   p=await js(`(async()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getClientRects().length&&!n.disabled);if(!n)return null;n.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});const a=n.getBoundingClientRect();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);return n.isConnected&&Math.abs(a.x-b.x)<1&&Math.abs(a.y-b.y)<1&&n.contains(document.elementFromPoint(x,y))?{x,y}:null})()`);
   if(p)break;await wait(50);
  }
  if(!p)throw Error('No stable visible pointer target: '+selector);
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await wait(120);
 };
 const fill=async(selector,text)=>{await click(selector);for(const [key,mods] of [['Home',['control']],['End',['control','shift']]]){win.webContents.sendInputEvent({type:'keyDown',keyCode:key,modifiers:mods});win.webContents.sendInputEvent({type:'keyUp',keyCode:key,modifiers:mods});}await win.webContents.insertText(text);};
 await win.loadFile(path.join(__dirname,'fixtures/requirements-integration.html'),{query:{hub,identity,workRoot:libraryWorkRoot}});
 assert.equal(await js('fixtureReady'),'ready');
 const file=async(selector,files)=>{
  if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');
  const {root}=await win.webContents.debugger.sendCommand('DOM.getDocument');
  const {nodeId}=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector});
  await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files});
 };
 return{win,js,until,click,fill,file,network};
}
app.whenReady().then(async()=>{
 try{
  let ready=false;
  for(let i=0;i<100;i++){try{const state=await call('/ready');ready=state.ok&&state.isolated;}catch(_){}if(ready)break;await wait(100);}
  assert.equal(ready,true,'isolated Hub must be ready before opening renderer');
  const sender=await open('sender');
  // The conversation action retains explicit create-and-assign; the board's collect-only path is covered by requirements-workspace.
  await sender.js('PluginUIHost.invoke("work.requirement.create",{source:"对话"})');await sender.until('!!document.querySelector("#cpTitle")');
  await sender.fill('#cpTitle','统一需求完整交付验证');await sender.fill('#cpNote','保留背景材料，交付可打开的 Markdown 文档。');
  if(!await sender.js('!!document.querySelector(".cp-ck-t")'))await sender.click('#cpCkAdd');
  await sender.fill('.cp-ck-t','交付 Markdown 文档并完成验收');
  assert.equal(await sender.js('document.querySelector("#cpVisibility").value'),'related');
  // This scenario explicitly verifies organization-visible delivery; new tasks stay private by default.
  await sender.click('#cpVisibility');
  for(const keyCode of ['End','Return'])for(const type of ['keyDown','keyUp'])
    sender.win.webContents.sendInputEvent({type,keyCode});
  await sender.until('document.querySelector("#cpVisibility").value==="organization"');
  const input=path.join(output,'requirement-input.txt');fs.writeFileSync(input,'原始需求材料，不可丢失。');
  sender.win.webContents.debugger.attach('1.3');
  const {root}=await sender.win.webContents.debugger.sendCommand('DOM.getDocument');
  const {nodeId}=await sender.win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector:'#wesAttachInput'});
  await sender.win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files:[input]});
  await sender.until('!!document.querySelector(".catt-item")');
  await sender.click('[data-selbtn="who"]');await sender.click('[data-selv="who|mate:recipient"]');
  await sender.click('#cpCreate');await sender.until('!!document.querySelector(".cp-ok")');
  const stored=await call('/e2e/stored');assert.equal(stored.length,1);const id=stored[0].id;
  assert.equal(stored[0].ownerClientId,'e2e-recipient');assert.deepEqual(stored[0].criteria,['交付 Markdown 文档并完成验收']);
  report.taskId=id;report.checks.push('real mouse/keyboard creation, file picker and atomic coworker assignment retain one Task');
  fs.writeFileSync(path.join(output,'created.png'),(await sender.win.webContents.capturePage()).toPNG());
  await sender.click('[data-cp-receipt-close]');
  const recipient=await open('recipient');
  assert.equal((await recipient.js('SoduWorkAPI.getTasks()')).length,1);
  const attachments=await recipient.js(`SoduWorkAPI.listAttachments(${JSON.stringify(id)})`);assert.equal(attachments.length,1);
  await recipient.click(`[data-rq-open="${id}"]`);await recipient.until('!!document.querySelector(".rq-detail-overview")');
  await recipient.until('!!document.querySelector("[data-rq-file]")');
  if(await recipient.js('!!document.querySelector("[data-rq-material-group=input]:not([open])")'))
    await recipient.click('[data-rq-material-group="input"]>summary');
  await recipient.click('[data-rq-file]');await recipient.until('fixturePreviews.length===1');assert.equal(await recipient.js('fixturePreviews.length'),1);
  const dispatch=await recipient.js(`SoduWorkAPI.dispatchToAI(${JSON.stringify(id)},{id:'local:pi',type:'agent'},'按完成标准交付',null,'',{strategy:'direct'})`);
  assert.equal(dispatch.ok,true);assert.equal((await recipient.js(`SoduWorkAPI.getTask(${JSON.stringify(id)})`)).status,'doing');
  const observations=await call('/e2e/observations');assert.equal(observations.dispatches.length,1);
  assert.deepEqual(observations.dispatches[0].files,['requirement-input.txt']);assert.equal(observations.dispatches[0].criteria.length,1);
  report.checks.push('production dispatch API sends original materials and completion criteria to provider, same Task enters delivering');
  await recipient.js(`RequirementsDetail.open(${JSON.stringify(id)})`);
  assert.equal(await recipient.js('!!document.querySelector("[data-rq-edit],#rqEditForm")'),false);
  const rejectedDefinition=await recipient.js(`SoduWorkAPI.patchTask(${JSON.stringify(id)},{acceptanceCriteria:['Changed after execution']}).then(()=>({status:200}),error=>({status:error.status}))`);
  assert.equal(rejectedDefinition.status,409,'active execution cannot change the completion definition');
  assert.deepEqual((await recipient.js(`SoduWorkAPI.getTask(${JSON.stringify(id)})`)).acceptanceCriteria,['交付 Markdown 文档并完成验收']);
  await recipient.js(`SoduWorkAPI.addTaskComment(${JSON.stringify(id)},'@发送验收 请确认交付标准',[{type:'user',id:'sender',name:'发送验收'}])`);
  const notices=await call('/e2e/observations');assert.ok(notices.events.some(row=>row.client==='e2e-sender'&&row.event.type==='notice'&&JSON.stringify(row.event).includes('确认交付标准')));
  report.checks.push('active execution removes definition editing and the HTTP API rejects changed criteria; real comment emits targeted mention notification');
  await call('/e2e/finish/'+encodeURIComponent(id),'POST');
  report.reviewResult=await sender.js(`SoduWorkAPI.reviewTask(${JSON.stringify(id)},'完成标准与文件内容已核对')`);
  assert.equal((await sender.js(`SoduWorkAPI.getTask(${JSON.stringify(id)})`)).status,'done');
  await sender.js('RequirementsBoard.refresh()');
  await sender.click('[data-rq-scope="all"]');
  assert.equal(await sender.js('document.querySelector("#rqLane-delivered").hidden'),false);
  await sender.click(`[data-rq-open="${id}"]`);await sender.until('document.querySelectorAll("[data-rq-file]").length===2');
  await sender.click('[data-rq-material-group="output"]>summary');
  await sender.click(`[data-rq-file="output-${id}"]`);await sender.until('fixturePreviews.at(-1)?.name==="delivery.md"');assert.equal(await sender.js('fixturePreviews.at(-1).name'),'delivery.md');
  await sender.click(`[data-rq-library="${id}:output-${id}"]`);
  await sender.until('!!document.querySelector(".library-save-action.is-saved")');
  const library=await sender.js('SoduWorkAPI.listLibrary({})');
  const localDelivery=library.items.find(row=>row.filename==='delivery.md');
  assert.match(localDelivery.id,/^local-/);
  const content=await sender.js(`SoduWorkAPI.readLibraryContent(${JSON.stringify(localDelivery.id)})`);
  assert.equal(content.content,Buffer.from(await sender.js('fixturePreviews.at(-1).data'),'base64').toString('utf8'));
 const indexFile=path.join(libraryWorkRoot,'SoduWorkLibrary/accounts',owners.sender,'index.json');
 assert.equal(fs.existsSync(path.join(output,'profile','library')),false,'Local library must stay under the configured work directory');
  assert.ok(JSON.parse(fs.readFileSync(indexFile,'utf8')).items.some(row=>row.id===localDelivery.id));
  assert.equal(sender.network.libraryWrites,0,'ordinary save stays on this PC and does not upload to the Hub library');
  assert.equal((await recipient.js('SoduWorkAPI.listLibrary({})')).items.some(row=>row.filename==='delivery.md'),false);
  report.checks.push('provider completion passes review; output saves to real account-scoped local files and reads back identical bytes, without uploading to Hub or appearing for another account');
  fs.writeFileSync(path.join(output,'delivered.png'),(await sender.win.webContents.capturePage()).toPNG());
  const other=await open('other');const publicTask=await other.js(`SoduWorkAPI.getTask(${JSON.stringify(id)})`);
  assert.equal(publicTask.canViewExecution,false);assert.equal(publicTask.result,undefined);
  assert.equal((await other.js(`SoduWorkAPI.listAttachments(${JSON.stringify(id)})`)).length,1);
  assert.equal(await other.js('!!document.querySelector(".rq-card")'),false,'shared work does not appear in personal default');
  await other.click('[data-rq-scope="all"]');
  await other.click(`[data-rq-open="${id}"]`);await other.until('!!document.querySelector(".rq-detail-actions")');
  assert.equal(await other.js('!!document.querySelector("[data-rq-chat],[data-rq-journey]")'),false);
  report.checks.push('unrelated shared viewer can read input requirement but cannot enter execution or see private output');
  const reopened=await open('sender');assert.equal((await reopened.js(`SoduWorkAPI.getTask(${JSON.stringify(id)})`)).status,'done');
  await reopened.click('[data-rq-scope="all"]');
  assert.equal(await reopened.js(`document.querySelector('[data-rq-open="${id}"]').closest('.rq-lane').dataset.rqLane`),'delivered');
  report.checks.push('fresh window reopens the same delivered requirement and reads persisted state');
  await reopened.click(`[data-rq-open="${id}"]`);await reopened.until('!!document.querySelector("[data-rq-archive]")');
  await reopened.click('.rq-detail-more summary');
  await reopened.click('.rq-detail [data-rq-archive]');await reopened.until('document.querySelector(".rq-detail [data-rq-archive]")?.textContent==="恢复需求"');
  assert.equal((await reopened.js(`SoduWorkAPI.getTask(${JSON.stringify(id)})`)).status,'done');
  await reopened.click('.rq-detail-more summary');await reopened.click('.rq-detail [data-rq-archive]');await reopened.until('document.querySelector(".rq-detail [data-rq-archive]")?.textContent==="归档需求"');
  assert.equal((await reopened.js(`SoduWorkAPI.getTask(${JSON.stringify(id)})`)).archivedAt,null);
  report.checks.push('archive and restore preserve accepted delivery and use the same Task');
  await reopened.click('[data-rq-dismiss]');await reopened.js('PluginUIHost.invoke("work.requirement.create",{source:"对话"})');
  await reopened.until('!!document.querySelector("#cpTitle")');await reopened.fill('#cpTitle','AI 派活上传失败重试');
  // Creation selects ownership and saves materials; dispatch requires a later explicit action.
  await reopened.file('#wesAttachInput',[input]);await reopened.until('!!document.querySelector(".catt-item")');
  reopened.network.failUploadOnce=true;await reopened.click('#cpCreate');
  await reopened.until('document.querySelector("#cpCreate")?.textContent==="重试上传并继续"');
  assert.equal(await reopened.js('document.querySelector(".wes-attach-zone").inert'),true);
  const beforeRetry=await call('/e2e/stored');assert.equal(beforeRetry.length,2);
  const directId=beforeRetry.find(row=>row.id!==id).id;
  assert.equal((await call('/e2e/observations')).dispatches.length,1);
  await reopened.click('#cpCreate');await reopened.until('!!document.querySelector(".cp-ok")');
  const afterRetry=await call('/e2e/stored');assert.equal(afterRetry.length,2);assert.equal(afterRetry.find(row=>row.id===directId).status,'todo');
  assert.equal((await call('/e2e/observations')).dispatches.filter(row=>row.id===directId).length,0);
  await reopened.js(`SoduWorkAPI.dispatchToAI(${JSON.stringify(directId)},{id:'local:pi',type:'agent'},'Execute after materials are saved',null,'',{strategy:'direct'})`);
  assert.equal((await reopened.js(`SoduWorkAPI.getTask(${JSON.stringify(directId)})`)).status,'doing');
  const directCalls=(await call('/e2e/observations')).dispatches.filter(row=>row.id===directId);
  assert.equal(directCalls.length,1);assert.deepEqual(directCalls[0].files,['requirement-input.txt']);
  assert.equal(reopened.network.uploadAttempts,2);
  report.checks.push('real upload failure retries on the same Task without implicit execution; explicit dispatch after materials are saved runs once');
  await reopened.click('[data-cp-receipt-close]');await reopened.js('RequirementsBoard.refresh()');
  await reopened.click(`[data-rq-open="${directId}"]`);await reopened.until('!!document.querySelector("#rqFileInput")');
  const supplement=path.join(output,'supplement.txt');fs.writeFileSync(supplement,'执行中追加的资料。');
  reopened.network.failUploadOnce=true;await reopened.file('#rqFileInput',[supplement]);
  await reopened.until('!!document.querySelector("[data-rq-retry-files]")&&!document.querySelector("[data-rq-retry-files]").hidden');
  assert.equal(await reopened.js('!!document.querySelector("#rqEditForm")'),false,
    'upload failure must not replace the detail with an editing form');
  assert.equal(await reopened.js('document.querySelector("[data-rq-retry-files]").hidden'),false);
  await reopened.click('[data-rq-retry-files]');await reopened.until('document.querySelectorAll("[data-rq-file]").length===2');
  assert.equal((await reopened.js(`SoduWorkAPI.listAttachments(${JSON.stringify(directId)})`)).length,2);
  assert.equal((await call('/e2e/observations')).dispatches.filter(row=>row.id===directId).length,1);
  report.checks.push('detail material upload can retry independently without duplicating Task or dispatch');
  await call('/e2e/finish/'+encodeURIComponent(directId),'POST');
  await reopened.js(`SoduWorkAPI.reviewTask(${JSON.stringify(directId)},'Fixture delivery verified')`);
  await reopened.js(`RequirementsDetail.open(${JSON.stringify(directId)})`);
  assert.equal(await reopened.js('!!document.querySelector("[data-rq-edit],#rqEditForm")'),false);
  const editId=directId+'-draft';
  await reopened.js(`SoduWorkAPI.putTask(${JSON.stringify(editId)},{title:'Editable draft',note:'Original draft',status:'todo',triageStage:'ready',kind:'requirement'})`);
  await reopened.js(`RequirementsDetail.open(${JSON.stringify(editId)})`);
  const staleVersion=(await reopened.js(`SoduWorkAPI.getTask(${JSON.stringify(editId)})`)).requirementVersion;
  await reopened.click('[data-rq-edit]');
  await reopened.fill('#rqEditForm [name="note"]','尚未提交的本地编辑');
  await reopened.js(`SoduWorkAPI.patchTask(${JSON.stringify(editId)},{title:'另一窗口已更新',requirementVersion:${staleVersion}})`);
  await reopened.click('.rq-detail-footer [type="submit"]');await reopened.until('document.querySelector("[data-rq-error]")?.textContent.includes("已被同事更新")');
  assert.equal(await reopened.js('document.querySelector("#rqEditForm [name=note]").value'),'尚未提交的本地编辑');
  assert.equal((await reopened.js(`SoduWorkAPI.getTask(${JSON.stringify(editId)})`)).title,'另一窗口已更新');
  assert.notEqual((await reopened.js(`SoduWorkAPI.getTask(${JSON.stringify(editId)})`)).note,'尚未提交的本地编辑');
  report.checks.push('concurrent edit is rejected without overwriting server state or losing local form input');
  for(const page of [sender,recipient,other,reopened])assert.deepEqual(await page.js('fixtureErrors'),[]);
  report.ok=true;
 }catch(error){report.error=String(error.stack||error);for(let i=0;i<windows.length;i++)fs.writeFileSync(path.join(output,'failure-'+i+'.png'),(await windows[i].webContents.capturePage()).toPNG());}
 finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(report.ok?0:1);}
});
