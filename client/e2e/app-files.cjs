'use strict';
// Isolated hidden Electron windows verify resource URLs across a process restart.
const electron=require('electron'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
if(typeof electron==='string') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sw-file-url-e2e-')),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  for(const phase of ['write','restart']) {
    const r=require('node:child_process').spawnSync(electron,[__filename,root,phase],{env,windowsHide:true,encoding:'utf8',timeout:45000});
    process.stdout.write(r.stdout||'');if(r.status!==0){process.stderr.write(r.stderr||String(r.error));process.exit(r.status||1);}
  }
  fs.rmSync(root,{recursive:true,force:true});
}else{
  const {app,BrowserWindow,nativeImage}=electron,root=process.argv[2],phase=process.argv[3];app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
  app.whenReady().then(async()=>{
    const settings=require('../main/app-settings-store.cjs'),personal=require('../main/personal-plugins'),resources=require('../main/plugin-resources'),pages=require('../main/app-package-pages.cjs'),files=require('../main/app-files.cjs');
    settings.configure({app,ownerOf:()=> 'fixture-user'});let receipt;
    if(phase==='write'){
      const out=path.join(root,'source');require('../../skills/app-developer/scripts/scaffold.cjs').scaffold({out,key:'file-url',name:'文件空间'});
      const name=path.join(out,'soduwork-plugin-draft.json'),draft=JSON.parse(fs.readFileSync(name,'utf8'));draft.jiyong={version:1,storage:{location:'local'},parameters:[],collections:[]};draft.ui.contributions[0].source.bridge={version:1,capabilities:['data.read','data.write']};
      const pluginId=personal.create(app,resources.collect(draft,name,out)).plugin.pluginId,binding={pluginId,origin:require('../core/plugin-package-page.cjs').origin(pluginId)};
      const bytes=nativeImage.createFromBitmap(Buffer.from([255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255]),{width:2,height:2}).toPNG();
      const begin=await files.execute(app,binding,'files.begin',{projectId:'page-project',name:'sample.png',type:'image/png',size:bytes.length});await files.execute(app,binding,'files.append',{id:begin.id,offset:0,data:bytes});
      receipt={pluginId,file:(await files.execute(app,binding,'files.finish',{id:begin.id})).file};fs.writeFileSync(path.join(root,'receipt.json'),JSON.stringify(receipt));
    }else receipt=JSON.parse(fs.readFileSync(path.join(root,'receipt.json'),'utf8'));
    const prepared=await pages.prepare({app},{pluginId:receipt.pluginId,contributionId:'main'}),win=new BrowserWindow({show:false,webPreferences:{partition:prepared.partition,contextIsolation:true,nodeIntegration:false,sandbox:true}});
    await win.loadURL(prepared.url);
    const result=await win.webContents.executeJavaScript(`(async()=>{const url=${JSON.stringify(receipt.file.url)};const image=new Image();image.src=url;await image.decode();const c=document.createElement('canvas');c.width=2;c.height=2;c.getContext('2d').drawImage(image,0,0);const pixels=Array.from(c.getContext('2d').getImageData(0,0,2,2).data);const range=await fetch(url,{headers:{Range:'bytes=0-7'}});return {w:image.naturalWidth,pixels,status:range.status,length:(await range.arrayBuffer()).byteLength};})()`);
    assert.equal(result.w,2);assert.equal(result.pixels.length,16);assert.equal(result.status,206);assert.equal(result.length,8);
    console.log(JSON.stringify({phase,ok:true,directImageURL:true,canvasReadable:true,range206:true,installedInUserProfile:false}));win.destroy();app.exit(0);
  }).catch(e=>{console.error(e.stack);app.exit(1);});
}
