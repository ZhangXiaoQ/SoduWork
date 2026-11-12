'use strict';
// All registry parsing, package validation and resource decoding runs off the
// Electron main thread. Authorization is supplied afresh by the host on reads.
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const resources = require('./plugin-resources');
const contract = require('../core/plugin-package-page.cjs');
const entries = new Map(), MAX_BYTES = 64 * 1024 * 1024, MAX_ENTRIES = 8, IDLE_MS = 300000;
let bytes = 0, hits = 0, misses = 0, registryReads = 0, normalizations = 0;
const normalize = resources.normalize;
resources.normalize = (...args) => { normalizations++; return normalize(...args); };
function remove(key) { const row = entries.get(key); if (row) bytes -= row.size; entries.delete(key); }
function prune() { for (const [key, row] of entries) if (Date.now() - row.used > IDLE_MS) remove(key); }
function matches(row, request) { return row.profile === request.profile && row.pluginId === request.pluginId; }
function select(row, request, action = request.action) {
  const contribution = row.definition.ui?.contributions?.find(item => item.id === request.contributionId &&
    item.slot === 'workspace.navigation' && item.source?.type === 'package');
  if (!contribution) throw Error('已安装应用未声明该包内入口');
  if (action === 'resource') {
    const names = [request.pathname, path.posix.join(path.posix.dirname(contribution.source.entry), request.pathname)];
    const file = names.map(name => row.index.get(name)).find(Boolean);
    return file ? { path: file.path, bytes: file.bytes } : null;
  }
  return { row: contribution, definition: row.definition, revision: row.revision };
}
function run(request) {
  if (request.action === 'import-file') return require('./plugin-package-picker-worker.cjs').read(request.file);
  if (request.action === 'preflight') return require('./personal-plugins').preflight(request.body);
  if (request.action === 'preflight-archive') return require('./personal-plugins').preflightArchive(request.content);
  prune();
  if (request.action === 'stats' || request.action === 'clear') {
    let size = 0;
    for (const [key, row] of entries) if (matches(row, request)) {
      size += row.size; if (request.action === 'clear') remove(key);
    }
    return { bytes: size, totalBytes: bytes, entries: entries.size, hits, misses, registryReads, normalizations, maxBytes: MAX_BYTES };
  }
  const key = JSON.stringify([request.profile, request.pluginId, request.scope]);
  // Identity changes cannot leave the previous account's package in this cache.
  for (const [oldKey, row] of entries) if (matches(row, request) && oldKey !== key) remove(oldKey);
  let revision;
  try {
    if (request.action === 'cached') {
      const cached = entries.get(key);
      if (!cached?.etag) return null;
      cached.used = Date.now(); entries.delete(key); entries.set(key, cached); hits++;
      return { etag: cached.etag, result: select(cached, request, request.requestedAction) };
    }
    if (request.value) revision = crypto.createHash('sha256').update(request.etag || '').update(JSON.stringify(request.value)).digest('hex');
    else {
      const stat = fs.statSync(path.join(request.profile, 'personal-plugins.json'), { bigint: true });
      revision = [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    }
    let row = entries.get(key);
    if (row?.revision !== revision) {
      remove(key); misses++;
      let value = request.value;
      if (!value) {
        registryReads++;
        const plugin = require('./personal-plugins').get({ getPath: () => request.profile }, request.pluginId);
        if (!plugin.enabled) throw Error('请先安装并启用该应用');
        value = { ui: plugin.ui, resources: plugin.localDraft.resources, jiyong: plugin.jiyong || plugin.localDraft.jiyong,
          version: plugin.version, checksum: plugin.checksum };
      }
      const files = resources.normalize(value.resources, { allowLegacyContent: true });
      contract.validate(value.ui, files);
      const index = new Map(files.filter(file => ['ui', 'asset'].includes(file.kind)).map(file =>
        [file.path, { path: file.path, bytes: Buffer.from(file.content, 'base64') }]));
      const { resources: _resources, ...definition } = value;
      const size = [...index.values()].reduce((sum, file) => sum + file.bytes.length, 0) +
        Buffer.byteLength(JSON.stringify(definition));
      row = { profile: request.profile, pluginId: request.pluginId, revision, definition, index, size, used: Date.now() };
      if (size > MAX_BYTES) throw Error('应用资源超过缓存容量限制');
      while (entries.size >= MAX_ENTRIES || bytes + size > MAX_BYTES) remove(entries.keys().next().value);
      entries.set(key, row); bytes += size;
    } else { hits++; entries.delete(key); entries.set(key, row); row.used = Date.now(); }
    row.etag = request.etag || '';
    return select(row, request);
  } catch (error) { remove(key); throw error; }
}
parentPort.on('message', request => {
  try { parentPort.postMessage({ id: request.id, result: run(request) }); }
  catch (error) { parentPort.postMessage({ id: request.id, error: error.message }); }
});
