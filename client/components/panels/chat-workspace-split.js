(function (global) {
  'use strict';
  const DEFAULT = 0.5, SNAP_WIDTH = 320;
  const text = (source, params) => global.SoduWorkI18n?.t(source, source, params) || source.replace(/\{(\w+)\}/g, (_, key) => params?.[key] ?? '');
  const availableWidth = root => (root.querySelector('.nchat-stage') || root).getBoundingClientRect().width;
  function current(root) {
    const total = availableWidth(root);
    const main = root.querySelector('.nchat-main');
    return total && main ? main.getBoundingClientRect().width / total : DEFAULT;
  }
  function set(root, ratio) {
    if (!root) return DEFAULT;
    const total = availableWidth(root) || 640;
    const min = Math.min(DEFAULT, SNAP_WIDTH / total);
    const max = Math.max(min, Math.min(0.7, 1 - SNAP_WIDTH / total));
    const value = Math.max(min, Math.min(max, Number(ratio) || DEFAULT));
    root.style.setProperty('--nchat-w', (value * 100).toFixed(2) + '%');
    const grip = root.querySelector('[data-wb-resize]');
    if (grip) {
      const percent = Math.round(value * 100);
      grip.setAttribute('aria-valuemin', String(Math.round(min * 100)));
      grip.setAttribute('aria-valuemax', String(Math.round(max * 100)));
      grip.setAttribute('aria-valuenow', String(percent));
      grip.setAttribute('aria-valuetext', text('对话 {chat}%，成果 {output}%', { chat: percent, output: 100 - percent }));
    }
    return value;
  }
  function bind(root, { hideNative, scheduleNative, maximize, isMaximized }) {
    const grip = root.querySelector('[data-wb-resize]');
    let drag = null;
    function snap(restore) {
      set(root, restore); // Retain the useful split from before the drag.
      maximize();
      root.querySelector('[data-wb-maximize]')?.focus({ preventScroll: true });
    }
    function cleanup() {
      const previous = drag; drag = null;
      global.removeEventListener('pointermove', move);
      global.removeEventListener('pointerup', up);
      global.removeEventListener('pointercancel', cancel);
      global.removeEventListener('keydown', escape, true);
      grip.removeEventListener('lostpointercapture', cancel);
      try { grip.releasePointerCapture(previous?.pointerId); } catch (_) {}
      root.classList.remove('ncw-resizing', 'ncw-snap-ready');
      grip.removeAttribute('data-snap-label');
    }
    const matches = event => drag && (event?.pointerId === undefined || drag.pointerId === undefined || event.pointerId === drag.pointerId);
    function move(event) {
      if (!matches(event)) return;
      const total = availableWidth(root);
      if (!total) return;
      const width = drag.startWidth + event.clientX - drag.startX;
      drag.snap = width <= SNAP_WIDTH;
      set(root, Math.max(SNAP_WIDTH, width) / total);
      root.classList.toggle('ncw-snap-ready', drag.snap);
      if (drag.snap) grip.setAttribute('data-snap-label', text('松开全屏查看成果'));
      else grip.removeAttribute('data-snap-label');
    }
    function up(event) {
      if (!matches(event)) return;
      if (Number.isFinite(event?.clientX)) move(event);
      const previous = drag; cleanup();
      if (previous.snap) snap(previous.ratio);
      scheduleNative();
    }
    function cancel(event) {
      if (!matches(event)) return;
      const previous = drag; cleanup(); set(root, previous.ratio); scheduleNative();
    }
    function escape(event) {
      if (event.key !== 'Escape' || event.isComposing || !drag) return;
      event.preventDefault(); event.stopPropagation(); cancel(); grip.focus({ preventScroll: true });
    }
    function down(event) {
      if (drag || isMaximized() || event.button !== undefined && event.button !== 0) return;
      event.preventDefault(); grip.focus({ preventScroll: true });
      drag = { startX: event.clientX, startWidth: root.querySelector('.nchat-main').getBoundingClientRect().width,
        ratio: current(root), pointerId: event.pointerId, snap: false };
      try { grip.setPointerCapture(event.pointerId); } catch (_) {}
      hideNative(); root.classList.add('ncw-resizing');
      global.addEventListener('pointermove', move);
      global.addEventListener('pointerup', up);
      global.addEventListener('pointercancel', cancel);
      global.addEventListener('keydown', escape, true);
      grip.addEventListener('lostpointercapture', cancel);
    }
    function reset(event) { event.preventDefault(); set(root, DEFAULT); scheduleNative(); }
    function key(event) {
      if (event.isComposing || drag || isMaximized()) return;
      const ratio = current(root), step = event.shiftKey ? 0.05 : 0.02;
      const width = availableWidth(root);
      let next;
      if (event.key === 'Home' || event.key === 'ArrowLeft' && (ratio - step) * width <= SNAP_WIDTH) {
        event.preventDefault(); snap(ratio); return;
      }
      if (event.key === 'ArrowLeft') next = ratio - step;
      else if (event.key === 'ArrowRight') next = ratio + step;
      else if (event.key === 'End') next = 0.7;
      else if (event.key === 'Enter' || event.key === ' ') next = DEFAULT;
      if (next === undefined) return;
      event.preventDefault(); set(root, next); scheduleNative();
    }
    grip.addEventListener('pointerdown', down);
    grip.addEventListener('dblclick', reset);
    grip.addEventListener('keydown', key);
    return { cancel, dispose() {
      if (drag) cancel();
      grip.removeEventListener('pointerdown', down);
      grip.removeEventListener('dblclick', reset);
      grip.removeEventListener('keydown', key);
    } };
  }
  const api = { DEFAULT, SNAP_WIDTH, current, set, bind };
  global.ChatWorkspaceSplit = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
