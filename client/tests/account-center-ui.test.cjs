'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8');

test('account center keeps profile editing behind the account summary entry', () => {
  const source = read('components/client-auth/account-center.js');
  const auth = read('components/client-auth/client-auth.js');
  assert.match(source, /function openProfileEditor\s*\(/);
  assert.match(source, /data-account-profile-editor/);
  assert.match(source, /openProfileEditor/);
  assert.match(auth, /data-account-profile-editor/);
  assert.doesNotMatch(auth, /soduwork-account-menu-btn|soduwork-account-menu-wrap|data-action="(?:change-password|logout)"/);
});

test('logout confirmation is an AccountUI modal with cancel and confirm outcomes', () => {
  const source = read('components/client-auth/client-auth.js');
  assert.match(source, /AccountUI\.modal/);
  assert.match(source, /clientLogout\(\)/);
  assert.match(source, /resolve\(false\)/);
  assert.match(source, /resolve\(true\)/);
  assert.doesNotMatch(source, /global\.confirm\(/);
});

test('account center management navigation renders security, devices and privacy tabs', () => {
  const source = read('components/client-auth/account-center.js');
  assert.match(source, /const tabs = \['security', 'devices', 'privacy'\]/);
  assert.match(source, /tabs\.map\(.*data-tab/);
  assert.doesNotMatch(source, /data-tab=\\\"profile\\\"/);
});

test('workspace and account avatars use circular clipping surfaces', () => {
  const authCss = read('components/client-auth/client-auth.css');
  const workspaceCss = read('components/workspace/workspace-navigation.css');
  const accountCss = read('components/client-auth/personal-account.css');
  assert.match(authCss, /\.soduwork-account-avatar\s*\{[\s\S]*?border-radius:\s*50%/);
  assert.match(workspaceCss, /\.ws-avatar\{[\s\S]*?border-radius:50%/);
  assert.match(accountCss, /#personalAccountPanel \.soduwork-account-avatar\s*\{[\s\S]*?border-radius:\s*50%/);
});

test('personal account header shares workspace dimensions and wraps readable supporting text', () => {
  const css = read('components/client-auth/personal-account.css');
  const header = css.match(/#personalAccountPanel > \.personal-account-head\s*\{([^}]*)\}/)?.[1];
  assert.ok(header, 'account header rule should exist');
  assert.match(header, /min-height:\s*var\(--ws-head-height,\s*60px\)/);
  assert.match(header, /padding:\s*12px\s+var\(--ws-head-gutter,\s*28px\)/);
  assert.match(header, /flex-wrap:\s*wrap/);
  assert.match(css, /--account-text:\s*max\(var\(--font-min-readable,\s*14\.5px\),\s*calc\(14\.5px\s*\*\s*var\(--font-scale,\s*1\)\)\)/);
  assert.match(css, /#personalAccountPanel \.personal-account-head p\s*\{[^}]*font-size:\s*var\(--account-text\)/);
  assert.match(css, /@media\s*\(max-width:\s*900px\)\s*\{\s*#personalAccountPanel \.personal-account-head p\s*\{\s*flex-basis:\s*100%/);
});

test('personal account uses the shared workspace frame below the optional window titlebar', () => {
  const css = read('components/workspace/workspace-navigation.css');
  const workspaceHostRule = css.match(/html\[data-desk-panel="workspace"\] :is\([^{}]*#personalAccountPanel[^{}]*\)\s*\{([^}]*)\}/);
  assert.ok(workspaceHostRule, 'personal account must participate in the shared workspace frame');
  assert.match(workspaceHostRule[1], /top:\s*var\(--ws-panel-top\)!important/);
  assert.match(workspaceHostRule[1], /bottom:\s*var\(--ws-frame-bottom\)!important/);
  assert.match(css, /--ws-panel-top:\s*calc\(var\(--window-menu-height,\s*0px\)\s*\+\s*var\(--ws-frame-top\)\)/);
  assert.match(css, /--ws-frame-top:\s*2px/);
  assert.match(css, /--ws-frame-bottom:\s*15px/);
  assert.match(read('components/workspace/window-menu.css'), /html\[data-window-menu\]\s*\{[^}]*--window-menu-height:\s*34px/);
});

test('signed-in device activity is isolated for phrase localization', () => {
  const source = read('components/client-auth/account-center.js');
  assert.match(source, /class="ac-last-active"/);
  assert.doesNotMatch(source, /item\.lastSeenAt \? '最近活动 '/);
});
