/* One queue for pending messages and task turns; state is owned by NativeChat, never copied. */
(function (global) {
  'use strict';
  function addDock() {
    return '<div class="nqueue-add-dock"><svg class="nqueue-add-curve" viewBox="0 0 88 30" preserveAspectRatio="none" aria-hidden="true">' +
      '<path class="nqueue-curve-fill" d="M0 28C18 28 23 25 27 15C31 5 35 1 44 1C53 1 57 5 61 15C65 25 70 28 88 28V30H0Z"/>' +
      '<path class="nqueue-curve-edge" d="M0 28C18 28 23 25 27 15C31 5 35 1 44 1C53 1 57 5 61 15C65 25 70 28 88 28"/></svg>' +
      '<button type="button" data-queue-action="add" aria-label="添加需求" title="添加需求">' +
      '<span class="nqueue-add-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span></button></div>';
  }
  function create(ctx) {
  let sendingNow = null, verifying = null;
  const currentSend = () => sendingNow && sendingNow.ref === ctx._ref && sendingNow.epoch === ctx._viewEpoch;
  const currentVerification = () => verifying && verifying.ref === ctx._ref && verifying.epoch === ctx._viewEpoch;
  // Business progress and cached receipts are not proof that a model is live.
  // Only the runtime's single activeTaskId may display a running indicator.
  function taskState(entry, pending) {
    const snapshot = ctx._snap || {}, execution = snapshot.execution || {}, state = execution.turnQueue || {};
    const task = entry && entry.task || {}, id = String(entry && entry.taskId || pending && pending.taskId || '');
    const normalize = value => {
      const raw = String(value || '').trim().toLowerCase();
      return ({ complete: 'completed', done: 'completed', delivered: 'completed', cancel: 'cancelled',
        canceled: 'cancelled', aborted: 'stopped', blocked: 'failed', unreachable: 'failed', incomplete: 'failed' })[raw] || raw;
    };
    const terminal = value => /^(completed|failed|stopped|cancelled)$/.test(normalize(value));
    const receipt = (state.tasks || []).find(row => String(row.taskId) === id);
    const controlled = (execution.taskExecutions || []).find(row => String(row.taskId) === id);
    const active = Boolean(id && String(state.activeTaskId || '') === id);
    if (task.readOnly) return normalize(task.status) === 'completed' ? 'completed' : 'transferred';
    if (active) {
      if (terminal(receipt && receipt.status)) return normalize(receipt.status);
      if (snapshot.pendingUi || /waiting|paused/.test(snapshot.status || '') || /waiting|paused/.test(controlled && controlled.status || '')) return 'waiting-user';
      if (/^(unreachable|no-output|failed|incomplete|aborted)$/.test(snapshot.status || '') && !execution.running) return 'failed';
      if (execution.running || /^(streaming|running|compacting)$/.test(snapshot.status || '') || controlled && controlled.status === 'running') return 'running';
      return 'starting';
    }
    // A newly submitted turn owns its pending position even when an older attempt has a receipt.
    if (pending) return 'queued';
    if (ctx._collabStarts && ctx._collabStarts.has(id)) return 'starting';
    const business = normalize(task.status);
    if (business === 'completed' || business === 'cancelled') return business;
    if (terminal(receipt && receipt.status)) return normalize(receipt.status);
    if (terminal(controlled && controlled.status)) return normalize(controlled.status);
    const localStatus = normalize(entry && ctx._collabEntryStatus(entry));
    const stored = (task.workRouting || {}).conversationTurn || {};
    const matching = stored.conversationId && stored.conversationId === ctx._sessionId;
    // A task-specific completion must not regress when cached Hub metadata still says running/waiting.
    if (terminal(localStatus)) return localStatus;
    const status = matching ? normalize(stored.state) : localStatus || business;
    if (terminal(status)) return status;
    // Delivery and human acceptance are separate. Neither belongs to the pending-send list.
    if (/^(done|completed|delivered|reviewing|review|pending_review|waiting_review)$/.test(task.ai && (task.ai.executionState || task.ai.state) || '')) return 'awaiting-review';
    if (/waiting|paused/.test(status)) return 'waiting';
    if (/^(todo|draft|pending)$/.test(status)) return 'todo';
    // Binding a task keeps its history/context available; it does not enqueue another execution.
    // Unknown/idle/stale running metadata must never invent a request for confirmation.
    return 'linked';
  }
  function _queueRows() {
    const server = (((ctx._snap || {}).execution || {}).queue || []).map((row) => ({ ...row, local: false }));
    const state = ((ctx._snap || {}).execution || {}).turnQueue || {};
    const unmatched = ctx._localQueue.filter((row) => !row.cancelled && row.visible !== false).slice();
    for (const local of unmatched) {
      if (local.submissionId && local.submissionId === state.activeSubmissionId) local.serverId = state.activeQueueId;
    }
    server.forEach((row) => {
      const index = unmatched.findIndex((local) => {
        // Identical wording is not an identity: a task and a follow-up (or two
        // separate submissions) may deliberately carry the same text.
        if (local.serverId) return local.serverId === row.id;
        if (row.submissionId) return local.submissionId === row.submissionId;
        if (row.taskId || local.taskId) return Boolean(row.taskId && local.taskId === row.taskId);
        return local.text === row.text; // Compatibility with older queue snapshots.
      });
      if (index >= 0) {
        unmatched[index].serverId = row.id;
        unmatched.splice(index, 1);
      }
    });
    // Once the runtime acknowledges a placeholder, only its snapshots own
    // that row. A delayed send receipt must not resurrect consumed input.
    return server.concat(unmatched.filter(row => !row.serverId).map((row, index) => ({
      id: row.id, text: row.text, attachments: row.attachments || [],
      taskId: row.taskId || '', taskTitle: row.taskTitle || '',
      position: server.length + index + 1, local: true,
    })));
  }

  function _renderQueue(el) {
    const host = el && el.querySelector('#nchatQueue');
    if (!host || (ctx._composerControls && ctx._composerControls.isDragging())) return;
    const rows = _queueRows();
    const pendingCount = rows.length;
    const represented = new Set(rows.map(row => row.taskId).filter(Boolean));
    const state = ((ctx._snap || {}).execution || {}).turnQueue || {};
    const immediate = ((ctx._snap || {}).execution || {}).queueImmediate || {};
    const recovery = ((ctx._snap || {}).execution || {}).modelRecovery;
    const recoveryRequired = ctx._snap?.execution?.recoveryRequired === true;
    const checking = Boolean(currentVerification());
    const cloudConversation = ctx._snap?.cloudHandoff?.phase === 'committed' ||
      ctx._snap?.snapshot?.cloudHandoff?.phase === 'committed' ||
      ctx._snap?.execution?.cloud === true || ctx._snap?.execution?.mode === 'cloud' ||
      ctx._snap?.snapshot?.execution?.cloud === true || ctx._snap?.snapshot?.execution?.mode === 'cloud';
    // Cloud runs return their files directly into the conversation result
    // area. They do not enter the local requirement acceptance queue/history.
    const completed = ctx._collabEntries().filter(entry => !cloudConversation &&
      /^(completed|awaiting-review)$/.test(taskState(entry)));
    /*
     * Expand acceptance execution records once when completion first appears; polling must
     * respect a later manual collapse.
     */
    if (!ctx._sessionOptions?.acceptanceSession && !ctx._sessionOptions?.acceptanceExecutionSession) {
      ctx._acceptanceHistoryAutoExpanded = false;
    } else if (completed.length && ctx._acceptanceHistoryAutoExpanded !== true) {
      ctx._queueHistoryOpen = true;
      ctx._acceptanceHistoryAutoExpanded = true;
    }
    ctx._collabEntries().forEach(entry => {
      const status = taskState(entry);

      // Its status remains visible in the requirement pool and detail view.
      if (entry.queueRemoved || represented.has(entry.taskId) || /^(completed|awaiting-review|cancelled|stopped|linked|transferred)$/.test(status)) return;
      const row = { id: 'task:' + entry.taskId, taskId: entry.taskId, taskTitle: entry.task.title,
        text: entry.task.description || entry.task.note || '', status, native: entry.nativeTurn };
      if (/^(running|starting|waiting-user)$/.test(status)) rows.unshift(row);
      else rows.push(row);
    });
    const labels = { running: '执行中', waiting: '等待确认', 'awaiting-review': '待验收',
      'waiting-user': '等待输入', transferred: '已转交 · 查看进展', failed: '执行失败', stopped: '已停止', todo: '待发送', starting: '准备中' };
    const action = (name, label, row) => '<button type="button" data-queue-action="' + name + '" data-queue-id="' +
      ctx.esc(row && row.id || '') + '" data-task-id="' + ctx.esc(row && row.taskId || '') + '"' +
      (currentSend() && row?.id === sendingNow.id || name === 'resume' && checking ? ' disabled' : '') +
      (name === 'add' ? ' aria-label="添加需求" title="添加需求"' : '') + '>' + label + '</button>';
    const icon = name => '<svg viewBox="0 0 20 20" aria-hidden="true">' + ({
      task: '<rect x="4.5" y="3" width="11" height="14" rx="2.5"/><path d="M7.5 7h5M7.5 10h5m-5 3 1.3 1.3 3-3"/>',
      message: '<path d="M6 4h8a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H8l-4 2v-3a3 3 0 0 1-1-2V7a3 3 0 0 1 3-3Z"/><path d="M7 8h6M7 11h4"/>',
      grip: '<path d="M7.5 5h.01m4.99 0h.01M7.5 10h.01m4.99 0h.01M7.5 15h.01m4.99 0h.01" stroke-width="2.6"/>',
      add: '<path d="M10 5v10M5 10h10"/>',
      edit: '<path d="m12.5 4.5 3 3M4 16l3.5-.7 8.8-8.8a2.1 2.1 0 0 0-3-3l-8.6 9Z"/>',
      remove: '<path d="M4 5.5h12M7.5 5.5V3.8a.8.8 0 0 1 .8-.8h3.4a.8.8 0 0 1 .8.8v1.7M5.5 5.5l.7 10a1.5 1.5 0 0 0 1.5 1.4h4.6a1.5 1.5 0 0 0 1.5-1.4l.7-10M8.5 9v4M11.5 9v4"/>',
      more: '<circle cx="4" cy="10" r=".7"/><circle cx="10" cy="10" r=".7"/><circle cx="16" cy="10" r=".7"/>',
      steer: '<path d="M4.5 15.5v-4a4 4 0 0 1 4-4h7"/><path d="m12 4 3.5 3.5L12 11"/>',
    })[name] + '</svg>';
    const html = '<div class="nqueue-stack' + (rows.length ? ' has-items' : ' is-empty') + '">' +
      '<div class="nqueue-toolbar"><div>' + (completed.length ? action('history', (ctx._queueHistoryOpen ? '收起记录' : '已完成') + ' · ' + completed.length) : '') +
      '</div>' + addDock() + '</div>' +
      '<div class="nqueue-goal-slot"></div><div class="nqueue-items" aria-label="待发送队列">' + rows.map((row, index) => {
      const entry = ctx._collabTasks.get(row.taskId);
      const transferred = Boolean(entry && entry.task && entry.task.readOnly);
      const nativeId = !row.id.startsWith('task:');
      const status = row.taskId ? taskState(entry || { taskId: row.taskId, task: {} }, nativeId ? row : null) : 'queued';
      const running = status === 'running';
      const controller = (ctx._snap?.execution?.taskExecutions || []).find(value => value.taskId === row.taskId);
      const waitLabel = controller?.status === 'waiting' && ({ connection: '等待连接', auth: '需要重新登录',
        permission: '等待授权', stop: '停止中' })[controller.waitingReason];
      const active = Boolean(row.taskId && String(state.activeTaskId || '') === String(row.taskId));
      const movable = nativeId && !active && !row.local && !transferred && !(currentSend() && sendingNow.id === row.id);
      const showImmediate = !row.taskId && nativeId && immediate.supported === true;
      const isSending = currentSend() && sendingNow.id === row.id;
      const busy = Boolean(currentSend() || immediate.pending);
      const cannotSend = row.local || busy || !immediate.available;
      const sendHint = isSending ? '正在停止当前回复并发送…' : row.local ? '消息正在加入队列，请稍候'
        : immediate.reason || '停止当前回复，立即发送这条消息；其余消息继续排队';
      return '<div class="nqueue-row' + (showImmediate ? ' has-send-now' : '') + '" data-queue-row="' + ctx.esc(row.id) + '" data-queue-kind="' + (row.taskId ? 'task' : 'message') + '" data-queue-state="' + ctx.esc(status) + '"' +
        (movable ? ' data-queue-draggable draggable="true"' : '') + '>' +
        (movable ? '<button class="nqueue-grip" type="button" data-queue-grip="' + ctx.esc(row.id) +
          '" aria-label="' + (row.taskId ? '需求' : '消息') + '：拖动排序，也可按 Alt 和上下方向键" title="' + (row.taskId ? '需求' : '消息') + ' · 拖动排序 · Alt + ↑ / ↓"><span class="nqueue-kind-icon">' + icon(row.taskId ? 'task' : 'message') + '</span><span class="nqueue-drag-icon">' + icon('grip') + '</span></button>' :
          '<span class="nqueue-mark" aria-hidden="true">' + icon(row.taskId ? 'task' : 'message') + '</span>') +
        '<button type="button" class="nqueue-copy" data-queue-action="' + (row.taskId ? 'detail' : 'edit') +
        '" title="' + ctx.esc(row.taskTitle || row.text) + '" data-task-id="' + ctx.esc(row.taskId || '') + '" data-queue-id="' + ctx.esc(row.id) + '">' +
        '<b>' + ctx.esc(row.taskTitle || row.text) + '</b></button>' +
        (status === 'queued' ? '' : '<span class="nqueue-state">' + ctx.esc(waitLabel || labels[status] || '等待确认') +
          (running ? '<span class="nqueue-progress" aria-hidden="true"></span>' : '') + '</span>') +
        (showImmediate ? '<button type="button" class="nqueue-send-now" data-queue-action="send-now" data-queue-id="' + ctx.esc(row.id) +
          '" title="' + ctx.esc(sendHint) + '" aria-label="' + ctx.esc(isSending ? '正在引导' : '引导') +
          '"' + (cannotSend ? ' disabled' : '') + (isSending ? ' aria-busy="true"' : '') + '>' +
          '<span>' + (isSending ? '引导中…' : '引导') + '</span>' + icon('steer') + '</button>' : '') +
        (movable && !showImmediate ? action('edit', icon('edit') + '<span class="nqueue-action-label">调整内容</span>', row) : '') +
        (!active && !transferred && !nativeId && row.native && /^(failed|stopped)$/.test(status) ?
          (recovery && recovery.taskId === row.taskId ? action('retry-model', recovery.requiresModelChange ? '切换模型后恢复' : '恢复这一轮', { id: recovery.id }) : action('retry', '重试需求', row)) : '') +
        (!transferred && !nativeId && status === 'todo' && !row.native ?
          action('arrange', '执行方式', row) + action('start', '发送需求', row) : '') +
        (!active ? action('remove', '<span class="nqueue-sr">移除</span>' + icon('remove'), row) : '') +
        (movable ? '<details class="nqueue-more"><summary aria-label="更多队列操作" title="更多操作">' + icon('more') +
          '</summary><div>' + (showImmediate ? action('edit', '调整内容', row) : '') + action('up', '向上移动', row) + action('down', '向下移动', row) + '</div></details>' : '') + '</div>';
    }).join('') + '</div>' +
      (recoveryRequired || state.paused && (pendingCount || recovery) ? '<div class="nqueue-paused" role="status"><span>' +
        ctx.esc(recoveryRequired ? (checking ? '正在核实执行状态…' : ctx._snap.statusText || state.reason || '执行状态尚未确认') : state.reason || '队列已暂停') +
        '</span>' + (recoveryRequired ? action('resume', checking ? '核实中…' : '核实执行状态') :
          recovery ? action('retry-model', recovery.requiresModelChange ? '切换模型后恢复' : '恢复这一轮', { id: recovery.id }) : action('resume', '继续队列')) + '</div>' : '') +
      (ctx._queueHistoryOpen && completed.length ? '<div class="nqueue-history">' + completed.map(entry => {
        const rt = entry && entry.task || {};
        // Derive receipt wording from current state so rejected approvals do not remain labeled pending acceptance.
        // Awaiting merge after project acceptance is a valid intermediate state, distinct from blocked completion.
        const rtEng = Boolean(rt.projectId || rt.repoId)
          || String(rt.workRouting?.outputContract?.kind || '') === 'repository-change';
        const receipt = (rt.reviewedAt && /^(done|completed|delivered)$/.test(String(rt.status || '')))
          ? '已验收 · 已办结'
          : rt.reviewedAt ? (rtEng ? '已验收 · 等待合并' : '已验收 · 办结中')
          : rt.reviewRejected ? '已打回 · 等待返修'
          : '已返回结果 · 待需求验收';
        const reworkAction = rt.reviewRejected && rt.canContinueExecution === true
          ? '<button type="button" class="nqueue-rework-action" data-task-rework="' + ctx.esc(entry.taskId) + '">继续修正</button>'
          : '';
        return '<div class="nqueue-receipt"><span aria-hidden="true">✓</span><span>' + ctx.esc(entry.task.title || '需求') +
          '</span><small>' + ctx.esc(receipt) + '</small>' + reworkAction + '<button type="button" data-task-receipt="' + ctx.esc(entry.taskId) +
          '">查看详情</button></div>';
      }).join('') + '</div>' : '') +
      (ctx._queueEdit ? '<div class="nqueue-editor"><label for="nqueueEditText">调整尚未发送的内容</label>' +
        '<textarea id="nqueueEditText" rows="4">' + ctx.esc(ctx._queueEdit.text) + '</textarea><div>' +
        action('discard-edit', '取消') + action('save-edit', '保存调整', { id: ctx._queueEdit.id }) + '</div></div>' : '') + '</div>';
    host.classList.add('show');
    host.classList.toggle('has-items', rows.length > 0);
    // Keep the goal node and its controls alive when task rows are refreshed.
    const rail = host.querySelector && el.querySelector('#nchatIntentRail');
    const focused = document.activeElement;
    const restoreGoalFocus = rail && rail.contains(focused);
    if (host.dataset.renderKey !== html) {
      if (ctx._queueEdit && focused && focused.id === 'nqueueEditText') return;
      if (rail) rail.remove();
      host.innerHTML = html; host.dataset.renderKey = html;
    }
    const goalSlot = host.querySelector && host.querySelector('.nqueue-goal-slot');
    if (rail && goalSlot && rail.parentElement !== goalSlot) {
      goalSlot.appendChild(rail);
      if (restoreGoalFocus) focused.focus({ preventScroll: true });
    }
  }

  async function _queueAction(action, id, taskId) {
    if (currentSend() && sendingNow.id === id) return;
    if (action === 'history') { ctx._queueHistoryOpen = !ctx._queueHistoryOpen; _renderQueue(ctx._mount()); return; }
    if (action === 'add') { ctx._openTaskPicker(); return; }
    const entry = ctx._collabTasks.get(taskId);
    if (action === 'arrange') { if (entry) await global.RequirementAssignment?.open(taskId, 'ai'); return; }
    if (action === 'detail') {
      if (entry && entry.task && entry.task.readOnly) {
        if (typeof global.openDetailEntry === 'function') global.openDetailEntry(taskId);
        else if (global.WorkspaceHost) global.WorkspaceHost.open('detail', { taskId });
      } else ctx._collabAction('open-task', { taskId });
      return;
    }
    if (action === 'start' || action === 'retry') { if (entry) await ctx._startTask(entry.task, { retry: action === 'retry', fromComposer: action === 'start' }); return; }
    const row = _queueRows().find(item => item.id === id);
    if (action === 'send-now') { await _sendNow(row); return; }
    if (action === 'edit') {
      if (!row) return;
      ctx._queueEdit = { id, text: row.text }; _renderQueue(ctx._mount());
      document.getElementById('nqueueEditText')?.focus(); return;
    }
    if (action === 'discard-edit') { ctx._queueEdit = null; _renderQueue(ctx._mount()); return; }
    if (action === 'remove') {
      const conversationId = ctx._sessionId || ctx._ref, ref = ctx._ref, epoch = ctx._viewEpoch;
      const removedTaskId = taskId || row && row.taskId;
      if (row && !(await _cancelQueued(id))) return;
      if (removedTaskId && (row || entry)) {
        const store = global.ChatCollaborationStore;
        if (!store || !store.setQueueRemoved(conversationId, removedTaskId, true)) {
          if (typeof global.petSay === 'function') global.petSay('移除未能保存，请重试');
          return;
        }
        if (entry) entry.queueRemoved = true;
        if (ref === ctx._ref && epoch === ctx._viewEpoch) {
          if (ctx._taskStartPrompt && ctx._taskStartPrompt.task && ctx._taskStartPrompt.task.id === removedTaskId)
            ctx._taskStartPrompt = null;
          ctx._render();
        }
      }
      return; // Removing a queue item never deletes the task.
    }
    const api = ctx._api();
    if (!api || !api.updateQueue) return;
    const ref = ctx._ref, epoch = ctx._viewEpoch, snapshot = ctx._snap;
    const verify = action === 'resume' && snapshot?.execution?.recoveryRequired === true;
    if (verify && currentVerification()) return;
    const verification = verify ? {ref, epoch} : null;
    if (verification) { verifying = verification; _renderQueue(ctx._mount()); }
    const value = action === 'save-edit' ? document.getElementById('nqueueEditText')?.value || '' : '';
    try {
      const result = await api.updateQueue(ref, id, action === 'save-edit' ? 'edit' : action, value);
      if (ctx._ref !== ref || ctx._viewEpoch !== epoch) return;
      if (result?.snapshot && ctx._snap === snapshot && (result.ok || verify)) ctx._snap = result.snapshot;
      if (!result || !result.ok) { global.petSay?.(result?.reason || '队列调整失败'); return; }
      ctx._queueEdit = null;
      if (!verification) ctx._render();
    }
    catch (error) {
      if (ctx._ref === ref && ctx._viewEpoch === epoch && typeof global.petSay === 'function')
        global.petSay(error.message || '操作未完成，请重试');
    } finally {
      if (verification && verifying === verification) {
        verifying = null;
        if (ctx._ref === ref && ctx._viewEpoch === epoch) ctx._render();
      }
    }
  }

  async function _sendNow(row) {
    const api = ctx._api(), immediate = ((ctx._snap || {}).execution || {}).queueImmediate || {};
    if (!row || row.local || row.taskId || !ctx._ref || currentSend() || !immediate.available || immediate.pending ||
        !immediate.supported || typeof api?.updateQueue !== 'function') return;
    const request = { ref: ctx._ref, epoch: ctx._viewEpoch, id: row.id, snapshot: ctx._snap };
    sendingNow = request;
    _renderQueue(ctx._mount());
    try {
      const result = await api.updateQueue(request.ref, row.id, 'send-now', '');
      if (ctx._ref !== request.ref || ctx._viewEpoch !== request.epoch) return;
      if (!result?.ok) throw Error(result?.reason || '引导未完成，消息仍保留在队列中');
      // Snapshots/events own the queue. Do not remove/recreate the item here:
      // it may already have started while this IPC reply was travelling.
      if (result.snapshot && ctx._snap === request.snapshot) ctx._snap = result.snapshot;
      if (ctx._queueEdit?.id === row.id) ctx._queueEdit = null;
    } catch (error) {
      if (ctx._ref === request.ref && ctx._viewEpoch === request.epoch && typeof global.petSay === 'function')
        global.petSay(error.message || '引导未完成，消息仍保留在队列中');
    } finally {
      if (sendingNow === request) sendingNow = null;
      if (ctx._ref === request.ref && ctx._viewEpoch === request.epoch) ctx._render();
    }
  }

  async function _updateQueueOrder(id, action, before) {
    if (currentSend() && (sendingNow.id === id || sendingNow.id === before)) return;
    const ref = ctx._ref, epoch = ctx._viewEpoch, snapshot = ctx._snap;
    try {
      const result = await ctx._api().updateQueue(ref, id, action, before);
      if (ref !== ctx._ref || epoch !== ctx._viewEpoch) return;
      if (!result || !result.ok) throw new Error(result && result.reason || '队列调整失败');
      if (result.snapshot && ctx._snap === snapshot) ctx._snap = result.snapshot;
      ctx._render();
    } catch (error) { if (ref === ctx._ref && epoch === ctx._viewEpoch && typeof petSay === 'function') petSay(error.message || '请刷新后重试'); }
  }

  async function _cancelQueued(id) {
    if (currentSend() && sendingNow.id === id) return false;
    const ref = ctx._ref, epoch = ctx._viewEpoch, snapshot = ctx._snap;
    const local = ctx._localQueue.find((row) => row.id === id);
    const queueId = local && local.serverId ? local.serverId : (!local ? id : '');
    const api = ctx._api();
    const removeLocal = () => {
      if (local) local.cancelled = true;
      ctx._localQueue = ctx._localQueue.filter((row) => row.id !== id);
      _renderQueue(ctx._mount());
    };
    if (!queueId) { removeLocal(); return true; }
    if (!api || !ref || typeof api.cancelQueued !== 'function') return false;
    try {
      const result = await api.cancelQueued(ref, queueId);
      if (!result || !result.ok) throw new Error((result && result.reason) || '取消失败');
      if (ref === ctx._ref && epoch === ctx._viewEpoch) {
        if (result.snapshot && ctx._snap === snapshot) ctx._snap = result.snapshot;
        removeLocal();
        ctx._render();
      }
      return true;
    } catch (error) {
      if (typeof petSay === 'function') petSay(String((error && error.message) || error));
      return false;
    }
  }
    return { _queueRows, _renderQueue, _queueAction, _updateQueueOrder, _cancelQueued };
  }
  global.ChatSendQueue = { create, addDock };
})(window);
