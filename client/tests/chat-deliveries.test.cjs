'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '../components/panels/chat-deliveries.js'), 'utf8');

function helper(document, extra = {}) {
  const global = { addEventListener() {}, document, ...extra };
  vm.runInNewContext(code, { window: global, globalThis: global, URL, document });
  return global.ChatDeliveries;
}

test('cloud card does not paint a package receipt as a saved PC library item', async () => {
  const child = () => ({ textContent: '', hidden: false, dataset: {}, classList: { toggle() {} },
    setAttribute() {}, appendChild() {}, replaceWith() {}, replaceChildren() {}, querySelector: child });
  const retry = child(), card = { ...child(), dataset: {},
    querySelector: selector => selector === '[data-delivery-retry]' ? retry : child() };
  const document = { createElement: tag => tag === 'section' ? card : child(),
    createTextNode: text => ({ textContent: text }), querySelectorAll: () => [card] };
  const message = { dataset: {}, querySelector: () => null, querySelectorAll: () => [], appendChild() {} };
  let decorated = false, saves = 0;
  const root = { ownerDocument: document, querySelectorAll: selector => selector === '[data-delivery]'
    ? decorated ? [card] : [] : [message] };
  const api = {
    getTaskDelivery: async () => { throw Error('Package receipt is not a save receipt'); },
    syncTaskDelivery: async () => { throw Error('Package preparation is not a library save'); },
    getTaskLibraryDeliveryStatus: async (taskId, selected) => {
      assert.equal(taskId, 'cloud');
      assert.deepEqual({...selected}, {round: 1, executionRef: 'run'});
      return { ok: true, delivery: null, manifest: {id: 'immutable', revision: 'v1', files: [{ path: 'a.txt' }] } };
    },
    saveTaskLibraryDelivery: async (_taskId, selected) => {
      assert.deepEqual({...selected}, {round: 1, executionRef: 'run', deliveryId: 'immutable', revision: 'v1'});
      saves++; return { ok: true, delivery: { id: 'local-saved', files: [{ path: 'a.txt' }] } };
    },
  };
  const deliveries = helper(document, { SoduWorkAPI: api });
  const snapshot = { status: 'idle', cloudHandoff: { taskId: 'cloud' } };
  deliveries.decorate(root, [{ taskId: 'cloud', artifactId: 'a', name: 'a.txt', role: 'output', round: 1, sourceRef: 'run' }], 'ref', snapshot);
  decorated = true;
  deliveries.hydrate(root, { ref: 'ref', snapshot });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(retry.title, '保存到资料库');
  assert.equal(saves, 0);
  await deliveries.handle({ closest: selector => selector === '[data-delivery]' ? card
    : selector === '[data-delivery-retry]' ? retry : null }, {});
  assert.equal(saves, 1);
  assert.equal(retry.title, '已保存到资料库，点击查看');
});

test('cloud delivery keeps same-named files from different paths', () => {
  const deliveries = helper();
  const files = [
    { taskId: 'task-1', attachmentId: 'a', artifactId: 'task-output:a', relative: 'docs/README.md', name: 'README.md', role: 'output', round: 1 },
    { taskId: 'task-1', attachmentId: 'b', artifactId: 'task-output:b', relative: 'examples/README.md', name: 'README.md', role: 'output', round: 1 },
  ];
  const rows = deliveries._groupFiles(files, 'task-1');
  assert.equal(rows.length, 2);
  assert.deepEqual(Array.from(rows, row => String(row.relative)), ['docs/README.md', 'examples/README.md']);
});

test('settled local and cloud outputs render a delivery card without the unused continuation arrow', () => {
  for (const remote of [false, true]) {
    const child = () => ({ textContent: '', hidden: false, dataset: {}, classList: { toggle() {} },
      setAttribute() {}, appendChild() {}, replaceWith() {}, replaceChildren() {}, querySelector: child });
    const card = { ...child(), dataset: {}, querySelector: child }, appended = [];
    const document = { createElement: tag => tag === 'section' ? card : child(), createTextNode: text => ({ textContent: text }) };
    const message = { dataset: { deliveryCurrent: 'true' }, ownerDocument: document,
      querySelector: () => null, querySelectorAll: () => [], appendChild: value => appended.push(value) };
    const root = { ownerDocument: document, querySelectorAll: selector => selector === '[data-delivery]' ? [] : [message] };
    const taskId = remote ? 'cloud-task' : '';
    const file = { artifactId: 'fixture-result', name: 'index.html', title: 'Current result',
      primary: true, changedInTurn: true, kind: 'website', size: 128, role: 'output', taskId };
    const deliveries = helper(document);
    deliveries.decorate(root, [file], 'fixture-conversation', { status: 'idle',
      ...(remote ? { cloudHandoff: { taskId } } : {}) });
    assert.deepEqual(appended, [card]);
    assert.equal(card.className, 'ndelivery');
    assert.match(card.innerHTML, /data-delivery-retry/);
    assert.match(card.innerHTML, /保存到资料库/);
    assert.match(card.innerHTML, /<details class="ndelivery-files" open>/);
    assert.ok(!card.innerHTML.includes('data-delivery-continue'));
    assert.ok(!card.innerHTML.includes('M5 12h13m-5-5 5 5-5 5'));
    assert.ok(!card.innerHTML.includes(remote ? '在云端继续' : '继续会话'));
  }
});

test('cloud website preview rewrites runner loopback to the selected host', () => {
  const deliveries = helper();
  const snapshot = { cloudHandoff: { target: { host: 'runner.example.com' } } };
  assert.equal(
    deliveries._artifactUrlFor('http://localhost:4173/demo/', snapshot),
    'http://runner.example.com:4173/demo/',
  );
  assert.equal(deliveries._artifactUrlFor('http://localhost:4173/demo/'), '');
  assert.equal(deliveries._artifactUrlFor('javascript:alert(1)', snapshot), '');
});
