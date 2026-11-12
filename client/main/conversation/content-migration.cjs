'use strict';

// Re-scan remaining Hub metadata after every restart. Each record is idempotent;
// no client cursor can mark a missing endpoint or failed transfer as completed.
const { fetchWithDeviceAuthRetry } = require('../device-auth-request');
const { connectionScope } = require('../platform-connections/runtime.cjs');
const KINDS = ['account', 'handoff', 'message', 'relay', 'execution', 'schedule'];
function create({ app, identityOf, fetch = fetchWithDeviceAuthRetry, interval = 60000, budget = 20 }) {
  let closed = false, timer, pending, owner = '', state = { phase: 'idle' };
  let cursors = {};
  const lifetime = new AbortController();
  async function run() {
    if (closed) return;
    if (pending) return pending;
    pending = (async () => {
      const identity = await identityOf(app);
      const captured = connectionScope(identity);
      if (!captured) return;
      if (owner !== captured) { owner = captured; cursors = {}; state = { phase: 'idle' }; }
      async function current() {
        if (closed || captured !== connectionScope(await identityOf(app))) throw Error('Migration account changed');
      }
      async function request(route, body) {
        await current();
        const response = await fetch(identity, String(identity.hub).replace(/\/+$/, '') + '/api/v1/conversation-content-migrations' + route, {
          method: body ? 'POST' : 'GET', redirect: 'error',
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(180000)]),
          ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
        });
        const value = await response.json(); await current();
        if (!response.ok) throw Error(typeof value.detail === 'string' ? value.detail : 'Conversation migration unavailable');
        return value;
      }
      const status = await request('/status');
      if (!status.metadataOnly) { state = { phase: 'waiting-upgrade', pending: status.pending }; return; }
      state = { phase: status.complete ? 'complete' : 'running', pending: status.pending, succeeded: 0, failed: 0 };
      let remaining = budget;
      for (const kind of KINDS) {
        if (remaining <= 0 || !status.pending?.[kind]) continue;
        const page = await request('?kind=' + kind + '&limit=' + Math.min(remaining, 50, Math.max(1, Math.floor(budget / KINDS.length))) +
          '&after=' + encodeURIComponent(cursors[kind] || ''));
        if (!Array.isArray(page.items)) throw Error('Invalid migration directory');
        cursors[kind] = page.hasMore ? String(page.cursor || '') : '';
        for (const item of page.items) {
          if (remaining <= 0) break;
          remaining--;
          try {
            let result;
            do {
              result = await request('/' + kind + '/' + encodeURIComponent(item.id),
                kind === 'account' ? { targetClientId: identity.clientId } : {});
              if (!result.ok) throw Error('Migration has no durable acknowledgement');
              if (result.complete === false && remaining > 0) remaining--;
              else break;
            } while (true);
            state.succeeded++;
          } catch (error) {
            await current(); state.failed++; state.lastError = error.message;
          }
        }
      }
      const final = await request('/status');
      state = { ...state, phase: final.complete ? 'complete' : 'pending', pending: final.pending };
    })().catch(error => { if (!closed) state = { ...state, phase: 'pending', lastError: error.message }; })
      .finally(() => { pending = null; });
    return pending;
  }
  function start() {
    if (timer || closed) return;
    timer = setTimeout(async () => { timer = null; await run(); start(); }, interval); timer.unref?.();
  }
  return { start, run, snapshot: identity => connectionScope(identity) === owner ? { ...state } : { phase: 'idle' },
    close() { closed = true; clearTimeout(timer); timer = null; lifetime.abort(); return pending; } };
}
module.exports = { create, KINDS };
