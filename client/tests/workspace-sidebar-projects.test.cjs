'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/workspace/workspace-sidebar-state.js'), 'utf8');
function fixture() {
  const window = {SoduWorkPluginIcon:require('../core/plugin-icon')}, values = new Map();
  vm.runInNewContext(source, { window });
  let blocked = false;
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => {
    if (blocked) throw Error('quota exceeded'); values.set(key, value);
  } };
  return { api: window.WorkspaceSidebarState, values, storage, block: () => { blocked = true; },
    create: key => window.WorkspaceSidebarState.create({ storage, key: key || 'one' }) };
}
const ids = rows => Array.from(rows, row => row.id);
test('background timestamp refreshes do not reorder existing recent conversations', () => {
  const s = fixture().create();
  const first = [{ id: 'a', at: 300 }, { id: 'b', at: 200 }, { id: 'c', at: 100 }];
  assert.deepEqual(ids(s.view(first).recent), ['a', 'b', 'c']);
  const refreshed = [{ id: 'c', at: 900, state: 'running' }, { id: 'b', at: 800 }, { id: 'a', at: 300 }];
  assert.deepEqual(ids(s.view(refreshed).recent), ['a', 'b', 'c']);
  assert.deepEqual(ids(s.view([{ id: 'new', at: 1000 }, ...refreshed]).recent), ['new', 'a', 'b', 'c']);
});

test('replacing a synchronization alias keeps its established position', () => {
  const s = fixture().create();
  s.view([{ id: 'a', at: 300 }, { id: 'acct-source', _uiKey: 'shared', at: 100 }]);
  assert.deepEqual(ids(s.view([{ id: 'native-source', _uiKey: 'shared', at: 900 }, { id: 'a', at: 300 }]).recent),
    ['a', 'native-source']);
});
const a = { id: 'a', title: '需求沟通', adapterId: 'codex', taskIds: ['task-one'], state: 'running' };
const b = { id: 'b', title: '项目进展', state: 'completed' };
const appIcon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxqkAAAAASUVORK5CYII=';

test('account project sync imports groups, preserves PC folders and applies only explicit removals', async () => {
  const f = fixture(), store = f.create();
  const id = store.saveProject({name: '本地项目', folders: ['C:/work']});
  store.fileChat('native-chat', id, {id: 'native-chat', title: '会话'});
  const remote = new Map(), writes = [], errors = [];
  const sync = f.api.projectSync({store, storage: f.storage, key: 'one', error: e => errors.push(e), api: {
    conversationProjects: async () => ({items: [...remote.values()]}),
    saveConversationProject: async (key, body) => {
      writes.push(key); assert.equal(body.revision, remote.get(key)?.revision || 0);
      const value = {...body, id: key, revision: body.revision + 1}; remote.set(key, value); return value;
    },
  }});
  await sync.run(); assert.equal(writes.length, 1);
  remote.set(id, {...remote.get(id), name: '手机改名', revision: 2});
  remote.set('project-phone', {id: 'project-phone', name: '手机项目', chatIds: [], revision: 1});
  await sync.run();
  const project = store.get().projects.find(p => p.id === id);
  assert.equal(project.name, '手机改名'); assert.deepEqual(Array.from(project.folders), ['C:/work']);
  remote.delete('project-phone'); await sync.run();
  assert.ok(store.get().projects.some(p => p.id === 'project-phone'), 'missing records do not imply deletion');
  remote.set('project-phone', {id: 'project-phone', name: '手机项目', chatIds: [], revision: 2, deleted: true});
  await sync.run(); assert.ok(!store.get().projects.some(p => p.id === 'project-phone'));
  assert.equal(errors.length, 0);
});

test('project sync preserves edits made in flight and does not publish application groups', async () => {
  const f = fixture(), store = f.create(), remote = new Map();
  const id = store.saveProject({name: '初始'});
  store.recordAppChat('app-local', '应用专用', a);
  let release, pause = true;
  const sync = f.api.projectSync({store, storage: f.storage, key: 'one', api: {
    conversationProjects: async () => ({items: [...remote.values()]}),
    saveConversationProject: async (key, body) => {
      assert.equal(key, id);
      if (pause) await new Promise(resolve => { release = resolve; });
      const value = {...body, id: key, revision: body.revision + 1}; remote.set(key, value); return value;
    },
  }});
  const job = sync.run(); await new Promise(resolve => setImmediate(resolve));
  store.saveProject({id, name: '发送期间的改名'}); pause = false; release(); await job;
  await sync.run(); assert.equal(remote.get(id).name, '发送期间的改名'); assert.equal(remote.size, 1);
});

