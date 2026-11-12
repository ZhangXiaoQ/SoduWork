'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../scripts/build-macos.cjs');
const { notarizeArtifact, notarizeApp } = require('../scripts/notarize-macos.cjs');
const isEntry = (args, suffix) => String(args[0] || '').replaceAll('\\', '/').endsWith(suffix);
function fixture(options = {}) {
  const calls = [], env = { SODUWORK_MACOS_ARM64_PYTHON: '/python/arm64', SODUWORK_MACOS_X64_PYTHON: '/python/x64' };
  let current;
  return { calls, config: { root: '/fixture', platform: 'darwin', hostArch: 'arm64', env,
    prepare({ python }) { current = python; calls.push(['prepare', python]); return '/fixture/runner'; },
    run(file, args) {
      if (file === '/usr/bin/arch') return '/Apple Tools/bin/' + args.at(-1);
      if (args[0] === '-c') return file.endsWith('x64') ? (options.wrongPython || 'x86_64') : 'arm64';
      if (file === 'lipo') return options.wrongRunner || (current.endsWith('x64') ? 'x86_64' : 'arm64');
      calls.push([file, ...args]); return '';
    } } };
}
test('macOS packages compile, verify and package each matching Runner in order', () => {
  const { calls, config } = fixture(); build(config);
  assert.deepEqual(calls.filter(row => row[0] === 'prepare'), [['prepare', '/python/arm64'], ['prepare', '/python/x64']]);
  assert.match(calls[1][1], /verify-runner-skills\.py$/);
  assert.ok(calls[2].includes('--arm64'));
  assert.match(calls[4][1], /verify-runner-skills\.py$/);
  assert.ok(calls[5].includes('--x64'));
  assert.ok(calls[2].includes('--config.mac.identity=-'));
  assert.deepEqual(calls[2].slice(-3, -1), ['--publish', 'never']);
});
test('Intel Mac builds only x64 and never probes or prepares ARM Python', () => {
  const f = fixture();
  f.config.hostArch = 'x64'; f.config.env.SODUWORK_MACOS_ARCH = 'x64';
  delete f.config.env.SODUWORK_MACOS_ARM64_PYTHON;
  const run = f.config.run;
  f.config.run = (file, args, options) => {
    if (file === '/usr/bin/arch') assert.equal(args[0], '-x86_64');
    assert.notEqual(file, '/python/arm64');
    return run(file, args, options);
  };
  build(f.config);
  assert.deepEqual(f.calls.filter(row => row[0] === 'prepare'), [['prepare', '/python/x64']]);
  assert.ok(f.calls.at(-1).includes('--x64'));
});
test('ARM shard builds only ARM; invalid selections fail before tool lookup', () => {
  const f = fixture(); f.config.env.SODUWORK_MACOS_ARCH = 'arm64';
  delete f.config.env.SODUWORK_MACOS_X64_PYTHON;
  build(f.config);
  assert.deepEqual(f.calls.filter(row => row[0] === 'prepare'), [['prepare', '/python/arm64']]);
  for (const arch of ['', '../x64', 'arm64,x64']) {
    const invalid = fixture(); invalid.config.env.SODUWORK_MACOS_ARCH = arch;
    invalid.config.run = () => assert.fail('must not look up tools');
    assert.throws(() => build(invalid.config), /Invalid SODUWORK_MACOS_ARCH/);
  }
  const intel = fixture(); intel.config.hostArch = 'x64';
  assert.throws(() => build(intel.config), /Intel Mac cannot execute ARM/);
});
test('toolchain failure in either Python stops packaging before either Runner is compiled', () => {
  const f = fixture(); const run = f.config.run;
  let directory;
  f.config.run = (file, args, options) => {
    if (file === '/python/x64') {
      // The fixture supplies no PATH; preserve Windows drive colons when examining its temporary directory.
      directory = options.env.PATH;
      assert.deepEqual(fs.readdirSync(directory).sort(), ['install_name_tool', 'lipo']);
      throw Error('lipo subprocess failed');
    }
    return run(file, args, options);
  };
  assert.throws(() => build(f.config), /lipo subprocess failed/);
  assert.equal(f.calls.length, 0);
  assert.ok(directory && !fs.existsSync(directory), 'failed builds clean up temporary tool links');
});
test('all packaging children inherit the resolved toolchain without changing the caller environment', () => {
  const f = fixture(); const run = f.config.run; const prepare = f.config.prepare;
  f.config.env.PATH = '/custom/bin:/usr/bin';
  let expected, directory;
  f.config.run = (file, args, options) => {
    if (file !== '/usr/bin/arch') {
      expected ??= options.env.PATH;
      assert.equal(options.env.PATH, expected);
      assert.ok(expected.endsWith(':/custom/bin:/usr/bin'));
      // Interpret the tested macOS PATH contract using known suffixes while preserving host Windows drive letters.
      directory ??= expected.slice(0, -(':' + f.config.env.PATH).length);
      assert.ok(path.isAbsolute(directory));
      assert.deepEqual(fs.readdirSync(directory).sort(), ['install_name_tool', 'lipo']);
      assert.equal(fs.readlinkSync(path.join(directory, 'lipo')), path.resolve('/Apple Tools/bin/lipo'));
    }
    return run(file, args, options);
  };
  f.config.prepare = options => { assert.equal(options.env.PATH, expected); return prepare(options); };
  build(f.config);
  assert.equal(f.config.env.PATH, '/custom/bin:/usr/bin');
  assert.ok(!fs.existsSync(directory), 'successful builds clean up temporary tool links');
});
test('wrong target Python prevents all packaging; wrong Runner prevents its package', () => {
  let f = fixture({ wrongPython: 'arm64' });
  assert.throws(() => build(f.config), /Python architecture differs/); assert.equal(f.calls.length, 0);
  f = fixture({ wrongRunner: 'x86_64' });
  assert.throws(() => build(f.config), /Runner architecture differs/); assert.equal(f.calls.length, 1);
});

