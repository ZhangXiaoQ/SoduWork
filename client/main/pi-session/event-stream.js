
















const attachmentContract = require('./attachment-contract');
const pluginContext = require('./plugin-context');
const visionContract = require('./vision-contract');
const outputContinuation = require('./output-continuation');
const modelErrors = require('./model-errors');
const goalQuality = require('../conversation/goal-quality');
const goalLoop = require('../conversation/goal-loop');
const protocolGuard = require('../agent-runtime/protocol-guard');
const stallRecovery = require('./stall-recovery');
const preparation = require('./tool-preparation');
const agentSource = require('../conversation/agent-source.cjs');
const { IMAGE_BYTES, MAX_FILES } = require('./attachments');
const SCOPES = Object.freeze({
  NORMAL: 'normal',
  GOAL_PROGRESS: 'goal-progress',
  GOAL_EXECUTION: 'goal-execution',
  GOAL_REVIEW: 'goal-review',
  GOAL_FINAL: 'goal-final',
  RUNTIME_NOTICE: 'runtime-notice',
});
const VALID_SCOPES = new Set(Object.values(SCOPES));
const DELTA_KINDS = {
  thinking_start: 'thinking', thinking_delta: 'thinking', thinking_end: 'thinking',
  text_start: 'text', text_delta: 'text', text_end: 'text',
  toolcall_start: 'toolcall', toolcall_delta: 'toolcall', toolcall_end: 'toolcall',
};

function _blank() {
  return {
    messages: [],            // [{ role, blocks:[], usage }]
    tools: [],               // [{ id, name, args, partial, result, isError, state }]
    usage: null,             // Latest message usage; Pi input reflects the full-history watermark.
    contextUsage: null,      // Settled request only; partial zeros cannot replace it.
    retried: false,          // Whether automatic retry events occurred.
    retryError: '',          // Latest raw retry explanation; presentation layers localize it.
    modelRetry: null,
    lastError: '',           // Raw nonretryable errors carried by the stream.
    lastStopReason: '',      // Current turn termination reason: stop, length, toolUse, error, or aborted.
    rawStopReason: '',
    lastAssistantError: '',
    incompleteReason: '',   // Bounded continuation stopped without a completed answer.
    ranTurn: false,          // Whether an actual turn started; an empty conversation does not count.
    turnMessageFrom: 0,
    /* A new session has not started a turn yet. It is ready for input. */
    settled: true,
    compacting: false,
    aborted: false,
    pendingUi: null,         // Pending extension request requiring confirmation, selection, input, or editing.
    auditFrom: -1,           // Start of internal delivery review, whose analysis remains hidden.
    auditUntil: -1,          // Review end boundary prevents later ordinary messages from remaining hidden.
    auditPreliminary: -1,    // Hide the initial draft after review starts to avoid duplicating final delivery.
    auditHidden: [],         // Do not expose review conclusions before they satisfy machine evidence checks.
    auditPlainFrom: -1,      // only the final composed answer is plain-visible
    auditRevealed: false,    // Expose the final review answer only after programmatic completion checks.
    protocolIssue: null,     // Keep private tool protocols out of assistant content.
    currentScope: SCOPES.NORMAL,
    goalActive: false,
    notices: [],
    continuationPending: false,
  };
}

/* Get the current assistant message or create one. */
function _current(state, sourceAgent) {
  const last = state.messages[state.messages.length - 1];
  if (last && last.role === 'assistant' && !last.done) {
    if (sourceAgent === undefined || agentSource.same(last.sourceAgent, sourceAgent)) return last;
    last.done = true;
  }
  const continuation = Boolean(state.continuationPending);
  state.continuationPending = false;
  const msg = {
    role: 'assistant', blocks: [], usage: null, done: false, continuation, ...agentSource.fields(sourceAgent),
    scope: VALID_SCOPES.has(state.currentScope) ? state.currentScope : SCOPES.NORMAL,
  };
  state.messages.push(msg);
  return msg;
}

/*
 * Resolve blocks by contentIndex so interleaved arrival order cannot mix thinking and
 * content.
 */
