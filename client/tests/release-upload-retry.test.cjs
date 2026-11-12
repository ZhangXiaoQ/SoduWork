'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const crypto = require('node:crypto');
const execFile = require('node:util').promisify(require('node:child_process').execFile);

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-upload-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = crypto.generateKeyPairSync('ed25519'), keyId = 'fixture-release';
  const trust = { schema: 1, keys: { [keyId]: key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') } };
  const seed = path.join(root, 'seed'), trustFile = path.join(root, 'trust.json');
  fs.writeFileSync(seed, Buffer.from(key.privateKey.export({ format: 'jwk' }).d, 'base64url').toString('base64'), { mode: 0o600 });
  fs.writeFileSync(trustFile, JSON.stringify(trust));
  const installer = path.join(root, 'SoduWork-1.13.14-linux.deb');
  fs.writeFileSync(installer, Buffer.alloc(1024 * 1024, 7));
  const bundle = path.join(root, 'bundle.json'), receipt = path.join(root, 'receipt.json');
  const state = { requests: [], row: null, status: 200, loseResponse: false, malformed: false };
  const server = http.createServer(async (request, response) => {
    state.requests.push(request.method);
    assert.equal(request.headers.authorization, 'Bearer fixture-token');
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET') {
      response.statusCode = state.status;
      response.end(state.malformed ? 'secret-response-invalid' : JSON.stringify({ releases: state.row ? [state.row] : [], detail: 'secret-response' }));
    } else {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': request.headers['content-type'] } }).formData();
      const signed = JSON.parse(await form.get('bundle').text());
      require('../main/client-update-contract.js').validateManifest(signed, trust, 'linux');
      assert.equal(crypto.createHash('sha256').update(Buffer.from(await form.get('installer').arrayBuffer())).digest('hex'), signed.artifact.sha256);
      state.row = { id: signed.releaseId, version: signed.version, channel: signed.channel, platform: signed.platform,
        arch: signed.arch, artifactName: signed.artifact.name, artifactSize: signed.artifact.size,
        sha256: signed.artifact.sha256, keyId: signed.keyId, notes: signed.notes, mandatory: signed.mandatory,
        minVersion: signed.minVersion, enabled: false };
      if (state.loseResponse) { response.destroy(); return; }
      response.end(JSON.stringify({ ok: true, release: state.row }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const env = { ...process.env, SODUWORK_DISTRIBUTION: 'self-hosted', SODUWORK_CLIENT_PLATFORM: 'linux',
    SODUWORK_CLIENT_ARCH: 'x64', SODUWORK_CLIENT_CHANNEL: 'stable', SODUWORK_CLIENT_RELEASE_NOTES: 'Fixture notes',
    SODUWORK_CLIENT_MINIMUM_VERSION: '1.13.13', SODUWORK_CLIENT_MANDATORY: '0',
    SODUWORK_CLIENT_SIGNING_KEY_FILE: seed, SODUWORK_CLIENT_SIGNING_KEY_ID: keyId, SODUWORK_CLIENT_TRUST_FILE: trustFile,
    SODUWORK_CLIENT_RELEASE_BUNDLE: bundle, SODUWORK_CLIENT_UPLOAD_RECEIPT: receipt,
    SODUWORK_CLIENT_COMPATIBILITY_REPORT: path.join(root, 'unused-compatibility.json'),
    SODUWORK_CLIENT_PUBLISHED_AT: '2026-11-06T01:00:00.000Z', SODUWORK_CLIENT_RELEASE_UPLOAD_TOKEN: 'fixture-token',
    SODUWORK_CLIENT_RELEASE_UPLOAD_URL: `http://127.0.0.1:${server.address().port}/api/v1/admin/client-releases/upload` };
  const run = overrides => execFile(process.execPath, [path.resolve(__dirname, '../../tools/sign-client-release.mjs'), installer, '--reuse-existing'],
    { env: { ...env, ...overrides }, timeout: 15000 });
  return { state, bundle, receipt, installer, run, env, root };
}

test('clean-workspace retry recreates the exact signed ID and skips uploading an existing original', async t => {
  const f = await fixture(t);
  await f.run(); const original = fs.readFileSync(f.bundle, 'utf8');
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).reused, false);
  fs.unlinkSync(f.bundle); fs.unlinkSync(f.receipt);
  await f.run();
  assert.equal(fs.readFileSync(f.bundle, 'utf8'), original);
  assert.deepEqual(f.state.requests, ['GET', 'POST', 'GET']);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).reused, true);
  assert.equal(f.state.row.enabled, false, 'Reconciliation must not enable a release');
});

test('upload response loss recovers through a fresh catalog read without resending bytes', async t => {
  const f = await fixture(t); f.state.loseResponse = true;
  await assert.rejects(f.run());
  assert.ok(f.state.row); assert.equal(fs.existsSync(f.receipt), false);
  fs.unlinkSync(f.bundle);
  await f.run();
  assert.deepEqual(f.state.requests, ['GET', 'POST', 'GET']);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).reused, true);
});

test('metadata conflicts, expired credentials and malformed responses fail without upload or secret logging', async t => {
  const f = await fixture(t); await f.run();
  const original = { ...f.state.row };
  for (const key of ['sha256', 'artifactSize', 'keyId', 'notes', 'minVersion', 'mandatory', 'arch']) {
    fs.rmSync(f.receipt, { force: true });
    f.state.row = { ...original, [key]: 'different' };
    await assert.rejects(f.run(), error => /differs from the signed/.test(error.stderr));
    assert.equal(fs.existsSync(f.receipt), false);
  }
  f.state.row = original;
  for (const status of [401, 403, 500]) {
    f.state.status = status;
    await assert.rejects(f.run(), error => error.stderr.includes('HTTP ' + status) && !error.stderr.includes('secret-response'));
  }
  f.state.status = 200; f.state.malformed = true;
  await assert.rejects(f.run(), error => /invalid JSON/.test(error.stderr) && !error.stderr.includes('secret-response'));
  assert.equal(f.state.requests.filter(method => method === 'POST').length, 1);
});

test('local signature, timestamp and installer changes are rejected before reconciliation', async t => {
  const f = await fixture(t); await f.run();
  const original = JSON.parse(fs.readFileSync(f.bundle));
  await assert.rejects(f.run({ SODUWORK_CLIENT_PUBLISHED_AT: '2026-11-07T01:00:00Z' }), error => /bundle does not match/.test(error.stderr));
  await assert.rejects(f.run({ SODUWORK_CLIENT_PUBLISHED_AT: '' }), error => /fixed publication timestamp/.test(error.stderr));
  fs.writeFileSync(f.bundle, JSON.stringify({ ...original, signature: 'invalid' }));
  await assert.rejects(f.run(), error => /bundle does not match/.test(error.stderr));
  fs.writeFileSync(f.bundle, JSON.stringify(original)); fs.writeFileSync(f.installer, Buffer.alloc(1024 * 1024, 8));
  await assert.rejects(f.run(), error => /bundle does not match/.test(error.stderr));
  assert.deepEqual(f.state.requests, ['GET', 'POST']);
});
