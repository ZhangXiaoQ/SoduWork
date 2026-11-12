'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(loadHistory, { authenticated = true } = {}) {
  const window = {
    SoduWorkAPI: { hubBase: () => 'https://sidebar-fixture.invalid',
      clientAuthSnapshot: () => ({ clientId: 'fixture-device', user: authenticated ? { id: 'fixture-user' } : null }) },
    soduWorkAPI: { conversationSession: { history: loadHistory } },
  };
  for (const name of ['workspace-chat-history', 'workspace-sidebar-state', 'workspace-chat-list']) {
    let source = fs.readFileSync(path.join(__dirname, '../components/workspace', name + '.js'), 'utf8');
    if (name === 'workspace-chat-list') {
      // Keep the production event/reconciliation path; only omit DOM painting.
      const start = source.indexOf('function renderChats() {');
      const end = source.indexOf('function subscribeConversationPresence', start);
      assert.ok(start > 0 && end > start);
      source = source.slice(0, start) + 'function renderChats() {}\n' + source.slice(end);
    }
    vm.runInNewContext(source, { window, URL });
  }
  const history = window.WorkspaceChatHistory;
  const ctx = { ...history, root: null, chatItems: [], chatNames: new Map(), activeChatId: '', mount() {} };
  const api = window.WorkspaceChatList.create(ctx);
  ctx.upsertChat = api.upsertChat;
  ctx.setChats = api.setChats;
  ctx.renderChats = api.renderChats;
  return { history, ctx, api, ids: () => Array.from(ctx.chatItems, row => row.id) };
}

const cloud = { id: 'mobile:n1', taskId: 'task-n1', title: 'N1', cloud: true, adapterId: 'pi', at: 100 };
const copy = { id: 'acct-n1', sourceSessionId: 'mobile:n1', title: 'N1', accountConversation: true,
  at: '2026-10-31T06:57:33Z' };
const other = { id: 'other', title: 'Other', at: 200 };

test('signed-out cloud alias invalidation cannot start an authenticated history read', async () => {
  let reads = 0;
  const f = fixture(() => { reads++; return { ok: true, chats: [cloud, other] }; }, { authenticated: false });
  f.api.setChats([other, cloud]);
  f.api.upsertChat({ id: 'unconfirmed', taskId: cloud.taskId, title: cloud.title, cloud: true });
  assert.equal(await f.api.refreshConversationHistory(), false);
  assert.equal(reads, 0);
  assert.deepEqual(f.ids(), [other.id, cloud.id]);
});

test('archived and deleted account presence remove rows without resurrecting them', () => {
  const f = fixture();
  for (const flag of ['archived', 'deleted']) {
    f.api.setChats([other, copy]);
    const event = { sessionId: copy.id, presence: { ...copy, [flag]: true } };
    f.api.updateChatState(event);
    assert.deepEqual(f.ids(), [other.id]);
    f.api.updateChatState(event);
    assert.deepEqual(f.ids(), [other.id]);
  }
  f.api.updateChatState({ sessionId: copy.id, presence: { ...copy, archived: false } });
  assert.equal(f.ids().includes(copy.id), false, 'ordinary presence cannot implicitly restore an archived/deleted conversation');
  f.api.updateChatState({ kind: 'history-lifecycle', sessionId: copy.id,
    presence: { ...copy, archived: false, deleted: false } });
  assert.ok(f.ids().includes(copy.id));
});

test('opening a cloud task before its alias is known does not insert a temporary first row', async () => {
  const partial = { id: 'runtime-segment', taskId: cloud.taskId, title: cloud.title, collaboration: true, at: 300 };
  let reads = 0;
  const f = fixture(() => {
    reads++;
    return { ok: true, chats: [{ ...cloud, historyAliasIds: [partial.id] }, other] };
  });
  f.api.setChats([other, cloud]);
  f.api.setActiveChat(cloud.id);
  const key = f.ctx.chatItems[1]._uiKey;
  f.api.upsertChat(partial);
  f.api.updateChatState({ sessionId: partial.id, presence: { ...partial, cloud: true } });
  assert.deepEqual(f.ids(), [other.id, cloud.id]);
  await f.ctx.historyLoad;
  assert.equal(reads, 1);
  assert.deepEqual(f.ids(), [other.id, cloud.id]);
  assert.equal(f.ctx.chatItems[1]._uiKey, key);
  assert.equal(f.ctx.activeChatId, cloud.id);
});

