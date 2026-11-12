/*
 * Initialize tasks and configuration from SoduWorkAPI. Renderer components share the
 * exposed tasks and cfg globals and persist changes through save and saveCfg.
 */
const _taskStorageKey=(kind,fallback)=>window.SoduWorkAPI&&typeof SoduWorkAPI.taskStorageKey==='function'
  ? SoduWorkAPI.taskStorageKey(kind):fallback;
const LS_KEY=()=>_taskStorageKey('tasks','soduwork_work_tasks_v5'),LS_CFG='soduwork_work_cfg_v5';
const LS_TASK_OPS=()=>_taskStorageKey('ops','soduwork_work_task_ops_v1');
const LS_TASK_SHADOW=()=>_taskStorageKey('shadow','soduwork_work_task_shadow_v1');
const {stripServerOwned,safeParseCfg}=SoduWorkStoreLifecycle;
const STATUS={todo:'待办',doing:'进行中',done:'已完成',cancel:'搁置'};
/* Match theme --s-* tokens when computed styles cannot provide them. */
const STATUS_RAW={todo:'#5b93f0',doing:'#f5a524',done:'#22c197',cancel:'#a2abbb'};
const statusRaw=k=>{const m={todo:'--s-todo',doing:'--s-doing',done:'--s-done',cancel:'--s-cancel'};return getComputedStyle(document.documentElement).getPropertyValue(m[k]).trim()||STATUS_RAW[k]};
const uid=()=>'t'+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/*
 * Integrated tasks are read-only and may link to their source. Identify them by
 * integrationId or nonlocal, nondispatch origin; platform-dispatched tasks remain
 * editable.
 */
