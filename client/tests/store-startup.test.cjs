const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const TaskSync = require('../core/task-sync.js');

const source = fs.readFileSync(path.join(__dirname, '../core/store-lifecycle.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(__dirname, '..', 'core', 'store.js'), 'utf8');

test('a remote skin patch wins over an older config fetch and refreshes the originating window', async () => {
  const config = deferred(), calls = [];
  const f = fixture({ online: true, getConfig: () => config.promise,
    getTasksSnapshot: async () => ({ online: true, items: [] }) });
  f.context.refreshSkinAppearance = previous => calls.push(previous);
  const previous = f.Store.cfg._lastSkinId;
  await f.Store.init();
  f.Store.applyServerEvent({ type: 'config.patch', patch: { character: 'diamond', theme: 'vivid',
    tube: 'glass', _lastSkinId: 'diamond-ice', _defaultLogoVersion: 1 } });
  config.resolve({ character: 'box', _lastSkinId: 'box-biz' }); await settle();
  assert.equal(f.Store.cfg.character, 'diamond');
  assert.deepEqual(calls, [previous]);
  assert.equal(JSON.parse(f.values.get('soduwork_work_cfg_v5'))._lastSkinId, 'diamond-ice');
});

function fixture(api, seed, options) {
  const values = new Map(Object.entries(seed || {}));
  const events = [];
  const timers = [];
  const listeners = new Map();
  const localStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const context = {
    SoduWorkAPI: api,
    soduWorkAPI: null,
    localStorage,
    TaskSync,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    document: {
      activeElement: null,
      getElementById: () => null,
      querySelectorAll: () => [],
      documentElement: { setAttribute() {} },
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    location: { reload() {} },
    console: { log() {}, error() {} },
    setTimeout: options && options.realTimeout ? setTimeout :
      ((fn, ms) => { timers.push({ fn, ms }); return timers.length; }),
    clearTimeout: options && options.realTimeout ? clearTimeout : (() => {}),
    setInterval: (fn, ms) => { timers.push({ fn, ms, interval: true }); return timers.length; },
    clearInterval() {},
  };
  context.window = context;
  context.addEventListener = (type, handler) => {
    const rows = listeners.get(type) || []; rows.push(handler); listeners.set(type, rows);
  };
  context.dispatchEvent = (event) => {
    events.push(event); for (const handler of listeners.get(event.type) || []) handler(event);
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'store.js' });
  return {
    context, values, events, timers,
    Store: vm.runInContext('Store', context),
    initData: vm.runInContext('initData', context),
  };
}

test('有本地缓存时首屏也不展示缓存，后台校准后就地填入同一任务数组', async () => {
  let releaseRegistration;
  const registration = new Promise((resolve) => { releaseRegistration = resolve; });
  let connected = 0;
  const api = {
    online: true,
    registerClient: () => registration,
    getTasksSnapshot: async () => ({
      online: true,
      items: [{ id: 't-1', title: '服务端标题', note: 'server', status: 'todo', origin: 'local' }],
    }),
    getConfig: async () => ({ theme: 'remote' }),
    connectWS: () => { connected++; return () => {}; },
  };
  const local = [{ id: 't-1', title: '本地标题', note: 'base', status: 'todo', origin: 'local' }];
  const f = fixture(api, {
    soduwork_work_tasks_v5: JSON.stringify(local),
    soduwork_work_task_shadow_v1: JSON.stringify(local),
    soduwork_work_cfg_v5: JSON.stringify({ theme: 'local' }),
  });

  const originalArray = f.Store.tasks;
  await f.initData();
  assert.equal(f.Store.tasks.length, 0);
  assert.equal(f.Store.taskState, 'loading');
  assert.equal(connected, 0);
  f.Store.cfg.theme = 'user-choice';
  f.Store.saveCfg();

  releaseRegistration({ ok: true, session: 'short-session' });
  await f.Store._startupPromise;
  assert.equal(f.Store.tasks, originalArray);
  assert.equal(f.Store.tasks[0].title, '服务端标题');
  assert.equal(f.Store.tasks[0].note, 'server');
  assert.equal(f.Store.taskState, 'ready');
  assert.equal(f.Store.cfg.theme, 'user-choice');
  assert.equal(connected, 1);
  assert.equal(f.events.some((event) => event.type === 'soduwork-store-hydrated'), true);
});

test('任务首屏不等待网络，断网期间保持加载态且不展示缓存', async () => {
  const api = {
    online: false,
    registerClient: () => new Promise(() => {}),
    getTasksSnapshot: async () => ({ online: false, items: [] }),
    getConfig: async () => ({}),
    connectWS: () => () => {},
  };
  const f = fixture(api, {});
  const started = Date.now();
  await f.initData();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 100, '任务首屏不能等待网络超时');
  assert.equal(f.Store.tasks.length, 0);
  assert.equal(f.Store.taskState, 'loading');
});

test('后台离线时有多少本地任务缓存都不进入任务视图', async () => {
  const api = {
    online: false,
    registerClient: async () => null,
    getTasksSnapshot: async () => ({ online: false, items: [], error: 'fetch failed' }),
    getConfig: async () => ({}),
    connectWS: () => () => {},
  };
  const cached = [{ id: 'cached-1', title: '不应显示的旧任务', status: 'todo', origin: 'local' }];
  const f = fixture(api, {
    soduwork_work_tasks_v5: JSON.stringify(cached),
    soduwork_work_task_shadow_v1: JSON.stringify(cached),
  });
  await f.initData();
  await f.Store._startupPromise;
  assert.equal(f.Store.tasks.length, 0);
  assert.equal(f.Store.taskState, 'offline');
});

test('saveCfg 发起即置待同步标记，后台确认送达后才摘除', async () => {
  let putCount = 0;
  const api = {
    online: true,
    registerClient: async () => null,
    getTasksSnapshot: async () => ({ online: false, items: [] }),
    getConfig: async () => ({}),
    connectWS: () => () => {},
    syncConfig: async () => { putCount++; return true; },
  };
  const f = fixture(api, { soduwork_work_cfg_v5: JSON.stringify({ theme: 'local' }) });
  await f.initData();
  await f.Store._startupPromise;
  f.Store.cfg.dockVisible = false;
  f.Store.saveCfg();
  assert.equal(f.values.get('soduwork_work_cfg_v5_sync_pending'), '1', '发起即置位：关窗杀掉定时器也留得住');
  // Advance fake timers through the 400ms debounce retry.
  for (const t of f.timers.filter(t => !t.interval)) { try { t.fn(); } catch (_) {} }
  await new Promise(r => setImmediate(r));
  assert.equal(putCount >= 1, true, '防抖结束后应向后台推送');
  assert.equal(f.values.get('soduwork_work_cfg_v5_sync_pending'), undefined, '送达后摘除标记');
});

test('有待同步修改时 hydrate 绝不用后台旧值回灌，并补推本地值', async () => {
  const puts = [];
  const api = {
    online: true,
    registerClient: async () => null,
    getTasksSnapshot: async () => ({ online: true, items: [] }),
    getConfig: async () => ({ dockVisible: true, petVisible: true, trayVisible: true, theme: 'stale-hub' }),
    connectWS: () => () => {},
    syncConfig: async (cfg) => { puts.push(JSON.parse(JSON.stringify(cfg))); return true; },
  };
  // Simulate persisted local changes whose prior upload remains pending.
  const f = fixture(api, {
    soduwork_work_cfg_v5: JSON.stringify({ dockVisible: false, petVisible: false, theme: 'local-new' }),
    soduwork_work_cfg_v5_sync_pending: '1',
  });
  await f.initData();
  await f.Store._startupPromise;
  assert.equal(f.Store.cfg.dockVisible, false, '后台旧值不得覆盖本地待同步修改');
  assert.equal(f.Store.cfg.theme, 'local-new', '同上：陈旧的 hub 值没有资格回灌');
  assert.equal(puts.length >= 1, true, '应反向补推本地值（反熵）');
  assert.equal(puts[0].dockVisible, false, '补推的内容是本地新值');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.values.get('soduwork_work_cfg_v5_sync_pending'), undefined, '补推送达后摘除标记');
});

