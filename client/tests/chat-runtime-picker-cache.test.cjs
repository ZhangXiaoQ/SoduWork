'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, handler, options = {}) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({ handler, signal: options.signal }); this.listeners.set(type, listeners);
  }
  fire(type, extra = {}) {
    const event = { type, target: this, stopPropagation() {}, preventDefault() {}, ...extra };
    return Promise.all((this.listeners.get(type) || []).filter(row => !row.signal?.aborted)
      .map(row => row.handler(event)));
  }
}
class Element extends Target {
  constructor(tag = 'div') {
    super(); this.tagName = tag; this.children = []; this.parentNode = null;
    this.attributes = {}; this.dataset = {}; this.hidden = false; this.style = {};
    this.className = ''; this.text = '';
    this.classList = {
      add: name => { this.className += ' ' + name; },
      remove: name => { this.className = this.className.split(' ').filter(value => value !== name).join(' '); },
      toggle: (name, active) => active ? this.classList.add(name) : this.classList.remove(name),
    };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set disabled(value) { this._disabled = Boolean(value); }
  get disabled() { return Boolean(this._disabled); }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  appendChild(child) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
  replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.text = ''; this.append(...children); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  after(child) {
    child.remove(); child.parentNode = this.parentNode;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this) + 1, 0, child);
  }
  contains(child) { return this === child || this.children.some(node => node.contains(child)); }
  matches(selector) {
    if (selector === '[data-runtime]') return Boolean(this.dataset.runtime);
    if (selector === '[role=status]') return this.attributes.role === 'status';
    if (selector.startsWith('#')) return this.attributes.id === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    return this.tagName === selector;
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector); }
  focus() {}
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const inventory = (id = 'opencode', extra = {}) => {
  const runtimes = ['pi', id].map((key, index) => ({ id: key, displayName: key, order: index + 1, availability: { ok: true } }));
  return { ok: true, runtimes, availableRuntimes: runtimes, missing: [], ...extra };
};
function fixture(t, initial = {}) {
  const state = { ref: 'chat-a', adapterId: 'pi', ...initial }, calls = [], projections = [], selections = [], notices = [];
  let now = 100000, owner = 'hub-a/device-a/user-a', locale = '', notify;
  const root = new Element(), button = new Element('button'), missingWrap = new Element(), missing = new Element(), more = new Element('button');
  for (const [node, id] of [[button, 'nchatRuntime'], [missingWrap, 'nchatRuntimeAvailability'], [missing, 'nchatRuntimeMissing'], [more, 'nchatRuntimeMore']]) node.setAttribute('id', id);
  missingWrap.append(missing, more); root.append(button, missingWrap);
  const context = new Target(), document = new Target(); document.createElement = tag => new Element(tag);
  const load = (ref, options, draft = false) => {
    const pending = deferred(); calls.push({ ref, options, draft, ...pending }); return pending.promise;
  };
  const selection = deferred(), selectionResponses = [];
  Object.assign(context, { AbortController, document, setTimeout,
    Date: class extends Date { static now() { return now; } },
    SoduWorkAPI: { taskStorageKey: () => owner },
    SoduWorkI18n: { translateText: value => locale + value },
    WorkComposer: { placeRuntime() {} },
    soduWorkAPI: { conversationSession: {
      conversationRuntimes: (ref, options) => load(ref, options),
      onRuntimesChanged: callback => { notify = callback; return () => { notify = null; }; },
      selectAgent: (ref, id) => {
        selections.push({ ref, id });
        const pending = selectionResponses.length ? deferred() : selection;
        selectionResponses.push(pending); return pending.promise;
      },
    } },
  });
  context.window = context;
  vm.runInNewContext(fs.readFileSync(require.resolve('../components/panels/chat-runtime-picker.js'), 'utf8'), context);
  const selected = [];
  const picker = context.ChatRuntimePicker.create(root, {
    state: () => state, say: value => notices.push(value), runtimeAvailability: value => projections.push(value),
    runtimeSelected: value => selected.push(value),
    draft: { runtimes: force => load(state.draftId, force ? { force: true } : undefined, true),
      selectRuntime: id => ({ ok: true, adapterId: id }) },
  });
  t.after(() => picker.destroy());
  const pop = root.querySelector('.nchat-runtime-pop');
  return { picker, state, button, pop, calls, projections, selections, selection, selectionResponses, selected, notices, context,
    click: () => button.fire('click'), notify: () => notify?.(),
    owner(value) { owner = value; }, clock(value) { now = value; }, locale(value) { locale = value; },
    choose: id => pop.fire('click', { target: pop.querySelectorAll('[data-runtime]').find(row => row.dataset.runtime === id) }),
  };
}

