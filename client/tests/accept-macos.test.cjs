'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { unpack } = require('../../tools/ci/accept-macos.cjs');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-mac-unpack-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mounts = path.join(root, 'mounts'), acceptance = path.join(root, 'acceptance');
  await fs.mkdir(mounts); await fs.mkdir(acceptance);
  const source = path.join(root, 'SoduWork.app'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'payload'), 'original payload');
  const calls = [], attached = [];
  const config = { mountRoot: mounts, async execute(file, args) {
    calls.push([file, ...args]);
    if (file === 'hdiutil' && args[0] === 'verify') return '';
    if (file === 'hdiutil' && args[0] === 'attach') {
      const mount = args[args.indexOf('-mountpoint') + 1]; attached.push(mount);
      await fs.cp(source, path.join(mount, 'SoduWork.app'), { recursive: true });
      if (options.attachError) throw options.attachError;
      return '';
    }
    if (file === 'hdiutil' && args[0] === 'detach') {
      if (options.detachError) throw options.detachError;
      // A real unmount exposes the empty mountpoint directory again.
      await fs.rm(path.join(args[1], 'SoduWork.app'), { recursive: true });
      return '';
    }
    if (file === 'ditto') {
      if (options.copyError) throw options.copyError;
      await fs.cp(args[0], args[1], { recursive: true }); return '';
    }
    if (file === '/usr/libexec/PlistBuddy') return 'SoduWork';
    if (file === 'codesign') { if (options.signatureError) throw options.signatureError; return ''; }
    if (file === 'spctl' || file === 'xcrun') { if (options.notaryError) throw options.notaryError; return ''; }
    throw Error('Unexpected command: ' + file);
  } };
  return { root, mounts, acceptance, source, calls, attached, config, installed: path.join(acceptance, 'installed') };
}

test('same DMG supports fresh, old baseline and overwrite extraction without reusing mountpoints', async t => {
  const f = await fixture(t);
  const profile = path.join(f.acceptance, 'profile-sentinel'); await fs.writeFile(profile, 'preserve');
  // Old script left this empty directory after detach. It must not block a retry.
  await fs.mkdir(f.installed + '-mount');
  for (const content of ['fresh', 'old baseline', 'overwrite']) {
    await fs.writeFile(path.join(f.source, 'payload'), content);
    const app = await unpack('same.dmg', 'dmg', f.installed, f.config);
    assert.equal(await fs.readFile(path.join(app.app, 'payload'), 'utf8'), content);
    assert.equal(app.binary, path.join(f.installed, 'SoduWork.app/Contents/MacOS/SoduWork'));
    assert.deepEqual(await fs.readdir(f.mounts), []);
    await fs.rm(f.installed, { recursive: true });
  }
  assert.equal(new Set(f.attached).size, 3);
  assert.equal(f.calls.filter(call => call[0] === 'codesign').length, 3);
  assert.equal(await fs.readFile(profile, 'utf8'), 'preserve');
});

test('failed copy still detaches and removes its empty mount while preserving the extraction error', async t => {
  const error = Error('ditto failed'), f = await fixture(t, { copyError: error });
  await assert.rejects(unpack('broken.dmg', 'dmg', f.installed, f.config), candidate => candidate === error);
  assert.equal(f.calls.filter(call => call[0] === 'hdiutil' && call[1] === 'detach').length, 1);
  assert.deepEqual(await fs.readdir(f.mounts), []);
  assert.equal(f.calls.some(call => call[0] === 'codesign'), false);
});

test('failed detach rejects acceptance and retains the mount outside recursive installation cleanup', async t => {
  const error = Error('resource busy'), f = await fixture(t, { detachError: error });
  await assert.rejects(unpack('busy.dmg', 'dmg', f.installed, f.config), candidate => {
    assert.ok(candidate instanceof AggregateError);
    assert.deepEqual(candidate.errors, [error]);
    assert.ok(candidate.message.includes(f.attached[0]));
    return true;
  });
  assert.equal(f.calls.some(call => call[0] === 'codesign'), false);
  await fs.rm(f.acceptance, { recursive: true }); // mirrors main finally; not the mount root
  assert.equal(await fs.readFile(path.join(f.attached[0], 'SoduWork.app/payload'), 'utf8'), 'original payload');
});

