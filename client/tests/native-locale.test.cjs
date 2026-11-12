const test = require('node:test');
const assert = require('node:assert/strict');
const locale = require('../main/native-locale.cjs');

test('catalog composition preserves package order, source dictionaries and prototype-like translation keys', () => {
  const packs = {
    'en-US-first.js': Object.freeze({ collision: 'First', retained: 'Retained' }),
    'builtin-fixture.js': Object.freeze({
      'en-US': Object.freeze({ collision: 'Builtin', builtinOnly: 'Builtin only' }),
      'ja-JP': Object.freeze({ collision: 'Builtin Japanese', japaneseOnly: 'Japanese only' }),
    }),
    'en-US-last.js': Object.freeze(JSON.parse('{"collision":"Last","__proto__":"Own proto","constructor":"Own constructor"}')),
    'ja-JP-last.js': Object.freeze({ collision: 'Last Japanese' }),
  };
  const before = JSON.stringify(packs), module = { exports: {} };
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../main/native-locale.cjs'), 'utf8'), {
    module,
    require(name) {
      if (name.endsWith('/manifest.json')) return Object.keys(packs);
      if (name.endsWith('/locale-registry.js')) return { defaultLocale: 'en-US', locales: { 'en-US': {}, 'ja-JP': {} } };
      const pack = packs[name.replace('../core/locales/', '')];
      assert.ok(pack, name); return pack;
    },
  });
  const composed = module.exports;
  assert.equal(composed.translate('collision'), 'Last');
  assert.equal(composed.translate('retained'), 'Retained');
  assert.equal(composed.translate('builtinOnly'), 'Builtin only');
  assert.equal(composed.translate('__proto__'), 'Own proto');
  assert.equal(composed.translate('constructor'), 'Own constructor');
  assert.equal(composed.translate('toString'), 'toString');
  composed.setLocale('ja-JP');
  assert.equal(composed.translate('collision'), 'Last Japanese');
  assert.equal(composed.translate('japaneseOnly'), 'Japanese only');
  assert.equal(composed.translate('retained'), 'Retained');
  assert.equal(JSON.stringify(packs), before);
});

test('native dialog translation preserves file paths, filter extensions and source options', () => {
  const original = { title: '下载附件', defaultPath: 'D:/保存/文件.txt', buttons: ['取消', '保存'],
    filters: [{ name: 'SoduWork 插件', extensions: ['soduwork-plugin', 'zip'] }], properties: ['openFile'] };
  locale.setLocale('en-US');
  const options = locale.dialogOptions(original);
  assert.equal(options.title, 'Download attachment');
  assert.deepEqual(options.buttons, ['Cancel', 'Save']);
  assert.equal(options.filters[0].name, 'SoduWork plugin');
  assert.equal(options.defaultPath, original.defaultPath);
  assert.deepEqual(options.filters[0].extensions, original.filters[0].extensions);
  assert.equal(original.title, '下载附件');
  assert.equal(original.filters[0].name, 'SoduWork 插件');
  locale.setLocale('zh-CN');
  assert.deepEqual(locale.dialogOptions(original), original);
});

test('native dialog copy localizes complete actions without translating inserted chat names', () => {
  locale.setLocale('en-US');
  assert.equal(locale.translate('删除“保存  和 删除”？'), 'Delete “保存  和 删除”?');
  assert.equal(locale.translate('停止「删除」？'), 'Stop “删除”?');
  assert.equal(locale.translate('这是发布说明：保存与删除的实现'), '这是发布说明：保存与删除的实现');
  assert.equal(locale.translate('SoduWork 已准备好更新\n这是发布说明'), 'SoduWork is ready to update\n这是发布说明');
  assert.equal(locale.translate('例如：保存\n还有 5 项工作没有结束'), 'For example: 保存\nWork still in progress: 5');
  locale.setLocale('zh-CN');
  assert.equal(locale.translate('删除“保存”？'), '删除“保存”？');
});

test('native windows accept the additional locale packs and use translated copy', () => {
  locale.setLocale('ja');
  assert.equal(locale.getLocale(), 'ja-JP');
  assert.equal(locale.translate('设置'), '設定');
  assert.equal(locale.translate('模型服务'), 'モデルサービス');
  locale.setLocale('ko-KR');
  assert.equal(locale.getLocale(), 'ko-KR');
  assert.equal(locale.translate('设置'), '설정');
  locale.setLocale('zh-CN');
});

