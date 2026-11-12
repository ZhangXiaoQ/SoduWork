(function (global) {
  'use strict';
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const email = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim()) && String(value).length <= 254;
  const code = value => /^\d{6}$/.test(String(value || ''));
  function error(value) {
    return String(value && (value.error || value.message || value.reason) || '操作未完成，请重试');
  }
  function check(result) {
    if (!result || result.ok === false) throw Object.assign(Error(error(result)), result || {});
    return result;
  }
  function modal(parent, title, body, className) {
    const previous = document.activeElement;
    const owner = global.SoduWorkAPI?.clientAuthSnapshot?.()?.user?.id;
    const hub = global.SoduWorkAPI?.hubBase?.();
    const mask = document.createElement('div');
    mask.className = 'ac-mask ' + (className || '');
    mask.innerHTML = '<section class="ac-dialog" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
      '<header class="ac-dialog-head"><h2>' + esc(title) + '</h2><button type="button" class="ac-icon" data-ac-close aria-label="关闭对话框">×</button></header>' +
      '<div class="ac-dialog-body">' + body + '</div></section>';
    parent.appendChild(mask);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      mask.dispatchEvent(new Event('ac-close'));
      mask.remove(); document.removeEventListener('keydown', keydown, true);
      global.removeEventListener('soduwork-data-scope-changed', scopeChanged);
      global.removeEventListener('soduwork-client-auth-required', scopeChanged);
      if (previous?.isConnected) previous.focus();
    };
    const scopeChanged = () => {
      if (owner !== global.SoduWorkAPI?.clientAuthSnapshot?.()?.user?.id || hub !== global.SoduWorkAPI?.hubBase?.()) close();
    };
    const keydown = event => {
      if (document.querySelectorAll('.ac-mask').length && [...document.querySelectorAll('.ac-mask')].at(-1) !== mask) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      if (event.key !== 'Tab') return;
      const fields = [...mask.querySelectorAll('button,input,textarea,select,a[href]')].filter(el => !el.disabled && el.getClientRects().length);
      if (!fields.length) return;
      const first = fields[0], last = fields.at(-1);
      if (event.shiftKey && (document.activeElement === first || !mask.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown, true);
    global.addEventListener('soduwork-data-scope-changed', scopeChanged);
    global.addEventListener('soduwork-client-auth-required', scopeChanged);
    mask.querySelector('[data-ac-close]').addEventListener('click', close);
    mask.querySelector('input,button')?.focus();
    return { mask, close, active: () => !closed && mask.isConnected };
  }
  const documentKind = row => row?.kind || row?.type || row?.key || row?.id;
  function documentLocale(row) {
    const value = row?.locale || row?.language;
    if (!value) return '';
    try { return Intl.getCanonicalLocales(String(value).replace(/_/g, '-'))[0] || ''; }
    catch (_) { return ''; }
  }
  function legalSelection(documents, kind, locale, version) {
    const candidates = (Array.isArray(documents) ? documents : []).filter(row => documentKind(row) === kind);
    // Only choose translations of the same published revision, never an older translation.
    const currentVersion = version || candidates[0]?.version;
    const rows = candidates.filter(row => !currentVersion || row.version === currentVersion);
    const exact = rows.find(row => documentLocale(row) === locale);
    const family = String(locale || '').split('-')[0];
    const related = family !== 'zh' && rows.find(row => documentLocale(row).split('-')[0] === family);
    return { rows, document: exact || related || rows.find(row => row.defaultLocale === true) || rows[0] };
  }
  function legal(parent, documents, kind, options = {}) {
    let rows = Array.isArray(documents) ? documents : [];
    const activeKind = kind === 'terms' ? 'terms' : 'privacy';
    let manualLocale = '', revision = 0, loading = false, consents = options.consents || [];
    const tx = (source, params) => global.SoduWorkI18n?.t?.(source, source, params) || source.replace(/\{(\w+)\}/g, (match, key) => params?.[key] ?? match);
    const locale = () => global.SoduWorkI18n?.getLocale?.() || document.documentElement.lang || 'en-US';
    const scope = options.getScope?.();
    const title = () => tx(activeKind === 'terms' ? '用户协议' : '隐私政策');
    const dialog = modal(parent, title(),
      '<div class="ac-legal-toolbar">' +
      '<label class="ac-legal-language" hidden><span></span><select data-document-language></select></label></div>' +
      '<div class="ac-legal-layout"><aside class="ac-legal-toc"><h3></h3><ol></ol></aside>' +
      '<div class="ac-legal-reading"><p class="ac-legal-language-note" role="status" hidden></p>' +
      '<article class="ac-legal-copy" data-user-content translate="no"></article>' +
      '<div class="ac-legal-empty" hidden><p class="ac-status" role="status"></p><button type="button" class="ac-secondary" data-legal-retry></button></div>' +
      '<details class="ac-legal-records" hidden><summary></summary><div data-user-content translate="no"></div></details></div></div>' +
      '<footer class="ac-legal-footer"><button type="button" class="ac-secondary" data-legal-back></button></footer>', 'ac-legal');
    const q = selector => dialog.mask.querySelector(selector);
    const valid = () => dialog.active() && (!options.getScope || scope === options.getScope());
    const reading = q('.ac-legal-reading'), copy = q('.ac-legal-copy'), toc = q('.ac-legal-toc');
    const language = q('[data-document-language]');
    const titleNode = q('.ac-dialog-head h2');
    const languageName = value => {
      if (!value) return tx('原文');
      try { return new Intl.DisplayNames([locale()], { type: 'language' }).of(value) || value; }
      catch (_) { return value; }
    };
    function displayDate(value) {
      if (!value) return '';
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(value));
      const parsed = new Date(dateOnly ? value + 'T12:00:00Z' : value);
      if (!Number.isFinite(parsed.getTime())) return '';
      return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', ...(dateOnly ? { timeZone: 'UTC' } : {}) }).format(parsed);
    }
    function renderCopy(doc) {
      copy.replaceChildren(); q('.ac-legal-toc ol').replaceChildren();
      const text = String(doc?.content || doc?.body || '');
      const sourceLocale = documentLocale(doc);
      if (sourceLocale) copy.lang = sourceLocale; else copy.removeAttribute('lang');
      const html = doc?.format === 'html' && global.SoduWorkLegalHtml && global.DOMPurify;
      copy.classList.toggle('sw-legal-html', !!html);
      if (doc?.title && !html) {
        const heading = document.createElement('h2'); heading.className = 'ac-legal-document-title';
        heading.textContent = doc.title; copy.appendChild(heading);
      }
      let buffer = [], headings = 0;
      function chapter(label) {
        const item = document.createElement('li'); item.textContent = label;
        item.setAttribute('translate', 'no'); if (sourceLocale) item.lang = sourceLocale;
        q('.ac-legal-toc ol').appendChild(item); headings++;
      }
      function flush() {
        if (!buffer.length) return;
        const block = document.createElement('div'); block.className = 'ac-legal-paragraph';
        block.textContent = buffer.join('\n'); copy.appendChild(block); buffer = [];
      }
      const markdown = doc?.format === 'markdown' && global.marked && global.DOMPurify;
      if (html) {
        copy.appendChild(global.SoduWorkLegalHtml.fragment(global.DOMPurify, text));
        copy.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(node => chapter(node.textContent));
      } else if (markdown) {
        copy.appendChild(global.DOMPurify.sanitize(global.marked.parse(text), {
          RETURN_DOM_FRAGMENT: true,
          ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'code', 'pre'],
          ALLOWED_ATTR: ['start', 'colspan', 'rowspan']
        }));
        copy.querySelectorAll('h1,h2:not(.ac-legal-document-title),h3,h4').forEach(node => {
          chapter(node.textContent);
        });
      }
      for (const line of markdown || html ? [] : text.split(/\r?\n/)) {
        const heading = line.trim();
        if (heading.length <= 120 && /^(?:#{1,3}\s+|[一二三四五六七八九十百]+[、．]|第[一二三四五六七八九十百\d]+[章节]|\d+(?:\.\d+)*[.、．]\s)/.test(heading)) {
          flush();
          const node = document.createElement('h3'); node.textContent = line; copy.appendChild(node);
          chapter(heading);
        } else buffer.push(line);
      }
      flush(); toc.hidden = !headings;
      q('.ac-legal-empty').hidden = !!text;
      q('.ac-legal-empty .ac-status').textContent = tx(loading ? '正在加载协议…' : '协议内容暂未加载，请稍后重试。');
      q('[data-legal-retry]').hidden = !options.load;
      q('[data-legal-retry]').disabled = loading;
    }
    function renderRecords() {
      const records = (Array.isArray(consents) ? consents : []).filter(row => row.document === activeKind);
      const panel = q('.ac-legal-records'); panel.hidden = !records.length;
      panel.querySelector('summary').textContent = tx('我的确认记录');
      const body = panel.querySelector('div'); body.replaceChildren();
      for (const row of records) {
        const item = document.createElement('p');
        item.textContent = [tx('版本：{value}', { value: row.version }), displayDate(row.acceptedAt)].filter(Boolean).join(' · ');
        if (row.locale) item.textContent += ' · ' + languageName(row.locale);
        if (row.revisionId && options.loadVersion) {
          const link = document.createElement('button'); link.className = 'ac-link'; link.type = 'button';
          link.textContent = tx('查看当时版本');
          link.onclick = () => legal(document.body, [], activeKind, {
            getScope: options.getScope, requiredVersions: { [activeKind]: row.version },
            load: () => options.loadVersion(row.revisionId)
          });
          item.append(' · ', link);
        }
        body.appendChild(item);
      }
    }
    function render(resetScroll = false) {
      if (!valid()) { dialog.close(); return; }
      const scroll = resetScroll ? 0 : reading.scrollTop;
      const selection = legalSelection(rows, activeKind, manualLocale || locale(), options.requiredVersions?.[activeKind]);
      const doc = selection.document, sourceLocale = documentLocale(doc);
      options.onSelection?.(doc);
      titleNode.textContent = title(); q('.ac-dialog').setAttribute('aria-label', title());
      q('[data-ac-close]').setAttribute('aria-label', tx('关闭对话框'));
      q('.ac-legal-toc h3').textContent = tx('协议目录');
      q('.ac-legal-language span').textContent = tx('正文语言');
      const choices = [...new Set(selection.rows.map(documentLocale))];
      language.replaceChildren();
      for (const value of choices) {
        const option = document.createElement('option'); option.value = value;
        option.textContent = languageName(value); option.setAttribute('translate', 'no'); language.appendChild(option);
      }
      language.value = sourceLocale; q('.ac-legal-language').hidden = choices.length < 2;
      q('.ac-legal-toolbar').hidden = choices.length < 2;
      const matching = legalSelection(selection.rows, activeKind, locale()).document;
      const matchesLocale = sourceLocale === locale() || (locale().split('-')[0] !== 'zh' && sourceLocale.split('-')[0] === locale().split('-')[0]);
      const note = q('.ac-legal-language-note'); note.hidden = !sourceLocale || matchesLocale || !!manualLocale;
      note.textContent = tx('暂无当前界面语言的版本，以下为{language}原文。', { language: languageName(documentLocale(matching)) });
      renderCopy(doc); renderRecords();
      q('[data-legal-retry]').textContent = tx('重新加载');
      const back = q('[data-legal-back]'); if (back) back.textContent = tx(options.returnLabel || '关闭');
      reading.scrollTop = scroll;
    }
    async function reload() {
      if (!options.load || loading || !valid()) return;
      const pending = ++revision; loading = true; render();
      try {
        const result = check(await options.load());
        if (pending !== revision || !valid()) return;
        rows = Array.isArray(result) ? result : result.documents || result.legalDocuments || [];
        if (Array.isArray(result.consents)) consents = result.consents;
        if (result.requiredConsentVersions) options.requiredVersions = result.requiredConsentVersions;
        options.onLoaded?.(result);
      } catch (_) {
        if (pending !== revision || !valid()) return;
      } finally {
        if (pending === revision && valid()) { loading = false; render(); }
      }
    }
    language.addEventListener('change', () => { manualLocale = language.value; render(true); });
    q('[data-legal-retry]').addEventListener('click', reload);
    q('[data-legal-back]').addEventListener('click', dialog.close);
    const onLocaleChange = () => { manualLocale = ''; render(); };
    global.addEventListener?.('soduwork-locale-change', onLocaleChange);
    dialog.mask.addEventListener('ac-close', () => { revision++; global.removeEventListener?.('soduwork-locale-change', onLocaleChange); });
    render();
    if (!rows.length) reload();
    return dialog;
  }
  function bindPassword(parent) {
    const tx = value => (global.SoduWorkI18n && typeof global.SoduWorkI18n.translateText === 'function')
      ? global.SoduWorkI18n.translateText(value) : value;
    const refresh = () => parent.querySelectorAll('[data-password-toggle]').forEach(button => {
      const input = parent.querySelector('#' + button.dataset.passwordToggle);
      const visible = input && input.type === 'text';
      button.textContent = tx(visible ? '隐藏' : '显示');
      button.setAttribute('aria-label', tx(visible ? '隐藏密码' : '显示密码'));
      button.setAttribute('aria-pressed', String(visible));
    });
    parent.querySelectorAll('[data-password-toggle]').forEach(button => button.addEventListener('click', () => {
      const input = parent.querySelector('#' + button.dataset.passwordToggle);
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password'; refresh();
    }));
    refresh();
    const onLocaleChange = () => refresh();
    global.addEventListener?.('soduwork-locale-change', onLocaleChange);
    parent._accountUiPasswordLocaleDispose = () => global.removeEventListener?.('soduwork-locale-change', onLocaleChange);
  }
  global.AccountUI = { esc, email, code, error, check, modal, legal, legalSelection, bindPassword };
})(window);
