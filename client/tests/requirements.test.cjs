const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../core/requirements.js');
const Sync = require('../core/task-sync.js');

test('unclaimed repository issues appear in related and actionable scopes without execution rights', () => {
  const task = {id: 'issue', status: 'todo', triageStage: 'ready', myRoles: ['repository_member'],
    canClaim: true, readOnly: true, canViewExecution: false};
  assert.equal(R.inScope(task, 'related'), true);
  assert.equal(R.inScope(task, 'actionable'), true);
  assert.equal(R.inScope(task, 'created'), false);
  assert.equal(R.owner(task).name, '待认领');
  assert.match(R.nextStep(task).text, /认领/);
  assert.equal(R.actionable({...task, canClaim: false}), false);
  for (const triageStage of ['intake', 'clarifying']) {
    const collected = {...task, triageStage};
    assert.equal(R.column(collected), 'intake');
    assert.equal(R.inScope(collected, 'actionable'), true);
    assert.match(R.nextStep(collected).text, /认领后自动移到待开始，可安排执行/);
    assert.equal(R.nextStep(collected).action, '查看并认领');
  }
});

test('preparation stages never expose an execution conversation and assigned devices get an explicit claim action', () => {
  for (const triageStage of ['intake', 'clarifying', 'ready']) {
    assert.equal(R.canOpenConversation({status:'todo', triageStage, canViewExecution:true}, 'local'), false);
  }
  const transferred = {status:'todo',triageStage:'ready',readOnly:true,canViewExecution:true,canClaimExecution:true};
  assert.equal(R.nextStep(transferred).action, '安排执行');
  assert.equal(R.nextStep({...transferred,canClaimExecution:false}).text, '等待负责人安排执行');
});

test('only unexecuted requirements submit definition changes', () => {
  const task = { status:'doing', title:'Before', note:'Original', priority:'normal', kind:'requirement',
    acceptanceCriteria:['Complete'], canEditRequirement:true };
  assert.deepEqual(R.editPatch(task, {title:'After',note:'Original',priority:'normal',kind:'bug',
    acceptanceCriteria:['Changed'],triageStage:'intake'}), {});
  assert.deepEqual(R.editPatch({...task,status:'todo'}, {acceptanceCriteria:['Changed']}), {acceptanceCriteria:['Changed']});
  assert.deepEqual(R.editPatch({...task,readOnly:true}, {title:'After',note:'Changed',priority:'high',visibility:'organization'}), {});
  assert.deepEqual(R.editPatch({...task,readOnly:true,status:'todo'}, {title:'After'}), {title:'After'});
});

test('execution facts lock definition editing without disabling delivery capabilities', () => {
  const task = {status:'todo',canEditRequirement:true,canSubmitReview:true,canManageRequirementMaterials:true};
  for (const fields of [{status:'doing'}, {status:'paused'}, {status:'done'}, {status:'cancel'},
    {requirementStage:'reviewing'}, {archivedAt:1}, {actualStart:1}, {reviewedAt:1},
    {hasExecutionHistory:true}, {requirementEditBlocked:true}, {maintenanceBlocked:true},
    {ai:{state:'running'}}, {ai:{state:'done'}}, {workRouting:{conversationTurn:{state:'done'}}}]) {
    const item = {...task,...fields};
    assert.equal(R.canEdit(item), false, JSON.stringify(fields));
    assert.deepEqual(R.editPatch(item,{title:'Changed',tags:['changed'],visibility:'organization'}), {});
    assert.equal(R.canManageMaterials(item), true);
    assert.equal(R.canSubmitReview(item), fields.status === 'doing');
  }
  assert.equal(R.canEdit({...task,ai:{state:'failed'},hasExecutionHistory:false}), true, 'failed preflight alone is not execution');
  assert.equal(R.canEdit({...task,canEditRequirement:false}), false);
  assert.equal(R.canOpenConversation({...task,status:'done',myRoles:['assignee']},'local'), false);
  assert.equal(R.canOpenConversation({...task,status:'doing',requirementStage:'reviewing'},'local'), false);
});