function isExternalTask(t){ return !!(t && (t.integrationId || (t.origin && t.origin!=='local' && t.origin!=='dispatch'))); }
function isTaskReadOnly(t){ return !!(t && t.readOnly); }
function hasTaskDeletePermission(t){return !!t&&(typeof t.canDeleteRequirement==='boolean'?t.canDeleteRequirement:t.canEditRequirement===true);}
/* Map origins to display labels, badge text, and badge colors. */
const SOURCE_META={
  gitlab:{label:'GitLab',short:'GL',color:'#e8663a'},
  jira:{label:'Jira',short:'JR',color:'#2a7de1'},
  zentao:{label:'禅道',short:'ZT',color:'#2ea44f'}
};
function sourceMeta(t){ return (t&&SOURCE_META[t.origin])||{label:(t&&t.origin)||'外部',short:'↗',color:'#6b5bd2'}; }
/* Open source links through Electron shell.openExternal for HTTP(S), falling back to window.open in browsers. */
function openExternalTask(t){
  const url=t&&t.externalUrl; if(!url)return;
  if(window.soduWorkAPI&&soduWorkAPI.openExternal){ soduWorkAPI.openExternal(url); }
  else{ try{ window.open(url,'_blank','noopener'); }catch(e){} }
}
const repChar=t=>{if(!t)return'？';return[...t].find(c=>/[\u4e00-\u9fa5a-zA-Z0-9]/.test(c))||[...t][0]};
const Store={
  _tasks:[],
  /* Preserve existing settings, tolerate malformed startup data, and remove server-owned fields. */
  _cfg:stripServerOwned(Object.assign({mode:'quad',shape:'ball',remind:'light',gender:'boy',theme:'vivid',character:'soduwork',locale:'zh-CN',_lastSkinId:'soduwork-logo',hubX:null,hubY:null,tubeCols:1},safeParseCfg(localStorage.getItem(LS_CFG)))),
  _syncT:null,_syncC:null,_wsOff:null,_taskRetryT:null,_taskFlushPromise:null,
  _taskInFlight:Object.create(null),
  _taskPriorityFlushPromise:null,
  _taskPersistJobs:new Map(),
  _taskPersistWaiters:new Set(),
  _taskPersistErrors:Object.create(null),
  _shadow:Object.create(null),
  _readTaskOps(){
    try{
      const rows=JSON.parse(localStorage.getItem(LS_TASK_OPS())||'[]');
      return Array.isArray(rows)?rows.filter(x=>x&&x.id&&x.kind):[];
    }catch(e){return[]}
  },
  _writeTaskOps(rows){
    try{localStorage.setItem(LS_TASK_OPS(),JSON.stringify(rows||[]));}catch(e){}
  },
  _opToken(){return Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9)},
  _mergeTaskOperation(next){
    let ops=this._readTaskOps();
    const i=ops.findIndex(x=>x.id===next.id);
    const previous=i>=0?ops[i]:null;
    let merged=TaskSync.mergeOperation(previous,next);
    /* Known-server rows and in-flight PUTs require a real compensating DELETE. */
    const active=this._taskInFlight[next.id]||(previous&&previous.sentAt?previous:null);
    if(!merged&&previous&&(this._shadow[next.id]||(active&&previous.token===active.token)))merged=Object.assign({},next);
    if(merged){
      merged.id=next.id;merged.token=this._opToken();merged.at=Date.now();
      if(next.notBefore)merged.notBefore=next.notBefore;else if(merged.kind!=='delete')delete merged.notBefore;
      delete merged.blocked;
      if(i>=0)ops[i]=merged;else ops.push(merged);
    }else if(i>=0)ops.splice(i,1);
    this._writeTaskOps(ops);
    return merged;
  },
  _captureTaskChanges(){
    if(typeof TaskSync==='undefined')return;
    let ops=this._readTaskOps();
    const setDesired=(id,desired)=>{
      const i=ops.findIndex(x=>x.id===id);const previous=i>=0?ops[i]:null;
      if(!desired){if(i>=0)ops.splice(i,1);return;}
      desired.id=id;
      /* No real change: retain the token (and a 4xx blocked state).  Otherwise
         frequent save() calls can make every in-flight response look stale. */
      if(previous&&TaskSync.sameIntent(previous,desired))return;
      desired.token=this._opToken();desired.at=Date.now();delete desired.blocked;
      if(i>=0)ops[i]=desired;else ops.push(desired);
    };
    this._tasks.forEach(task=>{
      if(!task||!task.id)return;
      if(typeof isTaskReadOnly==='function'&&isTaskReadOnly(task)){setDesired(task.id,null);return;}
      const server=this._shadow[task.id];
      if(!server){
        if(!task.origin||task.origin==='local'){
          const previous=ops.find(x=>x.id===task.id)||null;
          setDesired(task.id,TaskSync.reconcileOperation(previous,null,task));
        }
        return;
      }
      const previous=ops.find(x=>x.id===task.id)||null;
      let desired=TaskSync.reconcileOperation(previous,server,task);
      const active=this._taskInFlight[task.id]||(previous&&previous.sentAt?previous:null);
      if(!desired)desired=TaskSync.compensatingPatch(active,task);
      setDesired(task.id,desired);
    });
    this._writeTaskOps(ops);
  },
  _mirrorTasks(push){
    localStorage.setItem(LS_KEY(),JSON.stringify(this._tasks));
    if(push!==false&&window.WinSync)WinSync.pushTasks();
    this._notifyTaskPersisted();
  },
  _notifyTaskPersisted(){
    if(!this._taskPersistWaiters.size)return;
    const scope=LS_TASK_OPS(),pending=new Set(this._readTaskOps().map(op=>op.id));
    for(const waiter of this._taskPersistWaiters){
      if(waiter.scope!==scope)waiter.resolve(false);
      else if(!pending.has(waiter.id)&&this._shadow[waiter.id])waiter.resolve(true);
    }
  },
  async _flushTaskFor(id,scope){
    if(!this._readTaskOps().some(op=>op.id===id))return Boolean(this._shadow[id]);
    let resolve;
    const confirmed=new Promise(done=>{resolve=done;});
    const waiter={id,scope,resolve};
    this._taskPersistWaiters.add(waiter);
    try{
      // One background lane plus one bounded interactive lane. Each task stays
      // serial, but a slow unrelated request cannot block an explicit create.
      const flushed=Promise.all([this._flushTaskOps(),this._flushTaskOps(true)]);
      this._notifyTaskPersisted();
      return await Promise.race([flushed,confirmed]);
    }finally{this._taskPersistWaiters.delete(waiter);}
  },
  _scheduleTaskFlush(delay){
    clearTimeout(this._syncT);
    this._syncT=setTimeout(()=>this._flushTaskOps(),Math.max(0,delay==null?250:delay));
  },
  _beginTaskFlight(id,token,scope,kind,data){
    let settle;
    const settled=new Promise(resolve=>{settle=resolve;});
    const flight={token,scope,kind,data,settled,settle};
    this._taskInFlight[id]=flight;
    return flight;
  },
  _finishTaskFlight(id,flight){
    if(this._taskInFlight[id]===flight)delete this._taskInFlight[id];
    flight.settle();
  },
  _failTaskWaiters(id,scope){
    for(const waiter of this._taskPersistWaiters){
      if(waiter.scope===scope&&waiter.id===id)waiter.resolve(false);
    }
  },
  async _drainTaskOps(priorityOnly=false){
    const operationScope=LS_TASK_OPS();
    if(!priorityOnly)clearTimeout(this._taskRetryT);
    while(window.SoduWorkAPI){
      if(operationScope!==LS_TASK_OPS())return false;
      const ops=this._readTaskOps();
      const usable=ops.filter(x=>!x.blocked&&(!this._taskInFlight[x.id]||this._taskInFlight[x.id].scope!==operationScope)&&(!priorityOnly||
        Array.from(this._taskPersistWaiters).some(waiter=>waiter.scope===operationScope&&waiter.id===x.id)));
      if(!usable.length)return true;
      const now=Date.now();
      const ready=usable.filter(x=>!x.notBefore||x.notBefore<=now);
      const op=ready.find(x=>Array.from(this._taskPersistWaiters).some(waiter=>
        waiter.scope===operationScope&&waiter.id===x.id))||ready[0];
      if(!op){
        const nextAt=Math.min.apply(null,usable.map(x=>x.notBefore||now));
        this._scheduleTaskFlush(Math.max(20,nextAt-now));return true;
      }
      const token=op.token;
      const flight=this._beginTaskFlight(op.id,token,operationScope,op.kind,op.data||{});
      /* Persist the sending marker as well: overlay and workspace are separate
         renderer processes sharing the outbox, so an in-memory flag alone
         cannot protect cross-window create/delete races. */
      const marked=this._readTaskOps();
      const markedIndex=marked.findIndex(x=>x.id===op.id&&x.token===token);
      if(markedIndex>=0){marked[markedIndex].sentAt=Date.now();this._writeTaskOps(marked);}
      let canonical=null;
      try{
        if(op.kind==='put')canonical=await SoduWorkAPI.putTask(op.id,op.data||{},operationScope);
        else if(op.kind==='patch')canonical=await SoduWorkAPI.patchTask(op.id,op.data||{},operationScope);
        else await SoduWorkAPI.deleteTask(op.id,operationScope);
      }catch(e){
        if(operationScope!==LS_TASK_OPS()){
          this._finishTaskFlight(op.id,flight);
          return false;
        }
        const msg=String(e&&e.message||e);
        const status=Number(e&&e.status)||Number((msg.match(/^HTTP (\d+)/)||[])[1])||0;
        let latest=this._readTaskOps();
        let i=latest.findIndex(x=>x.id===op.id&&x.token===token);
        if(i>=0)delete latest[i].sentAt;
        /* A direct coworker assignment can cross an older local PUT from another
           renderer. The server-side dispatch row is authoritative: reconcile it
           instead of showing a false “not saved” warning to the creator. */
        if((op.kind==='put'||op.kind==='patch')&&status===409&&
            SoduWorkAPI&&typeof SoduWorkAPI.getTask==='function'){
          try{
            const server=await SoduWorkAPI.getTask(op.id);
            if(operationScope!==LS_TASK_OPS()){
              this._finishTaskFlight(op.id,flight);
              return false;
            }
            if(server&&server.id&&server.readOnly){
              latest=this._readTaskOps();
              i=latest.findIndex(x=>x.id===op.id&&x.token===token);
              if(i>=0)latest.splice(i,1);
              delete this._taskPersistErrors[op.id];
              this._rememberServerTask(server);
              const ti=this._tasks.findIndex(x=>x.id===op.id);
              if(ti>=0)this._tasks[ti]=server;else this._tasks.unshift(server);
              this._writeTaskOps(latest);this._mirrorTasks();
              this._finishTaskFlight(op.id,flight);
              continue;
            }
          }catch(_reconcileError){}
          if(operationScope!==LS_TASK_OPS()){
          this._finishTaskFlight(op.id,flight);
          return false;
        }
          latest=this._readTaskOps();
          i=latest.findIndex(x=>x.id===op.id&&x.token===token);
          if(i>=0)delete latest[i].sentAt;
        }
        this._finishTaskFlight(op.id,flight);
        if(op.kind==='patch'&&status===404){
          if(i>=0)latest.splice(i,1);
          const ti=this._tasks.findIndex(x=>x.id===op.id);if(ti>=0)this._tasks.splice(ti,1);
          this._forgetServerTask(op.id);this._writeTaskOps(latest);this._mirrorTasks();
          continue;
        }
        /* Treat deletion 404 responses as success because the required absent state already holds. */
        if(op.kind==='delete'&&status===404){
          if(i>=0)latest.splice(i,1);
          this._forgetServerTask(op.id);this._writeTaskOps(latest);this._mirrorTasks();
          continue;
        }
        if(op.kind==='delete'&&status>=400&&status<500){
          if(i>=0)latest.splice(i,1);
          this._writeTaskOps(latest);
          const server=this._shadow[op.id];
          if(server&&!this._tasks.some(x=>x.id===op.id))this._tasks.unshift(JSON.parse(JSON.stringify(server)));
          this._taskPersistErrors[op.id]=msg;this._mirrorTasks();
          const label=(server&&server.title)||'这条任务';
          this._reportTaskSyncError(op.id,msg,'“'+label+'”没有删除：它由平台或流程管理');
          continue;
        }
        if(status>=400&&status<500&&i>=0){
          latest[i].blocked=msg;this._writeTaskOps(latest);
          const local=this._tasks.find(x=>x.id===op.id)||this._shadow[op.id];
          this._reportTaskSyncError(op.id,msg,'“'+((local&&local.title)||'这条任务')+'”暂未保存，请检查后再试');
          this._failTaskWaiters(op.id,operationScope);
          return false;
        }
        this._writeTaskOps(latest);
        this._taskRetryT=setTimeout(()=>this._flushTaskOps(),3000);
        this._failTaskWaiters(op.id,operationScope);
        return false;
      }
      if(operationScope!==LS_TASK_OPS()){
        this._finishTaskFlight(op.id,flight);
        return false;
      }
      let transition=canonical&&canonical.statusTransition;
      if(transition){canonical=Object.assign({},canonical);delete canonical.statusTransition;}
      let latest=this._readTaskOps();
      const i=latest.findIndex(x=>x.id===op.id&&x.token===token);
      const unchanged=i>=0;
      if(unchanged)latest.splice(i,1);
      this._writeTaskOps(latest);
      if(op.kind==='delete'){
        this._forgetServerTask(op.id);
        /* DELETE may have crossed an undo.  Reconcile against the now-empty
           server shadow so the newer local intent is replayed as an idempotent PUT. */
        if(!unchanged)this._captureTaskChanges();
      }else if(canonical&&canonical.id){
        canonical=TaskSync.mergeSaveReceipt(this._shadow[op.id],canonical);
        this._rememberServerTask(canonical);
        if(unchanged){
          const ti=this._tasks.findIndex(x=>x.id===op.id);
          if(ti>=0)this._tasks[ti]=canonical;
          // A concurrent Hub snapshot may have hidden the unconfirmed draft.
          // The PUT receipt is now authoritative, so publish its actual row.
          else if(op.kind==='put')this._tasks.unshift(canonical);
        }else this._captureTaskChanges();
      }
      this._mirrorTasks();
      if(unchanged&&transition&&transition.applied===false)
        this._reportTaskSyncError(op.id,transition.code||'status_rejected',
          transition.message||'任务状态没有改变');
      this._finishTaskFlight(op.id,flight);
    }
    return false;
  },
  _hasRunnableTaskOps(priorityOnly=false){
    const now=Date.now(),scope=LS_TASK_OPS();
    return this._readTaskOps().some(op=>!op.blocked&&(!this._taskInFlight[op.id]||this._taskInFlight[op.id].scope!==scope)&&(!op.notBefore||op.notBefore<=now)&&
      (!priorityOnly||Array.from(this._taskPersistWaiters).some(waiter=>waiter.scope===scope&&waiter.id===op.id)));
  },
  _flushTaskOps(priorityOnly=false){
    const lane=priorityOnly?'_taskPriorityFlushPromise':'_taskFlushPromise';
    if(this[lane]){
      /* A save can arrive after the active drain has observed an empty outbox
         but before its promise settles. Waiting for that old promise alone
         strands the new PUT and makes persistTask report a false failure. */
      const active=this[lane];
      return active.then(result=>
        result!==false&&this._hasRunnableTaskOps(priorityOnly)?this._flushTaskOps(priorityOnly):result);
    }
    this[lane]=this._drainTaskOps(priorityOnly).finally(()=>{this[lane]=null;});
    return this[lane];
  },
  persistTask(id){
    const key=LS_TASK_OPS()+'\n'+id;
    if(this._taskPersistJobs.has(key)){
      this._captureTaskChanges();
      const active=this._taskPersistJobs.get(key);
      return active.then(result=>{
        if(key!==LS_TASK_OPS()+'\n'+id)return false;
        return result&&this._readTaskOps().some(op=>op.id===id)?this.persistTask(id):result;
      });
    }
    const job=this._persistTask(id).finally(()=>{if(this._taskPersistJobs.get(key)===job)this._taskPersistJobs.delete(key);});
    this._taskPersistJobs.set(key,job);
    return job;
  },
  async _persistTask(id){
    const operationScope=LS_TASK_OPS();
    const wasConfirmed=Boolean(this._shadow[id]);
    delete this._taskPersistErrors[id];
    const local=this._tasks.find(x=>x&&x.id===id);
    const payload=local&&typeof TaskSync!=='undefined'?TaskSync.taskPayload(local):null;
    this._captureTaskChanges();
    // Only an explicit submission resumes its paused create. Hydration and
    // unrelated saves must leave uncertain drafts available for review.
    const queued=this._readTaskOps();
    const retry=queued.find(op=>op.id===id&&op.kind==='put'&&op.blocked);
    if(retry){delete retry.blocked;this._writeTaskOps(queued);}
    await this._flushTaskFor(id,operationScope);
    if(operationScope!==LS_TASK_OPS())return false;
    // A worker can acquire a retry before this caller resumes. Wait for that
    // task's receipt instead of overwriting its lock with a fallback request.
    while(this._taskInFlight[id]?.scope===operationScope){
      await this._taskInFlight[id].settled;
      if(operationScope!==LS_TASK_OPS())return false;
    }
    let pending=this._readTaskOps().find(x=>x.id===id);
    if(!pending&&this._shadow[id])return true;
    /* localStorage can be full or a late Hub snapshot can replace the visible
       array while a new task is being confirmed. Task creation is an explicit
       user action, so finish it with the same idempotent PUT instead of turning
       a missing outbox row into a misleading failure. */
    if(payload&&(!pending||pending.kind==='put')&&window.SoduWorkAPI&&typeof SoduWorkAPI.putTask==='function'){
      const retryToken=pending&&pending.token, activeToken=retryToken||this._opToken();
      const retryPayload=pending?.kind==='put'?pending.data:payload;
      const flight=this._beginTaskFlight(id,activeToken,operationScope,'put',retryPayload);
      const marked=this._readTaskOps(), sending=marked.find(op=>op.id===id&&op.token===retryToken);
      if(sending){sending.sentAt=Date.now();this._writeTaskOps(marked);}
      try {
        let canonical=null;
        try{
          canonical=await SoduWorkAPI.putTask(id,retryPayload,operationScope);
        }catch(error){
          if(operationScope!==LS_TASK_OPS())return false;
          this._taskPersistErrors[id]=String(error&&error.detail||error&&error.message||error||'');
          const status=Number(error&&error.status)||Number((String(error&&error.message||'').match(/^HTTP (\d+)/)||[])[1])||0;
          // A committed create can lose both PUT receipts. Read this exact id
          // before returning an uncertain draft to its original form.
          if(!wasConfirmed&&!(status>=400&&status<500)&&typeof SoduWorkAPI.getTask==='function'){
            try{canonical=await SoduWorkAPI.getTask(id);}catch(_confirmationError){}
          }
        }
        if(operationScope!==LS_TASK_OPS())return false;
        if(canonical&&canonical.id===id){
          canonical=TaskSync.mergeSaveReceipt(this._shadow[id],canonical);
          delete this._taskPersistErrors[id];
          this._rememberServerTask(canonical);
          const latest=this._readTaskOps().filter(op=>op.id!==id||op.token!==retryToken);
          const newer=latest.find(op=>op.id===id);
          const visible=TaskSync.applyOperations([canonical],newer?[newer]:[])[0];
          const ti=this._tasks.findIndex(x=>x.id===id);
          if(!visible){if(ti>=0)this._tasks.splice(ti,1);}
          else if(ti>=0)this._tasks[ti]=visible;else this._tasks.unshift(visible);
          this._writeTaskOps(latest);
          this._mirrorTasks();
          return true;
        }
      }finally{
        this._finishTaskFlight(id,flight);
        if(operationScope===LS_TASK_OPS()){
          const latest=this._readTaskOps(), own=latest.find(op=>op.id===id&&op.token===retryToken);
          if(own){delete own.sentAt;this._writeTaskOps(latest);}
          // A later edit/delete must run after this receipt, never alongside it.
          if(latest.some(op=>op.id===id&&op.token!==retryToken&&!op.blocked))this._scheduleTaskFlush();
        }
      }
    }
    pending=this._readTaskOps().find(x=>x.id===id);
    if(pending&&pending.blocked&&!this._taskPersistErrors[id]){
      this._taskPersistErrors[id]=String(pending.blocked||'');
    }
    return false;
  },
  taskPersistError(id){return String(this._taskPersistErrors[id]||'')},
  removeTask(id,delay,latest){
    const index=this._tasks.findIndex(x=>x.id===id);if(index<0)return null;
    const task=this._tasks[index],current=latest&&latest.id===id?latest:task;
    if(!hasTaskDeletePermission(current)||current.maintenanceBlocked===true){
      if(typeof petSay==='function')petSay(current.maintenanceBlockReason||'当前没有删除权限，请刷新需求后重试');
      return null;
    }
    if(latest&&latest.id===id)this._rememberServerTask(latest);
    delete this._taskPersistErrors[id];this._tasks.splice(index,1);
    this._mergeTaskOperation({id,kind:'delete',notBefore:Date.now()+Math.max(0,delay||0)});
    this._mirrorTasks();this._scheduleTaskFlush(delay||0);return{task,index};
  },
  restoreTask(task,index){
    if(!task||!task.id)return false;
    let ops=this._readTaskOps();const oi=ops.findIndex(x=>x.id===task.id);
    let cancelledDelete=false;
    if(oi>=0&&ops[oi].kind==='delete'){
      cancelledDelete=true;ops.splice(oi,1);this._writeTaskOps(ops);
    }
    if(!this._tasks.some(x=>x.id===task.id))this._tasks.splice(Math.min(index||0,this._tasks.length),0,task);
    /* The DELETE may already be in flight although the shadow still exists.
       A replayable PUT is harmless before deletion and restores it afterwards. */
    if(cancelledDelete||!this._shadow[task.id]){
      this._mergeTaskOperation({id:task.id,kind:'put',data:TaskSync.taskPayload(task),restore:true});
    }
    this._mirrorTasks();this._scheduleTaskFlush();return true;
  },
  dropTask(id){
    const i=this._tasks.findIndex(x=>x.id===id);if(i>=0)this._tasks.splice(i,1);
    this._writeTaskOps(this._readTaskOps().filter(x=>x.id!==id));this._forgetServerTask(id);
    this._mirrorTasks();return i>=0;
  },
  pauseUnconfirmedTask(id){
    const ops=this._readTaskOps(),op=ops.find(row=>row.id===id);
    if(op&&op.kind==='put'){
      op.blocked=op.blocked||'需求创建尚未确认，请在原表单中重试';
      this._writeTaskOps(ops);
    }
    // Transport failure says nothing about remote existence. Hide only the
    // local optimistic row; never manufacture a DELETE or forget Hub truth.
    const i=this._tasks.findIndex(task=>task.id===id);
    if(i>=0&&!this._shadow[id])this._tasks.splice(i,1);
    this._mirrorTasks();
  },
  /*
   * Use this cleanup only when explicitly abandoning creation; 404 is success. Network
   * failure leaves creation uncertain, so pauseUnconfirmedTask must preserve the original ID
   * for retry.
   */
  discardUnconfirmedTask(id){
    const i=this._tasks.findIndex(x=>x.id===id);if(i>=0)this._tasks.splice(i,1);
    const ops=this._readTaskOps().filter(x=>x.id!==id);
    ops.push({id,kind:'delete',token:this._opToken(),at:Date.now()});
    this._writeTaskOps(ops);this._forgetServerTask(id);this._mirrorTasks();this._scheduleTaskFlush(0);
    return i>=0;
  },
  /*
   * Persist the local mirror and field changes as per-task commands. Delete only through
   * removeTask; missing array entries must not delete newer server tasks.
   */
  save(){
    if(this._initializing)return;
    this._mirrorTasks();this._captureTaskChanges();this._scheduleTaskFlush();
  },
  acceptTaskSave(receipt){
    if(!receipt?.id)return null;
    const canonical=TaskSync.mergeSaveReceipt(this._shadow[receipt.id],receipt);
    delete canonical.statusTransition;
    this.applyServerEvent({type:'task.updated',task:canonical,__fromWindow:true,saveReceipt:true});
    return canonical;
  },
  /* Merge WebSocket and integration events into local state without echoing them back to the server. */
  applyServerEvent(ev){
    if(!ev||!ev.type)return;
    if((ev.type==='task.created'||ev.type==='task.updated')&&ev.task?.projectionPending){
      const canonical=TaskSync.mergeSaveReceipt(this._shadow[ev.task.id],ev.task);
      delete canonical.statusTransition;
      ev=Object.assign({},ev,{task:canonical,saveReceipt:true});
    }
    /* Remote configuration, notification, and command channel. */
    if(ev.type==='plugins.policy'){
      try{window.dispatchEvent(new CustomEvent('soduwork-plugin-policy',{detail:ev}));}catch(e){}
      return;
    }
    if(ev.type==='config.patch'){this._applyConfigPatch(ev.patch);return;}
    if(ev.type==='notice'){
      // An administrator may restore the account allowance through a system
      // notification while this conversation is still open. Clear the stale
      // card immediately and reconcile the authoritative quota in background.
      try {
        const body = [ev.text, ev.bodyText, ev.message, ev.title].filter(Boolean).join(' ');
        const userId = String(window.SoduWorkAPI?.clientAuthSnapshot?.().user?.id || '');
        const recipientId = String(ev.recipientId || '');
        // A private notice for another member must never change this account's
        // composer state. System notices without a recipient remain eligible.
        if (!recipientId || !userId || recipientId === userId) {
          const restored = /(?:额度|配额|quota|allowance).*(?:恢复|已恢复|restor(?:e|ed|ation)|renew|replenish)|(?:恢复|restor(?:e|ed|ation)|renew|replenish).*(?:额度|配额|quota|allowance)/i.test(body);
          const notice = window.SoduWorkQuotaNotice;
          let refresh = restored ? notice?.markRestored?.() : notice?.refreshIfBlocked?.();
          if (restored && refresh === false) refresh = notice?.refreshIfBlocked?.();
          if (refresh && typeof refresh.catch === 'function') refresh.catch(() => {});
        }
      } catch (_) {}
      // Automation runs are ordinary conversations.  Ignore delayed notices
      // emitted by the retired task/workflow route so AI execution cannot be
      // presented as the automation's execution state.
      if(ev.automation===true)return;
      // Use the same identity boundary for inbox validation and presentation; identity-free legacy events only trigger authenticated inbox synchronization.
      const personal=ev.serverMessageId||ev.senderId||ev.recipientId||['mate_message','task_assignment'].includes(ev.kind);
      if(personal&&!window.MateNoticeSync?.canPresent(ev)){
        if(window.MateNoticeSync)void MateNoticeSync.handle(ev).catch(()=>{});
        return;
      }
      if(ev.serverMessageId&&window.MateNoticeSync){
        void MateNoticeSync.present(ev).then(notice=>{
          if(!notice?.isCurrent())return;
          if(typeof petSay==='function')petSay(notice.text,5000,{taskId:notice.taskId});
          this._alertIncoming();
        }).catch(()=>{});
        return;
      }
      if(ev.text&&typeof logNotice==='function'&&logNotice(ev.text,ev.taskId,ev.kind||'notice',ev)){
        if(typeof petSay==='function')petSay(ev.text,5000,{taskId:ev.taskId});
        this._alertIncoming();
      }
      return;
    }
    if(/^mate_message_(accepted|delivered|read)$/.test(ev.type)){
      if(window.MateNoticeSync)void MateNoticeSync.present(ev).then(notice=>{if(notice?.isCurrent())this._alertIncoming();}).catch(()=>{});
      return;
    }
    if(ev.type==='command'){ this._applyCommand(ev.action,ev.payload); return; }
    if(ev.type==='task.comment'){
      window.dispatchEvent(new CustomEvent('soduwork-requirement-comment', {detail:ev.comment}));
      return;
    }
    /*
     * Keep high-frequency execution events separate from task cards and localStorage. Emit
     * window events for lightweight summaries while consoles consume incremental content.
     */
    if(ev.type==='execution.updated'){
      try{window.dispatchEvent(new CustomEvent('soduwork-work-execution',{detail:ev}));}catch(e){}
      return;
    }
    /* Task events. */
    const relayTaskEvent=!ev.__fromWindow && (ev.type==='task.created'||ev.type==='task.updated');
    const arr=this._tasks;
    let incomingDetail=null;
    let eventTaskId='';
    let eventArrival='';
    let eventBy='';
    if(ev.type==='task.created'||ev.type==='task.updated'){
      if(!ev.task||!ev.task.id)return;
      const rawTask=ev.task;
      eventTaskId=String(rawTask.id);
      /* Scheduled automation keeps a Task row for traces and artifacts, but
         it is not a user requirement.  The Hub list already omits it; ignore
         late WS events too so an old desktop cannot reinsert it into the pool. */
      if(String(rawTask.origin||'')==='automation' || String(rawTask.source||'')==='定时派活'){
        const i=arr.findIndex(x=>String(x&&x.id||'')===eventTaskId);
        if(i>=0){arr.splice(i,1);this._mirrorTasks();
          if(typeof renderSoon==='function')renderSoon();else if(typeof render==='function')render();}
        this._forgetServerTask(eventTaskId);
        return;
      }
      const previous=arr.find(x=>String(x&&x.id||'')===eventTaskId)||null;
      if(rawTask.readOnly){
        const pending=this._readTaskOps();
        if(pending.some(x=>x.id===eventTaskId)){
          this._writeTaskOps(pending.filter(x=>x.id!==eventTaskId||(x.kind==='delete'&&hasTaskDeletePermission(rawTask))));
        }
        delete this._taskPersistErrors[eventTaskId];
      }
      this._rememberServerTask(rawTask);
      const pending=this._readTaskOps().find(x=>x.id===eventTaskId);
      const visible=TaskSync.applyOperations([rawTask],pending?[pending]:[])[0];
      const i=arr.findIndex(x=>String(x&&x.id||'')===eventTaskId);
      if(!visible){if(i>=0)arr.splice(i,1);}
      else if(i>=0)arr[i]=visible;
      else arr.unshift(visible);
      /*
       * Read-only state does not identify a delegator. Notify only creators or requesters
       * confirmed by the current Hub event, once per task state; skip initial hydration without
       * a local predecessor.
       */
      const handoffRoles=Array.isArray(rawTask.myRoles)?rawTask.myRoles:[];
      const tracksHandoff=handoffRoles.includes('creator')||handoffRoles.includes('requester');
      if(visible&&visible.readOnly&&previous&&tracksHandoff){
        const st=v=>String(v||'').trim().toLowerCase();
        const prevSt=st(previous.status),nextSt=st(visible.status);
        const done=v=>/done|complete|deliver/.test(v);
        const bad=v=>/fail|error|unreach|blocked|incomplete|abort/.test(v);
        const live=v=>/doing|running|active|claim|progress/.test(v);
        const handoffKind=done(nextSt)?'handoff.done':bad(nextSt)?'handoff.failed'
          :live(nextSt)&&!live(prevSt)?'handoff.started':'';
        const wasSettled=done(prevSt)||bad(prevSt);
        if(handoffKind&&!wasSettled&&nextSt!==prevSt){
          // Use server timestamps to distinguish reruns and stable event IDs to deduplicate across windows and reconnects.
          const revision=(done(nextSt)||bad(nextSt)?rawTask.actualEnd:rawTask.actualStart)||rawTask.updatedAt||'';
          const noticeEventId='handoff:'+JSON.stringify([eventTaskId,handoffKind,nextSt,revision]);
          const hTitle=String(visible.title||'需求');
          const hText=handoffKind==='handoff.done'?'你转出的「'+hTitle+'」已完成，点击查看结果'
            :handoffKind==='handoff.failed'?'你转出的「'+hTitle+'」执行失败，点击查看详情'
            :'「'+hTitle+'」已开始执行';
          if(typeof logNotice==='function'&&logNotice(hText,eventTaskId,handoffKind,{noticeEventId,taskId:eventTaskId,status:nextSt})){
            if(typeof petSay==='function')petSay(hText,6000,{taskId:eventTaskId});
            this._alertIncoming();
          }
        }
      }
      eventArrival=String(ev.arrival||'').trim().slice(0,24);
      eventBy=String(ev.by||'').trim().slice(0,120);
      const roles=visible&&Array.isArray(visible.myRoles)?visible.myRoles:[];
      /* compatibility: incomingActionable=incoming&&!incoming.readOnly */
      const incomingRoles=roles;
      const incomingActionable=Boolean(visible&&!visible.readOnly&&
        (!incomingRoles.length||incomingRoles.includes('executor')||incomingRoles.includes('assignee')));
      const actionable=incomingActionable;
      const owner=String(visible&&(visible.ownerClientId||visible.owner_client_id)||'');
      const oldOwner=String(previous&&(previous.ownerClientId||previous.owner_client_id)||'');
      const isIncoming=actionable&&eventArrival&&eventArrival!=='self'&&
        (ev.type==='task.created'||Boolean(eventArrival)||!previous||previous.readOnly||oldOwner!==owner);
      if(isIncoming){
        const key=eventTaskId+'|'+eventArrival+'|'+owner;
        const now=Date.now();
        const last=Number(this._incomingSeen[key]||0);
        if(now-last>60000){
          this._incomingSeen[key]=now;
          // Assignment updates the requirement and its notification; only an explicit user action opens a conversation.
          incomingDetail={type:ev.type,taskId:eventTaskId,task:Object.assign({},visible),
            arrival:eventArrival,by:eventBy,actionable:true,autoOpen:false};
        }
      }
    }else if(ev.type==='task.deleted'){
      eventTaskId=String(ev.id||'');
      const pending=this._readTaskOps();
      const restoring=pending.some(x=>x.id===ev.id&&x.kind==='put');
      this._writeTaskOps(pending.filter(x=>x.id!==ev.id||x.kind==='put'));
      this._forgetServerTask(ev.id);
      if(restoring){this._mirrorTasks();this._scheduleTaskFlush(0);return;}
      const i=arr.findIndex(x=>String(x&&x.id||'')===eventTaskId);
      if(i<0)return;arr.splice(i,1);
    }else return;
    this._mirrorTasks();
    /* Cross-renderer relay: preserve arrival semantics without echoing the event back. */
    if(relayTaskEvent&&window.WinSync&&typeof WinSync.pushTaskEvent==='function')
      WinSync.pushTaskEvent({type:ev.type,task:ev.task,arrival:ev.arrival||'',by:ev.by||'',autoOpen:false,notificationId:ev.notificationId||''});
    try{window.dispatchEvent(new CustomEvent('soduwork-work-task-change',{detail:{
      type:ev.type,taskId:eventTaskId,task:incomingDetail&&incomingDetail.task||null,
      incoming:Boolean(incomingDetail),actionable:Boolean(incomingDetail),
      arrival:eventArrival,by:eventBy,autoOpen:incomingDetail?incomingDetail.autoOpen:false,
    }}));}catch(e){}
    if(ev.type==='task.updated'&&!ev.saveReceipt&&typeof refreshOpenDetail==='function')refreshOpenDetail(ev.task.id);
    if(typeof renderSoon==='function')renderSoon();
    else if(typeof render==='function')render();
    if(typeof updatePet==='function')updatePet();
    if(typeof _syncSidebar==='function')_syncSidebar();
    // When a persistent message exists, task events update requirement state only; the message owns the notification to avoid duplicate alerts.
    if(incomingDetail&&!ev.__fromWindow&&!ev.notificationId){
      this._alertIncoming();
      if(typeof petSay==='function'){
        const nm='\u300c'+(incomingDetail.task.title||'')+'\u300d';
        const who=incomingDetail.by||incomingDetail.task.createdByName||'';
        const msg=incomingDetail.arrival==='assign'
          ? (who?who+' \u5206\u7ed9\u4f60 ':'\u5206\u7ed9\u4f60 ')+nm
          : (who?who+' \u6d3e\u6765 ':'\u6536\u5230\u65b0\u4efb\u52a1')+nm;
        if(typeof logNotice==='function')logNotice(msg,incomingDetail.taskId,'task');
        petSay(msg,3600,{taskId:incomingDetail.taskId});
      }
    }
  },
  _alertIncoming(){
    if(typeof petReact==='function')petReact('shake');
    if(typeof playOpenBox==='function')playOpenBox();
  },
  /* Remote commands. */
  _applyCommand(action,payload){
    if(action==='reload'){ if(typeof petSay==='function')petSay('管理员触发了刷新～'); setTimeout(()=>location.reload(),400); }
    else if(action==='toggle-tasks'){ if(typeof _toggleTasks==='function')_toggleTasks(); }
    /* Route settings through Entry into the workspace so the desktop overlay retains its stacking behavior. */
    else if(action==='open-settings'){ if(typeof openSettingsEntry==='function')openSettingsEntry(); }
    else if(action==='set-skin'){ if(payload&&payload.skinId&&typeof applySkin==='function')applySkin(payload.skinId); }
    else if(action==='apply-update'){ if(typeof _otaUpdate==='function')_otaUpdate(); }
  }
};
SoduWorkStoreLifecycle.install(Store,{
  shadowKey:LS_TASK_SHADOW,
  configEffects:(patch,previous)=>{
    const skinChanged=['character','theme','tube','_lastSkinId'].some(key=>key in patch)&&typeof refreshSkinAppearance==='function';
    if(skinChanged)refreshSkinAppearance(previous?._lastSkinId);
    else if(typeof applyTheme==='function')applyTheme();
    if(typeof applyRemind==='function')applyRemind();
    if(patch.uiScale&&typeof applyScale==='function')applyScale(patch.uiScale);
    if(!skinChanged){if(typeof render==='function')render();if(typeof updatePet==='function')updatePet();}
  },
  syncBindings:()=>{tasks=Store.tasks;cfg=Store.cfg;},
  scopeChanged:()=>{
    Store._taskInFlight=Object.create(null);Store._taskPersistErrors=Object.create(null);
    const next=_readNotices();notices.length=0;Array.prototype.push.apply(notices,next);
    if(typeof updateNoticeBadge==='function')updateNoticeBadge();
    if(typeof _renderNoticePanel==='function'){const panel=document.getElementById('noticePanel');if(panel&&panel.classList.contains('show'))_renderNoticePanel();}
  },
  render:()=>{
    if(typeof renderSoon==='function')renderSoon();else if(typeof render==='function')render();
    if(typeof _renderHistoryBoard==='function')_renderHistoryBoard();
  },
  recovered:()=>{if(typeof _otaUpdate==='function')void _otaUpdate(true);},
});

