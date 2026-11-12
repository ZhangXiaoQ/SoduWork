/* Matching is presentation/selection only; Hub and the native runtime still authorize every turn. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RequirementSessionContext = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';
  const text = value => String(value || '').trim();
  function folder(value) {
    const raw = text(value).replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[a-z]:\//i.test(raw) || raw.startsWith('//') ? raw.toLowerCase() : raw;
  }
  function scope(value) {
    const item = value || {}, context = item.executionContext || item.workRouting?.executionContext || {};
    const projectId = text(item.requirementContext?.projectId || item.projectId || item.project?.id || context.projectId);
    return { projectId: /^project-/.test(projectId) ? '' : projectId,
      repoId: text(item.requirementContext?.repoId || item.repoId || item.repo?.id || context.repoId || context.repo?.id),
      cwd: folder(item.cwd || item.repo?.path || context.repo?.path),
      projectName: text(item.projectName || item.project?.name || context.projectName),
      repoName: text(item.repoName || item.repo?.name || context.repo?.name) };
  }
  function relation(task, session) {
    const a = scope(task), b = scope(session);
    if (a.projectId && b.projectId && a.projectId !== b.projectId) return 'other';
    if (a.repoId && b.repoId && a.repoId !== b.repoId) return 'other';
    if (a.cwd && b.cwd && a.cwd !== b.cwd) return 'other';
    if (a.repoId && a.repoId === b.repoId || a.cwd && a.cwd === b.cwd) return 'repo';
    if (a.projectId && a.projectId === b.projectId) return 'project';
    return 'unbound';
  }
  function compatibility(task, session) {
    const row = task || {}, current = session || {}, ec = row.executionContext || row.workRouting?.executionContext || {};
    if (current.cloudHandoff) return '当前会话已转到云端，请在需求池安排执行';
    if (relation(row, current) === 'other') return '所属项目或工程不同，请选择对应会话';
    const binding = row.workRouting?.conversationTurn;
    if (binding?.conversationId && binding.conversationId !== current.sessionId &&
      !['cancelled', 'canceled', 'failed', 'stopped', 'interrupted'].includes(binding.state)) return '该需求已关联其他会话，请打开原会话';
    if (row.workflowBindingId || ec.workflowBindingId || ec.workflowId || ec.strategy === 'workflow' ||
      row.workRouting?.selectedStrategy === 'workflow' || ec.assigneeType === 'squad' ||
      ec.runner?.mode === 'remote' || ec.runner?.remote || ec.location?.mode === 'remote') return '此需求使用远程或工作流执行，请在需求池安排';
    const agent = text(ec.agent?.id || ec.agent?.key || ec.agentId || row.agentId || ec.agentKind || ec.agent?.cli);
    if (agent.startsWith('runner:')) return '此需求使用远程执行，请在需求池安排';
    if (agent && current.adapterId && agent.replace(/^local:/, '') !== current.adapterId) return '执行 Agent 与当前会话不同，请选择对应会话';
    const model = text(ec.model || row.model);
    if (model && current.model && model !== current.model) return '执行模型与当前会话不同，请先核对模型';
    return '';
  }
  function candidates(task, history, current, lookup) {
    const seen = new Set(), result = [];
    for (const row of [current, ...(history || [])]) {
      if (!row) continue;
      const id = text(row.sessionId || row.id); if (!id || seen.has(id) || row.archivedAt) continue;
      seen.add(id);
      const index = lookup?.(id), related = (index?.tasks || []).find(t => ['project','repo'].includes(relation(task,t)));
      const own = scope(row), inherited = scope(related);
      const candidate = { ...row, ...own, cwd: row.cwd || '', sessionId: id,
        projectId: own.projectId || inherited.projectId, repoId: own.repoId || inherited.repoId };
      // Do not propose an arbitrary recent chat just because it has no project.
      if (!['project','repo'].includes(relation(task,candidate))) continue;
      const reason = compatibility(task,candidate);
      result.push({ ...candidate, title: text(row.title || row.taskTitle || related?.title) || '项目会话',
        current: id === current?.sessionId, reason });
    }
    return result.sort((a,b) => Number(b.current)-Number(a.current) || Number(b.at || 0)-Number(a.at || 0));
  }
  function executionRuntime(task, sessionId, executions) {
    // Finished requirements use the selected conversation runtime for ordinary
    // follow-ups, matching task-input's TASK_FINISHED fallback in the main process.
    if (task?.status === 'done' || task?.status === 'cancel') return '';
    const receipt = task?.workRouting?.conversationTurn;
    // Only the requirement bound to this conversation can describe its next
    // controlled turn. Never relabel the local archive or another task's host.
    if (!task?.id || !sessionId || receipt?.conversationId !== sessionId || receipt.executor !== 'dispatch') return '';
    const active = (executions || []).find(row => row.taskId === task.id && row.executor === 'dispatch');
    const context = task.executionContext || task.workRouting?.executionContext || {};
    const actual = active?.run?.activeExecutionSelection?.agentId || active?.run?.engine || active?.run?.cli;
    const assigned = context.agent?.id || context.agent?.key || context.agentId || task.agentId || context.agent?.cli;
    const value = text(actual || assigned);
    const id = value.startsWith('runner:') ? value.split(':').pop() : value.replace(/^local:/, '');
    return /^[a-z][a-z0-9-]{0,39}$/.test(id) ? id : '';
  }
  return { scope, folder, relation, compatibility, candidates, executionRuntime };
});
