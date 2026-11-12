'use strict';

// This module coordinates ownership transfer. Hub's existing task dispatcher
// remains the only cloud executor; there is no second conversation queue here.
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const durableFiles = require('../verified-file-replace.cjs');
const portable = require('./portable-workspace-worker');
const { connectionScope: scope } = require('../platform-connections/runtime.cjs');
const { fetchWithDeviceAuthRetry } = require('../device-auth-request');
const { previewPath } = require('../pi-session/attachment-contract');
const liveOutput = require('./task-live-output');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const outputCache = require('./cloud-output-cache');
const safeOutputName = outputCache.safeName;
const outputAttachmentRows = outputCache.rows;

function serviceInfo(identity) {
  let host = '';
  try { host = new URL(identity.hub).hostname.toLowerCase(); } catch (_) { /* identity is validated by the connection layer */ }
  return { local: ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) };
}

function serviceUrlFromPage(items) {
  for (const item of [...(items || [])].reverse()) {
    if (!item || typeof item !== 'object') continue;
    const values = [item.previewUrl, item.serviceUrl,
      ...(Array.isArray(item.services) ? item.services.flatMap(service => [service?.previewUrl, service?.url]) : [])];
    for (const value of values) {
      const url = String(value || '').trim();
      if (/^https?:\/\//i.test(url)) return url.slice(0, 600);
    }
    const host = String(item.host || '').trim();
    const port = Number(item.port);
    if (host && Number.isInteger(port) && port > 0 && port < 65536 &&
        /^[a-z0-9][a-z0-9._:-]{0,252}$/i.test(host)) {
      return 'http://' + host + ':' + port + '/';
    }
  }
  return '';
}

async function http(identity, route, options = {}) {
  const response = await fetchWithDeviceAuthRetry(identity,
    String(identity.hub).replace(/\/+$/, '') + '/api/v1' + route, {
      redirect: 'error', signal: AbortSignal.timeout(options.body instanceof FormData ? 120000 : 30000),
      ...options,
    });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = Error(typeof data.detail === 'string' ? data.detail : data.error || '云端交接请求失败，请重试');
    error.status = response.status; error.delivery = data.delivery; error.messageId = data.messageId; throw error;
  }
  return data;
}

function source(handle) {
  const snapshot = handle.snapshot();
  const goal = typeof handle.goalView === 'function' ? handle.goalView() : handle.goal;
  return { sessionId: handle.sessionId, adapterId: handle.adapterId,
    title: handle.historyRow?.()?.title || '云端会话',
    modelName: snapshot.modelSelection?.name || '',
    goal: typeof goal === 'string' ? goal : String(goal?.goal || ''), messages: snapshot.messages || [] };
}

function assertPortable(handle) {
  const snapshot = handle.snapshot();
  if (snapshot.runtimeSwitching) throw Error('正在切换 Agent，请稍后再转到云端');
  const queue = snapshot.queue || snapshot.execution?.queue || [];
  if (queue.length || snapshot.queued) throw Error('请先处理排队中的消息，再转到云端');
  if (snapshot.pendingUi || snapshot.pendingPermissions?.length) throw Error('请先处理当前授权或确认请求，再转到云端');
  if (handle.pluginDebug || handle.ui?.selectedSkills?.length || snapshot.activePlugins?.length ||
      snapshot.messages?.some(row => row.plugins?.length)) {
    throw Error('本会话使用了本机插件或指定技能，请先在云端配置同等能力；当前不能直接交接');
  }
  // Absolute input paths are not portable. Never pretend an attachment moved
  // just because its display name survived in the conversation transcript.
  for (const item of [...(handle.ui?.inputAttachments || []),
    ...(snapshot.messages || []).flatMap(row => row.attachments || [])]) {
    const file = item.path || previewPath(item.previewRef);
    if (!file) continue;
    const relative = path.relative(handle.cwd, path.resolve(handle.cwd, file));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw Error('附件位于工作目录之外，请先将所需附件放入当前工作目录后再交接');
    }
  }
}