function _block(msg, index, kind) {
  let b = msg.blocks.find((x) => x.index === index);
  if (!b) {
    b = { index, kind, text: '', done: false, toolCall: null,
      protocolPending: '', protocolLeak: false };
    msg.blocks.push(b);
    msg.blocks.sort((a, c) => a.index - c.index);
  }
  // Preserve the first block kind if an inconsistent later event would discard received text.
  return b;
}

function _tool(state, id) {
  let t = state.tools.find((x) => x.id === id);
  if (!t) {
    /*
     * Record the owning message index for each tool so later turns do not relocate earlier
     * tool activity.
     */
    t = { id, name: '', args: null, partial: '', result: null, isError: false,
          state: 'running', after: Math.max(0, state.messages.length - 1),
          scope: VALID_SCOPES.has(state.currentScope) ? state.currentScope : SCOPES.NORMAL,
          startedAt: Date.now(), updatedAt: Date.now(), endedAt: 0 };
    state.tools.push(t);
  }
  return t;
}

function _toolMetadata(target, event) {
  if (!target || !event) return;
  Object.assign(target, agentSource.fields(event.sourceAgent));
  for (const key of ['toolKind', 'serviceUrl', 'previewUrl', 'host']) {
    if (typeof event[key] === 'string' && event[key].trim()) target[key] = event[key].trim().slice(0, 2000);
  }
  if (Number.isInteger(Number(event.port)) && Number(event.port) > 0 && Number(event.port) < 65536) {
    target.port = Number(event.port);
  }
  if (Array.isArray(event.services)) target.services = event.services.slice(0, 8);
}

function _textOf(result) {
  const arr = (result && result.content) || [];
  return arr.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n');
}

// Keep the pixels returned by a read, not a later filesystem version. Only the
// on-demand tool receipt exposes them; ordinary UI snapshots omit these bytes.
function _readImages(tool, result) {
  delete tool.readImages;
  delete tool.readImagesTruncated;
  if (String(tool.toolKind || '').toLowerCase() !== 'read' &&
      !/^(?:read|read_file|open_file)$/i.test(tool.name)) return;
  const images = [];
  let bytes = 0, truncated = false;
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    if (block?.type !== 'image') continue;
    const mimeType = typeof block.mimeType === 'string' ? block.mimeType.toLowerCase() : '';
    const data = block.data;
    if (!/^image\/[a-z0-9][a-z0-9.+-]*$/.test(mimeType) ||
        typeof data !== 'string' || !data.length || data.length % 4 !== 0) continue;
    // Check the transport size before scanning/decoding any untrusted payload.
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    const size = data.length / 4 * 3 - padding;
    if (images.length >= MAX_FILES || size > IMAGE_BYTES - bytes) { truncated = true; continue; }
    if (/[^A-Za-z0-9+/=]/.test(data) || (data.indexOf('=') !== -1 &&
        data.indexOf('=') !== data.length - padding)) continue;
    images.push({ mimeType, data });
    bytes += size;
  }
  if (images.length) tool.readImages = images;
  if (truncated) tool.readImagesTruncated = true;
}

function _usageObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

// Pi initializes every counter to zero before receiving provider usage. Keep
// that placeholder in the message receipt, but not in the context meter.
function reportedContextUsage(message) {
  const usage = _usageObject(message.usage);
  if (!usage || message.taskOutputKey || message.model === 'task-executor') return null;
  const inputs = [usage.input, usage.inputTokens, usage.input_tokens, usage.promptTokens,
    usage.prompt_tokens, usage.contextTokens, usage.context_tokens, usage.context];
  const cache = [usage.cacheRead, usage.cache_read_tokens, usage.cache_read_input_tokens,
    usage.cached_input_tokens, usage.cacheWrite, usage.cache_write_tokens, usage.cacheCreation,
    usage.cache_creation_input_tokens, usage.cache_write_input_tokens, usage.cache?.read, usage.cache?.write];
  const positive = value => Number.isFinite(value) && value > 0;
  if (inputs.some(positive) || cache.some(positive)) return usage;
  if (!inputs.includes(0)) return null;
  const otherCounts = [usage.output, usage.outputTokens, usage.output_tokens, usage.completion_tokens,
    usage.total, usage.totalTokens, usage.total_tokens];
  if (otherCounts.some(positive)) return usage;
  if (message.stopReason === 'aborted' || message.stopReason === 'error') return null;
  return otherCounts.includes(0) ? null : usage;
}

