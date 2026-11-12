(function (global) {
  'use strict';

  /* Renderer-side policy adapter. The web app gets a response-shaped API; it
     never receives a native session ref, a filesystem path, or a Hub token. */
  const conversations = new Map();
  const MAX_CONVERSATIONS = 20;
  let sequence = 0, epoch = 0;

  function keyOf(request) {
    return String(request && request.appId || '') + ':' + String(request && request.tabId || '');
  }
  function publicConversationId(request) {
    return 'conversation-' + Date.now().toString(36) + '-' + (++sequence).toString(36);
  }
  function sessionApi() {
    return global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
  }
  function safeContext(request) {
    return {
      ok: true, appId: String(request.appId || ''), contributionId: String(request.contributionId || ''),
      tabId: String(request.tabId || ''), activeConversationId: String(global.WorkspaceShell?.activeChatId || ''),
      locale: String(global.SoduWorkI18n?.getLocale?.() || 'en-US'),
    };
  }

  async function handle(request) {
    const generation = epoch, scope = global.SoduWorkAPI?.taskStorageKey?.('ops');
    const current = () => {
      if (generation !== epoch || scope !== global.SoduWorkAPI?.taskStorageKey?.('ops'))
        throw Error('Application account changed');
    };
    const authorize = async () => {
      current();
      const host = global.soduWorkAPI?.workPreviewAppHost;
      if (typeof host?.authorize !== 'function' || !(await host.authorize(request?.id))?.ok)
        throw Error('Application request authorization expired');
      current();
    };
    await authorize();
    const appId = String(request?.appId || '');
    if (appId.startsWith('plugin:')) {
      try {
        if (!global.PluginUIHost?.assertUse) throw new Error('插件权限校验暂不可用');
        await global.PluginUIHost.assertUse(appId.slice(7));
        await authorize();
      } catch (error) {
        return { ok: false, code: 'PLUGIN_USE_DENIED', reason: String(error?.message || error) };
      }
    }
    const method = String(request && request.method || '');
    const params = request && request.params || {};
    if (method === 'automation.create') {
      if (!global.WorkAutomationDirect?.create) return { ok: false, reason: '当前 SoduWork 尚未支持直接创建自动化，请更新客户端' };
      try { return await global.WorkAutomationDirect.create(params, { authorize: async () => {
        await authorize();
        await global.PluginUIHost.assertUse(appId.slice(7));
        const installed = await global.soduWorkAPI.personalPlugins.get(appId.slice(7));
        const source = installed?.plugin?.ui?.contributions?.find(row => row.id === request.contributionId)?.source;
        await authorize();
        if (!installed?.plugin?.enabled || !source?.bridge?.capabilities?.includes('automation.create')) throw Error('应用直接创建自动化的权限已变化，请重新打开应用');
      } }); }
      catch (error) { return { ok: false, reason: String(error?.message || error) }; }
    }
    if(['user.getCurrent','notifications.list','library.list','library.read'].includes(method)){
      if(!global.SoduWorkAppHostData)throw Error('宿主数据SDK未加载，请更新客户端');
      return global.SoduWorkAppHostData.handle(method,params);
    }
    if (method === 'directory.list') {
      const api=global.SoduWorkAPI,scope=api?.taskStorageKey?.('plugins');
      if(!api?.listTeammates)return {ok:false,reason:'当前客户端尚未支持同事目录'};
      const result=await api.listTeammates();
      if(scope!==api.taskStorageKey?.('plugins'))return {ok:false,reason:'SoduWork 账号已变化，请重新读取同事目录'};
      if(result?.ok===false)return {ok:false,reason:result.reason || '同事目录读取失败'};
      const members=(result?.mates || []).slice(0,500).map(row=>({id:String(row.id || ''),name:String(row.name || '').slice(0,120),orgId:String(row.orgId || ''),org:String(row.org || '').slice(0,120),canReceive:row.canReceive===true || row.hasBox===true}));
      const orgUnits=(result?.orgUnits || []).slice(0,500).map(row=>({id:String(row.id || ''),name:String(row.name || '').slice(0,120),parentId:String(row.parentId || '')}));
      return {ok:true,members,orgUnits,organizationDirectoryAvailable:Array.isArray(result?.orgUnits),truncated:(result?.mates?.length || 0)>500 || (result?.orgUnits?.length || 0)>500,reason:String(result?.reason || '').slice(0,300)};
    }
    if (method === 'context.get') return safeContext(request);
    if (method === 'conversation.open') {
      const api = sessionApi();
      if (!api || typeof api.open !== 'function') return { ok: false, code: 'CONVERSATION_UNAVAILABLE', reason: '当前客户端暂不支持对话能力' };
      const opened = await api.open({
        adapterId: 'pi', intent: 'chat', appRequestId: request.id,
        ...(params.title ? { title: String(params.title) } : {}),
        ...(params.projectId ? { projectId: String(params.projectId) } : {}),
      });
      if (!opened || opened.ok === false || !opened.ref) return { ok: false, code: 'CONVERSATION_OPEN_FAILED', reason: opened && opened.reason || '无法打开对话' };
      if (conversations.size >= MAX_CONVERSATIONS) conversations.delete(conversations.keys().next().value);
      const id = publicConversationId(request);
      conversations.set(id, { appKey: keyOf(request), ref: opened.ref });
      return { ok: true, conversationId: id };
    }
    if (method === 'conversation.send') {
      const record = conversations.get(String(params.conversationId || ''));
      if (!record || record.appKey !== keyOf(request)) return { ok: false, code: 'CONVERSATION_NOT_FOUND', reason: '对话已关闭，请重新打开' };
      const api = sessionApi();
      /*
       * Application conversations include the application's plugin for this turn. The plugin ID
       * is only a lookup key; the main process resolves executable content again when starting
       * the turn.
       */
      const ownPluginId = appId.startsWith('plugin:') ? appId.slice(7).trim() : '';
      const result = await api.send(record.ref, String(params.text || ''), [], {
        source: 'web-app', appRequestId: request.id,
        ...(ownPluginId ? { plugins: [{ pluginId: ownPluginId }] } : {}),
      });
      return { ok: result?.ok !== false, accepted: result?.accepted !== false, conversationId: params.conversationId };
    }
    if (method === 'requirements.propose') {
      if (!global.WorkEntrySheet || typeof global.WorkEntrySheet.openTask !== 'function') {
        return { ok: false, code: 'REQUIREMENT_UNAVAILABLE', reason: '需求创建页面暂不可用' };
      }
      global.WorkEntrySheet.openTask({
        source: 'web-app', saveOnly: true,
        proposal: { title: params.title, note: params.note, checklist: [], priority: 'normal', kind: 'requirement' },
        projectId: params.projectId || '',
      });
      return { ok: true, state: 'review' };
    }
    if (method === 'notifications.send') {
      if (!global.SoduWorkAPI || typeof global.SoduWorkAPI.sendMateMessage !== 'function') {
        return { ok: false, code: 'NOTIFICATION_UNAVAILABLE', reason: '通知能力暂不可用' };
      }
      const result = await global.SoduWorkAPI.sendMateMessage(params.recipientUserId, params.text);
      return { ok: result?.ok !== false, notificationId: result?.id || result?.messageId || '' };
    }
    return { ok: false, code: 'APP_METHOD_UNSUPPORTED', reason: '应用方法未开放' };
  }

  function install() {
    const host = global.soduWorkAPI && global.soduWorkAPI.workPreviewAppHost;
    if (!host || typeof host.onRequest !== 'function' || typeof host.respond !== 'function') return false;
    host.onRequest((request) => {
      Promise.resolve().then(() => handle(request)).catch((error) => ({
        ok: false, code: 'APP_HOST_ERROR', reason: String(error && error.message || error),
      })).then((result) => host.respond(request && request.id, result));
    });
    global.addEventListener('soduwork-data-scope-changed', () => conversations.clear());
    return true;
  }

  global.SoduWorkAppBridgeHost = { install, _handle: handle, _conversations: conversations };
  install();
})(window);
