'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const outputs = require('../main/pi-session/outputs');
const runtime = require('../main/conversation/artifact-runtime');
const drafts = require('../main/pi-session/plugin-draft');
const personal = require('../main/personal-plugins');
const candidates = require('../main/pi-session/plugin-draft-candidates');

const body = { template: 'method', key: 'weekly-notes', name: '每周工作简报', version: '1.0.0',
  description: '整理资料并生成简报', instructions: '复制随包模板，生成可读的每周工作简报。',
  resources: [{ path: 'templates/report.md', kind: 'template' }] };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-draft-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'conversation');
  fs.mkdirSync(path.join(cwd, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'templates/report.md'), '# {{title}}\n');
  return { root, cwd, app: { getPath: () => path.join(root, 'installed') } };
}

function handle(cwd, since = 0) {
  return { cwd, sessionId: 'selected-conversation', inFlight: () => false,
    outputSnapshot: () => outputs.scan(cwd, since, Date.now() - 1000) };
}

function publicDraft(session) {
  const snapshot = runtime.snapshot(session);
  return runtime.decorate(session.sessionId, { items: snapshot.items }).find(item => item.pluginDraft);
}

test('resource repairs refresh the public revision without changing draft identity or bypassing checksums', t => {
  const { cwd } = fixture(t), file = path.join(cwd, drafts.DRAFT_NAME);
  const expected = require('node:crypto').createHash('sha256').update('corrected resource').digest('hex');
  fs.writeFileSync(file, JSON.stringify({ ...body, resources: [{ ...body.resources[0], sha256: expected }] }));
  const session = handle(cwd), before = publicDraft(session), manifestTime = fs.statSync(file).mtimeMs;
  assert.equal(drafts.readSession(session, before.artifactId).ok, false);
  fs.writeFileSync(path.join(cwd, 'templates/report.md'), 'corrected resource');
  const after = publicDraft(session);
  assert.equal(fs.statSync(file).mtimeMs, manifestTime);
  assert.equal(after.artifactId, before.artifactId);
  assert.notEqual(after.pluginRevision, before.pluginRevision);
  assert.ok(after.pluginRevisionAt >= before.pluginRevisionAt);
  assert.equal(drafts.readSession(session, after.artifactId).ok, true);
  fs.writeFileSync(path.join(cwd, 'unrelated.md'), 'unrelated output');
  assert.equal(publicDraft(session).pluginRevision, after.pluginRevision);
  fs.writeFileSync(path.join(cwd, 'templates/report.md'), 'still invalid');
  assert.equal(drafts.readSession(session, after.artifactId).ok, false);
  assert.equal(publicDraft(handle(cwd, Date.now() + 1000)), undefined, 'resource repair cannot claim an older draft in a new chat');
});

test('large embedded drafts retain bounded metadata and declared resource repair tracking', t => {
  const { cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, drafts.DRAFT_NAME), JSON.stringify({ ...body,
    resources: [{ ...body.resources[0], content: 'a'.repeat(300_000), encoding: 'utf8' }] }));
  const before = publicDraft(handle(cwd));
  assert.equal(before.pluginName, body.name);
  fs.writeFileSync(path.join(cwd, 'templates/report.md'), 'changed external resource');
  const after = publicDraft(handle(cwd));
  assert.notEqual(after.pluginRevision, before.pluginRevision);
  assert.ok(JSON.stringify(after).length < 2000, 'resource bytes never enter renderer metadata');
});

