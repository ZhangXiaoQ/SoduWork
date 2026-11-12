'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const sheet = require('../components/panels/plugin-input-sheet');
const mention = require('../components/panels/chat-plugin-mention');

test('plain text payload uses composer content without guessing unrelated or ambiguous fields', () => {
  const field = {key: 'text', type: 'textarea', label: '待整理文本', required: true};
  const seed = '今天完成登录页；明天测试资料库；下载失败问题由小王排查。';
  const plan = mention.prepareConversationInputs([field], seed, {});
  assert.equal(plan.ready, true);
  assert.equal(plan.values.text, seed);
  assert.deepEqual(plan.inferredKeys, ['text']);
  assert.equal(mention.prepareConversationInputs([field], '', {}).ready, false);
  assert.equal(mention.prepareConversationInputs([field], seed, {text: 'Explicit input'}).values.text, 'Explicit input');
  const ambiguous = mention.prepareConversationInputs([field,
    {...field, key: 'content', label: 'Other content'}], seed, {});
  assert.equal(ambiguous.ready, false);
  assert.deepEqual(ambiguous.inferredKeys, []);
  const other = mention.prepareConversationInputs([{...field, key: 'recipientText', label: 'Recipient'}], seed, {});
  assert.equal(other.ready, false);
});

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const inputs = [{
  key: 'goal', type: 'textarea', label: '\u9700\u6c42\u80cc\u666f', required: true,
  description: '\u8bf4\u6e05\u95ee\u9898\u548c\u7528\u6237', placeholder: '\u8bf7\u8f93\u5165',
}, {
  key: 'priority', type: 'enum', label: '\u4f18\u5148\u7ea7', default: 'high',
  options: [{ value: 'normal', label: '\u666e\u901a' }, { value: 'high', label: '\u9ad8' }],
}, {
  key: 'needReview', type: 'bool', label: '\u9700\u8981\u5ba1\u9605', default: true,
}];

