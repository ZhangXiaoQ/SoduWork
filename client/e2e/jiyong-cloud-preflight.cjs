'use strict';
// Native preflight of a cloud-declared package with an explicit readonly readiness fixture.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-cloud-preflight-'));
(async()=>{
  const out=path.join(root,'source');
  require('../../skills/app-developer/scripts/scaffold.cjs').scaffold({out,key:'cloud-preflight',name:'云端预检',storage:'cloud'});
  const file=path.join(out,'soduwork-plugin-draft.json');
  const body=require('../main/plugin-resources').collect(JSON.parse(fs.readFileSync(file,'utf8')),file,out);
  const calls=[],identity={hub:'https://fixture.invalid',clientId:'device-a',session:'fixture-only'};
  const result=await require('../main/personal-plugins').preflightCandidate({getPath:()=>root},body,{
    identityOf:async()=>identity,fetchImpl:async(url,options)=>{calls.push({url,method:options.method});return Response.json({ok:true,location:'cloud'});}});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.runtime,undefined,'installation does not launch a first-screen worker');
  assert.ok(result.checks.some(row=>row.key==='cloud-readiness'&&row.ok));
  assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');
  assert.equal(fs.existsSync(path.join(root,'jiyong-data')),false);
  const evidence=path.resolve(__dirname,'../../.local/jiyong-cloud-evidence');fs.mkdirSync(evidence,{recursive:true});
  fs.writeFileSync(path.join(evidence,'cloud-native-preflight.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({ok:true,checks:result.checks,boundary:'Static package checks and readonly cloud readiness fixture; no page startup, cloud database provisioning or business write.'}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
  if(path.dirname(path.resolve(root))===path.resolve(os.tmpdir())&&path.basename(root).startsWith('soduwork-cloud-preflight-'))fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});
