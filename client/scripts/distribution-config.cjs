'use strict';
const assert = require('node:assert/strict');
const { selected } = require('../main/distribution.cjs');
const { candidateVersion, GENERATED_VERSION_DIRECTORY } = require('./client-build-version.cjs');
// Electron DataPacks are sealed by their framework signature. Signing the same
// resource through Versions/A, Versions/Current and Resources adds no protection.
const ELECTRON_DATA_SIGN_IGNORE = String.raw`/Contents/Frameworks/Electron Framework\.framework/(?:Versions/(?:A|Current)/)?Resources/(?:[^/]+\.lproj/locale|resources|chrome_100_percent|chrome_200_percent)\.pak$`;

function configuration({ env = process.env, profile = selected(env), base = require('../package.json').build } = {}) {
  if (env.SODUWORK_RELEASE_HUB_URL) {
    const target = new URL(env.SODUWORK_RELEASE_HUB_URL);
    assert.ok(!target.username && !target.password && target.pathname === '/' && !target.search && !target.hash,
      'Release Hub must be an origin without credentials or a path');
    assert.equal(target.origin, profile.hubOrigin, 'Release Hub differs from the client distribution');
  }
  const internal = profile.distributionId === 'internal' || profile.distributionId === 'stage';
  return {
    ...base,
    // The renderer version must match extraMetadata.version in the signed ASAR.
    files: [...[].concat(base.files || ['**/*']).filter(file => file !== 'version.json'),
      '!version.json', { from: GENERATED_VERSION_DIRECTORY, to: '.', filter: ['version.json'] }],
    ...(env.electron_config_cache ? {
      electronDownload: { ...base.electronDownload, cache: env.electron_config_cache },
    } : {}),
    appId: profile.appId,
    productName: profile.productName,
    directories: { ...base.directories, output: 'dist/' + profile.distributionId },
    // Stage candidates must carry their beta number into the signed installer
    // identity. Formal release jobs resolve to the committed stable version.
    extraMetadata: { ...base.extraMetadata, version: candidateVersion(env),
      name: internal ? 'soduwork' : profile.linuxPackageName,
      productName: profile.productName, homepage: profile.websiteUrl,
      desktopName: profile.linuxExecutableName + '.desktop', soduworkDistribution: profile },
    win: { ...base.win, executableName: profile.windowsExecutableName },
    nsis: { ...base.nsis, guid: profile.nsisGuid, shortcutName: profile.productName },
    mac: { ...base.mac, executableName: profile.windowsExecutableName,
      signIgnore: [...[].concat(base.mac?.signIgnore || []), ELECTRON_DATA_SIGN_IGNORE] },
    linux: { ...base.linux, executableName: profile.linuxExecutableName },
    deb: { ...base.deb, packageName: profile.linuxPackageName },
    rpm: { ...base.rpm, packageName: profile.linuxPackageName },
  };
}

module.exports = { configuration };
