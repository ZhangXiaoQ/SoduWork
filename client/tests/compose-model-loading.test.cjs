'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-compose-model-picker.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  let owner = 'hub-a/device/user-a', agent = 'pi', location = 'local';
  const requests = [], listeners = new Map(), notices = [];
  const element = () => ({ style: {}, dataset: {}, innerHTML: '', textContent: '',
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {}, addEventListener(name, listener) { this[name] = listener; } });
  const nodes = { cpModelBtn: element(), cpModelPop: element(), cpModelName: element(), wrap: element() };
  function request(kind) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    requests.push({ kind, owner, agent, location, resolve, reject }); return promise;
  }
  const bridge = { runtimeModels: () => request('native'), onModelsChanged: fn => { listeners.set('models-changed', fn); return () => listeners.delete('models-changed'); } };
  const context = vm.createContext({
    document: { getElementById: id => nodes[id] || null, querySelector: () => nodes.wrap },
    SoduWorkAPI: { taskStorageKey: () => owner, myModels: () => request('managed') },
    ComposeRuntime: { value: () => agent, location: () => location, catalog: () => [
      { id: 'pi', modelMode: 'managed' }, { id: 'qwen', modelMode: 'managed' },
      { id: 'codex', modelMode: 'account' },
    ] },
    SoduWorkI18n: {
      translateText(value) {
        return {
          'OpenAI 兼容（通用）': 'OpenAI compatible (general)',
          'OpenAI 兼容（个人）': 'OpenAI compatible (personal)',
          '自己的额度': 'Personal quota',
        }[value] || value;
      },
      translateNode() {},
    },
    addEventListener: (name, listener) => listeners.set(name, listener),
  });
  context.window = context;
  vm.runInContext(source, context);
  const picker = context.ComposeModelPicker;
  return { picker, requests, nodes, notices, changed: () => listeners.get('models-changed')?.(),
    start() { picker.bind({ api: () => bridge, onChange: value => notices.push(value) }); },
    remount() { for (const id of Object.keys(nodes)) nodes[id] = element(); },
    agent(value) { agent = value; }, location(value) { location = value; },
    owner(value, event = 'soduwork-data-scope-changed') { owner = value; if (event) listeners.get(event)?.(); },
    reply(index, name) {
      const row = requests[index];
      row.resolve(row.kind === 'native' ? { ok: true, models: [{ id: name, label: name }] }
        : { usable: [{ name, label: name }], defaultModels: { [row.agent]: name } });
    },
    choose(name, native = false) {
      const selector = native ? '[data-native-model]' : '[data-model]';
      nodes.cpModelPop.click({ stopPropagation() {}, target: {
        closest: value => value === selector ? { getAttribute: () => name } : null,
      } });
    },
    effort(index) {
      nodes.cpModelPop.input({ target: { value: String(index), matches: selector => selector === '[data-effort-slider]' } });
    },
  };
}

test('cold composer redraws share the first delayed request and ready waits for that response', async () => {
  const f = fixture(); f.start();
  const original = f.picker.refresh();
  let ready = false;
  const sendReady = f.picker.ready().then(value => { ready = true; return value; });
  for (let i = 0; i < 20; i++) assert.equal(f.picker.refresh(), original);
  await tick(); assert.equal(ready, false); assert.equal(f.requests.length, 1);
  f.reply(0, 'first-default'); assert.equal(await sendReady, true);
  assert.equal(f.picker.value().modelName, 'first-default');
  for (let i = 0; i < 5; i++) await f.picker.refresh();
  assert.equal(f.requests.length, 1, 'completed directory remains cached');
});

test('managed picker shows protocol and warns on an incompatible selected default without silently replacing it', async () => {
  const f = fixture(); f.start();
  f.requests[0].resolve({ usable: [
    { name: 'anthropic-fixture', providerKind: 'anthropic' },
    { name: 'openai-fixture', providerKind: 'openai-compat' },
  ], defaultModels: { pi: 'anthropic-fixture' } });
  await f.picker.ready();
  assert.equal(f.picker.value().modelName, 'anthropic-fixture');
  assert.match(f.nodes.cpModelPop.innerHTML, /Anthropic/);
  assert.match(f.nodes.cpModelPop.innerHTML, /role="note">企业模型对话通道只支持 OpenAI/);
  f.choose('openai-fixture');
  assert.equal(f.picker.value().modelName, 'openai-fixture');
  assert.match(f.nodes.cpModelPop.innerHTML, /role="note">企业模型/);
});

