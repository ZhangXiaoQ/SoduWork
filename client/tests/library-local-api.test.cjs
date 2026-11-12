'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const bytes = Buffer.from([0, 255, 13, 10, 42]);
const binary = () => ({ ok: true, name: 'private.bin', mimeType: 'application/octet-stream', size: 5, data: 'AP8NCio=' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const stale = error => error.code === 'STALE_TASK_SCOPE';
const shareOptions = { requestId: '6107d6aa-adbf-45ed-8c41-e3de833ee8a3' };

test('explicit local sharing sends the current filename and exact bytes only to notification storage', async () => {
  const h = harness(); await h.signIn('alice');
  h.native = async () => ({ ...binary(), name: 'renamed.bin' });
  await h.api.shareLibraryItem('local-one', ['bob'], 'Review', shareOptions);
  assert.equal(h.calls.length, 1); assert.match(h.calls[0].url, /\/library\/share-local$/);
  const body = JSON.parse(h.calls[0].request.body);
  assert.deepEqual(body, { requestId: shareOptions.requestId, localItemId: 'local-one', filename: 'renamed.bin',
    contentType: 'application/octet-stream', data: binary().data, recipientUserIds: ['bob'], note: 'Review' });
  assert.deepEqual(h.nativeCalls.map(row => row.action), ['readBinary']);
  await h.api.shareLibraryItem('local-one', ['bob'], 'Review', shareOptions);
  assert.equal(JSON.parse(h.calls[1].request.body).requestId, shareOptions.requestId);
});

test('local folder sharing reads nested files and forces one ZIP batch request', async () => {
  const h = harness(); await h.signIn('alice');
  h.native = async (action, payload) => {
    if (action === 'list') return payload.folderId === 'local-folder-one'
      ? { folders: [{ id: 'local-child-folder', name: 'nested' }], items: [] }
      : payload.folderId === 'local-child-folder'
        ? { folders: [], items: [{ id: 'local-nested-file', filename: 'detail.md', backend: 'local' }] }
        : { folders: [], items: [] };
    if (action === 'readBinary') return { ...binary(), name: 'detail.md', mimeType: 'text/markdown' };
    return { ok: true };
  };
  await h.api.shareLibraryItems([], ['bob'], 'Review', { ...shareOptions, folderIds: ['local-folder-one'] });
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].url, /\/library\/items\/batch-share$/);
  const body = JSON.parse(h.calls[0].request.body);
  assert.equal(body.forcePackage, true);
  assert.equal(body.localFiles[0].filename, 'nested/detail.md');
  assert.equal(body.localFiles[0].localItemId, 'local-nested-file');
});

