'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

function events() {
  const listeners = new Map();
  return {
    addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(handler); },
    removeEventListener(name, handler) { listeners.get(name)?.delete(handler); },
    dispatchEvent(event) { for (const handler of listeners.get(event.type) || []) handler(event); },
    listenerCount() { return [...listeners.values()].reduce((total, handlers) => total + handlers.size, 0); },
  };
}
function element() {
  const classes = new Set(), attributes = new Map();
  return { ...events(), nodeType: 1, isConnected: true, style: {}, value: '', selectionStart: 0,
    scrollTop: 0, scrollHeight: 740, innerHTML: '', children: [],
    classList: { add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name), toggle: (name, on) => on ? classes.add(name) : classes.delete(name) },
    setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name),
    getAttribute: name => attributes.get(name), appendChild(child) { this.children.push(child); },
    contains(target) { assert.equal(target.nodeType, 1); return target === this; },
  };
}
function fixture() {
  const input = element(), host = element(), frames = new Map(), observers = [];
  let reads = 0, frameId = 0;
  host.getBoundingClientRect = () => { reads++; return { left: 16, top: 480, bottom: 620, width: 700 }; };
  const context = { ...events(), innerWidth: 1000, innerHeight: 680,
    visualViewport: { ...events(), width: 1000, height: 680, offsetLeft: 0, offsetTop: 0 },
    document: { ...events(), createElement: element },
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
      observe() { this.active = true; }
      disconnect() { this.active = false; }
    },
  };
  context.window = context;
  for (const file of ['compose-candidate-navigation.js', 'panels-compose-skills.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8'), context);
  }
  const picker = context.ComposeSkills.create({ input, host, loading: false });
  picker.setItems(Array.from({ length: 14 }, (_, index) => ({ name: 'skill-' + index, selectable: true })));
  return { context, picker, input, host, frames, observers, reads: () => reads,
    open() { input.value = '#'; input.selectionStart = 1; input.dispatchEvent({ type: 'input' }); },
    flush() { const tasks = [...frames.values()]; frames.clear(); tasks.forEach(callback => callback()); } };
}

test('open skill menus coalesce viewport events and release all positioning observers on close', () => {
  const f = fixture();
  for (let round = 0; round < 100; round++) {
    f.open();
    assert.equal(f.context.listenerCount(), 2);
    assert.equal(f.context.visualViewport.listenerCount(), 2);
    assert.equal(f.observers.filter(observer => observer.active).length, 1);
    const before = f.reads();
    for (let index = 0; index < 100; index++) f.context.dispatchEvent({ type: 'resize', target: f.context });
    assert.equal(f.frames.size, 1);
    assert.equal(f.reads(), before);
    f.flush(); assert.equal(f.reads(), before + 1);
    f.context.dispatchEvent({ type: 'resize', target: f.context });
    f.picker.close();
    assert.equal(f.frames.size, 0);
    assert.equal(f.context.listenerCount(), 0);
    assert.equal(f.context.visualViewport.listenerCount(), 0);
    assert.equal(f.observers.filter(observer => observer.active).length, 0);
  }
});

test('scrolling the menu does not schedule a layout and a removed composer releases observers', () => {
  const f = fixture(); f.open();
  const menu = f.host.children[1];
  f.context.dispatchEvent({ type: 'scroll', target: menu });
  assert.equal(f.frames.size, 0);
  f.host.isConnected = false;
  f.observers[0].callback([]); f.flush();
  assert.equal(f.input.getAttribute('aria-expanded'), 'false');
  assert.equal(f.context.listenerCount(), 0);
  assert.equal(f.context.visualViewport.listenerCount(), 0);
  assert.equal(f.observers[0].active, false);
});

test('late catalog, loading and error updates cannot reopen a detached skill picker', () => {
  for (const update of [picker => picker.setItems([{ name: 'late-catalog', selectable: true }]),
    picker => picker.setLoading(true), picker => picker.setError('Unavailable')]) {
    const f = fixture(); f.open(); f.host.isConnected = false;
    update(f.picker);
    assert.equal(f.host.children[1].classList.contains('show'), false);
    assert.equal(f.input.getAttribute('aria-expanded'), 'false');
    assert.equal(f.context.listenerCount(), 0);
    assert.equal(f.context.visualViewport.listenerCount(), 0);
    assert.equal(f.observers.filter(observer => observer.active).length, 0);
    f.context.dispatchEvent({ type: 'resize', target: f.context });
    assert.equal(f.frames.size, 0);
  }
});

test('visual viewport changes bound the popup when an on-screen keyboard reduces available space', () => {
  const f = fixture(); f.open();
  Object.assign(f.context.visualViewport, { offsetTop: 240, offsetLeft: 30, height: 160, width: 390 });
  f.context.visualViewport.dispatchEvent({ type: 'resize', target: f.context.visualViewport }); f.flush();
  const style = f.host.children[1].style;
  assert.ok(parseFloat(style.left) >= 38);
  assert.ok(parseFloat(style.left) + parseFloat(style.width) <= 412);
  assert.ok(parseFloat(style.top) >= 248);
  assert.ok(parseFloat(style.top) + parseFloat(style.maxHeight) <= 392);
  f.picker.close();
});
