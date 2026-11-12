/* Automation reading surface. Scheduling, editing and execution remain in their existing controllers. */
function _schRenderLoadWarning(body) {
  if (!_schLoadError || !(_schRows || []).length) return;
  body.insertAdjacentHTML('afterbegin', '<div class="sch-stale-notice" role="status" aria-live="polite">' +
    '<div><b>刷新失败</b><span>当前显示上次读取的数据，状态可能已变化。</span>' +
    '<small>' + esc(_schLoadError) + '</small></div>' +
    '<button type="button" class="btn-mini" data-sch-refresh>重新加载</button></div>');
  const retry = body.querySelector('[data-sch-refresh]');
  retry.addEventListener('click', async () => {
    if (retry.disabled) return;
    retry.disabled = true; retry.textContent = '正在重新加载…';
    try { await _loadSch(); }
    finally {
      if (retry.isConnected) { retry.disabled = false; retry.textContent = '重新加载'; }
    }
  });
}

function _schVisualIcon(name) {
  const paths = {
    daily: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    template: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 9h16M9 9v11"/>',
    weekly: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 10h18M8 14h2M14 14h2M8 17h2"/>',
    inspect: '<rect x="3" y="4" width="18" height="15" rx="3"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01m-2 7 2.5 2.5 5-5"/>',
    form: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v4H9zM9 12h6M9 16h4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    agent: '<rect x="5" y="7" width="14" height="13" rx="4"/><path d="M12 3v4M2 12v4M22 12v4M9 12h.01M15 12h.01M9 16h6"/>',
    folder: '<path d="M3 8V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    chevron: '<path d="m7 10 5 5 5-5"/>',
  };
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (paths[name] || paths.clock) + '</svg>';
}

function _schCardAssignee(id) {
  const raw = String(id || '');
  const known = (_schAgents.find(a => a.id === id) || {}).name;
  if (known && !/^runner:/i.test(known)) return known;
  // Older schedules store a routing key; show the known runtime without changing that key.
  const runtime = raw.split(':').pop().toLowerCase();
  const names = { pi: 'Pi', opencode: 'OpenCode', codex: 'Codex', 'codex-harness': 'Codex Harness',
    'claude-code': 'Claude Code', claude: 'Claude Code', 'qwen-code': 'Qwen Code', qwencode: 'Qwen Code',
    qwen: 'Qwen Code', 'deepseek-harness': 'DeepSeek Harness', harness2: 'Google Harness²' };
  return names[runtime] || (raw.startsWith('runner:') ? 'Agent' : known || raw || 'Agent');
}

function _schCardNote(note) {
  const value = String(note || '').split('\n\n即用任务上下文（数据）：\n')[0];
  if (!value) return '';
  if (value.length <= 110 && !value.includes('\n')) return '<p class="sch-i-note" data-user-content>' + esc(value) + '</p>';
  return '<details class="sch-i-description"><summary><span class="sch-i-note" data-user-content>' + esc(value) +
    '</span><span class="sch-i-expand"><span class="sch-expand-label">展开说明</span>' +
    '<span class="sch-collapse-label">收起说明</span>' + _schVisualIcon('chevron') + '</span></summary></details>';
}

