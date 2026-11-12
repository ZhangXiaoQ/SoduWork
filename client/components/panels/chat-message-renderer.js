/* Ordinary message rendering and incremental patching; NativeChat owns state. */
(function (global) {
  'use strict';
  // Auto growth caps at 400; explicit history windows retain the backend's 2000-message ceiling.
  function growMessageWindow(currentSize, addedCount) {
    const current = Number(currentSize) || 80, grown = current + addedCount;
    return Math.max(current, Math.min(grown, current <= 400 ? 400 : 2000));
  }
  function create(ctx) {
  const uiText = value => global.SoduWorkI18n?.translateText?.(value) || value;
  const pluginBadges = global.ChatMessagePlugins?.create(ctx, () => { liveStreamShape = null; _render(); });
  const turnSummary = global.ChatTurnSummary?.create(ctx);
  const { _ctxText, _tokenText, _ctxHtml } = global.ChatContextMeter.create(ctx);
  const { _releaseScrollFollow, _ensureScrollFollow, _nearBottom, _followLatest, _updateScrollButton, _captureReadingAnchor, _restoreReadingAnchor, _preserveReadingPosition } = global.ChatScrollFollow.create(ctx);
  const markdown = global.ChatMarkdown.create(ctx, () => {
    if (ctx._snap?.status === 'streaming') _render();
  });
  const { rich, _richPlain, _streamText, _patchStreamNode, _ensureHlCss, _inject } = markdown;
  const _findDataNode = global.ChatDomPatch?.findDataNode || ((root, attribute, value) => {
    for (const node of root.querySelectorAll('[' + attribute + ']')) { if (node.getAttribute(attribute) === String(value)) return node; }
    return null;
  });
  let lastList = null, lastMessageCount = 0;
  let outputScope = '';
  let liveStreamShape = null;
  let approvalMarkup = '';
  let streamMarkup = new WeakMap();
  let thinkingRef = null;
  const liveThinkingKeys = new Set();
  const acceptance = global.ChatAcceptanceResults.create(ctx, { rich, render: _render,
    invalidate: () => { liveStreamShape = null; _render(); } });
  function _pendingIsConfirmed(messages) {
    const text = String(ctx._pending || '');
    if (!text) return false;
    const sentAt = Number(ctx._pendingSentAt || 0);
    const baseline = ctx._pendingBaseline || {};
    const history = ctx._snap?.history || {};
    const baselineTotal = baseline.historyTotal == null ? NaN : Number(baseline.historyTotal);
    const baselineMessages = Number(baseline.messageCount);
    const submissionId = String(baseline.submissionId || '').trim();
    const normalized = value => String(value || '').trim();
    const isNewMessage = index => {
      const rawIndex = Array.isArray(history.messageIndices) ? Number(history.messageIndices[index]) : NaN;
      if (Number.isFinite(rawIndex) && Number.isFinite(baselineTotal) && baselineTotal >= 0) {
        return rawIndex >= baselineTotal;
      }
      return Number.isFinite(baselineMessages) && index >= baselineMessages;
    };
    return (messages || []).some((message, index) => {
      if (!message || message.role !== 'user') return false;
      if (submissionId && String(message.submissionId || '').trim() === submissionId) return true;
      if (message.text !== text && normalized(message.text) !== normalized(text)) return false;
      // A matching row from the send baseline is the authoritative echo even
      // when the adapter omits or rounds its timestamp. Older identical rows
      // still need a timestamp at or after the pending send time.
      if (isNewMessage(index)) return true;
      if (!(sentAt > 0)) return false;
      const messageAt = Number(message.sentAt || 0);
      return messageAt >= sentAt;
    });
  }
  function reset() {
    global.SoduWorkReadAloud?.stop();
    global.ChatToolDetails?.reset(ctx);
    global.ChatCrew?.close?.();
    pluginBadges?.reset();
    global.ChatThinkingCollapse?.reset(lastList);
    _releaseScrollFollow();
    markdown.reset();
    global.ChatOutputLinks?.resetDecorateCache?.();
    lastList = null; lastMessageCount = 0; liveStreamShape = null; thinkingRef = null; outputScope = '';
    streamMarkup = new WeakMap();
    liveThinkingKeys.clear();
    acceptance.reset();
    approvalMarkup = '';
    turnSummary?.reset();
  }

  const CARET = '<svg class="nthink-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
  const THINK_ICON = '<svg class="nthink-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6a3 3 0 0 0-5.8-1A3.5 3.5 0 0 0 4 11a3.5 3.5 0 0 0 1.8 6.4A3.2 3.2 0 0 0 12 19V6Zm0 0a3 3 0 0 1 5.8-1A3.5 3.5 0 0 1 20 11a3.5 3.5 0 0 1-1.8 6.4A3.2 3.2 0 0 1 12 19"/><path d="M7 9c2 0 3 1 3 3m-4 3c0-1.5.7-2.4 2-2.8M17 9c-2 0-3 1-3 3m4 3c0-1.5-.7-2.4-2-2.8"/></svg>';
  const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><g class="ncopy-default"><rect x="8.5" y="7.5" width="10.5" height="12" rx="2"/><path d="M15.5 7.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v8A2.5 2.5 0 0 0 6 16.5h2.5"/></g><path class="ncopy-check" d="m5.5 12.5 3.2 3.2 9.8-10"/></svg>';
  function _copyButton(text, className, afterBlock = -1) {
    return '<button type="button" class="' + (className || 'ntext-copy') +
      '" data-copy-message="' + ctx.esc(String(text || '')) +
      '"' + (afterBlock >= 0 ? ' data-copy-after-block="' + afterBlock + '"' : '') +
      ' title="复制内容" aria-label="复制内容">' + COPY_ICON + '</button>';
  }

  // Use persisted event times only; opening an older transcript must not create a new time.
  function _messageFooter(message, text, afterBlock = -1, messageIndex = '') {
    const user = message.role === 'user';
    const value = user ? message.sentAt : (message.done !== false ? message.completedAt : null);
    const epoch = typeof value === 'number' ? value : (value ? Date.parse(value) : NaN);
    const date = new Date(epoch);
    let time = '';
    if (Number.isFinite(epoch) && epoch > 0 && Number.isFinite(date.getTime())) {
      const pad = number => String(number).padStart(2, '0');
      const clock = pad(date.getHours()) + ':' + pad(date.getMinutes());
      const full = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
        ' ' + clock + ':' + pad(date.getSeconds());
      const now = new Date();
      const today = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
      const locale = global.SoduWorkI18n?.getLocale?.() || 'zh-CN';
      const day = today ? '' : new Intl.DateTimeFormat(locale, {
        ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}), month: 'short', day: 'numeric',
      }).format(date) + ' ';
      time = '<span class="nmessage-time" title="' + (user ? '发送时间' : '输出完成时间') + '">' +
        '<time data-user-content tabindex="0" datetime="' + date.toISOString() + '" title="' + full + '">' +
        ctx.esc(day + clock) + '</time></span>';
    }
    const copy = String(text || '').trim() ? _copyButton(text, user ? 'nmessage-copy' : 'ntext-copy', afterBlock) : '';
    const speech = !user && message.done !== false && String(text || '').trim()
      ? global.SoduWorkReadAloud?.button(text, ctx._ref, messageIndex, ctx.esc) || '' : '';
    return time || copy || speech ? '<div class="nmessage-footer">' + time + speech + copy + '</div>' : '';
  }

  // A provider message can end before a tool runs. Only the last substantive
  // reply in a completed user turn owns the answer actions, including archives.
  function _finalReplyIndexes(messages, tools, settled) {
    const results = new Set();
    const orderedTools = tools.map(tool => ({ tool, after: Math.max(0, Number(tool.after) || 0) })).sort((a, b) => a.after - b.after);
    let candidate = -1, toolIndex = 0;
    const finish = (boundary, complete) => {
      const message = messages[candidate];
      // Pi may merge a permission/length continuation with earlier tool calls.
      // Only explicit block order can place a same-message tool before the answer.
      const blocks = message?.blocks || [];
      const lastText = blocks.findLastIndex(block => block.kind === 'text' && String(block.text || '').trim());
      let followedByTool = false;
      while (toolIndex < orderedTools.length && orderedTools[toolIndex].after < boundary) {
        const { tool, after } = orderedTools[toolIndex++];
        const call = after === candidate ? blocks.findIndex(block => block.kind === 'toolcall' && block.toolCall?.id === tool.id) : -1;
        if (after > candidate || after === candidate && !(call >= 0 && call < lastText && ['done', 'error'].includes(tool.state))) followedByTool = true;
      }
      if (complete && candidate >= 0 && !followedByTool) results.add(candidate);
      candidate = -1;
    };
    messages.forEach((message, index) => {
      if (message.role === 'user') { finish(index, true); return; }
      if (message.role !== 'assistant') return;
      const blocks = (message.blocks || []).filter(block => block.kind === 'toolcall' || String(block.text || '').trim());
      const incomplete = message.done === false || message.errorMessage ||
        /^(tool_?use|tool_?calls?|error|aborted|cancelled|canceled|length|max_tokens)$/i.test(message.stopReason || '');
      if (!blocks.length) { if (incomplete) candidate = -1; return; } // Ignore successful usage-only tails.
      const last = blocks[blocks.length - 1];
      candidate = !incomplete && last.kind === 'text' && last.done !== false ? index : -1;
    });
    finish(Infinity, settled);
    return results;
  }

  function _computerTool(tool) {
    const args = tool && tool.args;
    const signal = [tool && tool.name, tool && tool.tool, tool && tool.command,
      typeof args === 'string' ? args : '', args && args.command, args && args.cmd, args && args.script]
      .filter(Boolean).join(' ');
    return /computer-use|compute-use|screen\.ps1|操作电脑|桌面操作/i.test(signal);
  }

  function _syncComputerGlow(active) {
    const doc = global.document;
    if (!doc || !doc.body) return;
    let glow = doc.getElementById('computerActivityGlow');
    if (active && !glow) {
      glow = doc.createElement('div');
      glow.id = 'computerActivityGlow';
      glow.className = 'computer-activity-glow';
      glow.setAttribute('aria-hidden', 'true');
      doc.body.appendChild(glow);
    }
    if (glow) glow.classList.toggle('is-active', Boolean(active));
    if (!active && glow) glow.remove();
  }

  /* Streaming snapshots arrive once per provider token. Rebuilding the full
     transcript for each one is expensive: Markdown, tool grouping, output
     hydration, and the DOM diff all repeat work that changed only in the last
     text block. Keep a small structural fingerprint and patch the live tail
     in place while the turn is streaming. A structural change falls back to
     the normal renderer so all rich behavior remains authoritative. */

  function _messageOwner(index, snap = ctx._snap) {
    const absolute = snap?.history?.messageIndices?.[index];
    return String(Number.isInteger(absolute) ? absolute : (Number(snap?.history?.messageStart) || 0) + index);
  }
  function _workflowSlot(message) {
    return message?.taskOutputKey ? '<div class="nworkflow-message-slot" data-workflow-message-key="' +
      ctx.esc(message.taskOutputKey) + '"></div>' : '';
  }
  function _streamStructure(snap, messages, tools) {
    const textBlocks = [], thinkingBlocks = [], messageShape = [];
    const start = Math.max(0, messages.length - 24);
    messages.slice(start).forEach((message, offset) => {
      const index = start + offset;
      const blocks = Array.isArray(message && message.blocks) ? message.blocks : [];
      const shape = [index, _messageOwner(index, snap), message && message.role || '', message?.taskOutputKey || '', global.AgentBrand?.sourceKey(message?.sourceAgent) || '', blocks.length, Boolean(message?.done), message?.sentAt || '', message?.completedAt || ''];
      let textIndex = 0;
      blocks.forEach((block, blockIndex) => {
        const kind = block && block.kind || '';
        shape.push(kind + ':' + Boolean(block?.done) + ':' + (kind === 'text' && Boolean(String(block.text || '').trim())));
        if (kind === 'text') textBlocks.push({ index, blockIndex, textIndex: textIndex++, text: String(block.text || '') });
        if (kind === 'thinking') thinkingBlocks.push({ index, blockIndex, blockKey: block.index ?? blockIndex, text: String(block.text || '') });
      });
      messageShape.push(shape.join(':'));
    });
    const toolShape = tools.slice(-40).map((tool) => [
      String(tool && tool.id || ''), String(tool && tool.state || ''), global.AgentBrand?.sourceKey(tool?.sourceAgent) || '',
      String(tool && tool.name || ''), tool.phase || '', tool.phase === 'preparing' ? tool.args?.path || '' : '', Number(tool && tool.after || 0), global.ChatTools?.kind?.(tool) || '', ctx._openTool.has(tool.id) && tool.state !== 'running' ? tool.detailVersion || '' : '',
    ].join(':'));
    // Older active tools still affect retained rows and the turn's crew status.
    // Track their identity without inspecting large tool arguments or receipts.
    const runningToolShape = tools.filter(tool => tool?.state === 'running').map(tool => JSON.stringify([
      String(tool.id || ''), Number(tool.after || 0), global.AgentBrand?.sourceKey(tool.sourceAgent) || '',
    ]));
    const execution = snap.execution || {};
    const queue = execution.turnQueue || {};
    const queueShape = (queue.tasks || []).map((task) => [task.taskId, task.status].join(':'));
    return {
      ref: ctx._ref,
      status: snap.status || '',
      liveTextKey: ctx._liveTextKey,
      messages: messages.length,
      windowSize: Math.max(80, Number(ctx._messageWindowSize) || 80),
      tools: tools.length,
      textBlocks, thinkingBlocks, messageShape, toolShape, runningToolShape, queueShape,
      running: Boolean(execution.running),
      paused: Boolean(execution.limitRequest),
      stopped: Boolean(execution.stopped),
      quality: String((execution.quality || {}).phase || ''),
      pendingUi: Boolean(snap.pendingUi),
      notice: String((Array.isArray(snap.notices) && snap.notices[snap.notices.length - 1] || {}).message || ''),
    };
  }

  function _sameArray(a, b) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }

  function _patchLiveStream(list, snap, messages, tools) {
    if (!list || !snap || snap.status !== 'streaming' || !liveStreamShape) return false;
    const shape = _streamStructure(snap, messages, tools);
    if (shape.ref !== liveStreamShape.ref || shape.status !== liveStreamShape.status ||
        shape.liveTextKey !== liveStreamShape.liveTextKey ||
        shape.messages !== liveStreamShape.messages || shape.windowSize !== liveStreamShape.windowSize ||
        shape.tools !== liveStreamShape.tools ||
        !_sameArray(shape.messageShape, liveStreamShape.messageShape) ||
        !_sameArray(shape.toolShape, liveStreamShape.toolShape) ||
        !_sameArray(shape.runningToolShape, liveStreamShape.runningToolShape) ||
        !_sameArray(shape.queueShape, liveStreamShape.queueShape) ||
        shape.running !== liveStreamShape.running || shape.paused !== liveStreamShape.paused ||
        shape.stopped !== liveStreamShape.stopped || shape.quality !== liveStreamShape.quality ||
        shape.pendingUi !== liveStreamShape.pendingUi || shape.notice !== liveStreamShape.notice) return false;

    let valid = true;
    // Use the same live-block identity as the full renderer. Waiting, thinking,
    // and tool-only turns must never rewrite a previous result as streaming text.
    const liveTextBlocks = shape.textBlocks.filter(block =>
      block.index + ':' + block.blockIndex === ctx._liveTextKey);
    liveTextBlocks.forEach((block) => {
      const node = _findDataNode(list, 'data-chat-node', 'message:' + block.index);
      const text = node && node.querySelectorAll('.ntext')[block.textIndex];
      if (!text) { valid = false; return; }
      const copy = node.querySelector('.nmessage-footer [data-copy-message]');
      const html = _streamText(block.text);
      if (streamMarkup.get(text) !== html) {
        const next = text.cloneNode(false);
        next.innerHTML = html;
        _patchStreamNode(text, next);
        streamMarkup.set(text, html);
      }
      const copyText = (messages[block.index]?.blocks || []).filter(item => item.kind === 'text').map(item => item.text || '').join('\n\n');
      if (copy && copy.getAttribute('data-copy-message') !== copyText) copy.setAttribute('data-copy-message', copyText);
    });
    shape.thinkingBlocks.forEach((block) => {
      const before = liveStreamShape.thinkingBlocks.find(previous => previous.index === block.index && previous.blockKey === block.blockKey);
      if (before && before.text === block.text) return;
      const node = _findDataNode(list, 'data-chat-node', 'message:' + block.index);
      const body = node && node.querySelector('[data-thinking-body="' + block.index + ':' + block.blockKey + '"]');
      if (!body) { valid = false; return; }
      /* Skipped rows have no user-visible scroll state; reading their scroll
         metrics would force a layout of the skipped row on every token. */
      const hidden = typeof body.checkVisibility === 'function' &&
        !body.checkVisibility({ contentVisibilityAuto: true });
      const follow = !hidden && body.scrollHeight - body.scrollTop - body.clientHeight < 36;
      if (body.firstChild?.nodeType === 3 && body.childNodes.length === 1) body.firstChild.nodeValue = block.text;
      else body.textContent = block.text;
      if (follow && body.closest('.nthink.is-live')) body.scrollTop = body.scrollHeight;
    });
    /* Running tool bodies are the other frequently changing nodes. Their
       shell and grouping are stable here; only replace the body markup. */
    tools.filter((tool) => tool && tool.state === 'running').forEach((tool) => {
      if (!ctx._openTool.has(tool.id) || tool.phase === 'preparing' || global.ChatTools?.render(tool)?.side || global.ChatTools?.isCommandTool?.(tool)) return;
      const node = _findDataNode(list, 'data-tool-node', tool.id);
      const body = node && node.querySelector('.ntool-body');
      if (!body) { valid = false; return; }
      const html = _toolHtml(tool);
      if (streamMarkup.get(body) === html) return;
      const holder = document.createElement('template');
      holder.innerHTML = html;
      const next = holder.content.querySelector('.ntool-body');
      if (next) _patchStreamNode(body, next);
      streamMarkup.set(body, html);
    });
    if (!valid) return false;
    liveStreamShape = shape;
    ctx._refreshTurnMetrics?.();
    return true;
  }

  function _blockHtml(mi, b, blockIndex) {
    if (b.kind === 'thinking') {
      if (thinkingRef !== ctx._ref) { thinkingRef = ctx._ref; liveThinkingKeys.clear(); }
      const k = mi + ':' + (b.index ?? blockIndex);
      const messages = ctx._snap?.messages || [];
      const message = messages[mi];
      const active = ctx._snap?.status === 'streaming' && mi === messages.length - 1 &&
        !message?.done && !b.done && blockIndex === (message?.blocks || []).length - 1;
      if (active) liveThinkingKeys.add(k);
      else if (liveThinkingKeys.delete(k)) { ctx._openThink.delete(k); ctx._closedThink?.delete(k); }
      const open = ctx._openThink.has(k) || (active && !ctx._closedThink?.has(k));
      return '<div class="nthink' + (open ? ' open' : '') + (active ? ' is-live' : '') + '">' +
        '<button type="button" class="nthink-head" data-think="' + k + '" aria-expanded="' + open + '">' + THINK_ICON +
          '<span>深度思考</span>' + CARET + '</button>' +
        '<div class="nthink-body" data-thinking-body="' + k + '" data-user-content>' + ctx.esc(b.text) + '</div></div>';
    }
    if (b.kind === 'text') {
      // Stream Markdown at a bounded rate without discarding earlier content;
      // settled blocks use the ordinary sanitized Markdown cache.
      const streaming = ctx._snap && ctx._snap.status === 'streaming' &&
        ctx._liveTextKey === mi + ':' + blockIndex;
      const content = streaming ? _streamText(b.text) :
        (acceptance.html(b.text, _messageOwner(mi, ctx._snap) + ':' + blockIndex, mi) || rich(b.text));
      return '<div class="ntext" data-block="' + blockIndex + '">' + content + '</div>';
    }
    return '';        // Tool cards already represent toolcall blocks; do not render them twice.
  }

  const _MCP_SAY = {
    task_options: '看了看有哪些执行机和流程',
    task_propose: '提议了一条需求',
    task_create: '建了一条需求',
    task_list: '查了我名下的需求',
    task_get: '看了那条需求的详情',
    task_update: '改了那条需求',
  };

  function _friendlyTool(t) {
    if (t.name === 'generate_image') return { name: '图片生成', say: t.state === 'running' ? '正在生成图片…' :
      t.isError ? '图片生成未完成' : '图片已生成' };
    const cmd = String((t.args && (t.args.command || t.args.cmd)) || '');
    /*
     * Allow a closing quote after .mjs so quoted command paths containing spaces still match.
     */
    const m = cmd.match(/mcp\.mjs["']?\s+(\w+)(?:\s+(\S+))?(?:\s+(\w+))?/);
    if (!m) return null;
    if (m[1] === 'call') return { name: 'SoduWork', say: _MCP_SAY[m[3]] || ('调了 ' + (m[3] || '一个工具')) };
    if (m[1] === 'list') return { name: 'SoduWork', say: '看了看有哪些工具可用' };
    if (m[1] === 'servers') return { name: 'SoduWork', say: '看了看接了哪些外部系统' };
    return null;
  }

  function _toolBody(t) {
    const raw = t.state === 'running' ? t.partial : t.result;
    if (raw) return '<span data-user-content>' + ctx.esc(raw) + '</span>';
    const fallback = t.state === 'running' ? '正在执行…' : '（没有输出）';
    return global.SoduWorkI18n?.html(fallback, fallback) || ctx.esc(fallback);
  }

  function _toolHtml(t) {
    const open = ctx._openTool.has(t.id);
    const hydrate = open;
    const kind = (global.ChatTools && global.ChatTools.render) ? global.ChatTools.render(t) : null;
    if (kind?.summaryOnly) return '<div class="ntool ' + t.state + '" data-tool-node="' + ctx.esc(t.id) + '">' +
      '<div class="ntool-head ntool-summary">' + (global.ChatTools?.icon ? ChatTools.icon(t) : '') +
      '<span class="ntool-name">' + ctx.esc(kind.title) + '</span>' +
      '<span class="ntool-args"' + (kind.localizedSub ? '' : ' data-user-content') + '>' + (kind.subHtml || ctx.esc(kind.sub || '')) + '</span></div></div>';
    if (kind) {
      /* Open write/edit cards in the data-tool-side pane rather than inline. */
      return '<div class="ntool ' + t.state + (open && !kind.readSnapshot ? ' open' : '') + '"' + (kind.side ? ' data-tool-side="1"' : '') + ' data-tool-node="' + ctx.esc(t.id) + '">' +
        '<button class="ntool-head" data-tool="' + ctx.esc(t.id) + '" title="' + ctx.esc(kind.tip || '') + '">' +
          (global.ChatTools?.icon ? ChatTools.icon(t) : '') +
          "<span class=\"ntool-name\">" + ctx.esc(kind.title) + '</span>' +
          '<span class="ntool-args' + (kind.file ? ' ntool-file' : '') + '"' + (kind.localizedSub ? '' : ' data-user-content') + '>' + (kind.subHtml || ctx.esc(kind.sub || '')) + '</span>' +
          '<svg class="ntool-caret" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>' +
        '</button>' +
        (kind.readSnapshot ? '' : '<div class="ntool-body rich">' + (hydrate && !kind.side ? (global.ChatToolDetails?.bodyHtml(ctx, t, kind) ?? kind.body) : '') + '</div>') + '</div>';
    }
    const nice = _friendlyTool(t);
    if (nice) {
      return '<div class="ntool ' + t.state + (open ? ' open' : '') + '" data-tool-node="' + ctx.esc(t.id) + '">' +
        '<button class="ntool-head" data-tool="' + ctx.esc(t.id) + '">' +
          (global.ChatTools?.icon ? ChatTools.icon(t) : '') +
          "<span class=\"ntool-name\">" + ctx.esc(nice.name) + '</span>' +
          '<span class="ntool-args">' + ctx.esc(nice.say) + '</span>' +
          '<svg class="ntool-caret" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>' +
        '</button>' +
        '<div class="ntool-body">' + (hydrate
          ? _toolBody(t)
          : '') + '</div></div>';
    }
    const args = t.args ? JSON.stringify(t.args) : '';

    return '<div class="ntool ' + t.state + (open ? ' open' : '') + '" data-tool-node="' + ctx.esc(t.id) + '">' +
      '<button class="ntool-head" data-tool="' + ctx.esc(t.id) + '">' +
        (global.ChatTools?.icon ? ChatTools.icon(t) : '') +
        '<span class="ntool-name"' + (t.name ? ' data-user-content' : '') + '>' + ctx.esc(t.name || '工具') + '</span>' +
        '<span class="ntool-args" data-user-content>' + ctx.esc(args.length > 120 ? args.slice(0, 120) + '…' : args) + '</span>' +
        '<svg class="ntool-caret" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>' +
      '</button>' +
      '<div class="ntool-body">' + (hydrate ? _toolBody(t) : '') + '</div></div>';
  }

  function _render() {
    const el = ctx._mount();
    if (!el) return;
    global.ChatCloudHandoff?.sync(el, ctx._snap);
    global.AccessControls?.sync(el, ctx._ref, ctx._snap, ctx.esc, button =>
      ctx._answerUi('permission', button.dataset.uiValue, button));
    const turnState = (ctx._snap?.execution || {}).turnQueue || {};
    (turnState.tasks || []).forEach(row => {
      const entry = ctx._collabTasks.get(String(row.taskId));
      if (entry) {
        const previous = entry.queueState;
        entry.nativeTurn = true; entry.queueState = row.status;
        if (previous !== row.status) ctx._setCollabEntryStatus(entry, row.status, row.status === 'completed' ? 'complete' : 'execute');
        else if (entry.controller) entry.controller.update({ status: row.status, phase: row.status === 'completed' ? 'complete' : 'execute' });
      }
    });
    ((ctx._snap?.execution || {}).taskExecutions || []).forEach(value => {
      const entry = ctx._collabTasks.get(String(value.taskId));
      if (!entry) return;
      entry.controlledTurn = true; entry.controlledExecution = value;
      const receipt = (turnState.tasks || []).find(row => row.taskId === value.taskId);
      entry.queueState = receipt && /^(completed|failed|stopped|cancelled)$/.test(receipt.status) ? receipt.status : value.status;
      if (entry.controller) entry.controller.setExecution(value.run || value, value.runId);
    });
    // Picker actions are independent of transcript changes. The streaming fast
    // path (and an empty conversation) must still paint open/load/close updates.
    if (ctx._collabView) ctx._collabView.render(ctx._collabState());
    if (!ctx._snap) return;
    const scroll = el.querySelector('#nchatScroll');
    const list = el.querySelector('#nchatList');
    acceptance.bind(list);
    const scrollState = _ensureScrollFollow(el);
    /* Follow streaming output until the user scrolls upward; preserve their reading position afterward. */
    const stick = scrollState ? scrollState.follow : _nearBottom(scroll);

    const parts = [];
    const allMessages = Array.isArray(ctx._snap.messages) ? ctx._snap.messages : [];
    // Keep the reader's older page mounted while new messages arrive below it.
    // Never shrink an explicitly widened window; cap automatic growth only.
    if (lastList === list && !stick && allMessages.length > lastMessageCount) {
      ctx._messageWindowSize = growMessageWindow(ctx._messageWindowSize, allMessages.length - lastMessageCount);
    }
    lastList = list; lastMessageCount = allMessages.length;
    const windowSize = Math.max(80, Number(ctx._messageWindowSize) || 80);
    const messageStart = Math.max(0, allMessages.length - windowSize);
    const visibleMessages = allMessages.slice(messageStart).map((message, offset) => ({
      message, index: messageStart + offset,
    }));
    const workCards = ctx._workCards?.timeline?.(allMessages, messageStart) || [];
    const approvalCards = acceptance.timeline(ctx._collabEntries(), allMessages, messageStart);
    const nextApprovalMarkup = JSON.stringify(approvalCards);
    if (nextApprovalMarkup !== approvalMarkup) liveStreamShape = null;
    approvalMarkup = nextApprovalMarkup;
    const appendApprovals = index => {
      for (const card of approvalCards) if (card.index === index) {
        if (taskStreams.has(card.taskId) && !taskAnchors.has(card.taskId)) {
          parts.push(taskStreams.get(card.taskId)); taskStreams.delete(card.taskId);
        }
        if (legacyStreams.has(card.taskId)) {
          parts.push(legacyStreams.get(card.taskId)); legacyStreams.delete(card.taskId);
        }
        parts.push(card.html);
      }
    };
    const appendWorkCards = index => {
      for (const card of workCards) if (card.index === index) parts.push(
        '<section data-chat-node="work-card:' + ctx.esc(card.id) + '" data-work-card-slot="' + ctx.esc(card.id) + '"></section>');
      if (index < allMessages.length) appendApprovals(index);
    };
    if (ctx._pending && _pendingIsConfirmed(allMessages)) {
      ctx._pending = ''; ctx._pendingPlugins = []; ctx._pendingBaseline = null;
    }
    const allTools = global.ChatTools?.displayTools?.(ctx._snap) || ctx._snap.tools || [];
    ctx._liveTextKey = '';
    if (ctx._snap.status === 'streaming' && !ctx._pending) {
      const index = allMessages.length - 1;
      const message = allMessages[index];
      const blocks = Array.isArray(message?.blocks) ? message.blocks : [];
      const blockIndex = blocks.length - 1;
      if (message?.role === 'assistant' && message.done !== true &&
          blocks[blockIndex]?.kind === 'text' && blocks[blockIndex].done !== true) {
        ctx._liveTextKey = index + ':' + blockIndex;
      }
    }
    const toolStart = Math.max(0, allTools.length - windowSize * 2);
    const visibleTools = allTools.filter((tool, index) => index >= toolStart || tool.state === 'running');
    ctx._renderQueue(el);
    // One index per frame, rather than rescanning the transcript DOM for every
    // work card. Missing slots still force the full structural renderer.
    const mountedCardIds = workCards.length
      ? new Set([...list.children].map(node => node.dataset.workCardSlot)) : null;
    if (!mountedCardIds || workCards.every(card => mountedCardIds.has(card.id))) {
      if (_patchLiveStream(list, ctx._snap, allMessages, allTools)) {
        global.ChatMedia?.hydrate(list);
        global.PluginDebugCard?.reconcile?.({ ref: ctx._ref, snapshot: ctx._snap, list });
        _renderContextMeta(el);
        if (scrollState && scrollState.follow) _followLatest(scrollState, false);
        else _updateScrollButton(scrollState);
        return;
      }
    }
    streamMarkup = new WeakMap(); // The full renderer may replace cached node contents.
    const history = ctx._snap.history || {};
    if (messageStart > 0 || toolStart > 0 || history.truncated) {
      const olderCount = Number(history.messageStart || messageStart || 0);
      const hint = olderCount > 0 ? olderCount + ' 条更早消息' : '更多历史记录';
      parts.push('<div data-chat-node="history-older" class="nchat-history-older">' +
        '<button type="button" data-load-older>加载更早记录（' + hint + '）</button></div>');
    }
    const goalMode = ctx._sessionOptions.intent === 'goal' || ctx._sessionOptions.mode === 'goal';
    const snapshotTools = (ctx._snap && ctx._snap.tools) || [];
    _syncComputerGlow(snapshotTools.some((tool) => tool && tool.state === 'running' && _computerTool(tool)));
    const seenTools = [];
    const st = ctx._snap.status;
    const quality = ((ctx._snap.execution || {}).quality) || {};
    const harness = ((ctx._snap.execution || {}).harness) || {};
    const qualityBusy = ['executing', 'implementing', 'reviewing', 'repairing'].includes(quality.phase);
    const execution = ctx._snap.execution || {};
    const busy = global.ChatStatus && typeof global.ChatStatus.runtimeBusy === 'function'
      ? global.ChatStatus.runtimeBusy(ctx._snap, ctx._pending, ctx._pendingSentAt)
      : st === 'streaming' || Boolean(execution.running) || !!ctx._pending || qualityBusy;
    ctx._syncThinkingClock(busy);
    const paused = Boolean(execution.limitRequest);
    const budgetStopped = Boolean(execution.stopped && !paused);
    // Length truncation resumes within the same send; suppress premature error banners while execution is still active.
    const quotaBlocked = Boolean(global.SoduWorkQuota?.detail(ctx._snap));
    const outputIncomplete = st === 'incomplete' && !execution.running && !quotaBlocked;
    const failed = !quotaBlocked && (st === 'unreachable' || st === 'no-output' || outputIncomplete ||
      budgetStopped || quality.phase === 'blocked');
    const finalReplies = _finalReplyIndexes(allMessages, allTools, !ctx._pending && !execution.running && !qualityBusy && !paused && !failed &&
      !ctx._snap.pendingUi && (!st || st === 'idle'));
    // Before the new user message is echoed, the previous completed answer
    // still belongs to history, even though the optimistic turn is busy.
    const nextOutputScope = JSON.stringify([ctx._ref, global.SoduWorkAPI?.taskStorageKey?.('ops') || '']);
    if (ctx._pending && outputScope === nextOutputScope) {
      list.querySelectorAll('[data-delivery-final="true"][data-chat-node]').forEach(node => {
        const match = /^message:(\d+)$/.exec(node.dataset.chatNode || '');
        if (match && allMessages[Number(match[1])]?.role === 'assistant' &&
            node.dataset.messageOwner === _messageOwner(Number(match[1]))) finalReplies.add(Number(match[1]));
      });
    }
    const summaryTurns = turnSummary?.prepare(ctx._snap, finalReplies) || new Map();
    const shownSummaries = new Set();
    const appendSummary = index => {
      const turn = summaryTurns.get(index);
      if (!turn || shownSummaries.has(turn.key)) return;
      shownSummaries.add(turn.key);
      // Reopening a saved session resets its runtime clock. In that case the
      // latest saved reply is historical too and must use persisted timing.
      const latest = !ctx._pending && turn.to === allMessages.length - 1 &&
        Number.isFinite(execution.elapsedMs) && execution.elapsedMs > 0;
      parts.push(turnSummary.html(turn, latest ? ctx._turnMetricsHtml?.(false) : ''));
    };
    const elapsedMinutes = Math.max(0, Math.floor(Number(execution.elapsedMs || 0) / 60000));
    const goalDetail = execution.active
      ? ('已运行 ' + elapsedMinutes + ' 分钟 · ' + Number(execution.step || 0) + ' 项操作')
      : '';
    const scoreDetail = harness.score && Number.isFinite(Number(harness.score.total))
      ? ('质量 ' + Number(harness.score.total) + '/' +
        Number(harness.score.threshold || harness.qualityThreshold || 85)) : '';
    const latest = allMessages.findLast((message) => message.role === 'user' || message.role === 'assistant');
    const answered = latest && latest.role === 'assistant' && (latest.blocks || [])
      .some((block) => block.kind === 'text' && String(block.text || '').trim());
    const goalReady = !busy && !paused && !failed && answered &&
      (!quality.required || quality.phase === 'reviewed');
    const progressRows = ChatTools.goalProgressRows(goalMode, harness, quality, goalReady);
    const progressState = { index: 0 };
    let firstUser = !allMessages.slice(0, messageStart).some(m => m.role === 'user');
    const keyed = (html, key, index) => String(html).replace('<div class="nmsg',
      '<div data-chat-node="' + ctx.esc(key) + '"' + (index === undefined ? '' : ' data-message-owner="' + _messageOwner(index) + '"') + ' class="nmsg');
    const userHtml = (text, attachments, plugins, key, sentAt, message, index) => {
      const goal = firstUser && (ctx._sessionOptions.intent === 'goal' || ctx._sessionOptions.mode === 'goal')
        ? ctx._sessionOptions : {};
      firstUser = false;
      const footer = _messageFooter({ role: 'user', sentAt }, text);
      const files = global.ConversationAttachments ? ConversationAttachments.messageHtml(attachments) : '';
      const badges = pluginBadges?.html(plugins) || (plugins || []).map(item => '<span class="nmessage-plugin"><span class="nmessage-plugin-label">' + ctx.esc(item.name || item.key || 'Plugin') + '</span></span>').join('');
      const tail = (badges ? '<div class="nmessage-plugins">' + badges + '</div>' : '') + files + footer + _workflowSlot(message);
      const html = global.WorkIntent && typeof WorkIntent.userMessage === 'function'
        ? WorkIntent.userMessage(text, goal, tail)
        : '<div class="nmsg user"><div class="nbubble"><span data-user-content>' + ctx.esc(text) + '</span>' +
          '</div>' + tail + '</div>';
      return keyed(html, key, index);
    };

    const taskAnchors = new Map(), taskStreams = new Map(), legacyStreams = new Map();
    allMessages.forEach((m, mi) => {
      if (m.role !== 'user') return;
      if (m.taskId) taskAnchors.set(m.taskId, mi);
      else {
        const matching = ctx._collabEntries().filter(entry => entry.controlledTurn &&
          ['需求：', '任务：'].some(prefix => String(m.text || '').startsWith(prefix + entry.task.title + '\n')));
        if (matching.length === 1) taskAnchors.set(matching[0].taskId, mi);
      }
    });
    const anchoredTaskByMessage = new Map(Array.from(taskAnchors, ([id, mi]) => [mi, id]));
    if (global.TaskExecutionStream) ctx._collabEntries().filter(entry => entry.controlledTurn).forEach(entry => {
      // New executions are already ordinary messages/tools. Only old archives
      // need the legacy detail-stream projection (otherwise every reply doubles).
      if ((entry.controlledExecution || {}).sameMessageStream ||
        allMessages.some(m => m.taskId === entry.taskId && m.taskOutputKey)) return;
      const active = (entry.controlledExecution || {}).run || {};
      const sessions = active.items ? [active] :
        (entry.transcripts ? [...entry.transcripts.values()] : []);
      taskStreams.set(entry.taskId, sessions.filter(run => run.items && run.items.length).map(run =>
        '<div data-chat-node="task-stream:' + ctx.esc(entry.taskId + ':' + (run.ref || run.id)) +
        '" data-task-stream="' + ctx.esc(entry.taskId) + '" data-task-run="' + ctx.esc(run.ref || run.id || '') + '" data-delivery-final="' + ['completed', 'done', 'idle'].includes(run.status || run.state) + '">' + TaskExecutionStream.rowsHtml(run.items, run.status) + '</div>').join(''));
    });
    // Legacy archives without native message anchors follow their first approval slot.
    if (global.TaskExecutionStream) ctx._collabEntries().forEach(entry => {
      if (entry.executionElsewhere || entry.controlledTurn || entry.nativeTurn ||
          allMessages.some(message => message.taskId === entry.taskId && message.taskOutputKey)) return;
      const state = entry.controller?.snapshot();
      if (!state?.events?.length) return;
      legacyStreams.set(entry.taskId, '<div data-chat-node="task-stream:' + ctx.esc(entry.taskId) +
        '" data-task-stream="' + ctx.esc(entry.taskId) + '" data-delivery-final="' + ['completed', 'done', 'idle'].includes(state.status) + '">' +
        TaskExecutionStream.rowsHtml(state.events, state.status) + '</div>');
    });
    // Keep contiguous commands grouped without losing their source Agent.
    const renderTools = ChatTools.groupConsecutiveCommands
      ? ChatTools.groupConsecutiveCommands(visibleTools, allMessages) : visibleTools;
    const toolsByMessage = new Map();
    renderTools.forEach((tool) => {
      const after = Math.max(0, Number(tool && tool.after) || 0);
      const rows = toolsByMessage.get(after) || [];
      rows.push(tool); toolsByMessage.set(after, rows);
    });
    const latestUser = allMessages.findLastIndex(message => message.role === 'user');
    const turnMetrics = () => ctx._turnMetricsHtml?.(busy) || '';
    /* A freshly sent goal can be acknowledged by a tool event before the
       native snapshot persists its user message.  Render the optimistic
       bubble first so an early progress row cannot appear above the prompt. */
    let pendingRendered = false;
    const appendPending = () => {
      if (!ctx._pending || pendingRendered) return;
      parts.push(userHtml(ctx._pending, ctx._pendingAttachmentNames, ctx._pendingPlugins,
        'message:pending', ctx._pendingSentAt));
      parts.push(turnMetrics());
      pendingRendered = true;
    };
    if (!allMessages.length) appendWorkCards(0);
    if (ctx._pending && allMessages.length === 0 && !approvalCards.length) appendPending();
    // One identity stack per user turn, including tool-only participants.
    const crewOf = global.ChatCrew || null;
    const turnCrews = crewOf?.turnsOf(allMessages, allTools, st === 'streaming');
    const agents = global.AgentBrand?.transcript({
      turnScoped: true,
      crewHtml: (source, anchor) => {
        if (!crewOf || !turnCrews) return null;
        const mi = /^message:(\d+)(?::|$)/.exec(String(anchor || ''));
        const turn = (mi && turnCrews.byMessage[Number(mi[1])]) || turnCrews.tail;
        const stack = crewOf.stackHtml(source, null, turn);
        if (!stack.html) return null;
        // Preserve the primary run's detail link, or the sole task run when an
        // ordinary preface led the turn. Never invent ownership from the selected agent.
        stack.runId = turn.runs.has(source.runId) ? source.runId
          : turn.runs.size === 1 ? turn.runs.keys().next().value : '';
        stack.taskId = String(turn.runs.get(stack.runId) || '');
        return stack;
      },
    });
    const pluginsByReply = new Map();
    let turnPlugins = [];
    allMessages.forEach((message, index) => {
      if (message.role === 'user') turnPlugins = message.plugins || [];
      else pluginsByReply.set(index, turnPlugins);
    });
    // A still-running tool from an older, windowed-out turn remains visible,
    // but must not acquire the newest turn's identity just because it is retained.
    const turnAt = index => turnCrews?.byMessage[index] ||
      allMessages.findLastIndex((message, at) => at <= index && message.role === 'user');
    const priorTools = renderTools.filter(tool => tool.state === 'running' &&
      (tool.after || 0) < messageStart && turnAt(tool.after || 0) !== turnAt(messageStart))
      .sort((a, b) => (a.after || 0) - (b.after || 0));
    for (let start = 0; start < priorTools.length;) {
      const tool = priorTools[start], turn = turnAt(tool.after || 0);
      let end = start + 1;
      while (end < priorTools.length && turnAt(priorTools[end].after || 0) === turn) end++;
      agents?.breakRun();
      (agents ? agents.appendTools.bind(null, ChatTools.appendTimeline) : ChatTools.appendTimeline)(parts,
        priorTools.slice(start, end), seenTools, 'message:' + (tool.after || 0), goalMode, _toolHtml, ctx._openToolGroup, progressRows, progressState);
      start = end;
    }
    if (priorTools.length) agents?.breakRun();
    if (!ctx._pending && latestUser < messageStart && latestUser >= 0 && !summaryTurns.has(messageStart)) parts.push(turnMetrics());
    visibleMessages.forEach(({ message: m, index: mi }) => {
      appendWorkCards(mi);
      if (m.role === 'user') {
        agents?.breakRun?.();   // turn boundary: next turn's same-run messages repaint the crew head; tool-group dedup resets too
        agents?.before(parts, null, 'message:' + mi);
        parts.push(userHtml(m.text, m.attachments, m.plugins, 'message:' + mi, m.sentAt, m, mi));
        appendSummary(mi);
        if (!ctx._pending && mi === latestUser && !summaryTurns.has(mi)) parts.push(turnMetrics());
      } else {
        appendSummary(mi);
        const inner = (m.blocks || []).map((b, blockIndex) => _blockHtml(mi, b, blockIndex)).join('');
        const lastTool = summaryTurns.get(mi)?.lastToolBlock ?? -1;
        const reply = (m.blocks || []).filter((block, index) => block.kind === 'text' &&
          (!finalReplies.has(mi) || index > lastTool)).map(block => block.text || '').join('\n\n');
        const footer = finalReplies.has(mi) && reply.trim() ? _messageFooter(m, reply, lastTool, _messageOwner(mi)) : '';
        if (inner) agents?.before(parts, m.sourceAgent, 'message:' + mi, true);
        if (inner) parts.push('<div class="nmsg ai" data-streaming="' + (st === 'streaming' && ctx._liveTextKey.startsWith(mi + ':')) + '" data-delivery-final="' + finalReplies.has(mi) + '" data-delivery-current="' + (mi > latestUser && !ctx._pending) + '" data-output-task="' + ctx.esc(m.taskId || '') + '" data-message-owner="' + _messageOwner(mi) + '" data-chat-node="message:' + mi + '">' + inner + footer + _workflowSlot(m) + '</div>');
      }
      /* Tools may anchor to the previous visible user after internal review messages are hidden; preserve their chronological placement. */
      const mine = toolsByMessage.get(mi) || [];
      (agents ? agents.appendTools.bind(null, ChatTools.appendTimeline) : ChatTools.appendTimeline)(parts, mine, seenTools, 'message:' + mi, goalMode, _toolHtml, ctx._openToolGroup,
        progressRows, progressState);
      const taskAtMessage = anchoredTaskByMessage.get(mi);
      if (taskAtMessage && taskStreams.has(taskAtMessage)) {
        parts.push(taskStreams.get(taskAtMessage)); taskStreams.delete(taskAtMessage);
      }
      if (m.role === 'assistant' && finalReplies.has(mi)) {
        const cards = pluginBadges?.cards(pluginsByReply.get(mi)) || '';
        if (cards) parts.push('<div class="nmessage-app-cards" data-chat-node="application:' + mi + '">' + cards + '</div>');
      }
    });
    /* Append tools whose after index exceeds the current message count; events may arrive before messages. */
    if (allMessages.length) appendWorkCards(allMessages.length);
    const tail = renderTools.filter((t) => !priorTools.includes(t) && ((t.after || 0) >= allMessages.length ||
      (t.state === 'running' && (t.after || 0) < messageStart)));
    (agents ? agents.appendTools.bind(null, ChatTools.appendTimeline) : ChatTools.appendTimeline)(parts, tail, seenTools, 'tail', goalMode, _toolHtml, ctx._openToolGroup,
      progressRows, progressState);
    ChatTools.appendGoalProgress(parts, progressRows, progressState, Infinity);

    // Task runs use the existing task/chat renderer and the same message list.
    // Commands retain only their status; each task has its own stable transcript key.
    if (global.TaskExecutionStream) ctx._collabEntries().forEach(entry => {
      if (entry.executionElsewhere) return;
      if (entry.controlledTurn) {
        if (taskAnchors.has(entry.taskId) && taskAnchors.get(entry.taskId) < messageStart) return;
        if (taskStreams.has(entry.taskId)) {
          parts.push(taskStreams.get(entry.taskId)); taskStreams.delete(entry.taskId);
        }
        return;
      }
      if (legacyStreams.has(entry.taskId)) {
        parts.push(legacyStreams.get(entry.taskId)); legacyStreams.delete(entry.taskId);
      }
    });

    // The final slot follows tools and legacy execution projections as well as ordinary replies.
    appendApprovals(allMessages.length);
    ctx._collabEntries().forEach(entry => {
      if (entry.executionElsewhere || !global.TaskTraceApproval || !entry.trace) return;
      const run = (entry.controlledExecution || {}).run || {};
      const failed = entry.controlledTurn && run.state === 'failed';
      if (!failed) return;
      parts.push('<div class="nchat-task-confirmation" data-chat-node="task-confirmation:' + ctx.esc(entry.taskId) +
        '" data-task-confirmation="' + ctx.esc(entry.taskId) + '">' +
        (failed ? '<section class="tfd-inline-approval is-bad"><header><b>这一步没有完成</b></header>' +
          '<p>后续需求继续等待。检查失败原因后，可以重试当前步骤。</p><div class="tfd-inline-actions">' +
          '<button type="button" data-chat-workflow-retry="' + ctx.esc(entry.taskId) + '">重试本步骤</button>' +
          '<button type="button" data-task-receipt="' + ctx.esc(entry.taskId) + '">查看详情</button></div></section>' : '') + '</div>');
    });
    const runtimeNotices = (Array.isArray(ctx._snap.notices) ? ctx._snap.notices : [])
      .filter((item) => item && String(item.message || '').trim());
    const latestNotice = runtimeNotices[runtimeNotices.length - 1];
    if (latestNotice) {
      const noticeLevel = /error|danger/i.test(String(latestNotice.level || '')) ? 'error'
        : /warn/i.test(String(latestNotice.level || '')) ? 'warning' : 'info';
      parts.push('<div data-chat-node="runtime-notice" class="nruntime-notice is-' +
        noticeLevel + '" aria-live="polite"><span aria-hidden="true"></span><p>' +
        ctx.esc(String(latestNotice.message || '').slice(0, 360)) + '</p></div>');
    }

    /* Remove the optimistic copy when the main process echoes the message. */
    if (ctx._pending && _pendingIsConfirmed(allMessages)) {
      ctx._pending = '';
      ctx._pendingPlugins = []; ctx._pendingBaseline = null;
    }
    if (!ctx._pending && ctx._pendingAttachmentNames.length) {
      ctx._pendingAttachmentNames = [];
    }
    if (ctx._pending && !pendingRendered) {
      appendPending();
    } else if (latestUser < 0 && allMessages.length && !summaryTurns.has(allMessages.length - 1)) parts.splice(parts[0]?.includes('nchat-agent-source') ? 1 : 0, 0, turnMetrics());

    if (global.WorkIntent) WorkIntent.showGoal(el, ctx._sessionOptions, 'nchat', {
      busy, paused, failed, ready: goalReady,
      phases: harness.phases, phase: harness.phase,
      canContinue: execution.canContinue === true || (paused &&
        (!execution.limitRequest || execution.limitRequest.canContinue !== false)),
      actionPending: Boolean(ctx._goalActionPending),
      detail: paused ? execution.limitRequest.reason
        : budgetStopped ? execution.reason
          : (quality.phase === 'reviewed' && scoreDetail ? scoreDetail : (quality.reason || ctx._snap.statusText || goalDetail)),
      onPause: () => ctx._goalAction('stop'),
      onResume: () => ctx._goalAction('continue'),
      onClear: ctx._removeGoal,
    });
    parts.push(ctx._thinkingStatusHtml(busy));
    /*
     * Display both unreachable errors and runs producing no output, including invalid or
     * unauthorized models rejected upstream without retries.
     */
    const pluginAuthorizationBlocked = Boolean(ctx._pluginAuthorization &&
      ['missing', 'readOnlyConflicts', 'unsupported'].some(key =>
        Array.isArray(ctx._pluginAuthorization[key]) && ctx._pluginAuthorization[key].length));
    const missingCapabilityLabels = { browser: '浏览网页', office: 'Office 文档', computer: '操作电脑' };
    const pluginStatus = ctx._pluginAuthorization?.missing?.length
      ? '当前会话没有授权：' + ctx._pluginAuthorization.missing
        .map(id => missingCapabilityLabels[id] || id).join('、') +
        '。请新建会话并开启对应能力后再使用这个插件' : '';
    const sessionOpenFailure = !ctx._ref && Boolean(ctx._sessionId) &&
      Boolean(ctx._snap?.openBlocked || ctx._snap?.sessionOpenCode || ctx._snap?.sessionNotFound);
    const runtimeNotice = budgetStopped ? execution.reason : (pluginStatus || ctx._snap.statusText || '');
    parts.push('<div data-chat-node="runtime-error" class="nbad' +
      (!quotaBlocked && (st === 'unreachable' || st === 'no-output' || outputIncomplete || budgetStopped) ? ' show' : '') + '">' +
      '<span class="nbad-copy" translate="no" data-runtime-notice="' + ctx.esc(runtimeNotice || '') + '">' +
      ctx.esc((global.ChatStatus?.notice || uiText)(runtimeNotice)) + '</span>' +
      (sessionOpenFailure ?
        '<button type="button" data-session-retry>' + uiText('重新打开会话') + '</button>' :
       execution.modelRecovery && execution.modelRecovery.available && ctx._ref ?
        '<button type="button" data-model-retry="' + ctx.esc(execution.modelRecovery.id) + '">' + uiText('恢复这一轮') + '</button>' :
        ctx._retryDraft && ctx._pluginAuthorization?.missing?.length
          ? '<button type="button" data-plugin-new-session>' + uiText('新建会话并继续') + '</button>'
          : ctx._retryDraft && !pluginAuthorizationBlocked
            ? '<button type="button" data-plugin-retry>' + uiText('恢复这一轮') + '</button>' : '') + '</div>');
    if (!busy && failed) {
      const selected = ctx._retryDraft?.plugins?.length ? ctx._retryDraft.plugins :
        allMessages[latestUser]?.plugins?.length ? allMessages[latestUser].plugins : ctx._snap.activePlugins || [];
      const cards = pluginBadges?.cards(selected) || '';
      if (cards) parts.push('<div class="nmessage-app-cards" data-chat-node="application:failed">' + cards + '</div>');
    }
    parts.push(String(_uiHtml(ctx._snap.pendingUi, st)).replace('<div class="nask-ui',
      '<div data-chat-node="runtime-ui" class="nask-ui'));
    /* Append outputs whose after index exceeds the message count rather than dropping early events. */

    const expandedTaskTools = Array.from(list.querySelectorAll(
      '[data-task-stream] .ntool.open[data-dks-node], [data-task-stream] .nthink[data-dks-user-open]'))
      .map(node => [node.closest('[data-task-stream]').dataset.taskStream, node.dataset.dksNode,
        node.classList.contains('open'), node.classList.contains('is-live')]);
    parts.splice(parts[0]?.includes('nchat-history-older') ? 1 : 0, 0,
      '<div class="nworkflow-history-slot" data-chat-node="workflow-history" data-workflow-ref="' + ctx.esc(ctx._ref) + '"></div>');
    const rawMessageHtml = parts.join('');
    /* Structural stream updates retain preceding final cards. Token-only
       updates still use _patchLiveStream above; current files are decorated
       only after the whole turn has settled. */
    const deliverySnapshot = { ...ctx._snap, deliveryPending: Boolean(ctx._pending || ctx._snap?.deliveryPending) };
    const settledNow = !global.ChatDeliveries || global.ChatDeliveries.isSettled(deliverySnapshot);
    const restoreReading = _preserveReadingPosition(scroll, list);
    const finishThinkingFold = global.ChatThinkingCollapse?.capture(list, scroll, String(ctx._ref || '') + '|' + nextOutputScope);
    const carriedCards = !settledNow && outputScope === nextOutputScope && global.ChatDecorateCarry ? ChatDecorateCarry.capture(list) : null;
    const messageHtml = global.ChatOutputLinks && (ctx._snap.status !== 'streaming' || global.ChatDeliveries)
      ? ChatOutputLinks.decorate(rawMessageHtml, ctx._outs, ctx._ref, deliverySnapshot, outputScope === nextOutputScope ? list : null) : rawMessageHtml;
    outputScope = nextOutputScope;
    if (global.ChatTools && ChatTools.patchList) ChatTools.patchList(list, messageHtml, { preserveDeco: Boolean(carriedCards) });
    else list.innerHTML = messageHtml;
    ctx._workCards?.paint?.();
    if (carriedCards && global.ChatDecorateCarry) ChatDecorateCarry.reconcile(list, ctx._outs, carriedCards, deliverySnapshot);
    finishThinkingFold?.();
    turnSummary?.apply(list);
    restoreReading();
    list.querySelectorAll('.nmsg.ai[data-chat-node]').forEach(node => {
      const live = st === 'streaming' && node.dataset.chatNode === 'message:' + ctx._liveTextKey.split(':')[0];
      if (node.dataset.streaming !== String(live)) node.dataset.streaming = String(live);
    });
    list.querySelectorAll('.nthink.is-live .nthink-body').forEach(body => {
      if (!body.dataset.scrollReady) { body.dataset.scrollReady = 'true'; body.scrollTop = body.scrollHeight; }
    });
    list.querySelectorAll('[data-task-confirmation]').forEach(root => {
      const id = root.getAttribute('data-task-confirmation'), entry = ctx._collabTasks.get(id);
      if (!entry || !global.TaskTraceApproval) return;
      acceptance.bindApproval(root, id, entry);
      if (root.dataset.chatBound) return;
      root.dataset.chatBound = '1';
      root.addEventListener('click', async event => {
        const details = event.target.closest('[data-tfd-action="approval"]');
        if (details) { ctx._queueAction('detail', '', id); return; }
        const retry = event.target.closest('[data-chat-workflow-retry]');
        if (!retry || retry.disabled) return;
        retry.disabled = true;
        try {
          const live = ctx._collabTasks.get(id), execution = live && live.controlledExecution || {};
          const nodes = (execution.run || {}).nodes || [];
          const node = nodes.find(x => x.canRetry || x.can_retry);
          await SoduWorkAPI.retryTaskPluginGate(execution.runId, node && (node.key || node.nodeKey));
          await ctx._loadCollabTask(id);
        } catch (error) { if (typeof petSay === 'function') petSay(String(error.message || error)); }
        finally { retry.disabled = false; }
      });
    });
    expandedTaskTools.forEach(([taskId, key, open, wasLive]) => {
      const stream = Array.from(list.querySelectorAll('[data-task-stream]')).find(node => node.dataset.taskStream === taskId);
      const card = stream && Array.from(stream.querySelectorAll('[data-dks-node]')).find(node => node.dataset.dksNode === key);
      if (card && (!wasLive || card.classList.contains('is-live'))) {
        card.classList.toggle('open', open);
        if (card.classList.contains('nthink')) card.dataset.dksUserOpen = String(open);
        const toggle = card.querySelector('[data-dks-tool]');
        if (toggle) toggle.setAttribute('aria-expanded', String(open));
        if (open && toggle) global.TaskExecutionStream?.hydrateTool(toggle, ctx._collabEntries());
      }
    });
    if (global.ConversationAttachments && typeof ConversationAttachments.hydrateMessageImages === 'function') {
      ConversationAttachments.hydrateMessageImages(list, { ref: ctx._ref, api: ctx._api() });
    }
    global.ChatMedia?.hydrate(list);
    if (global.ChatOutputLinks) {
      ChatOutputLinks.hydrateImages(list, ctx._outs || [], { ref: ctx._ref, api: ctx._api() });
      ChatOutputLinks.hydrateVideos(list, ctx._outs || [], { ref: ctx._ref, api: ctx._api() });
    }
    global.ChatDeliveries?.hydrate(list, { ref: ctx._ref, api: ctx._api(), snapshot: ctx._snap });
    if (global.ChatTools && typeof ChatTools.linkifyOutputs === 'function') {
      ChatTools.linkifyOutputs(list, ctx._outs, String(ctx._ref || '') + '\u0000' + (ctx._outAt || ''));
    }
    global.PluginDebugCard?.reconcile?.({ ref: ctx._ref, snapshot: ctx._snap, list });
    ctx._renderTaskStartPrompt();
    ctx._syncSlowStatusTicker(busy && execution.stalled);
    if (global.ChatWorkbench) ChatWorkbench.render(el, ctx._snap, ctx._outs);
    if (stick && scrollState) _followLatest(scrollState, false);
    else _updateScrollButton(scrollState);

    ChatTools.paintSendButton(el, busy, ctx._messageAttachments, ctx._stopState,
      st === 'streaming' || execution.running === true || qualityBusy, ctx._sendState);

    if (ctx._snap.modelSelection) ctx._model = ctx._snap.modelSelection.activeModel;
    if (ctx._composerControls) ctx._composerControls.render();
    _renderContextMeta(el);
    liveStreamShape = ctx._snap.status === 'streaming'
      ? _streamStructure(ctx._snap, allMessages, allTools) : null;
  }

  // Usage counters change on provider deltas; update their small view without
  // rebuilding every historical message/tool or disturbing text selection.
  function _renderContextMeta(el) {
    const meta = el.querySelector('#nchatMeta');
    if (meta) {
      const html = _ctxHtml();
      if (meta._contextMarkup !== html) {
        if (meta.firstElementChild && global.ChatTools && ChatTools.patchContent) {
          const next = meta.cloneNode(false); next.innerHTML = html;
          ChatTools.patchContent(meta, next);
        } else meta.innerHTML = html;
        meta._contextMarkup = html;
      }
      if (ctx._composerControls && ctx._composerControls.positionContext) ctx._composerControls.positionContext();
    }

  }

  function _uiHtml(req, st) {
    if (!req || st !== 'waiting-user') return '<div class="nask-ui"></div>';
    if (req.method === 'permission') return ''; // Permission requests live above the composer.
    const title = ctx.esc(req.title || '需要你确认一下');
    const msg = ctx.esc(req.message || '');
    let btns = '';
    if (req.method === 'confirm') {
      btns = '<button class="nask-btn primary" data-ui-answer="confirm" data-ui-value="yes">好</button>' +
             '<button class="nask-btn" data-ui-answer="confirm" data-ui-value="no">不要</button>';
    } else if (req.method === 'select') {
      btns = (req.options || []).map((o, i) =>
        '<button class="nask-btn' + (i === 0 ? ' primary' : '') + '" data-ui-answer="select" data-ui-value="' +
        ctx.esc(o) + '">' + ctx.esc(o) + '</button>').join('');
    } else {
      btns = '<button class="nask-btn" data-ui-answer="cancel">跳过</button>';
    }
    return '<div class="nask-ui show"><b>' + title + '</b>' + (msg ? '<i>' + msg + '</i>' : '') +
      '<div class="nask-btns">' + btns + '</div></div>';
  }
    return { reset, _messageFooter, _finalReplyIndexes, rich, _richPlain, CARET, _ensureHlCss, _inject, _blockHtml, _MCP_SAY, _friendlyTool, _toolHtml, _render, _ctxText, _tokenText, _ctxHtml, _uiHtml };
  }
  global.ChatMessageRenderer = { create, _growMessageWindow: growMessageWindow };
})(window);
