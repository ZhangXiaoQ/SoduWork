'use strict';

/* Durable, provider-neutral client usage reporter.
   The outbox contains usage counters and environment identity only—never device keys. */
const path = require('path');
const conversationTitles = require('../conversation/titles');

const { empty, add, usageFromSnapshot } = require('./usage-values');
const outboxStore = require('./usage-outbox');

function createUsageReporter(options) {
  const app = options.app;
  const identityOf = options.identityOf;
  const onQuotaExceeded = typeof options.onQuotaExceeded === 'function'
    ? options.onQuotaExceeded : null;
  const fetchImpl = options.fetchImpl || fetch;
  const file = path.join(app.getPath('userData'), 'usage-outbox.json');
  const outbox = outboxStore.create(file, options.onError || (() => {
    console.warn('[usage] Pending usage could not be saved; retained for retry');
  }));
  let timer = null;
  let flushing = false;
  const observed = new WeakMap();
  const accountedReceipts = new WeakMap();

  function schedule(delay) {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush().catch(() => {});
    }, delay == null ? 700 : delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function post(row) {
    const identity = await identityOf(app, row.hub, row.clientId);
    if (!identity || !identity.hub) throw new Error('usage identity unavailable');
    if (identity.hub.replace(/\/+$/, '') !== row.hub.replace(/\/+$/, '') || identity.clientId !== row.clientId)
      throw new Error('usage environment changed');
    if (row.accountScope && require('../conversation/runtime-segments').scope(identity) !== row.accountScope)
      throw new Error('usage account changed');
    const headers = { 'Content-Type': 'application/json' };
    if (identity.session) headers.Authorization = 'Device ' + identity.session;
    else {
      headers['X-Soduwork-Device'] = identity.clientId;
      headers['X-Soduwork-Secret'] = identity.secret;
    }
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), 8000);
    try {
      const response = await fetchImpl(
        identity.hub.replace(/\/+$/, '') + '/api/v1/usage/events', {
          method: 'POST', headers, signal: ctl.signal,
          body: JSON.stringify(row.payload),
        });
      const text = await response.text();
      let result = {};
      try { result = text ? JSON.parse(text) : {}; } catch (_) { result = {}; }
      if (!response.ok || result.ok !== true) throw new Error('usage was not acknowledged');
      if (result && result.quota && result.quota.exceeded && onQuotaExceeded) {
        try {
          // A settled old-account report must never log out the current account.
          const current = await identityOf(app);
          const sameEnvironment = current?.hub?.replace(/\/+$/, '') === row.hub.replace(/\/+$/, '') &&
            current.clientId === row.clientId;
          const sameAccount = sameEnvironment && (row.accountScope
            ? require('../conversation/runtime-segments').scope(current) === row.accountScope
            : Boolean(identity.session) && current.session === identity.session);
          if (sameAccount) onQuotaExceeded({ hub: identity.hub, clientId: identity.clientId,
            quota: result.quota });
        } catch (_) { /* accounting succeeded; a UI notification must not retry it */ }
      }
      return result;
    } finally { clearTimeout(timeout); }
  }

  async function flush() {
    if (flushing) return;
    flushing = true;
    let delay = 500;
    try {
      const result = await outbox.drain(post);
      if (result.failed) delay = 30000;
    } catch (_) { delay = 30000; }
    finally {
      flushing = false;
      if (outbox.pending()) schedule(delay);
    }
  }

  function observe(handle, snapshot) {
    try {
      const identity = handle && handle.usageIdentity;
      const sessionId = String(handle && handle.sessionId || '');
      if (!identity || !identity.hub || !identity.clientId || !sessionId) return;
      // Cloud execution is already recorded by the Hub's execution ledger.
      // Replaying its display projection as a local chat would charge twice.
      if (snapshot?.cloudHandoff?.phase === 'committed') return;
      const receipts = snapshot?.usageReceipts;
      if (receipts && accountedReceipts.get(handle) === receipts) return;
      const scope = JSON.stringify([identity.hub, identity.clientId, identity.accountScope || '', sessionId]);
      if (snapshot && typeof snapshot === 'object') {
        const scopes = observed.get(snapshot) || new Set();
        if (scopes.has(scope)) return;
        scopes.add(scope); observed.set(snapshot, scopes);
      }
      const usage = usageFromSnapshot(snapshot);
      if (!(usage.total || usage.cost || usage.turns || usage.steps || snapshot?.usageReceipts?.length)) return;
      const rawModel = handle.model;
      const model = String(rawModel && typeof rawModel === 'object'
        ? (rawModel.id || rawModel.name || '') : (rawModel || ''));
      /*
       * Prefer renamed titles from the title store, then the history-derived first-message
       * title. Persist the title in the outbox for offline retries; empty titles let
       * administration fall back to the source label.
       */
      let sourceTitle = '';
      try {
        const decorated = conversationTitles.decorate(app, { id: sessionId });
        sourceTitle = String(decorated && decorated.title || '');
      } catch (_) { /* best effort */ }
      if (!sourceTitle) {
        try {
          const row = typeof handle.historyRow === 'function' ? handle.historyRow(snapshot) : null;
          sourceTitle = String((row && row.title) || '');
        } catch (_) { /* best effort */ }
      }
      sourceTitle = sourceTitle.replace(/\s+/g, ' ').trim().slice(0, 120);
      const base = {
        idempotencyKey: sessionId,
        sourceType: 'chat',
        sourceId: sessionId,
        conversationId: sessionId,
        sourceTitle,
        agent: String(handle.usageAgentKey || handle.adapterId || 'unknown'),
        provider: String(handle.usageProvider || ''),
        model,
        credentialScope: String(handle.usageCredentialScope || 'personal'),
        billingMode: String(handle.usageBillingMode || 'unknown'),
        usage,
        occurredAt: new Date().toISOString(),
      };
      // Time belongs to a checkpoint, not the network retry. Keep day/model
      // boundaries even when the server is unavailable for several days.
      function checkpoint(payload) {
        const day = new Date(Date.parse(payload.occurredAt) + 8 * 3600000).toISOString().slice(0, 10);
        const bucket = JSON.stringify([day, payload.agent, payload.provider, payload.model,
          payload.credentialScope, payload.billingMode, payload.quotaUsageToken || '']);
        if (outbox.enqueue({ hub: identity.hub, clientId: identity.clientId, accountScope: identity.accountScope || '',
          scope, bucket, payload })) schedule();
      }
      if (Array.isArray(snapshot?.usageReceipts) && snapshot.usageReceipts.length) {
        const cumulative = empty();
        for (const receipt of snapshot.usageReceipts) {
          add(cumulative, receipt.usage);
          checkpoint({ ...base, usage: { ...cumulative }, model: receipt.model || model,
            agent: receipt.agent || base.agent,
            provider: receipt.provider !== undefined ? receipt.provider : base.provider,
            ...(typeof receipt.quotaUsageToken === 'string' && receipt.quotaUsageToken
              ? { quotaUsageToken: receipt.quotaUsageToken } : {}),
            occurredAt: receipt.at ? new Date(receipt.at).toISOString() : base.occurredAt });
        }
      } else checkpoint(base);
      if (receipts) accountedReceipts.set(handle, receipts);
    } catch (_) { /* accounting cannot block the user's session */ }
  }

  if (outbox.pending()) schedule();
  return { observe, flush, persist: outbox.persist };
}

module.exports = { usageFromSnapshot, createUsageReporter };
