/* Rendering only. Hub owns lifecycle; RequirementsBoard owns interaction and preferences. */
(function (global) {
  'use strict';
  const R = global.Requirements;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const paths = {
    person: '<circle cx="12" cy="8" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
    agent: '<rect x="5" y="7" width="14" height="13" rx="4"/><path d="M12 3v4M9 12h.01M15 12h.01M9 16h6"/>',
    unassigned: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 8-5.65M17 13v8m-4-4h8"/>',
    board: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M10 4v16M17 4v16"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    filter: '<path d="M3 5h18M6 12h12M10 19h4"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    project: '<path d="M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10H3Z"/>',
    date: '<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 11h16"/>',
    arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
    flag: '<path d="M5 21V4m0 0c5-4 9 4 14 0v10c-5 4-9-4-14 0Z"/>',
    archive: '<rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v13h14V8M9 12h6"/>',
    intake: '<path d="M5 4h14l2 12v4H3v-4L5 4Z"/><path d="M3 15h5l2 3h4l2-3h5"/>',
    ready: '<circle cx="12" cy="12" r="8"/><path d="m10 8 5 4-5 4V8Z"/>',
    delivering: '<circle cx="12" cy="12" r="8"/><path d="M12 4v8h8"/>',
    reviewing: '<rect x="5" y="4" width="14" height="17" rx="3"/><path d="M9 4V2h6v2M8 13l3 3 5-6"/>',
    delivered: '<circle cx="12" cy="12" r="8"/><path d="m8 12 3 3 5-6"/>',
  };
  const icon = name => '<svg viewBox="0 0 24 24" aria-hidden="true">' + (paths[name] || paths.clock) + '</svg>';
  function options(entries, value) { return entries.map(([key, label]) => '<option value="' + esc(key) + '"' +
    (String(value) === String(key) ? ' selected' : '') + '>' + esc(label) + '</option>').join(''); }
  function assignable(task) { return (global.RequirementAssignment?.eligible(task) ?? global.ChatTaskController?.isPickableTask(task)) === true; }
  function project(task, ctx) { return ctx.projects?.get(String(task.projectId)) || task.projectName || (task.projectId ? '项目 ' + String(task.projectId).slice(0, 8) : '未关联项目'); }
  function human(task) { return task.assigneeName || (task.assigneeUserId ? '成员 ' + String(task.assigneeUserId).slice(0, 6) : '未指定负责人'); }
  function owner(task) {
    const value = R.owner(task);
    const avatar = value.kind === 'person'
      ? '<span class="rq-owner-avatar" aria-hidden="true">' + esc(Array.from(value.name.trim())[0] || '人') + '</span>'
      : '<span class="rq-owner-avatar is-' + esc(value.kind) + '" aria-hidden="true">' + icon(value.kind) + '</span>';
    return '<span class="rq-owner" title="' + esc((value.kind === 'agent' ? '执行智能体：' : '负责人：') + value.name) + '">' +
      avatar + '<span' + (value.kind === 'unassigned' ? '' : ' data-user-content') + '>' + esc(value.name) + '</span></span>';
  }
  // Creator and owner are distinct roles; display a dash when legacy records lack names.
  function creator(task) {
    const name = String(task.createdByName || '').trim();
    if (!name) return '<span class="rq-creator is-empty">—</span>';
    return '<span class="rq-creator" title="' + esc('创建人：' + name) + '" data-user-content>' + esc(name) + '</span>';
  }
  function stageBadge(task) {
    return '<span class="rq-stage is-' + R.column(task) + '">' + esc(task.status === 'cancel' ? '已取消' :
      R.columns.find(row => row[0] === R.column(task))?.[1] || '待开始') + '</span>';
  }
  function cardLabels(task) {
    return '<span class="rq-card-labels"><span class="rq-kind" data-kind="' + esc(task.kind || 'other') + '">' + esc(R.kinds[task.kind] || R.kinds.other) + '</span>' +
      (R.stage(task) === 'clarifying' ? '<span class="rq-flag">待补充</span>' : '') +
      (R.blocked(task) ? '<span class="rq-flag">' + (task.status === 'paused' ? '已暂停' : '执行异常') + '</span>' : '') + '</span>';
  }
  function tags(task) {
    const values = [...new Set((Array.isArray(task.tags) ? task.tags : [])
      .map(tag => String(tag || '').trim()).filter(Boolean))];
    if (!values.length) return '';
    const visible = values.slice(0, 2).map(tag => '<span class="rq-user-tag" data-user-content title="' + esc(tag) + '">' + esc(tag) + '</span>').join('');
    const more = values.length > 2 ? '<span class="rq-tags-more" title="' + esc(values.slice(2).join('、')) +
      '" aria-label="另有 ' + (values.length - 2) + ' 个标签：' + esc(values.slice(2).join('、')) + '">+' + (values.length - 2) + '</span>' : '';
    return '<span class="rq-card-tags">' + visible + more + '</span>';
  }
  function priorityFlag(task) {
    const priority = Object.hasOwn(R.priorities, task.priority) ? task.priority : 'normal';
    const label = '优先级：' + R.priorities[priority];
    return '<span class="rq-priority-flag is-' + priority + '" role="img" aria-label="' + label + '" title="' + label + '">' + icon('flag') + '</span>';
  }
  function due(task) {
    const value = R.day(task.due); if (!value) return '';
    return '<time class="rq-date' + (R.overdue(task) ? ' is-overdue' : '') + '" datetime="' + esc(value) +
      '" title="截止日期：' + esc(value) + '">' + icon('date') + value.slice(5).replace('-', '/') + '</time>';
  }
  function timestamp(task, compact) {
    const value = R.timeInfo(task);
    if (!value.datetime) return '<span class="rq-updated is-empty" title="' + esc(value.title) + '">' + esc(value.text) + '</span>';
    // compact: show the timestamp beside the card assignee without an Updated/Created prefix; tables keep the full prefixed form.
    if (compact) return '<span class="rq-updated"><time datetime="' + esc(value.datetime) +
      '" title="' + esc(value.title) + '" aria-label="' + esc(value.title) + '">' + esc(value.text) + '</time></span>';
    return '<span class="rq-updated"><span>' + esc(value.label) + '</span><time datetime="' + esc(value.datetime) +
      '" title="' + esc(value.title) + '" aria-label="' + esc(value.title) + '">' + esc(value.text) + '</time></span>';
  }
  function menuButton(task) { return '<button type="button" class="rq-card-menu" data-rq-actions="' + esc(task.id) +
    '" aria-label="需求操作：' + esc(R.content(task).title) + '" aria-haspopup="menu" aria-expanded="false">' + icon('more') + '</button>'; }
  function card(task, state, ctx) {
    const pending = R.approval(task, ctx);
    // A request that this user has already decided is still returned by the
    // hub while other approvers finish. It must not keep advertising the
    // decision card in the requirement pool; the detail view already treats
    // it as a waiting state.
    const actionable = pending && (!pending.status || pending.status === 'pending') && !pending.myDecision && R.approvalActionable(task, ctx)
      ? pending : null;
    const acceptance = actionable || global.TaskTraceApproval?.canAcceptTask(task, ctx), id = esc(task.id);
    const moving = state.movingId === String(task.id);
    return '<article class="rq-card" data-hbid="' + id + '" aria-busy="' + moving + '" draggable="' + (!moving && state.group === 'stage' && R.canTriage(task)) + '">' +
      '<div class="rq-card-top">' + cardLabels(task) + priorityFlag(task) + menuButton(task) + '</div>' +
      '<button type="button" class="rq-card-open" data-rq-open="' + id + '"><span class="rq-card-title" data-user-content title="' +
      esc(R.content(task).title) + '">' + esc(R.content(task).title || '未命名需求') + '</span>' +
      tags(task) +
      (state.group !== 'stage' ? stageBadge(task) : '') +
      (task.projectId || task.projectName ? '<span class="rq-project">' + icon('project') + '<span data-user-content>' + esc(project(task, ctx)) + '</span></span>' : '') +
      (due(task) ? '<span class="rq-card-due">' + due(task) + '</span>' : '') +
      '<span class="rq-card-meta">' + owner(task) + '<span class="rq-card-trailing">' + timestamp(task, true) + '</span></span></button>' +
      (moving ? '<div class="rq-card-moving" role="status"><span class="rq-moving-spinner" aria-hidden="true"></span>正在变更状态…</div>' : acceptance ? '<button type="button" class="rq-card-decision" data-rq-open="' + id + '">' + icon('check') +
        (actionable?.action === 'review' || (!pending && acceptance) ? '核对成果并选择验收方式' : esc(R.nextStep(task, ctx).text)) + icon('arrow') + '</button>' :
       assignable(task) ? '<button type="button" class="rq-card-assign" data-rq-assign="' + id + '">' + icon('arrow') + '安排执行</button>' : '') + '</article>';
  }
  function groups(list, state, ctx) {
    // Every board column uses actual update chronology, regardless of a saved
    // list-view sort preference. Filtering already happened in the controller.
    list = R.select(list, {sort: 'updated'}, ctx);
    if (state.archive === 'archived') return [['closed', '已归档', '历史记录与取消的需求', list]];
    if (state.group === 'stage') return R.columns.filter(([id]) => id !== 'closed').map(([id, label, hint]) =>
      [id, label, hint, list.filter(task => R.column(task) === id)]);
    const buckets = new Map();
    for (const task of list) {
      const key = String((state.group === 'project' ? task.projectId : task.assigneeUserId) || '__none');
      if (!buckets.has(key)) buckets.set(key, [key, state.group === 'project' ? project(task, ctx) : human(task), '', []]);
      buckets.get(key)[3].push(task);
    }
    return [...buckets.values()].sort((a, b) => a[0] === '__none' ? 1 : b[0] === '__none' ? -1 : a[1].localeCompare(b[1], 'zh-CN'));
  }
  function board(list, state, ctx) {
    const archived = state.archive === 'archived';
    return '<div class="' + (archived ? 'rq-archive' : 'rq-kanban' + (state.group !== 'stage' ? ' is-property-group' : '')) + '" role="list" aria-label="需求看板">' +
      groups(list, state, ctx).map(([id, title, hint, items]) => {
        const limit = state.limits[id] || 40, stage = state.group === 'stage', domId = 'rqLane-' + encodeURIComponent(id);
        return '<section class="rq-lane' + (stage ? ' is-' + id : '') + '" data-rq-lane="' + esc(id) + '" role="listitem">' +
          '<header class="rq-lane-head"><div class="rq-lane-heading"><h2 class="rq-lane-title" id="' + domId + '-title" title="' + esc(hint || title) + '">' +
          (stage ? icon(id) : icon(state.group === 'owner' ? 'person' : 'project')) + '<span' + (stage || id === '__none' ? '' : ' data-user-content') + '>' + esc(title) +
          '</span><em>' + items.length + '</em></h2>' + (stage && hint ? '<p class="rq-lane-hint">' + esc(hint) + '</p>' : '') + '</div>' +
          (!archived && stage && ['intake', 'ready'].includes(id) ? '<button type="button" class="rq-column-add" data-rq-create="' + id +
            '" aria-label="在' + esc(title) + '新建需求">＋</button>' : '') + '</header>' +
          '<div class="rq-lane-cards" id="' + domId + '" tabindex="0" role="region" aria-labelledby="' + domId + '-title">' +
          (items.length ? items.slice(0, limit).map(task => card(task, state, ctx)).join('') : '<p class="rq-lane-empty">暂无需求</p>') +
          (items.length > limit ? '<button type="button" class="rq-more-cards" data-rq-more="' + esc(id) + '">再显示 ' + Math.min(40, items.length - limit) + ' 条</button>' : '') + '</div></section>';
      }).join('') + '</div>';
  }
  function list(rows, state, ctx) {
    const limit = state.limits.list || 80;
    return '<div class="rq-table-wrap"><table class="rq-table"><thead><tr><th>需求</th><th>阶段</th><th>负责人 / 执行者</th><th>创建人</th><th>项目</th><th>优先级</th><th>截止日期</th><th>最近更新</th><th><span class="rq-sr-only">操作</span></th></tr></thead><tbody>' +
      rows.slice(0, limit).map(task => '<tr data-hbid="' + esc(task.id) + '"><td><button class="rq-list-title" type="button" data-rq-open="' + esc(task.id) +
        '"><span class="rq-list-title-text" data-user-content>' + esc(R.content(task).title || '未命名需求') + '</span><span class="rq-list-labels">' + cardLabels(task) + tags(task) + '</span></button></td><td>' + stageBadge(task) + '</td><td>' +
        owner(task) + '</td><td>' + creator(task) + '</td><td><span class="rq-table-project"' + (task.projectId || task.projectName ? ' data-user-content' : '') + ' title="' + esc(project(task, ctx)) + '">' + esc(project(task, ctx)) + '</span></td><td>' +
        esc(R.priorities[task.priority] || '普通') + '</td><td>' + (due(task) || '—') + '</td><td>' + timestamp(task) + '</td><td>' + menuButton(task) + '</td></tr>').join('') + '</tbody></table></div>' +
      (rows.length > limit ? '<button type="button" class="rq-more-cards" data-rq-more="list">再显示 ' + Math.min(80, rows.length - limit) + ' 条</button>' : '');
  }
  const labels = { phase: '阶段', kind: '类型', priority: '优先级', project: '项目', owner: '负责人', tag: '标签', due: '截止日期', attention: '关注事项' };
  function filterOptions(data, ctx) {
    const projects = new Map(), owners = new Map(), tags = new Map();
    for (const task of data) {
      if (task.projectId) projects.set(String(task.projectId), project(task, ctx));
      if (task.assigneeUserId) owners.set(String(task.assigneeUserId), human(task));
      (Array.isArray(task.tags) ? task.tags : []).forEach(tag => { const value = String(tag || '').trim(); if (value) tags.set(value, value); });
    }
    const sorted = map => [...map].sort((a,b) => a[1].localeCompare(b[1], 'zh-CN'));
    return { phase: R.columns.map(([id, label]) => [id, label]), kind: Object.entries(R.kinds), priority: Object.entries(R.priorities),
      project: [['__none', '未关联项目'], ...sorted(projects)], owner: [['__none', '未指定负责人'], ...sorted(owners)], tag: sorted(tags),
      due: [['overdue', '已逾期'], ['today', '今天截止'], ['week', '未来 7 天'], ['none', '未设截止日期']],
      attention: [['blocked', '暂停或执行异常'], ['clarifying', '待补充材料'], ['approval', '待我确认']] };
  }
  function filters(state, data, ctx) {
    const choices = filterOptions(data, ctx);
    return '<h3>筛选需求</h3>' + Object.entries(labels).map(([key, label]) => {
      const values = choices[key];
      if (state[key] && !values.some(([id]) => id === state[key])) values.push([state[key], '当前筛选项（暂无需求）']);
      return '<label>' + label + '<select data-rq-filter="' + key + '" aria-label="' + label + '筛选">' +
        options([['', '全部'], ...values], state[key]) + '</select></label>';
    }).join('') + '<button type="button" data-rq-clear>清除筛选</button>';
  }
  function chips(state, data, ctx) {
    const choices = filterOptions(data, ctx);
    return Object.entries(labels).filter(([key]) => state[key]).map(([key,label]) => '<button type="button" class="rq-filter-chip" data-rq-remove-filter="' + key +
      '" aria-label="移除' + label + '筛选">' + label + '：<span' + (['project','owner'].includes(key) && state[key] !== '__none' ? ' data-user-content' : '') + '>' + esc(choices[key].find(([id]) => id === state[key])?.[1] || '当前筛选项') + '</span><span aria-hidden="true">×</span></button>').join('');
  }
  function actions(task, ctx) {
    const id = esc(task.id);
    const actionButton = (action, label) => {
      const state = R.maintenance(task, action);
      if (!state.visible) return '';
      return '<button type="button" role="menuitem"' + (action === 'delete' ?
        ' class="rq-danger" data-rq-delete="' + id + '"' : ' data-rq-maintain="' + id + '" data-rq-maintenance="' + action + '"') +
        (state.disabled ? ' disabled aria-disabled="true" title="' + esc(state.reason) + '"' : '') + '>' + label +
        (state.disabled ? '<span>（' + esc(state.reason) + '）</span>' : '') + '</button>';
    };
    return '<button type="button" role="menuitem" data-rq-open="' + id + '">打开详情</button>' +
      (assignable(task) ? '<button type="button" role="menuitem" data-rq-assign="' + id + '">安排执行</button>' : '') +
      (R.canTriage(task) ? ['intake', 'clarifying', 'ready'].filter(key => key !== R.stage(task)).map(key =>
        '<button type="button" role="menuitem" data-rq-move="' + id + '" data-rq-target="' + key + '">' +
        ({intake:'放回收集箱', clarifying:'标记待补充', ready:'准备好，移到待开始'})[key] + '</button>').join('') : '') +
      (R.canSubmitReview(task) ? '<button type="button" role="menuitem" data-rq-move="' + id + '" data-rq-target="reviewing">提交验收</button>' : '') +
      (R.canOpenConversation(task, global.SoduWorkAPI?.clientId) && !task.archivedAt ? '<button type="button" role="menuitem" data-rq-chat="' + id + '">打开执行会话（仅本机）</button>' : '') +
      actionButton(R.stage(task) === 'closed' ? 'restore' : 'archive', R.stage(task) === 'closed' ? '恢复需求' : '归档需求') +
      actionButton('delete', '删除需求');
  }
  global.RequirementsView = { esc, icon, options, project, human, assignable, creator, board, list, labels, filters, chips, actions };
})(window);
