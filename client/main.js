if (require('./main/app-preflight-entry.cjs').dispatch()) return;

const { app, BrowserWindow, WebContentsView, webContents, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut, Notification, shell, safeStorage, dialog, net, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('./main/managed-runtime.cjs').initialize(app);
const _distribution = require('./main/distribution.cjs');
/*
 * SODUWORK_USER_DATA isolates development credentials, sessions, and the single-instance lock.
 * Set it before any userData path consumers.
 */
require('./main/userdata-path.cjs').initializeUserData(app);
const _hubEndpoint = require('./main/hub-endpoint.cjs');
_hubEndpoint.initialize(app);
const _lifecycleDiagnostics = require('./main/lifecycle-diagnostics').install({ app });
const _runnerRuntime = require('./main/runner-runtime');
const _officeEngine = require('./main/conversation/office-engine');
const _deviceAuth = require('./main/device-auth');
const _cloudComputerCredentials = require('./main/cloud-computer-credentials.cjs');
const _clientUpdater = require('./main/client-updater');
const _installLayout = require('./main/install-layout');
const _nativeAppIcon = require('./main/native-app-icon.cjs').create({
  app, shell, profile: _distribution.current(), launchPath: executable => _installLayout.launchPath(executable), root: __dirname,
});
_nativeAppIcon.install();
const _updateWorkloads = require('./main/update-workloads');
/* Restore native workspace window placement through the shared window-state module. */
const _geom = require('./main/window-geometry');
/* Cache desktop visibility for startup; renderer cfg remains authoritative. */
const _flags = require('./main/desk-flags');
const _WORK_SPEC = require('./main/window-specs');
/* Local Pi sessions execute in a separate Agent Runtime process. The main process forwards requests,
   and the renderer displays snapshots. See the module headers in main/pi-session/. */
const _piSessionIpc = require('./main/pi-session/ipc');
require('./main/native-theme.cjs').install({ BrowserWindow, ipcMain });
require('./main/screenshot-service.cjs').install({ getRendererRoot: rendererRoot });
const _piSessions = require('./main/agent-runtime/pi-session-bridge');
const _catalogChanges = require('./main/agent-runtime/catalog-changes.cjs').create({
  session: _piSessions, contents: () => webContents.getAllWebContents(),
  invalidateModels: () => {
    require('./main/pi-session/model-config').invalidate();
    require('./main/agent-runtime/process-session').invalidateModels();
  },
});
require('./main/agent-runtime/process-session').installLifecycle(app, powerMonitor);
require('./main/computer-use/index.cjs').install({ app, BrowserWindow, screen, ipcMain, globalShortcut, powerMonitor, sessions: _piSessions, runner: _runnerRuntime });
const _workPreview = require('./main/work-preview');
const _workspaceState = require('./main/workspace-state.cjs').create({ ownerOf: () => {
  const owner = _deviceAuth.localOwner(app);
  return owner ? _hubEndpoint.current(app).hub + '|' + owner : '';
} });
const _attachmentFiles = require('./main/attachment-files');
const _libraryExternal = require('./main/library-external.cjs');
const _personalPlugins = require('./main/personal-plugins');
const _desktopOverlay = require('./main/desktop-overlay.cjs').create({
  app, BrowserWindow, ipcMain, screen, globalShortcut, Notification, powerMonitor,
  getRendererRoot: rendererRoot, getIcon: _appIcon, translate: _nativeText,
});
/* Keep a renderer failure local to its window. Work windows are separate
   BrowserWindows and historically had no crash listener, so a renderer crash
   while opening a large history or rendering a new turn left the customer
   with an apparently stopped client. The main process remains alive and
   reloads the affected window so the current route can recover. */
function attachWorkWindowRecovery(win, windowKey) {
  let crashes = 0;
  let resetTimer = null;
  win.webContents.on('render-process-gone', (_event, details) => {
    const reason = String(details && details.reason || 'unknown');
    console.error('[SAFETY] work window renderer crashed:', windowKey, reason);
    if (win.isDestroyed() || reason === 'clean-exit') return;
    crashes = crashes > 0 ? crashes + 1 : 1;
    if (resetTimer) clearTimeout(resetTimer);
    if (crashes > 3) {
      try { win.show(); win.focus(); } catch (_) {}
      return;
    }
    resetTimer = setTimeout(() => {
      resetTimer = null;
      if (win.isDestroyed()) return;
      try { win.webContents.reload(); win.show(); } catch (error) {
        console.error('[SAFETY] work window renderer recovery failed:', error);
      }
    }, Math.min(3000, 500 * crashes));
  });
  win.webContents.on('unresponsive', () => {
    console.warn('[SAFETY] work window renderer unresponsive:', windowKey);
  });
  win.on('closed', () => { if (resetTimer) clearTimeout(resetTimer); });
}

/* A rejected Pi/Runner callback must become a visible session error, never an
   uncaught exception that takes down Electron for every open conversation. */
process.on('uncaughtException', (error) => {
  console.error('[SoduWork] uncaught exception (kept alive):', error && error.stack || error);
});
process.on('unhandledRejection', (reason) => {
  _lifecycleDiagnostics.recordError('unhandled-rejection', reason);
  console.error('[SoduWork] unhandled rejection (kept alive):', reason && reason.stack || reason);
});

_deviceAuth.install({ app, ipcMain, safeStorage });
require('./main/client-domain-cache.cjs').install({ app, ipcMain, webContents, deviceAuth: _deviceAuth,
  modelsChanged: () => _catalogChanges.changed() });
require('./main/read-aloud.cjs').install({ app, ipcMain, BrowserWindow, getRendererRoot: rendererRoot });
require('./main/conversation/search.cjs').install({ app, ipcMain, BrowserWindow, getRendererRoot: rendererRoot });
const _releaseNotes = require('./main/release-notes').register({ app, ipcMain, BrowserWindow, root: __dirname, getRendererRoot: rendererRoot,
  identityOf: _deviceAuth.identity, authenticatedIdentityOf: _deviceAuth.authenticatedIdentity });
/* Per-account cloud computer connection settings stay in the encrypted main
   process. The renderer receives metadata only and never handles credentials. */
_cloudComputerCredentials.install({ app, ipcMain, deviceAuth: _deviceAuth, safeStorage });
const _applicationMenu = require('./main/app-menu-info.cjs').install({ app, ipcMain, BrowserWindow, dialog, shell,
  quit: _quitSoduWork, getRendererRoot: rendererRoot,
  releaseNotes: _releaseNotes,
  openNewConversation: () => openDeskWindow({ panel: 'workspace', view: 'create', tab: 'chat', newSession: true }, null) });
const _workspaceTitlebar = require('./main/workspace-titlebar.cjs').create({ app, ipcMain, BrowserWindow, Menu,
  getRendererRoot: rendererRoot, fallbackCommand: _applicationMenu.nativeCommand,
  getWorkspace: () => { openDeskWindow({ panel: 'workspace' }, null); return _workWindows.get('workspace'); } });
_runnerRuntime.install({ app, ipcMain, identityOf: _deviceAuth.identity });
require('./main/agent-runtime/custom-runtimes.cjs').install({ app, ipcMain, session: _piSessions,
  runner: _runnerRuntime, BrowserWindow, dialog, changed: _catalogChanges.changed });
async function _sessionIdentity(appRef, hub = '', clientId = '') {
  const id = _deviceAuth.identity(appRef, hub, clientId);
  if (!id) return null;
  try {
    const session = await _deviceAuth.ensureSession(appRef, id);
    return { ...id, session };
  } catch (_) {
    return id;  // staged migration: callers can still report the existing error path
  }
}
/* A mobile viewer may request this desktop's screen. The source is read-only,
   consent-gated, and kept in the main process so renderers cannot silently
   publish pixels or turn the channel into a control surface. */
const _remoteScreenSource = require('./main/remote-screen-source.cjs').create({
  app, dialog, identityOf: _deviceAuth.authenticatedIdentity,
});
app.on('will-quit', () => _remoteScreenSource.dispose());
const _onQuotaExceeded = (detail) => {
    _deviceAuth.clearSession(app, detail || {});
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win || win.isDestroyed()) return;
      try { win.webContents.send('device-auth-quota-exceeded', detail || {}); } catch (_) {}
    });
  };
