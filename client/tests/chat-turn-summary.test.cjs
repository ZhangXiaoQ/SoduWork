'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const summary = require('../components/panels/chat-turn-summary');
const user = (sentAt = 1000) => ({ role: 'user', sentAt, text: 'Request' });
const reply = (text, completedAt = 5000) => ({ role: 'assistant', done: true, completedAt,
  blocks: [{ kind: 'text', text, done: true }] });

test('completed turn summaries preserve absolute ownership and independent round statistics', () => {
  const snap = { messages: [user(), reply('Progress'), reply('Answer'), user(9000), reply('Second', 12000)], tools: [],
    history: { messageIndices: [10, 11, 13, 14, 15] },
    turnMetrics: [{ fromMessage: 10, toMessage: 13, elapsedMs: 4000, tokens: 123 },
      { fromMessage: 14, toMessage: 15, elapsedMs: 3000, tokens: 456 }] };
  const turns = summary.project(snap, new Set([2, 4]));
  assert.deepEqual(turns.map(t => [t.key, t.from, t.to, t.finalIndex, t.tokens, t.elapsedMs]),
    [['reply:13', 0, 2, 2, 123, 4000], ['reply:15', 3, 4, 4, 456, 3000]]);
  const truncated = { ...snap, messages: snap.messages.slice(1, 3), history: { messageIndices: [11, 13] } };
  assert.equal(summary.project(truncated, new Set([1]))[0].key, 'reply:13');
});

test('running tools and unfinished final messages cannot collapse their turn', () => {
  const snap = { messages: [user(), reply('Done')], tools: [{ after: 1, state: 'running' }] };
  assert.equal(summary.project(snap, new Set([1])).length, 0);
  snap.tools = []; snap.messages[1].done = false;
  assert.equal(summary.project(snap, new Set([1])).length, 0);
  assert.equal(summary.project(snap, new Set()).length, 0);
});

test('historical unknown usage is never borrowed from the latest snapshot or estimated as actual', () => {
  const snap = { messages: [user(), reply('Answer')], tools: [], usage: { output: 9999 }, execution: { elapsedMs: 999999 } };
  const [turn] = summary.project(snap, new Set([1]));
  assert.equal(turn.tokens, 2);
  assert.equal(turn.tokensEstimated, true, 'visible text is an estimate, never the session total');
  assert.equal(turn.elapsedMs, 4000);
  assert.equal(turn.wallTime, true);
  delete snap.messages[0].sentAt;
  assert.equal(summary.project(snap, new Set([1]))[0].elapsedMs, null);
});

test('merged continuation keeps only text after its last tool call as the final answer', () => {
  const final = reply('');
  final.blocks = [{ kind: 'thinking', text: 'Thought' }, { kind: 'text', text: 'Earlier plan' },
    { kind: 'toolcall', toolCall: { id: 't' } }, { kind: 'thinking', text: 'Check' },
    { kind: 'text', text: 'Final summary' }, { kind: 'text', text: 'Validation' }];
  const [turn] = summary.project({ messages: [user(), final], tools: [] }, new Set([1]));
  assert.equal(turn.lastToolBlock, 2);
  assert.equal(turn.finalIndex, 1);
});

test('completed current turn uses fixed receipts instead of a still-growing execution clock', () => {
  const view = summary.create({ esc: String });
  const html = view.html({ key: 'reply:2', tokens: 17, elapsedMs: 4000 },
    '<div class="nturn-metrics"><span class="nstatus-metric"><span data-thinking-label>已处理</span> ' +
    '<b data-thinking-elapsed>3s</b></span><span class="nstatus-divider">·</span>' +
    '<span class="nstatus-metric" title="usage"><span data-thinking-estimate aria-label="estimate">≈</span>' +
    '<b data-thinking-tokens>7</b><em>tokens</em></span></div>');
  assert.doesNotMatch(html, /data-thinking-tokens/);
  assert.doesNotMatch(html, /tokens/);
  assert.match(html, /data-thinking-elapsed>4s<\/b>/);
  assert.doesNotMatch(html, /≈/);
  const reopened = view.html({ key: 'reply:2', tokens: 17, elapsedMs: 4000 },
    '<div class="nturn-metrics"><b data-thinking-elapsed>5m 03s</b></div>');
  assert.match(reopened, /data-thinking-elapsed>4s<\/b>/);
  const unknown = view.html({ key: 'reply:3', tokens: null, elapsedMs: null },
    '<div class="nturn-metrics"><b data-thinking-elapsed>0s</b></div>');
  assert.match(unknown, /data-thinking-elapsed>未记录<\/b>/);
  assert.doesNotMatch(unknown, /0s|—/);
});

