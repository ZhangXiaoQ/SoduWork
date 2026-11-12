'use strict';
// Stable Runner control messages are UI copy. Unknown native errors remain intact.
const messages = new Map([
  ['The session is already changing or stopping', '会话正在切换权限或停止，请稍候'],
  ['This running session cannot safely change permissions; stop it first', '当前会话暂时无法切换权限，请先停止执行'],
  ['Permission change cancelled because the session was stopped', '会话已停止，权限切换已取消'],
  ['Permission change cancelled', '权限切换已取消'],
  ['The Agent did not reach a safe permission-change boundary in time', '当前操作尚未结束，权限未切换，请稍后重试'],
  ['Native session identity could not be verified', '无法确认原会话，已停止权限切换，请重新打开会话'],
  ['The Agent did not confirm the new permissions; the saved session is preserved', 'Agent 未确认新权限，已保留原权限和会话进度'],
  ['This Agent cannot safely resume its native session', '当前 Agent 暂不支持在执行中恢复原会话，请先停止再切换权限'],
  ['A tool did not finish safely; inspect its result before continuing', '当前操作的结果尚未确认，请检查结果后继续'],
  ['The Agent did not acknowledge a safe cancellation', 'Agent 未确认当前操作已结束，权限未切换'],
  ['The Agent did not confirm a safe cancellation', 'Agent 未确认当前操作已结束，权限未切换'],
  ['Stopped during permission change', '会话已停止，权限切换已取消'],
  ['Unable to safely change access', '权限切换未完成，原权限保持不变'],
  ['Permission change in progress; this operation was not started', '正在切换权限，此操作尚未执行'],
  ['Stale access policy revision', '权限状态已变化，请重新选择'],
  ['Session not found', '会话不在了'],
]);
function message(value) {
  let text = String(value || '');
  // Old Runner archives contain the serialized, sanitized Harness2 envelope.
  // Unwrap only this known failure type; preserve all other native diagnostics.
  if (text.length <= 65536 && text.trimStart().startsWith('{')) {
    try {
      const error = JSON.parse(text);
      if (error?.name === 'Harness2Error' && typeof error.message === 'string' && error.message.trim())
        text = error.message;
    } catch (_) { /* Truncated or non-JSON diagnostics remain unchanged. */ }
  }
  return messages.get(text) || text;
}
module.exports = { message };
