'use strict';

// Resolve a formal requirement through its authoritative execution, not a
// same-title local creation/review conversation. This never dispatches work.
const PREFIX = 'task-execution:';
const text = value => String(value || '').trim();
function taskId(sessionId) {
  if (!String(sessionId || '').startsWith(PREFIX)) return '';
  const id = String(sessionId).slice(PREFIX.length);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw Error('需求执行记录标识无效');
  return id;
}
async function resolve(sessionId, identity, request) {
  const id = taskId(sessionId);
  if (!id) return null;
  const route = '/tasks/' + encodeURIComponent(id);
  const task = await request(identity, route);
  const context = task?.workRouting?.executionContext || {};
  const runnerId = text(context.runner?.runnerId);
  if (task?.id !== id || task.canViewExecution === false ||
      !['requirement', 'bug', 'ticket', 'improvement', 'other'].includes(task.kind) ||
      context.location?.mode !== 'remote' || !runnerId) {
    throw Error('这条需求的远程执行位置已变化或无权查看，请刷新需求后重试');
  }
  const page = await request(identity, route + '/ai-session?since=0&limit=1');
  if (page?.ok === false || page.taskId !== id || !text(page.ref) ||
      text(page.runnerId) !== runnerId || page.executionContext?.location?.mode !== 'remote') {
    throw Error('远程执行记录尚未就绪或归属不一致，请稍后重试');
  }
  const frozen = page.executionContext || {};
  const workflow = Boolean(page.workflowRunId || task.workRouting?.selectedStrategy === 'workflow');
  return {
    sessionId, taskId: id, ref: page.ref, title: task.title,
    at: page.updatedAt || page.createdAt, adapterId: page.engine || frozen.agent?.cli || 'pi',
    model: page.model || '', remoteState: page.status,
    activeExecutionSelection: page.activeExecutionSelection,
    workflow, canSend: page.canSend === true && !workflow,
    canContinue: page.canSend === true && !workflow,
    target: { runnerId, runnerName: page.host || frozen.runner?.host || context.runner?.host || runnerId,
      // The session owner client may be the requesting mobile device. Only
      // the frozen runner binding identifies a personal work computer.
      runnerKind: text(frozen.runner?.clientId) ? 'work-computer' : 'cloud', agentId: page.engine || frozen.agent?.cli || 'pi',
      model: page.model || '' },
  };
}
module.exports = { taskId, resolve };