/* The renderer only triggers full-client updates; the main process owns Hub selection, validation, and execution. */
async function _otaUpdate(silent){
  if(!window.soduWorkAPI||!soduWorkAPI.checkClientUpdate){
    if(!silent&&typeof petSay==='function')petSay('当前版本需要手动安装新版后才能在线升级');return;
  }
  try{
    const r=await soduWorkAPI.checkClientUpdate({interactive:!silent});
    if(!silent&&r&&r.state==='current'&&typeof petSay==='function')petSay('已经是最新版本～');
    else if(!silent&&r&&r.state==='failed'&&typeof petSay==='function')petSay('更新失败：'+(r.error||'未知'));
    else if(!silent&&r&&r.state==='manual'&&typeof petSay==='function')petSay(r.error||'需要手动安装新版');
  }catch(e){ if(!silent&&typeof petSay==='function')petSay('更新出错：'+(e.message||e)); }
}
/* Expose shared tasks and cfg bindings used directly by renderer components. */
let tasks=Store.tasks;
let cfg=Store.cfg;
/*
 * Resolve shared DOM references after their elements have been parsed before these body
 * scripts.
 */
let pet=document.getElementById('pet');
const save=()=>Store.save();
const saveCfg=()=>Store.saveCfg();

/*
 * Centralize task status changes and timeline entries here. Empty text records a status
 * transition without progress-report content. Return whether state changed so callers can
 * decide to persist and render.
 */
