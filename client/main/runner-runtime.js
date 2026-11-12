/*
 * Manage the bundled Runner lifecycle. Packaged builds prefer the current executable with
 * legacy-name fallback; development uses the backend environment. Persist only nonsecret
 * configuration, inject device keys into child environments, restart failed Runners, and
 * stop them with the client.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let _proc = null;
let _restartTimer = null;
let _wanted = false;
let _quitting = false;
let _lastError = '';
let _connectionState = 'stopped';
let _lastConfig = '';
let _identityOf = null;
const _ownedRunners = new Map();
const _runnerStops = new Set();
const LOCAL_RPC_PREFIX = '@@SODUWORK_LOCAL_RPC@@';
const STATUS_PREFIX = '@@SODUWORK_RUNNER_STATUS@@';
const CONNECTION_ERRORS = Object.freeze({
  AUTH_REQUIRED: '本机 Runner 的设备登记未通过，请重新登录后重试。',
  HANDSHAKE_TIMEOUT: '本机 Runner 已启动，但后台尚未确认上线，正在自动重连。',
  CONNECTION_FAILED: '本机 Runner 无法连接后台，请检查网络连接；恢复后会自动重连。',
  IDENTITY_CONFLICT: '升级后的设备身份与旧 Runner 登记不一致，正在恢复本机连接。',
  IDENTITY_STORAGE_FAILED: '本机 Runner 无法保存设备身份，请检查客户端数据目录的写入权限和磁盘空间。',
  IDENTITY_RECOVERY_FAILED: '本机 Runner 身份恢复失败，请联系管理员检查设备登记。',
});
const _rpcPending = new Map();
let _rpcSeq = 0;
let _stdoutRest = '';
const CAPABILITY_KEYS = new Set(['browser', 'computer']);
const CAPABILITY_GRANT_VERSION = 2;
const DEFAULT_CAPABILITY_GRANTS = Object.freeze(['browser']);
/* Chat sessions and the embedded Runner are separate trust boundaries. Chat puts
   its private Pi directory plus short-lived model/MCP tickets in process.env.
   A restarted Runner must not inherit those values: it would read the wrong
   models.json and leak one chat's credentials into later jobs. Job credentials
   are delivered by the Hub for each dispatch. */
const RUNNER_ENV_DENY = Object.freeze([
  'PI_CODING_AGENT_DIR',
  'SODUWORK_PROXY_KEY', 'SODUWORK_MCP_KEY', 'SODUWORK_HUB_ORIGIN',
  'SODUWORK_MCP_SERVERS', 'SODUWORK_MCP_SERVERS_JSON', 'SODUWORK_LLM_KEY',
  'SODUWORK_BUNDLED_PI_CLI', 'SODUWORK_BUNDLED_NODE',
  'SODUWORK_GIT_USER', 'SODUWORK_GIT_TOKEN',
  'OPENCODE_CONFIG_CONTENT', 'SODUWORK_BUNDLED_OPENCODE', 'SODUWORK_BUNDLED_SHELL',
  'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE',
]);
// Desktop startup is authorized by its private config pipe and device identity.
// Standalone Runner environment options must not override another app instance.
const RUNNER_INSTANCE_ENV_DENY = Object.freeze([
  'SODUWORK_HUB', 'SODUWORK_CLIENT_ID', 'SODUWORK_DATA_ROOT', 'SODUWORK_WORK_ROOT',
  'SODUWORK_RUNNER_ID', 'SODUWORK_RUNNER_KEY', 'SODUWORK_RUNNER_TOKEN', 'SODUWORK_DEVICE_SECRET',
  'SODUWORK_RUNNER_TAGS', 'SODUWORK_RUNNER_MAX_CONCURRENT', 'SODUWORK_HUB_HTTP_BASE',
]);

function _bundledPi(app, resourceRoot = process.resourcesPath) {
  if (!app) return null;
  // Source launches share the installed Pi dependency with native chats.
  const root = app.isPackaged ? resourceRoot : app.getAppPath?.();
  if (!root) return null;
  const cli = path.join(root, ...(app.isPackaged ? ['pi', 'node_modules'] : ['node_modules']),
    '@earendil-works',
    'pi-coding-agent', 'dist', 'cli.js');
  const node = process.execPath;
  if (!fs.existsSync(cli) || !fs.existsSync(node)) return null;
  return { cli, node };
}

/*
 * Pass the bundled PortableGit root to Runner so dispatched tasks can find Bash on
 * machines without Git. Existing machine Bash installations retain precedence.
 */