test('deleting a chat while another project saves cannot restore its old project membership', async () => {
  const f = fixture(), remote = new Map(), errors = [];
  let sync, autoSync = false, pause = false, release;
  const store = f.api.create({storage: f.storage, key: 'one', onChange: () => {
    if (autoSync) void sync.run();
  }});
  const first = store.saveProject({name: 'First'}), second = store.saveProject({name: 'Second'});
  store.fileChat('deleted-chat', second, {id: 'deleted-chat', title: 'Deleted conversation'});
  sync = f.api.projectSync({store, storage: f.storage, key: 'one', error: e => errors.push(e), api: {
    conversationProjects: async () => ({items: [...remote.values()]}),
    saveConversationProject: async (id, body) => {
      if (pause && id === first) await new Promise(resolve => { release = resolve; });
      assert.equal(body.revision, remote.get(id)?.revision || 0);
      const row = {...body, id, revision: body.revision + 1}; remote.set(id, row); return row;
    },
  }});
  await sync.run();
  store.saveProject({id: first, name: 'First edited'});
  autoSync = true; pause = true;
  const work = sync.run(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, 'function');
  store.forgetMany(['deleted-chat']);
  assert.deepEqual(Array.from(store.get().projects.find(row => row.id === second).chatIds), []);
  pause = false; release(); await work;
  assert.deepEqual(Array.from(store.get().projects.find(row => row.id === second).chatIds), []);
  assert.deepEqual(Array.from(remote.get(second).chatIds), []);
  assert.equal(f.create().view([]).projects.find(row => row.id === second).items.length, 0);
  assert.equal(errors.length, 0);
});

test('project push during a pending read is reconciled once without recursive remote-write loops', async () => {
  const f = fixture(); let sync, release, calls = 0, remote = {id: 'project-phone', name: 'Old', revision: 1, chatIds: []};
  const store = f.api.create({storage: f.storage, key: 'one', onChange: () => { void sync?.run(); }});
  sync = f.api.projectSync({store, storage: f.storage, key: 'one', api: {
    conversationProjects: async () => {
      const snapshot = {...remote}; calls++;
      if (calls === 1) await new Promise(resolve => { release = resolve; });
      return {items: [snapshot]};
    }, saveConversationProject: async () => assert.fail('remote updates must not write back'),
  }});
  const work = sync.run(); await new Promise(resolve => setImmediate(resolve));
  remote = {...remote, name: 'New', revision: 2};
  for (let i = 0; i < 100; i++) void sync.run();
  release(); await work;
  assert.equal(calls, 2); assert.equal(store.get().projects[0].name, 'New');
});

test('project revision conflict and account changes cannot overwrite local groups', async () => {
  const f = fixture(), store = f.create(), errors = [];
  const id = store.saveProject({name: '保留本地'});
  const sync = f.api.projectSync({store, storage: f.storage, key: 'one', error: e => errors.push(e), api: {
    conversationProjects: async () => ({items: []}),
    saveConversationProject: async () => {throw Error('409 conflict');},
  }});
  await sync.run(); assert.equal(errors.length, 1); assert.equal(store.get().projects[0].name, '保留本地');
  let current = true;
  const switched = f.api.projectSync({store, storage: f.storage, key: 'one', current: () => current, api: {
    conversationProjects: async () => {current = false; return {items: [{id, name:'别的账号', revision: 1, chatIds: []}]};},
    saveConversationProject: async () => assert.fail('must not write after account switch'),
  }});
  await switched.run(); assert.equal(store.get().projects[0].name, '保留本地');
});

