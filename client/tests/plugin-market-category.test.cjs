'use strict';

/* Use administrative marketplace categories when configured, otherwise infer them from package declarations and capabilities. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function directory() {
  const presentation = fs.readFileSync(path.join(
    __dirname, '..', 'components', 'panels', 'plugin-presentation.js'), 'utf8');
  const source = fs.readFileSync(path.join(
    __dirname, '..', 'components', 'panels', 'panels-capability-directory.js'), 'utf8');
  const context = { window: {
    SoduWorkPluginCatalogFormat: { processBadge: () => '' },
  } };
  vm.runInNewContext(presentation, context);
  vm.runInNewContext('(function (global) {' +
    source.replace(/^\/\*[\s\S]*?\*\//, '') + '}).call(null, window)', context);
  return context.window.SoduWorkCapabilityDirectory;
}

test('后台分类、上架状态和作者真实驱动客户端市场', () => {
  const api = directory();
  const catalog = {
    categories: [
      { key: 'knowledge', name: '企业知识', description: '企业知识与研究', sort: 5, enabled: true },
      { key: 'general', name: '通用能力', description: '企业基础能力', sort: 20, enabled: true },
    ],
    items: [
      {
        pluginId: 'configured', name: '知识助手', description: '查找内部知识',
        sourceKind: 'codex', authorName: '王小明', listed: true,
        marketPolicy: { configured: true, category: 'knowledge', installation: 'available' },
        capabilities: { hasWorkflow: false, executionMode: 'direct', skills: [], mcpServers: [] },
      },
      {
        pluginId: 'declared', name: '文稿助手', description: '生成专业文稿',
        sourceKind: 'soduwork', listed: true, declaredCategory: 'office',
        marketPolicy: { configured: false, category: 'general', installation: 'available' },
        capabilities: { hasWorkflow: false, executionMode: 'direct', skills: [], mcpServers: [] },
      },
      {
        pluginId: 'hidden', name: '已下架插件', description: '不应展示',
        sourceKind: 'soduwork', listed: false,
        marketPolicy: { configured: true, category: 'general', installation: 'not_available' },
        capabilities: { hasWorkflow: false, executionMode: 'direct', skills: [], mcpServers: [] },
      },
    ],
  };
  const content = {
    innerHTML: '',
    querySelectorAll: () => [],
  };
  api.renderMarket(content, '', { catalog });
  assert.equal(api.marketCount(catalog), 2, '下架插件不计入市场数量');
  assert.match(content.innerHTML, /企业知识/);
  assert.match(content.innerHTML, /企业知识与研究/);
  assert.match(content.innerHTML, /Codex 兼容 · 王小明/);
  // Once the backend publishes a taxonomy, the declared manifest purpose is
  // only a fallback; unconfigured plugins use the configured general bucket.
  assert.match(content.innerHTML, /通用能力/);
  assert.doesNotMatch(content.innerHTML, /办公文稿/);
  assert.ok(content.innerHTML.indexOf('企业知识') < content.innerHTML.indexOf('通用能力'),
    '后台排序优先于回退分类');
  assert.doesNotMatch(content.innerHTML, /已下架插件/);
});

test('已停用但仍被插件使用的分类继续显示原分类名称', () => {
  const api = directory();
  const catalog = {
    categories: [
      { key: 'knowledge', name: '企业知识', description: '企业知识与研究', sort: 5, enabled: false },
      { key: 'general', name: '通用能力', description: '企业基础能力', sort: 20, enabled: true },
    ],
    items: [{
      pluginId: 'legacy-knowledge', name: '知识助手', description: '保留原分类', listed: true,
      marketPolicy: { configured: true, category: 'knowledge', installation: 'available' },
      capabilities: { hasWorkflow: false, executionMode: 'direct', skills: [], mcpServers: [] },
    }],
  };
  const content = { innerHTML: '', querySelectorAll: () => [] };
  api.renderMarket(content, '', { catalog });
  assert.match(content.innerHTML, /企业知识/);
  assert.match(content.innerHTML, /企业知识与研究/);
});

test('客户端按稳定分类标识筛选，并保留没有插件的已启用分类', () => {
  const api = directory();
  const catalog = {
    categories: [
      { key: 'alpha', name: '同名分类', description: '第一组', sort: 20, enabled: true },
      { key: 'beta', name: '同名分类', description: '第二组', sort: 10, enabled: true },
      { key: 'empty', name: '空分类', description: '暂时没有插件', sort: 30, enabled: true },
    ],
  };
  const items = [
    { pluginId: 'a', marketPolicy: { configured: true, category: 'alpha' } },
    { pluginId: 'b', marketPolicy: { configured: true, category: 'beta' } },
  ];
  const view = api.categoryView(catalog, items, 'beta');
  assert.equal(view.selected, 'beta');
  assert.deepEqual(view.items.map(item => item.pluginId), ['b']);
  assert.match(view.html, /data-cap-category="empty"/);
  assert.equal(api.categoryFor(items[0], { categories: [
    { key: 'alpha', name: '改名后的分类', enabled: true },
  ] }).name, '改名后的分类');
});

test('搜索无结果不会丢失市场中仍在使用的停用分类，清空搜索后仍只展示该分类', () => {
  const api = directory();
  const catalog = { categories: [
    { key: 'legacy', name: '历史方法', enabled: false },
    { key: 'general', name: '通用能力', enabled: true },
  ], items: [
    { pluginId: 'old', name: '历史检索助手', marketPolicy: { configured: true, category: 'legacy' } },
    { pluginId: 'new', name: '新文稿助手', marketPolicy: { configured: true, category: 'general' } },
  ] };
  const handlers = new Map();
  const content = { innerHTML: '', querySelectorAll(selector) {
    if (selector !== '[data-cap-category]') return [];
    return Array.from(this.innerHTML.matchAll(/data-cap-category="([^"]*)"/g), match => ({
      dataset: { capCategory: match[1] }, focus() {},
      addEventListener(event, handler) { handlers.set(match[1], handler); },
    }));
  } };
  api.renderMarket(content, '', { catalog });
  handlers.get('legacy')();
  api.renderMarket(content, 'no-match', { catalog });
  assert.match(content.innerHTML, /data-cap-category="legacy" aria-pressed="true"/);
  assert.match(content.innerHTML, /没有匹配的企业插件/);
  api.renderMarket(content, '', { catalog });
  assert.match(content.innerHTML, /data-cap-market-open="old"/);
  assert.doesNotMatch(content.innerHTML, /data-cap-market-open="new"/);
});

test('应用类插件不出现在市场列表和计数，由应用菜单承载', () => {
  const api = directory();
  const catalog = {
    categories: [{ key: 'general', name: '通用能力', sort: 20, enabled: true }],
    items: [
      {
        pluginId: 'plain', name: '普通插件', description: '留在市场', listed: true,
        marketPolicy: { configured: true, category: 'general', installation: 'available' },
        capabilities: { hasWorkflow: false, executionMode: 'direct', skills: [], mcpServers: [] },
      },
      {
        pluginId: 'workspace-app', name: '工作台应用', description: '应用菜单展示，市场隐藏',
        listed: true,
        marketPolicy: { configured: true, category: 'general', installation: 'available' },
        capabilities: { hasWorkflow: false, executionMode: 'direct', skills: [], mcpServers: [] },
        ui: { contributions: [{ id: 'main', title: '工作台应用', slot: 'workspace.navigation',
          source: { type: 'external', url: 'https://example.invalid/app' } }] },
      },
    ],
  };
  const content = { innerHTML: '', querySelectorAll: () => [] };
  api.renderMarket(content, '', { catalog });
  assert.equal(api.marketCount(catalog), 1, '应用类插件不计入市场数量');
  assert.match(content.innerHTML, /普通插件/);
  assert.doesNotMatch(content.innerHTML, /工作台应用/, '应用类插件不出现在市场列表');
});

test('全部内置插件都声明了合法的用途类（并发会话未提交的文件除外）', () => {
  const dir = path.join(__dirname, '..', '..', 'hub-backend', 'plugins');
  const allowed = new Set(['dev', 'office', 'research', 'errand']);
  const missing = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    if (name === 'autonomous-dev-iterator.json') continue;   // Unsubmitted files from a concurrent conversation.
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    if (!allowed.has(manifest.category)) missing.push(name + ' -> ' + manifest.category);
  }
  assert.deepEqual(missing, [], '这些内置插件没有合法的 category：' + missing.join('、'));
});
