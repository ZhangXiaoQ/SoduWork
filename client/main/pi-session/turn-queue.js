'use strict';

function _attachmentName(item) {
  const value = String((item && (item.name || item.filename || item.path)) || '');
  return value.replace(/\\/g, '/').split('/').pop() || '';
}

/* Identify the paused queue item and its failure reason. */
function pauseLabel(item, result) {
  const label = String((item && (item.options && item.options.taskTitle || item.text)) || '').trim().slice(0, 40);
  const firstAttachment = Array.isArray(item && item.attachments) && item.attachments.length
    ? _attachmentName(item.attachments[0]) : '';
  const why = String((result && (result.reason || result.failureKind)) || '').trim().slice(0, 140);
  return '上一项' + (label ? '「' + label + '」' : firstAttachment ? '「附件 ' + firstAttachment + '」' : '') +
    '尚未完成' + (why ? '：' + why : '') + '，请处理后继续队列';
}

function createTurnQueue(now, onCompleted) {
  const clock = typeof now === 'function' ? now : Date.now;
  const items = [];
  let sequence = 0;
  let active = null;
  let pauseReason = '';
  // Keep automatic turn failures separate from an explicit pause requested by
  // guidance/stop/recovery controls.  A fresh message may release only the
  // former when the queue is otherwise idle.
  let pauseSource = '';
  let turnFailure = null;
  let pauseRevision = 0;
  const taskTurns = new Map();
  // Retain recent receipts so an IPC retry cannot enqueue the same user
  // submission again after steering has already consumed it.
  const submissions = new Map();
  const { resultState } = require('./task-turn');

  function pauseTurn(item, result) {
    pauseReason = pauseLabel(item, result);
    pauseSource = 'turn';
    // Keep the failed submission distinct from the previous SDK transcript:
    // preflight can fail before a new user/assistant message is appended.
    turnFailure = { queueId: item.id,
      reason: String(result?.reason || result?.failureKind || '本轮请求未完成') };
  }

  function add(payload) {
    const rawOptions = (payload && payload.options) || {};
    const taskId = String(rawOptions.taskId || '');
    const submissionId = String(rawOptions.submissionId || '').trim();
    const accepted = submissionId && submissions.get(submissionId);
    if (accepted && (!accepted.settled || !(rawOptions.retry && (taskId || rawOptions.modelRecovery)))) return accepted;
    // Allow one active or queued turn per requirement and explicitly reject duplicates with null.
    // Do not alias a new submission to an older turn's receipt.
    // Otherwise the new message would be silently discarded while appearing accepted.
    const duplicate = taskId && [active, ...items].find(item => item && item.options.taskId === taskId);
    if (duplicate) return null;
    let settle;
    const completion = new Promise((resolve) => { settle = resolve; });
    const options = { ...rawOptions };
    if (Array.isArray(rawOptions.plugins)) options.plugins = rawOptions.plugins.map((item) => ({ ...item }));
    if (Array.isArray(rawOptions.pluginIds)) options.pluginIds = rawOptions.pluginIds.slice();
    if (Array.isArray(rawOptions.skills)) options.skills = rawOptions.skills.slice();
    const item = {
      id: 'turn-' + clock().toString(36) + '-' + (++sequence).toString(36),
      text: String((payload && payload.text) || ''),
      attachments: Array.isArray(payload && payload.attachments) ? payload.attachments.slice() : [],
      options,
      at: clock(),
      completion,
      settle,
      settled: false,
    };
    if (submissionId) submissions.set(submissionId, item);
    const resumeAfterTerminalAt = Number(options.resumeAfterTerminalAt || 0);
    if (resumeAfterTerminalAt > 0) {
      // A message explicitly sent after a terminal provider stall is the
      // user's recovery instruction. Keep FIFO between such messages, but run
      // them before older dependent work that was queued before the failure.
      let index = 0;
      while (index < items.length &&
          Number(items[index].options.resumeAfterTerminalAt || 0) === resumeAfterTerminalAt) index++;
      items.splice(index, 0, item);
      if (!active && pauseReason && pauseSource === 'turn') {
        pauseRevision++;
        pauseReason = '';
        pauseSource = '';
      }
    }
    else if (options.retry && (taskId || options.modelRecovery)) {
      items.unshift(item); pauseReason = ''; pauseSource = '';
    }
    else items.push(item);
    return item;
  }

  function complete(item, result) {
    if (!item || item.settled) return false;
    item.settled = true;
    item.settle(result);
    const receipts = [...submissions].filter(([, value]) => value.settled);
    for (const [id] of receipts.slice(0, Math.max(0, receipts.length - 128))) submissions.delete(id);
    return true;
  }

  function take() { return items.shift() || null; }
  function find(id) { return items.find(item => item.id === id) || null; }
  function prioritize(id) {
    const index = items.findIndex(item => item.id === id);
    if (index < 0) return null;
    const beforeId = items[index + 1]?.id || '';
    const item = items.splice(index, 1)[0]; items.unshift(item);
    return { item, beforeId };
  }

  function stopActive() {
    if (!active) return null;
    active.stopRequested = true;
    return active;
  }

  function markStarted(item = active) {
    // Only the runtime's actual start acknowledgement calls this. Queue
    // admission, preflight and controlled dispatch are not execution evidence.
    if (!item || item.options.controlled || typeof item.options.onStarted !== 'function') return Promise.resolve();
    item.executionStarted = true;
    if (item.startReceiptDone) return Promise.resolve();
    if (!item.startReceipt) {
      item.startReceipt = Promise.resolve().then(() => item.options.onStarted()).then(() => {
        item.startReceiptDone = true;
      }).catch(error => {
        item.startReceipt = null;
        console.warn('[task-turn] 开始执行收据待重试：' + String(error?.message || error));
      });
    }
    return item.startReceipt;
  }

  async function run(item, send) {
    active = item;
    const startingPauseRevision = pauseRevision;
    const taskId = item.options.taskId;
    const record = (status, reason = '') => {
      if (taskId) taskTurns.set(taskId, { taskId, title: item.options.taskTitle || '',
        queueId: item.id, status, reason, executor: item.options.executor || 'native', at: clock() });
      while (taskTurns.size > 100) taskTurns.delete(taskTurns.keys().next().value);
    };
    let result;
    try {
      if (typeof item.options.beforeTurn === 'function') await item.options.beforeTurn({ modelName: item.options.modelName });
      record('running');
      try {
        result = await send();
      } catch (error) {
        if (!item.stopRequested) throw error;
        result = { ok: true, cancelled: true, manualStop: true };
      }
      let status = resultState(result);
      if (item.stopRequested && status !== 'completed') {
        status = 'stopped';
        result = { ...(result || {}), ok: true, cancelled: true, manualStop: true };
        delete result.reason;
      }
      record(status);
      // A late stop receipt must not erase a newer explicit pause (for
      // example, guidance timed out while this tool was still finishing).
      if (status === 'stopped') {
        if (pauseRevision === startingPauseRevision) { pauseReason = ''; pauseSource = ''; }
      }
      else if (status !== 'completed' && pauseRevision === startingPauseRevision) {
        const terminalAt = result && result.failureKind === 'agent-stall'
          ? Number(result.terminalAt || 0) : 0;
        const resumesTerminalStall = terminalAt > 0 &&
          Number(items[0]?.options?.resumeAfterTerminalAt || 0) === terminalAt;
        if (resumesTerminalStall) {
          pauseReason = '';
          pauseSource = '';
        } else {
          /*
           * Include the item name and failure reason in the paused-queue banner.
           */
          pauseTurn(item, result);
        }
      }
      if (item.executionStarted) await markStarted(item);
      if (typeof item.options.afterTurn === 'function') await item.options.afterTurn(status, result);
      // Freeze final files before the next queued instruction can overwrite
      // them. Storage/network work runs separately and cannot pause the queue.
      if (status === 'completed' && typeof onCompleted === 'function') {
        try { await onCompleted(result); } catch (_) { /* Delivery sync never changes task success. */ }
      }
    } catch (error) {
      result = { ok: false, reason: String(error && error.message || error),
        ...require('../../core/token-quota').fields(error) };
      record('failed', result.reason);
      if (pauseRevision === startingPauseRevision) {
        pauseTurn(item, { reason: String(error && error.message || error) });
      }
      if (typeof item.options.afterTurn === 'function') {
        if (item.executionStarted) await markStarted(item);
        try { await item.options.afterTurn('failed'); } catch (_) { /* Keep the queue paused when the receipt service is unavailable. */ }
      }

    } finally {
      complete(item, result);
      active = null;
    }
    return result;
  }

  function edit(id, text) {
    const item = items.find(x => x.id === id);
    if (!item || !String(text || '').trim()) return false;
    item.text = String(text).trim();
    return true;
  }
  function move(id, offset) {
    const index = items.findIndex(x => x.id === id);
    if (index < 0) return false;
    const target = Math.max(0, Math.min(items.length - 1, index + (offset < 0 ? -1 : 1)));
    items.splice(target, 0, items.splice(index, 1)[0]);
    return true;
  }

  // Reorder by stable IDs in one operation. Active/stale turns are never moved.
  function moveBefore(id, beforeId) {
    const index = items.findIndex(item => item.id === id);
    if (index < 0 || (beforeId && !items.some(item => item.id === beforeId))) return false;
    if (id === beforeId) return true;
    const item = items.splice(index, 1)[0];
    const target = beforeId ? items.findIndex(next => next.id === beforeId) : items.length;
    items.splice(target, 0, item);
    return true;
  }

  function cancel(id, result) {
    const index = items.findIndex((item) => item.id === String(id || ''));
    if (index < 0) return null;
    const item = items.splice(index, 1)[0];
    if (item.options.taskId) taskTurns.set(item.options.taskId, {
      taskId: item.options.taskId, title: item.options.taskTitle || '', status: 'cancelled', at: clock(),
    });
    if (typeof item.options.afterTurn === 'function') {
      Promise.resolve(item.options.afterTurn('stopped')).catch(() => {
        pauseReason = '已从队列移除，但任务回执未同步，请刷新后确认';
        pauseSource = 'external';
      });
    }
    complete(item, result || { ok: true, cancelled: true, queued: true });
    return item;
  }

  function clear(result) {
    const removed = items.slice();
    removed.forEach((item) => cancel(item.id, result || { ok: false, reason: '会话已关闭' }));
    return removed.length;
  }

  // A completed/failed turn can leave an automatic pause receipt behind after
  // its queue item has settled.  Treat a new idle submission as a new turn,
  // but never clear a live turn, queued work, or an explicit control pause.
  function resetIfIdle() {
    if (active || items.length || !pauseReason || pauseSource !== 'turn') return false;
    pauseRevision++;
    pauseReason = '';
    pauseSource = '';
    return true;
  }

  function view() {
    return items.map((item, index) => ({
      id: item.id,
      text: item.text,
      at: item.at,
      position: index + 1,
      taskId: item.options.taskId || '',
      taskTitle: item.options.taskTitle || '',
      executor: item.options.executor || 'native',
      submissionId: item.options.submissionId || '',
      attachments: item.attachments.map(_attachmentName).filter(Boolean),
    }));
  }

  return { add, complete, take, find, prioritize, stopActive, markStarted, cancel, clear, view, run, edit, move, moveBefore,
    active: () => active, blocked: () => Boolean(active || pauseReason),
    pause: (reason) => { pauseRevision++; pauseReason = reason || '队列已暂停'; pauseSource = 'external'; },
    resume: () => { pauseRevision++; pauseReason = ''; pauseSource = ''; },
    resetIfIdle,
    state: () => ({ paused: Boolean(pauseReason), reason: pauseReason,
      failure: pauseSource === 'turn' && turnFailure ? { ...turnFailure } : null,
      activeQueueId: active && active.id || '', activeSubmissionId: active && active.options.submissionId || '',
      activeTaskId: active && active.options.taskId || '', tasks: Array.from(taskTurns.values()) }),
    size: () => items.length };
}

module.exports = { createTurnQueue, _attachmentName };