function _eventUsage(event, assistantMessageEvent) {
  const a = assistantMessageEvent || {};
  return _usageObject(a.usage) || _usageObject(a.usageMetadata) ||
    _usageObject(event && event.message && event.message.usage) ||
    _usageObject(event && event.usage) || _usageObject(event && event.usageMetadata) || null;
}

function _mergeUsage(target, incoming) {
  const next = _usageObject(incoming);
  if (!next) return target || null;
  return { ...(target || {}), ...next };
}

/* Normalize message content from strings or block arrays. */
function _plain(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n');
}
function _user(content) {
  const plain = _plain(content);
  const normalFollowup = plain.trimStart().startsWith(goalQuality.NORMAL_MARKER);
  // Hide automatic continuation controls without starting an internal goal-review interval.
  if (outputContinuation.isContinuationPrompt(plain)) {
    return { hidden: true, internalContinuation: true, audit: false, scope: '', text: '', attachments: [] };
  }
  if (stallRecovery.isRecoveryPrompt(plain)) {
    const goal = stallRecovery.isGoalRecoveryPrompt(plain);
    return { hidden: true, audit: goal,
      scope: goal ? SCOPES.GOAL_EXECUTION : SCOPES.NORMAL, text: '', attachments: [] };
  }
  if (protocolGuard.isRecoveryPrompt(plain)) {
    const normal = protocolGuard.isNormalRecoveryPrompt(plain);
    return { hidden: true, audit: !normal,
      scope: normal ? SCOPES.NORMAL : SCOPES.GOAL_EXECUTION, text: '', attachments: [] };
  }
  if (goalLoop.isInternalPrompt(plain)) {
    return { hidden: true, audit: true, scope: SCOPES.GOAL_EXECUTION, text: '', attachments: [] };
  }
  if (goalQuality.isInternalPrompt(plain)) {
    const source = String(plain || '').trimStart();
    const execution = source.startsWith(goalQuality.IMPLEMENT_MARKER) ||
      source.startsWith(goalQuality.REPAIR_MARKER) ||
      source.startsWith(goalQuality.CONTINUE_MARKER);
    const final = /final user-facing delivery turn|最终阻断回执阶段/i.test(source);
    return {
      hidden: true, audit: true,
      scope: execution ? SCOPES.GOAL_EXECUTION : (final ? SCOPES.GOAL_FINAL : SCOPES.GOAL_REVIEW),
      text: '', attachments: [],
    };
  }
  const withoutVision = visionContract.parse(require('./input-context.cjs').strip(plain));
  const withPlugins = pluginContext.parse(withoutVision.text);
  const parsed = attachmentContract.parse(withPlugins.text);
  return {
    text: goalQuality.visibleUserPrompt(parsed.text), attachments: parsed.files,
    plugins: withPlugins.plugins, scope: SCOPES.NORMAL, normalFollowup,
  };
}

function _writeAssistantText(state, block, value, options) {
  if (block.protocolLeak) return null;
  const cfg = options || {};
  const current = block.text + String(block.protocolPending || '');
  const source = cfg.replace ? String(value == null ? '' : value)
    : current + String(value == null ? '' : value);
  const inspected = protocolGuard.inspect(source, { final: Boolean(cfg.final), channel: block.kind });
  block.text = inspected.text;
  block.protocolPending = inspected.pending || '';
  if (!inspected.detected) return null;
  block.protocolLeak = true;
  block.protocolPending = '';
  state.protocolIssue = {
    code: inspected.code,
    count: Number(state.protocolIssue && state.protocolIssue.count || 0) + 1,
    bytes: Number(inspected.bytes || 0),
    parameters: Number(inspected.parameters || 0),
    at: Date.now(),
  };
  return state.protocolIssue;
}

function _noticeText(event) {
  const params = event && event.params && typeof event.params === 'object' ? event.params : {};
  const raw = event && (event.message || event.text || event.status) ||
    params.message || params.text || params.status || '';
  const text = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 360);
  /*
   * Suppress repetitive internal system-warning reminders from conversation and progress
   * views while retaining raw audit events.
   */
  if (/忽略无关\s*system_warning|ignore (?:irrelevant )?system_warning/i.test(text)) return '';
  return text;
}

