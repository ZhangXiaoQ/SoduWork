/* Conversation environment and discovery handlers. No execution lifecycle state. */
const path = require('path');
const fs = require('fs');
const { shell } = require('electron');
const capabilities = require('../conversation/capabilities');
const nativeModelCatalog = require('../agent-runtime/native-model-catalog');
const conversationTitles = require('../conversation/titles');

const CAPABILITY_TIMEOUT_MS = 12000;
const CAPABILITY_WARMUP_TIMEOUT_MS = 8000;
function _withTimeout(value, timeoutMs, message) {
  let timer;
  const cancel = typeof clearTimeout === 'function' ? clearTimeout : () => {};
  if (typeof setTimeout !== 'function') return Promise.resolve(value);
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.code = 'CAPABILITY_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve(value), timeout]).finally(() => cancel(timer));
}

function awaitOpen(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(label);
      error.code = 'SODUWORK_OPEN_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
/* Read shared persisted session and workspace settings from the current app at call time. */
function createConfiguration(getApp) {
  const CONF = () => path.join(getApp().getPath('userData'), 'chat-config.json');
  function _conf() {
    try { return JSON.parse(fs.readFileSync(CONF(), 'utf8')) || {}; } catch (e) { return {}; }
  }
  function _saveConf(patch) {
    const next = { ..._conf(), ...patch };
    try { fs.writeFileSync(CONF(), JSON.stringify(next, null, 2), 'utf8'); } catch (e) { /* Continue if optional persistence fails. */ }
    return next;
  }
  function workDir(app) {
    const saved = String(_conf().workDir || '');
    const dir = saved || path.join(app.getPath('documents'), 'SoduWork');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* Let the caller report directory-creation failure. */ }
    return dir;
  }
  function _defaultCwd(app) { return workDir(app); }
  function _newSessionCwd(app, ref, opts) {
    const chosen = String((opts && opts.cwd) || '').trim();
    if (chosen) {
      const dir = path.resolve(chosen);
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) throw new Error('所选工作位置不是文件夹');
      return dir;
    }
    const dir = path.join(workDir(app), 'temp', ref);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  return { _conf, _saveConf, workDir, _defaultCwd, _newSessionCwd };
}

