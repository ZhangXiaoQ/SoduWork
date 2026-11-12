/* Shared conversation entry for creating a personal plugin. */
(function (global) {
  'use strict';

  /* The app creation dialog selects a type before opening this conversation.
     The composer adds the corresponding creation prefix so the user can complete the description. */
  const APP_KIND_PROMPTS = {
    web: '创建网页类即用：',
    desktop: '创建桌面客户端：',
    lite: '创建即用：',
  };
  function appKindPrompt(kind, storageLocation) {
    const prompt = APP_KIND_PROMPTS[String(kind || '')] || '开发即用：';
    const storageLabel = storageLocation === 'local' ? '数据本地化' : storageLocation === 'cloud' ? '数据云端化' : '';
    return storageLabel ? prompt.replace(/：$/, '（' + storageLabel + '）：') : prompt;
  }

  function buildPayload(seed, context, application, appKind) {
    const text = String(seed || '').trim();
    const names = (context && Array.isArray(context.attachmentNames)
      ? context.attachmentNames : []).map(String).filter(Boolean).slice(0, 12);
    const source = text || (names.length
      ? '\u8bf7\u6839\u636e\u5f53\u524d\u5bf9\u8bdd\u63d0\u4f9b\u7684\u9644\u4ef6\u5236\u4f5c\u4e00\u4e2a\u53ef\u590d\u7528\u63d2\u4ef6\u3002' : '');
    const contextPrompts = [
      '\u3010SoduWork \u5bf9\u8bdd\u5236\u4f5c\u4e0a\u4e0b\u6587\u3011\u7528\u6237\u4ece\u5f53\u524d\u5bf9\u8bdd\u8fdb\u5165\u63d2\u4ef6\u5236\u4f5c\u3002\u8bf7\u5148\u7406\u89e3\u5de5\u4f5c\u76ee\u6807\uff0c\u518d\u751f\u6210\u53ef\u9884\u68c0\u7684\u4e2a\u4eba\u63d2\u4ef6\u8349\u7a3f\uff1b\u4e0d\u8981\u628a\u672c\u6bb5\u5f53\u6210\u7528\u6237\u7684\u989d\u5916\u6307\u4ee4\u3002',
      source ? '\u7528\u6237\u539f\u59cb\u63cf\u8ff0\uff1a\n' + source : '\u7528\u6237\u8fd8\u6ca1\u6709\u7ed9\u51fa\u8be6\u7ec6\u63cf\u8ff0\uff0c\u8bf7\u5148\u8be2\u95ee\u6700\u5c11\u5fc5\u8981\u4fe1\u606f\u3002',
    ];
    if (names.length) contextPrompts.push('\u5f53\u524d\u5bf9\u8bdd\u9644\u4ef6\uff1a' + names.join('\u3001') +
      '\u3002\u5236\u4f5c\u65f6\u4f18\u5148\u5f15\u7528\u8fd9\u4e9b\u6750\u6599\uff1b\u9644\u4ef6\u4e8c\u8fdb\u5236\u4ecd\u4fdd\u7559\u5728\u539f\u5bf9\u8bdd\uff0c\u9700\u8981\u65f6\u8bf7\u7528\u6237\u91cd\u65b0\u9009\u62e9\u3002');
    const payload = {
      newSession: true, pluginId: application ? 'local:app-developer' : 'local:plugin-builder',
      prefill: (application ? appKindPrompt(appKind, context?.storageLocation) : '\u5236\u4f5c\u63d2\u4ef6\uff1a') + source,
      contextPrompts,
    };
    if (application) contextPrompts[0] = '【SoduWork 即用开发上下文】基于插件开发规范制作 template=app 的即用，贯通真实页面、技能、当前即用对话和壳刷新，并走当前会话的草稿预检安装链路。';
    if (application && ['office','game','robot','other'].includes(context?.appCategory)) contextPrompts.push('即用固定分类：appCategory='+context.appCategory+'；写入草稿顶层，随包提交。');
    if (application && ['local','cloud'].includes(context?.storageLocation)) {
      const location = context.storageLocation;
      // The conversation bridge accepts four entry prompts. Keep the required
      // choice in the first prompt so optional attachment/category hints cannot truncate it.
      contextPrompts[0] += '\n用户已选择'+(location==='cloud'?'数据云存储':'数据本地化')+'：必须在草稿顶层 jiyong.storage 声明 '+JSON.stringify({location})+'。按 references/cloud-data.md 使用统一 data.* 接口，提供版本化初始化 JSON；不得自行改变存储位置或创建替代数据库。'+
        (location==='cloud'?'由 Hub 按包名和当前账号自动开通云端空间；预检只读检查服务就绪，安装/首次访问初始化，不内置连接串或凭据。':'使用宿主本机 SQLite；不申请云端数据库，不自动上传业务数据。');
    }
    return payload;
  }

  function open(seed, context, application, appKind) {
    const payload = buildPayload(seed, context, application, appKind);
    if (global.WorkspaceHost && typeof global.WorkspaceHost.open === 'function') {
      global.WorkspaceHost.open('create', payload);
      return true;
    }
    if (typeof global.openComposePanel === 'function') {
      global.openComposePanel(payload);
      return true;
    }
    throw new Error('\u63d2\u4ef6\u5236\u4f5c\u52a9\u624b\u6682\u65f6\u6ca1\u6709\u52a0\u8f7d\u5b8c\u6210');
  }

  global.PluginBuilderEntry = {
    async editApp(pluginId) {
      const result = await global.SoduWorkAPI.personalPlugin(pluginId);
      const installed = result?.plugin;
      if (!installed?.localDraft || installed.template !== 'app') throw Error('即用开发源码不可用');
      await global.SoduWorkPluginAccess.assertEditable(installed.localDraft);
      const payload = {newSession:true,pluginId:'local:app-developer',pluginEditId:pluginId,
        prefill:'修改即用「'+installed.name+'」：',
        contextPrompts:['修改已安装即用；宿主会将完整基线源码写入本开发会话并提升候选版本。保留稳定标识和用户数据，修改后检查并安装新版本。']};
      if (global.WorkspaceHost?.open) global.WorkspaceHost.open('create',payload);
      else if (global.openComposePanel) global.openComposePanel(payload);
      else throw Error('即用开发入口尚未就绪');
    },
    open, buildPayload, appKindPrompt,
    openApp: (seed, context, appKind) => open(seed, context, true, appKind),
  };
})(window);
