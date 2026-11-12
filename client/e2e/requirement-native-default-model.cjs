'use strict';
// Real Chromium assignment mount, WorkCards restore, WorkIntent, task/session
// controllers and the verbatim NativeChat sessionInfo function. Only the Hub,
// conversation IPC and unrelated owner/view effects are fixtures; no model runs.
// Native execution remains a controller regression reached by a labelled test
// button: the assignment UI now offers Runner Agents only.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 90000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-native-default-'));
  const out = path.resolve(process.argv[2] || path.join(client, '../outputs/requirement-native-default-model-20261022'));
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', path.join(temporary, 'profile'));
  app.disableHardwareAcceleration();
  const report = { ok: false, cases: [], errors: [], networkRequests: [], realModel: false, businessDatabase: false,
    boundary: 'Real WorkCards.restore, WorkIntent, TaskController/TaskStart, SessionController, verbatim NativeChat.sessionInfo and assignment mount. A labelled fixture button invokes the native controller; it is not an assignment candidate. Hub/conversation IPC, reset/view/draft effects are fixtures; no native archive or SDK execution.',
    timing: 'No business-readiness sleeps. Restore immediately opens assignment. Rendering waits use animation frames; completion waits observe actual callbacks/DOM.' };
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const frames = () => js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
  async function click(selector) {
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});void 0;`);
    await frames();
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
      const p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
      if(!e.contains(document.elementFromPoint(p.x,p.y)))throw Error('Control obscured: '+${JSON.stringify(selector)});return p;})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});
  }
  async function screenshot(name) {
    await frames(); const file = path.join(out, name + '.png');
    // Capture the Chromium surface directly; a hidden native window can retain
    // its first OS compositor frame after the renderer layout has updated.
    const shot = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {format:'png',captureBeyondViewport:true});
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64')); return file;
  }
  async function waitDOM(expression) {
    return js(`new Promise((resolve,reject)=>{let timer;
      const observer=new MutationObserver(check);function check(){if(${expression}){observer.disconnect();clearTimeout(timer);resolve(true);}}
      observer.observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true});
      timer=setTimeout(()=>{observer.disconnect();reject(Error('DOM wait timed out: '+${JSON.stringify(expression)}));},5000);check();})`);
  }
  app.whenReady().then(async () => {
    const desk = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
    const css = [...desk.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(m=>m[1]);
    const html = path.join(temporary, 'fixture.html');
    fs.writeFileSync(html, '<!doctype html><html><head><meta charset="utf-8">' + css.map(file=>
      '<link rel="stylesheet" href="'+pathToFileURL(path.join(client,file)).href+'">').join('') +
      '</head><body><main style="padding:32px"><h1>默认模型 · 本机需求执行验证</h1>' +
      '<p>隔离夹具：不访问真实 Hub，不调用模型。</p><div id="chat"><div class="nchat-draft"></div>' +
      '<div id="nchatList"></div><textarea id="nchatInput"></textarea></div>' +
      '<button id="nativeControllerRegression">运行底层 native 会话回归（测试入口）</button><pre id="receipt"></pre></main></body></html>');
    win = new BrowserWindow({show:false,width:1280,height:960,useContentSize:true,
      webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
    win.webContents.debugger.attach('1.3');
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']}, (request, cb)=>{
      report.networkRequests.push(request.url); cb({cancel:true});
    });
    await win.loadFile(html);
    await js(`window.errors=[];window.calls=[];window.toasts=[];window.tasks=[];
      addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      window.esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      window.clone=v=>JSON.parse(JSON.stringify(v));window.petSay=text=>toasts.push(text);
      window.save=()=>{};window.render=()=>{};window.workRoot=()=>'';window._humanErr=(error,fallback)=>error.detail||fallback;
      window.taskFixture={id:'isolated-default-task',title:'开发美食网站',note:'实现首页并提供验收说明',kind:'task',
        status:'todo',triageStage:'ready',canManageRequirementMaterials:true,tags:[],workRouting:{requiredAgentCapabilities:[]}};
      window.inputMaterials=[];
      window.SoduWorkAPI={getTask:async()=>clone(taskFixture),getTasksSnapshot:async()=>({online:true,items:[clone(taskFixture)]}),
        listAttachments:async()=>clone(inputMaterials),listTeammates:async()=>({mates:[]}),taskStorageKey:()=> 'isolated-default-owner',
        uploadAttachment:async(id,file,metadata)=>{
          await new Promise(resolve=>window.finishUpload=resolve);
          calls.push({kind:'upload',id,name:file.name,purpose:metadata.purpose});
          inputMaterials.push({id:'material-1',name:file.name,role:'input'});return {ok:true};
        },
        taskExecutionOptions:async()=>({selection:{taskId:taskFixture.id,repoId:'',projectId:''},task:clone(taskFixture),
          scenario:{key:'office',name:'综合办公'},repos:[],workflows:[],blockedWorkflows:[],
          substrates:[{key:'local:pi',name:'Pi',cli:'pi',available:true,onlineSeats:1,modelPick:true}],models:[],
          recommendation:{strategy:'direct',workflowRequired:false},availability:{agentReason:'隔离测试不启用后台 Runner'}}),
        dispatchToAI:async()=>{throw Error('Unexpected background dispatch');},startTaskPlugin:async()=>{throw Error('Unexpected plugin dispatch');}};
      window.openTaskConversation=async(...args)=>{calls.push({kind:'navigate',args:clone(args)});return {ok:true};};
      window.RequirementsBoard={refresh:async()=>{}};
      window.completed=new Promise(resolve=>window.resolveCompleted=resolve);
      window.low={history:async()=>({ok:true,chats:[]}),probe:async()=>({ok:true}),
        workCards:async()=>({ok:true,workOnly:true,draftSelection:{adapterId:'pi',modelName:'',modelLabel:'',reasoningEffort:'',thinkingLevel:''},
          draftSelectionRevision:1,cards:[{id:'isolated-card',actionId:'work.requirement.create',prompt:'开发美食网站',closed:true,
            seed:{},files:[],state:{phase:'succeeded',receipt:{id:taskFixture.id,title:taskFixture.title}}}]}),
        open:async options=>{calls.push({kind:'open',options:clone(options)});return {ok:true,ref:'isolated-ref',sessionId:'isolated-new-session',
          adapterId:'pi',model:null,snapshot:{status:'idle',messages:[],tools:[],adapterId:'pi',modelSelection:{name:'',model:null}}};},
        bindTask:async(ref,id,title)=>{calls.push({kind:'bind',ref,id,title});return {ok:true};},
        send:async(ref,text,attachments,options)=>{calls.push({kind:'send',ref,text,attachments:clone(attachments),options:clone(options)});
          return {ok:true,queued:true,queueId:'isolated-queue'};},onEvent:()=>()=>{}};
      window.soduWorkAPI={conversationSession:low};
      window.ctx={_collabTasks:new Map(),_collabStarts:new Set(),_collabPicker:{},_sessionId:'',_ref:'',_viewEpoch:1,_taskOpenSeq:0,
        _sessionOptions:{},_snap:null,_model:null,_wd:null,_collabPollTimer:1,_activeCollabTaskId:'',_draftKey:'new',_draftScopeEpoch:0,
        _pendingAttachmentNames:[],_pendingPlugins:[],_taskAttachments:[],_localQueue:[],_localQueueSeq:0,_submissionSeq:0,
        _pluginResolveSeq:0,_failedConversationDrafts:new Map(),_submissionDrafts:new Map(),_submitTail:Promise.resolve(),OPEN_TIMEOUT_MS:3000,
        esc,_api:()=>low,_mount:()=>document.querySelector('#chat'),_render:()=>{},refreshHistory:()=>{},_paintBar:()=>{},_pullOuts:()=>{},
        _rememberConversationSnapshot:()=>{},_rememberConversationDraft:()=>{},_isEmptyStalledSnapshot:()=>false,_runtimeBusy:()=>false,
        _draftOwnerScope:()=>SoduWorkAPI.taskStorageKey('ops'),_draftKeyForCurrentSession:()=>ctx._sessionId||'new',
        _rememberSubmission:(id,draft)=>ctx._submissionDrafts.set(id,draft),
        _retainFailedConversationDraft:(key,draft,reason)=>ctx._failedConversationDrafts.set(key,{draft,reason}),
        _fail:(title,reason)=>{ctx._taskOpenError=title+': '+reason;errors.push(ctx._taskOpenError);},
        reset(){calls.push({kind:'reset',sessionId:ctx._sessionId});ctx._viewEpoch++;ctx._ref='';ctx._sessionId='';ctx._snap=null;ctx._model=null;
          ctx._sessionOptions={};ctx._collabTasks.clear();ctx._activeCollabTaskId='';ctx._collaborationTaskId='';ctx._collaborationTask=null;}};void 0;`);
    const scripts = ['components/panels/panels-icons.js','core/requirements.js','core/requirement-session-context.js',
      'components/panels/chat-work-cards.js','components/panels/chat-work-intent.js','components/panels/chat-task-start.js',
      'components/panels/chat-task-controller.js','components/panels/chat-session-controller.js',
      'components/panels/task-execution-context.js','components/panels/task-execution-client.js',
      'components/panels/panels-forward-plugin.js','components/panels/panels-forward-picker.js',
      'components/panels/panels-forward-options.js','components/panels/panels-forward.js',
      'components/requirements/requirement-session-choice.js','components/requirements/requirement-assignment.js'];
    for (const file of scripts) await js(fs.readFileSync(path.join(client,file),'utf8')+'\nvoid 0;');
    const owner = fs.readFileSync(path.join(client,'components/panels/panels-chat.js'),'utf8');
    const begin = owner.indexOf('  function sessionInfo()'), end = owner.indexOf('  function hasSession()',begin);
    assert(begin>=0&&end>begin,'NativeChat sessionInfo extraction boundary must exist');
    const sessionInfo = owner.slice(begin,end).trim();
    await js(`Object.assign(ctx,ChatWorkIntent.create(ctx),ChatTaskController.create(ctx),ChatSessionController.create(ctx));
      ctx._workCards=ChatWorkCards.create(ctx);
      ctx.sessionInfo=new Function('ctx','global','with(ctx){return ('+${JSON.stringify(sessionInfo)}+');}')(ctx,window);
      window.NativeChat={sessionInfo:ctx.sessionInfo,enqueueTask:async(...args)=>{
        const result=await ctx.enqueueTask(...args);calls.push({kind:'enqueue-result',result:clone(result)});
        resolveCompleted(result);return result;}};
      document.querySelector('#nativeControllerRegression').onclick=()=>RequirementSessionChoice.executeNative(taskFixture.id,'');void 0;`);
    // These two awaits are adjacent: no readiness delay after restoring receipt.
    const restored = await js(`(async()=>{await ctx._workCards.restore('isolated-work-draft');
      const shape=clone(ctx._snap.modelSelection);const info=NativeChat.sessionInfo();
      await RequirementAssignment.open(taskFixture.id);return {shape,model:info.model};})()`);
    assert.deepEqual(restored,{shape:{name:'',model:null},model:''});
    await waitDOM(`Boolean(document.querySelector('#fwdAgentSelect'))&&!document.querySelector('#fwdList .fwd-loading')`);
    assert.equal(await js(`Boolean(document.querySelector('[data-fwd-choice="native"]'))`),false);
    assert.equal(await js(`Boolean(document.querySelector('.rq-session-unavailable'))`),false);
    assert.equal(await js(`calls.some(row=>['open','bind','send'].includes(row.kind))`),false);
    assert.match(await js(`document.querySelector('.fwd-directory-hint').textContent`), /独立的会话目录/);
    // Exercise the production assignment UI with API-compatible catalogs. The
    // default remains an empty override; users may also select it explicitly.
    await js(`(async()=>{window.originalOptions=SoduWorkAPI.taskExecutionOptions;
      SoduWorkAPI.taskExecutionOptions=async()=>({...await originalOptions(),
        models:[],modelOptions:[{name:'only-model',providerId:'fixture-provider',providerName:'Example provider'}],defaultModel:'only-model',defaultModels:{pi:'only-model'}});
      RequirementAssignment.close();await RequirementAssignment.open(taskFixture.id);})()`);
    await waitDOM(`document.querySelector('#fwdModel option[value="only-model"]')`);
    assert.equal(await js(`document.querySelector('#fwdModel option[value=""]').textContent`),'跟随底座默认 · only-model · Example provider');
    assert.equal(await js(`document.querySelector('#fwdModel option[value="only-model"]').textContent`),'only-model · Example provider');
    assert.equal(await js(`document.querySelector('#fwdModel').value`),'');
    await js(`{const select=document.querySelector('#fwdModel');select.value='only-model';select.dispatchEvent(new Event('change'));}void 0;`);
    assert.equal(await js('_fwdModel'),'only-model');
    assert.equal(await js(`document.querySelector('#fwdConfirm').disabled`),false);
    report.cases.push({name:'single-model catalog shows its exact default and allows an explicit selection',ok:true,
      screenshot:await screenshot('03-explicit-default-model')});
    await js(`(async()=>{SoduWorkAPI.taskExecutionOptions=async()=>({...await originalOptions(),models:['review-model'],
      modelOptions:[{name:'catalog-model'},{name:'review-model'}],defaultModel:'catalog-model',defaultModels:{pi:'review-model'}});
      RequirementAssignment.close();await RequirementAssignment.open(taskFixture.id);})()`);
    await waitDOM(`document.querySelector('#fwdModel option[value="catalog-model"]')`);
    assert.equal(await js(`document.querySelector('#fwdModel option[value=""]').textContent`),'跟随底座默认 · review-model');
    assert.equal(await js(`document.querySelectorAll('#fwdModel option[value="catalog-model"]').length`),1);
    assert.equal(await js(`document.querySelector('#fwdModel').value`),'');
    report.cases.push({name:'Agent-specific default is named independently from the explicitly selectable catalog default',ok:true});
    await js(`(async()=>{SoduWorkAPI.taskExecutionOptions=originalOptions;RequirementAssignment.close();await RequirementAssignment.open(taskFixture.id);})()`);
    await waitDOM(`Boolean(document.querySelector('#fwdAgentSelect'))&&!document.querySelector('#fwdList .fwd-loading')`);
    await js(`const files=new DataTransfer();files.items.add(new File(['id,title'],'issues.csv'));
      const picker=document.querySelector('.fwd-materials input[type=file]');picker.files=files.files;
      picker.dispatchEvent(new Event('change'));void 0;`);
    assert.equal(await js(`document.getElementById('fwdConfirm').disabled`),true);
    await js('finishUpload();void 0;');
    await waitDOM(`document.querySelector('[data-material-list]').textContent==='issues.csv'&&!document.getElementById('fwdConfirm').disabled`);
    assert.deepEqual(await js(`calls.filter(row=>row.kind==='upload')`), [
      {kind:'upload',id:'isolated-default-task',name:'issues.csv',purpose:'requirement_input'},
    ]);
    report.cases.push({name:'local dispatch explains its session folder, waits for upload and lists the attached CSV',ok:true});
    report.assignmentVisual = await js(`(()=>{const e=document.querySelector('#fwdPop'),s=getComputedStyle(e);return {
      rect:JSON.parse(JSON.stringify(e.getBoundingClientRect())),display:s.display,visibility:s.visibility,opacity:s.opacity,
      css:document.styleSheets.length,text:e.innerText};})()`);
    report.cases.push({name:'default model restored; assignment mounts without errors or execution',ok:true,
      state:restored,screenshot:await screenshot('01-default-model-assignment')});
    await js(`RequirementAssignment.close();taskFixture.projectId='fixture-project';
      low.history=async()=>({ok:true,chats:[{id:'existing-chat',title:'Existing',projectId:taskFixture.projectId,
        cwd:'D:/existing-chat',adapterId:'pi',status:'idle'}]});
      low.runtimes=async()=>({ok:true,runtimes:[{id:'codex',displayName:'Codex',transport:'runner'}]});
      low.probe=()=>new Promise(resolve=>window.finishProbe=resolve);
      window.enqueue=NativeChat.enqueueTask;
      NativeChat.enqueueTask=()=>new Promise(resolve=>window.finishReuse=resolve);
      RequirementAssignment.open(taskFixture.id);`);
    await waitDOM(`document.querySelector('.rq-session-choice option[value="existing-chat"]')&&window.finishProbe`);
    await js(`const select=document.querySelector('.rq-session-choice select');select.value='existing-chat';
      select.dispatchEvent(new Event('change'));document.querySelector('.rq-session-choice .rq-primary').click();void 0;`);
    assert.match(await js(`document.querySelector('.rq-session-facts').textContent`), /D:\/existing-chat/);
    assert.equal(await js(`document.querySelector('.rq-session-choice [data-material-add]').matches(':disabled')`),true);
    await js(`finishProbe({ok:true,state:'ready'});void 0;`);
    await frames();
    await js(`finishReuse({ok:false,reason:'fixture refusal'});void 0;`);
    await waitDOM(`document.querySelector('.rq-session-status').textContent==='fixture refusal'&&
      document.querySelector('#fwdAgentSelect option[value="local:codex"]')`);
    assert.equal(await js(`document.querySelector('.rq-session-choice [data-material-add]').matches(':disabled')`),false);
    await js(`NativeChat.enqueueTask=enqueue;delete taskFixture.projectId;void 0;`);
    report.cases.push({name:'reuse shows its exact folder, locks uploads while submitting and restores deferred Agent options after failure',ok:true});
    await js('RequirementAssignment.close();void 0;');
    await click('#nativeControllerRegression');
    const result = await js(`Promise.race([completed,new Promise((_,reject)=>setTimeout(()=>reject(Error('No enqueue completion')),5000))])`);
    assert.equal(result.ok,true,JSON.stringify(await js(`({result:clone(calls),errors,toasts,taskOpenError:ctx._taskOpenError})`)));
    const evidence = await js(`({calls:clone(calls),errors:clone(errors),model:NativeChat.sessionInfo().model,
      sessionId:ctx._sessionId,nativeTurn:ctx._collabTasks.get(taskFixture.id)?.nativeTurn,
      queueState:ctx._collabTasks.get(taskFixture.id)?.queueState,pending:ctx._pending})`);
    const opened=evidence.calls.filter(row=>row.kind==='open'), bound=evidence.calls.filter(row=>row.kind==='bind'), sent=evidence.calls.filter(row=>row.kind==='send');
    assert.equal(opened.length,1);assert.equal(opened[0].options.chatId,undefined);
    assert.equal(opened[0].options.adapterId,'pi');assert.equal(opened[0].options.modelName,'');
    assert.equal(opened[0].options.taskRef,'isolated-default-task');assert(bound.length>=1);
    assert(bound.every(row=>row.ref==='isolated-ref'&&row.id==='isolated-default-task'));
    assert.equal(sent.length,1);assert.equal(sent[0].options.taskId,'isolated-default-task');
    assert.equal(sent[0].options.taskExecution.executionChoice,'native');
    assert.equal(sent[0].options.taskExecution.model,'');assert.equal(sent[0].text,'实现首页并提供验收说明');
    assert(evidence.calls.findIndex(row=>row.kind==='bind')<evidence.calls.findIndex(row=>row.kind==='send'));
    assert.equal(evidence.nativeTurn,true);assert.equal(evidence.queueState,'queued');assert.equal(evidence.pending,'');
    assert.equal(result.conversationId,'isolated-new-session');assert.equal(evidence.model,'');assert.deepEqual(evidence.errors,[]);
    await waitDOM(`!document.querySelector('#fwdConfirm')||document.querySelector('#fwdConfirm').offsetParent===null`);
    await js(`document.querySelector('#receipt').textContent=${JSON.stringify('已确认：新会话 isolated-new-session\n需求绑定成功 → 本机发送已接受\n默认模型：保持企业默认（空选择）')};void 0;`);
    report.cases.push({name:'fixture controller button opens fresh native session, binds task, starts real send controller and accepts queue receipt',ok:true,
      result,evidence,screenshot:await screenshot('02-native-send-accepted')});
    report.errors=await js('errors');assert.deepEqual(report.errors,[]);assert.deepEqual(report.networkRequests,[]);report.ok=true;
  }).catch(async error=>{
    report.error=String(error.stack||error);
    if(win&&!win.isDestroyed()) {
      report.diagnostics=await js(`({errors:window.errors,calls:window.calls,toasts:window.toasts,body:document.body.innerText})`).catch(()=>null);
      report.failureScreenshot=await screenshot('failure').catch(()=>null);
    }
  }).finally(()=>{
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({ok:report.ok,cases:report.cases.length,report:path.join(out,'report.json'),error:report.error||null}));
    if(win&&!win.isDestroyed())win.destroy();app.exit(report.ok?0:1);
  });
}
