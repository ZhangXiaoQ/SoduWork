'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const grants = require('../main/pi-session/plugin-grant');
const appGrants = require('../main/pi-session/app-mcp-grant.cjs');
const bridge = path.resolve(__dirname, '../../skills/mcp-tools/scripts/mcp.mjs');

function run(args, env = {}, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge, ...args], { shell: false, windowsHide: true,
      env: { ...process.env, SODUWORK_MCP_JSON: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(input);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('source grant discovers the current bridge and executes app list/call without exposing stored credentials', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork app grant 中文 '));
  const app = { isPackaged: false, getPath: () => root };
  assert.equal(grants._bridgePath(app), bridge);
  const seen = [];
  let redirect = false, redirected = 0;
  const upstream = http.createServer((req, res) => {
    if (req.url === '/other') redirected++;
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const rpc = JSON.parse(raw);
      seen.push({ method: rpc.method, authorization: req.headers.authorization, params: rpc.params });
      if (redirect) { res.writeHead(307, { Location: '/other' }); return res.end(); }
      if (rpc.id === undefined) { res.writeHead(202); return res.end(); }
      const result = rpc.method === 'initialize' ? { protocolVersion: rpc.params.protocolVersion, capabilities: {} }
        : rpc.method === 'tools/list' ? { tools: [{ name: 'whoami', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: '示例资料库' }], structuredContent: { record_id: rpc.params.arguments.record_id } };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let current = { token: 'stored-fixture-credential', revision: 1 };
  const connection = { ...current, server: 'fixture-app-service',
    url: 'http://127.0.0.1:' + upstream.address().port + '/mcp', readCurrent: () => current };
  const grant = await appGrants.extend({ app, connection });
  t.after(() => { grant.cleanup(); upstream.closeAllConnections(); upstream.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const args = ['--config', grant.configFile];
  const listed = await run([...args, 'list', connection.server], { SODUWORK_HUB_ORIGIN: 'https://hub.invalid' });
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).tools[0].name, 'whoami');
  const called = await run([...args, 'call', connection.server, 'whoami', JSON.stringify({ record_id: 'document-fixture', text: '项目文档' })]);
  assert.equal(called.code, 0, called.stderr);
  assert.equal(JSON.parse(called.stdout).structuredContent.record_id, 'document-fixture');
  assert.equal(seen.at(-1).params.arguments.text, '项目文档');
  const text = '项目文档\n引号 "正式"；$HOME `literal`；民生🙂';
  const stdin = await run([...args, 'call', connection.server, 'whoami'],
    { SODUWORK_MCP_ARGS_STDIN: '1' }, JSON.stringify({ space_id: 'team-media', text }));
  assert.equal(stdin.code, 0, stdin.stderr);
  assert.equal(seen.at(-1).params.arguments.text, text);
  assert.ok(seen.every(r => r.authorization === 'Bearer ' + current.token));
  assert.ok(!grant.guide.includes(current.token));
  assert.match(grant.guide, /不要改用技能缓存/);
  assert.match(grant.guide, /工具 schema/);
  for (const identifier of require('../../tools/distribution/PUBLIC-SOURCE.json').excludedIdentifiers) {
    assert.ok(!grant.guide.toLowerCase().includes(identifier.toLowerCase()));
  }
  const legacy = JSON.parse(fs.readFileSync(grant.configFile));
  delete legacy.servers[connection.server].appLease;
  fs.writeFileSync(grant.configFile, JSON.stringify(legacy));
  const alreadyRunning = await run([...args, 'list', connection.server]);
  assert.equal(alreadyRunning.code, 0, alreadyRunning.stderr);
  redirect = true;
  const refused = await run([...args, 'list', connection.server]);
  assert.notEqual(refused.code, 0); assert.match(refused.stderr, /重定向/); assert.equal(redirected, 0);
  const count = seen.length;
  current = { token: 'replacement-fixture-credential', revision: 2 };
  const expired = await run([...args, 'list', connection.server]);
  assert.notEqual(expired.code, 0); assert.match(expired.stderr, /401/); assert.equal(seen.length, count);
  const spec = JSON.parse(fs.readFileSync(grant.configFile)).servers[connection.server];
  const inherited = await run(['list', connection.server], {
    SODUWORK_MCP_SERVERS_JSON: JSON.stringify({ servers: { [connection.server]: spec } }), SODUWORK_HUB_ORIGIN: '' });
  assert.notEqual(inherited.code, 0); assert.match(inherited.stderr, /只允许/);
  for (const changed of [
    { url: 'https://example.invalid/mcp' }, { url: spec.url + '?x=1' }, { url: spec.url.replace('127.0.0.1', 'localhost') },
    { appLease: false }, { headers: { Authorization: 'Bearer ' + connection.token } },
  ]) {
    fs.writeFileSync(grant.configFile, JSON.stringify({ servers: { [connection.server]: { ...spec, ...changed } } }));
    const denied = await run([...args, 'list', connection.server], { SODUWORK_HUB_ORIGIN: '' });
    assert.notEqual(denied.code, 0); assert.match(denied.stderr, /只允许/);
  }
  grant.cleanup(); assert.equal(fs.existsSync(grant.configFile), false);
});