test('manual review submission requires an idle executor in the delivering stage', () => {
  const task = {status:'doing',requirementStage:'delivering',canSubmitReview:true};
  assert.equal(R.canSubmitReview(task),true);
  for (const fields of [{canSubmitReview:false},{canSubmitReview:undefined},{status:'todo'},
    {status:'paused'},{status:'done'},{requirementStage:'reviewing'},{archivedAt:1},
    {maintenanceBlocked:true},{ai:{state:'running'}},{ai:{state:'dispatching'}},
    ...['queued','starting','running','waiting'].map(state=>({workRouting:{conversationTurn:{state}}}))]) {
    assert.equal(R.canSubmitReview({...task,...fields}),false,JSON.stringify(fields));
  }
  for (const state of ['completed','failed','stopped']) {
    assert.equal(R.canSubmitReview({...task,workRouting:{conversationTurn:{state}}}),true);
  }
});

test('executor follow-up remains actionable after delivery and rework completion', () => {
  const task = {status:'doing',requirementStage:'delivering',myRoles:['executor'],ai:{state:'done'},
    workRouting:{conversationTurn:{state:'completed'}},canSubmitReview:true};
  assert.equal(R.inScope(task,'actionable'),true);
  assert.match(R.nextStep(task).text,/提交验收/);
  const rework = {...task,canSubmitReview:false,canContinueExecution:true,
    workRouting:{...task.workRouting,reworkPending:{feedback:'Revise'}}};
  assert.equal(R.inScope(rework,'actionable'),true);
  assert.equal(R.nextStep(rework).action,'继续修正');
  for (const fields of [{canSubmitReview:false,canContinueExecution:false,myRoles:['creator']},
    {canViewExecution:false},{status:'done',reviewedAt:1},{archivedAt:1},
    {ai:{state:'running'}},{workRouting:{conversationTurn:{state:'waiting'}}}]) {
    assert.equal(R.inScope({...task,...fields},'actionable'),false,JSON.stringify(fields));
  }
  assert.equal(R.inScope({...rework,canContinueExecution:false,myRoles:['creator']},'actionable'),false);
});

test('requirements support human assignment and exact tag filtering', () => {
  const task = {id:'tagged', status:'todo', triageStage:'ready', canEditRequirement:true,
    assigneeUserId:'member-1', tags:['growth', 'quarter'], myRoles:['creator']};
  assert.deepEqual(R.editPatch(task, {assigneeUserId:'member-2', tags:['design']}),
    {tags:['design'], assigneeUserId:'member-2'});
  assert.deepEqual(R.select([task, {...task, id:'other', tags:['design']}],
    {scope:'all', archive:'active', tag:'growth'}).map(row => row.id), ['tagged']);
  assert.equal(R.viewSettings({tag:'growth'}).tag, 'growth');
});
test('existing tasks keep their execution facts across six requirement lanes', () => {
  for (const [task, expected] of [
    [{status:'todo'},'ready'], [{status:'todo',triageStage:'intake'},'intake'],
    [{status:'todo',triageStage:'clarifying'},'clarifying'], [{status:'doing',triageStage:'intake'},'delivering'],
    [{status:'done',requirementStage:'ready'},'reviewing'], [{status:'cancel'},'closed'],
    [{status:'done',archivedAt:1},'closed'], [{status:'done',archivedAt:null},'reviewing'],
    [{status:'done',reviewedAt:1},'delivered'],
  ]) assert.equal(R.stage(task), expected, JSON.stringify(task));
});
test('shared visibility never makes a requirement actionable for an unrelated viewer', () => {
  const task = {status:'todo',readOnly:true,visibility:'organization',myRoles:[]};
  assert.equal(R.inScope(task,'all'),true);
  for (const scope of ['actionable','created','related']) assert.equal(R.inScope(task,scope),false);
  assert.equal(R.inScope({...task,myRoles:['requester']},'created'),true);
  assert.equal(R.inScope({...task,myRoles:['assignee']},'actionable'),true);
  assert.equal(R.inScope({...task,status:'done',myRoles:['assignee']},'actionable'),false);
});
test('dragging only prepares work; completion and executing are never client-synthesized', () => {
  const editable = {status:'todo',canEditRequirement:true,requirementVersion:8};
  assert.deepEqual(R.stagePatch(editable,'clarifying'),{triageStage:'clarifying',requirementVersion:8});
  for (const target of ['delivering','delivered','closed','done']) assert.equal(R.stagePatch(editable,target),null);
  for (const source of [{...editable,status:'doing'}, {...editable,archivedAt:2}, {...editable,canEditRequirement:false}]) {
    assert.equal(R.stagePatch(source,'ready'),null);
  }
});
test('filters combine scope, type, title/details/project and stable priority ordering without mutations', () => {
  const data = [
    {id:'a',title:'账单',note:'处理合同',status:'todo',kind:'bug',priority:'normal',myRoles:['creator']},
    {id:'b',title:'账单修复',status:'todo',kind:'bug',priority:'high',myRoles:['creator']},
    {id:'c',title:'账单报表',status:'doing',kind:'requirement',priority:'critical',myRoles:['executor']},
  ];
  const snapshot = JSON.stringify(data);
  assert.deepEqual(R.select(data,{scope:'created',kind:'bug',q:'账单'}).map(x=>x.id),['b','a']);
  assert.deepEqual(R.select(data,{q:'合同'}).map(x=>x.id),['a']);
  assert.deepEqual(R.select(data,{q:'no results'}),[]);
  assert.equal(JSON.stringify(data),snapshot);
});