function markStatus(t, ns, text) {
  if (!t || !ns) return false;
  if (typeof isTaskReadOnly === 'function' && isTaskReadOnly(t)) {
    if (typeof petSay === 'function') petSay('这是你参与跟踪的任务，执行状态由承办人更新');
    return false;
  }
  const txt = (text || '').trim();
  if (t.status === ns && !txt) return false;
  const prev = t.status;
  t.status = ns;
  /* Stamp actual start and completion times on status changes only when unset.
   Preserve manually entered values and match the backend stamp_actual rule. */
  if (prev !== ns) {
    const now = Date.now();
    if (ns === 'doing' && !t.actualStart) t.actualStart = now;
    else if (ns === 'done') { if (!t.actualStart) t.actualStart = t.start || now; if (!t.actualEnd) t.actualEnd = now; }
  }
  t.progress = t.progress || [];
  t.progress.push({ at: Date.now(), status: ns, text: txt });
  return true;
}

/* Use the latest done progress entry as completion time; missing entries represent historical completion.
   The active set contains unfinished tasks and tasks completed today. Older completions remain in task history. */
function taskDoneAt(t){
  if(!t||t.status!=='done')return null;
  let at=null;
  (t.progress||[]).forEach(p=>{ if(p&&p.status==='done'&&p.at)at=p.at; });
  return at;   // Treat a missing legacy completion timestamp as historical completion.
}
function isMyActionableTask(t){
  if(!t)return false;
  const roles=Array.isArray(t.myRoles)?t.myRoles:[];
  if(roles.length)return roles.includes('executor')||roles.includes('assignee');
  return !t.readOnly;
}
function isActiveTask(t){
  if(!isMyActionableTask(t))return false;
  if(t.status!=='done')return true;
  const at=taskDoneAt(t);
  if(!at)return false;
  const d0=new Date();d0.setHours(0,0,0,0);
  return at>=d0.getTime();
}
function activeTasks(){ return tasks.filter(isActiveTask); }

