'use strict';
// Real production DOM/scripts, synthetic API/IPC, isolated profile and no network.
const electron = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session, net } = electron;
  const { fileURLToPath } = require('node:url');
  const assert = require('node:assert/strict');
  const output = process.argv[2];
  if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence directory required');
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-page-refresh-'));
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  const client = path.resolve(__dirname, '..');
  const report = { ok: false, checks: [], boundary: 'Isolated Chromium DOM behavior; no live Hub, user profile or physical mouse assertions.' };
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) {
    for (let i = 0; i < 100; i++) { if (await js(code)) return; await wait(20); }
    throw Error('Timed out: ' + code);
  }
  async function check(name, code) { assert.equal(await js(code), true, name); report.checks.push(name); }
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_r, cb) => cb({ cancel: true }));
    session.defaultSession.protocol.handle('file', request => {
      if (path.basename(fileURLToPath(request.url.split('?')[0])) !== 'desk.html') return net.fetch(request.url, { bypassCustomProtocolHandlers: true });
      const mock = fs.readFileSync(path.join(__dirname, 'fixtures/page-audit-api.js'), 'utf8');
      const html = fs.readFileSync(path.join(client, 'desk.html'), 'utf8')
        .replace('<head>', '<head><script>' + mock + '\nsoduWorkAPI.workPreview.onComposerRefresh=()=>()=>{};soduWorkAPI.workPreview.hide=async()=>({ok:true});soduWorkAPI.distributionInfo=()=>({hubOrigin:"http://127.0.0.1:19999"});soduWorkAPI.readAloud={onStop:()=>()=>{}};</script>')
        .replace('<script src="desk-boot.js"></script>', '<script>fixtureInstallApi();</script><script src="desk-boot.js"></script>');
      return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
    });
    win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    await win.loadFile(path.join(client, 'desk.html'), { query: { panel: 'workspace', view: 'settings' } });
    await until('Boolean(window.fixtureReady)');
    await js('WorkspaceHost.open("create",{newSession:true});openCapabilityPanel();void 0;');
    await check('external plugin setup uses the workspace route without mixing conversation panels',
      'document.documentElement.dataset.workspaceView === "skills" && document.querySelector("#capPanel").classList.contains("show") && !document.querySelector("#composePanel")?.classList.contains("show")');
    await js('document.querySelector("[data-view=create]").click();void 0;');
    await check('conversation navigation works after external plugin setup',
      'document.documentElement.dataset.workspaceView === "create" && !document.querySelector("#capPanel").classList.contains("show")');
    await js(`window.refreshRows={items:[{pluginId:'local:refresh-one',personal:true,enabled:true,name:'Refresh fixture',description:'Synthetic application',ui:{contributions:[{id:'main',slot:'workspace.navigation'}]}}]};
      fixtureOverrides.pluginCatalog=async()=>structuredClone(refreshRows); WorkspaceHost.open('apps',{});void 0;`);
    await until('Boolean(document.querySelector(".appsx-card"))');
    await js(`window.firstCard=document.querySelector('.appsx-card');window.pendingCatalog=[];
      fixtureOverrides.pluginCatalog=()=>new Promise((resolve,reject)=>pendingCatalog.push({resolve,reject}));
      window.refreshApps=renderAppsCatalog(true);void 0;`);
    await check('apps keep existing cards while refreshing', 'firstCard.isConnected && !document.querySelector(".appsx-loading")');
    await js('pendingCatalog.shift().resolve(structuredClone(refreshRows));refreshApps');
    await check('unchanged apps keep DOM identity', 'firstCard === document.querySelector(".appsx-card")');
    await js('window.refreshApps=renderAppsCatalog(true);void 0;');
    await js('pendingCatalog.shift().reject(Error("offline"));refreshApps');
    await check('failed refresh preserves apps with retry', 'firstCard.isConnected && !!document.querySelector("#appsRefreshNotice button")');
    await js('window.refreshApps=renderAppsCatalog(true);void 0;');
    await js('refreshRows.items[0].name="Updated fixture";pendingCatalog.shift().resolve(structuredClone(refreshRows));refreshApps');
    await check('changed apps update and clear the error', 'document.querySelector("#appsBody").textContent.includes("Updated fixture") && !document.querySelector("#appsRefreshNotice")');
    await js('window.refreshApps=renderAppsCatalog(true);dispatchEvent(new Event("soduwork-plugin-policy"));void 0;');
    await check('policy invalidation immediately removes cached grants', '!document.querySelector(".appsx-card")');
    await js('pendingCatalog.pop().resolve({items:[]});void 0;'); await wait(40);
    await js('pendingCatalog.shift().resolve(structuredClone(refreshRows));refreshApps');
    await check('old catalog cannot restore revoked apps', '!document.querySelector(".appsx-card")');

    await js('fixtureOverrides.pluginCatalog=async()=>({items:[]});WorkspaceHost.open("skills",{});void 0;');
    await until('Boolean(document.getElementById("capContent"))'); await wait(80);
    // The controlled capabilityCatalog request belongs to the Skills tab.
    await js('document.querySelector("[data-cap-tab=skills]").click();void 0;');
    await js(`window.capShell=document.querySelector('.cap-shell');window.pendingCap=[];
      fixtureOverrides.capabilityCatalog=()=>new Promise((resolve,reject)=>pendingCap.push({resolve,reject}));
      window.capFirst=openCapabilityPanel();window.capSecond=openCapabilityPanel();void 0;`);
    await until('pendingCap.length>0');
    report.capabilityReopen = await js('({requests:pendingCap.length,connected:capShell.isConnected,view:document.documentElement.dataset.workspaceView})');
    await check('capability reopen coalesces reads and keeps content', 'pendingCap.length===1 && capShell.isConnected');
    await js('pendingCap.shift().resolve({skills:[],mcpTemplates:[],summary:{}});Promise.all([capFirst,capSecond])');
    await check('unchanged capability data keeps toolbar and focus container', 'capShell === document.querySelector(".cap-shell")');
    await js('window.capFirst=openCapabilityPanel();void 0;'); await until('pendingCap.length>0');
    await js('pendingCap.shift().reject(Error("offline"));capFirst');
    await check('capability refresh failure preserves content with retry', 'capShell.isConnected && !!document.querySelector("[data-cap-load-error] button")');

    await js(`window.libraryRows={items:[{id:'file-one',title:'Fixture document',kind:'document',storage:'local',filename:'fixture.md',updatedAt:1720000000000}],folders:[]};
      libraryRows.items.push(...Array.from({length:40},(_,i)=>({...libraryRows.items[0],id:'scroll-'+i,title:'Scroll fixture '+i})));
      fixtureOverrides.listLibrary=async()=>structuredClone(libraryRows);WorkspaceHost.open('library',{});void 0;`);
    await until('document.querySelector("[data-library-content]")?.textContent.includes("Fixture document")');
    await js(`window.libraryRow=document.querySelector('[data-library-content]').firstElementChild;window.pendingLibrary=[];
      fixtureOverrides.listLibrary=()=>new Promise((resolve,reject)=>pendingLibrary.push({resolve,reject}));openLibraryPanel();void 0;`);
    await until('pendingLibrary.length>0');
    await check('library reopen keeps loaded rows', 'libraryRow.isConnected && !document.querySelector("[data-library-content]").hidden');
    await js('pendingLibrary.shift().resolve(structuredClone(libraryRows));void 0;'); await wait(50);
    await check('unchanged library rows keep DOM identity', 'libraryRow === document.querySelector("[data-library-content]").firstElementChild');
    await js(`window.libraryListCalls=0;window.libraryStatusCalls=0;window.pendingStorage=[];
      fixtureOverrides.listLibrary=()=>{libraryListCalls++;return new Promise((resolve,reject)=>pendingLibrary.push({resolve,reject}));};
      fixtureOverrides.getLibraryStorageStatus=()=>{libraryStatusCalls++;return new Promise(resolve=>pendingStorage.push(resolve));};
      window.librarySearch=document.querySelector('[data-library-search]');librarySearch.focus({preventScroll:true});
      document.querySelector('#libraryPanel').scrollTop=180;window.libraryScroll=document.querySelector('#libraryPanel').scrollTop;
      window.libraryFirst=openLibraryPanel();window.librarySecond=openLibraryPanel();void 0;`);
    await check('concurrent library entry shares one list and one status request', 'libraryListCalls===1 && libraryStatusCalls===1 && pendingLibrary.length===1');
    await check('background library validation preserves input focus, scroll and row identity', 'document.activeElement===librarySearch && libraryScroll>0 && document.querySelector("#libraryPanel").scrollTop===libraryScroll && libraryRow===document.querySelector("[data-library-content]").firstElementChild');
    await js(`pendingStorage.shift()({local:{available:true}});pendingLibrary.shift().resolve(structuredClone(libraryRows));Promise.all([libraryFirst,librarySecond]);`);
    await js(`fixtureOverrides.getLibraryStorageStatus=async()=>({local:{available:true}});
      document.querySelector('[data-library-select="file-one"]').click();window.libraryRow=document.querySelector('[data-library-content]').firstElementChild;
      librarySearch.focus();libraryListCalls=0;
      dispatchEvent(new Event('soduwork-library-changed'));dispatchEvent(new Event('soduwork-library-changed'));
      dispatchEvent(new StorageEvent('storage',{key:'soduwork-library-change',newValue:'fixture-change'}));void 0;`);
    await until('pendingLibrary.length===1');
    await check('one notification burst starts one background read without clearing selection', 'libraryListCalls===1 && libraryRow.isConnected && document.querySelector("[data-library-select=file-one]").checked');
    await js(`dispatchEvent(new Event('soduwork-library-changed'));void 0;`); await wait(70);
    await check('a change during a slow read does not start a parallel list', 'libraryListCalls===1 && pendingLibrary.length===1');
    await js('pendingLibrary.shift().resolve({items:[],folders:[]});void 0;');
    await until('pendingLibrary.length===1 && libraryListCalls===2');
    await check('invalidated responses do not clear selection before the trailing read', 'libraryRow.isConnected && document.querySelector("[data-library-select=file-one]").checked && document.activeElement===librarySearch');
    await js('pendingLibrary.shift().resolve(structuredClone(libraryRows));void 0;'); await wait(70);
    await check('last notification is revalidated exactly once and unchanged rows retain identity', 'libraryListCalls===2 && pendingLibrary.length===0 && libraryRow===document.querySelector("[data-library-content]").firstElementChild');
    await js('openLibraryPanel();void 0;'); await until('pendingLibrary.length>0');
    await js('pendingLibrary.shift().reject(Error("offline"));void 0;'); await wait(50);
    await check('library outage preserves rows and exposes retry', 'libraryRow.isConnected && !document.querySelector("[data-library-content]").hidden && !!document.querySelector("[data-library-retry]")');
    await js(`openLibraryPanel();dispatchEvent(new Event('soduwork-library-changed'));closeLibraryPanel();
      window.callsBeforeClose=libraryListCalls;pendingLibrary.shift().resolve({items:[{id:'closed-result',title:'Late closed result'}],folders:[]});void 0;`); await wait(80);
    await check('closing cancels a scheduled refresh and fences the pending result', 'libraryListCalls===callsBeforeClose && !document.querySelector("[data-library-content]").textContent.includes("Late closed result")');
    await js('openLibraryPanel();void 0;'); await until('pendingLibrary.length===1');
    await js('pendingLibrary.shift().resolve(structuredClone(libraryRows));void 0;'); await wait(30);
    await js(`librarySearch.value='older query';librarySearch.dispatchEvent(new Event('input',{bubbles:true}));void 0;`);
    await until('pendingLibrary.length===1');
    await js(`librarySearch.value='latest query';librarySearch.dispatchEvent(new Event('input',{bubbles:true}));void 0;`);
    await until('pendingLibrary.length===2');
    await js('pendingLibrary[1].resolve(structuredClone(libraryRows));void 0;'); await wait(20);
    await js('pendingLibrary.shift().resolve({items:[{id:"old-query",title:"Outdated search result"}],folders:[]});pendingLibrary.shift();void 0;'); await wait(30);
    await check('a late search response cannot replace the latest filter or query', 'librarySearch.value==="latest query" && !document.querySelector("[data-library-content]").textContent.includes("Outdated search result")');
    await js('window.libraryRow=document.querySelector("[data-library-content]").firstElementChild;openLibraryPanel();void 0;'); await until('pendingLibrary.length===1');
    await js('fixtureOverrides.listLibrary=async()=>({items:[],folders:[]});fixtureOwner="second-owner";dispatchEvent(new Event("soduwork-data-scope-changed"));void 0;');
    await js('pendingLibrary.shift().resolve(structuredClone(libraryRows));void 0;'); await wait(30);
    await check('identity change removes old library and capability data', '!libraryRow.isConnected && !capShell.isConnected');
    report.rendererErrors = await js('fixtureErrors');
    await check('renderer has no unhandled errors', 'fixtureErrors.length===0');
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); process.exitCode = 1; }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    win?.destroy(); app.quit();
  });
  app.on('will-quit', () => {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    app.exit(report.ok ? 0 : 1);
  });
}
