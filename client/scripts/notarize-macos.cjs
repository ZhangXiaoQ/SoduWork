'use strict';
// Apple notarization for Developer ID release builds. Ad-hoc CI builds (no
// SODUWORK_MAC_SIGN_IDENTITY) never enter these paths, so CI artifacts stay unchanged.
// SODUWORK_MAC_SIGN_IDENTITY: Developer ID Application name (or SHA-1) to sign with.
// SODUWORK_MAC_NOTARY_PROFILE: notarytool keychain profile; defaults to SODUWORK_NOTARY.
// SODUWORK_MAC_NOTARY_KEYCHAIN: keychain containing the notary profile; falls back to the signing keychain.
// SODUWORK_MAC_SKIP_NOTARIZE: set to 1/true/yes to keep a signed but unnotarized (local-test) DMG.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_NOTARY_PROFILE = 'SODUWORK_NOTARY';

function signingIdentity(env = process.env) {
  const identity = env.SODUWORK_MAC_SIGN_IDENTITY;
  return identity && identity !== '-' ? String(identity).trim() : '';
}

function notaryProfile(env = process.env) {
  return env.SODUWORK_MAC_NOTARY_PROFILE || DEFAULT_NOTARY_PROFILE;
}

function notaryKeychain(env = process.env) {
  return env.SODUWORK_MAC_NOTARY_KEYCHAIN || env.SODUWORK_MAC_KEYCHAIN || '';
}

function notarizeEnabled(env = process.env) {
  const skip = String(env.SODUWORK_MAC_SKIP_NOTARIZE || '').trim().toLowerCase();
  return Boolean(signingIdentity(env)) && !['1', 'true', 'yes'].includes(skip);
}

function unlockSigningKeychain(env, run) {
  const password = env.SODUWORK_MAC_KEYCHAIN_PASSWORD;
  if (!password) return;
  const keychain = env.SODUWORK_MAC_KEYCHAIN || env.CSC_KEYCHAIN ||
    (env.HOME ? path.join(env.HOME, 'Library/Keychains/login.keychain-db') : '');
  if (!keychain) throw new Error('Configure the signing keychain before notarization');
  try {
    // Signing and compression can outlast the earlier CI unlock. Refresh access
    // in the submitting process, including when the profile uses the search list.
    run('security', ['unlock-keychain', '-p', password, keychain],
      { env, stdio: 'pipe', timeout: 30000 });
  } catch {
    // execFileSync errors include command arguments; never propagate the password.
    throw new Error('Unable to unlock the signing keychain before notarization');
  }
}

// `--wait` blocks until Apple's notary service issues the verdict; a rejected
// or invalid submission must fail the build instead of shipping a blocked DMG.
function assertPublicNotaryOptions(env) {
  if (env.SODUWORK_MAC_NOTARY_STATE_DIR || env.SODUWORK_MAC_BUILD_INPUT_ID)
    throw new Error('Private notarization checkpoints are unavailable in the public source');
}

function notarizeArtifact({ artifactPath, env, run, staple = true }) {
  assertPublicNotaryOptions(env);
  unlockSigningKeychain(env, run);
  const args = ['notarytool', 'submit', artifactPath, '--keychain-profile', notaryProfile(env)];
  const keychain = notaryKeychain(env);
  // iCloud keychains are valid search-list entries but are not accepted by
  // notarytool's explicit --keychain file argument. CI marks that case and
  // lets notarytool resolve the profile through the user search list.
  if (keychain && env.SODUWORK_MAC_NOTARY_KEYCHAIN_SEARCH !== '1') args.push('--keychain', keychain);
  args.push('--wait');
  run('xcrun', args);
  if (staple) run('xcrun', ['stapler', 'staple', artifactPath]);
}

// Signers see the app as a bundle; notarytool accepts a zip of it.
function notarizeApp({ appPath, env, run }) {
  assertPublicNotaryOptions(env);
  const zipPath = appPath + '.notarize.zip';
  run('ditto', ['-c', '-k', '--keepParent', appPath, zipPath]);
  try {
    notarizeArtifact({ artifactPath: zipPath, env, run, staple: false });
    run('xcrun', ['stapler', 'staple', appPath]);
  } finally {
    fs.rmSync(zipPath, { force: true });
  }
}

// electron-builder afterSign hook (top-level option): runs after the app is
// signed and before the DMG is packaged, so the DMG ships a stapled app that
// passes Gatekeeper offline. No-ops unless a real Developer ID build is active.
exports.default = async function afterSign(context) {
  const env = process.env;
  if (!notarizeEnabled(env)) return;
  const appPath = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  notarizeApp({ appPath, env, run: (file, args, options) => execFileSync(file, args, { stdio: 'inherit', ...options }) });
};

exports.signingIdentity = signingIdentity;
exports.notaryProfile = notaryProfile;
exports.notaryKeychain = notaryKeychain;
exports.notarizeEnabled = notarizeEnabled;
exports.notarizeArtifact = notarizeArtifact;
exports.notarizeApp = notarizeApp;
