'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/workspace/workspace-sidebar-state.js'), 'utf8');
const hub = 'https://sidebar-fixture.invalid';
const key = user => 'soduwork_sidebar_v1:' + encodeURIComponent(JSON.stringify([hub, user]));
const localKey = 'soduwork_sidebar_device_v1:' + encodeURIComponent('profile-one');
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(initial = {}) {
  const values = new Map(Object.entries(initial));
  let blocked = '', sequence = 0;
  const storage = { get length() { return values.size; }, key: index => [...values.keys()][index] || null,
    getItem: name => values.get(name) ?? null, removeItem: name => values.delete(name),
    setItem(name, value) { if (name === blocked) throw Error('quota'); values.set(name, value); } };
  const window = { crypto: { randomUUID: () => 'new-' + ++sequence } };
  vm.runInNewContext(source, { window, URL });
  const api = window.WorkspaceSidebarState;
  const open = user => api.create(api.accountOptions({ storage, api: {
    hubBase: () => hub, clientAuthSnapshot: () => ({ clientId: 'same-device', user: user ? { id: user } : null }),
  } }));
  const catalog = (items, rows = [], revision = 1, workspace = 'profile-one') =>
    api.setLocalHistory({ workspace, revision, items: items.map(item => typeof item === 'string' ? { id: item } : item) }, rows);
  return { api, values, storage, open, catalog, block: name => { blocked = name; } };
}
function saved({ local = 'native-a', remote = 'remote-a', project = 'project-a', name = 'Local A' } = {}) {
  return { version: 1, pins: [local, remote], recent: [],
    projects: [{ id: project, name, folders: ['C:/saved'], businessProjectId: 'private-business-' + remote,
      chatIds: [local, remote], createdAt: 10 }], archivedProjects: [],
    rows: [{ id: local, title: 'Saved ' + local, taskIds: ['private-task'] },
      { id: remote, title: 'SECRET ' + remote, cached: true, localReplica: true }],
    manualOrder: { recent: false, projects: { [project]: true } } };
}

test('verified device history merges local organization across A/B/A and keeps cloud metadata scoped', () => {
  const a = JSON.stringify(saved({ local: 'old-alias' }));
  const b = JSON.stringify(saved({ local: 'native-b', remote: 'remote-b', project: 'project-b', name: 'Local B' }));
  const f = fixture({ [key('a')]: a, [key('b')]: b });
  f.catalog([{ id: 'native-a', historyAliasIds: ['old-alias'] }, 'native-b']);
  const first = f.open('a'), other = f.open('b'), again = f.open('a');
  for (const store of [first, other, again]) {
    const value = plain(store.get());
    assert.deepEqual(value.pins.filter(id => id.startsWith('native')), ['native-a', 'native-b']);
    assert.deepEqual(value.projects.map(p => [p.id, p.chatIds.filter(id => id.startsWith('native'))]),
      [['project-a', ['native-a']], ['project-b', ['native-b']]]);
  }
  assert.deepEqual(plain(other.get().pins), ['native-a', 'native-b', 'remote-b']);
  assert.equal(other.get().rows.some(row => row.id === 'remote-a'), false);
  assert.equal(other.get().projects.find(p => p.id === 'project-a').businessProjectId, '');
  assert.equal(first.get().projects.find(p => p.id === 'project-a').businessProjectId, 'private-business-remote-a');
  assert.doesNotMatch(f.values.get(localKey), /SECRET|private-business|private-task|remote-a|remote-b/);
  assert.equal(f.values.get(key('a')), a, 'Discovery preserves the recoverable account snapshot');
  assert.equal(f.values.get(key('b')), b);
});