function _addNotice(state, value, level) {
  const message = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 360);
  if (!message) return null;
  const key = message.toLowerCase();
  const old = state.notices.find((item) => item.key === key);
  if (old) {
    old.count += 1;
    old.at = Date.now();
    return old;
  }
  const row = {
    key, message, level: String(level || 'info').slice(0, 20),
    scope: SCOPES.RUNTIME_NOTICE, count: 1, at: Date.now(),
  };
  state.notices.push(row);
  state.notices = state.notices.slice(-8);
  return row;
}

/* Some Pi/provider adapters include the complete assistant content only on
   `message_end` (there are no *_delta events in that mode). Keep the terminal
   message authoritative just like `text_end`/`thinking_end`; otherwise a
   thinking-only length stop looks empty and the continuation loop sends the
   same prompt again instead of recognizing the stalled turn. */
function _syncAssistantContent(state, msg, content) {
  const blocks = Array.isArray(content) ? content
    : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);
  let protocolIssue = null;
  blocks.forEach((item, position) => {
    if (!item || typeof item !== 'object') return;
    const type = String(item.type || '').toLowerCase();
    const kind = type === 'thinking' ? 'thinking' : type === 'text' ? 'text'
      : type === 'toolcall' ? 'toolcall' : '';
    if (!kind) return;
    const index = Number.isInteger(item.index) ? item.index : position;
    const block = _block(msg, index, kind);
    if (kind === 'toolcall') {
      block.toolCall = item;
      block.done = true;
      return;
    }
    const value = kind === 'thinking' ? item.thinking : item.text;
    protocolIssue = _writeAssistantText(state, block, typeof value === 'string' ? value : '', {
      replace: true, final: true,
    }) || protocolIssue;
    block.done = true;
  });
  return protocolIssue;
}