const _authorizeAI = require('./main/conversation/quota-admission.cjs').create({
  app, identityOf: _deviceAuth.authenticatedIdentity, onQuotaExceeded: _onQuotaExceeded });
const _ordinaryConversations = _piSessionIpc.install({ app, ipcMain, BrowserWindow, identityOf: _sessionIdentity,
  sendIdentityOf: _deviceAuth.authenticatedIdentity,
  capabilityGrantsOf: _runnerRuntime.capabilityGrants,
  authorizeAI: _authorizeAI, onQuotaExceeded: _onQuotaExceeded });
_clientUpdater.install({ app, ipcMain, dialog: require('electron').dialog, BrowserWindow,
  shell: require('electron').shell,
  identityOf: _sessionIdentity, getWindow: () => _desktopOverlay.window,
  beforeExit: (reason) => _lifecycleDiagnostics.setExitReason(reason),
  localWorkloads: () => _updateWorkloads.snapshot(_piSessions),
  stopLocalWorkload: (ref) => _updateWorkloads.stop(_piSessions, ref),
  setLocalDrain: (value) => _updateWorkloads.setDraining(value) });
_workPreview.install({ ipcMain, BrowserWindow, WebContentsView, screen, shell, app, appIcon: _appIcon,
  authorizeAI: _authorizeAI,
  identityOf: _deviceAuth.identity, authenticatedIdentityOf: _deviceAuth.authenticatedIdentity });