/* Retain remote history and the latest 100 local transient notifications. */
const LS_NOTICES=()=>_taskStorageKey('notices','soduwork_work_notices_v1');
function _readNotices(){
  try{
    const key=LS_NOTICES();let raw=localStorage.getItem(key);
    if(raw===null){
      // Older API versions routed the unknown "notices" kind to the task key.
      // Only this exact identity's collided cache is eligible for recovery.
      // Leave its source intact; Hub hydration remains the authority for tasks.
      const previous=LS_KEY();
      if(previous!==key&&previous.split('@').length===4){
        const legacy=JSON.parse(localStorage.getItem(previous)||'[]');
        const recovered=Array.isArray(legacy)?legacy.filter(row=>row&&
          /^(?:ntc_|mate_)/.test(String(row.id||''))&&typeof row.text==='string'&&
          typeof row.read==='boolean'&&Number.isFinite(row.at)&&row.at>0&&
          !Object.prototype.hasOwnProperty.call(row,'title')&&!Object.prototype.hasOwnProperty.call(row,'note')):[];
        if(recovered.length){raw=JSON.stringify(recovered);localStorage.setItem(key,raw);}
      }
    }
    const rows=JSON.parse(raw||'[]'),local=Array.isArray(rows)?rows:[];
    return window.MateNoticeSync?.cachedRows?.(key,local)||local;
  }catch(e){return[]}
}
let notices=_readNotices();
/*
 * Persist notifications and broadcast invalidation so read state, badges, and open
 * notification lists stay synchronized across windows.
 */