test('private distributions and unverified build checkpoints fail before tool lookup', () => {
  for (const options of [{distributions: ['stage', 'internal', 'cn', 'global']},
    {preparedRunner: '/original/soduwork-runner'}, {env: {SODUWORK_DISTRIBUTION: 'stage'}},
    {env: {SODUWORK_MAC_NOTARY_STATE_DIR: '/private/checkpoints'}},
    {env: {SODUWORK_MAC_BUILD_INPUT_ID: 'a'.repeat(64)}}]) {
    const f = fixture(); Object.assign(f.config, options);
    f.config.run = () => assert.fail('unsupported options must fail before tool lookup');
    assert.throws(() => build(f.config), /self-hosted distribution|Private build checkpoints/);
    assert.deepEqual(f.calls, []);
  }
});

test('explicit self-hosted packaging preserves the verified Runner path', () => {
  const f = fixture(); f.config.env.SODUWORK_MACOS_ARCH = 'x64';
  f.config.distributions = ['self-hosted'];
  build(f.config);
  assert.equal(f.calls.filter(row => row[0] === 'prepare').length, 1);
  assert.equal(f.calls.filter(row => isEntry(row.slice(1), 'electron-builder/cli.js')).length, 1);
});

const IDENTITY = 'Developer ID Application: Test (TEAMID)';
function signingFixture() {
  const f = fixture();
  f.config.env.SODUWORK_MAC_SIGN_IDENTITY = IDENTITY;
  f.config.env.HOME = '/Users/test';
  f.config.env.SODUWORK_MACOS_ARCH = 'arm64';
  delete f.config.env.SODUWORK_MACOS_X64_PYTHON;
  f.config.root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'soduwork-signing-'));
  fs.mkdirSync(path.join(f.config.root, 'client/dist'), { recursive: true });
  fs.writeFileSync(path.join(f.config.root, 'client/package.json'), JSON.stringify({ version: '9.9.9' }));
  fs.writeFileSync(path.join(f.config.root, 'client/dist/SoduWork-9.9.9-mac-arm64.dmg'), 'dmg');
  const run = f.config.run;
  f.config.run = (file, args, options) => {
    if (file === 'security') {
      f.calls.push([file, ...args]);
      return ' 1) ABCDEF1234 "' + IDENTITY + '"\n 1 valid identity found';
    }
    if (file === 'xcrun') { f.calls.push(['xcrun', ...args]); return ''; }
    return run(file, args, options);
  };
  return f;
}
test('Developer ID signing forwards the identity, hardened runtime and notarization hooks', () => {
  const f = signingFixture();
  build(f.config);
  const identityCheck = f.calls.find(row => row[0] === 'security');
  assert.deepEqual(identityCheck.slice(1), ['find-identity', '-v', '-p', 'codesigning',
    path.join(f.config.env.HOME, 'Library/Keychains/login.keychain-db')]);
  const builder = f.calls.find(row => isEntry(row.slice(1), 'electron-builder/cli.js'));
  assert.ok(builder, 'electron-builder must run once');
  assert.ok(builder.includes('--config.mac.identity=' + IDENTITY));
  assert.ok(builder.includes('--config.mac.hardenedRuntime=true'));
  assert.ok(builder.includes('--config.afterSign=scripts/notarize-macos.cjs'));
  assert.ok(builder.includes('--config.mac.identity=-') === false);
  const submit = f.calls.find(row => row[0] === 'xcrun' && row[1] === 'notarytool');
  assert.deepEqual(submit.slice(1), ['notarytool', 'submit',
    path.join(f.config.root, 'client/dist/SoduWork-9.9.9-mac-arm64.dmg'), '--keychain-profile', 'SODUWORK_NOTARY', '--wait']);
  assert.deepEqual(f.calls.find(row => row[0] === 'xcrun' && row[1] === 'stapler').slice(1),
    ['stapler', 'staple', path.join(f.config.root, 'client/dist/SoduWork-9.9.9-mac-arm64.dmg')]);
  fs.rmSync(f.config.root, { recursive: true, force: true });
});
test('SODUWORK_MAC_SKIP_NOTARIZE keeps a signed but unnotarized build', () => {
  const f = signingFixture();
  f.config.env.SODUWORK_MAC_SKIP_NOTARIZE = '1';
  build(f.config);
  assert.ok(f.calls.some(row => isEntry(row.slice(1), 'electron-builder/cli.js')));
  assert.deepEqual(f.calls.filter(row => row[0] === 'xcrun'), []);
  const builder = f.calls.find(row => isEntry(row.slice(1), 'electron-builder/cli.js'));
  assert.ok(builder.includes('--config.afterSign=scripts/notarize-macos.cjs') === false);
  fs.rmSync(f.config.root, { recursive: true, force: true });
});
test('private notarization checkpoint options fail before keychain access or submission', () => {
  for (const key of ['SODUWORK_MAC_NOTARY_STATE_DIR', 'SODUWORK_MAC_BUILD_INPUT_ID']) {
    const env = {[key]: 'private-checkpoint', SODUWORK_MAC_KEYCHAIN_PASSWORD: 'fixture-only-password'};
    const run = () => assert.fail('unsupported checkpoints must not touch native tools');
    assert.throws(() => notarizeArtifact({artifactPath: '/tmp/SoduWork.dmg', env, run}), /Private notarization checkpoints/);
    assert.throws(() => notarizeApp({appPath: '/tmp/SoduWork.app', env, run}), /Private notarization checkpoints/);
  }
});