function _bundledShell(app, resourceRoot = process.resourcesPath) {
  if (!app) return null;
  const base = app.isPackaged ? resourceRoot : app.getAppPath?.();
  if (!base) return null;
  const root = app.isPackaged ? path.join(base, 'shell') : path.join(base, '.runtime', 'git');
  return fs.existsSync(path.join(root, 'bin', 'bash.exe')) ? root : null;
}

function _skillRoots(app, resourceRoot = process.resourcesPath) {
  const roots = [];
  if (app && app.isPackaged && resourceRoot) {
    roots.push(path.join(resourceRoot, 'skills'));
  }
  try {
    roots.push(path.join(app.getPath('userData'), 'skills'));
  } catch (_) { /* test/minimal app */ }
  return Array.from(new Set(roots.map((root) => path.resolve(root))));
}

function _runnerEnv(base, deviceSecret, app, resourceRoot) {
  const env = { ...(base || {}) };
  const denied = new Set([...RUNNER_ENV_DENY, ...RUNNER_INSTANCE_ENV_DENY]);
  Object.keys(env).forEach(key => { if (denied.has(key.toUpperCase())) delete env[key]; });
  env.SODUWORK_DEVICE_SECRET = String(deviceSecret || '');
  /*
   * Expose the local personal-plugin store for read-only current-version resolution by
   * scheduled Runner tasks; plugin content stays local.
   */
  try {
    env.SODUWORK_PERSONAL_PLUGINS = path.join(app.getPath('userData'), 'personal-plugins.json');
  } catch (_) { /* Treat test app objects without getPath as having no personal-plugin store. */ }
  const bundled = _bundledPi(app, resourceRoot);
  if (bundled) {
    env.SODUWORK_BUNDLED_PI_CLI = bundled.cli;
    env.SODUWORK_BUNDLED_NODE = bundled.node;
  }
  const shellRoot = _bundledShell(app, resourceRoot);
  if (shellRoot) env.SODUWORK_BUNDLED_SHELL = shellRoot;
  env.SODUWORK_SKILL_ROOTS = _skillRoots(app, resourceRoot).join(path.delimiter);
  const managed = require('./managed-runtime.cjs');
  const root = managed.runtimeRoot(app, resourceRoot || process.resourcesPath);
  return root ? managed.environment(env, { resourcesPath: root }) : env;
}
const INSTALLABLE_COMPONENTS = Object.freeze({
  office: {
    label: '开源办公文档适配器',
    detail: '可选安装 Apache-2.0 本地文档适配器，写入 Runner 私有目录，不使用托管额度。已有免费 Python 文档引擎时无需安装。',
  },
});

function _dir(app) {
  return path.join(app.getPath('userData'), 'runner');
}

function _configPath(app) {
  return path.join(_dir(app), 'config.json');
}

function _writeConfig(app, encoded) {
  const dir = _dir(app);
  const file = _configPath(app);
  const next = file + '.next';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(next, encoded, { encoding: 'utf8', mode: 0o600 });
  try { fs.renameSync(next, file); }
  catch (e) {
    /* Use copying when managed filesystems reject same-directory rename with EXDEV. */
    if (e && e.code === 'EXDEV') {
      fs.copyFileSync(next, file);
      fs.rmSync(next, { force: true });
    } else {
      try { fs.unlinkSync(next); } catch (_) {}
      throw e;
    }
  }
}

function _rawConfig(app) {
  try { return JSON.parse(fs.readFileSync(_configPath(app), 'utf8')) || {}; }
  catch (e) { return {}; }
}

function _grants(value) {
  const source = Array.isArray(value) ? value : DEFAULT_CAPABILITY_GRANTS;
  return Array.from(new Set(source.map((v) => String(v || '').trim().toLowerCase())
    .filter((v) => CAPABILITY_KEYS.has(v))));
}

function capabilityGrants(app) {
  return _grants(_migrateRaw(_rawConfig(app)).capabilityGrants);
}

function _migrateRaw(value) {
  const raw = value && typeof value === 'object' ? { ...value } : {};
  const version = Number(raw.capabilityGrantVersion) || 0;
  if (version >= CAPABILITY_GRANT_VERSION) return raw;
  /*
   * Remove obsolete office-specific grants during upgrade; workspace document delivery uses
   * ordinary file permissions.
   */
  raw.capabilityGrants = _grants(raw.capabilityGrants).filter((key) => key !== 'office');
  raw.capabilityGrantVersion = CAPABILITY_GRANT_VERSION;
  return raw;
}

