'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
let worker, sequence = 0, idle;
let pendingBytes = 0;
const pending = new Map();
function inputSize(input) {
  let bytes = 0, nodes = 0;
  const stack = [input];
  while (stack.length) {
    const value = stack.pop();
    if (++nodes > 30000) throw Error('应用资源请求结构过大');
    if (typeof value === 'string') bytes += value.length * 2;
    else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) { stack.push(value[key]); if (stack.length > 30000) throw Error('应用资源请求结构过大'); }
    }
    if (bytes > 32 * 1024 * 1024) throw Error('应用资源请求超过容量限制');
  }
  return bytes;
}
function stop(reason = Error('应用资源缓存已关闭')) {
  const old = worker; worker = null; clearTimeout(idle);
  for (const row of pending.values()) { clearTimeout(row.timer); row.reject(reason); }
  pending.clear(); pendingBytes = 0; return old?.terminate();
}
function request(input) {
  let size;
  try { size = inputSize(input); } catch (error) { return Promise.reject(error); }
  if (pendingBytes + size > 32 * 1024 * 1024) return Promise.reject(Error('应用资源传输繁忙，请稍后重试'));
  if (pending.size >= 64) return Promise.reject(Error('应用资源读取繁忙，请稍后重试'));
  if (!worker) {
    const current = worker = new Worker(path.join(__dirname, 'app-resource-cache-worker.cjs'));
    current.on('message', message => {
      if (worker !== current) return;
      const row = pending.get(message.id); if (!row) return;
      pending.delete(message.id); clearTimeout(row.timer);
      pendingBytes -= row.size;
      if (message.error) row.reject(Error(message.error)); else row.resolve(message.result);
      if (!pending.size) {
        current.unref();
        idle = setTimeout(() => stop(), 300000); idle.unref();
      }
    });
    current.on('error', error => { if (worker === current) void stop(error); });
    current.on('exit', () => { if (worker === current) void stop(); });
  }
  clearTimeout(idle); worker.ref();
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { void stop(Error('应用资源读取超时，请重试')); }, 15000);
    pendingBytes += size;
    pending.set(id, { resolve, reject, timer, size });
    try { worker.postMessage({ ...input, id }); } catch (error) { void stop(error); }
  });
}
module.exports = { request, close: stop };