test('real plugin resolution submits inferred original goal in the workflow payload', async () => {
  const vm = require('node:vm');
  const node = () => ({ value: '', dataset: {}, style: {}, children: [], events: {}, classList: { add() {}, remove() {} }, setAttribute() {}, removeAttribute() {},
    insertBefore(child) { this.children.unshift(child); }, appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; },
    addEventListener(name, handler) { this.events[name] = handler; },
    removeEventListener() {}, focus() {}, remove() {}, contains() { return false; } });
  const window = { addEventListener() {}, removeEventListener() {} };
  const document = { createElement: node, addEventListener() {}, removeEventListener() {} };
  const scope = { window, document, console, Event: class {}, setTimeout, clearTimeout };
  for (const file of ['compose-candidate-navigation.js', 'chat-plugin-mention-model.js', 'chat-plugin-mention.js'])
    vm.runInNewContext(read('components', 'panels', file), scope);
  const raw = '  /需求 #1\r\n' + '完整正文'.repeat(450) + '\n  ';
  const picker = window.ChatPluginMention.create({ input: node(), host: node(), catalog: async () => ({ items: [{
    pluginId: 'local:fixture', name: '原文插件', key: 'fixture', personal: true, enabled: true, installed: true,
    conversationUse: { available: true }, inputs: [inputs[0]],
  }] }) });
  await picker.select('local:fixture', () => true, { keepText: true });
  const prepared = await picker.resolve('chat', '', raw, { attachmentNames: ['input.txt'] });
  assert.equal(prepared.text, raw);
  assert.equal(prepared.items[0].inputValues.goal, raw);
  const textPicker = window.ChatPluginMention.create({ input: node(), host: node(), catalog: async () => ({ items: [{
    pluginId: 'local:text', name: '文本整理', key: 'text', personal: true, enabled: true, installed: true,
    conversationUse: {available: true}, inputs: [{key: 'text', label: '待整理文本', type: 'textarea', required: true}],
  }] }) });
  await textPicker.select('local:text', () => true, {keepText: true});
  const textPrepared = await textPicker.resolve('chat', '', raw);
  assert.equal(textPrepared.text, raw);
  assert.equal(textPrepared.items[0].inputValues.text, raw);
  textPicker.destroy();
  const changed = raw + '后续修改';
  assert.equal((await picker.resolve('chat', '', changed)).items[0].inputValues.goal, changed,
    'an inferred goal from a refused send must not replace the edited original on retry');
  window.PluginInputSheet = { open(options) {
    options.onApply('', { ...options.initialValues, roomId: 'room-a' });
    return true;
  }, close() {} };
  const requiredPicker = window.ChatPluginMention.create({ input: node(), host: node(), catalog: async () => ({ items: [{
    pluginId: 'local:required', name: '补充参数插件', key: 'required', personal: true, enabled: true, installed: true,
    conversationUse: { available: true }, inputs: [inputs[0], { key: 'roomId', label: '会议室', type: 'text', required: true }],
  }] }) });
  await requiredPicker.select('local:required', () => true, { keepText: true });
  const first = await requiredPicker.resolve('chat', '', raw);
  assert.equal(first.items[0].inputValues.goal, raw);
  assert.equal(first.items[0].inputValues.roomId, 'room-a');
  const revised = await requiredPicker.resolve('chat', '', changed);
  assert.equal(revised.items[0].inputValues.goal, changed,
    'filling a missing room must not freeze the inferred goal hidden from that form');
  assert.equal(revised.items[0].inputValues.roomId, 'room-a');
  requiredPicker.destroy();
  let openedForm;
  window.PluginInputSheet.open = options => { openedForm = options; return true; };
  const fullHost = node();
  const fullPicker = window.ChatPluginMention.create({ input: node(), host: fullHost, inputText: () => raw,
    inputContext: () => ({ attachmentNames: ['folded.txt'] }), catalog: async () => ({ items: [{
      pluginId: 'local:full', name: '完整参数插件', key: 'full', personal: true, enabled: true, installed: true,
      conversationUse: { available: true }, inputs: [inputs[0]],
    }] }) });
  await fullPicker.select('local:full', () => true, { keepText: true });
  fullHost.children[0].children[0].events.click();
  assert.equal(openedForm.seed, raw);
  assert.equal(openedForm.initialValues.goal, raw, 'chip configuration must infer from the folded original, not an attachment placeholder');
  openedForm.onApply('', openedForm.initialValues);
  const full = await fullPicker.resolve('chat', '', raw);
  assert.equal(full.items[0].inputValues.goal, raw);
  assert.equal(full.text, raw);
  fullPicker.destroy();
  picker.destroy();
});

test('declarative plugin fields become a governed work form and a reviewable prompt', () => {
  const fields = sheet.normalizeInputs(inputs);
  assert.deepEqual(fields.map((field) => field.type), ['textarea', 'select', 'boolean']);
  assert.equal(sheet.readiness(fields, { goal: '', priority: 'high', needReview: true }).ready, false);
  assert.equal(sheet.readiness(fields, { goal: '\u4f18\u5316\u767b\u5f55', priority: 'high', needReview: true }).ready, true);
  const prompt = sheet.promptFrom({ name: '\u9700\u6c42\u6c89\u6dc0', inputs }, {
    goal: '\u4f18\u5316\u767b\u5f55', priority: 'high', needReview: true,
  }, '\u7528\u6237\u53cd\u9988\u63d0\u4ea4\u65e0\u54cd\u5e94');
  assert.match(prompt, /\u9700\u6c42\u6c89\u6dc0/);
  assert.match(prompt, /\u7528\u6237\u53cd\u9988\u63d0\u4ea4\u65e0\u54cd\u5e94/);
  assert.match(prompt, /\u4f18\u5316\u767b\u5f55/);
  assert.match(prompt, /\u9700\u8981\u5ba1\u9605/);
});

