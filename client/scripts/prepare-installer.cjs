'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows');
const { notarizeApp, notarizeEnabled } = require('./notarize-macos.cjs');

// This module is registered as BOTH afterPack and afterSign and stages its
// work across the two calls of one pack (same appOutDir):
//
//   afterPack (always fires): compile the launcher, copy the bundled shell
//     runtime, and rotate away any stale payload manifest so a missing second
//     stage fails the NSIS compile loudly instead of silently shipping an
//     outdated manifest.
//
//   afterSign (fires whenever signApp returns true; on win32 that is
//     unconditional unless signAndEditExecutable is false): inventory and
//     payload write ONLY. This is the single authoritative pass: fuses and
//     executable resource editing happen between the two hooks, so only these
//     final bytes may be hashed into .soduwork-payload.json. Skipping the
//     afterPack inventory and the afterSign launcher/copy rework removes
//     roughly one minute of redundant hashing and copying per build.
//
//   Isolated regression fixtures set signAndEditExecutable=false, so
//   electron-builder skips the afterSign hook entirely ("no signing
//   occurred"). In that case the afterPack call performs the full
//   inventory+payload itself: with resource editing disabled the bytes on
//   disk at afterPack are already the final bytes.
//
// A dir-only build (--dir) never compiles an installer: skip the launcher,
// inventory and payload entirely, but still copy the shell runtime - the
// packaged app needs bundled Git at runtime.
const previousPack = { key: null, assembled: false };
const macAfterPack = new Set();

function isDirOnlyBuild(context) {
  const names = (context.targets || []).map(target => target?.name).filter(Boolean);
  return names.length === 0 || names.every(name => name === 'dir');
}

// Use installed upstream template: do not fork UAC/multi-user/uninstall behavior.
async function prepare(context = {}) {
  if (context.electronPlatformName && context.electronPlatformName !== 'win32') {
    if (context.appOutDir) {
      const resourcesPath = context.electronPlatformName === 'darwin'
        ? path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app', 'Contents', 'Resources')
        : path.join(context.appOutDir, 'resources');
      require('./verify-runtime.cjs').verify(context.appOutDir, context.electronPlatformName, { packaged: true, resourcesPath });
      require('./verify-runtime.cjs').verifyExecutables(resourcesPath, context.electronPlatformName,
        typeof context.arch === 'string' ? context.arch : ({ 1: 'x64', 3: 'arm64' })[context.arch]);
      if (context.electronPlatformName === 'darwin') {
        const appPath = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
        const key = path.resolve(appPath);
        const afterSign = macAfterPack.has(key);
        if (afterSign && notarizeEnabled(process.env)) {
          await notarizeApp({ appPath, env: process.env,
            run: (file, args, options) => execFileSync(file, args, { stdio: 'inherit', ...options }) });
        }
        macAfterPack.add(key);
      }
    }
    return;
  }
  const root = context.packager?.projectDir || path.resolve(__dirname, '..');
  const output = path.join(root, '.runtime', 'installer');
  const appOutDir = context.appOutDir ? path.resolve(context.appOutDir) : null;
  const packKey = appOutDir ? `${appOutDir}:${context.arch}` : null;
  const secondPass = previousPack.assembled && packKey !== null && packKey === previousPack.key;
  const dirOnly = isDirOnlyBuild(context);
  // signAndEditExecutable=false is the only path where signApp returns false
  // and electron-builder skips the afterSign hook; detect it so the first
  // call can finish the payload itself.
  const afterSignWillFire = context.packager?.platformSpecificBuildOptions?.signAndEditExecutable !== false;

  if (!secondPass) {
    previousPack.key = packKey;
    previousPack.assembled = true;
    const template = await fs.readFile(path.join(root,
      'node_modules/app-builder-lib/templates/nsis/installer.nsi'), 'utf8');
    const header = template.indexOf('!insertmacro customHeader');
    const section = template.indexOf('Section "install"');
    if (template.split('!include "installSection.nsh"').length !== 2 ||
        header < 0 || section < 0 || header > section) {
      throw new Error('NSIS transaction hooks changed; review versioned installer');
    }
    if (!dirOnly) {
      await fs.mkdir(output, { recursive: true });
      const compiler = await getMakeNsisPath();
      const launcher = path.join(output, 'SoduWorkLauncher.exe');
      const result = spawnSync(compiler.path, ['/V2', '/INPUTCHARSET', 'UTF8', '/DSODUWORK_LAUNCHER_OUT=' + launcher,
        '/DSODUWORK_ICON=' + path.join(root, 'icon.ico'), path.join(root, 'build/launcher.nsi')],
        { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...compiler.env } });
      if (result.status !== 0) throw new Error('Launcher compilation failed: ' + result.stdout + result.stderr);
      if (context.packager?.signIf) await context.packager.signIf(launcher);
      // Rotate the manifest away: NSIS includes it at compile time, so a
      // build whose inventory stage never runs must not reuse the previous
      // build's hashes.
      await fs.rm(path.join(output, 'native-payload.nsh'), { force: true });
    }
    if (context.appOutDir) {
      // Portable Git ships under resources/shell. Copy it here instead of
      // extraResources so electron-builder's signing transformers never see
      // it: Git binaries carry upstream signatures, and re-signing ~346
      // exes/dlls (signtool spawn + TSA round-trip each) dominated the build
      // time for zero benefit.
      //
      // Existence is the skip criterion. Comparing sizes is unreliable:
      // transparent encryption changes stat metadata asynchronously right
      // after a fresh copy, which would re-trigger the overwrite slow path.
      await copyShellRuntime(root, context.appOutDir);
      // Miniature installer fixtures carry no product runtime manifest.
      if (await fs.stat(path.join(context.appOutDir, 'resources/runtime-manifest.json')).then(() => true, () => false)) {
        require('./verify-runtime.cjs').verify(context.appOutDir, 'win32', { packaged: true });
        require('./verify-runtime.cjs').verifyExecutables(path.join(context.appOutDir, 'resources'), 'win32',
          typeof context.arch === 'string' ? context.arch : ({ 1: 'x64', 3: 'arm64' })[context.arch]);
      } else if (await fs.stat(path.join(root, 'runtime-manifest.json')).then(() => true, () => false)) {
        throw Error('Packaged client runtime manifest is missing');
      }
      // Process bundled HTML documents before the payload inventories them;
      // loose HTML inside the install tree must not survive installation.
      await require('./prepare-html-resources.cjs').prepareHtmlResources(context.appOutDir);
      if (!afterSignWillFire) {
        // Resource editing is disabled for this pack, so afterSign will not
        // fire and these bytes are final: produce the payload here.
        await inventory(context.appOutDir);
        await require('./native-payload.cjs').writeNativePayload(context.appOutDir, output);
      }
    }
    return;
  }

  if (dirOnly) return;
  if (!context.appOutDir) return;
  // Final bytes only: fuses and resource editing have happened by now.
  await inventory(context.appOutDir);
  await require('./native-payload.cjs').writeNativePayload(context.appOutDir, output);
}

