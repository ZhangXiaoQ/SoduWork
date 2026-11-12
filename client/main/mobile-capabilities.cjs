'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { accountId } = require('./device-auth-request');
const plugins = require('./personal-plugins');
const { diskJournal } = require('./automation-conversations');
const { request } = require('./pi-session/task-input');
const capabilities = require('./conversation/capabilities');
const skillRoots = require('./conversation/skill-roots');

const fields = (row, keys) => Object.fromEntries(keys.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
const display = row => fields(row, ['id', 'pluginId', 'key', 'name', 'description', 'version', 'checksum',
  'builtIn', 'enabled', 'sourceKind', 'source', 'status', 'available', 'installed', 'listed', 'personal',
  'conversationUse', 'entrypoints', 'setupState', 'setupMessage', 'runtimeAvailable', 'portable', 'template', 'inputs', 'capabilities']);
const rows = value => Array.isArray(value) ? value : [];
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function create({ app, identityOf, conversation, pluginStore = plugins, fetchCatalog = request,
  library = require('./mobile-library.cjs').create({ app }),
  inspectSkills = identity => capabilities.inspect({ app, identity,
    skillDirs: skillRoots.discoverAsync(app), forcePolicy: true }),
  verifyRequest = (identity, body) => request(identity, '/desktop-capabilities/verify', body),
  journal = diskJournal(path.join(app.getPath('userData'), 'mobile-capability-receipts')) }) {
  let queue = Promise.resolve();
  const scope = identity => [identity?.hub, identity?.clientId, accountId(identity)];
  async function run(body) {
    if (!body || !['catalog', 'library.call', 'conversation.history', 'skill.set', 'plugin.get', 'plugin.preflight', 'plugin.install', 'plugin.use', 'plugin.prepare'].includes(body.operation)
        || !/^[A-Za-z0-9_-]{8,80}$/.test(body.requestId || '') || !body.args || Array.isArray(body.args)
        || typeof body.args !== 'object' || Buffer.byteLength(JSON.stringify(body)) > 512000) throw Error('操作内容不正确');
    const identity = await identityOf(app);
    if (!accountId(identity) || accountId(identity) !== body.ownerUserId || identity.clientId !== body.targetClientId)
      throw Error('电脑登录账号已变化，请重新选择本人电脑');
    const identityKey = JSON.stringify(scope(identity));
    async function guard(verify = false) {
      if (!Number.isFinite(body.expiresAt) || body.expiresAt * 1000 <= Date.now()) throw Error('操作等待过久，未继续执行；请刷新后重试');
      if (JSON.stringify(scope(await identityOf(app))) !== identityKey) throw Error('账号或服务已切换，请重新操作');
      if (verify) {
        const result = await verifyRequest(identity, { authorization: body.authorization,
          request: fields(body, ['requestId', 'operation', 'args', 'targetClientId', 'ownerUserId']) });
        if (result?.ok !== true) throw Error('电脑操作授权未确认');
        if (JSON.stringify(scope(await identityOf(app))) !== identityKey) throw Error('账号或服务已切换，请重新操作');
      }
    }
    await guard(true);
    const args = body.args;
    if (body.operation === 'conversation.history') {
      if (typeof conversation.history !== 'function') throw Error('请更新并重启这台电脑的 SoduWork');
      const result = await conversation.history(args, guard);
      await guard(true);
      return result;
    }
    if (body.operation === 'library.call') {
      const result = await library(args, body.requestId, () => guard(true));
      await guard(true);
      return result;
    }
    async function skillCatalog() {
      const [data, runtime] = await Promise.all([fetchCatalog(identity, '/capabilities'), inspectSkills(identity)]);
      await guard();
      if (runtime?.ok !== true) throw Error('电脑技能状态暂时无法读取，请刷新重试');
      const local = new Map([...rows(runtime.items).map(item => ({ name: item.skillName, installed: item.available })),
        ...rows(runtime.businessSkills)].map(item => [item.name, item]));
      // Match the desktop capability center's selectable catalog, not every Hub directory entry.
      return rows(data.skills).filter(item => item.available && (item.portable || item.runtimeAvailable ||
        local.get(item.name)?.installed || local.get(item.name)?.installState === 'remote'))
        .map(item => ({ ...display(item), installed: !!(item.runtimeAvailable || local.get(item.name)?.installed) }));
    }
    const checkVersion = raw => {
      const key = raw ? pluginStore.build(raw).body.key : null;
      const existing = pluginStore.catalog(app, true).find(row => args.pluginId ? row.pluginId === args.pluginId : row.key === key);
      if (args.pluginId) {
        if (!existing || existing.checksum !== args.expectedChecksum || (raw && existing.key !== key))
          throw Error('电脑上的插件已有变化，请重新打开后编辑');
        if (raw && existing.builtIn) throw Error('内置插件不能覆盖，请创建自己的插件');
      } else if (existing) throw Error('电脑上已有同名插件，请从该插件进入编辑');
      return existing;
    };
    const shared = pluginStore.service({ app, identityOf, beforeWrite: () => guard(true), validateWrite: checkVersion });
    if (body.operation === 'plugin.prepare') {
      return require('./mobile-plugin-turn.cjs').prepare({ app, pluginStore, shared,
        args, context: body._turnContext, guard });
    }
    if (body.operation === 'catalog') {
      const result = { plugins: pluginStore.catalog(app, true).map(display), skills: [], connectors: [], market: [], errors: {} };
      // Partial failures remain visible; an unavailable remote catalog is never shown as a confirmed empty list.
      for (const [section, route] of [['skills', '/capabilities'], ['connectors', '/mcp-servers'], ['market', '/plugins/catalog']]) {
        try {
          if (section === 'skills') { result.skills = await skillCatalog(); continue; }
          const data = await fetchCatalog(identity, route);
          if (section === 'connectors') result.connectors = [...rows(data.personal), ...rows(data.company)].map(display);
          if (section === 'market') result.market = rows(data.items).filter(row => row.personal !== true && row.listed !== false).map(display);
        } catch (error) { result.errors[section] = error.message || '目录暂时无法读取'; }
        await guard();
      }
      await guard(); return result;
    }
    if (body.operation === 'plugin.get') {
      const plugin = await shared.get(args.pluginId);
      await guard();
      if (!plugin) throw Error('插件不存在');
      return { plugin: { ...display(plugin), localDraft: plugin.localDraft } };
    }
    if (body.operation === 'plugin.preflight') {
      checkVersion(args.draft);
      const result = await shared.preflight(args.draft);
      await guard(); return result;
    }
    const key = hash([scope(identity), body.requestId]);
    const digest = hash([body.operation, args]);
    const old = journal.read(key);
    if (old) {
      if (old.digest !== digest) throw Error('操作编号已使用，请核对原操作');
      if (old.result) return old.result;
      throw Error(old.error || '上次操作结果尚未确认，请到电脑或目录核对；不会重复执行');
    }
    await guard();
    if (body.operation === 'skill.set') {
      if (typeof args.name !== 'string' || typeof args.enabled !== 'boolean' || Object.keys(args).some(key => !['name', 'enabled'].includes(key)))
        throw Error('技能开关内容不正确');
      if (!(await skillCatalog()).some(row => row.name === args.name)) throw Error('这项技能当前不可用，请刷新目录');
    } else if (body.operation === 'plugin.install') checkVersion(args.draft);
    else {
      checkVersion(null);
      if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 50000) throw Error('请填写本次要完成的工作');
      if (args.modelName !== undefined && (typeof args.modelName !== 'string' || args.modelName.length > 160 || /[\x00-\x1f]/.test(args.modelName)))
        throw Error('执行模型不正确');
    }
    // The fence survives crashes and lost network replies. Retrying this ID only reads the receipt.
    journal.write(key, { digest });
    try {
      let result;
      if (body.operation === 'skill.set') {
        await guard(true);
        result = await fetchCatalog(identity, '/desktop-capabilities/skill-selection', { authorization: body.authorization,
          request: fields(body, ['requestId', 'operation', 'args', 'targetClientId', 'ownerUserId']) });
        if (result?.ok !== true || result.name !== args.name || result.enabled !== args.enabled)
          throw Error('技能设置未确认，请刷新目录核对');
      } else if (body.operation === 'plugin.install') result = await shared.create(args.draft);
      else {
        const plugin = await shared.use(args.pluginId);
        await guard(); checkVersion(null);
        if (!plugin?.conversationUse?.available) throw Error(plugin?.conversationUse?.reason || '插件尚未启用或需要在电脑完成设置');
        const opened = await conversation.open({ intent: 'chat', adapterId: 'pi', modelName: args.modelName || '',
          sessionTitle: plugin.name, pluginLock: fields(plugin, ['pluginId', 'version', 'checksum']) }, identity);
        if (!opened?.ok) throw Error(opened?.reason || '电脑未能创建会话');
        await guard(true);
        const sent = await conversation.send(opened.ref, args.text, [], { source: 'mobile-plugin',
          submissionId: 'mobile-' + body.requestId, plugins: [{ pluginId: plugin.pluginId }] });
        if (!sent?.ok) throw Error(sent?.reason || '电脑未接收这次工作');
        await conversation.sync?.();
        result = { ok: true, sourceSessionId: opened.sessionId, sourceClientId: identity.clientId };
      }
      journal.write(key, { digest, result });
      await guard(); return result;
    } catch (error) {
      journal.write(key, { digest, error: String(error.message || error) });
      throw error;
    }
  }
  return body => {
    // Serialize against other mobile mutations, then recheck the current PC version just before writing.
    const pending = queue.then(() => run(body));
    queue = pending.catch(() => {});
    return pending;
  };
}
module.exports = { create, display };
