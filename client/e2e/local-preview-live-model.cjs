'use strict';
// Explicit opt-in live validation through the local Hub and an authorized existing model.
if (process.env.SODUWORK_ALLOW_LIVE_MODEL !== "1") throw Error("Live model authorization is required");
const { app, BrowserWindow, webContents } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const client = path.resolve(__dirname, '..');
const state = process.env.SODUWORK_LOCAL_PREVIEW_STATE;
if (!state || !process.env.SODUWORK_USER_DATA || !path.resolve(process.env.SODUWORK_USER_DATA).startsWith(path.resolve(state) + path.sep)) {
  throw Error('An explicit isolated preview profile is required');
}
const config = JSON.parse(fs.readFileSync(path.join(state, 'local-settings.json'), 'utf8'));
const hub = 'http://127.0.0.1:18989';
const report = { ok: false, cases: [], errors: [] };
app.setAppPath(client);
app.on('web-contents-created', (_event, content) => {
  content.on('console-message', (_event, level, message) => {
    if (level >= 3) report.errors.push(String(message).slice(0, 300));
  });
});
require('../main.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 1200; i++) { const value = await fn(); if (value) return value; await delay(100); }
  throw Error('Preview state did not become ready');
}
app.whenReady().then(async () => {
  const auth = require('../main/device-auth');
  await until(() => auth.identity(app, hub));
  const identity = auth.identity(app, hub);
  const logged = await auth.login(app, { hub, clientId: identity.clientId, account: 'admin', password: config.admin_password,
    name: 'Local PostgreSQL preview', workRoot: path.join(state, 'work') });
  assert.equal(logged.ok, true, logged.error);
  const used = Number(logged.quota?.used || 0), limit = used + 1000;
  const content = await until(() => webContents.getAllWebContents().find(w => w.getURL().includes('/desk.html')));
  content.reload();
  const run = code => content.executeJavaScript(code, true);
  await until(async () => { try { return await run('!!window.ClientAuth?.snapshot().user'); } catch (_) { return false; } });
  await run('SoduWorkI18n.setLocale("zh-CN")');
  const win = BrowserWindow.fromWebContents(content); win?.show();
  const adminResponse = await fetch(hub + '/api/v1/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin', pw: config.admin_password }) });
  const admin = await adminResponse.json(); assert.ok(admin.token);
  const setQuota = async limit => {
    const response = await fetch(hub + '/api/v1/admin/users/' + admin.user.id, { method: 'PATCH',
      headers: { Authorization: 'Bearer ' + admin.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenQuota: { mode: 'limited', limit } }) });
    assert.equal(response.status, 200);
  };

  const expected = await auth.authenticatedIdentity(app, hub, identity.clientId);
  const quota = async () => {
    const response = await fetch(hub + '/api/v1/client-auth/authorize-ai', {headers:{Authorization:'Device '+expected.session}});
    const data = await response.json(); return data.quota || data.detail?.quota;
  };
  const source = JSON.parse(fs.readFileSync(path.join(state, 'model-source.json'), 'utf8'));
  report.model = source.model;
  const assistantText = snapshot => (snapshot?.messages || []).filter(m => m.role === 'assistant').map(m => m.text || (m.blocks || m.content || []).filter(p => p.kind === 'text' || p.type === 'text').map(p => p.text || '').join('')).join('\n');
  let ref;
  try {
    await setQuota(1000000);
    report.before = await quota();
    const opened = await run(`soduWorkAPI.conversationSession.open({adapterId:'pi',modelName:${JSON.stringify(source.id)}})`);
    assert(opened.ok, opened.reason); ref = opened.ref;
    await run(`NativeChat.enter('',${JSON.stringify(opened.sessionId)},{adapterId:'pi'});`);
    const send = text => run(`soduWorkAPI.conversationSession.send(${JSON.stringify(ref)},${JSON.stringify(text)},[],{})`);
    const snapshot = async () => (await run(`soduWorkAPI.conversationSession.snapshot(${JSON.stringify(ref)})`)).snapshot;
    const start = Date.now();
    const first = await send('这是本地模型连通性验证。不要调用工具，不要访问文件，只回复一句：本地客户端与模型连接成功。');
    assert(first.ok, first.reason);
    await until(async () => assistantText(await snapshot()).includes('本地客户端与模型连接成功'));
    report.responseMs = Date.now() - start;
    report.answer = assistantText(await snapshot());
    await until(async () => { report.after = await quota(); return report.after.used > report.before.used; });
    report.cases.push('Real desktop IPC, Pi runtime, local Hub and existing model returned the requested answer and recorded usage');
    await delay(1000);
    fs.writeFileSync(path.join(state,'live-model-success.png'),(await content.capturePage()).toPNG());
    await setQuota(report.after.used);
    const blocked = await send('额度耗尽验证：这条请求不应到达模型。');
    // Acceptance only queues the turn; runtime quota rejection is asynchronous.
    if (!blocked.ok) assert.match(blocked.reason || blocked.error || '', /额度/);
    else assert.equal(blocked.accepted, true);
    await until(() => run('!!document.querySelector(".soduwork-quota-card:not([hidden])")'));
    assert.equal(await run('document.body.classList.contains("soduwork-client-auth-open")'), false);
    await delay(1000);
    report.blockedUsage = await quota(); assert.equal(report.blockedUsage.used, report.after.used);
    fs.writeFileSync(path.join(state,'live-model-quota.png'),(await content.capturePage()).toPNG());
    report.cases.push('Exhausted quota blocks the next real conversation request, keeps authentication and does not add usage');
    await setQuota(1000000);
    const restored = await send('这是额度恢复验证。不要调用工具，只回复：额度恢复成功。');
    assert(restored.ok, restored.reason);
    await until(async () => assistantText(await snapshot()).includes('额度恢复成功'));
    await until(async () => { report.restored = await quota(); return report.restored.used > report.after.used; });
    report.recoveryNoticeHidden = await run('!document.querySelector(".soduwork-quota-notice:not([hidden])")');
    assert.equal(report.recoveryNoticeHidden, true, 'A recovered conversation must clear the exhausted-quota notice');
    report.cases.push('Raising the quota restores a real model reply without signing in again');
    report.ok = true;
  } finally {
    await setQuota(1000000);
    if (ref) await run(`soduWorkAPI.conversationSession.release(${JSON.stringify(ref)})`).catch(()=>{});
  }
}).catch(error => { report.failure = String(error.stack); }).finally(() => {
  fs.writeFileSync(path.join(state, 'live-model-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  app.exit(report.ok ? 0 : 1);
});
