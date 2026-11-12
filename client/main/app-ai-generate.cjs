'use strict';

// A bounded, stateless inference path. Never create an Agent/session, load a
// workspace or register tools here. The existing Hub proxy owns auth and usage.
const crypto = require('node:crypto');
const { scope } = require('./conversation/runtime-segments');
const modelConfig = require('./pi-session/model-config');

function normalize(params) {
  if (Object.keys(params).some(key => !['input', 'instructions', 'model', 'maxOutputTokens', 'timeoutMs', 'requestId'].includes(key)))
    throw Error('单次 AI 调用包含不支持的参数');
  for (const key of ['input', 'instructions']) {
    if (typeof params[key] !== 'string' || !params[key].trim() || params[key].length > 16000 || params[key].includes('\0'))
      throw Error('请提供本次输入和技能提示词（各最多16000字）');
  }
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(params.requestId || '')) throw Error('单次 AI 调用需要有效请求编号');
  if (params.model != null && (typeof params.model !== 'string' || params.model.length > 160 || /[\x00-\x1f]/.test(params.model)))
    throw Error('模型名称无效');
  for (const [key, min, max] of [['maxOutputTokens', 1, 2048], ['timeoutMs', 1000, 60000]]) {
    if (params[key] != null && (!Number.isSafeInteger(params[key]) || params[key] < min || params[key] > max))
      throw Error('单次 AI 调用限制无效：' + key);
  }
  return { input: params.input, instructions: params.instructions, model: params.model || '',
    maxOutputTokens: params.maxOutputTokens ?? 256, timeoutMs: params.timeoutMs ?? 30000, requestId: params.requestId };
}
function failure(code, reason, uncertain = false) { return { ok: false, code, reason, ...(uncertain ? { uncertain: true } : {}) }; }
function payload(model, params) {
  const thinking = require('./conversation/thinking-capabilities').profile(model);
  const max = Math.min(params.maxOutputTokens, require('./conversation/model-selection').outputLimit(model));
  const body = { model: model.id, stream: false,
    [thinking.reasoning && thinking.format === 'openai' ? 'max_completion_tokens' : 'max_tokens']: max,
    messages: [{ role: 'system', content: params.instructions }, { role: 'user', content: params.input }] };
  // Match the supported off mappings in the bundled Pi completion transport.
  // An always-thinking model is never forced off or silently replaced.
  if (thinking.reasoning && thinking.thinkingLevelMap?.off !== null) {
    if (['zai', 'deepseek'].includes(thinking.format)) body.thinking = { type: 'disabled' };
    if (thinking.format === 'qwen') body.enable_thinking = false;
    if (thinking.format === 'qwen-chat-template') body.chat_template_kwargs = { enable_thinking: false, preserve_thinking: true };
    if (thinking.format === 'openai' && thinking.supportsReasoningEffort && typeof thinking.thinkingLevelMap?.off === 'string')
      body.reasoning_effort = thinking.thinkingLevelMap.off;
  }
  return body;
}
async function boundedJSON(response) {
  if (Number(response.headers?.get('content-length') || 0) > 1048576) {
    await response.body?.cancel(); throw Error('response too large');
  }
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > 1048576) throw Error('response too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function create({ app, authenticatedIdentityOf, authorizeAI, fetchImpl = global.fetch,
  resolveModel = modelConfig.fetchModel, configuredModel = modelConfig.configuredModel }) {
  const receipts = new WeakMap(), active = new Map();
  return async function generate(item, raw, assertCurrent = () => {}) {
    const params = normalize(raw);
    let identity, owner;
    try {
      assertCurrent();
      identity = await authenticatedIdentityOf?.(app);
      owner = scope(identity);
      if (!identity?.hub || !identity.clientId || !authorizeAI) throw Error('login unavailable');
      assertCurrent();
    } catch (_) { return failure('APP_AI_UNAVAILABLE', '请先登录 SoduWork，并确认即用仍可使用'); }
    const current = async () => {
      assertCurrent();
      const next = await authenticatedIdentityOf(app);
      if (scope(next) !== owner || next.hub !== identity.hub || next.clientId !== identity.clientId)
        throw Error('account changed');
      assertCurrent();
    };
    const rows = receipts.get(item) || new Map(); receipts.set(item, rows);
    // Scope is part of the key: a later account must never receive an old result.
    const key = owner + ':' + params.requestId;
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(params)).digest('hex');
    const prior = rows.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return failure('APP_AI_REQUEST_CONFLICT', '请求编号已用于其他内容');
      const result = await prior.promise;
      try { await current(); return result; } catch (_) { return failure('APP_AI_CONTEXT_CHANGED', '账号或即用已变化，请重新打开'); }
    }
    // Receipts live only as long as this native app page. Do not evict uncertain
    // requests and accidentally charge twice when the caller retries an ID.
    if (rows.size >= 128) return failure('APP_AI_RECEIPTS_FULL', '本页调用记录已满，请重新打开即用后继续');
    const appKey = owner + ':' + String(item.appBridge?.appId || '');
    if ((active.get(owner) || 0) >= 4 || (active.get(appKey) || 0) >= 2)
      return failure('APP_AI_BUSY', 'AI 请求较多，请等待当前请求结束');
    active.set(owner, (active.get(owner) || 0) + 1); active.set(appKey, (active.get(appKey) || 0) + 1);
    const controller = new AbortController(), wc = item.view?.webContents;
    let dispatched = false, resolveAbort;
    const aborted = new Promise(resolve => { resolveAbort = resolve; });
    const stop = () => {
      controller.abort(); resolveAbort(failure(dispatched ? 'APP_AI_RESULT_UNKNOWN' : 'APP_AI_CANCELLED',
        dispatched ? '模型调用已中断，结果未确认；请勿自动重试' : '本次调用已取消', dispatched));
    };
    const navigation = (_event, _url, inPlace, mainFrame) => { if (mainFrame !== false && !inPlace) stop(); };
    const timer = setTimeout(stop, params.timeoutMs);
    wc?.once('destroyed', stop); wc?.on('did-start-navigation', navigation);
    const work = (async () => {
      try {
        const selection = await resolveModel(identity, params.model || configuredModel(app), 8000, fetchImpl);
        await current();
        if (controller.signal.aborted) return;
        if (!selection?.ok || !selection.model || selection.model.modality === 'image')
          return failure(selection?.code === 'TOKEN_QUOTA_EXCEEDED' ? selection.code : 'APP_AI_MODEL_UNAVAILABLE', '所选文字模型当前不可用，请检查模型或额度');
        const model = selection.model;
        // Inline app calls lack Pi's signed per-call receipt path, so retain
        // strict account admission rather than borrowing Pi's funding scope.
        await authorizeAI(identity, owner);
        await current();
        if (controller.signal.aborted) return;
        const body = payload(model, params);
        dispatched = true;
        const response = await fetchImpl(model.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + model.key }, body: JSON.stringify(body),
        });
        await current();
        if (!response.ok) {
          await response.body?.cancel();
          return failure(response.status === 429 ? 'APP_AI_RATE_LIMITED' : 'APP_AI_PROVIDER_ERROR',
            '模型服务暂不可用（HTTP ' + response.status + '），本次未获得结果');
        }
        const result = await boundedJSON(response);
        await current();
        const choice = result?.choices?.[0];
        const text = choice?.message?.content;
        if (typeof text !== 'string' || !text.trim() || text.length > 262144)
          return failure('APP_AI_EMPTY_RESULT', '模型未返回可用文字，请调整提示词或模型');
        const usage = {};
        for (const [key, source] of [['inputTokens', 'prompt_tokens'], ['outputTokens', 'completion_tokens'], ['totalTokens', 'total_tokens']])
          if (Number.isSafeInteger(result.usage?.[source]) && result.usage[source] >= 0) usage[key] = result.usage[source];
        return { ok: true, requestId: params.requestId, text, model: model.id, usage,
          finishReason: choice.finish_reason === 'length' ? 'length' : 'stop' };
      } catch (error) {
        if (error?.code === 'TOKEN_QUOTA_EXCEEDED') return failure(error.code, '当前 AI 使用额度暂不可用，请查看额度详情');
        // Never surface provider bodies, headers, URLs or tickets to the app.
        return failure(dispatched ? 'APP_AI_RESULT_UNKNOWN' : 'APP_AI_NOT_SENT',
          dispatched ? '未能确认本次模型结果，请勿自动重试' : '本次尚未发送，请检查账号、模型和即用状态', dispatched);
      }
    })();
    const promise = Promise.race([work, aborted]).finally(() => {
      controller.abort(); // Also release an unread response after an account/origin guard rejects it.
      clearTimeout(timer); wc?.removeListener('destroyed', stop); wc?.removeListener('did-start-navigation', navigation);
      for (const k of [owner, appKey]) { const n = (active.get(k) || 1) - 1; if (n) active.set(k, n); else active.delete(k); }
    });
    rows.set(key, { fingerprint, promise });
    const result = await promise;
    try { await current(); return result; } catch (_) { return failure('APP_AI_CONTEXT_CHANGED', '账号或即用已变化，请重新打开', dispatched); }
  };
}
module.exports = { create, normalize, payload };
