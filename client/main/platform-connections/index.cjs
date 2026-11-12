'use strict';
const path=require('node:path'),{fileURLToPath}=require('node:url');
const runtime=require('./runtime.cjs'),feishu=require('./feishu.cjs'),wecomQr=require('./wecom-qr.cjs');
let installed=null;
function loginHint(key,raw){const clean=String(raw||'').replace(/\x1b\[[0-9;]*m/g,'');const urls=clean.match(/https:\/\/[^\s<>"']+/g)||[];const authUrl=urls.find(value=>{try{const u=new URL(value.replace(/[),;]+$/,''));const domain=key==='wecom'?'weixin.qq.com':'dingtalk.com';return !u.username&&!u.password&&(u.hostname===domain||u.hostname.endsWith('.'+domain))&&![...u.searchParams.keys()].some(k=>/token|secret|password/i.test(k));}catch(_){return false}})||'';const code=clean.match(/(?:user_code|userCode|授权码|设备码)\s*[":：=]*\s*([A-Z0-9]{4,16}(?:-[A-Z0-9]{4,16})?)/i);return{authUrl:authUrl.replace(/[),;]+$/,'').slice(0,2048),userCode:code?code[1]:''};}
function authResult(key,result){if(key==='wecom'){const text=result.output.trim();if(result.code===0&&text==='authorized')return true;if(text==='unauthorized')return false;throw Error('未能确认企业微信授权状态，请重试')}
 let data;
 try { data=JSON.parse(result.output); } catch { /* Only the official JSON status confirms a login. */ }
 const status=typeof data?.authenticated==='boolean'?data:data?.data;
 if(result.code!==0||data?.success===false||status?.success===false||typeof status?.authenticated!=='boolean')throw Error('未能确认钉钉授权状态，请重试');
 if(!status.authenticated){
   if(['ciphertext_key_mismatch','dek_missing','keychain_unavailable'].includes(status.reason))
     throw Error('钉钉无法读取本机登录凭据，请检查系统凭据存储后再检查连接');
   if(status.reason==='token_refresh_failed')throw Error('钉钉登录状态刷新失败，请检查网络后再检查连接');
 }
 return status.authenticated;
}
function trustedSender(event){try{const url=new URL(event.senderFrame?.url||event.sender.getURL());return url.protocol==='file:'&&runtime.inside(path.resolve(__dirname,'../..'),fileURLToPath(url));}catch(_){return false}}
function create(options){return require('./service.cjs').create(options,{loginHint,authResult});}
function install(options){const {app,ipcMain}=options;const service=create(options);installed=service;const methods={status:[],refresh:[],prepare:[],connect:[],cancel:[],disconnect:[],openAuth:[]};for(const action of Object.keys(methods))ipcMain.handle('platform-connection-'+action,async(event,key,payload)=>{if(!trustedSender(event))return{ok:false,reason:'只允许 SoduWork 客户端管理平台连接'};try{return await service[action](String(key||''),payload||{})}catch(error){return{ok:false,reason:error.message}}});app.on('before-quit',()=>service.close());app.whenReady().then(()=>Promise.allSettled(Object.keys(runtime.LABELS).map(key=>service.refresh(key)))).catch(()=>{});return service;}
async function guidance(key){return installed?installed.guide(key):''}
async function conversationGuidance(scope){return installed?installed.conversationGuide(scope):''}
module.exports={create,install,guidance,conversationGuidance,loginHint,authResult,trustedSender};
