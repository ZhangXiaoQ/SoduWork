'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-status-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, 'resources');
  fs.mkdirSync(path.join(resources, 'runner'), { recursive: true });
  const binary = process.platform === 'win32'
    ? (options.legacyBrand ? 'soduwork-runner.exe' : 'soduwork-runner.exe')
    : (options.legacyBrand ? 'soduwork-runner' : 'soduwork-runner');
  fs.writeFileSync(path.join(resources, 'runner', binary), 'fixture');
  const file = path.resolve(__dirname, '../main/runner-runtime.js');
  const nativeRequire = createRequire(file), handlers = new Map(), children = [], timers = [];
  const app = { isPackaged: options.isPackaged !== false, getPath: () => root, whenReady: () => Promise.resolve(), on() {} };
  const context = { module: { exports: {} }, __dirname: path.dirname(file), Buffer,
    process: Object.assign(Object.create(process), { resourcesPath: resources }),
    setTimeout: fn => { timers.push(fn); return fn; }, clearTimeout() {},
    require(name) {
      if (name === './runner-process-lifecycle.cjs') return { supervise: () => ({ stop: async () => {} }) };
      if (name === 'fs' && options.missingPython) return { ...fs,
        existsSync: file => /[\\/]\.venv[\\/](?:Scripts[\\/]python\.exe|bin[\\/]python)$/.test(file)
          ? false : fs.existsSync(file) };
      if (name === 'child_process') return { spawn() {
        const child = new EventEmitter(); child.pid = 100 + children.length;
        child.stdout = new EventEmitter(); child.stdin = new EventEmitter();
        child.stdin.writable = true; child.stdin.write = () => true; child.stdin.end = () => {};
        children.push(child); return child;
      } };
      if (name.includes('custom-runtime-store')) return { startupAgents: () => [] };
      return nativeRequire(name);
    } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  context.module.exports.install({ app, ipcMain: { handle: (id, fn) => handlers.set(id, fn) },
    identityOf: () => ({ hub: 'https://fixture.invalid', clientId: 'fixture-device', secret: 'fixture' }) });
  await Promise.resolve();
  const configure = () => handlers.get('runner-configure')(null, { hub: 'https://fixture.invalid', clientId: 'fixture-device' });
  await configure();
  return { configure, children, timers, status: () => handlers.get('runner-status')(), rpc: context.module.exports.rpc,
    mobile: context.module.exports.setMobileCapabilities,
    report: data => children.at(-1).stdout.emit('data', '@@SODUWORK_RUNNER_STATUS@@' + JSON.stringify(data) + '\n') };
}

test('mobile capability replies use the initiating private Runner pipe', async t => {
  const f = await fixture(t), child = f.children.at(-1), writes = [];
  child.stdin.write = value => writes.push(value);
  f.mobile(async body => ({ operation: body.operation }));
  child.stdout.emit('data', '@@SODUWORK_LOCAL_RPC@@' + JSON.stringify({ kind: 'desktop-capability', id: 'request', body: { operation: 'catalog' } }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  const packet = JSON.parse(writes[0].slice('@@SODUWORK_LOCAL_RPC@@'.length));
  assert.equal(packet.message.op, 'desktop.capability.reply');
  assert.equal(packet.message.requestId, 'request');
  assert.equal(packet.message.result.data.operation, 'catalog');
});

test('mobile capability result never goes to a replaced Runner process', async t => {
  const f = await fixture(t), child = f.children.at(-1), writes = [];
  let finish;
  child.stdin.write = value => writes.push(value);
  f.mobile(() => new Promise(resolve => { finish = resolve; }));
  child.stdout.emit('data', '@@SODUWORK_LOCAL_RPC@@' + JSON.stringify({ kind: 'desktop-capability', id: 'request', body: {} }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  child.emit('exit', 0);
  finish({ plugins: ['private'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 0);
});

test('Runner process existence is distinct from authenticated Hub readiness', async t => {
  const f = await fixture(t);
  assert.equal(f.status().running, true);
  assert.equal(f.status().connected, false);
  assert.equal(f.status().error, '', 'a profile awaiting its first configuration is not a failure');
  f.report({ state: 'online' });
  assert.equal(f.status().connected, true);
  f.report({ state: 'error', code: 'HANDSHAKE_TIMEOUT' });
  assert.equal(f.status().connected, false);
  assert.match(f.status().error, /后台.*确认|确认.*上线/);
  await f.configure();
  assert.match(f.status().error, /后台.*确认|确认.*上线/, 'config refresh cannot erase a connection failure');
  f.report({ state: 'online' });
  assert.equal(f.status().error, '');
});

test('a Runner left over from the previous brand name still starts', async t => {
  const f = await fixture(t, { legacyBrand: true });
  assert.equal(f.status().running, true, 'upgraded installs keep their existing Runner binary working');
});

test('missing development Runner environment is reported by status and local RPC', async t => {
  const f = await fixture(t, { isPackaged: false, missingPython: true });
  assert.equal(f.children.length, 0);
  assert.equal(f.status().running, false);
  assert.equal(f.status().state, 'error');
  assert.match(f.status().error, /hub-backend\/\.venv.*requirements-runner\.txt/);
  await assert.rejects(f.rpc('runtime.detect', { key: 'qwen' }), error => {
    assert.equal(error.code, 'RUNNER_NOT_RUNNING');
    assert.equal(error.message, f.status().error);
    return true;
  });
});

test('asynchronous spawn failure clears phantom process and schedules recovery', async t => {
  const f = await fixture(t);
  f.children[0].emit('error', new Error('fixture spawn denied'));
  assert.equal(f.status().running, false);
  assert.match(f.status().error, /fixture spawn denied/);
  assert.equal(f.timers.length, 1);
  f.timers.shift()();
  assert.equal(f.children.length, 2);
});

test('identity recovery failures remain actionable across child exit and retry', async t => {
  for (const [code, message] of [
    ['IDENTITY_STORAGE_FAILED', /无法保存.*身份.*目录.*写入/],
    ['IDENTITY_RECOVERY_FAILED', /身份恢复失败.*设备登记/],
  ]) {
    const f = await fixture(t);
    f.report({ state: 'error', code: 'IDENTITY_CONFLICT' });
    f.report({ state: 'error', code });
    f.children.at(-1).emit('exit', 1);
    assert.match(f.status().error, message);
    f.timers.shift()();
    await f.configure();
    assert.match(f.status().error, message);
    assert.equal(f.status().connected, false);
    f.report({ state: 'online' });
    assert.equal(f.status().error, '');
  }
});