test('the final owner-check await cannot dispatch old bytes after its internal scope assertion', async () => {
  const context = { Blob, Uint8Array, atob, queueMicrotask };
  vm.createContext(context);
  vm.runInContext(`var owner='A',contexts=0,sends=[],listeners=[];
    var window={addEventListener:(type,fn)=>listeners.push(fn),soduWorkAPI:{localLibrary:{
      context(){contexts++;if(contexts===2)queueMicrotask(()=>queueMicrotask(()=>{owner='B';listeners.forEach(fn=>fn())}));return Promise.resolve({owner:'A'});},
      call(){return Promise.resolve({ok:true,name:'private.txt',size:1,data:'QQ=='})}
    }}};
    var api={shareLocalLibraryFile:async body=>{sends.push({account:owner,data:body.data});return{ok:true}}};
    var deps={scope:()=>owner,assertScope:captured=>{if(captured!==owner)throw Object.assign(Error('changed'),{code:'STALE_TASK_SCOPE'})},blobToBase64:async()=> 'QQ=='};`, context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../api-library-local.js'), 'utf8'), context);
  vm.runInContext('window.SoduWorkLocalLibraryAPI.install(api,deps)', context);
  await assert.rejects(vm.runInContext(`api.shareLibraryItem('local-one',['recipient'],'',{requestId:'${shareOptions.requestId}'})`, context), stale);
  assert.equal(context.contexts, 2);
  assert.equal(context.sends.length, 0, 'The stale bytes must be rejected before the HTTP dispatch');
});

for (const boundary of ['read', 'encode', 'native-owner']) test(`local sharing stops after account changes during ${boundary}`, async () => {
  const h = harness(); await h.signIn('alice');
  if (boundary === 'read') h.native = async () => { await h.signIn('bob'); return binary(); };
  if (boundary === 'encode') h.encode = async () => { await h.signIn('bob'); return binary().data; };
  if (boundary === 'native-owner') h.native = async () => { h.bridge.localLibrary.context = async () => ({ owner: 'owner-bob' }); return binary(); };
  await assert.rejects(h.api.shareLibraryItem('local-one', ['bob'], '', shareOptions), stale);
  assert.equal(h.calls.length, 0);
});

test('saving a received notification explicitly uses the authenticated snapshot and native duplicate checks', async () => {
  const h = harness(); await h.signIn('alice');
  h.fetch = async () => new Response(JSON.stringify({ id: 'attachment-one', filename: 'renamed.bin', size: 5, url: '/attachments/safe', contentType: 'application/octet-stream' }));
  const downloads = [];
  h.bridge.readAttachmentBinary = async body => { downloads.push(body); return { ...binary(), name: 'untrusted.bin' }; };
  assert.equal(h.nativeCalls.length, 0);
  await h.api.saveMateMessageFileToLibrary('attachment-one');
  assert.match(h.calls[0].url, /\/team\/message-files\/attachment-one$/);
  assert.equal(downloads[0].filename, 'renamed.bin');
  const saved = h.nativeCalls[0]; assert.equal(saved.action, 'upload');
  assert.equal(saved.payload.name, 'renamed.bin'); assert.equal(saved.payload.dataBase64, binary().data);
  assert.equal(saved.payload.owner, 'owner-alice'); assert.equal(saved.payload.storage, 'local');
  assert.equal(saved.payload.rejectDuplicateName, true);
  h.native = async () => ({ ok: false, code: 'LIBRARY_NAME_CONFLICT', message: '存在同名资料' });
  await assert.rejects(h.api.saveMateMessageFileToLibrary('attachment-one'), error => error.code === 'LIBRARY_NAME_CONFLICT');
  assert(h.nativeCalls.every(row => row.action === 'upload'));
});

for (const changed of ['account', 'bytes']) test(`received snapshot save rejects changed ${changed} before native mutation`, async () => {
  const h = harness(); await h.signIn('alice');
  h.fetch = async () => new Response(JSON.stringify({ id: 'attachment-one', filename: 'renamed.bin', size: 5, url: '/attachments/safe' }));
  h.bridge.readAttachmentBinary = async () => {
    if (changed === 'account') await h.signIn('bob');
    return { ...binary(), data: changed === 'bytes' ? 'AA==' : binary().data };
  };
  await assert.rejects(h.api.saveMateMessageFileToLibrary('attachment-one'), error => changed === 'account' ? stale(error) : error.code === 'LOCAL_LIBRARY_BINARY_INVALID');
  assert.equal(h.nativeCalls.length, 0);
});

function harness(options = {}) {
  let user = 'alice';
  const values = new Map([['soduwork_work_hub_url', 'http://hub-a:8989']]);
  const h = { calls: [], nativeCalls: [], reads: 0, encode: async blob => Buffer.from(await blob.arrayBuffer()).toString('base64') };
  h.native = async action => action === 'readBinary' ? binary() : action === 'status'
    ? { ok: true, backend: 'local', available: true, configured: true, state: 'available' }
    : action === 'list' ? { folders: [], items: [{ id: 'local-one', backend: 'local' }] }
    : { ok: true, item: { id: 'local-one' } };
  h.fetch = async () => new Response(JSON.stringify({ ok: true, folders: [], items: [], item: { id: 'remote-one' } }));
  const bridge = {
    deviceAuthBootstrap: async () => ({ ok: true, stored: true, clientId: 'device-1', user: { id: user }, session: 'session-' + user, expiresIn: 1800 }),
    localLibrary: { context: async () => ({ owner: 'owner-' + user }), call: async (action, payload) => {
      h.nativeCalls.push({ action, payload }); return h.native(action, payload);
    } },
  };
  if (options.noBridge) delete bridge.localLibrary;
  const listeners = new Map();
  const window = { __SODUWORK_TEST_HUB_CONFIG__: { allowSwitch: true }, soduWorkAPI: bridge,
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); },
    dispatchEvent(event) { for (const callback of listeners.get(event.type) || []) callback(event); } };
  const context = { window, User: { id: 'device-1' }, navigator: { platform: 'test' },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    fetch: async (url, request) => { h.calls.push({ url, request }); return h.fetch(url, request); },
    URL, URLSearchParams, FormData, Blob, File, Response, Uint8Array, atob, AbortController,
    FileReader: class { async readAsDataURL(blob) { this.result = 'data:application/octet-stream;base64,' + await h.encode(blob); this.onload(); } },
    CustomEvent: class { constructor(type) { this.type = type; } }, console: { log() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  };
  const helper = path.join(__dirname, '../api-library-local.js');
  if (!options.noHelper && fs.existsSync(helper)) vm.runInNewContext(fs.readFileSync(helper, 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8'), context);
  h.api = window.SoduWorkAPI; h.bridge = bridge;
  h.signIn = async next => { user = next; await h.api.registerClient(); };
  h.switchScope = async kind => kind === 'user' ? h.signIn('bob') : h.api.setHubEnvironment('development', 'http://hub-b:8989');
  return h;
}

test('the default library and local folders never call Hub, including while Hub is offline', async () => {
  const h = harness(); await h.signIn('alice'); h.fetch = async () => { throw Error('Hub offline'); };
  assert.equal((await h.api.listLibrary()).items[0].id, 'local-one');
  await h.api.listLibrary({ storage: 'nfs', folderId: 'local-folder-one' });
  await h.api.createLibraryFolder('Folder');
  await h.api.createLibraryItem({ content: 'private' });
  await h.api.emptyLibraryTrash();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.nativeCalls.map(c => c.action), ['list', 'list', 'createFolder', 'createItem', 'emptyTrash']);
  assert(h.nativeCalls.every(c => c.payload.owner === 'owner-alice'));
});

test('local IDs route every read and mutation to the native owner, not an HTTP item endpoint', async () => {
  const h = harness(); await h.signIn('alice');
  await h.api.updateLibraryFolder('local-folder-one', { name: 'New' });
  await h.api.deleteLibraryFolder('local-folder-one');
  await h.api.readLibraryContent('local-one', { preview: true });
  await h.api.updateLibraryItem('local-one', { favorite: true });
  await h.api.associateLibrarySource('local-one', { sessionId: 's-1' });
  await h.api.deleteLibraryItem('local-one'); await h.api.restoreLibraryItem('local-one'); await h.api.purgeLibraryItem('local-one');
  await h.api.openLibraryExternally('local-one'); await h.api.revealLibraryItem('local-one'); await h.api.downloadLibraryItem('local-one', 'private.bin');
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.nativeCalls.map(c => c.action), ['updateFolder', 'deleteFolder', 'readContent', 'updateItem', 'associateSource', 'deleteItem', 'restoreItem', 'purgeItem', 'openExternal', 'reveal', 'exportFile']);
  assert(h.nativeCalls.every(c => c.payload.owner === 'owner-alice' && c.payload.id.startsWith('local-')));
  assert.equal(h.nativeCalls[2].payload.preview, true);
});

