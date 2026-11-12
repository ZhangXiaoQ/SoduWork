




















let _mdData = null;                 /* {providers, usable, myModels} */
let _mdKeyEdits = {};               /* New provider keys remain in memory until saved. */
let _mdMyModels = [];               /* Current custom-model edits. */
let _mdOpen = '';                   /* Expand one provider at a time. */
let _mdQuery = '';
let _mdDirty = false;
let _mdTest = {};                   /* providerId -> {state:'ing'|'ok'|'bad', detail} */
let _mdEditor = '';                 /* A native child window edits one provider; empty selection indicates the overview. */
let _mdNew = null;                  /* New-provider draft. */
let _mdDeletePending = '';
let _mdLoadId = 0;
let _mdLoadState = 'idle';
let _mdRefreshFlight = null;

const _MD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"/>' +
  '<rect x="14" y="14" width="7" height="7" rx="2"/><path d="M14 6h2a2 2 0 0 1 2 2v2M6 14v2a2 2 0 0 0 2 2h2"/></svg>';
const _MD_TYPES = { chat: '对话模型', image: '图片生成', video: '视频生成' };
function _mdType(value) { return _MD_TYPES[value] ? value : 'chat'; }
function _mdTypeOptions(value) {
  const current = _mdType(value);
  return Object.keys(_MD_TYPES).map((key) => '<option value="' + key + '"' +
    (key === current ? ' selected' : '') + '>' + _MD_TYPES[key] + '</option>').join('');
}

const _MD_THINKING_MODES = { auto: '\u81ea\u52a8\u8bc6\u522b', controllable: '\u53ef\u5173\u95ed\uff08\u9ed8\u8ba4\u5173\u95ed\uff09', always: '\u4e0d\u53ef\u5173\u95ed\uff08\u9ed8\u8ba4\u5f00\u542f\uff09', none: '\u65e0\u601d\u8003\u6a21\u5f0f' };
function _mdThinkingOptions(value) {
  const current = Object.prototype.hasOwnProperty.call(_MD_THINKING_MODES, value) ? value : 'auto';
  return Object.keys(_MD_THINKING_MODES).map((key) => '<option value=\"' + key + '\"' +
    (key === current ? ' selected' : '') + '>' + _MD_THINKING_MODES[key] + '</option>').join('');
}

