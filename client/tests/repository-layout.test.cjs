'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { sourceFiles } = require('../../tools/source-files.cjs');
const { auditFiles, auditPackaging, check } = require('../../tools/check-repository-layout.cjs');

test('repository contains maintained source and reproducible build boundaries', () => {
  const result = check();
  assert.deepEqual(result.errors, []);
  assert.ok(result.sourceFiles > 1000);
});

test('restored Electron downloads stay outside source while unknown and tracked cache files still fail', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-ci-cache-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', root], { stdio: 'pipe' });
  fs.copyFileSync(path.resolve(__dirname, '../../.gitignore'), path.join(root, '.gitignore'));
  const cached = '.cache/electron/SHASUMS256.txt', unknown = '.cache/unknown/source.js';
  for (const name of [cached, unknown]) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), 'isolated cache fixture');
  }
  let files = sourceFiles(root);
  assert.equal(files.includes(cached), false);
  assert.equal(files.includes(unknown), true);
  assert.ok(auditFiles(files).includes('Undocumented source root: .cache'));
  fs.unlinkSync(path.join(root, unknown));
  assert.deepEqual(auditFiles(sourceFiles(root)), []);
  execFileSync('git', ['-C', root, 'add', '--force', cached], { stdio: 'pipe' });
  files = sourceFiles(root);
  assert.equal(files.includes(cached), true);
  assert.ok(auditFiles(files).includes('Undocumented source root: .cache'));
});

test('generated binaries, runtime identities and retired routes cannot return as source', () => {
  const bad = ['client/runner/_internal/skills/browser-use/SKILL.md', 'client/runner/soduwork-runner.exe',
    'client/pi-chat/assets/main.js', 'skin-server/data/users/person/profile.json',
    'hub-backend/uploads/report.md', 'client/components/panels/panels-ms-agent.js'];
  for (const name of bad) assert.ok(auditFiles([name]).length > 0, name);
  assert.deepEqual(auditFiles(['client/runner/README.md', 'hub-backend/runner.spec',
    'hub-backend/migrations/versions/0053_unified_requirements.py', 'skills/browser-use/SKILL.md',
    '.github/workflows/ci.yml', '.github/workflows/packages.yml', 'mobile/lib/main.dart',
    '.github/ISSUE_TEMPLATE/bug_report.yml']), []);
});

test('all distribution formats reject stale Runner reuse and broad resource copying', () => {
  const original = require('../package.json');
  for (const hook of ['prebuild', 'prebuild-portable', 'build:mac', 'prebuild:linux']) {
    const pkg = structuredClone(original);
    pkg.scripts[hook] = 'electron-builder';
    assert.ok(auditPackaging(pkg).some(error => error.includes(hook)));
  }
  let pkg = structuredClone(original);
  pkg.build.win.extraResources.find(row => row.from === 'runner').filter.push('**/*');
  assert.ok(auditPackaging(pkg).some(error => error.includes('single-file')));
  pkg = structuredClone(original);
  pkg.build.win.extraResources.find(row => row.from === 'runner').filter = [];
  assert.ok(auditPackaging(pkg).some(error => error.includes('single-file')));
  pkg = structuredClone(original);
  pkg.build.mac.extraResources.find(row => row.from === 'runner').filter.push('soduwork-runner.exe');
  assert.ok(auditPackaging(pkg).some(error => error.includes('macOS Runner resources must select')));
  pkg = structuredClone(original);
  pkg.build.linux.extraResources.find(row => row.from === 'runner').filter.push('soduwork-runner.exe');
  assert.ok(auditPackaging(pkg).some(error => error.includes('Linux Runner resources must select')));
  pkg = structuredClone(original);
  pkg.build.extraResources.push({ from: 'runner', to: 'runner', filter: ['soduwork-runner.exe'] });
  assert.ok(auditPackaging(pkg).some(error => error.includes('platform sections')));
});
