/* Per-conversation Agent substrate selection. */
(function (global) {
  'use strict';

  /* Translate title/aria fragments before concatenation; preserve displayName and custom summaries as user data. */
  const _rtText = value => (global.SoduWorkI18n && typeof global.SoduWorkI18n.translateText === 'function'
    ? global.SoduWorkI18n.translateText(value) : value) || value;
  const FALLBACK = Object.freeze([
    { id: 'pi', displayName: 'Pi', summary: '低延迟办公与连续对话',
      modelMode: 'managed', goalMode: 'native', group: 'recommended', order: 10 },
    { id: 'codex-harness', displayName: 'Codex Harness', summary: '深度工程与完整交付',
      modelMode: 'managed', goalMode: 'native', group: 'recommended', order: 20 },
    { id: 'opencode', displayName: 'OpenCode', summary: '开放工程 Agent 与命令执行',
      modelMode: 'managed', goalMode: 'native', group: 'more', order: 30 },
    { id: 'codex', displayName: 'Codex', summary: '使用云端机器上的 Codex 账号执行',
      modelMode: 'account', goalMode: 'native', group: 'more', order: 50 },
    { id: 'qwen', displayName: 'Qwen Code', summary: '通过 ACP 接入的企业模型执行底座',
      modelMode: 'managed', goalMode: 'native', group: 'more', order: 60 },
    { id: 'dsh', displayName: 'DeepSeek Harness', summary: '通过 ACP 接入的 DeepSeek 执行底座',
      modelMode: 'managed', goalMode: 'native', group: 'more', order: 70 },
    { id: 'harness2', displayName: 'Google Harness²', summary: 'Harness² 文本推演后独立执行工具，增加耗时与模型用量',
      modelMode: 'managed', goalMode: 'native', group: 'more', order: 80 },
  ]);
  // Until the main process returns a health-checked projection, Pi is the only
  // safe local choice. Rendering the full declaration catalog here would let a
  // stale or offline Runner appear selectable during the probe window.
  let catalog = FALLBACK.filter((row) => row.id === 'pi');
  let missingCatalog = [];
  let current = 'pi';
  let location = 'local';
  // Keep the last choice for each execution location. A local account Agent
  // must not silently become the cloud choice (and vice versa) when the user
  // switches the new-chat location tabs.
  const selectedByLocation = { local: 'pi', cloud: 'pi' };
  const ownerScope = () => String(global.SoduWorkAPI?.taskStorageKey?.('ops') || 'renderer');
  let activeOwner = ownerScope(), probeGeneration = 0, selectionGeneration = 0;
  const probeKey = id => JSON.stringify([ownerScope(), location, id]);
  let probeChanged, releaseProbeChange;
  function changed() {
    const previous = releaseProbeChange;
    probeChanged = new Promise(resolve => { releaseProbeChange = resolve; });
    previous?.();
  }
  changed();
  let runtimeIcon = '';
  let loadPromise = null;
  let catalogLoaded = false;
  let catalogGeneration = 0;
  let unbindCatalog = null;
  let accessProbePromise = null;
  let cloudSelectionPromise = null;
  let locationGeneration = 0;
  const probes = Object.create(null);
  const pendingProbes = new Map();
  let boundOptions = null;
  function syncOwner() {
    const owner = ownerScope();
    if (owner === activeOwner) return false;
    activeOwner = owner; probeGeneration++; selectionGeneration++;
    catalogGeneration++; catalogLoaded = false; loadPromise = null;
    for (const key of Object.keys(probes)) delete probes[key];
    pendingProbes.clear(); accessProbePromise = null; cloudSelectionPromise = null;
    changed();
    return true;
  }
  const escapeText = value => String(value || '').replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function brandClass(id) {
    return global.AgentBrand
      ? AgentBrand.className(id, 'runtime-brand')
      : 'runtime-brand agent-brand-custom';
  }

  function brandGlyph(id) {
    return global.AgentBrand ? AgentBrand.glyph(id) : runtimeIcon;
  }

  function brandIcon(id, slotId) {
    return global.AgentBrand
      ? AgentBrand.html(id, { className: 'runtime-brand', id: slotId })
      : "<span class='" + brandClass(String(id || '')) + "'" +
        (slotId ? " id='" + slotId + "'" : '') + '>' + brandGlyph(id) + '</span>';
  }

  function normalize(items) {
    const seen = new Set();
    return (Array.isArray(items) ? items : []).map((item) => {
      const id = String(item && item.id || '');
      if (!/^[a-z][a-z0-9._-]{0,47}$/.test(id) || seen.has(id)) return null;
      seen.add(id);
      return {
        id,
        displayName: String(item.displayName || id).slice(0, 48),
        version: String(item.version || ''),
        accessControl: item.accessControl && typeof item.accessControl === 'object' ? item.accessControl : null,
        summary: String(item.summary || '').slice(0, 120),
        availability: item.availability && typeof item.availability === 'object' ? item.availability : null,
        modelMode: item.modelMode === 'account' ? 'account' : 'managed',
        goalMode: item.goalMode === 'native' ? 'native' : 'none',
        group: item.group === 'more' ? 'more' : 'recommended',
        order: Number(item.order || 999),
      };
    }).filter(Boolean).sort((a, b) => a.order - b.order);
  }

  function fallbackMissing() {
    return normalize(FALLBACK.filter((row) => row.id !== 'pi'));
  }

  function item(id) {
    return catalog.find((row) => row.id === String(id || '')) || catalog[0] || FALLBACK[0];
  }

  function selectCurrent(id) {
    const next = String(id || '');
    if (!next || !catalog.some((row) => row.id === next)) return false;
    current = next;
    selectedByLocation[location] = next;
    return true;
  }

  function rowHtml(runtime) {
    const mode = _rtText(runtime.modelMode === 'account' ? '个人账号' : '企业模型');
    return "<button type='button' class='wc-pop-row cp-runtime-row' data-runtime='" + runtime.id +
      "' aria-selected='false'>" + brandIcon(runtime.id) +
      "<span class='cp-runtime-copy'><span class='cp-runtime-head'><b data-user-content title=\"" + escapeText(runtime.displayName) + "\">" +
      escapeText(runtime.displayName) + "</b><small class='cp-runtime-version' translate='no' hidden></small><small class='cp-runtime-mode' title=\"" + escapeText(mode) + "\">" + mode +
      "</small></span><i" + (runtime.id.startsWith('custom-') ? ' data-user-content' : '') + ">" + escapeText(runtime.summary) + "</i></span>" +
      "<span class='cp-runtime-meta'><em class='cp-runtime-state' data-state='unknown' " +
      "data-runtime-state='" + runtime.id + "'>待检测</em>" +
      "<b class='wc-check' aria-label='" + _rtText('当前底座') + "' hidden>" +
      "<svg viewBox='0 0 16 16' aria-hidden='true'><path d='m4 8.2 2.4 2.4L12 5.3'/>" +
      "</svg></b></span></button>";
  }

  function rowsHtml() {
    const recommended = catalog.filter((row) => row.group !== 'more');
    const more = catalog.filter((row) => row.group === 'more');
    let html = recommended.length
      ? "<div class='cp-runtime-group is-first'>" + _rtText('推荐') + "</div>" + recommended.map(rowHtml).join('')
      : '';
    if (more.length) {
      html += "<div class='cp-runtime-group'>" + _rtText('更多底座') + "</div>" +
        more.map(rowHtml).join('');
    }
    return html || "<div class='cp-runtime-empty'>" + _rtText('暂时没有可用执行底座') + "</div>";
  }

  function renderRows(root) {
    const scope = root || document;
    const host = scope.querySelector('#cpRuntimeRows');
    if (host) host.innerHTML = rowsHtml();
    const count = scope.querySelector('#cpRuntimeCount');
    if (count) {
      const available = location === 'cloud'
        ? catalog.filter((row) => probes[probeKey(row.id)]?.ok).length
        : 0;
      const checking = location === 'cloud' && catalog.some((row) => pendingProbes.has(probeKey(row.id)));
      count.textContent = location === 'cloud'
        ? (checking ? _rtText('检查中') : available + ' ' + _rtText('个可用'))
        : catalog.length + ' ' + _rtText('个底座');
    }
  }

  function controls(abilityIcon) {
    runtimeIcon = String(abilityIcon || '');
    return WorkComposer.contextButton({
      id: 'cpRuntime', valueId: 'cpRuntimeName', iconHtml: brandIcon(current, 'cpRuntimeIcon'),
      label: _rtText('执行底座'), value: 'Pi',
      title: _rtText('选择本次会话的 Agent 底座'), popup: true, chevron: false,
    }) +
      "<div class='wc-popover cp-runtime-pop' id='cpRuntimePop'>" +
      "<div class='cp-runtime-heading'><span><b>" + _rtText('选择执行底座') + "</b>" +
      "<small>" + _rtText('选择一个底座完成本次会话') + "</small></span>" +
      "<em id='cpRuntimeCount'>" + catalog.length + " " + _rtText('个底座') + "</em></div>" +
      "<div class='cp-runtime-rows' id='cpRuntimeRows'>" + rowsHtml() + '</div>' +
      "<span class='wc-runtime-availability cp-runtime-availability-footer' id='cpRuntimeAvailability' hidden>" +
        "<span class='wc-runtime-missing' id='cpRuntimeMissing' role='img' aria-label='" + escapeText(_rtText('缺失的执行底座')) + "'></span>" +
        "<button type='button' class='wc-runtime-more' id='cpRuntimeMore' data-runtime-more hidden>" + escapeText(_rtText('更多')) + "</button>" +
      "</span></div>";
  }

  function paint(root) {
    const scope = root || document;
    const selected = item(current);
    const button = scope.querySelector('#cpRuntime');
    const name = scope.querySelector('#cpRuntimeName');
    const icon = scope.querySelector('#cpRuntimeIcon');
    const goalButton = scope.querySelector('#cpIntentMenu');
    const missingHost = scope.querySelector('#cpRuntimeMissing');
    const missingMore = scope.querySelector('#cpRuntimeMore');
    const missingWrap = scope.querySelector('#cpRuntimeAvailability');
    if (missingHost && missingMore && missingWrap && typeof missingHost.replaceChildren === 'function') {
      const rows = missingCatalog.filter((row) => row.id !== 'pi').slice(0, 6);
      missingHost.replaceChildren(...rows.map(row => {
        const item = document.createElement('span');
        item.className = 'wc-runtime-missing-icon'; item.dataset.runtimeMissing = row.id;
        item.title = _rtText(row.displayName);
        item.setAttribute('aria-hidden', 'true');
        const src = global.AgentBrand?.ICONS?.[row.id];
        if (src) {
          const image = document.createElement('img'); image.src = src; image.alt = ''; image.draggable = false;
          image.className = 'agent-brand'; item.append(image);
        } else item.textContent = '•';
        return item;
      }));
      missingWrap.hidden = rows.length === 0; missingHost.hidden = rows.length === 0; missingMore.hidden = rows.length === 0;
      missingWrap.setAttribute('aria-hidden', String(rows.length === 0));
      const runtimeWrap = missingWrap.closest('.cp-runtimewrap');
      // The management entry now lives in the picker footer. Only the legacy
      // toolbar slot should widen the compact runtime trigger.
      runtimeWrap?.classList.toggle('has-missing-runtime', rows.length > 0 &&
        missingWrap.parentElement === runtimeWrap);
      const names = rows.map(row => _rtText(row.displayName)).join('、');
      missingHost.setAttribute('aria-label', _rtText('缺失的执行底座') + (names ? '：' + names : ''));
      missingMore.textContent = _rtText('更多'); missingMore.title = _rtText(location === 'cloud'
        ? '打开云端电脑，安装或修复云端底座' : '打开 Agent 管理，安装或修复执行底座');
      missingMore.setAttribute('aria-label', _rtText(location === 'cloud' ? '打开云端电脑' : '打开 Agent 管理'));
    }
    if (goalButton) {
      goalButton.disabled = !goalSupported();
      goalButton.setAttribute('aria-disabled', String(goalButton.disabled));
      goalButton.title = goalButton.disabled ? _rtText('当前 Agent 暂不支持目标模式') : _rtText('设定持续目标');
    }
    if (name) { name.setAttribute('data-user-content', ''); name.textContent = selected.displayName; }
    if (icon) {
      icon.className = brandClass(selected.id);
      icon.innerHTML = brandGlyph(selected.id);
    }
    if (button) {
      button.title = (location === 'cloud' ? _rtText('云端 Harness：') : _rtText('执行底座：')) + selected.displayName + ' · ' + _rtText(selected.summary);
      button.setAttribute('aria-label', (location === 'cloud' ? _rtText('本次会话云端 Harness：') : _rtText('本次会话执行底座：')) + selected.displayName);
    }
    const label = scope.querySelector('#cpRuntime .wc-context-copy > i');
    if (label) label.textContent = location === 'cloud' ? _rtText('云端底座') : _rtText('执行底座');
    const heading = scope.querySelector('#cpRuntimePop .cp-runtime-heading b');
    const popup = scope.querySelector('#cpRuntimePop');
    if (popup) popup.classList.toggle('is-cloud', location === 'cloud');
    if (heading) heading.textContent = location === 'cloud' ? _rtText('选择云端 Harness') : _rtText('选择执行底座');
    const subheading = scope.querySelector('#cpRuntimePop .cp-runtime-heading small');
    if (subheading) subheading.textContent = location === 'cloud'
      ? _rtText('显示当前云端电脑的安装状态，可切换可用底座')
      : _rtText('选择一个底座完成本次会话');
    const count = scope.querySelector('#cpRuntimeCount');
    if (count && location === 'cloud') {
      const available = catalog.filter((row) => probes[probeKey(row.id)]?.ok).length;
      const checking = catalog.some((row) => pendingProbes.has(probeKey(row.id)));
      count.textContent = checking ? _rtText('检查中') : available + ' ' + _rtText('个可用');
    }
    scope.querySelectorAll('#cpRuntimePop [data-runtime]').forEach((row) => {
      const adapterId = row.dataset.runtime || '';
      const on = adapterId === current;
      row.classList.toggle('on', on);
      row.setAttribute('aria-selected', String(on));
      const check = row.querySelector('.wc-check');
      const result = probes[probeKey(adapterId)];
      const versionBadge = row.querySelector('.cp-runtime-version');
      if (versionBadge) {
        const runtime = item(adapterId);
        const rawVersion = result?.version || result?.detectedVersion || (location === 'local' ? runtime.version : '') || '';
        const version = global.AgentBrand?.version({ key: adapterId, version: rawVersion }) || rawVersion;
        versionBadge.textContent = version ? 'v' + version : '';
        versionBadge.title = versionBadge.textContent;
        versionBadge.hidden = !version;
      }
      const checking = row.classList.contains('checking');
      row.classList.toggle('unavailable', Boolean(result && !result.ok));
      if (result && result.reason) row.title = String(result.reason);
      else row.removeAttribute('title');
      const status = row.querySelector('[data-runtime-state]');
      if (check) check.hidden = !on || checking || Boolean(result && !result.ok);
      if (status) {
        // Cloud mode is an explicit capability decision. Keep each Harness
        // status visible so users can switch between the ready cloud agents
        // without guessing which one is installed on their remote machine.
        status.hidden = location !== 'cloud' && on && !checking && !(result && !result.ok);
        status.dataset.state = checking ? 'checking'
          : result == null ? 'unknown' : result.ok ? 'ready'
            : ['auth', 'unauthed', 'nollm'].includes(result.state) ? 'warning' : 'error';
        status.textContent = checking ? _rtText('检测中')
          : result == null ? _rtText('待检测')
            : result.ok ? _rtText('可用')
              : (['auth', 'unauthed'].includes(result.state) ? _rtText('需登录')
                : result.state === 'nollm' ? _rtText('缺少模型') : _rtText('不可用'));
        status.title = status.textContent;
      }
    });
    if (popup?.classList.contains('show')) {
      global.WorkComposer.placeRuntime(button, popup);
      // Model/access labels can change the centered toolbar after this paint.
      global.requestAnimationFrame?.(() => {
        if (popup.isConnected && popup.classList.contains('show')) global.WorkComposer.placeRuntime(button, popup);
      });
    }
  }

  function bounded(promise) {
    let timer;
    return Promise.race([Promise.resolve(promise), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('执行底座检测超时，请重试')), 15000);
    })]).finally(() => clearTimeout(timer));
  }

  async function loadCatalog(options, force = false) {
    syncOwner();
    if (loadPromise) return loadPromise;
    if (force) { catalogGeneration++; catalogLoaded = false; }
    if (catalogLoaded) return catalog;
    const api = options.api();
    if (!api || typeof api.runtimes !== 'function') return catalog;
    const generation = catalogGeneration;
    const job = Promise.resolve().then(() => bounded(api.runtimes(force ? { force: true } : undefined))).then((reply) => {
      syncOwner();
      if (generation !== catalogGeneration) return catalog;
      const declared = normalize(reply && reply.runtimes);
      let loaded = normalize(reply && Array.isArray(reply.availableRuntimes)
        ? reply.availableRuntimes
        : declared.filter((row) => row.id === 'pi'));
      const pi = declared.find((row) => row.id === 'pi') || (declared.length || loaded.length ? FALLBACK[0] : null);
      if (pi && !loaded.some((row) => row.id === 'pi')) loaded = [pi, ...loaded];
      if (!reply?.ok || !loaded.length) {
        // Keep Pi as the only safe choice when the health projection is
        // unavailable. The other declared bases remain management data and are
        // summarized by the footer icons, but never become conversation choices.
        catalog = FALLBACK.filter((row) => row.id === 'pi');
        missingCatalog = normalize((reply && reply.missing) || declared.filter((row) => row.id !== 'pi'));
        if (!missingCatalog.length) missingCatalog = fallbackMissing();
        catalogLoaded = false;
        renderRows(options.root);
        paint(options.root);
        return catalog;
      }
      const declaredMissing = Array.isArray(reply && reply.missing)
        ? reply.missing
        : declared.filter((row) => row.id !== 'pi');
      catalog = loaded; missingCatalog = normalize(declaredMissing.filter((row) => row.id !== 'pi')); catalogLoaded = true;
      if (location === 'local') for (const row of loaded) {
        if (row.availability) probes[probeKey(row.id)] = row.availability;
      }
      const preferred = selectedByLocation[location];
      const fallback = catalog.find((row) => row.id === 'pi') || catalog[0];
      if (!selectCurrent(preferred)) {
        selectCurrent(catalog.some((row) => row.id === current) ? current : fallback?.id);
      }
      renderRows(options.root);
      paint(options.root);
      return catalog;
    }).catch(() => {
      if (generation === catalogGeneration) {
        catalog = FALLBACK.filter((row) => row.id === 'pi');
        missingCatalog = fallbackMissing();
        catalogLoaded = false;
        renderRows(options.root);
        paint(options.root);
      }
      return catalog;
    }).finally(() => { if (loadPromise === job) loadPromise = null; });
    loadPromise = job;
    return job;
  }

  function demoteUnavailableLocal(adapterId, result, root) {
    if (location !== 'local' || adapterId === 'pi') return;
    const failed = catalog.find((row) => row.id === adapterId);
    if (!failed) return;
    catalog = catalog.filter((row) => row.id !== adapterId);
    if (!missingCatalog.some((row) => row.id === adapterId)) {
      missingCatalog = normalize([...missingCatalog, { ...failed, availability: result || { ok: false } }]);
    }
    if (current === adapterId) {
      const fallback = catalog.find((row) => row.id === 'pi') || catalog[0];
      if (fallback) selectCurrent(fallback.id);
    }
    renderRows(root);
    paint(root);
  }

  function probe(adapterId, options, announce) {
    syncOwner();
    const key = probeKey(adapterId);
    if (pendingProbes.has(key)) return pendingProbes.get(key);
    const generation = probeGeneration, owner = activeOwner;
    const valid = () => generation === probeGeneration && owner === ownerScope();
    const task = probeOnce(adapterId, options, announce, key, valid).finally(() => {
      if (pendingProbes.get(key) === task) pendingProbes.delete(key);
      if (valid()) options.refresh();
    });
    pendingProbes.set(key, task);
    options.refresh();
    return task;
  }

  // Selecting cloud is a location change, so the preferred local Harness may
  // not exist on the personal Runner. Probe the preferred choice first and,
  // only when it is unavailable, probe the remaining catalog in parallel and
  // pick the first ready one. This makes the cloud tab immediately usable
  // while still leaving every Harness switch explicit in the popup.
  function ensureCloudSelection(options) {
    if (location !== 'cloud') return probe(current, options, false);
    if (cloudSelectionPromise) return cloudSelectionPromise;
    const generation = locationGeneration, selection = selectionGeneration, owner = activeOwner;
    const job = Promise.resolve(loadCatalog(options)).then(async () => {
      if (generation !== locationGeneration || location !== 'cloud' || owner !== ownerScope()) return false;
      const preferredReady = await probe(current, options, false);
      // A click in the Harness picker is an explicit choice. Do not let an
      // automatic fallback from an earlier cloud probe overwrite it.
      if (selection !== selectionGeneration) return true;
      const candidates = catalog.filter((row) => row.id !== current);
      if (preferredReady) {
        // Do not make the first cloud send wait for every installed Harness.
        // Populate the remaining rows in the background so the picker can
        // show an honest ready/unavailable state as soon as it is opened.
        void Promise.all(candidates.map((row) => probe(row.id, options, false)))
          .then(() => { if (generation === locationGeneration && location === 'cloud' && owner === ownerScope()) options.refresh(); })
          .catch(() => {});
        return true;
      }
      const ready = await Promise.all(candidates.map((row) => probe(row.id, options, false)));
      if (generation !== locationGeneration || location !== 'cloud' || owner !== ownerScope()) return false;
      if (selection !== selectionGeneration) return true;
      const next = candidates.find((_, index) => ready[index]);
      if (!next) return false;
      selectCurrent(next.id);
      selectionGeneration++;
      changed();
      renderRows(options.root);
      paint(options.root);
      options.refresh();
      return true;
    }).finally(() => {
      if (cloudSelectionPromise === job) cloudSelectionPromise = null;
    });
    cloudSelectionPromise = job;
    accessProbePromise = job;
    return job;
  }

  async function probeOnce(adapterId, options, announce, key, valid) {
    const api = options.api();
    const cloud = location === 'cloud';
    if (cloud) {
      try {
        if (typeof api?.cloud?.targets !== 'function') throw Error('请重启客户端加载云端会话功能后重试');
        const reply = await bounded(api.cloud.targets(adapterId));
        if (!valid()) return false;
        const nodes = (reply?.diagnostics?.nodes || []).filter(node => node.code !== 'current_device');
        const detail = nodes.length && nodes.every(node => node.code === nodes[0].code) ? nodes[0].message : '';
        const result = { ok: reply?.ok !== false && Array.isArray(reply?.targets) && reply.targets.length > 0,
          reason: reply?.reason || detail || reply?.diagnostics?.summary || '没有可用的云端执行机，请配置云端环境' };
        probes[key] = result;
        if (!result.ok && announce) options.say(result.reason);
        return result.ok;
      } catch (error) {
        if (!valid()) return false;
        const reason = /No handler registered for ['"]conversation-cloud-targets['"]/i.test(String(error.message || ''))
          ? '云端会话功能尚未加载，请完全退出并重启客户端后重试' : error.message;
        probes[key] = { ok: false, reason };
        if (announce) options.say(reason);
        return false;
      }
    }
    if (!api || typeof api.probe !== 'function') {
      probes[key] = { ok: adapterId === 'pi' };
      return adapterId === 'pi';
    }
    try {
      const result = await bounded(api.probe(adapterId));
      if (!valid()) return false;
      probes[key] = result || { ok: false };
      paint(options.root);
      if (!result || !result.ok) {
        demoteUnavailableLocal(adapterId, result, options.root);
        if (announce) options.say((result && result.reason) ||
          '这个执行底座暂时不可用');
        return false;
      }
      return true;
    } catch (error) {
      if (!valid()) return false;
      probes[key] = { ok: false, reason: String(error && error.message || error) };
      paint(options.root);
      if (announce) options.say('执行底座检测没有成功');
      return false;
    }
  }

  function bind(root, options) {
    const opts = Object.assign({
      root, api: () => null, say: () => {}, close: () => {}, refresh: () => {},
    }, options || {});
    boundOptions = opts;
    if (unbindCatalog) unbindCatalog();
    unbindCatalog = opts.api()?.onRuntimesChanged?.(() => {
      catalogGeneration++; catalogLoaded = false; loadPromise = null;
      probeGeneration++; locationGeneration++; pendingProbes.clear(); cloudSelectionPromise = null;
      for (const key of Object.keys(probes)) delete probes[key];
      changed();
      accessProbePromise = loadCatalog(opts).then(() => refreshAccess()).then(() => opts.refresh());
    }) || null;
    const button = root.querySelector('#cpRuntime');
    const popup = root.querySelector('#cpRuntimePop');
    if (!button || !popup) return;
    const more = root.querySelector('#cpRuntimeMore');
    if (more) more.addEventListener('click', (event) => {
      event.stopPropagation();
      if (location === 'cloud') {
        if (global.WorkspaceHost?.open) global.WorkspaceHost.open('cloud');
        else global.openCloudEnvironmentsPanel?.();
        return;
      }
      if (typeof global.openAgentsEntry === 'function') global.openAgentsEntry();
      else if (typeof global.openAgentsPanel === 'function') global.openAgentsPanel();
      else if (global.WorkspaceHost && typeof global.WorkspaceHost.open === 'function') global.WorkspaceHost.open('agents');
    });
    button.addEventListener('click', () => { void loadCatalog(opts, true).then(() => refreshAccess()); });
    popup.addEventListener('click', async (event) => {
      const row = event.target.closest('[data-runtime]');
      if (!row || row.classList.contains('checking')) return;
      const adapterId = row.dataset.runtime || 'pi';
      syncOwner();
      const selection = ++selectionGeneration;
      row.classList.add('checking');
      row.setAttribute('aria-busy', 'true');
      paint(root);
      const available = await probe(adapterId, opts, true);
      row.classList.remove('checking');
      row.removeAttribute('aria-busy');
      paint(root);
      if (!available || selection !== selectionGeneration) return;
      selectCurrent(adapterId);
      changed();
      opts.refresh();
      paint(root);
      opts.close();
    });
    paint(root);
    accessProbePromise = loadCatalog(opts).then(() => probe(current, opts, false)).then(() => opts.refresh());
  }

  async function ready() {
    if (syncOwner() && boundOptions) refreshAccess();
    let key;
    do {
      key = probeKey(current);
      await Promise.race([pendingProbes.get(key) || accessProbePromise || Promise.resolve(), probeChanged]);
      if (syncOwner() && boundOptions) refreshAccess();
    } while (key !== probeKey(current) || pendingProbes.has(key));
    // Sending must be fenced by the same probe result that powers the picker.
    // A stale local selection can survive an install removal or a Runner
    // restart; treating every local adapter as ready would open a chat that
    // cannot execute and leave the user with a dead first turn.
    return Boolean(probes[key]?.ok);
  }

  function accessState() {
    if (pendingProbes.has(probeKey(current)) || !probes[probeKey(current)]) return 'checking';
    if (!probes[probeKey(current)].ok) return 'unavailable';
    return accessSupported() ? 'supported' : 'unsupported';
  }

  function refreshAccess() {
    syncOwner();
    if (!boundOptions) return Promise.resolve(false);
    accessProbePromise = location === 'cloud'
      ? ensureCloudSelection(boundOptions)
      : probe(current, boundOptions, false);
    return accessProbePromise;
  }

  function accessSupported() {
    if (location === 'cloud' || pendingProbes.has(probeKey(current))) return false;
    const result = probes[probeKey(current)];
    if (!result?.ok) return false;
    const capability = result.accessControl;
    // A Runner must report support itself. Catalog metadata alone cannot
    // authorize sending a policy to an old worker that would ignore it.
    return Boolean(capability?.supported && capability.schema === 'soduwork.access-policy/v1');
  }

  function goalSupported() {
    return location === 'local' && catalog.some(row => row.id === current && row.goalMode === 'native');
  }

  global.ComposeRuntime = {
    bind, controls, paint, accessSupported, accessState, refreshAccess, goalSupported, ready, value: () => current,
    brandIcon,
    location: () => location,
    availability: () => ({ checking: pendingProbes.has(probeKey(current)), ...(probes[probeKey(current)] || {}) }),
    setLocation(value) {
      const nextLocation = value === 'cloud' ? 'cloud' : 'local';
      if (location === nextLocation) return;
      locationGeneration++; probeGeneration++; pendingProbes.clear();
      cloudSelectionPromise = null; accessProbePromise = null;
      location = value === 'cloud' ? 'cloud' : 'local';
      selectCurrent(selectedByLocation[location]);
      selectionGeneration++; changed();
      if (boundOptions) {
        void refreshAccess();
        boundOptions.refresh();
      }
    },
    catalog: () => catalog.map((row) => ({ ...row })),
  };
  const ownerChanged = () => {
    if (syncOwner() && boundOptions) { void loadCatalog(boundOptions, true).then(() => refreshAccess()); boundOptions.refresh(); }
  };
  global.addEventListener?.('soduwork-data-scope-changed', ownerChanged);
  global.addEventListener?.('soduwork-device-auth', ownerChanged);
  global.addEventListener?.('soduwork-locale-change', () => { if (boundOptions) paint(boundOptions.root); });
  if (typeof module !== 'undefined' && module.exports) module.exports = global.ComposeRuntime;
})(window);
