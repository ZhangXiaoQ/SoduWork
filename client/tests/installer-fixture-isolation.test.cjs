'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const productionGuids = [require('../package.json').build.nsis.guid];

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-update-e2e-registry-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('soduwork-update-e2e-registry-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const entry = path.resolve(__dirname, '../e2e/fixtures/isolated-installer-build.cjs');
  const source = await fs.readFile(entry, 'utf8'), fixtureRequire = createRequire(entry);
  const module = { exports: {} }; let invoked;
  vm.runInNewContext(source, { module, process, require: name => name === 'electron-builder'
    ? { build: async options => { invoked = options; return []; } } : fixtureRequire(name) });
  const options = { config: { appId: 'com.soduwork.update.e2e.12345',
    directories: { output: path.join(root, 'dist') },
    nsis: { include: path.resolve(__dirname, '../build/installer.nsh') } } };
  return { root, options, ...module.exports, invoked: () => invoked };
}

test('fixture GUIDs are fresh by default and preserve only safe explicit identities', async t => {
  const f = await fixture(t), first = f.createFixtureGuid(), second = f.createFixtureGuid();
  assert.match(first, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(first, second);
  assert.equal(f.createFixtureGuid(first), first);
  assert.equal(f.validateFixtureGuid(first), first);
  for (const guid of productionGuids) assert.throws(() => f.createFixtureGuid(guid.toUpperCase()), /production NSIS GUID/);
  for (const guid of ['', 'relative-key', null]) assert.throws(() => f.createFixtureGuid(guid), /NSIS GUID/);
  assert.throws(() => f.validateFixtureGuid(undefined), /receipt must provide/);
  const names = f.fixtureNames(first);
  assert.equal(names.productName, 'SoduWorkE2E_' + first.replaceAll('-', ''));
  assert.equal(names.executableName, names.productName);
  assert.equal(names.shortcutName, names.productName);
  f.validateFixtureIdentity({ guid: first, ...names });
  assert.throws(() => f.validateFixtureIdentity({ guid: second, ...names }), /mismatched productName/);
});

test('a copied production NSIS GUID is rejected before any fixture builder side effects', async t => {
  const f = await fixture(t);
  for (const guid of productionGuids) {
    f.options.config.nsis.guid = guid;
    await assert.rejects(f.build(f.options), /production NSIS GUID/);
    assert.equal(f.invoked(), undefined);
    assert.deepEqual(await fs.readdir(f.root), []);
  }
  f.options.config.nsis.guid = f.createFixtureGuid();
  await f.build(f.options);
  const config = JSON.parse(await fs.readFile(f.invoked().config, 'utf8'));
  assert.equal(config.nsis.guid, f.options.config.nsis.guid);
});

test('fixtures without explicit GUID retain electron-builder appId derivation', async t => {
  const f = await fixture(t);
  await f.build(f.options);
  const config = JSON.parse(await fs.readFile(f.invoked().config, 'utf8'));
  assert.equal(Object.hasOwn(config.nsis, 'guid'), false);
});

test('fixture reuse retains the built identity and rejects mismatched roots, GUIDs and names', async t => {
  const f = await fixture(t), guid = f.createFixtureGuid(), names = f.fixtureNames(guid);
  await fs.mkdir(path.join(f.root, 'dist'));
  const config = { appId: 'com.soduwork.update.e2e.12345', productName: names.productName,
    win: { executableName: names.executableName }, directories: { output: path.join(f.root, 'dist') },
    nsis: { guid, shortcutName: names.shortcutName } };
  const file = path.join(f.root, 'dist-builder.json');
  await fs.writeFile(file, JSON.stringify(config));
  const reused = await f.readFixtureReuse(f.root, undefined, guid);
  assert.equal(reused.id, config.appId);
  assert.equal(reused.guid, guid);
  assert.equal(reused.executableName, names.executableName);
  await assert.rejects(f.readFixtureReuse(f.root, undefined, f.createFixtureGuid()), /Explicit GUID differs/);
  await assert.rejects(f.readFixtureReuse(f.root, path.join(f.root, 'outside.exe'), guid), /inside its own dist/);
  await fs.writeFile(file, JSON.stringify({ ...config, productName: 'SoduWork' }));
  await assert.rejects(f.readFixtureReuse(f.root), /mismatched productName/);
  await fs.writeFile(file, JSON.stringify({ ...config, nsis: { ...config.nsis, guid: productionGuids[0] } }));
  await assert.rejects(f.readFixtureReuse(f.root), /production NSIS GUID/);
  await fs.writeFile(file, JSON.stringify({ ...config, directories: { output: path.join(f.root, 'elsewhere') } }));
  await assert.rejects(f.readFixtureReuse(f.root), /own dist directory/);
});

test('reused Setup metadata must match the isolated identity before it can run', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), guid = f.createFixtureGuid(), names = f.fixtureNames(guid);
  const dist = path.join(f.root, 'dist');
  await fs.mkdir(dist);
  await fs.writeFile(path.join(f.root, 'dist-builder.json'), JSON.stringify({
    appId: 'com.soduwork.update.e2e.12345', productName: names.productName,
    win: { executableName: names.executableName }, directories: { output: dist }, nsis: { guid, shortcutName: names.shortcutName },
  }));
  const setup = path.join(dist, names.productName + '-1.0.1-Setup.exe');
  const compiler = await require('app-builder-lib/out/toolsets/windows').getMakeNsisPath();
  async function compile(productName) {
    const script = path.join(f.root, 'metadata.nsi');
    await fs.writeFile(script, ['Unicode true', 'RequestExecutionLevel user', 'OutFile "' + setup + '"',
      'LoadLanguageFile "${NSISDIR}\\Contrib\\Language files\\English.nlf"',
      'VIProductVersion "1.0.1.0"', 'VIAddVersionKey /LANG=1033 "ProductName" "' + productName + '"',
      'VIAddVersionKey /LANG=1033 "ProductVersion" "1.0.1"',
      'VIAddVersionKey /LANG=1033 "FileVersion" "1.0.1"',
      'VIAddVersionKey /LANG=1033 "FileDescription" "Isolated metadata fixture"',
      'VIAddVersionKey /LANG=1033 "LegalCopyright" "Isolated test"', 'Section', 'SectionEnd'].join('\n'));
    const built = spawnSync(compiler.path, ['/V2', '/INPUTCHARSET', 'UTF8', script],
      { env: { ...process.env, ...compiler.env }, windowsHide: true, encoding: 'utf8' });
    assert.equal(built.status, 0, built.stdout + built.stderr);
  }
  await compile(names.productName);
  assert.equal((await f.readFixtureReuse(f.root, setup, guid)).guid, guid);
  await compile('SoduWork');
  await assert.rejects(f.readFixtureReuse(f.root, setup, guid), /not the isolated fixture/);
});

