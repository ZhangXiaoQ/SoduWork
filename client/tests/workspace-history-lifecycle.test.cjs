'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(overrides = {}) {
  let owner = 'account-a';
  const events = new Map(), reads = [];
  const bridge = { history() { const request = deferred(); reads.push(request); return request.promise; },
    archiveHistory: async id => ({ ok: true, id, archived: true }),
    deleteHistory: async id => ({ ok: true, id, deleted: true }), ...overrides };
  const window = {
    SoduWorkAPI: { taskStorageKey: () => owner }, soduWorkAPI: { conversationSession: bridge },
    addEventListener(name, fn) { (events.get(name) || events.set(name, []).get(name)).push(fn); },
  };
  for (const name of ['workspace-chat-history', 'workspace-chat-list']) {
    let source = fs.readFileSync(path.join(__dirname, '../components/workspace', name + '.js'), 'utf8');
    if (name === 'workspace-chat-list') {
      // Exercise production lifecycle and reconciliation; only omit DOM painting.
      const start = source.indexOf('function renderChats() {');
      const end = source.indexOf('function subscribeConversationPresence', start);
      assert.ok(start > 0 && end > start);
      source = source.slice(0, start) + 'function renderChats() {}\n' + source.slice(end);
    }
    vm.runInNewContext(source, { window });
  }
  const ctx = { ...window.WorkspaceChatHistory, root: null, chatItems: [], chatNames: new Map(),
    activeChatId: '', mount() {}, sidebarProjects: { forget() {} } };
  const api = window.WorkspaceChatList.create(ctx); Object.assign(ctx, api);
  return { api, ctx, window, reads, ids: () => Array.from(ctx.chatItems, item => item.id),
    switchAccount(next) { owner = next; for (const fn of events.get('soduwork-data-scope-changed') || []) fn(); },
  };
}
const row = (id = 'conversation') => ({ id, title: 'Saved conversation', at: 100 });
const presence = (value, kind = 'account-conversation-sync') => ({ kind, sessionId: value.id, presence: value });

function persistentSidebar(f) {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/workspace/workspace-sidebar-state.js'), 'utf8'), { window });
  const values = new Map(); let blocked = false, writes = 0, scope = 'account-a';
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => {
    if (blocked) throw Error('sidebar storage unavailable'); writes++; values.set(key, value);
  } };
  const reopen = () => window.WorkspaceSidebarState.create({ storage, key: scope });
  let store = reopen();
  f.ctx.sidebarProjects = { forget: id => store.forget(id), forgetMany: ids => { store.forgetMany(ids); return true; },
    forgetArchived: ids => { store.forgetMany(ids, { preserveArchivedProjects: true }); return true; } };
  return { get store() { return store; }, reopen, values, writes: () => writes,
    block: value => { blocked = value; }, switchAccount(next) { scope = next; store = reopen(); f.switchAccount(next); } };
}

test('confirmed missing-content deletion removes a cached project title across reload while temporary removal does not', async () => {
  const calls = [], f = fixture({ deleteHistory: async (id, options) => {
    calls.push({ id, options });
    return options?.confirmed ? { ok: true, id, deleted: true, missingContent: true }
      : { ok: false, needsConfirm: true, missingContent: true, confirm: { title: 'Permanently delete this missing conversation?' } };
  } });
  f.window.SoduWorkConfirmDialog = { open: async () => true };
  const sidebar = persistentSidebar(f), item = row('missing-chat');
  const project = sidebar.store.saveProject({ name: 'Retained project' });
  sidebar.store.fileChat(item.id, project, item); f.api.setChats([item]);
  f.api.removeChat(item.id);
  assert.deepEqual(f.ids(), []);
  assert.equal(sidebar.reopen().view([]).projects[0].items[0].id, item.id, 'temporary removal must not forget saved organization');
  assert.equal(await f.api.deleteHistoryChat(item.id), true);
  assert.equal(calls.length, 2); assert.equal(calls[1].options.confirmed, true);
  assert.equal(calls[1].options.missingOnly, true);
  assert.equal(sidebar.reopen().view([]).projects[0].items.length, 0);
  assert.equal(sidebar.reopen().get().rows.length, 0);
});