test('download origins migrate saved organization without becoming local identity or account authority', () => {
  const original = JSON.stringify(saved({ local: 'cloud-original' }));
  const f = fixture({ [key('a')]: original });
  f.catalog([{ id: 'downloaded-copy', originIds: ['cloud-original'], historyAliasIds: [] }],
    [{ id: 'downloaded-copy', title: 'Saved download' }]);
  const a = f.open('a'), b = f.open('b');
  assert.equal(f.api.localHistoryId('cloud-original'), '', 'Download origin is not a lifecycle alias');
  assert.deepEqual(plain(b.get().pins), ['downloaded-copy']);
  assert.deepEqual(plain(b.get().projects[0].chatIds), ['downloaded-copy']);
  assert.equal(b.get().rows[0].title, 'Saved download');
  assert.ok(a.get().pins.includes('cloud-original'), 'The current account keeps its independent original pin');
  assert.ok(a.get().projects[0].chatIds.includes('cloud-original'));
  assert.equal(f.values.get(key('a')), original, 'Migration does not rewrite the account snapshot');
  a.togglePin('cloud-original');
  assert.equal(a.get().pins.includes('cloud-original'), false);
  assert.deepEqual(plain(b.get().pins), ['downloaded-copy']);
  f.catalog([{ id: 'downloaded-copy', originIds: ['cloud-original'], deleted: true }], [], 2);
  assert.equal(f.api.localHistoryId('cloud-original'), '');
  assert.equal(a.get().projects[0].chatIds.includes('cloud-original'), true);
  assert.doesNotMatch(f.values.get(localKey), /cloud-original|private-business|private-task/);
});

test('device unpin, project removal and manual ordering survive restart without legacy resurrection', () => {
  const f = fixture({ [key('a')]: JSON.stringify(saved({ remote: '' })) });
  const rows = [{ id: 'native-a', title: 'A', createdAt: 10 }, { id: 'native-b', title: 'B', createdAt: 20 }];
  f.catalog(['native-a', 'native-b'], rows);
  const a = f.open('a'); a.togglePin('native-a'); a.removeProject('project-a');
  a.move(rows[0], 'recent', 'native-b', rows);
  for (const user of ['b', 'a', '']) {
    const value = f.open(user);
    assert.equal(value.get().pins.includes('native-a'), false);
    assert.equal(value.get().projects.some(p => p.id === 'project-a'), false);
    assert.deepEqual(plain(value.view(rows).recent).filter(r => r.id.startsWith('native')).map(r => r.id), ['native-a', 'native-b']);
  }
});

for (const section of ['recent', 'pinned', 'project']) {
  test('mixed ' + section + ' drag order survives reopening without sharing account rows', () => {
    const f = fixture();
    const rows = [{ id: 'native-a', title: 'Local', createdAt: 20 },
      { id: 'remote-a', title: 'Private A', createdAt: 10 }];
    f.catalog(['native-a'], rows.slice(0, 1));
    const a = f.open('a');
    let target = section;
    if (section === 'pinned') rows.forEach(row => a.togglePin(row.id, row));
    if (section === 'project') {
      target = a.saveProject({ name: 'Mixed project' });
      rows.forEach(row => a.fileChat(row.id, target, row));
    }
    const ids = store => {
      const view = store.view(rows);
      return plain(section === 'project' ? view.projects.find(p => p.id === target).items : view[section]).map(row => row.id);
    };
    a.move(rows[1], target, rows[0].id, rows);
    assert.deepEqual(ids(a), ['remote-a', 'native-a']);
    assert.deepEqual(ids(f.open('a')), ['remote-a', 'native-a']);
    const b = f.open('b');
    assert.equal(b.get().rows.some(row => row.id === 'remote-a'), false);
    assert.doesNotMatch(f.values.get(localKey), /remote-a|Private A/);
    assert.deepEqual(ids(f.open('a')), ['remote-a', 'native-a']);
    if (section === 'project') {
      a.archiveProject(target); a.restoreProject(target);
      assert.deepEqual(ids(f.open('a')), ['remote-a', 'native-a']);
      assert.deepEqual(plain(a.getAccount().projects.find(p => p.id === target).chatIds), ['remote-a', 'native-a']);
    }
  });
}

