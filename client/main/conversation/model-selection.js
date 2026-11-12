'use strict';

const contextWindow = require('./context-window');
const thinkingCapabilities = require('./thinking-capabilities');
const { replaceFileSync } = require('../verified-file-replace.cjs');

// The previous fallback (16k/32k) was routinely consumed by hidden reasoning on
// coding models before they emitted a tool call or a final answer. Keep an
// explicit server supplied limit authoritative, but give models with missing
// metadata a usable default. This is still bounded by the model context below.
const DEFAULT_OUTPUT_TOKENS = 65536;

function publicModel(model) {
  const m = model || {};
  const resolved = contextWindow.resolveContextWindow(m);
  return { id: String(m.id || ''), label: String(m.label || m.name || m.id || '默认模型'),
    ...(m.modality ? { modality: m.modality } : {}),
    ...(m.quotaVersion === 2 && ['personal', 'platform'].includes(m.quotaScope)
      ? { quotaVersion: 2, quotaScope: m.quotaScope } : {}),
    contextWindow: m.modality === 'image' ? 0 : resolved.contextWindow,
    contextWindowKnown: m.modality === 'image' ? false : resolved.contextWindowKnown,
    ...(m.modality === 'image' ? {} : {
      contextWindowEstimated: resolved.contextWindowEstimated,
      contextWindowSource: resolved.contextWindowSource,
    }) };
}

// A choice belongs to future submissions, never to the currently streaming turn.
// Queue items capture a name, not credentials. The runtime changes only at a turn boundary.
function create({ name = '', model, resolve, apply, persist = () => {}, changed = () => {}, generation = () => 0 }) {
  let selected = name, active = name, selectedModel = model, activeModel = model;
  let selecting = false;
  let appliedGeneration = generation();
  const needsApply = name => name !== active || generation() !== appliedGeneration ||
    (name === selected && (selectedModel?.runtimeRevision || selectedModel?.configRevision) !==
      (activeModel?.runtimeRevision || activeModel?.configRevision));
  return {
    capture: () => selected,
    needsApply: name => needsApply(name === undefined ? selected : name),
    view: () => ({ name: selected, activeName: active, model: publicModel(selectedModel),
      activeModel: publicModel(activeModel), pending: needsApply(selected) }),
    async select(name) {
      if (typeof name !== 'string' || name.length > 300 || /[\r\n\0]/.test(name))
        return { ok: false, reason: '模型名称无效' };
      if (selecting) return { ok: false, reason: '正在更新模型，请稍候' };
      selecting = true;
      try {
        const resolved = await resolve(name);
        if (!resolved || !resolved.ok || !resolved.model) return { ok: false,
          reason: require('../../core/token-quota').detail(resolved)
            ? '当前 AI 使用额度暂不可用，请查看额度详情' : '该模型当前不可用，请刷新模型列表后重试',
          ...require('../../core/token-quota').fields(resolved) };
        await persist(name);
        selected = name; selectedModel = resolved.model; changed();
        return { ok: true, selection: this.view() };
      } catch (_) { return { ok: false, reason: '模型设置未保存，请重试；当前模型未改变' }; }
      finally { selecting = false; }
    },
    async applyForTurn(name = selected) {
      if (!needsApply(name)) return;
      const applyingGeneration = generation();
      const resolved = await resolve(name);
      if (!resolved || !resolved.ok || !resolved.model) throw Object.assign(
        new Error(require('../../core/token-quota').detail(resolved)
          ? '当前 AI 使用额度暂不可用，请查看额度详情' : '本轮所选模型不可用，队列已暂停，请调整模型后重试'),
        require('../../core/token-quota').fields(resolved));
      try { await apply(resolved.model, name); }
      catch (_) { throw new Error('模型未能切换，队列已暂停，原会话与历史已保留'); }
      active = name; activeModel = resolved.model;
      appliedGeneration = applyingGeneration;
      if (selected === name) selectedModel = resolved.model;
      changed();
    },
  };
}

// Stores credential-free future choices independently of Runner logs or task bindings.
function preference(app, ref) {
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const root = app && typeof app.getPath === 'function' ? app.getPath('userData') : '';
  const file = root && path.join(root, 'conversation-models', crypto.createHash('sha256').update(ref).digest('hex') + '.json');
  const readSelection = () => {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { ...(typeof value.name === 'string' ? { name: value.name } : {}),
        ...(typeof value.reasoningEffort === 'string' ? { reasoningEffort: value.reasoningEffort } : {}) };
    } catch (_) { return {}; }
  };
  return {
    read() { return readSelection().name; },
    readSelection,
    write(name, reasoningEffort = readSelection().reasoningEffort) {
      if (!file) return;
      // Reopening a conversation must not rewrite an unchanged saved choice.
      // A transient destination lock may block new choices, but not restoration.
      const current = readSelection();
      if (current.name === name && current.reasoningEffort === reasoningEffort) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.' + crypto.randomUUID() + '.tmp';
      try {
        fs.writeFileSync(tmp, JSON.stringify({ name,
          ...(typeof reasoningEffort === 'string' ? { reasoningEffort } : {}) }), { mode: 0o600, flag: 'wx' });
        replaceFileSync(tmp, file);
      } catch (cause) {
        const error = new Error('会话模型设置未能保存，请检查本机存储后重试；当前 Agent 和对话已保留', { cause });
        error.code = cause.code;
        throw error;
      } finally { try { fs.unlinkSync(tmp); } catch (_) { /* renamed or failed staging */ } }
    },
  };
}

function piProvider(next) {
  const thinking = thinkingCapabilities.profile(next);
  const compat = {
    supportsDeveloperRole: false,
    supportsReasoningEffort: thinking.supportsReasoningEffort,
    ...(thinking.format ? { thinkingFormat: thinking.format } : {}),
  };
  return { name: 'SoduWork \u6a21\u578b\u670d\u52a1', baseUrl: next.baseUrl, api: 'openai-completions', apiKey: next.key,
    compat, models: [{ id: next.id, name: next.label || next.id,
      input: next.input || ['text'], reasoning: thinking.reasoning,
      ...(thinking.reasoning && thinking.thinkingLevelMap ? { thinkingLevelMap: thinking.thinkingLevelMap } : {}),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...contextWindow.resolveContextWindow(next), maxTokens: outputLimit(next),
      imageRouting: next.imageRouting || 'vision-fallback', compat }] };
}
function outputLimit(model) {
  const value = Number(model?.maxOutputTokens);
  const limit = Number.isInteger(value) && value >= 1024 && value <= 262144 ? value : DEFAULT_OUTPUT_TOKENS;
  const context = Number(model?.contextWindow);
  return Number.isInteger(context) && context >= 1024 ? Math.min(limit, context) : limit;
}
module.exports = { create, publicModel, preference, piProvider, outputLimit, DEFAULT_OUTPUT_TOKENS };
