'use strict';

// Form archives have not started an agent. Resolve runtime and permissions on first send, then restore normal session state thereafter.
const fs = require('node:fs');
const preferences = require('../access-control/preferences');
const segments = require('./runtime-segments');
const { scopeMatches, connectionScope } = require('../platform-connections/runtime.cjs');

function prepare(app, options, resume, identity, interactive, historySource) {
  if (!resume?.workOnly) return { first: false, accessOptions: options };
  require('./session-memory').binding(app, resume.id, identity);
  if (!resume.workOwner || !scopeMatches(resume.workOwner, identity, require('../device-auth').profiles(app)))
    throw Error('这条工作表单会话属于另一个账号');
  const entries = fs.readFileSync(resume.path, 'utf8').split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const started = entries.some(item => item.type === 'custom' && item.customType === 'soduwork.access.policy');
  if (started) {
    if (options.adapterId && options.adapterId !== (resume.adapterId || 'pi'))
      throw Error('这条会话已经初始化过执行底座，请先接回会话，再使用 Agent 选择器切换');
    return { first: false, accessOptions: options };
  }
  // Omit chatId only for new-execution defaults and one-time grants; the archive retains conversation identity.
  const accessOptions = preferences.forNewChat(app, { ...options, chatId: undefined }, interactive);
  const adapterId = String(options.adapterId || 'pi');
  // Only a never-bound Pi draft can acquire its first task from a saved creation
  // receipt. Existing archives must still pass the runtime's task binding check.
  const createdTaskId = adapterId === 'pi' && options.requireTaskBinding &&
    !entries.some(item => item.type === 'custom' && item.customType === 'soduwork.task.binding')
    ? String(options.taskRef || '').trim() : '';
  let validated = false;
  return { first: true, accessOptions, adapterId, bindCreatedTask: Boolean(createdTaskId),
    bootstrap: adapterId === 'pi' ? null : { id: resume.id, path: resume.path, cwd: resume.cwd,
      title: require('./titles').decorate(app, resume).title, owner: resume.workOwner },
    async validate({ identityOf, event, request }) {
      if (createdTaskId) {
        await require('./work-conversation-cards').assertCreatedTask(app, resume.id, createdTaskId, identity);
        if (typeof request !== 'function') throw Error('无法确认需求归属，请重新打开后重试');
        const task = await request('/tasks/' + encodeURIComponent(createdTaskId));
        if (task?.id !== createdTaskId || !identity.clientId || task.ownerClientId !== identity.clientId ||
            task.readOnly || task.canViewExecution === false)
          throw Error('当前账号或设备无权在此会话中执行这项需求');
        const idle = new Set(['', 'failed', 'cancelled', 'canceled', 'stopped', 'interrupted']);
        if (task.status !== 'todo' || task.archivedAt || task.requirementStage === 'reviewing' ||
            ['intake', 'clarifying'].includes(task.triageStage) ||
            [task.workRouting?.conversationTurn?.state, task.ai?.state, task.ai?.executionState]
              .some(state => !idle.has(String(state || '').toLowerCase())))
          throw Error('这项需求已开始执行或状态已变化，请刷新需求后重试');
      }
      if (event && !preferences.isTrusted(event)) throw Error('原会话窗口已经关闭，本次执行未启动');
      const current = await identityOf(app);
      if (!current || connectionScope(current) !== connectionScope(identity)) throw Error('账号或服务已切换，本次执行未启动');
      // After initial attachment to another runtime, the public index points to its active segment while ownership remains rooted in the original Pi archive.
      const source = historySource || require('../agent-runtime/process-session');
      const latest = (await source.historyEntry(app, resume.id)).entry;
      // Pi initialization writes permission metadata to the original archive; do not mistake that write for another conversation.
      // Other runtimes attach only to uninitialized archives; real messages disable the first-attachment path.
      if (!latest?.workOwner || latest.path !== resume.path || latest.count ||
          ((adapterId !== 'pi' || (createdTaskId && !validated)) && !latest.workOnly))
        throw Error('工作表单会话已删除或发生变化，请重新打开');
      if (!scopeMatches(latest.workOwner, current, require('../device-auth').profiles(app))) throw Error('这条工作表单会话属于另一个账号');
      validated = true;
    },
  };
}

async function applyPolicy({ app, event, options, resume, work, cwd, automationContext, accessConsent, BrowserWindow, confirmFullAccess }) {
  if ((resume && !work.first) || !options.accessMode) { delete options.accessPolicy; return { ok: true }; }
  const support = require('../agent-runtime/runtime-catalog').runtime(options.adapterId || 'pi')?.accessControl;
  if (!support?.supported || !support.modes.includes(options.accessMode))
    return { ok: false, reason: '当前底座暂不支持新权限模式，请选择兼容权限或其他底座' };
  if (options.accessMode === 'full') {
    const allowed = await require('../access-control/automation-access').confirmFull({ app, event,
      options: work.accessOptions, context: automationContext, consent: accessConsent, BrowserWindow, confirm: confirmFullAccess });
    if (!allowed.ok) return allowed;
  }
  options.accessPolicy = require('../access-control/policy').create(options.accessMode, cwd);
  return { ok: true };
}

// Use the existing runtime-switch manifest to connect the empty Pi archive with the selected runtime without converting archive formats.
function bootstrapRecord(work, raw, options) {
  if (!work || segments.read(options.app, work.id)) throw Error('会话执行方式已变化，请重新打开');
  if (!scopeMatches(work.owner, options.identity, require('../device-auth').profiles(options.app))) throw Error('这条会话属于另一个账号');
  const snapshot = raw.snapshot();
  const nativeDispatchId = raw.historyRow?.()?.nativeDispatchId;
  return { version: 1, id: work.id, owner: segments.scope(options.identity), title: work.title || '工作记录',
    cwd: work.cwd, originAdapter: 'pi', at: Date.now(), prefix: { messages: [], tools: [] },
    accessPolicy: snapshot.accessPolicy || options.accessPolicy, readOnly: options.readOnly,
    activePluginIds: snapshot.activePlugins || [],
    segments: [{ sessionId: work.id, adapterId: 'pi', path: work.path }],
    active: { sessionId: raw.sessionId, adapterId: raw.adapterId, ref: raw.ref,
      ...(nativeDispatchId ? { nativeDispatchId } : {}),
      path: raw.resumeLocation?.() || raw.sessionId, modelName: snapshot.modelSelection?.name || options.modelName || '', started: false } };
}
module.exports = { prepare, applyPolicy, bootstrapRecord };