/* Apply one event in place and return affected state for incremental publication. */
function apply(state, ev) {
  if (!ev || typeof ev !== 'object') return { kind: 'ignored' };
  require('../conversation/message-time').stampPiEvent(ev);
  preparation.observe(state, ev);
  switch (ev.type) {
    /*
     * message events also contain user messages and tool results; treating all of them as
     * assistant output creates empty bubbles.
     */
    case 'message_start': {
      state.ranTurn = true;
      state.settled = false;
      const role = ev.message && ev.message.role;
      if (role && role !== 'assistant') return { kind: 'ignored' };
      return { kind: 'message', message: _current(state, ev.message?.sourceAgent || null) };
    }

    case 'message_update': {
      const a = ev.assistantMessageEvent || {};
      const kind = DELTA_KINDS[a.type];
      const usage = _eventUsage(ev, a);
      if (!kind && !usage) return { kind: 'ignored' };
      const msg = _current(state, ev.message?.sourceAgent ?? ev.sourceAgent);
      if (usage) {
        msg.usage = _mergeUsage(msg.usage, usage);
        state.usage = msg.usage;
      }
      if (!kind) return { kind: 'usage', usage: msg.usage, message: msg };
      // Treat zero as a valid contentIndex rather than a missing value.
      const idx = typeof a.contentIndex === 'number' ? a.contentIndex : 0;
      const b = _block(msg, idx, kind);
      let protocolIssue = null;
      if (a.type === 'thinking_delta' || a.type === 'text_delta') {
        protocolIssue = _writeAssistantText(state, b, a.delta || '');
      }
      if (kind === 'toolcall') {
        const brief = preparation.put(state, a.toolCall || a.partial?.content?.[idx]);
        if (brief) b.toolCall = brief;
      }
      if (a.type === 'toolcall_delta') b.text += a.delta || '';
      if (a.type === 'text_end' || a.type === 'thinking_end') {
        // Use complete end-event content to repair any missing deltas.
        protocolIssue = _writeAssistantText(state, b,
          typeof a.content === 'string' ? a.content : '', {
            replace: typeof a.content === 'string', final: true,
          }) || protocolIssue;
        b.done = true;
      }
      if (a.type === 'toolcall_end') {
        b.toolCall = a.toolCall || null;
        b.done = true;
      }
      if (protocolIssue) return { kind: 'protocol-leak', block: b, issue: protocolIssue };
      return { kind: 'block', block: b, ...(usage ? { usage: msg.usage } : {}) };
    }

    case 'message_end': {
      const m = ev.message || {};
      if (m.role && m.role !== 'assistant') {
        // Record user content from the runtime stream so displayed history matches model input.
        if (m.role === 'user') {
          const previous = state.messages[state.messages.length - 1];
          if (previous && previous.role === 'assistant' && !previous.done) previous.done = true;
          const visible = _user(m.content);
          if (visible.hidden) {
            if (visible.internalContinuation) state.continuationPending = true;
            /*
             * Once beginFinalAnswer selects final-answer scope, a legacy audit control must not
             * downgrade it to goal-review.
             */
            if (visible.scope && !(state.currentScope === SCOPES.GOAL_FINAL &&
                visible.scope === SCOPES.GOAL_REVIEW)) state.currentScope = visible.scope;
            if (visible.audit !== false && state.auditFrom < 0) state.auditFrom = state.messages.length;
            return { kind: 'internal' };
          }
          if (visible.normalFollowup) {
            if (state.auditFrom >= 0 && state.auditUntil < 0) state.auditUntil = state.messages.length;
            state.goalActive = false;
            state.currentScope = SCOPES.NORMAL;
          }
          state.messages.push({ role: 'user', text: visible.text, attachments: visible.attachments,
            sentAt: require('../conversation/message-time').epoch(m.sentAt),
            ...(m.submissionId ? { submissionId: String(m.submissionId).slice(0, 128) } : {}),
            ...(m.taskId ? { taskId: String(m.taskId) } : {}),
            ...(m.taskOutputKey ? { taskOutputKey: String(m.taskOutputKey) } : {}),
            plugins: Array.isArray(m.plugins) ? require('../conversation/plugin-badges').publicBadges(m.plugins)
              : visible.plugins || [], blocks: [], usage: null, done: true,
            scope: SCOPES.NORMAL });
          /*
           * Runtime notices belong to their triggering turn. Clear them when a new user turn starts
           * so stale stop reasons do not persist.
           */
          if (state.notices.length) state.notices = [];
          state.currentScope = state.goalActive ? SCOPES.GOAL_EXECUTION : SCOPES.NORMAL;
          return { kind: 'message' };
        }
        return { kind: 'ignored' };      // Tool results are tracked separately.
      }
      const msg = _current(state, m.sourceAgent);
      Object.assign(msg, agentSource.fields(m.sourceAgent));
      const terminalIssue = _syncAssistantContent(state, msg, m.content);
      msg.done = true;
      msg.completedAt = require('../conversation/message-time').epoch(m.completedAt);
      msg.usageAt = msg.completedAt || require('../conversation/message-time').epoch(m.timestamp);
      msg.usageModel = String(m.model || '');
      msg.usageProvider = String(m.usageProvider || m.provider || '');
      msg.quotaUsageToken = typeof m.quotaUsageToken === 'string' ? m.quotaUsageToken : '';
      msg.stopReason = String(m.stopReason || '');
      msg.rawStopReason = String(m.rawStopReason || '');
      msg.errorMessage = String(m.errorMessage || '');
      state.lastStopReason = msg.stopReason;
      state.rawStopReason = msg.rawStopReason;
      state.lastAssistantError = msg.errorMessage;
      if (m.usage) {
        state.usageRevision = (state.usageRevision || 0) + 1;
        // Pi's custom model registration uses unknown (zero) prices. Its SDK
        // synthesizes a zero cost object even when no price was supplied.
        msg.usage = m.usage.cost?.total === 0 && m.usage.costKnown === undefined
          ? { ...m.usage, costKnown: false } : m.usage;
        state.usage = msg.usage;
      }
      const contextUsage = reportedContextUsage(m);
      if (contextUsage) state.contextUsage = contextUsage;
      if (m.taskId) msg.taskId = String(m.taskId);
      if (m.taskOutputKey) msg.taskOutputKey = String(m.taskOutputKey);
      if (terminalIssue) return { kind: 'protocol-leak', issue: terminalIssue };
      return { kind: 'message', message: msg };
    }

    case 'tool_execution_start': {
      const t = _tool(state, ev.toolCallId);
      t.name = ev.toolName || '';
      t.args = ev.args || null;
      _toolMetadata(t, ev);
      t.state = 'running';
      t.updatedAt = Date.now();
      return { kind: 'tool', tool: t };
    }
    case 'tool_execution_update': {
      const t = _tool(state, ev.toolCallId);
      _toolMetadata(t, ev);
      // partialResult is cumulative; replace rather than append.
      t.partial = _textOf(ev.partialResult);
      t.updatedAt = Date.now();
      return { kind: 'tool', tool: t, partial: true };
    }
    case 'tool_execution_end': {
      const t = _tool(state, ev.toolCallId);
      t.name = ev.toolName || t.name;
      _toolMetadata(t, ev);
      t.result = _textOf(ev.result);
      _readImages(t, ev.result);
      const accessCancelled = !ev.isError && ev.state === 'cancelled' && ev.cancelReason === 'access-change';
      t.isError = !!ev.isError;
      t.state = ev.isError ? 'error' : accessCancelled ? 'cancelled' : 'done';
      if (accessCancelled) t.cancelReason = 'access-change';
      t.updatedAt = Date.now();
      t.endedAt = t.updatedAt;
      return { kind: 'tool', tool: t };
    }

    case 'auto_retry_start':
      state.retried = true;
      state.retryError = String(ev.errorMessage || '');
      state.modelRetry = { active: true, attempt: Number(ev.attempt) || 1, max: Number(ev.maxAttempts) || 3 };
      if (Number.isFinite(ev.delayMs) && ev.delayMs >= 0) {
        state.modelRetry.delayMs = ev.delayMs;
        state.modelRetry.retryAt = Date.now() + ev.delayMs;
      }
      return { kind: 'retry' };
    case 'auto_retry_end':
      if (ev.success === false) {
        state.retryError = String(ev.finalError || state.retryError);
        /* Some Pi/provider adapters finish an exhausted retry with only
           `auto_retry_end` + `agent_settled`; they do not emit the usual
           assistant `message_end`.  Treat that terminal retry as the same
           model error so the turn is recoverable instead of looking like a
           silent idle turn.  A later message_end remains authoritative and
           may replace these fields with its richer error/stop reason. */
        if (!state.lastStopReason) state.lastStopReason = 'error';
        if (!state.lastAssistantError) state.lastAssistantError = state.retryError;
      }
      if (state.modelRetry) state.modelRetry.active = false;
      return { kind: 'retry' };

    case 'context_reset':
      state.contextUsage = null;
      return { kind: 'usage' };
    case 'compaction_start':
      state.compacting = true;
      state.contextUsage = null;
      return { kind: 'compaction' };
    case 'compaction_end':
      state.compacting = false;
      state.contextUsage = null;
      return { kind: 'compaction' };

    case 'extension_ui_request':
      // Only dialog requests suspend for user input; notifications and status updates do not.
      if (['select', 'confirm', 'input', 'editor'].indexOf(ev.method) >= 0) {
        state.pendingUi = ev;
        return { kind: 'ui', request: ev };
      }
      return { kind: 'notice', request: ev,
        notice: _addNotice(state, _noticeText(ev), ev.level || 'info') };

    /*
     * Clear prior terminal state when a new turn starts so streaming indicators and Stop
     * remain available.
     */
    case 'agent_start':
      state.ranTurn = true;
      state.turnMessageFrom = state.messages.length;
      state.settled = false;
      state.aborted = false;
      state.protocolIssue = null;
      state.continuationPending = false;
      state.lastStopReason = '';
      state.rawStopReason = '';
      state.lastAssistantError = '';
      state.incompleteReason = '';
      /*
       * Invalidate unanswered prior-turn UI requests when a new turn begins to avoid permanent
       * waiting-user state.
       */
      state.pendingUi = null;
      if (state.modelRetry) state.modelRetry.active = false;
      return { kind: 'run' };

    case 'agent_settled':
      preparation.clear(state);
      state.settled = true;
      if (state.modelRetry) state.modelRetry.active = false;
      return { kind: 'settled' };

    default:
      // Retain error text from unknown events to explain turns that produce no output.
      if (ev && (ev.errorMessage || ev.error)) {
        const raw = ev.errorMessage || ev.error;
        state.lastError = String(typeof raw === 'string' ? raw : (raw.message || ''));
      }
      return { kind: 'ignored' };
  }
}

