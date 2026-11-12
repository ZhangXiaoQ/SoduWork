'use strict';

/*
 * Contract-only boundary for applications hosted by SoduWork's WebContentsView.
 * This module deliberately has no Electron imports and performs no side
 * effects. Main-process routing and the renderer host both use these checks so
 * a future bridge cannot accidentally grow an unbounded "call anything" API.
 */

const VERSION = 1;
const MAX_REQUEST_ID = 120;
const MAX_TEXT = 8000;
const MAX_TITLE = 160;
const MAX_RECIPIENT = 120;

const CAPABILITIES = Object.freeze([
  'ai.generate',
  'context.read',
  'directory.read',
  'messages.read',
  'library.read',
  'conversation.open',
  'conversation.send',
  'requirements.propose',
  'notifications.send',
  'composer.control',
  'mcp.connect',
  'settings.read',
  'settings.write',
  'automation.create',
  'data.read',
  'data.write',
]);

const METHOD_CAPABILITY = Object.freeze({
  'ai.generate': 'ai.generate',
  'user.getCurrent':'context.read',
  'notifications.list':'messages.read',
  'conversations.list':'messages.read',
  'conversations.messages':'messages.read',
  'library.list':'library.read',
  'library.read':'library.read',
  'context.get': 'context.read',
  'directory.list': 'directory.read',
  'composer.mention': 'notifications.send',
  'conversation.open': 'conversation.open',
  'conversation.send': 'conversation.send',
  'requirements.propose': 'requirements.propose',
  'notifications.send': 'notifications.send',
  'composer.expand': 'composer.control',
  'composer.collapse': 'composer.control',
  'composer.insertText': 'composer.control',
  'composer.insertAttachment': 'composer.control',
  'composer.theme': 'composer.control',
  'composer.send': 'conversation.send',
  'attachments.pick': 'composer.control',
  'attachments.begin': 'composer.control',
  'attachments.append': 'composer.control',
  'attachments.finish': 'composer.control',
  'attachments.release': 'composer.control',
  'attachments.check': 'composer.control',
  'mcp.connect': 'mcp.connect',
  'settings.get': 'settings.read',
  'settings.update': 'settings.write',
  'automation.create': 'automation.create',
  'data.get': 'data.read',
  'data.apps': 'data.read',
  'data.list': 'data.read',
  'data.batch': 'data.write',
  'data.assetPut': 'data.write',
  'data.assetGet': 'data.read',
  'files.pickLocal':'data.read', 'files.copyLocal':'data.write', 'files.begin':'data.write', 'files.append':'data.write', 'files.finish':'data.write', 'files.cancel':'data.write', 'files.getUrl':'data.read',
});

const METHODS = new Set(Object.keys(METHOD_CAPABILITY));

function text(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function normalizedCapabilities(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map((item) => text(item, 80)))]
    .filter((item) => CAPABILITIES.includes(item));
}

function hasCapability(granted, capability) {
  return normalizedCapabilities(granted).includes(String(capability || ''));
}

function normalizeOrigin(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) return '';
    return parsed.origin;
  } catch (_) { return ''; }
}

function validateOrigin(actual, expected) {
  const got = normalizeOrigin(actual), want = normalizeOrigin(expected);
  return Boolean(got && want && got === want);
}

function normalizeManifestBridge(raw) {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('应用能力声明必须是对象');
  }
  const unknown = Object.keys(raw).filter((key) => key !== 'version' && key !== 'capabilities');
  if (unknown.length) throw new Error('应用能力声明包含不支持的字段：' + unknown.join('、'));
  const version = Number(raw.version == null ? VERSION : raw.version);
  if (version !== VERSION) throw new Error('应用能力声明版本不受支持');
  const capabilities = normalizedCapabilities(raw.capabilities);
  const requested = Array.isArray(raw.capabilities) ? raw.capabilities.map((item) => text(item, 80)) : [];
  if (requested.some((item) => !CAPABILITIES.includes(item))) {
    throw new Error('应用请求了未开放的能力');
  }
  if (capabilities.length > CAPABILITIES.length) throw new Error('应用能力数量超过限制');
  return { version: VERSION, capabilities };
}

function normalizeRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('应用请求格式无效');
  const id = text(raw.id, MAX_REQUEST_ID);
  const method = text(raw.method, 80);
  if (!id || !/^[A-Za-z0-9_.:-]+$/.test(id)) throw new Error('应用请求缺少有效 id');
  if (!METHODS.has(method)) throw new Error('应用请求方法未开放');
  const params = raw.params == null ? {} : raw.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('应用请求参数格式无效');
  const out = { version: VERSION, id, method, params: {} };
  if (method === 'ai.generate') {
    out.params = require('./app-ai-generate.cjs').normalize(params);
    return out;
  }
  if (['user.getCurrent','notifications.list','library.list','library.read','conversations.list','conversations.messages'].includes(method)) {
    const names={ 'user.getCurrent':[], 'notifications.list':['source','folder','before','offset','limit'], 'library.list':['storage','folderId','query','offset','limit'], 'library.read':['id','format','offset','length'], 'conversations.list':['offset','limit','archived'], 'conversations.messages':['id','segmentId','offset','limit','after'] }[method];
    if(Object.keys(params).some(key=>!names.includes(key)))throw Error('宿主只读查询包含不支持的参数');
    for(const key of ['id','segmentId','before','folderId','query'])if(params[key]!=null && (typeof params[key]!=='string'||params[key].length>300||/[\x00-\x1f]/.test(params[key])))throw Error('只读查询标识或文本无效');
    for(const key of ['offset','after'])if(params[key]!=null && (!Number.isSafeInteger(params[key])||params[key]<0||params[key]>10000000))throw Error('分页位置无效');
    for(const [key,max]of [['limit',100],['length',262144]])if(params[key]!=null && (!Number.isSafeInteger(params[key])||params[key]<1||params[key]>max))throw Error('分页大小无效');
    if(['library.read','conversations.messages'].includes(method)&&!params.id)throw Error('缺少记录标识');
    for(const [key,values]of [['source',['server','center']],['storage',['local','nfs','minio']],['format',['text','base64']],['folder',['received','sent']]])if(params[key]!=null&&!values.includes(params[key]))throw Error('查询类型无效');
    if(params.archived!=null&&typeof params.archived!=='boolean')throw Error('归档标记无效');
    out.params={...params};return out;
  }
  if (method === 'directory.list') {
    if (Object.keys(params).length) throw Error('同事目录不接受账号或任意查询参数');
    return out;
  }
  if (method === 'composer.mention') {
    if (Object.keys(params).some(key=>!['recipientUserId','query','text','requestId'].includes(key))) throw Error('同事提及参数无效');
    for(const [key,max] of [['recipientUserId',MAX_RECIPIENT],['query',120],['text',500],['requestId',100]]) {
      if(params[key] != null && (typeof params[key] !== 'string' || params[key].length>max))throw Error('同事提及参数无效：'+key);
    }
    if(!/^[A-Za-z0-9_.:-]{1,100}$/.test(params.requestId || ''))throw Error('同事提及需要有效请求编号');
    out.params={recipientUserId:text(params.recipientUserId,MAX_RECIPIENT),query:text(params.query,120).replace(/^@/,''),text:String(params.text || ''),requestId:params.requestId};
    return out;
  }
  if (method.startsWith('files.')) {out.params=require('../core/app-files-contract.cjs').normalize(method,params);return out;}
  if (method.startsWith('data.')) {
    out.params = method.startsWith('data.asset') ? require('../core/jiyong-contract.cjs').assetRequest(method,params) : require('../core/jiyong-contract.cjs').json(params);
    return out;
  }
  if (method.startsWith('attachments.')) {
    const attachments = require('./work-preview-app-attachments.cjs');
    if (method === 'attachments.pick') return out;
    if (method === 'attachments.release' || method === 'attachments.check') {
      out.params.ids = attachments.ids(params.ids);
    } else if (method === 'attachments.begin') {
      if (typeof params.name !== 'string' || !params.name.trim() || params.name.length > 240 ||
          !Number.isSafeInteger(params.size) || params.size < 0 || params.size > attachments.limits.MAX_BYTES) throw Error('附件名称或大小无效');
      out.params = { name: params.name, type: text(params.type, 160), size: params.size };
    } else {
      attachments.ids([params.id]);
      out.params.id = params.id;
      if (method === 'attachments.append') {
        if (!(params.data instanceof Uint8Array) || !params.data.byteLength || params.data.byteLength > attachments.limits.CHUNK_BYTES ||
            !Number.isSafeInteger(params.offset) || params.offset < 0) throw Error('附件分块无效');
        out.params.data = params.data;
        out.params.offset = params.offset;
      }
    }
    return out;
  }
  if (method === 'automation.create') {
    if (typeof params.text !== 'string' || params.text.length > MAX_TEXT || !params.text.trim()) throw Error('请填写定时任务要求（最多8000字）');
    if (typeof params.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(params.requestId)) throw Error('创建自动化需要有效请求编号');
    const context = params.context || {};
    const spaceId = text(context.spaceId, 160);
    if (context.spaceId != null && (!spaceId || spaceId !== context.spaceId)) throw Error('请选择有效的当前空间');
    out.params = { text: params.text.trim(), requestId: params.requestId, context: { spaceId, spaceName: text(context.spaceName, 160), page: text(context.page, 2000), characterName: text(context.characterName, 120) } };
    return out;
  }
  if (method.startsWith('settings.')) {
    out.params = require('./app-settings-store.cjs').normalize(params);
    if (out.params.includeSecrets && !out.params.keys) throw Error('读取凭据时必须明确指定字段');
    return out;
  }
  if (method === 'mcp.connect') {
    out.params.server = text(params.server, 60);
    out.params.url = text(params.url, 2000);
    out.params.token = text(params.token, 4096);
    out.params.credentialKey = text(params.credentialKey, 80);
    if (out.params.credentialKey && !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(out.params.credentialKey)) throw Error('应用凭据字段无效');
    out.params.context = Object.fromEntries(['spaceId', 'recordId'].map(key => [key, text(params.context?.[key], 160)]));
    for (const key of ['spaceName', 'recordName']) {
      if (params.context?.[key]) out.params.context[key] = text(params.context[key], 200);
    }
    if (!/^[a-z][a-z0-9-]{0,59}$/.test(out.params.server) || /[\r\n]/.test(out.params.token)) throw Error('应用连接参数无效');
    return out;
  }
  if (method === 'context.get') return out;
  if (method === 'composer.expand' || method === 'composer.collapse') return out;
  if (method === 'composer.theme') {
    out.params.theme = params.theme === 'dark' ? 'dark' : 'light';
    return out;
  }
  if (method === 'composer.insertText') {
    out.params.text = text(params.text, MAX_TEXT);
    out.params.append = params.append === true;
    if (!out.params.text) throw new Error('插入输入框需要内容');
    return out;
  }
  if (method === 'composer.send') {
    if (typeof params.text !== 'string' || params.text.length > MAX_TEXT || typeof params.requestId !== 'string' || params.requestId.length > 100) throw Error('发送内容或请求编号超出限制');
    out.params.text = text(params.text, MAX_TEXT);
    out.params.requestId = text(params.requestId, 100);
    if (!out.params.text || !/^[A-Za-z0-9_.:-]{1,100}$/.test(out.params.requestId)) throw Error('发送需要内容和有效请求编号');
    if (params.attachmentIds != null) out.params.attachmentIds = require('./work-preview-app-attachments.cjs').ids(params.attachmentIds);
    return out;
  }
  if (method === 'composer.insertAttachment') {
    out.params.name = text(params.name, 120);
    if (!out.params.name) throw new Error('插入附件需要名称');
    if (params.path != null) out.params.path = text(params.path, 400);
    if (params.size != null) out.params.size = Number(params.size) || 0;
    return out;
  }
  if (method === 'conversation.open') {
    out.params.title = text(params.title || '即用会话', MAX_TITLE);
    if (params.projectId != null) out.params.projectId = text(params.projectId, 160);
    return out;
  }
  if (method === 'conversation.send') {
    out.params.conversationId = text(params.conversationId, 160);
    out.params.text = text(params.text, MAX_TEXT);
    if (!out.params.conversationId || !out.params.text) throw new Error('发送会话消息需要会话和内容');
    return out;
  }
  if (method === 'requirements.propose') {
    out.params.title = text(params.title, MAX_TITLE);
    out.params.note = text(params.note, MAX_TEXT);
    if (!out.params.title || !out.params.note) throw new Error('创建需求需要标题和说明');
    if (params.projectId != null) out.params.projectId = text(params.projectId, 160);
    return out;
  }
  out.params.recipientUserId = text(params.recipientUserId, MAX_RECIPIENT);
  out.params.text = text(params.text, MAX_TEXT);
  if (!out.params.recipientUserId || !out.params.text) throw new Error('发送通知需要收件人和内容');
  return out;
}

module.exports = {
  VERSION, CAPABILITIES, METHODS, METHOD_CAPABILITY,
  normalizedCapabilities, hasCapability, normalizeOrigin, validateOrigin,
  normalizeManifestBridge, normalizeRequest,
  _limits: { MAX_REQUEST_ID, MAX_TEXT, MAX_TITLE, MAX_RECIPIENT },
};
