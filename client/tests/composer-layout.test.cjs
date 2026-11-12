'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const composer = read('components/panels/panels-compose.js');
const surface = read('components/panels/compose-surface.js');
const shell = read('components/panels/work-composer.js');
const css = read('components/panels/work-composer.css');
const chatCss = read('components/panels/panels-chat.css');
const intentCss = read('components/panels/work-intent.css');

test('new composer groups add/access/workspace separately from compact model and Agent controls', () => {
  assert.match(composer, /querySelector\('\.wc-tools'\)\.appendChild\(more\)/);
  assert.match(composer, /toolbarContext\.insertBefore\(permission, workspace\)/);
  assert.match(composer, /morePop\.appendChild\(intent\)/);
  assert.match(composer, /runtimeWrap\.appendChild\(runtime\)/);
  assert.match(composer, /actions\.insertBefore\(model, voice \|\| actions\.firstChild\)/);
  assert.doesNotMatch(composer, /toolbarContext\.insertBefore\(model,/);
  assert.match(css, /\.wc-actions>\.cp-modelwrap\{[^}]*max-width:100%/);
  assert.match(css, /\.wc-actions>\.cp-modelwrap>\.cp-modelbtn>span\{[^}]*text-overflow:clip[^}]*white-space:normal/);
  assert.doesNotMatch(composer, /morePop\.appendChild\(model\)/);
  assert.match(shell, /o\.id !== 'cpWorkspace'/);
});

test('active model trigger is compact without shrinking its label or model list', () => {
  assert.match(chatCss, /\.nmodel\{[^}]*max-width:136px/);
  assert.match(chatCss, /\.nmodel-button\{[^}]*max-width:100%[^}]*gap:4px[^}]*font-size:max\(var\(--font-min-readable,\s*14\.5px\),\s*13px\)/);
  assert.match(chatCss, /\.nmodel-button>span\{[^}]*min-width:0[^}]*text-overflow:ellipsis/);
  assert.match(chatCss, /\.nmodel-button>svg\{[^}]*width:12px;height:12px;flex:none/);
  assert.match(chatCss, /@media\(max-width:480px\)\{\.nmodel\{max-width:96px/);
  assert.match(chatCss, /\.nmodel-pop\{[^}]*width:min\(368px,calc\(100vw - 28px\)\)/);
});

test('plus menu uses real file and plugin entry points', () => {
  assert.match(composer, /id="cpMoreFile"/);
  assert.doesNotMatch(surface, /id="cpMoreExecution"/);
  assert.match(surface, /WorkComposer\.executionMode\('data-execution'\)/);
  assert.match(shell, /executionMode\('data-chat-execution'\)/);
  assert.doesNotMatch(surface, /cp-execution-options/);
  assert.match(composer, /SoduWorkAPI\.pluginCatalog\(\)/);
  assert.match(composer, /WorkComposer\.pluginSection\('cpMorePlugins', 'cpMoreAllPlugins'\)/);
  assert.match(shell, /id="nchatFilePick"/);
  assert.match(shell, /pluginSection\('nchatMorePlugins', 'nchatPlugins'\)/);
});

test('default and active chat composers open menus into available space', () => {
  assert.match(css, /data-stage='compose'.*#cpMorePop\{top:calc\(100% \+ 9px\);bottom:auto/s);
  assert.match(css, /\.wc-chat-more-pop\{left:0;bottom:calc\(100% \+ 9px\);top:auto/);
  assert.match(css, /work-composer\.cp-box\{width:min\(800px/);
  assert.match(css, /cp-box>\.wc-input\{height:auto;min-height:98px/);
  assert.match(css, /cp-box>\.wc-toolbar\{min-height:43px/);
  assert.match(chatCss, /min-height:68px/);
});

test('selected plugin capsules hide the scrolling placeholder rail', () => {
  assert.match(css, /\.nplugin-strip:not\(\[hidden\]\) ~ \.wc-placeholder-rail\{[^}]*opacity:0[^}]*visibility:hidden/);
  assert.match(css, /\.nplugin-strip:not\(\[hidden\]\) ~ \.wc-placeholder-track\{[^}]*animation-play-state:paused/);
});

test('workspace chevron can be removed without changing popup behavior', () => {
  assert.match(shell, /o\.popup && o\.chevron !== false/);
});

test('goal status rail shares the task surface below the add cap', () => {
  assert.match(chatCss, /\.nchat-compose-shell\{[^}]*gap:7px/);
  assert.match(chatCss, /\.nchat-main\{[^}]*--nchat-column-max:780px/);
  assert.match(chatCss, /\.nchat-footin\{width:min\(var\(--nchat-column-max\),100%\)/);
  assert.match(intentCss,
    /\.nqueue-goal-slot > \.wi-rail \{[^}]*min-height: 34px;[^}]*border-radius: 16px 16px 0 0/s);
});

test('transcript and composer share column width and responsive gutters without scrollbar centering drift', () => {
  assert.match(chatCss, /\.nchat-inner\{width:min\(var\(--nchat-column-max\),calc\(100cqw - 2 \* var\(--nchat-column-gutter\)\)\)/);
  assert.match(chatCss, /margin:0 0 0 max\(var\(--nchat-column-gutter\),calc\(\(100cqw - var\(--nchat-column-max\)\) \/ 2\)\)/);
  assert.match(chatCss, /\.nchat-foot\{[^}]*padding:10px var\(--nchat-column-gutter\) 20px/);
  assert.match(chatCss, /@container chat-column \(max-width:380px\)\{\.nchat-inner,\.nchat-foot\{--nchat-column-gutter:10px\}\}/);
});

test('rotating placeholder yields to composer overlays', () => {
  assert.match(shell, /<kbd>\/<\/kbd>/);
  assert.match(shell, /<kbd>#<\/kbd>/);
  assert.match(shell, /<kbd>@<\/kbd>/);
  assert.match(shell, /\\u544a\\u8bc9 SoduWork \\u4f60\\u60f3\\u5b8c\\u6210\\u4ec0\\u4e48\\u2026/);
  assert.match(css, /wc-placeholder-item\.wc-placeholder-title\{[^}]*font-family:var\(--font-ui\);font-size:13\.5px;font-weight:400/);
  assert.match(css, /cp-box>\.wc-placeholder-rail\{[^}]*--wc-placeholder-step:28px;font-size:13\.5px/);
  assert.match(css, /wc-placeholder-item\{[^}]*font-weight:400/);
  assert.match(css, /\.work-composer:has\(\.nplugin-strip:not\(\[hidden\]\)\) \.wc-placeholder-rail/);
  assert.match(css, /\.work-composer:has\(\.cp-skill-tags\.show\) \.wc-placeholder-rail/);
  assert.match(css, /\.work-composer:has\(\.wi-rail\.show\) \.wc-placeholder-rail/);
  assert.match(css, /\.work-composer:has\(\.catt-tray\.show\) \.wc-placeholder-rail/);
  assert.match(css, /\.work-composer:has\(\.nannotation-tray:not\(\[hidden\]\)\) \.wc-placeholder-rail/);
  assert.match(css, /\.work-composer:has\(\.nannotation-list:not\(\[hidden\]\)\) \.wc-placeholder-rail/);
});
