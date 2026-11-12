// Run against a fresh, already verified extraction of the final deliverable EXE.
'use strict';
process.noAsar = true;
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { isNoticePath } = require('../build/verify-payload.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function main() {
  const candidateFile = path.resolve(process.argv[2]), work = path.dirname(candidateFile);
  const candidate = JSON.parse(fs.readFileSync(candidateFile));
  assert.equal(candidate.payloadVerified, true);
  const root = JSON.parse(fs.readFileSync(path.join(work, 'payload-result.json'))).extracted;
  assert.equal(path.dirname(root), require('node:os').tmpdir());
  assert.ok(path.basename(root).startsWith('soduwork-package-check-'));
  assert.deepEqual(fs.readFileSync(path.join(root, '.soduwork-verify.cjs')), fs.readFileSync(path.resolve(__dirname, '../build/verify-payload.cjs')));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.soduwork-payload.json')));
  const notices = manifest.files.filter(item => isNoticePath(item.path));
  assert.ok(notices.length >= 150, 'Full production payload notices; frozen Runner notices are embedded with its runtime');
  assert.ok(notices.some(item => item.path === 'LICENSE.electron.txt' || item.path === 'LICENSE'));
  assert.ok(notices.some(item => item.path.includes('resources/shell/')));
  assert.ok(notices.some(item => item.path.includes('resources/pi/')));
  assert.ok(!manifest.files.some(item => /^resources\/opencode\//i.test(item.path)),
    'Optional OpenCode is installed separately and must not enter the SoduWork payload');
  const originals = new Map(), start = Date.now();
  function change(item, transform) {
    const file = path.join(root, item.path), bytes = fs.readFileSync(file);
    assert.equal(sha(bytes), item.sha256); originals.set(file, bytes);fs.writeFileSync(file, transform(bytes));
  }
  function verify(name) {
    const report = path.join(work, name + '.json');
    const profile = require('../scripts/installed-distribution.cjs').installedDistribution(root);
    const result = spawnSync(path.join(root, profile.windowsExecutableName + '.exe'), [path.join(root, '.soduwork-verify.cjs'), root, report], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 300000,
    });
    assert.equal(result.error, undefined);
    return { code: result.status, report: JSON.parse(fs.readFileSync(report)) };
  }
  let compatible, rejected;
  try {
    for (const item of notices) change(item, bytes => Buffer.concat([crypto.randomBytes(4096), bytes]));
    compatible = verify('all-notices-compatibility');
    assert.equal(compatible.code, 0);assert.equal(compatible.report.ok, true);
    assert.equal(compatible.report.fileCount, manifest.files.length);
    assert.equal(compatible.report.noticeDifferences.length, notices.length);
    for (const detail of compatible.report.noticeDifferences) {
      assert.equal(detail.actualSize, detail.expectedSize + 4096);
      assert.equal(detail.sourceSha256, detail.expectedSha256);
      assert.equal(detail.verification, 'verified-redistribution-bundle');
      assert.equal(fs.readFileSync(path.join(root, detail.path)).length, detail.actualSize);
    }
    const critical = ['resources/app.asar', 'resources/pi/node_modules/@earendil-works/pi-coding-agent/package.json',
      'resources/skills/office/SKILL.md'];
    for (const name of critical) {
      const item = manifest.files.find(file => file.path === name); assert.ok(item, name);
      change(item, bytes => { const modified = Buffer.from(bytes);modified[0] ^= 1;return modified; });
    }
    rejected = verify('all-notices-with-runtime-corruption');
    assert.equal(rejected.code, 2);assert.equal(rejected.report.errorCount, critical.length);
    assert.equal(rejected.report.checkedFiles, manifest.files.length);
    assert.deepEqual(rejected.report.errors.map(x => x.path).sort(), critical.sort());
  } finally {
    for (const [file, bytes] of originals) { fs.writeFileSync(file, bytes);assert.equal(sha(fs.readFileSync(file)), sha(bytes)); }
  }
  fs.writeFileSync(path.join(work, 'all-notices-regression.json'), JSON.stringify({
    ok: true, version: candidate.version, installerSha256: candidate.sha256,
    filesVerified: manifest.files.length, noticesTransformed: notices.length,
    compatibilityPassed: compatible.code === 0, runtimeCorruptionRejected: rejected.code === 2,
    allRuntimeFailuresReported: rejected.report.errorCount, restored: true, durationMs: Date.now() - start,
    simulation: 'All notice files in actual final EXE extraction receive random 4096-byte prefixes; no live customer file-protection agent',
  }, null, 2));
  console.log('PASS: all ' + notices.length + ' final-package notices modified together; full payload passes; all three runtime corruptions rejected.');
}
main().catch(error => { console.error(error);process.exitCode = 1; });
