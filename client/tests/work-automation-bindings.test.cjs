'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const context = {}; context.window = context;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/work-automation-bindings.js'), 'utf8'), context);
const B = context.WorkAutomationBindings;

test('activation requires an unconditional instruction outside literal content', () => {
  const quoted = [
    '工作内容是 `说明。创建后启用。`', '工作内容是 ``说明。`示例`。创建后启用。``',
    '工作内容如下：\n~~~text\n创建后启用\n~~~', '工作内容如下：\n````text\n```\n创建后启用\n````',
    '工作内容如下：\n~~~text\n创建后启用', '工作内容是“说明。创建后启用。',
    '把标题改为《说明。创建后启用。》', '> 创建后启用',
  ];
  const conditional = [
    '如果审批通过，创建后启用。', 'If approval passes, enable after creation.',
    '审批通过后，创建后启用。', '审批通过时；创建后启用。', 'Once approved, enable after saving.',
    'When approved,\nenable after creation.', '创建后启用，如果审批通过。',
    '请创建后启用？', 'enable after creation?', '例如，创建后启用。',
  ];
  for (const text of [...quoted, ...conditional]) {
    assert.equal(B.resolve({enabled: true}, text, {enabled: false}, {}).enabled, false, text);
    assert.equal(B.resolve({}, '保存为暂停状态。' + text, {enabled: true}, {}).enabled, false, text);
  }
  for (const text of ['如果审批失败，保存为暂停状态。', 'If approval fails, save as paused.']) {
    assert.equal(B.resolve({}, text, {enabled: true}, {}).enabled, true, text);
  }
  for (const text of ['创建后启用。', '保存为暂停状态。Please enable after saving.',
    '工作内容是“如果通过再执行”。创建后启用。']) {
    assert.equal(B.resolve({}, text, {enabled: false}, {}).enabled, true, text);
  }
});

test('explicit activation directives preserve pause intent and ignore task content', () => {
  const resolve = (text, enabled, raw = {}) => B.resolve(raw, text, {enabled}, {});
  const request = '创建测试自动化，名称 AUTO-1110，每天北京时间 23:55 执行，工作内容是“只回复 AUTO-1110-OK”。保存为暂停状态，不立即运行。';
  assert.equal(resolve(request, true, {enabled: true}).enabled, false);
  for (const text of ['暂不启用', '创建后不启用', '保存后不要启用', 'Please save as paused.']) {
    assert.equal(resolve(text, true).enabled, false, text);
  }
  assert.equal(resolve('创建后启用', false).enabled, true);
  for (const text of ['不立即运行', '如果保存为暂停状态会怎样', '不要保存为暂停状态',
    '工作内容是“保存为暂停状态”。', '工作内容是“示例。创建后启用”。',
    '名称改为「保存为暂停状态」', '每天23:55执行']) {
    assert.equal(resolve(text, true).enabled, true, text);
    assert.equal(resolve(text, false, {enabled: true}).enabled, false, text);
  }
});
const catalogs = {
  methods:[{key:'games',name:'小游戏'},{key:'report',name:'报表'}],
  repos:[{id:'game-repo',name:'游戏工程',projectId:'game-project'},{id:'report-repo',name:'报表'}],
  agents:[{id:'local:pi',name:'Pi'},{id:'local:codex',name:'Codex'}],
};
const prior = { personalPluginKey:'report',repoId:'report-repo',assigneeId:'local:pi',
  pluginInputs:{format:'csv'},flow:true,every:'daily',bindingIssues:[] };
