'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const support = require('../../tools/ci/windows-acceptance-support.cjs');

test('owned-root checks accept both fixture families and SYSTEM TEMP casing', () => {
  for (const prefix of ['soduwork-install-acceptance-', 'soduwork-update-e2e-']) {
    support.assertOwnedRoot(path.win32.join(String.raw`C:\Windows\TEMP`, prefix + 'fixture'), String.raw`C:\Windows\Temp`);
  }
});

test('owned-root checks reject arbitrary, sibling, relative and nested directories', () => {
  for (const root of [String.raw`C:\Program Files\soduwork-install-acceptance-fixture`,
    String.raw`C:\Windows\Temp\user-data`, String.raw`C:\Windows\Temp\soduwork-install-acceptance-fixture\child`,
    'relative-root', null]) {
    assert.throws(() => support.assertOwnedRoot(root, String.raw`C:\Windows\Temp`));
  }
});

test('cleanup selects the current uninstaller instead of stale brand aliases', () => {
  assert.deepEqual(support.pendingUninstallers(['SoduWork.exe', 'Uninstall SoduWork.exe', 'Uninstall SoduWork.exe'], true),
    ['Uninstall SoduWork.exe']);
  assert.deepEqual(support.pendingUninstallers(['Uninstall SoduWork.exe', 'settings.json'], true), ['Uninstall SoduWork.exe']);
});

test('cleanup does not run residual uninstallers after the install was removed', () => {
  assert.deepEqual(support.pendingUninstallers(['Uninstall SoduWork.exe', 'Uninstall SoduWork.exe'], false), []);
});

test('uninstall waits for its maintenance process and does not stop unrelated product processes', () => {
  const root = path.win32.join(os.tmpdir(), 'soduwork-install-acceptance-fixture');
  const own = { pid: 9, exe: path.win32.join(root, '.soduwork-versions', 'ns01.tmp', 'SoduWork.exe'), owned: true, maintenance: true };
  const foreign = { pid: 10, exe: String.raw`C:\Program Files\SoduWork\SoduWork.exe`, owned: false, maintenance: false };
  let elapsed = 0, queries = 0;
  const ps = (_script, env) => {
    assert.equal(env.SODUWORK_ACCEPT_OWNED_ROOT, root);
    return JSON.stringify(++queries < 3 ? [own, foreign] : [foreign]);
  };
  const result = support.waitForOwnedExit(root, ps, { now: () => elapsed, sleep: ms => { elapsed += ms; } });
  assert.equal(result.waitedMs, 500);
  assert.deepEqual(result.observed, [own]);
});
test('owned process timeout and cleanup errors remain failures', () => {
  const root = path.win32.join(os.tmpdir(), 'soduwork-install-acceptance-fixture');
  let elapsed = 0;
  assert.throws(() => support.waitForOwnedExit(root, () => JSON.stringify([{ pid: 9, owned: true }]),
    { timeout: 500, now: () => elapsed, sleep: ms => { elapsed += ms; } }), /did not exit/);
  assert.throws(() => support.stopOwnedProcesses(root, () => { throw Error('taskkill failed'); }), /taskkill failed/);
});
test('PowerShell process diagnostics and cleanup use only the owned path and check native exit status',
  { skip: process.platform !== 'win32' }, () => {
    const root = path.win32.join(os.tmpdir(), 'soduwork-install-acceptance-fixture');
    function execute(script, extraEnv = {}, outcome = 'success') {
      // All process commands below are in-memory PowerShell functions. No
      // native application, registry entry or user process is touched.
      // CIM returns a full native path even when TEMP uses an 8.3 alias.
      const prelude = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$script:alive=$true;" +
        "$script:owned=[pscustomobject]@{ProcessId=9;Name='SoduWork.exe';CreationDate='fixture';" +
        "ExecutablePath=[IO.Path]::GetFullPath($env:SODUWORK_ACCEPT_OWNED_ROOT+'\\SoduWork.exe');CommandLine='.soduwork-prune.cjs --schedule'};" +
        "$script:foreign=[pscustomobject]@{ProcessId=10;Name='SoduWork.exe';CreationDate='other';" +
        "ExecutablePath='C:\\Program Files\\SoduWork\\SoduWork.exe';CommandLine='not exposed'};" +
        "function Get-CimInstance {param($ClassName,$Filter) if($Filter){if($script:alive){$script:owned}}" +
        "else{if($script:alive){$script:owned};$script:foreign}};" +
        "function Get-Process {param($Id,$ErrorAction) if($script:alive){$script:owned}};" +
        "function taskkill.exe {if($args[0] -ne '/PID' -or [int]$args[1] -ne 9){throw 'Foreign PID was targeted'};" +
        "if($env:SODUWORK_FIXTURE_OUTCOME -eq 'failed'){$global:LASTEXITCODE=5}" +
        "elseif($env:SODUWORK_FIXTURE_OUTCOME -eq 'gone'){$script:alive=$false;$global:LASTEXITCODE=128}" +
        "else{$script:alive=$false;$global:LASTEXITCODE=0}};";
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', prelude + script],
        { encoding: 'utf8', windowsHide: true, timeout: 15000,
          env: { ...process.env, ...extraEnv, SODUWORK_FIXTURE_OUTCOME: outcome } });
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      return result.stdout.trim();
    }
    const rows = support.processes(root, execute);
    assert.deepEqual(rows.map(row => [row.pid, row.owned, row.maintenance]), [[9, true, true], [10, false, false]]);
    assert.equal(JSON.stringify(rows).includes('not exposed'), false);
    let cleanupScript;
    support.stopOwnedProcesses(root, (script, env) => {
      if (!cleanupScript) { cleanupScript = script; return execute(script, env); }
      return '[]';
    });
    execute(cleanupScript, { SODUWORK_ACCEPT_OWNED_ROOT: root }, 'gone');
    assert.throws(() => execute(cleanupScript, { SODUWORK_ACCEPT_OWNED_ROOT: root }, 'failed'), /Owned fixture taskkill failed/);
  });
