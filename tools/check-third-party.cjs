'use strict';
// Offline source-distribution checks. This is not legal clearance or a complete SBOM.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const text = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const hash = file => crypto.createHash('sha256').update(text(file)).digest('hex');
function check(root = ROOT) {
  const manifest = JSON.parse(text(path.join(root, 'third-party/manifest.json')));
  const errors = [];
  const sourceReview = require('./check-source-provenance.cjs').check(root);
  errors.push(...sourceReview.errors);
  const lockReviews = require('./lock-license-reviews.cjs').check(root, manifest);
  errors.push(...lockReviews.errors);
  for (const item of [...manifest.notices, ...manifest.vendored]) {
    const file = path.join(root, item.path);
    if (!fs.existsSync(file)) errors.push('Missing reviewed material: ' + item.path);
    else if (hash(file) !== item.sha256) errors.push('Review changed license/source snapshot: ' + item.path);
  }
  for (const item of manifest.binaryVendored || []) {
    const file = path.join(root, item.path);
    if (!fs.existsSync(file)) errors.push('Missing reviewed binary: ' + item.path);
    else if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== item.sha256) {
      errors.push('Review changed binary provenance: ' + item.path);
    }
  }
  for (const name of manifest.skillNotices) {
    for (const file of ['LICENSE', 'UPSTREAM.md']) {
      const item = path.join(root, 'skills', name, file);
      if (!fs.existsSync(item) || text(item).trim().length < 80) errors.push('Missing skill provenance: skills/' + name + '/' + file);
      else if (file === 'LICENSE' && hash(item) !== manifest.skillLicenseHashes[name]) errors.push('Skill original license changed: ' + name);
    }
  }
  for (const file of manifest.locks) {
    const lock = JSON.parse(text(path.join(root, file)));
    for (const [name, pkg] of Object.entries(lock.packages || {})) {
      if (!name) continue;
      let trustedSource = false;
      try {
        const url = new URL(pkg.resolved);
        trustedSource = !pkg.link && url.origin === 'https://registry.npmjs.org' &&
          !url.username && !url.password && !url.search && !url.hash &&
          /^sha(?:256|384|512)-[A-Za-z0-9+/]+=*$/.test(pkg.integrity || '');
      } catch (_) { /* Missing or non-registry sources require review. */ }
      if (!trustedSource) errors.push('Unreviewed dependency source or integrity: ' + file + ':' + name);
      const evidence = manifest.lockLicenseEvidence[name];
      const license = pkg.license || (evidence?.version === pkg.version ? evidence.license : '');
      if (!manifest.reviewedLicenses.includes(license) && !lockReviews.accepted.has(file + ':' + name)) errors.push('Unreviewed dependency license: ' + file + ':' + name + '@' + pkg.version + ' (' + (license || 'unknown') + ')');
    }
    if (file === 'client/package-lock.json') {
      const pi = lock.packages['node_modules/@earendil-works/pi-coding-agent'];
      if (pi?.version !== manifest.piVersion) errors.push('Pi version changed: refresh original notices and bundled runtime inventory');
    }
  }
  const pkg = JSON.parse(text(path.join(root, 'client/package.json')));
  if (pkg.build.beforePack !== 'scripts/prepare-third-party.cjs') errors.push('Desktop packaging must prepare third-party notices');
  for (const [from, to] of [['../third-party', 'third-party'], ['.runtime/compliance', 'third-party/inventory']]) {
    if (!pkg.build.extraResources.some(row => row.from === from && row.to === to)) errors.push('Missing desktop license resource: ' + from);
  }
  return { ok: errors.length === 0, snapshots: manifest.notices.length, skills: manifest.skillNotices.length, errors };
}
if (require.main === module) {
  try { const result = check(); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { check, hash, ROOT };
