/*
 * Agent runtime installation and configuration: show availability,
 * installation/version/path, missing setup, and real execution checks separately.
 * Installed does not imply usable. This surface manages the current client only;
 * cloud runtime maintenance belongs to the cloud-computer surface.
 */

let _agData = null;                 /* {env, agents, modelCount} */
let _agOpen = '';                   /* Currently expanded agent; only one opens at a time. */
let _agJobs = {};                   /* key -> {jobId, action, state, lines, ok, detail} */
let _agTimer = null;                /* Follow active jobs to completion even after leaving this panel. */
let _agConfirm = '';                /* Agent awaiting uninstall confirmation. */
let _agView = 'agents';             /* Separate agent capabilities from Runner node management. */
const _agLoaded = { agents: false, runners: false };
let _agLoadSeq = 0;                 /* Discard stale requests after tab switches so they cannot replace the new page with an empty state. */
let _agRunnerPoll = null;
let _agRunnerTick = null;
let _agScopeEpoch = 0;
let _agScope = '';
const _agProbeBindings = new Map();
const _agProbeResults = new Map();

/* Agent cards are rendered from local HTML instead of data-i18n templates.
 * Re-scan each freshly painted surface so changing the interface language
 * cannot leave the status labels and action copy in Chinese. User-provided
 * names, versions, paths and diagnostics remain protected by their existing
 * data-user-content markers. */
function _agTranslate(root) {
  try { window.SoduWorkI18n?.translateNode?.(root || document.getElementById('agPanel')); } catch (_) {}
}

window.addEventListener?.('soduwork-locale-change', () => {
  if (document.getElementById('agPanel')?.classList.contains('show')) {
    _agSyncHeader();
    _agRender();
  }
});

const _AG_ICON = '<svg viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="12" rx="3"/>' +
  '<path d="M12 3v4M9 13h.01M15 13h.01"/></svg>';

/* Map states to labels and sort weights, placing usable agents first. */
const _AG_ST = {
  ok:      { t: '测通了',     o: 0 },
  ready:   { t: '可以派活',   o: 1 },
  bad:     { t: '测了没通',   o: 2 },
  nollm:   { t: '还差模型',   o: 3 },
  unauthed:{ t: '还没登录',   o: 3 },
  missing: { t: '没装',       o: 4 },
  setup:   { t: '待准备组件', o: 4, tone: 'nollm' },
  disabled:{ t: '已停用',     o: 4, tone: 'missing' },
  broken:  { t: '需要修复',   o: 2, tone: 'bad' },
  unknown: { t: '待重新探测', o: 5, tone: 'missing' },
};

function openAgentsPanel(options) {
  _agEnsureScope();
  _agView = options && options.tab === 'runners' ? 'runners' : 'agents';
  let p = document.getElementById('agPanel');
  if (!p) {
    p = document.createElement('div');
    p.id = 'agPanel'; p.className = 'sch-panel cfg-panel';
    /* Bind Escape once when creating the panel; ignore it when no drawer is open. */
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !document.getElementById('agDrawerWrap')) return;
      _agOpen = ''; _agConfirm = '';
      _agRender();
    });
    p.innerHTML =
      '<div class="sch-head ws-page-head">' +
      '<span class="sch-h-ico">' + _AG_ICON + '</span>' +
      '<div class="sch-h-txt"><span class="sch-h-kicker" id="agKicker" data-i18n="eyebrow.agent_runtime">AGENT RUNTIME</span>' +
      '<b class="sch-h-title" id="agTitle">Agent 管理</b>' +
      '<i class="sch-h-sub" id="agSubtitle">管理本机的 Agent、模型与可用状态</i></div>' +
      '<nav class="ag-tabs" role="tablist" aria-label="Agent 管理视图">' +
        '<button role="tab" data-agtab="agents">Agent</button>' +
        '<button role="tab" data-agtab="runners">Runner</button></nav>' +
      '<div class="sch-h-acts">' +
      '<button class="btn-mini" id="agAddRuntime" hidden>接入新底座</button>' +
      '<button class="btn-mini" id="agRefresh" hidden>重新探测</button>' +
      '<button class="np-close" id="agClose">✕</button></div></div>' +
      '<div class="sch-body" id="agBody"></div>';
    document.body.appendChild(p);
    document.getElementById('agClose').addEventListener('click', closeAgentsPanel);
    document.getElementById('agAddRuntime').addEventListener('click', () => window.CustomAgents?.open(() => {
      window.CustomAgents?.mount(document.getElementById('agCustomAgents'));
    }));
    document.getElementById('agRefresh').addEventListener('click', () => {
      _agLoad(true);
    });
    p.querySelectorAll('[data-agtab]').forEach((b) => b.addEventListener('click', () => {
      _agView = b.getAttribute('data-agtab') === 'runners' ? 'runners' : 'agents';
      _agSyncHeader();
      _agArmRunnerRefresh();
      _agLoad();
    }));
    if (typeof makeDraggable === 'function') makeDraggable(p, p.querySelector('.sch-head'));
  }
  _agSyncHeader();
  p.classList.add('show');
  _agArmRunnerRefresh();
  if (Object.values(_agJobs).some(job => job.state === 'running')) _agPoll();
  if (typeof expandForOverlay === 'function') expandForOverlay();
  _agLoad(true);
}

function _agArmRunnerRefresh() {
  if (_agRunnerPoll) { clearInterval(_agRunnerPoll); _agRunnerPoll = null; }
  const p = document.getElementById('agPanel');
  if (_agView !== 'runners' || !p || !p.classList.contains('show')) return;
  /* Refresh heartbeat/load every fifteen seconds; throttle session events separately rather than polling frequently. */
  _agRunnerPoll = setInterval(() => _agLoad(true), 15000);
}

function _agOnExecution() {
  const p = document.getElementById('agPanel');
  if (_agView !== 'runners' || !p || !p.classList.contains('show')) return;
  if (_agRunnerTick) clearTimeout(_agRunnerTick);
  _agRunnerTick = setTimeout(() => { _agRunnerTick = null; _agLoad(true); }, 550);
}
window.addEventListener('soduwork-work-execution', _agOnExecution);
function _agOwnerScope() {
  return String(window.SoduWorkAPI?.taskStorageKey?.('ops') || 'renderer');
}