const run = (text, raw = {}, previous = prior, choices = catalogs) => B.resolve(raw, text, previous, choices);
for (const text of ['使用小游戏插件', '请使用「小游戏」插件开发纸牌', '工作方法选择小游戏']) {
  test('explicit method resolves: ' + text, () => {
    const result = run(text); assert.equal(result.personalPluginKey,'games');
    assert.deepEqual(Object.keys(result.pluginInputs), []);
    assert.equal(result.repoId,prior.repoId);
  });
}
test('explicit engineering repo and substrate use current IDs', () => {
  const result = run('每天12点，在游戏工程开发纸牌，由Codex执行');
  assert.equal(result.repoId,'game-repo'); assert.equal(result.assigneeId,'local:codex');
});
for (const text of ['对比小游戏插件和报表插件的文档', '不要使用小游戏插件', '如果使用小游戏插件会怎样',
  '请使用插件生成一个工程文档', '#1 写作文 /login 返回首页']) {
  test('non-binding prose is preserved: ' + text, () => {
    const result = run(text);
    assert.equal(result.personalPluginKey,'report'); assert.equal(result.repoId,'report-repo');
    assert.equal(result.bindingIssues.length,0);
  });
}
test('clear is distinct from omitted and resets only dependent method inputs', () => {
  const result = run('不用插件，不关联工程');
  assert.equal(result.personalPluginKey,''); assert.equal(result.repoId,''); assert.equal(result.flow,false);
  assert.equal(run('输出增加CSV',{},result).personalPluginKey,'');
  assert.equal(run('输出增加CSV',{},result).repoId,'');
});
test('same method refinement keeps user supplied inputs', () => {
  assert.equal(run('继续使用报表插件').pluginInputs.format,'csv');
});
test('unknown name blocks preflight and persists through unrelated refinement', () => {
  const first = run('使用不存在插件');
  assert.equal(first.personalPluginKey,''); assert.match(B.validate(first,catalogs), /不存在/);
  assert.match(B.validate(run('每天9点运行',{},first),catalogs), /不存在/);
  assert.equal(B.validate(run('改用小游戏插件',{},first),catalogs),'');
});
test('duplicate names cannot be disambiguated by a model supplied ID', () => {
  const text = '使用小游戏插件';
  const c = {...catalogs, methods:[...catalogs.methods,{key:'other',name:'小游戏'}]};
  const result = run(text,{automationBindings:{method:{action:'select',id:'games',name:'小游戏',evidence:text}}},prior,c);
  assert.equal(result.personalPluginKey,''); assert.match(B.validate(result,c), /不唯一/);
});
test('multiple explicitly requested methods must be resolved by user', () => {
  const result = run('使用小游戏插件，使用报表插件');
  assert.match(B.validate(result,catalogs), /多个指定/);
});
test('model cannot invent bindings or override unrelated manual choices', () => {
  const result = run('只增加CSV输出', {repoId:'game-repo',personalPluginKey:'games',
    automationBindings:{method:{action:'select',id:'games',name:'小游戏',evidence:'使用小游戏插件'}}});
  assert.equal(result.personalPluginKey,'report'); assert.equal(result.repoId,'report-repo');
});
test('model abbreviation is accepted only for the unique matching catalog row', () => {
  const text = '使用小游戏插件';
  const raw = {automationBindings:{method:{action:'select',name:'小游戏',id:'games',evidence:text}}};
  const c = {...catalogs,methods:[{key:'games',name:'小游戏创作'}]};
  assert.equal(run(text,raw,prior,c).personalPluginKey,'games');
  assert.equal(run(text,raw,prior,{...c,methods:[...c.methods,{key:'second',name:'小游戏工具'}]}).personalPluginKey,'');
});
test('missing preserved references fail closed', () => {
  for (const field of ['personalPluginKey','repoId','assigneeId']) {
    assert.ok(B.validate({...prior,[field]:'deleted'},catalogs));
  }
});
test('binding resolution preserves a one-off reservation and its selected method', () => {
  const result = run('今天中午12点使用小游戏插件', {}, {...prior,every:'once',runAt:'2026-10-15T04:00:00Z'});
  assert.equal(result.every,'once'); assert.equal(result.runAt,'2026-10-15T04:00:00Z');
  assert.equal(result.personalPluginKey,'games'); assert.equal(B.validate(result,catalogs),'');
});