function _schAppIdentity(s) {
  let source=s.sourceApp;
  if(!source?.name){
    const line=String(s.note || '').split('即用任务上下文（数据）：\n')[1]?.split('\n')[0];
    if(line && line.length<150000){try{const prior=JSON.parse(line);source=prior.sourceApp || (prior.appName?{name:prior.appName}:null);}catch(_) {}}
  }
  if(!source?.name)return '';
  const method=_schmFind(s.personalPluginKey);
  const icon=source.icon || method?.icon || '';
  const image=/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(icon)?'<img src="'+esc(icon)+'" alt="" width="24" height="24">':'';
  return '<span class="sch-i-app" data-user-content>'+image+'<b>'+esc(source.name)+'</b>'+
    (source.characterName?'<span>'+esc(source.characterName)+'</span>':'')+'</span>';
}
function _schCardHtml(s) {
  const fired = s.every === 'once' && s.onceFired;
  const who = _schCardAssignee(s.assigneeId);
  const plugin = s.pluginBindingId ? _schFindPlugin(s.pluginBindingId) : _schmFind(s.personalPluginKey);
  const method = s.pluginBindingId ? (plugin && plugin.name) || '企业插件'
    : s.personalPluginKey ? (plugin && plugin.name) || s.personalPluginKey : '';
  const repo = s.repoId ? (_schRepos.find(r => r.id === s.repoId) || {}).name || s.repoId : '';
  const rh = s.every === 'custom' ? [_schRhythm(s)] : _schRhythm(s).split(' ');
  const retry = s.retrying ? ' · 自动重试 ' + Number(s.retryCount || 0) + '/' + Number(s.retryLimit || 0) : '';
  // Keep the runtime identity visual and consistent with the chat composer.
  // The old card repeated the runtime name beside a generic robot, which made
  // the header noisy and could show the wrong base for older routing keys.
  const agentBrand = (typeof AgentBrand !== 'undefined' && AgentBrand)
    ? AgentBrand.html(s.assigneeId || who, { className: 'sch-i-agent-brand', title: who })
    : '<span class="sch-i-agent-brand" title="' + esc(who) + '">' + _schVisualIcon('agent') + '</span>';
  const executor = '<span class="sch-i-executor" aria-label="' + esc(who) + '">' + agentBrand + '</span>';
  const appIdentity=_schAppIdentity(s);
  const methodLabel = method && !appIdentity
    ? '<span class="sch-i-method" data-user-content title="' + esc(method) + '">' + esc(method) + '</span>' : '';
  const stateLabel = fired ? '本次预约已触发' : s.enabled ? '已启用' : '已停用';
  const stateHtml = fired
    ? '<span class="sch-i-state">' + stateLabel + '</span>'
    : '<button type="button" class="sch-i-state' + (s.enabled ? ' is-enabled' : '') +
      '" data-act="toggle" aria-pressed="' + String(Boolean(s.enabled)) + '" aria-label="' +
      esc(s.enabled ? '停用自动化' : '启用自动化') + '" title="' +
      esc(s.enabled ? '停用自动化' : '启用自动化') + '">' + stateLabel + '</button>';
  return '<article class="sch-item' + (s.enabled ? '' : ' off') + '" data-sid="' + esc(s.id) + '">' +
    '<div class="sch-i-body"><div class="sch-i-head"><div class="sch-i-when">' + _schVisualIcon('clock') +
      '<b>' + esc(rh[0]) + '</b><i>' + esc(rh.slice(1).join(' ')) + '</i></div>' +
      '<div class="sch-i-assignment">' + appIdentity + executor + methodLabel + '</div>' +
      stateHtml + '</div>' +
    '<div class="sch-i-main"><div class="sch-i-top"><b class="sch-i-title" data-user-content title="' + esc(s.title) + '">' +
      esc(s.title) + '</b></div>' + _schCardNote(s.note) +
      (repo ? '<div class="sch-i-meta"><span class="sch-i-project">' + _schVisualIcon('folder') + '<b data-user-content title="' + esc(repo) + '">' + esc(repo) + '</b></span>' +
      (s.flow ? '<span class="sch-i-flow">（按研发流程走）</span>' : '') + '</div>' : '') +

      (s.lastError ? '<span class="sch-i-err" title="' + esc(s.lastError) + '">' + (s.retrying ? '等待重试' : '上次没派出去') + '</span>' : '') +
    '</div></div><div class="sch-i-foot"><span class="sch-i-timing"><span class="sch-i-next">' +
      esc(_schCardNext(s)) + '</span>' +
      (s.lastRunAt ? '<span class="sch-i-last">上次 ' + esc(_schLocal(s.lastRunAt)) + esc(retry) + '</span>' : '') +
    '</span><span class="sch-i-ops" role="group" aria-label="自动化操作">' +
      _schActionButton('run', '立刻跑一次') + _schActionButton('runs', '执行记录') +
      _schActionButton('edit', '编辑自动化') + _schActionButton('del', '删除自动化') + '</span></div></article>';
}

