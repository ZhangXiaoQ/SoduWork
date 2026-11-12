/* Assignment belongs to the requirement. Selection alone never starts work. */
(function (global) {
  'use strict';
  let root = null, current = null, generation = 0, identityEpoch = 0, returnFocus = null;
  function eligible(task) {
    return global.ChatTaskController.isPickableTask(task?.canClaimExecution === true
      ? {...task, readOnly: false} : task);
  }
  function close() {
    generation++;
    if (root) global.ForwardSelect?.destroy(root);
    if (root) root.remove();
    root = null; current = null;
    if (returnFocus?.isConnected) returnFocus.focus({preventScroll: true});
    returnFocus = null;
  }
  function bindMaterials(host, task, valid) {
    const list = host.querySelector('[data-material-list]');
    const status = host.querySelector('[data-material-status]');
    const input = host.querySelector('input[type=file]');
    let revision = 0;
    async function refresh() {
      const request = ++revision;
      try {
        const files = await global.SoduWorkAPI.listAttachments(task.id);
        if (!valid() || request !== revision) return;
        const inputs = files.filter(file => file.role === 'input' || file.role === 'rework_input' || (!file.role && !file.byAgent));
        list.replaceChildren(...inputs.map(file => {
          const item = document.createElement('li');
          item.textContent = file.name || file.filename || '附件';
          item.setAttribute('data-user-content', '');
          return item;
        }));
        status.textContent = inputs.length ? '' : '暂无输入材料';
      } catch (_) {
        if (valid() && request === revision) status.textContent = '无法读取相关材料';
      }
    }
    void refresh();
    if (!input) return;
    host.querySelector('[data-material-add]').onclick = () => input.click();
    input.onchange = async () => {
      const files = Array.from(input.files);
      input.value = '';
      if (!files.length || !valid() || root.querySelector('#fwdConfirm').dataset.idleLabel != null) return;
      revision++;
      _fwdSetBusy(true, '正在上传材料…');
      status.textContent = '正在上传材料…';
      const failures = [];
      try {
        for (const file of files) {
          if (!valid()) return;
          try {
            const result = await global.SoduWorkAPI.uploadAttachment(task.id, file, {purpose: 'requirement_input'});
            if (!result || result.ok === false) failures.push(file.name);
          } catch (_) { failures.push(file.name); }
        }
        if (!valid()) return;
        await refresh();
        if (valid() && failures.length) {
          status.replaceChildren('上传失败，可重新选择失败的文件。');
          const names = document.createElement('span');
          names.setAttribute('data-user-content', '');
          names.textContent = failures.join('、');
          status.append(names);
        }
      } finally {
        if (valid()) _fwdSetBusy(false);
      }
    };
  }
  async function open(taskId, tab) {
    close(); const request = ++generation;
    returnFocus = document.activeElement;
    try {
      let task = await SoduWorkAPI.getTask(taskId);
      if (request !== generation) return false;
      if (!eligible(task)) {
        global.petSay?.('请先将需求整理为待开始；已归档、执行中或只读的需求不能重复安排。');
        return false;
      }
      if (task.readOnly && task.canClaimExecution === true) {
        task = await SoduWorkAPI.prepareRequirementExecution(task.id);
        if (request !== generation) return false;
        if (!task || task.readOnly || !eligible(task)) throw new Error('接手未完成，请刷新需求后重试');
        void global.RequirementsBoard?.refresh?.();
      }
      current = task;
      const description = global.Requirements?.displayNote?.(task) || task.description || task.note || '';
      const previous = tasks.find(row => row.id === task.id);
      if (previous) Object.assign(previous, task); else tasks.push(task);
      root = document.createElement('div'); root.className = 'rq-assignment-backdrop';
      root.innerHTML = '<div class="fwd-pop" id="fwdPop" role="dialog" aria-label="安排执行">' +
      '<div class="fwd-head"><span><b>安排这条需求</b><small>确认工作内容，选择执行方式</small></span>' +
      '<button type="button" class="fwd-x" data-act="fwd-close" title="收起" aria-label="收起">✕</button></div>' +
      '<div class="fwd-tabs" role="tablist" aria-label="安排给谁">' +
      '<button type="button" class="fwd-tab on" data-fwdtab="ai" role="tab">' + _svg('ai') + '交给 AI</button>' +
      '<button type="button" class="fwd-tab" data-fwdtab="mate" role="tab">' + _svg('user') + '转给同事</button></div>' +
      '<div class="fwd-scroll"><section class="frw-main" aria-label="需求与补充内容">' +
      '<div class="fwd-task-context"><span class="fwd-section-label">本次需求</span><h3 data-user-content>' + esc(task.title || '未命名需求') + '</h3>' +
      (description ? '<p data-user-content>' + esc(description) + '</p>' : '') + '</div>' +
      '<div class="fwd-repo" id="fwdRepo" style="display:none"><label><span>关联工程</span>' +
      '<select class="fwd-repo-sel" id="fwdRepoSel" aria-label="关联工程" disabled><option>正在加载…</option></select></label>' +
      '<small id="fwdRepoHint"></small></div>' +
      '<section class="fwd-materials"><div class="fwd-property-heading"><b>相关材料</b>' +
      (global.Requirements?.canManageMaterials?.(task) ? '<button type="button" data-material-add>添加材料</button><input type="file" multiple hidden>' : '') +
      '</div><ul data-material-list></ul><small data-material-status role="status">正在加载材料…</small></section>' +
      '<label class="fwd-note-wrap"><span>补充内容 <i>选填</i></span>' +
      '<textarea class="fwd-note" id="fwdNote" rows="5" maxlength="2000" ' +
      'placeholder="补充验收标准、口径或参考资料（选填）"></textarea></label>' +
      '<div class="fwd-foot" id="fwdFoot"></div>' +
      '<div class="fwd-prev" id="fwdPrev" style="display:none"></div></section>' +
      '<section class="fwd-settings" aria-label="执行设置"><h3 class="fwd-settings-title">执行设置</h3>' +
      '<div class="fwd-list" id="fwdList"><div class="fwd-loading"><i></i><span>正在核对可执行方式…</span></div></div>' +
      '<div class="fwd-decision" id="fwdDecision"></div>' +
      '<label class="fwd-submission-wrap"><span>交付提交方式</span><select id="fwdSubmissionMode" aria-label="交付提交方式">' +
      '<option value="">按交付物自动判断（推荐）</option><option value="manual">完成后手动提交验收</option>' +
      '</select><small>有明确输出物时自动提交；没有输出物时默认手动提交。</small></label>' +
      '</section></div>' +
      '<div class="fwd-actions"><span class="fwd-status" id="fwdStatus"></span>' +
      '<button type="button" class="fwd-confirm" id="fwdConfirm" disabled>确认派活</button></div></div>';
      root.querySelector('#fwdPop').setAttribute('aria-modal', 'true');
      document.body.appendChild(root);
      global.ForwardSelect?.enhance(root);
      const assignmentScope = identityEpoch;
      bindMaterials(root.querySelector('.fwd-materials'), task, () => request === generation && assignmentScope === identityEpoch);
      void global.RequirementSessionChoice?.mount(root.querySelector('#fwdPop'), task, {
        setBusy: _fwdSetBusy,
        valid: () => request === generation && assignmentScope === identityEpoch,
        completed: (id, chatId) => completed(id, assignmentScope, chatId),
      });
      root.addEventListener('click', event => {
        if (event.target === root || event.target.closest('[data-act="fwd-close"]')) {
          if (root.querySelector('#fwdConfirm')?.dataset.idleLabel == null) _closeFwd();
          return;
        }
        const tabButton = event.target.closest('[data-fwdtab]');
        if (tabButton) _fwdSwitch(task.id, tabButton.dataset.fwdtab);
      });
      root.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation();
          if (root.querySelector('#fwdConfirm')?.dataset.idleLabel == null) _closeFwd();
        }
        if (event.key !== 'Tab') return;
        const nodes = [...root.querySelectorAll('button:enabled,input:enabled,textarea:enabled,select:enabled')].filter(n => n.getClientRects().length);
        const first = nodes[0], last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      });
      _fwdSwitch(task.id, tab || 'ai', {fresh: true});
      root.querySelector('[data-act="fwd-close"]').focus();
      return true;
    } catch (error) {
      if (request === generation) global.petSay?.(error.message || '暂时无法安排执行，请重试');
      return false;
    }
  }
  async function completed(id, scope = identityEpoch, chatId = '') {
    if (scope !== identityEpoch) return false;
    close();
    const detailClose = global.RequirementsDetail?.close?.();
    if (detailClose === false || (detailClose && typeof detailClose.then === 'function' && !(await detailClose))) return false;
    await global.RequirementsBoard?.refresh?.();
    if (scope !== identityEpoch) return false;
    return global.openTaskConversation?.(id, '', {source: 'requirement', navigation: true, ...(chatId ? {chatId} : {})});
  }
  global.RequirementAssignment = {open, close, eligible, completed,
    scope: () => identityEpoch, inScope: epoch => epoch === identityEpoch};
  global.addEventListener('soduwork-data-scope-changed', () => { identityEpoch++; close(); });
})(window);
