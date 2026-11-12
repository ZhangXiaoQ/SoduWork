// Real desktop request validation/resolution, with an isolated identity and no model.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const store = require('../../client/main/personal-plugins');
const {create} = require('../../client/main/mobile-capabilities.cjs');
const app = {getPath: () => process.argv[2], isPackaged:false};
async function main() {
  if (process.argv[3] === 'catalog') {
    const row = store.catalog(app,true).find(r=>r.pluginId==='local:plugin-builder');
    return {pluginId:row.pluginId,checksum:row.checksum};
  }
  const body=JSON.parse(fs.readFileSync(0,'utf8'));
  const identity={hub:'https://fixture.invalid',clientId:'pc',
    session:Buffer.from(JSON.stringify({typ:'device',cid:'pc',uid:'owner'})).toString('base64url')+'.fixture'};
  const handler=create({app,identityOf:async()=>identity,verifyRequest:async()=>({ok:true}),
    conversation:{open:async()=>{throw Error('must not open a synchronized PC chat');}}});
  const result=await handler({...body,expiresAt:Date.now()/1000+90,
    _turnContext:{ref:body.args.ref,cwd:app.getPath(),text:'summarize fixture',capabilityIds:[],readOnly:false}});
  return {plugins:result.plugins,hasPrompt:result.promptText.includes('summarize fixture'),
    resourceCount:result.resourceBundles.length};
}
main().then(result=>process.stdout.write(JSON.stringify(result))).catch(error=>{
  process.stderr.write(error.message);process.exitCode=1;
});
