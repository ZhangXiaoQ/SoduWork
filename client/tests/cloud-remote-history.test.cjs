'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { create } = require('../main/conversation/cloud-handoff');

function identity(uid = 'alice') {
  return { hub: 'http://127.0.0.1:18989', clientId: 'desktop',
    session: Buffer.from(JSON.stringify({ typ: 'device', uid, cid: 'desktop', iat: Math.floor(Date.now() / 1000) - 10, exp: 9999999999 }))
      .toString('base64url') + '.' + 'a'.repeat(64) };
}

test('desktop opens a mobile cloud conversation through the Hub directory projection', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-cloud-remote-history-'));
  let current = identity(), polls = 0;
  const requests = [];
  const request = async (_identity, route) => {
    requests.push(route);
    if (route.startsWith('/cloud-conversations')) return { ok: true, chats: [{
      id: 'cloud-mobile-1', sessionId: 'cloud-mobile-1', taskId: 'task-mobile-1', ref: 'run-mobile-1',
      title: 'Mobile request', state: 'running', remoteState: 'running', adapterId: 'pi', model: 'model-a',
      at: '2026-10-31T03:34:32Z',
      target: { runnerKind: 'work-computer', runnerName: 'Office PC', runnerId: 'runner:office' },
      canContinue: true, canSend: true,
    }] };
    if (route.endsWith('/ai-say')) return { ok: true, accepted: true, delivery: 'accepted' };
    if (route.includes('/ai-session?')) {
      polls++;
      return { ok: true, ref: 'run-mobile-1', status: 'completed', last: 2, items: [
        { kind: 'user', seq: 1, text: 'Mobile prompt' },
        { kind: 'say', seq: 2, text: 'Desktop replay' },
      ] };
    }
    if (route.endsWith('/ai-status')) return { ok: true, status: 'completed' };
    if (route.endsWith('/attachments')) return [];
    assert.fail('unexpected route ' + route);
  };
  const controller = create({ app: { getPath: () => root }, identityOf: async () => current,
    request, remoteDirectory: true, interval: 60000 });
  t.after(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  const history = await controller.history();
  assert.equal(history.chats.length, 1);
  assert.equal(history.chats[0].id, 'cloud-mobile-1');
  assert.equal(history.chats[0].location, 'work-computer');
  assert.equal(history.chats[0].readOnly, false);
  assert.equal(history.chats[0].canSend, true);
  assert.equal(history.chats[0].at, Date.parse('2026-10-31T03:34:32Z'));

  // Exercise the actual sidebar ownership filter, not a stubbed access layer.
  const app = { getPath: () => root };
  const access = require('../main/conversation/history-access');
  const cards = require('../main/conversation/work-conversation-cards');
  const captured = access.actor(app, current);
  assert.doesNotThrow(() => access.assertOwner(app, history.chats[0].id, captured, history.chats[0]));
  assert.equal(cards.visibleHistory(app, history.chats, current).length, 1);
  assert.equal(cards.visibleHistory(app, history.chats, identity('bob')).length, 0);
  assert.equal(cards.visibleHistory(app, history.chats, { ...current, hub: 'http://127.0.0.1:18990' }).length, 0);
  assert.equal(cards.visibleHistory(app, history.chats, { ...current, clientId: 'other-device' }).length, 0);
  for (const patch of [{ owner: captured.owner }, { ref: '' }, { taskId: '' }, { cloud: false }]) {
    assert.equal(cards.visibleHistory(app, [{ ...history.chats[0], ...patch }], current).length, 0);
  }

  const view = await controller.reopen('cloud-mobile-1', 'desktop-view');
  t.after(() => view?.close());
  for (let i = 0; i < 40 && polls === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(view.passiveCloudView, true);
  assert.equal(view.historyRow().remoteProjection, true, 'live updates retain their directory identity');
  assert.equal(view.historyRow().at, history.chats[0].at, 'opening and polling do not bump history time');
  assert.ok(view.snapshot().messages.some(row => row.text === 'Mobile prompt'));
  assert.ok(view.snapshot().messages.some(row => row.blocks?.some(block => block.text === 'Desktop replay')));
  const sent = await view.send('Continue from desktop');
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(view.historyRow().at, history.chats[0].at, 'a local ACK cannot invent a new Hub activity time');
  assert.deepEqual(await controller.forget('cloud-mobile-1'), {
    ok: false, reason: 'remote conversation must be managed by its source task',
  });
  assert.ok(requests.some(route => route.startsWith('/cloud-conversations')));
  assert.ok(requests.some(route => route.includes('/tasks/task-mobile-1/ai-session?')));
  current = identity('bob');
  assert.equal(controller.isRemote('cloud-mobile-1'), true, 'stale cache is still ownership checked on open');
  await assert.rejects(controller.reopen('cloud-mobile-1', 'wrong-account-view'));
});

test('unavailable cloud discovery leaves unknown archives to local ownership checks', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-cloud-discovery-offline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  let current = identity(), requests = 0;
  const controller = create({ app: { getPath: () => root }, remoteDirectory: true,
    identityOf: async () => current,
    request: async () => { requests++; throw Error('offline fixture'); } });
  assert.equal(await controller.reopen('local-archive', 'view'), null);
  assert.equal(requests, 1);
  current = { ...current, session: '' };
  assert.equal(await controller.reopen('local-archive', 'view-expired'), null);
  assert.equal(requests, 1, 'invalid credentials never reach the cloud directory');
});

