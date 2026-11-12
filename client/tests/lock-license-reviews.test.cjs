'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { check, key } = require('../../tools/lock-license-reviews.cjs');
const ROOT = path.resolve(__dirname, '../..');
const readJson = name => JSON.parse(fs.readFileSync(name, 'utf8'));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'locked-license-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('locked-license-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const manifest = readJson(path.join(ROOT, 'third-party/manifest.json'));
  function write(name, data) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  for (const review of manifest.lockLicenseReviews) {
    for (const entry of [review.metadata, ...review.notices]) {
      write(entry.path, fs.readFileSync(path.join(ROOT, entry.path)));
    }
  }
  const lockName = 'hub-frontend/package-lock.json';
  const fullLock = readJson(path.join(ROOT, lockName));
  const lock = { packages: Object.fromEntries(manifest.lockLicenseReviews.map(review =>
    [review.package, fullLock.packages[review.package]])) };
  const saveLock = () => write(lockName, JSON.stringify(lock));
  saveLock();
  return { root, manifest, lock, saveLock, write };
}

test('four exact frontend packages have original notices without broadening global licenses', () => {
  const manifest = readJson(path.join(ROOT, 'third-party/manifest.json'));
  const result = check(ROOT, manifest);
  assert.deepEqual(result.errors, []);
  assert.equal(result.accepted.size, 4);
  for (const review of manifest.lockLicenseReviews) {
    assert.ok(result.accepted.has(key(review.lock, review.package)));
    assert.equal(manifest.reviewedLicenses.includes(review.declaredLicense), false);
  }
});

for (const [field, value] of [
  ['version', '999.0.0'], ['license', 'MIT'], ['integrity', 'sha512-different'],
  ['resolved', 'https://registry.npmjs.org/dompurify/-/dompurify-999.0.0.tgz'],
]) test('changing locked ' + field + ' invalidates the exact review', t => {
  const f = fixture(t);
  f.lock.packages['node_modules/dompurify'][field] = value;
  f.saveLock();
  const result = check(f.root, f.manifest);
  assert.ok(result.errors.some(error => error.includes('Locked dependency changed')));
  assert.equal(result.accepted.has(key('hub-frontend/package-lock.json', 'node_modules/dompurify')), false);
});

test('a frontend review cannot accept the same package in another lock or package path', t => {
  const f = fixture(t);
  f.write('client/package-lock.json', JSON.stringify(f.lock));
  f.lock.packages['node_modules/other/node_modules/dompurify'] = f.lock.packages['node_modules/dompurify'];
  f.saveLock();
  const result = check(f.root, f.manifest);
  assert.deepEqual(result.errors, []);
  assert.equal(result.accepted.has(key('client/package-lock.json', 'node_modules/dompurify')), false);
  assert.equal(result.accepted.has(key('hub-frontend/package-lock.json', 'node_modules/other/node_modules/dompurify')), false);
});

test('removed locked package invalidates its retained review', t => {
  const f = fixture(t);
  delete f.lock.packages['node_modules/duck']; f.saveLock();
  assert.ok(check(f.root, f.manifest).errors.some(error => error.includes('Locked dependency changed')));
});

for (const target of ['metadata', 'notice']) test('changed ' + target + ' is rejected by its original hash', t => {
  const f = fixture(t), review = f.manifest.lockLicenseReviews[0];
  const entry = target === 'metadata' ? review.metadata : review.notices[0];
  f.write(entry.path, fs.readFileSync(path.join(f.root, entry.path), 'utf8') + '\nchanged\n');
  assert.ok(check(f.root, f.manifest).errors.some(error => error.includes('Changed locked-license evidence')));
});

test('missing original notice and unsafe evidence paths are rejected', t => {
  const f = fixture(t), review = f.manifest.lockLicenseReviews[0];
  review.notices[0].path = 'third-party/licenses/not-present.txt';
  assert.ok(check(f.root, f.manifest).errors.length);
  review.notices[0].path = '../outside.txt';
  assert.ok(check(f.root, f.manifest).errors.some(error => error.includes('Unsafe locked-license evidence path')));
});

test('pako retains both MIT and Zlib, with a complete notice for each obligation', t => {
  const f = fixture(t), review = f.manifest.lockLicenseReviews.find(row => row.package === 'node_modules/pako');
  review.notices = review.notices.filter(entry => entry.license === 'MIT');
  assert.ok(check(f.root, f.manifest).errors.some(error => error.includes('Missing original notice')));
  review.licenses = ['MIT'];
  assert.ok(check(f.root, f.manifest).errors.some(error => error.includes('declared alternatives or obligations')));
});

test('dual-license selection must be one of the package declarations', t => {
  const f = fixture(t), review = f.manifest.lockLicenseReviews[0];
  review.licenses = ['MIT'];
  assert.ok(check(f.root, f.manifest).errors.some(error => error.includes('declared alternatives or obligations')));
});

test('even rehashed package metadata must match the locked name, version and declaration', t => {
  const f = fixture(t), review = f.manifest.lockLicenseReviews[0];
  const metadata = readJson(path.join(f.root, review.metadata.path));
  metadata.version = '0.0.0';
  const content = JSON.stringify(metadata);
  f.write(review.metadata.path, content);
  review.metadata.sha256 = crypto.createHash('sha256').update(content).digest('hex');
  assert.ok(check(f.root, f.manifest).errors.some(error => error.includes('Package metadata does not match')));
});

test('duplicate scoped records fail instead of shadowing the first review', t => {
  const f = fixture(t);
  f.manifest.lockLicenseReviews.push(structuredClone(f.manifest.lockLicenseReviews[0]));
  assert.ok(check(f.root, f.manifest).errors.some(error => error.includes('Duplicate locked-license review')));
});

test('line-ending conversion preserves original license evidence', t => {
  const f = fixture(t), entry = f.manifest.lockLicenseReviews[0].notices[0];
  const content = fs.readFileSync(path.join(f.root, entry.path), 'utf8').replace(/\r\n/g, '\n');
  f.write(entry.path, content.replace(/\n/g, '\r\n'));
  assert.deepEqual(check(f.root, f.manifest).errors, []);
});
