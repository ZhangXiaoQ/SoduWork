'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareRunner } = require('./prepare-runner.cjs');
const { macosBuildEnvironment } = require('./macos-build-environment.cjs');
const { notarizeArtifact, notarizeEnabled, signingIdentity } = require('./notarize-macos.cjs');
const { candidateVersion } = require('./client-build-version.cjs');

const truthy = value => ['1', 'true', 'yes'].includes(String(value || '').trim().toLowerCase());

function releaseBuild(env = process.env) {
  return truthy(env.SODUWORK_MAC_RELEASE);
}

function signingArguments(env = process.env) {
  const identity = signingIdentity(env);
  if (releaseBuild(env)) {
    assert.ok(identity, 'macOS release builds require SODUWORK_MAC_SIGN_IDENTITY');
    assert.ok(!truthy(env.SODUWORK_MAC_SKIP_NOTARIZE),
      'macOS release builds cannot skip notarization');
  }
  return ['--config.mac.identity=' + (identity || '-')];
}

function signingKeychain(env = process.env) {
  return env.SODUWORK_MAC_KEYCHAIN || (env.HOME ? path.join(env.HOME, 'Library/Keychains/login.keychain-db') : '');
}

function build({ root = path.resolve(__dirname, '../..'), platform = process.platform,
  env = process.env, run = execFileSync, prepare = prepareRunner, hostArch = process.arch,
  distributions, preparedRunner, beforePackages = () => {}, beforePackage = () => {}, afterPackage = () => {} } = {}) {
  assert.equal(platform, 'darwin', 'macOS packages require a native Mac runner');
  signingArguments(env);
  assert.ok((!distributions || (distributions.length === 1 && distributions[0] === 'self-hosted')) &&
    (!env.SODUWORK_DISTRIBUTION || env.SODUWORK_DISTRIBUTION === 'self-hosted'),
  'Public macOS builds support only the self-hosted distribution');
  assert.ok(!preparedRunner && !env.SODUWORK_MAC_NOTARY_STATE_DIR && !env.SODUWORK_MAC_BUILD_INPUT_ID,
    'Private build checkpoints are unavailable in the public source');
  const architectures = env.SODUWORK_MACOS_ARCH === undefined ? ['arm64', 'x64'] : [env.SODUWORK_MACOS_ARCH];
  assert.ok(architectures.every(arch => ['arm64', 'x64'].includes(arch)), 'Invalid SODUWORK_MACOS_ARCH');
  assert.ok(hostArch !== 'x64' || !architectures.includes('arm64'), 'Intel Mac cannot execute ARM build tools; select SODUWORK_MACOS_ARCH=x64');
  const toolchain = macosBuildEnvironment({ env, run, hostArch });
  try {
    return buildTargets({ root, platform, env: toolchain.env, run, prepare, architectures, hostArch,
      beforePackages, beforePackage, afterPackage });
  } finally {
    toolchain.cleanup();
  }
}
function buildTargets({ root, platform, env, run, prepare, architectures, hostArch,
  beforePackages, beforePackage, afterPackage }) {
  const client = path.join(root, 'client');
  const targets = architectures.map(arch => ({ arch,
    python: env['SODUWORK_MACOS_' + arch.toUpperCase() + '_PYTHON'] ||
      (arch === hostArch ? path.join(root, 'hub-backend/.venv/bin/python') : '') }));
  // Validate all selected interpreters before spending time on a package.
  for (const { arch, python } of targets) {
    assert.ok(python, 'Configure SODUWORK_MACOS_' + arch.toUpperCase() + '_PYTHON');
    // Verify the target Python can invoke real lipo before expensive packaging; preserve underlying diagnostics.
    const actual = run(python, ['-c', 'import platform, subprocess, sys\n' +
      'probe = subprocess.run(["lipo", "-archs", sys.executable], capture_output=True, text=True)\n' +
      'if probe.returncode: sys.exit(probe.stderr or probe.stdout)\n' +
      'print(platform.machine())'], { env, encoding: 'utf8' }).trim();
    assert.equal(actual, arch === 'x64' ? 'x86_64' : 'arm64', 'Build Python architecture differs from ' + arch);
  }
  // Validation builds may use ad-hoc signing; public releases require Developer ID.
  const identity = signingIdentity(env);
  if (identity) {
    const keychain = signingKeychain(env);
    const args = ['find-identity', '-v', '-p', 'codesigning'];
    if (keychain) args.push(keychain);
    const listed = run('security', args, { env, encoding: 'utf8' });
    assert.ok(listed.includes(identity), 'Developer ID identity is missing from the keychain: ' + identity);
  }
  for (const { arch, python } of targets) {
    const runner = prepare({ root, platform, python, env });
    const architectures = run('lipo', ['-archs', runner], { env, encoding: 'utf8' }).trim().split(/\s+/);
    assert.ok(architectures.includes(arch === 'x64' ? 'x86_64' : 'arm64'), 'Bundled Runner architecture differs from ' + arch);
    run(python, [path.join(root, 'tools/ci/verify-runner-skills.py'), runner], { env, cwd: root, stdio: 'inherit' });
    // Finish each package before replacing the shared Runner with the next architecture.
    beforePackages({ arch, env });
    beforePackage();
    const signed = identity && notarizeEnabled(env);
    const dmgPath = signed ? path.join(client, 'dist', `SoduWork-${candidateVersion(env, root)}-mac-${arch}.dmg`) : '';
    run(process.execPath, [path.join(client, 'node_modules/electron-builder/cli.js'), '--mac', '--' + arch, '--publish', 'never',
      ...signingArguments(env),
      ...(signed ? ['--config.mac.hardenedRuntime=true', '--config.afterSign=scripts/notarize-macos.cjs'] : [])],
    { env, cwd: client, stdio: 'inherit' });
    if (signed) {
      // The afterSign hook notarizes and staples the App; notarize its DMG too.
      assert.ok(fs.existsSync(dmgPath), 'electron-builder did not produce ' + path.relative(root, dmgPath));
      notarizeArtifact({ artifactPath: dmgPath, env, run });
    }
    afterPackage(env, arch);
  }
}
module.exports = { build, releaseBuild, signingArguments };
if (require.main === module) {
  try { build(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
