'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/client-auth/email-auth.js'), 'utf8');

function element(dataset = {}) {
  const listeners = new Map(), classes = new Set();
  const node = { dataset, value: '', textContent: '', className: '', hidden: false, disabled: false, checked: false,
    focus() {}, setAttribute() {}, appendChild() {}, addEventListener(name, callback) { listeners.set(name, callback); },
    fire(name) { return listeners.get(name)?.({ preventDefault() {} }); },
    classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name) || node.className.split(' ').includes(name); } } };
  return node;
}
function view() {
  let now = 1000, timerId = 0, hub = 'http://fixture.invalid', clientId = 'device-a', user = null;
  const timers = new Map();
  const addTimer = (callback, delay, interval = false) => {
    const id = ++timerId; timers.set(id, { callback, at: now + delay, delay, interval }); return id;
  };
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  async function advance(milliseconds) {
    const end = now + milliseconds;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; now = timer.at;
      if (timer.interval) timer.at += timer.delay; else timers.delete(id);
      timer.callback(); await flush();
    }
    now = end; await flush();
  }
  const nodes = new Map(), modes = ['emailCode', 'password', 'register', 'resetPassword'].map(authMode => element({ authMode }));
  const gate = element();
  gate.querySelector = selector => {
    const mode = /^\[data-auth-mode="(.*)"\]$/.exec(selector);
    if (mode) return modes.find(row => row.dataset.authMode === mode[1]);
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  };
  gate.querySelectorAll = selector => selector === '[data-auth-mode]' ? modes
    : selector === '[role="tab"]' ? modes.slice(0, 2) : [];
  const form = gate.querySelector('form'), submit = gate.querySelector('[type="submit"]');
  form.querySelectorAll = () => [...nodes.values()]; submit.querySelector = () => gate.querySelector('submit-label');
  const localeListeners = new Map();
  const calls = [], window = { AccountUI: { email: value => /^.+@.+\..+$/.test(value), code: value => /^\d{6}$/.test(value),
    check: value => value, error: error => error.message, bindPassword() {}, legal() {} } };
  window.addEventListener = (type, listener) => {
    if (!localeListeners.has(type)) localeListeners.set(type, new Set());
    localeListeners.get(type).add(listener);
  };
  window.removeEventListener = (type, listener) => localeListeners.get(type)?.delete(listener);
  window.dispatchEvent = event => { for (const listener of localeListeners.get(event.type) || []) listener(event); };
  const localeContext = { window, globalThis: window, console, localStorage: { getItem: () => 'zh-CN' },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } } };
  const localeDir = path.join(__dirname, '../core/locales');
  for (const file of JSON.parse(fs.readFileSync(path.join(localeDir, 'manifest.json'), 'utf8')))
    vm.runInNewContext(fs.readFileSync(path.join(localeDir, file), 'utf8'), localeContext);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../core/i18n.js'), 'utf8'), localeContext);
  window.SoduWorkI18n.setLocale('zh-CN', { persist: false, broadcast: false });
  const api = { hubBase: () => hub, clientAuthSnapshot: () => ({ clientId, user }),
    async clientLogin(payload) { calls.push({ kind: 'legacy', payload }); return { ok: true, user: { id: 'test' } }; },
    async clientAccountAction(action, payload) { calls.push({ kind: action, payload }); return { ok: true, user: { id: 'test' } }; } };
  let retries = 0;
  const context = { window, document: { createElement: () => element() },
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, delay) => addTimer(fn, delay), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => addTimer(fn, delay, true), clearInterval: id => timers.delete(id) };
  vm.runInNewContext(source, context);
  const mounted = window.EmailAuth.mount(gate, { api: () => api, retry() { retries++; }, success() {} });
  return { gate, mounted, calls, api, window, context, advance, flush, timers, retries: () => retries,
    setLocale(locale) { window.SoduWorkI18n.setLocale(locale, { persist: false, broadcast: false }); },
    switchHub() { hub = 'http://second.invalid'; }, switchDevice() { clientId = 'device-b'; }, switchUser() { user = { id: 'second-user' }; },
    mode: name => modes.find(row => row.dataset.authMode === name).fire('click') };
}