/* Treat tokens or visible content as evidence that the model produced output. */
function _produced(state) {
  // Keep the displayed context/token waterline, but never use an earlier
  // answer as evidence that the current request received a model response.
  return state.messages.slice(state.turnMessageFrom || 0).some((m) => {
    if (m.role !== 'assistant') return false;
    if (m.blocks.some((b) => b.kind === 'text' && b.text.trim())) return true;
    const usage = m.usage || {};
    const output = [usage.output, usage.output_tokens, usage.completion_tokens]
      .filter(value => value !== undefined && value !== null && Number.isFinite(Number(value)));
    // Prompt/input tokens alone are not a response. Retain compatibility only
    // when an old provider reports total usage without any output breakdown.
    return output.length ? output.some(value => Number(value) > 0)
      : Number(usage.totalTokens || usage.total_tokens || 0) > 0;
  });
}

/* Derive status from the whole turn, including failures without a retry event.
   An upstream 404 can end a turn without producing assistant content. Report
   that outcome explicitly instead of presenting an empty response as idle. */
function deriveStatus(state) {
  if (state.protocolIssue) return 'unreachable';
  if (state.aborted) return 'aborted';
  if (state.pendingUi) return 'waiting-user';
  if (state.compacting) return 'compacting';
  if (!state.settled) return 'streaming';
  if (state.lastStopReason === 'error') return 'unreachable';
  if (state.lastStopReason === 'length' || state.incompleteReason) return 'incomplete';
  // An empty conversation remains idle until a real turn has started.
  if (state.ranTurn && !_produced(state)) return state.retried ? 'unreachable' : 'no-output';
  return 'idle';
}