test('batch delete splits local and remote ids while preserving the result contract', async () => {
  const h = harness(); await h.signIn('alice');
  h.native = async action => action === 'deleteItems'
    ? { ok: true, succeeded: ['local-one'], failed: [] }
    : { ok: true };
  h.fetch = async () => new Response(JSON.stringify({ ok: true, succeeded: ['remote-one'], failed: [] }), { status: 200 });
  const result = await h.api.deleteLibraryItems(['local-one', 'remote-one']);
  assert.deepEqual(Array.from(result.succeeded), ['local-one', 'remote-one']);
  assert.deepEqual(Array.from(result.failed), []);
  assert.deepEqual(h.nativeCalls.map(row => row.action), ['deleteItems']);
  assert.deepEqual(Array.from(h.nativeCalls[0].payload.ids), ['local-one']);
  assert.match(h.calls[0].url, /\/library\/items\/batch-delete$/);
  assert.deepEqual(JSON.parse(h.calls[0].request.body), { itemIds: ['remote-one'] });
});

test('batch remote copy checks the provider once and copies local items in order', async () => {
  const h = harness(); await h.signIn('alice');
  let uploads = 0;
  h.fetch = async (url, request) => {
    if (String(url).includes('/library/storage/status')) {
      return new Response(JSON.stringify({ storage: { remote: { backend: 'nfs', available: true, configured: true } } }));
    }
    if (request?.method === 'POST') {
      uploads += 1;
      return new Response(JSON.stringify({ ok: true, item: { id: 'remote-' + uploads } }));
    }
    return new Response(JSON.stringify({ ok: true }));
  };
  const result = await h.api.copyLocalLibraryItemsToRemote(['local-one', 'local-one'], 'nfs');
  assert.deepEqual(Array.from(result.failed), []);
  assert.deepEqual(Array.from(result.succeeded, row => row.id), ['local-one']);
  assert.equal(uploads, 1);
  assert.deepEqual(h.nativeCalls.map(row => row.action), ['status', 'readBinary', 'updateItem']);
  assert.equal(h.calls.filter(row => row.request.method === 'POST').length, 1);
});

test('batch remote copy reports an individual upload failure and continues', async () => {
  const h = harness(); await h.signIn('alice');
  let uploads = 0;
  h.fetch = async (url, request) => {
    if (String(url).includes('/library/storage/status')) {
      return new Response(JSON.stringify({ storage: { remote: { backend: 'nfs', available: true, configured: true } } }));
    }
    if (request?.method === 'POST') {
      uploads += 1;
      if (uploads === 1) return new Response(JSON.stringify({ detail: { code: 'UPSTREAM_DOWN', message: '远端暂不可用' } }), { status: 503 });
      return new Response(JSON.stringify({ ok: true, item: { id: 'remote-two' } }));
    }
    return new Response(JSON.stringify({ ok: true }));
  };
  const result = await h.api.copyLocalLibraryItemsToRemote(['local-one', 'local-two'], 'nfs');
  assert.deepEqual(Array.from(result.succeeded, row => row.id), ['local-two']);
  assert.equal(result.failed.length, 1); assert.equal(result.failed[0].id, 'local-one');
  assert.equal(result.failed[0].code, 'UPSTREAM_DOWN'); assert.equal(uploads, 2);
});

test('batch remote copy does not upload when the selected remote provider is unavailable', async () => {
  const h = harness(); await h.signIn('alice');
  h.fetch = async (url, request) => String(url).includes('/library/storage/status')
    ? new Response(JSON.stringify({ storage: { remote: { backend: 'nfs', available: false, configured: true, code: 'UPSTREAM_DOWN', message: '远端不可用' } } }))
    : new Response(JSON.stringify({ ok: true, item: { id: 'unexpected' } }));
  const result = await h.api.copyLocalLibraryItemsToRemote(['local-one'], 'nfs');
  assert.equal(result.succeeded.length, 0); assert.equal(result.failed[0].code, 'UPSTREAM_DOWN');
  assert.deepEqual(h.nativeCalls.map(row => row.action), ['status']);
  assert.equal(h.calls.filter(row => row.request.method === 'POST').length, 0);
});

test('batch remote copy rejects oversized batches before reading local data', async () => {
  const h = harness(); await h.signIn('alice');
  await assert.rejects(h.api.copyLocalLibraryItemsToRemote(Array.from({ length: 101 }, (_, i) => 'local-' + i), 'nfs'), error => error.code === 'LIBRARY_BATCH_LIMIT');
  assert.equal(h.nativeCalls.length, 0); assert.equal(h.calls.length, 0);
});

test('batch remote copy reports remote IDs without sending them to the local upload path', async () => {
  const h = harness(); await h.signIn('alice');
  h.fetch = async (url, request) => String(url).includes('/library/storage/status')
    ? new Response(JSON.stringify({ storage: { remote: { backend: 'nfs', available: true, configured: true } } }))
    : new Response(JSON.stringify({ ok: true, item: { id: 'remote-one' } }));
  const result = await h.api.copyLocalLibraryItemsToRemote(['remote-existing'], 'nfs');
  assert.deepEqual(Array.from(result.succeeded), []); assert.equal(result.failed[0].id, 'remote-existing');
  assert.equal(result.failed[0].code, 'LOCAL_LIBRARY_ITEM_REQUIRED');
  assert.deepEqual(h.nativeCalls.map(row => row.action), ['status']);
});

test('batch remote copy stops after the account scope changes during an item', async () => {
  const h = harness(); await h.signIn('alice');
  let reads = 0;
  h.native = async action => {
    if (action === 'readBinary') { reads += 1; await h.signIn('bob'); return binary(); }
    return { ok: true };
  };
  h.fetch = async (url, request) => String(url).includes('/library/storage/status')
    ? new Response(JSON.stringify({ storage: { remote: { backend: 'nfs', available: true, configured: true } } }))
    : new Response(JSON.stringify({ ok: true, item: { id: 'unexpected' } }));
  await assert.rejects(h.api.copyLocalLibraryItemsToRemote(['local-one', 'local-two'], 'nfs'), stale);
  assert.equal(reads, 1); assert.equal(h.calls.filter(row => row.request.method === 'POST').length, 0);
  assert.equal(h.nativeCalls.filter(row => row.action === 'readBinary').length, 1);
});

