'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const policy = require('../main/access-control/policy');
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-scope-'));
  const workspace = path.join(root, 'work'); fs.mkdirSync(workspace);
  for (const name of ['report.txt', 'report name.txt', 'AGENTS.md', 'SKILL.md', '.env']) fs.writeFileSync(path.join(workspace, name), 'needle fixture');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
  fs.symlinkSync(root, path.join(workspace, 'link'), 'junction');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace, policy: policy.create('standard', workspace) };
}
test('standard scope admits work instructions for reading but keeps sensitive reads and control writes interactive', t => {
  const { policy: p } = temporary(t);
  for (const name of ['AGENTS.md', 'SKILL.md', 'CLAUDE.md', 'GEMINI.md']) {
    assert.equal(policy.operation(p, 'read', { path: name }).verdict, 'allow', name);
    assert.equal(policy.operation(p, 'write', { path: name }).verdict, 'ask', name);
  }
  for (const name of ['.env', '.ENV', '.npmrc', '.netrc', '.git/config', '.ssh/id_rsa', '.agents/agent.json']) {
    assert.equal(policy.operation(p, 'read', { path: name }).verdict, 'ask', name);
    assert.equal(policy.operation(p, 'edit', { path: name }).verdict, 'ask', name);
  }
  assert.equal(policy.operation(p, 'write', { path: 'docs/new.md' }).verdict, 'allow');
  assert.equal(policy.operation(p, 'read', { path: 'link/outside.txt' }).verdict, 'ask');
});
test('literal queries match the shared Runner corpus, rejecting expansion, execution and mixed path escapes', t => {
  const { policy: p } = temporary(t);
  for (const row of require('./fixtures/access-query-cases.json')) {
    assert.equal(policy.operation(p, 'bash', { command: row.command }).verdict,
      row.allow ? 'allow' : 'ask', row.command);
  }
  assert.equal(policy.operation(p, 'bash', { command: 'pwd', env: { PATH: '.' } }).verdict, 'ask');
});
test('safe query admission rechecks every resolved path, and readonly/full/legacy retain their contracts', t => {
  const { root, workspace, policy: p } = temporary(t);
  const link = path.join(workspace, 'safe'); fs.mkdirSync(path.join(workspace, 'dir'));
  fs.writeFileSync(path.join(workspace, 'dir', 'x.txt'), 'inside');
  fs.symlinkSync(path.join(workspace, 'dir'), link, 'junction');
  const op = policy.operation(p, 'bash', { command: 'cat safe/x.txt' });
  assert.equal(op.verdict, 'allow'); fs.unlinkSync(link); fs.symlinkSync(root, link, 'junction');
  assert.equal(policy.current(p, op), false);
  assert.equal(policy.operation({ ...p, mode: 'readonly' }, 'bash', { command: 'pwd' }).verdict, 'deny');
  assert.equal(policy.operation({ ...p, mode: 'full' }, 'bash', { command: 'python -c pass' }).verdict, 'allow');
  assert.equal(policy.normalize(null), null);
});
test('real Pi SDK reads instructions and runs a safe query without approval, while credentials wait', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-scope-sdk-'));
  const sdk = await import(require('node:url').pathToFileURL(path.resolve(__dirname, '../node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  const fixture = await require('../e2e/fixtures/access-sdk.cjs').create(root, 'standard', () => {}, { customTools: [sdk.createBashTool(path.join(root, 'workspace'))] });
  t.after(async () => { await fixture.close(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(fixture.workspace, 'AGENTS.md'), 'Fixture work instructions');
  fs.writeFileSync(path.join(fixture.workspace, '.env'), 'DO_NOT_READ=secret');
  await fixture.send('read', { path: 'AGENTS.md' });
  assert.equal(fixture.access.broker.pending().length, 0);
  await fixture.send('bash', { command: 'pwd' });
  assert.equal(fixture.access.broker.pending().length, 0);
  const result = fixture.session.messages.filter(x => x.role === 'toolResult').at(-1);
  assert.equal(result.isError, false, JSON.stringify(result));
  const pending = fixture.send('read', { path: '.env' });
  for (let n = 0; n < 200 && !fixture.access.broker.pending().length; n++) await new Promise(r => setTimeout(r, 10));
  const request = fixture.access.broker.pending()[0]; assert.ok(request);
  fixture.access.broker.answer({ ...request, decision: 'deny' }); await pending;
  assert.ok(!JSON.stringify(fixture.session.messages.filter(x => x.role === 'toolResult').at(-1)).includes('DO_NOT_READ'));
});

test('content search cannot inherit recursive directory permission over secrets', t => {
  const { policy: p } = temporary(t);
  assert.equal(policy.operation(p, 'grep', { path: '.', pattern: 'fixture', glob: '**/*' }).verdict, 'ask');
  assert.equal(policy.operation(p, 'grep', { path: 'report.txt', pattern: 'fixture' }).verdict, 'allow');
  assert.equal(policy.operation(p, 'grep', { path: '.env', pattern: 'fixture' }).verdict, 'ask');
  if (process.platform === 'win32') assert.equal(policy.operation(p, 'read', { path: '.env:secret' }).verdict, 'ask');
});
test('query executor bypasses shell startup and refuses writable-workspace executable shadowing', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-query-exec-'));
  const sdk = await import(require('node:url').pathToFileURL(path.resolve(__dirname, '../node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  const fixture = await require('../e2e/fixtures/access-sdk.cjs').create(root, 'standard', () => {}, { customTools: [sdk.createBashTool(path.join(root, 'workspace'))] });
  t.after(async () => { await fixture.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const marker = path.join(root, 'shell-started.txt'), startup = path.join(root, 'startup.sh');
  fs.writeFileSync(startup, 'touch "' + marker.replaceAll('\\', '/') + '"');
  fs.writeFileSync(path.join(fixture.workspace, 'report.txt'), 'DIRECT-QUERY-OUTPUT');
  const shadow = path.join(fixture.workspace, process.platform === 'win32' ? 'cat.exe' : 'cat');
  fs.writeFileSync(shadow, 'untrusted executable'); fs.chmodSync(shadow, 0o755);
  const oldPath = process.env.PATH, oldStartup = process.env.BASH_ENV;
  try {
    process.env.PATH = fixture.workspace + path.delimiter + oldPath; process.env.BASH_ENV = startup;
    await fixture.send('bash', { command: 'cat report.txt' });
    assert.equal(fixture.access.broker.pending().length, 0);
    const result = fixture.session.messages.filter(x => x.role === 'toolResult').at(-1);
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.ok(JSON.stringify(result).includes('DIRECT-QUERY-OUTPUT'));
    assert.equal(fs.existsSync(marker), false);
  } finally {
    process.env.PATH = oldPath;
    if (oldStartup === undefined) delete process.env.BASH_ENV; else process.env.BASH_ENV = oldStartup;
  }
});

test('real Pi directory search skips credentials, external links and inherited ripgrep configuration', { timeout: 30000 }, async t => {
  // The production safe-query executor uses PATH, not the SDK's private tool cache.
  // A missing executable intentionally asks for approval; fail before creating a
  // session instead of leaving this noninteractive fixture waiting for a person.
  const trustedProgram = require('../main/access-control/query-execution').trustedProgram;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-query-search-'));
  if (!trustedProgram('rg', path.join(root, 'workspace'), policy.canonical, policy.within)) {
    fs.rmSync(root, { recursive: true, force: true });
    assert.fail('This real directory-search test requires ripgrep (rg) on PATH; install it before running the suite.');
  }
  const sdk = await import(require('node:url').pathToFileURL(path.resolve(__dirname, '../node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  const fixture = await require('../e2e/fixtures/access-sdk.cjs').create(root, 'standard', () => {}, { customTools: [sdk.createBashTool(path.join(root, 'workspace'))] });
  t.after(async () => { await fixture.close(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(fixture.workspace, 'report.txt'), 'needle PUBLIC_REPORT');
  fs.writeFileSync(path.join(fixture.workspace, '.ENV.local'), 'needle PRIVATE_ENV');
  fs.writeFileSync(path.join(fixture.workspace, 'auth.json'), 'needle PRIVATE_AUTH');
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'needle PRIVATE_OUTSIDE');
  fs.symlinkSync(outside, path.join(fixture.workspace, 'external'), 'junction');
  const config = path.join(root, 'ripgrep-config'); fs.writeFileSync(config, '--glob=*.missing');
  const oldConfig = process.env.RIPGREP_CONFIG_PATH;
  try {
    process.env.RIPGREP_CONFIG_PATH = config;
    await fixture.send('bash', { command: "rg --hidden -n 'needle|missing' ." });
    assert.equal(fixture.access.broker.pending().length, 0);
    const result = fixture.session.messages.filter(x => x.role === 'toolResult').at(-1);
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(JSON.stringify(result), /PUBLIC_REPORT/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_(?:ENV|AUTH|OUTSIDE)/);
  } finally {
    if (oldConfig === undefined) delete process.env.RIPGREP_CONFIG_PATH; else process.env.RIPGREP_CONFIG_PATH = oldConfig;
  }
});
