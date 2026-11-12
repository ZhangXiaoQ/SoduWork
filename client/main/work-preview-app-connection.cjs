'use strict';
const store = require('./app-settings-store.cjs');
const appOwner = require('./work-preview-app-owner.cjs');
function binding(item, deps, capability) {
  appOwner.assertCurrent(item);
  const pluginId = String(item.appBridge?.appId || '').replace(/^plugin:/, '');
  const installed = require('./personal-plugins').get(deps.app, pluginId);
  if (!installed?.enabled) throw Error('即用已停用或卸载');
  if (capability) {
    const source = installed.ui?.contributions?.find(row => row.id === item.appBridge.contributionId)?.source;
    const origin = source?.type === 'package' ? require('../core/plugin-package-page.cjs').origin(pluginId) : source?.type === 'external' ? new URL(source.url).origin : '';
    if (!origin || origin !== item.appBridge.origin || !source.bridge?.capabilities?.includes(capability)) throw Error('已安装应用未声明此来源或设置能力，请更新应用');
  }
  return { pluginId, origin: item.appBridge.origin };
}
async function settingsBinding(item, deps, capability) {
  appOwner.assertCurrent(item);
  const pluginId = String(item.appBridge?.appId || '').replace(/^plugin:/, '');
  const bound = { pluginId, origin: item.appBridge.origin }, scope = store.scope(bound);
  const assertCurrent = () => {
    appOwner.assertCurrent(item);
    if (store.scope(bound) !== scope || String(item.appBridge?.appId || '').replace(/^plugin:/, '') !== pluginId ||
        item.appBridge?.origin !== bound.origin || item.view?.webContents?.isDestroyed() ||
        (item.view && new URL(item.view.webContents.getURL()).origin !== bound.origin)) throw Error('应用身份或来源已变化，请重新打开即用');
  };
  const installed = await require('./app-installed-remote.cjs').get(deps, pluginId, assertCurrent);
  const source = installed.ui?.contributions?.find(row => row.id === item.appBridge.contributionId && row.slot === 'workspace.navigation')?.source;
  const origin = source?.type === 'package' ? require('../core/plugin-package-page.cjs').origin(pluginId) : source?.type === 'external' ? new URL(source.url).origin : '';
  if (!origin || origin !== bound.origin || !source.bridge?.capabilities?.includes(capability)) {
    throw Error('已安装应用未声明此来源或设置能力，请更新应用');
  }
  return { bound, assertCurrent, installed };
}
function settings({ item }, request, deps) {
  appOwner.assertCurrent(item);
  const read = request.method === 'settings.get';
  const capability = read ? 'settings.read' : 'settings.write', action = read ? 'get' : 'update';
  if (String(item.appBridge?.appId || '').replace(/^plugin:/, '').startsWith('local:')) {
    const bound = binding(item, deps, capability);
    const installed = require('./personal-plugins').get(deps.app, bound.pluginId);
    return require('./jiyong-runtime.cjs').parameters(bound, installed, action, request.params);
  }
  return settingsBinding(item, deps, capability).then(({ bound, assertCurrent, installed }) => {
    assertCurrent();
    return require('./jiyong-runtime.cjs').parameters(bound, installed, action, request.params);
  });
}
function connect({ owner, item }, params, deps) {
  appOwner.assertCurrent(item);
  const pluginId = String(item.appBridge?.appId || '').replace(/^plugin:/, '');
  if (!deps.app) throw Error('应用宿主尚未就绪');
  if (!pluginId.startsWith('local:')) return connectRemote(item, params, deps);
  const installed = require('./personal-plugins').get(deps.app, pluginId);
  if (!installed?.enabled || !(installed.localDraft?.mcpServers || []).includes(params.server)) throw Error('应用未声明该连接器');
  const target = new URL(params.url);
  if (target.origin !== item.appBridge.origin || target.pathname !== '/mcp' || target.search || target.hash || target.username || target.password) {
    throw Error('应用只能连接自己来源下的 /mcp 服务');
  }
  const bound = binding(item, deps, params.credentialKey ? 'mcp.connect' : null);
  if (item.appBridge.contributionId) store.saveConnection(bound, item.appBridge.contributionId, params.credentialKey ? {
    server: params.server, url: target.href, credentialKey: params.credentialKey,
  } : null);
  item.appConnection = params.credentialKey ? { pluginId, server: params.server, url: target.href,
    credentialKey: params.credentialKey, scope: store.scope(bound), context: params.context || {}, expiresAt: Number.MAX_SAFE_INTEGER }
    : params.token ? { pluginId, server: params.server, url: target.href, token: params.token, context: params.context || {}, expiresAt: Date.now() + 30 * 60 * 1000 } : null;
  return { ok: true, connected: !!item.appConnection, server: params.server };
}
async function connectRemote(item, params, deps) {
  const { bound, assertCurrent, installed } = await settingsBinding(item, deps, 'mcp.connect');
  if (!installed.capabilities?.mcpServers?.includes(params.server)) throw Error('当前即用版本未声明该 MCP 连接器，请更新应用');
  const target = new URL(params.url);
  if (target.origin !== bound.origin || target.pathname !== '/mcp' || target.search || target.hash || target.username || target.password)
    throw Error('应用只能连接自己来源下的 /mcp 服务');
  if (!params.credentialKey) throw Error('市场应用须使用宿主管理的应用凭据');
  assertCurrent();
  store.saveConnection(bound, item.appBridge.contributionId, {
    server: params.server, url: target.href, credentialKey: params.credentialKey,
  });
  item.appConnection = { pluginId: bound.pluginId, server: params.server, url: target.href,
    versionId: installed.versionId, contributionId: item.appBridge.contributionId, origin: bound.origin, jiyong: installed.jiyong,
    credentialKey: params.credentialKey, scope: store.scope(bound), context: params.context || {},
    expiresAt: Number.MAX_SAFE_INTEGER,
    authorize: async () => {
      const current = await settingsBinding(item, deps, 'mcp.connect');
      if (current.installed.versionId !== installed.versionId) throw Error('应用安装版本已变化，请重新打开即用');
      if (!current.installed.capabilities?.mcpServers?.includes(params.server)) throw Error('应用连接器授权已变化');
    } };
  return { ok: true, connected: true, server: params.server };
}
function resolve(item, deps, assertActive = () => {}) {
  appOwner.assertCurrent(item);
  const connection = item.appConnection;
  if (!connection || connection.expiresAt <= Date.now()) return null;
  if (!connection.credentialKey) return { ...connection,
    authorize: async () => { assertActive(); appOwner.assertCurrent(item); await connection.authorize?.(); } };
  const remote = !connection.pluginId.startsWith('local:');
  const bound = remote ? { pluginId: connection.pluginId, origin: item.appBridge.origin } : binding(item, deps, 'mcp.connect');
  const expectedScope = connection.scope;
  const read = () => {
    assertActive();
    appOwner.assertCurrent(item);
    if (store.scope(bound) !== expectedScope || item.view?.webContents?.isDestroyed() ||
      (item.view && new URL(item.view.webContents.getURL()).origin !== bound.origin)) throw Error('应用身份或来源已变化');
    if (String(item.appBridge?.appId || '').replace(/^plugin:/, '') !== bound.pluginId) throw Error('应用身份已变化');
    if (!remote) binding(item, deps, 'mcp.connect'); // Remote installations rechecked by authorize before every request.
    const row = store.read(bound), token = row.values[connection.credentialKey];
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token) || token.length > 4096) throw Error('请先登录应用以同步接入凭据');
    const installed = remote ? {jiyong:connection.jiyong} : require('./personal-plugins').get(deps.app,bound.pluginId);
    return { token, revision: store.mcpRevision(row, installed, connection.credentialKey) };
  };
  const current = read();
  const resolved = { ...connection, token: current.token, revision: current.revision, readCurrent: read,
    notifyChanged: change => {read();item.view?.webContents?.send('app-data-changed',change);},
    inspect: action => require('./work-preview-app-inspect.cjs').inspect(item, action, read) };
  return require('./jiyong-mcp-bindings.cjs').extend(resolved,remote ? {jiyong:connection.jiyong} : require('./personal-plugins').get(deps.app,bound.pluginId),bound);
}
async function authorize(item, deps, capability) {
  const pluginId = String(item.appBridge?.appId || '').replace(/^plugin:/, '');
  if (!pluginId.startsWith('local:')) return settingsBinding(item, deps, capability);
  const bound = binding(item, deps, capability), scope = store.scope(bound);
  const installed = require('./personal-plugins').get(deps.app, pluginId);
  const version = installed.checksum;
  const assertCurrent = () => {
    binding(item, deps, capability);
    if (store.scope(bound) !== scope || require('./personal-plugins').get(deps.app,pluginId).checksum !== version ||
        item.view?.webContents?.isDestroyed() || (item.view && new URL(item.view.webContents.getURL()).origin !== bound.origin)) throw Error('即用身份、版本或页面已变化');
  };
  return {bound,installed,assertCurrent};
}
module.exports = { connect, settings, resolve, authorize };
