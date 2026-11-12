'use strict';
const context = require('./plugin-context');
const connectorTurn = require('./connector-turn.cjs');
const RESOURCE_BUNDLES = Symbol('trusted-plugin-resource-bundles');

// Resolve after dequeue so temporary authorization belongs only to the executing turn.
function requestedIds(turn) {
  const input = turn || {};
  return [...new Set((Array.isArray(input.pluginIds) ? input.pluginIds :
    (input.plugins || []).map(item => item && item.pluginId))
    .map(value => String(value || '').trim()).filter(Boolean))].slice(0, context.MAX_PLUGINS);
}

async function prepare(options, turn, cancelled = () => false, turnContext = {}) {
  const opts = options || {}, input = turn || {}, ids = requestedIds(input);
  let grant = null, connectors = null, cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { connectors?.cleanup(); } finally { grant?.cleanup?.(); }
  };
  const redact = value => {
    const text = connectors?.redact ? connectors.redact(value) : String(value || '');
    return grant?.redact ? grant.redact(text) : text;
  };
  try {
    let resolved = { items: [], resourceBundles: [] };
    // Explicit plugins require strict authorization; ordinary connector fallback must not hide plugin grant failures.
    if (ids.length) {
      if (typeof opts.resolvePlugins !== 'function')
        throw new Error('当前会话没有可用的插件授权解析器，请重新打开会话');
      resolved = await opts.resolvePlugins(ids, input.projectId || '', turnContext);
    }
    grant = resolved && resolved.grant || null;
    const plugins = context.compact(resolved && resolved.items);
    if (plugins.length !== ids.length || ids.some(id => !plugins.some(item => item.pluginId === id)))
      throw new Error('有插件在发送前已失效，请重新选择');
    const authorization = context.authorization(plugins, {
      capabilityIds: opts.capabilityIds, readOnly: opts.readOnly,
      mcpServers: grant && grant.servers,
    });
    if (!authorization.ok) {
      const error = new Error(authorization.reason);
      error.pluginAuthorization = authorization;
      throw error;
    }
    connectors = await connectorTurn.prepare(resolved.applicationUnavailable
      ? { ...opts, resolveConnectors: undefined } : opts, cancelled, grant?.servers || []);
    return { ok: true, plugins, resourceBundles: resolved.resourceBundles || [],
      badges: plugins.map(({pluginId, name, version, scopeLabel}) => ({pluginId, name, version, scopeLabel})),
      cleanup, redact, hasSecrets: Boolean(grant?.redact || connectors.hasSecrets),
      augment: text => connectors.augment(context.augment(text, plugins,
        [resolved.applicationGuide, grant?.guide].filter(Boolean).join('\n\n'), input.pluginInputs)),
    };
  } catch (error) {
    cleanup();
    return { ok: false, failureKind: 'plugin-grant',
      retrySafe: error && error.pluginAuthorization?.retrySafe !== false,
      reason: '插件没能在发送前完成授权：' + redact(error && error.message || error),
      ...(error && error.pluginAuthorization ? { pluginAuthorization: error.pluginAuthorization } : {}),
      cleanup, redact };
  }
}
module.exports = { prepare, requestedIds, RESOURCE_BUNDLES };
