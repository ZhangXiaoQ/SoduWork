'use strict';

// Execution ownership remains account-bound. Local transcript reads and local
// replica management use the device workspace instead of the creating account.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const runtime = require('../platform-connections/runtime.cjs');
const { assertNoLinks } = require('../plugin-resources');
const LEGACY_OWNER_DIRECTORY = 'conversation-history-owners';
function actor(app, identity) {
  const auth = require('../device-auth');
  if (identity === undefined) identity = require('./requirement-context').cachedIdentity(app);
  let owner = '';
  try { owner = runtime.scope(identity); } catch (_) { owner = auth.localOwner(app); }
  return { identity, owner, candidates: auth.profiles(app) };
}
function saved(app, directory, id) {
  const file = path.join(app.getPath('userData'), directory,
    crypto.createHash('sha256').update(String(id)).digest('hex') + '.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function legacyOwner(app, id) {
  const file = path.join(app.getPath('userData'), LEGACY_OWNER_DIRECTORY,
    crypto.createHash('sha256').update(String(id)).digest('hex') + '.json');
  let record;
  try {
    // Legacy sidecars are local trust anchors. Reject links before reading so
    // migration never intentionally follows an external path.
    assertNoLinks(app.getPath('userData'), file);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('linked');
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Error('无法读取会话归属记录，请重新打开 SoduWork');
  }
  if (!record) return null;
  if (record.version !== 1 || record.sessionId !== id ||
      !/^[a-f0-9]{32}$/.test(String(record.owner || ''))) {
    throw Error('无法读取会话归属记录，请重新打开 SoduWork');
  }
  return record;
}
function bindLegacyOwner(app, id, captured) {
  const file = path.join(app.getPath('userData'), LEGACY_OWNER_DIRECTORY,
    crypto.createHash('sha256').update(String(id)).digest('hex') + '.json');
  const record = {
    version: 1, sessionId: id, owner: captured.owner,
    hub: String(captured.identity?.hub || ''), migratedAt: new Date().toISOString(),
  };
  assertNoLinks(app.getPath('userData'), file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return record;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return legacyOwner(app, id);
  }
}
function isOwnerlessNativeArchive(row) {
  // Native archive projections carry an absolute JSONL path and at least one
  // persisted message. Synthetic rows and cloud previews do not qualify for
  // first-open migration, so they remain hidden until an owner is recorded.
  return !!row && !row.workOwner && !row.cloud && typeof row.path === 'string' &&
    path.isAbsolute(row.path) && path.extname(row.path).toLowerCase() === '.jsonl' &&
    Number.isSafeInteger(Number(row.count)) && Number(row.count) > 0;
}
function assertOwner(app, id, captured = actor(app), row = {}, options = {}) {
  if (!id || !captured.owner) throw Error('请先登录 SoduWork 后查看会话');
  // Account projections are authenticated Hub records, not ownerless native archives.
  if (row.accountProjection === true) {
    if (row.accountConversation !== true || row.adapterId !== 'account-sync' ||
        row.owner !== runtime.connectionScope(captured.identity) ||
        !row.sourceSessionId || !row.sourceClientId || row.id !== id) {
      throw Error('账号会话归属记录无效');
    }
    return;
  }
  // A remote directory row is a projection of Hub metadata, not a local
  // archive.  Accept it only when the row carries the exact identity that was
  // derived from the authenticated connection and the immutable task/ref
  // needed to read its transcript.  The cloud flag alone is never an owner
  // proof and cannot bypass the account boundary.
  if (row.remoteProjection === true) {
    // Cloud projections use the current connection scope, like handoff receipts.
    // Local archive ownership remains account-scoped across device enrollment.
    if (row.cloud !== true || row.owner !== runtime.connectionScope(captured.identity) ||
        String(row.taskId || '').length === 0 || String(row.ref || '').length === 0) {
      throw Error('云端会话归属记录无效');
    }
    return;
  }
  const records = ['session-memory-bindings', 'requirement-session-context', 'conversation-runtime-segments']
    .map(directory => saved(app, directory, id)).filter(Boolean);
  const owners = records.map(record => record.owner);
  if (row.workOwner) owners.push(row.workOwner);
  const legacy = legacyOwner(app, id);
  if (legacy) owners.push(legacy.owner);
  const cloud = saved(app, 'conversation-handoffs', id);
  if (cloud) {
    const syncOwner = require('./cloud-execution-sync').scope(captured.identity);
    if (cloud.sessionId !== id || !cloud.owner || (cloud.owner !== runtime.connectionScope(captured.identity) &&
        (!syncOwner || cloud.syncOwner !== syncOwner)))
      throw Error('这条云端会话属于其他账号或服务，请切回原连接');
    // A verified cloud receipt also owns a remote-only conversation.
    if (!owners.length) return;
  }
  if (!owners.length && options.allowLegacy === true && isOwnerlessNativeArchive(row)) {
    const migrated = bindLegacyOwner(app, id, captured);
    if (migrated?.owner) owners.push(migrated.owner);
  }
  if (!owners.length) {
    const error = Error('无法确认这条会话属于当前账号，请切回原账号');
    error.code = 'HISTORY_OWNER_MISSING';
    throw error;
  }
  if (owners.some(owner => !owner || (owner !== captured.owner &&
      !runtime.scopeMatches(owner, captured.identity, captured.candidates))))
    throw Error('无法确认这条会话属于当前账号，请切回原账号');
}
function assertReadable(app, id, captured = actor(app), row = {}) {
  if (!id || typeof id !== 'string' || id.length > 512 || (row.id || row.sessionId) !== id)
    throw Error('会话标识无效');
  // Callers resolve rows through trusted local indexes, never renderer-supplied
  // paths. A downloaded replica is local data, not a remote permission grant.
  if (row.localReplica === true) return;
  if (row.remoteProjection === true || row.accountProjection === true || row.accountConversation === true ||
      row.adapterId === 'account-sync' || row.sourceClientId || row.cloud === true)
    return assertOwner(app, id, captured, row);
}
function visible(app, rows, identity) {
  const captured = actor(app, identity);
  return rows.filter(row => {
    try {
      assertReadable(app, row.sessionId || row.id, captured, row);
      return true;
    }
    catch (_) { return false; }
  }).map(row => { const { workOwner, ...visible } = row; return visible; });
}
function assertCurrent(app, captured, identity) {
  const current = actor(app, identity);
  if (!captured.owner || current.owner !== captured.owner)
    throw Error('账号已切换，请在当前账号重新打开会话');
}
module.exports = { actor, assertOwner, assertReadable, assertCurrent, visible, isOwnerlessNativeArchive };