test('binding after preference paint reuses the pending directory and a new draft refreshes completed data', async () => {
  const f = fixture();
  const painted = f.picker.refresh();
  f.start();
  const ready = f.picker.ready();
  assert.equal(f.picker.refresh(), painted);
  assert.equal(f.requests.length, 1, 'mount must not restart the first request');
  f.reply(0, 'first-default'); await ready;
  assert.equal(f.picker.value().modelName, 'first-default');
  f.remount(); f.start();
  assert.equal(f.requests.length, 2, 'a later draft sees updated model settings');
  f.reply(1, 'updated-default'); await f.picker.ready();
  assert.equal(f.picker.value().modelName, 'updated-default');
});

test('force refresh supersedes a pending request and existing ready follows only the new generation', async () => {
  const f = fixture(); f.start();
  let ready = false;
  const sendReady = f.picker.ready().then(() => { ready = true; });
  const forced = f.picker.refresh(true);
  assert.equal(f.picker.refresh(), forced); assert.equal(f.requests.length, 2);
  f.reply(0, 'stale-default'); await tick();
  assert.equal(ready, false); assert.equal(f.picker.value().modelName, '');
  f.reply(1, 'fresh-default'); await sendReady;
  assert.equal(f.picker.value().modelName, 'fresh-default');
});

test('first native Codex binding starts discovery even if preference paint ran before the bridge existed', async () => {
  const f = fixture(); f.agent('codex');
  const painted = f.picker.refresh();
  assert.equal(f.requests.length, 0);
  f.start();
  assert.equal(f.requests.length, 1);
  f.reply(0, 'native-after-bind'); await painted; await f.picker.ready();
  assert.match(f.nodes.cpModelPop.innerHTML, /data-native-list/);
  assert.doesNotMatch(f.nodes.cpModelPop.innerHTML, /data-native-model=/);
  f.choose('native-after-bind', true);
  assert.equal(f.nodes.cpModelName.textContent, 'native-after-bind');
});

test('a late pre-force response cannot overwrite the displayed refreshed directory', async () => {
  const f = fixture(); f.start(); const forced = f.picker.refresh(true);
  f.reply(1, 'fresh-default'); await forced;
  f.reply(0, 'stale-default'); await tick();
  assert.equal(f.picker.value().modelName, 'fresh-default');
  assert.equal(f.nodes.cpModelName.textContent, 'fresh-default');
});

test('switching Agent isolates pending requests and ready follows the selected runtime', async () => {
  const f = fixture(); f.start(); const ready = f.picker.ready();
  f.agent('qwen'); f.picker.refresh();
  assert.deepEqual(f.requests.map(row => row.agent), ['pi', 'qwen']);
  f.reply(1, 'qwen-default'); await ready;
  f.reply(0, 'pi-old'); await tick();
  assert.equal(f.picker.value().modelName, 'qwen-default');
  f.agent('pi'); const back = f.picker.refresh();
  assert.equal(f.requests.length, 3);
  f.reply(2, 'pi-current'); await back;
  assert.equal(f.picker.value().modelName, 'pi-current');
});

test('account or Hub changes discard prior selections and reject old responses', async () => {
  const f = fixture(); f.start(); f.reply(0, 'account-a-model'); await f.picker.ready();
  assert.equal(f.picker.value().modelName, 'account-a-model');
  const oldRefresh = f.picker.refresh(true);
  f.owner('hub-a/device/user-b', 'soduwork-device-auth');
  assert.equal(f.requests.length, 3); assert.equal(f.picker.value().modelName, '');
  f.reply(1, 'account-a-late'); await oldRefresh;
  assert.equal(f.picker.value().modelName, '');
  f.reply(2, 'account-b-model'); await f.picker.ready();
  assert.equal(f.picker.value().modelName, 'account-b-model');
  f.owner('hub-b/device/user-b'); f.reply(3, 'hub-b-model'); await f.picker.ready();
  assert.equal(f.picker.value().modelName, 'hub-b-model');
});

