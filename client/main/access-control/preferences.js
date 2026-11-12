'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const MODES = new Set(['standard', 'readonly', 'full']);
const CHANNEL = 'access-preferences-changed';
const file = app => path.join(app.getPath('userData'), 'access-preferences.json');
const pages = new Set(['desk.html', 'index.html'].map(name => pathToFileURL(path.join(__dirname, '../..', name)).pathname));
function isTrusted(event) {
  try {
    const sender = event?.sender, url = new URL(sender.getURL());
    return !sender.isDestroyed() && Boolean(sender.mainFrame) && event.senderFrame === sender.mainFrame &&
      url.protocol === 'file:' && pages.has(url.pathname);
  } catch { return false; }
}

function snapshot(app) {
  try {
    const value = JSON.parse(fs.readFileSync(file(app), 'utf8'));
    if (value.schema !== 1 || !MODES.has(value.mode) || !Number.isSafeInteger(value.revision) || value.revision < 0) throw Error('invalid');
    return { mode: value.mode === 'full' && value.fullConsentVersion !== 1 ? 'standard' : value.mode, revision: value.revision };
  } catch (error) {
    // A fresh profile uses the product default. Invalid/unreadable saved
    // preferences retain the existing conservative recovery behavior.
    return { mode: error?.code === 'ENOENT' ? 'full' : 'standard', revision: 0 };
  }
}
function save(app, mode, current) {
  const value = { schema: 1, mode, revision: current.revision + 1, fullConsentVersion: mode === 'full' ? 1 : 0 };
  const destination = file(app), temporary = destination + '.' + randomUUID() + '.tmp';
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
  return { mode: value.mode, revision: value.revision };
}
function broadcast(BrowserWindow, value) {
  if (!BrowserWindow?.getAllWindows) return;
  for (const window of BrowserWindow.getAllWindows()) {
    try { if (!window.isDestroyed()) window.webContents.send(CHANNEL, value); } catch { /* A closing window will refresh when reopened. */ }
  }
}
function rememberFromSession(app, mode, BrowserWindow) {
  if (!MODES.has(mode)) return { ok: false, reason: 'Invalid access mode' };
  const before = snapshot(app);
  if (before.mode === mode) return { ok: true, ...before };
  const value = save(app, mode, before);
  const result = { ok: true, ...value };
  broadcast(BrowserWindow, result);
  return result;
}
function forNewChat(app, options, interactive) {
  const opts = options || {};
  // Locally created requirements start new sessions and use system defaults; existing sessions and automation retain their original grants.
  if (!interactive || opts.chatId || opts.automationId || opts.accessMode) return opts;
  const support = require('../agent-runtime/runtime-catalog').runtime(opts.adapterId || 'pi')?.accessControl;
  if (!support?.supported) return opts;
  const mode = opts.mode === 'readonly' ? 'readonly' : snapshot(app).mode;
  return support.modes.includes(mode) ? { ...opts, accessMode: mode } : opts;
}
function hasFullConsent(app, options) {
  // Validate trusted desktop origin before calling; backend dispatch cannot obtain full access through this path.
  return !options.chatId && !options.automationId && snapshot(app).mode === 'full';
}
function install({ app, ipcMain, BrowserWindow, confirmFullAccess = require('./full-access-consent').confirm }) {
  let changing = false;
  ipcMain.handle('access-preferences-get', event => isTrusted(event)
    ? { ok: true, ...snapshot(app) } : { ok: false, reason: '请在设置页面修改默认授权模式' });
  ipcMain.handle('access-preferences-remember', (event, input) => {
    if (!isTrusted(event)) return { ok: false, reason: 'Please save access mode from SoduWork' };
    if (changing) return { ok: false, reason: 'Access confirmation is in progress' };
    return rememberFromSession(app, input?.mode, BrowserWindow);
  });
  ipcMain.handle('access-preferences-set', async (event, input) => {
    if (!isTrusted(event)) return { ok: false, reason: '请在设置页面修改默认授权模式' };
    if (changing) return { ok: false, reason: '正在确认权限，请稍候' };
    if (!MODES.has(input?.mode)) return { ok: false, reason: '请选择有效的授权模式' };
    changing = true;
    try {
      const before = snapshot(app);
      if (input.revision !== before.revision) return { ok: false, reason: '权限状态已变化，请重新选择', ...before };
      if (input.mode === before.mode) return { ok: true, ...before };
      if (input.mode === 'full') {
        const allowed = await confirmFullAccess(BrowserWindow.fromWebContents(event.sender), { scope: 'default' });
        if (allowed !== true) return { ok: false, cancelled: true, ...before };
      }
      if (!isTrusted(event) || snapshot(app).revision !== before.revision) return { ok: false, reason: '权限状态已变化，请重新选择' };
      return rememberFromSession(app, input.mode, BrowserWindow);
    } catch { return { ok: false, reason: '默认授权模式未保存，请重试' }; }
    finally { changing = false; }
  });
}
module.exports = { snapshot, forNewChat, hasFullConsent, isTrusted, rememberFromSession, install };
