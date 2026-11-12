'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { assertNoLinks } = require('../plugin-resources');
const runtime = require('./runtime.cjs');
const auth = require('./feishu-auth.cjs');
const lifecycle = require('./account-lifecycle.cjs');
const refreshes = new Map();
const servers = new Map();
const starting = new Map();

function credentialFile(app, scope) {
  const p = runtime.paths(app, 'feishu', scope);
  const file = path.join(p.account, 'connection.json');
  assertNoLinks(p.root, file);
  return file;
}
function secureStorage(safeStorage) {
  if (!safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw Error('系统安全存储不可用，无法保存飞书连接');
  }
}
function read(app, scope, safeStorage) {
  const file = credentialFile(app, scope);
  if (!fs.existsSync(file)) return null;
  secureStorage(safeStorage);
  try {
    return JSON.parse(safeStorage.decryptString(
      Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8')).cipher, 'base64')));
  } catch (_) { throw Error('飞书连接凭据无法解密，请重新连接'); }
}
function save(app, scope, value, safeStorage) {
  secureStorage(safeStorage);
  const file = credentialFile(app, scope);
  const temp = file + '.' + crypto.randomBytes(6).toString('hex') + '.next';
  fs.writeFileSync(temp, JSON.stringify({
    cipher: safeStorage.encryptString(JSON.stringify(value)).toString('base64'),
  }), { mode: 0o600, flag: 'wx' });
  try { fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
async function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    const failed = error => { server.removeListener('listening', ready); reject(error); };
    const ready = () => { server.removeListener('error', failed); resolve(server.address().port); };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(port, '127.0.0.1');
  });
}
async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function verifyCredentials(appId, appSecret, fetchImpl = fetch) {
  if (!/^cli_[a-zA-Z0-9]{5,100}$/.test(appId) || !appSecret || appSecret.length > 512) {
    throw Error('请填写有效的飞书 App ID 和 App Secret');
  }
  let response, data;
  try {
    response = await fetchImpl('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    data = await response.json();
  } catch (_) { throw Error('暂时无法验证飞书应用，请检查网络后重试'); }
  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    throw Error('飞书应用验证未通过，请检查 App ID、App Secret 和应用状态');
  }
  return true;
}
async function request(identity, method, route, body) {
  let response, data;
  try {
    response = await fetch(identity.hub.replace(/\/+$/, '') + '/api/v1' + route, {
      method, headers: { Authorization: 'Device ' + identity.session, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: AbortSignal.timeout(40000),
    });
    data = await response.json();
  } catch (_) { throw Error('SoduWork 后台暂时无法连接，请恢复连接后重试'); }
  // Do not expose diagnostic responses that may reflect connection credentials.
  if (!response.ok || data.ok === false) {
    if (route === '/mcp-servers/upsert' && [404,405].includes(response.status))
      throw Error('当前 Hub 不支持单条连接更新，请升级 Hub 后再检查连接');
    if (route === '/mcp-servers/upsert' && response.status === 409)
      throw Error('连接已在其他位置修改，请刷新后再检查连接');
    throw Error(route.endsWith('/probe')
      ? '飞书工具连接检查未通过，请确认本机 Runner 在线后重试'
      : 'SoduWork 连接设置保存失败，请检查登录状态与连接权限');
  }
  return data;
}
// Hub normalizes all MCP IDs to 36 characters; retain the IDs already saved by older clients.
function registrationId(scope) { return ('soduwork-feishu-' + scope).slice(0, 36); }
function spec(scope, value) {
  const url = 'http://127.0.0.1:' + value.port + '/mcp';
  return { id: registrationId(scope), name: 'feishu', description: 'SoduWork 本机飞书个人账号连接',
    type: 'http', url, headers: { Authorization: 'Bearer ' + value.bearer },
    enabled: true, approved: true, approvedTarget: url, startupTimeoutSeconds: 20 };
}
async function register(identity, scope, value, guard = async () => {}, verifyLocal = null) {
  await guard();
  const current = await request(identity, 'GET', '/mcp-servers');
  if (!Array.isArray(current.personal) || !Array.isArray(current.company)) throw Error('无法确认现有连接，请刷新后重试');
  const personal = current.personal;
  const selected = spec(scope, value);
  if (current.company.some(x => String(x.name).toLowerCase() === 'feishu')) {
    throw Error('已有公司飞书连接，请在连接器设置中使用公司连接');
  }
  const named = personal.filter(x => String(x.name).toLowerCase() === 'feishu');
  const exact = personal.find(x => x.id === selected.id);
  if ((exact && exact.name !== 'feishu') || named.length > 1) throw Error('飞书登记已变化，请刷新连接器列表');
  const existing = named[0];
  if (existing && existing.id !== selected.id) {
    const conflict = Object.assign(Error('已有同名个人连接。可管理原连接并更名，然后点击检查连接。'), { conflictId: existing.id });
    // Only try the stored masked credential on this exact loopback endpoint.
    // Require both the scoped ID suffix and an authenticated hit on our running proxy.
    const suffix = String(existing.id).match(/([a-f0-9]{16,32})$/)?.[1];
    if (!verifyLocal || !suffix || !scope.startsWith(suffix) || existing.type !== 'http' ||
        !/^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/.test(existing.url) || existing.headers?.Authorization !== '••••') throw conflict;
    await guard();
    const proof = verifyLocal();
    try {
      const checked = await request(identity,'POST','/mcp-servers/probe',{
        ...selected, id:existing.id, url:proof.url, approvedTarget:proof.url, headers:{Authorization:existing.headers.Authorization}
      });
      if (!checked.tools?.length || !proof.confirmed()) throw conflict;
    } catch { throw conflict; } finally { proof.close(); }
    selected.id = existing.id;
  }
  // The real Runner performs initialize + tools/list before the connection is enabled.
  await guard();
  const probe = await request(identity, 'POST', '/mcp-servers/probe', selected);
  if (!(probe.tools || []).length) throw Error('飞书未返回可用工具，请检查应用配置');
  await guard();
  const saved = await request(identity, 'POST', '/mcp-servers/upsert', { server:selected, original:existing || null });
  await guard();
  return { toolCount: probe.tools.length, warning: saved.warning || '', registrationId:selected.id };
}
function createProxy(upstream, scope, value, app, identityOf, accessToken, acceptProof) {
  return http.createServer(async (req, res) => {
    try {
      const active = await identityOf(app);
      if (runtime.platformScope(app, active, 'feishu') !== scope || lifecycle.read(app, 'feishu', scope).disconnected) { res.writeHead(403); return res.end(); }
      const got = Buffer.from(String(req.headers.authorization || ''));
      const expected = Buffer.from('Bearer ' + value.bearer);
      if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
        res.writeHead(401); return res.end();
      }
      if (!['GET', 'POST', 'DELETE'].includes(req.method) || (req.url !== '/mcp' && !acceptProof?.(req.url))) {
        res.writeHead(404); return res.end();
      }
      let length = 0;
      const parts = [];
      for await (const part of req) {
        length += part.length;
        if (length > 8 * 1024 * 1024) { res.writeHead(413); return res.end(); }
        parts.push(part);
      }
      const headers = {};
      for (const key of ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
        if (req.headers[key]) headers[key] = req.headers[key];
      }
      const ctl = new AbortController();
      res.on('close', () => ctl.abort());
      if (accessToken) headers.Authorization = 'Bearer ' + await accessToken();
      if (runtime.platformScope(app, await identityOf(app), 'feishu') !== scope || lifecycle.read(app, 'feishu', scope).disconnected) { res.writeHead(403); return res.end(); }
      const response = await fetch('http://127.0.0.1:' + upstream + '/mcp', {
        method: req.method, headers, ...(parts.length ? { body: Buffer.concat(parts) } : {}),
        signal: ctl.signal, redirect: 'error',
      });
      const out = {};
      for (const key of ['content-type', 'mcp-session-id', 'mcp-protocol-version']) {
        if (response.headers.get(key)) out[key] = response.headers.get(key);
      }
      res.writeHead(response.status, out);
      if (response.body) Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res);
      else res.end();
    } catch (_) { if (!res.headersSent) res.writeHead(502); res.end('Connection unavailable'); }
  });
}
async function start(app, identity, scope, value, safeStorage, identityOf, signal) {
  if (servers.has(scope)) return servers.get(scope);
  if (starting.has(scope)) return starting.get(scope);
  const pending = startService(app, identity, scope, value, safeStorage, identityOf, signal);
  starting.set(scope, pending);
  try { return await pending; } finally { starting.delete(scope); }
}
async function startService(app, identity, scope, value, safeStorage, identityOf, signal) {
  secureStorage(safeStorage);
  const ctl = new AbortController();
  const active = AbortSignal.any([signal || new AbortController().signal, ctl.signal]);
  const guard = () => sameOwner(app, scope, identityOf, active);
  await guard();
  await ensureToken(app, scope, value, safeStorage, identityOf, active);
  const p = runtime.paths(app, 'feishu', scope);
  const adapter = await runtime.adapter('feishu');
  const upstream = await freePort();
  const plan = adapter.plan(p.provider, { action: 'serve', prefix: p.prefix, port: upstream, args: [] },
    { ...runtime.env(), APP_ID: value.appId, APP_SECRET: value.appSecret }, runtime.node());
  // Personal connections always use the consenting user's access token. The
  // shared plugin launcher retains tenant mode for separately configured company MCPs.
  const tokenMode = plan.args.indexOf('--token-mode');
  if (tokenMode < 0) throw Error('飞书运行环境不支持个人授权');
  plan.args[tokenMode + 1] = 'user_access_token';
  plan.env.USER_ACCESS_TOKEN = value.accessToken;
  await guard();
  const child = runtime.execute(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, timeout: 0 });
  child.completion.catch(() => {});
  let challenge = null, boundPort;
  const verifyLocal = () => {
    const proof = { path:'/mcp/' + crypto.randomUUID(), seen:false };
    challenge = proof;
    return { url:'http://127.0.0.1:' + boundPort + proof.path, confirmed:() => proof.seen,
      close:() => { if (challenge === proof) challenge = null; } };
  };
  const proxy = createProxy(upstream, scope, value, app, identityOf,
    () => ensureToken(app, scope, value, safeStorage, identityOf, active), path => {
      if (!challenge || challenge.path !== path) return false;
      challenge.seen = true;
      return true;
    });
  let stopFailed = false;
  const stop = () => {
    for (const action of [() => child.cancel(), () => proxy.closeAllConnections(), () => proxy.close()]) {
      try { if (action() === false) stopFailed = true; } catch (_) { stopFailed = true; }
    }
  };
  active.addEventListener('abort', stop, { once: true });
  let result;
  try {
    try { boundPort = await listen(proxy, value.port || 0); }
    catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      boundPort = await listen(proxy);
    }
    let ready = false;
    for (let i = 0; i < 80; i++) {
      await guard();
      if (child.child.exitCode !== null) throw Error('飞书运行程序启动失败，请重新准备环境');
      try {
        await fetch('http://127.0.0.1:' + upstream + '/mcp', { method: 'GET', signal: AbortSignal.timeout(200) });
        ready = true; break;
      } catch (_) { /* Wait only for this managed child to bind its port. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw Error('飞书服务启动超时');
    // Token refresh reloads credential storage during the probe. The address
    // belongs to this listening socket even if storage still has the old port.
    result = await register(identity, scope, {...value,port:boundPort}, guard, verifyLocal);
    await guard();
    value.port = boundPort;
    lifecycle.bindRegistration(app, scope, result.registrationId, spec(scope,value).url);
    save(app, scope, value, safeStorage);
  } catch (error) {
    ctl.abort(); active.removeEventListener('abort', stop); stop(); throw error;
  }
  const handle = { connected: !result.warning, ...result, verifyLocal, port: boundPort,
    close() { ctl.abort(); active.removeEventListener('abort', stop); stop(); handle.connected = false;
      if (stopFailed) throw Error('飞书本机运行程序停止失败，请重试断开');
      if (servers.get(scope) === handle) servers.delete(scope); } };
  servers.set(scope, handle);
  const exited = () => { stopFailed = false; try { handle.close(); } catch (_) { /* Explicit disconnect reports a stop failure. */ } };
  child.completion.then(exited, exited);
  return handle;
}
async function sameOwner(app, scope, identityOf, signal) {
  auth.check(signal);
  if (runtime.platformScope(app, await identityOf(app), 'feishu') !== scope) throw Error('SoduWork 账号已切换，请重新连接');
  if (lifecycle.read(app, 'feishu', scope).disconnected) throw Error('本机连接已断开，请重新连接');
  auth.check(signal);
}
async function ensureToken(app, scope, value, safeStorage, identityOf, signal) {
  await sameOwner(app, scope, identityOf, signal);
  if (!value.openId || !value.accessToken) throw auth.failure('invalid_grant');
  const stored = read(app, scope, safeStorage);
  if (stored?.appId !== value.appId || stored?.openId !== value.openId) throw auth.failure('invalid_grant');
  Object.assign(value, stored);
  if (value.expiresAt > Date.now() + 60000) return value.accessToken;
  if (refreshes.has(scope)) {
    await refreshes.get(scope);
    await sameOwner(app, scope, identityOf, signal);
    const latest = read(app, scope, safeStorage);
    if (latest?.appId !== value.appId || latest?.openId !== value.openId) throw auth.failure('invalid_grant');
    Object.assign(value, latest);
    return value.accessToken;
  }
  const pending = (async () => {
    const next = await auth.refresh(value, signal);
    const account = await auth.userInfo(next.accessToken, signal);
    if (account.openId !== value.openId) throw auth.failure('identity');
    await sameOwner(app, scope, identityOf, signal);
    const updated = { ...value, ...next };
    save(app, scope, updated, safeStorage);
    Object.assign(value, updated);
    return value.accessToken;
  })();
  refreshes.set(scope, pending);
  try { return await pending; } finally { if (refreshes.get(scope) === pending) refreshes.delete(scope); }
}
async function connect(app, identity, scope, options, safeStorage, identityOf) {
  const { signal, progress = () => {} } = options || {};
  secureStorage(safeStorage);
  await sameOwner(app, scope, identityOf, signal);
  if (starting.has(scope)) await starting.get(scope).catch(() => {});
  servers.get(scope)?.close();
  if (refreshes.has(scope)) await refreshes.get(scope).catch(() => {});
  await sameOwner(app, scope, identityOf, signal);
  let value = read(app, scope, safeStorage);
  if (!value?.appId || !value?.appSecret) {
    progress({ state: 'connecting', phase: 'app_registration', message: '正在获取飞书官方应用创建入口…' });
    const created = await auth.registerApp(app, { signal, progress });
    await sameOwner(app, scope, identityOf, signal);
    value = { ...created, bearer: crypto.randomBytes(32).toString('base64url'), port: 0 };
    // Keep the successfully created app even if personal authorization is cancelled.
    save(app, scope, value, safeStorage);
  }
  progress({ state: 'connecting', phase: 'user_authorization', authUrl: '', userCode: '', expiresAt: 0,
    message: '应用配置已保存，正在获取个人账号授权入口…' });
  const granted = await auth.authorize(value, { signal, progress });
  await sameOwner(app, scope, identityOf, signal);
  progress({ state: 'connecting', phase: 'verifying', authUrl: '', userCode: '', expiresAt: 0,
    message: '扫码已完成，正在验证个人身份与工具连接…' });
  const account = await auth.userInfo(granted.accessToken, signal);
  await sameOwner(app, scope, identityOf, signal);
  value = { ...value, ...granted, ...account, authMode: 'user' };
  save(app, scope, value, safeStorage);
  const result = await start(app, identity, scope, value, safeStorage, identityOf, signal);
  return { connected: result.connected, account: value.name,
    description: result.warning || '个人账号与工具目录已验证；具体文档权限以飞书授权为准' };
}
async function restore(app, identity, scope, safeStorage, identityOf, signal) {
  await sameOwner(app, scope, identityOf, signal);
  const value = read(app, scope, safeStorage);
  if (!value) return { connected: false };
  // Legacy app-only credentials are reusable, but are not a personal login.
  if (value.authMode !== 'user' || !value.openId || !value.accessToken) {
    return { connected: false, description: '应用配置已保存，请扫码授权个人账号' };
  }
  await ensureToken(app, scope, value, safeStorage, identityOf, signal);
  const account = await auth.userInfo(value.accessToken, signal);
  if (account.openId !== value.openId) throw auth.failure('identity');
  await sameOwner(app, scope, identityOf, signal);
  const result = await start(app, identity, scope, value, safeStorage, identityOf, signal);
  if (result.warning) {
    const checked = await register(identity, scope, {...value,port:result.port}, () => sameOwner(app, scope, identityOf, signal), result.verifyLocal);
    Object.assign(result, checked, { connected: !checked.warning });
  }
  return { connected: result.connected, account: value.name || '飞书用户', description: result.warning };
}

async function disableRegistration(identity, scope, guard = async () => {}, binding) {
  await guard();
  const current = await request(identity, 'GET', '/mcp-servers');
  const id = binding?.id || registrationId(scope);
  if (!Array.isArray(current.personal)) throw Error('无法确认现有连接，请刷新后重试');
  const row = current.personal.find(item => item.id === id);
  if (!row) return;
  if (row.name !== 'feishu' || (binding && row.url !== binding.url)) throw Error('本机飞书注册记录已变化，请检查连接器设置');
  if (row.enabled === false) return;
  await guard();
  const result = await request(identity, 'PATCH', '/mcp-servers/selection',
    { changes: [{ kind: 'personal', id, enabled: false }] });
  await guard();
  if (!Array.isArray(result.personal) || result.personal.some(item => item.id === id && item.enabled !== false))
    throw Error('本机授权已清理，后台飞书连接仍未停用，请重试断开');
}
function closeScope(scope) { servers.get(scope)?.close(); }

function closeAll() { for (const server of [...servers.values()]) server.close(); }
module.exports = { verifyCredentials, read, save, connect, restore, closeAll, closeScope, registrationId, disableRegistration, register, createProxy, ensureToken };
