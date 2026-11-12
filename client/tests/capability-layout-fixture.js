/* Isolated capability page data. Every API action stays in this page's memory. */
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const empty = params.get('scenario') === 'empty';
  const clone = value => structuredClone(value);
  const calls = window.fixtureCalls = [];
  window.fixtureErrors = [];
  window.fixtureReady = false;
  addEventListener('error', event => fixtureErrors.push(event.message));
  addEventListener('unhandledrejection', event => fixtureErrors.push(String(event.reason)));
  const record = (action, value) => calls.push({ action, value: clone(value ?? null) });
  window.fetch = async () => { throw Error('Network forbidden in isolated capability fixture'); };
  window.petSay = message => record('notice', message);
  window.WorkspaceHost = { open: (...args) => record('workspace.open', args) };

  const company = [
    { id: 'company-knowledge', name: '企业知识库', description: '检索团队文档、制度与项目知识，保留出处。', type: 'http', url: 'https://knowledge.fixture.invalid/mcp', enabledTools: ['search', 'read_document'], disabledTools: ['delete_document'] },
    { id: 'company-github', name: 'GitHub 项目协作', description: '读取代码仓库、议题与提交记录，跟进团队工作。', type: 'http', url: 'https://github.fixture.invalid/mcp', enabledTools: ['read_issue'] },
    { id: 'company-calendar', name: '团队日历', description: '查询团队日程与会议安排。', type: 'stdio', templateKey: 'mcp-calendar' },
  ].map(item => ({ ...item, startupTimeoutSeconds: 10, toolTimeoutSeconds: 60 }));
  const personal = [
    { id: 'personal-research', name: '我的研究资料库', description: '整理个人研究材料与引用索引。', type: 'http', url: 'https://research.fixture.invalid/mcp', enabled: true, canEdit: true, canDelete: true },
    { id: 'personal-web', name: '网页资料采集', description: '读取网页内容，并整理为便于复核的资料。', type: 'http', url: 'https://web.fixture.invalid/mcp', enabled: false, canEdit: true, canDelete: true },
    { id: 'builtin-time', name: 'SoduWork 时间工具', description: '查询当前时间、日期与时区。', type: 'stdio', templateKey: 'mcp-time', enabled: true, builtIn: true, canEdit: false, canDelete: false },
    { id: 'builtin-files', name: 'SoduWork 文件读取', description: '读取工作目录内的资料，不修改文件。', type: 'stdio', templateKey: 'mcp-files', enabled: false, builtIn: true, canEdit: false, canDelete: false },
  ].map(item => ({ headers: {}, env: {}, approved: true, approvedTarget: item.url || item.templateKey,
    startupTimeoutSeconds: 10, toolTimeoutSeconds: 60, enabledTools: [], disabledTools: [], ...item }));
  const templates = [
    { key: 'mcp-time', name: '时间与时区', description: '为跨时区协作提供准确时间。', risk: 'read' },
    { key: 'mcp-fetch', name: '网页内容读取', description: '抓取公开网页与业务资料。', risk: 'network' },
    { key: 'mcp-files', name: '工作区文件', description: '在授权目录中读取或整理文件。', risk: 'write' },
    { key: 'mcp-git', name: 'Git 仓库', description: '查看提交记录与文件变化。', risk: 'read' },
  ].map(item => ({ ...item, permissions: ['仅访问用户确认的目标', '工具调用遵循会话权限'] }));
  const skillSpecs = [
    ['builtin-research', '研究与证据核查', '内置方法', 'company', true, true],
    ['builtin-summary', '长文摘要', '内置方法', 'company', false, true],
    ['personal-weekly', '整理个人周报与下一步行动。', '个人技能', 'personal', true, false],
    ['personal-minutes', '将会议记录转成清晰纪要。', '个人技能', 'personal', false, false],
    ['team-writing', '遵循团队标准撰写工作材料。', '公司能力库', 'company', true, false],
    ['team-review', '核对交付物、风险与验收标准。', '公司能力库', 'company', false, false],
    ['data-check', '使用核查脚本识别数据异常。', '个人技能', 'personal', true, false],
    ['project-context', '读取工程上下文并形成工作说明。', '公司能力库', 'company', false, false],
  ];
  const skills = skillSpecs.map(([name, description, source, scope, enabled, builtIn], index) => ({
    name, description, source, scope, enabled, builtIn, available: true, portable: index !== 7,
    runtimeAvailable: index < 4 || index === 7, version: '1.0.' + index, hasScripts: index === 6,
    canDelete: scope === 'personal' && !builtIn, canShare: scope === 'personal' && !builtIn,
  }));
  skills.push({ name: 'unavailable-skill', description: '不可选择的占位技能，不应出现在列表中。', available: false, enabled: false });
  const categories = [
    { key: 'office', name: '办公写作', description: '整理文档、会议与汇报材料', enabled: true, sort: 0 },
    { key: 'research', name: '研究分析', description: '查阅资料并保留证据链', enabled: true, sort: 1 },
    { key: 'development', name: '研发工具', description: '研发协作与交付检查', enabled: true, sort: 2 },
    { key: 'unused', name: '行业方法', description: '待上架的专业方法', enabled: true, sort: 3 },
  ];
  const pluginNames = ['演示文稿工坊', '会议纪要整理', '企业知识检索', '代码审查助手', '项目周报', '行业研究报告', '发布检查清单', '文档工作室'];
  const plugins = pluginNames.map((name, index) => ({
    pluginId: 'market-' + index, key: 'market-' + index, name, description: [
      '从材料出发，生成结构清晰、可以复核的交付成果。',
      '按团队工作方法处理输入，保留来源、检查结果和下一步建议。',
    ][index % 2], sourceKind: index % 2 ? 'codex' : 'soduwork', authorName: '隔离示例团队',
    version: '1.1.0', installed: index < 3, enabled: true, personal: false, listed: true,
    organizationWide: true, projectCount: 1, updateAvailable: index === 1,
    entrypoints: { conversation: true, task: true, automation: true },
    installationState: index === 4 ? 'default_disabled' : index < 3 ? 'installed' : 'available',
    marketPolicy: { configured: true, category: categories[index % 3].key, featured: index === 0,
      installation: index === 3 ? 'not_available' : index === 4 ? 'installed_by_default' : 'available' },
    capabilities: { hasWorkflow: false, executionMode: 'direct', skills: ['team-writing'], mcpServers: [],
      runtime: [], components: [{ kind: 'instructions', label: '工作说明' }],
      permissionSummary: { riskLevel: 'low' }, qualitySummary: { verified: true }, resources: [] },
    workflow: [],
  }));
  plugins.push({ ...clone(plugins[0]), pluginId: 'unlisted-plugin', name: '已下架示例', listed: false });
  window.fixtureState = {
    skills: empty ? [] : skills, templates: empty ? [] : templates, plugins: empty ? [] : plugins,
    categories, mcp: { company: empty ? [] : company, personal: empty ? [] : personal,
      enabledCompany: empty ? [] : ['企业知识库', '团队日历'] }, mcpSubmissions: [], skillSubmissions: {},
  };
  const state = window.fixtureState;
  const catalog = () => clone({ skills: state.skills, mcpTemplates: state.templates,
    summary: { mcpReady: params.get('scenario') !== 'restricted' } });
  const requireSkill = name => {
    const item = state.skills.find(row => row.name === name);
    if (!item) throw Error('隔离技能不存在'); return item;
  };
  const checksum = 'd'.repeat(64);
  const files = [{ path: 'SKILL.md', kind: 'text', size: 240 },
    { path: 'references/工作规范.md', kind: 'text', size: 120 },
    { path: 'templates/report.md', kind: 'text', size: 100 }];
  const readSkill = (name, path, offset = 0) => {
    requireSkill(name);
    const text = '# ' + name + '\n\n隔离验收资料 · ' + path + '\n\n1. 核对输入与来源。\n2. 按步骤完成工作。\n3. 检查结果并交付。';
    return { kind: 'text', text: text.slice(offset), nextOffset: null, totalCharacters: text.length };
  };
  window.SoduWorkAPI = {
    capabilityCatalog: async () => { record('capabilityCatalog'); return catalog(); },
    refreshMySkills: async () => { record('refreshMySkills'); return catalog(); },
    myMcpServers: async () => clone(state.mcp),
    pluginCatalog: async () => ({ items: clone(state.plugins), categories: clone(categories), submissions: [] }),
    hubConfig: () => ({ environment: 'development' }),
    mySkills: async () => ({ skills: clone(state.skills) }),
    listAIAgents: async () => ({ agents: [] }),
    setMySkills: async names => {
      record('setMySkills', names); state.skills.forEach(item => { item.enabled = names.includes(item.name); });
      return { enabled: names.slice() };
    },
    saveMyMcpServers: async (rows, enabledCompany) => {
      record('saveMyMcpServers', { rows, enabledCompany });
      state.mcp.personal = rows.map((row, index) => ({
        canEdit: true, canDelete: true, ...state.mcp.personal.find(item => item.id === row.id),
        ...clone(row), id: row.id || 'created-' + index,
      }));
      state.mcp.enabledCompany = enabledCompany.slice(); return clone(state.mcp);
    },
    probeMyMcpServer: async spec => {
      record('probeMyMcpServer', spec); return { ok: true, runner: { host: '隔离模拟 Runner' },
        toolCount: 2, discoveredToolCount: 2, tools: ['search', 'read_document'] };
    },
    probeCompanyMcp: async id => { record('probeCompanyMcp', id); return {
      ok: true, runOn: 'runner', runnerHost: '隔离模拟 Runner', tools: ['search', 'read_document'] }; },
    previewMyMcpImport: async file => {
      record('previewMyMcpImport', file.name); return { summary: { total: 1, importable: 1 },
        servers: [{ name: '导入示例连接', target: 'https://import.fixture.invalid/mcp', importable: true, credentialKeys: [], errors: [], warnings: [] }] };
    },
    importMyMcp: async file => {
      record('importMyMcp', file.name); const item = { id: 'imported-connection', name: '导入示例连接',
        type: 'http', url: 'https://import.fixture.invalid/mcp', enabled: false, canEdit: true, canDelete: true };
      state.mcp.personal.push(item); return { imported: [clone(item)], importedRows: [clone(item)] };
    },
    shareMyMcp: async (id, name) => {
      record('shareMyMcp', { id, name }); const item = { id, name, status: 'pending', note: '' };
      state.mcpSubmissions.push(item); return { item: clone(item) };
    },
    myMcpSubmissions: async () => ({ items: clone(state.mcpSubmissions) }),
    deleteMyMcpServer: async id => {
      const item = state.mcp.personal.find(row => row.id === id);
      if (!item?.canDelete || item.builtIn) throw Error('内置连接不能删除');
      record('deleteMyMcpServer', id); state.mcp.personal = state.mcp.personal.filter(row => row.id !== id);
    },
    skillDetails: async name => {
      const item = requireSkill(name); record('skillDetails', name);
      return { ...clone(item), checksum, fileCount: files.length, unpackedBytes: 460, files: clone(files),
        submission: clone(state.skillSubmissions[name] || null) };
    },
    skillContent: async (name, version, path, offset) => { record('skillContent', { name, path, offset }); return readSkill(name, path, offset); },
    downloadSkill: async (...args) => { record('downloadSkill', args); return { ok: true }; },
    shareSkill: async (name, payload) => {
      const item = requireSkill(name); if (!item.canShare) throw Error('公司技能不能再次共享');
      record('shareSkill', { name, payload }); state.skillSubmissions[name] = { status: 'pending' }; return { ok: true };
    },
    createMySkill: async payload => {
      record('createMySkill', payload); state.skills.push({ ...clone(payload), scope: 'personal', source: '个人技能',
        enabled: true, available: true, portable: true, runtimeAvailable: true, canShare: true, canDelete: true });
    },
    deleteMySkill: async name => {
      const item = requireSkill(name); if (!item.canDelete || item.builtIn) throw Error('内置技能不能删除');
      record('deleteMySkill', name); state.skills = state.skills.filter(row => row.name !== name);
    },
  };
  window.soduWorkAPI = { conversationSession: { capabilities: async () => ({ ok: true,
    skills: state.skills.map(item => ({ name: item.name, installed: !!item.runtimeAvailable,
      installState: item.runtimeAvailable ? 'installed' : item.portable ? 'remote' : 'missing' })) }) },
    personalPlugins: { choosePackage: async () => { record('choosePluginPackage'); return { canceled: true }; } } };

  window.fixtureSelectTab = async tab => {
    const button = document.querySelector('[data-cap-tab="' + tab + '"]');
    if (!button) throw Error('Unknown fixture tab: ' + tab);
    button.click(); await new Promise(resolve => setTimeout(resolve, 120));
  };
  window.fixtureReadyPromise = new Promise((resolve, reject) => {
    addEventListener('DOMContentLoaded', async () => {
      try {
        const skin = SkinRegistry.getSkin(params.get('skin') || 'flat-azure');
        if (skin) { document.documentElement.dataset.skin = skin.material; document.documentElement.dataset.theme = skin.palette; }
        await openCapabilityPanel();
        const requested = params.get('tab') || 'apps';
        await fixtureSelectTab(['plugins', 'apps', 'mcp', 'skills', 'market'].includes(requested) ? requested : 'apps');
        window.fixtureReady = true; resolve(true);
      } catch (error) { fixtureErrors.push(String(error)); reject(error); }
    }, { once: true });
  });
})();
