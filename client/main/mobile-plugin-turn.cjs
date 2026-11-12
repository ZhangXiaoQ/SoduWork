'use strict';

// Called only through the owning Runner's private pipe with a Hub-signed
// selection. Reuse desktop resolution and authorization; never accept a prompt,
// plugin body, resource path or capability grant from the mobile renderer.
async function prepare({ app, pluginStore, shared, args, context, guard }) {
  const selected = args.plugins;
  if (!Array.isArray(selected) || !selected.length || selected.length > 3 ||
      !context || context.ref !== args.ref || typeof context.cwd !== 'string' || !context.cwd)
    throw Error('原会话的插件上下文不匹配');
  const verify = async () => {
    await guard(true);
    const catalog = pluginStore.catalog(app, true);
    for (const row of selected) {
      const current = catalog.find(item => item.pluginId === row.pluginId);
      if (!current || current.checksum !== row.checksum || current.enabled === false)
        throw Error('电脑上的插件版本已变化，请重新选择插件');
      const usable = await shared.use(row.pluginId);
      if (!usable?.conversationUse?.available) throw Error(usable?.conversationUse?.reason || '插件当前不可用');
    }
  };
  await verify();
  const prepared = await require('./pi-session/plugin-turn').prepare({
    capabilityIds: context.capabilityIds || [], readOnly: context.readOnly === true,
    resolvePlugins: async ids => pluginStore.resolve(app, ids, { cwd: context.cwd }),
  }, { plugins: selected });
  try {
    if (!prepared.ok) throw Error(prepared.reason);
    await verify();
    return { promptText: prepared.augment(context.text), plugins: prepared.badges,
      resourceBundles: prepared.resourceBundles };
  } finally { prepared.cleanup(); }
}

module.exports = { prepare };
