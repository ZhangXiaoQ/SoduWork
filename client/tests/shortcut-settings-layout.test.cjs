const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const shortcutPanel = html => html.slice(
  html.indexOf('<section class="shortcuts-page"'),
  html.indexOf('<section class="archive-history-panel"'),
);
const cssRule = (css, selector) => {
  const start = css.indexOf(selector + ' {');
  assert.notEqual(start, -1, 'Missing rule: ' + selector);
  return css.slice(start, css.indexOf('}', start) + 1);
};

test('快捷键页接入工作区路由、脚本和样式', () => {
  const html = read('desk.html');
  const boot = read('desk-boot.js');
  const state = read('main/workspace-state.cjs');
  const css = read('components/settings/shortcut-settings.css');
  assert.match(html, /id="shortcutsPanel"/);
  assert.match(html, /components\/settings\/shortcut-settings\.css/);
  assert.match(html, /components\/settings\/shortcut-settings\.js/);
  const modelScript = '<script src="core/shortcut-bindings.js"></script>';
  const pageScript = '<script src="components/settings/shortcut-settings.js"></script>';
  assert.equal(html.split(modelScript).length - 1, 1, '共享快捷键目录只能加载一次');
  assert.ok(html.indexOf(modelScript) < html.indexOf(pageScript), '共享目录必须先于编辑器加载');
  assert.match(boot, /shortcuts:\s*'shortcutsPanel'/);
  assert.match(state, /'shortcuts'/);
  assert.match(css, /#shortcutsPanel\s*\{/);
  assert.match(css, /shortcut-keycap/);
});

test('快捷键页只保留标题、搜索、分组列表和恢复默认，不保留统计与分类侧栏', () => {
  const panel = shortcutPanel(read('desk.html'));
  const source = read('components/settings/shortcut-settings.js');
  assert.match(panel, /id="shortcutsPageTitle">快捷键<\/h1>/);
  assert.match(panel, /data-shortcut-reset-all>恢复默认<\/button>/);
  assert.equal((panel.match(/<input\b/g) || []).length, 1, '页面只需要一个搜索输入框');
  assert.match(panel, /type="search"[^>]*data-shortcut-search[^>]*aria-label="搜索快捷键"/);
  assert.match(panel, /data-shortcut-list/);
  assert.doesNotMatch(panel, /<aside\b|PREFERENCES|data-shortcut-(?:count|customized|conflicts|platform|categories|filter|export|import|result-count)\b/);
  assert.doesNotMatch(panel, /shortcuts-(?:summary|categories|filters|kicker|page-icon)\b/);
  assert.match(source, /class="shortcut-group"[^>]*aria-labelledby=/);
  assert.match(source, /<h2 class="shortcut-group-title"/);
  assert.match(source, /class="shortcut-binding-button/);
});

test('只有快捷键列表滚动，标题和搜索固定，空状态不占空间且搜索只显示一层焦点边框', () => {
  const panel = shortcutPanel(read('desk.html'));
  const css = read('components/settings/shortcut-settings.css');
  const mainStart = panel.indexOf('<main class="shortcuts-main"');
  const mainEnd = panel.indexOf('</main>');
  assert.ok(panel.indexOf('</header>') < mainStart);
  assert.ok(panel.indexOf('class="shortcuts-toolbar"') < mainStart);
  assert.ok(panel.indexOf('data-shortcut-search') < mainStart, '搜索不能跟随列表滚动');
  assert.ok(panel.indexOf('data-shortcut-list') > mainStart && panel.indexOf('data-shortcut-list') < mainEnd);
  assert.ok(panel.indexOf('data-shortcut-status') > mainEnd, '状态提示应固定在滚动区之外');
  assert.match(cssRule(css, '#shortcutsPanel'), /overflow:\s*hidden/);
  assert.match(cssRule(css, 'html[data-desk-panel="workspace"] #shortcutsPanel'), /overflow:\s*hidden\s*!important/);
  assert.match(cssRule(css, '#shortcutsPanel .shortcuts-main'), /min-height:\s*0/);
  assert.match(cssRule(css, '#shortcutsPanel .shortcuts-main'), /overflow-y:\s*auto/);
  assert.match(cssRule(css, '#shortcutsPanel .shortcuts-page-head'), /flex:\s*0 0 auto/);
  assert.match(cssRule(css, '#shortcutsPanel .shortcuts-toolbar'), /flex:\s*0 0 auto/);
  assert.match(cssRule(css, '#shortcutsPanel .shortcut-status:empty'), /display:\s*none/);
  assert.match(css, /--shortcut-text:\s*max\(var\(--font-min-readable,\s*14\.5px\),\s*14px\)/);
  assert.match(cssRule(css, '#shortcutsPanel .shortcuts-search input:focus-visible'), /outline:\s*0\s*!important/);
  assert.match(cssRule(css, '#shortcutsPanel .shortcuts-search input:focus-visible'), /box-shadow:\s*none\s*!important/);
  assert.match(css, /@container shortcut-settings \(max-width:\s*480px\)/);
});

test('快捷键编辑器使用真实配置存储并注册当前窗口截图能力', () => {
  const source = read('components/settings/shortcut-settings.js');
  const preload = read('preload.js');
  assert.match(source, /Store\._cfg/);
  assert.match(source, /Store\.saveCfg/);
  assert.match(source, /soduWorkAPI\?\.capturePage/);
  assert.match(source, /session\.copyImage/);
  assert.match(source, /navigator\.clipboard\?\.write/);
  assert.match(source, /host\.addEventListener\('keydown',\s*onKeydown,\s*true\)/);
  const panel = shortcutPanel(read('desk.html'));
  assert.doesNotMatch(panel, /data-shortcut-preview|data-shortcut-copy|data-shortcut-close-preview/);
  assert.match(source, /soduWorkAPI\.startScreenshot\(\{ hideOwner: options\?\.hideOwner === true \}\)/);
  assert.match(preload, /startScreenshot:\s*\(options\)\s*=>\s*ipcRenderer\.invoke\('screenshot-start',\s*options\s*\|\|\s*\{\}\)/,
    'preload must forward the hideOwner option to the main-process capture service');
  assert.match(panel, /data-shortcut-status role="status" aria-live="polite"/);
});
