'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { check, hash, ROOT } = require('../../tools/check-third-party.cjs');
const { collect, packages, distributionReview } = require('../scripts/prepare-third-party.cjs');
function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'license-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function write(root, name, text) { const dest = path.join(root, name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, text); return dest; }
function pkg(root, name, extra = {}) { const dir = path.join(root, 'node_modules', name); write(dir, 'package.json', JSON.stringify({ name, version: '1.0.0', license: 'MIT', ...extra })); return dir; }
function manifest() { return { notices: [], runtimeNoticeOverrides: [], runtimeNoticeReviews: [] }; }
test('reviewed repository notice snapshots and release wiring are intact', () => assert.deepEqual(check().errors, []));
test('complete README license is preserved verbatim, not reduced to SPDX metadata', t => {
  const root = temp(t), dir = pkg(root, 'readme-license');
  const original = '# Usage\n' + fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  write(dir, 'README.md', original);
  const rows = collect([dir], root, path.join(root, 'out'), manifest());
  assert.equal(rows[0].status, 'notice-collected');
  assert.equal(fs.readFileSync(path.join(root, 'out', rows[0].notices[0]), 'utf8'), original);
});

test('truncated README license phrases are not treated as complete permission', t => {
  const root = temp(t), dir = pkg(root, 'truncated-license');
  write(dir, 'README.md', 'Permission is hereby granted\nTHE SOFTWARE IS PROVIDED\n');
  assert.throws(() => collect([dir], root, path.join(root, 'out'), manifest()), /Missing original license/);
});

test('wrapped original MIT text with single quotes remains complete and is copied verbatim', t => {
  const root = temp(t), dir = pkg(root, 'wrapped-license');
  const original = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8')
    .replace(/"AS IS"/g, "'AS IS'").replace(/ /g, '\n');
  write(dir, 'README.md', original);
  const rows = collect([dir], root, path.join(root, 'out'), manifest());
  assert.equal(fs.readFileSync(path.join(root, 'out', rows[0].notices[0]), 'utf8'), original);
});

test('public installers fail closed while internal builds retain all unresolved blockers', t => {
  const root = temp(t);
  write(root, 'third-party/public-release.json', JSON.stringify({schema: 1, pending: [{id: 'original-license', reason: 'Missing original grant'}]}));
  write(root, 'tools/distribution/PUBLIC-SOURCE.json', JSON.stringify({schema: 1, sourceOnly: true}));
  assert.throws(() => distributionReview(root), /Public installer distribution is blocked/);
  assert.deepEqual(distributionReview(root, true), {schema: 1, internalOnly: true,
    publicDistributionAllowed: false, blockers: ['source-only-release-scope', 'original-license']});
  write(root, 'third-party/public-release.json', JSON.stringify({schema: 1, pending: []}));
  assert.throws(() => distributionReview(root), /source-only-release-scope/);
  write(root, 'tools/distribution/PUBLIC-SOURCE.json', JSON.stringify({schema: 1, sourceOnly: false}));
  assert.equal(distributionReview(root).publicDistributionAllowed, true);
});
test('an unknown missing license blocks packaging instead of silently declaring MIT sufficient', t => {
  const root = temp(t), dir = pkg(root, 'missing');
  assert.throws(() => collect([dir], root, path.join(root, 'out'), manifest()), /Missing original license: missing@1.0.0/);
});
test('notice overrides apply only to the reviewed version and preserve copyright', t => {
  const root = temp(t), dir = pkg(root, 'example'), m = manifest();
  const original = 'Copyright (c) Original contributor\nOriginal license text';
  write(root, 'third-party/example.txt', original);
  m.notices.push({ id: 'example', path: 'third-party/example.txt' });
  m.runtimeNoticeOverrides.push({ name: 'example', version: '1.0.0', notice: 'example' });
  const rows = collect([dir], root, path.join(root, 'out'), m);
  assert.equal(fs.readFileSync(path.join(root, 'out', rows[0].notices[0]), 'utf8'), original);
  write(dir, 'package.json', JSON.stringify({ name: 'example', version: '2.0.0', license: 'MIT' }));
  assert.throws(() => collect([dir], root, path.join(root, 'out-new'), m), /Missing original license/);
});
test('unresolved upstream evidence is explicitly distinguished from collected permission', t => {
  const root = temp(t), dir = pkg(root, 'review-needed'), m = manifest();
  m.runtimeNoticeReviews.push({ name: 'review-needed', version: '1.0.0', reason: 'Awaiting original text' });
  const rows = collect([dir], root, path.join(root, 'out'), m);
  assert.equal(rows[0].status, 'upstream-confirmation-needed');
  assert.deepEqual(rows[0].notices, []);
});
test('scoped nested packages are inventoried separately', t => {
  const root = temp(t), dir = pkg(root, 'parent');
  pkg(dir, '@example/child');
  assert.equal(packages(path.join(root, 'node_modules')).length, 2);
});
test('changed license text fails source gate; CRLF conversion alone is accepted', t => {
  const root = temp(t), original = JSON.parse(fs.readFileSync(path.join(ROOT, 'third-party/manifest.json')));
  for (const name of [...original.notices.map(x => x.path), ...original.vendored.map(x => x.path), ...(original.binaryVendored || []).map(x => x.path), ...(original.lockLicenseReviews || []).flatMap(row => [row.metadata.path, ...row.notices.map(entry => entry.path)]), ...original.locks, 'client/package.json', 'third-party/manifest.json', ...original.skillNotices.flatMap(x => ['skills/'+x+'/LICENSE', 'skills/'+x+'/UPSTREAM.md'])]) write(root, name, fs.readFileSync(path.join(ROOT, name)));
  const sourceInventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'third-party/source-files.json')));
  for (const name of new Set(['third-party/source-files.json', ...sourceInventory.components.flatMap(row => [...row.files, ...row.notices].map(entry => entry.path))])) {
    write(root, name, fs.readFileSync(path.join(ROOT, name)));
  }
  const binaryContent = Buffer.from([0x00, 0x0a, 0x0d, 0x80, 0xff]);
  const binaryPath = 'third-party/fixture.bin';
  const binary = write(root, binaryPath, binaryContent);
  original.binaryVendored = [...(original.binaryVendored || []), { path: binaryPath, sha256: crypto.createHash('sha256').update(binaryContent).digest('hex') }];
  write(root, 'third-party/manifest.json', JSON.stringify(original));
  const file = path.join(root, original.notices[0].path), content = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  fs.writeFileSync(file, content.replace(/\n/g, '\r\n'));
  assert.deepEqual(check(root).errors, []);
  fs.appendFileSync(binary, Buffer.from([0xff]));
  assert.ok(check(root).errors.some(x => x.includes('changed binary provenance')));
  fs.writeFileSync(binary, binaryContent);
  fs.writeFileSync(file, content.replace(/Copyright.*\n/, ''));
  assert.ok(check(root).errors.some(x => x.includes('changed license')));
  assert.notEqual(hash(file), original.notices[0].sha256);
  const lockPath = path.join(root, original.locks[0]);
  const lock = JSON.parse(fs.readFileSync(lockPath));
  const dependency = Object.values(lock.packages).find(row => row.resolved);
  dependency.resolved = 'https://private.invalid/package.tgz?token=fixture-must-not-log';
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  const sourceErrors = check(root).errors.filter(error => error.includes('Unreviewed dependency source'));
  assert.ok(sourceErrors.length > 0);
  assert.ok(!sourceErrors.join('\n').includes('fixture-must-not-log'), 'rejection does not echo registry credentials');
});
