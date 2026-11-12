(function (global) {
  'use strict';
  // Compatibility contract: taskRef: id, taskTitle: title; ChatChrome.resume(_collaborationTask.title)
  const context = {
    get _openingTask() { return _openingTask; }, set _openingTask(value) { _openingTask = value; },
    get _openingEpoch() { return _openingEpoch; }, set _openingEpoch(value) { _openingEpoch = value; },
    get _busy() { return _busy; }, set _busy(value) { _busy = value; },
    get _isEmptyStalledSnapshot() { return _isEmptyStalledSnapshot; },
    get _rememberConversationSnapshot() { return _rememberConversationSnapshot; },
    get _wd() { return _wd; }, set _wd(value) { _wd = value; },
    get _sessionCaps() { return _sessionCaps; }, set _sessionCaps(value) { _sessionCaps = value; },
    get _sessionInputs() { return _sessionInputs; }, set _sessionInputs(value) { _sessionInputs = value; },
    get _selectCollabTask() { return _selectCollabTask; },
    get _restoreCollaboration() { return _restoreCollaboration; },
    get _off() { return _off; }, set _off(value) { _off = value; },
    get _pullOuts() { return _pullOuts; },
    get OPEN_TIMEOUT_MS() { return OPEN_TIMEOUT_MS; },
    get _lastStatus() { return _lastStatus; }, set _lastStatus(value) { _lastStatus = value; },
    get _maybeProposal() { return _maybeProposal; },
    get _collabStatus() { return _collabStatus; },
    get _collabTerminal() { return _collabTerminal; },
    get _retainFailedConversationDraft() { return _retainFailedConversationDraft; },
    get _draftKeyForCurrentSession() { return _draftKeyForCurrentSession; },
    get _draftOwnerScope() { return _draftOwnerScope; },
    get _pluginResolveBusy() { return _pluginResolveBusy; }, set _pluginResolveBusy(value) { _pluginResolveBusy = value; },
    get _pluginResolveSeq() { return _pluginResolveSeq; }, set _pluginResolveSeq(value) { _pluginResolveSeq = value; },
    get _submitTail() { return _submitTail; }, set _submitTail(value) { _submitTail = value; },
    get _clearConversationDraft() { return _clearConversationDraft; },
    get _startTaskCommand() { return _startTaskCommand; },
    get _openWorkAction() { return _openWorkAction; },
    get _workCards() { return _workCards; },
    get _chatDraftBridge() { return _chatDraftBridge; },
    get _workConversationContext() { return _workConversationContext; },
    get _localQueueSeq() { return _localQueueSeq; }, set _localQueueSeq(value) { _localQueueSeq = value; },
    get _submissionSeq() { return _submissionSeq; }, set _submissionSeq(value) { _submissionSeq = value; },
    get _rememberSubmission() { return _rememberSubmission; },
    get _restoreFailedDraft() { return _restoreFailedDraft; },
    get _ensureHlCss() { return _ensureHlCss; },
    get _ensureCollabView() { return _ensureCollabView; },
    get _conversationDraftText() { return _conversationDraftText; },
    get _skillLoadSeq() { return _skillLoadSeq; }, set _skillLoadSeq(value) { _skillLoadSeq = value; },
    get _updateQueueOrder() { return _updateQueueOrder; },
    get _paintBar() { return _paintBar; },
    get _rememberConversationDraft() { return _rememberConversationDraft; },
    get _withConversationDraftRestore() { return _withConversationDraftRestore; },
    get _openPluginDebug() { return _openPluginDebug; },
    get _mateMention() { return _mateMention; }, set _mateMention(value) { _mateMention = value; },
    get _cancel() { return _cancel; },
    get _stopState() { return _stopState; },
    get _sendState() { return _sendState; },
    get _beginSendState() { return _beginSendState; },
    get _finishSendState() { return _finishSendState; },
    get _mode() { return _mode; }, set _mode(value) { _mode = value; },
    get _cancelQueued() { return _cancelQueued; },
    get _proposalAction() { return _proposalAction; },
    get _sendCore() { return _sendCore; },
    get _loadingOlder() { return _loadingOlder; }, set _loadingOlder(value) { _loadingOlder = value; },
    get _restoreRetryDraft() { return _restoreRetryDraft; },
    get _speech() { return _speech; }, set _speech(value) { _speech = value; },
    get _draftKey() { return _draftKey; }, set _draftKey(value) { _draftKey = value; },
    get _draftScopeEpoch() { return _draftScopeEpoch; }, set _draftScopeEpoch(value) { _draftScopeEpoch = value; },
    get _conversationDrafts() { return _conversationDrafts; },
    get _failedConversationDrafts() { return _failedConversationDrafts; },
    get _submissionDrafts() { return _submissionDrafts; },
    get _draftStorageLoaded() { return _draftStorageLoaded; }, set _draftStorageLoaded(value) { _draftStorageLoaded = value; },
    get _pluginMention() { return _pluginMention; }, set _pluginMention(value) { _pluginMention = value; },
    get _skillPicker() { return _skillPicker; }, set _skillPicker(value) { _skillPicker = value; },
    get _draftStorageKey() { return _draftStorageKey; },
    get _draftStorageTimer() { return _draftStorageTimer; }, set _draftStorageTimer(value) { _draftStorageTimer = value; },
    get _runtimeBusy() { return _runtimeBusy; },
    get _fail() { return _fail; },
    get _activeCollabTaskId() { return _activeCollabTaskId; }, set _activeCollabTaskId(value) { _activeCollabTaskId = value; },
    get _associateDraftLibrarySources() { return _associateDraftLibrarySources; },
    get _api() { return _api; },
    get _bindCollaborationTask() { return _bindCollaborationTask; },
    get _boundFromServer() { return _boundFromServer; }, set _boundFromServer(value) { _boundFromServer = value; },
    get _collabAction() { return _collabAction; },
    get _collabEntries() { return _collabEntries; },
    get _collabEntryStatus() { return _collabEntryStatus; },
    get _collaborationTask() { return _collaborationTask; }, set _collaborationTask(value) { _collaborationTask = value; },
    get _collaborationTaskId() { return _collaborationTaskId; }, set _collaborationTaskId(value) { _collaborationTaskId = value; },
    get _collaborationTrace() { return _collaborationTrace; }, set _collaborationTrace(value) { _collaborationTrace = value; },
    get _collabPicker() { return _collabPicker; }, set _collabPicker(value) { _collabPicker = value; },
    get _collabPollTimer() { return _collabPollTimer; }, set _collabPollTimer(value) { _collabPollTimer = value; },
    get _collabStarts() { return _collabStarts; },
    get _collabState() { return _collabState; },
    get _collabTasks() { return _collabTasks; },
    get _collabView() { return _collabView; }, set _collabView(value) { _collabView = value; },
    get _composerControls() { return _composerControls; }, set _composerControls(value) { _composerControls = value; },
    get _dismissProposal() { return _dismissProposal; },
    get _ensure() { return _ensure; },
    get _retryOpenChat() { return _retryOpenChat; },
    get enter() { return enter; },
    get _goalAction() { return _goalAction; },
    get _goalActionPending() { return _goalActionPending; }, set _goalActionPending(value) { _goalActionPending = value; },
    get _hotToolBodies() { return _hotToolBodies; }, set _hotToolBodies(value) { _hotToolBodies = value; },
    get _lastProposal() { return _lastProposal; }, set _lastProposal(value) { _lastProposal = value; },
    get _loadCollabTask() { return _loadCollabTask; },
    get _localQueue() { return _localQueue; }, set _localQueue(value) { _localQueue = value; },
    get _messageAttachments() { return _messageAttachments; }, set _messageAttachments(value) { _messageAttachments = value; },
    get _messageWindowSize() { return _messageWindowSize; }, set _messageWindowSize(value) { _messageWindowSize = value; },
    get _model() { return _model; }, set _model(value) { _model = value; },
    get _mount() { return _mount; },
    get _answerUi() { return _answerUi; },
    get _openTaskPicker() { return _openTaskPicker; },
    get _openThink() { return _openThink; },
    get _closedThink() { return _closedThink; },
    get _turnMetricsHtml() { return busy => _chatStatus?.metricsHtml(busy) || ""; },
    get _refreshTurnMetrics() { return () => _chatStatus?.refreshThinkingUi(); },
    get _openTool() { return _openTool; },
    get _openToolGroup() { return _openToolGroup; },
    get _outs() { return _outs; }, set _outs(value) { _outs = value; },
    get _outAt() { return _outAt; },
    get _pendingSentAt() { return _pendingSentAt; }, set _pendingSentAt(value) { _pendingSentAt = value; },
    get _pendingBaseline() { return _pendingBaseline; }, set _pendingBaseline(value) { _pendingBaseline = value; },
    get _pending() { return _pending; }, set _pending(value) { _pending = value; },
    get _pendingLibraryIds() { return _pendingLibraryIds; }, set _pendingLibraryIds(value) { _pendingLibraryIds = value; },
    get _pendingAttachmentNames() { return _pendingAttachmentNames; }, set _pendingAttachmentNames(value) { _pendingAttachmentNames = value; },
    get _pendingPlugins() { return _pendingPlugins; }, set _pendingPlugins(value) { _pendingPlugins = value; },
    get _pendingProposal() { return _pendingProposal; }, set _pendingProposal(value) { _pendingProposal = value; },
    get _proposalMuted() { return _proposalMuted; }, set _proposalMuted(value) { _proposalMuted = value; },
    get _queueAction() { return _queueAction; },
    get _queueEdit() { return _queueEdit; }, set _queueEdit(value) { _queueEdit = value; },
    get _queueHistoryOpen() { return _queueHistoryOpen; }, set _queueHistoryOpen(value) { _queueHistoryOpen = value; },
    get _acceptanceHistoryAutoExpanded() { return _acceptanceHistoryAutoExpanded; }, set _acceptanceHistoryAutoExpanded(value) { _acceptanceHistoryAutoExpanded = value; },
    get _ref() { return _ref; }, set _ref(value) { _ref = value; },
    get _removeGoal() { return _removeGoal; },
    get _render() { return _render; },
    get _scheduleRender() { return _scheduleRender; },
    get _renderQueue() { return _renderQueue; },
    get _renderTaskStartPrompt() { return _renderTaskStartPrompt; },
    get _retryDraft() { return _retryDraft; }, set _retryDraft(value) { _retryDraft = value; },
    get _pluginAuthorization() { return _pluginAuthorization; }, set _pluginAuthorization(value) { _pluginAuthorization = value; },
    get _openPluginAuthRecovery() { return _openPluginAuthRecovery; },
    get _send() { return _send; },
    get _sessionId() { return _sessionId; }, set _sessionId(value) { _sessionId = value; },
    get _sessionOpenedAt() { return _sessionOpenedAt; }, set _sessionOpenedAt(value) { _sessionOpenedAt = value; },
    get _sessionOptions() { return _sessionOptions; }, set _sessionOptions(value) { _sessionOptions = value; },
    get _setCollabEntryStatus() { return _setCollabEntryStatus; },
    get _snap() { return _snap; }, set _snap(value) { _snap = value; },
    get _startTask() { return _startTask; },
    get _syncSlowStatusTicker() { return _syncSlowStatusTicker; },
    get _syncThinkingClock() { return _syncThinkingClock; },
    get _taskAttachments() { return _taskAttachments; }, set _taskAttachments(value) { _taskAttachments = value; },
    get _taskOpenError() { return _taskOpenError; }, set _taskOpenError(value) { _taskOpenError = value; },
    get _taskOpenPending() { return _taskOpenPending; }, set _taskOpenPending(value) { _taskOpenPending = value; },
    get _taskOpenSeq() { return _taskOpenSeq; }, set _taskOpenSeq(value) { _taskOpenSeq = value; },
    get _taskSession() { return _taskSession; }, set _taskSession(value) { _taskSession = value; },
    get _taskStartPrompt() { return _taskStartPrompt; }, set _taskStartPrompt(value) { _taskStartPrompt = value; },
    get _thinkingStatusHtml() { return _thinkingStatusHtml; },
    get _viewEpoch() { return _viewEpoch; }, set _viewEpoch(value) { _viewEpoch = value; },
    get _workModel() { return _workModel; },
    get esc() { return esc; },
    get refreshHistory() { return refreshHistory; },
    get reset() { return reset; },
    get sessionInfo() { return sessionInfo; },
  };
  const _readingPosition = global.ChatReadingPosition?.create(context);
  const _workCards = global.ChatWorkCards?.create(context);
  const { _ensureOnce, _ensure, _retryOpenChat, _awaitBounded, _send, _sendCore, _paintOpening } = global.ChatSessionController.create(context);
  const { _bind, _mount, _loadChatSkills, _openPluginBuilder, _toggleChatMic } = global.ChatComposerBindings.create(context);
  const { _collabState, _ensureCollabView, _collabAction, _openTaskPicker, _selectCollabTask, _loadCollabTask, _clearFinishedAcceptanceContext, _loadCollabRun, _scheduleCollabPoll, _taskSnapshotIsStale, _isEmptyStalledSnapshot, _collabTerminal, _collabRunning, _collabStatus, _collabEntryStatus, _collabEntries, _collabQueueMode, _collabProjectId, _setCollabEntryStatus, _nextCollabEntry, _persistTaskBinding, _bindCollaborationTask, _restoreCollaboration, _openTask, _renderTaskStartPrompt, _startTask, _startTaskCommand, enqueueTask } = global.ChatTaskController.create(context);
  const { reset: _resetMessageRenderer, rich, _richPlain, CARET, _ensureHlCss, _inject, _blockHtml, _MCP_SAY, _friendlyTool, _toolHtml, _render, _ctxText, _tokenText, _ctxHtml, _uiHtml } = global.ChatMessageRenderer.create(context);
  const { _queueRows, _renderQueue, _queueAction, _updateQueueOrder, _cancelQueued } = global.ChatSendQueue.create(context);
  const { _chatDraftBridge, _workModel, _workConversationContext, _openPluginDebug, _openWorkAction, _pickProposal, _maybeProposal, _renderProposal, _dismissProposal, _proposalAction } = global.ChatWorkIntent.create(context);
  const { _withConversationDraftRestore, _draftKeyForCurrentSession, _draftOwnerScope, _clearConversationDraftScope, _flushConversationDrafts, _rememberConversationText, _rememberConversationDraft, _conversationDraftText, _conversationDraftSkills, _clearConversationDraft, _restoreConversationDraft, _retainFailedConversationDraft, _restoreRetainedConversationFailure, _restoreRetryDraft, _openPluginAuthRecovery, _restoreFailedDraft } = global.ChatDraftRecovery.create(context);
  let _ref = '';            // Current conversation reference.
  let _sessionId = '';      // Persistent Pi session ID for resuming the same live session.
  let _off = null;          // Event unsubscribe function.
  let _snap = null;         // Latest snapshot.
  let _renderFrame = 0;
  let _loadingOlder = false;
  let _busy = false;        // Session initialization is in progress.
  let _goalActionPending = '';
  let _viewEpoch = 0;         // Invalidate pending open operations when switching conversations.
  let _openingEpoch = -1;
  let _openingTask = null;
  // An archive/runtime open must always reach a terminal UI state.  The
  // underlying SDK is third-party code and may leave a Promise pending when a
  // model adapter or extension stalls; without this guard the opening skeleton
  // remained on screen forever.
  const OPEN_TIMEOUT_MS = 30000;
  let _submitTail = Promise.resolve();
  let _model = null;
  let _composerControls = null;
  let _speech = null;
  let _sessionOptions = {};  // Session capabilities are fixed; model and permission changes apply only to later turns.
  let _pending = '';
  let _pendingSentAt = 0;
  let _pendingBaseline = null;
  let _lastStatus = '';     // Previous frame state used to detect run completion.
  let _stopState = 'idle';  // idle | requested | timeout; scoped to the active turn.
  let _sendState = 'idle';  // idle | sending; scoped to the current submission.
  let _sendStateToken = 0;
  let _stopTimer = null;
  let _stopRequestToken = 0;
  let _stopReceiptAcknowledged = false;
  let _messageAttachments = null;
  let _messageWindowSize = 80;
  let _pluginMention = null;
  let _mateMention = null;
  let _skillPicker = null;
  let _skillLoadSeq = 0;
  let _pendingPlugins = [];
  let _pluginResolveBusy = false;
  let _pluginResolveSeq = 0;
  let _submissionSeq = 0;
  const _submissionDrafts = new Map();
  const _conversationDrafts = new Map();
  const _failedConversationDrafts = new Map();
  /* Keep the last rendered transcript for a short-lived navigation cache.
     Switching between a local handle and a cloud projection should never
     blank the chat while the main process re-attaches the selected handle.
     This is renderer-only state; the native snapshot remains authoritative
     and replaces it as soon as open() completes. */
  const _conversationSnapshots = new Map();
  const MAX_CONVERSATION_SNAPSHOTS = 12;
  function _rememberConversationSnapshot(id, snapshot) {
    const key = String(id || '').trim();
    if (!key || !snapshot || typeof snapshot !== 'object') return;
    _conversationSnapshots.delete(key);
    _conversationSnapshots.set(key, snapshot);
    while (_conversationSnapshots.size > MAX_CONVERSATION_SNAPSHOTS) {
      _conversationSnapshots.delete(_conversationSnapshots.keys().next().value);
    }
  }
  function _cachedConversationSnapshot(id) {
    const key = String(id || '').trim();
    if (!key || !_conversationSnapshots.has(key)) return null;
    const snapshot = _conversationSnapshots.get(key);
    _conversationSnapshots.delete(key);
    _conversationSnapshots.set(key, snapshot);
    return snapshot;
  }
  /* Associate attachments saved before a new native session existed with the
     session once its durable id is available. Failures remain non-blocking. */
  function _associateDraftLibrarySources(itemIds) {
    if (!_sessionId) return;
    const ids = [...new Set([...(itemIds || []), ...(_messageAttachments?.libraryItems?.() || [])])]
      .filter(Boolean);
    if (!ids.length || !global.SoduWorkAPI?.associateLibrarySource) return;
    const source = { sessionId: _sessionId, conversationTitle: (global.ChatChrome?.sessionTitle || '').trim() };
    void Promise.all(ids.map(id =>
      global.SoduWorkAPI.associateLibrarySource(id, source).catch(() => {})));
  }
  let _draftScopeEpoch = 0;
  const _draftStorageKey = 'soduwork.conversation-drafts.v1';
  let _draftStorageLoaded = false;
  let _draftStorageTimer = 0;
  let _draftKey = 'new';
  let _retryDraft = null;
  let _pluginAuthorization = null;
  let _pendingAttachmentNames = [];
  let _pendingLibraryIds = [];
  let _localQueue = [];
  let _localQueueSeq = 0;
  let _taskAttachments = [];
  let _collaborationTask = null;
  let _collaborationTaskId = '';
  const _collabTasks = new Map();
  let _activeCollabTaskId = '';
  let _collabPicker = { open: false, loading: false, tasks: [] };
  let _collabLoadSeq = 0;
  let _collabView = null;
  let _taskSession = null;
  let _taskOpenError = '';
  let _taskOpenPending = false;
  let _taskOpenSeq = 0;
  let _sessionOpenedAt = 0;
  let _boundFromServer = false;
  let _collaborationTrace = null;
  let _collaborationHistoryAnnounced = false;
  let _taskStartPrompt = null;
  const _collabStarts = new Set();
  let _collabPollTimer = null;
  const _openThink = new Set();
  const _closedThink = new Set();
  const _openTool = new Set();
  const _openToolGroup = new Set();
  let _hotToolBodies = new Set();
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const _chatStatus = global.ChatStatus && typeof global.ChatStatus.createThinking === 'function'
    ? global.ChatStatus.createThinking(() => ({
      snap: _snap, pending: _pending, ref: _ref, sessionId: _sessionId,
      pendingSentAt: _pendingSentAt,
      document: global.document, esc, tokenText: _tokenText, workStatus: _workStatus,
    })) : null;
  let _outs = [];
  let _outAt = '';
  let _outRequest = 0, _outRetryTimer = null;
  if (typeof global.addEventListener === 'function') global.addEventListener('soduwork-work-task-change', event => {
    const detail = event.detail || {}, id = String(detail.taskId || '');
    const hasMessageTask = ((_snap || {}).messages || []).some(m => String(m.taskId || '') === id);
    if (!_ref || detail.type !== 'task.updated' || !id || (!_collabTasks.has(id) && !hasMessageTask)) return;
    /*
     * History messages may restore before collaboration bindings. Create an inactive binding
     * rather than dropping events, then fetch current task and approval state.
     */
    const hadBinding = _collabTasks.has(id);
    if (!hadBinding && hasMessageTask && typeof _bindCollaborationTask === 'function') {
      _bindCollaborationTask(id, detail.task?.title || '当前协作需求', { persist: false, activate: false });
    }
    /*
     * Task events often contain current server state. Release temporary acceptance context
     * immediately on approval/rejection before users can send another acceptanceOnly message;
     * _loadCollabTask revalidates with the full trace.
     */
    if (typeof _clearFinishedAcceptanceContext === 'function' && detail.task) {
      _clearFinishedAcceptanceContext(id, detail.task, null);
    }
    /*
     * Acceptance, rejection, or confirmation elsewhere changes the same requirement. Refresh
     * task/approval snapshots so stale pending cards disappear; keep output-index refresh on
     * its existing throttled path.
     */
    if (hadBinding && _collabTasks.has(id) && typeof _loadCollabTask === 'function') {
      void Promise.resolve(_loadCollabTask(id)).catch(() => {});
    }
    const ref = _ref, epoch = _viewEpoch;
    clearTimeout(_outRetryTimer);
    _outRetryTimer = setTimeout(() => {
      if (ref === _ref && epoch === _viewEpoch) void _pullOuts();
    }, 150);
  });
  async function _pullOuts(retry = 0) {
    const api = _api(), ref = _ref, epoch = _viewEpoch, request = ++_outRequest;
    if (!ref || !api || !api.outputs) return;
    clearTimeout(_outRetryTimer); _outRetryTimer = null;
    let shouldRetry = false;
    const latestUser = (_snap?.messages || []).findLastIndex(message => message?.role === 'user');
    const currentTurnTools = (_snap?.tools || []).some(tool => {
      if (!tool || tool.state !== 'done' || Number(tool.after || 0) < latestUser) return false;
      const name = String(tool.name || '').toLowerCase();
      return /write|create|edit|patch|save|download|export|generate|image|document|file|bash|shell|command|exec/.test(name);
    });
    // A settled event can arrive immediately after the producer closes its
    // file handle.  Ordinary local sessions have no task id, so the old retry
    // gate skipped them and an initially empty scan permanently hid the card
    // and automatic preview.  Limit this to turns with a file-producing tool
    // or a file journal, then retry only twice within the same render scope.
    const localOutputMayBeLate = Boolean(_snap?.fileChanges || _snap?.execution?.fileChanges || currentTurnTools);
    try {
      const taskIds = [..._collabTasks.keys(), ...((_snap || {}).messages || []).map(m => m.taskId).filter(Boolean)];
      // Remote attachments can arrive after the task's completion event.
      // A successful local scan is already complete; do not sweep the same
      // workspace twice more whenever a conversation is opened or settles.
      shouldRetry = taskIds.length > 0 || Boolean(_snap?.cloudHandoff?.taskId ||
        _snap?.snapshot?.cloudHandoff?.taskId || _snap?.execution?.cloud) ||
        localOutputMayBeLate;
      let files = global.ChatOutputLinks
        ? await ChatOutputLinks.load(api, ref, taskIds, _outs, global.SoduWorkAPI)
        : await api.outputs(ref).then(r => {
          if (!r || r.ok === false) throw Error('成果索引暂时不可用');
          const payload = r && typeof r === 'object' ? r : {};
          return Array.isArray(payload.artifacts) && payload.artifacts.length ? payload.artifacts :
            Array.isArray(payload.deliverables) && payload.deliverables.length ? payload.deliverables :
              Array.isArray(payload.files) ? payload.files : [];
        });
      // A local turn can create a file without adding a delivery artifact.
      // Keep it in the trusted index so its filename opens CodeMirror instead
      // of being interpreted as a web hostname.
      const changeSet = _snap?.fileChanges || _snap?.execution?.fileChanges;
      if (global.ChatOutputLinks?.mergeFileChanges) {
        files = ChatOutputLinks.mergeFileChanges(files, changeSet);
      }
      // Before the Runner's attachments are copied into the private result
      // directory, keep cloud task files out of the native attachment opener.
      // They become ordinary local artifacts on the next settled refresh.
      const cloudTaskId = String(_snap?.cloudHandoff?.taskId ||
        _snap?.snapshot?.cloudHandoff?.taskId ||
        (_snap?.execution?.cloud ? _snap.execution.taskId : '') || '');
      if (cloudTaskId) files = files.map(file => file.taskId === cloudTaskId && !file.remoteMaterialized
        ? { ...file, cloudPending: true } : file);
      if (request !== _outRequest || ref !== _ref || epoch !== _viewEpoch) return;
      const key = JSON.stringify(files);
      if (key !== _outAt) { _outAt = key; _outs = files.slice(); _render(); }
    } catch (_) { shouldRetry = true; /* Keep the last trusted index during a transient failure. */ }
    finally {
      if (shouldRetry && retry < 2 && request === _outRequest && ref === _ref && epoch === _viewEpoch)
        _outRetryTimer = setTimeout(() => {
          if (ref === _ref && epoch === _viewEpoch) void _pullOuts(retry + 1);
        }, retry ? 1800 : 500);
    }
  }
  let _wd = { dir: '', name: '准备工作区' };
  let _mode = 'full';
  let _sessionCaps = [];
  let _sessionInputs = [];
  function _paintBar() {
    const remote = _snap?.cloudHandoff?.phase === 'committed';
    const workspace = remote ? { ..._wd,
      name: _snap.cloudHandoff.target?.runnerKind === 'work-computer' ? '电脑成果' : '云端成果' } : _wd;
    const wd = document.getElementById('nchatWdName');
    if (wd) wd.textContent = workspace.name || '选个文件夹';
    const el = document.getElementById('nchatWd');
    if (el) {
      el.title = _wd.dir || (remote ? workspace.name : '还没选文件夹');
      el.setAttribute('aria-label', workspace.name || '工作位置');
    }
    const md = document.getElementById('nchatModeName');
    if (md) md.textContent = (_snap?.nextAccessPolicy || _snap?.accessPolicy) ? WorkComposer.permissionLabel((_snap.nextAccessPolicy || _snap.accessPolicy).mode) : (_mode === 'readonly' ? '只读' : '兼容权限');
    const ability = document.getElementById('nchatAbilityName');
    if (ability) {
      ability.textContent = _sessionCaps.length ? (_sessionCaps.length + ' 项能力') : '基础对话';
    }
    if (global.ChatChrome) ChatChrome.setWorkspace(workspace);
    if (_composerControls) _composerControls.render();
  }
  function _thinkingStatusHtml(busy) {
    return _chatStatus ? _chatStatus.statusHtml(busy) : '';
  }
  function _stopThinkingClock() {
    if (_chatStatus) _chatStatus.stopThinkingClock();
  }
  function _syncThinkingClock(active) {
    if (_chatStatus) _chatStatus.syncThinkingClock(active);
  }
  function _stopSlowStatusTicker() {
    if (_chatStatus) _chatStatus.stopSlowStatusTicker();
  }
  function _syncSlowStatusTicker(active) {
    if (_chatStatus) _chatStatus.syncSlowStatusTicker(active);
  }
  function _workStatus() {
    const status = global.ChatStatus;
    if (status && typeof status.work === 'function') return status.work(_snap, _pending, _ref);
    if (_pending) return '正在发送…';
    return _runtimeBusy() ? '正在处理…' : '正在想…';
  }
  function _runtimeBusy() {
    const execution = (_snap && _snap.execution) || {};
    const quality = execution.quality || {};
    const queue = execution.turnQueue || {};
    const queued = Boolean(execution.queue?.length || _snap?.queue?.length || Number(execution.queued) > 0);
    // A confirmed failed turn can leave an automatic pause without any work.
    // Preserve that pause; only a fresh submission may release it in the runtime.
    const settledFailure = execution.recoveryRequired === false && queue.failure &&
      ['idle', 'unreachable', 'no-output', 'incomplete', 'aborted', 'quota'].includes(_snap?.status) &&
      !queued && !queue.activeQueueId && !queue.activeTaskId;
    return Boolean((_snap && ['streaming', 'queued'].includes(_snap.status)) ||
      execution.running || queue.activeQueueId || queue.activeTaskId || queued ||
      execution.recoveryRequired || queue.paused && !settledFailure || _pending ||
      ['executing', 'implementing', 'reviewing', 'repairing'].includes(quality.phase));
  }
  let _queueEdit = null;
  let _queueHistoryOpen = false;
  let _acceptanceHistoryAutoExpanded = false;
  let _lastProposal = '';
  let _pendingProposal = null;
  let _proposalMuted = false;
  const _api = () => global.soduWorkAPI &&
    (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession) || null;
  function _rememberSubmission(id, draft) {
    if (!id || !draft) return;
    _submissionDrafts.set(id, draft);
    while (_submissionDrafts.size > 8) {
      const oldest = _submissionDrafts.keys().next().value;
      _submissionDrafts.delete(oldest);
    }
  }
  function _cancelScheduledRender() {
    if (!_renderFrame) return;
    if (typeof global.cancelAnimationFrame === 'function' &&
        typeof global.requestAnimationFrame === 'function') {
      global.cancelAnimationFrame(_renderFrame);
    } else {
      clearTimeout(_renderFrame);
    }
    _renderFrame = 0;
  }
  function _scheduleRender() {
    if (_renderFrame) return;
    const paint = () => {
      _renderFrame = 0;
      _reconcileStopState();
      if (_ref || _snap) _render();
    };
    if (typeof global.requestAnimationFrame === 'function') {
      _renderFrame = global.requestAnimationFrame(paint);
    } else {
      _renderFrame = setTimeout(paint, 16);
    }
  }
  function _stopRoot() {
    if (!global.document) return null;
    return global.document.querySelector('#cpChat .nbox') ||
      global.document.querySelector('.nchat .nbox');
  }
  function _clearStopTimer() {
    if (_stopTimer) { clearTimeout(_stopTimer); _stopTimer = null; }
  }
  function _stopCapable() {
    const execution = _snap?.execution || {}, phase = execution.quality?.phase || '';
    return _snap?.status === 'streaming' || execution.running === true ||
      ['executing', 'implementing', 'reviewing', 'repairing'].includes(phase);
  }
  function _paintActionState() {
    const root = _stopRoot();
    if (!root) return;
    // The submission IPC can stay pending for the whole model turn. Once the
    // runtime reports that the turn is actually stoppable, expose the normal
    // stop action instead of keeping the primary button disabled as "sending".
    if (_sendState === 'sending' && _stopCapable()) _sendState = 'idle';
    root.dataset.stopState = _stopState;
    root.dataset.sendState = _sendState;
    if (global.ChatTools && typeof ChatTools.paintSendButton === 'function') {
      ChatTools.paintSendButton(root, _runtimeBusy(), _messageAttachments, _stopState, _stopCapable(), _sendState);
    }
  }
  function _paintStopState() { _paintActionState(); }
  function _beginSendState() {
    const token = ++_sendStateToken;
    if (_stopState === 'timeout') {
      _stopState = 'idle';
      _stopReceiptAcknowledged = false;
    }
    _sendState = 'sending';
    _paintActionState();
    return token;
  }
  function _finishSendState(token) {
    if (token == null || token !== _sendStateToken) return;
    _sendState = 'idle';
    _paintActionState();
  }
  function _setStopState(value) {
    _stopState = ['requested', 'timeout'].includes(value) ? value : 'idle';
    if (_stopState !== 'requested') _stopReceiptAcknowledged = false;
    _paintStopState();
  }
  function _reconcileStopState() {
    if (_stopState !== 'requested' || !_stopReceiptAcknowledged || _runtimeBusy()) return;
    _clearStopTimer();
    _stopState = 'idle';
    _stopReceiptAcknowledged = false;
    _paintStopState();
  }
  function _fail(text, detail, retryDraft, failure) {
    const quota = global.SoduWorkQuota?.detail(failure || detail);
    if (quota) global.SoduWorkQuotaNotice?.show(quota);
    _taskOpenPending = false;
    const keep = (_snap && _snap.messages) || [];
    const tools = (_snap && _snap.tools) || [];
    if (!keep.some((message) => message.role === 'user') && global.ChatChrome) ChatChrome.cancelPending();
    const draft = retryDraft || (_pending ? {
      text: _pending, files: [], plugins: (_pendingPlugins || []).slice(),
    } : null);
    _pending = '';
    _pendingPlugins = [];
    _pendingAttachmentNames = [];
    _retryDraft = draft;
    _pluginAuthorization = failure && failure.pluginAuthorization ? failure.pluginAuthorization : null;
    _snap = { ...(_snap || {}), status: quota ? 'quota' : 'unreachable',
              statusText: quota ? '' : text + (detail ? '（' + detail + '）' : ''),
              code: quota?.code || '', quota: quota?.quota || null,
              messages: keep, tools, usage: (_snap && _snap.usage) || null, pendingUi: null };
    _render();
    _restoreFailedDraft(draft);
  }
  async function refreshHistory() {
    if (global.WorkspaceShell &&
        typeof WorkspaceShell.refreshConversationHistory === 'function') {
      try { await WorkspaceShell.refreshConversationHistory(); } catch (e) {}
      return;
    }
    const api = _api();
    if (!api || typeof api.history !== 'function') return;
    try {
      const got = await api.history();
      if (got && got.ok && global.WorkspaceShell && typeof WorkspaceShell.setChats === 'function') {
        WorkspaceShell.setChats(got.chats || []);
      }
    } catch (e) { /* An empty sidebar must not block the conversation. */ }
  }
  function _cancel() {
    const api = _api();
    if (!api || !_ref || _stopState === 'requested') return;
    const ref = _ref;
    const token = ++_stopRequestToken;
    _clearStopTimer();
    _setStopState('requested');
    _stopTimer = setTimeout(() => {
      if (token === _stopRequestToken && _stopState === 'requested') {
        _stopTimer = null;
        _setStopState('timeout');
      }
    }, 8000);
    let result;
    try { result = api.cancel(ref); } catch (_) {
      if (token === _stopRequestToken) _setStopState('timeout');
      return;
    }
    Promise.resolve(result).then(receipt => {
      if (token !== _stopRequestToken || !receipt) return;
      if (receipt.ok === false ||
          (receipt.accepted === false && receipt.stopping !== true)) {
        _clearStopTimer();
        _setStopState('timeout');
        return;
      }
      // Apply the authoritative post-request snapshot before repainting. A
      // stale streaming frame must not make the stop button look clickable
      // while a controlled turn is still winding down.
      if (receipt.snapshot && typeof receipt.snapshot === 'object') {
        _snap = receipt.snapshot;
        _lastStatus = _snap.status || _lastStatus;
      }
      const acknowledged = receipt.stopped === true ||
        ['stopped', 'cancelled', 'canceled', 'aborted'].includes(String(receipt.state || '').toLowerCase());
      if (acknowledged) _stopReceiptAcknowledged = true;
      if (acknowledged && !_runtimeBusy()) {
        _clearStopTimer();
        _setStopState('idle');
      } else {
        _scheduleRender();
      }
    }).catch(() => {
      if (token !== _stopRequestToken) return;
      _clearStopTimer();
      _setStopState('timeout');
    });
  }
  async function _answerUi(method, value, button) {
    const api = _api();
    if (!api || !_ref) return;
    const answerRef = _ref, answerEpoch = _viewEpoch;
    if (method === 'permission' && button?.closest('.access-request')?.dataset.permissionRef !== answerRef) return;
    const res = method === 'permission' ? { requestId: button.dataset.permissionRequest,
      policyRevision: Number(button.dataset.permissionRevision), decision: value } : method === 'confirm' ? { confirmed: value === 'yes' }
      : method === 'select' ? { value }
      : { cancelled: true };
    if (button) button.disabled = true;
    try {
      const result = method === 'permission' && global.AccessControls ? await AccessControls.answer(button, api, answerRef) : await api.answerUi(answerRef, res);
      if (answerEpoch !== _viewEpoch || answerRef !== _ref) return;
      if (value === 'full' && result?.snapshot) { _snap = result.snapshot; _scheduleRender(); }
      if (result?.ok === false && !result.cancelled && !result.canceled && typeof petSay === 'function') petSay(result.reason || '权限确认失败，请重试');
    } catch (error) {
      if (answerEpoch === _viewEpoch && answerRef === _ref && typeof petSay === 'function') petSay('权限确认失败，请重试');
    } finally { if (method !== 'permission' && button?.isConnected) button.disabled = false; }
  }
  async function _goalAction(action) {
    if (_goalActionPending) return false;
    const api = _api();
    if (!api || !_ref || typeof api.goalAction !== 'function') return false;
    const actionRef = _ref;
    const actionEpoch = _viewEpoch;
    const pendingToken = String(action || 'pending') + ':' + String(Date.now());
    _goalActionPending = pendingToken;
    _render();
    try {
      const result = await api.goalAction(actionRef, action);
      if (actionEpoch !== _viewEpoch || actionRef !== _ref) return false;
      if (!result || !result.ok) {
        if (typeof petSay === 'function') petSay((result && result.reason) || '这个操作暂时没有完成');
        return false;
      }
      if (result.snapshot) _snap = result.snapshot;
      if (action === 'disable') {
        _sessionOptions = { ..._sessionOptions, intent: '', mode: 'chat', goal: '', acceptance: '' };
      }
      return true;
    } catch (error) {
      if (actionEpoch === _viewEpoch && actionRef === _ref && typeof petSay === 'function') {
        petSay('操作没有完成，请稍后再试');
      }
      return false;
    } finally {
      if (_goalActionPending === pendingToken) {
        _goalActionPending = '';
        if (actionEpoch === _viewEpoch && actionRef === _ref) _render();
      }
    }
  }
  async function _removeGoal() {
    if (!(await _goalAction('disable'))) return;
    _sessionOptions = { ..._sessionOptions, intent: '', mode: 'chat', goal: '', acceptance: '' };
    if (_snap && _snap.execution) {
      _snap = { ..._snap, execution: { ..._snap.execution, visible: false, active: false,
        quality: { ...(_snap.execution.quality || {}), required: false } } };
    }
    _render();
    const input = document.getElementById('nchatInput');
    if (input) input.focus();
  }
  async function enter(first, chatId, options) {
    _rememberConversationDraft();
    if (!first && !chatId && !_ref && _sessionId) chatId = _sessionId;
    const launchOptions = { ...(options || {}) };
    // Repaint the last known transcript while the native handle is reattached.
    // Local and cloud handles are both re-attachable, so the loading skeleton
    // should only be used when this conversation has never been rendered here.
    // Keep this guard for isolated navigation fixtures that evaluate only the
    // enter() slice; production always provides the renderer LRU above.
    const cachedSnapshot = chatId && typeof _cachedConversationSnapshot === 'function'
      ? _cachedConversationSnapshot(chatId) : null;
    const initialPlugins = Array.isArray(launchOptions.initialPlugins)
      ? launchOptions.initialPlugins.slice() : [];
    const initialSkills = Array.isArray(launchOptions.skills) ? launchOptions.skills.slice() : [];
    const initialInputPreparation = launchOptions.inputPreparation && typeof launchOptions.inputPreparation === 'object'
      ? { ...launchOptions.inputPreparation } : null;
    delete launchOptions.skills; // A picker selection belongs to the first turn, not the session defaults.
    delete launchOptions.initialPlugins;
    delete launchOptions.inputPreparation;
    if (initialInputPreparation) launchOptions.inputPreparation = initialInputPreparation;
    const libraryItemIds = Array.isArray(launchOptions.libraryItemIds)
      ? launchOptions.libraryItemIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()) : [];
    delete launchOptions.libraryItemIds;
    const inputFiles = Array.isArray(launchOptions.inputFiles) ? launchOptions.inputFiles : [];
    const previewInput = launchOptions.previewInput;
    const inputTitle = launchOptions.inputTitle;
    delete launchOptions.inputFiles; delete launchOptions.previewInput; delete launchOptions.inputTitle;
    const activeDraftKey = _ref || _sessionId
      ? String(_sessionId || _draftKey || _ref).trim()
      : '';
    const nextDraftKey = inputFiles.length ? 'file-input' : String(chatId || launchOptions.sessionId || launchOptions.conversationId ||
      activeDraftKey || 'new').trim() || 'new';
    if (chatId && (_ref || _sessionId || _busy) && (String(chatId) !== _sessionId || _busy)) reset();
    else if (chatId && String(chatId) !== _sessionId) {
      // New navigation invalidates earlier asynchronous history restoration, even from an empty page.
      _viewEpoch += 1;
      global.ComposeDraft?.clear();
    }
    _draftKey = nextDraftKey;
    // Navigation must preserve both a live handle and a work-only archive's
    // pending execution choices. Another archive has been reset above.
    const retainedWorkDraft = chatId && String(chatId) === _sessionId && _snap?.workOnly === true;
    if (!_ref && !retainedWorkDraft) {
      _sessionOptions = launchOptions;
      _pendingLibraryIds = chatId ? [] : libraryItemIds;
      _wd = { dir: _sessionOptions.cwd || '', name: _sessionOptions.workspaceLabel || '临时工作区' };
      _mode = _sessionOptions.mode || 'full';
      _sessionCaps = _sessionOptions.capabilities || [];
      _sessionInputs = _sessionOptions.attachments || [];
    }
    _pendingAttachmentNames = _sessionInputs.map((item) => item && (item.name || item.filename)).filter(Boolean);
    if (first) _clearConversationDraft(_draftKey);
    _mount();
    if (!first) _restoreConversationDraft(_draftKey);
    if (inputFiles.length) _messageAttachments?.addReferences(inputFiles);
    if (global.WorkIntent) WorkIntent.showGoal(_mount(), _sessionOptions, 'nchat');
    _mount();
    if (cachedSnapshot) {
      _snap = cachedSnapshot;
      if (launchOptions.chatTitle && global.ChatChrome) ChatChrome.resume(launchOptions.chatTitle);
      _render();
    } else if (_snap) _render();                 // Render restored messages immediately instead of flashing an empty conversation.
    else if (chatId) _paintOpening();
    const focusLater = () => setTimeout(() => {
      const i = document.getElementById('nchatInput');
      if (i) i.focus();
    }, 40);
    if (first) {
      // The first turn is sent after the new runtime is opened. Carry the
      // compose-stage attachment references into that send explicitly; the
      // chat composer has a different attachment controller and is empty on
      // first mount, so relying on it drops files when switching to a Runner
      // runtime (Qwen/DeepSeek/Codex) before sending.
      const accepted = await _send(first, {
        plugins: initialPlugins,
        skills: initialSkills,
        attachments: Array.isArray(_sessionOptions.attachments) ? _sessionOptions.attachments : [],
      });
      focusLater();
      return accepted;
    }
    const cardEpoch = _viewEpoch;
    let workCards;
    try { workCards = chatId && typeof _workCards !== 'undefined' ? await _workCards?.restore(chatId) : null; }
    catch (error) { workCards = {blocked: true, reason: String(error?.message || error || '')}; }
    if (cardEpoch !== _viewEpoch || workCards?.stale) return false;
    if (workCards?.blocked) {
      // A denied archive is a terminal navigation failure, never a blank new
      // conversation. Do not retain its cached transcript or allow draft send.
      if (typeof _conversationSnapshots !== 'undefined') _conversationSnapshots.delete(String(chatId));
      const failedDraftKey = _draftKey;
      const failedSessionId = String(chatId || _sessionId || '').trim();
      const failedSessionOptions = { ..._sessionOptions };
      reset();
      _draftKey = failedDraftKey;
      // Keep the historical identity and its launch options attached to the
      // error state.  reset() normally clears them because navigation to a
      // different chat must start clean, but the retry action needs the same
      // archive id to reopen it instead of creating a new conversation.
      _sessionId = failedSessionId;
      _sessionOptions = failedSessionOptions;
      _mount(); _restoreConversationDraft(_draftKey);
      _snap = {openBlocked: true, sessionOpenCode: 'WORK_CARDS_BLOCKED', sessionNotFound: _snap?.sessionNotFound === true, messages: [], tools: []};
      _taskOpenError = workCards.reason || '工作卡片暂时无法读取，请重新打开这条会话';
      _fail('打不开对话', _taskOpenError);
      return false;
    }
    if (!workCards?.workOnly && !(await _ensure(chatId))) return false;
    if (cardEpoch !== _viewEpoch) return false;
    if (workCards && !workCards.workOnly) await _workCards?.restoreActive?.();
    if (cardEpoch !== _viewEpoch) return false;
    // Restoring a form deliberately skips Agent startup, but its pending
    // requirements still belong to this conversation and must reappear.
    if (workCards?.workOnly && typeof _restoreCollaboration === 'function') _restoreCollaboration(_sessionId);
    if (workCards) _workCards?.restoreRequirements?.();
    _restoreRetainedConversationFailure();
    global.SoduWorkQuotaNotice?.modelChanged?.(_snap?.modelSelection?.model || _model,
      _snap?.adapterId || _sessionOptions.adapterId || 'pi', document.querySelector('#cpChat .work-composer'));
    _render();
    if (inputFiles.length) _rememberConversationDraft(_sessionId);
    if (previewInput) global.ChatWorkbench?.openInput(previewInput);
    if (inputTitle && _sessionId && _api()?.renameHistory) {
      void _api().renameHistory(_sessionId, inputTitle).then(() => refreshHistory()).catch(() => {});
    }
    focusLater();
    return true;
  }
  function reset() {
    global.SoduWorkQuotaNotice?.modelChanged?.();
    _workCards?.detach();
    _resetMessageRenderer();
    global.AccessControls?.destroy(document.querySelector('#cpChat .nchat'));
    _rememberConversationDraft();
    _flushConversationDrafts();
    // Control teardown must not overwrite the saved draft with an empty attachment tray.
    _withConversationDraftRestore(() => {
    _cancelScheduledRender();
    _loadingOlder = false;
    _viewEpoch += 1;
    clearTimeout(_collabPollTimer); _collabPollTimer = null;
    _stopSlowStatusTicker();
    _stopThinkingClock();
    _busy = false;
    _stopRequestToken += 1;
    _sendStateToken += 1;
    _sendState = 'idle';
    _clearStopTimer();
    _stopState = 'idle';
    _stopReceiptAcknowledged = false;
    _goalActionPending = '';
    _openingEpoch = -1;
    _openingTask = null;
    _submitTail = Promise.resolve();
    const api = _api();
    if (_off) { try { _off(); } catch (e) { /* ignore */ } _off = null; }
    const releasedRef = _ref;
    if (api && releasedRef) {
      if (typeof api.release === 'function') Promise.resolve(api.release(releasedRef)).then(refreshHistory).catch(() => {});
      else if (typeof api.close === 'function') api.close(releasedRef);
    }
    if (global.PluginDebugCard) PluginDebugCard.close();
    _ref = ''; _sessionId = ''; _snap = null; _model = null; _pending = ''; _pendingSentAt = 0; _pendingBaseline = null; _lastProposal = ''; _sessionOptions = {};
    _draftKey = 'new';
    _messageWindowSize = 80;
    if (_composerControls) { _composerControls.destroy(); _composerControls = null; }
    _wd = { dir: '', name: '准备工作区' }; _mode = 'full'; _sessionCaps = []; _sessionInputs = [];
    _pendingProposal = null; _proposalMuted = false;
    clearTimeout(_outRetryTimer); _outRetryTimer = null; _outRequest++;
    _outs = []; _outAt = ''; _lastStatus = '';
    if (_messageAttachments) _messageAttachments.clear();
    _messageAttachments = null;
    _skillPicker = null; // The composer is removed below; do not persist its old input as a new-chat draft.
    _skillLoadSeq += 1;
    _pendingAttachmentNames = [];
    _pendingLibraryIds = [];
    _localQueue = [];
    _taskAttachments = [];
    _collaborationTask = null;
    _collabTasks.clear(); _activeCollabTaskId = ''; _collabPicker = { open: false, loading: false, tasks: [] };
    _collaborationTaskId = '';
    _collaborationTrace = null;
    _collaborationHistoryAnnounced = false;
    _taskSession = null;
    _taskOpenError = '';
    _taskOpenPending = false;
    _sessionOpenedAt = 0;
    _boundFromServer = false;
    _collabLoadSeq += 1;
    _taskStartPrompt = null;
    _queueEdit = null;
    _queueHistoryOpen = false;
    _acceptanceHistoryAutoExpanded = false;
    if (_collabView) { _collabView.destroy(); _collabView = null; }
    _pendingPlugins = [];
    _submissionDrafts.clear();
    _retryDraft = null;
    _pluginAuthorization = null;
    const computerGlow = document.getElementById('computerActivityGlow');
    if (computerGlow) computerGlow.remove();
    _pluginResolveSeq += 1;
    _pluginResolveBusy = false;
    _openThink.clear(); _closedThink.clear(); _openTool.clear(); _openToolGroup.clear();
    if (global.WorkEntrySheet && typeof WorkEntrySheet.close === 'function') {
      WorkEntrySheet.close(true, true);
    }
    if (global.ComposeDraft) ComposeDraft.clear();     // Keep cards bound to their conversation rather than carrying them into the next one.
    if (global.ChatWorkbench) ChatWorkbench.reset();
    if (global.ChatWorkbenchAnnotations) ChatWorkbenchAnnotations.detach();
    if (_pluginMention) _pluginMention.destroy();
    _pluginMention = null;
    if (global.ChatChrome) ChatChrome.reset();
    const host = document.getElementById('cpChat');
    if (host) host.innerHTML = '';
    });
  }
  function sessionInfo() {
    const rows = _collabEntries();
    const active = rows.find((row) => row.taskId === _activeCollabTaskId) ||
      rows[rows.length - 1] || {};
    const task = active.task || {};
    const context = task.executionContext || ((_snap || {}).execution || {}).executionContext || {};
    const projectId = String(_snap?.requirementContext?.projectId || _sessionOptions.projectId || active.projectId || task.projectId ||
      task.project && task.project.id || '').trim();
    return {
      ref: _ref, sessionId: _sessionId, projectId,
      repoId: _snap?.requirementContext?.repoId || _sessionOptions.repoId || active.repoId || '',
      cwd: _wd?.dir || _sessionOptions.cwd || '', model: _workModel(),
      title: global.ChatChrome?.sessionTitle || _sessionOptions.sidebarProjectName || _sessionOptions.workspaceLabel || _wd?.name || '',
      sessionUnavailable: _snap?.sessionNotFound === true,
      cloudHandoff: _snap?.cloudHandoff?.phase === 'committed',
      collaboration: Boolean(rows.length || _sessionOptions.taskRef || _sessionOptions.taskSession),
      taskIds: rows.map((row) => row.taskId),
      adapterId: (_ref && _snap?.adapterId) || _sessionOptions.adapterId || 'pi',
      selectedAgentId: context.agentId || context.agent && context.agent.id || '',
      hasSelectedAgent: Boolean(context.agent || context.agentId || context.agentKind ||
        _sessionOptions.agentId || _sessionOptions.agentKind),
      queueMode: _sessionOptions.queueMode || active.queueMode || 'serial',
      status: active.queueState || context.status || task.status || '',
      acceptanceSession: _sessionOptions.acceptanceSession === true || _sessionOptions.acceptanceExecutionSession === true,
      acceptanceExecutionSession: _sessionOptions.acceptanceExecutionSession === true,
      acceptanceFallbackFrom: _sessionOptions.acceptanceFallbackFrom || '',
      acceptanceTaskId: String(_sessionOptions.taskRef || _activeCollabTaskId || '').trim(),
      acceptanceMode: _sessionOptions.acceptanceMode || _sessionOptions.mode || '',
      acceptanceApprovalId: String(_sessionOptions.approvalId || '').trim(),
    };
  }
  function hasSession() { return !!(_ref || _sessionId); }
  function prepare(options) {
    // Work forms reserve an archive without opening an Agent. Transfer the
    // selected model here so their composer and first normal send agree.
    if (options && !_ref && !_sessionId && !_busy) {
      _sessionOptions = { ..._sessionOptions, adapterId: options.adapterId || 'pi',
        modelName: options.modelName || '', modelLabel: options.modelLabel || options.modelName || '',
        reasoningEffort: options.reasoningEffort || '', thinkingLevel: options.thinkingLevel || '' };
      _model = _sessionOptions.modelName ? { id: _sessionOptions.modelName, label: _sessionOptions.modelLabel } : null;
    }
    _mount();
  }
  function openTaskPicker(options = {}) {
    if (options.host) {
      if (_ref || _sessionId || _busy || _collabPicker.open) return Promise.resolve(false);
      const host = options.host;
      _collabView?.destroy();
      _collabView = global.ChatCollaboration.create({ host, onAction: _collabAction });
      const detach = () => { _collabView?.destroy(); _collabView = null; };
      return _openTaskPicker({ host,
        canConfirm: options.canConfirm,
        context: { ...options.sessionOptions, model: options.sessionOptions?.modelName || '' },
        render: value => _collabView?.render(value),
        onClose: () => { detach(); options.onClose?.(); },
        onConfirm: isCurrent => {
          if (!isCurrent() || options.onConfirm?.(isCurrent) === false || !isCurrent()) return false;
          detach();
          _sessionOptions = { ..._sessionOptions, ...options.sessionOptions };
          _wd = { dir: _sessionOptions.cwd || '', name: _sessionOptions.workspaceLabel || '默认工作区' };
          _mode = _sessionOptions.mode || 'full';
          prepare(options.sessionOptions); _restoreConversationDraft('new');
          return true;
        },
      });
    }
    const newDraft = !_ref && !_sessionId && !_busy && options.sessionOptions;
    if (newDraft) {
      _sessionOptions = { ..._sessionOptions, ...options.sessionOptions };
      _wd = { dir: _sessionOptions.cwd || '', name: _sessionOptions.workspaceLabel || '默认工作区' };
      _mode = _sessionOptions.mode || 'full';
    }
    prepare(options.sessionOptions);
    if (newDraft) _restoreConversationDraft('new');
    return _openTaskPicker({ onClose: options.onClose });
  }
  if (global.addEventListener) {
    global.addEventListener('soduwork-data-scope-changed', _clearConversationDraftScope);
    global.addEventListener('soduwork-data-scope-changed', () => _conversationSnapshots.clear());
    global.addEventListener('soduwork-data-scope-changed', () => _workCards?.clearScope());
    global.addEventListener('beforeunload', () => { _workCards?.capture(); void _workCards?.flush(); });
    global.addEventListener('pagehide', _flushConversationDrafts);
    global.addEventListener('beforeunload', _flushConversationDrafts);
    const flushWhenHidden = () => {
      if (global.document && global.document.visibilityState === 'hidden') _flushConversationDrafts();
    };
    global.addEventListener('visibilitychange', flushWhenHidden);
    if (global.document && global.document.addEventListener) {
      global.document.addEventListener('visibilitychange', flushWhenHidden);
    }
  }
  global.NativeChat = {
    async focusApproval(taskId, approvalId) {
      const id = String(taskId || '');
      await _loadCollabTask(id);
      const block = [...document.querySelectorAll('[data-task-confirmation]')]
        .find(el => el.dataset.taskConfirmation === id);
      const card = block && [...block.querySelectorAll('[data-tfd-approval-id]')]
        .find(el => !approvalId || el.dataset.tfdApprovalId === String(approvalId));
      if (!card) return false;
      card.scrollIntoView({block: 'center'});
      card.setAttribute('tabindex', '-1');
      card.focus({preventScroll: true});
      return true;
    },
    enqueueTask,
    enter, reset, send: _send, openWorkAction: _openWorkAction,
    openAppMention: options => _mateMention?.open(options) || {ok:false,reason:'同事发送卡片尚未就绪，请稍后重试'},
    runAppAutomation: (params,authorize)=>_workCards.runAutomation(params,authorize),
    bindTask: _bindCollaborationTask, openTask: _openTask, openTaskPicker,
    closeTaskPicker: host => { if (_collabPicker.host === host) _collabAction('picker-close'); },
    isBusy: _runtimeBusy,
    hasSession, sessionInfo, refreshHistory, prepare,
    readingPosition: () => _readingPosition?.capture(),
    restoreReadingPosition: (reading, isCurrent) => _readingPosition?.restore(reading, isCurrent),
    revealSearchMatch: (query, isCurrent) => _readingPosition?.revealSearchMatch(query, isCurrent),
    rememberDraft: (key, text, skills) => _rememberConversationText(key, text, skills),
    rememberComposerDraft: _rememberConversationDraft,
    restoreComposerDraft: _restoreConversationDraft,
    withDraftRestore: _withConversationDraftRestore,
    getDraft: (key) => _conversationDraftText(key),
    getDraftSkills: (key) => _conversationDraftSkills(key),
    clearDraft: (key) => _clearConversationDraft(key),
  };
})(window);
