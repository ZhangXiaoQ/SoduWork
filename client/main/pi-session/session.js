/* multi-task binding compatibility */
// opts.taskRef ? String(opts.taskTitle : multi-task binding title compatibility
// taskId: handle.taskRef, collaboration: Boolean(handle.taskRef)
/* ===== Pi session engine, hosted in a separate Agent Runtime process =====
   This layer loads the SDK, starts and manages sessions, and forwards events to event-stream,
   which owns event normalization.

   Pi is ESM-only (type:module, with an import export but no require export). This entry is CJS,
   so load it through asynchronous dynamic import(), not a top-level require.

   Electron and SDK versions are pinned in package.json and the lockfile. Import the SDK at runtime
   to detect missing dependencies or incompatible APIs and report actionable errors.

   In production only agent-runtime/process-worker.js may load this module. The main process uses
   the process-session proxy, while tests may inject dependencies directly. A shared execution-process
   crash interrupts its Pi sessions; the host retains a read-only projection and never replays work
   automatically. The engine must still catch call failures and release resources.
   The agent-runtime module enforces this process boundary. */
const fs = require('fs');
const path = require('path');
const stream = require('./event-stream');
const messageTime = require('../conversation/message-time');
const outputContinuation = require('./output-continuation');
const historyState = require('./history-state');
const modelConfig = require('./model-config');
const agentContract = require('../conversation/agent-contract');
const nativeLocale = require('../native-locale.cjs');
const attachments = require('./attachments');
const attachmentContract = require('./attachment-contract');
const vision = require('./vision');
const imageRouting = require('./image-routing');
const visionContract = require('./vision-contract');
const pluginContext = require('./plugin-context');
const skillTurn = require('./skill-turn');
const { createTurnQueue } = require('./turn-queue');
const toolGuard = require('./tool-guard');
const goalContract = require('../conversation/goal-contract');
const goalQuality = require('../conversation/goal-quality');
const goalFinalizer = require('../conversation/goal-finalizer');
const goalHarness = require('../conversation/goal-harness');
const goalLoop = require('../conversation/goal-loop');
const goalReview = require('../conversation/goal-review');
const goalToolStages = require('./goal-tool-stages');
const finalAnswer = require('./final-answer');
const protocolGuard = require('../agent-runtime/protocol-guard');
const sessionHelpers = require('./session-helpers');
const runControl = require('./run-control');
const { sessionResources, initializeExtensions, independentReview } = require('./session-resources');
const mediaArtifacts = require('./media-artifacts');
const fileChangeJournal = require('../conversation/file-change-journal');
const snapshotWindow = require('./snapshot-window');
const thinkingCapabilities = require('../conversation/thinking-capabilities');
const deviceAuth = require('../device-auth');
let _sdk = null;          // Cache the dynamic SDK import result.
let _sdkError = '';
const _sessions = new Map();
// Opt-in cold-start diagnostics for the detached Electron main process.
// Disabled by default so normal desktop builds pay no logging cost.
const _openTiming = process.env.SODUWORK_OPEN_TIMING === '1'
  ? (() => {
      const file = path.join(require('os').tmpdir(), 'soduwork-open-timing.log');
      return (stage, started) => {
        try { fs.appendFileSync(file, `${new Date().toISOString()} ${stage} ${Math.round(performance.now() - started)}ms\\n`); } catch (_) {}
      };
    })()
  : () => {};

