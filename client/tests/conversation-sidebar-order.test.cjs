'use strict';

const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname,
  '../components/workspace/workspace-shell.js'), 'utf8');
const shellCss = fs.readFileSync(path.join(__dirname,
  '../components/workspace/workspace-shell.css'), 'utf8');

function shell() {
  const window = {};
  vm.runInNewContext(source, { window });
  return window.WorkspaceShell;
}

test('recent chats keep their slots when history timestamps and states change', () => {
  const api = shell();
  const current = [
    { id: 'a', title: 'A', at: 300 },
    { id: 'b', title: 'B', at: 200 },
    { id: 'c', title: 'C', at: 100 },
  ];
  const incoming = [
    { id: 'b', title: 'B', at: 900, state: 'running' },
    { id: 'c', title: 'C', at: 800 },
    { id: 'a', title: 'A', at: 700 },
  ];
  const result = api._reconcileChats(current, incoming, 1000);
  assert.deepEqual(Array.from(result, (item) => item.id), ['a', 'b', 'c']);
});

test('older chats append below stable visible chats instead of being silently dropped', () => {
  const api = shell();
  const current = Array.from({ length: 12 }, (_, index) => ({
    id: 'visible-' + index, title: 'Visible ' + index, at: 2000 - index,
  }));
  const older = Array.from({ length: 24 }, (_, index) => ({
    id: 'older-' + index, title: 'Older ' + index, at: 1000 - index,
  }));
  const incoming = [
    ...current.slice().reverse().map((item) => ({ ...item, state: 'completed' })),
    ...older,
  ];

  const result = api._reconcileChats(current, incoming, 3000);
  assert.deepEqual(Array.from(result, (item) => item.id),
    [...current, ...older].map((item) => item.id));
});

test('a genuinely newer chat enters the first slot without rotating old history', () => {
  const api = shell();
  const current = Array.from({ length: 12 }, (_, index) => ({
    id: 'visible-' + index, title: 'Visible ' + index, at: 2000 - index,
  }));
  const result = api._reconcileChats(current, [
    ...current.slice().reverse(),
    { id: 'new-chat', title: 'New chat', at: 3000 },
    { id: 'off-screen', title: 'Off screen', at: 1000 },
  ], 3500);
  assert.deepEqual(Array.from(result, (item) => item.id),
    ['new-chat', ...current.map((item) => item.id), 'off-screen']);
});

test('a temporary history gap cannot make an existing chat flicker out of the list', () => {
  const api = shell();
  const current = [{ id: 'stable', title: 'Stable', at: 900, state: 'completed' }];
  const missing = api._reconcileChats(current, [], 1000);
  assert.deepEqual(Array.from(missing, (item) => item.id), ['stable']);
  assert.equal(missing[0]._missingAt, 1000);
  const stillMissing = api._reconcileChats(missing, [], 20000);
  assert.deepEqual(Array.from(stillMissing, (item) => item.id), ['stable']);
  const restored = api._reconcileChats(stillMissing,
    [{ id: 'stable', title: 'Stable', at: 21000, state: 'completed' }], 21000);
  assert.equal(restored[0]._missingAt, undefined);
  const expired = api._reconcileChats(missing, [], 32000);
  assert.equal(expired.length, 0);
});

test('temporary chat keeps one UI identity when the real session id arrives', () => {
  const api = shell();
  const draft = api._upsertChatItems([], {
    localId: 'draft-1', title: '新的工作', at: 100, pending: true,
  });
  const key = draft[0]._uiKey;
  const settled = api._upsertChatItems(draft, {
    localId: 'draft-1', id: 'pi-real-1', title: '新的工作', at: 101, state: 'running',
  });
  assert.equal(settled.length, 1);
  assert.equal(settled[0].id, 'pi-real-1');
  assert.equal(settled[0]._uiKey, key);
  assert.equal(settled[0].pending, false);
});

