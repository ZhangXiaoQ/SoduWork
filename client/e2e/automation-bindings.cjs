'use strict';
// Real Chromium controls and production automation scripts, synthetic catalogs/API.
// No model, Hub, user profile, real schedule or task is touched.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron,[__filename,...process.argv.slice(2)],{env,windowsHide:true,stdio:'inherit'});
  const timer = setTimeout(()=>{child.kill();process.exitCode=1;},60000);
  child.on('exit',code=>{clearTimeout(timer);process.exitCode=code??1;});
} else {
  const {app,BrowserWindow}=electron;
  const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
  const {pathToFileURL}=require('node:url');
  const client=path.resolve(__dirname,'..'),output=process.argv[2]?path.resolve(process.argv[2]):path.resolve(client,'../outputs/automation-bindings-20261015');
  fs.mkdirSync(output,{recursive:true}); app.setPath('userData',path.join(output,'profile-'+Date.now()));
  const report={ok:false,realModel:false,realHub:false,cases:[],errors:[]};
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  let win;
  const js=source=>win.webContents.executeJavaScript(source,true);
  const until=async source=>{for(let i=0;i<100;i++){if(await js(source))return;await delay(30);}throw Error('Timed out '+source);};
  const get=name=>js(`document.querySelector('[name="${name}"]').value`);
  const choose=(name,value)=>js(`(()=>{const el=document.querySelector('[name="${name}"]');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  const open=(text,proposal={})=>js(`WorkAutomationSheet.open({host:document.getElementById('host'),text:${JSON.stringify(text)},proposal:${JSON.stringify(proposal)}})`);
  // Refinements retain disabled history snapshots with the same action attributes.
  const save=()=>js('document.querySelector("[data-plugin-surface=work-automation]:not(.is-archived) [data-waz-save]").click();void 0;');
  app.whenReady().then(async()=>{
    win=new BrowserWindow({show:false,width:1200,height:1600,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
    win.webContents.on('console-message',event=>{if(event.level==='error')report.errors.push(event.message);});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_r,cb)=>cb({cancel:true}));
    const page=path.join(output,'fixture.html');
    fs.writeFileSync(page,'<!doctype html><html><head><meta charset="utf-8"></head><body><main id="host"></main></body></html>');
    await win.loadFile(page);
    for(const file of ['theme/variables.css','components/panels/plugin-ui-host.css','components/panels/work-automation-sheet.css']) {
      await js(`new Promise(r=>{const s=document.createElement('link');s.rel='stylesheet';s.href=${JSON.stringify(pathToFileURL(path.join(client,file)).href)};s.onload=s.onerror=r;document.head.append(s)})`);
    }
    await js(`(()=>{const s=document.createElement('style');s.textContent='body{margin:0;background:var(--bg-0);font-family:var(--font-ui)}#host{max-width:1020px;margin:24px auto}';document.head.append(s)})()`);
    for(const name of ['plugin-ui-host','schedule-timing', 'work-automation-bindings','work-automation-view','work-automation-card-state','work-automation-sheet'])
      await js(fs.readFileSync(path.join(client,'components/panels',name+'.js'),'utf8')+'\nvoid 0;');
    await js(`window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      window.methods=[{key:'games',name:'小游戏',version:'1.2.3',checksum:'a'.repeat(64),inputs:[],capabilities:{runtime:['browser']}},
        {key:'reports',name:'报表',version:'2.0.0',checksum:'b'.repeat(64),inputs:[{key:'format',label:'格式',type:'text'}],capabilities:{runtime:['office']}}];
      window._schmLoad=async()=>methods;
      window.execution={substrates:[{key:'local:pi',name:'Pi',cli:'pi',available:true},{key:'local:codex',name:'Codex',cli:'codex',available:true}],
        repos:[{id:'repo-games',name:'游戏工程'},{id:'repo-reports',name:'报表工程'}]};
      window.calls={parse:[],probe:[],save:[]};window.parsed={};window.pendingProbes=[];window.holdProbes=false;
      window.SoduWorkAPI={taskExecutionOptions:async()=>execution,
        parseTaskText:async(text,model,attachments,options)=>{calls.parse.push({text,options});return {title:'纸牌游戏开发',note:text,checklist:['可演示'],...parsed}},
        preflightSchedule:async body=>{calls.probe.push(body);if(holdProbes)return new Promise(r=>pendingProbes.push(r));return {state:'ready',title:'执行条件已就绪',message:'隔离验证'}},
        createSchedule:async body=>{calls.save.push(body);return {id:'fixture-'+calls.save.length,...body}}};void 0;`);
    await open('每天中午12点，使用小游戏插件，在游戏工程开发，由Codex执行');
    assert.equal(await get('personalPluginKey'),'games');assert.equal(await get('repoId'),'repo-games');assert.equal(await get('assigneeId'),'local:codex');
    assert.equal(await js('calls.parse.at(-1).options.kind'),'automation');
    assert.equal(await js('calls.parse.at(-1).options.candidates.methods[0].id'),'games');
    await until('document.querySelector("#wazProbe").classList.contains("ready")');
    fs.writeFileSync(path.join(output,'selected.png'),(await win.webContents.capturePage()).toPNG());
    await save();
    await until('calls.save.length===1');
    const body=await js('calls.save[0]');
    assert.equal(body.personalPluginKey,'games');assert.equal(body.personalPluginVersionPolicy,'pinned');
    assert.equal(body.personalPluginVersion,'1.2.3');assert.equal(body.personalPluginChecksum,'a'.repeat(64));
    assert.equal(body.repoId,'repo-games');assert.equal(body.assigneeId,'local:codex');
    assert.deepEqual(body.requiredCapabilities,['browser']);
    assert.equal(body.bindingIssues,undefined);
    report.cases.push('explicit method/repo/substrate select actual options and save the current pinned manifest');

    await open('每天12点，使用小游戏插件');
    await choose('personalPluginKey','reports');await choose('repoId','repo-reports');
    await until('calls.probe.at(-1).personalPluginKey==="reports"');
    assert.deepEqual(await js('calls.probe.at(-1).requiredCapabilities'),['office']);
    await js(`document.querySelector('[data-waz-method-input="format"]').value='csv';void 0;`);
    await js(`parsed={automationBindings:{method:{action:'select',id:'games',name:'小游戏',evidence:'使用小游戏插件'}}};WorkAutomationSheet.refine('完成标准增加可演示')`);
    assert.equal(await get('personalPluginKey'),'reports');assert.equal(await get('repoId'),'repo-reports');
    assert.equal(await js(`document.querySelector('[data-waz-method-input="format"]').value`),'csv');
    await js(`parsed={};WorkAutomationSheet.refine('改用小游戏插件，不关联工程')`);
    assert.equal(await get('personalPluginKey'),'games');assert.equal(await get('repoId'),'');
    await js(`WorkAutomationSheet.refine('不用插件')`);assert.equal(await get('personalPluginKey'),'');
    await until('calls.probe.at(-1).personalPluginKey===""');
    assert.deepEqual(await js('calls.probe.at(-1).requiredCapabilities'),[]);
    await js(`WorkAutomationSheet.refine('再增加一条交付说明')`);assert.equal(await get('personalPluginKey'),'');
    report.cases.push('manual choices and inputs survive unrelated refinement; explicit replacement and clear apply');

    await js(`methods.push({...methods[0],key:'another-game'});void 0;`);
    await open('每天12点，使用小游戏插件');
    assert.equal(await get('personalPluginKey'),'__waz_unresolved__');
    assert.match(await js('document.querySelector("#wazProbe").textContent'),/不唯一/);
    await save();
    assert.equal(await js('calls.save.length'),1);
    await choose('personalPluginKey','games');
    assert.equal(await get('personalPluginKey'),'games');
    await until('document.querySelector("#wazProbe").classList.contains("ready")');
    report.cases.push('ambiguous names remain pending and block creation until an explicit selection');
    await js('methods.pop();void 0;');

    await open('每天12点，使用不存在插件');
    assert.equal(await get('personalPluginKey'),'__waz_unresolved__');
    assert.match(await js('document.querySelector("#wazProbe").textContent'),/不存在/);
    await choose('personalPluginKey','');
    await until('document.querySelector("#wazProbe").classList.contains("ready")');
    assert.equal(await get('personalPluginKey'),'');
    report.cases.push('unavailable reference can be deliberately cleared instead of trapping the already empty selector');

    await open('每天12点检查报告',{personalPluginKey:'removed',repoId:'gone'});
    assert.equal(await get('personalPluginKey'),'removed');assert.equal(await get('repoId'),'gone');
    assert.match(await js('document.querySelector("#wazProbe").textContent'),/不可用/);
    await save();assert.equal(await js('calls.save.length'),1);
    report.cases.push('missing preserved plugin and engineering repo remain visible and cannot degrade to defaults');

    await open('2030年10月20日中午12点使用小游戏插件');
    assert.equal(await get('every'),'once');assert.equal(await get('personalPluginKey'),'games');
    assert.equal(await get('runAt'),'2030-10-20T12:00');
    await until('document.querySelector("#wazProbe").classList.contains("ready")');
    assert.equal(await js('calls.probe.at(-1).every'),'once');
    assert.ok(await js('Boolean(calls.probe.at(-1).runAt)'));
    fs.writeFileSync(path.join(output,'once.png'),(await win.webContents.capturePage()).toPNG());
    await save();
    await until('calls.save.length===2');
    assert.equal(await js('calls.save[1].every'),'once');
    assert.equal(await js('ScheduleTiming.localInput(calls.save[1].runAt,calls.save[1].timeZone)'),'2030-10-20T12:00');
    report.cases.push('one-off request selects a fixed future date and saves one UTC reservation with its method');
    await open('只执行一次生成报告');
    assert.equal(await get('every'),'once');assert.equal(await get('runAt'),'');
    assert.match(await js('document.querySelector("#wazProbe").textContent'),/日期|时间/);
    await save();assert.equal(await js('calls.save.length'),2);
    await choose('runAt','2020-01-01T12:00');
    assert.match(await js('document.querySelector("#wazProbe").textContent'),/过去/);
    await choose('runAt','2030-10-20T12:00');
    await until('document.querySelector("#wazProbe").classList.contains("ready")');
    await js(`WorkAutomationSheet.refine('完成标准增加检查日志')`);
    assert.equal(await get('runAt'),'2030-10-20T12:00');
    await choose('every','daily');await until('calls.probe.at(-1).every==="daily"');
    assert.equal(await js('calls.probe.at(-1).runAt'),null);
    report.cases.push('missing and past dates block creation; editing, refinement and switching recurrence preserve intent');

    await js('holdProbes=true;pendingProbes=[];void 0;');
    await open('每天12点使用小游戏插件');await until('pendingProbes.length===1');
    await js(`WorkAutomationSheet.refine('改用不存在插件')`);
    assert.match(await js('document.querySelector("#wazProbe").textContent'),/不存在/);
    await js(`pendingProbes[0]({state:'ready',title:'旧预检',message:'不得覆盖'});void 0;`);await delay(60);
    assert.match(await js('document.querySelector("#wazProbe").textContent'),/不存在/);
    report.cases.push('late successful preflight cannot overwrite a newly blocked binding');
    await js('holdProbes=false;void 0;');

    await open('每天12点，对比小游戏插件和报表插件的使用文档');
    assert.equal(await get('personalPluginKey'),'');
    report.cases.push('ordinary mention and comparison do not invoke or bind a plugin');

    await js(`WorkAutomationSheet.open({host:document.getElementById('host'),text:'每天12点执行',
      bindingContext:{personalPluginKey:'games',repoId:'repo-games',adapterId:'codex'}})`);
    assert.equal(await get('personalPluginKey'),'games');assert.equal(await get('repoId'),'repo-games');assert.equal(await get('assigneeId'),'local:codex');
    report.cases.push('structured picker and current session context populate the same grounded form');

    await js(`window.originalLoad=_schmLoad;window.finishCatalog=null;
      _schmLoad=()=>new Promise(r=>finishCatalog=r);window.oldOpen=WorkAutomationSheet.open({host:document.getElementById('host'),text:'使用小游戏插件'});void 0;`);
    await until('Boolean(finishCatalog)');
    await js('_schmLoad=originalLoad;void 0;');
    await open('每天12点，使用报表插件');
    await js('finishCatalog([{key:"stale",name:"小游戏"}]);void 0;');
    assert.equal(await js('oldOpen'),false);assert.equal(await get('personalPluginKey'),'reports');
    report.cases.push('closed and reopened sheets cannot receive the previous catalog response');
    await open('每天12点生成报告。保存为暂停状态。如果审批通过，创建后启用。');
    assert.equal(await js('document.querySelector("[name=enabled]").checked'), false);
    await until('document.querySelector("#wazProbe").classList.contains("ready")');
    const beforePause = await js('calls.save.length');
    await save();
    await until('calls.save.length===' + (beforePause + 1));
    assert.equal(await js('calls.save.at(-1).enabled'), false);
    report.cases.push('conditional enable text leaves the checkbox and submitted schedule paused');

    await open('每天12点生成报告。保存为暂停状态。');
    await js("WorkAutomationSheet.refine('创建后启用')");
    assert.equal(await js('document.querySelector("[name=enabled]").checked'), true);
    await until('document.querySelector("#wazProbe").classList.contains("ready")');
    const beforeEnable = await js('calls.save.length');
    await save();
    await until('calls.save.length===' + (beforeEnable + 1));
    assert.equal(await js('calls.save.at(-1).enabled'), true);
    report.cases.push('an explicit unconditional refinement enables the actual submitted schedule');
    assert.deepEqual(await js('errors'),[]);assert.deepEqual(report.errors,[]);report.ok=true;
  }).catch(async error=>{
    report.errors.push(error.stack);
    report.failureState = await js(`({
      text: document.getElementById('host')?.innerText,
      saveButtons: [...document.querySelectorAll('[data-waz-save]')].map(el=>({text:el.textContent,disabled:el.disabled,archived:!!el.closest('.is-archived')})),
      calls, errors
    })`).catch(()=>null);
  }).finally(()=>{
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));win?.destroy();app.exit(report.ok?0:1);
  });
}