test('login labels stay in one locale and repaint after a language change', () => {
  const f = view();
  f.mounted.setPolicy({ mailReady: true, allowSelfRegistration: true });
  f.setLocale('en-US');
  assert.equal(f.gate.querySelector('.ac-account-label').textContent, 'Account');
  assert.equal(f.gate.querySelector('.ac-password-label').textContent, 'Password');
  assert.equal(f.gate.querySelector('[data-password-toggle]').textContent, 'Show');
  assert.equal(f.gate.querySelector('.soduwork-auth-submit span').textContent, 'Sign in');
  f.setLocale('zh-CN');
  assert.equal(f.gate.querySelector('.ac-account-label').textContent, '账号');
  assert.equal(f.gate.querySelector('.ac-password-label').textContent, '密码');
  assert.equal(f.gate.querySelector('[data-password-toggle]').textContent, '显示');
});

test('login starts with a generic account field while registration uses email verification', () => {
  const f = view();
  f.mounted.setPolicy({ mailReady: true, allowSelfRegistration: true });
  assert.equal(f.gate.querySelector('[data-auth-password]').hidden, false);
  assert.equal(f.gate.querySelector('[data-auth-code]').hidden, true);
  assert.equal(f.gate.querySelector('.ac-account-label').textContent, '账号');
  assert.equal(f.mounted.accountInput.type, 'text');
  f.mode('register');
  assert.equal(f.gate.querySelector('[data-auth-code]').hidden, false);
  assert.equal(f.gate.querySelector('.ac-account-label').textContent, '邮箱');
  assert.equal(f.mounted.accountInput.type, 'email');
  assert.equal(f.gate.querySelector('[data-send-code]').disabled, false);
});

test('old Hub policy explains version incompatibility and retains a password path', async () => {
  const f = view(); f.mounted.setBusy(true);
  f.mounted.setPolicy({ allowSelfRegistration: true, tokenLimit: 1000, passwordMinLength: 8 });
  f.mounted.setBusy(false);
  assert.equal(f.gate.querySelector('[data-auth-password]').hidden, false);
  assert.equal(f.gate.querySelector('[data-send-code]').disabled, true);
  assert.match(f.gate.querySelector('[data-mail-message]').textContent, /服务版本不支持邮箱验证.*更新服务.*密码登录/);
  assert.doesNotMatch(f.gate.querySelector('[data-mail-message]').textContent, /管理员尚未/);
  f.mounted.accountInput.value = 'person@example.test'; f.mounted.passwordInput.value = 'fixture-only';
  await f.mounted.form.fire('submit');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].kind, 'legacy');
  assert.equal(f.calls[0].payload.account, 'person@example.test');
  assert.equal(f.mounted.passwordInput.value, '');
});

function bootView() {
  const f = view(); f.policyRequests = [];
  f.mounted.dispose();
  const query = f.gate.querySelector;
  f.gate.querySelector = selector => ['.soduwork-auth-connection', '.soduwork-auth-first summary'].includes(selector) ? null : query(selector);
  f.api.registerClient = () => new Promise(resolve => { f.finishEnrollment = resolve; });
  f.api.clientAuthPolicy = () => new Promise((resolve, reject) => f.policyRequests.push({ resolve, reject }));
  f.window.SoduWorkAPI = f.api;
  const body = element(); body.appendChild = () => {};
  const document = { readyState: 'loading', documentElement: element(), body,
    createElement: () => f.gate, querySelectorAll: () => [], addEventListener() {} };
  const authSource = fs.readFileSync(path.join(__dirname, '../components/client-auth/client-auth.js'), 'utf8')
    .replace('global.ClientAuth = {', 'global.ClientAuth = { bootForTest: boot, loadPolicyForTest: loadPolicy,');
  vm.runInNewContext(authSource, { ...f.context, document, Intl });
  return f;
}

test('first device enrollment cannot strand the registration code button when mail policy returns later', async () => {
  const f = bootView();
  const startup = f.window.ClientAuth.bootForTest();
  f.switchDevice(); f.finishEnrollment({ ok: true, activationRequired: true }); await startup;
  assert.equal(f.policyRequests.length, 1);
  f.policyRequests[0].resolve({ mailReady: true, allowSelfRegistration: true }); await f.flush();
  f.mode('register'); f.mounted.accountInput.value = 'new-user@example.test'; f.mounted.accountInput.fire('input');
  assert.equal(f.window.ClientAuth.snapshot().policy?.mailReady, true, 'current-device mail policy reaches the outer gate');
  assert.equal(f.gate.querySelector('[data-send-code]').disabled, false, 'registration remains actionable after bootstrap changes the device ID');
  assert.equal(f.gate.querySelector('[data-mail-availability]').hidden, true);
});

