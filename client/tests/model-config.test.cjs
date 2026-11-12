'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const fsNode = require('node:fs');
const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

async function fetchDeclaredModel(metadata) {
  return require('../main/pi-session/model-config').fetchModel(
    { hub: 'https://hub.example.test', clientId: 'device-1', session: 'device-session' },
    'managed-alias', 8000,
    async () => new Response(JSON.stringify({ ok: true, key: 'fixture', model: 'managed-alias', ...metadata }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }),
    false, 'harness2');
}

test('Hub reasoning declarations survive model normalization and the runner boundary', async () => {
  const { create } = require('../main/agent-runtime/runner-config.cjs');
  for (const declaration of [
    { thinkingMode: 'always', thinkingAlwaysOn: true },
    { thinkingMode: 'always' },
    { thinkingMode: 'controllable', thinkingAlwaysOn: false },
    { thinkingMode: 'controllable' },
    { thinkingMode: 'none', thinkingAlwaysOn: false },
    { reasoning: true, thinkingAlwaysOn: true },
  ]) {
    const result = await fetchDeclaredModel({ ...declaration, thinkingFormat: 'zai',
      supportsReasoningEffort: true, thinkingLevelMap: { low: 'low', high: 'high' } });
    assert.equal(result.ok, true);
    assert.equal(result.model.reasoning, declaration.thinkingMode !== 'none');
    const runner = create(result.model, 'harness2').llm;
    for (const model of [result.model, runner]) {
      assert.equal(model.thinkingMode, declaration.thinkingMode);
      assert.equal(model.thinkingAlwaysOn, declaration.thinkingAlwaysOn);
      assert.equal(Object.hasOwn(model, 'thinkingMode'), Object.hasOwn(declaration, 'thinkingMode'));
      assert.equal(Object.hasOwn(model, 'thinkingAlwaysOn'), Object.hasOwn(declaration, 'thinkingAlwaysOn'));
      assert.equal(Object.hasOwn(model, 'thinkingLevel'), false);
    }
    if (declaration.thinkingMode === 'always' || declaration.thinkingAlwaysOn === true) {
      assert.equal(result.model.thinkingLevelMap.off, null);
      assert.equal(runner.thinkingLevelMap.off, null);
    } else if (declaration.thinkingMode === 'controllable') {
      assert.equal(Object.hasOwn(result.model.thinkingLevelMap, 'off'), false);
      assert.equal(Object.hasOwn(runner.thinkingLevelMap, 'off'), false);
    } else {
      assert.equal(Object.hasOwn(runner, 'reasoning'), false);
    }
  }
});

test('Hub model metadata does not invent thinking policy or accept malformed declarations', async () => {
  const ordinary = await fetchDeclaredModel({ reasoning: false });
  assert.equal(ordinary.ok, true);
  assert.equal(ordinary.model.reasoning, false);
  for (const field of ['thinkingMode', 'thinkingAlwaysOn', 'thinkingLevel']) {
    assert.equal(Object.hasOwn(ordinary.model, field), false, field);
  }
  for (const invalid of [null, '', 'AUTO', 'controllable ', 1, {}, []]) {
    const result = await fetchDeclaredModel({ thinkingMode: invalid, thinkingAlwaysOn: invalid,
      thinkingLevel: invalid });
    assert.equal(result.ok, true);
    for (const field of ['thinkingMode', 'thinkingAlwaysOn', 'thinkingLevel']) {
      assert.equal(Object.hasOwn(result.model, field), false, field);
    }
  }
});

test('Hub explicit thinking level remains explicit through the runner boundary', async () => {
  const { create } = require('../main/agent-runtime/runner-config.cjs');
  for (const thinkingLevel of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const result = await fetchDeclaredModel({ thinkingMode: 'controllable', thinkingAlwaysOn: false,
      thinkingFormat: 'zai', thinkingLevel });
    assert.equal(result.ok, true);
    assert.equal(result.model.thinkingLevel, thinkingLevel);
    assert.equal(create(result.model, 'harness2').llm.thinkingLevel, thinkingLevel);
  }
});

