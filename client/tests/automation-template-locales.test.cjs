const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-schedules-editor.js'), 'utf8');
// Load the shared SoduworkLocalizedText primitive before editor code.
const localizedSource = fs.readFileSync(path.join(__dirname, '../core/localized-text.js'), 'utf8');

// Read administrator-provided locale maps for employee-facing display and prefill.
const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const TEMPLATE = {
  id: 'daily-report', name: '每日工作总结', description: '每天整理今日任务、风险和明日计划',
  title: '每日工作总结', note: '汇总我今天的任务进展。', every: 'daily', atHour: 18, atMinute: 0,
  startDate: '2030-01-01', endDate: '2030-12-31',
  nameLocales: { 'en-US': 'Daily work summary' },
  descriptionLocales: { 'en-US': 'Summarize today’s work, risks and tomorrow’s plan each day' },
  noteLocales: { 'en-US': 'Summarize today’s task progress.' },
};
const PLAIN = { id: 'plain', name: '业务巡检', description: '按时检查页面', title: '业务巡检', note: '打开页面检查。', every: 'daily' };

function setup(locale, templates) {
  const i18n = {
    getLocale: () => locale,
    translateText: value => value, // Test locale selection rather than dictionary translation.
  };
  const c = {
    window: { SoduWorkI18n: i18n },
    _schTemplates: templates,
    esc, _schVisualIcon: () => '<i></i>',
    _schPrepareEditor: draft => { c.prepared = draft; },
    _schEditing: null, document: { getElementById: () => null },
  };
  vm.createContext(c);
  vm.runInContext(localizedSource, c);
  vm.runInContext(source, c);
  return c;
}

test('zh-CN keeps the administrator text everywhere', () => {
  const c = setup('zh-CN', [TEMPLATE]);
  const html = c._schRecipeHtml(true);
  assert.match(html, /<b data-user-content>每日工作总结<\/b>/);
  assert.match(html, /每天整理今日任务、风险和明日计划/);
  assert.match(html, /aria-label="使用模板 · 每日工作总结"/);
});

test('en-US shows the translated card and composes a protected aria-label', () => {
  const c = setup('en-US', [TEMPLATE]);
  const html = c._schRecipeHtml(true);
  assert.match(html, /<b data-user-content>Daily work summary<\/b>/);
  assert.match(html, /Summarize today’s work, risks and tomorrow’s plan each day/);
  assert.match(html, /aria-label="使用模板 · Daily work summary"/);
  // Do not translate already-localized aria-label templates again.
  assert.match(html, /data-user-attributes="aria-label"/);
});

test('missing locale falls back to the base field, never machine-translates', () => {
  const c = setup('ja-JP', [TEMPLATE]); // Only the English translation is available.
  const html = c._schRecipeHtml(true);
  assert.match(html, /<b data-user-content>每日工作总结<\/b>/);
  assert.match(html, /每天整理今日任务、风险和明日计划/);
});

test('template without locales renders identically across locales', () => {
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
    const c = setup(locale, [PLAIN]);
    assert.match(c._schRecipeHtml(true), /<b data-user-content>业务巡检<\/b>/);
    assert.match(c._schRecipeHtml(true), /按时检查页面/);
  }
});

test('prefill uses the current locale so English users create English automations', () => {
  const en = setup('en-US', [TEMPLATE]);
  assert.equal(en._schRecipeValues(TEMPLATE).title, 'Daily work summary');
  assert.equal(en._schRecipeValues(TEMPLATE).note, 'Summarize today’s task progress.');
  assert.equal(en._schRecipeValues(TEMPLATE).every, 'daily');
  assert.equal(en._schRecipeValues(TEMPLATE).startDate, '2030-01-01');
  assert.equal(en._schRecipeValues(TEMPLATE).endDate, '2030-12-31');
  const zh = setup('zh-CN', [TEMPLATE]);
  assert.equal(zh._schRecipeValues(TEMPLATE).title, '每日工作总结');
  assert.equal(zh._schRecipeValues(TEMPLATE).note, '汇总我今天的任务进展。');
  // Use the same values for card rendering and selected prefill.
  const html = en._schRecipeHtml(true);
  assert.match(html, /Daily work summary/);
});

test('resolver helpers: case-insensitive locale lookup and zh-CN bypass', () => {
  const c = setup('en-US', []);
  assert.equal(c._schPickLocale({ 'en-us': 'Hi' }, 'en-US'), 'Hi');
  assert.equal(c._schPickLocale({ 'en-US': '  ' }, 'en-US'), '');
  assert.equal(c._schPickLocale(null, 'en-US'), '');
  assert.equal(c._schPickLocale({ 'en-US': 'Hi' }, 'zh-CN'), '');
  assert.equal(c._schTemplateText(TEMPLATE, 'name'), 'Daily work summary');
});
