/*
 * Shared task trace backed by /tasks/{id}/trace. Variants emphasize task details,
 * execution evidence, or approval context without owning business rules. Preserve
 * disclosure state, forward existing actions, and retain TaskTraceView as a compatibility
 * alias.
 */
(function () {
  'use strict';

  const STATE_TEXT = {
    planned: '未开始', pending: '未开始', queued: '排队中', dispatching: '派发中',
    running: '执行中', rework: '返修中', waiting_human: '等待人工',
    waiting_external: '等待环境', succeeded: '已完成', skipped: '已跳过',
    failed: '未通过', cancelled: '已结束', approved: '已通过', rejected: '已退回',
    rolled_back: '已回滚', rollback_failed: '回滚失败', revoked: '已撤回',
    done: '已完成', stopped: '已结束', interrupted: '已中断', released: '已发布',
    ready: '已满足交付', complete: '已交付', blocked: '有阻断', manual: '人工办理',
  };
  const STATE_TONE = {
    running: 'run', dispatching: 'run', queued: 'idle', rework: 'warn',
    waiting_human: 'wait', waiting_external: 'wait', succeeded: 'ok', approved: 'ok',
    skipped: 'idle', failed: 'bad', rejected: 'bad', rollback_failed: 'bad',
    done: 'ok', released: 'ok', stopped: 'idle', interrupted: 'warn',
    cancelled: 'idle', revoked: 'idle', planned: 'idle', pending: 'wait', rolled_back: 'warn',
    ready: 'ok', complete: 'ok', blocked: 'bad', manual: 'idle',
  };
  const NODE_TEXT = {
    ai: 'AI 执行', ai_review: 'AI 代码审查', spec: '需求确认', quality: '质量门禁',
    validate: '结果校验', human_review: '人工审阅', approval: '授权审批',
    merge: '代码合并', deploy: '环境发布', deploy_chain: '发布链', publish: '交付完成',
    condition: '条件判断', script: '受信脚本', tool: '工具调用',
  };
  const PHASE_TEXT = {
    understand: '理解工作', organize: '组织协作', execute: '执行工作',
    verify: '确认结果', deliver: '交付发布', evolve: '评价沉淀',
  };
  const APPROVAL_TEXT = {
    baseline: '需求确认', review: '验收交付结果', merge: '合并授权', uat: '环境验收', deploy: '发布授权',
  };
  const EVENT_TEXT = {
    created: '创建需求', claim: '认领需求', assign: '分派需求', reassign: '转派需求',
    release: '退回需求池', advance: '推进需求', reject: '退回上一步', closed: '办结需求',
    receipt: '收到交付回执', 'ai.dispatch_started': '正在派给 AI', 'ai.dispatch_failed': 'AI 派活失败',
    'ai.dispatch_uncertain': '正在确认执行机回执',
    'ai.dispatched': '派给 AI', 'ai.rework': 'AI 按意见继续返修', 'ai.rework_failed': '自动返修未启动', 'release.approved': '审批通过',
    'release.rejected': '审批退回', 'release.ai_reviewed': 'AI 代码审查通过',
    'release.candidate': '交付版本已生成', 'release.approval_requested': '已发起审批',
    'ai.artifacts': '交付文件已关联', 'artifact.auto_reviewed': '自动验收报告已生成',
    'release.deploy_queued': '排入环境发布', 'plugin.gerrit_merged': '代码已合并',
    'task.evaluated': '完成需求评价', 'evolution.proposed': '形成改进建议',
    'task.execution_started': '更新执行状态',
    'execution.started': '执行会话已开始',
    'conversation.turn': '需求执行',
    'artifact.delivery_deferred': '产出暂存待确认',
    'artifact.delivery_waiting_manual': '产出等待手动提交',
    'artifact.submitted_for_review': '产出已提交验收',
    'artifact.review_cancelled': '验收单已撤回',
    'artifact.delivery_rejected': '产出未通过交付检查',
    'ai.session_reconciled': '执行会话状态已校正',
    'evolution.accepted': '采纳改进建议', 'evolution.rejected': '驳回改进建议',
    'evolution.applied': '改进已进入新版本',
  };
  const SESSION_EVENT_TEXT = {
    step: '执行计划', do: '正在操作', say: 'AI 更新', out: '执行结果',
    error: '异常信息', status: '状态变化', tool: '工具调用',
  };
  const LIVE = new Set(['queued', 'dispatching', 'running', 'rework', 'waiting_human', 'waiting_external']);
  const BAD = new Set(['failed', 'blocked', 'rework', 'rejected', 'rollback_failed']);

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function stateText(value) { return STATE_TEXT[value] || String(value || '—'); }
  function tone(value) { return STATE_TONE[value] || 'idle'; }
  function nodeText(value) { return NODE_TEXT[value] || String(value || '流程节点'); }
  function errorText(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
      return String(value.message || value.detail || value.summary || value.reason || value.code || '');
    }
    return String(value);
  }

  function duration(start, end) {
    if (!start) return '';
    const seconds = Math.max(0, Math.round(((end || Date.now()) - start) / 1000));
    if (seconds < 60) return seconds + ' 秒';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟';
    return (seconds / 3600).toFixed(1) + ' 小时';
  }

  function dateText(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString((globalThis.SoduWorkI18n?.getLocale() || 'zh-CN'), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function fullUrl(item) {
    if (window.SoduWorkAPI && typeof SoduWorkAPI.attachmentUrl === 'function') return SoduWorkAPI.attachmentUrl(item);
    const base = typeof window.SoduWorkAPI?.hubBase === 'function' ? SoduWorkAPI.hubBase() : window.SoduWorkAPI?.hubBase || '';
    const url = String((item || {}).url || '');
    return /^https?:/i.test(url) ? url : base.replace(/\/$/, '') + url;
  }

  function fileSize(value) {
    const size = Number(value || 0);
    if (!size) return '';
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(size < 10240 ? 1 : 0) + ' KB';
    return (size / 1024 / 1024).toFixed(1) + ' MB';
  }

  function standardStages(trace, run) {
    return Array.isArray((trace || {}).stages) && trace.stages.length ? trace.stages : routeNodes(run);
  }

  function latestNodes(run) {
    const latest = new Map();
    (run.nodes || []).forEach((node) => {
      const key = String(node.key || '');
      const old = latest.get(key);
      if (!old || Number(node.attempt || 0) >= Number(old.attempt || 0)) latest.set(key, node);
    });
    return latest;
  }

  function routeNodes(run) {
    if (!run) return [];
    const latest = latestNodes(run);
    const seen = new Set();
    const rows = (run.workflow || []).map((def) => {
      const key = String(def.key || '');
      seen.add(key);
      return latest.get(key) || {
        key, name: def.name || key, type: def.type || '', state: 'planned', attempt: 0, evidence: [],
      };
    });
    latest.forEach((node, key) => { if (!seen.has(key)) rows.push(node); });
    return rows;
  }

  function currentRun(trace) {
    const runs = trace.runs || [];
    const active = runs.find((run) => LIVE.has(String(run.state || '')));
    return active || runs[0] || null;
  }

  function currentNode(trace, run) {
    const stageId = String((((trace || {}).summary || {}).currentStageId) || '');
    if (stageId) {
      const hit = standardStages(trace, run).find((item) => String(item.id || '') === stageId);
      if (hit) return hit;
    }
    const key = String((((trace || {}).card || {}).stage || {}).key || '');
    if (run && key) {
      const hit = latestNodes(run).get(key);
      if (hit) return hit;
    }
    const route = standardStages(trace, run);
    return route.find((node) => LIVE.has(String(node.state || ''))) ||
      route.slice().reverse().find((node) => BAD.has(String(node.state || ''))) || route[route.length - 1] || null;
  }

  function progressHtml(progress) {
    const total = Math.max(0, Number((progress || {}).total || 0));
    const done = Math.min(total, Number((progress || {}).done || 0));
    if (!total) return '';
    const pct = Math.round((done / total) * 100);
    return '<div class="tfd-progress" aria-label="流程进度 ' + done + '/' + total + '">' +
      '<span>' + (progress.unit ? '已完成 ' : '') + '<b>' + done + '</b> / ' + total + ' ' + esc(progress.unit || '关') + '</span><i><em style="width:' + pct + '%"></em></i></div>';
  }

  function viewCopy(trace, opts, node) {
    const variant = opts.variant || 'task';
    const card = trace.card || {};
    const stage = card.stage || {};
    const lifecycle = (trace.summary || {}).lifecycle || {};
    const noRun = !(trace.runs || []).length;
    const title = (lifecycle.title || (trace.summary || {}).currentStageName || stage.name ||
      (node && (node.name || node.key)) || (noRun ? '需求已记录，等待开始' : '正在准备下一关'));
    let desc = '从理解需求到交付结果，每一关的状态、责任人与证据都在这里。';
    if (variant === 'execution') desc = '左侧是正在发生的真实会话；这里固定展示这条需求在完整流程中的位置。';
    if (variant === 'approval') desc = '请基于固定版本、上游证据和目标环境做决定，不必离开当前审批。';
    if (stage.state === 'waiting_human') desc = '流程已停在人工关口，完成当前决定后会自动继续。';
    if (stage.state === 'waiting_external') desc = '执行已交给外部环境，正在等待可验证的运行结果。';
    if (stage.error) desc = String(stage.error).slice(0, 260);
    if (lifecycle.description) desc = lifecycle.description;
    return {
      kicker: variant === 'approval' ? '审批上下文' : variant === 'execution' ? '执行进展' : '需求进展',
      title, desc,
    };
  }

  function actionHtml(trace, opts, node) {
    const card = trace.card || {};
    const variant = opts.variant || 'task';
    const actions = [];
    /*
     * Raw NodeRun objects use type; normalized trace stages use kind. Accept both when
     * identifying AI nodes.
     */
    const nodeKind = node ? String(node.type || node.kind || '') : '';
    if (variant === 'execution') actions.push(['task', '进入需求', '']);
    if (variant === 'execution' && node && node.state === 'waiting_human') actions.push(['approval', '去人审专区', 'primary']);
    if (variant === 'task' && card.canRetry && node &&
        ['failed', 'blocked', 'rework'].includes(String(node.state || '')) &&
        (node.diagnosis || {}).retryable) {
      const retryAction = String((node.diagnosis || {}).actionKey || '');
      actions.push(['retry-gate', retryAction === 'resume-rework' ? '按审查意见继续返修' :
        nodeKind === 'quality' ? '重跑质量门禁' :
        nodeKind === 'ai' || nodeKind === 'ai_review' ? '让 AI 重跑这一关' : '重试当前关口', 'primary']);
      if (nodeKind === 'ai' || nodeKind === 'ai_review') {
        /* Allow an explicit executor override when retrying the current failed stage. */
        actions.push(['retry-agent', '换个底座重跑', '']);
        actions.push(['recover', '检查并取回产出', '']);
      }
    }



    if ((variant === 'task' || variant === 'execution') && node &&
        String(((trace.card || {}).runId) || '') &&
        (nodeKind === 'ai' || nodeKind === 'ai_review') &&
        ['queued', 'dispatching', 'running'].includes(String(node.state || ''))) {
      actions.push(['redispatch', '重新派这一关', '']);
    }
    if (variant === 'task' && card.canCancel) actions.push(['handoff', '转人工收尾', 'danger']);
    if (!actions.length) return '';
    return '<div class="tfd-actions">' + actions.map((item) =>
      '<button class="' + item[2] + '" data-tfd-action="' + item[0] + '">' + item[1] + '</button>').join('') + '</div>';
  }

  function heroHtml(trace, opts, run, node) {
    const card = trace.card || {};
    const copy = viewCopy(trace, opts, node);
    const meta = [...new Set([card.projectName, card.repoName, card.pluginName].filter(Boolean))];
    const executor = card.executor || {};
    if (executor.assignee) meta.push(executor.assignee + (executor.host ? ' · ' + executor.host : ''));
    const summary = trace.summary || {};
    const lifecycle = summary.lifecycle || {};
    const progress = lifecycle.progress || (summary.totalStages ? { done: summary.completedStages, total: summary.totalStages } :
      ((run || {}).progress || card.progress));
    const nextAction = lifecycle.nextAction ?? summary.nextAction;
    return '<section class="tfd-hero is-' + tone(lifecycle.state || summary.currentState || (card.stage || {}).state) + '">' +
      '<div class="tfd-hero-main"><span class="tfd-kicker">' + esc(copy.kicker) + '</span>' +
        "<h3>" + esc(copy.title) + '</h3><p>' + esc(copy.desc) + '</p>' +
        (nextAction ? '<div class="tfd-next"><span>下一步</span><b>' + esc(nextAction) + '</b></div>' : '') +
        (meta.length ? '<div class="tfd-meta">' + meta.map((item) => '<span>' + esc(item) + '</span>').join('') + '</div>' : '') +
      '</div><div class="tfd-hero-side">' + progressHtml(progress) +
        actionHtml(trace, opts, node) + '</div></section>';
  }

  function phasesHtml(trace, run, selected) {
    const phases = Array.isArray(trace.phases) ? trace.phases : [];
    if (!phases.length) return '';
    const stages = standardStages(trace, run);
    const selectedCategory = String((selected || {}).category || '');




    return '<section class="tfd-loop"><div class="tfd-loop-head"><span data-i18n="eyebrow.task_journey">ISSUE PROGRESS</span>' +
      '<b>需求进程</b><small>上：工作闭环阶段 · 下：实际执行关卡与证据</small></div>' +
      '<ol class="tfd-loop-strip">' + phases.map((phase) => {
        const state = String(phase.state || 'planned');
        const rows = stages.filter((item) => String(item.category || '') === String(phase.key || ''));
        const target = rows.find((item) => LIVE.has(String(item.state || ''))) || rows[0] || null;
        const evolution = String(phase.key || '') === 'evolve' && trace.evolution;
        const chosen = selectedCategory && selectedCategory === String(phase.key || '');
        const facts = [stateText(state)];
        if (phase.stageCount) facts.push(Number(phase.stageCount) + ' 个阶段');
        if (phase.evidenceCount) facts.push(Number(phase.evidenceCount) + ' 份证据');
        const done = state === 'succeeded' || state === 'done' || state === 'complete';
        return '<li class="is-' + tone(state) + (chosen ? ' is-selected' : '') + '"><button type="button"' +
          (target ? ' data-tfd-stage="' + esc(target.id || '') + '"' :
            evolution ? ' data-tfd-action="evolution"' : ' disabled') +
          (chosen ? ' aria-current="step"' : '') + ' title="' + esc(facts.join(' · ')) + '">' +
          '<i>' + (done ? '<svg viewBox="0 0 24 24"><path d="m5 13 4 4 10-10"/></svg>' : '') + '</i>' +
          '<b>' + esc(phase.name || PHASE_TEXT[phase.key] || '工作阶段') + '</b>' +
          (LIVE.has(state) || BAD.has(state) ? '<small>' + esc(stateText(state)) + '</small>' : '') +
          '</button></li>';
      }).join('') + '</ol>' + routeHtml(trace, run, selected) + '</section>';
  }

  function deliveryHtml(trace, opts) {
    const delivery = trace.delivery || ((trace.card || {}).delivery) || {};
    if (!delivery.schemaVersion) return '';
    const artifact = opts.artifact || delivery.artifact || {}, manifest = artifact.manifest || delivery.manifest || {};
    const blocker = (delivery.blockers || [])[0] || null;
    const primary = manifest.primary || [];
    const supporting = manifest.supporting || [];
    const evidence = manifest.evidence || [];
    const authority = { workflow: '自动工作流', direct_ai: 'AI 直派', manual: '人工需求' }[delivery.authority] || '需求';
    const label = stateText(delivery.state);
    let title = '交付事实正在形成';
    let detail = '执行、成果、审批与发布会在这里汇成同一个最终结论。';
    if (delivery.complete) {
      title = '交付已经闭环'; detail = '当前需求状态与成果、审批及发布事实一致。';
    } else if (delivery.canComplete) {
      title = delivery.authority === 'manual' ? '由负责人按实际结果办结' : '所有交付条件已经满足';
      detail = delivery.authority === 'manual' ? '这条需求尚未进入 AI 或自动工作流，可由负责人确认完成。' : '系统可以安全地把需求更新为已完成。';
    } else if (blocker) {
      title = blocker.title || title; detail = blocker.detail || detail;
    }
    const facts = [authority];
    if (primary.length) facts.push(primary.length + ' 项主成果');
    if (supporting.length) facts.push(supporting.length + ' 项支撑文件');
    if (evidence.length) facts.push(evidence.length + ' 份验证证据');
    if (artifact.seq) facts.push('固定版本 v' + artifact.seq);
    const links = primary.slice(0, 3).map((item) => item.url ?
      '<a href="' + esc(fullUrl(item)) + '" target="_blank" rel="noreferrer" title="打开主成果">' +
        esc(item.name || '主成果') + (fileSize(item.size) ? '<small>' + esc(fileSize(item.size)) + '</small>' : '') + '</a>' :
      '<span title="' + esc(item.name || '') + '">' + esc(item.name || '主成果') + '</span>');
    if (manifest.url) links.push('<a href="' + esc(manifest.url) + '" target="_blank" rel="noreferrer">打开交付地址</a>');
    const action = ((primary.length || supporting.length) && String(artifact.kind) !== 'code' ?
      '<button data-tfd-action="download">' + (opts.artifactVersionId ? '下载本次固定成果' : '下载当前成果') + '</button>' : '') + (blocker && blocker.action === 'approval' && opts.variant !== 'task' ?
      '<button data-tfd-action="approval">去人审专区</button>' : '');
    return '<section class="tfd-truth is-' + tone(delivery.state) + '"><i></i><div class="tfd-truth-copy">' +
      '<span>DELIVERY TRUTH · ' + esc(label) + '</span><b>' + esc(title) + '</b><small>' + esc(detail) + '</small>' +
      '<p>' + facts.map((item) => '<em>' + esc(item) + '</em>').join('') + '</p></div>' +
      (links.length ? '<div class="tfd-truth-files">' + links.join('') + '</div>' : '') + action + '</section>';
  }
  function routeHtml(trace, run, selected) {
    const nodes = standardStages(trace, run);
    if (!nodes.length) return '';
    const selectedId = String((selected || {}).id || '');
    return '<div class="tfd-route-wrap"><div class="tfd-route-label"><b>实际执行关卡</b>' +
      '<small>点击关卡查看会话、证据、确认和结果</small></div>' +
      '<ol class="tfd-route" style="--tfd-count:' + nodes.length + '">' + nodes.map((node, index) => {
        const state = String(node.state || 'planned');
        const error = errorText(node.error);
        const chosen = String(node.id || '') === selectedId;
        return '<li class="is-' + tone(state) + (LIVE.has(state) ? ' is-current' : '') +
          (chosen ? ' is-selected' : '') + '"><button type="button" data-tfd-stage="' + esc(node.id || '') + '"' +
          (chosen ? ' aria-current="step"' : '') + ' title="' + esc(error || stateText(state)) + '"><i>' +
          (state === 'succeeded' || state === 'skipped' ?
            '<svg viewBox="0 0 24 24"><path d="m5 13 4 4 10-10"/></svg>' : (index + 1)) + '</i>' +
          '<span><b>' + esc(node.name || node.key || '流程节点') + '</b><small>' +
          esc(PHASE_TEXT[node.category] || nodeText(node.kind || node.type)) + ' · ' + esc(stateText(state)) +
          ((node.evidence || []).length ? ' · ' + Number(node.evidence.length) + ' 份证据' : '') +
          '</small></span></button></li>';
      }).join('') + '</ol></div>';
  }

  function evidenceHtml(list, node) {
    const rows = list || [];
    if (!rows.length) {
      return ['running', 'succeeded', 'failed', 'rework', 'waiting_external', 'waiting_human'].includes(String(node.state || '')) && !node.error
        ? '<p class="tfd-muted">这一关运行过，但还没有留下可复核证据。</p>' : '';
    }
    const images = rows.filter((item) => item.isImage || item.kind === 'image');
    const rest = rows.filter((item) => !images.includes(item));
    const proofLabel = (item) => {
      const value = String(((item.verification || {}).state) || '');
      return value === 'passed' ? '已验证' : value === 'failed' ? '未通过' :
        value === 'unverified' ? '待验证' : '';
    };
    const gallery = images.length ? '<div class="tfd-evidence-gallery">' + images.map((item) => {
      const verification = String(((item.verification || {}).state) || '');
      return '<a class="is-' + esc(verification || 'unknown') + '" href="' +
        esc(fullUrl(item)) + '" target="_blank" rel="noreferrer" title="打开原图">' +
        '<img src="' + esc(fullUrl(item)) + '" loading="lazy" decoding="async" alt="' + esc(item.title || item.label || '证据图片') + '">' +
        (proofLabel(item) ? '<em>' + esc(proofLabel(item)) + '</em>' : '') +
        '<span><b>' + esc(item.title || item.label || '证据图片') + '</b><small>' +
          esc([fileSize(item.size || item.value), ((item.producer || {}).name || '')].filter(Boolean).join(' · ')) +
        '</small></span></a>';
    }).join('') + '</div>' : '';
    return gallery + '<ul class="tfd-evidence">' + rest.map((item, index) => {
      const kind = String(item.kind || 'text');
      const title = item.title || item.label || '证据';
      const value = item.summary == null ? item.value : item.summary;
      if (kind === 'file') {
        // Artifact fingerprints describe a bundle; they are not downloadable
        // attachment IDs. Do not offer a link that can only return a 404.
        const downloadable = Boolean(item.url || item.attachmentId || /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(String(item.id || '')));
        const label = downloadable ? '<a href="' + esc(fullUrl(item)) + '" target="_blank" rel="noreferrer">' + esc(title) + '</a>' : '<span>' + esc(title) + '</span>';
        return '<li class="is-file"><i></i>' + label + '<small>' + esc([fileSize(item.size || item.value), item.mime,
            ((item.producer || {}).name || '')].filter(Boolean).join(' · ')) + '</small></li>';
      }
      if (kind === 'log') {
        return '<li class="is-log"><details data-tfd-open="log:' + esc(node.key || '') + ':' + index + '"><summary>' +
          esc(title || '执行日志') + '</summary><pre>' + esc(value || '') + '</pre></details></li>';
      }
      const verification = String(((item.verification || {}).state) || '');
      const bad = verification === 'failed' || kind === 'missing' || /没过|失败|缺少|false/i.test(String(value || ''));
      const producer = String(((item.producer || {}).name) || '');
      /*
       * Render URL and commit evidence as links so reviewers can inspect it directly.
       */
      const body = item.url
        ? '<a href="' + esc(fullUrl(item)) + '" target="_blank" rel="noreferrer">' + esc(value || item.url) + '</a>'
        : esc(value || '');
      return '<li class="is-' + esc(kind) + (bad ? ' is-bad' : '') + '"><i></i><b>' +
        esc(title) + '</b><span>' + body + '</span>' +
        (producer ? '<small class="tfd-proof-source">取证 · ' + esc(producer) + '</small>' : '') +
        (proofLabel(item) ? '<small class="tfd-proof-state">' +
          esc(proofLabel(item)) + '</small>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  function gatePacketHtml(gate, rawOpts) {
    if (!gate || !gate.schemaVersion) return '';
    const opts = rawOpts || {};
    const readiness = gate.readiness || {};
    const subject = gate.subject || {};
    const criteria = gate.criteria || [];
    const requirements = gate.requirements || [];
    const evidence = gate.evidence || [];
    const ready = readiness.canApprove !== false;
    const blockers = readiness.blockers || [];
    return '<section class="tfd-gate is-' + (ready ? 'ready' : 'blocked') +
      (opts.compact ? ' is-compact' : '') + '"><header><div><span>' +
        (ready ? '\u8bc1\u636e\u5df2\u9f50\u5168' : '\u5f85\u8865\u5145\u8bc1\u636e') + "</span><b" + (gate.title ? ' data-user-content' : '') + '>' +
        esc(gate.title || '\u4eba\u5de5\u95e8\u7981') + '</b></div><em>' +
        (ready ? '\u53ef\u4ee5\u5ba1\u6279' : blockers.length + ' \u9879\u672a\u6ee1\u8db3') + '</em></header>' +
      '<div class="tfd-gate-subject"><span><small>\u56fa\u5b9a\u7248\u672c</small><b>v' +
        Number(subject.artifactSeq || 1) + ' \u00b7 ' + esc(String(subject.fingerprint || '').slice(0, 16) || '\u2014') + '</b></span>' +
        (subject.environmentName ? '<span><small>\u76ee\u6807\u73af\u5883</small><b>' + esc(subject.environmentName) + '</b></span>' : '') +
        '<span><small>\u8bc1\u636e</small><b>' + evidence.length + ' \u4efd</b></span></div>' +
      '<div class="tfd-gate-grid">' +
        '<div><h5>\u9a8c\u6536\u6807\u51c6</h5>' + (criteria.length ? '<ol>' + criteria.map((item) =>
          '<li>' + esc(item.label || item.name || item) + '</li>').join('') + '</ol>' :
          '<p>\u8fd8\u6ca1\u6709\u8bbe\u5b9a\u660e\u786e\u7684\u9a8c\u6536\u6807\u51c6\u3002</p>') + '</div>' +
        '<div><h5>\u5fc5\u9700\u8bc1\u636e</h5>' + (requirements.length ? '<ul>' + requirements.map((item) =>
          '<li class="' + (item.satisfied ? 'is-ok' : 'is-missing') + '"><i>' +
          (item.satisfied ? '\u2713' : '!') + '</i><span>' + esc(item.label || '\u5fc5\u9700\u8bc1\u636e') + '</span></li>').join('') + '</ul>' :
          '<p>\u8fd9\u4e00\u5173\u6ca1\u6709\u989d\u5916\u5f3a\u5236\u8bc1\u636e\u3002</p>') + '</div></div>' +
      (!ready && blockers.length ? '<div class="tfd-gate-blockers"><b>\u901a\u8fc7\u524d\u8fd8\u9700\u8981</b><span>' +
        esc(blockers.join(' \u00b7 ')) + '</span></div>' : '') +
      (evidence.length ? '<div class="tfd-gate-evidence"><h5>\u672c\u5173\u8bc1\u636e</h5>' +
        evidenceHtml(evidence, { state: ready ? 'succeeded' : 'waiting_human', key: 'gate' }) + '</div>' : '') +
      '</section>';
  }

  /*
   * Synchronous rendering starts at html(); a module-level variant supplies nested rendering
   * helpers.
   */
  let _renderVariant = 'task';

  function sessionDetailHtml(item) {
    return TaskTraceExecutionDetails.sessionHtml(item, {
      esc, tone, stateText, dateText, duration, errorText, live: LIVE, eventText: SESSION_EVENT_TEXT,
      liveAside: _renderVariant === 'execution',
    });
  }

  function decisionDetailHtml(item) {
    const confirmation = item.confirmation || {};
    const artifact = confirmation.lockedArtifact || {};
    const target = confirmation.targetEnvironment || {};
    const gate = item.gate || confirmation.gate || {};
    const gateBlock = gatePacketHtml(gate, { compact: true });
    return '<article class="tfd-decision"><header><div><span>需要确认</span><b>' +
      esc(confirmation.title || APPROVAL_TEXT[item.action] || '人工决定') + '</b></div><em class="is-' +
      tone(item.status) + '">' + esc(stateText(item.status)) + '</em></header>' +
      '<div class="tfd-decision-lock">' +
        (artifact.id ? '<span><small>固定版本</small><b>v' + Number(artifact.seq || 1) + ' · ' +
          esc(String(artifact.commit || artifact.checksum || artifact.id).slice(0, 18)) + '</b></span>' : '') +
        (target.name ? "<span><small>目标环境</small><b data-user-content>" + esc(target.name) + '</b></span>' : '') +
        '<span><small>决策规则</small><b>' + Number(item.required || confirmation.required || 1) + ' 人确认</b></span>' +
      '</div>' + (!gate.schemaVersion && (confirmation.criteria || []).length ? '<ul class="tfd-criteria">' +
        confirmation.criteria.map((line) => '<li>' + esc(line) + '</li>').join('') + '</ul>' : '') +
      gateBlock +
      ((item.decisions || []).length ? '<div class="tfd-decision-history">' + (item.decisions || []).map((d) =>
        '<p><b>' + esc(d.userName || d.userId || '审批人') + '</b><span>' +
          esc(d.decision === 'approve' ? '确认通过' : '退回处理') + (d.note ? ' · ' + esc(d.note) : '') +
          '</span><small>' + esc(dateText(d.at)) + '</small></p>').join('') + '</div>' : '') + '</article>';
  }

  function deploymentDetailHtml(item) {
    return TaskTraceExecutionDetails.deploymentHtml(item, { esc, tone, stateText, errorText });
  }

  function outputDetailHtml(item) {
    const review = item.aiReview || {};
    return '<article class="tfd-output"><header><span>v' + Number(item.seq || 1) + '</span><div><b>' +
      esc(item.kind || '固定产出') + '</b><small>' + esc([item.branch, item.target].filter(Boolean).join(' → ')) +
      '</small></div><em>' + esc(stateText(item.state)) + '</em></header><p>' +
      esc(String(item.commit || item.checksum || item.id || '').slice(0, 64)) + '</p>' +
      (review.summary ? '<div class="tfd-review-note"><b>AI 复核</b><span>' + esc(review.summary) + '</span></div>' : '') + '</article>';
  }

  function stageExtrasHtml(stage) {
    const blocks = [];
    if ((stage.sessions || []).length) blocks.push('<div class="tfd-stage-block"><h4>真实执行会话</h4>' +
      stage.sessions.map(sessionDetailHtml).join('') + '</div>');
    if ((stage.decisions || []).length) blocks.push('<div class="tfd-stage-block"><h4>确认与决定</h4>' +
      stage.decisions.map(decisionDetailHtml).join('') + '</div>');
    if ((stage.deployments || []).length) blocks.push('<div class="tfd-stage-block"><h4>环境运行</h4>' +
      stage.deployments.map(deploymentDetailHtml).join('') + '</div>');
    if ((stage.outputs || []).length) blocks.push('<div class="tfd-stage-block"><h4>固定交付版本</h4><div class="tfd-output-grid">' +
      stage.outputs.map(outputDetailHtml).join('') + '</div></div>');
    return blocks.length ? '<div class="tfd-stage-extras">' + blocks.join('') + '</div>' : '';
  }

  function nodeHtml(node, runId, current) {
    const state = String(node.state || '');
    const key = 'node:' + runId + ':' + String(node.key || '') + ':' + Number(node.attempt || 0);
    /*
     * Expand the selected node by default, then preserve manual disclosure choices across
     * polling refreshes.
     */
    return '<details class="tfd-node is-' + tone(state) + '" data-tfd-open="' + esc(key) + '"' +
      (current ? ' open' : '') + '>' +
      '<summary><i class="tfd-node-dot"></i><span><b>' + esc(node.name || node.key || '流程节点') + '</b><small>' +
        esc(nodeText(node.kind || node.type)) + '</small></span><em class="tfd-state">' + esc(stateText(state)) + '</em>' +
        (node.attempt > 1 ? '<em>第 ' + Number(node.attempt) + ' 轮</em>' : '') +
        /*
         * Avoid Date.now() in running markup so polling does not replace unchanged content. Show
         * fixed elapsed time after completion.
         */
        (node.startedAt ? '<em>' + esc(node.finishedAt ? duration(node.startedAt, node.finishedAt) : '进行中') + '</em>' : '') +
        '<em>' + Number((node.evidence || []).length) + ' 条证据</em><svg viewBox="0 0 24 24"><path d="m8 10 4 4 4-4"/></svg></summary>' +
      executorHtml(node) + TaskTraceExecutionDetails.handoffHtml(node, { esc }) +
      TaskTraceExecutionDetails.failureHtml(node, { esc, errorText }) +
      evidenceHtml(node.evidence, node) + stageExtrasHtml(node) + '</details>';
  }

  function agentLabel(value) {
    const raw = String(value || '');
    return ({ 'local:pi': 'Pi', 'local:opencode': 'OpenCode', 'local:claude': 'Claude Code',
      'local:codex': 'Codex' })[raw] || raw.replace(/^runner:/, 'Runner · ');
  }

  function executorHtml(node) {
    if (!['ai', 'ai_review'].includes(String(node && (node.kind || node.type) || ''))) return '';
    const executor = (node && node.executor) || {};
    const requested = executor.requested || {};
    const resolved = executor.resolved || {};
    const wanted = [agentLabel(requested.agentKind), requested.model].filter(Boolean);
    const actual = [executor.assignee || agentLabel(resolved.agentKind), resolved.model,
      resolved.host || executor.host].filter((value, index, rows) => value && rows.indexOf(value) === index);
    if (!wanted.length && !actual.length) return '';
    return '<div class="tfd-executor"><span><small>计划执行</small><b>' +
      esc(wanted.join(' · ') || '跟随插件默认设置') + '</b></span><i>→</i><span><small>实际执行</small><b>' +
      esc(actual.join(' · ') || '正在选择可用执行机') + '</b></span>' +
      (executor.fallbackReason ? '<em title="' + esc(executor.fallbackReason) + '">已按策略降级</em>' : '') +
      '</div>';
  }

  function runsHtml(trace, run, node, opts) {
    const runs = trace.runs || [];
    const protocol = String(trace.schemaVersion || '').startsWith('1.');
    const latest = run ? latestNodes(run) : new Map();
    const currentNodes = protocol ? (node ? [node] : standardStages(trace, run).slice(0, 1)) :
      ((run && run.nodes) || []).filter((item) => latest.get(String(item.key || '')) === item);
    if (!currentNodes.length) return '<section class="tfd-empty-flow"><b>执行过程还没有开始</b><span>' +
      '需求已经建立；派给人或 AI 后，计划、会话、证据、确认和交付会按同一标准出现在这里。</span></section>';
    const earlierAttempts = protocol || !run ? [] : (run.nodes || []).filter((item) =>
      latest.get(String(item.key || '')) !== item);
    const currentId = String((node || {}).id || '');
    const evidence = '<section class="tfd-section"><div class="tfd-section-head"><div><span data-i18n="eyebrow.stage_detail">STAGE DETAIL</span>' +
      '<b>当前阶段</b></div><small>这里汇总所选关卡的真实会话、证据、确认和结果</small></div><div class="tfd-node-list">' +
      currentNodes.map((item) => nodeHtml(item, item.runId || (run || {}).id || '',
        String(item.id || '') === currentId)).join('') +
      (earlierAttempts.length ? '<details class="tfd-attempts" data-tfd-open="attempts:' + esc((run || {}).id || '') + '"><summary>返工与重试记录 <span>' +
        earlierAttempts.length + ' 轮</span></summary><div>' + earlierAttempts.map((item) =>
          nodeHtml(item, (run || {}).id || '', false)).join('') + '</div></details>' : '') + '</div></section>';
    const historical = runs.filter((item) => item !== run);
    if (!historical.length || opts.variant === 'execution') return evidence;
    return evidence + '<details class="tfd-history" data-tfd-open="history"><summary>历史执行记录 <span>' + historical.length +
      ' 次</span></summary>' + historical.map((old) => "<article><header><b" + ((old.plugin || {}).name ? ' data-user-content' : '') + '>' +
        esc((old.plugin || {}).name || '工作流') + '</b><span class="is-' + tone(old.state) + '">' +
        esc(stateText(old.state)) + '</span><small>' + esc(dateText(old.createdAt)) + '</small></header>' +
        (old.nodes || []).map((item) => nodeHtml(item, old.id || '', false)).join('') + '</article>').join('') + '</details>';
  }

  function approvalsHtml(list, opts) {
    if (!list || !list.length) return '';
    return '<details class="tfd-group" data-tfd-open="approvals"><summary>' +
      '<span><i class="tfd-group-icon is-human"></i><b>人工关口</b><small>' + list.length + ' 项决定</small></span>' +
      '<svg viewBox="0 0 24 24"><path d="m8 10 4 4 4-4"/></svg></summary><div class="tfd-decision-list">' +
      list.map(decisionDetailHtml).join('') + '</div></details>';
  }

  function deploymentsHtml(list, opts) {
    if (!list || !list.length) return '';
    return '<details class="tfd-group" data-tfd-open="deployments"><summary>' +
      '<span><i class="tfd-group-icon is-env"></i><b>环境与发布</b><small>' + list.length + ' 次运行</small></span>' +
      '<svg viewBox="0 0 24 24"><path d="m8 10 4 4 4-4"/></svg></summary><div class="tfd-deployment-list">' +
      list.map(deploymentDetailHtml).join('') + '</div></details>';
  }

  function aiHtml(list, opts) {
    if (!list || !list.length) return '';

    if (opts.variant === 'execution') return '';
    return '<details class="tfd-group" data-tfd-open="ai-sessions"><summary>' +
      '<span><i class="tfd-group-icon is-ai"></i><b>AI 执行会话</b><small>' + list.length + ' 条会话</small></span>' +
      '<svg viewBox="0 0 24 24"><path d="m8 10 4 4 4-4"/></svg></summary><div class="tfd-session-list">' +
      list.map(sessionDetailHtml).join('') + (opts.variant !== 'execution' ?
        '<button class="tfd-live-entry" data-tfd-action="live">查看对话</button>' : '') + '</div></details>';
  }

  function artifactsHtml(trace) {
    const artifacts = trace.artifacts || [];
    const attachments = (trace.attachments || []).filter((item) => item.role !== 'process');
    const rework = attachments.filter(item => item.role === 'rework_input');
    const deliveryFiles = attachments.filter(item => item.role !== 'rework_input');
    if (!artifacts.length && !attachments.length) return '';
    const fileHtml = rows => rows.map((item) => '<a class="' +
      (item.isImage ? 'is-image' : '') + '" href="' + esc(fullUrl(item)) +
      '" target="_blank" rel="noreferrer">' + (item.isImage ? '<img src="' + esc(fullUrl(item)) +
      '" loading="lazy" decoding="async" alt="">' : '') + "<span><b" + (item.filename ? ' data-user-content' : '') + '>' + esc(item.filename || '文件') + '</b><small>' +
      esc([item.role === 'input' ? '输入材料' : item.role === 'verification' ? '验证证据' :
        item.byAgent ? 'AI 产出' : '需求附件',
        Number(item.evidenceMeta?.round || item.meta?.round || item.round || 0) > 0 ?
          '第 ' + Number(item.evidenceMeta?.round || item.meta?.round || item.round) + ' 轮' : '',
        item.evidenceMeta?.versionId || item.meta?.versionId ? '版本 ' + String(item.evidenceMeta?.versionId || item.meta?.versionId).slice(0, 12) : '',
        fileSize(item.size)].filter(Boolean).join(' · ')) +
      '</small></span></a>').join('');
    return '<details class="tfd-group" data-tfd-open="artifacts"><summary><span><i class="tfd-group-icon is-file"></i>' +
      '<b>固定版本与文件</b><small>' + artifacts.length + ' 个版本 · ' + deliveryFiles.length + ' 份交付文件' + (rework.length ? ' · ' + rework.length + ' 份返修参考' : '') + '</small></span>' +
      '<svg viewBox="0 0 24 24"><path d="m8 10 4 4 4-4"/></svg></summary><div class="tfd-artifacts">' +
      '<div class="tfd-output-grid">' + artifacts.map(outputDetailHtml).join('') + '</div>' +
      (deliveryFiles.length ? '<div class="tfd-files"><h4>交付文件</h4>' + fileHtml(deliveryFiles) + '</div>' : '') +
      (rework.length ? '<details class="tfd-rework-files"><summary>返修参考 · ' + rework.length + ' 份<small>只作为返修输入，不计入固定交付</small></summary><div class="tfd-files">' + fileHtml(rework) + '</div></details>' : '') +
      '</div></details>';
  }

  const TURN_STATE_TEXT = {
    queued: '已排队，等待执行', running: '已开始执行', waiting: '等待补充或人工处理',
    completed: '本轮执行完成', failed: '本轮执行失败', cancelled: '本轮执行已取消',
  };

  function eventTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      // TaskEvent.to_api returns epoch milliseconds. Accept seconds too so
      // older integrations do not sort a valid event as year 51382.
      return value < 100000000000 ? value * 1000 : value;
    }
    const text = String(value || '').trim();
    if (!text) return 0;
    const numeric = Number(text);
    if (Number.isFinite(numeric)) return numeric < 100000000000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const TURN_EVENT_TEXT = {
    queued: '执行已排队', running: '执行已开始', waiting: '执行等待处理',
    completed: '执行本轮已完成', failed: '执行本轮失败', cancelled: '执行本轮已取消',
  };

  function timelineText(value, params) {
    return window.SoduWorkI18n?.t ? window.SoduWorkI18n.t(value, value, params || {}) :
      String(value).replace(/\{(\w+)\}/g, (match, key) => params?.[key] ?? match);
  }

  function timelineEventText(item, list) {
    const kind = String((item || {}).kind || '');
    const detail = (item || {}).detail || {};
    if (kind === 'conversation.turn') return TURN_EVENT_TEXT[String(detail.state || '')] || '执行状态已更新';
    if (kind === 'comment') return '讨论留言';
    if (kind === 'release.approved' || kind === 'release.rejected') {
      // A generic approval can be submitted by a person or an automatic review.
      // Match the recorded operation, never infer its origin from free-form notes.
      const automatic = list.some(row => row.kind === 'artifact.auto_reviewed' && detail.requestId &&
        row.detail?.requestId === detail.requestId && row.detail?.versionId === detail.versionId &&
        row.actor === item.actor && row.detail?.verdict === (kind === 'release.approved' ? 'approved' : 'rejected'));
      if (automatic) return kind === 'release.approved' ? '自动验收通过' : '自动验收未通过';
      if (detail.action === 'review') return kind === 'release.approved' ? '验收通过' : '退回修改';
    }
    if (EVENT_TEXT[kind]) return EVENT_TEXT[kind];
    return '需求更新';
  }

  function eventSummary(item) {
    const d = item.detail || {};
    const parts = [];
    const status = value => timelineText(({todo: '待开始', doing: '进行中', reviewing: '待验收',
      intake: '收集箱', clarifying: '待补充', ready: '待开始', delivering: '进行中', delivered: '已完成',
      closed: '已归档', archived: '已归档', paused: '已暂停'})[value] || STATE_TEXT[value] || '状态已更新');
    if (item.kind === 'conversation.turn' && d.state) parts.push(timelineText(TURN_STATE_TEXT[d.state] || '执行状态已更新'));
    if (d.executor) parts.push(timelineText(({ native: '本机对话', workflow: '工作流', dispatch: '执行机' })[d.executor] || '执行方式已更新'));
    if (d.fromStage || d.toStage) parts.push([d.fromStage, d.toStage].filter(Boolean).map(status).join(' → '));
    if (d.from || d.to) parts.push([d.from, d.to].filter(Boolean).map(status).join(' → '));
    parts.push(d.note, d.summary || d.report?.summary, d.reason, d.environmentName, d.commit && String(d.commit).slice(0, 12));
    if (Array.isArray(d.files) && d.files.length) parts.push(timelineText('涉及 {count} 个文件', {count: d.files.length}) + ': ' +
      d.files.map(file => typeof file === 'string' ? file : file?.filename || file?.name || file?.path || '').filter(Boolean).join('、'));
    return parts.filter(Boolean).join(' · ');
  }

  function timelineActor(value) {
    const actor = String(value || '');
    if (/^agent(?::|$)/i.test(actor)) return timelineText('AI 助手');
    if (!actor || /^(system|SoduWork)$/i.test(actor)) return timelineText('系统');
    return actor;
  }

  function timelineDateText(value) {
    const timestamp = eventTimestamp(value);
    if (!timestamp) return '';
    const d = new Date(timestamp);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString((globalThis.SoduWorkI18n?.getLocale() || 'zh-CN'), {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  function timelineRows(list) {
    return list.map((item, index) => ({ item, index })).sort((a, b) => {
      const atA = eventTimestamp(a.item.at);
      const atB = eventTimestamp(b.item.at);
      return atB - atA || b.index - a.index;
    }).map(({ item }) => item);
  }

  function timelineHtml(events, options = {}) {
    const list = [...(events || []), ...(options.comments || []).map(row => ({
      id: row.id ? 'comment:' + row.id : '', kind: 'comment', actor: row.authorName || timelineText('成员'), at: row.createdAt, detail: {note: row.body},
    }))];
    if (!list.length) return options.embedded ? '<p>' + esc(timelineText('暂无活动记录')) + '</p>' : '';
    const rows = timelineRows(list);
    const body = '<ol>' + rows.map(item => {
      const summary = eventSummary(item);
      const date = timelineDateText(item.at);
      const key = 'note:' + (item.id || [item.kind, item.actor, item.at].join(':'));
      const description = summary.length > 120
        ? '<details class="tfd-event-note" data-tfd-open="' + esc(key) + '"><summary><span data-user-content>' + esc(summary.slice(0, 120)) + '…</span><b>' +
          esc(timelineText('查看完整说明')) + '</b></summary><p data-user-content>' + esc(summary) + '</p></details>'
        : summary ? '<span data-user-content>' + esc(summary) + '</span>' : '';
      return '<li><i aria-hidden="true"></i><div><b>' + esc(timelineText(timelineEventText(item, list))) + '</b>' + description +
        '</div><small><span data-user-content>' + esc(timelineActor(item.actor)) + '</span>' + (date ? ' · ' + esc(date) : '') + '</small></li>';
    }).join('') + '</ol>';
    if (options.embedded) return '<div class="tfd-timeline is-activity">' + body + '</div>';
    return '<details class="tfd-group tfd-timeline" data-tfd-open="timeline"><summary><span><i class="tfd-group-icon is-time"></i>' +
      '<b>' + esc(timelineText('活动记录')) + '</b><small>' + esc(timelineText('{count} 条记录 · 按实际发生时间倒序', {count: list.length})) +
      '</small></span><svg viewBox="0 0 24 24"><path d="m8 10 4 4 4-4"/></svg></summary>' + body + '</details>';
  }

  function html(trace, rawOpts) {
    const opts = Object.assign({ variant: 'task' }, rawOpts || {});
    _renderVariant = opts.variant;
    if (opts.variant === 'execution' && opts.compact && window.TaskTraceRailView) {
      return window.TaskTraceRailView.html(trace, opts);
    }
    if (!trace) return '<div class="tfd-shell tfd-empty"><b>全链路暂时没有加载成功</b><span>请刷新后再试。</span></div>';
    const run = currentRun(trace);
    const stages = standardStages(trace, run);
    const node = stages.find((item) => String(item.id || '') === String(opts.selectedStageId || '')) ||
      currentNode(trace, run) || stages[0] || null;
    const automated = isAutomated(trace);
    /*
     * suppressInlineApproval avoids duplicating a decision card already shown by the host.
     * Other surfaces retain their inline approval card.
     */
    const inlineApproval = window.TaskTraceApproval && !opts.suppressInlineApproval
      ? window.TaskTraceApproval.html(trace.approvals, opts, window.TaskTraceApproval.currentId(trace, node)) : '';
    const approvalGroup = opts.variant === 'task' ? '' : approvalsHtml(trace.approvals, opts);
    return '<div class="tfd-shell is-' + esc(opts.variant) + '">' + heroHtml(trace, opts, run, node) +
      (window.TaskProjectContextView ? TaskProjectContextView.html(trace.projectContext) : '') +
      (automated ? phasesHtml(trace, run, node) : '') + deliveryHtml(trace, opts) + inlineApproval +
      (window.TaskEvolutionView ? TaskEvolutionView.html(trace, opts) : '') +
      (automated ? runsHtml(trace, run, node, opts) : '') + '<section class="tfd-groups">' +
      approvalGroup + deploymentsHtml(trace.deployments, opts) +
      aiHtml((((trace.execution || {}).sessions) || trace.ai), opts) +
      artifactsHtml(trace) + (opts.suppressTimeline ? '' : timelineHtml(trace.timeline)) + '</section></div>';
  }

  function isAutomated(trace) {
    const delivery = (trace || {}).delivery || (((trace || {}).card || {}).delivery) || {};
    return delivery.authority ? delivery.authority !== 'manual' : !!((trace.runs || []).length || (trace.ai || []).length ||
      ((((trace || {}).execution || {}).sessions) || []).length || (trace.deployments || []).length);
  }

  function openTask(taskId) {
    /*
     * Use the shared requirement-details entry point to preserve native window ownership and
     * focus.
     */
    if (typeof openDetailEntry === 'function') return openDetailEntry(taskId);
    if (typeof openTaskDetail === 'function') return openTaskDetail(taskId);
    if (typeof openDetail === 'function') return openDetail(taskId);
  }

  function openExternal(link) {
    const href = String((link && link.href) || '');
    if (!/^https?:\/\//i.test(href)) return;
    const bridge = window.soduWorkAPI;
    /*
     * Open evidence and delivery links in the system browser from Electron; use window.open
     * only in browser previews.
     */
    if (bridge && typeof bridge.openExternal === 'function') {
      Promise.resolve(bridge.openExternal(href)).then((result) => {
        if (result && result.ok === false && typeof petSay === 'function') petSay('这个链接暂时没能打开');
      }).catch(() => {
        if (typeof petSay === 'function') petSay('这个链接暂时没能打开');
      });
      return;
    }
    window.open(href, '_blank', 'noopener,noreferrer');
  }

  const copyText = value => window.TaskTraceExecutionDetails.copyText(value);

  function approvalFocus(trace, taskId) {
    const rows = (trace && trace.approvals) || [];
    const open = (window.TaskTraceApproval ? window.TaskTraceApproval.current(rows) : null) || rows.slice().reverse().find((item) =>
      ['waiting_human', 'waiting'].includes(String((item || {}).status || '')));
    return { taskId: String(taskId || ''), approvalId: String((open || {}).id || '') };
  }

  /* Handoff, runtime selection, and redispatch confirmations live in task-trace-execution-details.js. */

  async function runAction(button, action, root, state) {
    const trace = state.trace || {};
    const taskId = ((trace.task || {}).id) || ((trace.card || {}).taskId) || state.opts.taskId;
    if (action === 'task') return openTask(taskId);
    if (action === 'live') return typeof openAIDeskEntry === 'function' ? openAIDeskEntry(taskId) : openTask(taskId);
    if (action === 'approval-inline-focus') {
      const block = root.querySelector('.tfd-inline-approval');
      const form = block && block.querySelector('.tfd-inline-approval-form');
      if (block) {
        if (form) form.open = true;
        block.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      return typeof openApprovalsEntry === 'function'
        ? openApprovalsEntry(approvalFocus(trace, taskId)) : null;
    }
    if (action === 'approval') return typeof openApprovalsEntry === 'function'
      ? openApprovalsEntry(approvalFocus(trace, taskId)) : null;
    if (action === 'evolution') {
      const panel = root.querySelector('[data-tfd-open="evolution"]');
      if (panel) { panel.open = true; panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      return;
    }
    if (action === 'download') {
      const label = button.textContent; button.disabled = true; button.textContent = '正在准备…';
      try { const delivery = trace.delivery || ((trace.card || {}).delivery) || {}; await SoduWorkAPI.downloadArtifactsZip(taskId, ((trace.task || {}).title) || '产出', state.opts.artifactVersionId || ((delivery.artifact || {}).id) || ''); if (typeof petSay === 'function') petSay('当前固定版本已经保存'); }
      catch (error) { if (typeof petSay === 'function') petSay(typeof _humanErr === 'function' ? _humanErr(error, '成果暂时没能保存') : '成果暂时没能保存'); }
      finally { button.disabled = false; button.textContent = label; } return;
    }
    if (action === 'handoff') return TaskTraceExecutionDetails.confirmHandoff(root, state);
    const runId = String(((trace.card || {}).runId) || '');
    if (!runId) return;
    const run = currentRun(trace);
    const retryNode = standardStages(trace, run).find((item) =>
      String(item.id || '') === String(state.opts.selectedStageId || '')) || currentNode(trace, run) || {};
    if (action === 'retry-agent') return TaskTraceExecutionDetails.confirmRetryAgent(root, state, retryNode, runId, 'retry', esc);
    if (action === 'redispatch') return TaskTraceExecutionDetails.confirmRetryAgent(root, state, retryNode, runId, 'redispatch', esc);
    const label = button.textContent;
    button.disabled = true; button.textContent = '正在处理…';
    try {
      if (action === 'recover') await SoduWorkAPI.recoverTaskPluginArtifacts(runId);
      else if (action === 'retry-quality') await SoduWorkAPI.retryTaskPluginQuality(runId);
      else if (action === 'retry-gate') await SoduWorkAPI.retryTaskPluginGate(
        runId, retryNode.key || '', null, {
          resumeRework: String(((retryNode.diagnosis || {}).actionKey) || '') === 'resume-rework',
        });
      if (typeof petSay === 'function') petSay('已从当前关口继续');
      await state.refresh(true);
      if (typeof state.opts.onChanged === 'function') state.opts.onChanged(taskId);
    } catch (error) {
      button.disabled = false; button.textContent = label;
      if (typeof petSay === 'function') petSay(typeof _humanErr === 'function' ? _humanErr(error, '当前关口还不能继续') : '当前关口还不能继续');
    }
  }

  function bind(root, trace, opts, state) {
    root.querySelectorAll('a[target="_blank"]').forEach((link) => link.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation();
      openExternal(link);
    }));
    root.querySelectorAll('[data-tfd-stage]').forEach((button) => button.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = button.getAttribute('data-tfd-stage') || '';
      if (!id || id === String(state.opts.selectedStageId || '')) return;
      state.opts.selectedStageId = id;
      const rendered = html(trace, state.opts);
      root.innerHTML = rendered;
      state.signature = rendered;
      bind(root, trace, state.opts, state);
      const detail = root.querySelector('.tfd-section, .trv-detail');
      const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (detail) detail.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    }));
    root.querySelectorAll('[data-tfd-action]').forEach((button) => button.addEventListener('click', (event) => {
      event.stopPropagation();
      runAction(button, button.getAttribute('data-tfd-action') || '', root, state);
    }));
    if (window.TaskTraceApproval) window.TaskTraceApproval.bind(root, state);
    root.querySelectorAll('[data-tfd-copy]').forEach((button) => button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const value = button.getAttribute('data-tfd-copy') || '';
      if (!value) return;
      if (await copyText(value)) {
        const old = button.textContent; button.textContent = '已复制工作目录';
        setTimeout(() => { if (button.isConnected) button.textContent = old; }, 1200);
      } else if (typeof petSay === 'function') petSay('暂时没能复制，可以选中文字后复制');
    }));
    if (window.TaskEvolutionView) TaskEvolutionView.bind(root, {
      trace, refresh: () => state.refresh(true), changed: state.opts.onChanged,
    });
  }

  const api = { html, bind, stateText, tone, esc, timelineHtml,
    gateHtml: gatePacketHtml, openEvidence: openExternal,
    isLive: (value) => LIVE.has(String(value || '')),
  };
  window.TaskExecutionJourney = api;
  window.TaskFlowDetail = api;
  window.TaskTraceView = api;
})();
