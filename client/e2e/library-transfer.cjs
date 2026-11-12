'use strict';
const electron=require('electron');
if(typeof electron==='string'){
 const env={...process.env};for(const k of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE','CHROME_DEVEL_SANDBOX'])delete env[k];
 require('node:child_process').spawn(electron,[__filename,...process.argv.slice(2)],{env,windowsHide:true,stdio:'inherit'}).on('exit',code=>process.exitCode=code??1);
}else{
const {app,BrowserWindow,ipcMain}=electron,fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),client=path.resolve(__dirname,'..'),backend=path.resolve(client,'../hub-backend');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-library-e2e-')),out=path.resolve(client,'../outputs/library-transfer');
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(temporary,'profile'));
const read=p=>fs.readFileSync(path.join(client,p),'utf8'),tick=ms=>new Promise(r=>setTimeout(r,ms||100));
let win,server,logs='',url,outputReadGate=null,outputReads=0;const report={ok:false,cases:[],errors:[]};
const js=c=>win.webContents.executeJavaScript(c,true);
async function until(c){for(let i=0;i<160;i++){if(await js(c))return;await tick(40);}throw Error('Timed out: '+c);}
async function click(selector){const p=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing action');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...p});await tick();}
async function shot(name){await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await tick(180);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
async function startServer(){
 const probe=require('node:net').createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 server=spawn(process.argv[2]||path.join(backend,'.venv/Scripts/python.exe'),['-m','uvicorn','tests.library_browser_server:app','--host','127.0.0.1','--port',String(port)],{cwd:backend,windowsHide:true,env:{...process.env,SODUWORK_LIBRARY_E2E_ROOT:temporary},stdio:['ignore','pipe','pipe']});
 server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);url='http://127.0.0.1:'+port;
 for(let i=0;i<200;i++){try{if((await fetch(url+'/ready')).ok)return;}catch{}if(server.exitCode!==null)break;await tick();}throw Error('Library fixture unavailable: '+logs);
}
function css(p,seen=new Set()){const full=path.resolve(client,p);if(seen.has(full))return '';seen.add(full);return read(p).replace(/@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?;/g,(_,n)=>css(path.relative(client,path.resolve(path.dirname(full),n)),seen));}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH0UAAAAASUVORK5CYII=','base64');
const sourceFiles=[{artifactId:'html',name:'报告.html',data:Buffer.from('<!doctype html><meta charset="utf-8"><h1>完整报告</h1>'),kind:'website'},
 {artifactId:'png',name:'结果.png',data:png,kind:'image'}, {artifactId:'md',name:'说明.md',data:Buffer.from('# 保存\n\n完整的 Markdown 内容\n'),kind:'document'}];
const work=path.join(temporary,'session');fs.mkdirSync(work);sourceFiles.forEach(f=>{f.path=path.join(work,f.name);f.relative=f.name;f.at=1;f.size=f.data.length;fs.writeFileSync(f.path,f.data);});
const session={cwd:work,outputSnapshot:()=>({files:sourceFiles,delivery:{items:sourceFiles}})};
app.whenReady().then(async()=>{
 await startServer();const preload=path.join(temporary,'preload.cjs');
 fs.writeFileSync(preload,`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('soduWorkAPI',{localLibrary:{context:()=>ipcRenderer.invoke('fixture-local-library','context'),call:(action,payload)=>ipcRenderer.invoke('fixture-local-library',action,payload)},conversationSession:{readOutputBinary:(ref,target)=>ipcRenderer.invoke('fixture-library-output',ref,target),artifactAction:(ref,id,action)=>ipcRenderer.invoke('fixture-artifact-preview',ref,id,action)},workPreview:{onState:()=>()=>{},show:async p=>({ok:true,state:{tabId:p.tabId,url:p.url||'https://example.test/report',canBack:false,canForward:false}}),hide:()=>{},destroy:()=>{}}});`);
 // Fixture identity only; file/index writes use production local-library code.
 const owner='a'.repeat(32);
 ipcMain.handle('fixture-local-library',async(event,action,payload={})=>{
  assert.equal(event.sender,win.webContents);assert.equal(event.senderFrame,event.sender.mainFrame);
  if(action==='context')return{owner};assert.equal(payload.owner,owner);
  assert.ok(['upload','list','readBinary','status','outputStatus'].includes(action));
  const guard=()=>{assert.equal(event.sender,win.webContents);assert.ok(!event.sender.isDestroyed());};
  const store=require('../main/library-local-store.cjs').create(app,owner,guard);
  return store.run(index=>require('../main/library-local-actions.cjs').execute(store,index,action,payload));
 });
 ipcMain.handle('fixture-library-output',async(_e,ref,target)=>{assert.equal(ref,'conversation-one');outputReads++;if(outputReadGate)await outputReadGate;return require('../main/library-output.cjs').read(session,target);});
 ipcMain.handle('fixture-artifact-preview',(_e,_ref,id,action)=>{const f=sourceFiles.find(f=>f.artifactId===id);return action==='read'?{ok:true,text:f.data.toString('utf8')}:{ok:true,mimeType:'image/png',data:png.toString('base64')};});
 win=new BrowserWindow({show:false,width:1280,height:850,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',(_e,level,message)=>{if(level>=3&&!message.includes('404'))report.errors.push(message);});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(r,cb)=>cb({cancel:!r.url.startsWith(url+'/')}));
 const styles=['theme/variables.css','components/panels/panels-base.css','components/panels/panels-chat.css','components/panels/conversation-attachments.css','components/panels/panels-library.css','components/workspace/workspace-shell.css','components/workspace/workspace-page-layout.css','theme/workspace-experience.css','theme/workspace-page-heads.css','components/panels/library-transfer.css'].map(p=>'<style>'+css(p)+'</style>').join('');
 const fixture=path.join(temporary,'fixture.html');fs.writeFileSync(fixture,'<!doctype html><meta charset="utf-8">'+styles+'<style>:root{--ws-main-left:10px;--ws-main-bg:var(--bg-0)}body{margin:0;font:14px var(--font-ui);background:var(--bg-0)}#chat{position:relative;height:650px}.nchat-stage{height:100%;display:flex}.nchat-main{flex:1;min-width:0;padding:24px}#attachment-area{padding:16px;border-bottom:1px solid var(--line)}#chat .nmsg{margin:0}</style><section id="attachment-area"><textarea id="input"></textarea><input id="picker" type="file" hidden multiple><div id="tray" class="catt-tray"></div></section><main id="chat" class="nchat"><div class="nchat-stage"><section class="nchat-main"><div id="messages"></div></section></div></main>');
 await win.loadFile(fixture);
 await js(`localStorage.setItem('soduwork_work_hub_environment_v1','development');localStorage.setItem('soduwork_work_development_hub_url_v1',${JSON.stringify(url)});localStorage.setItem('soduwork_work_user_id','e2e-library-transfer');localStorage.setItem('soduwork_work_root',${JSON.stringify(libraryWorkRoot)});window.notices=[];window.petSay=s=>notices.push(s);window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));void 0;`);
 await js('window.__SODUWORK_TEST_HUB_CONFIG__ = { allowSwitch: true };');
 for(const f of JSON.parse(read('core/locales/manifest.json')))await js(read('core/locales/'+f));
 for(const f of ['core/i18n-dom.js','core/i18n.js','core/api-work-plugins.js', 'api-library-local.js', 'api.js','components/panels/library-transfer.js','components/panels/conversation-attachments.js','vendor/markdown/marked.umd.js','vendor/markdown/purify.min.js','components/panels/chat-output-links.js','components/panels/chat-dom-patch.js', 'components/panels/panels-chat-tools.js','components/panels/chat-workspace-info.js','components/panels/chat-workspace-split.js', 'components/panels/chat-workspace-controls.js', 'components/panels/panels-chat-workspace.js','components/panels/library-file-icons.js','components/panels/panels-library-dialogs.js','components/panels/panels-library.js'])await js(read(f)+'\nvoid 0;');
 await js(`window.files=${JSON.stringify(sourceFiles.map(({data,path,...f})=>f))};window.currentRef='conversation-one';ChatWorkbench.bind(document.querySelector('#chat'),()=>({ref:currentRef}));ChatWorkbench.render(document.querySelector('#chat'),{messages:[]},files);
 window.controller=ConversationAttachments.create({host:document.querySelector('#attachment-area'),input:document.querySelector('#input'),fileInput:document.querySelector('#picker'),tray:document.querySelector('#tray')});
 window.renderMessages=()=>{document.querySelector('#messages').innerHTML=ChatOutputLinks.decorate('<div class="nmsg ai"><div class="ntext nmd"><a href="报告.html">报告.html</a>、<a href="结果.png">结果.png</a>、<a href="说明.md">说明.md</a></div></div>',files,currentRef);};renderMessages();
 // Regression: a final answer may mention only a subset of generated files.
 // The trusted current-turn index must still surface every typed deliverable.
 const generatedExtras=Array.from({length:7},(_,i)=>({artifactId:'generated-'+i,name:'generated-'+i+'.md',relative:'generated-'+i+'.md',kind:'document',changedInTurn:true,primary:true}));
 files.push(...generatedExtras,{artifactId:'support-only',name:'support.md',kind:'document',changedInTurn:true,primary:false}); renderMessages();
 if(document.querySelectorAll('.noutput-library-row').length!==10) throw Error('Expected all 10 primary deliverables');
 if(document.querySelector('[data-library-output="support-only"]')) throw Error('Supporting files must stay out of the primary delivery card');
 document.querySelector('#messages').addEventListener('click',e=>{const button=e.target.closest('[data-library-output]');if(button)LibraryTransfer.saveDecorated(button);});void 0;`);
 // Native File input events exercise the same controller used by new and existing chats.
 await js(`window.inputFile=new File(['上传的原始内容'],'用户上传.txt',{type:'text/plain'});const dt=new DataTransfer();dt.items.add(inputFile);document.querySelector('#picker').files=dt.files;document.querySelector('#picker').dispatchEvent(new Event('change'));void 0;`);
 await until(`controller.files().length===1`);
 assert.equal(await js('controller.files().length'),1);assert.equal(await js('controller.refs({}).then(refs=>new TextDecoder().decode(refs[0].data))'),'上传的原始内容');
 assert.equal(await js('document.querySelectorAll(".catt-library-state").length'),0);assert.equal(await js('SoduWorkAPI.listLibrary({scope:"all"}).then(r=>r.items.length)'),0);
 await js(`controller.add([inputFile],'retry');controller.add([new File(['existing'],'库内文件.txt')],'library');`);await tick();
 assert.equal(await js(`SoduWorkAPI.listLibrary({scope:'all'}).then(r=>r.items.length)`),0);
 report.cases.push('Selecting a File keeps exact bytes in the conversation attachment; explicit library saves are separate');
 let releaseOutputRead;outputReadGate=new Promise(resolve=>releaseOutputRead=resolve);
 await click('[data-library-output="html"]');await until(`document.querySelector('[data-library-output="html"]').disabled`);
 assert.equal(outputReads,1);
 await js(`window.previousSaveButton=document.querySelector('[data-library-output="html"]');renderMessages();ChatWorkbench.openOutput('html');void 0;`);
 await until(`document.querySelector('[data-wb-library-upload="html"]')?.disabled`);
 assert.equal(await js(`previousSaveButton.isConnected`),false);
 assert.equal(await js(`document.querySelector('[data-library-output="html"]').disabled`),true);
 assert.equal(await js(`document.querySelector('[data-library-output="html"]').getAttribute('aria-busy')`),'true');
 releaseOutputRead();outputReadGate=null;
 await until(`['[data-library-output="html"]','[data-wb-library-upload="html"]'].every(selector=>{const button=document.querySelector(selector);return button?.classList.contains('is-saved')&&!button.disabled&&button.getAttribute('aria-busy')==='false';})`);
 assert.equal(outputReads,1);report.cases.push('A pending save survives chat rerender and preview reopening; replacement buttons both finish saved, enabled, and not busy with one original-byte read');
 for(const id of ['png','md']){await js(`ChatWorkbench.openOutput('${id}')`);await until(`!!document.querySelector('[data-wb-library-upload="${id}"]')`);await click(`[data-wb-library-upload="${id}"]`);await until(`document.querySelector('[data-wb-library-upload="${id}"]').classList.contains('is-saved')`);}
 const saved=await js(`SoduWorkAPI.listLibrary({scope:'all'}).then(r=>r.items)`);assert.equal(saved.length,3);
 for(const f of sourceFiles){const item=saved.find(i=>i.filename===f.name);assert.ok(item);const result=await js(`SoduWorkAPI.readLibraryBinary(${JSON.stringify(item.id)}).then(async r=>Array.from(new Uint8Array(await r.blob.arrayBuffer())))`);assert.deepEqual(Buffer.from(result),f.data);}
 report.cases.push('Chat HTML and preview PNG/Markdown reach the real isolated local library store; downloading reproduces every original byte; public artifacts need no absolute path');
 await js(`ChatWorkbench.openOutput('html')`);await until(`!!document.querySelector('[data-wb-library-upload="html"]')`);await click('[data-wb-library-upload="html"]');
 assert.equal(await js(`SoduWorkAPI.listLibrary({scope:'all'}).then(r=>r.items.length)`),4);report.cases.push('Chat and preview save share completion state and prevent duplicate copies');
 const readsBeforeRestore=outputReads;
 await js(read('components/panels/library-transfer.js')+'\nvoid 0;');
 await js(`document.querySelectorAll('.noutput-library').forEach(n=>n.remove());renderMessages();void 0;`);
 await until(`document.querySelector('[data-library-output="html"]')?.classList.contains('is-saved')`);
 await click('[data-library-output="html"]');
 await until(`document.activeElement?.classList.contains('library-file-card')`);
 assert.equal(await js(`document.activeElement.querySelector('.library-card-copy b').textContent`),'报告.html');
 assert.equal(await js(`document.querySelector('.library-preview-pane:modal')`),null);
 await js('closeLibraryPanel();void 0;');
 assert.equal(outputReads,readsBeforeRestore);
 assert.equal(await js(`SoduWorkAPI.listLibrary({scope:'all'}).then(r=>r.items.length)`),4);
 report.cases.push('A fresh transfer controller restores persisted save receipts without rereading or uploading the saved output');
 for(const locale of ['en-US','zh-CN']){await js(`SoduWorkI18n.setLocale('${locale}',{persist:false,broadcast:false})`);await tick();for(const width of [1280,800]){win.setContentSize(width,850);await tick();assert.equal(await js(`document.querySelector('.ncw-browserbar').scrollWidth<=document.querySelector('.ncw-browserbar').clientWidth+1`),true);await shot('chat-'+width+'-'+locale);}}
 report.cases.push('Visible save actions and attachment states switch between Chinese and English; preview toolbars fit wide and narrow panes');
 await js(`controller.add([new File(['must survive'],'重试.md',{type:'text/markdown'})],'picker');`);
 await until(`controller.files().some(f=>f.name==='重试.md')`);assert.equal(await js(`document.querySelectorAll('[data-catt-library-retry]').length`),0);
 assert.equal(await js(`document.querySelectorAll('.catt-library-state').length`),0);assert.equal(await js(`SoduWorkAPI.listLibrary({scope:'all'}).then(r=>r.items.length)`),3);report.cases.push('Conversation attachments remain visible without an automatic upload failure or retry state');
 win.setContentSize(1280,850);
 // Model the workspace host's surface switch using the actual panel/shell
 // styles, including the hosted state that intentionally replaces .show.
 await js(`document.querySelector('#chat').style.display='none';document.querySelector('#attachment-area').style.display='none';document.documentElement.dataset.deskPanel='workspace';document.documentElement.dataset.workspaceView='library';document.documentElement.style.setProperty('--ws-main-left','10px');openLibraryPanel();const panel=document.querySelector('#libraryPanel');panel.classList.remove('show');panel.classList.add('workspace-hosted');panel.scrollTop=0;window.scrollTo(0,0);const search=panel.querySelector('[data-library-search]');search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));void 0;`);
 await until(`document.querySelectorAll('.library-file-card').length===3`);
 const libraryVisible=await js(`(()=>{const panel=document.querySelector('#libraryPanel'),title=panel.querySelector('[data-library-title]'),card=panel.querySelector('.library-file-card'),r=card.getBoundingClientRect(),s=getComputedStyle(panel);return{visible:panel.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),opacity:s.opacity,pointerEvents:s.pointerEvents,title:title.textContent,view:document.documentElement.dataset.workspaceView,hosted:panel.classList.contains('workspace-hosted'),hit:panel.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),width:panel.getBoundingClientRect().width,overflow:panel.scrollWidth>panel.clientWidth+1,filenames:[...panel.querySelectorAll('.library-card-copy b')].map(e=>e.textContent)}})()`);
 report.libraryVisible=libraryVisible;assert.equal(libraryVisible.visible,true);assert.equal(libraryVisible.opacity,'1');assert.equal(libraryVisible.pointerEvents,'auto');assert.equal(libraryVisible.title,'资料库');assert.equal(libraryVisible.view,'library');assert.equal(libraryVisible.hosted,true);assert.equal(libraryVisible.hit,true);assert(libraryVisible.width>1100);assert.equal(libraryVisible.overflow,false);
 assert.deepEqual([...libraryVisible.filenames].sort(),['报告.html','结果.png','说明.md'].sort());report.libraryVisible=libraryVisible;
 await shot('library-saved-files');
 assert.deepEqual(await js('errors'),[]);assert.deepEqual(report.errors,[]);report.cases.push('Saved files are discoverable in the production library panel; no renderer exceptions');report.ok=true;
}).catch(async error=>{report.error=String(error.stack);if(win){report.rendererErrors=await js('window.errors||[]').catch(()=>[]);await shot('failure').catch(()=>{});}}).finally(()=>{fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(out,'server.log'),logs);console.log(JSON.stringify(report));if(win)win.destroy();if(server)server.kill();app.exit(report.ok?0:1);});
}
