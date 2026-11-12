/* Find the newest plugin draft produced by an active SoduWork conversation.

   This deliberately works from the active session registry and each session's
   bounded output snapshot. The renderer never supplies a path, so this helper
   cannot become an arbitrary local-file reader. */
const fs = require('fs');
const path = require('path');
const outputs = require('./outputs');
const resources = require('../plugin-resources');
const candidates = require('./plugin-draft-candidates');

const { DRAFT_NAME, MAX_BYTES } = candidates;

function _candidate(handle, snapshot) {
  if (!handle || !handle.cwd) return null;
  if (!snapshot) {
    if (typeof handle.outputSnapshot !== 'function') return null;
    try { snapshot = handle.outputSnapshot(); } catch (_) { return null; }
  }
  const matches = candidates.collect(handle.cwd, snapshot);
  matches.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  const file = matches[0];
  return file ? { handle, file, at: Number(file.at || handle.startedAt || 0) } : null;
}

function findRecent(handles) {
  const rows = (Array.isArray(handles) ? handles : []).map(handle => _candidate(handle)).filter(Boolean);
  rows.sort((a, b) => b.at - a.at);
  return rows[0] || null;
}

function readRecent(handles, app) {
  const found = findRecent(handles);
  if (!found) return { ok: false, reason: '最近的活动会话里还没有可安装的插件草稿' };
  return readCandidate(found, app);
}

async function readRecentAsync(handles, app) {
  const rows = (await Promise.all((Array.isArray(handles) ? handles : []).map(async handle => {
    try {
      const snapshot = typeof handle?.outputSnapshotAsync === 'function'
        ? await handle.outputSnapshotAsync() : handle?.outputSnapshot?.();
      return snapshot ? _candidate(handle, snapshot) : null;
    } catch (_) { return null; }
  }))).filter(Boolean).sort((a, b) => b.at - a.at);
  return rows.length ? readCandidate(rows[0], app)
    : { ok: false, reason: '最近的活动会话里还没有可安装的插件草稿' };
}

function readSession(handle, target, indexed, app) {
  if (!handle) return { ok: false, reason: '请重新打开制作插件的会话后安装' };
  if (typeof handle.inFlight === 'function' && handle.inFlight()) {
    return { ok: false, reason: '插件还在制作中，请等本轮完成后安装' };
  }
  const runtime = require('../conversation/artifact-runtime');
  const snapshot = indexed || runtime.snapshot(handle);
  const files = [...snapshot.items, ...(snapshot.got.files || [])];
  let file = files.find(item => String(item.artifactId || item.path || '') === String(target || ''));
  const described = file && candidates.describe(handle.cwd, file);
  if (!file || !file.path || !described ||
      !outputs.inside(handle.cwd, file.path)) {
    return { ok: false, reason: '这份插件草稿不属于当前会话成果，请刷新后重试' };
  }
  // Resolve stale history cards only within the current conversation and with the same actual plugin key.
  // Matching display names or filenames cannot authorize installation of another plugin.
  const identity = file.pluginIdentity || candidates.candidateIdentity(described);
  const replacements = snapshot.items.filter(item => item.pluginDraft && !item.pluginSuperseded &&
    item.pluginIdentity === identity && item.path !== file.path);
  // Do not use old delivery entries to recover packages whose merged manifest no longer marks them as plugin drafts.
  if (file.pluginSuperseded || (!file.pluginDraft && replacements.length)) {
    const current = replacements.find(item => described.pluginKey &&
      candidates.describe(handle.cwd, item)?.pluginKey === described.pluginKey);
    if (!current || !outputs.inside(handle.cwd, current.path)) {
      return { ok: false, reason: '这份插件草稿已有新稿，请刷新后安装最新稿' };
    }
    file = current;
  }
  return readCandidate({ handle, file, at: Number(file.at || 0) }, app);
}

async function readSessionAsync(handle, target, app) {
  if (!handle) return readSession(handle, target);
  return readSession(handle, target, await require('../conversation/artifact-runtime').snapshotAsync(handle), app);
}

function readCandidate(found, app) {
  try {
    if (typeof found.handle.inFlight === 'function' && found.handle.inFlight()) {
      return { ok: false, reason: '插件还在制作中，请等本轮完成后安装' };
    }
    resources.assertNoLinks(path.resolve(found.handle.cwd), path.resolve(found.file.path));
    const stat = fs.statSync(found.file.path);
    if (!stat.isFile()) return { ok: false, reason: '插件草稿已经不在了' };
    if (stat.size > MAX_BYTES) return { ok: false, reason: '插件草稿超过 24MB，无法安全读取' };
    const bytes = fs.readFileSync(found.file.path);
    if (bytes.length > MAX_BYTES) return { ok: false, reason: '插件草稿超过 24MB，无法安全读取' };
    const body = candidates.ARCHIVE.test(found.file.path)
      ? require('../plugin-package-reader.cjs').readPersonalArchive(bytes)
      : candidates.parseJson(bytes.toString('utf8'));
    if (!body || Array.isArray(body) || typeof body !== 'object') {
      return { ok: false, reason: '插件草稿不是有效的 JSON 对象' };
    }
    return {
      ok: true,
      body: require('../jiyong-edit-source.cjs').reconcile({app,cwd:found.handle.cwd,file:found.file.path,
        body:resources.collect(body, found.file.path, found.handle.cwd)}),
      source: {
        sessionId: String(found.handle.sessionId || ''),
        relative: String(found.file.relative || DRAFT_NAME),
        at: found.at,
      },
    };
  } catch (error) {
    return { ok: false, reason: '读取插件草稿失败：' + String((error && error.message) || error) };
  }
}

function installIpc(ipcMain, session, app) {
  ipcMain.handle('pi-session-recent-plugin-draft', () => readRecentAsync(session.list(), app));
  ipcMain.handle('pi-session-plugin-draft', async (event, ref, target) => {
    if (!require('../platform-connections/index.cjs').trustedSender(event)) {
      return { ok: false, reason: '只允许 SoduWork 客户端安装会话插件' };
    }
    try { return await readSessionAsync(session.get(ref), target, app); }
    catch (error) { return { ok: false, reason: '插件草稿读取失败：' + error.message }; }
  });
}

module.exports = { installIpc, readRecent, readRecentAsync, readSession, readSessionAsync, findRecent, DRAFT_NAME, MAX_BYTES, _candidate };
