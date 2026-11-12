'use strict';

// State remains owned by the session; accessors keep async transitions live.
const sessionHelpers = require('./session-helpers');
const modelErrors = require('./model-errors');

function create(ctx) {
  const {
    _openTiming, _pluginIds, attachmentContract, attachments, finalAnswer,
    goalFinalizer, goalLoop, goalQuality, goalReview, goalToolStages,
    independentReview, pluginContext, runControl, sessionResources, skillTurn,
    stream, imageRouting, vision, visionContract,
  } = ctx.shared;
  const titleForTurn = value => {
    const text = String(value || '').trim();
    if (!text || !sessionHelpers.visibleTitleText(text).trim()) return '';
    return sessionHelpers.title({ firstMessage: text });
  };
  return {
async send(text, turnAttachments, sendOptions) {
      const turn = sendOptions || {};
      let deliveryResult = null;
      const queuedTurn = turn.fromQueue ? ctx.turnQueue.active() : null;
      const interrupted = () => Boolean(queuedTurn?.stopRequested);
      const rawText = String(text || '');
      if (!rawText.trim()) return { ok: false, reason: '空消息' };
      /* Resolve only when this turn really reaches the front of the queue.
         Resolving before enqueue would mint a ticket and temp config that the
         queued turn never owns or cleans up. */
      if ((ctx.inFlight || ctx.turnQueue.size()) && !turn.internal && !turn.fromQueue) {
        const item = ctx._enqueueTurn(rawText, turnAttachments, turn);
        if (!item) return { ok: false, reason: '这条需求已有一轮在执行或排队中，请等它完成后再发送新消息' };
        return item.completion;
      }
      // The composer clears its draft after send; the conversation keeps its
      // selection. Apply changes at execution time so queued/cancelled turns
      // cannot alter the active turn or capture an outdated selection.
      const requestedPluginIds = _pluginIds(Array.isArray(turn.pluginIds)
        ? turn.pluginIds : (turn.plugins || []).map((item) => item && item.pluginId));
      if (turn.clearPluginSelection === true) ctx.persistPluginSelection([]);
      const effectivePluginIds = turn.clearPluginSelection !== true && requestedPluginIds.length
        ? requestedPluginIds.slice() : ctx.activePluginIds.slice();
      const accessReady = await ctx.liveAccess.wait();
      ctx.skillSelectionFailure = null;
      if (interrupted()) return { ok: true, cancelled: true, manualStop: true };
      if (!accessReady.ok) return { ...accessReady, retrySafe: true };
      if (!turn.internal) {
        try { await ctx.accessChanges.apply(); }
        catch (error) { return { ok: false, retrySafe: true, reason: '权限变更未生效：' + String(error?.message || error) }; }
      }
      const imageChoice = turn.modelName === undefined ? ctx.modelSelection.capture() : turn.modelName;
      if (require('./image-model').imageChoice(imageChoice)) {
        if (ctx.opts.readOnly) return { ok: false, retrySafe: true, reason: '当前是只读会话，请切换为可读写权限后再生成图片' };
        if (effectivePluginIds.length || turn.skills?.length || (turnAttachments || []).length || turn.goalMode || ctx.goalVisible || ctx.handle.taskRef) {
          return { ok: false, retrySafe: true, reason: '当前选择了直接生图。请仅输入图片描述；使用插件或分析附件时，请切回对话模型。' };
        }
        ctx.inFlight = true;
        ctx.failedLastTurn = false;
        ctx.imageController = new AbortController();
        runControl.resetTurn(ctx.run, true);
        ctx.displayTitle = ctx.displayTitle || titleForTurn(rawText);
        ctx.updatedAt = Date.now();
        try {
          await ctx.beginTurnJournal(turn);
          const result = await require('./image-turn').generate({ handle: ctx.handle, identity: ctx.identity, choice: imageChoice,
            text: rawText, submissionId: turn.submissionId, signal: ctx.imageController.signal,
            push: ev => ctx.acc.push(ev), emit: ctx._emit });
          ctx.failedLastTurn = !result.ok;
          return (deliveryResult = result);
        } finally {
          runControl.finishTurn(ctx.run);
          await ctx.finishTurnJournal();
          const capture = ctx._captureDirectDelivery(turn, deliveryResult);
          if (capture) await capture;
          ctx.imageController = null; ctx.inFlight = false;
          ctx._emit({ kind: 'turn-finished' }); queueMicrotask(ctx._drainTurns);
        }
      }
      const ticket = await ctx.refreshModelTicketIfNeeded();
      if (!ticket.ok) {
        return { ok: false, failureKind: 'model-auth', retrySafe: true, reason: ticket.reason,
            ...require('../../core/token-quota').fields(ticket) };
      }
      if (ctx.resourceActivation.required()) {
        ctx.inFlight = true;
        let restored;
        _openTiming('resource-activate-start', ctx.openStarted);
        try { restored = await ctx.resourceActivation.ensure(interrupted); }
        finally { ctx.inFlight = false; ctx._emit({ kind: 'session-resources' }); }
        _openTiming('resource-activate-end', ctx.openStarted);
        if (restored.cancelled || interrupted() || ctx.closed) return { ok: true, cancelled: true, manualStop: true };
        if (!restored.ok) return { ...restored, snapshot: ctx._snapshot() };
      }
      const selectedSkills = await skillTurn.prepare(ctx.opts, turn, ctx.sdk);
      if (interrupted() || ctx.closed) return { ok: true, cancelled: true, manualStop: true };
      if (!selectedSkills.ok) {
        ctx.skillSelectionFailure = selectedSkills; ctx.failedLastTurn = true;
        return { ...selectedSkills, snapshot: ctx._snapshot() };
      }
      let resolvedPlugins = { items: [], grant: null };
      if (effectivePluginIds.length && typeof ctx.opts.resolvePlugins !== 'function') {
        return {
          ok: false, failureKind: 'plugin-grant', retrySafe: true,
          reason: '当前会话没有可用的插件授权解析器，请重新打开会话',
        };
      }
      if (effectivePluginIds.length) {
        try {
          resolvedPlugins = await ctx.opts.resolvePlugins(effectivePluginIds, turn.projectId || '', {
            allowUnavailableApp: !turn.taskId && !ctx.handle.taskRef && !turn.goalMode &&
              !ctx.goalEnabled && !ctx.goalVisible && !(turnAttachments || []).length,
          });
        } catch (error) {
          return {
            ok: false, failureKind: 'plugin-grant', retrySafe: true,
            reason: '插件没能在发送前完成授权：' + String((error && error.message) || error),
          };
        }
      }
      const turnPlugins = pluginContext.compact(resolvedPlugins.items);
      const pluginGrant = resolvedPlugins.grant || null;
      const pluginAuthorization = pluginContext.authorization(turnPlugins, {
        capabilityIds: ctx.opts.capabilityIds,
        readOnly: ctx.opts.readOnly,
        mcpServers: pluginGrant && pluginGrant.servers,
      });
      if (!pluginAuthorization.ok) {
        if (pluginGrant && typeof pluginGrant.cleanup === 'function') pluginGrant.cleanup();
        return {
          ok: false, failureKind: 'plugin-grant', retrySafe: pluginAuthorization.retrySafe !== false,
          reason: pluginAuthorization.reason, pluginAuthorization,
        };
      }
      const continuing = Boolean(turn.continuing);
      if (interrupted() || ctx.closed) {
        pluginGrant?.cleanup?.();
        return { ok: true, cancelled: true, manualStop: true };
      }
      // A rejected preflight must not make later plain messages inherit an unusable plugin.
      if (turn.clearPluginSelection !== true && requestedPluginIds.length) ctx.persistPluginSelection(requestedPluginIds);
      const internal = Boolean(turn.internal);
      if (!internal || !ctx.desktopControlScope) {
        ctx.desktopControlScope = 'pi:' + ctx.ref + ':' + require('node:crypto').randomUUID();
      }
      await require('../agent-runtime/process-context').current()?.synchronize(ctx.handle);
      if (!internal) {
        ctx.access?.broker.beginTurn();
        runControl.resetRecoveries(ctx.run);
      }
      const runAsGoal = typeof turn.goalMode === 'boolean'
        ? turn.goalMode : Boolean(ctx.goalEnabled && !ctx.limitRequest);
      if (runAsGoal) {
        ctx.goalPluginIds = effectivePluginIds.slice();
        ctx.goalPluginProjectId = String(turn.projectId || '').slice(0, 36);
      }
      ctx.goalCancelled = false;
      if (!internal) {
        ctx.displayTitle = ctx.displayTitle || titleForTurn(rawText);
        ctx.updatedAt = Date.now();
      }
      if (!runAsGoal) {
        ctx.goalEnabled = false;
        ctx.limitRequest = null;
        ctx.run.stopReason = '';
        ctx._endGoalTurn();
      }
      ctx.inFlight = true;
      ctx.failedLastTurn = false;
      // Count retries per submitted turn, not across the lifetime of a chat.
      // SDK retries emit agent_start themselves, so reset here instead.
      ctx.acc.state.modelRetry = null;
      ctx.acc.state.retried = false;
      ctx.acc.state.retryError = '';
      if (runAsGoal) {
        ctx.qualityPhase = continuing ? 'implementing' : 'executing';
        ctx.qualityReason = continuing ? '已继续执行，正在完成剩余工作' : '正在确认目标、输入与完成标准';
        if (!continuing) ctx.qualityRounds = 0;
        ctx._setHarness(continuing ? 'execute' : 'understand', 'running', ctx.qualityReason);
        if (!continuing) {
          ctx._checkpoint('plan.ready', {
            reason: '\u5df2\u5c06\u76ee\u6807\u3001\u5b8c\u6210\u6807\u51c6\u548c\u7c7b\u578b\u9a8c\u6536\u9879\u7f16\u6210\u6267\u884c\u8d26\u672c',
          });
        }
      }
      runControl.resetTurn(ctx.run, false, turn.internal === true && turn.runtimeRecovery === true);
      const toolFrom = runAsGoal && continuing
        ? goalToolStages.evidenceStart(ctx.harness, ctx.acc.state.tools, ctx.acc.state.tools.length)
        : ctx.acc.state.tools.length;
      const profile = goalQuality.deliveryProfile(ctx.goal);
      const evidenceNow = async () => {
        const outputSnapshot = await require('./outputs').scanAsync(ctx.effectiveCwd, ctx.run.startedAt, ctx.run.startedAt);
        // Scanning yields to stop/pause and goal-disable actions. Let the
        // existing catch path preserve their receipts before changing audit state.
        if (interrupted() || ctx.closed || ctx.goalCancelled || ctx.run.stopReason || ctx.acc.status() !== 'idle')
          throw Object.assign(Error('成果采集已停止'), { code: 'EVIDENCE_INTERRUPTED' });
        return {
          outputSnapshot,
          evidence: goalQuality.collectEvidence(
            ctx.acc.state.tools.slice(toolFrom), outputSnapshot),
        };
      };
      let restoreSkills = () => {};
      let connectors = null;
      let modelRequestError = null;
      try {
        const stopped = () => interrupted() || ctx.closed || Boolean(ctx.run.stopReason) || ctx.goalCancelled;
        connectors = await require('./connector-turn.cjs').prepare(resolvedPlugins.applicationUnavailable
          ? { ...ctx.opts, resolveConnectors: undefined } : ctx.opts, stopped, pluginGrant?.servers || []);
        if (stopped()) return { ok: true, cancelled: true, manualStop: true };
        restoreSkills = skillTurn.installPi(ctx.piSession, ctx.resources, selectedSkills);
        ctx.turnReadScope = ctx.resourceReads.combine(ctx.resourceReads.create(resolvedPlugins.readRoots || []), selectedSkills.readScope);
        if (runAsGoal && !continuing && profile.kind !== 'conversation') {
          ctx._beginGoalTurn();
          ctx.qualityPhase = 'executing';
          ctx.qualityReason = '\u6b63\u5728\u6309\u9a8c\u6536\u6807\u51c6\u8fde\u7eed\u5b8c\u6210\u5de5\u4f5c';
          ctx._setHarness('execute', 'running', ctx.qualityReason);
        }
        const first = !ctx.opts.resumePath && !ctx.acc.state.messages.some((item) => item.role === 'user')
          ? (ctx.opts.inputAttachments || []) : [];
        const files = (turnAttachments && turnAttachments.length) ? turnAttachments : first;
        const initialFromMessage = ctx.acc.state.messages.length;
        const inputPrepText = Object.prototype.hasOwnProperty.call(turn.inputPreparation || {}, 'userText')
          ? String(turn.inputPreparation.userText || '') : rawText;
        let materialUnderstanding = { eligible: false, status: 'bypass', prompt: '', rows: [] };
        if (files.length) {
          try {
            materialUnderstanding = await require('../conversation/conversation-input-preparation.cjs').prepare({
              text: inputPrepText, files, plugins: turnPlugins,
              fallback: Boolean(turn.inputPreparation?.fallback), signal: turn.signal,
            });
          } catch (error) {
            materialUnderstanding = {
              eligible: true, status: 'error', rows: [],
              prompt: '本轮附件理解准备失败：' + String(error?.message || error) +
                '\n请不要假设附件内容已经读取；如需继续，请先说明处理目标或重新提供材料。',
            };
          }
        }
        const promptText = !runAsGoal && ctx.goal.intent === 'goal'
          ? goalQuality.normalPrompt(rawText) : rawText;
        let modelPrompt = pluginContext.augment(
          attachmentContract.augment(promptText, files), turnPlugins,
          [resolvedPlugins.applicationGuide, pluginGrant?.guide].filter(Boolean).join('\n\n'), turn.pluginInputs);
        const visualFiles = files.filter((file) => /^image\//i.test(String(file.mimeType || '')) ||
          /\.(?:png|jpe?g|webp|gif|avif|bmp|svg|tiff?|heic|heif|ico|jxl|jp2|j2k|raw|cr2|nef|arw|dng|psd)$/i.test(String(file.path || file.name || '')));
        const visualInputs = await attachments.images(files);
        if (visualFiles.length !== visualInputs.length) {
          throw new Error('有图片无法读取或超过 20 MB，原图已保留，请检查文件后重试');
        }
        // Read the active model after the queued turn's model switch, not the
        // model captured when the conversation was originally opened.
        // Raw image blocks require a server-declared native route; legacy clients
        // optimistically cached [text, image] for every gateway model.
        const nativeImages = Boolean(ctx.prep.model?.imageRouting === 'native' &&
          ctx.prep.model?.input?.includes('image'));
        const observationInputs = imageRouting.observationInputs(ctx.prep.model, visualInputs, ctx.piSession.messages,
          { allowHistoryOmission: true });
        const historyNotice = imageRouting.historyNotice(ctx.prep.model, visualInputs, ctx.piSession.messages);
        modelPrompt = connectors.augment(modelPrompt, historyNotice);
        if (observationInputs.length) {
          const observed = await vision.analyze(ctx.identity, observationInputs, promptText);
          if (!observed.ok) throw new Error(observed.reason || '视觉模型没有完成图片识别');
          modelPrompt = visionContract.augment(modelPrompt, observed);
        }
        if (interrupted()) return { ok: true, cancelled: true, manualStop: true };
        modelPrompt = require('./input-context.cjs').augment(modelPrompt,
          [turn.promptText, materialUnderstanding.eligible ? materialUnderstanding.prompt : ''].filter(Boolean).join('\n\n'));
        await ctx.beginTurnJournal(turn);
        let completion;
        try {
          completion = await ctx._promptComplete(modelPrompt, { images: nativeImages ? visualInputs : [] });
        } catch (error) {
          const described = modelErrors.describe(error);
          if (described.status === 404) modelRequestError = described;
          throw error;
        }
        if (interrupted()) return { ok: true, cancelled: true, manualStop: true };
        if (completion?.incomplete && !ctx.run.stopReason && !ctx.goalCancelled) {
          ctx.acc.markIncomplete(completion.incompleteReason || 'length');
          ctx.failedLastTurn = true;
          if (runAsGoal) {
            ctx.qualityPhase = 'blocked'; ctx.qualityReason = ctx.acc.snapshot().statusText;
            ctx.goalEnabled = false; ctx._endGoalTurn();
            ctx._checkpoint('run.blocked', { reason: ctx.qualityReason });
          }
          return { ok: false, failureKind: 'output-incomplete', retrySafe: false,
            reason: ctx.acc.snapshot().statusText, snapshot: ctx._snapshot() };
        }
        /*
         * Run the current goal once, resuming paused work before evidence review. After completion
         * or explicit blockage, later user messages return to ordinary conversation.
         */
        if (runAsGoal && profile.kind === 'conversation' && !ctx.run.stopReason && ctx.acc.status() === 'idle') {
          const reviewed = goalQuality.outcome(
            { messages: ctx.acc.state.messages }, initialFromMessage, { evidence: (await evidenceNow()).evidence, profile });
          ctx.qualityPhase = reviewed.phase;
          ctx.qualityReason = reviewed.reason;
          ctx.qualityRounds = Math.max(1, ctx.qualityRounds);
          ctx._checkpoint(reviewed.phase === 'reviewed' ? 'run.completed' : 'run.blocked', {
            reason: reviewed.reason,
          });
          ctx.goalEnabled = false;
          ctx.piSession.sessionManager.appendCustomEntry(goalQuality.ENTRY_TYPE, {
            phase: ctx.qualityPhase, reason: ctx.qualityReason, rounds: ctx.qualityRounds, at: Date.now(),
          });
          ctx._emit({ kind: 'quality-' + reviewed.phase });
        } else if (runAsGoal && !ctx.run.stopReason && ctx.acc.status() === 'idle') {
          let bundle = await evidenceNow();
          let evidence = bundle.evidence;
          let reviewed = null;
          let lastFingerprint = '';
          let stagnantCycles = 0;
          let cycleCount = 0;
          const maxCycles = 8;
          ctx._beginAudit();
          ctx._checkpoint('action.observed', {
            reason: '\u672c\u8f6e\u5b9e\u65bd\u5df2\u7ed3\u675f\uff0c\u5f00\u59cb\u6838\u5bf9\u771f\u5b9e\u7ed3\u679c',
            evidence: [
              'tools=' + evidence.toolCount,
              'files=' + evidence.meaningfulFileCount,
              'deliverables=' + evidence.deliverableCount,
            ],
          });
          while (!ctx.run.stopReason && ctx.acc.status() === 'idle' && cycleCount < maxCycles) {
            cycleCount += 1;
            ctx.qualityRounds += 1;
            ctx.qualityPhase = 'reviewing';
            ctx.qualityReason = cycleCount === 1
              ? '\u6b63\u5728\u8fdb\u884c\u786e\u5b9a\u6027\u9a8c\u6536\u548c\u72ec\u7acb\u590d\u6838'
              : '\u6b63\u5728\u590d\u6838\u7b2c ' + cycleCount + ' \u8f6e\u4fee\u8ba2\u7ed3\u679c';
            ctx._checkpoint('verification.started', { reason: ctx.qualityReason });
            ctx._emit({ kind: 'quality-review', cycle: cycleCount });
            reviewed = await independentReview({
              sdk: ctx.sdk, runtime: ctx.runtime, model: ctx.model, cwd: ctx.effectiveCwd, agentDir: ctx.prep.agentDir,
              goal: ctx.goal, spec: ctx.harness, evidence, profile, accessPolicy: ctx.accessPolicy,
              outputSnapshot: bundle.outputSnapshot,
            });
            const deterministicChecks = reviewed.deterministic &&
              Array.isArray(reviewed.deterministic.checks)
              ? reviewed.deterministic.checks : [];
            if (reviewed.phase === 'reviewed') {
              ctx._checkpoint('verification.passed', {
                reason: reviewed.reason,
                checks: deterministicChecks,
                score: reviewed.score,
              });
              break;
            }
            const fingerprint = goalReview.fingerprint(reviewed);
            stagnantCycles = fingerprint && fingerprint === lastFingerprint
              ? stagnantCycles + 1 : 0;
            lastFingerprint = fingerprint;
            const canRetry = reviewed.retryable &&
              cycleCount < maxCycles && stagnantCycles < 2;
            const replan = stagnantCycles > 0;
            ctx._checkpoint('verification.failed', {
              reason: reviewed.reason,
              decision: replan ? 'replan' : 'retry',
              checks: deterministicChecks,
              score: reviewed.score,
              result: reviewed,
            });
            if (!canRetry) {
              if (reviewed.retryable) {
                reviewed = {
                  ...reviewed,
                  retryable: false,
                  source: stagnantCycles >= 2
                    ? 'stagnation-guard' : 'cycle-guard',
                  reason: stagnantCycles >= 2
                    ? '\u540c\u4e00\u7c7b\u9a8c\u6536\u7f3a\u53e3\u8fde\u7eed\u51fa\u73b0\uff0cSoduWork \u5df2\u505c\u6b62\u65e0\u6548\u7a7a\u8f6c'
                    : '\u5df2\u8fbe\u5230\u672c\u6b21\u81ea\u52a8\u4fee\u8ba2\u8f6e\u6b21\u4e0a\u9650\uff0c\u4ecd\u672a\u8fbe\u5230\u4ea4\u4ed8\u6807\u51c6',
                };
              }
              break;
            }
            if (replan) {
              ctx._checkpoint('replan.requested', {
                reason: '\u539f\u4fee\u8865\u8def\u5f84\u6ca1\u6709\u6d88\u9664\u7f3a\u53e3\uff0c\u6b63\u5728\u6362\u65b9\u6848',
              });
            }
            ctx.qualityPhase = 'repairing';
            ctx.qualityReason = reviewed.reason;
            ctx._checkpoint('action.started', {
              focusKey: ctx.harness.focus && ctx.harness.focus.check,
              reason: replan
                ? '\u6839\u636e\u91cd\u590d\u5931\u8d25\u4e8b\u5b9e\u91cd\u65b0\u89c4\u5212\u5e76\u6267\u884c'
                : '\u6839\u636e\u9a8c\u6536\u7f3a\u53e3\u5b9a\u5411\u4fee\u8ba2',
            });
            ctx._emit({ kind: replan ? 'quality-replanning' : 'quality-repairing',
              cycle: cycleCount });
            await ctx._promptComplete(goalLoop.cyclePrompt(
              ctx.harness, reviewed, { replan }));
            ctx.acc.rejectAudit();
            if (ctx.run.stopReason || ctx.acc.status() !== 'idle') break;
            bundle = await evidenceNow();
            evidence = bundle.evidence;
            ctx._checkpoint('action.observed', {
              reason: '\u4fee\u8ba2\u5df2\u7ed3\u675f\uff0c\u91cd\u65b0\u91c7\u96c6\u771f\u5b9e\u8bc1\u636e',
              evidence: [
                'tools=' + evidence.toolCount,
                'files=' + evidence.meaningfulFileCount,
                'deliverables=' + evidence.deliverableCount,
              ],
            });
          }
          if (!reviewed && !ctx.run.stopReason) {
            reviewed = {
              phase: 'blocked',
              retryable: false,
              source: 'loop-runtime',
              reason: '\u76ee\u6807\u5faa\u73af\u6ca1\u6709\u5f62\u6210\u53ef\u9a8c\u6536\u7ed3\u8bba',
              gaps: [],
            };
          }
          if (!ctx.run.stopReason) {
            ctx._beginFinalAnswer();
            const finalized = await finalAnswer.compose({
              sdk: ctx.sdk,
              runtime: ctx.runtime,
              model: ctx.model,
              cwd: ctx.effectiveCwd,
              agentDir: ctx.prep.agentDir,
              goal: ctx.goal,
              reviewed,
              evidence,
              outputSnapshot: bundle.outputSnapshot,
              resourceFactory: (prompts) => sessionResources(
                ctx.sdk, ctx.effectiveCwd, ctx.prep.agentDir, [], prompts, { accessPolicy: ctx.accessPolicy }),
            });
            const finalMessage = ctx.acc.appendAssistant(finalized.rendered, stream.SCOPES.GOAL_FINAL);
            ctx.piSession.sessionManager.appendCustomEntry(goalFinalizer.ENTRY_TYPE, {
              schemaVersion: goalFinalizer.SCHEMA_VERSION,
              structured: finalized.structured,
              rendered: finalized.rendered,
              source: finalized.source,
              attempts: finalized.attempts,
              rejected: finalized.rejected,
              at: finalMessage.completedAt,
            });
            ctx.acc.revealAudit();
            ctx._endGoalTurn();
            ctx.qualityPhase = reviewed.phase;
            ctx.qualityReason = reviewed.reason;
            ctx._checkpoint(reviewed.phase === 'reviewed'
              ? 'run.completed' : 'run.blocked', {
              reason: reviewed.reason,
              checks: reviewed.deterministic && reviewed.deterministic.checks,
            });
            ctx.goalEnabled = false;
            ctx.piSession.sessionManager.appendCustomEntry(goalQuality.ENTRY_TYPE, {
              phase: ctx.qualityPhase,
              reason: ctx.qualityReason,
              rounds: ctx.qualityRounds,
              at: Date.now(),
            });
            ctx._emit({ kind: 'quality-' + reviewed.phase });
          }
        } else if (runAsGoal && ctx.goalCancelled) {
          ctx.qualityPhase = 'cancelled';
          ctx.qualityReason = '';
          ctx.failedLastTurn = false;
          ctx._endGoalTurn();
        } else if (runAsGoal && ctx.limitRequest) {
          ctx.qualityPhase = 'paused';
          ctx.qualityReason = ctx.limitRequest.reason;
        } else if (runAsGoal) {
          ctx.qualityPhase = 'blocked';
          ctx.qualityReason = '本轮执行没有形成可复核的结果';
          ctx._setHarness('deliver', 'blocked', ctx.qualityReason);
          ctx.goalEnabled = false;
          ctx._endGoalTurn();
        }
        const recovering = ctx._scheduleProtocolRecovery({
          goalMode: runAsGoal, request: rawText,
          pluginIds: effectivePluginIds, projectId: turn.projectId, skills: selectedSkills.names,
        });
        return (deliveryResult = { ok: true, paused: Boolean(ctx.limitRequest) && !recovering,
          recovering, modelRecoveryGoal: runAsGoal, snapshot: ctx._snapshot() });
      } catch (e) {
        if (interrupted() || ctx.closed || e?.code === 'EVIDENCE_INTERRUPTED' &&
            ctx.acc.status() === 'aborted' && !ctx.goalCancelled && !ctx.limitRequest)
          return { ok: true, cancelled: true, manualStop: true };
        if (ctx.goalCancelled) {
          ctx.failedLastTurn = false;
          ctx.qualityPhase = 'cancelled';
          ctx.qualityReason = '';
          ctx._endGoalTurn();
          return { ok: true, cancelled: true, snapshot: ctx._snapshot() };
        }
        if (runControl.isStallError(e)) {
          const stalled = ctx._scheduleStallRecovery({
            goalMode: runAsGoal, request: rawText,
            pluginIds: effectivePluginIds, projectId: turn.projectId, skills: selectedSkills.names,
          });
          if (stalled.recovering) {
            return { ok: true, paused: false, recovering: true, snapshot: ctx._snapshot() };
          }
          ctx.failedLastTurn = true;
          return {
            ok: false, failureKind: 'agent-stall', retrySafe: true,
            terminalAt: Number(ctx.run.terminalAt || 0),
            paused: Boolean(ctx.limitRequest), reason: stalled.reason || String(e.message || e),
            snapshot: ctx._snapshot(),
          };
        }
        if (modelRequestError) {
          const reason = modelRequestError.publicText || '模型服务地址或模型不存在';
          ctx.failedLastTurn = true;
          if (runAsGoal) {
            ctx.qualityPhase = 'paused';
            ctx.qualityReason = reason;
            ctx.goalEnabled = false;
            ctx._setHarness('execute', 'paused', reason);
            ctx._checkpoint('run.paused', { reason, cause: 'model-unavailable' });
          }
          return { ok: false, failureKind: 'model-unavailable', retrySafe: true,
            requiresModelChange: true, failedModelName: ctx.modelSelection.capture(),
            reason, modelRecoveryGoal: runAsGoal, snapshot: ctx._snapshot() };
        }
        const protocolRecovering = ctx._scheduleProtocolRecovery({
          goalMode: runAsGoal, request: rawText,
          pluginIds: effectivePluginIds, projectId: turn.projectId, skills: selectedSkills.names,
        });
        if (protocolRecovering) {
          return { ok: true, paused: false, recovering: true, snapshot: ctx._snapshot() };
        }
        if (ctx.limitRequest) {
          ctx.failedLastTurn = false;
          ctx.qualityPhase = 'paused';
          ctx.qualityReason = ctx.limitRequest.reason;
          const recovering = ctx._scheduleProtocolRecovery({
            goalMode: runAsGoal, request: rawText,
            pluginIds: effectivePluginIds, projectId: turn.projectId, skills: selectedSkills.names,
          });
          return { ok: true, paused: !recovering, recovering, snapshot: ctx._snapshot() };
        }
        ctx.failedLastTurn = true;
        if (runAsGoal) {
          ctx.qualityPhase = 'blocked';
          ctx.qualityReason = '交付执行或复核没有跑完';
          ctx._checkpoint('run.blocked', {
            reason: ctx.qualityReason + '：' + String((e && e.message) || e),
          });
          ctx.goalEnabled = false;
          ctx._endGoalTurn();
        }
        return { ok: false, reason: '这一轮没跑成：' + String((e && e.message) || e),
            ...require('../../core/token-quota').fields(e),
          modelRecoveryGoal: runAsGoal, snapshot: ctx._snapshot() };
      } finally {
        runControl.finishTurn(ctx.run);
        try { restoreSkills(); }
        finally {
          connectors?.cleanup();
          if (pluginGrant && typeof pluginGrant.cleanup === 'function') pluginGrant.cleanup();
          ctx.turnReadScope = undefined;
          await ctx.finishTurnJournal();
          const capture = ctx._captureDirectDelivery(turn, deliveryResult);
          if (capture) await capture;
          ctx.inFlight = false;
          ctx._emit({ kind: ctx.limitRequest ? 'goal-paused' : 'turn-finished' });
          queueMicrotask(ctx._drainTurns);
        }
      }
    }
  };
}
module.exports = { create };
