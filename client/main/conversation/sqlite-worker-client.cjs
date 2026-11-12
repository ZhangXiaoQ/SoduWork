'use strict';

// Keep SQLite work off the Electron main thread. Ref only active requests so
// an idle database worker does not prevent an otherwise clean application exit.
function create(script, workerData, methods) {
  const { Worker } = require('node:worker_threads');
  const worker = new Worker(script, { workerData });
  let serial = 0, failure;
  const pending = new Map();
  worker.on('message', reply => {
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    reply.error ? request.reject(Error(reply.error)) : request.resolve(reply.value);
    if (!pending.size) worker.unref();
  });
  const fail = error => { failure = error; for (const request of pending.values()) request.reject(error); pending.clear(); };
  worker.on('error', fail);
  worker.on('exit', code => fail(Error('Conversation storage worker exited: ' + code)));
  function call(method, ...args) {
    if (failure) return Promise.reject(failure);
    if (pending.size >= 256) return Promise.reject(Error('Conversation storage is busy; retry after pending requests complete'));
    worker.ref();
    return new Promise((resolve, reject) => {
      const id = ++serial;
      pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, method, args }); }
      catch (error) { pending.delete(id); if (!pending.size) worker.unref(); reject(error); }
    });
  }
  worker.unref();
  const api = Object.fromEntries(methods.map(method => [method, (...args) => call(method, ...args)]));
  api.asynchronous = true;
  let closing;
  api.close = () => closing ||= (async () => { try { await call('close'); } finally { await worker.terminate(); } })();
  return api;
}
module.exports = { create };