function _saveNotices(){try{
    const key=LS_NOTICES(),rows=window.MateNoticeSync?.ready?.(key)?notices.filter(row=>!row.serverMessageId):notices;
    localStorage.setItem(key,JSON.stringify(rows));
  }catch(e){return false;}
  if(window.WinSync)WinSync.pushNotices();return true;}
function logNotice(text,taskId,kind,extra){
  if(!text)return false;
  const eventId=extra&&extra.noticeEventId?String(extra.noticeEventId):extra&&extra.messageId ? 'mate_'+String(extra.messageId).slice(0,64) : '';
  // Deduplicate against current-account persisted records because another window may have written before WinSync arrives.
  const latest=_readNotices();notices.length=0;for(const row of latest)notices.push(row);
  if(eventId&&notices.some(n=>n.id===eventId))return false;
  if(eventId&&window.MateNoticeSync?.dismissedId?.(eventId))return false;
  try{if(eventId&&JSON.parse(localStorage.getItem(LS_NOTICES()+':sync')||'{}').ids?.includes(eventId))return false;}catch(_){}
  const files=(Array.isArray(extra&&extra.attachments)?extra.attachments:[]).slice(0,20)
    .filter(f=>f&&f.id&&f.name).map(f=>({id:String(f.id),name:String(f.name),size:Number(f.size)||0}));
  const at=Date.now();
  notices.unshift({attachments:files,id:eventId||'ntc_'+at.toString(36)+'_'+Math.random().toString(36).slice(2,8),
    serverMessageId:extra&&extra.serverMessageId?String(extra.serverMessageId):'', messageId:extra&&extra.messageId?String(extra.messageId):'',
    senderId:extra&&extra.senderId?String(extra.senderId):'', senderName:extra&&extra.senderName?String(extra.senderName):'', recipientId:String(extra&&extra.recipientId||''),
    website:extra&&extra.website&&typeof extra.website==='object'?extra.website:null,
    ...(kind==='legal_update'&&['terms','privacy'].includes(extra?.legalUpdate?.kind)&&extra.legalUpdate.revisionId
      ? {legalUpdate:{kind:extra.legalUpdate.kind,revisionId:String(extra.legalUpdate.revisionId),action:extra.legalUpdate.action==='accept'?'accept':'notice'}} : {}),
    at,text:String(text),taskId:taskId||null,kind:kind||'notice',read:false});
  // Remote rows are durable inbox/outbox records; trim only local transient notices.
  let localCount=0;const kept=notices.filter(n=>n.serverMessageId||++localCount<=100);
  notices.length=0;for(const row of kept)notices.push(row);
  if(_saveNotices()===false)return false;
  if(typeof updateNoticeBadge==='function')updateNoticeBadge();
  return true;
}
function noticeUnread(){let n=0;const rows=window.MateNoticeSync?MateNoticeSync.rows('received'):notices;
  for(const x of rows)if(x.folder!=='sent'&&!x.read)n++;return n}
