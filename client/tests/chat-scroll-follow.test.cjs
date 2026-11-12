'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '../components/panels/chat-scroll-follow.js'), 'utf8');

function setup() {
  const frames = [];
  let nextFrame = 1;
  let resizeCallback = null;
  const listeners = [];
  const observed = new Set();
  const rect = { left: 100, right: 916, top: 100, bottom: 500, width: 816, height: 400 };
  const style = { borderLeftWidth: '0px', borderRightWidth: '0px', direction: 'ltr', scrollbarWidth: 'auto' };
  const scrollbarStyle = { width: '5px', display: 'block' };
  const button = {
    hidden: true,
    remove() { this.removed = true; },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(type, fn) { listeners.push([type, fn]); },
    removeEventListener() {},
  };
  const scroll = {
    offsetWidth: 816,
    clientWidth: 800,
    clientLeft: 0,
    clientHeight: 400,
    scrollHeight: 800,
    isConnected: true,
    _top: 0,
    writes: [],
    attrs: {},
    attributeWrites: [],
    getAttribute(name) { return this.attrs[name] ?? null; },
    setAttribute(name, value) { this.attributeWrites.push([name, value]); this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    get scrollTop() { return this._top; },
    set scrollTop(value) { this._top = Number(value); this.writes.push(this._top); },
    getBoundingClientRect() { return { ...rect }; },
    addEventListener(type, fn) { listeners.push([type, fn]); },
    removeEventListener() {},
  };
  const list = { children: [], querySelector(selector) {
    return this.children.find(node => selector === '[data-chat-node="' + node.key + '"]') || null;
  } };
  const area = { insertBefore() {}, querySelector() { return null; } };
  const el = {
    querySelector(selector) {
      if (selector === '#nchatScroll') return scroll;
      if (selector === '#nchatList') return list;
      if (selector === '.nchat-content-area') return area;
      if (selector === '.nchat-collab-slot') return null;
      return null;
    },
  };
  const sandbox = {
    console,
    addEventListener(type, fn) { listeners.push([type, fn]); },
    removeEventListener() {},
    getComputedStyle(_target, pseudo) { return pseudo ? scrollbarStyle : style; },
    document: { createElement: () => button },
    requestAnimationFrame(fn) { const id = nextFrame++; frames.push([id, fn]); return id; },
    cancelAnimationFrame(id) {
      const index = frames.findIndex(item => item[0] === id);
      if (index >= 0) frames.splice(index, 1);
    },
    ResizeObserver: class {
      constructor(fn) { resizeCallback = fn; }
      observe(node) { observed.add(node); }
      unobserve(node) { observed.delete(node); }
      disconnect() { observed.clear(); }
    },
    setTimeout,
    clearTimeout,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'chat-scroll-follow.js' });
  const ctx = { _ref: 'test-ref', _mount: () => el };
  const state = sandbox.ChatScrollFollow.create(ctx);
  return {
    state, ctx, el, scroll, list, button, frames, rect, style, scrollbarStyle, observed,
    emit(type, event = {}) { listeners.filter(row => row[0] === type).forEach(row => row[1](event)); },
    flushFrame() { const item = frames.shift(); if (item) item[1](); },
    resize() { if (resizeCallback) resizeCallback(); },
  };
}

function readingView() {
  const view = setup();
  view.node = (key, offset, height = 160) => ({
    key, offset, height, style: {},
    getAttribute(name) { return name === 'data-chat-node' ? this.key : null; },
    getBoundingClientRect() {
      const top = 100 + this.offset - view.scroll.scrollTop;
      return { top, bottom: top + this.height, height: this.height };
    },
  });
  view.scroll.scrollHeight = 1200; view.scroll._top = 400;
  view.list.children = [view.node('message:0', 0, 100), view.node('message:1', 380), view.node('message:2', 540)];
  view.follow = view.state._ensureScrollFollow(view.el);
  view.emit('wheel', { deltaY: -24 });
  return view;
}

