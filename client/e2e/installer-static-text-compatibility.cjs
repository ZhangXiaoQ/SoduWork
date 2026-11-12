'use strict';
// Follow a completed installer-update.cjs run. Reuse ONLY its isolated fixture/profile/appId.
// Build a valid NSIS container containing the bootstrap archive with changed content; installation must still finish.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { build, validateFixtureGuid, validateFixtureIdentity, prepareFixtureLauncher, Platform, Arch } = require('./fixtures/isolated-installer-build.cjs');
function run(file, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', resolve);
  });
}
async function main() {
  const evidence = path.resolve(process.argv[2]);
  const data = JSON.parse(await fs.readFile(evidence, 'utf8'));
  const { root, installed, id, mode } = data;
  const guid = validateFixtureGuid(data.guid);
  const { productName, executableName, shortcutName } = validateFixtureIdentity(data);
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith('soduwork-update-e2e-'));
  assert.equal(path.dirname(installed), root);
  assert.match(id, /^com\.soduwork\.update\.e2e\.\d+$/);
  assert.ok(['currentuser', 'allusers'].includes(mode));
  const client = path.resolve(__dirname, '..');
  const prepackaged = path.join(root, 'dist', 'win-unpacked');
  const license = path.join(prepackaged, 'resources/shell/etc/package-versions.txt');
  const original = await fs.readFile(license);
  const manifestPath = path.join(prepackaged, '.soduwork-payload.json');
  const originalManifest = await fs.readFile(manifestPath);
  const before = await fs.readFile(path.join(installed, '.soduwork-active'), 'utf8');
  const base = JSON.parse(await fs.readFile(path.join(client, 'package.json'), 'utf8')).build;
  let setup;
  if (process.argv.includes('--reuse')) setup = path.join(root, 'static-text-dist', productName + '-1.0.1-Setup.exe');
  else {
    await prepareFixtureLauncher(client, data);
    const staging = path.join(client, '.runtime/installer');
    await require('../scripts/native-payload.cjs').writeNativePayload(prepackaged, staging);
    await require('./fixtures/native-payload-fault.cjs').mutateStagedPayload(prepackaged, staging,
      'resources/shell/etc/package-versions.txt', bytes => Buffer.concat([Buffer.alloc(4096, 65), bytes]));
    const outputs = await build({
      targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), projectDir: client, prepackaged,
      config: {
        appId: id, productName,
        directories: { app: path.join(root, 'fixture'), output: path.join(root, 'static-text-dist'),
          buildResources: path.join(client, 'build') },
        afterPack: null, afterSign: null, extraResources: [],
        win: { target: ['nsis'], icon: path.join(client, 'icon.ico'), executableName, signAndEditExecutable: false },
        nsis: { ...base.nsis, guid, shortcutName, artifactName: productName + '-${version}-Setup.exe', include: path.join(client, 'build/installer.nsh'),
          installerIcon: path.join(client, 'icon.ico'), uninstallerIcon: path.join(client, 'icon.ico'),
          createDesktopShortcut: false, createStartMenuShortcut: false, runAfterFinish: false },
        compression: 'store', npmRebuild: false,
      },
    });
    setup = outputs.find(file => file.endsWith('.exe'));
    assert.ok(setup);
    assert.deepEqual(await fs.readFile(manifestPath), originalManifest, 'test must not regenerate the inventory');
  }
  const code = await run(setup, ['/S', '/' + mode, '--updated', '/D=' + installed]);
  assert.equal(code, 0, 'verified static text storage overhead must not block installation');
  const active = await fs.readFile(path.join(installed, '.soduwork-active'), 'utf8');
  assert.notEqual(active, before);
  const details = JSON.parse(await fs.readFile(path.join(installed, '.soduwork-update-details.json'), 'utf8'));
  assert.equal(details.ok, true);
  assert.equal(details.fullContentVerified, false);
  assert.equal(details.staticTextDifferences.length, 1);
  assert.equal(details.staticTextDifferences[0].path, 'resources/shell/etc/package-versions.txt');
  assert.equal(details.staticTextDifferences[0].filesystemSize, original.length + 4096);
  assert.match(await fs.readFile(path.join(installed, '.soduwork-update.log'), 'utf8'), /verification-policy=bootstrap-existence-only/);
  const launchOutput = path.join(root, 'launched-after-static-text-' + Date.now() + '.json');
  const launchCode = await run(path.join(installed, executableName + '.exe'), [], {
    SODUWORK_UPDATE_E2E_PROFILE: path.join(root, 'profile'), SODUWORK_UPDATE_E2E_OUTPUT: launchOutput,
  });
  assert.equal(launchCode, 0);
  const deadline = Date.now() + 30000;
  while (!(await fs.access(launchOutput).then(() => true, () => false))) {
    if (Date.now() >= deadline) throw Error('Installed fixture did not produce its launch receipt');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const launched = JSON.parse(await fs.readFile(launchOutput, 'utf8'));
  assert.equal(launched.exe, path.join(installed, '.soduwork-versions', active, executableName + '.exe'));
  assert.equal(await fs.readFile(path.join(root, 'profile', 'sentinel.txt'), 'utf8'), 'keep user data');
  const result = { root, installed, setup, code, staticTextOriginalVerified: true, newVersionActivated: true,
    installedFixtureLaunched: true, userDataPreserved: true, details };
  await fs.writeFile(path.join(path.dirname(evidence), 'static-text-installation.json'), JSON.stringify(result, null, 2));
  console.log('PASS: real NSIS installs known static text with +4096 storage bytes, verifies original source and launches Electron.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
