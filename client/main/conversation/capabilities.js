/*
 * Register capabilities from local availability, session selection, and required
 * main-process grants. Enterprise policy governs business skills and fails closed when
 * unavailable without disabling independently authorized built-in capabilities.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const skillCache = require('./skill-cache');
const officeEngine = require('./office-engine');
const { fetchWithDeviceAuthRetry, accountScopeKey } = require('../device-auth-request');

const POLICY_TTL = 15000;
// Local capability probes invoke external runtimes (Node/Python). Cache the
// result briefly so opening or sending in another conversation never repeats
// a multi-second spawnSync sequence. The key includes the Skill file stat, so
// installing or replacing a Skill naturally invalidates the entry.
const PROBE_TTL = 60000;
const _probeCache = new Map();
const _probePending = new Map();
const _policyCache = new Map();
const _policyPending = new Map();



const DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'browser', skillName: 'browser-use', label: '浏览网页', short: 'Browser',
    description: '打开网页、读取内容、截图并验证页面效果', risk: 'standard', defaultOn: true,
  }),
  Object.freeze({
    id: 'computer', skillName: 'computer-use', label: '操作电脑', short: 'Computer',
    description: '操作只有桌面界面的本地软件', risk: 'high', defaultOn: true,
  }),
  Object.freeze({
    id: 'office', skillName: 'office', legacySkillNames: Object.freeze(['officecli']),
    label: 'Office 文档', short: 'Office',
    description: '创建、读取、编辑并校验 Word、Excel 与 PowerPoint',
    risk: 'standard', defaultOn: true,
  }),
]);

function _skillNames(definition) {
  return [definition.skillName, ...(definition.legacySkillNames || [])];
}

const CAPABILITY_SKILLS = new Set(DEFINITIONS.flatMap(_skillNames));

function _dirMap(skillDirs) {
  const out = new Map();
  (skillDirs || []).forEach((dir) => out.set(path.basename(String(dir || '')), dir));
  return out;
}

function _run(command, args, options) {
  return spawnSync(command, args || [], {
    encoding: 'utf8', timeout: 2500, windowsHide: true,
    shell: false,
    env: process.env,
    ...(options || {}),
  });
}

function _versionMajor(text) {
  const hit = String(text || '').match(/v?(\d+)(?:\.\d+)?/);
  return hit ? Number(hit[1]) : 0;
}

function _browserPath(exists = fs.existsSync, env = process.env) {
  const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:/Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)';
  const localAppData = env.LOCALAPPDATA || '';
  const candidates = [
    env.SODUWORK_BROWSER,
    path.join(programFiles, 'Microsoft/Edge/Application/msedge.exe'),
    path.join(programFilesX86, 'Microsoft/Edge/Application/msedge.exe'),
    path.join(programFiles, 'Google/Chrome/Application/chrome.exe'),
    path.join(programFilesX86, 'Google/Chrome/Application/chrome.exe'),
    localAppData && path.join(localAppData, 'Google/Chrome/Application/chrome.exe'),
    localAppData && path.join(localAppData, 'Microsoft/Edge/Application/msedge.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((item) => {
    try { return exists(item); } catch (error) { return false; }
  }) || '';
}

function _probeCacheKey(definition, skillDir) {
  const file = skillDir && path.join(String(skillDir), 'SKILL.md');
  let revision = 'missing';
  try {
    const stat = fs.statSync(file);
    revision = String(stat.mtimeMs) + ':' + String(stat.size);
  } catch (error) { /* missing/unreadable files remain short-lived cache entries */ }
  return [definition.id, String(skillDir || ''), revision, process.platform].join('|');
}

function _probeCached(definition, skillDir) {
  const key = _probeCacheKey(definition, skillDir);
  const now = Date.now();
  const hit = _probeCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const value = _probe(definition, skillDir);
  _probeCache.set(key, { value, expiresAt: now + PROBE_TTL });
  if (_probeCache.size > 64) {
    for (const [name, item] of _probeCache) {
      if (item.expiresAt <= now) _probeCache.delete(name);
    }
  }
  return value;
}