test('content restored during missing-content confirmation is not deleted or removed from the sidebar', async () => {
  const confirm = deferred(), calls = [];
  const f = fixture({ deleteHistory: async (id, options) => {
    calls.push({ id, options });
    if (!options?.confirmed) return { ok: false, needsConfirm: true, missingContent: true, confirm: { title: 'Delete missing title?' } };
    return options.missingOnly ? { ok: false, code: 'HISTORY_CONTENT_RESTORED', reason: 'Content is available again' }
      : { ok: true, id, deleted: true };
  } });
  f.window.SoduWorkConfirmDialog = { open: () => confirm.promise };
  const sidebar = persistentSidebar(f), item = row();
  sidebar.store.move(item, 'pinned', '', [item]); f.api.setChats([item]);
  const action = f.api.deleteHistoryChat(item.id); await tick();
  confirm.resolve(true);
  assert.equal(await action, false);
  assert.equal(calls[1].options.missingOnly, true);
  assert.deepEqual(f.ids(), [item.id]);
  assert.equal(sidebar.reopen().get().pins[0], item.id);
});

test('ordinary deletion confirmation does not add a missing-only constraint without an explicit missing-content flag', async () => {
  for (const missingContent of [undefined, false, 'true']) {
    const calls = [], f = fixture({ deleteHistory: async (id, options) => {
      calls.push({ id, options });
      return options?.confirmed ? { ok: true, id, deleted: true }
        : { ok: false, needsConfirm: true, missingContent, confirm: { title: 'Delete conversation?' } };
    } });
    f.window.SoduWorkConfirmDialog = { open: async () => true }; f.api.setChats([row()]);
    assert.equal(await f.api.deleteHistoryChat('conversation'), true);
    assert.equal(JSON.stringify(calls[1].options), JSON.stringify({ confirmed: true }));
  }
});

test('successful deletion atomically forgets every canonical and authenticated alias snapshot across reload', async () => {
  const aliases = ['account-copy', 'runtime-segment', 'archived-copy'];
  const f = fixture({ deleteHistory: async () => ({ ok: true, id: 'native', aliasIds: aliases, deleted: true }) });
  const sidebar = persistentSidebar(f), native = { ...row('native'), historyAliasIds: aliases };
  const active = sidebar.store.saveProject({ name: 'Active' }), archived = sidebar.store.saveProject({ name: 'Archived' });
  sidebar.store.move(native, 'pinned', '', [native]);
  sidebar.store.move(row('account-copy'), 'recent', '', [row('account-copy')]);
  sidebar.store.fileChat('runtime-segment', active, row('runtime-segment'));
  sidebar.store.fileChat('archived-copy', archived, row('archived-copy')); sidebar.store.archiveProject(archived);
  sidebar.store.fileChat('independent', active, row('independent'));
  f.api.setChats([native, row('independent')]);
  const writes = sidebar.writes();
  assert.equal(await f.api.deleteHistoryChat('account-copy'), true);
  const saved = sidebar.reopen().get();
  assert.deepEqual(Array.from(saved.rows, x => x.id), ['independent']);
  assert.equal(saved.pins.length, 0); assert.equal(saved.recent.length, 0);
  assert.deepEqual(Array.from(saved.projects[0].chatIds), ['independent']);
  assert.equal(saved.archivedProjects[0].chatIds.length, 0);
  assert.equal(sidebar.writes() - writes, 1, 'one deletion must be one atomic sidebar write');
  assert.deepEqual(f.ids(), ['independent']);
});

test('deleting the active alias clears the route and opens a fresh conversation', async () => {
  const opens = [];
  const f = fixture({ deleteHistory: async () => ({ ok: true, id: 'native', aliasIds: ['account-copy'], deleted: true }) });
  f.window.WorkspaceHost = { open: async (...args) => { opens.push(args); return true; } };
  f.api.setChats([{ ...row('native'), historyAliasIds: ['account-copy'] }]);
  f.ctx.activeChatId = 'account-copy';
  assert.equal(await f.api.deleteHistoryChat('account-copy'), true);
  assert.equal(f.ctx.activeChatId, '');
  assert.equal(opens.length, 1);
  assert.equal(opens[0][0], 'create');
  assert.equal(opens[0][1].newSession, true);
  assert.equal(opens[0][1].tab, 'chat');
});