const _presenceState = historyState.presenceState;
const _messageTitle = historyState.messageTitle;
const _mergeHistory = historyState.mergeHistory;
const SCOPE_ENTRY_TYPE = 'soduwork.message.scope';
const PLUGIN_SELECTION_ENTRY_TYPE = 'soduwork.plugin.selection';
const MAX_SESSION_PLUGINS = pluginContext.MAX_PLUGINS || 3;
function _pluginIds(value) {
  const source = Array.isArray(value) ? value : [];
  return [...new Set(source.map((item) => String(item && item.pluginId || item || '').trim()).filter(Boolean))]
    .slice(0, MAX_SESSION_PLUGINS);
}
function _pluginSelectionFromEntries(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const item = rows[i];
    if (!item || item.type !== 'custom' || item.customType !== PLUGIN_SELECTION_ENTRY_TYPE) continue;
    return _pluginIds(item.data && item.data.pluginIds);
  }
  return [];
}
/* Durable task binding is stored in the session archive, not localStorage. */

const TASK_BINDING_ENTRY_TYPE = 'soduwork.task.binding';

function _taskBindingsFromEntries(entries) {
  const map=new Map();
  const add=(value)=>{
    const data=value&&typeof value==='object'?value:{};
    const id=String(data.taskId||data.id||data.taskRef||'').trim().slice(0,120);
    if(!id)return;
    const title=String(data.taskTitle||data.title||'').trim().slice(0,200);
    const old=map.get(id);
    map.set(id,{taskId:id,taskTitle:title||(old&&old.taskTitle)||''});
  };
  (Array.isArray(entries)?entries:[]).forEach((item)=>{
    if(!item||item.type!=='custom'||item.customType!==TASK_BINDING_ENTRY_TYPE)return;
    const data=item.data&&typeof item.data==='object'?item.data:{};
    if(Array.isArray(data.tasks))data.tasks.slice(0,32).forEach(add);else add(data);
  });
  return Array.from(map.values()).slice(-32);
}
function _taskBindingFromEntries(entries) {
  const tasks=_taskBindingsFromEntries(entries); let active="";
  const rows=Array.isArray(entries)?entries:[];
  for(let i=rows.length-1;i>=0;i-=1){
    const item=rows[i]; if(!item||item.type!=="custom"||item.customType!==TASK_BINDING_ENTRY_TYPE)continue;
    const data=item.data&&typeof item.data==="object"?item.data:{};
    const wanted=String(data.activeTaskId||data.taskId||data.id||"").trim();
    if(wanted&&tasks.some((row)=>row.taskId===wanted)){active=wanted;break;}
  }
  if(!active&&tasks.length)active=tasks[tasks.length-1].taskId;
  const selected=tasks.find((row)=>row.taskId===active)||{};
  return {taskId:selected.taskId||"",taskTitle:selected.taskTitle||"",tasks,
    taskIds:tasks.map((row)=>row.taskId),taskBindings:tasks.slice(),activeTaskId:selected.taskId||""};
}
function _appendTaskBinding(manager,taskId,taskTitle) {
  const id=String(taskId||"").trim().slice(0,120);
  if(!manager||!id||typeof manager.appendCustomEntry!=="function")return {ok:false,reason:"Issue binding unavailable"};
  const current=_taskBindingFromEntries(typeof manager.getEntries==="function"?manager.getEntries():[]);
  const old=current.tasks.find((row)=>row.taskId===id);
  const title=String(taskTitle||(old&&old.taskTitle)||"").trim().slice(0,200);
  const next=current.tasks.filter((row)=>row.taskId!==id); next.push({taskId:id,taskTitle:title});
  const tasks=next.slice(-32);
  try{manager.appendCustomEntry(TASK_BINDING_ENTRY_TYPE,{schemaVersion:2,tasks,activeTaskId:id,at:Date.now()});
    return {ok:true,taskId:id,taskTitle:title,tasks,taskIds:tasks.map((row)=>row.taskId),taskBindings:tasks.slice(),activeTaskId:id};
  }catch(error){return {ok:false,reason:"Issue binding save failed: "+String((error&&error.message)||error)};}
}
/* Probe SDK import directly to verify required runtime APIs. */
async function loadSdk(app) {
  require('../windows-fs-watch-guard.cjs').install();
  if (_sdk) return { ok: true, sdk: _sdk };
  // The Pi SDK invalidates its extension factory cache for every cwd. SoduWork
  // creates a private scratch cwd per chat, so apply the small compatibility
  // patch before the first ESM import; otherwise the first message after every
  // restart pays the full third-party extension startup cost.
  try { require('../../scripts/patch-pi-extension-cache.cjs').patchPiExtensionCache(); } catch (_) {}
  // The bundled Pi runtime uses exponential backoff by default. Apply the
  // companion schedule patch before its first import so session settings can
  // express SoduWork's bounded 5/15/30/60/120/240 second retry policy.
  try { require('../../scripts/patch-pi-retry-schedule.cjs').patchPiRetrySchedule(); } catch (_) {}
  const tried = [];
  for (const entry of sessionHelpers.entryCandidates(app)) {
    if (!fs.existsSync(entry)) { tried.push(entry + '（不存在）'); continue; }
    try {
      const mod = await require('./sdk-loader').load(entry);
      if (typeof mod.createAgentSession !== 'function') {
        tried.push(entry + '（缺 createAgentSession）');
        continue;
      }
      _sdk = mod;
      _sdkError = '';
      return { ok: true, sdk: mod, entry };
    } catch (e) {
      _sdkError = sessionHelpers.explain(e);
      return { ok: false, reason: _sdkError };      // Do not retry alternate paths for an incompatible runtime API.
    }
  }
  _sdkError = '没找到 pi 的安装位置：' + tried.join('；');
  return { ok: false, reason: _sdkError };
}