function _probe(definition, skillDir, deps) {
  const exists = (deps && deps.exists) || fs.existsSync;
  const read = (deps && deps.read) || ((file) => fs.readFileSync(file, 'utf8'));
  const run = (deps && deps.run) || _run;
  const platform = (deps && deps.platform) || process.platform;
  const skillFile = skillDir && path.join(skillDir, 'SKILL.md');
  if (!skillFile || !exists(skillFile)) {
    return { ok: false, reason: '客户端没有带上这项能力' };
  }
  try {
    if (!String(read(skillFile) || '').trim()) return { ok: false, reason: '能力说明文件是空的' };
  } catch (error) {
    return { ok: false, reason: '能力文件存在，但当前系统无法读取' };
  }
  if (definition.id === 'browser') {
    const browser = _browserPath(exists, (deps && deps.env) || process.env);
    if (!browser) return { ok: false, reason: '没有找到 Chrome 或 Edge' };
    const node = run('node', ['--version']);
    const version = String((node && (node.stdout || node.stderr)) || '').trim();
    if (!node || node.status !== 0 || _versionMajor(version) < 22) {
      return { ok: false, reason: '需要 Node 22 或更高版本' };
    }
    return { ok: true, detail: path.basename(browser) + ' · Node ' + version.replace(/^v/, '') };
  }
  if (definition.id === 'computer') {
    if (platform !== 'win32') return { ok: false, reason: '当前仅支持 Windows 桌面' };
    if (!exists(path.join(skillDir, 'scripts', 'screen.ps1'))) {
      return { ok: false, reason: '桌面操作脚本不完整' };
    }
    return { ok: true, detail: 'Windows 桌面控制' };
  }
  if (definition.id === 'office') {
    const result = officeEngine.probe({
      platform, run: (deps && deps.run) || undefined, exists,
      env: (deps && deps.env) || process.env,
    });
    return result.ok
      ? { ok: true, detail: result.detail }
      : { ok: false, reason: result.reason };
  }
  return { ok: false, reason: '未知能力' };
}

async function _probeAsync(definition, skillDir) {
  const exists = fs.existsSync;
  const read = (file) => fs.readFileSync(file, 'utf8');
  const skillFile = skillDir && path.join(skillDir, 'SKILL.md');
  if (!skillFile || !exists(skillFile)) {
    return { ok: false, reason: '客户端没有带上这项能力' };
  }
  try {
    if (!String(read(skillFile) || '').trim()) return { ok: false, reason: '能力说明文件是空的' };
  } catch (error) {
    return { ok: false, reason: '能力文件存在，但当前系统无法读取' };
  }
  if (definition.id === 'browser') {
    const browser = _browserPath(exists, process.env);
    if (!browser) return { ok: false, reason: '没有找到 Chrome 或 Edge' };
    let node;
    try {
      node = await officeEngine.runAsync('node', ['--version'], {
        encoding: 'utf8', timeout: 2500, windowsHide: true, shell: false, env: process.env,
      });
    } catch (error) {
      node = { status: null, stdout: '', stderr: '' };
    }
    const version = String((node && (node.stdout || node.stderr)) || '').trim();
    if (!node || node.status !== 0 || _versionMajor(version) < 22) {
      return { ok: false, reason: '需要 Node 22 或更高版本' };
    }
    return { ok: true, detail: path.basename(browser) + ' · Node ' + version.replace(/^v/, '') };
  }
  if (definition.id === 'computer') {
    if (process.platform !== 'win32') return { ok: false, reason: '当前仅支持 Windows 桌面' };
    if (!exists(path.join(skillDir, 'scripts', 'screen.ps1'))) {
      return { ok: false, reason: '桌面操作脚本不完整' };
    }
    return { ok: true, detail: 'Windows 桌面控制' };
  }
  if (definition.id === 'office') {
    const result = await officeEngine.probeAsync({
      platform: process.platform, env: process.env,
    });
    return result.ok
      ? { ok: true, detail: result.detail || '' }
      : { ok: false, reason: result.reason };
  }
  return { ok: false, reason: '未知能力' };
}

