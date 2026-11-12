(function (global) {
  'use strict';
  function normalizeSingleLineInput(input) {
    var raw = String(input.value || '');
    var clean = raw.replace(/[\r\n]/g, '');
    if (clean === raw) return;
    var start = typeof input.selectionStart === 'number' ? input.selectionStart : raw.length;
    var end = typeof input.selectionEnd === 'number' ? input.selectionEnd : start;
    var removedBeforeStart = (raw.slice(0, start).match(/[\r\n]/g) || []).length;
    var removedBeforeEnd = (raw.slice(0, end).match(/[\r\n]/g) || []).length;
    input.value = clean;
    try {
      input.setSelectionRange(
        Math.max(0, Math.min(clean.length, start - removedBeforeStart)),
        Math.max(0, Math.min(clean.length, end - removedBeforeEnd))
      );
    } catch (_) { /* Some native input implementations do not expose selection APIs. */ }
  }
  function bindSingleLineInput(input) {
    input.addEventListener('beforeinput', function (event) {
      if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') event.preventDefault();
    });
    input.addEventListener('input', function () { normalizeSingleLineInput(input); });
  }

  /* 密码显隐图标（lucide 风格描边）：睁眼=点击查看，闭眼=点击隐藏 */
  var EYE_VIEW_SVG = '<svg class="soduwork-auth-eye-icon icon-view" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_HIDE_SVG = '<svg class="soduwork-auth-eye-icon icon-hide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>';

  var gate = null;
  var form = null;
  var accountInput = null;
  var passwordInput = null;
  var passwordEye = null;
  var displayInput = null;
  var statusNode = null;
  var submitButton = null;
  var retryButton = null;
  var recoveryNode = null;
  var connectionDetails = null;
  var hubInput = null;
  var hubButton = null;
  var currentUser = null;
  var currentQuota = null;
  var policy = null;
  var booting = false;
  var emailView = null;
  var policyRevision = 0;
  var quotaNotice = null;
  var dismissedQuotaNotice = '';
  function translate(message) { return global.SoduWorkI18n?.translateText(message) || message; }

  function text(value) {
    return String(value == null ? '' : value);
  }

  function api() {
    return global.SoduWorkAPI || null;
  }

  function hubLabel() {
    try {
      var value = api() && api().hubBase ? api().hubBase() : '';
      return value.replace(/^https?:\/\//i, '') || '\u672a\u77e5\u670d\u52a1';
    } catch (e) {
      return '\u672a\u77e5\u670d\u52a1';
    }
  }

  function isConnectionFailure(reason) {
    var raw = text(reason && (reason.error || reason.message || reason.reason));
    return /fetch failed|failed to fetch|econnrefused|connection refused|networkerror|network error|timed? ?out|\u8fde\u63a5\u8d85\u65f6|\u65e0\u6cd5\u8fde\u63a5/.test(raw.toLowerCase());
  }

  function connectionMessage(reason) {
    var detail = reason || {};
    var raw = text(detail.error || detail.message || detail.reason);
    if (!isConnectionFailure(detail)) return raw;
    return '暂时无法连接 SoduWork 服务。请检查网络后重试。';
  }

  /*
   * Show the collapsible endpoint editor only when the main process marks a source launch
   * editable; omit it in installed clients and internalTest fixtures.
   */
  function connectionPanelHtml() {
    var editable = false;
    try {
      var bridge = api();
      editable = !!(bridge && typeof bridge.hubConfig === 'function' && bridge.hubConfig().editable === true);
    } catch (e) {}
    if (!editable) return '';
    return '<details class="soduwork-auth-connection"><summary>服务连接 · 更改地址</summary>' +
        '<label for="soduWorkAuthHub">SoduWork 服务地址</label>' +
        '<div class="soduwork-auth-connection-row"><input id="soduWorkAuthHub" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:18989">' +
          '<button class="soduwork-auth-connect" type="button">保存并连接</button></div>' +
        '<p>使用本机服务，或填写你部署的服务地址。各服务的账号与数据独立保留。</p>' +
      '</details>';
  }

  function mountConnectionPanel() {
    if (!gate || !form) return;
    var existing = gate.querySelector('.soduwork-auth-connection');
    var html = connectionPanelHtml();
    if (html && !existing) {
      form.insertAdjacentHTML('afterbegin', html);
      bindConnectionPanel();
    } else if (!html && existing) {
      existing.remove();
      connectionDetails = null; hubInput = null; hubButton = null;
    }
  }

  function bindConnectionPanel() {
    connectionDetails = gate.querySelector('.soduwork-auth-connection');
    hubInput = gate.querySelector('#soduWorkAuthHub');
    hubButton = gate.querySelector('.soduwork-auth-connect');
    if (!hubInput || !hubButton) return;
    hubInput.value = (function () {
      try { return text(api().hubConfig().hub); } catch (e) { return ''; }
    })();
    hubButton.addEventListener('click', function () {
      var hub = text(hubInput.value).trim();
      var environment = /^(?:https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(hub)
        ? 'development' : 'production';
      switchConnection(environment, hub);
    });
    hubInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); hubButton.click(); }
    });
  }

  /* Reload after the main process confirms the saved endpoint; on failure, keep login open and expand the editor. */
  async function switchConnection(environment, hub) {
    if (hubButton && hubButton.disabled) return;
    setBusy(true, '正在连接服务');
    setStatus('正在保存服务地址并重新连接…', 'working');
    try {
      await api().connectHub(environment, hub);
      if (passwordInput) passwordInput.value = '';
      resetPasswordView();
      if (global.Store && global.Store.beginEnvironmentSwitch) global.Store.beginEnvironmentSwitch();
      if (global.WinSync && global.WinSync.pushHubEnvironment) global.WinSync.pushHubEnvironment();
      global.setTimeout(function () { global.location.reload(); }, 300);
    } catch (error) {
      setBusy(false);
      setStatus(connectionMessage({ error: error && error.message || error }), 'error');
      setRecoveryActions({ error: error && error.message || error });
    }
  }

  function setRecoveryActions(reason) {
    var failed = isConnectionFailure(reason);
    if (recoveryNode) recoveryNode.hidden = !failed;
    if (retryButton) retryButton.hidden = !failed;
    /* Expand endpoint settings after connection failure to allow correction. */
    if (failed && connectionDetails) connectionDetails.open = true;
  }

  function quotaCopy(quota) {
    if (!quota || !quota.enabled) return translate('未启用额度限制');
    var format = function (n) {
      try { return new Intl.NumberFormat((globalThis.SoduWorkI18n?.getLocale() || 'zh-CN')).format(Number(n) || 0); }
      catch (e) { return String(Number(n) || 0); }
    };
    return translate('本月已用 {used} / {limit} Tokens')
      .replace('{used}', format(quota.used)).replace('{limit}', format(quota.limit));
  }

  function showQuotaNotice(detail) {
    updateIdentity(detail.user, detail.quota);
    var noticeKey = JSON.stringify([currentUser?.id, currentQuota?.period, currentQuota?.mode, currentQuota?.limit]);
    if (dismissedQuotaNotice === noticeKey) return;
    if (!quotaNotice) {
      quotaNotice = document.createElement('aside');
      quotaNotice.className = 'soduwork-quota-notice';
      quotaNotice.setAttribute('role', 'alert');
      var message = document.createElement('span');
      var close = document.createElement('button');
      close.type = 'button'; close.textContent = '×';
      close.setAttribute('aria-label', translate('关闭'));
      close.addEventListener('click', function () {
        dismissedQuotaNotice = quotaNotice.dataset.noticeKey;
        quotaNotice.hidden = true;
      });
      quotaNotice.append(message, close);
      document.body.appendChild(quotaNotice);
    }
    var explanation = currentQuota && Number(currentQuota.limit) === 0
      ? '管理员已暂停你的 AI 使用额度。请联系管理员调整后重试；已有对话仍可查看。'
      : '本月 AI Token 额度已用完。请联系管理员调整后重试，或下月恢复后继续；已有对话仍可查看。';
    quotaNotice.dataset.noticeKey = noticeKey;
    quotaNotice.querySelector('span').textContent = translate(explanation) + ' ' + quotaCopy(currentQuota);
    quotaNotice.querySelector('button').setAttribute('aria-label', translate('关闭'));
    quotaNotice.hidden = false;
  }

  /* Mask the password field after submission or clearing so plaintext is not left visible. */
  function resetPasswordView() {
    if (passwordInput) passwordInput.type = 'password';
    if (passwordEye) {
      passwordEye.classList.remove('is-on');
      passwordEye.setAttribute('aria-pressed', 'false');
      passwordEye.setAttribute('aria-label', '\u663e\u793a\u5bc6\u7801');
      passwordEye.title = '\u663e\u793a\u5bc6\u7801';
    }
  }

  function setStatus(message, kind) {
    if (!statusNode) return;
    statusNode.textContent = text(message);
    statusNode.className = 'soduwork-auth-status' + (kind ? ' is-' + kind : '');
  }

  function setBusy(busy, label) {
    if (emailView) { emailView.setBusy(busy, label); return; }
    if (!submitButton) return;
    submitButton.disabled = !!busy;
    submitButton.classList.toggle('is-busy', !!busy);
    submitButton.querySelector('span').textContent = label ||
      (busy ? '\u6b63\u5728\u767b\u5f55' : '\u767b\u5f55\u5e76\u7ee7\u7eed');
    [accountInput, passwordInput, displayInput].forEach(function (input) {
      if (input) input.disabled = !!busy;
    });
    if (passwordEye) passwordEye.disabled = !!busy;
    if (retryButton) retryButton.disabled = !!busy;
    /* Prevent endpoint changes during restore, login, or environment switching. */
    if (hubButton) hubButton.disabled = !!busy;
    if (hubInput) hubInput.disabled = !!busy;
  }

  function createGate() {
    if (gate) return gate;
    gate = document.createElement('div');
    gate.id = 'soduWorkClientAuthGate';
    gate.className = 'soduwork-auth-gate';
    gate.setAttribute('role', 'dialog');
    gate.setAttribute('aria-modal', 'true');
    gate.setAttribute('aria-labelledby', 'soduWorkAuthTitle');
    if (global.EmailAuth) {
      emailView = global.EmailAuth.mount(gate, { api: api, retry: boot,
        success: function (result) {
          updateIdentity(result.user, result.quota);
          global.setTimeout(function () { global.location.reload(); }, 300);
        } });
      form = emailView.form; accountInput = emailView.accountInput; passwordInput = emailView.passwordInput;
      displayInput = null; statusNode = emailView.statusNode; submitButton = emailView.submitButton;
      recoveryNode = gate.querySelector('.soduwork-auth-recovery'); retryButton = gate.querySelector('.soduwork-auth-retry');
      gate.querySelector('.soduwork-auth-hub b').textContent = hubLabel();
      document.body.appendChild(gate); mountConnectionPanel();
      return gate;
    }
    gate.innerHTML =
      '<div class="soduwork-auth-ambient" aria-hidden="true"></div>' +
      '<main class="soduwork-auth-card">' +
        '<header class="soduwork-auth-brand">' +
          '<img class="soduwork-auth-mark" src="icon.png" alt="" draggable="false">' +
          '<span><b>SoduWork</b><small>Enterprise AI Native</small></span>' +
        '</header>' +
        '<section class="soduwork-auth-copy">' +
          '<span class="soduwork-auth-kicker" data-i18n="eyebrow.workspace_access">WORKSPACE ACCESS</span>' +
          '<h1 id="soduWorkAuthTitle">\u767b\u5f55 SoduWork</h1>' +
          '<p>登录后将这台电脑绑定到你的工作区。</p>' +
        '</section>' +
        '<form class="soduwork-auth-form" autocomplete="on">' +
          '<label><span>\u8d26\u53f7</span><input id="soduWorkAuthAccount" name="username" autocomplete="username" maxlength="64" placeholder="\u5de5\u53f7 / \u90ae\u7bb1 / \u624b\u673a\u53f7" required></label>' +
          '<label><span>\u5bc6\u7801</span><span class="soduwork-auth-pw-wrap">' +
            '<input id="soduWorkAuthPassword" name="password" type="password" autocomplete="current-password" maxlength="128" placeholder="\u8bf7\u8f93\u5165\u5bc6\u7801" required>' +
            '<button class="soduwork-auth-pw-eye" type="button" aria-label="\u663e\u793a\u5bc6\u7801" aria-pressed="false" title="\u663e\u793a\u5bc6\u7801">' +
              EYE_VIEW_SVG + EYE_HIDE_SVG +
            '</button>' +
          '</span></label>' +
          '<details class="soduwork-auth-first"><summary>\u9996\u6b21\u4f7f\u7528\uff1f\u53ef\u9009\u586b\u5199\u663e\u793a\u540d</summary>' +
            '<label><span>\u663e\u793a\u540d <em>\u53ef\u9009</em></span><input id="soduWorkAuthDisplayName" name="name" autocomplete="name" maxlength="64" placeholder="\u4f8b\uff1a\u80e1\u8015\u6c38"></label>' +
          '</details>' +
          '<div class="soduwork-auth-status" role="status" aria-live="polite"></div>' +
          '<div class="soduwork-auth-recovery" hidden>' +
            '<button class="soduwork-auth-retry" type="button" hidden>\u91cd\u8bd5\u8fde\u63a5</button>' +
          '</div>' +
          '<button class="soduwork-auth-submit" type="submit"><span>\u767b\u5f55\u5e76\u7ee7\u7eed</span><i aria-hidden="true"></i></button>' +
        '</form>' +
        '<footer><span class="soduwork-auth-secure"><i></i>\u5bc6\u7801\u4e0d\u4f1a\u4fdd\u5b58\u5728\u8fd9\u53f0\u7535\u8111</span>' +
          '<span class="soduwork-auth-form-badge" hidden></span>' +
          '<span class="soduwork-auth-hub">\u8fde\u63a5 <b></b></span></footer>' +
      '</main>';
    document.body.appendChild(gate);
    form = gate.querySelector('form');
    accountInput = gate.querySelector('#soduWorkAuthAccount');
    bindSingleLineInput(accountInput);
    passwordInput = gate.querySelector('#soduWorkAuthPassword');
    passwordEye = gate.querySelector('.soduwork-auth-pw-eye');
    displayInput = gate.querySelector('#soduWorkAuthDisplayName');
    statusNode = gate.querySelector('.soduwork-auth-status');
    submitButton = gate.querySelector('.soduwork-auth-submit');
    recoveryNode = gate.querySelector('.soduwork-auth-recovery');
    retryButton = gate.querySelector('.soduwork-auth-retry');
    var formBadge = gate.querySelector('.soduwork-auth-form-badge');
    if (formBadge) {
      var formBridge = api();
      var isLocalCode = formBridge && typeof formBridge.runtimeForm === 'function' && formBridge.runtimeForm() === 'local-code';
      formBadge.hidden = !isLocalCode;
      formBadge.textContent = isLocalCode ? '本地代码启动' : '';
    }
    gate.querySelector('.soduwork-auth-hub b').textContent = hubLabel();
    passwordEye.addEventListener('click', function () {
      var show = passwordInput.type === 'password';
      passwordInput.type = show ? 'text' : 'password';
      passwordEye.classList.toggle('is-on', show);
      var tip = show ? '\u9690\u85cf\u5bc6\u7801' : '\u663e\u793a\u5bc6\u7801';
      passwordEye.setAttribute('aria-pressed', String(show));
      passwordEye.setAttribute('aria-label', tip);
      passwordEye.title = tip;
    });
    form.addEventListener('submit', submit);
    retryButton.addEventListener('click', function () {
      setBusy(true, '\u6b63\u5728\u91cd\u8bd5\u8fde\u63a5');
      setStatus('\u6b63\u5728\u91cd\u65b0\u8fde\u63a5\u5f53\u524d\u540e\u53f0\u2026', 'working');
      boot();
    });
    return gate;
  }

  function show(reason) {
    if ((reason?.code === 'TOKEN_QUOTA_EXCEEDED' || reason?.state === 'quota') && reason.authenticated === true) {
      showQuotaNotice(reason);
      return;
    }
    if (quotaNotice) quotaNotice.hidden = true;
    createGate();
    gate.hidden = false;
    document.documentElement.classList.add('soduwork-auth-pending');
    document.body.classList.add('soduwork-client-auth-open');
    var detail = reason || {};
    if (detail.code === 'TOKEN_QUOTA_EXCEEDED' || detail.state === 'quota') {
      setStatus(detail.error || '\u672c\u6708 AI Token \u989d\u5ea6\u5df2\u7528\u5b8c\uff0c\u53ef\u6362\u7528\u5176\u4ed6\u8d26\u53f7\u6216\u8054\u7cfb\u7ba1\u7406\u5458\u3002', 'quota');
    } else if (detail.error) {
      setStatus(connectionMessage(detail), 'error');
    }
    mountConnectionPanel();
    setRecoveryActions(detail);
    setTimeout(function () {
      // Do not steal focus after the user has started typing. A previous
      // implementation checked the value after 50ms; the first account
      // character made that branch focus the password field.
      if (!gate || gate.hidden || gate.contains(document.activeElement)) return;
      if (accountInput && !accountInput.value) accountInput.focus();
      else if (passwordInput) passwordInput.focus();
    }, 50);
  }

  function updateIdentity(user, quota) {
    if (user?.id && currentUser?.id && user.id !== currentUser.id) currentQuota = null;
    currentUser = user || currentUser;
    currentQuota = quota || currentQuota;
    global.SoduWorkQuotaNotice?.update({ user: currentUser, quota: currentQuota });
    if (!currentUser) return;
    var name = text(currentUser.displayName).trim() || text(currentUser.username).trim() || '我的';
    ['#wsMine b', '#wsMine .ws-mine-name', '[data-soduwork-user-name]'].forEach(function (selector) {
      document.querySelectorAll(selector).forEach(function (node) { node.textContent = name; });
    });
    document.querySelectorAll('[data-soduwork-user-initial]').forEach(function (node) {
      renderAccountAvatar(node, name);
    });
    mountSettings();
  }

  function clearQuotaNotice() {
    if (currentQuota && typeof currentQuota === 'object') {
      currentQuota = { ...currentQuota, exceeded: false, reason: '', model: null, requestedModel: null };
    }
    global.SoduWorkQuotaNotice?.update({ user: currentUser, quota: currentQuota });
    mountSettings();
    return currentQuota;
  }

  function renderAccountAvatar(node, name) {
    node.textContent = Array.from(name || '我')[0].toLocaleUpperCase();
    var source = text(currentUser && currentUser.avatarUrl);
    if (!/^data:image\/(?:png|jpeg|webp);base64,/.test(source)) return;
    var image = document.createElement('img'); image.src = source; image.alt = '个人头像';
    image.className = 'ac-account-avatar-image'; node.textContent = ''; node.appendChild(image);
  }

  function activate(user, quota) {
    updateIdentity(user, quota);
    if (!currentQuota?.exceeded) dismissedQuotaNotice = '';
    void global.LegalUpdates?.refresh();
    if (emailView) emailView.invalidate();
    document.documentElement.classList.remove('soduwork-auth-pending');
    document.body.classList.remove('soduwork-client-auth-open');
    if (gate) gate.hidden = true;
  }

  function accountCardHtml() {
    /* 账户摘要只保留头像与昵称编辑入口；密码和退出登录统一放在账号安全页。 */
    return '<div class="set-kline"><div class="k">当前账号</div><span class="soduwork-account-badge">已登录</span></div>' +
      '<div class="soduwork-account-person" data-account-profile-editor role="button" tabindex="0" aria-label="编辑个人资料" title="编辑个人资料"><span class="soduwork-account-avatar"></span><span><b class="soduwork-account-name"></b><small class="soduwork-account-id"></small></span></div>' +
      '<div class="set-note soduwork-account-quota"></div>';
  }

  function mountSettings() {
    // Account controls belong to the personal workspace page. Keep settings as
    // a navigation entry so identity updates cannot inject a second account UI.
    document.getElementById('soduWorkAccountSettings')?.remove();
    var card = document.getElementById('personalAccountSummary');
    if (!card || !currentUser) return;
    if (!card.querySelector('.soduwork-account-person')) {
      card.innerHTML = '<div class="soduwork-account-settings">' + accountCardHtml() + '</div>';
      bindProfileEntry(card);
    }
    var name = text(currentUser.displayName || currentUser.username);
    card.querySelector('.soduwork-account-name').textContent = name;
    card.querySelector('.soduwork-account-id').textContent = text(currentUser.email || currentUser.username);
    renderAccountAvatar(card.querySelector('.soduwork-account-avatar'), name);
    card.querySelector('.soduwork-account-quota').textContent = quotaCopy(currentQuota);
  }

  function bindProfileEntry(card) {
    var entry = card.querySelector('[data-account-profile-editor]');
    if (!entry || entry.dataset.profileBound) return;
    entry.dataset.profileBound = '1';
    function open() { global.AccountCenter?.openProfileEditor?.(); }
    entry.addEventListener('click', function (event) {
      open();
    });
    entry.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); open();
    });
  }

  async function submit(event) {
    event.preventDefault();
    var account = text(accountInput.value).trim();
    var password = text(passwordInput.value);
    if (account.length < 3) {
      setStatus('\u8bf7\u8f93\u5165\u81f3\u5c11 3 \u4e2a\u5b57\u7b26\u7684\u8d26\u53f7\u3002', 'error');
      accountInput.focus();
      return;
    }
    if (!password) {
      setStatus('\u8bf7\u8f93\u5165\u5bc6\u7801\u3002', 'error');
      passwordInput.focus();
      return;
    }
    setBusy(true);
    setStatus('\u6b63\u5728\u9a8c\u8bc1\u8d26\u53f7\u5e76\u7ed1\u5b9a\u5f53\u524d\u7ec8\u7aef\u2026', 'working');
    try {
      var result = await api().clientLogin({
        account: account,
        password: password,
        displayName: text(displayInput.value).trim()
      });
      passwordInput.value = '';
      resetPasswordView();
      if (!result || !result.ok) {
        setStatus(connectionMessage(result) || '\u767b\u5f55\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5\u3002',
          result && result.code === 'TOKEN_QUOTA_EXCEEDED' ? 'quota' : 'error');
        setRecoveryActions(result);
        setBusy(false);
        passwordInput.focus();
        return;
      }
      updateIdentity(result.user, result.quota);
      setStatus(result.created ? '\u8d26\u53f7\u5df2\u521b\u5efa\uff0c\u6b63\u5728\u8fdb\u5165\u5de5\u4f5c\u53f0\u2026' :
        '\u767b\u5f55\u6210\u529f\uff0c\u6b63\u5728\u8fdb\u5165\u5de5\u4f5c\u53f0\u2026', 'success');
      setBusy(true, '\u6b63\u5728\u8fdb\u5165');
      setTimeout(function () { global.location.reload(); }, 300);
    } catch (error) {
      passwordInput.value = '';
      resetPasswordView();
      setStatus(connectionMessage(error) || '\u767b\u5f55\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u3002', 'error');
      setRecoveryActions(error);
      setBusy(false);
    }
  }

  function confirmLogout() {
    var bridge = global.AccountUI;
    if (!bridge || typeof bridge.modal !== 'function') {
      var nativeConfirm = global['confirm'];
      return typeof nativeConfirm === 'function' ? nativeConfirm((global.SoduWorkI18n?.translateText || String)('\u9000\u51fa\u540e\uff0c\u8fd9\u53f0\u7535\u8111\u9700\u8981\u91cd\u65b0\u767b\u5f55\u624d\u80fd\u4f7f\u7528 SoduWork\u3002\u786e\u5b9a\u9000\u51fa\uff1f')) : true;
    }
    return new Promise(function (resolve) {
      var settled = false;
      var dialog = global.AccountUI.modal(document.body, '\u9000\u51fa\u767b\u5f55',
        '<p class="ac-confirm-copy">\u9000\u51fa\u540e\uff0c\u8fd9\u53f0\u7535\u8111\u9700\u8981\u91cd\u65b0\u767b\u5f55\u624d\u80fd\u4f7f\u7528 SoduWork\u3002</p>' +
        '<div class="ac-actions ac-confirm-actions"><button type="button" class="ac-secondary" data-ac-cancel>\u53d6\u6d88</button><button type="button" class="ac-primary" data-ac-confirm>\u786e\u5b9a\u9000\u51fa</button></div>', 'ac-logout-confirm');
      function cancel() {
        if (settled) return;
        settled = true; resolve(false);
      }
      dialog.mask.addEventListener('ac-close', cancel, { once: true });
      dialog.mask.querySelector('[data-ac-cancel]').addEventListener('click', function () { dialog.close(); });
      dialog.mask.querySelector('[data-ac-confirm]').addEventListener('click', function () {
        if (settled) return;
        settled = true; dialog.close(); resolve(true);
      });
    });
  }

  async function logout() {
    var confirmation = confirmLogout();
    if (confirmation && typeof confirmation.then === 'function') confirmation = await confirmation;
    if (!confirmation) return;
    var button = document.querySelector('[data-logout]');
    var buttonLabel = button && (button.querySelector?.('span') || button);
    if (button) { button.disabled = true; if (buttonLabel) buttonLabel.textContent = '\u6b63\u5728\u9000\u51fa\u2026'; }
    try {
      var result = await api().clientLogout();
      if (!result || !result.ok) throw new Error(result && result.error || '\u9000\u51fa\u5931\u8d25');
      global.location.reload();
    } catch (error) {
      // Main invalidates every window before the logout HTTP request settles.
      // That notification already starts navigation; a late scope error must
      // neither open a blocking alert on the departing page nor touch a new user.
      if (error && error.code === 'STALE_TASK_SCOPE') return;
      if (button) { button.disabled = false; if (buttonLabel) buttonLabel.textContent = '\u9000\u51fa\u767b\u5f55'; }
      global.alert((global.SoduWorkI18n?.translateText || String)(error && error.message || '\u9000\u51fa\u5931\u8d25'));
    }
  }

  /* Verified email accounts use a one-time identity proof to set a password; legacy accounts validate the current password. */
  var pwdMask = null;
  var pwdFormView = null, pwdDoneView = null, pwdForm = null;
  var pwdCur = null, pwdNew = null, pwdNew2 = null;
  /*
   * Close on backdrop clicks only when the press also began there. Dragging a text selection
   * outside an input can otherwise dispatch click to the shared backdrop ancestor.
   */
  var pwdDownOnMask = false;
  var pwdTips = null, pwdFill = null, pwdTxt = null, pwdHint = null;
  var pwdMsg = null, pwdSubmitBtn = null;
  var pwdScope = null, pwdRevision = 0;

  function pwdOwnerMatches(scope, signedOut) {
    if (!scope || scope.bridge !== api() || scope.hub !== scope.bridge.hubBase()) return false;
    var snapshot = scope.bridge.clientAuthSnapshot();
    return snapshot.clientId === scope.clientId &&
      (snapshot.user?.id === scope.owner || (signedOut && !snapshot.user));
  }

  function pwdActive(scope) {
    return !!scope && scope === pwdScope && scope.revision === pwdRevision &&
      pwdMask.classList.contains('is-open') && pwdOwnerMatches(scope, false);
  }

  function pwdMinLength() {
    var value = Number(policy && policy.passwordMinLength);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 8;
  }

  function pwdScore(pw) {
    if (!pw) return 0;
    if (pw.length < pwdMinLength()) return 1;
    var kinds = /[a-z]/.test(pw) + /[A-Z]/.test(pw) + /\d/.test(pw) + /[^A-Za-z0-9]/.test(pw);
    if (pw.length >= 12 && kinds >= 3) return 4;
    if (kinds >= 2) return 3;
    return 2;
  }

  function ensureChangePwdModal() {
    if (pwdMask) return pwdMask;
    pwdMask = document.createElement('div');
    pwdMask.id = 'soduWorkPwdModal';
    pwdMask.className = 'soduwork-pwd-mask';
    pwdMask.innerHTML =
      '<div class="soduwork-pwd-card" role="dialog" aria-modal="true" aria-labelledby="soduworkPwdTitle">' +
        '<div class="soduwork-pwd-formview">' +
          '<div class="soduwork-pwd-head"><div class="soduwork-pwd-title" id="soduworkPwdTitle">修改密码</div>' +
            '<button type="button" class="soduwork-pwd-close" aria-label="关闭对话框" title="关闭对话框">✕</button></div>' +
          '<div class="soduwork-pwd-sub">修改成功后将退出登录</div>' +
          '<form class="soduwork-pwd-form" novalidate>' +
            '<label class="soduwork-pwd-field" data-pwd-current><span>当前密码</span>' +
              '<span class="soduwork-auth-pw-wrap">' +
                '<input id="soduworkPwdCurrent" type="password" autocomplete="current-password" maxlength="128" placeholder="输入正在使用的密码">' +
                '<button class="soduwork-auth-pw-eye" type="button" aria-label="显示密码" aria-pressed="false" title="显示密码">' + EYE_VIEW_SVG + EYE_HIDE_SVG + '</button>' +
              '</span></label>' +
            '<label class="soduwork-pwd-field"><span>新密码</span>' +
              '<span class="soduwork-auth-pw-wrap">' +
                '<input id="soduworkPwdNew" type="password" autocomplete="new-password" maxlength="128" placeholder="至少 8 位">' +
                '<button class="soduwork-auth-pw-eye" type="button" aria-label="显示密码" aria-pressed="false" title="显示密码">' + EYE_VIEW_SVG + EYE_HIDE_SVG + '</button>' +
              '</span>' +
              '<span class="soduwork-pwd-tips" hidden>' +
                '<span class="soduwork-pwd-strength"><i class="soduwork-pwd-strength-bar"><b></b></i><em></em></span>' +
                '<small class="soduwork-pwd-hint"></small>' +
              '</span></label>' +
            '<label class="soduwork-pwd-field"><span>确认新密码</span>' +
              '<span class="soduwork-auth-pw-wrap">' +
                '<input id="soduworkPwdConfirm" type="password" autocomplete="new-password" maxlength="128" placeholder="再输入一次">' +
                '<button class="soduwork-auth-pw-eye" type="button" aria-label="显示密码" aria-pressed="false" title="显示密码">' + EYE_VIEW_SVG + EYE_HIDE_SVG + '</button>' +
              '</span></label>' +
            '<div class="soduwork-pwd-actions">' +
              '<button type="button" class="soduwork-pwd-cancel">取消</button>' +
              '<button type="submit" class="soduwork-pwd-submit">确认修改</button>' +
            '</div>' +
            '<div class="soduwork-pwd-msg" role="alert" aria-live="polite"></div>' +
          '</form>' +
        '</div>' +
        '<div class="soduwork-pwd-done" hidden>' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="m7.8 12.3 2.7 2.7 5.7-6"/></svg>' +
          '<b>密码已修改</b>' +
          '<span>正在退出登录，请用新密码重新登录…</span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(pwdMask);
    pwdFormView = pwdMask.querySelector('.soduwork-pwd-formview');
    pwdDoneView = pwdMask.querySelector('.soduwork-pwd-done');
    pwdForm = pwdMask.querySelector('form');
    pwdCur = pwdMask.querySelector('#soduworkPwdCurrent');
    pwdNew = pwdMask.querySelector('#soduworkPwdNew');
    pwdNew2 = pwdMask.querySelector('#soduworkPwdConfirm');
    pwdTips = pwdMask.querySelector('.soduwork-pwd-tips');
    pwdFill = pwdMask.querySelector('.soduwork-pwd-strength-bar b');
    pwdTxt = pwdMask.querySelector('.soduwork-pwd-strength em');
    pwdHint = pwdMask.querySelector('.soduwork-pwd-hint');
    pwdMsg = pwdMask.querySelector('.soduwork-pwd-msg');
    pwdSubmitBtn = pwdMask.querySelector('.soduwork-pwd-submit');
    pwdMask.querySelectorAll('.soduwork-auth-pw-eye').forEach(function (eye) {
      var input = eye.closest('.soduwork-auth-pw-wrap').querySelector('input');
      eye.addEventListener('click', function () {
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        eye.classList.toggle('is-on', show);
        var tip = show ? '隐藏密码' : '显示密码';
        eye.setAttribute('aria-pressed', String(show));
        eye.setAttribute('aria-label', tip);
        eye.title = tip;
      });
    });
    pwdNew.addEventListener('input', updatePwdStrength);
    pwdMask.querySelector('.soduwork-pwd-close').addEventListener('click', closeChangePwd);
    pwdMask.querySelector('.soduwork-pwd-cancel').addEventListener('click', closeChangePwd);
    pwdMask.addEventListener('mousedown', function (event) {
      pwdDownOnMask = event.button === 0 && event.target === pwdMask;
    });
    pwdMask.addEventListener('click', function (event) {
      if (event.target === pwdMask && pwdDownOnMask) closeChangePwd();
    });
    pwdForm.addEventListener('submit', submitChangePwd);
    ['soduwork-data-scope-changed', 'soduwork-client-auth-required'].forEach(function (name) {
      global.addEventListener(name, function () { if (pwdScope) closeChangePwd(); });
    });
    return pwdMask;
  }

  function setPwdMsg(message, kind) {
    var tip = (global.SoduWorkI18n?.translateText || String)(message || '');
    pwdMsg.textContent = tip;
    pwdMsg.className = 'soduwork-pwd-msg' + (kind ? ' is-' + kind : '');
  }

  function resetPwdViews() {
    pwdForm.reset();
    [pwdCur, pwdNew, pwdNew2].forEach(function (input) {
      input.value = '';
      input.type = 'password';
      input.disabled = false;
    });
    pwdMask.querySelectorAll('.soduwork-auth-pw-eye').forEach(function (eye) {
      eye.classList.remove('is-on');
      eye.setAttribute('aria-pressed', 'false');
      eye.setAttribute('aria-label', '显示密码');
      eye.title = '显示密码';
    });
    pwdTips.hidden = true;
    pwdFill.style.width = '0';
    pwdTxt.textContent = '';
    pwdHint.textContent = '';
    pwdHint.classList.remove('is-ok');
    pwdMsg.textContent = '';
    pwdMsg.className = 'soduwork-pwd-msg';
    pwdSubmitBtn.disabled = false;
    pwdSubmitBtn.classList.remove('is-busy');
    pwdFormView.hidden = false;
    pwdDoneView.hidden = true;
  }

  function openChangePwd() {
    var bridge = api(), snapshot = bridge?.clientAuthSnapshot?.();
    if (!snapshot?.user?.id) return;
    ensureChangePwdModal();
    resetPwdViews();
    var email = !!snapshot.user.email && snapshot.user.emailVerified === true;
    pwdScope = { bridge: bridge, hub: bridge.hubBase(), owner: snapshot.user.id,
      clientId: snapshot.clientId, user: snapshot.user, email: email, revision: ++pwdRevision };
    pwdMask.querySelector('[data-pwd-current]').hidden = email;
    pwdCur.disabled = email;
    pwdMask.querySelector('#soduworkPwdTitle').textContent = email ? '设置新密码' : '修改密码';
    pwdMask.querySelector('.soduwork-pwd-sub').textContent = email
      ? '通过邮箱验证码确认身份后设置新密码，所有设备需要重新登录' : '修改成功后将退出登录';
    pwdSubmitBtn.textContent = email ? '验证邮箱并设置' : '确认修改';
    pwdMask.querySelector('.soduwork-pwd-done b').textContent = email ? '新密码已设置' : '密码已修改';
    pwdMask.classList.add('is-open');
    var scope = pwdScope;
    setTimeout(function () { if (pwdActive(scope)) (email ? pwdNew : pwdCur).focus(); }, 60);
  }

  function closeChangePwd() {
    pwdRevision++; pwdScope = null;
    pwdMask.classList.remove('is-open');
    resetPwdViews();
  }

  /* Rate strength after the minimum length: letters plus digits are medium; at least twelve characters and three character classes are strong. */
  function updatePwdStrength() {
    var value = pwdNew.value;
    if (!value) { pwdTips.hidden = true; return; }  /* Reserve no feedback height before input to keep the three fields compact. */
    pwdTips.hidden = false;
    var min = pwdMinLength();
    var map = {
      1: [25, '太短', '#c64151'],
      2: [50, '弱', '#c64151'],
      3: [75, '中', '#e0a63c'],
      4: [100, '强', '#158c6b']
    }[pwdScore(value)] || [0, '', 'transparent'];
    pwdFill.style.width = map[0] + '%';
    pwdFill.style.background = map[2];
    pwdTxt.textContent = map[1];
    var ok = value.length >= min;
    var i18n = global.SoduWorkI18n;
    pwdHint.textContent = ok
      ? (i18n?.translateText || String)('长度满足要求，可继续')
      : i18n.t('至少 {min} 位，还需 {n} 位',
          '至少 ' + min + ' 位，还需 ' + (min - value.length) + ' 位',
          { min: min, n: min - value.length });
    pwdHint.classList.toggle('is-ok', ok);
  }

  async function submitChangePwd(event) {
    event.preventDefault();
    var scope = pwdScope;
    if (!pwdActive(scope) || pwdSubmitBtn.disabled) return;
    var min = pwdMinLength();
    if (!scope.email && !pwdCur.value) { setPwdMsg('请输入当前密码。', 'error'); pwdCur.focus(); return; }
    if (pwdNew.value.length < min) {
      setPwdMsg(global.SoduWorkI18n.t('新密码至少 {min} 位。', '新密码至少 ' + min + ' 位。', { min: min }), 'error');
      pwdNew.focus(); return;
    }
    if (!scope.email && pwdNew.value === pwdCur.value) { setPwdMsg('新密码不能与当前密码相同。', 'error'); pwdNew.focus(); return; }
    if (pwdNew.value !== pwdNew2.value) { setPwdMsg('两次输入的新密码不一致。', 'error'); pwdNew2.focus(); return; }
    pwdSubmitBtn.disabled = true;
    pwdSubmitBtn.classList.add('is-busy');
    var payload = { newPassword: pwdNew.value };
    if (!scope.email) payload.currentPassword = pwdCur.value;
    [pwdCur, pwdNew, pwdNew2].forEach(function (input) { input.disabled = true; });
    setPwdMsg('正在提交…', 'busy');
    try {
      if (scope.email) {
        payload.verificationToken = await global.AccountVerification.verify('change_password', scope.user);
        if (!pwdActive(scope)) return;
        if (!payload.verificationToken) throw new Error('请先完成邮箱身份验证。');
      }
      var result = await scope.bridge.clientChangePassword(payload);
      if (!pwdOwnerMatches(scope, false)) return;
      if (!result || !result.ok) throw new Error((result && result.error) || '修改失败，请重试。');
      /* Show success, then log out because the server has invalidated every session for this account. */
      if (pwdActive(scope)) {
        [pwdCur, pwdNew, pwdNew2].forEach(function (input) { input.value = ''; input.type = 'password'; input.disabled = true; });
        pwdFormView.hidden = true;
        pwdDoneView.hidden = false;
      }
      // Closing a dialog cannot undo a committed change or its required logout.
      setTimeout(function () { return signOutAfterPasswordChange(scope); }, 1400);
    } catch (error) {
      if (!pwdActive(scope)) return;
      pwdSubmitBtn.disabled = false;
      pwdSubmitBtn.classList.remove('is-busy');
      [pwdCur, pwdNew, pwdNew2].forEach(function (input) { input.disabled = scope.email && input === pwdCur; });
      if (error?.name === 'AbortError') { setPwdMsg(''); return; }
      /* A 404 indicates an older server; show an actionable upgrade message. */
      setPwdMsg(error && error.status === 404
        ? (global.SoduWorkI18n?.translateText || String)('当前连接的 SoduWork 服务版本较旧，暂不支持修改密码，请先升级服务。')
        : (connectionMessage(error) || (error && error.message) || '修改失败，请检查网络。'),
        'error');
    }
  }

  /* After a password change, use the normal logout path and reload the login gate without another confirmation. */
  async function signOutAfterPasswordChange(scope) {
    if (!pwdOwnerMatches(scope, false)) return;
    try { await scope.bridge.clientLogout(); }
    catch (error) { if (error?.code === 'STALE_TASK_SCOPE') return; }
    // Our own logout closes the dialog through the scope event. Only a new
    // account, Hub or device should suppress the final login-page navigation.
    if (!pwdOwnerMatches(scope, true)) return;
    global.location.reload();
  }

  async function loadPolicy() {
    var bridge = api(), request = ++policyRevision;
    function scope() {
      var identity = bridge?.clientAuthSnapshot?.() || {};
      return [bridge?.hubBase?.() || '', identity.clientId || '', identity.user?.id || ''].join('|');
    }
    var requestedScope = scope();
    try {
      var next = await bridge.clientAuthPolicy();
      if (request !== policyRevision || bridge !== api() || requestedScope !== scope()) return;
      policy = next;
      if (emailView) emailView.setPolicy(policy);
      var summary = gate && gate.querySelector('.soduwork-auth-first summary');
      if (summary && policy && !policy.allowSelfRegistration) {
        summary.textContent = '\u663e\u793a\u540d\u7531\u7ba1\u7406\u5458\u7ef4\u62a4';
        summary.parentElement.hidden = true;
      }
    } catch (e) {
      if (request !== policyRevision || bridge !== api() || requestedScope !== scope()) return;
      emailView?.setPolicyError();
    }
  }

  async function boot() {
    if (booting || !api()) return;
    booting = true;
    createGate();
    setBusy(true, '\u6b63\u5728\u6062\u590d\u767b\u5f55');
    setStatus('\u6b63\u5728\u5b89\u5168\u6062\u590d\u8fd9\u53f0\u7535\u8111\u7684\u767b\u5f55\u72b6\u6001\u2026', 'working');
    try {
      var result = await api().registerClient();
      if (result && result.ok && result.user) {
        activate(result.user, result.quota);
        void api().clientAuthMe().then(function (fresh) { if (fresh?.user?.id === currentUser?.id) updateIdentity(fresh.user, fresh.quota); }).catch(function () {});
        return;
      }
      if (result && result.ok && result.session) {
        try {
          var me = await api().clientAuthMe();
          if (me && me.user) {
            activate(me.user, me.quota);
            return;
          }
        } catch (e) {}
      }
      setBusy(false);
      setStatus('');
      show(result || { error: '\u6682\u65f6\u65e0\u6cd5\u8fde\u63a5 SoduWork \u670d\u52a1\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u91cd\u8bd5\u3002' });
    } catch (error) {
      setBusy(false);
      show({ error: error && error.message || '\u6682\u65f6\u65e0\u6cd5\u8fde\u63a5 SoduWork \u670d\u52a1\u3002' });
    } finally {
      booting = false;
      // Enrollment replaces the provisional renderer ID. Read policy only after
      // that identity settles, so the stale-response guard cannot discard it.
      void loadPolicy();
      if (gate) gate.querySelector('.soduwork-auth-hub b').textContent = hubLabel();
    }
  }

  function init() {
    createGate();
    api()?.listenAccountProfileChanges?.();
    global.addEventListener('soduwork-profile-updated', function (event) { updateIdentity(event.detail, null); });
    global.addEventListener('soduwork-locale-change', function () {
      mountSettings();
    });
    global.addEventListener('soduwork-device-auth', function (event) {
      var detail = event.detail || {};
      if (detail.state === 'active' && detail.user) activate(detail.user, detail.quota);
      else if (detail.state === 'pending' || detail.state === 'quota') show(detail);
    });
    global.addEventListener('soduwork-client-auth-required', function (event) {
      show(event.detail || {});
    });
    var attempts = 0;
    var identityTimer = setInterval(function () {
      if (currentUser) updateIdentity(currentUser, currentQuota);
      attempts += 1;
      if (attempts >= 15) clearInterval(identityTimer);
    }, 1000);
    boot();
  }

  document.documentElement.classList.add('soduwork-auth-pending');
  global.ClientAuth = {
    logout: logout,
    confirmLogout: confirmLogout,
    connectionMessage: connectionMessage,
    accountCardHtml: accountCardHtml,
    changePassword: openChangePwd,
    updateIdentity: updateIdentity,
    clearQuotaNotice: clearQuotaNotice,
    snapshot: function () { return { user: currentUser, quota: currentQuota, policy: policy }; }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
