"use strict";
// Source snapshots deliberately exclude internal operations and release history.
const roots = new Set(['client', 'hub-backend', 'hub-frontend', 'mobile',
  'mobile-web-dist', 'skin-server', 'skills', 'tools', 'third-party', '.github']);
const rootFiles = new Set(['README.md', 'LICENSE', 'NOTICE.md', 'CONTRIBUTING.md',
  'SECURITY.md', '.gitignore', '.gitattributes', '.dockerignore', 'start.py',
  'start.cmd', 'start.sh', 'start.command', 'deploy.py', 'deploy.cmd', 'deploy.sh', 'Dockerfile.server']);
const internalServices = ['change_hygiene', 'cicd_publish', 'gerrit_client', 'gerrit_flow', 'gerrit_review', 'smart_route'];
const internalTests = ['smoke_change_hygiene.py', 'smoke_smart_route.py', 'smoke_gerrit_client.py',
  'smoke_gerrit_flow.py', 'smoke_gerrit_merge.py', 'smoke_gerrit_attested_merge.py', 'smoke_gerrit_nodes.py',
  'smoke_release_channels.py', 'smoke_rollback.py', 'smoke_demo_console.py'];
const internalFiles = new Set([
  ...internalServices.map(name => `hub-backend/app/services/${name}.py`),
  ...internalTests.map(name => `hub-backend/${name}`),
  'hub-backend/plugins/gerrit-autopilot.json', 'docs/design/gerrit-autopilot.md',
  'hub-backend/plugins/delivery-req-184.json', 'hub-backend/plugins/soduwork-bugfix-149.json',
  'hub-backend/plugins/delivery-change-184.json', 'hub-backend/plugins/delivery-bugfix-184.json',
]);
const excluded = [
  /(?:^|\/)(?:node_modules|\.git|\.venv|venv|__pycache__|\.runtime|\.runtime-cache)(?:\/|$)/,
  /(?:^|\/)(?:\.env(?:\.[^/]+)?|\.auth_secret|\.admin_pass|credentials\.json|auth\.json)$/,
  /\.(?:db|sqlite3?|log|pyc|pyo|pem|p12|pfx|key|exe|dll|dmg|msi|appimage)$/i,
  /\.(?:zip|tgz|tar|[a-z0-9-]+-plugin)$/i,
  /^client\/(?:dist[^/]*\/|runner\/(?!README\.md$)|isolated-history\.png$|--disable-gpu$)/,
  /^hub-backend\/(?:uploads|downloads|releases|workspaces|dist|\.local)(?:\/|$)/,
  /^hub-frontend\/dist\//, /^skin-server\/data\//,
  /^hub-backend\/deployers\/[^/]*(?:teahouse|website-local)/,
  /^hub-backend\/deployers\/soduwork-runner-dev\.compose\.yml$/,
  /^hub-frontend\/public\/autodevtest-five-scenarios\.html$/,
  /^skills\/timesheet-fill\//,
  /^docs\/design\/autoloop-fusion\.md$/,
  /^tools\/(?:cdp-eval\.py|inspect-local-cloud\.py|start-requirements-e2e\.ps1)$/,
  /^tools\/ci\/(?:.*\.gitlab\.yml|hub-rollout\.py|hub-node\.py)$/,
  /^mobile-web-dist\/(?!\.gitkeep$)/,
  // Vulnerability-scan reports and e2e run logs are operator tooling output, never public source.
  /(?:^|\/)snyk-[^/]*\.json$/,

];
function include(name) {
  if (internalFiles.has(name)) return false;
  if (name.includes('\\') || name.startsWith('/') || name.split('/').some(x => x === '..' || !x)) return false;
  // These three source archives have a pinned inventory and upstream licenses.
  if (/^hub-backend\/plugins\/platforms\/(?:dingtalk|feishu|wecom)\/upstream\.zip$/.test(name)) return true;
  if (excluded.some(rule => rule.test(name))) return false;
  if (rootFiles.has(name)) return true;
  if (/^ops\/(?:self-host|runner|backup)\//.test(name)) return true;
  if (new Set(['ops/deploy-server.sh', 'ops/rollback-server.sh', 'ops/install-operations.sh',
    'ops/soduworkctl', 'ops/package-server-release.py', 'ops/sign-upload-client-release.mjs',
    'ops/verify-soduwork-quality.ps1']).has(name)) return true;
  if (/^docs\/(?:architecture|design|testing)\//.test(name)) return !name.endsWith('.html');
  if (['docs/getting-started.md', 'docs/open-source.md', 'docs/plugin-authoring.md'].includes(name)) return true;
  return name.includes('/') && roots.has(name.split('/')[0]);
}
// Increment when the public distribution boundary changes; the hash also pins exact rules.
const policyVersion = 2;
module.exports = { include, internalFiles, policyVersion };