test('没有待同步修改时 hydrate 照旧认后台校准（原语义不回归）', async () => {
  const api = {
    online: true,
    registerClient: async () => null,
    getTasksSnapshot: async () => ({ online: true, items: [] }),
    getConfig: async () => ({ theme: 'from-hub' }),
    connectWS: () => () => {},
    syncConfig: async () => true,
  };
  const f = fixture(api, { soduwork_work_cfg_v5: JSON.stringify({ theme: 'local' }) });
  await f.initData();
  await f.Store._startupPromise;
  assert.equal(f.Store.cfg.theme, 'from-hub');
  assert.equal(f.values.get('soduwork_work_cfg_v5_sync_pending'), undefined);
});

test('响应不确定的创建会转成幂等删除，服务端 404 按清理成功收敛', async () => {
  let deleted = '';
  const api = {
    online: true,
    deleteTask: async (id) => {
      deleted = id;
      const error = new Error('HTTP 404'); error.status = 404; throw error;
    },
  };
  const f = fixture(api, {});
  f.Store.tasks.push({ id: 'uncertain-1', title: '未确认任务', status: 'todo', origin: 'local' });
  f.Store.save();
  f.Store.discardUnconfirmedTask('uncertain-1');
  assert.equal(f.Store.tasks.length, 0);
  assert.equal(f.Store._readTaskOps()[0].kind, 'delete');
  await f.Store._flushTaskOps();
  assert.equal(deleted, 'uncertain-1');
  assert.equal(f.Store._readTaskOps().length, 0);
});

