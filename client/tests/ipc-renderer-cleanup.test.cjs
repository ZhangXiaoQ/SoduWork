'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const publication = require('../main/pi-session/event-publication');
const grants = require('../main/pi-session/app-mcp-grant.cjs');
const source = fs.readFileSync(path.join(__dirname, '../main/pi-session/ipc.js'), 'utf8');

test('failed renderer finalization cancels pending frames, unwires, and releases ownership without scheduling a retry', () => {
  const scheduled = [], timers = new Map(), frames = [], listeners = new Set();
  let cleared = 0, reset = 0, artifacts = 0;
  const owner = new EventEmitter();
  const handle = { ref: 'failed-ref', sessionId: 'failed-id', attachedWindow: owner,
    detached: false, ownerClosed() {},
    on(callback) { listeners.add(callback); return () => listeners.delete(callback); } };
  owner.on('closed', handle.ownerClosed);
  grants.bind(handle, undefined, 'fixture-app');
  const queue = publication.create((...args) => frames.push(args), { schedule: fn => scheduled.push(fn) });
  const stream = publication.createStreamScheduler((...args) => frames.push(args), {
    setTimer(fn) { const id = {}; timers.set(id, fn); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  const release = new Map([[handle.ref, 'release-timer']]);
  const context = vm.createContext({ _wired: new WeakMap(), _publicationQueue: queue, _sharedHistory: null,
    _streamTransport: stream, _releaseTimers: release,
    _uiWindow: { reset() { reset++; } }, artifactRuntime: { closeRef() { artifacts++; } },
    clearTimeout() { cleared++; }, _push() {}, _scheduleRelease() { throw Error('must not schedule release'); },
    require(name) { assert.equal(name, './app-mcp-grant.cjs'); return grants; } });
  for (const [start, end] of [
    ['function _clearRelease(', 'function _scheduleRelease('],
    ['function _wire(', 'function _bindUsage('],
    ['function _unwatchOwner(', 'function _detach('],
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
  context._wire({}, handle);
  assert.equal(listeners.size, 1);
  queue.push(handle.ref, { kind: 'status' }, {}, { handle });
  stream.push(handle.ref, { kind: 'block' }, {}, { handle });
  context._discardRenderer(handle);
  scheduled.forEach(fn => fn());
  [...timers.values()].forEach(fn => fn());
  assert.equal(frames.length, 0);
  assert.equal(listeners.size, 0);
  assert.equal(owner.listenerCount('closed'), 0);
  assert.equal(handle.attachedWindow, null);
  assert.equal(handle.detached, true);
  assert.equal(handle.ownerClosed, null);
  assert.equal(release.size, 0);
  assert.equal(timers.size, 0);
  assert.equal(cleared, 1);
  assert.equal(reset, 1);
  assert.equal(artifacts, 1);
  assert.equal(grants.nativePluginId(handle), '');
  context._wire({}, handle);
  assert.equal(listeners.size, 1, 'a retained live runtime can be wired again after an authorized reopen');
});
