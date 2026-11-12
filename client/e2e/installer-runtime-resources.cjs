'use strict';
process.noAsar = true;
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function main(){
  const candidateFile=path.resolve(process.argv[2]),work=path.dirname(candidateFile),candidate=JSON.parse(fs.readFileSync(candidateFile));
  const result=JSON.parse(fs.readFileSync(path.join(work,'payload-result.json'))),root=result.extracted;
  const executable=require('../scripts/installed-distribution.cjs').installedDistribution(root).windowsExecutableName+'.exe';
  assert.equal(candidate.payloadVerified,true);assert.equal(path.dirname(root),require('node:os').tmpdir());assert.ok(path.basename(root).startsWith('soduwork-package-check-'));
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'.soduwork-payload.json')));
  const legacy=require('./fixtures/installer-runtime-resource-paths.json');assert.equal(legacy.length,66);
  const names=legacy.filter(name=>!name.startsWith('resources/runner/_internal/'));assert.equal(names.length,61);
  assert.equal(fs.existsSync(path.join(root,'resources/runner/_internal')),false,'Python bootstrap is embedded in the executable');
  const original=new Map();
  for(const name of names){const item=manifest.files.find(x=>x.path===name);assert.ok(item,name);const bytes=fs.readFileSync(path.join(root,name));assert.equal(bytes.length,item.size,name);assert.equal(sha(bytes),item.sha256,name);original.set(name,bytes);}
  const runtime=spawnSync(path.join(root,'resources/runner/soduwork-runner.exe'),['--help'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',SODUWORK_HUB:'',SODUWORK_RUNNER_TOKEN:'',SODUWORK_RUNNER_KEY:'',SODUWORK_DEVICE_SECRET:''}});
  assert.equal(runtime.status,0,runtime.stderr||runtime.error?.message);assert.match(runtime.stdout,/--config/);
  let rejected, compatible;
  try{
    for(const [name,bytes] of original)fs.writeFileSync(path.join(root,name),Buffer.concat([Buffer.alloc(4096,65),bytes]));
    const report=path.join(work,'runtime-resource-rejection.json');
    const checked=spawnSync(path.join(root,executable),[path.join(root,'.soduwork-verify.cjs'),root,report],{encoding:'utf8',windowsHide:true,timeout:300000,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
    assert.equal(checked.status,2,checked.error?.message);rejected=JSON.parse(fs.readFileSync(report));
    assert.equal(rejected.checkedFiles,manifest.files.length);assert.equal(rejected.errorCount,names.length);assert.deepEqual(rejected.errors.map(x=>x.path).sort(),[...names].sort());
    assert.ok(rejected.errors.every(x=>x.actualSize-x.expectedSize===4096));
    const installationReport=path.join(work,'static-text-installation.json');
    const installed=spawnSync(path.join(root,executable),[path.join(root,'.soduwork-verify.cjs'),root,installationReport,'--installation'],{encoding:'utf8',windowsHide:true,timeout:300000,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
    assert.equal(installed.status,0,installed.stderr);compatible=JSON.parse(fs.readFileSync(installationReport));
    assert.equal(compatible.staticTextDifferences.length,names.length);assert.equal(compatible.fullContentVerified,false);
    assert.ok(compatible.staticTextDifferences.every(x=>x.sourceSha256===x.expectedSha256));
  }finally{for(const [name,bytes] of original){fs.writeFileSync(path.join(root,name),bytes);assert.equal(sha(fs.readFileSync(path.join(root,name))),sha(bytes));}}
  fs.writeFileSync(path.join(work,'runtime-resource-regression.json'),JSON.stringify({ok:true,version:candidate.version,installerSha256:candidate.sha256,extractionMethod:result.extractionMethod,filesVerified:manifest.files.length,customerPathsVerified:legacy.length,externalTextPathsVerified:names.length,embeddedRunnerResources:legacy.length-names.length,installationTextDifferences:compatible.staticTextDifferences.length,runnerHelpExit:runtime.status,runnerStarted:true,allRuntimeMutationsRejected:rejected.errorCount,restored:true,limitation:'Process-scoped corporate filesystem filter not available locally; customer environment still requires confirmation.'},null,2));
  console.log('PASS: Runner bootstrap is embedded, delivered Runner boots, all 61 external text changes are rejected in strict mode and source-verified in installation mode.');
}
try{main();}catch(error){console.error(error);process.exitCode=1;}