async function prewarm(app, identity, modelName = '') {
  // Prepare the complete local Pi environment while the composer is idle.
  // Fetching only the model metadata leaves models.json, proxy variables and
  // MCP wiring for the first send, which is exactly the cold-start pause users
  // see after clicking Send. `prepare` shares model-config's in-flight cache
  // with the later open call, so it never creates a second request.
  const [sdk, model] = await Promise.all([
    loadSdk(app),
    modelConfig.prepare(app, identity, modelName),
  ]);
  return { ok: !!(sdk.ok && model.ok), sdk, model };
}

// Extension/package discovery is the only expensive part of creating the
// first local session after a desktop restart. Warm the SDK's module cache in
// the background while the shell is loading so the real session can create
// its own cwd-scoped resources without paying the cold package import cost.
let _resourceWarmupPromise = null;
// The warmup primes process-wide Pi extension factories. Keep the successful
// result for the life of the main process; clearing it after every call made
// each newly opened composer start the expensive package discovery again.
let _resourceWarmupResult = null;
async function prewarmResources(app, options = {}) {
  if (_resourceWarmupResult) return Promise.resolve(_resourceWarmupResult);
  if (_resourceWarmupPromise) return _resourceWarmupPromise;
  const warmupStarted = performance.now();
  _openTiming('resource-warmup-start', warmupStarted);
  _resourceWarmupPromise = (async () => {
    const loaded = await loadSdk(app);
    if (!loaded.ok) return loaded;
    const cwd = options.cwd || path.join(app.getPath('userData'), 'temp', '__soduwork-resource-warmup');
    try { fs.mkdirSync(cwd, { recursive: true }); } catch (_) {}
    let resources = null;
    try {
      resources = await sessionResources(loaded.sdk, cwd, modelConfig.agentDir(app),
        Array.isArray(options.skillDirs) ? options.skillDirs : [], [], {
          noExtensions: false,
          timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15000,
        });
      _openTiming('resource-warmup-ready', warmupStarted);
      return { ok: true, degraded: Boolean(resources.degraded), cached: true };
    } finally {
      try { resources?.resourceLoader?.getExtensions?.()?.runtime?.invalidate?.('startup warmup complete'); } catch (_) {}
    }
  })().catch((error) => ({ ok: false, reason: String(error?.message || error) }));
  _resourceWarmupPromise = _resourceWarmupPromise.then((result) => {
    if (result?.ok) _resourceWarmupResult = result;
    return result;
  }).finally(() => { _resourceWarmupPromise = null; });
  return _resourceWarmupPromise;
}