test('prefetched inventory opens immediately and 1000 repeated opens reuse one non-forced read', async t => {
  const f = fixture(t); f.picker.render(); await settle();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options, undefined);
  f.calls[0].resolve(inventory()); await settle();
  for (let i = 0; i < 1000; i++) {
    const open = f.click();
    assert.equal(f.pop.hidden, false);
    assert.equal(f.pop.querySelectorAll('[data-runtime]').length, 2, 'cached rows paint before awaiting a request');
    assert.doesNotMatch(f.pop.textContent, /正在读取/);
    await open; await f.click();
  }
  assert.equal(f.calls.length, 1); assert.equal(f.projections.length, 1);
});

test('closing and reopening during preload joins the same request and retains its hidden result', async t => {
  const f = fixture(t); f.picker.render(); await settle();
  const first = f.click(); await settle(); await f.click();
  const second = f.click(); await settle(); await f.click();
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve(inventory()); await Promise.all([first, second]);
  assert.equal(f.pop.hidden, true); assert.equal(f.projections.length, 1);
  const reopen = f.click(); assert.equal(f.pop.querySelectorAll('[data-runtime]').length, 2); await reopen;
  assert.equal(f.calls.length, 1);
});

test('host checkedAt bounds freshness and expiry reuses normal host cache semantics', async t => {
  const f = fixture(t); const first = f.click(); await settle();
  f.calls[0].resolve(inventory('opencode', { checkedAt: 75000 })); await first; await f.click();
  f.clock(104999); await f.click(); await f.click(); assert.equal(f.calls.length, 1);
  f.clock(105000); const expired = f.click(); await settle();
  assert.match(f.pop.textContent, /正在读取/); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].options, undefined, 'TTL expiry must not force all runtime probes');
  f.calls[1].resolve(inventory('codex')); await expired;
  assert.deepEqual(f.pop.querySelectorAll('[data-runtime]').map(row => row.dataset.runtime), ['pi', 'codex']);
});

test('explicit refresh invalidates fresh results and bursts during a probe require one serialized fresh pass', async t => {
  const f = fixture(t); const open = f.click(); await settle();
  for (let i = 0; i < 500; i++) f.notify();
  await settle(); assert.equal(f.calls.length, 1, 'notifications cannot start parallel probes');
  f.calls[0].resolve(inventory('opencode')); await settle();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].options.force, true);
  assert.equal(f.projections.length, 0, 'a read predating a runtime change cannot restore availability');
  f.calls[1].resolve(inventory('codex')); await open; await settle();
  assert.deepEqual(f.pop.querySelectorAll('[data-runtime]').map(row => row.dataset.runtime), ['pi', 'codex']);
  f.notify(); await settle(); assert.equal(f.calls.length, 3); assert.equal(f.calls[2].options.force, true);
  assert.equal(f.pop.querySelectorAll('[data-runtime]').length, 0);
  f.calls[2].resolve(inventory('qwen')); await settle();
});

test('a change during a failed probe is still refreshed and hidden invalidation stays lazy', async t => {
  const f = fixture(t); const open = f.click(); await settle(); f.notify();
  f.calls[0].reject(Error('old connection failed')); await settle();
  assert.equal(f.calls.length, 2); f.calls[1].resolve(inventory()); await open; await settle(); await f.click();
  f.notify(); await settle(); assert.equal(f.calls.length, 2);
  const next = f.click(); await settle(); assert.equal(f.calls.length, 3); assert.equal(f.calls[2].options.force, true);
  f.calls[2].resolve(inventory()); await next;
});

test('account, Hub and device changes close cached rows immediately and reject late responses', async t => {
  for (const owner of ['hub-a/device-a/user-b', 'hub-b/device-a/user-a', 'hub-a/device-b/user-a']) {
    const f = fixture(t); const old = f.click(); await settle();
    f.owner(owner); await f.context.fire('soduwork-data-scope-changed');
    assert.equal(f.pop.hidden, true);
    const current = f.click(); await settle(); assert.equal(f.calls.length, 2);
    f.calls[1].resolve(inventory('codex')); await current;
    f.calls[0].resolve(inventory('opencode')); await old;
    assert.equal(f.projections.length, 1);
    assert.deepEqual(f.pop.querySelectorAll('[data-runtime]').map(row => row.dataset.runtime), ['pi', 'codex']);
    f.picker.destroy();
  }
});

test('returning to the same owner cannot revive or duplicate an older in-flight read', async t => {
  const f = fixture(t); const old = f.click(); await settle();
  f.owner('hub-a/device-a/user-b'); await f.context.fire('soduwork-data-scope-changed');
  f.owner('hub-a/device-a/user-a'); await f.context.fire('soduwork-device-auth');
  const current = f.click(); await settle();
  f.calls[0].resolve(inventory('opencode')); await old; await settle();
  assert.equal(f.calls.length, 2); assert.equal(f.projections.length, 0);
  f.calls[1].resolve(inventory('codex')); await current;
  assert.equal(f.projections.length, 1);
});