test('PUT已到Hub但回包丢失，GET确认存在后删除必须发送真实DELETE', async () => {
  const deleted = [];
  let server = null;
  const api = {online: true,
    putTask: async (id, data) => {
      server = {...data, id, title: 'Hub已确认的最新标题', origin: 'local', canDeleteRequirement: true, maintenanceBlocked: false};
      throw new Error('connection lost after commit');
    },
    getTask: async () => structuredClone(server),
    deleteTask: async id => {deleted.push(id); server = null;},
  };
  const f = fixture(api, {}), task = {id: 'ack-lost', title: '本地标题', status: 'todo', origin: 'local', canEditRequirement: true};
  f.Store.tasks.push(task); f.Store.save();
  await f.Store._flushTaskOps();
  assert.equal(f.Store._readTaskOps()[0].kind, 'put');
  assert.equal(f.Store._readTaskOps()[0].sentAt, undefined);
  assert.equal(f.Store._taskInFlight[task.id], undefined);
  const latest = await api.getTask(task.id);
  assert.ok(f.Store.removeTask(task.id, 0, latest));
  assert.equal(f.Store._readTaskOps()[0]?.kind, 'delete');
  assert.equal(f.Store._shadow[task.id]?.title, latest.title);
  await f.Store._flushTaskOps();
  assert.deepEqual(deleted, [task.id]);
  assert.equal(server, null);
  assert.equal(f.Store.tasks.length, 0);
  assert.equal(f.Store._readTaskOps().length, 0);
  assert.equal(f.Store._shadow[task.id], undefined);
});

test('确认存在后的删除被Hub拒绝时恢复最新快照，不能丢失需求', async () => {
  const f = fixture({online: true, deleteTask: async () => {
    const error = new Error('HTTP 409: 关联流程刚开始'); error.status = 409; throw error;
  }}, {});
  const task = {id: 'delete-race', title: '陈旧本地标题', canEditRequirement: true};
  const latest = {...task, title: 'Hub最新标题', canDeleteRequirement: true, maintenanceBlocked: false, requirementVersion: 7};
  f.Store.tasks.push(task);
  f.Store._writeTaskOps([{id: task.id, kind: 'put', data: task, token: 'uncertain-put'}]);
  assert.ok(f.Store.removeTask(task.id, 0, latest));
  await f.Store._flushTaskOps();
  assert.equal(f.Store.tasks.length, 1);
  assert.equal(f.Store.tasks[0].title, latest.title);
  assert.equal(f.Store.tasks[0].requirementVersion, 7);
  assert.match(f.Store.taskPersistError(task.id), /409/);
  assert.equal(f.Store._readTaskOps().length, 0);
});