test('batch remote copy reuses a verified recorded remote copy on retry', async () => {
  const h = harness(); await h.signIn('alice');
  h.native = async action => action === 'readBinary'
    ? { ...binary(), item: { extra: { lastRemoteCopy: { id: 'remote-existing', storage: 'nfs', folderId: '' } } } }
    : { ok: true };
  h.fetch = async (url, request) => {
    if (String(url).includes('/library/storage/status')) return new Response(JSON.stringify({ storage: { remote: { backend: 'nfs', available: true, configured: true } } }));
    if (request?.method === 'GET') return new Response(bytes, { headers: { 'Content-Disposition': 'attachment; filename="private.bin"' } });
    throw Error('unexpected upload');
  };
  const result = await h.api.copyLocalLibraryItemsToRemote(['local-one'], 'nfs');
  assert.equal(result.failed.length, 0); assert.equal(result.succeeded[0].result.reused, true);
  assert.equal(h.calls.filter(row => row.request.method === 'POST').length, 0);
});

test('file uploads preserve exact bytes, names, source, and empty files on the client', async () => {
  const h = harness(); await h.signIn('alice');
  await h.api.uploadLibraryFile(new File([bytes], '中文.bin', { type: 'application/octet-stream' }), '', '', { type: 'conversation', sessionId: 's-1' });
  await h.api.uploadLibraryFile(new File([], 'empty.txt'), '', 'local');
  assert.equal(h.calls.length, 0);
  const payload = h.nativeCalls[0].payload;
  assert.deepEqual(Buffer.from(payload.dataBase64, 'base64'), bytes); assert.equal(payload.name, '中文.bin');
  assert.equal(payload.source.sessionId, 's-1'); assert.equal(h.nativeCalls[1].payload.dataBase64, '');
  const got = await h.api.readLibraryBinary('local-one');
  assert.deepEqual(Buffer.from(await got.blob.arrayBuffer()), bytes); assert.equal(got.name, 'private.bin');
});

for (const options of [{ noBridge: true }, { noHelper: true }]) {
  test(`missing ${options.noBridge ? 'native bridge' : 'adapter asset'} cannot silently create server-local data`, async () => {
    const h = harness(options); await h.signIn('alice');
    for (const action of [() => h.api.listLibrary(), () => h.api.createLibraryItem({ content: 'private' }),
      () => h.api.uploadLibraryFile(new File([bytes], 'private.bin')), () => h.api.deleteLibraryItem('local-one')]) {
      await assert.rejects(action(), error => error.code === 'LOCAL_LIBRARY_UNAVAILABLE');
    }
    assert.equal(h.calls.length, 0);
  });
}

test('storage status keeps native availability when Hub fails and exposes the actual remote error', async () => {
  const h = harness(); await h.signIn('alice');
  h.fetch = async () => new Response(JSON.stringify({ detail: { code: 'UPSTREAM_DOWN', message: '远程网关不可用' } }), { status: 503 });
  const result = await h.api.getLibraryStorageStatus();
  assert.equal(result.default, 'local'); assert.equal(result.storage.local.available, true);
  assert.equal(result.storage.remote.available, false); assert.equal(result.storage.remote.code, 'UPSTREAM_DOWN');
  assert.equal(result.storage.remote.message, '远程网关不可用');
  const local = await h.api.listLibrary(); assert.equal(local.items[0].id, 'local-one');
});

test('native IPC errors lose the Electron transport wrapper and retain the local error code', async () => {
  const h = harness(); await h.signIn('alice');
  h.native = async action => {
    if (action === 'list') throw Error("Error invoking remote method 'library-local-call': Error: 本机资料索引损坏；原文件已保留，请勿覆盖索引");
    return { ok: true };
  };
  await assert.rejects(h.api.listLibrary(), error =>
    error.code === 'LOCAL_LIBRARY_INDEX_CORRUPT' &&
    error.message === '本机资料索引损坏；原文件已保留，请勿覆盖索引');
});

test('server local health never substitutes for an unavailable native library', async () => {
  const h = harness({ noBridge: true }); await h.signIn('alice');
  h.fetch = async () => new Response(JSON.stringify({ default: 'nfs', remoteBackend: 'nfs', storage: {
    local: { available: true }, remote: { available: true, backend: 'nfs' }, nfs: { available: true, backend: 'nfs' },
  } }));
  const result = await h.api.getLibraryStorageStatus();
  assert.equal(result.default, 'local'); assert.equal(result.local.available, false); assert.equal(result.local.code, 'LOCAL_LIBRARY_UNAVAILABLE');
  assert.equal(result.storage.remote.available, true);
});

test('a legacy flat Hub MinIO capability remains remote while its local capability never replaces the client', async () => {
  const h = harness(); await h.signIn('alice');
  h.fetch = async () => new Response(JSON.stringify({ ok: true, local: { available: false }, minio: { configured: true, available: true } }));
  const result = await h.api.getLibraryStorageStatus();
  assert.equal(result.storage.local.available, true); assert.equal(result.remoteBackend, 'minio');
  assert.equal(result.storage.remote.available, true); assert.equal(result.storage.remote.backend, 'minio');
  assert.equal(result.storage.minio.available, true);
});

test('remote copies preserve conversation provenance from the native item', async () => {
  const h = harness(); await h.signIn('alice');
  h.native = async action => action === 'readBinary' ? { ...binary(), item: { sourceType: 'conversation', sessionId: 'conversation-one', conversationTitle: '设计评审' } } : { ok: true };
  await h.api.copyLocalLibraryItemToRemote('local-one', 'nfs');
  const form = h.calls[0].request.body;
  assert.equal(form.get('sourceType'), 'conversation'); assert.equal(form.get('sessionId'), 'conversation-one'); assert.equal(form.get('conversationTitle'), '设计评审');
});