/*
 * Give each session its own resource loader and additionalSkillPaths. Disable automatic
 * skill discovery so concurrent sessions cannot mutate shared skill sets or exceed their
 * SessionSpec.
 */

/*
 * Read Pi JSONL archives beneath the agent directory for conversation history and
 * resumption.
 */
const { createArchiveHistory } = require('./archive-history');
const archiveState = require('./archive-state');
const _historyIndexes = new Map();
function _historyIndex(app) {
  const root = path.resolve(modelConfig.agentDir(app));
  let index = _historyIndexes.get(root);
  if (!index) {
    index = createArchiveHistory({ root, project(s, entries) {
      const binding = _taskBindingFromEntries(entries);
      return {
        id: s.id, path: s.path, cwd: s.cwd || '', usedHarnesses: s.usedHarnesses || [],
        title: s.workOwner ? s.name || '工作记录' : sessionHelpers.repairPersistedTitle(
          s.messageCount ? sessionHelpers.title(s) : binding.taskTitle || sessionHelpers.title(s),
          s.firstMessage),
        ...(s.workOwner ? { workOwner: s.workOwner, workOnly: s.workOnly } : {}),
        taskId: binding.taskId, taskTitle: binding.taskTitle,
        taskIds: binding.taskIds, taskBindings: binding.taskBindings, activeTaskId: binding.activeTaskId,
        collaboration: Boolean(binding.taskId), createdAt: +new Date(s.createdAt || s.modified),
        at: +new Date(s.modified), count: s.messageCount || 0,
      };
    } });
    _historyIndexes.set(root, index);
  }
  return index;
}
async function history(app, limit) {
  try {
    const rows = await _historyIndex(app).list();
    const root = path.resolve(modelConfig.agentDir(app));
    const archived = archiveState.read(root).conversations;
    const visible = rows.filter(row => row.count || row.taskId || row.workOwner)
      .filter(row => !Object.prototype.hasOwnProperty.call(archived, row.id));
    return { ok: true, chats: _mergeHistory(visible, list(), limit) };
  } catch (e) {
    return { ok: false, reason: '读不出历史对话：' + String((e && e.message) || e), chats: [] };
  }
}

async function archivedHistory(app, limit) {
  try {
    const rows = await _historyIndex(app).list();
    const root = path.resolve(modelConfig.agentDir(app));
    const archivedIds = archiveState.read(root).conversations;
    const archived = rows.filter(row => (row.count || row.taskId || row.workOwner) &&
      Object.prototype.hasOwnProperty.call(archivedIds, row.id))
      .map(row => ({ ...row, archivedAt: Number(archivedIds[row.id]) || 0, archived: true }))
      .sort((a, b) => Number(b.archivedAt || b.at || 0) - Number(a.archivedAt || a.at || 0));
    const max = Math.max(1, Number(limit) || Number.MAX_SAFE_INTEGER);
    return { ok: true, chats: archived.slice(0, max) };
  } catch (e) {
    return { ok: false, reason: '读不出归档历史：' + String((e && e.message) || e), chats: [] };
  }
}

function archiveRoot(app) { return path.resolve(modelConfig.agentDir(app)); }
function isArchived(app, id) { return archiveState.isArchived(archiveRoot(app), id); }
function setArchived(app, id, archived) { return archiveState.setArchived(archiveRoot(app), id, archived); }

async function archiveHistory(app, id) {
  const found = await historyEntry(app, id, { strict: true });
  if (!found || !found.ok || !found.entry) return found || { ok: false, reason: '找不到这条会话' };
  const at = archiveState.setArchived(archiveRoot(app), id, true);
  return { ok: true, id: String(id), archived: true, archivedAt: at, entry: found.entry };
}