test('ready detects an identity switch even when its notification has not arrived', async () => {
  const f = fixture(); f.start(); f.reply(0, 'previous-account'); await f.picker.ready();
  f.owner('hub-a/device/new-account', null);
  const ready = f.picker.ready(); assert.equal(f.requests.length, 2);
  f.reply(1, 'new-account'); await ready;
  assert.equal(f.picker.value().modelName, 'new-account');
});

test('local/cloud changes isolate in-flight directories and cloud account runtimes do not query local models', async () => {
  const f = fixture(); f.start(); f.location('cloud'); const cloud = f.picker.refresh();
  assert.deepEqual(f.requests.map(row => row.location), ['local', 'cloud']);
  f.reply(1, 'cloud-model'); await cloud; f.reply(0, 'local-old'); await tick();
  assert.equal(f.picker.value().modelName, 'cloud-model');
  f.agent('codex'); await f.picker.refresh(); assert.equal(f.requests.length, 2);
  assert.equal(f.nodes.cpModelBtn.disabled, true);
  f.location('local'); const native = f.picker.refresh(); assert.equal(f.requests[2].kind, 'native');
  f.reply(2, 'native-model'); await native;
  assert.equal(f.nodes.cpModelBtn.disabled, false);
});

test('failed or malformed managed lookups can retry and a failed refresh preserves a valid selection', async () => {
  const f = fixture(); f.start(); const first = f.picker.refresh();
  f.requests[0].reject(Error('isolated unavailable')); await first;
  const malformed = f.picker.refresh(); assert.equal(f.requests.length, 2);
  f.requests[1].resolve(null); await malformed;
  const retry = f.picker.refresh(); assert.equal(f.requests.length, 3);
  f.reply(2, 'retained-model'); await retry;
  const failedRefresh = f.picker.refresh(true);
  f.requests[3].reject(Error('isolated unavailable')); await failedRefresh;
  assert.equal(f.picker.value().modelName, 'retained-model');
});

test('native Codex discovery also coalesces, retries failures and keeps native selection', async () => {
  const f = fixture(); f.agent('codex'); f.start();
  const original = f.picker.refresh();
  for (let i = 0; i < 10; i++) assert.equal(f.picker.refresh(), original);
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve({ ok: false, reason: 'isolated unavailable' }); await original;
  const retried = f.picker.refresh(); assert.equal(f.requests.length, 2);
  f.reply(1, 'native-selection'); await retried; f.choose('native-selection', true);
  assert.equal(f.picker.value().modelName, 'native-selection');
  await f.picker.refresh(); assert.equal(f.requests.length, 2);
});

test('Codex slider defaults to medium, preserves supported choices and never borrows another model capabilities', async () => {
  const f = fixture(); f.agent('codex'); f.start();
  const models = [
    { id: 'full', label: 'Full', reasoningLevels: ['ultra', 'low', 'medium', 'high'], defaultReasoning: 'low' },
    { id: 'limited', label: 'Limited', reasoningLevels: ['medium', 'high'], defaultReasoning: 'high' },
    { id: 'no-medium', label: 'No medium', reasoningLevels: ['low', 'xhigh'], defaultReasoning: 'xhigh' },
    { id: 'single', label: 'Single', reasoningLevels: ['low'], defaultReasoning: 'unknown' },
    { id: 'empty', label: 'Empty', reasoningLevels: [], defaultReasoning: 'high' },
  ];
  f.requests[0].resolve({ ok: true, models }); await f.picker.ready();
  assert.equal(f.picker.value().modelName, 'full', 'first available model is selected automatically');
  assert.equal(f.picker.value().reasoningEffort, 'medium', 'automatic selection is also a real medium effort');
  f.choose('full', true);
  assert.equal(f.picker.value().reasoningEffort, 'medium', 'explicit medium overrides model low default');
  f.effort(2); assert.equal(f.picker.value().reasoningEffort, 'high');
  f.choose('limited', true); assert.equal(f.picker.value().reasoningEffort, 'high');
  f.choose('full', true); f.effort(3);
  assert.equal(f.picker.value().reasoningEffort, 'ultra');
  f.choose('limited', true); assert.equal(f.picker.value().reasoningEffort, 'medium');
  f.choose('no-medium', true); assert.equal(f.picker.value().reasoningEffort, 'xhigh');
  f.choose('single', true); assert.equal(f.picker.value().reasoningEffort, 'low');
  f.choose('empty', true); assert.equal(f.picker.value().reasoningEffort, '');
  f.effort(0); assert.equal(f.picker.value().reasoningEffort, '', 'unsupported model cannot inherit union of levels');
  f.choose('full', true); f.effort(99); f.effort('invalid');
  assert.equal(f.picker.value().reasoningEffort, 'medium', 'invalid slider indices are ignored');
});

