'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const personal=require('../main/personal-plugins'),resources=require('../main/plugin-resources'),edit=require('../main/jiyong-edit-source.cjs');
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sw-edit-rebase-')),app={getPath:()=>path.join(root,'profile')};let owner='account-a';
 require('../main/app-settings-store.cjs').configure({app,ownerOf:()=>owner});
 t.after(()=>{require('../main/app-settings-store.cjs').configure(undefined);fs.rmSync(root,{recursive:true,force:true});});
 const source=path.join(root,'source');require('../../skills/app-developer/scripts/scaffold.cjs').scaffold({out:source,key:'edit-race',name:'Edit race'});
 const file=path.join(source,'soduwork-plugin-draft.json'),body=JSON.parse(fs.readFileSync(file,'utf8'));body.version='1.0.3';body.author='Original author';body.appCategory='other';
 const installed=personal.create(app,resources.collect(body,file,root)).plugin;
 const candidate=await edit.prepare({app,pluginId:installed.pluginId,cwd:root});
 const script=path.join(path.dirname(candidate.draft),'ui/app.js');fs.appendFileSync(script,'\nwindow.edited=true;');
 const collect=()=>resources.collect(JSON.parse(fs.readFileSync(candidate.draft,'utf8')),candidate.draft,root);
 const reconcile=()=>edit.reconcile({app,cwd:root,file:candidate.draft,body:collect()});
 const meta=options=>require('../main/personal-plugin-metadata.cjs').update({app,pluginId:installed.pluginId,options:{...options,expectedChecksum:personal.get(app,installed.pluginId).checksum}});
 return{root,app,installed,candidate,script,collect,reconcile,meta,setOwner:value=>owner=value};
}
test('metadata versions allocated during editing no longer block install or overwrite the saved author/category',async t=>{
 const f=await fixture(t);await f.meta({author:'New author'});await f.meta({appCategory:'game'});
 assert.equal(personal.get(f.app,f.installed.pluginId).version,'1.0.5');
 assert.throws(()=>personal.create(f.app,f.collect()),/同一版本内容已经变化/,'negative control preserves the original conflict');
 const before=fs.readFileSync(path.join(f.app.getPath(),'personal-plugins.json'),'utf8');
 const candidate=f.reconcile();assert.equal(candidate.version,'1.0.6');assert.equal(candidate.author,'New author');assert.equal(candidate.appCategory,'game');
 assert.equal(fs.readFileSync(path.join(f.app.getPath(),'personal-plugins.json'),'utf8'),before,'checking does not install or mutate accepted versions');
 const next=personal.create(f.app,candidate).plugin;
 assert.equal(next.pluginId,f.installed.pluginId);assert.equal(next.version,'1.0.6');
 assert.ok(Buffer.from(next.localDraft.resources.find(row=>row.path==='ui/app.js').content,'base64').toString().includes('window.edited=true'));
 assert.equal(personal.get(f.app,f.installed.pluginId).authorName,'New author');
 assert.equal(f.reconcile().version,'1.0.6','rechecking the installed candidate is idempotent');
 fs.appendFileSync(f.script,'\nwindow.secondEdit=true;');await f.meta({appCategory:'robot'});
 const second=f.reconcile();assert.equal(second.version,'1.0.8');assert.equal(second.appCategory,'robot');
 assert.equal(personal.create(f.app,second).plugin.version,'1.0.8','continuing in the same conversation still works');
 f.reconcile();
 for(let n=0;n<10;n++){fs.appendFileSync(f.script,'\nwindow.preview'+n+'=true;');assert.equal(f.reconcile().version,'1.0.9');}
});
test('concurrent code edits and competing metadata changes require explicit reconciliation',async t=>{
 const f=await fixture(t);
 const competing={...f.installed.localDraft,version:'1.0.4',description:'Changed in another editor'};personal.create(f.app,competing);
 assert.throws(f.reconcile,/源码已被其他修改/);
});
test('a model retaining the original version is rebased without rewriting its source file',async t=>{
 const f=await fixture(t),draft=JSON.parse(fs.readFileSync(f.candidate.draft,'utf8'));draft.version='1.0.3';fs.writeFileSync(f.candidate.draft,JSON.stringify(draft));
 await f.meta({author:'Saved author'});await f.meta({appCategory:'game'});
 const result=f.reconcile();assert.equal(result.version,'1.0.6');assert.equal(result.author,'Saved author');
 assert.equal(JSON.parse(fs.readFileSync(f.candidate.draft,'utf8')).version,'1.0.3');
});
test('the final draft may be delivered elsewhere within the same editing conversation',async t=>{
 const f=await fixture(t);await f.meta({author:'Saved author'});
 const body=f.collect(),file=path.join(f.root,'delivery','soduwork-plugin-draft.json');
 fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,JSON.stringify(body));
 const result=edit.reconcile({app:f.app,cwd:f.root,file,body});
 assert.equal(result.version,'1.0.5');assert.equal(result.author,'Saved author');
});
test('the selected conversation draft reader returns the reconciled body used by Check and install',async t=>{
 const f=await fixture(t);await f.meta({author:'Saved author'});await f.meta({appCategory:'game'});
 const file={path:f.candidate.draft,pluginDraft:true,artifactId:'edited-candidate'};
 const reader=require('../main/pi-session/plugin-draft');
 const result=reader.readSession({cwd:f.root,sessionId:'edit-session',inFlight:()=>false},'edited-candidate',{items:[file],got:{files:[file]}},f.app);
 assert.equal(result.ok,true,result.reason);assert.equal(result.body.version,'1.0.6');
 assert.equal(result.body.author,'Saved author');assert.equal(personal.create(f.app,result.body).plugin.version,'1.0.6');
});
test('explicit draft metadata edits are preserved or conflict rather than silently overwritten',async t=>{
 const f=await fixture(t);const draft=JSON.parse(fs.readFileSync(f.candidate.draft,'utf8'));draft.author='Draft author';fs.writeFileSync(f.candidate.draft,JSON.stringify(draft));
 assert.equal(f.reconcile().author,'Draft author');await f.meta({author:'Settings author'});
 assert.throws(f.reconcile,/开发者或分类已被其他修改/);
});
test('other accounts and unrelated imports cannot use an editing baseline to bypass version rules',async t=>{
 const f=await fixture(t);f.setOwner('account-b');assert.throws(f.reconcile,/账号已变化/);f.setOwner('account-a');
 const body=f.collect(),other=path.join(f.root,'other-session');assert.equal(edit.reconcile({app:f.app,cwd:other,file:path.join(other,'import.json'),body}),body);
 assert.throws(()=>personal.create(f.app,{...f.installed.localDraft,description:'same-version change'}),/提升版本号/);
});
test('a change after checking but before installation cannot replace a newer unoccupied version',async t=>{
 const f=await fixture(t),candidate=f.reconcile(),handlers={};
 personal.install({app:f.app,ipcMain:{handle:(name,fn)=>handlers[name]=fn}});
 personal.create(f.app,{...f.installed.localDraft,version:'1.0.8',description:'Other editor completed after preview'});
 await assert.rejects(handlers['personal-plugin-create']({},candidate),/安装前即用版本或账号已变化/);
 assert.equal(personal.get(f.app,f.installed.pluginId).version,'1.0.8');
});
