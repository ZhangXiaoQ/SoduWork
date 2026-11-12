'use strict';

// Delete the source device's synchronized projection, never its task, outputs,
// or native archive. Persist a tombstone through the existing source outbox.
const { accountScopeKey } = require('../device-auth-request');
const runtime = require('../platform-connections/runtime.cjs');
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sourceKey(identity, id) {
  return JSON.stringify([String(identity.hub).replace(/\/+$/, ''), identity.ownerKey || accountScopeKey(identity), identity.clientId, id]);
}
function create({ app, store, identityOf, fetch, drain, marked, changed, retry = () => {}, closed = () => false }) {
  const deleting = new Set();
  async function current(expected) {
    const identity = await identityOf(app);
    if (closed() || !identity || expected && runtime.connectionScope(identity) !== runtime.connectionScope(expected))
      throw Error('账号或服务已切换，请重新打开会话');
    return identity;
  }
  async function prepare(id, assertIdle = () => {}) {
    if (!String(id).startsWith('acct-')) return null;
    if (typeof id !== 'string' || id.length > 180) throw Error('同步会话标识无效');
    const identity = await current();
    const response = await fetch(identity, String(identity.hub).replace(/\/+$/, '') +
      '/api/v1/account-conversations/' + encodeURIComponent(id) + '/source',
    { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000) });
    const data = await response.json().catch(() => ({}));
    await current(identity);
    const row = data.conversation;
    if (!response.ok || row?.id !== id || !row.sourceSessionId || !data.sourceEpoch ||
        !Number.isSafeInteger(data.sourceRevision) || data.sourceRevision < 1)
      throw Error('同步会话不存在或暂时无法核对归属，请刷新后重试');
    if (row.sourceClientId !== identity.clientId)
      throw Error('请在创建这条会话的原电脑删除同步记录');
    if (['responding', 'running', 'streaming', 'queued', 'starting', 'waiting'].includes(row.state))
      throw Error('这条会话还在执行，完成或停止后再删除');
    assertIdle(row.sourceSessionId);
    return { identity, row, epoch: data.sourceEpoch, revision: data.sourceRevision,
      key: sourceKey(identity, row.sourceSessionId) };
  }
  async function forget(id, assertIdle) {
    const first = await prepare(id, assertIdle);
    if (!first) throw Error('同步会话标识无效');
    if (deleting.has(first.key)) throw Error('正在删除这条同步记录，请稍候');
    deleting.add(first.key);
    try {
      await drain(first.key);
      const target = await prepare(id, assertIdle);
      await current(first.identity);
      if (target.key !== first.key || target.epoch !== first.epoch)
        throw Error('来源会话已变化，请刷新后重试');
      const { identity, row, key, epoch } = target;
      const previous = await store.session(key) || {};
      if (previous.sourceEpoch && previous.sourceEpoch !== epoch)
        throw Error('来源会话版本已变化，请刷新后重试');
      const jobs = await store.jobs();
      const revisions = jobs.filter(job => sourceKey(job, job.body?.sourceSessionId) === key &&
        job.body?.sourceEpoch === epoch).map(job => job.body.sourceRevision);
      const revision = Math.max(target.revision, previous.sourceRevision || 0, ...revisions) + 1;
      if (!Number.isSafeInteger(revision) || revision > 2000000000) throw Error('同步版本无效');
      const body = { sourceClientId: identity.clientId, sourceSessionId: row.sourceSessionId,
        sourceEpoch: epoch, sourceRevision: revision, title: row.title || '', state: 'idle',
        archived: row.archived === true, deleted: true, snapshotComplete: false, messages: [] };
      const job = { id: key + ':' + revision + ':' + digest(body).slice(0, 12),
        ownerKey: accountScopeKey(identity), hub: identity.hub, clientId: identity.clientId,
        conversationId: id, body, createdAt: Date.now() };
      await current(identity); assertIdle?.(row.sourceSessionId);
      await store.checkpointAndEnqueue(key, { ...previous, deleted: true, sourceEpoch: epoch,
        sourceRevision: revision, sourceSessionId: row.sourceSessionId, hub: identity.hub,
        clientId: identity.clientId, ownerKey: job.ownerKey, digest: digest(body) }, job);
      marked(key);
      // Even a lost response must not allow an old local snapshot to resurrect
      // the record. The normal outbox retries this durable deletion.
      await current(identity);
      const response = await fetch(identity, String(identity.hub).replace(/\/+$/, '') + '/api/v1/account-conversations/sync',
        { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const receipt = await response.json().catch(() => ({}));
      if (!response.ok || receipt.ok !== true || receipt.conversationId !== id || receipt.sourceRevision !== revision)
        throw Error('删除同步记录尚未确认，请刷新后重试');
      await store.ack(job.id, receipt);
      await current(identity);
      await changed(id, { ...row, deleted: true }, identity);
      return { ok: true, id };
    } finally { deleting.delete(first.key); retry(); }
  }
  async function deleteNative(sourceId, remove, row = {}) {
    // Native archive authorization and confirmation belong to history IPC.
    // Its acknowledged source checkpoint lets deletion work while offline.
    const identity = await identityOf(app);
    if (!identity) return remove();
    const key = sourceKey(identity, sourceId);
    if (deleting.has(key)) throw Error('正在删除这条会话，请稍候');
    deleting.add(key);
    try {
      await drain(key);
      const previous = await store.session(key);
      await current(identity);
      const result = await remove();
      if (result?.ok === false || !previous?.sourceEpoch || previous.deleted) return result;
      const revision = Number(previous.sourceRevision || 0) + 1;
      if (!Number.isSafeInteger(revision) || revision > 2000000000) throw Error('同步版本无效');
      const body = { sourceClientId: identity.clientId, sourceSessionId: sourceId,
        sourceEpoch: previous.sourceEpoch, sourceRevision: revision, state: 'idle',
        title: row.title || previous.title || '未命名会话',
        deleted: true, snapshotComplete: false, messages: [] };
      const job = { id: key + ':' + revision + ':' + digest(body).slice(0, 12),
        ownerKey: accountScopeKey(identity), hub: identity.hub, clientId: identity.clientId,
        conversationId: previous.conversationId, body, createdAt: Date.now() };
      // Persist to the captured source account even if login changes while the
      // OS recycles the file. Flush only sends jobs under that exact identity.
      await store.checkpointAndEnqueue(key, { ...previous, deleted: true,
        sourceRevision: revision, digest: digest(body) }, job);
      marked(key);
      return result;
    } finally { deleting.delete(key); retry(); }
  }
  return { prepare, forget, deleteNative, blocked: key => deleting.has(key) };
}
module.exports = { create, sourceKey };
