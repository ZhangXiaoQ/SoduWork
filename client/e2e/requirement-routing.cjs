'use strict';
// Exercise the real action-to-form-to-save flow with isolated model, API, and Store doubles.
// Creation records goals and business type; the assignee configures and preflights execution later.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-requirement-routing-e2e-'));
  const out = path.resolve(process.argv[2] || path.join(client, '../outputs/requirement-routing-fix-20261015/actions'));
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  const report = { ok: false, cases: [], errors: [], realModel: false, businessDatabase: false };
  let win;
  const js = code => win.webContents.executeJavaScript(code, true).catch(error => { report.failedScript=code.slice(0,500);throw error; });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) {
    for(let i=0;i<150;i++) { if(await js(code)) return; await delay(20); }
    throw Error('Timed out: ' + code);
  }
  async function click(selector) {
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await delay(180);
    const point=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
      const p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
      if(!e.contains(document.elementFromPoint(p.x,p.y)))throw Error('Covered button');return p})()`);
    for(const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});
  }
  const direct='工作目标分析智能体，缺陷如附件，转给示例成员 修复';
  async function scenario(name, parsed, options={}) {
    await js(`WorkEntrySheet.close();window.calls=[];window.toasts=[];window.parsed=${JSON.stringify(parsed)};window.blocked=false;window.tasks=[];void 0;`);
    const text=options.text||direct;
    if(options.proposal) await js(`WorkEntrySheet.openTask({text:${JSON.stringify(text)},proposal:${JSON.stringify(options.proposal)}});void 0;`);
    else await js(`window.selected=PluginUIHost.actions().find(action=>action.id==='work.requirement.create');
      ChatWorkActions.route({text:${JSON.stringify(text)},mention:{action:()=>selected},attachments:{analysis:async()=>[{name:'缺陷清单.txt',text:'附件缺陷原文'}]}},
      {open:(command,options)=>ChatWorkActions.open(command,options,{mount:()=>document.body,dismissProposal(){},bridge:()=>({})})});void 0;`);
    await until('Boolean(document.querySelector("#cpCreate"))');
    if(options.selectedKind) await js(`document.querySelector('#cpKind').value=${JSON.stringify(options.selectedKind)};document.querySelector('#cpKind').dispatchEvent(new Event('change',{bubbles:true}));void 0;`);
    const before=await js(`({kind:document.querySelector('#cpKind').value,executionSelectors:document.querySelectorAll('[data-selbtn=scene],[data-selbtn=flow],[data-selbtn=repo]').length,label:document.querySelector('#cpCreate').textContent,body:document.querySelector('#wesTaskDraft').innerText,
      note:document.querySelector('#cpNote').value,calls:JSON.parse(JSON.stringify(calls))})`);
    await js(`window.blocked=${Boolean(options.blockedAtSubmit)};void 0;`);
    await click('#cpCreate');
    await until('Boolean(document.querySelector(".cp-ok"))');
    const after=await js(`({calls:JSON.parse(JSON.stringify(calls)),body:document.querySelector('#wesTaskDraft').innerText,
      tasks:JSON.parse(JSON.stringify(tasks)),note:document.querySelector('#cpNote')?.value,taskCount:tasks.length,toasts:toasts.slice(),success:Boolean(document.querySelector('.cp-ok'))})`);
    const result={name,text,parsed,before,after};report.cases.push(result);return result;
  }
  app.whenReady().then(async()=>{
    const html=fs.readFileSync(path.join(client,'desk.html'),'utf8');
    const styles=[...html.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)]
      .map(m=>fs.readFileSync(path.join(client,m[1]),'utf8')).join('\n');
    const fixture=path.join(temporary,'fixture.html');
    fs.writeFileSync(fixture,'<!doctype html><meta charset="utf-8"><style>'+styles+'</style><main class="nchat-draft"></main><textarea id="nchatInput"></textarea>');
    win=new BrowserWindow({show:false,width:1200,height:1100,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_request,cb)=>cb({cancel:true}));
    win.webContents.on('console-message',event=>{if(event.level==='error')report.errors.push(event.message);});
    await win.loadFile(fixture);
    await js(`window.calls=[];window.toasts=[];window.petSay=text=>toasts.push(text);window.uid=()=> 'isolated-task';window.tasks=[];
      window.save=()=>calls.push({kind:'save-local'});window.Store={persistTask:async id=>{calls.push({kind:'persistTask',id});return true;},dropTask(){}};
      window.Requirements={dateTimestamp:()=>null};window.fixtureFlow={bindingId:'binding-bug149',key:'soduwork-bugfix-149',name:'Bug修复上线149',runnable:true,multiAgent:true,workflow:{nodes:[{key:'repair',type:'ai'},{key:'review',type:'ai_review'}]}};
      window.SoduWorkAPI={taskStorageKey:()=> 'isolated-user',parseTaskText:async(...args)=>{calls.push({kind:'parse',args});return parsed;},
        listTeammates:async()=>({mates:[{id:'user-lipeng',name:'高礼朋',hasBox:true,deviceCount:1}]}),
        workCatalog:async()=>{calls.push({kind:'work-catalog'});return{scenarios:[{key:'bugfix',name:'缺陷修复',defaultPluginKey:'soduwork-bugfix-149'}]};},
        taskExecutionOptions:async body=>{calls.push({kind:'execution-options',body,blocked});return {substrates:[{key:'local:pi',name:'Pi',available:true}],workflows:blocked?[]:[fixtureFlow],blockedWorkflows:blocked?[{...fixtureFlow,runnable:false,readiness:{blockers:['需要选择代码仓库']}}]:[],repos:[{id:'repo-a',name:'可选工程',projectId:'project-a'}]};},
        createAssignedTask:async body=>{calls.push({kind:'assign-human',body});return {ok:true,task:{id:'isolated-assigned',title:body.title},targetName:'示例成员'};},
        startTaskPlugin:async(id,body)=>{calls.push({kind:'start-workflow',id,body});return {ok:true};},
        dispatchToAI:async(...args)=>{calls.push({kind:'start-direct-ai',args});return {ok:true};}};void 0;`);
    for(const name of ['task-priority','task-execution-client','plugin-ui-host','requirement-routing','panels-compose-submit','panels-compose-draft','work-entry-sheet','panels-chat-work-actions'])
      await js(fs.readFileSync(path.join(client,'components/panels',name+'.js'),'utf8')+'\nvoid 0;');
    await js(fs.readFileSync(path.join(client,'components/requirements/requirement-fields.js'),'utf8')+'\nvoid 0;');
    const human=await scenario('named human overrides model workflow recommendation',
      {title:'修复工作目标分析智能体',note:'修复附件缺陷',kind:'bug',assignee:'礼朋',assigneeExplicit:true,scene:'bugfix',flow:'soduwork-bugfix-149'});
    const noFlow=await scenario('unrequested workflow remains a recommendation',
      {title:'修复附件缺陷',note:'修复附件缺陷',assignee:'ai',flow:'soduwork-bugfix-149'}, {text:'检查附件中的缺陷'});
    const flowFields={title:'修复附件缺陷',note:'修复附件缺陷',assignee:'ai',flow:'soduwork-bugfix-149',flowRequested:'Bug修复上线149',flowExplicit:true};
    const explicitFlow=await scenario('明确插件建议在创建时不绑定或启动',flowFields,{text:'使用Bug修复上线149流程修复附件缺陷'});
    const blocked=await scenario('执行条件不满足时仍可保存需求',flowFields,
      {text:'使用Bug修复上线测试环境流程修复附件缺陷',blockedAtSubmit:true});
    const structured=await scenario('structured human identity survives workflow suggestion',{},
      {proposal:{title:'修复缺陷',note:'附件缺陷',assigneeUserId:'user-lipeng',flow:'soduwork-bugfix-149'}});
    for(const value of [human,structured]) {
      assert(value.before.body.includes('高示例成员')); assert(value.before.label.includes('转给'));
      assert.equal(value.after.calls.filter(c=>c.kind==='assign-human').length,1);
      assert.equal(value.after.calls.find(c=>c.kind==='assign-human').body.assigneeUserId,'user-example');
      assert(!value.after.calls.some(c=>c.kind==='start-workflow'||c.kind==='start-direct-ai'));
    }
    assert.equal(human.before.calls.find(c=>c.kind==='parse').args[3].instruction,direct);
    assert(!noFlow.before.body.includes('按工作流配置执行'));
    assert(!noFlow.after.calls.some(c=>c.kind==='start-workflow'));
    for(const value of [noFlow,explicitFlow,blocked]) {
      assert.equal(value.after.success,true); assert.equal(value.after.taskCount,1);
      assert.equal(value.after.tasks[0].executionContext,null);
      assert.deepEqual(value.after.tasks[0].workRouting,{});
      assert.equal(value.after.tasks[0].workScenarioKey,undefined);
      assert.equal(value.after.tasks[0].note,value.before.note);
      assert.equal(value.after.calls.filter(c=>c.kind==='persistTask').length,1);
      assert(!value.after.calls.some(c=>['start-direct-ai','start-workflow','execution-options'].includes(c.kind)));
    }
    assert.equal(human.before.kind,'bug');
    assert.equal(human.after.calls.find(c=>c.kind==='assign-human').body.kind,'bug');
    for(const kind of ['requirement','bug','ticket','improvement','other']) {
      const value=await scenario('识别并保存业务类型：'+kind,
        {title:'类型验证',note:'保留目标内容',kind,scene:'bugfix',flow:'soduwork-bugfix-149'},{text:'记录待办事项'});
      assert.equal(value.before.kind,kind); assert.equal(value.after.tasks[0].kind,kind);
    }
    const changed=await scenario('手动改为优化后保留用户选择',
      {title:'类型验证',note:'保留目标内容',kind:'bug'},{text:'记录问题',selectedKind:'improvement'});
    assert.equal(changed.before.kind,'improvement');assert.equal(changed.after.tasks[0].kind,'improvement');
    for(const value of report.cases) {
      assert.equal(value.before.executionSelectors,0);
      assert(!value.after.calls.some(c=>['work-catalog','execution-options','start-direct-ai','start-workflow'].includes(c.kind)));
      assert(!value.before.body.includes('工作类型'));
    }
    // Use real workspace and pet entry functions while stubbing IPC to avoid controlling live windows.
    await js(`WorkEntrySheet.close();window.__deskPanel='workspace';window.__deskArgs={view:'history'};
      window.initData=async()=>{};window.openTaskCenter=()=>calls.push({kind:'open-pool'});
      window.openAdd=()=>calls.push({kind:'legacy-add'});window.soduWorkAPI={openDeskWindow:payload=>calls.push({kind:'open-window',payload})};void 0;`);
    for(const file of ['core/win-bridge.js','desk-boot.js'])
      await js(fs.readFileSync(path.join(client,file),'utf8')+'\nvoid 0;');
    await until(`WorkspaceHost.view==='history'`);
    for(const entry of ['workspace','pet','legacy-workspace-add']) {
      await js(`WorkEntrySheet.close();window.calls=[];window.tasks=[];window.__deskPanel=${JSON.stringify(entry==='pet'?'':'workspace')};void 0;`);
      if(entry==='legacy-workspace-add') await js(`WorkspaceHost.open('add',{});void 0;`);
      else await js('openAddEntry();void 0;');
      if(entry==='pet') {
        const route=await js(`calls.find(value=>value.kind==='open-window')?.payload`);
        assert.deepEqual(route,{panel:'workspace',view:'history',createRequirement:true});
        await js(`window.__deskPanel='workspace';WorkspaceHost.open(${JSON.stringify(route.view)},${JSON.stringify(route)});void 0;`);
      }
      await until('Boolean(document.querySelector("#cpCreate"))');
      await js(`document.querySelector('#cpTitle').value='入口保存验证';document.querySelector('#cpNote').value='原文目标';
        document.querySelector('#cpKind').value='bug';document.querySelector('#cpKind').dispatchEvent(new Event('change',{bubbles:true}));void 0;`);
      const before=await js(`({label:document.querySelector('#cpCreate').textContent,body:document.querySelector('#wesTaskDraft').innerText,
        executionSelectors:document.querySelectorAll('[data-selbtn=scene],[data-selbtn=flow],[data-selbtn=repo]').length})`);
      await click('#cpCreate');await until('Boolean(document.querySelector(".cp-ok"))');
      const after=await js(`({calls:JSON.parse(JSON.stringify(calls)),tasks:JSON.parse(JSON.stringify(tasks)),toasts:[]})`);
      assert.equal(before.executionSelectors,0);assert.equal(after.tasks[0].kind,'bug');
      assert.equal(after.tasks[0].executionContext,null);
      assert(!after.calls.some(c=>['legacy-add','work-catalog','execution-options','start-direct-ai','start-workflow'].includes(c.kind)));
      report.cases.push({name:'统一创建入口：'+entry,before,after});
    }
    assert.equal(report.errors.length,0,JSON.stringify(report.errors));report.ok=true;
  }).catch(error=>{report.error=String(error.stack||error);}).finally(()=>{
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({ok:report.ok,error:report.error,cases:report.cases.map(row=>({name:row.name,label:row.before.label,
      dispatch:row.after.calls.filter(call=>['start-workflow','assign-human','start-direct-ai'].includes(call.kind)).map(call=>call.kind),toasts:row.after.toasts}))},null,2));
    win?.destroy();app.exit(report.ok?0:1);
  });
}
