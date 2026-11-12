/* Shared, presentation-only helpers for the employee plugin catalog. */
(function (global) {
  'use strict';

  const ICON = {
    plugin: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M9 9h6v6H9zM12 6v3m0 6v3M6 12h3m6 0h3"/></svg>',
    assistant: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m12 3 1.35 4.15a5.7 5.7 0 0 0 3.5 3.5L21 12l-4.15 1.35a5.7 5.7 0 0 0-3.5 3.5L12 21l-1.35-4.15a5.7 5.7 0 0 0-3.5-3.5L3 12l4.15-1.35a5.7 5.7 0 0 0 3.5-3.5z"/></svg>',
    slides: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3.5" y="4" width="17" height="13" rx="2.5"/><path d="M8 13V9m4 4V7m4 6v-2M9 20l3-3 3 3"/></svg>',
    writing: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 3.5h9.5L19 8v12.5H5zM14.5 3.5V8H19"/><path d="M8 12h5m-5 3h7m-7 3h4"/></svg>',
    story: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 5.5c2.8-.8 5.4-.3 8 1.5v12c-2.6-1.8-5.2-2.3-8-1.5zM20 5.5c-2.8-.8-5.4-.3-8 1.5v12c2.6-1.8 5.2-2.3 8-1.5z"/></svg>',
    research: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 4h8m-8 4h5m-5 4h4"/><circle cx="14.5" cy="14.5" r="4.5"/><path d="m18 18 3 3"/></svg>',
    report: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M9 3.5v3h6v-3M9 16v-3m3 3V9m3 7v-5"/></svg>',
    code: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3.5" y="4" width="17" height="16" rx="3"/><path d="M3.5 8h17m-11 3-2.5 2.5L9.5 16m5-5 2.5 2.5-2.5 2.5"/></svg>',
    review: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3.5 19 6v5.5c0 4.5-2.8 7.5-7 9-4.2-1.5-7-4.5-7-9V6z"/><path d="m8.5 12 2.2 2.2 4.8-4.8"/></svg>',
    release: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14 4c3-1 5-1 6-1 0 1 0 3-1 6l-5.5 5.5-4-4zM9.5 10.5 6 11l-2 2 5 1m4.5.5L13 18l-2 2-1-5"/><circle cx="15.5" cy="7.5" r="1.5"/></svg>',
    creative: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8.5 15.5c-1.7-1.2-2.7-3-2.7-5.1A6.2 6.2 0 0 1 12 4.2a6.2 6.2 0 0 1 6.2 6.2c0 2.1-1 3.9-2.7 5.1-.8.6-1.2 1.2-1.2 2H9.7c0-.8-.4-1.4-1.2-2zM9.5 20h5M9.7 17.5h4.6"/><path d="M9.5 10.5c.7.8 1.5 1.2 2.5 1.2s1.8-.4 2.5-1.2"/></svg>',
    upload: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v5h14v-5"/></svg>',
    maker: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m4 20 1-5L16.5 3.5l4 4L9 19zM14.5 5.5l4 4M5 4h5M7.5 1.5v5"/></svg>',
    flow: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3.5" y="4" width="6" height="5" rx="1.5"/><rect x="14.5" y="15" width="6" height="5" rx="1.5"/><path d="M9.5 6.5h2.5a5 5 0 0 1 5 5V15"/><path d="m14.5 12.5 2.5 2.5 2.5-2.5"/></svg>',
    skill: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m12 4 1.1 3.4a4.8 4.8 0 0 0 3.1 3.1l3.3 1.1-3.3 1.1a4.8 4.8 0 0 0-3.1 3.1L12 19.2l-1.1-3.4a4.8 4.8 0 0 0-3.1-3.1l-3.3-1.1 3.3-1.1a4.8 4.8 0 0 0 3.1-3.1z"/></svg>',
    mcp: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="7" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="m8.4 11 7.2-3m-7.2 5 7.2 3"/></svg>',
    shield: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3.5 19 6v5.5c0 4.5-2.8 7.5-7 9-4.2-1.5-7-4.5-7-9V6z"/><path d="m8.7 12 2.1 2.1 4.5-4.5"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9.5 6.5 5.5 5.5-5.5 5.5"/></svg>',
  };

  function h(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  }

  async function copyText(value) {
    try { await navigator.clipboard.writeText(String(value || '')); return true; } catch (_) {}
    const area = document.createElement('textarea');
    area.value = String(value || ''); area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.appendChild(area); area.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (_) {}
    area.remove(); return ok;
  }

  function sourceName(kind) {
    return ({ codex: 'Codex 插件', claude: 'Claude Code 插件', 'agent-plugins': 'Agent Plugins 标准包', soduwork: 'SoduWork 插件',
      adapter: 'SoduWork 标准插件', builtin: 'SoduWork 内置', personal: '个人插件' })[kind] || '企业插件';
  }

  function nodeName(type) {
    return ({ ai: 'AI 执行', ai_review: 'AI 审查', quality: '质量检查',
      human_review: '人工验收', approval: '人工门禁', deploy: '环境发布',
      deploy_chain: '发布链', merge: '自动合并', publish: '办结',
      condition: '条件判断', script: '自动脚本', tool: '业务工具' })[type] || type;
  }

  function trustName(state, enabled, decision) {
    if (state === 'approved' && enabled) return ['已发布', 'ready'];
    if (decision === 'reject') return ['退回修改', 'bad'];
    if (state === 'revoked') return ['已撤回', 'bad'];
    return ['审核中', 'waiting'];
  }

  function componentText(item) {
    const count = Number(item && item.count || 0);
    return String(item && item.label || item && item.kind || '能力') + (count > 1 ? ' ×' + count : '');
  }

  function riskName(level) {
    return ({ low: '低风险', medium: '需确认连接', high: '高权限能力' })[level] || '待审查';
  }

  /* Identify enterprise workflows and their delivery environment consistently across selection surfaces. */
  function processInfo(item) {
    const row = item && item.process || {};
    if (!row.enterprise) return null;
    const envs = (Array.isArray(row.environments) ? row.environments : [])
      .map(env => String(env && env.label || '').trim()).filter(Boolean);
    return { label: String(row.label || '企业流程'),
      route: String(row.route || ''), environments: envs };
  }

  function processBadge(item, cls) {
    const info = processInfo(item);
    if (!info) return '';
    const title = [info.route, info.environments.length
      ? '交付环境：' + info.environments.join('、') : ''].filter(Boolean).join('；');
    return '<em class="' + (cls || 'cap-plugin-quality') + ' is-enterprise-flow" title="' +
      h(title || '企业级流程，按公司规范执行') + '">' + h(info.label) + '</em>';
  }

  /* Render delivery-environment metadata only for enterprise workflows. */
  function processMetaHtml(item) {
    const info = processInfo(item);
    return info && info.environments.length
      ? '<i>·</i><em>交付环境：' + h(info.environments.join('、')) + '</em>' : '';
  }

  /* Omit the enterprise workflow details section when no information is available. */
  function processSectionHtml(item) {
    const info = processInfo(item);
    if (!info || (!info.route && !info.environments.length)) return '';
    const text = [info.route, info.environments.length
      ? '交付环境：' + info.environments.join('、') : ''].filter(Boolean).join('；');
    return '<section class="cap-detail-section cap-detail-process"><b>企业流程说明</b><p>' +
      h(text) + '</p></section>';
  }

  function provenanceName(item) {
    const row = item && item.provenance || {};
    if (item && item.personal) return '本机个人来源';
    if (row.signatureState === 'platform') return 'SoduWork 平台来源';
    if (row.signatureState === 'verified') return '签名已验证';
    return '企业审核来源';
  }

  global.SoduWorkPluginCatalogFormat = {
    icons: ICON, h, copyText, sourceName, nodeName, trustName, componentText, riskName, provenanceName,
    processInfo, processBadge, processMetaHtml, processSectionHtml,
  };
})(window);
