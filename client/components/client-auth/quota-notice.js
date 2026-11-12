/* Account allowance guidance lives beside the composer, outside the transcript. */
(function (global) {
  'use strict';
  const cards = new Set();
  let current = null, owner = '', revision = 0, refreshFlight = null;
  let selections = new WeakMap();
  const composerCards = new WeakMap();
  const tx = value => global.SoduWorkI18n?.translateText?.(value) || value;
  const locale = () => global.SoduWorkI18n?.getLocale?.() || 'zh-CN';
  const scope = () => {
    const api = global.SoduWorkAPI;
    const user = api?.clientAuthSnapshot?.()?.user;
    const config = api?.hubConfig?.();
    return [config?.hub || '', user?.id || ''].join('|');
  };
  const copy = card => global.SoduWorkQuota.copy({ ...current,
    personalModelsAllowed: current?.personalModelsAllowed === true && selections.get(card)?.adapterId === 'pi' }, tx, locale());
  const personalSelectionAllowed = card => {
    const selected = selections.get(card);
    return selected?.adapterId === 'pi' && selected.model?.quotaVersion === 2 &&
      selected.model.quotaScope === 'personal' && global.SoduWorkQuota.allowsPersonal?.(current);
  };
  const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };

  function render(card) {
    const show = current?.exceeded === true && !personalSelectionAllowed(card);
    card.hidden = !show;
    if (!show) return;
    const value = copy(card);
    setText(card.querySelector('[data-quota-title]'), value.title);
    setText(card.querySelector('[data-quota-guidance]'), value.guidance);
    setText(card.querySelector('[data-quota-summary]'), tx('额度详情'));
    const detail = card.querySelector('[data-quota-detail]');
    const rows = [current?.planName || '', value.used, value.timing];
    for (const model of (current?.models || []).slice(0, 100)) {
      const remaining = model.remaining === null ? tx('不限额') :
        tx('剩余 {tokens} Tokens').replace('{tokens}', new Intl.NumberFormat(locale()).format(model.remaining || 0));
      rows.push([model.provider, model.model].filter(Boolean).join(' / ') + ' · ' + remaining);
      if (Number(model.unattributedUsed) > 0) rows.push(tx('其中 {tokens} Tokens 来自旧版用量，已计入当前模型额度')
        .replace('{tokens}', new Intl.NumberFormat(locale()).format(model.unattributedUsed)));
    }
    setText(detail, rows.filter(Boolean).join('\n'));
    const button = card.querySelector('[data-quota-refresh]');
    button.disabled = Boolean(refreshFlight);
    setText(button, refreshFlight ? tx('正在刷新') : tx('刷新额度'));
    setText(card.querySelector('[data-quota-feedback]'), card.dataset.feedback === 'failed'
      ? tx('暂时无法刷新，请稍后重试。') : '');
  }

  function paint() {
    for (const card of cards) {
      if (!card.isConnected) { cards.delete(card); continue; }
      render(card);
    }
  }

  function update(detail = {}) {
    const nextOwner = scope();
    if (owner !== nextOwner) { owner = nextOwner; current = null; selections = new WeakMap(); refreshFlight = null; revision++; }
    if (detail.quota && typeof detail.quota === 'object') {
      const next = detail.quota;
      const selected = current?.model || current?.requestedModel;
      if (!next.exceeded && selected && /^(model_exhausted|model_not_allowed)$/.test(current?.reason || '')) {
        const row = (next.models || []).find(item => item.provider === selected.provider && item.model === selected.model);
        current = row?.exceeded ? { ...next, exceeded: true, reason: 'model_exhausted', model: row }
          : !row && next.restrictModels ? { ...next, exceeded: true, reason: 'model_not_allowed', requestedModel: selected }
            : next;
      } else current = next;
    }
    paint();
  }

  function show(value) {
    const found = global.SoduWorkQuota?.detail(value);
    if (!found) return false;
    update({ quota: found.quota || (current?.exceeded ? current : { enabled: true, exceeded: true }) });
    return true;
  }

  async function refresh() {
    if (refreshFlight) return refreshFlight;
    const requestScope = scope(), requestRevision = revision;
    const api = global.SoduWorkAPI;
    if (typeof api?.clientAuthMe !== 'function') return;
    const flight = Promise.resolve().then(() => api.clientAuthMe()).then(result => {
      if (requestScope !== scope() || requestRevision !== revision) return;
      if (!result?.quota) throw Error('Allowance response missing');
      for (const card of cards) delete card.dataset.feedback;
      global.ClientAuth?.updateIdentity?.(result.user, result.quota);
      update(result);
    }).catch(() => {
      if (requestScope !== scope() || requestRevision !== revision) return;
      for (const card of cards) card.dataset.feedback = 'failed';
    }).finally(() => { if (refreshFlight === flight) refreshFlight = null; paint(); });
    refreshFlight = flight;
    paint();
    return refreshFlight;
  }

  function mount(composer) {
    if (!composer?.parentElement) return null;
    const previous = composer.previousElementSibling;
    if (previous?.classList.contains('soduwork-quota-card')) { composerCards.set(composer, previous); return previous; }
    const card = document.createElement('aside');
    card.className = 'soduwork-quota-card'; card.hidden = true;
    const element = (tag, attributes, children = []) => {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
      node.append(...children);
      return node;
    };
    card.append(
      element('div', { class: 'quota-card-copy', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, [
        element('b', { 'data-quota-title': '' }), element('p', { 'data-quota-guidance': '' }),
      ]),
      element('div', { class: 'quota-card-actions' }, [
        element('details', {}, [element('summary', { 'data-quota-summary': '' }), element('p', { 'data-quota-detail': '' })]),
        element('button', { type: 'button', 'data-quota-refresh': '' }),
      ]),
      element('p', { class: 'quota-card-feedback', 'data-quota-feedback': '', role: 'status', 'aria-live': 'polite' }),
    );
    card.querySelector('[data-quota-refresh]').addEventListener('click', refresh);
    composer.before(card); cards.add(card); composerCards.set(composer, card); paint();
    return card;
  }

  function modelChanged(selection, adapterId = '', surface) {
    const composer = composerCards.has(surface) ? surface : surface?.querySelector?.('.work-composer');
    const card = composer && composerCards.get(composer);
    if (card) selections.set(card, { model: selection && typeof selection === 'object' ? selection : null, adapterId });
    else if (!selection) selections = new WeakMap();
    if (!current) return;
    const modelSpecific = /^(model_exhausted|model_not_allowed)$/.test(current.reason || '');
    if (current.exceeded && !modelSpecific) { paint(); return; }
    const model = typeof selection === 'string' ? selection : selection?.id || '';
    const provider = selection?.quotaProvider || '';
    const rows = (current.models || []).filter(row => row.model === model && (!provider || row.provider === provider));
    current = { ...current, exceeded: false, reason: '', model: null, requestedModel: null };
    // Ambiguous provider names are rechecked by admission rather than guessed here.
    if (rows.length === 1 && rows[0].exceeded) current = { ...current, exceeded: true, reason: 'model_exhausted', model: rows[0] };
    else if (model && !rows.length && current.restrictModels) current = { ...current, exceeded: true,
      reason: 'model_not_allowed', requestedModel: { provider, model } };
    paint();
  }
  function refreshIfBlocked() { if (current?.exceeded) return refresh(); }
  function markRestored() {
    if (!current?.exceeded) return false;
    // A restoration notification is an authoritative user-facing signal. Hide
    // the stale card immediately, then reconcile with the Hub in the
    // background so a model-specific limit can still be shown if it remains.
    current = { ...current, exceeded: false, reason: '', model: null, requestedModel: null };
    for (const card of cards) delete card.dataset.feedback;
    global.ClientAuth?.clearQuotaNotice?.();
    revision++;
    refreshFlight = null;
    paint();
    return refresh();
  }
  function reset() { current = null; selections = new WeakMap(); refreshFlight = null; owner = scope(); revision++; paint(); }
  global.addEventListener('soduwork-data-scope-changed', reset);
  global.addEventListener('soduwork-locale-change', paint);
  global.SoduWorkQuotaNotice = { mount, update, show, reset, refresh, refreshIfBlocked, markRestored, modelChanged };
})(window);
