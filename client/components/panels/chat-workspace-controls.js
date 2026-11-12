/* Renderer behavior extracted without copying its owner's state. */
(function (global) {
  'use strict';
  function create(ctx) {
function loadText(tab) {
    const file = tab.file;
    if (file.readSnapshot) {
      ctx.WB.previewRequest = null; ctx.WB.previewKey = 'tool-read:' + fileKey(file);
      ctx.WB.previewLoading = false; ctx.WB.previewError = '';
      ctx.WB.previewText = file.readSnapshot.text; ctx.WB.previewTooBig = Boolean(file.readSnapshot.truncated);
      return;
    }
    const key = ctx.workScope() + ':' + ctx.artifactKey(file) + ':' + (file.at || 0);
    if (ctx.WB.previewKey === key) return;
    const token = {}, ownsPreview = ctx.previewOwner();
    ctx.WB.previewRequest = token;
    ctx.WB.previewKey = key; ctx.WB.previewLoading = true; ctx.WB.previewText = ''; ctx.WB.previewError = ''; ctx.WB.previewTooBig = false;
    const api = ctx.sessionApi();
    const request = ctx.links.readPreview(file, api, ctx.context().ref, tab.kind === 'image' ? 'image-full' : tab.kind === 'video' ? 'preview' : 'read');
    Promise.resolve(request).then((got) => {
      if (!ownsPreview() || ctx.WB.previewKey !== key || ctx.WB.previewRequest !== token) return;
      if (!got || got.ok === false) ctx.WB.previewError = (got && got.reason) || '这份文件暂时读不出来';
      else {
        if (absolutePath(got.path) && !file.taskId && !file.attachmentId && !file.cloudPending)
          tab.resolvedLocation = { path: got.path, key: locationKey(file), ownsPreview };
        ctx.WB.previewText = tab.kind === 'image' ? ctx.links.imageUrl(got) : tab.kind === 'video' ? ctx.links.videoUrl(got) : got.text || '';
        ctx.WB.previewTooBig = Boolean(got.tooBig);
        if (tab.kind === 'image' && !ctx.WB.previewText) ctx.WB.previewError = '图片暂时无法预览';
        if (tab.kind === 'video' && !ctx.WB.previewText) ctx.WB.previewError = '视频暂时无法预览';
      }
    }).catch((error) => { if (ownsPreview() && ctx.WB.previewKey === key && ctx.WB.previewRequest === token) ctx.WB.previewError = String(error && error.message || error); })
      .finally(() => {
        if (ownsPreview() && ctx.WB.previewKey === key && ctx.WB.previewRequest === token) { ctx.WB.previewLoading = false; if (ctx.WB.active === tab.id) ctx.paint(); }
      });
  }

function absolutePath(value) { return /^(?:[a-z]:[\\/]|\/)/i.test(String(value || '')); }
function locationKey(file) { return JSON.stringify([fileKey(file), file?.at, file?.size]); }
function fileLocation(tab) {
    if (absolutePath(tab?.file?.path)) return tab.file.path;
    if (tab?.file?.taskId || tab?.file?.attachmentId || tab?.file?.cloudPending) return '';
    const resolved = tab?.resolvedLocation;
    return resolved?.ownsPreview() && resolved.key === locationKey(tab.file) ? resolved.path : '';
  }

function normalizedPath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  }

function inputPath(value) {
    const path = String(value || '').replace(/\\/g, '/');
    return /^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path;
  }

function matchesInput(file, input) {
    // Public artifacts deliberately omit absolute paths. Resolve their trusted
    // workspace-relative name against this conversation, never by basename.
    const root = ctx.context().cwd || ctx.context().intent?.cwd || ctx.WB.fileChanges?.cwd;
    const path = file.path || (root && file.relative ? String(root).replace(/[\\/]$/, '') + '/' + file.relative : '');
    return Boolean(path && inputPath(path) === inputPath(input.path));
  }

function fileChangeFor(file) {
    if (!file || file.readSnapshot) return null;
    if (file.change && typeof file.change === 'object') return file.change;
    const changes = ctx.WB.fileChanges && Array.isArray(ctx.WB.fileChanges.files) ? ctx.WB.fileChanges.files : [];
    return changes.find(change => ctx.links.workspaceFileTarget(change.path, [file],
      ctx.context().cwd || ctx.WB.fileChanges?.cwd || ctx.context().intent?.cwd)) || null;
  }

function fileKey(file) {
    if (file?.readSnapshot) return 'tool-read:' + file.readSnapshot.id;
    return ctx.artifactKey(file) || normalizedPath(file && file.relative) || normalizedPath(file && file.path) || String(file && file.name || '');
  }

// A journal file or an obsolete artifact ID can precede its current index. Only promote an
// ordinary file in this chat by its exact trusted workspace path; never merge
// snapshots, inputs, remote attachments, ambiguous paths or basename matches.
function promoteFileTab(tab, files) {
    const ordinary = file => file && !file.taskId && !file.attachmentId && !file.cloudPending && !file.readSnapshot;
    const previous = tab.file, scope = ctx.workScope();
    const root = ctx.context().cwd || ctx.context().intent?.cwd || ctx.WB.fileChanges?.cwd;
    if (!ctx.context().ref || !root || tab.inputFile || !ordinary(previous) ||
        (previous.artifactId && files.some(file => file.artifactId === previous.artifactId)) ||
        tab.key !== 'file:' + scope + ':' + fileKey(previous)) return null;
    const next = ctx.links.workspaceFileTarget(previous.path || previous.relative,
      files.filter(file => ordinary(file) && file.artifactId && (file.path || file.relative)), root);
    if (!next || ctx.WB.tabs.some(other => other !== tab && other.key === 'file:' + scope + ':' + fileKey(next))) return null;
    const oldId = fileKey(previous), newId = fileKey(next);
    const changed = previous.at !== next.at || previous.size !== next.size;
    if (ctx.activeTab() === tab) {
      const editor = ctx.WB.editor?.instance;
      tab.identityView = {
        scroll: ['.ncw-body', '.ncw-markdown', '.ncw-code', '.ncw-diff-body', '.ncw-image'].map(selector => {
          const node = ctx.WB.root?.querySelector(selector);
          return node ? { selector, top: node.scrollTop, left: node.scrollLeft } : null;
        }).filter(Boolean),
        editor: editor ? { scroll: editor.getScrollInfo?.() || { left: editor.scrollLeft, top: editor.scrollTop },
          selections: editor.listSelections?.(), selection: typeof editor.selectionStart === 'number'
            ? [editor.selectionStart, editor.selectionEnd, editor.selectionDirection] : null,
          history: editor.getHistory?.(), focused: editor.hasFocus?.() ?? global.document.activeElement === editor,
          saveEnabled: ctx.WB.root?.querySelector('[data-wb-code-save]')?.disabled === false } : null,
      };
      destroyEditor();
    }
    if (Object.prototype.hasOwnProperty.call(ctx.WB.editorDrafts, oldId)) {
      ctx.WB.editorDrafts[newId] = ctx.WB.editorDrafts[oldId]; delete ctx.WB.editorDrafts[oldId];
    }
    const oldPreviewKey = scope + ':' + ctx.artifactKey(previous) + ':' + (previous.at || 0);
    if (ctx.WB.previewKey === oldPreviewKey) {
      // Completed unchanged bytes remain usable. In-flight local reads lose
      // their token so they cannot replace the later artifact response.
      ctx.WB.previewRequest = null;
      ctx.WB.previewKey = !changed && !ctx.WB.previewLoading && !ctx.WB.previewError
        ? scope + ':' + ctx.artifactKey(next) + ':' + (next.at || 0) : '';
      ctx.WB.previewLoading = false;
    }
    if (ctx.WB.autoPreviewKey === scope + ':artifact:' + ctx.artifactKey(previous))
      ctx.WB.autoPreviewKey = scope + ':artifact:' + ctx.artifactKey(next);
    tab.file = next; tab.key = 'file:' + scope + ':' + newId;
    if (changed) { tab.nativeReady = false; tab.reloadNative = true; }
    return next;
  }

function restoreFileView(tab) {
    const saved = tab?.identityView;
    if (!saved || ctx.activeTab() !== tab || ctx.WB.previewLoading || ctx.WB.previewError) return;
    if (saved.editor && tab.view === 'code') {
      const editor = ctx.WB.editor?.instance;
      if (!editor) return;
      if (saved.editor.history) editor.setHistory?.(saved.editor.history);
      if (saved.editor.selections) editor.setSelections?.(saved.editor.selections);
      if (saved.editor.focused) editor.focus?.();
      if (saved.editor.selection) editor.setSelectionRange?.(...saved.editor.selection);
      if (saved.editor.scroll) editor.scrollTo?.(saved.editor.scroll.left, saved.editor.scroll.top);
      const save = ctx.WB.root?.querySelector('[data-wb-code-save]');
      if (save && saved.editor.saveEnabled && canEditFile(tab.file)) save.disabled = false;
    }
    saved.scroll.forEach(({ selector, top, left }) => {
      const node = ctx.WB.root?.querySelector(selector);
      if (node) { node.scrollTop = top; node.scrollLeft = left; }
    });
    delete tab.identityView;
  }

function canEditFile(file) {
    return Boolean(file && !file.readSnapshot && !file.taskId && (file.path || file.relative));
  }

function isCodeFile(file) {
    const kind = ctx.previewKind(file);
    if (kind === 'text') return true;
    const name = String(file && (file.name || file.path) || '').toLowerCase();
    return /\.(?:js|jsx|ts|tsx|mjs|cjs|py|html?|svg|css|scss|ya?ml|json|toml|ini|sh|bash|sql|go|rs|java|kt|swift|rb|php|c|h|cpp|hpp)$/i.test(name);
  }

function isEditorFile(file) {
    return Boolean(file?.readSnapshot) || isCodeFile(file) || Boolean(fileChangeFor(file));
  }

function codeMode(file) {
    const name = String(file && (file.name || file.path) || '').toLowerCase();
    if (/\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(name)) return 'javascript';
    if (/\.(?:py)$/.test(name)) return 'python';
    if (/\.(?:html?|svg)$/.test(name)) return 'xml';
    if (/\.(?:css|scss)$/.test(name)) return 'css';
    if (/\.(?:ya?ml)$/.test(name)) return 'yaml';
    if (/\.(?:md|markdown)$/.test(name)) return 'markdown';
    return 'text/plain';
  }

function destroyEditor() {
    if (!ctx.WB.editor) return;
    try {
      if (ctx.WB.editor.instance && typeof ctx.WB.editor.instance.getValue === 'function') {
        ctx.WB.editorDrafts[ctx.WB.editor.id] = ctx.WB.editor.instance.getValue();
      }
      if (typeof ctx.WB.editor.instance.toTextArea === 'function') ctx.WB.editor.instance.toTextArea();
    } catch (_) { /* a replaced tab may already have detached the editor */ }
    ctx.WB.editor = null;
  }

function editorSource(file) {
    if (file?.readSnapshot) return file.readSnapshot.text;
    const id = fileKey(file);
    if (Object.prototype.hasOwnProperty.call(ctx.WB.editorDrafts, id)) return ctx.WB.editorDrafts[id];
    const change = fileChangeFor(file);
    if (change && change.after && typeof change.after.text === 'string') return change.after.text;
    return ctx.WB.previewText || '';
  }

function mountEditor(tab) {
    if (!tab || ctx.activeTab() !== tab || !isEditorFile(tab.file) || tab.view !== 'code' || ctx.WB.previewLoading || ctx.WB.previewError) return;
    const host = ctx.WB.root && ctx.WB.root.querySelector('[data-code-editor]');
    if (!host) return;
    const textarea = host.querySelector('textarea');
    if (!textarea) return;
    const file = tab.file;
    const id = fileKey(file);
    const initial = editorSource(file);
    textarea.value = initial;
    if (global.CodeMirror && typeof global.CodeMirror.fromTextArea === 'function') {
      const instance = global.CodeMirror.fromTextArea(textarea, {
        lineNumbers: true, mode: codeMode(file), readOnly: canEditFile(file) ? false : 'nocursor',
        lineWrapping: false, tabSize: 2, indentUnit: 2,
        viewportMargin: 80, autofocus: false,
      });
      instance.on('change', () => {
        ctx.WB.editorDrafts[id] = instance.getValue();
        ctx.WB.editorDirty = true;
        const save = ctx.WB.root?.querySelector('[data-wb-code-save]');
        if (save) save.disabled = false;
      });
      ctx.WB.editor = { id, instance };
    } else {
      textarea.className = 'ncw-editor-fallback';
      textarea.readOnly = !canEditFile(file);
      textarea.addEventListener('input', () => { ctx.WB.editorDrafts[id] = textarea.value; ctx.WB.editorDirty = true; });
      ctx.WB.editor = { id, instance: textarea };
    }
    restoreFileView(tab);
  }

function diffTexts(file) {
    const change = fileChangeFor(file);
    if (!change) return null;
    const before = change.before && typeof change.before.text === 'string' ? change.before.text : '';
    const after = change.after && typeof change.after.text === 'string' ? change.after.text : editorSource(file);
    if (change.before && change.before.textTruncated || change.after && change.after.textTruncated) return { unavailable: true };
    return { before, after, action: change.action || 'modified' };
  }

function mergeFileChanges(files, changeSet) {
    const current = Array.isArray(files) ? files.map(file => ({ ...file })) : [];
    const changes = Array.isArray(changeSet?.files) ? changeSet.files : [];
    const byPath = (value) => normalizedPath(value);
    changes.forEach(change => {
      const target = byPath(change.path);
      let file = ctx.links.workspaceFileTarget(change.path, current, changeSet.cwd);
      if (!file && change.action !== 'deleted' && target) {
        const name = target.split('/').pop() || target;
        const after = change.after || {};
        const root = String(changeSet.cwd || '').replace(/\\/g, '/').replace(/\/$/, '');
        const absolute = /^(?:[A-Za-z]:[\\/]|\/)/.test(change.path) ? change.path : root ? root + '/' + target : target;
        file = { name, relative: target, path: absolute, size: Number(after.size) || 0,
          at: Number(after.mtimeMs) || Date.now(), kind: 'file', changedInTurn: true,
          primary: true, change };
        current.push(file);
      }
      if (!file && change.action === 'deleted' && target) {
        const name = target.split('/').pop() || target;
        file = { name, relative: target, path: '', size: 0, at: Number(change.after?.mtimeMs || change.before?.mtimeMs || 0),
          kind: 'file', deleted: true, change };
        current.push(file);
      }
      if (file) { file.change = change; file.syntheticChange = false; file.changedInTurn = true; }
    });
    return current;
  }

function codeModeToolbar(tab, libraryButton) {
    if (tab.file?.readSnapshot) return '<div class="ncw-code-modebar" data-read-snapshot>' +
      '<span data-user-content>' + ctx.esc(tab.label) + '</span><span>读取时快照</span>' +
      (tab.kind === 'image' ? '' : '<button type="button" data-wb-code-copy title="复制读取时快照">复制</button>') + '</div>';
    const change = fileChangeFor(tab.file);
    const diff = change ? '<button type="button" data-wb-code-view="diff" aria-pressed="' + (tab.view === 'diff') + '">' +
      '<span aria-hidden="true">↔</span><span>Diff</span></button>' : '';
      return ctx.info.documentToolbar(tab, libraryButton, false, fileLocation(tab)) + '<div class="ncw-code-modebar" role="toolbar" aria-label="代码查看方式">' +
      '<button type="button" data-wb-code-view="code" aria-pressed="' + (tab.view !== 'diff') + '">源码</button>' + diff +
      '<button type="button" data-wb-code-copy title="复制当前文件">复制</button>' +
      '<button type="button" data-wb-code-save disabled' + (canEditFile(tab.file) ? '' : ' hidden') + ' title="保存到当前工作区">保存</button></div>';
  }

function codeEditorBody(tab) {
    return '<div class="ncw-code-surface"><div class="ncw-code-editor" data-code-editor>' +
      '<textarea aria-label="' + ctx.esc(tab.label) + ' 源码" spellcheck="false"></textarea></div></div>';
  }

function diffBody(tab) {
    const data = diffTexts(tab.file);
    if (!data) return '<div class="ncw-diff-empty">这份文件还没有可比较的变更记录。</div>';
    if (data.unavailable) return '<div class="ncw-diff-empty">文件较大或为二进制文件，暂不生成文本 Diff。</div>';
    const D = global.Diff;
    const H = global.Diff2Html;
    let body = '';
    if (D && D.createTwoFilesPatch && H && H.html) {
      const patch = D.createTwoFilesPatch(tab.label, tab.label, data.before, data.after, '', '', { context: 3 });
      body = H.html(patch, { drawFileList: false, outputFormat: 'line-by-line', matching: 'lines', renderNothingWhenEmpty: false });
    } else if (global.ChatTools?.diffHtml) body = global.ChatTools.diffHtml(data.before, data.after, tab.label);
    else body = '<pre class="ncw-diff-raw">' + ctx.esc(data.after) + '</pre>';
    const add = data.action === 'created' ? 1 : data.after.split('\n').length;
    const del = data.action === 'deleted' ? 1 : data.before.split('\n').length;
    return '<div class="ncw-diff-surface"><div class="ncw-diff-summary"><b>' + ctx.esc(tab.label) + '</b>' +
      '<span class="ncw-change-badge">' + ctx.esc(data.action === 'created' ? '新增' : data.action === 'deleted' ? '删除' : '修改') + '</span>' +
      '<span class="add">+' + add + '</span><span class="del">-' + del + '</span></div>' +
      '<div class="ncw-diff-body">' + body + '</div></div>';
  }

function tabBody(tab) {
    if (!tab) return '';
    if (tab.kind === 'files') return ctx.filesHtml();
    if (tab.kind === 'browser' && tab.mediaType) {
      const media = tab.mediaType === 'video'
        ? '<video src="' + ctx.esc(tab.url) + '" controls playsinline preload="metadata" referrerpolicy="no-referrer"></video>'
        : '<img src="' + ctx.esc(tab.url) + '" alt="" referrerpolicy="no-referrer">';
      return ctx.info.mediaToolbar(tab) + '<div class="ncw-' + (tab.mediaType === 'video' ? 'video' : 'image') +
        ' ncw-remote-media" data-wb-remote-media data-media-state="loading">' + media +
        '<div class="ncw-image-error" data-wb-media-error hidden><span>媒体加载失败</span><button type="button" data-wb-media-retry>重新加载</button></div></div>';
    }
    if (tab.kind === 'service' || tab.kind === 'browser' || tab.kind === 'web' || tab.kind === 'pdf') return ctx.browserHtml(tab);
    if (tab.kind === 'image') {
      if (tab.file?.readSnapshot) {
        const snapshot = tab.file.readSnapshot, images = snapshot.imageUrls || [];
        const notice = snapshot.imagesTruncated ? '<div class="ncw-truncated" role="status">仅显示本次工具返回的部分内容。</div>' : '';
        if (snapshot.loading || snapshot.evicted) return codeModeToolbar(tab) +
          (snapshot.error ? '<div class="ncw-image-error"><span>图片暂时无法预览</span><button type="button" data-wb-read-image-retry>重新加载</button></div>' :
            '<div class="ncw-loading" role="status"><span></span>正在读取图片…</div>');
        return codeModeToolbar(tab) + notice + '<div class="ncw-image ncw-read-images" data-read-image-snapshot>' +
          (images.length ? images.map((src, index) => '<div class="ncw-read-image" data-read-image-index="' + index + '">' +
            (snapshot.failedImages?.has(index) ? '' : '<img loading="lazy" data-user-attributes="alt" src="' + ctx.esc(src) + '" alt="' + ctx.esc(tab.file.name) + '">') +
            '<span class="ncw-image-error" data-read-image-error' + (snapshot.failedImages?.has(index) ? '' : ' hidden') + '>图片暂时无法预览</span></div>').join('') :
            '<span class="ncw-image-error">图片暂时无法预览</span>') + '</div>';
      }
      loadText(tab);
      return ctx.info.documentToolbar(tab, ctx.libraryUploadButton(tab.file), ctx.WB.previewLoading || ctx.WB.previewError, fileLocation(tab)) + '<div class="ncw-image">' +
        (ctx.WB.previewLoading ? '正在读取图片…' : ctx.WB.previewError ? '<div class="ncw-image-error"><span>' + ctx.esc(ctx.WB.previewError) +
          '</span><button type="button" data-wb-image-retry>重新加载</button></div>' :
          '<img data-user-attributes="alt" src="' + ctx.esc(ctx.WB.previewText) + '" alt="' + ctx.esc(tab.file.name) + '">') + '</div>';
    }
    if (tab.kind === 'video') {
      loadText(tab);
      return ctx.info.documentToolbar(tab, ctx.libraryUploadButton(tab.file), false, fileLocation(tab)) + '<div class="ncw-video">' +
        (ctx.WB.previewLoading ? '<div class="ncw-loading"><span></span>正在准备视频…</div>' : ctx.WB.previewError ? '<div class="ncw-image-error"><span>' + ctx.esc(ctx.WB.previewError) +
          '</span><button type="button" data-wb-video-retry>重新加载</button></div>' :
          '<video src="' + ctx.esc(ctx.WB.previewText) + '" controls preload="metadata" playsinline aria-label="播放视频：' + ctx.esc(tab.file.name) + '"></video>') + '</div>';
    }
    if (tab.kind === 'markdown' || tab.kind === 'text') {
      const change = fileChangeFor(tab.file);
      const hasInlineChangeText = tab.view === 'code' && typeof change?.after?.text === 'string';
      // Created/changed files already carry bounded text in the change journal;
      // render that immediately instead of waiting for a second filesystem read.
      if (tab.view !== 'diff' && !hasInlineChangeText) loadText(tab);
      const body = tab.view === 'diff' ? diffBody(tab)
        : ctx.WB.previewLoading ? '<div class="ncw-loading"><span></span>正在准备预览…</div>'
        : ctx.WB.previewError ? '<div class="ncw-preview-error">' + ctx.esc(ctx.WB.previewError) + '</div>'
        : tab.view === 'code' || tab.kind === 'text' ? codeEditorBody(tab)
        : ctx.markdown(ctx.WB.previewText);
      return (isEditorFile(tab.file) ? codeModeToolbar(tab, ctx.libraryUploadButton(tab.file)) : ctx.info.documentToolbar(tab, ctx.libraryUploadButton(tab.file), false, fileLocation(tab))) +
        (ctx.WB.previewTooBig ? '<div class="ncw-truncated" role="status">' + (tab.file?.readSnapshot ?
          '仅显示本次工具返回的部分内容。' : '文件较大，仅预览前 2 MB；完整内容可在原生应用中打开。') + '</div>' : '') + body;
    }
    return '<div class="ncw-external">' + ctx.ICONS.file + "<b data-user-content>" + ctx.esc(tab.label) + '</b>' + ctx.libraryUploadButton(tab.file) + '<span>这类文件由系统原生应用呈现更可靠。</span><button type="button" data-wb-reference>引用到对话</button>' +
      '<button data-wb-file-open="' + ctx.esc(fileKey(tab.file)) + '">打开文件</button></div>';
  }

async function copyText(value, button) {
    let ok = false;
    try { await global.navigator.clipboard.writeText(value); ok = true; } catch (_) { /* Fallback for file:// URLs. */ }
    if (!ok) {
      const area = global.document.createElement('textarea');
      area.value = value; area.style.position = 'fixed'; area.style.opacity = '0';
      global.document.body.appendChild(area); area.select();
      try { ok = global.document.execCommand('copy'); } catch (_) { /* ignore */ }
      area.remove();
    }
    if (button && ok) {
      ctx.info.copied(button, button.closest('.ncw-browserbar') ? '复制页面地址' : '复制文件位置', ctx.ICONS.copy);
    }
  }

async function copyLocation(tab, button) {
    if (!tab) return;
    const file = tab.file, active = ctx.activeTab(), scope = ctx.workScope(), ownsPreview = ctx.previewOwner();
    const ref = ctx.context().ref, token = {};
    ctx.WB.locationRequest = token;
    let location = ctx.locationFor(tab);
    const absolute = absolutePath;
    if (file && !absolute(location) && !/^https?:\/\//i.test(location)) {
      // Public artifact metadata omits absolute paths. Ask the existing
      // workspace-authorized resolver; remote files do not imply local bytes.
      if (!file.artifactId || file.taskId || file.attachmentId || file.cloudPending) return;
      const key = fileKey(file), at = file.at, size = file.size;
      try {
        const result = await ctx.sessionApi()?.artifactAction?.(ref, file.artifactId, 'location');
        const current = tab === active ? tab.file : ctx.WB.files.find(item => fileKey(item) === key);
        if (!ownsPreview() || ctx.WB.locationRequest !== token || ctx.workScope() !== scope || ctx.context().ref !== ref ||
            ctx.activeTab() !== active || !current || fileKey(current) !== key || current.at !== at || current.size !== size) return;
        if (!result?.ok || !absolute(result.path)) return;
        location = result.path;
      } catch (_) { return; }
    }
    if (location) await copyText(location, button);
  }

function closeTab(id) {
    const tab = ctx.tabById(id);
    if (!tab) return;
    tab.dispose?.();
    const api = ctx.nativeApi();
    if (api) api.destroy(tab.id);
    delete ctx.WB.states[tab.id];
    ctx.WB.tabs = ctx.WB.tabs.filter((item) => item.id !== tab.id);
    if (ctx.WB.active === tab.id) ctx.WB.active = ctx.WB.tabs.length ? ctx.WB.tabs[ctx.WB.tabs.length - 1].id : '';
    if (!ctx.WB.tabs.length) { ctx.WB.open = false; ctx.WB.maximized = false; ctx.WB.manualClosed = true; }
    ctx.paint();
  }

function cycleTab(step) {
    if (!ctx.WB.tabs.length) return;
    const index = Math.max(0, ctx.WB.tabs.findIndex((tab) => tab.id === ctx.WB.active));
    const next = (index + step + ctx.WB.tabs.length) % ctx.WB.tabs.length;
    ctx.WB.active = ctx.WB.tabs[next].id; ctx.WB.tabs[next].autoPreview = false; ctx.WB.open = true; ctx.WB.manualClosed = false; ctx.paint();
  }

function focusAddress() {
    const input = ctx.WB.root && ctx.WB.root.querySelector('[data-wb-address]');
    if (!input || input.readOnly) return false;
    input.focus(); input.select(); return true;
  }

function bindWorkbench(root, getContext) {
    ctx.WB.root = root; ctx.WB.context = getContext; ctx.ensure(root);
    if (root.dataset.ncwBound) return;
    root.dataset.ncwBound = '1';
    const api = ctx.nativeApi();
    if (api && api.onState) ctx.WB.unlisten = api.onState(ctx.receiveNativeState);
    if (api && api.onElementSelected) {
      ctx.WB.unlistenElement = api.onElementSelected((payload) => {
        const tab = ctx.tabById(payload && payload.tabId);
        if (!tab) return;
        const state = ctx.stateFor(tab);
        if (state.inspectMode === 'annotate') {
          ctx.dispatchAnnotation(tab, payload);
          return;
        }
        ctx.dispatchElementReference(tab, payload);
        if (typeof api.inspect === 'function') api.inspect(tab.id, false).then((result) => {
          if (result && result.state) ctx.receiveNativeState(result.state);
        }).catch(() => {});
        if (typeof global.petSay === 'function') global.petSay('已引用网页元素，请补充修改要求后发送');
      });
    }
    root.addEventListener('click', (event) => {
      const link = event.target.closest('.ncw-markdown a');
      if (link) { event.preventDefault(); ctx.openLink(link.getAttribute('data-output-href') || link.getAttribute('href')); return; }
      const hit = event.target.closest('[data-wb-open],[data-wb-close],[data-wb-maximize],[data-wb-tab],[data-wb-tab-close],[data-wb-new],' +
        '[data-wb-file],[data-wb-service],[data-wb-tool],[data-wb-copy],[data-wb-file-open],[data-wb-nav],' +
        '[data-wb-code-view],[data-wb-code-copy],[data-wb-code-save],' +
        '[data-output-image],[data-output-video],[data-wb-image-copy],[data-wb-image-retry],[data-wb-video-retry],[data-wb-media-retry],[data-wb-read-image-retry],' +
        '[data-wb-files],[data-wb-reference],[data-wb-inspect],[data-wb-send-annotations],[data-wb-copy-location],[data-wb-reference-file],[data-wb-copy-file],[data-wb-library-upload]');
      if (!hit) return;
      if (hit.hasAttribute('data-wb-maximize')) { ctx.maximizeWorkbench(); return; }
      if (hit.hasAttribute('data-output-video')) {
        ctx.openOutput(hit.dataset.outputVideo);
        if (hit.dataset.videoState === 'error') {
          delete hit.dataset.videoState;
          ctx.links.hydrateVideos(root, ctx.WB.files, { ref: ctx.context().ref, api: ctx.sessionApi() });
        }
        return;
      }
      if (hit.hasAttribute('data-output-image')) {
        ctx.openOutput(hit.dataset.outputImage);
        if (hit.dataset.imageState === 'error') {
          delete hit.dataset.imageState;
          ctx.links.hydrateImages(root, ctx.WB.files, { ref: ctx.context().ref, api: ctx.sessionApi() });
        }
        return;
      }
      if (hit.hasAttribute('data-wb-read-image-retry')) {
        if (ctx.restoreReadImageSnapshot(ctx.activeTab(), true)) ctx.paint();
        return;
      }
      if (hit.hasAttribute('data-wb-image-retry') || hit.hasAttribute('data-wb-video-retry')) { ctx.WB.previewKey = ''; ctx.paint(); return; }
      if (hit.hasAttribute('data-wb-image-copy')) {
        const file = ctx.WB.files.find(item => ctx.artifactKey(item) === hit.dataset.wbImageCopy);
        if (!file || hit.disabled) return;
        const copyContext = { ref: ctx.context().ref, api: ctx.sessionApi() };
        hit.disabled = true; ctx.info.buttonStatus(hit, '正在复制…', ctx.ICONS.image);
        Promise.resolve().then(() => global.ConversationAttachments.copyOutputImage(file, copyContext))
          .then(result => { if (result && result.ok === false) throw Error(result.reason || '复制失败'); ctx.info.copied(hit, '复制图片', ctx.ICONS.image); })
          .catch(error => { ctx.info.buttonStatus(hit, '重试复制', ctx.ICONS.image); if (typeof global.petSay === 'function') global.petSay(error.message || '复制失败'); })
          .finally(() => { hit.disabled = false; });
        return;
      }
      if (hit.hasAttribute('data-wb-code-view')) {
        const tab = ctx.activeTab();
        if (!tab || !isEditorFile(tab.file)) return;
        tab.autoPreview = false;
        tab.view = hit.dataset.wbCodeView === 'diff' ? 'diff' : 'code';
        ctx.WB.manualClosed = false; ctx.paint(); return;
      }
      if (hit.hasAttribute('data-wb-code-copy')) {
        const tab = ctx.activeTab();
        const value = ctx.WB.editor?.instance?.getValue ? ctx.WB.editor.instance.getValue() : editorSource(tab?.file);
        if (value != null) copyText(value, hit);
        return;
      }
      if (hit.hasAttribute('data-wb-code-save')) {
        const tab = ctx.activeTab();
        if (!canEditFile(tab?.file)) return;
        const value = ctx.WB.editor?.instance?.getValue ? ctx.WB.editor.instance.getValue() : editorSource(tab?.file);
        const api = ctx.sessionApi();
        const target = tab?.file?.path || tab?.file?.relative;
        if (!target || !api?.writeOutput || value == null || hit.disabled) return;
        hit.disabled = true;
        Promise.resolve(api.writeOutput(ctx.context().ref, target, value)).then(result => {
          if (!result || result.ok === false) throw Error(result?.reason || '保存失败');
          delete ctx.WB.editorDrafts[fileKey(tab.file)]; ctx.WB.editorDirty = false;
          hit.disabled = true;
          if (typeof global.petSay === 'function') global.petSay('文件已保存');
        }).catch(error => { hit.disabled = false; if (typeof global.petSay === 'function') global.petSay(error.message || '保存失败'); });
        return;
      }
      if (hit.hasAttribute('data-wb-open')) { ctx.WB.open = true; ctx.WB.manualClosed = false; ctx.paint(); return; }
      if (hit.hasAttribute('data-wb-close')) { ctx.WB.open = false; ctx.WB.maximized = false; ctx.WB.manualClosed = true; ctx.paint(); return; }
      if (hit.hasAttribute('data-wb-files')) { if (ctx.openFiles()) ctx.paint(); return; }
      if (hit.hasAttribute('data-wb-tab-close')) { closeTab(hit.dataset.wbTabClose); return; }
      if (hit.hasAttribute('data-wb-tab')) { ctx.WB.active = hit.dataset.wbTab; const tab = ctx.tabById(ctx.WB.active); if (tab) tab.autoPreview = false; ctx.WB.open = true; ctx.paint(); return; }
      if (hit.hasAttribute('data-wb-new')) { ctx.newBrowser(); ctx.paint(); focusAddress(); return; }
      if (hit.hasAttribute('data-wb-file')) {
        const file = ctx.WB.files.find((item) => fileKey(item) === hit.dataset.wbFile || item.path === hit.dataset.wbFile);
        if (file) { const tab = ctx.openFile(file, true); if (tab) tab.autoPreview = false; ctx.paint(); }
        return;
      }
      if (hit.hasAttribute('data-wb-reference-file') || hit.hasAttribute('data-wb-copy-file')) {
        const id = hit.dataset.wbReferenceFile || hit.dataset.wbCopyFile;
        const file = ctx.WB.files.find((item) => fileKey(item) === id || item.path === id);
        const tab = file ? { kind: ctx.previewKind(file), label: file.name, file } : null;
        if (hit.hasAttribute('data-wb-reference-file')) ctx.dispatchReference(tab);
        else void copyLocation(tab, hit);
        return;
      }
      if (hit.hasAttribute('data-wb-library-upload')) {
        const id = hit.dataset.wbLibraryUpload;
        const file = ctx.WB.files.find((item) => fileKey(item) === id || item.path === id);
        if (file && !hit.disabled) void global.LibraryTransfer?.saveOutput(ctx.context().ref, file, hit);
        return;
      }
      if (hit.hasAttribute('data-wb-service')) {
        const service = ctx.WB.services.find((item) => item.id === hit.dataset.wbService);
        if (service && service.url) { const tab = ctx.openService(service, true); tab.autoPreview = false; ctx.paint(); }
        return;
      }
      if (hit.hasAttribute('data-wb-tool')) {
        const target = [...root.querySelectorAll('[data-tool]')].find((node) => node.dataset.tool === hit.dataset.wbTool);
        if (target) { target.click(); target.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        return;
      }
      if (hit.hasAttribute('data-wb-copy')) { copyText(hit.dataset.wbCopy, hit); return; }
      if (hit.hasAttribute('data-wb-reference')) { ctx.dispatchReference(ctx.activeTab()); return; }
      if (hit.hasAttribute('data-wb-send-annotations')) { ctx.sendAnnotations(ctx.activeTab()); return; }
      if (hit.hasAttribute('data-wb-inspect')) {
        const tab = ctx.activeTab(); const preview = ctx.nativeApi();
        if (!tab || !preview || typeof preview.inspect !== 'function') return;
        const enabled = !Boolean(ctx.stateFor(tab).inspectEnabled);
        preview.inspect(tab.id, enabled, {
          mode: 'annotate', annotations: ctx.annotationRows(),
        }).then((result) => {
          if (result && result.state) ctx.receiveNativeState(result.state);
          else {
            ctx.WB.states[tab.id] = { ...(ctx.WB.states[tab.id] || {}), inspectEnabled: enabled };
            ctx.updateNativeChrome();
          }
        }).catch(() => {});
        return;
      }
      if (hit.hasAttribute('data-wb-copy-location')) { void copyLocation(ctx.activeTab(), hit); return; }
      if (hit.hasAttribute('data-wb-media-retry')) {
        const body = root.querySelector('.ncw-body');
        if (body) { delete body.dataset.wbMediaKey; ctx.paint(); }
        return;
      }
      if (hit.hasAttribute('data-wb-file-open')) {
        const file = ctx.WB.files.find((item) => fileKey(item) === hit.dataset.wbFileOpen ||
          item.path === hit.dataset.wbFileOpen);
        if (file) ctx.artifactRequest(ctx.sessionApi(), ctx.context().ref, file, 'open');
        return;
      }
      if (hit.hasAttribute('data-wb-nav')) {
        const tab = ctx.activeTab(); const preview = ctx.nativeApi(); const action = hit.dataset.wbNav;
        if (tab && preview) preview.command(tab.id, action);
      }
    });
    root.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape' && event.target?.matches?.('[data-wb-address]')) {
        event.preventDefault(); event.stopPropagation();
        event.target.setCustomValidity(''); event.target.value = ctx.info.displayAddress(ctx.addressFor(ctx.activeTab()));
        event.target.title = event.target.value;
        event.target.blur(); return;
      }
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier) {
        const editing = event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="dialog"],[role="menu"],[role="listbox"]');
        if (event.key === 'Escape' && ctx.WB.maximized && !event.defaultPrevented && !editing) {
          event.preventDefault(); event.stopPropagation(); ctx.maximizeWorkbench(false);
        }
        return;
      }
      if (event.key === 'Tab') { event.preventDefault(); cycleTab(event.shiftKey ? -1 : 1); return; }
      if (event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault(); if (ctx.openFiles()) ctx.paint(); return;
      }
      if (event.key.toLowerCase() === 'l') { event.preventDefault(); focusAddress(); return; }
      if (!event.shiftKey && /^[1-9]$/.test(event.key)) {
        const tab = ctx.WB.tabs[Number(event.key) - 1];
        if (tab) { event.preventDefault(); ctx.WB.active = tab.id; ctx.WB.open = true; ctx.WB.manualClosed = false; ctx.paint(); }
      }
    });
    root.addEventListener('error', event => {
      if (event.target.closest?.('[data-wb-remote-media]')) return;
      const readImage = event.target.closest?.('[data-read-image-index]');
      if (readImage && root.contains(event.target)) {
        const snapshot = ctx.activeTab()?.file?.readSnapshot;
        if (!snapshot) return;
        (snapshot.failedImages ||= new Set()).add(Number(readImage.dataset.readImageIndex));
        event.target.remove();
        readImage.querySelector('[data-read-image-error]').hidden = false;
        return;
      }
      if (event.target.matches?.('.ncw-image img') && root.contains(event.target)) {
        ctx.WB.previewError = '图片内容无法识别，请重新加载或在原生应用中查看';
        ctx.paint();
      }
      if (event.target.matches?.('.ncw-video video') && root.contains(event.target)) {
        ctx.WB.previewError = '视频编码暂时无法播放，请在原生应用中打开';
        ctx.paint();
      }
    }, true);
    root.addEventListener('input', (event) => {
      // A previous invalid address must not block the next form submission.
      if (event.target.matches?.('[data-wb-address]')) event.target.setCustomValidity('');
    });
    root.addEventListener('submit', (event) => {
      const form = event.target.closest('[data-wb-address-form]');
      if (!form) return;
      event.preventDefault();
      const tab = ctx.activeTab(); const input = form.querySelector('[data-wb-address]');
      if (!tab || !input || input.readOnly) return;
      const currentAddress = ctx.addressFor(tab);
      if (input.value === ctx.info.displayAddress(currentAddress) &&
          (/^file:/i.test(currentAddress) || (tab.file && !/^https?:/i.test(currentAddress)))) {
        input.setCustomValidity('');
        // Keep the HTTP resource origin and artifact ownership when Enter is
        // pressed on the displayed local path.
        const result = ctx.nativeApi()?.command?.(tab.id, 'reload');
        Promise.resolve(result).then(value => { if (value?.state) ctx.receiveNativeState(value.state); }).catch(() => {});
        return;
      }
      const url = ctx.normalizeAddress(input.value === ctx.info.displayAddress(currentAddress) ? currentAddress : input.value);
      if (!url) { input.setCustomValidity('请输入有效的网址'); input.reportValidity(); return; }
      input.setCustomValidity('');
      // Explicit navigation detaches the tab from its original output/service.
      // Otherwise a later output refresh can reopen that file over this page,
      // and the library/reference actions still point to the previous file.
      tab.key = 'browser:' + ctx.workScope() + ':' + tab.id;
      delete tab.file; delete tab.service; delete tab.mediaType;
      tab.kind = 'browser'; tab.url = url; tab.nativeReady = false;
      tab.labelSource = tab.label = new URL(url).hostname;
      ctx.WB.states[tab.id] = { url, displayUrl: '', loading: true };
      ctx.paint();
    });
    ctx.WB.split = ctx.split.bind(root, { hideNative: ctx.hideNative, scheduleNative: ctx.scheduleNative,
      maximize: () => ctx.maximizeWorkbench(true), isMaximized: () => ctx.WB.maximized });
    if (global.ResizeObserver) {
      ctx.WB.observer = new global.ResizeObserver(ctx.scheduleNative);
      ctx.WB.observer.observe(root);
      const body = root.querySelector('.ncw-body');
      if (body) ctx.WB.observer.observe(body);
    }
    if (global.IntersectionObserver) {
      ctx.WB.visibilityObserver = new global.IntersectionObserver((entries) => {
        if (!entries[0] || !entries[0].isIntersecting) ctx.hideNative(); else ctx.scheduleNative();
      });
      ctx.WB.visibilityObserver.observe(root);
    }
  }
  function hydrateRemoteMedia(body) {
    const frame = body.querySelector?.('[data-wb-remote-media]');
    const media = frame?.querySelector('img,video');
    if (!media) return;
    const ready = () => { frame.dataset.mediaState = 'ready'; frame.querySelector('[data-wb-media-error]').hidden = true; };
    const failed = () => { frame.dataset.mediaState = 'error'; frame.querySelector('[data-wb-media-error]').hidden = false; };
    media.addEventListener(media.tagName === 'VIDEO' ? 'loadeddata' : 'load', ready);
    media.addEventListener('error', failed);
    if (media.tagName === 'IMG' && media.complete) { if (media.naturalWidth) ready(); else failed(); }
    if (media.tagName === 'VIDEO' && media.readyState >= 2) ready();
  }
  return { loadText, normalizedPath, inputPath, matchesInput, fileChangeFor, fileKey, fileLocation, promoteFileTab, restoreFileView, canEditFile, isCodeFile, isEditorFile, codeMode, destroyEditor, editorSource, mountEditor, diffTexts, mergeFileChanges, codeModeToolbar, codeEditorBody, diffBody, tabBody, copyText, closeTab, cycleTab, focusAddress, bindWorkbench, hydrateRemoteMedia };
  }
  global.ChatWorkspaceControls = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})(typeof window !== 'undefined' ? window : globalThis);
