'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const Requirements = require('../core/requirements.js');
const TaskSync = require('../core/task-sync.js');
const assigned = () => ({id:'assigned', title:'Assigned work', status:'todo',triageStage:'ready',readOnly:true,
  canViewExecution:true, canClaimExecution:true, myRoles:['assignee']});
function fixture(overrides = {}) {
  const calls = [], events = {}, roots = [], attachmentReads = [];
  const materialNodes = {
    '[data-material-list]': {replaceChildren(){}},
    '[data-material-status]': {textContent:''},
    'input[type=file]': {files:[], value:'', click(){}},
    '[data-material-add]': {},
  };
  const materials = {querySelector:selector => materialNodes[selector] || null};
  const window = {Requirements, addEventListener:(name, listener) => {events[name] = listener;},
    SoduWorkAPI:{getTask:async () => assigned(), listAttachments:async id => {
      attachmentReads.push(id); return [];
    }, prepareRequirementExecution:async id => {
      calls.push(['claim',id]); return {...assigned(),readOnly:false,canClaimExecution:false};
    }, ...overrides},
    RequirementsBoard:{refresh:async () => calls.push(['refresh'])},
    petSay: message => calls.push(['notice',message]),
  };
  const context = vm.createContext({window, SoduWorkAPI:window.SoduWorkAPI, tasks:[],
    document:{activeElement:null, createElement:() => {
      const node={innerHTML:'',remove(){},addEventListener(){},querySelector:selector =>
        selector === '.fwd-materials' ? materials : ({setAttribute(){},focus(){}})};
      return node;
    }, body:{appendChild:node=>roots.push(node)}},
    esc:text=>text, _svg:()=>'', _fwdSwitch:()=>calls.push(['show-assignment']),
  });
  for(const file of ['panels/chat-task-start.js','requirements/requirement-assignment.js','requirements/requirements-view.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../components',file),'utf8'),context);
  window.ChatTaskController = window.ChatTaskStart;
  return {window,calls,events,roots,attachmentReads,materialNodes,api:window.RequirementAssignment};
}

test('only explicit Hub claim capability makes a read-only assigned requirement actionable', () => {
  const f=fixture(), task=assigned();
  assert.equal(f.api.eligible(task),true);
  for(const item of [{...task,canClaimExecution:false},{...task,canViewExecution:false},
      {...task,status:'doing'},{...task,triageStage:'intake'},{...task,archivedAt:1},
      {...task,workRouting:{conversationTurn:{state:'running'}}}]) assert.equal(f.api.eligible(item),false);
  assert.equal(f.window.ChatTaskController.isPickableTask(task),false,'generic execution stays owner-only');
  assert.match(f.window.RequirementsView.actions(task,{}),/安排执行/);
  assert.doesNotMatch(f.window.RequirementsView.actions(task,{}),/接手并安排执行/);
  const projected = TaskSync.applyOperations([task], [{id:task.id,kind:'patch',data:{title:'New title'}}])[0];
  assert.equal(projected.canClaimExecution,true);
  assert.equal(Object.hasOwn(TaskSync.taskPayload(task),'canClaimExecution'),false);
});

test('explicit assignment click claims once before showing choices and never dispatches', async () => {
  const f=fixture();
  assert.equal(f.calls.length,0);
  assert.equal(await f.api.open('assigned'),true);
  assert.deepEqual(f.calls,[['claim','assigned'],['refresh'],['show-assignment']]);
  assert.equal(f.roots.length,1);
  await new Promise(done=>setImmediate(done));
  assert.deepEqual(f.attachmentReads,['assigned']);
  assert.equal(f.materialNodes['[data-material-status]'].textContent,'暂无输入材料');
});

test('denied claims remain visible and can be retried without opening execution choices', async () => {
  let count=0;
  const f=fixture({prepareRequirementExecution:async()=>{
    if (++count===1) throw Error('需求已被转交给其他人');
    return {...assigned(),readOnly:false};
  }});
  assert.equal(await f.api.open('assigned'),false);
  assert.match(f.calls[0][1],/已被转交/);
  assert.equal(f.roots.length,0);
  assert.deepEqual(f.attachmentReads,[]);
  assert.equal(await f.api.open('assigned'),true);
  assert.equal(count,2);
  assert.deepEqual(f.attachmentReads,['assigned']);
});

test('late claim response after account change cannot open a modal or refresh another account', async () => {
  let resolve;
  const f=fixture({prepareRequirementExecution:()=>new Promise(done=>{resolve=done;})});
  const opening=f.api.open('assigned');
  await new Promise(done=>setImmediate(done));
  f.events['soduwork-data-scope-changed']();
  resolve({...assigned(),readOnly:false});
  assert.equal(await opening,false);
  assert.equal(f.roots.length,0);
  assert.deepEqual(f.calls,[]);
  assert.deepEqual(f.attachmentReads,[]);
});

test('revoked claim capability from a fresh task response prevents any ownership write', async () => {
  const f=fixture({getTask:async()=>({...assigned(),canClaimExecution:false})});
  assert.equal(await f.api.open('assigned'),false);
  assert.equal(f.calls.some(row=>row[0]==='claim'),false);
  assert.equal(f.roots.length,0);
});
