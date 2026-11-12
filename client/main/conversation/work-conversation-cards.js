'use strict';

// Work forms belong to real conversations: Pi archives own identity and history; sidecar JSON stores UI state and attachments.
// Creating a form does not start an agent, fetch model configuration, or fabricate an assistant message to force persistence.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { scope, connectionScope, scopeMatches } = require('../platform-connections/runtime.cjs');
const memories = require('./session-memory');
const titles = require('./titles');
const ENTRY_TYPE = 'soduwork.work-entry';
const MAX_FILES = 32, MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024, MAX_STORE_BYTES = 256 * 1024 * 1024, MAX_CARDS = 100;
const ACTIONS = new Set(['work.requirement.create', 'work.automation.create']);
const queues = new Map();

const directory = app => path.join(app.getPath('userData'), 'conversation-work-cards');
const location = (app, id) => path.join(directory(app), crypto.createHash('sha256').update(id).digest('hex') + '.json');
const sessionId = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw Error('会话标识无效');
  return value.trim();
};
function jsonValue(value) {
  let count = 0;
  const seen = new Set();
  function visit(item, depth) {
    if (++count > 100000 || depth > 32) throw Error('表单结构过大，请精简后重试');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || seen.has(item) ||
        (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null))
      throw Error('表单只能保存 JSON 数据，请重新打开后重试');
    seen.add(item);
    for (const child of Object.values(item)) visit(child, depth + 1);
    seen.delete(item);
  }
  visit(value, 0);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw Error('表单正文超过 8 MB，未保存，请精简后重试');
  return JSON.parse(text);
}
function normalizeCard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('缺少工作表单');
  const allowed = new Set(['id', 'actionId', 'prompt', 'seed', 'state', 'files', 'closed', 'revision', 'createdAt', 'updatedAt']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw Error('工作表单包含不支持的字段');
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(value.id)) throw Error('表单标识无效');
  if (!ACTIONS.has(value.actionId)) throw Error('此动作不支持保存到会话');
  if (typeof value.prompt !== 'string' || value.prompt.length > 1000000) throw Error('表单原文超过限制，未保存');
  if (value.closed !== undefined && typeof value.closed !== 'boolean') throw Error('表单关闭状态无效');
  if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 0)) throw Error('表单版本无效');
  const fields = jsonValue({ prompt: value.prompt, seed: value.seed ?? {}, state: value.state ?? {} });
  if (!Array.isArray(value.files || []) || (value.files || []).length > MAX_FILES) throw Error('每张表单最多保存 32 份附件，未保存');
  let bytes = 0;
  const files = (value.files || []).map(file => {
    if (!file || typeof file !== 'object' || Array.isArray(file) ||
        Object.keys(file).some(key => !['name', 'type', 'lastModified', 'data'].includes(key))) throw Error('附件字段无效，请重新添加附件');
    if (typeof file.name !== 'string' || !file.name.trim() || file.name.length > 512 || /[\x00-\x1f/\\]/.test(file.name))
      throw Error('附件名称无效');
    if (typeof file.type !== 'string' || file.type.length > 200 ||
        !Number.isFinite(file.lastModified) || file.lastModified < 0 || typeof file.data !== 'string') throw Error('附件数据无效');
    if (file.data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || file.data.length % 4 ||
        /[^A-Za-z0-9+/=]/.test(file.data)) throw Error('附件内容损坏或超过 64 MB，未保存');
    const decoded = Buffer.from(file.data, 'base64');
    if (decoded.toString('base64') !== file.data) throw Error('附件内容编码无效');
    bytes += decoded.length;
    if (bytes > MAX_FILE_BYTES) throw Error('一张表单的附件合计超过 64 MB，未保存');
    return { name: file.name, type: file.type, lastModified: file.lastModified, data: file.data };
  });
  return { id: value.id, actionId: value.actionId, ...fields, files, closed: value.closed === true,
    ...(value.revision === undefined ? {} : { revision: value.revision }) };
}
function normalizeDraftSelection(value) {
  const limits = { adapterId: 160, modelName: 300, modelLabel: 300, reasoningEffort: 40, thinkingLevel: 40 };
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !Object.hasOwn(limits, key))) throw Error('草稿执行选项包含不支持的字段');
  const result = { adapterId: 'pi', modelName: '', modelLabel: '', reasoningEffort: '', thinkingLevel: '' };
  for (const [key, text] of Object.entries(value)) {
    if (typeof text !== 'string' || text.length > limits[key] || /[\x00-\x1f\x7f]/.test(text)) throw Error('草稿执行选项无效');
    result[key] = text.trim();
  }
  result.adapterId ||= 'pi';
  return result;
}
function accountCandidates(app) {
  try { return require('../device-auth').profiles(app); } catch (_) { return []; }
}
function restoredRequirementCard(card, captured) {
  const state = card?.state;
  if (card?.actionId !== 'work.requirement.create' || state?.version !== 1 ||
      !['draft', 'loading', 'error'].includes(state.phase) || state.submission != null || state.receipt != null ||
      typeof state.ownerScope !== 'string' || state.ownerScope.length > 8192) return card;
  try {
    const parts = state.ownerScope.split('@');
    if (parts.length !== 4 || parts[0] !== 'soduwork_work_task_ops_v1') return card;
    const [savedHub, savedDevice, uid] = parts.slice(1).map(decodeURIComponent);
    if ([savedHub, savedDevice, uid].some((value, index) => !value || /[\x00-\x1f\x7f]/.test(value) ||
        encodeURIComponent(value) !== parts[index + 1])) return card;
    const hub = new URL(captured.identity.hub);
    const currentHub = hub.protocol.toLowerCase() + '//' + hub.host.toLowerCase() + hub.pathname.replace(/\/+$/, '');
    // Outer record/session ownership has already been checked. The saved UI
    // tuple cannot establish identity: verify its account against trusted auth.
    const account = crypto.createHash('sha256').update('soduwork-account\0' + uid).digest('hex').slice(0, 32);
    if (savedHub !== currentHub || account !== captured.owner) return card;
    // Device re-enrollment can recover local draft text, never pending task
    // creation, submission retries, receipts or entities from another Hub.
    const ownerScope = [parts[0], ...[currentHub, captured.identity.clientId, uid].map(encodeURIComponent)].join('@');
    return ownerScope === state.ownerScope ? card : { ...card, state: { ...state, ownerScope } };
  } catch (_) { return card; }
}
function visibleHistory(app, rows, identity) {
  return require('./history-access').visible(app, rows, identity);
}
async function diskRecord(app, id) {
  try {
    const file = location(app, id), stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) throw Error('工作表单存档大小或路径无效');
    const row = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (row.version !== 1 || row.sessionId !== id || typeof row.owner !== 'string' || !Array.isArray(row.cards)) throw Error('工作表单存档格式无效');
    if (Object.hasOwn(row, 'draftSelection')) {
      row.draftSelection = normalizeDraftSelection(row.draftSelection);
      if (!Number.isSafeInteger(row.draftSelectionRevision) || row.draftSelectionRevision < 1) throw Error('草稿执行选项版本无效');
    } else if (Object.hasOwn(row, 'draftSelectionRevision')) throw Error('草稿执行选项缺失');
    return row;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Error('无法读取已保存的工作表单：' + String(error.message || error));
  }
}
function serial(key, action) {
  const job = (queues.get(key) || Promise.resolve()).catch(() => {}).then(action);
  queues.set(key, job);
  return job.finally(() => { if (queues.get(key) === job) queues.delete(key); });
}
async function assertCreatedTask(app, rawId, taskId, identity) {
  const id = sessionId(rawId);
  return serial(location(app, id), async () => {
    const record = await diskRecord(app, id);
    if (!record || !scopeMatches(record.owner, identity, accountCandidates(app)))
      throw Error('这条工作表单会话属于另一个账号或尚未保存');
    if (!record.cards.some(card => card.actionId === 'work.requirement.create' &&
        card.state?.phase === 'succeeded' && card.state.receipt?.id === taskId && !card.state.receipt.gone))
      throw Error('这条会话没有该需求的创建回执，请保存工作卡片后重试');
  });
}
function archiveFile(app, planned) {
  const base = path.resolve(app.getPath('userData')), root = path.join(base, 'pi-agent', 'sessions');
  const file = path.resolve(planned?.file || ''), relative = path.relative(root, file);
  if (!path.isAbsolute(planned?.file || '') || !relative || relative === '..' ||
      relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || path.extname(file) !== '.jsonl' ||
      !planned.header || planned.header.type !== 'session' || planned.header.id !== planned.id)
    throw Error('会话存档计划路径无效');
  let cursor = base;
  for (const part of ['', ...path.relative(base, path.dirname(file)).split(path.sep)]) {
    if (part) cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw Error('会话存档目录不能是链接');
  }
  return file;
}
function removeOwnedDraft(created, owner) {
  try {
    const stat = fs.lstatSync(created.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024 ||
        stat.dev !== created.stat.dev || stat.ino !== created.stat.ino) return;
    const bytes = fs.readFileSync(created.file), header = Buffer.from(JSON.stringify(created.header) + '\n');
    if (bytes.length <= header.length && header.subarray(0, bytes.length).equals(bytes)) {
      fs.unlinkSync(created.file); return;
    }
    if (!bytes.subarray(0, header.length).equals(header)) return;
    const entries = bytes.subarray(header.length).toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    if (entries.some(entry => entry.type !== 'session_info' &&
        !(entry.type === 'custom' && entry.customType === ENTRY_TYPE && entry.data?.owner === owner))) return;
    fs.unlinkSync(created.file);
  } catch (_) { /* Never remove a replaced archive or a conversation that has started. */ }
}
function removeReservedSelection(app, created, owner, selection) {
  if (!selection || fs.existsSync(created.file)) return;
  try {
    const file = location(app, created.header.id), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return;
    const expected = Buffer.from(JSON.stringify({ version: 1, sessionId: created.header.id, owner,
      cards: [], draftSelection: selection, draftSelectionRevision: 1 }));
    // Filesystem filters may report a container size rather than decoded bytes.
    // Read at most the exact expected payload plus one byte; never remove a
    // later writer's record or allocate from an untrusted reported file size.
    const fd = fs.openSync(file, 'r'), bytes = Buffer.alloc(expected.length + 1);
    let read = 0;
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) return;
      while (read < bytes.length) {
        const count = fs.readSync(fd, bytes, read, bytes.length - read, read);
        if (!count) break;
        read += count;
      }
    } finally { fs.closeSync(fd); }
    const current = fs.lstatSync(file);
    if (read === expected.length && bytes.subarray(0, read).equals(expected) &&
        current.dev === stat.dev && current.ino === stat.ino && !current.isSymbolicLink()) fs.unlinkSync(file);
  } catch (_) { /* Keep a later writer's card or selection record. */ }
}

