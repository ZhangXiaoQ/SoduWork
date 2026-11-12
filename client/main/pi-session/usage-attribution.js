'use strict';

// Freeze the resolved catalog provider per assistant call before SDK archival.
function create(preparedModel) {
  let active = null;
  return function stamp(event) {
    if (event?.type === 'agent_end') { active = null; return; }
    const message = event?.message;
    if (message?.role !== 'assistant') return;
    if (event.type === 'message_start') {
      const prepared = preparedModel();
      const model = prepared?.model;
      active = model?.id && typeof model.quotaProvider === 'string' && model.quotaProvider.trim()
        ? { model: String(model.id), provider: model.quotaProvider.trim(), runtimeProvider: prepared.provider || '',
          quotaUsageToken: model.quotaVersion === 2 && typeof model.quotaUsageToken === 'string'
            ? model.quotaUsageToken : '' } : null;
    }
    if (event.type !== 'message_start' && event.type !== 'message_end') return;
    if (!message.usageProvider && active && message.model === active.model &&
        (!active.runtimeProvider || message.provider === active.runtimeProvider)) {
      message.usageProvider = active.provider;
    }
    if (active && active.quotaUsageToken && message.model === active.model &&
        message.usageProvider === active.provider &&
        (!active.runtimeProvider || message.provider === active.runtimeProvider)) {
      // Persist only with this actual call's usage; never label historical totals
      // from the composer's current selection or an unverified funding flag.
      message.quotaUsageToken = active.quotaUsageToken;
    }
    if (event.type === 'message_end') active = null;
  };
}

module.exports = { create };