test('未发出且未被Hub确认的纯本地创建仍可抵消删除', async () => {
  const deleted = [], f = fixture({online: true, deleteTask: async id => {deleted.push(id);}}, {});
  const task = {id: 'never-sent', title: '本地草稿', status: 'todo', origin: 'local', canEditRequirement: true};
  f.Store.tasks.push(task); f.Store.save();
  assert.equal(f.Store._readTaskOps()[0].kind, 'put');
  assert.ok(f.Store.removeTask(task.id, 0));
  await f.Store._flushTaskOps();
  assert.deepEqual(deleted, []);
  assert.equal(f.Store._readTaskOps().length, 0);
});

test('参与跟踪任务不会进入离线写队列，也不能从本机删除', () => {
  const api = { online: true };
  const f = fixture(api, {});
  const shared = {
    id: 'shared-1', title: '由同事承办的任务', status: 'doing', origin: 'local',
    readOnly: true, myRoles: ['creator'],
  };
  f.Store.tasks.push(shared);
  f.Store._setShadow([shared]);
  f.Store.save();
  assert.equal(f.Store._readTaskOps().length, 0);
  assert.equal(f.Store.removeTask(shared.id, 0), null);
  assert.equal(f.Store.tasks.length, 1);
  assert.equal(f.Store.tasks[0].id, shared.id);
});

test('Hub授权的跨设备只读需求可删除，迟到只读WS不会取消排队删除', async () => {
  const deleted = [], f = fixture({online: true, deleteTask: async id => {deleted.push(id);}}, {});
  const task = {id: 'delegated', title: '由同事执行', origin: 'dispatch', ownerClientId: 'coworker',
    status: 'todo', readOnly: true, canEditRequirement: true, canDeleteRequirement: true, maintenanceBlocked: false};
  f.Store.tasks.push(task); f.Store._setShadow([task]);
  assert.ok(f.Store.removeTask(task.id, 0));
  f.Store.applyServerEvent({type: 'task.updated', task: {...task, updatedAt: Date.now()}});
  assert.equal(f.Store.tasks.length, 0);
  assert.equal(f.Store._readTaskOps()[0].kind, 'delete');
  await f.Store._flushTaskOps();
  assert.deepEqual(deleted, ['delegated']);
  assert.equal(f.Store._readTaskOps().length, 0);
});

test('删除拒绝缺失或被撤回的Hub权限及执行保护，以刷新后的同一需求事实为准', () => {
  for (const fields of [{readOnly: false}, {canDeleteRequirement: false, canEditRequirement: true},
    {canDeleteRequirement: true, maintenanceBlocked: true}]) {
    const f = fixture({online: true}, {}), task = {id: 'guarded', ...fields};
    f.Store.tasks.push(task); f.Store._setShadow([task]);
    assert.equal(f.Store.removeTask(task.id, 0), null);
    assert.equal(f.Store.tasks.length, 1);
  }
  const f = fixture({online: true}, {}), old = {id: 'refreshed', readOnly: true, canDeleteRequirement: false};
  f.Store.tasks.push(old); f.Store._setShadow([old]);
  assert.ok(f.Store.removeTask(old.id, 0, {...old, canDeleteRequirement: true, maintenanceBlocked: false}));
});

test('accepted Hub locale hydration and config patches reconcile the current renderer without saving back', async () => {
  const calls = [];
  const api = {
    online: true,
    registerClient: async () => ({ ok: true }),
    getTasksSnapshot: async () => ({ online: true, items: [] }),
    getConfig: async () => ({ locale: 'en-US' }),
    connectWS: () => () => {},
  };
  const f = fixture(api, {});
  f.context.SoduWorkI18n = { setLocale(value, options) { calls.push([value, options.persist, f.Store.cfg.locale]); } };
  await f.initData(); await f.Store._startupPromise;
  assert.deepEqual(calls, [['en-US', false, 'en-US']]);
  f.Store.applyServerEvent({ type: 'config.patch', patch: { locale: 'zh-CN' } });
  assert.deepEqual(calls.at(-1), ['zh-CN', false, 'zh-CN']);
});

