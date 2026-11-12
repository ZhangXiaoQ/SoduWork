'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const runtime = require('./runtime.cjs');
const { assertNoLinks } = require('../plugin-resources');
const MARKER = '.soduwork-connection-state.json';
function location(app, key, scope) {
  const p = runtime.paths(app, key, scope), file = path.join(p.account, MARKER);
  assertNoLinks(p.root, file);
  return { ...p, file };
}
function read(app, key, scope) {
  const p = location(app, key, scope);
  try {
    const value = JSON.parse(fs.readFileSync(p.file, 'utf8'));
    if (value.schema !== 1 || typeof value.revision !== 'string' || typeof value.disconnected !== 'boolean') throw Error();
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { revision: '', disconnected: false, connecting: false };
    throw Error('本机连接状态无法确认，请重新断开后连接');
  }
}
function write(app, key, scope, value) {
  const p = location(app, key, scope);
  fs.writeFileSync(p.file, JSON.stringify({ schema: 1, ...value }), { mode: 0o600 });
  return value;
}
function begin(app, key, scope, disconnected) {
  const binding = key === 'feishu' && read(app, key, scope).registration;
  return write(app, key, scope, { revision: crypto.randomUUID(), disconnected, connecting: !disconnected, cleanupPending: disconnected,
    ...(binding ? {registration:binding} : {}) });
}
function bindRegistration(app, scope, id, url) {
  const state = read(app, 'feishu', scope);
  if (state.disconnected) throw Error('连接操作已取消');
  return write(app, 'feishu', scope, {...state, registration:{id,url}});
}
function finish(app, key, scope, revision) {
  const current = read(app, key, scope);
  if (current.revision !== revision || current.disconnected) throw Error('连接操作已取消');
  return write(app, key, scope, { ...current, connecting: false });
}
function completeDisconnect(app, key, scope, revision) {
  const current = read(app, key, scope);
  if (current.revision !== revision || !current.disconnected) throw Error('连接状态已变化，请重新检查');
  return write(app, key, scope, { ...current, cleanupPending: false });
}
function current(app, key, scope, revision) {
  const value = read(app, key, scope);
  return value.revision === revision && !value.disconnected;
}
function clear(app, key, scope) {
  const p = location(app, key, scope);
  const account = fs.realpathSync(p.account), root = fs.realpathSync(p.root);
  if (!runtime.inside(root, account) || account === root) throw Error('连接授权目录越界');
  const targets = fs.readdirSync(p.account).filter(name => name !== MARKER && name !== '.soduwork-hub-binding.json').map(name => path.join(p.account, name));
  const check = target => {
    if (!runtime.inside(account, path.resolve(target)) || path.resolve(target) === account) throw Error('连接授权目录越界');
    assertNoLinks(p.root, target);
    const info = fs.lstatSync(target);
    if (info.isSymbolicLink()) throw Error('连接授权目录不能包含链接');
    if (info.isDirectory()) for (const name of fs.readdirSync(target)) check(path.join(target, name));
    else if (!info.isFile()) throw Error('连接授权目录包含不支持的文件');
  };
  // Validate every target before clearing dedicated authorization storage; exclude installation, other-account, and business directories.
  targets.forEach(check);
  targets.forEach(target => fs.rmSync(target, { recursive: true, force: false }));
}
module.exports = { read, begin, finish, completeDisconnect, bindRegistration, current, clear, MARKER };