test('private order anchors obey current device order and canonical aliases without reviving removed membership', () => {
  const f = fixture();
  let rows = [{ id: 'native-a', createdAt: 40 }, { id: 'native-b', createdAt: 30 },
    { id: 'remote-a', title: 'Private A', createdAt: 20 }, { id: 'remote-b', createdAt: 10 }];
  f.catalog(['native-a', 'native-b'], rows.slice(0, 2));
  const a = f.open('a');
  a.move(rows[2], 'recent', 'native-a', rows);
  a.move(rows[3], 'recent', 'native-b', rows);
  const ids = store => plain(store.view(rows).recent).map(row => row.id);
  assert.deepEqual(ids(a), ['remote-a', 'native-a', 'remote-b', 'native-b']);
  const b = f.open('b'); b.move(rows[1], 'recent', 'native-a', rows.slice(0, 2));
  assert.deepEqual(ids(f.open('a')).filter(id => id.startsWith('native')), ['native-b', 'native-a']);
  assert.deepEqual(ids(f.open('a')).filter(id => id.startsWith('remote')), ['remote-a', 'remote-b']);
  f.catalog([{ id: 'native-a', deleted: true }, { id: 'canonical-a', historyAliasIds: ['native-a'] }, 'native-b'],
    [{ ...rows[0], id: 'canonical-a' }, rows[1]], 2);
  rows = [{ ...rows[0], id: 'canonical-a' }, ...rows.slice(1)];
  const reopened = f.open('a');
  assert.equal(ids(reopened).includes('native-a'), false);
  assert.deepEqual(ids(reopened).filter(id => !id.startsWith('remote')), ['native-b', 'canonical-a']);
  reopened.togglePin('canonical-a', rows[0]);
  f.open('b').togglePin('canonical-a');
  assert.equal(f.open('a').get().pins.includes('canonical-a'), false, 'A stale private anchor cannot restore a removed device pin');
  assert.doesNotMatch(f.values.get(localKey), /remote-a|remote-b|Private A/);
});

test('all legacy account keys migrate only exact validated IDs and preserve archived membership', () => {
  const old = 'soduwork_sidebar_projects_v1:' + encodeURIComponent('soduwork_tasks_v5@' +
    [hub, 'previous-device', 'a'].map(encodeURIComponent).join('@'));
  const value = saved(); value.archivedProjects.push({ id: 'project-archived', name: 'Archived local', chatIds: ['archived-local', 'hidden-remote'] });
  value.rows.push({ id: 'archived-local', title: 'Archived' }, { id: 'hidden-remote', title: 'SECRET archived' });
  const before = JSON.stringify(value), f = fixture({ [old]: before });
  f.catalog(['native-a', { id: 'archived-local', archived: true }]);
  const state = f.open('b').get();
  assert.deepEqual(plain(state.archivedProjects[0].chatIds), ['archived-local']);
  assert.equal(state.rows.some(row => row.id === 'archived-local'), false);
  assert.equal(f.values.get(old), before);
  assert.doesNotMatch(f.values.get(localKey), /SECRET|hidden-remote|remote-a/);
});

test('a complete large catalog migrates pinned records outside the first fifty rows', () => {
  const f = fixture({ [key('a')]: JSON.stringify(saved({ local: 'native-1200' })) });
  const items = Array.from({ length: 2000 }, (_, i) => 'native-' + i);
  const rows = items.slice(0, 50).map(id => ({ id, title: id }));
  f.catalog(items, rows);
  const value = f.open('b');
  assert.equal(value.get().pins.includes('native-1200'), true);
  assert.equal(value.view(rows).pinned.find(row => row.id === 'native-1200').title, 'Saved native-1200');
  assert.equal(JSON.parse(f.values.get(localKey)).migratedIds.length, 2000);
  const bytes = f.values.get(localKey);
  for (let i = 0; i < 30; i++) value.view(rows);
  assert.equal(f.values.get(localKey), bytes, 'Read-only paints do not repeatedly rewrite or migrate the catalog');
});