for (const manifest of ['missing', 'invalid', 'unrelated']) {
  test('real filesystem draft remains installable with ' + manifest + ' delivery manifest', t => {
    const { cwd, app } = fixture(t);
    fs.writeFileSync(path.join(cwd, drafts.DRAFT_NAME), '\uFEFF' + JSON.stringify(body));
    if (manifest !== 'missing') {
      fs.mkdirSync(path.join(cwd, '.soduwork'));
      fs.writeFileSync(path.join(cwd, '.soduwork/delivery.json'), manifest === 'invalid' ? '{' : JSON.stringify({
        schemaVersion: 1, deliverables: [{ path: 'templates/report.md', kind: 'document' }],
      }));
    }
    const session = handle(cwd);
    const shown = publicDraft(session);
    assert.ok(shown, 'draft is indexed independently of delivery.json');
    assert.equal(shown.pluginName, body.name);
    assert.equal(shown.pluginVersion, body.version);
    assert.equal(shown.relative, drafts.DRAFT_NAME);
    assert.equal(shown.path, undefined, 'renderer receives an opaque artifact ID, not a file reader');
    const read = drafts.readSession(session, shown.artifactId);
    assert.equal(read.ok, true, read.reason);
    const preview = personal.preflight(read.body);
    assert.equal(preview.ok, true);
    assert.equal(personal.catalog(app).some(item => item.key === body.key), false);
    const installed = personal.create(app, read.body).plugin;
    assert.equal(installed.name, body.name);
    assert.equal(Buffer.from(personal.exportDraft(app, installed.pluginId).resources[0].content, 'base64').toString(), '# {{title}}\n');
  });
}

test('draft identity survives reopened Pi and Runner-style snapshots and later unrelated output', t => {
  const { cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, drafts.DRAFT_NAME), JSON.stringify(body));
  const first = publicDraft(handle(cwd));
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(cwd, drafts.DRAFT_NAME), past, past);
  fs.writeFileSync(path.join(cwd, 'later-result.md'), '# Later result');
  const reopened = handle(cwd, 0), shown = publicDraft(reopened);
  assert.equal(shown.artifactId, first.artifactId);
  assert.equal(drafts.readSession(reopened, shown.artifactId).ok, true);
});

test('an old install card reads the latest same-key revision in its own conversation', t => {
  const { cwd } = fixture(t);
  const oldPath = path.join(cwd, 'v1', drafts.DRAFT_NAME), newPath = path.join(cwd, 'v2', drafts.DRAFT_NAME);
  fs.mkdirSync(path.dirname(oldPath)); fs.mkdirSync(path.dirname(newPath));
  const inputs = [{ key: 'run_mode', type: 'select', options: [{ value: '每步人工确认（默认）', label: '每步人工确认（默认）' }], default: '每步人工确认' }];
  fs.writeFileSync(oldPath, JSON.stringify({ ...body, resources: [], inputs }));
  const old = new Date(Date.now() - 60000); fs.utimesSync(oldPath, old, old);
  const session = handle(cwd), staleCard = publicDraft(session);
  assert.throws(() => personal.preflight(drafts.readSession(session, staleCard.artifactId).body), /run_mode.*默认值不在选项/);
  inputs[0].default = inputs[0].options[0].value;
  fs.writeFileSync(newPath, JSON.stringify({ ...body, resources: [], version: '1.0.1', inputs }));
  const read = drafts.readSession(session, staleCard.artifactId);
  assert.equal(read.ok, true, read.reason);
  assert.equal(read.body.version, '1.0.1');
  assert.equal(read.source.relative, 'v2/' + drafts.DRAFT_NAME);
  assert.equal(personal.preflight(read.body).ok, true);
  fs.writeFileSync(newPath, JSON.stringify({ ...body, resources: [], key: 'different-plugin', version: '1.0.2' }));
  assert.equal(drafts.readSession(session, staleCard.artifactId).ok, false, 'a shared display name cannot redirect to another plugin key');
});

