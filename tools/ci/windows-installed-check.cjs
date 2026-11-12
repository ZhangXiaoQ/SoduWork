'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const support = require('./windows-acceptance-support.cjs');
const { candidateVersion, displayVersions } = require('../../client/scripts/client-build-version.cjs');
const productName = 'SoduWork', executableName = 'SoduWork.exe';
const nsisGuid = require('../../client/package.json').build.nsis.guid;
const [installer, output, oldInstaller, oldVersion, oldBrand = productName] = process.argv.slice(2);
assert.equal(oldBrand, productName, 'Upgrade baseline belongs to another distribution');
const oldExecutableName = executableName;
assert.equal(process.platform, 'win32');
assert.ok(path.isAbsolute(installer) && path.isAbsolute(output));
const expectedHash = process.env.SODUWORK_ACCEPT_INSTALLER_SHA256;
assert.match(expectedHash || '', /^[a-f0-9]{64}$/, 'Provide the immutable build artifact SHA-256');
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex'), expectedHash);
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-install-acceptance-'));
const installed = path.join(root, productName + ' acceptance');
const profile = path.join(root, 'soduwork-acceptance-profile-main');
const report = { ok: false, root, installed, version: candidateVersion(process.env), sha256: expectedHash, oldVersion: '', checks: [],
  limitations: ['Runs in Windows Runner SYSTEM session 0; no interactive user/UAC assertion.', 'Same-version repair is not an old-version upgrade.'] };