test('remote roots expose historical Hub local files through a separate, read-only virtual directory', async () => {
  const h = harness(); await h.signIn('alice');
  const root = await h.api.listLibrary({ storage: 'nfs', scope: 'all' });
  assert.equal(root.folders[0].id, 'server-history-root'); assert.equal(root.folders[0].storageOrigin, 'server-history');
  h.fetch = async () => new Response(JSON.stringify({ folders: [{ id: 'old-folder', parentId: '', name: 'Old' }], items: [{ id: 'old-item', backend: 'local' }] }));
  const old = await h.api.listLibrary({ storage: 'nfs', folderId: 'server-history-root' });
  assert.equal(new URL(h.calls[1].url).searchParams.get('storage'), 'local');
  assert.equal(new URL(h.calls[1].url).searchParams.has('folderId'), false);
  assert.equal(old.folders[0].id, 'server-history-old-folder'); assert.equal(old.items[0].id, 'old-item');
  assert.equal(old.items[0].storageOrigin, 'server-history');
  await h.api.listLibrary({ storage: 'nfs', folderId: 'server-history-old-folder' });
  assert.equal(new URL(h.calls[2].url).searchParams.get('folderId'), 'old-folder');
  await h.api.updateLibraryItem('old-item', { favorite: true });
  assert.equal(h.nativeCalls.length, 0); assert.match(h.calls[3].url, /items\/old-item$/);
  for (const action of [() => h.api.createLibraryFolder('new', 'server-history-root', 'nfs'),
    () => h.api.uploadLibraryFile(new File([bytes], 'x'), 'server-history-old-folder', 'nfs'),
    () => h.api.createLibraryItem({ folderId: 'server-history-root', storage: 'nfs' }),
    () => h.api.updateLibraryFolder('server-history-old-folder', { name: 'new' }),
    () => h.api.deleteLibraryFolder('server-history-root')]) {
    await assert.rejects(action(), error => error.code === 'LIBRARY_HISTORY_READ_ONLY');
  }
  assert.equal(h.calls.length, 4);
});

test('historical trash is flat Hub-local data and its explicit empty action never clears NFS or client trash', async () => {
  const h = harness(); await h.signIn('alice');
  h.fetch = async () => new Response(JSON.stringify({ folders: [], items: [{ id: 'old-deleted', backend: 'local', isDeleted: true }], trashCount: 1 }));
  const result = await h.api.listLibrary({ storage: 'nfs', scope: 'trash', folderId: 'server-history-old-folder' });
  const query = new URL(h.calls[0].url).searchParams;
  assert.equal(query.get('storage'), 'local'); assert.equal(query.get('scope'), 'trash'); assert.equal(query.has('folderId'), false);
  assert.equal(result.items[0].id, 'old-deleted'); assert.equal(result.items[0].storageOrigin, 'server-history');
  assert.equal(result.trashCount, 1);
  await h.api.restoreLibraryItem('old-deleted');
  await h.api.emptyLibraryTrash('nfs', { storageOrigin: 'server-history' });
  assert.match(h.calls[1].url, /items\/old-deleted\/restore$/);
  assert.equal(new URL(h.calls[2].url).searchParams.get('storage'), 'local'); assert.equal(h.calls[2].request.method, 'DELETE');
  assert.equal(h.nativeCalls.length, 0);
  await h.api.emptyLibraryTrash('nfs');
  assert.equal(new URL(h.calls[3].url).searchParams.get('storage'), 'nfs');
  await h.api.emptyLibraryTrash('local');
  assert.equal(h.nativeCalls[0].action, 'emptyTrash'); assert.equal(h.calls.length, 4);
});

test('copying client bytes to NFS uses multipart, preserves the local source, and records the remote copy', async () => {
  const h = harness(); await h.signIn('alice');
  const result = await h.api.copyLocalLibraryItemToRemote('local-one', { storage: 'nfs', folderId: 'remote-folder' });
  assert.equal(result.item.id, 'remote-one'); assert.equal(result.copied, true); assert.equal(result.localItemId, 'local-one');
  assert.equal(h.calls.length, 1); const request = h.calls[0].request;
  assert.equal(request.method, 'POST'); assert.match(h.calls[0].url, /items\/upload$/);
  assert.equal(request.body.get('storage'), 'nfs'); assert.equal(request.body.get('folderId'), 'remote-folder');
  assert.equal(request.body.get('rejectDuplicateName'), 'true');
  assert.deepEqual(Buffer.from(await request.body.get('file').arrayBuffer()), bytes);
  assert.deepEqual(h.nativeCalls.map(c => c.action), ['readBinary', 'updateItem']);
  assert.equal(h.nativeCalls[1].payload.body.extra.lastRemoteCopy.id, 'remote-one');
  assert.equal(h.nativeCalls[1].payload.body.storage, undefined);
});

test('empty client files create an exact empty remote file without using the non-empty upload endpoint', async () => {
  const h = harness(); await h.signIn('alice');
  h.native = async action => action === 'readBinary' ? { ...binary(), data: '', size: 0, name: 'empty.bin' } : { ok: true };
  const result = await h.api.copyLocalLibraryItemToRemote('local-one', 'nfs');
  assert.equal(result.copied, true); assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].url, /\/library\/items$/);
  const body = JSON.parse(h.calls[0].request.body);
  assert.equal(body.kind, 'file'); assert.equal(body.filename, 'empty.bin'); assert.equal(body.content, ''); assert.equal(body.storage, 'nfs');
  assert.equal(body.rejectDuplicateName, true);
  assert.deepEqual(h.nativeCalls.map(c => c.action), ['readBinary', 'updateItem']);
});

test('failed remote copies leave the source unchanged, while metadata failure cannot hide a successful copy', async () => {
  const h = harness(); await h.signIn('alice');
  h.fetch = async () => new Response('NFS unavailable', { status: 503 });
  await assert.rejects(h.api.copyLocalLibraryItemToRemote('local-one', 'nfs'));
  assert.deepEqual(h.nativeCalls.map(c => c.action), ['readBinary']);
  h.fetch = async () => new Response('{"ok":true,"item":{"id":"remote-one"}}');
  h.native = async action => action === 'readBinary' ? binary() : { ok: false, code: 'DISK_FULL', message: '磁盘已满' };
  const copy = await h.api.copyLocalLibraryItemToRemote('local-one', 'nfs');
  assert.equal(copy.item.id, 'remote-one'); assert.equal(copy.copyRecordSaved, false);
  assert(h.nativeCalls.every(c => c.action !== 'deleteItem'));
});

