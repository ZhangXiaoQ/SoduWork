'use strict';
// Clear only reproducible resource/HTTP caches. Never clear storage, cookies,
// credentials, databases, application files or whole profile directories.
const path = require('node:path');
const pages = require('./app-package-pages.cjs');
const cache = require('./app-resource-cache.cjs');
const contract = require('../core/plugin-package-page.cjs');
function create({ getDeps, ownerFor }) {
  async function manage(event, raw) {
    const owner = ownerFor(event), deps = getDeps();
    if (!owner || event.sender !== owner.host.webContents) throw Error('缓存管理仅支持主工作区');
    const pluginId = String(raw?.pluginId || '').trim();
    if (!pluginId || pluginId.length > 160 || !['stats', 'clear'].includes(raw?.action)) throw Error('缓存管理请求无效');
    const bindingOrigin = contract.origin(pluginId);
    const scope = pages.ownerScope(deps.app, pluginId, bindingOrigin);
    const assertCurrent = () => {
      if (owner.closed || pages.ownerScope(deps.app, pluginId, bindingOrigin) !== scope) throw Error('应用账号已变化，请重新打开设置');
    };
    const installed = pluginId.startsWith('local:') ? require('./personal-plugins').get(deps.app, pluginId)
      : await require('./app-installed-remote.cjs').get(deps, pluginId, assertCurrent);
    assertCurrent();
    if (!installed?.enabled) throw Error('请先安装并启用该应用');
    const packaged = installed.ui?.contributions?.some(row => row.slot === 'workspace.navigation' && row.source?.type === 'package');
    const sessions = new Set();
    let shared = false;
    if (packaged) sessions.add((deps.session || require('electron').session).fromPartition('persist:sw-app-' + scope.slice(0, 32)));
    else if (owner.lease?.session) {
      sessions.add(owner.lease.session); shared = true;
    }
    for (const item of owner.views.values()) {
      if (item.appBridge?.appId === 'plugin:' + pluginId) {
        const session = item.view.webContents.session;
        sessions.add(session);
        if (!packaged) shared = true; // External H5 previews share this owner's isolated Session.
      }
    }
    let networkBytes = 0;
    for (const session of sessions) {
      assertCurrent();
      if (raw.action === 'clear') await session.clearCache();
      networkBytes += await session.getCacheSize();
    }
    assertCurrent();
    const resource = await cache.request({ profile: path.resolve(deps.app.getPath('userData')), pluginId,
      action: raw.action === 'clear' ? 'clear' : 'stats' });
    assertCurrent();
    return { ok: true, networkBytes, resourceBytes: raw.action === 'clear' ? 0 : resource.bytes, shared,
      bytes: networkBytes + (raw.action === 'clear' ? 0 : resource.bytes) };
  }
  return { manage };
}
module.exports = { create };
