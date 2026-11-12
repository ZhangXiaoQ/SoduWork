const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const vm = require('node:vm');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const preview = require('../main/work-preview');

test('Hub PDF files use the native PDF preview even with a generic attachment kind', () => {
  const scope = { window: { ChatDomPatch: require('../components/panels/chat-dom-patch') } };
  vm.runInNewContext(read('components', 'panels', 'panels-chat-tools.js'), scope);
  const tools = scope.window.ChatTools;
  for (const kind of ['task-file', 'document', undefined]) {
    assert.equal(tools.previewKind({taskId:'task', attachmentId:'pdf', name:'报告.PDF', kind}), 'pdf');
  }
  assert.equal(tools.previewKind({name:'local.pdf'}), 'pdf');
  assert.equal(tools.previewKind({taskId:'task', attachmentId:'zip', name:'archive.zip', kind:'task-file'}), 'external');
  assert.equal(tools.previewKind({name:'report.docx', kind:'document'}), 'external');
  for (const ext of ['ZIP', '7z', 'rar', 'tar', 'gz']) {
    assert.equal(tools.previewKind({name:'result.'+ext, kind:'website', contentType:'text/html'}), 'external');
  }
  assert.equal(tools.previewKind({name:'download', kind:'text', contentType:'application/zip'}), 'external');
  assert.equal(tools.previewKind({name:'sheet.xlsx', contentType:'application/octet-stream'}), 'external');
  assert.equal(tools.previewKind({name:'document', kind:'document', contentType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}), 'external');
  assert.equal(tools.previewKind({name:'data.json', taskId:'task', attachmentId:'json', contentType:'application/json'}), 'text');
  assert.equal(tools.previewKind({name:'notes', kind:'document', contentType:'text/plain'}), 'text');
  assert.equal(tools.previewKind({name:'data.txt', kind:'spreadsheet', contentType:'text/plain'}), 'external');
  for (const contentType of ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.oasis.opendocument.presentation']) {
    assert.equal(tools.previewKind({name:'download.txt', kind:'text', contentType}), 'external');
  }
});

test('work preview only accepts safe browser addresses', () => {
  assert.equal(preview._normalizeAddress('localhost:5173/app'), 'http://localhost:5173/app');
  assert.equal(preview._normalizeAddress('example.com'), 'https://example.com/');
  assert.equal(preview._safeWebUrl('javascript:alert(1)'), '');
  assert.equal(preview._safeWebUrl('file:///C:/secret.txt'), '');
  assert.equal(preview._safeWebUrl('about:blank'), 'about:blank');
});

test('native preview bounds stay inside the host content area', () => {
  assert.deepEqual(preview._clampBounds({ x: -20, y: 10, width: 900, height: 700 }, { width: 800, height: 600 }),
    { x: 0, y: 10, width: 800, height: 590 });
  assert.deepEqual(preview._clampBounds({ x: 760, y: 580, width: 100, height: 80 }, { width: 800, height: 600 }),
    { x: 760, y: 580, width: 40, height: 20 });
});

