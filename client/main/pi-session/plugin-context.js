/* Per-turn enterprise plugin context: visible badges, hidden bounded instructions. */
'use strict';

const START = '<soduwork-conversation-plugins>';
const END = '</soduwork-conversation-plugins>';
const MAX_PLUGINS = 3;
const MAX_CONTEXT = 10000;
const MAX_CAPABILITIES = 20;

const RUNTIME_ALIASES = Object.freeze({
  file: 'files', filesystem: 'files', shell: 'terminal', command: 'terminal',
  build: 'terminal', git: 'repository', repo: 'repository', web: 'browser',
  'browser-use': 'browser', browser_use: 'browser', 'office-cli': 'office',
  office: 'office', officecli: 'office', 'computer-use': 'computer', computer_use: 'computer',
  desktop: 'computer',
});
const RUNTIME_LABELS = Object.freeze({
  files: '文件处理', terminal: '命令与构建', repository: '代码仓库',
  browser: '浏览网页', office: 'Office 文档', computer: '操作电脑',
});

function list(value, limit = MAX_CAPABILITIES) {
  const source = Array.isArray(value) ? value : [];
  return [...new Set(source.map((item) => String(item || '').trim()).filter(Boolean))]
    .slice(0, limit);
}

function runtimeName(value) {
  const key = String(value || '').trim().toLowerCase();
  return RUNTIME_ALIASES[key] || key;
}

function capabilitySet(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    skills: list(source.skills),
    mcpServers: list(source.mcpServers),
    runtime: [...new Set(list(source.runtime).map(runtimeName))],
  };
}

function neutralize(value) {
  return String(value || '').split(START).join('<soduwork-conversation-plugin-text>')
    .split(END).join('</soduwork-conversation-plugin-text>');
}

function compact(input) {
  const seen = new Set();
  const items = [];
  for (const raw of Array.isArray(input) ? input : []) {
    const pluginId = String(raw && raw.pluginId || '').trim();
    const context = neutralize(raw && raw.context).trim().slice(0, MAX_CONTEXT);
    if (!pluginId || !context || seen.has(pluginId)) continue;
    seen.add(pluginId);
    items.push({
      pluginId,
      name: String(raw.name || raw.key || '企业插件').trim().slice(0, 120),
      version: String(raw.version || '').trim().slice(0, 40),
      scopeLabel: String(raw.scopeLabel || '').trim().slice(0, 120),
      capabilities: capabilitySet(raw.capabilities),
      context,
    });
    if (items.length >= MAX_PLUGINS) break;
  }
  return items;
}

/* A plugin mention is a per-turn request, not a permission bypass. The model
   receives plugin instructions only after immutable session capabilities and
   the Hub-issued MCP grant satisfy every declared runtime dependency. */
function authorization(input, options) {
  const plugins = compact(input);
  const opts = options || {};
  const granted = new Set(list(opts.capabilityIds, 64).map(runtimeName));
  const activeMcp = new Set(list(opts.mcpServers, 64));
  const required = [...new Set(plugins.flatMap((item) => item.capabilities.runtime))];
  const requiredMcp = [...new Set(plugins.flatMap((item) => item.capabilities.mcpServers))];
  const missing = [];
  const access = [];
  const unsupported = [];
  required.forEach((name) => {
    if (['files', 'terminal', 'repository'].includes(name)) {
      if (opts.readOnly) access.push(name);
      return;
    }
    if (['browser', 'office', 'computer'].includes(name)) {
      if (!granted.has(name)) missing.push(name);
      return;
    }
    unsupported.push(name);
  });
  const missingMcp = requiredMcp.filter((name) => !activeMcp.has(name));
  const labels = (rows) => rows.map((name) => RUNTIME_LABELS[name] || name).join('、');
  const reasons = [];
  if (missing.length) {
    reasons.push('当前会话没有授权：' + labels(missing) + '。请新建会话并开启对应能力后再使用这个插件');
  }
  if (access.length) {
    reasons.push('当前会话是只读模式，插件还需要：' + labels(access) + '。请改为可读写后重新开始会话');
  }
  if (missingMcp.length) {
    reasons.push('当前对话尚未接入插件依赖的连接器：' + missingMcp.join('、') +
      '。请在插件或连接器设置中完成连接并启用后重试');
  }
  if (unsupported.length) {
    reasons.push('当前对话底座不支持插件声明的能力：' + labels(unsupported));
  }
  return {
    ok: !reasons.length,
    required,
    requiredMcp,
    missing,
    missingMcp,
    readOnlyConflicts: access,
    unsupported,
    retrySafe: !missing.length && !access.length && !unsupported.length,
    reason: reasons.join('；'),
  };
}

function inputSelections(input, allowedIds) {
  const allowed = new Set(allowedIds || []), result = [];
  for (const row of Array.isArray(input) ? input.slice(0, MAX_PLUGINS) : []) {
    if (!allowed.has(row?.pluginId) || !row.inputValues || typeof row.inputValues !== 'object') continue;
    const values = {};
    for (const [key, value] of Object.entries(row.inputValues).slice(0, 50)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key)) continue;
      if (typeof value === 'string') values[key] = neutralize(value);
      else if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) values[key] = value;
    }
    if (Object.keys(values).length) result.push({ pluginId: row.pluginId, inputValues: values });
  }
  if (JSON.stringify(result).length > 20000) throw Error('插件参数过长，请缩短后重试');
  return result;
}

function augment(text, input, runtimeGuide, selections) {
  const plugins = compact(input);
  const visible = neutralize(text);
  if (!plugins.length) return visible;
  const guide = neutralize(runtimeGuide).trim().slice(0, 4000);
  const inputs = inputSelections(selections, plugins.map(item => item.pluginId));
  return visible + '\n\n' + START + '\n' + JSON.stringify({
    plugins,
    ...(inputs.length ? { inputs } : {}),
    ...(guide ? { runtimeGuide: guide } : {}),
  }) + '\n' + END;
}

function parse(value) {
  const source = require('./connector-context.cjs').strip(value);
  const at = source.lastIndexOf(START);
  const end = source.lastIndexOf(END);
  if (at < 0 || end < at) return { text: source, plugins: [] };
  let plugins = [];
  try {
    const payload = JSON.parse(source.slice(at + START.length, end).trim());
    plugins = compact(payload && payload.plugins).map((item) => ({
      pluginId: item.pluginId,
      name: item.name,
      version: item.version,
      scopeLabel: item.scopeLabel,
    }));
  } catch (_) {
    plugins = [];
  }
  return { text: source.slice(0, at).trimEnd(), plugins };
}

module.exports = {
  START, END, MAX_PLUGINS, MAX_CONTEXT,
  compact, augment, parse, authorization, capabilitySet, runtimeName, inputSelections,
};
