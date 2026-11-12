'use strict';

// Transactional outbox; production storage and serialization run in a worker.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const sourceKey = job => JSON.stringify([String(job.hub || '').replace(/\/+$/, ''),
  job.ownerKey, job.clientId, job.body?.sourceSessionId, job.body?.sourceEpoch]);
const routeKey = job => JSON.stringify([String(job.hub || '').replace(/\/+$/, ''), job.ownerKey, job.clientId]);
function create(file, { persistent = false, maxBytes = 256 * 1024 * 1024 } = {}) {
  const legacy = path.resolve(file), target = legacy + '.sqlite';
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  let connection;
  function access(fn) {
    const db = connection || new DatabaseSync(target);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    if (persistent) connection = db;
    try { return fn(db); } finally { if (!persistent) db.close(); }
  }
  function transaction(db, fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function insert(db, job) {
    const value = JSON.stringify(job);
    db.prepare('INSERT OR IGNORE INTO jobs VALUES(?,?,?,?,?,?,?)').run(job.id, sourceKey(job),
      Number(job.body?.sourceRevision || 0), value, Buffer.byteLength(value), routeKey(job), job.blocked ? 1 : 0);
  }
  access(db => {
    db.exec('PRAGMA journal_mode=WAL;');
    if (db.prepare('PRAGMA user_version').get().user_version > 1) throw Error('Unsupported conversation outbox version');
    transaction(db, () => {
      db.exec('CREATE TABLE IF NOT EXISTS checkpoints(key TEXT PRIMARY KEY,value TEXT NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,source TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT NOT NULL,bytes INTEGER NOT NULL,scope TEXT NOT NULL,blocked INTEGER NOT NULL);' +
        'CREATE INDEX IF NOT EXISTS jobs_source ON jobs(source,revision);' +
        'CREATE INDEX IF NOT EXISTS jobs_scope ON jobs(scope,blocked);' +
        'CREATE TABLE IF NOT EXISTS directory(scope TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,id));' +
        'CREATE TABLE IF NOT EXISTS cursors(scope TEXT PRIMARY KEY,value INTEGER NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
      if (!db.prepare("SELECT 1 FROM metadata WHERE key='legacy-import'").get()) {
        if (fs.existsSync(legacy)) {
          const value = JSON.parse(fs.readFileSync(legacy, 'utf8').replace(/^\uFEFF/, ''));
          if (value.version !== 1 || !Array.isArray(value.jobs) || !value.sessions ||
              typeof value.sessions !== 'object' || Array.isArray(value.sessions))
            throw Error('Invalid legacy conversation outbox; preserve the original file');
          for (const [key, state] of Object.entries(value.sessions)) db.prepare('INSERT INTO checkpoints VALUES(?,?)')
            .run(key, JSON.stringify({ ...state, legacy: true }));
          for (const job of value.jobs) insert(db, job);
        }
        db.prepare("INSERT INTO metadata VALUES('legacy-import','done')").run();
      }
      if (!db.prepare("SELECT 1 FROM metadata WHERE key='lifecycle-tombstones'").get()) {
        // Previous clients discarded deleted directory rows but advanced the
        // cursor past them. Reconcile once from the beginning to recover those
        // ownership-scoped tombstones without touching checkpoints or uploads.
        db.exec('DELETE FROM cursors;');
        db.prepare("INSERT INTO metadata VALUES('lifecycle-tombstones','done')").run();
      }
      db.exec('PRAGMA user_version=1;');
    });
  });
  function enqueue(db, job) {
    const next = { ...job, id: String(job.id || crypto.randomUUID()), createdAt: Number(job.createdAt || Date.now()),
      attempts: Number(job.attempts || 0) };
    if (db.prepare('SELECT 1 FROM jobs WHERE id=?').get(next.id)) return next;
    const source = sourceKey(next), revision = Number(next.body?.sourceRevision || 0);
    if ((next.body?.snapshotComplete === true || next.body?.deleted === true) && revision > 0) db.prepare(
      'DELETE FROM jobs WHERE source=? AND revision<=?').run(source, revision);
    const size = Buffer.byteLength(JSON.stringify(next));
    const total = db.prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM jobs').get().total;
    if (total + size > maxBytes) throw Error('Conversation sync storage is full; local history is preserved');
    insert(db, next); return next;
  }
  return {
    jobs: (limit = 1000000) => access(db => db.prepare('SELECT value FROM jobs ORDER BY rowid LIMIT ?').all(limit).map(row => JSON.parse(row.value))),
    batch: (scope, limit = 100, byteLimit = 16 * 1024 * 1024) => access(db => {
      const result = []; let bytes = 0;
      for (const row of db.prepare('SELECT value,bytes FROM jobs WHERE scope=? AND blocked=0 ORDER BY rowid LIMIT ?')
        .iterate(routeKey(scope), limit)) {
        if (result.length && bytes + row.bytes > byteLimit) break;
        result.push(JSON.parse(row.value)); bytes += row.bytes;
      }
      return result;
    }),
    pending: () => access(db => db.prepare('SELECT id,source,revision,blocked FROM jobs ORDER BY rowid').all().map(row => {
      const [hub, ownerKey, clientId, sourceSessionId, sourceEpoch] = JSON.parse(row.source);
      return { id: row.id, hub, ownerKey, clientId, blocked: !!row.blocked,
        body: { sourceSessionId, sourceEpoch, sourceRevision: row.revision } };
    })),
    session: key => access(db => { const row = db.prepare('SELECT value FROM checkpoints WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }),
    setSession: (key, state) => access(db => db.prepare('INSERT OR REPLACE INTO checkpoints VALUES(?,?)').run(key, JSON.stringify(state))),
    checkpointAndEnqueue: (key, state, job) => access(db => transaction(db, () => {
      const next = enqueue(db, { ...job, sessionKey: key });
      db.prepare('INSERT OR REPLACE INTO checkpoints VALUES(?,?)').run(key, JSON.stringify({ ...state, legacy: false }));
      return next;
    })),
    enqueue: job => access(db => transaction(db, () => enqueue(db, job))),
    ack: (id, receipt) => access(db => transaction(db, () => {
      const row = db.prepare('SELECT value FROM jobs WHERE id=?').get(id); if (!row) return;
      const job = JSON.parse(row.value), key = job.sessionKey || job.ownerKey + ':' + job.body.sourceSessionId;
      const saved = db.prepare('SELECT value FROM checkpoints WHERE key=?').get(key);
      if (saved) {
        const state = JSON.parse(saved.value);
        if (state.sourceEpoch === job.body.sourceEpoch && state.sourceRevision >= job.body.sourceRevision) {
          state.ackedRevision = Math.max(state.ackedRevision || 0, job.body.sourceRevision);
          if (state.sourceRevision === job.body.sourceRevision) state.ackedDigest = state.contentDigest;
          state.conversationId = receipt?.conversationId || state.conversationId;
          db.prepare('UPDATE checkpoints SET value=? WHERE key=?').run(JSON.stringify(state), key);
        }
      }
      db.prepare('DELETE FROM jobs WHERE id=?').run(id);
    })),
    fail: (id, blocked = false) => access(db => {
      const row = db.prepare('SELECT value FROM jobs WHERE id=?').get(id); if (!row) return;
      const job = JSON.parse(row.value); job.attempts = Number(job.attempts || 0) + 1; job.blocked = blocked;
      const value = JSON.stringify(job);
      db.prepare('UPDATE jobs SET value=?,bytes=?,blocked=? WHERE id=?').run(value, Buffer.byteLength(value), blocked ? 1 : 0, id);
    }),
    directory: scope => access(db => ({ cursor: db.prepare('SELECT value FROM cursors WHERE scope=?').get(scope)?.value || 0,
      items: db.prepare('SELECT value FROM directory WHERE scope=?').all(scope).map(row => JSON.parse(row.value)) })),
    saveDirectory: (scope, items, cursor) => access(db => transaction(db, () => {
      for (const item of items) {
        if (!item?.id) continue;
        const previous = db.prepare('SELECT value FROM directory WHERE scope=? AND id=?').get(scope, item.id);
        if (previous && Number(JSON.parse(previous.value).revision || 0) > Number(item.revision || 0)) continue;
        // Retain deletion tombstones so a native transcript cannot reappear
        // after restart while the directory cursor already passed its deletion.
        db.prepare('INSERT OR REPLACE INTO directory VALUES(?,?,?)').run(scope, item.id, JSON.stringify(item));
      }
      // A single lifecycle receipt is not a complete directory page. Advancing
      // its cursor would skip unrelated conversations changed before that row.
      if (Number.isSafeInteger(cursor) && cursor >= 0) db.prepare(
        'INSERT INTO cursors VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET value=MAX(value,excluded.value)').run(scope, cursor);
    })),
    clear: () => access(db => transaction(db, () => db.exec('DELETE FROM jobs; DELETE FROM checkpoints; DELETE FROM directory; DELETE FROM cursors;'))),
    close() { connection?.close(); connection = null; },
  };
}
function createWorker(file, options = {}) {
  const { Worker } = require('node:worker_threads');
  const worker = new Worker(path.join(__dirname, 'account-sync-worker.cjs'), { workerData: { file, options } });
  let serial = 0, failure;
  const pending = new Map();
  worker.on('message', reply => {
    const request = pending.get(reply.id); if (!request) return;
    pending.delete(reply.id);
    reply.error ? request.reject(Error(reply.error)) : request.resolve(reply.value);
    if (!pending.size) worker.unref();
  });
  const fail = error => { failure = error; for (const request of pending.values()) request.reject(error); pending.clear(); };
  worker.on('error', fail); worker.on('exit', code => fail(Error('Conversation sync worker exited: ' + code)));
  function call(method, ...args) {
    if (failure) return Promise.reject(failure);
    worker.ref();
    return new Promise((resolve, reject) => {
      const id = ++serial; pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, method, args }); }
      catch (error) { pending.delete(id); if (!pending.size) worker.unref(); reject(error); }
    });
  }
  worker.unref();
  const api = Object.fromEntries(['jobs', 'batch', 'pending', 'session', 'setSession', 'checkpointAndEnqueue', 'enqueue', 'ack', 'fail',
    'directory', 'saveDirectory', 'clear'].map(method => [method, (...args) => call(method, ...args)]));
  api.asynchronous = true;
  api.close = async () => { try { await call('close'); } finally { await worker.terminate(); } };
  return api;
}
module.exports = { create, createWorker };