test('archive filter separates historical work without hiding completed active requirements', () => {
  const data = [
    {id:'ready',status:'todo',myRoles:['creator']},
    {id:'done',status:'done',myRoles:['creator']},
    {id:'archived',status:'done',archivedAt:42,myRoles:['creator']},
    {id:'cancelled',status:'cancel',myRoles:['creator']},
    {id:'shared-history',status:'done',archivedAt:7,myRoles:[]},
  ];
  const snapshot = JSON.stringify(data);
  assert.deepEqual(R.select(data,{archive:'active'}).map(x=>x.id).sort(),['done','ready']);
  assert.deepEqual(R.select(data,{archive:'archived'}).map(x=>x.id).sort(),['archived','cancelled','shared-history']);
  assert.deepEqual(R.select(data,{archive:'archived',scope:'related'}).map(x=>x.id).sort(),['archived','cancelled']);
  assert.equal(R.select(data,{}).length,5,'existing callers without an archive filter retain their full projection');
  assert.equal(JSON.stringify(data),snapshot);
});
test('offline creation retains requirement fields but never writes server-derived sharing or execution permission', () => {
  const payload = Sync.taskPayload({title:'需求',kind:'bug',acceptanceCriteria:['one','two'],triageStage:'intake',
    visibility:'organization',sharedOrgId:'forged',requirementStage:'delivered',canViewExecution:true});
  assert.deepEqual(payload.acceptanceCriteria,['one','two']);
  assert.equal(payload.visibility,'organization');
  for (const key of ['sharedOrgId','requirementStage','canViewExecution']) assert.equal(key in payload,false);
});

test('server created timestamps sort newest first, including safe shared projections', () => {
  assert.deepEqual(R.select([{id:'a',created:1000},{id:'b',created:2000}],{}).map(row=>row.id),['b','a']);
});

test('migrated requirement content is separate from private execution notes in read and edit', () => {
  const task={id:'merged',status:'todo',title:'Private title',note:'private transcript',
    requirementContent:{title:'Shared request',note:'Public background'},canEditRequirement:true};
  assert.equal(R.content(task).title,'Shared request');
  assert.deepEqual(R.editPatch(task,{title:'Shared request',note:'Public background'}),{});
  assert.deepEqual(R.editPatch(task,{note:'Changed request'}),{note:'Changed request'});
  assert.equal(R.select([task],{q:'private transcript'}).length,0);
  assert.equal(R.select([task],{q:'Public background'}).length,1);
  assert.equal(task.note,'private transcript');
});