test('SODUWORK_MAC_SKIP_NOTARIZE=0 keeps notarization enabled', () => {
  const f = signingFixture();
  f.config.env.SODUWORK_MAC_SKIP_NOTARIZE = '0';
  build(f.config);
  assert.ok(f.calls.some(row => row[0] === 'xcrun' && row[1] === 'notarytool'));
  const builder = f.calls.find(row => isEntry(row.slice(1), 'electron-builder/cli.js'));
  assert.ok(builder.includes('--config.afterSign=scripts/notarize-macos.cjs'));
  fs.rmSync(f.config.root, { recursive: true, force: true });
});
test('notarization can use a separate keychain profile', () => {
  const calls = [];
  notarizeArtifact({
    artifactPath: '/tmp/SoduWork.app.zip',
    env: { SODUWORK_MAC_NOTARY_KEYCHAIN: '/Users/test/Library/Keychains/keychain-2.db' },
    run: (file, args) => calls.push([file, ...args]),
  });
  assert.deepEqual(calls, [
    ['xcrun', 'notarytool', 'submit', '/tmp/SoduWork.app.zip', '--keychain-profile', 'SODUWORK_NOTARY', '--keychain', '/Users/test/Library/Keychains/keychain-2.db', '--wait'],
    ['xcrun', 'stapler', 'staple', '/tmp/SoduWork.app.zip'],
  ]);
});
test('notarization can resolve an iCloud keychain profile through the search list', () => {
  const calls = [];
  notarizeArtifact({
    artifactPath: '/tmp/SoduWork.app.zip',
    env: {
      SODUWORK_MAC_NOTARY_KEYCHAIN: '/Users/test/Library/Keychains/keychain-2.db',
      SODUWORK_MAC_NOTARY_KEYCHAIN_SEARCH: '1',
    },
    run: (file, args) => calls.push([file, ...args]),
  });
  assert.deepEqual(calls[0], [
    'xcrun', 'notarytool', 'submit', '/tmp/SoduWork.app.zip', '--keychain-profile', 'SODUWORK_NOTARY', '--wait',
  ]);
});
test('app notarization staples the app after submitting its zip', () => {
  const calls = [];
  notarizeApp({
    appPath: '/tmp/SoduWork.app',
    env: { SODUWORK_MAC_NOTARY_KEYCHAIN_SEARCH: '1' },
    run: (file, args) => calls.push([file, ...args]),
  });
  assert.deepEqual(calls, [
    ['ditto', '-c', '-k', '--keepParent', '/tmp/SoduWork.app', '/tmp/SoduWork.app.notarize.zip'],
    ['xcrun', 'notarytool', 'submit', '/tmp/SoduWork.app.notarize.zip', '--keychain-profile', 'SODUWORK_NOTARY', '--wait'],
    ['xcrun', 'stapler', 'staple', '/tmp/SoduWork.app'],
  ]);
});
test('app and DMG notarization refresh keychain access immediately before each submission', () => {
  const calls = [];
  const env = { HOME: '/Users/test', SODUWORK_MAC_KEYCHAIN_PASSWORD: 'fixture-only-password',
    SODUWORK_MAC_KEYCHAIN: '/Users/test/Library/Keychains/login.keychain-db',
    SODUWORK_MAC_NOTARY_KEYCHAIN: '/Users/test/Library/Keychains/keychain-2.db',
    SODUWORK_MAC_NOTARY_KEYCHAIN_SEARCH: '1' };
  let unlocked = false;
  const run = (file, args, options) => {
    calls.push([file, ...args]);
    if (file === 'security') {
      assert.deepEqual(args, ['unlock-keychain', '-p', env.SODUWORK_MAC_KEYCHAIN_PASSWORD,
        '/Users/test/Library/Keychains/login.keychain-db']);
      assert.equal(options.stdio, 'pipe');
      assert.equal(options.timeout, 30000);
      unlocked = true;
    }
    if (file === 'xcrun' && args[0] === 'notarytool') {
      assert.ok(unlocked, 'submission requires fresh access after a long signing/compression step');
      assert.equal(args.includes('--keychain'), false, 'iCloud profile still uses the search list');
      unlocked = false;
    }
  };
  notarizeApp({ appPath: '/tmp/SoduWork.app', env, run });
  notarizeArtifact({ artifactPath: '/tmp/SoduWork.dmg', env, run });
  assert.equal(calls.filter(row => row[0] === 'security').length, 2);
  assert.equal(calls.filter(row => row[0] === 'xcrun' && row[1] === 'stapler').length, 2);
  assert.equal(calls[0][0], 'ditto', 'unlock occurs after compression');
});
test('notarization resolves an unconfigured signing keychain from the supplied home', () => {
  const calls = [];
  const env = { HOME: '/Users/test', SODUWORK_MAC_KEYCHAIN_PASSWORD: 'fixture-only-password' };
  notarizeArtifact({ artifactPath: '/tmp/SoduWork.dmg', env,
    run: (file, args) => calls.push([file, ...args]) });
  assert.deepEqual(calls[0], ['security', 'unlock-keychain', '-p', env.SODUWORK_MAC_KEYCHAIN_PASSWORD,
    path.join(env.HOME, 'Library/Keychains/login.keychain-db')]);
});
test('keychain unlock failure blocks submission and does not expose command credentials', () => {
  const env = { SODUWORK_MAC_KEYCHAIN: '/custom/signing.keychain-db',
    SODUWORK_MAC_KEYCHAIN_PASSWORD: 'fixture-only-secret' };
  const calls = [];
  assert.throws(() => notarizeArtifact({ artifactPath: '/tmp/SoduWork.dmg', env,
    run(file, args) {
      calls.push([file, ...args]);
      throw new Error('Command failed: security ' + args.join(' '));
    } }), error => {
    assert.match(error.message, /Unable to unlock the signing keychain/);
    assert.equal(error.stack.includes(env.SODUWORK_MAC_KEYCHAIN_PASSWORD), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(calls, [['security', 'unlock-keychain', '-p',
    env.SODUWORK_MAC_KEYCHAIN_PASSWORD, env.SODUWORK_MAC_KEYCHAIN]]);
});
test('a missing Developer ID keychain identity stops packaging before building', () => {
  const f = signingFixture();
  f.config.run = (file, args) => {
    if (file === 'security') return ' 1) ABCDEF1234 "Apple Development: someone (OTHER)"';
    if (file === 'xcrun') { f.calls.push(['xcrun', ...args]); return ''; }
    if (file === '/usr/bin/arch') return '/Apple Tools/bin/' + args.at(-1);
    if (args[0] === '-c') return 'arm64';
    if (file === 'lipo') return 'arm64';
    f.calls.push([file, ...args]); return '';
  };
  assert.throws(() => build(f.config), /Developer ID identity is missing/);
  assert.equal(f.calls.filter(row => row[0] === 'xcrun').length, 0);
  fs.rmSync(f.config.root, { recursive: true, force: true });
});

test('a public release signs and notarizes both architectures with the configured identity', t => {
  const f = signingFixture();
  t.after(() => fs.rmSync(f.config.root, { recursive: true, force: true }));
  f.config.env.SODUWORK_MAC_RELEASE = '1';
  delete f.config.env.SODUWORK_MACOS_ARCH;
  f.config.env.SODUWORK_MACOS_X64_PYTHON = '/python/x64';
  fs.writeFileSync(path.join(f.config.root, 'client/dist/SoduWork-9.9.9-mac-x64.dmg'), 'dmg');
  build(f.config);
  const packageCalls = f.calls.filter(row => isEntry(row.slice(1), 'electron-builder/cli.js'));
  assert.equal(packageCalls.length, 2);
  for (const call of packageCalls) {
    assert.ok(call.includes('--config.mac.identity=' + IDENTITY));
    assert.ok(call.includes('--config.mac.hardenedRuntime=true'));
    assert.ok(call.includes('--config.afterSign=scripts/notarize-macos.cjs'));
    assert.ok(!call.includes('--config.mac.identity=-'));
  }
  assert.equal(f.calls.filter(row => row[0] === 'xcrun' && row[1] === 'notarytool').length, 2);
  assert.equal(f.calls.filter(row => row[0] === 'xcrun' && row[1] === 'stapler').length, 2);
});

test('a macOS release refuses missing identity or disabled notarization before tool lookup', () => {
  for (const env of [
    { SODUWORK_MAC_RELEASE: '1' },
    { SODUWORK_MAC_RELEASE: '1', SODUWORK_MAC_SIGN_IDENTITY: IDENTITY, SODUWORK_MAC_SKIP_NOTARIZE: 'yes' },
  ]) {
    const f = fixture(); Object.assign(f.config.env, env);
    f.config.run = () => assert.fail('invalid release configuration must fail before tool lookup');
    assert.throws(() => build(f.config), /require SODUWORK_MAC_SIGN_IDENTITY|cannot skip notarization/);
    assert.deepEqual(f.calls, []);
  }
});