test('UI binding context uses actual IDs and never folder/sidebar IDs', () => {
  const result = B.fromContext({}, {repoId:'game-repo',personalPluginKey:'games',adapterId:'codex',cwd:'D:/demo',sidebarProjectId:'wrong'}, catalogs);
  assert.equal(result.repoId,'game-repo'); assert.equal(result.assigneeId,'local:codex');
  assert.equal(B.fromContext({}, {cwd:'D:/demo',sidebarProjectId:'wrong'},catalogs).repoId,undefined);
  assert.equal(B.fromContext({repoId:''}, {repoId:'game-repo'},catalogs).repoId,'');
});
test('project context resolves only one real associated repo', () => {
  assert.equal(B.fromContext({}, {projectId:'game-project'},catalogs).repoId,'game-repo');
  const result = B.fromContext({}, {projectId:'game-project'}, {...catalogs,repos:[]});
  assert.match(B.validate(result,catalogs), /没有唯一关联工程/);
});
test('parsing receives catalog names and IDs but no local paths, secrets or versions', () => {
  const opts = B.candidates({...catalogs,methods:[{key:'games',name:'小游戏',root:'private',token:'secret',version:'9'}]},'需求');
  assert.deepEqual(Object.keys(opts.candidates.methods[0]),['id','name']);
  assert.equal(opts.instruction,'需求'); assert.equal(opts.kind,'automation');
});
test('refinement keeps the entire saved contract and long supplemental instruction', () => {
  const note = '需求'.repeat(3000)+'END_NOTE', change = '补充'.repeat(2000)+'END_CHANGE';
  const prompt = B.refinePrompt({note,acceptance:['A']},change);
  assert.ok(prompt.includes(note)); assert.ok(prompt.includes(change));
});
test('same catalog name across categories does not bind a different field', () => {
  const c = {methods:[{key:'pi-plugin',name:'Pi'}],repos:[{id:'pi-repo',name:'Pi'}],agents:[{id:'pi-agent',name:'Pi'}]};
  const result = run('使用Pi插件',{}, {repoId:'',assigneeId:'other'},c);
  assert.equal(result.personalPluginKey,'pi-plugin');
  assert.equal(result.repoId,'');assert.equal(result.assigneeId,'other');
});
test('cropped model evidence cannot convert a conditional or negative clause to a command', () => {
  for (const text of ['如果需要使用小游戏插件再通知我','不要使用小游戏插件','不想使用小游戏插件']) {
    const result = run(text,{automationBindings:{method:{action:'select',id:'games',name:'小游戏',evidence:'使用小游戏插件'}}});
    assert.equal(result.personalPluginKey,'report');
  }
});
test('English explicit plugin instructions use the same grounded binding path', () => {
  const c = {...catalogs,methods:[{key:'mini-game',name:'Mini game'}]};
  const text = 'Use Mini game plugin';
  const result = run(text,{automationBindings:{method:{action:'select',id:'mini-game',name:'Mini game',evidence:text}}},prior,c);
  assert.equal(result.personalPluginKey,'mini-game');
});
test('monthly schedules remain monthly and do not create an unsupported binding issue', () => {
  const result = run('每月一号生成报告');
  assert.equal(result.every,'monthly');
  assert.doesNotMatch(B.validate(result,catalogs), /月度|支持/);
});
test('hypothetical clearing does not erase existing method or repo', () => {
  for (const text of ['如果不用插件会怎样','如果不关联工程会怎样','if no plugin is available, compare the results']) {
    const result = run(text,{automationBindings:{method:{action:'clear',id:'',name:'',evidence:'不用插件'}}});
    assert.equal(result.personalPluginKey,'report');assert.equal(result.repoId,'report-repo');
  }
});
test('a project name resolves only when its visible engineering repo is unique', () => {
  const c = {...catalogs,repos:[{id:'repo-a',name:'source',projectName:'SoduWork'}]};
  assert.equal(run('在SoduWork项目开发',{},prior,c).repoId,'repo-a');
  c.repos.push({id:'repo-b',name:'service',projectName:'SoduWork'});
  assert.match(B.validate(run('在SoduWork项目开发',{},prior,c),c),/不唯一/);
});
test('literal text edits are not binding changes', () => {
  for (const text of ['把标题改为“不用插件”','执行说明增加“使用小游戏插件”','set title to "no plugin"',
    '把标题改为“纸牌开发，使用小游戏插件”','执行说明增加“开发步骤：查看需求，使用小游戏插件”',
    '把备注改为“第一条，不关联工程”']) {
    const result = run(text,{automationBindings:{method:{action:'clear',id:'',name:'',evidence:'不用插件'}}});
    assert.equal(result.personalPluginKey,'report'); assert.equal(result.pluginInputs.format,'csv');assert.equal(result.repoId,'report-repo');
  }
  assert.equal(run('把标题改为“纸牌开发，使用小游戏插件”，改用小游戏插件').personalPluginKey,'games');
});