async function captureUpdateConfig(t, explicitGuid) {
  const f = await fixture(t);
  const entry = path.resolve(__dirname, '../e2e/installer-update.cjs');
  const source = await fs.readFile(entry, 'utf8');
  const stop = Error('Captured fixture build without running installer');
  let captured, initialReport, resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const fsp = { mkdtemp: async () => f.root, mkdir: async () => {}, writeFile: async (file, text) => {
    if (path.basename(file) === 'report.json') initialReport = JSON.parse(text);
  },
    readFile: async () => JSON.stringify({ build: { nsis: { guid: productionGuids[0] } } }) };
  const fixtureRequire = createRequire(entry);
  vm.runInNewContext(source, { __dirname: path.dirname(entry),
    process: { env: explicitGuid === undefined ? {} : { SODUWORK_E2E_GUID: explicitGuid }, argv: [], exit() {} },
    console: { log() {}, error(error) { error === stop ? resolveDone() : rejectDone(error); } },
    require(name) {
      if (name === 'node:fs') return { promises: fsp };
      if (name === './fixtures/installer-prepare.cjs') return {};
      if (name === './fixtures/isolated-installer-build.cjs') return {
        ...f, Platform: { WINDOWS: { createTarget: () => [] } }, Arch: { x64: 1 },
        build: async options => { captured = options.config; throw stop; },
      };
      return fixtureRequire(name);
    },
  });
  await done;
  return { ...captured, initialReport };
}

test('installer update replaces inherited production GUID even when the gate clears E2E environment', async t => {
  const first = await captureUpdateConfig(t), second = await captureUpdateConfig(t);
  assert.ok(!productionGuids.includes(first.nsis.guid));
  assert.notEqual(first.nsis.guid, second.nsis.guid);
  assert.match(first.productName, /^SoduWorkE2E_[a-f0-9]{32}$/);
  assert.equal(first.win.executableName, first.productName);
  assert.equal(first.nsis.shortcutName, first.productName);
  assert.equal(first.initialReport.executableName, first.win.executableName);
  assert.equal(first.initialReport.productName, first.productName);
  assert.notEqual(first.productName, second.productName);
  const explicit = '73e82b76-1ce7-4246-8351-dd89d7c0e063';
  assert.equal((await captureUpdateConfig(t, explicit)).nsis.guid, explicit);
  await assert.rejects(captureUpdateConfig(t, productionGuids[0]), /production NSIS GUID/);
});

