'use strict';

const { fetchWithDeviceAuthRetry } = require('../device-auth-request');
const { scope } = require('./runtime-segments');

function create({ app, identityOf, onQuotaExceeded, fetchImpl = global.fetch }) {
  return async function authorize(expected, expectedScope = scope(expected), selection) {
    const identity = await identityOf(app);
    const matches = value => value && value.hub === expected?.hub &&
      value.clientId === expected?.clientId && scope(value) === expectedScope;
    if (!matches(identity)) throw Error('账号或连接环境已变化，请重新发送');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      // Captured model names are resolved by the server, never an exemption flag.
      const query = new URLSearchParams();
      if (typeof selection?.model === 'string') query.set('model', selection.model);
      if (typeof selection?.agent === 'string') query.set('agent', selection.agent);
      const response = await fetchWithDeviceAuthRetry(identity,
        identity.hub.replace(/\/+$/, '') + '/api/v1/client-auth/authorize-ai' +
          (query.size ? '?' + query.toString() : ''),
        { signal: controller.signal }, fetchImpl);
      const result = await response.json().catch(() => null);
      if (!matches(await identityOf(app))) throw Error('账号或连接环境已变化，请重新发送');
      const quota = result?.quota;
      // Legacy Hubs retain their strict account gate. Only a versioned,
      // server-resolved response can grant personal funding.
      const versioned = result?.quotaVersion === 2;
      const invalidScope = result?.quotaScope === 'personal' && (!versioned || query.get('agent') !== 'pi' ||
        result.personalQuotaSupported !== true) ||
        versioned && query.size && (!['personal', 'platform'].includes(result.quotaScope) ||
          typeof result.resolvedModel !== 'string' || !result.resolvedModel ||
          typeof result.providerId !== 'string' || !result.providerId ||
          Boolean(selection?.model && result.resolvedModel !== selection.model));
      if (invalidScope || !response.ok || result?.ok !== true || typeof quota?.enabled !== 'boolean' ||
          typeof quota?.exceeded !== 'boolean' || quota.exceeded) {
        const detail = quota?.exceeded ? { code: 'TOKEN_QUOTA_EXCEEDED',
          message: '本月 AI Token 额度已用完，请联系管理员调整额度', quota } : result?.detail;
        if (detail?.code === 'TOKEN_QUOTA_EXCEEDED') onQuotaExceeded?.({
          hub: identity.hub, clientId: identity.clientId, quota: detail.quota });
        throw Object.assign(Error(detail?.message || (response.status === 404 || invalidScope
          ? '服务端需要升级后才能校验个人 Token 额度' : '无法确认可用额度，请稍后重试')), require('../../core/token-quota').fields(detail));
      }
      return result.quota;
    } finally { clearTimeout(timer); }
  };
}

function beforeTurn(authorize, identity, previous, runtime) {
  const expectedScope = scope(identity);
  return async function (turn, ...args) {
    const selection = runtime?.agent === 'pi' && runtime.modelMode === 'managed' && !runtime.controlled &&
      !require('../../core/model-choice').imageChoice(turn?.modelName) ? {
      model: typeof turn?.modelName === 'string' ? turn.modelName : '', agent: 'pi',
    } : undefined;
    await authorize(identity, expectedScope, selection);
    return previous?.apply(this, args);
  };
}

module.exports = { create, beforeTurn };