test('missing historical timing has a localized explanation without borrowing a live counter', t => {
  const previous = global.SoduWorkI18n;
  t.after(() => { global.SoduWorkI18n = previous; });
  global.SoduWorkI18n = {translateText: text => ({'未记录': 'Not recorded', '用时': 'Duration'}[text] || text)};
  const view = summary.create({esc: String});
  const turn = summary.project({messages: [user(), {...reply('Old reply'), completedAt: 0}],
    execution: {elapsedMs: 900000}}, new Set([1]))[0];
  assert.equal(turn.elapsedMs, null);
  const html = view.html(turn);
  assert.match(html, /Duration Not recorded/);
  assert.doesNotMatch(html, /900|15m|未记录|—/);
});


test('latest cloud summary uses remote completion receipts without changing earlier turns', () => {
  const snap = { messages: [user(), reply('Earlier'), user(9000), reply('Cloud', 12000)],
    execution: { cloud:true, running:false, completedAt:95000, elapsedMs:85000 } };
  let turns = summary.project(snap, new Set([1,3]));
  assert.equal(turns[0].elapsedMs, 4000);
  assert.equal(turns[1].elapsedMs, 85000);
  snap.execution.completedAt = 0;
  turns = summary.project(snap, new Set([1,3]));
  assert.equal(turns[1].elapsedMs, null, 'replay arrival times cannot replace missing remote receipts');
  snap.execution.running = true;
  snap.execution.completedAt = 95000;
  assert.equal(summary.project(snap, new Set([3]))[0].elapsedMs, null);
});

test('legacy native turns retain their own actual usage without a turn-metrics receipt', () => {
  const first = reply('First'); first.usage = { output: 17 };
  const second = reply('Second'); second.usage = { input_tokens: 90, output_tokens: 31 };
  const snap = { messages: [user(), first, user(), second], usage: { output: 9000 } };
  const turns = summary.project(snap, new Set([1, 3]));
  assert.deepEqual(turns.map(row => [row.tokens, row.tokensEstimated]), [[17, false], [31, false]]);
  assert.equal(first.usage.output, 17, 'display aggregation never rewrites provider usage');
});

test('missing native usage estimates the turn text and thinking and reconciles a later receipt', () => {
  const thought = reply(''); thought.blocks = [{ kind: 'thinking', text: '先确认范围' }];
  const answer = reply('完成');
  const snap = { messages: [user(), thought, answer], usage: { output: 9000 } };
  let [turn] = summary.project(snap, new Set([2]));
  assert.equal(turn.tokens, 7);
  assert.equal(turn.tokensEstimated, true);
  const view = summary.create({ esc: String });
  assert.doesNotMatch(view.html(turn, ''), /tokens/);
  assert.doesNotMatch(view.html(turn, '<div><b data-thinking-tokens>—</b> tokens</div>'), /tokens/);
  snap.turnMetrics = [{ fromMessage: 0, toMessage: 2, tokens: 53, elapsedMs: 4000 }];
  [turn] = summary.project(snap, new Set([2]));
  assert.equal(turn.tokens, 53); assert.equal(turn.tokensEstimated, false);
  assert.doesNotMatch(view.html(turn, ''), /≈/);
  assert.equal(answer.usage, undefined, 'an estimate is never persisted as provider usage');
});

test('partial visible history is estimated while explicit zero usage and empty output stay distinct', () => {
  const raw = reply('Visible'); raw.usage = { output_tokens: 5 };
  const clipped = { messages: [raw], history: { messageIndices: [12], truncated: true } };
  assert.equal(summary.project(clipped, new Set([0]))[0].tokensEstimated, true);
  const zero = reply('Text'); zero.usage = { output_tokens: 0 };
  const [known] = summary.project({ messages: [user(), zero] }, new Set([1]));
  assert.equal(known.tokens, 0); assert.equal(known.tokensEstimated, false);
  const [empty] = summary.project({ messages: [user(), reply('')] }, new Set([1]));
  assert.equal(empty.tokens, null); assert.equal(empty.tokensEstimated, false);
  const [partial] = summary.project({ messages: [user(), reply(''), zero] }, new Set([2]));
  assert.equal(partial.tokens, 0); assert.equal(partial.tokensEstimated, true, 'a missing segment cannot become an authoritative total');
});
