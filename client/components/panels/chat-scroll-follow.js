/* Conversation view helper; state is scoped to its renderer instance. */
(function (global) {
  'use strict';
  function create(ctx) {
  const FOLLOW_DISTANCE = 72;
  let activeScrollState = null;
  let pendingReadingAnchor = null, pinFrame = 0, readingFrame = 0;

  function _cancelFrame(frame) {
    if (!frame) return;
    if (typeof global.cancelAnimationFrame === 'function' &&
        typeof global.requestAnimationFrame === 'function') global.cancelAnimationFrame(frame);
    else clearTimeout(frame);
  }
  function _cancelFollow(state) {
    if (!state?.followFrame) return;
    _cancelFrame(state.followFrame);
    state.followFrame = 0;
  }
  function _cancelReading() {
    _cancelFrame(readingFrame);
    readingFrame = 0; pendingReadingAnchor = null;
  }

  function _setFollowing(state, follow) {
    state.follow = follow;
    const policy = follow ? 'latest' : 'paused';
    if (state.scroll?.getAttribute?.('data-scroll-follow') !== policy) {
      state.scroll?.setAttribute?.('data-scroll-follow', policy);
    }
    if (!follow) _cancelFollow(state);
  }

  function _releaseScrollFollow() {
    _cancelReading(); _cancelFrame(pinFrame); pinFrame = 0;
    const state = activeScrollState;
    if (!state) return;
    activeScrollState = null;
    _cancelFollow(state);
    state.observer?.disconnect();
    state.listeners.forEach(([target, type, listener]) => target.removeEventListener(type, listener));
    if (state.showTimer) { clearTimeout(state.showTimer); state.showTimer = 0; }
    if (state.hideTimer) { clearTimeout(state.hideTimer); state.hideTimer = 0; }
    state.button?.remove();
    state.scroll?.removeAttribute?.('data-scroll-follow');
    if (state.scroll) delete state.scroll.__soduworkScrollFollow;
    state.scroll = state.button = state.observedList = state.observer = null;
    state.listeners = [];
  }

  /*
   * Store measured heights near the viewport in contain-intrinsic-size so repeated history
   * browsing keeps scrollHeight stable. Locate the viewport range by binary search to avoid
   * forcing layout for every node.
   */
  function _pinMeasuredSize(state) {
    if (state.follow) return;
    const list = state.observedList || (state.scroll && state.scroll.querySelector && state.scroll.querySelector('#nchatList'));
    if (!list) return;
    const kids = list.children;
    if (!kids || !kids.length || !kids[0].getBoundingClientRect) return;
    const viewport = state.scroll.getBoundingClientRect();
    const minTop = viewport.top - viewport.height, maxBottom = viewport.bottom + viewport.height;
    let lo = 0, hi = kids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (kids[mid].getBoundingClientRect().bottom >= minTop) hi = mid - 1; else lo = mid + 1;
    }
    const measured = [];
    for (let i = lo; i < kids.length; i++) {
      const rect = kids[i].getBoundingClientRect();
      if (rect.top > maxBottom) break;
      if (rect.height < 4) continue;
      const size = 'auto ' + Math.round(rect.height) + 'px';
      if (kids[i].style.containIntrinsicSize !== size) measured.push([kids[i], size]);
    }
    // Finish geometry reads before changing styles to avoid per-row layout flushes.
    for (const [node, size] of measured) node.style.containIntrinsicSize = size;
  }
  function _schedulePin(state) {
    // Chromium remembers auto-containment heights during live following.
    // Explicit pins are only needed while the reader browses expanded history.
    if (state.follow) return;
    if (pinFrame || typeof global.requestAnimationFrame !== 'function') { if (!pinFrame) _pinMeasuredSize(state); return; }
    pinFrame = global.requestAnimationFrame(() => { pinFrame = 0; if (state.scroll && state.scroll.isConnected && !state.follow) _pinMeasuredSize(state); });
  }

  // Capture before patching and restore only for the same paused reading view.
  function _preserveReadingPosition(scroll, list) {
    const anchor = scroll && list && !activeScrollState?.follow
      ? _captureReadingAnchor(scroll, list) : null;
    return () => { if (anchor) _restoreReadingAnchor(scroll, list, anchor); };
  }
  function _nearBottom(scroll) {
    return !scroll || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= FOLLOW_DISTANCE;
  }

  function _isScrollbarPointer(scroll, event) {
    if (event.target !== scroll || (event.button != null && event.button !== 0) ||
        event.pointerType === 'touch' || scroll.scrollHeight <= scroll.clientHeight ||
        !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false;
    const rect = scroll.getBoundingClientRect();
    if (!(rect.width > 0 && scroll.offsetWidth > 0) ||
        event.clientY < rect.top || event.clientY >= rect.bottom) return false;
    // Client coordinates include visual scaling; scrollbar metrics use layout pixels.
    const x = (event.clientX - rect.left) * scroll.offsetWidth / rect.width;
    const style = typeof global.getComputedStyle === 'function' ? global.getComputedStyle(scroll) : null;
    const leftBorder = parseFloat(style?.borderLeftWidth) || 0;
    const rightBorder = parseFloat(style?.borderRightWidth) || 0;
    const rightEdge = scroll.offsetWidth - rightBorder;
    const gutter = scroll.offsetWidth - scroll.clientWidth - leftBorder - rightBorder;
    if (gutter > 0) {
      const leftGutter = scroll.clientLeft - leftBorder;
      return leftGutter > 0
        ? x >= leftBorder && x < scroll.clientLeft
        : x >= scroll.clientLeft + scroll.clientWidth && x < rightEdge;
    }
    // Overlay scrollbars reserve no layout space. Limit their hit region to
    // the configured track width, never the blank margins beside the transcript.
    const bar = typeof global.getComputedStyle === 'function'
      ? global.getComputedStyle(scroll, '::-webkit-scrollbar') : null;
    const overlayWidth = bar?.display !== 'none' && style?.scrollbarWidth !== 'none'
      ? parseFloat(bar?.width) || 0 : 0;
    return overlayWidth > 0 && (style?.direction === 'rtl'
      ? x >= leftBorder && x < leftBorder + overlayWidth
      : x >= rightEdge - overlayWidth && x < rightEdge);
  }

  function _updateScrollButton(state) {
    if (!state || !state.button) return;
    const hidden = Boolean(state.follow || _nearBottom(state.scroll) ||
      state.scroll.scrollHeight <= state.scroll.clientHeight + 2);
    if (hidden) {
      if (state.showTimer) { clearTimeout(state.showTimer); state.showTimer = 0; }
      if (state.button.hidden || state.hideTimer) return;
      /* Near-bottom can oscillate for a few frames while a streaming message
         grows. Keep the hit target stable until the state is settled. */
      state.hideTimer = setTimeout(function () {
        state.hideTimer = 0;
        if (!state.button || !state.scroll || !state.button.isConnected) return;
        const stillHidden = Boolean(state.follow || _nearBottom(state.scroll) ||
          state.scroll.scrollHeight <= state.scroll.clientHeight + 2);
        if (stillHidden && !state.button.hidden) {
          state.button.hidden = true;
          state.button.setAttribute('aria-hidden', 'true');
        }
      }, 180);
      return;
    }
    if (state.hideTimer) { clearTimeout(state.hideTimer); state.hideTimer = 0; }
    if (!state.button.hidden) return;
    /*
     * Delay the jump-to-bottom button during transient streaming growth so automatic scroll
     * correction does not cause flicker or cursor changes.
     */
    if (state.showTimer) return;
    state.showTimer = setTimeout(function () {
      state.showTimer = 0;
      if (!state.button || !state.scroll || !state.button.isConnected) return;
      const stillAway = !state.follow && !_nearBottom(state.scroll) &&
        state.scroll.scrollHeight > state.scroll.clientHeight + 2;
      if (stillAway && state.button.hidden) {
        state.button.hidden = false;
        state.button.setAttribute('aria-hidden', 'false');
      }
    }, 280);
  }

  function _followLatest(state, explicit = true) {
    if (!state || !state.scroll) return;
    // Only a conversation switch or a click on "latest" may discard reading
    // intent. Token/resize updates merely continue an already active follow.
    if (explicit) { _cancelReading(); _setFollowing(state, true); state.userIntent = false; }
    _updateScrollButton(state);
    _scheduleFollow(state);
  }

  /*
   * DOM patches and image/font layout can produce several ResizeObserver
   * callbacks in one frame.  Writing scrollTop from each callback makes the
   * browser alternate between its scroll-anchor correction and our own
   * bottom correction, which is perceived as a vertical shake while a reply
   * streams.  Coalesce all bottom corrections into the next paint and avoid
   * writing when the viewport is already at the exact bottom.
   */
  function _scheduleFollow(state) {
    if (!state || !state.scroll || !state.follow || state.followFrame) return;
    const paint = () => {
      state.followFrame = 0;
      if (!state.scroll || !state.scroll.isConnected || !state.follow) return;
      const maxTop = Math.max(0, state.scroll.scrollHeight - state.scroll.clientHeight);
      if (Math.abs(state.scroll.scrollTop - maxTop) > 1) state.scroll.scrollTop = maxTop;
      _updateScrollButton(state);
    };
    if (typeof global.requestAnimationFrame === 'function') {
      state.followFrame = global.requestAnimationFrame(paint);
    } else {
      state.followFrame = setTimeout(paint, 16);
    }
  }

  function _ensureScrollFollow(el) {
    const scroll = el && el.querySelector('#nchatScroll');
    if (!scroll) return null;
    if (activeScrollState && activeScrollState.scroll !== scroll) _releaseScrollFollow();
    let state = scroll.__soduworkScrollFollow;
    if (!state) {
      const area = el.querySelector('.nchat-content-area');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nchat-jump-latest';
      button.hidden = true;
      button.setAttribute('aria-hidden', 'true');
      button.setAttribute('aria-label', '回到最新内容');
      button.title = '回到最新内容';
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v15M6.5 13.5 12 19l5.5-5.5"/></svg>';
      if (area) area.insertBefore(button, area.querySelector('.nchat-collab-slot'));
      state = {
        scroll, button, follow: true, userIntent: false, interaction: 0,
        ref: String(ctx._ref || ''), observedList: null, observer: null, listeners: [], followFrame: 0,
        showTimer: 0, hideTimer: 0, touchY: null, pointerActive: false, lastTop: scroll.scrollTop,
      };
      scroll.__soduworkScrollFollow = state;
      state.pause = () => _setFollowing(state, false);
      _setFollowing(state, true);
      const on = (target, type, listener, options) => {
        target.addEventListener(type, listener, options);
        state.listeners.push([target, type, listener]);
      };
      const markIntent = direction => {
        _cancelReading();
        state.interaction++;
        state.userIntent = direction;
        state.intentUntil = Date.now() + 600;
        // Pause before the browser applies the wheel default action: a queued
        // animation frame or token can otherwise win the race and undo it.
        if (direction === 'up' || direction === 'pointer') _setFollowing(state, false);
        if (direction === 'down' && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 2) _followLatest(state);
      };
      on(scroll, 'wheel', event => {
        if (event.ctrlKey || !event.deltaY) return;
        markIntent(event.deltaY < 0 ? 'up' : 'down');
      }, { passive: true });
      on(scroll, 'touchstart', event => { state.interaction++; state.touchY = event.touches?.[0]?.clientY ?? null; }, { passive: true });
      on(scroll, 'touchmove', event => {
        const y = event.touches?.[0]?.clientY;
        if (state.touchY != null && y != null && y !== state.touchY) markIntent(y > state.touchY ? 'up' : 'down');
        state.touchY = y ?? null;
      }, { passive: true });
      on(scroll, 'pointerdown', event => {
        // Only the scrollbar pauses following; blank margins share the scroll
        // container as their event target but must not relayout the history.
        if (_isScrollbarPointer(scroll, event)) {
          state.pointerActive = true;
          markIntent('pointer');
        } else state.interaction++;
      }, { passive: true });
      const endPointer = resume => {
        if (!state.pointerActive) return;
        state.pointerActive = false;
        state.userIntent = false;
        if (resume && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 2) _followLatest(state);
      };
      on(global, 'pointerup', () => endPointer(true));
      on(global, 'pointercancel', () => endPointer(false));
      on(global, 'blur', () => endPointer(false));
      on(scroll, 'keydown', (event) => {
        if (event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
        if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) markIntent('up');
        if (['ArrowDown', 'PageDown', 'End'].includes(event.key) || (event.key === ' ' && !event.shiftKey)) markIntent('down');
      });
      on(scroll, 'scroll', () => {
        if (!state.pointerActive && Date.now() > state.intentUntil) state.userIntent = false;
        const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 2;
        // The old 72px threshold immediately undid small upward wheel steps.
        // Layout changes alone must never opt a reader back into following.
        if (atBottom && (state.userIntent === 'down' || state.pointerActive)) {
          _setFollowing(state, true); state.userIntent = false;
        } else if (scroll.scrollTop < state.lastTop - 1 && state.userIntent) _setFollowing(state, false);
        state.lastTop = scroll.scrollTop;
        _schedulePin(state);
        _updateScrollButton(state);
      }, { passive: true });
      on(button, 'click', () => { state.interaction++; _followLatest(state); });
      if (typeof global.ResizeObserver === 'function') {
        state.observer = new global.ResizeObserver(() => {
          if (!state.scroll) return;
          if (state.follow) _scheduleFollow(state);
          _updateScrollButton(state);
        });
        // Keyboard/composer resizing changes the viewport without changing
        // the transcript height. Preserve the existing reader-follow policy.
        state.observer.observe(scroll);
      }
    }
    activeScrollState = state;
    const ref = String(ctx._ref || '');
    if (state.ref !== ref) {
      _cancelReading(); _cancelFrame(pinFrame); pinFrame = 0;
      state.ref = ref;
      _setFollowing(state, true);
      state.userIntent = false;
      state.pointerActive = false;
    }
    const list = el.querySelector('#nchatList');
    if (state.observer && state.observedList !== list) {
      if (state.observedList) state.observer.unobserve(state.observedList);
      state.observedList = list;
      if (list) state.observer.observe(list);
    }
    _updateScrollButton(state);
    return state;
  }

  /*
   * Anchor history reading to the first visible message key and viewport offset. Restore it
   * after patching despite height changes or node replacement.
   */
  function _captureReadingAnchor(scroll, list) {
    // Several status patches can arrive before paint. Keep the first reading
    // anchor instead of measuring an already-shifted layout as a new baseline.
    if (pendingReadingAnchor?.scroll === scroll && pendingReadingAnchor.list === list &&
        pendingReadingAnchor.current()) return pendingReadingAnchor.anchor;
    const viewportTop = scroll.getBoundingClientRect().top;
    for (const node of list.children) {
      const rect = node.getBoundingClientRect();
      if (rect.height <= 0 || rect.bottom <= viewportTop) continue;
      return { key: node.getAttribute('data-chat-node') || '',
        delta: rect.top - viewportTop, top: scroll.scrollTop };
    }
    return null;
  }
  function _restoreReadingAnchor(scroll, list, anchor) {
    if (pendingReadingAnchor?.scroll === scroll && pendingReadingAnchor.list === list &&
        pendingReadingAnchor.current()) return;
    const ref = ctx._ref, epoch = ctx._viewEpoch, scope = ctx._draftScopeEpoch;
    const top = scroll.scrollTop;
    const state = scroll.__soduworkScrollFollow, interaction = state?.interaction;
    const current = () => {
      const el = ctx._mount();
      return scroll.isConnected && el && ref === ctx._ref && epoch === ctx._viewEpoch && scope === ctx._draftScopeEpoch &&
        el.querySelector('#nchatScroll') === scroll && el.querySelector('#nchatList') === list &&
        scroll.__soduworkScrollFollow === state && !state?.follow && interaction === state?.interaction &&
        Math.abs(scroll.scrollTop - top) <= 1;
    };
    _cancelReading();
    const pending = pendingReadingAnchor = { scroll, list, anchor, current };
    const paint = () => {
      if (pendingReadingAnchor !== pending) return;
      readingFrame = 0; pendingReadingAnchor = null;
      if (!current()) return;
      let node = null;
      if (anchor.key) {
        try { node = list.querySelector('[data-chat-node="' + (global.CSS && CSS.escape ? CSS.escape(anchor.key) : anchor.key) + '"]'); }
        catch (_) { node = null; }
      }
      if (node) {
        const drift = node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.delta;
        if (Math.abs(drift) > 1) scroll.scrollTop += drift; // The browser clamps scrolling to the valid range.
      } else {
        const maxTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
        scroll.scrollTop = Math.min(anchor.top, maxTop);
      }
    };
    readingFrame = typeof global.requestAnimationFrame === 'function'
      ? global.requestAnimationFrame(paint) : setTimeout(paint, 16);
  }

    return { _releaseScrollFollow, _ensureScrollFollow, _nearBottom, _followLatest, _updateScrollButton, _captureReadingAnchor, _restoreReadingAnchor, _preserveReadingPosition };
  }
  global.ChatScrollFollow = { create };
})(window);
