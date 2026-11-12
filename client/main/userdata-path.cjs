'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

function resolvedDirectory(value) {
  const absolute = path.resolve(value);
  try { return fs.realpathSync.native(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(resolvedDirectory(parent), path.basename(absolute));
  }
}

function inside(parent, target) {
  const relative = path.relative(parent, target);
  return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

// Use the dedicated SoduWork data directory across upgrades without reading or moving other brands' data.
function initializeUserData(app, env = process.env, profile = require('./distribution.cjs').current()) {
  const explicit = env.SODUWORK_USER_DATA;
  let directory = explicit;
  if (app.isPackaged === false) {
    const appData = app.getPath('appData');
    const checkout = resolvedDirectory(typeof app.getAppPath === 'function' ? app.getAppPath() : path.resolve(__dirname, '..'));
    const namespace = crypto.createHash('sha256').update(process.platform === 'win32' ? checkout.toLowerCase() : checkout).digest('hex').slice(0, 20);
    directory = path.resolve(explicit || path.join(appData, 'SoduWork Development', profile.distributionId || 'internal', namespace));
    const candidate = resolvedDirectory(directory);
    // Reserve both the product profile and Linux's default Electron package
    // profile without loading private distribution configurations.
    const installedNames = [...new Set(['SoduWork', 'soduwork', profile.userDataName, profile.linuxPackageName].filter(Boolean))];
    const reserved = installedNames.map(name => resolvedDirectory(path.join(appData, name)));
    // Source builds must never enroll, migrate, or renew an installed client's
    // credentials, even when a stale shell override points at its directory.
    if (reserved.some(installed => inside(installed, candidate))) {
      throw Error('源码客户端必须使用独立数据目录，不能读取或修改已安装客户端的配置');
    }
  } else if (!directory) directory = path.join(app.getPath('appData'), profile.userDataName);
  fs.mkdirSync(directory, { recursive: true });
  app.setPath('userData', directory);
  return directory;
}
module.exports = { initializeUserData };
