'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-agents.js'), 'utf8');
function fixture() {
  const listeners = {}, body = { innerHTML: '', querySelectorAll: () => [] };
  const context = { console, setTimeout, clearTimeout, setInterval, clearInterval,
    esc: value => String(value || ''), addEventListener: (name, fn) => { listeners[name] = fn; },
    document: { getElementById: id => id === 'agBody' ? body : null },
    SoduWorkAPI: {}, petSay() {} };
  context.window = context;
  vm.createContext(context); vm.runInContext(source, context);
  return { context, listeners, body, run: code => vm.runInContext(code, context) };
}
const machine = agents => ({ runnerId: 'computer', scope: 'current-instance', label: 'Fixture', env: {}, agents });
const base = { key: 'opencode', name: 'OpenCode', installed: true, present: true,
  state: 'ready', version: '1.18.18', bin: 'opencode.exe', model: 'selected-model' };

test('managed Agent defaults disclose Anthropic incompatibility while account-based Agents remain unchanged', () => {
  const f = fixture();
  f.run("_agData={models:[{name:'anthropic-model',providerKind:'anthropic'},{name:'openai-model',providerKind:'openai-compat'}]}");
  for (const model of ['anthropic-model', '']) {
    const html = f.context._agModelHtml({ modelPick: true, key: 'pi', model, modelEffective: 'anthropic-model' });
    assert.match(html, /OpenAI 兼容协议/);
    assert.match(html, /Anthropic 模型需使用支持其协议的 Agent/);
  }
  assert.match(f.context._agModelHtml({ modelPick: true, key: 'pi', model: 'openai-model' }), /role="note"/);
  f.run("_agData={models:[{name:'openai-model',providerKind:'openai-compat'}]}");
  assert.doesNotMatch(f.context._agModelHtml({ modelPick: true, key: 'pi', model: 'openai-model' }), /ag-model-warn/);
  assert.doesNotMatch(f.context._agModelHtml({ modelPick: false, key: 'claude', model: 'anthropic-model' }), /OpenAI 兼容/);
});

