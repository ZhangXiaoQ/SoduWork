'use strict';

// Read-only, incremental projection of Pi's JSONL archives. Keep only sidebar
// metadata in memory, never whole transcripts, credentials or runtime handles.
const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');
const harnesses = require('../conversation/used-harnesses');

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function revision(stat) {
  return [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino].join(':');
}
async function mapLimit(items, visit) {
  let next = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(10, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await visit(items[index]);
    }
  }));
  return results;
}

async function readSummary(file, stat, project) {
  let header, firstMessage = '', name, count = 0, activity, workOwner, initialized = false, movedCwd = '';
  const bindings = [];
  const usedHarnesses = new Set();
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; } // Includes an incomplete final append.
      if (!entry || typeof entry !== 'object') continue;
      if (!header) {
        if (entry.type !== 'session' || typeof entry.id !== 'string' || !entry.id) return null;
        header = entry;
        continue;
      }
      if (entry.type === 'session_info') name = typeof entry.name === 'string' ? entry.name.trim() : '';
      if (entry.type === 'custom' && entry.customType === 'soduwork.work-entry' && entry.data?.version === 1 &&
          typeof entry.data.owner === 'string') workOwner = entry.data.owner;
      // An explicit workspace move (「换个文件夹继续」) supersedes the session header's
      // original directory; later moves win.
      if (entry.type === 'custom' && entry.customType === 'soduwork.workspace.moved' &&
          entry.data?.version === 1 && typeof entry.data.cwd === 'string' && entry.data.cwd) {
        movedCwd = entry.data.cwd;
      }
      // Permission metadata indicates an initialized runtime even if no message was sent before exit.
      if (entry.type === 'custom' && entry.customType === 'soduwork.access.policy') initialized = true;
      if (entry.type === 'custom' && entry.customType === 'soduwork.task.binding') bindings.push(entry);
      if (entry.type === 'custom' && entry.customType === 'soduwork.task.tool') harnesses.add(usedHarnesses, entry.data?.event);
      if (entry.type !== 'message') continue;
      count++;
      const message = entry.message;
      if (['assistant', 'toolResult'].includes(message?.role)) harnesses.add(usedHarnesses, message, 'pi');
      if (!message || typeof message !== 'object' || !('content' in message) ||
          !['user', 'assistant'].includes(message.role)) continue;
      const time = typeof message.timestamp === 'number' ? message.timestamp : Date.parse(entry.timestamp);
      if (Number.isFinite(time)) activity = Math.max(activity || 0, time);
      if (!firstMessage && message.role === 'user') {
        firstMessage = typeof message.content === 'string' ? message.content :
          Array.isArray(message.content) ? message.content.filter(block => block && block.type === 'text')
            .map(block => block.text || '').join(' ') : '';
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (!header) return null;
  const headerTime = Date.parse(header.timestamp);
  return project({
    id: header.id, path: file,
    cwd: movedCwd || (typeof header.cwd === 'string' ? header.cwd : ''),
    name, firstMessage: firstMessage || '(no messages)', messageCount: count, usedHarnesses: [...usedHarnesses],
    ...(workOwner ? { workOwner, workOnly: count === 0 && !initialized } : {}),
    createdAt: Number.isFinite(headerTime) ? headerTime : stat.birthtimeMs,
    modified: activity > 0 ? activity : Number.isFinite(headerTime) ? headerTime : stat.mtimeMs,
  }, bindings);
}

