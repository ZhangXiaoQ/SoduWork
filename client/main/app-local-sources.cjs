'use strict';
// Only host-picker-authorized image sources. Never accept paths from an app page.
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const rows=new Map(),picking=new Set(),types={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.bmp':'image/bmp','.avif':'image/avif'};
async function inspect(file){const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink())throw Error('请选择普通图片文件');return st;}
function same(a,b){return a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ino===b.ino&&a.dev===b.dev;}
async function select(scope,binding,current,options={}){
 if(picking.has(scope))throw Error('文件选择窗口已打开');picking.add(scope);
 try{const dialog=options.dialog||require('electron').dialog,settings={properties:['openFile','multiSelections'],filters:[{name:'Images',extensions:Object.keys(types).map(x=>x.slice(1))}]};
 const selected=await dialog.showOpenDialog(settings);current();if(selected.canceled)return {ok:true,items:[]};if(selected.filePaths.length>20)throw Error('一次最多选择20张图片');
 const pending=[];for(const file of selected.filePaths){const st=await inspect(file),type=types[path.extname(file).toLowerCase()];if(!type||st.size>256*1024*1024)throw Error('图片类型或大小无效');const id='source_'+randomUUID().replace(/-/g,''),name=path.basename(file);pending.push({id,scope,origin:binding.origin,path:file,stat:st,name,type,size:st.size});}current();
 for(const row of pending){rows.set(row.id,row);row.timer=setTimeout(()=>rows.delete(row.id),24*60*60*1000);row.timer.unref();}
 return {ok:true,items:pending.map(r=>({sourceId:r.id,name:r.name,type:r.type,size:r.size,url:new URL('/_app-sources/'+r.id+'/'+encodeURIComponent(r.name),binding.origin).href}))};
 }finally{picking.delete(scope);}
}
async function resolve(scope,binding,id){const row=rows.get(id);if(!row||row.scope!==scope||row.origin!==binding.origin)throw Error('本地图片引用已失效，请重新选择');const st=await inspect(row.path);if(!same(st,row.stat))throw Error('原图片已变化，请重新选择');return row;}
module.exports={select,resolve,same};