test('explicit remote copies reuse a recorded item only after verifying its current name and bytes', async () => {
  const h = harness(); await h.signIn('alice');
  h.native = async action => action === 'readBinary' ? { ...binary(), item: { extra: { lastRemoteCopy: { id: 'remote-existing', storage: 'nfs', folderId: '' } } } } : { ok: true };
  h.fetch = async () => new Response(bytes, { headers: { 'Content-Disposition': 'attachment; filename="private.bin"' } });
  const reused = await h.api.copyLocalLibraryItemToRemote('local-one', { storage: 'nfs', reuseExisting: true });
  assert.equal(reused.item.id, 'remote-existing'); assert.equal(reused.reused, true);
  assert(h.calls.every(c => c.request.method === 'GET'));
  assert.deepEqual(h.nativeCalls.map(c => c.action), ['readBinary']);
  h.calls.length = 0;
  h.fetch = async (_url, request) => request.method === 'GET'
    ? new Response('different bytes', { headers: { 'Content-Disposition': 'attachment; filename="private.bin"' } })
    : new Response(JSON.stringify({ detail: { code: 'LIBRARY_NAME_CONFLICT', message: '已有同名资料' } }), { status: 409 });
  await assert.rejects(h.api.copyLocalLibraryItemToRemote('local-one', { storage: 'nfs', reuseExisting: true }), error => error.code === 'LIBRARY_NAME_CONFLICT');
  assert.equal(h.calls.at(-1).request.body.get('rejectDuplicateName'), 'true');
});

test('a remote copy cannot reuse an item after the native account changes during verification', async () => {
  const h = harness(); await h.signIn('alice');
  h.native = async () => ({ ...binary(), item: { extra: { lastRemoteCopy: { id: 'remote-existing', storage: 'nfs' } } } });
  h.fetch = async () => {
    h.bridge.localLibrary.context = async () => ({ owner: 'owner-bob' });
    return new Response(bytes, { headers: { 'Content-Disposition': 'attachment; filename="private.bin"' } });
  };
  await assert.rejects(h.api.copyLocalLibraryItemToRemote('local-one', { storage: 'nfs', reuseExisting: true }), stale);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].request.method, 'GET');
});

test('a changed native owner cannot receive the previous owner’s bytes while renderer auth is catching up', async () => {
  const h = harness(), encode = deferred(); await h.signIn('alice'); h.encode = () => encode.promise;
  let currentOwner = 'owner-alice'; h.bridge.localLibrary.context = async () => ({ owner: currentOwner });
  h.native = async (action, payload) => payload.owner !== currentOwner ? { ok: false, code: 'STALE_TASK_SCOPE', message: '账号已切换' } : { ok: true };
  const pending = h.api.uploadLibraryFile(new File([bytes], 'private.bin'));
  await tick(); currentOwner = 'owner-bob'; encode.resolve('AP8NCio=');
  await assert.rejects(pending, stale);
  assert.equal(h.nativeCalls[0].payload.owner, 'owner-alice'); assert.equal(h.calls.length, 0);
});

test('switching away and back still cancels a pending copy instead of reviving an old operation', async () => {
  const h = harness(), read = deferred(); await h.signIn('alice'); h.native = () => read.promise;
  const pending = h.api.copyLocalLibraryItemToRemote('local-one', 'nfs');
  await tick(); await h.signIn('bob'); await h.signIn('alice'); read.resolve(binary());
  await assert.rejects(pending, stale); assert.equal(h.calls.length, 0);
});

test('cancelling local export is returned normally and never falls through to a browser download', async () => {
  const h = harness(); await h.signIn('alice'); h.native = async () => ({ ok: false, cancelled: true });
  const result = await h.api.downloadLibraryItem('local-one', 'private.bin');
  assert.equal(result.cancelled, true); assert.equal(h.calls.length, 0);
});

test('local archive and cross-storage PATCH cannot upload or expose private bytes implicitly', async () => {
  const h = harness(); await h.signIn('alice');
  for (const [action, code] of [
    [() => h.api.getLibraryArchive('local-one'), 'LOCAL_LIBRARY_ARCHIVE_UNSUPPORTED'],
    [() => h.api.readLibraryArchiveFile('local-one', 'private.txt'), 'LOCAL_LIBRARY_ARCHIVE_UNSUPPORTED'],
    [() => h.api.updateLibraryItem('local-one', { storage: 'nfs' }), 'LOCAL_LIBRARY_COPY_REQUIRED'],
    [() => h.api.copyLocalLibraryItemToRemote('local-one', 'local'), 'LIBRARY_REMOTE_REQUIRED'],
    [() => h.api.uploadLibraryFile(new File([bytes], 'x'), 'local-folder-one', 'nfs'), 'LIBRARY_FOLDER_BACKEND_MISMATCH'],
  ]) await assert.rejects(action(), error => error.code === code);
  assert.equal(h.calls.length, 0); assert.equal(h.nativeCalls.length, 0);
});

