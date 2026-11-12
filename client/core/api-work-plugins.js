/* Plugin catalogs, authoring and workflow requests share the Hub transport and live renderer bridge. */
(function (global) {
  'use strict';

  function create(dependencies) {
    function presentPlugin(item) {
      if (!global.SoduWorkPluginLocales) return item;
      const locale = global.SoduWorkI18n?.getLocale?.() || global.navigator?.language || 'en';
      const result = global.SoduWorkPluginLocales.present(item, locale);
      if (item.conversationLocales) {
        const conversation = global.SoduWorkPluginLocales.present({ name: item.conversationName, inputs: item.conversationInputs, locales: item.conversationLocales }, locale);
        return { ...result, conversationName: conversation.name, conversationInputs: conversation.inputs };
      }
      return result;
    }
    var { jfetch, uploadFile, _fetch, parseJSON, mark, markFromError, pluginsChanged,
      taskStorageKey, registrationEpoch, staleTaskScope, registrationBoundaryError } = dependencies;
    var catalogFlight = null;
    return {
      /*
       * Clients may start approved project plugins only for their own tasks. Plugin import,
       * trust, and project binding remain administrative operations.
       */
      async workCatalog() {
        var r = await jfetch('/work-catalog');
        mark(true); return r || { professions: [], scenarios: [], recommendation: {} };
      },
      async recommendWorkScenario(body) {
        var r = await jfetch('/work-catalog/recommend', {
          method: 'POST', body: JSON.stringify(body || {})
        });
        mark(true); return r || {};
      },
      async taskPlugins(taskId) {
        var r = await jfetch('/tasks/' + encodeURIComponent(taskId) + '/plugins');
        mark(true); return r || { items: [] };
      },
      async setEnterprisePluginInstalled(pluginId, enabled, expectedVersionId, config) {
        var active = enabled !== false;
        var body = { enabled: active };
        if (active) body.expectedVersionId = expectedVersionId || '';
        if (active && config !== undefined) body.config = config || {};
        var r = await jfetch('/plugins/' + encodeURIComponent(pluginId) + '/installation', {
          method: 'PUT',
          body: JSON.stringify(body)
        });
        mark(true);
        pluginsChanged(pluginId);
        if(active && global.soduWorkAPI?.personalPlugins?.initialize){
          try{const initialization=await global.soduWorkAPI.personalPlugins.initialize(pluginId);return {...r,initialization};}
          catch(error){throw Error('即用安装已保存，但数据初始化未完成：'+error.message);}
        }
        return r || {};
      },
      async probeEnterprisePluginInstallation(pluginId, expectedVersionId, config) {
        var r = await jfetch('/plugins/' + encodeURIComponent(pluginId) + '/installation/probe', {
          method: 'POST',
          body: JSON.stringify({
            expectedVersionId: expectedVersionId || '',
            config: config || {}
          })
        });
        mark(true);
        return r || { ok: false, connections: [] };
      },
      /*
       * Evaluate workflow eligibility before task creation using the same criteria as
       * taskPlugins, without requiring a task ID.
       */
      async applicableFlows(projectId) {
        var r = await jfetch('/plugins/applicable' +
          (projectId ? '?projectId=' + encodeURIComponent(projectId) : ''));
        mark(true); return r || { items: [] };
      },
      async automationPlugins(projectId) {
        var r = await jfetch('/plugins/automation-options' +
          (projectId ? '?projectId=' + encodeURIComponent(projectId) : ''));
        mark(true); return r || { items: [] };
      },
      /* Composer-page starter recommendations: the server provides placement rows only;
         display fields are derived client-side by joining the catalog. */
      async composeRecommendations() {
        var r = await jfetch('/plugins/recommendations?surface=compose', { cache: 'no-store' });
        mark(true);
        return r || { items: [] };
      },
      async sidebarRecommendations() {
        var r = await jfetch('/plugins/recommendations?surface=sidebar', { cache: 'no-store' });
        mark(true);
        return r || { items: [] };
      },
      async pluginCatalog() {
        var scope = taskStorageKey('ops'), generation = registrationEpoch();
        if (catalogFlight && catalogFlight.scope === scope && catalogFlight.generation === generation) {
          return catalogFlight.promise;
        }
        var flight = { scope: scope, generation: generation };
        catalogFlight = flight;
        flight.promise = (async function () {
        var local = { items: [] };
        var bridge = global.soduWorkAPI && global.soduWorkAPI.personalPlugins;
        var requestScope = taskStorageKey('ops'), epoch = registrationEpoch(), changed = false;
        var onScopeChange = function () { changed = true; if (catalogFlight === flight) catalogFlight = null; };
        var listen = typeof global.addEventListener === 'function' && typeof global.removeEventListener === 'function';
        var events = ['soduwork-data-scope-changed', 'soduwork:plugins-changed', 'soduwork-plugin-policy'];
        if (listen) events.forEach(name => global.addEventListener(name, onScopeChange));
        var results;
        try {
          results = await Promise.allSettled([
            Promise.resolve().then(() => bridge && typeof bridge.list === 'function'
              ? bridge.list({ includeDisabled: true }) : local),
            jfetch('/plugins/catalog', { cache: 'no-store', taskScope: requestScope })
          ]);
        } finally {
          if (listen) events.forEach(name => global.removeEventListener(name, onScopeChange));
        }
        // Completed siblings can still belong to a previous account. Identity
        // changes must never be mistaken for an ordinary offline fallback.
        if (changed || epoch !== registrationEpoch() || requestScope !== taskStorageKey('ops')) throw staleTaskScope();
        results.forEach(function (result) {
          if (result.status === 'rejected' && registrationBoundaryError(result.reason)) throw result.reason;
        });
        if (results[0].status === 'fulfilled' && results[0].value) local = results[0].value;
        var remote = { items: [], submissions: [] };
        if (results[1].status === 'fulfilled') { remote = results[1].value || remote; mark(true); }
        else {
          var e = results[1].reason;
          markFromError(e);
          if ([401, 403].includes(Number(e && e.status))) throw e;
          if (!(local.items || []).length) throw e;
          remote.remoteError = String((e && e.message) || e);
        }
        return {
          items: [...(local.items || []), ...(remote.items || [])].map(presentPlugin),
          submissions: (remote.submissions || []).map(presentPlugin), categories: remote.categories || [],
          remoteError: remote.remoteError || ''
        };
        })();
        try { return await flight.promise; }
        finally { if (catalogFlight === flight) catalogFlight = null; }
      },
      async enterprisePluginDraft(pluginId) {
        const result = await jfetch('/plugins/' + encodeURIComponent(pluginId) + '/draft', { cache: 'no-store' });
        mark(true); return result;
      },
      async enterprisePluginPermissions(pluginId) {
        const result = await jfetch('/plugins/' + encodeURIComponent(pluginId) + '/permissions', { cache: 'no-store' });
        mark(true); return result;
      },
      async resolveConversationPlugins(pluginIds, projectId, conversationId) {
        var ids = [...new Set((pluginIds || []).map(String))].slice(0, 3);
        var localIds = ids.filter(function (id) { return id.indexOf('local:') === 0; });
        var remoteIds = ids.filter(function (id) { return id.indexOf('local:') !== 0; });
        var local = { items: [] }, remote = { items: [] };
        var bridge = global.soduWorkAPI && global.soduWorkAPI.personalPlugins;
        if (localIds.length) {
          if (!bridge || typeof bridge.resolve !== 'function') throw new Error('个人插件服务不可用');
          local = await bridge.resolve(localIds);
        }
        if (remoteIds.length) {
          remote = await jfetch('/plugins/conversation-context', {
            method: 'POST', body: JSON.stringify({
              pluginIds: remoteIds, projectId: projectId || '', conversationId: conversationId || ''
            })
          });
          mark(true);
        }
        var byId = {};
        [...(local.items || []), ...(remote.items || [])].forEach(function (item) { byId[item.pluginId] = item; });
        return { ok: true, items: ids.map(function (id) { return byId[id]; }).filter(Boolean) };
      },
      async preflightPlugin(file) {
        var r = await uploadFile('/plugins/preflight', file);
        mark(true); return r;
      },
      async preflightPluginArchive(file) {
        var bridge = global.soduWorkAPI && global.soduWorkAPI.personalPlugins;
        if (!bridge || typeof bridge.preflightArchive !== 'function' ||
            !file || typeof file.arrayBuffer !== 'function') {
          throw new Error('本地插件包预检服务不可用');
        }
        if (Number(file.size) > 10 * 1024 * 1024) {
          throw new Error('插件文件超过10MB，请精简资源后重试');
        }
        var bytes = new Uint8Array(await file.arrayBuffer()), binary = '';
        if (bytes.length > 10 * 1024 * 1024) {
          throw new Error('插件文件超过10MB，请精简资源后重试');
        }
        for (var offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
        }
        return bridge.preflightArchive(file.name || 'plugin.soduwork-plugin', btoa(binary));
      },
      async submitPlugin(file) {
        var r = await uploadFile('/plugins/submissions', file);
        mark(true); return r;
      },
      async preflightPluginDraft(body) {
        var bridge = global.soduWorkAPI && global.soduWorkAPI.personalPlugins;
        if (!bridge || typeof bridge.preflight !== 'function') throw new Error('个人插件服务不可用');
        return bridge.preflight(body || {});
      },
      async createPluginDraft(body) {
        var bridge = global.soduWorkAPI && global.soduWorkAPI.personalPlugins;
        if (!bridge || typeof bridge.create !== 'function') throw new Error('个人插件服务不可用');
        var result = await bridge.create(body || {});
        pluginsChanged(result && result.plugin && result.plugin.pluginId);
        return result;
      },
      async personalPlugin(pluginId) {
        var bridge = global.soduWorkAPI && global.soduWorkAPI.personalPlugins;
        if (!bridge || typeof bridge.get !== 'function') throw new Error('个人插件服务不可用');
        return bridge.get(pluginId);
      },
      async configurePersonalPlugin(pluginId, checksum, config) {
        var bridge = global.soduWorkAPI && global.soduWorkAPI.personalPlugins;
        if (!bridge || typeof bridge.configure !== 'function') throw new Error('个人插件设置服务不可用，请升级客户端');
        var result = await bridge.configure(pluginId, checksum, config);
        pluginsChanged(pluginId);
        return result;
      },
      async pluginAudienceCandidates() {
        var r = await jfetch('/plugins/audience-candidates');
        mark(true); return r || { items: [] };
      },
      async personalPluginPublisherIdentity() {
        var bridge = global.soduWorkAPI && global.soduWorkAPI.personalPlugins;
        if (!bridge || typeof bridge.publisherIdentity !== 'function') {
          throw new Error('本机插件签名服务不可用');
        }
        return bridge.publisherIdentity();
      },
      async signPersonalPluginDraft(draft) {
        var bridge = global.soduWorkAPI && global.soduWorkAPI.personalPlugins;
        if (!bridge || typeof bridge.publisherIdentity !== 'function' ||
            typeof bridge.signPayload !== 'function') throw new Error('本机插件签名服务不可用');
        var identityResult = await bridge.publisherIdentity();
        var identity = identityResult && identityResult.identity || {};
        var prepared = await jfetch('/plugins/drafts/signing-payload', {
          method: 'POST', body: JSON.stringify({
            draft: draft || {}, keyId: identity.keyId || '', signedAt: new Date().toISOString()
          })
        });
        mark(true);
        var signed = await bridge.signPayload(prepared && prepared.payload || {});
        return {
          identity: identity, signature: signed && signed.signature || {},
          contentChecksum: prepared && prepared.contentChecksum || ''
        };
      },
      async publishPersonalPlugin(draft, visibility, userIds, orgUnitIds, signature, publisher) {
        var r = await jfetch('/plugins/personal-publish', {
          method: 'POST', body: JSON.stringify({
            draft: draft || {}, visibility: visibility || 'organization',
            userIds: userIds || [], orgUnitIds: orgUnitIds || [], signature: signature || null,
            publisher: publisher || {}
          })
        });
        mark(true); return r || {};
      },
      async setPersonalPluginEnabled(pluginId, enabled) {
        var result = await global.soduWorkAPI.personalPlugins.setEnabled(pluginId, enabled);
        pluginsChanged(pluginId);
        return result;
      },
      async setPersonalPluginVersion(pluginId, version) {
        var result = await global.soduWorkAPI.personalPlugins.setVersion(pluginId, version);
        pluginsChanged(pluginId);
        return result;
      },
      async deletePersonalPlugin(pluginId) {
        var result = await global.soduWorkAPI.personalPlugins.remove(pluginId);
        pluginsChanged(pluginId);
        return result;
      },
      async taskPluginRuns(taskId) {
        var r = await jfetch('/tasks/' + encodeURIComponent(taskId) + '/plugin-runs');
        mark(true); return r || { items: [] };
      },
      async taskPluginRun(runId) {
        var r = await jfetch('/plugin-runs/' + encodeURIComponent(runId));
        mark(true); return r || {};
      },
      async startTaskPlugin(taskId, body) {
        if (window.NativeChat && typeof window.NativeChat.enqueueTask === 'function' && !(body && body.resumeFromRunId)) {
          // A workflow started from the requirement drawer is a new task
          // dispatch.  It must not inherit the currently visible conversation
          // (which may be a passive cloud conversation); doing so made the
          // The drawer reported a cloud-transferred conversation and left the requirement pending.
          // Keep the same navigation semantics as direct requirement dispatch:
          // open an appropriate local/remote task conversation and run the
          // workflow there, while preserving the selected execution context.
          const result = await window.NativeChat.enqueueTask(taskId, { ...body,
            source: 'task-dispatch', reuseConversation: false,
            brief: body && body.instruction,
            executionContext: { ...(body && body.executionContext), strategy: 'workflow', execution: body && body.execution } });
          if (!result || result.ok === false) throw new Error(result && result.reason || '需求未能进入会话队列');
          return result;
        }
        var r = await jfetch('/tasks/' + encodeURIComponent(taskId) + '/plugin-runs', {
          method: 'POST', body: JSON.stringify(body || {})
        });
        mark(true);
        if (r && r.ok === false) {
          throw new Error(r.reason || r.error || r.message || '插件没有成功启动');
        }
        return r;
      },
      async recoverTaskPluginArtifacts(runId) {
        var res = await _fetch('/plugin-runs/' + encodeURIComponent(runId) + '/recover-artifacts',
          { method: 'POST', body: '{}' }, 180000);
        var text = await res.text();
        if (!res.ok) { mark(true); throw new Error('HTTP ' + res.status + (text ? ': ' + text : '')); }
        mark(true); return text ? parseJSON(text) : null;
      },
      async retryTaskPluginQuality(runId) {
        var r = await jfetch('/plugin-runs/' + encodeURIComponent(runId) + '/retry-quality', {
          method: 'POST', body: '{}'
        });
        mark(true); return r;
      },
      async retryTaskPluginGate(runId, nodeKey, execution, options) {
        /* Optional execution overrides contain agentKind and model for retrying a node with another runtime. */
        var body = {};
        if (nodeKey) body.nodeKey = nodeKey;
        if (execution && (execution.agentKind || execution.model)) body.execution = execution;
        if (options && options.resumeRework) body.resumeRework = true;
        var r = await jfetch('/plugin-runs/' + encodeURIComponent(runId) + '/retry-gate', {
          method: 'POST', body: JSON.stringify(body)
        });
        mark(true); return r;
      },
      async redispatchTaskPluginGate(runId, nodeKey, execution) {
        /* Stop an active AI node before redispatching it to the selected runtime. */
        var body = {};
        if (nodeKey) body.nodeKey = nodeKey;
        if (execution && (execution.agentKind || execution.model)) body.execution = execution;
        var r = await jfetch('/plugin-runs/' + encodeURIComponent(runId) + '/redispatch', {
          method: 'POST', body: JSON.stringify(body)
        });
        mark(true); return r;
      },
      async cancelTaskPluginRun(runId, reason) {
        var r = await jfetch('/plugin-runs/' + encodeURIComponent(runId) + '/cancel', {
          method: 'POST', body: JSON.stringify({ reason: reason || '由需求负责人结束本次流程' })
        });
        mark(true); return r;
      },
    };
  }

  global.SoduWorkPluginAPI = { create: create };
})(typeof window !== 'undefined' ? window : this);