test('an explicit local locale survives stale per-device Hub defaults during startup', async () => {
  const puts = [], calls = [];
  const api = {
    online: true,
    registerClient: async () => ({ ok: true }),
    getTasksSnapshot: async () => ({ online: true, items: [] }),
    getConfig: async () => ({ locale: 'en-US', theme: 'from-hub' }),
    syncConfig: async cfg => { puts.push(JSON.parse(JSON.stringify(cfg))); return true; },
    connectWS: () => () => {},
  };
  const f = fixture(api, {
    soduwork_work_cfg_v5: JSON.stringify({ locale: 'en-US' }),
    soduwork_work_cfg_v5_locale: 'zh-CN',
    soduwork_work_cfg_v5_locale_explicit: '1',
  });
  f.context.SoduWorkI18n = { normalize: value => value, setLocale(value, options) {
    calls.push([value, options.persist, options.broadcast]);
  } };
  await f.initData(); await f.Store._startupPromise; await settle();
  assert.equal(f.Store.cfg.locale, 'zh-CN');
  assert.equal(f.Store.cfg.theme, 'vivid', 'local config remains intact while the locale is repaired');
  assert.equal(puts.at(-1)?.locale, 'zh-CN');
  assert.equal(calls.length, 1, 'stale Hub locale must not trigger a renderer switch');
});

test('a locale changed after startup is protected from a late Hub patch', async () => {
  const api = {
    online: true,
    registerClient: async () => ({ ok: true }),
    getTasksSnapshot: async () => ({ online: true, items: [] }),
    getConfig: async () => ({ locale: 'zh-CN' }),
    connectWS: () => () => {},
  };
  const f = fixture(api, {
    soduwork_work_cfg_v5: JSON.stringify({ locale: 'zh-CN' }),
    soduwork_work_cfg_v5_locale: 'zh-CN',
    soduwork_work_cfg_v5_locale_explicit: '1',
  });
  f.context.SoduWorkI18n = { setLocale() {} };
  await f.initData(); await f.Store._startupPromise;
  f.values.set('soduwork_work_cfg_v5_locale', 'ja-JP');
  f.values.set('soduwork_work_cfg_v5_locale_explicit', '1');
  f.Store.cfg.locale = 'ja-JP';
  f.Store._applyConfigPatch({ locale: 'en-US', theme: 'remote' });
  assert.equal(f.Store.cfg.locale, 'ja-JP');
  assert.equal(f.Store.cfg.theme, 'remote');
});

test('a mirror without local config does not block the first remote locale hydration', async () => {
  const calls = [];
  const api = {
    online: true,
    registerClient: async () => ({ ok: true }),
    getTasksSnapshot: async () => ({ online: true, items: [] }),
    getConfig: async () => ({ locale: 'zh-CN' }),
    connectWS: () => () => {},
  };
  const f = fixture(api, { soduwork_work_cfg_v5_locale: 'en-US' });
  f.context.SoduWorkI18n = { setLocale(value, options) { calls.push([value, options.persist]); } };
  await f.initData(); await f.Store._startupPromise;
  assert.equal(f.Store.cfg.locale, 'zh-CN');
  assert.deepEqual(calls, [['zh-CN', false]]);
  assert.equal(f.values.get('soduwork_work_cfg_v5_locale_source'), 'hub');
});

test('legacy non-default mirror-only locale remains recoverable after upgrade', async () => {
  const puts = [];
  const api = {
    online: true,
    registerClient: async () => ({ ok: true }),
    getTasksSnapshot: async () => ({ online: true, items: [] }),
    getConfig: async () => ({ locale: 'en-US' }),
    syncConfig: async cfg => { puts.push(cfg); return true; },
    connectWS: () => () => {},
  };
  const f = fixture(api, { soduwork_work_cfg_v5_locale: 'zh-CN' });
  await f.initData(); await f.Store._startupPromise; await settle();
  assert.equal(f.Store.cfg.locale, 'zh-CN');
  assert.equal(puts.at(-1)?.locale, 'zh-CN');
});