/* Provide a readable explanation for either empty-result failure state. */
function statusText(state) {
  const s = deriveStatus(state);
  if (state.protocolIssue) return protocolGuard.reason(state.protocolIssue);
  if (s === 'incomplete') {
    if (state.incompleteReason === 'reasoning-limit') {
      return '模型的单次输出上限已被思考内容用完，尚未生成答复。请检查模型管理中的最大输出量；也可降低模型支持的思考强度或选择其他模型后继续。部分模型不支持关闭思考。已有内容和工具结果已保留，不会自动重复执行。';
    }
    if (state.incompleteReason === 'context-full') {
      return '会话上下文已超过模型窗口，自动压缩后仍未恢复。这个会话在新窗口模型下才能继续；请新建会话接着做，或在模型管理里检查该模型的上下文窗口配置。';
    }
    if (['action-handoff', 'output-loop', 'missing-answer'].includes(state.incompleteReason)) {
      return '模型未能完成本轮请求，已停止自动重试。已有内容和工具结果已保留，可以检查原因后重试。';
    }
    return '回复达到单轮输出长度上限，自动续写后仍未完整。已有内容已保留，可以直接发送“继续”。';
  }
  if (s === 'unreachable') {
    const raw = (state.lastAssistantError || state.retryError || state.lastError || '').trim();
    const detail = modelErrors.forDisplay(raw, 200);
    if (state.lastStopReason === 'error') {
      return '模型服务在回答过程中中断了这一轮' +
        (detail ? '（' + detail + '）' : '') + '。' +
        (state.modelRetry && state.modelRetry.attempt ? '已自动重试 ' + state.modelRetry.attempt + ' 次。' : '') +
        '已有内容和工具结果已保留，' + (modelErrors.describe(raw).retryable
          ? '可恢复这一轮继续。' : '请检查模型服务或配置后再继续。');
    }
    return '连不上模型服务，重试几次都没通' + (detail ? '（' + detail + '）' : '') +
      '。请检查模型服务地址、网络连接与代理设置。';
  }
  if (s === 'no-output') {
    const raw = (state.lastError || state.retryError || '').trim();
    const detail = modelErrors.forDisplay(raw, 200);
    return '这一轮模型没吐出任何内容' + (detail ? '（' + detail + '）' : '') +
      '。多半是模型服务那边报错了（模型名不存在、没授权、额度用完都长这样），' +
      '去「模型管理」里点一下「测一下」就能看到真实原因。';
  }
  return '';
}