function openModelsPanel(options) {
  const opts = options || {};
  _mdEditor = opts.editor ? String(opts.providerId || '') : '';
  if (_mdEditor.indexOf('__new__:') === 0 || _mdEditor === '__new__') {
    const id = _mdEditor.split(':')[1] || ('custom-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 7));
    _mdNew = { id, name: '', kind: 'openai-compat', baseUrl: '', defaultBaseUrl: '',
      personal: true, authMode: 'key', modelNames: [], note: '', myKeySet: false, keySet: false };
  }
  let p = document.getElementById('mdPanel');
  if (!p) {
    p = document.createElement('div');
    p.id = 'mdPanel'; p.className = 'sch-panel cfg-panel';
    p.innerHTML =
      '<div class="sch-head ws-page-head">' +
      '<span class="sch-h-ico">' + _MD_ICON + '</span>' +
      '<div class="sch-h-txt"><span class="sch-h-kicker" data-i18n="eyebrow.model_routing">MODEL ROUTING</span><b class="sch-h-title">我的模型</b>' +
      '<i class="sch-h-sub">管理个人额度、可用模型与自定义服务</i></div>' +
      '<div class="sch-h-acts">' +
      '<button class="btn-mini primary" id="mdSave" disabled>保存</button>' +
      '<button class="np-close" id="mdClose">✕</button></div></div>' +
      '<div class="sch-body" id="mdBody"></div>';
    document.body.appendChild(p);
    document.getElementById('mdClose').addEventListener('click', closeModelsPanel);
    document.getElementById('mdSave').addEventListener('click', () => _mdSave(false));
    if (typeof makeDraggable === 'function') makeDraggable(p, p.querySelector('.sch-head'));
  }
  p.classList.add('md-master-panel');
  const title = p.querySelector('.sch-h-title');
  const kicker = p.querySelector('.sch-h-kicker');
  const sub = p.querySelector('.sch-h-sub');
  if (title) title.textContent = '我的模型';
  if (kicker) kicker.textContent = 'MODEL CONNECTIONS';
  if (sub) sub.textContent = '管理服务连接、个人凭据与可选模型';
  const save = document.getElementById('mdSave');
  if (save) save.hidden = false;
  p.classList.add('show');
  if (typeof expandForOverlay === 'function') expandForOverlay();
  _mdLoad();
}

function closeModelsPanel() {
  ++_mdLoadId;
  _mdLoadState = 'idle';
  const p = document.getElementById('mdPanel');
  if (p) p.classList.remove('show');
  if (typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
}

async function _mdLoad() {
  const box = document.getElementById('mdBody');
  if (!box) return;
  const loadId = ++_mdLoadId;
  const current = () => loadId === _mdLoadId && document.getElementById('mdBody') === box;
  const previous = { data: _mdData, keys: _mdKeyEdits, models: _mdMyModels,
    dirty: _mdDirty, editor: _mdEditor, draft: _mdNew };
  let timer, rendering = false;
  _mdLoadState = 'loading';
  box.setAttribute('aria-busy', 'true');
  _mdMark();
  if (!_mdData) box.innerHTML = '<div class="md-load"><i></i><i></i><i></i><span>正在看有哪些模型能用…</span></div>';
  try {
    const r = await Promise.race([
      Promise.resolve().then(() => SoduWorkAPI.myModels()),
      new Promise((_, reject) => { timer = setTimeout(() => {
        const error = new Error('Model catalog load timed out');
        error.code = 'MODEL_LOAD_TIMEOUT'; reject(error);
      }, 20000); })
    ]);
    if (!current()) return false;
    if (!r || !['providers', 'usable', 'myModels'].every(key => Array.isArray(r[key])) ||
        r.providers.some(p => !p || typeof p.id !== 'string') ||
        r.myModels.some(m => !m || typeof m.name !== 'string')) {
      const error = new Error('Invalid model catalog'); error.code = 'MODEL_CATALOG_INVALID'; throw error;
    }
    rendering = true;
    _mdData = r;
    _mdReconcileChecks(r);
    if (_mdNew && _mdEditor.indexOf('__new__') === 0) {
      const saved = r.providers.find((p) => p.id === _mdNew.id);
      if (saved) { _mdEditor = saved.id; _mdNew = null; }
    }
    _mdKeyEdits = {};
    _mdMyModels = r.myModels.slice();
    _mdDirty = false;
    _mdRender();
    _mdLoadState = 'ready';
    return true;
  } catch (error) {
    if (!current()) return false;
    _mdData = previous.data; _mdKeyEdits = previous.keys; _mdMyModels = previous.models;
    _mdDirty = previous.dirty; _mdEditor = previous.editor; _mdNew = previous.draft;
    _mdLoadState = 'error';
    const message = rendering ? '页面显示遇到问题，请重试。已有模型配置未被修改。' :
      error?.code === 'MODEL_CATALOG_INVALID' ? '模型清单格式异常，请重试。已有模型配置未被修改。' :
      error?.status === 401 ? '登录状态已失效，请重新登录后重试。' :
      error?.status === 403 ? '暂时无法访问模型清单，请检查账号权限后重试。' :
      ['MODEL_LOAD_TIMEOUT', 'DEVICE_AUTH_INIT_TIMEOUT'].includes(error?.code) || error?.name === 'TimeoutError' || error?.name === 'AbortError' ?
        '加载超时，请检查服务连接后重试。' : '暂时无法获取模型清单，请检查服务连接后重试。';
    box.innerHTML = '<div class="md-blank" role="alert" data-md-load-error>' + _MD_ICON +
      '<b>模型页面未能加载</b><span>' + message + '</span>' +
      '<button class="md-addbtn" id="mdRetry">重新加载</button></div>';
    document.getElementById('mdRetry')?.addEventListener('click', _mdLoad);
    return false;
  } finally {
    clearTimeout(timer);
    if (current()) { box.removeAttribute('aria-busy'); _mdMark(); }
  }
}

/* Provider status precedence: personal credentials, company credentials, missing key, missing endpoint. */
function _mdState(p) {
  if (p.authMode === 'none' && p.baseUrl) return 'local';
  if (p.myKeySet || _mdKeyEdits[p.id]) return 'mine';
  if (p.keySet) return 'org';
  return p.baseUrl ? 'open' : 'noaddr';
}
const _MD_ST = {
  local: { t: '本地可用', o: 0 },
  mine: { t: '个人额度', o: 0 },
  org: { t: '公司可用', o: 1 },
  open: { t: '填写 Key', o: 2 },
  noaddr: { t: '需补地址', o: 3 },
};

function _mdRender() {
  const box = document.getElementById('mdBody');
  if (!box || !_mdData) return;
  const chatUsable = _mdData.usable || [];
  const mediaUsable = _mdData.mediaUsable || {};
  const usable = chatUsable.concat(mediaUsable.image || [], mediaUsable.video || []);
  const all = (_mdData.providers || []).slice();
  if (_mdNew && !all.some((p) => p.id === _mdNew.id)) all.unshift(_mdNew);
  const q = _mdQuery.trim().toLowerCase();
  const visible = all.filter((p) => !q ||
    String(p.name || '').toLowerCase().includes(q) ||
    String(p.id || '').toLowerCase().includes(q) ||
    (p.modelNames || []).some((n) => String(n).toLowerCase().includes(q)));
  const sorted = all.slice().sort((a, b) => (_MD_ST[_mdState(a)].o - _MD_ST[_mdState(b)].o) ||
    String(a.name || '').localeCompare(String(b.name || '')));
  const requested = _mdOpen || (_mdEditor.indexOf('__new__:') === 0 ? _mdEditor.split(':')[1] : _mdEditor);
  let target = all.find((p) => String(p.id) === String(requested || '')) || sorted[0] || null;
  if (target) _mdOpen = target.id;

  const active = visible.filter((p) => ['local', 'mine', 'org'].includes(_mdState(p)));
  const available = visible.filter((p) => _mdState(p) === 'open');
  const advanced = visible.filter((p) => _mdState(p) === 'noaddr');
  const mineN = usable.filter((m) => m.keyFrom === 'mine').length;
  const homes = new Set(usable.map((m) => m.providerId)).size;

  box.innerHTML = '<div class="cfg-master-detail md-master-detail">' +
    '<aside class="cfg-master md-master" aria-label="模型服务">' +
      '<div class="cfg-master-head"><span>模型服务</span>' +
        '<strong>' + _mdMessage('models.available', '{count} 个可选模型', { count: usable.length }) + '</strong>' +
        '<small>' + _mdMessage('models.types', '{chat} 个聊天 · {image} 个图片 · {video} 个视频', { chat: chatUsable.length, image: (mediaUsable.image || []).length, video: (mediaUsable.video || []).length }) + '</small>' +
        '<small>' + _mdMessage('models.providers', '{count} 家服务已配置 · {personal} 个使用个人额度', { count: homes, personal: mineN }) + '</small></div>' +
      '<div class="cfg-master-actions">' +
        '<label class="cfg-master-search"><span>搜索模型服务</span><input id="mdQ" class="md-q" value="' +
          esc(_mdQuery) + '" placeholder="搜索服务或模型"></label>' +
        '<button type="button" class="cfg-master-add" id="mdAddInline">＋ 添加服务</button></div>' +
      '<div class="cfg-master-scroll">' + (visible.length
        ? _mdNavGroupHtml('正在使用', active) +
          _mdNavGroupHtml('可配置服务', available) +
          _mdNavGroupHtml('高级与自定义', advanced)
        : '<div class="cfg-master-empty">' + _mdMessage('models.noResults', '没有匹配“{query}”的服务或模型', { query: _mdQuery }) + '</div>') +
      '</div>' +
    '</aside>' +
    '<main class="cfg-detail md-detail" aria-live="polite">' +
      (target ? _mdDetailHtml(target) : '<div class="cfg-detail-empty">' + _MD_ICON +
        '<b>还没有模型服务</b><span>从左侧添加一个 OpenAI 兼容或 Anthropic 服务。</span>' +
        '<button type="button" class="cfg-master-add" id="mdEmptyAdd">添加服务</button></div>') +
    '</main></div>';

  _mdBind(box);
  const emptyAdd = document.getElementById('mdEmptyAdd');
  if (emptyAdd) emptyAdd.addEventListener('click', _mdAddService);
  _mdMark();
}

function _mdNavGroupHtml(title, rows) {
  if (!rows.length) return '';
  return '<section class="cfg-nav-group"><header><span>' + title + '</span><em>' + rows.length +
    '</em></header><div>' + rows.map(_mdNavItemHtml).join('') + '</div></section>';
}

function _mdNavItemHtml(p) {
  const state = _mdState(p);
  const own = _mdMyModels.filter((m) => m.providerId === p.id);
  const count = (p.modelDefs || p.modelNames || []).length + own.length;
  const selected = String(_mdOpen) === String(p.id);
  return '<button type="button" class="cfg-nav-item md-nav-item st-' + state +
    (selected ? ' is-selected' : '') + '" data-mdselect="' + esc(p.id) + '" aria-pressed="' +
    (selected ? 'true' : 'false') + '">' +
      '<span class="md-provider-icon">' + _MD_ICON + '<i class="cfg-nav-dot"></i></span><span class="cfg-nav-copy"><b data-user-content>' + esc(p.name || p.id) + '</b>' +
        '<small>' + esc(_mdHost(p.baseUrl) || '未填写服务地址') + '</small></span>' +
      '<span class="cfg-nav-meta"><em>' + _mdMessage('models.count', '{count} 模型', { count }) + '</em><small>' + _MD_ST[state].t + '</small></span>' +
    '</button>';
}

function _mdDetailHtml(p) {
  const state = _mdState(p);
  const models = (p.modelDefs || []).length
    ? p.modelDefs
    : (p.modelNames || []).map((name) => ({ name, label: name, modality: 'chat', config: {} }));
  const own = _mdMyModels.filter((m) => m.providerId === p.id);
  const test = _mdTest[p.id];
  const count = models.length + own.length;
  const host = _mdHost(p.baseUrl) || '尚未连接';
  const route = state === 'mine' ? '使用你的个人额度' : state === 'org' ? '使用公司统一额度' :
    state === 'local' ? '本机免密服务' : '完成配置后可用';
  return '<header class="cfg-detail-head">' +
      '<span class="cfg-detail-icon">' + _MD_ICON + '</span>' +
      '<div class="cfg-detail-title"><span>模型服务</span><h2' + (p.name ? ' data-user-content' : '') + '>' + esc(p.name || '添加模型服务') + '</h2>' +
        '<p><span' + (_mdHost(p.baseUrl) ? ' data-user-content' : '') + '>' + esc(host) + '</span> · <span>' + esc(route) + '</span></p></div>' +
      '<span class="cfg-state is-' + state + '">' + _MD_ST[state].t + '</span></header>' +
    '<div class="cfg-detail-facts"><span><small>接口协议</small><b>' +
      (p.kind === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容') + '</b></span>' +
      '<span><small>模型数量</small><b>' + _mdMessage('models.itemCount', '{count} 个', { count }) + '</b></span>' +
      '<span><small>凭据来源</small><b>' + esc(route) + '</b></span>' +
      '<span><small>连接状态</small><b>' + (test ? (test.state === 'ing' ? '正在验证' : test.state === 'ok' ? '连接通过' : '验证未通过') : '待验证') + '</b></span></div>' +
    '<div class="cfg-detail-scroll">' +
      '<div class="md-editor-form st-' + state + '">' + _mdBodyHtml(p, state, models, own, test) + '</div>' +
    '</div>';
}

function _mdBodyHtml(p, s, ms, own, t) {
  return '<div class="md-row-b" id="md-body-' + esc(p.id) + '" role="region">' +
    '<section class="md-settings-section"><header class="md-section-heading"><b>连接设置</b><small>填写服务提供的 API 地址</small></header>' +
    '<div class="md-connect-fields">' +
      (p.personal ? '<label class="md-field"><span>服务名称</span><input class="md-in" data-pname="' +
        esc(p.id) + '" value="' + esc(p.name || '') + '" placeholder="例如：本机 Ollama"></label>' : '') +
      '<label class="md-field md-field-wide"><span>API 地址</span><input class="md-in" data-purl="' +
        esc(p.id) + '" value="' + esc(p.baseUrl || '') + '" placeholder="https://…/v1"></label>' +
      (p.personal ? '<label class="md-field"><span>接口协议</span><select class="md-in" data-pkind="' +
        esc(p.id) + '"><option value="openai-compat"' + (p.kind !== 'anthropic' ? ' selected' : '') +
        '>OpenAI 兼容</option><option value="anthropic"' + (p.kind === 'anthropic' ? ' selected' : '') +
        '>Anthropic</option></select></label>' +
        '<label class="md-auth-toggle"><input type="checkbox" data-pnoauth="' + esc(p.id) + '"' +
          (p.authMode === 'none' ? ' checked' : '') + '><span>本地服务无需密钥</span></label>' : '') +
      (!p.personal && p.addressOverridden ? '<button class="md-link md-reset-url" data-preset="' + esc(p.id) +
        '">恢复组织默认地址</button>' : '') +
    '</div>' + (p.kind === 'anthropic'
      ? '<p class="md-model-help" role="note">Anthropic 协议：连接测试通过也不能用于当前企业模型对话通道。请为该通道配置供应商的 OpenAI 兼容地址与对应密钥；此配置可保留给支持 Anthropic 的 Agent。</p>' : '') +
    '</section><section class="md-settings-section md-credentials">' +
    '<header class="md-section-heading"><b>访问凭据</b><small>密钥保存后只显示配置状态，不回显明文</small></header>' +
    '<p class="md-model-help">连接测试优先读取模型列表；列表可访问不代表聊天生成、余额或当前 Agent 的协议兼容性已验证。列表接口不可用时会尝试一个最小聊天请求，可能产生用量。</p>' +
    (p.authMode !== 'none'
      ? '<label class="md-key-label" for="md-key-input">个人 API Key</label>' +
        '<div class="md-keyrow">' +
          '<input type="password" class="md-in" id="md-key-input" data-pkey="' + esc(p.id) + '" ' +
            'autocomplete="new-password" placeholder="' +
            (p.myKeySet ? '输入新的以替换，留空则不改'
                        : (p.keySet ? '公司那把已经能用；想走自己的额度就贴自己的'
                                    : '粘贴你自己的 API Key')) + '">' +
          '<button class="md-eye" data-peye="' + esc(p.id) + '" aria-pressed="false" title="只显示本次输入的内容">显示</button>' +
          '<button class="md-test primary" data-ptest="' + esc(p.id) + '"' + (t && t.state === 'ing' ? ' disabled' : '') + '>' + (t && t.state === 'ing' ? '测试中…' : '保存并测试连接') + '</button>' +
        '</div>' +
        '<div class="md-meta">' +
          (p.myKeySet ? '<div class="md-personal-key-card"><div class="md-personal-key-copy">' +
                          '<b>当前使用这个模型的个人 Key</b><span>' + _mdMessage('models.keyLength', '个人 Key 已配置 · {count} 位，请求会优先使用你的个人额度', { count: p.myKeyLen }) + '</span>' +
                        '</div><button type="button" class="md-clear-key" data-pclear="' + esc(p.id) + '" aria-label="停止使用个人额度" title="停止使用个人额度"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.25"></circle><path d="M6.5 10h7"></path></svg><span>停止使用个人额度</span></button></div>'
                      : (p.keySet ? '<div class="md-key-fallback"><b>当前使用公司凭据</b><span>公司已配置这家服务，你也可以随时切回个人 Key</span></div>'
                                  : '<div class="md-key-fallback"><b>还没有可用凭据</b><span>公司未配置这家服务，请填写你的个人 API Key</span></div>')) +
          (t ? '<span role="status" class="md-test-r is-' + t.state + '">' +
                 (t.state === 'ing' ? '正在测…' : esc(t.detail || '')) + '</span>' : '') +
        '</div>'
      : '<div class="md-keyrow md-noauth"><span>免密连接</span><small>适用于本机 Ollama、vLLM 等可信服务</small>' +
          '<button class="md-test primary" data-ptest="' + esc(p.id) + '"' + (t && t.state === 'ing' ? ' disabled' : '') + '>保存并测试连接</button></div>' +
          (t ? '<span role="status" class="md-test-r is-' + t.state + '">' + esc(t.detail || '正在测试…') + '</span>' : '')) +
    '</section>' +
    '<section class="cfg-subsection"><div class="cfg-subsection-h"><b>模型清单</b><span>' +
      _mdMessage('models.itemCount', '{count} 个', { count: ms.length + own.length }) + '</span></div>' +
      '<p class="md-model-help">对话模型可单独支持图片输入；图片生成和视频生成用于创作成果。</p>' +
      _mdModelListHtml(p, ms, own) + _mdModelEditorHtml(p) + '</section>' +
    (p.personal ? '<div class="md-editor-danger"><button class="md-link' +
      (_mdDeletePending === p.id ? ' is-confirm' : '') + '" data-pdelete="' + esc(p.id) + '">' +
      (_mdDeletePending === p.id ? '再次点击，确认删除' : '删除这个模型服务') + '</button></div>' : '') +
  '</div>';
}

function _mdHost(raw) {
  try { return new URL(String(raw || '')).host; } catch (e) { return ''; }
}

function _mdAddService() {
  const id = 'custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  _mdNew = { id, name: '', kind: 'openai-compat', baseUrl: '', defaultBaseUrl: '',
    personal: true, authMode: 'key', modelNames: [], note: '', myKeySet: false, keySet: false };
  _mdEditor = '__new__:' + id;
  _mdOpen = id;
  _mdRender();
}

function _mdProvider(pid) {
  if (String(pid || '').indexOf('__new__') === 0) return _mdNew;
  if (_mdNew && _mdNew.id === pid) return _mdNew;
  return (_mdData.providers || []).find((p) => p.id === pid);
}

function _mdTouchProvider(pid, patch) {
  const p = _mdProvider(pid);
  if (!p) return;
  Object.assign(p, patch || {});
  p._capStale = true;
  for (const key of _mdChecks.keys()) if (JSON.parse(key)[0] === pid) _mdChecks.delete(key);
  _mdDirty = true; _mdMark();
}

function _mdBind(box) {
  // Re-rendering after search or service switching must not hide an unsaved key.
  box.querySelectorAll('[data-pkey]').forEach(el => { el.value = _mdKeyEdits[el.getAttribute('data-pkey')] || ''; });
  const addInline = document.getElementById('mdAddInline');
  if (addInline) addInline.addEventListener('click', _mdAddService);
  const q = document.getElementById('mdQ');
  if (q) {
    q.addEventListener('input', () => {
      _mdQuery = q.value;
      const at = q.selectionStart;
      _mdRender();
      const q2 = document.getElementById('mdQ');
      if (q2) { q2.focus(); try { q2.setSelectionRange(at, at); } catch (e) { /* Keep focus if selection restoration is unsupported. */ } }
    });
  }
  box.querySelectorAll('[data-mdselect]').forEach((el) => el.addEventListener('click', () => {
    _mdOpen = el.getAttribute('data-mdselect');
    _mdEditor = '';
    _mdDeletePending = '';
    _mdRender();
  }));

  box.querySelectorAll('[data-pkey]').forEach(el => el.addEventListener('input', () => {
    const pid = el.getAttribute('data-pkey');
    const provider = _mdProvider(pid); if (provider) provider._capStale = true;
    for (const key of _mdChecks.keys()) if (JSON.parse(key)[0] === pid) _mdChecks.delete(key);
    if (el.value.trim()) _mdKeyEdits[pid] = el.value.trim();
    else delete _mdKeyEdits[pid];
    _mdMark();
  }));
  box.querySelectorAll('[data-pname]').forEach(el => el.addEventListener('input', () =>
    _mdTouchProvider(el.getAttribute('data-pname'), { name: el.value })));
  box.querySelectorAll('[data-purl]').forEach(el => el.addEventListener('input', () =>
    _mdTouchProvider(el.getAttribute('data-purl'), { baseUrl: el.value.trim() })));
  box.querySelectorAll('[data-pkind]').forEach(el => el.addEventListener('change', () => {
    _mdTouchProvider(el.getAttribute('data-pkind'), { kind: el.value });
    _mdRender();
  }));
  box.querySelectorAll('[data-pnoauth]').forEach(el => el.addEventListener('change', () => {
    _mdTouchProvider(el.getAttribute('data-pnoauth'), { authMode: el.checked ? 'none' : 'key' });
    _mdRender();
  }));
  box.querySelectorAll('[data-preset]').forEach(el => el.addEventListener('click', () => {
    const p = _mdProvider(el.getAttribute('data-preset'));
    if (!p) return;
    _mdTouchProvider(p.id, { baseUrl: p.defaultBaseUrl || '', addressOverridden: false });
    _mdRender();
  }));
  box.querySelectorAll('[data-pdelete]').forEach(el => el.addEventListener('click', () => {
    const pid = el.getAttribute('data-pdelete');
    if (_mdDeletePending !== pid) { _mdDeletePending = pid; _mdRender(); return; }
    _mdDeletePending = '';
    _mdData.providers = (_mdData.providers || []).filter((p) => p.id !== pid);
    _mdMyModels = _mdMyModels.filter((m) => m.providerId !== pid);
    _mdKeyEdits[pid] = null; _mdDirty = true;
    _mdSave(true);
  }));
  box.querySelectorAll('[data-peye]').forEach(el => el.addEventListener('click', () => {
    const inp = box.querySelector('[data-pkey="' + el.getAttribute('data-peye') + '"]');
    if (!inp) return;
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    el.textContent = show ? '隐藏' : '显示';
    el.setAttribute('aria-pressed', String(show));
  }));
  box.querySelectorAll('[data-pclear]').forEach(el => el.addEventListener('click', async () => {
    const pid = el.getAttribute('data-pclear');
    _mdKeyEdits[pid] = null;    /* null explicitly removes the personal key. */
    const p = _mdProvider(pid);
    el.textContent = p && p.addressOverridden ? '（保存后此地址将没有凭据）' : '（保存后回落到公司凭据）';
    el.disabled = true;
    _mdMark();
    // Clearing a personal key is the removal action for built-in providers.
    // Persist it immediately so the provider leaves the usable/default list.
    const saved = await _mdSave(false);
    if (!saved) await _mdLoad();
  }));
  box.querySelectorAll('[data-ptest]').forEach(el => el.addEventListener('click', () => _mdDoTest(el)));
  box.querySelectorAll('[data-mdel]').forEach(el => el.addEventListener('click', async () => {
    const [pid, i] = el.getAttribute('data-mdel').split('|');
    const own = _mdMyModels.filter(m => m.providerId === pid);
    const target = own[+i];
    const at = _mdMyModels.indexOf(target);
    if (at >= 0) _mdMyModels.splice(at, 1);
    _mdDirty = true; _mdRender();
    // Removing a personal model is an explicit destructive action. Persist it
    // immediately so it does not reappear when the panel is reopened, and so a
    // stale model cannot remain selected in the conversation picker.
    const saved = await _mdSave(false);
    if (!saved) await _mdLoad();
  }));
  _mdBindModels(box);
}

/*
 * Save pending keys before the real connection test so the result applies to the new
 * credential.
 */
async function _mdDoTest(el) {
  const pid = el.getAttribute('data-ptest');
  if (_mdTest[pid]?.state === 'ing') return;
  const p = _mdProvider(pid);
  if (!p || !String(p.baseUrl || '').trim()) {
    _mdTest[pid] = { state: 'bad', detail: '请先填写 API 地址' }; _mdRender(); return;
  }
  if (!(_mdMyModels || []).some((m) => m.providerId === pid) &&
      !(p.modelDefs || p.modelNames || []).length) {
    _mdTest[pid] = { state: 'bad', detail: '请先添加一个模型 ID' }; _mdRender(); return;
  }
  _mdTest[pid] = { state: 'ing' };
  _mdRender();
  try {
    if (_mdDirty || Object.keys(_mdKeyEdits).length) {
      const body = _mdPayload();
      await SoduWorkAPI.saveMyModels(body);
      _mdKeyEdits = {}; _mdDirty = false;
      _mdData = await SoduWorkAPI.myModels();
      if (_mdNew) {
        const added = (_mdData.providers || []).find((x) => x.personal && x.id === _mdNew.id);
        if (added) { _mdEditor = added.id; _mdNew = null; }
      }
      if (window.soduWorkAPI && soduWorkAPI.broadcast) soduWorkAPI.broadcast('models', { providerId: pid });
    }
    const testPid = pid === '__new__' ? (_mdNew && _mdNew.id) : pid;
    const r = await SoduWorkAPI.testMyModel(testPid);
    _mdTest[testPid] = { state: r && r.ok ? 'ok' : 'bad',
                     detail: (r && r.detail) || '没测出结果' };
  } catch (e) {
    _mdTest[pid] = { state: 'bad', detail: _humanErr(e, '没测成') };
  }
  _mdRender();
}

/* Enable saving only when unsaved changes exist. */
function _mdMark() {
  const btn = document.getElementById('mdSave');
  if (!btn) return;
  const dirty = _mdDirty || Object.keys(_mdKeyEdits).length > 0;
  btn.disabled = !dirty || _mdLoadState !== 'ready';
  btn.textContent = dirty || _mdLoadState !== 'ready' ? '保存' : '已保存';
}

function _mdPayload() {
  const all = (_mdData && _mdData.providers ? _mdData.providers : []).slice();
  if (_mdNew && !all.some((p) => p.id === _mdNew.id)) {
    all.push(_mdNew);
  }
  const providers = all.map((p) => ({ id: p.id, name: p.name, kind: p.kind || 'openai-compat',
    baseUrl: p.baseUrl || '', defaultBaseUrl: p.defaultBaseUrl || '', personal: !!p.personal,
    authMode: p.authMode || 'key', note: p.note || '' }));
  return { providers, models: _mdMyModels, keys: _mdKeyEdits, expectedRevision: _mdData && _mdData.revision };
}

async function _mdSave(closeAfter) {
  const btn = document.getElementById('mdSave');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    const p = _mdProvider(_mdOpen || _mdEditor);
    if (p && (!String(p.baseUrl || '').startsWith('http://') && !String(p.baseUrl || '').startsWith('https://'))) {
      throw new Error('API 地址要以 http:// 或 https:// 开头');
    }
    if (p && p.personal && !String(p.name || '').trim()) throw new Error('请填写服务名称');
    const body = _mdPayload();
    await SoduWorkAPI.saveMyModels(body);
    if (typeof petSay === 'function') petSay('模型配置存好了～');
    await _mdLoad();
    if (globalThis.ComposeModelPicker && typeof ComposeModelPicker.refresh === 'function') {
      await ComposeModelPicker.refresh(true);
    }
    if (window.soduWorkAPI && soduWorkAPI.broadcast) {
      soduWorkAPI.broadcast('models', { providerId: _mdEditor || '' });
    }
    if (closeAfter && window.soduWorkAPI && soduWorkAPI.closeDeskWindow) soduWorkAPI.closeDeskWindow();
    return true;
  } catch (e) {
    if (typeof petSay === 'function') petSay(_humanErr(e, '没存上'));
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }
    return false;
  }
}

