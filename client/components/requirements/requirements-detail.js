/* One requirement: facts and delivery here; conversation uses NativeChat. */
(function (global) {
  'use strict';
  const R = global.Requirements;
  const pendingSchedules = new Map();
  let identityEpoch = 0;
  let loadController = null, loadTiming = null;
  let root = null, task = null, seq = 0, returnFocus = null, busy = false, editing = false, files = [], pendingUploads = [];
  let pendingConfirmation = null, evidenceReturnFocus = null, evidenceRequest = 0, editBaseline = null, saving = false;
  let refreshRequest = 0, refreshFlight = null, editVersion = null, mountedTrace = null, refreshPending = false;
  let approvalState = '';
  function approvalSignature() {
    const context = global.RequirementsBoard?.context?.(), item = task && R.approval(task, context);
    return JSON.stringify([task?.id, item?.id, item?.status, item?.myDecision, task && R.waitingOn(task, context)]);
  }
  const esc = value => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const options = (entries, value) => entries.map(([key, label]) => '<option value="' + esc(key) + '"' +
    (key === value ? ' selected' : '') + '>' + esc(label) + '</option>').join('');
  const sectionIcon = name => global.RequirementFields?.sectionIcon?.(name) || '';
  function errorText(error) {
    return error.status === 409 && /需求已被.*更新/.test(error.message || '') ? '这条需求已被同事更新。请先重新加载，再保存你的修改。' :
      String(error.message || '操作没有完成，请重试').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  }
  function feedback(text) {
    const message = root?.querySelector('[data-rq-error]'); if (message) { message.textContent = text; message.hidden = !text; }
  }
  function bundleName(title) {
    return global.SoduWorkAPI?.artifactZipFilename?.(title) || title + '.zip';
  }
  function bundleFeedback(text) {
    const node = root?.querySelector('[data-rq-bundle-status]');
    if (node) { node.textContent = text; node.hidden = !text; }
  }
  function editValues() {
    const fields = root?.querySelector('#rqEditForm')?.elements;
    if (!fields) return null;
    return {title: fields.title.value.trim(), note: fields.note.value, kind: fields.kind.value,
      priority: fields.priority.value, tags: global.RequirementFields?.readTags(fields.tags) || [],
      assigneeUserId: fields.assigneeUserId?.value || '', acceptanceCriteria: fields.acceptance.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean),
      ...(fields.triageStage ? {triageStage: fields.triageStage.value} : {}),
      ...(fields.visibility ? {visibility: fields.visibility.value} : {}),
      ...(fields.due ? {due: fields.due.value} : {})};
  }
  function editChanges() {
    const values = editing && editValues();
    if (!values) return {};
    // Compare against the edit-session baseline to avoid false changes from nulls, defaults, or display formatting.
    const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) =>
      JSON.stringify(value) !== JSON.stringify(editBaseline?.[key])));
    return R.editPatch(task, changed);
  }
  function hasUnsavedEdits() {
    const values = editing && editValues();
    return Boolean(values && Object.entries(values).some(([key, value]) =>
      JSON.stringify(value) !== JSON.stringify(editBaseline?.[key])));
  }
  function lockExecutedDraft() {
    if (!editing || !task || R.canEdit(task)) return false;
    root?.querySelectorAll('#rqEditForm input,#rqEditForm textarea,#rqEditForm select,[form="rqEditForm"][type="submit"]')
      .forEach(node => { node.disabled = true; });
    const save = root?.querySelector('[form="rqEditForm"][type="submit"]');
    if (save) { save.textContent = '不可编辑'; save.title = task.requirementEditBlockReason || '需求已进入执行'; }
    const eyebrow = root?.querySelector('.rq-detail-eyebrow');
    if (eyebrow) eyebrow.textContent = '编辑已锁定';
    return true;
  }
  function updateHeader() {
    const content = R.content(task), phase = R.stage(task), owner = R.owner(task);
    const label = R.lanes.find(row => row[0] === phase)?.[1] || '';
    const creatorName = String(task.createdByName || '').trim();
    const title = root?.querySelector('#rqDetailTitle'), meta = root?.querySelector('[data-rq-header-meta]');
    if (title) title.textContent = content.title || '需求详情';
    if (meta) {
      const ownerLabel = owner.kind === 'agent' ? '执行智能体' : owner.kind === 'person' ? '负责人' : '待安排';
      meta.textContent = [label, owner.name ? ownerLabel + ' · ' + owner.name : ownerLabel,
        creatorName ? '创建人 · ' + creatorName : ''].filter(Boolean).join('  ·  ');
      meta.hidden = false;
    }
  }
  function resumePendingRefresh() {
    if (!refreshPending || busy || !root || !task) return;
    refreshPending = false; void refresh(task.id);
  }
  function settleConfirmation(discard) {
    const pending = pendingConfirmation;
    if (!pending) return;
    pendingConfirmation = null;
    const dialog = root?.querySelector('[data-rq-confirm]');
    if (dialog) {
      dialog.hidden = true;
      dialog.setAttribute?.('aria-hidden', 'true');
    }
    root?.querySelector('.rq-detail')?.removeAttribute?.('aria-hidden');
    pending.resolve(Boolean(discard));
    if (!discard && pending.returnFocus?.isConnected) pending.returnFocus.focus({preventScroll: true});
  }
  function confirmDiscardEdits() {
    if (!hasUnsavedEdits()) return true;
    if (pendingConfirmation) return pendingConfirmation.promise;
    const dialog = root?.querySelector('[data-rq-confirm]');
    if (!dialog) return false;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    pendingConfirmation = {promise, resolve, returnFocus: document.activeElement};
    dialog.hidden = false;
    dialog.setAttribute?.('aria-hidden', 'false');
    root?.querySelector('.rq-detail')?.setAttribute?.('aria-hidden', 'true');
    dialog.querySelector('[data-rq-confirm-cancel]')?.focus();
    return promise;
  }
  function closeEvidencePanel() {
    const dialog = root?.querySelector('[data-rq-evidence-modal]');
    if (!dialog || dialog.hidden) return;
    evidenceRequest++;
    dialog.hidden = true;
    dialog.setAttribute?.('aria-hidden', 'true');
    root?.querySelector('.rq-detail')?.removeAttribute?.('aria-hidden');
    const previous = evidenceReturnFocus;
    evidenceReturnFocus = null;
    if (previous?.isConnected) previous.focus({preventScroll: true});
  }
  function openEvidencePanel(kind, trigger) {
    const dialog = root?.querySelector('[data-rq-evidence-modal]');
    if (!dialog || !task || task.canViewExecution === false) return;
    const comments = dialog.querySelector('[data-rq-comment-list]');
    const extensions = dialog.querySelector('[data-rq-extension-list]');
    const isComments = kind === 'comments';
    const title = dialog.querySelector('[data-rq-evidence-title]');
    const subtitle = dialog.querySelector('[data-rq-evidence-subtitle]');
    if (title) title.textContent = isComments ? '活动记录' : '插件扩展';
    if (subtitle) subtitle.textContent = isComments ? '操作历史与讨论留言，按时间倒序显示' : '由已安装插件提供的需求专属操作与信息；普通需求无需配置。';
    if (comments) { comments.hidden = !isComments; if (isComments) comments.textContent = '正在加载活动记录…'; }
    if (extensions) { extensions.hidden = isComments; if (!isComments) extensions.textContent = '正在加载插件扩展…'; }
    /* Return focus to the overflow trigger after closing its dialog. */
    const focusTarget = trigger || document.activeElement;
    evidenceReturnFocus = focusTarget?.closest?.('.rq-detail-more')?.querySelector('summary') || focusTarget;
    evidenceRequest++;
    dialog.dataset.panel = isComments ? 'comments' : 'extensions';
    dialog.hidden = false;
    dialog.setAttribute?.('aria-hidden', 'false');
    root?.querySelector('.rq-detail')?.setAttribute?.('aria-hidden', 'true');
    dialog.querySelector('[data-rq-evidence-close]')?.focus();
    if (isComments) void loadComments(); else void loadExtensions();
  }
  function finalizeClose() {
    loadController?.abort(); loadController = null;
    loadTiming?.mark('cancelled'); loadTiming = null;
    global.ForwardSelect?.destroy(root);
    global.RequirementConfirm?.cancel();
    settleConfirmation(false);
    closeEvidencePanel();
    if (task) global.TaskPluginInput?.suspend?.(task.id);
    const journey = root?.querySelector('[data-rq-trace]');
    if (journey) global.TaskExecutionJourney?.unmount(journey);
    mountedTrace = null; refreshPending = false; refreshFlight = null;
    seq++; task = null; busy = false; saving = false; editing = false; editBaseline = null; editVersion = null; files = []; pendingUploads = [];
    if (root) { root.remove(); root = null; }
    const origin = returnFocus?.isConnected ? returnFocus : [...document.querySelectorAll('[data-rq-open]')]
      .find(node => node.dataset.rqOpen === returnFocus?.dataset.rqOpen);
    if (origin?.getClientRects().length) origin.focus({ preventScroll: true });
    returnFocus = null;
    return true;
  }
  function close(force) {
    if (force) return finalizeClose();
    if (saving) return false;
    const decision = confirmDiscardEdits();
    if (decision && typeof decision.then === 'function') return decision.then(ok => ok ? finalizeClose() : false);
    if (!decision) return false;
    return finalizeClose();
  }
  function mount() {
    const node = document.createElement('div'); node.className = 'rq-detail-backdrop';
    node.innerHTML = '<aside class="rq-detail" role="dialog" aria-modal="true" aria-labelledby="rqDetailTitle">' +
      '<header class="rq-detail-header"><div class="rq-detail-header-copy"><p class="rq-detail-eyebrow">需求详情</p>' +
      '<h2 id="rqDetailTitle">需求详情</h2><p class="rq-detail-header-meta" data-rq-header-meta hidden></p></div>' +
      '<button type="button" data-rq-dismiss aria-label="关闭需求详情">×</button></header>' +
      '<div class="rq-detail-content"></div><footer class="rq-detail-footer" hidden></footer></aside>' +
      '<div class="rq-detail-modal-layer rq-evidence-modal" data-rq-evidence-modal hidden role="dialog" aria-modal="true" aria-labelledby="rqEvidenceTitle" aria-describedby="rqEvidenceSubtitle">' +
      '<div class="rq-detail-modal-card"><header class="rq-detail-modal-header"><div><h3 id="rqEvidenceTitle" data-rq-evidence-title>活动记录</h3><p id="rqEvidenceSubtitle" data-rq-evidence-subtitle>操作历史与讨论留言，按时间倒序显示</p></div><button type="button" data-rq-evidence-close aria-label="关闭弹窗">×</button></header>' +
      '<div class="rq-detail-modal-body"><div data-rq-comment-list role="status" aria-live="polite"></div><div data-rq-extension-list hidden role="status" aria-live="polite"></div></div></div></div>' +
      '<div class="rq-detail-modal-layer rq-confirm-modal" data-rq-confirm hidden role="alertdialog" aria-modal="true" aria-labelledby="rqConfirmTitle" aria-describedby="rqConfirmDescription">' +
      '<div class="rq-detail-modal-card rq-confirm-card"><div class="rq-confirm-icon" aria-hidden="true">!</div><div class="rq-confirm-copy"><h3 id="rqConfirmTitle">放弃未保存的修改？</h3><p id="rqConfirmDescription">已保存的需求内容会保留。</p></div><div class="rq-confirm-actions"><button type="button" data-rq-confirm-cancel>继续编辑</button><button type="button" class="rq-primary" data-rq-confirm-discard>放弃修改</button></div></div></div>';
    document.body.appendChild(node);
    global.RequirementFields?.bindTags(node);
    node.addEventListener('click', event => {
      if (busy) return;
      const more = node.querySelector('.rq-detail-more');
      const evidenceTrigger = event.target.closest('[data-rq-comments-open],[data-rq-extensions-open]');
      const evidenceFocus = evidenceTrigger ? more?.querySelector('summary') : null;
      if (more?.open && (!event.target.closest('.rq-detail-more') || event.target.closest('.rq-detail-more-menu button'))) more.open = false;
      const confirmDialog = node.querySelector('[data-rq-confirm]');
      if (event.target.closest('[data-rq-confirm-discard]')) { settleConfirmation(true); return; }
      if (event.target.closest('[data-rq-confirm-cancel]') || event.target === confirmDialog) { settleConfirmation(false); return; }
      const evidenceDialog = node.querySelector('[data-rq-evidence-modal]');
      if (event.target.closest('[data-rq-evidence-close]') || event.target === evidenceDialog) { closeEvidencePanel(); return; }
      if (event.target.closest('[data-rq-comments-open]')) { openEvidencePanel('comments', evidenceFocus); return; }
      if (event.target.closest('[data-rq-activity-retry]')) { void loadComments(); return; }
      if (event.target.closest('[data-rq-extensions-open]')) { openEvidencePanel('extensions', evidenceFocus); return; }
      if (event.target === node || event.target.closest('[data-rq-dismiss]')) { if (!busy) void close(); return; }
      if (event.target.closest('[data-rq-edit]') && task && R.canEdit(task)) { void setEditing(true); return; }
      if (event.target.closest('[data-rq-edit-cancel]')) { void setEditing(false); return; }
      if (event.target.closest('[data-rq-reload]')) { if (task) void open(task.id); return; }
      const maintenance = event.target.closest('[data-rq-archive],[data-rq-delete]');
      if (maintenance && task) {
        const action = maintenance.hasAttribute('data-rq-delete') ? 'delete' : R.stage(task) === 'closed' ? 'restore' : 'archive';
        const permission = R.maintenance(task, action);
        if (!permission.visible || permission.disabled) { feedback(permission.reason || '当前账号没有维护权限'); return; }
        const request = seq, id = task.id; busy = true; feedback('');
        Promise.resolve(global.RequirementsBoard?.maintain(id, action)).then(async changed => {
          if (request !== seq || !changed) return;
          if (action === 'delete') close(true);
          else { busy = false; await open(id); }
        }).catch(error => { if (request === seq) feedback(errorText(error)); })
          .finally(() => { if (request === seq) busy = false; });
        return;
      }
      if (event.target.closest('[data-rq-ready]') && task && R.canTriage(task) &&
          ['intake', 'clarifying'].includes(R.stage(task))) {
        void save({triageStage: 'ready'}); return;
      }
      const submitReview = event.target.closest('[data-rq-submit-review]');
      if (submitReview && task && !busy && R.canSubmitReview(task) && global.SoduWorkAPI?.submitTaskReview) {
        busy = true; submitReview.disabled = true; feedback('');
        const request = seq;
        Promise.resolve(global.SoduWorkAPI.submitTaskReview(task.id, ''))
          .then(async result => {
            if (request !== seq) return;
            await global.RequirementsBoard?.refresh?.();
            await open(task.id);
            if (result?.already) global.petSay?.('这条需求已经在待验收，请直接查看验收卡');
            else global.petSay?.('已提交验收，等待验收人确认');
          })
          .catch(error => { if (request === seq) feedback(errorText(error)); })
          .finally(() => { if (request === seq) { busy = false; if (submitReview.isConnected) submitReview.disabled = false; } });
        return;
      }
      /*
       * Review decisions belong to the inline TaskTraceApproval card. Execution archives are
       * device-local and cannot serve as a cross-device review entry point.
       */
      if (event.target.closest('[data-rq-assign]') && task) {
        void global.RequirementAssignment?.open(task.id); return;
      }
      const chat = event.target.closest('[data-rq-chat]');
      if (chat && task && R.canOpenConversation(task, global.SoduWorkAPI?.clientId) && global.openTaskConversation) {
        const item = task;
        Promise.resolve(close()).then(closed => closed === false ? null : global.openTaskConversation(item.id, R.content(item).title, { source: 'requirement', navigation: true })).catch(error => {
          if (typeof global.petSay === 'function') global.petSay(errorText(error));
        });
      }
      const reworkAction = event.target.closest('[data-rq-rework]');
      if (reworkAction && task && global.openTaskConversation) {
        /*
         * Use one rework entry point: reuse the local conversation when available, otherwise
         * create one with prior delivery, attachment IDs, and feedback.
         */
        if (task.canContinueExecution === true) {
          const item = task;
          Promise.resolve(close()).then(closed => closed === false ? null : global.openTaskConversation(
            item.id, R.content(item).title, {
              source: 'rework', navigation: true, forceNew: false, reworkSession: true,
            })).catch(error => { if (typeof global.petSay === 'function') global.petSay(errorText(error)); });
        }
        return;
      }
      const file = event.target.closest('[data-rq-file]');
      if (file) void openAttachment(file.dataset.rqFile);
      const download = event.target.closest('[data-rq-download]');
      if (download) void downloadAttachment(download.dataset.rqDownload);
      const bundle = event.target.closest('[data-rq-bundle-download],[data-rq-download-bundle]');
      if (bundle) void downloadBundle(bundle);
      const bundleLibrary = event.target.closest('[data-rq-bundle-library]');
      if (bundleLibrary) void downloadBundle(bundleLibrary, true);
      const remove = event.target.closest('[data-rq-remove-file]');
      if (remove) void removeAttachment(remove.dataset.rqRemoveFile);
      if (event.target.closest('[data-rq-artifact]')) global.soduWorkAPI?.openExternal?.(task.artifactUrl);
      if (event.target.closest('[data-rq-add-files]')) root.querySelector('#rqFileInput')?.click();
      if (event.target.closest('[data-rq-retry-files]')) void uploadPending();
      if (event.target.closest('[data-rq-automation]')) void createAutomation();
      const library = event.target.closest('[data-rq-library]');
      if (library && task) {
        const material = files.find(file => task.id + ':' + file.id === library.dataset.rqLibrary);
        if (material) void global.LibraryTransfer?.saveOutput('', libraryFile(material), library);
      }
    });
    node.addEventListener('toggle', event => {
      if (!event.target.matches('[data-rq-execution]')) return;
      const journey = event.target.querySelector('[data-rq-trace]');
      if (!task || task.canViewExecution === false || !journey) return;
      /*
       * Suppress duplicate inline approval actions when the details page already shows the
       * decision card; keep the trace focused on lifecycle and evidence.
       */
      if (event.target.open) {
        if (mountedTrace === journey) return;
        mountedTrace = journey;
        global.TaskExecutionJourney?.mount(journey, {taskId: task.id, compact: true,
          suppressInlineApproval: true, suppressTimeline: true, force: true});
      } else {
        global.TaskExecutionJourney?.unmount(journey);
        if (mountedTrace === journey) mountedTrace = null;
      }
    }, true);
    node.addEventListener('change', event => {
      if (event.target.id !== 'rqFileInput' || !task || !R.canManageMaterials(task)) return;
      pendingUploads.push(...event.target.files); event.target.value = ''; void uploadPending();
    });
    node.addEventListener('submit', event => {
      event.preventDefault(); if (!task) return;
      if (!R.canEdit(task)) { feedback(task.requirementEditBlockReason || '只有尚未执行的需求可以编辑，请重新加载查看最新状态。'); return; }
      const form = event.target;
      if (global.RequirementFields?.validateTags(form) === false) return;
      const fields = form.elements;
      const patch = editValues();
      if (!patch) return;
      if (!patch.title) { feedback('请填写需求标题'); fields.title.focus(); return; }
      const changes = editChanges();
      if (Object.keys(changes).length) void save(changes);
      else global.petSay?.('没有需要保存的修改');
    });
    node.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!busy) {
          const confirmDialog = node.querySelector('[data-rq-confirm]');
          if (confirmDialog && !confirmDialog.hidden) { settleConfirmation(false); return; }
          const evidenceDialog = node.querySelector('[data-rq-evidence-modal]');
          if (evidenceDialog && !evidenceDialog.hidden) { closeEvidencePanel(); return; }
          const more = node.querySelector('.rq-detail-more');
          if (more?.open) { more.open = false; more.querySelector('summary')?.focus(); }
          else if (editing) void setEditing(false); else void close();
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const modal = [node.querySelector('[data-rq-confirm]'), node.querySelector('[data-rq-evidence-modal]')]
        .find(item => item && !item.hidden);
      const focusable = [...(modal || node).querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),summary,[tabindex="0"]')]
        .filter(item => !item.hidden && item.getClientRects().length);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    return node;
  }
  function setEditing(value) {
    if (!root || !task || busy) return;
    const apply = () => {
      editing = value;
      editVersion = editing ? task.requirementVersion : null;
      render(); renderAttachments(files);
      editBaseline = editing ? editValues() : null;
      const form = root.querySelector('#rqEditForm'), request = seq, epoch = identityEpoch;
      if (editing && global.SoduWorkAPI?.listTeammates) void global.SoduWorkAPI.listTeammates().then(directory => {
        if (!editing || request !== seq || epoch !== identityEpoch || root?.querySelector('#rqEditForm') !== form) return;
        const select = root.querySelector('[name="assigneeUserId"]');
        if (!select || !directory || directory.ok === false) return;
        // Preserve the current owner if absent from the directory, and retain selections made while loading.
        const current = String(select.value || '');
        const rows = (directory.mates || []).filter(item => item && (item.id || item.userId || item.uid))
          .map(item => ({ id: String(item.id || item.userId || item.uid), name: String(item.name || item.displayName || item.username || '成员') }))
          .filter((item, index, all) => all.findIndex(row => row.id === item.id) === index);
        if (current && !rows.some(item => item.id === current)) rows.unshift({id: current,
          name: select.selectedOptions?.[0]?.textContent || task.assigneeName || '当前负责人'});
        select.innerHTML = '<option value="">未指派</option>' + rows.map(item => '<option value="' + esc(item.id) + '">' + esc(item.name) + '</option>').join('');
        select.value = current;
      }).catch(() => {});
      root.querySelector(editing ? '#rqEditForm [name="title"]:not([disabled]),#rqEditForm textarea:not([disabled])' : '[data-rq-edit]')?.focus();
      return true;
    };
    if (value) return apply();
    const decision = confirmDiscardEdits();
    if (decision && typeof decision.then === 'function') return decision.then(ok => ok ? apply() : false);
    if (!decision) return false;
    return apply();
  }
  async function open(id) {
    const previousFocus = root ? returnFocus : document.activeElement;
    const closed = close();
    if (closed === false) return false;
    if (closed && typeof closed.then === 'function' && !(await closed)) return false;
    if (typeof detailId !== "undefined") detailId = String(id || "");
    returnFocus = previousFocus;
    const request = ++seq;
    loadController = typeof AbortController === 'function' ? new AbortController() : null;
    const controller = loadController;
    loadTiming = global.SoduWorkPagePerformance?.interaction?.('requirement-detail');
    const timing = loadTiming;
    root = mount();
    const cached = typeof Store !== 'undefined' && ['ready', 'stale'].includes(Store.taskState)
      ? Store.tasks?.find(row => String(row.id) === String(id)) : null;
    // Cached content is read-only. All action controls wait for fresh Hub authority.
    root.querySelector('.rq-detail-content').innerHTML = '<p class="rq-detail-loading" role="status">正在加载需求…</p>' +
      (cached ? '<section class="rq-detail-section"><h3 data-user-content>' + esc(cached.title) +
        '</h3><p data-user-content style="white-space:pre-wrap">' + esc(cached.note || '') + '</p></section>' : '');
    timing?.mark('shell');
    root.querySelector('[data-rq-dismiss]').focus();
    try {
      const value = await global.SoduWorkAPI.getTask(id, { signal: controller?.signal });
      if (request !== seq || !root) return;
      if (!value?.id) throw new Error('需求已移除或当前账号无权访问');
      task = value; render();
      timing?.mark('data');
      root.querySelector('.rq-detail-content').dataset.taskId = id;
      const attachments = await global.SoduWorkAPI.listAttachments(id);
      if (request !== seq || !root || task?.id !== id) return;
      renderAttachments(attachments);
      global.TaskPluginInput?.resume(id);
      timing?.mark('ready');
    } catch (error) {
      if (request !== seq || !root) return;
      timing?.mark('failed');
      if (task) feedback(errorText(error));
      else {
        root.querySelector('.rq-detail-content').innerHTML = '<p class="rq-detail-error" role="alert">' +
          esc(errorText(error)) + '</p><button type="button" id="rqLoadRetry">重新加载</button>';
        root.querySelector('#rqLoadRetry').onclick = () => open(id);
      }
    } finally {
      if (request === seq) { loadController = null; loadTiming = null; }
    }
  }
  function refresh(id) {
    // Background invalidation must retain drafts while still updating execution permissions.
    if (!root || String(task?.id) !== String(id)) return false;
    refreshRequest++;
    if (refreshFlight) { refreshFlight.queued = true; return refreshFlight.promise; }
    const flight = {request: seq, drawer: root, queued: false, promise: null};
    const current = () => flight.request === seq && flight.drawer === root;
    refreshFlight = flight;
    flight.promise = (async () => {
      let applied = false;
      try {
        do {
          flight.queued = false;
          const refreshId = refreshRequest;
          try {
            const latest = await global.SoduWorkAPI.getTask(id);
            if (!current()) return false;
            if (refreshId !== refreshRequest) continue;
            if (!latest?.id) throw new Error('需求已移除或当前账号无权访问');
            if (Number(latest.requirementVersion || 0) < Number(task.requirementVersion || 0)) continue;
            task = latest; applied = true;
            if (editing) {
              updateHeader();
              // Keep the draft visible, but prevent stale forms from changing executed work.
              if (lockExecutedDraft()) {
                feedback(task.requirementEditBlockReason || '需求已开始执行，不能再编辑。未保存内容已保留，取消编辑可查看最新状态。');
              }
              continue;
            }
            if (busy) { refreshPending = true; continue; }
            const content = root.querySelector('.rq-detail-content'), scrollTop = content.scrollTop;
            render(); renderAttachments(files); content.scrollTop = scrollTop;
            const attachments = await global.SoduWorkAPI.listAttachments(id);
            if (current() && refreshId === refreshRequest && !editing && !busy) renderAttachments(attachments);
          } catch (error) {
            if (current() && refreshId === refreshRequest) feedback(errorText(error));
          }
        } while (current() && flight.queued);
        return applied;
      } finally { if (refreshFlight === flight) refreshFlight = null; }
    })();
    return flight.promise;
  }
  function render() {
    global.ForwardSelect?.destroy(root);
    if (task.canViewExecution === false) {
      closeEvidencePanel();
      root?.querySelector('[data-rq-comment-list]')?.replaceChildren();
      root?.querySelector('[data-rq-extension-list]')?.replaceChildren();
    }
    const evidenceOpen = root?.querySelector('[data-rq-execution]')?.open === true;
    const previousTrace = root?.querySelector('[data-rq-trace]');
    const preserveTrace = evidenceOpen && !editing && task.canViewExecution !== false;
    if (previousTrace && !preserveTrace) {
      global.TaskExecutionJourney?.unmount(previousTrace); mountedTrace = null;
    }
    const canEdit = R.canEdit(task), phase = R.stage(task);
    const metadataLocked = task.readOnly === true && task.status !== 'todo';
    const content = R.content(task);
    const priorities = global.TaskPriority?.labels || { normal: '普通' };
    const criteria = task.acceptanceCriteria || [];
    const ctx = global.RequirementsBoard?.context?.(), step = R.nextStep(task, ctx);
    const approvalItem = R.approval(task, ctx);
    approvalState = approvalSignature();
    const created = R.timeInfo({createdAt: task.createdAt, created: task.created}), changed = R.timeInfo(task);
    const timeProperty = info => info.datetime
      ? '<time datetime="' + esc(info.datetime) + '" title="' + esc(info.title) + '">' + esc(info.text) + '</time>'
      : esc(info.text);
    updateHeader();
    root.querySelector('.rq-detail-eyebrow').textContent = editing ? '编辑需求' : '需求详情';
    root.querySelector('.rq-detail').classList.toggle('is-editing', editing);
    const tags = global.RequirementFields?.normalizeTags(task.tags) || [];
    const heading = '<h3 class="rq-detail-title" data-user-content>' + esc(content.title) + '</h3>';
    const overview = '<section class="rq-detail-overview rq-detail-section-card">' +
      '<div class="rq-detail-section-heading"><h3>' + sectionIcon('content') + '需求信息</h3></div>' +
      '<dl class="rq-detail-properties"><div><dt>类型</dt><dd>' + esc(R.kinds[task.kind] || R.kinds.requirement) + '</dd></div>' +
      '<div><dt>优先级</dt><dd>' + esc(priorities[task.priority] || priorities.normal) + '</dd></div>' +
      '<div><dt>截止日期</dt><dd>' + esc(R.day(task.due) || '未设置') + '</dd></div>' +
      '<div><dt>可见范围</dt><dd>' + (task.visibility === 'organization' ? '团队可见' : '仅相关人可见') + '</dd></div>' +
      '<div><dt>创建时间</dt><dd>' + timeProperty(created) + '</dd></div>' +
      '<div><dt>最近更新</dt><dd>' + timeProperty(changed) + '</dd></div></dl>' +
      '<section class="rq-detail-block rq-detail-tag-block"><h4>' + sectionIcon('tags') + '标签</h4><div class="rq-detail-tags" data-rq-detail-tags>' +
      (tags.length ? tags.map(tag => '<span data-user-content>' + esc(tag) + '</span>').join('') : '<p class="rq-field-hint">暂无标签</p>') + '</div></section>' +
      '<section class="rq-detail-block"><h4>' + sectionIcon('content') + '背景与说明</h4><div class="rq-description"' + (content.note ? ' data-user-content' : '') + '>' + esc(R.displayNote(task) || '暂无补充说明') + '</div></section>' +
      '<section class="rq-detail-block"><h4>' + sectionIcon('criteria') + '完成标准</h4>' + (criteria.length ? '<ul class="rq-detail-criteria" data-user-content>' + criteria.map(value => '<li>' + esc(value) + '</li>').join('') + '</ul>' :
        '<p class="rq-field-hint">尚未填写完成标准</p>') + '</section></section>';
    const form = canEdit && editing ? '<form id="rqEditForm" class="rq-detail-editing"><section class="rq-edit-section"><h3>' + sectionIcon('content') + '需求内容</h3>' +
      (metadataLocked ? '<p class="rq-field-hint">需求内容已锁定，标签仍可修改。</p>' : '') +
      '<label>需求标题<input name="title" value="' + esc(content.title) + '" maxlength="200" required' + (metadataLocked ? ' disabled data-rq-locked' : '') + '></label>' +
      '<label>背景与说明<textarea name="note" rows="5"' + (metadataLocked ? ' disabled data-rq-locked' : '') + '>' + esc(content.note) + '</textarea></label>' +
      '<label>完成标准<span class="rq-field-hint">' + (task.status === 'todo' ? '每行一条' : '已进入执行，保留原完成标准') + '</span><textarea name="acceptance" rows="3"' + (task.status !== 'todo' ? ' readonly' : '') + '>' + esc(criteria.join('\n')) + '</textarea></label></section>' +
      '<section class="rq-edit-section"><h3>' + sectionIcon('settings') + '基本信息</h3>' +
      '<div class="rq-field-pair"><label>类型<select name="kind"' + (task.status !== 'todo' ? ' disabled data-rq-locked' : '') + '>' + options(Object.entries(R.kinds), task.kind || 'requirement') + '</select></label>' +
      '<label>优先级<select name="priority"' + (metadataLocked ? ' disabled data-rq-locked' : '') + '>' + options(Object.entries(priorities), task.priority || 'normal') + '</select></label></div>' +
      '<div class="rq-field-pair">' + (task.canViewExecution !== false ? '<label>截止日期<input type="date" name="due" value="' + esc(R.day(task.due)) + '"' + (metadataLocked ? ' disabled data-rq-locked' : '') + '></label>' : '') +
      (!task.readOnly ? '<label>负责人<select name="assigneeUserId" data-search-placeholder="输入部分姓名搜索…"><option value="">未指派</option><option value="' + esc(task.assigneeUserId || '') + '" selected>' + esc(task.assigneeName || (task.assigneeUserId ? '当前负责人' : '未指派')) + '</option></select></label>' : '') + '</div>' +
      '<div class="rq-tag-field"><label for="rqTagsInput">标签</label>' + (global.RequirementFields?.tagHtml(task.tags, {id: 'rqTags', name: 'tags'}) || '') + '</div><div class="rq-field-pair">' +
      ((!task.readOnly || R.roles(task).includes('creator')) ? '<label>可见范围<select name="visibility">' +
        options([['organization', '团队可见'], ['related', '仅相关人可见']], task.visibility || 'related') + '</select></label>' : '') +
      (R.canTriage(task) ? '<label>准备阶段<select name="triageStage">' + options(R.lanes.slice(0, 3), task.triageStage || 'ready') + '</select></label>' : '') +
      '</div></section></form>' : overview;
    const migrated = (task.migratedRequirements || []).map(item => '<details class="rq-source"><summary>' + esc(item.title || '历史需求') +
      '</summary><div class="rq-description" data-user-content>' + esc(item.description) + '</div><ul data-user-content>' +
      (item.acceptanceCriteria || []).map(text => '<li>' + esc(text) + '</li>').join('') + '</ul></details>').join('');
    const canArrange = global.RequirementAssignment?.eligible(task);
    const reworkPending = task.workRouting && task.workRouting.reworkPending || null;
    const archive = R.maintenance(task, phase === 'closed' ? 'restore' : 'archive'), removal = R.maintenance(task, 'delete');
    const locked = permission => permission.disabled ? ' disabled data-rq-locked aria-disabled="true" title="' + esc(permission.reason) + '"' : '';
    const maintenanceReason = [archive, removal].find(item => item.visible && item.disabled)?.reason;
    const more =
      (task.canViewExecution !== false ? '<button type="button" data-rq-comments-open aria-haspopup="dialog">活动记录</button>' +
        '<button type="button" data-rq-extensions-open aria-haspopup="dialog">插件扩展</button>' : '') +
      (R.canSubmitReview(task) ? '<button type="button" data-rq-submit-review>提交验收</button>' : '') +
      (R.canManageAutomation(task) ? '<button type="button" data-rq-automation>' + (task.automationScheduleId ? '查看自动化' :
        pendingSchedules.has(task.id) ? '重试关联自动化' : '设为自动化') + '</button>' : '') +
      (archive.visible ? '<button type="button" data-rq-archive' + locked(archive) + '>' + (phase === 'closed' ? '恢复需求' : '归档需求') + '</button>' : '') +
      (removal.visible ? '<button type="button" class="rq-danger" data-rq-delete' + locked(removal) + '>删除需求</button>' : '') +
      (maintenanceReason ? '<p class="rq-maintenance-reason" role="status">' + esc(maintenanceReason) + '</p>' : '');
    /*
     * Keep review decisions in the details card. Gate conversation links with
     * canOpenConversation and label their local-device scope.
     */
    const actions = editing ? '<div class="rq-edit-actions"><button type="submit" form="rqEditForm" class="rq-primary" data-rq-save aria-live="polite">保存修改</button>' +
      '<button type="button" data-rq-edit-cancel>取消</button><button type="button" data-rq-reload>重新加载</button></div>' : '<div class="rq-detail-actions rq-detail-toolbar">' +
      (R.canTriage(task) && ['intake', 'clarifying'].includes(phase) ? '<button type="button" class="rq-primary" data-rq-ready>移至待开始</button>' : '') +
      (canArrange ? '<button type="button" class="rq-primary" data-rq-assign>安排执行</button>' : '') +
      (R.canOpenConversation(task, global.SoduWorkAPI?.clientId) && !reworkPending ? '<button type="button" data-rq-chat>打开执行会话（仅本机）</button>' : '') +
      (canEdit ? '<button type="button" data-rq-edit>编辑</button>' : '') +
      (more ? '<details class="rq-detail-more"><summary>更多</summary><div class="rq-detail-more-menu">' + more + '</div></details>' : '') + '</div>';
    root.querySelector('.rq-detail-content').innerHTML = '<div class="rq-detail-title-sr">' + heading + '</div>' +
      (!editing && !['closed', 'delivered'].includes(phase) ? '<p class="rq-detail-next"><b>下一步</b><span>' + esc(step.text) + '</span></p>' : '') +
      '<p class="rq-detail-error" data-rq-error role="alert" hidden></p>' + form +
      (editing ? '' : executionHtml(ctx) +
      (migrated ? '<section class="rq-sources"><h4>原需求记录</h4>' + migrated + '</section>' : '') +
      '<section class="rq-detail-materials"><div class="rq-material-head"><h4>' + sectionIcon('materials') + '相关材料</h4>' +
      (R.canManageMaterials(task) ? '<button type="button" data-rq-add-files>添加材料</button><input type="file" id="rqFileInput" multiple hidden>' : '') +
      '</div><div id="rqAttachments" role="status">正在加载材料…</div><p data-rq-upload-status role="status"' + (pendingUploads.length ? '' : ' hidden') + '>' +
      (pendingUploads.length ? pendingUploads.length + ' 个材料未上传，可直接重试。' : '') + '</p>' +
      '<button type="button" data-rq-retry-files' + (pendingUploads.length ? '' : ' hidden') + '>重试上传</button></section>');
    bindApprovalCard(approvalItem, ctx);
    const footer = root.querySelector('.rq-detail-footer');
    if (footer) { footer.innerHTML = actions; footer.hidden = !actions; }
    const assignee = editing && root.querySelector('[name="assigneeUserId"]');
    if (assignee) global.ForwardSelect?.enhance(assignee);
    const evidence = root.querySelector('[data-rq-execution]');
    if (evidenceOpen && !editing && task.canViewExecution !== false && evidence) {
      evidence.open = true;
      let journey = evidence.querySelector('[data-rq-trace]');
      // Keep the mounted evidence tree so nested disclosures and reading position survive.
      if (previousTrace && journey && typeof journey.replaceWith === 'function') {
        journey.replaceWith(previousTrace); journey = previousTrace;
      }
      if (journey) {
        mountedTrace = journey;
        global.TaskExecutionJourney?.mount(journey, {taskId: task.id, compact: true,
          suppressInlineApproval: true, suppressTimeline: true, force: true});
      }
    }
  }
  /*
   * Hub cards load authoritative details and submit through decideApproval. Creator-direct
   * cards share the presentation but use directApi for reviewTask and rejectArtifact.
   */
  function bindApprovalCard(item, ctx) {
    const slot = root?.querySelector('[data-rq-approval-card]');
    if (!slot || !global.TaskTraceApproval) return;
    const request = seq;
    const bindState = (approvals, extra) => global.TaskTraceApproval.bind(slot, {
      trace: { approvals },
      refresh: async () => { if (root?.isConnected && request === seq && task?.id) await open(task.id); },
      opts: { taskId: task.id, taskTitle: R.content(task).title || task.title || '',
        onAcceptanceOpened: () => request === seq ? close() : undefined,
        onAcceptanceClosed: () => request === seq ? close() : undefined,
        onChanged: () => { void global.RequirementsBoard?.refresh?.(); } },
      ...extra,
    });
    if (!item) {
      /* Use the same directItem predicate for rendering and submission. */
      const waitingNames = R.waitingOn ? R.waitingOn(task, ctx) : [];
      const direct = task.status === 'done' && canReviewDirect(task) && !waitingNames.length;
      if (!direct) return;
      bindState([{ id: 'direct:' + task.id, action: 'review', status: 'pending',
        confirmation: { title: '交付验收' } }], {
        directApi: {
          approve: (note) => global.SoduWorkAPI.reviewTask(task.id, note || ''),
          /* Record rejection feedback and default to continued agent rework; optionally return to pending. */
          reject: async (note, reworkAttachmentIds) => {
            const result = await global.SoduWorkAPI.rejectArtifact(task.id, note || '', true, reworkAttachmentIds);
            if (result?.ok === false) throw new Error(result.reason || '退回操作未完成');
            return result || { ok: true };
          }
        },
      });
      return;
    }
    const normalized = { ...item, status: item.status || 'pending' };
    if (normalized.action === 'review' && !canReviewDirect(task)) return;
    bindState([normalized]);
  }
  function canReviewDirect(item) {
    if (item?.canReview === true) return true;
    if (item?.canReview === false) return false;
    return item?.status === 'done' && !item?.reviewedAt &&
      item?.createdBy === global.__teamCap?.meId;
  }
  function executionHtml(ctx) {
    if (task.canViewExecution === false) return '';
    const progress = (task.progress || []).slice().reverse();
    const reviewed = task.reviewedAt;
    const canReview = canReviewDirect(task);
    const routing = task.workRouting || {};
    const artifact = /^https?:\/\//i.test(task.artifactUrl || '') ? task.artifactUrl : '';
    // For project tasks, waiting at merge or release after review is a valid intermediate state.
    // For non-project tasks, the corresponding unresolved state is blocked.
    const closedDone = /^(done|completed|delivered)$/.test(String(task.status || ''));
    const contractKind = String(task.workRouting?.outputContract?.kind || '');
    const hasEngineering = Boolean(task.projectId || task.repoId) || contractKind === 'repository-change';
    const phase = R.stage(task);
    // Execution evidence can arrive before the business-stage projection.
    const hasExecution = task.maintenanceBlocked === true || ['running', 'dispatching', 'done'].includes(task.ai?.state) ||
      ['queued', 'starting', 'running', 'waiting'].includes(routing.conversationTurn?.state);
    const preparing = ['intake', 'clarifying', 'ready'].includes(phase) && !hasExecution && task.ai?.state !== 'failed';
    const deliveryState = reviewed ? (closedDone ? '已验收'
        : hasEngineering ? '已验收 · 待合并' : '已验收 · 办结受阻')
      : phase === 'reviewing' ? '待验收' : phase === 'closed' ? '已归档'
      : preparing ? '尚未开始' : task.status === 'paused' ? '已暂停' : task.ai?.state === 'failed' ? '执行异常' : '处理中';
    const deliveryStateClass = reviewed ? (closedDone ? 'is-reviewed'
        : hasEngineering ? 'is-reviewed' : 'is-reviewed is-stalled')
      : phase === 'reviewing' ? 'is-ready' : preparing || phase === 'closed' ? 'is-idle' : 'is-active';
    // Show persisted rework failures with their feedback and a retry action.
    const reworkPending = task.workRouting && task.workRouting.reworkPending || null;
    const reworkCard = reworkPending ?
      '<div class="rq-rework-pending" role="status"><b>返修待处理</b><p><span data-user-content>' +
      esc(String(reworkPending.feedback || '').slice(0, 200)) + '</span>' +
      (task.canContinueExecution === true && reworkPending.error ? '<small>自动返修未启动：' + esc(String(reworkPending.error).slice(0, 80)) + '</small>' : '') +
      '</p><p class="rq-rework-route">' + (task.canContinueExecution === true
        ? '系统会优先续接原执行会话；原会话不可用时自动新开修正会话，上一轮交付会作为输入保留。'
        : '等待执行人根据返修意见继续修正。') + '</p>' +
      (task.canContinueExecution === true ? '<div class="rq-rework-actions"><button type="button" class="rq-primary" data-rq-rework>继续修正</button></div>' : '') +
      '</div>' : '';
    /*
     * Render exactly one review surface: the creator's Hub card, a creator-direct card when no
     * approval exists, or a waiting notice for every other participant. The executor never gets
     * a review decision card from a stale assignment snapshot.
     */
    const approvalItem = R.approval(task, ctx);
    const normalized = approvalItem ? { ...approvalItem, status: approvalItem.status || 'pending' } : null;
    const waitingNames = R.waitingOn ? R.waitingOn(task, ctx) : [];
    const directItem = task.status === 'done' && canReview && !normalized && !waitingNames.length ? {
      id: 'direct:' + task.id, action: 'review', status: 'pending',
      confirmation: { title: '交付验收' },
    } : null;
    const cardOpts = {
      variant: 'task', blocksExecution: false, taskId: task.id,
      taskTitle: R.content(task).title || task.title || '',
    };
    /*
     * Use server-confirmed mineWaiting ownership to suppress unauthorized cards before
     * rendering; otherwise let the card verify permissions with the server.
     */
    const approvalCard = normalized && !waitingNames.length && global.TaskTraceApproval &&
      (normalized.action !== 'review' || canReview) &&
      !normalized.myDecision
      ? global.TaskTraceApproval.html([normalized], cardOpts, normalized.id)
      : directItem && global.TaskTraceApproval
        ? global.TaskTraceApproval.html([directItem], cardOpts, directItem.id)
        : '';
    const waitingOthers = !approvalCard && !reviewed && task.status === 'done'
      ? (normalized?.myDecision
        ? '<p class="rq-acceptance-waiting">你的验收意见已提交，等待其余验收人确认；证据对相关人可见。</p>'
        : waitingNames.length
        ? '<p class="rq-acceptance-waiting">交付验收进行中，由 ' + esc(waitingNames.join('、')) + ' 确认；证据对相关人可见。</p>'
        : '<p class="rq-acceptance-waiting">交付验收进行中，由需求创建人确认；证据对相关人可见。</p>')
      : '';
    return '<section class="rq-delivery"><div class="rq-delivery-head"><div class="rq-delivery-title"><span class="rq-delivery-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6zM12 8v5m0 3h.01"/></svg></span><div><h4>验收与交付</h4>' +
      '<p>验收决策、交付链接与执行证据</p></div></div><div class="rq-delivery-head-actions">' +
      '<span class="rq-delivery-state ' + deliveryStateClass + '">' + deliveryState + '</span></div></div>' +
      reworkCard +
      (approvalCard ? '<div data-rq-approval-card>' + approvalCard + '</div>' : waitingOthers) +
      (artifact ? '<div class="rq-delivery-actions">' +
        '<button type="button" data-rq-artifact>查看交付链接 <span aria-hidden="true">↗</span></button></div>' : '') +
      '<div class="rq-delivery-sections"><details class="rq-evidence" data-rq-execution><summary><span><b>执行记录与交付证据</b><small>查看执行过程和可验证成果</small></span><i aria-hidden="true"></i></summary><div data-rq-trace></div></details>' +
      (progress.length ? '<details class="rq-evidence rq-history-panel"><summary><span><b>历史进展</b><small>' + progress.length + ' 条记录</small></span><i aria-hidden="true"></i></summary><ol class="rq-history">' +
        progress.map(row => '<li><div data-user-content>' + esc(row.text || row.content || '') + '</div><time>' +
          esc(row.at ? new Date(row.at).toLocaleString() : '') + '</time></li>').join('') + '</ol></details>' : '') + '</div></section>';
  }
  function renderAttachments(value) {
    files = value || [];
    const node = root?.querySelector('#rqAttachments'); if (!node) return;
    // Group the latest delivery batch for review.
    // Keep pending or failed validation files in that batch with explicit status labels.
    // Retain older batches and invalid historical files as collapsed audit evidence.
    // Keep historical outputs separate from the current delivery to avoid ambiguous duplicate filenames.
    // Leave outputs without round metadata ungrouped for compatibility.
    const rework = files.filter(file => String(file.role || '') === 'rework_input');
    const deliveryFiles = files.filter(file => String(file.role || '') !== 'rework_input');
    const roundOf = file => Number(((file || {}).evidenceMeta || {}).round || file?.round) || 0;
    const batchOf = file => String(file?.sourceRef || file?.evidenceMeta?.identifier || file?.evidenceMeta?.conversationId || 'legacy');
    const stampOf = (file, index) => {
      const raw = file?.createdAt || file?.created_at || file?.updatedAt || file?.at || '';
      const parsed = typeof raw === 'number' ? raw : Date.parse(String(raw));
      return Number.isFinite(parsed) ? parsed : index;
    };
    const batchRows = new Map();
    deliveryFiles.filter(file => String(file.role || '') === 'output').forEach((file, index) => {
      const key = batchOf(file), old = batchRows.get(key) || {stamp: -1, index: -1};
      old.stamp = Math.max(old.stamp, stampOf(file, index)); old.index = Math.max(old.index, index); batchRows.set(key, old);
    });
    const latestBatch = [...batchRows.entries()].sort((a, b) => a[1].stamp - b[1].stamp || a[1].index - b[1].index).at(-1)?.[0] || 'legacy';
    const latestRound = deliveryFiles.filter(file => batchOf(file) === latestBatch).reduce((max, file) => Math.max(max, roundOf(file)), 0);
    const hasVersionedBatch = deliveryFiles.some(file => roundOf(file) > 0 || batchOf(file) !== 'legacy');
    const isCurrent = file => batchOf(file) === latestBatch && roundOf(file) === latestRound &&
      String(file.role || '') !== 'input';
    const current = deliveryFiles.filter(file => ['input', 'evidence', 'verification', 'process'].includes(String(file.role || '')) || !hasVersionedBatch || isCurrent(file) ||
      (roundOf(file) === 0 && String(file.role || '') !== 'output'));
    const archived = deliveryFiles.filter(file => !current.includes(file));
    const isBundle = file => {
      const name = String(file?.name || file?.filename || '').toLowerCase();
      return name.endsWith('.zip') && /(完整产出|交付包|deliverable|artifact|bundle)/i.test(name);
    };
    const materialRow = file => {
      const name = file.name || file.filename || '附件';
      const extension = String(name).split('.').pop()?.toUpperCase() || 'FILE';
      const round = roundOf(file), version = String(file.versionId || file.evidenceMeta?.versionId || '').trim();
      const validation = String(file.evidenceMeta?.verification?.state || file.validation?.state || '').toLowerCase();
      const validationLabel = validation === 'failed' ? '校验未通过' : validation && validation !== 'passed' ? '待校验' : '';
      const autoBundle = file.autoBundle === true;
      const bundleIds = autoBundle ? ' data-rq-bundle-ids="' + esc(JSON.stringify(file.attachmentIds || [])) + '"' : '';
      const meta = [autoBundle ? '自动打包' : extension, file.size ? formatBytes(file.size) : '', round > 0 ? 'v' + round : '', version ? version.slice(0, 12) : '', validationLabel].filter(Boolean).join(' · ');
      const open = autoBundle
        ? '<button type="button" class="rq-attachment" data-rq-bundle-download' + bundleIds + '>' + esc(name) + '</button>'
        : '<button type="button" class="rq-attachment" data-rq-file="' + esc(file.id) + '">' + esc(name) + '</button>';
      const download = autoBundle
        ? '<button type="button" class="rq-material-icon rq-material-download" title="下载" aria-label="下载" data-rq-bundle-download' + bundleIds + '>↓</button>'
        : '<button type="button" class="rq-material-icon rq-material-download" title="下载" aria-label="下载" data-rq-download="' + esc(file.id) + '">↓</button>';
      return '<div class="rq-material" role="listitem" data-rq-file-id="' + esc(file.id || '') + '"><div class="rq-material-info"><span class="rq-material-type" aria-hidden="true">' + esc(autoBundle ? 'ZIP' : extension.slice(0, 4)) + '</span><div>' +
        open + (meta ? '<span class="rq-material-meta">' + esc(meta) + '</span>' : '') + '</div></div><div class="rq-material-actions">' +
        download + (global.LibraryTransfer?.button ? (autoBundle
          ? LibraryTransfer.button({deliveryBundle: true, taskId: task.id, attachmentIds: file.attachmentIds, name}, '', 'data-rq-bundle-library')
            .replace('data-rq-bundle-library=', bundleIds + ' data-rq-bundle-library=')
          : LibraryTransfer.button(libraryFile(file), '', 'data-rq-library')) : '') + '</div></div>';
    };
    const section = (className, key, title, items, hint) => items.length
      ? '<details class="rq-material-group ' + className + '" data-rq-material-group="' + esc(key) + '"><summary>' + esc(title) + ' · ' + items.length + ' 份<small>' + esc(hint) + '</small></summary>' + items.map(materialRow).join('') + '</details>'
      : '';
    const input = current.filter(file => String(file.role || '') === 'input');
    const categoryOf = file => String(file.category || file.evidenceMeta?.category || '');
    const isEvidence = file => ['evidence', 'verification', 'process'].includes(String(file.role || '')) ||
      ['evidence', 'internal'].includes(categoryOf(file));
    const evidence = current.filter(file => String(file.role || '') !== 'input' && isEvidence(file));
    const outputs = current.filter(file => String(file.role || '') === 'output' && !isEvidence(file));
    const other = current.filter(file => !['input', 'evidence', 'verification', 'process', 'output'].includes(String(file.role || '')) && !isEvidence(file));
    const storedBundles = outputs.filter(isBundle);
    const deliverables = outputs.filter(file => !isBundle(file));
    // Keep original filenames visible. Reuse a stored transport bundle instead
    // of replacing it with a second archive named after the requirement.
    const finalCount = deliverables.filter(file => categoryOf(file) !== 'supporting').length;
    const autoBundle = !storedBundles.length && finalCount > 2
      ? [{autoBundle: true, id: '', name: bundleName(R.content(task).title || task.title || '交付物'), size: 0, attachmentIds: outputs.map(file => file.id)}]
      : [];
    const archive = archived.length ? '<details class="rq-material-group rq-material-archive"><summary>历史轮次 · ' + archived.length + ' 份<small>历史交付与未通过校验的文件，仅供追溯</small></summary>' + archived.map(materialRow).join('') + '</details>' : '';
    node.innerHTML = section('rq-material-input', 'input', '需求资料', [...input, ...other], '创建需求时提供的原始资料') +
      section('rq-material-evidence', 'evidence', '过程证据', evidence, '截图、验证记录和执行过程材料') +
      section('rq-material-output', 'output', '交付物', [...autoBundle, ...storedBundles, ...deliverables], '仅包含本轮交付文件') +
      (autoBundle.length ? '<p data-rq-bundle-status role="status" aria-live="polite" hidden></p>' : '') + archive +
      (rework.length ? '<details class="rq-material-group rq-material-rework" data-rq-material-group="rework"><summary>返修参考资料 · ' + rework.length + ' 个<small>仅供返修使用，不计入交付产物</small></summary>' +
        rework.map(materialRow).join('') + '</details>' : '') || '<p>暂无材料</p>';
    if (R.canManageMaterials(task)) node.querySelectorAll('.rq-material').forEach((row, i) => {
      const file = files.find(candidate => String(candidate.id) === row.dataset.rqFileId); if (!file) return;
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'rq-material-icon rq-material-remove'; button.title = '删除'; button.setAttribute('aria-label', '删除');
      button.dataset.rqRemoveFile = file.id; button.textContent = '×';
      row.querySelector('.rq-material-actions').append(button);
    });
  }
  function formatBytes(value) {
    const size = Number(value);
    if (!Number.isFinite(size) || size <= 0) return '';
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return Math.round(size / 1024) + ' KB';
    return (size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  }
  async function loadComments() {
    const id = task?.id, request = seq, panelRequest = ++evidenceRequest, node = root?.querySelector('[data-rq-comment-list]');
    if (!id || !node || task.canViewExecution === false) return;
    if (!node.querySelector('.tfd-timeline')) node.textContent = '正在加载活动记录…';
    try {
      // Load independent sources without letting a discussion failure hide task history.
      const [comments, history] = await Promise.allSettled([
        global.SoduWorkAPI.getTaskComments(id), global.SoduWorkAPI.getTaskEvents(id),
      ]);
      if (request !== seq || panelRequest !== evidenceRequest || !node.isConnected) return;
      // The existing event API returns null on failure; it is not an empty history.
      const failed = comments.status === 'rejected' || history.status === 'rejected' || !Array.isArray(history.value);
      const rows = comments.status === 'fulfilled' ? comments.value : [];
      const events = history.status === 'fulfilled' && Array.isArray(history.value) ? history.value : [];
      const expanded = new Set([...node.querySelectorAll('details[data-tfd-open][open]')].map(item => item.dataset.tfdOpen));
      const focusKey = node.contains?.(document.activeElement) ? document.activeElement.closest?.('[data-tfd-open]')?.dataset.tfdOpen : null;
      const scroll = node.parentElement?.scrollTop;
      node.innerHTML = (failed ? '<p role="alert">部分记录未能加载，请重试</p><button type="button" data-rq-activity-retry>重新加载</button>' : '') +
        (failed && !rows.length && !events.length ? '' : global.TaskTraceView.timelineHtml(events, {embedded: true, comments: rows}));
      node.querySelectorAll('details[data-tfd-open]').forEach(item => {
        item.open = expanded.has(item.dataset.tfdOpen);
        if (item.dataset.tfdOpen === focusKey) item.querySelector('summary')?.focus({preventScroll: true});
      });
      if (node.parentElement && scroll !== undefined) node.parentElement.scrollTop = scroll;
    } catch (error) { if (request === seq && panelRequest === evidenceRequest) node.textContent = errorText(error); }
  }
  async function loadExtensions() {
    const item = task, request = seq, panelRequest = ++evidenceRequest, node = root?.querySelector('[data-rq-extension-list]');
    if (!item || !node || item.canViewExecution === false) return;
    if (!global.PluginUIHost) { node.textContent = '暂无可用的需求插件扩展，不影响执行与验收。'; return; }
    node.textContent = '正在加载插件扩展…';
    try {
      // Preserve the public plugin slot; its host is now this requirement drawer.
      const rows = await global.PluginUIHost.contributions('task.detail.tab', {task: item});
      if (request !== seq || panelRequest !== evidenceRequest || !node.isConnected) return;
      node.replaceChildren();
      if (!rows.length) node.textContent = '暂无可用的需求插件扩展，不影响执行与验收。';
      rows.forEach(row => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = row.title;
        button.onclick = () => {
          if (request !== seq || panelRequest !== evidenceRequest || task?.canViewExecution === false || node.hidden) return;
          return global.PluginUIHost.openContribution(row, {task: item}).catch(error => {
            if (request !== seq || panelRequest !== evidenceRequest || node.hidden) return;
            /* Show errors inside the active plugin dialog, which overlays task details. */
            let notice = node.querySelector('[data-rq-extension-error]');
            if (!notice) { notice = document.createElement('p'); notice.dataset.rqExtensionError = ''; notice.setAttribute('role', 'alert'); node.prepend(notice); }
            notice.textContent = '打开插件扩展失败：' + errorText(error);
          });
        };
        node.append(button);
      });
    } catch (error) { if (request === seq && panelRequest === evidenceRequest) node.textContent = errorText(error); }
  }
  async function downloadAttachment(id) {
    const file = files.find(row => String(row.id) === id), request = seq;
    if (!file) return;
    feedback('正在准备下载…');
    try {
      if (!global.soduWorkAPI?.downloadAttachment) throw new Error('当前客户端不支持附件下载');
      const result = await global.soduWorkAPI.downloadAttachment({...file, url: global.SoduWorkAPI.attachmentUrl(file)});
      if (result?.ok === false && !result.cancelled && !result.canceled) throw new Error(result.reason || '下载未完成');
      if (request === seq) feedback(result?.ok ? '文件已保存到所选位置' : '');
    } catch (error) { if (request === seq) feedback(errorText(error)); }
  }
  async function downloadBundle(button, saveToLibrary = false) {
    if (!button || button.disabled) return;
    const request = seq;
    button.disabled = true;
    button.setAttribute?.('aria-busy', 'true');
    feedback('');
    bundleFeedback('正在准备交付文件…');
    try {
      if (!task || typeof global.SoduWorkAPI?.downloadArtifactsZip !== 'function') throw new Error('当前客户端不支持自动压缩包下载');
      const id = task.id, title = R.content(task).title || task.title || '交付物';
      const ids = JSON.parse(button?.dataset?.rqBundleIds || '[]');
      const trace = await global.SoduWorkAPI.taskTrace(id);
      if (request !== seq) return;
      const delivery = trace?.delivery || trace?.card?.delivery;
      const artifact = delivery?.artifact;
      const files = (delivery?.manifest || artifact?.manifest)?.files || [];
      if (artifact && ids.length && (ids.length !== files.length || ids.some(value => !files.some(file => String(file.id || file.attachmentId) === String(value)))))
        throw Error('交付版本已变化，请刷新需求后下载');
      if (!trace) throw Error('交付信息暂时不可用，请刷新后重试');
      if (saveToLibrary) {
        if (!artifact?.id || !global.LibraryTransfer?.saveOutput) throw Error('交付信息暂时不可用，请刷新后重试');
        await global.LibraryTransfer.saveOutput('', { deliveryBundle: true, taskId: id,
          attachmentIds: ids, artifactVersionId: artifact.id, name: bundleName(title) }, button);
        if (request === seq) bundleFeedback('');
      } else {
        const result = await global.SoduWorkAPI.downloadArtifactsZip(id, title, artifact?.id || '');
        if (result?.ok === false && !result.canceled && !result.cancelled) throw Error(result.reason || '下载未完成');
        if (request === seq) bundleFeedback(result?.ok ? '文件已保存到所选位置' : '');
      }
    } catch (error) { if (request === seq) { feedback(errorText(error)); bundleFeedback(errorText(error)); } }
    finally { button.disabled = false; button.setAttribute?.('aria-busy', 'false'); }
  }
  async function removeAttachment(id) {
    if (busy || !task || !R.canManageMaterials(task)) return;
    const taskId = task.id, request = seq; busy = true;
    try {
      const file = files.find(row => String(row.id) === String(id));
      if (!await global.RequirementConfirm?.open({title: '删除这份材料？', name: file?.name || file?.filename || '',
        description: '已有会话和其它材料会保留。', confirmLabel: '删除材料', valid: () => request === seq})) return;
      const latest = await global.SoduWorkAPI.getTask(taskId);
      if (request !== seq) return;
      if (!R.canManageMaterials(latest)) throw new Error('当前账号已无权修改这条需求的材料。');
      await global.SoduWorkAPI.deleteAttachment(id);
      if (request !== seq) return;
      const rows = await global.SoduWorkAPI.listAttachments(taskId);
      if (request === seq) renderAttachments(rows);
    } catch (error) { if (request === seq) feedback(errorText(error)); }
    finally { if (request === seq) { busy = false; resumePendingRefresh(); } }
  }
  function libraryFile(file) {
    return { taskId: task.id, attachmentId: file.id, name: file.name || file.filename,
      size: file.size, at: file.createdAt, sha256: file.sha256 || file.evidenceMeta?.sha256 };
  }
  async function uploadPending() {
    if (busy || !task || !R.canManageMaterials(task) || !pendingUploads.length) return;
    const id = task.id, request = seq, batch = pendingUploads.slice();
    busy = true; feedback('');
    const status = root.querySelector('[data-rq-upload-status]');
    const retry = root.querySelector('[data-rq-retry-files]');
    status.hidden = false; retry.hidden = true;
    root.querySelectorAll('button,input,textarea,select').forEach(node => { node.disabled = true; });
    try {
      let finished = 0;
      for (const file of batch) {
        status.textContent = '正在上传 ' + (++finished) + ' / ' + batch.length + '：' + file.name;
        try {
          const result = await global.SoduWorkAPI.uploadAttachment(id, file, { purpose: 'requirement_input' });
          if (!result || result.ok === false) throw new Error('上传未成功');
          pendingUploads = pendingUploads.filter(item => item !== file);
        } catch (error) { feedback(errorText(error)); }
        if (request !== seq || !root) return;
      }
      const uploaded = await global.SoduWorkAPI.listAttachments(id);
      if (request !== seq || !root) return;
      renderAttachments(uploaded);
      status.textContent = pendingUploads.length ? pendingUploads.length + ' 个材料未上传，可直接重试。' : '材料已保存';
      retry.hidden = !pendingUploads.length;
    } catch (error) { if (request === seq) feedback(errorText(error)); }
    finally {
      if (request === seq && root) {
        busy = false;
        root.querySelectorAll('button,input,textarea,select').forEach(node => { node.disabled = node.hasAttribute('data-rq-locked'); });
        resumePendingRefresh();
      }
    }
  }
  async function linkSchedule(id, schedule, epoch) {
    if (epoch !== identityEpoch) return;
    pendingSchedules.set(id, schedule);
    try {
      const latest = await global.SoduWorkAPI.getTask(id);
      if (epoch !== identityEpoch) return;
      if (latest.automationScheduleId && latest.automationScheduleId !== schedule.id) {
        throw new Error('此需求已关联另一条自动化，请重新加载后查看。');
      }
      await global.SoduWorkAPI.patchTask(id, { automationScheduleId: schedule.id, requirementVersion: latest.requirementVersion });
      if (epoch !== identityEpoch) return;
      pendingSchedules.delete(id);
      await global.RequirementsBoard.refresh();
      if (task?.id === id) await open(id);
    } catch (error) {
      if (epoch !== identityEpoch) return;
      global.petSay?.('自动化已创建，但关联需求未成功。可在需求详情中重试关联。');
      if (task?.id === id) { render(); renderAttachments(files); feedback(errorText(error)); }
    }
  }
  async function createAutomation() {
    if (busy || !task || !R.canManageAutomation(task)) return;
    const id = task.id, epoch = identityEpoch, request = seq;
    busy = true;
    try {
      const item = await global.SoduWorkAPI.getTask(id);
      if (request !== seq || epoch !== identityEpoch) return;
      if (!item?.id || !R.canManageAutomation(item)) throw new Error('当前账号已无法管理这条需求的自动化，请重新加载。');
      if (item.automationScheduleId) {
        const closed = close();
        if (closed === false || (closed && typeof closed.then === 'function' && !(await closed))) return;
        if (typeof global.openSchedulesEntry === 'function') global.openSchedulesEntry({scheduleId: item.automationScheduleId});
        else global.openSchedulePanel?.({scheduleId: item.automationScheduleId});
        return;
      }
      if (pendingSchedules.has(item.id)) { await linkSchedule(item.id, pendingSchedules.get(item.id), epoch); return; }
      if (!global.WorkAutomationSheet) throw new Error('自动化表单暂时不可用，请重新打开窗口');
      const closed = close();
      if (closed === false || (closed && typeof closed.then === 'function' && !(await closed))) return;
      await WorkAutomationSheet.open({ proposal: { ...R.content(item),
        acceptance: [...(item.acceptanceCriteria || [])], repoId: item.repoId || '' },
        onCreated: schedule => { if (schedule?.id) void linkSchedule(item.id, schedule, epoch); } });
    } catch (error) {
      if (epoch === identityEpoch) {
        if (request === seq && root) feedback(errorText(error));
        else global.petSay?.(errorText(error));
      }
    } finally { if (request === seq) { busy = false; resumePendingRefresh(); } }
  }
  async function openAttachment(id) {
    const request = seq;
    feedback('正在打开材料…');
    try {
      const file = files.find(row => String(row.id) === String(id));
      if (!file) throw new Error('材料已更新，请重新加载后再打开');
      if (!global.ConversationAttachments?.openTaskAttachment) throw new Error('当前客户端版本不支持附件预览');
      await ConversationAttachments.openTaskAttachment({ ...file, url: global.SoduWorkAPI.attachmentUrl(file) }, {
        api: global.soduWorkAPI, isCurrent: () => request === seq,
        say: message => { if (request === seq) feedback(message); },
      });
      if (request === seq) feedback('');
    } catch (error) { if (request === seq) feedback(errorText(error)); }
  }
  async function save(patch) {
    if (busy || !task) return;
    if (!R.canEdit(task)) { feedback(task.requirementEditBlockReason || '只有尚未执行的需求可以编辑，请重新加载查看最新状态。'); return; }
    busy = true; saving = true; feedback('');
    const id = task.id, request = seq;
    const saveButton = root.querySelector('[data-rq-save]');
    if (saveButton) saveButton.textContent = '正在保存…';
    root.querySelector('#rqEditForm')?.setAttribute('aria-busy', 'true');
    root.querySelectorAll('button,input,textarea,select').forEach(node => { node.disabled = true; });
    try {
      const version = Number((editing ? editVersion : task.requirementVersion) || 0);
      let result;
      try {
        result = await global.SoduWorkAPI.patchTask(id, { ...patch,
          requirementVersion: editing ? editVersion : task.requirementVersion });
      } catch (error) {
        if (request !== seq || !root) return;
        if (error?.code === 'STALE_TASK_SCOPE' || (Number(error?.status) && ![502, 503, 504].includes(Number(error.status)))) throw error;
        if (saveButton) saveButton.textContent = '正在确认保存结果…';
        let confirmed;
        try { confirmed = await global.SoduWorkAPI.getTask(id); } catch (_) { /* Keep the original request error. */ }
        if (request !== seq || !root) return;
        const matches = confirmed?.id === id && Number(confirmed.requirementVersion || 0) > version &&
          Object.entries(patch).every(([key, value]) => JSON.stringify(key === 'due' ? R.day(confirmed[key]) : confirmed[key]) === JSON.stringify(value));
        if (!matches) throw error;
        result = confirmed;
      }
      if (request !== seq) return;
      // The PATCH response is authoritative. Avoid full-board refresh/reopening
      // an unsaved form, and don't wait for unrelated projects or approvals.
      const saved = result?.id === id ? result : await global.SoduWorkAPI.getTask(id);
      if (request !== seq || !root) return;
      if (!saved?.id) throw new Error('保存响应不完整，请重新加载确认');
      const newerTask = Number(task.requirementVersion || 0) > Number(saved.requirementVersion || 0);
      let canonical = newerTask ? task : global.TaskSync?.mergeSaveReceipt(task, saved) || saved;
      if (typeof Store !== 'undefined') {
        const visible = typeof tasks === 'undefined' ? null : tasks.find(row => String(row.id) === String(id));
        if (Number(visible?.requirementVersion || 0) <= Number(canonical.requirementVersion || 0)) {
          if (Store.acceptTaskSave) canonical = Store.acceptTaskSave(newerTask ? canonical : saved) || canonical;
          else Store.applyServerEvent?.({type: 'task.updated', task: canonical, saveReceipt: true});
        } else canonical = visible;
      }
      // Reads begun before this receipt cannot replace it, including partial projections.
      if (refreshFlight) { refreshRequest++; refreshFlight.queued = true; }
      task = canonical; editing = false; editBaseline = null; editVersion = null;
      render(); renderAttachments(files);
      global.RequirementsBoard?.render?.();
      // The hub can accept the patch yet refuse a status change (delivery truth
      // gate). Surface the rejection instead of claiming success.
      const transition = result && result.statusTransition;
      if (transition && transition.applied === false) {
        const blocker = (transition.blockers || [])[0] || {};
        feedback([blocker.title, blocker.detail].filter(Boolean).join('：') || transition.message || '状态未变更');
      } else if (typeof global.petSay === 'function') {
        global.petSay('需求已保存');
      }
    } catch (error) {
      if (request === seq && root) {
        feedback(errorText(error));
      }
    } finally {
      if (request === seq && root) {
        busy = false; saving = false;
        root.querySelectorAll('button,input,textarea,select').forEach(node => { node.disabled = node.hasAttribute('data-rq-locked'); });
        if (editing && saveButton) saveButton.textContent = '保存修改';
        root.querySelector('#rqEditForm')?.setAttribute('aria-busy', 'false');
        lockExecutedDraft();
        resumePendingRefresh();
      }
    }
  }
  global.RequirementsDetail = { open, close, refresh };
  global.addEventListener('soduwork-approvals-changed', () => {
    if (!root || !task || editing) return;
    const latest = approvalSignature();
    if (latest === approvalState) return;
    approvalState = latest;
    // Inbox and task responses can arrive in either order. Refresh only when
    // this task's approval changes, preserving notes during unrelated updates.
    if (busy) { refreshPending = true; return; }
    void refresh(task.id);
  });
  global.addEventListener('soduwork-requirement-comment', event => {
    const dialog = root?.querySelector('[data-rq-evidence-modal]');
    if (String(event.detail?.taskId) === String(task?.id) && dialog && !dialog.hidden && dialog.dataset.panel === 'comments') void loadComments();
  });
  global.addEventListener('soduwork-locale-change', () => {
    const dialog = root?.querySelector('[data-rq-evidence-modal]');
    if (task && dialog && !dialog.hidden && dialog.dataset.panel === 'comments') void loadComments();
  });
  global.addEventListener('soduwork-data-scope-changed', () => {
    identityEpoch++; pendingSchedules.clear(); close(true);
  });
})(window);