function snapshot(state, options) {
  return require('./event-snapshot').snapshot(state, options, { SCOPES, deriveStatus, statusText });
}

function create() {
  const state = _blank();
  return {
    state,
    push: (ev) => apply(state, ev),
    snapshot: () => snapshot(state),
    uiSnapshot: (options) => snapshot(state, {
      messageLimit: options && options.messageLimit || 80,
      toolLimit: options && options.toolLimit || 160,
    }),
    status: () => deriveStatus(state),
    abort: () => { preparation.clear(state); state.aborted = true; },
    markIncomplete: (reason) => {
      state.incompleteReason = ['action-handoff', 'output-loop', 'reasoning-limit', 'missing-answer', 'length', 'context-full'].includes(reason) ? reason : 'length';
    },
    recoverProtocol: () => {
      const last = state.messages[state.messages.length - 1];
      if (last && last.role === 'assistant' && !last.done) last.done = true;
      state.protocolIssue = null;
      state.aborted = false;
      preparation.clear(state);
      state.settled = true;
    },
    recoverRuntime: () => {
      const last = state.messages[state.messages.length - 1];
      if (last && last.role === 'assistant' && !last.done) last.done = true;
      state.aborted = false;
      preparation.clear(state);
      state.settled = true;
      state.lastStopReason = '';
    },
    answerUi: () => { state.pendingUi = null; },
    beginGoalTurn: () => {
      state.goalActive = true;
      state.currentScope = SCOPES.GOAL_EXECUTION;
      state.auditFrom = state.messages.length;
      state.auditUntil = -1;
      state.auditPreliminary = -1;
      state.auditHidden = [];
      state.auditPlainFrom = -1;
      state.auditRevealed = false;
    },
    beginAudit: () => {
      state.currentScope = SCOPES.GOAL_REVIEW;
      if (state.auditFrom >= 0) return;
      state.auditFrom = state.messages.length;
      for (let index = state.messages.length - 1; index >= 0; index -= 1) {
        const item = state.messages[index];
        if (item && item.role === 'assistant' && (item.blocks || []).some((block) =>
          block && block.kind === 'text' && String(block.text || '').trim())) {
          state.auditPreliminary = index;
          break;
        }
      }
    },
    rejectAudit: () => {
      for (let index = state.messages.length - 1; index >= 0; index -= 1) {
        const item = state.messages[index];
        if (item && item.role === 'assistant' && (item.blocks || []).some((block) =>
          block && block.kind === 'text' && String(block.text || '').trim())) {
          if (!state.auditHidden.includes(index)) state.auditHidden.push(index);
          break;
        }
      }
      state.auditRevealed = false;
      /*
       * Legacy archives may omit beginAudit before a later review conclusion. Default to review
       * scope; an explicit repair control restores execution scope.
       */
      state.currentScope = SCOPES.GOAL_REVIEW;
    },
    setScope: (scope) => {
      if (VALID_SCOPES.has(scope)) state.currentScope = scope;
    },
    appendAssistant: (value, scope, completedAt = Date.now()) => {
      const selected = VALID_SCOPES.has(scope) ? scope : SCOPES.NORMAL;
      const message = {
        role: 'assistant', done: true, usage: null, scope: selected,
        completedAt: require('../conversation/message-time').epoch(completedAt),
        blocks: [{ index: 0, kind: 'text', text: String(value || ''), done: true, toolCall: null }],
      };
      state.messages.push(message);
      state.currentScope = selected;
      return message;
    },
    appendNotice: (value, level) => _addNotice(state, value, level),
    beginFinalAnswer: () => {
      state.currentScope = SCOPES.GOAL_FINAL;
      state.auditPlainFrom = state.messages.length;
    },
    revealAudit: () => {
      state.currentScope = SCOPES.GOAL_FINAL;
      state.auditRevealed = true;
      state.auditUntil = state.messages.length;
    },
    endGoalTurn: () => {
      if (state.auditFrom >= 0 && state.auditUntil < 0) state.auditUntil = state.messages.length;
      state.goalActive = false;
      state.currentScope = SCOPES.NORMAL;
    },
  };
}

module.exports = { SCOPES, create, apply, snapshot, deriveStatus, statusText, reportedContextUsage, _blank };
