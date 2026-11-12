'use strict';
// One encrypted, account/application/origin-scoped store for both H5 and shell UI.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { replaceFileSync } = require('./verified-file-replace.cjs');
const KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const SECRET = /ukey|token|secret|password|credential|api.?key|authorization/i;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
let deps;
function configure(value) { deps = value; }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function key(value) {
  if (typeof value !== 'string' || !KEY.test(value) || forbidden.has(value)) throw Error('即用设置参数名无效');
  return value;
}
function clean(value, depth = 0) {
  if (depth > 8) throw Error('即用设置嵌套过深');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string' && value.length <= 16384) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length <= 100) return value.map(v => clean(v, depth + 1));
  if (object(value) && Object.keys(value).length <= 100) return Object.fromEntries(Object.entries(value).map(([k,v]) => [key(k), clean(v, depth + 1)]));
  throw Error('即用设置只接受有限大小的 JSON 值');
}
function normalize(input = {}) {
  if (!object(input)) throw Error('即用设置请求必须是对象');
  const values = input.values == null ? {} : clean(input.values);
  if (!object(values) || Buffer.byteLength(JSON.stringify(values)) > 65536) throw Error('即用设置超过大小限制');
  const list = value => { if (value == null) return []; if (!Array.isArray(value) || value.length > 100) throw Error('设置字段列表无效'); return [...new Set(value.map(key))]; };
  const out = { values, remove: list(input.remove), secretKeys: list(input.secretKeys), keys: input.keys == null ? null : list(input.keys), includeSecrets: input.includeSecrets === true };
  if (input.expectedRevision != null) {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw Error('设置版本无效');
    out.expectedRevision = input.expectedRevision;
  }
  return out;
}
function scope(binding) {
  const owner = deps?.ownerOf?.(), origin = new URL(binding.origin).origin;
  if (!owner || !/^https?:/.test(origin) || !String(binding.pluginId || '').trim()) throw Error('请先登录 SoduWork 再使用即用设置');
  return crypto.createHash('sha256').update(String(owner) + '\0' + binding.pluginId + '\0' + origin).digest('hex');
}
function file() { return path.join(deps.app.getPath('userData'), 'app-settings.secure.json'); }
function doc() {
  try { const value = JSON.parse(fs.readFileSync(file(), 'utf8')); if (value.schema !== 1 || !object(value.records)) throw Error(); return value; }
  catch (error) { if (error.code === 'ENOENT') return { schema: 1, records: {} }; throw Error('即用设置存储无法读取'); }
}
function secure() {
  if (!deps?.safeStorage?.isEncryptionAvailable() || (process.platform === 'linux' && deps.safeStorage.getSelectedStorageBackend?.() === 'basic_text')) throw Error('系统安全存储不可用，无法读写应用凭据');
}
function read(binding) {
  const id = scope(binding), raw = doc().records[id];
  if (!raw) return { values: {}, secretKeys: [], revision: 0 };
  secure();
  try { return JSON.parse(deps.safeStorage.decryptString(Buffer.from(raw, 'base64'))); }
  catch (_) { throw Error('即用设置无法解密，请在当前系统账户下重试'); }
}
function sensitive(value) {
  return object(value) ? Object.entries(value).some(([k,v]) => SECRET.test(k) || sensitive(v)) : Array.isArray(value) && value.some(sensitive);
}
function publicRecord(row, options = {}) {
  const keys = options.keys || Object.keys(row.values), secretKeys = row.secretKeys || [];
  const secretMasks = Object.fromEntries(keys.filter(k => secretKeys.includes(k) && Object.hasOwn(row.values, k)).map(k => {
    const value = row.values[k];
    return [k, k === 'ukey' && typeof value === 'string' && value.length >= 10 ? value.slice(0, 5) + '****' : '****'];
  }));
  return { ok: true, revision: row.revision, updatedAt: row.updatedAt || '', secretKeys,
    secretMasks,
    configuredKeys: Object.keys(row.values), values: Object.fromEntries(keys.filter(k => Object.hasOwn(row.values, k) &&
      (options.includeSecrets === true || !secretKeys.includes(k))).map(k => [k, row.values[k]])) };
}
function get(binding, input) { return publicRecord(read(binding), normalize(input)); }
function write(binding, row) {
  secure();
  const data = doc();
  data.records[scope(binding)] = deps.safeStorage.encryptString(JSON.stringify(row)).toString('base64');
  const target = file(), temp = target + '.next-' + crypto.randomUUID();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try { fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); replaceFileSync(temp, target); }
  finally { fs.rmSync(temp, { force: true }); }
}
// Host-only connection metadata shares the encrypted account/app/origin record.
// It is never returned by settings.get or accepted through settings.update.
function saveConnection(binding, contributionId, connection) {
  const name = key(contributionId), row = read(binding), connections = { ...(row.connections || {}) };
  if (connection) {
    const target = new URL(connection.url);
    if (target.origin !== new URL(binding.origin).origin || target.pathname !== '/mcp' ||
        target.search || target.hash || target.username || target.password ||
        !/^[a-z][a-z0-9-]{0,59}$/.test(connection.server)) throw Error('应用连接参数无效');
    connections[name] = { server: connection.server, url: target.href, credentialKey: key(connection.credentialKey) };
  } else delete connections[name];
  if (JSON.stringify(connections) === JSON.stringify(row.connections || {})) return;
  write(binding, { ...row, connections, connectionRevision: row.revision + 1, revision: row.revision + 1, updatedAt: new Date().toISOString() });
}
// MCP authority follows its credential and declared inputs, not UI preferences.
// Per-key versions also reject a credential changed away and then back.
function mcpRevision(row, installed, credentialKey) {
  const schema = installed?.jiyong || installed?.localDraft?.jiyong;
  const keys = [...new Set([credentialKey, 'accountId', ...(schema?.mcp?.bindings || []).map(b => b.parameter)])].sort();
  return crypto.createHash('sha256').update(JSON.stringify({
    connection: row.connectionRevision ?? 0, connections: row.connections || {},
    keys: keys.map(k => [k, row.keyRevisions?.[k] ?? 0, row.values[k]]),
  })).digest('hex');
}
function update(binding, input) {
  const options = normalize(input), row = read(binding);
  if (options.expectedRevision != null && options.expectedRevision !== row.revision) throw Error('即用设置已变化，请重新读取后重试');
  const values = { ...row.values, ...options.values };
  options.remove.forEach(k => delete values[k]);
  if (Object.keys(values).length > 100 || Buffer.byteLength(JSON.stringify(values)) > 65536) throw Error('即用设置超过大小限制');
  const secretKeys = [...new Set([...(row.secretKeys || []), ...options.secretKeys, ...Object.keys(values).filter(k => SECRET.test(k) || sensitive(values[k]))])].filter(k => Object.hasOwn(values, k));
  if (JSON.stringify(values) === JSON.stringify(row.values) && JSON.stringify(secretKeys) === JSON.stringify(row.secretKeys)) return publicRecord(row);
  const keyRevisions = { ...(row.keyRevisions || {}) };
  for (const k of new Set([...Object.keys(row.values), ...Object.keys(values)])) {
    if (JSON.stringify(row.values[k]) !== JSON.stringify(values[k])) keyRevisions[k] = row.revision + 1;
  }
  const next = { ...row, values, secretKeys, keyRevisions, revision: row.revision + 1, updatedAt: new Date().toISOString() };
  write(binding, next);
  return publicRecord(next);
}
function saveHosted(binding, installed) {
  if (!installed.jiyong || !installed.versionId) return;
  const row = read(binding), hosted = {versionId:installed.versionId,jiyong:installed.jiyong,ui:installed.ui,capabilities:installed.capabilities};
  if (JSON.stringify(row.hosted) === JSON.stringify(hosted)) return;
  write(binding,{...row,hosted});
}
module.exports = { configure, normalize, read, get, update, scope, publicRecord, saveConnection, saveHosted, mcpRevision };
