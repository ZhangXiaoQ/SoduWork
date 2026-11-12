'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const vm = require('node:vm'), crypto = require('node:crypto');
const { secureStorageProbe } = require('../../tools/ci/installed-client-secure-storage.cjs');
function fixture(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-acceptance-profile-cipher-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  return { profile, file: path.join(profile, 'acceptance-secure-storage.bin') };
}
function processProbe(profile, mode, key, available = true) {
  const safeStorage = {
    isEncryptionAvailable: () => available,
    encryptString(text) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(bytes) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
  return vm.runInNewContext('(' + secureStorageProbe.toString() + ')(profile, mode)', {
    profile, mode, process: { mainModule: { require: name => name === 'electron' ? { safeStorage } : require(name) } },
  });
}
test('separate restart and upgrade processes must decrypt the original ciphertext', t => {
  const f = fixture(t), key = crypto.randomBytes(32);
  const written = processProbe(f.profile, 'write', key), bytes = fs.readFileSync(f.file);
  for (const phase of ['restart', 'upgrade']) {
    const read = processProbe(f.profile, 'read', Buffer.from(key));
    assert.equal(read.ciphertextSha256, written.ciphertextSha256, phase);
    assert.equal(read.persisted, true); assert.equal(read.mode, 'read');
    assert.deepEqual(fs.readFileSync(f.file), bytes);
  }
});
test('a changed encryption key fails without replacing prior ciphertext', t => {
  const f = fixture(t);
  processProbe(f.profile, 'write', crypto.randomBytes(32)); const bytes = fs.readFileSync(f.file);
  assert.throws(() => processProbe(f.profile, 'read', crypto.randomBytes(32)));
  assert.deepEqual(fs.readFileSync(f.file), bytes);
});
test('missing or corrupt ciphertext fails instead of generating a new marker', t => {
  const f = fixture(t), key = crypto.randomBytes(32);
  assert.throws(() => processProbe(f.profile, 'read', key), /ENOENT/);
  assert.equal(fs.existsSync(f.file), false);
  processProbe(f.profile, 'write', key);
  fs.writeFileSync(f.file, 'corrupt');
  assert.throws(() => processProbe(f.profile, 'read', key));
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'corrupt');
});
test('write mode cannot erase an existing cipher and unavailable storage creates none', t => {
  const f = fixture(t), key = crypto.randomBytes(32);
  assert.throws(() => processProbe(f.profile, 'write', key, false), /unavailable/);
  assert.equal(fs.existsSync(f.file), false);
  processProbe(f.profile, 'write', key); const bytes = fs.readFileSync(f.file);
  assert.throws(() => processProbe(f.profile, 'write', key), /EEXIST/);
  assert.deepEqual(fs.readFileSync(f.file), bytes);
});
test('secure-storage probe rejects profiles outside the acceptance namespace', t => {
  const f = fixture(t), key = crypto.randomBytes(32);
  assert.throws(() => processProbe(path.dirname(f.profile), 'write', key), /isolated acceptance profile/);
  assert.throws(() => processProbe(f.profile, 'other', key), /Invalid.*mode/);
  assert.equal(fs.existsSync(f.file), false);
});
