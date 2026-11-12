/* Local sidebar organization only. Never changes conversation/workspace contents. */
(function (global) {
  'use strict';
  const unique = values => [...new Set((Array.isArray(values) ? values : []).filter(v => typeof v === 'string' && v && v.length < 512))];
  const copy = value => JSON.parse(JSON.stringify(value));
  // These exact prefixes/stems were shipped by this application. Recovery only
  // inspects the current profile; it never opens another product's data directory.
  const previousPrefixes = ['soduwork_work_sidebar_projects_v1:', 'soduwork_sidebar_projects_v1:'];
  const previousTaskStems = new Set(['soduwork_work_tasks_v5', 'soduwork_tasks_v5']);
  const accountPrefix = 'soduwork_sidebar_v1:';
  const localPrefix = 'soduwork_sidebar_device_v1:';
  let localHistory = null;
  function setLocalHistory(catalog, rows = []) {
    if (!catalog || typeof catalog.workspace !== 'string' || !catalog.workspace ||
        !Number.isSafeInteger(catalog.revision) || catalog.revision < 0) return false;
    if (localHistory?.workspace === catalog.workspace && catalog.revision < localHistory.revision) return false;
    if (Array.isArray(catalog.items)) {
      const records = new Map(), aliases = new Map(), origins = new Map();
      for (const item of catalog.items) {
        if (!item || typeof item.id !== 'string' || !item.id || item.id.length >= 512) continue;
        records.set(item.id, { id: item.id, archived: item.archived === true, deleted: item.deleted === true,
          historyAliasIds: unique(item.historyAliasIds), originIds: unique(item.originIds) });
      }
      const claims = new Map();
      for (const id of records.keys()) aliases.set(id, id);
      for (const item of records.values()) for (const alias of item.historyAliasIds) {
        if (!claims.has(alias)) claims.set(alias, []);
        claims.get(alias).push(item);
      }
      for (const [alias, owners] of claims) {
        if (records.has(alias) && !records.get(alias).deleted) continue;
        // Native joins retain retired child tombstones. Their IDs belong to
        // the active parent's explicit alias set, not to the retired row.
        const active = owners.filter(owner => !owner.deleted), candidates = active.length ? active : owners;
        aliases.set(alias, candidates.length === 1 ? candidates[0].id : null);
      }
      for (const item of records.values()) for (const origin of item.originIds) {
        if (aliases.has(origin) || item.deleted) continue;
        origins.set(origin, origins.has(origin) && origins.get(origin) !== item.id ? null : item.id);
      }
      localHistory = { workspace: catalog.workspace, revision: catalog.revision, records, aliases, origins,
        rows: localHistory?.workspace === catalog.workspace ? localHistory.rows : new Map() };
    } else if (!localHistory || localHistory.workspace !== catalog.workspace || localHistory.revision !== catalog.revision) return false;
    for (const row of rows) {
      const id = localHistory.aliases.get(row?.id);
      if (id) localHistory.rows.set(id, localSnapshot({ ...row, id }));
    }
    return true;
  }
  function localSnapshot(row) {
    const result = snapshot(row);
    // Account task bindings are resolved by main when opening the saved record.
    delete result.taskId; delete result.taskIds; delete result.mode;
    return result;
  }
  function hubIdentity(value) {
    try {
      const url = new URL(String(value || ''));
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return '';
      // Accounts are scoped to the exact service origin; do not alias deployments.
      return url.origin;
    } catch (_) { return ''; }
  }
  function previousIdentity(value) {
    try {
      const parts = String(value).split('@');
      if (parts.length !== 4 || !previousTaskStems.has(parts[0])) return null;
      const [hub, device, user] = parts.slice(1).map(decodeURIComponent);
      if (!hubIdentity(hub) || !device || !user || user === 'unbound') return null;
      return { hub, device, user };
    } catch (_) { return null; }
  }
  function accountOptions({ storage, api }) {
    const previous = String(api?.taskStorageKey?.('tasks') || '');
    const fallback = previousIdentity(previous);
    const auth = api?.clientAuthSnapshot?.();
    const user = String(auth ? auth.user?.id || '' : fallback?.user || '');
    const hub = hubIdentity(api?.hubBase?.() || fallback?.hub);
    const device = String(auth?.clientId || fallback?.device || '');
    const key = accountPrefix + encodeURIComponent(JSON.stringify([hub, user]));
    if (!hub || !user || user === 'unbound') return {
      key, writable: false, storage: { getItem: () => null }, deviceStorage: storage,
    };
    return { storage, key, deviceStorage: storage, migrate() {
      const candidates = [];
      for (let index = 0; index < storage.length; index++) {
        const oldKey = storage.key(index);
        const prefix = previousPrefixes.find(value => oldKey?.startsWith(value));
        if (!prefix) continue;
        let decoded;
        try { decoded = decodeURIComponent(oldKey.slice(prefix.length)); } catch (_) { continue; }
        const owner = previousIdentity(decoded);
        if (!owner || owner.user !== user || hubIdentity(owner.hub) !== hub) continue;
        const exact = oldKey === previousPrefixes[0] + encodeURIComponent(previous);
        candidates.push({ key: oldKey, rank: exact ? -1 :
          (owner.device === device ? 0 : 100) + (owner.hub === api?.hubBase?.() ? 0 : 10) + previousPrefixes.indexOf(prefix) });
      }
      candidates.sort((a, b) => a.rank - b.rank);
      if (!candidates.length) return null;
      const best = candidates.filter(item => item.rank === candidates[0].rank);
      const values = best.map(item => storage.getItem(item.key));
      if (new Set(values).size !== 1) throw Error('Conflicting previous sidebar snapshots');
      return values[0];
    } };
  }
  function timestamp(value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  function createdAt(row) {
    return timestamp(row && (row.createdAt ?? row.created ?? row.at ?? row.updatedAt));
  }
  function newestFirst(rows) {
    return rows.slice().sort((left, right) => createdAt(right) - createdAt(left));
  }
  function applicationFields(value) {
    if (typeof value?.appId !== 'string' || !value.appId.trim()) return {};
    const appIcon = applicationIcon(value.appIcon);
    return { appId: value.appId.trim().slice(0, 512), lastChatId: String(value.lastChatId || '').slice(0, 512),
      ...(appIcon ? {appIcon} : {}) };
  }
  function applicationIcon(value) {
    try { return global.SoduWorkPluginIcon?.normalize(value) || ''; } catch (_) { return ''; }
  }
  function storageKey(api) {
    return accountOptions({ api }).key;
  }
  function normalizedManualOrder(value) {
    const source = value && typeof value === 'object' ? value : {};
    const projects = source.projects && typeof source.projects === 'object' ? source.projects : {};
    return {
      recent: source.recent === true,
      projects: Object.fromEntries(Object.entries(projects).filter(([id, enabled]) =>
        /^project-[\w-]+$/.test(id) && enabled === true)),
    };
  }
  function normalized(value) {
    const source = value && typeof value === 'object' ? value : {};
    const pins = unique(source.pins);
    const archivedIds = new Set();
    const archivedChatIdsSeen = new Set();
    const archivedProjects = (Array.isArray(source.archivedProjects) ? source.archivedProjects : []).filter(p =>
      p && typeof p.id === 'string' && /^project-[\w-]+$/.test(p.id) && !archivedIds.has(p.id) && archivedIds.add(p.id)).map(p => ({
        id: p.id, name: String(p.name || '未命名项目').slice(0, 120), ...applicationFields(p),
        folders: unique(p.folders), collapsed: !!p.collapsed,
        businessProjectId: String(p.businessProjectId || '').slice(0, 120),
        chatIds: unique(p.chatIds).filter(id => !archivedChatIdsSeen.has(id) && archivedChatIdsSeen.add(id)),
        createdAt: Number(p.createdAt) || 0,
        archivedAt: Number(p.archivedAt) || Date.now(),
      }));
    const archivedChatIds = new Set(archivedProjects.flatMap(p => p.chatIds));
    /* Project membership is exclusive across projects; independent pins may coexist with membership and duplicate display. */
    const allocated = new Set();
    const projects = (Array.isArray(source.projects) ? source.projects : []).filter(p =>
      p && typeof p.id === 'string' && /^project-[\w-]+$/.test(p.id) && !archivedIds.has(p.id) && archivedIds.add(p.id)).map(p => ({
        id: p.id, name: String(p.name || '未命名项目').slice(0, 120), ...applicationFields(p),
        folders: unique(p.folders), collapsed: !!p.collapsed,
        businessProjectId: String(p.businessProjectId || '').slice(0, 120),
        chatIds: unique(p.chatIds).filter(id => !archivedChatIds.has(id) && !allocated.has(id) && allocated.add(id)),
        createdAt: Number(p.createdAt) || 0,
      }));
    for (const p of [...projects, ...archivedProjects]) {
      if (p.appId && !p.chatIds.includes(p.lastChatId)) p.lastChatId = '';
    }
    const activePins = pins.filter(id => !archivedChatIds.has(id));
    const activeRecent = unique(source.recent).filter(id => !allocated.has(id) && !archivedChatIds.has(id));
    return { version: 1, projects, archivedProjects, pins: activePins, recent: activeRecent,
      rows: (Array.isArray(source.rows) ? source.rows : []).filter(row => row && typeof row.id === 'string').map(snapshot),
      manualOrder: normalizedManualOrder(source.manualOrder), collapsed: !!source.collapsed };
  }
  function snapshot(row) {
    // Keep enough metadata to open an older grouped chat outside the latest-50 window,
    // but never persist messages, attachments, credentials, or stale running status.
    const out = { id: String(row.id), title: String(row.title || '未命名对话'),
      state: 'completed', live: false, pending: false };
    for (const key of ['customTitle', 'titleUpdatedAt', 'adapterId', 'runtime', 'createdAt', 'created', 'updatedAt', 'at', 'taskId', 'taskIds', 'mode']) {
      if (row[key] !== undefined) out[key] = row[key];
    }
    if (Array.isArray(row.usedHarnesses)) out.usedHarnesses = unique(row.usedHarnesses);
    return out;
  }
  function sourceOwner(key) {
    if (key.startsWith(accountPrefix)) {
      try {
        const owner = JSON.parse(decodeURIComponent(key.slice(accountPrefix.length)));
        return Array.isArray(owner) && owner.length === 2 && hubIdentity(owner[0]) &&
          typeof owner[1] === 'string' && owner[1] && owner[1] !== 'unbound' ? key : '';
      } catch (_) { return ''; }
    }
    const prefix = previousPrefixes.find(value => key.startsWith(value));
    if (!prefix) return '';
    try {
      const owner = previousIdentity(decodeURIComponent(key.slice(prefix.length)));
      return owner ? accountPrefix + encodeURIComponent(JSON.stringify([hubIdentity(owner.hub), owner.user])) : '';
    } catch (_) { return ''; }
  }
  function localProject(project, chatIds) {
    // A shared folder group conveys local organization, never account authorization.
    return { id: project.id, name: project.name, folders: project.folders, chatIds,
      collapsed: project.collapsed, createdAt: project.createdAt,
      ...(project.archivedAt ? { archivedAt: project.archivedAt } : {}) };
  }
  function createDevicePartition(storage, key) {
    let shared = null, sharedKey = '', sharedRaw = null;
    const enabled = () => !!storage && key.startsWith(accountPrefix) && !!localHistory;
    const canonical = id => localHistory?.aliases.get(String(id || '')) || '';
    // A downloaded copy can inherit legacy organization from its origin, but
    // the origin remains an independent account conversation and lifecycle.
    const migrationId = id => canonical(id) || localHistory?.origins.get(String(id || '')) || '';
    const localIds = ids => unique((ids || []).map(canonical).filter(Boolean));
    const remoteIds = ids => unique(ids).filter(id => !canonical(id));
    function orderedIds(deviceIds, accountIds) {
      const local = localIds(deviceIds), positions = new Map(local.map((id, index) => [id, index]));
      const account = unique((accountIds || []).map(id => canonical(id) || id));
      const boundaries = new Array(account.length);
      let boundary = local.length;
      for (let index = account.length - 1; index >= 0; index--) {
        if (positions.has(account[index])) boundary = positions.get(account[index]);
        boundaries[index] = boundary;
      }
      // Account lists retain local IDs only as placement anchors. Membership
      // and local relative order always come from the current device state.
      const buckets = new Map();
      let minimum = 0;
      account.forEach((id, index) => {
        if (canonical(id)) return;
        const at = Math.max(minimum, boundaries[index]); minimum = at;
        if (!buckets.has(at)) buckets.set(at, []);
        buckets.get(at).push(id);
      });
      const result = [];
      local.forEach((id, index) => { result.push(...(buckets.get(index) || []), id); });
      return result.concat(buckets.get(local.length) || []);
    }
    const owns = id => (shared.projectOwners[id] || []).includes(key);
    function read(account) {
      if (!enabled()) return account;
      sharedKey = localPrefix + encodeURIComponent(localHistory.workspace);
      const raw = storage.getItem(sharedKey);
      if (!shared || raw !== sharedRaw) {
        const parsed = raw === null ? {} : JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
            (parsed.version !== undefined && parsed.version !== 1)) throw Error('Invalid local sidebar state');
        shared = { ...normalized(parsed), migratedIds: unique(parsed.migratedIds),
          projectOwners: Object.fromEntries(Object.entries(parsed.projectOwners || {}).filter(([id]) => /^project-[\w-]+$/.test(id))
            .map(([id, owners]) => [id, unique(owners).filter(owner => sourceOwner(owner) === owner)])) };
        sharedRaw = raw;
      }
      const remap = ids => unique((ids || []).map(id => canonical(id) || id));
      const canonicalRows = new Map();
      for (const row of shared.rows) {
        const id = canonical(row.id) || row.id;
        if (!canonicalRows.has(id) || row.id === id) canonicalRows.set(id, localSnapshot({ ...row, id }));
      }
      const canonicalState = { ...normalized({ ...shared, pins: remap(shared.pins), recent: remap(shared.recent),
        projects: shared.projects.map(project => ({ ...project, chatIds: remap(project.chatIds) })),
        archivedProjects: shared.archivedProjects.map(project => ({ ...project, chatIds: remap(project.chatIds) })),
        rows: [...canonicalRows.values()] }),
        migratedIds: unique([...shared.migratedIds, ...remap(shared.migratedIds)]), projectOwners: shared.projectOwners };
      const canonicalValue = JSON.stringify(canonicalState);
      const referencesChanged = canonicalValue !== JSON.stringify(shared);
      shared = canonicalState;
      const migrated = new Set(shared.migratedIds);
      const fresh = new Set([...localHistory.records.keys()].filter(id => !migrated.has(id)));
      if (fresh.size) {
        const next = copy(shared), sources = [];
        for (let index = 0; index < storage.length; index++) {
          const sourceKey = storage.key(index), owner = sourceOwner(sourceKey || '');
          if (owner) sources.push({ sourceKey, owner });
        }
        sources.sort((a, b) => Number(b.sourceKey === key) - Number(a.sourceKey === key) || a.sourceKey.localeCompare(b.sourceKey));
        const freshIds = ids => unique((ids || []).map(migrationId))
          .filter(id => fresh.has(id) && !localHistory.records.get(id).deleted);
        for (const source of sources) {
          let value;
          try {
            value = JSON.parse(storage.getItem(source.sourceKey));
            if (!value || typeof value !== 'object' || Array.isArray(value) ||
                (value.version !== undefined && value.version !== 1)) continue;
          } catch (_) { continue; }
          const previous = normalized(value);
          next.pins = unique([...next.pins, ...freshIds(previous.pins)]);
          next.recent = unique([...next.recent, ...freshIds(previous.recent)]);
          if (freshIds(previous.recent).length && previous.manualOrder.recent) next.manualOrder.recent = true;
          for (const section of ['projects', 'archivedProjects']) for (const project of previous[section]) {
            const chatIds = freshIds(project.chatIds);
            if (!chatIds.length) continue;
            const old = [...next.projects, ...next.archivedProjects].find(row => row.id === project.id);
            if (old) old.chatIds = unique([...old.chatIds, ...chatIds]);
            else next[section].push(localProject(project, chatIds));
            next.projectOwners[project.id] = unique([...(next.projectOwners[project.id] || []), source.owner]);
            if (previous.manualOrder.projects[project.id]) next.manualOrder.projects[project.id] = true;
          }
          const known = new Set(next.rows.map(row => row.id));
          for (const row of previous.rows) {
            const id = migrationId(row.id);
            if (fresh.has(id) && !known.has(id) && !localHistory.records.get(id).deleted) {
              next.rows.push(localSnapshot({ ...row, id })); known.add(id);
            }
          }
        }
        // Record even ungrouped IDs so later unpin/remove operations cannot be
        // undone by an obsolete account snapshot during another account's login.
        next.migratedIds = unique([...next.migratedIds, ...fresh]);
        const value = JSON.stringify({ ...normalized(next), migratedIds: next.migratedIds, projectOwners: next.projectOwners });
        storage.setItem(sharedKey, value);
        shared = JSON.parse(value); sharedRaw = value;
      } else if (referencesChanged) {
        storage.setItem(sharedKey, canonicalValue); sharedRaw = canonicalValue;
      }
      const rows = new Map(shared.rows.map(row => [row.id, row]));
      for (const [id, row] of localHistory.rows) if (rows.has(id)) rows.set(id, row);
      const visibleRows = [...rows.values()].filter(row => {
        const record = localHistory.records.get(row.id);
        return record && !record.archived && !record.deleted;
      });
      const merged = { ...account, rows: [...visibleRows, ...account.rows.filter(row => !canonical(row.id))],
        pins: orderedIds(shared.pins, account.pins), recent: orderedIds(shared.recent, account.recent),
        manualOrder: { recent: shared.manualOrder.recent || account.manualOrder.recent,
          projects: { ...account.manualOrder.projects, ...shared.manualOrder.projects } }, collapsed: shared.collapsed };
      for (const section of ['projects', 'archivedProjects']) {
        const locals = new Map(shared[section].map(project => [project.id, project]));
        const allShared = new Set([...shared.projects, ...shared.archivedProjects].map(project => project.id));
        merged[section] = [...locals.values()].map(project => {
          const privateProject = [...account.projects, ...account.archivedProjects].find(row => row.id === project.id);
          return { ...project, businessProjectId: privateProject?.businessProjectId || '',
            ...applicationFields(privateProject), chatIds: orderedIds(project.chatIds, privateProject?.chatIds) };
        });
        for (const project of account[section]) if (!allShared.has(project.id) && !shared.projectOwners[project.id])
          merged[section].push({ ...project, chatIds: remoteIds(project.chatIds) });
      }
      return normalized(merged);
    }
    function accountState(account) {
      if (!enabled() || !shared) return account;
      const projects = account.projects.filter(project => !shared.projectOwners[project.id] || !owns(project.id));
      for (const project of shared.projects) if (owns(project.id)) {
        const previous = [...account.projects, ...account.archivedProjects].find(row => row.id === project.id);
        projects.push({ ...previous, ...project, businessProjectId: previous?.businessProjectId || '',
          ...applicationFields(previous), chatIds: orderedIds(project.chatIds, previous?.chatIds) });
      }
      return normalized({ ...account, projects });
    }
    function write(next, account, { localProjectId = '', remoteProjectId = '' } = {}) {
      const sharedIds = new Set([...shared.projects, ...shared.archivedProjects].map(project => project.id));
      if (localProjectId) sharedIds.add(localProjectId);
      const local = { ...next, pins: localIds(next.pins), recent: localIds(next.recent),
        rows: next.rows.filter(row => canonical(row.id)).map(row => localSnapshot({ ...row, id: canonical(row.id) })),
        migratedIds: shared.migratedIds, projectOwners: copy(shared.projectOwners) };
      const privateState = { ...next, pins: unique(next.pins), recent: unique(next.recent),
        rows: next.rows.filter(row => !canonical(row.id)) };
      for (const section of ['projects', 'archivedProjects']) {
        local[section] = []; privateState[section] = [];
        for (const project of next[section]) {
          const ids = localIds(project.chatIds);
          const useLocal = sharedIds.has(project.id) || ids.length > 0;
          if (useLocal) {
            local[section].push(localProject(project, ids));
            if (!local.projectOwners[project.id]) local.projectOwners[project.id] = sourceOwner(key) ? [key] : [];
            if (remoteProjectId === project.id && sourceOwner(key)) local.projectOwners[project.id] = unique([...local.projectOwners[project.id], key]);
            const prior = [...account.projects, ...account.archivedProjects].find(row => row.id === project.id);
            if (prior || local.projectOwners[project.id].includes(key) || localProjectId === project.id && project.businessProjectId)
              privateState[section].push(prior && !local.projectOwners[project.id].includes(key) && localProjectId !== project.id
                ? prior : { ...project, chatIds: unique(project.chatIds) });
          } else privateState[section].push(project);
        }
      }
      const projectIds = new Set([...local.projects, ...local.archivedProjects].map(project => project.id));
      local.manualOrder = { ...local.manualOrder,
        projects: Object.fromEntries(Object.entries(local.manualOrder.projects).filter(([id]) => projectIds.has(id))) };
      const localValue = JSON.stringify({ ...normalized(local), migratedIds: local.migratedIds, projectOwners: local.projectOwners });
      const accountValue = JSON.stringify(normalized(privateState));
      const priorAccount = storage.getItem(key);
      const accountChanged = !!sourceOwner(key) && accountValue !== priorAccount;
      if (accountChanged) storage.setItem(key, accountValue);
      try { if (localValue !== sharedRaw) storage.setItem(sharedKey, localValue); }
      catch (error) {
        // A failed second write must not leave a half-applied account layout.
        if (accountChanged) {
          if (priorAccount === null) storage.removeItem(key); else storage.setItem(key, priorAccount);
        }
        throw error;
      }
      shared = JSON.parse(localValue); sharedRaw = localValue;
      return { account: normalized(privateState), raw: accountChanged ? accountValue : priorAccount };
    }
    function applyRemote(project, account) {
      const nextAccount = copy(account), previous = nextAccount.projects.find(row => row.id === project.id);
      nextAccount.projects = nextAccount.projects.filter(row => row.id !== project.id);
      if (!project.deleted) nextAccount.projects.push({ ...previous, ...project });
      if (shared.projectOwners[project.id] && !owns(project.id)) {
        // Matching IDs in another account's directory do not grant ownership
        // of this device's group or its native conversation membership.
        const raw = JSON.stringify(normalized(nextAccount));
        storage.setItem(key, raw);
        return { account: normalized(nextAccount), raw };
      }
      const next = read(nextAccount), old = next.projects.find(row => row.id === project.id);
      next.projects = next.projects.filter(row => row.id !== project.id);
      if (!project.deleted) next.projects.push({ ...old, ...project });
      return write(next, nextAccount, { remoteProjectId: project.id });
    }
    return { enabled, read, write, accountState, applyRemote };
  }
  function create({ storage, key, deviceStorage, legacyPins = [], writable = true, migrate, onChange }) {
    let raw = null, state = normalized({ pins: legacyPins }), initialized = false, readError = null;
    let accountState = state;
    const device = createDevicePartition(deviceStorage, key);
    const observedTimes = new Map();
    function stableNewestFirst(rows) {
      const time = row => {
        const key = row._uiKey || row.id || row.localId;
        const value = createdAt(row);
        if (!observedTimes.has(key) && value > 0) observedTimes.set(key, value);
        return observedTimes.get(key) || 0;
      };
      // Capture before sorting: comparator invocation order must not determine
      // where aliases or equal-time rows appear. Metadata refresh is not creation.
      rows.forEach(time);
      return rows.slice().sort((a, b) => time(b) - time(a));
    }
    function refresh() {
      try {
        let latest = storage.getItem(key);
        if (!initialized && latest === null && migrate) {
          const previous = migrate();
          if (previous !== null) {
            const parsed = JSON.parse(previous);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
                (parsed.version !== undefined && parsed.version !== 1)) throw Error('Invalid previous sidebar state');
            const current = storage.getItem(key);
            latest = current !== null ? current : JSON.stringify(normalized(parsed));
            if (current === null) storage.setItem(key, latest); // Keep the source intact, including on failure.
          }
        }
        if (!initialized || latest !== raw) {
          const parsed = latest !== null ? JSON.parse(latest) : initialized ? {} : { pins: legacyPins };
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
            (parsed.version !== undefined && parsed.version !== 1)) throw Error('Invalid sidebar state');
          accountState = normalized(parsed); raw = latest; initialized = true;
        }
        state = device.read(accountState);
        readError = null;
      } catch (_) {
        readError = Error('项目分组数据暂时无法读取，原数据已保留。请重新打开客户端后重试');
      }
    }
    refresh();
    function commit(change, options) {
      if (!writable && !device.enabled()) throw Error('登录后即可整理会话');
      refresh();
      if (readError) throw readError;
      const next = copy(state);
      change(next);
      const normalizedNext = normalized(next);
      const held = new Set([...normalizedNext.pins, ...normalizedNext.recent,
        ...normalizedNext.projects.flatMap(p => p.chatIds), ...normalizedNext.archivedProjects.flatMap(p => p.chatIds)]);
      normalizedNext.rows = normalizedNext.rows.filter(row => held.has(row.id));
      if (device.enabled()) {
        const result = device.write(normalizedNext, accountState, options);
        accountState = result.account; raw = result.raw;
        state = device.read(accountState);
      } else {
        const value = JSON.stringify(normalizedNext);
        if (value !== raw) storage.setItem(key, value); // Failure leaves the previous state intact.
        state = accountState = normalizedNext; raw = value;
      }
      onChange?.();
    }
    function remember(next, items) {
      const rows = new Map(next.rows.map(row => [row.id, row]));
      const held = new Set([...next.pins, ...next.recent, ...next.projects.flatMap(p => p.chatIds),
        ...next.archivedProjects.flatMap(p => p.chatIds)]);
      for (const row of items || []) if (row?.id && held.has(String(row.id))) rows.set(String(row.id),
        snapshot({ ...rows.get(String(row.id)), ...row }));
      next.rows = [...rows.values()];
    }
    function forgetMany(ids, { preserveArchivedProjects = false, preserveProjectIds = [] } = {}) {
      const removed = new Set(unique(ids));
      if (!removed.size) return;
      const preserved = new Set(unique(preserveProjectIds));
      commit(next => {
        next.pins = next.pins.filter(id => !removed.has(id));
        next.recent = next.recent.filter(id => !removed.has(id));
        for (const project of [...next.projects.filter(project => !preserved.has(project.id)),
          ...(preserveArchivedProjects ? [] : next.archivedProjects)]) {
          project.chatIds = project.chatIds.filter(id => !removed.has(id));
        }
      });
    }
    function view(items) {
      refresh();
      const current = new Map((items || []).filter(row => row?.id).map(row => [String(row.id), row]));
      const rows = [...(items || []).filter(Boolean), ...state.rows.filter(row => !current.has(row.id))];
      const byId = new Map(rows.map(row => [String(row.id), row]));
      const allocated = new Set([...state.pins, ...state.projects.flatMap(p => p.chatIds),
        ...state.archivedProjects.flatMap(p => p.chatIds)]);
      const recent = rows.filter(row => !allocated.has(String(row.id)));
      const ordered = new Set(state.recent);
      const recentFresh = recent.filter(row => !ordered.has(String(row.id)));
      const recentKnown = state.recent.map(id => byId.get(id)).filter(row => row && !allocated.has(String(row.id)));
      const recentItems = state.manualOrder.recent
        ? [...stableNewestFirst(recentFresh), ...recentKnown]
        : stableNewestFirst(recent);
      return { projects: state.projects.map(p => {
        const items = p.chatIds.map(id => byId.get(id)).filter(Boolean);
        return { ...copy(p), items: state.manualOrder.projects[p.id] ? items : stableNewestFirst(items) };
      }),
        pinned: state.pins.map(id => byId.get(id)).filter(Boolean),
        recent: recentItems, collapsed: state.collapsed };
    }
    return {
      applyRemoteProject(project) {
        const callback = onChange; onChange = null;
        try {
          refresh(); if (readError) throw readError;
          if (device.enabled()) {
            const result = device.applyRemote(project, accountState);
            accountState = result.account; raw = result.raw; state = device.read(accountState);
            return;
          }
          commit(next => {
          const old = next.projects.find(p => p.id === project.id);
          next.projects = next.projects.filter(p => p.id !== project.id);
          if (!project.deleted) next.projects.push({...old, ...project});
        }); } finally { onChange = callback; }
      },
      view, get: () => { refresh(); return copy(state); },
      getAccount: () => { refresh(); return copy(device.accountState(accountState)); },
      remember: items => { if (writable || device.enabled()) commit(next => remember(next, items)); },
      recordAppChat(appId, name, row, appIcon) {
        appId = String(appId || '').trim();
        const id = String(row?.id || '').trim();
        if (!appId || appId.length > 512 || !id || id.length > 512) throw Error('应用或会话标识无效');
        commit(next => {
          let p = next.projects.find(item => item.appId === appId);
          if (!p) {
            p = { id: 'project-' + (global.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)),
              appId, name: '', folders: [], businessProjectId: '', collapsed: false, chatIds: [], createdAt: Date.now() };
            next.projects.push(p);
          }
          p.name = String(name || '应用').trim().slice(0, 120);
          if (appIcon !== undefined) p.appIcon = applicationIcon(appIcon);
          if (!p.chatIds.includes(id)) {
            next.projects.forEach(q => { q.chatIds = q.chatIds.filter(value => value !== id); });
            next.archivedProjects.forEach(q => { q.chatIds = q.chatIds.filter(value => value !== id); });
            next.recent = next.recent.filter(value => value !== id);
            p.chatIds.push(id);
          }
          p.lastChatId = id;
          const previous = next.rows.find(item => item.id === id);
          remember(next, [{ ...row, createdAt: previous?.createdAt || row.createdAt || Date.now() }]);
        });
      },
      saveProject({ id, name, folders = [], businessProjectId }) {
        name = String(name || '').replace(/\s+/g, ' ').trim();
        if (!name || [...name].length > 80) throw Error(name ? '项目名称最多 80 个字' : '请输入项目名称');
        if (folders.some(folder => typeof folder !== 'string' || !folder.trim())) throw Error('文件夹无效，请重新选择');
        const editing = !!id;
        id = id || 'project-' + (global.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
        commit(next => {
          if (next.projects.some(p => !p.appId && p.id !== id && p.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw Error('已有同名项目，请换一个名称');
          const p = next.projects.find(p => p.id === id);
          if (editing && !p) throw Error('项目已被移除，请重新创建');
          const association = businessProjectId === undefined ? p?.businessProjectId || '' : String(businessProjectId || '').slice(0,120);
          if (p) Object.assign(p, { name, folders: unique(folders), businessProjectId: association });
          else next.projects.push({ id, name, folders: unique(folders), businessProjectId: association, collapsed: false, chatIds: [], createdAt: Date.now() });
          next.collapsed = false;
        }, { localProjectId: id });
        return id;
      },
      archiveProject(id) { commit(next => {
        const p = next.projects.find(item => item.id === id);
        if (!p) throw Error('项目已被归档或移除，请刷新后重试');
        next.projects = next.projects.filter(item => item.id !== id);
        next.archivedProjects = [...next.archivedProjects.filter(item => item.id !== id), {
          ...p, chatIds: [...p.chatIds], createdAt: Number(p.createdAt) || Date.now(), archivedAt: Date.now(),
        }];
      }); },
      restoreProject(id) { commit(next => {
        const p = next.archivedProjects.find(item => item.id === id);
        if (!p) throw Error('归档项目不存在或已恢复');
        next.archivedProjects = next.archivedProjects.filter(item => item.id !== id);
        next.projects.push({ id: p.id, name: p.name, ...applicationFields(p), businessProjectId: p.businessProjectId || '', folders: [...p.folders], collapsed: !!p.collapsed, chatIds: [...p.chatIds], createdAt: Number(p.createdAt) || 0 });
      }); },
      permanentlyDeleteProject(id) { commit(next => {
        const p = next.archivedProjects.find(item => item.id === id);
        if (!p) throw Error('归档项目不存在或已删除');
        next.archivedProjects = next.archivedProjects.filter(item => item.id !== id);
        next.rows = next.rows.filter(row => !p.chatIds.includes(row.id));
      }); },
      removeProject(id) { commit(next => {
        const p = next.projects.find(p => p.id === id);
        if (!p) return;
        next.recent = unique([...p.chatIds, ...next.recent]);
        next.projects = next.projects.filter(p => p.id !== id);
      }); },
      restoreChat(id) { commit(next => {
        const wanted = String(id || '');
        if (!wanted) return;
        next.pins = next.pins.filter(value => value !== wanted);
        next.projects.forEach(p => { p.chatIds = p.chatIds.filter(value => value !== wanted); });
        next.archivedProjects.forEach(p => { p.chatIds = p.chatIds.filter(value => value !== wanted); });
        next.recent = unique([wanted, ...next.recent]);
      }); },
      collapse(id) { commit(next => {
        if (!id) next.collapsed = !next.collapsed;
        else { const p = next.projects.find(p => p.id === id); if (p) p.collapsed = !p.collapsed; }
      }); },
      /*
       * Toggle pins without changing project ownership. Unowned conversations return to recent
       * ordering while preserving snapshot retention rules.
       */
      togglePin(id, row) { commit(next => {
        id = String(id || '');
        if (!id) return;
        if (next.pins.includes(id)) {
          next.pins = next.pins.filter(value => value !== id);
          if (![...next.projects, ...next.archivedProjects].some(p => p.chatIds.includes(id)))
            next.recent = unique([...next.recent, id]);
        } else next.pins = unique([...next.pins, id]);
        if (row?.id === id) remember(next, [row]);
      }); },
      /* Assign new conversations to projects before they appear in the list, preserving existing pins. */
      fileChat(id, projectId, row) {
        id = String(id || '');
        if (!id) return false;
        let filed = false;
        commit(next => {
          const p = next.projects.find(item => item.id === projectId);
          if (!p) throw Error('项目已被移除，请刷新后重试');
          if (p.chatIds.includes(id)) { filed = true; return; }
          next.recent = next.recent.filter(value => value !== id);
          next.projects.forEach(q => { q.chatIds = q.chatIds.filter(value => value !== id); });
          next.archivedProjects.forEach(q => { q.chatIds = q.chatIds.filter(value => value !== id); });
          p.chatIds.push(id);
          p.collapsed = false;
          if (row && row.id) remember(next, [row]);
          filed = true;
        });
        return filed;
      },
      move(item, target, beforeId, items) {
        if (!item?.id || item.pending) throw Error('会话建立后即可移动');
        const id = String(item.id);
        if (id === beforeId) return;
        const visible = view(items);
        const recentIds = visible.recent.filter(row => row.id).map(row => String(row.id));
        const projectIds = visible.projects.find(p => p.id === target)?.items.map(row => String(row.id)) || [];
        commit(next => {
          if (!['recent', 'pinned'].includes(target) && !next.projects.some(p => p.id === target)) throw Error('项目已移除，请重新选择');
          next.pins = next.pins.filter(v => v !== id);
          next.recent = unique([...recentIds, ...next.recent]).filter(v => v !== id);
          next.projects.forEach(p => { p.chatIds = p.chatIds.filter(v => v !== id); });
          const p = next.projects.find(p => p.id === target);
          // The first drag starts from the creation-sorted view, not the older
          // membership insertion order. Preserve hidden references at the end.
          if (p) p.chatIds = unique([...projectIds, ...p.chatIds]).filter(v => v !== id);
          const list = p ? p.chatIds : target === 'pinned' ? next.pins : next.recent;
          const at = list.indexOf(beforeId);
          list.splice(at < 0 ? list.length : at, 0, id);
          next.manualOrder = normalizedManualOrder(next.manualOrder);
          if (target === 'recent') next.manualOrder.recent = true;
          else if (p) next.manualOrder.projects[p.id] = true;
          if (p) { p.collapsed = false; next.collapsed = false; }
          remember(next, [item]);
        });
      },
      forget(id) { forgetMany([id]); },
      forgetMany,
    };
  }

  function projectSync({store, api, storage, key, current = () => true, changed = () => {}, error = () => {}}) {
    const checkpointKey = key + ':sync';
    let busy = false, pending = false, applying = false;
    const shape = row => row ? {name: row.name, chatIds: row.chatIds, deleted: false} : null;
    const digest = row => JSON.stringify(shape(row));
    async function run() {
      if (applying || !current() || !api.conversationProjects) return;
      if (busy) { pending = true; return; }
      busy = true;
      try {
        do {
        pending = false;
        const checkpoints = JSON.parse(storage.getItem(checkpointKey) || '{}');
        const reply = await api.conversationProjects();
        if (!current()) return;
        const remote = new Map(reply.items.map(row => [row.id, row]));
        const getAccount = () => store.getAccount ? store.getAccount() : store.get();
        const local = new Map(getAccount().projects.filter(row => !row.appId).map(row => [row.id, row]));
        for (const id of new Set([...local.keys(), ...remote.keys(), ...Object.keys(checkpoints)])) {
          if (!current()) return;
          // A previous project's save may have awaited while this project was edited.
          const here = getAccount().projects.find(row => row.id === id && !row.appId);
          const there = remote.get(id), saved = checkpoints[id];
          const hash = digest(here);
          const dirty = saved ? hash !== saved.hash : !!here && !there;
          if (dirty) {
            const body = here ? shape(here) : {name: saved.name, deleted: true};
            const updated = await api.saveConversationProject(id, {...body, revision: saved?.revision || 0});
            if (!current()) return;
            // Re-read: edits made while the request was in flight remain dirty.
            checkpoints[id] = {revision: updated.revision, hash, name: updated.name};
          } else if (there) {
            if (!saved && here && digest(here) !== digest(there)) {
              throw Error('项目在另一台设备也有改动，原分组已保留，请在项目中确认后重试');
            }
            applying = true;
            try { store.applyRemoteProject({...there, chatIds: shape(there).chatIds}); }
            finally { applying = false; }
            checkpoints[id] = {revision: there.revision, hash: digest(there.deleted ? null : there), name: there.name};
            changed();
          }
          storage.setItem(checkpointKey, JSON.stringify(checkpoints));
        }
        } while (pending && current());
      } catch (e) { if (current()) error(e); }
      finally { busy = false; }
    }
    return {run};
  }
  const localHistoryId = id => localHistory?.aliases.get(String(id || '')) || '';
  const localHistoryRevision = workspace => localHistory?.workspace === workspace ? localHistory.revision : -1;
  global.WorkspaceSidebarState = { create, normalized, storageKey, accountOptions, projectSync, setLocalHistory, localHistoryId, localHistoryRevision };
})(window);
