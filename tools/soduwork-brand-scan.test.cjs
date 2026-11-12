'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { retained } = require('./soduwork-brand-scan.cjs');
test('reviewed compatibility permits only exact source lines in the named file', () => {
  const exceptions = [{file: 'source.js', reason: 'Persisted protocol', lines: ['oldProtocol()']}];
  assert.equal(retained('source.js', 'oldProtocol()', exceptions), true);
  assert.equal(retained('other.js', 'oldProtocol()', exceptions), false);
  assert.equal(retained('source.js', 'oldProtocol();newCall()', exceptions), false);
  assert.equal(retained('source.js', 'oldProtocol()', [{...exceptions[0], reason: ''}]), false);
});
