'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const LOCALES = path.join(ROOT, 'core', 'locales');
const manifest = JSON.parse(fs.readFileSync(path.join(LOCALES, 'manifest.json'), 'utf8'));

function loadI18n(locale) {
  const context = vm.createContext({
    console,
    window: null,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      documentElement: { dataset: {} }, readyState: 'complete', body: null,
      addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
  });
  context.window = context;
  for (const file of manifest) vm.runInContext(fs.readFileSync(path.join(LOCALES, file), 'utf8'), context, { filename: file });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'core', 'i18n-dom.js'), 'utf8'), context, { filename: 'i18n-dom.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'core', 'i18n.js'), 'utf8'), context, { filename: 'i18n.js' });
  context.SoduWorkI18n.setLocale(locale, { persist: false, broadcast: false, initial: true });
  return context.SoduWorkI18n;
}

const PHRASES = [
  ['count', '已选择 {count} 项', { count: 3 }],
  ['chat', '围绕内容开启对话'],
  ['migrate', '批量存储到远端'],
  ['share', '批量分享'],
  ['delete', '批量删除'],
  ['clear', '取消选择'],
];

test('资料库多选工具栏的操作文字全部通过资料库翻译桥接', () => {
  const source = fs.readFileSync(path.join(ROOT, 'components', 'panels', 'panels-library.js'), 'utf8');
  for (const [, phrase, params] of PHRASES) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(source, new RegExp(`tx\\('${escaped}'${params ? ', \\{ count: selectedCount \\}' : '\\)'}`), phrase);
    assert.doesNotMatch(source, new RegExp(`data-library-batch-[^>]+>${escaped}<`), `${phrase} must not remain hard-coded in toolbar markup`);
  }
});

test('资料库多选工具栏数量和操作在中英日韩语言下均可显示', () => {
  const expected = {
    'zh-CN': ['已选择 3 项', '围绕内容开启对话', '批量存储到远端', '批量分享', '批量删除', '取消选择'],
    'en-US': ['Selected 3 items', 'Chat about selected items', 'Save selected to remote', 'Share selected', 'Delete selected', 'Clear selection'],
    'ja-JP': ['3 件の資料を選択中', '選択した資料について会話する', '選択した資料をリモートに保存', '選択した資料を共有', '選択した資料を削除', '選択を解除'],
    'ko-KR': ['3개 자료 선택됨', '선택한 자료로 대화하기', '선택한 자료를 원격에 저장', '선택한 자료 공유', '선택한 자료 삭제', '선택 취소'],
  };
  for (const [locale, values] of Object.entries(expected)) {
    const i18n = loadI18n(locale);
    PHRASES.forEach(([, source, params], index) => {
      assert.equal(i18n.t('library.copy', source, params), values[index], `${locale}: ${source}`);
    });
  }
});


test('missing local file dialogs provide recovery guidance in every supported locale', () => {
  const title = '本地文件不存在';
  const message = '找不到这份资料的本地文件，可能已被删除或移动。请恢复文件后重试，或从原会话重新保存、重新上传到资料库。';
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    const api = loadI18n(locale);
    assert.notEqual(api.translateText(title), title, locale);
    assert.notEqual(api.translateText(message), message, locale);
  }
});

test('delivery version and integrity failures have copy in every supported locale', () => {
  const messages = ['成果已变化，请重新打开后保存', '成果正在收集，请稍后重试',
    '成果读取不完整，请重试', '成果已变化，请重新打开会话'];
  for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN']) {
    const api = loadI18n(locale);
    for (const message of messages) {
      if (locale === 'zh-CN') assert.equal(api.translateText(message), message);
      else assert.notEqual(api.translateText(message), message, `${locale}: ${message}`);
    }
    assert.equal(api.translateText('用户原文：成果已变化，请重新打开会话'), '用户原文：成果已变化，请重新打开会话');
  }
});

test('remote storage percentage and connected tooltip follow the selected locale', () => {
  const expected = {
    'zh-CN': '远程存储已连接 · 剩余 75%',
    'en-US': 'Remote storage connected · 75% remaining',
    'ja-JP': 'リモート保存に接続済み · 残り 75%',
    'ko-KR': '원격 저장에 연결됨 · 남은 공간 75%',
  };
  for (const [locale, tooltip] of Object.entries(expected)) {
    const api = loadI18n(locale);
    assert.equal(api.t('library.copy', '远程存储已连接 · 剩余 {percent}%', { percent: 75 }), tooltip);
  }
});
