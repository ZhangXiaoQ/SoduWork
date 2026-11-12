/* Shared execution-event rendering for NativeChat. No timers or second composer. */
function _executionStreamEmptyState(data) {
  const value = data && typeof data === 'object' ? data : {};
  const status = String(value.status || '').toLowerCase();
  const error = String(value.error || value.liveError || '').trim();
  if (status === 'failed') return {
    tone: 'failed',
    title: error || '执行在产生第一条会话记录前失败',
    detail: '这次没有可回放的对话；失败事实和重试入口仍保留在需求全链路中。',
  };
  if (status === 'stopped' || status === 'cancelled' || status === 'canceled') return {
    tone: 'stopped', title: '执行已停止，没有留下会话记录',
    detail: '这是终态记录，不会继续等待执行机；可以从需求全链路重新派活。',
  };
  if (status === 'interrupted') return {
    tone: 'stopped', title: error || '执行已中断，没有留下可回放的会话',
    detail: '中断前没有收到结构化过程记录；可以从需求全链路重试。',
  };
  if (status === 'done') return {
    tone: 'done', title: '本次执行已结束，但没有留下结构化会话',
    detail: '成果、审批和发布事实仍以需求全链路中的固定记录为准。',
  };
  return {
    tone: 'waiting', title: error || '正在等待执行机回传第一条记录',
    detail: '会话会自动出现在这里，切走或关窗都不会影响 AI 继续工作。',
  };
}

function _executionStreamBlankHtml(value) {
  const state = typeof value === 'string'
    ? { tone: 'waiting', title: value, detail: '会话会自动出现在这里，切走或关窗都不会影响 AI 继续工作。' }
    : _executionStreamEmptyState(value);
  return '<div class="dks-blank is-' + esc(state.tone) + "\"><span class=\"dks-waitdot\"></span><b data-user-content>" +
    esc(state.title) + '</b><span>' + esc(state.detail) + '</span></div>';
}

function _executionStreamTime(at) {
  const raw = String(at || '');
  if (!raw) return '';
  const direct = raw.length >= 19 ? raw.slice(11, 19) : '';
  if (direct && /^\d\d:\d\d:\d\d$/.test(direct)) return direct;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString((globalThis.SoduWorkI18n?.getLocale() || 'zh-CN'), { hour12: false }).slice(0, 8);
}

/*
 * Render Markdown through the vendored marked and DOMPurify libraries when available;
 * otherwise preserve content as plain text.
 */
function _executionStreamMarkdown(text) {
  try {
    if (window.marked && window.DOMPurify) {
      const html = window.DOMPurify.sanitize(window.marked.parse(text), {
        FORBID_TAGS: ['style', 'form', 'input', 'button'], ADD_ATTR: ['target'] });
      return '<div class="ntext dks-bubble dks-md nmd">' + html + '</div>';
    }
  } catch (e) { /* Fall back to plain text if rendering fails. */ }
  return '<div class="ntext dks-bubble dks-plain">' + esc(text) + '</div>';
}

function _executionStreamText(item) {
  return String((item && (item.full || item.text)) || '').trim();
}

function _executionStreamIsThinkingStep(item) {
  const text = _executionStreamText(item).replace(/\s+/g, ' ').trim();
  return !text || /(?:第\s*\d+\s*步\s*[·・.、:-]?\s*)?(?:正在)?(?:想|思考|thinking)(?:中|…|\.\.\.)?\s*$/i.test(text);
}

function _executionStreamIsProtocolStep(item) {
  const kind = String((item && item.kind) || '').toLowerCase();
  if (kind === 'step') return true;
  /* Some older runners exposed the same step heartbeat as a generic output.
     Never hide a real assistant reply, only a short single-line protocol label. */
  if (kind === 'say') return false;
  const raw = _executionStreamText(item);
  if (!raw || raw.length > 120 || /[\r\n]/.test(raw)) return false;
  return /^\u7b2c\s*\d+\s*\u6b65(?:\s*[\u00b7\u30fb.\u3001:\uFF1A-]\s*)?.+$/i.test(raw.trim());
}

function _executionStreamToolModel(item, result, running) {
  return {
    id: 'task-tool-' + Number(item.seq || 0),
    name: String(item.tool || 'tool'),
    ...(item.kind === 'tool-preparing' ? { phase: 'preparing' } : {}),
    toolKind: String(item.toolKind || ''),
    args: window.ExecutionToolArgs.normalize(item),
    result: String(result || ''),
    partial: running ? String(result || '') : '',
    state: running ? 'running' : 'done',
  };
}

