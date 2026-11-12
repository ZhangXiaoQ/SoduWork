'use strict';
// Package bytes are served by Electron's resource protocol, never by a spawned server.
const path = require('node:path');
const crypto = require('node:crypto');
const contract = require('../core/plugin-package-page.cjs');
const resources = require('./plugin-resources');
const configured = new WeakMap();
const MIME = { '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain', '.wasm': 'application/wasm' };
function ownerScope(app, pluginId, origin) {
  try { return require('./app-settings-store.cjs').scope({ pluginId, origin }); }
  catch (error) {
    // Only installed local pages may work without a logged-in Hub account.
    // Remote pages must never share the offline partition during account changes.
    if (!pluginId.startsWith('local:')) throw error;
    return crypto.createHash('sha256').update(app.getPath('userData') + '\0local\0' + pluginId).digest('hex');
  }
}
async function definition(deps, pluginId, conditional) {
  if (pluginId.startsWith('local:')) {
    const plugin = require('./personal-plugins').get(deps.app, pluginId);
    if (!plugin.enabled) throw Error('请先安装并启用该应用');
    return { ui: plugin.ui, resources: plugin.localDraft.resources, jiyong:plugin.jiyong || plugin.localDraft.jiyong };
  }
  const identity = await (deps.authenticatedIdentityOf || deps.identityOf)?.(deps.app);
  if (!identity?.hub) throw Error('请先登录 SoduWork');
  const response = await require('./device-auth-request').fetchWithDeviceAuthRetry(identity,
    identity.hub.replace(/\/+$/, '') + '/api/v1/plugins/' + encodeURIComponent(pluginId) + '/ui-package', {
      redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json',
        ...(conditional?.etag ? { 'If-None-Match': conditional.etag } : {}) },
    }, deps.fetchImpl || global.fetch);
  if (conditional && response.status === 304) {
    const canonical = value => String(value || '').trim().replace(/^W\//, '');
    const echoed = response.headers.get('etag');
    if (!conditional.etag || (echoed && canonical(echoed) !== canonical(conditional.etag))) throw Error('应用缓存校验响应无效，请重试');
    conditional.unchanged = true; return null;
  }
  if (!response.ok) throw Error('包内应用资源读取失败，请确认安装与使用权限');
  if (conditional) conditional.nextEtag = response.headers.get('etag') || '';
  return response.json();
}
async function prepare(deps, raw) {
  const pluginId = String(raw?.pluginId || ''), contributionId = String(raw?.contributionId || '');
  if (!pluginId || !contributionId) throw Error('包内应用缺少安装与入口标识');
  const origin = contract.origin(pluginId), scope = ownerScope(deps.app, pluginId, origin);
  const read = async (action = 'metadata', pathname) => {
    if (ownerScope(deps.app, pluginId, origin) !== scope) throw Error('应用账号已变化，请重新打开即用');
    // Remote reads still authenticate on every request; only inert validation and
    // decoded bytes are cached. Local reads stat the registry on the Worker.
    const cache = require('./app-resource-cache.cjs');
    const input = { profile: path.resolve(deps.app.getPath('userData')), pluginId, contributionId, scope, pathname };
    const remote = !pluginId.startsWith('local:');
    const cached = remote ? await cache.request({ ...input, action: 'cached', requestedAction: action }) : null;
    const conditional = { etag: cached?.etag };
    let value;
    try { value = remote ? await definition(deps, pluginId, conditional) : undefined; }
    catch (error) { if (remote) await cache.request({ ...input, action: 'clear' }); throw error; }
    if (ownerScope(deps.app, pluginId, origin) !== scope) throw Error('应用账号已变化，请重新打开即用');
    const result = conditional.unchanged ? cached.result : await cache.request({ ...input, action, value, etag: conditional.nextEtag });
    if (ownerScope(deps.app, pluginId, origin) !== scope) throw Error('应用账号已变化，请重新打开即用');
    return result;
  };
  const initial = await read();
  if (initial.definition.jiyong?.initialization && raw.initialize !== false)
    await require('./jiyong-initialization.cjs').initialize(deps, pluginId);
  if (!pluginId.startsWith('local:') && initial.definition.jiyong)
    require('./app-settings-store.cjs').saveHosted({pluginId,origin},initial.definition);
  // Keep Windows IndexedDB backing-store paths below legacy path limits.
  const partition = 'persist:sw-app-' + scope.slice(0, 32);
  const session = (deps.session || require('electron').session).fromPartition(partition);
  let pages = configured.get(session);
  if (!pages) {
    pages = new Map(); configured.set(session, pages);
    session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.protocol.handle('https', async request => {
      const target = new URL(request.url), page = pages.get(target.origin);
      // This partition only hosts package resources. Reserved origins never reach DNS.
      if (!page || !['GET', 'HEAD'].includes(request.method)) return new Response('', { status: 403 });
      try {
        if((target.pathname.startsWith('/_app-files/')||target.pathname.startsWith('/_app-sources/'))) {
          const { row, definition:installed } = await page();
          if(!row.source.bridge?.capabilities?.includes('data.read') || !installed.jiyong || installed.jiyong.storage?.location==='cloud')return new Response('',{status:403});
          return await require('./app-files.cjs').response(deps.app,{pluginId:page.pluginId,origin:target.origin},request,()=>{if(ownerScope(deps.app,page.pluginId,target.origin)!==page.scope)throw Error('应用账号已变化');});
        }
        const pathname = decodeURIComponent(target.pathname.slice(1));
        const file = await page('resource', pathname);
        if (!file) return new Response('', { status: 404 });
        const name = resources.resourcePath(file.path);
        const bytes = Buffer.from(file.bytes);
        return new Response(request.method === 'HEAD' ? null : bytes, { headers: {
          'Content-Type': (MIME[path.extname(name).toLowerCase()] || 'application/octet-stream') + (/[.](?:html?|css|m?js|json|txt)$/i.test(name) ? '; charset=utf-8' : ''),
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'",
        } });
      } catch (_) { return new Response('', { status: 403 }); }
    });
  }
  read.pluginId=pluginId;read.scope=scope;
  pages.set(origin, read);
  return { url: origin + '/' + initial.row.source.entry, partition, revision: initial.revision,
    assertActive: () => { if (ownerScope(deps.app, pluginId, origin) !== scope) throw Error('Application account changed'); },
    bridge: { appId: 'plugin:' + pluginId, contributionId, origin, version: 1,
      capabilities: initial.row.source.bridge?.capabilities || [] } };
}
module.exports = { prepare, definition, ownerScope };
