'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const retired = [
  "hub-frontend/src/screens/AutomationHub.jsx",
  "hub-frontend/src/screens/ApprovalPolicies.jsx",
  "hub-frontend/src/screens/automation.css",
  "hub-frontend/src/screens/automation-guide.css",
  "hub-frontend/src/screens/DeliveryBoard.jsx",
  "hub-frontend/src/screens/delivery-board.css",
  "hub-frontend/src/screens/DeliveryOverview.jsx",
  "hub-frontend/src/screens/delivery-setup.css",
  "hub-frontend/src/screens/EnvironmentCenter.jsx",
  "hub-frontend/src/screens/environment-setup.css",
  "hub-frontend/src/screens/ReleaseCenter.jsx",
  "hub-frontend/src/screens/TraceDrawer.jsx",
  "hub-frontend/src/screens/PluginGovernanceOverview.jsx",
  "hub-frontend/src/screens/plugin-governance.css",
  "client/components/panels/panels-approvals.js",
  "client/components/panels/panels-approvals.css"
];

function sources(directory) {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : /\.(jsx?|css)$/.test(file) ? [file] : [];
  });
}

function localImports(source) {
  const modules = [...source.matchAll(/(?:from\s*|import\s*\(?\s*|@import\s*)['"]([^'"]+)['"]/g)].map(match => match[1]);
  const workers = [...source.matchAll(/new\s+Worker\s*\(\s*new\s+URL\s*\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url/g)].map(match => match[2]);
  return [...modules, ...workers].filter(value => value.startsWith('.'));
}

test('admin module graph follows bundled worker URLs as well as static and lazy imports', () => {
  assert.deepEqual(localImports("import x from './a.js'; import('./b.js'); new Worker(new URL('./parse.worker.js', import.meta.url), { type: 'module' });"), ['./a.js', './b.js', './parse.worker.js']);
  assert.deepEqual(localImports("new URL('./not-a-worker.js', import.meta.url); new Worker(new URL('https://external.test/x.js', import.meta.url));"), []);
});

test('retired approval and admin page implementations are removed, not only hidden', () => {
  for (const file of retired) assert.equal(fs.existsSync(path.join(root, file)), false, file);
});

test('every admin source module is reachable and every local import resolves', () => {
  const files = sources(path.join(root, 'hub-frontend/src')), graph = new Map();
  const pending = [...files], known = new Set(files);
  for (const file of pending) {
    const imports = localImports(fs.readFileSync(file, 'utf8'));
    graph.set(file, imports.map(value => {
      const target = path.resolve(path.dirname(file), value);
      const resolved = [target, target + '.js', target + '.jsx', target + '.css']
        .find(name => fs.existsSync(name) && fs.statSync(name).isFile());
      assert.ok(resolved, file + ' imports missing ' + value);
      assert.ok(!path.relative(root, resolved).startsWith('..' + path.sep), 'Local source imports must remain in the repository');
      if (!known.has(resolved)) { known.add(resolved); pending.push(resolved); }
      return resolved;
    }));
  }
  const reached = new Set();
  function visit(file) { if (reached.has(file)) return; reached.add(file); (graph.get(file) || []).forEach(visit); }
  visit(path.join(root, 'hub-frontend/src/main.jsx'));
  assert.deepEqual(files.filter(file => !reached.has(file)), [], 'Do not leave disconnected admin modules in src');
});

test('admin API wrappers all have current source consumers', () => {
  const files = sources(path.join(root, 'hub-frontend/src')).filter(file => /\.jsx?$/.test(file) && !file.endsWith(path.sep + 'api.js'));
  const used = new Set(files.flatMap(file => [...fs.readFileSync(file, 'utf8').matchAll(/\bapi\.(\w+)\b/g)].map(match => match[1])));
  const defined = [...read('hub-frontend/src/api.js').matchAll(/^  (\w+): /gm)].map(match => match[1]);
  assert.deepEqual(defined.filter(name => !used.has(name)), [], 'Remove unused admin-only transport wrappers with their screens');
});

test('client entry manifests resolve scripts and styles without retired approval assets', () => {
  for (const entry of ['client/index.html', 'client/desk.html']) {
    const html = read(entry);
    assert.doesNotMatch(html, /panels-approvals\.(?:js|css)/);
    const refs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map(match => match[1]);
    for (const ref of refs.filter(value => !/^(?:https?:|data:|#)/.test(value))) {
      assert.ok(fs.existsSync(path.resolve(root, 'client', ref.split('?')[0])), entry + ': ' + ref);
    }
  }
});

test('legacy approval links route to the requirement details or confirmation inbox, never a ghost conversation', () => {
  const bridge = read('client/core/win-bridge.js'), boot = read('client/desk-boot.js');
  /*
   * Task review notifications open Hub-backed details cards across devices rather than
   * device-local execution archives.
   */
  assert.match(bridge, /RequirementsDetail\.open\(payload\.taskId\)/);
  assert.match(bridge, /routeToWorkWindow\('history', \{ requirementId: payload\.taskId \}\)/);
  const entry = bridge.slice(bridge.indexOf('global.openApprovalsEntry'), bridge.indexOf('global.openHistoryEntry'));
  assert.doesNotMatch(entry, /openTaskConversation/);
  assert.match(bridge, /TaskApprovalInbox\.open/);
  assert.doesNotMatch(boot, /\bapPanel\b|closeApprovalsPanel/);
  assert.match(boot, /openWorkspace\('history', \{approvalInbox: true\}\)/);
  for (const file of ['client/main.js', 'client/components/panels/task-trace-view.js', 'client/components/panels/task-trace-approval.js']) {
    assert.doesNotMatch(read(file), /approvalView/, 'Old approval page tabs no longer have a consumer');
  }
  const app = read('hub-frontend/src/App.jsx');
  assert.match(app, /automation: 'plugins'/);
  assert.doesNotMatch(app, /import\(['"][^'"]*(?:AutomationHub|ReleaseCenter)/);
});

test('approval enforcement and audit stay available after deleting old surfaces', () => {
  assert.ok(fs.existsSync(path.join(root, 'hub-backend/app/api/approvals.py')));
  assert.ok(fs.existsSync(path.join(root, 'hub-backend/app/services/gate_contract.py')));
  assert.ok(fs.existsSync(path.join(root, 'hub-backend/app/services/approval_routing.py')));
  const approval = read('client/components/panels/task-trace-approval.js');
  assert.match(approval, /decideApproval/);
  assert.match(approval, /canApprove/);
});