test('conversation plugins infer a natural-language goal and only ask for truly missing fields', () => {
  const goalOnly = mention.prepareConversationInputs(inputs, '\u4f18\u5316\u767b\u5f55\u9875', {});
  assert.equal(goalOnly.ready, true);
  assert.equal(goalOnly.values.goal, '\u4f18\u5316\u767b\u5f55\u9875');
  assert.deepEqual(goalOnly.inferredKeys, ['goal']);

  const withAudience = mention.prepareConversationInputs(inputs.concat([{
    key: 'audience', type: 'text', label: '\u76ee\u6807\u53d7\u4f17', required: true,
  }]), '\u4f18\u5316\u767b\u5f55\u9875', {});
  assert.equal(withAudience.ready, false);
  assert.deepEqual(withAudience.missing.map((field) => field.key), ['audience']);

  const withDate = mention.prepareConversationInputs([{
    key: 'runDate', type: 'text', label: '\u6267\u884c\u65e5\u671f', required: true,
  }], '\u5e2e\u6211\u5b89\u6392\u5de1\u68c0', {});
  assert.equal(withDate.ready, false);
});

test('compound goal fields and attachment-only requests do not open a redundant form', () => {
  const businessObjective = [{
    key: 'businessObjective', type: 'textarea', label: '\u4e1a\u52a1\u8bc9\u6c42', required: true,
  }];
  const fromText = mention.prepareConversationInputs(
    businessObjective, '\u6839\u636e\u4ee5\u4e0b\u9700\u6c42\u6784\u5efa\u4e00\u4e2a\u667a\u80fd\u4f53', {});
  assert.equal(fromText.ready, true);
  assert.equal(fromText.values.businessObjective,
    '\u6839\u636e\u4ee5\u4e0b\u9700\u6c42\u6784\u5efa\u4e00\u4e2a\u667a\u80fd\u4f53');

  const fromAttachment = mention.prepareConversationInputs(
    businessObjective, '', {}, { attachmentNames: ['\u4ea7\u54c1\u9700\u6c42.txt'] });
  assert.equal(fromAttachment.ready, true);
  assert.match(fromAttachment.values.businessObjective, /\u4ea7\u54c1\u9700\u6c42\.txt/);

  const dateStillMissing = mention.prepareConversationInputs([{
    key: 'runDate', type: 'text', label: '\u6267\u884c\u65e5\u671f', required: true,
  }], '', {}, { attachmentNames: ['\u4ea7\u54c1\u9700\u6c42.txt'] });
  assert.equal(dateStillMissing.ready, false);
});

test('explicit follow-up references use the bounded prior result as the plugin input', () => {
  const prior = 'Report result:\n- revenue grew 18%\n- follow-up: notify the owner';
  const plan = mention.prepareConversationInputs(
    [{ key: 'content', type: 'textarea', label: 'Content', required: true }],
    'Send the previous result to the delivery plugin',
    {}, { priorConversationText: prior },
  );
  assert.equal(plan.ready, true);
  assert.equal(plan.values.content, prior);
  assert.deepEqual(plan.inferredKeys, ['content']);
  const pronoun = mention.prepareConversationInputs(
    [{ key: 'content', type: 'textarea', label: 'Content', required: true }],
    'Send it to the delivery plugin', {}, { priorConversationText: prior },
  );
  assert.equal(pronoun.values.content, prior);

  const ordinary = mention.prepareConversationInputs(
    [{ key: 'content', type: 'textarea', label: 'Content', required: true }],
    'Send a new status update', {}, { priorConversationText: prior },
  );
  assert.equal(ordinary.values.content, 'Send a new status update');
  const ordinaryThis = mention.prepareConversationInputs(
    [{ key: 'content', type: 'textarea', label: 'Content', required: true }],
    'This status update is new', {}, { priorConversationText: prior },
  );
  assert.equal(ordinaryThis.values.content, 'This status update is new');
  const ordinaryResult = mention.prepareConversationInputs(
    [{ key: 'content', type: 'textarea', label: 'Content', required: true }],
    'Create a new result summary', {}, { priorConversationText: prior },
  );
  assert.equal(ordinaryResult.values.content, 'Create a new result summary');
  const ordinaryAbove = mention.prepareConversationInputs(
    [{ key: 'content', type: 'textarea', label: 'Content', required: true }],
    'Create an above average summary', {}, { priorConversationText: prior },
  );
  assert.equal(ordinaryAbove.values.content, 'Create an above average summary');
  const chineseFollowUp = mention.prepareConversationInputs(
    [{ key: 'content', type: 'textarea', label: 'Content', required: true }],
    '把上一轮结果交给发布插件', {}, { priorConversationText: prior },
  );
  assert.equal(chineseFollowUp.values.content, prior);
  const chineseOrdinary = mention.prepareConversationInputs(
    [{ key: 'content', type: 'textarea', label: 'Content', required: true }],
    '创建内容用于官网', {}, { priorConversationText: prior },
  );
  assert.equal(chineseOrdinary.values.content, '创建内容用于官网');
});

