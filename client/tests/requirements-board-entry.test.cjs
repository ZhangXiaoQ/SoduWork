'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Requirements = require('../core/requirements.js');

function fixture(saved, clock) {
  class Node {
    constructor() {
      this.children = new Map(); this.classes = new Set(); this.scrollTop = 0; this.dataset = {};
      this.listeners = new Map();
      this.classList = { contains: name => this.classes.has(name), add: name => this.classes.add(name), remove: name => this.classes.delete(name),
        toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name) };
    }
    querySelector(selector) {
      if (!this.children.has(selector)) this.children.set(selector, new Node());
      return this.children.get(selector);
    }
    querySelectorAll() { return []; }
    matches() { return false; }
    contains() { return false; }
    setAttribute() {}
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    dispatchEvent(event) { this.listeners.get(event.type)?.(event); }
  }
  const root = new Node(), rendered = [], stored = new Map([['account:requirement-view', JSON.stringify(saved)]]);
  let mounted = !clock;
  const context = { Requirements,
    RequirementsView: { labels: {phase: '', kind: '', priority: '', project: '', owner: '', tag: '', due: '', attention: ''},
      icon: () => '', chips: () => '', options: () => '', board: (rows, state) => { rendered.push({ids: rows.map(row => row.id), state: {...state}}); return ''; } },
    document: {
      getElementById: id => id === 'historyBoard' && mounted ? root : null,
      createElement: () => root,
      body: { appendChild() { mounted = true; } },
      activeElement: null,
    },
    localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    SoduWorkAPI: { taskStorageKey: () => 'account' }, Store: {taskState: 'ready'},
    tasks: [
      {id: 'review', status: 'done', title: '待验收需求', kind: 'requirement', myRoles: ['creator']},
      {id: 'running', status: 'doing', title: '进行中的需求', myRoles: ['creator', 'executor']},
      {id: 'archived', status: 'done', archivedAt: 1, title: '归档需求', myRoles: ['creator']},
    ],
    addEventListener() {},
  };
  context.window = context;
  const sandbox = vm.createContext(context);
  const load = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), sandbox, {filename: file});
  if (clock) {
    context.Date = class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock.now])); }
      static now() { return clock.now; }
    };
    load('core/requirements.js');
    load('components/requirements/requirements-view.js');
    context.esc = context.RequirementsView.esc;
    load('components/gantt/gantt.js');
  }
  load('components/requirements/requirements-board.js');
  return {api: context.RequirementsBoard, root, rendered, stored, context};
}

test('ordinary chat executions do not appear in requirement lanes or counts', () => {
  const f = fixture({scope: 'all'});
  f.root.classList.add('show');
  const original = f.context.tasks.length;
  for (const origin of ['cloud-conversation', 'conversation-handoff']) {
    f.context.tasks.push({id: origin, origin, status: 'doing', title: 'Chat', myRoles: ['creator', 'executor']});
  }
  f.api.open();
  assert.ok(f.rendered.at(-1).ids.every(id => !['cloud-conversation', 'conversation-handoff'].includes(id)));
  assert.equal(f.root.querySelector('#hbCount').textContent, '· 2 条');
  assert.equal(f.context.tasks.length, original + 2, 'execution records remain available for conversation consumers');
  assert.deepEqual(Requirements.select(f.context.tasks, {scope: 'all'}).map(row => row.id).sort(),
    ['archived', 'review', 'running']);
});

test('explicit acceptance entry clears unrelated filters and opens the current review stage', () => {
  const f = fixture({scope: 'created', archive: 'archived', kind: 'bug', owner: 'another', project: 'old', due: 'overdue'});
  f.api.open({phase: 'reviewing'});
  assert.ok(f.rendered.length, 'pending review remains visible after entering from unrelated saved filters');
  const {ids, state} = f.rendered.at(-1);
  assert.deepEqual(ids, ['review']);
  assert.equal(state.phase, 'reviewing');
  assert.equal(state.archive, 'active');
  for (const key of ['q', 'kind', 'priority', 'project', 'owner', 'tag', 'due', 'attention']) assert.equal(state[key], '');
  assert.equal(state.onlyOverdue, false);
});

test('ordinary entry defaults to actionable while preserving other saved filters', () => {
  const f = fixture({scope: 'created', archive: 'active', phase: 'delivering'});
  f.api.open();
  assert.deepEqual(f.rendered.at(-1).ids, ['running']);
  assert.equal(f.rendered.at(-1).state.phase, 'delivering');
  assert.equal(f.rendered.at(-1).state.scope, 'actionable');
});