async function copyShellRuntime(root, appOutDir) {
  const src = path.join(root, '.runtime', 'git');
  const dest = path.join(appOutDir, 'resources', 'shell');
  // Developer API manuals are not used by the bundled Git/bash runtime. Loose
  // HTML can be wrapped by enterprise document filters after installation.
  // Remove only this optional documentation tree from our own build output;
  // redistribution licenses remain under their original share/licenses paths.
  const docs = path.resolve(dest, 'usr/share/gtk-doc');
  const outputRoot = path.resolve(appOutDir);
  const outputStat = await fs.lstat(outputRoot);
  if (outputRoot === path.resolve(root) || !docs.startsWith(outputRoot + path.sep) ||
      !outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw Error('Unsafe shell documentation output');
  }
  for (let current = docs; current.startsWith(outputRoot + path.sep); current = path.dirname(current)) {
    const stat = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat?.isSymbolicLink()) throw Error('Shell output cannot contain symbolic links');
  }
  const docsStat = await fs.lstat(docs).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (docsStat?.isSymbolicLink()) throw Error('Shell documentation cannot be a symbolic link');
  if (docsStat) await fs.rm(docs, { recursive: true });
  if (!await fs.stat(src).then(() => true, () => false)) return 0;
  let copied = 0;
  async function walk(s, d) {
    await fs.mkdir(d, { recursive: true });
    for (const entry of await fs.readdir(s, { withFileTypes: true })) {
      const sp = path.join(s, entry.name), dp = path.join(d, entry.name);
      if (path.relative(src, sp).replaceAll('\\', '/') === 'usr/share/gtk-doc') continue;
      if (entry.isDirectory()) { await walk(sp, dp); continue; }
      // Existence is the skip criterion. Comparing sizes is unreliable here:
      // transparent encryption changes stat metadata asynchronously right
      // after a fresh copy, which would re-trigger the overwrite slow path.
      if (await fs.stat(dp).then(() => true, () => false)) continue;
      await fs.copyFile(sp, dp);
      copied++;
    }
  }
  await walk(src, dest);
  return copied;
}