require('./main/app-settings-ipc.cjs').install({ app, ipcMain, safeStorage,
  identityOf: _deviceAuth.authenticatedIdentity,
  ownerOf: () => { const id = _deviceAuth.identity(app), owner = _deviceAuth.localOwner(app); return id && owner ? id.hub + ':' + owner : ''; } });
_attachmentFiles.install({ app, ipcMain, BrowserWindow, dialog, net, shell, identityOf: _deviceAuth.identity,
  authenticatedIdentityOf: _deviceAuth.authenticatedIdentity });
_libraryExternal.install({ app, ipcMain, BrowserWindow, shell });
require('./main/library-local.cjs').install({ app, ipcMain, BrowserWindow, shell, dialog, nativeImage });
require('./main/pi-session/attachment-materialize').install({ app, ipcMain,
  identityOf: _deviceAuth.authenticatedIdentity, sessionOf: ref => _piSessions.get(String(ref || '')) });
require('./main/file-type-icons.cjs').install({ app, ipcMain });
_personalPlugins.install({ app, ipcMain, dialog: require('electron').dialog, safeStorage, identityOf: _sessionIdentity });
_runnerRuntime.setMobileCapabilities(require('./main/mobile-capabilities.cjs').create({
  app, identityOf: _deviceAuth.authenticatedIdentity, conversation: _ordinaryConversations }));
const _platformConnections = require('./main/platform-connections/index.cjs').install({ app, ipcMain, identityOf: _sessionIdentity, safeStorage, shell });
require('./main/automation-conversations').install({ app, ipcMain, identityOf: _sessionIdentity, conversation: _ordinaryConversations, platformConnections: _platformConnections });

// Allow notification audio triggered by WebSocket events without a user gesture.
// Set autoplay policy before app readiness so Web Audio can resume for application notifications.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Force grayscale text antialiasing to avoid subpixel-rendering flicker.
// Software-composited environments may lack hardware GPU support.
// GPU feature diagnostics identify software-compositing configurations.
// Repainting text in those configurations can switch antialiasing modes.
// The switch changes colored edges and apparent text weight.
// A process-wide grayscale policy keeps text rendering consistent across windows.
// Screenshot comparisons can verify that text edges no longer use colored subpixels.
app.commandLine.appendSwitch('disable-lcd-text');

let tray = null;
/* Current-user startup registration: enable once, then respect the tray setting.
   Development launches need the application directory as Electron's argument. */
const AUTOSTART_ARGS = app.isPackaged ? [] : [path.resolve(__dirname)];
function isAutostartOn() {
  try { return !!app.getLoginItemSettings({ path: _installLayout.launchPath(), args: AUTOSTART_ARGS }).openAtLogin; }
  catch (e) { return false; }
}
function setAutostart(on) {
  try { app.setLoginItemSettings({ openAtLogin: !!on, path: _installLayout.launchPath(), args: AUTOSTART_ARGS }); }
  catch (e) { console.error('[autostart] set failed:', e); }
}
function ensureAutostartDefault() {
  try {
    const marker = path.join(app.getPath('userData'), 'autostart-initialized');
    if (!fs.existsSync(marker)) { setAutostart(true); fs.writeFileSync(marker, '1'); }
  } catch (e) { console.error('[autostart] default failed:', e); }
}

// The renderer always belongs to the same complete client release.
function rendererRoot() { return __dirname; }

ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('hub-connection-info', () => _hubEndpoint.current(app));
ipcMain.on('client-distribution-info', event => { event.returnValue = _distribution.publicInfo(); });
/* Informational runtime badge only; connection selection stays in hub-endpoint. */
ipcMain.on('runtime-form', (event) => {
  event.returnValue = app.isPackaged ? 'packaged' : 'local-code';
});
/* Include hostname and operating-system username in device registration for recognizable administration labels. */
ipcMain.handle('sys-info', () => {
  const os = require('os');
  let username = '';
  try { username = os.userInfo().username || ''; } catch (e) {}
  return { hostname: os.hostname() || '', username, platform: process.platform, arch: process.arch };
});
/*
 * Create the default SoduWork workspace beneath the user home and expose it to renderer
 * settings. Users may override the local path.
 */
