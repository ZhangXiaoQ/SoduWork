/* Expose native platforms through the personal connection directory; existing local flows still own authorization. */
(function(global) {
  'use strict';
  const providers = [
    {key:'wecom', label:'企业微信', description:'连接企业微信账号，供对话和插件按需使用。'},
    {key:'dingtalk', label:'钉钉', description:'连接钉钉账号，复用已有的组织与应用授权。'},
    {key:'feishu', label:'飞书', description:'连接飞书账号，按已授予的权限使用工作数据。'},
  ];
  const labels = {connected:'已连接',disconnected:'已断开',needs_auth:'需要授权',needs_setup:'尚未连接',
    preparing:'准备中',connecting:'连接中',awaiting_user:'等待确认',error:'需检查连接',offline:'执行机离线',unknown:'尚未验证'};
  const icon = '<span class="cap-card-icon cap-plugin-brand cap-ability-icon icon-mcp" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v3"/></svg></span>';
  const states = new Map(), pending = new Map(), checked = new Map(), revisions = new Map(), listeners = new Set();
  let epoch = 0;
  const api = () => global.soduWorkAPI?.platformConnections;
  const stamp = () => Date.now();
  const exists = key => providers.some(item => item.key === key);
  function entries() {
    return providers.map(item => ({...item,state:'unknown',connected:false,added:false,disconnected:false,
      installed:false,checkedAt:'',account:'',message:'',runOn:'local',source:'personal',...(states.get(item.key)||{})}));
  }
  function notify(key, reason) {
    for (const listener of [...listeners]) {
      try {listener(entries(), {key,reason});} catch (_) { /* A closed page must not interrupt other subscribers. */ }
    }
  }
  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function reset() {
    epoch++;states.clear();pending.clear();checked.clear();revisions.clear();notify('', 'reset');
  }
  function update(key, value, reason) {
    const previous = states.get(key) || {};
    const state = Object.hasOwn(labels, value?.state) ? value.state : 'unknown';
    const disconnected = value?.disconnected === true || state === 'disconnected';
    const connected = state === 'connected' && value?.connected === true && !disconnected;
    // Distinguish never-installed platforms from existing connections that are unavailable, offline, or expired.
    const added = previous.added === true || value?.added === true || connected || disconnected ||
      ['preparing','connecting','awaiting_user'].includes(state) || !!value?.account;
    const next = {state,connected,added,disconnected,installed:value?.installed ?? previous.installed ?? false,
      checkedAt:String(value?.checkedAt ?? previous.checkedAt ?? '').slice(0,100),
      account:disconnected?'':String(value?.account ?? previous.account ?? '').slice(0,200),
      registrationId:String(value?.registrationId ?? previous.registrationId ?? '').slice(0,36),
      message:String(value?.message || value?.reason || '').slice(0,500)};
    states.set(key,next);checked.set(key,stamp());
    if (JSON.stringify(previous) !== JSON.stringify(next)) notify(key, reason);
    return previous;
  }
  function load(options = {}) {
    const generation = epoch, bridge = api(), force = options?.force === true;
    if (!bridge?.status) return Promise.resolve(entries());
    return Promise.all(providers.map(({key}) => {
      if (pending.has(key)) return pending.get(key);
      if (!force && checked.has(key) && stamp()-checked.get(key)<10000) return Promise.resolve();
      const revision = revisions.get(key) || 0;
      const valid = () => generation === epoch && (revisions.get(key)||0) === revision;
      const request = Promise.resolve().then(() => generation === epoch ? bridge.status(key) : undefined).then(value => {
        if (!valid()) return;
        if (value?.provider !== key || !value?.ok && !value?.disconnected && !['offline','error','needs_auth'].includes(value?.state))
          update(key,{state:'error',message:'暂时无法检查连接，请稍后重试'},'status');
        else update(key,value,'status');
      }, () => {
        if (valid()) update(key,{state:'error',message:'暂时无法检查连接，请稍后重试'},'status');
      }).finally(() => {if (pending.get(key) === request) pending.delete(key);});
      pending.set(key, request);return request;
    })).then(entries);
  }
  function open(key, ctx = {}) {
    if (!exists(key) || !global.SoduWorkPlatformConnections?.openProvider) return;
    const generation = epoch;
    const active = () => generation === epoch && (!ctx.isCurrent || ctx.isCurrent());
    return global.SoduWorkPlatformConnections.openProvider(key,{openModal:ctx.openModal,closeModal:ctx.closeModal},{
      manageConflict:ctx.manageConflict && ((id,live) => ctx.manageConflict(id,() => active() && live())),
      onState(value) {
        if (!active() || value?.provider !== key) return;
        revisions.set(key,(revisions.get(key)||0)+1);
        const previous = update(key,value,'dialog');
        ctx.onChanged?.();
        if (!!value.connected !== !!previous.connected || !!value.disconnected !== !!previous.disconnected ||
            value.disconnected && value.state !== previous.state) ctx.onConnectionChanged?.();
      },
    });
  }
  function ownsRegistration(entry,row) {
    return entry?.key === 'feishu' && (entry.registrationId ? row.id === entry.registrationId : String(row.id).startsWith('soduwork-feishu-'));
  }
  function connectedCount(mcp) {
    return entries().filter(x => x.connected && !(x.key === 'feishu' &&
      (mcp?.personal || []).some(r => r.enabled && ownsRegistration(x,r)))).length;
  }
  // Update legacy rows independently; unified directory consumers subscribe directly to entries.
  function render(root, ctx) {
    if (!root || !api()) return;
    root._platformDirectoryUnsubscribe?.();
    const generation = epoch, h = ctx.h;
    const visible = providers.filter(x => (x.label+' '+x.key+' '+x.description).toLowerCase().includes(String(ctx.query||'').toLowerCase()));
    if (!visible.length) {root.replaceChildren();return;}
    root.innerHTML = '<section class="cap-section"><div class="cap-section-head"><b>平台账号</b><span>在此连接一次，对话与插件共用；按实际授权范围使用</span><em>'+visible.length+' 项</em></div><div class="cap-mcp-list">'+visible.map(x =>
      '<div class="cap-mcp-row" data-platform-account="'+x.key+'">'+(global.SoduWorkConnectorBrand?.image(x.key)?'<span class="cap-card-icon cap-plugin-brand cap-ability-icon icon-mcp" aria-hidden="true">'+global.SoduWorkConnectorBrand.image(x.key)+'</span>':icon)+'<span class="cap-mcp-main"><span class="cap-mcp-name"><b>'+h(x.label)+'</b><em data-platform-state>正在检查…</em></span><span>'+h(x.description)+'</span></span><span class="cap-mcp-ops"><button type="button" class="btn-mini" data-platform-manage="'+x.key+'">管理连接</button></span></div>').join('')+'</div></section>';
    function paint(rows) {
      if (generation !== epoch || !root.isConnected) {root._platformDirectoryUnsubscribe?.();return;}
      for (const row of rows) {
        if (!visible.some(item=>item.key===row.key)) continue;
        const node=root.querySelector('[data-platform-account="'+row.key+'"]');
        if (!node) continue;
        node.querySelector('[data-platform-state]').textContent=labels[row.state]||'尚未验证';
        node.querySelector('button').textContent=row.connected?'管理连接':row.disconnected?'重新连接':'连接账号';
      }
      ctx.onChanged?.();
    }
    root._platformDirectoryUnsubscribe=subscribe(paint);
    paint(entries());
    visible.forEach(({key})=>{root.querySelector('[data-platform-manage="'+key+'"]').onclick=()=>open(key,{
      ...ctx,onChanged:undefined,isCurrent:()=>root.isConnected && generation===epoch,
    });});
    void load();
  }
  global.SoduWorkPlatformDirectory={entries,load,subscribe,open,render,reset,connectedCount,ownsRegistration};
})(window);