test('policy HTTP failure exposes recheck, repeated failure remains visible, and success restores the same draft', async () => {
  const f = bootView(), startup = f.window.ClientAuth.bootForTest();
  f.finishEnrollment({ ok: true, activationRequired: true }); await startup;
  f.mode('register'); f.mounted.accountInput.value = 'draft@example.test';
  f.policyRequests[0].reject(Error('private HTTP response')); await f.flush();
  assert.equal(f.window.ClientAuth.snapshot().policy, null, 'a transport failure must not invent unsupported or disabled mail policy');
  assert.equal(f.gate.querySelector('[data-mail-availability]').hidden, false);
  assert.match(f.gate.querySelector('[data-mail-message]').textContent, /无法读取邮件服务状态.*重新检查/);
  assert.doesNotMatch(f.gate.querySelector('[data-mail-message]').textContent, /private|管理员尚未|不支持邮箱/);
  assert.equal(f.gate.querySelector('[data-send-code]').disabled, true);
  for (const success of [false, true]) {
    f.gate.querySelector('[data-recheck-policy]').fire('click');
    f.finishEnrollment({ ok: true, activationRequired: true }); await f.flush();
    const request = f.policyRequests.at(-1);
    if (success) request.resolve({ mailReady: true, allowSelfRegistration: true }); else request.reject(Error('still unavailable'));
    await f.flush();
    assert.equal(f.gate.querySelector('[data-mail-availability]').hidden, success);
    assert.equal(f.gate.querySelector('[data-send-code]').disabled, !success);
    assert.equal(f.mounted.accountInput.value, 'draft@example.test');
    assert.doesNotMatch(f.mounted.statusNode.textContent, /正在安全恢复/);
  }
  assert.equal(f.policyRequests.length, 3);
  assert.equal(f.gate.querySelector('[data-mail-message]').textContent, '');
});

test('failed policy recheck disables stale availability without losing the email draft', () => {
  const f = view(); f.mounted.setPolicy({ mailReady: true }); f.mounted.accountInput.value = 'draft@example.test';
  f.mounted.setPolicyError();
  assert.equal(f.gate.querySelector('[data-send-code]').disabled, true);
  assert.equal(f.gate.querySelector('[data-mail-availability]').hidden, false);
  f.mounted.setPolicy({ mailReady: true });
  assert.equal(f.gate.querySelector('[data-send-code]').disabled, false);
  assert.equal(f.gate.querySelector('[data-mail-availability]').hidden, true);
  assert.equal(f.mounted.accountInput.value, 'draft@example.test');
});

for (const change of ['switchHub', 'switchDevice', 'switchUser']) test('late policy failure cannot mark a new identity unavailable after ' + change, async () => {
  const f = bootView(), startup = f.window.ClientAuth.bootForTest();
  f.finishEnrollment({ ok: true, activationRequired: true }); await startup;
  f[change](); f.policyRequests[0].reject(Error('old failure')); await f.flush();
  assert.equal(f.gate.querySelector('[data-mail-availability]').hidden, true);
});

test('older failed policy request cannot replace a successful newer recheck', async () => {
  const f = bootView(), startup = f.window.ClientAuth.bootForTest();
  f.finishEnrollment({ ok: true, activationRequired: true }); await startup;
  const newer = f.window.ClientAuth.loadPolicyForTest();
  f.policyRequests[1].resolve({ mailReady: true }); await newer;
  f.policyRequests[0].reject(Error('old failure')); await f.flush();
  assert.equal(f.gate.querySelector('[data-mail-availability]').hidden, true);
  assert.equal(f.gate.querySelector('[data-send-code]').disabled, false);
});

test('new Hub disabled mail names administrator configuration and preserves modern password endpoint', async () => {
  const f = view(); f.mounted.setPolicy({ allowSelfRegistration: true, mailReady: false });
  assert.match(f.gate.querySelector('[data-mail-message]').textContent, /管理员尚未配置或启用邮件服务/);
  assert.doesNotMatch(f.gate.querySelector('[data-mail-message]').textContent, /服务版本/);
  f.mounted.accountInput.value = 'person@example.test'; f.mounted.passwordInput.value = 'fixture-only';
  await f.mounted.form.fire('submit');
  assert.equal(f.calls[0].kind, 'password');
});

test('explicit recheck uses the existing retry hook and an updated policy enables email without changing input', () => {
  const f = view(); f.mounted.setPolicy({ mailReady: false });
  f.mounted.accountInput.value = 'draft@example.test';
  f.gate.querySelector('[data-recheck-policy]').fire('click');
  assert.equal(f.retries(), 1);
  f.mounted.setBusy(true); f.gate.querySelector('[data-recheck-policy]').fire('click'); assert.equal(f.retries(), 1);
  f.mounted.setPolicy({ mailReady: true, allowSelfRegistration: true }); f.mounted.setBusy(false);
  assert.equal(f.gate.querySelector('[data-mail-availability]').hidden, true);
  assert.equal(f.mounted.accountInput.value, 'draft@example.test');
  f.mode('emailCode'); assert.equal(f.gate.querySelector('[data-send-code]').disabled, false);
  assert.equal(f.gate.querySelector('[data-auth-code]').hidden, false);
});