// NSIS writes the registry DisplayVersion without the semver prerelease suffix
// (1.13.11-beta.1 → 1.13.11 or the numeric 1.13.11.1 form); accept either.
const displayVersion = expected => displayVersions(expected);
if (oldInstaller) {
  const baselineHash = process.env.SODUWORK_ACCEPT_BASELINE_SHA256;
  assert.match(baselineHash || '', /^[a-f0-9]{64}$/);
  assert.match(oldVersion, /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/);
  assert.notEqual(oldVersion, report.version);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(oldInstaller)).digest('hex'), baselineHash);
  report.oldVersion = oldVersion;
  report.oldBrand = oldBrand;
  report.oldSha256 = baselineHash;
  report.limitations.pop();
}
const oldUninstaller = path.join(root, 'legacy-uninstall.exe');
const scope = '/allusers';
report.installScope = 'allusers';
const env = { ...process.env, SODUWORK_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
function run(file, args, options = {}) {
  // Verbatim mode also disables quoting argv[0]. NSIS must still see a quoted
  // executable path, while /D= and _?= remain the final unquoted tail.
  if (options.windowsVerbatimArguments) options = { ...options, argv0: '"' + file + '"' };
  const result = spawnSync(file, args, { env, encoding: 'utf8', windowsHide: true, timeout: 600000, ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, result.error?.message || `${file} exit ${result.status}`);
  return result.stdout;
}
function ps(script, extraEnv = {}) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';" + script],
    { env: { ...env, ...extraEnv }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function registrations() {
  // electron-builder stores InstallLocation under Software\\<app GUID>, not
  // in the Windows Uninstall entry. Read both keys in the same hive/view.
  return JSON.parse(ps(`
    $rows=@()
    foreach($h in @('HKCU','HKLM')) {
      foreach($view in @('', 'WOW6432Node\\')) {
        $software=$h+':\\Software\\'+$view
        $p=$software+'Microsoft\\Windows\\CurrentVersion\\Uninstall'
        if(Test-Path -LiteralPath $p) {
          Get-ChildItem -LiteralPath $p | ForEach-Object {
            $v=Get-ItemProperty -LiteralPath $_.PSPath
            if($v.DisplayName -match 'SoduWork') {
              $info=Get-ItemProperty -LiteralPath ($software+$_.PSChildName) -ErrorAction SilentlyContinue
              $rows+=@{hive=$h;view=$view;key=$_.PSChildName;name=$v.DisplayName;version=$v.DisplayVersion;location=$info.InstallLocation;uninstall=$v.UninstallString}
            }
          }
        }
      }
    }
    ConvertTo-Json -InputObject $rows -Compress
  `));
}
function payload() {
  const pointer = fs.readFileSync(path.join(installed, '.soduwork-active'), 'utf8');
  assert.ok(pointer && !/[\\/]/.test(pointer));
  const directory = path.join(installed, '.soduwork-versions', pointer);
  assert.equal(JSON.parse(fs.readFileSync(path.join(installed, '.soduwork-update-details.json'))).ok, true);
  assert.equal(fs.readFileSync(path.join(installed, '.soduwork-install-mode'), 'utf8'), 'all');
  return directory;
}
function smoke(label, mode, version = report.version, entryName = 'SoduWork.exe') {
  run(process.execPath, [path.join(__dirname, 'installed-client-smoke.cjs'), path.join(installed, entryName),
    installed, profile, path.join(output, label + '.json'), version, mode]);
  report.checks.push({ name: label, ok: true });
}
function uninstall(cleanupLegacy = false) {
  if (!fs.existsSync(path.join(installed, '.soduwork-active'))) return;
  if (cleanupLegacy) support.stopOwnedProcesses(root, ps);
  // Installation schedules a short-lived maintenance process. Wait only for
  // processes from this fixture before testing the real uninstall guard.
  report.uninstallWait = support.waitForOwnedExit(root, ps);
  const files = support.pendingUninstallers(fs.readdirSync(installed), true);
  assert.equal(files.length, 1, 'Expected current root uninstaller');
  // _?= prevents the uninstaller's asynchronous self-copy, so the exit is observable.
  // NSIS parses _?= before normal argv handling; its path must be the final,
  // unquoted command-line tail, even when it contains spaces.
  run(path.join(installed, files[0]), ['/S', scope, '_?=' + installed], { windowsVerbatimArguments: true });
  // The accepted upgrade must uninstall with the NEW uninstaller alone.
  // A saved old uninstaller is only a recovery tool after a failed assertion.
  if (cleanupLegacy && fs.existsSync(oldUninstaller) && fs.existsSync(path.join(installed, '.soduwork-active')))
    run(oldUninstaller, ['/S', scope, '_?=' + installed], { windowsVerbatimArguments: true });
  const deadline = Date.now() + 30000;
  while (fs.existsSync(path.join(installed, 'SoduWork.exe')) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}
let started = false;
// Parent CI cleanup can recover the owned root even if the job is interrupted.
fs.writeFileSync(path.join(output, 'windows-install-report.json'), JSON.stringify(report, null, 2) + '\n');
try {
  // A previous acceptance run can leave its temporary installation behind
  // (interrupted job, rebooted runner); uninstall fixture leftovers before the
  // fresh install. Genuine user installations are still rejected.
  const leftovers = registrations().filter(row =>
    typeof row.location === 'string' && /soduwork-(?:install-acceptance|update-e2e)-/i.test(row.location) &&
    typeof row.uninstall === 'string' && row.uninstall.trim());
  for (const row of leftovers) {
    // The leftover's uninstaller may itself be broken (Windows temp cleanup
    // removes its target files), so remove the registry entry directly.
    console.log('Removing leftover acceptance installation registry entry: ' + row.name + ' @ ' + row.location);
    const keyPath = row.hive + ':\\Software\\' + row.view + 'Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + row.key;
    ps(`if (Test-Path -LiteralPath '${keyPath}') { Remove-Item -LiteralPath '${keyPath}' -Recurse -Force }`);
  }
  // Interrupted runs also leave acceptance processes alive from the temp root;
  // kill only executables under a soduwork-install-acceptance directory, never by
  // product name.
  const killScript = "$rows=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and " +
    "$_.ExecutablePath -like '*soduwork-install-acceptance-*'});" +
    "foreach($row in $rows){$live=Get-CimInstance Win32_Process -Filter ('ProcessId='+$row.ProcessId);" +
    "if($live -and $live.CreationDate -eq $row.CreationDate -and $live.ExecutablePath -eq $row.ExecutablePath){" +
    "& taskkill.exe /PID $row.ProcessId /T /F | Out-Null}}";
  ps(killScript);
  const deadlineProcesses = Date.now() + 30000;
  while (support.processes(root, ps).length && Date.now() < deadlineProcesses) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  assert.deepEqual(registrations(), [], 'An existing SoduWork installation must not be replaced');
  report.processesBefore = support.processes(root, ps);
  assert.deepEqual(report.processesBefore, [], 'Existing product processes block acceptance; they will not be stopped');
  const verb = 'SoduWork.Open';
  // Interrupted acceptance runs leave the NSIS shell verb and the Applications
  // class behind after the temp root is gone. Clean only entries whose command
  // target is gone or lives in the acceptance root; genuine installations
  // keep blocking the run.
  const orphaned = command => {
    const target = String(command || '').trim();
    if (!target) return false;
    if (/soduwork-install-acceptance/i.test(target)) return true;
    const executable = target.replace(/^"|"$/g, '').split(' /')[0].trim();
    return executable.length > 0 && !fs.existsSync(executable);
  };
  for (const key of ['HKLM:\\Software\\Classes\\*\\shell\\' + verb,
    'HKLM:\\Software\\Classes\\Applications\\' + executableName]) {
    const command = ps(`$k='${key}\\command'; if (Test-Path -LiteralPath $k) { (Get-ItemProperty -LiteralPath $k).'(default)' }`);
    if (orphaned(command)) {
      (report.removedOrphanedKeys ??= []).push(key);
      ps(`if (Test-Path -LiteralPath '${key}') { Remove-Item -LiteralPath '${key}' -Recurse -Force }`);
    }
  }
  const linkName = (oldInstaller ? oldBrand : productName) + '.lnk';
  const links = JSON.parse(ps("ConvertTo-Json -InputObject @((Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) $env:SODUWORK_CHECK_LINK_NAME),(Join-Path ([Environment]::GetFolderPath('CommonPrograms')) $env:SODUWORK_CHECK_LINK_NAME)) -Compress", { SODUWORK_CHECK_LINK_NAME: linkName }));
  for (const link of links) for (const name of new Set(['SoduWork.lnk', 'SoduWork.lnk', 'SoduWork.lnk', productName + '.lnk'])) {
    const stale = path.join(path.dirname(link), name);
    if (!fs.existsSync(stale)) continue;
    const target = ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${stale.replace(/'/g, "''")}'); $s.TargetPath`);
    if (orphaned(target)) {
      (report.removedOrphanedLinks ??= []).push(stale);
      fs.rmSync(stale, { force: true });
    }
  }
  started = true;
  // NSIS requires /D= to be the final unquoted command-line tail, even when
  // the isolated installation directory contains spaces.
  run(oldInstaller || installer, ['/S', scope, '/D=' + installed], { windowsVerbatimArguments: true });
  const first = payload();
  const rows = registrations();
  report.initialRegistration = rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].hive, 'HKLM');
  assert.ok(displayVersion(report.oldVersion || report.version).includes(rows[0].version),
    'Registry DisplayVersion ' + rows[0].version + ' differs from candidate ' + (report.oldVersion || report.version));
  assert.ok(rows[0].name.startsWith(oldInstaller ? oldBrand : productName));
  if (!oldInstaller) assert.equal(rows[0].key.toLowerCase().replace(/[{}]/g, ''), nsisGuid.toLowerCase());
  assert.equal(typeof rows[0].location, 'string', 'Installation GUID key must contain InstallLocation');
  assert.equal(path.resolve(rows[0].location).toLowerCase(), path.resolve(installed).toLowerCase());
  for (const link of links) {
    assert.ok(fs.existsSync(link), 'Installer did not create shortcut: ' + link);
    const target = ps('(New-Object -ComObject WScript.Shell).CreateShortcut($env:SODUWORK_CHECK_LINK).TargetPath', { SODUWORK_CHECK_LINK: link });
    assert.equal(target.toLowerCase(), path.join(installed, oldInstaller ? oldExecutableName : executableName).toLowerCase());
  }
  run(path.join(first, oldInstaller ? oldExecutableName : executableName), [path.join(first, '.soduwork-verify.cjs'), first, path.join(output, 'payload-verification.json')],
    { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } });
  report.checks.push({ name: 'fresh install, full payload, HKLM registration and stable shortcuts', ok: true });
  smoke('fresh-launch', 'write', report.oldVersion || report.version, oldInstaller ? oldBrand + '.exe' : 'SoduWork.exe');
  if (oldInstaller) fs.copyFileSync(path.join(installed, 'Uninstall ' + oldBrand + '.exe'), oldUninstaller);
  run(installer, ['/S', scope, '--updated', '/D=' + installed], { windowsVerbatimArguments: true });
  assert.notEqual(payload(), first);
  smoke(oldInstaller ? 'upgraded-new-entry-launch' : 'same-version-repair-launch', 'read');
  if (oldInstaller) {
    report.upgradedRegistrations = registrations();
    smoke('upgraded-existing-shortcut-launch', 'read', report.version, oldBrand + '.exe');
    assert.equal(report.upgradedRegistrations.length, 1, 'Upgrade must retire its legacy registration');
    assert.ok(displayVersion(report.version).includes(report.upgradedRegistrations[0].version),
      'Upgraded DisplayVersion differs from candidate ' + report.version);
    assert.ok(report.upgradedRegistrations[0].name.startsWith(productName));
    assert.equal(report.upgradedRegistrations[0].key.toLowerCase().replace(/[{}]/g, ''), nsisGuid.toLowerCase());
    assert.equal(typeof report.upgradedRegistrations[0].location, 'string', 'Upgraded installation GUID key must contain InstallLocation');
    assert.equal(path.resolve(report.upgradedRegistrations[0].location).toLowerCase(), path.resolve(installed).toLowerCase());
    assert.equal(fs.existsSync(path.join(installed, 'Uninstall SoduWork.exe')), true);
  }
  uninstall();
  assert.equal(fs.existsSync(path.join(installed, 'SoduWork.exe')), false);
  assert.deepEqual(registrations(), []);
  for (const link of links) {
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.existsSync(path.join(path.dirname(link), 'SoduWork.lnk')), false);
  }
  assert.equal(fs.readFileSync(path.join(profile, 'acceptance-sentinel.txt'), 'utf8'), 'preserve-install-acceptance-data');
  report.checks.push({ name: 'uninstall removes application, registration and shortcuts; retains profile', ok: true });
  report.ok = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  if (started && !report.ok) {
    try { uninstall(true); } catch (error) {
      report.cleanupError = error.message;
      try { report.remainingProcesses = support.processes(root, ps); } catch (_) { /* Preserve the original failure. */ }
    }
  }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'windows-install-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
