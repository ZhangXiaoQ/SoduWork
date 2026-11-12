'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { notarizeApp, notarizeEnabled } = require('../scripts/notarize-macos.cjs');

test('Developer ID builds enable notarization unless explicitly skipped', () => {
  const identity = { SODUWORK_MAC_SIGN_IDENTITY: 'Developer ID Application: SoduWork (TEAM123)' };
  assert.equal(notarizeEnabled(identity), true);
  assert.equal(notarizeEnabled({ ...identity, SODUWORK_MAC_SKIP_NOTARIZE: 'yes' }), false);
  assert.equal(notarizeEnabled({}), false);
});

test('notarization submits a zipped app and staples the original bundle', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-notary-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appPath = path.join(root, 'SoduWork.app');
  await fs.mkdir(appPath);
  const calls = [];
  await notarizeApp({
    appPath,
    env: {
      SODUWORK_MAC_SIGN_IDENTITY: 'Developer ID Application: SoduWork (TEAM123)',
      SODUWORK_MAC_NOTARY_PROFILE: 'fixture-profile',
      SODUWORK_MAC_NOTARY_KEYCHAIN: '/tmp/fixture.keychain-db',
    },
    run: (file, args) => calls.push([file, ...args]),
  });
  assert.deepEqual(calls, [
    ['ditto', '-c', '-k', '--keepParent', appPath, appPath + '.notarize.zip'],
    ['xcrun', 'notarytool', 'submit', appPath + '.notarize.zip', '--keychain-profile', 'fixture-profile',
      '--keychain', '/tmp/fixture.keychain-db', '--wait'],
    ['xcrun', 'stapler', 'staple', appPath],
  ]);
  assert.equal(await fs.stat(appPath).then(() => true), true);
});

test('installer afterSign forwards bounded and captured keychain command options', async () => {
  const vm = require('node:vm');
  const source = await fs.readFile(path.join(__dirname, '../scripts/prepare-installer.cjs'), 'utf8');
  const calls = [];
  const module = { exports: {} };
  const capture = { timeout: 30000, stdio: 'pipe', encoding: 'utf8' };
  let notaryCalls = 0;
  vm.runInNewContext(source, {
    module,
    __dirname: path.join(__dirname, '../scripts'),
    process: { env: {} },
    require(name) {
      if (name === 'node:child_process') return {
        execFileSync: (...args) => calls.push(args),
      };
      if (name === 'app-builder-lib/out/toolsets/windows') return {};
      if (name === './verify-runtime.cjs') return { verify() {}, verifyExecutables() {} };
      if (name === './notarize-macos.cjs') return {
        notarizeEnabled: () => true,
        async notarizeApp({ run }) {
          notaryCalls++;
          run('security', ['unlock-keychain', 'synthetic.keychain-db'], capture);
          run('xcrun', ['stapler', 'staple', 'SoduWork.app']);
        },
      };
      return require(name);
    },
  });
  const context = {
    electronPlatformName: 'darwin', appOutDir: path.join(os.tmpdir(), 'soduwork-notary-hook'),
    packager: { appInfo: { productFilename: 'SoduWork' } }, arch: 'arm64',
  };
  await module.exports(context);
  assert.equal(notaryCalls, 0, 'afterPack must not notarize unsigned bytes');
  await module.exports(context);
  assert.equal(notaryCalls, 1);
  assert.equal(calls[0][0], 'security');
  assert.deepEqual({ ...calls[0][2] }, capture);
  assert.deepEqual({ ...calls[1][2] }, { stdio: 'inherit' });
});