function _executionStreamIsDiagnostic(item) {
  const tool = String((item && item.tool) || '').toLowerCase();
  const text = _executionStreamText(item).toLowerCase();
  return String((item && item.kind) || '') === 'out' &&
    (!tool || /stderr|提示|错误|warn|error/.test(tool) ||
      /^(?:warn|warning|error|reconnecting|failed\b)/.test(text));
}

function _executionStreamDiagnosticLevel(item) {
  const text = (String((item && item.tool) || '') + ' ' + _executionStreamText(item)).toLowerCase();
  return /\berror\b|错误|failed|timed out|timeout/.test(text) ? 'error' : 'info';
}

function _executionStreamVisibleItems(items) {
  const visible = [];
  const seenSources = new Set();
  const seenSays = new Set();
  const seenDeltas = new Set();
  let scope = '';
  const reset = () => { seenSources.clear(); seenSays.clear(); seenDeltas.clear(); };
  (items || []).forEach((value) => {
    if (!value || typeof value !== 'object') return;
    const item = value;
    const rawScope = item.round != null ? item.round :
      (item._round != null ? item._round : item.seg);
    const nextScope = rawScope == null || rawScope === '' ? '' : String(rawScope);
    if (scope && nextScope && nextScope !== scope) reset();
    if (nextScope) scope = nextScope;
    const kind = String(item.kind || 'out').toLowerCase();
    if (kind === 'user') {
      reset();
      visible.push(item);
      return;
    }
    const text = _executionStreamText(item).replace(/\s+/g, ' ').trim();
    const source = String(item.sourceId || item._sourceId || '').trim();
    const sourceKey = source ? [source, kind, String(item.tool || '').toLowerCase(), text].join('|') : '';
    const streaming = kind === 'say' && (item.delta || item.streamId);
    if (!streaming && sourceKey && seenSources.has(sourceKey)) return;
    // Repeated words and whitespace are real tokens. Only an event identity
    // can deduplicate a stream when historical pages overlap.
    if (streaming && Number.isSafeInteger(item.seq) && item.seq > 0) {
      const eventKey = [scope, item.seg || 1, item.seq].join(':');
      if (seenDeltas.has(eventKey)) return;
      seenDeltas.add(eventKey);
    }
    if (kind === 'say' && !streaming && text && seenSays.has(text)) return;
    visible.push(item);
    if (!streaming && sourceKey) seenSources.add(sourceKey);
    if (kind === 'say' && !streaming && text) seenSays.add(text);
  });
  return visible;
}

/*
 * Normalize runtime events into content, phase, tool, and diagnostic categories before
 * rendering; stderr must not become conversation content.
 */