function _probeCachedAsync(definition, skillDir) {
  const key = _probeCacheKey(definition, skillDir);
  const now = Date.now();
  const hit = _probeCache.get(key);
  if (hit && hit.expiresAt > now) return Promise.resolve(hit.value);
  const pending = _probePending.get(key);
  if (pending) return pending;
  const request = (async () => {
    let value;
    try { value = await _probeAsync(definition, skillDir); }
    catch (error) { value = { ok: false, reason: '无法检测本地能力' }; }
    _probeCache.set(key, { value, expiresAt: Date.now() + PROBE_TTL });
    return value;
  })();
  _probePending.set(key, request);
  request.finally(() => {
    if (_probePending.get(key) === request) _probePending.delete(key);
  }).catch(() => {});
  return request;
}

// Allow a cold enterprise catalog to finish while staying inside the capability
// view's 12-second bound. A timeout still fails closed for governed skills.
const POLICY_TIMEOUT_MS = 10000;
async function fetchPolicy(identity, timeoutMs = POLICY_TIMEOUT_MS, fetchImpl = global.fetch, force = false) {
  const hub = String((identity && identity.hub) || '').replace(/\/+$/, '');
  if (!hub || !identity.clientId || (!identity.session && !identity.secret)) {
    return { ok: false, skills: [], enabled: [], reason: '这台 SoduWork 尚未连接企业后台' };
  }
  const accountScope = accountScopeKey(identity);
  const cacheKey = hub + '|' + String(identity.clientId || '') + '|' + accountScope;
  const cacheable = fetchImpl === global.fetch && !!accountScope;
  if (cacheable && force) {
    _policyCache.delete(cacheKey);
    _policyPending.delete(cacheKey);
  }
  const current = cacheable && _policyCache.get(cacheKey);
  if (current && current.expiresAt > Date.now()) return current.value;
  if (cacheable && _policyPending.has(cacheKey)) return _policyPending.get(cacheKey);
  const request = (async () => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const response = await fetchWithDeviceAuthRetry(identity, hub + '/api/v1/skills', {
      signal: ctl.signal,
    }, fetchImpl);
    if (!response.ok) return { ok: false, skills: [], enabled: [], reason: '企业能力策略暂时不可用（HTTP ' + response.status + '）' };
    const data = await response.json();
    const value = {
      ok: true,
      skills: Array.isArray(data && data.skills) ? data.skills : [],
      enabled: Array.isArray(data && data.enabled) ? data.enabled.map(String) : [],
      revoked: Array.isArray(data && data.revoked) ? data.revoked.map(String) : [],
    };
    if (cacheable && _policyPending.get(cacheKey) === request) {
      _policyCache.set(cacheKey, { value, expiresAt: Date.now() + POLICY_TTL });
    }
    return value;
  } catch (error) {
    const reason = error && error.name === 'AbortError' ? '读取企业能力策略超时' : '暂时连不上企业能力策略';
    return { ok: false, skills: [], enabled: [], reason };
  } finally {
    clearTimeout(timer);
  }
  })();
  if (cacheable) _policyPending.set(cacheKey, request);
  try { return await request; }
  finally {
    if (cacheable && _policyPending.get(cacheKey) === request) {
      _policyPending.delete(cacheKey);
    }
  }
}