test('remote locale hydration remains authoritative for profiles without an explicit local choice', async () => {
  const firstApi = {
    online: true,
    registerClient: async () => ({ ok: true }),
    getTasksSnapshot: async () => ({ online: true, items: [] }),
    getConfig: async () => ({ locale: 'zh-CN' }),
    connectWS: () => () => {},
  };
  const values = new Map([['soduwork_work_cfg_v5_locale', 'en-US']]);
  const first = fixture(firstApi, Object.fromEntries(values));
  await first.initData(); await first.Store._startupPromise;
  first.values.forEach((value, key) => values.set(key, value));
  const secondApi = { ...firstApi, getConfig: async () => ({ locale: 'en-US' }) };
  const second = fixture(secondApi, Object.fromEntries(values));
  await second.initData(); await second.Store._startupPromise;
  assert.equal(second.Store.cfg.locale, 'en-US');
});

const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function connectedFixture() {
  const calls = { tasks: 0, registration: 0, probe: 0 };
  let snapshot = { online: true, items: [
    { id: 'same', title: '保留引用', status: 'todo', origin: 'local', canEditRequirement: true },
    { id: 'change', title: '旧标题', status: 'todo', origin: 'local' },
  ] };
  const api = {
    online: true,
    registerClient: async () => { calls.registration++; return { ok: true, authState: 'active' }; },
    checkConnection: async () => { calls.probe++; return true; },
    getTasksSnapshot: async () => { calls.tasks++; return typeof snapshot === 'function' ? snapshot() : snapshot; },
    getConfig: async () => ({}),
  };
  const f = fixture(api); await f.Store.init();
  return { ...f, api, calls, snapshot(value) { snapshot = value; } };
}

test('短暂断连保留同一列表、对象、服务端基线和待保存操作；自动入口等待真实心跳', async () => {
  const f = await connectedFixture(), rows = f.Store.tasks, first = rows[0], shadow = f.Store._shadow;
  const op = { id: 'change', kind: 'patch', token: 'pending', data: { title: '用户未保存的修改' } };
  f.Store._writeTaskOps([op]);
  f.snapshot({ online: false, items: [], error: 'timeout' });
  await f.Store.refreshTasks();
  assert.equal(f.Store.taskState, 'stale'); assert.equal(f.Store.tasks, rows);
  assert.equal(rows[0], first); assert.equal(f.Store._shadow, shadow);
  assert.equal(f.Store._readTaskOps()[0].token, 'pending');
  await f.Store.refreshTasks(); await f.Store.hydrate(true);
  f.context.dispatchEvent({ type: 'soduwork-ws-open' }); await settle();
  assert.equal(f.calls.tasks, 2, '跨窗、直接 hydrate 和 WS 不能绕过恢复门槛');
  f.api.checkConnection = async () => { f.calls.probe++; return false; };
  await f.Store.heartbeat(); await f.Store.heartbeat();
  assert.equal(f.calls.probe, 2); assert.equal(f.calls.tasks, 2);
  assert.equal(f.Store.tasks[0], first); assert.equal(f.Store._readTaskOps()[0].token, 'pending');
});

test('恢复检查单飞，真实心跳成功后只补拉一次并保留未变对象和未提交修改', async () => {
  const f = await connectedFixture(), rows = f.Store.tasks, first = rows[0], probe = deferred();
  f.Store._writeTaskOps([{ id: 'change', kind: 'patch', token: 'edit', data: { title: '用户修改' } }]);
  f.Store.markTaskOffline('断连');
  f.api.checkConnection = async () => { f.calls.probe++; return probe.promise; };
  f.snapshot({ online: true, items: [ { ...rows[0] }, { ...rows[1], note: '后台新增内容' }, { id: 'new', title: '新需求' } ] });
  const heartbeat = f.Store.heartbeat();
  assert.equal(f.Store.heartbeat(), heartbeat);
  const manual = f.Store.refreshTasks({ reconnect: true });
  f.context.dispatchEvent({ type: 'soduwork-ws-open' }); await settle();
  assert.equal(f.calls.probe, 1); assert.equal(f.calls.tasks, 1);
  probe.resolve(true); await Promise.all([heartbeat, manual]);
  assert.equal(f.calls.tasks, 2); assert.equal(f.Store.taskState, 'ready');
  assert.equal(f.Store.tasks, rows); assert.equal(rows[0], first);
  assert.equal(rows[1].title, '用户修改'); assert.equal(rows[1].note, '后台新增内容');
  assert.equal(rows[2].id, 'new'); assert.equal(f.Store._readTaskOps()[0].token, 'edit');
});

