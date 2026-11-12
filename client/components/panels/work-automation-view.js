/* Pure form rendering shared by the automation sheet; all catalog text is escaped. */
(function (global) {
  'use strict';
  const esc = value => String(value == null ? '' : value).replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cut = (value, max) => String(value || '').trim().slice(0, max);
  function methodFieldsHtml(method, values) {
    if (!method) {
      return '<p class="waz-method-hint">不选工作方法时，Agent 会按上面的执行说明直接完成。</p>';
    }
    const fields = (method.inputs || []).map(field => {
      const key = cut(field.key, 80);
      const hasValue = Object.prototype.hasOwnProperty.call(values || {}, key);
      const value = hasValue ? values[key] : field.default;
      const label = esc(field.label || key) + (field.required ? ' <b>*</b>' : '');
      const help = field.description ? "<small data-user-content>" + esc(field.description) + '</small>' : '';
      if (field.type === 'boolean') {
        return '<label class="waz-check"><input type="checkbox" data-waz-method-input="' +
          esc(key) + '" data-input-type="boolean"' + (value ? ' checked' : '') +
          '><span>' + label + help + '</span></label>';
      }
      if (field.type === 'select') {
        const options = (field.options || []).map(option => {
          const itemValue = typeof option === 'object' ? option.value : option;
          const itemLabel = typeof option === 'object' ? (option.label || option.value) : option;
          return '<option value="' + esc(itemValue) + '"' +
            (String(itemValue) === String(value == null ? '' : value) ? ' selected' : '') +
            '>' + esc(itemLabel) + '</option>';
        }).join('');
        return '<label class="waz-field"><span>' + label + help + '</span><select data-waz-method-input="' +
          esc(key) + '">' + options + '</select></label>';
      }
      const type = field.type === 'number' ? 'number' : 'text';
      return '<label class="waz-field"><span>' + label + help + '</span><input type="' + type +
        '" data-waz-method-input="' + esc(key) + '" data-input-type="' + type +
        '" value="' + esc(value == null ? '' : value) + '"></label>';
    }).join('');
    return "<div class=\"waz-method-card\"><div><b data-user-content>" + esc(method.name) + '</b><span>固定 v' +
      esc(method.version || '') + '</span></div>' +
      (method.description ? "<p data-user-content>" + esc(method.description) + '</p>' : '') +
      (fields ? '<div class="waz-method-fields">' + fields + '</div>' :
        '<p class="waz-method-hint">这个方法不需要额外参数。</p>') + '</div>';
  }

  function optionRows(items, current, emptyLabel, pending) {
    return '<option value="">' + esc(emptyLabel) + '</option>' +
      (pending ? '<option value="__waz_unresolved__" selected>请确认指定的工程</option>' : '') +
      (!pending && current && !items.some(item => String(item.id) === String(current))
        ? '<option value="' + esc(current) + '" selected>已指定的工程不可用 · 请重新选择</option>' : '') + items.map(item =>
      '<option value="' + esc(item.id) + '"' +
      (String(item.id) === String(current || '') ? ' selected' : '') + '>' +
      esc(item.name || item.title || item.id) + '</option>').join('');
  }

  // Restore scroll position and focus after plugin or runtime changes rebuild the fields.
  function rememberView(body) {
    const fields = body.querySelector?.('.waz-fields');
    if (!fields) return () => {};
    const scrollTop = fields.scrollTop;
    const active = body.contains(document.activeElement) ? document.activeElement : null;
    const name = active?.name || (active?.dataset?.selectId && document.getElementById(active.dataset.selectId)?.name);
    const reload = active?.hasAttribute('data-waz-reload-agents');
    return () => {
      const next = body.querySelector('.waz-fields');
      if (next) next.scrollTop = scrollTop;
      const control = name ? [...body.querySelectorAll('[name]')].find(node => node.name === name) :
        reload ? body.querySelector('[data-waz-reload-agents]') : null;
      control?.focus({ preventScroll: true });
    };
  }

  // Manage focus within standalone dialogs; inline sheets retain the conversation's reading order.
  function mountDialog(surface, onClose) {
    if (surface.inline) return () => {};
    const root = surface.root, sheet = root.querySelector('.waz-sheet');
    const previous = document.activeElement;
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.tabIndex = -1;
    const controls = () => [...sheet.querySelectorAll('button,input,textarea,select,[tabindex="0"]')]
      .filter(node => !node.disabled && !node.closest('[hidden]') && node.getClientRects().length);
    const onKey = event => {
      if (event.defaultPrevented || !root.isConnected ||
          document.querySelector('dialog:modal,[popover]:popover-open,.catt-preview')) return;
      // Handle focus only inside this dialog or on body after redraw; do not steal it from other overlays or menus.
      if (!root.contains(document.activeElement) && document.activeElement !== document.body) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); onClose(); return;
      }
      if (event.key !== 'Tab') return;
      const nodes = controls(), first = nodes[0] || sheet, last = nodes.at(-1) || sheet;
      if (!root.contains(document.activeElement) || document.activeElement === sheet ||
          (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', onKey);
    root.querySelector('.waz-close').focus({ preventScroll: true });
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous?.isConnected && (root.contains(document.activeElement) || document.activeElement === document.body)) {
        previous.focus({ preventScroll: true });
      }
    };
  }

  global.WorkAutomationView = {methodFieldsHtml, optionRows, mountDialog, rememberView};
})(window);