test('account project synchronization exports only the original account bindings', async () => {
  const f = fixture({ [key('a')]: JSON.stringify(saved()) });
  f.catalog(['native-a']);
  const a = f.open('a'), b = f.open('b');
  assert.equal(a.getAccount().projects.some(p => p.id === 'project-a'), true);
  assert.equal(b.getAccount().projects.some(p => p.id === 'project-a'), false);
  const writes = [];
  await f.api.projectSync({ store: b, storage: f.storage, key: key('b'), api: {
    conversationProjects: async () => ({ items: [] }),
    saveConversationProject: async (id, body) => { writes.push({ id, body }); return { revision: 1 }; },
  } }).run();
  assert.deepEqual(writes, []);
  b.saveProject({ id: 'project-a', name: 'Renamed locally' });
  assert.equal(f.open('a').get().projects[0].name, 'Renamed locally');
  assert.equal(f.open('b').getAccount().projects.length, 0);
});

test('a matching project ID in another account cannot rename or empty the device group', () => {
  const f = fixture({ [key('a')]: JSON.stringify(saved()) }); f.catalog(['native-a']);
  const a = f.open('a'), b = f.open('b');
  b.applyRemoteProject({ id: 'project-a', name: 'B private remote name', chatIds: ['remote-b'] });
  assert.equal(a.get().projects[0].name, 'Local A');
  assert.deepEqual(plain(a.get().projects[0].chatIds), ['native-a', 'remote-a']);
  assert.equal(b.getAccount().projects[0].name, 'B private remote name');
  b.applyRemoteProject({ id: 'project-b', name: 'Other B remote group', chatIds: ['remote-b-two'] });
  assert.equal(a.get().projects[0].name, 'Local A');
  assert.deepEqual(plain(JSON.parse(f.values.get(localKey)).projectOwners['project-a']), [key('a')]);
  b.applyRemoteProject({ id: 'project-a', name: 'Deleted B project', deleted: true });
  assert.deepEqual(plain(a.get().projects[0].chatIds), ['native-a', 'remote-a']);
  assert.doesNotMatch(f.values.get(localKey), /B private|Other B remote|remote-b/);
});

test('cross-account archive and restore retain the original account application and business associations', () => {
  const value = saved(); Object.assign(value.projects[0], { appId: 'local:owned-app', lastChatId: 'native-a' });
  const f = fixture({ [key('a')]: JSON.stringify(value) }); f.catalog(['native-a']);
  const a = f.open('a'), b = f.open('b');
  b.archiveProject('project-a');
  assert.equal(a.get().archivedProjects[0].businessProjectId, 'private-business-remote-a');
  assert.equal(a.get().archivedProjects[0].appId, 'local:owned-app');
  b.restoreProject('project-a');
  assert.equal(a.get().projects[0].businessProjectId, 'private-business-remote-a');
  assert.equal(a.get().projects[0].appId, 'local:owned-app');
  assert.equal(b.get().projects[0].businessProjectId, '');
  assert.equal(b.get().projects[0].appId, undefined);
});

test('local organization remains writable without an authenticated account', () => {
  const f = fixture(); f.catalog(['native-a'], [{ id: 'native-a', title: 'Local offline' }]);
  const store = f.open(''); store.togglePin('native-a', { id: 'native-a', title: 'Local offline' });
  assert.deepEqual(plain(f.open('b').get().pins), ['native-a']);
  assert.equal(f.open('').getAccount().projects.length, 0);
});

test('catalog identity and alias validation cannot promote arbitrary renderer cache flags', () => {
  const f = fixture({ [key('a')]: JSON.stringify(saved()) });
  assert.equal(f.api.setLocalHistory({ workspace: 'profile-one', revision: 1 }), false);
  assert.deepEqual(plain(f.open('b').get().pins), []);
  f.catalog([{ id: 'one', historyAliasIds: ['ambiguous'] }, { id: 'two', historyAliasIds: ['ambiguous'] }]);
  assert.equal(f.api.setLocalHistory({ workspace: 'other-profile', revision: 1 }, [{ id: 'remote-a' }]), false);
  assert.deepEqual(plain(f.open('b').get().pins), []);
  assert.doesNotMatch(f.values.get(localKey), /SECRET|remote-a/);
});

