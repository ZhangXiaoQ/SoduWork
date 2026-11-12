'use strict';
const liveOutput = require('../conversation/task-live-output');
const modelErrors = require('./model-errors');

// Executor adapter for the EXISTING conversation queue. It owns no queue and
// never starts a model turn alongside a workflow/remote execution.
function executionSpec(task, requested = {}) {
  const routing = task.workRouting || {};
  const context = { ...(task.executionContext || routing.executionContext || {}), ...(requested.executionContext || {}) };
  if (requested.executionChoice === 'native') {
    // Honor the executor's explicit current selection over stale workflow, machine, or model settings.
    // requirement-context and Hub row locking still validate state, ownership, and directory changes.
    const repo = task.repo || context.repo || {};
    return { mode: 'native', bindingId: '', agentId: String(requested.agentId || ''),
      assigneeType: 'agent', repo, repoId: String(task.repoId || context.repoId || repo.id || ''),
      model: String(requested.model || ''), reasoningEffort: String(requested.reasoningEffort || ''),
      context: { strategy: 'direct', runner: { mode: 'local' } }, inputs: {} };
  }
  const agent = context.agent || {};
  const agentId = requested.agentId || agent.id || agent.key || context.agentId || task.agentId ||
    context.agentKind || (agent.cli ? 'local:' + agent.cli : '') || '';
  const bindingId = requested.bindingId || task.workflowBindingId || context.workflowBindingId ||
    context.workflowId || context.plugin && context.plugin.bindingId || routing.workflowBindingId || routing.selectedWorkflowBindingId;
  const workflow = bindingId || routing.selectedStrategy === 'workflow' || context.strategy === 'workflow';
  if (workflow && !bindingId) throw new Error('需求选择的工作流尚不可用，请补充执行配置');
  const repo = requested.repo || task.repo || context.repo || {};
  const repoId = task.repoId || context.repoId || repo.id || '';
  const runner = context.runner || {};
  const remote = runner.mode === 'remote' || runner.remote === true ||
    (context.location || {}).mode === 'remote' || /^runner:/.test(String(agentId));
  const assigneeType = requested.assigneeType || context.assigneeType || 'agent';
  const mode = workflow ? 'workflow' : repoId || repo.path || remote || assigneeType === 'squad' ? 'dispatch' : 'native';
  return { mode, bindingId, repo: { ...repo, ...(repoId ? { id: repoId } : {}) }, repoId,
    agentId, assigneeType,
    model: requested.model !== undefined ? requested.model : context.model || task.model || '', context,
    reasoningEffort: requested.reasoningEffort || context.reasoningEffort || '',
    inputs: requested.inputs || {} };
}

function outcome(value, mode) {
  const status = String(value && (value.state || value.status) || '').toLowerCase();
  // In workflow mode ONLY the whole workflow can release the next turn.
  if ((mode === 'workflow' ? ['succeeded'] : ['done', 'completed', 'succeeded']).includes(status)) return 'completed';
  if (['failed', 'rework', 'blocked', 'interrupted'].includes(status)) return 'failed';
  if (['cancelled', 'canceled', 'stopped', 'aborted'].includes(status)) return 'stopped';
  return '';
}