test('conversation stays concise unless the user configured extra plugin parameters', () => {
  const plugin = { pluginId: 'requirements', name: '\u9700\u6c42\u6574\u7406', inputs };
  assert.equal(mention.preparedConversationText('\u4f18\u5316\u767b\u5f55', [plugin], new Map()), '\u4f18\u5316\u767b\u5f55');
  const values = new Map([['requirements', {
    goal: '\u4f18\u5316\u767b\u5f55', priority: 'high', needReview: true,
  }]]);
  const text = mention.preparedConversationText('\u4f18\u5316\u767b\u5f55', [plugin], values);
  assert.doesNotMatch(text, /\u9700\u6c42\u80cc\u666f/);
  assert.match(text, /\u4f18\u5148\u7ea7\uff1ahigh/);
  assert.match(text, /\u9700\u8981\u5ba1\u9605\uff1a\u662f/);
});

test('plugin goal and conversation body preserve the complete original request without normalization', () => {
  const text = '  #1 原文\r\n' + '正文'.repeat(900) + '\n  ';
  const plugin = { pluginId: 'requirements', name: '需求', inputs: [inputs[0]] };
  const plan = mention.prepareConversationInputs(plugin.inputs, text, {});
  assert.equal(plan.values.goal, text);
  assert.equal(mention.preparedConversationText(text, [plugin], new Map([['requirements', plan.values]])), text);
});

test('enterprise catalog preserves safe inputs and makes their labels searchable', () => {
  const item = mention.normalizeCatalog({ items: [{
    pluginId: 'requirements', key: 'requirements',
    qualifiedKey: 'org:org-a/requirements', scope: 'organization',
    name: 'Requirement intake',
    installed: true, organizationWide: true, inputs,
  }] })[0];
  assert.equal(item.inputs.length, 3);
  assert.equal(item.inputs[1].type, 'select');
  assert.match(item.searchText, /\u9700\u6c42\u80cc\u666f/);
  assert.match(item.searchText, /\u4f18\u5148\u7ea7/);
  assert.match(item.searchText, /org:org-a\/requirements/);
});

