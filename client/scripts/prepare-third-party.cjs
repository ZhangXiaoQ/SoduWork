'use strict';
// Runs at build time only. No runtime scanning, network requests or package changes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { check, ROOT } = require('../../tools/check-third-party.cjs');
const read = file => fs.readFileSync(file, 'utf8');
function distributionReview(root, internal = false) {
  const release = JSON.parse(read(path.join(root, 'third-party/public-release.json')));
  const profile = JSON.parse(read(path.join(root, 'tools/distribution/PUBLIC-SOURCE.json')));
  if (release.schema !== 1 || !Array.isArray(release.pending) ||
      release.pending.some(row => !row.id || !row.reason) ||
      profile.schema !== 1 || typeof profile.sourceOnly !== 'boolean') throw Error('Invalid distribution review records');
  const blockers = release.pending.map(row => row.id);
  if (profile.sourceOnly) blockers.unshift('source-only-release-scope');
  if (!internal && blockers.length) throw Error('Public installer distribution is blocked: ' + blockers.join(', ') +
    '. SODUWORK_INTERNAL_BUILD=1 permits an internal validation build only; it does not grant public distribution rights.');
  return {schema: 1, internalOnly: internal, publicDistributionAllowed: !internal && blockers.length === 0, blockers};
}
function matches(pattern, value) {
  return pattern.endsWith('*') ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
}
function packages(directory) {
  const result = [];
  if (!fs.existsSync(directory)) throw new Error('Install locked dependencies before packaging: ' + directory);
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!item.isDirectory() || item.name.startsWith('.')) continue;
    const child = path.join(directory, item.name);
    if (item.name.startsWith('@')) result.push(...packages(child));
    else {
      if (fs.existsSync(path.join(child, 'package.json'))) result.push(child);
      if (fs.existsSync(path.join(child, 'node_modules'))) result.push(...packages(path.join(child, 'node_modules')));
    }
  }
  return result;
}
function collect(packageDirs, root, output, manifest) {
  fs.mkdirSync(output, { recursive: true });
  const rows = [], errors = [];
  for (const dir of [...new Set(packageDirs)].sort()) {
    const pkg = JSON.parse(read(path.join(dir, 'package.json')));
    const files = fs.readdirSync(dir).filter(name => /^(?:licen[cs]e|copying|copyright|notice)(?:[.\-_]|$)/i.test(name) && fs.statSync(path.join(dir, name)).isFile());
    const noticeTexts = files.map(name => ({ name, content: read(path.join(dir, name)) }));
    if (!noticeTexts.length) {
      // Some upstream packages put the complete grant in README, not LICENSE.
      const readme = fs.readdirSync(dir).find(name => /^readme(?:\.md)?$/i.test(name));
      if (readme) {
        const content = read(path.join(dir, readme));
        const grant = content.replace(/\s+/g, ' ');
        if (/Copyright\s+(?:\(c\)\s*)?\S/i.test(grant) &&
            /Permission is hereby granted, free of charge/.test(grant) &&
            /The above copyright notice and this permission notice shall be included/.test(grant) &&
            /THE SOFTWARE IS PROVIDED ["'“]AS IS["'”]/.test(grant) &&
            /LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE/.test(grant)) {
          noticeTexts.push({ name: readme, content });
        }
      }
    }
    let override, review;
    if (!noticeTexts.length) {
      override = manifest.runtimeNoticeOverrides.find(row => matches(row.name, pkg.name) && row.version === pkg.version);
      if (override) {
        const notice = manifest.notices.find(row => row.id === override.notice);
        if (!notice) throw new Error('Missing override snapshot: ' + override.notice);
        noticeTexts.push({ name: path.basename(notice.path), content: read(path.join(root, notice.path)) });
      } else {
        review = manifest.runtimeNoticeReviews.find(row => matches(row.name, pkg.name) && row.version === pkg.version);
        if (!review) errors.push('Missing original license: ' + pkg.name + '@' + pkg.version);
        // Retain upstream evidence without inventing copyright or claiming clearance.
        for (const name of fs.readdirSync(dir).filter(name => /^readme(?:\.md)?$/i.test(name))) noticeTexts.push({ name, content: read(path.join(dir, name)) });
      }
    }
    const relative = path.relative(root, dir).replace(/\\/g, '/');
    const id = pkg.name.replace(/[^a-z0-9_.-]/gi, '_') + '-' + pkg.version + '-' + crypto.createHash('sha256').update(relative).digest('hex').slice(0, 8);
    const target = path.join(output, id);
    fs.mkdirSync(target, { recursive: true });
    for (const notice of noticeTexts) fs.writeFileSync(path.join(target, notice.name), notice.content, 'utf8');
    const row = { name: pkg.name, version: pkg.version, license: pkg.license || '', repository: pkg.repository || '',
      sourcePath: relative, notices: noticeTexts.map(item => id + '/' + item.name),
      status: review ? 'upstream-confirmation-needed' : 'notice-collected', ...(override ? { originalNotice: override.notice } : {}), ...(review ? { review } : {}) };
    fs.writeFileSync(path.join(target, 'package-evidence.json'), JSON.stringify({ name: pkg.name, version: pkg.version, license: pkg.license, author: pkg.author, repository: pkg.repository }, null, 2) + '\n');
    rows.push(row);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  fs.writeFileSync(path.join(output, 'npm-notices.json'), JSON.stringify({ schema: 1, scope: 'Desktop Pi runtime and SSH dependencies actually copied by extraResources; not a full native/Python SBOM', packages: rows }, null, 2) + '\n');
  return rows;
}
async function prepare(context) {
  if (context?.packager) require('./client-build-version.cjs').prepareVersionFile(context);
  const result = check();
  if (!result.ok) throw new Error(result.errors.join('\n'));
  await require('./prepare-client-runtime.cjs')(context);
  const manifest = JSON.parse(read(path.join(ROOT, 'third-party/manifest.json')));
  const client = path.join(ROOT, 'client');
  const installed = JSON.parse(read(path.join(client, 'node_modules/@earendil-works/pi-coding-agent/package.json')));
  if (installed.version !== manifest.piVersion) throw new Error('Installed Pi differs from package-lock: run npm ci before packaging');
  const output = path.join(client, '.runtime/compliance');
  // Fixed output inside this checkout; never delete a user-supplied path.
  if (!output.startsWith(client + path.sep)) throw new Error('Unsafe compliance output');
  fs.rmSync(output, { recursive: true, force: true });
  const staged = require('./prepare-pi-runtime.cjs').preparePiRuntime(client);
  const dirs = packages(path.join(staged.output, 'node_modules'));
  for (const name of ['ssh2', 'asn1', 'bcrypt-pbkdf', 'safer-buffer', 'tweetnacl']) dirs.push(path.join(client, 'node_modules', name));
  const rows = collect(dirs, ROOT, output, manifest);
  const shell = path.join(client, '.runtime/git');
  if (context?.electronPlatformName === 'win32') {
    for (const name of ['LICENSE.txt', 'etc/package-versions.txt', '.soduwork-shell-runtime.json']) {
      const file = path.join(shell, name);
      if (!fs.existsSync(file)) throw new Error('Missing PortableGit distribution evidence: ' + name);
      fs.copyFileSync(file, path.join(output, 'PortableGit-' + path.basename(name)));
    }
  }
  const pending = rows.filter(row => row.status !== 'notice-collected');
  if (!distribution.internalOnly && pending.length) throw Error('Unresolved original runtime notices block public distribution');
  fs.writeFileSync(path.join(output, 'distribution-review.json'), JSON.stringify(distribution, null, 2) + '\n');
  console.log('[third-party] Collected ' + rows.length + ' package notices; ' + pending.length + ' upstream confirmations remain (see third-party/README.md).');
  return rows;
}
module.exports = prepare;
module.exports.collect = collect;
module.exports.packages = packages;
module.exports.distributionReview = distributionReview;
if (require.main === module) prepare({ electronPlatformName: process.platform }).catch(error => { console.error(error.message); process.exitCode = 1; });