function create({ request, task, spec, scope, interval = 1500, wait = ms => new Promise(r => setTimeout(r, ms)) }) {
  const route = '/tasks/' + encodeURIComponent(task.id);
  let runId = '', stopping = false, stopAcknowledged = false, stopPromise = null;
  let latest = null;
  const continuation = spec.continuationRef ? require('./controlled-task-continuation.cjs').create({
    request, route, ref: spec.continuationRef, scope,
  }) : null;
  async function cancel() {
    stopping = true;
    if (stopAcknowledged) return { ok: true, accepted: false, stopped: true, alreadyStopped: true };
    if (stopPromise) return stopPromise;
    // Do not free the queue until the authoritative executor acknowledges stop.
    // Keep one in-flight request per execution so repeated UI/queue signals
    // share the same acknowledgement instead of issuing duplicate /ai-stop
    // calls.  A rejection is intentionally preserved for the polling loop,
    // which will retry at its normal interval.
    stopPromise = Promise.resolve().then(() => {
      if (!runId) return { ok: true, accepted: true, stopping: true, stopped: false };
      return request(spec.mode === 'workflow' ? '/plugin-runs/' + encodeURIComponent(runId) + '/cancel'
        : route + '/ai-stop', { reason: '用户在当前对话中停止需求' }).then((response) => {
          if (response && response.ok === false) {
            throw Error(response.reason || '执行机未确认停止');
          }
          return response;
        });
    }).then((result) => {
      // A stop requested before the remote run has an id remains pending; the
      // execution loop must issue the authoritative stop after it starts.
      if (result && result.stopped === false) return result;
      stopAcknowledged = true;
      return { ok: true, accepted: true, stopped: true };
    }).finally(() => { stopPromise = null; });
    return stopPromise;
  }
  async function execute(handle, text, files) {
    const startedAt = Date.now();
    let waitingAt = null;
    const changed = value => {
      // Repeated failed reads keep the original pause boundary.
      waitingAt = value.status === 'waiting' ? (waitingAt ?? Date.now()) : null;
      handle.taskExecutionChanged({ ...value,
        timing: { startedAt, updatedAt: waitingAt ?? Date.now() } });
    };
    const outputs = new Map();
    const cursors = new Map();
    async function readOutput(ref) {
      const since = cursors.get(ref) || 0;
      const page = await request(route + '/ai-session?ref=' + encodeURIComponent(ref) + '&since=' + since);
      if (page.ok === false) throw new Error('执行输出暂时不可用');
      if (page.ref && page.ref !== ref) throw new Error('执行输出标识不一致');
      // Attribute output to the Hub's execution receipt, never to the queue host or requested selection.
      const sourceAgent = require('../conversation/agent-source.cjs').normalize({
        agentId: page.activeExecutionSelection?.agentId || page.engine || page.cli,
        runId: ref,
      });
      if (!outputs.has(ref)) outputs.set(ref, liveOutput.create(handle, task.id, { sourceAgent, coalesceText: true }));
      const output = outputs.get(ref);
      output.setSourceAgent(sourceAgent);
      const items = continuation ? continuation.items(page) : page.items;
      // An older Hub can learn the runtime after its first page. Keep already consumed events idempotent.
      await output.consume(ref, (items || []).filter(item => Number(item.seq) > since));
      const last = Math.max(since, Number(page.last || 0), ...(page.items || []).map(x => Number(x.seq) || 0));
      const drained = last >= Number(page.seq || last);
      // A terminal receipt can omit the final text event. Flush only after all
      // pages arrive, and before advancing the cursor so failed saves retry.
      const pageStatus = continuation ? { status: continuation.status(page) } : page;
      if (drained && outcome(pageStatus, 'dispatch')) await output.finish(ref);
      cursors.set(ref, last);
      return { page, drained };
    }
    handle.appendTaskMessage('user', text, files, task.id);
    changed({ taskId: task.id, runId: '', executor: spec.mode, status: 'running',
      reason: '', waitingReason: '', sameMessageStream: true });
    if (stopping) return { ok: true, cancelled: true };
    let started;
    try {
      started = continuation ? await continuation.start(text, files) :
        await request(spec.mode === 'workflow' ? route + '/plugin-runs' : route + '/ai-dispatch',
        spec.mode === 'workflow' ? { bindingId: spec.bindingId, inputs: spec.inputs, instruction: text,
          repoId: spec.repoId, execution: spec.context.execution || {}, conversationTurn: scope }
          : { assigneeId: spec.agentId, assigneeType: spec.assigneeType || 'agent', brief: text, repo: spec.repo, model: spec.model,
            reasoningEffort: spec.reasoningEffort,
            executionContext: { ...spec.context, strategy: 'direct' }, conversationTurn: scope });
    } catch (error) {
      if (error.authRequired || error.permissionRequired) {
        const reason = error.authRequired ? '登录已过期，请重新连接后继续' : '当前连接没有执行此操作的权限';
        changed({ taskId: task.id, runId: '', executor: spec.mode,
          status: 'waiting', waitingReason: error.authRequired ? 'auth' : 'permission',
          authRequired: !!error.authRequired, permissionRequired: !!error.permissionRequired, reason });
        return { ok: true, paused: true, authRequired: !!error.authRequired,
          permissionRequired: !!error.permissionRequired, reason };
      }
      throw error;
    }
    runId = String((spec.mode === 'workflow' ? started.id || started.runId || started.workflowRunId
      : started.ref || started.issueId || (started.execution || {}).ref || started.runId) || '');
    if (!runId) throw new Error('执行机未返回运行标识；请查看需求记录，避免重复派活');
    for (;;) {
      if (stopping && !stopAcknowledged) {
        try { await cancel(); }
        catch (_) {
          changed({ taskId: task.id, runId, executor: spec.mode,
            status: 'waiting', waitingReason: 'stop', reason: '停止尚未确认；后续需求继续等待' });
          await wait(interval); continue;
        }
      }
      let drained = true;
      try {
        if (spec.mode === 'workflow') {
          latest = await request('/plugin-runs/' + encodeURIComponent(runId));
          // Includes prior attempts: retrying a node must not erase its output.
          const refs = [...new Set((latest.nodes || []).filter(n => (n.executor || {}).kind === 'ai')
            .map(n => n.executor.ref).filter(Boolean))];
          for (const ref of refs) {
            const result = await readOutput(ref);
            drained = drained && result.drained;
          }
        } else {
          const result = await readOutput(runId);
          latest = result.page;
          drained = result.drained;
        }
        if (drained && outcome(continuation ? { status: continuation.status(latest) } : latest, spec.mode)) {
          for (const [ref, output] of outputs) await output.finish(ref);
        }
      } catch (error) {
        if (error.authRequired || error.permissionRequired) {
          const reason = error.authRequired ? '登录已过期，请重新连接后继续' : '当前连接没有执行此操作的权限';
          changed({ taskId: task.id, runId, executor: spec.mode,
            status: 'waiting', waitingReason: error.authRequired ? 'auth' : 'permission',
            authRequired: !!error.authRequired, permissionRequired: !!error.permissionRequired, reason });
          return { ok: true, paused: true, authRequired: !!error.authRequired,
            permissionRequired: !!error.permissionRequired, reason };
        }
        // A transient read failure cannot mean completion or permit another run.
        changed({ taskId: task.id, runId, executor: spec.mode,
          status: 'waiting', waitingReason: 'connection', reason: '正在重新连接执行记录；后续需求继续等待' });
        await wait(interval); continue;
      }
      const returnedId = String((spec.mode === 'workflow' ? latest.id || latest.runId : latest.ref || latest.runId) || '');
      if (returnedId && returnedId !== runId) throw new Error('执行记录标识发生变化，请核对需求后再继续队列');
      const status = outcome(continuation ? { status: continuation.status(latest) } : latest, spec.mode);
      const waiting = /waiting/.test(latest.state || latest.status || '') ||
        (latest.nodes || []).some(node => /^(waiting_human|waiting_external)$/.test(node.state || ''));
      changed({ taskId: task.id, runId, executor: spec.mode,
        sameMessageStream: true,
        reason: '', waitingReason: '', authRequired: false, permissionRequired: false,
        status: status || (waiting ? 'waiting' : 'running'),
        run: latest });
      if (drained && status && !(spec.mode === 'workflow' && status === 'failed')) {
        // Transcript completion does not ingest Runner outputs. Reconcile the
        // exact execution before acknowledging this controlled conversation turn.
        if (continuation && status === 'completed')
          await request(route + '/ai-status?ref=' + encodeURIComponent(runId));
        // Preserve the authoritative failure without copying raw provider envelopes into chat.
        const error = status === 'failed' ? modelErrors.describe(latest.error) : null;
        let reason = error ? modelErrors.forDisplay(latest.error) || '需求执行失败，请检查当前步骤' : '';
        if (error?.status === 404) reason += '；请切换可用模型，或联系管理员核对服务地址与模型名称。';
        else if (error?.status === 401 || error?.status === 403) reason += '；请检查模型授权或切换有权限的模型。';
        else if (error?.status === 429) reason += '；请稍后重试或检查模型额度。';
        // A result receipt must never replace the executor's actual answer.
        if (![...outputs.values()].some(output => output.answers())) handle.appendTaskMessage('assistant', status === 'completed'
          ? '需求执行已结束，但执行器没有返回正文。请核对成果后再继续。'
          : reason || '本次需求已停止或未完成，已有过程保留在当前对话中。', [], task.id);
        return { ok: status !== 'failed', cancelled: status === 'stopped',
          ...(status === 'failed' ? { reason } : {}) };
      }
      await wait(interval);
    }
  }
  return { execute, cancel };
}
module.exports = { executionSpec, outcome, create };