test('bottom following coalesces scroll writes into one paint', () => {
  const view = setup();
  const follow = view.state._ensureScrollFollow(view.el);
  view.scroll.scrollTop = 100;
  view.scroll.writes.length = 0;

  view.state._followLatest(follow);
  view.state._followLatest(follow);
  assert.equal(view.scroll.writes.length, 0, 'follow should not write during the render stack');
  assert.equal(view.frames.length, 1, 'multiple follow requests share one frame');

  view.flushFrame();
  assert.deepEqual(view.scroll.writes, [400], 'scrollTop uses the actual max scroll offset');
  view.state._followLatest(follow);
  view.flushFrame();
  assert.deepEqual(view.scroll.writes, [400], 'already-at-bottom does not write again');
});

test('reading restoration pauses follow policy and cancels an already queued bottom correction', () => {
  const view = setup(), follow = view.state._ensureScrollFollow(view.el);
  view.state._followLatest(follow);
  assert.equal(view.frames.length, 1);
  follow.pause();
  assert.equal(follow.follow, false);
  assert.equal(view.scroll.attrs['data-scroll-follow'], 'paused');
  assert.equal(view.frames.length, 0);
  view.state._releaseScrollFollow();
});

test('following writes its initial policy once and repeated intents do not invalidate the transcript', () => {
  const view = setup(), state = view.state._ensureScrollFollow(view.el);
  assert.deepEqual(view.scroll.attributeWrites, [['data-scroll-follow', 'latest']]);
  view.state._followLatest(state); view.state._followLatest(state);
  assert.equal(view.scroll.attributeWrites.length, 1);
  assert.equal(view.frames.length, 1);
  view.emit('wheel', { deltaY: -24 }); view.emit('wheel', { deltaY: -24 });
  assert.deepEqual(view.scroll.attributeWrites, [
    ['data-scroll-follow', 'latest'], ['data-scroll-follow', 'paused'],
  ]);
  assert.equal(view.frames.length, 0, 'pausing still cancels the pending bottom correction');
  view.state._followLatest(state); view.state._followLatest(state);
  assert.deepEqual(view.scroll.attributeWrites.at(-1), ['data-scroll-follow', 'latest']);
  assert.equal(view.scroll.attributeWrites.length, 3);
  view.state._releaseScrollFollow();
  view.state._ensureScrollFollow(view.el);
  assert.equal(view.scroll.attributeWrites.length, 4, 'a new view restores the removed initial policy');
  view.state._releaseScrollFollow();
});

test('measured history heights batch geometry reads before changed style writes', () => {
  const view = readingView(), operations = [];
  assert.equal(view.follow.follow, false, 'height pinning belongs to paused history reading');
  for (const node of view.list.children) {
    const measure = node.getBoundingClientRect.bind(node);
    node.getBoundingClientRect = () => { operations.push('read:' + node.key); return measure(); };
    let value = '';
    Object.defineProperty(node.style, 'containIntrinsicSize', {
      get: () => value,
      set(next) { value = next; operations.push('write:' + node.key); },
    });
  }
  const pin = () => { view.emit('scroll'); view.flushFrame(); };
  pin();
  const firstWrite = operations.findIndex(value => value.startsWith('write:'));
  assert.ok(firstWrite > 0);
  assert.equal(operations.slice(firstWrite).some(value => value.startsWith('read:')), false,
    'a style change must never be followed by another geometry read in the same measurement pass');
  assert.equal(operations.filter(value => value.startsWith('write:')).length, 3);
  operations.length = 0; pin();
  assert.ok(operations.some(value => value.startsWith('read:')));
  assert.equal(operations.some(value => value.startsWith('write:')), false,
    'unchanged heights do not invalidate styles during repeated stream-follow scrolls');
  view.list.children[1].height += 40; operations.length = 0; pin();
  assert.deepEqual(operations.filter(value => value.startsWith('write:')), ['write:message:1']);
  assert.equal(view.list.children[1].style.containIntrinsicSize, 'auto 200px');
  view.state._releaseScrollFollow();
});