async function restoreHistory(app, id) {
  const wanted = String(id || '').trim();
  if (!wanted) return { ok: false, reason: '没有指定要恢复的会话' };
  if (!archiveState.isArchived(archiveRoot(app), wanted)) {
    return { ok: false, reason: '这条会话不在归档历史中' };
  }
  const found = await historyEntry(app, wanted, { strict: true });
  if (!found || !found.ok || !found.entry) return found || { ok: false, reason: '找不到这条会话' };
  archiveState.setArchived(archiveRoot(app), wanted, false);
  return { ok: true, id: wanted, archived: false, entry: found.entry };
}

async function _plainArchiveRoot(root) {
  let directory = path.resolve(root);
  try {
    for (;;) {
      const stat = await fs.promises.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      const parent = path.dirname(directory);
      if (parent === directory) return true;
      directory = parent;
    }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error?.code)) return false;
    throw error;
  }
}

async function permanentlyDeleteHistory(app, id) {
  const wanted = String(id || '').trim();
  if (!wanted) return { ok: false, reason: '没有指定要删除的会话' };
  const root = archiveRoot(app);
  if (!await _plainArchiveRoot(root)) return { ok: false, reason: '会话存档目录不受信任，已拒绝删除' };
  if (!archiveState.isArchived(root, wanted)) return { ok: false, reason: '只能从归档历史彻底删除会话' };
  const found = await historyEntry(app, wanted, { strict: true });
  if (!await _plainArchiveRoot(root)) return { ok: false, reason: '会话存档目录不受信任，已拒绝删除' };
  if (!found?.ok && !found?.notFound) return found || { ok: false, reason: '读取会话存档失败，请重试' };
  if (!found.ok || !found.entry || !found.entry.path) {
    archiveState.remove(root, wanted);
    return { ok: true, id: wanted, alreadyDeleted: true };
  }
  try {
    // The index resolves transcripts to real paths. Resolve the approved root
    // at this final check too, so Windows short names cannot look like escapes.
    const trustedRoot = await fs.promises.realpath(root);
    const file = await fs.promises.realpath(found.entry.path);
    const relative = path.relative(trustedRoot, file);
    if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ||
        path.extname(file).toLowerCase() !== '.jsonl') {
      return { ok: false, reason: '会话存档路径不受信任，已拒绝删除' };
    }
    if (!await _plainArchiveRoot(root)) return { ok: false, reason: '会话存档目录不受信任，已拒绝删除' };
    await fs.promises.unlink(file);
    if (!await _plainArchiveRoot(root)) return { ok: false, reason: '会话存档目录不受信任，已拒绝删除' };
    archiveState.remove(root, wanted);
    return { ok: true, id: wanted, permanentlyDeleted: true };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      if (!await _plainArchiveRoot(root)) return { ok: false, reason: '会话存档目录不受信任，已拒绝删除' };
      archiveState.remove(root, wanted);
      return { ok: true, id: wanted, alreadyDeleted: true };
    }
    throw error;
  }
}

/*
 * Accept indexed conversation IDs only and revalidate real paths, file versions, and IDs.
 * History lookup does not load the Agent SDK or prepare model execution.
 */
async function historyEntry(app, id, options = {}) {
  const wanted = String(id || '').trim();
  if (!wanted) return { ok: false, reason: '没有指定会话' };
  try {
    const row = await _historyIndex(app).find(wanted, { strict: options.strict === true });
    if (!row) return { ok: false, notFound: true, reason: '这条会话已经不存在了' };
    return { ok: true, entry: row };
  } catch (error) {
    return { ok: false, reason: '找不到这条会话的安全存档：' + String(error && error.message || error) };
  }
}
/*
 * Seed restored messages through normal event shapes so history and live content share one
 * normalizer.
 */
const { seed: _seed } = require('./history-seed');

