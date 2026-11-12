const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname,
  '../components/panels/task-execution-stream.js'), 'utf8');
let rendered = 0;
const ChatTools = {
  phaseNarrative: () => '',
  render(tool) {
    rendered += 1;
    const command = String((tool.args || {}).command || '');
    return {
      summaryOnly: Boolean(command),
      title: command ? '运行了命令' : '执行操作',
      sub: command ? '' : tool.name,
      tip: '',
      body: '<pre>' + String(tool.result || '') + '</pre>',
    };
  },
};
const window = { ChatTools, ExecutionToolArgs: require('../components/shared/execution-tool-args'), addEventListener() {} };
const context = {
  window, ChatTools,
  esc: (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;'),
  setTimeout, clearTimeout, console,
};
vm.runInNewContext(source, context, { filename: 'task-execution-stream.js' });

const stream = window.TaskExecutionStream;
assert.ok(stream, 'should expose the shared task execution stream adapter');

const events = [
  { seq: 1, kind: 'out', tool: 'stderr', text: 'WARN plugin cache unavailable', at: '2026-08-24T12:00:01Z' },
  { seq: 2, kind: 'out', tool: 'stderr', text: 'WARN plugin cache unavailable', at: '2026-08-24T12:00:02Z' },
  { seq: 3, kind: 'step', text: '第 1 步 · 正在想…', at: '2026-08-24T12:00:03Z' },
  { seq: 4, kind: 'say', text: '短文', full: '开始检查项目结构。', at: '2026-08-24T12:00:04Z' },
  { seq: 5, kind: 'do', tool: 'bash', text: 'npm run test', at: '2026-08-24T12:00:05Z' },
  { seq: 6, kind: 'out', tool: 'bash', text: '38 assertions passed', at: '2026-08-24T12:00:06Z' },
];

const rows = stream.rows(events, 'done');
assert.equal(rows.filter((row) => row.type === 'diagnostics').length, 1,
  'consecutive runtime noise should collapse into one row');
assert.equal(rows[0].entries[0].count, 2, 'identical diagnostics should be deduplicated');
assert.equal(rows.find((row) => row.type === 'tool').result, '38 assertions passed',
  'tool output should attach to its preceding action');
assert.equal(rows.some((row) => row.type === 'step'), false,
  'thinking counters should not become permanent conversation messages');
assert.equal(stream.isThinkingStep({ text: '\u7b2c 1 \u6b65 \u00b7 \u6b63\u5728\u60f3\u2026' }), true);

const html = stream.rowsHtml(events, 'done');
assert.match(html, /运行环境信息/);
assert.match(html, /2 条底座消息，已自动收拢/);
assert.match(html, /开始检查项目结构。/, 'full assistant text should win over the clipped preview');
assert.match(html, /运行了命令/);
assert.match(html, /data-dks-node="tool-5"/);
assert.doesNotMatch(html, /npm run test|data-dks-tool="tool-5"/);
assert.doesNotMatch(html, /dks-step/);
assert.match(html, /class="ntool dks-tool/);
assert.ok(rendered > 0, 'task stream should reuse the shared conversation tool renderer');

const userRows = stream.rows([
  { seq: 7, kind: 'user', text: '\u8865\u5145\u4e00\u6761\u9a8c\u6536\u8981\u6c42', at: '2026-08-24T12:00:07Z' },
], 'running');
assert.equal(userRows[0].type, 'user', 'a follow-up becomes a canonical user turn');
assert.match(stream.rowsHtml([
  { seq: 7, kind: 'user', text: '\u8865\u5145\u4e00\u6761\u9a8c\u6536\u8981\u6c42' },
], 'running'), /class="nmsg user dks-message"[\s\S]*\u8865\u5145\u4e00\u6761\u9a8c\u6536\u8981\u6c42/,
  'persisted follow-ups render with the shared user message treatment');

const running = stream.rows([
  { seq: 9, kind: 'do', tool: 'command_execution', text: 'npm run build' },
], 'running');
assert.equal(running.find((row) => row.type === 'tool').model.state, 'running');
assert.equal(running.filter((row) => row.type === 'status').length, 1,
  'running work should expose one live status row instead of historical step counters');

const failedEmpty = stream.emptyState({ status: 'failed', error: 'Runner 启动失败' });
assert.equal(failedEmpty.title, 'Runner 启动失败',
  'a terminal empty session should show its durable failure reason');
assert.match(stream.blankHtml({ status: 'failed', error: 'Runner 启动失败' }),
  /is-failed[\s\S]*Runner 启动失败[\s\S]*需求全链路/,
  'failed empty history must not pretend it is still waiting for the runner');
assert.doesNotMatch(stream.blankHtml({ status: 'done' }), /正在等待执行机/,
  'a completed empty session is a terminal record, not a live loading state');

const repeatedNarration = stream.visibleItems([
  { seq: 20, kind: 'say', text: 'Browser acceptance in progress', round: 1 },
  { seq: 21, kind: 'do', tool: 'browser', text: 'open page', round: 1 },
  { seq: 22, kind: 'say', text: '  Browser   acceptance in progress ', round: 1 },
  { seq: 23, kind: 'user', text: 'check again', round: 2 },
  { seq: 24, kind: 'say', text: 'Browser acceptance in progress', round: 2 },
]);
assert.deepEqual(Array.from(repeatedNarration, (item) => item.seq), [20, 21, 23, 24],
  'identical narration should collapse only within the current work round');
assert.equal(repeatedNarration.filter((item) => item.kind === 'do').length, 1,
  'tool evidence between repeated narration must remain visible');
assert.equal(stream.visibleItems([
  { seq: 30, kind: 'do', tool: 'bash', text: 'npm test', sourceId: 'codex:event-1' },
  { seq: 31, kind: 'do', tool: 'bash', text: 'npm test', sourceId: 'codex:event-1' },
]).length, 1, 'the same provider event replay should be idempotent');
assert.equal(stream.visibleItems([
  { seq: 32, kind: 'do', tool: 'bash', text: 'npm test' },
  { seq: 33, kind: 'do', tool: 'bash', text: 'npm test' },
]).length, 2, 'two real tool calls without a shared source id must remain auditable');

console.log('task session stream: 25 assertions passed');

const test = require('node:test');
test('modern execution stream escapes untrusted user and assistant text and preserves round order', () => {
  const events = [
    {seq: 1, kind: 'user', text: '<img src=x onerror=alert(1)>'},
    {seq: 2, kind: 'say', text: '<script>first</script>'},
    {seq: 3, kind: 'user', text: 'Continue'},
    {seq: 4, kind: 'say', text: '<script>first</script>'},
  ];
  const html = stream.rowsHtml(events, 'done');
  assert.doesNotMatch(html, /<img src=x|<script>/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /&lt;script&gt;first&lt;\/script&gt;/);
  assert.equal((html.match(/&lt;script&gt;first/g) || []).length, 2);
  assert.ok(html.indexOf('&lt;img') < html.indexOf('&lt;script'));
  assert.ok(html.indexOf('Continue') > html.indexOf('&lt;script'));
});

test('native Pi thought deltas collapse into one reasoning block and usage creates no output card', () => {
  const events = [
    { seq: 1, round: 1, kind: 'thinking', streamId: 'pi:11:0', delta: true, done: false, text: 'Let' },
    { seq: 2, round: 1, kind: 'thinking', streamId: 'pi:11:0', delta: true, done: false, text: ' me understand' },
    { seq: 3, round: 1, kind: 'thinking', streamId: 'pi:11:0', delta: true, done: false, text: ' carefully' },
  ];
  let rows = stream.rows(events, 'running');
  assert.equal(rows.filter(row => row.type === 'thinking').length, 1);
  assert.equal(rows[0].item.text, 'Let me understand carefully');
  assert.match(stream.rowsHtml(events, 'running'), /nthink dks-thinking open is-live/);
  events.push({ seq: 4, round: 1, kind: 'thinking', streamId: 'pi:11:0', done: true,
    delta: false, text: 'Let me understand carefully' },
    { seq: 5, round: 1, kind: 'say', text: 'Completed the report.' },
    { seq: 6, round: 1, kind: 'usage', text: '', usageScope: 'message', usage: { input: 20, output: 10 } });
  rows = stream.rows(events, 'done');
  assert.deepEqual(Array.from(rows, row => row.type), ['thinking', 'say']);
  const html = stream.rowsHtml(events, 'done');
  assert.equal((html.match(/Let me understand carefully/g) || []).length, 1);
  assert.match(html, /深度思考/); assert.doesNotMatch(html, />输出<|is-live|ntool-name/);
  assert.match(html, /aria-expanded="false"/);
});

test('snapshot and delta reasoning stay scoped to round and segment, with no empty completion cards', () => {
  const events = [
    { seq: 1, round: 1, kind: 'thinking', streamId: 'r', text: 'one', done: false },
    { seq: 2, round: 1, kind: 'thinking', streamId: 'r', text: 'one two', done: false },
    { seq: 3, round: 1, kind: 'thinking', streamId: 'r', text: '', done: true, delta: true },
    { seq: 4, round: 2, kind: 'thinking', streamId: 'r', text: 'new', delta: true, done: false },
    { seq: 5, round: 2, kind: 'thinking', streamId: 'r', text: ' again', delta: true, done: false },
    { seq: 6, round: 2, kind: 'thinking', streamId: 'r', text: ' again', delta: true, done: false },
    { seq: 7, round: 2, kind: 'thinking', streamId: 'hidden', text: '', done: true },
    { seq: 8, round: 2, kind: 'out', text: '' },
  ];
  const rows = stream.rows(events, 'done');
  assert.deepEqual(Array.from(rows, row => row.item.text), ['one two', 'new again again']);
  assert.ok(rows.every(row => row.type === 'thinking' && row.done));
  assert.doesNotMatch(stream.rowsHtml(events, 'done'), /ntool|>输出</);
});

test('usage interleaved with a command does not split it or erase its real failure result', () => {
  const rows = stream.rows([
    { seq: 1, kind: 'do', tool: 'bash', callId: 'a', text: 'npm test' },
    { seq: 2, kind: 'usage', usageScope: 'step', usage: { input: 20, output: 10 } },
    { seq: 3, kind: 'out', tool: 'bash', callId: 'a', text: 'test failed', isError: true },
  ], 'done');
  assert.equal(rows.length, 1); assert.equal(rows[0].type, 'tool');
  assert.equal(rows[0].result, 'test failed');
});

test('restored task deltas preserve repeated tokens and whitespace in one paragraph', () => {
  const chunks = ['A', ' ', 'very', ' very', ' ', 'short', '\n\n', 'reply.'];
  const events = chunks.map((text, index) => ({ seq: index + 1, kind: 'say',
    streamId: 'answer', sourceId: 'provider-message', delta: true, text, round: 1, seg: 1 }));
  events.splice(4, 0, { ...events[3] }); // A repeated page boundary is not a new token.
  events.push({ seq: 9, kind: 'say', streamId: 'answer', delta: true, text: '', done: true });
  const before = JSON.stringify(events);
  const rows = stream.rows(events, 'done').filter(row => row.type === 'say');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item.text, chunks.join(''));
  assert.equal(JSON.stringify(events), before, 'rendering never rewrites archived events');
  assert.equal((stream.rowsHtml(events, 'done').match(/dks-message/g) || []).length, 1);
});

test('restored reply snapshots replace deltas without merging tools or later rounds', () => {
  const events = [
    { seq: 1, kind: 'say', streamId: 'answer', delta: true, text: 'First', round: 1 },
    { seq: 2, kind: 'say', streamId: 'answer', delta: true, text: ' preview', full: 'First answer', round: 1 },
    { seq: 3, kind: 'say', streamId: 'answer', text: '', done: true, round: 1 },
    { seq: 4, kind: 'do', tool: 'read', text: 'file', round: 1 },
    { seq: 5, kind: 'out', tool: 'read', text: 'file contents', round: 1 },
    { seq: 6, kind: 'say', streamId: 'after-tool', text: 'Second answer', done: true, round: 1 },
    { seq: 7, kind: 'user', text: 'Revise', round: 2 },
    { seq: 8, kind: 'say', streamId: 'answer', delta: true, text: 'New answer', round: 2 },
    { seq: 9, kind: 'say', streamId: 'answer', delta: true, text: 'New segment', round: 2, seg: 2 },
    { seq: 10, kind: 'user', text: 'Legacy follow-up' },
    { seq: 11, kind: 'say', delta: true, text: 'Legacy' },
    { seq: 12, kind: 'say', delta: true, text: ' reply' },
    { seq: 13, kind: 'user', text: 'Another follow-up' },
    { seq: 14, kind: 'say', delta: true, text: 'Separate reply' },
  ];
  const rows = stream.rows(events, 'done');
  assert.deepEqual(Array.from(rows, row => row.type),
    ['say', 'tool', 'say', 'user', 'say', 'say', 'user', 'say', 'user', 'say']);
  assert.deepEqual(Array.from(rows.filter(row => row.type === 'say'), row => row.item.text),
    ['First answer', 'Second answer', 'New answer', 'New segment', 'Legacy reply', 'Separate reply']);
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length);
});

test('ten thousand restored deltas keep one stable row across repeated projections', () => {
  const events = Array.from({length:10000}, (_, index) => ({seq:index + 1,
    kind:'say', streamId:'answer', delta:true, text:index % 2 ? ' ' : 'token'}));
  const first = stream.rows(events.slice(0, 250), 'running').find(row => row.type === 'say');
  for (let iteration = 0; iteration < 10; iteration++) {
    const rows = stream.rows(events, 'done');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, first.key);
    assert.equal(rows[0].item.text, 'token '.repeat(5000));
  }
});
