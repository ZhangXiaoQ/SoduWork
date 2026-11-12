'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { create } = require('../main/pi-session/session-handle');
const history = require('../main/pi-session/history-state');
const { openReply } = require('../main/pi-session/open-reply');
const titles = require('../main/conversation/titles');

function handle(id, ephemeral) {
  const ctx = { ref: id, opts: { ephemeral }, taskBinding: { taskIds: [], taskBindings: [] }, goal: {},
    shared: { _messageTitle: history.messageTitle, _presenceState: history.presenceState,
      snapshotWindow: require('../main/pi-session/snapshot-window') },
    piSession: { sessionId: id }, prep: { model: {} },
    acc: { state: { messages: [], tools: [] } },
    updatedAt: 100, turnQueue: { size: () => 0 }, effectiveCwd: 'node-workspace',
    _snapshot: () => ({ status: 'streaming', messages: [{ role: 'user', text: 'Run the workflow' }] }),
  };
  ctx.handle = create(ctx);
  return { ctx, handle: ctx.handle };
}

test('an active ephemeral Pi child never becomes a sidebar conversation or presence row', () => {
  const parent = handle('parent', false), child = handle('workflow-pi:node', true);
  child.ctx.inFlight = true;
  child.ctx._snapshot = () => { throw Error('private child transcript must not be read for history'); };
  assert.equal(child.handle.historyRow(), null);
  assert.equal(child.handle.historyRow({ status: 'streaming', messages: [{ role: 'user', text: 'child input' }] }), null);
  const disk = [{ id: 'parent', title: 'Run the workflow', path: 'parent.jsonl', at: 50, count: 1 }];
  const rows = history.mergeHistory(disk, [parent.handle, child.handle]);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, 'parent'); assert.equal(rows[0].path, 'parent.jsonl');
  child.ctx.inFlight = false;
  assert.deepEqual(history.mergeHistory(disk, [parent.handle, child.handle]), rows);
});

test('normal newly opened Pi conversations still appear in live history without an archive row', () => {
  for (const ephemeral of [false, undefined]) {
    const { handle: visible } = handle('normal', ephemeral);
    const rows = history.mergeHistory([], [visible]);
    assert.equal(rows.length, 1); assert.equal(rows[0].title, 'Run the workflow');
    assert.equal(rows[0].id, 'normal'); assert.equal(rows[0].live, true);
  }
});


test('an unsent task review title does not create a phantom history entry', () => {
  const f = handle('review-draft', false);
  f.ctx.taskTitle = 'Requirement with the same title';
  f.handle.taskRef = 'requirement';
  f.ctx._snapshot = () => ({ status: 'idle', messages: [] });
  assert.equal(f.handle.historyRow(), null);
  assert.deepEqual(history.mergeHistory([], [f.handle]), []);
  assert.equal(f.handle.historyRow({ status: 'idle', messages: [{ role: 'user', text: 'Review this delivery' }] }).id, 'review-draft');
});

test('unsent composer titles and saved renames remain visible without publishing history rows', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-draft-title-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const app = {getPath: () => root};
  for (const assigned of [false, true]) {
    const f = handle('draft-' + assigned, false);
    f.ctx.displayTitle = assigned ? 'Assigned report' : 'Project workspace';
    if (assigned) { f.ctx.taskTitle = 'Assigned report'; f.handle.taskRef = 'requirement'; }
    f.ctx._snapshot = () => ({status: 'idle', messages: []});
    assert.equal(f.handle.historyRow(), null);
    assert.equal(openReply(app, f.handle).title, f.ctx.displayTitle);
    assert.deepEqual(history.mergeHistory([], [f.handle]), []);
    f.ctx.displayTitle = 'Updated live title';
    assert.equal(openReply(app, f.handle).title, 'Updated live title');
    titles.save(app, f.handle.sessionId, 'My chosen name');
    assert.equal(openReply(app, f.handle).title, 'My chosen name');
    assert.deepEqual(history.mergeHistory([], [f.handle]), []);
    f.ctx._snapshot = () => ({status: 'idle', messages: [{role: 'user', text: 'Submit this request'}]});
    assert.equal(history.mergeHistory([], [f.handle]).length, 1);
    assert.equal(openReply(app, f.handle).title, 'My chosen name');
  }
});
