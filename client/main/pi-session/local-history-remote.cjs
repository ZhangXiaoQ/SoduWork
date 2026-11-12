'use strict';

// This transport exposes only indexed conversations. Paths, runtime handles,
// credentials and task mutation capabilities never cross the phone boundary.
function create({ app, session, history, action, identityOf, accountHistory }) {
  const integer = (value, fallback, maximum) => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw Error('会话分页参数无效');
    return value;
  };
  function metadata(row, identity) {
    let taskProjectionId = '';
    // A downloaded transcript is another view of the same task, not another
    // conversation. Only link copies from the current Hub/account; local
    // history itself remains readable without granting source execution.
    const account = require('../device-auth-request').accountId(identity);
    if (row.cached && row.taskId && row.source?.id && account && row.source.account === account) {
      try {
        if (new URL(row.source.hub).origin === new URL(identity.hub).origin) taskProjectionId = String(row.taskId);
      } catch (_) { /* Unverified provenance stays an independent local copy. */ }
    }
    let source = null;
    if (!row.cached && !row.deleted) {
      try {
        const access = require('../conversation/history-access');
        access.assertOwner(app, row.id, access.actor(app), row);
        source = accountHistory?.sourceProjection(row.id, identity);
      } catch (_) { /* Reading shared history never grants source execution. */ }
    }
    const messageCount = Number.isSafeInteger(row.count) ? row.count : undefined;
    const state = row.status === 'idle' ? 'idle' : row.state || 'idle';
    const empty = messageCount === 0 && !taskProjectionId && state === 'idle';
    return { id: row.id, sourceSessionId: row.id, taskProjectionId, messageCount,
    sourceClientId: identity.clientId, sourceDeviceName: identity.name || '',
    title: row.title || '', state, archived: row.archived === true,
    deleted: row.deleted === true, revision: row.revision || 0,
    canContinue: !empty && !!source && source.canContinue !== false,
    continuationId: source?.id || '', continuationRevision: source?.revision || 0,
    localReplica: true, updatedAt: new Date(Number(row.replicaUpdatedAt) || 0).toISOString(),
    createdAt: row.createdAt || '' };
  }
  return async (args, guard) => {
    if (args?.action === 'import') {
      await guard(true);
      const identity = await identityOf(app);
      const result = await require('../conversation/import-content.cjs').run({ history, identity,
        pointer: args.pointer, metadata: args.metadata, guard });
      await guard(true);
      return result;
    }
    if (!args || !['list', 'read', 'archive', 'restore', 'delete'].includes(args.action) ||
        Object.keys(args).some(key => !['action', 'id', 'after', 'limit', 'confirmed', 'segmentId', 'expectedRevision'].includes(key)))
      throw Error('会话操作内容不正确');
    const after = integer(args.after, 0, Number.MAX_SAFE_INTEGER), limit = integer(args.limit, 100, 200) || 100;
    await guard(true);
    const identity = await identityOf(app);
    if (args.action === 'list') {
      const page = await history.directory(after, limit);
      await guard(true);
      return { ...page, items: page.items.map(row => metadata(row, identity)) };
    }
    if (typeof args.id !== 'string' || !args.id || args.id.length > 512) throw Error('会话标识无效');
    const row = await history.resolve(args.id);
    if (!row) throw Error('这条会话已经不存在了');
    if (args.action !== 'read') {
      if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1) throw Error('请刷新会话后重试');
      await guard(true);
      const result = await action(args.action, row.id, { confirmed: args.confirmed === true,
        expectedRevision: args.expectedRevision, assertCurrent: guard });
      await guard(true);
      return result?.ok ? { ok: true, conversation: metadata(result.conversation || row, identity) } : result;
    }
    if (row.deleted) return { conversation: metadata(row, identity), items: [], cursor: after, hasMore: false };
    const page = await history.read(row.id, { after, offset: after,
      limit, segmentId: args.segmentId });
    await guard(true);
    const events = page.format === 'events';
    const items = (page.items || []).map((item, index) => ({
      id: String(events ? item.streamId || item.id : item.id || after + index), role: item.role,
      text: String(item.text || (item.blocks || []).filter(block => block.kind === 'text').map(block => block.text || '').join('\n')),
      position: events ? item.revision : item.position ?? after + index,
      revision: events ? item.revision : (item.position ?? after + index) + 1,
      ...(events ? { delta: item.delta === true } : {}), deleted: false, createdAt: item.timestamp || '',
    }));
    const next = page.nextCursor;
    const cursor = next ?? page.cursor ?? items.at(-1)?.revision ?? after;
    return { conversation: metadata(row, identity), items, cursor, hasMore: next != null,
      format: 'events', segments: page.segments || [], requiresSegment: false };
  };
}
module.exports = { create };
