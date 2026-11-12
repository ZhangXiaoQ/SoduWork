'use strict';
// Production decorators and actual Chromium DOM; isolated, no model or service.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('error', error => { console.error(error); process.exitCode = 1; })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const output = path.resolve(__dirname, '../../outputs/chat-delivery-previews');
  fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-delivery-previews-')));
  const report = { ok: false, cases: [] }; let win;
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: false, nodeIntegration: false } });
    await win.loadURL('data:text/html;charset=utf-8,<textarea id="cpInput" hidden>home draft</textarea><main class="nchat"><div id="messages"></div><textarea id="nchatInput">keep this draft</textarea></main>');
    const js = async source => {
      const value = await win.webContents.executeJavaScript('(async()=>{try{return await (0,eval)(' + JSON.stringify(source) + ')}catch(error){return{fixtureError:error.stack}}})()', true);
      if (value?.fixtureError) throw Error(value.fixtureError + '\nSource: ' + source);
      return value;
    };
    const click = async selector => {
      const point = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
      await new Promise(resolve => setTimeout(resolve, 60));
    };
    await win.webContents.insertCSS(':root{--line:#dde2e8;--ink:#232b35;--ink-2:#303946;--ink-3:#66717f;--bg-0:#fff;--bg-1:#f6f7f9;--accent:#387eed;--font-ui:system-ui}body{font:15px system-ui;margin:20px;background:var(--bg-0);color:var(--ink)}body.dark{--line:#414a56;--ink:#e9eef5;--ink-2:#d5dde8;--ink-3:#b3bdcc;--bg-0:#1c2028;--bg-1:#242b36;--accent:#8bb8ff}.nchat{max-width:560px;margin:auto}textarea{box-sizing:border-box;width:100%;margin-top:24px}');
    await win.webContents.insertCSS(fs.readFileSync(path.resolve(__dirname, '../components/panels/chat-deliveries.css'), 'utf8'));
    const nativeIcon = await app.getFileIcon(path.resolve(__dirname, '../desk.html'));
    await js('window.soduWorkAPI={fileTypeIcon:async()=>({ok:true,dataUrl:' + JSON.stringify(nativeIcon.toDataURL()) + '})};void 0;');
    await js(`window.currentScope='owner-a';window.currentRef='delivery-chat';window.events=[];window.notices=[];
      window.NativeChat={sessionInfo:()=>({ref:currentRef})};window.petSay=text=>notices.push(text);
      window.SoduWorkAPI={taskStorageKey:()=>currentScope,saveLibraryDelivery:async payload=>({ok:true,delivery:{id:'saved',files:[{path:'index.html',size:1}]}})};
      addEventListener('soduwork-cloud-delivery-continue',event=>events.push(event.detail));
      window.site={artifactId:'site',name:'index.html',relative:'index.html',primary:true,changedInTurn:true,at:1};
      window.shot={artifactId:'shot',name:'screenshot.png',relative:'screens/screenshot.png',primary:false,processEvidence:true,at:2};
      window.base='<article class="nmsg user" data-chat-node="message:0">Build</article>'+ '<article class="nmsg ai" data-chat-node="message:1" data-delivery-final="false"><span data-output-image-ref="screens/screenshot.png">Screenshot</span></article>'+ '<article class="nmsg ai" data-chat-node="message:2" data-delivery-final="true"><div class="ntext"><a href="index.html">Website</a></div></article>';
      window.calls=[];window.api={inspectDelivery:async(ref,ids)=>{calls.push(['inspect',ids]);return{ok:true,manifest:{files:[{path:'index.html',size:1}]}}},prepareDelivery:async(ref,ids)=>{calls.push(['prepare',ids]);return{ok:true,manifest:{files:[{path:'index.html',size:1}]}}}};
      messages.addEventListener('click',event=>{if(event.target.closest('[data-delivery-retry],[data-delivery-open],[data-delivery-local]'))void ChatDeliveries.handle(event.target,api)});
      window.render=(html,files,snapshot={},previous=null)=>messages.innerHTML=ChatOutputLinks.decorate(html,files,currentRef,{status:'idle',...snapshot},previous);void 0;`);
    for (const name of ['chat-dom-patch.js', 'panels-chat-tools.js', 'library-file-icons.js', 'chat-deliveries.js', 'chat-output-links.js']) await js(fs.readFileSync(path.resolve(__dirname, '../components/panels', name), 'utf8'));
    await js('render(base,[site,shot]);');
    assert.equal(await js('messages.querySelector("[data-delivery-continue]")'), null, 'file actions replace the retired continue shortcut');
    assert.equal(await js('messages.querySelector("[data-delivery-retry]").hidden'),false);
    assert.equal(await js('messages.querySelectorAll(".noutput-image").length'), 1);
    assert.equal(await js('messages.querySelectorAll(".ndelivery").length'), 1);
    assert.equal(await js('messages.querySelectorAll("[data-output-image=shot]").length'), 1);
    assert.equal(await js('messages.querySelector(".ndelivery").closest("article").dataset.chatNode'), 'message:2');
    await js('ChatDeliveries.hydrate(messages,{api,ref:currentRef,snapshot:{status:"idle"}});');
    await js('ChatDeliveries.handle(messages.querySelector("[data-delivery-retry]"),api)');
    assert.equal(await js('calls.every(row=>row[1].length===1&&row[1][0]==="site")'), true);
    assert.equal(await js('messages.querySelectorAll("[data-output-image=shot]").length'), 1);
    assert.equal(await js('messages.querySelector("[data-delivery-files-count]").textContent'), '1 个文件');
    report.cases.push('Explicit evidence appears above its final delivery without entering inspect, save or file-count collections');

    await js(`window.titledSite={...site,artifactId:'titled-site',kind:'website',title:'四季花园'};
      window.websiteManifest={title:'成果包',files:[{path:'index.html',size:1},{path:'style.css',size:2}]};
      window.titleCalls=[];window.titleApi={inspectDelivery:async(ref,ids)=>{titleCalls.push(['inspect',ids]);return{ok:true,manifest:websiteManifest}},prepareDelivery:async(ref,ids)=>{titleCalls.push(['prepare',ids]);return{ok:true,manifest:websiteManifest}}};
      window.SoduWorkAPI.saveLibraryDelivery=async()=>({ok:true,delivery:{id:'saved-website',...websiteManifest}});
      render(base,[titledSite,shot]);ChatDeliveries.hydrate(messages,{api:titleApi,ref:currentRef,snapshot:{status:'idle'}});void 0;`);
    await js('new Promise(resolve=>setTimeout(resolve,0))');
    assert.equal(await js('messages.querySelector("[data-delivery-title]").textContent'), '四季花园.zip', 'a website package retains its title and archive suffix after dependency inspection');
    await js('ChatDeliveries.handle(messages.querySelector("[data-delivery-retry]"),titleApi)');
    assert.equal(await js('messages.querySelector("[data-delivery-title]").textContent'), '四季花园.zip', 'a website package retains its title and archive suffix after saving');
    assert.equal(await js('titleCalls.every(row=>row[1].length===1&&row[1][0]==="titled-site")'), true);
    assert.equal(await js('messages.querySelectorAll("[data-output-image=shot]").length'), 1);
    for (const variant of ['multiple', 'archive']) {
      await js(`window.titleVariant=${JSON.stringify(variant)};
        render('<article class="nmsg ai">Done</article>',titleVariant==='multiple'?[{...titledSite,artifactId:'multi-site'}, {...site,artifactId:'other-result',name:'notes.md',relative:'notes.md',kind:'document'}]:[{...site,artifactId:'archive',name:'site.zip',relative:'site.zip',kind:'archive',title:'Website export'}]);
        ChatDeliveries.hydrate(messages,{api:titleApi,ref:currentRef,snapshot:{status:'idle'}});void 0;`);
      await js('new Promise(resolve=>setTimeout(resolve,0))');
      assert.equal(await js('messages.querySelector("[data-delivery-title]").textContent'), '成果包.zip', variant + ' retains the package title and archive suffix');
    }
    report.cases.push('A single website keeps its explicit title through multi-file inspection/save; multiple primary outputs and archives keep package naming, evidence stays out of selections');

    await js('render(base,[site]);window.prior=messages.cloneNode(true);render(base,[site,shot],{},prior);');
    assert.equal(await js('messages.querySelectorAll(".ndelivery").length'), 1);
    assert.equal(await js('messages.querySelectorAll("[data-output-image=shot]").length'), 1);
    // Direct decoration covers a retained, already-hydrated card receiving a late preview entry.
    await js('window.card=messages.querySelector(".ndelivery");window.late=document.createElement("button");late.className="noutput-image";late.dataset.outputImage="late";late.textContent="late.png";card.parentElement.append(late);ChatDeliveries.decorate(messages,[site,shot,{artifactId:"late",name:"late.png",processEvidence:true,primary:false}],currentRef,{status:"idle"});');
    assert.equal(await js('messages.querySelector(".ndelivery")===card&&late.nextElementSibling===card'), true);
    report.cases.push('Late screenshots update existing groups, including retained hydrated cards');
    await js(`render(base,[site,shot]);window.imageReads=[];window.imageApi={artifactAction:(ref,id,mode)=>new Promise(resolve=>imageReads.push({ref,id,mode,resolve}))};
      ChatOutputLinks.hydrateImages(messages,[site,shot],{ref:currentRef,api:imageApi});
      window.loadingImage=messages.querySelector('[data-output-image=shot]');window.clonedImage=loadingImage.cloneNode(true);loadingImage.replaceWith(clonedImage);
      ChatOutputLinks.hydrateImages(messages,[site,shot],{ref:currentRef,api:imageApi});
      window.imageReply={ok:true,mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='};
      imageReads[0].resolve(imageReply);imageReads[1].resolve(imageReply);void 0;`);
    await js('new Promise(resolve=>setTimeout(resolve,0))');
    assert.equal(await js("messages.querySelectorAll('[data-output-image=shot] img').length"), 1);
    assert.equal(await js("clonedImage.nextElementSibling.matches('.ndelivery')"), true);
    assert.equal(await js("imageReads.every(row=>row.ref===currentRef&&row.id==='shot'&&row.mode==='image')"), true);
    await js(`render(base,[site,shot]);ChatOutputLinks.hydrateImages(messages,[site,shot],{ref:currentRef,api:imageApi});currentScope='changed-image-owner';imageReads.at(-1).resolve(imageReply);void 0;`);
    await js('new Promise(resolve=>setTimeout(resolve,0))');
    assert.equal(await js("messages.querySelectorAll('[data-output-image=shot] img').length"), 0);
    await js("currentScope='owner-a';void 0;");
    report.cases.push('Inline images use authorized thumbnail reads, recover copied loading nodes, remain above delivery, and discard late bytes after account changes');


    await js('render(base,[shot],{delivery:{presentation:"summary"}});');
    assert.equal(await js('messages.querySelectorAll("[data-output-image=shot]").length'), 1);
    assert.equal(await js('messages.querySelectorAll("[data-delivery-retry],[data-delivery-archive],[data-delivery-local]").length'), 0);
    await js(`render('<article class="nmsg ai"><span data-output-image-ref="art.png">Art</span></article>',[{artifactId:'art',name:'art.png',relative:'art.png',primary:true,changedInTurn:true}]);`);
    assert.equal(await js('messages.querySelectorAll(".ndelivery").length'), 1);
    assert.equal(await js('messages.querySelectorAll(".noutput-image").length'), 1);
    assert.equal(await js('messages.querySelectorAll(".ndelivery-preview").length'), 0);
    report.cases.push('Summary-only evidence remains previewable; a primary image has one ordinary delivery group');

    // File actions preserve the draft; saved-file previews replace the retired continue shortcut.
    await js(`render(base,[site,shot]);nchatInput.setSelectionRange(2,6);nchatInput.blur();
      window.savedOpens=[];window.ChatWorkbench={openSavedDelivery:(id,options)=>{savedOpens.push({id,title:options.title});return true}};void 0;`);
    await click('[data-delivery-open]');
    assert.equal(await js('savedOpens.at(-1).id'),'saved');
    assert.deepEqual(await js('[nchatInput.value,nchatInput.selectionStart,nchatInput.selectionEnd]'),['keep this draft',2,6]);
    await js('window.oldOpen=messages.querySelector("[data-delivery-open]");currentScope="owner-b";ChatDeliveries.handle(oldOpen,api);');
    assert.equal(await js('savedOpens.length'),1,'a retained card cannot open another account\'s saved delivery');
    report.cases.push('Saved-file preview preserves the draft and selection; account changes reject retained cards');

    await js(`currentScope='owner-a';render(base.replace('data-delivery-final="true"','data-delivery-final="true" data-delivery-current="false"'),[{...site,changedInTurn:false},shot]);`);
    await click('[data-delivery-open]');
    assert.equal(await js('savedOpens.length'),2);
    assert.equal(await js('nchatInput.value'),'keep this draft');
    report.cases.push('Historical saved deliveries open without replacing the current conversation draft');

    await js(`window.localCalls=[];window.localOpens=[];
      window.WorkspaceHost={open:async(name,options)=>{localOpens.push({name,options});return true}};
      api.continueLocalDelivery=async(ref,ids)=>{localCalls.push({ref,ids});return{ok:true,files:[{path:'index.html'}]}};
      render('<article class="nmsg ai" data-output-task="cloud-task">Done</article>',[{...site,cloudTaskId:'cloud-task',remoteMaterialized:true,role:'output'}],{cloudHandoff:{taskId:'cloud-task'}});`);
    await click('[data-delivery-local]');
    assert.deepEqual(await js('localCalls.at(-1)'),{ref:'delivery-chat',ids:['site']});
    assert.equal(await js('localOpens.at(-1).name'),'create');
    assert.equal(await js('localOpens.at(-1).options.newSession'),true);
    assert.equal(await js('nchatInput.value'),'keep this draft');
    await js('window.oldLocal=messages.querySelector("[data-delivery-local]");currentRef="different-chat";ChatDeliveries.handle(oldLocal,api);');
    assert.equal(await js('localCalls.length'),1,'a changed conversation cannot continue a retained cloud delivery');
    assert.ok(await js('notices.length>0'));
    await js('currentRef="delivery-chat";currentScope="owner-b";ChatDeliveries.handle(oldLocal,api);');
    assert.equal(await js('localCalls.length'),1);
    await js('currentScope="owner-a";');
    report.cases.push('Cloud delivery continues in a new local conversation, preserves the draft and rejects changed chat/account');
    await js(`currentRef='cloud-revision';window.archiveCalls=[];
      window.localManifest={revision:'b'.repeat(64),files:[{path:'index.html',size:1},{path:'style.css',size:2}]};
      SoduWorkAPI.getTaskLibraryDeliveryStatus=async()=>({delivery:null,manifest:{revision:'a'.repeat(64),files:localManifest.files}});
      window.archiveApi={cloud:{materialize:async()=>({ok:true,artifacts:[{artifactId:'cached-site',remoteAttachmentId:'remote-page',cloudTaskId:'revision-task',relative:'index.html',name:'index.html'}]})},
        inspectDelivery:async()=>({ok:true,manifest:localManifest}),
        openLocalDelivery:async(ref,ids,options)=>{archiveCalls.push({ref,ids,options});return{ok:true}},
        openDeliveryArchive:async(ref,ids,options)=>{archiveCalls.push({ref,ids,options});return{ok:true}}};
      render('<article class="nmsg ai" data-output-task="revision-task">Done</article>',[{...site,taskId:'revision-task',attachmentId:'remote-page',cloudPending:true,role:'output'}],{cloudHandoff:{taskId:'revision-task'}});
      ChatDeliveries.hydrate(messages,{api:archiveApi,ref:currentRef,snapshot:{status:'idle'}});void 0;`);
    await js('new Promise(resolve=>setTimeout(resolve,0))');
    await js('ChatDeliveries.handle(messages.querySelector("[data-delivery-reveal]"),archiveApi)');
    await js('ChatDeliveries.handle(messages.querySelector(".ndelivery-actions [data-delivery-archive]"),archiveApi)');
    assert.deepEqual(await js('archiveCalls.map(call=>call.options)'), [
      {bundle:true,revision:'b'.repeat(64)}, {bundle:true,revision:'b'.repeat(64)},
    ], 'a remote receipt revision must not be used to validate a newly materialized local package');
    await js('delete SoduWorkAPI.getTaskLibraryDeliveryStatus;currentRef="delivery-chat";');
    report.cases.push('Cloud ZIP actions inspect the materialized local revision and reuse it for both open and reveal');
    await js(`render('<article class="nmsg user">Request</article><article class="nmsg ai" data-output-task="task-a" data-delivery-final="false"><span data-output-image-ref="a.png">A</span></article><article class="nmsg ai" data-output-task="task-a" data-delivery-final="true">A done</article><article class="nmsg ai" data-output-task="task-b" data-delivery-final="true"><span data-output-image-ref="b.png">B</span></article>',[{...shot,artifactId:'image-a',relative:'a.png',name:'a.png',taskId:'task-a'},{...shot,artifactId:'image-b',relative:'b.png',name:'b.png',taskId:'task-b'}]);`);
    assert.deepEqual(await js('Array.from(messages.querySelectorAll("[data-output-image]")).map(node=>[node.dataset.outputImage,node.closest("article").dataset.outputTask])'), [['image-a', 'task-a'], ['image-b', 'task-b']]);
    report.cases.push('Simultaneous task screenshots remain attached to their own final message and group');
    await js('render(base,[site,shot]);');
    await js('SoduWorkLibraryFileIcons.hydrate(messages);');
    for (let tries = 0; tries < 30 && !await js('!!messages.querySelector(".library-native-file-icon img:not([hidden])")?.naturalWidth'); tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await js('!!messages.querySelector(".library-native-file-icon img:not([hidden])")?.naturalWidth'), true);
    for (const dark of [false, true]) for (const width of [900, 360]) {
      await js('document.body.classList.toggle("dark",' + dark + ')');
      win.setContentSize(width, 700); await js('new Promise(resolve=>requestAnimationFrame(resolve))');
      assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
      fs.writeFileSync(path.join(output, 'group-' + (dark ? 'dark-' : '') + width + '.png'), (await win.webContents.capturePage()).toPNG());
    }
    report.cases.push('Actual native file icons and combined delivery groups fit light/dark 900 px and 360 px widths');
    report.ok = true; fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); win.destroy(); app.quit();
  }).catch(error => { report.error = error.stack; fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.error(error); app.exit(1); });
}
