'use strict';

const fs = require('node:fs');
const path = require('node:path');

/* Stable entry points use the SoduWork name since the brand rename, while
   payloads installed before it still ship SoduWork.exe. Accept both so the
   launcher of any installed generation can be located. */
const { current } = require('./distribution.cjs');
function launcherNames(profile = current()) {
  return profile.distributionId === 'internal' || profile.distributionId === 'stage'
    ? [profile.windowsExecutableName + '.exe', 'SoduWork.exe', 'SoduWork.exe']
    : [profile.windowsExecutableName + '.exe'];
}

function rootLauncher(root, exists = fs.existsSync, profile = current()) {
  for (const name of launcherNames(profile)) {
    const file = path.join(root, name);
    if (exists(file)) return file;
  }
  return null;
}

// External entry points use the stable launcher; Runner still uses process.execPath.
function installRoot(executable = process.execPath, exists = fs.existsSync, profile = current()) {
  const binaryDir = path.dirname(executable);
  const versions = path.dirname(binaryDir);
  if (path.basename(versions) === '.soduwork-versions') {
    const root = path.dirname(versions);
    if (exists(path.join(root, '.soduwork-active')) && rootLauncher(root, exists, profile)) return root;
  }
  return binaryDir;
}

function launchPath(executable = process.execPath, exists = fs.existsSync, profile = current()) {
  const root = installRoot(executable, exists, profile);
  const launcher = rootLauncher(root, exists, profile);
  if (root !== path.dirname(executable) ||
      (exists(path.join(root, '.soduwork-launcher')) && launcher)) {
    return launcher || path.join(root, launcherNames(profile)[0]);
  }
  return executable;
}

function installMode(executable = process.execPath, read = fs.readFileSync) {
  try {
    const mode = read(path.join(installRoot(executable), '.soduwork-install-mode'), 'utf8').trim();
    return ['all', 'CurrentUser'].includes(mode) ? mode : '';
  } catch (_) { return ''; } // legacy installers: upstream registry detection remains authoritative
}

module.exports = { installRoot, launchPath, installMode };