function _mergeRaw(existing, incoming) {
  const before = existing && typeof existing === 'object' ? existing : {};
  const patch = incoming && typeof incoming === 'object' ? incoming : {};
  const next = { ...before, ...patch };
  // A window may register before its asynchronous default-directory lookup
  // completes. An empty sync must not erase a previously selected workspace.
  if (!String(patch.workRoot || '').trim() && before.workRoot) {
    next.workRoot = before.workRoot;
  }
  if (!Object.prototype.hasOwnProperty.call(patch, 'capabilityGrants')) {
    next.capabilityGrants = Object.prototype.hasOwnProperty.call(before, 'capabilityGrants')
      ? before.capabilityGrants : DEFAULT_CAPABILITY_GRANTS;
  }
  return next;
}

function _prepareWorkRoot(workRoot) {
  const root = String(workRoot || '').trim();
  if (!root) return;
  try {
    // Prepare the user's chosen directory before the first capability report.
    // Otherwise the files gate prevents the very first job from creating it.
    fs.mkdirSync(root, { recursive: true });
    if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
    fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    throw new Error('工作目录不可用：' + root + '（' + String(error && error.message || error) + '）');
  }
}

function _clean(raw, dataRoot = '', secureIdentity = null) {
  const x = raw || {};
  const id = secureIdentity || {};
  const hub = String(id.hub || x.hub || '').trim().replace(/\/+$/, '');
  const clientId = String(id.clientId || x.clientId || '').trim().slice(0, 64);
  const secret = String(id.secret || '').trim().slice(0, 256);
  const workRoot = String(x.workRoot || '').trim().slice(0, 500);
  /*
   * Tag the bundled Runner through the existing configuration contract so scheduling can
   * prefer the active desktop client over server or build-machine Runners.
   */
  const tags = Array.from(new Set((Array.isArray(x.tags) ? x.tags : [])
    .map((v) => String(v || '').trim().toLowerCase()).filter(Boolean).concat('soduwork-client'))).slice(0, 20);
  if (!/^https?:\/\//i.test(hub)) throw new Error('后台地址必须以 http:// 或 https:// 开头');
  if (!clientId || !secret) throw new Error('设备身份还没准备好');
  return { hub, clientId, secret, workRoot, tags,
    capabilityGrantVersion: CAPABILITY_GRANT_VERSION,
    capabilityGrants: _grants(x.capabilityGrants),
    dataRoot: String(dataRoot || x.dataRoot || '').trim() };
}

function _stored(cfg) {
  return { hub: cfg.hub, clientId: cfg.clientId, workRoot: cfg.workRoot,
    tags: cfg.tags, capabilityGrantVersion: CAPABILITY_GRANT_VERSION,
    capabilityGrants: cfg.capabilityGrants, dataRoot: cfg.dataRoot };
}

function _spec(app) {
  if (app.isPackaged) {
    if (process.platform === 'win32') {
      const names = ['soduwork-runner.exe'];
      const bins = names.map(name => path.join(process.resourcesPath, 'runner', name));
      return { bin: bins.find(candidate => fs.existsSync(candidate)) || bins[0], args: [] };
    }
    const posixNames = ['soduwork-runner'];
    const posixBins = posixNames.map(name => path.join(process.resourcesPath, 'runner', name));
    return { bin: posixBins.find(candidate => fs.existsSync(candidate)) || posixBins[0], args: [] };
  }
  const clientRoot = path.dirname(__dirname);
  const backend = path.resolve(clientRoot, '..', 'hub-backend');
  const python = process.platform === 'win32'
    ? path.join(backend, '.venv', 'Scripts', 'python.exe')
    : path.join(backend, '.venv', 'bin', 'python');
  return {
    bin: python,
    args: [path.join(backend, 'runner_main.py')],
  };
}

function _readConfig(app) {
  try {
    const file = _configPath(app);
    let encodedFile;
    try { encodedFile = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      // First launch has no Runner configuration yet. Keep genuine read,
      // workspace and connection failures visible; only absence is normal.
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    const raw = JSON.parse(encodedFile);
    const migrated = _migrateRaw(raw);
    const id = _identityOf ? _identityOf(app, raw.hub, raw.clientId) : null;
    const clean = _clean(migrated, path.join(_dir(app), 'data'), id);
    _prepareWorkRoot(clean.workRoot);
    const encoded = JSON.stringify(_stored(clean));
    /*
     * Persist configuration migrations before spawning Runner. Updating only memory can let it
     * register stale settings while later comparisons incorrectly suppress restart.
     */
    if (JSON.stringify(raw) !== encoded) {
      _writeConfig(app, encoded);
    }
    return clean;
  }
  catch (e) { _lastError = String(e && e.message || e); return null; }
}

function _rejectRpc(message = 'Runner stopped') {
  const error = message instanceof Error ? message : new Error(String(message || 'Runner stopped'));
  for (const pending of _rpcPending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  _rpcPending.clear();
}

let _mobileCapabilities = null;
function setMobileCapabilities(handler) { _mobileCapabilities = handler; }

function _consumeRunnerOutput(chunk, logPath, child = _proc) {
  _stdoutRest += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
  const lines = _stdoutRest.split(/\r?\n/);
  _stdoutRest = lines.pop() || '';
  const logLines = [];
  lines.forEach((line) => {
    if (line.startsWith(STATUS_PREFIX)) {
      try {
        const status = JSON.parse(line.slice(STATUS_PREFIX.length));
        if (['connecting', 'online', 'error'].includes(status.state)) {
          _connectionState = status.state;
          if (status.state === 'online') _lastError = '';
          else if (status.state === 'error') _lastError = CONNECTION_ERRORS[status.code] || CONNECTION_ERRORS.CONNECTION_FAILED;
        }
      } catch (_) { /* Ignore malformed status, never arbitrary peer text. */ }
      return;
    }
    if (!line.startsWith(LOCAL_RPC_PREFIX)) {
      if (line) logLines.push(line);
      return;
    }
    try {
      const packet = JSON.parse(line.slice(LOCAL_RPC_PREFIX.length));
      if (packet.kind === 'desktop-capability') {
        const reply = result => {
          if (child !== _proc || child.killed || !child.stdin?.writable) return;
          child.stdin.write(LOCAL_RPC_PREFIX + JSON.stringify({ id: 'desktop-' + packet.id,
            message: { op: 'desktop.capability.reply', requestId: packet.id, result } }) + '\n');
        };
        Promise.resolve().then(() => {
          if (child !== _proc || !_mobileCapabilities) throw Error('电脑能力尚未准备好，请稍后刷新');
          return _mobileCapabilities(packet.body);
        }).then(data => reply({ ok: true, data }), error => reply({ ok: false, error: String(error.message || error) }));
        return;
      }
      const pending = _rpcPending.get(String(packet.id || ''));
      if (!pending) return;
      _rpcPending.delete(String(packet.id || ''));
      clearTimeout(pending.timer);
      if (packet.ok) pending.resolve(packet.result || {});
      else pending.reject(new Error(String(packet.error || 'Runner request failed')));
    } catch (error) {
      logLines.push('[local-rpc] invalid response: ' + String(error && error.message || error));
    }
  });
  if (logLines.length) {
    fs.appendFile(logPath, logLines.join('\n') + '\n', () => {});
  }
}

function rpc(op, payload = {}, timeoutMs = 30000) {
  const child = _proc;
  if (!child || child.killed || !child.stdin || !child.stdin.writable) {
    return Promise.reject(Object.assign(new Error(_lastError || 'Runner is not running'), {
      code: 'RUNNER_NOT_RUNNING',
    }));
  }
  const id = Date.now().toString(36) + '-' + (++_rpcSeq).toString(36);
  const message = { ...(payload && typeof payload === 'object' ? payload : {}), op: String(op || '') };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _rpcPending.delete(id);
      reject(new Error('Runner request timed out'));
    }, Math.max(1000, Number(timeoutMs) || 30000));
    _rpcPending.set(id, { resolve, reject, timer });
    const line = LOCAL_RPC_PREFIX + JSON.stringify({ id, message }) + '\n';
    child.stdin.write(line, 'utf8', (error) => {
      if (!error) return;
      const pending = _rpcPending.get(id);
      if (!pending) return;
      _rpcPending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    });
  });
}

