/* Personal cloud environment setup and one-time credential rotation. */
(function (global) {
  'use strict';
  let active = null, busy = false;
  const owners = new WeakMap();
  const ownerScope = () => String(global.SoduWorkAPI?.taskStorageKey?.('ops') || 'renderer');
  const esc = value => global.CloudEnvironments.esc(value);
  const translateDialog = node => global.SoduWorkI18n?.translateNode?.(node);
  const isCurrent = node => active === node && owners.get(node) === ownerScope();
  function close() { if (busy || !active) return; active.close(); active.remove(); active = null; }
  function invalidate() { busy = false; if (active && owners.get(active) !== ownerScope()) { active.close(); active.remove(); active = null; } }
  function dialog(title, subtitle, body, submitLabel, options = {}) {
    if (active) { active.focus(); return null; }
    const node = document.createElement('dialog'); active = node; owners.set(node, ownerScope());
    node.className = 'ce-dialog'; node.setAttribute('aria-labelledby', 'ceDialogTitle');
    node.innerHTML = '<form><header><span class="ce-dialog-icon">' + global.CloudEnvironments.icon + '</span><div><h2 id="ceDialogTitle">' + esc((title)) + '</h2><p' + (options.translateSubtitle === false ? ' translate="no"' : '') + '>' + esc(options.translateSubtitle === false ? String(subtitle ?? '') : (subtitle)) + '</p></div><button type="button" data-ce-dismiss aria-label="' + esc(('关闭')) + '">×</button></header><div class="ce-dialog-body">' + body + '<p class="ce-error" role="alert" hidden></p></div><footer><div class="ce-progress" data-ce-progress role="status" aria-live="polite" hidden><span class="ce-progress-spinner" aria-hidden="true"></span><span data-ce-progress-label></span></div><button type="button" data-ce-dismiss>' + esc(('取消')) + '</button><button type="submit" class="ce-primary">' + esc((submitLabel)) + '</button></footer></form>';
    node.querySelectorAll('[data-ce-dismiss]').forEach(button => button.addEventListener('click', close));
    node.addEventListener('cancel', event => { event.preventDefault(); close(); });
    document.body.append(node); translateDialog(node); node.showModal(); return node;
  }
  function checked(result, node) {
    if (!isCurrent(node)) throw Error(('账号或服务已切换，请重新打开云端环境'));
    if (result?.ok === false) throw Error(result.reason || result.error || result.message || ('操作没有完成，请重试'));
    return result;
  }
  function failure(node, error) { const box = node.querySelector('[role=alert]'); box.textContent = (error.message || '操作没有完成，请重试'); box.hidden = false; }
  function progress(node, message) {
    const box = node.querySelector('[data-ce-progress]');
    box.querySelector('[data-ce-progress-label]').textContent = (message);
    box.hidden = false;
  }
  async function run(node, action) {
    if (busy || !isCurrent(node)) return;
    busy = true; node.querySelector('[role=alert]').hidden = true; node.setAttribute('aria-busy', 'true');
    progress(node, '正在处理，请稍候…');
    const controls = [...node.querySelectorAll('button,input,select,textarea')], prior = controls.map(item => item.disabled); controls.forEach(item => { item.disabled = true; });
    try { await action(); } catch (error) { if (isCurrent(node)) failure(node, error); }
    finally { if (active === node) busy = false; node.removeAttribute('aria-busy'); node.querySelector('[data-ce-progress]').hidden = true; controls.forEach((item, i) => { item.disabled = prior[i]; }); }
  }
  function setupCommand(result, platform) {
    const setup = result?.setup || result || {};
    return setup.commands?.[platform] || setup.command || '';
  }
  function showOneTimeCredential(node, result, platform, title, onChange) {
    const setup = result?.setup || result || {}, row = result?.environment || {};
    const command = setupCommand(result, platform), key = setup.key || setup.token || result?.key || '';
    if (!command && !key) throw Error(('环境已保存，但没有拿到一次性接入凭据，请重新生成'));
    const secret = command || key;
    node.dataset.created = 'true';
    node.querySelector('.ce-dialog-body').innerHTML = '<div class="ce-onetime"><span class="ce-onetime-badge">仅显示一次</span><h3>' + esc((title)) + '</h3><p>请在这台云端电脑上完成接入。凭据不会保存到客户端，关闭窗口后无法再次查看。</p><div class="ce-command"><pre translate="no"></pre><button type="button" data-ce-copy>复制凭据</button></div><p class="ce-help">凭据拥有这台执行机的接入权限，请只在目标电脑的终端中使用，不要发到公开聊天或工单。</p></div><div class="ce-connection-check"><p data-ce-connection role="status">完成接入后，可以检查连接状态。</p><button type="button" data-ce-check>检查连接</button></div><p class="ce-error" role="alert" hidden></p>';
    translateDialog(node);
    node.querySelector('pre').textContent = secret;
    node.querySelector('button[type=submit]').textContent = ('完成');
    node.querySelector('footer [data-ce-dismiss]').hidden = true;
    node.querySelector('[data-ce-copy]').addEventListener('click', async event => {
      try { await navigator.clipboard.writeText(secret); if (isCurrent(node)) event.currentTarget.textContent = ('已复制'); }
      catch (_) { if (isCurrent(node)) failure(node, Error(('无法复制，请手动选中凭据复制'))); }
    });
    node.querySelector('[data-ce-check]').addEventListener('click', () => void run(node, async () => {
      const latest = checked(await global.SoduWorkAPI.cloudEnvironments(), node);
      const current = (latest.environments || []).find(item => item.id === (row.id || setup.runnerId));
      node.querySelector('[data-ce-connection]').textContent = current?.online ? (current.statusText || '已连接') + ' · ' + (current.statusReason || '连接状态已更新') : ('尚未连接，请确认目标电脑已启动 Runner，并能访问 SoduWork 服务');
      onChange?.();
    }));
  }
  function readCredential(form) {
    const host = String(form.elements.host?.value || '').trim();
    const port = Number.parseInt(form.elements.port?.value || '22', 10);
    const username = String(form.elements.username?.value || '').trim();
    const authMethod = form.elements.authMethod?.value === 'privateKey' ? 'privateKey' : 'password';
    const secret = String(form.elements[authMethod === 'privateKey' ? 'privateKey' : 'password']?.value || '');
    const passphrase = String(form.elements.passphrase?.value || '');
    if (!host || /[\s\\`;$|<>]/.test(host) || host.length > 253) throw Error(('请输入有效的云端电脑地址或主机名'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error(('SSH 端口必须是 1–65535 之间的数字'));
    if (!username || username.length > 128 || /[\r\n]/.test(username)) throw Error(('请输入有效的登录账号'));
    if (!secret) throw Error((authMethod === 'privateKey' ? '请粘贴 SSH 私钥' : '请输入登录密码'));
    return { host, port, username, platform: form.elements.platform?.value || 'linux', authMethod, [authMethod === 'privateKey' ? 'privateKey' : 'password']: secret,
      ...(authMethod === 'privateKey' && passphrase ? { passphrase } : {}) };
  }
  function bindAuthFields(form) {
    const method = form.elements.authMethod, password = form.querySelector('[data-ce-password]'), key = form.querySelector('[data-ce-private-key]');
    const update = () => { const isKey = method.value === 'privateKey'; password.hidden = isKey; key.hidden = !isKey; password.querySelector('input').required = !isKey; key.querySelector('textarea').required = isKey; };
    method.addEventListener('change', update); update();
  }
  function credentialForm(row) {
    const saved = row?.localCredential || {};
    return '<fieldset class="ce-credential-fields"><legend>云端电脑登录信息</legend>' +
      '<label>IP 地址或主机名<input name="host" value="' + esc(saved.host || '') + '" placeholder="例如 192.0.2.20 或 dev.example.com" autocomplete="off" required></label>' +
      '<div class="ce-field-row"><label>SSH 端口<input name="port" type="number" min="1" max="65535" value="' + esc(saved.port || 22) + '" required></label>' +
      '<label>登录账号<input name="username" value="' + esc(saved.username || '') + '" placeholder="例如 root 或 ubuntu" autocomplete="username" required></label></div>' +
      '<label>认证方式<select name="authMethod"><option value="password">账号密码</option><option value="privateKey">SSH 私钥</option></select></label>' +
      '<div data-ce-password><label>登录密码<input name="password" type="password" autocomplete="new-password" placeholder="只保存在本机安全存储中"></label></div>' +
      '<div data-ce-private-key hidden><label>SSH 私钥<textarea name="privateKey" rows="5" spellcheck="false" autocomplete="off" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></label><label>私钥口令（可选）<input name="passphrase" type="password" autocomplete="new-password"></label></div>' +
      '<p class="ce-help">凭据只在当前客户端加密保存，不会上传到 SoduWork 服务，也不会出现在日志或会话内容中。连接测试通过后才会保存；首次成功连接会记录 SSH 主机指纹，后续连接会校验它。登录账号需要具备安装 Runner 的权限（root，或可以无交互执行 sudo）。</p></fieldset>';
  }
  async function checkConnection(node, runnerId) {
    const button = node.querySelector('[data-ce-check]');
    const status = node.querySelector('[data-ce-connection]');
    button.disabled = true;
    status.textContent = ('正在检查执行机在线状态…');
    progress(node, '正在检查执行机在线状态…');
    try {
      const latest = checked(await global.SoduWorkAPI.cloudEnvironments(), node);
      const current = (latest.environments || []).find(item => item.id === runnerId);
      status.textContent = current?.online ? (current.statusText || '已连接') : ('尚未连接，请确认 Runner 已启动并能访问 SoduWork 服务');
    } catch (error) {
      if (isCurrent(node)) status.textContent = ('暂时无法确认在线状态，请重试检查连接');
      throw error;
    } finally { button.disabled = false; }
  }
  async function showInstallResult(node, result, setup, onChange, runnerId) {
    const installed = result?.installed !== false && result?.ok !== false;
    const title = result?.connectionOnly ? '连接信息已保存' : installed ? 'Runner 安装已完成' : '连接测试通过，但 Runner 安装未完成';
    const fallback = setupCommand({ setup }, result?.platform || 'linux');
    node.dataset.created = 'true';
    node.querySelector('.ce-dialog-body').innerHTML = '<div class="ce-onetime"><span class="ce-onetime-badge">' + (installed ? 'SSH 连接已验证' : '需要手动完成') + '</span><h3>' + title + '</h3><p>' + esc(result?.message || (installed ? 'SoduWork 已通过 SSH 完成 Runner 安装，稍后会自动检测在线状态。' : '请在目标电脑终端执行下方命令，完成后回到这里检查连接。')) + '</p>' + (installed || !fallback ? '' : '<div class="ce-command"><pre translate="no"></pre><button type="button" data-ce-copy>复制安装命令</button></div>') + '</div><div class="ce-connection-check"><p data-ce-connection role="status">正在刷新执行机状态…</p><button type="button" data-ce-check>检查连接</button></div><p class="ce-error" role="alert" hidden></p>';
    translateDialog(node);
    if (!installed && fallback) {
      node.querySelector('pre').textContent = fallback;
      node.querySelector('[data-ce-copy]').addEventListener('click', async event => { try { await navigator.clipboard.writeText(fallback); event.currentTarget.textContent = ('已复制'); } catch (_) { failure(node, Error(('无法复制，请手动选中命令复制'))); } });
    }
    node.querySelector('button[type=submit]').textContent = ('完成'); node.querySelector('footer [data-ce-dismiss]').hidden = true;
    node.querySelector('[data-ce-check]').addEventListener('click', () => void run(node, async () => { await checkConnection(node, runnerId); onChange?.(); }));
    onChange?.();
    await checkConnection(node, runnerId);
  }
  async function configure(node, form, data, row, onChange) {
    let credential = readCredential(form); const native = global.soduWorkAPI?.cloudComputer;
    const configuredHub = String(form.elements.hub?.value || data?.service?.recommendedHub || '').trim();
    // The command sent to the remote host must use the Hub's reachable/public
    // address, while the local credential vault is scoped to the Hub origin
    // that the signed-in client is currently using.  A development Hub often
    // reports `127.0.0.1` as `service.url` and a LAN address as
    // `recommendedHub`; using the latter for the vault makes the very first
    // SSH test fail with “please connect to SoduWork” before the environment can
    // even be created.  Keep these two origins separate.
    const activeHub = String(global.SoduWorkAPI?.hubConfig?.()?.hub || data?.service?.url || '').trim();
    if (activeHub || configuredHub) credential = { ...credential, hub: activeHub || configuredHub };
    if (form.elements.workRoot) credential.workRoot = String(form.elements.workRoot.value || '').trim();
    if (!native?.test) throw Error(('当前客户端不支持云端电脑连接，请升级后重试'));
    progress(node, '正在测试 SSH 连接…');
    const probe = await native.test({ credential });
    if (!isCurrent(node)) return;
    if (probe?.ok === false) throw Error(probe.reason || probe.error || probe.message || ('无法连接云端电脑，请检查地址、端口和登录信息'));
    if (probe?.hostFingerprint) credential = { ...credential, hostFingerprint: probe.hostFingerprint };
    progress(node, 'SSH 已连接，正在安全保存登录信息…');
    const persisted = await native.save({ credential });
    if (!isCurrent(node)) return;
    if (persisted?.ok === false) throw Error(persisted.reason || persisted.error || ('连接信息保存失败'));
    if (row) {
      await showInstallResult(node, { installed: true, connectionOnly: true, message: 'SSH 连接已验证；Runner 是否在线以下方检查结果为准。' }, {}, onChange, row.id); return;
    }
    const name = form.elements.name.value.trim(), hub = form.elements.hub.value.trim(), workRoot = form.elements.workRoot.value.trim();
    progress(node, 'SSH 已连接，正在创建云端环境…');
    const result = checked(await global.SoduWorkAPI.addCloudEnvironment({ name, hub, workRoot }), node);
    const setup = result.setup || {};
    // Cloud computers support Linux only; retain main-process Windows compatibility solely for existing credentials.
    const platform = form.elements.platform?.value || 'linux';
    let install;
    progress(node, 'SSH 已连接，正在安装 Runner，可能需要几分钟…');
    try { install = await native.install({ credential, setup, platform }); }
    catch (error) { install = { ok: false, error: error.message || '已创建环境，但 Runner 安装失败' }; }
    if (!isCurrent(node)) return;
    await showInstallResult(node, { ...install, platform, message: install?.reason || install?.error || install?.message }, setup, onChange, result.environment?.id || setup.runnerId);
  }
  function open(data, onChange) {
    if (!data?.permissions?.canCreate || (data.environments || []).length) return;
    const node = dialog('配置专属云端执行机', '在你自己的远程电脑上安装 Runner，云端会话将自动使用它。',
      '<label>环境名称<input name="name" maxlength="80" placeholder="例如：我的开发电脑" required autofocus></label>' +
      credentialForm() +
      '<details class="ce-advanced"><summary>连接设置</summary><label>SoduWork 服务地址<input name="hub" type="url" value="' + esc(data.service?.recommendedHub || '') + '" placeholder="https://soduwork.example.com" required></label><label>工作目录（可选）<input name="workRoot" maxlength="512" placeholder="留空使用执行机默认目录"></label><p class="ce-help">填写目标电脑可以访问的 SoduWork 服务地址。工作目录必须是目标电脑上的绝对路径。</p></details>' +
      '<p class="ce-help">会先测试 SSH 连接，再创建环境并自动安装 Runner；不需要复制命令到另一台窗口。</p>', '测试并接入');
    if (!node) return;
    const form = node.querySelector('form');
    bindAuthFields(form);
    form.addEventListener('invalid', event => { const details = event.target.closest('details'); if (details) details.open = true; }, true);
    form.addEventListener('submit', event => {
      event.preventDefault(); if (node.dataset.created) { close(); return; } if (!form.reportValidity()) return;
      void run(node, async () => { await configure(node, form, data, null, onChange); });
    });
  }
  function credentials(row, onChange) {
    if (!row?.canManage) return;
    const node = dialog('连接你的云端电脑', row.name || row.id, credentialForm(row), '测试并保存', { translateSubtitle: false });
    if (!node) return;
    const form = node.querySelector('form'); bindAuthFields(form);
    form.addEventListener('submit', event => { event.preventDefault(); if (node.dataset.created) { close(); return; } if (!form.reportValidity()) return; void run(node, async () => { await configure(node, form, null, row, onChange); }); });
  }
  function remove(row, onChange) {
    if (!row?.canManage) return;
    const node = dialog('移除云端电脑', row.name || row.id,
      '<div class="ce-remove-zone"><span class="ce-remove-mark">!</span><div><strong>确认移除这台专属执行机？</strong><p>空闲连接会立即断开并从当前账号移除。目标电脑上的文件不会被删除；仍在执行的会话需要先完成。</p></div></div>', '确认移除', { translateSubtitle: false });
    if (!node) return;
    node.querySelector('button[type=submit]').classList.add('ce-danger-primary');
    const form = node.querySelector('form');
    form.addEventListener('submit', event => { event.preventDefault(); if (node.dataset.removed) { close(); return; } void run(node, async () => {
      checked(await global.SoduWorkAPI.removeCloudEnvironment(row.id), node);
      node.dataset.removed = 'true'; onChange?.(); busy = false; close();
    }); });
  }
  function edit(row, onChange) {
    if (!row?.canManage) return;
    const node = dialog('环境设置', row.name || row.id,
      '<label>环境名称<input name="name" value="' + esc(row.name || '') + '" maxlength="80" required></label><label>接收新会话<select name="mode"><option value="accepting">自动接收</option><option value="draining">暂停新会话</option><option value="disabled">停用</option></select></label><p class="ce-help">暂停接收只影响新会话，已有会话继续执行。工作目录：<span translate="no">' + esc(row.workRoot || '使用执行机默认目录') + '</span>。更换目录可通过“更新 Runner 密钥”重新生成接入命令。</p><div class="ce-edit-remove"><span>更换设备时可从当前账号移除这台执行机。</span><button type="button" class="ce-danger" data-ce-edit-remove>移除环境</button></div>', '保存', { translateSubtitle: false });
    if (!node) return;
    const form = node.querySelector('form'); form.elements.mode.value = ['draining', 'disabled'].includes(row.mode) ? row.mode : 'accepting';
    form.addEventListener('submit', event => { event.preventDefault(); if (!form.reportValidity()) return; void run(node, async () => { checked(await global.SoduWorkAPI.updateCloudEnvironment(row.id, { name: form.elements.name.value.trim(), mode: form.elements.mode.value }), node); onChange?.(); busy = false; close(); }); });
    node.querySelector('[data-ce-edit-remove]').addEventListener('click', () => { close(); remove(row, onChange); });
  }
  function rotate(row, onChange, service) {
    if (!row?.canManage || row.credential?.canRotate === false) return;
    const node = dialog('更新接入密钥', row.name || row.id, '<p>请确认目标电脑没有运行中的会话。更新后旧密钥立即失效；已保存 SSH 连接时，客户端会先验证连接，再自动更新并启动 Runner。没有可用 SSH 连接时，将提供一次性接入命令。</p><details class="ce-advanced"><summary>连接与工作目录</summary><label>SoduWork 服务地址<input name="hub" type="url" value="' + esc(service?.recommendedHub || '') + '" placeholder="留空使用当前服务地址"></label><label>工作目录（可选）<input name="workRoot" maxlength="500" value="' + esc(row.workRoot || '') + '" placeholder="留空使用执行机默认目录"></label><p class="ce-help">新目录在 Runner 重新接入后生效。已有文件会保留在原目录。</p></details><p class="ce-help">完整凭据只显示这一次，关闭窗口后无法恢复。</p>', '生成新密钥', { translateSubtitle: false });
    if (!node) return;
    const form = node.querySelector('form');
    form.addEventListener('invalid', event => { const details = event.target.closest('details'); if (details) details.open = true; }, true);
    form.addEventListener('submit', event => { event.preventDefault(); if (node.dataset.created) { close(); return; } if (!form.reportValidity()) return; void run(node, async () => {
      const payload = { workRoot: form.elements.workRoot.value.trim() };
      if (form.elements.hub.value.trim()) payload.hub = form.elements.hub.value.trim();
      const platform = 'linux', native = global.soduWorkAPI?.cloudComputer;
      const hub = global.SoduWorkAPI?.hubConfig?.()?.hub || '';
      const saved = native?.get ? checked(await native.get({ hub }), node) : null;
      const automatic = saved?.configured && native?.test && native?.install;
      // Verify saved SSH access before revoking the existing Runner credential.
      if (automatic) {
        progress(node, '正在测试 SSH 连接…');
        checked(await native.test({ credential: { hub } }), node);
      }
      const result = checked(await global.SoduWorkAPI.rotateCloudEnvironmentCredential(row.id, payload), node);
      if (!automatic) { showOneTimeCredential(node, result, platform, '新的接入凭据', onChange); onChange?.(); return; }
      progress(node, 'SSH 已连接，正在安装 Runner，可能需要几分钟…');
      let install;
      try { install = await native.install({ credential: { hub }, setup: result.setup || {}, platform }); }
      catch (error) { install = { ok: false, error: error.message }; }
      if (!isCurrent(node)) return;
      await showInstallResult(node, { ...install, platform, message: install?.reason || install?.error || install?.message },
        result.setup || {}, onChange, row.id);
    }); });
  }
  function agent(setup) {
    const node = dialog('准备云端 Agent', '在目标电脑安装所需 Agent 后，刷新环境状态即可使用。', '<p>请在目标电脑上安装 Node.js 22.19 或更新版本，然后执行：</p><div class="ce-command"><pre translate="no">' + esc(setup?.command || 'npm install -g @earendil-works/pi-coding-agent@0.84.4') + '</pre></div><p class="ce-help">安装完成后重启 Runner，系统会自动重新检测 Agent。</p>', '知道了');
    if (node) node.querySelector('form').addEventListener('submit', event => { event.preventDefault(); close(); });
  }
  const scopeChanged = () => { if (active && !isCurrent(active)) invalidate(); };
  global.addEventListener?.('soduwork-data-scope-changed', scopeChanged); global.addEventListener?.('soduwork-device-auth', scopeChanged);
  global.CloudEnvironmentSetup = { open, edit, remove, rotate, credentials, agent, close, invalidate };
})(window);