test('entering the pool reconciles a stale failure without rerunning the requirement', async () => {
  const f = fixture({}), row = f.context.tasks.find(task => task.id === 'running');
  row.ai = {state: 'failed', error: 'Old routing failure'};
  let refreshes = 0;
  f.context.Store.refreshTasks = async () => {
    refreshes++;
    await Promise.resolve();
    row.ai = {state: 'done', executionState: 'done'};
  };
  assert.equal(Requirements.blocked(row), true);
  f.api.open();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 1);
  assert.equal(Requirements.blocked(row), false);
  f.api.open(); f.api.render();
  assert.equal(refreshes, 1, 'rendering an already open pool does not poll');
  f.api.close(); f.api.open();
  assert.equal(refreshes, 2, 'a new navigation reconciles missed updates');
});

test('a failed pool refresh preserves the last known execution state and view', async () => {
  const f = fixture({phase: 'delivering'}), row = f.context.tasks.find(task => task.id === 'running');
  row.ai = {state: 'failed', error: 'Current failure'};
  f.context.Store.refreshTasks = async () => { throw Error('offline'); };
  f.api.open();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(Requirements.blocked(row), true);
  assert.equal(f.rendered.at(-1).state.phase, 'delivering');
  assert.deepEqual(f.rendered.at(-1).ids, ['running']);
});

test('every pool entry restores current actionable work instead of archived or saved scope', () => {
  for (const scope of ['created', 'actionable', 'related', 'all']) {
    const f = fixture({scope, archive: 'archived', v: 2});
    f.api.open();
    assert.equal(f.rendered.at(-1).state.scope, 'actionable');
    assert.equal(f.rendered.at(-1).state.archive, 'active');
    assert.deepEqual(f.rendered.at(-1).ids, ['running']);
    assert.match(f.root.querySelector('.rq-scopes').innerHTML, /data-rq-scope="actionable"/);
  }
});

test('visible pool refresh and repeated open preserve explicit view; navigation back resets scope', async () => {
  const f = fixture({});
  f.api.open({phase: 'reviewing'});
  f.api.render(true); await f.api.refresh(); f.api.open();
  assert.equal(f.rendered.at(-1).state.scope, 'all');
  assert.equal(f.rendered.at(-1).state.phase, 'reviewing');
  f.api.close(); f.api.open();
  assert.equal(f.root.querySelector('#rqScope').value, 'actionable');
  assert.equal(f.root.querySelector('#rqArchive').value, 'active');
});

function ganttFixture() {
  const clock = { now: new Date(2026, 10, 10, 14, 30).getTime() };
  const f = fixture({view: 'gantt'}, clock);
  const task = (id, due, extra = {}) => ({
    id, title: id, status: 'todo', myRoles: ['creator'], start: new Date(2026, 10, 8).getTime(),
    due: f.context.Requirements.dateTimestamp(due), ...extra,
  });
  const change = (target) => f.root.dispatchEvent({type: 'change', target});
  return {
    ...f, clock, task,
    html: () => f.root.querySelector('.hb-body').innerHTML,
    select: (id, value) => change({id, value, dataset: {}, hasAttribute: () => false}),
    onlyOverdue: () => change({dataset: {}, checked: true, hasAttribute: name => name === 'data-gvod'}),
    showView: view => {
      const button = {dataset: {rqView: view}, hasAttribute: name => name === 'data-rq-view', closest: () => null};
      f.root.dispatchEvent({type: 'click', target: {closest: () => button}});
    },
  };
}

function ganttBars(html) {
  return Object.fromEntries(Array.from(
    html.matchAll(/class="gv-bar gv-(\w+)" data-(?:rq-open|gvtid)="([^"]+)"/g),
    ([, state, id]) => [id, state],
  ));
}

test('requirements Gantt uses the local due day for coloring, filtering and the count', () => {
  const f = ganttFixture();
  f.context.tasks = [
    f.task('yesterday', '2026-11-09'),
    f.task('today', '2026-11-10'),
    f.task('tomorrow', '2026-11-11'),
    f.task('undated', null),
    f.task('reviewing', '2026-11-09', {status: 'done'}),
    f.task('completed', '2026-11-09', {status: 'done', reviewedAt: f.clock.now}),
  ];
  f.api.open();
  f.select('rqScope', 'all');
  assert.deepEqual(ganttBars(f.html()), {
    yesterday: 'over', today: 'run', tomorrow: 'run', undated: 'run', reviewing: 'done', completed: 'done',
  });
  f.onlyOverdue();
  assert.deepEqual(ganttBars(f.html()), {yesterday: 'over'});
  assert.match(f.html(), /class="gv-count">任务 1 项</);

  f.clock.now = new Date(2026, 10, 10, 23, 59, 59, 999).getTime();
  f.api.render(true);
  assert.deepEqual(ganttBars(f.html()), {yesterday: 'over'});

  f.clock.now = new Date(2026, 10, 11).getTime();
  f.api.render(true);
  assert.deepEqual(ganttBars(f.html()), {yesterday: 'over', today: 'over'});
  assert.match(f.html(), /class="gv-count">任务 2 项</);
});

