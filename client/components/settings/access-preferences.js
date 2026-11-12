/* Device-local access preference. The main process owns storage and consent. */
(function (global) {
  'use strict';
  let state = { mode: 'standard', revision: 0 }, loaded = false, saving = false, serial = 0, pending;
  const listeners = new Set();
  const api = () => global.soduWorkAPI?.accessPreferences;
  const t = text => global.SoduWorkI18n?.getLocale?.() === 'zh-CN' ? text : global.SoduWorkI18n?.t?.(text) || text;
  function paint(message = '', error = false) {
    const host = document.getElementById('defaultAccessModes');
    if (!host) return;
    host.setAttribute('aria-busy', String(saving || !loaded));
    host.querySelectorAll('[data-default-access]').forEach(button => {
      const selected = button.dataset.defaultAccess === state.mode;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-checked', String(selected));
      button.disabled = saving || !loaded;
    });
    const note = document.getElementById('defaultAccessStatus');
    if (note) {
      note.textContent = t(message || (saving ? '正在保存…' : state.mode === 'full'
        ? '新建对话将默认完全访问，请仅执行可信任的任务。' : '新建对话会使用此模式，开始前仍可单独调整。'));
      note.classList.toggle('is-error', error);
      note.classList.toggle('is-full', state.mode === 'full' && !error);
    }
  }
  function accept(value) {
    if (!['standard', 'readonly', 'full'].includes(value?.mode) || !Number.isSafeInteger(value.revision)) return;
    state = { mode: value.mode, revision: value.revision }; loaded = true;
    paint(); listeners.forEach(listener => listener({ ...state }));
  }
  async function refresh() {
    if (pending) return pending;
    const seq = ++serial;
    pending = Promise.resolve().then(() => api()?.get()).then(reply => {
      if (!reply?.ok) throw Error(reply?.reason || '无法读取默认授权模式，请重试');
      if (seq === serial) accept(reply);
      return { ...state };
    }).catch(error => { paint(error.message, true); return { ...state }; }).finally(() => { pending = null; });
    return pending;
  }
  async function choose(mode) {
    if (saving || !loaded || state.mode === mode) return;
    saving = true; ++serial; paint();
    try {
      const reply = await api().set(mode, state.revision);
      if (reply?.ok) accept(reply);
      else if (!reply?.cancelled) {
        if (reply?.mode) accept(reply);
        throw Error(reply?.reason || '默认授权模式未保存，请重试');
      }
      saving = false; paint();
    } catch (error) { saving = false; paint(error.message, true); }
  }
  async function remember(mode) {
    if (!['standard', 'readonly', 'full'].includes(mode)) return { ok: false };
    try {
      const reply = await api()?.remember?.(mode);
      if (reply?.ok) accept(reply);
      return reply || { ok: false };
    } catch (error) { return { ok: false, reason: error.message }; }
  }
  const host = document.getElementById('defaultAccessModes');
  host?.addEventListener('click', event => {
    const button = event.target.closest('[data-default-access]');
    if (button && !button.disabled) void choose(button.dataset.defaultAccess);
  });
  api()?.onChange?.(value => { ++serial; accept(value); });
  global.addEventListener?.('soduwork-locale-change', () => paint());
  global.AccessPreferences = Object.freeze({ refresh,
    ready: () => loaded ? Promise.resolve({ ...state }) : refresh(),
    snapshot: () => ({ ...state }),
    remember,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  });
  void refresh();
})(window);
