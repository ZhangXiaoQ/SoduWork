"use strict";
// Reuse only a completed isolated NSIS fixture. Simulate a notice changing AFTER
// extraction while keeping its original installer archive entry byte-for-byte valid.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { build, createFixtureGuid, fixtureNames, validateFixtureIdentity, prepareFixtureLauncher, Platform, Arch } = require('./fixtures/isolated-installer-build.cjs');
function run(file, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(Error('Isolated fixture timed out')); }, 180000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}
async function main() {
  const evidence = path.resolve(process.argv[2]);
  const data = JSON.parse(await fs.readFile(evidence, 'utf8'));
  const { root, id } = data;
  const previous = validateFixtureIdentity(data);
  const guid = createFixtureGuid();
  const { productName, executableName, shortcutName } = fixtureNames(guid);
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith('soduwork-update-e2e-'));
  assert.match(id, /^com\.soduwork\.update\.e2e\.\d+$/);
  const client = path.resolve(__dirname, '..');
  const prepackaged = path.join(root, 'notice-prepackaged');
  await fs.mkdir(prepackaged); // never overwrite a previous run or a production package
  await fs.cp(path.join(root, 'dist/win-unpacked'), prepackaged, { recursive: true });
  await fs.rename(path.join(prepackaged, previous.executableName + '.exe'), path.join(prepackaged, executableName + '.exe'));
  for (const name of ['resources/optional-agent/LICENSE.txt', 'resources/pi/node_modules/sdk/LICENSE',
    'resources/runner/_internal/sdk.dist-info/licenses/LICENSE.APACHE', 'resources/shell/share/licenses/sdk/COPYING3']) {
    await fs.mkdir(path.dirname(path.join(prepackaged, name)), { recursive: true });
    await fs.writeFile(path.join(prepackaged, name), 'Copyright upstream: permission granted.');
  }
  await require('../scripts/prepare-installer.cjs').inventory(prepackaged);
  const licenseName = await fs.access(path.join(prepackaged, 'LICENSE.electron.txt')).then(() => 'LICENSE.electron.txt', () => 'LICENSE');
  const license = await fs.readFile(path.join(prepackaged, licenseName));
  const realVerifier = await fs.readFile(path.join(client, 'build/verify-payload.cjs'));
  const manifestPath = path.join(prepackaged, '.soduwork-payload.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const wrapper = Buffer.from([
    "process.noAsar=true;",
    "const fs=require('fs'),path=require('path'),root=path.resolve(process.argv[2]);",
    "const manifest=JSON.parse(fs.readFileSync(path.join(root,'.soduwork-payload.json')));",
    "const policy=require('./.soduwork-realverify.cjs');",
    "for(const item of manifest.files)if(policy.isNoticePath(item.path))fs.appendFileSync(path.join(root,item.path),Buffer.alloc(4096,65));",
    "require('./.soduwork-realverify.cjs').run(root,process.argv[3],process.argv[4],process.argv[5])",
    ".then(code=>{process.exitCode=code}).catch(e=>{console.error(e);process.exitCode=2});",
  ].join('\n'));
  for (const [name, bytes] of [['.soduwork-realverify.cjs', realVerifier], ['.soduwork-verify.cjs', wrapper]]) {
    await fs.writeFile(path.join(prepackaged, name), bytes);
    manifest.files = manifest.files.filter(item => item.path !== name);
    manifest.files.push({ path: name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const base = JSON.parse(await fs.readFile(path.join(client, 'package.json'), 'utf8')).build;
  await prepareFixtureLauncher(client, { guid, productName, executableName, shortcutName });
  await require('../scripts/native-payload.cjs').writeNativePayload(prepackaged, path.join(client, '.runtime/installer'));
  const outputs = await build({
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), projectDir: client, prepackaged,
    config: {
      appId: id + '.notice', productName,
      directories: { app: path.join(root, 'fixture'), output: path.join(root, 'notice-dist'),
        buildResources: path.join(client, 'build') },
      afterPack: null, afterSign: null, extraResources: [],
      win: { target: ['nsis'], icon: path.join(client, 'icon.ico'), executableName, signAndEditExecutable: false },
      nsis: { ...base.nsis, guid, shortcutName, artifactName: productName + '-${version}-Setup.exe', include: path.join(client, 'build/installer.nsh'),
        installerIcon: path.join(client, 'icon.ico'), uninstallerIcon: path.join(client, 'icon.ico'),
        createDesktopShortcut: false, createStartMenuShortcut: false, runAfterFinish: false },
      compression: 'store', npmRebuild: false,
    },
  });
  const setup = outputs.find(file => file.endsWith('.exe'));
  assert.ok(setup);
  assert.deepEqual(await fs.readFile(path.join(prepackaged, licenseName)), license);
  const installed = path.join(root, 'notice-install');
  const code = await run(setup, ['/S', '/currentuser', '/D=' + installed]);
  assert.equal(code, 0, 'changed installed notice with a valid original entry must allow installation');
  const details = JSON.parse(await fs.readFile(path.join(installed, '.soduwork-update-details.json'), 'utf8'));
  assert.equal(details.ok, true);
  const noticeItems = manifest.files.filter(item => require('../build/verify-payload.cjs').isNoticePath(item.path));
  assert.equal(details.noticeDifferences.length, noticeItems.length);
  assert.ok(noticeItems.length >= 6);
  const difference = details.noticeDifferences.find(item => item.path === licenseName);
  assert.equal(difference.path, licenseName);
  assert.equal(difference.actualSize, license.length + 4096);
  assert.equal(difference.sourceSize, license.length);
  assert.equal(difference.sourceSha256, crypto.createHash('sha256').update(license).digest('hex'));
  assert.equal(difference.verification, 'verified-redistribution-bundle');
  const active = await fs.readFile(path.join(installed, '.soduwork-active'), 'utf8');
  const version = path.join(installed, '.soduwork-versions', active);
  assert.equal((await fs.readFile(path.join(version, licenseName))).length, license.length + 4096);
  const launchOutput = path.join(root, 'notice-launch.json');
  assert.equal(await run(path.join(installed, executableName + '.exe'), [], {
    SODUWORK_UPDATE_E2E_PROFILE: path.join(root, 'profile'), SODUWORK_UPDATE_E2E_OUTPUT: launchOutput,
  }), 0);
  const deadline = Date.now() + 30000;
  while (!(await fs.access(launchOutput).then(() => true, () => false))) {
    if (Date.now() >= deadline) throw Error('Installed fixture did not launch');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const launched = JSON.parse(await fs.readFile(launchOutput, 'utf8'));
  assert.equal(launched.exe, path.join(version, executableName + '.exe'));
  const result = { root, installed, setup, guid, productName, executableName, shortcutName, code, launched: true,
    simulation: '4096 bytes appended to every notice after extraction, before verification; not a live customer protection agent', details };
  await fs.writeFile(path.join(path.dirname(evidence), 'notice-compatibility.json'), JSON.stringify(result, null, 2));
  console.log('PASS: real NSIS installs and launches with all nested notices changed by 4096 bytes after extraction; canonical copies verified.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