test('archive receipts remove all active aliases while retaining archived project members for restoration', async () => {
  const aliases = ['account-copy', 'segment', 'old-copy'];
  const f = fixture({ archiveHistory: async () => ({ok:true,id:'native',archived:true,aliasIds:aliases}) });
  const sidebar = persistentSidebar(f), native = {...row('native'),historyAliasIds:aliases};
  const active = sidebar.store.saveProject({name:'Active'}), archived = sidebar.store.saveProject({name:'Archived'});
  sidebar.store.move(native,'pinned','',[native]);
  sidebar.store.move(row('account-copy'),'recent','',[row('account-copy')]);
  sidebar.store.fileChat('segment',active,row('segment'));
  sidebar.store.fileChat('old-copy',archived,row('old-copy')); sidebar.store.archiveProject(archived);
  f.api.setChats([native]);
  assert.equal(await f.api.archiveHistoryChat('native'),true);
  const saved = sidebar.reopen().get();
  assert.equal(saved.pins.length,0); assert.equal(saved.recent.length,0); assert.equal(saved.projects[0].chatIds.length,0);
  assert.deepEqual(Array.from(saved.archivedProjects[0].chatIds),['old-copy']);
  assert.deepEqual(Array.from(saved.rows,x=>x.id),['old-copy']);
});

test('cold-start lifecycle batches exceeding the live ledger clear snapshots once without treating missing rows as deletion', async () => {
  const f = fixture(), sidebar = persistentSidebar(f), project = sidebar.store.saveProject({name:'Saved group'});
  const items=Array.from({length:1100},(_,index)=>row('archived-'+index));
  const saved=sidebar.store.get();saved.projects.find(item=>item.id===project).chatIds=[...items.map(item=>item.id),'independent'];
  saved.rows=[...items,row('independent')];sidebar.values.set('account-a',JSON.stringify(saved));
  const lifecycle=items.map((item,index)=>({...item,archived:true,deleted:false,lifecycleRevision:index+1}));
  const writes=sidebar.writes(), read=f.api.refreshConversationHistory();await tick();
  f.reads[0].resolve({ok:true,chats:[],lifecycle});assert.equal(await read,true);
  assert.deepEqual(Array.from(sidebar.reopen().get().rows,x=>x.id),['independent']);
  assert.equal(sidebar.writes()-writes,1,'a large lifecycle directory uses one atomic archive cleanup');
  assert.equal(sidebar.reopen().view([]).projects[0].items[0].id,'independent','absence alone preserves saved groups');
});

test('a stale history lifecycle receipt cannot clear grouping restored by a newer live action', async () => {
  const f = fixture(), sidebar=persistentSidebar(f), item=row();
  f.api.setChats([item]);const read=f.api.refreshConversationHistory();await tick();
  f.api.updateChatState(presence({...item,archived:true,lifecycleRevision:2},'history-lifecycle'));
  f.api.updateChatState(presence({...item,archived:false,deleted:false,lifecycleRevision:3},'history-lifecycle'));
  sidebar.store.move(item,'pinned','',[item]);const saved=sidebar.values.get('account-a');
  f.reads[0].resolve({ok:true,chats:[],lifecycle:[{...item,archived:true,lifecycleRevision:2}]});
  assert.equal(await read,false);assert.equal(sidebar.values.get('account-a'),saved);
});

test('sidebar persistence failure after backend deletion remains retryable without reporting complete cleanup', async () => {
  const f = fixture(), sidebar = persistentSidebar(f), item = row();
  sidebar.store.move(item, 'pinned', '', [item]); f.api.setChats([item]);
  sidebar.block(true);
  assert.equal(await f.api.deleteHistoryChat(item.id), false);
  assert.equal(sidebar.reopen().get().pins[0], item.id);
  sidebar.block(false);
  assert.equal(await f.api.deleteHistoryChat(item.id), true);
  assert.equal(sidebar.reopen().get().rows.length, 0);
});

