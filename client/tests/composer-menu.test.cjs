'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('./renderer-source.cjs');
const path=require('node:path');
const vm=require('node:vm');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
function composer(){
 const window={addEventListener(){}};
 const context=vm.createContext({window,innerWidth:1000,innerHeight:800});
 vm.runInContext(read('components/panels/work-composer.js'),context);
 return {window,context,api:window.WorkComposer};
}
test('Agent label retains popup semantics without a decorative chevron',()=>{
 const {api,context}=composer();context.WorkComposer=api;
 vm.runInContext(read('components/panels/panels-compose-runtime.js'),context);
 const html=context.window.ComposeRuntime.controls(api.icons.ability);
 assert.match(html,/id="cpRuntime" aria-haspopup="true"/);
 assert.doesNotMatch(html,/class="wc-chevron"/);
 assert.match(api.contextButton({id:'permission',popup:true}),/class="wc-chevron"/);
});

test('existing workspace uses a static label while the new-draft workspace remains a picker',()=>{
 const {api}=composer();
 const label=api.contextButton({id:'nchatWd',valueId:'nchatWdName',label:'Work location',value:'saved-folder',readOnly:true});
 assert.match(label,/^<span class="wc-context-button wc-context-static"/);
 assert.doesNotMatch(label,/<button|tabindex|aria-haspopup/);
 const picker=api.contextButton({id:'cpWorkspace',label:'Work location',popup:true});
 assert.match(picker,/^<button/);assert.match(picker,/aria-haspopup="true"/);
});
test('plugin library navigation prefers the workspace router and supports detached fallback',()=>{
 const {api,window}=composer(),calls=[];
 window.WorkspaceHost={open:(...args)=>calls.push(args)};
 window.openCapabilityPanel=()=>calls.push(['legacy']);
 api.openPlugins();assert.equal(calls[0][0],'skills');assert.equal(calls.length,1);
 delete window.WorkspaceHost;api.openPlugins();assert.equal(calls[1][0],'legacy');
});

test('start and active chat menus share the full plugin list and availability',()=>{
 const {api,window}=composer();
 window.ChatPluginMention={availability:item=>item.conversationUse};
 const plugins=Array.from({length:15},(_,i)=>({pluginId:'p'+i,name:'Plugin '+i,
   description:'Use <files>',conversationUse:{available:i!==3,label:'Unavailable'}}));
 const html=api.pluginRows(plugins,[{pluginId:'p14'}]);
 assert.equal((html.match(/data-more-plugin=/g)||[]).length,15);
 assert.match(html,/data-more-plugin="p14" aria-pressed="true"/);
 assert.match(html,/data-more-plugin="p3"[^>]* disabled/);
 assert.match(html,/Use &lt;files&gt;/);
 assert.match(api.pluginSection('nchatMorePlugins','nchatPlugins'),/查看全部/);
 assert.match(api.pluginRows([],[]),/还没有安装插件/);
});
test('menu fits its clipped workspace and opens upward near the bottom edge',()=>{
 const {api}=composer();
 const popup={hidden:false,style:{},closest:()=>({getBoundingClientRect:()=>({left:220,right:990,top:10,bottom:790})}),
  getBoundingClientRect:()=>({left:640,right:1220})};
 api.placeMore({getBoundingClientRect:()=>({top:690,bottom:720})},popup);
 assert.equal(popup.style.top,'auto');assert.equal(popup.style.left,'-242px');
 assert.equal(popup.style.maxHeight,'480px');
});
test('menu opens downward where sufficient room remains',()=>{
 const {api}=composer();
 const popup={hidden:false,style:{},closest:()=>null,getBoundingClientRect:()=>({left:80,right:660})};
 api.placeMore({getBoundingClientRect:()=>({top:100,bottom:130})},popup);
 assert.equal(popup.style.bottom,'auto');assert.equal(popup.style.left,'0px');
});
test('composer hint hides on input focus and returns on blur',()=>{
 const {api,context}=composer();
 const events={}, classes=new Set();
 const input={value:'',addEventListener:(name,fn)=>{events[name]=fn}};
 const rail={attrs:{},setAttribute:(name,value)=>{rail.attrs[name]=value}};
 const node={querySelector:selector=>selector==='.wc-input'?input:rail,
   classList:{add:name=>classes.add(name),toggle:(name,on)=>{if(on)classes.add(name);else classes.delete(name)}}};
 context.document={activeElement:null};
 api.bindPlaceholder(node);
 assert.equal(classes.has('wc-input-focused'),false);
 context.document.activeElement=input; events.focus();
 assert.equal(classes.has('wc-input-focused'),true);
 context.document.activeElement=null; events.blur();
 assert.equal(classes.has('wc-input-focused'),false);
});
test('explicit plugin pick uses the existing selection controller, not catalog navigation',()=>{
 const source=read('components/panels/panels-compose.js');
 const handler=source.slice(source.indexOf("p.querySelector('#cpMorePlugins').addEventListener"),source.indexOf("p.querySelector('#cpCapList').addEventListener"));
 assert.match(handler,/const current = ctx\.menuSelectionGuard\(\)/);
 assert.match(handler,/_pluginMention\.select\(button\.dataset\.morePlugin, current, \{ keepText: true \}\)/);
 assert.match(handler,/if \(current\(\)\) ctx\._closeMore\(\)/);
 assert.doesNotMatch(handler,/openPlugins\(|openComposePanel\(|makeDraft\(/);
 assert.match(source,/ChatPluginMention\.normalizeCatalog\(result\)/);
 assert.doesNotMatch(source,/_plugins\.slice\(0, 6\)/);
 const mention=read('components/panels/chat-plugin-mention.js');
 assert.match(mention,/async select\(pluginId(?:, isCurrent)?(?:, options)?\)\s*\{[^]*?close\(\);[^]*?const key/);
});
test('plugin-center launch waits for asynchronous selection before the first send',()=>{
 const source=read('components/panels/panels-compose.js');
 assert.match(source,/let _pluginSelectTask = Promise\.resolve\(\)/);
 assert.match(source,/let _pluginSelectSeq = 0/);
 assert.match(source,/await _pluginSelectTask/);
 assert.match(source,/if \(_pluginSelectError\) return false/);
 assert.match(source,/const selectionSeq = _pluginSelectSeq/);
 assert.match(source,/selectionSeq !== _pluginSelectSeq/);
 assert.match(source,/_pluginSelectTask = selection\.catch/);
});
test('pending plugin send is invalidated when the visible conversation changes',()=>{
 const source=read('components/panels/panels-compose.js');
 assert.match(source,/let _composeViewSeq = 0/);
 assert.match(source,/const viewSeq = _composeViewSeq/);
 assert.match(source,/if \(viewSeq !== _composeViewSeq\) return false/);
 assert.match(source,/_composeViewSeq \+= 1/);
});
test('delete action is visible in the chat menu and preserves the existing delete handler',()=>{
 const source=read('components/workspace/workspace-shell.js');
 assert.match(source,/remove\.className = 'ws-chat-delete ws-chat-menu-item'/);
 assert.match(source,/focusable="false"[^]*<\/svg><span>删除<\/span>/);
 assert.match(source,/try \{ await deleteHistoryChat\(id\); \}/);
 assert.match(source,/remove\.hidden = !canDelete/);
 assert.match(source,/remove\.disabled = !canDelete/);
 const css=read('components/workspace/workspace-shell.css');
 assert.match(css,/\.ws-chat-delete svg\{width:17px;height:17px;stroke-width:1\.5\}/);
 assert.match(css,/\.ws-chat-menu \.ws-chat-delete\{width:100%;height:auto/);
});
