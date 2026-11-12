'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function fixture(decision = 'full') {
  const window = { screenX: 10, screenY: 20 }, context = { window };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/access-controls.js'), 'utf8'), context);
  const error = { hidden: true, classList: { toggle() {} } };
  const card = { dataset: { permissionRef: 'chat-a' }, isConnected: true, hidden: false,
    setAttribute() {}, querySelector: () => error, querySelectorAll: () => [button] };
  const button = { dataset: { uiValue: decision, permissionRequest: 'request-a', permissionRevision: '2', accessRevision: '3' },
    disabled: false, closest: () => card, getBoundingClientRect: () => ({ left: 5, top: 8, width: 60, height: 30 }) };
  return { controls: window.AccessControls, button, card, error };
}
test('command approval offers three decisions and no session-grant entry', () => {
  const f = fixture(); const request = { requestId: 'command-a', policyRevision: 2,
    action: 'command.execute', tool: 'bash', arguments: { command: 'echo sample' } };
  const html = f.controls.render(request, value => String(value ?? ''), { ref: 'chat-a', fullRevision: 3 });
  assert.match(html, /允许运行命令？/); assert.match(html, /echo sample/);
  assert.match(html, /data-ui-value="full"[^>]*data-access-revision="3"[^>]*>始终允许/);
  assert.deepEqual([...html.matchAll(/data-ui-value="([^"]+)"/g)].map(row => row[1]), ['deny', 'once', 'full']);
  assert.match(html, /role="group"/);
  assert.doesNotMatch(html, /data-ui-value="session"|记住这条命令|记住同一目标/);
  assert.doesNotMatch(f.controls.render(request, String), /data-ui-value="full"/);
});
test('full access uses the versioned session change API rather than granting a tool reply', async () => {
  const f = fixture(); let calls = 0;
  const api = { answerUi() { assert.fail('full is not a tool approval decision'); },
    async setAccessMode(ref, mode, revision, options) {
      calls++; assert.equal(ref, 'chat-a'); assert.equal(mode, 'full'); assert.equal(revision, 3);
      assert.equal(options.anchor.screenX, 15); assert.equal(options.anchor.screenY, 28);
      assert.equal(f.button.disabled, true); return { ok: true, effective: 'current-turn' };
    } };
  assert.equal((await f.controls.answer(f.button, api, 'chat-a')).ok, true);
  assert.equal(calls, 1); assert.equal(f.card.hidden, true);
});
test('cancelled or failed full access preserves the pending tool and re-enables all choices', async () => {
  for (const response of [{ ok: false, cancelled: true }, { ok: false, reason: 'stale revision' }]) {
    const f = fixture(); const api = { setAccessMode: async () => response };
    await f.controls.answer(f.button, api, 'chat-a');
    assert.equal(f.card.hidden, false); assert.equal(f.button.disabled, false);
    assert.equal(f.card.dataset.answerPending, 'false'); assert.equal(f.error.hidden, !!response.cancelled);
  }
  const f = fixture(); await f.controls.answer(f.button, { setAccessMode: async () => { throw Error('offline'); } }, 'chat-a');
  assert.equal(f.card.hidden, false); assert.equal(f.button.disabled, false); assert.equal(f.error.hidden, false);
});
test('next-turn changes retain current approval, while stale chats and duplicate clicks cannot submit', async () => {
  const f = fixture(); let resolve, calls = 0;
  const api = { setAccessMode: () => { calls++; return new Promise(r => { resolve = r; }); } };
  assert.equal((await f.controls.answer(f.button, api, 'chat-b')).ok, false); assert.equal(calls, 0);
  const pending = f.controls.answer(f.button, api, 'chat-a');
  assert.equal((await f.controls.answer(f.button, api, 'chat-a')).ok, false); assert.equal(calls, 1);
  resolve({ ok: true, effective: 'next-turn' }); await pending;
  assert.equal(f.card.hidden, false); assert.equal(f.button.disabled, false);
  assert.equal(f.error.textContent, '新权限将在下一轮生效。');
});
test('allow once still sends the exact pending request and does not change session permissions', async () => {
  const f = fixture('once'); let received;
  await f.controls.answer(f.button, { answerUi: async (ref, reply) => { received = { ref, ...reply }; return { ok: true }; },
    setAccessMode() { assert.fail('ordinary reply must not escalate'); } }, 'chat-a');
  assert.equal(received.ref, 'chat-a'); assert.equal(received.decision, 'once');
  assert.equal(received.requestId, 'request-a'); assert.equal(received.policyRevision, 2);
});
