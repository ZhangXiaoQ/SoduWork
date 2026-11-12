'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { project } = require('../main/conversation/history-message.cjs');

test('plain assistant history becomes a renderer block without modifying stored text', () => {
  const message = { id: 'answer', role: 'assistant', text: '<script>untrusted()</script>\nAnswer',
    done: false, sentAt: 123, position: 2 };
  const original = JSON.stringify(message), result = project(message);
  assert.equal(result.blocks[0].text, message.text);
  assert.equal(result.blocks[0].kind, 'text');
  assert.equal(result.blocks[0].done, false);
  assert.equal(result.sentAt, 123);
  assert.equal(result.position, 2);
  assert.equal(JSON.stringify(message), original);
  assert.equal(project(result), result);
});

test('structured thinking, tools and text retain their original block contract', () => {
  for (const kind of ['text', 'thinking', 'toolCall']) {
    const message = { role: 'assistant', text: 'Legacy summary', blocks: [{ kind, text: 'Original' }] };
    assert.equal(project(message), message);
  }
});

test('empty usage tails and user attachments do not acquire fabricated answer blocks', () => {
  for (const message of [null, { role: 'assistant', text: '' },
    { role: 'assistant', usage: { outputTokens: 5 } },
    { role: 'user', text: 'Question', attachments: [{ id: 'image' }] }]) {
    assert.equal(project(message), message);
  }
  assert.equal(project({ role: 'assistant', text: 'Answer', blocks: [] }).blocks[0].text, 'Answer');
});