function install({ app, ipcMain, session, identityOf, capabilityGrantsOf, _skillDirs, workDir, _saveConf, _conf }) {
  /*
   * Probe policy and actual machine capability in the main process before opening a new
   * conversation; keep executable discovery and device identity out of the renderer.
   */
  ipcMain.handle('conversation-capabilities', async (event, options) => {
    try {
      const localPi = options?.adapterId === 'pi' && options?.executionLocation !== 'cloud';
      // SDK loading needs no credentials. Begin while identity is renewed,
      // rather than adding cold import time after a slow authentication call.
      // Keep the promise: a first send must never race the warmup that makes
      // the opening path feel like a frozen desktop window.
      const warmups = [];
      if (localPi && typeof session.loadSdk === 'function') {
        warmups.push(Promise.resolve(session.loadSdk(app)).catch(() => null));
      }
      // Package/extension discovery is independent of account identity. Keep
      // it in the same retained fence as the SDK/model warmup so the first
      // Send cannot enter a cold session and then sit in resource activation.
      if (localPi && typeof session.prewarmResources === 'function') {
        warmups.push(Promise.resolve(session.prewarmResources(app, { cwd: workDir(app) }))
          .catch(() => null));
      }
      const identity = await _withTimeout(identityOf(app), CAPABILITY_WARMUP_TIMEOUT_MS,
        'identity lookup timed out');
      // Capability catalogs are shared by every Agent and the settings page.
      // Only an explicitly selected local Pi composer should load the Pi SDK.
      // `prewarm` prepares model config as well as the SDK, and is awaited
      // together with capability discovery so the renderer can fence Send on
      // one authoritative readiness promise.
      if (localPi && typeof session.prewarm === 'function') {
        warmups.push(Promise.resolve(session.prewarm(app, identity, String(options.modelName || '')))
          .catch(() => null));
      }
      const skillDirs = typeof _skillDirs === 'function' ? _skillDirs(app) : [];
      const viewPromise = capabilities.inspect({
        app, identity, skillDirs,
        deviceGrants: capabilityGrantsOf ? capabilityGrantsOf(app) : [],
        forcePolicy: Boolean(options && options.force),
      });
      const [view] = await Promise.all([
        _withTimeout(viewPromise, CAPABILITY_TIMEOUT_MS, 'capability discovery timed out'),
        Promise.all(warmups.map((warmup) => _withTimeout(
          warmup, CAPABILITY_WARMUP_TIMEOUT_MS, 'Pi warmup timed out').catch(() => null))),
      ]);
      return {
        ok: true, policyOk: view.policyOk, policyReason: view.policyReason,
        items: view.items, skills: view.skillCatalog || view.businessSkills || [],
      };
    } catch (error) {
      return { ok: false, items: [], reason: String((error && error.message) || error) };
    }
  });

  /* Inspect, change, or open the workspace directory. */
  ipcMain.handle('pi-session-workdir', () => {
    const dir = workDir(app);
    return { ok: true, dir, name: path.basename(dir) };
  });
  function saveWorkdir(dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || !fs.statSync(dir).isDirectory()) {
      return { ok: false, reason: '所选工作位置不是文件夹' };
    }
    _saveConf({ workDir: dir });
    if (_conf().workDir !== dir) return { ok: false, reason: '无法保存工作目录，请重试' };
    return { ok: true, dir, name: path.basename(dir) };
  }
  ipcMain.handle('pi-session-save-workdir', async (_event, dir) => saveWorkdir(dir));
  ipcMain.handle('pi-session-pick-workdir', async (event, options = {}) => {
    const { dialog, BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(event.sender);
    const requested = typeof options?.defaultPath === 'string' ? options.defaultPath.trim() : '';
    const r = await dialog.showOpenDialog(win, require("../native-locale.cjs").dialogOptions({
      title: '选一个文件夹，AI 就在这儿干活',
      defaultPath: path.isAbsolute(requested) ? requested : workDir(app),
      properties: ['openDirectory', 'createDirectory'],
    }));
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const dir = r.filePaths[0];
    if (!fs.statSync(dir).isDirectory()) return { ok: false, reason: '所选工作位置不是文件夹' };
    return options?.persist === false ? { ok: true, dir, name: path.basename(dir) } : saveWorkdir(dir);
  });
  ipcMain.handle('pi-session-pick-cwd', async (event, options = {}) => {
    const { dialog, BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(event.sender);
    /* Start from the caller's previous choice (current session folder or the last
       hand-picked workspace) so changing the workspace does not jump back to the root. */
    const requested = typeof options?.defaultPath === 'string' ? options.defaultPath.trim() : '';
    const result = await dialog.showOpenDialog(win, require("../native-locale.cjs").dialogOptions({
      title: '选择本次会话直接使用的文件夹',
      defaultPath: path.isAbsolute(requested) ? requested : workDir(app),
      properties: ['openDirectory', 'createDirectory'],
    }));
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    const dir = result.filePaths[0];
    return { ok: true, dir, name: path.basename(dir) };
  });

  ipcMain.handle('pi-session-open-workdir', async () => {
    const err = await shell.openPath(workDir(app));
    return err ? { ok: false, reason: err } : { ok: true };
  });

  ipcMain.handle('pi-session-open-session-workdir', async (event, ref) => {
    const current = session.get(ref);
    if (!current) return { ok: false, reason: '会话不在了' };
    const err = await shell.openPath(current.cwd);
    return err ? { ok: false, reason: err } : { ok: true };
  });

  /* Remove write and execution tools in read-only mode using the SDK tool allowlist. */
  ipcMain.handle('pi-session-mode', (event, mode) => {
    if (mode === 'readonly' || mode === 'full') _saveConf({ mode });
    return { ok: true, mode: _conf().mode || 'full' };
  });

  ipcMain.handle('pi-session-probe', async (event, adapterId) => {
    try { return await session.probe(app, adapterId || 'pi'); }
    catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
  });

  ipcMain.handle('pi-session-runtimes', async (_event, options) => {
    try {
      if (options?.catalogOnly === true) return { ok: true, runtimes: session.runtimes() };
      if (typeof session.availableRuntimes === 'function') return await session.availableRuntimes(app, options || {});
      const catalog = session.runtimes();
      return { ok: true, runtimes: catalog,
        availableRuntimes: catalog.filter(row => row && row.id === 'pi'),
        missing: catalog.filter(row => row && row.id !== 'pi') };
    }
    catch (e) { return { ok: false, reason: String((e && e.message) || e), runtimes: [] }; }
  });
  ipcMain.handle('pi-session-runtime-models', (event, adapterId) => {
    try { return nativeModelCatalog.list(adapterId || ''); }
    catch (e) { return { ok: false, reason: String((e && e.message) || e), models: [] }; }
  });

  /* Conversation history for sidebar navigation. */
  ipcMain.handle('pi-session-history', async (_event, options) => {
    try {
      const access = require('../conversation/history-access');
      const local = options?.source === 'local';
      const account = options?.source === 'account';
      const profile = app.getPath('userData');
      const captured = local ? null : access.actor(app);
      if (account) access.assertCurrent(app, captured);
      const result = await session.history(app, local || account ? options : undefined);
      if (local) {
        if (app.getPath('userData') !== profile) throw Error('Local history workspace changed');
      } else access.assertCurrent(app, captured);
      const identity = require('../conversation/requirement-context').cachedIdentity(app);
      const rows = require('../conversation/work-conversation-cards').visibleHistory(app, result.chats || [], identity);
      return { ...result, chats: rows.map(row => conversationTitles.decorate(app,
        require('../conversation/requirement-context').decorate(app, row, identity))) };
    }
    catch (e) { return { ok: false, reason: String((e && e.message) || e), chats: [] }; }
  });

}
function entryContextPrompts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 4).map((item) => String(item || '').trim().slice(0, 16000)).filter(Boolean);
}
module.exports = { install, entryContextPrompts, awaitOpen, createConfiguration };
