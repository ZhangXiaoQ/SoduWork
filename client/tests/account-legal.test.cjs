'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/client-auth/account-ui.js'), 'utf8'), { window, Intl });
const select = window.AccountUI.legalSelection;
const cn = { key: 'terms', version: 'v2', locale: 'zh-CN', content: 'current original' };
const en = { key: 'terms', version: 'v2', locale: 'en-US', content: 'current translation' };

test('legal selection uses a published translation of the required revision', () => {
  assert.equal(select([cn, en], 'terms', 'en-US', 'v2').document, en);
  assert.equal(select([cn, en], 'terms', 'en-GB', 'v2').document, en);
  assert.equal(select([cn, en], 'terms', 'ja-JP', 'v2').document, cn);
});

test('a missing current translation never falls back to an obsolete legal revision', () => {
  const old = { ...en, version: 'v1' };
  const selected = select([cn, old], 'terms', 'en-US', 'v2');
  assert.equal(selected.document, cn);
  assert.equal(selected.rows.length, 1);
  assert.equal(select([old], 'terms', 'en-US', 'v2').document, undefined);
});

test('privacy and terms never substitute for each other', () => {
  assert.equal(select([cn, en], 'privacy', 'en-US', 'v2').document, undefined);
  assert.equal(select(null, 'privacy', 'zh-CN').document, undefined);
});

test('legacy documents remain readable without inventing a language or revision', () => {
  const legacy = { type: 'privacy', body: 'unaltered original' };
  assert.equal(select([legacy], 'privacy', 'ko-KR').document, legacy);
  assert.equal(legacy.locale, undefined);
  assert.equal(legacy.version, undefined);
});

test('Chinese scripts are not treated as interchangeable published translations', () => {
  const traditional = { ...en, locale: 'zh-TW' };
  assert.equal(select([traditional, cn], 'terms', 'zh-CN', 'v2').document, cn);
  assert.equal(select([cn, traditional], 'terms', 'zh-TW', 'v2').document, traditional);
});