ipcMain.handle('work-root-default', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const root = path.join(os.homedir(), _distribution.current().workspaceName);
  try { fs.mkdirSync(root, { recursive: true }); } catch (e) { /* Return the path even if creation fails so the user can resolve the directory issue. */ }
  return root;
});
/* Allow only HTTP(S) external task links. */
ipcMain.handle('open-external', (e, url) => {
  try {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) { shell.openExternal(url); return { ok: true }; }
  } catch (err) { return { ok: false, error: String(err) }; }
  return { ok: false, error: 'invalid url' };
});

/* ----- Window creation ----- */











/* panel -> BrowserWindow. Standard application entries route to workspace; console and multi remain separate. */
const _workWindows = new Map();
const _fileOpenModule = require('./main/file-open.cjs');
const _fileOpen = _fileOpenModule.create({
  app, ipcMain, getWorkspace: () => _workWindows.get('workspace'),
  revealWorkspace: () => {
    const win = _workWindows.get('workspace');
    if (win && !win.isDestroyed()) revealWorkWindow(win);
    else openDeskWindow({ panel: 'workspace' }, null);
  },
  identityOf: () => _sessionIdentity(app),
  ownerOf: require('./main/platform-connections/runtime.cjs').connectionScope,
});







function revealWorkWindow(win) {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openDeskWindow(payload, sourceWin) {
  /* Close temporary task views when opening a native window, regardless of whether the OS changes focus. */
  _desktopOverlay.notifyBlur();
  const requested = payload || {};
  const panel = _WORK_SPEC[requested.panel] ? requested.panel : 'workspace';
  const p = panel === 'workspace' ? _workspaceState.resolve(requested) : requested;
  const spec = _WORK_SPEC[panel];
  /* Use separate configuration windows per object to preserve unsaved provider input. */
  const windowKey = panel === 'model-editor' && p.providerId
    ? panel + ':' + String(p.providerId) : panel;
  const existing = _workWindows.get(windowKey);
  if (existing && !existing.isDestroyed()) {
    revealWorkWindow(existing);
    /* panel-only calls are tray/taskbar "bring it back" actions. Do not turn
       them into a navigation event: the renderer already owns the current
       page and the process-local navigation record is used on a later reopen.
       Explicit view/task/chat targets still navigate the existing window. */
    const hasTarget = Object.keys(requested).some((key) => key !== 'panel');
    if (hasTarget) existing.webContents.send('desk-open', p);
    return;
  }
  /* Restore saved bounds only when they still intersect an available display. */
  const saved = _geom.get(panel);
  const restored = _geom.restore(saved, spec);
  const bounds = restored || _geom.initial(spec, sourceWin, [..._workWindows.values()]);
  const limits = _geom.limits(spec, bounds);
  const rendererDirectory = rendererRoot(), titlebarOptions = _workspaceTitlebar.windowOptions(rendererDirectory);
  const win = new BrowserWindow({
    ...bounds,
    minWidth: limits.minWidth,
    minHeight: limits.minHeight,
    title: panel === 'workspace' ? 'SoduWork' : 'SoduWork · ' + spec.title,
    backgroundColor: '#f3f6fb',



    icon: _appIcon(),
    /* Keep OS resizing and native window controls; the command row shares their titlebar. */
    frame: true,
    ...titlebarOptions,
    skipTaskbar: false,
    alwaysOnTop: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    }
  });
  _workWindows.set(windowKey, win);
  win.setMenuBarVisibility(false);
  _workspaceTitlebar.attach(win, titlebarOptions);
  /*
   * Keep the native workspace title as the product name; intercept document-title changes
   * and show page titles within content.
   */
  if (panel === 'workspace') {
    win.webContents.on('page-title-updated', (event) => {
      event.preventDefault();
      if (!win.isDestroyed()) win.setTitle('SoduWork');
    });
  }



  if (panel === 'workspace') {
    const syncOverlayToWorkspaceState = () => {
      if (win.isDestroyed()) return;
      try { _desktopOverlay.setWorkspaceMaximized(win.isMaximized() || win.isFullScreen()); }
      catch (e) { console.error('[desk] 同步桌宠显隐失败', e); }
    };
    for (const evt of ['maximize', 'unmaximize', 'minimize', 'restore', 'enter-full-screen', 'leave-full-screen']) {
      win.on(evt, syncOverlayToWorkspaceState);
    }
  }
  if (restored && saved.max) win.maximize();
  _geom.remember(panel, win);
  /*
   * Put initial page arguments in the URL to avoid losing desk-open before listeners exist.
   * Retain IPC for changing targets in already-open windows.
   */
  const q = { panel: panel };
  if (panel === 'workspace') {
    q.view = _workspaceState.valid(p.view) || 'create';
    if (p.workspaceRestore) q.workspaceRestore = p.workspaceRestore;
  } else if (p.view) q.view = String(p.view);
  if (p.taskId) q.taskId = String(p.taskId);
  if (p.providerId) q.providerId = String(p.providerId);
  if (p.teamEntry) q.teamEntry = String(p.teamEntry);
  if (p.chatId) q.chatId = String(p.chatId);
  if (p.tab) q.tab = String(p.tab);
  if (p.newSession) q.newSession = '1';
  if (p.createRequirement === true) q.createRequirement = '1';
  if (p.approvalId) q.approvalId = String(p.approvalId);
  if (p.console) q.console = '1';
  win.loadFile(path.join(rendererDirectory, 'desk.html'), { query: q });
  attachWorkWindowRecovery(win, windowKey);
  /*
   * Wait for explicit renderer readiness, not merely ready-to-show, with a 1.5-second
   * diagnostic fallback. URL arguments eliminate duplicate initial desk-open calls.
   */
  win._deskChromeReady = false;
  win._deskContentReady = false;
  win._deskShown = false;
  let revealTimer = null;
  win._revealDesk = (force) => {
    if (win.isDestroyed() || win._deskShown || !win._deskChromeReady ||
        (!win._deskContentReady && !force)) return false;
    win._deskShown = true;
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    win.show();
    return true;
  };
  win.once('ready-to-show', () => {
    win._deskChromeReady = true;
    if (!win._revealDesk(false)) revealTimer = setTimeout(() => win._revealDesk(true), 1500);
  });
  /*
   * Remove a closed window from the registry only if it is still the registered instance; a
   * delayed close event must not erase its replacement.
   */
  win.on('closed', () => {
    if (revealTimer) clearTimeout(revealTimer);
    if (_workWindows.get(windowKey) === win) _workWindows.delete(windowKey);
    /* Restore the pet and dock when closing a workspace that hid them while maximized. */
    if (panel === 'workspace') {
      try { _desktopOverlay.setWorkspaceMaximized(false); } catch (_e) { /* Application shutdown is in progress. */ }
    }
  });
}

