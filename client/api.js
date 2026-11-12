/**
 * SoduWork desktop-to-Hub API with localStorage offline fallback.
 * Hub is authoritative for tasks. store.js queues per-task put/patch/delete
 * operations and replays them on reconnect instead of overwriting the task table.
 * Exposes task operations, configuration sync, registerClient, and connectWS.
 * The default Hub is http://127.0.0.1:18989; the login gate can change it through
 * the main-process hub-endpoint policy. Identities and pending operations remain
 * isolated by service. X-Soduwork-Device identifies the installation using Electron
 * secure storage; User.id is only a legacy first-migration hint.
 * window.SoduWorkAPI is canonical; compatibility aliases remain at the end.
 */
/*
 * Preserve the installed storage namespace and migrate legacy keys idempotently before any
 * panel reads configuration.
 */
/* Keep the installed storage namespace and migrate earlier keys idempotently
   before any panel reads configuration. */
(function migrateLegacyStorageKeys() {
  var MAP = {
    soduwork_chat_pins_v1: 'soduwork_work_chat_pins_v1',
    soduwork_collaboration_sessions_v1: 'soduwork_work_collaboration_sessions_v1',
    soduwork_development_hub_url_v1: 'soduwork_work_development_hub_url_v1',
    soduwork_hub_connections_v2: 'soduwork_work_hub_connections_v2',
    soduwork_hub_environment_v1: 'soduwork_work_hub_environment_v1',
    soduwork_lastgo_v2: 'soduwork_work_lastgo_v2',
    soduwork_legacy_auth_hub_v1: 'soduwork_work_legacy_auth_hub_v1',
    soduwork_library_show_hidden: 'soduwork_work_library_show_hidden',
    soduwork_library_view: 'soduwork_work_library_view',
    soduwork_proxy_error: 'soduwork_work_proxy_error',
    soduwork_sidebar_projects_v1: 'soduwork_work_sidebar_projects_v1',
    soduwork_task_ops_v1: 'soduwork_work_task_ops_v1',
    soduwork_task_shadow_v1: 'soduwork_work_task_shadow_v1',
  };
  try {
    for (var oldKey in MAP) {
      if (oldKey === MAP[oldKey]) continue;
      if (!Object.prototype.hasOwnProperty.call(localStorage, oldKey)) continue;
      if (!Object.prototype.hasOwnProperty.call(localStorage, MAP[oldKey])) {
        localStorage.setItem(MAP[oldKey], localStorage.getItem(oldKey));
      }
      localStorage.removeItem(oldKey);
    }
  } catch (_) { /* Storage may be unavailable in privacy mode; continue without persistence. */ }
})();