test('acceptance receipt is written only after every owned cleanup succeeds', async t => {
  const vm = require('node:vm');
  const source = require('node:fs').readFileSync(path.join(__dirname, '../../tools/ci/accept-windows.cjs'), 'utf8');
  const root = path.join(os.tmpdir(), 'soduwork-install-acceptance-fixture');
  const version = '9.9.1';
  for (const failCleanup of [false, true]) {
    let completedChecks;
    const calls = [], errors = [], state = { platform: 'win32', execPath: process.execPath, env: {} };
    const contract = {
      root: 'fixture', dist: 'fixture-dist', evidence: 'fixture-evidence',
      verify: async () => ({ version, artifacts: [{ name: 'fixture.exe', sha256: 'new-sha' }] }),
      read: async () => ({ ok: true, version, sha256: 'new-sha', root,
        oldVersion: '1.12.80', oldBrand: 'SoduWork', oldSha256: 'old-sha' }),
      acceptance: async (_platform, checks) => { completedChecks = checks; calls.push('receipt'); },
    };
    const fakeFs = {
      mkdir: async () => {}, mkdtemp: async () => path.join(os.tmpdir(), 'soduwork-accept-packages-fixture'),
      readdir: async () => [],
      rm: async target => {
        calls.push('cleanup');
        if (target === root && failCleanup) throw Error('owned cleanup failed');
      },
    };
    const modules = {
      'node:fs/promises': fakeFs, 'node:path': path, 'node:os': os, 'node:assert/strict': assert,
      'node:child_process': { spawnSync: () => { throw Error('Unexpected native call'); } },
      './release-artifacts.cjs': contract,
      './acceptance-common.cjs': { run: async () => {}, soduworkBaseline: async () => ({ productName: 'SoduWork',
        path: 'old.exe', version: '1.12.80', sha256: 'old-sha' }) },
      './windows-acceptance-support.cjs': { ...support, stopOwnedProcesses: () => {} },
    };
    await vm.runInNewContext(source, { __dirname: path.join(__dirname, '../../tools/ci'), process: state,
      require: id => { assert.ok(id in modules, id); return modules[id]; },
      console: { log: () => {}, error: error => errors.push(error) } });
    if (failCleanup) {
      assert.equal(state.exitCode, 1);
      assert.equal(calls.includes('receipt'), false);
      assert.equal(errors[0].message, 'Windows acceptance cleanup failed');
    } else {
      assert.equal(state.exitCode, undefined);
      assert.equal(calls.at(-1), 'receipt');
      assert.equal(errors.length, 0);
      assert.deepEqual(Array.from(completedChecks, row => row.name), ['fresh-repair', 'soduwork-upgrade', 'compatibility']);
      assert.equal(completedChecks.find(row => row.name === 'soduwork-upgrade').oldVersion, '1.12.80');
    }
  }
});


test('public Windows acceptance reaches artifact validation without private distribution modules', () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const entry = path.resolve(__dirname, '../../tools/ci/windows-installed-check.cjs');
  const entryRequire = require('node:module').createRequire(entry);
  const state = { platform: 'win32', env: {}, argv: ['node', entry,
    path.join(os.tmpdir(), 'fixture-installer.exe'), path.join(os.tmpdir(), 'fixture-receipt')] };
  let sideEffects = 0;
  assert.throws(() => vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
    process: state,
    require(name) {
      if (name === 'node:fs') return new Proxy(fs, { get(target, key) {
        if (['readFileSync', 'mkdirSync', 'mkdtempSync', 'writeFileSync'].includes(key)) return () => {
          sideEffects++; throw Error('Artifact validation must precede filesystem access');
        };
        return target[key];
      } });
      if (name === 'node:child_process') return { spawnSync() {
        sideEffects++; throw Error('Artifact validation must precede native execution');
      } };
      return entryRequire(name);
    },
  }), /Provide the immutable build artifact SHA-256/);
  assert.equal(sideEffects, 0);
});
