'use strict';
// Exercise worker resolution inside a real ASAR without installing a client.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), electron = require('electron');
const output = path.resolve(__dirname, '../outputs/nov04-stability/asar');
if (typeof electron === 'string') {
  (async () => {
    const source = path.join(output, 'source'); fs.mkdirSync(source, { recursive: true });
    for (const name of ['account-sync-store.js', 'account-sync-worker.cjs'])
      fs.copyFileSync(path.resolve(__dirname, '../main/conversation', name), path.join(source, name));
    await require('@electron/asar').createPackage(source, path.join(output, 'sync.asar'));
    const env = { ...process.env };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
      'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
    const child = require('node:child_process').spawnSync(electron, [__filename], {
      env, windowsHide: true, encoding: 'utf8', timeout: 30000,
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    assert.equal(child.status, 0, child.error?.message || 'Packaged worker failed');
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app } = electron;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-sync-asar-'));
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const store = require(path.join(output, 'sync.asar/account-sync-store.js')).createWorker(path.join(profile, 'outbox.json'));
    let ok = false;
    try {
      await store.checkpointAndEnqueue('fixture', { sourceEpoch: 'epoch', sourceRevision: 1 }, {
        id: 'fixture', ownerKey: 'fixture-owner', hub: 'https://fixture.invalid', clientId: 'fixture-device',
        body: { sourceSessionId: 'fixture-session', sourceEpoch: 'epoch', sourceRevision: 1, messages: [] },
      });
      assert.equal((await store.jobs()).length, 1);
      await store.ack('fixture', { conversationId: 'fixture-conversation' });
      assert.equal((await store.session('fixture')).ackedRevision, 1);
      assert.equal((await store.pending()).length, 0);
      await store.saveDirectory('fixture-owner', [{ id: 'fixture-conversation', revision: 1, archived: false }], 1);
      await store.saveDirectory('fixture-owner', [{ id: 'fixture-conversation', sourceSessionId: 'fixture-session',
        revision: 9, lifecycleRevision: 9, deleted: true }]);
      await store.saveDirectory('fixture-owner', [{ id: 'fixture-conversation', revision: 2, deleted: false }], 2);
      const directory = await store.directory('fixture-owner');
      assert.equal(directory.cursor, 2, 'a single lifecycle receipt must not skip directory pages');
      assert.equal(directory.items[0].deleted, true);
      assert.equal(directory.items[0].lifecycleRevision, 9);
      assert.equal(directory.items[0].sourceSessionId, 'fixture-session');
      ok = true;
    } catch (error) { console.error(error); }
    finally {
      await store.close(); console.log(JSON.stringify({ ok, asarWorker: true })); app.exit(ok ? 0 : 1);
    }
  });
}
