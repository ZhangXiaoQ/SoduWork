/* Employee-facing plugin catalog. Governance remains in the admin plugin workshop. */
(function (global) {
  'use strict';
  let catalog = { items: [], submissions: [], categories: [] };
  let completeCatalog = false;
  let loadRevision = 0;
  let libraryFilters = { source: 'all', category: '', status: 'all' };
  const systemCopy = source => global.SoduWorkI18n?.html?.(source, source) || h(source);
  function displayCopy(item, field) {
    if (field === 'description' && !item.description) return systemCopy('公司发布的标准工作方法');
    const source = item.builtIn && (item.locales?.['zh-CN'] || item.locales?.['zh-cn'])?.[field];
    return source && global.SoduWorkI18n?.html ? global.SoduWorkI18n.html(source, source)
      : '<span data-user-content>' + h(item[field] || '') + '</span>';
  }
  const { icons: ICON, h, copyText, sourceName, nodeName, trustName, componentText, riskName,
    provenanceName, processBadge, processMetaHtml, processSectionHtml } = global.SoduWorkPluginCatalogFormat;
  async function load(onCatalog) {
    const request = ++loadRevision;
    let next;
    try {
      next = await SoduWorkAPI.pluginCatalog() || { items: [], submissions: [] };
      if (request !== loadRevision) return catalog;
      if (next.remoteError && (completeCatalog || catalog.items.length)) {
        catalog = { ...catalog, remoteError: next.remoteError }; return catalog;
      }
      completeCatalog = !next.remoteError;
      next.error = '';
      catalog = next;
      if (typeof onCatalog === 'function') onCatalog(next);
      if (global.SoduWorkPlatformConnections) await global.SoduWorkPlatformConnections.hydrate(next.items || [], () => request === loadRevision);
      if (request !== loadRevision) return catalog;
      if (window.PluginUIHost && typeof PluginUIHost.invalidateCatalog === 'function') {
        PluginUIHost.invalidateCatalog();
      }
    } catch (error) {
      if (request === loadRevision && [401, 403].includes(Number(error && error.status))) {
        completeCatalog = false;
        catalog = { items: [], submissions: [], categories: [] };
      }
      if (request === loadRevision) catalog = completeCatalog || catalog.items.length
        ? { ...catalog, remoteError: String(error && error.message || error) }
        : { items: [], submissions: [], categories: [], error: String(error && error.message || error) };
    }
    return catalog;
  }
  function invalidateCatalog(event) {
    if (event?.type === 'soduwork:plugins-changed' && event.detail?.platformStatusOnly) return;
    ++loadRevision;
    completeCatalog = false;
    catalog = { items: [], submissions: [], categories: [] };
  }
  ['soduwork-data-scope-changed', 'soduwork-plugin-policy', 'soduwork:plugins-changed'].forEach(name => {
    global.addEventListener?.(name, invalidateCatalog);
  });
  global.addEventListener?.('soduwork-locale-change', () => {
    ++loadRevision;
    global.PluginUIHost?.invalidateCatalog?.();
  });
  /* Load presentation helpers first per index/desk script order; sandbox fixtures without them retain the unfiltered fallback. */
  const isWorkspaceApp = item => Boolean(global.SoduWorkPluginPresentation &&
    global.SoduWorkPluginPresentation.isWorkspaceApp(item));
  function count() { return (catalog.items || []).filter(item => !isWorkspaceApp(item)).length; }
  function managedCount() {
    return new Set((catalog.items || []).filter(item => item && item.pluginId && !isWorkspaceApp(item) && (item.personal || item.installed || item.permissions?.canEdit === true))
      .map(item => item.pluginId)).size; }
  function marketCount() { return (catalog.items || []).filter(item => !item.personal && item.listed !== false && !isWorkspaceApp(item)).length; }
  function marketItems() { return (catalog.items || []).filter(item => !item.personal && item.listed !== false && !isWorkspaceApp(item)).slice(); }
  function snapshot() { return catalog; }
  function hasPendingReview() {
    return (catalog.submissions || []).some(function (item) {
      if (item.reviewDecision === 'reject' || item.trustState === 'revoked') return false;
      return !(item.trustState === 'approved' && item.enabled);
    });
  }
  function revision(value) { const source = value || catalog || { items: [], submissions: [], categories: [] };
    return JSON.stringify({
      items: source.items || [], submissions: source.submissions || [],
      categories: source.categories || [],
      remoteError: source.remoteError || '',
    });
  }
  function matches(item, query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return true;
    const cap = item.capabilities || {};
    const category = global.SoduWorkCapabilityDirectory
      ? global.SoduWorkCapabilityDirectory.categoryFor(item, catalog).name : '';
    return [item.name, item.key, item.qualifiedKey, item.scope, item.description, item.sourceKind, category, ...(cap.skills || []),
      ...(cap.mcpServers || []), ...(cap.runtime || []), ...(item.workflow || []).map(x => x.name)]
      .some(value => String(value || '').toLowerCase().includes(needle));
  }
  function catalogWarning() {
    if (!catalog.remoteError) return '';
    return '<section class="cap-plugin-offline"><span>' + ICON.shield + '</span><div><b>企业插件暂时不可用</b>' +
      '<em>本机个人插件仍可正常使用；恢复连接后会自动读取当前环境的企业目录。</em></div>' +
      '<button class="btn-mini" id="capPluginRemoteRetry">重试</button></section>';
  }
  function sourceClass(item) {
    const kind = item && item.personal ? 'personal' : String(item && item.sourceKind || 'enterprise');
    return 'source-' + (/^(personal|codex|claude|soduwork|adapter|builtin)$/.test(kind)
      ? kind : 'enterprise');
  }
  function iconKind(item, hasWorkflow) {
    const cap = item && item.capabilities || {};
    const text = [item && item.name, item && item.description, item && item.pluginId,
      ...(cap.skills || []), ...(cap.runtime || [])].join(' ').toLowerCase();
    if (/ppt|powerpoint|汇报|演示|幻灯/.test(text)) return 'slides';
    if (/小说|故事|剧本|长文写作/.test(text)) return 'story';
    if (/招标|投标|检索|搜索|调研|研究|情报/.test(text)) return 'research';
    if (/日报|周报|月报|简报|复盘|报告|report/.test(text)) return 'report';
    if (/文档|word|制度|材料|方案|稿件|撰写/.test(text)) return 'writing';
    if (/审查|评审|验收|验证|review|质量/.test(text)) return 'review';
    if (/发布|上线|生产|交付|deploy|release/.test(text)) return 'release';
    if (/代码|编程|修复|开发|gerrit|研发|html|网站|code/.test(text)) return 'code';
    if (/笑话|创意|灵感|脑暴/.test(text)) return 'creative';
    if (/助手|零活|助理|assistant/.test(text)) return 'assistant';
    return hasWorkflow ? 'flow' : 'plugin';
  }
  function toneClass(item, hasWorkflow) {
    const tone = ({ assistant: 0, report: 1, slides: 2, writing: 3, story: 4,
      research: 6, code: 7, review: 1, release: 4, creative: 2, flow: 0,
      plugin: 5 })[iconKind(item, hasWorkflow)];
    return 'tone-' + tone;
  }
  function brandIcon(item, hasWorkflow) {
    return (ICON[iconKind(item, hasWorkflow)] || ICON.plugin) +
      (global.SoduWorkPluginIcon ? global.SoduWorkPluginIcon.image(item && item.icon) : '');
  }
  function libraryState(item) {
    if (item.enabled === false || item.installationState === 'default_disabled') return 'disabled';
    const readiness = global.SoduWorkPluginDependencies.state(item);
    const life = global.SoduWorkPluginLifecycle.resolve(item, readiness);
    if (life.code === 'enable') return 'disabled';
    if (readiness.runtimeBlocked || (global.SoduWorkPlatformConnections && !global.SoduWorkPlatformConnections.ready(item))) return 'attention';
    return ['ready', 'taskOnly'].includes(life.code) ? 'ready' : 'attention';
  }
  function card(item) {
    const cap = item.capabilities || {};
    const policy = item.marketPolicy || {};
    const taskOnly = policy.installation === 'not_available';
    const readiness = global.SoduWorkPluginDependencies.state(item);
    const life = global.SoduWorkPluginLifecycle.resolve(item, readiness);
    const workflow = item.workflow || [];
    const hasWorkflow = cap.hasWorkflow !== false &&
      (cap.executionMode === 'workflow' || workflow.length > 0);
    const category = global.SoduWorkCapabilityDirectory
      ? global.SoduWorkCapabilityDirectory.categoryFor(item, catalog).name : '';
    const source = item.builtIn ? 'SoduWork 内置' : item.personal ? '个人插件' : '企业插件';
    const platformReady = !global.SoduWorkPlatformConnections || global.SoduWorkPlatformConnections.ready(item);
    const canUse = platformReady && life.code === 'ready' && !readiness.runtimeBlocked && !taskOnly &&
      (item.personal || item.installed) && (item.entrypoints || {}).conversation !== false &&
      (item.personal || item.organizationWide || item.projectCount === 1) &&
      item.pluginId !== 'local:plugin-builder';
    return '<article class="cap-plugin-card' + (item.personal ? ' is-personal' : '') +
      (!item.personal && !item.installed ? ' is-available' :
        !item.personal && item.updateAvailable ? ' needs-update' : '') +
      (taskOnly ? ' is-task-only' : '') +
      (item.enabled === false ? ' is-disabled' : '') + '"><button type="button" class="cap-plugin-open" data-plugin="' + h(item.pluginId) +
      '" aria-label="打开插件 ' + h(item.name) + '">' +
      '<span class="cap-plugin-brand ' + sourceClass(item) + ' ' + toneClass(item, hasWorkflow) + ' icon-' + iconKind(item, hasWorkflow) + '" aria-hidden="true">' + brandIcon(item, hasWorkflow) + '</span>' +
      '<span class="cap-plugin-copy"><span class="cap-plugin-title"><b>' + displayCopy(item, 'name') +
        '</b></span>' +
      '<span class="cap-plugin-desc">' + displayCopy(item, 'description') + '</span>' +
      '<span class="cap-plugin-meta"><em>' + h(source) + '</em>' +
        (category ? '<i>·</i><em class="cap-plugin-category">' + h(category) + '</em>' : '') + '</span></span>' +
      '</button><div class="cap-plugin-side"><span class="cap-plugin-card-status is-' + h(!platformReady || readiness.runtimeBlocked ? 'warning' : life.tone) + '">' +
        h(!platformReady ? '待连接账号' : readiness.runtimeBlocked ? '暂不可用' : life.label) + '</span>' +
      '<span class="cap-plugin-card-actions"><button type="button" class="btn-mini" data-plugin="' + h(item.pluginId) + '">详情</button>' +
      (canUse ? '<button type="button" class="btn-mini cap-plugin-use" data-plugin-use="' + h(item.pluginId) + '">立即使用</button>' :
        '<button type="button" class="btn-mini" data-plugin="' + h(item.pluginId) + '">' + h(!platformReady ? '连接账号' : life.nextLabel) + '</button>') +
      '</span></div></article>';
  }
  function render(content, query, ctx) {
    if (catalog.error) {
      content.innerHTML = '<div class="cap-empty"><b>插件目录没有加载成功</b>' +
        h(catalog.error) + '<br><button class="btn-mini primary" id="capPluginRetry">重试</button></div>';
      content.querySelector('#capPluginRetry').addEventListener('click', async function () {
        await load(); ctx.refresh();
      });
      return;
    }
    const presentation = global.SoduWorkPluginPresentation;
    const view = presentation.libraryModel(catalog, { ...libraryFilters, query }, matches, libraryState);
    libraryFilters = { source: view.source, category: view.category, status: view.status };
    const focused = content.contains(document.activeElement) ? document.activeElement : null;
    const focusId = focused && focused.id;
    const focusSource = focused && focused.dataset.pluginSource;
    const focusPlugin = focused && (focused.dataset.plugin || focused.dataset.pluginUse);
    const focusAction = focused && (focused.dataset.pluginUse ? 'data-plugin-use' : 'data-plugin');
    const focusClass = focused && focused.className;
    const scroll = content.scrollTop;
    content.innerHTML = '<section class="cap-plugin-library" aria-label="我的插件">' + catalogWarning() +
      presentation.libraryToolbar(view, catalog.submissions || []) +
      '<div class="cap-library-summary"><span role="status" aria-live="polite">' +
      (view.filtered ? '找到 ' : '共 ') + view.items.length + ' 个插件</span>' +
      (view.filtered && view.items.length ? '<button type="button" id="capPluginClear">清除筛选</button>' :
        '<span class="cap-library-tip">在对话中输入 / 快速调用</span>') + '</div>' +
      (view.items.length ? '<div class="cap-plugin-grid">' + view.items.map(card).join('') + '</div>' :
        presentation.libraryEmpty(view, ICON.plugin)) + '</section>';
    content.querySelectorAll('[data-plugin-source]').forEach(button => button.addEventListener('click', () => {
      libraryFilters.source = button.dataset.pluginSource; render(content, query, ctx);
    }));
    [['capPluginCategory', 'category'], ['capPluginStatus', 'status']].forEach(([id, key]) => {
      content.querySelector('#' + id)?.addEventListener('change', event => {
        libraryFilters[key] = event.target.value; render(content, query, ctx);
      });
    });
    content.querySelector('#capPluginClear')?.addEventListener('click', () => {
      libraryFilters = { source: 'all', category: '', status: 'all' };
      if (ctx.clearSearch) ctx.clearSearch(); else render(content, '', ctx);
    });
    content.querySelector('#capPluginSubmissions')?.addEventListener('click', () =>
      presentation.records(catalog.submissions || [], ctx, trustName, openSubmission));
    content.scrollTop = scroll;
    if (focusId) content.querySelector('#' + focusId)?.focus({ preventScroll: true });
    else if (focusSource) content.querySelector('[data-plugin-source="' + focusSource + '"]')?.focus({ preventScroll: true });
    else if (focusPlugin) Array.from(content.querySelectorAll('[' + focusAction + ']')).find(button =>
      button.getAttribute(focusAction) === focusPlugin && button.className === focusClass)?.focus({ preventScroll: true });
    const retry = content.querySelector('#capPluginRemoteRetry');
    if (retry) retry.addEventListener('click', async function () {
      this.disabled = true; this.textContent = '正在重试…';
      await load(); ctx.refresh();
    });
    const market = content.querySelector('#capOpenMarket');
    if (market) market.addEventListener('click', function () {
      if (typeof ctx.openMarket === 'function') ctx.openMarket();
    });
    content.querySelectorAll('[data-plugin]').forEach(function (button) {
      button.addEventListener('click', function () {
        openDetail((catalog.items || []).find(x => x.pluginId === button.dataset.plugin), ctx);
      });
    });
    content.querySelectorAll('[data-plugin-use]').forEach(function (button) {
      button.addEventListener('click', function () {
        const item = (catalog.items || []).find(x => x.pluginId === button.dataset.pluginUse);
        if (item && typeof ctx.tryPlugin === 'function') ctx.tryPlugin(item);
      });
    });
  }
  function openSubmission(item, ctx, onBack) {
    return global.SoduWorkPluginPublication.openSubmission(item, ctx, {
      items: catalog.items || [], trustName, sourceName, choosePackage, openDetail, onBack,
    });
  }
  function openById(pluginId, ctx) {
    openDetail((catalog.items || []).find(function (item) {
      return item.pluginId === pluginId;
    }), ctx);
  }
  function openDetail(item, ctx) {
    if (!item) return;
    const cap = item.capabilities || {};
    const policy = item.marketPolicy || {};
    const taskOnly = policy.installation === 'not_available';
    const readiness = global.SoduWorkPluginDependencies.state(item);
    const life = global.SoduWorkPluginLifecycle.resolve(item, readiness);
    const missingMcp = readiness.missingMcp;
    const runtimeBlocked = readiness.runtimeBlocked;
    const installBlocked = readiness.installBlocked;
    const flow = item.workflow || [];
    const hasWorkflow = cap.hasWorkflow !== false &&
      (cap.executionMode === 'workflow' || flow.length > 0);
    const entrypoints = item.entrypoints || {};
    const uiPresentation = global.PluginUIHost.catalogPresentation(item, ICON.plugin);
    const components = (cap.components || []).filter(x => x && x.state !== 'blocked');
    const permission = cap.permissionSummary || {};
    const permissionReasons = permission.reasons || [];
    const compatibilityNotes = [
      ...(cap.adapterWarnings || []),
      ...(cap.unsupportedComponents || []).map(x => '个人试用不执行：' + x),
    ];
    const quality = cap.qualitySummary || {};
    const provenance = item.provenance || {};
    const authorName = item.builtIn ? 'SoduWork' : item.authorName || provenance.publisherName || '\u672a\u77e5\u4f5c\u8005';
    const openSource = item.openSource || {};
    const entryNames = [
      entrypoints.conversation !== false ? '对话' : '',
      entrypoints.task !== false ? '需求' : '',
      entrypoints.automation ? '自动化' : '',
    ].filter(Boolean);
    const scope = item.personal ? '仅自己可用' :
      item.audienceLimited ? '企业' + (item.audienceLabel || '指定成员') :
      '企业共享' + (item.projectCount ? ' · ' + item.projectCount + ' 个项目配置' : '');
    const quickUse = global.SoduWorkPluginDependencies.quickUse(item, readiness, h);
    const installNote = global.SoduWorkPluginDependencies.installNote(item, readiness);
    const dependencyNote = global.SoduWorkPluginDependencies.blocker(readiness, h);
    const isBuilder = item.builtIn && item.pluginId === 'local:plugin-builder';
    const platformReady = !global.SoduWorkPlatformConnections || global.SoduWorkPlatformConnections.ready(item);
    const canUse = item.personal || item.permissions?.canUse !== false;
    const canTry = platformReady && !taskOnly && !isBuilder && item.enabled !== false && canUse &&
      (item.personal ? !runtimeBlocked && entrypoints.conversation !== false :
        item.installed && (item.conversationUse ? item.conversationUse.available :
          !runtimeBlocked && entrypoints.conversation !== false));
    const tryAction = canTry
      ? '<button class="btn-mini primary" id="capPluginTry">立即试用</button>' : '';
    const install = (button, upgrading) => global.SoduWorkPluginInstallSetup.install(
      item, ctx, button, { upgrading: Boolean(upgrading),
        reload: async function () { await load(); ctx.refresh(); } });
    const personalActions = item.personal && !item.builtIn
      ? '<button class="btn-mini" id="capPersonalDelete">删除</button><span class="push"></span>' +
        '<button class="btn-mini" id="capPersonalVersions">\u7248\u672c\u4e0e\u5bfc\u51fa</button>' +
        (item.setup?.preferences?.length || item.dependencyReadiness?.requiredMcp?.length
          ? '<button class="btn-mini" id="capEnterpriseSetup">设置连接</button>' : '') +
        '<button class="btn-mini" id="capPersonalEdit">编辑新版本</button>' +
        '<button class="btn-mini" id="capPersonalImprove">用 SoduWork 改进</button>' +
        '<button class="btn-mini primary" id="capPersonalPublish">\u63d0\u4ea4\u5ba1\u6838</button>' +
        '<button class="btn-mini" id="capPersonalExport">\u5bfc\u51fa\u5f53\u524d\u7248\u672c</button>' +
        '<button class="btn-mini" id="capPersonalToggle">' +
        (item.enabled === false ? '启用' : '停用') + '</button>' + tryAction
      : isBuilder
        ? '<span class="push"></span><button class="btn-mini primary" id="capBuilderStart">开始制作</button>'
        : '<button class="btn-mini" id="capDetailClose">关闭</button>' +
          (tryAction ? '<span class="push"></span>' + tryAction : '');
    const dependencyAction = runtimeBlocked
      ? '<button class="btn-mini" id="capCopyMissingMcp">复制连接清单</button>' : '';
    const enterpriseEditActions = global.SoduWorkPluginAccess?.actions(item, taskOnly) || '';
    const enterpriseAction = item.personal || taskOnly || !canUse ? enterpriseEditActions : enterpriseEditActions +
      (tryAction ? '' : '<span class="push"></span>') +
      dependencyAction +
      (item.updateAvailable
        ? '<button class="btn-mini primary" id="capEnterpriseInstall"' +
          (installBlocked ? ' disabled' : '') + '>' +
          (installBlocked ? '等待管理员配置' : '升级到 v' + h(item.version)) + '</button>'
        : item.installed
          ? (global.SoduWorkPluginInstallSetup &&
              global.SoduWorkPluginInstallSetup.needs(item)
            ? '<button class="btn-mini" id="capEnterpriseSetup">设置</button>'
            : '') +
            '<button class="btn-mini" id="capEnterpriseRemove">从我的对话中停用</button>'
          : '<button class="btn-mini primary" id="capEnterpriseInstall"' +
            (installBlocked ? ' disabled' : '') + '>' +
            (installBlocked ? '等待管理员配置' : (entrypoints.conversation !== false ? '安装并试用' : '安装到我的 SoduWork')) + '</button>') +
      (!item.personal && item.installed && item.updateAvailable ?
        '<button class="btn-mini" id="capEnterpriseRemove">从我的对话中停用</button>' : '');
    const layer = ctx.openModal(item.name, '\u4f5c\u8005 \u00b7 ' + authorName + ' \u00b7 v' + item.version,
      global.SoduWorkPluginPresentation.tabs() + '<div class="cap-detail-pane" id="capDetailOverview" role="tabpanel" aria-labelledby="capDetailOverviewTab">' +
      '<div class="cap-plugin-detail-head"><span class="cap-plugin-brand ' + toneClass(item, hasWorkflow) + ' icon-' + iconKind(item, hasWorkflow) + '">' + brandIcon(item, hasWorkflow) + '</span><div><b>' + displayCopy(item, 'name') +
      '</b>' + processBadge(item) + '<p>' + displayCopy(item, 'description') + '</p><em>' +
      systemCopy(scope) + ' · ' + systemCopy('作者') + ' · <span data-user-content>' + h(authorName) + '</span></em></div></div>' + global.SoduWorkPluginLifecycle.html(item, readiness, h) + processSectionHtml(item) +
      uiPresentation.notice +
      '<section class="cap-detail-section"><b>' + (hasWorkflow ? (uiPresentation.rows.length ? '人工需求流程' : '自动化流程') : '调用方式') +
      '</b><div class="cap-flow-line">' + (hasWorkflow ? flow.map(function (node, i) {
        return (i ? '<i class="arrow">→</i>' : '') + '<span><small>' + (i + 1) + "</small><b" + (node.name && !item.builtIn ? ' data-user-content' : '') + '>' +
          (item.builtIn ? systemCopy(node.name || nodeName(node.type)) : h(node.name || nodeName(node.type))) + '</b><em>' + h(nodeName(node.type)) + '</em></span>';
      }).join('') : '<span><small>✓</small><b>直接使用能力</b><em>' +
        h(entryNames.join(' · ') || '按授权入口使用') + '</em></span>') + '</div></section>' +
      (global.SoduWorkPlatformConnections ? global.SoduWorkPlatformConnections.markup(item) : '') +
      quickUse + ((item.setup || {}).description
        ? detailGroup('使用准备', [global.SoduWorkPlatformConnections
          ? global.SoduWorkPlatformConnections.setupDescription(item) : item.setup.description], '') : '') +
      installNote + dependencyNote + '</div>' +
      '<div class="cap-detail-pane" id="capDetailResources" role="tabpanel" aria-labelledby="capDetailResourcesTab" hidden>' +
      detailGroup('能力包内容', components.map(componentText), '只有基础工作说明') +
      (global.SoduWorkPluginMakerUtils ? global.SoduWorkPluginMakerUtils.resourceMarkup(cap.resources) : '') +
      detailGroup('包含的 Skill', cap.skills || [], '插件没有声明额外 Skill') +
      detailGroup('依赖的连接器', cap.mcpServers || [], '插件不依赖连接器') +
      detailGroup('员工界面', uiPresentation.descriptions,
        '默认不增加界面；只有无界面的插件才可按授权进入后台自动化') +
      detailGroup('需要的执行能力', cap.runtime || [], '使用基础文件与对话能力') +
      (openSource.license ? detailGroup('开源适配', [
        openSource.license + (openSource.upstreamVersion ? ' · ' + openSource.upstreamVersion : ''),
        openSource.repository,
        openSource.adaptation || '按 SoduWork 权限、需求和验收协议完成适配',
      ], '') : '') +
      '</div><div class="cap-detail-pane" id="capDetailQuality" role="tabpanel" aria-labelledby="capDetailQualityTab" hidden>' +
      detailGroup('兼容说明', compatibilityNotes, '没有额外兼容限制') +
      detailGroup('发布质量', (cap.evaluationCases || []).map(x =>
        (x.name || x.key) + ' · ' + (x.criteria || []).length + ' 条验收标准'),
      quality.message || '已有结果契约，尚未声明代表性发布评测') +
      '<div class="cap-permission-line"><span>' + ICON.shield + '<b>权限与风险</b></span>' +
        '<em>' + h(riskName(permission.riskLevel)) + '</em>' +
        '<em>' + (cap.network ? '需要网络访问' : '不要求网络访问') + '</em>' +
        '<em>' + (cap.hasScript ? '包含受控脚本' : (cap.resources || []).some(x => x.kind === 'script') ? '含脚本资源 · 按需使用' : '不含脚本') + '</em></div>' +
      (permissionReasons.length ? '<p class="cap-permission-note">' +
        permissionReasons.map(h).join(' · ') + '</p>' : '') + '</div>',
      personalActions + enterpriseAction + uiPresentation.action);
    const detailModal = layer.querySelector('.cap-modal'); if (detailModal) detailModal.classList.add('cap-plugin-detail-modal');
    const heading = layer.querySelector('#capModalTitle');
    if (heading) heading.innerHTML = displayCopy(item, 'name');
    const subtitle = layer.querySelector('#capModalSub');
    if (subtitle) subtitle.innerHTML = systemCopy('作者') + ' · <span data-user-content>' + h(authorName) + '</span> · v' + h(item.version);
    global.SoduWorkPluginPresentation.detail(layer, ctx);
    global.SoduWorkPluginAccess?.bind(layer, item, ctx, openMaker, async function (permissions, isCurrent) {
      const snapshot = await load();
      if (!isCurrent() || snapshot.error || snapshot.remoteError) return;
      const next = (snapshot.items || []).find(row => row.pluginId === item.pluginId) ||
        { ...item, permissions: { canUse: false, canEdit: false } };
      const selected = layer.querySelector('.cap-detail-tabs [aria-selected="true"]')?.id;
      const scroll = layer.querySelector('#capModalBody')?.scrollTop || 0;
      openDetail(next, ctx);
      if (selected) layer.querySelector('#' + selected)?.click();
      const body = layer.querySelector('#capModalBody');
      if (body) body.scrollTop = scroll;
    });
    if (global.SoduWorkPlatformConnections) global.SoduWorkPlatformConnections.bind(layer, item, ctx);
    const close = layer.querySelector('#capDetailClose');
    if (close) close.addEventListener('click', ctx.closeModal);
    const copyMissing = layer.querySelector('#capCopyMissingMcp');
    if (copyMissing) copyMissing.addEventListener('click', async function () {
      const request = global.SoduWorkPluginDependencies.adminRequest(item, readiness);
      const ok = await copyText(request);
      this.textContent = ok ? '连接清单已复制' : '复制失败';
      ctx.say(ok ? '连接清单已复制，可以直接发给管理员' :
        '请管理员配置企业连接：' + missingMcp.join('、'));
    });
    const enterpriseInstall = layer.querySelector('#capEnterpriseInstall');
    if (enterpriseInstall) enterpriseInstall.addEventListener('click', function () {
      if (item.updateAvailable) {
        ctx.closeModal();
        global.SoduWorkPluginPublication.openUpgrade(item, ctx, function (button) {
          return install(button, true);
        });
        return;
      }
      install(this, false);
    });
    const enterpriseRemove = layer.querySelector('#capEnterpriseRemove');
    if (enterpriseRemove) enterpriseRemove.addEventListener('click', async function () {
      this.disabled = true; this.textContent = '正在停用…';
      try {
        await SoduWorkAPI.setEnterprisePluginInstalled(item.pluginId, false);
        ctx.closeModal();
        await load(); ctx.refresh();
        ctx.say('插件已从你的日常对话工具箱移除，企业需求和自动化不受影响');
      } catch (error) {
        ctx.say(ctx.errorText(error, '插件没有停用成功'));
        this.disabled = false; this.textContent = '从我的对话中停用';
      }
    });
    const enterpriseSetup = layer.querySelector('#capEnterpriseSetup');
    if (enterpriseSetup) enterpriseSetup.addEventListener('click', function () {
      global.SoduWorkPluginInstallSetup.configure(item, ctx, {
        reload: async function () { await load(); ctx.refresh(); },
      });
    });
    const tryButton = layer.querySelector('#capPluginTry');
    if (tryButton) tryButton.addEventListener('click', function () {
      if (typeof ctx.tryPlugin === 'function') ctx.tryPlugin(item);
    });
    global.PluginUIHost.bindCatalogDetail(layer, item, ctx);
    const builderStart = layer.querySelector('#capBuilderStart');
    if (builderStart) builderStart.addEventListener('click', function () {
      if (typeof ctx.createWithAgent === 'function') ctx.createWithAgent();
    });
    const publish = layer.querySelector('#capPersonalPublish');
    if (publish) publish.addEventListener('click', async function () {
      const label = this.textContent;
      this.disabled = true; this.textContent = '正在准备…';
      try { await openPersonalPublish(item, ctx); }
      catch (error) {
        ctx.say(ctx.errorText(error, '没有读取到企业成员或插件版本'));
        this.disabled = false; this.textContent = label;
      }
    });
    const exportButton = layer.querySelector('#capPersonalExport');
    if (exportButton) exportButton.addEventListener('click', async function () {
      this.disabled = true;
      try {
        const bridge = global.soduWorkAPI && global.soduWorkAPI.personalPlugins;
        const exportPlugin = bridge && (bridge.exportToFile || bridge.exportDraft);
        if (typeof exportPlugin !== 'function') throw new Error('个人插件导出服务不可用，请重启 SoduWork 后再试');
        const result = await exportPlugin(item.pluginId);
        if (!result.canceled) ctx.say('已导出插件压缩包 ' + (result.filename || item.name) +
          (result.resourceCount ? '，随附资源文件 ' + result.resourceCount + ' 个' : ''));
      } catch (error) { ctx.say(ctx.errorText(error, '个人插件没有导出成功')); }
      finally { this.disabled = false; }
    });
    const edit = layer.querySelector('#capPersonalEdit');
    if (edit) edit.addEventListener('click', async function () {
      this.disabled = true;
      try {
        const result = await SoduWorkAPI.personalPlugin(item.pluginId);
        const detail = result && result.plugin || {};
        if (!detail.localDraft) throw new Error('没有读取到当前插件版本');
        await SoduWorkPluginAccess.assertEditable(detail.localDraft);
        if (!layer.isConnected) return;
        ctx.closeModal();
        openMaker(ctx, detail.localDraft, detail.localVersions || []);
      } catch (error) {
        ctx.say(ctx.errorText(error, '没有打开插件版本编辑器'));
        this.disabled = false;
      }
    });
    const improve = layer.querySelector('#capPersonalImprove');
    if (improve) improve.addEventListener('click', async function () {
      this.disabled = true;
      try {
        const result = await SoduWorkAPI.personalPlugin(item.pluginId);
        const detail = result && result.plugin || {};
        if (!detail.localDraft) throw new Error('没有读取到当前插件版本');
        if (typeof ctx.createWithAgent !== 'function') throw new Error('插件开发助手暂不可用');
        await ctx.createWithAgent(detail.localDraft, item.pluginId);
      } catch (error) {
        ctx.say(ctx.errorText(error, '没有打开插件改进会话'));
        this.disabled = false;
      }
    });
    const versions = layer.querySelector('#capPersonalVersions');
    if (versions) versions.addEventListener('click', async function () {
      this.disabled = true;
      try { ctx.closeModal(); await openPersonalVersions(item, ctx); }
      catch (error) { ctx.say(ctx.errorText(error, '没有读取到个人插件版本')); }
    });
    const toggle = layer.querySelector('#capPersonalToggle');
    if (toggle) toggle.addEventListener('click', async function () {
      this.disabled = true;
      try {
        await SoduWorkAPI.setPersonalPluginEnabled(item.pluginId, item.enabled === false);
        ctx.closeModal(); await load(); ctx.refresh();
      } catch (error) { ctx.say(ctx.errorText(error, '个人插件状态没有更新')); this.disabled = false; }
    });
    const remove = layer.querySelector('#capPersonalDelete');
    if (remove) remove.addEventListener('click', function () {
      ctx.closeModal();
      openPersonalDelete(item, ctx);
    });
  }
  function openPersonalDelete(item, ctx) {
    const layer = ctx.openModal('删除个人插件', item.name + ' · 仅移除当前 SoduWork 中的副本',
      '<div class="cap-danger-confirm"><span>' + brandIcon(item, false) + '</span><div><b>确定删除「' +
      h(item.name) + '」？</b><p>本机保存的所有版本都会移除，之后的对话和需求不能再调用它。' +
      '已经上传到企业、正在运行的需求与历史记录不会受影响。</p></div></div>',
      '<button class="btn-mini" id="capDeleteCancel">取消</button><span class="push"></span>' +
      '<button class="btn-mini cap-danger-action" id="capDeleteDo">删除插件</button>');
    layer.querySelector('#capDeleteCancel').addEventListener('click', ctx.closeModal);
    layer.querySelector('#capDeleteDo').addEventListener('click', async function () {
      this.disabled = true; this.textContent = '正在删除…';
      try {
        await SoduWorkAPI.deletePersonalPlugin(item.pluginId);
        ctx.closeModal(); await load(); ctx.refresh(); ctx.say('个人插件已删除');
      } catch (error) {
        ctx.say(ctx.errorText(error, '个人插件没有删除成功'));
        this.disabled = false; this.textContent = '删除插件';
      }
    });
  }
  async function openPersonalVersions(item, ctx) {
    const detailResult = await SoduWorkAPI.personalPlugin(item.pluginId);
    const detail = (detailResult && detailResult.plugin) || {};
    const versions = detail.localVersions || [];
    const layer = ctx.openModal('版本历史', item.name + ' · 不可变本地快照',
      '<p class="cap-governance-note"><b>切换只影响之后的新调用。</b>正在运行的需求、历史对话和已经上传企业的版本都保持原快照。</p>' +
      '<div class="cap-version-list">' + versions.map(function (version) {
        return '<div class="cap-version-row' + (version.current ? ' is-current' : '') + '">' +
          '<span><b>v' + h(version.version) + '</b><small>' +
          h(String(version.checksum || '').slice(0, 12)) + ' · ' +
          h(version.createdAt ? new Date(version.createdAt).toLocaleString() : '本地版本') +
          '</small></span>' +
          (version.current ? '<em>当前使用</em>' :
            '<button class="btn-mini" data-version="' + h(version.version) + '">切换到此版本</button>') +
          '</div>';
      }).join('') + '</div>',
      '<button class="btn-mini" id="capPersonalExport">\u5bfc\u51fa\u5f53\u524d\u7248\u672c</button>' +
      '<span class="push"></span><button class="btn-mini primary" id="capVersionClose">完成</button>');
    const versionModal = layer.querySelector('.cap-modal'); if (versionModal) versionModal.classList.add('cap-plugin-version-modal');
    layer.querySelector('#capVersionClose').addEventListener('click', ctx.closeModal);
    layer.querySelector('#capPersonalExport').addEventListener('click', async function () {
      this.disabled = true;
      try {
        const bridge = global.soduWorkAPI && global.soduWorkAPI.personalPlugins;
        const exportPlugin = bridge && (bridge.exportToFile || bridge.exportDraft);
        if (typeof exportPlugin !== 'function') {
          throw new Error('个人插件导出服务不可用，请重启 SoduWork 后再试');
        }
        const result = await exportPlugin(item.pluginId);
        if (!result.canceled) ctx.say('已导出插件压缩包 ' + (result.filename || item.name) +
          (result.resourceCount ? '，随附资源文件 ' + result.resourceCount + ' 个' : ''));
      } catch (error) {
        ctx.say(ctx.errorText(error, '个人插件没有导出成功'));
      } finally { this.disabled = false; }
    });
    layer.querySelectorAll('[data-version]').forEach(function (button) {
      button.addEventListener('click', async function () {
        this.disabled = true; this.textContent = '正在切换…';
        try {
          const result = await SoduWorkAPI.setPersonalPluginVersion(
            item.pluginId, button.dataset.version);
          ctx.closeModal(); ctx.say(result.message || '个人插件版本已切换');
          await load(); ctx.refresh();
        } catch (error) {
          ctx.say(ctx.errorText(error, '版本没有切换成功'));
          this.disabled = false; this.textContent = '切换到此版本';
        }
      });
    });
  }
  async function openPersonalPublish(item, ctx) {
    return global.SoduWorkPluginPublication.openPersonalPublish(item, ctx, {
      api: SoduWorkAPI, copyText, load,
    });
  }
  function detailGroup(title, rows, empty) {
    return '<section class="cap-detail-section"><b>' + title + '</b><div class="cap-detail-tags">' +
      (rows.length ? rows.map(x => '<span>' + h(x) + '</span>').join('') : '<em>' + empty + '</em>') +
      '</div></section>';
  }
  function choosePackage(ctx) {
    return global.SoduWorkPluginMakerUtils.choosePackage(SoduWorkAPI, {
      local: (body, preview) => openLocalImport(body, preview, ctx),
      archive: (file, preview) => preview.sourceKind === 'personal' && preview.personalDraft &&
        !(preview.capabilities?.adapterBlockers || []).length
        ? openLocalImport(preview.personalDraft, preview, ctx) : openPreflight(file, preview, ctx),
      error: error => ctx.say(ctx.errorText(error, '插件包预检没有通过')),
    });
  }
  function openLocalImport(body, preview, ctx) {
    if(preview.ok===false||preview.checks?.some(row=>row.ok===false))throw Error((preview.checks||[]).filter(row=>row.ok===false).map(row=>row.label).join('\n')||'预检仍有未通过项');
    const rawManifest = preview.manifest || {};
    const manifest = global.SoduWorkPluginLocales?.present(rawManifest, global.SoduWorkI18n?.getLocale?.() || global.navigator?.language) || rawManifest;
    const flow = (preview.workflow || {}).nodes || [];
    const cap = preview.capabilities || {};
    const hasWorkflow = cap.hasWorkflow !== false &&
      (cap.executionMode === 'workflow' || flow.length > 1);
    const resources = manifest.resources || cap.resources || [];
    const application = manifest.template === 'app';
    const layer = ctx.openModal(application ? '安装即用' : '安装插件', '检查已完成，选择安装方式',
      '<div class="cap-plugin-preview"><span class="cap-plugin-brand ' + toneClass(manifest, hasWorkflow) + ' icon-' + iconKind(manifest, hasWorkflow) + '">' + brandIcon(manifest, hasWorkflow) + "</span><div><b data-user-content>" + h(manifest.name) +
      "</b><p" + (manifest.description ? ' data-user-content' : '') + '>' + h(manifest.description || '没有说明') + '</p><em>v' + h(manifest.version) +
      ' · ' + (application ? '即用' : hasWorkflow ? flow.length + ' 个步骤' : '直接能力包') + '</em></div></div>' +
      '<div class="cap-local-checks"><span>结构检查通过</span><span>仅保存到本机</span></div>' +
      '<div class="cap-local-access"><b>使用时需要</b><span>' + [
        cap.network ? '网络访问' : '无需网络访问',
        ...(cap.runtime || []).filter(x => x !== 'files').map(x => x === 'terminal' ? '运行命令' : x === 'browser' ? '浏览器' : x),
      ].map(label => '<span>' + h(label) + '</span>').join(' · ') + '</span></div>' +
      (global.SoduWorkPluginMakerUtils ? global.SoduWorkPluginMakerUtils.resourceMarkup(resources) : '') +
      '<p class="cap-local-note">' + (application ? '安装后可在「即用 → 我的」中找到，独立打开工作页面。' : '安装后可在插件中找到；需要的偏好和账号连接会在首次使用时引导设置。') + '</p>' +
      '<p class="cap-local-error" id="capLocalError" role="alert" hidden></p>',
      '<button class="btn-mini" id="capLocalCancel">取消</button><span class="push"></span>' +
      '<button class="btn-mini" id="capLocalOnly">仅安装</button>' +
      '<button class="btn-mini primary" id="capLocalInstall">' + (application ? '安装并打开' : '安装并试用') + '</button>');
    layer.querySelector('.cap-modal')?.classList.add('cap-local-install-modal');
    const resourceDetails = layer.querySelector('.cap-resource-pack');
    if (resourceDetails) resourceDetails.open = false;
    layer.querySelector('#capLocalCancel').addEventListener('click', ctx.closeModal);
    const installButton = layer.querySelector('#capLocalInstall');
    const errorEl = layer.querySelector('#capLocalError');
    function installed(item, message = '') {
      const ready = ctx.openModal('安装完成', (application ? '即用' : '插件') + '已保存到我的 SoduWork',
        '<div class="cap-local-success"><span aria-hidden="true">' + ICON.shield + '</span><div><b data-user-content>' + h(item.name) +
        '</b><p>' + (application ? '可从「即用 → 我的」独立打开。' : '可从插件页面或对话输入框中选择使用。') + '</p></div></div>' +
        (message ? '<p class="cap-local-error" role="alert">' + h(message) + '</p>' : ''),
        '<button class="btn-mini" id="capLocalDone">完成</button><span class="push"></span>' +
        '<button class="btn-mini primary" id="capLocalTry">开始使用</button>');
      ready.querySelector('.cap-modal')?.classList.add('cap-local-install-modal');
      ready.querySelector('#capLocalDone').onclick = ctx.closeModal;
      ready.querySelector('#capLocalTry').onclick = async function () {
        this.disabled = true;
        try { ctx.closeModal(); await ctx.tryPlugin?.(item); }
        catch (error) { installed(item, ctx.errorText(error, '插件已安装，暂时无法开始试用')); }
      };
    }
    async function install(useNow, button) {
      if (layer._installPending) return;
      layer._installPending = true; errorEl.hidden = true;
      const controls = [...layer.querySelectorAll('#capModalClose,#capLocalCancel,#capLocalOnly,#capLocalInstall')];
      controls.forEach(control => { control.disabled = true; });
      const label = button.textContent; button.textContent = '正在安装…';
      let result;
      try {
        result = await SoduWorkAPI.createPluginDraft(body);
        if (!result || result.ok === false || !result.plugin) throw Error(result?.reason || result?.error || '个人插件没有安装成功');
      } catch (error) {
        errorEl.textContent = ctx.errorText(error, '个人插件没有安装成功'); errorEl.hidden = false;
        return;
      } finally {
        layer._installPending = false; controls.forEach(control => { control.disabled = false; }); button.textContent = label;
      }
      // Installation is already committed. Catalog or trial failures must not
      // turn success into "install failed" or trigger another installation.
      void load().then(() => ctx.refresh()).catch(() => {});
      ctx.say(result.message || '个人插件已安装');
      if (layer.querySelector('#capLocalInstall') !== installButton) return;
      if (!useNow || typeof ctx.tryPlugin !== 'function') { installed(result.plugin); return; }
      try { ctx.closeModal(); await ctx.tryPlugin(result.plugin); }
      catch (error) { installed(result.plugin, ctx.errorText(error, '插件已安装，暂时无法开始试用')); }
    }
    installButton.addEventListener('click', function () { void install(true, this); });
    layer.querySelector('#capLocalOnly').addEventListener('click', function () { void install(false, this); });
  }
  function openPreflight(file, preview, ctx) {
    const rawManifest = preview.manifest || {};
    const manifest = global.SoduWorkPluginLocales?.present(rawManifest, global.SoduWorkI18n?.getLocale?.() || global.navigator?.language) || rawManifest;
    const personalDraft = preview.personalDraft || {};
    const cap = preview.capabilities || {};
    const flow = (preview.workflow || {}).nodes || [];
    const hasWorkflow = cap.hasWorkflow !== false &&
      (cap.executionMode === 'workflow' || flow.length > 1);
    const blockers = cap.adapterBlockers || [];
    const warnings = [...(cap.adapterWarnings || []), ...(cap.unsupportedComponents || []).map(
      x => '暂不自动执行第三方组件：' + x)];
    const layer = ctx.openModal('导入插件到本机',
      '已识别 ' + sourceName(preview.sourceKind) + ' · 先在当前 SoduWork 安装试用',
      '<div class="cap-plugin-preview"><span>' + ICON.upload + "</span><div><b" + (manifest.name ? ' data-user-content' : '') + '>' + h(manifest.name || file.name) +
      "</b><p" + (manifest.description ? ' data-user-content' : '') + '>' + h(manifest.description || '没有说明') + '</p><em>v' + h(manifest.version || '—') +
      ' · ' + (hasWorkflow ? flow.length + ' 个步骤' : '直接能力') +
      ' · ' + (cap.skills || []).length + ' 个 Skill</em></div></div>' +
      (global.SoduWorkPluginMakerUtils ? global.SoduWorkPluginMakerUtils.resourceMarkup(personalDraft.resources || cap.resources || manifest.resources) : '') +
      '<div class="cap-checks">' + (preview.checks || []).map(x => '<span class="cap-check' +
        (x.ok ? '' : ' warn') + '">' + h(x.label) + '</span>').join('') + '</div>' +
      (warnings.length ? '<div class="cap-plugin-warnings"><b>兼容说明</b>' + warnings.map(x => '<span>' + h(x) + '</span>').join('') + '</div>' : '') +
      (blockers.length ? '<div class="cap-plugin-blockers"><b>当前不能提交</b>' + blockers.map(x => '<span>' + h(x) + '</span>').join('') + '</div>' : '') +
      '<p class="cap-governance-note"><b>安装并试用只保存在本机。</b>SoduWork 保留预检通过的工作说明、Skill 正文和声明并校验的随包资源。安装不会执行脚本；未适配的第三方组件不会启用。提交平台审核会把原始压缩包上传到隔离区，审核通过后才能面向企业安装。</p>',
      '<button class="btn-mini" id="capUploadCancel">取消</button><span class="push"></span>' +
      '<button class="btn-mini" id="capUploadSubmit"' + (blockers.length ? ' disabled' : '') + '>提交平台审核</button>' +
      '<button class="btn-mini primary" id="capUploadDo"' + (blockers.length ? ' disabled' : '') + '>安装并试用</button>');
    layer.querySelector('#capUploadCancel').addEventListener('click', ctx.closeModal);
    layer.querySelector('#capUploadSubmit').addEventListener('click', async function () {
      this.disabled = true; this.textContent = '正在提交…';
      try {
        const result = await SoduWorkAPI.submitPlugin(file);
        ctx.closeModal();
        ctx.say(result.message || '插件已提交平台隔离区，等待审核');
        await load(); ctx.refresh();
      } catch (error) {
        ctx.say(ctx.errorText(error, '插件没有提交成功'));
        this.disabled = false; this.textContent = '提交平台审核';
      }
    });
    layer.querySelector('#capUploadDo').addEventListener('click', async function () {
      this.disabled = true; this.textContent = '正在安装…';
      try {
        if (!personalDraft.name || !personalDraft.version) {
          throw new Error('插件预检没有生成可安装的个人快照');
        }
        const result = await SoduWorkAPI.createPluginDraft(personalDraft);
        ctx.closeModal();
        ctx.say(result.message || '个人插件已安装，可以立即试用');
        await load(); ctx.refresh();
        if (result.plugin && typeof ctx.tryPlugin === 'function') ctx.tryPlugin(result.plugin);
      } catch (error) {
        ctx.say(ctx.errorText(error, '个人插件没有安装成功'));
        this.disabled = false; this.textContent = '安装并试用';
      }
    });
  }
  function openMaker(ctx, initial, versions) {
    if (!global.SoduWorkPluginMaker || typeof global.SoduWorkPluginMaker.open !== 'function') {
      ctx.say('高级插件编辑器还没有加载，请重启 SoduWork 后再试');
      return;
    }
    return global.SoduWorkPluginMaker.open({ ...ctx, api: SoduWorkAPI }, {
      openLocalImport: openLocalImport, load: load,
    }, initial, versions);
  }
  global.SoduWorkCapabilityPlugins = { load, hasCompleteCatalog: () => completeCatalog, count, managedCount, marketCount, marketItems, snapshot, hasPendingReview, revision, render, open: openById, choosePackage, openMaker, openLocalImport, brandIcon, iconKind, toneClass };
})(window);
