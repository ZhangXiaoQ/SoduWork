'use strict';

// Account metadata comes from the authenticated directory. Only its verified
// native IDs may affect local archives; foreign source IDs are not local aliases.
function create(lifecycle = [], archivedIds = {}) {
  const parent = new Map();
  function root(id) {
    if (!parent.has(id)) parent.set(id, id);
    let next = id;
    while (parent.get(next) !== next) next = parent.get(next);
    while (parent.get(id) !== id) { const before = parent.get(id); parent.set(id, next); id = before; }
    return next;
  }
  const entries = lifecycle.map(state => ({ state,
    ids: [...new Set([state.id, ...(state.nativeIds || [])].filter(Boolean))] }));
  for (const { ids } of entries) {
    for (const id of ids) parent.set(root(id), root(ids[0]));
  }
  // Several historical source records can refer to the same switched chat.
  // Content sync revisions must never outrank an explicit lifecycle intent.
  // Deletion is irreversible, including when another source has stale metadata.
  const compare = (a, b) => Number(a.deleted === true) - Number(b.deleted === true) ||
    Number(a.lifecycleRevision || 0) - Number(b.lifecycleRevision || 0) ||
    Number(a.revision || 0) - Number(b.revision || 0);
  const groups = new Map();
  for (const { state, ids } of entries) {
    if (!ids.length) continue;
    const key = root(ids[0]);
    const group = groups.get(key) || { state, ids: new Set() };
    if (compare(state, group.state) >= 0) group.state = state;
    for (const id of ids) group.ids.add(id);
    groups.set(key, group);
  }
  const byId = new Map();
  for (const group of groups.values()) for (const id of group.ids) byId.set(id, group);
  function project(row) {
    if (row.localReplica === true) return row;
    const group = byId.get(row.id), state = group?.state;
    const ids = group ? [...group.ids] : [row.id];
    const localArchived = ids.some(id => Object.hasOwn(archivedIds || {}, id));
    const authoritative = Number(state?.lifecycleRevision || 0) > 0;
    const archived = authoritative ? state.archived === true
      : row.archived === true || state?.archived === true || localArchived;
    return { ...row, archived, deleted: row.deleted === true || state?.deleted === true,
      ...(state ? { revision: state.revision, lifecycleRevision: state.lifecycleRevision,
        historyAliasIds: [...new Set([...(row.historyAliasIds || []), ...ids])].filter(id => id !== row.id),
      } : {}),
      ...(archived ? { archivedAt: row.archivedAt || archivedIds[row.id] || 0 } : {}),
    };
  }
  function visible(row, archived = false) {
    const next = project(row);
    return !next.deleted && next.archived === archived;
  }
  return { project, visible };
}

module.exports = { create };