test('plugin work form is registered in every employee window and never accepts arbitrary HTML', () => {
  const index = read('index.html');
  const desk = read('desk.html');
  const source = read('components', 'panels', 'plugin-input-sheet.js');
  const picker = read('components', 'panels', 'chat-plugin-mention.js');
  const catalog = read('..', 'hub-backend', 'app', 'services', 'plugin_catalog.py');
  [index, desk].forEach((html) => {
    assert.match(html, /plugin-input-sheet\.css/);
    assert.match(html, /plugin-input-sheet\.js/);
  });
  assert.match(source, /PluginUIHost\.mount/);
  assert.match(source, /onApply\(prompt, values, plugin\)/);
  assert.match(source, /typeof o\.onChange === 'function'/);
  assert.doesNotMatch(source, /plugin\.html|plugin\.javascript|eval\(|new Function/);
  assert.match(picker, /openPluginForm\(item\)/);
  assert.match(picker, /requestMissingInputs\(item, originalText, inputContext\)/);
  assert.doesNotMatch(picker, /if \(!openPluginForm\(item\)\) input\.focus\(\)/);
  assert.match(catalog, /"inputs": _public_inputs\(manifest\)/);
});

test('structured plugin inputs live on conversation and task work surfaces, not compact controls', () => {
  const picker = read('components', 'panels', 'chat-plugin-mention.js');
  const chat = read('components', 'panels', 'panels-chat.js');
  const compose = read('components', 'panels', 'panels-compose.js');
  const forward = read('components', 'panels', 'panels-forward-plugin.js');
  const options = read('components', 'panels', 'panels-forward-options.js');
  const detail = read('components', 'requirements', 'requirements-detail.js');
  const desk = read('desk.html');
  assert.match(picker, /formHost/);
  assert.match(picker, /surfaceContext:\s*'conversation'/);
  assert.match(picker, /pluginBuilderAction/);
  assert.match(picker, /openConversationInstall/);
  assert.match(chat, /formHost:\s*\(\)\s*=>\s*el\.querySelector\('\.nchat-draft'\)/);
  assert.match(compose, /formHost:\s*\(\)\s*=>\s*p\.querySelector\('\.cp-mid'\)/);
  assert.match(chat + compose, /inputContext:[\s\S]*attachmentNames/);
  assert.match(chat, /priorConversationText/);
  assert.match(chat, /Previous (?:assistant|tool) result/);
  assert.match(chat + compose, /onChange:[\s\S]*_pluginMention(?:\?\.|\.)refresh/);
  assert.doesNotMatch(forward, /data-fwp-input|function _fwpField/);
  assert.match(options, /window\.TaskPluginInput/);
  assert.match(options, /ChatPluginMention\.prepareConversationInputs/);
  assert.match(options, /if \(plan\.ready\) \{[\s\S]*await _tpiStart/);
  assert.match(options, /inputs:\s*plan\.missing/);
  assert.match(options, /TaskPluginInput\.start\(tid/);
  assert.match(options, /surfaceContext:\s*'task'/);
  assert.match(options, /const _tpiDrafts = Object\.create\(null\)/);
  assert.match(options, /onChange:\s*\(values\)\s*=>\s*\{/);
  assert.match(options, /delete _tpiDrafts\[id\]/);
  assert.match(options, /document\.querySelector\('\.rq-detail-content'\)/);
  assert.match(detail, /TaskPluginInput\?\.resume\(id\)/);
  assert.equal((desk.match(/<script src="components\/panels\/plugin-input-sheet\.js"><\/script>/g) || []).length, 1);
});

test('plugin authoring belongs to the client while admin governs immutable submissions', () => {
  const maker = read('components', 'panels', 'panels-plugin-maker.js');
  const admin = read('..', 'hub-frontend', 'src', 'screens', 'PluginAuthoring.jsx');
  const guide = read('..', 'docs', 'plugin-authoring.md');
  assert.match(maker, /Client-first plugin authoring/);
  assert.match(maker, /entrypoints:\s*\{ \.\.\.entrypoints \}/);
  assert.match(maker, /data-entrypoint="conversation"/);
  assert.match(maker, /kind === 'workflow'[\s\S]*conversation: false/);
  assert.match(admin, /author-boundary/);
  assert.match(admin, /tx\("制作 → 治理"\)/);
  assert.doesNotMatch(admin, /PluginFormDesigner|author-setup-preview/);
  assert.match(guide, /\u7ba1\u7406\u7aef\u4e0d\u662f\u63d2\u4ef6\u7f16\u8f91\u5668/);
});
