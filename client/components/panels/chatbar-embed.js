/*
 * Application conversation sidebar using desk.html, NativeChat, and the real send
 * pipeline. The main process owns composerDockBounds geometry; this page renders state and
 * reports interactions. Preserve compatibility with rail, float, and pinned state
 * messages.
 */
(function (global) {
  'use strict';
  if (global.__deskPanel !== 'chatbar') return;
  const api = global.soduWorkAPI || global.SoduWorkAPI;
  if (!api || !api.workPreview || typeof api.workPreview.composerHello !== 'function') return;

  let currentSessionId = '';
  // Account/config hydration must finish before the first send captures its
  // draft scope. Otherwise boot can invalidate an already displayed pending turn.
  let markReady;
  const ready = global.__soduWorkChatbarReady ? Promise.resolve() : new Promise(resolve => { markReady = resolve; });
  global.addEventListener('soduwork-chatbar-ready', () => markReady?.(), { once: true });

  function inputEl() { return document.getElementById('nchatInput'); }

  function fill(text, append) {
    const input = inputEl();
    if (!input || !text) return;
    input.value = (append && input.value.trim() ? input.value + '\n\n' : '') + String(text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }

  /* Legacy input-card collapse state is independent of sidebar rail/pinned state. */
  function setCollapsed(collapsed) {
    document.documentElement.classList.toggle('chatbar-collapsed', Boolean(collapsed));
  }

  /*
   * body[data-composer-state] controls the collapsed rail, floating overlay, and full-height
   * pinned styles.
   */
  let composerState = 'rail';
  function applyState(state) {
    composerState = (state === 'pinned' || state === 'float' || state === 'rail') ? state : 'rail';
    document.body.dataset.composerState = composerState;
    const railButton = document.getElementById('chatbarRailBtn');
    if (railButton) {
      const expanded = composerState !== 'rail';
      railButton.title = expanded ? '折叠对话侧栏' : '对话（点击展开并固定）';
      railButton.setAttribute('aria-label', railButton.title);
      railButton.setAttribute('aria-expanded', String(expanded));
    }
  }
  function setMode(patch) {
    try { void api.workPreview.composerSetMode(patch || {}); } catch (_) {}
  }

  async function followSession(sessionId) {
    if (!sessionId || sessionId === currentSessionId) return;
    try {
      if (global.NativeChat && typeof NativeChat.enter === 'function' && await NativeChat.enter('', sessionId)) currentSessionId = sessionId;
    } catch (_) { /* The conversation may already be closed; retain current state. */ }
  }

  api.workPreview.onComposerSession(({ sessionId }) => { void followSession(sessionId); });
  api.workPreview.onComposerPut((payload) => { if (payload.text) fill(payload.text, payload.append); });
  // Serialize admission, not execution: rapid page clicks must observe the
  // preceding submission's busy state before choosing their conversation.
  let submissionTail = Promise.resolve();
  api.workPreview.onComposerSubmit(payload => {
    const submission = submissionTail.then(() => submitFromPage(payload));
    submissionTail = submission.catch(() => {});
    return submission;
  });
  api.workPreview.onComposerAutomation?.(payload=>{
    const admission=submissionTail.then(async()=>{
      let result;
      try{
        await ready; await global.SoduWorkAppConversations?.ready();
        if(!global.NativeChat?.runAppAutomation)throw Error('即用对话尚未就绪');
        result=await NativeChat.runAppAutomation(payload.params,async()=>{
          const permission=await api.workPreview.authorizeComposerAutomation(payload.id);
          if(!permission?.ok)throw Error('即用创建权限已变化，请重新发起');
        });
      }catch(error){result={ok:false,reason:String(error.message || error)};}
      await api.workPreview.composerAutomationResult({id:payload.id,result});
    });
    submissionTail=admission.catch(()=>{});
  });
  async function submitFromPage(payload) {
    let ok = false, reason = '';
    try {
      let timer;
      try { await Promise.race([ready, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('对话初始化尚未完成，请稍后重试')), 30000);
      })]); } finally { clearTimeout(timer); }
      await global.SoduWorkAppConversations?.ready();
      if (payload.kind === 'mention') {
        if(!global.NativeChat?.openAppMention)throw Error('当前客户端尚未支持同事提及');
        const opened=await NativeChat.openAppMention(payload.mention || {});
        await api.workPreview.composerSubmitResult({id:payload.id,ok:opened?.ok===true,state:opened?.state,reason:opened?.reason});
        return;
      }
      if (!global.NativeChat?.send) throw Error('对话尚未就绪');
      if (NativeChat.isBusy?.() || NativeChat.sessionInfo?.()?.sessionUnavailable) {
        // Use the same navigation lifecycle as the new-topic button. Reset
        // retains the old draft and releases its view without stopping its run.
        NativeChat.reset();
        await NativeChat.prepare();
      }
      // An explicit override sends the app task without consuming the user's
      // composer text, attachments or selected skills.
      let missingBeforeSend = false;
      const options = { useComposer: false, ...(payload.attachments?.length ? { attachments: payload.attachments } : {}),
        onAdmission: result => { missingBeforeSend = result?.notSent === true && result.code === 'SESSION_NOT_FOUND'; } };
      ok = await NativeChat.send(payload.text, options);
      // Only a definite missing-session rejection permits one new-topic
      // attempt. Model/auth/quota failures and uncertain sends are not retried.
      if (!ok && missingBeforeSend) {
        NativeChat.reset(); await NativeChat.prepare();
        ok = await NativeChat.send(payload.text, { ...options, onAdmission: undefined });
      }
      if (!ok) reason = '发送未被接受，请查看右侧对话中的错误并重试';
    } catch (error) { reason = String(error.message || error); }
    void api.workPreview.composerSubmitResult({ id: payload.id, ok, reason });
  }
  let turnWasBusy = false, observedRef = '';
  let reportedBusy = false;
  function reportActivity(busy) {
    if (reportedBusy === busy) return;
    reportedBusy = busy;
    void api.workPreview.composerActivity?.(busy);
  }
  function observeTurn(snapshot) {
    const ref = global.NativeChat?.sessionInfo?.()?.ref || '';
    if (!snapshot) { if (ref !== observedRef) { observedRef = ref; turnWasBusy = false; reportActivity(false); } return; }
    const busy = ['streaming', 'queued'].includes(snapshot.status) || !!snapshot.execution?.running;
    reportActivity(busy);
    if (ref !== observedRef) { observedRef = ref; turnWasBusy = busy; return; }
    if (ref && turnWasBusy && !busy) void api.workPreview.composerTurnSettled?.();
    turnWasBusy = busy;
  }
  const turnTimer = setInterval(observeTurn, 400);
  const offTurn = api.conversationSession?.onEvent?.(event => {
    if (event.ref === global.NativeChat?.sessionInfo?.()?.ref && event.snapshot) observeTurn(event.snapshot);
  });
  global.addEventListener('beforeunload', () => { clearInterval(turnTimer); offTurn?.(); }, { once: true });

  /* Apply application theme messages through HTML attributes and CSS variables. */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-composer-theme', theme === 'dark' ? 'dark' : 'light');
  }

  /* Mode messages synchronize state and main-process width/margin declarations. */
  let resizeController;
  api.workPreview.onComposerMode((mode) => {
    setCollapsed(mode.collapsed);
    applyTheme(mode.theme);
    applyState(mode.state || (mode.expanded ? 'pinned' : 'rail'));
    resizeController?.setWidthInset(mode.widthInset);
  });

  /*
   * User toggles switch between collapsed rail and pinned sidebar; hover does not expand.
   * Bridge expand/collapse actions use the same state machine.
   */
  const RAIL_ICON = '<span class="chatbar-sprite"><img src="icon.png" alt="" draggable="false"></span>';
  const PIN_SVG = '<svg viewBox="0 0 24 72" aria-hidden="true"><path class="chatbar-pin-outline" d="M0 0 16 6.7C21.5 9 24 12.5 24 18V54C24 59.5 21.5 63 16 65.3L0 72Z"/><path d="m9 30 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function installRailDrag(button, finishArrival) {
    let drag = null, suppressClick = false, frame = 0, pendingY;
    const sendPosition = () => {
      frame = 0;
      if (pendingY !== undefined) { setMode({ railScreenY: pendingY }); pendingY = undefined; }
    };
    button.addEventListener('pointerdown', event => {
      if (composerState !== 'rail' || event.button !== 0 || !event.isPrimary) return;
      finishArrival();
      const rect = button.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.screenX, y: event.screenY,
        offset: event.clientY - rect.top - rect.height / 2, active: false };
      suppressClick = false;
      try { button.setPointerCapture(event.pointerId); } catch (_) {}
    });
    button.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      if (!drag.active && Math.hypot(event.screenX - drag.x, event.screenY - drag.y) < 4) return;
      drag.active = true;
      button.classList.add('is-dragging');
      pendingY = event.screenY - drag.offset;
      if (!frame) frame = requestAnimationFrame(sendPosition);
    });
    const endDrag = event => {
      if (!drag || (event.pointerId !== undefined && event.pointerId !== drag.id)) return;
      suppressClick = drag.active;
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      sendPosition();
      const id = drag.id;
      drag = null;
      button.classList.remove('is-dragging');
      try { if (button.hasPointerCapture(id)) button.releasePointerCapture(id); } catch (_) {}
    };
    button.addEventListener('pointerup', endDrag);
    button.addEventListener('pointercancel', endDrag);
    button.addEventListener('lostpointercapture', endDrag);
    global.addEventListener('blur', endDrag);
    button.addEventListener('click', event => {
      if (suppressClick) { suppressClick = false; event.preventDefault(); return; }
      setMode({ expanded: composerState === 'rail' });
    });
  }

  function installSidebarChrome() {
    /* Animate the brand companion once on entry; hover reveals the icon and clicking opens chat. */
    if (!document.getElementById('chatbarRail')) {
      const rail = document.createElement('div');
      rail.id = 'chatbarRail';
      rail.classList.add('is-arriving');
      rail.innerHTML = '<button id="chatbarRailBtn" type="button" title="对话（点击展开并固定）">' + RAIL_ICON + '</button>';
      document.body.appendChild(rail);
      const finishArrival = () => {
        if (!rail.classList.contains('is-arriving')) return;
        rail.classList.remove('is-arriving');
        setMode({ railArrival: false });
      };
      rail.addEventListener('animationend', event => {
        if (event.animationName === 'chatbar-sprite-arrive') finishArrival();
      });
      rail.addEventListener('pointerenter', finishArrival, { once: true });
      rail.addEventListener('focusin', finishArrival, { once: true });
      installRailDrag(rail.querySelector('button'), finishArrival);
      // Also finish when reduced motion prevents animationend or the renderer is occluded.
      if (global.matchMedia('(prefers-reduced-motion: reduce)').matches) finishArrival();
      else setTimeout(finishArrival, 1700);
    }
    applyState(composerState);
    /* Both edge handles share the same collapse action, independent of message scrolling. */
    for (const id of ['chatbarPin', 'chatbarPinRight']) {
      if (document.getElementById(id)) continue;
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.id = id;
      pin.title = '折叠对话侧栏';
      pin.setAttribute('aria-label', pin.title);
      pin.innerHTML = PIN_SVG;
      pin.addEventListener('click', () => setMode({ expanded: false }));
      document.body.appendChild(pin);
    }
  }

  /* Notify the main window after NativeChat.send succeeds. */
  if (global.NativeChat && typeof NativeChat.send === 'function') {
    const originalSend = NativeChat.send.bind(NativeChat);
    NativeChat.send = async (...args) => {
      const result = await originalSend(...args);
      try { if (result === true) void api.workPreview.composerSent(); } catch (_) {}
      return result;
    };
  }

  /* Mount the conversation and composer through prepare/_mount, then request initial state from the main process. */
  function boot() {
    if (!(global.NativeChat && typeof NativeChat.prepare === 'function')) {
      setTimeout(boot, 120);
      return;
    }
    try { NativeChat.prepare(); } catch (_) {}
    fixInputHeight();
    resizeController = global.SoduWorkChatbarResize?.install(api.workPreview);
    installSidebarChrome();
    try {
      const hello = api.workPreview.composerHello();
      void global.SoduWorkAppConversations?.start(hello, ready);
    } catch (_) {}
  }
  /*
   * Before styles load, scrollHeight can be zero and leave an inline height:0. Clear it once
   * min-height is available.
   */
  function fixInputHeight() {
    const input = inputEl();
    if (!input) { setTimeout(fixInputHeight, 150); return; }
    const minH = parseFloat(getComputedStyle(input).minHeight || '0');
    if (!(minH > 20)) { setTimeout(fixInputHeight, 120); return; }
    input.style.height = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (parseFloat(input.style.height || '0') < 10) input.style.height = String(minH) + 'px';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