async function inspect(options) {
  const input = options || {};
  // Directory discovery and the policy request are independent; await both
  // without serializing disk preparation ahead of authentication/network.
  const [policy, skillDirsInput] = await Promise.all([
    input.policy || fetchPolicy(input.identity, input.timeoutMs, input.fetchImpl, input.forcePolicy === true),
    input.skillDirs || [],
  ]);
  const opts = { ...input, skillDirs: skillDirsInput };
  let runtime = {
    dirs: opts.skillDirs || [],
    contracts: (opts.skillDirs || []).map((dir) => ({
      id: 'skill:' + path.basename(String(dir || '')),
      name: path.basename(String(dir || '')),
      path: String(dir || ''), installed: true, version: 'bundled',
    })),
    warning: '',
  };
  if (opts.app && policy.ok) {
    runtime = await skillCache.ensure({
      app: opts.app, identity: opts.identity, policy,
      localDirs: opts.skillDirs || [], names: opts.selectedSkills || [],
      timeoutMs: opts.syncTimeoutMs, fetchImpl: opts.fetchImpl, allowUnavailableDefaults: true,
    });
  }
  const dirs = _dirMap(runtime.dirs || opts.skillDirs || []);
  const enabled = new Set(policy.enabled || []);
  const deviceGrants = new Set((Array.isArray(opts.deviceGrants) ? opts.deviceGrants : ['browser'])
    .map((item) => String(item || '').trim().toLowerCase()).filter(Boolean));
  const skillDirs = DEFINITIONS.map((definition) => {
    const names = _skillNames(definition);
    return names.map((name) => dirs.get(name)).find(Boolean);
  });
  // Injected dependencies are intentionally synchronous and deterministic for
  // unit tests.  Real runtime probes use asynchronous child processes and are
  // launched together so one missing launcher cannot block the whole composer.
  const probeValues = await Promise.all(DEFINITIONS.map((definition, index) =>
    opts.deps ? _probe(definition, skillDirs[index], opts.deps)
      : _probeCachedAsync(definition, skillDirs[index])));
  const items = DEFINITIONS.map((definition, index) => {
    const names = _skillNames(definition);
    const runtime = probeValues[index];
    /* Browser / Computer / Office are SoduWork's local foundation capabilities, not
       enterprise Skill catalog entries. A temporary Hub or catalog outage must
       not silently downgrade the composer to text-only chat. Their effective
       boundary is local readiness plus the trusted device grant below. */
    const policyAllowed = true;
    const selectable = runtime.ok;
    const deviceGranted = definition.risk !== 'high' || deviceGrants.has(definition.id);
    let reason = '';
    if (!runtime.ok) reason = runtime.reason;
    return {
      ...definition,
      policyAllowed,
      available: !!runtime.ok,
      selectable,
      deviceGranted,
      grantRequired: selectable && !deviceGranted,
      personalEnabled: names.some((name) => enabled.has(name)),
      selected: selectable && deviceGranted && definition.defaultOn,
      detail: runtime.detail || '',
      reason,
    };
  });
  const runtimeByName = new Map((runtime.contracts || []).map((item) => [String(item.name || ''), item]));
  // Explicit guide selection includes foundation skills. Loading their trusted
  // resources never grants the corresponding browser, computer or office tools.
  const skillCatalog = (policy.skills || []).map((item) => {
    const name = String(item.name || '');
    const local = runtimeByName.get(name);
    const installed = !!local;
    return {
      ...item,
      id: item.id || 'skill:' + name,
      discovered: true,
      installed,
      personalEnabled: enabled.has(name),
      selected: (opts.selectedSkills || []).map(String).includes(name),
      selectable: installed || !!item.downloadable,
      installState: installed ? 'installed' : (item.downloadable ? 'remote' : 'missing'),
      path: installed ? local.path : '',
      reason: installed ? '' : (item.downloadable ? '选择后会安全同步到本机' : '当前执行节点没有这个 Skill 文件'),
    };
  });
  const businessSkills = skillCatalog.filter((item) => !CAPABILITY_SKILLS.has(item.name));
  const policyReason = policy.reason || runtime.warning || '';
  return {
    ok: true, policyOk: !!policy.ok, policyReason, items, skillCatalog, businessSkills, policy,
    runtime: { dirs: runtime.dirs || [], contracts: runtime.contracts || [], warning: runtime.warning || '' },
  };
}

