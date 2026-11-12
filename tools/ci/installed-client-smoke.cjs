'use strict';
// Observe the installed application with CDP; never inject business/task results.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { waitForRenderer } = require('./installed-client-inspection.cjs');
const { acceptanceTiming } = require('./installed-client-timing.cjs');
const { connect } = require('./installed-client-cdp.cjs');
const { secureStorageProbe } = require('./installed-client-secure-storage.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const [entry, installRoot, profile, output, expectedVersion, markerMode = 'write'] = process.argv.slice(2);
  for (const value of [entry, installRoot, profile, output]) assert.ok(path.isAbsolute(value));
  assert.ok(path.basename(profile).startsWith('soduwork-acceptance-profile-'));
  if (process.platform === 'win32') {
    const ownedRoot = path.dirname(installRoot);
    assert.ok(path.basename(ownedRoot).startsWith('soduwork-install-acceptance-'));
    assert.equal(path.dirname(ownedRoot).toLowerCase(), require('node:os').tmpdir().toLowerCase());
    assert.ok(profile.toLowerCase().startsWith(ownedRoot.toLowerCase() + path.sep));
  }
  assert.ok(['write', 'read'].includes(markerMode));
  const timing = acceptanceTiming(entry);
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const sentinel = path.join(profile, 'acceptance-sentinel.txt');
  if (markerMode === 'write') fs.writeFileSync(sentinel, 'preserve-install-acceptance-data');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve-install-acceptance-data');
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const inspectorServer = net.createServer();
  await new Promise(resolve => inspectorServer.listen(0, '127.0.0.1', resolve));
  const inspectorPort = inspectorServer.address().port;
  await new Promise(resolve => inspectorServer.close(resolve));
  const log = fs.openSync(output + '.app.log', 'w');
  const env = { ...process.env, SODUWORK_USER_DATA: profile,
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    `--inspect=127.0.0.1:${inspectorPort}`, `--user-data-dir=${profile}`,
    '--disable-gpu', '--host-resolver-rules=MAP * 127.0.0.1', '--proxy-server=http://127.0.0.1:9'];
  // Containers do not provide a desktop login's Chromium sandbox namespace.
  if (process.env.SODUWORK_ACCEPTANCE_CONTAINER === '1') args.push('--no-sandbox');
  // Isolated test profiles contain no user credentials. Electron's test keychain
  // avoids interactive prompts from ad-hoc app copies; production release checks
  // opt into the real login Keychain through SODUWORK_MAC_REAL_KEYCHAIN.
  // https://releases.electronjs.org/pr/53790
  const realKeychain = process.platform === 'darwin' && process.env.SODUWORK_MAC_REAL_KEYCHAIN === '1';
  if (process.platform === 'darwin' && !realKeychain) args.push('--use-mock-keychain');
  const child = spawn(entry, args, { env, stdio: ['ignore', log, log],
    detached: process.platform !== 'win32', windowsHide: false });
  let launchError;
  child.on('error', error => { launchError = error; });
  const report = { ok: false, entry, installRoot, profile, expectedVersion, markerMode, timing,
    startedAt: new Date().toISOString(), phases: [], currentPhase: 'launch', pages: [], limitations: ['No authenticated Hub, model call, or interactive desktop acceptance.'] };
  const started = Date.now();
  const phase = name => { report.currentPhase = name; report.phases.push({ phase: name, elapsedMs: Date.now() - started }); };
  child.on('exit', (code, signal) => { report.processExit = { code, signal, elapsedMs: Date.now() - started, phase: report.currentPhase }; });
  const trace = scope => value => report.phases.push({ phase: report.currentPhase, scope, ...value });
  if (process.platform === 'darwin' && !realKeychain) report.limitations.push(
    'Isolated macOS test uses mock Keychain; system Keychain authorization and credential migration are not certified.');
  const sockets = [];
  const timeout = setTimeout(() => child.kill(), timing.totalMs);
  try {
    let pages = [];
    phase('renderer-discovery');
    const discoveryDeadline = Date.now() + timing.discoveryMs;
    while (Date.now() < discoveryDeadline) {
      if (launchError) throw launchError;
      if (process.platform === 'darwin' && (child.exitCode !== null || child.signalCode !== null))
        throw Error('Installed application exited before opening a renderer');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
        pages = (await response.json()).filter(row => row.type === 'page' && row.url.startsWith('file:'));
        if (pages.length) break;
      } catch (_) { /* Wait for the actual application to open its window. */ }
      await delay(500);
    }
    assert.ok(pages.length, 'Installed application never opened a renderer');
    phase('main-inspector-discovery');
    const response = await fetch(`http://127.0.0.1:${inspectorPort}/json/list`, { signal: AbortSignal.timeout(timing.commandMs) });
    const targets = await response.json();
    assert.ok(targets[0]?.webSocketDebuggerUrl, 'Main inspector target is missing');
    const mainSocket = await connect(targets[0].webSocketDebuggerUrl, { timeoutMs: timing.commandMs, trace: trace('main') }); sockets.push(mainSocket);
    const evaluateMain = async expression => {
      const value = await mainSocket.call('Runtime.evaluate', { expression, returnByValue: true });
      assert.equal(value.exceptionDetails, undefined, 'Main process inspection failed');
      return value.result.value;
    };
    phase('main-runtime-identity');
    report.runtimeStart = await evaluateMain("(()=>{const {app}=process.mainModule.require('electron');return {version:app.getVersion(),arch:process.arch,pid:process.pid,exe:process.execPath,profile:app.getPath('userData'),appPath:app.getAppPath(),packaged:app.isPackaged}})()");
    if (timing.translated) assert.equal(report.runtimeStart.arch, 'x64', 'Expected the inspected Intel application');
    assert.equal(report.runtimeStart.version, expectedVersion, 'Running application version differs');
    assert.equal(path.resolve(report.runtimeStart.profile).toLowerCase(), path.resolve(profile).toLowerCase(), 'Application ignored profile isolation');
    assert.equal(report.runtimeStart.packaged, true, 'Expected the actual installed application');
    phase('secure-storage');
    report.secureStorage = await evaluateMain('(' + secureStorageProbe.toString() + ')(' +
      JSON.stringify(profile) + ',' + JSON.stringify(markerMode) + ')');
    assert.equal(report.secureStorage.roundTrip, true, 'Electron safeStorage round-trip failed');
    for (const page of pages) {
      phase('renderer-connect-' + report.pages.length);
      const socket = await connect(page.webSocketDebuggerUrl, { timeoutMs: timing.commandMs, trace: trace('renderer-' + report.pages.length) }); sockets.push(socket);
      const call = socket.call;
      phase('renderer-ready-' + report.pages.length);
      const dom = await waitForRenderer(call, { timeoutMs: timing.rendererMs });
      assert.equal(dom.ready, 'complete');
      assert.ok(dom.scripts > 0 && dom.body.length > 0, 'Renderer is empty');
      const key = 'soduwork-install-acceptance-marker';
      phase('renderer-data-' + report.pages.length);
      if (markerMode === 'write') await call('Runtime.evaluate', { expression: `localStorage.setItem('${key}','preserved')` });
      const stored = await call('Runtime.evaluate', { returnByValue: true, expression: `localStorage.getItem('${key}')` });
      assert.equal(stored.result.value, 'preserved', 'Renderer user data was not preserved');
      phase('renderer-screenshot-' + report.pages.length);
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      const screenshot = output + '.page-' + report.pages.length + '.png';
      fs.writeFileSync(screenshot, Buffer.from(shot.data, 'base64'));
      report.pages.push({ ...dom, screenshot, localStoragePreserved: true });
      if (page === pages.at(-1)) {
        phase('graceful-exit');
        // Ask Electron to exit normally through its local main-process inspector.
        // This is automation, not evidence of clicking the native confirmation UI.
        await evaluateMain("process.mainModule.require('electron').session.defaultSession.flushStorageData(); setTimeout(() => process.mainModule.require('electron').app.quit(), 100); true");
        mainSocket.close();
        let exited = false;
        const exitDeadline = Date.now() + timing.exitMs;
        while (Date.now() < exitDeadline) {
          try { process.kill(report.runtimeStart.pid, 0); } catch (error) { if (error.code === 'ESRCH') exited = true; else throw error; }
          if (exited) break;
          await delay(100);
        }
        assert.ok(exited, 'Application did not exit normally after its Exit request');
        report.gracefulExit = true;
      }
      socket.close();
    }
    report.ok = true;
    phase('complete');
  } catch (error) { report.error = error.stack; throw error; }
  finally {
    clearTimeout(timeout);
    for (const socket of sockets) socket.close();
    if (process.platform === 'win32') {
      // The NSIS stable launcher exits after creating Electron. Kill only PIDs
      // whose executable is below this explicitly supplied acceptance root.
      const cleanup = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$p=$env:SODUWORK_ACCEPTANCE_INSTALL_ROOT.TrimEnd('\\')+'\\';Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($p,[StringComparison]::OrdinalIgnoreCase) -and $_.ProcessId -ne [int]$env:SODUWORK_ACCEPTANCE_CONTROLLER_PID} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}"],
      { env: { ...process.env, SODUWORK_ACCEPTANCE_INSTALL_ROOT: installRoot, SODUWORK_ACCEPTANCE_CONTROLLER_PID: String(process.pid) }, encoding: 'utf8' });
      report.cleanupExitCode = cleanup.status;
      if (cleanup.status !== 0) { report.ok = false; process.exitCode = 1; }
    } else if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    fs.closeSync(log);
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ ok: report.ok, pages: report.pages.length, output }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