test('partial attach failure still attempts detach and retains both errors if cleanup fails', async t => {
  const attachError = Error('attach incomplete'), detachError = Error('detach failed');
  const f = await fixture(t, { attachError, detachError });
  await assert.rejects(unpack('partial.dmg', 'dmg', f.installed, f.config), candidate => {
    assert.ok(candidate instanceof AggregateError);
    assert.deepEqual(candidate.errors, [attachError, detachError]);
    return true;
  });
  assert.equal(f.calls.filter(call => call[0] === 'hdiutil' && call[1] === 'detach').length, 1);
  assert.equal(f.calls.some(call => call[0] === 'ditto'), false);
});

test('public release acceptance verifies Gatekeeper assessment and stapled notarization', async t => {
  const previous = process.env.SODUWORK_MAC_RELEASE;
  process.env.SODUWORK_MAC_RELEASE = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.SODUWORK_MAC_RELEASE;
    else process.env.SODUWORK_MAC_RELEASE = previous;
  });
  const f = await fixture(t);
  const app = await unpack('signed.dmg', 'dmg', f.installed, f.config);
  assert.equal(app.signature.verified, true);
  assert.deepEqual(f.calls.filter(call => call[0] === 'spctl' || call[0] === 'xcrun'), [
    ['spctl', '--assess', '--type', 'execute', app.app],
    ['xcrun', 'stapler', 'validate', app.app],
  ]);
});

function releaseMode(t) {
  const previous = process.env.SODUWORK_MAC_RELEASE;
  process.env.SODUWORK_MAC_RELEASE = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.SODUWORK_MAC_RELEASE;
    else process.env.SODUWORK_MAC_RELEASE = previous;
  });
}
async function legacyArtifact(f) {
  const file = path.join(f.root, 'old.dmg'), bytes = Buffer.from('pinned old installer fixture');
  await fs.writeFile(file, bytes);
  return { productName: 'SoduWork', version: '1.0.0', path: file, size: bytes.length,
    sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
    notarization: 'legacy-ad-hoc' };
}
test('only an explicit hash-pinned old baseline may predate notarization', async t => {
  releaseMode(t);
  const f = await fixture(t, { notaryError: Error('old app has no ticket') });
  const baseline = await legacyArtifact(f);
  const app = await unpack(baseline.path, 'dmg', f.installed, { ...f.config, legacyBaseline: baseline });
  assert.equal(app.signature.verified, true);
  assert.equal(app.signature.notarization, 'pinned-legacy-ad-hoc');
  assert.equal(f.calls.filter(row => row[0] === 'codesign').length, 1);
  assert.equal(f.calls.some(row => ['spctl', 'xcrun'].includes(row[0])), false);
});
test('legacy migration still rejects an invalid bundle signature', async t => {
  releaseMode(t);
  const signatureError = Error('invalid old signature'), f = await fixture(t, { signatureError });
  const baseline = await legacyArtifact(f);
  await assert.rejects(unpack(baseline.path, 'dmg', f.installed, { ...f.config, legacyBaseline: baseline }),
    error => error === signatureError);
});
test('candidate and unmarked old installers still require notarization', async t => {
  releaseMode(t);
  const notaryError = Error('no stapled ticket'), f = await fixture(t, { notaryError });
  const baseline = await legacyArtifact(f); delete baseline.notarization;
  for (const legacyBaseline of [undefined, baseline]) {
    await assert.rejects(unpack(baseline.path, 'dmg', f.installed, { ...f.config, legacyBaseline }),
      error => error === notaryError);
  }
});
test('legacy exemptions reject altered bytes, wrong paths, other products and candidate versions before extraction', async t => {
  releaseMode(t);
  const f = await fixture(t), baseline = await legacyArtifact(f);
  for (const patch of [
    { sha256: '0'.repeat(64) }, { sha256: '' }, { path: path.join(f.root, 'different.dmg') },
    { productName: 'Other' }, { version: require('../package.json').version }, { size: baseline.size + 1 },
  ]) {
    await assert.rejects(unpack(baseline.path, 'dmg', f.installed, {
      ...f.config, legacyBaseline: { ...baseline, ...patch },
    }));
    assert.deepEqual(f.calls, [], 'invalid exemption must fail before mounting or executing bundle tools');
  }
});
