'use strict';
// Read-only resource-serving benchmark on generated, isolated plugin data.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{performance}=require('node:perf_hooks');
const personal=require('../main/personal-plugins'),resources=require('../main/plugin-resources'),pages=require('../main/app-package-pages.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-package-perf-'));
const app={getPath:()=>path.join(root,'profile')};
(async()=>{
  const source=path.join(root,'source');require('../../skills/app-developer/scripts/scaffold.cjs').scaffold({out:source,key:'perf-fixture',name:'Performance fixture'});
  const file=path.join(source,'soduwork-plugin-draft.json');
  const body=resources.collect(JSON.parse(fs.readFileSync(file,'utf8')),file,source);
  const extra=Array.from({length:40},(_,i)=>({path:'assets/asset-'+i+'.txt',kind:'asset',encoding:'utf8',content:'x'.repeat(64*1024)}));
  body.resources=resources.normalize([...body.resources,...extra]);
  const plugin=personal.create(app,body).plugin;
  let handler;
  const session={setPermissionRequestHandler(){},setPermissionCheckHandler(){},protocol:{handle(_scheme,fn){handler=fn;}}};
  const deps={app,session:{fromPartition:()=>session}};
  const started=performance.now(),opened=await pages.prepare(deps,{pluginId:plugin.pluginId,contributionId:'main'});
  const prepareMs=performance.now()-started;
  const metadata=path.join(app.getPath(),'personal-plugins.json');
  const read=fs.readFileSync,normalize=resources.normalize;let reads=0,normalizations=0;
  fs.readFileSync=(filename,...args)=>{if(String(filename)===metadata)reads++;return read(filename,...args);};
  resources.normalize=(...args)=>{normalizations++;return normalize(...args);};
  const results=[];
  try{
    for(const count of [1,10,40]){
      const cacheInput={action:'stats',profile:app.getPath(),pluginId:plugin.pluginId};
      const cacheBefore=await require('../main/app-resource-cache.cjs').request(cacheInput);
      reads=0;normalizations=0;const durations=[],begin=performance.now();
      for(let i=0;i<count;i++){
        const t=performance.now(),response=await handler({url:new URL('/assets/asset-'+i+'.txt',opened.url).href,method:'GET'});
        if(response.status!==200)throw Error('Fixture asset failed: '+response.status);
        await response.arrayBuffer();durations.push(performance.now()-t);
      }
      const totalMs=Math.round(performance.now()-begin),cacheAfter=await require('../main/app-resource-cache.cjs').request(cacheInput);
      results.push({requests:count,totalMs,maxRequestMs:Math.round(Math.max(...durations)),registryReads:reads,wholePackageNormalizations:normalizations,
        workerRegistryReads:cacheAfter.registryReads-cacheBefore.registryReads,workerNormalizations:cacheAfter.normalizations-cacheBefore.normalizations,
        cacheHits:cacheAfter.hits-cacheBefore.hits,cacheBytes:cacheAfter.bytes});
    }
  }finally{fs.readFileSync=read;resources.normalize=normalize;}
  const report={prepareMs:Math.round(prepareMs),registryBytes:fs.statSync(metadata).size,resources:body.resources.length,results,
    boundary:'Generated local package and production resource handler. Sequential Node fixture benchmark, not user app startup timing or native Chromium profile.'};
  const out=path.resolve(__dirname,'../../.local/app-window-audit-20261105');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'package-performance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
