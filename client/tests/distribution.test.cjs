"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const distribution = require('../main/distribution.cjs');
const endpoint = require('../main/hub-endpoint.cjs');
const { initializeUserData } = require('../main/userdata-path.cjs');
const { canonicalBytes, manifestPayload, validateManifest } = require('../main/client-update-contract');

function appFixture(t, isPackaged) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-self-hosted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let userData;
  const app = { isPackaged, getPath: key => key === 'appData' ? root : userData,
    setPath: (_, value) => { userData = value; } };
  initializeUserData(app, {});
  return app;
}

test('public identity comes from the existing package and configured update trust', () => {
  const profile = distribution.current();
  const packageInfo = require('../package.json');
  assert.equal(profile.distributionId, 'self-hosted');
  assert.equal(profile.hubOrigin, 'http://127.0.0.1:18989');
  assert.equal(profile.websiteUrl, packageInfo.homepage || '');
  assert.equal(profile.appId, packageInfo.build.appId);
  assert.equal(profile.productName, packageInfo.productName);
  assert.equal(profile.userDataName, 'SoduWork');
  assert.equal(profile.workspaceName, 'SoduWork');
  assert.equal(profile.linuxPackageName, packageInfo.build.deb.packageName);
  assert.deepEqual(profile.updateTrust, require('../update-trust.json'));
  assert.ok(Object.isFrozen(profile.updateTrust.keys));
  assert.deepEqual(distribution.fromMetadata(profile), profile);
  for (const id of ['internal', 'stage', 'cn', 'global', 'unknown']) {
    assert.throws(() => distribution.selected({ SODUWORK_DISTRIBUTION: id }), /Unknown/);
  }
});

test('bundled metadata cannot inject another Hub or update signing key', () => {
  const profile = distribution.current();
  assert.throws(() => distribution.fromMetadata({ ...profile, hubOrigin: 'https://another.example.test' }), /differs/);
  assert.throws(() => distribution.fromMetadata({ ...profile, updateTrust: { schema: 1,
    keys: { injected: crypto.randomBytes(32).toString('base64') } } }), /differs/);
  assert.throws(() => distribution.selected({ SODUWORK_RELEASE_HUB_URL: 'https://another.example.test' }), /does not match/);
});

test('self-hosted update channels are explicit, validated and bound to package identity', () => {
  const packageInfo = require('../package.json');
  const previous = packageInfo.soduworkUpdateChannel;
  try {
    delete packageInfo.soduworkUpdateChannel;
    const stable = distribution.getProfile();
    assert.equal(stable.updateChannel, 'stable');
    packageInfo.soduworkUpdateChannel = 'beta';
    const beta = distribution.getProfile();
    assert.equal(beta.updateChannel, 'beta');
    assert.notEqual(beta.configSha256, stable.configSha256);
    assert.deepEqual(distribution.fromMetadata(beta), beta);
    assert.throws(() => distribution.fromMetadata(stable), /differs/);
    packageInfo.soduworkUpdateChannel = 'unknown';
    assert.throws(() => distribution.getProfile(), /Invalid Client update channel/);
  } finally {
    if (previous === undefined) delete packageInfo.soduworkUpdateChannel;
    else packageInfo.soduworkUpdateChannel = previous;
  }
});

test('an otherwise valid signed manifest is rejected when isolated public trust has no keys', t => {
  const signing = crypto.generateKeyPairSync('ed25519');
  const manifest = { schema: 1, version: '99.0.0', releaseId: '00000000-0000-4000-8000-000000000001',
    channel: 'stable', platform: 'win32', arch: 'x64', keyId: 'unregistered',
    artifact: { name: 'SoduWork-99.0.0-Setup.exe', size: 1048576, sha256: 'a'.repeat(64),
      url: '/api/v1/client-updates/artifacts/00000000-0000-4000-8000-000000000001' },
    signature: Buffer.alloc(64).toString('base64') };
  manifest.signature = crypto.sign(null, canonicalBytes(manifestPayload(manifest)), signing.privateKey).toString('base64');
  const fixtureTrust = { schema: 1, keys: { unregistered: signing.publicKey.export({ format: 'der', type: 'spki' })
    .subarray(-32).toString('base64') } };
  assert.equal(validateManifest(manifest, fixtureTrust, 'win32'), manifest);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-empty-update-trust-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('soduwork-empty-update-trust-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'main'));
  for (const file of ['distribution.cjs', 'hub-endpoint.cjs']) {
    fs.copyFileSync(path.join(__dirname, '../main', file), path.join(root, 'main', file));
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(require('../package.json')));
  fs.writeFileSync(path.join(root, 'update-trust.json'), JSON.stringify({ schema: 1, keys: {} }));
  const isolated = require(path.join(root, 'main/distribution.cjs')).current();
  assert.deepEqual(isolated.updateTrust.keys, {});
  assert.throws(() => validateManifest(manifest, isolated.updateTrust, 'win32'), /不受信任/);
});

for (const isPackaged of [false, true]) test(`self-hosted ${isPackaged ? 'packaged' : 'source'} clients persist an editable Hub`, t => {
  const app = appFixture(t, isPackaged);
  assert.deepEqual(endpoint.initialize(app, {}), { hub: 'http://127.0.0.1:18989', editable: true, internalTest: false });
  assert.equal(endpoint.prepare(app, 'https://hub.example.test').ok, true);
  assert.equal(endpoint.initialize(app, {}).hub, 'https://hub.example.test');
  assert.equal(distribution.publicInfo().websiteUrl, '');
});
