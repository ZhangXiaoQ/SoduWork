'use strict';
// Real isolated Electron startup checks; no model or user's business data.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-preflight-e2e-'));
const app={getPath:()=>path.join(root,'source-client-fixture')};
const probe=require('../main/app-candidate-preflight.cjs');
const resources=require('../main/plugin-resources');
function candidate(name,script,extraHtml){
  const out=path.join(root,name);
  require('../../skills/app-developer/scripts/scaffold.cjs').scaffold({out,key:name,name,storage:true});
  const file=path.join(out,'soduwork-plugin-draft.json'),body=JSON.parse(fs.readFileSync(file,'utf8'));
  body.ui.contributions[0].source.bridge.capabilities.push('context.read');
  if(script)fs.writeFileSync(path.join(out,'ui/app.js'),script);
  if(extraHtml)fs.appendFileSync(path.join(out,'ui/index.html'),extraHtml);
  return resources.collect(body,file,root);
}
(async()=>{
  const original=path.join(app.getPath(),'personal-plugins.json'),originalBytes=JSON.stringify({schemaVersion:1,plugins:[],sentinel:'user profile must remain untouched'});fs.mkdirSync(app.getPath(),{recursive:true});fs.writeFileSync(original,originalBytes);
  const originalHarness=process.env.NODE_TEST_CONTEXT;process.env.NODE_TEST_CONTEXT='child-v8';
  const good=await probe.run(app,candidate('good-demo',`soduWorkApp.context.get().then(async r=>{if(!r.ok)throw Error(r.reason);const p=await soduWorkApp.data.list({collection:'notes',after:''});if(!p.ok)throw Error(p.reason);document.getElementById('status').textContent='Ready';});`));
  assert.equal(good.ok,true,JSON.stringify(good));
  for(const key of ['app-first-screen','app-bridge','app-context','app-database-notes','app-database-write-notes','app-startup'])assert.equal(good.checks.find(row=>row.key===key)?.ok,true,key);
  assert.equal(good.businessTested,false);assert.equal(good.firstScreen.inputCount,1);
  assert.equal(good.checks.find(row=>row.key==='app-check-hidden').ok,true);
  assert.equal(good.diagnosticNotice.fontSize,'12px');
  assert.equal(good.diagnosticNotice.whiteSpace,'nowrap');
  assert.equal(good.diagnosticNotice.color,'rgb(139, 139, 147)');
  assert.ok(good.diagnosticNotice.height-good.diagnosticNotice.bottom<=8);
  const noContextBody=candidate('no-context-demo',"document.getElementById('status').textContent='Ready';");
  noContextBody.ui.contributions[0].source.bridge.capabilities=noContextBody.ui.contributions[0].source.bridge.capabilities.filter(value=>value!=='context.read');
  const noContext=await probe.run(app,noContextBody);
  assert.equal(noContext.ok,true,JSON.stringify(noContext));
  assert.equal(noContext.checks.find(row=>row.key==='app-bridge').ok,true);
  assert.equal(noContext.checks.some(row=>row.key==='app-context'),false,'probe must not grant undeclared context access');
  if(originalHarness===undefined)delete process.env.NODE_TEST_CONTEXT;else process.env.NODE_TEST_CONTEXT=originalHarness;
  const swallowedBody=candidate('swallowed-demo',`try{soduWorkApp.connect({capabilities:['data.read']});}catch(_){document.getElementById('status').textContent='预览模式：未连接应用壳';}`);
  const swallowed=await probe.run(app,swallowedBody);
  assert.equal(swallowed.ok,false);assert.equal(swallowed.checks.find(row=>row.key==='app-bridge').ok,true);assert.equal(swallowed.checks.find(row=>row.key==='app-database-notes').ok,true);
  assert.match(swallowed.errors.join('\n'),/soduWorkApp\.connect is not a function/);
  assert.match(swallowed.checks.find(row=>row.key==='app-startup').label,/发现脚本/);
  assert.doesNotMatch(swallowed.checks.find(row=>row.key==='app-startup').label,/未发现/);
  const brokenDom=await probe.run(app,candidate('dom-demo',`document.getElementById('does-not-exist').textContent='Broken';`));
  assert.equal(brokenDom.ok,false);assert.match(brokenDom.errors.join('\n'),/null/);
  const brokenSyntax=await probe.run(app,candidate('syntax-demo',`const pendingCopy=1;const pendingCopy=2;`));
  assert.equal(brokenSyntax.ok,false);assert.match(brokenSyntax.errors.join('\n'),/pendingCopy/);
  const missing=candidate('asset-demo',null,'<script src="missing.js"></script>');
  const missingAsset=await probe.run(app,missing);assert.equal(missingAsset.ok,false);assert.match(missingAsset.errors.join('\n'),/404|Failed to load/);
  const consoleError=await probe.run(app,candidate('console-demo',`console.error('startup connection failed');`));
  assert.equal(consoleError.ok,false);assert.match(consoleError.errors.join('\n'),/startup connection failed/);
  const external=await probe.run(app,{template:'app',ui:{contributions:[{slot:'workspace.navigation',source:{type:'external',url:'https://example.invalid'}}]}});
  assert.equal(external.executed,false);assert.equal(external.checks.length,0,'untested external page has no fabricated pass');
  const handlers={};require('../main/personal-plugins').install({app,ipcMain:{handle:(name,fn)=>handlers[name]=fn}});
  assert.equal(fs.readFileSync(original,'utf8'),originalBytes,'explicit diagnostics leave the user profile unchanged');
  const installed=await handlers['personal-plugin-create']({},swallowedBody);
  assert.equal(installed.ok,true,'installation no longer executes or gates on the first screen');
  assert.ok(installed.plugin);
  for(const r of [good,swallowed,brokenDom,brokenSyntax,missingAsset,consoleError]){
    const folder=path.join(app.getPath(),'diagnostics/app-preflight',r.candidate.checksum);
    assert.ok(fs.existsSync(path.join(folder,'report.json')));assert.ok(fs.existsSync(path.join(folder,'first-screen.png')));
  }
  console.log(JSON.stringify({ok:true,evidence:root,cases:['Node test-runner environment isolation','bridge transport with undeclared context access denied','explicit native first screen','native bridge/context','real isolated SQLite read/write/readback','caught nonexistent SDK method despite empty catch','DOM mismatch','duplicate declaration','missing resource','console startup error','external not executed','installation independent of startup diagnostics','explicit diagnostics preserve user profile'],businessTested:false}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
