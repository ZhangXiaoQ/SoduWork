/* Generate visible execution-status wording from standard snapshots without scheduling sessions. */
(function (global) {
  'use strict';

  /*
   * Translate dynamic status fragments before concatenation because DOM lookup matches whole
   * phrases. zh-CN translation preserves the original text.
   */
  function tx(value) {
    const i18n = global.SoduWorkI18n;
    if (!i18n || typeof i18n.translateText !== 'function') return value;
    return i18n.translateText(value);
  }

  function notice(value) {
    const source = String(value || '');
    const locale = global.SoduWorkI18n?.getLocale?.() || 'zh-CN';
    if (locale === 'zh-CN') return source;
    // Localize system-owned status envelopes only; model replies and user names stay untouched.
    const wrapped = source.match(/^(这一轮没发出去|打不开对话|开不了对话|需求执行失败)（([\s\S]*)）$/);
    if (wrapped) return tx(wrapped[1] + '（{reason}）').replace('{reason}', () => notice(wrapped[2]));
    const patterns = [
      ['当前会话没有授权', '请新建会话并开启对应能力后再使用这个插件', true],
      ['当前会话是只读模式，插件还需要', '请改为可读写后重新开始会话', true],
      ['当前对话尚未接入插件依赖的连接器', '请在插件或连接器设置中完成连接并启用后重试', false],
      ['当前对话底座不支持插件声明的能力', '', true],
    ];
    const labels = new Set(['浏览网页', 'Office 文档', '操作电脑', '文件处理', '命令与构建', '代码仓库']);
    const parts = source.split(new RegExp('；(?=' + patterns.map(([prefix]) => prefix + '：').join('|') + ')'));
    const localized = parts.map(part => {
      for (const [prefix, suffix, capabilities] of patterns) {
        const begin = prefix + '：', end = suffix ? '。' + suffix : '';
        if (!part.startsWith(begin) || (end && !part.endsWith(end))) continue;
        const namesSource = part.slice(begin.length, end ? -end.length : undefined);
        const names = capabilities ? namesSource.split('、').map(label => labels.has(label) ? tx(label) : label).join(', ') : namesSource;
        return tx(begin + '{names}' + end).replace('{names}', () => names);
      }
      return tx(part);
    });
    return localized.every((part, index) => part === parts[index]) ? tx(source) : localized.join('; ');
  }

  global.addEventListener?.('soduwork-locale-change', () => {
    global.document?.querySelectorAll?.('[data-runtime-notice]').forEach(node => {
      node.textContent = notice(node.getAttribute('data-runtime-notice'));
    });
  });

  const LONG_WORK_COPY = [
    '正在核对这一轮的细节，已有工作会继续保留 · 可随时停止',
    '复杂步骤仍在执行，SoduWork 正在等待真实工具结果 · 可随时停止',
    '正在把文件、运行结果和交付说明收拢到一起 · 可随时停止',
    '这一轮还没有结束，形成可交付结果后会立即告诉你 · 可随时停止',
    '正在完成必要的检查，暂时不需要你反复操作 · 可随时停止',
    '任务仍在稳步推进，完成后会把结果和依据一起交付 · 可随时停止',
    '正在处理较耗时的步骤，当前现场与上下文都已保留 · 可随时停止',
    '正在复核关键结果，避免把未验证的内容交到你手里 · 可随时停止',
    '可以先喝口水，SoduWork 会继续守着这轮工作，有结果马上回来',
    '复杂工作值得多一点耐心，愿你今天接下来的事情都顺利从容',
    '正在把最后几处细节讲清楚，感谢你的耐心等待 · 可随时停止',
    '这一步需要一些时间，愿接下来的每一步都清晰、可靠、顺利',
  ];
  const TEAM_WORK_COPY = [
    '每一次高质量交付，都会成为团队下一次工作时可复用的经验',
    '让个人经验成为团队能力，让成熟的工作方法在企业中持续复用',
  ];

  function seed(ref) {
    let value = 0;
    for (const char of String(ref || 'soduwork')) value = (value * 31 + char.charCodeAt(0)) >>> 0;
    return value;
  }

  function longWork(ref, execution) {
    const elapsed = Math.max(90000, Number(execution && execution.elapsedMs) || 90000);
    const phase = Math.floor((elapsed - 90000) / 60000);
    return tx(LONG_WORK_COPY[(seed(ref) + phase) % LONG_WORK_COPY.length]);
  }

  function rotating(ref, now) {
    const phase = Math.floor(Number(now || Date.now()) / 14000);
    const stable = seed(ref);
    if ((stable + phase) % 17 === 0) {
      return tx(TEAM_WORK_COPY[(stable + phase) % TEAM_WORK_COPY.length]);
    }
    return tx(LONG_WORK_COPY[(stable + phase) % LONG_WORK_COPY.length]);
  }

  function work(snapshot, pending, ref) {
    const snap = snapshot || {};
    const execution = snap.execution || {};
    if (!pending && waiting(snap)) return notice(snap.statusText || execution.controlled?.reason || '等待输入');
    const harness = execution.harness || {};
    if (snap.modelRetry && snap.modelRetry.active) {
      const remaining = Math.ceil((Number(snap.modelRetry.retryAt) - Date.now()) / 1000);
      if (Number.isFinite(remaining) && remaining > 0) return tx('模型服务暂时异常，' + remaining +
        ' 秒后重连（' + snap.modelRetry.attempt + '/' + snap.modelRetry.max + '），已完成的工作会保留…');
      return tx('模型服务暂时异常，正在重连（' + snap.modelRetry.attempt + '/' + snap.modelRetry.max + '），已完成的工作会保留…');
    }
    if (execution.quality && execution.quality.phase === 'implementing') {
      return tx('计划已经形成，正在完成实现与运行验证…');
    }
    if (execution.quality && execution.quality.phase === 'repairing') {
      const focus = harness.focus && String(harness.focus.reason || '').trim();
      if (focus) return tx('正在定向修复：' + focus.slice(0, 58) + (focus.length > 58 ? '…' : ''));
      return tx('复核发现交付缺口，正在自动补齐并重新验证…');
    }
    if (execution.quality && execution.quality.phase === 'reviewing') {
      const score = harness.score;
      if (score && Number.isFinite(Number(score.total))) {
        return tx('正在独立复核，当前质量 ' + Number(score.total) + '/' +
          Number(score.threshold || harness.qualityThreshold || 85) + '…');
      }
      return tx('正在做交付复核，并补齐最后的缺口…');
    }
    if (execution.stalled) {
      const tools = global.ChatTools?.displayTools?.(snap) || snap.tools || [];
      const running = [...tools].reverse().find((tool) => tool.state === 'running');
      const view = running && global.ChatTools && global.ChatTools.render(running);
      const idleSeconds = Math.max(1, Math.round(Number(execution.idleMs || 0) / 1000));
      if (view) {
        return [tx(view.title), tx(view.sub)].filter(Boolean).join(' ') +
          tx('已有 ' + idleSeconds + ' 秒没有新进展；现场已保留，达到本类安全上限后会自动停止并换方案…');
      }
      return longWork(ref, execution);
    }
    if (execution.longRunning) {
      const tools = global.ChatTools?.displayTools?.(snap) || snap.tools || [];
      const running = [...tools].reverse().find((tool) => tool.state === 'running');
      const view = running && global.ChatTools && global.ChatTools.render(running);
      const elapsedSeconds = Math.max(1, Math.round(Number(
        execution.tool && execution.tool.elapsedMs || 0) / 1000));
      if (view) {
        return [tx(view.title), tx(view.sub)].filter(Boolean).join(' ') +
          tx('仍在运行（' + elapsedSeconds + ' 秒），进度会持续同步…');
      }
    }
    if (global.ChatTools && global.ChatTools.status) return global.ChatTools.status(snap, pending);
    const tools = global.ChatTools?.displayTools?.(snap) || snap.tools || [];
    const running = [...tools].reverse().find((tool) => tool.state === 'running');
    if (running) {
      const view = global.ChatTools && global.ChatTools.render(running);
      return view ? [tx(view.title), tx(view.sub)].filter(Boolean).join(' ') + '…' :
        tx('正在执行 ' + (running.name || '工具') + '…');
    }
    const answered = (snap.messages || []).some((message) => message.role === 'assistant');
    return answered ? tx('正在把结果讲清楚…') : tx('正在理解你的要求…');
  }

  function waiting(snapshot) {
    return snapshot?.status === 'waiting-user' || Boolean(snapshot?.pendingUi ||
      snapshot?.pendingPermissions?.length || snapshot?.execution?.waitingPermission);
  }

  function runtimeBusy(snapshot, pending, pendingSentAt) {
    const snap = snapshot || {};
    // An occupied queue is not evidence of model execution while it waits.
    if (!pending && waiting(snap)) return false;
    const execution = snap.execution || {};
    const quality = execution.quality || {};
    const queue = execution.turnQueue || {};
    const terminalAt = Number(execution.terminalAt || 0);
    const sentAt = Number(pendingSentAt || 0);
    const pendingAfterTerminal = Boolean(pending && terminalAt > 0 &&
      Number.isFinite(sentAt) && sentAt >= terminalAt);
    const queuedAfterTerminal = Number(execution.queued || 0) > 0;
    // The provider and evidence cleanup remain fenced internally, but the
    // completed stalled turn must stop its timer. A later user submission or
    // an accepted queued turn starts visible work again.
    if (execution.stopKind === 'agent-stall' &&
        !pendingAfterTerminal && !queuedAfterTerminal) return false;
    return Boolean(['streaming', 'queued'].includes(snap.status) || execution.running ||
      queue.activeQueueId || queue.activeTaskId || pending ||
      ['executing', 'implementing', 'reviewing', 'repairing'].includes(quality.phase));
  }

  function usageValue(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const read = keys => {
      for (const key of keys) {
        if (usage[key] == null || usage[key] === '') continue;
        const value = Number(usage[key]);
        if (Number.isFinite(value) && value >= 0) return value;
      }
      return null;
    };
    const input = read(['input', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']);
    const total = read(['total', 'totalTokens', 'total_tokens']);
    const output = read(['output', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']);
    const reasoning = read(['reasoning', 'reasoningTokens', 'reasoning_tokens', 'output_reasoning_tokens', 'thinking_tokens']);
    const details = usage.output_tokens_details || usage.outputTokensDetails || usage.completion_tokens_details || {};
    const nested = Number(details.reasoning_tokens ?? details.reasoningTokens ?? 0);
    // Provider details are a breakdown of output, never an additional charge.
    // SoduWork's flattened reasoning field may be separate; a reported total wins.
    if (output !== null) {
      if (reasoning === null) return Math.round(output);
      if (total !== null && input !== null) {
        const cache = Object.hasOwn(usage, 'input')
          ? (read(['cacheRead', 'cacheReadTokens']) || 0) + (read(['cacheWrite', 'cacheWriteTokens']) || 0) : 0;
        return Math.round(Math.max(output, total - input - cache));
      }
      return Math.round(output + reasoning);
    }
    if (total !== null && input !== null) return Math.max(0, Math.round(total - input));
    if (reasoning !== null) return Math.round(reasoning);
    return nested > 0 ? Math.round(nested) : null;
  }

  function estimateOutput(message) {
    return (message?.blocks || []).reduce((total, block) => {
      if (!block || !['thinking', 'text'].includes(block.kind)) return total;
      let cjk = 0, other = 0;
      for (const char of String(block.text || '')) {
        if (/[\u3400-\u9fff]/.test(char)) cjk++;
        else if (!/\s/.test(char)) other++;
      }
      return total + cjk + Math.ceil(other / 4);
    }, 0);
  }

  function createThinking(read) {
    let thinkingTimer = 0;
    let thinkingStartedAt = 0;
    let thinkingObservedElapsed = null;
    let thinkingRef = '';
    let thinkingTurnKey = '';
    let thinkingUseSubmitTime = false;
    let thinkingActive = false;
    let thinkingElapsedMs = 0;
    let slowStatusTimer = 0;
    let slowStatusSlot = -1;
    let estimateRef = "", feedbackAt = 0;
    const tokenEstimates = new Map();
    const promos = [
      '团队协作，让每次交付更稳',
      '把经验沉淀成可复用的能力',
    ];
    const state = () => (typeof read === 'function' ? read() : {}) || {};
    const escape = (value) => {
      const current = state();
      if (typeof current.esc === 'function') return current.esc(value);
      return String(value == null ? '' : value).replace(/&/g, '&amp;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };
    const tokenText = (value) => {
      const current = state();
      return typeof current.tokenText === 'function' ? current.tokenText(value) : String(Number(value || 0));
    };
    function turnMessages() {
      const current = state();
      if (current.pending) return [];
      const messages = (current.snap && current.snap.messages) || [];
      let lastUser = -1;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i] && messages[i].role === 'user') { lastUser = i; break; }
      }
      const identity = String(current.ref || current.sessionId || "") + ":" + lastUser;
      if (estimateRef !== identity) { estimateRef = identity; tokenEstimates.clear(); }
      return lastUser >= 0 ? messages.slice(lastUser + 1) : [];
    }
    function estimateTokens(value, key) {
      const text = String(value || '');
      if (!text) return 0;
      const previous = tokenEstimates.get(key);
      const append = previous && text.startsWith(previous.text);
      let cjk = append ? previous.cjk : 0, other = append ? previous.other : 0;
      for (const char of append ? text.slice(previous.text.length) : text) {
        if (/[\u3400-\u9fff]/.test(char)) cjk += 1;
        else if (!/\s/.test(char)) other += 1;
      }
      tokenEstimates.set(key, { text, cjk, other });
      while (tokenEstimates.size > 64) tokenEstimates.delete(tokenEstimates.keys().next().value);
      return cjk + Math.ceil(other / 4);
    }
    function estimateMessage(message, index) {
      return ((message && message.blocks) || []).reduce((sum, block, blockIndex) =>
        sum + (block && (block.kind === 'thinking' || block.kind === 'text')
          ? estimateTokens(block.text, index + ':' + blockIndex) : 0), 0);
    }
    function tokenInfo() {
      const current = state();
      const messages = turnMessages();
      const live = current.snap?.status === 'streaming' || runtimeActive(current);
      let value = 0, estimated = false, known = false;
      messages.filter(message => message && message.role === 'assistant').forEach((message, index) => {
        const actual = usageValue(message.usage);
        if (actual !== null && message.done === true) { value += actual; known = true; return; }
        const estimate = estimateMessage(message, index);
        // Initial SDK usage is often all zero while thinking deltas are arriving.
        // A partial/stale counter must not freeze the visible live estimate.
        if (actual === null || (live && message.done !== true && estimate > actual)) {
          value += estimate; estimated = estimated || estimate > 0; known = known || estimate > 0;
        } else { value += actual; known = true; }
      });
      // A fresh turn starts its display counter at zero until output arrives.
      // Missing usage after a finished segment remains unknown.
      const hasTurn = (current.snap?.messages || []).some(message => message?.role === 'user');
      const initial = Boolean(current.pending || hasTurn && (live || current.snap?.status === 'queued')) &&
        messages.every(message => message?.role !== 'assistant' ||
          (message.done !== true && !(message.blocks || []).some(block => block &&
            (!['thinking', 'text'].includes(block.kind) || String(block.text || '').trim()))));
      return { value, estimated, known, initial };
    }
    function elapsedText(elapsedMs) {
      if (elapsedMs === null) return tx('未记录');
      const seconds = Math.max(0, Math.floor(Number(elapsedMs || 0) / 1000));
      if (seconds < 60) return seconds + 's';
      const minutes = Math.floor(seconds / 60);
      return minutes + 'm ' + String(seconds % 60).padStart(2, '0') + 's';
    }
    function runtimeActive(current) {
      const snap = current && current.snap || {};
      if (waiting(snap)) return false;
      const execution = snap.execution || {};
      const phase = execution.quality && execution.quality.phase;
      if (execution.stopKind === 'agent-stall') return false;
      return execution.running === true ||
        ['executing', 'implementing', 'reviewing', 'repairing'].includes(phase);
    }
    function snapshotElapsedMs() {
      const current = state();
      if (!runtimeActive(current) && (current.pending || !current.snap?.execution?.controlled &&
          !current.snap?.messages?.some(message => message.role === 'assistant'))) return null;
      const raw = current.snap?.execution?.elapsedMs;
      if (raw == null) return null;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 ? value : null;
    }
    function completedElapsedMs(current) {
      if (current.pending || runtimeActive(current)) return null;
      const snap = current.snap || {}, messages = snap.messages || [];
      if (snap.execution?.controlled) return snapshotElapsedMs();
      if (snap.execution?.cloud) return snapshotElapsedMs();
      let final = -1, from = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'assistant' && final < 0) final = i;
        if (messages[i]?.role === 'user') { from = i; break; }
      }
      if (final < 0 || messages[final].done === false) return null;
      const absolute = snap.history?.messageIndices?.[final] ?? ((Number(snap.history?.messageStart) || 0) + final);
      const receipt = (snap.turnMetrics || []).find(row => row.fromMessage <= absolute && row.toMessage >= absolute);
      if (Number.isFinite(receipt?.elapsedMs) && receipt.elapsedMs >= 0) return receipt.elapsedMs;
      const epoch = value => typeof value === 'number' ? value : Date.parse(value || '');
      const start = epoch(messages[from]?.sentAt), end = epoch(messages[final].completedAt);
      return Number.isFinite(start) && start > 0 && Number.isFinite(end) && end >= start ? end - start : null;
    }
    function turnKey(current) {
      if (!current.pending && current.snap?.execution?.timingTurn) {
        return 'runtime:' + current.snap.execution.timingTurn;
      }
      const pendingAt = Number(current && current.pendingSentAt);
      if (current && current.pending && Number.isFinite(pendingAt) && pendingAt > 0) {
        return 'pending:' + pendingAt;
      }
      const messages = (current && current.snap && current.snap.messages) || [];
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message || message.role !== 'user') continue;
        const sentAt = Number(message.sentAt);
        return 'message:' + index + ':' + (Number.isFinite(sentAt) && sentAt > 0 ? sentAt : String(message.text || ''));
      }
      return '';
    }
    function elapsedMs() {
      const current = state();
      if (!current.pending && waiting(current.snap)) return snapshotElapsedMs();
      const completed = completedElapsedMs(current);
      if (current.snap?.execution?.cloud && !current.pending && snapshotElapsedMs() === null) return null;
      if (completed !== null) return completed;
      if (!thinkingActive && !current.pending && !runtimeActive(current)) {
        const sameTurn = thinkingRef === String(current.ref || current.sessionId || '') && thinkingTurnKey === turnKey(current);
        if (sameTurn && thinkingElapsedMs > 0) return thinkingElapsedMs;
        const saved = snapshotElapsedMs();
        if (saved > 0) return saved;
        // Restored delegated history can contain only the initiating user
        // message until its execution pages arrive. No clock means unknown.
        if (current.snap?.messages?.some(message => ['user', 'assistant'].includes(message.role))) return null;
      }
      // A fresh submit owns the clock. The runtime snapshot may still carry
      // the previous turn's elapsed value while the new request is being
      // accepted, so never let that stale value jump the display forward.
      const observed = thinkingUseSubmitTime ? null : snapshotElapsedMs();
      const local = thinkingStartedAt ? Math.max(0, Date.now() - thinkingStartedAt) : 0;
      const live = observed == null ? local : (thinkingStartedAt ? Math.max(observed, local) : observed);
      return Math.max(thinkingElapsedMs, live);
    }
    function displayText(elapsed, baseText) {
      const current = state();
      const base = String(baseText == null
        ? (typeof current.workStatus === 'function' ? current.workStatus() : work(current.snap, current.pending, current.ref))
        : baseText).trim();
      if (!current.pending && waiting(current.snap)) return base;
      if (Number(elapsed || 0) < 12000) return base;
      const slot = Math.floor((Number(elapsed || 0) - 12000) / 14000);
      const promo = tx(promos[slot % promos.length]);
      return promo && base ? base + ' · ' + promo : base;
    }
    function refreshStatusCopy() {
      const current = state();
      const doc = current.document || global.document;
      const status = doc && doc.querySelector('#nchatList [data-chat-node="runtime-status"]');
      const copy = status && status.querySelector('.nstatus-copy');
      if (!copy) return;
      copy.textContent = displayText(elapsedMs());
      copy.classList.remove('swap');
    }
    function metricsHtml(busy) {
      const tokens = tokenInfo();
      const label = busy ? '处理中' : '已处理';
      return '<div data-chat-node="turn-metrics" class="nturn-metrics" aria-label="' + escape(tx('当前工作统计')) + '">' +
        '<span class="nstatus-metric"><span data-thinking-label>' + tx(label) + '</span> ' +
        '<b data-thinking-elapsed>' + elapsedText(elapsedMs()) + '</b></span><span class="nstatus-divider">·</span>' +
        '<span class="nstatus-metric" title="' + escape(tx('包含深度思考与回复；估算值以模型返回用量为准。')) + '">' +
        '<span data-thinking-estimate' + (tokens.estimated ? '' : ' hidden') + ' aria-label="估算">≈</span>' +
        '<b data-thinking-tokens>' + (tokens.known || tokens.initial ? tokenText(tokens.value) : '—') +
        '</b><em>tokens</em></span></div>';
    }
    function statusHtml(busy) {
      const current = state();
      if (!current.pending && waiting(current.snap)) return '<div data-chat-node="runtime-status" class="nstatus show">' +
        '<span class="nstatus-copy">' + escape(work(current.snap, '', current.ref)) + '</span></div>';
      return '<div data-chat-node="runtime-status" class="nstatus' + (busy ? ' show' : '') + '">' +
        '<span class="ndot"></span><span class="nstatus-copy">' + escape(displayText(elapsedMs())) + '</span></div>';
    }
    function stopThinkingClock() {
      const current = state();
      const identity = String(current.ref || current.sessionId || '');
      if (thinkingRef && identity && thinkingRef !== identity) thinkingElapsedMs = completedElapsedMs(current) ?? snapshotElapsedMs() ?? 0;
      else thinkingElapsedMs = elapsedMs();
      if (thinkingTimer) clearInterval(thinkingTimer);
      thinkingTimer = 0; thinkingStartedAt = 0; thinkingObservedElapsed = null;
      thinkingTurnKey = turnKey(current);
      thinkingUseSubmitTime = false;
      if (identity) thinkingRef = identity;
      thinkingActive = false;
    }
    function refreshThinkingUi() {
      if (Date.now() - feedbackAt < 200) return;
      feedbackAt = Date.now();
      const current = state();
      const doc = current.document || global.document;
      const status = doc && doc.querySelector('#nchatList [data-chat-node="runtime-status"]');
      if (!thinkingStartedAt) return;
      const metrics = doc && doc.querySelector('#nchatList [data-chat-node="turn-metrics"]');
      const elapsed = elapsedMs();
      const elapsedNode = metrics?.querySelector('[data-thinking-elapsed]');
      const tokenNode = metrics?.querySelector('[data-thinking-tokens]');
      const tokens = tokenInfo();
      const estimate = metrics?.querySelector('[data-thinking-estimate]');
      if (estimate) estimate.hidden = !tokens.estimated;
      if (elapsedNode) elapsedNode.textContent = elapsedText(elapsed);
      if (tokenNode) tokenNode.textContent = tokens.known || tokens.initial ? tokenText(tokens.value) : '—';
      const statusCopy = status?.querySelector('.nstatus-copy');
      if (statusCopy && !((current.snap && current.snap.execution) || {}).stalled) {
        statusCopy.textContent = displayText(elapsed);
      }
    }
    function syncThinkingClock(active) {
      if (!active) { stopThinkingClock(); return; }
      const current = state();
      const identity = String(current.ref || current.sessionId || 'pending');
      const nextTurnKey = turnKey(current);
      const now = Date.now();
      const observed = snapshotElapsedMs();
      const turnChanged = thinkingTurnKey && nextTurnKey && nextTurnKey !== thinkingTurnKey;
      if (!thinkingActive || turnChanged) {
        thinkingActive = true;
        thinkingElapsedMs = 0;
        thinkingObservedElapsed = null;
        const sentAt = Number(current.pendingSentAt);
        const runtimeClock = current.snap?.execution?.cloud || current.snap?.execution?.controlled;
        const hasSubmitTime = (!runtimeClock || Boolean(current.pending)) &&
          Number.isFinite(sentAt) && sentAt > 0 && sentAt <= now;
        thinkingStartedAt = hasSubmitTime ? sentAt : now - (observed == null ? 0 : observed);
        thinkingUseSubmitTime = hasSubmitTime;
        thinkingRef = identity;
        thinkingTurnKey = nextTurnKey;
      }
      else if (thinkingRef !== identity && thinkingRef !== 'pending') {
        stopThinkingClock();
        thinkingActive = true;
        thinkingElapsedMs = 0;
        thinkingStartedAt = now - (observed == null ? 0 : observed);
        thinkingRef = identity;
        thinkingTurnKey = nextTurnKey;
      } else if (thinkingRef !== identity) thinkingRef = identity;
      if (observed != null && !thinkingUseSubmitTime) {
        const local = Math.max(0, now - thinkingStartedAt);
        // The local clock starts as soon as the user submits. The runtime's
        // elapsedMs starts later when the provider accepts the turn, so an
        // initial value of 0 (or a lower value after a snapshot) must never
        // rewind the visible timer. Rebase only when the runtime has advanced
        // beyond our local estimate, such as when reopening a running chat.
        if (observed > local) thinkingStartedAt = now - observed;
        thinkingObservedElapsed = Math.max(Number(thinkingObservedElapsed || 0), observed);
      }
      if (!thinkingTimer) thinkingTimer = setInterval(refreshThinkingUi, 1000);
    }
    function stopSlowStatusTicker() {
      if (slowStatusTimer) clearInterval(slowStatusTimer);
      slowStatusTimer = 0; slowStatusSlot = -1;
    }
    function refreshSlowStatus() {
      const current = state();
      const execution = (current.snap && current.snap.execution) || {};
      if (!execution.stalled) return;
      const slot = Math.floor(Date.now() / 14000);
      if (slot === slowStatusSlot) return;
      slowStatusSlot = slot;
      const doc = current.document || global.document;
      const copy = doc && doc.querySelector('#nchatList [data-chat-node="runtime-status"] .nstatus-copy');
      if (!copy) return;
      const base = global.ChatStatus && typeof global.ChatStatus.rotating === 'function'
        ? global.ChatStatus.rotating(current.ref) : (typeof current.workStatus === 'function' ? current.workStatus() : tx('正在处理'));
      copy.textContent = displayText(elapsedMs(), base);
      copy.classList.remove('swap');
      void copy.offsetWidth;
      copy.classList.add('swap');
    }
    function syncSlowStatusTicker(active) {
      if (!active) { stopSlowStatusTicker(); return; }
      if (slowStatusTimer) return;
      slowStatusSlot = Math.floor(Date.now() / 14000);
      slowStatusTimer = setInterval(refreshSlowStatus, 1200);
    }
    function setDialogFocused(focused) {
      /* The focus-specific hint belongs to the composer, not this runtime row.
         Keep this method as a compatibility no-op for callers from older builds. */
      void focused;
      refreshStatusCopy();
    }
    return {
      statusHtml, metricsHtml, refreshThinkingUi, syncThinkingClock, stopThinkingClock, syncSlowStatusTicker,
      stopSlowStatusTicker, setDialogFocused,
    };
  }

  const api = { notice, longWork, rotating, work, runtimeBusy, createThinking, outputTokens: usageValue, estimateOutput };
  global.ChatStatus = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
