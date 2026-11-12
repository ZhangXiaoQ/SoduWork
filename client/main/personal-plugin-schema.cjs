/* Personal plugin draft normalization; storage, versioning and publication stay with the caller. */
'use strict';

const crypto = require('crypto');

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;
const KEY = /^[a-z][a-z0-9-]{1,62}$/;
const INPUT_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SECRET_KEY = /password|passwd|token|secret|private.?key|api.?key/i;
const SECRET_VALUE = /(?:sk|pk|pat|ghp|glpat)-[A-Za-z0-9_-]{12,}|(?:api[_ -]?key|token|password)\s*[:=]\s*\S{8,}/i;
const RUNTIME_CAPABILITIES = new Set([
  'files', 'terminal', 'repository', 'browser', 'office', 'computer',
]);
const UI_SLOTS = new Set([
  'workspace.navigation', 'conversation.sidebar', 'task.detail.tab',
  'requirement.detail.tab', 'approval.detail.tab', 'automation.detail.tab',
]);
const UI_BUILTINS = new Set([
  'work.requirement.create', 'work.automation.create',
]);
/* Web applications request an explicitly granted, versioned capability set.
   The hosted page receives the bridge only from an installed contribution
   after the main-process origin and capability checks succeed. */
const UI_BRIDGE_CAPABILITIES = new Set([
  'ai.generate',
  'context.read', 'directory.read', 'messages.read', 'library.read', 'conversation.open', 'conversation.send',
  'requirements.propose', 'notifications.send', 'composer.control', 'mcp.connect',
  'settings.read', 'settings.write', 'automation.create', 'data.read', 'data.write',
]);

function text(value, limit) { return String(value == null ? '' : value).trim().slice(0, limit); }

