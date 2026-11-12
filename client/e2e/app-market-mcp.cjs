'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 90000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, safeStorage } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const http = require('node:http'), assert = require('node:assert/strict');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-market-e2e-'));
  app.setPath('userData', root);
  let python, server, resolved;
  const report = { ok: false, cases: [], boundary: 'Isolated Electron main-process connection/store/grant/proxy and real loopback Hub APIs, package review, catalog and installation; authentication fixture only; no model, production profile or business service.' };
  app.whenReady().then(async () => {
    let businessCalls = 0;
    server = http.createServer((req, res) => {
      assert.equal(req.url, '/mcp');
      if (req.headers.authorization !== 'Bearer fixture-app-credential') {
        res.writeHead(401, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({error:'Invalid application credential'}));
      }
      businessCalls++;
      let raw = '';
      req.on('data',chunk=>{raw+=chunk;});
      req.on('end',()=>{
        const rpc = JSON.parse(raw || '{}');
        if (rpc.method?.startsWith('notifications/')) {res.writeHead(202);return res.end();}
        const result = rpc.method === 'initialize'
          ? {protocolVersion:rpc.params.protocolVersion,capabilities:{}}
          : rpc.method === 'tools/call' && rpc.params.name === 'whoami'
            ? {content:[{type:'text',text:'Fixture account'}],structuredContent:{userId:'fixture-business-user'}}
            : {tools:[{name:'whoami',description:'Fixture identity',inputSchema:{type:'object',properties:{}}}]};
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? 1, result }));
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + server.address().port;
    python = require('node:child_process').spawn(path.resolve(__dirname, '../../hub-backend/.venv/Scripts/python.exe'),
      [path.join(__dirname, 'fixtures/market-app-hub.py'), origin], {
        cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, AUTH_SECRET: 'isolated-market-e2e-secret-000000000000000000',
          ADMIN_PASS: 'isolated-market-password', DATABASE_URL: 'sqlite+aiosqlite:///:memory:',
          CLUSTER_REDIS_URL: '', SODUWORK_ENV: 'development', PYTHONIOENCODING: 'utf-8' },
      });
    let diagnostics = '';
    python.stderr.on('data', data => { diagnostics += data.toString(); });
    const hub = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(Error('Fixture startup timeout: ' + diagnostics)), 30000);
      python.once('error', reject);
      python.once('exit', code => { clearTimeout(timer); reject(Error('Fixture exited ' + code + ': ' + diagnostics)); });
      python.stdout.on('data', data => {
        out += data.toString();
        if (out.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(out.split('\n')[0]).hub); }
      });
    });
    let metadata;
    for (let i = 0; i < 200; i++) {
      try { const response = await fetch(hub + '/fixture/ready'); if (response.ok) { metadata = await response.json(); break; } } catch (_) {}
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(metadata?.pluginId, diagnostics);
    const identityOf = async () => ({ hub, clientId: 'fixture-device', session: 'fixture-session' });
    const headers = { Authorization: 'Device fixture-session', 'Content-Type': 'application/json' };
    const preflight = await fetch(hub + '/fixture/preflight', {method:'POST',headers});
    assert.equal(preflight.status,200);
    const checks = await preflight.json();
    assert.ok(checks.checks.some(row=>row.key==='app-mcp' && row.ok && row.verification==='declaration'));
    assert.ok(!checks.blockers.some(text=>text.includes('企业尚未启用') || text.includes('只批准插件实际需要')));
    assert.ok(checks.warnings.some(text=>text.includes('未验证用户凭据或服务连通性')));
    report.cases.push('The production preflight service recognizes the approved app MCP without company registration and explicitly leaves credentials/connectivity unverified.');
    const install = await fetch(hub + '/api/v1/plugins/' + metadata.pluginId + '/installation', {
      method: 'PUT', headers, body: JSON.stringify({ enabled: true, expectedVersionId: metadata.versionId }),
    });
    assert.equal(install.status, 200, await install.text());
    const store = require('../main/app-settings-store.cjs');
    store.configure({ app, safeStorage, ownerOf: () => 'fixture-account' });
    store.update({ pluginId: metadata.pluginId, origin }, {
      values: { ukey: 'fixture-invalid-credential' }, secretKeys: ['ukey'],
    });
    const invalidContext = await require('../main/app-conversation-connection.cjs').context(app,metadata.pluginId,{app,identityOf});
    const invalidLease = await require('../main/pi-session/app-mcp-proxy.cjs').create(invalidContext.connection);
    try {
      const rejected = await fetch(invalidLease.url,{method:'POST',headers:{Authorization:'Bearer '+invalidLease.token},body:'{}'});
      assert.equal(rejected.status,401);
      assert.equal(businessCalls,0);
    } finally { invalidLease.cleanup(); }
    store.update({pluginId:metadata.pluginId,origin},{values:{ukey:'fixture-app-credential'},secretKeys:['ukey']});
    report.cases.push('Invalid stored app credentials still fail at the actual service; installing the app or passing declaration checks cannot bypass authentication.');
    const connection = require('../main/work-preview-app-connection.cjs');
    const item = { appBridge: { appId: 'plugin:' + metadata.pluginId, contributionId: 'main', origin },
      view: { webContents: { isDestroyed: () => false, getURL: () => origin + '/' } } };
    const deps = { app, identityOf };
    require('../main/work-preview-app-owner.cjs').capture(item, deps);
    assert.equal((await connection.connect({ item }, { server: 'fixture-business', url: origin + '/mcp', credentialKey: 'ukey' }, deps)).connected, true);
    resolved = await require('../main/pi-session/plugin-grant').resolve({ ...deps, cwd: root,
      pluginIds: [metadata.pluginId], appContext: { pluginId: metadata.pluginId,
        requiresMcp: true, connection: connection.resolve(item, deps) } });
    const spec = JSON.parse(fs.readFileSync(resolved.grant.configFile)).servers['fixture-business'];
    assert.equal(spec.appLease, true);
    assert.deepEqual(resolved.grant.servers, ['fixture-business']);
    const call = () => fetch(spec.url, { method: 'POST', headers: spec.headers, body: '{}' });
    assert.equal((await call()).status, 200);
    assert.equal(businessCalls, 1);
    report.cases.push('Real approved market package installs with on_install policy and no company MCP; production native bridge and turn resolver reach owned MCP.');
    resolved.grant.cleanup();
    await assert.rejects(require('../main/pi-session/plugin-grant').resolve({ ...deps, cwd: root,
      pluginIds: [metadata.pluginId] }), /插件需要但企业尚未启用的 MCP.*fixture-business/,
    'missing application context reproduces the reported enterprise-MCP error');
    const ownership = require('../main/pi-session/app-mcp-grant.cjs');
    const handle = { snapshot: () => ({ activePlugins: [metadata.pluginId] }) };
    // No native app window or live connection object: only the accepted
    // installation and the existing account-scoped encrypted settings remain.
    ownership.bind(handle, null, '', app, deps);
    const historyTurn = {};
    await ownership.guardSend(handle, historyTurn);
    await historyTurn.beforeTurn();
    resolved = await require('../main/pi-session/plugin-grant').resolve({ ...deps, cwd: root,
      pluginIds: [metadata.pluginId], appContext: await ownership.forSession(handle) });
    const restored = JSON.parse(fs.readFileSync(resolved.grant.configFile)).servers['fixture-business'];
    assert.equal(restored.appLease, true);
    const callRestored = () => fetch(restored.url, { method: 'POST', headers: restored.headers, body: '{}' });
    assert.equal((await callRestored()).status, 200);
    assert.equal(businessCalls, 2);
    report.cases.push('A market history turn restores its accepted version and owned MCP from encrypted settings without a window or company connector.');
    store.update({pluginId:metadata.pluginId,origin}, {values:{theme:'light',accountName:'Updated display name'}});
    assert.deepEqual((await Promise.all([callRestored(),callRestored()])).map(r=>r.status),[200,200]);
    assert.equal(businessCalls,4);
    report.cases.push('Concurrent headless MCP consumers keep using the stored credential after display preferences change; no page login or token exchange occurs.');
    const identity = await new Promise((resolve,reject)=>{
      const child = require('node:child_process').spawn(process.execPath,[
        path.resolve(__dirname,'../../skills/mcp-tools/scripts/mcp.mjs'),
        '--config',resolved.grant.configFile,'call','fixture-business','whoami','{}',
      ],{windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',SODUWORK_MCP_JSON:'1'},stdio:['ignore','pipe','pipe']});
      let out='',err='';const timer=setTimeout(()=>{child.kill();reject(Error('MCP bridge timeout'));},15000);
      child.stdout.on('data',data=>{out+=data;});child.stderr.on('data',data=>{err+=data;});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(Error(err));else {try{resolve(JSON.parse(out));}catch(error){reject(error);}}});
    });
    assert.equal(identity.structuredContent.userId,'fixture-business-user');
    report.cases.push('The production MCP CLI bridge completes initialize and a real tools/call through the restored grant and returns the application identity.');
    const beforeUninstall = businessCalls;
    const uninstalled = await fetch(hub + '/fixture/uninstall', { method: 'POST', headers });
    assert.equal(uninstalled.status, 200);
    assert.equal((await callRestored()).status, 401);
    assert.equal(businessCalls, beforeUninstall);
    report.cases.push('Uninstall revokes an existing application lease before another business call.');
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(async () => {
    resolved?.grant?.cleanup();
    if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    if (python && python.exitCode === null) {
      const exited = new Promise(r => python.once('exit', r));
      python.kill(); await exited;
    }
    console.log(JSON.stringify(report));
    app.exit(report.ok ? 0 : 1);
  });
}