test('live following does not measure or pin history and discards queued reading measurements', () => {
  for (const queuedWhileReading of [false, true]) {
    const view = readingView();
    let measurements = 0;
    for (const node of view.list.children) {
      const measure = node.getBoundingClientRect.bind(node);
      node.getBoundingClientRect = () => { measurements++; return measure(); };
    }
    if (queuedWhileReading) view.emit('scroll');
    view.state._followLatest(view.follow);
    while (view.frames.length) view.flushFrame();
    assert.equal(measurements, 0, 'resuming latest prevents pending reading-only work');
    view.emit('scroll');
    assert.equal(view.frames.length, 0, 'automatic stream scrolling schedules no history measurements');
    assert.equal(measurements, 0);
    assert.ok(view.list.children.every(node => node.style.containIntrinsicSize === undefined),
      'live updates do not mutate settled history styles');
    view.state._releaseScrollFollow();
  }
});

test('ResizeObserver layout changes are coalesced and cancelled on reset', () => {
  const view = setup();
  const follow = view.state._ensureScrollFollow(view.el);
  view.resize();
  view.resize();
  assert.equal(view.frames.length, 1, 'layout bursts schedule one follow frame');
  view.scroll.scrollHeight = 920;
  view.flushFrame();
  assert.equal(view.scroll.scrollTop, 520);

  view.state._releaseScrollFollow();
  view.scroll.scrollHeight = 1040;
  view.resize();
  assert.equal(view.frames.length, 0, 'released state no longer follows layout changes');
  assert.equal(view.button.removed, true);
});

test('keyboard viewport changes follow latest but preserve a reader browsing history', () => {
  const view = setup();
  view.state._ensureScrollFollow(view.el);
  assert.ok(view.observed.has(view.scroll), 'observe the viewport, not only the transcript');
  view.scroll._top = 400;
  view.scroll.clientHeight = 180;
  view.resize(); view.flushFrame();
  assert.equal(view.scroll.scrollTop, 620, 'latest remains visible above the keyboard');
  view.emit('wheel', {deltaY: -100}); view.scroll._top = 400;
  view.scroll.clientHeight = 240;
  view.resize(); view.flushFrame();
  assert.equal(view.scroll.scrollTop, 400, 'resizing must not pull a history reader to latest');
  view.state._releaseScrollFollow();
  assert.equal(view.observed.size, 0);
});

test('a small upward wheel cancels queued following before the next token or scroll event', () => {
  const view = setup();
  const follow = view.state._ensureScrollFollow(view.el);
  view.scroll._top = 400;
  view.resize();
  view.emit('wheel', { deltaY: -24 });
  view.scroll._top = 376;
  view.state._followLatest(follow, false);
  view.emit('scroll');
  view.resize();
  view.flushFrame();
  assert.equal(follow.follow, false);
  assert.equal(view.scroll.scrollTop, 376);
  assert.equal(view.scroll.writes.length, 0, 'streaming must not undo an upward wheel');
  view.state._releaseScrollFollow();
});

test('layout and small downward scrolling do not resume until the reader reaches the bottom', () => {
  const view = setup();
  const follow = view.state._ensureScrollFollow(view.el);
  view.scroll._top = 400;
  view.emit('wheel', { deltaY: -40 });
  view.scroll._top = 360;
  view.emit('scroll');
  view.scroll.scrollHeight = 1000;
  view.resize();
  view.emit('wheel', { deltaY: 200 });
  view.scroll._top = 560;
  view.emit('scroll');
  assert.equal(follow.follow, false, '40px from bottom still belongs to the reader');
  view.emit('wheel', { deltaY: 40 });
  view.scroll._top = 600;
  view.emit('scroll');
  assert.equal(follow.follow, true);
  view.state._releaseScrollFollow();
});