function _retire(child) {
  const lifecycle = _ownedRunners.get(child);
  if (!lifecycle) return Promise.resolve();
  _ownedRunners.delete(child);
  const work = lifecycle.stop().catch(error => {
    console.warn('[runner] Owned process cleanup failed:', error.message);
  }).finally(() => _runnerStops.delete(work));
  _runnerStops.add(work);
  return work;
}

function _stop() {
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  _rejectRpc('Runner stopped');
  _stdoutRest = '';
  const p = _proc;
  _proc = null;
  _connectionState = 'stopped';
  return _retire(p);
}

function _schedule(app) {
  if (_quitting || !_wanted || _restartTimer) return;
  _restartTimer = setTimeout(() => {
    _restartTimer = null;
    _start(app);
  }, 5000);
}

function _start(app) {
  if (_quitting || !_wanted || (_proc && !_proc.killed)) return;
  const cfg = _readConfig(app);
  if (!cfg) { if (!_lastError) _lastError = 'runner 配置还没准备好'; return; }
  const spec = _spec(app);
  if (!fs.existsSync(spec.bin) || spec.args.some((x) => !fs.existsSync(x))) {
    _lastError = app.isPackaged ? '安装包里没有 runner 运行时'
      : !fs.existsSync(spec.bin)
        ? '开发环境缺少 Runner Python：请创建 hub-backend/.venv，并安装 requirements-runner.txt 中的依赖'
        : '开发环境缺少 hub-backend/runner_main.py，请检查工程文件是否完整';
    _connectionState = 'error';
    return;
  }
  const dir = _dir(app);
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, 'runner.log');
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1024 * 1024) {
      fs.renameSync(logPath, path.join(dir, 'runner.prev.log'));
    }
  } catch (e) { /* Log rotation failure must not block startup. */ }
  let fd = null;
  try {
    fd = fs.openSync(logPath, 'a');
    const child = spawn(spec.bin, [...spec.args, '--config-stdin'], {
      cwd: path.dirname(spec.bin), windowsHide: true,
      stdio: ['pipe', 'pipe', fd], shell: false,
      env: _runnerEnv(process.env, cfg.secret, app),
    });
    _proc = child;
    if (Number.isInteger(child.pid)) {
      _ownedRunners.set(child, require('./runner-process-lifecycle.cjs').supervise(child));
    }
    _connectionState = 'connecting';
    if (child.stdout) child.stdout.on('data', (chunk) => {
      if (_proc === child) _consumeRunnerOutput(chunk, logPath);
    });
    if (child.stdin) child.stdin.on('error', (error) => {
      if (_proc === child) _rejectRpc(error);
    });
    // The same private pipe already owns local RPC. Pass one bounded startup
    // frame before any RPC; the Runner never reopens an Electron-written JSON.
    child.stdin.write('@@SODUWORK_RUNNER_CONFIG@@' + JSON.stringify({ ..._stored(cfg),
      customAgents: require('./agent-runtime/custom-runtime-store.cjs').startupAgents(app) }) + '\n', 'utf8');
    child.once('error', (e) => {
      if (_proc !== child) return;
      _lastError = String(e && e.message || e);
      _connectionState = 'error';
      _proc = null;
      _rejectRpc(e);
      _stdoutRest = '';
      _schedule(app);
    });
    child.once('exit', (code) => {
      void _retire(child);
      // A reconfigure may already have started the replacement.  The old
      // child's late exit must not erase or duplicate that new runner.
      if (_proc !== child) return;
      _proc = null;
      _connectionState = 'error';
      if (!_lastError) _lastError = '本机 Runner 已退出（' + String(code ?? '未知') + '），正在自动重启。';
      _rejectRpc('Runner exited');
      _stdoutRest = '';
      _schedule(app);
    });
  } catch (e) {
    _proc = null;
    _lastError = String(e && e.message || e);
    _schedule(app);
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} }
  }
}