test('an actual native join migrates retired-child pins and groups to the live public identity', t => {
  const os = require('node:os'), { create } = require('../main/conversation/replica-store.cjs');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-sidebar-join-'));
  const store = create(path.join(folder, 'history.sqlite'));
  t.after(() => { store.close(); fs.rmSync(folder, { recursive: true, force: true }); });
  store.register([{ id: 'public-parent', title: 'Public local title', at: 2 }, { id: 'runtime-child', title: 'Child title', at: 1 }]);
  store.join('public-parent', ['runtime-child']);
  const catalog = store.catalog(), page = store.page();
  assert.equal(catalog.items.find(row => row.id === 'runtime-child').deleted, true);
  assert.ok(catalog.items.find(row => row.id === 'public-parent').historyAliasIds.includes('runtime-child'));
  const f = fixture({ [key('a')]: JSON.stringify(saved({ local: 'runtime-child' })) });
  assert.equal(f.api.setLocalHistory(catalog, page.chats), true);
  const state = f.open('b');
  assert.deepEqual(plain(state.get().pins), ['public-parent']);
  assert.deepEqual(plain(state.get().projects[0].chatIds), ['public-parent']);
  assert.equal(state.view([]).pinned[0].title, 'Public local title');
  assert.equal(f.api.localHistoryId('runtime-child'), 'public-parent');
});

test('a later native join canonicalizes an already-saved device layout without reviving obsolete account pins', t => {
  const os = require('node:os'), { create } = require('../main/conversation/replica-store.cjs');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-sidebar-later-join-'));
  const store = create(path.join(folder, 'history.sqlite'));
  t.after(() => { store.close(); fs.rmSync(folder, { recursive: true, force: true }); });
  store.register([{ id: 'public-parent', title: 'Public local title', at: 2 }, { id: 'runtime-child', title: 'Child title', at: 1 }]);
  const f = fixture({ [key('a')]: JSON.stringify(saved({ local: 'runtime-child' })) });
  f.api.setLocalHistory(store.catalog(), store.page().chats);
  const a = f.open('a'); assert.equal(a.get().pins.includes('runtime-child'), true);
  store.join('public-parent', ['runtime-child']);
  f.api.setLocalHistory(store.catalog(), store.page().chats);
  assert.deepEqual(plain(f.open('b').get().pins), ['public-parent']);
  assert.deepEqual(plain(a.get().projects[0].chatIds), ['public-parent', 'remote-a']);
  a.togglePin('public-parent');
  assert.equal(f.open('b').get().pins.includes('public-parent'), false);
});

test('late older catalogs cannot resurrect deleted local metadata across concurrent views', () => {
  const f = fixture({ [key('a')]: JSON.stringify(saved()) });
  assert.equal(f.catalog(['native-a'], [{ id: 'native-a', title: 'Local title' }], 0), true);
  const s = f.open('b'); assert.equal(s.view([]).pinned.length, 1);
  assert.equal(f.catalog([{ id: 'native-a', deleted: true }], [], 2), true);
  assert.equal(s.view([]).pinned.length, 0);
  assert.equal(f.catalog(['native-a'], [{ id: 'native-a', title: 'Obsolete title' }], 1), false);
  assert.equal(f.api.localHistoryRevision('profile-one'), 2);
  assert.equal(s.view([]).pinned.length, 0);
});

test('storage failure rolls back the account half and retains local organization', () => {
  const f = fixture({ [key('a')]: JSON.stringify(saved()) }); f.catalog(['native-a']);
  const store = f.open('a'), before = [...f.values.entries()];
  f.block(localKey);
  assert.throws(() => store.togglePin('native-a'), /quota/);
  assert.deepEqual([...f.values.entries()], before);
  f.block(''); assert.equal(f.open('b').get().pins.includes('native-a'), true);
});
