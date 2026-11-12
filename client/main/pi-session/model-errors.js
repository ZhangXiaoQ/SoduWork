'use strict';

/* Model providers and the SoduWork proxy use several error shapes. Keep the raw
   value in the in-memory audit state, but never put a proxy envelope or an
   upstream response into user-facing chat text. */

// Older Hub streams expose only localized message text because the SDK discards envelope.code.
// Recognize only published capacity-error text; generic retry wording must not authorize retries.
const LEGACY_CAPACITY_STATUS = new Map([
  ['模型并发调度连接中断，请稍后重试', 503],
  ['模型并发调度暂时不可用，请稍后重试', 503],
  ['模型等待队列已满，请稍后重试', 429],
  ['等待模型服务超时，请稍后重试', 429],
  ['模型服务当前繁忙，请稍后重试', 429],
]);
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_RE = /time[ -]?out|timed\s*out|upstream\s+connect|disconnect\s*\/\s*reset|connection\s+reset|connection\s+refused|(?:network|connection)\s+error|fetch\s+failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket\s+hang\s+up|temporarily\s+unavailable|(?:bad\s+gateway|gateway\s+error)|didn'?t\s+respond\s+in\s+time/i;
const AUTH_EXPIRED_RE = /(?:ai\s+)?proxy\s+ticket(?:\s+is)?\s+(?:expired|required|invalid)|(?:session|credential|token|key|密钥|凭据|会话).{0,30}(?:expired|expiry|expiration|过期|失效)|(?:expired|过期|失效).{0,30}(?:session|credential|token|ticket|key|密钥|凭据|会话)/i;
// These are the native SDK's premature-stream/transport errors, including
// HTTP 200 responses that end before a terminal event. Exhausting the SDK's
// retry budget must still expose the existing explicit continuation action.
const STREAM_INTERRUPTION_RE = /^(?:TypeError:\s*)?terminated$|\bother side closed\b|\bconnection\s+lost\b|\bsocket connection was closed\b|\bwebsocket[ :]+(?:closed|error)\b|\bstream ended (?:without\b|before (?:message_stop|a terminal response event)\b)/i;
// An unrecognized gateway body must not become chat text. In particular, do
// not strip HTML and retain its internal addresses, request tokens or headers.
const PRIVATE_RESPONSE_RE = /<\/?[a-z][^>]*>|<!doctype\b|&lt;\/?[a-z]|\b(?:https?|wss?):\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:authorization|api[-_ ]?key|access[-_ ]?token|password|secret)\s*[:=]|\bbearer\s+\S+/i;
const IMAGE_REJECTION_RE = /image[_ -]?input[_ -]?(?:rejected|unsupported)|(?:image|vision|multimodal).{0,50}(?:not supported|unsupported|rejected|maximum|limit)/i;

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return String(value.message || value);
  if (typeof value === 'object') {
    if (typeof value.message === 'string') return value.message;
    try { return JSON.stringify(value); } catch (error) { return String(value); }
  }
  return String(value);
}

function payloadOf(source) {
  const start = source.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(source.slice(start)); } catch (error) { return null; }
}

function statusOf(source, payload, error) {
  const explicit = [error, payload].filter(Boolean)
    .flatMap(item => [item.status, item.statusCode, item.code]).map(Number)
    .find(value => value >= 400 && value < 600);
  if (explicit >= 400 && explicit < 600) return explicit;
  const match = source.match(/\bHTTP(?:\/\d(?:\.\d)?)?\s+([45]\d{2})\b|^([45]\d{2})(?=$|[\s:<({])|(?:^|\s)([45]\d{2})(?=\s*(?:[:{<]|status\s+code|\(no body\)))|<(?:title|h1)\b[^>]*>\s*([45]\d{2})\b/i);
  return Number(match && match.slice(1).find(Boolean) || LEGACY_CAPACITY_STATUS.get(source) || 0);
}

function describe(value) {
  const raw = textOf(value).trim();
  const payload = value && typeof value === 'object' ? value : payloadOf(raw);
  const error = payload && payload.error && typeof payload.error === 'object'
    ? payload.error : payload;
  const quota = require('../../core/token-quota').detail(payload || raw);
  if (quota) return { raw, payload, type: 'quota', status: 403, proxy: true, transient: false,
    retryable: false, code: quota.code, quota: quota.quota,
    publicText: '当前 AI 使用额度暂不可用，请查看额度详情' };
  const type = String(error && error.type || '');
  const status = statusOf(raw, payload, error);
  const upstream = String(error && error.upstream || '');
  const combined = [raw, String(error && error.message || ''), upstream].join(' ');
  const proxy = /soduwork(?:_work)?_proxy_error/i.test(type + ' ' + raw);
  const providerCode = String(error?.providerCode || error?.code || '') === '1113' ||
    /供应商错误码\s*[:：]?\s*1113\b/.test(combined) ? '1113' : '';
  const billing = Boolean(providerCode) || /upstream_billing_error|billing_required|insufficient_quota|insufficient_balance|billing_hard_limit_reached|余额不足|计费额度不可用/i.test(combined);
  const transient = TRANSIENT_STATUS.has(status) || TRANSIENT_RE.test(combined) ||
    STREAM_INTERRUPTION_RE.test(raw) || STREAM_INTERRUPTION_RE.test(String(error && error.message || ''));
  const authExpired = !billing && status === 401 && AUTH_EXPIRED_RE.test(combined);
  const permanent = billing || /insufficient_quota|quota exceeded|billing|out of budget|available balance|usage limit reached/i.test(combined) ||
    [400,403,404,413,422].includes(status) || (status === 401 && !authExpired);
  const retryable = authExpired || (!permanent && (transient || proxy && status === 0));

  let publicText = '';
  const privateResponse = PRIVATE_RESPONSE_RE.test(raw) || Boolean(payload && !(payload instanceof Error));
  if (billing || proxy || status || transient || privateResponse) {
    if (billing) {
      publicText = '模型服务余额不足或计费额度不可用' + (providerCode ? '（供应商错误码 1113）' : '') +
        '；请检查供应商账单、API Key 类型和接口地址';
    } else if (/context_length_exceeded|context length exceeded|prompt (?:is )?too long/i.test(combined)) {
      publicText = '当前上下文超过模型容量，历史和本轮输入已保留';
    } else if (IMAGE_REJECTION_RE.test(combined)) {
      publicText = '当前模型不接受图片输入，请切换支持图片的模型或启用视觉适配';
    } else if (status === 401 || status === 403) {
      publicText = '模型服务拒绝了当前凭据或模型权限';
    } else if (status === 404) {
      publicText = '模型服务地址或模型不存在';
    } else if (status === 429) {
      publicText = '模型服务当前繁忙或额度受限';
    } else if (transient) {
      publicText = '模型服务暂时不可用';
    } else {
      publicText = '模型服务返回了暂时无法处理的错误';
    }
    if (status) publicText += '（HTTP ' + status + '）';
  }
  return { raw, payload, type, status, proxy, transient, authExpired, retryable, publicText,
    ...(billing ? { code: 'upstream_billing_error', providerCode } : {}) };
}

function forDisplay(value, limit = 200) {
  const info = describe(value);
  if (!info.raw) return '';
  if (info.publicText) return info.publicText;
  return info.raw.replace(/\s+/g, ' ').trim().slice(0, Math.max(40, Number(limit) || 200));
}

module.exports = { describe, forDisplay, textOf };
