'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const {assertNoLinks}=require('../plugin-resources');
const LABELS={dingtalk:'钉钉',wecom:'企业微信',feishu:'飞书'};
const installs=new Map();
const stoppedChildren=new WeakSet();
const nodeRuntime=require('../node-runtime.cjs');
function provider(key){if(!Object.hasOwn(LABELS,key))throw Error('不支持的平台');return{...JSON.parse(fs.readFileSync(path.join(__dirname,'providers',key,'upstream-lock.json'),'utf8')),label:LABELS[key]};}
function base(app){return path.join(app.getPath('userData'),'platform-connections');}
function inside(root,target){const r=path.relative(path.resolve(root),path.resolve(target));return !r||!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r);}
function privateDir(root,target){if(!inside(root,target))throw Error('连接目录越界');assertNoLinks(root,target);fs.mkdirSync(target,{recursive:true,mode:0o700});assertNoLinks(root,target);if(!inside(fs.realpathSync(root),fs.realpathSync(target)))throw Error('连接目录不能指向外部位置');return target;}
function paths(app,key,scope){const p=provider(key),root=base(app);assertNoLinks(app.getPath('userData'),root);fs.mkdirSync(root,{recursive:true,mode:0o700});if(scope&&!/^[a-f0-9]{32}$/.test(scope))throw Error('连接账号目录无效');const prefix=privateDir(root,path.join(root,'tools',key,p.version));const account=scope?privateDir(root,path.join(root,'accounts',scope,key)):'';return{root,prefix,account,provider:p};}
// External Node/Python cannot read Electron ASAR paths. Materialize only reviewed
// launcher files into an immutable directory outside the application archive.
function entry(app,key){
 const p=paths(app,key),source=path.join(__dirname,'providers',key);
 const names=['upstream-lock.json','scripts/runtime.mjs'];
 if(key==='dingtalk')names.push('scripts/prepare-dingtalk.py');
 const files=names.map(name=>({name,data:fs.readFileSync(path.join(source,name))}));
 const hash=crypto.createHash('sha256');for(const file of files)hash.update(file.name).update(file.data);
 const root=privateDir(p.root,path.join(p.root,'adapters',key,hash.digest('hex')));
 for(const file of files){
  const target=path.join(root,file.name);assertNoLinks(root,target);
  if(path.dirname(target)!==root)privateDir(root,path.dirname(target));
  try{fs.writeFileSync(target,file.data,{flag:'wx',mode:0o600})}
  catch(error){if(error.code!=='EEXIST')throw error;assertNoLinks(root,target);if(!fs.readFileSync(target).equals(file.data))throw Error('连接启动文件已被修改，请检查本机运行环境');}
 }
 return path.join(root,'scripts/runtime.mjs');
}
async function adapter(key){provider(key);return import(pathToFileURL(path.join(__dirname,'providers',key,'scripts/runtime.mjs')).href);}
function node(){return nodeRuntime.resolve().node;}
function env(selected=nodeRuntime.resolve()){const next={...selected.env};for(const k of ['NODE_OPTIONS','SODUWORK_PROXY_KEY','SODUWORK_MCP_KEY','SODUWORK_MCP_SERVERS','SODUWORK_MCP_SERVERS_JSON','APP_ID','APP_SECRET','USER_ACCESS_TOKEN'])delete next[k];return next;}
function stop(child){
 if(!child||!child.pid||child.exitCode!==null||child.signalCode!=null||stoppedChildren.has(child))return true;
 if(process.platform==='win32'){
  const result=spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:5000});
  // taskkill completes before Node can deliver the child's exit event. Remember
  // only a confirmed successful tree termination so repeated cleanup is safe.
  if(result.status===0){stoppedChildren.add(child);return true;}
  return child.exitCode!==null;
 }
 const killed = child.kill('SIGTERM');
 if(killed) stoppedChildren.add(child);
 return killed || child.exitCode!==null;
}
function execute(command,args,options={}){let child;const completion=new Promise((resolve,reject)=>{let output='',error='',settled=false;child=spawn(command,args,{cwd:options.cwd,env:options.env||env(),shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});const timer=options.timeout===0?null:setTimeout(()=>{stop(child);finish(Error('平台程序响应超时，请重试'));},options.timeout||30000);const finish=(failure,value)=>{if(settled)return;settled=true;clearTimeout(timer);failure?reject(failure):resolve(value);};child.stdout.on('data',part=>{output=(output+part.toString()).slice(-1024*1024);if(options.onOutput)options.onOutput(output);});child.stderr.on('data',part=>{error=(error+part.toString()).slice(-64000);if(options.onOutput)options.onOutput(output+'\n'+error);});child.once('error',()=>finish(Error('无法启动平台程序，请重新准备运行环境')));child.once('close',code=>finish(null,{code,output,error}));});return{completion,cancel:()=>stop(child),get child(){return child}};}
async function inspect(app,key){const p=paths(app,key),a=await adapter(key);const found=a.inspect(p.provider,p.prefix);const sdk=p.provider.registrationSdk;
 if(found.status==='installed'&&sdk){try{const file=path.join(p.prefix,'node_modules',sdk.package,'package.json');assertNoLinks(p.root,file);const installed=JSON.parse(fs.readFileSync(file,'utf8'));const lock=JSON.parse(fs.readFileSync(path.join(p.prefix,'package-lock.json'),'utf8'));if(installed.version!==sdk.version||lock.packages?.['node_modules/'+sdk.package]?.integrity!==sdk.npmIntegrity)found.status='needs_update';}catch(_){found.status='needs_update';}}
 return{...found,provider:key,label:p.provider.label,prefix:p.prefix};}