(function (global) {
  'use strict';
  var TASK_STORAGE_BASE = {
    tasks: 'soduwork_work_tasks_v5', ops: 'soduwork_work_task_ops_v1', shadow: 'soduwork_work_task_shadow_v1',
    notices: 'soduwork_work_notices_v1'
  };
  var LS_CFG = 'soduwork_work_cfg_v5';
  // An unscoped legacy credential has no trustworthy destination. Quarantine it
  // rather than guessing a former deployment or sending it to a new service.
  var DEFAULT_PRODUCTION_HUB = 'http://127.0.0.1:18989';
  var LEGACY_PRODUCTION_HUB = 'https://unassigned-legacy-hub.invalid';
  var DEFAULT_DEVELOPMENT_HUB = 'http://127.0.0.1:18989';
  var HUB_CONNECTIONS_KEY = 'soduwork_work_hub_connections_v2';
  var LEGACY_AUTH_HUB_KEY = 'soduwork_work_legacy_auth_hub_v1';
  var HUB_ENV_KEY = 'soduwork_work_hub_environment_v1';
  var DEVELOPMENT_HUB_KEY = 'soduwork_work_development_hub_url_v1';
  var LEGACY_HUB_KEY = 'soduwork_work_hub_url';

  function readLocal(key) {
    try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
  }
  function writeLocal(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (e) { /* Allow this session to continue when storage is read-only. */ }
  }
  function normalizeHub(raw) {
    var value = String(raw || '').trim();
    if (!value) throw new Error('请填写 SoduWork 服务地址');
    if (!/^https?:\/\//i.test(value)) value = 'http://' + value;
    value = value.replace(/\/+$/, '');
    try {
      if (typeof URL === 'function') {
        var parsed = new URL(value);
        if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password ||
            parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
          throw new Error('bad hub');
        }
        return parsed.origin;
      }
    } catch (e) { throw new Error('后台地址应为不带路径的 http:// 或 https:// 地址'); }
    /* Node VM tests may lack URL; the fallback must enforce the same validation rules. */
    var match = /^(https?):\/\/([^\/?#]+)$/i.exec(value);
    if (!match || /[@\\\s]/.test(match[2])) {
      throw new Error('后台地址应为不带路径的 http:// 或 https:// 地址');
    }
    return match[1].toLowerCase() + '://' + match[2];
  }
  function safeHub(value, fallback) { try { return normalizeHub(value); } catch (_) { return fallback; } }
  // Runtime form is informational; the main-process connection policy remains authoritative.
  function runtimeForm() {
    try {
      var scope = (typeof window !== 'undefined' && window) || (typeof globalThis !== 'undefined' ? globalThis : {});
      var bridge = scope.soduWorkAPI || null;
      return bridge && typeof bridge.runtimeForm === 'function' ? bridge.runtimeForm() : 'packaged';
    } catch (e) { return 'packaged'; }
  }
  // An explicit in-memory harness flag is never read from saved preferences.
  // Retain switch-boundary fixtures without exposing a product switcher.
  var testHubConfig = (!global.soduWorkAPI || !global.soduWorkAPI.getHubConnection)
    ? global.__SODUWORK_TEST_HUB_CONFIG__ || null : null;
  var runtimeHub = '';
  // Expose endpoint editing only when the main process permits it; refresh when policy is restored.
  var runtimeEditable = false;
  function legacyHubConfig() {
    var row;
    try { row = JSON.parse(readLocal(HUB_CONNECTIONS_KEY)); } catch (_) {}
    if (!row || !['production', 'development'].includes(row.environment)) {
      var previous = readLocal(HUB_ENV_KEY), legacy = safeHub(readLocal(LEGACY_HUB_KEY), '');
      var dev = safeHub(readLocal(DEVELOPMENT_HUB_KEY), '');
      var existed = !!(previous || legacy || dev || readLocal('soduwork_work_device_secret'));
      // Reconstruct the former endpoint only to scope legacy secrets and to
      // support explicit isolated fixtures. Product routing ignores this row.
      var production = !existed ? runtimeForm() !== 'local-code' :
        previous === 'production' || (previous !== 'development' &&
          (legacy === LEGACY_PRODUCTION_HUB || (!legacy && existed)));
      row = { environment: production ? 'production' : 'development',
        productionHub: existed ? (legacy || LEGACY_PRODUCTION_HUB) : DEFAULT_PRODUCTION_HUB,
        developmentHub: dev || (!production && legacy) ||
          (existed ? 'http://127.0.0.1:9080' : DEFAULT_DEVELOPMENT_HUB) };
      if (existed) writeLocal(HUB_CONNECTIONS_KEY, JSON.stringify(row));
    }
    var team = safeHub(row.productionHub, ''), local = safeHub(row.developmentHub, DEFAULT_DEVELOPMENT_HUB);
    var environment = row.environment === 'production' && team ? 'production' : 'development';
    var hub = environment === 'production' ? team : local;
    if (readLocal('soduwork_work_device_secret') && !readLocal(LEGACY_AUTH_HUB_KEY)) writeLocal(LEGACY_AUTH_HUB_KEY, hub);
    return { environment: environment, hub: hub, productionHub: team, developmentHub: local, editable: true };
  }
  function hubConfig() {
    if (testHubConfig && testHubConfig.allowSwitch === true) return legacyHubConfig();
    // Bind an unscoped legacy secret to its OLD endpoint before ignoring old
    // environment preferences. Never send a localhost/retired-Hub key to prod.
    if (readLocal('soduwork_work_device_secret') && !readLocal(LEGACY_AUTH_HUB_KEY)) legacyHubConfig();
    var hub = runtimeHub || DEFAULT_PRODUCTION_HUB;
    return { environment: 'production', hub: hub, productionHub: hub, developmentHub: '',
      editable: runtimeEditable === true };
  }
  function hubEnvironment() { return hubConfig().environment; }
  function setHubEnvironment(environment, address) {
    if (!testHubConfig || testHubConfig.allowSwitch !== true) throw new Error('此客户端使用固定的 SoduWork 服务');
    var target = environment === 'development' ? 'development' :
      (environment === 'production' ? 'production' : '');
    if (!target) throw new Error('请选择团队服务或本机服务');
    var previous = hubConfig(), next = { environment: target,
      productionHub: previous.productionHub, developmentHub: previous.developmentHub };
    var key = target === 'production' ? 'productionHub' : 'developmentHub';
    next[key] = normalizeHub(address || next[key]);
    var hub = next[key];
    // A single durable record commits the selection. Never claim success on quota/read-only failure.
    try { localStorage.setItem(HUB_CONNECTIONS_KEY, JSON.stringify(next)); }
    catch (_) { throw new Error('无法保存服务地址，请检查本机存储空间或权限'); }
    if (previous.hub !== hub) {
      invalidateRegistrations();
      _deviceSession = ''; _deviceSessionUntil = 0; _deviceAuthState = 'legacy';
      _deviceId = ''; _clientUser = null; _clientQuota = null;
      try { window.dispatchEvent(new CustomEvent('soduwork-data-scope-changed')); } catch (_) {}
    }
    writeLocal(DEVELOPMENT_HUB_KEY, next.developmentHub);
    writeLocal(HUB_ENV_KEY, target);
    writeLocal(LEGACY_HUB_KEY, hub);
    return hubConfig();
  }
  async function connectHub(environment, address) {
    var previous = base(), target = normalizeHub(address), bridge = window.soduWorkAPI;
    if (testHubConfig && testHubConfig.allowSwitch === true) {
      if (!['production', 'development'].includes(environment)) throw new Error('请选择团队服务或本机服务');
      if (bridge && bridge.selectHubEnvironment) {
        var selected = await bridge.selectHubEnvironment(target);
        if (!selected || !selected.ok) throw new Error(selected && selected.error || '无法切换服务');
      }
      try { return setHubEnvironment(environment, target); }
      catch (error) {
        if (bridge && bridge.selectHubEnvironment) await bridge.selectHubEnvironment(previous).catch(function () {});
        throw error;
      }
    }
    // Allow endpoint changes at login only for source launches authorized by the main process.
    // Persist the choice in the main process and invalidate the previous environment's identity, sessions, and pending queue.
    if (!hubConfig().editable || !bridge || !bridge.selectHubEnvironment) {
      throw new Error('此客户端使用固定的 SoduWork 服务');
    }
    var committed = await bridge.selectHubEnvironment(target);
    if (!committed || !committed.ok) throw new Error(committed && committed.error || '无法切换服务');
    if (previous !== target) {
      invalidateRegistrations();
      _deviceSession = ''; _deviceSessionUntil = 0; _deviceAuthState = 'legacy';
      _deviceId = ''; _clientUser = null; _clientQuota = null;
      try { window.dispatchEvent(new CustomEvent('soduwork-data-scope-changed')); } catch (_) {}
    }
    runtimeHub = target;
    return hubConfig();
  }
  var _savedHubRestore = null;
  // Resolve the trusted main-process policy before enrollment. Saved environment
  // selection is consulted only by explicitly enabled internal fixtures.
  function restoreSavedHub() {
    if (!testHubConfig || testHubConfig.allowSwitch !== true) {
      var fixedBridge = window.soduWorkAPI;
      if (!fixedBridge || !fixedBridge.getHubConnection) return;
      if (!_savedHubRestore) _savedHubRestore = new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          var error = new Error('读取服务配置超时，请重试');
          error.code = 'DEVICE_AUTH_INIT_TIMEOUT'; reject(error);
        }, 8000);
        Promise.resolve().then(function () { return fixedBridge.getHubConnection(); })
          .then(resolve, reject).finally(function () { clearTimeout(timer); });
      }).then(function (connection) {
        var target = normalizeHub(connection && connection.hub);
        if (target !== DEFAULT_PRODUCTION_HUB && !(connection && connection.internalTest === true &&
            /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|$)/i.test(target)) &&
            !(connection && connection.editable === true)) throw new Error('客户端服务配置无效');
        runtimeHub = target;
        runtimeEditable = !!(connection && connection.editable === true);
      }).catch(function (error) { _savedHubRestore = null; throw error; });
      return _savedHubRestore;
    }
    if (readLocal(HUB_CONNECTIONS_KEY) || readLocal(HUB_ENV_KEY) || readLocal(LEGACY_HUB_KEY) ||
        readLocal(DEVELOPMENT_HUB_KEY) || readLocal('soduwork_work_device_secret')) return;
    var bridge = window.soduWorkAPI;
    if (!bridge || !bridge.deviceAuthStatus) return;
    if (!_savedHubRestore) {
      var epoch = _registrationEpoch;
      _savedHubRestore = new Promise(function (resolve, reject) {
        var expired = false;
        var timer = setTimeout(function () {
          expired = true;
          var error = new Error('读取已保存的服务连接超时，请重试');
          error.code = 'DEVICE_AUTH_INIT_TIMEOUT'; reject(error);
        }, 8000);
        Promise.resolve().then(function () { return bridge.deviceAuthStatus(); }).then(function (saved) {
          clearTimeout(timer);
          if (expired) return;
          if (epoch !== _registrationEpoch) return reject(staleTaskScope());
          if (readLocal(HUB_CONNECTIONS_KEY)) return resolve();
          if (saved && saved.ready && saved.hub) {
            var hub = normalizeHub(saved.hub);
            setHubEnvironment(/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|$)/i.test(hub)
              ? 'development' : 'production', hub);
          }
          resolve();
        }, function (error) { clearTimeout(timer); reject(error); }).catch(reject);
      }).catch(function (error) { _savedHubRestore = null; throw error; });
    }
    return _savedHubRestore;
  }
  function base() { return hubConfig().hub; }
  function taskScope() {
    var value = base();
    try {
      var parsed = new URL(value);
      return parsed.protocol.toLowerCase() + '//' + parsed.host.toLowerCase() +
        parsed.pathname.replace(/\/+$/, '');
    } catch (e) { return String(value || '').toLowerCase(); }
  }
  function taskStorageKey(kind) {
    var stem = TASK_STORAGE_BASE[kind] || TASK_STORAGE_BASE.tasks;
    // Hub alone is not an identity: reinstalling or signing in as another person
    // must never replay the previous installation's pending task creations.
    return stem + '@' + encodeURIComponent(taskScope()) +
      '@' + encodeURIComponent(device()) + '@' +
      encodeURIComponent(String(_clientUser && _clientUser.id || 'unbound'));
  }
  function staleTaskScope() {
    var error = new Error('当前账号或设备已切换，请重新打开后再操作');
    error.code = 'STALE_TASK_SCOPE';
    return error;
  }
  function adoptVerifiedTaskOperations(items) {
    if (!_deviceId || !_clientUser || !_clientUser.id) return;
    try {
      var key = taskStorageKey('ops'), marker = key + ':legacy-adopted';
      if (readLocal(marker)) return;
      var legacyKey = TASK_STORAGE_BASE.ops + '@' + encodeURIComponent(taskScope());
      var legacy = JSON.parse(readLocal(legacyKey) || '[]');
      var current = JSON.parse(readLocal(key) || '[]');
      if (!Array.isArray(legacy) || !Array.isArray(current)) return;
      var owned = new Set((items || []).filter(function (row) {
        return row && !row.readOnly && row.ownerClientId === _deviceId &&
          [row.createdBy, row.requesterUserId, row.assigneeUserId].includes(_clientUser.id);
      }).map(function (row) { return row.id; }));
      legacy.forEach(function (operation) {
        if (operation && owned.has(operation.id) && ['put', 'patch', 'delete'].includes(operation.kind) &&
            !current.some(function (row) { return row.id === operation.id; })) current.push(operation);
      });
      // Only the server can prove ownership. Unconfirmed legacy creations and
      // unscoped caches stay untouched for recovery; never auto-upload them.
      writeLocal(key, JSON.stringify(current));
      writeLocal(marker, '1');
    } catch (_) { /* Preserve the original queue on malformed/read-only storage. */ }
  }
  var _deviceId = '';
  function device() {
    try {
      if (_deviceId) return _deviceId;
      if (typeof User !== 'undefined' && User && User.id) return User.id;
      return localStorage.getItem('soduwork_work_user_id') || 'u-unknown';
    } catch (e) { return 'u-unknown'; }
  }
  function apiUrl(path) { return base() + '/api/v1' + path; }

  /*
   * Convert library blobs to base64 before main-process open/reveal operations, matching
   * attachment-read-binary and its 64 MB limit.
   */
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '').split(',', 2)[1] || ''); };
      reader.onerror = function () { reject(new Error('读取文件失败，请重试')); };
      reader.readAsDataURL(blob);
    });
  }
  function libraryExternalPayload(id, blob, name) {
    return blobToBase64(blob).then(function (data) {
      var bridge = window.soduWorkAPI || {};
      if (typeof bridge.openLibraryExternally !== 'function' || typeof bridge.revealLibraryItem !== 'function') {
        throw new Error('当前客户端不支持该操作，请下载后使用');
      }
      return { itemId: String(id || ''), filename: String(name || '资料'), data: data };
    });
  }

  /* Abort fetch after the timeout so a slow backend cannot block initialization indefinitely. */
  var DEFAULT_TIMEOUT = 8000;
  function _abortSignal(ms) {
    return _requestAbort(undefined, ms).signal;
  }
  function _requestAbort(parent, ms) {
    /*
     * Pass an explicit abort reason so the UI displays the timeout instead of Chromium's
     * generic abort error.
     */
    var c;
    try { c = new AbortController(); }
    catch(e){ return { signal: parent, dispose: function () {} }; }
    var timer;
    var cancel = function () { c.abort(parent.reason); };
    var dispose = function () { clearTimeout(timer); parent?.removeEventListener('abort', cancel); };
    if (parent?.aborted) cancel();
    else {
      parent?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(function () {
        c.abort(new Error('请求超时（' + Math.round(ms / 1000) + ' 秒），请检查网络后重试'));
      }, ms);
    }
    return { signal: c.signal, dispose };
  }

  /*
   * Use legacy device secrets only for migration, then remove them from page storage. Normal
   * requests use short-lived, in-memory sessions issued by the main process.
   */
  function secret() { var hub = base(); return readLocal(LEGACY_AUTH_HUB_KEY) === hub ? readLocal('soduwork_work_device_secret') : ''; }
  function setSecret(s) { if (s) { writeLocal(LEGACY_AUTH_HUB_KEY, base()); writeLocal('soduwork_work_device_secret', s); } }
  /*
   * Authenticate WebSockets in the first frame, never in the URL where proxies and access
   * logs could expose credentials. Prefer a short-lived session; use a legacy secret only
   * during migration.
   */
  function wsAuthFrame() {
    var auth = { t: 'auth', device: device() };
    if (_deviceSession) auth.session = _deviceSession;
    else { var s = secret(); if (s) auth.secret = s; }
    return JSON.stringify(auth);
  }
  var _deviceSession = '';
  var _deviceSessionHub = '';
  var _deviceSessionUntil = 0;
  var _deviceAuthState = 'legacy';
  var _clientUser = null;
  var _clientQuota = null;
  function hasValidDeviceSession() {
    if (_deviceSession && _deviceSessionHub === base() && Date.now() < _deviceSessionUntil) return true;
    if (_deviceSession) { _deviceSession = ''; _deviceSessionUntil = 0; }
    return false;
  }
  function rememberSession(row) {
    var previousScope = _deviceId && _clientUser ? taskStorageKey('ops') : '';
    if (row && row.clientId) _deviceId = String(row.clientId);
    if (row?.user?.id && row.user.id !== _clientUser?.id) _clientQuota = null;
    if (row && row.user) _clientUser = row.user;
    if (row && row.quota) _clientQuota = row.quota;
    if (row && row.session) {
      _deviceSession = String(row.session);
      _deviceSessionHub = base();
      _deviceSessionUntil = Date.now() + Math.max(30, Number(row.expiresIn) || 0) * 1000;
      _deviceAuthState = 'active';
    } else if (row && row.code === 'TOKEN_QUOTA_EXCEEDED') {
      if (!hasValidDeviceSession()) _deviceAuthState = 'quota';
      if (row.quota) _clientQuota = row.quota;
    } else if (row && row.activationRequired) {
      _clientUser = null; _clientQuota = null;
      _deviceSession = ''; _deviceSessionUntil = 0; _deviceAuthState = 'pending';
    }
    if (previousScope && previousScope !== taskStorageKey('ops')) {
      try { window.dispatchEvent(new CustomEvent('soduwork-data-scope-changed')); } catch (_) {}
    }
    try { window.dispatchEvent(new CustomEvent('soduwork-device-auth', { detail: {
      state: _deviceAuthState, activationRequired: _deviceAuthState === 'pending',
      user: _clientUser, quota: _clientQuota,
      code: String(row && row.code || ''), error: String(row && row.error || '')
    } })); } catch (e) {}
  }
  function requireClientAuth(reason, payload) {
    var data = payload || {};
    if (data.code === 'TOKEN_QUOTA_EXCEEDED' && _clientUser && hasValidDeviceSession()) {
      if (data.quota) _clientQuota = data.quota;
      window.dispatchEvent(new CustomEvent('soduwork-client-auth-required', { detail: {
        state: 'quota', authenticated: true, code: data.code, error: String(data.message || data.error || ''),
        user: _clientUser, quota: _clientQuota
      } }));
      return;
    }
    invalidateRegistrations();
    _deviceSession = ''; _deviceSessionUntil = 0;
    _deviceAuthState = data.code === 'TOKEN_QUOTA_EXCEEDED' ? 'quota' : 'pending';
    if (data.quota) _clientQuota = data.quota;
    try {
      if (window.soduWorkAPI && window.soduWorkAPI.deviceAuthClearSession) {
        window.soduWorkAPI.deviceAuthClearSession({ hub: base(), clientId: device() });
      }
      window.dispatchEvent(new CustomEvent('soduwork-client-auth-required', { detail: {
        state: _deviceAuthState, reason: String(reason || ''), code: String(data.code || ''),
        error: String(data.message || data.error || ''), user: _clientUser, quota: _clientQuota
      } }));
    } catch (e) {}
  }
  function handleAuthError(error) {
    if (!error) return;
    if (error.code === 'LEGAL_ACCEPTANCE_REQUIRED') {
      window.dispatchEvent(new CustomEvent('soduwork-legal-required'));
      return;
    }
    if (error.code === 'TOKEN_QUOTA_EXCEEDED' || error.status === 401) {
      requireClientAuth(error.code || 'SESSION_INVALID', error.payload || error);
    }
  }

  if (window.soduWorkAPI && window.soduWorkAPI.onDeviceAuthQuotaExceeded) {
    window.soduWorkAPI.onDeviceAuthQuotaExceeded(function (detail) {
      if (detail?.hub && detail.hub !== base()) return;
      if (detail?.clientId && detail.clientId !== device()) return;
      requireClientAuth('TOKEN_QUOTA_EXCEEDED', {
        code: 'TOKEN_QUOTA_EXCEEDED',
        message: '\u672c\u6708 AI Token \u989d\u5ea6\u5df2\u7528\u5b8c\uff0c\u8bf7\u8054\u7cfb\u7ba1\u7406\u5458\u8c03\u6574\u989d\u5ea6\u3002',
        quota: detail && detail.quota || null,
      });
    });
  }

  async function syncRunnerConfig(workRootNow, registration) {
    try {
      if (!window.soduWorkAPI || !window.soduWorkAPI.configureRunner) return false;
      var configure = function () { return window.soduWorkAPI.configureRunner({
        hub: base(), clientId: device(), workRoot: String(workRootNow || '')
      }); };
      var r = registration ? await registration.step(configure) : await configure();
      return !!(r && r.ok);
    } catch (e) { if (registrationBoundaryError(e)) throw e; return false; }
  }
  async function localRunnerReason() {
    try {
      if (!window.soduWorkAPI || !window.soduWorkAPI.runnerStatus) return '';
      var status = await window.soduWorkAPI.runnerStatus();
      if (!status || status.connected) return '';
      if (status.error) return String(status.error);
      if (!status.running) return '本机 Runner 尚未启动，请检查客户端的工作目录设置后重新打开客户端。';
      if (status.connected === false) return '本机 Runner 正在连接后台，连接成功后会自动显示可用 Agent。';
    } catch (_) { /* Older clients can still use the authoritative Hub response. */ }
    return '';
  }
  function authHeaders(withJson) {
    var h = { 'X-Soduwork-Device': device() };
    if (hasValidDeviceSession()) h.Authorization = 'Device ' + _deviceSession;
    if (!h.Authorization) { var s = secret(); if (s) h['X-Soduwork-Secret'] = s; }
    if (withJson) h['Content-Type'] = 'application/json';
    return h;
  }

  function httpError(res, text) {
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    var detail = data && data.detail;
    var meta = detail && !Array.isArray(detail) && typeof detail === 'object' ? detail : null;
    if (Array.isArray(detail)) detail = detail.map(function (item) {
      return item && (item.msg || item.message) || String(item || '');
    }).filter(Boolean).join('；');
    else if (detail && typeof detail === 'object') detail = detail.message || detail.msg || '';
    detail = String(detail || '').trim().slice(0, 500);
    var error = new Error(detail || ('HTTP ' + res.status));
    error.status = Number(res.status) || 0;
    error.detail = detail;
    error.code = String(meta && meta.code || '');
    error.phase = String(meta && meta.phase || '');
    error.phaseName = String(meta && meta.phaseName || '');
    error.retryable = meta && typeof meta.retryable === 'boolean' ? meta.retryable : null;
    error.attemptId = String(meta && meta.attemptId || '');
    error.payload = meta;
    return error;
  }

  var _sessionRefresh = null;
  var _registrationEpoch = 0;
  var _registrations = new Set();
  function registrationBoundaryError(error) {
    return error && ['DEVICE_AUTH_INIT_TIMEOUT', 'STALE_TASK_SCOPE'].includes(error.code);
  }
  function invalidateRegistrations() {
    _registrationEpoch += 1;
    _sessionRefresh = null;
    _registrations.forEach(function (job) { job.cancel(); });
  }
  function registrationContext(startedAt) {
    var epoch = _registrationEpoch, hub = base(), until = (startedAt == null ? Date.now() : startedAt) + DEFAULT_TIMEOUT;
    var rejectStep = null, stopped = null;
    function timedOut() {
      var error = new Error('登录状态准备超时，请重试');
      error.code = 'DEVICE_AUTH_INIT_TIMEOUT';
      stopped = error; return error;
    }
    function check() {
      if (stopped) throw stopped;
      if (epoch !== _registrationEpoch || hub !== base()) throw staleTaskScope();
      if (Date.now() >= until) throw timedOut();
    }
    var job = {
      check: check,
      cancel: function () { stopped = staleTaskScope(); if (rejectStep) rejectStep(stopped); },
      step: function (operation) {
        check();
        return new Promise(function (resolve, reject) {
          var settled = false;
          function finish(error, value) {
            if (settled) return;
            settled = true; clearTimeout(timer); rejectStep = null;
            if (error) reject(error); else resolve(value);
          }
          rejectStep = function (error) { finish(error); };
          var timer = setTimeout(function () { finish(timedOut()); }, Math.max(1, until - Date.now()));
          Promise.resolve().then(function () { check(); return operation(); }).then(function (value) {
            try { check(); finish(null, value); } catch (error) { finish(error); }
          }, function (error) {
            try { check(); finish(error); } catch (boundary) { finish(boundary); }
          });
        });
      },
      dispose: function () { _registrations.delete(job); }
    };
    _registrations.add(job);
    return job;
  }
  async function refreshDeviceSession(staleSession, startedAt) {
    if (!SoduWorkAPI || typeof SoduWorkAPI.registerClient !== 'function') return false;
    if (startedAt == null) startedAt = Date.now();
    var restoration = restoreSavedHub(); if (restoration) await restoration;
    var epoch = _registrationEpoch, hub = base();
    function checkRefresh() { if (epoch !== _registrationEpoch || hub !== base()) throw staleTaskScope(); }
    if (!_sessionRefresh) {
      var refresh = Promise.resolve().then(function () {
        checkRefresh();
        return SoduWorkAPI.registerClient({ staleSession: staleSession || '', startedAt: startedAt });
      }).finally(function () { if (_sessionRefresh === refresh) _sessionRefresh = null; });
      _sessionRefresh = refresh;
    }
    var row = await _sessionRefresh;
    checkRefresh();
    return !!(row && row.ok && row.session);
  }

  /*
   * Report a readable error when a gateway returns HTML or truncated JSON instead of leaking
   * an unexplained SyntaxError.
   */
  function parseJSON(txt) {
    if (!txt) return null;
    try { return JSON.parse(txt); }
    catch (e) {
      var err = new Error('服务返回的不是有效 JSON（响应可能被代理或网络设备改写）');
      err.code = 'BAD_JSON'; err.status = 0; throw err;
    }
  }

  async function jfetch(path, opts, retried, trace) {
    const own = !trace;
    let measured = trace, ok = false;
    try { measured = measured || global.SoduWorkPagePerformance?.beginRequest?.(path, opts?.method); } catch (_) {}
    try { const value = await jfetchCurrent(path, opts, retried, measured); ok = true; return value; }
    finally { if (own) { try { measured?.finish?.(ok); } catch (_) {} } }
  }

  async function jfetchCurrent(path, opts, retried, trace) {
    var startedAt = Date.now();
    var restoration = restoreSavedHub(); if (restoration) await restoration;
    /*
     * Each Electron window has separate renderer memory. Before its first request, obtain a
     * short-lived session through main-process secure storage; cached task data does not imply
     * initData ran here. Share _sessionRefresh across concurrent requests to avoid duplicate
     * issuance and transient 401 flashes. Pending activation still fails with the actual
     * authorization error.
     */
    if (!retried && path !== '/clients/register' && !hasValidDeviceSession() &&
        _deviceAuthState !== 'pending' && window.soduWorkAPI && window.soduWorkAPI.deviceAuthBootstrap) {
      try { await refreshDeviceSession('', startedAt); } catch (e) {
        if (registrationBoundaryError(e)) throw e;
        /* Subsequent requests report the actual connectivity or authorization error. */
      }
    }
    var requestScope = taskStorageKey('ops');
    if (opts && opts.taskScope && opts.taskScope !== requestScope) throw staleTaskScope();
    var o = Object.assign({ headers: {} }, opts || {});
    delete o.taskScope;
    o.headers = Object.assign(authHeaders(true), o.headers);
    if (trace?.requestId && !Object.keys(o.headers).some(key => key.toLowerCase() === 'x-request-id')) o.headers['X-Request-ID'] = trace.requestId;
    if (!o.signal) o.signal = _abortSignal(DEFAULT_TIMEOUT);
    var res;
    try { res = await fetch(apiUrl(path), o); }
    catch (error) { if (!opts?.signal?.aborted || error?.name !== 'AbortError') mark(false); throw error; }
    try { trace?.response?.(res); } catch (_) {}
    /*
     * Any HTTP response proves reachability; 4xx/5xx are request failures, not offline status.
     * Update connectivity centrally even when errors propagate to the UI.
     */
    mark(true);
    var txt = await res.text();
    if (requestScope !== taskStorageKey('ops')) throw staleTaskScope();
    /*
     * The first request may precede initialization or encounter an expired 30-minute session.
     * Refresh through secure storage and replay once; pending or disabled devices must still
     * report their actual errors.
     */
    if (res.status === 401 && !retried && path !== '/clients/register') {
      try {
        if (await refreshDeviceSession(_deviceSession)) return jfetch(path, Object.assign({}, opts, { taskScope: requestScope }), true, trace);
      } catch (e) { if (registrationBoundaryError(e)) throw e; /* Preserve the original 401 error details. */ }
      /*
       * A failed refresh can reflect a transient network error. Preserve the original 401 and
       * let later requests retry instead of forcing reauthentication. Registration and
       * activation checks still handle revoked or reset devices.
       */
      throw httpError(res, txt);
    }
    if (!res.ok) {
      var requestError = httpError(res, txt); handleAuthError(requestError); throw requestError;
    }
    return parseJSON(txt);
  }

  async function cloudSetup(path, body) {
    var hub = base(), requestScope = taskStorageKey('ops');
    var result = await jfetch(path, { method: 'POST', taskScope: requestScope,
      redirect: 'error', cache: 'no-store', body: JSON.stringify(body || {}) });
    if (hub !== base() || requestScope !== taskStorageKey('ops')) throw staleTaskScope();
    // Bind the one-time response to the origin we actually authenticated to.
    // Behind a TLS proxy the Hub may see an internal HTTP origin; older Hubs
    // omit clientHub entirely. The remote command still uses setup.hub.
    if (result && result.ok !== false && result.setup && typeof result.setup === 'object') {
      result.setup = Object.assign({}, result.setup, { clientHub: hub });
    }
    return result;
  }

  async function uploadFile(path, file, retried, metadata, requestScope) {
    var startedAt = Date.now();
    var restoration = restoreSavedHub(); if (restoration) await restoration;
    if (!retried && !hasValidDeviceSession() && _deviceAuthState !== 'pending' &&
        window.soduWorkAPI && window.soduWorkAPI.deviceAuthBootstrap) {
      try { await refreshDeviceSession('', startedAt); } catch (e) { if (registrationBoundaryError(e)) throw e; }
    }
    if (requestScope && requestScope !== taskStorageKey('ops')) throw staleTaskScope();
    var form = new FormData();
    form.append('file', file);
    if (metadata && metadata.purpose === 'requirement_input') {
      form.append('purpose', 'requirement_input');
      form.append('field', metadata.field === 'acceptance' ? 'acceptance' : 'description');
      form.append('sequence', String(Math.max(0, Number(metadata.sequence) || 0)));
      form.append('criterionText', String(metadata.criterionText || '').slice(0, 500));
    }
    var res;
    try {
      res = await fetch(apiUrl(path), {
        method: 'POST', headers: authHeaders(false), body: form,
        signal: _abortSignal(60000)
      });
    } catch (error) { mark(false); throw error; }
    mark(true);
    var txt = await res.text();
    if (requestScope && requestScope !== taskStorageKey('ops')) throw staleTaskScope();
    if (res.status === 401 && !retried) {
      try {
        if (await refreshDeviceSession(_deviceSession)) return uploadFile(path, file, true, metadata, requestScope);
      } catch (e) { if (registrationBoundaryError(e)) throw e; }
      /* As in jfetch, preserve the original 401 after refresh failure without forcing reauthentication. */
      throw httpError(res, txt);
    }
    if (!res.ok) {
      var requestError = httpError(res, txt); handleAuthError(requestError); throw requestError;
    }
    return parseJSON(txt);
  }

  /* Timeout-aware raw fetch for callers outside jfetch. */
  async function _fetch(path, opts, timeout) {
    var restoration = restoreSavedHub(); if (restoration) await restoration;
    var o = Object.assign({ headers: authHeaders(true) }, opts || {});
    if (!o.signal) o.signal = _abortSignal(timeout || DEFAULT_TIMEOUT);
    return fetch(apiUrl(path), o);
  }

  function lsCfg() { try { return JSON.parse(localStorage.getItem(LS_CFG) || '{}'); } catch (e) { return {}; } }

  var _online = null;  // null means unknown.
  var _teamCapabilityFlight = null;
  function mark(ok) {
    if (_online !== ok) { _online = ok; try { console.log('[hub]', ok ? '已连后端' : '后台不可达'); } catch (e) {} }
  }
  function pluginsChanged(pluginId) {
    try {
      if (typeof global.dispatchEvent !== 'function' ||
          typeof global.CustomEvent !== 'function') return;
      global.dispatchEvent(new global.CustomEvent('soduwork:plugins-changed', {
        detail: { pluginId: String(pluginId || '') }
      }));
    } catch (e) { /* catalog refresh is best-effort; the mutation already succeeded */ }
  }
  function approvalsInvalidated() {
    try {
      if (typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function')
        global.dispatchEvent(new global.CustomEvent('soduwork-approvals-invalidated'));
    } catch (e) { /* Approval already persisted; discovery refresh is best-effort. */ }
  }

  /* HTTP 4xx/5xx prove backend reachability; mark offline only when fetch fails due to network errors or timeout. */
  function markFromError(e) {
    if (e && (e.code === 'STALE_TASK_SCOPE' || e.connectivityHandled)) return;
    var msg = String(e && e.message || e);
    if ((e && Number(e.status)) || /^HTTP \d+$/.test(msg)) { mark(true); }  /* An HTTP status proves backend reachability. */
    else { mark(false); }                         /* TypeError/AbortError indicate a failed connection or aborted request. */
  }

  /*
   * Apply the returned authoritative task immediately in both windows without waiting for
   * WebSocket delivery. Store treats it as server state and must not PATCH it back.
   */
  function acceptTaskResult(result, arrival) {
    try {
      if (result && result.task && typeof Store !== 'undefined' && Store.applyServerEvent) {
        const event = { type: 'task.updated', task: result.task, arrival: String(arrival || 'self') };
        event.autoOpen = event.arrival !== 'self';
        Store.applyServerEvent(event);
      }
    } catch (e) { /* Store may be unavailable during boot; WS and the next refresh will reconcile. */ }
    return result;
  }
  function refreshSentNotices(requestScope) {
    if (requestScope === taskStorageKey('ops') && global.MateNoticeSync) {
      void invalidateDomain('team-messages-sent', domainScope()).then(() => {
        if (requestScope === taskStorageKey('ops')) return global.MateNoticeSync.refresh('sent', true);
      }).catch(() => {});
    }
  }

  // Multi-step library transfers must stay bound to the identity that started them.
  function assertLibraryScope(scope) {
    if (scope !== taskStorageKey('ops')) throw staleTaskScope();
  }

  function libraryArchivePath(path) {
    if (typeof path !== 'string' || !path || /[\\\x00-\x1f\x7f]/.test(path) || /^[A-Za-z]:/.test(path) ||
        path.split('/').some(function (part) { return !part || part === '.' || part === '..'; })) {
      throw new Error('压缩包文件路径无效');
    }
    return path;
  }

  function domainScope() {
    return { hub: base().replace(/\/+$/, ''), clientId: device(), userId: String(_clientUser?.id || '') };
  }
  function sameDomainScope(value) {
    var current = domainScope();
    return value && value.hub === current.hub && value.clientId === current.clientId && value.userId === current.userId;
  }
  async function domainRead(domain, path) {
    var bridge = global.soduWorkAPI, scope = domainScope();
    if (!bridge?.clientDomainRead || !scope.userId) return jfetch(path);
    var result = await bridge.clientDomainRead(domain, scope);
    if (!sameDomainScope(scope)) throw staleTaskScope();
    if (result?.code === 'DOMAIN_POLL_FALLBACK') return jfetch(path);
    // A local snapshot or replayed backoff error does not prove current reachability.
    if (typeof result?.online === 'boolean') mark(result.online);
    if (!result?.ok) {
      if (result?.status) {
        var error = httpError({status: result.status}, JSON.stringify(result.body || {detail: result.reason}));
        error.connectivityHandled = true;
        if (result.status !== 401) handleAuthError(error);
        throw error;
      }
      throw Object.assign(new Error(result?.reason || '同步暂时不可用'), {status: result?.status, code: result?.code, connectivityHandled: true});
    }
    return result.value;
  }
  async function invalidateDomain(domain, scope) {
    if (!sameDomainScope(scope)) throw staleTaskScope();
    try { if (global.soduWorkAPI?.clientDomainInvalidate) await global.soduWorkAPI.clientDomainInvalidate(domain, scope); }
    catch (_) { /* Cache maintenance cannot turn a committed write into a failure. */ }
    if (!sameDomainScope(scope)) throw staleTaskScope();
  }
  global.soduWorkAPI?.onClientDomainChanged?.(value => {
    if (!sameDomainScope(value?.scope)) return;
    try { global.dispatchEvent(new CustomEvent('soduwork-domain-changed', {detail: {domain: value.domain}})); } catch (_) {}
  });

  var SoduWorkAPI = {
    get online() { return _online; },
    conversationProjects: () => domainRead('conversation-projects', '/conversation-projects'),
    saveConversationProject: async (id, body) => {
      var scope = domainScope();
      var result = await jfetch('/conversation-projects/' + encodeURIComponent(id), {method: 'PUT', body: JSON.stringify(body)});
      await invalidateDomain('conversation-projects', scope);
      return result;
    },
    hubBase: base,
    hubEnvironment: hubEnvironment,
    hubConfig: hubConfig,
    runtimeForm: runtimeForm,
    /*
     * Hub device ID shares the ownerClientId namespace and identifies the execution device,
     * where session archives are stored.
     */
    get clientId() { return _deviceId; },
    setHubEnvironment: setHubEnvironment,
    connectHub: connectHub,
    normalizeHub: normalizeHub,
    taskStorageKey: taskStorageKey,
    adoptVerifiedTaskOperations: adoptVerifiedTaskOperations,

    /*
     * Return startup data with its provenance. Task views accept current Hub state; network
     * failure yields an explicit offline state, never cached data presented as live.
     */
    async getTasksSnapshot() {
      var requestHub = base();
      try {
        var t = await jfetch('/tasks');
        /* Discard late responses from the previous environment after an endpoint switch. */
        if (requestHub !== base()) return { items: [], online: false, stale: true, hub: requestHub };
        mark(true);
        return { items: t || [], online: true, hub: requestHub };
      }
      catch (e) {
        markFromError(e);
        if (e && e.code === 'STALE_TASK_SCOPE') return { items: [], online: false, stale: true, hub: requestHub };
        if ((e && Number(e.status)) || /^HTTP \d+$/.test(String(e && e.message || e))) throw e;
        /* Only the current Hub supplies live tasks; compatibility caches must not appear as current server data. */
        return { items: [], online: false, hub: requestHub,
          error: String(e && e.message || e || '后台不可达') };
      }
    },
    async getTasks() {
      var snapshot = await this.getTasksSnapshot();
      return snapshot.items;
    },
    /* Recovery needs an authenticated HTTP response: Electron registration can
       return an unexpired session entirely from its local cache. */
    async checkConnection() {
      var scope = taskStorageKey('ops');
      try {
        var result = await jfetch('/client-auth/me', { taskScope: scope });
        if (scope !== taskStorageKey('ops')) return false;
        var connected = !!(result && result.user && result.user.id && result.device && result.device.authState === 'active');
        mark(connected); return connected;
      } catch (error) { markFromError(error); return false; }
    },
    /*
     * Task details may open before list initialization. Fetch directly from the current Hub
     * and discard responses from earlier environments.
     */
    async getTask(taskId, options) {
      var requestHub = base();
      var request = _requestAbort(options?.signal, DEFAULT_TIMEOUT);
      var task;
      try { task = await jfetch('/tasks/' + encodeURIComponent(taskId), request.signal ? { signal: request.signal } : undefined); }
      finally { request.dispose(); }
      if (requestHub !== base()) {
        var stale = new Error('后台环境已经切换，请重新打开需求');
        stale.code = 'STALE_HUB';
        throw stale;
      }
      mark(true);
      return task;
    },
    async prepareRequirementExecution(taskId) {
      var requestHub = base(), scope = taskStorageKey('ops'), epoch = _registrationEpoch;
      var task = await jfetch('/tasks/' + encodeURIComponent(taskId) + '/prepare-execution', {method: 'POST', body: '{}'});
      if (requestHub !== base() || scope !== taskStorageKey('ops') || epoch !== _registrationEpoch) {
        throw new Error('账号或后台环境已切换，请重新打开需求');
      }
      return task;
    },
    async getConfig() {
      try { var c = await domainRead('config', '/config'); return c || {}; }
      catch (e) { markFromError(e); return lsCfg(); }
    },

    /*
     * Fetch the device department's team overview. Return null on failure so team.js can
     * display its offline fallback.
     */
    async getTeam() {
      try { var t = await jfetch('/team'); mark(true); return t; }
      catch (e) { markFromError(e); return null; }
    },
    /*
     * Probe assigned, canManage, orgName, and meName to control team navigation. On failure,
     * return null and hide the entry until the next probe.
     */
    async getTeamCapability() {
      var scope = taskStorageKey('ops'), epoch = _registrationEpoch;
      if (_teamCapabilityFlight && _teamCapabilityFlight.scope === scope && _teamCapabilityFlight.epoch === epoch) return _teamCapabilityFlight.promise;
      var flight = { scope: scope, epoch: epoch };
      _teamCapabilityFlight = flight;
      flight.promise = (async function () {
        try {
          var c = await jfetch('/team/capability', { taskScope: scope });
          if (_teamCapabilityFlight !== flight || epoch !== _registrationEpoch || scope !== taskStorageKey('ops')) return null;
          mark(true); return c;
        } catch (e) { markFromError(e); return null; }
      })();
      try { return await flight.promise; }
      finally { if (_teamCapabilityFlight === flight) _teamCapabilityFlight = null; }
    },
    /* Return the team board's canManage, tasks, and members; return null on failure. */
    async getTeamTasks() {
      try { var t = await jfetch('/team/tasks'); mark(true); return t; }
      catch (e) { markFromError(e); return null; }
    },
    /* Let a team manager update a member's task status, including acceptance; propagate backend rejection details. */
    async setTeamTaskStatus(tid, status) {
      var res = await fetch(apiUrl('/team/tasks/' + encodeURIComponent(tid) + '/status'),
        { method: 'POST', headers: authHeaders(true), body: JSON.stringify({ status: status }) });
      var txt = await res.text();
      var data = parseJSON(txt);
      if (!res.ok) { markFromError(new Error('HTTP ' + res.status)); throw new Error((data && data.detail) || ('HTTP ' + res.status)); }
      mark(true); return data;
    },
    /* Reassign a task to another team member's SoduWork; propagate backend rejection details. */
    async reassignTeamTask(tid, assigneeUserId) {
      var res = await fetch(apiUrl('/team/tasks/' + encodeURIComponent(tid) + '/reassign'),
        { method: 'POST', headers: authHeaders(true), body: JSON.stringify({ assigneeUserId: assigneeUserId }), signal: _abortSignal(DEFAULT_TIMEOUT) });
      var txt = await res.text();
      var data = parseJSON(txt);
      if (!res.ok) { markFromError(new Error('HTTP ' + res.status)); throw new Error((data && data.detail) || ('HTTP ' + res.status)); }
      mark(true); return data;
    },
    /* Send a manager's reminder from the desktop pet; the recipient sees a bubble and attention animation. */
    async nudgeTeamTask(tid, note) {
      var res = await fetch(apiUrl('/team/tasks/' + encodeURIComponent(tid) + '/nudge'),
        { method: 'POST', headers: authHeaders(true), body: JSON.stringify({ note: note || '' }), signal: _abortSignal(DEFAULT_TIMEOUT) });
      var txt = await res.text(); var data = parseJSON(txt);
      if (!res.ok) { markFromError(new Error('HTTP ' + res.status)); throw new Error((data && data.detail) || ('HTTP ' + res.status)); }
      mark(true); return data;
    },
    /* Assign tasks using title, assigneeUserIds/assigneeUserId, priority, due, tags, and note; propagate backend error details. */
    async createTeamTask(body) {
      var res = await fetch(apiUrl('/team/tasks'),
        { method: 'POST', headers: authHeaders(true), body: JSON.stringify(body || {}), signal: _abortSignal(DEFAULT_TIMEOUT) });
      var txt = await res.text();
      var data = parseJSON(txt);
      if (!res.ok) { markFromError(new Error('HTTP ' + res.status)); throw new Error((data && data.detail) || ('HTTP ' + res.status)); }
      mark(true); return data;
    },

    /* Atomic coworker assignment: create on the recipient device, never create locally then hand off. */
    async createAssignedTask(body) {
      var result, requestScope = taskStorageKey('ops');
      try {
        result = await jfetch('/tasks/assigned', {
          method: 'POST', body: JSON.stringify(body || {}), taskScope: requestScope
        });
      } catch (error) { markFromError(error); throw error; }
      mark(true);
      /* A JSON business rejection is still a healthy Hub response. Keep the
         online indicator green so the retry dialog does not incorrectly tell
         the user that the whole backend is offline. */
      if (result && result.ok === false) {
        var businessError = new Error(
          result.reason || result.error || result.message || '创建交办任务失败'
        );
        businessError.status = 200;
        throw businessError;
      }
      refreshSentNotices(requestScope);
      return acceptTaskResult(result, 'self');
    },

    /* Projects available when assigning tasks. */
    async getProjects() {
      var res = await fetch(apiUrl('/projects'), { headers: authHeaders(), signal: _abortSignal(DEFAULT_TIMEOUT) });
      if (!res.ok) { markFromError(new Error('HTTP ' + res.status)); return []; }
      var txt = await res.text(); mark(true); return parseJSON(txt) || [];
    },

    /* Personal and team daily/weekly reports, with client reading and confirmation. */
    async getWorkReports(period, anchor, scope, orgId) {
      var q = new URLSearchParams({
        period: period || 'daily', anchor: anchor || '', scope: scope || 'mine'
      });
      if (orgId) q.set('orgId', orgId);
      return await jfetch('/reports?' + q.toString());
    },
    async generateWorkReports(body) {
      return await jfetch('/reports/generate', {
        method: 'POST', body: JSON.stringify(body || {})
      });
    },
    async confirmTeamReport(reportId, note) {
      return await jfetch('/reports/team/' + encodeURIComponent(reportId) + '/confirm', {
        method: 'POST', body: JSON.stringify({ note: note || '' })
      });
    },

    /* Task collaboration: comments and mentions. */
    async getTaskComments(tid) {
      return await jfetch('/tasks/' + encodeURIComponent(tid) + '/comments');
    },
    async addTaskComment(tid, body, mentions) {
      var res = await fetch(apiUrl('/tasks/' + encodeURIComponent(tid) + '/comments'),
        { method: 'POST', headers: authHeaders(true), body: JSON.stringify({ body: body, mentions: mentions || [] }), signal: _abortSignal(DEFAULT_TIMEOUT) });
      var txt = await res.text(); var data = parseJSON(txt);
      if (!res.ok) { markFromError(new Error('HTTP ' + res.status)); throw new Error((data && data.detail) || ('HTTP ' + res.status)); }
      mark(true); return data;
    },

    /* Derive task fields from instructions and materials. Preserve input for manual editing when the API rejects or fails. */
    async parseTaskText(text, model, attachments, options) {
      var signal;
      var timeoutMs = options?.kind === 'automation' ? 90000 : 130000;
      try {
        signal = _abortSignal(timeoutMs);
        var res = await fetch(apiUrl('/tasks/parse'),
          { method: 'POST', headers: { ...authHeaders(true), Accept: 'application/json; keepalive=1' },
            /* Use the model selected for this request, or the personal default when empty. */
            body: JSON.stringify({ text: text || '', model: model || '', keepalive: true,
              attachments: Array.isArray(attachments) ? attachments : [],
              ...(options && (!options.kind || options.kind === 'requirement' || options.kind === 'automation') &&
                Object.prototype.hasOwnProperty.call(options, 'instruction') ? { instruction: options.instruction } : {}),
              ...(options && options.kind === 'automation' ? {kind: 'automation',
                instruction: options.instruction, candidates: options.candidates} : {}) }),
            signal: signal });
        if (!res.ok) {
          // A proxy may return HTML or an unreadable body. Its HTTP status still
          // proves the server answered; never expose that raw response page.
          mark(true);
          var detail = '';
          try { var failure = parseJSON(await res.text()); detail = typeof failure?.detail === 'string' ? failure.detail.trim() : ''; }
          catch (_) { /* Keep the known HTTP status without requiring JSON. */ }
          return { _parseError: '需求解析失败（HTTP ' + res.status + '）' + (detail ? '：' + detail : '') +
            '；原文已保留，请稍后重试或手动填写' };
        }
        var txt = await res.text(), data;
        mark(true);
        try { data = parseJSON(txt); } catch (_) { /* Format errors do not imply a lost connection. */ }
        if (!data || !data.fields || typeof data.fields !== 'object' || Array.isArray(data.fields)) {
          return { _parseError: '需求解析服务返回的内容格式异常，原文已保留，请重试或手动填写' };
        }
        return data.fields;
      } catch (e) {
        markFromError(e);
        return { _parseError: signal?.aborted
          ? '需求解析超时' + (options?.kind === 'automation' ? '（90 秒）' : '') + '，原文已保留，请稍后重试或手动填写'
          : '需求解析网络连接失败，原文已保留，请检查网络后重试或手动填写' };
      }
    },

    /* Team inbox: enqueue, claim, and return tasks. */
    /* Return unclaimed inbox items with assignment and organization metadata; return null on failure. */
    async getTeamInbox() {
      try { var r = await jfetch('/team/inbox'); mark(true); return r; }
      catch (e) { markFromError(e); return null; }
    },
    /* Claim a task for this SoduWork instance; HTTP 409 means another member already claimed it. */
    async claimInboxTask(tid) {
      var res = await fetch(apiUrl('/team/inbox/' + encodeURIComponent(tid) + '/claim'),
        { method: 'POST', headers: authHeaders(true), body: '{}', signal: _abortSignal(DEFAULT_TIMEOUT) });
      var txt = await res.text();
      var data = parseJSON(txt);
      if (!res.ok) { markFromError(new Error('HTTP ' + res.status)); throw new Error((data && data.detail) || ('HTTP ' + res.status)); }
      /*
       * Apply the claimed task locally and broadcast it to the other window before waiting for
       * WS, so it appears as the inbox card disappears.
       */
      mark(true); return acceptTaskResult(data);
    },
    /* Let a manager assign an inbox task directly; 403 means unauthorized and 409 means already claimed. */
    async assignInboxTask(tid, userId) {
      var res = await fetch(apiUrl('/team/inbox/' + encodeURIComponent(tid) + '/assign'),
        { method: 'POST', headers: authHeaders(true), body: JSON.stringify({ userId: userId }), signal: _abortSignal(DEFAULT_TIMEOUT) });
      var txt = await res.text();
      var data = parseJSON(txt);
      if (!res.ok) { markFromError(new Error('HTTP ' + res.status)); throw new Error((data && data.detail) || ('HTTP ' + res.status)); }
      mark(true); return acceptTaskResult(data, 'self');
    },
    /* Return an owned task to the team inbox; the backend rejects workflow tasks and non-owners. */
    async releaseTask(tid, note) {
      var res = await fetch(apiUrl('/tasks/' + encodeURIComponent(tid) + '/release'),
        { method: 'POST', headers: authHeaders(true), body: JSON.stringify({ note: note || '' }), signal: _abortSignal(DEFAULT_TIMEOUT) });
      var txt = await res.text();
      var data = parseJSON(txt);
      if (!res.ok) { markFromError(new Error('HTTP ' + res.status)); throw new Error((data && data.detail) || ('HTTP ' + res.status)); }
      mark(true); return data;
    },

    /* Fetch non-workflow task events: creation, claiming, assignment, transfer, return, and completion. Return null on failure. */
    async getTaskEvents(tid) {
      try { var v = await jfetch('/tasks/' + encodeURIComponent(tid) + '/events'); mark(true); return (v && v.events) || []; }
      catch (e) { markFromError(e); return null; }
    },

    /*
     * Legacy FlowTemplate methods getTaskFlow/advanceTask/rejectTask were replaced by the
     * plugin workflow engine. Use t.workflow (WorkflowRun) and approvals in the original
     * conversation.
     */

    /* Delegate a task to AI: the backend creates an execution record and dispatches the selected agent. */
    /*
     * Return available agents, squads, defaults, and unavailability reasons. Preserve reason
     * on failure so the picker explains an empty list.
     */
    async listAIAgents() {
      try {
        var v = await jfetch('/ai-agents') || { agents: [], squads: [] };
        if (!(v.agents || []).length) v.reason = await localRunnerReason() || v.reason;
        mark(true); return v;
      }
      catch (e) { markFromError(e); return { agents: [], squads: [], reason: '拿不到 AI 清单（后台没连上）' }; }
    },
    /*
     * who={id,type} selects an agent or squad; omit it to use the configured default. brief
     * adds task-specific instructions.
     */
    async dispatchToAI(tid, who, brief, repo, model, executionContext, submissionMode) {
      // All interactive task entries use the same conversation send queue.
      // The main process invokes the authorized executor only at the head.
      const native = window.NativeChat;
      if (native && typeof native.enqueueTask === 'function') {
        const result = await native.enqueueTask(tid, { source: 'task-dispatch', agentId: who && who.id || '',
          assigneeType: who && who.type || 'agent', brief, repo, model, executionContext,
          ...(submissionMode ? { submissionMode } : {}) });
        if (!result || result.ok === false) {
          const error = new Error(result && (result.reason || result.error || result.message) || '需求未能进入会话队列');
          // Explicit business refusals use the same display contract as HTTP errors.
          error.detail = error.message;
          throw error;
        }
        return acceptTaskResult(result);
      }
      var b = who && who.id ? { assigneeId: who.id, assigneeType: who.type || 'agent' } : {};
      if (brief) b.brief = String(brief).slice(0, 2000);
      if (repo && (repo.id || repo.path)) b.repo = repo; /* Resolve the repository ID beneath the Runner's own workspace root. */
      if (model) b.model = String(model);     /* Per-request model override; empty uses the agent's configuration. */
      if (executionContext) b.executionContext = executionContext;
      if (submissionMode) b.submissionMode = submissionMode;
      var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/ai-dispatch',
        { method: 'POST', body: JSON.stringify(b) });
      mark(true);
      if (r && r.ok === false) {
        const error = new Error(r.reason || r.error || r.message || 'AI 派活未被执行机接受');
        error.detail = error.message;
        throw error;
      }
      return acceptTaskResult(r);
    },
    /* A project may contain multiple repositories. Return relative directories; resolve absolute paths against the local workspace. */
    async listRepos() {
      try { var v = await jfetch('/repos'); mark(true); return (v && v.repos) || []; }
      catch (e) { markFromError(e); return []; }
    },
    /*
     * The backend computes one execution contract covering repositories, workflows, CLI
     * availability, and recommendations; do not join separate lists by display name.
     */
    async taskExecutionOptions(body) {
      var r = await jfetch('/task-execution-options', {
        method: 'POST', body: JSON.stringify(body || {})
      });
      mark(true);
      if (r && r.ok === false) {
        throw new Error(r.reason || r.error || r.message || '执行方式暂时无法加载');
      }
      return r || { repos: [], workflows: [], substrates: [], models: [], modelOptions: [],
        defaultModel: '', recommendation: {} };
    },
    /*
     * Personal skill selection is limited by administrator availability; return skills,
     * enabled selections, and revoked selections.
     */
    /* Personal model configuration returns availability and secret metadata, never plaintext keys. */
    async myModels() {
      var r = await domainRead('models', '/my-models');
      return r || { providers: [], usable: [], myModels: [] };
    },
    /*
     * Accept provider overrides, keys, and models. Omitted keys remain unchanged; null removes
     * the personal key and restores the company fallback.
     */
    async saveMyModels(body) {
      var scope = domainScope();
      var r = await jfetch('/my-models', { method: 'PUT', body: JSON.stringify(body || {}) });
      await invalidateDomain('models', scope);
      mark(true); return r;
    },
    /*
     * Test the effective key immediately: use a personal override when configured, otherwise
     * the company key.
     */
    async testMyModel(providerId) {
      var r = await jfetch('/my-models/test', { method: 'POST',
        body: JSON.stringify({ providerId: providerId }) });
      mark(true); return r;
    },
    async checkMyModelCapabilities(body) {
      var scope = domainScope();
      var result = await jfetch('/my-models/capabilities/check', { method: 'POST',
        body: JSON.stringify(body), signal: _abortSignal(140000) });
      await invalidateDomain('models', scope); return result;
    },
    /*
     * CLI installation and real execution checks are asynchronous jobs. Start a job and poll
     * jobId rather than holding an HTTP request open.
     */
    async agentSetup(runnerId) {
      var requestScope = taskStorageKey('ops');
      var target = typeof runnerId === 'string' ? '?runnerId=' + encodeURIComponent(runnerId) : '';
      var r = await jfetch('/agent-setup' + target, { taskScope: requestScope }) || { env: {}, agents: [], modelCount: 0 };
      if (!(r.machines || []).length && !(r.agents || []).length) {
        var reason = await localRunnerReason();
        if (reason) r.env = Object.assign({}, r.env, { why: reason });
      }
      if (requestScope !== taskStorageKey('ops')) throw staleTaskScope();
      mark(true); return r;
    },
    async localAgentSetup() {
      var requestScope = taskStorageKey('ops'), requestHub = base(), epoch = _registrationEpoch;
      function currentRequest() {
        if (requestScope !== taskStorageKey('ops') || requestHub !== base() || epoch !== _registrationEpoch) {
          throw staleTaskScope();
        }
      }
      function runnerId(row) {
        return row && typeof row.runnerId === 'string' ? row.runnerId.trim() : '';
      }
      function currentInstance(row) {
        if (!row || row.execution === 'backend') return false;
        return row.scope != null && row.scope !== '' ? row.scope === 'current-instance' : row.isCurrentDevice === true;
      }
      var inventory = await jfetch('/runners', { taskScope: requestScope }) || {};
      currentRequest();
      async function unavailable() {
        var reason = inventory.localRunnerReason || await localRunnerReason();
        currentRequest();
        return { machines: [], agents: [], models: [], modelCount: null, execution: 'runner',
          env: { ok: false, why: reason || '当前客户端的 Runner 尚未连接，连接后会显示本机底座。' } };
      }
      var runners = (Array.isArray(inventory.runners) ? inventory.runners : []).filter(function (row) {
        return currentInstance(row) && row.online === true && runnerId(row);
      });
      var selected = runners.find(function (row) { return row.scope === 'current-instance'; }) || runners[0];
      if (!selected) return unavailable();
      var selectedId = runnerId(selected);
      // Keep the captured identity through both requests; an older Hub may ignore runnerId.
      var data = await jfetch('/agent-setup?runnerId=' + encodeURIComponent(selectedId), { taskScope: requestScope }) || {};
      currentRequest();
      var machine = (Array.isArray(data.machines) ? data.machines : []).find(function (row) {
        if (runnerId(row) !== selectedId || row.execution === 'backend' || row.online === false) return false;
        if (row.scope != null && row.scope !== '') return row.scope === 'current-instance';
        // /runners proved this exact identity; only absent metadata may be supplemented.
        return row.isCurrentDevice == null || row.isCurrentDevice === true;
      });
      if (!machine) return unavailable();
      machine = Object.assign({}, machine, { runnerId: selectedId, scope: 'current-instance', isCurrentDevice: true });
      var agents = Array.isArray(machine.agents) ? machine.agents : [];
      // Never reuse first-machine compatibility fields returned by an older Hub.
      return { machines: [machine], agents: agents, env: machine.env || {}, execution: 'runner',
        models: Array.isArray(data.models) ? data.models : [],
        modelCount: typeof data.modelCount === 'number' ? data.modelCount : null };
    },
    async myUsage(days) {
      var span = Math.max(1, Math.min(365, Number(days || 30)));
      var r = await jfetch('/usage/me?days=' + encodeURIComponent(span));
      mark(true); return r || { days: span, summary: {}, trend: [],
        bySource: [], byAgent: [], recent: [], quality: {} };
    },
    /* action: install | update | uninstall | check */
    /*
     * Require runnerId for machine-level installation/removal; omitting it could modify the
     * wrong host.
     */
    async agentInstall(key, action, runnerId, options) {
      var r = await jfetch('/agent-setup/install', { method: 'POST', taskScope: taskStorageKey('ops'),
        body: JSON.stringify({ key: key, action: action || 'install', runnerId: runnerId || '',
          ...(action === 'login-cancel' && options?.jobId ? { jobId: String(options.jobId) } : {}) }) });
      mark(true); return r;
    },
    /* Run a minimal real task using the same effective-key resolution as normal dispatch. */
    async agentProbe(key, model, runnerId) {
      var r = await jfetch('/agent-setup/probe', { method: 'POST', taskScope: taskStorageKey('ops'),
        body: JSON.stringify({ key: key, model: model || '', runnerId: runnerId || '' }) });
      mark(true); return r;
    },
    async agentJob(jid) {
      var r = await jfetch('/agent-setup/job/' + encodeURIComponent(jid), { taskScope: taskStorageKey('ops') });
      mark(true); return r;
    },

    async setAgentModel(key, model) {
      var scope = domainScope();
      var r = await jfetch('/agent-setup/model', {
        method: 'PUT', taskScope: taskStorageKey('ops'), body: JSON.stringify({ key: key, model: model || '' })
      });
      await invalidateDomain('models', scope);
      mark(true); return r;
    },
    /* A Runner hosts task execution. Pausing blocks new tasks without interrupting existing sessions. */
    async cloudEnvironments() { return jfetch('/cloud-environments', { taskScope: taskStorageKey('ops') }); },
    async addCloudEnvironment(body) {
      return cloudSetup('/cloud-environments', body);
    },
    async updateCloudEnvironment(id, body) {
      return jfetch('/cloud-environments/' + encodeURIComponent(id), { method: 'PATCH', taskScope: taskStorageKey('ops'), body: JSON.stringify(body || {}) });
    },
    async rotateCloudEnvironmentCredential(id, body) {
      return cloudSetup('/cloud-environments/' + encodeURIComponent(id) + '/credentials', body);
    },
    async removeCloudEnvironment(id) {
      return jfetch('/cloud-environments/' + encodeURIComponent(id), { method: 'DELETE', taskScope: taskStorageKey('ops') });
    },
    async runners() {
      var r = await jfetch('/runners') || { runners: [] };
      r.localRunnerReason = await localRunnerReason();
      mark(true); return r;
    },
    async runnerMode(runnerId, mode) {
      var r = await jfetch('/runners/' + encodeURIComponent(runnerId) + '/mode', {
        method: 'POST', body: JSON.stringify({ mode: mode })
      });
      mark(true); return r;
    },
    async runnerProbe(runnerId) {
      var r = await jfetch('/runners/' + encodeURIComponent(runnerId) + '/probe', { method: 'POST' });
      mark(true); return r;
    },
    async runnerComponentInstall(runnerId, key) {
      var r = await jfetch('/runners/' + encodeURIComponent(runnerId) + '/components/' +
        encodeURIComponent(key) + '/install', { method: 'POST' });
      mark(true); return r;
    },
    async runnerComponentJob(runnerId, jobId) {
      var r = await jfetch('/runners/' + encodeURIComponent(runnerId) + '/components/jobs/' +
        encodeURIComponent(jobId));
      mark(true); return r;
    },



    async setExecutionName(scope, key, name) {
      var r = await jfetch('/execution-names', {
        method: 'PUT', body: JSON.stringify({ scope: scope, key: key, name: name || '' })
      });
      mark(true); return r;
    },
    /*
     * Git/Gerrit submissions use the user's code identity. Return credential presence, length,
     * and type, never plaintext.
     */
    async myGit() {
      var r = await jfetch('/my-git');
      mark(true); return r || { git: {}, repos: [] };
    },
    /* Omitted token/key fields remain unchanged; null deletes them without requiring re-entry for unrelated edits. */
    async saveMyGit(body) {
      var r = await jfetch('/my-git', { method: 'PUT', body: JSON.stringify(body || {}) });
      mark(true); return r;
    },
    /* Validate credentials with read-only ls-remote; do not modify the remote repository. */
    async testMyGit(url) {
      var r = await jfetch('/my-git/test', { method: 'POST', body: JSON.stringify({ url: url }) });
      mark(true); return r;
    },
    /*
     * Human review covers requirements and real-environment acceptance; automation handles
     * code review and merging. Load full evidence only on demand.
     */
    async listApprovals(view) {
      var mode = view === 'done' ? 'done' : 'pending';
      var r = await jfetch('/approvals?view=' + mode);
      mark(true); return r || { items: [], count: 0, pendingCount: 0, doneCount: 0, view: mode };
    },
    async approvalDetail(requestId) {
      var r = await jfetch('/approvals/' + encodeURIComponent(requestId));
      mark(true); return r || {};
    },
    async uploadApprovalEvidence(requestId, file) {
      var fd = new FormData();
      fd.append('file', file);
      var res = await fetch(apiUrl('/approvals/' + encodeURIComponent(requestId) + '/evidence'),
        { method: 'POST', headers: authHeaders(false), body: fd, signal: _abortSignal(30000) });
      if (!res.ok) {
        var detail = '';
        try { detail = String((await res.json()).detail || ''); } catch (_) { /* non-json error */ }
        throw new Error(detail || ('HTTP ' + res.status));
      }
      mark(true);
      return await res.json();
    },
    async decideApproval(requestId, decision, note, rework, reworkAttachmentIds) {
      var body = { decision: decision, note: note || '' };
      /*
       * Pass false only for an explicit return to backlog. Omission retains automatic rework;
       * older backends safely ignore the added field.
       */
      if (rework === false) body.rework = false;
      if (Array.isArray(reworkAttachmentIds) && reworkAttachmentIds.length) {
        body.reworkAttachmentIds = [...new Set(reworkAttachmentIds.map(String))].slice(0, 20);
      }
      var r = await jfetch('/approvals/' + encodeURIComponent(requestId) + '/decision', {
        method: 'POST', body: JSON.stringify(body)
      });
      mark(true); if (r && r.ok !== false) approvalsInvalidated(); return r;
    },
    async uploadApprovalReworkMaterial(requestId, file) {
      try { return await uploadFile('/approvals/' + encodeURIComponent(requestId) + '/rework-materials', file, false, null); }
      catch (e) { markFromError(e); throw e; }
    },
    /* Withdraw an approval; the backend rejects irreversible changes already merged or published. */
    async revokeApproval(requestId, note) {
      var r = await jfetch('/approvals/' + encodeURIComponent(requestId) + '/revoke', {
        method: 'POST', body: JSON.stringify({ note: note || '' })
      });
      mark(true); if (r && r.ok !== false) approvalsInvalidated(); return r;
    },
    ...global.SoduWorkPluginAPI.create({
      jfetch, uploadFile, _fetch, parseJSON, mark, markFromError, pluginsChanged,
      taskStorageKey, registrationEpoch: () => _registrationEpoch,
      staleTaskScope, registrationBoundaryError
    }),
    /*
     * Task details, AI workbench, and approvals share task_trace facts. Use lightweight cards
     * in lists and fetch the full trace on opening a task.
     */
    async taskCard(taskId) {
      try {
        var r = await jfetch('/tasks/' + encodeURIComponent(taskId) + '/card');
        mark(true); return r;
      } catch (e) { markFromError(e); return null; }
    },
    async taskTrace(taskId) {
      try {
        var r = await jfetch('/tasks/' + encodeURIComponent(taskId) + '/trace');
        mark(true); return r;
      } catch (e) { markFromError(e); return null; }
    },
    async saveTaskEvaluation(taskId, value) {
      var r = await jfetch('/tasks/' + encodeURIComponent(taskId) + '/evaluation', {
        method: 'PUT', body: JSON.stringify(value || {})
      });
      mark(true); return r;
    },
    async decideTaskEvolution(taskId, proposalId, decision, note) {
      var r = await jfetch('/tasks/' + encodeURIComponent(taskId) + '/evolution/' +
        encodeURIComponent(proposalId) + '/decision', {
          method: 'POST', body: JSON.stringify({ decision: decision || '', note: note || '' })
        });
      mark(true); return r;
    },
    /*
     * Stop workflow and AI execution for offline handling while retaining evidence. Keep this
     * method distinct from transferring a task to avoid duplicate object keys.
     */
    async handoffAutomationTask(taskId, note, status) {
      var r = await jfetch('/tasks/' + encodeURIComponent(taskId) + '/manual-handoff', {
        method: 'POST',
        body: JSON.stringify({ note: note || '', status: status || 'done' })
      });
      mark(true); return acceptTaskResult(r);
    },
    async mySkills() {
      try { var v = await jfetch('/skills'); mark(true); return v || { skills: [] }; }
      catch (e) { markFromError(e); return { skills: [] }; }
    },
    async setMySkills(names) {
      var r = await jfetch('/skills', { method: 'PUT', body: JSON.stringify({ enabled: names || [] }) });
      mark(true); return r;
    },
    async refreshMySkills() {
      var r = await jfetch('/skills/refresh', { method: 'POST', body: '{}' });
      mark(true); return r || { skills: [], mcpTemplates: [], summary: {} };
    },
    async capabilityCatalog() {
      var r = await jfetch('/capabilities');
      mark(true); return r || { skills: [], mcpTemplates: [], summary: {} };
    },
    async createMySkill(body) {
      var r = await jfetch('/skills/create', { method: 'POST', body: JSON.stringify(body || {}) });
      mark(true); return r;
    },
    async deleteMySkill(name, checksum) {
      var r = await jfetch('/skills/' + encodeURIComponent(name), {
        method: 'DELETE', body: JSON.stringify({ checksum: checksum }) });
      mark(true); return r;
    },
    async deleteMyMcpServer(id) {
      var r = await jfetch('/mcp-servers/' + encodeURIComponent(id), { method: 'DELETE' });
      mark(true); return r;
    },
    async preflightMySkill(file) {
      var r = await uploadFile('/skills/preflight', file);
      mark(true); return r;
    },
    skillDetails(name) { return jfetch('/skills/' + encodeURIComponent(name) + '/details'); },
    skillContent(name, checksum, path, offset) {
      return jfetch('/skills/' + encodeURIComponent(name) + '/content?' +
        new URLSearchParams({ checksum, path, offset: offset || 0 }));
    },
    previewSkillContent(file, path, offset) {
      return uploadFile('/skills/preflight/content?' +
        new URLSearchParams({ path, offset: offset || 0 }), file);
    },
    shareSkill(name, body) {
      return jfetch('/skills/' + encodeURIComponent(name) + '/share', {
        method: 'POST', body: JSON.stringify(body) });
    },
    async downloadSkill(name, checksum, path) {
      await jfetch('/skills/' + encodeURIComponent(name) + '/details');
      var url = '/skills/' + encodeURIComponent(name) + '/download?' +
        new URLSearchParams({ checksum, path: path || '' });
      var res = await _fetch(url, {}, 60000);
      if (!res.ok) throw httpError(res, await res.text());
      var blob = await res.blob();
      var link = document.createElement('a');
      var objectUrl = URL.createObjectURL(blob);
      link.href = objectUrl;
      link.download = path ? path.split('/').pop() : name + '.skill';
      link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
    },
    async importMySkill(file) {
      var r = await uploadFile('/skills/import', file);
      mark(true); return r;
    },
    async exportMyMcp(ids) { return jfetch('/mcp-servers/export', {method:'POST', taskScope:taskStorageKey('ops'), body:JSON.stringify({ids:ids})}); },
    async previewMyMcpImport(file) { return uploadFile('/mcp-servers/import/preview', file, false, null, taskStorageKey('ops')); },
    async importMyMcp(file) { return uploadFile('/mcp-servers/import?confirmed=true', file, false, null, taskStorageKey('ops')); },
    async myMcpSubmissions() { return jfetch('/mcp-servers/submissions'); },
    async shareMyMcp(id, name) {
      return jfetch('/mcp-servers/' + encodeURIComponent(id) + '/share', {
        method: 'POST', taskScope: taskStorageKey('ops'), body: JSON.stringify({name: name, confirmed: true})
      });
    },
    async probeCompanyMcp(id) {
      return jfetch('/mcp-servers/company/' + encodeURIComponent(id) + '/probe', {method:'POST', taskScope:taskStorageKey('ops'), signal:_abortSignal(150000)});
    },
    async myMcpServers() {
      var r = await jfetch('/mcp-servers');
      mark(true); return r || { company: [], personal: [], enabledCompany: [] };
    },
    async selectMcpServers(changes) {
      var scope = taskStorageKey('ops');
      return jfetch('/mcp-servers/selection', {
        method: 'PATCH', taskScope: scope, body: JSON.stringify({changes: changes})
      });
    },
    async saveMyMcpServer(server, original) {
      var scope = taskStorageKey('ops');
      var r = await jfetch('/mcp-servers/upsert', { method: 'POST', taskScope: scope,
        body: JSON.stringify({server: server, original: original || null}) });
      mark(true); return r;
    },
    async saveMyMcpServers(personal, enabledCompany) {
      var r = await jfetch('/mcp-servers', {
        method: 'PUT',
        body: JSON.stringify({ servers: personal || [], enabledCompany: enabledCompany || [] })
      });
      mark(true); return r;
    },
    async connectorOAuthProviders() { return jfetch('/mcp-servers/oauth/providers', {taskScope:taskStorageKey('ops')}); },
    async startConnectorOAuth(provider, connectorId, server) {
      return jfetch('/mcp-servers/oauth/start', {method:'POST', taskScope:taskStorageKey('ops'), body:JSON.stringify({provider,connectorId,...(server?{server}:{})})});
    },
    async connectorOAuthStatus(attemptId) { return jfetch('/mcp-servers/oauth/status/'+encodeURIComponent(attemptId), {taskScope:taskStorageKey('ops')}); },
    async cancelConnectorOAuth(attemptId) { return jfetch('/mcp-servers/oauth/cancel/'+encodeURIComponent(attemptId), {method:'POST', taskScope:taskStorageKey('ops')}); },
    async probeMyMcpServer(spec) {
      var r = await jfetch('/mcp-servers/probe', {
        method: 'POST', taskScope: taskStorageKey('ops'), signal: _abortSignal(150000), body: JSON.stringify(spec || {})
      });
      mark(true); return r;
    },
    async preflightMyMcpServer(spec) {
      var r = await jfetch('/mcp-servers/preflight', {
        method: 'POST', taskScope: taskStorageKey('ops'), body: JSON.stringify(spec || {})
      });
      mark(true); return r;
    },
    /*
     * Personal schedules create AI tasks when due. Backend access is scoped to the current
     * SoduWork instance.
     */
    async listSchedules() {
      /*
       * Propagate schedule-list failures to the retry UI; returning [] would misrepresent an
       * outage as an empty list.
       */
      var v = await jfetch('/schedules'); mark(true); return v || [];
    },
    async listScheduleTemplates() {
      var v = await jfetch('/schedules/templates'); mark(true); return Array.isArray(v) ? v : [];
    },
    async preflightSchedule(b, options) {
      var epoch = _registrationEpoch, hub = base(), owner = taskStorageKey('ops');
      var r = await jfetch('/schedules/preflight',
        { method: 'POST', body: JSON.stringify(b || {}) });
      if (epoch !== _registrationEpoch || hub !== base() || owner !== taskStorageKey('ops')) throw staleTaskScope();
      var bridge = global.soduWorkAPI;
      if (r && r.deviceDependencies && bridge && bridge.automationPreflight) {
        r = await bridge.automationPreflight({ server: r, hub: hub, force: !!(options && options.force) });
        if (epoch !== _registrationEpoch || hub !== base() || owner !== taskStorageKey('ops')) throw staleTaskScope();
      }
      mark(true); return r || {};
    },
    async createSchedule(b) {
      var r = await jfetch('/schedules', { method: 'POST', taskScope: taskStorageKey('ops'), body: JSON.stringify(b || {}) });
      mark(true); return r;
    },
    async updateSchedule(sid, b) {
      var r = await jfetch('/schedules/' + encodeURIComponent(sid),
        { method: 'PUT', body: JSON.stringify(b || {}) });
      mark(true); return r;
    },
    async deleteSchedule(sid) {
      var r = await jfetch('/schedules/' + encodeURIComponent(sid), { method: 'DELETE' });
      mark(true); return r;
    },
    async listScheduleRuns(sid, limit) {
      var q = '?limit=' + encodeURIComponent(limit || 20);
      var r = await jfetch('/schedules/' + encodeURIComponent(sid) + '/runs' + q);
      mark(true); return (r && r.items) || [];
    },
    async runSchedule(sid, options) {
      var epoch = _registrationEpoch, hub = base(), owner = taskStorageKey('ops');
      var body = options && options.instanceId ? { instanceId: String(options.instanceId) } : {};
      var r = await jfetch('/schedules/' + encodeURIComponent(sid) + '/run', {
        method: 'POST', body: JSON.stringify(body)
      });
      // Wake only after the Hub accepts the run. The native worker coalesces wakes;
      // an older/unavailable bridge must not turn an accepted run into a UI error.
      if (epoch === _registrationEpoch && hub === base() && owner === taskStorageKey('ops') && r && r.ok !== false) {
        var bridge = global.soduWorkAPI;
        try {
          if (bridge && typeof bridge.automationConversationsWake === 'function') {
            Promise.resolve(bridge.automationConversationsWake({ hub: hub })).catch(function () {});
          }
        } catch (_) {}
      }
      mark(true); return r;
    },
    async acknowledgeScheduleRun(runId, body) {
      var r = await jfetch('/automation-conversations/' + encodeURIComponent(runId) + '/state', {
        method: 'POST', body: JSON.stringify(body || {})
      });
      mark(true); return r;
    },
    /* Preview the same backend-generated title, description, and carried materials used by dispatch. */
    async aiPreview(tid, brief, repo) {
      try {
        var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/ai-preview',
          { method: 'POST', body: JSON.stringify({ brief: brief || '', repo: repo || null }) });
        mark(true); return r;
      } catch (e) { markFromError(e); return null; }
    },
    /* List eligible colleagues and transfer an owned task. */
    async listTeammates() {
      try { var r = await jfetch('/team/mates'); mark(true); return r || { mates: [] }; }
      catch (e) { markFromError(e); return { ok: false, mates: [], reason: '拿不到同事清单（后台没连上）' }; }
    },
    /* Send a brief colleague mention from the conversation; propagate backend rejection details. */
    async sendMateMessage(uid, text, outputs) {
      var requestScope = taskStorageKey('ops');
      if (outputs?.files?.length) {
        try { const caps = await jfetch('/team/message-capabilities'); if (!caps?.files) throw Error(); }
        catch (_) { throw Error('后台暂不支持成果发送或连接已断开，请更新后台后重试；消息尚未发送'); }
      }
      /*
       * Inline base64 deliverables can reach 20 MB; allow 120 seconds for uploads instead of the
       * default eight-second timeout.
       */
      var r = await jfetch('/team/mates/' + encodeURIComponent(uid) + '/message',
        { method: 'POST', body: JSON.stringify({ ...(outputs || {}), text: String(text || '') }), signal: _abortSignal(120000), taskScope: requestScope });
      mark(true); if (r?.ok !== false) refreshSentNotices(requestScope); return r;
    },
    async draftMateMessage(context) {
      return await jfetch('/team/message-draft', {
        method: 'POST', body: JSON.stringify(context || {}), signal: _abortSignal(30000)
      });
    },
    async mateMessageFile(id) {
      return jfetch('/team/message-files/' + encodeURIComponent(id));
    },
    async mateMessages(folder, limit, before, ifRevision) {
      try {
        var q = '?folder=' + encodeURIComponent(folder || 'received') + '&limit=' + encodeURIComponent(limit || 100);
        if (before) q += '&before=' + encodeURIComponent(before);
        else if (ifRevision) q += '&ifRevision=' + encodeURIComponent(ifRevision);
        var shared = !before && Number(limit) === 200 && (!folder || folder === 'sent' || folder === 'received');
        var r = shared ? await domainRead('team-messages-' + (folder === 'sent' ? 'sent' : 'received'), '/team/messages' + q)
          : await jfetch('/team/messages' + q, { taskScope: taskStorageKey('ops') });
        if (shared && ifRevision && r?.revision === ifRevision) r = {ok: true, folder: folder === 'sent' ? 'sent' : 'received',
          items: [], nextCursor: '', notModified: true, revision: r.revision};
        return r || { ok: true, items: [] };
      } catch (e) { markFromError(e); return { ok: false, items: [], reason: '通知暂时无法加载，请重试' }; }
    },
    async invalidateMateMessageCache(folder) {
      var scope = domainScope();
      await Promise.all((folder ? [folder] : ['received', 'sent'])
        .map(side => invalidateDomain('team-messages-' + (side === 'sent' ? 'sent' : 'received'), scope)));
    },
    async markMateMessageRead(id) {
      var scope = domainScope();
      var r = await jfetch('/team/messages/' + encodeURIComponent(id) + '/read', { method: 'POST', taskScope: taskStorageKey('ops') });
      await invalidateDomain('team-messages-received', scope);
      mark(true); return r;
    },
    async markMateMessageDelivered(id) {
      var scope = domainScope();
      var r = await jfetch('/team/messages/' + encodeURIComponent(id) + '/delivered', { method: 'POST', taskScope: taskStorageKey('ops') });
      await invalidateDomain('team-messages-received', scope);
      mark(true); return r;
    },
    async handoffTask(tid, assigneeUserId, note) {
      var requestScope = taskStorageKey('ops');
      var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/handoff',
        { method: 'POST', body: JSON.stringify({ assigneeUserId: assigneeUserId, note: note || '' }), taskScope: requestScope });
      mark(true);
      if (r && r.ok === false) {
        throw new Error(r.reason || r.error || r.message || '需求没有成功转交给同事');
      }
      refreshSentNotices(requestScope);
      return r;
    },
    /*
     * Execution status distinguishes code delivery from other output. Configured code tasks
     * complete when code.stage is merged; other tasks require returned files or URLs. stalled
     * means the agent reports completion without a deliverable or commit.
     */
    async aiStatus(tid) {
      var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/ai-status');
      mark(true); return r;
    },
    /*
     * Read delivery status and its timeline without invoking Git: stage, branch, target,
     * commits, files, merge result, conflicts, and repository metadata.
     */
    async taskDelivery(tid) {
      try {
        var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/delivery');
        mark(true); return r;
      } catch (e) { markFromError(e); return null; }
    },
    /* Retry merging only after explicit user action; automatic retries stop on conflict to avoid repeated fetch/merge attempts. */
    async retryMerge(tid) {
      var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/retry-merge', { method: 'POST' });
      mark(true); return r;
    },
    /*
     * Read incremental execution events without SSH: say for agent text, do for actions, and
     * out for command output.
     */
    async aiSession(tid, since, ref) {
      try {
        var params = new URLSearchParams();
        if (since) params.set('since', String(since));
        if (ref) params.set('ref', String(ref));
        var q = params.size ? '?' + params.toString() : '';
        var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/ai-session' + q);
        mark(true); return r || { ok: false, items: [] };
      } catch (e) { markFromError(e); return { ok: false, items: [], httpStatus: Number(e.status) || 0, error: '拿不到执行记录，请检查需求权限或后台连接' }; }
    },
    /*
     * Queue a message on the execution record rather than attaching to a TTY. Pending work
     * receives it in the next run; active work is not interrupted.
     */
    async aiSay(tid, text) {
      var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/ai-say',
        { method: 'POST', body: JSON.stringify({ text: text || '' }) });
      mark(true); return r;
    },
    /*
     * Request cancellation of the active local run. Hosted noninteractive agents without
     * cancellation support return 409 with a reason.
     */
    async aiStop(tid) {
      var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/ai-stop',
        { method: 'POST', body: '{}' });
      mark(true); return r;
    },
    /* Request delivery by adding a reminder to the execution record. */
    async aiRemind(tid) {
      var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/ai-remind', { method: 'POST', body: '{}' });
      mark(true); return r;
    },

    /*
     * List local CLI sessions from backend memory without remote calls; the console polls
     * every two seconds.
     */
    async aiConsoles() {
      try {
        var r = await jfetch('/ai-consoles');
        mark(true); return r || { runs: [] };
      } catch (e) { markFromError(e); return { runs: [], offline: true }; }
    },
    /*
     * Expose unprocessed terminal output for diagnosing local execution failures.
     */
    async aiRaw(tid) {
      try {
        var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/ai-raw');
        mark(true); return r || { ok: false, text: '' };
      } catch (e) { markFromError(e); return { ok: false, text: '', error: '拿不到（后台没连上）' }; }
    },

    /*
     * Fetch the agent workbench overview from local tables in one request; load live events
     * and outputs only when opening a station.
     */
    async aiDesks() {
      try {
        var r = await jfetch('/ai-desks');
        mark(true); return r || { desks: [] };
      } catch (e) { markFromError(e); return { desks: [], offline: true, reason: '后台没连上' }; }
    },
    async aiDeskCleanupAbnormal() {
      var r = await jfetch('/ai-desks/cleanup-abnormal', { method: 'POST', body: '{}' });
      mark(true); return r || { ok: true, cleaned: [], skipped: [] };
    },

    /*
     * Paginate agent task history. scope selects done (default), live, or all.
     */
    async aiAgentTasks(agent, opts) {
      opts = opts || {};
      var q = '?agent=' + encodeURIComponent(agent || '') +
        '&scope=' + (opts.scope || 'done') +
        '&offset=' + (opts.offset || 0) + '&limit=' + (opts.limit || 20);
      try {
        var r = await jfetch('/ai-agent-tasks' + q);
        mark(true); return r || { items: [], total: 0, hasMore: false };
      } catch (e) {
        markFromError(e);
        return { items: [], total: 0, hasMore: false, offline: true };
      }
    },

    /*
     * Long tasks plan first and execute one milestone per run. Persist progress outside the
     * conversation because context resets may retain only the workspace.
     */
    /* The initial run produces a plan without modifying code. */
    async aiPlan(tid, opts) {
      var o = opts || {};
      var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/ai-plan',
        { method: 'POST', body: JSON.stringify({
          assigneeId: o.assigneeId || '', assigneeType: o.assigneeType || '',
          brief: o.brief || '', repo: o.repo || null, model: o.model || '',
          executionContext: o.executionContext || null }) });
      mark(true); return r;
    },
    /* Return confirmed milestones and an optional draft; the draft exists only before any milestone is confirmed. */
    /*
     * Use one portable archive name for the material card, save dialog and acceptance input.
     */
    artifactZipFilename(title) {
      var name = Array.from(String(title || '交付物').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim())
        .slice(0, 40).join('').replace(/[. ]+$/g, '') || '交付物';
      if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
      return name + '.zip';
    },
    async downloadArtifactsZip(tid, title, artifactVersionId) {
      // Opening the URL in a browser omits the device header and returns 401.
      var filename = global.SoduWorkAPI.artifactZipFilename(title);
      // Desktop downloads use the same native save dialog and account checks as individual files.
      if (global.soduWorkAPI?.downloadAttachment) {
        var saved = await global.soduWorkAPI.downloadAttachment({ deliveryBundle: true, taskId: String(tid),
          artifactVersionId: String(artifactVersionId || ''), filename: filename });
        if (!saved || (saved.ok === false && !saved.canceled && !saved.cancelled))
          throw new Error(saved?.reason || '下载未完成');
        return saved;
      }
      var res = await _fetch('/tasks/' + encodeURIComponent(tid) + '/artifacts.zip' + (artifactVersionId ? '?artifactVersionId=' + encodeURIComponent(artifactVersionId) : ''),
        { method: 'GET' }, 60000);
      if (!res.ok) {
        var msg = 'HTTP ' + res.status;
        try { var j = await res.json(); if (j && j.detail) msg = j.detail; } catch (e) {}
        throw new Error(msg);
      }
      var blob = await res.blob();
      var n = res.headers.get('X-Artifact-Count') || '';
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      mark(true);
      return { ok: true, count: n };
    },
    /*
     * Per-task automatic milestone execution advances after a successful run. It does not
     * prove acceptance criteria; record results as not manually accepted.
     */
    async setMsAuto(tid, on) {
      var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/ms-auto',
        { method: 'POST', body: JSON.stringify({ on: !!on }) });
      mark(true); return r;
    },
    async listMilestones(tid) {
      try {
        var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/milestones');
        mark(true); return r || { items: [], draft: null };
      } catch (e) { markFromError(e); return { items: [], draft: null, offline: true }; }
    },
    /* Replace the complete milestone list with the user-confirmed revision. */
    async saveMilestones(tid, items) {
      var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/milestones',
        { method: 'PUT', body: JSON.stringify({ items: items || [] }) });
      mark(true); return r;
    },
    /* Run the specified milestone or the next pending one by continuing the same execution record and workspace. */
    async runMilestone(tid, id, repo) {
      var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/ai-run-milestone',
        { method: 'POST', body: JSON.stringify({ id: id || '', repo: repo || null }) });
      mark(true); return r;
    },
    /* Record human acceptance against the milestone criteria; rejection requires a reason carried into the next run. */
    async milestoneVerdict(tid, mid, ok, note) {
      var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/milestones/' +
        encodeURIComponent(mid) + '/verdict',
        { method: 'POST', body: JSON.stringify({ pass: !!ok, note: note || '' }) });
      mark(true); return r;
    },

    /* Reject for rework; toAI=true sends feedback to the same agent in its original workspace. */
    async rejectArtifact(tid, note, toAI, reworkAttachmentIds) {
      var ids = Array.isArray(reworkAttachmentIds)
        ? [...new Set(reworkAttachmentIds.map(String))].slice(0, 20) : [];
      var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/reject-artifact',
        { method: 'POST', body: JSON.stringify({ note: note || '', toAI: !!toAI,
          ...(ids.length ? { reworkAttachmentIds: ids } : {}) }) });
      mark(true); return r;
    },
    /* Accept AI output as the task creator and return the updated task. */
    async reviewTask(tid, note) {
      var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/review',
        { method: 'POST', body: JSON.stringify({ note: note || '' }) });
      mark(true); return r;
    },
    /*
     * Submit current output for review. Hub freezes ArtifactVersion and creates or reuses the
     * approval; clients cannot emulate this by PATCHing requirementStage.
     */
    async submitTaskReview(tid, note) {
      var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/submit-review',
        { method: 'POST', body: JSON.stringify({ note: note || '' }) });
      mark(true); return acceptTaskResult(r);
    },
    /* Evaluate the frozen delivery evidence under server-side reviewer permissions and quality gates. */
    async autoReviewTask(tid, note) {
      var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/auto-review', {
        method: 'POST', body: JSON.stringify({ note: note || '' })
      });
      mark(true); return acceptTaskResult(r);
    },

    /* Task image and document attachments. */
    attachmentUrl(a) { return base() + (a && a.url || ''); },   // Absolute URL for images and external links.
    async listAttachments(tid) {
      try { var l = await jfetch('/tasks/' + encodeURIComponent(tid) + '/attachments'); return l || []; }
      catch (e) { markFromError(e); throw e; }
    },
    async getAcceptanceContext(tid) {
      try { return await jfetch('/tasks/' + encodeURIComponent(tid) + '/acceptance-context'); }
      catch (e) { markFromError(e); throw e; }
    },
    async uploadAttachment(tid, file, metadata) {
      try { return await uploadFile('/tasks/' + encodeURIComponent(tid) + '/attachments', file, false, metadata); }
      catch (e) { markFromError(e); throw e; }
    },
    async uploadTaskReworkMaterial(tid, file) {
      try { return await uploadFile('/tasks/' + encodeURIComponent(tid) + '/rework-materials', file, false, null); }
      catch (e) { markFromError(e); throw e; }
    },
    async deleteAttachment(aid) {
      try { await jfetch('/attachments/' + encodeURIComponent(aid), { method: 'DELETE' }); return true; }
      catch (e) { markFromError(e); throw e; }
    },

    async publishDelivery(payload) {
      var requestScope = taskStorageKey('ops');
      if (!payload?.manifest || typeof payload.data !== 'string') throw new Error('成果内容尚未准备好');
      var raw = atob(payload.data), bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      var form = new FormData(); form.append('manifest', JSON.stringify(payload.manifest));
      form.append('file', new Blob([bytes], { type: payload.contentType }), payload.filename);
      var res = await fetch(apiUrl('/deliveries'), { method: 'POST', headers: authHeaders(false), body: form, signal: _abortSignal(120000) });
      assertLibraryScope(requestScope);
      var text = await res.text(); assertLibraryScope(requestScope);
      if (!res.ok) { var error = httpError(res, text); handleAuthError(error); throw error; }
      /*
       * Reject empty responses with a clear error instead of JSON.parse's generic end-of-input
       * message.
       */
      if (!text) throw new Error('服务返回了空响应（上传可能未送达）');
      return parseJSON(text);
    },
    async syncTaskDelivery(taskId) {
      return jfetch('/deliveries/from-task/' + encodeURIComponent(taskId), { taskScope: taskStorageKey('ops'), method: 'POST' });
    },
    async getTaskDelivery(taskId) {
      return jfetch('/deliveries/from-task/' + encodeURIComponent(taskId), { taskScope: taskStorageKey('ops') });
    },
    async listDeliveries(filters) {
      var query = new URLSearchParams(filters || {});
      return jfetch('/deliveries?' + query, { taskScope: taskStorageKey('ops') });
    },
    async getDelivery(id) {
      return jfetch('/deliveries/' + encodeURIComponent(id), { taskScope: taskStorageKey('ops') });
    },
    async readDeliveryFile(id, path) {
      var requestScope = taskStorageKey('ops');
      var res = await fetch(apiUrl('/deliveries/' + encodeURIComponent(id) + '/files/' + String(path).split('/').map(encodeURIComponent).join('/')), {
        headers: authHeaders(false), signal: _abortSignal(120000), redirect: 'error'
      });
      assertLibraryScope(requestScope);
      if (!res.ok) { var message = await res.text(); assertLibraryScope(requestScope); throw httpError(res, message); }
      var cap = 64 * 1024 * 1024;
      if (Number(res.headers.get('content-length')) > cap) { await res.body?.cancel(); throw new Error('文件较大，请下载整份成果'); }
      var reader = res.body.getReader(), parts = [], total = 0;
      try { for (;;) { var part = await reader.read(); assertLibraryScope(requestScope); if (part.done) break;
        total += part.value.byteLength; if (total > cap) throw new Error('文件较大，请下载整份成果'); parts.push(part.value); }
      } finally { await reader.cancel().catch(function () {}); reader.releaseLock(); }
      assertLibraryScope(requestScope);
      return new Blob(parts, { type: res.headers.get('content-type') || 'application/octet-stream' });
    },
    async listLibrary(filters) {
      var f = filters || {}, q = new URLSearchParams();
      if (f.scope) q.set('scope', String(f.scope));
      if (f.storage) q.set('storage', String(f.storage));
      if (f.query) q.set('query', String(f.query));
      if (f.folderId) q.set('folderId', String(f.folderId));
      try { var r = await jfetch('/library' + (q.toString() ? '?' + q.toString() : ''), { taskScope: taskStorageKey('ops') }); mark(true); return r || { folders: [], items: [] }; }
      catch (e) { markFromError(e); throw e; }
    },
    async listLibraryShareMembers() {
      try { var r = await jfetch('/library/share-members', { taskScope: taskStorageKey('ops'), cache: 'no-store' }); mark(true); return r || { ok: true, members: [] }; }
      catch (e) { markFromError(e); throw e; }
    },
    async shareLibraryItem(id, recipientUserIds, note) {
      const requestScope = taskStorageKey('ops');
      try {
        var r = await jfetch('/library/items/' + encodeURIComponent(id) + '/share', {
          taskScope: requestScope, method: 'POST',
          body: JSON.stringify({ recipientUserIds: Array.isArray(recipientUserIds) ? recipientUserIds : [], note: String(note || '') })
        }); mark(true); refreshSentNotices(requestScope); return r;
      } catch (e) { markFromError(e); throw e; }
    },
    async shareLibraryItems(ids, recipientUserIds, note, options) {
      const requestScope = taskStorageKey('ops');
      try {
        var itemIds = [...new Set((Array.isArray(ids) ? ids : []).map(function (id) { return String(id || '').trim(); }).filter(Boolean))];
        var payload = { itemIds: itemIds, recipientUserIds: Array.isArray(recipientUserIds) ? recipientUserIds : [], note: String(note || '') };
        if (Array.isArray(options?.folderIds) && options.folderIds.length) payload.folderIds = [...new Set(options.folderIds.map(function (id) { return String(id || '').trim(); }).filter(Boolean))];
        if (options?.forcePackage === true) payload.forcePackage = true;
        if (options?.requestId) payload.requestId = String(options.requestId);
        if (Array.isArray(options?.localFiles) && options.localFiles.length) payload.localFiles = options.localFiles;
        var r = await jfetch('/library/items/batch-share', {
          taskScope: requestScope, method: 'POST',
          signal: _abortSignal(120000), body: JSON.stringify(payload)
        }); mark(true); refreshSentNotices(requestScope); return r;
      } catch (e) { markFromError(e); throw e; }
    },
    async shareLocalLibraryFile(body) {
      const requestScope = taskStorageKey('ops');
      try {
        var r = await jfetch('/library/share-local', { taskScope: requestScope, method: 'POST',
          signal: _abortSignal(120000), body: JSON.stringify(body) });
        mark(true); refreshSentNotices(requestScope); return r;
      } catch (e) { markFromError(e); throw e; }
    },
    async shareLocalLibraryFiles(files, recipientUserIds, note, options) {
      const requestScope = taskStorageKey('ops');
      try {
        var payload = { files: Array.isArray(files) ? files : [], recipientUserIds: Array.isArray(recipientUserIds) ? recipientUserIds : [], note: String(note || ''), requestId: String(options?.requestId || '') };
        var r = await jfetch('/library/share-local-batch', { taskScope: requestScope, method: 'POST',
          signal: _abortSignal(120000), body: JSON.stringify(payload) });
        mark(true); refreshSentNotices(requestScope); return r;
      } catch (e) { markFromError(e); throw e; }
    },
    async getLibraryStorageStatus() {
      try { var r = await jfetch('/library/storage/status', { taskScope: taskStorageKey('ops'), cache: 'no-store', signal: _abortSignal(45000) }); mark(true); return r || { default: 'local', storage: {} }; }
      catch (e) { markFromError(e); throw e; }
    },
    async createLibraryFolder(name, parentId, storage) {
      try { var r = await jfetch('/library/folders', { taskScope: taskStorageKey('ops'), method: 'POST', body: JSON.stringify({ name: name || '', parentId: parentId || '', storage: storage || '' }) }); mark(true); return r; }
      catch (e) { markFromError(e); throw e; }
    },
    async deleteLibraryFolder(id) {
      try { var r = await jfetch('/library/folders/' + encodeURIComponent(id), { taskScope: taskStorageKey('ops'), method: 'DELETE' }); mark(true); return r; }
      catch (e) { markFromError(e); throw e; }
    },
    async updateLibraryFolder(id, body) {
      try { var r = await jfetch('/library/folders/' + encodeURIComponent(id), { taskScope: taskStorageKey('ops'), method: 'PATCH', body: JSON.stringify(body || {}) }); mark(true); return r; }
      catch (e) { markFromError(e); throw e; }
    },
    async createLibraryItem(body) {
      try { var r = await jfetch('/library/items', { taskScope: taskStorageKey('ops'), method: 'POST', body: JSON.stringify(body || {}) }); mark(true); return r; }
      catch (e) { markFromError(e); throw e; }
    },
    async uploadLibraryFile(file, folderId, storage, source) {
      var requestScope = taskStorageKey('ops');
      if (!file) throw new Error('请选择文件');
      var form = new FormData(); form.append('file', file); form.append('folderId', folderId || ''); form.append('storage', storage || '');
      var meta = source && typeof source === 'object' ? source : {};
      if (meta.type) form.append('sourceType', String(meta.type));
      if (meta.sessionId) form.append('sessionId', String(meta.sessionId));
      if (meta.conversationTitle) form.append('conversationTitle', String(meta.conversationTitle));
      if (meta.rejectDuplicateName === true) form.append('rejectDuplicateName', 'true');
      try {
        var res = await fetch(apiUrl('/library/items/upload'), {
          method: 'POST', headers: authHeaders(false), body: form, signal: _abortSignal(120000)
        });
        assertLibraryScope(requestScope);
        mark(true); var txt = await res.text();
        assertLibraryScope(requestScope);
        if (!res.ok) { var err = httpError(res, txt); handleAuthError(err); throw err; }
        return parseJSON(txt);
      } catch (e) { markFromError(e); throw e; }
    },
    async readLibraryThumbnail(id, options) {
      const requestScope = taskStorageKey('ops');
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (options?.signal?.aborted) abort();
      options?.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 30000);
      let reader;
      try {
        const res = await fetch(apiUrl('/library/items/' + encodeURIComponent(id) + '/thumbnail'), {
          headers: authHeaders(false), signal: controller.signal, cache: 'no-store'
        });
        assertLibraryScope(requestScope);
        if (!res.ok) { await res.body?.cancel(); return null; }
        if (Number(res.headers.get('content-length') || 0) > 512 * 1024) throw Error('LIBRARY_THUMBNAIL_TOO_LARGE');
        reader = res.body?.getReader();
        if (!reader) return null;
        const chunks = []; let size = 0;
        for (;;) {
          const part = await reader.read(); assertLibraryScope(requestScope);
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 512 * 1024) throw Error('LIBRARY_THUMBNAIL_TOO_LARGE');
          chunks.push(part.value);
        }
        return { blob: new Blob(chunks, { type: 'image/png' }) };
      } finally {
        try { await reader?.cancel(); } catch (_) {}
        reader?.releaseLock(); clearTimeout(timer);
        options?.signal?.removeEventListener('abort', abort);
        controller.abort();
      }
    },
    async readLibraryBinary(id) {
      var requestScope = taskStorageKey('ops');
      try {
        var res = await fetch(apiUrl('/library/items/' + encodeURIComponent(id) + '/download'), {
          method: 'GET', headers: authHeaders(false), signal: _abortSignal(120000)
        });
        if (requestScope !== taskStorageKey('ops')) {
          try { await res.body?.cancel(); } catch (_) {}
          throw staleTaskScope();
        }
        mark(true);
        if (!res.ok) {
          var text = await res.text(); assertLibraryScope(requestScope);
          var err = httpError(res, text); handleAuthError(err); throw err;
        }
        var limit = 64 * 1024 * 1024;
        if (Number(res.headers.get('content-length') || 0) > limit) { await res.body?.cancel(); throw new Error('文件超过 64MB，请下载后使用'); }
        var reader = res.body?.getReader(), chunks = [], size = 0;
        try {
          if (reader) for (;;) {
            var part = await reader.read(); assertLibraryScope(requestScope); if (part.done) break;
            size += part.value.byteLength;
            if (size > limit) { await reader.cancel(); throw new Error('文件超过 64MB，请下载后使用'); }
            chunks.push(part.value);
          }
        } catch (error) {
          try { await reader?.cancel(); } catch (_) {}
          throw error;
        } finally { reader?.releaseLock(); }
        assertLibraryScope(requestScope);
        var blob = new Blob(chunks, { type: res.headers.get('content-type') || 'application/octet-stream' });
        var disposition = res.headers.get('content-disposition') || '', name = '';
        var encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
        try { if (encoded) name = decodeURIComponent(encoded[1]); } catch (_) {}
        if (!name) name = disposition.match(/filename="?([^";]+)"?/i)?.[1] || '资料';
        return { ok: true, blob: blob, name: name, type: blob.type, size: blob.size };
      } catch (e) { markFromError(e); throw e; }
    },
    async getLibraryArchive(id) {
      try {
        var result = await jfetch('/library/items/' + encodeURIComponent(id) + '/archive', {
          taskScope: taskStorageKey('ops'), cache: 'no-store', redirect: 'error', signal: _abortSignal(120000)
        });
        mark(true); return result;
      } catch (error) { markFromError(error); throw error; }
    },
    async readLibraryArchiveFile(id, path, options) {
      var requestScope = taskStorageKey('ops');
      var route = '/library/items/' + encodeURIComponent(id) + '/archive/file?path=' + encodeURIComponent(libraryArchivePath(path));
      try {
        if (options?.preview) {
          var preview = await jfetch(route + '&preview=true', {
            taskScope: requestScope, cache: 'no-store', redirect: 'error', signal: _abortSignal(120000)
          });
          mark(true); return preview;
        }
        var res = await fetch(apiUrl(route), {
          method: 'GET', headers: authHeaders(false), signal: _abortSignal(120000), redirect: 'error', cache: 'no-store'
        });
        if (requestScope !== taskStorageKey('ops')) {
          try { await res.body?.cancel(); } catch (_) {}
          throw staleTaskScope();
        }
        mark(true);
        if (!res.ok) {
          var text = await res.text(); assertLibraryScope(requestScope);
          var error = httpError(res, text); handleAuthError(error); throw error;
        }
        var cap = 64 * 1024 * 1024;
        if (Number(res.headers.get('content-length') || 0) > cap) {
          try { await res.body?.cancel(); } catch (_) {}
          throw new Error('文件超过 64MB，请下载整个 ZIP 后使用');
        }
        var reader = res.body?.getReader(), chunks = [], size = 0;
        try {
          if (reader) for (;;) {
            var part = await reader.read(); assertLibraryScope(requestScope); if (part.done) break;
            size += part.value.byteLength;
            if (size > cap) throw new Error('文件超过 64MB，请下载整个 ZIP 后使用');
            chunks.push(part.value);
          }
        } catch (error) {
          try { await reader?.cancel(); } catch (_) {}
          throw error;
        } finally { reader?.releaseLock(); }
        assertLibraryScope(requestScope);
        return new Blob(chunks, { type: res.headers.get('content-type') || 'application/octet-stream' });
      } catch (error) { markFromError(error); throw error; }
    },
    libraryOutputKey(ref, file) {
      if (file?.deliveryBundle && file.taskId && (file.artifactVersionId || file.attachmentIds?.length))
        return JSON.stringify(['delivery-bundle', file.taskId,
          file.attachmentIds?.length ? [...file.attachmentIds].sort() : file.artifactVersionId]);
      var task = file?.taskId || file?.cloudTaskId, attachment = file?.attachmentId || file?.remoteAttachmentId;
      return task && attachment ? JSON.stringify(['attachment', task, attachment]) :
        JSON.stringify(['output', ref || '', file?.artifactId || file?.path || file?.relative || '', file?.at || file?.updatedAt || 0, file?.size || 0]);
    },
    async uploadLibraryOutput(ref, file, folderId, source) {
      var requestScope = taskStorageKey('ops');
      var outputKey = this.libraryOutputKey(ref, file);
      if (this.getLibraryOutputStatus) {
        var saved = await this.getLibraryOutputStatus(outputKey, file);
        assertLibraryScope(requestScope);
        if (saved?.item?.id) return { ok: true, item: saved.item, duplicate: true };
      }
      var bridge = global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
      var target = file && (file.path || file.relative || '');
      var got;
      if (file?.deliveryBundle && file.taskId && file.artifactVersionId && global.soduWorkAPI?.readAttachmentBinary) {
        got = await global.soduWorkAPI.readAttachmentBinary({ deliveryBundle: true, taskId: file.taskId,
          artifactVersionId: file.artifactVersionId, filename: file.name || '交付物.zip' });
        assertLibraryScope(requestScope);
      } else if (bridge && typeof bridge.readOutputBinary === 'function' && (target || file?.artifactId) && !(file?.taskId && file?.attachmentId)) {
        got = await bridge.readOutputBinary(String(ref || ''), file.artifactId ? { artifactId: file.artifactId } : target);
        assertLibraryScope(requestScope);
      } else if (file && file.taskId && file.attachmentId && global.soduWorkAPI &&
          typeof global.soduWorkAPI.readAttachmentBinary === 'function') {
        var rows = await this.listAttachments(String(file.taskId));
        assertLibraryScope(requestScope);
        var row = rows.find(function (entry) { return String(entry && entry.id || '') === String(file.attachmentId); });
        if (!row) throw new Error('对话附件不存在或已失效');
        got = await global.soduWorkAPI.readAttachmentBinary({
          url: this.attachmentUrl(row), filename: row.filename || row.name || file.name || '对话附件'
        });
        assertLibraryScope(requestScope);
      } else {
        throw new Error('当前成果暂时无法上传到资料库');
      }
      if (!got || got.ok === false) throw new Error((got && got.reason) || '读取成果文件失败');
      var raw = atob(String(got.data || ''));
      var bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      var blob = new Blob([bytes], { type: got.mimeType || 'application/octet-stream' });
      var name = String(got.name || (file && file.name) || '对话成果');
      assertLibraryScope(requestScope);
      var result = await this.uploadLibraryFile(new File([blob], name, { type: got.mimeType || 'application/octet-stream' }), folderId, '', Object.assign({}, source, { outputKey: outputKey }));
      assertLibraryScope(requestScope);
      if (result?.ok !== true || !result.item?.id) throw new Error('保存到资料库失败，请重试');
      return result;
    },
    async associateLibrarySource(id, source) {
      try { var r = await jfetch('/library/items/' + encodeURIComponent(id) + '/source', { taskScope: taskStorageKey('ops'), method: 'POST', body: JSON.stringify(source || {}) }); mark(true); return r; }
      catch (e) { markFromError(e); throw e; }
    },
    async openLibraryExternally(id, member) {
      var requestScope = taskStorageKey('ops');
      var got = member?.path ? { blob: await (member.archive === true ? this.readLibraryArchiveFile(id, member.path) : this.readDeliveryFile(id, member.path)), name: member.path.split('/').pop() } : await this.readLibraryBinary(id);
      var payload = await libraryExternalPayload(id, got.blob, got.name);
      assertLibraryScope(requestScope);
      return window.soduWorkAPI.openLibraryExternally(payload);
    },
    async revealLibraryItem(id, member) {
      var requestScope = taskStorageKey('ops');
      var got = member?.path ? { blob: await (member.archive === true ? this.readLibraryArchiveFile(id, member.path) : this.readDeliveryFile(id, member.path)), name: member.path.split('/').pop() } : await this.readLibraryBinary(id);
      var payload = await libraryExternalPayload(id, got.blob, got.name);
      assertLibraryScope(requestScope);
      return window.soduWorkAPI.revealLibraryItem(payload);
    },
    async updateLibraryItem(id, body) {
      try { var r = await jfetch('/library/items/' + encodeURIComponent(id), { taskScope: taskStorageKey('ops'), method: 'PATCH', body: JSON.stringify(body || {}) }); mark(true); return r; }
      catch (e) { markFromError(e); throw e; }
    },
    async readLibraryContent(id, options) {
      try { var r = await jfetch('/library/items/' + encodeURIComponent(id) + '/content' + (options?.preview ? '?preview=true' : ''), { taskScope: taskStorageKey('ops') }); mark(true); return r; }
      catch (e) { markFromError(e); throw e; }
    },
    async deleteLibraryItem(id) {
      try { var r = await jfetch('/library/items/' + encodeURIComponent(id), { taskScope: taskStorageKey('ops'), method: 'DELETE' }); mark(true); return r; }
      catch (e) { markFromError(e); throw e; }
    },
    async deleteLibraryItems(ids) {
      try {
        var itemIds = [...new Set((Array.isArray(ids) ? ids : []).map(function (id) { return String(id || '').trim(); }).filter(Boolean))];
        var r = await jfetch('/library/items/batch-delete', { taskScope: taskStorageKey('ops'), method: 'POST',
          body: JSON.stringify({ itemIds: itemIds }) }); mark(true); return r;
      } catch (e) { markFromError(e); throw e; }
    },
    async restoreLibraryItem(id) {
      try { var r = await jfetch('/library/items/' + encodeURIComponent(id) + '/restore', { taskScope: taskStorageKey('ops'), method: 'POST' }); mark(true); return r; }
      catch (e) { markFromError(e); throw e; }
    },
    async purgeLibraryItem(id) {
      try { var r = await jfetch('/library/items/' + encodeURIComponent(id) + '/purge', { taskScope: taskStorageKey('ops'), method: 'DELETE' }); mark(true); return r; }
      catch (e) { markFromError(e); throw e; }
    },
    async emptyLibraryTrash(storage) {
      try { var r = await jfetch('/library/trash' + (storage ? '?storage=' + encodeURIComponent(storage) : ''), { taskScope: taskStorageKey('ops'), method: 'DELETE' }); mark(true); return r; }
      catch (e) { markFromError(e); throw e; }
    },
    async downloadLibraryItem(id, filename, member) {
      var requestScope = taskStorageKey('ops');
      try {
        var memberBlob = member?.path ? await (member.archive === true ? this.readLibraryArchiveFile(id, member.path) : this.readDeliveryFile(id, member.path)) : null;
        var res = memberBlob ? new Response(memberBlob) : await fetch(apiUrl('/library/items/' + encodeURIComponent(id) + '/download'), {
          method: 'GET', headers: authHeaders(false), signal: _abortSignal(120000)
        });
        if (requestScope !== taskStorageKey('ops')) {
          try { await res.body?.cancel(); } catch (_) {}
          throw staleTaskScope();
        }
        mark(true);
        if (!res.ok) {
          var text = await res.text(); assertLibraryScope(requestScope);
          var err = httpError(res, text); handleAuthError(err); throw err;
        }
        var blob = await res.blob(); assertLibraryScope(requestScope);
        var url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = member?.path ? member.path.split('/').pop() : filename || '资料'; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { try { URL.revokeObjectURL(url); } catch (_) {} }, 2000);
        return { ok: true };
      } catch (e) { markFromError(e); throw e; }
    },

    /*
     * Registration and heartbeat report device name, platform, and version. Prefer a
     * user-supplied name, otherwise system username and hostname.
     */
    async registerClient(options) {
      var startedAt = options && options.startedAt != null ? options.startedAt : Date.now();
      var restoration = restoreSavedHub(); if (restoration) await restoration;
      var registration = registrationContext(startedAt);
      try {
      var version = '1.2.0';
      try { if (window.soduWorkAPI && window.soduWorkAPI.getAppVersion) version = await registration.step(function () { return window.soduWorkAPI.getAppVersion(); }); }
      catch (e) { if (registrationBoundaryError(e)) throw e; }
      var name = (typeof User !== 'undefined' && User && User.name) || '';
      var sysInfo = null;
      try {
        sysInfo = window.soduWorkAPI && window.soduWorkAPI.getSysInfo ? await registration.step(function () { return window.soduWorkAPI.getSysInfo(); }) : null;
        if (!name && sysInfo && (sysInfo.username || sysInfo.hostname)) {
          name = [sysInfo.username, sysInfo.hostname].filter(Boolean).join(' · ');
        }
      } catch (e) { if (registrationBoundaryError(e)) throw e; }
      var body = {
        device: device(),
        name: name,
        platform: (sysInfo && sysInfo.platform ? sysInfo.platform :
          ((typeof navigator !== 'undefined' && navigator.platform) || '')) + (sysInfo && sysInfo.arch ? '/' + sysInfo.arch : ''),
        version: version
      };
      /* Report a non-empty configured work root so unattended dispatch can resolve the same directory.
   Omit the field when unavailable: an empty value must not erase an existing server-side setting. */
      try {
        var wr = (typeof workRoot === 'function') ? String(workRoot() || '').trim() : '';
        if (wr) body.workRoot = wr;
      } catch (e) { /* A missing workspace value must not prevent registration. */ }
      /* Start the Runner with an existing local secret while Hub is offline; refresh after initial registration and let it reconnect. */
      await syncRunnerConfig(body.workRoot || '', registration);
      try {
        if (window.soduWorkAPI && window.soduWorkAPI.deviceAuthBootstrap) {
          var secure = await registration.step(function () { return window.soduWorkAPI.deviceAuthBootstrap({
            hub: base(), clientId: device(), legacySecret: secret(),
            staleSession: options && options.staleSession || '',
            name: body.name, platform: body.platform, version: body.version,
            workRoot: body.workRoot || ''
          }); });
          if (secure && secure.stored) {
            /*
             * After secure storage takes ownership, remove long-lived secrets from the renderer even
             * before device activation.
             */
            try { if (readLocal(LEGACY_AUTH_HUB_KEY) === base()) localStorage.removeItem('soduwork_work_device_secret'); } catch (e) {}
            rememberSession(secure);
            await syncRunnerConfig(body.workRoot || '', registration);
            registration.check();
            if (secure.ok) mark(true);
            return secure;
          }
          /*
           * Fail closed when the main process reports secure-storage failure; legacy registration
           * would otherwise put the secret back in localStorage.
           */
          return secure || { ok: false, stored: false, error: '设备安全存储没有应答' };
        }
        var r = await registration.step(function () { return jfetch('/clients/register', { method: 'POST', body: JSON.stringify(body) }); });
        if (r && r.secret) setSecret(r.secret);  // Persist the initial device binding for subsequent requests.
        await syncRunnerConfig(body.workRoot || '', registration);
        registration.check();
        mark(true); return r;
      }
      catch (e) { if (registrationBoundaryError(e)) throw e; markFromError(e); return null; }
      } finally { registration.dispose(); }
    },

    /* Generate task IDs client-side for replayable PUTs, PATCH only actual changes, and delete only through explicit calls. */
    async putTask(id, task, taskScope) {
      try {
        var r = await jfetch('/tasks/' + encodeURIComponent(id),
          { method: 'PUT', body: JSON.stringify(task || {}), taskScope: taskScope });
        mark(true); return r;
      } catch (e) { markFromError(e); throw e; }
    },

    async clientLogin(credentials) {
      var restoration = restoreSavedHub(); if (restoration) await restoration;
      if (!window.soduWorkAPI || !window.soduWorkAPI.deviceAuthLogin) {
        return { ok: false, error: '\u5f53\u524d\u5ba2\u6237\u7aef\u7248\u672c\u4e0d\u652f\u6301\u5b89\u5168\u767b\u5f55' };
      }
      invalidateRegistrations();
      var loginEpoch = _registrationEpoch, loginHub = base();
      function checkLogin() { if (loginEpoch !== _registrationEpoch || loginHub !== base()) throw staleTaskScope(); }
      var version = '1.2.0', sysInfo = null, root = '';
      try { if (window.soduWorkAPI.getAppVersion) version = await window.soduWorkAPI.getAppVersion(); } catch (e) {}
      try { if (window.soduWorkAPI.getSysInfo) sysInfo = await window.soduWorkAPI.getSysInfo(); } catch (e) {}
      try { root = typeof workRoot === 'function' ? String(workRoot() || '').trim() : ''; } catch (e) {}
      checkLogin();
      var result = await window.soduWorkAPI.deviceAuthLogin({
        hub: loginHub, clientId: device(),
        account: String(credentials && credentials.account || '').trim(),
        password: String(credentials && credentials.password || ''),
        displayName: String(credentials && credentials.displayName || '').trim(),
        name: [sysInfo && sysInfo.username, sysInfo && sysInfo.hostname].filter(Boolean).join(' \u00b7 '),
        platform: (sysInfo && sysInfo.platform || '') + (sysInfo && sysInfo.arch ? '/' + sysInfo.arch : ''),
        version: version, workRoot: root
      });
      checkLogin();
      invalidateRegistrations();
      rememberSession(result || {});
      if (result && result.ok) {
        await syncRunnerConfig(root);
        mark(true);
      } else if (result && (result.code === 'TOKEN_QUOTA_EXCEEDED' || result.status === 401)) {
        requireClientAuth(result.code || 'LOGIN_FAILED', result);
      }
      return result || { ok: false, error: '\u767b\u5f55\u6ca1\u6709\u8fd4\u56de\u7ed3\u679c' };
    },

    async clientAccountAction(action, payload) {
      var restoration = restoreSavedHub(); if (restoration) await restoration;
      if (!window.soduWorkAPI || !window.soduWorkAPI.deviceAccountAction)
        return { ok: false, error: '请更新客户端后使用邮箱账号功能' };
      var signsIn = ['password', 'emailCode', 'register'].includes(action);
      var changesIdentity = signsIn || action === 'resetPassword';
      if (changesIdentity) invalidateRegistrations();
      var epoch = _registrationEpoch, hub = base();
      var version = '', info = null, root = '';
      if (signsIn) {
        try { version = await window.soduWorkAPI.getAppVersion(); } catch (_) {}
        try { info = await window.soduWorkAPI.getSysInfo(); } catch (_) {}
        try { root = typeof workRoot === 'function' ? String(workRoot() || '') : ''; } catch (_) {}
      }
      if (epoch !== _registrationEpoch || hub !== base()) throw staleTaskScope();
      var result = await window.soduWorkAPI.deviceAccountAction(Object.assign({}, payload || {}, {
        action: action, hub: hub, clientId: device(), version: version, workRoot: root,
        name: [info && info.username, info && info.hostname].filter(Boolean).join(' · '),
        platform: info && info.platform || ''
      }));
      if (epoch !== _registrationEpoch || hub !== base()) throw staleTaskScope();
      if (signsIn && result && result.ok) {
        invalidateRegistrations();
        rememberSession(result);
        await syncRunnerConfig(root);
        mark(true);
      }
      return result || { ok: false, error: '服务没有返回结果' };
    },

    async clientAccountRequest(operation, payload) {
      var routes = {
        profile: ['PATCH', '/client-auth/me'], devices: ['GET', '/client-auth/me/devices'],
        verification: ['POST', '/client-auth/me/verification'],
        challenge: ['POST', '/client-auth/me/email-challenges'],
        email: ['POST', '/client-auth/me/email-change'],
        export: ['POST', '/client-auth/me/exports'],
        deletion: ['POST', '/client-auth/me/deletion'],
        legal: ['GET', '/client-auth/legal-documents'], privacy: ['GET', '/client-auth/me/privacy'],
        legalStatus: ['GET', '/client-auth/me/legal-status'], legalResponse: ['POST', '/client-auth/me/legal-response']
      };
      var route = routes[operation];
      if (operation === 'legalVersion') route = ['GET', '/client-auth/legal-documents/versions/' + encodeURIComponent(String(payload && payload.id || ''))];
      if (operation === 'exportStatus') route = ['GET', '/client-auth/me/exports/' + encodeURIComponent(String(payload && payload.id || ''))];
      if (operation === 'revokeDevice') route = ['DELETE', '/client-auth/me/devices/' + encodeURIComponent(String(payload && payload.deviceId || ''))];
      if (!route) throw new Error('不支持的账号操作');
      var body = operation === 'revokeDevice' ? { verificationToken: payload && payload.verificationToken } : payload;
      var epoch = _registrationEpoch, hub = base();
      var result = await jfetch(route[1], { method: route[0],
        body: route[0] === 'GET' ? undefined : JSON.stringify(body || {}) });
      if (epoch !== _registrationEpoch || hub !== base()) throw staleTaskScope();
      if (operation === 'profile' && result && result.user) {
        rememberSession({ user: result.user });
        if (window.soduWorkAPI?.refreshAccountProfile) void window.soduWorkAPI.refreshAccountProfile().catch(function () {});
        try { window.dispatchEvent(new CustomEvent('soduwork-profile-updated', { detail: result.user })); } catch (_) {}
      }
      return result;
    },

    async clientAccountExportDownload(id) {
      var epoch = _registrationEpoch, hub = base();
      await SoduWorkAPI.clientAuthMe();
      if (epoch !== _registrationEpoch || hub !== base()) throw staleTaskScope();
      var response = await fetch(apiUrl('/client-auth/me/exports/' + encodeURIComponent(String(id)) + '/download'),
        { headers: authHeaders(true), signal: _abortSignal(DEFAULT_TIMEOUT) });
      if (!response.ok) throw httpError(response, await response.text());
      var blob = await response.blob();
      if (epoch !== _registrationEpoch || hub !== base()) throw staleTaskScope();
      return blob;
    },

    listenAccountProfileChanges() {
      if (!window.soduWorkAPI?.onAccountProfileChanged) return function () {};
      return window.soduWorkAPI.onAccountProfileChanged(function (result) {
        if (!result || result.hub !== base() || result.clientId !== device() ||
            !result.user || result.user.id !== _clientUser?.id) return;
        rememberSession({ user: result.user });
        try { window.dispatchEvent(new CustomEvent('soduwork-profile-updated', { detail: result.user })); } catch (_) {}
      });
    },

    async clientLogout() {
      if (!window.soduWorkAPI || !window.soduWorkAPI.deviceAuthLogout) {
        return { ok: false, error: '\u5f53\u524d\u5ba2\u6237\u7aef\u7248\u672c\u4e0d\u652f\u6301\u9000\u51fa' };
      }
      invalidateRegistrations();
      var logoutEpoch = _registrationEpoch, logoutHub = base();
      var result = await window.soduWorkAPI.deviceAuthLogout({ hub: logoutHub, clientId: device() });
      if (logoutEpoch !== _registrationEpoch || logoutHub !== base()) throw staleTaskScope();
      if (result && result.ok) {
        _clientUser = null; _clientQuota = null;
        try { window.dispatchEvent(new CustomEvent('soduwork-data-scope-changed')); } catch (_) {}
        requireClientAuth('LOGOUT', { code: 'LOGOUT' });
      }
      return result || { ok: false, error: '\u9000\u51fa\u6ca1\u6709\u8fd4\u56de\u7ed3\u679c' };
    },

    async clientAuthMe() {
      var epoch = _registrationEpoch, hub = base();
      var result = await jfetch('/client-auth/me');
      if (epoch !== _registrationEpoch || hub !== base()) throw staleTaskScope();
      rememberSession({ user: result && result.user, quota: result && result.quota });
      return result;
    },

    /* After a password change, all account sessions are revoked; the caller must sign out immediately. */
    async clientChangePassword(payload) {
      var epoch = _registrationEpoch, hub = base(), owner = _clientUser && _clientUser.id, requestScope = taskStorageKey('ops');
      var body = { newPassword: String(payload && payload.newPassword || '') };
      if (payload && payload.currentPassword != null) body.currentPassword = String(payload.currentPassword);
      if (payload && payload.verificationToken != null) body.verificationToken = String(payload.verificationToken);
      try {
        var result = await jfetch('/client-auth/change-password', {
          method: 'POST', taskScope: requestScope,
          body: JSON.stringify(body)
        });
        if (epoch !== _registrationEpoch || hub !== base() || owner !== (_clientUser && _clientUser.id)) throw staleTaskScope();
        mark(true); return result || { ok: false, error: '服务没有返回结果' };
      } catch (error) {
        markFromError(error);
        throw error;
      }
    },

    async clientAuthPolicy() {
      var restoration = restoreSavedHub(); if (restoration) await restoration;
      var res = await fetch(apiUrl('/client-auth/policy'), { signal: _abortSignal(DEFAULT_TIMEOUT) });
      var text = await res.text();
      if (!res.ok) throw httpError(res, text);
      return text ? parseJSON(text) : {};
    },

    clientAuthSnapshot() {
      return { state: _deviceAuthState, user: _clientUser, quota: _clientQuota,
        clientId: device(), online: _online };
    },
    im: {
      catalog: opts => jfetch('/im', Object.assign({cache: 'no-store'}, opts)),
      create: (body, opts) => jfetch('/im/connections', Object.assign({}, opts, {method: 'POST', redirect: 'error', body: JSON.stringify(body)})),
      connect: (id, opts) => jfetch('/im/connections/' + encodeURIComponent(id) + '/connect', Object.assign({}, opts, {method: 'POST', redirect: 'error'})),
      revoke: (id, opts) => jfetch('/im/connections/' + encodeURIComponent(id), Object.assign({}, opts, {method: 'DELETE', redirect: 'error'})),
      targets: (id, opts) => jfetch('/im/connections/' + encodeURIComponent(id) + '/targets', Object.assign({cache: 'no-store'}, opts)),
      pair: (id, body, opts) => jfetch('/im/connections/' + encodeURIComponent(id) + '/pairings', Object.assign({}, opts, {method: 'POST', redirect: 'error', body: JSON.stringify(body)})),
      bindings: (id, opts) => jfetch('/im/connections/' + encodeURIComponent(id) + '/bindings', Object.assign({cache: 'no-store'}, opts)),
      unbind: (id, opts) => jfetch('/im/bindings/' + encodeURIComponent(id), Object.assign({}, opts, {method: 'DELETE', redirect: 'error'})),
      messages: (id, opts) => jfetch('/im/connections/' + encodeURIComponent(id) + '/messages', Object.assign({cache: 'no-store'}, opts)),
      dismiss: (id, opts) => jfetch('/im/messages/' + encodeURIComponent(id) + '/dismiss', Object.assign({}, opts, {method: 'POST', redirect: 'error'}))
    },
    async patchTask(id, patch, taskScope) {
      try {
        var r = await jfetch('/tasks/' + encodeURIComponent(id),
          { method: 'PATCH', body: JSON.stringify(patch || {}), taskScope: taskScope });
        mark(true); return r;
      } catch (e) { markFromError(e); throw e; }
    },
    async deleteTask(id, taskScope) {
      try {
        await jfetch('/tasks/' + encodeURIComponent(id), { method: 'DELETE', taskScope: taskScope });
        mark(true); return { ok: true };
      } catch (e) {
        if (e && e.status === 404) { mark(true); return { ok: true }; }
        markFromError(e); throw e;
      }
    },
    /* Synchronize configuration through saveCfg(). */
    async syncConfig(cfg) {
      var scope = domainScope();
      try { await jfetch('/config', { method: 'PUT', body: JSON.stringify(cfg || {}) });
        await invalidateDomain('config', scope); mark(true); return true; }
      catch (e) { markFromError(e); return false; }
    },

    /*
     * Open the workspace on the execution host. Use the returned dir and host to show a path
     * when that host differs from the client.
     */
    async openWorkDir(tid) {
      var r = await jfetch('/tasks/' + encodeURIComponent(tid) + '/open-dir', { method: 'POST', body: '{}' });
      mark(true); return r;
    },
    /* Check terminal availability and explain failures before opening a WebSocket. */
    async termSupport() {
      try {
        var r = await jfetch('/term/support');
        mark(true); return r || { ok: false };
      } catch (e) { markFromError(e); return { ok: false, reason: '后台没连上' }; }
    },
    /* Return current task terminal state, or null if none was opened. */
    async termInfo(tid) {
      try { return await jfetch('/tasks/' + encodeURIComponent(tid) + '/term'); }
      catch (e) { markFromError(e); return { supported: false, reason: '后台没连上' }; }
    },
    /* Close the task terminal and its child processes. */
    async termClose(tid) {
      try { return await jfetch('/tasks/' + encodeURIComponent(tid) + '/term', { method: 'DELETE' }); }
      catch (e) { return { ok: false }; }
    },
    /* Terminal and dispatch channels share first-frame authentication through wsAuthFrame. */
    wsAuthFrame,

    /*
     * Build the terminal WebSocket URL without credentials. Browser WebSockets authenticate
     * through the first frame using SoduWorkAPI.wsAuthFrame().
     */
    termWsUrl(tid, cols, rows, mode) {
      return base().replace(/^http/, 'ws') + '/api/v1/term?device=' + encodeURIComponent(device()) +
        '&task=' + encodeURIComponent(tid) +
        '&cols=' + (cols || 100) + '&rows=' + (rows || 30) +
        '&mode=' + (mode || 'session');
    },

    /*
     * Subscribe to backend task events, reconnect automatically, and return an unsubscribe
     * function.
     */
    connectWS(onEvent) {
      var ws = null, timer = null, closed = false, delay = 3000;
      var sourceHub = base(), sourceScope = taskStorageKey('ops');
      function currentSource() { return !closed && sourceHub === base() && sourceScope === taskStorageKey('ops'); }
      function wsUrl() {
        return base().replace(/^http/, 'ws') + '/api/v1/ws?device=' + encodeURIComponent(device());
      }
      function open() {
        if (!currentSource()) return;
        /*
         * Wait locally for registration and a valid session before connecting; an unauthenticated
         * first frame would produce 4401.
         */
        if (!_deviceSession && !secret()) { timer = setTimeout(open, 800); return; }
        try {
          ws = new WebSocket(wsUrl());
          ws.onopen = function () {
            if (!currentSource()) { try { ws.close(); } catch (e) {} return; }
            try { ws.send(wsAuthFrame()); } catch (e) {}
          };
          ws.onmessage = function (ev) { try {
            if (!currentSource()) return;
            var event = JSON.parse(ev.data);
            if (event.type === 'ready') {
              mark(true); delay = 3000;
              try { global.dispatchEvent(new CustomEvent('soduwork-ws-open')); } catch (e) {}
            }
            onEvent(event);
          } catch (e) {} };
          ws.onclose = function () { if (!closed) retry(); };
          ws.onerror = function () { try { ws.close(); } catch (e) {} };
        } catch (e) { retry(); }
      }
      /* Reconnect with exponential backoff from three seconds, capped at thirty seconds. */
      function retry() { if (closed) return; clearTimeout(timer); timer = setTimeout(open, delay); delay = Math.min(delay * 2, 30000); }
      open();
      return function () { closed = true; clearTimeout(timer); try { ws && ws.close(); } catch (e) {} };
    }
  };

  if (global.SoduWorkLocalLibraryAPI && typeof global.SoduWorkLocalLibraryAPI.install === 'function') {
    global.SoduWorkLocalLibraryAPI.install(SoduWorkAPI, {
      scope: function () { return taskStorageKey('ops'); }, assertScope: assertLibraryScope, blobToBase64: blobToBase64
    });
  } else {
    // A missing renderer asset must never reinterpret client-local data as Hub-local.
    Object.keys(SoduWorkAPI).filter(function (name) { return /Library/.test(name); }).forEach(function (name) {
      SoduWorkAPI[name] = async function () {
        var error = new Error('本机资料库组件未加载，请更新客户端后重试'); error.code = 'LOCAL_LIBRARY_UNAVAILABLE'; throw error;
      };
    });
  }

  if (global.soduWorkAPI?.onAccountSessionChanged) global.soduWorkAPI.onAccountSessionChanged(function (changed) {
    if (!changed || changed.hub !== base() || changed.clientId !== device()) return;
    invalidateRegistrations(); _clientUser = null; _clientQuota = null;
    _deviceSession = ''; _deviceSessionUntil = 0; _deviceAuthState = 'pending';
    try { window.dispatchEvent(new CustomEvent('soduwork-data-scope-changed')); } catch (_) {}
    if (global.location?.reload) global.location.reload();
  });
  global.SoduWorkAPI = SoduWorkAPI;

})(typeof window !== 'undefined' ? window : this);
