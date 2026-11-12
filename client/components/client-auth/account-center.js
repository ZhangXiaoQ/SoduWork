(function (global) {
  'use strict';
  let currentDialog = null;
  const tabs = ['security', 'devices', 'privacy'];
  const api = () => global.SoduWorkAPI;
  const ui = () => global.AccountUI;
  const normalizeTab = value => value === 'profile' ? 'security' : (tabs.includes(value) ? value : 'security');
  function navigation() {
    return '<nav class="ac-center-tabs" role="tablist" aria-label="个人信息">' +
      tabs.map((tab, i) => '<button type="button" role="tab" data-tab="' + tab + '" id="account-tab-' + tab + '" aria-controls="account-tab-content">' + ['账号安全', '登录设备', '隐私与数据'][i] + '</button>').join('') +
      '</nav><div class="ac-center-content" id="account-tab-content" role="tabpanel" tabindex="0"></div>';
  }
  function open(initial = 'security') {
    initial = normalizeTab(initial);
    if (document.getElementById('personalAccountPanel') && global.WorkspaceHost?.open) {
      return global.WorkspaceHost.open('account', { tab: initial });
    }
    if (currentDialog?.active()) { currentDialog.mask.querySelector('[data-tab="' + initial + '"]')?.click(); return; }
    if (!api().clientAuthSnapshot()?.user?.id) return;
    mount(ui().modal(document.body, '个人信息', navigation(), 'ac-center'), initial);
  }
  function closePanel() {
    if (currentDialog?.embedded) {
      currentDialog.close();
      return;
    }
    const panel = document.getElementById('personalAccountPanel');
    if (panel) panel.classList.remove('show');
    document.getElementById('personalAccountContent')?.replaceChildren();
    document.getElementById('personalAccountSummary')?.replaceChildren();
  }
  function openInPanel(initial = 'security') {
    initial = normalizeTab(initial);
    const panel = document.getElementById('personalAccountPanel');
    const host = document.getElementById('personalAccountContent');
    if (!panel || !host) return;
    panel.classList.add('show');
    if (currentDialog?.active() && currentDialog.embedded) {
      currentDialog.mask.querySelector('[data-tab="' + initial + '"]')?.click(); return;
    }
    currentDialog?.close();
    const snapshot = api().clientAuthSnapshot();
    if (!snapshot?.user?.id) {
      document.getElementById('personalAccountSummary')?.replaceChildren();
      host.textContent = '请先登录后管理个人信息。'; return;
    }
    host.innerHTML = navigation();
    let closed = false;
    const dialog = { mask: host, embedded: true, active: () => !closed && host.isConnected, close() {
      if (closed) return;
      closed = true; host.dispatchEvent(new Event('ac-close')); host.replaceChildren();
      panel.classList.remove('show');
      document.getElementById('personalAccountSummary')?.replaceChildren();
      const device = panel.querySelector('.personal-account-device'); if (device) device.hidden = true;
    } };
    global.ClientAuth?.updateIdentity(snapshot.user, snapshot.quota);
    if (typeof global.refreshPersonalAccountBinding === 'function') global.refreshPersonalAccountBinding();
    panel.scrollTop = 0;
    mount(dialog, initial);
  }
  function mount(dialog, initial) {
    const original = api().clientAuthSnapshot(), owner = original?.user?.id, hub = api().hubBase();
    if (!owner) { dialog.close(); return; }
    currentDialog = dialog;
    let user = original.user, revision = 0, tab = initial, deviceListRevision = 0;
    const content = dialog.mask.querySelector('.ac-center-content');
    const accountAlive = () => dialog.active() && owner === api().clientAuthSnapshot()?.user?.id && hub === api().hubBase();
    const alive = stamp => accountAlive() && stamp === revision;
    const status = message => { const node = content.querySelector('.ac-status'); if (node) node.textContent = message || ''; };
    const text = value => ui().esc(value);
    async function request(operation, payload, stamp = revision) {
      const result = ui().check(await api().clientAccountRequest(operation, payload));
      if (!alive(stamp)) throw Object.assign(Error('账号或页面已变化'), { name: 'AbortError' });
      return result;
    }
    function picture(value) {
      const source = value?.avatarDataUrl || value?.avatarUrl || '';
      return /^data:image\/(?:png|jpeg|webp);base64,/.test(source)
        ? '<img src="' + text(source) + '" alt="个人头像">'
        : '<span>' + text(Array.from(value?.displayName || value?.username || '我')[0]) + '</span>';
    }
    async function signOut() {
      const bridge = api();
      if (hub !== bridge.hubBase() || owner !== bridge.clientAuthSnapshot()?.user?.id) return;
      try { await bridge.clientLogout(); }
      catch (error) {
        // A session-change notification already owns navigation. Never reload
        // the replacement account when its predecessor's logout settles late.
        if (error?.code === 'STALE_TASK_SCOPE') return;
      }
      const nextOwner = bridge.clientAuthSnapshot()?.user?.id;
      if (bridge !== api() || hub !== bridge.hubBase() || (nextOwner && nextOwner !== owner)) return;
      if (dialog.active()) dialog.close(); global.location.reload();
    }
    function openProfileEditor() {
      const trigger = document.querySelector('[data-account-profile-editor]');
      const stamp = revision;
      const child = ui().modal(document.body, '编辑个人资料',
        '<form class="ac-form ac-profile-form" novalidate><section class="ac-profile-head"><div class="ac-profile-avatar">' + picture(user) + '</div><div class="ac-profile-fields"><label>昵称<input name="displayName" value="' + text(user.displayName || '') + '" maxlength="64" autocomplete="nickname" required></label>' +
        '<div class="ac-avatar-actions"><label class="ac-link ac-file">重新上传头像<input type="file" accept="image/png,image/jpeg,image/webp" hidden></label><button type="button" class="ac-link" data-avatar-remove>移除头像</button><span class="ac-muted">PNG、JPEG、WebP · 5 MB 以内</span></div></div></section>' +
        '<p class="ac-muted">昵称不会改变你的账号或本机设备名称。</p><p class="ac-status" role="status" aria-live="polite"></p><div class="ac-actions"><button class="ac-secondary" type="button" data-ac-cancel>取消</button><button class="ac-primary" type="submit">保存资料</button></div></form>', 'ac-profile-editor');
      const form = child.mask.querySelector('form');
      const note = form.querySelector('.ac-status');
      const preview = form.querySelector('.ac-profile-avatar');
      const input = form.querySelector('[type="file"]');
      let avatar = undefined, avatarRevision = 0;
      const valid = () => child.active() && alive(stamp);
      form.querySelector('[data-ac-cancel]').onclick = () => child.close();
      form.querySelector('[data-avatar-remove]').onclick = () => {
        avatarRevision++; avatar = '';
        preview.innerHTML = picture({ ...user, avatarDataUrl: '', avatarUrl: '' });
        note.textContent = '保存后移除头像。';
      };
      input.onchange = async event => {
        const file = event.target.files?.[0], imageRevision = ++avatarRevision;
        event.target.value = '';
        if (!file) return;
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) { note.textContent = '请选择 5 MB 以内的 PNG、JPEG 或 WebP 图片。'; return; }
        try {
          const bitmap = await createImageBitmap(file);
          if (!valid() || imageRevision !== avatarRevision) { bitmap.close(); return; }
          const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
          const side = Math.min(bitmap.width, bitmap.height);
          canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256); bitmap.close();
          avatar = canvas.toDataURL('image/png'); preview.innerHTML = picture({ avatarDataUrl: avatar }); note.textContent = '头像已准备好，保存后生效。';
        } catch (_) { if (valid()) note.textContent = '无法读取这张图片，请更换图片。'; }
      };
      form.onsubmit = async event => {
        event.preventDefault();
        const displayName = form.querySelector('[name="displayName"]').value.trim(), button = form.querySelector('[type="submit"]');
        if (!displayName) { note.textContent = '昵称不能为空。'; return; }
        button.disabled = true; note.textContent = '正在保存…';
        try {
          const result = await request('profile', { displayName, ...(avatar !== undefined ? { avatarDataUrl: avatar } : {}) }, stamp);
          user = result.user; global.ClientAuth?.updateIdentity(user); if (tab === 'security') security(); child.close();
        } catch (error) { if (valid()) note.textContent = ui().error(error); }
        finally { if (valid()) button.disabled = false; }
      };
      return child;
    }
    dialog.openProfileEditor = openProfileEditor;
    function security() {
      const emailPassword = !!user.email && user.emailVerified === true;
      content.innerHTML = '<h3>账号安全</h3><p class="ac-muted">邮箱用于登录、找回密码与重要的安全通知。</p>' +
        '<div class="ac-setting-row"><div><b>登录邮箱</b><span>' + text(user.email || '尚未绑定邮箱') + '</span></div><button class="ac-secondary" data-email-change>' + (user.email ? '更换邮箱' : '绑定邮箱') + '</button></div>' +
        '<div class="ac-setting-row"><div><b>账号 ID</b><span><code class="ac-account-id-value">' + text(user.id) + '</code></span></div></div>' +
        '<div class="ac-setting-row"><div><b>登录密码</b><span>' + (emailPassword ? '通过邮箱验证码设置新密码，所有已登录设备需要重新登录' : '修改后，所有已登录设备需要重新登录') + '</span></div><button class="ac-secondary" data-password-change>' + (emailPassword ? '设置新密码' : '修改密码') + '</button></div>' +
        '<div class="ac-setting-row"><div><b>当前设备</b><span>退出后需重新验证身份</span></div><button class="ac-secondary" data-logout>退出登录</button></div><p class="ac-status" role="status"></p>';
      content.querySelector('[data-email-change]').onclick = changeEmail;
      content.querySelector('[data-password-change]').onclick = () => { if (!dialog.embedded) dialog.close(); global.ClientAuth?.changePassword(); };
      content.querySelector('[data-logout]').onclick = () => global.ClientAuth?.logout();
    }
    async function changeEmail() {
      const stamp = revision;
      const child = ui().modal(document.body, user.email ? '更换登录邮箱' : '绑定登录邮箱',
        '<p class="ac-muted">验证新邮箱及当前账号后生效。完成后所有设备将退出登录。</p><form class="ac-form" novalidate>' +
        '<label>新邮箱<input name="email" type="email" autocomplete="email" maxlength="254" placeholder="name@example.com"></label>' +
        '<label>新邮箱验证码<span class="ac-code-row"><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位验证码"><button type="button" class="ac-secondary" data-send>获取验证码</button></span></label>' +
        '<p class="ac-status" role="status"></p><button class="ac-primary" type="submit">验证身份并更换</button></form>', 'ac-email-change');
      const form = child.mask.querySelector('form'), email = form.querySelector('[name="email"]'), code = form.querySelector('[name="code"]');
      const note = form.querySelector('.ac-status'), send = form.querySelector('[data-send]');
      let challenge = null, until = 0, timer = null, sending = false;
      const valid = () => child.active() && alive(stamp);
      const tick = () => { const left = Math.max(0, Math.ceil((until - Date.now()) / 1000)); send.disabled = sending || left > 0; send.textContent = left ? left + ' 秒后重发' : '获取验证码'; };
      email.oninput = () => { challenge = null; code.value = ''; };
      code.oninput = () => { code.value = code.value.replace(/\D/g, '').slice(0, 6); };
      child.mask.addEventListener('ac-close', () => { if (timer) clearInterval(timer); });
      send.onclick = async () => {
        const address = email.value.trim();
        if (!ui().email(address)) { note.textContent = '请输入有效的新邮箱。'; return; }
        if (sending || until > Date.now()) return;
        sending = true; tick();
        try {
          const result = await request('challenge', { email: address, purpose: 'change_email' }, stamp);
          if (!valid() || email.value.trim() !== address) return;
          challenge = { id: result.challengeId, email: address }; until = Date.now() + (result.retryAfter || 60) * 1000;
          if (timer) clearInterval(timer); timer = setInterval(tick, 1000); note.textContent = '新邮箱验证码发送请求已受理，请查看邮箱。';
        } catch (error) { if (valid()) note.textContent = ui().error(error); }
        finally { sending = false; if (valid()) tick(); }
      };
      form.onsubmit = async event => {
        event.preventDefault(); if (!challenge || challenge.email !== email.value.trim() || !ui().code(code.value)) { note.textContent = '请获取并填写新邮箱的 6 位验证码。'; return; }
        const button = form.querySelector('[type="submit"]'); button.disabled = true;
        const pending = { email: email.value.trim(), challengeId: challenge.id, code: code.value };
        try {
          const token = await global.AccountVerification.verify('change_email', user);
          if (!valid()) return;
          // A committed email change must sign out even after this page closes.
          // The API and signOut still enforce the owning account and Hub scope.
          ui().check(await api().clientAccountRequest('email', { ...pending, verificationToken: token }));
          child.close(); await signOut();
        } catch (error) { if (valid() && error.name !== 'AbortError') note.textContent = ui().error(error); }
        finally { if (valid()) button.disabled = false; }
      };
    }
    async function devices(stamp) {
      const load = ++deviceListRevision;
      let result;
      try { result = await request('devices', {}, stamp); }
      catch (error) { if (load !== deviceListRevision) return false; throw error; }
      if (load !== deviceListRevision) return false;
      content.innerHTML = '<h3>登录设备</h3><p class="ac-muted">可删除其他登录设备。删除后，该设备需要重新登录。</p><div class="ac-device-list"></div><p class="ac-status" role="status"></p>';
      const list = content.querySelector('.ac-device-list');
      for (const item of result.items || []) {
        const row = document.createElement('div'); row.className = 'ac-setting-row'; row.dataset.deviceId = item.id;
        const lastActive = item.lastSeenAt
          ? '<span class="ac-last-active">最近活动 ' + text(new Date(item.lastSeenAt).toLocaleString()) + '</span>'
          : '<span class="ac-last-active">暂无活动记录</span>';
        row.innerHTML = '<div><b>' + text(item.name || item.id) + (item.current ? ' <span class="ac-badge">当前设备</span>' : '') + '</b><span>' + text(item.platform || '') + (item.platform ? ' · ' : '') + lastActive + '</span></div>' +
          (item.current ? '' : '<button class="ac-secondary" data-device-remove>删除设备</button>');
        list.appendChild(row);
        const button = row.querySelector('[data-device-remove]');
        if (!button) continue;
        button.onclick = async () => {
          if (button.disabled || !alive(stamp)) return;
          button.disabled = true;
          let deleted = false, actionStamp = stamp;
          try {
            const token = await global.AccountVerification.verify('devices', user);
            if (!alive(stamp)) return;
            ui().check(await api().clientAccountRequest('revokeDevice', { deviceId: item.id, verificationToken: token }));
            if (!accountAlive()) return;
            deleted = true;
            if (tab !== 'devices') return;
            actionStamp = revision;
            // Another deletion may have refreshed the list while this request
            // was pending, so remove the currently rendered row for this ID.
            Array.from(content.querySelector('.ac-device-list')?.children || [])
              .find(candidate => candidate.dataset.deviceId === item.id)?.remove();
            if (await devices(actionStamp) && alive(actionStamp)) status('该设备已删除。');
          } catch (error) {
            if (alive(actionStamp) && error.name !== 'AbortError') status((deleted ? '设备已删除，刷新列表失败：' : '') + ui().error(error));
          }
          finally { if (alive(stamp)) button.disabled = false; }
        };
      }
      if (!list.children.length) list.textContent = '暂无设备记录';
      return true;
    }
    async function privacy(stamp) {
      const result = await request('privacy', {}, stamp);
      const docs = result.documents || [];
      content.innerHTML = '<h3>隐私与个人数据</h3><p class="ac-muted">查看协议与政策，或管理账号注销。</p>' +
        '<div class="ac-setting-row"><div><b>协议与政策</b><span>查看内容与版本</span></div><div class="ac-legal-links"><button class="ac-link" data-legal="terms">用户协议</button><button class="ac-link" data-legal="privacy">隐私政策</button></div></div>' +
        '<div class="ac-setting-row ac-danger-row"><div><b>注销账号</b><span>注销后无法登录；团队业务记录按必要范围保留</span></div><button class="ac-secondary ac-danger" data-delete>注销账号</button></div>' +
        '<p class="ac-muted ac-data-note">' + text(result.deletionScopeSummary || '注销会清理账号资料、个人资料库文件与个人记忆，并撤销登录。组织需求、已共享材料和必要审计记录保留；设备本地对话、文件及第三方服务的数据需在对应设备或服务中管理。') + '</p>' +
        '<p class="ac-status" role="status" aria-live="polite"></p>';
      content.querySelectorAll('[data-legal]').forEach(button => { button.onclick = () => ui().legal(document.body, docs, button.dataset.legal, {
        consents: result.consents,
        loadVersion: id => request('legalVersion', { id }, stamp),
        getScope: () => JSON.stringify([api().hubBase(), api().clientAuthSnapshot()?.user?.id]),
        load: () => request('privacy', {}, stamp)
      }); });
      content.querySelector('[data-delete]').onclick = () => deletion(stamp);
    }
    function deletion(stamp) {
      const child = ui().modal(document.body, '注销账号', '<p>即将注销 <strong>' + text(user.displayName || user.username || user.email || user.id) + '</strong>。提交后所有设备将退出登录，账号不可恢复。</p>' +
        '<p class="ac-muted">团队业务记录和必要的审计记录可能保留。本机聊天、下载与工作目录不会由服务器删除，请先备份或自行清理。</p>' +
        '<form class="ac-form" novalidate><label>输入“注销账号”确认<input name="confirmation" autocomplete="off" placeholder="注销账号" data-user-attributes="placeholder"></label><p class="ac-status" role="status" aria-live="polite"></p><div class="ac-actions"><button type="button" class="ac-secondary" data-ac-cancel>取消</button><button class="ac-primary ac-danger-button" type="submit">验证身份并注销</button></div></form>', 'ac-deletion');
      const form = child.mask.querySelector('form'), note = form.querySelector('.ac-status');
      const input = form.querySelector('input'), button = form.querySelector('[type="submit"]');
      let busy = false;
      const valid = () => child.active() && alive(stamp);
      form.querySelector('[data-ac-cancel]').onclick = () => child.close();
      input.oninput = () => { note.textContent = ''; };
      form.onsubmit = async event => {
        event.preventDefault(); if (busy || !valid()) return;
        if (input.value !== '注销账号') { note.textContent = '请完整输入“注销账号”。'; input.focus(); return; }
        busy = true; button.disabled = true; input.disabled = true;
        form.setAttribute('aria-busy', 'true'); button.textContent = '正在验证身份…'; note.textContent = '';
        try {
          const token = await global.AccountVerification.verify('delete_account', user);
          if (!valid()) return;
          button.textContent = '正在注销…'; note.textContent = '正在提交注销申请，请稍候。';
          // Once accepted, deletion must sign out even if this page was closed.
          // The API and signOut retain the account/Hub fences independently.
          ui().check(await api().clientAccountRequest('deletion', { verificationToken: token, confirmation: '注销账号' }));
          if (valid()) { button.textContent = '正在退出登录…'; note.textContent = '注销申请已受理，数据清理将在后台继续。'; }
          await signOut(); child.close();
        } catch (error) { if (valid() && error.name !== 'AbortError') note.textContent = ui().error(error); }
        finally {
          busy = false;
          if (valid()) { button.disabled = false; input.disabled = false; button.textContent = '验证身份并注销'; form.setAttribute('aria-busy', 'false'); }
        }
      };
    }
    async function show(next) {
      tab = normalizeTab(next); const stamp = ++revision;
      dialog.mask.querySelectorAll('[data-tab]').forEach(button => {
        const selected = button.dataset.tab === tab;
        button.setAttribute('aria-current', String(selected)); button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      });
      content.setAttribute('aria-labelledby', 'account-tab-' + tab);
      if (dialog.embedded) {
        const device = document.querySelector('#personalAccountPanel .personal-account-device');
        if (device) device.hidden = tab !== 'devices';
      }
      content.innerHTML = '<p class="ac-muted">正在加载…</p>';
      try {
        if (tab === 'security') security();
        else if (tab === 'devices') await devices(stamp); else await privacy(stamp);
      } catch (error) {
        if (!alive(stamp)) return;
        content.innerHTML = '<p class="ac-status" role="status"></p><button class="ac-secondary" data-retry>重新加载</button>';
        status(ui().error(error)); content.querySelector('[data-retry]').onclick = () => show(tab);
      }
    }
    const scopeChanged = () => { if (owner !== api().clientAuthSnapshot()?.user?.id || hub !== api().hubBase()) dialog.close(); };
    global.addEventListener('soduwork-data-scope-changed', scopeChanged);
    global.addEventListener('soduwork-client-auth-required', scopeChanged);
    dialog.mask.addEventListener('ac-close', () => {
      revision++;
      if (currentDialog === dialog) currentDialog = null;
      global.removeEventListener('soduwork-data-scope-changed', scopeChanged);
      global.removeEventListener('soduwork-client-auth-required', scopeChanged);
    }, { once: true });
    dialog.mask.querySelectorAll('[data-tab]').forEach(button => {
      button.onclick = () => { if (button.dataset.tab !== tab) show(button.dataset.tab); };
      button.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = tabs.indexOf(tab), next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        const target = dialog.mask.querySelector('[data-tab="' + tabs[next] + '"]'); target.focus(); target.click();
      };
    });
    show(initial);
    api().clientAuthMe().then(result => { if (alive(revision) && result.user) { user = result.user; if (tab === 'security') security(); } }).catch(() => {});
  }
  function openProfileEditor() { return currentDialog?.openProfileEditor?.(); }
  global.AccountCenter = { open, openInPanel, closePanel, openProfileEditor };
})(window);