test('history can confirm a distinct new conversation sharing a cloud task', async () => {
  const independent = { ...cloud, id: 'independent', at: 300 };
  const f = fixture(() => ({ ok: true, chats: [independent, other, cloud] }));
  f.api.setChats([other, cloud]);
  f.api.updateChatState({ sessionId: independent.id, presence: independent });
  assert.deepEqual(f.ids(), [other.id, cloud.id]);
  await f.ctx.historyLoad;
  assert.deepEqual(f.ids(), [independent.id, other.id, cloud.id]);
});

test('authenticated native aliases replace stale account rows during live rework without waiting for a list refresh', () => {
  const f = fixture();
  const alias = { ...copy, id: 'account-rework', sourceSessionId: 'runtime-segment', accountCanSend: true, at: 150 };
  const native = { id: 'public-conversation', title: 'N1', adapterId: 'pi', historyAliasIds: [alias.id], at: 100 };
  f.api.setChats([other, alias]);
  const key = f.ctx.chatItems[1]._uiKey;
  for (let i = 0; i < 4; i++) {
    f.api.updateChatState({ kind: 'account-conversation-sync', sessionId: native.id, presence: native });
    f.api.setChats([alias, native, other]);
    assert.deepEqual(f.ids(), [other.id, native.id]);
    assert.equal(f.ctx.chatItems[1]._uiKey, key);
  }
});

test('native PC presence and its owned account projection remain one stable entry', () => {
  const f = fixture();
  const native = {id: 'native-p1', title: 'P1', adapterId: 'pi', at: 100};
  const alias = {...copy, id: 'acct-p1', sourceSessionId: native.id, accountCanSend: true, at: 150};
  f.api.setChats([other, native]);
  const key = f.ctx.chatItems[1]._uiKey;
  for (let index = 0; index < 5; index++) {
    f.api.updateChatState({kind: 'account-conversation-sync', sessionId: alias.id, presence: alias});
    assert.deepEqual(f.ids(), [other.id, native.id]);
    f.api.setChats([alias, native, other]);
    assert.deepEqual(f.ids(), [other.id, native.id]);
    assert.equal(f.ctx.chatItems[1]._uiKey, key);
  }
});

test('native arrival replaces an owned alias in place but preserves foreign and archived records', () => {
  const f = fixture();
  const native = {id: 'native-p1', title: 'P1', adapterId: 'pi', at: 100};
  const alias = {...copy, id: 'acct-p1', sourceSessionId: native.id, accountCanSend: true, at: 150};
  const foreign = {...alias, id: 'foreign', accountCanSend: false};
  const archived = {...alias, id: 'archived', archived: true};
  f.api.setChats([other, alias, foreign, archived]);
  const key = f.ctx.chatItems[1]._uiKey;
  f.api.updateChatState({sessionId: native.id, presence: native});
  assert.deepEqual(f.ids(), [other.id, native.id, foreign.id, archived.id]);
  assert.equal(f.ctx.chatItems[1]._uiKey, key);
});

test('cloud presence and account invalidations cannot duplicate or reorder an existing conversation', () => {
  const f = fixture();
  f.api.setChats([other, cloud]);
  const key = f.ctx.chatItems[1]._uiKey;
  f.api.setActiveChat(cloud.id);
  for (let i = 0; i < 5; i++) {
    f.api.updateChatState({ kind: 'account-conversation-sync', sessionId: copy.id, presence: copy });
    f.api.updateChatState({ sessionId: cloud.id, presence: { ...cloud, state: i % 2 ? 'running' : 'completed' } });
    f.api.setChats([copy, cloud, other]);
    f.api.setActiveChat(other.id);
    f.api.setActiveChat(cloud.id);
    assert.deepEqual(f.ids(), [other.id, cloud.id]);
    assert.equal(f.ctx.chatItems[1]._uiKey, key);
    assert.equal(f.ctx.activeChatId, cloud.id);
  }
});

test('a cloud directory replaces a visible sync alias in place, retaining independent namesakes', () => {
  const f = fixture();
  const namesake = { ...copy, id: 'acct-independent', sourceSessionId: 'different-source' };
  f.api.setChats([other, { ...copy, at: 150 }, { ...namesake, at: 50 }]);
  const key = f.ctx.chatItems[1]._uiKey;
  f.api.setChats([cloud, copy, namesake, other]);
  assert.deepEqual(f.ids(), [other.id, cloud.id, namesake.id]);
  assert.equal(f.ctx.chatItems[1]._uiKey, key);
  f.api.setChats([namesake, cloud, other]);
  assert.deepEqual(f.ids(), [other.id, cloud.id, namesake.id]);
});

test('an alias preceding cloud presence is replaced without jumping ahead of existing rows', () => {
  const f = fixture();
  f.api.setChats([other, { ...copy, at: 150 }]);
  f.api.updateChatState({ sessionId: cloud.id, presence: cloud });
  assert.deepEqual(f.ids(), [other.id, cloud.id]);
});

