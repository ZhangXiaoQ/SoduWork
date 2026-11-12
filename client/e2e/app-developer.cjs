'use strict';
// Production authoring/resources/install/export and native app bridge. Composer
// admission is deterministic here; this test does not claim model execution.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const run = require('node:child_process').spawnSync(electron, [__filename, '--disable-gpu'], { env, windowsHide: true, stdio: 'inherit', timeout: 60000 });
  process.exit(run.status ?? 1);
}
const { app, BrowserWindow, WebContentsView, ipcMain } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const personal = require('../main/personal-plugins'), resources = require('../main/plugin-resources');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-app-developer-'));
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const report = { ok: false, cases: [], boundary: 'Real Chromium, production skill resources, selected draft/install/export IPC, independent native window and public H5 SDK; deterministic composer admission, no real model in this fixture.' };
const windows = []; let host, server;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { for (let i = 0; i < 200; i++) { if (await check()) return; await delay(30); } throw Error('Timeout: ' + label); }
const js = async (wc, source) => {
  try { return await wc.executeJavaScript(source); }
  catch (error) { throw Error('Renderer step ' + source.slice(0, 90) + ': ' + error.message); }
};
app.whenReady().then(async () => {
  const detail = personal.get(app, personal.APP_DEVELOPER_ID);
  const bundle = resources.materialize(detail.localDraft.resources, root, detail.key);
  const source = path.join(bundle.directory, 'references/developer');
  const candidate = path.join(root, 'candidate');
  require(path.join(source, 'scripts/scaffold.cjs')).scaffold({ out: candidate, key: 'authored-demo', name: '即用开发闭环样例', url: 'http://127.0.0.1/' });
  server = require(path.join(source, 'scripts/serve.cjs')).serve(path.join(candidate, 'ui'), 0);
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const file = path.join(candidate, 'soduwork-plugin-draft.json'), body = JSON.parse(fs.readFileSync(file));
  body.ui.contributions[0].source.url = origin + '/'; fs.writeFileSync(file, JSON.stringify(body));
  const entry = { artifactId: 'app-draft', path: file, relative: 'soduwork-plugin-draft.json' };
  const session = { cwd: candidate, sessionId: 'app-author', inFlight: () => false,
    outputSnapshot: () => ({ files: [entry], delivery: { items: [entry] } }) };
  personal.install({ app, ipcMain, dialog: { showSaveDialog: async () => ({ filePath: path.join(root, 'app.soduwork-plugin') }) } });
  require('../main/pi-session/plugin-draft').installIpc(ipcMain, { get: id => id === session.sessionId ? session : null, list: () => [session] }, app);
  fs.writeFileSync(path.join(root, 'host.html'), '<!doctype html><title>Application authoring fixture</title>');
  fs.writeFileSync(path.join(root, 'composer.html'), '<!doctype html><textarea id="draft">用户未发送的草稿</textarea><script>window.received=[];soduWorkAPI.workPreview.onComposerSubmit(p=>{received.push(p.text);soduWorkAPI.workPreview.composerSubmitResult({id:p.id,ok:true});});</script>');
  require('../main/work-preview').install({ app, ipcMain,
    BrowserWindow: Object.assign(function (options) { const win = new BrowserWindow(options); windows.push(win); return win; }, { fromWebContents: wc => BrowserWindow.fromWebContents(wc) }),
    WebContentsView: function (options) {
      const view = new WebContentsView(options), load = view.webContents.loadFile.bind(view.webContents);
      view.webContents.loadFile = (file, options) => load(path.basename(file) === 'desk.html' ? path.join(root, 'composer.html') : file, options);
      return view;
    }, shell: { openExternal: async () => { throw Error('Unexpected external navigation'); } } });
  host = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, sandbox: true } });
  await host.loadFile(path.join(root, 'host.html'));
  // recent draft uses the same trusted session registry. A file URL outside the
  // real client is deliberately not allowed to invoke the selected-draft IPC.
  const read = await js(host.webContents, 'soduWorkAPI.conversationSession.recentPluginDraft()');
  assert.equal(read.ok, true, read.reason);
  const checked = await js(host.webContents, 'soduWorkAPI.personalPlugins.preflight(' + JSON.stringify(read.body) + ')');
  assert.equal(checked.ok, true); assert.equal(checked.manifest.template, 'app');
  const created = await js(host.webContents, 'soduWorkAPI.personalPlugins.create(' + JSON.stringify(read.body) + ')');
  assert.equal(created.ok, true); assert.equal(created.plugin.template, 'app');
  const exported = await js(host.webContents, 'soduWorkAPI.personalPlugins.exportToFile(' + JSON.stringify(created.plugin.pluginId) + ')');
  assert.equal(exported.ok, true);
  assert.equal(require('../main/plugin-package-reader.cjs').readPersonalArchive(fs.readFileSync(exported.filePath)).template, 'app');
  report.cases.push('Built-in developer resources generate a real app; conversation resources collect, preflight, native install and export preserve app type and SDK.');
  require('../main/app-settings-store.cjs').configure({app,safeStorage:electron.safeStorage,ownerOf:()=>'fixture/edit-author'});
  const editing = personal.create(app,{...read.body,key:'edit-metadata-race',version:'1.0.3',author:'Original author',appCategory:'other'}).plugin;
  const copied = await require('../main/jiyong-edit-source.cjs').prepare({app,pluginId:editing.pluginId,cwd:session.cwd});
  fs.appendFileSync(path.join(path.dirname(copied.draft),'ui/app.js'),'\nwindow.metadataRaceFixed=true;');
  for (const options of [{author:'Saved author'},{appCategory:'game'}]) {
    const checksum=personal.get(app,editing.pluginId).checksum;
    const updated=await js(host.webContents,'soduWorkAPI.personalPlugins.updateMetadata('+JSON.stringify(editing.pluginId)+','+JSON.stringify({...options,expectedChecksum:checksum})+')');
    assert.equal(updated.ok,true);
  }
  const snapshot = session.outputSnapshot;
  session.outputSnapshot=()=>({files:[{path:copied.draft,at:Date.now()}]});
  const revised=await js(host.webContents,'soduWorkAPI.conversationSession.recentPluginDraft()');
  assert.equal(revised.ok,true,revised.reason);assert.equal(revised.body.version,'1.0.6');
  assert.equal(revised.body.author,'Saved author');assert.equal(revised.body.appCategory,'game');
  const preview=await js(host.webContents,'soduWorkAPI.personalPlugins.preflight('+JSON.stringify(revised.body)+')');
  assert.equal(preview.ok,true);assert.equal(preview.manifest.version,'1.0.6');
  const revisedInstall=await js(host.webContents,'soduWorkAPI.personalPlugins.create('+JSON.stringify(revised.body)+')');
  assert.equal(revisedInstall.ok,true);assert.equal(revisedInstall.plugin.pluginId,editing.pluginId);
  assert.equal(revisedInstall.plugin.version,'1.0.6');assert.equal(revisedInstall.plugin.authorName,'Saved author');
  assert.equal(personal._read(app).plugins.find(row=>row.id===editing.pluginId).versions.find(row=>row.version==='1.0.3').checksum,editing.checksum);
  session.outputSnapshot=snapshot;
  report.cases.push('Editing v1.0.3 while saving author/category to v1.0.5 yields a v1.0.6 candidate through real preload/IPC; preflight and installation keep metadata, app identity and immutable history.');
  const c = created.plugin.ui.contributions[0];
  const payload = { tabId: 'app-developer-demo', url: c.source.url, appBridge: {
    appId: 'plugin:' + created.plugin.pluginId, contributionId: c.id, origin, ...c.source.bridge } };
  assert.equal((await js(host.webContents, 'soduWorkAPI.workPreview.showDetached(' + JSON.stringify(payload) + ')')).ok, true);
  const [chrome, application, composer] = windows[0].contentView.children;
  await until(() => !application.webContents.isLoading() && !composer.webContents.isLoading(), 'application and composer');
  const guard = require('../main/pi-session/app-mcp-grant.cjs'), handle = {};
  guard.bind(handle, composer.webContents, created.plugin.pluginId, app);
  const turn = {}; guard.guardSend(handle, turn); await turn.beforeTurn();
  const context = guard.forSession(handle);
  assert.equal(context.pluginId, created.plugin.pluginId);
  assert.equal(context.requiresMcp, false); assert.equal(context.connection, null);
  assert.equal(handle.appMcpExpected, '');
  report.cases.push('An installed standalone app passes the production send guard with real native ownership, no MCP, no ukey and no business login.');
  await js(application.webContents, 'document.getElementById("description").value="请帮我整理今天的便签";document.getElementById("submit").click()');
  await until(async () => (await js(composer.webContents, 'received.length')) === 1, 'H5 send');
  assert.deepEqual(await js(composer.webContents, 'received'), ['请帮我整理今天的便签']);
  assert.equal(await js(composer.webContents, 'draft.value'), '用户未发送的草稿');
  report.cases.push('Generated business DIV sends through public SDK/postMessage to its owned native composer, preserving user draft.');
  await js(composer.webContents, 'soduWorkAPI.workPreview.composerTurnSettled({ref:"fixture",state:"complete"})');
  await until(async () => (await js(application.webContents, 'refreshCount')) === 1, 'turn refresh');
  const oldComposer = composer.webContents.id;
  await js(chrome.webContents, 'soduWorkWindowChrome.action("refresh")');
  await until(async () => !application.webContents.isLoading() && (await js(application.webContents, '!!window.soduWorkApp')), 'title refresh');
  assert.equal(composer.webContents.id, oldComposer);
  assert.equal(await js(composer.webContents, 'received.length'), 1);
  assert.equal(await js(composer.webContents, 'draft.value'), '用户未发送的草稿');
  report.cases.push('Turn-settled refresh reaches the generated page; shell reload retains the same conversation and draft.');
  report.ok = true;
}).catch(error => { report.error = String(error.stack || error); }).finally(async () => {
  host?.destroy(); windows.forEach(win => { if (!win.isDestroyed()) win.destroy(); });
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const output = path.resolve(__dirname, '../../outputs/app-developer-20261020'); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  app.exit(report.ok ? 0 : 1);
});
