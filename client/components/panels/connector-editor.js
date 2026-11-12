/* One primary connector action validates, saves, and enables configuration; preserve the draft on failure. */
(function (global) {
  'use strict';
  function open(ctx, initial, template, options = {}) {
    const api = ctx.api, h = ctx.h, say = ctx.say, errorText = ctx.errorText;
    template = global.SoduWorkConnectorConfig.apiTemplate(initial) || template || (ctx.data.mcpTemplates || []).find(t => t.key === initial?.templateKey) || null;
    const commercial = !!template?.configurable;
    if (initial && (initial.builtIn || initial.canEdit === false)) { say('此连接器由系统维护，可在列表中启停'); return; }
    const value = initial ? {...initial} : {id:global.crypto.randomUUID(),name:template?.name||String(options.name||''),
      type:template?'stdio':'http',templateKey:template?.key||'',url:'',headers:{},env:{},
      description:template?.description||String(options.description||''),enabled:false,
      startupTimeoutSeconds:10,toolTimeoutSeconds:60,enabledTools:[],disabledTools:[]};
    const local = value.type === 'stdio';
    const brand = global.SoduWorkConnectorBrand?.image(template || value) || ctx.warnIcon || '';
    const fields = template?.connectionFields || [];
    const bundled = template?.template?.command === 'soduwork-connector' && !value.apiDefinition;
    const port = bundled && fields.find(field => field.key.endsWith('_PORT') && field.default &&
      fields.some(other => other.key === field.key.replace(/_PORT$/, '_HOST')));
    const hostKey = port && port.key.replace(/_PORT$/, '_HOST');
    const redis = bundled && template.key === 'connector-redis';
    const fieldMarkup = field => {
      const raw = value.env?.[field.key];
      const fallback = (field === port || redis) && !field.secret ? field.default : '';
      const saved = String(raw === undefined || raw === null || raw === '' ? fallback ?? '' : raw);
      const tls = redis && field.key === 'REDIS_TLS';
      if (tls || field.type === 'boolean') {
        const hint = tls ? '本机未启用 TLS 时可关闭。远程连接或使用 CA 证书时须开启。'
          : field.key === 'ALLOW_WRITES' ? '仅在你需要创建、修改或发送内容时开启' : '';
        const checked = saved === 'true' || (tls && Boolean(value.env?.REDIS_CA_PEM));
        return '<label class="cap-confirm"><input data-connector-field="'+h(field.key)+'" type="checkbox"'+(checked?' checked':'')+'><span>'+h(tls?'使用 TLS':field.label)+(hint?'<small>'+h(hint)+'</small>':'')+'</span></label>';
      }
      const paired = field === port || field.key === hostKey;
      let label = field.label, placeholder = field.example || (field.secret ? '粘贴授权凭据' : '');
      if (field.key === hostKey) label = '数据库主机';
      if (redis && field.key === 'REDIS_USER') label = '用户名';
      if (redis && field.key === 'REDIS_PASSWORD') { label = '密码'; placeholder = ''; }
      return '<label class="cap-field'+(paired?'':' wide')+'"><span>'+h(label)+(field.required || field === port?'':' <em>选填</em>')+'</span><input class="cap-input" data-connector-field="'+h(field.key)+'" type="'+(field.secret?'password':'text')+'"'+(field === port?' inputmode="numeric"':'')+' autocomplete="off" maxlength="16384" value="'+h(saved)+'" placeholder="'+h(placeholder)+'"></label>';
    };
    const mainFields = fields.filter(field => field === port || (field.required && field.type !== 'boolean') ||
      (redis && ['REDIS_USER','REDIS_PASSWORD','REDIS_TLS'].includes(field.key)));
    const moreFields = fields.filter(x=>!mainFields.includes(x));
    const address = port ? '<div><div class="connector-db-address">'+fields.filter(field => field.key === hostKey || field === port).map(fieldMarkup).join('')+'</div><small class="connector-inline-note">localhost 指运行连接器的那台电脑。</small></div>' : '';
    const layer = ctx.openModal(initial ? '管理连接' : (template?'连接 '+template.name:'添加连接器'),
      '连接一次，在对话、插件和自动化中使用',
      '<div class="connector-intro"><span class="connector-intro-icon">'+brand+'</span><div><strong>'+h(template?.name||value.name||'远程连接')+'</strong><p>'+h(global.SoduWorkConnectorConfig.summary(template?.description||value.description)||'接入你已经使用的业务工具')+'</p></div></div>'+
      (value.apiDefinition?'<p class="connector-inline-note">'+h(value.apiDefinition.baseUrl)+' · '+Number(value.apiDefinition.tools?.length||0)+' 个接口</p>':'')+
      (!local?'<label class="cap-field"><span>连接地址或配置</span><textarea class="cap-textarea compact" id="capMcpQuickConfig" placeholder="粘贴连接地址或 JSON 配置">'+h(value.url||'')+'</textarea></label><select class="cap-input" id="capMcpQuickChoice" aria-label="选择连接" hidden></select><p class="connector-inline-note" id="capMcpAutoFillStatus" role="status"></p>':'')+
      '<div class="cap-fields connector-main-fields">'+address+mainFields.filter(field => field !== port && field.key !== hostKey).map(fieldMarkup).join('')+'</div>'+
      '<div data-connector-oauth></div>'+
      (commercial && template.officialDocs?.[0]?'<a class="connector-help" href="'+h(template.officialDocs[0])+'" target="_blank" rel="noopener noreferrer">如何获取授权 <span aria-hidden="true">↗</span></a>':'')+
      '<details class="cap-mcp-advanced connector-advanced"><summary><span>高级设置</span><i>›</i></summary><div class="cap-mcp-advanced-body"><div class="cap-fields">'+
      '<label class="cap-field"><span>连接名称</span><input class="cap-input" id="capMcpName" maxlength="60" value="'+h(value.name)+'"></label>'+
      '<label class="cap-field"><span>说明 <em>选填</em></span><input class="cap-input" id="capMcpDesc" maxlength="200" value="'+h(value.description||'')+'"></label>'+
      (!local?'<label class="cap-field wide"><span>连接地址</span><input class="cap-input" id="capMcpUrl" maxlength="400" value="'+h(value.url||'')+'"></label><label class="cap-field wide"><span>鉴权头 <em>每行一项，头名=值</em></span><textarea class="cap-textarea compact" id="capMcpHeaders" autocomplete="off">'+h(kvText(value.headers))+'</textarea></label>':'')+
      moreFields.map(fieldMarkup).join('')+
      '<label class="cap-field"><span>启动超时（秒）</span><input class="cap-input" id="capMcpStartup" type="number" min="3" max="120" value="'+h(value.startupTimeoutSeconds||10)+'"></label>'+
      '<label class="cap-field"><span>调用超时（秒）</span><input class="cap-input" id="capMcpToolTimeout" type="number" min="3" max="300" value="'+h(value.toolTimeoutSeconds||60)+'"></label>'+
      '<label class="cap-field"><span>允许的工具</span><textarea class="cap-textarea compact" id="capMcpEnabledTools" placeholder="留空表示使用全部已授权工具">'+h((value.enabledTools||[]).join('\n'))+'</textarea></label>'+
      '<label class="cap-field"><span>禁用的工具</span><textarea class="cap-textarea compact" id="capMcpDisabledTools" placeholder="每行一个工具名">'+h((value.disabledTools||[]).join('\n'))+'</textarea></label></div>'+
      '<div class="connector-extra-actions"><button class="btn-mini" id="capMcpCheck" type="button">仅检查连接</button><button class="btn-mini" id="capMcpDraft" type="button">保存为停用配置</button>'+
      (initial&&template&&options.allowAdditional?'<button class="btn-mini" id="capMcpAnother" type="button">连接其他账号</button>':'')+'</div>'+
      (template?.limitations?.length?'<p class="connector-inline-note">'+template.limitations.map(h).join('；')+'</p>':'')+
      '</div></details><div class="cap-probe-result" id="capMcpProbe" role="status" aria-live="polite" hidden></div>'+
      '<p class="connector-consent">点击连接即允许 SoduWork 检查此连接并按你的指令使用；检查不会发送或修改业务内容。</p>',
      '<button class="btn-mini" id="capModalCancel" type="button">取消</button><span class="push"></span><button class="btn-mini primary" id="capMcpSave" type="button">'+(initial?'保存并连接':'连接')+'</button>');
    layer.querySelector('.cap-modal')?.classList.add('cap-connector-editor');
    const marker = {}, owner = api.taskStorageKey?.('ops'), revision = ctx.viewRevision?.();
    layer._mcpEditorView = marker;
    const save = layer.querySelector('#capMcpSave'), check = layer.querySelector('#capMcpCheck'), draft = layer.querySelector('#capMcpDraft');
    const probe = layer.querySelector('#capMcpProbe');
    const sameOwner = () => !api.taskStorageKey || api.taskStorageKey('ops') === owner;
    const current = () => layer.isConnected !== false && !layer.hidden && layer._mcpEditorView === marker
      && layer.querySelector('#capMcpSave') === save && sameOwner() && (!ctx.viewRevision || ctx.viewRevision() === revision);
    let saving = false, pending = false, ticket = 0, verified = '', started = '', lastResult = null, quickRows = null;
    let appliedQuick = value.url || '';
    const controls = () => Array.from(layer.querySelectorAll('#capModalBody input, #capModalBody textarea, #capModalBody select'));
    const form = id => layer.querySelector('#'+id);
    if (initial && options.editName) {
      const name = form('capMcpName');
      name.closest('details').open = true;
      name.focus(); name.select();
    }
    let auth=null;
    const compose = (enabled = value.enabled) => ({
      ...(auth?.binding()?{oauth:auth.binding()}:{}),
      id:value.id,name:form('capMcpName').value.trim(),type:local?'stdio':'http',templateKey:value.templateKey,
      url:local?'':form('capMcpUrl').value.trim(),command:value.apiDefinition?'soduwork-api':'',args:[],
      ...(value.apiDefinition?{apiDefinition:value.apiDefinition}:{}),
      env:commercial?Object.fromEntries(Array.from(layer.querySelectorAll('[data-connector-field]')).map(f=>[f.dataset.connectorField,f.type==='checkbox'?String(f.checked):f.value])):{},
      headers:local?{}:parseKv(form('capMcpHeaders').value),keycloak:{},description:form('capMcpDesc').value.trim(),
      startupTimeoutSeconds:Number(form('capMcpStartup').value||10),toolTimeoutSeconds:Number(form('capMcpToolTimeout').value||60),
      enabledTools:names(form('capMcpEnabledTools').value),disabledTools:names(form('capMcpDisabledTools').value),
      enabled,approved:true,approvedTarget:value.apiDefinition?'api:'+value.apiDefinition.id:local?value.templateKey:form('capMcpUrl').value.trim()
    });
    const fingerprint = spec => JSON.stringify({...spec,enabled:undefined});
    function show(state,title,detail) {
      if (!current()) return;
      probe.hidden=false;probe.className='cap-probe-result '+state;
      const doc=probe.ownerDocument,body=doc.createElement('div'),heading=doc.createElement('b');
      heading.textContent=title;body.append(heading);
      if(detail){const note=doc.createElement('span');note.textContent=detail;body.append(note);}
      probe.replaceChildren(doc.createElement('i'),body);
    }
    function idleButtons() { if (!current()) return; save.disabled=false;check.disabled=false;draft.disabled=false;
      save.textContent=initial?'保存并连接':'连接';check.textContent='仅检查连接'; }
    function invalidate() {
      if (!current() || saving) return;
      if ((pending && started!==fingerprint(compose())) || (verified && verified!==fingerprint(compose()))) {
        ticket++;pending=false;verified='';lastResult=null;idleButtons();show('idle','配置已更新','连接时会自动重新检查');
      }
    }
    function fillQuick(row) {
      if (row.type!=='http') throw Error('本地工具请从连接器目录选择，或使用“导入配置”检查');
      const changedTarget = form('capMcpUrl').value.trim() !== row.url;
      if (changedTarget) {
        form('capMcpHeaders').value='';
        form('capMcpEnabledTools').value='';form('capMcpDisabledTools').value='';
        form('capMcpStartup').value=10;form('capMcpToolTimeout').value=60;
      }
      form('capMcpUrl').value=row.url;
      appliedQuick=form('capMcpQuickConfig').value;
      form('capMcpName').value=row.name||form('capMcpName').value;
      for (const [key,id] of [['description','capMcpDesc'],['startupTimeoutSeconds','capMcpStartup'],['toolTimeoutSeconds','capMcpToolTimeout']])
        if (row[key]!==undefined) form(id).value=row[key];
      if (row.headers!==undefined) form('capMcpHeaders').value=kvText(row.headers);
      for (const [key,id] of [['enabledTools','capMcpEnabledTools'],['disabledTools','capMcpDisabledTools']])
        if (row[key]!==undefined) form(id).value=row[key].join('\n');
      form('capMcpAutoFillStatus').textContent='已识别 '+row.name;
      invalidate();
    }
    function applyQuick() {
      if (!current() || saving) return false;
      try {
        if (form('capMcpQuickConfig').value === appliedQuick && form('capMcpUrl').value.trim()) return true;
        quickRows=global.SoduWorkConnectorConfig.parse(form('capMcpQuickConfig').value);
        const choice=form('capMcpQuickChoice');
        choice.hidden=quickRows.length===1;
        if (quickRows.length>1) {
          const options=[{name:'选择要连接的服务（'+quickRows.length+'）',value:''},...quickRows.map((r,i)=>({name:r.name,value:String(i)}))];
          choice.replaceChildren(...options.map(row=>{const option=choice.ownerDocument.createElement('option');option.value=row.value;option.textContent=row.name;return option;}));
          choice.value='';form('capMcpAutoFillStatus').textContent='检测到多个连接，请选择一个；批量添加可使用导入配置';
          return false;
        }
        fillQuick(quickRows[0]);return true;
      } catch(e) { quickRows=null;form('capMcpAutoFillStatus').textContent=e.message;return false; }
    }
    if (!local) {
      form('capMcpQuickConfig').addEventListener('input',()=>{ticket++;pending=false;verified='';lastResult=null;idleButtons();});
      form('capMcpUrl').addEventListener('change',()=>{
        if (form('capMcpUrl').value.trim() !== value.url) form('capMcpHeaders').value='';
        form('capMcpQuickConfig').value=form('capMcpUrl').value;appliedQuick=form('capMcpUrl').value;
      });
      form('capMcpQuickConfig').addEventListener('paste',()=>setTimeout(applyQuick,0));
      form('capMcpQuickConfig').addEventListener('change',applyQuick);
      form('capMcpQuickChoice').addEventListener('change',()=>{
        const selected=form('capMcpQuickChoice').value;
        if (selected!=='' && quickRows?.[Number(selected)]) { try {fillQuick(quickRows[Number(selected)]);} catch(e) {form('capMcpAutoFillStatus').textContent=e.message;} }
      });
    }
    controls().forEach(f=>{f.addEventListener('input',invalidate);f.addEventListener('change',invalidate);
      if (f.dataset.connectorField) f.addEventListener('paste',event=>{
        const value=global.SoduWorkConnectorConfig.credentialPaste(f.dataset.connectorField,event.clipboardData?.getData('text/plain'));
        if (value!==null) { event.preventDefault();f.value=value;invalidate(); }
      });
    });
    function validate(spec) {
      if (!spec.name || !local && !spec.url) throw Error('请先填写连接地址或选择服务');
      if (spec.enabledTools.some(x=>spec.disabledTools.includes(x))) throw Error('同一工具不能同时允许和禁用');
      const absent=mainFields.find(x=>x.required&&!auth?.skipField(x.key)&&!String(spec.env[x.key]||'').trim());
      if (absent) { layer.querySelector('[data-connector-field="'+absent.key+'"]')?.focus();throw Error('请填写'+absent.label); }
      if (port && (!/^\d{1,5}$/.test(spec.env[port.key]) || Number(spec.env[port.key]) < 1 || Number(spec.env[port.key]) > 65535)) {
        layer.querySelector('[data-connector-field="'+port.key+'"]')?.focus();
        throw Error('端口必须是 1 到 65535 之间的整数');
      }
      if (redis && spec.env.REDIS_TLS === 'false' && (spec.env.REDIS_CA_PEM ||
          !['localhost','127.0.0.1','::1'].includes(String(spec.env.REDIS_HOST).toLowerCase()))) {
        layer.querySelector('[data-connector-field="REDIS_TLS"]')?.focus();
        throw Error('远程 Redis 或使用 CA 证书的连接需要启用 TLS');
      }
      if (redis && spec.env.REDIS_USER && !spec.env.REDIS_PASSWORD) {
        layer.querySelector('[data-connector-field="REDIS_PASSWORD"]')?.focus();
        throw Error('填写 Redis 用户名后也需要填写密码');
      }
    }
    async function inspect(spec, id) {
      const valid=()=>current() && id===ticket && fingerprint(spec)===fingerprint(compose());
      if (api.preflightMyMcpServer) {
        const preflight=await api.preflightMyMcpServer(spec);
        if (!valid()) return null;
        if (preflight?.ok===false) throw Error(preflight.message||'请检查连接配置');
      }
      if (!valid()) return null;
      show('loading','正在检查授权','完成后会自动连接');
      const result=await api.probeMyMcpServer(spec);
      if (!valid()) return null;
      if (result?.ok===false) throw Error(result.error||result.message||'暂时无法连接，请检查授权或执行设备');
      verified=fingerprint(spec);lastResult=result;
      const state=global.SoduWorkConnectorConfig.status(result,commercial);
      show(state.state,state.title,state.detail);return result||{};
    }
    let authorizing=false;
    async function connect(onlyCheck = false, saveDraft = false) {
      if (!current() || saving || pending || authorizing) return;
      if (port) {
        const input = layer.querySelector('[data-connector-field="'+port.key+'"]');
        if (!input.value.trim()) input.value = String(port.default);
      }
      if (!local && (form('capMcpQuickConfig').value!==appliedQuick || !form('capMcpUrl').value.trim()) && !applyQuick()) return;
      if(auth){
        authorizing=true;
        try{
          await auth.ready;
          if(!current())return;
          validate(compose(!saveDraft));
          if(!saveDraft&&!await auth.authorize())return;
        }catch(e){if(current())show('bad','连接未完成',errorText(e,'授权未完成，请重试'));return;}
        finally{authorizing=false;}
      }
      if(!current())return;
      const spec=compose(!saveDraft);
      try { validate(spec); } catch(e) {show('bad','还差一点信息',e.message);return;}
      const id=++ticket, submitted=fingerprint(spec);
      saving=!onlyCheck;pending=!saveDraft;started=submitted;
      save.disabled=true;check.disabled=true;draft.disabled=true;
      save.textContent=saveDraft?'正在保存…':'正在连接…';
      const inputs=controls(),disabled=inputs.map(f=>f.disabled);
      if (saving) inputs.forEach(f=>{f.disabled=true;});
      try {
        if (!saveDraft && (onlyCheck || verified!==submitted)) {
          show('loading','正在连接','正在检查配置与执行设备');
          if (!await inspect(spec,id)) return;
        }
        if (!current() || id!==ticket || submitted!==fingerprint(compose())) return;
        if (onlyCheck) return;
        save.textContent='正在保存…';
        const result=await api.saveMyMcpServer(spec,initial||null);
        if (!current() || id!==ticket) return;
        ctx.setState(result,ctx.data);ctx.closeModal();
        const after=ctx.viewRevision?.();
        const canFinish=()=>sameOwner() && layer.isConnected!==false && layer._mcpEditorView===marker &&
          layer.querySelector('#capMcpSave')===save && (!ctx.viewRevision || ctx.viewRevision()===after);
        const state=global.SoduWorkConnectorConfig.status(lastResult,commercial);
        say(saveDraft?'配置已保存，暂未启用':state.state==='ok'?'已连接，可直接使用':'配置已保存并启用，业务授权待验证');
        try {
          const catalog=await api.capabilityCatalog();
          if (!canFinish()) return;
          ctx.setState(result,catalog);ctx.render();
        } catch(e) { if (canFinish()) say('连接已经保存；目录暂未更新，可稍后刷新'); }
        if (canFinish() && typeof options.onSaved==='function') {
          try {await options.onSaved(result);} catch(e) {if(canFinish()) say('连接已保存；'+errorText(e,'后续操作暂未完成'));}
        }
      } catch(e) {
        if (current() && id===ticket) show('bad','连接未完成',errorText(e,'请检查授权或执行设备后重试'));
      } finally {
        if (current() && id===ticket) {
          if (submitted!==fingerprint(compose())) show('idle','配置已更新','连接时会自动重新检查');
          saving=false;pending=false;inputs.forEach((f,i)=>{f.disabled=disabled[i];});idleButtons();
        }
      }
    }
    auth=global.SoduWorkConnectorAuth?.create({api,layer,value,template,current,show,onChange:invalidate,save,compose})||null;
    form('capModalCancel').addEventListener('click',ctx.closeModal);
    save.addEventListener('click',()=>connect());
    check.addEventListener('click',()=>connect(true));
    draft.addEventListener('click',()=>connect(false,true));
    form('capMcpAnother')?.addEventListener('click',()=>{if(current()&&!saving&&!pending)ctx.openMcpEditor(null,template);});
    return {layer};
  }
  function kvText(v) {return Object.entries(v||{}).map(([k,x])=>k+'='+x).join('\n');}
  function parseKv(text) {
    const out={};
    for(const line of String(text||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean)) {
      const i=line.indexOf('=');out[(i<0?line:line.slice(0,i)).trim()]=(i<0?'':line.slice(i+1)).trim();
    }
    return out;
  }
  function names(text) {return [...new Set(String(text||'').split(/[\r\n,]+/).map(x=>x.trim()).filter(Boolean))].slice(0,200);}
  global.SoduWorkConnectorEditor={open};
})(window);
