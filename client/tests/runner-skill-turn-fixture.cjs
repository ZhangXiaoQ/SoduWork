'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const catalog = require('../main/agent-runtime/runtime-catalog');
const rules = require('../main/access-control/policy');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Skill parsing is request-local. Reuse one real worker per test module while
// keeping every conversation, workspace and skill directory independent.
const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runner-skills-suite-'));
const app = { getPath: () => suiteRoot };
test.after(async t => {
  const runtime = require('../main/agent-runtime/process-session');
  try { await runtime.reset(app); }
  catch (error) {
    t.diagnostic(JSON.stringify({ cleanup: error.message, report: error.report,
      errors: Array.from(error.errors || [], item => ({ message: item.message, code: item.code })) }));
    throw error;
  }
  assert.deepEqual(runtime.maintenanceWorkloads(), [], 'the owned parsing worker must be fully reclaimed');
  fs.rmSync(suiteRoot, { recursive: true, force: true });
});
// Use the Windows native CI job's 180-second timeout instead of a shorter local override.
const turnTimeout = process.platform === 'win32' ? 180000 : 15000;
async function until(check) { for (let i = 0; i < 500; i++) { if (check()) return; await delay(10); } throw Error('fixture timeout'); }
async function fixture(t, spec, overrides = {}) {
  const root = fs.mkdtempSync(path.join(suiteRoot, 'case-'));
  const calls = [], events = [], resolutions = [];
  const cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd);
  function skill(name, directory = name) {
    const dir = path.join(root, directory); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: >-\n  Trusted ${name}\n  multiline description\n---\nRead the trusted guide.\n`);
    return { name, path: dir, installed: true };
  }
  const base = skill('base'), added = skill('added'), refreshed = skill('base', 'updated-base');
  const ref = 'skill-turn-' + spec.id + '-' + path.basename(root);
  const id = _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', 'chat:' + ref + ':' + spec.id);
  let held, released = false, round = 0, deny = false, preparing;
  let entered;
  const heldReady = new Promise(resolve => { entered = resolve; });
  const runtime = { async rpc(op, payload) {
    calls.push({ op, payload });
    if (op === 'runtime.detect') return { ok: true, data: { accessControl: {
      schema: 'soduwork.access-policy/v1', supported: true, modes: ['standard', 'full', 'readonly'], canChangeDuringSession: true,
    } } };
    if (op === 'job.dispatch' || op === 'job.comment') {
      round++; events.push({ seq: events.length + 1, kind: 'user', text: op === 'job.dispatch' ? payload.ctx.conversationUserText : payload.text });
      return { ok: true, data: { ok: true, ref: id } };
    }
    if (op === 'job.stop') return { ok: true, data: { ok: true } };
    if (op === 'job.session') {
      if (!released && round === 1) await new Promise(resolve => { held = resolve; entered(); });
      if (events.at(-1)?.kind === 'user') events.push({ seq: events.length + 1, kind: 'say', text: 'Completed turn ' + round });
      return { ok: true, data: { ok: true, status: 'done', round, items: events.filter(row => row.seq > payload.since) } };
    }
    throw Error(op);
  } };
  const model = { id: 'fixture', baseUrl: 'http://fixture.invalid', key: 'synthetic' };
  const adapter = createRunnerRuntimeAdapter({ app, runtimeSpec: spec, runnerRuntime: runtime,
    modelConfig: { fetchModel: async () => ({ ok: true, model }) } });
  const session = await adapter.createSession({ identity: {}, native: { runner: { openOptions: {
    app, cwd, ref, skillDirs: [base.path], capabilityIds: [], accessPolicy: rules.create('standard', cwd),
    resolveSkills: async names => { resolutions.push(names.slice());
      if (overrides.holdPrepare) await new Promise(resolve => { preparing = resolve; });
      if (deny) throw Error('技能已撤回');
      return { items: names.map(name => name === 'added' ? added : name === 'base' ? refreshed : null).filter(Boolean) }; },
  } } } });
  const handle = getRunnerSessionDetails(session).handle;
  t.after(async () => { released = true; held?.(); preparing?.(); await session.dispose();
    await delay(10); fs.rmSync(root, { recursive: true, force: true }); });
  assert.deepEqual(handle.snapshot().messages, [], 'each case starts with an independent conversation');
  return { root, cwd, base, added, refreshed, session, handle, calls, resolutions,
    get held() { return Boolean(held); }, get preparing() { return Boolean(preparing); },
    waitHeld(first) { return Promise.race([heldReady, first.completion.then(result => {
      throw new Error('Runner completed before reaching the held turn: ' + JSON.stringify(result));
    })]); },
    release() { released = true; held?.(); }, releasePrepare() { preparing?.(); }, revoke() { deny = true; }, allow() { deny = false; } };
}

function registerSkillTurns(specs) {
for (const spec of specs) {
  test(spec.id + ': first/queued skills use trusted resources only at the turn boundary and expire next turn', { timeout: turnTimeout }, async t => {
    const f = await fixture(t, spec);
    const first = f.handle.submit('#added first', [], { skills: ['added'], skillDirs: ['C:/untrusted'], instructions: 'MALICIOUS' });
    await f.waitHeld(first);
    const firstPayload = f.calls.find(row => row.op === 'job.dispatch').payload;
    assert.deepEqual(firstPayload.ctx.skills.map(row => row.name), ['base', 'added']);
    assert.equal(firstPayload.ctx.skills[1].path, f.added.path);
    assert.equal(firstPayload.ctx.skills[1].description, 'Trusted added multiline description');
    assert.match(firstPayload.task.note, /SKILL\.md/); assert.match(firstPayload.task.note, /本轮明确选用/);
    assert.doesNotMatch(JSON.stringify(firstPayload), /MALICIOUS|C:\/untrusted/);
    const selection = ['base'], queued = f.handle.submit('#base replace base for this turn', [], { skills: selection });
    selection[0] = 'changed'; assert.equal(queued.queued, true);
    assert.deepEqual(f.resolutions, [['added']]);
    assert.equal(firstPayload.ctx.skills[0].path, f.base.path, 'active turn remains unchanged');
    f.release(); assert.equal((await first.completion).ok, true); assert.equal((await queued.completion).ok, true);
    await until(() => !f.handle.inFlight());
    const next = f.calls.find(row => row.op === 'job.comment').payload;
    assert.deepEqual(next.cfg.skillSelection.map(row => row.name), ['base']);
    assert.equal(next.cfg.skillSelection[0].path, f.refreshed.path, 'same-name selection replaces rather than duplicates metadata');
    assert.equal(next.cfg.accessPolicy.mode, 'standard');
    assert.equal((await f.handle.submit('plain follow-up', []).completion).ok, true);
    const final = f.calls.filter(row => row.op === 'job.comment').at(-1).payload;
    assert.deepEqual(final.cfg.skillSelection.map(row => row.path), [f.base.path]);
    assert.doesNotMatch(final.promptText, /本轮明确选用/);
    assert.deepEqual(f.resolutions, [['added'], ['base']]);
    assert.deepEqual(f.handle.snapshot().messages.filter(row => row.role === 'user').map(row => row.text),
      ['#added first', '#base replace base for this turn', 'plain follow-up']);
  });
  test(spec.id + ': revocation while queued fails explicitly without RPC and preserves the later queue', { timeout: turnTimeout }, async t => {
    const f = await fixture(t, spec), first = f.handle.submit('first', []);
    await f.waitHeld(first);
    const denied = f.handle.submit('#added queued', [], { skills: ['added'] });
    const file = path.join(f.cwd, 'retained.txt'); fs.writeFileSync(file, 'retained');
    const later = f.handle.submit('keep later', [{ path: file, name: 'retained.txt' }]);
    assert.equal(f.resolutions.length, 0); f.revoke(); f.release(); await first.completion;
    const result = await denied.completion;
    assert.equal(result.ok, false); assert.equal(result.failureKind, 'skill-selection'); assert.equal(result.retrySafe, true);
    assert.equal(f.calls.filter(row => row.op === 'job.comment').length, 0);
    assert.equal(f.handle.snapshot().messages.some(row => row.text === '#added queued'), false);
    const snap = f.handle.snapshot(); assert.equal(snap.execution.turnQueue.paused, true);
    assert.deepEqual(snap.execution.queue.map(row => ({ id: row.id, text: row.text, files: row.attachments })),
      [{ id: later.queueId, text: 'keep later', files: ['retained.txt'] }]);
    f.allow();
    const retried = f.handle.submit('#added queued', [], { skills: ['added'] });
    assert.equal(retried.queued, false, 'explicit resubmission is not trapped behind the paused queue');
    assert.equal((await retried.completion).ok, true); assert.equal((await later.completion).ok, true);
    assert.deepEqual(f.calls.filter(row => row.op === 'job.comment').map(row => row.payload.text), ['#added queued', 'keep later']);
    assert.equal(f.calls.filter(row => row.op === 'job.comment')[1].payload.localFiles[0].path, file);
  });
}

}

function registerSkillStop() {
test('stopping a Runner while skill authorization is pending never dispatches the cancelled content', async t => {
  const f = await fixture(t, catalog.runtime('opencode'), { holdPrepare: true });
  const sent = f.handle.submit('#added pending', [], { skills: ['added'] });
  await until(() => f.preparing); f.handle.cancel(); f.releasePrepare();
  assert.equal((await sent.completion).cancelled, true);
  assert.equal(f.calls.filter(row => ['job.comment', 'job.dispatch'].includes(row.op)).length, 0);
});
}

module.exports = { registerSkillTurns, registerSkillStop };