test('offline, denied and cancelled deletion preserve cached titles; late success cannot clean the next account', async () => {
  const pending = deferred(); let reply = { ok: false, reason: 'offline' };
  const f = fixture({ deleteHistory: () => reply }), sidebar = persistentSidebar(f), item = row();
  sidebar.store.move(item, 'pinned', '', [item]); f.api.setChats([item]);
  for (const response of [{ ok: false, reason: 'offline' }, { ok: false, code: 'HISTORY_OWNER_UNKNOWN' }, { ok: false, cancelled: true }]) {
    reply = response; assert.equal(await f.api.deleteHistoryChat(item.id), false);
    assert.equal(sidebar.reopen().get().pins[0], item.id);
  }
  reply = pending.promise; const action = f.api.deleteHistoryChat(item.id);
  sidebar.switchAccount('account-b'); sidebar.store.move(item, 'pinned', '', [item]);
  const accountB = sidebar.values.get('account-b'), accountA = sidebar.values.get('account-a');
  pending.resolve({ ok: true, id: item.id, deleted: true });
  assert.equal(await action, false);
  assert.equal(sidebar.values.get('account-b'), accountB); assert.equal(sidebar.values.get('account-a'), accountA);
});

for (const operation of ['archiveHistoryChat', 'deleteHistoryChat']) {
  test(operation + ' rejects an older history response and late ordinary presence', async () => {
    const f = fixture(), item = row(); f.api.setChats([item]);
    const old = f.api.refreshConversationHistory(); await tick();
    assert.equal(await f.api[operation](item.id), true);
    assert.deepEqual(f.ids(), []);
    f.reads[0].resolve({ ok: true, chats: [item] }); await old;
    assert.deepEqual(f.ids(), [], 'a pre-mutation history read cannot resurrect the row');
    f.api.updateChatState(presence(item));
    f.api.upsertChat(item);
    f.api.setChats([item]);
    assert.deepEqual(f.ids(), [], 'ordinary events and history cannot undo a successful mutation');
    const next = f.api.refreshConversationHistory(); await tick();
    assert.equal(f.reads.length, 2, 'a fresh read is not held behind the invalidated request');
    f.reads[1].resolve({ ok: true, chats: [item, row('other')] }); await next;
    assert.deepEqual(f.ids(), ['other']);
  });
}

test('mutation receipts suppress canonical and authenticated aliases without hiding an independent namesake', async () => {
  const f = fixture({ archiveHistory: async () => ({ ok: true, id: 'native', aliasIds: ['account-copy'], archived: true }) });
  const native = { ...row('native'), historyAliasIds: ['account-copy', 'runtime-segment'] };
  f.api.setChats([native, row('independent')]);
  assert.equal(await f.api.archiveHistoryChat('account-copy'), true);
  assert.deepEqual(f.ids(), ['independent']);
  for (const id of ['native', 'account-copy', 'runtime-segment']) f.api.updateChatState(presence(row(id)));
  f.api.setChats([native, row('account-copy'), row('independent')]);
  assert.deepEqual(f.ids(), ['independent']);
});

for (const flag of ['archived', 'deleted']) {
  test(flag + ' events require explicit restore and reject older lifecycle revisions afterwards', () => {
    const f = fixture(), item = row(); f.api.setChats([item]);
    f.api.updateChatState(presence({ ...item, [flag]: true, lifecycleRevision: 2 }, 'history-lifecycle'));
    f.api.updateChatState(presence({ ...item, archived: false, deleted: false, lifecycleRevision: 3 }));
    assert.deepEqual(f.ids(), [], 'ordinary non-archived presence is not a restore command');
    f.api.updateChatState(presence({ ...item, archived: false, deleted: false, lifecycleRevision: 4 }, 'history-lifecycle'));
    assert.deepEqual(f.ids(), [item.id]);
    f.api.updateChatState(presence({ ...item, [flag]: true, lifecycleRevision: 2 }, 'history-lifecycle'));
    assert.deepEqual(f.ids(), [item.id], 'an older lifecycle event cannot reverse an explicit restore');
  });
}

