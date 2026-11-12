'use strict';

// Device-local replica state is independent of cloud/account lifecycle state.
// Production callers execute all SQLite and serialization work in a worker.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const METHODS = ['register', 'join', 'importChunk', 'importPlan', 'importPage', 'sealImport', 'get', 'list', 'catalog', 'page', 'directory', 'lifecycleRows', 'remoteLifecycleRows', 'lifecycle', 'cache', 'messages', 'changes', 'ack', 'workspace', 'close'];
const REMOTE_LIFECYCLE = "deleted=0 AND revision>0 AND json_extract(data,'$.cached')=1 AND coalesce(json_extract(data,'$.taskId'),'')<>''";
function key(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\x00-\x1f]/.test(value))
    throw Error('Invalid local conversation identity');
  return value;
}
function bounded(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw Error('Invalid history page size');
  return value;
}
function create(file, { maxImportBytes = 512 * 1024 * 1024 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  require('../plugin-resources').assertNoLinks(path.dirname(file), file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) { db.close(); throw Error('Unsupported local replica store version'); }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS replicas(id TEXT PRIMARY KEY,data TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL,catalog_revision INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS replica_page ON replicas(deleted,archived,updated DESC,id DESC);
      CREATE INDEX IF NOT EXISTS replica_directory ON replicas(catalog_revision);
      CREATE INDEX IF NOT EXISTS replica_migration_source ON replicas(json_extract(data,'$.sourceLocalId')) WHERE deleted=0;
      CREATE INDEX IF NOT EXISTS replica_origin_id ON replicas(json_extract(data,'$.source.id'));
      CREATE INDEX IF NOT EXISTS replica_origin_conversation ON replicas(json_extract(data,'$.source.conversationId'));
      CREATE INDEX IF NOT EXISTS replica_origin_session ON replicas(json_extract(data,'$.sourceSessionId'));
      CREATE INDEX IF NOT EXISTS replica_remote_lifecycle_source ON replicas(
        json_extract(data,'$.source.account'),json_extract(data,'$.source.id')) WHERE ${REMOTE_LIFECYCLE};
      CREATE INDEX IF NOT EXISTS replica_remote_lifecycle_task ON replicas(
        json_extract(data,'$.source.account'),json_extract(data,'$.taskId')) WHERE ${REMOTE_LIFECYCLE};
      CREATE TABLE IF NOT EXISTS aliases(alias TEXT PRIMARY KEY,replica TEXT NOT NULL REFERENCES replicas(id));
      CREATE INDEX IF NOT EXISTS aliases_replica ON aliases(replica);
      CREATE TABLE IF NOT EXISTS messages(replica TEXT NOT NULL REFERENCES replicas(id),position INTEGER NOT NULL,
        data TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(replica,position));
      CREATE TABLE IF NOT EXISTS import_chunks(replica TEXT NOT NULL,digest TEXT NOT NULL,offset INTEGER NOT NULL,
        body BLOB NOT NULL,PRIMARY KEY(replica,digest,offset));
      CREATE TABLE IF NOT EXISTS import_pages(replica TEXT NOT NULL,manifest TEXT NOT NULL,page INTEGER NOT NULL,
        digest TEXT NOT NULL,size INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(replica,manifest,page));
      CREATE TABLE IF NOT EXISTS import_messages(replica TEXT NOT NULL,manifest TEXT NOT NULL,page INTEGER NOT NULL,
        position INTEGER NOT NULL,data TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(replica,manifest,page,position));
      CREATE TABLE IF NOT EXISTS operations(revision INTEGER PRIMARY KEY AUTOINCREMENT,replica TEXT NOT NULL,
        action TEXT NOT NULL,actor TEXT NOT NULL,created INTEGER NOT NULL,acked INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS operations_pending ON operations(acked,revision);
      PRAGMA user_version=1;`);
    db.prepare("INSERT OR IGNORE INTO metadata VALUES('workspace',?)").run(crypto.randomUUID());
  });
  const resolve = id => {
    const wanted = key(id);
    const direct = db.prepare('SELECT r.* FROM replicas r JOIN aliases a ON r.id=a.replica WHERE a.alias=?').get(wanted);
    if (direct) return direct;
    // Account directory IDs and native source IDs are authenticated aliases
    // persisted in replica metadata. Resolve them without title matching so a
    // stale account projection can still open its local transcript.
    return db.prepare(`SELECT * FROM replicas WHERE json_extract(data,'$.source.id')=? OR
      json_extract(data,'$.source.conversationId')=? OR json_extract(data,'$.sourceSessionId')=?
      ORDER BY updated DESC, id DESC LIMIT 1`).get(wanted, wanted, wanted);
  };
  function project(row, aliases) {
    if (!row) return null;
    return { ...JSON.parse(row.data), id: row.id, localReplica: true, archived: !!row.archived,
      deleted: !!row.deleted, replicaRevision: row.revision, replicaUpdatedAt: row.updated,
      revision: row.catalog_revision,
      historyAliasIds: aliases || db.prepare('SELECT alias FROM aliases WHERE replica=? AND alias<>?').all(row.id, row.id).map(r => r.alias) };
  }
  function projectPage(rows) {
    if (!rows.length) return [];
    const aliases = new Map(rows.map(row => [row.id, []]));
    for (const row of db.prepare(`SELECT replica,alias FROM aliases WHERE replica IN (${rows.map(() => '?').join(',')}) AND alias<>replica`)
      .iterate(...rows.map(row => row.id))) aliases.get(row.replica).push(row.alias);
    return rows.map(row => project(row, aliases.get(row.id)));
  }
  function register(rows) {
    if (!Array.isArray(rows) || rows.length > 500) throw Error('Invalid local history batch');
    return transaction(() => rows.map(raw => {
      const id = key(raw.id), ids = [...new Set([id, ...(raw.historyAliasIds || [])].map(key))];
      if (ids.length > 100) throw Error('Too many conversation aliases');
      const matches = ids.map(resolve).filter(Boolean), canonical = matches[0]?.id || id;
      if (matches.some(row => row.id !== canonical)) throw Error('Conflicting conversation aliases');
      const old = resolve(canonical), previous = old ? JSON.parse(old.data) : {};
      if (old && id !== canonical) return project(old);
      // Provenance is immutable. Registering a refreshed snapshot cannot revive
      // a deleted replica, change local lifecycle intent, or claim another user.
      const data = { ...previous, ...raw, id: canonical,
        creator: previous.creator || raw.creator || null, source: previous.source || raw.source || null };
      delete data.historyAliasIds;
      const updated = Number.isFinite(Number(raw.at)) ? Number(raw.at) : Date.parse(raw.at) || old?.updated || Date.now();
      const encoded = JSON.stringify(data);
      const previousAliases = new Set(old ? db.prepare('SELECT alias FROM aliases WHERE replica=?').all(canonical).map(row => row.alias) : []);
      if (!old || old.data !== encoded || old.updated !== updated || ids.some(alias => !previousAliases.has(alias))) {
        const revision = Number(db.prepare("INSERT INTO operations(replica,action,actor,created) VALUES(?,'upsert','{}',?)")
          .run(canonical, Date.now()).lastInsertRowid);
        db.prepare(`INSERT INTO replicas(id,data,updated,archived,catalog_revision) VALUES(?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated=excluded.updated,catalog_revision=excluded.catalog_revision`)
          .run(canonical, encoded, updated, raw.archived === true ? 1 : 0, revision);
      }
      for (const alias of ids) db.prepare('INSERT OR IGNORE INTO aliases VALUES(?,?)').run(alias, canonical);
      return project(resolve(canonical));
    }));
  }
  function decodeImport(id, pointer) {
    key(id);
    if (!/^[a-f0-9]{64}$/.test(pointer?.sha256) || !Number.isSafeInteger(pointer.size) ||
        pointer.size < 0 || pointer.size > 128 * 1024 * 1024) throw Error('Invalid transcript import');
    const chunks = []; let size = 0;
    for (const part of db.prepare('SELECT offset,body FROM import_chunks WHERE replica=? AND digest=? ORDER BY offset').iterate(id, pointer.sha256)) {
      if (part.offset !== size) throw Error('Transcript import has a gap');
      size += part.body.length; chunks.push(Buffer.from(part.body));
      if (size > pointer.size) throw Error('Transcript import exceeds limit');
    }
    const content = Buffer.concat(chunks);
    if (size !== pointer.size || crypto.createHash('sha256').update(content).digest('hex') !== pointer.sha256)
      throw Error('Transcript import checksum mismatch');
    return JSON.parse(content.toString('utf8'));
  }
  function importPlan(id, pointer, supplied) {
    const old = resolve(id), previous = old && JSON.parse(old.data);
    if (previous?.importDigest === pointer.sha256 && previous.importSize === pointer.size) return null;
    const decoded = supplied || decodeImport(id, pointer);
    if (decoded?.format !== 'soduwork.account-history.pages.v1') return null;
    if (!Array.isArray(decoded.pages) || decoded.pages.length > 100000 || !Number.isSafeInteger(decoded.count) || decoded.count < 0 ||
        decoded.pages.some(page => page.scope !== pointer.scope || page.runnerId !== pointer.runnerId || page.schema !== 1 ||
          !/^[a-f0-9]{64}$/.test(page.sha256) || !Number.isSafeInteger(page.size) || page.size < 0 || page.size > 8 * 1024 * 1024 ||
          !Number.isSafeInteger(page.count) || page.count < 1) || decoded.pages.reduce((sum, page) => sum + page.count, 0) !== decoded.count)
      throw Error('Invalid transcript page manifest');
    const saved = new Map(db.prepare('SELECT page,digest,size,count FROM import_pages WHERE replica=? AND manifest=?')
      .all(id, pointer.sha256).map(page => [page.page, page]));
    return { ...decoded, pages: decoded.pages.map((page, index) => {
      const prior = saved.get(index);
      return { ...page, staged: !!prior && prior.digest === page.sha256 && prior.size === page.size && prior.count === page.count };
    }) };
  }
  return {
    register,
    importPlan,
    importPage(id, manifest, page, index) {
      const plan = importPlan(id, manifest), expected = plan?.pages[index];
      if (!Number.isSafeInteger(index) || index < 0 || !expected || ['scope', 'sha256', 'size', 'count', 'runnerId'].some(key => expected[key] !== page[key]))
        throw Error('Transcript page is not in the manifest');
      const old = db.prepare('SELECT digest,size,count FROM import_pages WHERE replica=? AND manifest=? AND page=?').get(id, manifest.sha256, index);
      if (old && old.digest === page.sha256 && old.size === page.size && old.count === page.count) return { ok: true, durable: true };
      const messages = decodeImport(id, page);
      if (!Array.isArray(messages) || messages.length !== page.count || messages.some(message => !['user', 'assistant'].includes(message?.role)))
        throw Error('Invalid transcript page');
      transaction(() => {
        messages.forEach((message, position) => {
          const data = JSON.stringify(message), digest = crypto.createHash('sha256').update(data).digest('hex');
          db.prepare('INSERT INTO import_messages VALUES(?,?,?,?,?,?)').run(id, manifest.sha256, index, position, data, digest);
        });
        db.prepare('INSERT INTO import_pages VALUES(?,?,?,?,?,?)').run(id, manifest.sha256, index, page.sha256, page.size, page.count);
        db.prepare('DELETE FROM import_chunks WHERE replica=? AND digest=?').run(id, page.sha256);
      });
      return { ok: true, durable: true };
    },
    importChunk(id, pointer, offset, encoded) {
      key(id);
      if (!/^[a-f0-9]{64}$/.test(pointer?.sha256) || !Number.isSafeInteger(pointer.size) || pointer.size < 0 || pointer.size > 128 * 1024 * 1024 ||
          !Number.isSafeInteger(offset) || offset < 0 || offset % (256 * 1024) || offset > pointer.size ||
          typeof encoded !== 'string' || encoded.length > 349528) throw Error('Invalid transcript import chunk');
      const replica = resolve(id), imported = replica && JSON.parse(replica.data);
      // A lost migration acknowledgement remains retryable after a local
      // deletion. The endpoint retains the immutable source object; no local
      // messages are rewritten by this receipt-only retry.
      if (imported?.importDigest === pointer.sha256 && imported.importSize === pointer.size)
        return { ok: true, durable: true, deleted: !!replica.deleted, offset, size: Math.min(256 * 1024, pointer.size - offset) };
      if (replica?.deleted) return { ok: false, deleted: true };
      const body = Buffer.from(encoded, 'base64');
      if (body.length !== Math.min(256 * 1024, pointer.size - offset)) throw Error('Invalid transcript import size');
      transaction(() => {
        const old = db.prepare('SELECT body FROM import_chunks WHERE replica=? AND digest=? AND offset=?').get(id, pointer.sha256, offset);
        if (old && !Buffer.from(old.body).equals(body)) throw Error('Transcript retry changed content');
        if (!old) {
          const used = db.prepare('SELECT COALESCE(SUM(length(body)),0) AS bytes FROM import_chunks').get().bytes;
          if (used + body.length > maxImportBytes) throw Error('Incomplete transcript imports exceed the local storage budget');
          db.prepare('INSERT INTO import_chunks VALUES(?,?,?,?)').run(id, pointer.sha256, offset, body);
        }
      });
      return { ok: true, offset, size: body.length };
    },
    sealImport(id, pointer, metadata) {
      key(id);
      if (!/^[a-f0-9]{64}$/.test(pointer?.sha256) || !Number.isSafeInteger(pointer.size) || pointer.size < 0 ||
          pointer.size > 128 * 1024 * 1024 || !metadata || typeof metadata !== 'object') throw Error('Invalid transcript import');
      const old = resolve(id);
      if (old && JSON.parse(old.data).importDigest === pointer.sha256 && JSON.parse(old.data).importSize === pointer.size)
        return { ok: true, durable: true, deleted: !!old.deleted, sha256: pointer.sha256, size: pointer.size };
      if (old?.deleted) return { ok: false, deleted: true };
      const decoded = decodeImport(id, pointer), plan = importPlan(id, pointer, decoded);
      const messages = plan ? null : Array.isArray(decoded) ? decoded : decoded.messages;
      if (!plan && (!Array.isArray(messages) || messages.some(message => !['user', 'assistant'].includes(message?.role)))) throw Error('Invalid migrated transcript');
      transaction(() => {
        if (plan) plan.pages.forEach((page, index) => {
          const saved = db.prepare('SELECT digest,size,count FROM import_pages WHERE replica=? AND manifest=? AND page=?').get(id, pointer.sha256, index);
          if (!saved || saved.digest !== page.sha256 || saved.size !== page.size || saved.count !== page.count)
            throw Error('Transcript pages are incomplete');
        });
        const source = metadata.sourceLocalId ? resolve(metadata.sourceLocalId) : null;
        const deleted = metadata.deleted === true || !!source?.deleted;
        const archived = source ? !!source.archived : metadata.archived === true;
        const data = { ...metadata, id, cached: true, cloud: false, localReplica: true,
          importDigest: pointer.sha256, importSize: pointer.size };
        const revision = Number(db.prepare("INSERT INTO operations(replica,action,actor,created) VALUES(?,'upsert','{}',?)").run(id, Date.now()).lastInsertRowid);
        db.prepare(`INSERT INTO replicas(id,data,updated,catalog_revision,archived,deleted) VALUES(?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET data=excluded.data,catalog_revision=excluded.catalog_revision`)
          .run(id, JSON.stringify(data), Date.parse(metadata.createdAt) || Date.now(), revision,
            archived ? 1 : 0, deleted ? 1 : 0);
        if (deleted) db.prepare('UPDATE replicas SET deleted=1 WHERE id=?').run(id);
        db.prepare('INSERT OR IGNORE INTO aliases VALUES(?,?)').run(id, id);
        db.prepare('DELETE FROM messages WHERE replica=?').run(id);
        (deleted || plan ? [] : messages).forEach((message, position) => {
          const data = JSON.stringify(message);
          db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(id, position, data, crypto.createHash('sha256').update(data).digest('hex'));
        });
        if (plan && !deleted) db.prepare(`INSERT INTO messages(replica,position,data,digest)
          SELECT replica,row_number() OVER(ORDER BY page,position)-1,data,digest FROM import_messages
          WHERE replica=? AND manifest=?`).run(id, pointer.sha256);
        db.prepare('DELETE FROM import_chunks WHERE replica=?').run(id);
        db.prepare('DELETE FROM import_messages WHERE replica=?').run(id);
        db.prepare('DELETE FROM import_pages WHERE replica=?').run(id);
      });
      return { ok: true, durable: true, sha256: pointer.sha256, size: pointer.size, count: plan ? plan.count : messages.length };
    },
    join(id, aliases) {
      key(id);
      if (!Array.isArray(aliases) || aliases.length > 100) throw Error('Invalid native conversation aliases');
      return transaction(() => {
        const rows = [...new Map([id, ...aliases].map(key).map(resolve).filter(Boolean).map(row => [row.id, row])).values()];
        if (!rows.length) return;
        if (rows.some(row => JSON.parse(row.data).cached)) throw Error('Cloud copies cannot be joined to native transcripts');
        // A child runtime may be discovered before its public conversation.
        // Always keep the trusted manifest's public identity as the canonical row.
        let winner = db.prepare('SELECT * FROM replicas WHERE id=?').get(id);
        if (!winner) {
          const seed = rows[0];
          db.prepare('INSERT INTO replicas(id,data,archived,deleted,revision,updated,catalog_revision) VALUES(?,?,?,?,?,?,0)')
            .run(id, JSON.stringify({ ...JSON.parse(seed.data), id }), seed.archived, seed.deleted, seed.revision, seed.updated);
          winner = db.prepare('SELECT * FROM replicas WHERE id=?').get(id);
        }
        if (!rows.some(row => row.id === winner.id)) rows.push(winner);
        if (rows.length === 1) return;
        const lifecycle = rows.slice().sort((a, b) => b.deleted - a.deleted || b.revision - a.revision)[0];
        for (const row of rows) {
          if (row.id === winner.id) continue;
          db.prepare('UPDATE aliases SET replica=? WHERE replica=?').run(winner.id, row.id);
          db.prepare('DELETE FROM messages WHERE replica=?').run(row.id);
          const retired = Number(db.prepare("INSERT INTO operations(replica,action,actor,created) VALUES(?,'delete','{}',?)")
            .run(row.id, Date.now()).lastInsertRowid);
          db.prepare('UPDATE replicas SET deleted=1,revision=?,catalog_revision=? WHERE id=?').run(retired, retired, row.id);
        }
        db.prepare('INSERT INTO aliases(alias,replica) VALUES(?,?) ON CONFLICT(alias) DO UPDATE SET replica=excluded.replica').run(id, id);
        db.prepare('UPDATE replicas SET archived=?,deleted=?,revision=? WHERE id=?')
          .run(lifecycle.archived, lifecycle.deleted, lifecycle.revision, winner.id);
        const revision = Number(db.prepare("INSERT INTO operations(replica,action,actor,created) VALUES(?,'upsert','{}',?)")
          .run(winner.id, Date.now()).lastInsertRowid);
        db.prepare('UPDATE replicas SET catalog_revision=? WHERE id=?').run(revision, winner.id);
      });
    },
    get: id => project(resolve(id)),
    remoteLifecycleRows({ account, sourceIds = [], taskIds = [] }) {
      key(account);
      const identities = values => {
        if (!Array.isArray(values) || values.length > 200) throw Error('Invalid remote history batch');
        return [...new Set(values.map(key))];
      };
      const sources = identities(sourceIds), tasks = identities(taskIds), result = new Map();
      // Each lookup uses its own partial index. Do not deserialize transcripts,
      // aliases, or unrelated inventory merely to overlay one remote history page.
      for (const [field, values] of [['source.id', sources], ['taskId', tasks]]) {
        if (!values.length) continue;
        const query = `SELECT id,archived,revision,catalog_revision,
          json_extract(data,'$.source.id') AS source_id,json_extract(data,'$.source.hub') AS hub,
          json_extract(data,'$.taskId') AS task_id FROM replicas WHERE ${REMOTE_LIFECYCLE}
          AND json_extract(data,'$.source.account')=? AND json_extract(data,'$.${field}') IN (${values.map(() => '?').join(',')})`;
        for (const row of db.prepare(query).iterate(account, ...values)) result.set(row.id, {
          id: row.id, source: { id: row.source_id, hub: row.hub }, taskId: row.task_id,
          archived: !!row.archived, replicaRevision: row.revision, revision: row.catalog_revision,
        });
      }
      return [...result.values()];
    },
    lifecycleRows() {
      return db.prepare('SELECT id,archived,deleted,revision,catalog_revision FROM replicas WHERE archived=1 OR deleted=1').all().map(row => ({
        id: row.id, archived: !!row.archived, deleted: !!row.deleted, revision: row.catalog_revision,
        lifecycleRevision: row.revision, localReplica: true,
        historyAliasIds: db.prepare('SELECT alias FROM aliases WHERE replica=? AND alias<>?').all(row.id, row.id).map(item => item.alias),
      }));
    },
    workspace: () => db.prepare("SELECT value FROM metadata WHERE key='workspace'").get().value,
    catalog(knownRevision) {
      if (knownRevision !== undefined) bounded(knownRevision, 0, Number.MAX_SAFE_INTEGER);
      const workspace = db.prepare("SELECT value FROM metadata WHERE key='workspace'").get().value;
      const revision = Number(db.prepare('SELECT coalesce(max(revision),0) AS revision FROM operations').get().revision);
      if (knownRevision === revision) return { workspace, revision };
      // This inventory proves device-local membership without exposing titles,
      // creator identities or message bodies. Aliases are loaded in one pass.
      const items = db.prepare('SELECT id,archived,deleted FROM replicas ORDER BY id').all()
        .map(row => ({ id: row.id, historyAliasIds: [], originIds: [], archived: !!row.archived, deleted: !!row.deleted }));
      const byId = new Map(items.map(row => [row.id, row]));
      const claimed = new Set();
      for (const row of db.prepare('SELECT replica,alias FROM aliases ORDER BY alias').iterate()) {
        claimed.add(row.alias);
        if (row.alias !== row.replica) byId.get(row.replica)?.historyAliasIds.push(row.alias);
      }
      // Source IDs locate downloaded content for legacy organization recovery.
      // They are not identity aliases: a local copy never owns the lifecycle or
      // execution authority of its account-authorized original.
      const origins = db.prepare(`SELECT id,json_extract(data,'$.source.id') AS source_id,
        json_extract(data,'$.source.conversationId') AS conversation_id,
        json_extract(data,'$.sourceSessionId') AS session_id FROM replicas ORDER BY updated DESC,id DESC`);
      for (const row of origins.iterate()) for (const alias of [row.source_id, row.conversation_id, row.session_id]) {
        if (claimed.has(alias)) continue;
        try { key(alias); } catch (_) { continue; }
        claimed.add(alias);
        if (alias !== row.id) byId.get(row.id).originIds.push(alias);
      }
      return { workspace, revision, items };
    },
    page(options = {}) {
      const localCatalog = this.catalog(options.catalogRevision);
      if (options.workspace !== undefined && options.workspace !== localCatalog.workspace)
        throw Error('Local history workspace changed');
      // Both projections execute in the same worker turn, so lifecycle intent
      // cannot change between membership validation and the visible page.
      const page = this.list({ after: options.after, limit: options.limit, archived: options.archived === true });
      return { ok: true, chats: page.items, next: page.next, localCatalog };
    },
    directory(after = 0, limit = 100) {
      bounded(after, 0, Number.MAX_SAFE_INTEGER); bounded(limit, 100, 200);
      const rows = db.prepare('SELECT * FROM replicas WHERE catalog_revision>? ORDER BY catalog_revision LIMIT ?').all(after, limit + 1);
      const page = rows.slice(0, limit);
      return { items: projectPage(page), cursor: page.at(-1)?.catalog_revision || after, hasMore: rows.length > limit };
    },
    list(options = {}) {
      const limit = bounded(options.limit, 50, 200) || 50;
      const cursor = options.after;
      if (cursor && (!Number.isFinite(cursor.at) || typeof cursor.id !== 'string')) throw Error('Invalid history cursor');
      const rows = cursor
        ? db.prepare('SELECT * FROM replicas WHERE deleted=0 AND archived=? AND (updated<? OR (updated=? AND id<?)) ORDER BY updated DESC,id DESC LIMIT ?')
          .all(options.archived ? 1 : 0, cursor.at, cursor.at, key(cursor.id), limit + 1)
        : db.prepare('SELECT * FROM replicas WHERE deleted=0 AND archived=? ORDER BY updated DESC,id DESC LIMIT ?').all(options.archived ? 1 : 0, limit + 1);
      const page = rows.slice(0, limit), last = page.at(-1);
      return { items: projectPage(page), next: rows.length > limit ? { at: last.updated, id: last.id } : null };
    },
    lifecycle(id, action, actor = {}) {
      if (!['archive', 'restore', 'delete'].includes(action)) throw Error('Invalid replica operation');
      // Audit fields contain identities only, never tokens or a raw auth object.
      const audit = JSON.stringify({ account: String(actor.account || '').slice(0, 180),
        hub: String(actor.hub || '').slice(0, 1024), device: String(actor.device || '').slice(0, 180) });
      return transaction(() => {
        const row = resolve(id);
        if (!row) throw Error('Local conversation does not exist');
        if (row.deleted && action !== 'delete') throw Error('Deleted local copies require explicit restoration');
        if ((action === 'delete' && row.deleted) || (!row.deleted && action !== 'delete' && !!row.archived === (action === 'archive')))
          return { ok: true, unchanged: true, conversation: project(row) };
        const receipt = db.prepare('INSERT INTO operations(replica,action,actor,created) VALUES(?,?,?,?)').run(row.id, action, audit, Date.now());
        db.prepare('UPDATE replicas SET archived=?,deleted=?,revision=?,catalog_revision=? WHERE id=?')
          .run(action === 'archive' ? 1 : 0, action === 'delete' ? 1 : 0, Number(receipt.lastInsertRowid), Number(receipt.lastInsertRowid), row.id);
        if (action === 'delete') db.prepare('DELETE FROM messages WHERE replica=?').run(row.id);
        // Migrated copies of this same local source are recovery records, not
        // independent cloud originals. A late import must obey its tombstone.
        if (action === 'delete') {
          const copies = db.prepare("SELECT id FROM replicas WHERE deleted=0 AND json_extract(data,'$.sourceLocalId') IN (SELECT alias FROM aliases WHERE replica=?)").all(row.id);
          for (const copy of copies) {
            const revision = Number(db.prepare('INSERT INTO operations(replica,action,actor,created) VALUES(?,?,?,?)')
              .run(copy.id, action, audit, Date.now()).lastInsertRowid);
            db.prepare('UPDATE replicas SET deleted=1,revision=?,catalog_revision=? WHERE id=?').run(revision, revision, copy.id);
            db.prepare('DELETE FROM messages WHERE replica=?').run(copy.id);
          }
        }
        return { ok: true, conversation: project(resolve(row.id)) };
      });
    },
    cache(id, messages, { start = 0, expectedRevision, complete = false } = {}) {
      bounded(start, 0, 1000000000);
      if (!Array.isArray(messages) || messages.length > 200) throw Error('Invalid transcript batch');
      if (Buffer.byteLength(JSON.stringify(messages)) > 16 * 1024 * 1024) throw Error('Transcript batch exceeds local cache limit');
      return transaction(() => {
        const row = resolve(id);
        if (!row || row.deleted || row.revision !== expectedRevision) return { ok: false, stale: true };
        for (let i = 0; i < messages.length; i++) {
          const message = messages[i];
          if (!message || !['user', 'assistant'].includes(message.role)) throw Error('Invalid conversation message');
          const data = JSON.stringify(message);
          if (Buffer.byteLength(data) > 2 * 1024 * 1024) throw Error('Conversation message exceeds local cache limit');
          const digest = crypto.createHash('sha256').update(data).digest('hex');
          db.prepare(`INSERT INTO messages VALUES(?,?,?,?) ON CONFLICT(replica,position)
            DO UPDATE SET data=excluded.data,digest=excluded.digest WHERE messages.digest<>excluded.digest`)
            .run(row.id, start + i, data, digest);
        }
        if (complete) db.prepare('DELETE FROM messages WHERE replica=? AND position>=?').run(row.id, start + messages.length);
        return { ok: true };
      });
    },
    messages(id, { after = -1, limit = 100 } = {}) {
      if (!Number.isSafeInteger(after) || after < -1) throw Error('Invalid message cursor');
      bounded(limit, 100, 200);
      const row = resolve(id);
      if (!row || row.deleted) return { items: [], next: null, unavailable: true };
      const page = [];
      let bytes = 0, more = false;
      for (const entry of db.prepare("SELECT position,data FROM messages WHERE replica=? AND position>? AND json_extract(data,'$.deleted') IS NOT 1 ORDER BY position LIMIT ?").iterate(row.id, after, limit + 1)) {
        const size = Buffer.byteLength(entry.data);
        if (page.length >= limit || (page.length && bytes + size > 2 * 1024 * 1024)) { more = true; break; }
        page.push(entry); bytes += size;
      }
      return { items: page.map(r => ({ ...JSON.parse(r.data), position: r.position })),
        next: more ? page.at(-1).position : null };
    },
    changes(after = 0, limit = 100) {
      bounded(after, 0, Number.MAX_SAFE_INTEGER); bounded(limit, 100, 200);
      return db.prepare('SELECT * FROM operations WHERE revision>? ORDER BY revision LIMIT ?').all(after, limit)
        .map(row => ({ ...row, actor: JSON.parse(row.actor) }));
    },
    ack(revision) { bounded(revision, 0, Number.MAX_SAFE_INTEGER); db.prepare('UPDATE operations SET acked=1 WHERE revision=?').run(revision); },
    close() { db.close(); },
  };
}

function createWorker(file) {
  return require('./sqlite-worker-client.cjs').create(path.join(__dirname, 'replica-store-worker.cjs'), { file }, METHODS);
}
module.exports = { create, createWorker, METHODS };
