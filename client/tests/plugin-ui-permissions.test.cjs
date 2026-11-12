'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function setup() {
  const events = {}, effects = [];
  let allowed = true;
  const item = { pluginId: 'enterprise-ui', name: 'UI', installed: true, enabled: true,
    organizationWide: true, permissions: {canUse:false,canEdit:true}, ui: {contributions: [{
      id:'form', slot:'task.detail.tab', source:{type:'builtin',actionId:'fixture.action'},
    }]} };
  const api = { pluginCatalog: async () => ({items:[item]}), enterprisePluginPermissions: async id => {
    effects.push(['authorize',id]); return {canUse:allowed,canEdit:true};
  }, sendMateMessage: async () => {effects.push(['notification']);return {ok:true};} };
  const window = { SoduWorkAPI:api, addEventListener:(name,fn)=>{events[name]=fn;},
    soduWorkAPI:{openExternal:async url=>effects.push(['external',url]),
      workPreviewAppHost:{authorize:async id=>({ok:id==='authorized-request'})}} };
  const context = {window,SoduWorkAPI:api,soduWorkAPI:window.soduWorkAPI,URL,Date,Map,Set,console};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../components/panels/plugin-ui-host.js'),'utf8'),context);
  window.PluginUIHost.registerAction({id:'fixture.action',command:'fixture',open:()=>effects.push(['action'])});
  return {window,context,item,api,events,effects,host:window.PluginUIHost,setAllowed:value=>{allowed=value;}};
}
test('an installed edit-only plugin contributes no usable UI action or task tab',async()=>{
  const s=setup();
  assert.equal(s.host.catalogPresentation(s.item).action,'');
  assert.equal((await s.host.contributions('task.detail.tab',{})).length,0);
});
test('stale direct builtin and external UI entries reauthorize before side effects',async()=>{
  const s=setup();s.setAllowed(false);
  await assert.rejects(s.host.openContribution(s.item.ui.contributions[0],{item:s.item}),/使用权限/);
  await assert.rejects(s.host.openContribution({id:'web',slot:'task.detail.tab',source:{type:'external',
    url:'https://example.invalid/',openMode:'external'}},{item:s.item}),/使用权限/);
  assert.equal(s.effects.filter(row=>row[0]!=='authorize').length,0);
});
test('normalized task contributions keep the source identity for fresh authorization',async()=>{
  const s=setup();s.item.permissions.canUse=true;
  const [row]=await s.host.contributions('task.detail.tab',{});
  await s.host.openContribution(row,{});
  assert.deepEqual(s.effects,[['authorize','enterprise-ui'],['action']]);
});
test('native personal UI opens offline without enterprise authorization',async()=>{
  const s=setup();s.setAllowed(false);s.item.personal=true;s.item.pluginId='local:fixture';
  await s.host.openContribution(s.item.ui.contributions[0],{item:s.item});
  assert.deepEqual(s.effects,[['action']]);
});
test('an identity change during UI authorization prevents opening the old source',async()=>{
  const s=setup();let release;
  s.api.enterprisePluginPermissions=()=>new Promise(resolve=>{release=resolve;});
  const pending=s.host.openContribution(s.item.ui.contributions[0],{item:s.item});
  await new Promise(resolve=>setImmediate(resolve));
  s.events['soduwork-data-scope-changed']?.();release?.({canUse:true});
  await assert.rejects(pending,/身份|账号/);
  assert.equal(s.effects.length,0);
});

test('account scope changes explicitly close independent apps while ordinary authorization leaves them intact',async()=>{
  const s=setup(), destroyed=[];
  s.window.soduWorkAPI.workPreview={destroy:id=>destroyed.push(id)};
  await s.host.assertUse(s.item.pluginId);
  assert.deepEqual(destroyed,[]);
  s.events['soduwork-data-scope-changed']();
  assert.deepEqual(destroyed,['']);
});
test('a different plugin policy change does not cancel a pending source authorization',async()=>{
  const s=setup();let release;
  s.api.enterprisePluginPermissions=()=>new Promise(resolve=>{release=resolve;});
  const pending=s.host.openContribution(s.item.ui.contributions[0],{item:s.item});
  await new Promise(resolve=>setImmediate(resolve));
  s.events['soduwork-plugin-policy']({detail:{pluginId:'other-plugin'}});
  release({canUse:true});await pending;
  assert.deepEqual(s.effects,[['action']]);
});
test('already open plugin application requests check current rights; other apps retain their contract',async()=>{
  const s=setup();
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../components/panels/soduwork-app-bridge-host.js'),'utf8'),s.context);
  s.setAllowed(false);
  const request={id:'authorized-request',appId:'plugin:enterprise-ui',method:'notifications.send',params:{recipientUserId:'fixture',text:'hello'}};
  const denied=await s.window.SoduWorkAppBridgeHost._handle(request);
  assert.equal(denied.ok,false);
  assert.equal(s.effects.filter(row=>row[0]==='notification').length,0);
  assert.equal((await s.window.SoduWorkAppBridgeHost._handle({...request,appId:'standalone-app'})).ok,true);
});

// Native request authorization remains required even for non-plugin applications.
test('expired native application requests cannot send notifications',async()=>{
  const s=setup();
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../components/panels/soduwork-app-bridge-host.js'),'utf8'),s.context);
  await assert.rejects(s.window.SoduWorkAppBridgeHost._handle({id:'expired-request',appId:'standalone-app',
    method:'notifications.send',params:{recipientUserId:'fixture',text:'hello'}}),/authorization expired/);
  assert.equal(s.effects.filter(row=>row[0]==='notification').length,0);
});
