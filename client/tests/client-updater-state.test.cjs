'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
test.beforeEach(() => require('../main/native-locale.cjs').setLocale('zh-CN'));

const contract = require('../main/client-update-contract');
const updater = require('../main/client-updater');

async function withPlatform(value, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}


async function fixture(deferredTarget = '1.2.13', options = {}) {
  const packageInfo = require('../package.json');
  const priorDistribution = packageInfo.soduworkDistribution;
  const priorChannel = packageInfo.soduworkUpdateChannel;
  if (options.channel) packageInfo.soduworkUpdateChannel = options.channel;
  if (options.distribution) packageInfo.soduworkDistribution =
    require('../main/distribution.cjs').getProfile(options.distribution);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'soduwork-updater-state-'));
  const appPath = path.join(root, 'app');
  const updateRoot = path.join(root, 'client-updates');
  await fsp.mkdir(appPath, { recursive: true });
  await fsp.mkdir(updateRoot, { recursive: true });

  const pair = crypto.generateKeyPairSync('ed25519');
  const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
  const publicKey = spki.subarray(spki.length - 32).toString('base64');
  const artifact = Buffer.alloc(1024 * 1024 + 17, 0x53);
  const releaseId = '12345678-1234-4234-8234-123456789abc';
  const platform = options.platform || 'win32';
  const arch = options.arch || 'x64';
  const artifactName = options.artifactName || (platform === 'win32'
    ? 'SoduWork-1.2.13-Setup.exe'
    : platform === 'darwin' ? 'SoduWork-1.2.13-mac-arm64.dmg'
      : 'SoduWork-1.2.13-linux-x64.tar.gz');
  const manifest = {
    schema: 1,
    releaseId,
    version: options.version || '1.2.13',
    channel: options.channel || 'stable',
    platform,
    arch,
    artifact: {
      name: artifactName,
      size: artifact.length,
      sha256: crypto.createHash('sha256').update(artifact).digest('hex'),
      url: `/api/v1/client-updates/artifacts/${releaseId}`,
    },
    mandatory: false,
    minVersion: options.minVersion || '',
    notes: 'Updater state regression',
    publishedAt: '2026-08-12T12:00:00Z',
    keyId: options.unknownKey ? 'rotated-state-test-key' : 'state-test-key',
  };
  manifest.signature = crypto.sign(
    null, contract.canonicalBytes(manifest), pair.privateKey,
  ).toString('base64');
  await fsp.writeFile(path.join(appPath, 'update-trust.json'), JSON.stringify({
    schema: 1, keys: options.noTrust ? {} : { 'state-test-key': publicKey },
  }));
  if (!options.download) await fsp.writeFile(path.join(updateRoot, manifest.artifact.name), artifact);
  await fsp.writeFile(path.join(updateRoot, 'state.json'), JSON.stringify({
    targetVersion: deferredTarget,
    deferredUntil: Date.now() + 60 * 60 * 1000,
  }));

  const events = [];
  const states = [], scheduled = [], relaunches = [];
  const prepareBodies = [], artifactRequests = [], checkRequests = [];
  let prompts = 0;
  const dialogs = [];
  const drains = [];
  let currentVersion = options.currentVersion || '1.2.12';
  const originalFetch = global.fetch;
  global.fetch = async (url, requestOptions = {}) => {
    const target = String(url);
    if (target.includes('/client-updates/check?')) {
      checkRequests.push(new URL(target));
      if (options.checkResponse) return options.checkResponse();
      return new Response(JSON.stringify({
        hasUpdate: options.hasUpdate !== false,
        manualInstallRequired: !!options.manualInstallRequired,
        attemptId: '22345678-1234-4234-8234-123456789abc',
        manifest,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (target.endsWith(manifest.artifact.url)) {
      artifactRequests.push(requestOptions);
      const response = await options.artifactResponse?.(requestOptions, artifactRequests.length, artifact);
      if (response) return response;
      const bytes = options.corruptDownload ? Buffer.alloc(artifact.length, 0x54) : artifact;
      let offset = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (offset === bytes.length) return controller.close();
        const end = Math.min(bytes.length, offset + 64 * 1024);
        controller.enqueue(bytes.subarray(offset, end)); offset = end;
      } }), { status: 200 });
    }
    if (target.endsWith('/prepare')) {
      prepareBodies.push(JSON.parse(String(requestOptions.body || '{}')));
      return new Response(JSON.stringify(options.prepare || {
        safe: true, blockers: [], retryAfterMs: 1,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (target.includes('/client-updates/attempts/')) {
      const body = JSON.parse(String(requestOptions.body || '{}'));
      events.push(body);
      const response = await options.reportResponse?.(body, requestOptions, originalFetch);
      if (response) return response;
      return new Response(JSON.stringify({ ok: true, attempt: body }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected request: ${target}`);
  };

  const app = {
    isPackaged: true,
    getVersion: () => currentVersion,
    getPath: (name) => {
      assert.equal(name, 'userData');
      return root;
    },
    getAppPath: () => appPath,
    whenReady: () => Promise.resolve(),
    quit: () => assert.fail('defer path must not quit the app'),
    relaunch: options => relaunches.push(options),
  };
  updater.install({
    app,
    ipcMain: { handle: () => {} },
    dialog: { showMessageBox: async (...args) => {
      dialogs.push(args.at(-1));
      prompts += 1;
      if (options.dialogResponse) return options.dialogResponse(args.at(-1));
      return { response: Number(options.promptResponse ?? 1) };
    } },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: {
      send(channel, state) { assert.equal(channel, 'client-update-status'); states.push(state); },
    } }] },
    identityOf: async () => ({
      hub: 'https://hub.test', clientId: 'state-client', session: 'session',
    }),
    getWindow: () => null,
    localWorkloads: () => options.local || { safe: true, blockers: [] },
    setLocalDrain: (value) => drains.push(Boolean(value)),
    stopLocalWorkload: options.stopLocalWorkload,
    wait: options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    launchHelper: options.launchHelper || (async () => assert.fail('fixture must never start a real installer')),
    shell: options.shell || null,
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
    drainTimeoutMs: Number(options.drainTimeoutMs || 20),
    drainPollMs: 1,
    linuxExec: options.linuxExec || null,
  });
  return {
    app,
    events,
    states,
    scheduled,
    relaunches,
    manifest,
    root,
    updateRoot,
    prompts: () => prompts,
    dialogs,
    drains,
    prepareBodies,
    artifactRequests,
    checkRequests,
    setCurrentVersion: (value) => { currentVersion = value; },
    restore: async () => {
      global.fetch = originalFetch;
      if (priorChannel === undefined) delete packageInfo.soduworkUpdateChannel;
      else packageInfo.soduworkUpdateChannel = priorChannel;
      if (priorDistribution === undefined) delete packageInfo.soduworkDistribution;
      else packageInfo.soduworkDistribution = priorDistribution;
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

test('Windows self-hosted beta downloads, verifies and hands off a newer beta for installation', async () => {
  await withPlatform('win32', async () => {
    let launches = 0;
    const ctx = await fixture('other', { distribution: 'self-hosted', download: true,
      currentVersion: '1.13.11-beta.532', version: '1.13.11-beta.533', channel: 'beta',
      minVersion: '1.13.11-beta.532', artifactName: 'SoduWork-1.13.11-beta.533-Setup.exe',
      launchHelper: async () => { launches++; },
    });
    try {
      const status = await updater.check({ interactive: true });
      assert.equal(ctx.checkRequests[0].searchParams.get('channel'), 'beta');
      assert.equal(ctx.checkRequests[0].searchParams.get('current'), '1.13.11-beta.532');
      assert.equal(status.targetVersion, '1.13.11-beta.533');
      assert.equal(ctx.artifactRequests.length, 1);
      assert.ok(ctx.events.some(event => event.state === 'downloaded'));
      assert.equal((await updater.installDownloaded()).state, 'installing');
      assert.equal(launches, 1);
    } finally { await ctx.restore(); }
  });
});

test('only verified manifest notes reach renderer status and the next check clears them', async () => {
  await withPlatform('win32', async () => {
    const ctx = await fixture();
    try {
      const state = await updater.check({ interactive: false });
      assert.equal(state.releaseNotes, ctx.manifest.notes);
      assert.equal('manifest' in state, false); assert.equal('installerPath' in state, false);
      ctx.manifest.notes = 'unsigned changed notes';
      const failed = await updater.check({ interactive: false });
      assert.equal(failed.state, 'failed'); assert.equal(failed.releaseNotes, '');
      assert.ok(!ctx.states.some(row => row.releaseNotes === 'unsigned changed notes'));
    } finally { await ctx.restore(); }
  });
});

test('install requested during download waits for preparation and launches only once', async () => {
  await withPlatform('win32', async () => {
    let release, entered, launches = 0;
    const downloading = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const f = await fixture('other', { download: true,
      artifactResponse: async () => { entered(); await hold; },
      launchHelper: async () => { launches++; },
    });
    try {
      const checking = updater.check({ interactive: true });
      await downloading;
      const installing = updater.installDownloaded();
      // Observe rejection immediately too: the old implementation fails here.
      const result = installing.then(value => ({ value }), error => ({ error }));
      release();
      await checking;
      const installed = await result;
      assert.equal(installed.error, undefined);
      assert.equal(installed.value.state, 'installing');
      assert.equal(f.dialogs.length, 0, 'explicit install must not prompt again');
      assert.equal(launches, 1);
      await updater.installDownloaded();
      await updater.check();
      assert.equal(launches, 1, 'handoff stays exclusive until exit');
    } finally { release(); await f.restore(); }
  });
});

test('drain barrier is a safety check, not a running task or a wait notice', async () => {
  await withPlatform('win32', async () => {
    let f, launches = 0;
    const options = { prepare: { safe: false, blockers: [{ kind: 'drain-barrier', title: '正在确认没有新的任务进入' }] },
      launchHelper: async () => { launches++; }, drainTimeoutMs: 10000,
      wait: async () => {
        assert.equal(launches, 0, 'barrier must still block installation');
        assert.equal(f.dialogs.length, 0, 'an idle safety check must not claim unfinished work');
        options.prepare = { safe: true, blockers: [] };
      } };
    f = await fixture('other', options);
    try {
      await updater.check();
      assert.equal((await updater.installDownloaded()).state, 'installing');
      assert.equal(launches, 1);
    } finally { await f.restore(); }
  });
});

test('an install waiting on a failed download preserves the failure and never launches', async () => {
  await withPlatform('win32', async () => {
    let entered, release;
    const downloading = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const f = await fixture('other', { download: true, corruptDownload: true,
      artifactResponse: async () => { entered(); await hold; } });
    try {
      const checking = updater.check();
      await downloading;
      const installing = updater.installDownloaded();
      release();
      const checked = await checking, installed = await installing;
      assert.equal(installed.state, 'failed');
      assert.equal(installed.error, checked.error);
      assert.doesNotMatch(installed.error, /没有可安装/);
      assert.equal(f.prepareBodies.length, 0);
      assert.equal(f.scheduled.length, 0);
    } finally { release(); await f.restore(); }
  });
});

test('a late defer dialog cannot overwrite installation requested in another window', async () => {
  await withPlatform('win32', async () => {
    let entered, release, launches = 0;
    const prompted = new Promise(resolve => { entered = resolve; });
    const f = await fixture('other', { dialogResponse: () => { entered(); return new Promise(resolve => { release = resolve; }); },
      launchHelper: async () => { launches++; } });
    try {
      const checking = updater.check({ interactive: true });
      await prompted;
      assert.equal((await updater.installDownloaded()).state, 'installing');
      release({ response: 1 });
      assert.equal((await checking).state, 'installing');
      assert.equal(launches, 1);
      assert.equal(f.events.some(event => event.state === 'deferred'), false);
    } finally { release?.({ response: 1 }); await f.restore(); }
  });
});

test('one real workload plus a drain barrier shows one task and still waits for both', async () => {
  await withPlatform('win32', async () => {
    let f, launches = 0;
    const options = { local: { safe: false, blockers: [{ kind: 'runtime-cleanup', title: '执行资源回收' }] },
      prepare: { safe: false, blockers: [{ kind: 'drain-barrier' }] }, drainTimeoutMs: 10000,
      launchHelper: async () => { launches++; },
      wait: async () => {
        assert.equal(launches, 0);
        assert.match(f.dialogs[0].message, /还有 1 项/);
        assert.equal(f.states.at(-1).blockers.length, 2, 'retain all safety evidence');
        options.local = { safe: true, blockers: [] };
        options.prepare = { safe: true, blockers: [] };
      } };
    f = await fixture('other', options);
    try {
      await updater.check();
      assert.equal((await updater.installDownloaded()).state, 'installing');
      assert.equal(launches, 1);
    } finally { await f.restore(); }
  });
});

test('background check failures retain diagnostics without claiming an available version', async () => {
  const ctx = await fixture('1.2.12', { checkResponse: () => new Response('Service unavailable', { status: 503 }) });
  try {
    const state = await withPlatform('win32', () => updater.check({ testMode: true }));
    assert.equal(state.state, 'failed');
    assert.equal(state.interactive, false);
    assert.equal(state.targetVersion, '');
    assert.match(state.error, /更新服务暂时不可用/);
    assert.match(state.rawError, /503/, 'raw HTTP status preserved in rawError');
    assert.equal(ctx.prompts(), 0);
    const manual = await withPlatform('win32', () => updater.check({ testMode: true, interactive: true }));
    assert.equal(manual.interactive, true);
    assert.equal(ctx.prompts(), 1);
  } finally { await ctx.restore(); }
});

test('stale equal or older manifests are current even when the server asks for manual installation', async () => {
  for (const version of ['1.2.13', '1.2.14']) {
    for (const manualInstallRequired of [false, true]) {
      const ctx = await fixture('1.2.12', { manualInstallRequired });
      try {
        ctx.setCurrentVersion(version);
        const state = await withPlatform('win32', () => updater.check({ testMode: true, interactive: true }));
        assert.equal(state.state, 'current');
        assert.equal(state.targetVersion, '');
        assert.equal(state.error, '');
        assert.equal(ctx.prompts(), 0);
        assert.equal(ctx.artifactRequests.length, 0);
      } finally { await ctx.restore(); }
    }
  }
});

test('key rotation can request manual installation without trusting or downloading its installer', async () => {
  const ctx = await fixture('1.2.12', { unknownKey: true, manualInstallRequired: true });
  try {
    const state = await withPlatform('win32', () => updater.check({ testMode: true, interactive: true }));
    assert.equal(state.state, 'manual');
    assert.equal(state.targetVersion, '1.2.13');
    assert.match(state.error, /手动安装/);
    assert.equal(ctx.artifactRequests.length, 0);
    assert.deepEqual(ctx.scheduled, []);
    assert.equal(ctx.prompts(), 0);
  } finally { await ctx.restore(); }
});

test('an empty trust store cannot enter automatic download or installation', async () => {
  const ctx = await fixture('1.2.12', { noTrust: true });
  try {
    const state = await withPlatform('win32', () => updater.check({ testMode: true }));
    assert.equal(state.state, 'failed');
    assert.equal(ctx.artifactRequests.length, 0);
    assert.deepEqual(ctx.scheduled, []);
    assert.equal(ctx.prompts(), 0);
  } finally { await ctx.restore(); }
});

test('an unknown signing key cannot enter automatic download or installation', async () => {
  const ctx = await fixture('1.2.12', { unknownKey: true });
  try {
    const state = await withPlatform('win32', () => updater.check({ testMode: true }));
    assert.equal(state.state, 'failed');
    assert.match(state.error, /签名不受信任/);
    assert.equal(state.targetVersion, '');
    assert.equal(ctx.artifactRequests.length, 0);
    assert.deepEqual(ctx.scheduled, []);
    assert.equal(ctx.prompts(), 0);
  } finally { await ctx.restore(); }
});

test('manual key rotation metadata for equal or older versions stays current without an update prompt', async () => {
  for (const current of ['1.2.13', '1.2.14']) {
    const ctx = await fixture('1.2.12', { unknownKey: true, manualInstallRequired: true });
    try {
      ctx.setCurrentVersion(current);
      const state = await withPlatform('win32', () => updater.check({ testMode: true, interactive: true }));
      assert.equal(state.state, 'current');
      assert.equal(state.targetVersion, '');
      assert.equal(state.error, '');
      assert.equal(ctx.prompts(), 0);
      assert.equal(ctx.artifactRequests.length, 0);
    } finally { await ctx.restore(); }
  }
});

test('transient artifact 503 retries preserve the signed download and finish verified', async () => {
  const waits = [];
  const ctx = await fixture('1.2.12', { download: true,
    wait: async ms => { waits.push(ms); },
    artifactResponse: (_options, attempt) => attempt < 3 ? new Response('Unavailable', { status: 503 }) : null,
  });
  try {
    const state = await withPlatform('win32', () => updater.check({ testMode: true }));
    assert.equal(state.state, 'downloaded');
    assert.equal(ctx.artifactRequests.length, 3);
    assert.deepEqual(waits, [1000, 2000]);
    assert.ok(!ctx.events.some(event => event.state === 'failed'));
    assert.equal((await fsp.stat(path.join(ctx.updateRoot, ctx.manifest.artifact.name))).size, ctx.manifest.artifact.size);
  } finally { await ctx.restore(); }
});

test('persistent artifact 503 retains the resumable partial and server diagnosis after bounded retries', async () => {
  const ctx = await fixture('1.2.12', { download: true, wait: async () => {},
    artifactResponse: () => new Response(JSON.stringify({ detail: 'client release artifact is missing' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }),
  });
  const partial = path.join(ctx.updateRoot, ctx.manifest.artifact.name + '.part');
  await fsp.writeFile(partial, Buffer.alloc(65536, 0x53));
  try {
    const state = await withPlatform('win32', () => updater.check({ testMode: true }));
    assert.equal(state.state, 'failed');
    assert.match(state.error, /更新服务暂时不可用/);
    assert.match(state.rawError, /HTTP 503.*client release artifact is missing/, 'server diagnostics preserved in rawError');
    assert.equal(ctx.artifactRequests.length, 3);
    assert.ok(ctx.artifactRequests.every(options => options.headers.Range === 'bytes=65536-'));
    assert.equal((await fsp.stat(partial)).size, 65536);
    assert.equal(ctx.events.at(-1).state, 'failed');
    await assert.rejects(fsp.stat(path.join(ctx.updateRoot, ctx.manifest.artifact.name)), { code: 'ENOENT' });
  } finally { await ctx.restore(); }
});

test('a resumed signed artifact survives transient 503 and completes using the original Range', async () => {
  const ctx = await fixture('1.2.12', { download: true, wait: async () => {},
    artifactResponse: (_options, attempt, bytes) => attempt === 1
      ? new Response('Unavailable', { status: 503 })
      : new Response(bytes.subarray(65536), { status: 206,
        headers: { 'Content-Range': `bytes 65536-${bytes.length - 1}/${bytes.length}` } }),
  });
  await fsp.writeFile(path.join(ctx.updateRoot, ctx.manifest.artifact.name + '.part'), Buffer.alloc(65536, 0x53));
  try {
    const state = await withPlatform('win32', () => updater.check({ testMode: true }));
    assert.equal(state.state, 'downloaded');
    assert.equal(ctx.artifactRequests.length, 2);
    assert.ok(ctx.artifactRequests.every(options => options.headers.Range === 'bytes=65536-'));
    const bytes = await fsp.readFile(path.join(ctx.updateRoot, ctx.manifest.artifact.name));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), ctx.manifest.artifact.sha256);
  } finally { await ctx.restore(); }
});

test('an artifact server ignoring Range restarts once from zero and still verifies the complete file', async () => {
  const ctx = await fixture('1.2.12', { download: true });
  await fsp.writeFile(path.join(ctx.updateRoot, ctx.manifest.artifact.name + '.part'), Buffer.alloc(65536, 0x53));
  try {
    const state = await withPlatform('win32', () => updater.check({ testMode: true }));
    assert.equal(state.state, 'downloaded');
    assert.equal(ctx.artifactRequests.length, 2);
    assert.equal(ctx.artifactRequests[0].headers.Range, 'bytes=65536-');
    assert.equal(ctx.artifactRequests[1].headers.Range, undefined);
  } finally { await ctx.restore(); }
});

test('artifact authorization failures are immediate, preserve diagnostics and never launch installation', async () => {
  const waits = [];
  const ctx = await fixture('1.2.12', { download: true, wait: async ms => waits.push(ms),
    artifactResponse: () => new Response(JSON.stringify({ detail: 'Device session expired' }), { status: 403 }),
  });
  try {
    const state = await withPlatform('win32', () => updater.check({ testMode: true }));
    assert.equal(state.state, 'failed');
    assert.match(state.error, /更新服务拒绝了本次请求/,
      'UI shows only the friendly message, never the raw error');
    assert.match(state.rawError, /HTTP 403.*Device session expired/,
      'server diagnostics preserved in rawError');
    assert.equal(ctx.artifactRequests.length, 1);
    assert.deepEqual(waits, []);
    assert.deepEqual(ctx.scheduled, []);
  } finally { await ctx.restore(); }
});

test('a real HTTP telemetry response that stalls after its headers cannot strand a downloaded update', { timeout: 12000 }, async t => {
  const http = require('node:http');
  let disconnected = false;
  let confirmDisconnected;
  const disconnectedReceipt = new Promise(resolve => { confirmDisconnected = resolve; });
  let closing = false;
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    request.resume();response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"ok":'); // Deliberately never finish the HTTP body.
    response.on('close', () => { disconnected = true; confirmDisconnected(); });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (closing) socket.destroy();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    // Stop accepting connections before closing sockets: fetch can establish a
    // replacement connection after an abort. Also cover already queued accepts.
    closing = true;
    // Drain queued accepts from the aborted fetch before closing the listener.
    if (process.platform === 'win32') await new Promise(resolve => setTimeout(resolve, 100));
    await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Fixture HTTP server did not close')), 2000);
    server.close(error => { clearTimeout(timer); error ? reject(error) : resolve(); });
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    });
  });
  let count = 0;
  const ctx = await fixture('1.2.12', { reportResponse: (_body, options, fetch) => {
    if (++count !== 1) return null;
    return fetch('http://127.0.0.1:' + server.address().port + '/events', options);
  } });
  try {
    const start = Date.now();
    const result = await withPlatform('win32', () => updater.check({ interactive: false, testMode: true }));
    assert.equal(result.state, 'downloaded');
    assert.ok(ctx.states.some(state => state.reportPending === true), 'timeout remains visible for diagnostics');
    // Observe the actual close receipt within the original operation deadline.
    // A fixed delay races Winsock completion under concurrent native tests.
    let deadline;
    try {
      await Promise.race([disconnectedReceipt, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(Error('Stalled telemetry socket did not close')),
          Math.max(0, 8000 - (Date.now() - start)));
      })]);
    } finally { clearTimeout(deadline); }
    assert.ok(Date.now() - start < 8000, 'nonessential telemetry and socket cleanup have a bounded whole-response timeout');
    assert.equal(disconnected, true, 'abort closes the stalled response instead of leaking a request');
    assert.equal(ctx.scheduled.length, 0, 'background check does not quit or install');
  } finally { await ctx.restore(); }
});


test('automatic checks preserve a deferral for the same target version', async () => {
  const ctx = await fixture('1.2.13');
  try {
    const state = await withPlatform('win32', () => updater.check({ testMode: true, interactive: false }));
    assert.equal(state.state, 'deferred');
    assert.equal(state.phase, 'deferred');
    assert.equal(state.phaseProgress, null);
    assert.equal(ctx.prompts(), 0);
    assert.deepEqual(ctx.events.map((event) => event.state), ['deferred']);
    assert.equal(ctx.events[0].detail.preserved, true);
  } finally {
    await ctx.restore();
  }
});

test('waiting upgrade can stop a listed conversation and cancel waiting without quitting', async () => {
  let phase = 0, stops = 0;
  const ctx = await fixture('1.2.12', {
    local: { safe: false, blockers: [{ kind: 'conversation', ref: 'live-ref', id: 'chat-id', title: 'Long task' }] },
    promptResponse: 1, drainTimeoutMs: 10000,
    stopLocalWorkload: async ref => { assert.equal(ref, 'live-ref'); stops++; },
    wait: async () => {
      if (phase++) return;
      await assert.rejects(updater.resolveBlocker({ kind: 'conversation', id: 'forged' }));
      const stopped = await updater.resolveBlocker({ kind: 'conversation', id: 'live-ref' });
      assert.equal(stopped.state, 'waiting');
      assert.equal(stopped.phase, 'waiting');
      assert.equal(stopped.phaseProgress, null);
      assert.match(stopped.actionMessage, /已请求停止/);
      await updater.resolveBlocker({ action: 'cancel-wait' });
    },
  });
  try {
    await withPlatform('win32', async () => {
      await updater.check({ testMode: true, interactive: false });
      const state = await updater.installDownloaded();
      assert.equal(stops, 1);
      assert.equal(state.state, 'deferred');
    });
    assert.equal(ctx.drains.at(-1), false);
    assert.equal(ctx.events.at(-1).detail.reason, 'user-cancelled-wait');
  } finally { await ctx.restore(); }
});


test('后台检查静默下载：不弹窗，停在 downloaded 等用户点小标识', async () => {


  const ctx = await fixture('1.2.12');
  try {
    const state = await withPlatform('win32', () => updater.check({ testMode: true, interactive: false }));
    assert.equal(state.state, 'downloaded');
    assert.equal(ctx.prompts(), 0);
    assert.deepEqual(ctx.events.map((event) => event.state), [
      'downloading', 'downloaded', 'downloaded',
    ]);
  } finally {
    await ctx.restore();
  }
});

test('主动检查更新仍然给出可选择的提示', async () => {
  const ctx = await fixture('1.2.12');
  try {
    const state = await withPlatform('win32', () => updater.check({ testMode: true, interactive: true }));
    assert.equal(state.state, 'deferred');
    assert.equal(ctx.prompts(), 1);
    assert.match(ctx.dialogs[0].message, /1\.2\.12\s*→\s*1\.2\.13/);
  } finally {
    await ctx.restore();
  }
});


test('post-install launch reports installed and removes pending state', async () => {
  const ctx = await fixture('1.2.13');
  try {
    const attemptId = '22345678-1234-4234-8234-123456789abc';
    await fsp.writeFile(path.join(ctx.updateRoot, 'pending.json'), JSON.stringify({
      schema: 1,
      attemptId,
      targetVersion: '1.2.13',
      createdAt: new Date().toISOString(),
      installer: ctx.manifest.artifact.name,
    }));
    ctx.setCurrentVersion('1.2.13');
    await updater.confirmPending();
    assert.equal(ctx.events.at(-1).state, 'installed');
    assert.equal(ctx.states.at(-1).phase, 'installed');
    assert.equal(ctx.events.at(-1).currentVersion, '1.2.13');
    await assert.rejects(() => fsp.stat(path.join(ctx.updateRoot, 'pending.json')));
    await assert.rejects(() => fsp.stat(path.join(ctx.updateRoot, 'state.json')));
  } finally {
    await ctx.restore();
  }
});


test('post-install launch never reports success while the binary version is still old', async () => {
  const ctx = await fixture('1.2.13');
  try {
    const pending = path.join(ctx.updateRoot, 'pending.json');
    await fsp.writeFile(pending, JSON.stringify({
      schema: 1,
      attemptId: '22345678-1234-4234-8234-123456789abc',
      targetVersion: '1.2.13',
      createdAt: new Date().toISOString(),
      installer: ctx.manifest.artifact.name,
    }));
    await updater.confirmPending();
    assert.equal(ctx.events.at(-1).state, 'failed');
    assert.equal(ctx.states.at(-1).phase, 'failed');
    assert.equal(ctx.states.at(-1).phaseProgress, null);
    assert.equal(ctx.events.at(-1).currentVersion, '1.2.12');
    assert.match(ctx.events.at(-1).error, /当前仍是 1\.2\.12/);
    assert.equal(fs.existsSync(pending), true,
      'failed installs remain recoverable and must not be acknowledged as installed');
  } finally {
    await ctx.restore();
  }
});

test('streamed signed download reports measured bytes but never starts a silent installation', async () => {
  const ctx = await fixture('1.2.12', { download: true });
  try {
    const result = await withPlatform('win32', () => updater.check({ testMode: true }));
    assert.equal(result.state, 'downloaded');
    assert.equal(result.phase, 'ready');
    assert.equal(result.receivedBytes, ctx.manifest.artifact.size);
    assert.equal(result.totalBytes, ctx.manifest.artifact.size);
    const downloads = ctx.states.filter(s => s.phase === 'downloading');
    assert.ok(downloads.some(s => s.receivedBytes > 0 && s.receivedBytes < s.totalBytes));
    assert.ok(downloads.every(s => s.phaseProgress === s.progress && s.progress < 100));
    assert.ok(ctx.states.some(s => s.phase === 'verifying' && s.phaseProgress === null));
    assert.ok(ctx.states.every(s => !('installerPath' in s) && !('manifest' in s)));
    assert.equal(ctx.prompts(), 0);
    assert.deepEqual(ctx.scheduled, []);
    assert.ok(!ctx.states.some(s => ['preparing', 'restarting', 'installed'].includes(s.phase)));
  } finally { await ctx.restore(); }
});

test('a corrupt complete download reports failure, never ready or installation completion', async () => {
  const ctx = await fixture('1.2.12', { download: true, corruptDownload: true });
  try {
    const result = await withPlatform('win32', () => updater.check({ testMode: true }));
    assert.equal(result.state, 'failed');
    assert.equal(result.phase, 'failed');
    assert.equal(result.phaseProgress, null);
    assert.match(result.error, /摘要校验失败/);
    assert.ok(!ctx.states.some(s => ['ready', 'installed'].includes(s.phase)));
    assert.equal(fs.existsSync(path.join(ctx.updateRoot, ctx.manifest.artifact.name)), false);
    assert.deepEqual(ctx.scheduled, []);
  } finally { await ctx.restore(); }
});

test('cached verification and install handoff expose separate phases, and quit waits for acknowledgement', async () => {
  let acknowledge, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const ctx = await fixture('1.2.12', { launchHelper: async (helper, env) => {
    assert.ok(fs.existsSync(helper));
    assert.ok(env.SODUWORK_HELPER_READY.startsWith(ctx.updateRoot));
    entered(); await new Promise(resolve => { acknowledge = resolve; });
  } });
  try {
    await withPlatform('win32', async () => { await updater.check({ testMode: true }); });
    const cached = ctx.states.filter(s => s.phase === 'verifying' && s.verifiedBytes > 0);
    assert.ok(cached.some(s => s.phaseProgress > 0 && s.phaseProgress < 100));
    assert.equal(cached.at(-1).verifiedBytes, ctx.manifest.artifact.size);
    const offset = ctx.states.length;
    const installation = withPlatform('win32', () => updater.installDownloaded());
    await started;
    assert.equal(ctx.states.at(-1).phase, 'preparing');
    assert.equal(ctx.states.at(-1).phaseProgress, null);
    assert.deepEqual(ctx.scheduled, []);
    assert.ok(ctx.states.slice(offset).some(s => s.phase === 'waiting' && s.phaseProgress === null));
    assert.ok(ctx.states.slice(offset).some(s => s.phase === 'verifying' && s.phaseProgress === 100));
    acknowledge();
    const result = await installation;
    assert.equal(result.state, 'installing');
    assert.equal(result.phase, 'restarting');
    assert.equal(result.phaseProgress, null);
    assert.deepEqual(ctx.scheduled.map(s => s.ms), [100, 5000]);
    assert.ok(!ctx.states.some(s => s.phase === 'installed'));
  } finally { acknowledge?.(); await ctx.restore(); }
});

test('failed helper handoff clears stale installation progress and releases the work drain', async () => {
  const ctx = await fixture('1.2.12', { launchHelper: async () => { throw Error('fixture helper rejected'); } });
  try {
    await withPlatform('win32', async () => {
      await updater.check({ testMode: true });
      await assert.rejects(updater.installDownloaded(), /fixture helper rejected/);
    });
    assert.equal(ctx.states.at(-1).phase, 'failed');
    assert.equal(ctx.states.at(-1).phaseProgress, null);
    assert.equal(ctx.drains.at(-1), false);
    assert.deepEqual(ctx.scheduled, []);
  } finally { await ctx.restore(); }
});

test('a fresh successful check clears failed phase and byte counters from the previous attempt', async () => {
  const options = { download: true, corruptDownload: true };
  const ctx = await fixture('1.2.12', options);
  try {
    assert.equal((await withPlatform('win32', () => updater.check({ testMode: true }))).phase, 'failed');
    options.hasUpdate = false;
    const state = await withPlatform('win32', () => updater.check({ testMode: true }));
    assert.equal(state.state, 'current');
    assert.equal(state.phase, 'current');
    assert.equal(state.error, '');
    assert.equal(state.receivedBytes, 0);
    assert.equal(state.totalBytes, 0);
    assert.equal(state.verifiedBytes, 0);
  } finally { await ctx.restore(); }
});


test('mac/linux updates open the installer manually and report deferred', { timeout: 12000 }, async () => {
  const opens = [];
  const ctx = await fixture('1.2.12', {
    platform: 'darwin', arch: 'arm64',
    shell: { openPath: async (target) => { opens.push(target); return ''; } },
  });
  try {
    await withPlatform('darwin', async () => {
      await updater.check({ testMode: true });
      const result = await updater.installDownloaded();
      assert.equal(result.state, 'deferred');
    });
    assert.equal(opens.length, 1);
    assert.ok(opens[0].endsWith('SoduWork-1.2.13-mac-arm64.dmg'));
    assert.equal(ctx.events.at(-1).state, 'deferred');
    assert.equal(ctx.events.at(-1).detail.manualInstall, true);
    assert.ok(!ctx.events.some((event) => event.state === 'installing'));
    assert.deepEqual(ctx.scheduled, []);
    const pending = JSON.parse(await fsp.readFile(
      path.join(ctx.updateRoot, 'pending.json'), 'utf8'));
    assert.equal(pending.targetVersion, '1.2.13');
  } finally { await ctx.restore(); }
});

test('a failed manual installer launch reports failure and drops the pending marker', { timeout: 12000 }, async () => {
  const ctx = await fixture('1.2.12', {
    platform: 'linux', arch: 'x64',
    shell: { openPath: async () => 'boom' },
  });
  try {
    await withPlatform('linux', async () => {
      await updater.check({ testMode: true });
      await assert.rejects(updater.installDownloaded(), /无法打开安装包/);
    });
    assert.equal(ctx.events.at(-1).state, 'failed');
    assert.ok(!ctx.events.some((event) => event.state === 'deferred'));
    await assert.rejects(() => fsp.stat(path.join(ctx.updateRoot, 'pending.json')));
  } finally { await ctx.restore(); }
});

test('installation waits for workloads and safely defers instead of quitting', async () => {
  const ctx = await fixture('1.2.12', {
    promptResponse: 0,
    prepare: {
      safe: false, retryAfterMs: 1,
      blockers: [{ kind: 'runner-session', title: '正在执行的任务' }],
    },
    local: {
      safe: false,
      blockers: [{ kind: 'local-conversation', title: '本机直接会话' }],
    },
    drainTimeoutMs: 5,
    wait: () => new Promise((resolve) => setImmediate(resolve)),
  });
  try {
    const state = await withPlatform('win32', () => updater.check({ testMode: true, interactive: true }));
    assert.equal(state.state, 'deferred');
    assert.match(state.error, /没有中断任何任务/);
    assert.equal(ctx.drains[0], true);
    assert.equal(ctx.drains.at(-1), false);
    assert.equal(ctx.events.at(-1).state, 'deferred');
    assert.equal(ctx.events.at(-1).detail.reason, 'workloads-still-running');
    assert.equal(ctx.prepareBodies[0].blockers[0].title, '本机直接会话');
  } finally {
    await ctx.restore();
  }
});

/* Linux managed updates use pkexec and package managers within the shared update state machine. */

function fakeLinuxExec(over = {}) {
  const calls = [];
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === 'dpkg-query') return { error: null,
      // Match the updater's native async realpath, including Windows temp casing.
      stdout: args[0] === '-L' ? await fsp.realpath(process.execPath) + '\n' : 'install ok installed', stderr: '' };
    if (file === 'which') return { error: null, stdout: '/usr/bin/' + args[0] + '\n', stderr: '' };
    if (file === '/usr/bin/pkexec') {
      if (over.pkexec) return over.pkexec(args);
      return { error: null, stdout: '', stderr: '' };
    }
    throw new Error('unexpected exec: ' + file);
  };
  exec.calls = calls;
  return exec;
}

test('linux deb 更新走与 Windows 相同的静默升级链路（pkexec+dpkg）', { timeout: 12000 }, async () => {
  const linuxExec = fakeLinuxExec();
  const ctx = await fixture('1.2.12', {
    platform: 'linux', arch: 'x64',
    artifactName: 'SoduWork-1.2.13-linux-x64.deb',
    linuxExec,
  });
  try {
    await withPlatform('linux', async () => {
      await updater.check({ testMode: true });
      const result = await updater.installDownloaded();
      assert.equal(result.state, 'installing');
      assert.equal(result.phase, 'restarting');
    });
    assert.deepEqual(ctx.scheduled.map(s => s.ms), [100, 5000]);
    assert.deepEqual(ctx.relaunches, [{ execPath: process.execPath, args: [] }]);
    const pkexec = linuxExec.calls.find(c => c.file === '/usr/bin/pkexec');
    assert.ok(pkexec, 'pkexec must be invoked for the system install');
    assert.deepEqual(pkexec.args.slice(0, 3), ['/usr/bin/dpkg', '-i', '--force-confnew']);
    assert.ok(pkexec.args[3].endsWith('SoduWork-1.2.13-linux-x64.deb'));
    assert.ok(ctx.states.some(s => s.phase === 'preparing'));
    assert.ok(ctx.events.some(e => e.state === 'installing'));
    assert.ok(!ctx.events.some(e => e.state === 'failed'));
    const pending = JSON.parse(await fsp.readFile(
      path.join(ctx.updateRoot, 'pending.json'), 'utf8'));
    assert.equal(pending.targetVersion, '1.2.13');
    assert.ok(!ctx.events.some(e => e.detail && e.detail.manualInstall));
  } finally { await ctx.restore(); }
});

test('linux 授权被拒时不静默回落人工链路，报告 failed 并清 pending', { timeout: 12000 }, async () => {
  const opens = [];
  const linuxExec = fakeLinuxExec({ pkexec: () => ({
    error: Object.assign(new Error('pkexec dismissed'), { code: 126 }),
    stdout: '', stderr: '',
  }) });
  const ctx = await fixture('1.2.12', {
    platform: 'linux', arch: 'x64',
    artifactName: 'SoduWork-1.2.13-linux-x64.deb',
    linuxExec,
    shell: { openPath: async (target) => { opens.push(target); return ''; } },
  });
  try {
    await withPlatform('linux', async () => {
      await updater.check({ testMode: true });
      await assert.rejects(updater.installDownloaded(), /未获得系统授权/);
    });
    assert.equal(ctx.events.at(-1).state, 'failed');
    assert.deepEqual(ctx.scheduled, []);
    await assert.rejects(() => fsp.stat(path.join(ctx.updateRoot, 'pending.json')));
    assert.equal(opens.length, 0, 'cancelled auth must not silently reopen the installer');
  } finally { await ctx.restore(); }
});

test('linux 无 pkexec 或包管理器未登记时回落人工安装链路', { timeout: 12000 }, async () => {
  const opens = [];
  for (const over of [{ pkexec: () => { throw Object.assign(new Error('no pkexec'), { code: 'ENOENT' }); } }]) {
    const linuxExec = fakeLinuxExec(over);
    const ctx = await fixture('1.2.12', {
      platform: 'linux', arch: 'x64',
      artifactName: 'SoduWork-1.2.13-linux-x64.deb',
      linuxExec,
      shell: { openPath: async (target) => { opens.push(target); return ''; } },
    });
    try {
      await withPlatform('linux', async () => {
        await updater.check({ testMode: true });
        const result = await updater.installDownloaded();
        assert.equal(result.state, 'deferred');
      });
      assert.equal(opens.length, 1);
      assert.ok(opens[0].endsWith('SoduWork-1.2.13-linux-x64.deb'));
      assert.equal(ctx.events.at(-1).detail.manualInstall, true);
    } finally { await ctx.restore(); }
  }
  /* Unregistered tarball installations select manual handling without probing managed installation. */
  const quietExec = async (file) => {
    throw new Error('probe must not run for tar.gz: ' + file);
  };
  const ctx = await fixture('1.2.12', {
    platform: 'linux', arch: 'x64',
    artifactName: 'SoduWork-1.2.13-linux-x64.tar.gz',
    linuxExec: quietExec,
    shell: { openPath: async (target) => { opens.push(target); return ''; } },
  });
  try {
    await withPlatform('linux', async () => {
      await updater.check({ testMode: true });
      const result = await updater.installDownloaded();
      assert.equal(result.state, 'deferred');
    });
    assert.equal(opens.length, 2);
  } finally { await ctx.restore(); }
});
