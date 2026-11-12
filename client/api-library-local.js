/*
 * Renderer library routing. Empty/local storage always means the client PC.
 * Main owns the files and validates payload.owner against deviceAuth.localOwner.
 * Local IDs are local-UUID / local-folder-UUID; every other item ID stays on Hub.
 *
 * Historical Hub-local data is reachable only through the remote root's virtual
 * server-history-root / server-history-<Hub folder ID> directories. These carry
 * storageOrigin=server-history and are read-only navigation, never upload or
 * folder mutation destinations. Historical item IDs remain unchanged so existing
 * download/edit/favorite/trash/share endpoints retain their original behavior.
 * Historical trash keeps the virtual root in list filters; emptyLibraryTrash
 * requires options.storageOrigin=server-history to target the old Hub-local trash.
 * Copying a PC item uploads its bytes and keeps the source; it never PATCHes a
 * backend or automatically moves old data. Explicit sharing sends a notification
 * snapshot; it does not create a remote library item.
 */
(function (global) {
  'use strict';
  var HISTORY = 'server-history-', HISTORY_ROOT = HISTORY + 'root';
  var BINARY_LIMIT = 64 * 1024 * 1024;
  function failure(code, message) { var e = new Error(message); e.code = code; return e; }
  function nativeFailure(error) {
    var raw = String(error && (error.message || error.reason) || error || '本机资料库操作失败');
    // Electron prefixes renderer-visible rejections with the IPC method name
    // and a second `Error:`. Strip that transport detail before it reaches the
    // library panel, while retaining the useful native error text.
    var wrapped = raw.match(/^Error invoking remote method '[^']+':\s*Error:\s*([\s\S]*)$/);
    var message = (wrapped ? wrapped[1] : raw).replace(/^Error:\s*/, '').trim();
    var code = error && error.code;
    if (!code && message.indexOf('本机资料索引损坏') >= 0) code = 'LOCAL_LIBRARY_INDEX_CORRUPT';
    return failure(code || 'LOCAL_LIBRARY_ERROR', message || '本机资料库操作失败');
  }
  function isLocal(id) { return String(id || '').startsWith('local-'); }
  function isHistory(id) { return String(id || '').startsWith(HISTORY); }
  function isLocalStorage(storage) { return !storage || storage === 'local'; }
  function requestId() {
    try { if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID(); } catch (_) {}
    var hex = '0123456789abcdef', value = '';
    for (var i = 0; i < 32; i += 1) value += hex[Math.floor(Math.random() * hex.length)];
    return value.slice(0, 8) + '-' + value.slice(8, 12) + '-4' + value.slice(13, 16) + '-' + (8 + Math.floor(Math.random() * 4)).toString(16) + value.slice(17, 20) + '-' + value.slice(20);
  }
  function storedWorkRoot() {
    try {
      const direct = typeof global.workRoot === 'function' ? global.workRoot() : global.localStorage?.getItem('soduwork_work_root');
      return String(direct || '').trim();
    } catch (_) { return ''; }
  }
  async function currentWorkRoot() {
    let root = storedWorkRoot();
    if (!root && global.soduWorkAPI?.getDefaultWorkRoot) {
      try {
        root = String(await global.soduWorkAPI.getDefaultWorkRoot() || '').trim();
        if (root) { try { global.localStorage?.setItem('soduwork_work_root', root); } catch (_) {} }
      } catch (_) {}
    }
    return root;
  }
  function requireRemote(storage) {
    if (storage !== 'nfs' && storage !== 'minio') throw failure('LIBRARY_REMOTE_REQUIRED', '请选择已连接的远程存储');
    return storage;
  }
  function rejectHistory(id) {
    if (isHistory(id)) throw failure('LIBRARY_HISTORY_READ_ONLY', '历史服务器目录仅供浏览，请返回远程根目录保存新资料');
  }
  function checkFolder(folderId, storage) {
    rejectHistory(folderId);
    if (folderId && isLocal(folderId) !== isLocalStorage(storage)) {
      throw failure('LIBRARY_FOLDER_BACKEND_MISMATCH', '资料和目标文件夹必须位于同一存储');
    }
  }
  function noArchive() { throw failure('LOCAL_LIBRARY_ARCHIVE_UNSUPPORTED', '本机压缩包暂不支持内嵌浏览，请下载原件或使用默认应用打开'); }
  function unavailable(error, backend) {
    return { backend: backend || '', state: 'unavailable', configured: false, available: false, enabled: false, connected: false,
      code: error?.code || (backend === 'local' ? 'LOCAL_LIBRARY_UNAVAILABLE' : 'LIBRARY_REMOTE_UNAVAILABLE'),
      message: error?.message || '存储暂不可用' };
  }
  function historyFolder(row, backend) {
    return Object.assign({}, row, { id: HISTORY + row.id, parentId: row.parentId ? HISTORY + row.parentId : HISTORY_ROOT,
      backend: backend, storageOrigin: 'server-history', readOnly: true });
  }
  function historyRoot(backend) {
    return { id: HISTORY_ROOT, parentId: '', name: '历史服务器资料', backend: backend, storageOrigin: 'server-history', readOnly: true };
  }

  function install(api, dependencies) {
    var remote = {}, scopeEpoch = 0;
    global.addEventListener?.('soduwork-data-scope-changed', function () { scopeEpoch += 1; });
    Object.keys(api).forEach(function (name) { if (typeof api[name] === 'function') remote[name] = api[name].bind(api); });
    function scope() { return { key: dependencies.scope(), epoch: scopeEpoch }; }
    function assertScope(value) {
      dependencies.assertScope(value.key);
      if (value.epoch !== scopeEpoch) throw failure('STALE_TASK_SCOPE', '当前账号或设备已切换，请重新打开后再操作');
    }
    async function localContext(requestScope) {
      assertScope(requestScope);
      var bridge = global.soduWorkAPI?.localLibrary;
      if (!bridge || typeof bridge.context !== 'function' || typeof bridge.call !== 'function') {
        throw failure('LOCAL_LIBRARY_UNAVAILABLE', '当前客户端不支持本机资料库，请更新客户端后重试');
      }
      var root = await currentWorkRoot();
      var context = await bridge.context({ workRoot: root });
      assertScope(requestScope);
      if (!context?.owner || context.ok === false) throw failure(context?.code || 'LOCAL_LIBRARY_UNAVAILABLE', context?.message || context?.reason || '请先登录后使用本机资料库');
      return { owner: context.owner, workRoot: context.workRoot || root, bridge: bridge };
    }
    async function invoke(action, payload, requestScope, capturedContext) {
      if (requestScope == null) requestScope = scope();
      var context = capturedContext || await localContext(requestScope);
      assertScope(requestScope);
      var result;
      try {
        result = await context.bridge.call(action, Object.assign({}, payload, { owner: context.owner, workRoot: context.workRoot || '' }));
      } catch (error) {
        throw nativeFailure(error);
      }
      assertScope(requestScope);
      if (action === 'exportFile' && result?.cancelled === true) return result;
      if (result?.ok === false) throw failure(result.code || 'LOCAL_LIBRARY_ERROR', result.message || result.reason || '本机资料库操作失败');
      if (['deleteItem', 'deleteItems', 'restoreItem', 'purgeItem', 'emptyTrash'].includes(action)) {
        global.dispatchEvent?.(new CustomEvent('soduwork-library-changed'));
      }
      return result;
    }
    async function localBinary(id, requestScope, capturedContext) {
      var got = await invoke('readBinary', { id: id }, requestScope, capturedContext);
      assertScope(requestScope);
      if (typeof got?.data !== 'string' || got.data.length > Math.ceil(BINARY_LIMIT / 3) * 4 ||
          got.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(got.data)) {
        throw failure('LOCAL_LIBRARY_BINARY_INVALID', '本机文件内容无效或超过 64MB，请下载原件后使用');
      }
      var raw = atob(got.data), bytes = new Uint8Array(raw.length);
      if (bytes.length > BINARY_LIMIT || (got.size != null && Number(got.size) !== bytes.length)) {
        throw failure('LOCAL_LIBRARY_BINARY_INVALID', '本机文件读取不完整或超过 64MB，请下载原件后使用');
      }
      for (var i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      var blob = new Blob([bytes], { type: got.mimeType || 'application/octet-stream' });
      var source = got.source || (got.item?.sourceType ? { type: got.item.sourceType,
        sessionId: got.item.sessionId || got.item.sourceSessionId || '',
        conversationTitle: got.item.conversationTitle || got.item.sourceConversationTitle || '' } : null);
      return { ok: true, blob: blob, name: got.name || '资料', type: blob.type, size: blob.size, source: source,
        remoteCopy: got.item?.extra?.lastRemoteCopy };
    }

    function deliveryKey(manifest) {
      if (manifest?.source !== 'local' || !manifest.sessionId || !manifest.revision || !manifest.files?.length) {
        throw failure('LIBRARY_DELIVERY_INVALID', '成果清单不完整，请重新打开会话后重试');
      }
      return JSON.stringify(['delivery', manifest.sessionId, manifest.revision]);
    }
    function deliveryReceipt(item, manifest) {
      return Object.assign({}, manifest, item, { storage: 'local', source: 'local', revision: manifest.revision,
        sessionId: manifest.sessionId, files: manifest.files });
    }
    // Generated files use the same PC library as ordinary uploads. Publishing a
    // cross-device delivery on Hub does not save it into the local library.
    api.saveLibraryDelivery = async function (payload) {
      var requestScope = scope(), manifest = payload?.manifest, outputKey = deliveryKey(manifest);
      var context = await localContext(requestScope);
      if (!payload.filename || typeof payload.data !== 'string') throw failure('LIBRARY_DELIVERY_INVALID', '成果文件尚未准备好');
      var result = await invoke('upload', { dataBase64: payload.data, name: payload.filename,
        contentType: payload.contentType || 'application/octet-stream', storage: 'local',
        source: { type: 'conversation', sessionId: manifest.sessionId,
          conversationTitle: manifest.conversationTitle || manifest.title || '', outputKey: outputKey }
      }, requestScope, context);
      if (result?.ok !== true || !result.item?.id) throw failure('LIBRARY_SAVE_FAILED', '保存到资料库失败，请重试');
      return Object.assign({}, result, { delivery: deliveryReceipt(result.item, manifest) });
    };
    api.getLibraryDeliveryStatus = async function (manifest) {
      var result = await invoke('outputStatus', { outputKey: deliveryKey(manifest) });
      return { ok: true, delivery: result?.item?.id ? deliveryReceipt(result.item, manifest) : null };
    };
    function taskDeliveryManifest(receipt) {
      if (receipt?.state !== 'synced' || !receipt.delivery?.id) return null;
      // Hub packages support preview/download. Only a PC library receipt proves
      // that the user saved this exact version into the computer library.
      return Object.assign({}, receipt.delivery, { source: 'local' });
    }
    function assertDeliverySelection(receipt, selection) {
      if (!selection) return;
      if (selection.deliveryId && selection.revision) {
        if (receipt.delivery?.id === selection.deliveryId && receipt.delivery?.revision === selection.revision) return;
      } else if (Number.isSafeInteger(selection.round) && selection.round > 0 && selection.executionRef &&
          receipt.round === selection.round && receipt.executionRef === selection.executionRef) return;
      throw failure('LIBRARY_DELIVERY_CHANGED', '成果已变化，请重新打开后保存');
    }
    async function selectedTaskDelivery(taskId, selection) {
      if (selection?.deliveryId && selection.revision) {
        const result = await remote.getDelivery(selection.deliveryId);
        return { state: 'synced', delivery: result.delivery };
      }
      return remote.getTaskDelivery(taskId);
    }
    api.getTaskLibraryDeliveryStatus = async function (taskId, selection) {
      var requestScope = scope();
      var receipt = await selectedTaskDelivery(taskId, selection);
      assertScope(requestScope);
      assertDeliverySelection(receipt, selection);
      var manifest = taskDeliveryManifest(receipt);
      if (!manifest) return { ok: true, delivery: null };
      var saved = await api.getLibraryDeliveryStatus(manifest);
      assertScope(requestScope);
      return Object.assign({}, saved, { manifest: manifest });
    };
    api.saveTaskLibraryDelivery = async function (taskId, selection) {
      var requestScope = scope();
      var receipt = await selectedTaskDelivery(taskId, selection);
      assertScope(requestScope);
      assertDeliverySelection(receipt, selection);
      if (!receipt.delivery && receipt.retryable) receipt = await remote.syncTaskDelivery(taskId);
      assertScope(requestScope);
      assertDeliverySelection(receipt, selection);
      var manifest = taskDeliveryManifest(receipt);
      if (!manifest) throw failure('LIBRARY_DELIVERY_PENDING', receipt.error || '成果正在收集，请稍后重试');
      var saved = await api.getLibraryDeliveryStatus(manifest);
      assertScope(requestScope);
      if (saved.delivery) return Object.assign({}, saved, { manifest: manifest });
      var got = await remote.readLibraryBinary(receipt.delivery.id);
      assertScope(requestScope);
      if (got.blob?.size !== manifest.size) throw failure('LIBRARY_DELIVERY_INVALID', '成果读取不完整，请重试');
      var data = await dependencies.blobToBase64(got.blob);
      assertScope(requestScope);
      // A verified historical receipt stays valid when a later turn completes.
      // Recheck its immutable identity and authorization, never replace it with the latest package.
      var latest = selection ? { state: 'synced', delivery: (await remote.getDelivery(manifest.id)).delivery }
        : await remote.getTaskDelivery(taskId);
      assertScope(requestScope);
      if (latest.state !== 'synced' || latest.delivery?.id !== manifest.id || latest.delivery?.revision !== manifest.revision)
        throw failure('LIBRARY_DELIVERY_CHANGED', '成果已变化，请重新打开后保存');
      var result = await api.saveLibraryDelivery({ manifest: manifest, filename: manifest.filename,
        contentType: got.blob.type, data: data });
      return Object.assign({}, result, { manifest: manifest });
    };
    api.getLibraryOutputStatus = function (outputKey, file) {
      return invoke('outputStatus', { outputKey: outputKey, name: file?.name || file?.filename, size: file?.size, sha256: file?.sha256 });
    };
    api.listLibrary = async function (filters) {
      var f = Object.assign({}, filters), storage = f.storage || 'local', folderId = f.folderId || '';
      if (isHistory(folderId)) {
        requireRemote(storage);
        var old = await remote.listLibrary(Object.assign({}, f, { storage: 'local', folderId: f.scope === 'trash' || folderId === HISTORY_ROOT ? '' : folderId.slice(HISTORY.length) }));
        return Object.assign({}, old, { storage: storage, storageOrigin: 'server-history',
          folder: folderId === HISTORY_ROOT ? historyRoot(storage) : old.folder ? historyFolder(old.folder, storage) : null,
          folders: (old.folders || []).map(function (row) { return historyFolder(row, storage); }),
          items: (old.items || []).map(function (row) { return Object.assign({}, row, { storageOrigin: 'server-history' }); }) });
      }
      if (isLocal(folderId) || isLocalStorage(storage)) return invoke('list', Object.assign({}, f, { storage: 'local' }));
      requireRemote(storage);
      var result = await remote.listLibrary(Object.assign({}, f, { storage: storage }));
      if (!folderId && !f.query && (!f.scope || ['all', 'recommended', 'folders'].includes(f.scope))) {
        result = Object.assign({}, result, { folders: [historyRoot(storage)].concat(result.folders || []) });
      }
      return result;
    };
    api.getLibraryStorageStatus = async function () {
      var requestScope = scope();
      var results = await Promise.allSettled([invoke('status', {}, requestScope), remote.getLibraryStorageStatus()]);
      assertScope(requestScope);
      results.forEach(function (entry) { if (entry.status === 'rejected' && entry.reason?.code === 'STALE_TASK_SCOPE') throw entry.reason; });
      var localResult = results[0].status === 'fulfilled' ? results[0].value : null;
      var local = localResult ? (localResult.storage?.local || localResult.local || localResult) : unavailable(results[0].reason, 'local');
      local = Object.assign({}, local, { backend: 'local' });
      var hub = results[1].status === 'fulfilled' ? results[1].value : {};
      var storage = Object.assign({}, hub.storage || {});
      storage.local = local;
      ['nfs', 'minio'].forEach(function (backend) { storage[backend] = storage[backend] || hub[backend] || unavailable(results[1].reason, backend); });
      var legacyBackend = ['nfs', 'minio'].includes(hub.remoteBackend) ? hub.remoteBackend
        : storage.minio.configured || storage.minio.available ? 'minio' : '';
      storage.remote = storage.remote || hub.remote || (legacyBackend
        ? Object.assign({}, storage[legacyBackend], { backend: legacyBackend }) : unavailable(results[1].reason));
      return Object.assign({}, hub, storage, { ok: true, default: 'local', storage: storage, remoteBackend: hub.remoteBackend || storage.remote.backend || '' });
    };
    api.createLibraryFolder = async function (name, parentId, storage) {
      storage = storage || 'local'; checkFolder(parentId, storage);
      return isLocalStorage(storage) ? invoke('createFolder', { name: name || '', parentId: parentId || '', storage: 'local' })
        : remote.createLibraryFolder(name, parentId, requireRemote(storage));
    };
    api.updateLibraryFolder = async function (id, body) {
      rejectHistory(id); body = body || {};
      if (isLocal(id)) {
        if (body.storage && body.storage !== 'local') throw failure('LOCAL_LIBRARY_COPY_REQUIRED', '本机资料不能直接移动到远程，请保存远程副本');
        checkFolder(body.parentId, 'local'); return invoke('updateFolder', { id: id, body: body });
      }
      rejectHistory(body.parentId);
      if (isLocal(body.parentId)) throw failure('LIBRARY_FOLDER_BACKEND_MISMATCH', '资料和目标文件夹必须位于同一存储');
      return remote.updateLibraryFolder(id, body);
    };
    api.deleteLibraryFolder = async function (id) {
      rejectHistory(id); return isLocal(id) ? invoke('deleteFolder', { id: id }) : remote.deleteLibraryFolder(id);
    };
    api.createLibraryItem = async function (body) {
      body = Object.assign({}, body); var storage = body.storage || 'local'; checkFolder(body.folderId, storage);
      if (isLocalStorage(storage)) return invoke('createItem', Object.assign(body, { storage: 'local' }));
      return remote.createLibraryItem(Object.assign(body, { storage: requireRemote(storage) }));
    };
    api.uploadLibraryFile = async function (file, folderId, storage, source) {
      var requestScope = scope(); storage = storage || 'local'; checkFolder(folderId, storage);
      if (!isLocalStorage(storage)) return remote.uploadLibraryFile(file, folderId, requireRemote(storage), source);
      if (!file) throw new Error('请选择文件');
      if (Number(file.size) > BINARY_LIMIT) throw failure('LOCAL_LIBRARY_FILE_TOO_LARGE', '文件超过 64MB，暂时无法保存到本机资料库');
      var context = await localContext(requestScope);
      var encoded = await dependencies.blobToBase64(file);
      assertScope(requestScope);
      return invoke('upload', { dataBase64: encoded, name: file.name || '资料', contentType: file.type || 'application/octet-stream',
        folderId: folderId || '', source: source || {}, storage: 'local' }, requestScope, context);
    };
    api.readLibraryThumbnail = async function (id, options) {
      if (!isLocal(id)) return remote.readLibraryThumbnail(id, options);
      const requestScope = scope();
      if (options?.signal?.aborted) return null;
      const result = await invoke('thumbnail', { id }, requestScope);
      assertScope(requestScope);
      if (options?.signal?.aborted || !result?.data) return null;
      if (result.data.length > 700000) throw failure('LOCAL_LIBRARY_BINARY_INVALID', '缩略图过大');
      const raw = atob(result.data), bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      return { blob: new Blob([bytes], { type: 'image/png' }) };
    };
    api.readLibraryBinary = async function (id) { return isLocal(id) ? localBinary(id, scope()) : remote.readLibraryBinary(id); };
    api.readLibraryContent = async function (id, options) {
      return isLocal(id) ? invoke('readContent', { id: id, preview: options?.preview === true }) : remote.readLibraryContent(id, options);
    };
    api.updateLibraryItem = async function (id, body) {
      body = Object.assign({}, body);
      if (isLocal(id)) {
        if (body.storage && body.storage !== 'local') throw failure('LOCAL_LIBRARY_COPY_REQUIRED', '本机资料不能直接移动到远程，请保存远程副本');
        checkFolder(body.folderId, 'local'); return invoke('updateItem', { id: id, body: body });
      }
      if (isLocal(body.folderId)) throw failure('LIBRARY_FOLDER_BACKEND_MISMATCH', '资料和目标文件夹必须位于同一存储');
      if (isHistory(body.folderId)) {
        body.folderId = body.folderId === HISTORY_ROOT ? '' : body.folderId.slice(HISTORY.length); body.storage = 'local';
      }
      return remote.updateLibraryItem(id, body);
    };
    ['delete', 'restore', 'purge'].forEach(function (action) {
      var method = action + 'LibraryItem';
      api[method] = async function (id) { return isLocal(id) ? invoke(action + 'Item', { id: id }) : remote[method](id); };
    });
    api.deleteLibraryItems = async function (ids) {
      var values = [...new Set((Array.isArray(ids) ? ids : []).map(function (id) { return String(id || '').trim(); }).filter(Boolean))];
      var localIds = values.filter(isLocal), remoteIds = values.filter(function (id) { return !isLocal(id); });
      var results = { ok: true, succeeded: [], failed: [] };
      if (localIds.length) {
        var localResult = await invoke('deleteItems', { ids: localIds });
        results.succeeded.push(...(localResult.succeeded || []));
        results.failed.push(...(localResult.failed || []));
      }
      if (remoteIds.length) {
        var remoteResult = await remote.deleteLibraryItems(remoteIds);
        results.succeeded.push(...(remoteResult.succeeded || []));
        results.failed.push(...(remoteResult.failed || []));
      }
      return results;
    };
    api.emptyLibraryTrash = async function (storage, options) {
      if (options?.storageOrigin === 'server-history') { requireRemote(storage); return remote.emptyLibraryTrash('local'); }
      return isLocalStorage(storage) ? invoke('emptyTrash', {}) : remote.emptyLibraryTrash(requireRemote(storage));
    };
    api.associateLibrarySource = async function (id, source) {
      return isLocal(id) ? invoke('associateSource', { id: id, source: source || {} }) : remote.associateLibrarySource(id, source);
    };
    api.shareLibraryItem = async function (id, recipients, note, options) {
      if (!isLocal(id)) return remote.shareLibraryItem(id, recipients, note);
      var requestScope = scope(), context = await localContext(requestScope);
      var got = await localBinary(id, requestScope, context);
      if (!got.size || got.size > 24 * 1024 * 1024) throw failure('LIBRARY_SHARE_SIZE', '请选择非空且不超过 24 MB 的文件');
      var data = await dependencies.blobToBase64(got.blob);
      assertScope(requestScope);
      var current = await localContext(requestScope);
      if (current.owner !== context.owner) throw failure('STALE_TASK_SCOPE', '当前账号已变化，请重新打开资料库');
      assertScope(requestScope);
      var result = await remote.shareLocalLibraryFile({ requestId: options?.requestId || requestId(),
        localItemId: id, filename: got.name, contentType: got.type, data: data,
        recipientUserIds: recipients || [], note: String(note || '') });
      assertScope(requestScope);
      return result;
    };
    async function collectLocalFolderFiles(folderIds, requestScope, capturedContext) {
      var queue = (Array.isArray(folderIds) ? folderIds : []).map(function (id) { return { id: String(id || '').trim(), path: [] }; }).filter(function (entry) { return entry.id; });
      var seenFolders = new Set(), seenItems = new Set(), files = [];
      while (queue.length) {
        assertScope(requestScope);
        var current = queue.shift();
        if (seenFolders.has(current.id)) continue;
        seenFolders.add(current.id);
        var listing = await api.listLibrary({ scope: 'all', storage: 'local', folderId: current.id });
        assertScope(requestScope);
        (Array.isArray(listing?.folders) ? listing.folders : []).forEach(function (folder) {
          var childId = String(folder?.id || '').trim();
          if (childId && !seenFolders.has(childId)) queue.push({ id: childId, path: current.path.concat(String(folder.name || '')) });
        });
        for (var i = 0; i < (Array.isArray(listing?.items) ? listing.items : []).length; i += 1) {
          var item = listing.items[i], itemId = String(item?.id || '').trim();
          if (!itemId || seenItems.has(itemId)) continue;
          seenItems.add(itemId);
          if (files.length >= 20) throw failure('LIBRARY_SHARE_LIMIT', '一次最多分享 20 个资料');
          var got = await localBinary(itemId, requestScope, capturedContext);
          if (!got.size || got.size > 24 * 1024 * 1024) throw failure('LIBRARY_SHARE_SIZE', '请选择非空且不超过 24 MB 的文件');
          var data = await dependencies.blobToBase64(got.blob);
          assertScope(requestScope);
          files.push({ localItemId: itemId, filename: current.path.concat(got.name).filter(Boolean).join('/'), contentType: got.type, data: data });
        }
      }
      if (!files.length) throw failure('LIBRARY_FOLDER_EMPTY', '文件夹内没有可分享的资料');
      return files;
    }
    api.shareLibraryItems = async function (ids, recipients, note, options) {
      var values = [...new Set((Array.isArray(ids) ? ids : []).map(function (id) { return String(id || '').trim(); }).filter(Boolean))];
      var folderIds = [...new Set((Array.isArray(options?.folderIds) ? options.folderIds : []).map(function (id) { return String(id || '').trim(); }).filter(Boolean))];
      var localFolderIds = folderIds.filter(isLocal), remoteFolderIds = folderIds.filter(function (id) { return !isLocal(id); });
      var localIds = values.filter(isLocal), remoteIds = values.filter(function (id) { return !isLocal(id); });
      if (!values.length && !folderIds.length) return { ok: true, succeeded: [], failed: [] };
      var requestScope = scope(), context, localFiles = [], requestIdValue = options?.requestId || requestId();
      if (localIds.length) {
        context = await localContext(requestScope);
        for (var i = 0; i < localIds.length; i += 1) {
          var got = await localBinary(localIds[i], requestScope, context);
          if (!got.size || got.size > 24 * 1024 * 1024) throw failure('LIBRARY_SHARE_SIZE', '请选择非空且不超过 24 MB 的文件');
          var data = await dependencies.blobToBase64(got.blob);
          assertScope(requestScope);
          localFiles.push({ localItemId: localIds[i], filename: got.name, contentType: got.type, data: data });
        }
        assertScope(requestScope);
      }
      if (localFolderIds.length) {
        context ||= await localContext(requestScope);
        localFiles.push(...await collectLocalFolderFiles(localFolderIds, requestScope, context));
        assertScope(requestScope);
      }
      var hasFolder = folderIds.length > 0;
      if (remoteIds.length || remoteFolderIds.length || hasFolder) return remote.shareLibraryItems(remoteIds, recipients, note, {
        requestId: requestIdValue, folderIds: remoteFolderIds.length ? remoteFolderIds : undefined,
        forcePackage: hasFolder, localFiles: localFiles.length ? localFiles : undefined,
      });
      if (localFiles.length === 1) return remote.shareLocalLibraryFile(Object.assign({}, localFiles[0], {
        requestId: requestIdValue, recipientUserIds: recipients || [], note: String(note || ''),
      }));
      return remote.shareLocalLibraryFiles(localFiles, recipients, note, { requestId: requestIdValue });
    };
    api.saveMateMessageFileToLibrary = async function (id) {
      var requestScope = scope(), context = await localContext(requestScope);
      var row = await remote.mateMessageFile(id);
      assertScope(requestScope);
      if (typeof global.soduWorkAPI?.readAttachmentBinary !== 'function') throw failure('LOCAL_LIBRARY_UNAVAILABLE', '请更新客户端后保存附件');
      var got = await global.soduWorkAPI.readAttachmentBinary({ url: api.attachmentUrl(row), filename: row.filename });
      assertScope(requestScope);
      if (!got || got.ok === false) throw failure('LOCAL_LIBRARY_BINARY_INVALID', got?.reason || '读取附件失败');
      var cap = 24 * 1024 * 1024;
      if (typeof got.data !== 'string' || got.data.length > Math.ceil(cap / 3) * 4 ||
          got.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(got.data)) {
        throw failure('LOCAL_LIBRARY_BINARY_INVALID', '附件内容无效，请重新下载后保存');
      }
      var size = atob(got.data).length;
      if (size > cap || (row.size != null && Number(row.size) !== size) || (got.size != null && Number(got.size) !== size)) {
        throw failure('LOCAL_LIBRARY_BINARY_INVALID', '附件读取不完整，请重试');
      }
      var current = await localContext(requestScope);
      if (current.owner !== context.owner) throw failure('STALE_TASK_SCOPE', '当前账号已变化，请重新打开通知');
      // Use the authorized snapshot name and the normal native upload path,
      // which rejects duplicate names without replacing the existing file.
      return invoke('upload', { dataBase64: got.data, name: row.filename || '附件',
        contentType: row.contentType || row.content_type || got.mimeType || 'application/octet-stream',
        folderId: '', source: {}, rejectDuplicateName: true, storage: 'local' }, requestScope, context);
    };
    api.getLibraryArchive = async function (id) { if (isLocal(id)) noArchive(); return remote.getLibraryArchive(id); };
    api.readLibraryArchiveFile = async function (id, path, options) { if (isLocal(id)) noArchive(); return remote.readLibraryArchiveFile(id, path, options); };
    ['openLibraryExternally', 'revealLibraryItem'].forEach(function (method) {
      api[method] = async function (id, member) {
        if (!isLocal(id)) return remote[method](id, member);
        if (member?.path) noArchive();
        return invoke(method === 'openLibraryExternally' ? 'openExternal' : 'reveal', { id: id });
      };
    });
    api.downloadLibraryItem = async function (id, filename, member) {
      if (!isLocal(id)) return remote.downloadLibraryItem(id, filename, member);
      if (member?.path) noArchive();
      return invoke('exportFile', { id: id, filename: filename || '' });
    };
    api.copyLocalLibraryItemToRemote = async function (id, target) {
      var requestScope = scope(), destination = typeof target === 'string' ? { storage: target } : target || {};
      var storage = requireRemote(destination.storage), folderId = destination.folderId || '';
      if (!isLocal(id)) throw failure('LOCAL_LIBRARY_ITEM_REQUIRED', '请选择本机资料');
      checkFolder(folderId, storage);
      var context = await localContext(requestScope);
      var got = await localBinary(id, requestScope, context);
      var prior = got.remoteCopy;
      if (destination.reuseExisting === true && prior?.id && prior.storage === storage && (prior.folderId || '') === folderId) {
        var saved;
        try { saved = await remote.readLibraryBinary(prior.id); }
        catch (error) { assertScope(requestScope); if (error?.status !== 404) throw error; }
        assertScope(requestScope);
        if (saved?.blob && saved.name === got.name && saved.size === got.size) {
          var buffers = await Promise.all([got.blob.arrayBuffer(), saved.blob.arrayBuffer()]);
          assertScope(requestScope);
          var original = new Uint8Array(buffers[0]), existing = new Uint8Array(buffers[1]);
          if (original.every(function (value, offset) { return value === existing[offset]; })) {
            var verifiedContext = await localContext(requestScope);
            if (verifiedContext.owner !== context.owner) throw failure('STALE_TASK_SCOPE', '当前账号已变化，请重新打开资料库');
            return { ok: true, item: { id: prior.id }, reused: true, localItemId: id };
          }
        }
      }
      var current = await localContext(requestScope);
      if (current.owner !== context.owner) throw failure('STALE_TASK_SCOPE', '当前账号已变化，请重新打开资料库');
      assertScope(requestScope);
      var file = new File([got.blob], got.name, { type: got.type });
      // No await between the scope check and dispatch: the old account's bytes
      // must never start a request carrying a newly selected account's session.
      var result = got.size === 0 ? await remote.createLibraryItem({ kind: 'file', title: got.name, filename: got.name,
        content: '', contentType: got.type, folderId: folderId, storage: storage, rejectDuplicateName: true,
        sourceType: got.source?.type, sessionId: got.source?.sessionId, conversationTitle: got.source?.conversationTitle,
      }) : await remote.uploadLibraryFile(file, folderId, storage, Object.assign({}, got.source, { rejectDuplicateName: true }));
      assertScope(requestScope);
      if (!result || result.ok === false || !result.item?.id) throw failure('LIBRARY_REMOTE_COPY_FAILED', '远程副本未保存成功，本机原件已保留');
      var recorded = true;
      try {
        await invoke('updateItem', { id: id, body: { extra: { lastRemoteCopy: {
          id: result.item.id, storage: storage, folderId: folderId, copiedAt: new Date().toISOString(),
        } } } }, requestScope, context);
      } catch (error) {
        assertScope(requestScope);
        if (error?.code === 'STALE_TASK_SCOPE') throw error;
        // The copy exists even if recording its ID on the source fails. Returning
        // a failure here would encourage a duplicate upload on the next retry.
        recorded = false;
      }
      return Object.assign({}, result, { copied: true, localItemId: id, copyRecordSaved: recorded });
    };
    api.copyLocalLibraryItemsToRemote = async function (ids, target) {
      var destination = typeof target === 'string' ? { storage: target } : target || {};
      var values = [...new Set((Array.isArray(ids) ? ids : []).map(function (id) { return String(id || '').trim(); }).filter(Boolean))];
      if (values.length > 100) throw failure('LIBRARY_BATCH_LIMIT', '一次最多批量处理 100 项资料，请减少选择后重试');
      var results = { ok: true, succeeded: [], failed: [] };
      if (!values.length) return results;
      var storage = requireRemote(destination.storage);
      var requestScope = scope();
      var status = await api.getLibraryStorageStatus();
      assertScope(requestScope);
      var isCurrent = typeof destination.isCurrent === 'function' ? destination.isCurrent : null;
      if (isCurrent && !isCurrent()) throw failure('STALE_TASK_SCOPE', '远程存储状态已变化，请重新选择后重试');
      var reported = status && (status.storage?.remote || status.remote) || {};
      var remoteReady = reported.available === true && String(reported.backend || '') === storage;
      var unavailableCode = reported.code || 'LIBRARY_REMOTE_UNAVAILABLE';
      var unavailableMessage = reported.message || '远程存储状态已变化，请重新选择后重试';
      for (var i = 0; i < values.length; i += 1) {
        assertScope(requestScope);
        if (isCurrent && !isCurrent()) throw failure('STALE_TASK_SCOPE', '远程存储状态已变化，请重新选择后重试');
        var id = values[i];
        if (!isLocal(id)) {
          results.failed.push({ id: id, code: 'LOCAL_LIBRARY_ITEM_REQUIRED', message: '请选择本机资料' });
          continue;
        }
        if (!remoteReady) {
          results.failed.push({ id: id, code: unavailableCode, message: unavailableMessage });
          continue;
        }
        try {
          var copied = await api.copyLocalLibraryItemToRemote(id, Object.assign({}, destination, { storage: storage, reuseExisting: true }));
          results.succeeded.push({ id: id, result: copied });
        } catch (error) {
          if (error?.code === 'STALE_TASK_SCOPE') throw error;
          results.failed.push({ id: id, code: error?.code || 'LIBRARY_REMOTE_COPY_FAILED', message: error?.message || String(error) });
        }
      }
      return results;
    };
  }
  global.SoduWorkLocalLibraryAPI = { install: install };
})(typeof window !== 'undefined' ? window : this);
