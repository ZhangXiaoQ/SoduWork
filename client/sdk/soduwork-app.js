/* SoduWork H5 SDK v1.7.0. Works in native app pages and authorized iframes.
 * Parent: configure({allowedFrameOrigins:['https://business.example']}).
 * Child: configure({parentOrigin:'https://shell.example'}).
 * await soduWorkApp.chat.send({text:'...', requestId:crypto.randomUUID()}); */
(function (global) {
  'use strict';
  if (global.soduWorkApp) return;
  const channel = 'soduwork.app/v1', native = global.soduWorkAppBridge;
  const methods = new Set(['files.pickLocal','files.copyLocal','files.begin','files.append','files.finish','files.cancel','files.getUrl','ai.generate', 'context.get', 'user.getCurrent', 'notifications.list', 'library.list', 'library.read', 'conversations.list', 'conversations.messages', 'directory.list', 'composer.mention', 'composer.send', 'composer.insertText', 'composer.expand', 'composer.collapse', 'settings.get', 'settings.update', 'automation.create', 'data.apps', 'data.get', 'data.list', 'data.batch', 'data.assetPut', 'data.assetGet', 'mcp.connect',
    'attachments.pick','attachments.begin','attachments.append','attachments.finish','attachments.release','attachments.check']);
  const origins = new Set([location.origin]), pending = new Map();
  const listeners = new Set(), dataListeners = new Set();
  let parentOrigin = '', inFlight = 0;
  try { if (global.parent !== global && document.referrer) parentOrigin = new URL(document.referrer).origin; } catch (_) {}
  const origin = value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) throw Error('需要精确的 HTTP(S) 来源，不支持通配符');
    return value;
  };
  function configure(options) {
    if (options?.parentOrigin) parentOrigin = origin(options.parentOrigin);
    if (options?.allowedFrameOrigins) {
      if (global.parent !== global || !native) throw Error('只有原生应用顶层可以授权 iframe');
      const next = options.allowedFrameOrigins.map(origin);
      origins.clear(); origins.add(location.origin); next.forEach(value => origins.add(value));
    }
  }
  const id = () => typeof global.crypto.randomUUID === 'function' ? global.crypto.randomUUID()
    : [...global.crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
  function invoke(method, params) {
    if (!methods.has(method)) return Promise.reject(Error('H5 桥未开放此方法'));
    if (native?.request) return native.request(method, params || {});
    if (global.parent === global || !parentOrigin) return Promise.reject(Error('未连接 SoduWork 即用壳，请配置 parentOrigin'));
    if (pending.size >= 16) return Promise.reject(Error('桥接请求过多'));
    return new Promise((resolve, reject) => {
      const key = id(), timer = setTimeout(() => { pending.delete(key); reject(Error('即用壳响应超时；请先核对创建/发送结果，勿重复提交')); }, method === 'automation.create' ? 185000 : 65000);
      pending.set(key, { resolve, reject, timer });
      global.parent.postMessage({ channel, type: 'request', id: key, method, params: params || {} }, parentOrigin);
    });
  }
  global.addEventListener('message', async event => {
    const data = event.data;
    if (!data || data.channel !== channel || typeof data.id !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(data.id)) return;
    if (event.source === global.parent && event.source !== global && event.origin === parentOrigin) {
      if(data.type==='data-changed'){if(['identity','notifications','conversations','library','content'].includes(data.topic))dataListeners.forEach(fn=>{try{fn({topic:data.topic,...(data.topic==='content'?{spaceId:data.spaceId,topicId:data.topicId}:{})});}catch(_){}});return;}
      if (data.type === 'settled') { listeners.forEach(callback => { try { callback({ state: 'settled' }); } catch (_) {} }); return; }
      if (data.type !== 'response') return;
      const row = pending.get(data.id); if (!row) return;
      pending.delete(data.id); clearTimeout(row.timer); row.resolve(data.result); return;
    }
    if (!native || data.type !== 'request' || !origins.has(event.origin)) return;
    const frame = [...document.querySelectorAll('iframe')].find(item => item.contentWindow === event.source);
    if (!frame || !methods.has(data.method) || inFlight >= 16) return;
    // Only declared methods and exact child origins. Attachment requests expose
    // opaque IDs and bounded binary chunks, never filesystem paths or raw IPC.
    let currentOrigin;
    try { currentOrigin = new URL(frame.src, location.href).origin; } catch (_) { return; }
    if (currentOrigin !== event.origin) return;
    inFlight++;
    try {
      const result = await native.request(data.method, data.params || {});
      event.source.postMessage({ channel, type: 'response', id: data.id, result }, event.origin);
    } catch (error) {
      event.source.postMessage({ channel, type: 'response', id: data.id, result: { ok: false, reason: String(error.message || error) } }, event.origin);
    } finally { inFlight--; }
  });
  function settled() {
    listeners.forEach(callback => { try { callback({ state: 'settled' }); } catch (_) {} });
    if (!native) return;
    document.querySelectorAll('iframe').forEach(frame => {
      try {
        const value = new URL(frame.src, location.href).origin;
        if (origins.has(value)) frame.contentWindow.postMessage({ channel, type: 'settled', id: 'turn' }, value);
      } catch (_) {}
    });
  }
  native?.events?.onDataChanged?.(value=>{
    if(!['identity','notifications','conversations','library','content'].includes(value?.topic))return;
    dataListeners.forEach(fn=>{try{fn({topic:value.topic,...(value.topic==='content'?{spaceId:value.spaceId,topicId:value.topicId}:{})});}catch(_){}});
    document.querySelectorAll('iframe').forEach(frame=>{try{const source=new URL(frame.src,location.href).origin;if(origins.has(source))frame.contentWindow.postMessage({channel,type:'data-changed',id:'data',topic:value.topic,...(value.topic==='content'?{spaceId:value.spaceId,topicId:value.topicId}:{})},source);}catch(_){}});
  });
  native?.events?.onTurnSettled(settled);
  async function importFile(file, options = {}) {
    if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 256 * 1024 * 1024 || typeof file.slice !== 'function') throw Error('文件无效或超过256 MB');
    const started = await invoke('attachments.begin', {name:file.name || 'clipboard.png', type:file.type || '', size:file.size});
    if (!started?.ok) throw Error(started?.reason || '无法暂存附件，请更新 SoduWork');
    try {
      const bytes = Math.min(started.chunkBytes || 1048576, 1048576);
      for (let offset = 0; offset < file.size; offset += bytes) {
        if (options.signal?.aborted) throw Error('已取消附件传输');
        const data = new Uint8Array(await file.slice(offset, offset + bytes).arrayBuffer());
        const result = await invoke('attachments.append', {id:started.id, offset, data});
        if (!result?.ok) throw Error(result?.reason || '附件传输失败');
        options.onProgress?.(Math.min(offset + data.length, file.size), file.size);
      }
      if (options.signal?.aborted) throw Error('已取消附件传输');
      const result = await invoke('attachments.finish', {id:started.id});
      if (!result?.ok) throw Error(result?.reason || '附件暂存失败');
      return result.item;
    } catch (error) { await invoke('attachments.release', {ids:[started.id]}).catch(() => {}); throw error; }
  }
  async function saveLocalFile(file, options = {}) {
    if(!file || typeof file.slice!=='function')throw Error('请选择有效文件');
    const begin=await invoke('files.begin',{projectId:options.projectId,name:file.name||options.name||'image',type:file.type||'application/octet-stream',size:file.size});
    if(!begin?.ok)throw Object.assign(Error(begin?.reason||'文件保存未开始'),{code:begin?.code});
    if(!/^upload_[a-f0-9]{32}$/.test(begin.id||'') || !Number.isSafeInteger(begin.chunkBytes) || begin.chunkBytes<1 || begin.chunkBytes>512*1024)throw Error('文件上传回执无效');
    try {
      for(let offset=0;offset<file.size;offset+=begin.chunkBytes){
        if(options.signal?.aborted)throw Error('文件保存已取消');
        const data=new Uint8Array(await file.slice(offset,offset+begin.chunkBytes).arrayBuffer());
        const receipt=await invoke('files.append',{id:begin.id,offset,data});
        if(!receipt?.ok || receipt.offset!==offset+data.length)throw Error(receipt?.reason||'文件分块未确认');
        options.onProgress?.({loaded:receipt.offset,total:file.size});
        await new Promise(resolve=>setTimeout(resolve,0));
      }
      const result=await invoke('files.finish',{id:begin.id});
      if(!result?.ok||!result.file?.url)throw Error(result?.reason||'文件保存未完成');
      return result;
    } catch(error){try{await invoke('files.cancel',{id:begin.id});}catch(_){}throw error;}
  }
  global.soduWorkApp = Object.freeze({ version: '1.7.0', configure, request: invoke, createRequestId: id,
    files:Object.freeze({pickLocal:()=>invoke('files.pickLocal',{}),copyLocal:options=>invoke('files.copyLocal',options),importFile:saveLocalFile,getUrl:options=>invoke('files.getUrl',options)}),
    ai: Object.freeze({generate: options => invoke('ai.generate', {...options, requestId: options?.requestId || id()})}),
    data: Object.freeze({ apps: () => invoke('data.apps',{}), get: options => invoke('data.get', options), list: options => invoke('data.list', options), batch: options => invoke('data.batch', options), assetPut: options => invoke('data.assetPut',options), assetGet: options => invoke('data.assetGet',options) }),
    mcp: Object.freeze({connect:options => invoke('mcp.connect',options)}),
    attachments: Object.freeze({ pick: () => invoke('attachments.pick', {}), importFile,
      release: ids => invoke('attachments.release',{ids}), check: ids => invoke('attachments.check',{ids}) }),
    user: Object.freeze({getCurrent:()=>invoke('user.getCurrent',{})}),
    notifications: Object.freeze({list:options=>invoke('notifications.list',options||{})}),
    library: Object.freeze({list:options=>invoke('library.list',options||{}),read:options=>invoke('library.read',options||{})}),
    conversations: Object.freeze({list:options=>invoke('conversations.list',options||{}),messages:options=>invoke('conversations.messages',options||{})}),
    directory: Object.freeze({list:() => invoke('directory.list',{})}),
    context: Object.freeze({ get: () => invoke('context.get', {}) }),
    automation: Object.freeze({ create: options => invoke('automation.create', {text: options?.text || '', requestId: options?.requestId || id(), context: options?.context || {}}) }),
    settings: Object.freeze({ get: options => invoke('settings.get', options || {}), update: options => invoke('settings.update', options || {}) }),
    chat: Object.freeze({ send: options => invoke('composer.send', { text: options?.text || '', requestId: options?.requestId || id(), ...(options?.attachmentIds?.length ? {attachmentIds:options.attachmentIds} : {}) }),
      mention: options => invoke('composer.mention',{recipientUserId:options?.recipientUserId || '',query:options?.query || '',text:options?.text || '',requestId:options?.requestId || id()}),
      insertText: options => invoke('composer.insertText', options || {}),
      expand: () => invoke('composer.expand', {}), collapse: () => invoke('composer.collapse', {}) }),
    events: Object.freeze({ onDataChanged(callback){if(typeof callback!=='function')return ()=>{};dataListeners.add(callback);return ()=>dataListeners.delete(callback);}, onRefresh(callback) { listeners.add(callback); return () => listeners.delete(callback); },
      onTurnSettled(callback) { listeners.add(callback); return () => listeners.delete(callback); } }) });
})(window);