for (const scope of ['user', 'hub']) {
  test(`pending owner lookup cannot dispatch an old local mutation after ${scope} changes`, async () => {
    const h = harness(), owner = deferred(); await h.signIn('alice');
    h.bridge.localLibrary.context = () => owner.promise;
    const result = h.api.createLibraryItem({ content: 'private' });
    await h.switchScope(scope); owner.resolve({ owner: 'owner-alice' });
    await assert.rejects(result, stale); assert.equal(h.nativeCalls.length, 0); assert.equal(h.calls.length, 0);
  });
  test(`pending local copy read cannot upload old bytes after ${scope} changes`, async () => {
    const h = harness(), read = deferred(); await h.signIn('alice'); h.native = () => read.promise;
    const result = h.api.copyLocalLibraryItemToRemote('local-one', 'nfs');
    await tick(); await h.switchScope(scope); read.resolve(binary());
    await assert.rejects(result, stale); assert.equal(h.calls.length, 0);
  });
  test(`local file encoding cannot dispatch to the next ${scope}`, async () => {
    const h = harness(), encode = deferred(); await h.signIn('alice'); h.encode = () => encode.promise;
    const result = h.api.uploadLibraryFile(new File([bytes], 'private.bin'));
    await tick(); await h.switchScope(scope); encode.resolve('AP8NCio=');
    await assert.rejects(result, stale); assert.equal(h.nativeCalls.length, 0); assert.equal(h.calls.length, 0);
  });
  test(`a late remote copy result cannot annotate the next ${scope}'s local library`, async () => {
    const h = harness(), body = deferred(); await h.signIn('alice');
    h.fetch = async () => ({ ok: true, status: 200, text: () => body.promise });
    const result = h.api.copyLocalLibraryItemToRemote('local-one', 'nfs');
    await tick(); await h.switchScope(scope); body.resolve('{"ok":true,"item":{"id":"remote-one"}}');
    await assert.rejects(result, stale); assert.deepEqual(h.nativeCalls.map(c => c.action), ['readBinary']);
    assert.equal(h.calls[0].request.headers.Authorization, 'Device session-alice');
  });
}


test('generated files persist in the default PC library with durable owner-scoped receipts', async t => {
  const os = require('node:os'), crypto = require('node:crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-output-library-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const storage = require('../main/library-local-store.cjs'), { execute } = require('../main/library-local-actions.cjs');
  const h = harness(); await h.signIn('alice');
  h.native = (action, payload) => {
    const owner = crypto.createHash('sha256').update(payload.owner).digest('hex').slice(0, 32);
    const store = storage.create({ getPath: () => root }, owner, () => {}, root);
    return store.run(index => execute(store, index, action, payload));
  };
  h.fetch = async () => { throw Error('Hub is offline'); };
  for (const ext of ['md', 'html', 'png', 'pdf', 'xlsx', 'docx', 'pptx', 'zip']) {
    const bytes = Buffer.from('exact fixture bytes: ' + ext);
    const manifest = { source: 'local', sessionId: 'session-' + ext, revision: 'v1', title: '课程表.' + ext,
      conversationTitle: '生成课程表', files: [{ path: '课程表.' + ext, size: bytes.length }] };
    const payload = { manifest, filename: '课程表.' + ext, data: bytes.toString('base64') };
    assert.equal((await h.api.getLibraryDeliveryStatus(manifest)).delivery, null);
    const saved = await h.api.saveLibraryDelivery(payload);
    assert.match(saved.item.id, /^local-/); assert.equal(saved.item.sourceType, 'conversation');
    assert.equal(saved.item.sessionId, manifest.sessionId);
    assert.equal((await h.api.getLibraryDeliveryStatus(manifest)).delivery.id, saved.item.id);
    assert.equal((await h.api.saveLibraryDelivery(payload)).item.id, saved.item.id);
    for (const scope of ['recommended', 'all']) assert.ok((await h.api.listLibrary({ scope })).items.some(item => item.id === saved.item.id));
    assert.deepEqual(Buffer.from(await (await h.api.readLibraryBinary(saved.item.id)).blob.arrayBuffer()), bytes);
    await h.api.deleteLibraryItem(saved.item.id);
    assert.equal((await h.api.getLibraryDeliveryStatus(manifest)).delivery, null);
    assert.notEqual((await h.api.saveLibraryDelivery(payload)).item.id, saved.item.id);
  }
  assert.equal((await h.api.listLibrary()).items.length, 8);
  await h.signIn('bob'); assert.equal((await h.api.listLibrary()).items.length, 0);
});

test('cloud package receipts remain unsaved until exact bytes enter the PC library', async () => {
  const h = harness(); await h.signIn('alice');
  const delivery = { id: 'hub-package', source: 'cloud', sessionId: 'cloud-session', revision: 'v1',
    filename: 'result.zip', size: bytes.length, files: [{ path: 'a.txt', size: 5 }] };
  let saved = null;
  h.native = async (action, payload) => {
    if (action === 'outputStatus') return { ok: true, item: saved };
    if (action === 'upload') {
      assert.deepEqual(Buffer.from(payload.dataBase64, 'base64'), bytes);
      assert.equal(payload.name, 'result.zip');
      assert.equal(payload.source.sessionId, 'cloud-session');
      assert.equal(payload.source.outputKey, JSON.stringify(['delivery', 'cloud-session', 'v1']));
      return { ok: true, item: saved = { id: 'local-cloud-copy', filename: payload.name } };
    }
    throw Error('Unexpected local action: ' + action);
  };
  h.fetch = async (url, request) => {
    assert.ok(!request.method || request.method === 'GET');
    return url.includes('/from-task/') ? new Response(JSON.stringify({ ok: true, state: 'synced', delivery }))
      : new Response(bytes, { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(bytes.length) } });
  };
  assert.equal((await h.api.getTaskLibraryDeliveryStatus('task')).delivery, null);
  assert.deepEqual(h.nativeCalls.map(c => c.action), ['outputStatus']);
  assert.equal((await h.api.saveTaskLibraryDelivery('task')).delivery.id, 'local-cloud-copy');
  assert.equal((await h.api.getTaskLibraryDeliveryStatus('task')).delivery.id, 'local-cloud-copy');
  await h.api.saveTaskLibraryDelivery('task');
  assert.equal(h.nativeCalls.filter(c => c.action === 'upload').length, 1);
});

test('cloud save rejects a changed version and an account switch before local persistence', async () => {
  for (const changed of ['revision', 'account']) {
    const h = harness(); await h.signIn('alice');
    h.native = async () => ({ ok: true, item: null });
    let reads = 0;
    h.fetch = async url => {
      if (url.includes('/from-task/')) return new Response(JSON.stringify({ state: 'synced', delivery: {
        id: 'hub-package', sessionId: 's', revision: ++reads > 1 ? 'v2' : 'v1',
        filename: 'result.zip', size: bytes.length, files: [{ path: 'a.txt' }],
      } }));
      if (changed === 'account') await h.signIn('bob');
      return new Response(bytes);
    };
    await assert.rejects(h.api.saveTaskLibraryDelivery('task'), error =>
      error.code === (changed === 'account' ? 'STALE_TASK_SCOPE' : 'LIBRARY_DELIVERY_CHANGED'));
    assert.equal(h.nativeCalls.filter(c => c.action === 'upload').length, 0);
  }
});

