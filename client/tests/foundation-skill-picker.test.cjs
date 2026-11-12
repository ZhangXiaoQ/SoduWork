'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const capabilities = require('../main/conversation/capabilities');
const skillTurn = require('../main/pi-session/skill-turn');
const access = require('../main/access-control/policy');

const foundationNames = ['browser-use', 'computer-use', 'office'];
const businessNames = ['code-review', 'codebase-design', 'diagnosing-bugs', 'domain-modeling',
  'grill-with-docs', 'improve-codebase-architecture', 'prototype', 'resolving-merge-conflicts', 'tdd', 'wizard'];
const names = [...foundationNames, ...businessNames];
const policy = { ok: true, skills: names.map(name => ({ name, description: 'Guide for ' + name })), enabled: names };
function probeDependencies() {
  return { platform: 'win32', env: { SODUWORK_BROWSER: '/fixture/chrome.exe' }, exists: () => true,
    read: () => '---\nname: fixture\ndescription: Fixture\n---\n',
    run: command => ({ status: 0, stdout: command === 'node' ? 'v24.4.0' : 'python-docx + openpyxl + python-pptx' }) };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-foundation-picker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillDirs = names.map(name => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Trusted ${name} guide\n---\nFollow existing tool permissions.\n`);
    return dir;
  });
  const now = Math.floor(Date.now() / 1000);
  const identity = { hub: 'https://fixture.invalid', clientId: 'foundation-device',
    session: Buffer.from(JSON.stringify({ typ: 'device', uid: 'owner', cid: 'foundation-device', iat: now,
      exp: now + 3600 })).toString('base64url') + '.' + '0'.repeat(64) };
  return { root, skillDirs, identity, app: { getPath: () => root },
    options: { policy, skillDirs, deps: probeDependencies(), deviceGrants: [] } };
}

test('the selectable catalog includes all thirteen policy skills without changing business or tool grants', async t => {
  const f = fixture(t);
  const view = await capabilities.inspect(f.options);
  assert.deepEqual(view.skillCatalog.map(item => item.name), names);
  assert.equal(view.skillCatalog.length, 13);
  assert.ok(view.skillCatalog.every(item => item.installed && item.selectable && item.personalEnabled));
  assert.deepEqual(view.businessSkills.map(item => item.name), businessNames);
  assert.equal(view.items.find(item => item.id === 'computer').selected, false);
  assert.equal(view.items.find(item => item.id === 'computer').grantRequired, true);
  const resolved = await capabilities.resolve({ ...f.options, requested: [], selectedSkills: foundationNames });
  assert.deepEqual(resolved.capabilityIds, [], 'picking a guide must not grant or enable its tools');
  assert.deepEqual(resolved.skills.map(item => item.name), businessNames);
  assert.ok(resolved.skillDirs.every(dir => !foundationNames.includes(path.basename(dir))));
});

test('production capability IPC forwards the full catalog to every runtime picker', async t => {
  const f = fixture(t), handlers = new Map();
  const file = require.resolve('../main/pi-session/environment-ipc');
  const nativeRequire = createRequire(file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, console, setTimeout, clearTimeout,
    require: name => name === 'electron' ? { shell: {} } : name === '../conversation/capabilities'
      ? { inspect: () => capabilities.inspect(f.options) } : nativeRequire(name) }, { filename: file });
  module.exports.install({ app: f.app, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    session: {}, identityOf: async () => f.identity, capabilityGrantsOf: () => [], _skillDirs: () => f.skillDirs,
    workDir: () => f.root, _saveConf() {}, _conf: () => ({}) });
  for (const adapterId of ['pi', 'opencode', 'harness2']) {
    const result = await handlers.get('conversation-capabilities')({}, { adapterId, executionLocation: 'local' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.skills.map(item => item.name), names);
    assert.equal(result.items.find(item => item.id === 'computer').deviceGranted, false);
  }
});

test('picked foundation guides use the existing trusted policy and resource path without widening access', async t => {
  const f = fixture(t), policyRequests = [];
  const resolveSkills = skillTurn.resolver({ app: f.app, identity: f.identity, identityOf: async () => f.identity,
    skillDirs: () => f.skillDirs, fetchPolicy: async (...args) => { policyRequests.push(args); return policy; } });
  const prepared = await skillTurn.prepare({ cwd: f.root, resolveSkills }, { skills: foundationNames });
  assert.equal(prepared.ok, true, prepared.reason);
  assert.deepEqual(prepared.names, foundationNames);
  assert.deepEqual(prepared.skills.map(item => item.name), foundationNames);
  assert.equal(policyRequests[0][3], true, 'explicit selection revalidates current account policy');
  const originalPolicy = access.create('standard', path.join(f.root, 'workspace'));
  const before = JSON.stringify(originalPolicy);
  for (const name of foundationNames) {
    const dir = path.join(f.root, name);
    assert.equal(access.operation(originalPolicy, 'read', { path: path.join(dir, 'SKILL.md') }, originalPolicy.cwd,
      prepared.readScope).verdict, 'allow');
    assert.equal(access.operation(originalPolicy, 'write', { path: path.join(dir, 'SKILL.md') }, originalPolicy.cwd,
      prepared.readScope).verdict, 'ask');
  }
  assert.equal(JSON.stringify(originalPolicy), before);
  let workerCalls = 0;
  const runner = await skillTurn.prepareRunner({ app: f.app, cwd: f.root, resolveSkills },
    { skills: foundationNames }, { prepareSkills: async (app, request) => {
      workerCalls++;
      assert.equal(app, f.app);
      assert.deepEqual(request.names, foundationNames);
      assert.deepEqual(request.items, foundationNames.map(name => ({ name, path: path.join(f.root, name) })));
      assert.equal(request.capabilityIds, undefined);
      return { ok: true, names: request.names };
    } });
  assert.equal(runner.ok, true);
  assert.equal(workerCalls, 1);
});

test('foundation selection still rejects revoked policy before synchronization or execution', async t => {
  const f = fixture(t);
  const resolveSkills = skillTurn.resolver({ app: f.app, identity: f.identity, identityOf: async () => f.identity,
    skillDirs: () => f.skillDirs, fetchPolicy: async () => ({ ...policy, revoked: ['computer-use'] }),
    ensure: async () => { throw Error('Revoked selection must not synchronize'); } });
  const result = await skillTurn.prepareRunner({ app: f.app, cwd: f.root, resolveSkills },
    { skills: ['computer-use'] }, { prepareSkills: async () => { throw Error('Revoked selection must not execute'); } });
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, 'skill-selection');
  assert.match(result.reason, /computer-use/);
});
