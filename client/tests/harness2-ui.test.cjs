'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const brand = require('../components/panels/agent-brand');
const route = require('../main/personal-plugin-agent-route.cjs');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const aliases = ['Google Harness²', 'harness2', 'harness²', 'harness-2', 'local:harness2'];

test('Harness² aliases identify the same runtime in cards and response attribution', () => {
  for (const alias of aliases) {
    assert.equal(brand.canonical(alias), 'harness2', alias);
    assert.match(brand.html(alias), /data-agent-brand="harness2"/);
  }
  assert.equal(brand.canonical('runner:office:harness2'), 'harness2');
  assert.equal(brand.canonical('custom-harness20'), 'custom');
  const parts = [];
  brand.transcript().before(parts, { agentId: 'harness2', runId: 'run-1' }, 'answer');
  assert.match(parts.join(''), /data-output-agent="harness2"/);
  assert.match(parts.join(''), /Google Harness²/);
  assert.match(brand.html('harness2'), />H2<\/span>/);
});

test('plugin routes normalize Harness² spellings only when the runtime is in the catalog', () => {
  const row = { id: 'harness2', displayName: 'Google Harness²' };
  const catalog = { runtime: id => id === 'harness2' ? row : null, runtimes: () => [row] };
  for (const alias of aliases) assert.equal(route.normalize(alias, catalog), 'local:harness2', alias);
  assert.equal(route.normalize('harness²', { runtime: () => null, runtimes: () => [] }), 'harness²');
  assert.equal(route.normalize('harness20', catalog), 'harness20');
});

function composerFixture(catalogAvailable = false) {
  const handlers = new Map(), elements = new Map(), probes = [];
  let created = 0, changed;
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      dataset: {}, attrs: {}, children: [], classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      setAttribute(key, value) { this.attrs[key] = String(value); }, removeAttribute() {}, querySelector: () => null,
      closest: () => null, append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
      addEventListener: (event, handler) => handlers.set(selector + ':' + event, handler),
    });
    return elements.get(selector);
  };
  const root = { querySelector: element, querySelectorAll: () => [], createElement: () => element('created:' + created++) };
  const rows = JSON.parse(source('../hub-backend/app/agent_catalog.json')).agents.filter(row => ['pi', 'harness2'].includes(row.id));
  const api = {
    runtimes: async () => {
      if (!catalogAvailable) throw Error('catalog temporarily unavailable');
      return { ok: true, runtimes: rows, availableRuntimes: rows, missing: [] };
    },
    onRuntimesChanged: handler => { changed = handler; return () => {}; },
    probe: async id => { probes.push(id); return { ok: id === 'pi' }; },
  };
  const context = { document: root, AgentBrand: brand, WorkComposer: { contextButton: () => '' },
    setTimeout, clearTimeout };
  context.window = context;
  vm.runInNewContext(source('components/panels/panels-compose-runtime.js'), context);
  context.ComposeRuntime.bind(root, { api: () => api });
  return { runtime: context.ComposeRuntime, api, probes, element,
    async catalogChanged() { changed(); for (let i = 0; i < 30; i++) await Promise.resolve(); },
    select: id => handlers.get('#cpRuntimePop:click')({ target: { closest: () => {
      const row = element(id); row.dataset.runtime = id; return row;
    } } }) };
}

test('failed catalog keeps Harness² discoverable for repair without offering it as a ready choice', async () => {
  const f = composerFixture();
  await f.runtime.ready();
  assert.doesNotMatch(f.runtime.controls(''), /data-runtime='harness2'/);
  assert.deepEqual(Array.from(f.runtime.catalog(), row => row.id), ['pi']);
  const missing = f.element('#cpRuntimeMissing');
  assert.ok(missing.children.some(row => row.dataset.runtimeMissing === 'harness2'));
  assert.match(missing.attrs['aria-label'], /Google Harness²/);
  assert.equal(f.element('#cpRuntimeMore').hidden, false);
});

test('health-projected Harness² still requires a current probe and returns after a component repair', async () => {
  const f = composerFixture(true);
  await f.runtime.ready();
  const html = f.runtime.controls('');
  assert.match(html, /data-runtime='harness2'/);
  assert.match(html, /Google Harness²/);
  await f.select('harness2');
  assert.equal(f.probes.at(-1), 'harness2');
  assert.equal(f.runtime.value(), 'pi', 'unavailable runtime must not replace the ready selection');
  assert.doesNotMatch(f.runtime.controls(''), /data-runtime='harness2'/);
  assert.ok(f.element('#cpRuntimeMissing').children.some(row => row.dataset.runtimeMissing === 'harness2'));
  f.api.probe = async id => ({ ok: id === 'harness2' });
  await f.catalogChanged();
  assert.match(f.runtime.controls(''), /data-runtime='harness2'/);
  await f.select('harness2');
  assert.equal(f.runtime.value(), 'harness2');
  assert.equal(await f.runtime.ready(), true);
  assert.equal(f.runtime.goalSupported(), true);
  assert.equal(f.element('#cpRuntimeName').textContent, 'Google Harness²');
  const row = f.runtime.catalog().find(row => row.id === 'harness2');
  assert.equal(row.modelMode, 'managed');
  assert.match(row.summary, /Harness² 文本推演后独立执行工具/);
  assert.match(row.summary, /增加耗时与模型用量/);
  const catalog = JSON.parse(source('../hub-backend/app/agent_catalog.json'));
  const shared = catalog.agents.find(item => item.id === 'harness2');
  assert.equal(shared.summary, row.summary);
  assert.match(shared.install.blurb, /每轮先运行.*七阶段文本推演.*独立执行器调用工具/);
  assert.match(shared.install.blurb, /无需其他底座.*增加耗时与模型用量/);
});