test('application project artwork reuses only validated app PNGs and survives archive/restore', () => {
  const f=fixture(), s=f.create();
  s.recordAppChat('local:art', '应用', a, appIcon);
  assert.equal(f.create().get().projects[0].appIcon, appIcon);
  const id=s.get().projects[0].id; s.archiveProject(id); s.restoreProject(id);
  assert.equal(s.get().projects[0].appIcon, appIcon);
  s.recordAppChat('local:art', '应用', b);
  assert.equal(s.get().projects[0].appIcon, appIcon, 'older clients cannot erase saved artwork');
  for(const icon of ['https://example.invalid/icon.png','file:///private/icon.png','data:image/svg+xml,<svg onload="alert(1)"/>']) {
    s.recordAppChat('local:art', '应用', b, icon);
    assert.equal(s.get().projects[0].appIcon, undefined);
  }
});

test('application groups reuse app identity, retain all chats and last selection across reloads without colliding with projects', () => {
  const f = fixture(), s = f.create();
  s.saveProject({ name: '运营应用' });
  s.recordAppChat('local:ops', '运营应用', a);
  s.recordAppChat('local:ops', '运营应用', b);
  s.recordAppChat('local:ops', '运营应用', a);
  s.recordAppChat('market:other', '运营应用', { id: 'other', title: '另一个应用' });
  const reloaded = f.create(), groups = reloaded.get().projects;
  assert.equal(groups.length, 3);
  const app = groups.find(p => p.appId === 'local:ops');
  assert.deepEqual(Array.from(app.chatIds), ['a', 'b']); assert.equal(app.lastChatId, 'a');
  assert.equal(app.businessProjectId, ''); assert.deepEqual(Array.from(app.folders), []);
  assert.equal(reloaded.view(Array.from({ length: 50 }, (_, i) => ({ id: 'new-' + i }))).projects.find(p => p.appId === 'local:ops').items.length, 2);
  reloaded.forget('a'); assert.equal(reloaded.get().projects.find(p => p.appId === 'local:ops').lastChatId, '');
  assert.equal(f.create('other-account').get().projects.length, 0);
});

test('application grouping refreshes other windows atomically and archive/restore preserves app metadata', () => {
  const f = fixture(), one = f.create(), two = f.create();
  one.recordAppChat('local:ops', '运营', a); two.recordAppChat('local:ops', '运营改名', b);
  let app = one.get().projects[0];
  assert.equal(app.name, '运营改名'); assert.deepEqual(Array.from(app.chatIds), ['a', 'b']);
  one.archiveProject(app.id); one.restoreProject(app.id);
  app = two.get().projects[0]; assert.equal(app.appId, 'local:ops'); assert.equal(app.lastChatId, 'b');
  const saved = f.values.get('one'); f.block();
  assert.throws(() => two.recordAppChat('local:ops', '运营', { id: 'failed' }), /quota/);
  assert.equal(f.values.get('one'), saved);
});

test('older grouped chats retain complete used harnesses across restart and partial rename', () => {
  const f = fixture(), s = f.create(), project = s.saveProject({name:'持续协作'});
  s.fileChat(a.id, project, {...a,usedHarnesses:['pi','codex-harness','harness2','pi'],messages:[{text:'private'}]});
  s.remember([{id:a.id,title:'改名后'}]);
  const row = f.create().view([]).projects[0].items[0];
  assert.deepEqual(Array.from(row.usedHarnesses || []), ['pi','codex-harness','harness2']);
  assert.equal(row.title,'改名后'); assert.equal(row.messages,undefined);
  s.fileChat(b.id, project, {...b,adapterId:'codex',usedHarnesses:[]});
  const draft = f.create().view([]).projects[0].items.find(item=>item.id===b.id);
  assert.ok(Array.isArray(draft.usedHarnesses));
  assert.equal(draft.usedHarnesses.length,0,'Explicitly unused history must not fall back to current adapter after reload');
});

test('explicit Hub project link survives edits, archive/restore and account isolation',()=>{
  const f=fixture(),s=f.create(),id=s.saveProject({name:'长期项目',folders:['D:/site'],businessProjectId:'hub-id'});
  assert.notEqual(id,'hub-id');
  s.saveProject({id,name:'更名',folders:['D:/site']});assert.equal(s.get().projects[0].businessProjectId,'hub-id');
  s.archiveProject(id);assert.equal(s.get().archivedProjects[0].businessProjectId,'hub-id');
  s.restoreProject(id);assert.equal(f.create().get().projects[0].businessProjectId,'hub-id');
  assert.equal(f.create('other-account').get().projects.length,0);
  s.saveProject({id,name:'更名',folders:['D:/site'],businessProjectId:''});assert.equal(s.get().projects[0].businessProjectId,'');
});