test('keyboard upward navigation pauses and explicit latest resumes', () => {
  const view = setup();
  const follow = view.state._ensureScrollFollow(view.el);
  view.scroll._top = 400;
  view.emit('keydown', { key: 'ArrowUp' });
  view.state._followLatest(follow, false);
  assert.equal(follow.follow, false);
  view.scroll._top = 300;
  view.state._followLatest(follow);
  view.flushFrame();
  assert.equal(follow.follow, true);
  assert.equal(view.scroll.scrollTop, 400);
  view.state._releaseScrollFollow();
});

test('reset removes the reading anchor policy before reusing the scroll element', () => {
  const view = setup(); view.state._ensureScrollFollow(view.el);
  view.emit('wheel', {deltaY:-24});
  assert.equal(view.scroll.attrs['data-scroll-follow'], 'paused');
  view.state._releaseScrollFollow();
  assert.equal(view.scroll.attrs['data-scroll-follow'], undefined);
  const state = view.state._ensureScrollFollow(view.el);
  assert.equal(state.follow, true);
  assert.equal(view.scroll.attrs['data-scroll-follow'], 'latest');
  view.state._releaseScrollFollow();
});

test('downward intent at the exact bottom resumes even without a scroll event', () => {
  const view=setup(), state=view.state._ensureScrollFollow(view.el);
  view.scroll._top=400; view.emit('wheel',{deltaY:-24});
  assert.equal(state.follow,false);
  view.emit('wheel',{deltaY:24});
  assert.equal(state.follow,true);
  view.state._releaseScrollFollow();
});

test('expired downward intent cannot resume following when content later shrinks', () => {
  const view=setup(), state=view.state._ensureScrollFollow(view.el);
  view.scroll._top=300; view.emit('wheel',{deltaY:-24}); view.emit('wheel',{deltaY:24});
  state.intentUntil=0; view.scroll.scrollHeight=700; view.emit('scroll');
  assert.equal(state.follow,false);
  view.state._releaseScrollFollow();
});

test('a long scrollbar drag resumes at bottom and releasing away cannot leave stale intent', () => {
  const view=setup(), state=view.state._ensureScrollFollow(view.el);
  view.scroll._top=300;
  view.emit('pointerdown',{target:view.scroll,button:0,clientX:908,clientY:250});
  state.intentUntil=0;
  view.scroll._top=400; view.emit('scroll');
  assert.equal(state.follow,true,'drag remains an intentional scroll after 600ms');
  view.emit('pointerup');
  assert.equal(state.pointerActive,false);
  view.emit('pointerdown',{target:view.scroll,button:0,clientX:908,clientY:250});
  view.scroll._top=300; view.emit('scroll'); view.emit('pointerup');
  view.scroll.scrollHeight=700; view.emit('scroll');
  assert.equal(state.follow,false,'later layout cannot reuse a finished drag');
  view.state._releaseScrollFollow();
});

test('window blur clears an unfinished scrollbar drag without resuming', () => {
  const view=setup(), state=view.state._ensureScrollFollow(view.el);
  view.emit('pointerdown',{target:view.scroll,button:0,clientX:908,clientY:250});
  view.emit('blur');
  view.scroll._top=400; view.emit('scroll');
  assert.equal(state.pointerActive,false);
  assert.equal(state.follow,false);
  view.state._releaseScrollFollow();
});

test('clicking either blank transcript margin retains following and the pending paint', () => {
  for (const clientX of [120, 880]) {
    const view = setup(), state = view.state._ensureScrollFollow(view.el);
    view.scroll._top = 400;
    view.state._followLatest(state, false);
    view.emit('pointerdown', { target: view.scroll, button: 0, clientX, clientY: 250 });
    assert.equal(state.follow, true, 'blank space must not switch history to its fully laid-out state');
    assert.equal(state.pointerActive, false);
    assert.equal(view.scroll.attrs['data-scroll-follow'], 'latest');
    assert.equal(view.frames.length, 1, 'a normal click must not cancel the pending stream paint');
    view.emit('pointerup'); view.flushFrame();
    assert.equal(view.scroll.scrollTop, 400);
    assert.deepEqual(view.scroll.writes, [], 'a click at the bottom does not move the transcript');
    view.state._releaseScrollFollow();
  }
});