function python(){const choices=[process.env.SODUWORK_MANAGED_PYTHON,path.join(process.resourcesPath||'',process.platform==='win32'?'python/python.exe':'python/bin/python3'),path.resolve(__dirname,'../../../hub-backend/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')];const selected=choices.filter(Boolean).find(fs.existsSync);if(!selected)throw Error('连接组件不完整，请重新安装 SoduWork 后重试（SW-PYTHON-MISSING）');return selected;}
async function prepare(app,key){const p=paths(app,key),pending=installs.get(p.prefix);if(pending)return pending;const promise=(async()=>{let current=await inspect(app,key);if(current.status==='installed')return current;
 const selected=nodeRuntime.resolve({minimum:p.provider.nodeMinimum||20,requireNpm:true});
 const result=await execute(selected.node,[selected.npm,'install','--engine-strict','--prefix',p.prefix,'--ignore-scripts','--save-exact','--no-audit','--no-fund','--registry=https://registry.npmjs.org',p.provider.package+'@'+p.provider.version,...(p.provider.registrationSdk?[p.provider.registrationSdk.package+'@'+p.provider.registrationSdk.version]:[])],{cwd:p.prefix,env:env(selected),timeout:240000}).completion;
 if(result.code!==0)throw Error('官方运行环境下载失败，请检查网络后重试');
 const lock=JSON.parse(fs.readFileSync(path.join(p.prefix,'package-lock.json'),'utf8'));
 if(lock.packages?.['node_modules/'+p.provider.package]?.integrity!==p.provider.npmIntegrity)throw Error('官方运行包校验不一致，已停止准备');
 if(key==='dingtalk'){const binary=await execute(python(),[path.join(path.dirname(entry(app,key)),'prepare-dingtalk.py'),'--prefix',p.prefix],{cwd:p.prefix,timeout:60000}).completion;if(binary.code!==0)throw Error('钉钉程序校验或解包失败，请重试连接组件准备');}
 current=await inspect(app,key);if(current.status!=='installed')throw Error('运行环境未就绪：'+current.status);return current;})();installs.set(p.prefix,promise);try{return await promise}finally{installs.delete(p.prefix)}}
