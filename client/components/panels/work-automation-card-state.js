/* Persist serializable automation state independently of the view to prevent duplicate submissions when switching conversations. */
(function (global) {
  'use strict';
  const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
  function create(ownerOf) {
    const records = new Map();
    let epoch = 0, serial = 0;
    const current = record => Boolean(record && record.epoch === epoch && record.owner === ownerOf());
    const capture = record => record ? clone(record.snapshot) : null;
    function publish(record, patch, seed, notify) {
      if (!current(record)) return null;
      record.snapshot = { ...record.snapshot, ...clone(patch), updatedAt: Date.now() };
      try { (seed || record.seed).onCardState?.(capture(record)); } catch (_) {}
      if (notify) record.listener?.(capture(record));
      return capture(record);
    }
    function open(seed) {
      const saved = seed.cardState, owner = ownerOf();
      const cardId = String(seed.cardId || saved?.cardId || 'automation-' + Date.now() + '-' + (++serial));
      const key = owner + '\n' + cardId, previous = records.get(key);
      if (saved && current(previous) && (previous.pending || previous.snapshot.updatedAt > Number(saved.updatedAt || 0))) {
        if (!previous.pending) previous.seed = seed;
        return previous;
      }
      const snapshot = { phase: 'loading', proposal: null, receipt: null, createdId: '', error: '', ...clone(saved), version: 1, cardId };
      const record = { key, owner, epoch, seed, snapshot, pending: null, operation: 0, listener: null };
      // After restart, verify server records before retrying a request whose creation outcome is unknown.
      if (saved?.phase === 'submitting') Object.assign(snapshot, { phase: 'error', uncertain: true,
        error: '上次创建结果尚未确认，请先到自动化管理中查询，避免重复创建。' });
      if (saved?.phase === 'loading') Object.assign(snapshot, { phase: 'error',
        error: '上次整理未完成；已保留原有内容，请确认后重新整理。' });
      records.set(key, record);
      for (const [id, item] of records) {
        if (records.size <= 100) break;
        if (!item.pending && item !== record && !item.listener) records.delete(id);
      }
      return record;
    }
    function begin(record, phase, patch) {
      if (!current(record) || record.pending) return null;
      const ticket = { record, operation: ++record.operation, seed: record.seed };
      record.pending = phase;
      publish(record, { ...patch, phase, error: '', uncertain: false }, ticket.seed);
      return ticket;
    }
    function valid(ticket) { return Boolean(ticket && current(ticket.record) && ticket.operation === ticket.record.operation); }
    function finish(ticket, patch) {
      if (!valid(ticket)) return null;
      ticket.record.pending = null;
      return publish(ticket.record, patch, ticket.seed, true);
    }
    return { open, capture, current, begin, valid, finish,
      update: (record, patch, seed) => publish(record, patch, seed, false),
      subscribe(record, listener) { record.listener = listener; return () => { if (record.listener === listener) record.listener = null; }; },
      reset() { epoch++; records.clear(); },
    };
  }
  async function loadOptions(seed) {
    const A = global.SoduWorkAPI;
    if (A?.taskExecutionOptions) {
      try {
        const result = await A.taskExecutionOptions({ title: String(seed?.text || '').trim().slice(0, 60), note: String(seed?.text || '').trim().slice(0, 8000), tags: [] });
        const modelOptions = Array.isArray(result?.modelOptions) ? result.modelOptions.slice() :
          (Array.isArray(result?.models) ? result.models.map(name => ({ name, label: name })) : []);
        const nativeAgents = (result?.substrates || []).filter(item => item?.key && item.nativeModelPick);
        const bridge = global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
        const nativeModels = Object.create(null);
        if (bridge && typeof bridge.runtimeModels === 'function') await Promise.all(nativeAgents.map(async item => {
          const adapter = String(item.cli || item.adapterId || item.key || '').replace(/^local:/, '');
          if (!adapter) return;
          try {
            const value = await bridge.runtimeModels(adapter);
            nativeModels[item.key] = Array.isArray(value?.models) ? value.models : [];
          } catch (_) { nativeModels[item.key] = []; }
        }));
        return { agents: (result?.substrates || []).filter(item => item?.key).map(item => ({
          id: String(item.key), name: String(item.name || item.cli || item.key), adapterId: String(item.adapterId || item.cli || ''),
          available: item.available !== false, note: String(item.note || ''), locationLabel: String(item.locationLabel || ''),
          onlineSeats: Math.max(0, Number(item.onlineSeats) || 0),
        })), repos: result?.repos || [], reason: String(result?.availability?.agentReason || '') };
      } catch (_) { /* Read the existing roster endpoint for compatibility with older Hub versions. */ }
    }
    const agents = A?.listAIAgents ? await A.listAIAgents().catch(() => ({ agents: [] })) : { agents: [] };
    const repos = A?.listRepos ? await A.listRepos().catch(() => []) : [];
    return { agents: (agents?.agents || []).filter(agent => agent && !agent.off).map(agent => ({ ...agent, available: agent.online !== false,
      modelPick: agent.modelPick !== false, nativeModelPick: agent.nativeModelPick === true, modelOptions: agent.modelOptions || [] })),
      repos, reason: String(agents?.reason || ''), modelOptions: [], defaultModel: '' };
  }
  function savedHtml(value, agent, method, esc) {
    const tx = text => global.SoduWorkI18n?.translateText?.(text) || text;
    const when = String(value.atHour).padStart(2, '0') + ':' + String(value.atMinute).padStart(2, '0');
    const selectedWeekdays = Array.isArray(value.weekdays) && value.weekdays.length ? value.weekdays : [value.weekday];
    const weekdayLabels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const monthDays = Array.isArray(value.monthDays) ? value.monthDays.slice().sort((a, b) => a - b) : [];
    const range = value.startDate || value.endDate
      ? ' · ' + (value.startDate || '…') + ' – ' + (value.endDate || '…') : '';
    let rhythm = tx('每天') + ' ' + when + range;
    if (value.every === 'once') rhythm = global.ScheduleTiming.summary(value);
    else if (value.every === 'custom') rhythm = tx(global.ScheduleTiming.summary(value));
    else if (value.every === 'hourly') rhythm = tx('每小时第几分') + ' ' + String(value.atMinute).padStart(2, '0') + ' ' + tx('分钟') + range;
    else if (value.every === 'monthly') rhythm = tx('每月') + ' ' + monthDays.join(', ') + ' ' + tx('日期') +
      (value.monthDayPolicy === 'last_day' ? ' · ' + tx('缺少日期时使用当月最后一天') : '') + ' · ' + when + range;
    else if (value.every === 'weekly') rhythm = selectedWeekdays.map(day =>
      tx(weekdayLabels[Math.max(0, Number(day) - 1)])).join(', ') + ' ' + when + range;
    return '<div class="waz-saved"><span class="waz-saved-mark">✓</span><p>' + esc(tx('自动化已创建')) + '</p><h3 data-user-content>' + esc(value.title) + '</h3>' +
      '<div><span>' + esc(rhythm) + '</span><span>' + esc(agent?.name || value.assigneeId) + '</span>' +
      (method ? '<span>' + esc(method.name) + ' · v' + esc(method.version || '') + '</span>' : '') +
      '</div><small>' + esc(tx('以后每次运行都会生成可追踪的任务，并保留结果、异常与重试记录。')) + '</small>' +
      '<button type="button" class="waz-button primary" data-waz-open>' + esc(tx('查看自动化')) + '</button></div>';
  }
  global.WorkAutomationCardState = { create, loadOptions, savedHtml };
})(window);
