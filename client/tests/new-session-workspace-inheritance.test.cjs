'use strict';
/*
 * New drafts inherit the last local or explicitly selected workspace, never
 * remote output caches. The draft picker opens at the last selected location.
 * Once a conversation starts, its archive owns the working directory. Stale
 * renderer overrides cannot relocate it; missing-path recovery remains intact.
 * Existing migrated archives retain their persisted location on reopen.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

function fakeElement() {
  const cache = {};
  const node = {
    style: {}, dataset: {}, hidden: false, textContent: '', innerHTML: '', children: [],
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle() {}, contains(c) { return node.classList._s.has(c); } },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
    toggleAttribute() {}, addEventListener() {}, removeEventListener() {}, remove() {}, append() {},
    focus() {}, blur() {}, closest: () => null, contains: () => false,
    appendChild(child) { node.children.push(child); return child; },
    insertBefore(child) { node.children.push(child); return child; },
    querySelector: (selector) => cache[selector] || (cache[selector] = fakeElement()),
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  };
  return node;
}
function bootShell({ recent = { ok: true, dir: '', name: '' } } = {}) {
  const bridge = {
    get: async () => ({ ...recent }),
    set: async () => ({ ok: true }),
    clear: async () => ({ ok: true }),
  };
  const window = {
    document: {
      createElement: () => fakeElement(), querySelector: () => fakeElement(), querySelectorAll: () => [],
      addEventListener() {}, documentElement: { dataset: {} }, body: { appendChild() {} },
    },
    addEventListener() {}, removeEventListener() {},
    soduWorkAPI: { recentWorkspace: bridge },
  };
  vm.runInNewContext(read('components/workspace/workspace-chat-history.js'), { window }, { filename: 'workspace-chat-history.js' });
  vm.runInNewContext(read('components/workspace/workspace-shell.js'),
    { window, document: window.document, innerWidth: 1200, innerHeight: 800 }, { filename: 'workspace-shell.js' });
  return { window, bridge, shell: window.WorkspaceShell };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('纯新对话入口沿用活动会话工作目录，项目归属仍不继承', () => {
  const { shell } = bootShell();
  shell.setChats([{ id: 'c1', cwd: 'D:/work/soduwork', workspaceName: 'soduwork',
    sidebarProjectId: 'proj-1', sidebarProjectName: '客户360' }]);
  shell.setActiveChat('c1');
  const payload = JSON.parse(JSON.stringify(shell.newSessionPayload()));
  assert.equal(payload.cwd, 'D:/work/soduwork');
  assert.equal(payload.workspaceLabel, 'soduwork');
  assert.equal(payload.workspaceSource, 'last-session');
  assert.equal(payload.newSession, true);
  assert.equal('sidebarProjectId' in payload, false);
  assert.equal('sidebarProjectName' in payload, false);
  assert.equal('projectId' in payload, false);
});

test('云端会话的目录不延续（远端缓存路径不得串进本地草稿）', () => {
  const { shell } = bootShell();
  shell.setChats([{ id: 'c2', cloud: true, cwd: 'C:/cache/remote-only', workspaceName: '云端' }]);
  shell.setActiveChat('c2');
  const payload = shell.newSessionPayload();
  assert.equal(payload.cwd, undefined);
  assert.equal('workspaceSource' in payload, false);
});

test('云端会话不污染目录，但最近手选目录仍可作冷启动兜底', async () => {
  const { shell } = bootShell({ recent: { ok: true, dir: 'D:/work/local', name: 'local' } });
  shell.setChats([{ id: 'c2', cloud: true, cwd: 'C:/cache/remote-only', workspaceName: '云端' }]);
  shell.setActiveChat('c2');
  shell.refreshRecentWorkspace();
  await flush();
  const payload = shell.newSessionPayload();
  assert.equal(payload.cwd, 'D:/work/local');
  assert.equal(payload.workspaceSource, 'recent');
});

test('冷启动沿用最近一次手选目录（主进程已校验目录仍存在）', async () => {
  const { shell } = bootShell({ recent: { ok: true, dir: 'D:/work/soduwork', name: 'soduwork' } });
  shell.setActiveChat('');
  shell.refreshRecentWorkspace();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(shell.newSessionPayload())),
    { cwd: 'D:/work/soduwork', workspaceLabel: 'soduwork', workspaceSource: 'recent', newSession: true });
});

test('最近目录已失效（主进程返回空）时不兜底，回落默认工作区', async () => {
  const { shell } = bootShell({ recent: { ok: true, dir: '', name: '' } });
  shell.refreshRecentWorkspace();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(shell.newSessionPayload())), { newSession: true });
});

test('显式传入优先：目录、归属与来源标注都不被继承覆盖', () => {
  const { shell } = bootShell({ recent: { ok: true, dir: 'D:/work/soduwork', name: 'soduwork' } });
  shell.setChats([{ id: 'c1', cwd: 'D:/work/soduwork', workspaceName: 'soduwork' }]);
  shell.setActiveChat('c1');
  const explicit = shell.newSessionPayload({ cwd: 'D:/other/project', workspaceLabel: 'other',
    sidebarProjectId: 'proj-9', sidebarProjectName: 'SoduWork' });
  assert.equal(explicit.cwd, 'D:/other/project');
  assert.equal(explicit.workspaceSource, undefined);
  assert.equal(explicit.sidebarProjectId, 'proj-9');
  assert.equal(explicit.sidebarProjectName, 'SoduWork');
  assert.equal(explicit.newSession, true);
});

test('newSessionWorkspace 透传目录来源且显式入口清空残留；归属只认显式传入', () => {
  const window = {};
  vm.runInNewContext(read('components/panels/compose-surface.js'), { window }, { filename: 'compose-surface.js' });
  const newSessionWorkspace = window.ComposeSurface.newSessionWorkspace;
  const carried = newSessionWorkspace({ dir: 'old', name: '旧目录', direct: true, workspaceSource: 'last-session' },
    { cwd: 'D:/next', workspaceLabel: 'next', workspaceSource: 'recent' });
  assert.equal(carried.dir, 'D:/next');
  assert.equal(carried.workspaceSource, 'recent');
  assert.equal(carried.projectId, '');
  const explicit = newSessionWorkspace({ dir: 'old', direct: true, workspaceSource: 'last-session' },
    { cwd: 'D:/proj-folder', workspaceLabel: '客户360', projectId: 'biz-1', sidebarProjectId: 'proj-1', sidebarProjectName: '客户360' });
  assert.equal(explicit.workspaceSource, '');
  assert.equal(explicit.projectId, 'biz-1');
  assert.equal(explicit.sidebarProjectId, 'proj-1');
  const cleared = newSessionWorkspace({ dir: 'old', direct: true, workspaceSource: 'recent' }, {});
  assert.equal(cleared.dir, '');
  assert.equal(cleared.direct, false);
  assert.equal(cleared.workspaceSource, '');
});

test('真实调用序：纯入口 payload 携带沿用目录，新会话草稿直接落到该目录', () => {
  const { shell } = bootShell({ recent: { ok: true, dir: 'D:/work/soduwork', name: 'soduwork' } });
  shell.setChats([{ id: 'c1', cwd: 'D:/work/soduwork', workspaceName: 'soduwork' }]);
  shell.setActiveChat('c1');
  const window = {};
  vm.runInNewContext(read('components/panels/compose-surface.js'), { window }, { filename: 'compose-surface.js' });
  const next = window.ComposeSurface.newSessionWorkspace(
    { dir: 'old', name: '旧目录', direct: true }, shell.newSessionPayload());
  assert.equal(next.dir, 'D:/work/soduwork');
  assert.equal(next.name, 'soduwork');
  assert.equal(next.direct, true);
  assert.equal(next.workspaceSource, 'last-session');
  assert.equal(next.projectId, '');
});

test('修改工作区：选择对话框从当前目录或最近手选目录打开（defaultPath）', () => {
  const compose = read('components/panels/panels-compose.js');
  const section = compose.slice(compose.indexOf('async function _pickWorkspace'));
  assert.match(section, /_workspace\.direct \? _workspace\.dir : ''/);
  assert.match(section, /global\.soduWorkAPI\?\.recentWorkspace\?\.get\?\.?\(\)/);
  assert.match(section, /defaultPath: startDir/);
  const environment = read('main/pi-session/environment-ipc.js');
  assert.match(environment, /ipcMain\.handle\('pi-session-pick-cwd'[\s\S]*?options\?\.defaultPath[\s\S]*?path\.isAbsolute\(requested\)/);
  const preload = read('preload.js');
  assert.match(preload, /pickCwd: \(options\) => ipcRenderer\.invoke\('pi-session-pick-cwd', options \|\| \{\}\)/);
});

test('archived conversations ignore removed workspace overrides and retain remote recovery protection', () => {
  const ipc = read('main/pi-session/ipc.js');
  assert.doesNotMatch(ipc, /resumeWorkspace|resumeOverride|workspaceMoved/);
  assert.match(ipc, /require\('\.\/resume-cwd'\)\(app, resume, _defaultCwd\)/);
  assert.match(ipc, /if \(opts\.nativeRelay === true && resume\) \{\s*\n\s*require\('\.\/resume-cwd'\)\(app, resume, \(\) => \{/);
  assert.match(ipc, /resumeCwd: resume \? cwd : '',/);
  const sessionOpen = read('main/pi-session/session-open.js');
  assert.doesNotMatch(sessionOpen, /workspaceMoved|soduwork\.workspace\.moved/);
  assert.match(read('main/pi-session/archive-history.js'), /soduwork\.workspace\.moved/,
    'previously migrated archives must retain their recorded directory');
});

test('resume-cwd keeps the archive directory despite stale overrides and preserves missing-path recovery', () => {
  const resumeCwd = require('../main/pi-session/resume-cwd');
  const os = require('node:os');
  const base = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'soduwork-resume-cwd-'));
  const picked = path.join(base, 'picked');
  const archived = path.join(base, 'archived');
  require('node:fs').mkdirSync(picked);
  require('node:fs').mkdirSync(archived);
  const fallback = () => 'FALLBACK';
  assert.equal(resumeCwd({}, { cwd: archived }, fallback, picked), path.resolve(archived));
  assert.equal(resumeCwd({}, { cwd: archived }, fallback, path.join(base, 'gone')), path.resolve(archived));
  assert.equal(resumeCwd({}, { cwd: archived }, fallback, 'relative/dir'), path.resolve(archived));
  assert.equal(resumeCwd({}, { cwd: path.join(base, 'gone-too') }, fallback, path.join(base, 'gone')), 'FALLBACK');
  require('node:fs').rmSync(base, { recursive: true, force: true });
});

test('conversation composer omits the removed workspace-switch action and its private handler', () => {
  const composer = read('components/panels/work-composer.js');
  assert.doesNotMatch(composer, /nchatWdPick|wc-wd-pick/);
  const bindings = read('components/panels/chat-composer-bindings.js');
  assert.doesNotMatch(bindings, /nchatWdPick|_changeConversationWorkspace/);
  const chat = read('components/panels/panels-chat.js');
  assert.doesNotMatch(chat, /_changeConversationWorkspace/);
  const css = read('components/panels/work-composer.css');
  assert.doesNotMatch(css, /\.wc-wd-pick/);
  assert.doesNotMatch(bindings, /querySelector\('#nchatWd'\)\.addEventListener/);
  assert.match(composer, /id: 'nchatWd',[\s\S]{0,160}readOnly: true/);
  assert.match(read('components/panels/panels-chat-chrome.js'), /data-chat-open-location/,
    'the independent header action still opens the existing directory');
});

test('主进程持久化模块：三个 IPC、来源校验与失效目录拦截齐备', () => {
  const source = read('main/workspace/recent-workspace.js');
  assert.match(source, /ipcMain\.handle\('recent-workspace-get'/);
  assert.match(source, /ipcMain\.handle\('recent-workspace-set'/);
  assert.match(source, /ipcMain\.handle\('recent-workspace-clear'/);
  assert.match(source, /isDirectory\(\)/);
  assert.match(source, /url\.protocol === 'file:'/);
  assert.match(source, /renameSync/);
  const preload = read('preload.js');
  assert.match(preload, /recentWorkspace: \{[\s\S]*recent-workspace-get[\s\S]*recent-workspace-set[\s\S]*recent-workspace-clear/);
  /*
   * Read recentWorkspace from top-level soduWorkAPI, not the conversation-session facade
   * returned by _setupApi.
   */
  const compose = read('components/panels/panels-compose.js');
  assert.match(compose, /function _syncRecentWorkspace[\s\S]*?const bridge = global\.soduWorkAPI;/);
  assert.doesNotMatch(compose, /_setupApi\(\)[\s\S]{0,80}recentWorkspace/);
});

test('目录延续不会回流到会话记录：发送链路只取 cwd 与名称', () => {
  const compose = read('components/panels/panels-compose.js');
  const surface = read('components/panels/panels-compose.js');
  assert.match(compose, /workspaceLabel: _workspace\.direct \? _workspace\.name : '默认工作区'/);
  assert.doesNotMatch(compose, /workspaceLabel:[^,]*workspaceSource/);
  assert.match(surface, /workspaceSource: String\(options\.workspaceSource \|\| ''\)\.trim\(\)/);
});

test('面板内 newChatSession 与全局独立工作区入口同源', () => {
  const source = read('components/panels/panels-compose.js');
  const section = source.slice(source.indexOf('function newChatSession'));
  assert.match(section, /WorkspaceShell\.newSessionPayload/);
  assert.doesNotMatch(section, /\{ tab: 'chat', newSession: true \}\s*\);\s*\n  \}/);
});