async function captureFollowupConfig(t, name, guid) {
  const f = await fixture(t), entry = path.resolve(__dirname, '../e2e/' + name + '.cjs');
  const source = await fs.readFile(entry, 'utf8'), fixtureRequire = createRequire(entry);
  const evidence = path.join(f.root, 'report.json');
  const names = f.fixtureNames(guid && !productionGuids.includes(guid) ? guid : 'bc0dd917-52b3-493f-b096-acf04cda608b');
  const report = { root: f.root, installed: path.join(f.root, 'installed'), id: 'com.soduwork.update.e2e.12345', mode: 'currentuser', guid, ...names };
  const stop = Error('Captured followup build without running installer');
  let captured, preparedIdentity, rename, resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const noWrite = async () => {};
  const fakeFs = { mkdir: noWrite, cp: noWrite, writeFile: noWrite, access: noWrite, rename: async (...args) => { rename = args; },
    readFile: async file => file === evidence ? JSON.stringify(report)
      : path.basename(file) === 'package.json' ? JSON.stringify({ build: { nsis: { guid: productionGuids[0] } } })
        : path.basename(file) === '.soduwork-payload.json' ? JSON.stringify({ files: [] }) : Buffer.from('fixture') };
  vm.runInNewContext(source, { __dirname: path.dirname(entry), Buffer,
    process: { env: {}, argv: ['node', entry, evidence], exit() {} },
    console: { log() {}, error(error) { error === stop ? resolveDone() : rejectDone(error); } },
    require(moduleName) {
      if (moduleName === 'node:fs/promises') return fakeFs;
      if (moduleName === '../scripts/native-payload.cjs') return { writeNativePayload: noWrite };
      if (moduleName === '../scripts/prepare-installer.cjs') return { inventory: noWrite };
      if (moduleName === './fixtures/native-payload-fault.cjs') return { mutateStagedPayload: noWrite };
      if (moduleName === './fixtures/isolated-installer-build.cjs') return {
        ...f, Platform: { WINDOWS: { createTarget: () => [] } }, Arch: { x64: 1 },
        prepareFixtureLauncher: async (_client, identity) => { preparedIdentity = identity; },
        build: async options => { captured = options.config; throw stop; },
      };
      return fixtureRequire(moduleName);
    },
  });
  await done;
  return { ...captured, preparedIdentity, rename };
}

test('upgrade followups reuse the receipt GUID and reject old or production identities', async t => {
  const guid = 'bc0dd917-52b3-493f-b096-acf04cda608b';
  for (const name of ['installer-bootstrap-compatibility', 'installer-static-text-compatibility', 'installer-payload-rejection']) {
    const config = await captureFollowupConfig(t, name, guid);
    assert.equal(config.nsis.guid, guid, name);
    assert.equal(config.productName, 'SoduWorkE2E_' + guid.replaceAll('-', ''));
    assert.equal(config.win.executableName, config.productName);
    assert.equal(config.nsis.shortcutName, config.productName);
    assert.equal(config.preparedIdentity.executableName, config.win.executableName);
    await assert.rejects(captureFollowupConfig(t, name, undefined), /receipt must provide/);
    await assert.rejects(captureFollowupConfig(t, name, productionGuids[0]), /production NSIS GUID/);
  }
  const notice = await captureFollowupConfig(t, 'installer-notice-compatibility', guid);
  assert.equal(notice.appId, 'com.soduwork.update.e2e.12345.notice');
  assert.notEqual(notice.nsis.guid, guid, 'the separate notice installation must not replace the main fixture registration');
  assert.ok(!productionGuids.includes(notice.nsis.guid));
  assert.notEqual(notice.productName, 'SoduWorkE2E_' + guid.replaceAll('-', ''));
  assert.equal(notice.preparedIdentity.executableName, notice.win.executableName);
  assert.equal(path.basename(notice.rename[0]), 'SoduWorkE2E_' + guid.replaceAll('-', '') + '.exe');
  assert.equal(path.basename(notice.rename[1]), notice.win.executableName + '.exe');
});

test('every fixture build overrides both file-open namespaces before installer and uninstaller includes', async t => {
  const f = await fixture(t), original = f.options.config.nsis.include;
  await f.build(f.options);
  const config = JSON.parse(await fs.readFile(f.invoked().config, 'utf8'));
  const wrapper = await fs.readFile(config.nsis.include, 'utf8');
  assert.equal(path.dirname(config.nsis.include), f.root);
  assert.match(wrapper, /^!define SODUWORK_FILE_VERB "Software\\Classes\\\*\\shell\\SoduWork\.E2E\.[a-f0-9]{16}"\n/);
  assert.match(wrapper, /!define SODUWORK_OPEN_APP "Software\\Classes\\Applications\\SoduWork\.E2E\.[a-f0-9]{16}\.exe"\n!include /);
  assert.ok(wrapper.includes(original)); assert.equal(f.options.config.nsis.include, original);
  await f.build(f.options);
  assert.equal(await fs.readFile(config.nsis.include, 'utf8'), wrapper, 'rebuild keeps its own registration stable');
  f.options.config.appId += '.notice'; await f.build(f.options);
  assert.notEqual(await fs.readFile(config.nsis.include, 'utf8'), wrapper, 'independent fixture variants do not overwrite each other');
});