test('historical card selection rejects current receipts before status, sync or download', async () => {
  for (const selection of [{round: 1, executionRef: 'run'}, {round: 2, executionRef: 'other'}, {}]) {
    const h = harness(); await h.signIn('alice');
    h.fetch = async url => {
      assert.match(url, /\/from-task\//);
      return new Response(JSON.stringify({state: 'pending', round: 2, executionRef: 'run', retryable: true}));
    };
    for (const method of ['getTaskLibraryDeliveryStatus', 'saveTaskLibraryDelivery']) {
      await assert.rejects(h.api[method]('task', selection), error => error.code === 'LIBRARY_DELIVERY_CHANGED');
    }
    assert.equal(h.nativeCalls.length, 0);
    assert.equal(h.calls.some(call => call.request?.method === 'POST'), false);
  }
});

test('verified historical receipts keep their original bytes and saved state after a later task turn', async () => {
  const h = harness(); await h.signIn('alice');
  const delivery = {id: 'original-package', source: 'cloud', sessionId: 'cloud-session', revision: 'original-v1',
    filename: 'old.zip', size: bytes.length, files: [{path: 'old.txt'}]};
  let round = 1, saved = null;
  h.fetch = async url => {
    if (url.includes('/from-task/')) return new Response(JSON.stringify({state: 'synced', round, executionRef: 'run',
      delivery: round === 1 ? delivery : {...delivery, id: 'new-package', revision: 'new-v2', filename: 'new.zip'}}));
    if (url.endsWith('/deliveries/original-package')) return new Response(JSON.stringify({delivery}));
    assert.match(url, /original-package/);
    return new Response(bytes);
  };
  h.native = async (action, payload) => {
    if (action === 'outputStatus') return {ok: true, item: saved};
    assert.equal(action, 'upload'); assert.equal(payload.name, 'old.zip');
    assert.deepEqual(Buffer.from(payload.dataBase64, 'base64'), bytes);
    return {ok: true, item: saved = {id: 'local-original'}};
  };
  const initial = await h.api.getTaskLibraryDeliveryStatus('task', {round: 1, executionRef: 'run'});
  const selected = {round: 1, executionRef: 'run', deliveryId: initial.manifest.id, revision: initial.manifest.revision};
  round = 2;
  assert.equal((await h.api.saveTaskLibraryDelivery('task', selected)).delivery.id, 'local-original');
  assert.equal((await h.api.getTaskLibraryDeliveryStatus('task', selected)).delivery.id, 'local-original');
  assert.equal(h.calls.filter(call => call.url.includes('/from-task/')).length, 1);
});

test('collection changing turns rejects the newly collected receipt before saving', async () => {
  const h = harness(); await h.signIn('alice');
  h.fetch = async (_url, request) => new Response(JSON.stringify(request.method === 'POST'
    ? {state: 'synced', round: 2, executionRef: 'run', delivery: {id: 'new-package', revision: 'v2'}}
    : {state: 'pending', round: 1, executionRef: 'run', retryable: true}));
  await assert.rejects(h.api.saveTaskLibraryDelivery('task', {round: 1, executionRef: 'run'}),
    error => error.code === 'LIBRARY_DELIVERY_CHANGED');
  assert.equal(h.nativeCalls.length, 0);
});

test('generated-file save rejects absent persistence receipts and supports retry', async () => {
  const h = harness(); await h.signIn('alice');
  const payload = { manifest: { source: 'local', sessionId: 's', revision: 'v', files: [{ path: 'a.md' }] }, filename: 'a.md', data: 'YQ==' };
  h.native = async () => ({ ok: true });
  await assert.rejects(h.api.saveLibraryDelivery(payload), /保存到资料库失败/);
  h.native = async () => { throw Error('磁盘空间不足'); };
  await assert.rejects(h.api.saveLibraryDelivery(payload), /磁盘空间不足/);
  h.native = async () => ({ ok: true, item: { id: 'local-saved' } });
  assert.equal((await h.api.saveLibraryDelivery(payload)).delivery.id, 'local-saved');
  assert.equal(h.calls.filter(call => call.request?.method === 'POST').length, 0);
});

test('generated-file save rejects account switch during native context lookup', async () => {
  const h = harness(); await h.signIn('alice');
  h.bridge.localLibrary.context = async () => { await h.signIn('bob'); return { owner: 'owner-alice' }; };
  await assert.rejects(h.api.saveLibraryDelivery({ manifest: { source: 'local', sessionId: 's', revision: 'v', files: [{}] }, filename: 'a.md', data: 'YQ==' }), /切换|变化/);
  assert.equal(h.nativeCalls.length, 0);
});


test('missing local files reject single and bundled shares before any network transmission', async () => {
  const h = harness(); await h.signIn('alice');
  h.native = async action => action === 'list'
    ? { items: [{ id: 'local-missing', filename: 'lost.pptx' }], folders: [] }
    : { ok: false, code: 'LOCAL_LIBRARY_FILE_MISSING', message: 'Local file is missing' };
  for (const invoke of [
    () => h.api.readLibraryContent('local-missing'),
    () => h.api.openLibraryExternally('local-missing'),
    () => h.api.shareLibraryItem('local-missing', ['bob'], '', shareOptions),
    () => h.api.shareLibraryItems(['local-missing'], ['bob'], '', shareOptions),
    () => h.api.shareLibraryItems([], ['bob'], '', { ...shareOptions, folderIds: ['local-folder-one'] }),
  ]) await assert.rejects(invoke(), error => error.code === 'LOCAL_LIBRARY_FILE_MISSING');
  assert.equal(h.calls.length, 0);
});