function markMateNoticeRead(messageId, readAt){
  if(globalThis.MateNoticeSync?.persistent)return MateNoticeSync.confirmedRead(messageId,readAt);
  const key=String(messageId||''); if(!key)return false; let changed=false;
  notices.forEach(n=>{
    /* The recipient knows the server row id from the notification payload,
       while the sender receipt may only carry the client id. Accept both
       identifiers so clicking a persisted remote row also clears the local
       badge immediately. */
    if(n.folder!=='sent'&&n.kind!=='mate_receipt'&&(String(n.messageId||'')===key || String(n.serverMessageId||'')===key ||
       String(n.id||'')==='mate_'+key.slice(0,64))){
      n.read=true; n.readAt=readAt||Date.now(); n.status='read'; changed=true;
    }
  });
  if(changed){_saveNotices();if(typeof updateNoticeBadge==='function')updateNoticeBadge();} return changed;
}
function markNoticeRead(ref){
  const key=String(ref==null?'':ref);
  const n=notices.find((x,i)=>String(x.id||x.at||i)===key);
  if(!n||n.read)return false;
  if(n.kind==='mate_receipt'&&window.MateNoticeSync)return MateNoticeSync.markLocalRead(n.id);
  n.read=true;_saveNotices();
  if(typeof updateNoticeBadge==='function')updateNoticeBadge();
  return true;
}

