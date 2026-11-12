'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const smokeFile = path.resolve(__dirname, '../../tools/ci/installed-client-smoke.cjs');
const source = fs.readFileSync(smokeFile, 'utf8');
const smokeRequire = require('node:module').createRequire(smokeFile);

async function launch(t, platform, validProfile = true, realKeychain = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-install-acceptance-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, 'installed');
  const profile = path.join(root, validProfile ? 'soduwork-acceptance-profile-test' : 'personal-profile');
  const output = path.join(root, 'result.json');
  const state = { platform, pid: process.pid, env: { SODUWORK_USER_DATA: '/must-not-use-existing-profile',
      ...(realKeychain ? { SODUWORK_MAC_REAL_KEYCHAIN: '1' } : {}) },
    argv: ['node', 'smoke', path.join(installed, 'app'), installed, profile, output, '9.9.1'] };
  const launches = [], errors = [];
  const childError = new Error('Intentional stop after capturing the application launch');
  await vm.runInNewContext(source, {
    process: state, setTimeout, clearTimeout, console: { error: error => errors.push(error) },
    require(name) {
      if (name === 'node:net') return { createServer: () => ({
        listen: (_port, _host, ready) => ready(), address: () => ({ port: 12345 }), close: done => done(),
      }) };
      if (name === 'node:child_process') return {
        spawn(entry, args, options) {
          launches.push({ entry, args: Array.from(args), env: options.env });
          return { on: (_event, callback) => callback(childError), kill() {} };
        },
        spawnSync: () => ({ status: 0 }),
      };
      if (name === './installed-client-timing.cjs') return {
        acceptanceTiming: entry => smokeRequire(name).acceptanceTiming(entry,
          { platform, hostArch: 'arm64', inspect: () => ({ status: 0, stdout: 'arm64' }) }),
      };
      return smokeRequire(name);
    },
  });
  assert.equal(state.exitCode, 1);
  assert.equal(errors.length, 1);
  return { launches, error: errors[0], childError, profile,
    report: fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null };
}

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`installed acceptance launch isolates its profile and Keychain policy on ${platform}`, async t => {
    const result = await launch(t, platform);
    assert.equal(result.error, result.childError);
    assert.equal(result.launches.length, 1);
    const { args, env } = result.launches[0];
    assert.equal(args.includes('--use-mock-keychain'), platform === 'darwin');
    assert.ok(args.includes('--user-data-dir=' + result.profile));
    assert.equal(env.SODUWORK_USER_DATA, result.profile);
    assert.equal(env.SODUWORK_USER_DATA, result.profile);
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:9');
    assert.equal(result.report.ok, false, 'A launch error must not produce successful acceptance');
    assert.equal(result.report.limitations.some(text => text.includes('Keychain')), platform === 'darwin');
  });
}

test('Mac acceptance rejects a personal profile before launching the application', async t => {
  const result = await launch(t, 'darwin', false);
  assert.equal(result.error.code, 'ERR_ASSERTION');
  assert.deepEqual(result.launches, []);
  assert.equal(result.report, null);
  assert.equal(fs.existsSync(result.profile), false);
});

test('Mac acceptance can opt into the real login Keychain for signed release checks', async t => {
  const result = await launch(t, 'darwin', true, true);
  assert.equal(result.error, result.childError);
  assert.equal(result.launches.length, 1);
  assert.equal(result.launches[0].args.includes('--use-mock-keychain'), false);
  assert.equal(result.report.limitations.some(text => text.includes('mock Keychain')), false);
});
