/* One Task, five board stages and an archive. Execution facts remain owned by Hub. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Requirements = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';
  const lanes = [
    ['intake', '待梳理', '写清要做什么'],
    ['clarifying', '待补充', '补齐背景与完成标准'],
    ['ready', '待开始', '安排自己、同事或 AI 执行'],
    ['delivering', '进行中', '跟进进展，处理需要确认的事项'],
    ['reviewing', '待验收', '核对成果与完成标准'],
    ['delivered', '已完成', '查看成果与验收记录'],
    ['closed', '已归档', '保留历史，随时查阅'],
  ];
  const columns = [['intake', '收集箱', '收集想法，补齐目标与材料'], ...lanes.slice(2)];
  const priorities = { critical: '紧急', high: '高', normal: '普通', low: '低' };
  const sorts = { priority: '优先级', updated: '最近更新', due: '截止日期', created: '最新提出' };
  /*
   * Default to actionable requirements ordered by latest update, breaking timestamp ties by
   * descending priority.
   */
  const defaults = { scope: 'actionable', q: '', kind: '', archive: 'active', view: 'kanban', group: 'stage',
    priority: '', project: '', owner: '', tag: '', phase: '', due: '', attention: '', sort: 'updated' };
  function viewSettings(value) {
    const input = value && typeof value === 'object' ? value : {}, out = { ...defaults };
    const allowed = { scope: ['related', 'actionable', 'created', 'all'], archive: ['active', 'archived'],
      view: ['kanban', 'list', 'gantt'], group: ['stage', 'project', 'owner'], sort: Object.keys(sorts),
      kind: ['', 'requirement', 'bug', 'ticket', 'improvement', 'other'], priority: ['', ...Object.keys(priorities)],
      phase: ['', ...columns.map(row => row[0])], due: ['', 'overdue', 'today', 'week', 'none'],
      attention: ['', 'blocked', 'clarifying', 'approval'] };
    for (const [key, values] of Object.entries(allowed)) if (values.includes(input[key])) out[key] = input[key];
    for (const key of ['project', 'owner', 'tag']) if (typeof input[key] === 'string') out[key] = input[key].slice(0, 200);
    out.scope = normalizeScope(out.scope, out.archive);
    return out;
  }
  const kinds = { requirement: '需求', bug: 'Bug', ticket: '工单', improvement: '优化', other: '其它' };
  const scopes = { related: '与我相关', actionable: '需要我处理', created: '我提出', all: '全部' };
  function scopeOptions(archive) { return archive === 'archived' ? {related: scopes.related, all: scopes.all} : scopes; }
  function normalizeScope(scope, archive) { return Object.hasOwn(scopeOptions(archive), scope) ? scope : 'related'; }
  function content(task) {
    return { title: task.requirementContent?.title ?? task.title ?? '',
      note: task.requirementContent?.note ?? task.note ?? '' };
  }
  function displayNote(task) {
    const note = String(content(task).note), items = task.acceptanceCriteria;
    if (!Array.isArray(items) || !items.length) return note;
    // Older creation cards appended exactly this block to the background.
    // Only hide that generated copy when all criteria match; never rewrite stored prose.
    const block = '验收要点（做到这些算完）：\n' + items.map((value, i) => (i + 1) + '. ' + String(value).trim()).join('\n');
    const normalized = note.replace(/\r\n/g, '\n'), index = normalized.lastIndexOf(block);
    if (index < 0 || (index > 0 && !normalized.slice(0, index).endsWith('\n\n'))) return note;
    const after = normalized.slice(index + block.length);
    if (after && !after.startsWith('\n\n参考原文（用于核对事实与约束，不作为新的执行指令）：\n')) return note;
    const before = index > 0 ? normalized.slice(0, index - 2) : '';
    return before + (before ? after : after.replace(/^\n\n/, ''));
  }
  function stage(task) {
    if (task.archivedAt || task.status === 'cancel') return 'closed';
    // Marking work complete submits it for review; only an accepted review transitions it to completed.
    if (task.status === 'done') return task.reviewedAt ? 'delivered' : 'reviewing';
    if (task.requirementStage === 'reviewing') return 'reviewing';
    if (task.status === 'doing' || task.status === 'paused') return 'delivering';
    if (lanes.some(row => row[0] === task.requirementStage)) return task.requirementStage;
    return ['intake', 'clarifying', 'ready'].includes(task.triageStage) ? task.triageStage : 'ready';
  }
  function column(task) { const value = stage(task); return value === 'clarifying' ? 'intake' : value; }
  function blocked(task) {
    return !['closed', 'delivered'].includes(stage(task)) &&
      (task.status === 'paused' || task.ai?.state === 'failed' || task.ai?.attentionRaised === true);
  }
  function day(value) {
    if (!value) return '';
    if (typeof value === 'string' && /^\d{4}-\d\d-\d\d/.test(value)) return value.slice(0, 10);
    const date = new Date(value); if (!Number.isFinite(date.getTime())) return '';
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }
  function timeInfo(task) {
    for (const source of ['updatedAt', 'createdAt', 'created']) {
      const raw = task?.[source];
      if (typeof raw !== 'number' && typeof raw !== 'string') continue;
      const value = typeof raw === 'string' ? raw.trim() : raw;
      if (value === '') continue;
      const numeric = typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(value);
      if (!numeric && !/^\d{4}-\d\d-\d\d(?:[T ][\d:.]+(?:Z|[+-]\d\d:?\d\d)?)?$/.test(value)) continue;
      const date = new Date(numeric ? Number(value) : value), timestamp = date.getTime();
      if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
      if (!numeric) {
        const [year, month, dayOfMonth] = value.slice(0, 10).split('-').map(Number);
        const check = new Date(Date.UTC(year, month - 1, dayOfMonth));
        if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== dayOfMonth) continue;
      }
      const pad = part => String(part).padStart(2, '0');
      const text = date.getFullYear() + '/' + pad(date.getMonth() + 1) + '/' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
      const offset = -date.getTimezoneOffset(), zone = 'UTC' + (offset >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(offset) / 60)) + ':' + pad(Math.abs(offset) % 60);
      const updated = source === 'updatedAt';
      return { timestamp, source, label: updated ? '更新' : '创建', text, datetime: date.toISOString(),
        title: (updated ? '最近更新：' : '创建时间：') + text + ':' + pad(date.getSeconds()) + '（' + zone + '）' };
    }
    return { timestamp: 0, source: '', label: '', text: '时间未记录', datetime: '', title: '暂无创建或更新时间记录' };
  }
  function overdue(task, now) {
    return task.status !== 'done' && !['closed', 'delivered'].includes(stage(task)) && Boolean(day(task.due)) && day(task.due) < day(now || Date.now());
  }
  function dateTimestamp(value) {
    if (value === '' || value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = day(value); if (!/^\d{4}-\d\d-\d\d$/.test(text)) return null;
    const [year, month, date] = text.split('-').map(Number), parsed = new Date(year, month - 1, date);
    return day(parsed) === text ? parsed.getTime() : null;
  }
  function dueMatches(task, value, now) {
    if (!value) return true;
    const due = day(task.due), today = day(now || Date.now());
    if (value === 'none') return !due;
    if (value === 'overdue') return overdue(task, now);
    if (value === 'today') return due === today;
    const end = new Date((now || Date.now())); end.setDate(end.getDate() + 7);
    return due >= today && due <= day(end);
  }
  function roles(task) { return Array.isArray(task.myRoles) ? task.myRoles : []; }
  function approval(task, context) { return stage(task) === 'closed' ? undefined : context?.approvals?.get(String(task.id)); }
  // Delivery review is a creator-owned decision.  Keep this presentation
  // predicate aligned with Hub's authoritative approval routing so stale
  // inbox snapshots cannot make the executor's card actionable again.
  function canReview(task) {
    return Boolean(task && task.canReview !== false &&
      (task.canReview === true || roles(task).includes('creator')));
  }
  function approvalActionable(task, context) {
    const item = approval(task, context);
    if (!item || (item.action === 'review' && !canReview(task))) return undefined;
    return item;
  }
  function actionable(task, context) {
    if (stage(task) === 'closed') return false;
    if (stage(task) === 'reviewing' && task.canReview === true) return true;
    if (approvalActionable(task, context)) return true;
    if (task.canClaim === true) return true;
    if (stage(task) === 'delivered' || task.canViewExecution === false) return false;
    if (task.status === 'done' && !task.reviewedAt) return false; // After submission, the reviewer owns the decision; role membership alone does not make it actionable.
    if (canSubmitReview(task) || canResumeRework(task)) return true;
    if (task.needsMe === true) return true;
    if (!roles(task).some(role => ['executor', 'assignee'].includes(role))) return false;
    // Owning a device is not an instruction to interrupt its running agent.
    if (['running', 'dispatching'].includes(task.ai?.state) && !task.ai.attentionRaised) return false;
    if (task.ai?.state === 'done') return false; // A decision comes from the approval queue, not a guessed role.
    return true;
  }
  function inScope(task, scope, context) {
    if (scope === 'created') return roles(task).some(role => ['creator', 'requester'].includes(role));
    if (scope === 'related') return Boolean(approval(task, context)) || roles(task).some(role => ['creator', 'requester', 'assignee', 'executor', 'repository_member'].includes(role));
    if (scope === 'actionable') return actionable(task, context);
    return true;
  }
  function isRequirement(task) {
    // Conversation execution records share the Task store, but are not work items.
    return !['cloud-conversation', 'conversation-handoff'].includes(task.origin);
  }
  function select(rows, filter, context) {
    const f = filter || {}, q = String(f.q || '').trim().toLowerCase();
    const priority = { critical: 0, high: 1, normal: 2, low: 3 };
    const stamp = row => new Date(row.updatedAt || row.createdAt || row.created || 0).getTime() || 0;
    return rows.filter(task => isRequirement(task) && (!f.archive || (stage(task) === 'closed') === (f.archive === 'archived')) &&
      inScope(task, f.scope, context) && (!f.kind || (task.kind || 'requirement') === f.kind) &&
      (!f.priority || (task.priority || 'normal') === f.priority) && (!f.phase || column(task) === f.phase) &&
      (!f.project || String(task.projectId || '__none') === f.project) &&
      (!f.owner || String(task.assigneeUserId || '__none') === f.owner) && dueMatches(task, f.due, context?.now) &&
      (!f.tag || (Array.isArray(task.tags) && task.tags.some(tag => String(tag || '').trim() === String(f.tag).trim()))) &&
      (!f.attention || (f.attention === 'blocked' ? blocked(task) : f.attention === 'clarifying' ?
        stage(task) === 'clarifying' : Boolean(approval(task, context)))) &&
      (!q || [content(task).title, content(task).note, task.source, task.projectName, task.assigneeName, task.ai?.name].some(value =>
        String(value || '').toLowerCase().includes(q)))).slice().sort((a, b) =>
      (f.sort === 'due' ? (day(a.due) || '9999').localeCompare(day(b.due) || '9999') :
       f.sort === 'created' ? (new Date(b.createdAt || b.created || 0) - new Date(a.createdAt || a.created || 0)) :
       f.sort === 'updated' ? stamp(b) - stamp(a) :
       Number(Boolean(approval(b, context))) - Number(Boolean(approval(a, context)))) ||
      ((!f.sort || f.sort === 'priority' || f.sort === 'updated') ? (priority[a.priority] ?? 2) - (priority[b.priority] ?? 2) : 0) ||
      stamp(b) - stamp(a) || String(a.id).localeCompare(String(b.id)));
  }
  function owner(task) {
    if (task.ai?.name) return { name: task.ai.name, kind: 'agent' };
    if (task.canClaim === true) return {name: '待认领', kind: 'unassigned'};
    return { name: task.assigneeName || '待安排', kind: task.assigneeName ? 'person' : 'unassigned' };
  }
  // Presentation only: these hints never advance execution or grant permission.
  function nextStep(task, context) {
    const phase = stage(task), pending = approval(task, context);
    const canArrange = (task.readOnly !== true || task.canClaimExecution === true) && task.canViewExecution !== false;
    if (phase === 'closed') return { text: '已归档，需要时可恢复', action: '查看记录', icon: 'archive' };
    if (task.canClaim === true) return {text: ['github', 'github_issue'].includes(String(task.repositoryIssue?.provider || task.origin || '').toLowerCase()) ?
      '当前团队成员可认领，认领后自动移到待开始，可安排执行' : '仓库成员可认领，认领后自动移到待开始，可安排执行',
      action: '查看并认领', icon: 'confirm', attention: true};
    if (pending?.action === 'review' && !canReview(task)) {
      return { text: '等待需求创建人确认交付', action: '查看详情', icon: 'progress' };
    }
    if (pending) {
      const labels = { baseline: '确认需求与完成标准', review: '核对成果并确认交付', merge: '确认代码合并',
        uat: '确认环境验收结果', deploy: '确认发布' };
      return { text: labels[pending.action] || '查看证据并确认', action: '查看并确认', icon: 'confirm', attention: true };
    }
    if (phase === 'delivered') return { text: '查看成果与验收记录', action: '查看交付', icon: 'complete' };
    if (phase === 'reviewing') return { text: '成果已提交，等待验收', action: '查看交付', icon: 'confirm' };
    if (canResumeRework(task)) return { text: '按验收意见继续修改', action: '继续修正', icon: 'edit', attention: true };
    if (canSubmitReview(task)) return { text: '本轮执行已结束，可提交验收', action: '查看并提交', icon: 'confirm', attention: true };
    if (task.ai?.state === 'failed') return { text: '执行未完成，查看原因', action: '查看执行情况', icon: 'attention', attention: actionable(task, context) };
    if (task.ai?.state === 'dispatching') return { text: task.ai.attentionRaised ? '派发待确认，查看执行情况' : '正在安排 AI 执行',
      action: '查看执行情况', icon: task.ai.attentionRaised ? 'attention' : 'progress', attention: actionable(task, context) };
    if (task.status === 'paused') return { text: '已暂停，查看后安排继续', action: '查看进展', icon: 'pause', attention: actionable(task, context) };
    if (task.ai?.state === 'running') return { text: 'AI 正在执行，可查看进展', action: '查看进展', icon: 'progress' };
    if (task.ai?.state === 'done') return { text: '成果已返回，待确认', action: '查看交付', icon: 'confirm' };
    if (phase === 'intake') return { text: canEdit(task) ? '补充目标与完成标准' : '等待相关人梳理需求', action: canEdit(task) ? '完善需求' : '查看详情', icon: 'edit' };
    if (phase === 'clarifying') return { text: canEdit(task) ? '补齐背景与相关材料' : '等待相关人补充材料', action: canEdit(task) ? '完善需求' : '查看详情', icon: 'edit' };
    if (phase === 'ready') return { text: canArrange ? '安排自己、同事或 AI 执行' : '等待负责人安排执行', action: canArrange ? '安排执行' : '查看进展', icon: 'assign' };
    return { text: actionable(task, context) ? '更新进展，完成后提交成果' : '跟进进展与交付结果', action: '查看进展', icon: 'progress' };
  }
  function canEdit(task) {
    if (!task || task.canEditRequirement !== true || task.status !== 'todo' ||
        !['intake', 'clarifying', 'ready'].includes(stage(task))) return false;
    // Hub owns historical execution facts; these checks also protect older snapshots.
    return !task.hasExecutionHistory && !task.requirementEditBlocked && !task.maintenanceBlocked &&
      !task.actualStart && !task.actualEnd && !task.reviewedAt &&
      !['running', 'dispatching', 'done'].includes(task.ai?.state) &&
      !['queued', 'starting', 'running', 'waiting', 'done'].includes(task.workRouting?.conversationTurn?.state);
  }
  function capability(task, field) {
    return Boolean(task && (typeof task[field] === 'boolean' ? task[field] : task.canEditRequirement === true));
  }
  function canManageMaterials(task) { return capability(task, 'canManageRequirementMaterials'); }
  function canSubmitReview(task) {
    return Boolean(task && task.canSubmitReview === true && task.status === 'doing' &&
      stage(task) === 'delivering' && !task.archivedAt && !task.maintenanceBlocked &&
      !['running', 'dispatching'].includes(task.ai?.state) &&
      !['queued', 'starting', 'running', 'waiting'].includes(task.workRouting?.conversationTurn?.state));
  }
  function canResumeRework(task) {
    return Boolean(task && task.canContinueExecution === true && task.workRouting?.reworkPending &&
      task.status === 'doing' && stage(task) === 'delivering' && !task.archivedAt && !task.maintenanceBlocked &&
      !['running', 'dispatching'].includes(task.ai?.state) &&
      !['queued', 'starting', 'running', 'waiting'].includes(task.workRouting?.conversationTurn?.state));
  }
  function canManageAutomation(task) { return capability(task, 'canManageRequirementAutomation'); }
  // Definition editing, delivery operations and maintenance have separate capabilities.
  function executing(task) { return ['doing', 'paused', 'reviewing'].includes(task && task.status); }
  function maintenance(task, action) {
    if (!task || !['delete', 'archive', 'restore'].includes(action)) return {visible: false, disabled: true, reason: '没有维护此需求的权限'};
    const field = action === 'delete' ? 'canDeleteRequirement' : 'canArchiveRequirement';
    const visible = capability(task, field);
    if (!visible) return {visible: false, disabled: true, reason: '没有维护此需求的权限'};
    const phase = stage(task);
    if (action !== 'restore' && ['intake', 'clarifying', 'ready'].includes(phase) &&
        Array.isArray(task.myRoles) && !roles(task).includes('creator')) {
      return {visible: false, disabled: true, reason: '收集箱和待开始的需求只有创建人可以归档或删除'};
    }
    // Hub checks workflows, approvals, execution sessions and startup leases.
    // An explicit settled result wins over a stale AI badge in the same payload.
    const live = ['queued', 'dispatching', 'running', 'starting', 'preparing', 'waiting', 'waiting_human', 'waiting_external', 'paused'];
    let disabled = typeof task.maintenanceBlocked === 'boolean' ? task.maintenanceBlocked :
      live.includes(task.workRouting?.conversationTurn?.state) || live.includes(task.ai?.executionState || task.ai?.state);
    let reason = disabled ? String(task.maintenanceBlockReason || '关联流程或执行尚未结束，请先结束后再操作') : '';
    if (!disabled && action !== 'restore' && !(action === 'delete' && phase === 'closed') &&
        !['intake', 'clarifying', 'ready', 'delivered'].includes(phase)) {
      disabled = true;
      reason = '只有收集箱、待开始和已完成的需求可以归档；这些需求及已归档需求可以删除';
    }
    return {visible: action === 'restore' || !disabled, disabled, reason};
  }
  function canArchive(task) { const state = maintenance(task, 'archive'); return state.visible && !state.disabled; }
  function canDelete(task) { const state = maintenance(task, 'delete'); return state.visible && !state.disabled; }
  /*
   * Show conversation links on the execution device because archives are local. Preserve
   * legacy visibility when task ownership or local device identity is unavailable.
   */
  function canOpenConversation(task, localClientId) {
    // Preparation never opens a stale or unrelated execution conversation.
    if (!task || task.canViewExecution === false || ['intake', 'clarifying', 'ready', 'reviewing'].includes(stage(task))) return false;
    const owner = String(task.ownerClientId || '');
    if (!owner || !localClientId) return true;
    return localClientId === owner;
  }
  function canTriage(task) { return canEdit(task) && task.status === 'todo' && !task.archivedAt &&
    !['queued', 'running', 'starting', 'waiting'].includes(task.workRouting?.conversationTurn?.state) &&
    !['running', 'dispatching', 'done'].includes(task.ai?.state) && stage(task) !== 'reviewing'; }
  function editPatch(task, values) {
    if (!canEdit(task)) return {};
    const original = { ...task, ...content(task) };
    const fields = ['visibility'];
    if (!task.readOnly) fields.push('assigneeUserId');
    if (canEdit(task)) fields.push('tags');
    if (!task.readOnly || task.status === 'todo') fields.push('title', 'note', 'priority');
    if (task.canViewExecution !== false && (!task.readOnly || task.status === 'todo')) fields.push('due');
    if (task.status === 'todo') fields.push('kind', 'acceptanceCriteria');
    if (canTriage(task)) fields.push('triageStage');
    return Object.fromEntries(fields.filter(key => Object.prototype.hasOwnProperty.call(values, key) &&
      (key === 'due' ? day(values[key]) !== day(original[key]) : JSON.stringify(values[key]) !== JSON.stringify(original[key])))
      .map(key => [key, key === 'due' ? dateTimestamp(values[key]) : values[key]]));
  }
  function stagePatch(task, next) {
    if (!canTriage(task) || !['intake', 'clarifying', 'ready'].includes(next)) return null;
    return { triageStage: next, requirementVersion: task.requirementVersion };
  }
  /*
   * List other assigned reviewers for active delivery-review approvals. An empty list means
   * no matching in-flight review.
   */
  function waitingOn(task, context) {
    const list = (context || {}).waiting && context.waiting.get(String((task || {}).id));
    return Array.isArray(list) ? list : [];
  }
  /*
   * Reevaluate board actions against the latest server snapshot instead of blocking stale
   * optimistic state. Return settled when already achieved, blocked when no longer valid, or
   * the current action and patch. The server remains authoritative.
   */
  function resolveStageMove(task, latest, next, actionOf) {
    const target = latest || task;
    if (stage(target) === next) return { settled: true };
    const action = actionOf(stage(latest) !== stage(task) ? target : task, next);
    if (!action) return { blocked: true };
    const patch = action === 'triage' ? stagePatch(target, next) : null;
    if (action === 'triage' && !patch) return { blocked: true };
    return { action, patch };
  }
  return { lanes, columns, priorities, sorts, defaults, viewSettings, kinds, scopes, scopeOptions, normalizeScope, content, displayNote, stage, column,
    day, timeInfo, dateTimestamp, overdue, blocked, roles, approval, canReview, approvalActionable, waitingOn, actionable, inScope, isRequirement, select, owner, nextStep,
    canEdit, canManageMaterials, canSubmitReview, canManageAutomation, canTriage, executing, maintenance,
    canArchive, canDelete, canOpenConversation, editPatch, stagePatch, resolveStageMove };
});
