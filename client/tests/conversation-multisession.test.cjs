const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const sessions = require('../main/pi-session/session');

test('conversation presence covers every runtime terminal and interactive state', () => {
  assert.equal(sessions._presenceState('streaming'), 'running');
  assert.equal(sessions._presenceState('queued'), 'waiting');
  assert.equal(sessions._presenceState('compacting'), 'running');
  assert.equal(sessions._presenceState('waiting-user'), 'waiting');
  assert.equal(sessions._presenceState('idle'), 'completed');
  assert.equal(sessions._presenceState('unreachable'), 'failed');
  assert.equal(sessions._presenceState('no-output'), 'failed');
  assert.equal(sessions._presenceState('aborted'), 'stopped');
});

test('conversation title stays on the first prompt unless the user explicitly renames it', () => {
  assert.equal(sessions._title({ name: '完事了吗', firstMessage: '帮我制作一个飞机游戏' }),
    '帮我制作一个飞机游戏');
  assert.equal(sessions._title({ name: '底座自动标题', firstMessage: '首次需求', userTitle: '飞机项目' }),
    '飞机项目');
});

test('live session facts override disk history and live-only work is retained', () => {
  const handles = [
    { historyRow: () => ({ id: 'a', title: 'A', state: 'running', at: 30, live: true }) },
    { historyRow: () => ({ id: 'b', title: 'B', state: 'waiting', at: 20, live: true }) },
  ];
  const rows = sessions._mergeHistory([{ id: 'a', title: 'old', state: 'archived', at: 10, path: 'a.jsonl' }], handles, 20);
  assert.deepEqual(rows.map((row) => [row.id, row.state]), [['a', 'running'], ['b', 'waiting']]);
  assert.equal(rows[0].path, 'a.jsonl');
});

test('switching conversations releases the renderer but keeps and reattaches the runtime', () => {
  const chat = read('components', 'panels', 'panels-chat.js');
  const ipc = read('main', 'pi-session', 'ipc.js');
  const preload = read('preload.js');
  assert.match(chat, /api\.release\(releasedRef\)/);
  assert.doesNotMatch(chat, /if \(api && (?:ctx\.)?_ref\) api\.close\((?:ctx\.)?_ref\)/);
  assert.match(ipc, /session\.findBySessionId\(opts\.chatId\)/);
  assert.match(ipc, /attached: true/);
  assert.match(ipc, /pi-session-release/);
  assert.match(preload, /release:\s*\(ref\).*pi-session-release/);
});

test('only the attached window receives full snapshots while every window receives presence', () => {
  const ipc = read('main', 'pi-session', 'ipc.js');
  assert.match(ipc, /snapshot: includeSnapshot \? (?:ctx\.)?_contextSnapshot\(handle, snapshot\) : null/);
  assert.match(ipc, /const full = !handle\.detached && owner === win/);
  assert.match(ipc, /(?:ctx\.)?_send\(win, handle, touched, snapshot, full\)/);
  assert.match(read('components', 'panels', 'panels-chat.js'), /if \(!p\.snapshot\) return/);
  assert.doesNotMatch(ipc, /getAllWindows\(\).*(?:ctx\.)?_send\(win, handle, touched, snapshot\)\)/);
});

