'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const sources = [
  '无法迁移 Harness² 会话上下文；原历史已保留，请重试',
  '所选 Linux 执行机的 CPU 缺少 sse4_2 指令集，无法运行 OpenCode。请选择兼容的执行机，或由管理员调整该虚拟机的 CPU 配置。',
  'Harness² 核心及独立执行器 0.2.0（随 SoduWork 升级），无需安装其他底座。',
  '模型上下文超限；完整历史已保留，将通过现有会话接续机制恢复。',
  '轻快，原生支持技能（Agent Skills，和 Claude Code 同一套标准）。',
  'Apache-2.0 开源的 Codex Agent Harness；通过 ACP 接入，使用 SoduWork 分配的企业模型。',
  '开源编码 Agent；按需安装，使用企业模型执行代码与命令。',
  'OpenAI 官方 CLI。用它自己的账号（ChatGPT 登录或 OpenAI key），不吃 SoduWork 这边的模型配置。',
  'Apache-2.0 开源编码 Agent；通过 ACP 接入，支持公司 OpenAI 兼容模型。',
  'MIT 开源的 DeepSeek 官方 Agent 框架（dsh）；通过 ACP 接入，支持公司 OpenAI 兼容模型或个人 DeepSeek Key。',
  'Harness² 文本推演后独立执行工具，增加耗时与模型用量',
  '每轮先运行 Google Research Harness² 的七阶段文本推演，再由 SoduWork 的 Harness² 独立执行器调用工具；无需其他底座，推演会增加耗时与模型用量。',
  '② 验证 Harness² 独立执行器；不运行推演，会使用所选模型额度，最多 3 分钟。',
  '收到执行回复，但尚未确认 Harness² 独立执行器完整结束，请点「测一下」重试。',
  '上次测试尚未验证当前执行组件；请点「测一下」重新验证。',
  '通了 —— Harness² 0.2.0 的独立执行器已验证；此测试不包含推演。',
  'Harness² 核心及独立执行器随 SoduWork 升级，无需安装其他底座；停用会保留任务记录，点「启用」可重新启用。',
  '停用这台机器上的 Harness²，新任务不能再派给它；保留内置文件和任务记录。点「启用」可重新启用。',
];

function loadI18n(withoutChineseCatalog = false) {
  const storage = new Map();
  const listeners = new Map();
  const context = vm.createContext({
    Intl, Map, Set, Object, JSON, console,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    document: { readyState: 'loading', documentElement: { dataset: {} }, querySelectorAll: () => [] },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    addEventListener: (name, callback) => listeners.set(name, callback),
    dispatchEvent: event => listeners.get(event.type)?.(event),
    soduWorkAPI: { setLocale() {}, onLocaleChange: callback => listeners.set('ipc-locale', callback) },
  });
  vm.runInContext('window = globalThis; let cfg = {}; const saveCfg = () => {};', context);
  {
    for (const file of JSON.parse(fs.readFileSync(path.join(root, 'core/locales/manifest.json'), 'utf8'))) {
      if (withoutChineseCatalog && file.startsWith('zh-CN')) continue;
      vm.runInContext(fs.readFileSync(path.join(root, 'core/locales', file), 'utf8'), context);
    }
    vm.runInContext(fs.readFileSync(path.join(root, 'core/i18n.js'), 'utf8'), context);
  }
  return context.SoduWorkI18n;
}

test('agent management card blurbs are localized in every shipped non-Chinese locale', () => {
  const i18n = loadI18n();
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    i18n.setLocale(locale, { persist: false, broadcast: false });
    for (const source of sources) {
      const translated = i18n.translateText(source);
      assert.notEqual(translated, source, `${locale} missing Agent blurb: ${source}`);
      assert.ok(translated.length > 0);
    }
  }
});