test('Codex refresh reconciles changed capabilities but a failed refresh preserves the user choice', async () => {
  const f = fixture(); f.agent('codex'); f.start();
  f.requests[0].resolve({ ok: true, models: [{ id: 'full', label: 'Full', reasoningLevels: ['medium', 'ultra'] }] });
  await f.picker.ready(); f.choose('full', true); f.effort(1);
  const failed = f.picker.refresh(true); f.requests[1].reject(Error('offline')); await failed;
  assert.equal(f.picker.value().reasoningEffort, 'ultra');
  const updated = f.picker.refresh(true);
  f.requests[2].resolve({ ok: true, models: [{ id: 'full', label: 'Full', reasoningLevels: ['low', 'medium'] }] });
  await updated; assert.equal(f.picker.value().reasoningEffort, 'medium');
  f.owner('hub-b/device/user-b');
  assert.equal(f.picker.value().reasoningEffort, '', 'account changes discard previous effort');
});

test('Codex honors an available catalog default and retains a valid manual selection on refresh', async () => {
  const f = fixture(); f.agent('codex'); f.start();
  const models = [
    {id:'first',label:'First',reasoningLevels:['medium','high']},
    {id:'preferred',label:'Preferred',reasoningLevels:['medium','high']},
  ];
  f.requests[0].resolve({ok:true,models,defaultModel:'preferred'}); await f.picker.ready();
  assert.equal(f.picker.value().modelName,'preferred');
  assert.equal(f.picker.value().reasoningEffort,'medium');
  f.choose('first',true); f.effort(1);
  const refreshed=f.picker.refresh(true);
  f.requests[1].resolve({ok:true,models,defaultModel:'preferred'}); await refreshed;
  assert.equal(f.picker.value().modelName,'first');
  assert.equal(f.picker.value().reasoningEffort,'high');
  const removed=f.picker.refresh(true);
  f.requests[2].resolve({ok:true,models:[models[1]],defaultModel:'missing'}); await removed;
  assert.equal(f.picker.value().modelName,'preferred','removed selections fall back to an actual available model');
});

test('managed model picker translates built-in provider and quota labels', async () => {
  const f = fixture(); f.start();
  f.requests[0].resolve({
    usable: [{ name: 'soduwork-prd-large', label: 'soduwork-prd-large',
      providerName: 'OpenAI 兼容（通用）', keyFrom: 'mine' }],
    defaultModels: { pi: 'soduwork-prd-large' },
  });
  await f.picker.ready();
  assert.match(f.nodes.cpModelPop.innerHTML, /OpenAI compatible \(general\) · Personal quota/);
  assert.doesNotMatch(f.nodes.cpModelPop.innerHTML, /OpenAI 兼容（通用）/);
  assert.doesNotMatch(f.nodes.cpModelPop.innerHTML, /自己的额度/);
});


test('model changes refresh an already-mounted composer, preserve its explicit choice and reject older replies', async () => {
  const f = fixture(); f.start(); f.reply(0, 'chosen'); await f.picker.ready(); f.choose('chosen');
  f.changed(); assert.equal(f.requests.length, 2);
  f.changed(); assert.equal(f.requests.length, 3);
  f.requests[2].resolve({ usable: [{name:'chosen',label:'Renamed choice'},{name:'new',label:'New model'}],defaultModels:{pi:'new'} });
  await f.picker.ready();
  assert.equal(f.picker.value().modelName, 'chosen'); assert.equal(f.picker.label(), 'Renamed choice');
  assert.match(f.nodes.cpModelPop.innerHTML, /New model/);
  f.reply(1, 'obsolete'); await tick();
  assert.equal(f.picker.value().modelName, 'chosen'); assert.equal(f.picker.label(), 'Renamed choice');
});