function _executionStreamRows(items, status) {
  const rows = [];
  const visibleItems = _executionStreamVisibleItems(items);
  const seenTools = [];
  const thoughts = new Map();
  const replies = new Map();
  const preparations = new Map();
  let preparationRound, preparationSegment;
  const callKey = item => [item.round || item._round || 1, item.seg || 1, item.callId || ''].join(':');
  let pending = null;
  let diagnostics = null;
  const flushTool = () => {
    if (!pending) return;
    pending.model = _executionStreamToolModel(pending.item, pending.result, false);
    const narrative = window.ChatTools && typeof ChatTools.phaseNarrative === 'function'
      ? ChatTools.phaseNarrative(pending.model, seenTools) : '';
    if (narrative) rows.push({ type: 'process', key: 'process-' + pending.item.seq,
      text: narrative, at: pending.item.at });
    rows.push(pending);
    seenTools.push(pending.model);
    pending = null;
  };
  const flushDiagnostics = () => {
    if (!diagnostics) return;
    rows.push(diagnostics);
    diagnostics = null;
  };
  visibleItems.forEach((item) => {
    const kind = String((item && item.kind) || 'out');
    const round = item.round ?? item._round ?? preparationRound, segment = item.seg ?? preparationSegment;
    if (kind === 'user' || (preparationRound != null && round !== preparationRound) ||
        (preparationSegment != null && segment !== preparationSegment)) {
      preparations.forEach(row => { row.discarded = true; }); preparations.clear();
    }
    preparationRound = round; preparationSegment = segment;
    // Native reasoning is a replaceable stream; usage is metadata. Neither is
    // a tool result, including when it arrives between a tool's start and end.
    if (kind === 'usage') return;
    if (kind === 'tool-preparing') {
      const key = callKey(item), old = preparations.get(key);
      if (old) old.discarded = true;
      if (item.phase === 'cancelled') { preparations.delete(key); return; }
      if (status === 'running' && item.callId) {
        const row = { type: 'tool', key: 'preparing-' + key, item,
          model: _executionStreamToolModel(item, '', true) };
        preparations.set(key, row); rows.push(row);
      }
      return;
    }
    if ((kind === 'do' || kind === 'out') && item.callId) {
      const old = preparations.get(callKey(item));
      if (old) old.discarded = true;
    }
    if (kind === 'thinking') {
      flushTool(); flushDiagnostics();
      const key = [item.round || item._round || 1, item.seg || 1,
        item.streamId || item.seq].join(':');
      const text = String(item.full || item.text || '');
      let thought = thoughts.get(key);
      if (!thought) {
        if (!text) return;
        thought = { type: 'thinking', key: 'thinking-' + key,
          item: { ...item, text: '', full: '' }, done: false };
        thoughts.set(key, thought); rows.push(thought);
      }
      if (text || item.delta || !item.done) {
        thought.item.text = (item.delta ? thought.item.text + text : text).slice(-50000);
      }
      thought.done = item.done === true;
      return;
    }
    if (kind === 'user') {
      flushTool(); flushDiagnostics();
      replies.clear();
      thoughts.forEach(thought => { thought.done = true; });
      rows.push({ type: 'user', key: 'user-' + Number(item.seq || rows.length), item });
      return;
    }
    if (_executionStreamIsProtocolStep(item)) {
      /* Step counters belong to the protocol/right-side progress rail, not chat. */
      flushTool(); flushDiagnostics();
      return;
    }
    if (kind === 'say') {
      flushTool(); flushDiagnostics();
      if (item.delta || item.streamId) {
        const key = [item.round || item._round || 1, item.seg || 1,
          item.streamId || 'message'].join(':');
        let reply = replies.get(key);
        if (!reply) {
          if (!item.full && !item.text) return;
          reply = { type: kind, key: kind + '-' + Number(item.seq || rows.length),
            item: { ...item, text: '', full: '' } };
          replies.set(key, reply); rows.push(reply);
        }
        // Match the live transcript contract: full snapshots replace, deltas
        // append, and empty terminal receipts retain the accumulated answer.
        if (Object.prototype.hasOwnProperty.call(item, 'full')) reply.item.text = String(item.full);
        else if (item.delta) reply.item.text += String(item.text || '');
        else if (item.text || !item.done) reply.item.text = String(item.text || '');
        reply.item.done = item.done === true;
        return;
      }
      rows.push({ type: kind, key: kind + '-' + Number(item.seq || rows.length), item });
      return;
    }
    if (kind === 'do') {
      flushTool(); flushDiagnostics();
      pending = { type: 'tool', key: preparations.get(callKey(item))?.key || 'tool-' + Number(item.seq || rows.length), item, result: '' };
      preparations.delete(callKey(item));
      return;
    }
    if (pending) {
      const sameTool = !item.tool || !pending.item.tool ||
        String(item.tool).toLowerCase() === String(pending.item.tool).toLowerCase();
      const processNoise = /stderr|提示|错误|warn|error/i.test(String(item.tool || ''));
      if (sameTool && !processNoise) {
        pending.result = [pending.result, _executionStreamText(item)].filter(Boolean).join('\n');
        return;
      }
    }
    flushTool();
    if (!_executionStreamText(item)) return;
    if (_executionStreamIsDiagnostic(item)) {
      const level = _executionStreamDiagnosticLevel(item);
      if (!diagnostics) diagnostics = { type: 'diagnostics', key: 'diagnostics-' +
        Number(item.seq || rows.length), level, entries: [], at: item.at };
      if (level === 'error') diagnostics.level = 'error';
      const text = _executionStreamText(item);
      const found = diagnostics.entries.find((entry) => entry.text === text);
      if (found) found.count += 1;
      else diagnostics.entries.push({ text, count: 1 });
      return;
    }
    flushDiagnostics();
    if (!_executionStreamText(item)) return;
    rows.push({ type: 'output', key: 'output-' + Number(item.seq || rows.length), item });
  });
  flushTool(); flushDiagnostics();
  if (status !== 'running') thoughts.forEach(thought => { thought.done = true; });
  if (status === 'running') {
    const latest = [...visibleItems].reverse().find((item) => ['do', 'out'].includes(String(item.kind || '')));
    const lastTool = [...rows].reverse().find((row) => row.type === 'tool');
    if (latest && latest.kind === 'do' && lastTool && latest.seq === lastTool.item.seq && !lastTool.result) {
      lastTool.model = _executionStreamToolModel(lastTool.item, '', true);
    }
    rows.push({ type: 'status', key: 'runtime-status', text: '正在执行…' });
  }
  return rows.filter(row => !row.discarded);
}