function createArchiveHistory({ root, project, read = readSummary }) {
  const files = new Map(), byId = new Map(), pending = new Map();
  let refreshing;
  async function safeFile(file, base) {
    const target = await fs.promises.realpath(file);
    if (!inside(base, target) || path.extname(target).toLowerCase() !== '.jsonl') return null;
    const stat = await fs.promises.stat(target);
    return stat.isFile() ? { target, stat } : null;
  }
  function forget(file) {
    const old = files.get(file);
    if (old && old.row && byId.get(old.row.id) === file) byId.delete(old.row.id);
    files.delete(file);
  }
  const namedFor = (file, id) => path.basename(file) === id + '.jsonl' || path.basename(file).endsWith('_' + id + '.jsonl');
  function unsafeArchive() {
    return Object.assign(Error('会话存档路径不受信任，无法确认会话是否存在'), { code: 'HISTORY_ARCHIVE_UNSAFE' });
  }
  function requireTarget(row, candidate, wanted) {
    if (candidate && (!row || row.id !== wanted))
      throw Object.assign(Error('会话存档已损坏或标识不一致，请检查本地存储后重试'), { code: 'HISTORY_ARCHIVE_INVALID' });
    return row;
  }
  async function load(file, base, strictId = '') {
    if (pending.has(file)) {
      try { await pending.get(file); } catch (error) { if (strictId) throw error; }
      return load(file, base, strictId);
    }
    const work = (async () => {
      try {
        const candidate = strictId && (namedFor(file, strictId) || files.get(file)?.row?.id === strictId);
        const safe = await safeFile(file, base);
        if (!safe) { if (strictId) throw unsafeArchive(); forget(file); return null; }
        const version = revision(safe.stat);
        const cached = files.get(file);
        if (cached && cached.target === safe.target && cached.version === version)
          return requireTarget(cached.row, candidate, strictId);
        const row = await read(safe.target, safe.stat, project);
        requireTarget(row, candidate, strictId);
        // A live append during parsing must not mark a partial projection as current.
        const after = await safeFile(file, base);
        forget(file);
        if (after && after.target === safe.target && revision(after.stat) === version) {
          files.set(file, { target: safe.target, version, row });
          if (row) byId.set(row.id, file);
        }
        return row;
      } catch (error) {
        // Keep the last verified identity on strict failures so a later retry
        // cannot reinterpret an unreadable renamed archive as an unrelated row.
        if (!strictId || error.code === 'ENOENT') forget(file);
        if ((strictId ? ['ENOENT'] : ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']).includes(error.code)) return null;
        throw error;
      }
    })();
    pending.set(file, work);
    try { return await work; } finally { pending.delete(file); }
  }

  async function refresh(strictId = '') {
    if (!strictId && refreshing) return refreshing;
    const work = (async () => {
      let base, folders;
      try {
        base = await fs.promises.realpath(root);
        folders = await fs.promises.readdir(path.join(root, 'sessions'), { withFileTypes: true });
      } catch (error) {
        if (!(strictId ? ['ENOENT'] : ['ENOENT', 'ENOTDIR']).includes(error.code)) throw error;
        files.clear(); byId.clear(); return [];
      }
      const groups = await mapLimit(folders.filter(entry => entry.isDirectory() || entry.isSymbolicLink()), async entry => {
        const directory = path.join(root, 'sessions', entry.name);
        try {
          if (!inside(base, await fs.promises.realpath(directory))) {
            if (strictId) throw unsafeArchive();
            return [];
          }
          return (await fs.promises.readdir(directory, { withFileTypes: true }))
            .filter(item => (item.isFile() || item.isSymbolicLink()) && item.name.endsWith('.jsonl'))
            .map(item => path.join(directory, item.name));
        } catch (error) {
          if ((strictId ? ['ENOENT'] : ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']).includes(error.code)) return [];
          throw error;
        }
      });
      const paths = groups.flat(), seen = new Set(paths);
      for (const file of files.keys()) if (!seen.has(file)) forget(file);
      const rows = await mapLimit(paths, file => load(file, base, strictId));
      return rows.filter(Boolean).sort((a, b) => Number(b.at) - Number(a.at));
    })();
    if (!strictId) refreshing = work;
    try { return await work; } finally { if (refreshing === work) refreshing = null; }
  }

  // A click can arrive before the sidebar's initial full projection has
  // finished. Looking up an id through refresh() in that state means reading
  // every transcript in the archive (some installations contain hundreds of
  // megabytes), which leaves the chat screen showing its opening skeleton for
  // a long time. Pi puts the session id in the archive filename, so first do
  // a cheap filename-only lookup and parse just the requested transcript.
  async function locateById(wanted, base, strict = false) {
    const sessionsRoot = path.join(base, 'sessions');
    let folders;
    try {
      folders = await fs.promises.readdir(sessionsRoot, { withFileTypes: true });
    } catch (error) {
      if ((strict ? ['ENOENT'] : ['ENOENT', 'ENOTDIR']).includes(error.code)) return null;
      throw error;
    }
    const exact = wanted + '.jsonl';
    const suffix = '_' + wanted + '.jsonl';
    const groups = await mapLimit(
      folders.filter(entry => entry.isDirectory() || entry.isSymbolicLink()),
      async entry => {
        const directory = path.join(sessionsRoot, entry.name);
        try {
          if (!inside(base, await fs.promises.realpath(directory))) {
            if (strict) throw unsafeArchive();
            return null;
          }
          const names = await fs.promises.readdir(directory, { withFileTypes: true });
          const match = names.find(item => (item.isFile() || item.isSymbolicLink()) &&
            (item.name === exact || item.name.endsWith(suffix)));
          return match ? path.join(directory, match.name) : null;
        } catch (error) {
          if ((strict ? ['ENOENT'] : ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']).includes(error.code)) return null;
          throw error;
        }
      },
    );
    return groups.find(Boolean) || null;
  }
  async function find(id, { strict = false } = {}) {
    const wanted = String(id || '').trim();
    if (!wanted) return null;
    // A destructive caller needs a verified absence, not the sidebar's tolerant
    // omission of unreadable/invalid rows. Non-target malformed JSON stays hidden.
    const strictId = strict ? wanted : '';
    // Retry discovery once if an indexed archive was moved/deleted externally.
    // A live Pi session can append while the directory scan is reading it. In
    // that case load() deliberately avoids caching the moving projection; use
    // the just-scanned row directly instead of telling the renderer that the
    // visible conversation disappeared.
    for (let attempt = 0; attempt < 2; attempt++) {
      let refreshed = null;
      const file = byId.get(wanted);
      if (!file && !attempt) {
        try {
          const base = await fs.promises.realpath(root);
          const direct = await locateById(wanted, base, strict);
          if (direct) {
            const row = await load(direct, base, strictId);
            if (row && row.id === wanted) return row;
          }
        } catch (error) {
          if (!(strict ? ['ENOENT'] : ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']).includes(error.code)) throw error;
        }
      }
      if (attempt) refreshed = await refresh(strictId);
      if (!file) {
        const direct = Array.isArray(refreshed)
          ? refreshed.find((row) => row && row.id === wanted)
          : null;
        if (direct) return direct;
        continue;
      }
      try {
        // Even a cache hit revalidates the real path, revision and identity.
        const row = await load(file, await fs.promises.realpath(root), strictId);
        if (row && row.id === wanted) return row;
      } catch (error) {
        if (!(strict ? ['ENOENT'] : ['ENOENT', 'ENOTDIR']).includes(error.code)) throw error;
        forget(file);
      }
    }
    return null;
  }
  return { list: refresh, find };
}
module.exports = { createArchiveHistory, readSummary };