test('one conversation belongs to exactly one group, pin and recent moves are reversible', () => {
  const f = fixture(), s = f.create(), project = s.saveProject({ name: '客户项目' });
  s.move(a, project, '', [a, b]);
  assert.deepEqual(ids(s.view([a, b]).projects[0].items), ['a']);
  assert.deepEqual(ids(s.view([a, b]).recent), ['b']);
  s.move(a, 'pinned', '', [a, b]);
  assert.equal(s.view([a, b]).projects[0].items.length, 0);
  assert.deepEqual(ids(s.view([a, b]).pinned), ['a']);
  s.move(a, 'recent', 'b', [a, b]);
  assert.equal(s.view([a, b]).pinned.length, 0);
  assert.deepEqual(ids(s.view([a, b]).recent), ['a', 'b']);
});
test('recent and project conversations default to creation-time descending, then keep a manual drag order', () => {
  const f = fixture(), s = f.create();
  const older = { id: 'older', title: '较早', createdAt: 100 };
  const newer = { id: 'newer', title: '较新', createdAt: 300 };
  s.remember([older, newer]);
  assert.deepEqual(ids(s.view([older, newer]).recent), ['newer', 'older']);
  const project = s.saveProject({ name: '按时间排序' });
  s.fileChat(older.id, project, older);
  s.fileChat(newer.id, project, newer);
  assert.deepEqual(ids(s.view([older, newer]).projects[0].items), ['newer', 'older']);
  s.move(older, project, 'newer', [older, newer]);
  assert.deepEqual(ids(s.view([older, newer]).projects[0].items), ['older', 'newer']);
  const reloaded = f.create();
  assert.deepEqual(ids(reloaded.view([older, newer]).projects[0].items), ['older', 'newer']);
});