test('finite Harness2 backend diagnostics localize stages, phases, details and HTTP status in every locale', () => {
  const i18n = loadI18n();
  const backend = fs.readFileSync(path.join(root, '../hub-backend/app/services/harness2_errors.py'), 'utf8');
  const finite = name => {
    const body = new RegExp(name + ' = \\{([\\s\\S]*?)\\n\\}').exec(backend)?.[1];
    assert.ok(body, name);
    return Object.fromEntries([...body.matchAll(/"([^"]+)": "([^"]+)"/g)].map(match => [match[1], match[2]]));
  };
  const stages = finite('_STAGES'), phases = finite('_PHASES'), details = finite('_DETAILS');
  const complete = (stage, phase, detail) => 'Google Harness² ' + stage + (phase ? '（' + phase + '）' : '') + '失败：' + detail;
  for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN']) {
    i18n.setLocale(locale, { persist: false, broadcast: false });
    const verify = (text, keys) => {
      const translated = i18n.translateText(text);
      if (locale === 'zh-CN') assert.equal(translated, text);
      else assert.notEqual(translated, text, locale + ': ' + text);
      for (const key of keys) assert.ok(translated.includes(i18n.t(key)), locale + ': missing ' + key);
      assert.doesNotMatch(translated, /\{(?:stage|phase|detail|status)\}/);
      return translated;
    };
    for (const detail of Object.values(details)) {
      verify(complete(stages.refine, phases['dom1.a1'], detail),
        ['harness2.stage.' + stages.refine, 'harness2.phase.' + phases['dom1.a1'], 'harness2.detail.' + detail]);
    }
    for (const stage of Object.values(stages)) {
      verify(complete(stage, '', details.model_timeout), ['harness2.stage.' + stage, 'harness2.detail.' + details.model_timeout]);
      for (const phase of Object.values(phases)) {
        verify(complete(stage, phase, details.model_timeout),
          ['harness2.stage.' + stage, 'harness2.phase.' + phase, 'harness2.detail.' + details.model_timeout]);
      }
    }
    for (const status of [401, 403, 404, 429, 503]) {
      const chinese = status === 503 ? details.model_http : new RegExp(status + ': "([^"]+)"').exec(backend)?.[1];
      assert.ok(chinese);
      const text = complete(stages.refine, phases['dom1.a1'], '模型请求失败（HTTP ' + status + '）：' + chinese);
      assert.match(verify(text, ['harness2.detail.' + chinese]), new RegExp('HTTP ' + status));
    }
  }
});

test('Harness2 diagnostic templates preserve unknown provider text and bound nested translation', () => {
  const i18n = loadI18n();
  const prefix = 'Google Harness² 推演执行方法（提出任务方法改进）失败：';
  const known = '模型连接或响应超时；请检查所选模型服务、网络和代理设置后重试。';
  const unchanged = [
    prefix + '服务返回：请保留我的原始输出。',
    prefix + '保存',
    'Google Harness² 用户自定义阶段失败：' + known,
    'Google Harness² 推演执行方法（GLM3.5flash <tool>）失败：' + known,
    prefix + '模型请求失败（HTTP 429）：原始 provider body',
    prefix + '模型请求失败（HTTP 429）：模型请求失败（HTTP 429）：' + known,
    prefix + 'x'.repeat(513),
    'My model/tool output: ' + prefix + known,
  ];
  for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN']) {
    i18n.setLocale(locale, { persist: false, broadcast: false });
    for (const text of unchanged) assert.equal(i18n.translateText(text), text, locale + ': ' + text);
  }
});

test('public desktop locales localize Harness2 diagnostics with or without the Chinese catalog', () => {
  const text = 'Google Harness² 推演执行方法（提出任务方法改进）失败：模型连接或响应超时；请检查所选模型服务、网络和代理设置后重试。';
  for (const withoutChineseCatalog of [false, true]) {
    const i18n = loadI18n(withoutChineseCatalog);
    i18n.setLocale('en-US', { persist: false, broadcast: false });
    assert.equal(i18n.translateText(text), 'Google Harness²: Execution planning failed (Proposing task-specific improvements). The model connection or response timed out. Check the selected model service, network, and proxy settings, then retry.');
    i18n.setLocale('zh-CN', { persist: false, broadcast: false });
    assert.equal(i18n.translateText(text), text);
  }
});