test('失败或待激活注册返回值不能触发任务恢复；旧 active 注册响应仍兼容', async () => {
  for (const registration of [null, { ok: false }, { ok: true, activationRequired: true },
    { ok: true, authState: 'pending' }, { id: 'legacy', authState: 'pending' }]) {
    const f = await connectedFixture(); f.Store.markTaskOffline();
    f.api.registerClient = async () => registration;
    await f.Store.heartbeat();
    assert.equal(f.calls.probe, 0); assert.equal(f.calls.tasks, 1);
    assert.equal(f.Store.taskState, 'stale');
  }
  const f = await connectedFixture(); f.Store.markTaskOffline();
  f.api.registerClient = async () => ({ id: 'legacy', authState: 'active' });
  await f.Store.heartbeat(); assert.equal(f.calls.tasks, 2); assert.equal(f.Store.taskState, 'ready');
});

test('成功空列表也保留已确认状态；503 后保留旧列表，成功快照收敛权限且不生成删除', async () => {
  const f = await connectedFixture();
  f.snapshot(() => { const error = Error('HTTP 503'); error.status = 503; throw error; });
  await f.Store.refreshTasks(); assert.equal(f.Store.taskState, 'stale'); assert.equal(f.Store.tasks.length, 2);
  f.Store._writeTaskOps([{ id: 'same', kind: 'patch', token: 'edit', data: { title: '旧权限修改' } }]);
  f.snapshot({ online: true, items: [{ id: 'same', title: '服务端只读', readOnly: true }] });
  await f.Store.heartbeat();
  assert.equal(f.Store.tasks.length, 1); assert.equal(f.Store.tasks[0].title, '服务端只读');
  assert.equal(f.Store._readTaskOps().length, 0, '失权记录退出投影，不产生远端 DELETE');
  f.snapshot({ online: true, items: [] }); await f.Store.refreshTasks(); f.Store.markTaskOffline();
  assert.equal(f.Store.tasks.length, 0); assert.equal(f.Store.taskState, 'stale');
});

test('迟到的列表不能复活刷新期间已删除任务或覆盖新推送', async () => {
  const f = await connectedFixture(), response = deferred(), before = JSON.parse(JSON.stringify(f.Store.tasks));
  f.snapshot(() => response.promise); const refresh = f.Store.refreshTasks();
  f.Store.applyServerEvent({ type: 'task.deleted', id: 'same' });
  f.Store.applyServerEvent({ type: 'task.updated', task: { ...before[1], title: '最新推送', readOnly: true } });
  f.Store.applyServerEvent({ type: 'task.created', task: { id: 'event-new', title: '新推送需求' } });
  response.resolve({ online: true, items: before }); await refresh;
  assert.deepEqual(Array.from(f.Store.tasks, task => task.id), ['change', 'event-new']);
  assert.equal(f.Store.tasks[0].title, '最新推送'); assert.equal(f.Store.tasks[0].readOnly, true);
});

test('新身份加载不受旧 hydrate 阻塞；旧恢复心跳也不能污染新身份', async () => {
  const f = await connectedFixture(), old = deferred();
  let identity = 'alice'; f.api.taskStorageKey = kind => identity + ':' + kind;
  f.snapshot(() => old.promise); const previous = f.Store.refreshTasks();
  identity = 'bob'; f.context.dispatchEvent({ type: 'soduwork-data-scope-changed' });
  assert.equal(f.Store.tasks.length, 0); assert.equal(f.Store.taskState, 'loading');
  f.snapshot({ online: true, items: [{ id: 'bob', title: '新账号' }] }); await f.Store.hydrate(true);
  old.resolve({ online: true, items: [{ id: 'alice', title: '旧账号' }] }); await previous;
  assert.equal(f.Store.tasks[0].id, 'bob');
  const probe = deferred(); f.Store.markTaskOffline(); f.api.checkConnection = async () => probe.promise;
  const recovery = f.Store.heartbeat(); await settle();
  identity = 'carol'; f.context.dispatchEvent({ type: 'soduwork-data-scope-changed' });
  f.snapshot({ online: true, items: [{ id: 'carol' }] }); await f.Store.hydrate(true);
  probe.resolve(true); await recovery; assert.equal(f.Store.tasks[0].id, 'carol');
});

