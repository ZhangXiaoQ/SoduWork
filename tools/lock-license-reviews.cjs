'use strict';
// Exact locked-package evidence, not a general license allowlist or publication clearance.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const validPath = name => typeof name === 'string' && name.length > 0 &&
  !/[\\:\0]/.test(name) && !name.startsWith('/') &&
  name.split('/').every(part => part && part !== '.' && part !== '..');
const key = (lock, name) => lock + ':' + name;

function check(root, manifest) {
  const errors = [], accepted = new Set(), seen = new Set();
  const reviews = manifest.lockLicenseReviews || [];
  if (!Array.isArray(reviews)) return { accepted, errors: ['Invalid locked-license review records'] };
  function read(name) {
    if (!validPath(name)) throw Error('Unsafe locked-license evidence path');
    let current = root;
    for (const part of name.split('/')) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw Error('Linked locked-license evidence: ' + name);
    }
    if (!fs.statSync(current).isFile()) throw Error('Invalid locked-license evidence file: ' + name);
    return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(current)).replace(/\r\n/g, '\n');
  }
  function evidence(entry) {
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error('Invalid locked-license evidence digest');
    const content = read(entry.path);
    if (crypto.createHash('sha256').update(content).digest('hex') !== entry.sha256) {
      throw Error('Changed locked-license evidence: ' + entry.path);
    }
    return content;
  }
  for (const review of reviews) {
    const label = key(review?.lock, review?.package);
    try {
      if (!review || !validPath(review.lock) || !manifest.locks.includes(review.lock) ||
          !validPath(review.package) || !review.package.startsWith('node_modules/') ||
          !review.reviewBasis || !Array.isArray(review.licenses) || !review.licenses.length ||
          new Set(review.licenses).size !== review.licenses.length ||
          !review.licenses.every(value => /^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(value)) ||
          !Array.isArray(review.notices) || !review.notices.length) throw Error('Incomplete locked-license review');
      if (seen.has(label)) throw Error('Duplicate locked-license review');
      seen.add(label);
      const pkg = JSON.parse(read(review.lock)).packages?.[review.package];
      if (!pkg || ['version', 'integrity', 'resolved'].some(field =>
        typeof review[field] !== 'string' || !review[field] || pkg[field] !== review[field]) ||
          typeof review.declaredLicense !== 'string' || pkg.license !== review.declaredLicense) {
        throw Error('Locked dependency changed; refresh its license evidence');
      }
      const metadata = JSON.parse(evidence(review.metadata));
      if (metadata.name !== review.package.split('node_modules/').at(-1) ||
          metadata.version !== review.version || metadata.license !== review.declaredLicense) {
        throw Error('Package metadata does not match locked-license review');
      }
      // Support only the simple declarations actually evidenced here. Do not infer
      // compatibility for arbitrary SPDX expressions or discard an AND obligation.
      const declaration = review.declaredLicense.replace(/^\(([^()]+)\)$/, '$1');
      const choice = declaration.split(' OR '), required = declaration.split(' AND ');
      const resolved = review.licenses;
      const validResolution = choice.length > 1
        ? resolved.length === 1 && choice.includes(resolved[0])
        : declaration === 'BSD'
          ? resolved.length === 1 && ['BSD-2-Clause', 'BSD-3-Clause'].includes(resolved[0])
          : required.length === resolved.length && required.every(value => resolved.includes(value));
      if (!validResolution) throw Error('License resolution changes the declared alternatives or obligations');
      if (review.notices.some(notice => !resolved.includes(notice.license)) ||
          resolved.some(license => !review.notices.some(notice => notice.license === license))) {
        throw Error('Missing original notice for a resolved license');
      }
      for (const notice of review.notices) evidence(notice);
      accepted.add(label);
    } catch (error) {
      errors.push('Invalid locked-license review ' + label + ': ' + error.message);
    }
  }
  return { accepted, errors };
}
module.exports = { check, key };
