const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const next = force === undefined ? !this.values.has(name) : Boolean(force);
    if (next) this.values.add(name); else this.values.delete(name);
    return next;
  }
}

class FakeElement {
  constructor() {
    this.attributes = new Map();
    this.children = [];
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.innerHTML = '';
    this.value = '';
    this.selectionStart = 0;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, listener) {
    const rows = this.listeners.get(type) || [];
    rows.push(listener);
    this.listeners.set(type, rows);
  }
  emit(type, event = {}) {
    (this.listeners.get(type) || []).forEach((listener) =>
      listener(Object.assign({ target: this, isComposing: false }, event)));
  }
  contains(target) { return target === this || this.children.includes(target); }
  setSelectionRange(start) { this.selectionStart = start; }
  focus() {}
}

test('typing # opens a truthful Skill palette before and after catalog loading', () => {
  const document = {
    createElement: () => new FakeElement(),
    addEventListener() {},
  };
  const localStorage = { getItem: () => null, setItem() {} };
  const context = { window: {}, document, localStorage };
  vm.runInNewContext(read('components', 'panels', 'panels-compose-skills.js'), context);

  const host = new FakeElement();
  const input = new FakeElement();
  const picker = context.window.ComposeSkills.create({ host, input });
  const menu = host.children[1];

  input.value = '#';
  input.selectionStart = 1;
  input.emit('input');
  assert.equal(menu.classList.contains('show'), true);
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  assert.match(menu.innerHTML, /正在加载团队 Skill/);

  picker.setItems([{
    name: 'weekly-summary', description: '整理团队周报',
    installed: true, selectable: true,
  }]);
  assert.match(menu.innerHTML, /#weekly-summary/);
  assert.doesNotMatch(menu.innerHTML, /正在加载团队 Skill/);
});

test('Skill rows inherit the matching plugin icon from the catalog', () => {
  const context = { window: {} };
  vm.runInNewContext(read('components', 'panels', 'panels-compose-skills.js'), context);
  const rows = context.window.ComposeSkills.withPluginIcons([
    { name: 'weekly-summary', selectable: true },
  ], [{ key: 'team-tools', icon: 'data:image/png;base64,icon', capabilities: { skills: ['weekly-summary'] } }]);
  assert.equal(rows[0].icon, 'data:image/png;base64,icon');
});

test('a slow plugin catalog cannot keep the Skill palette in its loading state', () => {
  const compose = read('components', 'panels', 'panels-compose.js');
  const chat = read('components', 'panels', 'panels-chat.js');
  const composeItems = compose.indexOf('_skillPicker.setItems(_skills)');
  const composeEnrich = compose.indexOf('_enrichSkillIcons(_skills, requestKey)');
  assert.ok(composeItems >= 0 && composeEnrich > composeItems,
    'new-chat capabilities must paint Skill rows before optional plugin icons');
  const composeLoader = compose.slice(compose.indexOf('function _loadCapabilities'),
    compose.indexOf('function _renderCapabilities'));
  assert.doesNotMatch(composeLoader, /await\s+SoduWorkAPI\.pluginCatalog\(\)/,
    'new-chat capability loading must not await the plugin catalog');
  const chatItems = chat.indexOf('picker.setItems(skills)');
  const chatEnrich = chat.indexOf('SoduWorkAPI.pluginCatalog()', chatItems);
  assert.ok(chatItems >= 0 && chatEnrich > chatItems,
    'active-chat capabilities must paint Skill rows before optional plugin icons');
  const chatLoader = chat.slice(chat.indexOf('async function _loadChatSkills'),
    chat.indexOf('function _bind(el)'));
  assert.doesNotMatch(chatLoader, /await\s+SoduWorkAPI\.pluginCatalog\(\)/,
    'active-chat capability loading must not await the plugin catalog');
  assert.match(compose, /CAPABILITY_REQUEST_TIMEOUT_MS = 12000/);
  assert.match(chat, /setTimeout\(\(\) => reject\(new Error\('capability timeout'\)\), 12000\)/);
});

test('new conversation exposes local capabilities as selectable session controls', () => {
  const service = read('main', 'conversation', 'capabilities.js');
  const compose = read('components', 'panels', 'panels-compose.js');
  const capUi = read('components', 'panels', 'panels-compose-capabilities.js');
  const composerCss = read('components', 'panels', 'work-composer.css');
  const skillCss = read('components', 'panels', 'panels-compose-skills.css');

  assert.match(service, /const policyAllowed = true/);
  assert.doesNotMatch(service, /const policyAllowed = !!policy\.ok/);
  assert.match(compose,
    /grant:\s*global\.soduWorkAPI[\s\S]*?global\.soduWorkAPI\.setRunnerCapability/,
    'the high-risk capability grant must use the Electron bridge exposed by preload');
  assert.doesNotMatch(compose, /SoduWorkAPI\.setRunnerCapability/,
    'the HTTP API facade cannot grant trusted local device capabilities');
  assert.match(capUi, /data-capability-retry/);
  assert.match(compose, /api\.capabilities\(\{ force: force === true,[\s\S]*?executionLocation:/);
  assert.match(compose, /if \(!result \|\| result\.ok === false\) \{[\s\S]*?_skillPicker\.setError[\s\S]*?return;\s*\}/,
    'service errors must reach the Skill picker before the branch returns');
  assert.match(capUi, /cp-cap-switch/);
  assert.match(composerCss, /\.wc-cap-pop \.cp-cap-switch/);
  // The 14-skill Chromium regression covers adaptive placement and final-row
  // access; this contract keeps CSS from forcing that popup below the window.
  const skillMenu = skillCss.match(/\.cp-skill-menu\{([^}]*)\}/)?.[1] || '';
  assert.match(skillMenu, /position:fixed/);
  assert.match(skillMenu, /max-height:360px;overflow:auto;overscroll-behavior:contain/);
  assert.doesNotMatch(skillCss, /\.compose-panel\[data-stage=['"]compose['"]\] \.cp-skill-menu\{[^}]*top:calc\(100%/);
});

test('foundation capability panel grants high-risk controls before selecting them', async () => {
  const context = { window: {} };
  vm.runInNewContext(
    read('components', 'panels', 'panels-compose-capabilities.js'), context);
  const ui = context.window.ComposeCapabilities;
  const items = [
    { id: 'browser', label: '浏览网页', selectable: true, description: '读取网页' },
    { id: 'computer', label: '操作电脑', selectable: true, grantRequired: true },
  ];
  const selected = new Set(['browser']);
  const list = { innerHTML: '' };
  const escapeHtml = (value) => String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;');

  assert.equal(ui.summary(items, selected, false), '1 项已启用');
  ui.render(list, items, selected, false, escapeHtml);
  assert.match(list.innerHTML, /data-capability="computer"/);
  assert.match(list.innerHTML, /需要本机授权/);

  const notices = [];
  let granted = '';
  const changed = await ui.toggle({
    id: 'computer', items, selected,
    grant: async (id, enabled) => {
      granted = id + ':' + enabled;
      return { ok: true };
    },
    say: (message) => notices.push(message),
  });
  assert.equal(changed, true);
  assert.equal(granted, 'computer:true');
  assert.equal(selected.has('computer'), true);
  assert.equal(items[1].grantRequired, false);
  assert.match(notices.join(' '), /高风险动作仍严格守界/);
});
