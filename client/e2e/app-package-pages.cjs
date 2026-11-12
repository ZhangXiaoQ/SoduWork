'use strict';
// Three real Electron launches: install, process restart, then import on another profile.
const electron = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
if (typeof electron === 'string') {
  const evidence = process.env.SODUWORK_PACKAGE_EVIDENCE;
  if (evidence) fs.mkdirSync(evidence,{recursive:true});
  const root = fs.mkdtempSync(path.join(evidence || os.tmpdir(), 'soduwork-static-h5-'));
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  for (const phase of ['install', 'restart', 'receiver']) {
    const result = require('node:child_process').spawnSync(electron, [__filename, root, phase], { env, windowsHide: true, encoding: 'utf8', timeout: 45000 });
    process.stdout.write(result.stdout || '');
    if (result.status !== 0) { process.stderr.write(result.stderr || String(result.error)); process.exit(result.status || 1); }
    if (phase === 'install') fs.renameSync(path.join(root, 'candidate'),path.join(root,'candidate-source-kept'));
  }
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain } = electron;
  const root = process.argv[2], phase = process.argv[3];
  app.setPath('userData', path.join(root, phase === 'receiver' ? 'receiver-profile' : 'author-profile'));
  app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
  const personal = require('../main/personal-plugins'), resources = require('../main/plugin-resources');
  const windows = []; let host;
  const report = { phase, ok: false, boundary: 'Real Electron package resource protocol, isolated profiles, no HTTP server, business service, credentials or models.' };
  const js = async (wc, text) => { try { return await wc.executeJavaScript(text); }
    catch (error) { throw Error(text.slice(0, 140) + ': ' + (error?.message || JSON.stringify(error))); } };
  async function until(check) { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw Error('Package page did not become ready'); }
  app.whenReady().then(async () => {
    require('../main/app-settings-store.cjs').configure({app,safeStorage:electron.safeStorage,ownerOf:()=>'fixture/account'});
    console.log('Package phase',phase,'started');
    let pluginId;
    if (phase === 'install') {
      const out = path.join(root, 'candidate');
      require('../../skills/app-developer/scripts/scaffold.cjs').scaffold({ out, key: 'static-h5', name: '纯静态便签' });
      const draftPath = path.join(out, 'soduwork-plugin-draft.json'), draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
      // A real multi-color PNG fixture exercises decoding in the application
      // window and portability; this does not assess an author's visual design.
      const pixels = Buffer.alloc(128 * 128 * 4);
      for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
        const offset = (y * 128 + x) * 4;
        const color = x < 64 ? [255, 92, 124] : y < 64 ? [83, 196, 255] : [61, 200, 255];
        pixels.set([...color, 255], offset);
      }
      draft.icon = 'data:image/png;base64,' + electron.nativeImage.createFromBitmap(pixels, { width: 128, height: 128 }).toPNG().toString('base64');
      fs.writeFileSync(path.join(root, 'expected-icon.txt'), draft.icon);
      let html = fs.readFileSync(path.join(out, 'ui/index.html'), 'utf8');
      html = html.replace('</main>', '<button id="counter">Increase</button><output id="total"></output><div id="data"></div><img id="picture" src="picture.svg"></main>') + '<link rel="stylesheet" href="styles.css"><script type="module" src="local.mjs"></script>';
      fs.writeFileSync(path.join(out, 'ui/index.html'), html);
      const files = { 'styles.css': '#data{color:rgb(18,52,86)}', 'data.json': '{"message":"离线数据"}',
        'math.mjs': 'export const add=n=>n+1;',
        'local.mjs': `import{add}from'./math.mjs';const total=document.getElementById('total');total.textContent=localStorage.getItem('count')||'0';document.getElementById('counter').onclick=()=>{total.textContent=add(Number(total.textContent));localStorage.setItem('count',total.textContent)};document.getElementById('data').textContent=(await(await fetch('./data.json')).json()).message;window.staticReady=true;`,
        'picture.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>' };
      for (const [file, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(out, 'ui', file), content);
        draft.resources.push({ path: 'ui/' + file, kind: 'ui' });
      }
      draft.jiyong = {version:1,storage:{location:'local'},parameters:[],collections:[{key:'notes',indexes:['status']}],mcp:{server:'soduwork-jiyong',bindings:[]}};
      draft.mcpServers = ['soduwork-jiyong']; draft.entrypoints = {automation:true};
      draft.ui.contributions[0].source.bridge.capabilities.push('data.read','data.write','mcp.connect');
      fs.writeFileSync(draftPath, JSON.stringify(draft));
      const developer = personal.get(app, personal.APP_DEVELOPER_ID);
      const bundle = resources.materialize(developer.localDraft.resources, root, developer.key);
      const validator = require(path.join(bundle.directory, 'references/developer/scripts/validate.cjs'));
      assert.equal(validator.validate(draftPath, root).ok, true);
      const artifact = { artifactId: 'generated-app', path: draftPath, relative: 'candidate/soduwork-plugin-draft.json' };
      const read = require('../main/pi-session/plugin-draft').readSession({ cwd: root, sessionId: 'author', inFlight: () => false,
        outputSnapshot: () => ({ files: [artifact], delivery: { items: [artifact] } }) }, artifact.artifactId);
      assert.equal(read.ok, true, read.reason);
      assert.equal(personal.preflight(read.body).manifest.icon, draft.icon);
      pluginId = personal.create(app, read.body).plugin.pluginId;
      fs.writeFileSync(path.join(root, 'id.json'), JSON.stringify(pluginId));
      await personal.exportToFile(app, { showSaveDialog: async () => ({ filePath: path.join(root, 'static.soduwork-plugin') }) }, pluginId);
    } else if (phase === 'receiver') {
      const body = require('../main/plugin-package-reader.cjs').readPersonalArchive(fs.readFileSync(path.join(root, 'static.soduwork-plugin')));
      pluginId = personal.create(app, body).plugin.pluginId;
    } else pluginId = JSON.parse(fs.readFileSync(path.join(root, 'id.json'), 'utf8'));
    assert.equal(personal.get(app, pluginId).icon, fs.readFileSync(path.join(root, 'expected-icon.txt'), 'utf8'));
    fs.writeFileSync(path.join(root, 'host.html'), '<!doctype html><title>Static package fixture</title>');
    fs.writeFileSync(path.join(root, 'composer.html'), '<!doctype html><textarea id="draft">保留草稿</textarea><script>window.received=[];soduWorkAPI.workPreview.onComposerSubmit(p=>{received.push(p.text);soduWorkAPI.workPreview.composerSubmitResult({id:p.id,ok:true})});</script>');
    require('../main/work-preview').install({ app, ipcMain,
      BrowserWindow: Object.assign(function(options) { const win = new BrowserWindow(options); windows.push(win); return win; }, { fromWebContents: wc => BrowserWindow.fromWebContents(wc) }),
      WebContentsView: function(options) { const view = new WebContentsView(options), load = view.webContents.loadFile.bind(view.webContents); view.webContents.loadFile = (file, options) => load(path.basename(file) === 'desk.html' ? path.join(root, 'composer.html') : file, options); return view; },
      shell: { openExternal: async () => { throw Error('No external navigation expected'); } } });
    host = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, sandbox: true } });
    await host.loadFile(path.join(root, 'host.html'));
    const source = fs.readFileSync(path.resolve(__dirname, '../components/panels/panels-capabilities.js'), 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('tryPlugin: async function (item) {') + 'tryPlugin: '.length;
    const end = source.indexOf('\n      },\n    };', start) + '\n      }'.length;
    const trial = source.slice(start, end);
    await js(host.webContents, fs.readFileSync(path.resolve(__dirname, '../components/panels/plugin-ui-host.js'), 'utf8'));
    const embedded = process.env.SODUWORK_PACKAGE_EMBEDDED === '1';
    const item = personal.get(app, pluginId);
    const opened = embedded
      ? await js(host.webContents, 'PluginUIHost.openContribution(' + JSON.stringify(item.ui.contributions[0]) + ',{item:' + JSON.stringify(item) + ',embedded:true,bounds:{x:52,y:0,width:748,height:600}})')
      : await js(host.webContents, '(async()=>{const closeModal=()=>{};return (' + trial + ')(' + JSON.stringify(item) + ')})()');
    assert.equal(embedded ? opened.embedded : opened.detached, true);
    if (embedded) assert.equal(windows.length, 0, 'package embedding creates no standalone window');
    console.log('Package phase',phase,'window opened');
    const surface = embedded ? host : windows.at(-1);
    surface.show();surface.focus();
    const [, application, composer] = surface.contentView.children, wc = application.webContents;
    await until(() => js(wc, '!!window.staticReady && picture.naturalWidth===10'));
    console.log('Package phase',phase,'resources ready');
    const stored = await js(wc, `(async()=>{const r=await soduWorkApp.data.get({collection:'notes',id:'native_note'});if(!r.ok)throw Error(r.reason);return r.item})()`);
    assert.equal(stored?.value.count || 0,phase === 'restart' ? 1 : 0);
    console.log('Package phase',phase,'SQLite read passed');
    const write = await js(wc, `(async()=>{return soduWorkApp.data.batch({collection:'notes',operations:[{id:'native_note',expectedRevision:${stored?.revision || 0},value:{count:${(stored?.value.count || 0)+1},status:'saved'}}]})})()`);
    assert.equal(write.ok,true,write.reason);
    console.log('Package phase',phase,'SQLite write passed');
    const asset = await js(wc, `soduWorkApp.data.assetPut({name:'preview.png',type:'image/png',data:new Uint8Array([1,2,3])})`);
    assert.equal(asset.ok,true,asset.reason);
    console.log('Package phase',phase,'asset save passed');
    assert.deepEqual(await js(wc, `(async()=>{const image=document.createElement('img');image.alt='Package icon';const loaded=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Package icon did not load')),5000);image.onload=()=>{clearTimeout(timer);resolve([image.naturalWidth,image.naturalHeight])};image.onerror=()=>{clearTimeout(timer);reject(Error('Package icon failed to decode'))}});image.src=${JSON.stringify(personal.get(app, pluginId).icon)};document.body.append(image);return loaded})()`), [128, 128]);
    assert.match(wc.getURL(), /^https:\/\/[a-f0-9]{32}\.soduwork-app\.invalid\/ui\/index.html$/);
    assert.equal(await js(wc, 'document.getElementById("data").textContent'), '离线数据');
    assert.equal(await js(wc, 'getComputedStyle(document.getElementById("data")).color'), 'rgb(18, 52, 86)');
    assert.equal(await js(wc, 'typeof require'), 'undefined');
    assert.equal(await js(wc, `(async()=> (await fetch('/data.json')).json())().then(x=>x.message)`), '离线数据', 'root-relative resources resolve within the package');
    console.log('Package phase',phase,'SQLite and image checks passed');
    const storedNote = await js(wc, `new Promise((resolve,reject)=>{const request=indexedDB.open('notes',1);request.onupgradeneeded=()=>request.result.createObjectStore('notes');request.onerror=()=>reject(request.error.name+": "+request.error.message);request.onsuccess=()=>{const db=request.result,tx=db.transaction('notes','readwrite'),store=tx.objectStore('notes'),read=store.get('note');read.onsuccess=()=>{const previous=read.result;store.put('记在本机','note');tx.oncomplete=()=>{db.close();resolve(previous||'')}}}})`);
    assert.equal(storedNote, phase === 'restart' ? '记在本机' : '');
    assert.equal(await js(wc, 'document.getElementById("total").textContent'), phase === 'restart' ? '1' : '0');
    await js(wc, 'document.getElementById("counter").click()');
    const guard = require('../main/pi-session/app-mcp-grant.cjs'), handle = {}, turn = {};
    guard.bind(handle, composer.webContents, pluginId, app); guard.guardSend(handle, turn); await turn.beforeTurn();
    assert.equal(guard.forSession(handle).connection.server, 'soduwork-jiyong');
    await js(wc, 'document.getElementById("description").value="离线应用对话";document.getElementById("submit").click()');
    await until(() => js(composer.webContents, 'received.length===1'));
    assert.equal(await js(composer.webContents, 'draft.value'), '保留草稿');
    assert.equal(await js(wc, `(async()=> (await fetch('/references/private.txt')).status)()`), 404);
    console.log('Package phase',phase,'conversation checks passed');
    const cookieUrl = new URL(wc.getURL()).origin + '/';
    await wc.session.cookies.set({ url: cookieUrl, name: 'cache-preserved', value: 'signed-in-fixture' });
    const cacheBefore = await js(host.webContents, 'soduWorkAPI.workPreview.appCache(' + JSON.stringify({ pluginId, action: 'stats' }) + ')');
    assert.equal(cacheBefore.ok, true, cacheBefore.reason); assert.ok(cacheBefore.resourceBytes > 0);
    const cleared = await js(host.webContents, 'soduWorkAPI.workPreview.appCache(' + JSON.stringify({ pluginId, action: 'clear' }) + ')');
    assert.equal(cleared.ok, true, cleared.reason); assert.equal(cleared.resourceBytes, 0);
    assert.equal((await wc.session.cookies.get({ url: cookieUrl, name: 'cache-preserved' }))[0].value, 'signed-in-fixture');
    assert.equal(await js(wc, 'document.getElementById("total").textContent'), phase === 'restart' ? '2' : '1');
    assert.equal((await js(wc, `(async()=> (await soduWorkApp.data.get({collection:'notes',id:'native_note'})).item.value.count)()`)), phase === 'restart' ? 2 : 1);
    assert.equal(await js(wc, `(async()=> (await fetch('/data.json')).json())().then(x=>x.message)`), '离线数据', 'resource cache rebuilds after clearing');
    assert.equal(await js(composer.webContents, 'draft.value'), '保留草稿');
    await wc.session.flushStorageData();
    if (embedded) await js(host.webContents, 'soduWorkAPI.workPreview.destroy(' + JSON.stringify(opened.tabId) + ')');
    else windows.at(-1).destroy();
    const background = require('../main/app-conversation-connection.cjs').context(app,pluginId);
    const lease = await require('../main/pi-session/app-mcp-proxy.cjs').create(background.connection);
    try {
      const response = await fetch(lease.url,{method:'POST',headers:{Authorization:'Bearer '+lease.token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'data_get',arguments:{collection:'notes',id:'native_note'}}})});
      assert.equal(response.status,200);
      const result = await response.json(); assert.equal(result.result.isError,undefined);
      assert.equal(JSON.parse(result.result.content[0].text).item.value.count,phase==='restart'?2:1);
    } finally { lease.cleanup(); }
    await require('../main/jiyong-data.cjs').close();
    report.ok = true; report.evidence=root;report.checks = ['generated disk draft and bundled installer-equivalent check', 'conversation draft read, preflight, install and PNG decode', 'bundled HTML/CSS/module JS/JSON/image', 'host SQLite across process restart and receiver isolation', 'legacy browser storage portability regression', 'portable import and icon without original source path or server; sources retained elsewhere', 'no ukey, business login or Node access', 'native send guard and SDK conversation', 'headless MCP reads host SQLite after window close', 'undeclared resources blocked'];
  }).catch(error => { report.error = String(error.stack || error); }).finally(() => {
    host?.destroy(); for (const win of windows) if (!win.isDestroyed()) win.destroy();
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  });
}
