(function (global) {
  'use strict';
  // The admin and desktop reader share this policy. Imported HTML is inert:
  // no links, remote assets, selectors, positioning, event handlers or scripts.
  const tags = ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'span', 'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'hr', 'code', 'pre', 'sup', 'sub'];
  const enums = {
    'text-align': ['left', 'right', 'center', 'justify', 'start', 'end'],
    'font-weight': ['normal', 'bold', '400', '600', '700'],
    'font-style': ['normal', 'italic'],
    'text-decoration-line': ['none', 'underline', 'line-through', 'underline line-through'],
    'vertical-align': ['baseline', 'super', 'sub', 'top', 'middle', 'bottom']
  };
  function safeStyle(value) {
    const result = [];
    for (const declaration of String(value || '').split(';')) {
      const match = declaration.trim().match(/^([a-z-]+)\s*:\s*([^:]+)$/i);
      if (!match) continue;
      const key = match[1].toLowerCase(), val = match[2].trim().toLowerCase();
      if (enums[key]?.includes(val)) { result.push(key + ':' + val); continue; }
      if (!['font-size', 'line-height', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right', 'text-indent'].includes(key)) continue;
      const size = val.match(/^(-?\d+(?:\.\d+)?)(pt|px|em)?$/);
      if (!size) continue;
      const n = Number(size[1]), unit = size[2] || '';
      if (!unit && (key !== 'line-height' || n < 1 || n > 4)) continue;
      if (unit) {
        const bound = unit === 'em' ? 12 : 240;
        if (Math.abs(n) > bound || (n < 0 && key !== 'text-indent')) continue;
        if (key === 'font-size' && (n < (unit === 'em' ? 0.5 : 6) || n > (unit === 'em' ? 4 : 72))) continue;
        if (key === 'line-height' && n < (unit === 'em' ? 1 : 8)) continue;
      }
      result.push(key + ':' + val);
    }
    return result.join(';');
  }
  function fragment(purifier, html) {
    const result = purifier.sanitize(String(html || ''), {
      RETURN_DOM_FRAGMENT: true, ALLOWED_TAGS: tags,
      ALLOWED_ATTR: ['style', 'start', 'colspan', 'rowspan'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false
    });
    result.querySelectorAll('[style]').forEach(node => {
      const style = safeStyle(node.getAttribute('style'));
      node.removeAttribute('style'); if (style) node.setAttribute('style', style);
    });
    for (const name of ['start', 'colspan', 'rowspan']) result.querySelectorAll('[' + name + ']').forEach(node => {
      const value = node.getAttribute(name);
      if (!/^\d{1,4}$/.test(value) || Number(value) < 1) node.removeAttribute(name);
    });
    return result;
  }
  function sanitize(purifier, html) {
    const result = fragment(purifier, html), host = result.ownerDocument.createElement('div');
    host.appendChild(result); return host.innerHTML;
  }
  global.SoduWorkLegalHtml = Object.freeze({ fragment, sanitize, safeStyle });
})(typeof window === 'undefined' ? globalThis : window);
