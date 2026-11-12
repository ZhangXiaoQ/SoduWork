/*
 * Compact Skill chooser. # opens suggestions; only explicitly selected skill metadata
 * accompanies this turn. Preserve #, /, and /skill:name in conversation text.
 */
(function (global) {
  'use strict';

  const RECENT_KEY = 'soduwork.compose.skill.recent.v1';
  const esc = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function recent() {
    try {
      const value = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(value) ? value.map(String).slice(0, 8) : [];
    } catch (error) { return []; }
  }
  function remember(name) {
    const next = [name, ...recent().filter((item) => item !== name)].slice(0, 8);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch (error) { /* private mode */ }
  }
  function queryOf(value, cursor) {
    const before = String(value || '').slice(0, Number(cursor || 0));
    const hash = before.lastIndexOf('#');
    if (hash < 0 || (hash > 0 && before.charAt(hash - 1).trim())) return null;
    const token = before.slice(hash + 1);
    if ([...token].some((char) => !char.trim())) return null;
    const raw = token;
    return {
      raw, query: raw.replace(/^skill:/, '').toLowerCase(),
      start: before.length - raw.length - 1,
      end: before.length,
    };
  }

  function create(options) {
    const opts = options || {};
    const host = opts.host;
    const input = opts.input;
    if (!host || !input) return null;
    const navigation = global.ComposeCandidateNavigation;
    let items = [];
    let menuItems = [];
    const selected = new Set();
    let active = 0;
    let match = null;
    let loading = opts.loading !== false;
    let loadMessage = String(opts.loadMessage || '正在加载团队 Skill…');
    let loadError = '';
    let positionFrame = null;
    let observingPosition = false;
    let sizeObserver = null;

    const tags = document.createElement('div');
    tags.className = 'cp-skill-tags';
    tags.setAttribute('aria-label', '本次使用的 Skill');
    const menu = document.createElement('div');
    menu.className = 'cp-skill-menu';
    menu.id = String(opts.menuId || 'cpSkillMenu');
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', '选择 Skill');
    input.setAttribute('aria-controls', menu.id);
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    host.appendChild(tags);
    host.appendChild(menu);

    function positionMenu() {
      if (!menu.classList.contains('show')) return;
      if (host.isConnected === false) { close(); return; }
      const rect = host.getBoundingClientRect?.();
      if (!rect || !Number.isFinite(rect.left)) return;
      const viewport = global.visualViewport;
      const margin = 8, gap = 8;
      const left = (viewport?.offsetLeft || 0) + margin;
      const top = (viewport?.offsetTop || 0) + margin;
      const right = left + (viewport?.width || global.innerWidth) - margin * 2;
      const bottom = top + (viewport?.height || global.innerHeight) - margin * 2;
      const width = Math.max(0, Math.min(460, Math.max(180, rect.width - 32), right - left));
      const above = Math.max(0, Math.min(rect.top, bottom) - top - gap);
      const below = Math.max(0, bottom - Math.max(rect.bottom, top) - gap);
      const desired = Math.min(360, menu.scrollHeight + 2);
      const useAbove = below < desired && above > below;
      const available = useAbove ? above : below;
      // A tall composer can occupy the entire viewport. Keep its menu usable
      // within the visible area instead of creating a zero-height popup.
      const height = Math.min(desired, available >= 80 ? available : Math.max(0, bottom - top));
      const anchorTop = useAbove ? rect.top - gap - height : rect.bottom + gap;
      menu.style.left = Math.max(left, Math.min(rect.left + 16, right - width)) + 'px';
      menu.style.top = Math.max(top, Math.min(anchorTop, bottom - height)) + 'px';
      menu.style.width = width + 'px';
      menu.style.maxHeight = height + 'px';
    }

    function schedulePosition(event) {
      if (event?.target?.nodeType && menu.contains?.(event.target)) return;
      if (positionFrame !== null) return;
      if (typeof global.requestAnimationFrame !== 'function') { positionMenu(); return; }
      positionFrame = global.requestAnimationFrame(() => { positionFrame = null; positionMenu(); });
    }

    function watchPosition() {
      positionMenu();
      if (observingPosition) return;
      observingPosition = true;
      global.addEventListener?.('resize', schedulePosition);
      global.addEventListener?.('scroll', schedulePosition, true);
      global.visualViewport?.addEventListener('resize', schedulePosition);
      global.visualViewport?.addEventListener('scroll', schedulePosition);
      if (typeof global.ResizeObserver === 'function') {
        sizeObserver = new global.ResizeObserver(schedulePosition);
        sizeObserver.observe(host);
      }
    }

    function stopPositioning() {
      observingPosition = false;
      global.removeEventListener?.('resize', schedulePosition);
      global.removeEventListener?.('scroll', schedulePosition, true);
      global.visualViewport?.removeEventListener('resize', schedulePosition);
      global.visualViewport?.removeEventListener('scroll', schedulePosition);
      sizeObserver?.disconnect();
      sizeObserver = null;
      if (positionFrame !== null) global.cancelAnimationFrame?.(positionFrame);
      positionFrame = null;
    }

    function ranked(query) {
      const q = String(query || '').toLowerCase();
      const used = recent();
      return items.filter((item) => {
        const hay = [item.name, item.description, item.compatibility,
          global.SoduWorkBuiltinSkills?.text(item), global.SoduWorkBuiltinSkills?.text(item, 'description')].join(' ').toLowerCase();
        return !q || hay.includes(q);
      }).sort((a, b) => {
        const ai = used.indexOf(a.name);
        const bi = used.indexOf(b.name);
        if (ai >= 0 || bi >= 0) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
        return String(a.name).localeCompare(String(b.name));
      });
    }

    function paintTags() {
      // A recovered selection is explicit even while its catalog loads or its
      // permission changes. Keep the chip so execution can freshly validate it.
      const chosen = [...selected].map(name => items.find(item => item.name === name) || { name });
      tags.innerHTML = chosen.map((item) =>
        '<span class="cp-skill-tag"' + (global.SoduWorkBuiltinSkills?.title(item) || ' title="' + esc(item.description || item.name) + '"') + '>' +
          '<i>Skill</i><b>' + (global.SoduWorkBuiltinSkills?.html(item) || esc(item.name)) + '</b>' +
          '<button data-remove-skill="' + esc(item.name) + '" aria-label="移除 ' + esc(item.name) + '">×</button>' +
        '</span>').join('');
      tags.classList.toggle('show', !!chosen.length);
      opts.onChange?.([...selected]);
    }

    function close() {
      match = null;
      stopPositioning();
      menu.classList.remove('show');
      menu.innerHTML = '';
      menuItems = [];
      input.removeAttribute('aria-activedescendant');
      input.setAttribute('aria-expanded', 'false');
    }

    function paintMenu() {
      // Late catalog updates must not rearm a picker whose composer was removed.
      if (!match || host.isConnected === false) { close(); return; }
      const scrollTop = menu.scrollTop;
      const rows = menuItems = loading || loadError ? [] : ranked(match.query);
      active = navigation.normalize(rows, active, item => item.selectable);
      input.removeAttribute('aria-activedescendant');
      const head =
        '<div class="cp-skill-menu-head"><span>Skill</span>' +
        '<i>↑↓ 选择 · Enter 使用 · Esc 关闭</i></div>';
      if (loading) {
        menu.innerHTML = head +
          '<div class="cp-skill-empty is-loading"><span class="cp-skill-spinner"></span>' +
          esc(loadMessage) + '</div>';
      } else if (loadError) {
        menu.innerHTML = head + '<div class="cp-skill-empty is-error">' + esc(loadError) + '</div>';
      } else if (!rows.length) {
        const empty = match.query ? '没有匹配的 Skill' : '团队还没有发布可用 Skill';
        menu.innerHTML = head + '<div class="cp-skill-empty">' + empty + '</div>';
      } else {
        menu.innerHTML = head +
          rows.map((item, index) => {
            const on = selected.has(item.name);
            const state = item.installed ? '已安装' : (item.installState === 'remote' ? '选择后同步' : '不可用');
            const icon = global.SoduWorkPluginIcon && typeof global.SoduWorkPluginIcon.image === 'function'
              ? global.SoduWorkPluginIcon.image(item.icon) : '';
            return '<button id="cpSkillOption' + index + '" class="cp-skill-option' +
              (index === active ? ' active' : '') + (on ? ' selected' : '') +
              '" role="option" aria-selected="' + (on ? 'true' : 'false') +
              '" aria-disabled="' + (!item.selectable ? 'true' : 'false') +
              '" data-skill-name="' + esc(item.name) + '">' +
                '<span class="cp-skill-glyph">' + (icon || '#') + '</span><span class="cp-skill-copy"><b>#' +
                  (global.SoduWorkBuiltinSkills?.html(item) || esc(item.name)) + '</b><i>' + (global.SoduWorkBuiltinSkills?.html(item, 'description') || esc(item.description || '企业工作方法')) + '</i></span>' +
                '<em>' + esc(state) + '</em></button>';
          }).join('');
        if (active >= 0) input.setAttribute('aria-activedescendant', 'cpSkillOption' + active);
      }
      menu.classList.add('show');
      watchPosition();
      menu.scrollTop = scrollTop;
      input.setAttribute('aria-expanded', 'true');
    }

    function choose(name) {
      const item = items.find((row) => row.name === name);
      if (!item || !item.selectable) {
        if (opts.say) opts.say((item && item.reason) || '这个 Skill 当前不可用');
        return false;
      }
      selected.add(name);
      remember(name);
      if (match) {
        const value = input.value;
        input.value = value.slice(0, match.start) + value.slice(match.end).replace(/^\s+/, '');
        input.setSelectionRange(match.start, match.start);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      paintTags();
      close();
      return true;
    }

    function onInput() {
      match = queryOf(input.value, input.selectionStart);
      active = 0;
      menu.scrollTop = 0;
      paintMenu();
    }
    function onKeydown(event) {
      if (event.isComposing || !menu.classList.contains('show')) return false;
      const rows = menuItems;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopImmediatePropagation();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        active = navigation.move(rows, active, delta, item => item.selectable);
        navigation.highlight(menu, input, '.cp-skill-option', 'active', active, true);
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); close(); return true;
      }
      if ((event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) && rows.length) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (rows[active]) choose(rows[active].name);
        return true;
      }
      return false;
    }

    input.addEventListener('input', onInput);
    input.addEventListener('click', onInput);
    input.addEventListener('keydown', onKeydown, true);
    menu.addEventListener('mousedown', (event) => event.preventDefault());
    input.addEventListener('compositionend', onInput);
    menu.addEventListener('click', (event) => {
      const button = event.target.closest('[data-skill-name]');
      if (button) choose(button.dataset.skillName || '');
    });
    tags.addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-skill]');
      if (!button) return;
      selected.delete(button.dataset.removeSkill || '');
      paintTags();
      input.focus();
    });
    document.addEventListener('click', (event) => {
      if (!host.contains(event.target)) close();
    });

    return {
      setLoading(value, message) {
        loading = value !== false;
        if (message) loadMessage = String(message);
        if (loading) loadError = '';
        if (match) paintMenu();
      },
      setError(message) {
        loading = false;
        loadError = String(message || '团队 Skill 暂时不可用');
        items = [];
        paintTags();
        if (match) paintMenu();
      },
      setItems(next) {
        loading = false;
        loadError = '';
        items = Array.isArray(next) ? next.slice() : [];
        paintTags();
        if (match) paintMenu();
      },
      selected: () => [...selected],
      restore(names) {
        selected.clear();
        selectionNames(names).forEach(name => selected.add(name));
        paintTags(); close();
      },
      clear() { selected.clear(); paintTags(); close(); },
      consume(names) { for (const name of names || []) selected.delete(name); paintTags(); close(); },
      close,
      queryOf,
    };
  }

  // Compatibility API: body text never grants a Skill selection. # remains a
  // palette hook; only a chosen chip or saved structured selection is sent.
  function namesFromText() { return []; }
  function selectionNames(value) {
    return [...new Set((Array.isArray(value) ? value : []).filter(name =>
      typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name)))].slice(0, 20);
  }

  // Preserve the body and explicit metadata separately. Empty, skill-only
  // turns still have visible text; that text alone cannot invoke a Skill.
  function submission(value, selected) {
    const text = String(value || '');
    const skills = selectionNames(selected);
    return { text: text.trim() ? text : skills.map(name => '#' + name).join(' '), skills };
  }

  function withPluginIcons(skills, catalog) {
    const rows = Array.isArray(skills) ? skills : [];
    const source = Array.isArray(catalog) ? catalog : (catalog && Array.isArray(catalog.items) ? catalog.items : []);
    const icons = new Map();
    const keyOf = (value) => String(value == null ? '' : value).trim().toLowerCase().replace(/^#/, '');
    source.forEach((plugin) => {
      const icon = global.SoduWorkPluginIcon && typeof global.SoduWorkPluginIcon.source === 'function'
        ? global.SoduWorkPluginIcon.source(plugin)
        : String(plugin && plugin.icon || '').trim();
      if (!icon) return;
      const cap = plugin && plugin.capabilities || {};
      const keys = [plugin.name, plugin.key, plugin.pluginId, plugin.qualifiedKey];
      (Array.isArray(cap.skills) ? cap.skills : []).forEach((skill) => {
        keys.push(typeof skill === 'string' ? skill : skill && (skill.name || skill.key));
      });
      keys.map(keyOf).filter(Boolean).forEach((key) => { if (!icons.has(key)) icons.set(key, icon); });
    });
    return rows.map((item) => {
      if (!item || item.icon) return item;
      const icon = icons.get(keyOf(item.name || item.key));
      return icon ? Object.assign({}, item, { icon }) : item;
    });
  }

  global.ComposeSkills = { create, queryOf, namesFromText, submission, withPluginIcons };
})(window);