/*
 * Read device identity from main-process secure storage and never persist keys in Runner
 * configuration. Return null until registration is available.
 */
function identity(app) {
  return _identityOf ? _identityOf(app) : null;
}

/* Environment switching is a connection-boundary operation. Stop the old
   runner immediately; the renderer will configure and start a replacement only
   after the selected Hub has its own secure device identity. */
function pauseForHubChange() {
  _wanted = false;
  _lastError = '';
  _lastConfig = '';
  _stop();
}

function _applyConfig(app, raw) {
  try {
    const merged = _mergeRaw(_migrateRaw(_rawConfig(app)), raw);
    const id = _identityOf
      ? _identityOf(app, merged && merged.hub, merged && merged.clientId) : null;
    const cfg = _clean(merged, path.join(_dir(app), 'data'), id);
    _prepareWorkRoot(cfg.workRoot);
    const encoded = JSON.stringify(_stored(cfg));
    _writeConfig(app, encoded);
    _wanted = true;
    if (encoded !== _lastConfig) {
      _lastConfig = encoded;
      _stop();
    }
    _start(app);
    // Only a confirmed Hub welcome clears connection failures. A live process
    // alone can be stuck retrying authentication or registration indefinitely.
    if (_connectionState === 'online') _lastError = '';
    return {
      ok: true, running: !!_proc, pid: _proc ? _proc.pid : 0,
      error: _lastError, capabilityGrants: cfg.capabilityGrants,
    };
  } catch (e) {
    _lastError = String(e && e.message || e);
    return { ok: false, running: false, error: _lastError };
  }
}