test('配置缓慢或失败不阻塞任务，且迟到配置不覆盖等待期间的用户设置', async () => {
  const config = deferred(), f = fixture({ online: true, getConfig: () => config.promise,
    getTasksSnapshot: async () => ({ online: true, items: [{ id: 'visible' }] }) });
  await f.Store.init(); assert.equal(f.Store.taskState, 'ready'); assert.equal(f.Store.tasks[0].id, 'visible');
  f.Store.cfg.theme = 'user-choice'; f.Store.saveCfg(); config.resolve({ theme: 'old-server' });
  await settle(); assert.equal(f.Store.cfg.theme, 'user-choice');
  f.context.SoduWorkAPI.getConfig = async () => { throw Error('config failed'); };
  await f.Store.refreshTasks(); await settle(); assert.equal(f.Store.taskState, 'ready');
});

test('迟到的有效配置单独通知界面，config.patch 仍调用原脚本的词法主题函数', async () => {
  const config = deferred(), attributes = [];
  const f = fixture({ online: true, getConfig: () => config.promise,
    getTasksSnapshot: async () => ({ online: true, items: [{ id: 'visible' }] }) });
  await f.Store.init(); const row = f.Store.tasks[0];
  config.resolve({ theme: 'warm' }); await settle();
  assert.equal(f.Store.cfg.theme, 'warm'); assert.equal(f.Store.tasks[0], row);
  assert.equal(f.events.filter(event => event.type === 'soduwork-config-hydrated').length, 1);
  f.context.document.documentElement.setAttribute = (...args) => attributes.push(args);
  f.Store.applyServerEvent({ type: 'config.patch', patch: { theme: 'dark' } });
  assert.equal(attributes.some(([key, value]) => key === 'data-theme' && value === 'dark'), true);
});

test('切换身份后的心跳恢复重新订阅推送，并且只订阅一次', async () => {
  const f = await connectedFixture(); let connected = 0, closed = 0;
  f.api.connectWS = () => { connected++; return () => { closed++; }; };
  f.Store._wsOff = () => { closed++; };
  f.context.dispatchEvent({ type: 'soduwork-data-scope-changed' });
  await f.Store.heartbeat(); await f.Store.heartbeat();
  assert.equal(closed, 1); assert.equal(connected, 1); assert.equal(f.Store.taskState, 'ready');
});

test('在途刷新和旧删除回声不会抹掉显式撤销的卡片，普通未确认 PUT 仍不展示', async () => {
  const f = await connectedFixture(), response = deferred(), original = JSON.parse(JSON.stringify(f.Store.tasks));
  f.snapshot(() => response.promise); const refresh = f.Store.refreshTasks();
  const removed = f.Store.removeTask('same', 10000); f.Store.restoreTask(removed.task, removed.index);
  f.Store.save(); // A subsequent edit/save must retain the explicit undo marker.
  assert.equal(f.Store._readTaskOps().find(op => op.id === 'same').restore, true);
  f.Store._writeTaskOps(f.Store._readTaskOps().concat({ id: 'unconfirmed', kind: 'put', data: { title: '尚未确认' } }));
  f.Store.applyServerEvent({ type: 'task.deleted', id: 'same' });
  response.resolve({ online: true, items: original }); await refresh;
  assert.equal(f.Store.tasks.some(task => task.id === 'same'), true);
  assert.equal(f.Store.tasks.some(task => task.id === 'unconfirmed'), false);
  assert.equal(f.Store._shadow.same, undefined, '删除仍是服务端事实，撤销只属于本地操作队列');
});