test('renderer receives a narrow work-preview bridge instead of raw Electron access', () => {
  const preload = read('preload.js');
  const main = read('main.js');
  assert.match(preload, /const workPreview = \{/);
  assert.match(preload, /work-preview-show/);
  assert.match(preload, /work-preview-command/);
  assert.match(preload, /artifactAction/);
  assert.match(preload, /workPreview,/);
  assert.match(main, /WebContentsView/);
  assert.match(main, /_workPreview\.install/);
});

test('standalone HTML output blocks navigation outside its real workspace', () => {
  const ipc = read('main', 'pi-session', 'ipc.js');
  assert.match(ipc, /webContents\.on\('will-navigate'/);
  assert.match(ipc, /outputs\.navigation\(s\.cwd, url\)/);
  assert.match(ipc, /e\.preventDefault\(\)/);
  assert.match(ipc, /setWindowOpenHandler/);
  assert.match(ipc, /shell\.openExternal\(nav\.url\)/);
});


test('conversation loads a tabbed native workspace and does not fall back to iframe preview', () => {
  const desk = read('desk.html');
  const workspace = read('components', 'panels', 'panels-chat-workspace.js');
  assert.match(desk, /panels-chat-tools\.js[\s\S]*panels-chat-chrome\.js[\s\S]*panels-chat-workspace\.js[\s\S]*panels-chat\.js/);
  assert.doesNotMatch(desk, /conversation-deliverables/);
  assert.match(workspace, /data-wb-address-form/);
  assert.match(workspace, /data-wb-tab-close/);
  assert.match(workspace, /workPreview/);
  assert.doesNotMatch(workspace, /<iframe/);

});
test('service URLs survive ANSI-colored CLI output (vite bolds the port)', () => {
  const src = read('components', 'panels', 'chat-workspace-info.js');
  /*
   * Execute the production stripAnsi helper against colored server output so escape codes
   * cannot leak into preview URLs.
   */
  const m = src.match(/function stripAnsi\(text\) \{[\s\S]*?\n  \}/);
  assert.ok(m, 'panels-chat-workspace.js 里必须有 stripAnsi');
  const stripAnsi = new Function('return ' + m[0])();
  const vite = '  ➜  Local:   http://localhost:\x1b[1m4199\x1b[22m/\x1b[39m\n';
  const urls = stripAnsi(vite).match(/https?:\/\/[^\s"'<>]+/ig) || [];
  assert.deepEqual(urls, ['http://localhost:4199/']);
  const osc = '\x1b]0;title\x07http://127.0.0.1:8080/ok\x1b[0m';
  assert.deepEqual(stripAnsi(osc).match(/https?:\/\/[^\s"'<>]+/ig), ['http://127.0.0.1:8080/ok']);
  /* Only observed output is scanned; command arguments are not service evidence. */
  assert.match(src, /stripAnsi\(\[tool\.partial, tool\.result\]/);
});

test('conversation chrome exposes location, deliverables and in-area maximize controls', () => {
  const chrome = read('components', 'panels', 'panels-chat-chrome.js');
  const workspace = read('components', 'panels', 'panels-chat-workspace.js');
  const css = read('components', 'panels', 'panels-chat.css');
  assert.match(css, /@import url\("\.\/chat-workbench-toolbar\.css"\)/);
  const toolbarCss = read('components', 'panels', 'chat-workbench-toolbar.css');
  assert.match(chrome, /data-chat-open-location/);
  assert.match(chrome, /data-chat-summary/);
  assert.match(chrome, /data-chat-pane/);
  assert.doesNotMatch(workspace, /class="ncw-peek"/);
  assert.match(chrome, /data-chat-summary-pop/);
  assert.match(workspace, /data-wb-maximize/);
  assert.match(workspace, /data-wb-close aria-label="隐藏成果区"/);
  assert.match(workspace, /M13\.5 4v16/);
  assert.match(read('components', 'panels', 'panels-chat.js'),
    /<div class="nchat-stage"><div class="nchat-main">' \+\s*\(global\.ChatChrome \? ChatChrome\.header\(\) : ''\)/);
  assert.match(workspace, /if \(!hit\) return;\s*if \(hit\.hasAttribute\('data-wb-maximize'\)\)/);
  assert.match(workspace, /toggle:\s*toggleWorkbench/);
  assert.match(workspace, /maximize:\s*maximizeWorkbench/);
  assert.match(css, /\.nchat\.ncw-maximized \.nchat-main\{display:none\}/);
  assert.match(css, /--nchat-w:50%/);
  assert.match(workspace, /role="separator"/);
  assert.match(workspace, /aria-valuetext="对话 50%，成果 50%"/);
  assert.match(workspace, /function resetSplit\(root\)/);
  const split = read('components', 'panels', 'chat-workspace-split.js');
  assert.match(workspace, /split\.bind\(root/);
  assert.match(split, /grip\.addEventListener\('dblclick'/);
  assert.match(split, /event\.key === 'ArrowLeft'/);
  assert.doesNotMatch(workspace, /soduwork\.workbench\.chatRatio/);
  assert.match(css, /\.ncw\{[^}]*overflow:visible/);
  assert.match(css, /\.ncw-resize\{[^}]*width:28px/);
  assert.match(css, /\.ncw-resize>span\{/);
  assert.match(css, /\.nchat\.ncw-open \.nchat-head \[data-chat-pane\]\{visibility:hidden/);
  assert.match(toolbarCss, /\.ncw-top\{height:54px/);
  const context = { window: {} };
  context.window.window = context.window;
  vm.runInNewContext(chrome, context, { filename: 'panels-chat-chrome.js' });
  assert.equal(typeof context.window.ChatChrome, 'object');
  assert.equal(typeof context.window.ChatChrome.toggle, 'undefined');
  assert.equal(typeof context.window.ChatChrome.begin, 'function');
  assert.equal(typeof context.window.ChatChrome.identify, 'function');
  assert.equal(typeof context.window.ChatChrome.workbenchState, 'function');
});
test('resumed conversations do not create a second optimistic history row', () => {
  const chrome = read('components', 'panels', 'panels-chat-chrome.js');
  const writes = [];
  const selections = [];
  const window = {
    WorkspaceShell: { upsertChat: (item) => writes.push(item), removeChat: () => {},
      setActiveChat: (id) => selections.push(id) },
    setTimeout,
  };
  window.window = window;
  const context = { window, setTimeout };
  vm.runInNewContext(chrome, context, { filename: 'panels-chat-chrome.js' });

  window.ChatChrome.identify('existing-session');
  window.ChatChrome.resume('????');
  window.ChatChrome.begin('????');

  assert.equal(writes.length, 0);
  assert.deepEqual(selections, ['existing-session']);
});


test('first prompt creates an immediate history row backed by the real Pi session id', () => {
  const chrome = read('components', 'panels', 'panels-chat-chrome.js');
  const shell = read('components', 'workspace', 'workspace-shell.js');
  const chat = read('components', 'panels', 'panels-chat.js');
  const session = read('main', 'pi-session', 'session.js');
  const ipc = read('main', 'pi-session', 'ipc.js');
  assert.match(chrome, /WorkspaceShell\.upsertChat\(pendingHistory\)/);
  assert.match(chat, /ChatChrome\.identify\(got\.sessionId\)/);
  assert.match(session, /sessionId:\s*ctx\.piSession\.sessionId/);
  /* Both new and resumed active conversations return the actual runtime session ID to sidebar state. */
  assert.match(ipc, /function _openReply\(handle, extra\)/);
  assert.match(ipc, /sessionId:\s*handle\.sessionId/);
  assert.match(shell, /function _sameDraft\(draft, real\)/);
  /* The reconcile implementation lives in workspace-chat-history.js since 664a7a9a;
     the shell destructures it and the chat list still reconciles every chat update. */
  assert.match(shell, /_reconcileChats, _upsertChatItems \} = global\.WorkspaceChatHistory/);
  const chatHistory = read('components', 'workspace', 'workspace-chat-history.js');
  const historyScope = { window: {} };
  vm.runInNewContext(chatHistory, historyScope);
  const now = 1700000000000;
  const rows = historyScope.window.WorkspaceChatHistory._reconcileChats(
    [{ localId: 'draft-first', title: 'First prompt', at: now, pending: true }],
    [{ id: 'real-pi-session', title: 'First prompt', at: now + 1, state: 'running' }],
    now + 2,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'real-pi-session');
  assert.equal(rows[0].title, 'First prompt');
  assert.equal(rows[0].pending, false);
  assert.equal(rows[0]._uiKey, 'draft:draft-first');
  assert.equal(Object.hasOwn(rows[0], 'localId'), false);
  const chatList = read('components', 'workspace', 'workspace-chat-list.js');
  assert.match(chatList, /ctx\.chatItems = ctx\._reconcileChats\(/);
  /* Allow selecting optimistic rows once they have a real session ID, even during startup. */
  assert.match(shell, /b\.dataset\.chatId = id; b\.disabled = !id/);
  assert.match(shell, /aria-current/);
  assert.match(shell, /function setActiveChat\(id\)/);
});

test('goal sessions stay in the conversation until a real deliverable exists', () => {
  const workspace = read('components', 'panels', 'panels-chat-workspace.js');
  assert.doesNotMatch(workspace, /workBriefHtml|ncw-workbrief|_workState|_latestAnswer/);
  assert.match(workspace, /const has = hasVisibleTabs\(WB\.tabs\)/);
  assert.match(workspace, /if \(!has\) \{ WB\.open = false; WB\.maximized = false; WB\.active = ''; \}/);
  assert.match(workspace, /const turnTools = currentTurnTools\(snapshot \|\| \{\}\)/);
  assert.match(workspace, /candidate\.key !== WB\.autoPreviewKey/);
  assert.doesNotMatch(workspace, /WB\.intent\.active/);
});

test('delivery refreshes replace stale automatic previews instead of opening another tab', () => {
  const workspace = read('components', 'panels', 'panels-chat-workspace.js');
  assert.match(workspace, /function samePreviewFile\(tab, candidate\)/);
  assert.match(workspace, /tab\.autoPreview && samePreviewFile\(tab, candidate\)/);
  assert.match(workspace, /removeStaleAutoPreviewTabs\(candidate\)/);
});

test('preview candidates are isolated to the current turn and newest service', () => {
  const oldWindow = global.window;
  const oldIntent = global.WorkIntent;
  global.window = global;
  global.WorkIntent = require('../components/panels/work-intent');
  const toolsPath = require.resolve('../components/panels/panels-chat-tools');
  const workspacePath = require.resolve('../components/panels/panels-chat-workspace');
  delete require.cache[toolsPath]; delete require.cache[workspacePath];
  const tools = require(toolsPath);
  require(workspacePath);
  assert.equal(tools._linkTarget('#section', []), null);
  assert.equal(tools._linkTarget('/unknown/output.pdf', []), null);
  assert.equal(tools._linkTarget('report.html', [{artifactId:'report', name:'report.html'}]).kind, 'file');
  const oldTool = { id: 'old-service', name: 'bash', args: { command: 'npm run dev' },
    state: 'done', partial: 'http://127.0.0.1:8899/', after: 0 };
  const currentTool = { id: 'current-service', name: 'bash', args: { command: 'npm run dev' },
    state: 'running', partial: 'http://127.0.0.1:8899/', after: 2 };
  const snapshot = { messages: [
    { role: 'user', text: 'old' }, { role: 'assistant', blocks: [] }, { role: 'user', text: 'new' },
  ], tools: [oldTool, currentTool] };
  assert.deepEqual(tools._currentTurnTools(snapshot).map((item) => item.id), ['current-service']);
  assert.equal(tools._services([oldTool, currentTool])[0].id, 'current-service');
  const cloudService = tools._services([{
    id: 'cloud-service', name: 'bash', args: { command: 'npm run dev' }, state: 'running',
    partial: '  Local:   localhost:\x1b[1m4173\x1b[22m/\n',
  }], { cloud: true, cloudHost: '192.0.2.20' });
  assert.equal(cloudService[0].url, 'http://192.0.2.20:4173/');
  assert.equal(cloudService[0].cloud, true);
  assert.equal(cloudService[0].cloudHost, '192.0.2.20');
  const customServer = tools._services([{
    id: 'custom-server', name: 'bash', args: { command: 'node server.js' }, state: 'running',
    partial: 'Server listening on port 4174',
  }]);
  assert.equal(customServer[0].url, 'http://127.0.0.1:4174/');
  assert.equal(customServer[0].unreachable, false);
  const advertisedAddress = tools._services([{
    id: 'advertised-server', name: 'bash', args: { command: 'node server.js' }, state: 'running',
    host: '192.0.2.20', port: 4176,
  }], { cloud: true, cloudHost: '192.0.2.20' });
  assert.equal(advertisedAddress[0].url, 'http://192.0.2.20:4176/');
  const cloudWithoutAddress = tools._services([{
    id: 'cloud-without-address', name: 'bash', args: { command: 'node server.js' }, state: 'running',
    partial: 'Local: http://localhost:4175/',
  }], { cloud: true });
  assert.equal(cloudWithoutAddress[0].url, '');
  assert.equal(cloudWithoutAddress[0].unreachable, true);
  assert.equal(cloudWithoutAddress[0].state, '等待云端地址');
  const selected = tools._latestTurnWebFile([
    { name: 'index.html', path: 'C:/old/index.html', at: 10 },
    { name: 'index.html', path: 'C:/new/index.html', at: 20 },
  ], [{ path: 'C:/new/index.html' }]);
  assert.equal(selected.path, 'C:/new/index.html');
  const shellCreated = tools._latestTurnWebFile([
    { name: 'index.html', artifactId: 'art_shell', kind: 'website', at: 30, changedInTurn: true },
  ], []);
  assert.equal(shellCreated.artifactId, 'art_shell');
  if (oldWindow === undefined) delete global.window; else global.window = oldWindow;
  if (oldIntent === undefined) delete global.WorkIntent; else global.WorkIntent = oldIntent;
  delete global.ChatWorkbench; delete global.ChatTools;
});

test('native preview recreates a reused tab id when the conversation changes', () => {
  const main = read('main', 'work-preview.js');
  assert.match(main, /item\.ref !== nextRef[\s\S]*destroyTab\(owner, id\)[\s\S]*item = null/);
});

test('inline-code filenames become trusted artifact links and web previews use artifact ids', () => {
  const workspace = read('components', 'panels', 'panels-chat-workspace.js');
  const chatTools = read('components', 'panels', 'panels-chat-tools.js');
  const chrome = read('components', 'panels', 'panels-chat-chrome.js');
  const ipc = read('main', 'pi-session', 'ipc.js');
  assert.doesNotMatch(workspace, /closest\('a,button,code,pre/);
  assert.match(workspace, /kind: 'artifact', artifactId: tab\.file\.artifactId/);
  assert.match(chatTools, /file\.changedInTurn/);
  assert.match(chrome, /ChatWorkbench\.openOutput\(hit\.dataset\.chatOpenFile\)/);
  assert.match(ipc, /pi-session-artifact-action/);
  assert.match(ipc, /artifactRuntime\.decorate/);
});

test('deliverables stay out of the message stream and use the shared summary plus workspace', () => {
  const chat = read('components', 'panels', 'panels-chat.js');
  const css = read('components', 'panels', 'panels-chat.css');
  const tools = read('components', 'panels', 'panels-chat-tools.js');
  const chrome = read('components', 'panels', 'panels-chat-chrome.js');
  const workspace = read('components', 'panels', 'panels-chat-workspace.js');
  assert.doesNotMatch(chat, /ConversationDeliverables\.(?:render|html)/);
  assert.doesNotMatch(chat, /parts\.push\(_artifactRows/);
  assert.doesNotMatch(chat, /function _artifactRows/);
  assert.doesNotMatch(css, /\.nartifacts?\b/);
  assert.match(chat, /ChatWorkbench\.openLink/);
  assert.match(chat, /ChatTools\.linkifyOutputs\(list, ctx\._outs, String\(ctx\._ref/);
  assert.match(chat, /ChatTools\.appendTimeline/);
  assert.match(tools, /function appendTimeline/);
  assert.match(workspace, /function openLink/);
  assert.match(chrome, /summaryHtml/);
  assert.match(chrome, /data-chat-summary-pop/);
  assert.doesNotMatch(workspace, /ConversationDeliverables/);
  assert.match(workspace, /ChatChrome\.workbenchState/);
});

test('streaming conversation keeps tool rows stable instead of replacing the whole list', () => {
  const chat = read('components', 'panels', 'panels-chat.js');
  const renderer = read('components', 'panels', 'chat-message-renderer.js');
  const tools = read('components', 'panels', 'panels-chat-tools.js');
  assert.match(chat, /ChatTools\.patchList\(list, messageHtml, \{ preserveDeco: Boolean\(carriedCards\) \}\)/);
  assert.match(renderer, /ChatDecorateCarry\.reconcile\(list, ctx\._outs, carriedCards, deliverySnapshot\)/);
  assert.match(renderer, /ChatOutputLinks\.decorate\(rawMessageHtml, ctx\._outs, ctx\._ref, deliverySnapshot,/);
  assert.match(renderer, /ctx\._snap\.status !== 'streaming'/);
  assert.doesNotMatch(chat, /\n\s*list\.innerHTML = parts\.join\(''\);/);
  assert.match(chat, /data-tool-node/);
  assert.match(tools, /function patchList\(host, html, opts = \{\}\)/);
  assert.match(tools, /function _syncTool\(current, next\)/);
  assert.match(tools, /function _syncThinking\(current, next\)/);
  assert.match(tools, /function _syncMessage\(current, next, opts = \{\}\)/);
  assert.match(tools, /key\.startsWith\('message:'\)/);
});

test('conversation workspace provides native video elements for inline and side previews', () => {
  const links = read('components', 'panels', 'chat-output-links.js');
  const workspace = read('components', 'panels', 'panels-chat-workspace.js');
  const contract = read('main', 'conversation', 'delivery-contract.js');
  assert.match(links, /function hydrateVideos/);
  assert.match(links, /className = 'noutput-video'/);
  assert.match(workspace, /class="ncw-video"/);
  assert.match(workspace, /controls preload="metadata" playsinline/);
  assert.match(contract, /'\.mp4': 'video'/);
});

test('web preview exposes an isolated element picker for quick chat edits', () => {
  const preload = read('preload.js');
  const workspace = read('components', 'panels', 'panels-chat-workspace.js');
  const chat = read('components', 'panels', 'panels-chat.js');
  const injected = preview._inspectorScript(true, [{ selector: '#hero', index: 1 }]);
  assert.match(preload, /onElementSelected/);
  assert.match(preload, /work-preview-element-selected/);
  assert.match(workspace, /data-wb-inspect/);
  assert.match(workspace, /dispatchElementReference/);
  assert.match(workspace, /dispatchAnnotation/);
  assert.match(workspace, /data-wb-send-annotations/);
  assert.match(workspace, /soduwork-workbench-send-annotations/);
  assert.match(workspace, /元素选择器/);
  assert.match(chat, /browser-element/);
  assert.match(injected, /soduWorkbenchInspectorCleanup/);
  assert.match(injected, /stopImmediatePropagation/);
  assert.match(injected, /__soduwork_workbench_element__:/);
  assert.match(injected, /__soduwork-annotations/);
  assert.match(injected, /className = 'pin'/);
  assert.doesNotMatch(injected, /requestNativeFocus/);
  assert.doesNotMatch(injected, /shadow\.addEventListener\('pointerdown'[\s\S]*send\(\{ action: 'focus' \}\)/);
  assert.match(injected, /function closeEditor\(\)[\s\S]*host\.style\.pointerEvents = 'none'/);
  assert.match(injected, /host\.style\.pointerEvents = 'auto'/);
  assert.match(injected, /area\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(injected, /function focusEditorField/);
  assert.doesNotMatch(injected, /focusRecoveryTimer/);
  assert.doesNotMatch(injected, /setTimeout\(restoreEditorFocus/);
  assert.match(injected, /function isOverlay\(event\)[\s\S]*event\.target === host/);
  assert.doesNotMatch(injected, /window\.focus\(\)/);
  const workPreview = read('main', 'work-preview.js');
  assert.doesNotMatch(workPreview, /owner\.host && typeof owner\.host\.focus === 'function'/);
  assert.doesNotMatch(workPreview, /focusOnWebView\(\)/);
  assert.doesNotMatch(workPreview, /payload\.action === 'focus'/);
  assert.doesNotMatch(workPreview, /setTimeout\(\(\) => focus\(false\)/);
});

test('web annotations stay scoped, editable, and are consumed only after send succeeds', async () => {
  const annotations = require('../components/panels/chat-workbench-annotations');
  const store = annotations.createStore();
  const first = store.upsert('session-a', { selector: '#hero', url: 'http://fixture/a', comment: '改成绿色' });
  assert.equal(store.list('session-a').length, 1);
  assert.equal(store.list('session-b').length, 0);
  assert.match(annotations.format(store.list('session-a')), /改成绿色/);
  store.upsert('session-a', { ...first, comment: '改成蓝色' });
  assert.equal(store.list('session-a')[0].comment, '改成蓝色');
  store.consume('session-a', store.list('session-a'));
  assert.equal(store.list('session-a').length, 0);
  assert.equal(store.list('session-b').length, 0);
});

test('annotation sends share the composer pipeline and keep failed batches', () => {
  const chat = read('components', 'panels', 'panels-chat.js');
  const desk = read('desk.html');
  assert.match(desk, /chat-workbench-annotations\.js/);
  assert.match(chat, /ChatWorkbenchAnnotations\.submit/);
  assert.match(chat, /_sendCore\(null, \{ annotationBatch: batch \}/);
  assert.match(read('components', 'panels', 'chat-workbench-annotations.js'), /if \(accepted\) store\.consume/);
});

test('workbench keeps files and browser references one shortcut away from the composer', () => {
  const workspace = read('components', 'panels', 'panels-chat-workspace.js');
  const chat = read('components', 'panels', 'panels-chat.js');
  const css = read('components', 'panels', 'panels-chat.css');
  assert.match(workspace, /data-wb-files/);
  assert.match(workspace, /data-wb-reference/);
  assert.match(workspace, /data-wb-copy-location/);
  assert.match(workspace, /event\.key === 'Tab'/);
  assert.match(workspace, /Ctrl\+Shift\+O/);
  assert.match(workspace, /event\.key\.toLowerCase\(\) === 'l'/);
  assert.match(chat, /soduwork-workbench-reference/);
  assert.match(chat, /网页已引用到对话输入框/);
  assert.match(css, /\.ncw-files/);
  assert.match(css, /\.ncw-file-row/);
});

test('modal dialogs park the native preview view instead of losing the z-order fight', () => {
  const wp = read('main', 'work-preview.js');
  assert.match(wp, /work-preview-suppress/);
  assert.match(wp, /work-preview-occlusion/);
  const caps = read('components', 'panels', 'panels-capabilities.js');
  assert.match(caps, /suppressWorkPreview\?\.\(true\)/);
  assert.match(caps, /suppressWorkPreview\?\.\(false\)/);
  assert.match(read('preload.js'), /suppressWorkPreview: \(hidden\) =>/);
});