test('canceled and archived requirements are excluded from overdue Gantt results', () => {
  const f = ganttFixture();
  f.context.tasks = [
    f.task('canceled', '2026-11-09', {status: 'cancel'}),
    f.task('archived', '2026-11-09', {archivedAt: f.clock.now}),
  ];
  f.api.open();
  f.select('rqArchive', 'archived');
  f.select('rqScope', 'all');
  f.showView('gantt');
  assert.deepEqual(ganttBars(f.html()), {canceled: 'run', archived: 'run'});
  f.onlyOverdue();
  assert.deepEqual(ganttBars(f.html()), {});
  assert.match(f.html(), /class="gv-count">任务 0 项</);
});

test('shared team Gantt retains timestamp-based overdue behavior without a requirements predicate', () => {
  const f = ganttFixture();
  const rows = [{label: 'Owner', tasks: [
    f.task('earlier', null, {due: new Date(2026, 10, 10, 12).getTime()}),
    f.task('later', null, {due: new Date(2026, 10, 10, 18).getTime()}),
    f.task('completed', '2026-11-09', {status: 'done'}),
  ]}];
  const options = {year: 2026, month: 10};
  const { GanttView } = f.context;
  assert.deepEqual(ganttBars(GanttView.html(rows, options)), {earlier: 'over', later: 'run', completed: 'done'});
  assert.deepEqual(ganttBars(GanttView.html(rows, {...options, onlyOverdue: true})), {earlier: 'over'});
});

function moveFixture() {
  const f = fixture({scope:'all', archive:'active'}), c = f.context;
  c.tasks = [{id:'move',status:'todo',triageStage:'intake',requirementVersion:3,canEditRequirement:true,myRoles:['assignee']}];
  const events = [], notices = [];
  c.Store.applyServerEvent = event => {events.push(event);c.tasks[0]=event.task;};
  c.petSay = text => notices.push(text);
  f.api.open();
  return {...f,c,events,notices};
}
test('preparation move uses one versioned write and renders authoritative reply without list reads', async () => {
  const f=moveFixture();
  f.c.SoduWorkAPI.getTask=async()=>{throw Error('unnecessary detail read');};
  f.c.Store.refreshTasks=async()=>{throw Error('unnecessary list read');};
  const writes=[];
  f.c.SoduWorkAPI.patchTask=async(id,patch)=>{writes.push({id,...patch});return {...f.c.tasks[0],triageStage:'ready',requirementVersion:4};};
  await f.api.move('move','ready');
  assert.equal(writes.length,1);assert.equal(writes[0].requirementVersion,3);
  assert.equal(f.events.length,1);assert.equal(f.c.tasks[0].triageStage,'ready');
  assert.deepEqual(f.notices,[]);
});
test('lost move response checks the saved task and does not report a confirmed write as failed', async () => {
  const f=moveFixture();let writes=0,reads=0;
  f.c.SoduWorkAPI.patchTask=async()=>{writes++;throw Error('request timeout');};
  f.c.SoduWorkAPI.getTask=async()=>{reads++;return {...f.c.tasks[0],triageStage:'ready',requirementVersion:4};};
  await f.api.move('move','ready');
  assert.equal(writes,1);assert.equal(reads,1);assert.equal(f.events.length,1);assert.deepEqual(f.notices,[]);
});
test('rejected version is not retried or presented as a successful move', async () => {
  const f=moveFixture();let writes=0;
  f.c.SoduWorkAPI.patchTask=async()=>{writes++;throw Object.assign(Error('version conflict'),{status:409});};
  await f.api.move('move','ready');
  assert.equal(writes,1);assert.equal(f.events.length,0);assert.deepEqual(f.notices,['version conflict']);
});
test('late move response after identity switch cannot update the current account', async () => {
  const f=moveFixture();let resolve;
  f.c.SoduWorkAPI.patchTask=()=>new Promise(done=>{resolve=done;});
  const moving=f.api.move('move','ready');
  f.c.SoduWorkAPI.taskStorageKey=()=> 'other-account';
  resolve({...f.c.tasks[0],triageStage:'ready',requirementVersion:4});await moving;
  assert.equal(f.events.length,0);
});

test('pending move is visible through refreshes and cleared on success or rejection', async () => {
  for (const failed of [false,true]) {
    const f=moveFixture();let resolve,reject;
    f.c.SoduWorkAPI.patchTask=()=>new Promise((yes,no)=>{resolve=yes;reject=no;});
    const moving=f.api.move('move','ready');
    assert.equal(f.rendered.at(-1).state.movingId,'move');
    f.api.render(true);
    assert.equal(f.rendered.at(-1).state.movingId,'move');
    if (failed) reject(Object.assign(Error('rejected'),{status:409}));
    else resolve({...f.c.tasks[0],triageStage:'ready',requirementVersion:4});
    await moving;
    assert.equal(f.rendered.at(-1).state.movingId,'');
  }
});