/*
 * Open a session from application, identity, workspace, capability, model, intent, goal,
 * review, and optional resume settings. Return either the session or a readable failure
 * reason.
 */
const openContext = {
  get _appendTaskBinding() { return _appendTaskBinding; },
  get _messageTitle() { return _messageTitle; },
  get _openTiming() { return _openTiming; },
  get _pluginIds() { return _pluginIds; },
  get _pluginSelectionFromEntries() { return _pluginSelectionFromEntries; },
  get _presenceState() { return _presenceState; },
  get _seed() { return _seed; },
  get _sessions() { return _sessions; },
  get _taskBindingFromEntries() { return _taskBindingFromEntries; },
  get agentContract() { return agentContract; },
  get attachmentContract() { return attachmentContract; },
  get attachments() { return attachments; },
  get createTurnQueue() { return createTurnQueue; },
  get deviceAuth() { return require('../agent-runtime/process-context').current()?.deviceAuth || deviceAuth; },
  get fileChangeJournal() { return fileChangeJournal; },
  get finalAnswer() { return finalAnswer; },
  get goalContract() { return goalContract; },
  get goalFinalizer() { return goalFinalizer; },
  get goalHarness() { return goalHarness; },
  get goalLoop() { return goalLoop; },
  get goalQuality() { return goalQuality; },
  get goalReview() { return goalReview; },
  get goalToolStages() { return goalToolStages; },
  get independentReview() { return independentReview; },
  get initializeExtensions() { return initializeExtensions; },
  get loadSdk() { return loadSdk; },
  get mediaArtifacts() { return mediaArtifacts; },
  get messageTime() { return messageTime; },
  get modelConfig() { return modelConfig; },
  get nativeLocale() { return nativeLocale; },
  get outputContinuation() { return outputContinuation; },
  get PLUGIN_SELECTION_ENTRY_TYPE() { return PLUGIN_SELECTION_ENTRY_TYPE; },
  get pluginContext() { return pluginContext; },
  get protocolGuard() { return protocolGuard; },
  get runControl() { return runControl; },
  get SCOPE_ENTRY_TYPE() { return SCOPE_ENTRY_TYPE; },
  get sessionResources() { return sessionResources; },
  get skillTurn() { return skillTurn; },
  get snapshotWindow() { return snapshotWindow; },
  get stream() { return stream; },
  get thinkingCapabilities() { return thinkingCapabilities; },
  get toolGuard() { return toolGuard; },
  get imageRouting() { return imageRouting; },
  get vision() { return vision; },
  get visionContract() { return visionContract; },
};
const { open } = require('./session-open').create(openContext);


function get(ref) { return _sessions.get(ref) || null; }
function list() { return Array.from(_sessions.values()); }
function findBySessionId(id) {
  const wanted = String(id || '');
  return wanted ? list().find((handle) => String(handle.sessionId || '') === wanted) || null : null;
}
function closeAll() { list().forEach((s) => { try { s.close(); } catch (e) { /* ignore */ } }); }

/* Probe availability before presenting the conversation interface. */
async function probe(app) {
  const loaded = await loadSdk(app);
  return loaded.ok
    ? { ok: true, node: process.versions.node, electron: process.versions.electron || '',
      accessControl: require('../agent-runtime/runtime-catalog').runtime('pi').accessControl }
    : { ok: false, reason: loaded.reason };
}

module.exports = {
  open, get, list, findBySessionId, closeAll, probe, loadSdk, prewarm, prewarmResources,
  sessionResources, history, archivedHistory, historyEntry, archiveHistory, restoreHistory,
  permanentlyDeleteHistory, archiveRoot, isArchived, setArchived, archiveState,
  SCOPE_ENTRY_TYPE, TASK_BINDING_ENTRY_TYPE,
  _taskBindingFromEntries,
  _explain: sessionHelpers.explain, _presenceState, _mergeHistory, _title: sessionHelpers.title, _seed,
};


