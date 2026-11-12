'use strict';

const fs = require('node:fs');
const path = require('node:path');
const PRODUCTION_HUB = 'http://127.0.0.1:18989';
const connections = new WeakMap();

const BAD_HUB = '后台地址应为不带路径的 http:// 或 https:// 地址';
// Public builds default to a local Hub and persist the user's service selection.
// The isolated integration harness keeps a fixed connection:
// - an unpackaged, separately profiled integration harness may opt into its own
//   loopback backend (SODUWORK_TEST_HUB_URL; internalTest, never editable);
// Both packaged and source clients may select a self-hosted Hub at login.
function normalizeHub(raw) {
  const value = String(raw || '').trim();
  let parsed;
  try { parsed = new URL(/^https?:\/\//i.test(value) ? value : 'http://' + value); }
  catch (_) { throw new Error(BAD_HUB); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password ||
      parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error(BAD_HUB);
  }
  return parsed.origin;
}
function savedFile(app) { return path.join(app.getPath('userData'), 'hub-endpoint.json'); }
function loadSavedHub(app) {
  try { return normalizeHub(JSON.parse(fs.readFileSync(savedFile(app), 'utf8')).hub); }
  catch (_) { return ''; }
}
function saveHub(app, hub) {
  fs.writeFileSync(savedFile(app), JSON.stringify({ hub }), { encoding: 'utf8', mode: 0o600 });
}
function initialize(app, env = process.env, distributionProfile = require('./distribution.cjs').current()) {
  let hub = distributionProfile.hubOrigin, internalTest = false, editable = false;
  const testHub = env.SODUWORK_TEST_HUB_URL;
  const testProfile = env.SODUWORK_USER_DATA;
  if (!app.isPackaged && testHub) {
    const value = new URL(testHub);
    const profile = path.resolve(app.getPath('userData'));
    const installedNames = ['SoduWork', 'soduwork', distributionProfile.userDataName, distributionProfile.linuxPackageName].filter(Boolean);
    const reserved = installedNames.map(name => path.resolve(app.getPath('appData'), name).toLowerCase());
    if (!['http:', 'https:'].includes(value.protocol) ||
        !['127.0.0.1', '[::1]', 'localhost'].includes(value.hostname) ||
        value.username || value.password || value.search || value.hash || value.pathname !== '/' ||
        !testProfile || path.resolve(testProfile) !== profile || reserved.includes(profile.toLowerCase())) {
      throw new Error('Internal Hub tests require a loopback URL and an isolated SODUWORK_USER_DATA directory');
    }
    hub = value.origin; internalTest = true;
  } else {
    editable = true;
    const saved = loadSavedHub(app);
    if (saved) hub = saved;
  }
  const connection = Object.freeze({ hub, internalTest, editable });
  connections.set(app, connection);
  return connection;
}

function current(app) { return connections.get(app) || null; }
function accepts(app, hub) { const connection = current(app); return !connection || connection.hub === hub; }
// Commit a self-hosted service selection. Fixed test connections only
// ever accept their own hub, and an invalid editable address changes nothing.
function prepare(app, rawHub) {
  const connection = current(app);
  if (!connection || !connection.editable) {
    return accepts(app, rawHub) ? { ok: true } : { ok: false, error: '此客户端使用固定的 SoduWork 服务' };
  }
  let target;
  try { target = normalizeHub(rawHub); } catch (error) { return { ok: false, error: error.message }; }
  if (target !== connection.hub) {
    try { saveHub(app, target); }
    catch (_) { return { ok: false, error: '无法保存服务地址，请检查本机存储空间或权限' }; }
    connections.set(app, Object.freeze({ hub: target, internalTest: false, editable: true }));
  }
  return { ok: true, hub: target };
}
module.exports = { PRODUCTION_HUB, initialize, current, accepts, prepare };
