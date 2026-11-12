'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-public-signing-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('soduwork-public-signing-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const key = crypto.generateKeyPairSync('ed25519'), keyId = 'fixture-public-signing';
  const trust = { schema: 1, keys: { [keyId]: key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') } };
  const seed = path.join(root, 'seed'), trustFile = path.join(root, 'trust.json');
  fs.writeFileSync(seed, Buffer.from(key.privateKey.export({ format: 'jwk' }).d, 'base64url').toString('base64'), { mode: 0o600 });
  fs.writeFileSync(trustFile, JSON.stringify(trust));
  const installer = path.join(root, 'SoduWork-1.13.3-linux.deb');
  fs.writeFileSync(installer, Buffer.alloc(1048576, 0x42));
  const bundle = path.join(root, 'bundle.json');
  const env = { ...process.env, SODUWORK_DISTRIBUTION: 'self-hosted',
    SODUWORK_CLIENT_PLATFORM: 'linux', SODUWORK_CLIENT_ARCH: 'x64', SODUWORK_CLIENT_CHANNEL: 'stable',
    SODUWORK_CLIENT_MINIMUM_VERSION: '', SODUWORK_CLIENT_MANDATORY: '0', SODUWORK_CLIENT_RELEASE_NOTES: '',
    SODUWORK_CLIENT_PUBLISHED_AT: '', SODUWORK_CLIENT_SIGNING_KEY_FILE: seed, SODUWORK_CLIENT_SIGNING_KEY_ID: keyId,
    SODUWORK_CLIENT_TRUST_FILE: trustFile, SODUWORK_CLIENT_RELEASE_BUNDLE: bundle };
  const run = (overrides = {}) => {
    const childEnv = { ...env, ...overrides };
    for (const name of Object.keys(childEnv)) if (childEnv[name] === undefined) delete childEnv[name];
    return spawnSync(process.execPath, [path.resolve(__dirname, '../../tools/sign-client-release.mjs'), installer, '--dry-run'],
      { env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  };
  return { root, trust, installer, bundle, run };
}

test('public signer requires an explicit key ID and the matching original trust key', t => {
  const f = fixture(t);
  for (const overrides of [
    { SODUWORK_CLIENT_SIGNING_KEY_ID: '' },
    { SODUWORK_CLIENT_SIGNING_KEY_ID: 'another-key' },
    { SODUWORK_CLIENT_TRUST_FILE: undefined },
  ]) {
    const result = f.run(overrides);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /KEY_ID is invalid|not trusted/);
    assert.equal(fs.existsSync(f.bundle), false);
  }
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(f.bundle, 'utf8'));
  require('../main/client-update-contract').validateManifest(manifest, f.trust, 'linux');
  assert.equal(manifest.schema, 1, 'retain the deployed Hub update protocol');
  assert.equal(Object.hasOwn(manifest, 'distribution'), false);
  assert.equal(manifest.artifact.sha256, crypto.createHash('sha256').update(fs.readFileSync(f.installer)).digest('hex'));
});

test('excluded private profiles cannot be enabled by trust overrides or acceptance receipts', t => {
  const f = fixture(t), receipt = path.join(f.root, 'acceptance.json');
  fs.writeFileSync(receipt, JSON.stringify({ schema: 1, ok: true, version: '1.13.3' }));
  for (const id of ['internal', 'stage', 'cn', 'global', 'unknown']) {
    const result = f.run({ SODUWORK_DISTRIBUTION: id, SODUWORK_CLIENT_DISTRIBUTION_RECEIPT: receipt });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Only the self-hosted Client distribution/);
    assert.equal(fs.existsSync(f.bundle), false);
  }
});

test('no distribution selector defaults to the same public self-hosted signer', t => {
  const f = fixture(t);
  const result = f.run({ SODUWORK_DISTRIBUTION: undefined });
  assert.equal(result.status, 0, result.stderr);
  require('../main/client-update-contract').validateManifest(JSON.parse(fs.readFileSync(f.bundle)), f.trust, 'linux');
});
