'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { recycleLongPath } = require('../main/pi-session/recycle-long-path.cjs');

for (const mode of ['success', 'shell failure', 'changed archive']) {
  test('long archive recovery: ' + mode, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-recycle-test-'));
    const file = path.join(root, 'session.jsonl'), retained = path.join(root, 'recycled');
    await fs.writeFile(file, 'original archive');
    const operation = recycleLongPath({ async trashItem(folder) {
      assert.equal(await fs.readFile(path.join(folder, 'session.jsonl'), 'utf8'), 'original archive');
      assert.equal(JSON.parse(await fs.readFile(path.join(folder, 'restore-info.json'))).originalPath, file);
      if (mode === 'shell failure') throw Error('shell rejected');
      await fs.rename(folder, retained);
      if (mode === 'changed archive') await fs.appendFile(file, '\nnew message');
    } }, file);
    if (mode === 'success') {
      await operation;
      await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    } else {
      await assert.rejects(operation, mode === 'shell failure' ? /shell rejected/ : /Archive changed/);
      assert.match(await fs.readFile(file, 'utf8'), /^original archive/);
    }
    if (mode !== 'shell failure') {
      assert.equal(await fs.readFile(path.join(retained, 'session.jsonl'), 'utf8'), 'original archive');
      await fs.unlink(path.join(retained, 'session.jsonl'));
      await fs.unlink(path.join(retained, 'restore-info.json'));
      await fs.rmdir(retained);
    }
    await fs.unlink(file).catch(() => {});
    await fs.rmdir(root);
  });
}