test('runtime errors are visible in both the conversation and history presence', () => {
  const ipc = read('main', 'pi-session', 'ipc.js');
  const chat = read('components', 'panels', 'panels-chat.js');
  assert.match(ipc, /reason: touched && touched\.reason/);
  assert.match(chat, /p\.kind === 'error'/);
  assert.match(chat, /(?:ctx\.)?_fail\('这一轮没跑成'/);
});

test('failed personal-plugin turns keep the draft, plugin selection, and attachments editable', () => {
  const chat = read('components', 'panels', 'panels-chat.js');
  assert.match(chat, /function _restoreFailedDraft\(draft\)/);
  assert.match(chat, /const files = _ordinaryDraftFiles\(draft\.files\)/);
  assert.match(chat, /(?:ctx\.)?_messageAttachments\?\.add\?\.\(files, 'draft'\)/);
  assert.match(chat, /(?:ctx\.)?_pluginMention\?\.restore\?\.\(draft\.plugins\)/);
  assert.match(chat, /(?:ctx\.)?_fail\('这一轮没发出去', r && r\.reason, failedDraft, r\)/);
  // Parameter-bearing retry drafts and conflicting newer selections are checked
  // behaviorally in chat-send-boundary / chat-plugin-draft-recovery. Folded body
  // cards must not duplicate their persisted text (long-text-draft), rather than
  // freezing the previous implementation's inline failedDraft expression.
  assert.match(chat, /if \(!ready\) \{ retainFailure\([\s\S]{0,80}?(?:ctx\.)?_restoreFailedDraft\(failedDraft\)/);
});

test('closing the owner window detaches rather than terminates active work', () => {
  const ipc = read('main', 'pi-session', 'ipc.js');
  assert.match(ipc, /win\.once\('closed', handle\.ownerClosed\)/);
  assert.match(ipc, /if \(handle\.attachedWindow === win\) (?:ctx\.)?_detach\(handle\)/);
  assert.match(ipc, /function _detach\(handle\)/);
});

test('history list distinguishes runtime state from selected row state', () => {
  const shell = read('components', 'workspace', 'workspace-shell.js');
  const css = read('components', 'workspace', 'workspace-shell.css');
  assert.match(shell, /等待你确认/);
  assert.match(shell, /st-chat-.*state/);
  // Presence may be guarded by the account owner before it reaches the row
  // updater. Check delivery through both supported subscription APIs instead
  // of requiring a particular callback expression.
  for (const batched of [false, true]) {
    let receive, subscribed;
    const api = { onEvent(fn) { receive = fn; subscribed = 'single'; return () => {}; } };
    if (batched) api.onEventBatch = (fn, options) => {
      assert.equal(options.presenceOnly, true);
      receive = fn; subscribed = 'batch'; return () => {};
    };
    const window = {
      SoduWorkAPI: { hubBase: () => 'https://sidebar-fixture.invalid',
        clientAuthSnapshot: () => ({ clientId: 'fixture-device', user: { id: 'fixture-user' } }) },
      soduWorkAPI: { conversationSession: api },
    };
    for (const file of ['workspace-sidebar-state.js', 'workspace-chat-list.js'])
      vm.runInNewContext(read('components', 'workspace', file), { window, URL });
    const delivered = [];
    const ctx = { activeChatId: 'selected-completed', updateChatState: event => delivered.push(event) };
    window.WorkspaceChatList.create(ctx).subscribeConversationPresence();
    assert.equal(subscribed, batched ? 'batch' : 'single');
    for (const state of ['running', 'waiting', 'failed', 'completed', 'stopped', 'archived']) {
      const event = { sessionId: 'background-chat', presence: { id: 'background-chat', state } };
      receive(event);
      assert.equal(delivered.at(-1), event, `${state} presence must reach the history updater`);
      assert.equal(ctx.activeChatId, 'selected-completed', 'presence must not select a background conversation');
    }
    assert.equal(delivered.length, 6);
  }
  /*
   * Show status dots for running, waiting, or failed conversations only; completed, stopped,
   * and archived history remains unlit.
   */
  assert.match(css, /st-chat-running/);
  assert.match(css, /st-chat-waiting/);
  assert.match(css, /st-chat-failed/);
  assert.doesNotMatch(css, /st-chat-completed/);
  assert.doesNotMatch(css, /st-chat-archived/);
  assert.doesNotMatch(css, /\.ws-chat\.is-active i\.st-chat\{/);
});

test('signed-out history cannot subscribe to single or batched runtime presence', () => {
  for (const batched of [false, true]) {
    let subscriptions = 0;
    const api = { onEvent() { subscriptions++; } };
    if (batched) api.onEventBatch = () => { subscriptions++; };
    const window = {
      SoduWorkAPI: { hubBase: () => 'https://sidebar-fixture.invalid',
        clientAuthSnapshot: () => ({ clientId: 'fixture-device', user: null }) },
      soduWorkAPI: { conversationSession: api },
    };
    for (const file of ['workspace-sidebar-state.js', 'workspace-chat-list.js'])
      vm.runInNewContext(read('components', 'workspace', file), { window, URL });
    window.WorkspaceChatList.create({}).subscribeConversationPresence();
    assert.equal(subscriptions, 0);
  }
});

test('opening a history chat paints an immediate placeholder instead of a blank stage', () => {
  // This ordering belongs to NativeChat, not a dependency factory's reset().
  const chat = require('node:fs').readFileSync(path.join(root, 'components/panels/panels-chat.js'), 'utf8');
  const css = read('components', 'panels', 'panels-chat.css');
  /* Show immediate loading feedback while history lookup and runtime initialization complete. */
  assert.match(chat, /else if \(chatId\) (?:ctx\.)?_paintOpening\(\)/);
  const opening = read('components', 'panels', 'chat-session-controller.js');
  assert.match(opening, /function _paintOpening/);
  assert.match(opening, /nchat-opening/);
  assert.match(css, /\.nchat-opening\{/);
  assert.match(chat, /const _conversationSnapshots = new Map\(\)/,
    'recently opened chats keep a renderer snapshot for fast navigation');
  assert.match(chat, /const cachedSnapshot = chatId[\s\S]*?(?:ctx\.)?_cachedConversationSnapshot\(chatId\)/,
    'navigation checks the cached transcript before showing the opening skeleton');
  assert.ok(chat.indexOf('_snap = cachedSnapshot') < chat.indexOf('else if (chatId) _paintOpening()'),
    'a cached transcript must paint before the fallback skeleton');
  const enterBody = chat.slice(chat.indexOf('async function enter('), chat.indexOf('function reset()'));
  const paintAt = enterBody.indexOf('_paintOpening()');
  const ensureAt = enterBody.indexOf('await _ensure(chatId)');
  assert.ok(paintAt > 0 && ensureAt > paintAt, '占位必须画在 await _ensure 之前');

  assert.match(opening, /ctx\._taskOpenError = reason;[\s\S]*ctx\._fail\('\\u6253\\u5f00\\u4e0d\\u4e86\\u5bf9\\u8bdd', reason\)/, 'history rejection must leave the loading placeholder');
});

test('history sessions pass the extension watchdog options to the resource loader', () => {
  const session = read('main', 'pi-session', 'session.js');
  const start = session.indexOf('resources = await sessionResources', session.indexOf('async function open(opts)'));
  const opening = session.slice(start, start + 900);
  assert.ok(start >= 0, 'session opening must load scoped resources');
  assert.match(opening, /agentContract\.prompts\([\s\S]*\),\s*\{\s*noExtensions:\s*Boolean\(opts\.noExtensions(?: \|\| [^\n]+)?\)/);
  assert.match(opening, /timeoutMs:\s*opts\.resourceLoadTimeoutMs/);
});

test('switching conversations invalidates stale opens and resyncs after subscribing', () => {
  const chat = read('components', 'panels', 'panels-chat.js');
  assert.match(chat, /let _viewEpoch = 0/);
  assert.match(chat, /epoch !== (?:ctx\.)?_viewEpoch/);
  assert.match(chat, /api\.snapshot\(activeRef\)/);
  assert.match(chat, /p\.ref !== activeRef/);
});


test('the first turn is accepted before compose clears it and stale replies cannot cross sessions', () => {
  const chat = read('components', 'panels', 'panels-chat.js');
  const compose = read('components', 'panels', 'panels-compose.js');
  assert.match(compose, /await NativeChat\.enter\(/);
  assert.match(chat, /const accepted = await (?:ctx\.)?_send\(first/);
  assert.match(chat, /const submissionRef = retainedRef \|\| (?:ctx\.)?_ref/);
  assert.match(chat, /sendEpoch !== (?:ctx\.)?_viewEpoch \|\| submissionRef !== (?:ctx\.)?_ref/);
});

test('switching conversations preserves each unsent composer draft by conversation key', () => {
  const chat = read('components', 'panels', 'panels-chat.js');
  const compose = read('components', 'panels', 'panels-compose.js');
  assert.match(chat, /const _conversationDrafts = new Map\(\)/);
  assert.match(chat, /soduwork\.conversation-drafts\.v1/);
  assert.match(chat, /function _flushConversationDrafts\(\)/);
  assert.match(chat, /function _rememberConversationDraft\(key(?:, composer)?\)/);
  assert.match(chat, /function _restoreConversationDraft\(key(?:, composer)?\)/);
  // Exercise the row's consumer contract instead of freezing its private
  // literal shape: explicit Skill selections now share this existing draft row.
  const rows = new Map(); let picked = ['company-research'];
  const input = { value: '#1 第一份未发送的正文', dispatchEvent() {} };
  const scope = { Event, setTimeout, clearTimeout,
    document: { getElementById: () => input },
    localStorage: { getItem: key => rows.get(key), setItem: (key, value) => rows.set(key, value), removeItem: key => rows.delete(key) } };
  scope.window = scope;
  vm.runInNewContext(read('components', 'panels', 'chat-draft-recovery.js'), scope);
  const ctx = { _ref: 'ref-a', _draftKey: 'chat-a', _draftStorageKey: 'isolated-multisession-drafts',
    _conversationDrafts: new Map(), _skillPicker: { selected: () => picked, restore: names => { picked = Array.from(names); } } };
  const recovery = scope.ChatDraftRecovery.create(ctx);
  recovery._rememberConversationDraft('chat-a');
  input.value = '#web-audit 第二份普通正文'; picked = [];
  recovery._rememberConversationDraft('chat-b');
  recovery._restoreConversationDraft('chat-a');
  assert.equal(input.value, '#1 第一份未发送的正文');
  assert.deepEqual(picked, ['company-research']);
  recovery._restoreConversationDraft('chat-b');
  assert.equal(input.value, '#web-audit 第二份普通正文');
  assert.deepEqual(picked, [], 'body text cannot manufacture a picked Skill during switching');
  recovery._flushConversationDrafts();
  const saved = JSON.parse(rows.get('isolated-multisession-drafts'));
  assert.deepEqual(saved.map(row => ({ key: row.key, text: row.text, skills: row.skills })), [
    { key: 'chat-a', text: '#1 第一份未发送的正文', skills: ['company-research'] },
    { key: 'chat-b', text: '#web-audit 第二份普通正文', skills: [] },
  ]);
  assert.match(chat, /(?:ctx\.)?_restoreConversationDraft\((?:ctx\.)?_draftKey\)/);
  assert.match(chat, /const activeDraftKey = (?:ctx\.)?_ref[\s\S]*activeDraftKey \|\| 'new'/);
  assert.match(chat, /(?:ctx\.)?_draftKey = 'new';/);
  assert.match(chat, /if \(first\) (?:ctx\.)?_clearConversationDraft\((?:ctx\.)?_draftKey\);/);
  // Read the owner module for ordering; dependencies have their own reset().
  const nativeChat = require('node:fs').readFileSync(path.join(root, 'components/panels/panels-chat.js'), 'utf8');
  const resetBody = nativeChat.slice(nativeChat.indexOf('function reset() {'));
  assert.ok(resetBody.indexOf('_rememberConversationDraft();') < resetBody.indexOf('_viewEpoch += 1;'));
  assert.match(resetBody, /AccessControls\?\.destroy/);
  assert.match(chat, /input\.addEventListener\('input', \(\) => \{\s*(?:ctx\.)?_rememberConversationDraft\(\);/);
  assert.match(compose, /input\.addEventListener\('input', (?:ctx\.)?_rememberComposeDraft\)/);
  assert.match(compose, /(?:ctx\.)?_rememberComposeDraft\(\);[\s\S]*NativeChat\.reset\(\)/);
  assert.match(compose, /if \(q\.chatId\) \{[\s\S]*(?:ctx\.)?_rememberComposeDraft\(\);/);
  assert.match(compose, /function closeComposePanel\(\) \{[\s\S]*(?:ctx\.)?_rememberComposeDraft\(\);/);
  assert.match(compose, /else (?:ctx\.)?_restoreComposeDraft\(\);/);
});

test('in-flight prompts survive a conversation switch and paint before the stream fast path', () => {
  const chat = read('components', 'panels', 'panels-chat.js');
  const renderer = read('components', 'panels', 'chat-message-renderer.js');
  assert.match(chat, /let retainedRef = String\((?:ctx\.)?_ref \|\| ''\)\.trim\(\)/);
  assert.match(chat, /const ready = retainedRef \? true : await (?:ctx\.)?_ensure\(\)/);
  assert.match(chat, /const api = retainedApi \|\| (?:ctx\.)?_api\(\)/);
  assert.match(chat, /const submissionRef = retainedRef \|\| (?:ctx\.)?_ref/);
  assert.match(chat, /api\.send\(submissionRef, text, attachmentRefs/);
  const queueAt = renderer.indexOf('ctx._renderQueue(el);');
  const fastPathAt = renderer.indexOf('if (!mountedCardIds || workCards.every(');
  assert.ok(queueAt >= 0 && fastPathAt > queueAt,
    'local queue must repaint before the live-stream early return');
});

test('stream fast path waits for every requirement card slot without disabling ordinary token patches', () => {
  const renderer = read('components', 'panels', 'chat-message-renderer.js');
  const guard = renderer.match(/if \((!mountedCardIds[^\n]+)\) \{\s*if \((_patchLiveStream\([^\n]+\))\) \{/);
  assert.ok(guard, 'the fast path must include the requirement-card guard');
  const indexStart = renderer.indexOf('const mountedCardIds =');
  const guardStart = renderer.indexOf(guard[0], indexStart);
  assert.ok(indexStart >= 0 && guardStart > indexStart);
  const indexSource = renderer.slice(indexStart, guardStart);
  for (const [cards, slots, patched, expected, calls] of [
    [[], [], true, true, 1],
    [['saved'], [], true, false, 0],
    [['saved'], ['another'], true, false, 0],
    [['saved'], ['saved'], true, true, 1],
    [['saved', 'new'], ['saved'], true, false, 0],
    [['saved'], ['saved'], false, false, 1],
  ]) {
    let count = 0;
    const sandbox = {workCards: cards.map(id => ({id})),
      list: {children: slots.map(workCardSlot => ({dataset: {workCardSlot}}))},
      ctx: {_snap: {}}, allMessages: [], allTools: [],
      _patchLiveStream() { count++; return patched; }};
    assert.equal(vm.runInNewContext(indexSource + '\n(' + guard[1] + ') && ' + guard[2], sandbox), expected, JSON.stringify({cards, slots, patched}));
    assert.equal(count, calls);
  }
});

test('streaming chat avoids reparsing the whole Markdown transcript on every token', () => {
  const renderer = read('components', 'panels', 'chat-message-renderer.js');
  const chat = read('components', 'panels', 'panels-chat.js');
  const intent = read('components', 'panels', 'chat-work-intent.js');
  const stream = read('main', 'pi-session', 'event-snapshot.js');
  // Exercise the actual renderer's block route and its delegated Markdown
  // component. Acceptance-result rendering may wrap settled text, while live
  // tokens must keep the bounded parse rate and settled-history cache.
  let now = 1000, nextTimer = 0, repaints = 0;
  const parsed = [], sanitized = [], timers = new Map();
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const sandbox = {
    Date: { now: () => now },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    marked: { parse(source) { parsed.push(source); return '<unsafe>' + source + '</unsafe>'; } },
    DOMPurify: { sanitize(html, policy) {
      sanitized.push({ html, policy });
      return '<p data-sanitized>' + escape(parsed.at(-1)) + '</p>';
    } },
    ChatContextMeter: { create: () => ({}) }, ChatScrollFollow: { create: () => ({}) },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(read('components', 'panels', 'chat-markdown.js'), sandbox);
  vm.runInNewContext(renderer, sandbox);
  const ctx = { _ref: 'parse-budget-a', _snap: { status: 'streaming' }, _liveTextKey: '50:0', esc: escape,
    _mount() { repaints++; return null; } };
  const view = sandbox.ChatMessageRenderer.create(ctx);
  const history = Array.from({ length: 50 }, (_, index) => ({ kind: 'text', text: 'Settled reply ' + index }));
  const live = { kind: 'text', text: '```js\n' + 'const value = 1;\n'.repeat(1600) };
  const paint = () => {
    history.forEach((block, index) => view._blockHtml(index, block, 0));
    return view._blockHtml(50, live, 0);
  };
  const first = paint();
  assert.equal(parsed.length, 51, 'initial paint parses each history block and the live block once');
  for (let index = 0; index < 100; index++) {
    live.text += '\nnext ' + index;
    assert.equal(paint(), first, 'token bursts reuse the last sanitized live frame');
  }
  assert.equal(parsed.length, 51, 'neither settled history nor the live tail is reparsed for every token');
  assert.equal(timers.size, 1, 'one deferred repaint must flush the last token when the provider pauses');
  now += 400;
  for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
  assert.equal(repaints, 1);
  const final = paint();
  assert.equal(parsed.length, 52, 'one bounded parse includes the accumulated live deltas');
  assert.equal(parsed.at(-1), live.text, 'the code fence and complete prefix survive responses larger than 24k');
  assert.match(final, /data-sanitized/);
  assert.doesNotMatch(final, /<unsafe>/);
  assert.equal(sanitized.length, parsed.length, 'every parsed Markdown frame passes through sanitization');
  for (const { policy } of sanitized) {
    assert.ok(policy.FORBID_TAGS.includes('style'));
    assert.ok(policy.FORBID_ATTR.includes('style'));
  }
  ctx._snap.status = 'idle';
  const settled = paint(), afterSettling = parsed.length;
  assert.equal(paint(), settled);
  assert.equal(parsed.length, afterSettling, 'unchanged settled content uses the ordinary Markdown cache');
  assert.match(renderer, /function _patchLiveStream\(list, snap, messages, tools\)/);
  assert.match(renderer, /if \(!mountedCardIds \|\| workCards\.every\([^\n]+\)\) \{\s*if \(_patchLiveStream\(list, ctx\._snap, allMessages, allTools\)\) \{[\s\S]*?return;\s*}/);
  assert.match(renderer, /ctx\._refreshTurnMetrics\?\.\(\)/);
  assert.match(renderer, /liveStreamShape = ctx\._snap\.status === 'streaming'/);
  assert.match(renderer, /ctx\._snap\.status !== 'streaming'/);
  assert.match(intent, /proposalFingerprintRef/);
  assert.match(intent, /proposalFingerprints/);
  assert.match(intent, /JSON\.parse\(result\.trim\(\)\)/);
  assert.match(chat, /requestAnimationFrame/);
  assert.match(stream, /function _snapshotCache\(state\)/);
  assert.match(stream, /m\.done === true \? cache\.messages\.get\(m\) : null/);
  assert.match(stream, /Never mutate a cached projection/);
});

test('a newly opened conversation stores the live ref before the first send', () => {
  const chat = read('components', 'panels', 'panels-chat.js');
  const openStart = chat.indexOf('async function _ensureOnce');
  const openEnd = chat.indexOf('async function _send', openStart);
  const openBody = chat.slice(openStart, openEnd);
  assert.match(openBody, /const openedRef = String\(got\.ref/);
  assert.match(openBody, /const openedSessionId = String\(got\.sessionId/);
  assert.match(openBody, /(?:ctx\.)?_ref = openedRef;\s*(?:ctx\.)?_sessionId = openedSessionId;/);
  assert.ok(openBody.indexOf('ctx._ref = openedRef') < openBody.indexOf('const activeRef = ctx._ref'),
    'active event subscription must use the newly opened ref');
});

test('task queue sits above the composer and does not reserve a chat side column', () => {
  const chat = read('components', 'panels', 'panels-chat.js');
  const collaboration = read('components', 'panels', 'chat-collaboration.js');
  const css = read('components', 'panels', 'chat-collaboration.css');
  assert.match(chat, /id="nchatQueue"/);
  assert.ok(chat.indexOf('class="nchat-entry-dock"') < chat.indexOf('id="nchatQueue"'));
  assert.ok(chat.indexOf('id="nchatQueue"') < chat.indexOf('class="nbox"'));
  assert.match(chat, /dock\.insertBefore\(rail, dock\.firstChild\)/);
  assert.match(chat, /data-queue-action/);
  assert.doesNotMatch(collaboration, /ncollab-pin-trigger|ncollab-task-rail/);
  assert.match(css, /pointer-events:none/);
  assert.doesNotMatch(css, /flex:0 0 304px|font-size:(?:[0-9]|1[01])(?:\.\d+)?px\b/);
  assert.match(collaboration, /aria-modal="false"/);
});
test('reopening a conversation preserves persisted history order until new user work', () => {
  const handles = [
    { historyRow: () => ({ id: 'a', title: 'A', state: 'completed', at: 10, live: true }) },
  ];
  const rows = sessions._mergeHistory([
    { id: 'a', title: 'A', state: 'archived', at: 10, path: 'a.jsonl' },
    { id: 'b', title: 'B', state: 'archived', at: 20, path: 'b.jsonl' },
  ], handles, 20);
  assert.deepEqual(rows.map((row) => row.id), ['b', 'a']);
  const source = read('main', 'pi-session', 'session.js');
  assert.match(source, /Number\(opts\.resumeAt \|\| 0\)/);
  assert.match(read('main', 'pi-session', 'ipc.js'), /resumeAt: resume \? resume\.at : 0/);
});

test('tool limits become resumable goal pauses instead of terminal failures', () => {
  const session = read('main', 'pi-session', 'session.js');
  const runControl = require('../main/pi-session/run-control');
  const ipc = read('main', 'pi-session', 'ipc.js');
  const chat = read('components', 'panels', 'panels-chat.js');
  assert.match(session, /limitRequest/);

  assert.match(session, /isToolStart.*tool_execution_start/);
  assert.match(session, /maxToolSteps/);
  for (const [kind, used, limit] of [['steps', 7, 5], ['time', 10, 10], ['tool-loop', 16, 16]]) {
    const state = runControl.createState();
    state.toolSteps = 7; state.toolProgress.noProgress = 16;
    let request, quality, aborted = 0;
    const ctx = { maxSteps: 5, maxToolSteps: 5, goalBudgetMinutes: 10,
      goalEnabled: () => true, visible: () => true, limitRequest: () => request,
      setLimitRequest: value => { request = value; }, setQuality: phase => { quality = phase; },
      checkpoint() {}, emit() {}, acc: { abort() { aborted++; } } };
    runControl.stopForLimit(state, kind, 'pause', ctx);
    assert.equal(quality, 'paused'); assert.equal(aborted, 1);
    assert.equal(request.used, used); assert.equal(request.limit, limit);
    assert.equal(request.kind, kind);
    assert.deepEqual(runControl.continuation(ctx), request);
    if (kind === 'steps') assert.match(request.reason, /另有 2 个并行调用/);
  }
  assert.match(session, /continueGoal\(\)/);
  assert.match(ipc, /pi-session-goal-action/);
  const intent = read('components', 'panels', 'work-intent.js');
  assert.match(intent, /继续完成目标/);
  assert.match(chat, /onResume: \(\) => ctx\._goalAction\('continue'\)/);
});

test('goal controls stay callable and removing an active goal stops its hidden loop', () => {
  const chat = read('components', 'panels', 'panels-chat.js');
  const session = read('main', 'pi-session', 'session.js');
  assert.match(chat, /async function _answerUi\([\s\S]*?api\.answerUi\(answerRef, res\);[\s\S]*?\n  }\s*async function _goalAction/);
  assert.doesNotMatch(chat, /function _goalLimitHtml/);
  assert.doesNotMatch(chat, /(?:ctx\.)?_goalLimitHtml\(execution\)/);
  assert.match(chat, /onPause: \(\) => ctx\._goalAction\('stop'\)/);
  assert.match(chat, /onResume: \(\) => ctx\._goalAction\('continue'\)/);
  assert.match(chat, /let _goalActionPending = ''/);
  assert.equal((chat.match(/(?:ctx\.)?_goalAction\('disable'\)/g) || []).length, 1);
  assert.match(chat, /if \(!\(await (?:ctx\.)?_goalAction\('disable'\)\)\) return/);
  assert.match(session, /let goalCancelled = false/);
  assert.match(session, /if \(ctx\.inFlight\) \{\s*ctx\.goalCancelled = true/);
  assert.match(session, /if \(ctx\.goalCancelled\) \{/);
});

test('goal loop rail lives outside the composer without shrinking the input', () => {
  const chat = read('components', 'panels', 'panels-chat.js');
  const intentCss = read('components', 'panels', 'work-intent.css');
  assert.match(chat, /dock\.insertBefore\(rail, dock\.firstChild\)/);
  assert.match(intentCss, /\.nqueue-goal-slot\s*>\s*\.wi-rail/);
});

test('long waits rotate truthful copy without institution promotion', () => {
  const chat = read('components', 'panels', 'panels-chat.js');
  const status = read('components', 'panels', 'panels-chat-status.js');
  assert.match(status, /setInterval\(refreshSlowStatus, 1200\)/);
  assert.match(status, /\(stable \+ phase\) % 17 === 0/);
  assert.match(status, /每一次高质量交付/);
  assert.doesNotMatch(status, /\d+%|预计.*(?:分钟|小时)/);
  assert.match(chat, /(?:ctx\.)?_stopSlowStatusTicker\(\);[\s\S]*(?:ctx\.)?_busy = false/);
});