function _agResetScope() {
  _agScopeEpoch++; _agLoadSeq++;
  _agData = null; _agJobs = {}; _agOpen = ''; _agConfirm = '';
  _agProbeBindings.clear();
  _agProbeResults.clear();
  _agLoaded.agents = false; _agLoaded.runners = false;
  if (_agTimer) { clearInterval(_agTimer); _agTimer = null; }
  if (_agRunnerPoll) { clearInterval(_agRunnerPoll); _agRunnerPoll = null; }
  if (_agRunnerTick) { clearTimeout(_agRunnerTick); _agRunnerTick = null; }
  _agDrawerSync();
  const box = document.getElementById('agBody');
  if (box) { box.innerHTML = ''; box.textContent = ''; }
  window.RunnerManager?.reset?.();
}

function _agEnsureScope() {
  const scope = _agOwnerScope();
  if (!_agScope) { _agScope = scope; return false; }
  if (_agScope === scope) return false;
  _agScope = scope;
  _agResetScope();
  return true;
}

function _agScopeChanged(force) {
  if (force) { _agScope = _agOwnerScope(); _agResetScope(); }
  else if (!_agEnsureScope()) return;
  const panel = document.getElementById('agPanel');
  if (panel?.classList.contains('show')) {
    _agArmRunnerRefresh();
    Promise.resolve().then(() => _agLoad(true));
  }
}
window.addEventListener('soduwork-data-scope-changed', () => _agScopeChanged(true));
window.addEventListener('soduwork-device-auth', () => _agScopeChanged(false));