test('remote directory and persisted sync receipt expose one history row per task', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-cloud-history-alias-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const actor = identity(), cachedId = 'cloud-sync-cached-p3';
  const receiptRoot = path.join(root, 'conversation-handoffs');
  await fs.mkdir(receiptRoot);
  const filename = require('node:crypto').createHash('sha256').update(cachedId).digest('hex') + '.json';
  await fs.writeFile(path.join(receiptRoot, filename), JSON.stringify({
    sessionId: cachedId, taskId: 'task-p3', syncId: 'sync-p3', transferId: 'p3-transfer', entryKind: 'cloud', title: 'P3',
    owner: require('../main/platform-connections/runtime.cjs').connectionScope(actor),
    phase: 'committed', adapterId: 'pi', at: 100,
  }));
  let latest, messages = [];
  const openController = () => create({ app: { getPath: () => root }, identityOf: async () => actor,
    remoteDirectory: true, request: async (_, route) => {
      if (route.startsWith('/cloud-execution-sync/')) {
        const url = new URL(route, 'http://test.invalid');
        assert.equal(url.pathname, '/cloud-execution-sync/sync-p3');
        assert.equal(url.searchParams.has('ref'), false);
        return { ok: true, conversation: { id: 'sync-p3', receipt: { taskId: 'task-p3' } }, page: latest, messages };
      }
      return {ok: true, chats: [
      {sessionId: 'mobile-p3', taskId: 'task-p3', ref: 'run-p3', title: '自动验收 · P3 · 第2版',
        conversationReview: {mode: 'auto', taskId: 'requirement', artifactSeq: 2}, canSend: true},
      {sessionId: 'mobile-other', taskId: 'task-other', ref: 'run-other', title: 'P3', canSend: true},
      ]};
    } });
  const controller = openController();
  const result = await controller.history();
  assert.deepEqual(result.chats.map(row => row.id), [cachedId, 'mobile-other']);
  assert.deepEqual(result.chats[0].historyAliasIds, ['mobile-p3']);
  assert.equal(result.chats[0].title, '自动验收 · P3 · 第2版', 'old replay receipt must not erase the authoritative review label');
  assert.equal(result.chats[1].title, 'P3', 'namesake ordinary conversation is unchanged');

  // Work cards are restored before opening the passive execution view. A
  // previously rendered directory ID must remain resolvable after sync wins
  // sidebar deduplication, without ever starting a local model session.
  const app = { getPath: () => root };
  const bridge = require('../main/agent-runtime/pi-session-bridge').createPiSessionBridge({
    app, runnerAdapters: [], sessionModule: {
      probe: async () => ({ ok: true }),
      history: async () => ({ ok: true, chats: [] }),
      historyEntry: async () => ({ ok: false, notFound: true }),
      open: async () => assert.fail('history lookup must not start execution'),
    },
  });
  t.after(() => bridge.dispose());
  const cards = require('../main/conversation/work-conversation-cards').create({
    app, session: bridge, identityOf: async () => actor,
  });
  bridge.setExternalHistory({ history: () => controller.history() });
  assert.equal((await cards.read('mobile-p3')).ok, false, 'deduplicated inventory reproduces the opening failure');
  bridge.setExternalHistory(controller);
  const restored = await cards.read('mobile-p3');
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(restored.presence.id, 'mobile-p3');
  assert.equal(restored.presence.taskId, 'task-p3');
  assert.deepEqual(restored.cards, []);
  assert.equal((await cards.read('unknown-same-title')).ok, false);
  const resolved = await bridge.archivedConversation(app, 'mobile-p3');
  const access = require('../main/conversation/history-access');
  assert.doesNotThrow(() => access.assertOwner(app, 'mobile-p3', access.actor(app, actor), resolved));
  assert.throws(() => access.assertOwner(app, 'mobile-p3', access.actor(app, identity('bob')), resolved));
  assert.throws(() => access.assertOwner(app, 'mobile-p3', access.actor(app,
    { ...actor, hub: 'http://127.0.0.1:18990' }), resolved));
  assert.deepEqual((await controller.history()).chats.map(row => row.id), [cachedId, 'mobile-other']);
  for (const status of ['queued', 'dispatching', 'running']) {
    latest = { ok: true, ref: 'newer-round', status, done: true };
    await assert.rejects(controller.forget(cachedId), /仍在执行/);
  }
  for (const fields of [{ status: 'unknown' }, { status: 'done', liveError: 'offline' },
    { status: 'done', taskId: 'wrong-task' }, { ok: false }]) {
    latest = { ok: true, ref: 'newer-round', ...fields };
    await assert.rejects(controller.forget(cachedId), /无法确认/);
  }
  assert.deepEqual((await controller.history()).chats.map(row => row.id), [cachedId, 'mobile-other']);
  latest = { ok: true, ref: 'newer-round', status: 'done', liveError: 'offline',
    persisted: true, taskId: 'task-p3', finishedAt: '2026-11-03T07:46:00Z' };
  messages = [{ phase: 'sending' }];
  await assert.rejects(controller.forget(cachedId), /待处理/);
  messages = [];
  assert.deepEqual(await controller.forget(cachedId), { ok: true, id: cachedId });
  assert.deepEqual((await controller.history({ includeAliases: true })).chats.map(row => row.id), ['mobile-other']);
  assert.deepEqual((await openController().history()).chats.map(row => row.id), ['mobile-other']);
});