test('human attention distinguishes assigned work, running agents, returned results and real approvals', () => {
  const task = {id:'work',status:'doing',myRoles:['executor','assignee'],canViewExecution:true};
  assert.equal(R.actionable(task),true,'the responsible person can still see their manual work');
  for (const state of ['running','dispatching','done']) {
    assert.equal(R.actionable({...task,ai:{state,name:'Pi'}}),false,state);
  }
  assert.equal(R.actionable({...task,ai:{state:'failed'}}),true);
  assert.equal(R.actionable({...task,ai:{state:'dispatching',attentionRaised:true}}),true);
  const ctx={approvals:new Map([['work',{id:'review-1',taskId:'work',action:'review'}]])};
  const requester={...task,myRoles:['requester'],ai:{state:'done'}};
  assert.equal(R.actionable(requester),false,'a role alone does not grant review permission');
  assert.equal(R.actionable(requester,ctx),false,'an executor/requester cannot approve delivery review');
  assert.equal(R.nextStep(requester,ctx).text,'等待需求创建人确认交付');
  const creator={...task,myRoles:['creator'],ai:{state:'done'}};
  assert.equal(R.actionable(creator,ctx),true,'the requirement creator can approve delivery review');
  assert.equal(R.stage(requester),'delivering','agent completion is not business completion');
  assert.equal(R.actionable({...task,status:'done',myRoles:['executor','assignee']},ctx),false,'completed work waits for the creator review');
  assert.equal(R.actionable({...task,archivedAt:1},ctx),false);
  assert.equal(R.actionable({...task,canViewExecution:false}),false,'shared source roles do not grant execution access');
});

test('personal review capability keeps a pending delivery actionable before the inbox refreshes', () => {
  const task = {id:'reviewing',status:'doing',requirementStage:'reviewing',
    myRoles:['creator'],canReview:true,ai:{state:'done'},canViewExecution:true};
  assert.equal(R.actionable(task),true);
  assert.equal(R.actionable({...task,canReview:false}),false);
  assert.equal(R.actionable({...task,canReview:undefined}),false);
  assert.equal(R.actionable({...task,status:'done',reviewedAt:1,canReview:false}),false);
  assert.equal(R.actionable({...task,archivedAt:1}),false);
});

test('cards identify the actual assignee and provide permission-aware next steps', () => {
  assert.deepEqual(R.owner({createdByName:'提出者'}),{name:'待安排',kind:'unassigned'});
  assert.deepEqual(R.owner({assigneeName:'同事',ai:{state:'running',name:'Pi'}}),{name:'Pi',kind:'agent'});
  assert.equal(R.nextStep({status:'doing',ai:{state:'running'}}).text,'AI 正在执行，可查看进展');
  assert.equal(R.nextStep({status:'doing',ai:{state:'done'}}).text,'成果已返回，待确认');
  assert.equal(R.nextStep({status:'todo',readOnly:true}).text,'等待负责人安排执行');
  assert.notEqual(R.nextStep({status:'todo',canViewExecution:false}).action,'安排执行');
  assert.equal(R.nextStep({status:'done',archivedAt:1}).action,'查看记录');
});

test('board columns separate collection from verified review and never turn a receipt into completion', () => {
  assert.deepEqual(R.columns.filter(([key])=>key!=='closed').map(([key])=>key),['intake','ready','delivering','reviewing','delivered']);
  assert.equal(R.column({status:'todo',triageStage:'clarifying'}),'intake');
  assert.equal(R.stage({status:'doing',requirementStage:'reviewing'}),'reviewing');
  assert.equal(R.stage({status:'done',requirementStage:'reviewing'}),'reviewing','marking done submits for review, it is not acceptance');
  assert.equal(R.stage({status:'done',requirementStage:'reviewing',reviewedAt:1}),'delivered');
  assert.equal(R.stage({status:'doing',requirementStage:'reviewing',archivedAt:5}),'closed');
  assert.equal(R.stage({status:'doing',ai:{state:'done'}}),'delivering');
  assert.equal(R.canTriage({status:'todo',canEditRequirement:true,requirementStage:'reviewing'}),false);
  for(const state of ['running','dispatching','done']) assert.equal(R.canTriage({status:'todo',canEditRequirement:true,ai:{state}}),false);
  for(const state of ['queued','running','starting','waiting']) {
    const task={status:'todo',canEditRequirement:true,workRouting:{conversationTurn:{state}}};
    assert.equal(R.canTriage(task),false,state);assert.equal(R.stagePatch(task,'intake'),null,state);
  }
  const finished = {status:'todo',canEditRequirement:true,workRouting:{conversationTurn:{state:'done'}}};
  assert.equal(R.canTriage(finished),false);
  assert.equal(R.stagePatch(finished,'intake'),null);
  assert.equal(R.canTriage({status:'todo',canEditRequirement:true}),true);
});