async function _schToggleEnabled(sid, source) {
  const schedule = (_schRows || []).find(item => item.id === sid);
  if (!schedule || !window.SoduWorkAPI?.updateSchedule) return;
  const enabled = !Boolean(schedule.enabled);
  const action = enabled ? '\u542f\u7528' : '\u505c\u7528';
  const title = enabled ? '\u542f\u7528\u81ea\u52a8\u5316' : '\u6682\u505c\u81ea\u52a8\u5316';
  const consequence = enabled
    ? '\u542f\u7528\u540e\uff0c\u8be5\u81ea\u52a8\u5316\u4f1a\u6309\u539f\u5b9a\u8ba1\u5212\u7ee7\u7eed\u8fd0\u884c\u3002'
    : '\u6682\u505c\u540e\u4e0d\u4f1a\u81ea\u52a8\u8fd0\u884c\uff0c\u5df2\u6709\u7684\u6267\u884c\u8bb0\u5f55\u4e0d\u4f1a\u88ab\u5220\u9664\u3002';
  const ui = window.AccountUI;
  if (!ui?.modal) return;
  const dialog = ui.modal(document.body, title,
    '<p>\u786e\u5b9a\u8981' + action + '\u300c' + esc(schedule.title || '\u81ea\u52a8\u5316') + '\u300d\uff1f</p>' +
    '<p class=\"ac-muted\">' + consequence + '</p>' +
    '<div class=\"ac-actions\"><button type=\"button\" class=\"ac-secondary\" data-sch-toggle-cancel>\u53d6\u6d88</button>' +
    '<button type=\"button\" class=\"ac-primary\" data-sch-toggle-confirm>' + action + '</button></div>',
    'sch-toggle-dialog');
  const cancel = dialog.mask.querySelector('[data-sch-toggle-cancel]');
  const confirm = dialog.mask.querySelector('[data-sch-toggle-confirm]');
  cancel?.addEventListener('click', () => dialog.close());
  confirm?.addEventListener('click', async () => {
    if (confirm.disabled) return;
    confirm.disabled = true; confirm.textContent = enabled ? '\u6b63\u5728\u542f\u7528\u2026' : '\u6b63\u5728\u505c\u7528\u2026';
    try {
      await window.SoduWorkAPI.updateSchedule(sid, { enabled });
      dialog.close();
      _schRows = null;
      await _loadSch();
      if (typeof petSay === 'function') petSay('\u5df2' + action + '\u81ea\u52a8\u5316\u300c' + (schedule.title || '\u81ea\u52a8\u5316') + '\u300d');
    } catch (error) {
      confirm.disabled = false; confirm.textContent = action;
      const message = dialog.mask.querySelector('[data-sch-toggle-error]') || document.createElement('p');
      message.setAttribute('data-sch-toggle-error', ''); message.className = 'ac-status ac-danger'; message.textContent = _schErrorText(error);
      if (!message.parentNode) dialog.mask.querySelector('.ac-dialog-body')?.appendChild(message);
    }
  });
}

function _schCardNext(s) {
  if (s.every === 'once' && s.onceFired) return s.retrying ? '等待重试' : '不再自动触发';
  if (!s.enabled) return '已停用，不会自动跑';
  if (s.every === 'custom' && !s.nextRunAt) return _schTx(s.retrying ? '等待重试' : '自定义规则已无后续执行时间');
  if (s.endDate && !s.nextRunAt) return _schTx(s.retrying ? '等待重试' : '计划已超出有效日期范围');
  if (s.every === 'once') {
    if (Date.parse(s.runAt) <= Date.now()) return '等待补跑一次';
    const local = window.ScheduleTiming?.localInput(s.runAt, s.timeZone || _schBrowserTimeZone()) || '';
    return '下次 ' + (s.nextRunLocal || local.replace('T', ' ')) + ' · ' + _schTimeZoneLabel(s.timeZone);
  }
  return '下次 ' + (s.nextRunLocal || _schLocal(s.nextRunAt));
}