test('chat rendering patches keyed rows instead of clearing the scrolling list', () => {
  assert.match(source, /function _syncChatList\(target, items, isPinned, pool\)/);
  assert.match(source, /const scrollTop = scroller\.scrollTop/);
  assert.match(source, /scroller\.scrollTop = scrollTop/);
  assert.doesNotMatch(source, /chats\.innerHTML\s*=\s*['"]['"]/);
  assert.doesNotMatch(source, /pinnedChats\.innerHTML\s*=\s*['"]['"]/);
});

test('navigation and chats share the upper scrollport; recent tasks use a sibling dock', () => {
  assert.match(shellCss, /\.ws-pinned\{[^}]*flex:0 0 auto/);
  assert.match(shellCss, /\.ws-pinned \.ws-list-body\{[^}]*flex:0 0 auto/);
  assert.doesNotMatch(shellCss, /\.ws-pinned \.ws-list-body\{[^}]*max-height/);
  assert.match(shellCss, /\.ws-chats\{[^}]*flex:0 0 auto/);
  assert.match(shellCss, /\.ws-side-scroll\{[^}]*overflow-y:auto/);
  assert.match(source, /id="wsChats"[\s\S]*?'<\/div>' \+\s*'<section class="ws-list ws-recent/);
  assert.match(shellCss, /\.ws-recent\{[^}]*max-height:min\(32vh,280px\)/);
  assert.match(shellCss, /\.ws-recent \.ws-list-body\{[^}]*overflow-y:auto[^}]*overscroll-behavior:contain/);
  assert.match(shellCss, /\.ws-profile-row\{flex:none\}/);
  assert.match(shellCss, /\.ws-section-label\{[^}]*font-size:14\.5px/);
});

test('the home rail starts a new conversation and utility pages reclaim the sidebar space', () => {
  assert.match(source, /\['create', '[^']+', 'home'\]/);
  assert.match(source, /const CONVERSATION_KEYS = new Set\(\['create', 'pichat'\]\)/);
  assert.match(source, /const RAIL_MORE_ITEMS = \[/);
  assert.match(source, /\['create', '[^']+', 'home'\]/);
  assert.match(source, /const RAIL_MORE_ITEMS = \[[\s\S]*?\['aidesk', 'AI [^']+', 'aidesk'\]/);
  assert.match(source, /data-rail-menu="more"/);
  assert.doesNotMatch(source, /data-rail-menu="collaboration"/);
  assert.match(source, /function syncWorkspaceLayout\(key\)/);
  assert.match(shellCss, /\.workspace-shell\{--ws-rail-w:52px/);
  assert.match(shellCss, /\.ws-rail\{[^}]*padding:18px 4px 10px/);
  assert.match(shellCss, /\.ws-rail-button\{[^}]*width:36px;height:36px/);
  assert.match(shellCss, /\.ws-rail-button svg\{width:20px;height:20px/);
  assert.match(source, /ws-rail-top\">' \+ primary \+ '<div id="wsSidebarApps" class="ws-sidebar-apps"><\/div>' \+ moreMenu/,
    'administrator app slots follow primary navigation and precede the More menu');
  assert.match(shellCss, /\.ws-rail-more-wrap\{position:relative/);
  /* Keep rail buttons and avatars circular while preserving the active gradient. */
  assert.match(shellCss, /\.ws-rail-button\{[^}]*border-radius:50%/);
  assert.match(shellCss, /\.ws-rail-button\.active\{background:linear-gradient\([^}]*var\(--accent\)[^}]*var\(--ws-rail-face-hi\)/);
  assert.doesNotMatch(shellCss, /\.ws-rail-avatar\{[^}]*border-radius:10px/);
  assert.match(shellCss, /\.workspace-shell\[data-layout="utility"\][^}]*grid-template-columns:var\(--ws-rail-w\) minmax\(0,1fr\)/);
  assert.match(shellCss, /html\[data-desk-panel="workspace"\]\[data-workspace-layout="utility"\] \.ws-resizer\{display:none\}/);
  assert.doesNotMatch(shellCss, /\.ws-rail-button\.active::before/);
});

test('history deletion confirms and routes both Pi archives and Runner records', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
  const ipc = fs.readFileSync(path.join(__dirname, '../main/pi-session/ipc.js'), 'utf8');
  const session = fs.readFileSync(path.join(__dirname, '../main/pi-session/session.js'), 'utf8');
  assert.match(source, /className = 'ws-chat-delete ws-chat-menu-item'/);
  assert.match(preload, /deleteHistory:\s*\(id, options\)\s*=>\s*ipcRenderer\.invoke\('pi-session-history-delete'/);
  // The main process returns confirmation metadata for the renderer's application dialog.
  // After acceptance, repeat the request with confirmed through SoduWorkConfirmDialog.
  assert.match(ipc, /needsConfirm: true/);
  assert.match(ipc, /rawOptions && rawOptions\.confirmed === true/);
  assert.doesNotMatch(ipc, /await dialog\.showMessageBox\(/);
  assert.match(source, /const dialog = global\.SoduWorkConfirmDialog/);
  assert.match(source, /await dialog\.open\(\{ \.\.\.\(got\.confirm \|\| \{\}\), danger: true \}\)/);
  assert.match(ipc, /active\.inFlight\(\)/);
  assert.match(ipc, /await active\.close\(\)/);
  assert.match(ipc, /allowMissing: !canonicalId/);
  // Pi archives now pass through recycle readiness checks before native delete.
  assert.match(ipc, /trash = trashWithRecovery/);
  assert.match(ipc, /await trash\(shell, piEntry\.path\)/);
  assert.match(ipc, /session\.findRunnerRow\(id, \{ strict: true \}\)/);
  assert.match(ipc, /session\.forgetRunner\(app, id\)/);
  assert.match(source, /const canDelete = Boolean\(id\) && !c\.pending/);
  const archives = fs.readFileSync(path.join(__dirname, '../main/pi-session/archive-history.js'), 'utf8');
  assert.match(session, /_historyIndex\(app\)\.find\(wanted, \{ strict: options\.strict === true \}\)/);
  assert.match(archives, /fs\.promises\.realpath\(root\)/);
  assert.match(archives, /path\.extname\(target\)\.toLowerCase\(\) !== '\.jsonl'/);
  // Load both dialog logic and styling so deletion can request confirmation.
  const desk = fs.readFileSync(path.join(__dirname, '../desk.html'), 'utf8');
  const dialog = fs.readFileSync(path.join(__dirname, '../components/shared/app-confirm-dialog.js'), 'utf8');
  const dialogCss = fs.readFileSync(path.join(__dirname, '../components/shared/app-confirm-dialog.css'), 'utf8');
  assert.equal((desk.match(/components\/shared\/app-confirm-dialog\.js/g) || []).length, 1);
  assert.equal((desk.match(/components\/shared\/app-confirm-dialog\.css/g) || []).length, 1);
  assert.match(dialog, /danger \? dialog\.querySelector\('\.app-confirm-cancel'\)/);
  assert.match(dialogCss, /\.app-confirm-dialog::backdrop\{background:rgba\(16,22,32,\.34\)/);
  assert.match(dialogCss, /\.app-confirm-submit\.app-confirm-danger\{background:#e5484d;?\}/);
});