test('Harness² management provides lifecycle actions while explaining its independent executor', () => {
  const context = { AgentBrand: brand, addEventListener() {}, esc: value => String(value || '') };
  context.window = context;
  vm.runInNewContext(source('components/panels/panels-agents.js'), context);
  const agent = { key: 'harness2', name: 'Google Harness²', modelPick: true, bundled: true,
    installed: false, version: '0.1.0' };
  const versionText = html => html.match(/class="ag-ver[^"]*"[^>]*>([^<]*)<\/span>/)?.[1];
  assert.equal(versionText(context._agRowHtml(agent)), '0.1.0');
  const bundledPi = { ...agent, key: 'pi', name: 'Pi' };
  assert.equal(versionText(context._agRowHtml(bundledPi)), '0.1.0 · 内置');
  context.fixtureAgents = [agent, bundledPi];
  vm.runInContext("_agData = { machines: [{ runnerId: 'local', scope: 'current-instance', agents: fixtureAgents }] }; _agOpen = 'local~harness2'", context);
  assert.equal(versionText(context._agDrawer()), '0.1.0');
  vm.runInContext("_agOpen = 'local~pi'", context);
  assert.equal(versionText(context._agDrawer()), '0.1.0 · 内置');
  assert.match(context._agRowHtml(agent), /data-ainstall="harness2"/);
  const details = context._agBodyHtml(agent, 'missing');
  assert.match(details, /核心/);
  assert.match(details, /独立执行器.*无需安装其他底座/);
  assert.doesNotMatch(details, /不需要单独安装、更新或卸载/);
  assert.doesNotMatch(details, /data-aunin=/);
  assert.match(context._agRowHtml({ ...agent, installed: true }), /data-aprobe="harness2"/);
  const installed = context._agBodyHtml({ ...agent, installed: true }, 'bad');
  assert.match(installed, /data-acheck="harness2"[^>]*>看看有没有新版/);
  assert.match(installed, /data-ainstall="harness2"[^>]*>重装 \/ 升到最新/);
  assert.match(installed, /data-aunin="harness2"[^>]*>卸载/);
  assert.match(installed, /核心.*随 SoduWork 升级/);
  assert.match(installed, /独立执行器随 SoduWork 升级/);
  vm.runInContext("_agConfirm = 'harness2'", context);
  const confirmation = context._agBodyHtml({ ...agent, installed: true }, 'ready');
  assert.match(confirmation, /停用.*Harness²/);
  assert.match(confirmation, /保留内置文件和任务记录/);
  assert.doesNotMatch(confirmation, /手上正在跑的活会失败/);
  vm.runInContext("_agJobs = { harness2: { state: 'running', action: 'install', lines: [] } }", context);
  const busy = context._agBodyHtml({ ...agent, installed: true }, 'ready');
  for (const attr of ['data-acheck', 'data-ainstall', 'data-aunin']) {
    assert.match(busy, new RegExp(attr + '="harness2" disabled'));
  }
  const pi = context._agBodyHtml({ ...agent, key: 'pi', name: 'Pi', installed: true }, 'ready');
  assert.doesNotMatch(pi, /data-aunin=/);
  const probeJob = { key: 'fixture-device~harness2', action: 'probe', state: 'running', lines: [] };
  const executionProbe = context._agJobHtml(probeJob);
  assert.match(executionProbe, /验证 Harness² 独立执行器/);
  assert.match(executionProbe, /不运行推演/);
  assert.match(executionProbe, /模型额度/);
  assert.match(executionProbe, /最多 3 分钟/);
  assert.doesNotMatch(executionProbe, /7 轮推演|10 分钟/);
  const otherProbe = context._agJobHtml({ ...probeJob, key: 'fixture-device~opencode' });
  assert.match(otherProbe, /几十秒/);
  assert.doesNotMatch(otherProbe, /7 轮推演/);
});

test('saved automation routing keys retain the readable Harness² identity', () => {
  const context = { _schAgents: [] };
  vm.runInNewContext(source('components/panels/panels-schedules-cards.js'), context);
  assert.equal(context._schCardAssignee('local:harness2'), 'Google Harness²');
  assert.equal(context._schCardAssignee('runner:office:harness2'), 'Google Harness²');
});