function install({ app, ipcMain, identityOf }) {
  _identityOf = identityOf || null;
  ipcMain.handle('runner-configure', async (_event, raw) => _applyConfig(app, raw || {}));
  ipcMain.handle('runner-capability-set', async (event, rawKey, enabled) => {
    const key = String(rawKey || '').trim().toLowerCase();
    if (!CAPABILITY_KEYS.has(key)) {
      return { ok: false, error: '这项基础能力不存在' };
    }
    if (key === 'computer' && enabled) {
      const { BrowserWindow, dialog } = require('electron');
      const parent = BrowserWindow.fromWebContents(event.sender);
      const options = {
        type: 'warning',
        title: '授权 SoduWork 操作这台电脑',
        message: '允许 AI 操作这台电脑？',
        detail: '开启后，只有企业已开放、任务明确需要且本机 Runner 承接的工作才能使用桌面控制。登录、密码、支付、删除和发送等高风险动作仍会被操作护栏拦截。',
        buttons: ['取消', '允许本机操作'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const choice = parent
        ? await dialog.showMessageBox(parent, require("./native-locale.cjs").dialogOptions(options))
        : await dialog.showMessageBox(require("./native-locale.cjs").dialogOptions(options));
      if (!choice || choice.response !== 1) return { ok: false, canceled: true };
    }
    const raw = _rawConfig(app);
    if (!raw.hub || !raw.clientId) {
      return { ok: false, error: '本机 Runner 还没有连接企业后台' };
    }
    const grants = new Set(_grants(raw.capabilityGrants));
    if (enabled) grants.add(key);
    else grants.delete(key);
    return _applyConfig(app, { capabilityGrants: [...grants] });
  });
  ipcMain.handle('runner-component-confirm', async (event, rawKey) => {
    const key = String(rawKey || '').trim().toLowerCase();
    const spec = INSTALLABLE_COMPONENTS[key];
    if (!spec) return { ok: false, error: '这项能力不支持自动安装' };
    const { BrowserWindow, dialog } = require('electron');
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options = {
      type: 'info',
      title: '给本机 Runner 安装能力',
      message: '安装' + spec.label + '？',
      detail: spec.detail,
      buttons: ['取消', '安装并测通'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    };
    const choice = parent
      ? await dialog.showMessageBox(parent, require("./native-locale.cjs").dialogOptions(options))
      : await dialog.showMessageBox(require("./native-locale.cjs").dialogOptions(options));
    return choice && choice.response === 1 ? { ok: true } : { ok: false, canceled: true };
  });
  ipcMain.handle('runner-status', () => ({
    running: !!(_proc && !_proc.killed), pid: _proc ? _proc.pid : 0, error: _lastError,
    connected: !!_proc && _connectionState === 'online', state: _connectionState,
    capabilityGrants: capabilityGrants(app),
  }));
  app.whenReady().then(() => {
    const cfg = _readConfig(app);
    if (cfg) {
      _lastConfig = JSON.stringify(_stored(cfg));
      _wanted = true;
      _start(app);
    }
  });
  let quitReady = false, quitWork = null;
  app.on('before-quit', event => {
    _quitting = true;
    _wanted = false;
    _stop();
    if (quitReady || !_runnerStops.size) return;
    event.preventDefault();
    if (!quitWork) quitWork = Promise.allSettled([..._runnerStops]).finally(() => {
      quitReady = true;
      app.quit();
    });
  });
}

module.exports = {
  install, identity, pauseForHubChange, capabilityGrants, rpc, setMobileCapabilities,
  _clean, _stored, _grants, _migrateRaw, _mergeRaw, _prepareWorkRoot, _runnerEnv, _bundledPi,
  _bundledShell, _skillRoots,
  CAPABILITY_KEYS, CAPABILITY_GRANT_VERSION, DEFAULT_CAPABILITY_GRANTS, RUNNER_ENV_DENY,
};
