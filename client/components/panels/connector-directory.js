/* Personal connections and the product catalog share one page and one search. */
(function(global) {
  'use strict';
  let cleanup = null;
  const platform = () => global.SoduWorkPlatformDirectory;
  const entries = () => platform()?.entries?.() || [];
  const text = (tag, cls, value) => { const el=document.createElement(tag); el.className=cls||''; if(value!==undefined)el.textContent=value; return el; };
  function button(label, handler, cls='btn-mini') { const el=text('button',cls,label);el.type='button';el.onclick=handler;return el; }
  function mark(value) {
    const el=text('span','cap-card-icon cap-plugin-brand cap-ability-icon icon-mcp');const file=global.SoduWorkConnectorBrand?.asset(value);
    if(file){const img=document.createElement('img');img.src='assets/connector-brands/'+file;img.alt='';img.className='cap-connector-product-icon';img.width=28;img.height=28;img.draggable=false;el.append(img);}
    else {el.textContent=String(value.name||value.label||'C').slice(0,1).toUpperCase();el.setAttribute('aria-hidden','true');}
    return el;
  }
  const short = value => global.SoduWorkConnectorConfig?.summary(value) || String(value||'').split('。')[0];
  // Translate card metadata fragments before joining them; whole-node phrase lookup cannot match composite labels.
  const tSegment = value => {
    const i18n = global.SoduWorkI18n;
    const text = String(value ?? '');
    return i18n && typeof i18n.translateText === 'function' ? i18n.translateText(text) : text;
  };
  function models(mcp) {
    const native=entries().filter(x=>x.added);
    const nativeFeishu=native.find(x=>x.key==='feishu');
    return [
      ...native.map(item=>({kind:'native',key:'native:'+item.key,item,name:item.label,description:item.description,source:'本机'})),
      ...(mcp.personal||[]).filter(x=>!(nativeFeishu&&(platform()?.ownsRegistration?.(nativeFeishu,x) ?? String(x.id).startsWith('soduwork-feishu-')))).map(item=>({kind:'personal',key:'personal:'+item.id,item,name:item.name,description:item.description,source:item.builtIn?'系统提供 · 本机':'本机'})),
      ...(mcp.company||[]).filter(x=>(mcp.enabledCompany||[]).includes(x.name)).map(item=>({kind:'company',key:'company:'+item.id,item,name:item.name,description:item.description,source:'企业提供'+(item.type==='http'?'':' · 本机')})),
    ];
  }
  function status(model) {
    const x=model.item;
    if(model.kind==='native')return {label:({connected:'已连接',disconnected:'已断开',needs_auth:'需要授权',needs_setup:'待连接',preparing:'准备中',connecting:'连接中',awaiting_user:'等待确认',error:'需检查',offline:'电脑离线',unknown:'待检查'})[x.state]||'待检查',tone:x.connected?'ok':['needs_auth','error'].includes(x.state)?'attention':'quiet'};
    if(model.kind==='personal'&&!x.enabled)return{label:'已停用',tone:'quiet'};
    const value=x.connectionState||x.health?.connectionState;
    return {label:({verified:'已验证',needs_auth:'需重新授权',offline:'电脑离线',error:'需检查',configured:'已配置'})[value]||(model.kind==='company'?'已添加':'已配置'),tone:value==='verified'?'ok':['needs_auth','error','offline'].includes(value)?'attention':'quiet'};
  }
  function managePersonal(ctx,item,template) {
    if(!item.builtIn&&item.canEdit!==false)return ctx.openMcpEditor(item,template,{allowAdditional:true});
    const layer=ctx.openModal(item.name,'此连接由系统维护','<p class="connector-readonly-copy">'+ctx.h(short(item.description)||'此连接可供本机任务按需使用。')+'</p><p data-readonly-state role="status"></p>',
      '<button class="btn-mini" data-readonly-toggle></button>');
    const action=layer.querySelector('[data-readonly-toggle]'),note=layer.querySelector('[data-readonly-state]');
    const update=()=>{const latest=(ctx.getMcp().personal||[]).find(x=>x.id===item.id);action.textContent=latest?.enabled?'停用连接':'启用连接';};update();
    action.onclick=async()=>{if(action.disabled||ctx.isCurrent?.()===false)return;action.disabled=true;if(!ctx.state().pending&&!ctx.state().error)ctx.toggle('personal',item.id);const ok=await ctx.retry();
      if(layer.hidden||layer.querySelector('[data-readonly-toggle]')!==action||ctx.isCurrent?.()===false)return;
      action.disabled=false;update();if(!ok)action.textContent='重试保存';note.textContent=ok?'已保存':'保存未完成，可以重试。';};
  }
  function findModel(ctx,key){return models(ctx.getMcp()).find(x=>x.key===key);}
  function menu(label='更多操作') {
    const el=text('details','connector-row-menu');const summary=text('summary');summary.setAttribute('aria-label',label);summary.append(global.SoduWorkMcpManagement.moreIcon());
    const body=text('div','connector-menu-body');el.append(summary,body);
    el.addEventListener('toggle',()=>{if(el.open){const bounds=el.getBoundingClientRect(),frame=el.closest('.cap-content')?.getBoundingClientRect();el.classList.toggle('drop-up',bounds.bottom+body.offsetHeight+8>Math.min(innerHeight,frame?.bottom||innerHeight));}if(el.open)el.closest('.cap-connections-view')?.querySelectorAll('details[open]').forEach(x=>{if(x!==el)x.open=false;});});
    el.addEventListener('keydown',e=>{if(e.key==='Escape'&&el.open){e.stopPropagation();el.open=false;summary.focus();}});
    return{el,body};
  }
  function nativeContext(ctx){return{openModal:ctx.openModal,closeModal:ctx.closeModal,onChanged:ctx.onPlatformChanged,onConnectionChanged:ctx.onPlatformConnectionChanged,isCurrent:ctx.isCurrent,
    async manageConflict(id,active) {
      if (!active()) return;
      await ctx.onPlatformConnectionChanged?.();
      if (!active()) return;
      const row = ctx.getMcp().personal?.find(item => item.id === id && String(item.name).toLowerCase() === 'feishu');
      if (!row || row.builtIn || row.canEdit === false) throw Error('连接列表已变化，请刷新后再管理同名连接');
      return ctx.openMcpEditor(row,null,{editName:true});
    }};}
  function makeRow(model,ctx,actions) {
    const row=text('article','cap-template cap-mcp-card connector-connection-row');row.dataset.connectionKey=model.key;
    const latest=()=>ctx.isCurrent?.()===false?null:findModel(ctx,model.key);
    const manage=button('',()=>{const now=latest();if(!now)return;
      if(now.kind==='native')platform().open(now.item.key,nativeContext(ctx));
      else if(now.kind==='company')actions.company(now.item);
      else managePersonal(ctx,now.item,null);
    },'connector-manage');manage.dataset.connectionManage=model.key;manage.setAttribute('aria-label','管理'+model.name);
    const copy=text('span','cap-template-copy');copy.append(text('b','connector-row-name',model.name),text('span','connector-row-description',short(model.description)||'连接你的工作工具'),text('em','connector-state'));
    row.append(mark(model.item),copy,manage);
    const ops=text('div','connector-row-actions');row.append(ops);
    if(model.kind!=='native'){
      const more=menu(model.name+'的更多操作');ops.append(more.el);
      const action=(label,fn)=>{const b=button(label,()=>{more.el.open=false;const now=latest();if(now)fn(now);},'');more.body.append(b);return b;};
      if(model.kind==='personal'){
        const toggle=action('停用',now=>ctx.toggle('personal',now.item.id));toggle.dataset.toggleMcp=model.item.id;
        action('导出配置',now=>global.SoduWorkConnectorExport?.open(ctx.editorContext(),{ids:[now.item.id]}));
        if(model.item.canEdit&&!model.item.builtIn)action('共享到公司',now=>actions.share(now.item));
        if(model.item.canDelete&&!model.item.builtIn)action('删除连接',now=>ctx.capabilityEditors().openDeleteMcp(now.item)).classList.add('danger');
      }else action('移出我的连接器',now=>ctx.toggle('company',now.item.name));
    }
    return row;
  }
  function reconcile(root,ctx,actions) {
    const list=root.querySelector('[data-my-connections]');if(!list)return;
    const all=models(ctx.getMcp()),needle=String(ctx.query||'').trim().toLowerCase();
    const shown=all.filter(x=>[x.name,x.description,x.item.templateKey,x.item.key,x.source].some(v=>String(v||'').toLowerCase().includes(needle)));
    const keep=new Set(shown.map(x=>x.key));
    for(const row of [...list.children])if(!keep.has(row.dataset.connectionKey)){
      if(row.contains(document.activeElement)){const next=[...list.children].find(x=>x!==row&&keep.has(x.dataset.connectionKey));(next?.querySelector('.connector-manage')||document.getElementById('capAddButton'))?.focus({preventScroll:true});}row.remove();
    }
    shown.forEach(model=>{
      let row=[...list.children].find(x=>x.dataset.connectionKey===model.key);
      if(!row){row=makeRow(model,ctx,actions);list.append(row);}
      const state=status(model),badge=row.querySelector('.connector-state');badge.textContent=state.label;badge.className='connector-state '+state.tone;
      row.querySelector('.connector-row-name').textContent=model.name;
      row.querySelector('.connector-row-description').textContent=short(model.description)||'连接你的工作工具';
      const toggle=row.querySelector('[data-toggle-mcp]');if(toggle)toggle.textContent=model.item.enabled?'停用':'启用';
      row.querySelector('.connector-manage').setAttribute('aria-label',(model.kind==='native'&&!model.item.connected?'重新连接':'管理')+model.name);
    });
    const empty=root.querySelector('[data-connections-empty]');empty.hidden=!!shown.length;
    empty.querySelector('b').textContent=needle?'没有找到匹配的连接':'连接工作中使用的工具';
    empty.querySelector('p').textContent=needle?'可以换个关键词，或添加新的连接。':'添加后，可在对话、插件和自动化中使用。';
    root.querySelector('[data-my-connection-count]').textContent=String(all.length);
  }
  function render(content,ctx) {
    dispose();content._connectorContext=ctx;
    content.innerHTML='<div class="cap-connections-view"><section class="cap-section cap-template-section" aria-labelledby="myConnectorsHeading"><header class="connector-section-heading"><div class="cap-section-head"><b id="myConnectorsHeading">我的连接器</b><span>已添加的产品与服务</span><em data-my-connection-count>0</em></div><div data-connection-tools></div></header>'+
      '<div class="cap-connector-save" role="status" hidden><span></span><button class="btn-mini" data-connector-retry>重试保存</button></div>'+
      (ctx.data && !ctx.data.summary?.mcpReady?'<p class="connector-access-note">公司尚未开放连接执行能力；已保存的配置会为你保留。</p>':'')+
      '<div class="cap-template-row connector-connections" data-my-connections></div><div class="connector-empty" data-connections-empty><b></b><p></p><button class="btn-mini" data-connection-empty-add>添加连接</button></div></section>'+
      '<section class="cap-section cap-template-section connector-common-section" aria-labelledby="commonConnectorsHeading"><header class="connector-section-heading"><div class="cap-section-head"><b id="commonConnectorsHeading" tabindex="-1">常用连接器</b><span>连接一次，供对话、插件和自动化复用</span><em data-connector-results></em></div><div class="connector-library-tools"><button class="connector-link" data-connector-custom>使用连接地址</button><button class="connector-link" data-connector-import>导入配置</button></div></header>'+
      '<div class="cap-template-row connector-library-grid" data-connector-library></div><p class="connector-library-empty" data-library-empty hidden>没有找到匹配的产品，试试其他名称，或使用连接地址添加。</p></section></div>';
    content.querySelector('[data-connector-retry]').onclick=ctx.retry;
    content.querySelector('[data-connection-empty-add]').onclick=()=>openLibrary(ctx);
    const actions=global.SoduWorkMcpManagement.enhance(content,{...ctx.editorContext(),compactConnections:true});
    const bar=content.querySelector('.cap-mcp-manage-bar');content.querySelector('[data-connection-tools]').append(bar);
    content._connectorActions=actions;content._connectorUpdate=()=>reconcile(content,ctx,actions);
    mountLibrary(content,ctx);
    content._connectorUpdate();sync(content,ctx.getMcp(),ctx.state());
    const off=platform()?.subscribe?.(()=>{if(!content.isConnected||!content.querySelector('[data-my-connections]'))return;content._connectorUpdate();content._connectorLibrarySync?.();ctx.onPlatformChanged?.();});
    const menuEvents=new AbortController();
    document.addEventListener('pointerdown',event=>{content.querySelectorAll('details[open]').forEach(el=>{if(!el.contains(event.target))el.open=false;});},{signal:menuEvents.signal});
    content.addEventListener('focusout',event=>{
      // activeElement can briefly be body before the destination receives focus.
      const next=event.relatedTarget;
      queueMicrotask(()=>{content.querySelectorAll('details[open]').forEach(el=>{if(!el.contains(next||document.activeElement))el.open=false;});});
    },{signal:menuEvents.signal});
    const disposeIM=global.SoduWorkIMRemote?.mount(content,ctx);
    cleanup=()=>{disposeIM?.();menuEvents.abort();off?.();delete content._connectorContext;delete content._connectorUpdate;delete content._connectorActions;delete content._connectorLibrarySync;};
    platform()?.load?.().catch(()=>{});
  }
  function dispose(){cleanup?.();cleanup=null;}
  function sync(root,mcp,state={}) {
    if(!root?._connectorContext)return;
    root._connectorUpdate?.();const el=root.querySelector('.cap-connector-save');
    if(el){el.hidden=!state.pending&&!state.error;el.querySelector('span').textContent=state.error?'选择尚未保存：'+state.error:'正在保存…';el.querySelector('button').hidden=!state.error;}
    root._connectorLibrarySync?.();
  }
  function openLibrary(ctx) {
    if(ctx.isCurrent?.()===false)return;
    const heading=document.getElementById('commonConnectorsHeading');
    if(!heading)return;
    heading.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    heading.focus({preventScroll:true});
  }
  function mountLibrary(content,ctx) {
    const editor=ctx.editorContext(),api=editor.api,owner=api.taskStorageKey?.('ops');
    const holder=content.querySelector('[data-connector-library]');
    const current=()=>content.isConnected&&content._connectorContext===ctx&&content.querySelector('[data-connector-library]')===holder&&api.taskStorageKey?.('ops')===owner;
    const selected=key=>(ctx.getMcp().personal||[]).filter(x=>x.templateKey===key);
    function manageTemplate(item){
      const rows=selected(item.key);
      if(rows.length===0)return ctx.openMcpEditor(null,item);
      if(rows.length===1)return managePersonal(ctx,rows[0],item);
      const chooser=ctx.openModal(item.name,'选择要管理的连接','<div data-connector-accounts></div>','<button class="btn-mini" data-connector-another>连接其他账号</button>');
      chooser.querySelector('.cap-modal').classList.add('cap-connector-library');
      for(const row of rows)chooser.querySelector('[data-connector-accounts]').append(button(row.name,()=>managePersonal(ctx,row,item),'connector-account-choice'));
      chooser.querySelector('[data-connector-another]').onclick=()=>ctx.openMcpEditor(null,item);
    }
    const cards=[];
    function addCard(kind,item){
      const card=button('',async()=>{
        if(!current()||card.disabled)return;
        if(kind==='native')return platform().open(item.key,nativeContext(ctx));
        if(kind==='template')return manageTemplate(item);
        const live=(ctx.getMcp().company||[]).find(x=>x.id===item.id);if(!live)return;
        if(ctx.state().pending||ctx.state().error){card.disabled=true;const ok=await ctx.retry();if(current()){card.disabled=false;refresh();if(!ok)label.textContent='重试保存';}return;}
        if((ctx.getMcp().enabledCompany||[]).includes(live.name))return contentActions().company(live);
        if(card.disabled)return;card.disabled=true;ctx.toggle('company',live.name);
        const ok=await ctx.retry();if(!current())return;
        card.disabled=false;if(ok)refresh();else label.textContent='保存未完成 · 重试';
      },'cap-template cap-mcp-card connector-library-card');
      if(kind==='template')card.dataset.template=item.key;
      if(kind==='native')card.dataset.platformConnect=item.key;
      if(kind==='company')card.dataset.companyConnect=item.id;
      const name=item.label||item.name,copy=text('span','cap-template-copy'),label=text('em','connector-library-action');
      copy.append(text('b','',name),text('span','connector-library-description',short(item.description)||'接入你的工作工具'),label);
      card.append(mark(item),copy);holder.append(card);
      cards.push({kind,item,card,label,search:[name,item.key,item.description,item.category].join(' ').toLowerCase()});
    }
    function contentActions(){return content?._connectorActions||global.SoduWorkMcpManagement.enhance(document.createElement('div'),{...ctx.editorContext(),compactConnections:true});}
    entries().forEach(item=>addCard('native',item));
    (ctx.getMcp().company||[]).forEach(item=>addCard('company',item));
    [...(ctx.data?.mcpTemplates||[])].sort((a,b)=>Number(String(b.key||'').startsWith('connector-'))-Number(String(a.key||'').startsWith('connector-'))).forEach(item=>addCard('template',item));
    function refresh(){
      if(!current())return;let count=0;const needle=String(ctx.query||'').trim().toLowerCase();
      cards.forEach(x=>{
        x.card.hidden=!!needle&&!x.search.includes(needle);if(!x.card.hidden)count++;
        let added=false;
        if(x.kind==='native')added=!!entries().find(e=>e.key===x.item.key)?.added;
        else if(x.kind==='template')added=selected(x.item.key).length>0;
        else added=(ctx.getMcp().enabledCompany||[]).includes(x.item.name);
        x.card.classList.toggle('is-added',added);x.label.textContent=x.kind==='company'&&ctx.state().error?'重试保存':added?'已添加 · 管理':x.kind==='company'?'企业提供 · 待添加':x.kind==='native'?'账号授权 · 待连接':[x.item.category,x.item.risk==='read'?'只读':x.item.risk==='network'?'网络访问':'可能写入','待配置'].filter(Boolean).map(part => tSegment(part)).join(' · ');
      });
      content.querySelector('[data-connector-results]').textContent=String(count);content.querySelector('[data-library-empty]').hidden=!!count;
    }
    content._connectorLibrarySync=refresh;refresh();
    content.querySelector('[data-connector-custom]').onclick=()=>{if(current())ctx.openMcpEditor(null,null);};
    content.querySelector('[data-connector-import]').onclick=()=>{if(current())global.SoduWorkMcpManagement.openImport(ctx.editorContext());};
  }
  global.SoduWorkConnectorDirectory={render,sync,dispose,openLibrary,count:mcp=>models(mcp).length};
})(window);