test('combined filters use responsible people, exact project identity and open-work deadlines', () => {
  const today = new Date(2026,9,3,12).getTime();
  const a = {id:'a',status:'todo',triageStage:'clarifying',priority:'high',kind:'bug',projectId:'p1',assigneeUserId:'u1',due:'2026-10-02'};
  const data = [a,{...a,id:'b',status:'done'},{...a,id:'c',due:'2026-10-04'}, {...a,id:'d',assigneeUserId:'u2',ai:{name:'u1',state:'failed'}},
    {id:'none',status:'todo'}, {id:'review',status:'doing',requirementStage:'reviewing',due:'2026-10-03'}];
  const ctx={now:today,approvals:new Map([['review',{id:'approval'}]])};
  const filter={scope:'all',project:'p1',owner:'u1',kind:'bug',priority:'high',phase:'intake',due:'overdue',attention:'clarifying'};
  assert.deepEqual(R.select(data,filter,ctx).map(t=>t.id),['a']);
  assert.deepEqual(R.select(data,{owner:'__none',project:'__none',due:'none'},ctx).map(t=>t.id),['none']);
  assert.deepEqual(R.select(data,{due:'today'},ctx).map(t=>t.id),['review']);
  assert.deepEqual(R.select(data,{due:'week'},ctx).map(t=>t.id).sort(),['c','review']);
  assert.deepEqual(R.select(data,{attention:'blocked'},ctx).map(t=>t.id),['d']);
  assert.deepEqual(R.select(data,{attention:'approval'},ctx).map(t=>t.id),['review']);
  assert.equal(R.overdue({...a,status:'done'},today),false);
});

test('sort options have stable tie breakers, actual updated dates and undated work last', () => {
  const data=[{id:'c',priority:'high',created:3,updatedAt:4},{id:'b',priority:'normal',created:1,updatedAt:9,due:'2026-10-03'},
    {id:'a',priority:'normal',created:2,updatedAt:9,due:'2026-10-01'}];
  assert.deepEqual(R.select(data,{sort:'updated'}).map(t=>t.id),['a','b','c']);
  assert.deepEqual(R.select(data,{sort:'created'}).map(t=>t.id),['c','a','b']);
  assert.deepEqual(R.select(data,{sort:'due'}).map(t=>t.id),['a','b','c']);
  assert.deepEqual(R.select(data,{sort:'priority'}).map(t=>t.id),['c','a','b']);
});

test('stored view settings are allowlisted and never persist query text, payloads or operation state', () => {
  const out=R.viewSettings({view:'list',group:'project',scope:'all',project:'p',priority:'high',q:'private words',busy:true,drag:'id',sort:'due',unknown:'payload'});
  assert.equal(out.view,'list');assert.equal(out.project,'p');assert.equal(out.q,'');assert.equal(out.sort,'due');
  assert.equal('busy' in out,false);assert.equal('drag' in out,false);assert.equal('unknown' in out,false);
  assert.deepEqual(R.viewSettings({view:'evil',group:'x',scope:'x',sort:'evil'}),R.defaults);
  assert.deepEqual(R.viewSettings(null),R.defaults);
});

test('deadline forms send Hub milliseconds and editing other fields preserves an existing deadline time', () => {
  const date=new Date(2026,9,10,14,30).getTime();
  const task={status:'todo',due:date,title:'before',canEditRequirement:true};
  assert.deepEqual(R.editPatch(task,{due:'2026-10-10',title:'after'}),{title:'after'});
  assert.deepEqual(R.editPatch(task,{due:'2026-10-12'}),{due:new Date(2026,9,12).getTime()});
  assert.deepEqual(R.editPatch(task,{due:''}),{due:null});
  assert.deepEqual(R.editPatch({...task,status:'doing'},{title:'after',due:'2026-10-12'}),{});
  assert.equal(R.dateTimestamp(date),date);assert.equal(R.dateTimestamp('2026-99-99'),null);
  assert.equal(Sync.taskPayload({due:R.dateTimestamp('2026-10-12')}).due,new Date(2026,9,12).getTime());
  assert.deepEqual(R.editPatch({...task,readOnly:true,canViewExecution:false},{title:'shared title',due:'2026-10-12'}),{title:'shared title'});
});

