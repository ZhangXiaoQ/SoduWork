/* Trusted output index shared by ordinary and task messages. Never open an AI supplied path directly. */
(function (global) {
  'use strict';
  // Production fuse: SODUWORK_CHAT_LINKIFY_LEGACY=1 restores the pre-indexing
  // scan path (per-node mentions, no memo, no zero-hit skip) without a rollback.
  const LEGACY = (() => { try { return String(global.process?.env?.SODUWORK_CHAT_LINKIFY_LEGACY || '') === '1'; } catch (_) { return false; } })();
  const key = file => String(file && (file.artifactId || file.path) || '');
  const draftPlacement = global.ChatPluginDraftPlacement || (typeof require === 'function' ? require('./chat-plugin-draft-placement') : null);
  const asFiles = value => Array.isArray(value) ? value : [];
  const normalize = value => {
    let text = String(value || '').trim();
    try { text = decodeURIComponent(text); } catch (_) { /* incomplete URI */ }
    return text.replace(/\\/g, '/').replace(/^(?:file:\/+|sandbox:\/)/i, '')
      .replace(/^\.\//, '').replace(/^\/+/, '');
  };
  const basename = value => normalize(value).split('/').pop();
  const explicitWeb = value => /^(?:https?:)?\/\//i.test(String(value || ''));
  // Ownership and edits require the exact workspace path. A basename fallback
  // is useful for prose links, but must never attach another directory's diff.
  function workspaceFileTarget(value, files, cwd) {
    const clean = value => {
      let text = String(value || '');
      if (/^file:\/\//i.test(text)) try {
        const uri = new URL(text); text = decodeURIComponent(uri.pathname);
        if (uri.hostname && uri.hostname !== 'localhost') text = '//' + uri.hostname + text;
        else if (/^\/[a-z]:\//i.test(text)) text = text.slice(1);
      } catch (_) { return ''; }
      text = text.replace(/\\/g, '/').replace(/^\.\//, '');
      return /^(?:[a-z]:)?\/$/i.test(text) ? text : text.replace(/\/$/, '');
    };
    const root = clean(cwd), raw = clean(value);
    const prefix = root.endsWith('/') ? root : root + '/';
    const windows = /^[a-z]:\//i.test(root || raw) || (root || raw).startsWith('//');
    const fold = text => windows ? text.toLowerCase() : text;
    const absolute = text => /^(?:[a-z]:\/|\/)/i.test(text);
    const relative = text => {
      text = clean(text);
      if (text.split('/').includes('..')) return '';
      if (!absolute(text)) return fold(text);
      return root && fold(text).startsWith(fold(prefix)) ? fold(text.slice(prefix.length)) : '';
    };
    const target = relative(raw);
    const matches = asFiles(files).filter(file => {
      if (root && file.path && absolute(clean(file.path)) && !relative(file.path)) return false;
      if (absolute(raw) && file.path && fold(clean(file.path)) === fold(raw)) return true;
      const name = file.relative || file.path || file.name;
      return target && relative(name) === target;
    });
    return matches.length === 1 ? matches[0] : null;
  }
  function fileTarget(value, files) {
    files = asFiles(files);
    const raw = String(value || '').trim();
    if (!raw || raw[0] === '#' || explicitWeb(raw) ||
        (/^[a-z][\w+.-]*:/i.test(raw) && !/^(?:file:|sandbox:|[a-z]:[\\/])/i.test(raw))) return null;
    const target = normalize(raw);
    const exact = (files || []).filter(file => [file.relative, file.name, file.path]
      .filter(Boolean).some(label => normalize(label) === target));
    // A missing historical screenshot must not open an unrelated same-name
    // website asset. Preserve the dedicated evidence path through legacy URLs.
    const evidence = /(?:^|\/)(\.soduwork\/evidence\/.*)$/.exec(target)?.[1];
    const matches = exact.length ? exact : (files || []).filter(file => evidence
      ? [file.relative, file.path].filter(Boolean).some(label => {
        const value = normalize(label); return value === evidence || value.endsWith('/' + evidence);
      }) : basename(file.relative || file.name || file.path) === basename(target));
    const unique = new Map(matches.map(file => [key(file), file]));
    return unique.size === 1 ? [...unique.values()][0] : null;
  }
  // Workspace changes live in the conversation snapshot rather than the
  // persisted output index. Promote them to file entries so filenames in an
  // answer open the native editor instead of being treated as web hosts.
  /* Tool-written files are work evidence, not deliverables on their own
     (competitor pattern: Claude/Manus promote an explicit publish/declaration;
     a filesystem sweep never decides what the user consumes). A change row
     enters the trusted index so its filename still opens in the workbench,
     but it reaches the result card only when the answer names it (explicit),
     a delivery manifest declares it, or a trusted typed fallback applies.
     Compiler/telemetry noise additionally disappears from the workbench. */
  const PROCESS_DIR_RE = /(?:^|\/)(?:logs?|tmp|temp|obj|bin|coverage|\.cache)(?:\/|$)/i;
  const PROCESS_EXT_RE = /\.(?:log|err|out|cmdline|tmp|bak|pdb|obj|cache)$/i;
  const ROSLYN_TEMP_RE = /^[a-z0-9]{8,}(?:\.\d+)?\.(?:cs|dll)$/i;
  const PROCESS_WORDS = ['test', 'spec', 'fixture', 'mock', 'cache', 'debug', 'trace', 'log',
    'screenshot', 'screen-shot', 'command-output', 'terminal-output', 'browser-output', 'tool-output',
    '\u4e34\u65f6', '\u8349\u7a3f', '\u6d4b\u8bd5', '\u622a\u56fe'];
  function looksLikeProcessEvidence(rel) {
    const p = String(rel || '');
    if (PROCESS_DIR_RE.test(p) || PROCESS_EXT_RE.test(p) || ROSLYN_TEMP_RE.test(p)) return true;
    const stem = p.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
    // Separator-bounded so 'contest' does not match 'test' or 'logistic' 'log'.
    return PROCESS_WORDS.some(word => new RegExp(`(?:^|[-_.])${word}(?:[-_.]|$)`).test(stem));
  }
  function mergeFileChanges(files, changeSet) {
    const current = asFiles(files).map(file => ({ ...file }));
    const changes = Array.isArray(changeSet?.files) ? changeSet.files : [];
    changes.forEach(change => {
      const raw = String(change && change.path || '');
      const target = normalize(raw);
      if (!target) return;
      let file = workspaceFileTarget(raw, current, changeSet.cwd);
      if (!file) {
        const name = raw.split('/').pop() || raw;
        const after = change.after || {};
        const root = String(changeSet.cwd || '').replace(/\\/g, '/').replace(/\/$/, '');
        const absolute = /^(?:[A-Za-z]:[\\/]|\/)/.test(raw) ? raw : root ? root + '/' + raw : raw;
        file = {
          name, relative: raw, path: absolute, kind: 'file',
          size: Number(after.size) || 0, at: Number(after.mtimeMs) || Date.now(),
          changedInTurn: true, primary: false, change,
          processEvidence: looksLikeProcessEvidence(target),
        };
        current.push(file);
      } else {
        file.change = change;
        file.changedInTurn = true;
      }
      if (change.action === 'deleted') file.deleted = true;
    });
    return current;
  }
  /* Long transcripts re-scan every text node on every full render. The label
     set and its fileTarget resolution were rebuilt per node, which made the
     cost O(nodes × files). Build the resolved token list once per file set
     (per scope) and let each node do plain indexOf scans against it. */
  function tokensFor(files) {
    files = asFiles(files);
    const labels = new Set();
    files.forEach(file => [file.relative, file.name, file.path, basename(file.relative || file.name || file.path)]
      .filter(Boolean).forEach(label => {
        if (String(label).length >= 3 && /\.[^./\\\s]{1,12}$/.test(label)) labels.add(normalize(label));
      }));
    const tokens = [];
    [...labels].sort((a,b) => b.length-a.length).forEach(label => {
      const file = fileTarget(label, files);
      if (!file) return;
      tokens.push({ label, token: label.toLocaleLowerCase(), file });
    });
    return tokens;
  }
  function buildLinkIndex(files) {
    const cache = new Map();
    return {
      __linkIndex: true,
      // Mirrors scoped(): an owned task bucket when the owner's task has its
      // own files, the shared untasked bucket otherwise, and the full index
      // when the node carries no [data-output-task] anchor at all.
      scope(scopeKey) {
        scopeKey = String(scopeKey || '');
        if (cache.has(scopeKey)) return cache.get(scopeKey);
        let bucket;
        if (!scopeKey) bucket = files;
        else {
          // Strict equality mirrors the legacy scoped() filter exactly (taskId
          // values are strings from the hub/outputs index; coercion here could
          // silently re-bucket rows the old path left in the untasked set).
          const own = files.filter(file => file.taskId === scopeKey);
          bucket = own.length ? own : files.filter(file => !file.taskId);
        }
        const tokens = tokensFor(bucket);
        cache.set(scopeKey, tokens);
        return tokens;
      },
    };
  }
  function mentions(text, filesOrIndex, scopeKey = '') {
    const tokens = filesOrIndex && filesOrIndex.__linkIndex
      ? filesOrIndex.scope(scopeKey) : tokensFor(filesOrIndex);
    const lower = String(text).replace(/\\/g, '/').toLocaleLowerCase(), hits = [];
    tokens.forEach(({ label, token, file }) => {
      for (let from=0, at; (at=lower.indexOf(token,from))>=0; from=at+token.length) {
        if ((!text[at-1] || !/[A-Za-z0-9_.-]/.test(text[at-1])) &&
            (!text[at+label.length] || !/[A-Za-z0-9_.-]/.test(text[at+label.length])))
          hits.push({start:at,end:at+label.length,text:text.slice(at,at+label.length),file});
      }
    });
    hits.sort((a,b) => a.start-b.start || b.end-a.end);
    let end=-1;
    return hits.filter(hit => { if(hit.start<end)return false;end=hit.end;return true; });
  }
  function scoped(node, files) {
    files = asFiles(files);
    const owner = node.closest('[data-output-task]');
    if (!owner) return files;
    const taskId = owner.dataset.outputTask;
    if (!taskId) return files;
    const own = files.filter(file => file.taskId === taskId);
    return own.length ? own : files.filter(file => !file.taskId);
  }
  function button(doc, file, text) {
    const node = doc.createElement('button');
    node.type = 'button'; node.className = 'noutput-inline';
    node.dataset.openApp = key(file);
    node.title = '打开成果：' + String(file.name || text); node.textContent = text;
    return node;
  }
  /* Zero-hit scan memory. patchContent restores plain text over the link
     buttons during streaming, so hit nodes must re-linkify every pass and are
     never cached; a node is remembered only when a scan found nothing. The
     entry stores the exact nodeValue plus the (ref + files) signature, so any
     text growth or file-set change invalidates it and forces a rescan. */
  const linkScanCache = new WeakMap();
  function linkify(root, files, filesSig = '') {
    files = asFiles(files);
    if (!root || !files.length) return 0;
    const doc=root.ownerDocument, filter=doc.defaultView.NodeFilter;
    let count=0;
    root.querySelectorAll('.ntext a,.nmd a').forEach(anchor => {
      if (anchor.closest('.user,.ntool,.nthink,pre')) return;
      const href = anchor.getAttribute('data-output-href') || anchor.getAttribute('href') || '';
      if (explicitWeb(href)) return;
      const file = fileTarget(href || anchor.textContent, scoped(anchor,files));
      if (!file) return;
      anchor.replaceWith(button(doc,file,anchor.textContent)); count++;
    });
    const index = LEGACY ? null : buildLinkIndex(files);
    const walker=doc.createTreeWalker(root,filter.SHOW_TEXT,{acceptNode(node){
      const parent=node.parentElement;
      return parent && !parent.closest('a,button,pre,textarea,input,[contenteditable="true"],.user,.ntool,.nthink,.ndelivery,.noutput-library,.noutput-image,.noutput-video,.nplugin-draft') &&
        String(node.nodeValue||'').trim() ? filter.FILTER_ACCEPT : filter.FILTER_REJECT;
    }});
    const nodes=[]; while(walker.nextNode())nodes.push(walker.currentNode);
    nodes.forEach(node => {
      const text=node.nodeValue;
      let hits;
      if (LEGACY || !index) {
        hits = mentions(text, scoped(node.parentElement, files));
      } else {
        const cached = linkScanCache.get(node);
        if (cached && cached.sig === filesSig && cached.text === text) return;
        const parent = node.parentElement;
        const owner = parent && parent.closest ? parent.closest('[data-output-task]') : null;
        const scopeKey = owner && owner.dataset && owner.dataset.outputTask ? String(owner.dataset.outputTask) : '';
        hits = mentions(text, index, scopeKey);
        if (!hits.length) {
          if (filesSig) linkScanCache.set(node, { sig: filesSig, text });
          return;
        }
      }
      const frag=doc.createDocumentFragment();let cursor=0;
      hits.forEach(hit => {frag.appendChild(doc.createTextNode(text.slice(cursor,hit.start)));
        frag.appendChild(button(doc,hit.file,hit.text));cursor=hit.end;count++;});
      frag.appendChild(doc.createTextNode(text.slice(cursor)));node.replaceWith(frag);
    });
    return count;
  }
  /* Fingerprint of the live decorator cards in previousRoot. The settled carry
     clones these subtrees into the decorated HTML, so any drift in their
     interactive state (install errors, image readiness) must miss the memo. */
  function carryFingerprint(previousRoot) {
    if (!previousRoot || !previousRoot.querySelectorAll) return '';
    const cards = previousRoot.querySelectorAll('.ndelivery,.noutput-library,.noutput-image,.noutput-video,.nplugin-draft');
    if (!cards.length) return '';
    return [...cards].map(node => {
      const attrs = [];
      const raw = node.attributes;
      if (raw) {
        if (typeof raw.length === 'number') { for (let i = 0; i < raw.length; i += 1) attrs.push(raw[i].name + '=' + raw[i].value); }
        else Object.keys(raw).forEach(name => attrs.push(name + '=' + raw[name]));
      }
      return (node.dataset && node.dataset.chatNode || '') + '#' + (node.className || '') + '#' +
        attrs.sort().join(';') + '#' + (node.textContent || '');
    }).join('|');
  }
  /* Everything the settled decorate path reads from the snapshot: isSettled,
     the delivery decorators and the library fallback. messages/tools/notices
     are replaced by cheap projections; fileChanges reach decorate only through
     the merged files list, which carries its own signature. */
  function decorateStateSignature(snapshot) {
    const s = snapshot || {};
    const messages = Array.isArray(s.messages) ? s.messages : [];
    let latestUser = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) { if (messages[i] && messages[i].role === 'user') { latestUser = i; break; } }
    const runningTools = (Array.isArray(s.tools) ? s.tools : []).filter(t => t && t.state === 'running').map(t => Number(t.after) || 0);
    const slim = { ...s, messages: undefined, tools: undefined, notices: undefined, fileChanges: undefined,
      history: s.history ? { messageStart: s.history.messageStart, messageIndices: s.history.messageIndices } : undefined };
    if (s.execution && typeof s.execution === 'object') slim.execution = { ...s.execution, fileChanges: undefined };
    return JSON.stringify([slim, latestUser, runningTools, messages.flatMap((m, i) => m?.role === 'user'
      ? [[i, m.sentAt || m.timestamp || 0]] : m?.role === 'assistant' && m.done !== false && m.completedAt ? [[i, m.completedAt]] : [])]);
  }
  let decorateMemo = null;
  function decorate(html, files, ref = '', snapshot = {}, previousRoot = null) {
    files = asFiles(files);
    // A file write is not a completed result. While this turn is executing,
    // retain only already displayed cards belonging to earlier final replies.
    // This also avoids reparsing/linkifying growing text on provider tokens.
    const settled = !global.ChatDeliveries || global.ChatDeliveries.isSettled(snapshot);
    if (!settled) return html; // streaming carry moved to post-patch (chat-decorate-carry)
    const carrySig = carryFingerprint(previousRoot);
    const filesSig = JSON.stringify(files);
    const stateSig = JSON.stringify([decorateStateSignature(snapshot), global.LibraryTransfer?.revision?.() || 0]);
    if (!LEGACY && decorateMemo && decorateMemo.ref === String(ref || '') && decorateMemo.html === html &&
        decorateMemo.filesSig === filesSig && decorateMemo.stateSig === stateSig && decorateMemo.carrySig === carrySig)
      return decorateMemo.decorated;
    if (!files.length && !snapshot?.artifactUrl && !snapshot?.cloudHandoff?.artifactUrl && !snapshot?.execution?.artifactUrl && !carrySig) return html;
    const root = document.createElement('div'); root.innerHTML = html;
    if (carrySig) {
      const messageKey = node => node.dataset.messageOwner != null
        ? 'owner:' + node.dataset.messageOwner : node.dataset.chatNode;
      [...previousRoot.children].filter(node => node.dataset?.pluginDraftHistorical === 'true' && !supersededDraftCard(node, files))
        .forEach(node => root.appendChild(node.cloneNode(true)));
      const previous = new Map([...previousRoot.querySelectorAll('[data-chat-node]')]
        .map(node => [messageKey(node), node]));
      root.querySelectorAll('[data-delivery-current="false"][data-delivery-final="true"]').forEach(message => {
        const old = previous.get(messageKey(message));
        if (!old) return;
        [...old.children].filter(node => node.matches('.ndelivery,.noutput-library,.noutput-image,.noutput-video,.nplugin-draft'))
          .filter(node => !supersededDraftCard(node, files))
          .filter(node => !node.classList.contains('nplugin-draft') || draftPlacement?.matchesOwner(node, message, snapshot) !== false)
          .forEach(node => message.appendChild(node.cloneNode(true)));
      });
    }
    // A cloud run may return a reachable URL (preview/deployment/PR) without
    // attachments. Still run the delivery decorator so that URL-only output
    // is visible and clickable in the conversation.
    if (files.length) {
      linkify(root,files,(ref || '') + '\u0000' + filesSig);inlineImages(root,files,ref);inlineVideos(root,files,ref);
      pluginDrafts(root,files,ref,snapshot);
    }
    // The unified decorator owns both local and cloud file cards. A second
    // fallback must not revive a result it intentionally withheld/deduplicated.
    if (global.ChatDeliveries) {
      global.ChatDeliveries.decorate(root, files, ref, snapshot);
      // Ordinary task attachments still use the existing library action;
      // they are not cloud conversation deliveries or local output fallbacks.
      if (!snapshot.cloudHandoff?.taskId) global.LibraryTransfer?.decorateOutputs(root, files.filter(file => file.taskId), ref, snapshot);
    }
    else global.LibraryTransfer?.decorateOutputs(root,files,ref,snapshot);
    // Media belongs to its review result, including carried nodes from earlier renders.
    // Folding a handled result must also fold its evidence, without hiding ordinary deliveries.
    root.querySelectorAll('.nmsg.ai,[data-task-stream]').forEach(message => {
      const card = message.querySelector('.nacceptance-result');
      const body = card?.querySelector('.nacceptance-result-body');
      if (!body) return;
      const media = [...message.querySelectorAll('.noutput-image,.noutput-video,.noutput-library')]
        .filter(node => node.closest('.nmsg.ai,[data-task-stream]') === message && !node.closest('.nacceptance-result'));
      if (!media.length) return;
      let evidence = body.querySelector('[data-acceptance-evidence]');
      if (!evidence) {
        evidence = document.createElement('details'); evidence.dataset.acceptanceEvidence = '';
        evidence.className = 'nacceptance-evidence';
        const summary = document.createElement('summary'); summary.textContent = '查看相关证据';
        evidence.appendChild(summary); body.appendChild(evidence);
      }
      media.forEach(node => evidence.appendChild(node));
    });
    const decorated = root.innerHTML;
    if (!LEGACY) decorateMemo = { ref: String(ref || ''), html, filesSig, stateSig, carrySig, decorated };
    return decorated;
  }
  const isPluginDraft = file => !file?.taskId && (file?.pluginDraft === true ||
    ['soduwork-plugin-draft.json', 'soduwork-plugin-draft.json'].includes(basename(file?.relative || file?.name || file?.path).toLowerCase()));
  // One install entry per plugin; revisions belong to their own turn's final reply.
  const pluginIdentityOf = file => String(file && file.pluginIdentity || '') || key(file);
  function supersededDraftCard(node, files) {
    if (!node.classList || !node.classList.contains('nplugin-draft')) return false;
    const identity = node.getAttribute('data-plugin-draft-identity') || '';
    if (!identity) return false;
    const cardKey = node.getAttribute('data-install-plugin-draft') || node.querySelector('[data-install-plugin-draft]')?.dataset.installPluginDraft || '';
    const candidates = asFiles(files).filter(file => isPluginDraft(file) && !file.pluginSuperseded && pluginIdentityOf(file) === identity);
    return candidates.length > 0 && !candidates.some(file => key(file) === cardKey);
  }
  function pluginDrafts(root, files, ref, snapshot = {}) {
    if (!ref) return;
    const messages = [...root.querySelectorAll('.nmsg.ai')], seen = new Set();
    const escapeSelector = value => global.CSS?.escape ? global.CSS.escape(value)
      : String(value).replace(/["\\]/g, '\\$&');
    // Only trusted indexed candidates speak; manifest and archive share one identity.
    for (const file of files.filter(file => isPluginDraft(file) && !file.pluginSuperseded &&
        (file.pluginIdentity || file.pluginName))) {
      const identity = pluginIdentityOf(file); if (seen.has(identity)) continue; seen.add(identity);
      const owned = draftPlacement?.target(file, snapshot, messages);
      const old = root.querySelector('[data-plugin-draft-identity="' + escapeSelector(identity) + '"]');
      const revision = String(file.pluginRevision || file.at || 0);
      const sameRevision = old && (old.dataset.pluginDraftRevision || old.dataset.pluginDraftAt) === revision;
      if (owned === false) continue;
      if (owned === null && old && (sameRevision || !file.pluginRevision)) {
        const previousMessage = old.closest('.nmsg.ai');
        if (previousMessage && draftPlacement?.matchesOwner(old, previousMessage, snapshot) === false) {
          root.appendChild(old); old.dataset.pluginDraftHistorical = 'true';
          old.removeAttribute('data-plugin-draft-owner');
        }
        continue;
      }
      const target = owned === null ? root : owned !== undefined ? owned : [...messages].reverse().find(message =>
        [...message.querySelectorAll('[data-open-app]')].some(node => node.dataset.openApp === key(file))) ||
        messages.at(-1) || root;
      if (!target) continue;
      if (old && sameRevision && (owned === undefined || old.dataset.pluginDraftHistorical !== 'true')) {
        if (owned) {
          target.appendChild(old);
          old.dataset.pluginDraftOwner = draftPlacement.ownerIndex(target, snapshot);
        }
        continue;
      }
      old?.remove();
      const card = root.ownerDocument.createElement('div'); card.className = 'nplugin-draft';
      card.dataset.chatNode = 'plugin-draft:' + key(file);
      card.dataset.pluginDraftIdentity = identity; card.dataset.pluginDraftAt = String(file.at || 0);
      card.dataset.pluginDraftRevision = revision;
      card.dataset.pluginDraftHistorical = String(owned === null);
      if (owned) card.dataset.pluginDraftOwner = draftPlacement.ownerIndex(target, snapshot);
      const mark = root.ownerDocument.createElement('span'); mark.className = 'nplugin-draft-icon'; mark.setAttribute('aria-hidden', 'true');
      mark.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 4H5a1 1 0 0 0-1 1v4h2a3 3 0 0 1 0 6H4v4a1 1 0 0 0 1 1h4v-2a3 3 0 0 1 6 0v2h4a1 1 0 0 0 1-1v-4h-2a3 3 0 0 1 0-6h2V5a1 1 0 0 0-1-1h-4V3a3 3 0 0 0-6 0z"/></svg>';
      const copy = root.ownerDocument.createElement('div'); copy.className = 'nplugin-draft-copy';
      const label = root.ownerDocument.createElement('b'); label.textContent = file.pluginName || '插件已生成';
      if (file.pluginName) label.setAttribute('data-user-content', '');
      const hint = root.ownerDocument.createElement('span'); hint.textContent = owned === null ? '会话中已生成的插件，可检查并安装' : '检查内容后，安装到我的 SoduWork';
      copy.append(label, hint);
      const install = root.ownerDocument.createElement('button'); install.type = 'button';
      install.className = 'btn-mini primary'; install.dataset.installPluginDraft = key(file);
      install.dataset.pluginDraftRef = ref; install.textContent = '检查并安装';
      const error = root.ownerDocument.createElement('p'); error.className = 'nplugin-draft-error'; error.setAttribute('role', 'alert'); error.hidden = true;
      card.append(mark, copy, install, error); target.appendChild(card);
    }
  }
  const isImage = file => /\.(?:png|jpe?g|gif|webp|ico)$/i.test(String(file?.name || file?.relative || file?.path || ''));
  const isVideo = file => /\.(?:mp4|m4v|webm|mov|ogv)$/i.test(String(file?.name || file?.relative || file?.path || ''));
  function claimInlineMedia(file, shown) {
    const id = key(file);
    if (!id || file?.deleted || file?.processEvidence || shown.has(id)) return false;
    shown.add(id);
    return true;
  }
  function imageCard(doc, file, ref) {
    const card = doc.createElement(global.ChatMedia ? 'div' : 'button');
    card.type = 'button'; card.className = 'noutput-image';
    card.dataset.outputImage = key(file);
    card.dataset.outputVersion = String(file.at || 0);
    card.dataset.outputScope = ref;
    card.setAttribute('aria-label', '在右侧查看图片：' + file.name);
    card.title = '在右侧查看：' + file.name;
    if (global.ChatMedia) {
      card.tabIndex = 0; card.setAttribute('role', 'button');
      card.classList.add('nmedia-local');
      card.append(global.ChatMedia.card(doc, 'image', file.name));
      card.removeAttribute('title');
      return card;
    }
    const caption = doc.createElement('span'); caption.className = 'noutput-image-caption';
    const name = doc.createElement('span'); name.textContent = file.name;
    const hint = doc.createElement('small'); hint.textContent = file.processEvidence ? '验证截图' : '右侧查看';
    caption.append(name,hint); card.append(caption);
    return card;
  }
  function inlineImages(root, files, ref) {
    files = asFiles(files);
    const doc = root.ownerDocument, shown = new Set([...root.querySelectorAll('[data-output-image],[data-delivery-preview]')]
      .map(node => node.dataset.outputImage || node.dataset.deliveryPreview));
    const outputMessage = message => !/^(?:tools|process):/.test(message.dataset.chatNode || '');
    const messages = [...root.querySelectorAll('.nmsg.ai,[data-task-stream]')].filter(message => outputMessage(message) && message.dataset.deliveryFinal !== 'false');
    // Explicit screenshots are previewable evidence even when they are not
    // deliverables. Keep their inline image on the same turn's final reply so
    // folding the process cannot hide the only way to open the right workbench.
    // Walk back to the user boundary; task streams must not borrow another owner.
    const owners = new Map();
    [...root.querySelectorAll('.nmsg.user,.nmsg.ai,[data-task-stream]')].reverse().forEach(message => {
      if (message.classList.contains('user')) { owners.clear(); return; }
      if (!outputMessage(message)) return;
      const task = message.dataset.outputTask || message.dataset.taskStream || '';
      if (message.dataset.deliveryFinal !== 'false') owners.set(task, message);
      const target = owners.get(task);
      const candidates = new Map(), available = scoped(message,files);
      message.querySelectorAll('[data-output-image-ref]').forEach(node => {
        const file = fileTarget(node.dataset.outputImageRef,available);
        if (file && !file.deleted && isImage(file)) {
          candidates.set(key(file),file);
          if (file.processEvidence || !target) node.replaceWith(button(doc,file,node.textContent || file.name));
          else node.remove();
        }
      });
      message.querySelectorAll('[data-open-app]').forEach(node => {
        const file = available.find(item=>key(item)===node.dataset.openApp);
        if (file && isImage(file)) candidates.set(key(file),file);
      });
      candidates.forEach(file => {
        if (!target || file.deleted || shown.has(key(file))) return;
        // This branch requires an explicit reference resolved in the trusted
        // index. The implicit current-turn fallback below still rejects evidence.
        shown.add(key(file)); target.appendChild(imageCard(doc,file,ref));
      });
    });
    // Explicit, current-turn image deliverables also appear when the agent did
    // not repeat their filename. Do not dump unrelated workspace assets.
    files.filter(file=>isImage(file) && file.changedInTurn && file.primary!==false && !shown.has(key(file)))
      .forEach(file=>{
        const target = messages.filter(message=>message.dataset.deliveryCurrent !== 'false' && (!file.taskId || message.dataset.outputTask===file.taskId ||
          message.dataset.taskStream===file.taskId)).pop();
        if (target && claimInlineMedia(file, shown)) target.appendChild(imageCard(doc,file,ref));
      });
  }
  function videoCard(doc, file, ref) {
    const card = doc.createElement('figure');
    card.className = 'noutput-video'; card.dataset.outputVideo = key(file);
    card.dataset.outputVersion = String(file.at || 0); card.dataset.outputScope = ref;
    if (global.ChatMedia) {
      card.classList.add('nmedia-local');
      card.append(global.ChatMedia.card(doc, 'video', file.name));
      card.tabIndex = 0; card.setAttribute('role', 'button');
      return card;
    }
    const frame = doc.createElement('span'); frame.className = 'noutput-video-frame';
    const video = doc.createElement('video'); video.controls = true; video.preload = 'metadata';
    video.playsInline = true; video.setAttribute('aria-label', '播放视频：' + file.name);
    const loading = doc.createElement('span'); loading.className = 'noutput-video-loading'; loading.textContent = '正在准备视频…';
    frame.append(video, loading);
    const caption = doc.createElement('figcaption');
    const name = doc.createElement('span'); name.textContent = file.name;
    const open = doc.createElement('button'); open.type = 'button'; open.dataset.openApp = key(file); open.textContent = '右侧查看';
    caption.append(name, open); card.append(frame, caption);
    return card;
  }
  function inlineVideos(root, files, ref) {
    files = asFiles(files);
    const doc = root.ownerDocument, shown = new Set([...root.querySelectorAll('[data-output-video]')].map(node => node.dataset.outputVideo));
    const messages = [...root.querySelectorAll('.nmsg.ai,[data-task-stream]')].filter(message => message.dataset.deliveryFinal !== 'false');
    // Prefer the latest mention so a long run cannot repeat one image throughout the chat.
    [...messages].reverse().forEach(message => {
      const available = scoped(message, files);
      message.querySelectorAll('[data-open-app]').forEach(node => {
        const file = available.find(item => key(item) === node.dataset.openApp);
        if (file && isVideo(file) && claimInlineMedia(file, shown)) {
          message.appendChild(videoCard(doc, file, ref));
        }
      });
    });
    files.filter(file => isVideo(file) && file.changedInTurn && file.primary !== false && !shown.has(key(file)))
      .forEach(file => {
        const target = messages.filter(message => message.dataset.deliveryCurrent !== 'false' && (!file.taskId || message.dataset.outputTask === file.taskId ||
          message.dataset.taskStream === file.taskId)).pop();
        if (target && claimInlineMedia(file, shown)) target.appendChild(videoCard(doc, file, ref));
      });
  }
  async function taskAttachment(file, hub) {
    const rows=await hub.listAttachments(file.taskId);
    const row=(rows||[]).find(item=>item.id===file.attachmentId && isOutput(item));
    if(!row || !/^\/(?:api\/v1\/)?attachments\/[^/?#]+\?/.test(row.url||'')) throw Error('这份成果暂时不可用，请刷新后重试');
    return {...row,url:hub.attachmentUrl(row)};
  }
  async function readPreview(file, api, ref, mode='read') {
    if (file.cloudPending && !file.processEvidence) file = await materialize(file, api, ref, { previewOnly: true });
    if (file.taskId && file.attachmentId) {
      const row = await taskAttachment(file,global.SoduWorkAPI);
      if (mode === 'preview' && isVideo(file)) {
        const url = String(row.url || '');
        return videoUrl({ok:true,url}) ? {ok:true,url,mimeType:row.mimeType||''} :
          {ok:false,reason:'视频地址无效'};
      }
      return global.soduWorkAPI.previewAttachment({...row,inlineText:mode==='read',inlineImage:mode!=='read'});
    }
    if (file.artifactId && api?.artifactAction) return api.artifactAction(ref,file.artifactId,mode);
    if (mode==='read' && file.path && api?.readOutput) return api.readOutput(ref,file.path);
    return {ok:false,reason:'当前成果暂时不能预览，请刷新后重试'};
  }
  function imageUrl(reply) {
    return reply?.ok && /^image\/(?:png|jpeg|gif|webp|bmp|avif|x-icon)$/.test(reply.mimeType||'') &&
      /^[A-Za-z0-9+/=\r\n]+$/.test(reply.data||'') ? 'data:'+reply.mimeType+';base64,'+reply.data : '';
  }
  function videoUrl(reply) {
    const url = reply?.ok ? String(reply.url || '') : '';
    try {
      const parsed = new URL(url);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.pathname && parsed.pathname !== '/' ? url : '';
    } catch (_) { return ''; }
  }
  // Read only indexed images through the authorized preview bridge. Async
  // replies must still belong to the mounted card, account and conversation.
  const loadingImages = new WeakSet();
  function mediaOwnerCurrent(owner, options) {
    const scope = global.SoduWorkAPI?.taskStorageKey?.('ops'), version = owner.dataset.outputVersion;
    return () => owner.isConnected && owner.dataset.outputScope === options.ref &&
      owner.dataset.outputVersion === version && scope === global.SoduWorkAPI?.taskStorageKey?.('ops');
  }
  function hydrateImages(root, files, options = {}) {
    if (global.ChatMedia) {
      root.querySelectorAll('[data-output-image] .nmedia-item').forEach(node => {
        const file = asFiles(files).find(item => key(item) === node.closest('[data-output-image]').dataset.outputImage);
        if (file) {
          const owner = node.closest('[data-output-image]');
          if (owner.dataset.outputScope !== options.ref) return;
          const current = mediaOwnerCurrent(owner, options);
          owner.onkeydown = event => { if (event.target === owner && ['Enter', ' '].includes(event.key)) { event.preventDefault(); owner.click(); } };
          global.ChatMedia.load(node, async () => {
            const reply = await readPreview(file, options.api, options.ref, 'image-full');
            return current() ? imageUrl(reply) : '';
          });
        }
      });
      return;
    }
    const scope = global.SoduWorkAPI?.taskStorageKey?.('ops');
    root.querySelectorAll('[data-output-image]').forEach(async node => {
      if (loadingImages.has(node) || node.dataset.imageState === 'error' ||
          (node.dataset.imageState === 'ready' && node.querySelector('img'))) return;
      const file = asFiles(files).find(item => key(item) === node.dataset.outputImage);
      if (!file || !isImage(file) || node.dataset.outputScope !== options.ref) return;
      const version = node.dataset.outputVersion;
      const valid = () => node.isConnected && node.dataset.outputScope === options.ref &&
        node.dataset.outputVersion === version && scope === global.SoduWorkAPI?.taskStorageKey?.('ops');
      loadingImages.add(node);
      node.dataset.imageState = 'loading';
      const hint = node.querySelector('small');
      if (hint) hint.textContent = '正在加载图片…';
      try {
        const reply = await readPreview(file, options.api, options.ref, 'image');
        const src = imageUrl(reply);
        if (!src) throw Error(reply?.reason || '图片暂时无法预览');
        if (!valid()) return;
        const image = node.ownerDocument.createElement('img');
        image.alt = file.name || '验证截图'; image.src = src; image.decoding = 'async';
        node.insertBefore(image, node.firstChild);
        node.dataset.imageState = 'ready';
        if (hint) hint.textContent = '右侧查看';
      } catch (error) {
        if (valid()) { node.dataset.imageState = 'error'; if (hint) hint.textContent = error.message || '图片暂时无法预览'; }
      } finally { loadingImages.delete(node); }
    });
  }
  function hydrateVideos(root, files, options) {
    files = asFiles(files);
    if (global.ChatMedia) {
      root.querySelectorAll('[data-output-video] .nmedia-item').forEach(node => {
        const file = files.find(item => key(item) === node.closest('[data-output-video]').dataset.outputVideo);
        if (file) {
          const owner = node.closest('[data-output-video]');
          if (owner.dataset.outputScope !== options.ref) return;
          const current = mediaOwnerCurrent(owner, options);
          owner.onkeydown = event => { if (event.target === owner && ['Enter', ' '].includes(event.key)) { event.preventDefault(); owner.click(); } };
          global.ChatMedia.load(node, async () => {
            const reply = await readPreview(file, options.api, options.ref, 'preview');
            return current() ? videoUrl(reply) : '';
          });
        }
      });
      return;
    }
    root.querySelectorAll('[data-output-video]').forEach(async node => {
      if (node.dataset.videoState) return;
      const file = files.find(item => key(item) === node.dataset.outputVideo);
      if (!file || !isVideo(file)) return;
      node.dataset.videoState = 'loading';
      try {
        const reply = await readPreview(file, options.api, options.ref, 'preview');
        const src = videoUrl(reply);
        if (!src) throw Error(reply?.reason || '视频暂时无法预览');
        if (!node.isConnected) return;
        const video = node.querySelector('video'); video.src = src;
        node.dataset.videoState = 'ready'; node.querySelector('.noutput-video-loading').textContent = '';
      } catch (error) {
        if (node.isConnected) { node.dataset.videoState = 'error';
          node.querySelector('.noutput-video-loading').textContent = error.message || '视频暂时无法预览'; }
      }
    });
  }
  function sanitize(html, purifier) {
    // Conversation markup shares the app DOM. DOMPurify's defaults still allow
    // nested styles and style attributes, which can hide the composer or alter
    // other chats when history is rendered. Webpage previews have their own host.
    const policy = { FORBID_TAGS: ['style', 'link', 'meta', 'base', 'video', 'audio', 'source', 'picture'], FORBID_ATTR: ['style'] };
    if (!/<img\b|href\s*=\s*["'](?:file:|sandbox:|[a-z]:[\\/])/i.test(html)) return purifier.sanitize(html, policy);
    // Retain local Markdown destinations as inert data BEFORE the sanitizer
    // strips file:/drive-letter hrefs. They still require an index match to open.
    const template=document.createElement('template');template.innerHTML=html;
    template.content.querySelectorAll('img').forEach(img=>{
      // Inert until matched against the authorized output index; do not let
      // model-authored markup load arbitrary local files or tracking URLs.
      const placeholder=document.createElement('span');
      placeholder.dataset.outputImageRef=img.getAttribute('src')||'';
      placeholder.textContent=img.getAttribute('alt')||'图片';
      img.replaceWith(placeholder);
    });
    template.content.querySelectorAll('a[href]').forEach(anchor=>{
      const href=anchor.getAttribute('href')||'';
      if (/^(?:file:|sandbox:|[a-z]:[\\/])/i.test(href)) {
        anchor.setAttribute('data-output-href',href);anchor.removeAttribute('href');
      }
    });
    return purifier.sanitize(template.innerHTML, policy);
  }
  const outputRoles = new Set(['output', 'evidence', 'supporting', 'verification']);
  const evidenceKinds = new Set(['deploy_screenshot', 'screenshot', 'screen_shot', 'screen_capture', 'verification', 'test_evidence']);
  function rowEvidenceMeta(row) {
    return row && row.evidenceMeta && typeof row.evidenceMeta === 'object' ? row.evidenceMeta : {};
  }
  function isValidationEvidence(row) {
    if (!row) return false;
    const role = String(row.role || '').toLowerCase();
    const meta = rowEvidenceMeta(row);
    const normalizeTag = value => String(value || '').toLowerCase().replace(/[\s-]+/g, '_');
    const kind = normalizeTag(meta.kind || meta.type);
    const category = normalizeTag(meta.category || row.category);
    return role === 'evidence' || role === 'verification' || category === 'evidence' ||
      evidenceKinds.has(kind) || evidenceKinds.has(category);
  }
  const isOutput = row => row && outputRoles.has(String(row.role || '').toLowerCase());
  async function load(api, ref, taskIds, previous, hub) {
    const local = await api.outputs(ref);
    if (!local || local.ok === false) throw Error('成果索引暂时不可用');
    // `artifacts` is intentionally a compact primary list (for example an
    // HTML entry point and an archive).  Cloud tasks can also return the
    // supporting files that make that entry point usable.  Keep those files
    // as a separate fallback and promote only rows that the Hub explicitly
    // identifies as deliverables; this avoids leaking validation screenshots
    // or arbitrary workspace files into a result card.
    // Preserve the compact-index semantics: an explicitly present `artifacts`
    // array is authoritative (including an intentionally empty array).  Older
    // sessions only expose `files`, so keep that compatibility fallback when
    // no artifact index was written at all.
    const files = Array.isArray(local.artifacts) ? local.artifacts.slice() :
      Array.isArray(local.deliverables) && local.deliverables.length ? local.deliverables.slice() :
        asFiles(local.files);
    const allLocalFiles = asFiles(local.files);
    if (local.delivery?.presentation === 'summary' || local.deliveryPresentation === 'summary' ||
        local.deliveryMode === 'git' || local.codeDelivery) {
      return files.map(file => ({ ...file, primary: false }));
    }
    const tasks = await Promise.all([...new Set(taskIds)].filter(Boolean).map(async taskId => {
      if (!hub || typeof hub.listAttachments !== 'function') return [];
      try {
        const rows=await hub.listAttachments(taskId);
        return (rows||[]).filter(isOutput).map(row=>({
          // Keep the server's role/evidence metadata on the opaque client
          // entry. Cloud attachment rows predate `primary`; deriving it from
          // role prevents validation screenshots from becoming deliverables,
          // while a declared output image remains a user-visible result.
          ...(() => {
            const meta = rowEvidenceMeta(row);
            const evidence = isValidationEvidence(row);
            const role = String(row.role || '').toLowerCase();
            return {
              primary: !evidence && String(meta.category || row.category || '') !== 'supporting' &&
                (row.primary == null ? role === 'output' : row.primary !== false),
              processEvidence: evidence,
              evidenceMeta: meta,
              category: meta.category || row.category || '',
            };
          })(),
          artifactId:'task-output:'+encodeURIComponent(taskId)+':'+encodeURIComponent(row.id),
          taskId, attachmentId:row.id, name:row.filename, relative:row.filename,
          size:row.size, at:Number(row.createdAt)||Date.parse(row.createdAt||'')||0,
          sha256:row.sha256 || row.evidenceMeta?.sha256,
          // Task outputs are immutable remote deliverables. Mark the current
          // output explicitly so a generated HTML site is opened once in the
          // right-side workbench as soon as the cloud task settles.
          changedInTurn: String(row.role || '').toLowerCase() === 'output', kind:'task-file', sourceRef:row.sourceRef||'', role:row.role, round: Number(row.evidenceMeta?.round) || 0,
        }));
      } catch (_) { return (previous||[]).filter(file=>file.taskId===taskId); }
    }));
    // A settled cloud task is copied into the passive view's local result
    // directory. Merge its attachment metadata without retaining taskId on
    // the local entry: openOutput must use the local artifact IPC path rather
    // than opening the Hub's attachment URL as a system download.
    const proofs = Array.isArray(local.cloudOutputs) ? local.cloudOutputs : [];
    // Cloud-session local rows require main-process proof; matching name and size alone are insufficient.
    // For local sessions, the workspace is the device's authoritative file source.
    const cloudConversation = Array.isArray(local.cloudOutputs);
    const remote = [];
    const newest = new Map();
    const claimed = new Set();
    tasks.flat().forEach(row => {
      const id = row.taskId + ':' + normalize(row.relative).toLowerCase();
      if (!newest.has(id) || row.at >= newest.get(id).at) newest.set(id, row);
    });
    [...newest.values()].forEach(row => {
      // A filename is not proof of origin. Only the main process can attest
      // that these exact task/attachment bytes were materialized locally.
      const proof = proofs.find(item => item.taskId === row.taskId && item.attachmentId === row.attachmentId &&
        normalize(item.relative) === normalize(row.relative) && Number(item.size) === Number(row.size));
      let exact = proof && files.find(file => file.artifactId === proof.artifactId);
      // Supporting files are available from the trusted local index, but
      // should enter the visible result set only when a matching remote
      // deliverable proves that they belong to this cloud task.
      if (!exact && proof) {
        const supplemental = allLocalFiles.find(file => normalize(file.relative) === normalize(proof.relative));
        if (supplemental) {
          exact = supplemental;
          files.push(supplemental);
        }
      }
      const local = exact;
      if (local && !local.taskId) {
        local.remoteMaterialized = true;
        local.cloudTaskId = row.taskId;
        local.remoteAttachmentId = row.attachmentId;
        local.role = row.role || local.role || 'output';
        local.primary = row.primary;
        local.processEvidence = row.processEvidence;
        local.evidenceMeta = row.evidenceMeta;
      } else if (!local && !cloudConversation) {
        // Local-session delivery sync has no proof receipt, but its workspace is authoritative.
        // A unique name-and-size match can identify the local and remote rows for the same
        // upload. Retain attachment identity on the local row for library and task scoping,
        // then remove the remote duplicate so opening resolves to local bytes rather than a Hub URL.
        // Do not pair ambiguous local rows with identical names and sizes.
        const name = normalize(row.relative);
        const size = Number(row.size) || 0;
        const match = candidates => (candidates || []).filter(file => !file.taskId && !claimed.has(file) &&
          normalize(file.relative || file.name || file.path || '') === name &&
          (Number(file.size) || 0) === size && size > 0);
        let pair = match(files);
        if (pair.length !== 1) pair = match(allLocalFiles);
        if (pair.length === 1) {
          const found = pair[0];
          claimed.add(found);
          // A fallback match may exist only in local.files, outside the compact artifacts list.
          // Add the matched row to the result so successful pairing cannot hide the delivery.
          if (!files.includes(found)) files.push(found);
          found.remoteMaterialized = true;
          found.taskId = row.taskId;
          found.attachmentId = row.attachmentId;
          found.remoteAttachmentId = row.attachmentId;
          found.role = row.role || 'output';
          found.primary = row.primary;
          found.processEvidence = row.processEvidence;
          found.evidenceMeta = row.evidenceMeta;
          found.round = row.round;
        } else remote.push(row);
      } else remote.push(row);
    });
    return [...files, ...remote];
  }
  const materializePending = new Map();
  async function materialize(file, api, ref, { previewOnly = false } = {}) {
    if (!file?.cloudPending) return file;
    if (!api?.cloud?.materialize || !ref) throw Error('云端成果暂时无法保存，请重新打开会话后再试');
    const id = JSON.stringify([ref, file.taskId, file.attachmentId, previewOnly]);
    if (materializePending.has(id)) return materializePending.get(id);
    const pending = (async () => {
      const result = await api.cloud.materialize(ref, { taskId: file.taskId, attachmentId: file.attachmentId, ...(previewOnly ? { previewOnly: true } : {}) });
      if (!result?.ok || !result.artifact?.artifactId) throw Error(result?.reason || '云端成果保存失败，请重试');
      const local = { ...file, ...result.artifact, remoteMaterialized: true,
        cloudTaskId: file.taskId, remoteAttachmentId: file.attachmentId,
        materializedArtifacts: Array.isArray(result.artifacts) ? result.artifacts : [result.artifact] };
      delete local.taskId; delete local.attachmentId; delete local.cloudPending;
      return local;
    })().finally(() => materializePending.delete(id));
    materializePending.set(id, pending); return pending;
  }
  async function openTaskFile(file, hub, bridge) {
    if (!file || !file.taskId || !file.attachmentId) return false;
    if (file.cloudPending) throw Error('云端成果正在准备，请稍后重试');
    const rows=await hub.listAttachments(file.taskId);
    const row=(rows||[]).find(item=>item.id===file.attachmentId && isOutput(item));
    if(!row)throw Error('这份成果暂时不可用，请刷新后重试');
    // A fresh authorized attachment listing mints the short-lived ticket.
    // Neither ticket nor arbitrary executor paths are rendered in the message.
    if(!/^\/(?:api\/v1\/)?attachments\/[^/?#]+\?/.test(row.url||''))throw Error('成果地址无效');
    const url=hub.attachmentUrl(row);
    if(!/^https?:\/\//i.test(url))throw Error('成果地址无效');
    const filename = row.filename || file.name || '\u6210\u679c';
    // The main process owns the authorized download and system-app handoff.
    // This keeps office/archive outputs out of the right-side renderer while
    // still opening them with Excel/PowerPoint/Word or the user's configured app.
    if (bridge && typeof bridge.previewAttachment === 'function') {
      const result = await bridge.previewAttachment({ url, filename });
      if (result && result.ok === false && !result.canceled) throw Error(result.reason || '\u65e0\u6cd5\u6253\u5f00\u6210\u679c');
      return result?.canceled ? false : true;
    }
    // Older clients do not expose the handoff bridge. Keep the explicit save
    // dialog as a compatibility fallback so the file remains recoverable.
    if(!bridge || typeof bridge.downloadAttachment !== 'function') throw Error('\u8bf7\u5347\u7ea7\u5ba2\u6237\u7aef\u540e\u91cd\u8bd5');
    const result=await bridge.downloadAttachment({url,filename});
    if(result && result.ok===false && !result.canceled)throw Error(result.reason||'\u65e0\u6cd5\u4fdd\u5b58\u6210\u679c');
    return true;
  }
  const materializeTaskPending = new Map();
  async function materializeTask(file, api, ref, { previewOnly = false } = {}) {
    if (!file?.taskId || !file.attachmentId) throw Error('这份成果无法保存到本地');
    const bridge = global.soduWorkAPI;
    if (!bridge || typeof bridge.attachmentMaterialize !== 'function') throw Error('请升级客户端后重试');
    const id = JSON.stringify([ref, file.taskId, file.attachmentId, previewOnly]);
    if (materializeTaskPending.has(id)) return materializeTaskPending.get(id);
    const pending = (async () => {
      const result = await bridge.attachmentMaterialize({ ref, taskId: file.taskId, attachmentId: file.attachmentId, ...(previewOnly ? { previewOnly: true } : {}) });
      if (!result?.ok) throw Error(result?.reason || '成果保存失败，请重试');
      const mine = (result.artifacts || []).find(item => String(item.attachmentId || '') === String(file.attachmentId));
      if (!mine) throw Error('成果未完整保存，请重试');
      // Temporary attachment artifactId values such as task-output: are not local index IDs.
      // Remove them before routing to prevent lookups of nonexistent local artifacts.
      const local = { ...file, ...mine, artifactId: '', remoteMaterialized: true,
        cloudTaskId: file.taskId, remoteAttachmentId: file.attachmentId };
      delete local.cloudPending;
      return local;
    })().finally(() => materializeTaskPending.delete(id));
    materializeTaskPending.set(id, pending); return pending;
  }
  function shouldRefresh(event, before) {
    const after=event.snapshot||{}, execution=after.execution||{}, previous=before?.execution||{};
    // Delivery receipts can arrive after the session's settled publication
    // (the local writer flushes the artifact index asynchronously). Treat the
    // receipt as a first-class refresh signal so cards and automatic preview
    // see the final materialized files without relying on a later snapshot.
    if(['settled','task-message','plugin-debug','delivery-sync'].includes(event.kind)) return true;
    if(['streaming','running','queued'].includes(before?.status) &&
        !['streaming','running','queued'].includes(after.status))return true;
    if(previous.running && !execution.running)return true;
    const changed=(execution.taskExecutions||[]).some(row=>
      ['completed','failed','stopped','waiting'].includes(row.status) &&
      !(previous.taskExecutions||[]).some(old=>old.taskId===row.taskId && old.runId===row.runId && old.status===row.status));
    return changed;
  }
  // Session switches reuse identical text nodes via patchList; entries are
  // keyed by (ref + files) signatures so they can never leak across sessions,
  // and the WeakMap drops entries for replaced nodes on its own.
  function resetDecorateCache() { decorateMemo = null; }
  const api={fileTarget,workspaceFileTarget,mergeFileChanges,mentions,linkify,decorate,sanitize,load,taskAttachment,openTaskFile,materialize,materializeTask,shouldRefresh,
    isImage,isVideo,readPreview,imageUrl,videoUrl,hydrateImages,hydrateVideos,
    isPluginDraft,pluginDrafts,_supersededDraftCard:supersededDraftCard,_claimInlineMedia:claimInlineMedia,
    _buildLinkIndex:buildLinkIndex,_decorateStateSignature:decorateStateSignature,resetDecorateCache};
  global.ChatOutputLinks=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
