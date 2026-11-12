'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const create = require('../main/conversation/native-transcript-pages.cjs').create;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-native-page-')), file = path.join(root, 'history.jsonl');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { file, read: create() };
}
const message = (id, text = '多语言 😀 ' + id) => JSON.stringify({ type: 'message', id: String(id), message: { role: 'user', content: text } });

test('native history uses persisted turn times through pagination, transport and completed summaries', async t => {
  const f = fixture(t), start = Date.parse('2026-11-09T01:00:00Z');
  const entries = [
    {type: 'message', id: 'user', timestamp: new Date(start + 2000).toISOString(),
      message: {role: 'user', content: 'request', timestamp: start + 1000, sentAt: start}},
    {type: 'message', id: 'answer', timestamp: new Date(start + 32000).toISOString(),
      message: {role: 'assistant', content: 'answer', timestamp: start + 1000, completedAt: start + 31000}},
    {type: 'message', id: 'legacy-user', message: {role: 'user', content: 'legacy request', timestamp: new Date(start + 60000).toISOString()}},
    {type: 'message', id: 'legacy-answer', timestamp: new Date(start + 81000).toISOString(),
      message: {role: 'assistant', content: 'legacy answer', timestamp: start + 61000}},
    {type: 'message', id: 'unknown-user', message: {role: 'user', content: 'old request', timestamp: start + 90000}},
    {type: 'message', id: 'unknown-answer', message: {role: 'assistant', content: 'old answer', timestamp: start + 91000}},
  ];
  const source = entries.map(value => JSON.stringify(value)).join('\n');
  fs.writeFileSync(f.file, source);
  const remote = require('../main/pi-session/local-history-remote.cjs').create({
    app: {}, session: {}, identityOf: async () => require('./helpers/platform-session-fixture.cjs').identity(),
    history: {resolve: async () => ({id: 'native-clock', revision: 1}),
      read: async (_, options) => {
        const page = await f.read(f.file, options);
        return {...page, nextCursor: page.nextOffset};
      }},
  });
  const items = [], cursors = [];
  let after = 0;
  do {
    const page = await remote({action: 'read', id: 'native-clock', after, limit: 2}, async () => {});
    items.push(...page.items); cursors.push(page.cursor); after = page.cursor;
    if (!page.hasMore) break;
  } while (true);
  assert.deepEqual(cursors, [2, 4, 6]);
  assert.deepEqual(items.map(row => row.id), entries.map(row => row.id));
  assert.deepEqual(items.map(row => row.createdAt), [start, start + 31000, start + 60000,
    start + 81000, start + 90000].map(value => new Date(value).toISOString()).concat(''));

  const messageTime = require('../main/conversation/message-time');
  const summary = require('../components/panels/chat-turn-summary');
  const project = () => summary.project({messages: entries.map(messageTime.storedMessage)}, new Set([1, 3, 5]));
  assert.deepEqual(project().map(turn => turn.elapsedMs), [31000, 21000, null]);
  t.mock.method(Date, 'now', () => start + 86400000);
  assert.deepEqual(project().map(turn => turn.elapsedMs), [31000, 21000, null]);
  assert.equal(fs.readFileSync(f.file, 'utf8'), source, 'reading never rewrites the archive');
});

test('native phone timestamps reject invalid receipt times without inventing a completion', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, [
    {type: 'message', id: 'invalid-user', message: {role: 'user', content: 'request', sentAt: -1, timestamp: 'invalid'}},
    {type: 'message', id: 'invalid-answer', timestamp: 'invalid',
      message: {role: 'assistant', content: 'answer', completedAt: 8640000000000001, timestamp: '2026-11-09T01:00:00Z'}},
  ].map(value => JSON.stringify(value)).join('\n'));
  assert.deepEqual((await f.read(f.file, {})).items.map(row => row.timestamp), ['', '']);
});
test('native history exposes visible user text without rewriting archive or pagination identity', async t => {
  const f = fixture(t), context = require('../main/pi-session/connector-context.cjs');
  const augmented = context.augment('next turn', 'Internal connector capability guide');
  const source = [message('one', augmented), JSON.stringify({type:'message', id:'two',
    message:{role:'user',content:[{type:'text',text:augmented}]}}),
    JSON.stringify({type:'message',id:'three',message:{role:'assistant',content:augmented}})].join('\n');
  fs.writeFileSync(f.file, source);
  const first = await f.read(f.file, {limit:1});
  assert.equal(first.items[0].id, 'one'); assert.equal(first.items[0].text, 'next turn');
  assert.equal(first.nextOffset, 1);
  const rest = await f.read(f.file, {offset:first.nextOffset,limit:10});
  assert.deepEqual(rest.items.map(row=>row.text), ['next turn', augmented]);
  assert.equal(rest.nextOffset, null);
  assert.equal(fs.readFileSync(f.file,'utf8'), source);
});
test('native pages preserve CRLF, multibyte text, metadata gaps and final unterminated lines', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, [message(1), '{}', message(2), '{bad', message(3)].join('\r\n'));
  const first = await f.read(f.file, { limit: 1 });
  assert.deepEqual(first.items.map(row => row.id), ['1']); assert.equal(first.nextOffset, 1);
  const next = await f.read(f.file, { offset: first.nextOffset, limit: 1 });
  assert.equal(next.items[0].text, '多语言 😀 2'); assert.equal(next.nextOffset, 2);
  const final = await f.read(f.file, { offset: next.nextOffset, limit: 1 });
  assert.equal(final.items[0].id, '3'); assert.equal(final.nextOffset, null);
  fs.writeFileSync(f.file, message('replacement'));
  assert.equal((await f.read(f.file, { limit: 1 })).items[0].id, 'replacement');
});
test('sequential pages use bounded byte checkpoints rather than repeated prefix scans', async t => {
  const f = fixture(t), rows = Array.from({ length: 10000 }, (_, i) => message(i, '文'.repeat(80) + i));
  fs.writeFileSync(f.file, rows.join('\n'));
  const starts = [], original = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', (file, options) => { starts.push(options.start); return original(file, options); });
  let after = 0, count = 0;
  do {
    const page = await f.read(f.file, { offset: after, limit: 100 });
    assert.equal(page.items[0].id, String(count)); count += page.items.length; after = page.nextOffset;
  } while (after != null);
  assert.equal(count, 10000); assert.equal(starts.length, 100);
  assert.ok(starts.slice(1).every((value, i) => value > starts[i]));
});
test('archive replacement during a page invalidates the result and preserves retry', async t => {
  const f = fixture(t); fs.writeFileSync(f.file, message(1));
  let changed = false;
  await assert.rejects(f.read(f.file, {}, () => {
    if (!changed) { changed = true; fs.writeFileSync(f.file, message('changed')); }
  }), /正在更新/);
  assert.equal((await f.read(f.file, {})).items[0].id, 'changed');
});
