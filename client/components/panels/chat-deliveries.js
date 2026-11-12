/* Final-file delivery collection for local and cloud conversations.
 * The task remains authoritative; this card is the single, durable result set
 * that can be previewed, opened locally and saved to the library.
 */
(function (global) {
  'use strict';
  const groups = new Map(), jobs = new Map(), localJobs = new Map(), completed = new Set();
  let inspectTail = Promise.resolve();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const key = file => file && (file.artifactId || file.attachmentId || file.path || file.relative || file.name) || '';
  const scope = () => global.SoduWorkAPI?.taskStorageKey?.('ops') || '';
  const announceLibraryChange = detail => {
    global.dispatchEvent?.(new CustomEvent('soduwork-library-changed', { detail: detail || {} }));
    try { global.soduWorkAPI?.broadcast?.('library', detail || {}); } catch (_) { /* Optional outside the desktop bridge. */ }
  };
  const size = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n ? Math.max(1, Math.round(n / 1024)) + ' KB' : '';
  const totalSize = files => files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  const jobKey = (ref, files) => JSON.stringify([scope(), ref, files.map(f => [key(f), f.at || 0, f.size || 0])]);
  const text = Object.freeze({
    title: '成果', cloud: '\u4e91\u7aef', local: '\u672c\u673a',
    preview: '\u9884\u89c8\u6210\u679c', openWeb: '\u6253\u5f00\u7f51\u9875\u9884\u89c8', file: '\u6587\u4ef6', files: '\u4e2a\u6587\u4ef6',
    preparing: '\u6b63\u5728\u51c6\u5907\u6210\u679c', saved: '\u5df2\u4fdd\u5b58',
    savedCrossDevice: '\u5df2\u540c\u6b65 \u00b7 \u53ef\u8de8\u8bbe\u5907\u67e5\u770b',
    collecting: '\u6b63\u5728\u6536\u96c6', retry: '\u91cd\u8bd5\u540c\u6b65',
    save: '\u4fdd\u5b58\u5230\u8d44\u6599\u5e93', openSaved: '\u9884\u89c8\u5df2\u4fdd\u5b58\u7248\u672c',
    structure: '\u4fdd\u7559\u76ee\u5f55\u7ed3\u6784',
    localSaved: '\u6587\u4ef6\u5728\u672c\u673a \u00b7 \u5df2\u4fdd\u5b58\u5230\u8d44\u6599\u5e93',
    localFiles: '\u6587\u4ef6\u5728\u672c\u673a',
  });
  const folderIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5V5.8c0-.7.6-1.3 1.3-1.3h5l2 2H19c.8 0 1.5.7 1.5 1.5v9.8c0 .9-.7 1.7-1.7 1.7H5.2c-.9 0-1.7-.8-1.7-1.7V7.5Z"/><path d="M3.5 9h17"/></svg>';
  const localIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>';
  const archiveIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M10 4v3h3v3h-3v3h3v4h-3v-4"/></svg>';
  const saveIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 18.25h9a4.25 4.25 0 0 0 .56-8.46A5.75 5.75 0 0 0 6.2 8.5a4.9 4.9 0 0 0 1.3 9.75Z"/><path d="M12 16V9.5m-2.5 2.5L12 9.5l2.5 2.5"/></svg>';
  const savedIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4L19 6"/></svg>';
  const tx = source => global.SoduWorkI18n?.t(source, source) || source;
  const previewIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const action = (attr, label, glyph, hidden = false) => '<button type="button" class="ndelivery-action" ' + attr +
    (hidden ? ' hidden' : '') + ' aria-label="' + esc(label) + '" title="' + esc(label) + '">' + glyph + '<span class="ndelivery-action-label">' + label + '</span></button>';
  function icon(file) {
    return global.SoduWorkLibraryFileIcons?.markup?.({ filename: file.name || file.relative || '', contentType: file.contentType }) ||
      '<span class="ndelivery-extension">' + esc((file.name || '').split('.').pop().toUpperCase().slice(0, 6)) + '</span>';
  }
  function outputRound(message, snapshot) {
    const match = /^message:(\d+)$/.exec(message.dataset.chatNode || '');
    const round = match && snapshot.messages?.[Number(match[1])]?.round;
    return Number.isSafeInteger(round) && round > 0 ? round : 0;
  }
  function groupFiles(files, taskId, ownerRound = 0) {
    let candidates = (files || []).filter(f => (f.taskId || f.cloudTaskId || '') === (taskId || '') && !f.processEvidence && !f.pluginDraft && f.role !== 'evidence' && (taskId ? f.role === 'supporting' || f.primary !== false || f.remoteMaterialized : f.primary !== false));
    if (taskId) {
      const round = ownerRound || Math.max(0, ...candidates.map(f => Number(f.round) || 0));
      candidates = candidates.filter(f => (Number(f.round) || 0) === round).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    }
    /* Attachment filenames are not unique in a multi-file delivery (for
     * example docs/README.md and examples/README.md). Deduplicating task
     * outputs by display name silently dropped one of those results. The
     * opaque artifact/attachment id is the stable identity; the path/name is
     * only a fallback for legacy rows. */
    return [...new Map(candidates.map(f => [taskId
      ? (f.artifactId || f.attachmentId || f.relative || f.name)
      : key(f), f])).values()];
  }
  function artifactUrlFor(value, snapshot) {
    const url = String(value || '').trim();
    // A cloud runner commonly reports localhost:<port>. That address belongs
    // to the runner, not the user's computer. Reuse the target metadata and
    // rewrite only loopback hosts before presenting the preview link.
    if (!/^https?:\/\//i.test(url)) return '';
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) return '';
      const loopback = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::\]|\[::1\])$/i.test(parsed.hostname);
      const target = snapshot?.cloudHandoff?.target || snapshot?.execution?.target || {};
      const cloudHost = String(target.host || target.address || target.runnerHost || '').trim();
      if (loopback && !cloudHost) return '';
      if (loopback && !/^[a-z0-9][a-z0-9._-]{0,252}$/i.test(cloudHost)) return '';
      if (loopback) parsed.hostname = cloudHost;
      return parsed.href.slice(0, 2000);
    } catch (_) { return ''; }
  }
  function appendArtifactUrl(message, url) {
    if (!message || !url || message.querySelector('[data-cloud-artifact-url]')) return;
    const doc = message.ownerDocument, card = doc.createElement('section');
    card.className = 'ndelivery ndelivery-url';
    card.dataset.cloudArtifactUrl = url;
    card.setAttribute('aria-label', text.title);
    card.innerHTML = '<header><span class="ndelivery-icon">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/></svg>' +
      '</span><div class="ndelivery-heading"><small>' + text.title + '</small>' +
       '<button type="button" data-cloud-artifact-url="' + esc(url) + '" title="' + esc(url) + '"><b>' +
       text.openWeb + '</b></button><div class="ndelivery-meta">' + esc(url) + '</div></div></header>' +
       '<footer><span data-delivery-status role="status">点击在右侧打开</span></footer>';
    message.appendChild(card);
  }
  function isSettled(snapshot = {}) {
    const execution = snapshot.execution || {};
    const latestUser = (Array.isArray(snapshot.messages) ? snapshot.messages : []).findLastIndex(message => message?.role === 'user');
    return (!snapshot.status || ['idle', 'completed', 'done'].includes(snapshot.status)) &&
      !snapshot.deliveryPending && !snapshot.pendingUi && !execution.running && !execution.stopped &&
      !execution.limitRequest && !['executing', 'implementing', 'reviewing', 'repairing', 'blocked'].includes(execution.quality?.phase) &&
      !(Array.isArray(snapshot.tools) ? snapshot.tools : []).some(tool => tool?.state === 'running' && (Number(tool.after) || 0) >= latestUser);
  }
  function joinPreviews(message, card) {
    // Evidence remains visible above the delivery without entering its saved files.
    if (!card) return;
    [...message.querySelectorAll('.noutput-image')]
      .filter(node => node.closest('.nmsg.ai,[data-task-stream]') === message && !node.closest('.nacceptance-result'))
      .forEach(node => message.insertBefore(node, card));
  }
  function fileList(doc, rows, originalOf) {
    // Packages stay ahead of their members, including asynchronously inspected manifests.
    const isArchive = file => file.kind === 'archive' || /\.zip$/i.test(String(file.path || file.relative || file.name || ''));
    rows = rows.slice().sort((left, right) => Number(isArchive(right)) - Number(isArchive(left)));
    const container = doc.createElement('div');
    container.setAttribute('data-delivery-file-list', '');
    const list = items => {
      const ul = doc.createElement('ul');
      for (const row of items) {
        const original = originalOf(row), li = doc.createElement('li');
        const link = doc.createElement(original ? 'button' : 'span');
        if (original) { link.type = 'button'; link.dataset.openApp = key(original); }
        else link.className = 'ndelivery-supporting';
        const name = doc.createElement('span'), amount = doc.createElement('small');
        name.setAttribute('data-user-content', '');
        name.textContent = row.relative || row.name || row.path || '';
        amount.textContent = size(row.size);
        link.appendChild(name); link.appendChild(amount); li.appendChild(link); ul.appendChild(li);
      }
      return ul;
    };
    container.appendChild(list(rows.slice(0, 3)));
    if (rows.length > 3) {
      const more = doc.createElement('details'), summary = doc.createElement('summary');
      more.className = 'ndelivery-more';
      for (const [className, label] of [['nfiles-expand-label', '更多'], ['nfiles-collapse-label', '收起']]) {
        const span = doc.createElement('span'); span.className = className; span.textContent = tx(label);
        summary.appendChild(span);
      }
      more.appendChild(summary); more.appendChild(list(rows.slice(3))); container.appendChild(more);
    }
    return container;
  }
  function decorate(root, files, ref, snapshot = {}) {
    if (!root || !ref || !isSettled(snapshot)) return;
    const summaryOnly = snapshot.delivery?.presentation === 'summary' || snapshot.deliveryPresentation === 'summary' ||
      snapshot.deliveryMode === 'git' || snapshot.cloudHandoff?.deliveryMode === 'git';
    const cloudTaskId = String(snapshot.cloudHandoff?.taskId || '');
    const artifactUrl = artifactUrlFor(
      snapshot.artifactUrl || snapshot.cloudHandoff?.artifactUrl || snapshot.execution?.artifactUrl ||
      snapshot.previewUrl || snapshot.execution?.previewUrl || snapshot.execution?.serviceUrl,
      snapshot,
    );
    const used = new Set();
    const priorFiles = new Map();
    root.querySelectorAll('[data-delivery]').forEach(card => {
      const previous = groups.get(card.dataset.delivery);
      if (previous?.ref !== ref || previous.scope !== scope()) return;
      previous.files.forEach(file => priorFiles.set(key(file), { file, revision: previous.receiptRevision || previous.snapshot?.deliverySync?.revision }));
    });
    const alreadyDelivered = file => {
      const previous = priorFiles.get(key(file));
      if (!previous || String(previous.file.at || 0) !== String(file.at || 0) || Number(previous.file.size || 0) !== Number(file.size || 0)) return false;
      const receipt = snapshot.deliverySync;
      return !(receipt?.currentTurn !== false && receipt?.revision && receipt.revision !== previous.revision);
    };
    const messages = [...root.querySelectorAll('.nmsg.ai,[data-task-stream]')].filter(n => n.dataset.deliveryFinal !== 'false').reverse();
    for (const message of messages) {
      if (message.querySelector('.nacceptance-result')) continue;
      const existing = message.querySelector('.ndelivery');
      if (existing && !existing.classList.contains('ndelivery-preview-only')) {
        joinPreviews(message, existing, groups.get(existing.dataset.delivery)); continue;
      }
      if (summaryOnly) { joinPreviews(message, existing); continue; }
      const taskId = cloudTaskId ? (message.dataset.outputTask || message.dataset.taskStream || cloudTaskId) : '';
      if (taskId !== cloudTaskId) { joinPreviews(message, existing); continue; }
      const mentioned = new Set([...message.querySelectorAll('[data-open-app],[data-output-image],[data-output-video]')]
        .map(n => n.dataset.openApp || n.dataset.outputImage || n.dataset.outputVideo).filter(Boolean));
      const latestForTask = message === messages.find(n => (n.dataset.outputTask || n.dataset.taskStream || cloudTaskId) === cloudTaskId);
      // Repository and commit links belong to the summary, not a website card.
      const currentTurn = message.dataset.deliveryCurrent !== 'false';
      if (cloudTaskId && latestForTask && currentTurn && !snapshot.codeDelivery && !/^https?:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)(?:\/|$)/i.test(artifactUrl)) appendArtifactUrl(message, artifactUrl);
      const captured = f => (snapshot.deliverySync?.artifactVersions || []).some(v => v.id === key(f) && String(v.at || 0) === String(f.at || 0) && Number(v.size || 0) === Number(f.size || 0));
      const ownerRound = outputRound(message, snapshot);
      const available = groupFiles(files, taskId, ownerRound).filter(f => !used.has(key(f)) && !alreadyDelivered(f) && (
        (taskId && ownerRound > 0 && Number(f.round) === ownerRound) ||
        mentioned.has(key(f)) ||
        ((currentTurn && snapshot.deliverySync?.currentTurn !== false && (f.changedInTurn || captured(f)) && f.primary !== false && message === messages[0])) ||
        (cloudTaskId && currentTurn && latestForTask && ['output', 'supporting'].includes(f.role || 'output'))));
      if (!available.length || !available.some(f => f.primary !== false && f.role !== 'supporting')) {
        joinPreviews(message, message.querySelector('.ndelivery')); continue;
      }
      available.forEach(f => used.add(key(f)));
      const matchesReceipt = (message === messages[0] || snapshot.deliverySync?.currentTurn === false) && available.every(captured);
      const id = jobKey(ref, available) + (matchesReceipt && snapshot.deliverySync?.revision ? ':' + snapshot.deliverySync.revision : '');
      const old = groups.get(id);
      const rounds = [...new Set(available.map(file => Number(file.round) || 0))];
      const executionRefs = [...new Set(available.map(file => file.sourceRef || ''))];
      const selection = old?.selection || { round: rounds.length === 1 ? rounds[0] : 0,
        executionRef: executionRefs.length === 1 ? executionRefs[0] : '' };
      const group = { id, ref, files: available, selection, scope: scope(), taskId, snapshot, remote: Boolean(cloudTaskId), current: message === messages[0], ...(old?.delivery ? { delivery: old.delivery } : {}) };
      groups.set(id, group);
      available.sort((a, b) => Number(b.primary !== false && b.role !== 'supporting') - Number(a.primary !== false && a.role !== 'supporting'));
      const first = available[0], count = available.length, amount = totalSize(available);
      const card = root.ownerDocument.createElement('section');
      card.className = 'ndelivery'; card.dataset.delivery = id; card.dataset.chatNode = 'delivery:' + id;
      card.setAttribute('aria-label', text.title);
      card.innerHTML = '<header><span class="ndelivery-icon">' + icon(count > 1 ? { name: '成果包.zip' } : first) + '</span>' +
        '<div class="ndelivery-heading"><small>' + text.title + '</small>' +
        '<button type="button" ' + (count > 1 || /\.zip$/i.test(first.name || '') ? 'data-delivery-archive' : 'data-open-app="' + esc(key(first)) + '"') + ' title="' + text.preview + '"><b data-delivery-title data-user-content>' + esc(first.title || first.name || text.file) + '</b></button>' +
        '<div class="ndelivery-meta"><span data-delivery-format>' + (count > 1 ? 'ZIP 成果包' : esc(first.name || text.file)) + '</span><span data-delivery-files-count>' + count + ' ' + text.files + '</span>' + (amount ? '<span>' + esc(size(amount)) + '</span>' : '') + '</div></div>' +
        '<div class="ndelivery-actions">' + action('data-delivery-reveal', '打开所在位置', folderIcon) +
        action('data-delivery-archive', '打开压缩包', archiveIcon, count < 2 && !/\.zip$/i.test(first.name || '')) +
        action('data-delivery-retry', text.save, saveIcon) + action('data-delivery-open', text.openSaved, previewIcon, true) +
        action('data-delivery-local', '在本地继续', localIcon, !group.remote) +
        '</div></header>' +
        '<details class="ndelivery-files" open><summary data-delivery-count>' + count + ' ' + text.files + '</summary><div data-delivery-file-list></div></details>' +
        '<footer><span data-delivery-status role="status">' + text.preparing + '</span></footer>';
      card.querySelector('[data-delivery-file-list]').replaceWith(fileList(root.ownerDocument, available, file => file));
      paint(card, group);
      message.appendChild(card);
      joinPreviews(message, card, group);
      if (existing?.classList.contains('ndelivery-preview-only')) existing.remove();
    }
    while (groups.size > 120) { const old = groups.keys().next().value; groups.delete(old); if (!jobs.get(old)?.busy) jobs.delete(old); }
  }
  function canPreviewSaved(group, delivery) {
    if (!delivery || group.files.length !== 1) return false;
    const rows = delivery.files || group.files;
    if (rows.length !== 1) return false; // Multi-file results are displayed as ZIP packages.
    const file = group.files[0];
    const savedFile = { ...file, name: delivery.filename || rows[0].path || file.name };
    // Saving changes storage, not preview support. Use the same policy as the chat workbench.
    return [file, savedFile].every(item => {
      const kind = global.ChatTools?.previewKind?.(item);
      return Boolean(kind && kind !== 'external');
    });
  }
  function paint(card, group) {
    const job = jobs.get(group.id), result = job?.delivery || group.delivery;
    const status = card.querySelector('[data-delivery-status]');
    if (status) status.textContent = job?.localError
      ? job.localError + (job.localUnavailable && result ? ' · ' + text.openSaved : '')
      : job?.error ? (text.title + ' · ' + text.retry + ' · ') + job.error
      : result ? (result.storage === 'local' || !group.remote ? text.localSaved : text.savedCrossDevice)
      : job?.busy ? (group.remote ? text.collecting : text.preparing) : (group.remote ? text.collecting : text.localFiles);
    if (status && job?.error && !job.localError) {
      // Keep complete UI phrases in separate nodes so locale changes can
      // translate and restore them without rewriting user-supplied details.
      status.replaceChildren(...[text.title, ' · ', text.retry, ' · ', job.error]
        .map(value => document.createTextNode(value)));
    }
    const retry = card.querySelector('[data-delivery-retry]');
    const open = card.querySelector('[data-delivery-open]');
    card.classList.toggle('has-error', Boolean(job?.localError || job?.error));
    card.classList.toggle('is-busy', Boolean(job?.busy));
    if (open) { open.hidden = !canPreviewSaved(group, result); open.classList.toggle('is-saved', Boolean(result)); }
    if (retry) {
      retry.hidden = false;
      retry.disabled = Boolean(job?.busy);
      retry.classList.toggle('is-saved', Boolean(result));
      const label = result ? '已保存到资料库' : job?.busy ? '正在保存到资料库…' : job?.error ? '重试保存' : text.save;
      retry.innerHTML = (result ? savedIcon : saveIcon) + '<span class="ndelivery-action-label">' + esc(tx(label)) + '</span>';
      retry.title = tx(result ? '已保存到资料库，点击查看' : label); retry.setAttribute('aria-label', retry.title);
      retry.setAttribute('aria-busy', String(Boolean(job?.busy)));
    }
    const rows = result?.files || job?.manifest?.files || group.package?.files;
    const count = rows?.length || group.files.length;
    const archive = card.querySelector('.ndelivery-actions [data-delivery-archive]');
    if (archive) archive.hidden = count < 2 && !/\.zip$/i.test(group.files[0]?.name || '');
    const format = card.querySelector('[data-delivery-format]');
    if (format) format.textContent = count > 1 ? 'ZIP 成果包' : (group.files[0]?.name || text.file);
    const title = card.querySelector('[data-delivery-title]');
    const primary = group.files.filter(file => file.primary !== false && file.role !== 'supporting');
    const websiteTitle = primary.length === 1 && primary[0].kind === 'website'
      ? String(primary[0].title || '').trim() : '';
    // CSS/JS dependencies enlarge the package, not the number of website results.
    if (title && count > 1) {
      title.textContent = (websiteTitle || result?.title || job?.manifest?.title || group.package?.title || '成果包').replace(/\.zip$/i, '') + '.zip';
      title.parentElement?.removeAttribute('data-open-app');
      title.parentElement?.setAttribute('data-delivery-archive', '');
      title.parentElement?.setAttribute('title', '打开压缩包');
      const mark = card.querySelector('.ndelivery-icon');
      const nativeIcon = mark?.querySelector('[data-native-file-icon]');
      if (nativeIcon && nativeIcon.dataset.nativeFileIcon !== 'zip') {
        nativeIcon.dataset.nativeFileIcon = 'zip';
        const image = nativeIcon.querySelector('img'), label = nativeIcon.querySelector('.library-file-extension');
        if (image) { image.hidden = true; image.removeAttribute('src'); }
        if (label) { label.hidden = false; label.textContent = 'ZIP'; }
        global.SoduWorkLibraryFileIcons?.hydrate?.(mark);
      } else if (!nativeIcon) {
        const label = mark?.querySelector('.ndelivery-extension');
        if (label) label.textContent = 'ZIP';
      }
    }
    card.querySelector('[data-delivery-files-count]')?.replaceChildren(document.createTextNode(count + ' ' + text.files));
    if (rows?.length === 1) card.querySelector('.ndelivery-files').hidden = true;
    if (rows?.length > 1) {
      const details = card.querySelector('.ndelivery-files'); details.hidden = false;
      card.querySelector('[data-delivery-count]').textContent = rows.length + ' ' + text.files + ' · ' + text.structure;
      const expanded = details.querySelector('.ndelivery-more')?.open;
      details.querySelector('[data-delivery-file-list]').replaceWith(fileList(card.ownerDocument, rows,
        row => group.files.find(f => (f.relative || f.name) === row.path)));
      const more = details.querySelector('.ndelivery-more');
      if (expanded && more) more.open = true;
    }
  }
  function repaint(group) {
    if (group.scope !== scope()) return;
    global.document?.querySelectorAll('[data-delivery]').forEach(card => { if (card.dataset.delivery === group.id) paint(card, group); });
  }
  async function sync(group, api) {
    let job = jobs.get(group.id);
    if (job?.busy || job?.delivery || group.scope !== scope()) return;
    job = Object.assign(job || {}, { busy: true, error: '', manual: true }); jobs.set(group.id, job); repaint(group);
    try {
      let result;
      if (group.taskId) result = await global.SoduWorkAPI.saveTaskLibraryDelivery(group.taskId, { ...group.selection });
      else {
        const payload = await api.prepareDelivery(group.ref, group.files.map(key));
        if (!payload?.ok) throw Error(payload?.reason || '\u6210\u679c\u6587\u4ef6\u5c1a\u672a\u51c6\u5907\u597d');
        if (group.scope !== scope()) return;
        job.manifest = payload.manifest; repaint(group);
        if (!global.SoduWorkAPI?.saveLibraryDelivery) throw Error('请更新客户端后重试保存');
        result = await global.SoduWorkAPI.saveLibraryDelivery(payload);
      }
      if (group.scope !== scope()) return;
      if (!result?.ok || !result.delivery?.id) throw Error(result?.error || result?.reason || '\u6210\u679c\u96c6\u540c\u6b65\u5931\u8d25');
      job.delivery = group.delivery = result.delivery;
      if (group.taskId && result.manifest?.id && result.manifest.revision) {
        const current = groups.get(group.id);
        if (current?.scope === group.scope) current.selection = { ...group.selection,
          deliveryId: result.manifest.id, revision: result.manifest.revision };
      }
      announceLibraryChange({ itemId: result.delivery.id });
    } catch (error) {
      job.error = /Failed to fetch|NetworkError|fetch failed/i.test(error.message || '') ? '\u7f51\u7edc\u6682\u65f6\u4e0d\u53ef\u7528' : error.message || '\u6210\u679c\u96c6\u540c\u6b65\u5931\u8d25';
    } finally { job.busy = false; repaint(group); }
  }
  function hydrateRemoteStatus(group) {
    if (!group.taskId || group.statusRequested || group.delivery || typeof global.SoduWorkAPI?.getTaskLibraryDeliveryStatus !== 'function') return;
    group.statusRequested = true;
    Promise.resolve(global.SoduWorkAPI.getTaskLibraryDeliveryStatus(group.taskId, { ...group.selection })).then(result => {
      if (group.scope !== scope() || groups.get(group.id) !== group || jobs.get(group.id)?.manual) return;
      if (result?.delivery) group.delivery = result.delivery;
      // Server package revisions must never guard a materialized local ZIP.
      if (result?.manifest) {
        group.package = result.manifest;
        group.selection = { ...group.selection, deliveryId: result.manifest.id, revision: result.manifest.revision };
      }
      repaint(group);
    }).catch(() => { /* A legacy task may not have a delivery yet; the normal sync path handles it. */ });
  }
  async function hydrateLocalStatus(group, manifest) {
    // A read-only receipt lookup must not hold up metadata inspection for other
    // cards, or restore stale account data after the scope was cleared.
    if (jobs.get(group.id)?.manual || !manifest?.sessionId || !manifest?.revision ||
        typeof global.SoduWorkAPI?.getLibraryDeliveryStatus !== 'function') return;
    try {
      const response = await global.SoduWorkAPI.getLibraryDeliveryStatus(manifest);
      if (group.scope !== scope() || groups.get(group.id) !== group || jobs.get(group.id)?.manual) return;
      const saved = response?.delivery;
      if (saved && (saved.sessionId !== manifest.sessionId || saved.revision !== manifest.revision)) return;
      if (saved) {
        const job = jobs.get(group.id) || {}; jobs.set(group.id, job);
        job.delivery = group.delivery = saved; repaint(group);
      }
    } catch { /* Offline lookup leaves the explicit save action available. */ }
  }
  function inspect(group, api) {
    if (!api?.inspectDelivery || group.inspectRequested || group.delivery || jobs.get(group.id)?.manifest ||
        group.files.some(f => f.taskId || !f.artifactId) || ['streaming', 'running', 'queued'].includes(group.snapshot?.status)) return;
    group.inspectRequested = true;
    inspectTail = inspectTail.then(async () => {
      if (group.scope !== scope()) return;
      const metadata = await api.inspectDelivery(group.ref, group.files.map(key));
      if (group.scope !== scope() || !metadata?.ok) return;
      const job = jobs.get(group.id) || {}; jobs.set(group.id, job);
      job.manifest = metadata.manifest; job.filename = metadata.filename; repaint(group);
      void hydrateLocalStatus(group, metadata.manifest);
    }).catch(() => { /* Current files remain available through the local actions. */ });
  }
  function hydrate(root, { api, ref, snapshot }) {
    global.SoduWorkLibraryFileIcons?.hydrate?.(root);
    root.querySelectorAll('[data-delivery]').forEach(card => {
      const group = groups.get(card.dataset.delivery);
      if (!group || group.ref !== ref || group.scope !== scope()) return;
      const saved = snapshot?.deliverySync;
      const receiptRevision = group.receiptRevision || group.snapshot?.deliverySync?.revision;
      if (!group.taskId && (!receiptRevision || receiptRevision === saved?.revision) && (group.current || saved?.currentTurn === false) && saved?.artifactVersions?.length && group.files.every(f => saved.artifactVersions.some(v => v.id === key(f) && String(v.at || 0) === String(f.at || 0) && Number(v.size || 0) === Number(f.size || 0)))) {
        const current = jobs.get(group.id);
        if (!current?.manual) {
          // A local index contains no save receipt. It must not erase a real
          // receipt obtained by the read-only library lookup on the next render.
          const delivery = saved.delivery || current?.delivery || group.delivery;
          jobs.set(group.id, { ...current, busy: !delivery && saved.state === 'saving', delivery,
            error: !delivery && saved.state === 'failed' ? saved.error : '', managed: true,
            manifest: saved.manifest || current?.manifest, filename: saved.filename || current?.filename });
          group.delivery = delivery;
        }
        if (saved.revision) group.receiptRevision = saved.revision;
      }
      hydrateRemoteStatus(group);
      if (isSettled(snapshot)) inspect(group, api);
      paint(card, group);
      // Hydration is read-only. Save only through the explicit icon action.
    });
  }
  function localContinuation(ref) {
    if (!ref) return '';
    let id = '';
    global.document?.querySelectorAll('[data-delivery]').forEach(card => {
      const group = groups.get(card.dataset.delivery), button = card.querySelector('[data-delivery-local]');
      if (group?.ref === ref && group.scope === scope() && group.remote && group.files.length &&
          button && !button.disabled && !button.hidden && card.getClientRects().length) id = group.id;
    });
    return id;
  }
  function continueLocal(ref, id, api) {
    const existing = localJobs.get(id);
    if (existing?.ref === ref) return existing.promise;
    const promise = prepareLocal(ref, id, api), job = { ref, promise };
    localJobs.set(id, job);
    void promise.finally(() => { if (localJobs.get(id) === job) localJobs.delete(id); }).catch(() => {});
    return promise;
  }
  async function prepareLocal(ref, id, api) {
    const group = groups.get(id);
    const check = () => {
      if (!group || groups.get(id) !== group || group.ref !== ref || group.scope !== scope() || !group.remote ||
          (global.NativeChat?.sessionInfo && global.NativeChat.sessionInfo()?.ref !== ref)) throw Error('会话或成果已变化，请重新打开成果');
      if (global.NativeChat?.isBusy?.()) throw Error('请等待本轮云端执行结束，再带成果回到本机');
    };
    check();
    if (!api?.continueLocalDelivery || !global.WorkspaceHost?.open) throw Error('本地会话暂时不可用，请重新打开客户端');
    await materialize(group, api);
    check();
    const ids = group.files.map(f => f.artifactId).filter(Boolean);
    if (!ids.length) throw Error('成果文件尚未准备好，请重新打开成果');
    const result = await api.continueLocalDelivery(ref, ids);
    check();
    if (!result?.ok) throw Error(result?.reason || '无法准备本地成果');
    const opened = await global.WorkspaceHost.open('create', { newSession: true, tab: 'chat', source: 'cloud-result', fileOpen: result });
    if (!opened) throw Error('本地会话未能打开，请重试');
    return true;
  }
  async function handle(node, api) {
    const external = node.closest('[data-cloud-artifact-url]');
    if (external) {
      const url = String(external.dataset.url || external.dataset.cloudArtifactUrl || '').trim();
      if (!/^https?:\/\//i.test(url)) { global.petSay?.('成果地址无效，请刷新后重试'); return true; }
      try {
        const result = await (global.ChatWorkbench?.openLink?.(url) || global.soduWorkAPI?.openExternal?.(url));
        if (result?.ok === false) throw Error(result.reason || '无法打开在线成果');
      } catch (error) { global.petSay?.(error.message || '无法打开在线成果'); }
      return true;
    }
    const card = node.closest('[data-delivery]'), group = card && groups.get(card.dataset.delivery);
    if (!group || group.scope !== scope()) return false;
    if (node.closest('[data-delivery-local]')) {
      const button = node.closest('[data-delivery-local]');
      if (button.disabled) return true;
      button.disabled = true;
      try {
        await continueLocal(group.ref, group.id, api);
      } catch (error) { if (group.scope === scope()) global.petSay?.(error.message || '无法在本地继续'); }
      finally { button.disabled = false; }
      return true;
    }
    if (node.closest('[data-delivery-continue]')) {
      const info = global.NativeChat?.sessionInfo?.();
      if (info && info.ref !== group.ref) {
        global.petSay?.('会话已变化，请在对应会话中继续'); return true;
      }
      // A selector list chooses document order. The hidden home composer can
      // precede this chat, so focus the input owned by the clicked result.
      const input = card.closest('.nchat')?.querySelector('#nchatInput') || global.document?.getElementById('nchatInput');
      const visible = input && (typeof input.checkVisibility === 'function'
        ? input.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : input.getClientRects?.().length > 0);
      if (visible && !input.disabled && !input.hidden) {
        input.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        input.focus({ preventScroll: true });
      } else if (!input && typeof global.NativeChat?.focusComposer === 'function') global.NativeChat.focusComposer(group.ref);
      else { global.petSay?.('请打开这份成果所属的会话后继续'); return true; }
      if (group.remote) global.dispatchEvent?.(new CustomEvent('soduwork-cloud-delivery-continue', { detail: { taskId: group.taskId, ref: group.ref } }));
      return true;
    }
    if (node.closest('[data-delivery-open]')) {
      const delivery = jobs.get(group.id)?.delivery || group.delivery;
      if (!canPreviewSaved(group, delivery)) return true;
      if (delivery?.id?.startsWith('local-')) {
        try { await global.LibraryTransfer.openSavedItem(delivery, { preview: true }); }
        catch (error) { if (group.scope === scope()) global.petSay?.(error.message); }
        return true;
      }
      if (delivery && !(global.ChatWorkbench?.openSavedDelivery || global.LibraryDelivery?.open)?.(delivery.id, { title: delivery.title || group.files[0]?.title || '已保存版本', openLocal: async () => {
        await materialize(group, api);
        if (group.scope !== scope()) throw Error('账号已变化，请重新打开成果');
        const result = await api.openLocalDelivery(group.ref, group.files.map(f => f.artifactId).filter(Boolean));
        if (!result?.ok) throw Error(result?.reason || '本地成果暂时不可用');
      } })) global.petSay?.('请在对话预览区域中打开已保存版本');
      return true;
    }
    if (node.closest('[data-delivery-retry]')) {
      const delivery = jobs.get(group.id)?.delivery || group.delivery;
      if (delivery) {
        try {
          if (!global.LibraryTransfer?.openSavedItem) throw Error(tx('暂时无法打开资料库，请稍后重试'));
          await global.LibraryTransfer.openSavedItem(delivery, { remote: true });
        } catch (error) { if (group.scope === scope()) global.petSay?.(error.message); }
      } else await sync(group, api);
      return true;
    }
    if (node.closest('[data-delivery-reveal],[data-delivery-archive]')) {
      const job = jobs.get(group.id) || {}; jobs.set(group.id, job);
      if (job.opening) return true;
      job.opening = true; job.localError = ''; job.localUnavailable = false; repaint(group);
      try {
        if (!api?.openLocalDelivery) throw Error('\u65e0\u6cd5\u5728 SoduWork \u4e2d\u6253\u5f00\u672c\u673a\u6210\u679c');
        await materialize(group, api);
        if (group.scope !== scope()) return true;
        // Cloud receipts identify the server collection. Inspect its verified
        // local projection before applying a local package revision guard.
        if (!job.manifest && (!group.delivery || group.remote) && api.inspectDelivery) {
          const metadata = await api.inspectDelivery(group.ref, group.files.map(key));
          if (group.scope !== scope()) return true;
          if (!metadata?.ok) throw Error(metadata?.reason || '成果文件尚未准备好');
          job.manifest = metadata.manifest; job.filename = metadata.filename;
        }
        const action = node.closest('[data-delivery-archive]') ? api.openDeliveryArchive : api.openLocalDelivery;
        if (!action) throw Error('请重新打开客户端后操作成果');
        const manifest = job.manifest || group.delivery;
        const revision = job.manifest?.revision || (!group.remote ? group.delivery?.revision : undefined);
        const result = await action(group.ref, group.files.map(f => f.artifactId).filter(Boolean), {
          bundle: (manifest?.files?.length || group.files.length) > 1 || /\.zip$/i.test(group.files[0]?.name || ''),
          ...(revision ? { revision } : {}),
        });
        if (group.scope !== scope()) return true;
        if (result?.ok !== true && !result?.canceled) { job.localUnavailable = result?.code === 'DELIVERY_LOCAL_UNAVAILABLE'; throw Error(result?.reason || '\u65e0\u6cd5\u6253\u5f00\u672c\u673a\u6210\u679c'); }
      } catch (error) { if (group.scope === scope()) job.localError = error.message || '\u65e0\u6cd5\u6253\u5f00\u672c\u673a\u6210\u679c'; }
      finally { job.opening = false; repaint(group); }
      return true;
    }
    return false;
  }
  async function materialize(group, api) {
    const pending = group.files.find(file => file.cloudPending);
    if (!pending) {
      if (group.files.some(file => file.taskId)) throw Error('这份云端成果尚未保存到本机，请重新打开会话后再试');
      return;
    }
    if (!api?.cloud?.materialize) throw Error('请重新打开会话后再试');
    // One request captures the whole task. Repeating it per file rehashes the
    // entire collection N times and can make large deliveries feel frozen.
    const result = await api.cloud.materialize(group.ref, { taskId: pending.taskId, attachmentId: pending.attachmentId });
    if (group.scope !== scope()) return;
    if (!result?.ok) throw Error(result?.reason || '云端成果保存失败，请重试');
    const byId = new Map((result.artifacts || [result.artifact]).filter(Boolean).map(file => [file.remoteAttachmentId, file]));
    group.files = group.files.map(file => {
      if (!file.cloudPending) return file;
      const local = byId.get(file.attachmentId);
      if (!local?.artifactId || local.cloudTaskId !== pending.taskId) throw Error('成果文件已更新，请重新打开会话');
      const merged = { ...file, ...local, remoteMaterialized: true };
      delete merged.taskId; delete merged.attachmentId; delete merged.cloudPending;
      return merged;
    });
  }
  global.addEventListener?.('soduwork-data-scope-changed', () => { groups.clear(); jobs.clear(); localJobs.clear(); completed.clear(); });
  function settled(ref) { completed.add(ref); if (completed.size > 120) completed.delete(completed.values().next().value); }
  function deliverySelection(card) {
    const group = groups.get(card?.dataset?.delivery);
    return group && group.scope === scope() ? { ...group.selection } : null;
  }
  global.ChatDeliveries = { decorate, hydrate, handle, settled, isSettled, outputRound, deliverySelection, localContinuation, continueLocal, _groupFiles: groupFiles, _artifactUrlFor: artifactUrlFor };
})(typeof window !== 'undefined' ? window : globalThis);