test('first project drag preserves the visible order of the other conversations', () => {
  const f = fixture(), s = f.create(), project = s.saveProject({ name: '拖动顺序' });
  const rows = [100, 200, 300].map(createdAt => ({ id: String(createdAt), createdAt }));
  rows.forEach(row => s.fileChat(row.id, project, row));
  assert.deepEqual(ids(s.view(rows).projects[0].items), ['300', '200', '100']);
  s.move(rows[0], project, '200', rows);
  assert.deepEqual(ids(s.view(rows).projects[0].items), ['300', '100', '200']);
  assert.deepEqual(ids(f.create().view(rows).projects[0].items), ['300', '100', '200']);
});
test('pin/unpin only toggles the flag: project membership survives, unpin returns to the project', () => {
  const f = fixture(), s = f.create(), project = s.saveProject({ name: '客户项目' });
  s.fileChat('a', project, a);
  assert.deepEqual(ids(s.view([a, b]).projects[0].items), ['a']);
  s.togglePin('a');
  assert.deepEqual(ids(s.view([a, b]).pinned), ['a']);
  assert.deepEqual(ids(s.view([a, b]).projects[0].items), ['a']);       // Keep project grouping visible while pinned.
  assert.ok(!ids(s.view([a, b]).recent).includes('a'), '置顶会话不重复出现在最近聊天');
  s.togglePin('a');                                                     // Remove the pin.
  assert.equal(s.view([a, b]).pinned.length, 0);
  assert.deepEqual(ids(s.view([a, b]).projects[0].items), ['a']);       // Return to the project group.
  assert.ok(!ids(s.view([a, b]).recent).includes('a'));
});
test('filing a pinned chat keeps the flag; unpinning without project membership returns to recent', () => {
  const f = fixture(), s = f.create(), project = s.saveProject({ name: '客户项目' });
  s.remember([b]);
  s.togglePin('b');
  assert.deepEqual(ids(s.view([a, b]).pinned), ['b']);
  s.fileChat('b', project, b);                                          // Assign a pinned conversation to a project.
  assert.ok(s.get().pins.includes('b'), '归属变更不得清除置顶标记');
  s.togglePin('b');
  assert.equal(s.view([a, b]).pinned.length, 0);
  assert.deepEqual(ids(s.view([a, b]).projects[0].items), ['b']);       // Return to the project rather than recent chats.
});
test('unpinning a chat without project membership returns it to recent', () => {
  const f = fixture(), s = f.create();
  s.remember([a, b]);
  s.togglePin('a');
  assert.deepEqual(ids(s.view([a, b]).pinned), ['a']);
  s.togglePin('a');
  assert.equal(s.view([a, b]).pinned.length, 0);
  assert.ok(ids(s.view([a, b]).recent).includes('a'), '无项目归属的会话取消置顶后回到最近聊天'); // Conversation b already belongs to recent chats.
});
test('project names, optional folders and collapse survive reload; names are validated', () => {
  const f = fixture(), s = f.create(), p = s.saveProject({ name: '产品孵化', folders: ['C:\\Work\\product'] });
  s.collapse(p); s.saveProject({ id: p, name: '客户方案', folders: ['C:\\Work\\product', 'D:\\资料'] });
  const saved = f.create().get().projects[0];
  assert.equal(saved.name, '客户方案'); assert.equal(saved.folders.length, 2); assert.equal(saved.collapsed, true);
  assert.throws(() => s.saveProject({ name: '  ' }), /名称/);
  assert.throws(() => s.saveProject({ name: '客户方案' }), /同名/);
  assert.throws(() => s.saveProject({ name: '字'.repeat(81) }), /80/);
});
test('old grouped conversations remain outside the latest-50 inventory without stale running signals', () => {
  const f = fixture(), s = f.create(), p = s.saveProject({ name: '归档资料' });
  s.move(a, p, '', [a]); s.remember([a]);
  const restored = f.create().view(Array.from({ length: 50 }, (_, n) => ({ id: 'new-' + n }))).projects[0].items[0];
  assert.equal(restored.id, a.id); assert.equal(restored.adapterId, 'codex');
  assert.deepEqual(Array.from(restored.taskIds), ['task-one']);
  assert.equal(restored.state, 'completed'); assert.equal(restored.live, false);
});
test('removing project returns conversations to recent without losing metadata; deleting removes references', () => {
  const f = fixture(), s = f.create(), p = s.saveProject({ name: '临时组' });
  s.move(a, p, '', [a]); s.removeProject(p);
  assert.equal(s.get().projects.length, 0); assert.equal(s.view([]).recent[0].title, a.title);
  s.forget('a'); assert.equal(s.view([]).recent.length, 0); assert.equal(s.get().rows.length, 0);
});
test('archiving a project hides its chats, preserves the snapshot, and supports restore or permanent removal', () => {
  const f = fixture(), s = f.create(), p = s.saveProject({ name: '已归档项目', folders: ['D:\\archive'] });
  s.move(a, p, '', [a]); s.remember([a]); s.archiveProject(p);
  assert.equal(s.get().projects.length, 0);
  assert.equal(s.get().archivedProjects[0].id, p);
  assert.deepEqual(Array.from(s.get().archivedProjects[0].chatIds), ['a']);
  assert.equal(s.view([a]).recent.length, 0);
  s.restoreProject(p);
  assert.equal(s.get().archivedProjects.length, 0);
  assert.equal(s.view([a]).projects[0].items[0].id, 'a');
  s.archiveProject(p); s.permanentlyDeleteProject(p);
  assert.equal(s.get().archivedProjects.length, 0);
  assert.equal(s.get().rows.length, 0);
});
test('archived project chat references win conflicts', () => {
  const f = fixture();
  f.values.set('one', JSON.stringify({ version: 1,
    projects: [{ id: 'project-active', name: '活动项目', folders: [], chatIds: ['a'] }],
    archivedProjects: [{ id: 'project-archived', name: '已归档项目', folders: [], chatIds: ['a'] }],
    pins: ['a'], recent: [], rows: [{ id: 'a', title: '会话' }] }));
  const s = f.create();
  assert.deepEqual(Array.from(s.get().archivedProjects[0].chatIds), ['a']);
  assert.deepEqual(Array.from(s.get().projects[0].chatIds), []);
  assert.equal(s.get().archivedProjects[0].id, 'project-archived');
});
test('restoring or deleting a chat updates archived project references', () => {
  const f = fixture(), s = f.create(), p = s.saveProject({ name: '归档同步' });
  s.move(a, p, '', [a]); s.remember([a]); s.archiveProject(p);
  s.restoreChat('a');
  assert.deepEqual(Array.from(s.get().archivedProjects[0].chatIds), []);
  assert.deepEqual(ids(s.view([a]).recent), ['a']);
  const g = fixture(), raw = { version: 1, projects: [], archivedProjects: [{ id: 'project-old', name: '旧项目', folders: [], chatIds: ['a'] }], pins: [], recent: [], rows: [{ id: 'a', title: '会话' }] };
  g.values.set('one', JSON.stringify(raw));
  const other = g.create();
  other.forget('a');
  assert.deepEqual(Array.from(other.get().archivedProjects[0].chatIds), []);
});
test('manual order survives history polling and newer conversations still appear', () => {
  const s = fixture().create(), p = s.saveProject({ name: '交付' });
  s.move(a, p, '', [a, b]); s.move(b, p, 'a', [a, b]);
  assert.deepEqual(ids(s.view([a, b]).projects[0].items), ['b', 'a']);
  s.move(a, 'recent', '', [a, b]); s.move(b, 'recent', 'a', [a, b]);
  assert.deepEqual(ids(s.view([{ id: 'new', title: '新会话' }, a, b]).recent), ['new', 'b', 'a']);
});
test('storage failure is atomic, preserves saved groups, and is not reported as success', () => {
  const f = fixture(), s = f.create(), p = s.saveProject({ name: '保留数据' });
  s.move(a, p, '', [a]); const before = f.values.get('one'); f.block();
  assert.throws(() => s.move(a, 'pinned', '', [a]), /quota/);
  assert.equal(f.values.get('one'), before);
  assert.deepEqual(ids(s.view([a]).projects[0].items), ['a']);
});
test('account/device scopes and simultaneous windows do not overwrite unrelated changes', () => {
  const f = fixture(), one = f.create('account-one'), two = f.create('account-two'), otherWindow = f.create('account-one');
  one.saveProject({ name: '甲的项目' }); two.saveProject({ name: '乙的项目' });
  otherWindow.saveProject({ name: '另一窗口添加' });
  assert.equal(one.get().projects.length, 2); assert.equal(two.get().projects.length, 1);
});
test('pending conversations cannot move; missing destinations do not mutate data; snapshots exclude message content', () => {
  const f = fixture(), s = f.create();
  assert.throws(() => s.move({ ...a, pending: true }, 'pinned', '', [a]), /建立后/);
  assert.throws(() => s.move(a, 'project-missing', '', [a]), /移除/);
  s.move({ ...a, messages: [{ text: 'private body' }], secret: 'key', attachments: ['private file'] }, 'pinned', '', [a]);
  assert.doesNotMatch(f.values.get('one'), /private|secret|attachments/);
});
test('corrupt grouping storage cannot block history rendering or overwrite recoverable original data', () => {
  const f = fixture(); f.values.set('one', '{broken original');
  const s = f.create();
  assert.deepEqual(ids(s.view([a, b]).recent), ['a', 'b']);
  assert.throws(() => s.saveProject({ name: '不能覆盖原数据' }), /原数据已保留/);
  assert.equal(f.values.get('one'), '{broken original');
});
test('partial rename keeps stored runtime/task metadata; editing a removed project fails safely', () => {
  const s = fixture().create(), p = s.saveProject({ name: '旧项目' });
  s.move(a, p, '', [a]); s.remember([{ id: 'a', title: '重新命名' }]);
  assert.equal(s.view([]).projects[0].items[0].adapterId, 'codex');
  assert.deepEqual(Array.from(s.view([]).projects[0].items[0].taskIds), ['task-one']);
  s.removeProject(p);
  assert.throws(() => s.saveProject({ id: p, name: '不应复活' }), /已被移除/);
});
test('new-conversation placeholders stay visible until the real session id arrives', () => {
  const s = fixture().create();
  const pending = { localId: 'pending-one', title: '正在建立会话', pending: true, _uiKey: 'draft:pending-one' };
  const before = s.view([pending, a, b]).recent;
  assert.equal(before.length, 3); assert.equal(before[0].localId, 'pending-one');
  s.move(b, 'pinned', '', [pending, a, b]);
  assert.equal(s.get().recent.includes('undefined'), false);
  assert.equal(s.view([pending, a, b]).recent[0].localId, 'pending-one');
});
