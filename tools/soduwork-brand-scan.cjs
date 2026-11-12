'use strict';

// Retired brand tokens are encoded so this gate does not reintroduce them as source text.
const fs = require('node:fs');
const path = require('node:path');
const { sourceFiles } = require('./source-files.cjs');

const root = path.resolve(__dirname, '..');
const forbidden = [
  '627562626c79',
  '627564646c79',
  '68657a69',
  '736f646f',
].map((hex) => Buffer.from(hex, 'hex').toString('utf8'));
const excluded = /(?:^|\/)(?:node_modules|\.git|\.venv|outputs|work|dist|__pycache__|\.runtime|\.local)(?:\/|$)|^mobile-web-dist\//;
const extensions = /\.(?:[cm]?js|jsx|tsx?|json|jsonl|md|txt|html|css|py|ps1|sh|bat|toml|ya?ml|service|timer|nsh|nsi|dart|sql|svg|xml|ini|conf|cfg|env|lock|spec|plist|desktop|properties|gradle|kts|swift|pbxproj|xcworkspacedata|xcconfig|kt|java|entitlements)$/i;

function containsForbidden(text) {
  return forbidden.some((token) => text.toLocaleLowerCase().includes(token));
}

function inspect(file, content) {
  const hits = content.replace(/^\uFEFF/, '').split(/\r?\n/).flatMap((text, index) =>
    containsForbidden(text) ? [{ line: index + 1, text: text.trim() }] : []);
  return { file, count: hits.length, forbiddenPath: containsForbidden(file), hits };
}

function scan() {
  const rows = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const file of sourceFiles(root)) {
    if (excluded.test(file)) continue;
    if (!extensions.test(file) && !/(?:^|\/)(?:LICENSE|Dockerfile[^/]*|Makefile|\.gitignore|\.gitattributes|soduworkctl)$/.test(file)) continue;
    const full = path.join(root, file);
    const stat = fs.statSync(full, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    let content;
    try {
      content = decoder.decode(fs.readFileSync(full));
    } catch {
      continue;
    }
    rows.push(inspect(file, content));
  }
  return rows;
}

function check() {
  const rows = scan();
  // Public source admits no retained legacy-brand exceptions.
  const errors = rows.flatMap((row) => {
    const result = [];
    if (row.forbiddenPath) result.push(`${row.file}: retired brand in path`);
    for (const hit of row.hits) {
      result.push(`${row.file}:${hit.line}: retired brand in content`);
    }
    return result;
  });
  return {
    ok: errors.length === 0,
    scannedFiles: rows.length,
    forbiddenFiles: rows.filter((row) => row.forbiddenPath || row.count).length,
    forbiddenLines: rows.reduce((sum, row) => sum + row.count, 0),
    errors,
  };
}

// Exact reviewed source lines only. A token, directory, or filename alone is
// never an exemption; changes to retained protocols require a new audit entry.
function retained(file, text, exceptions) {
  return exceptions.some(item => item.file === file && typeof item.reason === 'string' && item.reason.trim() &&
    Array.isArray(item.lines) && item.lines.includes(text));
}

if (require.main === module) {
  const result = check();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

module.exports = { root, forbidden, inspect, scan, check, retained };