/*
 * Remap the overlay and native regions after display or DPI changes; native shape clipping
 * bounds the visible compositor surface.
 */
/* System tray. */
/*
 * Use the full product icon for native windows; tray rendering trims its padding.
 */
function _appIcon() {
  return _nativeAppIcon.icon();
}

/*
 * Synchronize tray visibility and menu checkmarks after desktop preference changes.
 */
function applyDeskFlags(pushToRenderer) {
  const f = _flags.all();
  if (f.tray && !tray) createTray();
  else if (!f.tray && tray) { tray.destroy(); tray = null; }
  else if (tray) tray.setContextMenu(Menu.buildFromTemplate(_trayMenu()));






  if (pushToRenderer) {
    const payload = f;
    const flagTargets = [];
    for (const [, w] of _workWindows) { if (!w.isDestroyed()) flagTargets.push(w); }
    if (_desktopOverlay.window && !_desktopOverlay.window.isDestroyed()) flagTargets.push(_desktopOverlay.window);
    flagTargets.forEach((w) => {
      try { w.webContents.send('desk-flags-set', payload); } catch (e) { /* Window destruction is in progress. */ }
    });
  }
}

/*
 * Tray double-click opens the workspace without changing pet or dock visibility
 * preferences.
 */
function revealSoduWorkSuite() {
  if (!_desktopOverlay.window || _desktopOverlay.window.isDestroyed()) _desktopOverlay.createWindow();

  const pushFlags = () => {
    if (!_desktopOverlay.window || _desktopOverlay.window.isDestroyed()) return;
    if (!_desktopOverlay.window.isVisible()) {
      if (typeof _desktopOverlay.window.showInactive === 'function') _desktopOverlay.window.showInactive();
      else _desktopOverlay.window.show();
    }
    /* Restore only the main workspace; preserve pet and dock visibility. */
  };

  if (_desktopOverlay.emergency) {
    /* Emergency recovery reloads the page, so synchronize flags only after the replacement renderer is ready. */
    _desktopOverlay.window.webContents.once('did-finish-load', pushFlags);
    _desktopOverlay.recoverFromEmergency();
  } else if (_desktopOverlay.window.webContents.isLoading()) {
    _desktopOverlay.window.webContents.once('did-finish-load', pushFlags);
  } else {
    pushFlags();
  }
  openDeskWindow({ panel: 'workspace' }, null);
}

