'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(electron, [__filename],
    { env, windowsHide: true, stdio: 'inherit', timeout: 60000 });
  process.exit(result.status ?? 1);
}
const { app, shell } = electron;
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { trashWithRecovery, currentWindowsSid } = require('../main/pi-session/history-ipc');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  assert.equal(process.platform, 'win32', 'This test needs the real Windows Recycle Bin');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-recycle-e2e-'));
  const dir = path.join(root, 'a'.repeat(110), 'b'.repeat(100));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  await fs.writeFile(file, 'isolated archive proof');
  assert.ok(file.length >= 260);
  let recycledFolder;
  await trashWithRecovery({ async trashItem(folder) {
    recycledFolder = folder;
    await shell.trashItem(folder);
  } }, file);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  const bin = path.join(path.parse(root).root, '$Recycle.Bin', await currentWindowsSid());
  let found = false;
  for (const name of await fs.readdir(bin)) {
    if (!name.startsWith('$I')) continue;
    const metadata = await fs.readFile(path.join(bin, name)).catch(() => null);
    if (!metadata || !metadata.includes(Buffer.from(recycledFolder, 'utf16le'))) continue;
    const retained = path.join(bin, '$R' + name.slice(2));
    assert.equal(await fs.readFile(path.join(retained, 'session.jsonl'), 'utf8'), 'isolated archive proof');
    assert.equal(JSON.parse(await fs.readFile(path.join(retained, 'restore-info.json'))).originalPath, file);
    found = true; break;
  }
  assert.ok(found, 'Recovery archive and original path must actually exist in the system Recycle Bin');
  console.log(JSON.stringify({ ok: true, sourceLength: file.length, recycledArchiveVerified: true }));
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