test('a corrected same-path draft is read again from disk even if the caller holds an older snapshot', t => {
  const { cwd } = fixture(t), file = path.join(cwd, drafts.DRAFT_NAME);
  fs.writeFileSync(file, JSON.stringify({ ...body, resources: [], inputs: [{ key: 'run_mode', type: 'select',
    options: [{ value: 'confirm', label: '每步人工确认（默认）' }], default: '每步人工确认' }] }));
  const session = handle(cwd), indexed = runtime.snapshot(session), shown = publicDraft(session);
  assert.throws(() => personal.preflight(drafts.readSession(session, shown.artifactId, indexed).body), /默认值不在选项/);
  const corrected = JSON.parse(fs.readFileSync(file, 'utf8')); corrected.inputs[0].default = 'confirm';
  fs.writeFileSync(file, JSON.stringify(corrected));
  assert.equal(personal.preflight(drafts.readSession(session, shown.artifactId, indexed).body).ok, true);
});

for (const declared of [false, true]) {
  test('new conversation sharing author cwd does not inherit old draft' + (declared ? ' declared in old manifest' : ''), t => {
    const { cwd } = fixture(t);
    const file = path.join(cwd, drafts.DRAFT_NAME);
    fs.writeFileSync(file, JSON.stringify(body));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    if (declared) {
      fs.mkdirSync(path.join(cwd, '.soduwork'));
      fs.writeFileSync(path.join(cwd, '.soduwork/delivery.json'), JSON.stringify({
        schemaVersion: 1, deliverables: [{ path: drafts.DRAFT_NAME, kind: 'file' }],
      }));
    }
    const original = handle(cwd), originalId = publicDraft(original).artifactId;
    // File mtimes and Date.now() have different precision across platforms.
    // Keep all existing fixture files (including templates) before the new
    // conversation boundary, without relaxing the production ownership check.
    const freshSince = Date.now() + 1000;
    const fresh = handle(cwd, freshSince);
    assert.equal(fresh.outputSnapshot().files.length, 0);
    assert.equal(publicDraft(fresh), undefined);
    assert.equal(runtime.snapshot(fresh).items.some(item => item.name === drafts.DRAFT_NAME), false);
    assert.equal(drafts.readSession(fresh, originalId).ok, false);
    assert.equal(drafts.readRecent([fresh]).ok, false);
    assert.equal(publicDraft(handle(cwd, 0)).artifactId, originalId, 'author history retains its actual draft');
    fs.writeFileSync(file, JSON.stringify({ ...body, version: '1.0.1' }));
    const updated = new Date(freshSince + 1000);
    fs.utimesSync(file, updated, updated);
    assert.ok(publicDraft(fresh), 'newly written draft belongs to the new conversation');
  });
}

test('legacy snapshots without a time boundary never invent an unindexed root draft', t => {
  const { cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, drafts.DRAFT_NAME), JSON.stringify(body));
  const legacy = { ...handle(cwd), outputSnapshot: () => ({ files: [] }) };
  assert.equal(publicDraft(legacy), undefined);
  assert.equal(drafts.readRecent([legacy]).ok, false);
});

test('plugin history scope prefers persisted session header and falls back to earliest dated message', () => {
  assert.equal(candidates.sessionSince({ getHeader: () => ({ timestamp: '2026-09-30T01:00:00Z' }),
    getEntries: () => [{ type: 'message', timestamp: '2026-09-30T02:00:00Z' }] }), Date.parse('2026-09-30T01:00:00Z'));
  assert.equal(candidates.sessionSince({ getEntries: () => [
    { type: 'message', timestamp: '2026-09-30T02:00:00Z' },
    { type: 'message', message: { timestamp: Date.parse('2026-09-30T01:00:00Z') } },
  ] }), Date.parse('2026-09-30T01:00:00Z'));
  assert.equal(candidates.sessionSince({ getEntries: () => [{ type: 'message', message: {} }] }), 0);
});

