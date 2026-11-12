(function (global) {
  'use strict';
  function normalizeSingleLineInput(input) {
    const raw = String(input.value || '');
    const clean = raw.replace(/[\r\n]/g, '');
    if (clean === raw) return;
    const start = typeof input.selectionStart === 'number' ? input.selectionStart : raw.length;
    const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : start;
    const removedBeforeStart = (raw.slice(0, start).match(/[\r\n]/g) || []).length;
    const removedBeforeEnd = (raw.slice(0, end).match(/[\r\n]/g) || []).length;
    input.value = clean;
    try {
      input.setSelectionRange(
        Math.max(0, Math.min(clean.length, start - removedBeforeStart)),
        Math.max(0, Math.min(clean.length, end - removedBeforeEnd))
      );
    } catch (_) { /* Some native input implementations do not expose selection APIs. */ }
  }
  function bindSingleLineInput(input) {
    input.addEventListener('beforeinput', event => {
      if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') event.preventDefault();
    });
    input.addEventListener('input', () => normalizeSingleLineInput(input));
  }
  function mount(gate, hooks) {
    const ui = global.AccountUI;
    // Established accounts may use a username, employee number, or email.
    // Email verification is an explicit registration / recovery flow instead
    // of the default login mode.
    let mode = 'password', policy = null, revision = 0, busy = false, sending = false;
    let policyError = false;
    let legalLocales = {};
    let challenge = null, cooldownUntil = 0, clock = null, pendingPasswordMode = false;
    let delivery = null, deliveryTimer = null, disposed = false, statusSource = '';
    gate.classList.add('ac-auth');
    gate.innerHTML = '<main class="soduwork-auth-card ac-auth-card">' +
      '<header class="ac-brand"><img src="icon.png" alt="" width="32" height="32"><b>SoduWork</b><span>让工作更简单</span></header>' +
      '<h1 id="soduWorkAuthTitle">欢迎回来</h1><p class="ac-auth-intro">使用账号和密码登录</p>' +
      '<div class="ac-auth-tabs" role="tablist" aria-label="登录方式"><button type="button" role="tab" data-auth-mode="emailCode">验证码登录</button>' +
      '<button type="button" role="tab" data-auth-mode="password">密码登录</button></div>' +
      '<form class="soduwork-auth-form ac-auth-form" novalidate>' +
      '<label><span class="ac-account-label">账号</span><input id="soduWorkAuthAccount" name="username" type="text" autocomplete="username" maxlength="254" placeholder="输入账号" required></label>' +
      '<label data-auth-code><span>邮箱验证码</span><span class="ac-code-row"><input id="acEmailCode" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="6 位验证码">' +
      '<button type="button" class="ac-secondary" data-send-code>获取验证码</button></span></label>' +
      '<label data-auth-password hidden><span class="ac-password-label">密码</span><span class="ac-password-row"><input id="soduWorkAuthPassword" type="password" autocomplete="current-password" maxlength="128" placeholder="输入密码">' +
      '<button type="button" class="ac-text" data-password-toggle="soduWorkAuthPassword" aria-label="显示密码" aria-pressed="false">显示</button></span></label>' +
      '<label data-auth-confirm hidden><span>确认密码</span><input id="acConfirmPassword" type="password" autocomplete="new-password" maxlength="128" placeholder="再次输入密码"></label>' +
      '<div class="ac-consent" data-auth-consent hidden><label><input id="acConsent" type="checkbox"><span>我已阅读并同意</span></label>' +
      '<button type="button" class="ac-link" data-legal="terms">《用户协议》</button><span data-consent-and>和</span><button type="button" class="ac-link" data-legal="privacy">《隐私政策》</button></div>' +
      '<div class="soduwork-auth-status" role="status" aria-live="polite"></div>' +
      '<div class="ac-status" data-mail-availability hidden><span data-mail-message></span> ' +
      '<button type="button" class="ac-link" data-recheck-policy>重新检查</button></div>' +
      '<div class="soduwork-auth-recovery" hidden><button type="button" class="soduwork-auth-retry" hidden>重试连接</button></div>' +
      '<button class="soduwork-auth-submit ac-primary" type="submit"><span>登录</span></button></form>' +
      '<nav class="ac-auth-links"><button type="button" class="ac-link" data-auth-mode="register">创建账号</button><button type="button" class="ac-link" data-auth-mode="resetPassword">忘记密码</button></nav>' +
      '<button type="button" class="ac-link ac-auth-back" data-auth-mode="password" hidden>返回登录</button>' +
      '<footer class="ac-auth-footer"><div class="ac-auth-connection-note"><span class="soduwork-auth-secure"><i></i>密码和验证码不会保存在本机</span><span class="soduwork-auth-hub">连接 <b></b></span></div><div class="ac-auth-legal-links"><button type="button" class="ac-link" data-legal="terms">用户协议</button><i aria-hidden="true">·</i><button type="button" class="ac-link" data-legal="privacy">隐私政策</button></div>' +
      '<label class="ac-auth-language" hidden><span>界面语言</span><select data-auth-language translate="no"></select></label></footer></main>';
    const form = gate.querySelector('form'), account = gate.querySelector('#soduWorkAuthAccount');
    const password = gate.querySelector('#soduWorkAuthPassword'), confirm = gate.querySelector('#acConfirmPassword');
    const code = gate.querySelector('#acEmailCode'), consent = gate.querySelector('#acConsent');
    const status = gate.querySelector('.soduwork-auth-status'), submit = gate.querySelector('[type="submit"]');
    const send = gate.querySelector('[data-send-code]');
    const language = gate.querySelector('[data-auth-language]');
    const consentRequiredMessage = '请阅读并同意用户协议和隐私政策。';
    const api = () => hooks.api();
    const tx = value => (global.SoduWorkI18n && typeof global.SoduWorkI18n.translateText === 'function')
      ? global.SoduWorkI18n.translateText(String(value || '')) : String(value || '');
    function setStatus(message, kind) {
      statusSource = String(message || '');
      status.textContent = tx(statusSource);
      status.className = 'soduwork-auth-status' + (kind ? ' is-' + kind : '');
    }
    function modeCopy() {
      return mode === 'register'
        ? { title: '创建你的账号', intro: '验证邮箱后即可使用，无需等待审核' }
        : mode === 'resetPassword'
          ? { title: '找回密码', intro: '验证邮箱后，设置新的登录密码' }
          : mode === 'emailCode'
            ? { title: '欢迎回来', intro: '使用邮箱验证码登录' }
            : { title: '欢迎回来', intro: '使用账号和密码登录' };
    }
    function refreshLocale() {
      const copy = modeCopy();
      const text = (selector, source) => {
        const node = gate.querySelector(selector);
        if (node) node.textContent = tx(source);
      };
      const attr = (selector, name, source) => {
        const node = gate.querySelector(selector);
        if (node) node.setAttribute(name, tx(source));
      };
      text('.ac-brand span', '让工作更简单');
      text('h1', copy.title); text('.ac-auth-intro', copy.intro);
      attr('.ac-auth-tabs', 'aria-label', '登录方式');
      text('[data-auth-mode="emailCode"]', '验证码登录');
      text('[data-auth-mode="password"]', '密码登录');
      text('[data-auth-code] > span', '邮箱验证码');
      text('[data-send-code]', '获取验证码');
      text('.ac-password-label', mode === 'password' ? '密码' : '设置密码');
      text('[data-auth-confirm] > span', '确认密码');
      const toggle = gate.querySelector('[data-password-toggle]');
      if (toggle) {
        const shown = password.type === 'text';
        toggle.textContent = tx(shown ? '隐藏' : '显示');
        toggle.setAttribute('aria-label', tx(shown ? '隐藏密码' : '显示密码'));
      }
      const passwordLogin = mode === 'password';
      text('.ac-account-label', passwordLogin ? '账号' : '邮箱');
      account.placeholder = tx(passwordLogin ? '输入账号' : 'name@example.com');
      password.placeholder = tx('输入密码');
      confirm.placeholder = tx('再次输入密码');
      const consentText = gate.querySelector('.ac-consent label span');
      if (consentText) consentText.textContent = tx('我已阅读并同意');
      text('[data-consent-and]', '和');
      gate.querySelectorAll('[data-legal]').forEach(node => {
        node.textContent = tx(node.dataset.legal === 'privacy' ? '隐私政策' : '用户协议');
      });
      text('[data-recheck-policy]', '重新检查');
      text('.soduwork-auth-retry', '重试连接');
      text('[data-auth-mode="register"]', '创建账号');
      text('[data-auth-mode="resetPassword"]', '忘记密码');
      text('.ac-auth-back', '返回登录');
      text('.ac-auth-language > span', '界面语言');
      language.setAttribute('aria-label', tx('界面语言'));
      language.value = global.SoduWorkI18n?.getLocale?.() || '';
      text('.soduwork-auth-secure', '密码和验证码不会保存在本机');
      const hub = gate.querySelector('.soduwork-auth-hub');
      if (hub && hub.firstChild && hub.firstChild.nodeType === 3) hub.firstChild.nodeValue = tx('连接 ');
      if (!busy) text('.soduwork-auth-submit span', actionLabel());
      refreshCooldown(); refreshAvailability();
      if (statusSource) status.textContent = tx(statusSource);
    }
    function actionLabel() { return mode === 'register' ? '注册并进入工作区' : mode === 'resetPassword' ? '重置密码' : '登录'; }
    function supportsEmail() { return typeof policy?.mailReady === 'boolean'; }
    function canMail() { return !policyError && policy?.mailReady === true; }
    function refreshAvailability() {
      const unavailable = policyError || !!policy && !canMail();
      gate.querySelector('[data-mail-availability]').hidden = !unavailable;
      gate.querySelector('[data-mail-message]').textContent = tx(policyError
        ? '暂时无法读取邮件服务状态，请重新检查。'
        : !unavailable ? '' : !supportsEmail()
        ? '当前服务版本不支持邮箱验证，请更新服务或使用密码登录。'
        : '管理员尚未配置或启用邮件服务，请联系管理员，或使用密码登录。');
    }
    function identityScope() {
      const bridge = api(), identity = bridge?.clientAuthSnapshot?.() || {};
      return JSON.stringify([bridge?.hubBase?.() || '', identity.clientId || '', identity.user?.id || '']);
    }
    function current(state, authenticated = false) { return !disposed && gate.hidden !== true && gate.isConnected !== false &&
      state.revision === revision && (authenticated ? state.hub === api()?.hubBase?.() : state.scope === identityScope()) &&
      state.email === account.value.trim(); }
    function stamp() { return { revision, email: account.value.trim(), scope: identityScope(), hub: api()?.hubBase?.() }; }
    function stopDelivery() {
      delivery = null;
      if (deliveryTimer !== null) clearTimeout(deliveryTimer);
      deliveryTimer = null;
    }
    function deliveryMessage(result) {
      if (result.deliveryState === 'sent') return '邮件服务已发送验证码，请查看邮箱（包括垃圾邮件）。';
      if (result.deliveryState === 'expired') return '验证码已过期，请重新获取。';
      if (['MAIL_NOT_READY', 'SMTP_AUTH_FAILED', 'SMTP_TLS_FAILED', 'MAIL_INTERNAL_ERROR'].includes(result.errorCode))
        return '邮件服务暂不可用，请联系管理员检查邮件配置。';
      if (result.errorCode === 'SMTP_RECIPIENT_REJECTED') return '收件邮箱拒收了验证码，请核对邮箱地址后稍后重试。';
      if (result.deliveryState === 'failed') return '验证码邮件发送失败，请稍后重试；持续失败请联系管理员。';
      return '暂未确认邮件发送结果，请先查看邮箱（包括垃圾邮件），未收到可稍后重试。';
    }
    function finishDelivery(result) {
      stopDelivery();
      if (['failed', 'expired'].includes(result.deliveryState)) challenge = null;
      setStatus(deliveryMessage(result), result.deliveryState === 'sent' ? 'success' :
        ['failed', 'expired'].includes(result.deliveryState) ? 'error' : 'working');
    }
    function watchDelivery(state, result) {
      stopDelivery();
      if (!['queued', 'sending', 'retry'].includes(result.deliveryState)) return;
      const request = delivery = { state, id: result.challengeId, until: Date.now() + 60000, attempts: 0 };
      async function poll() {
        deliveryTimer = null;
        if (delivery !== request || !current(state) || busy) { if (delivery === request) stopDelivery(); return; }
        if (Date.now() >= request.until || request.attempts >= 20) { finishDelivery({ deliveryState: 'unknown' }); return; }
        request.attempts++;
        try {
          const latest = await api().clientAccountAction('emailChallengeStatus', { challengeId: request.id });
          if (delivery !== request || !current(state) || busy) { if (delivery === request) stopDelivery(); return; }
          if (!latest?.ok) {
            // Old Hubs and unavailable challenges stop here; never loop on 404 or a lost identity.
            if ([400, 401, 403, 404, 405].includes(latest?.status)) { finishDelivery({ deliveryState: 'unknown' }); return; }
          } else if (latest.challengeId !== request.id || !latest.deliveryState) {
            finishDelivery({ deliveryState: 'unknown' }); return;
          } else if (!['queued', 'sending', 'retry'].includes(latest.deliveryState)) {
            finishDelivery(latest); return;
          }
        } catch (_) {
          if (delivery !== request || !current(state) || busy) { if (delivery === request) stopDelivery(); return; }
        }
        deliveryTimer = setTimeout(poll, Math.min(3000, Math.max(0, request.until - Date.now())));
      }
      deliveryTimer = setTimeout(poll, 1000);
    }
    function refreshCooldown() {
      const seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      send.textContent = sending ? tx('正在发送…') : seconds ? seconds + ' ' + tx('秒后重发') : tx('获取验证码');
      send.disabled = busy || sending || seconds > 0 || !canMail();
      if (!seconds && clock) { clearInterval(clock); clock = null; }
    }
    function setBusy(value, label) {
      busy = !!value;
      if (busy) stopDelivery();
      if (!busy && pendingPasswordMode) { pendingPasswordMode = false; changeMode('password'); return; }
      form.querySelectorAll('input,button').forEach(el => { el.disabled = busy; });
      gate.querySelectorAll('[data-auth-mode]').forEach(el => { el.disabled = busy || (el.dataset.authMode === 'register' && policy?.allowSelfRegistration === false); });
      submit.querySelector('span').textContent = tx(label || (busy ? '正在处理…' : actionLabel()));
      submit.classList.toggle('is-busy', busy); refreshCooldown();
    }
    function changeMode(next) {
      if (busy) return;
      stopDelivery();
      revision++; mode = next; challenge = null; code.value = ''; password.value = ''; confirm.value = '';
      password.type = 'password'; consent.checked = false;
      gate.querySelector('[data-password-toggle]').textContent = tx('显示');
      const login = mode === 'emailCode' || mode === 'password';
      gate.querySelector('.ac-auth-tabs').hidden = !login;
      gate.querySelector('.ac-auth-links').hidden = !login;
      gate.querySelector('.ac-auth-back').hidden = login;
      gate.querySelector('h1').textContent = tx(modeCopy().title);
      gate.querySelector('.ac-auth-intro').textContent = tx(modeCopy().intro);
      gate.querySelector('[data-auth-code]').hidden = mode === 'password';
      gate.querySelector('[data-auth-password]').hidden = mode === 'emailCode';
      gate.querySelector('[data-auth-confirm]').hidden = !['register', 'resetPassword'].includes(mode);
      gate.querySelector('[data-auth-consent]').hidden = mode !== 'register';
      gate.querySelector('.ac-password-label').textContent = tx(mode === 'password' ? '密码' : '设置密码');
      const passwordLogin = mode === 'password';
      gate.querySelector('.ac-account-label').textContent = tx(passwordLogin ? '账号' : '邮箱');
      account.type = passwordLogin ? 'text' : 'email';
      account.maxLength = 254;
      account.placeholder = tx(passwordLogin ? '输入账号' : 'name@example.com');
      password.autocomplete = mode === 'password' ? 'current-password' : 'new-password';
      gate.querySelectorAll('[role="tab"]').forEach(el => el.setAttribute('aria-selected', String(el.dataset.authMode === mode)));
      setStatus(''); refreshAvailability();
      setBusy(false); refreshLocale(); account.focus();
    }
    bindSingleLineInput(account);
    account.addEventListener('input', () => { stopDelivery(); revision++; challenge = null; code.value = ''; setStatus(''); });
    code.addEventListener('input', () => { code.value = code.value.replace(/\D/g, '').slice(0, 6); });
    consent.addEventListener('change', () => {
      if (mode === 'register' && consent.checked && policy?.requiredConsentVersions?.terms && policy?.requiredConsentVersions?.privacy &&
          status.classList.contains('is-error') && statusSource === consentRequiredMessage) setStatus('');
    });
    gate.querySelectorAll('[data-auth-mode]').forEach(button => button.addEventListener('click', () => changeMode(button.dataset.authMode)));
    gate.querySelectorAll('[data-legal]').forEach(button => button.addEventListener('click', () => ui.legal(gate, policy?.legalDocuments || [], button.dataset.legal, {
      returnLabel: mode === 'register' ? '返回注册' : mode === 'resetPassword' ? '返回找回密码' : '返回登录',
      requiredVersions: policy?.requiredConsentVersions,
      onSelection: doc => { if (doc?.key) legalLocales[doc.key] = { version: doc.version, locale: doc.locale || '' }; },
      getScope: identityScope,
      load: typeof api()?.clientAuthPolicy === 'function' ? () => api().clientAuthPolicy() : undefined,
      onLoaded: result => setPolicy(result)
    })));
    const languages = global.SoduWorkI18n?.options?.() || [];
    gate.querySelector('.ac-auth-language').hidden = languages.length < 2;
    languages.forEach(item => {
      const option = document.createElement('option');
      option.value = item.value; option.textContent = item.label; language.appendChild(option);
    });
    language.addEventListener('change', () => global.SoduWorkI18n?.setLocale?.(language.value));
    ui.bindPassword(gate);
    gate.querySelector('.soduwork-auth-retry').addEventListener('click', hooks.retry);
    gate.querySelector('[data-recheck-policy]').addEventListener('click', () => {
      if (busy || sending) return;
      stopDelivery();
      revision++; challenge = null; code.value = '';
      hooks.retry();
    });
    send.addEventListener('click', async () => {
      if (!ui.email(account.value)) { setStatus('请输入有效的邮箱地址。', 'error'); account.focus(); return; }
      if (!canMail() || sending || busy || cooldownUntil > Date.now()) return;
      const state = stamp(); sending = true; refreshCooldown(); setStatus('');
      try {
        const result = ui.check(await api().clientAccountAction('emailChallenge', {
          email: state.email, purpose: mode === 'register' ? 'register' : mode === 'resetPassword' ? 'reset_password' : 'login'
        }));
        if (!current(state)) return;
        challenge = { id: result.challengeId, email: state.email, expires: Date.now() + result.expiresIn * 1000 };
        cooldownUntil = Date.now() + result.retryAfter * 1000;
        setStatus('验证码发送请求已受理，正在确认发送结果…', 'working'); code.focus();
        if (['queued', 'sending', 'retry'].includes(result.deliveryState)) watchDelivery(state, result);
        else if (result.deliveryState) finishDelivery(result);
        else setStatus('验证码发送请求已受理，请查看邮箱（包括垃圾邮件）；未收到可稍后重试。', 'working');
        if (clock) clearInterval(clock);
        clock = setInterval(refreshCooldown, 1000);
      } catch (error) { if (current(state)) setStatus(ui.error(error), 'error'); }
      finally { sending = false; refreshCooldown(); }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy) return;
      const value = account.value.trim();
      if (mode === 'password' ? value.length < 3 : !ui.email(value)) { setStatus('请输入有效的邮箱或账号。', 'error'); account.focus(); return; }
      if (mode !== 'password' && (!challenge || challenge.email !== value || challenge.expires <= Date.now())) {
        setStatus('请先获取有效的邮箱验证码。', 'error'); code.focus(); return;
      }
      if (mode !== 'password' && !ui.code(code.value)) { setStatus('请输入 6 位验证码。', 'error'); code.focus(); return; }
      if (mode !== 'emailCode' && !password.value) { setStatus('请输入密码。', 'error'); password.focus(); return; }
      if (['register', 'resetPassword'].includes(mode)) {
        if (password.value.length < (policy?.passwordMinLength || 8)) { setStatus('密码长度不足，请按要求重新填写。', 'error'); return; }
        if (password.value !== confirm.value) { setStatus('两次输入的密码不一致。', 'error'); confirm.focus(); return; }
      }
      if (mode === 'register' && (!consent.checked || !policy?.requiredConsentVersions?.terms || !policy?.requiredConsentVersions?.privacy)) {
        setStatus(consentRequiredMessage, 'error'); consent.focus(); return;
      }
      const state = stamp(), action = mode;
      const payload = { email: value, password: password.value, newPassword: password.value,
        challengeId: challenge?.id || '', code: code.value, consents: policy?.requiredConsentVersions || {} };
      if (action === 'register') payload.consentLocales = Object.fromEntries(['terms', 'privacy'].map(kind => {
        const selected = ui.legalSelection?.(policy?.legalDocuments, kind, global.SoduWorkI18n?.getLocale?.() || 'zh-CN', policy?.requiredConsentVersions?.[kind]).document;
        const read = legalLocales[kind];
        return [kind, (read?.version === policy?.requiredConsentVersions?.[kind] ? read.locale : selected?.locale) || ''];
      }));
      setBusy(true); setStatus('');
      try {
        const result = ui.check(await (action === 'password' && (!ui.email(value) || (policy && !supportsEmail()))
          ? api().clientLogin({ account: value, password: password.value }) : api().clientAccountAction(action, payload)));
        // The API fences concurrent auth changes; first login can also establish the real device ID.
        if (!current(state, true)) return;
        password.value = ''; confirm.value = ''; code.value = ''; password.type = 'password';
        if (action === 'resetPassword') {
          setBusy(false); changeMode('password'); setStatus('密码已重置，请用新密码登录。', 'success'); return;
        }
        setStatus('验证成功，正在进入工作区…', 'success'); hooks.success(result);
      } catch (error) {
        if (current(state) && error?.code === 'CONSENT_REQUIRED') {
          consent.checked = false;
          try { const latest = await api().clientAuthPolicy(); if (current(state)) setPolicy(latest); } catch (_) {}
        }
        if (current(state)) { password.value = ''; confirm.value = ''; setStatus(ui.error(error), 'error'); setBusy(false); }
      }
    });
    function setPolicy(next) {
      policyError = false;
      if (policy && ['terms', 'privacy'].some(kind => policy.requiredConsentVersions?.[kind] !== next?.requiredConsentVersions?.[kind])) {
        consent.checked = false; legalLocales = {};
      }
      policy = next || {};
      if (!canMail() && mode === 'emailCode') {
        if (busy) pendingPasswordMode = true; else changeMode('password');
      } else pendingPasswordMode = false;
      gate.querySelector('[data-auth-mode="register"]').hidden = policy.allowSelfRegistration === false;
      refreshAvailability(); refreshCooldown();
    }
    function setPolicyError() {
      policyError = true;
      stopDelivery(); refreshAvailability(); refreshCooldown();
    }
    const onLocaleChange = () => refreshLocale();
    global.addEventListener?.('soduwork-locale-change', onLocaleChange);
    changeMode('password');
    return { form, accountInput: account, passwordInput: password, displayInput: null,
      statusNode: status, submitButton: submit, setBusy, setPolicy, setPolicyError, setStatus,
      invalidate() { stopDelivery(); revision++; challenge = null; password.value = ''; confirm.value = ''; code.value = ''; },
      dispose() { stopDelivery(); disposed = true; revision++; if (clock) clearInterval(clock); global.removeEventListener?.('soduwork-locale-change', onLocaleChange); gate._accountUiPasswordLocaleDispose?.(); delete gate._accountUiPasswordLocaleDispose; } };
  }
  global.EmailAuth = { mount };
})(window);
