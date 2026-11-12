'use strict';

// A queue host does not run its native model during delegated execution.
// Project the existing controller receipt instead of the host's stale clock.
function project(receipt, turnId, now = Date.now()) {
  if (!receipt) return null;
  const running = receipt.status === 'running';
  const waiting = ['waiting', 'failed', 'blocked'].includes(receipt.status);
  const start = Number(receipt.timing?.startedAt);
  const end = running ? now : Number(receipt.timing?.updatedAt);
  const elapsedMs = Number.isFinite(start) && start > 0 && Number.isFinite(end) && end >= start
    ? end - start : null;
  return {
    status: running ? 'streaming' : waiting ? 'waiting-user' : 'idle',
    statusText: receipt.reason || '',
    execution: {
      running, elapsedMs, timingTurn: String(turnId || ''),
      waitingPermission: false, stalled: false, longRunning: false,
      stopped: false, stopKind: '', terminalAt: 0, finalizing: false,
      reason: receipt.reason || '', quality: {},
      controlled: { taskId: receipt.taskId || '', status: receipt.status,
        waitingReason: receipt.waitingReason || '', reason: receipt.reason || '' },
    },
  };
}

module.exports = { project };