async function launch(app,key,scope,args,options={}){const p=paths(app,key,scope),a=await adapter(key);const plan=a.plan(p.provider,{action:'run',prefix:p.prefix,state:p.account,args},env(),node());return execute(plan.command,plan.args,{...options,cwd:options.cwd||plan.cwd,env:plan.env});}
function _claims(identity){
 if(!identity?.hub||!identity?.clientId||!identity?.session)throw Error('请先登录 SoduWork');
 // SoduWork Hub app/auth.py signs <payload_b64url>.<hex HMAC>, not a JWT.
 // identity comes only from trusted main-process deviceAuth.ensureSession.
 // Decode ownership here; server authentication/signature checks stay with Hub.
 let claims;
 try{
  const parts=identity.session.split('.');
  if(parts.length!==2||!/^[A-Za-z0-9_-]+$/.test(parts[0])||!/^[a-f0-9]{64}$/.test(parts[1]))throw Error();
  const payload=Buffer.from(parts[0],'base64url');
  if(payload.toString('base64url')!==parts[0])throw Error();
  claims=JSON.parse(payload.toString('utf8'));
  if(!claims||typeof claims!=='object'||Array.isArray(claims))throw Error();
 }catch(_){throw Error('当前账号会话无效，请重新登录 SoduWork')}
 if(claims.typ!=='device'||typeof claims.uid!=='string'||!claims.uid.trim()||claims.cid!==identity.clientId)
  throw Error('当前账号会话不完整，请重新登录 SoduWork');
 const now=Math.floor(Date.now()/1000);
 if(!Number.isSafeInteger(claims.exp)||!Number.isSafeInteger(claims.iat)||claims.exp<=now||claims.iat>now+60||claims.exp<=claims.iat)
  throw Error('当前账号会话已失效，请重新登录 SoduWork');
 return claims;
}
function scope(identity){
 const claims=_claims(identity);
 // Bind general ownership fingerprints to the account rather than Hub or enrollment details.
 // Same-account environment changes preserve local conversation and memory ownership.
 // Account UID continues to enforce cross-account isolation.
 return crypto.createHash('sha256').update('soduwork-account\0'+claims.uid).digest('hex').slice(0,32);
}
function legacyScope(hub,clientId,identity){
 // Use the legacy Hub, device, and account fingerprint only to recognize existing data, never for new writes.
 if(!hub||!clientId)throw Error('请先登录 SoduWork');
 const claims=_claims(identity);
 return crypto.createHash('sha256').update(new URL(hub).origin+'|'+clientId+'|'+claims.uid).digest('hex').slice(0,32);
}
function connectionScope(identity){
 // Use an environment-bound fingerprint for connection-specific data such as cloud handoff receipts.
 return legacyScope(identity&&identity.hub,identity&&identity.clientId,identity);
}
function scopeMatches(stored,identity,candidates){
 if(typeof stored!=='string'||!/^[a-f0-9]{32}$/.test(stored))return false;
 let current;try{current=scope(identity);}catch(_){return false;}
 if(stored===current)return true;
 // Recompute legacy fingerprints from local enrollment history and the current account to verify ownership.
 for(const candidate of Array.isArray(candidates)?candidates:[]){
  if(!candidate||!candidate.hub||!candidate.clientId)continue;
  try{if(legacyScope(candidate.hub,candidate.clientId,identity)===stored)return true;}
  catch(_){/* Skip candidates that are not valid origins. */}
 }
 return false;
}

// Platform credentials remain environment-bound; general conversations and memory use account scope.
// Register missing Hub metadata only during trusted explicit operations; do not move legacy files or change existing platform registration IDs.
function platformScope(app, identity, key, claim = false) {
  provider(key);
  const legacy = scope(identity), current = connectionScope(identity);
  const root = base(app), account = path.join(root, 'accounts', legacy, key);
  assertNoLinks(app.getPath('userData'), account);
  if (!fs.existsSync(account)) return current;
  if (!fs.lstatSync(account).isDirectory()) throw Error('连接账号目录无效');
  const file = path.join(account, '.soduwork-hub-binding.json');
  assertNoLinks(root, file);
  if (claim && !fs.existsSync(file)) {
    try { fs.writeFileSync(file, JSON.stringify({ schema: 1, scope: current }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.schema !== 1 || !/^[a-f0-9]{32}$/.test(value.scope || '')) throw Error();
    return value.scope === current ? legacy : current;
  } catch (error) {
    if (error.code === 'ENOENT') return legacy;
    throw Error('旧平台账号归属无法确认，请检查本机连接');
  }
}

module.exports={LABELS,provider,base,inside,privateDir,paths,entry,adapter,node,env,execute,stop,inspect,prepare,launch,scope,legacyScope,connectionScope,scopeMatches,platformScope};
