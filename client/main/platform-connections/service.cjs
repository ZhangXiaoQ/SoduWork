'use strict';
const runtime = require('./runtime.cjs'), lifecycle = require('./account-lifecycle.cjs');
const feishu = require('./feishu.cjs'), wecomQr = require('./wecom-qr.cjs');
const wecomAuthError = require('./wecom-auth-error.cjs');
const CLEAR = { authUrl: '', qrCode: '', userCode: '', expiresAt: 0, phase: '', account: '', conflictId:'' };
const LOCAL_ONLY = '已断开本机连接；平台侧授权未撤销，需要使用时请重新连接';
// DWS 1.0.61 allows sixteen minutes for device authorization. Leave one minute
// for credential persistence and final verification before cancelling its process.
const DINGTALK_AUTH_TIMEOUT_MS = 17 * 60 * 1000;
function create({ app, identityOf, safeStorage, shell }, { loginHint, authResult }) {
  const states = new Map(), jobs = new Map(), checks = new Map(), disconnects = new Map(), retiring = new Map();
  let revision = 0, lastEnvironment = '';
  const id = (context, key) => context.environment + ':' + key;
  const set = (context, key, patch) => {
    const name = id(context, key), value = { ...(states.get(name) || {}), ...patch };
    states.set(name, value); return value;
  };
  function stopJob(job) {
    if (!job) return;
    job.cancelled = true;
    for (const stop of [() => job.controller?.abort(), () => job.command?.cancel(), () => job.qr?.dispose()]) {
      try { if (stop() === false) job.stopFailed = true; } catch (_) { job.stopFailed = true; }
    }
  }
  const running = job => job.command?.child && job.command.child.exitCode === null && job.command.child.signalCode == null;
  function retire(name, map) {
    const job = map.get(name);
    if (!job) return;
    map.delete(name); stopJob(job);
    if (!retiring.has(name)) retiring.set(name, new Set());
    const pending = retiring.get(name); pending.add(job);
    const finished = () => {
      job.done = true;
      if (!running(job)) pending.delete(job);
      if (!pending.size && retiring.get(name) === pending) retiring.delete(name);
    };
    if (job.completion) job.completion.then(finished, finished);
  }
  function unfinished(name) {
    const pending = retiring.get(name);
    if (!pending) return [];
    for (const job of pending) if (job.done && !running(job)) pending.delete(job);
    if (!pending.size) retiring.delete(name);
    return [...pending];
  }
  async function waitForJobs(pending) {
    let timer;
    try {
      await Promise.race([Promise.allSettled(pending.map(job => job.completion).filter(Boolean)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('平台授权程序尚未确认停止，请稍后重试')), 3500); })]);
      if (pending.some(running)) throw Error('平台授权程序尚未确认停止，请稍后重试');
    } finally { clearTimeout(timer); }
  }
  async function owner(key, claim = false) {
    runtime.provider(key);
    const identity = await identityOf(app), environment = runtime.connectionScope(identity);
    if (lastEnvironment && lastEnvironment !== environment) {
      revision++;
      for (const name of jobs.keys()) if (name.startsWith(lastEnvironment + ':')) retire(name, jobs);
      for (const name of checks.keys()) if (name.startsWith(lastEnvironment + ':')) retire(name, checks);
      for (const [name, state] of states) if (name.startsWith(lastEnvironment + ':'))
        states.set(name, { ...state, ...CLEAR, state: state.disconnectError ? 'error' : 'needs_auth', checkedAt: '' });
      // After account switching, stop only the old environment's local proxy while preserving saved credentials.
      const previous = states.get(lastEnvironment + ':feishu');
      if (previous?.scope) { try { feishu.closeScope(previous.scope); } catch (_) { /* Current owner remains isolated by proxy guard. */ } }
    }
    lastEnvironment = environment;
    return { identity, environment, scope: runtime.platformScope(app, identity, key, claim), account: runtime.scope(identity) };
  }
  async function guard(context, key, expected) {
    const current = await identityOf(app);
    if (runtime.connectionScope(current) !== context.environment ||
        runtime.platformScope(app, current, key) !== context.scope) throw Error('SoduWork 账号或服务已切换，请重新连接');
    if (expected !== undefined && !lifecycle.current(app, key, context.scope, expected)) throw Error('连接操作已取消');
  }
  async function snapshot(context, key) {
    const info = await runtime.inspect(app, key), saved = lifecycle.read(app, key, context.scope);
    await guard(context, key);
    const cached = states.get(id(context, key)) || {};
    const job = jobs.get(id(context, key));
    const disconnected = saved.disconnected;
    const disconnectError = cached.disconnectError || (saved.cleanupPending ? '本机连接已停用，清理尚未完成，请重试断开' : '');
    const state = disconnectError ? 'error' : disconnected ? 'disconnected'
      : ['preparing', 'error'].includes(cached.state) ? cached.state
      : saved.connecting && !job ? 'needs_auth'
      : info.status === 'installed' ? (cached.state || 'needs_auth') : 'needs_setup';
    // Installed runtime support does not prove prior account authorization; persist operation history to distinguish first use from expired connections.
    const added = !!saved.revision || cached.state === 'connected' || !!cached.account;
    return { ok: !disconnectError, provider: key, label: info.label, version: runtime.provider(key).version, added,
      installed: info.status === 'installed', state, connected: !disconnected && !saved.connecting && state === 'connected',
      disconnected, message: disconnected ? (disconnectError || LOCAL_ONLY) : (cached.message || ''),
      ...(disconnectError ? { reason: disconnectError } : {}),
      authUrl: disconnected ? '' : cached.authUrl || '', qrCode: disconnected ? '' : job?.qr && !job.cancelled ? job.qr.read() : '',
      userCode: disconnected ? '' : cached.userCode || '', phase: disconnected ? '' : cached.phase || '',
      expiresAt: disconnected ? 0 : cached.expiresAt || 0, checkedAt: cached.checkedAt || '',
      account: disconnected ? '' : cached.account || '', conflictId:disconnected ? '' : cached.conflictId || '',
      ...(key === 'feishu' ? {registrationId:saved.registration?.id || feishu.registrationId(context.scope)} : {}) };
  }
  const status = async key => snapshot(await owner(key), key);
  async function refresh(key, afterLogin = false) {
    const context = await owner(key, true), name = id(context, key);
    const saved = lifecycle.read(app, key, context.scope);
    if (saved.disconnected || states.get(name)?.disconnectError || jobs.has(name) || disconnects.has(name) || (key !== 'feishu' && unfinished(name).length)) return snapshot(context, key);
    if (checks.has(name)) return checks.get(name).completion;
    const job = { controller: new AbortController(), cancelled: false, command: null };
    checks.set(name, job);
    job.completion = (async () => {
      try {
        const info = await runtime.inspect(app, key);
        if (info.status !== 'installed') return snapshot(context, key);
        await guard(context, key, saved.revision);
        let result;
        if (key === 'feishu') result = await feishu.restore(app, context.identity, context.scope, safeStorage, identityOf, job.controller.signal);
        else {
          job.command = await runtime.launch(app, key, context.scope,
            key === 'wecom' ? ['auth', 'show', '--status'] : ['auth', 'status', '--format', 'json'], { timeout: 25000 });
          if (job.cancelled) job.command.cancel();
          result = { connected: authResult(key, await job.command.completion) };
        }
        if (job.cancelled) return status(key);
        await guard(context, key, saved.revision);
        // A prior process may have exited after browser consent but before its
        // completion callback. Only the provider's current status can settle it.
        if (saved.connecting) lifecycle.finish(app, key, context.scope, saved.revision);
        set(context, key, { ...CLEAR, scope: context.scope, state: result.connected ? 'connected' : 'needs_auth',
          account: result.account || '', checkedAt: new Date().toISOString(),
          message: result.description || (result.connected ? '账号授权状态已检查；具体业务权限以平台返回为准'
            : key === 'dingtalk' && afterLogin === true ? '钉钉尚未确认本机登录。请完成网页中的组织授权，再点检查连接。' : '请连接你的平台账号') });
      } catch (error) {
        if (!job.cancelled) {
          try { await guard(context, key, saved.revision); set(context, key, { ...CLEAR, state: 'error', message: error.message, conflictId:error.conflictId || '', checkedAt: new Date().toISOString() }); }
          catch (_) { /* Discard stale results after disconnect or account switching. */ }
        }
      } finally { if (checks.get(name) === job) checks.delete(name); }
      return status(key);
    })();
    return job.completion;
  }
  async function prepare(key) {
    const context = await owner(key), saved = lifecycle.read(app, key, context.scope);
    set(context, key, { state: 'preparing', message: '正在准备官方运行环境…' });
    try {
      await runtime.prepare(app, key); await guard(context, key);
      if (lifecycle.read(app, key, context.scope).revision === saved.revision)
        set(context, key, { state: 'needs_auth', message: '运行环境已就绪，请连接账号' });
      return status(key);
    } catch (error) { set(context, key, { state: 'error', message: error.message }); throw error; }
  }
  async function connect(key) {
    const context = await owner(key, true), name = id(context, key);
    if (disconnects.has(name)) throw Error('正在断开本机连接，请稍后重试');
    if (jobs.has(name)) return snapshot(context, key);
    if ((await runtime.inspect(app, key)).status !== 'installed') throw Error('请先准备运行环境');
    if (checks.has(name)) {
      try { await waitForJobs([checks.get(name)]); }
      catch (error) { retire(name, checks); throw error; }
    }
    if (key !== 'feishu' && unfinished(name).length) throw Error('上一次平台授权程序仍在退出，请稍后重试');
    await guard(context, key);
    if (disconnects.has(name)) throw Error('正在断开本机连接，请稍后重试');
    if (jobs.has(name)) return snapshot(context, key);
    const previous = lifecycle.read(app, key, context.scope);
    if (previous.disconnected) lifecycle.clear(app, key, context.scope);
    const saved = lifecycle.begin(app, key, context.scope, false);
    revision++;
    const job = { cancelled: false, controller: new AbortController(), command: null, qr: null };
    jobs.set(name, job);
    const active = () => !job.cancelled && jobs.get(name) === job && lifecycle.current(app, key, context.scope, saved.revision);
    async function failWecom(error) {
      if (!active()) return;
      try { await guard(context, key, saved.revision); if (!active()) return; }
      catch (_) { return; }
      let message = wecomAuthError.message(error);
      // Persist failures as terminal states so connecting cannot block later checks indefinitely.
      try { lifecycle.finish(app, key, context.scope, saved.revision); }
      catch (_) { message = '本机连接状态无法保存，请检查目录权限后重试'; }
      // Block reconnection while a timed-out authentication process remains alive and could still write credentials.
      if (running(job)) retire(name, jobs);
      job.qr?.dispose();
      set(context, key, { ...CLEAR, state: 'error', message, checkedAt: new Date().toISOString() });
    }
    async function failDingtalk(error) {
      if (!active()) return;
      try { await guard(context, key, saved.revision); if (!active()) return; }
      catch (_) { return; }
      let message = /超时/.test(String(error?.message || ''))
        ? '等待钉钉授权超时，请重新连接并完成网页上的全部授权步骤'
        : '钉钉授权未完成，请检查连接后重试';
      try { lifecycle.finish(app, key, context.scope, saved.revision); }
      catch (_) { message = '本机连接状态无法保存，请检查目录权限后重试'; }
      if (running(job)) retire(name, jobs);
      set(context, key, { ...CLEAR, state: 'error', message, checkedAt: new Date().toISOString() });
    }
    set(context, key, { ...CLEAR, scope: context.scope, disconnectError: '', state: 'connecting', message: '正在获取官方授权入口…' });
    if (key === 'feishu') {
      job.completion = Promise.resolve().then(() => feishu.connect(app, context.identity, context.scope,
        { signal: job.controller.signal, progress: patch => {
          if (active()) set(context, key, { state: patch.state, phase: patch.phase || '', authUrl: patch.authUrl || '',
            userCode: patch.userCode || '', expiresAt: patch.expiresAt || 0, message: patch.message || '' });
        } }, safeStorage, identityOf)).then(async result => {
        if (!active()) return;
        await guard(context, key, saved.revision);
        lifecycle.finish(app, key, context.scope, saved.revision);
        set(context, key, { ...CLEAR, state: result.connected ? 'connected' : 'error', account: result.account || '',
          checkedAt: new Date().toISOString(), message: result.description || '' });
      }).catch(async error => {
        if (!active()) return;
        try { await guard(context,key,saved.revision); } catch { return; }
        if (!active()) return;
        try { lifecycle.finish(app,key,context.scope,saved.revision); }
        catch { error = Error('本机连接状态无法保存，请检查目录权限后重试'); }
        set(context,key,{ ...CLEAR, state:'error', message:error.message, conflictId:error.conflictId || '' });
      })
        .finally(() => { if (jobs.get(name) === job) jobs.delete(name); });
      return snapshot(context, key);
    }
    job.completion = (async () => {
    try {
      if (key === 'wecom') job.qr = wecomQr.create(app, context.scope);
      const args = key === 'wecom'
        ? ['auth', 'init', '--noninteractive', '--no-browser', '--output-qrcode', job.qr.name]
        : ['auth', 'login', '--device', '--no-browser', '--format', 'json'];
      job.command = await runtime.launch(app, key, context.scope, args, {
        timeout: key === 'dingtalk' ? DINGTALK_AUTH_TIMEOUT_MS : 300000, ...(job.qr ? { cwd: job.qr.cwd } : {}), onOutput: raw => {
          if (!active()) return;
          const hint = loginHint(key, raw);
          if (hint.authUrl) set(context, key, { state: 'awaiting_user', ...hint,
            message: key === 'wecom' ? '使用企业微信扫一扫下方二维码，并在手机上确认授权' : '打开钉钉官方授权页，按提示完成登录' });
        },
      });
      if (!active()) job.command.cancel();
      await job.command.completion.then(async result => {
        if (!active()) return;
        await guard(context, key, saved.revision);
        job.qr?.dispose(); set(context, key, CLEAR);
        if (result.code !== 0 && key === 'wecom') {
          await failWecom(result);
          return;
        }
        lifecycle.finish(app, key, context.scope, saved.revision);
        jobs.delete(name);
        if (key === 'dingtalk') set(context,key,{...CLEAR,state:'connecting',message:'正在验证钉钉本机登录状态…'});
        // DWS can persist a profile before a later login step exits with an
        // error. Verify the active profile once, after CLI output has closed.
        const checked = await refresh(key,true);
        if (key === 'dingtalk' && result.code !== 0) {
          await guard(context,key,saved.revision);
          if (checked.connected) set(context,key,{message:'网页授权未确认，本机已有可用的钉钉登录。'});
          else if (checked.state === 'needs_auth') set(context,key,{state:'error',message:'钉钉授权未完成，请检查连接后重试'});
        }
      }).catch(async error => {
        if (key === 'wecom') await failWecom(error);
        else await failDingtalk(error);
      })
        .finally(() => { if (jobs.get(name) === job) jobs.delete(name); job.qr?.dispose(); });
    } catch (error) {
      if (key === 'wecom') await failWecom(error);
      else await failDingtalk(error);
      job.qr?.dispose(); if (jobs.get(name) === job) jobs.delete(name);
      if (!job.cancelled) throw error;
    }
    })().catch(() => {});
    return status(key);
  }
  async function cancel(key) {
    const context = await owner(key), name = id(context, key);
    const saved = lifecycle.read(app, key, context.scope);
    retire(name, jobs); revision++;
    lifecycle.finish(app, key, context.scope, saved.revision);
    set(context, key, { ...CLEAR, state: 'needs_auth', message: '已取消本次授权' });
    return status(key);
  }
  async function disconnect(key) {
    const context = await owner(key, true), name = id(context, key);
    if (disconnects.has(name)) return disconnects.get(name);
    const work = (async () => {
      // Persist the revocation fence before cleanup so restarts, late success, or cleanup failure cannot reuse old authorization.
      let barrier;
      try { barrier = lifecycle.begin(app, key, context.scope, true); }
      catch (_) {
        retire(name, jobs); retire(name, checks);
        if (key === 'feishu') { try { feishu.closeScope(context.scope); } catch (_) { /* Report persistence failure below. */ } }
        revision++; set(context, key, { ...CLEAR, state: 'error', disconnectError: '无法保存本机断开状态，请检查文件权限后重试' });
        return { ok: false, provider: key, state: 'error', connected: false, disconnected: false,
          message: '无法保存本机断开状态，请检查文件权限后重试', reason: '本机断开尚未完成' };
      }
      revision++; set(context, key, { ...CLEAR, state: 'disconnected', disconnectError: '', message: LOCAL_ONLY });
      unfinished(name).forEach(stopJob);
      retire(name, jobs); retire(name, checks);
      const pending = unfinished(name);
      let failure = '';
      try {
        if (key === 'feishu') feishu.closeScope(context.scope);
        // Wait only for authentication requests started by this app; do not stop or retry business tools.
        await waitForJobs(pending);
        if (pending.some(job => job.stopFailed)) throw Error('平台授权程序停止失败，请重试断开');
        await guard(context, key);
        lifecycle.clear(app, key, context.scope);
        if (key === 'feishu') await feishu.disableRegistration(context.identity, context.scope, () => guard(context, key), barrier.registration);
        lifecycle.completeDisconnect(app, key, context.scope, barrier.revision);
      } catch (error) { failure = error.message || '本机连接清理尚未完成，请重试'; }
      if (failure) set(context, key, { state: 'error', disconnectError: failure });
      try { return await snapshot(context, key); }
      catch (_) { return { ok: !failure, provider: key, state: failure ? 'error' : 'disconnected', connected: false,
        disconnected: true, message: failure || LOCAL_ONLY, ...(failure ? { reason: failure } : {}) }; }
    })();
    disconnects.set(name, work);
    try { return await work; } finally { if (disconnects.get(name) === work) disconnects.delete(name); }
  }
  async function openAuth(key) {
    const context = await owner(key), cached = states.get(id(context, key));
    if (!jobs.has(id(context, key)) || !cached?.authUrl || (cached.expiresAt && cached.expiresAt <= Date.now()))
      throw Error('授权链接已失效，请重新连接');
    await shell.openExternal(cached.authUrl); return { ok: true };
  }
  function cli(context, key) {
    const p = runtime.paths(app, key, context.scope);
    return JSON.stringify([runtime.node(), runtime.entry(app, key), 'run', '--prefix', p.prefix, '--state', p.account, '--']);
  }
  async function guide(key) {
    if (!Object.hasOwn(runtime.LABELS, key)) return '';
    const checked = await refresh(key);
    if (!checked.connected) throw Error('请先在「插件 → 连接器 → 平台账号」完成连接账号；' + (checked.message || ''));
    if (key === 'feishu') return '飞书连接由当前账号的连接器页面管理，仅使用本轮授权的 feishu MCP。凭据不在聊天中填写。';
    const context = await owner(key);
    return '本轮 ' + runtime.LABELS[key] + ' 已准备并检查当前账号。CLI 固定前缀参数数组：' + cli(context, key) +
      '。在此数组后追加官方 CLI 参数，按 argv 调用。不要更换账号目录、安装依赖或重新登录；具体业务仍按当前用户授权执行。';
  }
  async function conversationGuide(expectedScope) {
    const guides = [];
    for (const key of ['wecom', 'dingtalk']) {
      const context = await owner(key);
      if (context.account !== expectedScope) return '';
      const cached = states.get(id(context, key)), saved = lifecycle.read(app, key, context.scope);
      if (saved.disconnected || saved.connecting || cached?.disconnectError || cached?.state !== 'connected' || !cached.checkedAt) continue;
      guides.push(runtime.LABELS[key] + '：当前账号此前已完成连接，实际权限和有效性以官方 CLI 返回为准。固定前缀参数数组：' + cli(context, key) +
        '。追加官方 CLI 参数并按 argv 执行；先按需查看 --help / 命令元数据，不猜测接口。所有命令走当前终端审批。不要更换账号目录、安装依赖、自动登录或读取凭据。连接本身不授予消息发送、删除或修改业务数据的权限；仅执行用户授权的操作，回执未知时不要自动重试写入。');
      await guard(context, key);
    }
    return guides.join('\n');
  }
  function close() {
    for (const job of jobs.values()) stopJob(job);
    for (const job of checks.values()) stopJob(job);
    for (const pending of retiring.values()) for (const job of pending) stopJob(job);
    jobs.clear(); checks.clear(); retiring.clear(); feishu.closeAll(); revision++;
  }
  return { status, refresh, prepare, connect, cancel, disconnect, openAuth, guide, conversationGuide, close, revision: () => revision };
}
module.exports = { create };