test('both production desktop entries load requirement presentation before the controller', () => {
  const fs=require('node:fs'),path=require('node:path');
  for(const file of ['desk.html','index.html']) {
    const html=fs.readFileSync(path.join(__dirname,'..',file),'utf8');
    const paths=['core/requirements.js','components/requirements/requirements-view.js','components/requirements/requirements-board.js'];
    const positions=paths.map(script=>html.indexOf('src="'+script+'"'));
    assert.ok(positions.every(n=>n>=0),file+' must load every dependency');
    assert.ok(positions[0]<positions[1]&&positions[1]<positions[2],file+' must load scripts in dependency order');
    assert.ok(html.includes('src="components/requirements/requirement-confirm.js"'),file+' must load application confirmation');
    assert.ok(html.includes('href="components/requirements/requirement-confirm.css"'),file+' must load confirmation theme');
  }
});

test('approval-only participation is related and actionable; approval attention sorts first', () => {
  const ctx={approvals:new Map([['b',{taskId:'b',id:'pending',action:'deploy'}]])};
  const tasks=[{id:'a',status:'todo',priority:'critical',myRoles:['assignee']},
    {id:'b',status:'done',priority:'normal',myRoles:[]}];
  assert.deepEqual(R.select(tasks,{scope:'related'},ctx).map(t=>t.id),['b','a']);
  assert.deepEqual(R.select(tasks,{scope:'actionable'},ctx).map(t=>t.id),['b','a']);
  assert.equal(R.inScope(tasks[1],'related'),false);
  assert.equal(R.select([{id:'agent',ai:{name:'Pi'}}],{q:'Pi'}).length,1);
});

test('stale board snapshot never blocks stage moves: decision follows the server truth', () => {
  // Artifact collection can make a board snapshot stale before review submission.
  // Reevaluate against the latest server state while retaining authoritative transition checks.
  const moveAction = (task, next) => {
    if (task.canEditRequirement !== true) return '';
    const s = R.stage(task);
    if (s === 'delivering' && next === 'reviewing') return 'submit-review';
    if (s === 'reviewing' && next === 'delivered') return 'review';
    return R.stagePatch(task, next) ? 'triage' : '';
  };
  const doing = {id:'t', status:'doing', canEditRequirement:true, requirementVersion:6};
  // Execute valid progress actions from refreshed snapshots.
  assert.deepEqual(R.resolveStageMove(doing, {...doing, requirementVersion:7}, 'reviewing', moveAction),
    {action:'submit-review', patch:null});
  // Refresh silently when the server already reached the target state.
  assert.deepEqual(R.resolveStageMove(doing, {...doing, status:'done'}, 'reviewing', moveAction),
    {settled:true});
  // Explain and refresh invalid transitions without sending them.
  assert.deepEqual(R.resolveStageMove(doing, {...doing, status:'done', reviewedAt:1}, 'reviewing', moveAction),
    {blocked:true});
  // Include the latest version in triage patches for server optimistic locking.
  const todo = {id:'t2', status:'todo', triageStage:'intake', canEditRequirement:true, requirementVersion:3};
  assert.deepEqual(R.resolveStageMove(todo, {...todo, requirementVersion:4}, 'clarifying', moveAction),
    {action:'triage', patch:{triageStage:'clarifying', requirementVersion:4}});
});

test('GitHub claim guidance names the current team while GitLab keeps repository membership', () => {
  for (const provider of ['github', 'gitlab']) {
    const task = {status: 'todo', triageStage: 'intake', canClaim: true, repositoryIssue: {provider}};
    assert.match(R.nextStep(task).text, provider === 'github' ? /当前团队成员可认领/ : /仓库成员可认领/);
    assert.match(R.nextStep(task).text, /认领后自动移到待开始/);
    assert.equal(R.column(task), 'intake');
  }
  assert.match(R.nextStep({status: 'todo', canClaim: true, origin: 'github_issue'}).text, /当前团队成员可认领/);
});