test('real Pi archives sharing cwd retain author draft but exclude it from reopened trial history', async t => {
  const { pathToFileURL } = require('node:url');
  const sdk = await import(pathToFileURL(path.join(__dirname, '../node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  const { cwd, root } = fixture(t);
  const archiveDir = path.join(root, 'archives');
  const author = sdk.SessionManager.create(cwd, archiveDir);
  function persist(manager) {
    manager.appendMessage({ role: 'user', content: 'Fixture request', timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Fixture reply' }],
      api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop' });
  }
  persist(author);
  fs.writeFileSync(path.join(cwd, drafts.DRAFT_NAME), JSON.stringify(body));
  const draftTime = new Date(candidates.sessionSince(author) + 1);
  fs.utimesSync(path.join(cwd, drafts.DRAFT_NAME), draftTime, draftTime);
  await new Promise(resolve => setTimeout(resolve, 10));
  const trial = sdk.SessionManager.create(cwd, archiveDir);
  persist(trial);
  function reopened(manager) {
    const saved = sdk.SessionManager.open(manager.getSessionFile());
    return { ...handle(cwd), outputSnapshot: () => ({ ...outputs.scan(cwd, 0, 0),
      pluginSince: candidates.sessionSince(saved) }) };
  }
  assert.ok(publicDraft(reopened(author)));
  assert.equal(publicDraft(reopened(trial)), undefined);
  fs.writeFileSync(path.join(cwd, 'ordinary-prior-report.md'), '# Other history');
  const old = new Date(Date.now() - 86400000);
  fs.utimesSync(path.join(cwd, 'ordinary-prior-report.md'), old, old);
  assert.ok(runtime.snapshot(reopened(trial)).items.some(item => item.name === 'ordinary-prior-report.md'),
    'general document recovery keeps its prior behavior');
});

for (const placement of ['assets', 'root']) test('canonical root draft survives bounded output scanning with resources in ' + placement, t => {
  const { cwd } = fixture(t);
  fs.mkdirSync(path.join(cwd, 'assets'));
  for (let i = 0; i < 75; i++) fs.writeFileSync(path.join(cwd,
    placement === 'assets' ? 'assets/' + i + '.txt' : 'a-resource-' + i + '.txt'), 'resource');
  fs.writeFileSync(path.join(cwd, drafts.DRAFT_NAME), JSON.stringify(body));
  const session = handle(cwd);
  assert.equal(session.outputSnapshot().truncated, true);
  // Direct files are now scanned before child resources. Keep a second case
  // that genuinely exhausts the root index, so the canonical fallback is tested.
  assert.equal(session.outputSnapshot().files.some(file => file.name === drafts.DRAFT_NAME), placement === 'assets');
  const shown = publicDraft(session);
  assert.ok(shown);
  assert.equal(drafts.readSession(session, shown.artifactId).ok, true);
  assert.equal(drafts.readRecent([session]).ok, true);
});

test('truncated fresh conversation index still excludes a pre-existing root draft', t => {
  const { cwd } = fixture(t);
  const file = path.join(cwd, drafts.DRAFT_NAME), old = new Date(Date.now() - 60_000);
  fs.writeFileSync(file, JSON.stringify(body));
  fs.utimesSync(file, old, old);
  const since = Date.now() - 1000;
  fs.mkdirSync(path.join(cwd, 'assets'));
  for (let i = 0; i < 75; i++) fs.writeFileSync(path.join(cwd, 'assets', i + '.txt'), 'new resource');
  const fresh = handle(cwd, since);
  assert.equal(fresh.outputSnapshot().truncated, true);
  assert.equal(fresh.outputSnapshot().since, since);
  assert.equal(publicDraft(fresh), undefined);
  assert.equal(drafts.readRecent([fresh]).ok, false);
});

test('only structurally identified plugin.json is indexed; unrelated JSON never becomes installable', t => {
  const { cwd } = fixture(t);
  const file = path.join(cwd, 'plugin.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'regular application configuration' }));
  fs.writeFileSync(path.join(cwd, 'report.json'), JSON.stringify(body));
  assert.equal(publicDraft(handle(cwd)), undefined);
  fs.writeFileSync(file, JSON.stringify(body));
  const shown = publicDraft(handle(cwd));
  assert.equal(shown.relative, 'plugin.json');
  assert.equal(drafts.readSession(handle(cwd), shown.artifactId).ok, true);
});

for (const extension of ['soduwork-plugin', 'soduwork-plugin', 'soduwork-plugin']) {
  test('real exported ' + extension + ' package can be discovered and installed without the Hub', async t => {
    const { cwd, root } = fixture(t);
    const source = { getPath: () => path.join(root, 'source') };
    const target = { getPath: () => path.join(root, 'target') };
    const made = personal.create(source, { ...body, resources: [{ ...body.resources[0],
      encoding: 'utf8', content: '# {{title}}\n' }] }).plugin;
    await personal.exportToFile(source, { showSaveDialog: async () => ({ canceled: false,
      filePath: path.join(cwd, 'weekly.' + extension) }) }, made.pluginId);
    const shown = publicDraft(handle(cwd));
    assert.ok(shown);
    assert.equal(shown.pluginPackage, true);
    const read = drafts.readSession(handle(cwd), shown.artifactId);
    assert.equal(read.ok, true, read.reason);
    const installed = personal.create(target, read.body).plugin;
    assert.equal(installed.checksum, made.checksum);
  });
}

test('an old archive card cannot bypass its corrected manifest after candidate merging', async t => {
  const { cwd, root } = fixture(t), source = { getPath: () => path.join(root, 'source') };
  const made = personal.create(source, { ...body, resources: [] }).plugin;
  const name = body.name + '-1.0.0.soduwork-plugin', archive = path.join(cwd, name);
  await personal.exportToFile(source, { showSaveDialog: async () => ({ canceled: false, filePath: archive }) }, made.pluginId);
  fs.mkdirSync(path.join(cwd, '.soduwork'));
  fs.writeFileSync(path.join(cwd, '.soduwork/delivery.json'), JSON.stringify({ schemaVersion: 1,
    deliverables: [{ path: name, kind: 'file', primary: true }] }));
  const session = handle(cwd), old = publicDraft(session);
  assert.equal(drafts.readSession(session, old.artifactId).ok, true);
  fs.writeFileSync(path.join(cwd, drafts.DRAFT_NAME), JSON.stringify({ ...body, resources: [], version: '1.0.1' }));
  const result = drafts.readSession(session, old.artifactId);
  assert.equal(result.ok, false, 'an archive without trustworthy key metadata must ask to refresh, never keep reading its stale bytes');
  assert.match(result.reason, /新稿/);
});

test('draft access rejects in-progress turns, removed files, junctions and forged artifact IDs', t => {
  const { cwd, root } = fixture(t);
  fs.writeFileSync(path.join(cwd, drafts.DRAFT_NAME), JSON.stringify(body));
  const session = handle(cwd), shown = publicDraft(session);
  assert.equal(drafts.readSession(session, '../' + drafts.DRAFT_NAME).ok, false);
  assert.equal(drafts.readSession({ ...session, inFlight: () => true }, shown.artifactId).ok, false);
  assert.equal(drafts.readRecent([{ ...session, inFlight: () => true }]).ok, false);
  fs.unlinkSync(path.join(cwd, drafts.DRAFT_NAME));
  assert.equal(drafts.readSession(session, shown.artifactId).ok, false);
  const outside = path.join(root, 'other-session');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, drafts.DRAFT_NAME), JSON.stringify(body));
  fs.symlinkSync(outside, path.join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const file = path.join(cwd, 'linked', drafts.DRAFT_NAME);
  const linked = { ...session, outputSnapshot: () => ({ files: [{ path: file, name: drafts.DRAFT_NAME }] }) };
  assert.equal(publicDraft(linked), undefined);
  assert.equal(drafts.readRecent([linked]).ok, false);
});

test('broken canonical drafts stay reachable and return an actionable parse error, not a false success', t => {
  const { cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, drafts.DRAFT_NAME), '{');
  const session = handle(cwd), shown = publicDraft(session);
  assert.ok(shown);
  const read = drafts.readSession(session, shown.artifactId);
  assert.equal(read.ok, false);
  assert.match(read.reason, /读取插件草稿失败/);
});

/* ── Plugin identity merge: one install card per plugin, revisions converge ── */

const draftRow = (dir, name, pluginName, at) => ({
  path: path.resolve(dir, name), name, at,
  pluginDraft: true, pluginPackage: /\.soduwork-plugin$/i.test(name),
  pluginName: pluginName || '', pluginVersion: '',
});

test('merge: same-directory archive collapses into its manifest as one candidate', () => {
  const merged = candidates.mergePluginCandidates([
    { path: 'C:\ws\soduwork-plugin-draft.json', name: 'soduwork-plugin-draft.json', at: 200,
      pluginDraft: true, pluginPackage: false, pluginName: '销售数据问答', pluginVersion: '1.0.0' },
    { path: 'C:\ws\销售数据问答-1.0.0.soduwork-plugin', name: '销售数据问答-1.0.0.soduwork-plugin',
      at: 100, pluginDraft: true, pluginPackage: true, pluginName: '', pluginVersion: '' },
  ]);
  assert.equal(merged.length, 1, 'package beside its manifest never becomes a second card');
  assert.equal(merged[0].pluginName, '销售数据问答');
  assert.equal(merged[0].pluginIdentity, 'name:' + candidates.slugName('销售数据问答'));
  assert.equal(merged[0].pluginSuperseded, undefined);
});

test('merge: package name without its version tail matches the manifest slug', () => {
  assert.equal(candidates.packageSlug({ name: 'sales-qa-1.0.0.soduwork-plugin' }), 'sales-qa');
  assert.equal(candidates.packageSlug({ name: 'sales-qa-v2.3.soduwork-plugin' }), 'sales-qa');
  assert.equal(candidates.packageSlug({ name: '销售数据问答-1.0.0.soduwork-plugin' }), candidates.slugName('销售数据问答'));
});

test('merge: numeric plugin name remains distinct from its exported version suffix', () => {
  assert.equal(candidates.packageSlug({ name: 'excel-365-1.0.0.soduwork-plugin' }), 'excel-365');
  assert.equal(candidates.packageSlug({ name: 'report-2026-v2.3.soduwork-plugin' }), 'report-2026');
  const merged = candidates.mergePluginCandidates([
    draftRow('workspace', 'soduwork-plugin-draft.json', 'Excel 365', 200),
    draftRow('workspace', 'excel-365-1.0.0.soduwork-plugin', '', 100),
  ]);
  assert.equal(merged.length, 1, 'the numeric name must not produce a duplicate install card');
  assert.equal(merged[0].pluginIdentity, 'name:excel-365');
});

test('merge: unmatched archive in the same directory stays an honest standalone candidate', () => {
  const merged = candidates.mergePluginCandidates([
    { path: 'C:\ws\soduwork-plugin-draft.json', name: 'soduwork-plugin-draft.json',
      pluginDraft: true, pluginPackage: false, pluginName: '销售数据问答', pluginVersion: '1.0.0' },
    { path: 'C:\ws\mystery-tool-2.0.0.soduwork-plugin', name: 'mystery-tool-2.0.0.soduwork-plugin',
      pluginDraft: true, pluginPackage: true, pluginName: '', pluginVersion: '' },
  ]);
  assert.equal(merged.length, 2, 'unrelated package is not silently swallowed');
  assert.ok(merged.every(row => row.pluginIdentity));
});

test('merge: a revision in another directory supersedes the older copy, newest stays current', () => {
  const old = candidates.mergePluginCandidates([
    { path: 'C:\ws\v1\soduwork-plugin-draft.json', name: 'soduwork-plugin-draft.json',
      pluginDraft: true, pluginPackage: false, pluginName: '销售数据问答', pluginVersion: '1.0.0', at: 100 },
    { path: 'C:\ws\v2\soduwork-plugin-draft.json', name: 'soduwork-plugin-draft.json',
      pluginDraft: true, pluginPackage: false, pluginName: '销售数据问答', pluginVersion: '1.1.0', at: 200 },
  ]);
  assert.equal(old.length, 2, 'older copy stays openable in the workspace');
  assert.equal(old.find(row => row.pluginVersion === '1.1.0').pluginSuperseded, undefined);
  assert.equal(old.find(row => row.pluginVersion === '1.0.0').pluginSuperseded, true);
  assert.equal(old[0].pluginIdentity, old[1].pluginIdentity);
});

test('merge: equal timestamps keep scan order so delivery-declared rows stay current', () => {
  const rows = candidates.mergePluginCandidates([
    { path: 'C:\ws\v1\soduwork-plugin-draft.json', name: 'soduwork-plugin-draft.json',
      pluginDraft: true, pluginPackage: false, pluginName: '销售数据问答', at: 100 },
    { path: 'C:\ws\v2\soduwork-plugin-draft.json', name: 'soduwork-plugin-draft.json',
      pluginDraft: true, pluginPackage: false, pluginName: '销售数据问答', pluginVersion: '2.0.0', at: 100 },
  ]);
  assert.equal(rows.filter(row => row.pluginSuperseded).length, 1);
  assert.equal(rows.find(row => !row.pluginSuperseded).path, 'C:\ws\v1\soduwork-plugin-draft.json',
    'first-scanned (delivery items come first) wins the tie');
});

test('merge: three generations collapse to one current and two superseded', () => {
  const rows = candidates.mergePluginCandidates([
    { path: 'C:\ws\v1\soduwork-plugin-draft.json', name: 'soduwork-plugin-draft.json',
      pluginDraft: true, pluginPackage: false, pluginName: '销售数据问答', at: 100 },
    { path: 'C:\ws\v2\soduwork-plugin-draft.json', name: 'soduwork-plugin-draft.json',
      pluginDraft: true, pluginPackage: false, pluginName: '销售数据问答', at: 200 },
    { path: 'C:\ws\v3\soduwork-plugin-draft.json', name: 'soduwork-plugin-draft.json',
      pluginDraft: true, pluginPackage: false, pluginName: '销售数据问答', at: 300 },
  ]);
  assert.equal(rows.filter(row => row.pluginSuperseded).length, 2);
  assert.equal(rows.find(row => !row.pluginSuperseded).at, 300);
});

test('merge: distinct plugin names in different directories never merge', () => {
  const rows = candidates.mergePluginCandidates([
    { path: 'C:\ws\a\soduwork-plugin-draft.json', name: 'soduwork-plugin-draft.json',
      pluginDraft: true, pluginPackage: false, pluginName: '销售数据问答', at: 100 },
    { path: 'C:\ws\b\soduwork-plugin-draft.json', name: 'soduwork-plugin-draft.json',
      pluginDraft: true, pluginPackage: false, pluginName: '每周工作简报', at: 200 },
  ]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => !row.pluginSuperseded), 'different plugins never supersede each other');
});

test('end-to-end: real archive beside a real manifest is merged before the renderer sees it', t => {
  const { cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, drafts.DRAFT_NAME), JSON.stringify(body));
  const packaged = path.join(cwd, body.name + '-1.0.0.soduwork-plugin');
  fs.writeFileSync(packaged, 'PK\u0003\u0004 fake archive');
  const snapshot = handle(cwd).outputSnapshot();
  const collected = candidates.collect(cwd, snapshot);
  assert.equal(collected.filter(row => row.pluginPackage).length, 0,
    'same-directory package never reaches the item set as its own draft');
  const shown = publicDraft(handle(cwd));
  assert.ok(shown);
  assert.equal(shown.pluginIdentity, 'name:' + candidates.slugName(body.name));
  assert.equal(shown.pluginSuperseded, false, 'public artifact carries an explicit, not-undefined flag');
});
