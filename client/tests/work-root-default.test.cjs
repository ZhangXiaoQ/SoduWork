'use strict';

/* Default and native-picker workspace preferences survive renderer reloads. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('main process preserves the public default workspace directory', t => {
  const main = read('main.js');
  const handler = main.match(/^ipcMain\.handle\('work-root-default', \(\) => \{[\s\S]*?^\}\);/m)?.[0];
  assert.ok(handler, '主进程必须注册默认工作目录 IPC');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-default-work-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const id of ['stage', 'internal', 'cn', 'global']) {
    let callback;
    const profile = require('../main/distribution.cjs').current();
    vm.runInNewContext(handler, { _distribution: { current: () => profile },
      ipcMain: { handle: (_, fn) => { callback = fn; } },
      require: name => name === 'os' ? { homedir: () => home } : require(name) });
    const expected = path.join(home, 'SoduWork');
    assert.equal(callback(), expected);
    assert.equal(fs.statSync(expected).isDirectory(), true);
  }
  assert.match(read('preload.js'), /getDefaultWorkRoot:.*work-root-default/);
});

function storage(initial = {}) {
  return Object.assign({
    getItem(key) { return Object.hasOwn(this, key) ? this[key] : null; },
    setItem(key, value) { this[key] = String(value); },
    removeItem(key) { delete this[key]; },
  }, initial);
}

function settingsFixture(options = {}) {
  const localStorage = options.storage || storage();
  const listeners = {};
  const elements = {
    workRootInput: { value: '', readOnly: false },
    workRootSave: {
      disabled: false, textContent: '选择文件夹',
      addEventListener(type, listener) { listeners[type] = listener; },
    },
    workRootNote: { textContent: 'Choose a local workspace' },
  };
  const defaultRoot = 'C:\\Users\\fixture\\SoduWork';
  const calls = [];
  const saves = [];
  const picker = async request => {
    calls.push(request);
    return options.pick ? options.pick(request) : { ok: false, canceled: true };
  };
  const saveWorkdir = async dir => {
    saves.push({ dir, storedRoot: localStorage.getItem('soduwork_work_root') });
    return options.save ? options.save(dir) : { ok: true, dir };
  };
  const bridge = {
    getDefaultWorkRoot: async () => defaultRoot,
    [options.legacy ? 'piSession' : 'conversationSession']: { pickWorkdir: picker, saveWorkdir },
  };
  const sandbox = {
    localStorage, soduWorkAPI: bridge, console,
    document: {
      readyState: 'loading',
      getElementById: id => elements[id] || null,
      addEventListener() {},
    },
    petSay() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('components/settings/settings.js'), sandbox);
  sandbox._bindWorkRoot();
  return {
    ...elements, localStorage, calls, saves, defaultRoot,
    click: () => listeners.click(),
    root: () => sandbox.workRoot(),
    ready: () => new Promise(resolve => setImmediate(resolve)),
  };
}

test('settings provides a read-only path and opens the system folder picker', () => {
  const html = read('desk.html');
  const input = html.match(/<input\b[^>]*\bid="workRootInput"[^>]*>/)?.[0];
  assert.ok(input, 'workspace path field exists');
  assert.match(input, /\breadonly(?:\s|=|>)/i);
  assert.match(html, /id="workRootSave"[^>]*>选择文件夹<\/button>/);
});

test('an unset workspace gets its default while reopening retains the saved preference', async () => {
  const first = settingsFixture();
  await first.ready();
  assert.equal(first.root(), first.defaultRoot);
  assert.equal(first.workRootInput.value, first.defaultRoot);
  first.localStorage.setItem('soduwork_work_root', 'D:\\My Work\\采购资料');
  const reopened = settingsFixture({ storage: first.localStorage });
  await reopened.ready();
  assert.equal(reopened.root(), 'D:\\My Work\\采购资料');
  assert.equal(reopened.workRootInput.value, 'D:\\My Work\\采购资料');
});

test('selecting a folder saves the native result and survives reopening', async () => {
  for (const legacy of [false, true]) {
    const previous = 'C:\\Users\\fixture\\SoduWork';
    const selected = 'D:\\Team Work\\报价资料';
    const fixture = settingsFixture({
      legacy, storage: storage({ soduwork_work_root: previous }),
      pick: async () => ({ ok: true, dir: selected }),
    });
    await fixture.click();
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].defaultPath, previous);
    assert.equal(fixture.calls[0].persist, false);
    assert.deepEqual(fixture.saves, [{ dir: selected, storedRoot: selected }]);
    assert.equal(fixture.root(), selected);
    assert.equal(fixture.workRootInput.value, selected);
    assert.equal(fixture.workRootSave.disabled, false);
    const reopened = settingsFixture({ storage: fixture.localStorage });
    await reopened.ready();
    assert.equal(reopened.workRootInput.value, selected);
  }
});

test('canceling the native picker keeps the saved path and visible field', async () => {
  const previous = 'D:\\Existing Work';
  const fixture = settingsFixture({ storage: storage({ soduwork_work_root: previous }) });
  await fixture.click();
  assert.equal(fixture.saves.length, 0);
  assert.equal(fixture.root(), previous);
  assert.equal(fixture.workRootInput.value, previous);
  assert.equal(fixture.workRootSave.disabled, false);
});

test('a pending folder selection accepts one click and re-enables after completion', async () => {
  let resolveSelection;
  const selection = new Promise(resolve => { resolveSelection = resolve; });
  const fixture = settingsFixture({
    storage: storage({ soduwork_work_root: 'D:\\Existing Work' }),
    pick: () => selection,
  });
  const first = fixture.click();
  await fixture.click();
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.workRootSave.disabled, true);
  resolveSelection({ ok: true, dir: 'E:\\New Work' });
  await first;
  assert.equal(fixture.root(), 'E:\\New Work');
  assert.equal(fixture.workRootSave.disabled, false);
});

test('picker rejection, reported failure and empty result keep the saved preference', async () => {
  for (const pick of [
    async () => { throw Error('Directory permission denied'); },
    async () => ({ ok: false, reason: 'Directory permission denied' }),
    async () => ({ ok: true, dir: '' }),
  ]) {
    const fixture = settingsFixture({
      storage: storage({ soduwork_work_root: 'D:\\Existing Work' }), pick,
    });
    const previousNote = fixture.workRootNote.textContent;
    await fixture.click();
    assert.equal(fixture.saves.length, 0);
    assert.equal(fixture.root(), 'D:\\Existing Work');
    assert.equal(fixture.workRootInput.value, 'D:\\Existing Work');
    assert.equal(fixture.workRootSave.disabled, false);
    assert.notEqual(fixture.workRootNote.textContent, previousNote);
    assert.doesNotMatch(fixture.workRootNote.textContent, /工作目录已保存|已设为|记下了/);
  }
});

test('storage failure leaves the old renderer preference visible and permits retry', async () => {
  const localStorage = storage({ soduwork_work_root: 'D:\\Existing Work' });
  const fixture = settingsFixture({
    storage: localStorage, pick: async () => ({ ok: true, dir: 'E:\\New Work' }),
  });
  localStorage.setItem = () => { throw Error('Storage write failed'); };
  const previousNote = fixture.workRootNote.textContent;
  await fixture.click();
  assert.equal(fixture.saves.length, 0);
  assert.equal(fixture.root(), 'D:\\Existing Work');
  assert.equal(fixture.workRootInput.value, 'D:\\Existing Work');
  assert.equal(fixture.workRootSave.disabled, false);
  assert.notEqual(fixture.workRootNote.textContent, previousNote);
  assert.doesNotMatch(fixture.workRootNote.textContent, /工作目录已保存|已设为|记下了/);
});

test('main-process save failure rolls back the renderer preference and visible path', async () => {
  for (const save of [
    async () => ({ ok: false, reason: 'Unable to persist workspace' }),
    async () => { throw Error('Unable to persist workspace'); },
  ]) {
    const fixture = settingsFixture({
      storage: storage({ soduwork_work_root: 'D:\\Existing Work' }),
      pick: async () => ({ ok: true, dir: 'E:\\New Work' }), save,
    });
    const previousNote = fixture.workRootNote.textContent;
    await fixture.click();
    assert.deepEqual(fixture.saves, [{ dir: 'E:\\New Work', storedRoot: 'E:\\New Work' }]);
    assert.equal(fixture.root(), 'D:\\Existing Work');
    assert.equal(fixture.workRootInput.value, 'D:\\Existing Work');
    assert.equal(fixture.workRootSave.disabled, false);
    assert.notEqual(fixture.workRootNote.textContent, previousNote);
    assert.doesNotMatch(fixture.workRootNote.textContent, /工作目录已保存|已设为|记下了/);
    const reopened = settingsFixture({ storage: fixture.localStorage });
    await reopened.ready();
    assert.equal(reopened.root(), 'D:\\Existing Work');
  }
});

test('success is shown only after main-process persistence completes', async () => {
  let finishSave;
  const pendingSave = new Promise(resolve => { finishSave = resolve; });
  const fixture = settingsFixture({
    storage: storage({ soduwork_work_root: 'D:\\Existing Work' }),
    pick: async () => ({ ok: true, dir: 'E:\\New Work' }),
    save: () => pendingSave,
  });
  const first = fixture.click();
  await fixture.ready();
  assert.equal(fixture.saves.length, 1);
  assert.equal(fixture.workRootSave.disabled, true);
  assert.equal(fixture.workRootInput.value, 'D:\\Existing Work');
  assert.doesNotMatch(fixture.workRootNote.textContent, /工作目录已保存/);
  await fixture.click();
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.saves.length, 1);
  finishSave({ ok: true, dir: 'E:\\New Work' });
  await first;
  assert.equal(fixture.workRootInput.value, 'E:\\New Work');
  assert.match(fixture.workRootNote.textContent, /工作目录已保存/);
  assert.equal(fixture.workRootSave.disabled, false);
});

test('drive roots and UNC share roots retain their native trailing separator', async () => {
  for (const selected of ['D:\\', '\\\\server\\share\\']) {
    const fixture = settingsFixture({
      storage: storage({ soduwork_work_root: 'C:\\Users\\fixture\\SoduWork' }),
      pick: async () => ({ ok: true, dir: selected }),
    });
    await fixture.click();
    assert.equal(fixture.root(), selected);
    assert.equal(fixture.workRootInput.value, selected);
    const reopened = settingsFixture({ storage: fixture.localStorage });
    await reopened.ready();
    assert.equal(reopened.root(), selected);
  }
});
