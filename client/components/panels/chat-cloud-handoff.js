/* Cloud execution uses the existing task conversation, within the same chat. */
(function (global) {
  'use strict';
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17H6a4 4 0 0 1-.5-8 6.5 6.5 0 0 1 12.4-1A4.5 4.5 0 0 1 18 17h-1M12 20V10m-3 3 3-3 3 3"/></svg>';
  const PC_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]));
  const size = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB';
  const labels = { preparing: '正在准备交接', uploading: '正在上传工作文件', prepared: '已准备好交接',
    committing: '正在确认云端执行', committed: '云端会话', aborted: '已撤销交接' };
  let active = null, activeContext = null;
  const ownerScope = () => global.SoduWorkAPI?.taskStorageKey?.('ops') || '';
  const sameSession = ref => !global.NativeChat?.sessionInfo || global.NativeChat.sessionInfo()?.ref === ref;
  global.addEventListener?.('soduwork-data-scope-changed', () => activeContext?.close());
  function sync(root, snapshot, context) {
    if (context !== undefined && activeContext && (activeContext.ref !== context?.ref || activeContext.owner !== ownerScope())) activeContext.close();
    if (!root) return;
    const value = snapshot?.cloudHandoff?.phase === 'aborted' ? null : snapshot?.cloudHandoff;
    if (context !== undefined) root.dataset.executionSessionReady = context?.ref ? 'true' : 'false';
    const ready = root.dataset.executionSessionReady === 'true';
    const transitioning = !!value && value.phase !== 'committed';
    const personal = value?.target?.runnerKind === 'work-computer';
    const committed = value?.phase === 'committed';
    const cloud = committed && !personal;
    global.WorkComposer?.syncExecutionMenu?.(root, cloud ? 'cloud' : 'local', !ready || Boolean(snapshot?.runtimeSwitching),
      context === undefined ? undefined : ownerScope() + ':' + (context?.ref || ''));
    if (personal) root.querySelectorAll('[data-execution-menu]').forEach(button => {
      button.setAttribute('aria-label', '执行位置：我的电脑');
      button.title = '我的电脑执行，点击查看执行位置';
    });
    root.querySelectorAll('[data-chat-execution]').forEach(control => {
      const selected = control.dataset.chatExecution === (cloud ? 'cloud' : 'local');
      control.classList.toggle('on', selected);
      control.setAttribute('aria-checked', String(selected)); control.setAttribute('aria-pressed', String(selected));
      control.disabled = !ready || Boolean(snapshot?.runtimeSwitching) || (cloud && control.dataset.chatExecution === 'local' && ['streaming', 'running', 'queued'].includes(snapshot?.status));
      control.title = personal ? '当前会话在我的电脑执行，点击查看状态' : control.dataset.chatExecution === 'cloud'
        ? (cloud ? '当前会话在云端执行，点击查看状态' : value ? labels[value.phase] || '查看云端交接' : '转到云端继续')
        : cloud ? '将已完成的成果带到新的本机会话' : transitioning ? '查看并撤销云端交接' : '本机执行';
    });
    const button = root.querySelector('[data-chat-cloud-status]');
    if (button) {
      if (context !== undefined) button.dataset.sessionReady = context?.ref ? 'true' : 'false';
      const ready = button.dataset.sessionReady === 'true';
      button.hidden = !value && !ready;
      button.disabled = !ready || Boolean(snapshot?.runtimeSwitching);
      const name = personal ? '我的电脑会话' : value ? (value.entryKind === 'cloud' ? '云端会话' : '查看云端交接') : '转到云端';
      const place = personal ? '电脑' : '云端';
      button.querySelector('span').textContent = value?.pendingApprovals ? place + '待审批' : value?.outputError ? place + '成果待同步' : value?.historyGap ? place + '记录待核对' : personal && committed ? name : value ? labels[value.phase] || name : name;
      button.title = value
        ? (personal ? `当前会话在我的电脑执行：${value.target.runnerName || value.target.name || value.target.host || '我的电脑'}` : value.target?.name ? `当前会话在云端执行，执行机：${value.target.name}` : '当前会话在云端执行，执行机由系统自动选择')
        : '将当前任务、工作记录与文件交给云端继续执行';
      button.setAttribute('aria-label', name);
      button.classList.toggle('is-cloud', Boolean(value) && !personal);
    }
    const menu = root.querySelector('[data-chat-cloud]');
    if (menu) {
      menu.hidden = !value && !ready;
      menu.disabled = !ready || Boolean(snapshot?.runtimeSwitching);
      menu.querySelector('span').textContent = personal ? '我的电脑会话' : value ? (value.entryKind === 'cloud' ? '云端会话' : '查看云端交接') : '转到云端';
    }
  }
  // Both confirmations use locally defined markup; server values are rendered
  // separately through display() with escaping or textContent.
  function dialogShell(label, markup) {
    const dialog = document.createElement('dialog');
    dialog.className = 'nchat-rename-dialog ncloud-dialog';
    dialog.setAttribute('aria-labelledby', label);
    dialog.innerHTML = markup;
    return dialog;
  }
  async function select(target, context) {
    if (!context?.ref || !['local', 'cloud'].includes(target) || active) return;
    const handoff = context.snapshot?.cloudHandoff;
    // A personal-PC receipt remains bound to that execution. Reuse the
    // existing status dialog rather than creating a new local continuation.
    if (handoff?.phase === 'committed' && handoff.target?.runnerKind === 'work-computer') {
      return open(context.ref);
    }
    if (target === 'cloud' || handoff && !['committed', 'aborted'].includes(handoff.phase)) return open(context.ref);
    if (handoff?.phase !== 'committed') return;
    if (['streaming', 'running', 'queued'].includes(context.snapshot?.status)) {
      global.petSay?.('请等待本轮云端执行结束，再带成果回到本机'); return;
    }
    // Cloud still owns the original conversation. Continue from a private copy;
    // never pretend that changing an icon migrates a live remote workspace.
    const ref = context.ref, owner = ownerScope();
    const delivery = global.ChatDeliveries?.localContinuation?.(ref) || '';
    const dialog = dialogShell('ncloudLocalTitle', '<form class="nchat-rename-form"><header><div><h2 id="ncloudLocalTitle">在本机继续</h2>' +
      '<p>云端会话和记录会保留。' + (delivery ? '已完成的成果会复制到新的本机工作区，云端后续修改不会覆盖本机文件。' : '当前还没有可带回的成果，将打开新的本机会话。') + '</p></div>' +
      '<button type="button" class="nchat-rename-close" data-local-close aria-label="关闭">×</button></header>' +
      '<footer><button type="button" data-local-close>留在云端</button><button type="submit" class="nchat-rename-save">' +
      (delivery ? '带成果在本机继续' : '新建本机会话') + '</button></footer></form>');
    const close = () => { dialog.close(); dialog.remove(); if (active === dialog) { active = null; activeContext = null; } };
    const current = () => active === dialog && owner === ownerScope() && sameSession(ref);
    dialog.querySelectorAll('[data-local-close]').forEach(button => button.addEventListener('click', close));
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      if (!current()) { close(); return; }
      if (global.NativeChat?.isBusy?.()) { close(); global.petSay?.('请等待本轮云端执行结束，再带成果回到本机'); return; }
      if (delivery !== (global.ChatDeliveries?.localContinuation?.(ref) || '')) { close(); global.petSay?.('成果已更新，请重新选择本机执行'); return; }
      close();
      try {
        if (delivery) await global.ChatDeliveries.continueLocal(ref, delivery, global.soduWorkAPI?.conversationSession || global.soduWorkAPI?.piSession);
        else if (!await global.WorkspaceHost?.open('create', { newSession: true, tab: 'chat' })) throw Error('未能打开本机会话，请重试');
      } catch (error) { if (owner === ownerScope() && sameSession(ref)) global.petSay?.(error.message || '未能打开本机会话，请重试'); }
    });
    active = dialog; activeContext = { ref, owner, close }; document.body.append(dialog); dialog.showModal();
  }
  async function open(ref) {
    if (!ref || active || !sameSession(ref)) return;
    const owner = ownerScope();
    const api = (global.soduWorkAPI?.conversationSession || global.soduWorkAPI?.piSession)?.cloud;
    if (!api) { global.petSay?.('请更新客户端后使用云端交接'); return; }
    const dialog = dialogShell('ncloudTitle', '<form class="nchat-rename-form" novalidate><header><div><h2 id="ncloudTitle">转到云端继续</h2>' +
      '<p data-cloud-intro>工作记录与文件一起交接，由 SoduWork 自动安排云端服务器。</p></div>' +
      '<button type="button" class="nchat-rename-close" data-cloud-close aria-label="关闭">×</button></header>' +
      '<div data-cloud-body aria-live="polite"><p class="ncloud-muted">正在检查可用执行机与工作文件…</p></div>' +
      '<p class="nchat-rename-error" role="alert" hidden></p><footer><button type="button" data-cloud-close>关闭</button>' +
      '<button type="button" data-cloud-abort hidden>撤销交接</button><button class="nchat-rename-save" type="submit" disabled>确认交接</button></footer></form>');
    const form = dialog.querySelector('form'), body = dialog.querySelector('[data-cloud-body]');
    const submit = dialog.querySelector('[type=submit]'), abort = dialog.querySelector('[data-cloud-abort]');
    const error = dialog.querySelector('[role=alert]');
    let busy = false, preview = null, phase = '', selectedTargetId = '';
    let instructionDraft = '请根据本会话已有记录和工作文件继续完成原任务，验证最终成果并说明尚未解决的问题。';
    const dispose = () => { dialog.close(); dialog.remove(); preview = null; body.replaceChildren?.(); if (active === dialog) { active = null; activeContext = null; } };
    const close = () => { if (!busy) dispose(); };
    const current = () => {
      if (active !== dialog) return false;
      if (owner !== ownerScope() || !sameSession(ref)) { dispose(); return false; }
      return true;
    };
    const fail = message => { if (current()) { error.textContent = message; error.hidden = false; } };
    function display(value) {
      if (!current()) return;
      instructionDraft = body.querySelector('[data-cloud-instruction]')?.value ?? instructionDraft;
      preview = value;
      dialog.querySelector('[data-cloud-intro]').textContent = value.service?.local
        ? '当前后台在本机。交接后可关闭客户端，请保持这台电脑和后台服务在线。'
        : '工作记录与文件一起交接，由 SoduWork 自动安排云端服务器。';
      if (value.handoff) {
        const record = value.handoff; phase = record.phase;
        const personal = record.target?.runnerKind === 'work-computer';
        form.querySelector('footer [data-cloud-close]').textContent = '关闭';
        if (record.entryKind === 'cloud' || phase === 'committed') {
          dialog.querySelector('#ncloudTitle').textContent = personal ? '我的电脑会话' : '云端会话';
          dialog.querySelector('[data-cloud-intro]').textContent = personal
            ? '会话在所选的本人电脑执行，请保持该电脑的 SoduWork 客户端在线。' : value.service?.local
            ? '会话由远程服务器执行。当前后台在本机，请保持本机后台在线。' : 'SoduWork 已自动安排远程服务器执行。';
        }
        body.innerHTML = '<section class="ncloud-receipt-card"><div class="ncloud-receipt">' + (personal ? PC_ICON : ICON) + '<strong>' + esc(personal && phase === 'committed' ? '我的电脑会话' : labels[phase] || phase) + '</strong></div>' +
          '<p class="ncloud-target" translate="no">' + esc(record.target?.runnerName || record.target?.name || record.target?.host || '远程执行机') + '</p>' +
          '<p class="ncloud-muted">' + (phase === 'committed'
            ? (personal ? '继续在当前对话中发送消息和查看成果。执行位置保持在所选的本人电脑，权限由该电脑的执行环境管理。' : '继续在当前对话中发送消息和查看成果。执行位置保持在云端，权限由云端环境管理。')
            : phase === 'aborted' ? '交接已撤销，可以继续本地对话。'
              : record.accepted ? '云端已受理，会自动继续处理。可关闭客户端，之后重新打开查看进度。'
                : '本地执行已暂停。若网络中断，可核对原交接回执；未确认前不会在两台机器上同时执行。') + '</p>' +
          (record.pendingMessages ? '<p class="ncloud-muted">有 ' + Number(record.pendingMessages) + ' 条消息已受理，正在等待执行机确认。</p>' : '') +
          (record.historyGap ? '<p class="ncloud-muted">部分历史记录尚未同步，已有记录已保留；可在原执行机核对。</p>' : '') +
          (record.outputError ? '<p class="ncloud-muted">云端成果尚未完成同步，将自动重试；已收到的过程记录已保留。</p>' : '') +
          (record.pendingApprovals ? '<button type="button" data-cloud-review>查看待处理审批（' + Number(record.pendingApprovals) + '）</button>' : '') + '</section>';
        if (record.error) fail(record.error);
        abort.hidden = record.accepted === true || (record.canAbort !== undefined
          ? record.canAbort !== true : ['committed', 'aborted', 'committing'].includes(phase));
        submit.textContent = phase === 'committed' ? '刷新状态' : '核对并继续交接';
        submit.hidden = phase === 'aborted'; submit.disabled = false;
        return;
      }
      phase = '';
      const targets = value.targets || [], fallback = value.fallback;
      if (!targets.some(target => target.id === selectedTargetId)) selectedTargetId = '';
      const targetPicker = targets.length ? '<label class="ncloud-target-picker">' +
        '\u6267\u884c\u7535\u8111' +
        '<select data-cloud-target aria-label="\u6267\u884c\u7535\u8111"><option value="">\u81ea\u52a8\u9009\u62e9\uff08\u63a8\u8350\uff09</option>' +
        targets.map(target => {
          const id = String(target.id || '');
          const label = target.runnerName || target.machineLabel || target.name || target.runnerId || id;
          const agentLabel = target.cliName || target.agentId || '';
          return '<option value="' + esc(id) + '"' + (id === selectedTargetId ? ' selected' : '') + '>' +
            esc(agentLabel ? label + ' · ' + agentLabel : label) + '</option>';
        }).join('') + '</select></label>' : '';
      const agent = global.AgentBrand?.LABELS?.[value.source?.agentId] || ({ pi: 'Pi', opencode: 'OpenCode', qwen: 'Qwen Code', codex: 'Codex' }[value.source?.agentId]) || value.source?.agentId || '当前 Agent';
      body.innerHTML = '<div class="ncloud-auto" data-cloud-auto>' + ICON + '<div><strong>' + (fallback ? '改用 Pi 在云端继续？' : targets.length ? '自动选择云端服务器' : '暂无可用的云端服务器') + '</strong>' +
        '<p class="ncloud-muted">' + (fallback ? esc('云端暂无可用的 ' + agent + '。可改用 Pi 和已授权的云端默认模型，保留工作记录与文件。') : targets.length ? esc('继续使用 ' + agent + '，自动选择可用服务器。') : esc(value.diagnostics?.summary || '请先接入一台支持当前 Agent 的远程服务器。')) + '</p></div></div>' +
        (!targets.length ? '<div class="ncloud-setup-actions"><button type="button" data-cloud-configure>配置云端环境</button><button type="button" data-cloud-refresh>重新检查</button></div>' : '') +
        '<label>继续执行的目标<textarea data-cloud-instruction rows="3">' + esc(instructionDraft) + '</textarea></label>' +
        '<details class="ncloud-files"><summary>将交接 ' + (value.files || []).length + ' 个文件 · ' + size(value.total || 0) + '</summary><ul>' +
          (value.files || []).map(file => '<li><span>' + esc(file.path) + '</span><small>' + size(file.size) + '</small></li>').join('') + '</ul></details>' +
        ((value.excluded || []).length ? '<details class="ncloud-files"><summary>不传输 ' + value.excluded.length + ' 项凭据、缓存或链接</summary><ul>' +
          value.excluded.map(file => '<li>' + esc(file.path) + '</li>').join('') + '</ul></details>' : '') +
        '<p class="ncloud-muted">' + (value.running ? '确认后先停止本轮本地执行，再交接到云端。' : '') +
          '云端会基于工作记录继续执行；运行中的程序、电脑操作和浏览器登录状态不会迁移。请确认清单内不含需要留在本机的私密文件。</p>';
      if (targetPicker) body.insertAdjacentHTML('afterbegin', targetPicker);
      submit.disabled = !targets.length; submit.textContent = fallback ? '同意改用 Pi 并转到云端' : '转到云端继续'; abort.hidden = true;
      form.querySelector('footer [data-cloud-close]').textContent = '留在本地';
    }
    async function perform(action) {
      if (busy || !current()) return;
      busy = true; error.hidden = true; form.setAttribute('aria-busy', 'true');
      dialog.querySelectorAll('button').forEach(button => { button.disabled = true; });
      const label = submit.textContent; submit.textContent = action === 'confirm' ? '正在交接…' : '正在核对…';
      try {
        const value = action === 'confirm' ? await api.confirm(ref, { previewId: preview.previewId,
          ...(selectedTargetId ? { assigneeId: selectedTargetId } : {}),
          ...(preview.fallback ? { agentFallback: { ...preview.fallback, accepted: true } } : {}),
          instruction: body.querySelector('[data-cloud-instruction]').value }) : await api[action](ref);
        if (!current()) return;
        if (!value?.ok) throw Error(value?.reason || '交接没有完成，请重试');
        display(value.handoff || action === 'preview' ? value : await api.preview(ref));
        if (!current()) return;
        if (value.reopenLocal && global.NativeChat?.sessionInfo().ref === ref) {
          global.NativeChat.reset();
          await global.NativeChat.enter('', value.sessionId);
        }
      } catch (problem) {
        if (!current()) return;
        try { const latest = await api.preview(ref); if (latest?.ok) display(latest); } catch (_) { /* preserve the original failure */ }
        fail(problem.message || '交接没有完成，请核对原请求后重试');
      } finally {
        busy = false; if (!current()) return;
        form.removeAttribute('aria-busy');
        dialog.querySelectorAll('button').forEach(button => { button.disabled = false; });
        if (!phase && !preview?.targets?.length) submit.disabled = true;
        if (submit.textContent === '正在交接…' || submit.textContent === '正在核对…') submit.textContent = label;
      }
    }
    dialog.querySelectorAll('[data-cloud-close]').forEach(button => button.addEventListener('click', close));
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    body.addEventListener('click', event => {
      if (event.target.closest('[data-cloud-review]') && !busy && current()) {
        const taskId = preview?.handoff?.taskId;
        if (taskId) { close(); void global.WorkspaceHost?.open('detail', { taskId }); }
      }
      if (event.target.closest('[data-cloud-refresh]')) void perform('preview');
      if (event.target.closest('[data-cloud-configure]') && !busy) {
        close();
        if (global.WorkspaceHost) global.WorkspaceHost.open('cloud');
        else global.openCloudEnvironmentsPanel?.();
      }
    });
    form.addEventListener('submit', event => { event.preventDefault(); void perform(phase ? 'recover' : 'confirm'); });
    body.addEventListener('change', event => {
      const target = event.target.closest?.('[data-cloud-target]');
      if (target) selectedTargetId = target.value || '';
    });
    abort.addEventListener('click', () => { void perform('abort'); });
    active = dialog; activeContext = { ref, owner, close: dispose }; document.body.append(dialog); dialog.showModal();
    try { const value = await api.preview(ref); if (!value?.ok) throw Error(value?.reason || '无法检查交接条件'); if (current()) display(value); }
    catch (problem) { if (current()) fail(problem.message); }
  }
  global.ChatCloudHandoff = { ICON, open, sync, select };
})(window);