/*
 * Rebuild menu checkmarks from current flags each time.
 */
function _trayMenu() {
  const f = _flags.all();
  const flip = (key) => (item) => { _flags.merge({ [key]: item.checked }); applyDeskFlags(true); };
  return [
    {
      /* The main workspace is the first tray action. */
      label: _nativeText('打开主窗口'),
      click: () => { try { openDeskWindow({ panel: 'workspace' }, null); } catch (e) { console.error('[tray] 打开主窗口失败', e); } }
    },
    { type: 'separator' },
    {
      /* Expose desktop visibility preferences in the tray menu. */
      label: _nativeText('桌面显示'),
      submenu: [
        { label: _nativeText('快捷竖条'), type: 'checkbox', checked: f.dock, click: flip('dock') },
        { label: _nativeText('桌面小球'), type: 'checkbox', checked: f.pet, click: flip('pet') },
        { type: 'separator' },
        { label: _nativeText('托盘图标（这一个）'), type: 'checkbox', checked: f.tray, click: flip('tray') },
        { label: _nativeText('　└ 关掉后从主窗口的「我的 → 设置」里找回来'), enabled: false },
      ]
    },
    { type: 'separator' },
    {
      label: _nativeText('显示 SoduWork'),
      click: () => {
        if (_desktopOverlay.window) {
          if (_desktopOverlay.emergency) {
            _desktopOverlay.recoverFromEmergency();
          } else {
            _desktopOverlay.window.show();
            _desktopOverlay.window.focus();
          }
        }
      }
    },
    {
      label: _nativeText('隐藏 SoduWork'),
      click: () => {
        if (_desktopOverlay.window) _desktopOverlay.window.hide();
      }
    },
    { type: 'separator' },
    {
      /* Route the tray conversation action into the existing workspace. */
      label: _nativeText('🤖 新建对话'),
      click: () => {
        try { openDeskWindow({ panel: 'workspace', view: 'create', tab: 'chat', newSession: true }, null); }
        catch (e) { console.error('[workspace] 打开失败', e); }
      }
    },
    { type: 'separator' },
    {
      /* Group recovery actions for frozen or passthrough-blocked windows in a submenu. */
      label: _nativeText('故障恢复'),
      submenu: [
        {
          label: _nativeText('🚨 紧急解锁（鼠标穿透）'),
          click: () => { _desktopOverlay.emergencyPassthrough('用户通过托盘紧急解锁'); }
        },
        {
          label: _nativeText('🔄 强制重载（修复卡死）'),
          click: () => {
            _desktopOverlay.reload();
          }
        }
      ]
    },
    { type: 'separator' },
    {
      label: _nativeText('开机自启'),
      type: 'checkbox',
      checked: isAutostartOn(),
      click: (item) => { setAutostart(item.checked); }
    },
    { type: 'separator' },
    {
      label: _nativeText('退出 SoduWork'),
      click: () => _quitSoduWork('tray')
    }
  ];
}

function _quitSoduWork(reason) {
  if (tray) { tray.destroy(); tray = null; }
  _lifecycleDiagnostics.setExitReason(reason);
  app.quit();
}

function createTray() {
  const trayIcon = require('./main/tray-icon.cjs').createTrayIcon(nativeImage, path.join(__dirname, 'icon.png'));
  tray = new Tray(trayIcon);
  tray.setToolTip(_nativeText('SoduWork · 桌面任务助手'));

  /*
   * Tray recovery runs in the main process and remains available when the renderer is
   * unresponsive.
   */
  tray.setContextMenu(Menu.buildFromTemplate(_trayMenu()));

  /*
   * Tray left-click opens the workspace without toggling desktop visibility.
   */
  tray.on('click', () => {
    if (_desktopOverlay.emergency) { _desktopOverlay.recoverFromEmergency(); return; }
    try { openDeskWindow({ panel: 'workspace' }, null); }
    catch (e) { console.error('[tray] 打开主窗口失败', e); }
  });
  tray.on('double-click', () => {
    try { revealSoduWorkSuite(); }
    catch (e) { console.error('[tray] 恢复 SoduWork 桌面入口失败', e); }
  });
}

// Use the single-instance lock to focus the existing application on repeated launches.
const gotTheLock = app.requestSingleInstanceLock(
  _fileOpenModule.instanceData(process.argv, process.cwd(), app.isPackaged));
