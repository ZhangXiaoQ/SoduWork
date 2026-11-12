'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { check, inspect, retained, forbidden } = require('../../tools/soduwork-brand-scan.cjs');

test('branding gate rejects unaudited content and paths', () => {
  const result = check();
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.errors, []);
});

test('a compatibility exception grants only its exact file and reviewed line', () => {
  const file = 'client/example.js';
  const text = `const legacySchema = '${forbidden[0]}-schema';`;
  const exception = {file, reason: 'Read only the audited historical schema', lines: [text]};
  assert.equal(retained(file, text, [exception]), true);
  assert.equal(retained('client/other.js', text, [exception]), false);
  assert.equal(retained(file, text + ' // another use', [exception]), false);
  assert.equal(retained(file, text, [{...exception, reason: ''}]), false);
  assert.equal(retained(file, text, [{...exception, file: 'client/*'}]), false);
  assert.equal(retained(file, text, [{...exception, lines: [forbidden[0]]}]), false);
});

test('public brand inspection rejects legacy content and path identifiers', () => {
  for (const token of forbidden) {
    const content = inspect('client/example.js', 'const value = "' + token + '";');
    assert.equal(content.count, 1);
    assert.equal(inspect('client/' + token + '.js', '').forbiddenPath, true);
  }
});
