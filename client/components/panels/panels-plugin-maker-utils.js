/* Shared, side-effect-free helpers for the client plugin authoring surface. */
(function (global) {
  'use strict';

  function html(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function errorText(error, fallback = '插件检查没有完成') {
    // Electron prefixes a rejected IPC call with transport details; retain the
    // actionable validation reason without exposing that implementation wrapper.
    return String(error?.message || error || fallback)
      .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').trim().slice(0, 240) || fallback;
  }

  function values(value) {
    return [...new Set(String(value || '').split(/[,，\n]/).map(x => x.trim()).filter(Boolean))];
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function versionParts(value) {
    const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) : [0, 0, 0];
  }

  function compareVersions(left, right) {
    const a = versionParts(left), b = versionParts(right);
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
  }

  function nextVersion(value, versions) {
    const parts = versionParts(value);
    const used = new Set((versions || []).map(item => String(item.version || item)));
    let candidate;
    do {
      parts[2] += 1;
      candidate = parts.join('.');
    } while (used.has(candidate));
    return candidate;
  }

  function resourceMarkup(resources) {
    if (!Array.isArray(resources) || !resources.length) return '';
    const labels = { template: '模板', example: '示例', asset: '素材', script: '脚本', reference: '参考', ui: '页面文件' };
    const size = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.ceil(bytes / 1024)) + ' KB';
    return '<details class="cap-resource-pack" open><summary><span class="cap-resource-emblem" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3ZM4 7.5l8 4.5 8-4.5M12 12v9M8 5.2l8 4.5v4"/></svg></span>' +
      '<span><b>随包资源</b><small>随版本保存 · 试用可读取 · 上传时一并携带</small></span>' +
      '<span class="cap-resource-count">' + resources.length + ' 个文件</span></summary>' +
      '<div class="cap-resource-list">' + resources.map(item => '<div class="cap-resource-row">' +
        '<span class="cap-resource-kind">' + html(labels[item.kind] || '资源') + '</span>' +
        '<span class="cap-resource-name" title="' + html(item.path) + '">' + html(item.path) + '</span>' +
        '<span class="cap-resource-size">' + size(Number(item.size) || 0) + '</span></div>').join('') + '</div>' +
      '<p>模板请复制后使用。安装不会执行脚本；页面文件暂不自动挂载为交互界面。</p></details>';
  }
  const MAX_PACKAGE_BYTES = 10 * 1024 * 1024;
  async function preflightArchive(api, file) {
    if (api && typeof api.preflightPluginArchive === 'function') {
      try { return await api.preflightPluginArchive(file); }
      catch (_) { /* Enterprise adapters still use the Hub preflight below. */ }
    }
    return api.preflightPlugin(file);
  }
  async function choosePackage(api, callbacks) {
    const bridge = global.soduWorkAPI && global.soduWorkAPI.personalPlugins;
    if (bridge && typeof bridge.choosePackage === 'function') {
      try {
        const picked = await bridge.choosePackage();
        if (!picked || picked.canceled) { callbacks.cancel?.(); return; }
        if (picked.kind === 'draft') await callbacks.local(picked.body, await api.preflightPluginDraft(picked.body));
        else {
          const bytes = Uint8Array.from(atob(picked.content), c => c.charCodeAt(0));
          const file = new File([bytes], picked.name, { type: 'application/zip' });
          await callbacks.archive(file, await preflightArchive(api, file));
        }
        return;
      } catch (error) {
        // A renderer reload may precede the main-process restart during a source
        // upgrade. Keep the existing self-contained package import usable.
        if (!/No handler registered.*personal-plugin-choose-package/.test(String(error && error.message))) {
          callbacks.error(error); return;
        }
      }
    }
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,.zip,.soduwork-plugin,.soduwork-plugin,.soduwork-plugin,application/json,application/zip';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) { callbacks.cancel?.(); return; }
      try {
        if (file.size > MAX_PACKAGE_BYTES) throw new Error('插件文件超过10MB，请精简资源后重试');
        if (/\.json$/i.test(file.name || '')) {
          const body = JSON.parse(await file.text());
          await callbacks.local(body, await api.preflightPluginDraft(body));
        } else await callbacks.archive(file, await preflightArchive(api, file));
      } catch (error) { callbacks.error(error); }
    });
    input.addEventListener('cancel', () => callbacks.cancel?.());
    input.click();
  }
  const repairs = new Set();
  async function openConversationDraft(ref, target, button, ctx) {
    if (button && button.disabled) return;
    const label = button && button.textContent;
    const errorEl = button?.closest?.('.nplugin-draft')?.querySelector('.nplugin-draft-error');
    const card = button?.closest?.('.nplugin-draft');
    let report = card?.querySelector?.('.nplugin-checks');
    if (!report && card?.appendChild && global.document?.createElement) {
      report = global.document.createElement('div'); report.className = 'nplugin-checks';
      report.setAttribute('role','status'); card.appendChild(report);
    }
    const checks = [];
    const paint = () => {
      if (!report?.replaceChildren) return;
      report.replaceChildren();
      for (const row of checks) {
        const line = global.document.createElement('p'); line.dataset.state = row.state;
        line.textContent = (row.state === 'passed' ? '✓ ' : row.state === 'failed' ? '✕ ' : '○ ') + row.label;
        report.appendChild(line);
      }
    };
    let draft;
    if (errorEl) errorEl.hidden = true;
    if (button) { button.disabled = true; button.textContent = '正在检查…'; }
    try {
      const api = global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
      if (!api || typeof api.pluginDraft !== 'function') throw Error('请更新并重启 SoduWork 后安装会话插件');
      const result = await api.pluginDraft(ref, target);
      if (!result || !result.ok) throw Error(result && result.reason || '草稿读取失败');
      draft = result.body;
      checks.push({state:'passed',label:'已读取本会话的实际草稿和随包资源'}); paint();
      const preview = await global.SoduWorkAPI.preflightPluginDraft(result.body);
      if(button?.isConnected===false)return;
      if(draft.template==='app'){
        const hint=card?.querySelector?.('.nplugin-draft-copy span');if(hint)hint.textContent='即用已生成，可以检查并安装';
        const mark=card?.querySelector?.('.nplugin-draft-icon');
        if(mark?.replaceChildren&&preview.manifest?.icon&&global.document?.createElement){const image=global.document.createElement('img');image.src=preview.manifest.icon;image.alt='';mark.replaceChildren(image);}
      }
      for (const check of preview.checks || []) checks.push({state:check.state==='pending'||check.ok==null ? 'pending' : check.ok ? 'passed' : 'failed',label:check.label});
      checks.push({state:'pending',label:preview.runtime?.executed ? '真实AI、业务授权与视觉质量：待实际操作验收；隔离首屏不代表业务完成' : '业务运行、真实服务授权和视觉质量：尚未执行；安装预检不代表业务验收'}); paint();
      if (preview.ok === false || preview.checks?.some(check => check.ok === false)) throw Error((preview.checks||[]).filter(check=>check.ok===false).map(check=>check.label).join('\n')||'预检仍有未通过项');
      global.SoduWorkCapabilityPlugins.openLocalImport(result.body, preview, ctx);
    } catch (error) {
      if(button?.isConnected===false)return;
      const message = errorText(error);
      if (errorEl) { errorEl.textContent = message; errorEl.hidden = false; }
      checks.push({state:'failed',label:message}); paint();
      if (report?.appendChild && global.document?.createElement) {
        const repair = global.document.createElement('button'); repair.type = 'button';
        repair.className = 'btn-mini'; repair.textContent = '立即修复';
        const repairKey = ref + '\0' + target;
        if (repairs.has(repairKey)) { repair.disabled = true; repair.textContent = '原会话正在修复'; }
        repair.onclick = async () => {
          if (repair.disabled || repairs.has(repairKey)) return;
          const api = global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
          repair.disabled = true; repairs.add(repairKey);
          let off = () => {}, accepted, expiry, outcome, finished = false;
          const submissionId = 'repair-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,9);
          const finish = () => {
            if (!accepted || !outcome || finished) return;
            finished = true; off(); clearTimeout(expiry); repairs.delete(repairKey);
            if (outcome.kind !== 'settled') {
              repair.disabled = false; repair.textContent = '立即修复';
              ctx.say(outcome.reason || '修复未完成，可重试或继续在原会话处理'); return;
            }
            repair.textContent = '正在重新检查…';
            if (button?.isConnected !== false) void openConversationDraft(ref,target,button,ctx);
          };
          try {
            if (!api?.send) throw Error('原开发会话发送接口不可用');
            const prompt = ['请修复本会话刚生成的即用交付包，保留用户已有内容。',
              '目标成果：' + target, '即用：' + String(draft?.key || '待读取') + '；版本：' + String(draft?.version || '待读取'),
              '本次检查错误：' + message,
              '读取实际文件→定位修复→提升版本号→运行随包 validate.cjs→重新登记交付；不要只解释错误，不扩大权限，不修改其他业务工程。'].join('\n');
            if (api.onEvent) off = api.onEvent(event => {
              if (event.ref !== ref || !['settled','error','turn-queue-cancelled'].includes(event.kind) || event.submissionId !== submissionId) return;
              outcome = event; finish();
            });
            expiry = setTimeout(() => { off(); repairs.delete(repairKey); repair.disabled = false; repair.textContent = '重新检查'; repair.onclick = () => openConversationDraft(ref,target,button,ctx); }, 600000);
            accepted = await api.send(ref,prompt,[],{source:'jiyong-repair',submissionId});
            if (!accepted?.ok) { clearTimeout(expiry); throw Error(accepted?.reason || '修复请求发送失败'); }
            repair.textContent = accepted?.queued ? '已加入原会话队列' : '已在原会话发起修复';
            finish();
          } catch (failure) { off(); clearTimeout(expiry); repairs.delete(repairKey); repair.disabled = false; ctx.say(errorText(failure)); }
        };
        report.appendChild(repair);
      }
      ctx.say(message);
    }
    finally { if (button) { button.disabled = false; button.textContent = label; } }
  }
  global.SoduWorkPluginMakerUtils = { html, errorText, values, clone, compareVersions, nextVersion, resourceMarkup, choosePackage, openConversationDraft };
})(window);
