'use strict';
// Real Electron/preload/IPC/local filesystem and renderer code. Identity and the
// loopback HTTP receiver are isolated fixtures, not a live Hub or NFS server.
const electron = require('electron');
if (typeof electron === 'string') {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-library-client-local-'));
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, temporary], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 90000);
  child.on('exit', code => {
    clearTimeout(timer);
    const target = path.resolve(temporary), parent = path.resolve(os.tmpdir());
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('soduwork-library-client-local-')) throw Error('Unsafe temporary cleanup path');
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    process.exitCode = code ?? 1;
  });
} else {
  const { app, BrowserWindow, ipcMain, net } = electron;
  const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path');
  const os = require('node:os'), http = require('node:http'), crypto = require('node:crypto');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), temporary = path.resolve(process.argv[2] || '');
  if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('soduwork-library-client-local-')) throw Error('Isolated temporary profile required');
  const profile = path.join(temporary, 'profile'), libraryWorkRoot = path.join(temporary, 'workspace'), output = path.resolve(client, '../outputs/library-client-local');
  fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(libraryWorkRoot, { recursive: true }); fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', profile); app.setPath('sessionData', path.join(profile, 'chromium'));
  app.on('window-all-closed', () => {});
  const report = { ok: false, boundary: 'Real Electron, production preload/IPC, client filesystem, renderer API and panel. Synthetic account identities and loopback HTTP multipart receiver; no production profile, Hub or NFS.', cases: [] };
  const accounts = { a: crypto.randomBytes(16).toString('hex'), b: crypto.randomBytes(16).toString('hex') };
  let account = 'a', win, receiver, origin, offline = false, fileProtocolInstalled = false;
  let historyDeleted = false, historyPurged = false;
  const requests = [], uploads = [], emptyCreates = [], blocked = [], trashClears = [], shares = [], systemOpens = [];
  const nfsTrash = [{ id: 'fixture-nfs-trashed', title: 'Separate NFS trash', filename: 'nfs-trash.bin',
    kind: 'file', backend: 'nfs', size: 0, deletedAt: '2026-10-16T00:00:00Z' }];
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const bytes = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), crypto.randomBytes(4096), Buffer.from([0, 255, 0, 128])]);
  const source = path.join(temporary, 'source.bin'); fs.writeFileSync(source, bytes);
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) {
    for (let i = 0; i < 120; i++) { if (await js(code)) return; await delay(25); }
    throw Error('Timed out: ' + code);
  }
  async function untilMain(predicate, label) {
    for (let i = 0; i < 120; i++) { if (predicate()) return; await delay(25); }
    throw Error('Timed out: ' + label);
  }
  const call = (name, ...args) => js(`SoduWorkAPI[${JSON.stringify(name)}](...${JSON.stringify(args)})`);
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click();void 0;`);
  const identity = () => ({ ok: true, stored: true, clientId: 'fixture-device-' + account,
    user: { id: 'fixture-user-' + account, displayName: 'Isolated fixture' }, session: 'fixture-session-' + account, expiresIn: 3600 });
  function filesBelow(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const target = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, 'Fixture files must not escape through symlinks');
      return entry.isDirectory() ? filesBelow(target) : entry.isFile() ? [target] : [];
    });
  }
  function installLocal() {
    for (const channel of ['library-local-context', 'library-local-call']) ipcMain.removeHandler(channel);
    for (const filename of ['library-local.cjs', 'library-local-store.cjs', 'library-local-actions.cjs']) {
      const resolved = require.resolve(path.join(client, 'main', filename)); delete require.cache[resolved];
    }
    require('../main/library-local.cjs').install({ app, ipcMain, BrowserWindow,
      ownerOf: () => accounts[account],
      shell: { openPath: async target => { systemOpens.push(target); return ''; }, showItemInFolder() {} },
      dialog: { showSaveDialog: async () => ({ canceled: true }) } });
  }
  async function startReceiver() {
    receiver = http.createServer(async (request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Soduwork-Device,X-Soduwork-Secret');
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      const url = new URL(request.url, origin);
      requests.push({ method: request.method, path: url.pathname, storage: url.searchParams.get('storage'),
        scope: url.searchParams.get('scope'), folderId: url.searchParams.get('folderId') });
      function json(value, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); }
      if (offline) { json({ detail: 'Isolated receiver is offline' }, 503); return; }
      try {
        if (url.pathname === '/api/v1/library/share-members') {
          json({ members: [{ id: 'fixture-recipient', name: 'Test member', username: 'fixture' }] }); return;
        }
        if (url.pathname === '/api/v1/library/share-local' && request.method === 'POST') {
          const chunks = []; for await (const chunk of request) chunks.push(chunk);
          shares.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); json({ ok: true }); return;
        }
        if (url.pathname === '/api/v1/library/storage/status') {
          const available = backend => ({ backend, configured: true, available: true, connected: true });
          json({ storage: { local: available('local'), nfs: available('nfs'), remote: available('nfs') } }); return;
        }
        if (url.pathname === '/api/v1/library/items/upload' && request.method === 'POST') {
          const chunks = []; for await (const chunk of request) chunks.push(chunk);
          const form = await new Request(origin + request.url, { method: 'POST', headers: request.headers, body: Buffer.concat(chunks) }).formData();
          const file = form.get('file'), data = Buffer.from(await file.arrayBuffer());
          assert.equal(form.get('rejectDuplicateName'), 'true');
          if (uploads.some(row => row.item.filename.toLowerCase() === file.name.toLowerCase())) {
            json({ detail: { code: 'LIBRARY_NAME_CONFLICT', message: '当前文件夹下已有同名资料，请重命名后重试' } }, 409); return;
          }
          const row = { id: 'fixture-remote-' + (uploads.length + 1), title: file.name, filename: file.name,
            kind: 'file', backend: form.get('storage'), size: data.length, folderId: form.get('folderId') || null };
          uploads.push({ item: row, digest: sha(data), bytes: data, source: {
            type: form.get('sourceType') || '', sessionId: form.get('sessionId') || '',
            conversationTitle: form.get('conversationTitle') || '',
          } });
          json({ ok: true, item: row }); return;
        }
        if (url.pathname === '/api/v1/library/items' && request.method === 'POST') {
          const chunks = []; for await (const chunk of request) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          assert.equal(body.kind, 'file'); assert.equal(body.content, ''); assert.equal(body.storage, 'nfs');
          const row = { id: 'fixture-empty-' + (emptyCreates.length + 1), title: body.title, filename: body.filename,
            kind: 'file', backend: body.storage, size: 0, folderId: body.folderId || null };
          emptyCreates.push({ item: row, digest: sha(Buffer.alloc(0)) });
          json({ ok: true, item: row }); return;
        }
        if (url.pathname === '/api/v1/library' && request.method === 'GET') {
          const history = { id: 'fixture-server-history', title: 'Historical Hub file', filename: 'server-only.txt',
            kind: 'file', backend: 'local', size: 7, deletedAt: historyDeleted ? '2026-10-16T00:00:00Z' : null };
          const local = url.searchParams.get('storage') === 'local', trash = url.searchParams.get('scope') === 'trash';
          const items = local ? (!historyPurged && historyDeleted === trash ? [history] : [])
            : trash ? nfsTrash : uploads.concat(emptyCreates).map(row => row.item);
          json({ ok: true, items, folders: [], folder: null, trashCount: local ? Number(historyDeleted && !historyPurged) : nfsTrash.length }); return;
        }
        if (url.pathname === '/api/v1/library/items/fixture-server-history' && request.method === 'DELETE') {
          assert.equal(historyPurged, false); historyDeleted = true;
          json({ ok: true, trashed: true }); return;
        }
        if (url.pathname === '/api/v1/library/items/fixture-server-history/restore' && request.method === 'POST') {
          assert.equal(historyDeleted, true); assert.equal(historyPurged, false); historyDeleted = false;
          json({ ok: true, restored: true }); return;
        }
        if (url.pathname === '/api/v1/library/trash' && request.method === 'DELETE') {
          const storage = url.searchParams.get('storage'); trashClears.push(storage);
          if (storage === 'local') { historyPurged = historyDeleted; historyDeleted = false; }
          else if (storage === 'nfs') nfsTrash.length = 0;
          else throw Error('Explicit trash storage required');
          json({ ok: true, deleted: 1, failed: 0 }); return;
        }
        json({ detail: 'Unexpected fixture route' }, 404);
      } catch (error) { json({ detail: String(error.message || error) }, 500); }
    });
    await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + receiver.address().port;
  }
  async function openRenderer() {
    win = new BrowserWindow({ show: false, width: 1280, height: 840,
      webPreferences: { preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    const session = win.webContents.session;
    session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      const allowed = new URL(details.url).origin === origin;
      if (!allowed) blocked.push(new URL(details.url).origin);
      callback({ cancel: !allowed });
    });
    if (fileProtocolInstalled) session.protocol.unhandle('file');
    const html = fs.readFileSync(path.join(__dirname, 'fixtures/library.html'), 'utf8')
      .replaceAll('../../', pathToFileURL(client + path.sep).href);
    session.protocol.handle('file', request => request.url === pathToFileURL(path.join(client, 'desk.html')).href
      ? new Response(html, { headers: { 'Content-Type': 'text/html' } })
      : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
    fileProtocolInstalled = true;
    await win.loadFile(path.join(client, 'desk.html'));
    await js(`localStorage.setItem('soduwork_work_root',${JSON.stringify(libraryWorkRoot)});window.notices=[];window.petSay=message=>notices.push(message);void 0;`);
    for (const name of ['api-library-local.js', 'core/api-work-plugins.js', 'api.js']) await js(fs.readFileSync(path.join(client, name), 'utf8') + '\nvoid 0;');
    assert.equal((await call('registerClient')).ok, true);
    assert.equal(await js('SoduWorkAPI.hubBase()'), origin);
  }
  async function listLocal() { return call('listLibrary', { scope: 'recommended', storage: 'local' }); }
  async function readBytes(id) {
    return Buffer.from(await js(`(async()=>Array.from(new Uint8Array(await (await SoduWorkAPI.readLibraryBinary(${JSON.stringify(id)})).blob.arrayBuffer())))()`));
  }
  async function loadPanel() {
    if (!await js('typeof openLibraryPanel === "function"')) {
      for (const file of ['library-file-icons', 'panels-library-dialogs', 'panels-library']) await js(fs.readFileSync(path.join(client, 'components/panels/' + file + '.js'), 'utf8') + '\nvoid 0;');
    }
    await js('openLibraryPanel();void 0;');
    await until('document.querySelector("[data-library-menu-toggle=create]")&&!document.querySelector("[data-library-menu-toggle=create]").disabled');
  }
  app.whenReady().then(async () => {
    await startReceiver();
    ipcMain.on('runtime-form', event => { event.returnValue = 'local-code'; });
    ipcMain.on('client-distribution-info', event => { event.returnValue = { hubOrigin: origin }; });
    for (const [channel, handler] of Object.entries({
      'hub-connection-info': () => ({ hub: origin, internalTest: true, editable: false }),
      'work-root-default': () => libraryWorkRoot,
      'app-version': () => 'isolated-library-test', 'sys-info': () => ({ platform: process.platform, arch: process.arch }),
      'file-type-icon': () => ({ ok: false }),
      'runner-configure': () => ({ ok: true }), 'device-auth-bootstrap': identity,
      'device-auth-login': (_event, input) => { assert.ok(accounts[input.account]); account = input.account; return identity(); },
    })) ipcMain.handle(channel, handler);
    installLocal(); await openRenderer();

    const beforeUpload = requests.length;
    const folder = (await call('createLibraryFolder', 'Client files', '', 'local')).folder;
    const encoded = fs.readFileSync(source).toString('base64');
    const sourceMetadata = { type: 'conversation', sessionId: 'fixture-source-session', conversationTitle: 'Fixture conversation' };
    const created = await js(`SoduWorkAPI.uploadLibraryFile(new File([Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0))],'client-binary.bin',{type:'application/octet-stream'}),${JSON.stringify(folder.id)},'local',${JSON.stringify(sourceMetadata)})`);
    const item = created.item;
    assert.ok(item.id.startsWith('local-')); assert.equal(item.backend, 'local');
    assert.equal(requests.length, beforeUpload, 'Client-local folder/upload must not contact Hub');
    const storageRoot = path.join(libraryWorkRoot, 'SoduWorkLibrary', 'accounts', accounts.a);
    assert.equal(fs.existsSync(path.join(profile, 'library')), false, 'Client library must not fall back into userData');
    const payloadPaths = filesBelow(storageRoot).filter(file => sha(fs.readFileSync(file)) === sha(bytes));
    assert.equal(payloadPaths.length, 1, 'Original binary bytes must be on the client disk');
    assert.equal(sha(await readBytes(item.id)), sha(bytes));
    report.cases.push('Local upload crosses real preload/IPC and stores exact binary bytes on client disk without Hub traffic');

    win.destroy(); win = null; installLocal(); await openRenderer();
    assert.ok((await listLocal()).items.some(row => row.id === item.id));
    assert.equal(sha(await readBytes(item.id)), sha(bytes));
    report.cases.push('Closing the renderer and rebuilding the main module preserves the account library and bytes');

    offline = true;
    const disconnected = await call('getLibraryStorageStatus');
    assert.equal(disconnected.storage.local.available, true);
    assert.equal(disconnected.storage.remote.available, false);
    report.cases.push('A real HTTP 503 from the isolated remote fixture leaves client-local capability available');
    const beforeOffline = requests.length;
    const note = (await call('createLibraryItem', { kind: 'note', title: 'Offline note', content: 'Created while receiver is offline', storage: 'local' })).item;
    await call('updateLibraryItem', note.id, { title: 'Offline edited', content: 'Updated offline', storage: 'local' });
    assert.ok((await listLocal()).items.some(row => row.id === note.id && row.title === 'Offline edited'));
    await call('deleteLibraryItem', note.id);
    assert.equal((await listLocal()).items.some(row => row.id === note.id), false);
    await call('restoreLibraryItem', note.id); await call('deleteLibraryItem', note.id); await call('purgeLibraryItem', note.id);
    assert.equal(requests.length, beforeOffline, 'Offline local CRUD must not probe Hub');
    report.cases.push('Local create/read/update/trash/restore/purge remain usable with remote unavailable');
    offline = false;

    await call('updateLibraryItem', item.id, { title: 'client-renamed' });
    assert.equal((await call('readLibraryBinary', item.id)).name, 'client-renamed.bin');
    // Rename now moves the native file as well as its metadata. Capture the
    // current source path before copying and prove that exact path survives.
    const renamedPayloads = filesBelow(storageRoot).filter(file => sha(fs.readFileSync(file)) === sha(bytes));
    assert.equal(renamedPayloads.length, 1);
    const copied = await call('copyLocalLibraryItemToRemote', item.id, { storage: 'nfs', folderId: '' });
    assert.equal(copied.ok, true); assert.equal(uploads.length, 1);
    assert.equal(uploads[0].item.backend, 'nfs'); assert.equal(uploads[0].digest, sha(bytes));
    assert.equal(uploads[0].item.filename, 'client-renamed.bin');
    assert.equal(fs.existsSync(renamedPayloads[0]), true); assert.equal(sha(await readBytes(item.id)), sha(bytes));
    assert.equal(requests.some(request => request.method === 'PATCH'), false);
    report.cases.push('Copy reads actual local bytes and POSTs multipart to an isolated HTTP receiver; hash matches and local source remains');
    assert.deepEqual(uploads[0].source, sourceMetadata);
    report.cases.push('Conversation source metadata survives client disk persistence and is sent with the multipart copy');

    const empty = (await js("SoduWorkAPI.uploadLibraryFile(new File([],'client-empty.bin',{type:'application/octet-stream'}),'','local')")).item;
    const beforeEmptyUpload = uploads.length;
    assert.equal((await readBytes(empty.id)).length, 0);
    const emptyCopy = await call('copyLocalLibraryItemToRemote', empty.id, 'nfs');
    assert.equal(emptyCopy.ok, true); assert.equal(emptyCreates.length, 1);
    assert.equal(emptyCreates[0].item.size, 0); assert.equal(emptyCreates[0].digest, sha(Buffer.alloc(0)));
    assert.equal(uploads.length, beforeEmptyUpload, 'An empty copy must use the Hub-supported create route instead of rejected multipart');
    assert.equal((await readBytes(empty.id)).length, 0);
    assert.ok((await listLocal()).items.some(row => row.id === empty.id));
    report.cases.push('A zero-byte client file copies through the Hub-compatible empty-file POST route and retains its local original');

    await call('clientLogin', { account: 'b' });
    assert.equal((await listLocal()).items.length, 0);
    const denied = await js(`SoduWorkAPI.readLibraryBinary(${JSON.stringify(item.id)}).then(()=>false,()=>true)`);
    assert.equal(denied, true);
    await call('clientLogin', { account: 'a' });
    assert.ok((await listLocal()).items.some(row => row.id === item.id));
    report.cases.push('Two account scopes have separate client files; the other account cannot read an existing local ID');

    const originalRead = fsp.readFile;
    let enterRead, releaseRead;
    const entered = new Promise(resolve => { enterRead = resolve; });
    const released = new Promise(resolve => { releaseRead = resolve; });
    const beforeStaleCopy = uploads.length;
    fsp.readFile = async function (filename, ...args) {
      const result = await originalRead.call(this, filename, ...args);
      if (path.resolve(String(filename)) === renamedPayloads[0]) { enterRead(); await released; }
      return result;
    };
    try {
      await js(`window.pendingCopy=SoduWorkAPI.copyLocalLibraryItemToRemote(${JSON.stringify(item.id)},'nfs').then(()=>({ok:true}),error=>({ok:false,code:error.code||'',message:String(error.message||error)}));void 0;`);
      await Promise.race([entered, delay(4000).then(() => { throw Error('Local read did not cross the real filesystem gate'); })]);
      await call('clientLogin', { account: 'b' }); releaseRead();
      assert.equal((await js('pendingCopy')).ok, false);
      assert.equal(uploads.length, beforeStaleCopy, 'Switching scope during local read must cancel remote upload');
    } finally { releaseRead(); fsp.readFile = originalRead; }
    await call('clientLogin', { account: 'a' });
    report.cases.push('An account switch during real filesystem read rejects the pending copy before remote upload');

    await call('updateLibraryItem', item.id, { title: 'client-menu' });
    await loadPanel();
    await until(`document.querySelector('[data-library-migrate="${item.id}"]')`);
    assert.equal(await js('document.body.textContent.includes("Historical Hub file")'), false);
    const beforeMenu = uploads.length;
    await click('[data-library-migrate="' + item.id + '"]'); await until('document.querySelector(".library-confirm-dialog")');
    await click('[data-library-confirm-cancel]'); await delay(30);
    assert.equal(uploads.length, beforeMenu);
    await click('[data-library-migrate="' + item.id + '"]'); await until('document.querySelector(".library-confirm-dialog")');
    await click('.library-confirm-submit');
    await untilMain(() => uploads.length === beforeMenu + 1, 'confirmed multipart copy');
    await until(`document.querySelector('[data-library-file-preview="${item.id}"]')&&!document.querySelector('.library-confirm-dialog')&&!document.querySelector('[data-library-menu-toggle=create]').disabled`);
    assert.equal(uploads.length, beforeMenu + 1); assert.equal(uploads.at(-1).digest, sha(bytes));
    assert.equal(requests.some(request => request.method === 'PATCH'), false);
    assert.equal(sha(await readBytes(item.id)), sha(bytes));
    assert.equal(await js('document.body.textContent.includes("Historical Hub file")'), false);
    report.cases.push('The production panel confirmation invokes a real copy, not PATCH; cancel is inert and the local source stays visible');
    assert.equal(uploads.at(-1).item.filename, 'client-menu.bin');
    await until(`!document.querySelector('[data-library-migrate="${item.id}"]').disabled`);
    await click('[data-library-migrate="' + item.id + '"]'); await until('document.querySelector(".library-confirm-dialog")');
    await click('.library-confirm-submit');
    await until('document.querySelector(".library-confirm-dialog")?.textContent.includes("名称重复")');
    assert.equal(uploads.length, beforeMenu + 1); await click('.library-confirm-submit');
    report.cases.push('Renamed local files reach remote storage with the current filename; duplicate remote copies show the themed alert without overwriting');

    const dupe = (await call('createLibraryItem', { kind: 'document', title: 'duplicate', filename: 'duplicate.txt', content: 'original', storage: 'local' })).item;
    await loadPanel();
    await js(`(()=>{const dt=new DataTransfer();dt.items.add(new File(['replacement'],'DUPLICATE.txt',{type:'text/plain'}));dt.items.add(new File(['new'],'batch-next.txt',{type:'text/plain'}));const input=document.querySelector('[data-library-upload]');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until('document.body.textContent.includes("DUPLICATE（1）.txt") && document.body.textContent.includes("batch-next.txt")');
    assert.equal((await call('readLibraryContent', dupe.id)).content, 'original');
    const renamedUpload = (await listLocal()).items.find(row => row.filename === 'DUPLICATE（1）.txt');
    assert.ok(renamedUpload); assert.notEqual(renamedUpload.id, dupe.id);
    assert.equal((await call('readLibraryContent', renamedUpload.id)).content, 'replacement');
    assert.equal(await js('document.querySelector("[data-library-create-kind=document]")'), null);
    assert.ok(await js('document.querySelector("[data-library-filter-kind=document]") !== null'));
    report.cases.push('Actual native upload renames duplicate files, preserves both versions and completes the batch; document creation is absent while existing documents remain filterable');
    report.cases.push('Historical Hub-local fixture rows never appear in the client-local tab');
    await click('[data-library-storage=remote]');
    await click('[data-library-scope=all]');
    await until('document.querySelector("[data-library-folder=server-history-root]")');
    assert.equal(await js('document.querySelector("[data-library-menu-toggle=folder-server-history-root]")'), null);
    await click('[data-library-folder=server-history-root]');
    await until('document.querySelector("[data-library-file-preview=fixture-server-history]")');
    assert.equal(await js('document.querySelector("[data-library-menu-toggle=create]").disabled'), true);
    assert.equal(await js('document.querySelector("[data-library-create-kind=upload]").disabled'), true);
    assert.equal(await js('document.querySelector("[data-library-migrate=fixture-server-history]")'), null);
    assert.equal(await js('document.querySelector("[data-library-move=fixture-server-history]")'), null);
    report.cases.push('The historical server folder is read-only for creation/upload and its legacy local rows never offer client-copy or move');

    async function trashHistoryFile() {
      await click('[data-library-delete=fixture-server-history]');
      await until('document.querySelector(".library-confirm-dialog")');
      await click('.library-confirm-submit');
      await untilMain(() => historyDeleted, 'historical server file deletion');
      await until('!document.querySelector("[data-library-file-preview=fixture-server-history]")');
      await click('[data-library-menu-toggle=options]'); await click('[data-library-trash]');
      await until('document.querySelector("[data-library-restore=fixture-server-history]")');
    }
    await trashHistoryFile();
    const historicalTrashRequests = () => requests.filter(request => request.method === 'GET'
      && request.path === '/api/v1/library' && request.scope === 'trash');
    assert.ok(historicalTrashRequests().length > 0);
    assert.ok(historicalTrashRequests().every(request => request.storage === 'local'), 'Historical trash must never request the NFS namespace');
    assert.equal(await js('document.querySelector("[data-library-restore=fixture-nfs-trashed]")'), null);
    report.cases.push('Deleting a historical server item and entering its trash requests only Hub storage=local and excludes the separate NFS trash');

    await click('[data-library-restore=fixture-server-history]');
    await untilMain(() => !historyDeleted, 'historical item restoration');
    await until('!document.querySelector("[data-library-restore=fixture-server-history]")');
    await click('.library-trash-nav [data-library-root]');
    await until('document.querySelector("[data-library-file-preview=fixture-server-history]")');
    assert.equal(await js('document.querySelector("[data-library-breadcrumb]").hidden'), false);
    assert.match(await js('document.querySelector("[data-library-breadcrumb]").textContent'), /历史服务器资料/);
    assert.equal(await js('document.querySelector("[data-library-menu-toggle=create]").disabled'), true);
    report.cases.push('Restore and return-from-trash stay in the historical server folder instead of switching to client or NFS storage');

    await trashHistoryFile();
    await click('[data-library-empty-trash]');
    await until('document.querySelector(".library-confirm-dialog")');
    await click('.library-confirm-submit');
    await untilMain(() => historyPurged, 'historical trash clearing');
    await until('!document.querySelector("[data-library-restore=fixture-server-history]")');
    assert.equal(await js('document.querySelector("[data-library-empty-trash]").disabled'), true,
      'The empty trash action must remain disabled after refresh and action cleanup');
    assert.deepEqual(trashClears, ['local'], 'Historical empty-trash must explicitly target Hub local storage');
    assert.equal(nfsTrash.length, 1, 'Historical trash clearing must preserve NFS trash');
    assert.ok(historicalTrashRequests().every(request => request.storage === 'local'));
    assert.equal(sha(await readBytes(item.id)), sha(bytes));
    report.cases.push('Clearing historical trash sends DELETE with storage=local, preserving both NFS trash and the client-local original');

    await click('.library-trash-nav [data-library-root]');
    await until('!document.querySelector("[data-library-breadcrumb]").hidden');
    await click('[data-library-breadcrumb] button');
    await until('document.querySelector("[data-library-folder=server-history-root]")');
    assert.equal(await js('document.querySelector("[data-library-storage=remote]").getAttribute("aria-selected")'), 'true');
    assert.ok(requests.some(request => request.method === 'GET' && request.path === '/api/v1/library'
      && request.storage === 'nfs' && !request.folderId));
    report.cases.push('Only the historical breadcrumb root exits history and returns to the remote NFS root');
    // The metadata remains while the real object is removed outside the app.
    // Exercise production IPC, renderer routing and modal UI against that state.
    await js(fs.readFileSync(path.join(client, 'components/panels/library-preview-pane.js'), 'utf8') + '\nvoid 0;');
    const missingRows = [];
    for (const filename of ['missing.pptx', 'missing.xlsx', 'missing.docx', 'missing.zip', 'missing.txt', 'missing.png']) {
      const row = (await js(`SoduWorkAPI.uploadLibraryFile(new File(['fixture bytes'],${JSON.stringify(filename)}),'','local')`)).item;
      const index = JSON.parse(fs.readFileSync(path.join(storageRoot, 'index.json'), 'utf8'));
      const target = path.join(storageRoot, index.items.find(x => x.id === row.id)._object);
      fs.unlinkSync(target); missingRows.push({ ...row, target });
    }
    await click('[data-library-storage=local]');
    await until(`document.querySelector('[data-library-file-preview="${missingRows[0].id}"]')`);
    const beforeOpens = systemOpens.length;
    const assertMissingDialog = async () => {
      await until('document.querySelector(".library-confirm-dialog[open]")');
      const text = await js('document.querySelector(".library-confirm-dialog").textContent');
      assert.match(text, /本地文件不存在/); assert.match(text, /恢复文件后重试/);
      assert.doesNotMatch(text, /ENOENT|lstat|objects|[A-Z]:\\/);
      assert.equal(await js('document.querySelector(".library-confirm-dialog").matches(":modal")'), true);
    };
    for (const row of missingRows.slice(0, 4)) {
      await click(`[data-library-open-system="${row.id}"]`);
      await assertMissingDialog(); await click('.library-confirm-submit');
    }
    assert.equal(systemOpens.length, beforeOpens, 'Missing files must never launch system applications');
    report.cases.push('Deleted Word, Excel, PowerPoint and ZIP files show a safe modal instead of native errors and never launch a system app');
    for (const row of missingRows.slice(4)) {
      await click(`[data-library-file-preview="${row.id}"]`);
      await until('document.querySelector(".library-preview-message")?.textContent.includes("本地文件不存在")');
      assert.equal(await js('document.querySelector(".library-preview-dialog").matches(":modal")'), true);
      assert.equal(await js('[...document.querySelectorAll(".library-preview-actions button")].filter(b=>!b.hidden).every(b=>b.disabled)'), true);
      assert.doesNotMatch(await js('document.querySelector(".library-preview-dialog").textContent'), /ENOENT|lstat|objects/);
      await click('[data-preview-close]'); await until('!document.querySelector(".library-preview-dialog")');
    }
    report.cases.push('Deleted text/image previews show recovery guidance inside the preview modal and disable unavailable file actions');
    await click(`[data-library-share="${missingRows[0].id}"]`);
    await until('document.querySelector(".library-share-dialog[open]")');
    await click('.library-share-members input');
    await js('document.querySelector("[data-library-share-note]").value="Keep this note";void 0;');
    await click('.library-share-submit'); await assertMissingDialog();
    assert.equal(shares.length, 0, 'Failed read must not send any notification');
    assert.equal(await js('document.querySelector("[data-library-share-error]").hidden'), true);
    win.setSize(560, 720);
    const rect = await js('(()=>{const r=document.querySelector(".library-confirm-dialog").getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth};})()');
    assert.ok(rect.left >= 0 && rect.right <= rect.width, 'Error dialog fits a narrow window');
    fs.writeFileSync(path.join(output, 'missing-file-dialog.png'), (await win.webContents.capturePage()).toPNG());
    await click('.library-confirm-submit');
    await until('!document.querySelector(".library-share-submit").disabled');
    assert.equal(await js('document.querySelector(".library-share-members input").checked'), true);
    assert.equal(await js('document.querySelector("[data-library-share-note]").value'), 'Keep this note');
    fs.writeFileSync(missingRows[0].target, 'restored fixture bytes');
    await click('.library-share-submit'); await until('!document.querySelector(".library-share-dialog")');
    assert.equal(shares.length, 1); assert.equal(shares[0].note, 'Keep this note');
    assert.equal(Buffer.from(shares[0].data, 'base64').toString('utf8'), 'restored fixture bytes');
    await click(`[data-library-open-system="${missingRows[0].id}"]`);
    await untilMain(() => systemOpens.length === beforeOpens + 1, 'restored system file opens');
    assert.ok((await listLocal()).items.some(row => row.id === missingRows[0].id));
    assert.doesNotMatch(await js('notices.join("\\n")'), /ENOENT|lstat|objects/);
    report.cases.push('Sharing a deleted file shows a narrow-layout modal, preserves recipients/note and metadata, and succeeds with exact bytes only after file restoration');
    assert.deepEqual(blocked, [], 'No request may attempt a production or external endpoint');
    report.counts = { cases: report.cases.length, httpRequests: requests.length, multipartUploads: uploads.length,
      emptyFileCreates: emptyCreates.length, historicalTrashClears: trashClears.length, blockedExternalRequests: blocked.length };
    report.ok = true;
  }).catch(async error => { report.error = String(error.stack || error); report.lastRequests = requests.slice(-8); report.visibleState = await js('document.querySelector("#libraryPanel")?.textContent').catch(() => ''); }).finally(async () => {
    if (win && !win.isDestroyed()) win.destroy();
    if (receiver) { receiver.closeAllConnections(); await new Promise(resolve => receiver.close(resolve)); }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  });
}
