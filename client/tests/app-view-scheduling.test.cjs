'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const { attach } = require('../main/app-view-scheduling.cjs');
test('idle background views throttle, foreground/loading/Agent work stay awake, listeners are reclaimed', () => {
  const host = Object.assign(new EventEmitter(), { isDestroyed: () => false, isMinimized: () => minimized, isVisible: () => visible });
  let minimized = false, visible = true;
  const values = [];
  const view = { webContents: { isDestroyed: () => false, setBackgroundThrottling: value => values.push(value) } };
  const page = { view, startup: 'ready' }, item = { view, detachedWin: host, composer: { view, busy: false }, appTabs: { pages: new Map([['app', page]]) } };
  attach(item); assert.equal(values.at(-1), false);
  const count = values.length; item.schedule(); assert.equal(values.length, count, 'no redundant native writes');
  minimized = true; host.emit('minimize'); assert.equal(values.at(-1), true);
  item.composer.busy = true; item.schedule(); assert.equal(values.at(-1), false);
  item.composer.busy = false; page.startup = 'loading'; item.schedule(); assert.equal(values.at(-1), false);
  page.startup = 'ready'; item.schedule(); assert.equal(values.at(-1), true);
  minimized = false; host.emit('restore'); assert.equal(values.at(-1), false);
  visible = false; host.emit('hide'); assert.equal(values.at(-1), true);
  item.disposeScheduling(); assert.equal(host.listenerCount('minimize'), 0);
});
test('embedded app visibility follows workspace navigation rather than the shared host visibility', () => {
  let value;
  const host = Object.assign(new EventEmitter(), { isDestroyed: () => false, isMinimized: () => false });
  const view = { webContents: { isDestroyed: () => false, setBackgroundThrottling: next => { value = next; } } };
  const item = { embeddedHost: host, surfaceVisible: false, view, appTabs: { pages: new Map([['a', { view, startup: 'ready' }]]) } };
  attach(item); assert.equal(value, true);
  item.surfaceVisible = true; item.schedule(); assert.equal(value, false);
  item.disposeScheduling();
});
