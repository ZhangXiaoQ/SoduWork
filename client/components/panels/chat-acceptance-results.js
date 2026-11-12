/* Acceptance results and approvals share the original conversation state without duplicating task facts. */
(function (global) {
  'use strict';
  function readableResult(text) {
    // Only presentation prose is normalized. Links, code and persisted evidence stay intact.
    return String(text || '').split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`|!?\[[^\]\n]*\]\([^\n]*?\)|https?:\/\/[^\s<>]+)/g)
      .map((part, index) => {
        if (index % 2) return part;
        return part.replace(/[（(]([^()（）\n]*)[）)]/g, (whole, content) => {
          const cleaned = content.replace(/(?:附件|文件|交付版本|审批单|会话|attachment|artifact version|approval|session)\s*ID\s*[:：]\s*[a-z0-9][a-z0-9_.:-]*(?:\s*[,，;；]\s*)?/gi, '')
            .replace(/^[\s,，;；]+|[\s,，;；]+$/g, '');
          return cleaned === content ? whole : cleaned ? '（' + cleaned + '）' : '';
        }).replace(/(^|\n)([ \t]*(?:[-*+]\s+|\d+[.)]\s+)?)criterion-(\d+)(?=\s*[:：])/gi,
          '$1$2验收标准 $3');
      }).join('');
  }
  function create(ctx, { rich, invalidate }) {
    const acceptanceHandoffs = new Map();
    const acceptanceResultActions = new Set();
    const resultApprovals = new Map();
    // These receipts acknowledge successful UI operations, never replace Hub task facts.
    const approvalResults = new Map();
    const resultOutcomes = new Map();
    const pendingActions = new Set();
    const approvalAnchors = new Map();
    let epoch = 0;
    const acceptanceKey = (taskId, approvalId) => String(taskId || '') + ':' + String(approvalId || '');
    function reset() {
      epoch++;
      acceptanceHandoffs.clear(); acceptanceResultActions.clear(); resultApprovals.clear();
      approvalResults.clear(); resultOutcomes.clear(); pendingActions.clear();
      approvalAnchors.clear();
    }
    function outcomeLabel(outcome) {
      if (outcome.decision === 'analyze') return '已填入对话框，请按需选择插件后发送。';
      if (outcome.decision === 'auto') return '已打开自动验收会话';
      if (outcome.decision === 'manual') return '已转入会话分析';
      if (outcome.decision === 'reject') return '已退回修改';
      if (outcome.status === 'approved') return '已确认验收';
      return outcome.status === 'pending' ? '确认意见已提交，等待其他审批人' : '确认验收意见已提交';
    }
    function outcomeHtml(outcome) {
      return '<p class="nacceptance-result-followup">' + ctx.esc(outcomeLabel(outcome)) + '</p>' +
        (outcome.note ? '<p class="nacceptance-result-outcome-note" data-user-content>' + ctx.esc(outcome.note) + '</p>' : '');
    }
    function operationResults(entry) {
      const results = new Map();
      const me = String(global.__teamCap?.meId || '').trim();
      for (const approval of entry.trace?.approvals || []) {
        // Task traces contain everyone's decisions. A global gate outcome is not a personal receipt.
        const mine = approval.myDecision || (me && approval.decisions?.find(row => String(row.userId || '') === me));
        const receipt = approvalResults.get(acceptanceKey(entry.taskId, approval.id));
        const decision = mine?.decision || (typeof mine === 'string' ? mine : '') ||
          (receipt && (({ approved: 'approve', rejected: 'reject' })[approval.status] || receipt.decision));
        if (approval.action === 'review' && ['approve', 'reject'].includes(decision)) {
          // A delayed pending trace cannot undo the final status returned by Hub.
          // The receipt is scoped to this exact request; new requests remain independent.
          const settledReceipt = ['approved', 'rejected'].includes(receipt?.status);
          const status = settledReceipt && (!approval.status || approval.status === 'pending')
            ? receipt.status : approval.status || receipt?.status;
          results.set(approval.id, { decision, status, note: mine?.note || receipt?.note || '' });
        }
      }
      for (const result of approvalResults.values()) {
        if (result.taskId === entry.taskId && !results.has(result.approvalId)) results.set(result.approvalId, result);
      }
      return results;
    }
    function operationHtml(entry, id, result) {
      return '<section class="nacceptance-result ' + (result.decision === 'reject' ? 'is-rejected' : 'is-confirmed') +
        '" data-acceptance-operation="' + ctx.esc(id) + '" aria-label="操作结果">' +
        '<header><span class="nacceptance-result-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.2 4.2L19 7"/></svg></span>' +
        '<span><b>操作结果</b><small data-user-content>' + ctx.esc(entry.task?.title || '') + '</small></span><em>只读</em></header>' +
        '<div class="nacceptance-result-body">' + outcomeHtml(result) + '</div></section>';
    }
    function resultsHtml(entry) {
      return [...operationResults(entry)].map(([id, result]) => operationHtml(entry, id, result)).join('');
    }

    function timeline(entries, messages = [], start = 0) {
      const owner = index => ctx._snap?.history?.messageIndices?.[index] ??
        ((Number(ctx._snap?.history?.messageStart) || 0) + index);
      const timestamp = value => Number(value) || Date.parse(value || '') || 0;
      const positions = [];
      for (const entry of entries) {
        if (entry.executionElsewhere || !entry.trace || !global.TaskTraceApproval) continue;
        const pending = new Map(pendingApprovals(entry).map(row => [row.id, row]));
        const results = operationResults(entry);
        const ids = new Set([...pending.keys(), ...results.keys()]);
        const taskId = String(entry.taskId || '');
        const outputIndices = taskId ? messages.reduce((indices, message, messageIndex) => {
          if (message?.role === 'assistant' && String(message.taskId || '') === taskId &&
              message.taskOutputKey && message.done !== false &&
              (!Array.isArray(message.blocks) || message.blocks.some(block => block?.kind === 'text' && block.done !== false))) indices.push(messageIndex);
          return indices;
        }, []) : [];
        for (const id of ids) {
          const key = JSON.stringify([entry.taskId, id]);
          const approval = entry.trace.approvals?.find(row => row.id === id);
          const me = String(global.__teamCap?.meId || '').trim();
          const direct = String(id || '').startsWith('direct:');
          // Pool reviews need an explicit assignment (or reviewer field) from
          // the server. Only direct reviews may fall back to the creator; a
          // namesake pool task must not gain a self-review position by guesswork.
          const reviewer = String(approval?.assignment?.userId || entry.task?.reviewerUserId ||
            (direct ? entry.task?.createdBy : '') || '').trim();
          const executor = String(entry.task?.assigneeUserId || entry.task?.executorUserId ||
            entry.task?.executionContext?.assigneeUserId || (direct ? entry.task?.createdBy : '') || '').trim();
          const samePerson = Boolean(me && reviewer && executor && me === reviewer && me === executor);
          let anchor = approvalAnchors.get(key);
          if (!anchor) {
            // Approval creation is immutable; resolution and task updates must not move its slot.
            const at = timestamp(approval?.createdAt) || timestamp(approval?.gate?.createdAt) ||
              timestamp(approval?.myDecision?.at) || timestamp(approval?.resolvedAt);
            let index = at ? messages.findIndex(message => timestamp(message.sentAt || message.completedAt) > at) : -1;
            if (index < 0) index = messages.length;
            // A partially loaded archive cannot locate a preceding card until older history arrives.
            if (index === 0 && owner(0) > 0) continue;
            anchor = { after: index ? owner(index - 1) : -1, at, order: approvalAnchors.size,
              messageKey: index ? String(messages[index - 1]?.taskOutputKey || '') : '' };
            if (messages.length || !at) approvalAnchors.set(key, anchor);
          }
          const matched = anchor.messageKey ? messages.findIndex(message => message.taskOutputKey === anchor.messageKey) : -1;
          let index = matched >= 0 ? matched + 1 : messages.findIndex((_, at) => owner(at) > anchor.after);
          if (index < 0) index = messages.length;
          /*
           * A review gate can be created before its executor publishes the
           * native task output. This is common when the executor and reviewer
           * are the same person: the approval timestamp then points before
           * the answer, so a timestamp-only anchor renders the card above the
           * delivery. For an explicitly self-assigned review only, prefer the
           * first completed output for this task when no matching output
           * already precedes the slot. The task output key is retained by the
           * renderer anchor, so the corrected slot remains stable while
           * history pages and streaming snapshots are reconciled.
           */
          if (samePerson && outputIndices.length && !outputIndices.some(outputIndex => outputIndex < index)) {
            const outputIndex = outputIndices.find(outputIndex => outputIndex >= index);
            if (outputIndex !== undefined) {
              const output = messages[outputIndex];
              const outputKey = String(output?.taskOutputKey || '');
              anchor = { ...anchor, after: owner(outputIndex), messageKey: outputKey };
              approvalAnchors.set(key, anchor);
              index = outputIndex + 1;
            }
          }
          if (index < start || (matched < 0 && index === 0 && owner(0) > anchor.after + 1)) continue;
          const body = results.has(id) ? operationHtml(entry, id, results.get(id)) : global.TaskTraceApproval.html(entry.trace.approvals, {
            variant: 'task', taskId: entry.taskId, taskTitle: entry.task?.title,
            blocksExecution: pending.get(id)?.action !== 'review' || ctx._collabEntryStatus(entry) !== 'completed',
          }, id);
          if (body) positions.push({ index, key, taskId: entry.taskId, at: anchor.at, order: anchor.order,
            html: '<div class="nchat-task-confirmation" data-chat-node="task-confirmation:approval:' +
            ctx.esc(key) + '" data-task-confirmation="' + ctx.esc(entry.taskId) + '">' + body + '</div>' });
        }
      }
      return positions.sort((left, right) => left.index - right.index ||
        (left.at && right.at ? left.at - right.at : 0) || left.order - right.order);
    }

    function _acceptanceResultHtml(text, resultKey, sourceIndex) {
      const value = String(text || '').trim();
      // Models occasionally add a short preface or Markdown heading before the
      // protocol marker. Keep the whole reply in the result card instead of
      // falling back to plain Markdown with no decision controls.
      const marker = value.match(/(^|\n)[ \t]*(?:[-*+][ \t]+|\d+[.)][ \t]+|>[ \t]*)?(?:#{1,6}[ \t]*)?【(验收分析结果|验收退回卡|验收确认卡)】[ \t]*/);
      if (!marker) return '';
      const kind = marker[2];
      const analysis = kind === '验收分析结果';
      const rejected = kind === '验收退回卡';
      const body = (value.slice(0, marker.index) + value.slice(marker.index + marker[0].length)).trim();
      const title = analysis ? '验收分析结果' : '自动验收审核结果';
      const state = analysis ? 'is-analysis' : (rejected ? 'is-rejected' : 'is-confirmed');
      const icon = rejected
        ? '<path d="m7 7 10 10M17 7 7 17"/>'
        : '<path d="m5 12.5 4.2 4.2L19 7"/>';
      const subtitle = analysis
        ? '分析已完成，请根据逐项依据在验收卡中确认或退回'
        : '自动验收会话已完成，结果与逐项依据已留在当前会话';
      const status = analysis ? '待人工确认' : (rejected ? '需要修改' : '已确认');
      const taskId = String(ctx._sessionOptions?.taskRef || ctx._sessionOptions?.taskId ||
        ctx._activeCollabTaskId || ctx._collaborationTaskId || ctx._collaborationTask?.id || '').trim();
      const taskEntry = taskId && ctx._collabTasks?.get?.(taskId);
      const approvals = taskEntry?.trace?.approvals || ctx._collaborationTrace?.approvals || [];
      const review = Array.isArray(approvals)
        ? approvals.find(item => item && item.action === 'review' && item.status === 'pending' && !item.myDecision) ||
          approvals.find(item => item && item.action === 'review')
        : null;
      const approvalId = String(ctx._sessionOptions?.approvalId || review?.id || '').trim() || (taskId ? 'direct:' + taskId : '');
      const actionKey = taskId + ':' + approvalId + ':analysis:' + String(resultKey || 'latest');
      const outcome = resultOutcomes.get(resultKey);
      const messages = ctx._snap?.messages || [];
      const messageIndex = sourceIndex ?? Number(String(resultKey).split(':')[0]);
      const latestUser = messages.findLastIndex(message => message?.role === 'user');
      const task = taskEntry?.task || ctx._collaborationTask || {};
      const subject = approvalId + ':' + String(review?.artifactVersionId || '');
      if ((review || task.status === 'done') && !resultApprovals.has(resultKey)) resultApprovals.set(resultKey, subject);
      const messageAt = Number(messages[messageIndex]?.sentAt || messages[messageIndex]?.completedAt || 0);
      const reviewAt = Number(review?.createdAt || 0);
      // Historical analysis must never acquire a later round's approval controls.
      const actionable = analysis && taskId && !task.reviewedAt && task.canReview !== false &&
        (review ? review.status === 'pending' && !review.myDecision && approvalId === review.id : task.status === 'done') &&
        !(messageAt && reviewAt && messageAt < reviewAt) &&
        resultApprovals.get(resultKey) === subject && Number.isInteger(messageIndex) && messageIndex > latestUser &&
        !outcome && !acceptanceResultActions.has(actionKey) &&
        !['approve', 'reject'].includes(acceptanceHandoffs.get(acceptanceKey(taskId, approvalId)));
      const actions = actionable
        ? '<div class="nacceptance-result-actions" data-acceptance-message-key="' + ctx.esc(resultKey) + '" data-acceptance-result-key="' + ctx.esc(actionKey) + '" data-acceptance-result-task="' + ctx.esc(taskId) + '" data-acceptance-result-approval="' + ctx.esc(approvalId) + '">' +
          '<label class="nacceptance-result-note"><span>验收意见 <small>退回时必填</small></span><textarea rows="2" maxlength="2000" data-acceptance-result-note placeholder="确认结果，或写明需要修改的内容"></textarea></label>' +
          '<label class="nacceptance-result-files"><input type="file" multiple data-acceptance-result-file hidden><span>添加返修资料（可选）</span><small data-acceptance-result-file-list></small></label>' +
          '<label class="nacceptance-result-analysis"><span>补充分析项 <small>可选</small></span><textarea rows="2" maxlength="2000" data-acceptance-result-analysis placeholder="还需要核对什么？填写后可继续分析"></textarea></label>' +
          '<div class="nacceptance-result-buttons"><button type="button" data-acceptance-result-action="analyze">继续分析</button><button type="button" data-acceptance-result-action="reject">退回修改</button><button type="button" class="primary" data-acceptance-result-action="approve">确认验收</button></div></div>'
        : '';
      return '<section class="nacceptance-result ' + state + '" aria-label="' + title + '">' +
        '<header><span class="nacceptance-result-icon" aria-hidden="true"><svg viewBox="0 0 24 24">' + icon + '</svg></span>' +
        '<span><b>' + title + '</b><small>' + (actionable ? subtitle : '结果已保留，仅供查阅') + '</small></span>' +
        '<em>' + (outcome ? '操作结果' : !actionable && analysis ? '历史记录' : status) + '</em></header>' +
        '<div class="nacceptance-result-body">' + rich(readableResult(body)) +
        (outcome ? outcomeHtml(outcome) : actions) + '</div></section>';
    }

    async function _acceptanceResultAction(button) {
      const card = button?.closest?.('[data-acceptance-result-key]');
      if (!card || button.disabled) return;
      const taskId = String(card.getAttribute('data-acceptance-result-task') || '').trim();
      const approvalId = String(card.getAttribute('data-acceptance-result-approval') || '').trim();
      const key = String(card.getAttribute('data-acceptance-result-key') || '');
      const messageKey = String(card.getAttribute('data-acceptance-message-key') || '');
      if (acceptanceResultActions.has(key) || pendingActions.has(key)) return;
      const currentEpoch = epoch;
      const decision = button.getAttribute('data-acceptance-result-action');
      if (!['analyze', 'approve', 'reject'].includes(decision)) return;
      if (decision === 'analyze') {
        const analysisInput = card.querySelector('[data-acceptance-result-analysis]');
        const prompt = String(analysisInput?.value || '').trim();
        if (!prompt) {
          if (analysisInput) analysisInput.focus();
          let error = card.querySelector('[data-acceptance-result-error]');
          if (!error) { error = document.createElement('p'); error.dataset.acceptanceResultError = ''; card.append(error); }
          error.textContent = '请填写需要补充核对的内容，再继续分析。';
          return;
        }
        const composer = ctx._mount()?.querySelector?.('#nchatInput');
        if (!composer) {
          let error = card.querySelector('[data-acceptance-result-error]');
          if (!error) { error = document.createElement('p'); error.dataset.acceptanceResultError = ''; card.append(error); }
          error.textContent = '当前对话输入框不可用，请刷新后重试。';
          return;
        }
        const followUp = '请补充验收分析：\n' + prompt;
        composer.value = [String(composer.value || '').trim(), followUp].filter(Boolean).join('\n\n');
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        composer.focus();
        acceptanceResultActions.add(key);
        resultOutcomes.set(messageKey, { decision });
        const notice = document.createElement('p');
        notice.className = 'nacceptance-result-followup';
        notice.textContent = '已填入对话框，请按需选择插件后发送。';
        card.replaceChildren(notice);
        invalidate();
        return;
      }
      const note = String(card.querySelector('[data-acceptance-result-note]')?.value || '').trim();
      if (decision === 'reject' && !note) {
        const input = card.querySelector('[data-acceptance-result-note]');
        if (input) input.focus();
        let error = card.querySelector('[data-acceptance-result-error]');
        if (!error) { error = document.createElement('p'); error.dataset.acceptanceResultError = ''; card.append(error); }
        error.textContent = '请写明需要修改的内容，再退回。';
        return;
      }
      const files = [...(card.querySelector('[data-acceptance-result-file]')?.files || [])];
      if (files.length > 20) return;
      pendingActions.add(key);
      card.setAttribute('aria-busy', 'true');
      card.querySelectorAll('button,input,textarea').forEach(node => { node.disabled = true; });
      try {
        const api = global.SoduWorkAPI;
        const attachmentIds = [];
        if (decision === 'reject' && files.length) {
          const direct = approvalId.startsWith('direct:');
          const upload = direct ? api?.uploadTaskReworkMaterial : api?.uploadApprovalReworkMaterial;
          if (!upload || (direct ? !taskId : !approvalId)) throw Error('当前客户端暂不支持上传返修资料，请刷新后重试');
          for (const file of files) {
            const result = await upload(direct ? taskId : approvalId, file);
            const row = result?.attachment || result?.item || result;
            const id = String(row?.id || row?.attachmentId || '').trim();
            if (!id) throw Error('返修资料上传后没有返回附件标识');
            attachmentIds.push(id);
          }
        }
        let result;
        if (approvalId.startsWith('direct:')) {
          result = decision === 'approve' ? await api.reviewTask(taskId, note) :
            await api.rejectArtifact(taskId, note, true, attachmentIds);
        } else {
          result = await api.decideApproval(approvalId, decision, note, undefined, attachmentIds);
        }
        if (!result || result.ok === false) throw Error('验收意见没有提交成功，请刷新后重试');
        if (currentEpoch !== epoch) return;
        acceptanceResultActions.add(key);
        const outcome = { decision, note, status: result.request?.status || '' };
        resultOutcomes.set(messageKey, outcome);
        acceptanceHandoffs.set(acceptanceKey(taskId, approvalId), decision);
        const notice = document.createElement('p');
        notice.className = 'nacceptance-result-followup';
        notice.textContent = outcomeLabel(outcome);
        card.replaceChildren(notice);
        /*
         * Same-person acceptance temporarily reuses the execution session. Clear its acceptance
         * marker after submitting the decision so ordinary follow-up and rework can continue;
         * preserve dedicated acceptance-session metadata.
         */
        if (ctx._sessionOptions?.acceptanceExecutionSession === true) {
          ctx._sessionOptions = { ...ctx._sessionOptions, acceptanceExecutionSession: false,
            acceptanceSession: false, acceptanceMode: 'manual', approvalId: '', acceptanceAttachmentIds: [] };
        }
        invalidate();
        // A failed refresh cannot turn an accepted decision into a retryable form.
        try { await ctx._loadCollabTask?.(taskId); } catch (_) { /* Hub accepted the decision. */ }
        if (currentEpoch === epoch) invalidate();
      } catch (error) {
        if (currentEpoch !== epoch || acceptanceResultActions.has(key)) return;
        card.removeAttribute('aria-busy');
        card.querySelectorAll('button,input,textarea').forEach(node => { node.disabled = false; });
        let output = card.querySelector('[data-acceptance-result-error]');
        if (!output) { output = document.createElement('p'); output.dataset.acceptanceResultError = ''; card.append(output); }
        output.textContent = String(error?.message || '验收意见没有提交成功，请刷新后重试');
      } finally {
        if (currentEpoch === epoch) pendingActions.delete(key);
      }
    }

    function pendingApprovals(entry) {
      // A cloud conversation is already executing on the assigned runner.
      // Its task trace may contain workflow approvals used by the generic
      // task surface, but surfacing those as an actionable card here is
      // misleading and blocks the ordinary cloud result presentation.
      // Cloud handles can be represented by the active snapshot, the
      // controller snapshot, or the execution projection while a passive
      // view is being resumed. Treat all of those shapes as the same cloud
      // conversation so a stale task trace cannot reintroduce an approval
      // card during the short reopen window.
      const cloudConversation = ctx._snap?.cloudHandoff?.phase === 'committed' ||
        ctx._snap?.snapshot?.cloudHandoff?.phase === 'committed' ||
        ctx._snap?.execution?.cloud === true || ctx._snap?.execution?.mode === 'cloud';
      const acceptanceConversation = ctx._sessionOptions?.acceptanceSession === true ||
        ctx._sessionOptions?.acceptanceExecutionSession === true;
      const activeTaskId = String(ctx._sessionOptions?.taskRef || ctx._activeCollabTaskId ||
        ctx._collaborationTaskId || '').trim();
      const messages = Array.isArray(ctx._snap?.messages) ? ctx._snap.messages : [];
      const latestUser = messages.findLastIndex?.(message => message?.role === 'user') ??
        messages.reduce((last, message, index) => message?.role === 'user' ? index : last, -1);
      const analysisAfterLatestUser = latestUser >= 0 && activeTaskId && activeTaskId === String(entry.taskId || '').trim() &&
        messages.slice(latestUser + 1).some(message => message?.role === 'assistant' &&
          (message.blocks || []).some(block => block?.kind === 'text' &&
            /【验收分析结果】/.test(String(block.text || ''))));
      /*
       * task.updated may arrive before taskTrace after acceptance elsewhere. reviewedAt is
       * authoritative completion evidence; stale approval snapshots must not restore a
       * pending-review card.
       */
      const taskReviewed = Boolean(entry.task?.reviewedAt || entry.task?.reviewed_at);
      return cloudConversation || acceptanceConversation || taskReviewed || analysisAfterLatestUser ? [] : (entry.trace.approvals || []).filter(a =>
        a.status === 'pending' && !a.myDecision && !acceptanceHandoffs.has(acceptanceKey(entry.taskId, a.id)));
    }

    function bind(list) {
      if (list && list.dataset && !list.dataset.acceptanceResultBound) {
        list.dataset.acceptanceResultBound = '1';
        list.addEventListener('click', event => {
          const button = event.target.closest?.('[data-acceptance-result-action]');
          if (button) { event.preventDefault(); void _acceptanceResultAction(button); }
        });
    }
    }

    function bindApproval(root, id, entry) {
      const boundEpoch = epoch;
      TaskTraceApproval.bind(root, { trace: entry.trace, opts: {
        taskId: id,
        onAcceptanceOpened: (approvalId, mode) => {
          if (boundEpoch !== epoch) return;
          const key = acceptanceKey(id, approvalId);
          acceptanceHandoffs.set(key, mode || 'manual');
          approvalResults.set(key, { decision: mode || 'manual', taskId: id, approvalId });
          invalidate();
        },
        onAcceptanceClosed: (block, outcome) => {
          if (boundEpoch !== epoch || !outcome) return false;
          const approvalId = block.getAttribute('data-tfd-approval-id');
          if (!entry.trace?.approvals?.some(approval => approval.id === approvalId && approval.action === 'review')) return false;
          const key = acceptanceKey(id, approvalId);
          acceptanceHandoffs.set(key, outcome.decision);
          approvalResults.set(key, { ...outcome, taskId: id, approvalId });
          invalidate();
          return true;
        },
      }, refresh: () => ctx._loadCollabTask(id) });
    }

    return { reset, html: _acceptanceResultHtml, pendingApprovals, resultsHtml, timeline, bind, bindApproval };
  }
  global.ChatAcceptanceResults = { create };
})(window);
