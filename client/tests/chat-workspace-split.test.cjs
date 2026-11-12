'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
class Target {
  constructor() { this.events = new Map(); this.attrs = {}; this.dataset = {}; this.writes = 0; this.html = ''; }
  addEventListener(name, fn) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(fn); }
  removeEventListener(name, fn) { this.events.get(name)?.delete(fn); }
  emit(name, extra = {}) {
    const event = { preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra };
    for (const fn of [...(this.events.get(name) || [])]) fn(event);
    return event;
  }
  setAttribute(name, value) { this.attrs[name] = value; }
  removeAttribute(name) { delete this.attrs[name]; }
  focus() { this.focused = true; }
  setPointerCapture(id) { this.capture = id; }
  releasePointerCapture() { this.capture = null; this.emit('lostpointercapture'); }
  set innerHTML(value) { this.html = value; this.writes++; }
  get innerHTML() { return this.html; }
  replaceChildren() { this.html = ''; this.writes++; }
}
function fixture(width = 1200, stageWidth = width) {
  const global = new Target(), root = new Target(), grip = new Target(), maximize = new Target();
  let ratio = 0.5, maximized = false, hidden = 0, scheduled = 0;
  const classes = new Set();
  root.classList = { add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)),
    toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) };
  root.style = { setProperty(_name, value) { ratio = Number.parseFloat(value) / 100; } };
  root.getBoundingClientRect = () => ({ width });
  const nodes = { '[data-wb-resize]': grip, '[data-wb-maximize]': maximize,
    '.nchat-stage': { getBoundingClientRect: () => ({ width: stageWidth }) },
    '.nchat-main': { getBoundingClientRect: () => ({ width: stageWidth * ratio }) },
    '.ncw': new Target(), '.ncw-tabs': new Target(), '.ncw-body': new Target() };
  root.querySelector = name => nodes[name] || null;
  const context = { window: global, URL, setTimeout, clearTimeout };
  vm.createContext(context);
  const load = name => vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels/', name), 'utf8'), context);
  load('chat-workspace-split.js');
  const bind = () => global.ChatWorkspaceSplit.bind(root, { hideNative() { hidden++; }, scheduleNative() { scheduled++; },
    maximize() { maximized = true; }, isMaximized: () => maximized });
  return { global, root, grip, maximize, classes, nodes, load, bind, get ratio() { return ratio; },
    set ratio(value) { ratio = value; }, get maximized() { return maximized; }, get hidden() { return hidden; }, get scheduled() { return scheduled; } };
}
function drag(ctx, destination) {
  const start = 1200 * ctx.ratio;
  ctx.grip.emit('pointerdown', { button: 0, pointerId: 7, clientX: start });
  ctx.global.emit('pointermove', { pointerId: 7, clientX: destination });
}
test('split ratios, keyboard steps and pointer resizing follow the actual stage bounds', () => {
  const ctx = fixture(1600, 1280), binding = ctx.bind();
  assert.equal(ctx.global.ChatWorkspaceSplit.current(ctx.root), 0.5);
  ctx.grip.emit('keydown', { key: 'ArrowRight' });
  assert.equal(ctx.ratio, 0.52);
  ctx.grip.emit('pointerdown', { button: 0, pointerId: 7, clientX: 665.6 });
  ctx.global.emit('pointerup', { pointerId: 7, clientX: 512 });
  assert.equal(ctx.ratio, 0.4);
  assert.equal(ctx.maximized, false);
  binding.dispose();
});
test('drag below 320 previews snap, commits only on release, and retains prior useful width', () => {
  const ctx = fixture(); const binding = ctx.bind(); ctx.ratio = 0.56;
  drag(ctx, 310);
  assert.equal(ctx.maximized, false);
  assert.equal(ctx.classes.has('ncw-snap-ready'), true);
  assert.equal(ctx.grip.attrs['data-snap-label'], '松开全屏查看成果');
  ctx.global.emit('pointerup', { pointerId: 7, clientX: 310 });
  assert.equal(ctx.maximized, true); assert.equal(ctx.ratio, 0.56);
  assert.equal(ctx.maximize.focused, true); assert.equal(ctx.hidden, 1);
  assert.equal(ctx.classes.has('ncw-resizing'), false); assert.equal(ctx.grip.capture, null);
  assert.equal(ctx.global.events.get('pointermove').size, 0);
  binding.dispose();
});
test('moving back from snap threshold commits ordinary width without maximizing', () => {
  const ctx = fixture(); const binding = ctx.bind();
  drag(ctx, 310); ctx.global.emit('pointermove', { pointerId: 7, clientX: 420 });
  assert.equal(ctx.classes.has('ncw-snap-ready'), false);
  ctx.global.emit('pointerup', { pointerId: 7, clientX: 420 });
  assert.equal(ctx.maximized, false); assert.equal(ctx.ratio, 0.35); binding.dispose();
});
for (const reason of ['pointercancel', 'lostpointercapture', 'Escape', 'dispose']) test(reason + ' restores split and removes the in-flight drag listeners', () => {
  const ctx = fixture(); const binding = ctx.bind(); drag(ctx, 280);
  if (reason === 'Escape') ctx.global.emit('keydown', { key: 'Escape' });
  else if (reason === 'dispose') binding.dispose();
  else if (reason === 'lostpointercapture') ctx.grip.emit(reason, { pointerId: 7 });
  else ctx.global.emit(reason, { pointerId: 7 });
  assert.equal(ctx.ratio, 0.5); assert.equal(ctx.maximized, false);
  assert.equal(ctx.classes.has('ncw-snap-ready'), false);
  assert.equal(ctx.global.events.get('pointermove').size, 0);
  ctx.global.emit('pointerup', { pointerId: 7, clientX: 270 }); assert.equal(ctx.maximized, false);
  binding.dispose();
});
test('another pointer cannot finish the captured drag and narrow keyboard motion can maximize', () => {
  const ctx = fixture(); const binding = ctx.bind(); drag(ctx, 410);
  const before = ctx.ratio;
  ctx.global.emit('pointerup', { pointerId: 8, clientX: 200 });
  assert.equal(ctx.ratio, before); assert.equal(ctx.classes.has('ncw-resizing'), true);
  ctx.global.emit('pointercancel', { pointerId: 7 });
  ctx.ratio = 0.28; ctx.grip.emit('keydown', { key: 'ArrowLeft' });
  assert.equal(ctx.maximized, true); assert.equal(ctx.ratio, 0.28); binding.dispose();
});
test('ordinary keyboard resize/reset remains bounded and Home maximizes with restore width', () => {
  const ctx = fixture(); const binding = ctx.bind();
  ctx.grip.emit('keydown', { key: 'ArrowRight' }); assert.equal(ctx.ratio, 0.52);
  ctx.grip.emit('keydown', { key: 'Enter' }); assert.equal(ctx.ratio, 0.5);
  ctx.grip.emit('keydown', { key: 'Home' }); assert.equal(ctx.maximized, true); assert.equal(ctx.ratio, 0.5);
  binding.dispose();
});
test('production workbench maximize and Escape preserve mounted preview, tabs, draft and active context', () => {
  const ctx = fixture();
  ctx.global.ChatTools = { esc: String, normalizeAddress: value => value, artifactKey: file => file?.path, previewKind: () => 'text' };
  ctx.global.ChatOutputLinks = { fileTarget: () => null };
  ctx.global.ChatWorkspaceInfo = { baseName: String, browserToolbar: () => '<video>fixture preview</video>', ICONS: {} };
  ctx.global.requestAnimationFrame = () => 1; ctx.global.cancelAnimationFrame = () => {};
  ctx.load('chat-workspace-controls.js');
  ctx.load('panels-chat-workspace.js');
  const draft = { value: '保留这份未发送草稿' }, owner = { ref: 'same-session', running: true };
  ctx.nodes['textarea'] = draft;
  const wb = ctx.global.ChatWorkbench; wb.bind(ctx.root, () => owner);
  assert.equal(wb.openLink('https://example.test/preview'), true);
  const body = ctx.nodes['.ncw-body'], tabs = ctx.nodes['.ncw-tabs'];
  body.scrollTop = 245; body.videoTime = 12;
  const bodyWrites = body.writes, tabWrites = tabs.writes;
  wb.maximize(true);
  assert.equal(wb.state().maximized, true); assert.match(ctx.maximize.innerHTML, /返回对话/);
  const inputEscape = ctx.root.emit('keydown', { key: 'Escape', target: { closest: () => draft } });
  assert.equal(wb.state().maximized, true); assert.equal(inputEscape.prevented, undefined);
  ctx.root.emit('keydown', { key: 'Escape', defaultPrevented: true });
  assert.equal(wb.state().maximized, true);
  ctx.root.emit('keydown', { key: 'Escape' });
  assert.equal(wb.state().maximized, false);
  assert.equal(body.writes, bodyWrites); assert.equal(tabs.writes, tabWrites);
  assert.equal(body.scrollTop, 245); assert.equal(body.videoTime, 12);
  assert.equal(draft.value, '保留这份未发送草稿'); assert.equal(owner.ref, 'same-session'); assert.equal(owner.running, true);
  assert.equal(ctx.grip.focused, true);
  wb.reset();
  assert.equal(body.innerHTML, ''); assert.equal(tabs.innerHTML, '');
  assert.equal(ctx.classes.has('ncw-open'), false);
  assert.equal(ctx.nodes['.ncw'].attrs['aria-hidden'], 'true');
});