async function resolve(options) {
  const opts = options || {};
  const catalog = await inspect(opts);
  const requested = new Set(Array.isArray(opts.requested) ? opts.requested.map(String) :
    catalog.items.filter((item) => item.selected).map((item) => item.id));
  const selected = catalog.items.filter((item) =>
    requested.has(item.id) && item.selectable && item.deviceGranted);
  const personal = new Set((catalog.policy && catalog.policy.enabled) || []);
  const explicit = new Set(Array.isArray(opts.selectedSkills) ? opts.selectedSkills.map(String) : []);
  const authorizedBusiness = new Set(catalog.businessSkills.map((item) => String(item.name || '')));
  const chosenBusiness = new Set(
    [...personal, ...explicit].filter((name) => authorizedBusiness.has(name)));
  const authorizedExplicit = [...explicit].filter((name) => authorizedBusiness.has(name));
  const runtimeByName = new Map(((catalog.runtime && catalog.runtime.contracts) || [])
    .map((item) => [String(item.name || ''), item]));
  const allDirs = (catalog.runtime && catalog.runtime.dirs) || opts.skillDirs || [];
  const businessDirs = [];
  chosenBusiness.forEach((name) => {
    const item = runtimeByName.get(name);
    if (item && item.path) businessDirs.push(item.path);
  });
  const capabilityDirs = [];
  selected.forEach((item) => {
    const names = _skillNames(item);
    const dir = allDirs.find((candidate) => names.includes(path.basename(String(candidate || ''))));
    if (dir) capabilityDirs.push(dir);
  });
  // A default alias must never make an explicitly selected/foundation path optional.
  const pathKey = dir => {
    let target = path.resolve(dir);
    try { target = fs.realpathSync(target); } catch { /* Loader reports missing paths. */ }
    return process.platform === 'win32' ? target.toLowerCase() : target;
  };
  const requiredDirs = new Set([...capabilityDirs, ...authorizedExplicit
    .map(name => runtimeByName.get(name)?.path).filter(Boolean)].map(pathKey));
  const warnings = catalog.items
    .filter((item) => requested.has(item.id) && (!item.selectable || !item.deviceGranted))
    .map((item) => item.label + '：' + (item.reason ||
      (item.grantRequired ? '这台设备尚未明确授权' : '不可用')));
  if (catalog.runtime && catalog.runtime.warning) warnings.push(catalog.runtime.warning);
  if (!catalog.policyOk) warnings.unshift(catalog.policyReason || '企业能力策略不可用，本次没有加载受治理技能');
  catalog.businessSkills.filter((item) => explicit.has(item.name) && !item.installed)
    .forEach((item) => warnings.push(item.name + '：' + (item.reason || '当前执行节点未安装')));
  return {
    catalog,
    capabilityIds: selected.map((item) => item.id),
    capabilities: selected,
    skills: catalog.businessSkills.filter((item) => chosenBusiness.has(item.name) && item.installed),
    selectedSkills: authorizedExplicit,
    skillDirs: [...new Set([...businessDirs, ...capabilityDirs])],
    optionalSkillDirs: [...chosenBusiness].filter(name => !explicit.has(name))
      .map(name => runtimeByName.get(name)?.path).filter(dir => dir && !requiredDirs.has(pathKey(dir))),
    warnings,
  };
}

module.exports = {
  DEFINITIONS, CAPABILITY_SKILLS, fetchPolicy, inspect, resolve,
  _probe, _probeAsync, _probeCached, _probeCachedAsync, _probeCache, _probePending,
  _browserPath, _versionMajor, _policyCache, _policyPending,
};
