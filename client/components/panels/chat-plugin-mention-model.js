/* Pure catalog, action and turn-input normalization for ChatPluginMention.
   Selection and menu state stay in the per-composer picker closure. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatPluginMentionModel = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function names(value, limit) {
    return [...new Set((Array.isArray(value) ? value : []).map((item) =>
      String(item || '').trim()).filter(Boolean))].slice(0, limit || 30);
  }

  function normalizeActions(value) {
    return (Array.isArray(value) ? value : []).map((item) => {
      const actionId = String(item && (item.actionId || item.id) || '').trim();
      const command = String(item && item.command || '').trim().replace(/^\/+/, '');
      const aliases = names(item && item.aliases, 12);
      const action = {
        actionId,
        command,
        aliases,
        name: String(item && item.name || command || '工作动作'),
        description: String(item && item.description || ''),
        icon: String(item && item.icon || command.slice(0, 1) || '/'),
        badge: String(item && item.badge || '内置表单'),
        kind: 'action',
      };
      action.searchText = [action.command, action.name, action.description, ...aliases]
        .map(part => String(part || '').toLocaleLowerCase()).join(' ');
      return action;
    }).filter(item => item.actionId && item.command);
  }

  /* Plugin authoring is a conversation action, not another admin form. */
  function pluginBuilderAction() {
    return {
      actionId: 'work.plugin.create',
      command: '\u5236\u4f5c\u63d2\u4ef6',
      aliases: ['\u521b\u5efa\u63d2\u4ef6', 'plugin'],
      name: '\u5236\u4f5c\u63d2\u4ef6',
      description: '\u548c SoduWork \u5bf9\u8bdd\u751f\u6210\u4e2a\u4eba\u63d2\u4ef6\uff0c\u9884\u68c0\u540e\u5b89\u88c5\u8bd5\u7528',
      icon: '\u2726', badge: '\u5bf9\u8bdd\u5236\u4f5c', kind: 'action',
    };
  }

  function commandText(action, value) {
    const body = String(value || '').trim();
    if (!action || !String(action.command || '').trim()) return body;
    return '/' + String(action.command).replace(/^\/+/, '') + (body ? ' ' + body : '');
  }

  function normalizeCapabilities(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      skills: names(source.skills, 30),
      mcpServers: names(source.mcpServers, 30),
      runtime: names(source.runtime, 30),
      components: (Array.isArray(source.components) ? source.components : []).slice(0, 30).map(
        (item) => ({
          kind: String(item && item.kind || ''),
          label: String(item && item.label || item && item.kind || ''),
        })),
      hasWorkflow: source.hasWorkflow !== false,
      executionMode: String(source.executionMode || ''),
    };
  }

  function normalizePluginInputs(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : []).slice(0, 50).map((raw) => {
      const source = raw && typeof raw === 'object' ? raw : {};
      const key = String(source.key || '').trim().slice(0, 64);
      let type = String(source.type || 'text').trim().toLowerCase();
      type = ({ string: 'text', bool: 'boolean', enum: 'select' })[type] || type;
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || seen.has(key) ||
          !['text', 'textarea', 'boolean', 'number', 'select'].includes(type)) return null;
      seen.add(key);
      const field = {
        key, type, label: String(source.label || key).trim().slice(0, 100),
        required: Boolean(source.required),
        description: String(source.description || '').trim().slice(0, 300),
        placeholder: String(source.placeholder || '').trim().slice(0, 180),
      };
      if (Object.prototype.hasOwnProperty.call(source, 'default')) field.default = source.default;
      if (type === 'select') {
        field.options = (Array.isArray(source.options) ? source.options : []).slice(0, 50)
          .map((option) => {
            const row = option && typeof option === 'object' ? option : { value: option, label: option };
            const optionValue = String(row.value || '').trim().slice(0, 200);
            return optionValue ? { value: optionValue,
              label: String(row.label || optionValue).trim().slice(0, 100) } : null;
          }).filter(Boolean);
        if (!field.options.length) return null;
      }
      return field;
    }).filter(Boolean);
  }

  const CONVERSATION_INPUT_KEYS = new Set([
    'goal', 'objective', 'request', 'requirement', 'prompt', 'instruction',
    'task', 'query', 'question', 'topic', 'brief', 'description', 'content', 'message',
  ]);
  const CONVERSATION_INPUT_TOKENS = new Set([
    ...CONVERSATION_INPUT_KEYS, 'intent', 'need', 'purpose', 'outcome', 'problem',
  ]);
  const CONVERSATION_INPUT_LABEL = /(?:\u76ee\u6807|\u9700\u6c42|\u8bc9\u6c42|\u8981\u6c42|\u610f\u56fe|\u76ee\u7684|\u671f\u671b|\u4efb\u52a1|\u95ee\u9898|\u4e3b\u9898|\u8bf4\u660e|\u63cf\u8ff0|\u80cc\u666f|\u5185\u5bb9|\u6307\u4ee4|\u6210\u679c|\u4ea7\u51fa|\u8981\u505a\u4ec0\u4e48)/;

  function hasInputValue(field, value) {
    if (field && field.type === 'boolean') return value === true;
    if (field && field.type === 'number') {
      return value !== '' && value != null && Number.isFinite(Number(value));
    }
    return Boolean(String(value == null ? '' : value).trim());
  }

  function conversationInputRank(field) {
    if (!field || !['text', 'textarea'].includes(field.type)) return 0;
    const rawKey = String(field.key || '').trim();
    const exactKey = rawKey.toLowerCase();
    const compactKey = exactKey.replace(/[-_]/g, '');
    // A plain text payload is a conversation input, not every field ending in Text.
    if (exactKey === 'text') return 3;
    if (CONVERSATION_INPUT_KEYS.has(exactKey) || CONVERSATION_INPUT_KEYS.has(compactKey)) return 3;
    const tokens = rawKey.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
      .split(/[^a-z0-9]+/).filter(Boolean);
    if (tokens.some((token) => CONVERSATION_INPUT_TOKENS.has(token))) return 2;
    return CONVERSATION_INPUT_LABEL.test(String(field.label || '')) ? 1 : 0;
  }

  function isConversationInput(field) {
    return conversationInputRank(field) > 0;
  }

  function attachmentNames(context) {
    const source = context && (context.attachmentNames || context.attachments);
    return (Array.isArray(source) ? source : []).map((item) => String(
      item && typeof item === 'object' ? (item.name || item.filename || '') : item || '').trim())
      .filter(Boolean).slice(0, 12);
  }

  function inferenceText(seed, context) {
    const message = String(seed || '');
    if (message.trim()) {
      /* A follow-up may explicitly delegate the previous result to the plugin.
         Preserve the current instruction while using the bounded transcript as
         the structured input value; the model still receives both in the prompt. */
      const prior = String(context && (context.priorConversationText || context.conversationText) || '').trim();
      if (prior && referencesPriorConversation(message)) return prior.slice(-12000);
      return message;
    }
    const names = attachmentNames(context);
    return names.length
      ? '\u8bf7\u6839\u636e\u672c\u8f6e\u63d0\u4f9b\u7684\u9644\u4ef6\u5b8c\u6210\u3002\u9644\u4ef6\uff1a' + names.join('\u3001')
      : '';
  }

  function referencesPriorConversation(value) {
    const text = String(value || '');
    if (/\b(?:the\s+)?(?:above|previous|earlier|prior|last)\s+(?:result|output|transcript|response|reply|answer|content|message|turn|one)\b/i.test(text)) return true;
    if (/\b(?:the|this|that|my|your|same|previous|last)\s+(?:result|output|transcript|response|reply|answer|content)\b/i.test(text)) return true;
    if (/\b(?:send|use|apply|forward|pass|publish|process|summarize|deliver|continue|share|attach|include|based\s+on)\s+(?:(?:the|this|that|my|your|same|previous|last)\s+)?(?:result|output|transcript|response|reply|answer|content|it|this|that|same)\b/i.test(text)) return true;
    if (/\b(?:send|use|apply|forward|pass|publish|process|summarize|deliver|continue|share|attach|include|based\s+on)\s+(?:the\s+)?above\b/i.test(text)) return true;
    if (/\b(?:send|use|apply|forward|pass|publish|process|summarize|deliver|continue|based\s+on)\s+(?:it|this|that|same)\b/i.test(text)) return true;
    if (/(?:\u4e0a\u9762|\u4e0a\u8ff0|\u524d\u9762|\u4e4b\u524d|\u521a\u624d|\u4e0a\u4e00\u8f6e|\u4e0a\u4e00\u6b21).{0,8}(?:\u7ed3\u679c|\u8f93\u51fa|\u56de\u590d|\u56de\u7b54|\u5185\u5bb9)/.test(text)) return true;
    if (/(?:\u7ed3\u679c|\u8f93\u51fa|\u56de\u590d|\u56de\u7b54).{0,8}(?:\u4ea4\u7ed9|\u53d1\u9001\u7ed9|\u4f20\u7ed9|\u7528\u4e8e|\u7ee7\u7eed|\u5904\u7406)/.test(text)) return true;
    return /(?:\u628a|\u5c06).{0,8}(?:\u5185\u5bb9).{0,8}(?:\u4ea4\u7ed9|\u53d1\u9001\u7ed9|\u4f20\u7ed9|\u7528\u4e8e|\u7ee7\u7eed|\u5904\u7406)/.test(text);
  }

  /* Conversation-first input policy: the user's sentence already is the goal.
     Only fields that cannot be inferred safely remain for the governed sheet. */
  function prepareConversationInputs(value, seed, savedValues, context) {
    const fields = normalizePluginInputs(value);
    const saved = savedValues && typeof savedValues === 'object' ? savedValues : {};
    const values = {};
    fields.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(field, 'default')) values[field.key] = field.default;
      if (Object.prototype.hasOwnProperty.call(saved, field.key)) values[field.key] = saved[field.key];
    });
    const message = inferenceText(seed, context);
    let missing = fields.filter((field) => field.required && !hasInputValue(field, values[field.key]));
    const candidates = missing.filter(isConversationInput);
    const exact = candidates.filter((field) => conversationInputRank(field) === 3);
    const compound = candidates.filter((field) => conversationInputRank(field) === 2);
    let inferred = [];
    if (message && exact.length === 1) inferred = exact;
    else if (message && !exact.length && compound.length === 1) inferred = compound;
    else if (message && missing.length === 1 && candidates.length === 1) inferred = candidates;
    inferred.forEach((field) => { values[field.key] = message; });
    missing = fields.filter((field) => field.required && !hasInputValue(field, values[field.key]));
    return {
      fields, values, missing, ready: !missing.length,
      inferredKeys: inferred.map((field) => field.key),
    };
  }

  function preparedConversationText(seed, plugins, valuesByPlugin) {
    const message = String(seed || '');
    const chunks = [];
    (Array.isArray(plugins) ? plugins : []).forEach((plugin) => {
      const values = valuesByPlugin && valuesByPlugin.get
        ? valuesByPlugin.get(plugin.pluginId) : null;
      if (!values || typeof values !== 'object') return;
      const rows = [];
      normalizePluginInputs(plugin.inputs).forEach((field) => {
        if (!Object.prototype.hasOwnProperty.call(values, field.key)) return;
        let value = values[field.key];
        if (isConversationInput(field) && String(value == null ? '' : value).trim() === message.trim()) return;
        if (field.type === 'boolean') value = value ? '是' : '否';
        if (value == null || String(value).trim() === '') return;
        rows.push(field.label + '：' + String(value).trim());
      });
      if (rows.length) chunks.push('「' + plugin.name + '」本轮参数：\n' + rows.join('\n'));
    });
    return [message.trim() ? message : '', ...chunks].filter(Boolean).join('\n\n');
  }

  function normalizeConversationUse(item) {
    const source = item && item.conversationUse;
    if (source && typeof source.available === 'boolean') {
      return {
        available: source.available, code: String(source.code || ''),
        label: String(source.label || ''), requiresProject: Boolean(source.requiresProject),
        missingMcp: names(source.missingMcp, 20),
      };
    }
    const entrypoints = item && item.entrypoints || {};
    const policy = item && item.marketPolicy || {};
    const missingMcp = names(item && item.dependencyReadiness &&
      item.dependencyReadiness.missingMcp, 20);
    if (entrypoints.conversation === false) {
      return { available: false, code: 'entrypoint_disabled',
        label: '\u4ec5\u4efb\u52a1\u6216\u81ea\u52a8\u5316', requiresProject: false, missingMcp: [] };
    }
    if (policy.installation === 'not_available') {
      return { available: false, code: 'task_only',
        label: '\u4efb\u52a1\u4e13\u7528', requiresProject: false, missingMcp: [] };
    }
    if (!(item && (item.personal || item.installed))) {
      return { available: false, code: 'install_required',
        label: '\u8bf7\u5148\u5b89\u88c5', requiresProject: false, missingMcp: [] };
    }
    if (item && item.enabled === false) {
      return { available: false, code: 'disabled',
        label: '\u5df2\u505c\u7528', requiresProject: false, missingMcp: [] };
    }
    if (missingMcp.length) {
      return { available: false, code: 'connection_required',
        label: '\u8fde\u63a5\u5f85\u6062\u590d', requiresProject: false, missingMcp };
    }
    return { available: true, code: 'ready',
      label: '\u53ef\u5728\u5bf9\u8bdd\u4f7f\u7528', requiresProject: false, missingMcp: [] };
  }

  function availability(item, projectId) {
    const state = item && item.conversationUse || normalizeConversationUse(item);
    if (!state.available && state.code === 'project_required' && String(projectId || '').trim()) {
      return { ...state, available: true, code: 'ready_for_project',
        label: '\u5f53\u524d\u9879\u76ee' };
    }
    return state;
  }

  function pluginKind(item) {
    const cap = item && item.capabilities || {};
    if (cap.hasWorkflow !== false && (cap.executionMode === 'workflow' ||
        (item.workflow || []).length)) return 'workflow';
    if ((cap.mcpServers || []).length) return 'connector';
    if ((cap.skills || []).length) return 'skill';
    return 'plugin';
  }

  function searchable(item) {
    const cap = item.capabilities || {};
    return [item.name, item.key, item.qualifiedKey, item.scope, item.description, item.kind,
      ...(cap.skills || []), ...(cap.mcpServers || []), ...(cap.runtime || []),
      ...(cap.components || []).flatMap((row) => [row.kind, row.label]),
      ...(item.workflow || []).map((row) => row.name),
      ...(item.inputs || []).flatMap((field) => [field.label, field.description,
        ...(field.options || []).flatMap((option) => [option.label, option.value])])]
      .map((value) => String(value || '').toLocaleLowerCase()).join(' ');
  }

  /* Applications share the remote catalog with conversation plugins, but their
     workspace.navigation pages belong in the app rail. Older catalog payloads
     did not always copy template: "app" through, so the contribution slot is
     the compatibility boundary for the slash-only plugin picker. */
  function isWorkspaceApp(item) {
    if (!item || typeof item !== 'object') return false;
    if (String(item.template || '').trim().toLowerCase() === 'app') return true;
    return Array.isArray(item.ui?.contributions) && item.ui.contributions.some((row) =>
      row && row.slot === 'workspace.navigation');
  }

  function displayText(item, field, translate) {
    const source = item?.builtIn && (item.locales?.['zh-CN'] || item.locales?.['zh-cn'])?.[field];
    return String(source && translate ? translate(source) : item?.[field] || '');
  }

  function normalizeCatalog(payload) {
    const iconValue = (item) => {
      const source = item && typeof item === 'object' ? item : {};
      const candidates = [source.icon, source.iconData,
        source.manifest && source.manifest.icon,
        source.body && source.body.icon,
        source.body && source.body.manifest && source.body.manifest.icon,
        source.metadata && source.metadata.icon,
        source.presentation && source.presentation.icon];
      return String(candidates.find(value => typeof value === 'string' && value.trim()) || '');
    };
    return (Array.isArray(payload && payload.items) ? payload.items : [])
      .filter((item) => item && item.pluginId && !isWorkspaceApp(item))
      .map((item) => ({
      pluginId: String(item && item.pluginId || ''),
      key: String(item && item.key || ''),
      // Applications share the catalog with conversation plugins, but the
      // slash picker is intentionally a plugin-only surface. Preserve the
      // marker so the boundary stays explicit in the normalized contract.
      template: String(item && item.template || '').trim().toLowerCase(),
      qualifiedKey: String(item && item.qualifiedKey || item && item.key || ''),
      scope: String(item && item.scope || ''),
      name: String(item && item.name || item && item.key || '企业插件'),
      builtIn: item.builtIn === true,
      locales: item.locales,
      icon: iconValue(item),
      description: String(item && item.description || ''),
      version: String(item && (item.conversationVersion || item.version) || ''),
      personal: Boolean(item && item.personal),
      installed: Boolean(item && (item.personal || item.installed)),
      updateAvailable: Boolean(item && item.updateAvailable),
      enabled: Boolean(item && (item.personal ? item.enabled !== false :
        item.installed)),
      audienceLimited: Boolean(item && item.audienceLimited),
      organizationWide: Boolean(item && item.organizationWide),
      projectCount: Math.max(0, Number(item && item.projectCount || 0)),
      workflow: Array.isArray(item && item.workflow) ? item.workflow : [],
      inputs: normalizePluginInputs(item && (item.conversationInputs || item.inputs)),
      process: item && item.process && typeof item.process === 'object' ? item.process : {},
      entrypoints: Object.assign({ conversation: true }, item && (item.conversationEntrypoints || item.entrypoints) || {}),
      capabilities: normalizeCapabilities(item && (item.conversationCapabilities || item.capabilities)),
      versionId: String(item && item.versionId || item && item.id || ''),
      marketPolicy: item && item.marketPolicy && typeof item.marketPolicy === 'object'
        ? Object.assign({}, item.marketPolicy) : {},
      setup: item && item.setup && typeof item.setup === 'object' ? item.setup : {},
      setupConfig: item && item.setupConfig && typeof item.setupConfig === 'object'
        ? item.setupConfig : {},
      setupState: String(item && item.setupState || ''),
      dependencyReadiness: item && item.dependencyReadiness &&
        typeof item.dependencyReadiness === 'object' ? item.dependencyReadiness : {},
      conversationUse: normalizeConversationUse(item),
    })).map((item) => {
      item.kind = pluginKind(item);
      item.searchText = searchable(item);
      return item;
    });
  }

  function catalogWarning(payload) {
    return String(payload && payload.remoteError || '').trim();
  }

  function retryableGrantFailure(payload) {
    return Boolean(payload && payload.kind === 'error' && payload.retrySafe === true &&
      payload.failureKind === 'plugin-grant' && String(payload.submissionId || '').trim());
  }

  return {
    normalizeActions, pluginBuilderAction, commandText, normalizePluginInputs,
    prepareConversationInputs, preparedConversationText, availability, pluginKind,
    normalizeCatalog, displayText, isWorkspaceApp, catalogWarning, retryableGrantFailure,
  };
});