async function inventory(root) {
  const crypto = require('node:crypto');
  const { createReadStream } = require('node:fs');
  await fs.copyFile(path.resolve(__dirname, '../build/verify-payload.cjs'), path.join(root, '.soduwork-verify.cjs'));
  await fs.copyFile(path.resolve(__dirname, '../build/prune-versions.cjs'), path.join(root, '.soduwork-prune.cjs'));
  const { isNoticePath, noticeCandidate, NOTICE_BUNDLE, NOTICE_LIMIT, STATIC_TEXT_BUNDLE, isStaticTextPath } = require('../build/verify-payload.cjs');
  const { gzipSync } = require('node:zlib');
  const files = [], notices = [], staticTexts = [];

  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.soduwork-payload.json' || (dir === root && [NOTICE_BUNDLE, STATIC_TEXT_BUNDLE].includes(entry.name))) continue;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error('Payload cannot contain symbolic links: ' + file);
      if (entry.isDirectory()) { await visit(file); continue; }
      const hash = crypto.createHash('sha256');
      // Inventory the exact bytes being hashed, independently of filesystem filter metadata.
      let size = 0;
      for await (const chunk of createReadStream(file)) { size += chunk.length; hash.update(chunk); }
      const relative = path.relative(root, file).replaceAll('\\', '/');
      const item = { path: relative, size, sha256: hash.digest('hex') };
      files.push(item);
      if (isStaticTextPath(relative)) {
        const original = await fs.readFile(file);
        if (original.length !== size || crypto.createHash('sha256').update(original).digest('hex') !== item.sha256) throw Error('Unstable static text source: ' + relative);
        staticTexts.push({ path: relative, content: original.toString('base64') });
      }
      if (noticeCandidate(relative) && !isNoticePath(relative)) throw Error('Unclassified redistribution notice: ' + relative);
      if (isNoticePath(relative)) {
        const original = await fs.readFile(file);
        // A binary or already protected document is not a valid build source.
        const text = new TextDecoder('utf-8', { fatal: true }).decode(original);
        if (text.includes('\0') || original.length !== size || crypto.createHash('sha256').update(original).digest('hex') !== item.sha256) {
          throw Error('Invalid redistribution notice source: ' + relative);
        }
        notices.push({ path: relative, content: original.toString('base64') });
      }
    }
  }
  await visit(root);
  let noticeBundle;
  if (notices.length) {
    const raw = Buffer.from(JSON.stringify({ schema: 1, files: notices }));
    if (raw.length > NOTICE_LIMIT) throw Error('Redistribution notice bundle exceeds supported size');
    const compressed = gzipSync(raw);
    noticeBundle = { path: NOTICE_BUNDLE, size: compressed.length, sha256: crypto.createHash('sha256').update(compressed).digest('hex') };
    await fs.writeFile(path.join(root, NOTICE_BUNDLE), compressed);
    files.push(noticeBundle);
  } else {
    await fs.rm(path.join(root, NOTICE_BUNDLE), { force: true });
  }
  let staticTextBundle;
  if (staticTexts.length) {
    const raw = Buffer.from(JSON.stringify({ schema: 1, files: staticTexts }));
    if (raw.length > NOTICE_LIMIT) throw Error('Static text bundle exceeds supported size');
    const compressed = gzipSync(raw);
    staticTextBundle = { path: STATIC_TEXT_BUNDLE, size: compressed.length, sha256: crypto.createHash('sha256').update(compressed).digest('hex') };
    await fs.writeFile(path.join(root, STATIC_TEXT_BUNDLE), compressed);
    files.push(staticTextBundle);
  } else {
    await fs.rm(path.join(root, STATIC_TEXT_BUNDLE), { force: true });
  }
  await fs.writeFile(path.join(root, '.soduwork-payload.json'), JSON.stringify({ schema: 1, files, noticeBundle, staticTextBundle }));
}

module.exports = prepare;
module.exports.inventory = inventory;
if (require.main === module) prepare().catch(error => { console.error(error); process.exitCode = 1; });
