'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main', 'desktop-overlay.cjs'), 'utf8');
const pet = fs.readFileSync(path.join(root, 'components', 'pet', 'pet-ui.js'), 'utf8');
const electron = fs.readFileSync(path.join(root, 'core', 'electron.js'), 'utf8');

function block(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, 'missing block: ' + start);
  return source.slice(from, to);
}

test('覆盖窗失焦保留显示区域，先穿透再通知渲染层确认新区域', () => {
  const blur = block(main, "mainWindow.on('blur'", 'const fitToScreen =');
  assert.doesNotMatch(blur, /applyOverlayShape\(\[\], false\)/, '失焦不能裁掉可见组件');
  assert.match(blur, /notifyOverlayBlur\(\)/);
  const notify = block(main, 'function notifyOverlayBlur()', 'let _overlayHiddenByWorkspace');
  const pendingAt = notify.indexOf('_overlayAwaitingShape = true');
  const ignoreAt = notify.indexOf('_setOverlayInputIgnored(true');
  const notifyAt = notify.indexOf("webContents.send('overlay-window-blur'");
  assert.ok(pendingAt >= 0 && ignoreAt > pendingAt, '同步失焦前应建立等待确认状态');
  assert.ok(notifyAt > ignoreAt, '原生安全闸应早于渲染层收起通知');
  const sync = block(main, 'function _syncOverlayInputNow()', 'function _startOverlayInputGuard()');
  assert.match(sync, /_overlayAwaitingShape/, '轮询不得在当前 revision 确认前恢复输入');
});

test('显式停放可选择使旧 revision 失效并清除待确认状态', () => {
  const park = block(main, 'function parkOverlayShape(invalidate = false)', 'function setOverlayIdleInput()');
  assert.match(park, /if \(invalidate\) _overlayShapeRevision\+\+/);
  assert.match(park, /_overlayAwaitingShape = false/);
  assert.match(park, /applyOverlayShape\(\[\], false\)/);
});

test('桌宠和竖条单独或同时显示时，主进程按真实组件区域持续守住鼠标穿透', () => {
  const apply = block(main, 'function applyOverlayShape(', 'function parkOverlayShape(');
  assert.match(apply, /_overlayShape\.resolve\(normalized, bounds\)/);
  assert.match(apply, /_overlayInputRects = normalized/);
  const sync = block(main, 'function _syncOverlayInputNow()', 'function _startOverlayInputGuard()');
  assert.match(sync, /screen\.getCursorScreenPoint\(\)/);
  assert.match(sync, /_overlayShape\.containsPoint/);
  assert.match(sync, /_setOverlayInputIgnored\(!inside\)/);
  const guard = block(main, 'function _startOverlayInputGuard()', 'function applyOverlayShape(');
  assert.match(guard, /_syncOverlayInputNow\(\)/);
  assert.doesNotMatch(sync + guard, /_overlayInputRects\.length [!=]==? 1/);
  assert.match(guard, /40/);
});

test('窗口销毁会停止输入守卫，避免后台残留轮询', () => {
  const closed = block(main, `mainWindow.on('closed'`, "mainWindow.webContents.on('render-process-gone'");
  assert.match(closed, /releaseWindowResources\(\)/);
  const release = block(main, 'function releaseWindowResources()', 'function reload()');
  assert.match(release, /clearInterval\(_overlayInputGuardTimer\)/);
  assert.match(closed, /_overlayInputRects = \[\]/);
});

test('repainting preserves the layered window; explicit shows restore its shape', () => {
  const redraw = block(main, 'function redrawOverlay()', 'function fixOverlayZoom(');
  assert.match(redraw, /webContents\.invalidate/);
  assert.doesNotMatch(redraw.slice(0, redraw.indexOf('function revealInitialOverlay')), /mainWindow\.(?:hide|showInactive|setAlwaysOnTop)\(/);
  const create = block(main, 'function createWindow()', '/* ----- Overlay IPC ----- */');
  const show = block(create, "mainWindow.on('show'", 'mainWindow.setAlwaysOnTop(');
  assert.match(show, /applyOverlayShape\(_lastOverlayRects, false\)/);
});

test('渲染层收到失焦通知后总会重新上报剩余桌面组件', () => {
  const handler = block(pet, 'soduWorkAPI.onOverlayWindowBlur(() => {', "pet.addEventListener('pointerdown'");
  assert.match(handler, /requestOverlayShapeSync\(240, true\)/);
  assert.doesNotMatch(handler, /if \(!taskArea \|\| !taskArea\.classList\.contains\('show'\)\) return/);
  const sync = block(electron, 'window.requestOverlayShapeSync=(trackMs,force)=>{', 'if(typeof window!==');
  assert.match(sync, /if\(force\)_lastShapeKey=null/);
});

test('heartbeat watchdog ignores a single busy or GC interval', () => {
  assert.match(main, /const HEARTBEAT_TIMEOUT_MS = 20000/);
  assert.match(main, /const HEARTBEAT_MISSES_REQUIRED = 2/);
  assert.match(main, /const UNRESPONSIVE_GRACE_MS = 15000/);
  assert.doesNotMatch(main, /webContents\.isResponsive\(\)/);
  assert.match(main, /_rendererUnresponsive/);
  assert.match(main, /_heartbeatMisses >= HEARTBEAT_MISSES_REQUIRED/);
  assert.match(main, /event\.sender !== mainWindow\.webContents/);
});

test('passive transparent overlay cannot retain the native keyboard focus', () => {
  const input = block(main, 'function _setOverlayInputIgnored(ignore)', 'function _syncOverlayInputNow()');
  assert.match(input, /setFocusable\(!next\)/);
  assert.match(input, /if \(next && typeof mainWindow\.blur === 'function'\) mainWindow\.blur\(\)/);
});