test('production appId and ambiguous includes are rejected before builder runs', async t => {
  const f = await fixture(t); f.options.config.appId = 'com.soduwork.app';
  await assert.rejects(f.build(f.options), /isolated appId/); assert.equal(f.invoked(), undefined);
  f.options.config.appId = 'com.soduwork.update.e2e.12345'; f.options.config.nsis.include = 'relative.nsh';
  await assert.rejects(f.build(f.options), /include must be explicit/); assert.equal(f.invoked(), undefined);
});

test('real NSIS resolves isolated definitions when production file-open macros are included', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), original = path.join(f.root, 'check-include.nsh');
  const hook = path.resolve(__dirname, '../build/file-open.nsh');
  await fs.writeFile(original, [
    '!include "' + hook + '"',
    '!if "${SODUWORK_FILE_VERB}" == "Software\\Classes\\*\\shell\\SoduWork.Open"',
    '!error "Production file verb leaked into fixture"', '!endif',
    '!if "${SODUWORK_OPEN_APP}" == "Software\\Classes\\Applications\\SoduWork.exe"',
    '!error "Production application registration leaked into fixture"', '!endif', '',
  ].join('\n'));
  f.options.config.nsis.include = original; await f.build(f.options);
  const config = JSON.parse(await fs.readFile(f.invoked().config, 'utf8'));
  const script = path.join(f.root, 'compile-only.nsi');
  await fs.writeFile(script, ['Unicode true', 'RequestExecutionLevel user',
    'OutFile "' + path.join(f.root, 'not-executed.exe') + '"',
    '!define APP_EXECUTABLE_FILENAME "SoduWork.exe"',
    '!include "' + config.nsis.include + '"', 'Section', 'SectionEnd', '',
  ].join('\n'));
  const compiler = await require('app-builder-lib/out/toolsets/windows').getMakeNsisPath();
  const result = spawnSync(compiler.path, ['/V2', '/INPUTCHARSET', 'UTF8', script],
    { env: { ...process.env, ...compiler.env }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('real NSIS compiles the unique prepackaged launcher and legacy gap only targets its declared executable', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), guid = f.createFixtureGuid(), names = f.fixtureNames(guid);
  await fs.mkdir(path.join(f.root, 'build'));
  await fs.copyFile(path.resolve(__dirname, '../build/launcher.nsi'), path.join(f.root, 'build/launcher.nsi'));
  await fs.copyFile(path.resolve(__dirname, '../build/launcher-progress.nsh'), path.join(f.root, 'build/launcher-progress.nsh'));
  await fs.copyFile(path.resolve(__dirname, '../icon.ico'), path.join(f.root, 'icon.ico'));
  await f.prepareFixtureLauncher(f.root, { guid, ...names });
  assert.ok((await fs.stat(path.join(f.root, '.runtime/installer/SoduWorkLauncher.exe'))).size > 0);
  const installed = path.join(f.root, 'isolated-install');
  await fs.mkdir(installed);
  await fs.writeFile(path.join(installed, '.soduwork-e2e-owned'), 'isolated');
  await fs.writeFile(path.join(installed, names.executableName + '.exe'), 'before');
  await fs.writeFile(path.join(installed, names.executableName + '.pre-test.exe'), 'restored');
  await fs.writeFile(path.join(installed, 'SoduWork.exe'), 'unrelated fixture sentinel');
  const compiler = await require('app-builder-lib/out/toolsets/windows').getMakeNsisPath();
  const baseline = path.join(f.root, 'baseline.exe');
  const args = ['/V2', '/INPUTCHARSET', 'UTF8', '/DSODUWORK_E2E_BASELINE_OUT=' + baseline,
    '/DSODUWORK_E2E_ROOT=' + installed, '/DSODUWORK_E2E_EXECUTABLE_NAME=' + names.executableName,
    path.resolve(__dirname, '../e2e/fixtures/installer-legacy-gap.nsi')];
  const result = spawnSync(compiler.path, args,
    { env: { ...process.env, ...compiler.env }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(spawnSync(baseline, [], { windowsHide: true, timeout: 15000 }).status, 0);
  assert.equal(await fs.readFile(path.join(installed, names.executableName + '.exe'), 'utf8'), 'restored');
  assert.equal(await fs.readFile(path.join(installed, 'SoduWork.exe'), 'utf8'), 'unrelated fixture sentinel');
  await fs.rm(path.join(installed, names.executableName + '.pre-test.exe'));
  assert.equal(spawnSync(baseline, [], { windowsHide: true, timeout: 15000 }).status, 4,
    'a failed baseline restore must not be reported as a successful starting state for upgrade');
});
