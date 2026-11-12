'use strict';

const crypto = require('crypto');

// Stable releases use canonical X.Y.Z; staging candidates carry a semver
// prerelease suffix X.Y.Z-beta.N (beta.1 < beta.2 < ... < the same stable).
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(1|[1-9]\d*))?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

/*
 * Match backend RELEASE_PLATFORM_SUFFIXES. Accept only platform-specific installer
 * suffixes, including compound tar.gz and Windows Setup names.
 */
const INSTALLER_STEM = 'SoduWork';
const VERSION_STEM = '\\d+\\.\\d+\\.\\d+(?:-beta\\.(?:1|[1-9]\\d*))?';
const INSTALLER_NAMES = {
  win32: new RegExp(`^${INSTALLER_STEM}-${VERSION_STEM}-Setup\\.exe$`),
  darwin: new RegExp(`^${INSTALLER_STEM}-${VERSION_STEM}-mac(?:-(?:x64|arm64))?\\.(?:dmg|zip)$`, 'i'),
  linux: new RegExp(`^${INSTALLER_STEM}-${VERSION_STEM}-linux(?:-(?:x64|arm64))?\\.(?:deb|rpm|appimage|tar\\.gz)$`, 'i'),
};
const RELEASE_PLATFORMS = Object.keys(INSTALLER_NAMES);

const PRERELEASE = 0, RELEASE = 1;

function parseVersion(value) {
  const match = VERSION.exec(String(value || '').trim());
  if (!match) return null;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  const beta = match[4] === undefined ? undefined : Number(match[4]);
  // Matches the Hub ordering: stable releases outrank their own prereleases.
  return [major, minor, patch, beta === undefined ? RELEASE : PRERELEASE, beta || 0];
}

function newer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 5; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach((key) => { out[key] = stable(value[key]); });
    return out;
  }
  return value;
}

function canonicalBytes(payload) {
  return Buffer.from(JSON.stringify(stable(payload)), 'utf8');
}

function manifestPayload(manifest) {
  const copy = { ...(manifest || {}) };
  delete copy.signature;
  return copy;
}

function validateManifest(manifest, trust, currentPlatform = process.platform) {
  if (!manifest || manifest.schema !== 1) throw new Error('升级清单版本不受支持');
  if (!parseVersion(manifest.version)) throw new Error('升级版本无效');
  if (!/^[0-9a-f-]{36}$/i.test(String(manifest.releaseId || ''))) throw new Error('升级版本标识无效');
  if (!['stable', 'beta'].includes(manifest.channel)) throw new Error('升级通道无效');
  if (!RELEASE_PLATFORMS.includes(manifest.platform) || manifest.platform !== currentPlatform) {
    throw new Error('升级包与当前系统不匹配');
  }
  if (!['x64', 'arm64'].includes(manifest.arch)) throw new Error('升级包与当前系统不匹配');
  const artifact = manifest.artifact || {};
  if (!INSTALLER_NAMES[manifest.platform].test(String(artifact.name || ''))) {
    throw new Error('安装包名称无效');
  }
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 1024 * 1024) throw new Error('安装包大小无效');
  if (!SHA256.test(String(artifact.sha256 || ''))) throw new Error('安装包摘要无效');
  if (!/^\/api\/v1\/client-updates\/artifacts\/[0-9a-f-]{36}$/i.test(String(artifact.url || ''))) {
    throw new Error('安装包地址无效');
  }
  if (!KEY_ID.test(String(manifest.keyId || ''))) throw new Error('升级签名标识无效');
  const key = trust && trust.keys && trust.keys[manifest.keyId];
  if (!key) throw new Error('升级签名不受信任');
  const signature = Buffer.from(String(manifest.signature || ''), 'base64');
  if (signature.length !== 64) throw new Error('升级签名无效');
  const raw = Buffer.from(String(key), 'base64');
  if (raw.length !== 32) throw new Error('升级签名公钥无效');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  const publicKey = crypto.createPublicKey({
    key: spki, format: 'der', type: 'spki',
  });
  if (!crypto.verify(null, canonicalBytes(manifestPayload(manifest)), publicKey, signature)) {
    throw new Error('升级签名校验失败');
  }
  return manifest;
}

function safeInstallerPath(root, name, platform = process.platform) {
  if (!RELEASE_PLATFORMS.includes(platform) ||
      !INSTALLER_NAMES[platform].test(String(name || ''))) {
    throw new Error('安装包名称无效');
  }
  const path = require('path');
  const target = path.resolve(root, name);
  const base = path.resolve(root) + path.sep;
  if (!target.startsWith(base)) throw new Error('安装包路径越界');
  return target;
}

module.exports = {
  canonicalBytes, manifestPayload, newer, parseVersion, safeInstallerPath, validateManifest,
  INSTALLER_NAMES, RELEASE_PLATFORMS,
};