if (!gotTheLock) {
  _lifecycleDiagnostics.setExitReason('second-instance');
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory, additionalData) => {
    if (_fileOpen.enqueue(_fileOpenModule.instanceFiles(
      argv, workingDirectory, app.isPackaged, additionalData))) return;
    // Reveal the existing instance even when minimized or hidden.
    if (!_desktopOverlay.window || _desktopOverlay.window.isDestroyed()) { _desktopOverlay.createWindow(); return; }
    if (_desktopOverlay.emergency && typeof _desktopOverlay.recoverFromEmergency === 'function') { _desktopOverlay.recoverFromEmergency(); return; }
    if (_desktopOverlay.window.isMinimized()) _desktopOverlay.window.restore();
    if (!_desktopOverlay.window.isVisible()) _desktopOverlay.window.show();
    _desktopOverlay.window.focus();
    /*
     * On macOS, repeated application launches also restore the workspace; preserve the
     * existing Windows activation path.
     */
    if (process.platform === 'darwin') {
      try { openDeskWindow({ panel: 'workspace' }, null); }
      catch (e) { console.error('[second-instance] 打开主工作区失败', e); }
    }
  });

  _fileOpen.fromCommand(process.argv, process.cwd());
  app.whenReady().then(() => {
    /*
     * Adopt the Runner-managed office engine so client probes and child processes use the same
     * installation. Missing engines must not block startup.
     */
    try { _officeEngine.syncManagedOfficeCliEnv(); }
    catch (e) { console.warn('[office] managed engine adoption skipped:', e && e.message); }
    // Warm the device session, Pi SDK, and default model before the first
    // composer interaction.  The renderer can appear immediately, but a cold
    // install must never make the first Send wait for enrollment plus a large
    // ESM import.  All calls are coalesced with the normal renderer bootstrap
    // and failures remain observable through the regular send path.
    void (async () => {
      try {
        const pi = require('./main/agent-runtime/process-session');
        const skillRoots = require('./main/conversation/skill-roots');
        const skillDirs = await skillRoots.discoverAsync(app);
        // Start the expensive package/extension cache before device enrollment;
        // enrollment may take several seconds on a freshly installed client.
        const resourceWarmup = typeof pi.prewarmResources === 'function'
          ? pi.prewarmResources(app, { skillDirs,
            cwd: typeof _piSessionIpc._defaultCwd === 'function'
              ? _piSessionIpc._defaultCwd(app) : undefined }) : Promise.resolve();
        const stored = _deviceAuth.identity(app);
        if (!stored) { await resourceWarmup; return; }
        const session = await _deviceAuth.ensureSession(app, stored);
        const identity = { ...stored, session };
        await Promise.all([
          resourceWarmup,
          typeof pi.loadSdk === 'function' ? pi.loadSdk(app) : Promise.resolve(),
          typeof pi.prewarm === 'function' ? pi.prewarm(app, identity, '') : Promise.resolve(),
        ]);
      } catch (error) {
        // Offline starts and pending device activation must still open the UI;
        // the authoritative conversation open reports the actionable reason.
        console.warn('[startup] conversation warmup deferred:', error && error.message || error);
      }
    })();
    _workspaceTitlebar.installMenu();
    _desktopOverlay.start();
    ensureAutostartDefault();   // Enable login startup by default on first launch; the tray menu can disable it.
    _desktopOverlay.createWindow();
    /* Open the main workspace on startup. The overlay starts separately and follows saved pet and dock preferences. */
    openDeskWindow({ panel: 'workspace' }, null);
    _fileOpen.signal();
    /*
     * Use cached tray visibility before renderer startup to avoid flashing an explicitly
     * hidden icon.
     */
    if (_flags.all().tray) createTray();
    /*
     * Track recent overlay focus on macOS so pet interactions do not accidentally reopen the
     * workspace through activate.
     */
    let _overlayFocusAt = 0;
    if (process.platform === 'darwin') {
      app.on('browser-window-focus', (_event, win) => {
        if (win && !win.isDestroyed() && win === _desktopOverlay.window) _overlayFocusAt = Date.now();
      });
    }
    app.on('activate', () => {
      /* Apply this activation behavior only on macOS. */
      if (process.platform === 'darwin') {
        if (BrowserWindow.getAllWindows().length === 0) _desktopOverlay.createWindow();








        const overlayEngaged = Date.now() - _overlayFocusAt < 1000;
        if (!overlayEngaged) {
          try { openDeskWindow({ panel: 'workspace' }, null); }
          catch (e) { console.error('[activate] 打开主工作区失败', e); }
        }
        return;
      }
      if (BrowserWindow.getAllWindows().length === 0) {
        _desktopOverlay.createWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  // Keep the process available in the tray after windows close.
  // Explicit tray Quit exits the application.
});

/*
 * IPC channels.
 */

/*
 * Open or focus a native workspace or terminal window. Workspace pages use panel=workspace
 * and view; terminals use console or multi. taskId optionally selects a task.
 */
ipcMain.on('open-desk-window', (event, payload) => {
  try {
    openDeskWindow(payload || {}, BrowserWindow.fromWebContents(event.sender));
  } catch (e) {
    console.error('[desk] 打开工作窗口失败', e);
  }
});

/* The workspace renderer is disposable; the main process owns the last page
   so a tray reopen can restore it even after the renderer/localStorage is gone. */
_workspaceState.install({ ipcMain, BrowserWindow, getWorkspace: () => _workWindows.get('workspace') });

let _clientLocale = 'en-US';
const _nativeMessages = require('./main/native-locale.cjs');
function _nativeText(source) { return _nativeMessages.translate(source); }
ipcMain.on('client-locale', (_event, locale) => {
  const value = _nativeMessages.normalize(locale);
  if (_clientLocale === value) return;
  _clientLocale = value;
  _nativeMessages.setLocale(value);
  require('./main/agent-runtime/process-session').setLocale(value);
  _workspaceTitlebar.refreshMenu();
  if (tray && !tray.isDestroyed()) {
    tray.setContextMenu(Menu.buildFromTemplate(_trayMenu()));
    tray.setToolTip(_nativeText('SoduWork · 桌面任务助手'));
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('client-locale-changed', value);
  }
});
/* Compatibility IPC for older renderers. The main-process fixed-Hub policy
   rejects a foreign endpoint before touching conversations or Runner state. */
ipcMain.handle('hub-environment-select', (_event, hub) => {
  const selected = _deviceAuth.selectHub(app, hub);
  if (!selected.ok) return selected;
  try { _piSessions.closeAll(); } catch (_) {}
  void require('./main/agent-runtime/process-session').reset(app).catch(() => {});
  try { _runnerRuntime.pauseForHubChange(); } catch (_) {}
  return selected;
});

ipcMain.on('desk-content-ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || typeof win._revealDesk !== 'function') return;
  win._deskContentReady = true;
  win._revealDesk(false);
});

/*
 * Close only the requesting standalone work window after its explicit close action; ignore
 * requests from the desktop overlay.
 */
ipcMain.on('close-desk-window', (event) => {
  for (const [, w] of _workWindows) {
    if (!w.isDestroyed() && w.webContents === event.sender) { w.close(); return; }
  }
});

/*
 * Broadcast invalidations to every window except the sender. Receivers reread shared state
 * without writing it back, preventing feedback loops.
 */
ipcMain.on('soduwork-work-broadcast', (event, kind, payload) => {
  if (kind === 'models' || kind === 'agent-runtimes-changed') {
    if (!_catalogChanges.receive(event, kind)) return;
    if (kind === 'agent-runtimes-changed') return;
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents === event.sender) continue;
    try { w.webContents.send('soduwork-work-broadcast', kind, payload); } catch (e) { /* Window destruction is in progress. */ }
  }
});

/*
 * Update startup flags and tray state from renderer cfg without echoing the same values
 * back.
 */
ipcMain.on('desk-flags', (_event, flags) => {
  if (_flags.merge(flags).changed) applyDeskFlags(false);
});

/*
 * Capture the requesting window through webContents.capturePage using DIP coordinates and
 * return a PNG data URL. This accesses transparent-window compositor content directly.
 */
ipcMain.handle('window-capture', async (_e, rect) => {
  /*
   * Capture the sender's window rather than always capturing the desktop overlay.
   */
  const win = BrowserWindow.fromWebContents(_e.sender) || _desktopOverlay.window;
  if (!win || win.isDestroyed()) return null;
  const img = rect ? await win.webContents.capturePage(rect)
                   : await win.webContents.capturePage();
  return img.toDataURL();
});

ipcMain.handle('screen-get-size', () => {
  return screen.getPrimaryDisplay().workAreaSize;
});

/* Unregister global shortcuts on exit. */
app.on('will-quit', () => {
  // Electron can emit will-quit while startup is being aborted (for example
  // after another instance owns the profile lock). The globalShortcut module
  // rejects calls before app ready; cleanup must remain safe on that path.
  if (app.isReady()) globalShortcut.unregisterAll();
});