test('模型中心支持个人地址覆盖与任意自定义服务', () => {
  const panel = read('components', 'panels', 'panels-models.js');
  const api = read('api.js');
  assert.match(panel, /添加模型服务/);
  assert.match(panel, /data-purl=/);
  assert.match(panel, /data-pname=/);
  assert.match(panel, /OpenAI 兼容/);
  assert.match(panel, /本地服务无需密钥/);
  assert.match(panel, /providers, models: _mdMyModels, keys: _mdKeyEdits/);
  assert.match(api, /async saveMyModels\(body\)[\s\S]*?jfetch\('\/my-models', \{ method: 'PUT', body: JSON\.stringify\(body \|\| \{\}\)/);
});

test('saving personal models preserves provider overrides, custom services, and key removal', async () => {
  const values = new Map(), calls = [];
  const response = { ok: true, providers: [{ id: 'custom-local', hasKey: false }] };
  const window = { dispatchEvent() {}, soduWorkAPI: {
    getHubConnection: async () => ({ ok: true, hub: 'https://hub.example.test', editable: true }),
    deviceAuthBootstrap: async () => ({ ok: true, stored: true, clientId: 'device-1',
      user: { id: 'alice' }, session: 'fixture-session', expiresIn: 1800 }),
  } };
  vm.runInNewContext(read('api.js'), {
    window, User: { id: 'device-1', name: 'Fixture' }, navigator: { platform: 'test' },
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    fetch: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(response)); },
    URL, URLSearchParams, Response, AbortController, CustomEvent: class {},
    console: { log() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  }, { filename: 'api.js' });
  const api = window.SoduWorkAPI;
  await api.registerClient();
  const body = {
    providers: [
      { id: 'company-provider', baseUrl: 'https://personal.example.test/v1' },
      { id: 'custom-local', name: 'Local service', baseUrl: 'http://127.0.0.1:12345/v1', kind: 'openai-compat', personal: true, authMode: 'none' },
    ],
    models: [{ name: 'custom-model', providerId: 'custom-local', label: 'Custom model' }],
    keys: { 'company-provider': null, 'custom-local': '' },
    expectedRevision: 7,
  };
  assert.deepEqual(JSON.parse(JSON.stringify(await api.saveMyModels(body))), response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hub.example.test/api/v1/my-models');
  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(calls[0].options.headers.Authorization, 'Device fixture-session');
  assert.deepEqual(JSON.parse(calls[0].options.body), body);
});

test('模型配置保留就地真实探测与组织地址恢复能力', () => {
  const panel = read('components', 'panels', 'panels-models.js');
  assert.match(panel, /保存并测试/);
  assert.match(panel, /SoduWorkAPI\.testMyModel/);
  assert.match(panel, /恢复组织默认地址/);
  assert.match(panel, /连接设置/);
  assert.match(panel, /访问凭据/);
  assert.match(panel, /模型清单/);
});

test('额度耗尽时历史会话仍可使用本地模型元数据打开', async t => {
  const modelConfig = require('../main/pi-session/model-config');
  const rootDir = fsNode.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-quota-'));
  t.after(() => fsNode.rmSync(rootDir, { recursive: true, force: true }));
  const app = { getPath: () => rootDir };
  modelConfig.writeModels(path.join(rootDir, 'pi-agent'), {
    baseUrl: 'https://hub.example.test/api/v1/ai-proxy/v1', id: 'saved-model', label: 'Saved model',
    input: ['text'], contextWindow: 128000, maxOutputTokens: 4096,
  });
  const result = await modelConfig.fetchModel(
    { hub: 'https://hub.example.test', clientId: 'device-1', session: 'device-session' },
    'saved-model', 8000,
    async () => new Response(JSON.stringify({ detail: {
      code: 'TOKEN_QUOTA_EXCEEDED', quota: { enabled: true, exceeded: true },
    } }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    false, 'pi', { app, allowHistorical: true });
  assert.equal(result.ok, true);
  assert.equal(result.historical, true);
  assert.equal(result.model.id, 'saved-model');
  assert.equal(result.model.key, 'history-only');
  const denied = await modelConfig.fetchModel(
    { hub: 'https://hub.example.test', clientId: 'device-1', session: 'device-session' },
    'saved-model', 8000,
    async () => new Response(JSON.stringify({ detail: {
      code: 'TOKEN_QUOTA_EXCEEDED', quota: { enabled: true, exceeded: true },
    } }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'TOKEN_QUOTA_EXCEEDED');
});
