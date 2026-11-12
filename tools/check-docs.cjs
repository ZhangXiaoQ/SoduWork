'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sourceFiles } = require('./source-files.cjs');
const ROOT = path.resolve(__dirname, '..');
const PAIRS = [
  ['README.md', 'README.zh-CN.md'], ['docs/README.md', 'docs/README.zh-CN.md'],
  ['CONTRIBUTING.md', 'docs/contributing.zh-CN.md'], ['SECURITY.md', 'docs/security.zh-CN.md'],
  ['NOTICE.md', 'NOTICE.zh-CN.md'],
  ...['getting-started', 'development', 'release-scope', 'open-source', 'plugin-authoring', 'model-services']
    .map(name => [`docs/${name}.md`, `docs/${name}.en.md`]),
  ...['client', 'hub-backend', 'hub-frontend', 'third-party', 'ops/self-host', 'client/sdk']
    .map(name => [`${name}/README.md`, `${name}/README.zh-CN.md`]),
  ['hub-backend/CONNECTOR_OAUTH.md', 'hub-backend/CONNECTOR_OAUTH.en.md'],
];

function prose(text) {
  return text.replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[ \t]*$/gm, '');
}
function links(text) {
  return [...prose(text).matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)].map(match => match[1]);
}
function anchors(text) {
  const seen = new Map(), result = new Set();
  for (const match of prose(text).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const slug = match[1].trim().replace(/<[^>]*>/g, '').replace(/[`*]/g, '').toLowerCase()
      .replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-');
    const count = seen.get(slug) || 0;
    seen.set(slug, count + 1);
    result.add(slug + (count ? '-' + count : ''));
  }
  return result;
}
function audit(root, names, pairs = PAIRS) {
  const errors = [], texts = new Map();
  let checkedLinks = 0;
  for (const name of names) texts.set(name, fs.readFileSync(path.join(root, name), 'utf8'));
  for (const [name, text] of texts) {
    const imageSources = [...prose(text).matchAll(/<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)]
      .map(match => match[1] ?? match[2] ?? match[3]);
    for (const link of [...links(text), ...imageSources]) {
      if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(link)) continue;
      checkedLinks++;
      const [target, fragment] = link.split('#');
      const full = path.resolve(path.dirname(path.join(root, name)), decodeURIComponent(target || path.basename(name)));
      const relative = path.relative(root, full);
      if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !fs.existsSync(full)) {
        errors.push(`${name}: missing or escaping link ${link}`);
      } else if (fragment && full.endsWith('.md') &&
          !anchors(fs.readFileSync(full, 'utf8')).has(decodeURIComponent(fragment))) {
        errors.push(`${name}: missing heading ${link}`);
      }
    }
  }
  for (const pair of pairs) for (const [from, to] of [pair, [...pair].reverse()]) {
    if (!texts.has(from) || !texts.has(to)) { errors.push(`Missing translation: ${from} / ${to}`); continue; }
    const header = texts.get(from).split(/\r?\n/).slice(0, 5).join('\n');
    const destinations = links(header).map(link => path.resolve(root, path.dirname(from), link.split('#')[0]));
    if (!destinations.includes(path.resolve(root, to))) errors.push(`${from}: missing top language link to ${to}`);
  }
  return { ok: !errors.length, pages: names.length, checkedLinks, languagePairs: pairs.length, errors };
}
function check() {
  const names = sourceFiles(ROOT).filter(name => name.endsWith('.md') && (
    !name.includes('/') || name.startsWith('docs/') || name.startsWith('.github/') || name === 'tools/security/README.md' ||
    /\/README(?:\.en|\.zh-CN)?\.md$/.test(name) || PAIRS.some(pair => pair.includes(name))));
  return audit(ROOT, names);
}
if (require.main === module) {
  try { const result = check(); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { audit, anchors, links, check };
