'use strict';

// A synchronized transcript is a projection, not a second local conversation.
// Only the authenticated source device may resolve it to a native archive.
async function resolve({ app, session, item, identity }) {
  if (!item?.sourceSessionId || !identity?.clientId ||
      item.sourceClientId !== identity.clientId) return null;
  const access = require('./history-access');
  const segments = require('./runtime-segments');
  let id = String(item.sourceSessionId);
  const record = segments.list(app).find(row => row.id === id || row.active?.sessionId === id ||
    row.segments.some(part => part.sessionId === id));
  if (record) { segments.assertOwner(app, record, identity); id = record.id; }
  const archived = session.isArchived?.(app, id) === true;
  const live = session.findBySessionId?.(id);
  if (live?.passiveCloudView) return null;
  // A previously attached account view must not mask a native archive that
  // became available after startup. The projection itself grants no execution
  // rights: the source device and the archive owner are still checked here.
  const accountView = live?.adapterId === 'account-sync';
  if (accountView && live.inFlight?.()) return null;
  const row = live && !accountView ? live.historyRow?.() || { id, adapterId: live.adapterId }
    : await session.archivedConversation?.(app, id, { nativeOnly: true });
  if (!row || row.accountConversation || row.accountProjection || row.adapterId === 'account-sync' || row.cloud) return null;
  access.assertOwner(app, id, access.actor(app, identity), row);
  const nativeIds = [...new Set([id, ...(record?.segments || []).map(part => part.sessionId),
    record?.active?.sessionId, item.sourceSessionId].filter(Boolean))];
  return { ...row, id, archived: archived || row.archived === true, nativeIds,
    historyAliasIds: [...new Set([...(row.historyAliasIds || []), ...nativeIds, item.id])].filter(Boolean) };
}

function aliases({ app, id, identity }) {
  const wanted = String(id || '');
  if (!wanted || !app?.getPath) return wanted ? [wanted] : [];
  const segments = require('./runtime-segments');
  const record = segments.list(app).find(row => row.id === wanted || row.active?.sessionId === wanted ||
    row.segments.some(part => part.sessionId === wanted));
  if (!record) return [wanted];
  segments.assertOwner(app, record, identity);
  return [...new Set([record.id, ...record.segments.map(part => part.sessionId),
    record.active?.sessionId].filter(Boolean))];
}

module.exports = { resolve, aliases };