test('session, local-to-cloud and cloud-runner changes never reuse the previous inventory', async t => {
  const f = fixture(t);
  const changes = [() => {}, () => { f.state.ref = 'chat-b'; },
    () => { f.state.cloudHandoff = { phase: 'committed', transferId: 'transfer-a', ref: 'remote-a', target: { runnerId: 'runner-a' } }; },
    () => { f.state.cloudHandoff.target.runnerId = 'runner-b'; },
    () => { f.state.cloudHandoff.transferId = 'transfer-b'; },
    () => { f.state.cloudHandoff = null; }];
  for (let i = 0; i < changes.length; i++) {
    changes[i](); f.picker.render(); const open = f.click(); await settle();
    assert.equal(f.calls.length, i + 1); f.calls[i].resolve(inventory()); await open; await f.click();
  }
});

test('failed reads remain retryable and destroy suppresses late availability callbacks', async t => {
  const f = fixture(t); const first = f.click(); await settle();
  f.calls[0].resolve({ ok: false, reason: 'fixture unavailable' }); await first;
  assert.match(f.pop.textContent, /fixture unavailable/); await f.click();
  const next = f.click(); await settle(); assert.equal(f.calls.length, 2);
  f.calls[1].reject(Error('fixture network error')); await next;
  assert.match(f.pop.textContent, /fixture network error/); await f.click();
  const last = f.click(); await settle(); const before = f.projections.length;
  f.picker.destroy(); f.calls[2].resolve(inventory()); await last;
  assert.equal(f.projections.length, before); assert.equal(f.pop.hidden, true);
});

test('draft inventory shares reads but resets when the draft identity changes', async t => {
  const f = fixture(t, { ref: '', draftOnly: true, draftId: 'draft-a' });
  f.picker.render(); const first = f.click(); await settle();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].draft, true);
  f.calls[0].resolve(inventory()); await first; await f.click(); await f.click(); await f.click();
  assert.equal(f.calls.length, 1);
  f.state.draftId = 'draft-b'; f.picker.render(); const next = f.click(); await settle();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].ref, 'draft-b');
  f.calls[1].resolve(inventory()); await next;
});

test('locale and same-owner auth renewal retain cached inventory without a readiness probe', async t => {
  const f = fixture(t); const first = f.click(); await settle(); f.calls[0].resolve(inventory()); await first;
  f.locale('translated:'); await f.context.fire('soduwork-locale-change');
  assert.match(f.pop.textContent, /translated:选择执行底座/);
  await f.context.fire('soduwork-device-auth'); assert.equal(f.pop.hidden, false);
  await f.click(); await f.click(); assert.equal(f.calls.length, 1);
});

test('cached choices still require authoritative selection and do not apply after an owner change', async t => {
  const f = fixture(t); const first = f.click(); await settle(); f.calls[0].resolve(inventory()); await first;
  await f.choose('opencode'); assert.deepEqual(f.selections, [{ ref: 'chat-a', id: 'opencode' }]);
  const waiting = f.picker.wait(); f.owner('hub-a/device-a/user-b');
  await f.context.fire('soduwork-data-scope-changed');
  f.selection.resolve({ ok: true, adapterId: 'opencode' }); await waiting;
  assert.equal(f.selected.length, 0); assert.equal(f.pop.hidden, true);
});

test('authoritative selection failures and busy recovery keep the existing conversation unchanged', async t => {
  const f = fixture(t); const first = f.click(); await settle(); f.calls[0].resolve(inventory()); await first;
  await f.choose('opencode'); f.selection.resolve({ ok: false, reason: 'runtime unavailable now' });
  assert.equal(await f.picker.wait(), false); assert.equal(f.selected.length, 0);
  assert.match(f.pop.textContent, /runtime unavailable now/); await f.click();
  f.state.busy = true; f.state.recoveryRequired = true; f.state.recoveryReason = 'fixture recovery required';
  await f.click(); assert.equal(f.pop.hidden, true); assert.equal(f.calls.length, 1);
  assert.match(f.notices[0], /fixture recovery required/);
});

test('an old selection cannot release a newer selection after switching accounts away and back', async t => {
  const f = fixture(t); const first = f.click(); await settle(); f.calls[0].resolve(inventory()); await first;
  await f.choose('opencode'); const oldSelection = f.picker.wait();
  f.owner('hub-a/device-a/user-b'); await f.context.fire('soduwork-data-scope-changed');
  f.owner('hub-a/device-a/user-a'); await f.context.fire('soduwork-data-scope-changed');
  const next = f.click(); await settle(); f.calls[1].resolve(inventory()); await next;
  await f.choose('opencode'); const currentSelection = f.picker.wait();
  f.selection.resolve({ ok: true, adapterId: 'opencode' }); await oldSelection;
  assert.equal(f.selected.length, 0); assert.equal(f.button.disabled, true);
  assert.strictEqual(f.picker.wait(), currentSelection);
  f.selectionResponses[1].resolve({ ok: true, adapterId: 'opencode' }); await currentSelection;
  assert.equal(f.selected.length, 1); assert.equal(f.button.disabled, false);
});