test('missing cloud access, archived aliases and distinct sources remain visible', () => {
  const f = fixture();
  f.api.setChats([copy]);
  assert.deepEqual(f.ids(), [copy.id]);
  const archived = { ...copy, id: 'acct-archived', archived: true };
  const legacy = { ...copy, id: 'acct-old-alias', sourceSessionId: 'cloud-task:task-n1' };
  f.api.setChats([cloud, archived, legacy]);
  assert.deepEqual(new Set(f.ids()), new Set([cloud.id, archived.id]));
  assert.equal(f.history._chatAt({ at: '2026-10-31T06:57:33Z' }), Date.parse(copy.at));
  assert.equal(f.history._chatAt({ at: 'invalid' }), 0);
  assert.equal(f.history._chatAt({ at: 0 }), 0);
  assert.equal(f.history._chatAt({ at: '0' }), 0);
});

test('native review sync aliases do not appear and disappear during history and presence refreshes', () => {
  const f = fixture();
  const native = { id: 'native-review', title: 'Review', adapterId: 'pi', at: 100 };
  const alias = { ...copy, id: 'acct-review', sourceSessionId: native.id, title: native.title };
  const independent = { ...native, id: 'other-review', at: 50 };
  f.api.setChats([other, native, independent]);
  const key = f.ctx.chatItems[1]._uiKey;
  for (let i = 0; i < 6; i++) {
    f.api.updateChatState({ kind: 'account-conversation-sync', sessionId: alias.id, presence: alias });
    f.api.setChats(i % 2 ? [alias, native, other, independent] : [native, other, independent]);
    assert.deepEqual(f.ids(), [other.id, native.id, independent.id]);
    assert.equal(f.ctx.chatItems[1]._uiKey, key);
  }
  const second = fixture();
  second.api.setChats([other, { ...alias, at: 150 }]);
  const aliasKey = second.ctx.chatItems[1]._uiKey;
  second.api.updateChatState({ sessionId: native.id, presence: native });
  assert.deepEqual(second.ids(), [other.id, native.id]);
  assert.equal(second.ctx.chatItems[1]._uiKey, aliasKey);
  const remoteOnly = fixture();
  remoteOnly.api.setChats([alias]);
  assert.deepEqual(remoteOnly.ids(), [alias.id]);
  remoteOnly.api.setChats([alias, { ...native, archived: true }]);
  assert.ok(remoteOnly.ids().includes(alias.id));
});

test('task directory and cached execution aliases stay one stable sidebar entry', () => {
  const f = fixture();
  const remote = {...cloud, id: 'mobile-p3', taskId: 'task-p3', remoteProjection: true};
  const cached = {...cloud, id: 'cloud-sync-p3', taskId: 'task-p3'};
  const namesake = {...remote, id: 'mobile-other', taskId: 'different-task'};
  f.api.setChats([other, remote, namesake]);
  const key = f.ctx.chatItems[1]._uiKey;
  f.api.updateChatState({sessionId: cached.id, presence: cached});
  assert.deepEqual(f.ids(), [other.id, cached.id, namesake.id]);
  assert.equal(f.ctx.chatItems[1]._uiKey, key);
  for (let i = 0; i < 3; i++) {
    f.api.updateChatState({sessionId: remote.id, presence: remote});
    f.api.setChats([remote, namesake, cached, other]);
    assert.deepEqual(f.ids(), [other.id, cached.id, namesake.id]);
    assert.equal(f.ctx.chatItems[1]._uiKey, key);
  }
  const fresh = fixture();
  fresh.api.setChats([remote, cached]);
  assert.deepEqual(fresh.ids(), [cached.id]);
});

test('opening and continuing a directory alias cannot reinsert a partial task row', () => {
  const f = fixture();
  const cached = {...cloud, id: 'cloud-sync-p3', taskId: 'task-p3', historyAliasIds: ['mobile-p3']};
  const opening = {id: 'mobile-p3', title: 'P3', taskId: 'task-p3', collaboration: true};
  const namesake = {...opening, id: 'independent'};
  f.api.setChats([other, cached, namesake]);
  const key = f.ctx.chatItems.find(row => row.id === cached.id)._uiKey;
  for (const state of ['idle', 'starting', 'running', 'completed']) {
    f.api.upsertChat({...opening, state});
    f.api.updateChatState({sessionId: opening.id, presence: {...opening, cloud: true, state}});
    f.api.setChats([cached, other, namesake]);
    assert.deepEqual(f.ids(), [other.id, cached.id, namesake.id]);
    assert.equal(f.ctx.chatItems.find(row => row.id === cached.id)._uiKey, key);
  }
});