// Source-owned messages keep count updates and language changes independent.
function _mdMessage(key, fallback, params) {
  if (globalThis.SoduWorkI18n?.html) return SoduWorkI18n.html(key, fallback, params);
  return esc(fallback.replace(/\{(\w+)\}/g, (all, name) => params[name] ?? all));
}

// A background hint must not replace the editor's loading/error state or drafts.
function _mdBackgroundRefresh() {
  if (_mdRefreshFlight) return _mdRefreshFlight;
  const panel = document.getElementById('mdPanel'), box = document.getElementById('mdBody');
  const editable = () => panel?.classList.contains('show') && document.getElementById('mdBody') === box &&
    _mdLoadState === 'ready' && _mdData && !_mdDirty && !Object.keys(_mdKeyEdits).length &&
    !_mdNew && !_mdDeletePending && !_mdDrafts.size &&
    !Object.values(_mdTest).some(test => test.state === 'ing') && ![..._mdChecks.values()].some(check => check.pending);
  if (!box || !editable()) return Promise.resolve(false);
  const scope = SoduWorkAPI.taskStorageKey?.('ops'), loadId = _mdLoadId;
  const previous = { data: _mdData, models: _mdMyModels, editor: _mdEditor, open: _mdOpen, query: _mdQuery };
  const snapshot = JSON.stringify(_mdData);
  const current = () => editable() && loadId === _mdLoadId && scope === SoduWorkAPI.taskStorageKey?.('ops') &&
    previous.data === _mdData && snapshot === JSON.stringify(_mdData) && previous.editor === _mdEditor &&
    previous.open === _mdOpen && previous.query === _mdQuery;
  let timer, rendering = false;
  const flight = Promise.race([
    Promise.resolve().then(() => SoduWorkAPI.myModels()),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Model catalog refresh timed out')), 20000); })
  ]).then(result => {
    if (!current() || !result || !['providers', 'usable', 'myModels'].every(key => Array.isArray(result[key])) ||
        result.providers.some(provider => !provider || typeof provider.id !== 'string') ||
        result.myModels.some(model => !model || typeof model.name !== 'string') || snapshot === JSON.stringify(result)) return false;
    rendering = true;
    _mdData = result; _mdMyModels = result.myModels.slice();
    _mdReconcileChecks(result); _mdRender();
    return true;
  }).catch(() => {
    if (rendering) { _mdData = previous.data; _mdMyModels = previous.models; }
    return false;
  }).finally(() => { clearTimeout(timer); if (_mdRefreshFlight === flight) _mdRefreshFlight = null; });
  _mdRefreshFlight = flight;
  return flight;
}

window.addEventListener?.('soduwork-domain-changed', event => {
  if (event.detail?.domain === 'models') void _mdBackgroundRefresh();
});
