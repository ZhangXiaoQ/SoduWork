'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const contract = require('./release-artifacts.cjs');
const { run, soduworkBaseline } = require('./acceptance-common.cjs');
const { spawnSync } = require('node:child_process');
const support = require('./windows-acceptance-support.cjs');
function ps(script, extraEnv = {}) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';" + script],
    { env: { ...process.env, ...extraEnv }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout.trim();
}
async function cleanupRoot(root, prefix) {
  support.assertOwnedRoot(root);
  assert.ok(path.basename(root).startsWith(prefix));
  support.stopOwnedProcesses(root, ps);
  // Fixture registrations must be removed by their own scoped uninstaller.
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(root, entry.name);
    const active = await fs.access(path.join(directory, '.soduwork-active')).then(() => true, () => false);
    for (const name of support.pendingUninstallers(await fs.readdir(directory), active)) {
      const scope = prefix === 'soduwork-install-acceptance-' ? '/allusers' : '/currentuser';
      const file = path.join(directory, name);
      try {
        await run(file, ['/S', scope, '_?=' + directory],
          { argv0: '"' + file + '"', windowsVerbatimArguments: true, timeout: 120000 });
      } catch (error) {
        // Some isolated NSIS fixtures return exit code 2 while completing the
        // self-removal transaction. Wait for owned processes and the marker
        // before deciding whether the transaction completed. If the marker is
        // still present, retry once after the asynchronous helper has exited.
        if (!/ exited 2;/.test(String(error?.message))) throw error;
        support.waitForOwnedExit(root, ps, { timeout: 120000 });
        const marker = path.join(directory, '.soduwork-active');
        const markerGone = async (timeout = 120000) => {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            if (!await fs.access(marker).then(() => true, () => false)) return true;
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          return false;
        };
        if (!await markerGone(5000)) {
          try {
            await run(file, ['/S', scope, '_?=' + directory],
              { argv0: '"' + file + '"', windowsVerbatimArguments: true, timeout: 120000 });
          } catch (retryError) {
            if (!/ exited 2;/.test(String(retryError?.message))) throw retryError;
          }
          support.waitForOwnedExit(root, ps, { timeout: 120000 });
        }
        if (!await markerGone()) {
          // The isolated NSIS fixture can leave its marker while returning 2
          // from the self-delete helper. No owned process remains, and the
          // fixture root is removed immediately below; retain the original
          // failure for any process that is still alive.
          console.warn('Windows acceptance: uninstaller exited 2 after owned processes exited; removing isolated fixture root:', file);
        } else {
          console.warn('Windows acceptance: uninstaller exited 2 after completing asynchronous cleanup; verified marker removal:', file);
        }
      }
      support.waitForOwnedExit(root, ps, { timeout: 120000 });
      if (!await fs.access(path.join(directory, '.soduwork-active')).then(() => true, () => false)) break;
    }
  }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
async function main() {
  assert.equal(process.platform, 'win32');
  const record = await contract.verify('windows'), item = record.artifacts[0];
  const output = path.join(contract.root, 'release-evidence/windows');
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-accept-packages-'));
  const checks = [], roots = new Map();
  const installer = path.join(contract.dist, item.name);
  const env = { ...process.env, SODUWORK_ACCEPT_INSTALLER_SHA256: item.sha256 };
  let failure;
  try {
    const recent = await soduworkBaseline('windows-x64-exe', temp);
    for (const [name, old] of [['fresh-repair', null], ['soduwork-upgrade', recent]]) {
      console.log('Windows acceptance: starting ' + name);
      const destination = path.join(output, name);
      try {
        await run(process.execPath, [path.join(__dirname, 'windows-installed-check.cjs'), installer,
          destination, ...(old ? [old.path, old.version, old.productName] : [])], { env: { ...env,
            ...(old ? { SODUWORK_ACCEPT_BASELINE_SHA256: old.sha256 } : {}) }, timeout: 20 * 60 * 1000, log: path.join(output, name + '.log') });
        const report = await contract.read(path.join(destination, 'windows-install-report.json'));
        assert.equal(report.ok, true); assert.equal(report.sha256, item.sha256);
        assert.equal(report.version, record.version);
        if (old) {
          assert.equal(report.oldVersion, old.version);
          assert.equal(report.oldBrand, old.productName);
          assert.equal(report.oldSha256, old.sha256);
        }
        checks.push({ name, ok: true, oldVersion: old ? old.version : record.version,
          ...(old ? { oldBrand: old.productName, oldSha256: old.sha256 } : {}) });
        console.log('Windows acceptance: passed ' + name);
      } finally {
        const report = await contract.read(path.join(destination, 'windows-install-report.json')).catch(() => null);
        if (report?.root) roots.set(report.root, 'soduwork-install-acceptance-');
      }
    }
    try {
      console.log('Windows acceptance: starting compatibility checks');
      await run(process.execPath, [path.join(contract.root, 'client/scripts/installer-compatibility-gate.cjs'),
        installer, path.join(output, 'compatibility.json')], { env, timeout: 60 * 60 * 1000, log: path.join(output, 'compatibility.log') });
      checks.push({ name: 'compatibility', ok: true });
      console.log('Windows acceptance: passed compatibility checks');
    } finally {
      for (const name of await fs.readdir(output)) if (name.startsWith('installer-compatibility-')) {
        const report = await contract.read(path.join(output, name, 'transaction/report.json')).catch(() => null);
        if (report?.root) roots.set(report.root, 'soduwork-update-e2e-');
      }
    }
  } catch (error) { failure = error; throw error; }
  finally {
    const cleanupErrors = [];
    for (const [root, prefix] of roots) {
      try { await cleanupRoot(root, prefix); } catch (error) { cleanupErrors.push(error); }
    }
    try { await fs.rm(temp, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) {
      const error = new AggregateError(cleanupErrors, 'Windows acceptance cleanup failed');
      if (failure) console.error(error); // Retain the original acceptance failure.
      else throw error;
    }
  }
  await contract.acceptance('windows', checks, ['Windows Runner SYSTEM/session 0; no interactive UAC or customer filesystem filter certification.']);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
