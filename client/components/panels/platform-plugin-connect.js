/* Platform account setup uses trusted main-process actions; secrets never enter chat. */
(function(global){
 'use strict';
 const PLATFORMS={
  dingtalk:{label:'钉钉',intro:'首次连接会准备钉钉官方运行环境。打开钉钉官方授权页，按提示完成登录；页面要求时输入设备码。'},
  wecom:{label:'企业微信',intro:'首次连接会准备企业微信官方运行环境。打开企业微信官方授权页，使用企业微信扫码完成授权。'},
  feishu:{label:'飞书',intro:'首次连接会准备飞书官方运行环境。在飞书官方页面扫码创建应用，再扫码授权个人账号；应用配置自动保存，后续连接直接授权。'},
 };
 const api=()=>global.soduWorkAPI&&global.soduWorkAPI.platformConnections;
 const providers=item=>global.SoduWorkPluginPlatforms.forItem(item);
 const connection=(item,key)=>item.platformConnections?.[key]||item.platformConnection;
 const provider=item=>providers(item).find(key=>!matches(key,connection(item,key))||!connection(item,key).connected)||providers(item)[0]||'';
 const esc=value=>String(value||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const activeStates=['preparing','connecting','awaiting_user'];
 let scopeRevision=0;const stateRevisions=new Map(),latest=new Map();
 global.addEventListener?.('soduwork-data-scope-changed',()=>{scopeRevision++;stateRevisions.clear();latest.clear();});
 const matches=(key,value)=>value&&value.ok===true&&value.provider===key;
 function ready(item){return providers(item).every(key=>matches(key,connection(item,key))&&connection(item,key).connected);}
 function remember(item,key,value){
  const previous=latest.get(key);
  const items=[item,...(global.SoduWorkCapabilityPlugins?.snapshot().items||[]).filter(x=>providers(x).includes(key))];
  for(const target of items){target.platformConnections={...(target.platformConnections||{}),[key]:value};target.platformConnection=value;}
  latest.set(key,value);
  if(previous?.connected!==value?.connected||previous?.disconnected!==value?.disconnected)
   global.dispatchEvent?.(new CustomEvent('soduwork:plugins-changed', {detail:{platformStatusOnly:true}}));
 }
 // Old installed manifests also get the correct instructions for this desktop connection entry.
 function setupDescription(item){const keys=providers(item);return keys.length?'点击「连接账号」。'+keys.map(key=>PLATFORMS[key].intro).join(' '):String(item&&item.setup&&item.setup.description||'');}
 async function hydrate(items,isCurrent=()=>true){
  if(!api())return;
  const pending=new Map(),epoch=scopeRevision;
  await Promise.all(items.flatMap(item=>providers(item).map(async key=>{
   if(!pending.has(key))pending.set(key,Promise.resolve().then(()=>api().status(key)));
   const version=stateRevisions.get(key)||0;
   try{const value=await pending.get(key);if(epoch!==scopeRevision||!isCurrent())return;remember(item,key,version===(stateRevisions.get(key)||0)?(value?.provider===key&&(value.ok||value.disconnected)?value:{}):(latest.get(key)||{}));}
   catch(_){if(epoch===scopeRevision&&isCurrent())remember(item,key,version===(stateRevisions.get(key)||0)?{}:(latest.get(key)||{}));}
  })));
 }
 function markup(item){
  const key=provider(item);if(!key||!api())return'';
  const state=matches(key,connection(item,key))?connection(item,key):{};
  return '<section class="cap-detail-section cap-platform-status"><b>平台连接</b><p>'+esc(state.connected?'账号已连接':state.installed?'运行环境已就绪，等待账号连接':'连接时会准备官方运行环境')+'</p><button type="button" class="btn-mini primary" id="capPlatformConnect">'+(state.connected?'管理连接':'连接账号')+'</button></section>';
 }
 function open(item,ctx,options={}){
  return openProvider(provider(item),ctx,options,item);
 }
 function openProvider(key,ctx,options={},item={}){
  if(!PLATFORMS[key]||!api())return;
  const platform=PLATFORMS[key],epoch=scopeRevision;
  ctx.closeModal();
  const layer=ctx.openModal('连接'+platform.label,'仅用于当前 SoduWork 账号',
   '<section class="cap-platform-connect"><p class="cap-platform-intro">'+esc(platform.intro)+'</p><div class="cap-platform-state" role="status" aria-live="polite" id="capPlatformState">正在检查…</div><div id="capPlatformAuth" hidden><p id="capPlatformHint"></p><img id="capPlatformQr" alt="企业微信扫码授权二维码" hidden><code id="capPlatformCode"></code><button type="button" class="btn-mini primary" id="capPlatformAuthOpen">打开'+platform.label+'官方授权页</button></div><p class="cap-platform-note" id="capPlatformNote"></p><div class="cap-platform-disconnect" id="capPlatformDisconnectConfirm" hidden><b>断开本机连接？</b><p>当前账号在本机的对话和自动化将无法使用此连接，需要重新连接后才能继续。这不会撤销平台侧的授权。</p><div><button type="button" class="btn-mini" id="capPlatformKeep">保留连接</button><button type="button" class="btn-mini cap-delete-action" id="capPlatformDisconnectApply">确认断开</button></div></div></section>',
   '<button type="button" class="btn-mini" id="capPlatformClose">关闭</button><button type="button" class="btn-mini" id="capPlatformCancel" hidden>取消本次授权</button><button type="button" class="btn-mini cap-delete-action" id="capPlatformDisconnect" hidden>断开本机连接</button><span class="push"></span><button type="button" class="btn-mini" id="capPlatformCheck" disabled>检查连接</button><button type="button" class="btn-mini primary" id="capPlatformStart" disabled>连接账号</button><button type="button" class="btn-mini primary" id="capPlatformContinue" hidden>继续试用</button>');
  let current={},busy=false,timer=null,stopped=false,revision=0,confirming=false;
  const $=id=>layer.querySelector('#'+id);
  const anchor=$('capPlatformState');
  const manageConflict=layer.ownerDocument?.createElement('button');
  if (manageConflict && typeof options.manageConflict === 'function') {
   manageConflict.type='button';manageConflict.className='btn-mini';manageConflict.hidden=true;
   manageConflict.textContent='管理同名连接';$('capPlatformNote').after(manageConflict);
   manageConflict.onclick=()=>perform(()=>options.manageConflict(current.conflictId,live));
  }
  const live=()=>epoch===scopeRevision&&!stopped&&layer.isConnected&&!layer.hidden&&$('capPlatformState')===anchor;
  const notify=()=>{if(typeof ctx.refresh==='function')ctx.refresh();};
  function render(value){
   if(!live())return;
   current=value||{};
   if(manageConflict)manageConflict.hidden=!current.conflictId||busy||confirming;
   if(current.provider===key){
    stateRevisions.set(key,(stateRevisions.get(key)||0)+1);remember(item,key,current);
    if(typeof options.onState==='function')options.onState(current);
   }
   const label={needs_setup:'尚未连接',needs_auth:'等待账号授权',preparing:'正在准备运行环境…',connecting:'正在连接…',awaiting_user:'等待你完成授权',connected:'已连接',disconnected:'已断开本机连接',error:'连接需要处理'};
   $('capPlatformState').textContent=label[current.state]||'尚未连接';
   $('capPlatformState').dataset.state=current.state||'';
   const qr=/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(current.qrCode||'')?current.qrCode:'';
   const waiting=!!(current.authUrl||qr);
   $('capPlatformQr').hidden=!qr;
   $('capPlatformQr').src=qr;
   $('capPlatformAuthOpen').hidden=!current.authUrl;
   $('capPlatformNote').textContent=waiting?'':current.message||'';
   $('capPlatformAuth').hidden=!waiting;
   $('capPlatformHint').textContent=current.message||'';
   $('capPlatformCode').textContent=current.userCode||'';
   $('capPlatformCode').hidden=!current.userCode;
   $('capPlatformCancel').hidden=!['connecting','awaiting_user'].includes(current.state);
   $('capPlatformCancel').disabled=busy||confirming;
   $('capPlatformDisconnect').hidden=!api().disconnect||activeStates.includes(current.state)||(!current.installed&&!current.disconnected)||(current.disconnected&&current.state!=='error')||confirming;
   $('capPlatformDisconnect').disabled=busy;
   $('capPlatformDisconnectConfirm').hidden=!confirming;
   $('capPlatformKeep').disabled=busy;
   $('capPlatformDisconnectApply').disabled=busy;
   $('capPlatformStart').disabled=busy||confirming||activeStates.includes(current.state);
   $('capPlatformStart').textContent=current.connected?'重新授权':current.disconnected?'重新连接':key==='feishu'?'扫码连接':'连接账号';
   $('capPlatformAuthOpen').textContent=key==='feishu'?(current.phase==='app_registration'?'前往飞书扫码创建应用':'前往飞书扫码授权'):'打开'+platform.label+'官方授权页';
   $('capPlatformCheck').disabled=busy||confirming;
   $('capPlatformContinue').hidden=!current.connected||typeof options.onReady!=='function';
   $('capPlatformContinue').disabled=busy||confirming;
  }
  function fail(error){render({...current,...error.connection,state:'error',connected:false,authUrl:'',qrCode:'',userCode:'',message:error.message});remember(item,key,current);}
  async function invoke(action,body){
   const result=await api()[action](key,body);
   if(!result||!result.ok){const error=Error(result&&result.reason||'连接操作没有完成');
    if(result?.provider===key&&result.disconnected)error.connection=result;throw error;}
   if(action!=='openAuth'&&!matches(key,result))throw Error('返回的平台与当前连接器不一致，请重新检查连接');
   return result;
  }
  function schedule(){
   if(timer)clearTimeout(timer);
   timer=null;
   if(live()&&activeStates.includes(current.state))timer=setTimeout(poll,750);
  }
  async function poll(){
   if(timer)clearTimeout(timer);timer=null;
   if(!live()||busy||confirming)return;
   const requestedAt=revision;
   try{const value=await invoke('status');if(!live()||busy||revision!==requestedAt)return;render(value);remember(item,key,value);if(value.connected)notify();}
   catch(error){if(live()&&!busy&&revision===requestedAt)fail(error);}
   schedule();
  }
  async function perform(action){
   if(!live()||busy)return;
   busy=true;revision++;render(current);
   try{await action();}catch(error){if(live())fail(error);}
   finally{busy=false;if(live()){render(current);schedule();}}
  }
  $('capPlatformClose').onclick=()=>{stopped=true;if(timer)clearTimeout(timer);ctx.closeModal();notify();};
  $('capPlatformStart').onclick=()=>{if(confirming)return;return perform(async()=>{
   if(!current.installed){$('capPlatformState').textContent='正在准备官方运行环境，首次可能需要几分钟…';const value=await invoke('prepare');if(!live())return;render(value);}
   const value=await invoke('connect',{});
   if(live()){render(value);remember(item,key,value);notify();}
  });};
  $('capPlatformCheck').onclick=()=>{if(!confirming)return check();};
  $('capPlatformDisconnect').onclick=()=>{
   if(!live()||busy||!api().disconnect)return;
   confirming=true;revision++;if(timer)clearTimeout(timer);timer=null;render(current);
   $('capPlatformKeep').focus?.();
  };
  $('capPlatformKeep').onclick=()=>{if(busy||!live())return;confirming=false;render(current);$('capPlatformDisconnect').focus?.();schedule();};
  $('capPlatformDisconnectApply').onclick=()=>{if(!confirming)return;return perform(async()=>{
   $('capPlatformState').textContent='正在断开本机连接…';
   try{const value=await invoke('disconnect');if(live()){render(value);remember(item,key,value);notify();}}
   finally{confirming=false;}
  });};
  $('capPlatformCancel').onclick=()=>perform(async()=>{const value=await invoke('cancel');if(live()){render(value);remember(item,key,value);notify();}});
  $('capPlatformContinue').onclick=()=>{
   if(!live()||busy||confirming||!current.connected||typeof options.onReady!=='function')return;
   stopped=true;if(timer)clearTimeout(timer);ctx.closeModal();options.onReady();
  };
  $('capPlatformAuthOpen').onclick=()=>perform(()=>invoke('openAuth'));
  function check(){return perform(async()=>{
   $('capPlatformState').textContent='正在检查连接…';
   const value=await invoke('refresh');if(live()){render(value);remember(item,key,value);}
  });}
  check();
 }
 function bind(layer,item,ctx){const button=layer.querySelector('#capPlatformConnect');if(button)button.addEventListener('click',()=>open(item,ctx));}
 global.SoduWorkPlatformConnections={provider,providers,ready,hydrate,markup,setupDescription,bind,open,openProvider};
})(window);
