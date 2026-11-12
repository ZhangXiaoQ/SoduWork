'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { sessionResources, configureSoduWorkRetryPolicy } = require('../main/pi-session/session-resources');
const sdkReady = import(pathToFileURL(path.join(__dirname, '../node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-resource-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'work');
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
  const skill = (folder, name, body) => {
    const dir = path.join(root, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), body ?? `---\nname: ${name}\ndescription: A regression fixture.\n---\n\nFixture instructions.\n`);
    return dir;
  };
  return { root, cwd, agentDir, skill, load: async dirs => sessionResources(await sdkReady, cwd, agentDir, dirs, []) };
}

test('SoduWork defaults avoid multiplying one model turn into provider replays', () => {
  const applied = [];
  configureSoduWorkRetryPolicy({
    getGlobalSettings: () => ({}),
    getProjectSettings: () => ({}),
    applyOverrides: value => applied.push(value),
  });
  assert.deepEqual(applied, [{ retry: {
    maxRetries: 6, delayScheduleMs: [5000, 15000, 30000, 60000, 120000, 240000],
    provider: { maxRetries: 0, maxRetryDelayMs: 0 },
  } }]);
});

test('explicit retry settings remain authoritative', () => {
  const applied = [];
  configureSoduWorkRetryPolicy({
    getGlobalSettings: () => ({ retry: { maxRetries: 3, baseDelayMs: 9000,
      delayScheduleMs: [9000], provider: { maxRetries: 2, maxRetryDelayMs: 500 } } }),
    getProjectSettings: () => ({}),
    applyOverrides: value => applied.push(value),
  });
  assert.deepEqual(applied, []);
});

test('an explicit retry count keeps its base-delay strategy when no schedule is supplied', () => {
  const applied = [];
  configureSoduWorkRetryPolicy({
    getGlobalSettings: () => ({ retry: { maxRetries: 2, baseDelayMs: 750 } }),
    getProjectSettings: () => ({}),
    applyOverrides: value => applied.push(value),
  });
  assert.deepEqual(applied, [{ retry: { provider: { maxRetries: 0, maxRetryDelayMs: 0 } } }]);
});

test('real session resources expose the bounded SoduWork retry defaults', async t => {
  const f = fixture(t);
  const resources = await f.load([]);
  assert.equal(resources.settingsManager.getRetrySettings().maxRetries, 6);
  assert.deepEqual(resources.settingsManager.getRetrySettings().delayScheduleMs,
    [5000, 15000, 30000, 60000, 120000, 240000]);
  assert.equal(resources.settingsManager.getProviderRetrySettings().maxRetries, 0);
  assert.equal(resources.settingsManager.getProviderRetrySettings().maxRetryDelayMs, 0);
});

test('a stalled extension cannot hold a session open forever', async () => {
  let calls = 0;
  const sdk = {
    SettingsManager: { create: () => ({}) },
    DefaultResourceLoader: class {
      constructor(options) { this.options = options; }
      reload() {
        calls += 1;
        return this.options.noExtensions ? Promise.resolve() : new Promise(() => {});
      }
      getSkills() { return { skills: [], diagnostics: [] }; }
    },
  };
  const resources = await sessionResources(sdk, '/scope', '/agent', [], [], { timeoutMs: 30 });
  assert.equal(calls, 2);
  assert.equal(resources.degraded, true);
  assert.equal(resources.resourceLoader.options.noExtensions, true);
});

test('same-name installed Skills use the SDK winner without blocking a session', async t => {
  const f = fixture(t);
  const first = f.skill('bundled', 'same-skill');
  const second = f.skill('imported', 'same-skill');
  const resources = await f.load([first, second]);
  assert.deepEqual(resources.skills, ['same-skill']);
  assert.equal(resources.resourceLoader.getSkills().skills[0].filePath, path.join(first, 'SKILL.md'));
  const rules = require('../main/access-control/policy');
  const policy = rules.create('standard', f.cwd);
  assert.equal(rules.operation(policy, 'read', { path: path.join(first, 'SKILL.md') }, f.cwd, resources.skillReadScope).verdict, 'allow');
  assert.equal(rules.operation(policy, 'read', { path: path.join(second, 'SKILL.md') }, f.cwd, resources.skillReadScope).verdict, 'ask');
});

test('the same Skill reached through a directory, file and junction loads once', async t => {
  const f = fixture(t);
  const dir = f.skill('original', 'one-skill');
  const alias = path.join(f.root, 'alias');
  fs.symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual((await f.load([dir, alias, path.join(dir, 'SKILL.md'), dir])).skills, ['one-skill']);
});

test('empty scope never discovers skills from user or project defaults', async t => {
  const f = fixture(t);
  f.skill('agent/skills/unauthorized', 'unauthorized');
  f.skill('work/.pi/skills/unauthorized-project', 'unauthorized-project');
  assert.deepEqual((await f.load([])).skills, []);
});

test('Windows case-only aliases do not count as missing Skills', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  const dir = f.skill('mixed-case', 'mixed-case');
  assert.deepEqual((await f.load([dir, dir.toUpperCase()])).skills, ['mixed-case']);
});