test('Agent management renders only this client even when cloud and other instances share its label', () => {
  const f = fixture();
  f.context.machines = [machine([base]),
    { ...machine([base]), runnerId: 'cloud', scope: 'personal-cloud', isCurrentDevice: true },
    { ...machine([base]), runnerId: 'other', scope: 'bound-runner' },
    { ...machine([base]), runnerId: 'unknown', scope: undefined }].map(m => ({...m,label:'我的电脑'}));
  f.run('_agData={machines,modelCount:1}');
  f.context._agRender();
  assert.equal(f.run('_agMachines().length'), 1);
  assert.match(f.body.innerHTML, /本机 AI 助手/);
  assert.match(f.body.innerHTML, /data-ak="computer~opencode"/);
  assert.doesNotMatch(f.body.innerHTML, /data-ak="(?:cloud|other|unknown)~/);
});

test('cloud-only and legacy backend inventories cannot become a local fallback', () => {
  const f = fixture(); f.context.agent = base;
  for (const payload of [
    "{machines:[{runnerId:'cloud',scope:'personal-cloud',agents:[agent]}],agents:[agent],modelCount:0}",
    "{machines:[],agents:[agent],execution:'backend',modelCount:0}",
    "{agents:[agent],env:{host:'My computer'},modelCount:0}",
  ]) {
    f.run('_agData=' + payload);
    f.context._agRender();
    assert.equal(f.run('_agMachines().length'), 0);
    assert.match(f.body.innerHTML, /本机底座暂不可用/);
    assert.match(f.body.innerHTML, /云端底座请在「云端电脑」中管理/);
    assert.doesNotMatch(f.body.innerHTML, /data-ak=|一个模型都用不了/);
  }
});

test('local discovery uses its dedicated API and preserves the actual Runner diagnostic', async () => {
  const f = fixture();
  f.context.SoduWorkAPI.agentSetup = () => { throw Error('Unscoped discovery is forbidden'); };
  f.context.SoduWorkAPI.localAgentSetup = async () => ({machines:[],env:{why:'Local Runner reconnecting'},modelCount:null});
  await f.context._agLoad(true);
  assert.match(f.body.innerHTML, /Local Runner reconnecting/);
});

test('Pi cannot be uninstalled when old runners omit bundled metadata or its payload is broken', async () => {
  const f = fixture(); let calls = 0;
  f.context.SoduWorkAPI.agentInstall = async () => { calls++; return { jobId: 'unexpected' }; };
  for (const state of ['ready', 'broken', 'missing']) {
    const pi = { ...base, key: 'pi', name: 'Pi', bundled: false, state, setupState: state,
      installed: state === 'ready', canUninstall: true };
    f.context.pi = pi;
    f.run("_agData={machines:[{runnerId:'computer',scope:'current-instance',agents:[pi]}]};_agConfirm='computer~pi'");
    const html = f.context._agBodyHtml(pi, state, 'computer~pi');
    assert.doesNotMatch(html, /data-aunin=|data-adoun=/);
    await f.context._agRun('computer~pi', 'uninstall');
  }
  assert.equal(calls, 0);
});

test('local details and authorization retain host facts without repeating them in the section title', () => {
  const f = fixture();
  const m = { runnerId: 'cloud', label: '我的电脑', host: 'linux-cloud', os: 'linux', agents: [base] };
  assert.equal(f.context._agMachineIdentity(m), '远程执行环境 · 我的电脑 · linux-cloud · linux');
  assert.equal(f.context._agMachineIdentity({...m,isCurrentDevice:false,scope:'personal-cloud'}), '个人云端 · 我的电脑 · linux-cloud · linux');
  assert.equal(f.context._agMachineIdentity({...m,isCurrentDevice:true}), '当前客户端 · 我的电脑 · linux-cloud · linux');
  assert.match(f.context._agMachineHtml(m), /本机 AI 助手/);
  f.context.machine = {...m,scope:'current-instance'};
  f.run("_agData={machines:[machine]};_agOpen='cloud~opencode'");
  assert.match(f.context._agDrawer(), /装在.*linux-cloud · linux/);
});

test('unknown Codex login keeps installation facts but offers connection instead of dispatch', () => {
  const f = fixture();
  const a = { ...base, key:'codex', auth:'unauthed', authStatus:'unknown', setupState:'unknown', loginAvailable:true };
  const status = f.context._agPresentation(a);
  assert.equal(status.installed, true);
  assert.equal(status.canProbe, false);
  assert.equal(status.primaryAction, 'login');
  assert.equal(status.state, 'unknown');
});

test('native login requires advertised support and remains scoped to its machine', async () => {
  const f = fixture(), calls = [];
  const codex = {...base,key:'codex',name:'Codex',loginAvailable:true};
  f.context.codex = codex; f.context._agRender = () => {}; f.context._agPoll = () => {};
  f.run(`_agData={machines:[{runnerId:'native',scope:'current-instance',agents:[codex]},{runnerId:'old',scope:'current-instance',agents:[{...codex,loginAvailable:false}]}]}`);
  f.context.SoduWorkAPI.agentInstall = async () => {throw Error('Opening a dialog must not start authorization')};
  f.context.CodexAuthDialog = {open: async options => calls.push(options.runnerId)};
  assert.match(f.context._agBodyHtml(codex,'ready','native~codex'),/data-alogin="native~codex"/);
  assert.doesNotMatch(f.context._agBodyHtml({...codex,loginAvailable:false},'ready','old~codex'),/data-alogin/);
  assert.doesNotMatch(f.context._agBodyHtml({...codex,key:'codex-harness'},'ready','native~codex-harness'),/data-alogin/);
  await f.context._agRun('old~codex','login');
  await f.context._agRun('native~codex-harness','login');
  await f.context._agRun('native~codex','login');
  await f.context._agRun('native~codex','login');
  assert.deepEqual(calls,['native','native']);
  assert.doesNotMatch(f.context._agJobHtml({action:'login',lines:['secret-token']}),/secret-token/);
});

test('authorization completion tests only the original machine after a fresh detector read', async () => {
  const f = fixture(), calls = [];
  f.context._agRender = () => {}; f.context._agPoll = () => {};
  f.context.codex = {...base,key:'codex',name:'Codex',auth:'unauthed',state:'unauthed',loginAvailable:true};
  f.run(`_agData={machines:[{runnerId:'native',scope:'current-instance',agents:[codex]}]}`);
  let options;
  f.context.CodexAuthDialog = {open: async value => {options=value}};
  f.context.SoduWorkAPI.localAgentSetup = async () => {calls.push('detect');return{machines:[{runnerId:'native',scope:'current-instance',agents:[{...f.context.codex,auth:'authed',state:'ready'}]}]}};
  f.context.SoduWorkAPI.agentProbe = async (key,model,runnerId) => {calls.push({key,runnerId});return{jobId:'probe'}};
  await f.context._agRun('native~codex','probe');
  assert.deepEqual(calls,[]);
  await options.onProbe();
  assert.deepEqual(calls,['detect',{key:'codex',runnerId:'native'}]);
  f.listeners['soduwork-data-scope-changed']();
  await options.onProbe();
  assert.equal(calls.length,2);
});

test('authorization does not interrupt another operation on the same machine', async () => {
  const f = fixture();let opened=0;
  f.context.codex = {...base,key:'codex',loginAvailable:true};
  f.run(`_agData={machines:[{runnerId:'native',scope:'current-instance',agents:[codex]}]};_agJobs['native~codex']={state:'running',action:'install'}`);
  f.context.CodexAuthDialog = {open: async () => {opened++}};
  await f.context._agRun('native~codex','login');
  assert.equal(opened,0);
});

for (const [state, installed, label, action] of [
  ['missing', false, '没装', 'install'], ['setup', false, '待准备组件', 'install'],
  ['disabled', false, '已停用', 'install'], ['broken', false, '需要修复', 'install'],
  ['nollm', true, '还差模型', 'details'], ['unauthed', true, '还没登录', 'details'],
  ['ready', true, '可以派活', 'probe'], ['probeFailed', true, '测了没通', 'probe'],
]) test(`one presentation controls the ${state} card, detail and action`, () => {
  const f = fixture(), a = { ...base, state, installed, why: 'Specific current reason',
    warnNow: state === 'broken' ? 'Native dependency failed' : '',
    probe: { ok: true, at: 100, detail: 'Earlier success', historical: true } };
  const p = f.context._agPresentation(a);
  assert.equal(p.label, label); assert.equal(p.primaryAction, action);
  const card = f.context._agRowHtml(a, machine([a]));
  const detail = f.context._agBodyHtml(a, f.context._agState(a), 'computer~opencode');
  assert.match(card, new RegExp(label)); assert.match(detail, new RegExp(label));
  assert.doesNotMatch(card, /装得不干净/);
  assert.equal(card.includes('data-aprobe='), action === 'probe');
  assert.equal(card.includes('data-ainstall='), action === 'install');
  assert.equal(p.installed, installed);
  if (state === 'broken') assert.match(detail, /Native dependency failed/);
  if (!installed) assert.doesNotMatch(detail, /ag-probe is-ok/);
});

test('legacy partial installs and bundled setup do not produce contradictory badges', () => {
  const f = fixture();
  const broken = { ...base, present: undefined, state: 'missing', installed: false, warnNow: '启动自检失败' };
  assert.equal(f.context._agPresentation(broken).state, 'broken');
  const setup = { ...broken, key: 'harness2', name: 'Google Harness²', bundled: true,
    warnNow: 'Google Harness² 需要 OpenCode 执行组件，请点「装上」自动准备。' };
  assert.equal(f.context._agPresentation(setup).state, 'setup');
  assert.equal(f.context._agPresentation({ key: 'opencode', state: 'missing', installed: false,
    warnNow: '需要准备依赖' }).state, 'missing');
});

test('old ready probes remain compatible; current lifecycle gates dominate earlier results', () => {
  const f = fixture();
  for (const ok of [true, false]) {
    assert.equal(f.context._agState({ ...base, probe: { ok, at: 100 } }), ok ? 'ok' : 'bad');
    for (const state of ['missing', 'setup', 'disabled', 'broken', 'nollm', 'unauthed']) {
      assert.equal(f.context._agState({ ...base, state, probe: { ok, at: 100 } }), state);
    }
  }
  assert.equal(f.context._agState({ ...base, probe: { ok: true, at: 100, historical: true } }), 'ready');
  assert.equal(f.context._agState({ ...base, state: 'missing', setupState: 'broken', installed: false }), 'broken');
});

test('a completed probe belongs to its runner, version and model until those change', () => {
  const f = fixture(); f.context.agent = base;
  f.run(`_agJobs['computer~opencode'] = { action:'probe',state:'done',ok:true,
    context:_agProbeContext(agent), finishedAt:Date.now(), detail:'This test passed' };`);
  const a = { ...base, probe: { ok: false, at: 100, historical: true, detail: 'Old failure' } };
  assert.equal(f.context._agState(a, 'computer~opencode'), 'ok');
  assert.equal(f.context._agState(a, 'another~opencode'), 'ready');
  assert.equal(f.context._agState({ ...a, model: 'different' }, 'computer~opencode'), 'ready');
  assert.equal(f.context._agState({ ...a, version: 'next' }, 'computer~opencode'), 'ready');
  assert.equal(f.context._agState({ ...a, state: 'broken', installed: false }, 'computer~opencode'), 'broken');
});

test('legacy saved probes do not follow an observed model or version change', () => {
  const f = fixture(), a = { ...base, probe: { ok: true, at: 100, detail: 'Passed earlier' } };
  assert.equal(f.context._agState(a, 'computer~opencode'), 'ok');
  assert.equal(f.context._agState({ ...a, model: 'next-model' }, 'computer~opencode'), 'ready');
  assert.equal(f.context._agState({ ...a, version: 'next-version' }, 'computer~opencode'), 'ready');
  assert.equal(f.context._agState({ ...a, model: 'next-model', probe: { ...a.probe, at: 200 } }, 'computer~opencode'), 'ok');
});

test('unknown states are renderable and overview counts only complete installations', () => {
  const f = fixture(), agents = [base, { ...base, key: 'harness2', state: 'setup', installed: false },
    { ...base, key: 'broken', state: 'broken', installed: false },
    { ...base, key: 'unknown', state: 'future-state', installed: false }];
  assert.equal(f.context._agPresentation(agents[3]).state, 'unknown');
  const html = f.context._agMachineHtml(machine(agents));
  assert.match(html, /<b>1<\/b> 已装/); assert.match(html, /<b>0<\/b> 测通/);
  assert.match(html, /待重新探测/);
});

test('an older successful response cannot replace a newer detector result', async () => {
  const f = fixture(); let resolveOld;
  f.context.SoduWorkAPI.localAgentSetup = () => new Promise(resolve => { resolveOld = resolve; });
  const old = f.context._agLoad(true);
  f.context.SoduWorkAPI.localAgentSetup = async () => ({ agents: [{ ...base, state: 'broken' }], marker: 'new' });
  f.context._agRender = () => {};
  await f.context._agLoad(true); resolveOld({ agents: [base], marker: 'old' }); await old;
  assert.equal(f.run('_agData.marker'), 'new');
});

test('scope changes clear cached agents and jobs and reject late reads and job receipts', async () => {
  const f = fixture(); let resolveRead, resolveJob;
  f.context._agRender = () => {};
  f.context.local = machine([base]);
  f.run(`_agData={machines:[local]};_agLoaded.agents=true;_agJobs.old={state:'done'};`);
  f.context.SoduWorkAPI.localAgentSetup = () => new Promise(resolve => { resolveRead = resolve; });
  const read = f.context._agLoad(true);
  f.context.SoduWorkAPI.agentInstall = () => new Promise(resolve => { resolveJob = resolve; });
  const job = f.context._agRun('computer~opencode', 'install');
  f.listeners['soduwork-data-scope-changed']();
  resolveRead({ agents: [base] }); resolveJob({ jobId: 'old-account' }); await Promise.all([read, job]);
  assert.equal(f.run('_agData'), null); assert.equal(f.run('_agLoaded.agents'), false);
  assert.equal(f.run('Object.keys(_agJobs).length'), 0); assert.equal(f.run('_agTimer'), null);
});

for (const change of ['scope', 'replacement']) test(`poll results cannot escape their ${change} boundary`, async () => {
  const f = fixture(); let poll, resolve;
  f.context.setInterval = callback => { poll = callback; return 1; };
  f.context.clearInterval = () => {};
  f.context.SoduWorkAPI.agentJob = () => new Promise(done => { resolve = done; });
  let loads = 0, renders = 0;
  f.context._agLoad = async () => { loads++; }; f.context._agRender = () => { renders++; };
  f.run(`_agJobs['computer~opencode']={key:'computer~opencode',jobId:'old',state:'running',lines:[]};_agPoll()`);
  const pending = poll();
  if (change === 'scope') f.listeners['soduwork-data-scope-changed']();
  else f.run(`_agJobs['computer~opencode']={key:'computer~opencode',jobId:'new',state:'running',lines:[]}`);
  resolve({ state: 'done', ok: true, lines: ['Old job'] }); await pending;
  assert.equal(loads, 0); assert.equal(renders, 0);
  assert.equal(f.run(`_agJobs['computer~opencode']?.state`), change === 'scope' ? undefined : 'running');
});

test('stale cloud actions cannot start jobs from the local Agent surface', async () => {
  const f = fixture(), calls = [];
  f.context.local = machine([base]);
  f.context.remote = {...machine([base]),runnerId:'cloud',scope:'personal-cloud'};
  f.run("_agData={machines:[local,remote]};_agJobs['cloud~opencode']={state:'done',jobId:'previous-cloud-job'}");
  f.context._agRender = () => {}; f.context._agPoll = () => {};
  f.context.SoduWorkAPI.agentProbe = async (key, model, runner) => { calls.push([key, model, runner]); return { jobId: runner }; };
  f.context.SoduWorkAPI.agentInstall = async () => { throw Error('Hidden targets cannot be mutated'); };
  for (const action of ['probe','install','update','check','uninstall','login']) await f.context._agRun('cloud~opencode', action);
  await f.context._agRun('unknown~opencode','probe');
  await f.context._agRun('computer~opencode','probe');
  assert.deepEqual(calls, [['opencode', '', 'computer']]);
  assert.equal(f.run(`_agJobs['computer~opencode'].jobId`), 'computer');
  assert.equal(f.run(`_agJobs['cloud~opencode'].jobId`), 'previous-cloud-job');
});

test('changing a model invalidates completed probe evidence while preserving every running job', async () => {
  const f = fixture(); let onChange;
  const select = { value: 'next-model', getAttribute: () => 'opencode', addEventListener: (_name, callback) => { onChange = callback; } };
  f.context.SoduWorkAPI.setAgentModel = async () => ({}); f.context._agLoad = async () => {};
  f.run(`_agData={agents:[]};_agJobs={
    'first~opencode':{action:'install',state:'running',jobId:'install'},
    'second~opencode':{action:'probe',state:'running',jobId:'probe',context:'old'},
    'third~opencode':{action:'probe',state:'done',context:'old'},
    'fourth~opencode':{action:'uninstall',state:'done',context:'retained'}}`);
  f.context._agBind({ querySelectorAll: selector => selector === '[data-amodel]' ? [select] : [] });
  await onChange();
  assert.equal(f.run(`Object.keys(_agJobs).length`), 4);
  assert.equal(f.run(`_agJobs['first~opencode'].jobId`), 'install');
  assert.equal(f.run(`_agJobs['second~opencode'].context`), 'old');
  assert.equal(f.run(`_agJobs['third~opencode'].context`), '');
  assert.equal(f.run(`_agJobs['fourth~opencode'].context`), 'retained');
});

test('installation completes and notifies conversations after leaving Agent management', async () => {
  const f = fixture(), timers = new Map(); let id = 0, refreshes = 0;
  const classes = new Set(['show']);
  const panel = { classList: { contains: key => classes.has(key), add: key => classes.add(key), remove: key => classes.delete(key) },
    querySelector: () => null, querySelectorAll: () => [] };
  f.context.document.getElementById = key => key === 'agPanel' ? panel : key === 'agBody' ? f.body : null;
  f.context.setInterval = fn => { timers.set(++id, fn); return id; };
  f.context.clearInterval = key => timers.delete(key);
  f.context._agLoad = async force => { assert.equal(force, true); refreshes++; };
  f.run(`_agJobs['computer~opencode']={key:'computer~opencode',jobId:'live',action:'install',state:'running',lines:[]};_agPoll()`);
  assert.equal(timers.size, 1);
  const events = []; f.context.soduWorkAPI = { broadcast: kind => events.push(kind) };
  f.context.closeAgentsPanel(); assert.equal(timers.size, 1);
  f.context._agPoll(); assert.equal(timers.size, 1, 'closing does not duplicate the completion observer');
  f.context.SoduWorkAPI.agentJob = async () => ({state:'done',ok:true,lines:[]});
  await [...timers.values()][0]();
  assert.equal(f.run(`_agJobs['computer~opencode'].state`), 'done');
  assert.deepEqual(events, ['agent-runtimes-changed']);
  assert.equal(refreshes, 0, 'do not render a hidden panel');
  await [...timers.values()][0](); assert.equal(timers.size, 0, 'stop once jobs finish');
  f.context.openAgentsPanel(); f.context.openAgentsPanel(); assert.equal(timers.size, 0);
  assert.equal(refreshes, 2);
});

test('dismissing completed probe logs does not discard its verified result', async () => {
  const f = fixture(); let poll, dismiss;
  f.context.agent = base; f.context._agLoad = async () => {}; f.context._agRender = () => {};
  f.context.setInterval = fn => { poll = fn; return 1; }; f.context.clearInterval = () => {};
  f.context.SoduWorkAPI.agentJob = async () => ({state:'done',ok:true,detail:'Passed',lines:[]});
  f.run(`_agJobs['computer~opencode']={key:'computer~opencode',jobId:'p',action:'probe',state:'running',lines:[],context:_agProbeContext(agent)};_agPoll()`);
  await poll();
  f.context._agBind({querySelectorAll: selector => selector === '[data-aclose]' ? [{
    getAttribute: () => 'computer~opencode', addEventListener: (_name, callback) => { dismiss = callback; }}] : []});
  dismiss();
  assert.equal(f.context._agState({...base,probe:{ok:true,at:100,historical:true}}, 'computer~opencode'), 'ok');
});

test('version checks preserve probe evidence but newer Runner records supersede it', () => {
  const f = fixture(), now = Date.now(); f.context.agent = base;
  f.run(`_agProbeResults.set('computer~opencode',{action:'probe',state:'done',ok:true,context:_agProbeContext(agent),finishedAt:${now-120000},detail:'Older success'});
    _agJobs['computer~opencode']={action:'check',state:'done',ok:true}`);
  assert.equal(f.context._agState(base,'computer~opencode'),'ok');
  const p = f.context._agPresentation({...base,probe:{ok:false,at:(now-60000)/1000,detail:'Newer failure',historical:true}},'computer~opencode');
  assert.equal(p.state,'ready'); assert.equal(p.probe.detail,'Newer failure');
  const saved = {...base,probe:{ok:true,at:100,detail:'Older success',historical:true}};
  assert.equal(f.context._agState(saved,'computer~opencode'),'ok');
  const changed = f.context._agPresentation({...saved,probe:{...saved.probe,at:101,ok:false,detail:'Changed on Runner'}},'computer~opencode');
  assert.equal(changed.state,'ready'); assert.equal(changed.probe.detail,'Changed on Runner');
});

test('probe records use the Runner clock and bind only records from their own job', async () => {
  const f = fixture(); let poll;
  const clientNow = Date.now(), runnerNow = clientNow - 600000;
  f.context.agent = base; f.context._agLoad = async () => {}; f.context._agRender = () => {};
  f.context.setInterval = fn => { poll = fn; return 1; }; f.context.clearInterval = () => {};
  f.context.SoduWorkAPI.agentJob = async () => ({state:'done',ok:true,detail:'Passed',lines:[],
    startedAt:(runnerNow-10000)/1000, endedAt:runnerNow/1000});
  f.run(`_agJobs['computer~opencode']={key:'computer~opencode',jobId:'p',action:'probe',state:'running',lines:[],startedAt:${clientNow-10000},context:_agProbeContext(agent)};_agPoll()`);
  await poll();
  const record = at => ({...base,probe:{ok:true,at:at/1000,detail:'Passed',historical:true,
    steps:[{name:'Reply',ok:true}]}});
  assert.equal(f.context._agState(record(runnerNow-30000),'computer~opencode'),'ok');
  assert.equal(f.run(`_agJobs['computer~opencode'].recordSignature`), undefined);
  const current = f.context._agPresentation(record(runnerNow-100),'computer~opencode');
  assert.equal(current.state,'ok'); assert.equal(current.probe.steps.length,1);
  const later = f.context._agPresentation({...base,probe:{ok:false,at:(runnerNow+2000)/1000,
    detail:'Newer failure',historical:true}},'computer~opencode');
  assert.equal(later.state,'ready'); assert.equal(later.probe.detail,'Newer failure');
  f.run(`delete _agJobs['computer~opencode']`);
  assert.equal(f.context._agState({...base,probe:{ok:false,at:(runnerNow+2000)/1000,
    detail:'Newer failure',historical:true}},'computer~opencode'),'ready');
});