test('text selection, touch presses, secondary buttons and missing coordinates do not arm a scrollbar drag', () => {
  for (const event of [
    { target: {}, clientX: 908, clientY: 250 },
    { pointerType: 'touch', clientX: 908, clientY: 250 },
    { button: 2, clientX: 908, clientY: 250 },
    {},
    { clientX: 908, clientY: 500 },
  ]) {
    const view = setup(), state = view.state._ensureScrollFollow(view.el);
    view.emit('pointerdown', { target: view.scroll, button: 0, ...event });
    assert.equal(state.follow, true); assert.equal(state.pointerActive, false);
    view.state._releaseScrollFollow();
  }
});

test('scrollbar hit testing uses layout geometry under scaling and excludes borders and content', () => {
  for (const [layoutX, expected] of [[801, false], [808, true], [819, false]]) {
    const view = setup(), state = view.state._ensureScrollFollow(view.el);
    Object.assign(view.scroll, { offsetWidth: 820, clientWidth: 800, clientLeft: 2 });
    Object.assign(view.rect, { width: 1230, right: 1330 });
    Object.assign(view.style, { borderLeftWidth: '2px', borderRightWidth: '2px' });
    view.emit('pointerdown', { target: view.scroll, button: 0, clientX: 100 + layoutX * 1.5, clientY: 250 });
    assert.equal(state.pointerActive, expected, 'layout x=' + layoutX);
    assert.equal(state.follow, !expected);
    view.state._releaseScrollFollow();
  }
});

test('a left-side scrollbar uses clientLeft without treating the opposite margin as a drag', () => {
  for (const [clientX, expected] of [[101, false], [110, true], [130, false], [910, false]]) {
    const view = setup(), state = view.state._ensureScrollFollow(view.el);
    Object.assign(view.scroll, { offsetWidth: 820, clientWidth: 800, clientLeft: 18 });
    Object.assign(view.rect, { width: 820, right: 920 });
    Object.assign(view.style, { borderLeftWidth: '2px', borderRightWidth: '2px', direction: 'rtl' });
    view.emit('pointerdown', { target: view.scroll, button: 0, clientX, clientY: 250 });
    assert.equal(state.pointerActive, expected, 'client x=' + clientX);
    view.state._releaseScrollFollow();
  }
});

test('an overlay scrollbar uses only its configured edge width and respects hidden tracks', () => {
  for (const [direction, clientX, hidden, expected] of [
    ['ltr', 1296, false, true], ['ltr', 1280, false, false],
    ['rtl', 104, false, true], ['rtl', 120, false, false],
    ['ltr', 1296, true, false],
  ]) {
    const view = setup(), state = view.state._ensureScrollFollow(view.el);
    Object.assign(view.scroll, { offsetWidth: 800, clientWidth: 800 });
    Object.assign(view.rect, { width: 1200, right: 1300 });
    Object.assign(view.style, { direction });
    view.scrollbarStyle.display = hidden ? 'none' : 'block';
    view.emit('pointerdown', { target: view.scroll, button: 0, clientX, clientY: 250 });
    assert.equal(state.pointerActive, expected);
    view.state._releaseScrollFollow();
  }
});

test('a transcript without overflow has no scrollbar drag region', () => {
  const view = setup(), state = view.state._ensureScrollFollow(view.el);
  view.scroll.scrollHeight = view.scroll.clientHeight;
  view.emit('pointerdown', { target: view.scroll, button: 0, clientX: 908, clientY: 250 });
  assert.equal(state.follow, true); assert.equal(state.pointerActive, false);
  view.state._releaseScrollFollow();
});