test('account deletion confirmation and retry guidance use the selected native locale', () => {
  const detail = '该会话将从当前账号的会话列表中删除，其他设备也会同步；需求和成果文件不会删除。';
  const failure = '删除没有完成。账号会话已归档，请在归档会话中重试。';
  const source = '账号或服务已切换，请重新打开会话';
  const reason = 'EBUSY: D:/work/保存.jsonl';
  for (const id of ['en-US', 'ja-JP', 'ko-KR']) {
    const catalog = require('../core/locales/' + (id === 'en-US' ? 'en-US-native' : id) + '.js');
    locale.setLocale(id);
    assert.equal(locale.dialogOptions({ detail }).detail, catalog[detail], id);
    assert.equal(locale.translate(failure), catalog[failure], id);
    assert.equal(locale.translate(source), catalog[source], id);
    assert.equal(locale.translate(failure + '\n' + reason), catalog[failure] + '\n' + reason, id);
  }
  locale.setLocale('zh-CN');
  assert.equal(locale.translate(failure), failure);
});

test('missing conversation deletion distinguishes account sync from local cleanup in every native locale', () => {
  const details = [
    '未找到这条会话的本地内容。永久删除会清除残留的会话记录，并同步到当前账号；已生成的文件不受影响。',
    '未找到这条会话的本地内容。永久删除会清除本机列表中的残留记录；已生成的文件不受影响。',
  ];
  const titles = { 'en-US': 'Permanently delete conversation', 'ja-JP': 'チャットを完全に削除', 'ko-KR': '대화 영구 삭제' };
  const buttons = { 'en-US': ['Cancel', 'Delete permanently'], 'ja-JP': ['キャンセル', '完全削除'], 'ko-KR': ['취소', '영구 삭제'] };
  for (const id of Object.keys(titles)) {
    locale.setLocale(id);
    const catalog = require('../core/locales/' + (id === 'en-US' ? 'en-US-native' : id) + '.js');
    for (const detail of details) {
      const original = { title: '永久删除会话', detail, buttons: ['取消', '永久删除'] };
      const translated = locale.dialogOptions(original);
      assert.equal(translated.title, titles[id], id);
      assert.equal(translated.detail, catalog[detail], id);
      assert.ok(translated.detail && translated.detail !== detail, 'the selected language must have a complete explanation');
      assert.deepEqual(translated.buttons, buttons[id], id);
      assert.equal(original.detail, detail, 'translation preserves the source confirmation');
    }
    assert.notEqual(locale.translate(details[0]), locale.translate(details[1]), 'account and local-only consequences stay distinct');
  }
  locale.setLocale('zh-CN');
  for (const detail of details) assert.equal(locale.translate(detail), detail);
});

test('missing conversation cleanup errors localize retry guidance in every native locale', () => {
  const messages = [
    '暂时无法核对会话内容，请稍后重试',
    '会话状态已变化，请刷新列表后重新删除',
    '会话切换记录已变化，请重新打开会话',
    '会话内容仍然存在，请重新打开后删除',
    '会话已删除，但侧栏记录未能保存，请重新点击删除清理',
    'Runner 会话目录响应无效',
    '清理会话记录失败，请重试',
  ];
  try {
    for (const id of ['en-US', 'ja-JP', 'ko-KR']) {
      const file = require.resolve('../core/locales/' + (id === 'en-US' ? 'en-US-native' : id) + '.js');
      const catalog = require(file), source = require('node:fs').readFileSync(file, 'utf8');
      locale.setLocale(id);
      for (const message of messages) {
        assert.ok(catalog[message] && catalog[message] !== message, id + ': ' + message);
        assert.equal(locale.translate(message), catalog[message], id + ': ' + message);
        assert.equal(source.split(JSON.stringify(message) + ':').length - 1, 1, 'no duplicate key: ' + id + ': ' + message);
      }
      const detail = 'EACCES: D:/work/保存.jsonl';
      assert.equal(locale.translate(messages[6] + '\n' + detail), catalog[messages[6]] + '\n' + detail,
        'technical details and paths stay intact');
    }
  } finally { locale.setLocale('zh-CN'); }
  for (const message of messages) assert.equal(locale.translate(message), message);
});