function _executionStreamToolHtml(row) {
  const t = row.model || _executionStreamToolModel(row.item, row.result, false);
  const view = window.ChatTools && typeof ChatTools.render === 'function' ? ChatTools.render(t) : null;
  // Summary rows do not hydrate raw command receipts or expose a detail action.
  if (view?.summaryOnly) return '<div class="ntool dks-tool ' + esc(t.state) + '" data-dks-node="' + esc(row.key) + '">' +
    '<div class="ntool-head ntool-summary">' + (ChatTools.icon?.(t) || '') + '<span class="ntool-name">' + esc(view.title) +
    '</span><span class="ntool-args">' + esc(view.sub || '') + '</span></div></div>';
  if (view?.side) return '<div class="ntool dks-tool ' + esc(t.state) + '" data-dks-node="' + esc(row.key) + '">' +
    '<button type="button" class="ntool-head" data-dks-read="' + esc(row.key) + '" title="' + esc(view.tip) + '">' +
    (ChatTools.icon?.(t) || '') + '<span class="ntool-name">' + esc(view.title) + '</span>' +
    '<span class="ntool-args ntool-file">' + esc(view.sub) + '</span></button></div>';
  const raw = _executionStreamText(row.item);
  const title = view ? view.title : (row.item.tool || '执行操作');
  const sub = view ? view.sub : raw.replace(/\s+/g, ' ').slice(0, 80);
  return '<div class="ntool dks-tool ' + esc(t.state) + '" data-dks-node="' + esc(row.key) + '">' +
    '<button type="button" class="ntool-head" data-dks-tool="' + esc(row.key) + '" title="' +
      esc((view && view.tip) || raw) + '" aria-expanded="false">' +
    '<span class="ntool-name">' + esc(title) + '</span>' +
    '<span class="ntool-args' + (view?.file ? ' ntool-file' : '') + '">' + esc(sub || '已完成') + '</span>' +
    '<svg class="ntool-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>' +
    '</button><div class="ntool-body rich"></div></div>';
}

function _executionStreamDiagnosticHtml(row) {
  const total = row.entries.reduce((sum, entry) => sum + entry.count, 0);
  const lines = row.entries.map((entry) => (entry.count > 1 ? '×' + entry.count + '  ' : '') + entry.text);
  return '<div class="ntool dks-diagnostics ' + (row.level === 'error' ? 'error' : 'done') +
    '" data-dks-node="' + esc(row.key) + '"><button type="button" class="ntool-head" data-dks-tool ' +
    'aria-expanded="false"><span class="ntool-name">' +
      (row.level === 'error' ? '执行提醒' : '运行环境信息') + '</span><span class="ntool-args">' +
      esc(total + ' 条底座消息，已自动收拢') + '</span><svg class="ntool-caret" viewBox="0 0 24 24" ' +
      'aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>' +
      '<div class="ntool-body"><pre>' + esc(lines.join('\n\n')) + '</pre></div></div>';
}

