'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { scope } = require('../platform-connections/runtime.cjs');
const { assertNoLinks } = require('../plugin-resources');
const { replaceFileSync } = require('../verified-file-replace.cjs');
const attached = new WeakMap();

function identifier(value, label, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() ||
      value.length > 320 || /[\x00-\x1f\x7f]/.test(value)) throw Error(label + '无效，请重新打开验收会话');
  return value;
}
function hubOf(identity) {
  try {
    const url = new URL(identity.hub);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error();
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch (_) { throw Error('验收会话的服务地址无效，请重新登录'); }
}
function localHubHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '127.0.0.1') return true;
  const octets = host.split('.').map(value => Number(value));
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}
function canMigrateLocalHub(app, storedHub, currentHub) {
  if (app?.isPackaged !== false || storedHub === currentHub) return false;
  try {
    const stored = new URL(storedHub), current = new URL(currentHub);
    return stored.protocol === current.protocol && stored.port === current.port &&
      localHubHost(stored.hostname) && localHubHost(current.hostname);
  } catch (_) { return false; }
}
function location(app, sessionId) {
  identifier(sessionId, '会话编号');
  if (!app?.getPath) throw Error('无法读取验收会话存储位置');
  const root = app.getPath('userData');
  const file = path.join(root, 'acceptance-session-context',
    crypto.createHash('sha256').update(sessionId).digest('hex') + '.json');
  assertNoLinks(root, file);
  return file;
}
function selection(value) {
  const mode = value.acceptanceMode === undefined ? 'manual' : value.acceptanceMode;
  if (!['manual', 'auto'].includes(mode)) throw Error('验收方式无效，请重新选择');
  const attachmentIds = Array.isArray(value.acceptanceAttachmentIds)
    ? [...new Set(value.acceptanceAttachmentIds.map(id => identifier(String(id), '验收附件编号')))].slice(0, 60)
    : [];
  return { acceptanceSession: true, taskRef: identifier(value.taskRef, '需求编号'),
    acceptanceMode: mode, approvalId: identifier(value.approvalId, '审批单编号', true),
    ...(attachmentIds.length ? { acceptanceAttachmentIds: attachmentIds } : {}) };
}
function read(app, sessionId) {
  try {
    const file = location(app, sessionId), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 16384) throw Error();
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.version !== 1 || record.sessionId !== sessionId ||
        !/^[a-f0-9]{32}$/.test(record.owner) || typeof record.hub !== 'string' ||
        hubOf({ hub: record.hub }) !== record.hub || record.acceptanceSession !== true ||
        !['manual', 'auto'].includes(record.acceptanceMode) || typeof record.approvalId !== 'string') throw Error();
    selection(record);
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Error('验收会话设置无法读取，请检查本地存储后重试');
  }
}
function save(app, record) {
  let temporary;
  try {
    const file = location(app, record.sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    temporary = file + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    // Use the managed-disk replacement fallback; failed persistence must not leave automatic review grants in memory.
    replaceFileSync(temporary, file);
  } catch (_) { throw Error('验收会话设置保存失败，请检查本地存储后重试'); }
  finally { if (temporary) { try { fs.unlinkSync(temporary); } catch (_) {} } }
}
function checkTask(handle, selected) {
  const bound = [handle.taskRef, handle.taskId, handle.activeTaskId, ...(handle.taskIds || []),
    ...(handle.taskBindings || []).map(row => row.taskId)].filter(Boolean);
  if (bound.some(id => id !== selected.taskRef)) throw Error('验收会话不能绑定其他需求，请新建会话');
}
function checkRequested(requested, selected) {
  // History restoration reads existing authorization only; renderer parameters cannot change review mode, task, or approval identity.
  for (const key of ['taskRef', 'acceptanceMode', 'approvalId', 'acceptanceAttachmentIds']) {
    if (requested[key] !== undefined && requested[key] !== selected[key])
      throw Error('验收会话的需求、方式或审批单不一致，请重新发起验收');
  }
}
function expose(handle, record) {
  const selected = record ? Object.freeze(selection(record)) : null;
  attached.set(handle, { record, selected });
  handle.acceptanceSession = selected;
  return selected;
}

// Trust resumed only from the main process's actual open result.
// Persist local review settings only; Hub revalidates permissions, artifact versions, and business state each turn.
async function attach(app, handle, rawOptions = {}, identity) {
  if (!handle?.sessionId) throw Error('无法确认当前会话，请重新打开验收入口');
  const cached = attached.get(handle);
  let record = cached ? cached.record : read(app, handle.sessionId);
  if (record) {
    const owner = scope(identity), currentHub = hubOf(identity);
    if (record.owner !== owner || (record.hub !== currentHub && !canMigrateLocalHub(app, record.hub, currentHub)))
      throw Error('这条验收会话属于另一个账号或服务，请切回原账号');
    if (record.hub !== currentHub) {
      // Local source runs may change between loopback and a private LAN address.
      // Persist the current endpoint after ownership has already been verified.
      save(app, { ...record, owner, hub: currentHub });
      record = { ...record, owner, hub: currentHub };
    }
    const selected = selection(record);
    checkRequested(rawOptions, selected);
    checkTask(handle, selected);
    return expose(handle, record);
  }
  if (rawOptions.acceptanceSession !== true) return expose(handle, null);
  if (cached || rawOptions.resumed === true || rawOptions.chatId)
    throw Error('已有普通会话不能改为验收会话，请从需求的验收入口新建会话');
  const selected = selection(rawOptions);
  checkTask(handle, selected);
  const next = { version: 1, sessionId: handle.sessionId, owner: scope(identity), hub: hubOf(identity), ...selected };
  save(app, next);
  return expose(handle, next);
}
function get(handle) { return attached.get(handle)?.selected || null; }
function assertTask(handle, taskRef) {
  const selected = get(handle);
  if (selected) {
    checkTask(handle, selected);
    if (taskRef && taskRef !== selected.taskRef) throw Error('验收会话不能绑定其他需求，请新建会话');
  }
  return selected;
}
function projectHistory(app, row) {
  const record = read(app, row.id);
  if (!record) return row;
  const review = selection(record);
  const title = row.reviewBaseTitle || row.title || '需求验收';
  const at = new Date(Number(row.at) || row.createdAt || 0);
  const stamp = at.getTime() ? ' · ' + [at.getMonth() + 1, at.getDate()].map(n => String(n).padStart(2, '0')).join('-') +
    ' ' + [at.getHours(), at.getMinutes()].map(n => String(n).padStart(2, '0')).join(':') : '';
  return { ...row, reviewBaseTitle: title, acceptanceReview: review,
    title: (review.acceptanceMode === 'auto' ? '自动验收' : '验收分析') + ' · ' + title + stamp };
}
module.exports = { attach, get, assertTask, projectHistory };