test('restore without a title refetches history, releases aliases and fences the older read', async () => {
  const f = fixture(), item = { ...row('native'), historyAliasIds: ['account-copy'] };
  f.api.setChats([item]);
  const old = f.api.refreshConversationHistory(); await tick();
  f.api.updateChatState(presence({ id: 'account-copy', historyAliasIds: ['native'], archived: true, revision: 1 }, 'history-lifecycle'));
  f.api.updateChatState(presence({ id: 'account-copy', archived: false, deleted: false, revision: 2 }, 'history-lifecycle'));
  await tick();
  assert.equal(f.reads.length, 2, 'a lifecycle restore must fetch the current title/history');
  const current = f.ctx.historyLoad;
  f.reads[1].resolve({ ok: true, chats: [item] }); await current;
  f.reads[0].resolve({ ok: true, chats: [{ ...item, archived: true }] }); await old;
  assert.deepEqual(f.ids(), ['native']);
  assert.equal(f.ctx.chatItems[0].archived, undefined, 'the pre-restore snapshot must not overwrite fresh data');
});

test('failed or cancelled mutations leave the visible conversation and its future updates intact', async () => {
  const f = fixture({ archiveHistory: async () => ({ ok: false, reason: 'offline' }),
    deleteHistory: async () => ({ ok: false, cancelled: true }) });
  f.api.setChats([row()]);
  assert.equal(await f.api.archiveHistoryChat('conversation'), false);
  assert.equal(await f.api.deleteHistoryChat('conversation'), false);
  f.api.updateChatState(presence({ ...row(), title: 'Updated normally' }));
  assert.deepEqual(f.ids(), ['conversation']);
  assert.equal(f.ctx.chatItems[0].title, 'Updated normally');
});

test('account change clears suppression and a previous account mutation response cannot hide the next account row', async () => {
  const mutation = deferred();
  const f = fixture({ archiveHistory: () => mutation.promise });
  f.api.setChats([row('already-hidden'), row()]);
  f.api.updateChatState(presence({ ...row('already-hidden'), archived: true }, 'history-lifecycle'));
  const pending = f.api.archiveHistoryChat('conversation');
  f.switchAccount('account-b');
  f.api.setChats([row('already-hidden'), row()]);
  mutation.resolve({ ok: true, id: 'conversation', archived: true }); await pending;
  assert.deepEqual(new Set(f.ids()), new Set(['already-hidden', 'conversation']));
});

test('a confirmation accepted after switching accounts cannot dispatch deletion under the next account', async () => {
  const confirm = deferred(), calls = [];
  const f = fixture({ deleteHistory: async (id, options) => {
    calls.push({ id, options }); return options?.confirmed ? { ok: true, id, deleted: true }
      : { ok: false, needsConfirm: true, confirm: { title: 'Delete?' } };
  } });
  f.window.SoduWorkConfirmDialog = { open: () => confirm.promise };
  f.api.setChats([row()]); const deleting = f.api.deleteHistoryChat('conversation'); await tick();
  f.switchAccount('account-b'); f.api.setChats([row()]);
  confirm.resolve(true); await deleting;
  assert.equal(calls.length, 1, 'the second destructive IPC must not cross the account boundary');
  assert.deepEqual(f.ids(), ['conversation']);
});

test('duplicate lifecycle events and their mutation receipt do not invalidate a fresh history read', async () => {
  const mutation = deferred(), f = fixture({ archiveHistory: () => mutation.promise });
  f.api.setChats([row()]); const action = f.api.archiveHistoryChat('conversation');
  const changed = { ...row(), archived: true, lifecycleRevision: 2 };
  f.api.updateChatState(presence(changed, 'history-lifecycle'));
  const fresh = f.api.refreshConversationHistory(); await tick();
  f.api.updateChatState(presence(changed, 'history-lifecycle'));
  mutation.resolve({ ok: true, ...changed }); await action;
  assert.equal(f.ctx.historyLoad, fresh);
  f.reads[0].resolve({ ok: true, chats: [row('other')] }); assert.equal(await fresh, true);
  assert.deepEqual(f.ids(), ['other']);
});