test('a full transcript patch retains the visible message offset even when its node is replaced', () => {
  const view = readingView();
  const restore = view.state._preserveReadingPosition(view.scroll, view.list);
  view.list.children[1] = view.node('message:1', 460);
  restore();
  assert.equal(view.scroll.scrollTop, 400, 'patching must not write scrollTop during the render stack');
  view.flushFrame();
  assert.equal(view.scroll.scrollTop, 480);
  assert.equal(view.list.children[1].getBoundingClientRect().top, 80, 'visible message stays 20px above the viewport');
  view.state._releaseScrollFollow();
});

test('successive patches before a paint preserve the original reading offset with one correction', () => {
  const view = readingView();
  for (const offset of [460, 500]) {
    const restore = view.state._preserveReadingPosition(view.scroll, view.list);
    view.list.children[1].offset = offset; restore();
  }
  assert.equal(view.frames.length, 1);
  view.flushFrame();
  assert.deepEqual(view.scroll.writes, [520]);
  assert.equal(view.list.children[1].getBoundingClientRect().top, 80);
  view.state._releaseScrollFollow();
});

test('removing the reading anchor falls back to the previous offset within the new transcript bounds', () => {
  const view = readingView();
  const restore = view.state._preserveReadingPosition(view.scroll, view.list);
  view.list.children = []; view.scroll.scrollHeight = 650; restore(); view.flushFrame();
  assert.equal(view.scroll.scrollTop, 250);
  view.state._releaseScrollFollow();
});

test('new wheel intent or a changed reading offset wins over an outstanding anchor correction', () => {
  for (const input of ['wheel', 'scroll']) {
    const view = readingView();
    const restore = view.state._preserveReadingPosition(view.scroll, view.list);
    view.list.children[1].offset = 460; restore();
    if (input === 'wheel') view.emit('wheel', { deltaY: -40 });
    view.scroll._top = 360; view.flushFrame();
    assert.equal(view.scroll.scrollTop, 360, input);assert.equal(view.scroll.writes.length, 0, input);
    view.state._releaseScrollFollow();
  }
});

test('explicit latest and switching conversations discard outstanding reading corrections', () => {
  for (const action of ['latest', 'switch']) {
    const view = readingView();
    const restore = view.state._preserveReadingPosition(view.scroll, view.list);
    view.list.children[1].offset = 460; restore();
    if (action === 'latest') {
      view.state._followLatest(view.follow); view.flushFrame();
      assert.equal(view.scroll.scrollTop, 800);assert.equal(view.frames.length, 0);
    } else {
      view.ctx._ref = 'another-conversation'; view.state._ensureScrollFollow(view.el);
      assert.equal(view.frames.length, 0);assert.equal(view.scroll.writes.length, 0);
    }
    assert.equal(view.follow.follow, true);view.state._releaseScrollFollow();
  }
});

test('reset cancels both reading restoration and measured-size frames before reusing the viewport', () => {
  const view = readingView();
  const restore = view.state._preserveReadingPosition(view.scroll, view.list);
  view.list.children[1].offset = 460; restore();view.emit('scroll');
  assert.equal(view.frames.length, 2);
  view.state._releaseScrollFollow();assert.equal(view.frames.length, 0);
  view.state._ensureScrollFollow(view.el);view.flushFrame();
  assert.equal(view.scroll.writes.length, 0);assert.deepEqual(view.list.children[1].style, {});
  view.state._releaseScrollFollow();
});


test('blank transcript clicks preserve following and its pending streaming correction', () => {
  const view=setup(), state=view.state._ensureScrollFollow(view.el);
  view.scroll._top=400; view.scroll.scrollHeight=840; view.resize();
  view.emit('pointerdown',{target:view.scroll,button:0,clientX:120,clientY:450});
  view.emit('pointerup');
  assert.equal(state.follow,true);
  assert.equal(state.pointerActive,false);
  assert.equal(view.scroll.attrs['data-scroll-follow'],'latest');
  view.flushFrame();
  assert.equal(view.scroll.scrollTop,440,'new output retains normal bottom following');
  view.state._releaseScrollFollow();
});