function clearNotices(){if(window.MateNoticeSync)return MateNoticeSync.clear();
  notices.length=0;_saveNotices();if(typeof updateNoticeBadge==='function')updateNoticeBadge();}

/* Recurring scheduled tasks. */
/* Calculate the next daily, weekly, or monthly due time from from; return null for nonrecurring tasks. */
function _nextRecurAt(recur, from){
  const d=new Date(from||Date.now());
  if(recur==='daily')d.setDate(d.getDate()+1);
  else if(recur==='weekly')d.setDate(d.getDate()+7);
  else if(recur==='monthly')d.setMonth(d.getMonth()+1);
  else return null;
  return d.getTime();
}
/* Every 60 seconds, reset completed recurring tasks when due and trigger pending reminders. */
function _tickRecur(){
  if(typeof tasks==='undefined'||!Array.isArray(tasks))return;
  const now=Date.now(); let changed=false;
  tasks.filter(t=>t&&!t.readOnly&&!t.archivedAt&&t.status!=='cancel'&&(!Array.isArray(t.myRoles)||t.myRoles.some(role=>role==='executor'||role==='assignee'))).forEach(t=>{
    if(t&&t.recur&&t.status==='done'&&t.recurAt&&now>=t.recurAt){
      t.status='todo';
      t.recurAt=_nextRecurAt(t.recur, now);
      changed=true;
      if(typeof logNotice==='function')logNotice('↻ 循环任务「'+(t.title||'')+'」又到啦，已回到待办',t.id,'recur');
      if(typeof petSay==='function')petSay('「'+(t.title||'')+'」又到啦，该处理咯~',4200);
    }
    /* Alert when an unfinished task reaches its reminder time and has not already notified. */
    if(t&&t.remindAt&&!t.reminded&&t.status!=='done'&&now>=t.remindAt){
      t.reminded=true; changed=true;
      _fireReminder(t);
    }
  });
  if(changed){ save(); if(typeof render==='function')render(); if(typeof updatePet==='function')updatePet(); }
}
/*
 * Task reminders combine an eight-second bubble, repeated chimes, and a 1.1-second shake.
 * Schedule shaking after updatePet clears animation classes.
 */
function _fireReminder(t){
  if(typeof logNotice==='function')logNotice('⏰ 提醒：「'+(t.title||'')+'」到点了！',t.id,'remind');
  if(typeof petSay==='function')petSay('⏰ 提醒：「'+(t.title||'')+'」到点了！',8000);
  if(typeof playRemindChime==='function')playRemindChime();
  setTimeout(()=>{
    const p=document.getElementById('pet');
    if(p){ p.classList.remove('remind-shake'); void p.offsetWidth; p.classList.add('remind-shake');
      setTimeout(()=>p.classList.remove('remind-shake'),1200); }
  },50);
}
/*
 * Set data-skin from registry material to theme task views, dock, bubbles, and pet. Fall
 * back to character-derived material when skin metadata is unavailable.
 */
const applyTheme=()=>{
  const el=document.documentElement;
  if(typeof SkinRegistry!=='undefined' && SkinRegistry.migrateDefaultLogo?.(cfg)){
    saveCfg();
  }
  /* Retire the removed bunny skin without leaving existing installations in a dead state. */
  if(cfg._lastSkinId==='bunny-cream' || (cfg.character==='bunny' && !cfg._lastSkinId)){
    cfg.character='bear'; cfg.theme='vivid'; cfg.tube='glass'; cfg._lastSkinId='bear-vivid';
    if(typeof saveCfg==='function'){ try{ saveCfg(); }catch(e){} }
  }
  /*
   * Migrate retired flatcube configurations to the matching glass orb while preserving other
   * settings.
   */
  if(cfg.character==='flatcube'){ cfg.character='bear'; if(typeof saveCfg==='function'){ try{ saveCfg(); }catch(e){} } }
  el.setAttribute('data-theme',cfg.theme||'vivid');
  el.setAttribute('data-tube',cfg.tube||'glass');
  /*
   * Expose the character on the root so material styles can apply character-specific
   * overrides.
   */
  el.setAttribute('data-character',cfg.character||'bear');
  let mat='';
  try{
    if(typeof SkinRegistry!=='undefined'){
      const id=(typeof currentSkinId==='function')?currentSkinId():cfg._lastSkinId;
      const s=id&&SkinRegistry.getSkin(id);
      mat=(s&&s.material)||'';
    }
  }catch(e){}
  el.setAttribute('data-skin', mat || (cfg.character==='box'?'box':'glass'));
  /* Native consent has its own isolated renderer. Report only presentation
     tokens after the application theme is applied; main validates this window
     and never executes code in it or receives an authorization decision here. */
  if(window.soduWorkAPI?.reportTheme){
    const styles=getComputedStyle(el),tokens={};
    for(const key of ['--bg-0','--bg-1','--bg-2','--bg-3','--ink','--ink-2','--ink-3','--ink-4',
      '--line','--line-2','--line-3','--accent','--accent-hover','--accent-soft','--accent-soft-2','--font-ui','--font-display']){
      tokens[key]=styles.getPropertyValue(key).trim();
    }
    window.soduWorkAPI.reportTheme({theme:el.dataset.theme,skin:el.dataset.skin,character:el.dataset.character,tokens});
  }
};
/* Apply reminder glows to unfinished task markers and the pet according to cfg.remind. */
const applyRemind=()=>{
  const level=cfg.remind||'light';
  /* Clear previous glow classes. */
  document.querySelectorAll('.ball .remind').forEach(el=>{
    el.classList.remove('light','strong');
    if(level==='off')el.style.display='none';
    else el.style.display='';
  });
  if(level==='off')return;
  /* Highlight active task markers. */
  document.querySelectorAll('.ball.st-doing .remind,.ball.st-todo .remind').forEach(el=>{
    el.classList.add(level);
  });
  /* Apply the pet reminder glow. */
  const pet=document.getElementById('pet');
  if(pet){
    pet.classList.remove('remind-light','remind-strong');
    const hasDoing=tasks.some(t=>t.status==='doing');
    if(hasDoing)pet.classList.add(level==='strong'?'remind-strong':'remind-light');
  }
};
/* Toggle shape-square on task markers according to cfg.shape. */
const applyShape=()=>{
  const shape=cfg.shape||'ball';
  document.querySelectorAll('.ball').forEach(el=>{
    el.classList.toggle('shape-square',shape==='square');
  });
};
let detailId=null;
