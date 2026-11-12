/* Task loading and connection recovery. Only this renderer's verified snapshot
   survives a transport failure; account/Hub/device changes still discard it. */
(function (global) {
  'use strict';
  const LS_CFG = 'soduwork_work_cfg_v5', LS_CFG_PENDING = LS_CFG + '_sync_pending';
  const LS_CFG_LOCALE = LS_CFG + '_locale', LS_CFG_LOCALE_EXPLICIT = LS_CFG_LOCALE + '_explicit';
  const LS_CFG_LOCALE_SOURCE = LS_CFG_LOCALE + '_source';
  const SUPPORTED_LOCALES = new Set(['zh-CN', 'en-US', 'ja-JP', 'ko-KR']);
  const CFG_SERVER_OWNED = ['modelProviders'];
  const stripServerOwned = value => {
    if (value && typeof value === 'object') CFG_SERVER_OWNED.forEach(key => { delete value[key]; });
    return value;
  };
  function safeParseCfg(raw) {
    try { const value = JSON.parse(raw || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
    catch (_) { return {}; }
  }
  function normalizeLocale(value) {
    const locale = String(value || '').trim();
    const registry = global.SoduWorkI18n?.LOCALES;
    return (registry && Object.prototype.hasOwnProperty.call(registry, locale)) || SUPPORTED_LOCALES.has(locale) ? locale : '';
  }
  function localLocaleIntent() {
    try {
      const mirror = normalizeLocale(global.localStorage.getItem(LS_CFG_LOCALE));
      if (!mirror) return '';
      if (global.localStorage.getItem(LS_CFG_LOCALE_EXPLICIT) === '1') return mirror;
      if (global.localStorage.getItem(LS_CFG_LOCALE_SOURCE) === 'hub') return '';
      // Preserve preferences written by versions without the explicit marker,
      // while a fresh profile with only the renderer mirror still accepts Hub.
      const raw = global.localStorage.getItem(LS_CFG);
      const stored = safeParseCfg(raw);
      if (Object.prototype.hasOwnProperty.call(stored, 'locale')) {
        return normalizeLocale(stored.locale) === mirror ? mirror : '';
      }
      // Older clients only persisted the mirror. A non-default mirror is a
      // recoverable local preference, while a fresh profile starts at en-US.
      return mirror === 'en-US' ? '' : mirror;
    } catch (_) { return ''; }
  }
  function cfgSyncPending() {
    try { return global.localStorage.getItem(LS_CFG_PENDING) === '1'; } catch (_) { return true; }
  }
  const cfgSyncMark = () => { try { global.localStorage.setItem(LS_CFG_PENDING, '1'); } catch (_) {} };
  const cfgSyncClear = () => { try { global.localStorage.removeItem(LS_CFG_PENDING); } catch (_) {} };
  const registered = row => Boolean(row && row.ok !== false && !row.activationRequired &&
    (!row.authState || row.authState === 'active') &&
    (row.ok === true || (row.id && row.authState === 'active')));

  function install(store, hooks) {
    const api = () => global.SoduWorkAPI;
    const emit = (type, detail) => {
      try { global.dispatchEvent(new global.CustomEvent(type, { detail })); } catch (_) {}
    };
    const scope = () => api()?.taskStorageKey?.('ops') || '';
    const current = (epoch, key) => epoch === store._taskEpoch && key === scope();
    const clone = value => JSON.parse(JSON.stringify(value));
    Object.defineProperties(store, {
      tasks: { get() { return this._tasks; } }, cfg: { get() { return this._cfg; } },
      taskState: { get() { return this._taskState; } }, taskError: { get() { return this._taskError; } },
    });
    Object.assign(store, {
      _initializing: false, _incomingSeen: Object.create(null),
      _localReady: false, _remoteReady: false, _hasTaskSnapshot: false,
      _taskState: 'loading', _taskError: '', _taskEpoch: 0, _cfgRevision: 0,
      _hydratePromise: null, _configPromise: null, _startupPromise: null,
      _reconnectPromise: null, _heartbeatPromise: null, _waitingHeartbeat: false,
      _snapshotEvents: null, _cfgSyncWarned: false,
      _localLocaleIntent: '',
      _reportTaskSyncError(id, error, message) {
        emit('soduwork-task-sync-error', { id, error });
        if (typeof global.petSay === 'function') global.petSay(message, 6000);
        else try { global.console.error('[task sync]', id, error); } catch (_) {}
      },
      _clearIncomingTasks() { this._incomingSeen = Object.create(null); },
      _emitTaskSource(detail) {
        emit('soduwork-task-source', Object.assign({ state: this._taskState,
          online: this._taskState === 'ready', count: this._tasks.length,
          hub: api()?.hubBase?.() || '' }, detail || {}));
      },
      _setTaskSource(state, error, detail) {
        this._taskState = state; this._taskError = String(error || ''); this._emitTaskSource(detail);
      },
      markTaskOffline(error) {
        if (!this._waitingHeartbeat) {
          this._taskEpoch++; this._hydratePromise = null; this._configPromise = null;
          this._snapshotEvents = null;
        }
        this._waitingHeartbeat = true; this._remoteReady = false;
        this._setTaskSource(this._hasTaskSnapshot ? 'stale' : 'offline', error || '后台服务暂时不可用');
        hooks.render();
      },
      beginEnvironmentSwitch() {
        this._taskEpoch++; this._remoteReady = false; this._hasTaskSnapshot = false;
        this._waitingHeartbeat = false; this._hydratePromise = null; this._configPromise = null;
        this._reconnectPromise = null; this._heartbeatPromise = null; this._snapshotEvents = null; this._startupPromise = null;
        this._tasks.length = 0; this._shadow = Object.create(null); this._clearIncomingTasks();
        this._localLocaleIntent = '';
        if (this._wsOff) { try { this._wsOff(); } catch (_) {} this._wsOff = null; }
        this._setTaskSource('loading', '', { environmentChanged: true });
        emit('soduwork-work-task-change', { type: 'tasks.environment', all: true }); hooks.render();
      },
      refreshTasks(options) {
        if (this._waitingHeartbeat) return options?.reconnect ? this.reconnectTasks() :
          Promise.resolve({ online: false, waitingHeartbeat: true });
        return this.hydrate(true);
      },
      _writeShadow() {
        try { global.localStorage.setItem(hooks.shadowKey(), JSON.stringify(Object.values(this._shadow))); } catch (_) {}
      },
      _setShadow(rows, persist) {
        this._shadow = Object.create(null);
        (rows || []).forEach(task => { if (task?.id) this._shadow[task.id] = clone(task); });
        if (persist !== false) this._writeShadow();
      },
      _rememberServerTask(task) {
        if (!task?.id) return;
        this._snapshotEvents?.push({ type: 'task.updated', task: clone(task) });
        this._shadow[task.id] = clone(task); this._writeShadow();
      },
      _forgetServerTask(id) {
        this._snapshotEvents?.push({ type: 'task.deleted', id });
        delete this._shadow[id]; this._writeShadow();
      },
      saveCfg() {
        if (this._initializing) return;
        this._cfgRevision++; global.localStorage.setItem(LS_CFG, JSON.stringify(this._cfg)); cfgSyncMark();
        global.WinSync?.pushCfg();
        clearTimeout(this._syncC);
        this._syncC = setTimeout(() => { this._syncC = null; this._syncCfgToHub(); }, 400);
      },
      _syncCfgToHub() {
        if (!api()?.syncConfig) return;
        const epoch = this._taskEpoch, revision = this._cfgRevision;
        const done = ok => {
          if (epoch !== this._taskEpoch || revision !== this._cfgRevision) return;
          if (ok) {
            cfgSyncClear();
            if (this._cfgSyncWarned) { this._cfgSyncWarned = false; global.petSay?.('设置已同步到后台'); }
          }
          else if (!this._cfgSyncWarned) {
            this._cfgSyncWarned = true;
            global.petSay?.('设置已保存到本机；后台暂不可达，稍后自动重试');
          }
        };
        try { Promise.resolve(api().syncConfig(stripServerOwned(Object.assign({}, this._cfg)))).then(value => done(value !== false), () => done(false)); }
        catch (_) { done(false); }
      },
      _applyConfigPatch(patch) {
        if (!patch || typeof patch !== 'object') return;
        const previous = { ...this._cfg };
        // An earlier config GET must not overwrite a newer administrator action.
        ++this._cfgRevision;
        const incoming = stripServerOwned({ ...patch });
        // Refresh the local intent because the user may have changed locale
        // after startup while a Hub push was still in flight.
        this._localLocaleIntent = localLocaleIntent();
        if (incoming.locale && this._localLocaleIntent &&
            normalizeLocale(incoming.locale) !== this._localLocaleIntent) delete incoming.locale;
        Object.assign(this._cfg, incoming);
        if (incoming.locale && !this._localLocaleIntent) {
          try { global.localStorage.setItem(LS_CFG_LOCALE_SOURCE, 'hub'); } catch (_) {}
        }
        if (incoming.locale) global.SoduWorkI18n?.setLocale(incoming.locale, { persist: false });
        global.localStorage.setItem(LS_CFG, JSON.stringify(this._cfg)); global.WinSync?.pushCfg();
        hooks.configEffects(incoming, previous); global.petSay?.('管理员更新了设置～');
      },
      initLocal() {
        if (!this._localReady) {
          this._tasks.length = 0; this._setShadow([], false);
          this._taskState = 'loading'; this._taskError = ''; this._localReady = true;
        }
        return { tasks: this._tasks, cfg: this._cfg };
      },
      _reconcileLocalLocale() {
        const locale = localLocaleIntent();
        this._localLocaleIntent = locale;
        const stored = safeParseCfg(global.localStorage.getItem(LS_CFG));
        // A recovered mirror also needs syncing when it matches the in-memory
        // default: that default is not evidence of a persisted local choice.
        if (!locale || (normalizeLocale(this._cfg.locale) === locale &&
            normalizeLocale(stored.locale) === locale)) return false;
        ++this._cfgRevision;
        this._cfg.locale = locale;
        try {
          global.localStorage.setItem(LS_CFG, JSON.stringify(stripServerOwned(Object.assign({}, this._cfg))));
          cfgSyncMark();
        } catch (_) {}
        global.SoduWorkI18n?.setLocale(locale, { persist: false, broadcast: false });
        return true;
      },
      _loadConfig(revision) {
        if (this._configPromise || !api()?.getConfig) return;
        const epoch = this._taskEpoch, key = scope();
        const job = Promise.resolve().then(() => api().getConfig()).then(apiCfg => {
          if (!current(epoch, key)) return;
          this._localLocaleIntent = localLocaleIntent();
          if (cfgSyncPending()) this._syncCfgToHub();
          else if (this._cfgRevision === revision && apiCfg && Object.keys(apiCfg).length) {
            const previous = JSON.stringify(this._cfg);
            const incoming = stripServerOwned({ ...apiCfg });
            // A locale selected on this device is a local preference. Hub may
            // still expose an older per-device default, so keep the local value
            // while accepting unrelated remote configuration fields.
            if (this._localLocaleIntent && incoming.locale &&
              normalizeLocale(incoming.locale) !== this._localLocaleIntent) delete incoming.locale;
            Object.assign(this._cfg, incoming);
            if (incoming.locale && !this._localLocaleIntent) {
              try { global.localStorage.setItem(LS_CFG_LOCALE_SOURCE, 'hub'); } catch (_) {}
            }
            if (incoming.locale) global.SoduWorkI18n?.setLocale(incoming.locale, { persist: false });
            global.localStorage.setItem(LS_CFG, JSON.stringify(stripServerOwned(this._cfg)));
            if (previous !== JSON.stringify(this._cfg)) emit('soduwork-config-hydrated', { configChanged: true });
          }
        }).catch(() => { /* Config failure cannot invalidate a successful task snapshot. */ });
        this._configPromise = job;
        job.finally(() => { if (this._configPromise === job) this._configPromise = null; });
      },
      hydrate(force, startedCfgRevision) {
        this.initLocal();
        this._reconcileLocalLocale();
        if (this._waitingHeartbeat) return Promise.resolve({ online: false, waitingHeartbeat: true });
        if (this._hydratePromise) return this._hydratePromise;
        if (this._remoteReady && !force) return Promise.resolve({ online: true, unchanged: true });
        const epoch = this._taskEpoch, key = scope(), events = [];
        this._snapshotEvents = events;
        this._loadConfig(startedCfgRevision == null ? this._cfgRevision : startedCfgRevision);
        const job = (async () => {
          try {
            const snapshot = api().getTasksSnapshot ? await api().getTasksSnapshot() :
              { items: await api().getTasks(), online: api().online === true };
            if (!current(epoch, key) || snapshot?.stale) return { online: false, stale: true };
            if (snapshot?.online !== true || !Array.isArray(snapshot.items)) {
              this.markTaskOffline(snapshot?.error); return { online: false };
            }
            // Events/confirmed writes arriving after the GET began outrank its older snapshot.
            const rows = global.TaskSync.applySnapshotEvents(snapshot.items, events);
            api().adoptVerifiedTaskOperations?.(rows); this._setShadow(rows);
            const ids = new Set(rows.map(task => task.id)), readOnly = new Set(rows.filter(task => task.readOnly).map(task => task.id));
            const ops = this._readTaskOps().filter(op => (op.kind === 'put' || ids.has(op.id)) && !readOnly.has(op.id));
            this._writeTaskOps(ops);
            // An explicit undo can outlive the old DELETE echo. Preserve only
            // those already-visible restorations, never an unconfirmed create.
            const restores = new Set(ops.filter(op => op.kind === 'put' && op.restore &&
              this._tasks.some(task => task.id === op.id)).map(op => op.id));
            const base = rows.concat(this._tasks.filter(task => restores.has(task.id) && !ids.has(task.id)));
            const visible = global.TaskSync.applyOperations(base, ops.filter(op =>
              (op.kind !== 'put' || restores.has(op.id)) && !op.blocked));
            const changed = global.TaskSync.reconcileSnapshot(this._tasks, visible);
            if (changed) this._mirrorTasks(false);
            this._hasTaskSnapshot = true; this._remoteReady = true;
            this._setTaskSource('ready', '', { tasksChanged: changed }); this._scheduleTaskFlush(0);
            return { online: true, tasksChanged: changed };
          } catch (error) {
            if (!current(epoch, key)) return { online: false, stale: true };
            this.markTaskOffline(String(error?.message || error)); return { online: false, error: this._taskError };
          }
        })();
        this._hydratePromise = job;
        job.finally(() => {
          if (this._hydratePromise === job) this._hydratePromise = null;
          if (this._snapshotEvents === events) this._snapshotEvents = null;
        });
        return job;
      },
      async init() { this.initLocal(); return this.hydrate(); },
      reconnectTasks(registration) {
        if (this._reconnectPromise) return this._reconnectPromise;
        const epoch = this._taskEpoch, key = scope(), wasOnline = api()?.online === true;
        const job = (async () => {
          try {
            const row = registration || await api().registerClient();
            if (!current(epoch, key)) return { online: false, stale: true };
            // Registration may be a cached Electron session. Require a real authenticated HTTP heartbeat.
            const reachable = registered(row) && await api().checkConnection?.();
            if (!current(epoch, key)) return { online: false, stale: true };
            if (!reachable) { this.markTaskOffline(row?.error); return { online: false }; }
            this._waitingHeartbeat = false;
            const result = await this.hydrate(true);
            if (result.online) { connectRealtime(); emit('soduwork-store-hydrated', result); global.MateNoticeSync?.tick(true); if (!wasOnline) hooks.recovered?.(); }
            return result;
          } catch (error) {
            if (current(epoch, key)) this.markTaskOffline(String(error?.message || error));
            return { online: false };
          }
        })();
        this._reconnectPromise = job;
        job.finally(() => { if (this._reconnectPromise === job) this._reconnectPromise = null; });
        return job;
      },
      heartbeat() {
        if (this._heartbeatPromise) return this._heartbeatPromise;
        const epoch = this._taskEpoch, key = scope();
        const job = (async () => {
          if (this._waitingHeartbeat || api().online === false) return this.reconnectTasks();
          let row;
          try { row = await api().registerClient(); } catch (_) {}
          if (!current(epoch, key)) return { online: false, stale: true };
          if (!registered(row)) {
            if (api().online === false || row?.ok === false) this.markTaskOffline(row?.error);
            return { online: false };
          }
          global.MateNoticeSync?.tick();
          if (!this._remoteReady) return this.reconnectTasks(row);
          return { online: true, unchanged: true };
        })();
        this._heartbeatPromise = job;
        job.finally(() => { if (this._heartbeatPromise === job) this._heartbeatPromise = null; });
        return job;
      },
    });

    function connectRealtime() {
      if (!api()?.connectWS || store._wsOff) return;
      store._wsOff = api().connectWS(event => store.applyServerEvent(event));
    }
    async function startup() {
      const revision = store._cfgRevision, epoch = store._taskEpoch;
      try { await api().registerClient(); } catch (_) {}
      if (epoch !== store._taskEpoch) return { online: false, stale: true };
      const result = await store.hydrate(false, revision);
      if (result.stale) return result;
      hooks.syncBindings();
      if (result.online) emit('soduwork-store-hydrated', result);
      connectRealtime(); global.MateNoticeSync?.tick(true);
      return result;
    }
    global.addEventListener?.('soduwork-data-scope-changed', () => { store.beginEnvironmentSwitch(); hooks.scopeChanged(); });
    global.addEventListener?.('soduwork-ws-open', () => {
      if (store._remoteReady && !store._waitingHeartbeat) void store.refreshTasks();
      global.MateNoticeSync?.tick(true);
    });
    global.addEventListener?.('soduwork-domain-changed', event => {
      if (event.detail?.domain === 'config') store._loadConfig(store._cfgRevision);
    });
    global.initData = async function initData() {
      store.initLocal(); hooks.syncBindings();
      if (!api()) return;
      if (!store._hbTimer) store._hbTimer = setInterval(() => { void store.heartbeat(); }, 20000);
      if (!store._startupPromise) store._startupPromise = startup();
    };
  }
  global.SoduWorkStoreLifecycle = { install, safeParseCfg, stripServerOwned };
})(window);
