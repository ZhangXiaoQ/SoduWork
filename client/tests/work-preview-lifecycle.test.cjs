'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path'), { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../main/work-preview.js'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture({ artifact, input, cleanup, location } = {}) {
  const handlers = {}, views = [], states = [], immediates = [], windows = [], external = [], sender = new EventEmitter();
  sender.id = 11; sender.isDestroyed = () => !!sender.dead; sender.send = (...args) => states.push(args);
  const host = { focusOrder: [], isDestroyed: () => !!host.dead, getContentBounds: () => ({ width: 800, height: 600 }),
    contentView: { addChildView() {}, removeChildView() {} },
    focus: () => { host.hostFocused = true; host.focusOrder.push('host'); } };
  class View {
    constructor() {
      const wc = new EventEmitter(); this.originalContents = this.webContents = wc; views.push(this);
      Object.assign(wc, { navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
        isDestroyed: () => !!wc.dead, getURL: () => wc.url || '', getTitle: () => 'Fixture', isLoading: () => false,
        focus: () => { host.webViewFocused = true; host.focusOrder.push('child'); },
        close: () => { wc.dead = true; this.webContents = undefined; wc.emit('destroyed'); },
        setWindowOpenHandler: fn => { wc.windowOpen = fn; },
        loadURL: url => { if (wc.dead) throw Error('Object has been destroyed'); wc.url = url; const d = deferred(); wc.loads.push(d); return d.promise; },
        loadFile: async () => {},
        loads: [], executeJavaScriptInIsolatedWorld: () => wc.injection.promise });
      wc.injection = deferred();
    }
    setBackgroundColor() {}
    setBorderRadius() {}
    #visible = false;
    #rect = { x: 0, y: 0, width: 0, height: 0 };
    setVisible(value) { (this.visibilityCalls ||= []).push(Boolean(value)); this.#visible = Boolean(value); }
    getVisible() { return this.#visible; }
    setBounds(rect) { this.#rect = { ...rect }; }
    getBounds() { return { ...this.#rect }; }
  }
  class Window extends EventEmitter {
    constructor() { super(); windows.push(this); this.contentView = { addChildView() {} }; }
    static fromWebContents() { return host; }
    setMenuBarVisibility() {}
    setBounds(bounds) { this.bounds = bounds; }
    getNativeWindowHandle() { throw Error('No native decoration in lifecycle fixture'); }
    isDestroyed() { return !!this.dead; }
    getContentBounds() { return { width: 1120, height: 780 }; }
    isVisible() { return !!this.visible; }
    isMinimized() { return false; }
    show() { this.visible = true; }
    focus() { this.focused = true; }
    destroy() { if (!this.dead) { this.dead = true; this.emit('closed'); } }
  }
  const module = { exports: {} };
  let session = { cwd: 'C:/fixture' };
  const requireModule = require('node:module').createRequire(path.join(__dirname, '../main/work-preview.js'));
  vm.runInNewContext(source, { module, exports: module.exports, URL, setTimeout, clearTimeout, setImmediate: fn => immediates.push(fn),
    require: name => name === './agent-runtime/pi-session-bridge' ? { get: () => session }
      : name === './conversation/artifact-runtime' ? { preview: () => artifact.promise, previewInput: () => input.promise, previewLocation: (ref, url) => location?.(ref, url) || '' }
      : requireModule(name) });
  module.exports.install({ ipcMain: { handle: (name, fn) => { handlers[name] = fn; },
    on: (name, fn) => { handlers[name] = (event, payload) => { fn(event, payload); return event.returnValue; }; } }, WebContentsView: View,
    session: { fromPartition: () => ({ on: () => {}, closeAllConnections: async () => {}, clearData: async () => cleanup?.promise, clearAuthCache: async () => {} }) },
    BrowserWindow: Window, shell: { openExternal: async url => { external.push(url); } } });
  const call = (name, payload) => handlers['work-preview-' + name]({ sender }, payload);
  const show = (patch = {}) => call('show', { tabId: 'tab', ref: 'session-a', url: 'https://fixture.test/a', bounds: { width: 400, height: 300 }, ...patch });
  const detached = (tabId, patch = {}) => call('show-detached', { tabId, url: 'https://fixture.test/app/' + tabId, label: tabId, ...patch });
  return { call, show, detached, views, windows, states, sender, host, immediates, external, replaceSession(value) { session = value; }, changeCwd(value) { session.cwd = value; } };
}

test('preview state distinguishes the displayed local file from its HTTP loading and external-browser URL', async t => {
  const artifact = deferred(), internal = 'http://127.0.0.1:9876/index.html';
  const f = fixture({ artifact, location: (ref, url) => ref === 'session-a' && url === internal ? 'file:///C:/fixture/index.html' : '' });
  t.after(() => f.call('destroy', ''));
  const pending = f.show({ kind: 'artifact', artifactId: 'site', url: undefined });
  artifact.resolve({ ok: true, url: internal });
  const result = await pending;
  assert.equal(result.state.url, internal);
  assert.equal(result.state.displayUrl, 'file:///C:/fixture/index.html');
  await f.call('command', { tabId: 'tab', action: 'external' });
  assert.deepEqual(f.external, [internal], 'system browser still opens the resource-compatible HTTP page');
  const navigated = await f.call('command', { tabId: 'tab', action: 'load', url: 'https://example.test/next' });
  assert.equal(navigated.state.url, 'https://example.test/next');
  assert.equal(navigated.state.displayUrl, '', 'external navigation cannot retain the previous local file label');
});

test('a URL-based running app never becomes a static file address merely because its origin has a known mapping', async t => {
  const url = 'http://127.0.0.1:9876/app/route?q=%23#section';
  const f = fixture({ location: () => 'file:///C:/fixture/index.html' });
  t.after(() => f.call('destroy', ''));
  const result = await f.show({ kind: 'url', url });
  assert.equal(result.state.url, url);
  assert.equal(result.state.displayUrl, '');
});

test('conversation cleanup preserves multiple detached apps and an individual close affects only that app', async t => {
  const f = fixture(); t.after(() => f.call('destroy', ''));
  await f.show(); const inline = f.views[0];
  assert.equal((await f.detached('one')).ok, true);
  assert.equal((await f.detached('two')).ok, true);
  const apps = f.views.filter(view => view.originalContents.getURL().includes('/app/'));
  f.call('reset-embedded');
  assert.equal(inline.originalContents.dead, true);
  assert.ok(f.windows.every(win => !win.isDestroyed()));
  assert.ok(apps.every(view => !view.originalContents.dead));
  for (let i = 0; i < 3; i++) {
    await f.show({ ref: 'conversation-' + i });
    f.call('hide'); f.call('reset-embedded');
    f.call('occlusion', { blocked: true }); f.call('occlusion', { blocked: false });
  }
  assert.ok(f.windows.every(win => !win.isDestroyed()));
  f.call('destroy', 'one');
  assert.equal(f.windows[0].isDestroyed(), true);
  assert.equal(f.windows[1].isDestroyed(), false);
  f.call('destroy', '');
  assert.equal(f.windows[1].isDestroyed(), true);
});

test('reopening the same app focuses its existing window without discarding page or composer', async t => {
  const f = fixture(); t.after(() => f.call('destroy', ''));
  await f.detached('one'); const originalViews = f.views.slice();
  f.views[0].originalContents.draft = 'unsaved app state';
  await f.detached('one');
  assert.equal(f.windows.length, 1);
  assert.deepEqual(f.views, originalViews);
  assert.equal(f.windows[0].focused, true);
  assert.equal(f.views[0].originalContents.draft, 'unsaved app state');
});

test('concurrent opens of the same app create only one window and retain the existing page', async t => {
  const f = fixture(); t.after(() => f.call('destroy', ''));
  const results = await Promise.all([f.detached('one'), f.detached('one'), f.detached('one')]);
  assert.equal(f.windows.length, 1);
  assert.equal(results.filter(result => result.reused).length, 2);
  assert.ok(results.every(result => result.ok));
});

test('a detached app awaiting session preparation survives inline cleanup but not owner teardown', async t => {
  for (const action of ['reset-embedded', 'destroy']) {
    const cleanup = deferred(), f = fixture({ cleanup }); t.after(() => f.call('destroy', ''));
    await f.show(); f.call('destroy', '');
    const pending = f.detached('pending');
    await flush(); f.call(action, ''); cleanup.resolve();
    const result = await pending;
    assert.equal(result.ok, action === 'reset-embedded');
    if (result.ok) assert.equal(f.windows[0].isDestroyed(), false);
  }
});

test('input HTTP preparation cannot revive a hidden view or continue under a replaced session', async () => {
  for (const mode of ['hide', 'session', 'cwd']) {
    const input = deferred(), f = fixture({ input });
    const opening = f.show({ kind: 'file', target: 'C:/fixture/input.html', url: undefined });
    await flush();
    if (mode === 'hide') f.call('hide'); else if (mode === 'session') f.replaceSession({ cwd: 'C:/fixture' });
    else f.changeCwd('C:/other');
    input.resolve({ ok: true, url: 'http://127.0.0.1:9999/input.html' });
    assert.equal((await opening).ok, false);
    assert.equal(f.views[0].getVisible(), false);
    assert.equal(f.views[0].originalContents.loads.length, 0);
  }
});
test('a removed preview never snapshots a missing WebContents after load rejects', async () => {
  const f = fixture(); assert.equal((await f.show()).ok, true); const old = f.views[0].originalContents;
  f.call('destroy', 'tab'); f.states.length = 0; old.loads[0].reject(Error('ERR_ABORTED fixture close'));
  await flush(); assert.equal(f.states.length, 0);
});
test('a closed item cannot publish state into a replacement with the same tab id', async () => {
  const f = fixture(); await f.show(); const old = f.views[0].originalContents;
  f.call('destroy', 'tab'); await f.show({ url: 'https://fixture.test/b' }); f.states.length = 0;
  old.emit('did-stop-loading'); old.emit('page-title-updated'); old.loads[0].reject(Error('old load failure'));
  await flush(); assert.equal(f.states.length, 0);
  f.views[1].originalContents.emit('page-title-updated'); assert.equal(f.states.length, 1);
});
test('artifact preparation completed after closing cannot revive or touch the old view', async () => {
  const artifact = deferred(), f = fixture({ artifact }); const opened = f.show({ kind: 'artifact', artifactId: 'a' });
  f.call('destroy', 'tab'); artifact.resolve({ ok: true, url: 'http://127.0.0.1:9999/artifact' });
  const result = await opened; assert.equal(result.ok, false); assert.match(result.reason, /关闭/);
  assert.equal(f.views[0].originalContents.loads.length, 0);
});
test('delayed window-open navigation is harmless after its owned view closes', async () => {
  const f = fixture(); await f.show(); const wc = f.views[0].originalContents;
  assert.equal(wc.windowOpen({ url: 'https://fixture.test/next' }).action, 'deny');
  f.call('destroy', 'tab'); assert.doesNotThrow(() => f.immediates.forEach(fn => fn()));
  wc.loads[0].resolve(); await flush();
});
test('late annotation injection is reported as closed and emits nothing after owner destruction', async () => {
  const f = fixture(); await f.show(); const wc = f.views[0].originalContents;
  const command = f.call('command', { tabId: 'tab', action: 'inspect', enabled: true });
  f.sender.dead = true; f.sender.emit('destroyed'); f.states.length = 0;
  wc.injection.reject(Error('Object has been destroyed')); wc.loads[0].reject(Error('aborted'));
  assert.equal((await command).ok, false); await flush(); assert.equal(f.states.length, 0);
});
test('entering inspector mode does not steal focus from the annotation editor', async () => {
  const f = fixture(); await f.show(); const wc = f.views[0].originalContents;
  const command = f.call('command', { tabId: 'tab', action: 'inspect', enabled: true });
  wc.injection.resolve(true);
  assert.equal((await command).ok, true);
  assert.equal(f.host.webViewFocused, undefined);
  assert.deepEqual(f.host.focusOrder, []);
});

test('content versions explicitly reload the same URL while ordinary layout updates preserve the page', async () => {
  const f = fixture(); await f.show(); const wc = f.views[0].originalContents;
  wc.loads[0].resolve(); await flush();
  for (let i = 0; i < 10; i++) await f.show();
  assert.equal(wc.loads.length, 1);
  assert.equal((await f.show({ reload: true })).ok, true);
  assert.equal(wc.loads.length, 2);
  wc.loads[1].resolve(); await flush();
  await f.show(); assert.equal(wc.loads.length, 2);
  assert.deepEqual(f.host.focusOrder, []);
});
test('a live preview still exposes genuine load errors and invalid navigation remains rejected', async () => {
  const f = fixture(); await f.show(); const wc = f.views[0].originalContents;
  wc.loads[0].reject(Error('ERR_CONNECTION_REFUSED fixture')); await flush();
  assert.match(f.states.at(-1)[1].error, /ERR_CONNECTION_REFUSED/);
  const bad = await f.call('command', { tabId: 'tab', action: 'load', url: 'javascript:bad()' }); assert.equal(bad.ok, false);
});
test('an older navigation failure cannot overwrite a later successful navigation', async () => {
  const f = fixture(); await f.show(); const wc = f.views[0].originalContents;
  await f.call('command', { tabId: 'tab', action: 'load', url: 'https://fixture.test/b' });
  wc.loads[1].resolve(); wc.emit('did-stop-loading'); f.states.length = 0;
  wc.loads[0].reject(Error('old navigation aborted')); await flush(); assert.equal(f.states.length, 0);
});
test('late artifact preparation cannot override a newer show for the same live tab', async () => {
  const artifact = deferred(), f = fixture({ artifact });
  const old = f.show({ kind: 'artifact', artifactId: 'a' });
  assert.equal((await f.show({ url: 'https://fixture.test/new' })).ok, true);
  artifact.resolve({ ok: true, url: 'http://127.0.0.1:9999/old' });
  const reply = await old; assert.equal(reply.ok, false); assert.match(reply.reason, /切换/);
  const wc = f.views[0].originalContents; assert.equal(wc.loads.length, 1); assert.equal(wc.url, 'https://fixture.test/new');
  wc.loads[0].resolve();
});
test('an inspector error from a live page is returned instead of being swallowed', async () => {
  const f = fixture(); await f.show(); const wc = f.views[0].originalContents;
  const command = f.call('command', { tabId: 'tab', action: 'inspect', enabled: true });
  wc.injection.reject(Error('live isolated-world execution failed'));
  const reply = await command; assert.equal(reply.ok, false); assert.match(reply.reason, /live isolated-world execution failed/);
  wc.loads[0].resolve();
});
test('a destroyed WebContents still referenced by its view is rejected and may be recreated', async () => {
  const f = fixture(); await f.show(); const wc = f.views[0].originalContents;
  wc.dead = true;
  assert.equal((await f.call('command', { tabId: 'tab', action: 'inspect' })).ok, false);
  assert.equal((await f.show({ url: 'https://fixture.test/reopened' })).ok, true);
  assert.equal(f.views.length, 2); wc.loads[0].resolve(); f.views[1].originalContents.loads[0].resolve();
});

test('modal occlusion persists across show and bounds updates, restoring once without focus calls', async () => {
  const f = fixture(); await f.show(); const view = f.views[0];
  f.call('occlusion', { blocked: true });
  const hidden = view.visibilityCalls.length;
  for (let i = 0; i < 20; i++) {
    await f.show(); f.call('bounds', { tabId: 'tab', bounds: { x: i, width: 400, height: 300 } });
    f.call('occlusion', { blocked: true });
  }
  assert.equal(view.getVisible(), false); assert.equal(view.visibilityCalls.length, hidden);
  f.call('occlusion', { blocked: false });
  assert.equal(view.getVisible(), true); assert.equal(view.visibilityCalls.length, hidden + 1);
  assert.deepEqual(f.host.focusOrder, []);
  view.originalContents.loads[0].resolve();
});

test('an awaited artifact cannot reappear after hide and late bounds cannot revive it', async () => {
  const artifact = deferred(), f = fixture({ artifact });
  const pending = f.show({ kind: 'artifact', artifactId: 'slow' });
  f.call('hide'); artifact.resolve({ ok: true, url: 'http://127.0.0.1:9999/slow' });
  assert.equal((await pending).ok, false);
  f.call('bounds', { tabId: 'tab', bounds: { width: 400, height: 300 } });
  assert.equal(f.views[0].getVisible(), false);
  assert.equal(f.views[0].originalContents.loads.length, 0);
});

test('a modal that opens during artifact preparation still hides the completed view until it closes', async () => {
  const artifact = deferred(), f = fixture({ artifact });
  const pending = f.show({ kind: 'artifact', artifactId: 'slow' });
  f.call('occlusion', { blocked: true }); artifact.resolve({ ok: true, url: 'http://127.0.0.1:9999/slow' });
  assert.equal((await pending).ok, true); assert.equal(f.views[0].getVisible(), false);
  f.call('occlusion', { blocked: false }); assert.equal(f.views[0].getVisible(), true);
  f.views[0].originalContents.loads[0].resolve();
});

test('a native plugin dialog may own a browser while nested confirmation hides every child', async () => {
  const f = fixture(); await f.show();
  f.call('occlusion', { blocked: true, allowedTabs: ['plugin'] });
  await f.show({ tabId: 'plugin', url: 'https://fixture.test/plugin' });
  await f.show();
  assert.deepEqual(f.views.map(v => v.getVisible()), [false, true]);
  f.call('occlusion', { blocked: true }); assert.deepEqual(f.views.map(v => v.getVisible()), [false, false]);
  f.call('occlusion', { blocked: true, allowedTabs: ['plugin'] });
  assert.deepEqual(f.views.map(v => v.getVisible()), [false, true]);
  f.call('destroy', 'plugin'); f.call('occlusion', { blocked: false });
  assert.equal(f.views[0].getVisible(), true);
  f.views.forEach(v => v.originalContents.loads[0].resolve());
});

test('chat reset cannot clear document occlusion and closing while occluded cannot reopen the panel', async () => {
  const f = fixture(); await f.show(); f.call('occlusion', { blocked: true });
  f.call('destroy', ''); await f.show({ tabId: 'next' });
  assert.equal(f.views[1].getVisible(), false);
  f.call('hide'); f.call('occlusion', { blocked: false });
  assert.equal(f.views[1].getVisible(), false);
  f.views.forEach(v => v.originalContents.loads[0].resolve());
});

test('an older different-tab artifact preparation cannot steal the newly selected browser', async () => {
  const artifact = deferred(), f = fixture({ artifact });
  const pending = f.show({ kind: 'artifact', artifactId: 'slow' });
  await f.show({ tabId: 'chosen' });
  artifact.resolve({ ok: true, url: 'http://127.0.0.1:9999/slow' });
  assert.equal((await pending).ok, false);
  assert.deepEqual(f.views.map(v => v.getVisible()), [false, true]);
  f.views[1].originalContents.loads[0].resolve();
});

test('synchronous suppression and document occlusion must both clear before restoring a view', async () => {
  for (const first of ['suppress', 'occlusion']) {
    const f = fixture(); await f.show(); const view = f.views[0];
    assert.equal(f.call('suppress', true).ok, true);
    f.call('occlusion', { blocked: true });
    const calls = view.visibilityCalls.length;
    for (let i = 0; i < 10; i++) {
      f.call('suppress', true); await f.show();
      f.call('bounds', { tabId: 'tab', bounds: { width: 400, height: 300 } });
    }
    assert.equal(view.getVisible(), false);
    assert.equal(view.visibilityCalls.length, calls);
    f.call(first, first === 'suppress' ? false : { blocked: false });
    assert.equal(view.getVisible(), false);
    f.call(first === 'suppress' ? 'occlusion' : 'suppress', first === 'suppress' ? { blocked: false } : false);
    assert.equal(view.getVisible(), true);
    assert.equal(view.visibilityCalls.length, calls + 1);
    assert.deepEqual(f.host.focusOrder, []);
    view.originalContents.loads[0].resolve();
  }
});

test('suppression survives owner reset and clearing it cannot reopen a hidden or zero-size view', async () => {
  for (const mode of ['hide', 'empty-bounds']) {
    const f = fixture(); await f.show(); f.call('suppress', true);
    f.call('destroy', ''); await f.show({ tabId: 'next' });
    assert.equal(f.views[1].getVisible(), false);
    if (mode === 'hide') f.call('hide');
    else f.call('bounds', { tabId: 'next', bounds: { width: 0, height: 0 } });
    f.call('suppress', false);
    assert.equal(f.views[1].getVisible(), false);
    f.views.forEach(v => v.originalContents.loads[0].resolve());
  }
});

test('a synchronous confirmation also suppresses a browser otherwise allowed inside a plugin dialog', async () => {
  const f = fixture(); await f.show();
  f.call('occlusion', { blocked: true, allowedTabs: ['plugin'] });
  await f.show({ tabId: 'plugin', url: 'https://fixture.test/plugin' });
  f.call('suppress', true);
  f.call('occlusion', { blocked: true });
  await f.show();
  f.call('occlusion', { blocked: true, allowedTabs: ['plugin'] });
  assert.deepEqual(f.views.map(v => v.getVisible()), [false, false]);
  f.call('suppress', false);
  assert.deepEqual(f.views.map(v => v.getVisible()), [false, true]);
  f.call('destroy', 'plugin'); f.call('occlusion', { blocked: false });
  assert.equal(f.views[0].getVisible(), true);
  f.views.forEach(v => v.originalContents.loads[0].resolve());
});

const invalidateDocument = (f, reason) => reason === 'reload'
  ? f.sender.emit('did-start-navigation', {}, 'file:///fixture/desk.html', false, true)
  : f.sender.emit('render-process-gone', {}, { reason: 'crashed' });

for (const reason of ['reload', 'crash']) {
  test(`owner ${reason} destroys previews and menu closing cannot restore the previous document`, async () => {
    const f = fixture(); await f.show(); const view = f.views[0], wc = view.originalContents;
    f.call('occlusion', { blocked: true }); f.call('suppress', true);
    invalidateDocument(f, reason);
    assert.equal(wc.isDestroyed(), true);
    assert.equal(view.getVisible(), false);
    f.states.length = 0;
    wc.loads[0].reject(Error('aborted old document'));
    wc.emit('did-stop-loading'); await flush();
    assert.equal(f.states.length, 0);
    f.call('occlusion', { blocked: false });
    assert.equal(view.getVisible(), false);
    assert.equal((await f.show({ tabId: 'new-document' })).ok, true);
    assert.equal(f.views[1].getVisible(), true, 'new document does not inherit old suppression');
    f.views[1].originalContents.loads[0].resolve(); f.call('destroy', '');
  });

  test(`owner ${reason} invalidates pending artifact preparation`, async () => {
    const artifact = deferred(), f = fixture({ artifact });
    const pending = f.show({ kind: 'artifact', artifactId: 'pending' }); await flush();
    invalidateDocument(f, reason);
    artifact.resolve({ ok: true, url: 'https://fixture.test/late' });
    assert.equal((await pending).ok, false);
    assert.equal(f.views[0].originalContents.isDestroyed(), true);
    assert.equal(f.views[0].originalContents.loads.length, 0);
  });

  test(`owner ${reason} while waiting for a session lease cannot allocate a late child view`, async () => {
    const cleanup = deferred(), f = fixture({ cleanup }); await f.show();
    f.views[0].originalContents.loads[0].resolve();
    f.call('destroy', ''); await flush();
    const pending = f.show({ tabId: 'waiting' }); await flush();
    assert.equal(f.views.length, 1, 'session cleanup must finish before creating a new view');
    invalidateDocument(f, reason); cleanup.resolve();
    assert.equal((await pending).ok, false);
    assert.equal(f.views.length, 1);
    assert.equal((await f.show({ tabId: 'fresh' })).ok, true);
    assert.equal(f.views.length, 2);
    f.views[1].originalContents.loads[0].resolve(); f.call('destroy', '');
  });
}

test('subframe and same-document navigation preserve the live preview and current modal state', async () => {
  const f = fixture(); await f.show(); const view = f.views[0], wc = view.originalContents;
  f.call('occlusion', { blocked: true }); f.call('suppress', true);
  f.sender.emit('did-start-navigation', {}, 'https://fixture.test/frame', false, false);
  f.sender.emit('did-start-navigation', {}, 'file:///fixture/desk.html#section', true, true);
  assert.equal(wc.isDestroyed(), false); assert.equal(view.getVisible(), false);
  f.call('occlusion', { blocked: false }); assert.equal(view.getVisible(), false);
  f.call('suppress', false); assert.equal(view.getVisible(), true);
  assert.equal(wc.loads.length, 1);
  wc.loads[0].resolve(); f.call('destroy', '');
});

test('document invalidation clears modal state even between disposed and newly created chat owners', async () => {
  const f = fixture(); await f.show(); f.views[0].originalContents.loads[0].resolve();
  f.call('occlusion', { blocked: true }); f.call('suppress', true); f.call('destroy', '');
  invalidateDocument(f, 'reload');
  assert.equal((await f.show({ tabId: 'new-document' })).ok, true);
  assert.equal(f.views[1].getVisible(), true);
  f.views[1].originalContents.loads[0].resolve(); f.call('destroy', '');
});

test('repeated chat reset and document reload keep only one renderer lifecycle observer', async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) {
    await f.show(); f.views.at(-1).originalContents.loads[0].resolve();
    assert.equal(f.sender.listenerCount('did-start-navigation'), 1);
    assert.equal(f.sender.listenerCount('render-process-gone'), 1);
    if (i % 2) invalidateDocument(f, 'reload'); else f.call('destroy', '');
    assert.equal(f.sender.listenerCount('destroyed'), 0, 'disposed owners release their own cleanup listener');
  }
});


test('explicitly opening an upgraded app replaces old UI; reopening the same version preserves its live window',async t=>{
 const f=fixture();t.after(()=>f.call('destroy',''));
 assert.equal((await f.detached('versioned',{appVersion:'1.0.0'})).ok,true);const first=f.windows.at(-1);
 assert.equal((await f.detached('versioned',{appVersion:'1.0.0'})).reused,true);assert.equal(f.windows.at(-1),first);
 assert.equal((await f.detached('versioned',{appVersion:'1.0.1'})).reused,undefined);assert.equal(first.dead,true);assert.notEqual(f.windows.at(-1),first);
});