test('missing description names the broken Skill and preserves SDK diagnostics', async t => {
  const f = fixture(t);
  const broken = f.skill('broken-description', 'broken', '---\nname: broken\n---\nInstructions only.');
  await assert.rejects(f.load([broken]), error => /broken-description/.test(error.message) && /description/i.test(error.message));
});

test('malformed YAML cannot masquerade as an installed Skill', async t => {
  const f = fixture(t);
  await assert.rejects(f.load([f.skill('bad-yaml', '', '---\nname: [\ndescription: broken\n---\n')]), /bad-yaml/);
});

test('a missing path has actionable diagnostics instead of a count mismatch', async t => {
  const f = fixture(t);
  await assert.rejects(f.load([path.join(f.root, 'uninstalled')]), /uninstalled/);
});

test('multiple valid Skills in one root cannot conceal another missing Skill', async t => {
  const f = fixture(t);
  f.skill('collection/first', 'first');
  f.skill('collection/second', 'second');
  await assert.rejects(f.load([path.join(f.root, 'collection'), path.join(f.root, 'absent')]), /absent/);
});

test('a collision receipt is accepted only when its winner really loaded', async () => {
  const sdk = { SettingsManager: { create: () => ({}) }, DefaultResourceLoader: class {
    async reload() {}
    getSkills() { return { skills: [], diagnostics: [{ type: 'collision', collision: {
      winnerPath: '/scope/winner/SKILL.md', loserPath: '/scope/loser/SKILL.md',
    } }] }; }
  } };
  await assert.rejects(sessionResources(sdk, '/scope', '/agent', ['/scope/loser'], []), /loser/);
});

test('real SoduWork runtime resumes an archived session after its old cwd is removed', async t => {
  const f = fixture(t);
  const sdk = await sdkReady;
  const modelConfig = require('../main/pi-session/model-config');
  const sessions = require('../main/pi-session/session');
  const model = { id: 'fixture-model', label: 'Fixture', contextWindow: 32000, baseUrl: 'http://127.0.0.1:9/v1' };
  const modelsPath = modelConfig.writeModels(f.agentDir, model);
  const originalPrepare = modelConfig.prepare;
  const originalCreate = sdk.ModelRuntime.create;
  modelConfig.prepare = async () => ({ ok: true, provider: 'soduwork', agentDir: f.agentDir, model });
  sdk.ModelRuntime.create = () => originalCreate.call(sdk.ModelRuntime, { modelsPath, authPath: path.join(f.agentDir, 'auth.json') });
  t.after(() => { modelConfig.prepare = originalPrepare; sdk.ModelRuntime.create = originalCreate; });
  const app = { isPackaged: false, getPath: () => f.root };
  const dirs = [f.skill('copy-a', 'shared'), f.skill('copy-b', 'shared')];
  const fresh = await sessions.open({ app, identity: {}, cwd: f.cwd, skillDirs: dirs, ephemeral: true });
  assert.equal(fresh.ok, true, fresh.reason);
  t.after(() => fresh.session.close());
  assert.deepEqual(fresh.session.skills, ['shared']);
  const archive = sdk.SessionManager.create(f.cwd, path.join(f.agentDir, 'sessions'));
  archive.appendMessage({ role: 'user', content: 'Ordinary history fixture', timestamp: 1000 });
  archive.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Preserved reply' }], api: 'openai-completions', provider: 'soduwork', model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 1001 });
  const archivePath = archive.getSessionFile();
  const before = fs.readFileSync(archivePath, 'utf8');
  const fallback = path.join(f.root, 'safe-workspace');
  fs.mkdirSync(fallback);
  fs.rmSync(f.cwd, { recursive: true, force: true });
  const resumed = await sessions.open({ app, identity: {}, cwd: fallback, skillDirs: dirs, resumePath: archivePath, resumeCwd: fallback });
  assert.equal(resumed.ok, true, resumed.reason);
  t.after(() => resumed.session.close());
  assert.equal(resumed.session.sessionId, archive.getSessionId());
  assert.equal(resumed.session.taskRef, '');
  assert.match(JSON.stringify(resumed.session.snapshot()), /Preserved reply/);
  assert.ok(fs.readFileSync(archivePath, 'utf8').startsWith(before), 'existing archive messages stay intact');
});
