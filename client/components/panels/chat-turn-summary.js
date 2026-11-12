/* Completed-turn presentation only. Source messages and output ownership stay intact. */
(function (global) {
  'use strict';
  const owner = (snap, index) => snap.history?.messageIndices?.[index] ??
    ((Number(snap.history?.messageStart) || 0) + index);
  const epoch = value => typeof value === 'number' ? value : Date.parse(value || '');
  const tx = value => global.SoduWorkI18n?.translateText?.(value) || value;
  function tokenInfo(messages, from, to, metric) {
    if (Number.isFinite(metric?.tokens)) return { tokens: metric.tokens, tokensEstimated: false };
    const counter = global.ChatStatus || (typeof require === 'function' ? require('./panels-chat-status') : null);
    if (!counter?.outputTokens || !counter?.estimateOutput) return { tokens: null, tokensEstimated: false };
    let tokens = 0, known = false, estimated = messages[from]?.role !== 'user';
    for (let index = from; index <= to; index++) {
      const message = messages[index];
      if (message?.role !== 'assistant') continue;
      const actual = counter.outputTokens(message.usage);
      if (actual !== null) { tokens += actual; known = true; }
      else {
        const estimate = counter.estimateOutput(message);
        tokens += estimate; known = known || estimate > 0; estimated = true;
      }
    }
    // Old native archives may lack turn receipts. Estimate only their exposed
    // output; context occupancy and cumulative session billing are unrelated.
    return { tokens: known ? tokens : null, tokensEstimated: known && estimated };
  }
  function project(snap, finalReplies) {
    const messages = snap.messages || [], turns = [];
    let from = 0;
    messages.forEach((message, index) => {
      if (message.role === 'user') from = index;
      if (!finalReplies.has(index) || message.done === false) return;
      let to = index;
      while (to + 1 < messages.length && messages[to + 1].role !== 'user') to++;
      if ((snap.tools || []).some(tool => tool.state === 'running' &&
        (Number(tool.after) || 0) >= from && (Number(tool.after) || 0) <= to)) return;
      const absolute = owner(snap, index);
      const metric = (snap.turnMetrics || []).find(row => row.fromMessage <= absolute && row.toMessage >= absolute);
      const start = messages[from]?.role === 'user' ? epoch(messages[from].sentAt) : NaN;
      const end = epoch(message.completedAt);
      const wallTime = Number.isFinite(start) && start > 0 && Number.isFinite(end) && end >= start ? end - start : null;
      // The latest cloud receipt belongs to the remote turn, not replay arrival times.
      const latestCloud = snap.execution?.cloud && to === messages.length - 1;
      const cloudElapsed = !snap.execution?.running && snap.execution?.completedAt > 0 &&
        Number.isFinite(snap.execution.elapsedMs) ? snap.execution.elapsedMs : null;
      turns.push({ key: 'reply:' + absolute, from, to, finalIndex: index,
        lastToolBlock: (message.blocks || []).findLastIndex(block => block.kind === 'toolcall'),
        ...tokenInfo(messages, from, to, metric),
        elapsedMs: latestCloud ? cloudElapsed : Number.isFinite(metric?.elapsedMs) ? metric.elapsedMs : wallTime,
        wallTime: !latestCloud && !Number.isFinite(metric?.elapsedMs),
      });
    });
    return turns;
  }
  function create(ctx) {
    const expanded = new Set();
    let scope = '', turns = [], byIndex = new Map(), boundList = null;
    const duration = value => {
      if (value === null) return ctx.esc(tx('未记录'));
      const seconds = Math.floor(Math.max(0, value) / 1000);
      return seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + String(seconds % 60).padStart(2, '0') + 's';
    };
    function reset() { expanded.clear(); turns = []; byIndex.clear(); scope = ''; }
    function prepare(snap, finals) {
      const nextScope = JSON.stringify([ctx._ref || '', global.SoduWorkAPI?.taskStorageKey?.('ops') || '']);
      if (scope !== nextScope) { reset(); scope = nextScope; }
      turns = project(snap, finals); byIndex = new Map();
      turns.forEach(turn => { for (let index = turn.from; index <= turn.to; index++) byIndex.set(index, turn); });
      return byIndex;
    }
    function html(turn, currentMetrics) {
      const open = expanded.has(turn.key);
      const label = ctx.esc(tx(open ? '收起过程' : '展开过程'));
      // A completed turn owns immutable timing, including after switching or
      // reopening. A live counter cannot supply a missing historical duration.
      // Keep the footer focused on elapsed time. Token usage remains in the
      // immutable turn metrics for compaction/diagnostics, but is not part of
      // the message metadata shown to users.
      let values = currentMetrics ? currentMetrics.replace(/^<div\b[^>]*>/, '').replace(/<\/div>$/, '')
        : '<span>' + ctx.esc(tx('用时')) + ' ' + duration(turn.elapsedMs) + '</span>';
      values = values.replace(/(<span\b[^>]*\bdata-thinking-label[^>]*>)[\s\S]*?(<\/span>)/,
        (_, before, after) => before + ctx.esc(tx('用时')) + after);
      if (currentMetrics) {
        values = values.replace(/(<b\b[^>]*\bdata-thinking-elapsed[^>]*>)[\s\S]*?(<\/b>)/,
          (_, before, after) => before + duration(turn.elapsedMs) + after);
      }
      if (currentMetrics) {
        values = values
          // The token metric is a nested status item. Removing only its value
          // leaves the surrounding `tokens` label visible in completed turns.
          .replace(/<span\b(?=[^>]*\bclass=["'][^"']*\bnstatus-metric\b[^"']*["'])[^>]*>(?:(?!<span\b(?=[^>]*\bclass=["'][^"']*\bnstatus-metric\b[^"']*["'])[^>]*>)[\s\S])*?<b\b[^>]*\bdata-thinking-tokens\b[^>]*>[\s\S]*?<\/b>[\s\S]*?<\/span>\s*/gi, '')
          .replace(/<span\b[^>]*\bdata-thinking-estimate[^>]*>[\s\S]*?<\/span>/g, '')
          .replace(/<b\b[^>]*\bdata-thinking-tokens[^>]*>[\s\S]*?<\/b>/g, '')
          .replace(/<span\b[^>]*\bdata-thinking-tokens[^>]*>[\s\S]*?<\/span>/g, '')
          .replace(/<span\b[^>]*>\s*(?:≈\s*)?(?:—|[\d,]+)?\s*tokens\s*<\/span>/gi, '')
          .replace(/<b\b[^>]*>\s*(?:≈\s*)?(?:—|[\d,]+)?\s*tokens\s*<\/b>/gi, '')
          .replace(/\s+tokens?\b/gi, '')
          .replace(/<span\b[^>]*class=["']nstatus-divider["'][^>]*>\s*·\s*<\/span>/g, '');
      }
      return '<div class="nturn-summary" data-chat-node="turn-summary:' + ctx.esc(turn.key) + '">' +
        '<button type="button" data-turn-toggle="' + ctx.esc(turn.key) + '" aria-expanded="' + open +
        '" title="' + label + '" aria-label="' + label + '">' +
        '<span class="nturn-summary-values" title="' + ctx.esc(tx('包含深度思考与回复')) + '">' + values + '</span>' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button></div>';
    }
    function apply(list) {
      if (!list?.querySelectorAll) return;
      list.querySelectorAll('[data-turn-hidden]').forEach(node => node.removeAttribute('data-turn-hidden'));
      list.querySelectorAll('[data-turn-process]').forEach(node => node.removeAttribute('data-turn-process'));
      const hide = node => node.setAttribute('data-turn-hidden', '');
      for (const row of Array.from(list.children || [])) {
        const key = row.dataset.chatNode || '';
        const message = /^message:(\d+)$/.exec(key);
        const tools = /^(?:tools|process):message:(\d+)(?::|$)/.exec(key);
        const index = message ? Number(message[1]) : tools ? Number(tools[1]) :
          /^(?:(?:tools|process):tail|goal-progress:)/.test(key) ? (ctx._snap?.messages?.length || 1) - 1 : -1;
        const turn = byIndex.get(index);
        if (!turn || expanded.has(turn.key) || row.classList.contains('user')) continue;
        if (message) {
          row.querySelectorAll(':scope > .nthink').forEach(hide);
          row.querySelectorAll(':scope > .ntext').forEach(node => {
            if (index !== turn.finalIndex || Number(node.dataset.block) <= turn.lastToolBlock) hide(node);
          });
          if (index !== turn.finalIndex) {
            row.querySelectorAll(':scope > .nmessage-footer').forEach(hide);
            row.setAttribute('data-turn-process', '');
          }
        } else row.setAttribute('data-turn-process', '');
      }
      list.querySelectorAll('[data-turn-toggle]').forEach(button => {
        const open = expanded.has(button.dataset.turnToggle);
        button.setAttribute('aria-expanded', String(open));
        button.title = tx(open ? '收起过程' : '展开过程');
        button.setAttribute('aria-label', button.title);
      });
      if (boundList === list) return;
      boundList = list;
      list.addEventListener('click', event => {
        const button = event.target.closest?.('[data-turn-toggle]');
        if (!button || !list.contains(button)) return;
        event.preventDefault();
        const key = button.dataset.turnToggle;
        if (!turns.some(turn => turn.key === key)) return;
        const top = button.getBoundingClientRect().top;
        if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
        apply(list);
        const scroll = list.closest('.nchat-scroll');
        if (scroll) scroll.scrollTop += button.getBoundingClientRect().top - top;
      });
    }
    return { prepare, html, apply, reset };
  }
  const api = { project, create };
  global.ChatTurnSummary = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
