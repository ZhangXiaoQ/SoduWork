(function (global) {
  'use strict';
  const tx = value => (global.SoduWorkI18n && typeof global.SoduWorkI18n.translateText === 'function'
    ? global.SoduWorkI18n.translateText(value) : value) || value;
  function node(tag, text, className) {
    const el = document.createElement(tag); if (text) el.textContent = text;
    if (className) el.className = className; return el;
  }
  function create(el, options) {
    const button = el.querySelector('#nchatRuntime');
    if (!button) return { render() {}, reset() {}, destroy() {} };
    const life = new AbortController(), on = (node, type, fn) => node.addEventListener(type, fn, { signal: life.signal });
    const pop = document.createElement('div'); pop.className = 'nchat-access-pop nchat-runtime-pop cp-runtime-pop'; pop.hidden = true;
    pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', tx('切换 Agent')); button.after(pop);
    const missingWrap = el.querySelector('#nchatRuntimeAvailability'), missing = el.querySelector('#nchatRuntimeMissing'), more = el.querySelector('#nchatRuntimeMore');
    let ref = '', lastIdentity = '', generation = 0, saving = false, request = null;
    let availability = null, availabilityAt = 0, availabilityFlight = null, checkingId = '';
    let availabilityGeneration = 0, scopeGeneration = 0, refreshRequested = false;
    const api = () => global.soduWorkAPI?.conversationSession;
    const close = () => { generation++; pop.hidden = true; button.setAttribute('aria-expanded', 'false'); };
    function scope(state = options.state()) {
      const identity = state.ref || (state.draftOnly ? 'draft:' + state.draftId : '');
      if (!identity) return '';
      const cloud = state.cloudHandoff;
      return JSON.stringify([global.SoduWorkAPI?.taskStorageKey?.('ops') || '', identity,
        cloud?.phase || '', cloud?.transferId || '', cloud?.ref || '', cloud?.target?.runnerId || '']);
    }
    function invalidateAvailability(force = false) {
      availabilityGeneration++; availability = null; availabilityAt = 0;
      refreshRequested = refreshRequested || force;
    }
    function syncScope(state = options.state()) {
      const identity = scope(state);
      if (lastIdentity !== identity) {
        scopeGeneration++;
        lastIdentity = identity; ref = state.ref || ''; saving = false; request = null; checkingId = '';
        invalidateAvailability(); availabilityFlight = null; refreshRequested = false; refreshAfterSelection = false;
        close(); paintMissing(null);
      }
      return identity;
    }
    const currentScope = identity => !life.signal.aborted && identity === lastIdentity && identity === scope();
    const freshAvailability = () => availability?.ok && Date.now() >= availabilityAt && Date.now() - availabilityAt < 30000;
    function openAgents() {
      const targetRef = options.state().ref, cloud = !!options.state().cloudHandoff;
      const invoke = () => {
        if (options.state().ref !== targetRef || !!options.state().cloudHandoff !== cloud) return false;
        try {
          if (options.state().cloudHandoff) {
            if (global.WorkspaceHost?.open) return global.WorkspaceHost.open('cloud');
            return global.openCloudEnvironmentsPanel?.() || false;
          }
          if (typeof global.openAgentsEntry === 'function') return global.openAgentsEntry();
          if (typeof global.openAgentsPanel === 'function') return global.openAgentsPanel();
          if (global.WorkspaceHost && typeof global.WorkspaceHost.open === 'function') return global.WorkspaceHost.open('agents');
        } catch (_) { /* The workspace bridge may still be mounting on first open. */ }
        return false;
      };
      const opened = invoke();
      if (opened !== false) return opened;
      setTimeout(() => invoke(), 0);
      setTimeout(() => invoke(), 80);
      return false;
    }
    function paintMissing(result) {
      if (!missingWrap || !missing || !more) return;
      const rows = (Array.isArray(result && result.missing) ? result.missing : []).filter(row => row && row.id !== 'pi');
      missing.replaceChildren(...rows.slice(0, 6).map(row => {
        const icon = node('span', '', 'wc-runtime-missing-icon');
        icon.dataset.runtimeMissing = row.id || ''; icon.title = tx(row.displayName || row.id || '');
        icon.setAttribute('aria-hidden', 'true');
        const src = global.AgentBrand?.ICONS?.[row.id];
        if (src) {
          const image = node('img'); image.src = src; image.alt = ''; image.draggable = false;
          image.className = 'agent-brand'; icon.append(image);
        } else icon.textContent = '•';
        return icon;
      }));
      missingWrap.hidden = rows.length === 0; missing.hidden = rows.length === 0; more.hidden = rows.length === 0;
      missingWrap.setAttribute('aria-hidden', String(rows.length === 0));
      const names = rows.map(row => tx(row.displayName || row.id)).filter(Boolean).join('、');
      missing.setAttribute('aria-label', tx('缺失的执行底座') + (names ? '：' + names : ''));
      const cloud = !!options.state().cloudHandoff;
      more.textContent = tx('更多'); more.title = tx(cloud ? '打开云端电脑，安装或修复云端底座' : '打开 Agent 管理，安装或修复执行底座');
      more.setAttribute('aria-label', tx(cloud ? '打开云端电脑' : '打开 Agent 管理'));
    }
    function attachFooter() {
      if (!missingWrap) return;
      missingWrap.classList.add('cp-runtime-availability-footer');
      if (missingWrap.parentNode !== pop) pop.appendChild(missingWrap);
      if (more) more.disabled = Boolean(saving);
    }
    // Keep the management entry in the picker from the moment the component
    // is created. Availability probes can finish while the picker is closed.
    attachFooter();
    function rowsFrom(result) {
      const declared = Array.isArray(result && result.runtimes) ? result.runtimes : [];
      const rows = Array.isArray(result && result.availableRuntimes)
        ? result.availableRuntimes : declared.filter(row => row && row.id === 'pi');
      if (!Array.isArray(rows)) return [];
      const pi = declared.find(row => row && row.id === 'pi');
      const available = pi && !rows.some(row => row && row.id === 'pi') ? [pi, ...rows] : rows;
      return available.slice().sort((a, b) => Number(a.order || 999) - Number(b.order || 999));
    }
    function renderLoading() {
      const heading = node('div', '', 'cp-runtime-heading');
      const title = node('span'); title.append(node('b', tx('选择执行底座')));
      heading.append(title, node('em', '…'));
      pop.replaceChildren(heading, node('p', tx('正在读取可用执行底座…'), 'nchat-access-note'));
      attachFooter();
    }
    function renderPicker(result) {
      const rows = rowsFrom(result);
      const heading = node('div', '', 'cp-runtime-heading');
      const title = node('span'); title.append(node('b', tx('选择执行底座')));
      heading.append(title, node('em', rows.length + ' ' + tx('个底座')));
      const host = node('div', '', 'cp-runtime-rows');
      const groups = [[tx('推荐'), rows.filter(row => row.group !== 'more')], [tx('更多底座'), rows.filter(row => row.group === 'more')]];
      for (const [label, group] of groups) {
        if (!group.length) continue;
        host.append(node('div', label, 'cp-runtime-group' + (label === tx('推荐') ? ' is-first' : '')));
        for (const runtime of group) {
          const selected = runtime.id === options.state().adapterId;
          const choice = node('button', '', 'wc-pop-row cp-runtime-row');
          choice.type = 'button'; choice.dataset.runtime = runtime.id; choice.dataset.sessionAgent = runtime.id;
          choice.setAttribute('aria-selected', String(selected)); choice.setAttribute('aria-pressed', String(selected));
          choice.classList.toggle('on', selected);
          const src = global.AgentBrand?.ICONS?.[runtime.id];
          if (src) {
            const brand = node('span', '', global.AgentBrand.className(runtime.id, 'runtime-brand'));
            const image = node('img'); image.src = src; image.alt = ''; image.draggable = false;
            brand.append(image); choice.append(brand);
          } else choice.append(node('span', '•', 'runtime-brand'));
          const runtimeHealth = runtime.availability || {};
          const rawVersion = runtime.version || runtimeHealth.version || runtimeHealth.detectedVersion || '';
          const runtimeVersion = global.AgentBrand?.version({ key: runtime.id, version: rawVersion }) || rawVersion;
          const runtimeReady = runtimeHealth.ok === true || (Array.isArray(result && result.availableRuntimes) && result.availableRuntimes.some(row => row && row.id === runtime.id)) || (!Array.isArray(result && result.availableRuntimes) && runtime.id === 'pi');
          const runtimeChecking = checkingId === runtime.id;
          const copy = node('span', '', 'cp-runtime-copy');
          const head = node('span', '', 'cp-runtime-head');
          const name = node('b', runtime.displayName || runtime.id);
          name.title = name.textContent; name.setAttribute('data-user-content', ''); head.append(name);
          if (runtimeVersion) {
            const version = node('small', 'v' + runtimeVersion, 'cp-runtime-version');
            version.title = version.textContent; version.setAttribute('translate', 'no'); head.append(version);
          }
          const mode = node('small', tx(runtime.modelMode === 'account' ? '个人账号' : '企业模型'), 'cp-runtime-mode');
          mode.title = mode.textContent; head.append(mode);
          copy.append(head);
          const meta = node('span', '', 'cp-runtime-meta');
          const state = node('em', runtimeChecking ? tx('检测中') : (runtimeReady ? tx('可用') : (selected ? '' : tx('待检测'))), 'cp-runtime-state');
          state.title = state.textContent;
          state.dataset.state = runtimeChecking ? 'checking' : (runtimeReady ? 'ready' : 'unknown'); state.hidden = selected && !runtimeChecking;
          const check = node('b', '✓', 'wc-check'); check.setAttribute('aria-label', tx('当前底座')); check.hidden = !selected || checkingId === runtime.id;
          meta.append(state, check); choice.append(copy, meta); host.append(choice);
        }
      }
      if (!host.children.length) host.append(node('div', tx('暂时没有可用执行底座'), 'cp-runtime-empty'));
      const status = node('p', '', 'nchat-access-status'); status.setAttribute('role', 'status'); status.hidden = true;
      pop.replaceChildren(heading, host, status);
      attachFooter();
    }
    function loadAvailability(force = false) {
      const state = options.state(), identity = syncScope(state);
      if (!identity) return Promise.resolve(null);
      if (force) invalidateAvailability(true);
      if (availabilityFlight) return availabilityFlight;
      if (freshAvailability()) return Promise.resolve(availability);
      // Closing the picker does not cancel its shared inventory read. Changes
      // during that read require one fresh pass, never concurrent health probes.
      const job = Promise.resolve().then(async () => {
        while (currentScope(identity) && availabilityFlight === job) {
          const token = availabilityGeneration, forced = refreshRequested;
          refreshRequested = false;
          let result, failure;
          try {
            result = state.draftOnly ? await options.draft?.runtimes?.(forced)
              : await api()?.conversationRuntimes?.(state.ref, forced ? { force: true } : undefined);
          } catch (error) { failure = error; }
          if (!currentScope(identity) || availabilityFlight !== job) return null;
          if (token !== availabilityGeneration) continue;
          if (failure || !result?.ok) {
            availability = null; availabilityAt = 0;
            paintMissing(result || null); options.runtimeAvailability?.(result || null);
            throw failure || Error(result?.reason || tx('无法读取 Agent 列表'));
          }
          availability = result;
          // Preserve the host probe age instead of extending its 30-second TTL.
          availabilityAt = Number.isFinite(result.checkedAt) && result.checkedAt > 0
            ? Math.min(Date.now(), result.checkedAt) : Date.now();
          paintMissing(result); options.runtimeAvailability?.(result); return result;
        }
        return null;
      })
        .finally(() => { if (availabilityFlight === job) availabilityFlight = null; });
      availabilityFlight = job; return job;
    }
    let refreshAfterSelection = false;
    function refreshAvailability() {
      if (saving) { refreshAfterSelection = true; return; }
      refreshAfterSelection = false;
      const identity = syncScope();
      generation++;
      invalidateAvailability(true);
      paintMissing({ missing: [] });
      if (pop.hidden) return;
      renderLoading(); position();
      const pending = loadAvailability(), token = generation;
      pending.then(result => {
        if (token === generation && currentScope(identity) && !pop.hidden && result?.ok) { renderPicker(result); position(); }
      }).catch(error => {
        if (token === generation && currentScope(identity) && !pop.hidden) { pop.replaceChildren(node('p', error.message, 'nchat-access-note')); attachFooter(); position(); }
      });
    }
    function position() {
      global.WorkComposer.placeRuntime(button, pop);
    }
    function render() {
      const s = options.state();
      const identity = syncScope(s);
      const taskRuntime = Boolean(s.taskRuntime);
      button.disabled = (!s.ref && !s.draftOnly) || saving || s.runtimeSwitching || (s.cloudHandoff && s.cloudHandoff.phase !== 'committed');
      if (more) more.disabled = Boolean(saving);
      button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-busy', String(saving || !!s.runtimeSwitching));
      button.setAttribute('role', 'button'); button.title = tx('切换 Agent · 保留当前对话和工作目录');
      if (taskRuntime) { button.title = tx('需求已保存工程、分支和模型配置；执行结束后可切换 Agent'); }
      if (identity && !availability && !availabilityFlight) void loadAvailability().catch(() => {});
      if (!pop.hidden) position();
    }
    on(global, 'agent-runtimes-changed', refreshAvailability);
    on(global, 'soduwork-data-scope-changed', () => syncScope());
    on(global, 'soduwork-device-auth', () => syncScope());
    const offRuntimes = api()?.onRuntimesChanged?.(refreshAvailability);
    if (more) on(more, 'click', event => { event.stopPropagation(); close(); openAgents(); });
    on(global, 'soduwork-locale-change', () => {
      syncScope();
      pop.setAttribute('aria-label', tx('切换 Agent')); button.title = tx('切换 Agent · 保留当前对话和工作目录');
      if (availability) { paintMissing(availability); if (!pop.hidden) { renderPicker(availability); position(); } }
    });
    on(button, 'click', async event => {
      event.stopPropagation(); const identity = syncScope(); if (!pop.hidden) { close(); return; }
      // The model picker uses the browser popover top layer. Close it before
      // opening the runtime picker so the two menus cannot overlap and steal
      // clicks from the selected runtime row.
      const modelPop = el.querySelector('.nmodel-pop');
      if (modelPop && !modelPop.hidden) {
        modelPop.hidePopover?.(); modelPop.hidden = true; modelPop.classList?.remove('show');
        modelPop.previousElementSibling?.setAttribute('aria-expanded', 'false');
      }
      const state = options.state();
      if (state.busy) {
        options.say(state.recoveryRequired
          ? (state.recoveryReason || tx('执行状态尚未确认')) + '；' + tx('请先点击“核实执行状态”后再切换 Agent')
          : tx('请等待本轮和排队消息完成后切换 Agent')); return;
      }
      const cached = freshAvailability();
      if (cached) renderPicker(availability); else renderLoading();
      pop.hidden = false; button.setAttribute('aria-expanded', 'true'); position();
      if (cached) return;
      const pending = loadAvailability(), token = generation;
      try {
        const result = await pending;
        if (token !== generation || !currentScope(identity) || pop.hidden) return;
        if (!result?.ok) throw Error(result?.reason || tx('无法读取 Agent 列表'));
        renderPicker(result);
        position();
      } catch (error) { if (token === generation && currentScope(identity) && !pop.hidden) { pop.replaceChildren(node('p', error.message, 'nchat-access-note')); attachFooter(); position(); } }
    });
    on(pop, 'click', event => {
      if (lastIdentity !== scope()) { render(); return; }
      const row = event.target.closest('[data-runtime]');
      if (!row || saving) return;
      const selectedId = row.dataset.runtime || '';
      if (selectedId === options.state().adapterId) { close(); return; }
      const token = generation, activeRef = ref, identity = lastIdentity, scopeToken = scopeGeneration;
      saving = true; render();
      checkingId = selectedId;
      if (availability) renderPicker(availability);
      pop.querySelectorAll('[data-runtime]').forEach(b => { b.disabled = true; });
      const status = pop.querySelector('[role=status]'); if (status) { status.hidden = false; status.textContent = tx('正在切换…'); }
      request = (async () => {
        try {
          const result = options.state().draftOnly ? options.draft.selectRuntime(selectedId)
            : await api().selectAgent(activeRef, selectedId);
          if (token !== generation || !currentScope(identity)) return false;
          if (!result?.ok) throw Error(result?.reason || tx('切换未完成，原会话已保留'));
          checkingId = ''; options.runtimeSelected?.(result); close(); return true;
        } catch (error) {
          if (token === generation && currentScope(identity)) {
            checkingId = ''; if (status) status.textContent = error.message;
            pop.querySelectorAll('[data-runtime]').forEach(b => { b.disabled = false; });
          }
          return false;
        } finally { if (scopeToken === scopeGeneration && currentScope(identity)) {
          saving = false; request = null; render();
          if (refreshAfterSelection) refreshAvailability();
        } }
      })();
    });
    on(document, 'click', event => { if (!saving && !pop.contains(event.target) && !button.contains(event.target)) close(); });
    on(document, 'keydown', event => { if (event.key === 'Escape' && !saving && !pop.hidden) { event.preventDefault(); close(); button.focus(); } });
    on(global, 'resize', position);
    return { render, wait: () => request || Promise.resolve(true), reset: close,
      destroy() { close(); offRuntimes?.(); life.abort(); pop.remove(); } };
  }
  global.ChatRuntimePicker = { create };
})(window);