function _executionStreamRowHtml(row) {
  if (row.type === 'tool') return _executionStreamToolHtml(row);
  if (row.type === 'diagnostics') return _executionStreamDiagnosticHtml(row);
  const item = row.item || {};
  const text = _executionStreamText(item);
  const time = _executionStreamTime(item.at || row.at);
  if (row.type === 'thinking') {
    const live = !row.done;
    return '<div class="nthink dks-thinking' + (live ? ' open is-live' : '') +
      '" data-dks-node="' + esc(row.key) + '">' +
      '<button type="button" class="nthink-head" data-dks-tool aria-expanded="' + live + '">' +
      '<svg class="nthink-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6a3 3 0 0 0-5.8-1A3.5 3.5 0 0 0 4 11a3.5 3.5 0 0 0 1.8 6.4A3.2 3.2 0 0 0 12 19V6Zm0 0a3 3 0 0 1 5.8-1A3.5 3.5 0 0 1 20 11a3.5 3.5 0 0 1-1.8 6.4A3.2 3.2 0 0 1 12 19"/><path d="M7 9c2 0 3 1 3 3m-4 3c0-1.5.7-2.4 2-2.8M17 9c-2 0-3 1-3 3m4 3c0-1.5-.7-2.4-2-2.8"/></svg>' +
      '<span>深度思考</span><svg class="nthink-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>' +
      '<div class="nthink-body" data-user-content>' + esc(text) + '</div></div>';
  }
  if (row.type === 'user') {
    return '<article class="nmsg user dks-message" data-dks-node="' + esc(row.key) + '"' +
      (time ? ' title="' + esc(time) + '"' : '') + '><div class="nbubble">' + esc(text) + '</div></article>';
  }
  if (row.type === 'say') {
    return '<article class="nmsg ai dks-message" data-dks-node="' + esc(row.key) + '"' +
      (time ? ' title="' + esc(time) + '"' : '') + '>' + _executionStreamMarkdown(text) + '</article>';
  }
  if (row.type === 'process') {
    return '<div class="nprocess dks-process" data-dks-node="' + esc(row.key) + '"' +
      (time ? ' title="' + esc(time) + '"' : '') + '><span aria-hidden="true"></span><p>' +
      esc(row.text || text || '继续推进') + '</p></div>';
  }
  if (row.type === 'status') {
    return '<div class="nstatus show dks-status" data-dks-node="runtime-status">' +
      '<span class="ndot"></span><span>' + esc(row.text || '正在执行…') + '</span></div>';
  }
  return '<div class="ntool dks-diagnostics done" data-dks-node="' + esc(row.key) + '">' +
    '<button type="button" class="ntool-head" data-dks-tool aria-expanded="false">' +
    '<span class="ntool-name">输出</span>' +
    '<span class="ntool-args">' + esc(text.split(/\r?\n/)[0].slice(0, 100)) + '</span>' +
    '<svg class="ntool-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>' +
    '</button><div class="ntool-body"><pre>' + esc(text) + '</pre></div></div>';
}

function _executionStreamRowsHtml(items, status) {
  return _executionStreamRows(items, status).map(_executionStreamRowHtml).join('');
}

function _executionStreamToolEntry(button, entries, attribute) {
  const stream = button.closest('[data-task-stream]');
  const entry = (entries || []).find(item => String(item.taskId) === stream?.dataset.taskStream);
  if (!entry) return null;
  const runId = stream.dataset.taskRun;
  const active = entry.controlledExecution?.run;
  const state = runId ? (active && String(active.ref || active.id) === runId ? active :
    entry.trace?.execution?.sessions?.find(run => String(run.ref || run.id) === runId)) : entry.controller?.snapshot();
  const row = _executionStreamRows(state?.items || state?.events || [], state?.status)
    .find(item => item.key === button.getAttribute(attribute));
  return row?.model ? { ...row.model, id: (stream.dataset.chatNode || entry.taskId) + ':' + row.key } : null;
}
function _executionStreamOpenRead(button, entries) {
  const tool = _executionStreamToolEntry(button, entries, 'data-dks-read');
  return tool && window.ChatTools?.render(tool)?.side ? ChatTools.openSide(tool) : false;
}
function _executionStreamHydrateTool(button, entries) {
  if (!button.getAttribute('data-dks-tool')) return;
  const tool = _executionStreamToolEntry(button, entries, 'data-dks-tool');
  const body = button.closest('.ntool')?.querySelector('.ntool-body');
  if (!tool || !body) return;
  const view = window.ChatTools?.render(tool);
  if (view?.summaryOnly) return;
  const html = view?.body || '<pre>' + esc(tool.result || '已完成') + '</pre>';
  if (body.innerHTML !== html) window.ChatDomPatch.patchHtml(body, html);
}

/* Patch only changed nodes so incoming events preserve expanded tools and text selection. */
window.TaskExecutionStream = Object.freeze({
  visibleItems: _executionStreamVisibleItems,
  rows: _executionStreamRows,
  rowsHtml: _executionStreamRowsHtml,
  openRead: _executionStreamOpenRead,
  hydrateTool: _executionStreamHydrateTool,
  emptyState: _executionStreamEmptyState,
  blankHtml: _executionStreamBlankHtml,
  isDiagnostic: _executionStreamIsDiagnostic,
  toolModel: _executionStreamToolModel,
  isThinkingStep: _executionStreamIsThinkingStep,
  isProtocolStep: _executionStreamIsProtocolStep,
});