function create({ app, identityOf, request = http, workspace = portable, notify = () => {}, validateHandle = () => {},
  wait = sleep, stopTimeout = 45000, interval = 1800, remoteDirectory = false,
  discovery = require('../native-discovery.cjs'), syncOptions = {} }) {
  const root = path.join(app.getPath('userData'), 'conversation-handoffs');
  const previews = new Map(), records = new Map(), remoteRecords = new Map(), watches = new WeakMap(), operations = new Map(), writes = new Map();
  const taskViews = new Map();
  const taskExecution = require('./task-execution-view');
  let remoteDirectoryPromise = null, remoteDirectoryAt = 0, remoteDirectoryScope = '';
  const remoteDirectoryTtl = 5000, remoteDirectoryPageSize = 100, remoteDirectoryMaxPages = 20;
  const previewRevisions = new Map();
  const pendingViews = new Set();
  const protectedHandles = new WeakSet();
  const file = id => path.join(root, digest(String(id)) + '.json');
  function readReceipt(id) {
    if (records.has(id)) return records.get(id);
    let record;
    try { record = JSON.parse(syncFs.readFileSync(file(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw Error('云端交接记录无法读取，已阻止在本地重复执行'); }
    if (record.sessionId !== id || !record.transferId || !record.owner) throw Error('云端交接记录损坏，请检查数据目录');
    records.set(id, record); return record;
  }
  function read(id) {
    const record = readReceipt(id) || taskViews.get(id) || remoteRecords.get(id) || null;
    const review = record && [...remoteRecords.values()].find(row => row.taskId === record.taskId &&
      row.owner === record.owner && row.conversationReview);
    return review ? { ...record, title: review.title, conversationReview: review.conversationReview } : record;
  }
  function save(record) {
    const id = record.sessionId, previous = records.get(id);
    // A cross-device row is a cache of Hub metadata, never a second durable
    // execution receipt. Its transcript is recovered through ai-session.
    if (record.remoteProjection) {
      (record.taskExecutionView ? taskViews : remoteRecords).set(id, record);
      return Promise.resolve(record);
    }
    // Publish the current revision before another async poll/send reads it,
    // then serialize disk writes. Polling must never erase a pending send ID.
    // A snapshot prepared before deletion must not restore a hidden history row.
    if (previous?.hidden && !record.hidden) record = { ...record, hidden: true };
    records.set(id, record);
    const job = (writes.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await durableFiles.writeFile(file(id), JSON.stringify(record), { mode: 0o600, flush: true });
    }).catch(error => {
      if (records.get(id) === record) { if (previous) records.set(id, previous); else records.delete(id); }
      throw error;
    }).finally(() => { if (writes.get(id) === job) writes.delete(id); });
    writes.set(id, job); return job;
  }
  const cache = outputCache.create({ app });
  const materializations = new Map();
  async function materializeOutputs(record, current, taskRows, options) {
    const id = record.sessionId;
    const job = (materializations.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      const assertCurrent = async () => {
        const latest = read(id);
        if (!latest || latest.owner !== record.owner || latest.taskId !== record.taskId ||
            latest.transferId !== record.transferId || latest.phase !== 'committed') throw Error('云端成果归属已变化');
        await identity(latest);
      };
      await assertCurrent();
      const latest = read(id);
      const result = await cache.materialize(latest, current, taskRows, assertCurrent, options);
      // Polls, sends and materialization share one durable receipt. Never save
      // an earlier copy over a concurrently acknowledged cloud message.
      const next = read(id);
      if (result.files || next.resultCwd) await save({ ...next, resultCwd: result.cwd,
        materializedOutputs: result.materializedOutputs });
      return result;
    }).finally(() => { if (materializations.get(id) === job) materializations.delete(id); });
    materializations.set(id, job); return job;
  }
  async function artifactSession(handle) {
    const record = guard(handle);
    if (!record) return handle;
    const current = await identity(record);
    if (record.phase !== 'committed') throw Error('云端交接尚未完成');
    const facade = Object.create(handle);
    Object.defineProperty(facade, 'cwd', { value: outputCache.directory(app, record) });
    facade.cloudArtifactCache = true;
    facade.deliveryOwner = require('../platform-connections/runtime.cjs').scope(current);
    facade.outputSnapshot = () => outputCache.index(app, read(record.sessionId));
    facade.outputSnapshotAsync = () => outputCache.indexAsync(app, read(record.sessionId));
    facade.outputs = () => facade.outputSnapshot().files;
    return facade;
  }
  async function materialize(handle, input) {
    const record = guard(handle);
    if (!record || record.phase !== 'committed' || input.taskId !== record.taskId || !input.attachmentId) {
      throw Error('这份云端成果不属于当前会话');
    }
    const current = await identity(record);
    const attachments = await request(current, '/tasks/' + encodeURIComponent(record.taskId) + '/attachments');
    if (!outputAttachmentRows(attachments, record.taskId).some(row => String(row.id) === String(input.attachmentId))) {
      throw Error('这份成果已更新或暂时不可用，请刷新后重试');
    }
    await materializeOutputs(record, current, attachments, { previewOnly: input.previewOnly === true });
    const projected = await artifactSession(handle);
    const files = (await projected.outputSnapshotAsync()).files;
    const file = files.find(row => row.remoteAttachmentId === String(input.attachmentId));
    if (!file) throw Error('云端成果未完整保存，请重试');
    notify(handle, { kind: 'settled' });
    return { ok: true, artifact: file, artifacts: files };
  }
  async function identity(record, handle) {
    const value = await identityOf(app);
    if (!value) throw Error('请先连接 SoduWork 服务并登录');
    if (record && record.owner !== scope(value) &&
        (!record.syncOwner || record.syncOwner !== require('./cloud-execution-sync').scope(value)))
      throw Error('这条云端会话属于其他账号或服务，请切回原连接');
    if (handle) await validateHandle(handle, value);
    return value;
  }
  function publicRecord(record) {
    if (!record) return null;
    return { transferId: record.transferId, phase: record.phase, entryKind: record.entryKind || 'handoff', taskId: record.taskId || '',
      ref: record.ref || '', target: record.target || null, error: record.error || '',
      accepted: Boolean(record.accepted), acceptedAt: record.acceptedAt || '',
      canAbort: record.canAbort === undefined ? !record.accepted && ['preparing', 'uploading', 'prepared'].includes(record.phase) : record.canAbort === true,
      pendingApprovals: (record.cloudApprovals || []).length, pendingMessages: (record.cloudMessages || []).length,
      historyGap: record.syncSnapshot?.historyGap || (record.syncRecovery?.historyGap ? { reason: 'local-cache-recovery' } : null),
      outputPending: Boolean(record.syncArtifactsPending), outputError: record.syncArtifactError || '',
      // A cloud runner can produce a reachable URL without uploading a file
      // (for example a preview server, PR, or deployment). Keep it on the
      // durable handoff so reopened conversations can render the same result.
      artifactUrl: record.artifactUrl || '', ...(record.codeDelivery ? { codeDelivery: record.codeDelivery, deliveryMode: 'git' } : {}) };
  }
  const route = record => '/conversation-handoffs/' + encodeURIComponent(record.transferId);
  const cloudStart = require('./cloud-start').create({ app, root, read, save, identity, request, publicRecord });

  function remoteSaved(row, adapterId, model) {
    const displayName = String(row.displayName || row.target?.runnerName || adapterId || 'Cloud').slice(0, 120);
    return { cwd: '', adapterId, model,
      snapshot: { messages: [], tools: [], pendingUser: null, adapterId, displayName,
        modelSelection: { name: model, model: { id: model, name: model, label: model || 'default' } },
        execution: { cloud: true }, status: 'idle' } };
  }
  function remoteRecord(row, current) {
    const taskId = String(row.taskId || '').trim();
    if (!taskId) return null;
    const sessionId = String(row.sessionId || row.id || ('cloud-task:' + taskId)).trim();
    const adapterId = String(row.adapterId || row.target?.agentId || 'pi').trim();
    const model = String(row.model || row.target?.model || '').trim();
    const rawState = String(row.remoteState || row.state || 'queued').trim();
    const remoteState = ['running', 'queued', 'dispatching', 'done', 'completed', 'failed', 'stopped'].includes(rawState)
      ? rawState : 'queued';
    const numericAt = Number(row.at);
    return { sessionId, transferId: 'remote:' + taskId, owner: scope(current), entryKind: 'cloud',
      remoteProjection: true, phase: 'committed', title: String(row.title || 'Cloud conversation').slice(0, 200),
      at: Number.isFinite(numericAt) ? numericAt : Date.parse(row.at) || 0,
      taskId, ref: String(row.ref || '').trim(), adapterId, remoteState,
      conversationReview: row.conversationReview || null,
      target: row.target || null, options: { model }, activeExecutionSelection: row.activeExecutionSelection || null,
      workflowKnown: row.workflow === false || row.workflow === true,
      workflow: row.workflow === true,
      canContinue: row.canContinue === true, canSend: row.canSend === true,
      saved: remoteSaved(row, adapterId, model) };
  }
  async function refreshRemoteDirectory({ force = false } = {}) {
    if (!remoteDirectory) return [];
    if (remoteDirectoryPromise) return remoteDirectoryPromise;
    const current = await identity();
    const currentScope = scope(current);
    if (!force && currentScope === remoteDirectoryScope && Date.now() - remoteDirectoryAt < remoteDirectoryTtl) {
      return [...remoteRecords.values()];
    }
    const load = (async () => {
      const rows = [];
      let cursor = '';
      for (let page = 0; page < remoteDirectoryMaxPages; page += 1) {
        const query = '?limit=' + remoteDirectoryPageSize + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
        const reply = await request(current, '/cloud-conversations' + query);
        if (Array.isArray(reply?.chats)) rows.push(...reply.chats);
        const next = String(reply?.nextCursor || '');
        if (!reply?.hasMore || !next || next === cursor) break;
        cursor = next;
      }
      const nextRecords = new Map();
      for (const row of rows) {
        const record = remoteRecord(row, current);
        if (record && record.owner === scope(current)) nextRecords.set(record.sessionId, record);
      }
      remoteRecords.clear();
      for (const [id, record] of nextRecords) remoteRecords.set(id, record);
      remoteDirectoryAt = Date.now();
      remoteDirectoryScope = currentScope;
      return [...nextRecords.values()];
    })();
    remoteDirectoryPromise = load;
    try { return await load; }
    finally { if (remoteDirectoryPromise === load) remoteDirectoryPromise = null; }
  }
  function remoteHistoryRow(record) {
    return { id: record.sessionId, title: record.title, at: record.at, cwd: '',
      workspaceName: record.target?.runnerKind === 'work-computer' ? 'work computer' : 'cloud',
      workspaceLabel: record.target?.runnerName || record.target?.host || 'cloud',
      locationMode: 'remote', location: record.target?.runnerKind || 'cloud',
      adapterId: record.adapterId, taskId: record.taskId, state: record.remoteState,
      ref: record.ref, owner: record.owner, workflowKnown: record.workflowKnown,
      workflow: record.workflow,
      cloud: true, remoteProjection: true, canSend: record.canSend === true,
      readOnly: record.canSend !== true };
  }
  async function history({ includeAliases = false } = {}) {
    const hiddenTasks = new Set();
    const local = await cloudStart.history(hiddenTasks);
    if (!remoteDirectory) return local;
    let remote;
    try { remote = await refreshRemoteDirectory(); }
    catch (_) { return local; }
    const seen = new Set((local.chats || []).map(row => row.id));
    // A persisted sync receipt has a device-local ID but represents the same
    // Hub task as the directory entry. Keep its replayable history entry.
    const tasks = new Set((local.chats || []).map(row => row.taskId).filter(Boolean));
    const cached = (local.chats || []).map(row => ({ ...row,
      ...(remote.find(alias => alias.taskId === row.taskId && alias.conversationReview)
        ? { title: remote.find(alias => alias.taskId === row.taskId && alias.conversationReview).title } : {}),
      historyAliasIds: remote.filter(alias => alias.taskId && alias.taskId === row.taskId &&
        alias.sessionId !== row.id).map(alias => alias.sessionId) }));
    return { ok: true, chats: [...cached, ...remote.filter(row =>
      !hiddenTasks.has(row.taskId) && !seen.has(row.sessionId) && (includeAliases || !tasks.has(row.taskId))).map(remoteHistoryRow)] };
  }
  const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function cleanSnapshot(record) {
    const suffixes = record.phase === 'aborted' ? ['.zip', '.view.json'] : ['.zip'];
    for (const suffix of suffixes) await fs.unlink(path.join(root, record.transferId + suffix)).catch(error => {
      if (error.code !== 'ENOENT') console.warn('[cloud-handoff] snapshot cleanup:', error.code);
    });
  }
  async function stopLocal(handle) {
    if (!handle.inFlight?.()) return;
    const deadline = Date.now() + stopTimeout;
    const reason = '本地执行尚未停止，未启动云端任务，请确认停止后重试';
    let timer;
    try {
      // Some adapters wait for a process acknowledgement inside cancel(). That
      // promise needs the same deadline as the subsequent idle-state check.
      await Promise.race([Promise.resolve().then(() => handle.cancel()),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error(reason)), stopTimeout); })]);
      while (handle.inFlight?.()) {
        if (Date.now() >= deadline) throw Error(reason);
        await wait(Math.min(100, Math.max(1, deadline - Date.now())));
      }
    } finally { clearTimeout(timer); }
  }
  function guard(handle) {
    const record = read(handle.sessionId);
    return record && record.phase !== 'aborted' ? record : null;
  }
  function protect(handle) {
    if (protectedHandles.has(handle)) return;
    protectedHandles.add(handle);
    const methods = ['submit', 'continueGoal', 'disableGoal', 'selectAgent', 'selectModel', 'setThinkingMode', 'setAccessPolicy', 'updateQueue'];
    if (!handle.remoteContinuation) methods.push('send');
    for (const method of methods) {
      if (typeof handle[method] !== 'function') continue;
      const original = handle[method];
      handle[method] = function (...args) {
        if (guard(handle)) {
          const result = { ok: false, reason: '这条会话正在交接或在云端执行，已阻止本地重复运行' };
          return method === 'submit' ? { accepted: false, result } : result;
        }
        return original.apply(this, args);
      };
    }
  }
  function busy(handle, action) {
    if (operations.has(handle.sessionId)) return Promise.reject(Error('正在处理这条会话的云端交接，请稍候'));
    const promise = Promise.resolve().then(action).finally(() => operations.delete(handle.sessionId));
    operations.set(handle.sessionId, promise); return promise;
  }
  async function update(handle, record, receipt) {
    if (receipt.transferId !== record.transferId || receipt.sha256 && receipt.sha256 !== record.sha256) {
      throw Error('云端交接回执不匹配，已保留现场，请勿重复派活');
    }
    if (!['prepared', 'committing', 'committed', 'aborted'].includes(receipt.phase)) throw Error('云端交接状态无效');
    const next = { ...record, phase: receipt.phase, taskId: receipt.taskId || record.taskId,
      accepted: receipt.accepted === true || record.accepted === true, acceptedAt: receipt.acceptedAt || record.acceptedAt || '',
      canAbort: receipt.canAbort === true,
      ...(receipt.deliveryMode === 'git' ? { deliveryPresentation: 'summary', codeDelivery: receipt.codeDelivery || { kind: 'git' } } : {}),
      ref: receipt.ref || record.ref, target: { ...record.target, ...receipt.target }, error: receipt.error || '' };
    await save(next);
    if (['prepared', 'committed', 'aborted'].includes(next.phase)) {
      await cleanSnapshot(next);
    }
    if (next.phase === 'committed') {
      const bound = await handle.bindTask(next.taskId, record.title);
      if (bound?.ok === false) throw Error(bound.reason || '云端已接收，但本地关联未保存，请重试恢复');
      observe(handle);
    }
    notify(handle, { kind: 'cloud-handoff' }); return publicRecord(next);
  }
  async function preview(handle) {
    const revision = crypto.randomUUID();
    previewRevisions.set(handle.sessionId, revision);
    protect(handle);
    const old = guard(handle);
    if (old) { const current = await identity(old); return { ok: true, handoff: publicRecord(old), service: serviceInfo(current) }; }
    assertPortable(handle);
    const current = await identity(null, handle);
    const origin = source(handle), cwd = handle.cwd, agentId = origin.adapterId || 'pi';
    const [snapshot, matching] = await Promise.all([
      workspace.scan(cwd), request(current, '/conversation-handoffs/targets?agentId=' + encodeURIComponent(agentId)),
    ]);
    let targets = matching, fallback = null;
    if (!matching.targets?.length && agentId !== 'pi') {
      const pi = await request(current, '/conversation-handoffs/targets?agentId=pi');
      if (pi.targets?.length && pi.handoffCapabilities?.piFallback === true) {
        targets = pi; fallback = { fromAgentId: agentId, toAgentId: 'pi' };
      } else if (pi.targets?.length) {
        targets = { ...matching, diagnostics: { ...matching.diagnostics,
          summary: '当前后台暂不支持确认后改用 Pi，请更新后台后重试；本地执行不受影响。' } };
      }
    }
    if (guard(handle) || handle.cwd !== cwd || source(handle).adapterId !== origin.adapterId ||
        source(handle).modelName !== origin.modelName || scope(await identity(null, handle)) !== scope(current)) {
      throw Error('会话或连接已变化，请重新检查交接');
    }
    assertPortable(handle);
    if (previewRevisions.get(handle.sessionId) !== revision) throw Error('已有更新的交接预览，请使用当前弹框继续');
    const model = fallback || targets.targets?.[0]?.modelMode === 'account' ? '' : origin.modelName;
    const token = crypto.randomUUID();
    previews.set(handle.sessionId, { token, owner: scope(current), expires: Date.now() + 5 * 60000,
      files: digest(JSON.stringify(snapshot.files.map(x => [x.path, x.size]))),
      targets: targets.targets || [], agentId: fallback ? 'pi' : agentId,
      origin: { adapterId: origin.adapterId, modelName: origin.modelName }, cwd, fallback, model });
    return { ok: true, previewId: token, files: snapshot.files.map(x => ({ path: x.path, size: x.size })),
      excluded: snapshot.excluded, total: snapshot.total, targets: targets.targets || [],
      diagnostics: targets.diagnostics, selection: targets.selection, service: serviceInfo(current),
      fallback, model, source: { title: origin.title, modelName: origin.modelName, agentId },
      running: Boolean(handle.inFlight?.()) };
  }
  async function commit(handle, record) {
    // Persist the fence before a request that can start remote execution.
    await save({ ...record, phase: 'committing', error: '' });
    const receipt = await request(await identity(record), route(record) + '/commit', json({ sha256: record.sha256 }));
    return update(handle, read(handle.sessionId), receipt);
  }
  function confirm(handle, input) {
    return busy(handle, async () => {
      if (guard(handle)) throw Error('已有交接记录，请恢复原交接，避免重复执行');
      const reviewed = previews.get(handle.sessionId), current = await identity(null, handle);
      if (!reviewed || reviewed.token !== input.previewId || reviewed.expires < Date.now() || reviewed.owner !== scope(current)) {
        throw Error('交接预览已过期，请重新检查文件');
      }
      const origin = source(handle);
      if (origin.adapterId !== reviewed.origin.adapterId || origin.modelName !== reviewed.origin.modelName || handle.cwd !== reviewed.cwd) {
        throw Error('Agent、模型或工作目录已变化，请重新检查交接');
      }
      const consent = input.agentFallback;
      if (reviewed.fallback ? (!consent || consent.accepted !== true ||
          consent.fromAgentId !== reviewed.fallback.fromAgentId || consent.toAgentId !== 'pi' ||
          Object.keys(consent).some(key => !['fromAgentId', 'toAgentId', 'accepted'].includes(key))) : consent != null) {
        throw Error('请先确认是否改用 Pi，再转到云端');
      }
      // The Hub chooses from current live capacity at preparation time. A
      // preview is advisory, never a client-side reservation or a default host.
      const target = input.assigneeId ? reviewed.targets.find(row => row.id === input.assigneeId) : null;
      if (input.assigneeId && !target) throw Error('云端执行机已不可用，请重新检查');
      if (!reviewed.targets.length) throw Error('当前没有兼容且可用的云端服务器，请先配置云端环境');
      const instruction = String(input.instruction || '').trim();
      if (!instruction || instruction.length > 16000) throw Error('请填写 1 到 16000 字的继续执行说明');
      assertPortable(handle);
      let record = { sessionId: handle.sessionId, transferId: crypto.randomUUID(), owner: scope(current),
        phase: 'preparing', title: source(handle).title, target, ref: '', taskId: '',
        options: { ...(target ? { assigneeId: target.id } : { agentId: reviewed.agentId }), model: reviewed.model, instruction,
          ...(reviewed.fallback ? { agentFallback: { ...reviewed.fallback, accepted: true } } : {}),
          requiredSkills: [], personalPlugins: [] } };
      let uploadIssued = false;
      await save(record); notify(handle, { kind: 'cloud-handoff' });
      try {
        await identity(record, handle);
        await stopLocal(handle);
        assertPortable(handle);
        const stopped = source(handle);
        if (stopped.adapterId !== reviewed.origin.adapterId || stopped.modelName !== reviewed.origin.modelName || handle.cwd !== reviewed.cwd) {
          throw Error('Agent、模型或工作目录已变化，请重新检查交接');
        }
        const snapshot = await workspace.create(handle.cwd, source(handle));
        if (reviewed.files !== digest(JSON.stringify(snapshot.manifest.files.map(x => [x.path, x.size])))) {
          throw Error('工作文件已变化，请重新检查交接文件');
        }
        record = { ...record, sha256: snapshot.sha256, phase: 'uploading' };
        // Preserve the public view before any cloud output is appended. This
        // stays local and allows a later reopen without the original runtime.
        await durableFiles.writeFile(path.join(root, record.transferId + '.view.json'), JSON.stringify({
          cwd: handle.cwd, adapterId: handle.adapterId, snapshot: handle.snapshot(),
          model: { id: snapshot.manifest.source.modelName },
        }), { flag: 'wx', mode: 0o600, flush: true });
        await fs.writeFile(path.join(root, record.transferId + '.zip'), snapshot.bytes, { flag: 'wx', mode: 0o600 });
        await save(record);
        const form = new FormData(); form.set('file', new Blob([snapshot.bytes], { type: 'application/zip' }), 'workspace.zip');
        form.set('options', JSON.stringify({ ...record.options, sha256: record.sha256 }));
        const uploadIdentity = await identity(record, handle);
        uploadIssued = true;
        const receipt = await request(uploadIdentity, route(record), { method: 'POST', body: form });
        await update(handle, record, receipt);
        if (receipt.phase === 'aborted') return { ok: true, handoff: publicRecord(read(handle.sessionId)) };
        return { ok: true, handoff: await commit(handle, read(handle.sessionId)) };
      } catch (error) {
        const latest = read(handle.sessionId);
        const failed = { ...latest, phase: uploadIssued ? latest.phase : 'aborted', error: String(error.message || error) };
        await save(failed);
        if (!uploadIssued) await cleanSnapshot(failed);
        notify(handle, { kind: 'cloud-handoff' }); throw error;
      }
    });
  }
  function recover(handle) {
    return busy(handle, async () => {
      const record = guard(handle); if (!record) return { ok: true, handoff: null };
      const current = await identity(record);
      if (record.syncId) {
        await synchronization.tick();
        return { ok: true, handoff: publicRecord(read(handle.sessionId)) };
      }
      if (record.entryKind === 'cloud' && record.phase !== 'committed') {
        const result = await cloudStart.retry(record);
        if (result.ok) observe(handle);
        return result;
      }
      // A crash before upload cannot have started a cloud task.
      if (record.phase === 'preparing') return { ok: true, handoff: await abortRecord(handle, record) };
      const receipt = await request(current, route(record));
      await update(handle, record, receipt);
      return { ok: true, handoff: receipt.phase === 'prepared' || receipt.phase === 'committing'
        ? await commit(handle, read(handle.sessionId)) : publicRecord(read(handle.sessionId)) };
    });
  }
  async function abortRecord(handle, record) {
    if (record.phase === 'preparing') {
      const aborted = { ...record, phase: 'aborted', error: '' };
      await save(aborted); await cleanSnapshot(aborted); notify(handle, { kind: 'cloud-handoff' });
      return publicRecord(read(handle.sessionId));
    }
    const receipt = await request(await identity(record), route(record) + '/abort', json({}));
    return update(handle, record, receipt);
  }
  function abort(handle) { return busy(handle, async () => {
    const record = guard(handle); if (!record) return { ok: true, handoff: null };
    await identity(record);
    return { ok: true, handoff: await abortRecord(handle, record) };
  }); }

  function view(handle, snapshot) {
    const record = guard(handle); if (!record) return snapshot;
    const watch = watches.get(handle), remote = watch?.state || record.syncSnapshot;
    const handoff = publicRecord(record);
    // Older handoff records predate the reachable-host field. The session API
    // still carries the runner host, so enrich the live view without rewriting
    // the durable handoff record.
    if (handoff?.target && !handoff.target.host && remote?.host) {
      handoff.target = { ...handoff.target, host: String(remote.host).slice(0, 200) };
    }
    const adapterId = executionSelection.active(record).agentId || snapshot?.adapterId;
    const target = require('../agent-runtime/runtime-catalog').runtime(adapterId);
    const selected = executionSelection.active(record);
    const model = selected.modelName || '';
    const artifactUrl = String(record.artifactUrl || watch?.artifactUrl || snapshot?.execution?.artifactUrl || snapshot?.artifactUrl || '').trim();
    const cachedDelivery = record.syncState?.ref === record.ref && Number.isSafeInteger(remote?.persistedThrough) &&
      record.syncState.cursor >= remote.persistedThrough && record.syncArtifactsPending === false;
    return { ...snapshot, ...(artifactUrl ? { artifactUrl } : {}),
      ...(record.codeDelivery ? { codeDelivery: record.codeDelivery, deliveryMode: 'git' } : {}), cloudHandoff: handoff,
      ...(record.phase === 'committed' ? {
        // A remote final message precedes attachment collection and local
        // materialization. Only the completed, fully collected turn can add
        // a new desktop delivery card; historical cards remain visible.
        deliveryPending: !remote || !['done', 'completed'].includes(remote.status) || Boolean(watch?.more || remote.historyGap) ||
          (!cachedDelivery && (!watch || watch.artifactsKey !== record.ref + ':' + remote.status + ':' + watch.cursor)),
        adapterId, displayName: target?.displayName || adapterId,
        executionSelectionPending: Boolean(record.pendingExecutionSelection),
        modelSelection: { name: model, model: { id: model, name: model, label: model || '执行机默认模型' } },
        status: ['running', 'queued', 'dispatching'].includes(remote?.status) ? 'streaming'
          : remote?.status === 'failed' ? 'error' : 'idle',
        statusText: watch?.error || (record.syncArtifactError ? require('./cloud-execution-sync').ARTIFACT_RETRY_MESSAGE : '') ||
          (remote?.historyGap ? require('./cloud-execution-sync').HISTORY_GAP_MESSAGE : '') ||
          ((record.cloudMessages || []).length ? '消息已保存，正在等待执行机确认，请勿重复发送。' : ''),
        queue: [], queued: 0, pendingUi: null, pendingPermissions: [],
        cloudApprovals: record.cloudApprovals || [],
        cloudMessages: record.cloudMessages || [],
        accessControl: { ...snapshot.accessControl, supported: false, canChangeDuringSession: false },
        execution: { ...require('./cloud-timing').project(remote), ...(artifactUrl ? { artifactUrl } : {}), running: ['running', 'queued', 'dispatching'].includes(remote?.status), stopped: remote?.status === 'stopped', queue: [],
          configured: false, visible: false, quality: null, harness: null,
          cloud: true, taskId: record.taskId, runId: record.ref },
      } : {}) };
  }
  async function refreshTaskExecution(sessionId, live = false) {
    if (!taskExecution.taskId(sessionId)) return null;
    const previous = taskViews.get(sessionId);
    const current = await identity(previous);
    const row = await taskExecution.resolve(sessionId, current, request);
    const record = { ...remoteRecord(row, current), taskExecutionView: true,
      transferId: 'task-execution:' + row.taskId + ':' + row.ref };
    await identity(record);
    if (live && previous && previous.ref !== record.ref) {
      throw Error('需求已有新的执行记录，请关闭原会话后重新打开');
    }
    // Directory refreshes cannot discard an explicitly opened requirement.
    taskViews.set(sessionId, { ...(previous?.ref === record.ref ? previous : {}), ...record });
    return taskViews.get(sessionId);
  }
  async function historyEntry(sessionId) {
    // Work cards restore before a runtime opens. Formal requirements are not
    // ordinary cloud-directory entries, so resolve their authority by ID.
    const record = await refreshTaskExecution(sessionId);
    return record ? remoteHistoryRow(record) : null;
  }
  async function reopen(sessionId, ref) {
    // A known task projection fails closed: never fall back to a local runtime.
    await refreshTaskExecution(sessionId);
    let record = read(sessionId);
    if (!record && remoteDirectory) {
      // Directory discovery is optional for an unknown local archive. Its
      // caller still verifies persisted ownership before resuming locally.
      // Known transfers never take this fallback and remain fail-closed.
      try { await refreshRemoteDirectory({ force: true }); }
      catch (_) { return null; }
      record = remoteRecords.get(String(sessionId || ''));
    }
    if (!record || record.phase === 'aborted') return null;
    await identity(record);
    if (record.remoteProjection) {
      const saved = record.saved || remoteSaved(record, record.adapterId, record.options?.model || '');
      let handle;
      handle = await require('./cloud-conversation-view').create({ app, ref, record, saved,
        recordOf: () => read(record.sessionId), artifactDirectory: () => outputCache.directory(app, read(record.sessionId)),
        // The projection never executes locally. These callbacks append a
        // turn to the existing Hub task, so a desktop can continue a cloud
        // conversation started by mobile/Web while the Runner stays pinned.
        sendRemote: record.canSend === true
          ? (view, text, attachments, options) => send(view, text, attachments, options) : undefined,
        stopRemote: record.canSend === true ? view => stop(view) : undefined });
      observe(handle); return handle;
    }
    // No upload can be issued before this durable phase advances. A crashed
    // preparation therefore has no remote owner and may safely reopen locally.
    if (record.phase === 'preparing') {
      const aborted = { ...record, phase: 'aborted', error: '' };
      await save(aborted); await cleanSnapshot(aborted); return null;
    }
    if (!['uploading', 'prepared', 'committing', 'committed'].includes(record.phase)) {
      throw Error('云端交接状态无效，已阻止本地重复执行');
    }
    let saved;
    const savedPath = path.join(root, record.transferId + '.view.json');
    try {
      saved = JSON.parse(await fs.readFile(savedPath, 'utf8'));
      if (!Array.isArray(saved?.snapshot?.messages)) throw new SyntaxError('Invalid projection view');
    } catch (error) {
      if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error;
      if (!record.syncId) throw Error('云端会话的本地展示记录无法读取，请保留数据目录后重试');
      const captured = await identity(record);
      await projection.recoverCache(sessionId, captured, () => identity(record));
      record = read(sessionId);
      saved = JSON.parse(await fs.readFile(savedPath, 'utf8'));
      synchronization.wake();
    }
    if (!path.isAbsolute(saved.cwd || '') || !Array.isArray(saved.snapshot?.messages)) {
      throw Error('云端会话的本地展示记录无效，未启动新的本地执行');
    }
    const handle = await require('./cloud-conversation-view').create({ app, ref, record, saved,
      recordOf: () => read(record.sessionId), artifactDirectory: () => outputCache.directory(app, read(record.sessionId)) });
    if (record.phase !== 'committed') {
      const snapshot = handle.snapshot, close = handle.close;
      handle.snapshot = () => view(handle, snapshot());
      handle.close = (...args) => { pendingViews.delete(handle); return close(...args); };
      pendingViews.add(handle);
    }
    observe(handle); return handle;
  }
  function observe(handle) {
    protect(handle);
    if (watches.has(handle)) { watches.get(handle).wake(); return; }
    const record = guard(handle); if (!record || record.phase !== 'committed') return;
    outputCache.bind(handle, () => artifactSession(handle));
    // Keep the current desktop view pointed at the private cloud result
    // directory. The directory is deliberately separate from a handed-off
    // local workspace and is never returned as the session's working cwd.
    const output = liveOutput.create(handle, record.taskId, { includeUser: true });
    const watch = { timer: null, timerDue: 0, startedAt: -Infinity, retryAfter: 0,
      closed: false, pending: false, cursor: 0, state: null, error: '', artifactsKey: '', wakeUntil: 0, refreshRequested: false };
    const original = { close: handle.close, snapshot: handle.snapshot, uiSnapshot: handle.uiSnapshot,
      cancel: handle.cancel, selectModel: handle.selectModel, setAccessPolicy: handle.setAccessPolicy,
      outputs: handle.outputs, outputSnapshot: handle.outputSnapshot, outputSnapshotAsync: handle.outputSnapshotAsync };
    const locked = () => ({ ok: false, reason: '这条会话已在云端运行，执行配置由云端任务管理' });
    handle.snapshot = () => view(handle, original.snapshot.call(handle));
    if (original.uiSnapshot) handle.uiSnapshot = options => view(handle, original.uiSnapshot.call(handle, options));
    handle.selectModel = locked; handle.setAccessPolicy = locked;
    handle.outputs = () => outputCache.index(app, read(handle.sessionId)).files;
    handle.outputSnapshot = () => outputCache.index(app, read(handle.sessionId));
    handle.outputSnapshotAsync = () => outputCache.indexAsync(app, read(handle.sessionId));
    handle.cancel = record.remoteProjection && record.canSend !== true
      ? original.cancel : () => stop(handle);
    handle.close = function () { watch.closed = true; watch.stopPush?.(); clearTimeout(watch.timer); watches.delete(handle);
      handle.cancel = original.cancel; handle.outputs = original.outputs; handle.outputSnapshot = original.outputSnapshot;
      handle.outputSnapshotAsync = original.outputSnapshotAsync;
      return original.close.call(handle); };
    const pushConfirmed = () => watch.pushCapable && discovery.confirmed(watch.identity, 'cloud-execution-sync');
    function armPoll(delay, push = false) {
      if (watch.closed) return;
      const due = Math.max(Date.now() + delay, watch.retryAfter,
        push || pushConfirmed() ? watch.startedAt + 1000 : 0);
      if (watch.timer && watch.timerDue <= due) return;
      clearTimeout(watch.timer); watch.timerDue = due;
      watch.timer = setTimeout(poll, Math.max(0, due - Date.now())); watch.timer.unref?.();
    }
    async function poll() {
      clearTimeout(watch.timer); watch.timer = null; watch.timerDue = 0;
      if (watch.closed || watch.pending) return;
      if (handle.detached) { armPoll(interval * 3); return; }
      watch.startedAt = Date.now();
      watch.pending = true; watch.more = false;
      let collected = false;
      try {
        const live = guard(handle), current = await identity(live);
        watch.identity = current;
        watch.pushCapable = Boolean(live.syncId);
        const details = live.syncId ? await request(current, '/cloud-execution-sync/' + encodeURIComponent(live.syncId) +
          '?ref=' + encodeURIComponent(live.ref) + '&since=' + watch.cursor + '&limit=400') : null;
        const page = details ? details.page : await request(current, '/tasks/' + encodeURIComponent(live.taskId) + '/ai-session?ref=' +
          encodeURIComponent(live.ref) + '&since=' + watch.cursor + '&limit=400');
        await identity(live);
        if (!page) throw Error('云端执行记录尚未就绪，请稍后同步');
        if (page.ref && page.ref !== live.ref) throw Error('云端执行标识不一致，请核对任务');
        if (page.persistedThrough !== undefined && (!Number.isSafeInteger(page.last) || page.last > page.persistedThrough))
          throw Error('云端执行连续水位无效，请重新同步');
        if (watch.closed) return;
        watch.state = page; watch.error = '';
        if (details || (live.entryKind === 'cloud' && live.remoteState !== page.status) ||
            (page.activeExecutionSelection && JSON.stringify(live.activeExecutionSelection) !== JSON.stringify(page.activeExecutionSelection))) {
          // Reading execution state is not new conversation activity.
          await save({ ...read(handle.sessionId), remoteState: page.status,
            ...(details ? { cloudApprovals: details.approvals || [], cloudMessages: details.messages || [] } : {}),
            ...(page.activeExecutionSelection ? { activeExecutionSelection: page.activeExecutionSelection } : {}) });
        }
        const serviceUrl = serviceUrlFromPage(page.items);
        if (serviceUrl) watch.artifactUrl = serviceUrl;
        await output.consume(live.ref, page.items);
        watch.more = typeof page.hasMore === 'boolean' ? page.hasMore : page.items?.length >= 400 && Number(page.last) > watch.cursor;
        watch.cursor = Math.max(watch.cursor, Number(page.last || 0));
        const artifactsKey = live.ref + ':' + page.status + ':' + watch.cursor;
        if (['done', 'completed', 'failed', 'stopped'].includes(page.status) && !watch.more &&
            watch.artifactsKey !== artifactsKey) {
          // The existing status endpoint collects Runner files into authorized
          // task attachments. Reading the transcript alone never does that.
          const settled = details ? { artifactUrl: details.conversation?.artifactUrl } :
            await request(current, '/tasks/' + encodeURIComponent(live.taskId) + '/ai-status');
          await identity(live);
          if (settled?.deliveryKind === 'code' || read(handle.sessionId)?.codeDelivery) {
            await save({ ...read(handle.sessionId), deliveryPresentation: 'summary', codeDelivery: {
              ...read(handle.sessionId)?.codeDelivery, kind: 'git',
              commit: String(settled.gitHead || ''), branch: String(settled.gitRemoteBranch || settled.gitBranch || ''),
              state: settled.gitHead ? 'committed' : 'pending' } });
          }
          const artifactUrl = String(settled?.artifactUrl || settled?.task?.artifactUrl || watch.artifactUrl || '').trim();
          if (artifactUrl) watch.artifactUrl = artifactUrl;
          if (artifactUrl && artifactUrl !== String(read(handle.sessionId)?.artifactUrl || '')) {
            await save({ ...read(handle.sessionId), artifactUrl });
            // The next snapshot is enough to trigger a render, but notifying
            // here also covers URL-only deliveries with no attachments/events.
            notify(handle, { kind: 'settled' });
          }
          // Cache only browser-readable results and preview assets on completion.
          // Other outputs remain remote file cards until explicitly opened or saved.
          const attachmentRows = details ? details.attachments : await request(current, '/tasks/' + encodeURIComponent(live.taskId) + '/attachments');
          await materializeOutputs(read(handle.sessionId), current, attachmentRows, { previewOnly: true });
          watch.artifactsKey = artifactsKey; collected = true;
        }
      } catch (error) { watch.error = String(error.message || error); }
      finally {
        watch.pending = false;
        watch.retryAfter = watch.error ? Date.now() + Math.max(1000, interval) : 0;
        if (!watch.closed) {
          notify(handle, { kind: collected ? 'settled' : 'cloud-handoff' });
          const again = watch.more || watch.refreshRequested; watch.refreshRequested = false;
          armPoll(again ? 0 :
            pushConfirmed() ? 60000 :
              Date.now() < watch.wakeUntil || ['running', 'queued'].includes(watch.state?.status) ? interval : 30000);
        }
      }
    }
    watch.wake = () => {
      watch.wakeUntil = Date.now() + 10000;
      if (watch.pending) watch.refreshRequested = true; else void poll();
    };
    watch.stopPush = discovery.register('cloud-execution-sync', event => {
      if (!watch.closed && !handle.detached && (!event?.taskId || event.taskId === record.taskId)) {
        if (watch.pending) watch.refreshRequested = true;
        else armPoll(100, true);
      }
    });
    watches.set(handle, watch); watch.wake();
  }
  function send(handle, text, attachments, options = {}) { return busy(handle, async () => {
    if (read(handle.sessionId)?.taskExecutionView) {
      const current = await refreshTaskExecution(handle.sessionId, true);
      if (!current.canSend) throw Error('当前账号暂不能继续这条远程需求');
    }
    const record = guard(handle);
    if (!record || record.phase !== 'committed') return { ok: false, reason: '云端交接尚未确认，请先恢复或撤销交接' };
    if (attachments?.length || options.skills?.length || options.plugins?.length) return { ok: false,
      reason: '云端会话请先通过任务附件或云端能力配置补充材料；本次内容没有发送' };
    const message = String(text || '').trim();
    if (!message || message.length > 50000) return { ok: false, reason: '云端补充说明需为 1 到 50000 字，长材料请使用任务附件' };
    const current = await identity(record);
    if (record.pendingMessage && record.pendingMessage.text !== message) return { ok: false,
      reason: '上一条云端留言尚未确认，请先重试原消息核对回执，避免丢失或重复发送' };
    const id = record.pendingMessage?.id || String(options.submissionId || crypto.randomUUID());
    const selection = record.pendingMessage?.executionSelection || record.pendingExecutionSelection;
    await save({ ...record, pendingMessage: { id, text: message, ...(selection ? { executionSelection: selection } : {}) } });
    let receipt;
    try {
      receipt = await request(current, '/tasks/' + encodeURIComponent(record.taskId) + '/ai-say',
        json({ text: message, messageId: id, ...(selection ? { executionSelection: selection } : {}) }));
      if (!receipt?.ok || receipt.pending || receipt.uncertain) throw Object.assign(
        Error(receipt?.error || '云端留言尚未确认，请重试原消息核对回执'), receipt);
    } catch (error) {
      // A proven pre-send refusal can be corrected and retried. Network or ACK
      // uncertainty must retain the original id so a retry cannot duplicate it.
      if (error.delivery === 'rejected' && error.messageId === id) {
        const rejected = { ...read(handle.sessionId) }; delete rejected.pendingMessage; await save(rejected);
      }
      throw error;
    }
    const next = { ...read(handle.sessionId) }; delete next.pendingMessage;
    if (receipt.acceptedSelection) { next.activeExecutionSelection = receipt.acceptedSelection; delete next.pendingExecutionSelection; }
    await save(next);
    observe(handle);
    return { ...receipt, ok: true, accepted: true, queued: Boolean(receipt.queued), snapshot: handle.snapshot(), inputAttachments: [] };
  }); }
  async function stop(handle) {
    try {
      if (read(handle.sessionId)?.taskExecutionView) {
        const current = await refreshTaskExecution(handle.sessionId, true);
        if (!current.canSend) throw Error('当前账号暂不能停止这条远程需求');
      }
      const record = guard(handle); if (!record || record.phase !== 'committed') return { ok: false, reason: '交接尚未完成' };
      const receipt = await request(await identity(record), '/tasks/' + encodeURIComponent(record.taskId) + '/ai-stop', json({}));
      observe(handle); return receipt;
    } catch (error) { notify(handle, { kind: 'error', reason: String(error.message || error) }); return { ok: false, reason: error.message }; }
  }
  // Decorate the native handle once. A registry facade has its own close()
  // ownership and must not be installed as the native disposal callback.
  const native = handle => handle?.[Symbol.for('soduwork.agent-runtime.native-handle')] || handle;
  // Used by the history bridge to label an existing local archive that has
  // already been handed to the cloud.  The durable handoff record remains the
  // authority; this is intentionally a synchronous, read-only classification.
  function isRemote(sessionId) {
    try { const record = read(String(sessionId || '')); return Boolean(record && record.phase !== 'aborted'); }
    catch (_) { return false; }
  }
  const executionSelection = require('./cloud-execution-selection').create({ app, read, save, guard, identity, request, view, notify, busy });
  // Directory aliases can reopen remote views, but only durable receipts can own a sync checkpoint.
  const projection = require('./cloud-execution-projection').create({ app, root, read: readReceipt, save,
    materialize: materializeOutputs, directory: outputCache.directory });
  const synchronization = require('./cloud-execution-sync').create({ ...syncOptions, app, identityOf, request, open: projection.open, discovery,
    changed: presence => {
      for (const handle of pendingViews) {
        if (handle.sessionId !== presence.id) continue;
        if (read(handle.sessionId)?.phase === 'committed') { observe(handle); pendingViews.delete(handle); }
        notify(handle, { kind: 'cloud-handoff' });
      }
      if (!readReceipt(presence.id)?.hidden) {
        syncListeners.forEach(listener => { try { listener(presence); } catch (_) {} });
      }
    } });
  const syncListeners = new Set();
  async function resolveDeleteAlias(id) {
    const alias = remoteRecords.get(id);
    if (!alias?.taskId || !alias.ref || readReceipt(id)) return null;
    await identity(alias);
    const { chats } = await cloudStart.history();
    const matches = chats.filter(row => row.taskId === alias.taskId);
    if (matches.length !== 1) return null;
    const receipt = readReceipt(matches[0].id);
    if (!receipt?.syncId || receipt.taskId !== alias.taskId) return null;
    await identity(alias);
    await identity(receipt);
    return receipt.sessionId;
  }
  async function forget(id) {
    const record = read(String(id || ''));
    if (record?.remoteProjection) {
      return { ok: false, reason: 'remote conversation must be managed by its source task' };
    }
    return cloudStart.forget(id);
  }
  return { reopen, refreshTaskExecution, start: cloudStart.start, history, historyEntry, forget, resolveDeleteAlias, isRemote,
    synchronization, onSynchronized(listener) { syncListeners.add(listener); return () => syncListeners.delete(listener); },
    targets: async agentId => request(await identity(), '/conversation-handoffs/targets?agentId=' + encodeURIComponent(agentId || 'pi')),
    ...Object.fromEntries(Object.entries({ selectExecution: executionSelection.selectExecution, executionRuntimes: executionSelection.executionRuntimes, preview, confirm, recover, abort, guard, view, observe, send, stop, materialize, artifactSession,
    current: handle => publicRecord(guard(handle)) }).map(([key, fn]) =>
    [key, (handle, ...args) => fn(native(handle), ...args)])) };
}

module.exports = { create, source, assertPortable, _serviceUrlFromPage: serviceUrlFromPage,
  _safeOutputName: safeOutputName, _outputAttachmentRows: outputAttachmentRows };
