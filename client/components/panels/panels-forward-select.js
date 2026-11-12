/* Theme-aware presentation for existing assignment selects; the select remains the value owner. */
(function (global) {
  'use strict';
  const records = new Map(), roots = new Map();
  let opened = null, nextId = 0;
  const themeKeys = ['--bg-0', '--bg-1', '--bg-2', '--bg-3', '--ink', '--ink-2', '--ink-3', '--ink-4', '--ink-5',
    '--line', '--line-2', '--accent', '--accent-soft', '--font-ui', '--font-min-readable', '--font-scale'];
  const setAttr = (node, name, value) => {
    if (value == null) { if (node.hasAttribute(name)) node.removeAttribute(name); }
    else if (node.getAttribute(name) !== String(value)) node.setAttribute(name, String(value));
  };
  const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const optionDisabled = option => option.disabled || (option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled);
  function labelOf(select) {
    if (select.getAttribute('aria-label')) return select.getAttribute('aria-label');
    const named = (select.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
    if (named) return named;
    const label = select.labels?.[0];
    if (!label) return select.title || '选择选项';
    const copy = label.cloneNode(true);
    copy.querySelectorAll('select,.fwd-select,small').forEach(node => node.remove());
    return copy.textContent.trim() || '选择选项';
  }
  function unavailable(record) {
    return record.select.disabled || record.select.matches(':disabled') || !record.select.isConnected ||
      record.select.hidden || !record.wrap.getClientRects().length;
  }
  function sync(record) {
    const {select, trigger, value, wrap} = record;
    const chosen = select.options[select.selectedIndex];
    const label = labelOf(select), text = chosen?.textContent || select.dataset.placeholder || '请选择';
    setText(value, text);
    setAttr(trigger, 'title', text);
    setAttr(trigger, 'aria-label', label + '：' + text);
    setAttr(trigger, 'aria-describedby', select.getAttribute('aria-describedby'));
    const disabled = select.disabled || select.matches(':disabled');
    if (trigger.disabled !== disabled) trigger.disabled = disabled;
    if (wrap.hidden !== select.hidden) wrap.hidden = select.hidden;
    setAttr(trigger, 'aria-disabled', disabled ? 'true' : 'false');
    if (opened?.record === record) {
      if (unavailable(record)) close(false);
      else { renderOptions(); position(); }
    }
  }
  function close(restore = true) {
    if (!opened) return;
    const previous = opened; opened = null;
    previous.popup.remove();
    setAttr(previous.record.trigger, 'aria-expanded', 'false');
    setAttr(previous.record.trigger, 'aria-controls', null);
    window.removeEventListener('resize', position);
    window.removeEventListener('scroll', onScroll, true);
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('focusin', focusOutside, true);
    global.visualViewport?.removeEventListener('resize', position);
    global.visualViewport?.removeEventListener('scroll', position);
    if (previous.dialog) setAttr(previous.dialog, 'aria-owns', previous.owns);
    if (restore && previous.record.trigger.isConnected && !previous.record.trigger.disabled) previous.record.trigger.focus({preventScroll: true});
  }
  function outside(event) {
    if (opened && !opened.popup.contains(event.target) && !opened.record.wrap.contains(event.target)) close(false);
  }
  function focusOutside(event) {
    if (opened && !opened.popup.contains(event.target) && !opened.record.wrap.contains(event.target)) close(false);
  }
  function onScroll(event) {
    if (opened && !opened.popup.contains(event.target)) position();
  }
  function position() {
    if (!opened) return;
    const {record, popup} = opened;
    if (unavailable(record)) { close(false); return; }
    const rect = record.trigger.getBoundingClientRect(), margin = 8, gap = 5;
    const viewport = global.visualViewport;
    const leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
    const bottomEdge = topEdge + height, rightEdge = leftEdge + width;
    if (rect.bottom < topEdge || rect.top > bottomEdge || rect.right < leftEdge || rect.left > rightEdge) { close(false); return; }
    const compactTime = record.select.dataset.forwardSelect === 'compact-time';
    const menuWidth = Math.min(Math.max(rect.width, compactTime ? 96 : 240), width - margin * 2);
    popup.style.width = menuWidth + 'px';
    const below = bottomEdge - rect.bottom - gap - margin, above = rect.top - topEdge - gap - margin;
    const popupLimit = compactTime ? 220 : 340;
    const upward = below < Math.min(popupLimit, popup.scrollHeight) && above > below;
    popup.style.maxHeight = Math.max(96, Math.min(popupLimit, upward ? above : below)) + 'px';
    popup.style.left = Math.max(leftEdge + margin, Math.min(rect.left, rightEdge - menuWidth - margin)) + 'px';
    const actualHeight = popup.getBoundingClientRect().height;
    popup.style.top = Math.max(topEdge + margin, upward ? rect.top - gap - actualHeight : Math.min(rect.bottom + gap, bottomEdge - actualHeight - margin)) + 'px';
  }
  function activate(index, reveal = true) {
    if (!opened) return;
    opened.active = index;
    for (const row of opened.rows) {
      const current = row.index === index;
      row.node.classList.toggle('is-active', current);
      if (current) {
        setAttr(opened.compactTime ? opened.list : opened.search, 'aria-activedescendant', row.node.id);
        if (reveal) row.node.scrollIntoView({block: 'nearest'});
      }
    }
    if (index < 0) setAttr(opened.compactTime ? opened.list : opened.search, 'aria-activedescendant', null);
  }
  function renderOptions() {
    if (!opened) return;
    const {record, search, list} = opened, query = search.value.trim().toLocaleLowerCase();
    const oldActive = opened.active;
    list.replaceChildren(); opened.rows = [];
    Array.from(record.select.options).forEach((option, index) => {
      if (option.hidden || option.parentElement?.hidden || (query && !option.textContent.toLocaleLowerCase().includes(query))) return;
      const node = document.createElement('div'), disabled = optionDisabled(option);
      node.className = 'fwd-select-option'; node.id = opened.id + '-option-' + index;
      node.dataset.value = option.value; node.setAttribute('role', 'option');
      node.setAttribute('aria-selected', String(index === record.select.selectedIndex));
      node.setAttribute('aria-disabled', String(Boolean(disabled)));
      const text = document.createElement('span'); text.textContent = option.textContent; node.appendChild(text);
      const mark = document.createElement('span'); mark.className = 'fwd-select-check'; mark.setAttribute('aria-hidden', 'true');
      mark.textContent = index === record.select.selectedIndex ? '✓' : ''; node.appendChild(mark);
      node.addEventListener('pointermove', () => { if (!disabled) activate(index, false); });
      node.addEventListener('pointerdown', event => event.preventDefault());
      node.addEventListener('click', () => choose(index));
      list.appendChild(node); opened.rows.push({index, node, disabled});
    });
    if (!opened.rows.length) {
      const empty = document.createElement('div'); empty.className = 'fwd-select-empty';
      empty.textContent = '没有匹配的选项'; empty.setAttribute('role', 'status'); list.appendChild(empty);
    }
    const eligible = opened.rows.filter(row => !row.disabled);
    const next = eligible.find(row => row.index === oldActive) || eligible.find(row => row.index === record.select.selectedIndex) || eligible[0];
    activate(next?.index ?? -1, false);
  }
  function choose(index) {
    if (!opened) return;
    const record = opened.record, option = record.select.options[index];
    if (unavailable(record) || !option || optionDisabled(option) || option.hidden) return;
    const changed = record.select.selectedIndex !== index;
    record.select.selectedIndex = index;
    close(true); sync(record);
    if (changed) {
      record.select.dispatchEvent(new Event('input', {bubbles: true}));
      record.select.dispatchEvent(new Event('change', {bubbles: true}));
    }
    // A change handler may synchronously replace the native select and its trigger.
    enhance(record.root);
    if (!record.trigger.isConnected && record.select.id) {
      const replacement = document.getElementById(record.select.id);
      records.get(replacement)?.trigger.focus({preventScroll: true});
    }
  }
  function keydown(event) {
    if (!opened || event.isComposing) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const rows = opened.rows.filter(row => !row.disabled), current = rows.findIndex(row => row.index === opened.active);
      let next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 :
        event.key === 'ArrowDown' ? Math.min(rows.length - 1, current + 1) : Math.max(0, current - 1);
      activate(rows[next]?.index ?? -1); return;
    }
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); choose(opened.active); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') {
      event.preventDefault(); event.stopPropagation();
      const trigger = opened.record.trigger, scope = trigger.closest('[role="dialog"],.fwd-pop,form,.sch-form') || opened.record.root;
      const nodes = Array.from(scope.querySelectorAll('button,input,textarea,select,summary,a[href],[tabindex]'))
        .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
      const index = nodes.indexOf(trigger), next = nodes[(index + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length];
      close(false); (next || trigger).focus({preventScroll: true});
    }
  }
  function open(record, initial = '') {
    if (unavailable(record)) return;
    close(false);
    const popup = document.createElement('div'), search = document.createElement('input'), list = document.createElement('div');
    const id = 'fwd-select-menu-' + (++nextId);
    const compactTime = record.select.dataset.forwardSelect === 'compact-time';
    popup.className = 'fwd-select-popup' + (compactTime ? ' fwd-select-compact-time' : ''); popup.id = id;
    const style = getComputedStyle(record.trigger);
    for (const key of themeKeys) popup.style.setProperty(key, style.getPropertyValue(key));
    popup.style.fontSize = style.fontSize; popup.style.fontFamily = style.fontFamily;
    search.type = 'search'; search.className = 'fwd-select-search'; search.placeholder = record.select.dataset.searchPlaceholder || '搜索选项…'; search.autocomplete = 'off';
    search.setAttribute('role', 'combobox'); search.setAttribute('aria-label', record.select.dataset.searchPlaceholder || '搜索' + labelOf(record.select));
    search.setAttribute('aria-autocomplete', 'list'); search.setAttribute('aria-expanded', 'true');
    list.className = 'fwd-select-options'; list.id = id + '-list'; list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', labelOf(record.select)); search.setAttribute('aria-controls', list.id);
    popup.append(search, list); document.body.appendChild(popup);
    const dialog = record.trigger.closest('[role="dialog"]'), owns = dialog?.getAttribute('aria-owns');
    if (dialog) setAttr(dialog, 'aria-owns', [owns, id].filter(Boolean).join(' '));
    opened = {record, popup, search, list, id, rows: [], active: record.select.selectedIndex, dialog, owns, compactTime};
    setAttr(record.trigger, 'aria-expanded', 'true'); setAttr(record.trigger, 'aria-controls', list.id);
    search.value = compactTime ? '' : initial;
    search.addEventListener('input', () => { renderOptions(); position(); });
    popup.addEventListener('keydown', keydown);
    renderOptions(); position();
    if (compactTime) {
      list.tabIndex = -1;
      list.focus({preventScroll: true});
      activate(opened.active);
    } else search.focus({preventScroll: true});
    window.addEventListener('resize', position); window.addEventListener('scroll', onScroll, true);
    document.addEventListener('pointerdown', outside, true); document.addEventListener('focusin', focusOutside, true);
    global.visualViewport?.addEventListener('resize', position);
    global.visualViewport?.addEventListener('scroll', position);
  }
  function create(select, root) {
    const wrap = document.createElement('span'), trigger = document.createElement('button'), value = document.createElement('span');
    wrap.className = 'fwd-select'; trigger.className = 'fwd-select-trigger'; trigger.type = 'button';
    const autoId = !select.id;
    if (autoId) select.id = 'fwd-select-control-' + (++nextId);
    trigger.dataset.selectId = select.id; trigger.dataset.fwdSelect = select.id; trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
    value.className = 'fwd-select-value'; trigger.appendChild(value); wrap.appendChild(trigger); select.after(wrap);
    const original = {tabindex: select.getAttribute('tabindex'), ariaHidden: select.getAttribute('aria-hidden'),
      focus: Object.getOwnPropertyDescriptor(select, 'focus')};
    const record = {select, root, wrap, trigger, value, original, autoId}; records.set(select, record);
    select.classList.add('fwd-select-native'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
    // Existing validation focuses the select; direct that focus to its visible control.
    Object.defineProperty(select, 'focus', {configurable: true, value: options => trigger.focus(options)});
    record.onChange = () => sync(record); select.addEventListener('change', record.onChange);
    trigger.addEventListener('click', () => { if (opened?.record === record) close(true); else open(record); });
    trigger.addEventListener('keydown', event => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation(); open(record);
        if (opened) keydown(event);
      } else if (event.key.length === 1 && event.key !== ' ') { event.preventDefault(); open(record, event.key); }
    });
    sync(record); return record;
  }
  function dispose(record) {
    if (opened?.record === record) close(false);
    record.select.removeEventListener('change', record.onChange); record.wrap.remove();
    record.select.classList.remove('fwd-select-native');
    if (record.autoId) record.select.removeAttribute('id');
    setAttr(record.select, 'tabindex', record.original.tabindex); setAttr(record.select, 'aria-hidden', record.original.ariaHidden);
    if (record.original.focus) Object.defineProperty(record.select, 'focus', record.original.focus); else delete record.select.focus;
    records.delete(record.select);
  }
  function enhance(root) {
    if (!root?.querySelectorAll) return;
    for (const record of records.values()) {
      if (record.root === root && record.select !== root && !root.contains(record.select)) dispose(record);
    }
    const selects = root.matches?.('select') ? [root] : Array.from(root.querySelectorAll('select'));
    for (const select of selects) {
      if (select.multiple || select.size > 1 || select.dataset.forwardSelect === 'false') continue;
      const record = records.get(select);
      if (record && !record.wrap.isConnected && select.isConnected) { dispose(record); create(select, root); }
      else if (record) sync(record); else create(select, root);
    }
    if (!roots.has(root)) {
      const observer = new MutationObserver(() => enhance(root));
      observer.observe(root, {subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['disabled', 'hidden', 'selected', 'label', 'aria-label', 'aria-labelledby', 'aria-describedby', 'style']});
      roots.set(root, observer);
    }
  }
  function destroy(root) {
    for (const [owner, observer] of roots) {
      if (owner === root || root?.contains(owner)) { observer.disconnect(); roots.delete(owner); }
    }
    for (const record of records.values()) {
      if (record.root === root || record.select === root || root?.contains(record.select)) dispose(record);
    }
  }
  function focus(select) {
    if (!select) return;
    const root = select.closest('.fwd-pop');
    if (!records.has(select) && root) enhance(root);
    (records.get(select)?.trigger || select).focus({preventScroll: true});
  }
  function capture(root) {
    if (!opened || !root?.contains(opened.record.select)) return null;
    return {id:opened.record.select.id, query:opened.search.value,
      activeValue:opened.record.select.options[opened.active]?.value};
  }
  function restore(state, root) {
    if (!state || !root?.isConnected) return;
    const select = document.getElementById(state.id);
    if (!select || !root.contains(select)) return;
    enhance(root);
    const record = records.get(select);
    if (!record || unavailable(record)) return;
    open(record, state.query);
    const active = opened?.rows.find(row => !row.disabled && select.options[row.index]?.value === state.activeValue);
    if (active) activate(active.index);
  }
  global.ForwardSelect = {enhance, destroy, focus, capture, restore, closeAll: () => close(true)};
})(window);