test('available email policy does not manufacture an unavailable-service warning', () => {
  const f = view(); f.mounted.setPolicy({ mailReady: true, allowSelfRegistration: false });
  assert.equal(f.gate.querySelector('[data-mail-availability]').hidden, true);
  assert.equal(f.gate.querySelector('[data-auth-mode="register"]').hidden, true);
});

test('registration consent survives identical policy refresh but never applies to changed required versions', () => {
  const f = view();
  const policy = { mailReady: true, requiredConsentVersions: { terms: 'v1', privacy: 'v1' } };
  f.mounted.setPolicy(policy); f.mode('register');
  const consent = f.gate.querySelector('#acConsent'); consent.checked = true;
  f.mounted.setPolicy({ ...policy }); assert.equal(consent.checked, true);
  f.mounted.setPolicy({ ...policy, requiredConsentVersions: { privacy: 'v1', terms: 'v1' } });
  assert.equal(consent.checked, true);
  f.mounted.setPolicy({ ...policy, requiredConsentVersions: { terms: 'v2', privacy: 'v1' } });
  assert.equal(consent.checked, false);
});

function deliveryView(statusReply, sentReply = {}) {
  const f = view(); f.mounted.setPolicy({ mailReady: true, allowSelfRegistration: true });
  f.mode('emailCode');
  f.mounted.accountInput.value = 'person@example.test';
  f.api.clientAccountAction = async (action, payload) => {
    f.calls.push({ kind: action, payload });
    if (action === 'emailChallenge') return { ok: true, challengeId: 'challenge-1', expiresIn: 300,
      retryAfter: 60, queued: true, deliveryState: 'queued', ...sentReply };
    return typeof statusReply === 'function' ? statusReply() : statusReply;
  };
  f.send = () => f.gate.querySelector('[data-send-code]').fire('click');
  f.status = () => f.mounted.statusNode.textContent;
  f.polls = () => f.calls.filter(call => call.kind === 'emailChallengeStatus').length;
  return f;
}

test('queued mail waits for delivery status and sent means SMTP sending, not inbox receipt', async () => {
  const f = deliveryView({ ok: true, challengeId: 'challenge-1', deliveryState: 'sent' });
  await f.send(); assert.match(f.status(), /请求已受理.*确认发送结果/); assert.equal(f.polls(), 0);
  await f.advance(1000); assert.equal(f.polls(), 1);
  assert.match(f.status(), /邮件服务已发送验证码.*查看邮箱.*垃圾邮件/);
  assert.doesNotMatch(f.status(), /已送达|已收到|已入收件箱/);
  await f.advance(120000); assert.equal(f.polls(), 1);
  f.mounted.dispose();
});

for (const [errorCode, copy] of [
  ['SMTP_AUTH_FAILED', /联系管理员.*配置/], ['MAIL_NOT_READY', /联系管理员.*配置/],
  ['SMTP_TLS_FAILED', /联系管理员.*配置/], ['SMTP_CONNECTION_FAILED', /发送失败.*稍后重试/],
  ['SMTP_RECIPIENT_REJECTED', /收件邮箱拒收.*核对邮箱/], ['SMTP_REJECTED', /发送失败.*稍后重试/]
]) test('mail failure shows safe actionable feedback for ' + errorCode, async () => {
  const f = deliveryView({ ok: true, challengeId: 'challenge-1', deliveryState: 'failed', errorCode,
    error: 'private SMTP password 123456' });
  await f.send(); await f.advance(1000); assert.match(f.status(), copy);
  assert.doesNotMatch(f.status(), /private|123456|SMTP/);
  f.gate.querySelector('#acEmailCode').value = '123456'; await f.mounted.form.fire('submit');
  assert.match(f.status(), /请先获取有效/); await f.advance(120000); assert.equal(f.polls(), 1);
  f.mounted.dispose();
});

test('old Hub without delivery metadata retains an honest receipt and does not poll', async () => {
  const f = deliveryView(null, { deliveryState: '', queued: false });
  await f.send(); await f.advance(120000); assert.equal(f.polls(), 0);
  assert.match(f.status(), /请求已受理/); assert.doesNotMatch(f.status(), /服务已发送/); f.mounted.dispose();
});

