'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { cleanResources } = require('../build/uninstall-resources.cjs');
// A short temporary root on an 8.3-enabled Windows volume lets filesystem
// filters create the deliberately deep fixture before testing the remover.
const temporaryRoot = path.resolve(process.env.SODUWORK_UNINSTALL_TEST_TMP || os.tmpdir());
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(temporaryRoot, 'soduwork-uninstall-test-'));
  const root = path.join(parent, 'installed'), payload = path.join(root, '.soduwork-versions/nsABC.tmp');
  const executable = path.join(payload, 'fixture.exe');
  await fs.mkdir(payload, { recursive: true });
  for (const [file, data] of [['.soduwork-launcher', '1'], ['.soduwork-active', 'nsABC.tmp']]) await fs.writeFile(path.join(root, file), data);
  await fs.writeFile(path.join(payload, '.soduwork-release'), '1'); await fs.writeFile(executable, 'fixture');
  const outside = path.join(parent, 'profile'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'sentinel'), 'keep');
  const resource = path.join(payload, 'resources', ...Array(13).fill('中文runtimeabcdefghijklmnop'), 'module.py');
  await fs.mkdir(path.dirname(resource), { recursive: true }); await fs.writeFile(resource, 'fixture');
  t.after(async () => {
    assert.equal(path.dirname(parent), temporaryRoot); assert.ok(path.basename(parent).startsWith('soduwork-uninstall-test-'));
    await fs.rm(parent, { recursive: true, force: true });
  });
  return { parent, root, payload, executable, outside, resource };
}
test('removes deep Unicode runtime resources while retaining executable and profile', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'resources/legacy'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'resources/legacy/old.py'), 'legacy');
  const retired = path.join(f.root, '.soduwork-retired/nsOLD.tmp-00000000-0000-4000-8000-000000000000/resources');
  await fs.mkdir(retired, { recursive: true }); await fs.writeFile(path.join(retired, 'old.py'), 'retired');
  assert.ok(f.resource.length > 400);
  const result = await cleanResources(f.root, f.executable);
  assert.equal(result.removedResources.length, 3);
  await assert.rejects(fs.access(f.resource), { code: 'ENOENT' });
  assert.equal(await fs.readFile(f.executable, 'utf8'), 'fixture');
  assert.equal(await fs.readFile(path.join(f.outside, 'sentinel'), 'utf8'), 'keep');
});
test('foreign runtime and traversal pointers are rejected before removal', async t => {
  const f = await fixture(t);
  await assert.rejects(cleanResources(f.root, process.execPath), /active Electron/);
  await fs.writeFile(path.join(f.root, '.soduwork-active'), '..');
  await assert.rejects(cleanResources(f.root, f.executable), /Invalid installed version/);
  assert.equal(await fs.readFile(f.resource, 'utf8'), 'fixture');
});
test('failed first migration can clean with its preserved flat-layout Electron', async t => {
  const f = await fixture(t), recovery = path.join(f.root, 'SoduWork.previous.exe');
  await fs.writeFile(recovery, 'original'); await fs.unlink(path.join(f.root, '.soduwork-active'));
  await cleanResources(f.root, recovery);
  await assert.rejects(fs.access(f.resource), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.outside, 'sentinel'), 'utf8'), 'keep');
});
test('an active payload with its historical executable filename can be cleaned', async t => {
  const f = await fixture(t), historical = path.join(f.payload, 'SoduWork.exe');
  await fs.rename(f.executable, historical);
  await cleanResources(f.root, historical);
  await assert.rejects(fs.access(f.resource), { code: 'ENOENT' });
});
test('junctions inside resources or another install folder preserve both trees', async t => {
  const f = await fixture(t), link = path.join(f.root, 'foreign');
  await fs.symlink(f.outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cleanResources(f.root, f.executable), /contains a link/);
  assert.equal(await fs.readFile(f.resource, 'utf8'), 'fixture');
  await fs.unlink(link);
  await fs.symlink(f.outside, path.join(f.payload, 'resources/foreign'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cleanResources(f.root, f.executable), /contains a link/);
  assert.equal(await fs.readFile(f.resource, 'utf8'), 'fixture');
  assert.equal(await fs.readFile(path.join(f.outside, 'sentinel'), 'utf8'), 'keep');
});
test('linked installation roots are rejected before removal', async t => {
  const f = await fixture(t), link = path.join(f.parent, 'linked-install');
  await fs.symlink(f.root, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cleanResources(link, f.executable), /must not be a link/);
  assert.equal(await fs.readFile(f.resource, 'utf8'), 'fixture');
});
test('a foreign I/O root is rejected before removing resources from either tree', async t => {
  const f = await fixture(t);
  await assert.rejects(cleanResources(f.root, f.executable, f.outside), /same installation/);
  assert.equal(await fs.readFile(f.resource, 'utf8'), 'fixture');
  assert.equal(await fs.readFile(path.join(f.outside, 'sentinel'), 'utf8'), 'keep');
});
test('verified short-root I/O removes longer retired Unicode resources without weakening root checks', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), root = path.join(f.parent, 'installed-' + 'long-installation-'.repeat(4));
  await fs.rename(f.root, root);
  const executable = path.join(root, path.relative(f.root, f.executable));
  try {
    const query = require('node:child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$f=New-Object -ComObject Scripting.FileSystemObject;[Console]::Write($f.GetFolder($env:SODUWORK_TEST_ROOT).ShortPath)'],
      { env: { ...process.env, SODUWORK_TEST_ROOT: root }, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(query.status, 0, query.stderr);
    const alias = query.stdout.trim();
    assert.ok(path.isAbsolute(alias), 'Windows must return an absolute I/O spelling');
    // 8.3 generation is a per-volume policy, not a Windows guarantee. An
    // unchanged spelling cannot exercise the shorter-alias success contract.
    // Root rejection and unreadable-path fail-closed behavior remain separate,
    // unconditional tests; never change filesystem policy to satisfy this case.
    if (alias.length >= root.length) return t.skip('The temporary volume does not provide a shorter native 8.3 alias');
    const relative = path.join('.soduwork-retired/nsOLD.tmp-00000000-0000-4000-8000-000000000000/resources',
      ...Array(12).fill('中文资源abcdefghijklmnop'), 'requirements.txt');
    assert.ok(path.join(root, relative).length > 460);
    await fs.mkdir(path.dirname(path.join(alias, relative)), { recursive: true });
    await fs.writeFile(path.join(alias, relative), 'deep retired resource');
    await assert.rejects(cleanResources(root, executable, f.outside), /same installation/);
    await cleanResources(root, executable, alias);
    await assert.rejects(fs.access(path.join(alias, relative)), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(f.outside, 'sentinel'), 'utf8'), 'keep');
  } finally {
    // Restore the owned fixture's original short spelling before its cleanup
    // hook runs, including on volumes where no native short alias exists.
    assert.equal(path.dirname(root), f.parent);
    assert.equal(path.dirname(f.root), f.parent);
    await fs.rename(root, f.root);
  }
});
test('when no shorter alias exists an inaccessible path fails before any resource deletion', async t => {
  const f = await fixture(t), original = fs.lstat;
  t.mock.method(fs, 'lstat', async (file, ...options) => {
    if (String(file) === f.resource) throw Object.assign(new Error('Filesystem path is inaccessible'), { code: 'UNKNOWN' });
    return original(file, ...options);
  });
  // GetFullPathName /SHORT can return the original spelling when 8.3 names
  // are unavailable. An unreadable descendant must not become a partial pass.
  await assert.rejects(cleanResources(f.root, f.executable, f.root), { code: 'UNKNOWN' });
  assert.equal(await fs.readFile(f.resource, 'utf8'), 'fixture');
  assert.equal(await fs.readFile(path.join(f.outside, 'sentinel'), 'utf8'), 'keep');
});
