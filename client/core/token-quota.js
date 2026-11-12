/* Shared quota metadata for native admission and renderer guidance. */
(function (global) {
  'use strict';
  const CODE = 'TOKEN_QUOTA_EXCEEDED';
  const legacy = /当前 AI 使用额度暂不可用，请查看额度详情|TOKEN_QUOTA_EXCEEDED|本月\s*AI\s*Token\s*额度已用完/;

  function detail(value, depth = 0) {
    if (!value || depth > 4) return null;
    if (typeof value === 'string') {
      if (value.length <= 20000 && value.includes('{')) {
        try { const found = detail(JSON.parse(value.slice(value.indexOf('{'))), depth + 1); if (found) return found; } catch (_) {}
      }
      return legacy.test(value) ? { code: CODE, message: value } : null;
    }
    if (value.code === CODE || value.errorCode === CODE) return {
      code: CODE, quota: value.quota || null,
      message: String(value.message || value.reason || value.statusText || ''),
    };
    if (value.quota?.exceeded === true) return { code: CODE, quota: value.quota, message: '' };
    for (const nested of [value.detail, value.payload, value.error, value.completion?.error, value.execution?.turnQueue?.failure]) {
      const found = detail(nested, depth + 1);
      if (found) return found;
    }
    return detail(value.reason || value.statusText || value.message, depth + 1);
  }

  function fields(value) {
    const found = detail(value);
    return found ? { code: CODE, ...(found.quota ? { quota: found.quota } : {}) } : {};
  }

  function allowsPersonal(quota) {
    return quota?.quotaVersion === 2 && quota.personalModelsAllowed === true &&
      quota.exceeded === true && (!quota.reason || quota.reason === 'total_exhausted') &&
      Number(quota.limit) > 0 && !quota.restrictModels;
  }

  function copy(quota, tx = value => value, locale = 'en-US') {
    const q = quota || {};
    const number = value => new Intl.NumberFormat(locale).format(Math.max(0, Number(value) || 0));
    const date = value => {
      const parsed = value && new Date(value);
      return parsed && Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat(locale,
        { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(parsed) : '';
    };
    let title = tx('本期额度已用完');
    let guidance = tx('联系管理员调整额度后，即可继续。对话和草稿已保留。');
    if (q.reason === 'trial_expired') title = tx('试用已结束');
    else if (q.reason === 'model_not_allowed') title = tx('当前模型未包含在套餐中');
    else if (q.reason === 'model_exhausted') title = tx('当前模型的额度已用完');
    else if (q.mode === 'trial' || q.period === 'trial' || q.expiresAt) title = tx('试用额度已用完');
    else if (q.limit === 0 && q.totalLimited !== false) title = tx('AI 使用已暂停');
    if ((q.reason === 'model_exhausted' || q.reason === 'model_not_allowed') &&
        (q.models || []).some(model => !model.exceeded && (model.remaining === null || Number(model.remaining) > 0))) {
      guidance = tx('可在模型菜单选择其他可用模型，或联系管理员调整套餐。');
    }
    if (allowsPersonal(q)) {
      title = tx('平台模型额度已用完');
      guidance = tx('可选择账号允许的个人模型继续，或联系管理员调整平台额度。对话和草稿已保留。');
    }
    const reset = date(q.resetsAt), expiry = date(q.expiresAt);
    const used = q.enabled === false || q.totalLimited === false ? tx('总额度不限额') : Number.isFinite(Number(q.limit))
      ? tx('已用 {used} / {limit} Tokens').replace('{used}', number(q.used)).replace('{limit}', number(q.limit))
      : tx('请刷新查看当前额度');
    const timing = expiry ? tx('试用截止 {date}').replace('{date}', expiry)
      : reset ? tx('下次恢复 {date}').replace('{date}', reset) : '';
    return { title, guidance, used, timing };
  }

  const api = Object.freeze({ CODE, detail, fields, copy, allowsPersonal });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.SoduWorkQuota = api;
})(globalThis);