// Bind the existing module objects once per personal-plugin service instance so
// resource/workflow overrides retain the same lifetime as the public service.
function create({ pluginWorkflow, pluginResources, pluginPlatforms }) {
  function slug(value) {
    const source = text(value, 120);
    let key = source.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
    if (!key || !/^[a-z]/.test(key)) key = 'personal-' + crypto.createHash('sha256').update(source).digest('hex').slice(0, 10);
    return key.slice(0, 63).replace(/-+$/g, '');
  }

  function names(value) {
    const raw = Array.isArray(value) ? value : String(value || '').split(/[,，\n]/);
    return [...new Set(raw.map((item) => text(item, 80)).filter(Boolean))].slice(0, 30);
  }

  function criteria(value) {
    const raw = Array.isArray(value) ? value : String(value || '').split(/[\n；;]/);
    return [...new Set(raw.map((item) => text(item, 300)).filter(Boolean))].slice(0, 20);
  }
  function normalizeInstallSetup(value) {
    // Earlier generated drafts used the preference list directly. Canonicalize
    // this unambiguous shorthand before applying every existing field safeguard.
    if (Array.isArray(value)) value = { preferences: value };
    const empty = { title: '', description: '', preferences: [] };
    if (value == null || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length)) return empty;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件 setup 必须是对象');
    const unknown = Object.keys(value).filter((key) => !['title', 'description', 'preferences'].includes(key));
    if (unknown.length) throw new Error('插件 setup 包含不支持的字段：' + unknown.join('、'));
    const rawFields = value.preferences == null ? [] : value.preferences;
    if (!Array.isArray(rawFields) || rawFields.length > 40) throw new Error('插件 setup.preferences 必须是至多 40 项的数组');
    const setupKey = /password|passwd|passphrase|token|secret|private.?key|api.?key|credential|client.?secret|access.?key|auth(?:orization)?|账号|密码|密钥|令牌|凭据|授权/i;
    const setupText = (value, limit) => {
      const output = String(value == null ? '' : value).trim();
      if (output.length > limit) throw new Error('安装设置内容不能超过 ' + limit + ' 个字符');
      return output;
    };
    const setupTypes = new Set(['text', 'textarea', 'boolean', 'number', 'select', 'multiselect', 'url']);
    const aliases = { string: 'text', bool: 'boolean', enum: 'select' };
    const seen = new Set();
    const preferences = rawFields.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('每个安装设置都必须是对象');
      const key = String(item.key == null ? '' : item.key).trim();
      if (!INPUT_KEY.test(key) || seen.has(key)) throw new Error('安装设置字段名不合法或重复：' + (key || '（空）'));
      if (setupKey.test(key) || item.sensitive) throw new Error('安装设置 ' + key + ' 不能收集凭据，请使用企业连接或密钥引用');
      let type = String(item.type == null ? '' : item.type).trim().toLowerCase() || 'text';
      type = aliases[type] || type;
      if (!setupTypes.has(type)) throw new Error('安装设置 ' + key + ' 使用了不支持的类型：' + type);
      const label = String(item.label == null ? '' : item.label).trim() || key;
      const description = String(item.description == null ? '' : item.description).trim();
      const placeholder = String(item.placeholder == null ? '' : item.placeholder).trim();
      const group = String(item.group == null ? '' : item.group).trim() || '使用偏好';
      const setupCopy = description + '\n' + placeholder;
      const credentialCopy = /password|passwd|passphrase|token|secret|private.?key|api.?key|credential|client.?secret|access.?key|auth(?:orization)?/i;
      if (setupKey.test(label) || credentialCopy.test(setupCopy) || SECRET_VALUE.test(setupCopy)) throw new Error('安装设置 ' + key + ' 疑似要求填写凭据，请改用企业连接');
      const field = { key, label: setupText(label, 100), type, required: Boolean(item.required), description: setupText(description, 300), placeholder: setupText(placeholder, 180), group: setupText(group, 60) };
      const optionValues = new Set();
      if (type === 'select' || type === 'multiselect') {
        if (!Array.isArray(item.options) || !item.options.length || item.options.length > 50) throw new Error('安装设置 ' + key + ' 的 options 必须有 1 到 50 项');
        field.options = item.options.map((rawOption) => {
          const option = rawOption && typeof rawOption === 'object' && !Array.isArray(rawOption) ? rawOption : { value: rawOption, label: rawOption };
          const optionValue = String(option.value == null ? '' : option.value).trim();
          if (!optionValue || optionValues.has(optionValue) || SECRET_VALUE.test(optionValue)) throw new Error('安装设置 ' + key + ' 包含空值、重复选项或疑似凭据');
          optionValues.add(optionValue);
          return { value: setupText(optionValue, 200), label: setupText(option.label == null ? '' : option.label, 100) || setupText(optionValue, 200) };
        });
      }
      if (['text', 'textarea', 'url'].includes(type)) {
        const minimum = item.minLength == null || item.minLength === '' ? 0 : Number(item.minLength);
        const maximum = item.maxLength == null || item.maxLength === '' ? 8000 : Number(item.maxLength);
        if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 0 || maximum < 1 || minimum > maximum || maximum > 8000) throw new Error('安装设置 ' + key + ' 的长度范围不合法');
        if (minimum) field.minLength = minimum;
        field.maxLength = maximum;
      }
      if (type === 'number') {
        if (item.minimum != null && item.minimum !== '') { const minimum = Number(item.minimum); if (!Number.isFinite(minimum)) throw new Error('安装设置 ' + key + ' 必须是有效数字'); field.minimum = minimum; }
        if (item.maximum != null && item.maximum !== '') { const maximum = Number(item.maximum); if (!Number.isFinite(maximum)) throw new Error('安装设置 ' + key + ' 必须是有效数字'); field.maximum = maximum; }
        if (field.minimum != null && field.maximum != null && field.minimum > field.maximum) throw new Error('安装设置 ' + key + ' 的数字范围不合法');
      }
      if (Object.prototype.hasOwnProperty.call(item, 'default')) {
        let defaultValue = item.default;
        if (defaultValue !== '' && defaultValue != null && !(Array.isArray(defaultValue) && !defaultValue.length)) {
          if (type === 'boolean') {
            if (typeof defaultValue !== 'boolean') throw new Error('安装设置 ' + key + ' 的默认值必须是布尔值');
          } else if (type === 'number') {
            if (typeof defaultValue !== 'number' || !Number.isFinite(defaultValue)) throw new Error('安装设置 ' + key + ' 的默认值必须是数字');
            if ((field.minimum != null && defaultValue < field.minimum) || (field.maximum != null && defaultValue > field.maximum)) throw new Error('安装设置 ' + key + ' 的默认值超出数字范围');
          } else if (type === 'multiselect') {
            if (!Array.isArray(defaultValue) || defaultValue.length > 50 || defaultValue.some((itemValue) => !optionValues.has(String(itemValue)))) throw new Error('安装设置 ' + key + ' 的默认值必须来自选项');
            defaultValue = [...new Set(defaultValue.map((itemValue) => String(itemValue)))];
          } else {
            defaultValue = setupText(defaultValue, field.maxLength || 8000);
            if (field.minLength && defaultValue.length < field.minLength) throw new Error('安装设置 ' + key + ' 的默认值内容太短');
            if ((type === 'select' && !optionValues.has(defaultValue)) || SECRET_VALUE.test(defaultValue)) throw new Error('安装设置 ' + key + ' 的默认值不合法或疑似包含凭据');
            if (type === 'url') {
              try { const parsed = new URL(defaultValue); if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error('invalid'); }
              catch (_) { throw new Error('安装设置 ' + key + ' 的默认值必须是完整的 http/https 地址'); }
            }
          }
          field.default = defaultValue;
        }
      }
      seen.add(key);
      return field;
    });
    const title = String(value.title == null ? '' : value.title).trim();
    const description = String(value.description == null ? '' : value.description).trim();
    if (SECRET_VALUE.test(description)) throw new Error('插件安装说明疑似包含凭据');
    return { title: setupText(title, 120), description: setupText(description, 500), preferences };
  }

  function normalizePublicInputs(value) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > 50) {
      throw new Error('插件公开参数必须是至多 50 项的数组');
    }
    const aliases = { string: 'text', bool: 'boolean', enum: 'select' };
    const seen = new Set();
    return value.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('插件的每个公开参数都必须是对象');
      }
      const key = text(item.key, 64);
      if (!INPUT_KEY.test(key) || seen.has(key)) {
        throw new Error('插件公开参数名不合法或重复：' + (key || '空值'));
      }
      if (SECRET_KEY.test(key) || item.sensitive) {
        throw new Error('公开参数「' + key + '」不能收集凭据，请使用企业 Secret Reference');
      }
      let type = text(item.type, 20).toLowerCase() || 'text';
      type = aliases[type] || type;
      if (type === 'text' && item.multiline) type = 'textarea';
      if (!['text', 'textarea', 'boolean', 'number', 'select'].includes(type)) {
        throw new Error('公开参数「' + key + '」使用了不支持的类型');
      }
      const field = {
        key, label: text(item.label, 100) || key, type, required: Boolean(item.required),
        description: text(item.description, 300), placeholder: text(item.placeholder, 180),
      };
      const optionValues = new Set();
      if (type === 'select') {
        if (!Array.isArray(item.options) || !item.options.length || item.options.length > 50) {
          throw new Error('公开参数「' + key + '」需要 1 到 50 个选项');
        }
        field.options = item.options.map((raw) => {
          const option = raw && typeof raw === 'object' && !Array.isArray(raw)
            ? raw : { value: raw, label: raw };
          const value = text(option.value, 200);
          if (!value || optionValues.has(value)) {
            throw new Error('公开参数「' + key + '」包含空值或重复选项');
          }
          optionValues.add(value);
          return { value, label: text(option.label, 100) || value };
        });
      }
      if (Object.prototype.hasOwnProperty.call(item, 'default')) {
        let defaultValue = item.default;
        if (type === 'boolean' && typeof defaultValue !== 'boolean') {
          throw new Error('公开参数「' + key + '」的默认值必须是布尔值');
        }
        if (type === 'number' && (typeof defaultValue !== 'number' || !Number.isFinite(defaultValue))) {
          throw new Error('公开参数「' + key + '」的默认值必须是数字');
        }
        if (!['boolean', 'number'].includes(type)) {
          defaultValue = text(defaultValue, 8000);
          if (type === 'select' && !optionValues.has(defaultValue)) {
            throw new Error('公开参数「' + key + '」的默认值不在选项中');
          }
        }
        if (typeof defaultValue === 'string' && SECRET_VALUE.test(defaultValue)) {
          throw new Error('公开参数「' + key + '」的默认值疑似包含凭据');
        }
        field.default = defaultValue;
      }
      if (SECRET_VALUE.test([field.description, field.placeholder].join('\n'))) {
        throw new Error('公开参数「' + key + '」的说明疑似包含凭据');
      }
      seen.add(key);
      return field;
    });
  }

  function normalizeUi(value) {
    if (value == null || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length)) {
      return { contributions: [] };
    }
    const rows = value && Array.isArray(value.contributions) ? value.contributions : null;
    if (!rows || rows.length > 12) throw new Error('员工界面必须是至多 12 项的数组');
    const seen = new Set();
    return { contributions: rows.map((raw, index) => {
      const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      const id = text(item.id || 'view-' + (index + 1), 64);
      const title = text(item.title, 80);
      const slot = text(item.slot, 40);
      if (!INPUT_KEY.test(id) || seen.has(id) || !title || !UI_SLOTS.has(slot)) {
        throw new Error('员工界面的标识、名称或展示位置不合法');
      }
      const source = item.source && typeof item.source === 'object' ? item.source : {};
      const type = text(source.type || source.kind, 20);
      let safeSource;
      if (type === 'builtin') {
        const requestedAction = text(source.actionId, 100);
        const actionId = requestedAction === 'work.task.create' ? 'work.requirement.create' : requestedAction;
        if (!UI_BUILTINS.has(actionId)) throw new Error('个人插件引用了未开放的 SoduWork 页面');
        safeSource = { type: 'builtin', actionId };
      } else if (type === 'external' || type === 'package') {
        if (type === 'package' && slot !== 'workspace.navigation') throw Error('包内页面仅支持即用入口 workspace.navigation');
        if (type === 'package' && source.openMode != null && source.openMode !== 'workspace') throw Error('包内页面只能由即用壳打开');
        const url = type === 'package' ? '' : text(source.url, 1600);
        if (type === 'external' && (!/^https?:\/\//i.test(url.replace(/\{\{\s*(?:task|project|user)\.[\w.-]+\s*\}\}/g, 'sample')) ||
            /(?:[?&])(?:token|secret|password|api[_-]?key)=/i.test(url))) {
          throw new Error('员工界面只允许不含凭据的 HTTP(S) 地址');
        }
        const bridge = source.bridge == null ? null : source.bridge;
        if (bridge != null && (!bridge || typeof bridge !== 'object' || Array.isArray(bridge))) {
          throw new Error('鍛樺伐鐣岄潰鐨勮兘鍔涚敵璇峰繀椤绘槸瀵硅薄');
        }
        const bridgeKeys = bridge ? Object.keys(bridge).filter((key) => !['version', 'capabilities'].includes(key)) : [];
        if (bridgeKeys.length) throw new Error('鍛樺伐鐣岄潰鐨勮兘鍔涚敵璇峰寘鍚笉鏀寔瀛楁');
        const bridgeVersion = bridge ? Number(bridge.version == null ? 1 : bridge.version) : 1;
        const requested = bridge && Array.isArray(bridge.capabilities) ? bridge.capabilities.map((item) => text(item, 80)) : [];
        if (bridge && (!Array.isArray(bridge.capabilities) || bridgeVersion !== 1 ||
            requested.some((item) => !UI_BRIDGE_CAPABILITIES.has(item)) || requested.length > UI_BRIDGE_CAPABILITIES.size)) {
          throw new Error('鍛樺伐鐣岄潰鐨勮兘鍔涚敵璇蜂笉鍚堟硶');
        }
        safeSource = { ...(type === 'package' ? { type, entry: require('../core/plugin-package-page.cjs').entry(source.entry) } : { type, url }),
          openMode: source.openMode === 'external' ? 'external' : 'workspace',
          ...(bridge ? { bridge: { version: 1, capabilities: [...new Set(requested)] } } : {}) };
      } else throw new Error('员工界面只支持外部系统页面、包内页面或 SoduWork 原生页面');
      seen.add(id);
      return { id, title, description: text(item.description, 240), slot,
        icon: text(item.icon, 24) || 'plugin', order: Number.isFinite(Number(item.order))
          ? Math.max(-1000, Math.min(1000, Number(item.order))) : 100, source: safeSource };
    }).sort((left, right) => left.order - right.order) };
  }

  function normalizeBody(raw) {
    const body = raw && typeof raw === 'object' ? raw : {};
    for (const [key, value] of Object.entries(body)) {
      if (SECRET_KEY.test(key) && String(value || '').trim()) {
        throw new Error('插件定义不能包含真实密码或密钥，请在企业发布时绑定 Secret Reference');
      }
    }
    // Metadata "secret: true" is a declaration, never a credential. Validate it
    // separately before excluding that declaration from the legacy field scan.
    const jiyong = body.jiyong == null ? null : require('../core/jiyong-contract.cjs').normalize(body.jiyong);
    if (pluginWorkflow.hasSecretField({ ...body, jiyong: undefined })) {
      throw new Error('插件定义不能保存密码、密钥或令牌，请在企业发布后绑定 Secret Reference');
    }
    const template = text(body.template, 20).toLowerCase();
    const distribution = text(body.distribution, 24).toLowerCase();
    if (distribution && distribution !== 'standalone') {
      throw new Error('插件发布方式只支持独立插件');
    }
    if (!['method', 'connector', 'workflow', 'app'].includes(template)) throw new Error('请选择工作方法、系统连接、自动化流程或应用');
    const name = text(body.name, 120);
    const description = text(body.description, 600);
    const instructions = text(body.instructions, 8000);
    const version = text(body.version, 40) || '0.1.0';
    const key = slug(body.key || name);
    const skills = names(body.skills).filter((item) => item !== key);
    const mcpServers = require('./plugin-capability-names.cjs').normalize(body.mcpServers, 'mcpServers');
    const runtime = require('./plugin-capability-names.cjs').normalize(body.runtimeCapabilities || body.runtime, body.runtimeCapabilities ? 'runtimeCapabilities' : 'runtime');
    const platforms = pluginPlatforms.normalize(body.platforms);
    if (platforms.includes('feishu') && !mcpServers.includes('feishu')) mcpServers.push('feishu');
    if (platforms.length) for (const capability of ['files', 'terminal']) {
      if (!runtime.includes(capability)) runtime.push(capability);
    }
    const evaluationInstruction = text(body.evaluationInstruction, 2000);
    const evaluationCriteria = criteria(body.evaluationCriteria);
    const inputs = normalizePublicInputs(body.inputs);
    const author = text(body.author, 120);
    const icon = require('../core/plugin-icon').normalize(body.icon);
    const setup = normalizeInstallSetup(body.setup);
    const ui = normalizeUi(body.ui);
    if (jiyong?.mcp && !mcpServers.includes(jiyong.mcp.server)) throw Error('即用 MCP 必须同时声明在 mcpServers 中');
    if (jiyong?.mcp?.server === 'soduwork-jiyong') {
      const pages = ui.contributions.filter(r => r.slot === 'workspace.navigation' && r.source.type === 'package' && r.source.bridge?.capabilities?.includes('mcp.connect'));
      if (pages.length !== 1 || !pages[0].source.bridge.capabilities.some(c => c === 'data.read' || c === 'data.write')) throw Error('宿主 MCP 需要唯一包内入口及数据能力');
    }
    require('../core/plugin-app-contract.cjs').validate(template, ui);
    const resources = pluginResources.normalize(body.resources);
    if(jiyong?.initialization)require('../core/jiyong-initialization.cjs').parse(jiyong,resources);
    require('../core/plugin-package-page.cjs').validate(ui, resources);
    const entrypoints = body.entrypoints == null ? null : body.entrypoints;
    if (entrypoints !== null && (typeof entrypoints !== 'object' || Array.isArray(entrypoints) ||
        Object.entries(entrypoints).some(([key, value]) => !['conversation', 'task', 'automation'].includes(key) || typeof value !== 'boolean'))) {
      throw new Error('插件入口必须使用 conversation、task、automation 布尔配置');
    }
    const importedKind = text(body.sourceKind, 32).toLowerCase();
    const sourceKind = ['codex', 'claude', 'agent-plugins', 'soduwork', 'adapter'].includes(importedKind)
      ? importedKind : 'personal';
    const importChecksum = /^[a-f0-9]{64}$/i.test(text(body.importChecksum, 64))
      ? text(body.importChecksum, 64).toLowerCase() : '';
    const importWarnings = criteria(body.importWarnings);
    const unsupportedComponents = names(body.unsupportedComponents);
    const workflow = body.workflow && typeof body.workflow === 'object'
      ? JSON.parse(JSON.stringify(body.workflow)) : null;
    const unsupportedRuntime = runtime.filter((item) => !RUNTIME_CAPABILITIES.has(item));
    if (!name || !description || !instructions) throw new Error('插件名称、用途和工作方法都要写清楚');
    if (SECRET_VALUE.test(description + '\n' + instructions)) {
      throw new Error('插件说明中疑似包含真实密码或密钥，请删除后再安装');
    }
    if (!KEY.test(key)) throw new Error('插件标识只允许小写字母、数字和短横线');
    if (!VERSION.test(version)) throw new Error('插件版本必须是 SemVer，例如 0.1.0');
    if (template === 'connector' && !pluginPlatforms.connectorReady(mcpServers, runtime, resources, platforms)) {
      throw new Error('系统连接插件需要声明连接器、平台账号连接，或终端能力与随包 CLI 脚本');
    }
    if (unsupportedRuntime.length) {
      throw new Error('不支持的执行能力：' + unsupportedRuntime.join('、'));
    }
    if (Boolean(evaluationInstruction) !== Boolean(evaluationCriteria.length)) {
      throw new Error('发布评测试题和验收标准需要一起填写');
    }
    return {
      template, key, name, version, description, instructions, skills, mcpServers, runtime,
      ...(jiyong ? { jiyong } : {}),
      ...(body.appCategory != null ? {appCategory:require('../core/plugin-app-contract.cjs').category(body.appCategory)} : {}),
      ...(body.extensions != null ? {extensions:require('../core/plugin-extensions.cjs').normalize(body.extensions)} : {}),
      ...(body.locales != null ? { locales: require('../core/plugin-locales').normalize(body.locales) } : {}),
      ...(text(body.sourcePluginId, 64) ? { sourcePluginId: text(body.sourcePluginId, 64) } : {}),
      ...(distribution ? { distribution } : {}),
      ...(platforms.length ? { platforms } : {}),
      evaluationInstruction, evaluationCriteria, sourceKind, importChecksum,
      ...(body.coverUrl ? { coverUrl: require('../core/plugin-cover.cjs').normalize(body.coverUrl) } : {}),
      ...(body.appWindow != null ? { appWindow: require('../core/app-window-sizing').normalize(body.appWindow) } : {}),
      importWarnings, unsupportedComponents, inputs, setup, workflow, ui,
      ...(icon ? { icon } : {}), ...(author ? { author } : {}),
      ...(resources.length ? { resources } : {}), ...(entrypoints ? { entrypoints: { ...entrypoints } } : {}),
    };
  }

  return { normalizeBody, normalizeInstallSetup, slug };
}

module.exports = { KEY, VERSION, create };