function create({ app, identityOf, session, newCwd, loadStorageSdk: load, replace = fsp.rename, notify = () => {} }) {
  async function auth() {
    const identity = await identityOf(app);
    if (!identity) throw Error('请先登录 SoduWork');
    return { identity, owner: scope(identity), connection: connectionScope(identity) };
  }
  async function guard(captured) {
    const now = await auth();
    if (captured.owner !== now.owner || captured.connection !== now.connection) throw Error('账号或服务已切换，请在当前会话重试');
  }
  async function resolve(id, captured) {
    await guard(captured);
    const live = session.findBySessionId?.(id);
    const row = live ? live.historyRow?.() || { id, adapterId: live.adapterId }
      : await session.archivedConversation(app, id);
    if (!row) throw Error('这条会话已经不存在，工作表单未保存');
    await guard(captured);
    memories.binding(app, id, captured.identity);
    // usageIdentity contains Hub and client identifiers, not an account-signed credential.
    // Validate account ownership through persisted memory, requirement, and segment bindings rather than treating missing tokens as unauthorized history.
    if (row.workOwner && !scopeMatches(row.workOwner, captured.identity, accountCandidates(app))) throw Error('这条会话属于另一个账号');
    const segments = require('./runtime-segments').read(app, id);
    if (segments) require('./runtime-segments').assertOwner(app, segments, captured.identity);
    const linked = require('./requirement-context').read(app, id);
    if (linked && !scopeMatches(linked.owner, captured.identity, accountCandidates(app))) throw Error('这条需求会话属于另一个账号');
    return { ...row, id };
  }
  function owner(record, captured) {
    if (record && !scopeMatches(record.owner, captured.identity, accountCandidates(app))) throw Error('工作表单属于另一个账号，请切回原账号');
  }
  const attempt = async action => {
    try { return await action(); }
    catch (error) { return { ok: false, reason: String(error.message || error),
      ...(['STALE_DRAFT_SELECTION', 'WORK_CONVERSATION_STARTED'].includes(error.code) ? { code: error.code } : {}) }; }
  };
  function draftOnly(id, row) {
    return row.workOnly === true && !session.findBySessionId?.(id) && !require('./runtime-segments').read(app, id);
  }
  function assertDraftOnly(id, row) {
    if (!draftOnly(id, row)) throw Object.assign(Error('会话已经开始执行，请使用当前会话的模型和 Agent 选择器'), { code: 'WORK_CONVERSATION_STARTED' });
  }
  async function writeRecord(id, captured, record, validate = resolve) {
    const file = location(app, id), text = JSON.stringify(record);
    if (Buffer.byteLength(text) > MAX_STORE_BYTES) throw Error('本会话的表单材料超过 256 MB，未保存，请减少附件或新建会话');
    await fsp.mkdir(directory(app), { recursive: true });
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fsp.writeFile(temp, text, { flag: 'wx', mode: 0o600 });
      // Selection and cards share this session queue and the final identity check.
      await validate(id, captured);
      for (let retry = 0; ; retry++) {
        try { await replace(temp, file); break; }
        catch (error) {
          if (!['EBUSY', 'EPERM'].includes(error.code) || retry === 4) throw error;
          await new Promise(done => setTimeout(done, 25 * 2 ** retry));
          await validate(id, captured);
        }
      }
    } finally { await fsp.unlink(temp).catch(() => {}); }
    await guard(captured);
  }
  function publicPresence(row) {
    const { workOwner, ...rest } = titles.decorate(app, row);
    return { ...rest, workOnly: row.workOnly === true };
  }
  async function reserve(raw = {}) {
    return attempt(async () => {
      const captured = await auth(), title = titles.normalize(raw.title || '工作记录');
      const selection = raw.draftSelection === undefined ? null : normalizeDraftSelection(raw.draftSelection);
      let sdk, planned, created, memory, storage;
      try {
        // Explicit storage SDK injection remains available to isolated legacy
        // tests. Production always delegates SDK work to the runtime process.
        if (load) { sdk = await load(app); await guard(captured); }
        const cwd = newCwd(raw);
        if (sdk) {
          const manager = sdk.SessionManager.create(cwd,
            sdk.getDefaultSessionDir(cwd, path.join(app.getPath('userData'), 'pi-agent')));
          planned = { id: manager.getSessionId(), file: manager.getSessionFile(), header: manager.getHeader() };
        } else {
          storage = typeof session.reserveArchive === 'function' ? session : require('../agent-runtime/process-session');
          planned = await storage.reserveArchive(app, cwd, title, captured.owner);
        }
        await guard(captured);
        const { id, header } = planned, file = archiveFile(app, planned);
        const binding = path.join(app.getPath('userData'), 'session-memory-bindings',
          crypto.createHash('sha256').update(id).digest('hex') + '.json');
        if (fs.existsSync(binding)) throw Error('会话标识已被占用，请重试');
        memories.bind(app, id, captured.identity, [], true);
        memory = { file: binding, stat: fs.lstatSync(binding), bytes: fs.readFileSync(binding) };
        // Create only the SDK-provided native header. Metadata append stays
        // in the worker and cannot load execution or SDK code into main.
        const fd = fs.openSync(file, 'wx', 0o600);
        try { created = { file, stat: fs.fstatSync(fd), header }; fs.writeFileSync(fd, JSON.stringify(header) + '\n'); }
        finally { fs.closeSync(fd); }
        await guard(captured);
        if (sdk) {
          const stored = sdk.SessionManager.open(file);
          stored.appendSessionInfo(title);
          stored.appendCustomEntry(ENTRY_TYPE, { version: 1, owner: captured.owner });
        } else await storage.commitArchive(app, planned);
        await guard(captured);
        let selected = { draftSelection: null, draftSelectionRevision: 0 };
        if (selection) {
          selected = await saveDraftSelection(id, { selection, revision: 0 });
          if (!selected.ok) throw Error(selected.reason);
        }
        await guard(captured);
        const presence = { id, title, cwd, adapterId: 'pi', at: Date.now(), count: 0, state: 'idle', workOnly: true };
        notify({ kind: 'work-conversation-created', sessionId: id, ref: '', presence });
        return { ok: true, sessionId: id, title, presence, workOnly: true,
          draftSelection: selected.draftSelection, draftSelectionRevision: selected.draftSelectionRevision,
          snapshot: { messages: [], tools: [], status: 'idle', workOnly: true } };
      } catch (error) {
        if (storage && planned) await Promise.resolve().then(() => storage.abandonArchive(app, planned)).catch(() => {});
        if (created) { removeOwnedDraft(created, captured.owner); removeReservedSelection(app, created, captured.owner, selection); }
        if (memory) {
          try {
            const stat = fs.lstatSync(memory.file);
            if (!stat.isSymbolicLink() && stat.dev === memory.stat.dev && stat.ino === memory.stat.ino &&
                fs.readFileSync(memory.file).equals(memory.bytes)) fs.unlinkSync(memory.file);
          } catch (_) { /* Keep another writer's replacement intact. */ }
        }
        throw error;
      }
    });
  }
  async function read(rawId) {
    return attempt(async () => {
      const id = sessionId(rawId), captured = await auth();
      const row = await resolve(id, captured), record = await diskRecord(app, id);
      owner(record, captured); await guard(captured);
      const latest = row.workOnly ? await resolve(id, captured) : row;
      const cards = (record?.cards || []).map(card => restoredRequirementCard(card, captured));
      await guard(captured);
      const workOnly = draftOnly(id, latest);
      return { ok: true, cards, presence: publicPresence({ ...latest, workOnly }), workOnly,
        draftSelection: workOnly ? record?.draftSelection || null : null,
        draftSelectionRevision: workOnly ? record?.draftSelectionRevision || 0 : 0 };
    });
  }
  async function save(rawId, value) {
    return attempt(async () => {
      const id = sessionId(rawId), captured = await auth(), card = normalizeCard(value), file = location(app, id);
      return serial(file, async () => {
        const row = await resolve(id, captured), previous = await diskRecord(app, id);
        owner(previous, captured);
        const cards = previous?.cards.slice() || [], index = cards.findIndex(item => item.id === card.id);
        const before = index < 0 ? null : cards[index];
        if (card.revision !== undefined && card.revision !== (before?.revision || 0)) throw Error('表单已在其他窗口更新，请重新打开后继续编辑');
        if (index < 0 && cards.length >= MAX_CARDS) throw Error('本会话已保存 100 张工作表单，请新建会话');
        const at = Math.max(Date.now(), Number(before?.updatedAt || 0) + 1);
        const saved = { ...card, revision: (before?.revision || 0) + 1, createdAt: before?.createdAt || at, updatedAt: at };
        if (index < 0) cards.push(saved); else cards[index] = saved;
        await writeRecord(id, captured, { version: 1, sessionId: id, owner: captured.owner, cards,
          ...(previous?.draftSelection ? { draftSelection: previous.draftSelection,
            draftSelectionRevision: previous.draftSelectionRevision } : {}) });
        notify({ kind: 'work-card-saved', sessionId: id, ref: '', cardId: saved.id, revision: saved.revision,
          presence: { ...publicPresence(row), at } });
        return { ok: true, card: saved };
      });
    });
  }
  async function saveDraftSelection(rawId, value) {
    return attempt(async () => {
      const id = sessionId(rawId), captured = await auth();
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).some(key => !['selection', 'revision'].includes(key)) ||
          !Number.isSafeInteger(value.revision) || value.revision < 0) throw Error('草稿执行选项版本无效');
      const selected = normalizeDraftSelection(value.selection);
      return serial(location(app, id), async () => {
        const row = await resolve(id, captured), previous = await diskRecord(app, id);
        owner(previous, captured); assertDraftOnly(id, row);
        if (value.revision !== (previous?.draftSelectionRevision || 0))
          throw Object.assign(Error('执行选项已在其他窗口更新，请重新打开会话后选择'), { code: 'STALE_DRAFT_SELECTION' });
        const revision = value.revision + 1;
        await writeRecord(id, captured, { version: 1, sessionId: id, owner: captured.owner,
          cards: previous?.cards || [], draftSelection: selected, draftSelectionRevision: revision }, async (key, actor) => {
          const latest = await resolve(key, actor); assertDraftOnly(key, latest); return latest;
        });
        return { ok: true, draftSelection: selected, draftSelectionRevision: revision };
      });
    });
  }
  async function findTaskCreation(rawTaskId) {
    return attempt(async () => {
      const taskId = sessionId(rawTaskId), captured = await auth();
      let files;
      try { files = await fsp.readdir(directory(app), { withFileTypes: true }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
      for (const file of files) {
        if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
        const target = path.join(directory(app), file.name), stat = await fsp.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) continue;
        const row = JSON.parse(await fsp.readFile(target, 'utf8'));
        if (row.version !== 1 || typeof row.sessionId !== 'string' ||
            location(app, row.sessionId) !== target || !Array.isArray(row.cards) ||
            !scopeMatches(row.owner, captured.identity, accountCandidates(app))) continue;
        if (!row.cards.some(card => card.actionId === 'work.requirement.create' &&
            card.state?.phase === 'succeeded' && card.state.receipt?.id === taskId && !card.state.receipt.gone)) continue;
        // A saved creation receipt is provenance, not proof that its archive still exists.
        const live = session.findBySessionId?.(row.sessionId);
        const archive = live || await session.archivedConversation(app, row.sessionId);
        if (!archive) continue;
        await resolve(row.sessionId, captured);
        return { ok: true, sessionId: row.sessionId };
      }
      await guard(captured);
      return { ok: true, sessionId: '' };
    });
  }
  return { reserve, read, save, saveDraftSelection, findTaskCreation };
}
function install({ ipcMain, BrowserWindow, ...options }) {
  const controller = create({ ...options, notify: event => {
    for (const win of BrowserWindow?.getAllWindows?.() || []) {
      try { if (!win.isDestroyed()) win.webContents.send('pi-session-event', event); } catch (_) { /* Recover state on the next read if the window is closing. */ }
    }
  } });
  for (const [channel, method] of [['pi-session-reserve-work', 'reserve'], ['pi-session-work-cards', 'read'],
    ['pi-session-save-work-card', 'save'], ['pi-session-save-work-draft-selection', 'saveDraftSelection'],
    ['pi-session-find-task-creation', 'findTaskCreation']]) {
    ipcMain.handle(channel, (event, ...args) => require('../access-control/preferences').isTrusted(event)
      ? controller[method](...args) : { ok: false, reason: '请在 SoduWork 工作区中操作工作表单' });
  }
  return controller;
}
module.exports = { create, install, normalizeCard, visibleHistory, assertCreatedTask, location, ENTRY_TYPE, MAX_FILES, MAX_FILE_BYTES, MAX_STORE_BYTES };
