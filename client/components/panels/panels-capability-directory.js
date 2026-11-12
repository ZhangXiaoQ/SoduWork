/* Application and market views over the real plugin and MCP catalogs. */
(function (global) {
  'use strict';

  const ICON = {
    app: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>',
    git: '<svg viewBox="0 0 24 24"><circle cx="7" cy="5" r="2"/><circle cx="7" cy="19" r="2"/><circle cx="17" cy="6" r="2"/><path d="M7 7v10m10-9v3a4 4 0 0 1-4 4H7"/></svg>',
    files: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 10h18"/></svg>',
    web: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 6.5h14M5 17.5h14"/></svg>',
    time: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></svg>',
    memory: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7"/></svg>',
    reasoning: '<svg viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="5" rx="1.5"/><rect x="2" y="17" width="6" height="5" rx="1.5"/><rect x="16" y="17" width="6" height="5" rx="1.5"/><path d="M12 7v5m-7 5v-5h14v5"/></svg>',
    market: '<svg viewBox="0 0 24 24"><path d="M4 9h16l-1-5H5z"/><path d="M5 9v11h14V9M9 20v-6h6v6"/><path d="M4 9c0 2 3 3 4 0 0 2 3 3 4 0 0 2 3 3 4 0 0 2 3 3 4 0"/></svg>',
    shield: '<svg viewBox="0 0 24 24"><path d="M12 3 20 6v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="m9 12 2 2 4-4"/></svg>',
  };

  function h(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function includes(row, query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return true;
    return [row.name, row.description, row.source, row.status, row.category]
      .some(value => String(value || '').toLowerCase().includes(needle));
  }

  function appRows(data, mcp, companyMcp) {
    const enabledCompany = companyMcp instanceof Set ? companyMcp : new Set(mcp.enabledCompany || []);
    const company = (mcp.company || []).map(function (item) {
      const enabled = enabledCompany.has(item.name);
      return {
        id: item.name, kind: 'company', name: item.name, enabled,
        templateKey: item.templateKey || '', icon: item.icon,
        description: item.description || '企业发布的业务连接',
        source: '企业连接器', status: enabled ? '已连接' : '可连接',
      };
    });
    const personal = (mcp.personal || []).map(function (item) {
      return {
        id: item.id, kind: 'personal', name: item.name, enabled: Boolean(item.enabled),
        templateKey: item.templateKey || '', icon: item.icon,
        canEdit: item.canEdit === true && !item.builtIn,
        description: item.description || item.url || item.templateKey || '个人业务连接',
        source: '我的连接器', status: item.enabled ? '已连接' : '已停用',
      };
    });
    const installed = new Set((mcp.personal || []).map(item => item.templateKey).filter(Boolean));
    const templates = (data.mcpTemplates || []).filter(item => !installed.has(item.key)).map(function (item) {
      return {
        id: item.key, kind: 'template', name: item.name, enabled: false,
        templateKey: item.key, icon: item.icon,
        description: item.description || '可信连接器模板',
        source: '可信模板', status: '可连接',
      };
    });
    return company.concat(personal, templates);
  }

  function appBrand(item) {
    const identity = [item.templateKey, item.name].join(' ').toLowerCase();
    const rules = [
      [/\bgit\b|gitlab|github|仓库/, 'git', 'code'],
      [/filesystem|文件|目录/, 'files', 'slides'],
      [/fetch|网页|web|browser/, 'web', 'research'],
      [/time|时间|时区/, 'time', 'creative'],
      [/memory|记忆/, 'memory', 'writing'],
      [/sequential|reason|推理/, 'reasoning', 'report'],
    ];
    const match = rules.find(rule => rule[0].test(identity));
    const glyph = match ? match[1] : 'app', tone = match ? match[2] : 'plugin';
    return '<span class="cap-plugin-brand cap-app-brand icon-' + tone + '" aria-hidden="true">' +
      ICON[glyph] + (global.SoduWorkPluginIcon ? global.SoduWorkPluginIcon.image(item.icon) : '') + '</span>';
  }

  function appRow(item) {
    const control = item.kind === 'template'
      ? '<button class="cap-dir-connect" data-cap-app-template="' + h(item.id) + '">连接</button>'
      : '<button class="cap-dir-switch' + (item.enabled ? ' on' : '') +
        '" data-cap-app-toggle="' + h(item.kind + ':' + item.id) +
        '" aria-pressed="' + Boolean(item.enabled) + '" aria-label="' +
        h((item.enabled ? '停用' : '启用') + item.name) + '"><i></i></button>';
    return '<div class="cap-directory-row' + (item.enabled ? ' is-on' : '') + '">' +
      appBrand(item) +
      "<span class=\"cap-directory-copy\"><b data-user-content>" + h(item.name) + "</b><span data-user-content>" +
        h(item.description) + '</span>' +
      '<span class="cap-directory-meta"><em>' + h(item.source) + '</em><small>' +
        h(item.status) + '</small></span></span><span class="cap-directory-actions">' +
      (item.kind === 'personal' && item.canEdit ? '<button class="cap-dir-more" data-cap-app-edit="' +
        h(item.id) + '" aria-label="编辑 ' + h(item.name) + '">•••</button>' : '') +
      control + '</span></div>';
  }

  function section(title, hint, rows, emptyText) {
    return '<section class="cap-directory-section"><div class="cap-section-head"><b>' +
      h(title) + '</b><span>' + h(hint) + '</span><em>' + rows.length + ' 项</em></div>' +
      (rows.length ? '<div class="cap-directory-list">' + rows.map(appRow).join('') + '</div>' :
        '<div class="cap-empty"><b>' + h(emptyText) +
        '</b>可以从可信模板连接，或由管理员发布企业连接器。</div>') + '</section>';
  }

  function renderApps(content, query, ctx) {
    const rows = appRows(ctx.data || {}, ctx.mcp || {}, ctx.companyMcp)
      .filter(item => includes(item, query));
    const connected = rows.filter(item => item.enabled);
    const available = rows.filter(item => !item.enabled);
    content.innerHTML = '<p class="cap-catalog-hint">连接常用应用与业务系统，按需开启使用。</p>' +
      section('已连接', '下一次对话、需求或自动化可按权限调用', connected, '还没有已连接的连接器') +
      section('可连接', '企业连接、个人连接和可信连接器模板', available, '没有匹配的连接器');
    content.querySelectorAll('[data-cap-app-toggle]').forEach(function (button) {
      button.addEventListener('click', function () {
        const value = button.dataset.capAppToggle || '';
        const split = value.indexOf(':');
        const kind = value.slice(0, split); const id = value.slice(split + 1);
        if (kind === 'company') ctx.onToggleCompany(id); else ctx.onTogglePersonal(id);
      });
    });
    content.querySelectorAll('[data-cap-app-template]').forEach(function (button) {
      button.addEventListener('click', function () {
        const item = (ctx.data.mcpTemplates || []).find(x => x.key === button.dataset.capAppTemplate);
        if (item) ctx.onTemplate(item);
      });
    });
    content.querySelectorAll('[data-cap-app-edit]').forEach(function (button) {
      button.addEventListener('click', function () {
        const item = (ctx.mcp.personal || []).find(x => x.id === button.dataset.capAppEdit);
        if (item) ctx.onEditPersonal(item);
      });
    });
  }

  function marketSource(item) {
    const kind = String(item.sourceKind || '');
    const publisher = String(item.authorName ||
      item.provenance && item.provenance.publisherName || '');
    const label = ({ codex: 'Codex 兼容', claude: 'Claude Code 兼容',
      soduwork: 'SoduWork 原生', adapter: 'SoduWork 标准', builtin: 'SoduWork 内置' })[kind] || '企业发布';
    return publisher ? label + ' · ' + publisher : label;
  }

  const PURPOSE = {
    dev: { name: '研发与交付', description: '从需求、修复到合并上线的受控研发流程' },
    office: { name: '办公文稿', description: 'Word、Excel、PPT、PDF、图表与会议纪要' },
    research: { name: '信息与研究', description: '检索、采集、研读与综述' },
    errand: { name: '日常零活', description: '一句话交给 AI 的零散事务' },
  };
  const CATEGORY_HINT = {
    automation: '多 Agent、多节点和受控交付',
    connector: '连接企业系统并按最小权限调用',
    method: '把成熟工作方法带进每一轮对话',
    general: '可直接使用的企业基础能力',
  };
  function configuredCategories(catalog) {
    // Keep disabled definitions in the map.  The backend deliberately keeps
    // an existing plugin's configured category stable when an administrator
    // disables that category; filtering it out here made the card fall back
    // to the manifest category and looked like the admin change was ignored.
    const rows = (catalog.categories || []).filter(item => item && item.key && item.name)
      .slice().sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0));
    const map = Object.create(null);
    rows.forEach(item => { map[item.key] = item; });
    return { rows, map };
  }
  function categoryFor(item, catalog) {
    const configured = configuredCategories(catalog).map;
    const enabled = key => configured[key] && configured[key].enabled !== false;
    const policy = item.marketPolicy || {};
    if (policy.configured && configured[policy.category]) {
      return configured[policy.category];
    }
    const declared = item.declaredCategory || (item.personal ? item.category : '');
    if (enabled(declared)) return configured[declared];
    // The Hub taxonomy is authoritative. Legacy purpose labels are only a
    // compatibility fallback for older servers that do not publish categories.
    if (!(catalog.categories || []).length && Object.prototype.hasOwnProperty.call(PURPOSE, declared)) {
      return { key: declared, ...PURPOSE[declared] };
    }
    if (enabled(item.category) && (policy.configured || item.category !== 'general')) {
      return configured[item.category];
    }
    const cap = item.capabilities || {};
    const workflow = item.workflow || [];
    const inferred = cap.hasWorkflow !== false && (cap.executionMode === 'workflow' || workflow.length)
      ? 'automation' : (cap.mcpServers || []).length ? 'connector'
        : (cap.skills || []).length ? 'method' : 'general';
    if (enabled(inferred)) return configured[inferred];
    if (enabled('general')) return configured.general;
    if (!(catalog.categories || []).length) {
      return { key: inferred, name: ({ automation: '自动化流程', connector: '业务连接',
        method: '专业方法', general: '通用能力' })[inferred], description: CATEGORY_HINT[inferred] };
    }
    return { key: '_uncategorized', name: '未分类', description: '尚未分配到已启用的企业分类' };
  }

  function categoryView(catalog, items, selected) {
    const assigned = items.map(item => ({ item, category: categoryFor(item, catalog) }));
    const used = new Set(assigned.map(row => row.category.key));
    const definitions = configuredCategories(catalog).rows.filter(row => row.enabled !== false || used.has(row.key));
    const seen = new Set(definitions.map(row => row.key));
    assigned.forEach(row => {
      if (!seen.has(row.category.key)) { seen.add(row.category.key); definitions.push(row.category); }
    });
    const active = seen.has(selected) ? selected : '';
    const buttons = [{ key: '', name: '全部', count: items.length }].concat(definitions.map(row => ({
      ...row, count: assigned.filter(value => value.category.key === row.key).length,
    })));
    return {
      selected: active, definitions,
      items: assigned.filter(row => !active || row.category.key === active).map(row => row.item),
      html: '<nav class="cap-category-filters" aria-label="插件分类">' + buttons.map(row =>
        '<button type="button" class="cap-category-filter' + (row.key === active ? ' on' : '') +
        '" data-cap-category="' + h(row.key) + '" aria-pressed="' + (row.key === active) +
        '" title="' + h(row.description || row.name) + "\"><span>" + h(row.name) +
        '</span><small>' + row.count + '</small></button>').join('') + '</nav>',
    };
  }

  function bindCategoryFilters(content, select) {
    content.querySelectorAll('[data-cap-category]').forEach(button => {
      button.addEventListener('click', () => {
        const key = button.dataset.capCategory;
        select(key);
        // Repainting a filtered list should not drop keyboard focus.
        const next = Array.from(content.querySelectorAll('[data-cap-category]'))
          .find(row => row.dataset.capCategory === key);
        if (next && next.focus) next.focus({ preventScroll: true });
      });
    });
  }

  function marketRows(catalog) {
    const isWorkspaceApp = global.SoduWorkPluginPresentation && global.SoduWorkPluginPresentation.isWorkspaceApp;
    return (catalog.items || []).filter(item =>
      !item.personal && item.listed !== false && !(isWorkspaceApp && isWorkspaceApp(item))).map(function (item) {
      const policy = item.marketPolicy || {};
      const taskOnly = policy.installation === 'not_available';
      const defaultInstall = policy.installation === 'installed_by_default';
      return {
        id: item.pluginId, name: item.name, description: item.description,
        plugin: item,
        process: item.process,
        source: marketSource(item), category: categoryFor(item, catalog).name,
        categoryKey: categoryFor(item, catalog).key,
        installed: Boolean(item.installed), updateAvailable: Boolean(item.updateAvailable),
        featured: Boolean(policy.featured), taskOnly, defaultInstall,
        status: taskOnly ? '需求专用' :
          item.updateAvailable ? '有新版本' :
          defaultInstall ? (item.installed ? '企业默认' :
            item.installationState === 'default_blocked' ? '等待企业连接' : '默认已停用') :
          item.installed ? '已安装' : '可安装',
      };
    });
  }

  function marketBrand(item) {
    const plugin = item.plugin, cap = plugin.capabilities || {};
    const hasWorkflow = cap.hasWorkflow !== false &&
      (cap.executionMode === 'workflow' || (plugin.workflow || []).length > 0);
    const presentation = global.SoduWorkCapabilityPlugins;
    const kind = presentation ? presentation.iconKind(plugin, hasWorkflow) : 'plugin';
    const tone = presentation ? presentation.toneClass(plugin, hasWorkflow) : 'tone-5';
    const image = presentation ? presentation.brandIcon(plugin, hasWorkflow) :
      ICON.app + (global.SoduWorkPluginIcon ? global.SoduWorkPluginIcon.image(plugin.icon) : '');
    return '<span class="cap-plugin-brand ' + tone + ' icon-' + kind +
      '" aria-hidden="true">' + image + '</span>';
  }

  function marketRow(item) {
    const action = item.taskOnly ? '查看' :
      item.updateAvailable ? '查看升级' :
      item.installed ? '打开' : item.defaultInstall ? '重新启用' : '安装';
    return '<div class="cap-market-row' + (item.installed ? ' is-installed' : '') +
      (item.updateAvailable ? ' needs-update' : '') +
      (item.taskOnly ? ' is-task-only' : '') + (item.featured ? ' is-featured' : '') +
      '">' + marketBrand(item) + '<span class="cap-directory-copy"><b>' + h(item.name) +
      global.SoduWorkPluginCatalogFormat.processBadge(item) +
      "</b><span data-user-content>" + h(item.description) + '</span></span>' +
      '<div class="cap-market-footer"><span class="cap-directory-meta"><em data-user-content>' +
      h(item.category) + ' · ' + h(item.source) + '</em><small>' + h(item.status) + '</small></span>' +
      '<button class="cap-dir-connect' +
      (!item.taskOnly && (!item.installed || item.updateAvailable) ? ' primary' : '') +
      '" data-cap-market-open="' + h(item.id) + '">' + action + '</button></div></div>';
  }

  let marketCategoryKey = '';
  function renderMarket(content, query, ctx) {
    const allRows = marketRows(ctx.catalog || { items: [] });
    // Search must not erase a selected category (including a retired category still in use).
    const view = categoryView(ctx.catalog || {}, allRows.map(row => row.plugin), marketCategoryKey);
    marketCategoryKey = view.selected;
    const rows = allRows.filter(item => (!view.selected || item.categoryKey === view.selected) && includes(item, query));
    content.innerHTML = view.html +
      '<p class="cap-catalog-hint">发现企业已发布的插件，查看详情后按需安装。</p>' +
      (rows.length ? '<div class="cap-market-list">' + rows.map(marketRow).join('') + '</div>' :
        '<div class="cap-empty"><b>' + (query ? '没有匹配的企业插件' :
        view.selected ? '此分类暂无你可用的插件' : '企业市场还没有可用插件') +
        '</b>' + (query ? '换个关键词搜索能力、来源或分类。' :
          '管理员将已上架的插件分配到此分类后，你可以在这里查看。') + '</div>');
    bindCategoryFilters(content, key => { marketCategoryKey = key; renderMarket(content, query, ctx); });
    content.querySelectorAll('[data-cap-market-open]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (ctx.onOpenPlugin) ctx.onOpenPlugin(button.dataset.capMarketOpen);
      });
    });
  }

  function appCount(data, mcp, companyMcp) {
    return appRows(data || {}, mcp || {}, companyMcp).filter(item => item.enabled).length;
  }

  function marketCount(catalog) {
    const isWorkspaceApp = global.SoduWorkPluginPresentation && global.SoduWorkPluginPresentation.isWorkspaceApp;
    return ((catalog || {}).items || []).filter(item =>
      !item.personal && item.listed !== false && !(isWorkspaceApp && isWorkspaceApp(item))).length;
  }

  global.SoduWorkCapabilityDirectory = { appCount, marketCount, renderApps, renderMarket,
    categoryFor, categoryView, bindCategoryFilters };
})(window);