test('a late unversioned mutation receipt cannot reverse a newer explicit restore', async () => {
  const mutation = deferred(), f = fixture({ archiveHistory: () => mutation.promise });
  f.api.setChats([row()]); const action = f.api.archiveHistoryChat('conversation');
  f.api.updateChatState(presence({ ...row(), archived: true }, 'history-lifecycle'));
  f.api.updateChatState(presence({ ...row(), archived: false, deleted: false }, 'history-lifecycle'));
  mutation.resolve({ ok: true, id: 'conversation', archived: true }); await action;
  assert.deepEqual(f.ids(), ['conversation']);
});

test('bounded lifecycle bookkeeping falls back to authoritative history for unknown late presence', async () => {
  const f = fixture();
  for (let i = 0; i < 1100; i++) {
    f.api.updateChatState(presence({ ...row('archived-' + i), archived: true }, 'history-lifecycle'));
  }
  f.api.updateChatState(presence(row('archived-0')));
  await tick(); assert.equal(f.reads.length, 1);
  const confirmation = f.ctx.historyLoad;
  assert.deepEqual(f.ids(), [], 'eviction must not let old presence insert an unconfirmed row');
  f.reads[0].resolve({ ok: true, chats: [] }); await confirmation;
  assert.deepEqual(f.ids(), []);
  f.api.updateChatState(presence(row('new-conversation')));
  await tick(); const next = f.ctx.historyLoad;
  f.reads[1].resolve({ ok: true, chats: [row('new-conversation')] }); await next;
  assert.deepEqual(f.ids(), ['new-conversation'], 'a genuine new conversation is still discoverable');
});

test('content refreshes carrying the same explicit lifecycle revision preserve an in-flight history read', async () => {
  const f = fixture(), restored = { ...row(), archived: false, deleted: false, lifecycleRevision: 4, revision: 4 };
  f.api.updateChatState(presence(restored, 'history-lifecycle'));
  const reading = f.api.refreshConversationHistory(); await tick();
  f.api.updateChatState(presence({ ...restored, title: 'New content title', revision: 5 }, 'history-lifecycle'));
  assert.equal(f.ctx.historyLoad, reading, 'content revisions cannot invalidate the lifecycle generation');
  assert.equal(f.ctx.chatItems[0].title, 'New content title');
  f.reads[0].resolve({ ok: true, chats: [{ ...restored, title: 'New content title', revision: 5 }, row('other')] });
  assert.equal(await reading, true);
  assert.equal(f.ids().includes('other'), true);
});

test('a late unversioned archived presence cannot hide a conversation explicitly restored at a newer lifecycle revision', () => {
  const f = fixture();
  f.api.updateChatState(presence({ ...row(), archived: true, lifecycleRevision: 2 }, 'history-lifecycle'));
  f.api.updateChatState(presence({ ...row(), archived: false, deleted: false, lifecycleRevision: 4 }, 'history-lifecycle'));
  f.api.updateChatState(presence({ ...row(), archived: true }));
  assert.deepEqual(f.ids(), ['conversation']);
});


test('empty review projections remove only exact sidebar aliases without lifecycle deletion and can later become real chats', async () => {
  const f = fixture();
  f.api.updateChatState(presence(row('native-empty')));
  f.api.updateChatState(presence(row('cloud-real')));
  const empty = { ...row('account-empty'), accountConversation: true,
    sourceSessionId: 'native-empty', emptyPlaceholder: true };
  f.api.updateChatState(presence(empty));
  assert.deepEqual(f.ids(), ['cloud-real']);
  const read = f.api.refreshConversationHistory(); await tick();
  f.reads[0].resolve({ ok: true, chats: [empty, row('cloud-real')] }); await read;
  assert.deepEqual(f.ids(), ['cloud-real']);
  f.api.updateChatState(presence({ ...empty, emptyPlaceholder: false, title: 'Submitted review' }));
  assert.equal(f.ids().includes('account-empty'), true);
  assert.equal(f.ids().includes('cloud-real'), true);
});
