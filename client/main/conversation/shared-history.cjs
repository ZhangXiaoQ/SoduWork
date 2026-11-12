'use strict';

const path = require('node:path');
const access = require('./history-access');
const { accountId } = require('../device-auth-request');

function create({ app, session, store = require('./replica-store.cjs').createWorker(
  path.join(app.getPath('userData'), 'conversation-replicas', 'history.sqlite')) }) {
  const observed = new Map();
  let closed = false, closing;
  const localReader = require('../app-readonly-history.cjs').create({ app, session, localOnly: true,
    access: { actor: () => ({}), assertCurrent() {}, assertOwner: access.assertReadable } });
  const isNative = row => row && !row.accountProjection && !row.remoteProjection && !row.cloud;
  async function register(rows) {
    const result = [];
    for (let i = 0; i < rows.length; i += 200) result.push(...await store.register(rows.slice(i, i + 200)));
    return result;
  }
  async function projectRows(rows, archived = false, records) {
    const native = rows.filter(isNative).map(row => {
      const record = records ? records.get(row.id) : require('./runtime-segments').read(app, row.id);
      return { ...require('./acceptance-session').projectHistory(app, row),
        accountConversation: false, accountProjection: false,
        archived: row.archived === true || session.isArchived?.(app, row.id) === true ||
        (archived && (!row.adapterId || row.adapterId === 'pi')), historyAliasIds: [...new Set([
        ...(row.historyAliasIds || []), ...[...(record?.segments || []), record?.active].filter(Boolean).map(part => part.sessionId),
      ])].filter(id => id !== row.id) };
    });
    for (const row of native) if (row.historyAliasIds.length) await store.join(row.id, row.historyAliasIds);
    const registered = await register(native);
    const byId = new Map();
    for (const row of registered) for (const id of [row.id, ...row.historyAliasIds]) byId.set(id, row);
    return rows.map(row => byId.get(row.id) || row).filter(row => !row.deleted && (row.archived === true) === archived);
  }
  async function resolve(id) {
    let row = await store.get(id);
    if (row) return row;
    if (/^(?:acct-|cloud-execution:|task-execution:)/.test(id)) return null;
    const pi = await session.historyEntry?.(app, id, { strict: true });
    if (pi?.ok && pi.entry?.path) {
      if (pi.entry.id !== id) throw Error('本地会话记录不匹配，请刷新后重试');
      return (await register([{ ...pi.entry, id, adapterId: 'pi', cloud: false }]))[0];
    }
    const native = await session.archivedConversation(app, id, { nativeOnly: true, strict: true });
    if (!isNative(native)) return null;
    return (await register([native]))[0];
  }
  async function lifecycle(id, action, identity) {
    const row = await resolve(id);
    if (!row) return null;
    for (const alias of [row.id, ...row.historyAliasIds]) {
      if (session.findBySessionId(alias)?.inFlight?.()) throw Error('这条会话还在执行，完成或停止后再操作');
    }
    return store.lifecycle(row.id, action, { account: accountId(identity), hub: identity?.hub, device: identity?.clientId });
  }
  async function remoteLifecycle(rows, identity = require('./requirement-context').cachedIdentity(app)) {
    const remote = rows.filter(row => row.cloud || row.remoteProjection || row.accountProjection);
    if (!remote.length) return [];
    const owner = accountId(identity);
    if (!owner || !identity?.hub) return [];
    let hub;
    try { hub = new URL(identity.hub).origin; } catch (_) { return []; }
    const bySource = new Map(), byTask = new Map(), states = new Map();
    const add = (index, id, row) => {
      if (!id) return;
      if (!index.has(id)) index.set(id, new Set());
      index.get(id).add(row);
    };
    for (const row of remote) {
      for (const id of [row.id, ...(row.historyAliasIds || [])]) add(bySource, id, row);
      add(byTask, row.taskId, row);
    }
    const sourceIds = [...bySource.keys()], taskIds = [...byTask.keys()];
    for (let offset = 0; offset < Math.max(sourceIds.length, taskIds.length); offset += 200) {
      const copies = await store.remoteLifecycleRows({ account: owner,
        sourceIds: sourceIds.slice(offset, offset + 200), taskIds: taskIds.slice(offset, offset + 200) });
      for (const copy of copies) {
        try { if (new URL(copy.source.hub).origin !== hub) continue; }
        catch (_) { continue; }
        // Deleted copies are excluded by the store: deleting a local transcript
        // must not hide its cloud original. The latest explicit intent wins.
        const matched = new Set([...(bySource.get(copy.source.id) || []), ...(byTask.get(copy.taskId) || [])]);
        for (const row of matched) {
          const previous = states.get(row.id);
          if (!previous || copy.replicaRevision > previous.lifecycleRevision ||
              (copy.replicaRevision === previous.lifecycleRevision && copy.revision >= previous.revision)) {
            states.set(row.id, { id: row.id, archived: copy.archived, deleted: false,
              lifecycleRevision: copy.replicaRevision, revision: copy.revision });
          }
        }
      }
    }
    return [...states.values()];
  }
  async function read(id, options = {}) {
    const row = await resolve(id);
    if (!row || row.deleted) throw Error('这条会话已经不存在了');
    const after = Number(options.after || 0);
    if (!Number.isSafeInteger(after) || after < 0) throw Error('Invalid local history cursor');
    if (row.cached) {
      const page = await store.messages(row.id, { after: after - 1, limit: options.limit || 100 });
      return { ...page, nextCursor: page.next == null ? null : page.next + 1, cursor: page.items.at(-1)?.position + 1 || after };
    }
    // Encode the segment in the cursor so phones and passive desktop views
    // traverse runtime switches without mixing sequence namespaces.
    const span = 1000000000;
    const record = require('./runtime-segments').read(app, row.id);
    const parts = record ? [...new Set([...record.segments, record.active].filter(Boolean).map(part => part.sessionId))] : [row.id];
    const segment = Math.floor(after / span), offset = after % span;
    if (segment >= parts.length) throw Error('Invalid local history segment');
    const page = await localReader('conversations.read', { id: row.id, offset, after: offset,
      limit: options.limit || 100, segmentId: parts[segment] });
    const next = page.nextOffset ?? page.nextAfter;
    const cursor = segment * span + (page.cursor ?? offset + (page.items || []).length);
    return { ...page, cursor,
      items: (page.items || []).map(item => ({ ...item, id: parts[segment] + ':' + item.id,
        ...(page.format === 'events' ? { streamId: parts[segment] + ':' + item.streamId, revision: segment * span + Number(item.id) } : {}) })),
      nextCursor: next != null ? segment * span + next : segment + 1 < parts.length ? (segment + 1) * span : null };
  }
  async function open(id) {
    const row = await resolve(id);
    if (!row || row.deleted) return null;
    return require('./local-history-view.cjs').create({ row, read });
  }
  async function preserveLegacyOutbox(job, identity) {
    const id = 'recovered-' + require('node:crypto').createHash('sha256').update(
      JSON.stringify([job.hub, job.ownerKey, job.body.sourceSessionId, job.body.sourceEpoch])).digest('hex');
    const [row] = await register([{ id, cached: true, archived: true, title: job.body.title,
      source: { hub: job.hub, id: job.body.sourceSessionId, account: accountId(identity) } }]);
    if (row.deleted) return;
    const messages = [...(job.body.messages || [])].sort((a, b) => a.position - b.position);
    let batch = [], start = 0, bytes = 0;
    async function save() {
      if (!batch.length) return;
      const saved = await store.cache(id, batch, { start, expectedRevision: row.replicaRevision });
      if (!saved.ok) throw Error('Local recovery copy changed during migration');
      batch = []; bytes = 0;
    }
    for (const message of messages) {
      const size = Buffer.byteLength(JSON.stringify(message));
      if (batch.length && (message.position !== start + batch.length || batch.length >= 100 || bytes + size > 8 * 1024 * 1024)) await save();
      if (!batch.length) start = message.position;
      batch.push(message);
      bytes += size;
    }
    await save();
    if (job.body.deleted) await store.lifecycle(id, 'delete', { account: accountId(identity), hub: job.hub });
  }
  async function capture(handle, identity) {
    if (closed || handle.localReplica || typeof handle.snapshot !== 'function') return;
    const snapshot = handle.snapshot(), original = handle.historyRow?.(snapshot);
    if (!original?.id) return;
    // A cache has its own identity so deleting it cannot delete or hide the
    // account-authorized cloud original in the cloud directory.
    const remote = original.cloud || original.accountProjection;
    const id = remote ? 'copy-' + require('node:crypto').createHash('sha256').update(
      JSON.stringify([identity?.hub, accountId(identity), original.id])).digest('hex') : original.id;
    const displayed = remote ? original : require('./acceptance-session').projectHistory(app, original);
    const [row] = await register([{ ...displayed, id, cloud: false, accountProjection: false,
      accountConversation: false,
      remoteProjection: false, cached: !!remote, source: remote ? { hub: identity?.hub, id: original.id, account: accountId(identity) } : null,
      creator: { account: accountId(identity), hub: identity?.hub }, historyAliasIds: remote ? [] : original.historyAliasIds || [] }]);
    if (row.deleted || !remote) return;
    const messages = (snapshot.messages || []).filter(message => ['user', 'assistant'].includes(message.role));
    const offset = Number(snapshot.history?.messageStart || 0);
    const complete = !snapshot.history?.truncated && offset === 0;
    for (let start = 0; start < Math.max(1, messages.length);) {
      let end = start, bytes = 0;
      while (end < messages.length && end - start < 100) {
        const size = Buffer.byteLength(JSON.stringify(messages[end]));
        if (end > start && bytes + size > 8 * 1024 * 1024) break;
        bytes += size; end++;
      }
      const result = await store.cache(id, messages.slice(start, end), {
        start: offset + start, expectedRevision: row.replicaRevision, complete: complete && end >= messages.length });
      if (!result.ok) break;
      if (end === start) break;
      start = end;
    }
  }
  function observe(handle, identity) {
    if (!handle || observed.has(handle) || handle.localReplica) return;
    let pending, timer, disposed = false, error = '', dirty = false;
    const flush = () => {
      if (timer) clearTimeout(timer); timer = null;
      dirty = true;
      if (pending) return pending;
      pending = (async () => {
        while (dirty) {
          dirty = false;
          try { await capture(handle, identity); error = ''; }
          catch (failure) { error = failure.message; handle.localHistoryError = error; }
        }
      })().finally(() => { pending = null; });
      return pending;
    };
    const dispose = handle.on?.(() => {
      if (disposed || timer) return;
      timer = setTimeout(() => { timer = null; void flush(); }, 1000); timer.unref?.();
    });
    const entry = { flush, error: () => error, dispose: () => { disposed = true; clearTimeout(timer); dispose?.(); } };
    observed.set(handle, entry);
    // Registry facades intercept close; decorating that facade would make the
    // native close await its own registry disposal and deadlock shutdown.
    const native = handle[Symbol.for('soduwork.agent-runtime.native-handle')] || handle;
    const originalClose = native.close;
    if (typeof originalClose === 'function') native.close = async function (...args) {
      const result = await originalClose.apply(this, args);
      if (result !== false) { entry.dispose(); await flush(); observed.delete(handle); }
      return result;
    };
    void flush();
  }
  let refreshing, refreshedAt = 0;
  async function directory(after = 0, limit = 100) {
    // Coalesce simultaneous phone/sidebar scans. Native providers own their
    // indexes; directory responses contain metadata only and use keyset cursors.
    if (!refreshing && Date.now() - refreshedAt > 5000) refreshing = Promise.all([session.history(app, Number.MAX_SAFE_INTEGER),
      session.archivedHistory(app, Number.MAX_SAFE_INTEGER)]).then(result => {
        if (result.some(row => row.ok === false)) throw Error('Local history inventory is temporarily unavailable');
        refreshedAt = Date.now();
      }).finally(() => { refreshing = null; });
    await refreshing;
    return { ...await store.directory(after, limit), workspace: await store.workspace() };
  }
  return { resolve, read, open, register, projectRows, lifecycle, remoteLifecycle, capture, observe, store, directory, preserveLegacyOutbox,
    list: options => store.list(options),
    page: options => store.page(options),
    async indexedRows(archived, limit) {
      const items = []; let after;
      do {
        const page = await store.list({ archived, after, limit: Math.min(200, Math.max(1, limit - items.length)) });
        items.push(...page.items); after = page.next;
      } while (after && items.length < limit);
      return items;
    },
    close() { return closing ||= (async () => {
      for (const entry of observed.values()) entry.dispose();
      await Promise.all([...observed.values()].map(entry => entry.flush()));
      closed = true; observed.clear(); await store.close();
    })(); } };
}
// Source locators permit passive transcript recovery, not lifecycle ownership
// or interception of an authenticated account original.
function isLocalIdentity(row, id) {
  return !!row && (row.id === id || Array.isArray(row.historyAliasIds) && row.historyAliasIds.includes(id));
}
module.exports = { create, isLocalIdentity };