function _agSyncHeader() {
  const p = document.getElementById('agPanel');
  if (!p) return;
  const runners = _agView === 'runners';
  const kicker = p.querySelector('#agKicker'), title = p.querySelector('#agTitle');
  const subtitle = p.querySelector('#agSubtitle');
  const refresh = p.querySelector('#agRefresh');
  const addRuntime = p.querySelector('#agAddRuntime');
  if (addRuntime) addRuntime.hidden = true;
  if (kicker) kicker.textContent = runners ? 'EXECUTION CONTROL' : 'AGENT RUNTIME';
  if (title) title.textContent = runners ? 'Runner 管理' : 'Agent 管理';
  if (subtitle) subtitle.textContent = runners
    ? '查看任务在哪台机器执行，并管理节点健康与接单状态'
    : '管理本机的 Agent、模型与可用状态';
  if (refresh) {
    refresh.hidden = !runners;
    refresh.textContent = runners ? '刷新节点' : '重新探测';
  }
  p.querySelectorAll('[data-agtab]').forEach((b) => {
    const on = b.getAttribute('data-agtab') === _agView;
    b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  _agTranslate(p);
}

function closeAgentsPanel() {
  _agLoadSeq++;
  const p = document.getElementById('agPanel');
  if (p) p.classList.remove('show');
  _agOpen = ''; _agConfirm = '';
  _agDrawerSync();     /* Use one close path to remove the drawer and notify the pet overlay. */
  // Installation continues off-screen; the active-job poll publishes completion.
  if (_agRunnerPoll) { clearInterval(_agRunnerPoll); _agRunnerPoll = null; }
  if (_agRunnerTick) { clearTimeout(_agRunnerTick); _agRunnerTick = null; }
  if (typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
}

async function _agLoad(force) {
  _agEnsureScope();
  const box = document.getElementById('agBody');
  if (!box) return;
  const view = _agView;
  const runners = view === 'runners';
  const loaded = runners ? _agLoaded.runners : _agLoaded.agents;
  if (loaded && !force) { _agRender(); return; }
  const seq = ++_agLoadSeq;
  const scope = _agScopeEpoch;
  const ownerScope = _agScope;
  if (!loaded) {
    box.innerHTML = '<div class="ag-load"><i></i><i></i><i></i>' +
      '<span>' + (runners ? '正在读取运行节点…' : '正在查看本机底座…') + '</span></div>';
    _agTranslate(box);
  }
  let r = null, nodes = null;
  try {
    if (runners) {
      nodes = await SoduWorkAPI.runners();
    }
    else r = await SoduWorkAPI.localAgentSetup();
  } catch (e) { /* Render a retryable empty state below. */ }
  if (scope !== _agScopeEpoch || ownerScope !== _agOwnerScope() || seq !== _agLoadSeq || document.getElementById('agBody') !== box) return;
  if (!r && !nodes) {
    if (_agView !== view || seq !== _agLoadSeq) return;       /* Do not show an old error after switching views. */
    if (loaded) return;                                       /* Keep visible data when a background refresh fails. */
    box.innerHTML = '<div id="agCustomAgents"></div><div class="ag-blank">' + _AG_ICON +
      '<b>没连上后台</b><span>探测不了执行机上装了什么。等连上了再打开这一页。</span>' +
      '<button class="btn-mini" id="agRetry">重试</button></div>';
    const rb = document.getElementById('agRetry');
    if (rb) rb.addEventListener('click', () => _agLoad(true));
    if (!runners) window.CustomAgents?.mount(document.getElementById('agCustomAgents'));
    _agTranslate(box);
    return;
  }
  if (!_agData) _agData = { env: {}, agents: [], modelCount: 0, runners: [] };
  if (r) {
    const before = JSON.stringify(_agData.agents || []);
    _agData = Object.assign(_agData, r);
    if (before !== JSON.stringify(_agData.agents || [])) {
      try { window.soduWorkAPI?.broadcast?.('agent-runtimes-changed'); } catch (_) {}
    }
    _agLoaded.agents = true;
  }
  if (nodes) {
    _agData.runners = nodes.runners || [];
    _agData.localRunnerReason = nodes.localRunnerReason || '';
    _agLoaded.runners = true;
  }
  if (_agView === view && seq === _agLoadSeq) _agRender();
}

function _agProbeContext(a) {
  return JSON.stringify([a.key, a.version || '', a.bin || '', a.model || '', a.modelEffective || '',
    a.modelGone === true, a.configRevision || '', a.runtimeRevision || '']);
}

/* Resolve server-provided localized descriptors while preserving diagnostic params.
 * The fallback is passed through the phrase catalog for older servers that do not
 * know descriptor keys yet. */
function _agMessage(value, fallback = '') {
  if (value == null || value === '') return fallback ? (window.SoduWorkI18n?.translateText?.(fallback) || fallback) : '';
  if (typeof value === 'string') return window.SoduWorkI18n?.translateText?.(value) || value;
  const source = String(value.fallback || value.text || fallback || '');
  const key = String(value.key || '');
  const params = value.params && typeof value.params === 'object' ? value.params : {};
  if (key && window.SoduWorkI18n?.t) return window.SoduWorkI18n.t(key, source || key, params);
  return window.SoduWorkI18n?.translateText?.(source) || source;
}

function _agCopy(a, field, fallback = '') {
  if (field === 'name' && ['kimi', 'claude'].includes(a?.key)) {
    return String(a.name || fallback || a.key).replace(/\s+CLI$/i, '');
  }
  return _agMessage(a?.copy?.[field], fallback || a?.[field] || '');
}

/* Phrase translation for server-composed job copy. The backend stays Chinese;
 * lines rendered inside <pre data-alog> never pass through the DOM adapter,
 * so they are translated here, per line, before escaping. */
function _agTx(value) {
  const text = String(value == null ? '' : value);
  let out = text;
  try { out = window.SoduWorkI18n?.translateText?.(text) || text; } catch (_) { return text; }
  if (out !== text) return out;
  /* Trailing parenthetical the exact catalog cannot match
   * (e.g. "gpt-5（走我自己的额度）" -> model id + translated suffix). */
  let m = text.match(/^([\s\S]*?)(（[^（）]{1,24}）)$/);
  if (m && m[1]) {
    const suffix = _agTx(m[2]);
    if (suffix !== m[2]) return m[1] + suffix;
  }
  /* Known-label prefix split so the label and reason translate independently
   * (templates whose parameter contains sentence punctuation are skipped by
   * the catalog, e.g. "OpenCode 安装失败：npm ERR! code 1"). */
  m = text.match(/^(\s*)([^：:\n]{1,14}：)([\s\S]+)$/);
  if (m) {
    const head = _agTx(m[2]);
    if (head !== m[2]) return m[1] + head + _agTx(m[3]);
  }
  return out;
}

function _agPresentation(a, ak) {
  const aliases = { needmodel: 'nollm', auth: 'unauthed', probeFailed: 'bad' };
  const declared = a.setupState || a.displayState || a.state;
  let state = aliases[declared] || declared || (a.installed ? 'ready' : 'missing');
  if (!_AG_ST[state]) state = 'unknown';
  const issue = _agMessage(a.warnMessage || a.runtimeIssue || a.warnNow, '');
  // Older Runners collapsed incomplete installations and bundled setup into
  // missing. Recover only facts supported by their executable/core metadata.
  if (state === 'missing' && typeof a.present !== 'boolean') {
    if (a.key === 'harness2' && a.bundled) {
      state = /已停用|已卸载|未启用/.test(issue) ? 'disabled'
        : !issue || /需要 OpenCode|执行组件.*(?:尚未安装|未安装)/.test(issue) ? 'setup' : 'broken';
    } else if ((a.bin || a.version) && issue) state = 'broken';
  }
  if (['ready', 'ok', 'bad'].includes(state) && a.installed === false) {
    state = (a.present || a.bin) && issue ? 'broken' : 'missing';
  }
  const unknownAccount = state === 'unknown' && a.key === 'codex' && a.authStatus === 'unknown';
  const installed = (!['missing', 'setup', 'disabled', 'broken', 'unknown'].includes(state)
    || (unknownAccount && a.installed === true)) && a.installed !== false;
  const canProbe = installed && ['ready', 'ok', 'bad'].includes(state);
  let probe = a.probe || {};
  const activeJob = _agJobs[ak || a.key];
  const job = activeJob?.action === 'probe' ? activeJob : _agProbeResults.get(ak || a.key);
  const signature = probe.at ? JSON.stringify([probe.at, probe.ok, probe.detail]) : '';
  const recordAt = Number(probe.at || 0) * 1000;
  const startedAt = Number(job?.runnerStartedAt || job?.startedAt || 0);
  const finishedAt = Number(job?.runnerFinishedAt || job?.finishedAt || Date.now());
  const tolerance = job?.runnerFinishedAt ? 0 : 1000;
  // Bind a completed local result to its saved Runner record once observed.
  // Compare Runner timestamps on their own clock. Older identical messages
  // must not bind to this job, and later records must supersede retained ones.
  if (job?.state === 'done' && !job.recordSignature && signature
      && recordAt >= startedAt && recordAt <= finishedAt + tolerance
      && probe.ok === job.ok && probe.detail === job.detail) job.recordSignature = signature;
  const superseded = job?.recordSignature ? signature !== job.recordSignature
    : recordAt > finishedAt + tolerance;
  const currentJob = canProbe && job?.action === 'probe' && job.state === 'done'
    && job.context === _agProbeContext(a) && typeof job.ok === 'boolean' && !superseded;
  // Legacy Runners do not bind saved probes to configuration. Once this panel
  // has observed one, retain its original context across model/version changes.
  if (probe.at && probe.historical !== true) {
    const key = ak || a.key, signature = JSON.stringify([probe.at, probe.ok, probe.detail]);
    const binding = _agProbeBindings.get(key), context = _agProbeContext(a);
    if (binding?.signature === signature && binding.context !== context) probe = { ...probe, historical: true };
    else if (binding?.signature !== signature) _agProbeBindings.set(key, { signature, context });
  }
  if (currentJob) probe = { ...probe, ok: job.ok, detail: job.detail,
    at: (job.finishedAt || Date.now()) / 1000, historical: false,
    steps: recordAt >= startedAt ? probe.steps : [] };
  const probeCurrent = canProbe && probe.historical !== true && probe.stale !== true
    && typeof probe.ok === 'boolean';
  if (state === 'ready' && probeCurrent) state = probe.ok ? 'ok' : 'bad';
  const info = _AG_ST[state];
  const login = (state === 'unauthed' || (state === 'unknown' && a.authStatus === 'unknown'))
    && a.key === 'codex' && a.loginAvailable === true;
  const primaryAction = login ? 'login' : ['missing', 'setup', 'disabled', 'broken'].includes(state) ? 'install'
    : canProbe ? 'probe' : state === 'unknown' ? 'refresh' : 'details';
  const primaryLabel = { missing: '装上', setup: '准备组件', disabled: '启用', broken: '修复安装',
    nollm: '选择模型', unauthed: login ? '连接 Codex' : '查看登录说明', unknown: '重新探测' }[state] || '测一下';
  const reason = state === 'bad' ? _agMessage(null, '已安装，实际测试未通过。请查看下方测试结果并处理后重试。')
    : state === 'broken' ? issue || _agMessage(a.whyMessage || a.why, '安装组件无法正常启动，请修复后重试。')
    : state === 'unknown' ? _agMessage(null, '状态暂时无法识别，请重新探测。') : _agMessage(a.whyMessage || a.why, issue || '');
  return { state, label: info.t, tone: info.tone || state, reason, issue, installed, canProbe,
    primaryAction, primaryLabel, probe, probeCurrent };
}

function _agState(a, ak) { return _agPresentation(a, ak).state; }

function _agMachines() {
  // Never promote a legacy top-level payload or a cloud alias into this client.
  return (_agData?.machines || []).filter(m => m.runnerId &&
    (m.scope ? m.scope === 'current-instance' : m.isCurrentDevice === true));
}

function _agRender() {
  const box = document.getElementById('agBody');
  if (!box || !_agData) return;
  if (_agView === 'runners') {
    _agOpen = ''; _agDrawerSync();       /* Close agent details when switching to the Runner-node page. */
    box.innerHTML = window.RunnerManager
      ? RunnerManager.render(_agData.runners || []) : '<div class="ag-blank">运行节点组件没有加载</div>';
    if (window.RunnerManager) RunnerManager.bind(box, _agLoad, _agData.runners || []);
    _agTranslate(box);
    return;
  }
  /* Keep the current instance identity on every action, even when only one card group is visible. */
  const machines = _agMachines();
  box.innerHTML = '<div id="agCustomAgents"></div>' +
    (machines.length && _agData.modelCount === 0
      /* This is HTML; Markdown emphasis would render literally. */
      ? '<div class="ag-warn">你这台 SoduWork 现在一个模型都用不了，所以要模型的助手装了也派不了活。' +
        '先去「我的模型」配一把 key，再回来测。</div>'
      : '') +
    (machines.length ? machines.map(_agMachineHtml).join('')
      : '<div class="ag-blank">' + _AG_ICON + '<b>本机底座暂不可用</b><span>' +
        esc(_agData.env?.why || '当前客户端的 Runner 尚未连接，连接后会显示本机底座。') +
        '</span><span>云端底座请在「云端电脑」中管理。</span>' +
        '<button class="btn-mini" data-arefresh>重新探测</button></div>');
  _agDrawerSync();
  const wrap = document.getElementById('agDrawerWrap');
  if (wrap) _agBind(wrap);
  _agBind(box);
  window.CustomAgents?.mount(document.getElementById('agCustomAgents'));
  _agTranslate(box);
}

function _agMachineIdentity(m) {
  const facts = [m?.host, m?.os].filter(Boolean).join(' · ');
  return [_agEnvironmentLabel(m), m?.label || '本机', facts].filter(Boolean).join(' · ');
}

function _agEnvironmentLabel(m) {
  const label = m?.scope === 'current-instance' || m?.isCurrentDevice === true ? '当前客户端'
    : m?.scope === 'personal-cloud' ? '个人云端' : m?.scope === 'bound-runner' ? '关联执行机'
      : m?.execution === 'backend' ? '服务端环境' : '远程执行环境';
  return window.SoduWorkI18n?.translateText?.(label) || label;
}

function _agCanUninstall(a) {
  return !!a && a.key !== 'pi' && a.canUninstall !== false && (!a.bundled || a.key === 'harness2');
}

function _agMachineHtml(m) {
  const env = m.env || {};
  const list = (m.agents || []).slice();
  const presentation = a => _agPresentation(a, (m.runnerId ? m.runnerId + '~' : '') + a.key);
  list.sort((a, b) => (_AG_ST[presentation(a).state].o - _AG_ST[presentation(b).state].o) ||
    String(a.name || '').localeCompare(String(b.name || '')));
  const okN = list.filter(a => presentation(a).state === 'ok').length;
  const upN = list.filter(a => presentation(a).installed).length;
  const testN = list.filter(a => presentation(a).canProbe).length;
  const envCopy = env.ok
    ? '<span translate="no">Node ' + esc(env.node || '?') + ' · npm ' + esc(env.npm || '?') +
      '</span> · <span>每个助手可以单独指定模型，派活时按这里的选择执行。</span>'
    : '<span>运行环境会由 SoduWork 自动准备；无需手动安装 Node/npm。</span>';
  return '<section class="rn-section ag-section">' +
    '<div class="rn-section-head"><div><span class="cfg-eyebrow" data-i18n="eyebrow.my_agents">MY AGENTS</span>' +
      '<h3>本机 AI 助手</h3><p>' +
      envCopy +
      ' <span>安装、登录与测试仅作用于此环境。</span></p></div>' +
      '<div class="rn-overview"><span><b>' + upN + '</b> 已装</span>' +
      '<span><b>' + okN + '</b> 测通</span><span><b>' + list.length + '</b> 可管理</span></div>' +
    '</div>' +
    (okN === 0 && testN > 0
      ? '<div class="cfg-notice"><b>还没有测通的助手</b><span>点任一已安装助手上的「测一下」，会真跑一轮最小的活。</span></div>'
      : '') +
    (list.length
      ? '<div class="ag-grid">' + list.map(a => _agRowHtml(a, m)).join('') + '</div>'
      : '<div class="rn-none">' + _AG_ICON + '<div><b>这台机器上探不到助手</b><span>' +
        esc(env.why || '它可能刚掉线，请稍后重新打开这一页。') + '</span></div></div>') +
  '</section>';
}

/* One card per agent. Brand identifies the runtime; status describes availability. */
function _agRowHtml(a, m) {
  const rid = (m && m.runnerId) || '';
  const ak = (rid ? rid + '~' : '') + a.key;   /* Drawer identity includes the machine because runtimes can exist on several machines. */
  const status = _agPresentation(a, ak), s = status.state, p = status.probe;
  const displayName = _agCopy(a, 'name', a.name || a.key);
  const blurb = _agCopy(a, 'blurb', a.blurb || '');
  const busy = _agJobs[ak]?.state === 'running';
  const bundled = !!a.bundled;
  const bot = window.AgentBrand
    ? AgentBrand.html(a, { className: 'ag-agent-brand', title: displayName + ' 底座' })
    : '<span class="ag-ico">' + _AG_ICON + '</span>';
  return '<article class="ag-row st-' + status.tone + '" data-agstate="' + s + '" data-ak="' + esc(ak) + '">' +
    '<button class="ag-row-h" data-atoggle="' + esc(ak) + '">' +
      bot +
      '<span class="ag-main">' +
        '<span class="ag-l1">' +
          "<b class=\"ag-row-nm\"" + (a.name ? ' data-user-content' : '') + '>' + esc(displayName) + '</b>' +
          (a.version
            ? '<span class="ag-ver' + (a.verFrom === 'cli' ? ' is-guess' : '') + '" ' +
              'title="' + (a.verFrom === 'cli' ? '版本由程序自检得出' : '') + '">' +
              esc(typeof AgentBrand !== 'undefined' ? AgentBrand.version(a) : a.version) + (bundled && a.key !== 'harness2' ? ' · 内置' : '') + '</span>'
            : '') +
          /* Expose the current machine status even when the card is collapsed. */
          '<span class="cfg-state ag-row-st is-' + status.tone + '" title="' + esc(status.reason) + '">' + status.label + '</span>' +
          '<span class="ag-caret">▾</span>' +
        '</span>' +
        /* Allow two description lines instead of truncating them beside the status badge. */
        '<span class="ag-l2"><span class="ag-row-x" title="' + esc(blurb) + '">' +
          esc(blurb) + '</span></span>' +
      '</span>' +
    '</button>' +

    '<div class="ag-quick">' +
      '<button class="btn-mini primary" ' + ({ probe: 'data-aprobe', install: 'data-ainstall',
        details: 'data-atoggle', refresh: 'data-arefresh', login: 'data-alogin' }[status.primaryAction]) + '="' + esc(ak) + '"' +
        (busy ? ' disabled' : '') + '>' + status.primaryLabel + '</button>' +
      (p.at ? '<span class="ag-l2-t">' + (status.probeCurrent ? '上次测：' : '历史测试：') + _agAgo(p.at) + '</span>' : '<span></span>') +
      '<button class="btn-mini ag-more" data-atoggle="' + esc(ak) + '">详情</button>' +
    '</div>' +
  '</article>';
}





function _agDrawer() {
  if (!_agOpen || !_agData) return '';
  const { rid, key } = _agParse(_agOpen);
  const m = _agMachines().find(x => (x.runnerId || '') === rid);
  const a = m && (m.agents || []).find(x => x.key === key);
  if (!a) return '';
  const status = _agPresentation(a, _agOpen), s = status.state;
  const displayName = _agCopy(a, 'name', a.name || a.key);
  const bot = window.AgentBrand
    ? AgentBrand.html(a, { className: 'ag-agent-brand', title: displayName + ' 底座' })
    : '<span class="ag-ico">' + _AG_ICON + '</span>';
  return '<div class="ag-drawer-mask" data-adrawer-x="1"></div>' +
    '<aside class="ag-drawer" role="dialog" aria-modal="true" aria-label="' + esc(displayName) + ' 详情">' +
      '<header class="ag-drawer-head">' + bot +
        '<div class="ag-drawer-tt"><b' + (a.name ? ' data-user-content' : '') + '>' +
          esc(displayName) + '</b>' +
          (a.version ? '<span class="ag-ver">' + esc(typeof AgentBrand !== 'undefined' ? AgentBrand.version(a) : a.version) + (a.bundled && a.key !== 'harness2' ? ' · 内置' : '') + '</span>' : '') +
          '<span class="cfg-state is-' + status.tone + '">' + status.label + '</span></div>' +
        '<button class="btn-mini ag-drawer-x" data-adrawer-x="1" aria-label="关闭详情">✕</button>' +
      '</header>' +
      '<div class="ag-drawer-sub">装在 <span data-user-content>' + esc(_agMachineIdentity(m)) + '</span></div>' +
      '<div class="ag-drawer-body">' + _agBodyHtml(a, s, _agOpen) + '</div>' +
    '</aside>';
}

function _agDrawerSync() {
  let wrap = document.getElementById('agDrawerWrap');
  const html = _agDrawer();
  /*
   * Notify the separate pet-overlay window when opening/closing the drawer; CSS z-index
   * cannot move its overlapping navigation rail.
   */
  const open = !!html;
  if (open !== _agDrawerShown) {
    _agDrawerShown = open;
    try { if (window.soduWorkAPI && soduWorkAPI.broadcast) soduWorkAPI.broadcast('ag-drawer', open); }
    catch (e) { /* Skip the bridge in single-window mode. */ }
  }
  if (!html) { if (wrap) wrap.remove(); return; }
  const still = !!wrap;               /* Polling an open drawer must not replay its entrance animation. */
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'agDrawerWrap';
    document.body.appendChild(wrap);
  }
  wrap.innerHTML = html;
  _agTranslate(wrap);
  if (still) wrap.classList.add('is-still');
}
let _agDrawerShown = false;

/* Select the model for this agent.
   Offer the selector only for agents that use the shared model service. Claude Code and Codex
   use their own accounts and models; explain this instead of showing an ineffective selector,
   consistent with the milestone view. */
function _agModelHtml(a) {
  if (!a.modelPick) {
    return '<div class="ag-model is-own"><span class="ag-model-cap">模型</span>' +
      '<span class="ag-model-own">用它自己的账号与模型，这儿不用配</span></div>';
  }
  const list = (_agData && _agData.models) || [];
  if (!list.length) {
    return '<div class="ag-model is-none"><span class="ag-model-cap">模型</span>' +
      '<span class="ag-model-own">还没有能用的模型，先去「我的模型」配一把 key</span></div>';
  }
  const cur = a.model || '';
  const fallback = a.modelEffective || '';
  return '<div class="ag-model' + (a.modelGone ? ' is-bad' : '') + '">' +
    '<span class="ag-model-cap">模型</span>' +
    '<select class="ag-model-sel" data-amodel="' + esc(a.key) + '" data-amodel-value="' + esc(cur) + '">' +
      '<option value=""' + (cur ? '' : ' selected') + '>跟这台 SoduWork 的默认' +
        (fallback && !cur ? '（' + esc(fallback) + '）' : '') + '</option>' +
      list.map(m => '<option value="' + esc(m.name) + '"' +
        (m.name === cur ? ' selected' : '') + '>' + esc(m.label || m.name) +
        (m.provider ? ' · ' + esc(_agTx(m.provider)) : '') +
        (m.providerKind === 'anthropic' ? ' · Anthropic' : '') +
        (m.keyFrom === 'mine' ? ' · 走我的额度' : '') + '</option>').join('') +
      /*
       * Keep unavailable selected models visible and labeled rather than silently reverting the
       * user's choice.
       */
      (a.modelGone ? '<option value="' + esc(cur) + '" selected>' + esc(cur) + '（已不可用）</option>' : '') +
    '</select>' +
    (list.some(m => m.providerKind === 'anthropic')
      ? '<span class="ag-model-warn" role="note">企业模型对话通道只支持 OpenAI 兼容协议；列表中的 Anthropic 模型需使用支持其协议的 Agent。</span>' : '') +
    (a.modelGone
      ? '<span class="ag-model-warn">这个模型现在用不了，派活会退回默认' +
        (fallback ? '（' + esc(fallback) + '）' : '') + '</span>'
      : '') +
  '</div>';
}

function _agBodyHtml(a, s, ak) {
  ak = ak || a.key;
  const status = _agPresentation(a, ak);
  s = status.state;
  const job = _agJobs[ak];
  const busy = !!(job && job.state === 'running');
  const p = status.probe;
  const bundled = !!a.bundled;
  const dis = busy ? ' disabled' : '';
  const why = status.reason;
  const warn = _agMessage(a.warnMessage || a.warn, '');
  return '<div class="ag-row-b" id="ag-body-' + esc(ak) + '" role="region">' +
    '<div class="cfg-result is-' + status.tone + '"><span class="cfg-result-dot"></span>' +
      '<div><b>' + status.label + '</b><span>' + esc(why) + '</span></div></div>' +
    (status.issue && status.issue !== why ? '<div class="ag-note">' + esc(status.issue) + '</div>' : '') +
    (warn && !status.installed ? '<div class="ag-note">' + esc(warn) + '</div>' : '') +
    /* Group model settings with configuration instructions in the drawer. */
    _agModelHtml(a) +
    /* Keep installation facts separate from the latest real execution result. */
    (p.at ? '<div class="ag-probe is-' + (status.probeCurrent ? (p.ok ? 'ok' : 'bad') : 'ing') + '">' +
        '<span class="ag-p-t">' + (status.probeCurrent ? (p.ok ? '测通了' : '没通') : '历史测试') + '</span>' +
        '<span class="ag-p-d">' + esc(p.detail || '') + '</span>' +
        '<span class="ag-p-when">' + _agAgo(p.at) + '</span>' +
      '</div>' +
      (status.probeCurrent && (p.steps || []).length
        ? '<div class="ag-steps">' + p.steps.map(st =>
            '<div class="ag-step is-' + (st.ok ? 'ok' : 'bad') + '"><em>' +
            (st.ok ? '✓' : '✕') + '</em><span>' + esc(_agTx(st.name)) + '：' +
            esc(_agTx(st.detail || '')) + '</span></div>').join('') + '</div>'
        : '')
      : '') +
    '<div class="ag-cfg"><b>配置方式</b><span>' + esc(a.configHow || '') + '</span></div>' +
    (a.accountSetup?.command && a.auth !== 'authed'
      ? '<div class="ag-cfg"><b>官方账号授权</b><span>在此执行机的终端运行以下命令，按官方页面完成登录，再刷新状态。</span>' +
        '<small translate="no">' + esc(a.accountSetup.shell) + '</small><pre class="ag-log" translate="no">' + esc(a.accountSetup.command) + '</pre></div>' : '') +
    (a.key === 'codex' && a.loginAvailable === true
      ? '<div class="ag-cfg"><b>Codex 账号</b><span>优先使用这台机器已有的 Codex 登录；未登录时再由官方页面完成授权。</span>' +
        '<button class="btn-mini" data-alogin="' + esc(ak) + '"' + dis + '>连接 Codex</button></div>' : '') +
    (bundled ? '<div class="ag-cfg"><b>随 SoduWork 内置</b><span>' +
      (a.key === 'harness2'
        ? 'Harness² 核心及独立执行器随 SoduWork 升级，无需安装其他底座；停用会保留任务记录，点「启用」可重新启用。'
        : '安装包已包含 ' + esc(a.name || a.key) +
          '；升级 SoduWork 时会一起升级，不需要单独安装、更新或卸载。') + '</span></div>' : '') +
    /*
     * Tailor actions to installation state. Keep primary test/install actions on the card and
     * secondary actions in details without duplicates.
     */
    (bundled && a.key !== 'harness2' ? '' : '<div class="ag-ops">' +
      (status.installed || s === 'broken' || (a.present && a.key === 'harness2')
        ? '<button class="btn-mini" data-acheck="' + esc(ak) + '"' + dis + '>看看有没有新版</button>' +
          '<button class="btn-mini" data-ainstall="' + esc(ak) + '"' + dis + '>' +
            (status.installed ? '重装 / 升到最新' : status.primaryLabel) + '</button>' +
          (_agCanUninstall(a) ? '<span class="ag-spacer"></span>' +
          '<button class="btn-mini danger" data-aunin="' + esc(ak) + '"' + dis + '>卸载</button>' : '')
        : '<button class="btn-mini primary" data-ainstall="' + esc(ak) + '"' + dis + '>' + status.primaryLabel + '</button>' +
          '<button class="btn-mini" data-acheck="' + esc(ak) + '"' + dis + '>看看是哪一版</button>') +
      '</div>') +
    /*
     * Confirm uninstallation inline with its consequences rather than window.confirm.
     */
    (_agConfirm === ak && _agCanUninstall(a)
      ? '<div class="sch-confirm"><div>真的把 ' + esc(a.name) + ' 从执行机上卸掉？' +
        '<i>' + (a.key === 'harness2'
          ? '停用这台机器上的 Harness²，新任务不能再派给它；保留内置文件和任务记录。点「启用」可重新启用。'
          : '这台机器上所有人都会少一个能派活的助手；手上正在跑的活会失败。装回来只要点一次「装上」。') + '</i></div>' +
        '<div class="sch-c-ops">' +
        '<button class="btn-mini" data-acancel="1">算了</button>' +
        '<button class="btn-mini danger-solid" data-adoun="' + esc(ak) + '">确定卸载</button>' +
        '</div></div>'
      : '') +
    (job ? _agJobHtml(job) : '') +
    /* Place diagnostic paths and configuration files at the bottom. */
    '<details class="cfg-details"><summary>安装与配置信息</summary>' +
      '<div class="ag-facts">' +
        (a.bin ? '<span><em>可执行文件</em>' + esc(a.bin) + '</span>' : '') +
        (a.entry ? '<span><em>程序入口</em>' + esc(a.entry) + '</span>' : '') +
        (a.source
          ? '<span><em>程序来源</em>' + esc(a.source) + '</span>'
          : (a.pkg ? '<span><em>npm 包</em>' + esc(a.pkg) + '</span>' : '')) +
        (a.configPath
          ? '<span><em>配置文件</em>' + esc(a.configPath) +
            (a.configReady ? '' : '（测一次后自动创建）') + '</span>'
          : '') +
      '</div>' +
    '</details>' +
  '</div>';
}

function _agJobHtml(job) {
  if (job.action === 'login' || job.action === 'login-isolated') return '<div class="ag-cfg"><b>Codex 账号</b><span>请在授权窗口中查看登录进度。</span></div>';
  const running = job.state === 'running';
  const title = { install: '正在安装', repair: '正在修复安装', update: '正在安装', uninstall: '正在卸载',
                  check: '正在查版本', probe: '正在测', login: '等待官方登录授权' }[job.action] || '正在跑';
  const failed = { install: '安装未完成', repair: '修复未完成', update: '更新未完成', uninstall: '卸载未完成',
    check: '版本检查未完成', probe: '实际测试未通过', login: '登录未完成' }[job.action] || '操作未完成';
  const harnessProbe = job.action === 'probe' && _agParse(job.key).key === 'harness2';
  const runningHint = job.action === 'login'
    ? '请按下方官方地址与设备码完成登录。此操作不启动模型对话。'
    : harnessProbe
    ? '验证 Harness² 独立执行器；不运行推演，会使用所选模型额度，最多 3 分钟。'
    : '这一步可能要几十秒，日志在下面滚';
  /* Log lines live inside <pre data-alog>, which the DOM adapter deliberately
   * leaves alone; translate each line here instead. The head-model filter in
   * _agPoll still matches the original Chinese prefix on raw j.lines. */
  const lines = (job.lines || []).slice(-40).map(l => esc(_agTx(l))).join('\n');
  return '<div class="ag-job' + (harnessProbe ? ' is-harness2-probe' : '') + '">' +
    '<div class="ag-job-h">' +
      (running ? '<span class="ag-spin"></span>' : '') +
      '<b>' + (running ? _agTx(title) + '…' : (job.ok ? _agTx('完成') : _agTx(failed))) + '</b>' +
      '<span>' + esc(_agTx(job.detail || (running ? runningHint : ''))) + '</span>' +
      (running ? '' : '<button class="ag-job-t btn-mini" data-aclose="' + esc(job.key) + '">收起</button>') +
    '</div>' +
    '<pre class="ag-log" data-alog="' + esc(job.key) + '">' + lines + '</pre>' +
  '</div>';
}

function _agAgo(sec) {
  const d = Date.now() / 1000 - Number(sec || 0);
  if (!sec || d < 0) return '';
  if (d < 60) return _agTx('刚刚');
  if (d < 3600) return _agTx(Math.floor(d / 60) + ' 分钟前');
  if (d < 86400) return _agTx(Math.floor(d / 3600) + ' 小时前');
  return _agTx(Math.floor(d / 86400) + ' 天前');
}

function _agBind(box) {
  box.querySelectorAll('[data-atoggle]').forEach(el => el.addEventListener('click', () => {
    const k = el.getAttribute('data-atoggle');
    _agOpen = (_agOpen === k) ? '' : k;      /* Expand only one item at a time. */
    _agConfirm = '';
    _agRender();
  }));
  /* Close via backdrop or close button; Escape is handled by the panel-level listener. */
  box.querySelectorAll('[data-adrawer-x]').forEach(el => el.addEventListener('click', () => {
    _agOpen = ''; _agConfirm = '';
    _agRender();
  }));
  /*
   * Save model selection immediately and disable the selector until completion to prevent
   * out-of-order updates.
   */
  box.querySelectorAll('[data-amodel]').forEach(el => el.addEventListener('change', async () => {
    const scope = _agScopeEpoch;
    const key = el.getAttribute('data-amodel');
    const val = el.value || '';
    const before = el.getAttribute('data-amodel-value') || '';
    el.disabled = true;
    try {
      await SoduWorkAPI.setAgentModel(key, val);
      if (scope !== _agScopeEpoch) return;
      try { window.soduWorkAPI?.broadcast?.('models'); } catch (_) {}
      const hit = (_agData?.agents || []).find(x => x.key === key);
      for (const ak of _agProbeResults.keys()) {
        if (_agParse(ak).key === key) _agProbeResults.delete(ak);
      }
      Object.keys(_agJobs).forEach(ak => {
        const job = _agJobs[ak];
        if (_agParse(ak).key === key && job.action === 'probe' && job.state === 'done') job.context = '';
      });
      if (hit) { hit.model = val; hit.modelGone = false; }
      if (typeof petSay === 'function') {
        petSay(val ? ('好，' + ((hit && hit.name) || key) + ' 以后用 ' + val)
          : (((hit && hit.name) || key) + ' 改回跟默认模型走'));
      }
      await _agLoad(true);                 /* Recheck readiness after a model change. */
    } catch (e) {
      if (scope !== _agScopeEpoch) return;
      el.value = before;                   /* Restore the saved selection if persistence fails. */
      el.disabled = false;
      if (typeof petSay === 'function') {
        petSay(typeof _humanErr === 'function' ? _humanErr(e, '模型没存上') : '模型没存上');
      }
    }
  }));
  box.querySelectorAll('[data-ainstall]').forEach(el => el.addEventListener('click',
    () => _agRun(el.getAttribute('data-ainstall'), 'install')));
  box.querySelectorAll('[data-acheck]').forEach(el => el.addEventListener('click',
    () => _agRun(el.getAttribute('data-acheck'), 'check')));
  box.querySelectorAll('[data-aprobe]').forEach(el => el.addEventListener('click',
    () => _agRun(el.getAttribute('data-aprobe'), 'probe')));
  box.querySelectorAll('[data-alogin]').forEach(el => el.addEventListener('click',
    () => _agRun(el.getAttribute('data-alogin'), 'login')));
  box.querySelectorAll('[data-arefresh]').forEach(el => el.addEventListener('click', () => _agLoad(true)));
  box.querySelectorAll('[data-aunin]').forEach(el => el.addEventListener('click', () => {
    _agConfirm = el.getAttribute('data-aunin');
    _agRender();
  }));
  box.querySelectorAll('[data-acancel]').forEach(el => el.addEventListener('click', () => {
    _agConfirm = '';
    _agRender();
  }));
  box.querySelectorAll('[data-adoun]').forEach(el => el.addEventListener('click', () => {
    const k = el.getAttribute('data-adoun');
    _agConfirm = '';
    _agRun(k, 'uninstall');
  }));
  box.querySelectorAll('[data-aclose]').forEach(el => el.addEventListener('click', () => {
    delete _agJobs[el.getAttribute('data-aclose')];
    _agRender();
  }));
  /* Follow the latest job-log lines while execution is active. */
  box.querySelectorAll('[data-alog]').forEach(el => { el.scrollTop = el.scrollHeight; });
}

/*
 * ak combines runnerId and runtime key, with a legacy single-host form. Always pass
 * runnerId for machine-specific install/remove/test actions.
 */
function _agParse(ak) {
  const i = String(ak || '').indexOf('~');
  return i < 0 ? { rid: '', key: String(ak || '') }
    : { rid: ak.slice(0, i), key: ak.slice(i + 1) };
}

async function _agRun(ak, action) {
  _agEnsureScope();
  if (!ak) return;
  const { rid, key } = _agParse(ak);
  const scope = _agScopeEpoch;
  const ownerScope = _agScope;
  const agent = (_agMachines().find(m => (m.runnerId || '') === rid)?.agents || []).find(a => a.key === key);
  if (!agent) return;
  if (action === 'uninstall' && !_agCanUninstall(agent)) return;
  const previousJob = _agJobs[ak];
  if (previousJob?.state === 'running') return;
  if (action === 'login' || (action === 'probe' && key === 'codex' && agent?.auth === 'unauthed')) {
    if (key !== 'codex' || agent?.loginAvailable !== true) return;
    if (!window.CodexAuthDialog) { if (typeof petSay === 'function') petSay('登录窗口未加载，请更新 SoduWork 后重试。'); return; }
    const machine = _agMachines().find(m => (m.runnerId || '') === rid);
    return window.CodexAuthDialog.open({ runnerId: rid, machine: _agMachineIdentity(machine),
      onDone: () => { if (scope === _agScopeEpoch) void _agLoad(true); },
      onProbe: async () => {
        if (scope !== _agScopeEpoch) return;
        await _agLoad(true);
        if (scope === _agScopeEpoch) await _agRun(ak, 'probe');
      } });
  }
  if (action === 'probe' && agent && !_agPresentation(agent, ak).canProbe) return;
  if (action !== 'check') _agProbeResults.delete(ak);
  _agOpen = ak;                                   /* Keep the selected agent drawer open. */
  const job = _agJobs[ak] = { key: ak, action: action, state: 'running', lines: [], detail: '',
    scope, startedAt: Date.now(), context: agent ? _agProbeContext(agent) : '' };
  _agRender();
  try {
    const r = action === 'probe'
      ? await SoduWorkAPI.agentProbe(key, '', rid)
      : await SoduWorkAPI.agentInstall(key, action === 'repair' ? 'update' : action, rid);
    if (scope !== _agScopeEpoch || ownerScope !== _agOwnerScope() || _agJobs[ak] !== job) return;
    if (!r || !r.jobId) throw new Error('后端没给作业号');
    _agJobs[ak].jobId = r.jobId;
    if (action === 'probe' && r.model) {
      _agJobs[ak].lines.push('用的模型：' + r.model +
        (r.keyFrom === 'mine' ? '（走我自己的额度）' : '（走公司那把）'));
      /*
       * Disclose fallback when the requested model is unavailable so a successful probe is not
       * attributed to the wrong model.
       */
      if (r.fellBackFrom) {
        _agJobs[ak].lines.push('⚠ 你指定的「' + r.fellBackFrom + '」现在用不了，这一轮退回了默认模型');
      }
    }
    _agPoll();
  } catch (e) {
    if (scope !== _agScopeEpoch || ownerScope !== _agOwnerScope() || _agJobs[ak] !== job) return;
    _agJobs[ak] = { key: ak, action: action, state: 'done', ok: false, lines: [],
                     detail: (typeof _humanErr === 'function' ? _humanErr(e, '没发起来') : '没发起来') };
    _agRender();
  }
}

/* Use one timer to poll all active jobs. */
function _agPoll() {
  if (_agTimer) return;
  let polling = false;
  const timer = _agTimer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
    const scope = _agScopeEpoch;
    const ownerScope = _agOwnerScope();
    const live = Object.values(_agJobs).filter(j => j.state === 'running' && j.jobId);
    if (!live.length) { clearInterval(_agTimer); _agTimer = null; return; }
    let changed = false, finished = false;
    for (const j of live) {
      let g = null;
      try { g = await SoduWorkAPI.agentJob(j.jobId); } catch (e) { g = null; }
      if (scope !== _agScopeEpoch || ownerScope !== _agOwnerScope() || _agTimer !== timer) return;
      if (_agJobs[j.key] !== j) continue;
      if (!g) continue;
      const before = (j.lines || []).length;
      /* Preserve the initial effective-model log entry and append backend logs after it. */
      const head = j.lines.filter(l => l.indexOf('用的模型：') === 0);
      j.lines = head.concat(g.lines || []);
      if (j.lines.length !== before) changed = true;
      if (g.state === 'done') {
        j.state = 'done'; j.ok = g.ok; j.detail = g.detail || '';
        j.finishedAt = Date.now();
        if (Number.isFinite(g.startedAt) && g.startedAt > 0) j.runnerStartedAt = g.startedAt * 1000;
        if (Number.isFinite(g.endedAt) && g.endedAt > 0) j.runnerFinishedAt = g.endedAt * 1000;
        if (j.action === 'probe') _agProbeResults.set(j.key, { ...j, lines: [] });
        changed = true; finished = true;
      }
    }
    if (finished) {
      /* Re-probe after installation or testing to replace stale availability results. */
      try { window.soduWorkAPI?.broadcast?.('agent-runtimes-changed'); } catch (_) {}
      if (document.getElementById('agPanel')?.classList.contains('show')) await _agLoad(true);
    } else if (changed && document.getElementById('agPanel')?.classList.contains('show')) {
      _agRender();
    }
    } finally { polling = false; }
  }, 900);
}