test('old Hub status endpoint 404 ends polling without exposing HTTP errors', async () => {
  const f = deliveryView({ ok: false, status: 404, error: 'private response' });
  await f.send(); await f.advance(120000); assert.equal(f.polls(), 1);
  assert.match(f.status(), /暂未确认.*查看邮箱/); assert.doesNotMatch(f.status(), /404|private/); f.mounted.dispose();
});

for (const statusReply of [
  { ok: true, challengeId: 'challenge-1', deliveryState: 'retry' },
  { ok: false, status: 503, error: 'private server response' },
  () => { throw Error('private network error'); }
]) test('pending mail and transient lookup failures are bounded to sixty seconds', async () => {
  const f = deliveryView(statusReply); await f.send(); await f.advance(60000);
  assert.ok(f.polls() > 1 && f.polls() <= 20); assert.match(f.status(), /暂未确认.*未收到可稍后重试/);
  const calls = f.polls(); await f.advance(300000); assert.equal(f.polls(), calls); f.mounted.dispose();
});

for (const change of ['email', 'tab', 'invalidate', 'dispose', 'hidden', 'switchHub', 'switchDevice', 'switchUser']) {
  test('delivery polling discards an in-flight response after ' + change, async () => {
    let resolve; const f = deliveryView(() => new Promise(done => { resolve = done; }));
    await f.send(); await f.advance(1000); assert.equal(f.polls(), 1);
    if (change === 'email') { f.mounted.accountInput.value = 'changed@example.test'; f.mounted.accountInput.fire('input'); }
    else if (change === 'tab') f.mode('password');
    else if (change === 'hidden') f.gate.hidden = true;
    else if (['invalidate', 'dispose'].includes(change)) f.mounted[change]();
    else f[change]();
    const before = f.status(); resolve({ ok: true, challengeId: 'challenge-1', deliveryState: 'sent' });
    await f.flush(); await f.advance(120000); assert.equal(f.status(), before); assert.equal(f.polls(), 1);
    f.mounted.dispose();
  });
}

test('submitting verification stops delivery feedback from overwriting the verification result', async () => {
  let resolve;
  const f = deliveryView(() => new Promise(done => { resolve = done; }));
  await f.send(); await f.advance(1000);
  f.api.clientAccountAction = async () => { f.switchUser(); f.switchDevice(); return { ok: true, user: { id: 'signed-in' } }; };
  f.gate.querySelector('#acEmailCode').value = '123456'; await f.mounted.form.fire('submit');
  assert.match(f.status(), /验证成功/);
  resolve({ ok: true, challengeId: 'challenge-1', deliveryState: 'failed', errorCode: 'SMTP_AUTH_FAILED' });
  await f.flush(); await f.advance(120000); assert.match(f.status(), /验证成功/); assert.equal(f.polls(), 1);
  f.mounted.dispose();
});

function policyRuntime() {
  let hub = 'http://first.invalid', client = 'device-a', user = '', resolvers = [];
  const window = { SoduWorkAPI: { hubBase: () => hub,
    clientAuthSnapshot: () => ({ clientId: client, user: user ? { id: user } : null }),
    clientAuthPolicy: () => new Promise(resolve => resolvers.push(resolve)) } };
  const authSource = fs.readFileSync(path.join(__dirname, '../components/client-auth/client-auth.js'), 'utf8')
    .replace('global.ClientAuth = {', 'global.ClientAuth = { loadPolicyForTest: loadPolicy,');
  vm.runInNewContext(authSource, { window, document: { readyState: 'loading', addEventListener() {},
    documentElement: { classList: { add() {} } } }, setTimeout, clearTimeout, Intl });
  return { auth: window.ClientAuth, resolvers,
    switchHub() { hub = 'http://second.invalid'; }, switchDevice() { client = 'device-b'; }, switchUser() { user = 'other-user'; } };
}
for (const action of ['switchHub', 'switchDevice', 'switchUser']) test('late policy is discarded after ' + action, async () => {
  const f = policyRuntime(), pending = f.auth.loadPolicyForTest();
  f[action](); f.resolvers[0]({ mailReady: true }); await pending;
  assert.equal(f.auth.snapshot().policy, null);
});
test('older policy response cannot overwrite a newer explicit recheck', async () => {
  const f = policyRuntime(), first = f.auth.loadPolicyForTest(), second = f.auth.loadPolicyForTest();
  f.resolvers[1]({ mailReady: true }); await second;
  f.resolvers[0]({ mailReady: false }); await first;
  assert.equal(f.auth.snapshot().policy.mailReady, true);
});
