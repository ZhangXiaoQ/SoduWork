(function (global) {
  'use strict';
  const tx = value => global.SoduWorkI18n?.translateText?.(value) || value;
  const api = () => global.SoduWorkAPI;
  const scope = () => [api()?.hubBase?.(), api()?.clientAuthSnapshot?.()?.user?.id || ''].join('|');
  let data = null, owner = '', reader = null, pending = 0, request = null, checkedAt = 0;
  function clear() {
    pending++; request = null; data = null; checkedAt = 0;
    reader?.close(); reader = null;
  }
  function selected(kind) {
    return global.AccountUI.legalSelection(data?.documents, kind, global.SoduWorkI18n?.getLocale?.() || 'en-US', data?.requiredConsentVersions?.[kind]).document;
  }
  function button(label, action, className = 'ac-secondary') {
    const node = document.createElement('button'); node.type = 'button'; node.className = className;
    node.textContent = tx(label); node.onclick = action; return node;
  }
  function noticeText(ref) {
    return tx(ref?.kind === 'privacy' ? '隐私政策已更新' : ref?.action === 'accept' ? '用户协议需要重新确认' : '用户协议已更新');
  }
  function syncNotices() {
    const userId = String(api()?.clientAuthSnapshot?.()?.user?.id || '');
    if (!userId || owner !== scope() || typeof global.logNotice !== 'function') return;
    for (const update of data?.updates || []) {
      if (!['terms', 'privacy'].includes(update.key) || !update.revisionId) continue;
      const ref = { kind: update.key, revisionId: String(update.revisionId), action: update.key === 'terms' && update.action === 'accept' ? 'accept' : 'notice' };
      // The existing account-scoped inbox owns persistence, read state, clear
      // markers and cross-window badges. Never create a second notification UI.
      global.logNotice(noticeText(ref), null, 'legal_update', {
        noticeEventId: 'legal_update_' + ref.kind + '_' + ref.revisionId,
        recipientId: userId, legalUpdate: ref
      });
    }
  }
  function refresh(force = false) {
    if (!api()?.clientAuthSnapshot?.()?.user?.id || !global.AccountUI) { clear(); return Promise.resolve(null); }
    if (owner !== scope()) { clear(); owner = scope(); }
    if (request) return request;
    if (!force && Date.now() - checkedAt < 60000) { syncNotices(); return Promise.resolve(data); }
    const stamp = ++pending, requestScope = scope();
    const work = Promise.resolve().then(async () => {
      try {
        if (pending !== stamp || requestScope !== scope()) return null;
        const result = global.AccountUI.check(await api().clientAccountRequest('legalStatus'));
        if (pending !== stamp || requestScope !== scope()) return null;
        data = result; checkedAt = Date.now(); syncNotices(); return result;
      } catch (_) {
        // Keep the saved inbox on transient failure. No response is consent.
        return null;
      } finally { if (request === work) request = null; }
    });
    request = work; return work;
  }
  async function openNotice(notice) {
    const ref = notice?.legalUpdate, requestScope = scope();
    if (notice?.kind !== 'legal_update' || !['terms', 'privacy'].includes(ref?.kind) || !ref.revisionId ||
        String(notice.recipientId || '') !== String(api()?.clientAuthSnapshot?.()?.user?.id || '') || !notice.recipientId) return false;
    if (reader?.active()) return false;
    const current = await refresh(true);
    if (requestScope !== scope()) return false;
    if (!current) throw Error(tx('协议内容暂未加载，请稍后重试。'));
    const update = current.updates?.find(item => item.key === ref.kind && item.revisionId === ref.revisionId);
    if (update) return open(ref.kind);
    // Read/cleared/acknowledged messages never imply consent. Historical inbox
    // entries open their immutable original without accepting a newer revision.
    let rows = (current.documents || []).filter(row => (row.key || row.kind) === ref.kind && row.revisionId === ref.revisionId);
    if (!rows.length) {
      let result;
      try { result = global.AccountUI.check(await api().clientAccountRequest('legalVersion', { id: ref.revisionId })); }
      catch (_) {
        if (requestScope !== scope()) return false;
        throw Error(tx('协议内容暂未加载，请稍后重试。'));
      }
      if (requestScope !== scope()) return false;
      rows = (result.documents || []).filter(row => (row.key || row.kind) === ref.kind && row.revisionId === ref.revisionId);
    }
    if (!rows.length) throw Error(tx('协议内容暂未加载，请稍后重试。'));
    if (reader?.active()) return false;
    reader = global.AccountUI.legal(document.body, rows, ref.kind, { getScope: scope });
    const dialog = reader;
    dialog.mask.addEventListener('ac-close', () => { if (reader === dialog) reader = null; });
    return true;
  }
  function open(kind) {
    if (reader?.active() || !data?.updates?.length || owner !== scope()) return false;
    const update = typeof kind === 'string' ? data.updates.find(item => item.key === kind)
      : data.updates.find(item => item.action === 'accept') || data.updates[0];
    if (!update) return false;
    const requiresAcceptance = update.action === 'accept';
    let documentRow = selected(update.key), checkbox, saving = false, summary;
    if (!documentRow || documentRow.revisionId !== update.revisionId) return false;
    const requestScope = scope();
    reader = global.AccountUI.legal(document.body, data.documents, update.key, {
      requiredVersions: data.requiredConsentVersions, getScope: scope,
      onSelection(doc) {
        if (checkbox && (documentRow?.locale !== doc?.locale || documentRow?.revisionId !== doc?.revisionId)) {
          checkbox.checked = false; if (action) action.disabled = true;
        }
        documentRow = doc;
        if (summary) { summary.textContent = doc?.summary || ''; summary.lang = doc?.locale || ''; }
      }
    });
    const dialog = reader, footer = dialog.mask.querySelector('.ac-legal-footer');
    const updateInfo = document.createElement('section'); updateInfo.className = 'ac-legal-update-summary';
    const heading = document.createElement('b'); heading.textContent = tx('本次更新');
    summary = document.createElement('p'); summary.setAttribute('translate', 'no'); summary.textContent = documentRow?.summary || ''; summary.lang = documentRow?.locale || '';
    updateInfo.append(heading, summary); dialog.mask.querySelector('.ac-legal-reading').prepend(updateInfo);
    const status = document.createElement('p'); status.className = 'ac-status'; status.setAttribute('role', 'status');
    footer.replaceChildren();
    let action;
    if (requiresAcceptance) {
      const label = document.createElement('label'); label.className = 'ac-legal-accept';
      checkbox = document.createElement('input'); checkbox.type = 'checkbox';
      const copy = document.createElement('span'); copy.textContent = tx('我已阅读并同意更新后的用户协议');
      label.append(checkbox, copy); footer.append(label);
      checkbox.onchange = () => { action.disabled = !checkbox.checked || saving; };
    }
    const controls = document.createElement('div'); controls.className = 'ac-legal-update-actions';
    const close = button(requiresAcceptance ? '暂不接受' : '关闭', dialog.close);
    action = button(requiresAcceptance ? '同意并继续' : '已知悉', async () => {
      if (saving || (requiresAcceptance && !checkbox.checked) || !documentRow || requestScope !== scope()) return;
      saving = true; action.disabled = true; close.disabled = true;
      try {
        const result = global.AccountUI.check(await api().clientAccountRequest('legalResponse', {
          kind: update.key, revisionId: documentRow.revisionId, locale: documentRow.locale,
          action: requiresAcceptance ? 'accept' : 'notice'
        }));
        if (requestScope !== scope()) return;
        pending++; request = null; data = result; checkedAt = Date.now(); dialog.close(); syncNotices();
      } catch (error) {
        if (!dialog.active() || requestScope !== scope()) return;
        if (checkbox) checkbox.checked = false;
        status.textContent = tx(error?.code === 'LEGAL_VERSION_CHANGED' ? '协议已更新，请关闭后重新查看。' : '操作未完成，请重试');
        if (error?.code === 'LEGAL_VERSION_CHANGED') void refresh(true);
      } finally {
        saving = false;
        if (dialog.active()) { action.disabled = requiresAcceptance && !checkbox.checked; close.disabled = false; }
      }
    }, 'ac-primary');
    action.disabled = requiresAcceptance || !documentRow;
    controls.append(close, action); footer.append(status, controls);
    dialog.mask.addEventListener('ac-close', () => {
      if (reader === dialog) reader = null;
    });
    return true;
  }
  global.addEventListener('soduwork-legal-required', () => { void refresh(true).then(result => { if (result) open(); }); });
  global.addEventListener('soduwork-data-scope-changed', () => { if (owner !== scope()) clear(); void refresh(); });
  global.addEventListener('soduwork-client-auth-required', () => { if (owner !== scope()) clear(); });
  global.addEventListener('soduwork-locale-change', () => { reader?.close(); });
  global.addEventListener('focus', () => { void refresh(); });
  global.setInterval(() => { if (!document.hidden) void refresh(); }, 300000);
  global.LegalUpdates = { refresh, open, openNotice, noticeText, clear };
})(window);
