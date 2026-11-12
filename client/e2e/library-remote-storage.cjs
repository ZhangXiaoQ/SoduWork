'use strict';
// Real renderer with isolated provider status and API fixtures; no remote mounts.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 90000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), output = path.resolve(client, '../outputs/library-remote-storage');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-library-storage-'));
  fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  // Keep isolated screenshot rendering portable across CI graphics environments.
  app.disableHardwareAcceleration();
  const report = { ok: false, boundary: 'Production panel/dialog in real Electron, synthetic status and API calls. No MinIO/NFS server or user data.', cases: [] };
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) { for (let i = 0; i < 100; i++) { if (await js(code)) return; await delay(25); } throw Error('Timed out: ' + code); }
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click();void 0;`);
  const available = backend => ({ backend, configured: true, available: true, connected: true, ...(backend === 'nfs' || backend === 'minio' ? { quotaBytes: 1073741824, usedBytes: 123, remainingBytes: 1073741701 } : {}) });
  async function status(value) {
    await js(`window.fixtureStatus=${JSON.stringify(value)};openLibraryPanel();void 0;`);
    await until('!document.querySelector("[data-library-menu-toggle=create]").disabled || document.querySelector("[data-library-state]").textContent.includes("加载失败")');
  }
  async function upload(name = 'fixture.txt') {
    await js(`(()=>{const input=document.querySelector('[data-library-upload]'),d=new DataTransfer();d.items.add(new File(['fixture'],${JSON.stringify(name)}));input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true}));})();`);
    await until('!document.querySelector("[data-library-menu-toggle=create]").disabled');
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1280, height: 840, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await win.loadFile(path.join(__dirname, 'fixtures/library.html'));
    await js(`window.calls=[];window.notices=[];window.batchFixture=false;window.batchCopyFail=false;window.fixtureStatus={storage:{local:{available:true},remote:{backend:'nfs',configured:true,available:true,connected:true,quotaBytes:1073741824,usedBytes:123,remainingBytes:1073741701},nfs:{configured:true,available:true},minio:{configured:false,available:false}}};
      window.petSay=m=>notices.push(m);window.waitList=false;window.releaseList=null;window.waitUpload=false;window.releaseUpload=null;
      window.statusCalls=0;
      window.SoduWorkAPI={taskStorageKey:()=> 'storage-fixture',getLibraryStorageStatus:async()=>{statusCalls++;return fixtureStatus;},
        listLibrary:async filters=>{calls.push({op:'list',...filters});const batchItems=window.batchFixture&&filters.storage==='local'?[{id:'local-batch-a',title:'batch-a.txt',filename:'batch-a.txt',kind:'document',backend:'local',size:3},{id:'local-batch-b',title:'batch-b.txt',filename:'batch-b.txt',kind:'document',backend:'local',size:4}]:[{id:filters.storage==='local'?'local-fixture':'file-'+filters.storage,title:'fixture.txt',filename:'fixture.txt',kind:'document',backend:filters.storage,size:7}];const result={items:filters.folderId?[]:batchItems,folders:filters.folderId?[]:[{id:'folder-'+filters.storage,name:'目录',backend:filters.storage}],folder:filters.folderId?{id:filters.folderId,name:'目录',backend:filters.storage}:null,trashCount:1};if(waitList){waitList=false;await new Promise(r=>releaseList=r);}return result;},
        uploadLibraryFile:async(file,folderId,storage)=>{calls.push({op:'upload',name:file.name,folderId,storage});if(waitUpload)await new Promise(r=>releaseUpload=r);return{ok:true};},
        createLibraryFolder:async(name,parentId,storage)=>{calls.push({op:'folder',name,parentId,storage});return{folder:{id:'new-'+storage,backend:storage}};},
        createLibraryItem:async body=>{calls.push({op:'document',...body});return{ok:true};},
        updateLibraryItem:async(id,body)=>{calls.push({op:'update',id,...body});return{ok:true};},
        copyLocalLibraryItemToRemote:async(id,storage)=>{calls.push({op:'copy',id,storage});return{ok:true};},
        copyLocalLibraryItemsToRemote:async(ids,target)=>{calls.push({op:'batch-copy',ids:[...ids],target:typeof target==='string'?target:target.storage});return window.batchCopyFail?{ok:true,succeeded:[],failed:ids.map(id=>({id,code:'UPSTREAM_DOWN',message:'远端不可用'}))}:{ok:true,succeeded:ids.map(id=>({id,result:{ok:true}})),failed:[]};},
        updateLibraryFolder:async(id,body)=>{calls.push({op:'folder-update',id,...body});return{ok:true};},
        emptyLibraryTrash:async storage=>{calls.push({op:'empty',storage});return{ok:true};}
      };void 0;`);
    for (const file of ['library-file-icons', 'panels-library-dialogs', 'panels-library']) await js(fs.readFileSync(path.join(client, 'components/panels/' + file + '.js'), 'utf8') + '\nvoid 0;');
    await js('openLibraryPanel();void 0;'); await until('document.querySelector("[data-library-storage=remote]")&&!document.querySelector("[data-library-storage=remote]").disabled');
    assert.equal(await js('document.querySelectorAll("[data-library-storage]").length'), 2);
    assert.equal(await js('document.querySelector("[data-library-storage=remote]").title'), '远程存储已连接 · 剩余 100%');
    assert.equal(await js('document.querySelector("[data-library-storage-quota=remote]")'), null);
    for (const [remainingBytes, percent] of [[805306368, 75], [0, 0], [1073741824, 100]]) {
      await status({ storage: { local: available('local'), remote: { ...available('nfs'), remainingBytes }, nfs: available('nfs') } });
      await until(`document.querySelector('[data-library-storage=remote]').title === '远程存储已连接 · 剩余 ${percent}%'`);
      assert.equal(await js('document.querySelector("[data-library-storage-quota=remote]")'), null);
      assert.equal(await js('document.querySelector("[data-library-storage=remote]").title'), `远程存储已连接 · 剩余 ${percent}%`);
      assert.equal(await js('document.querySelector("[data-library-storage-status=remote]").title'), `远程存储已连接 · 剩余 ${percent}%`);
    }
    await status({ storage: { local: available('local'), remote: { ...available('nfs'), remainingBytes: null }, nfs: available('nfs') } });
    await until('document.querySelector("[data-library-storage=remote]").title === "远程存储已连接"');
    assert.equal(await js('document.querySelector("[data-library-storage=remote]").title'), '远程存储已连接');
    await status({ storage: { local: available('local'), remote: available('nfs'), nfs: available('nfs') } });
    await until('document.querySelector("[data-library-storage=remote]").title === "远程存储已连接 · 剩余 100%"');
    win.showInactive();
    await delay(150);
    fs.writeFileSync(path.join(output, 'quota-percent.png'), (await win.webContents.capturePage()).toPNG());
    win.hide();
    report.cases.push('No capacity summary element is rendered; only the remote tooltip updates for partial, full and empty storage, and unknown quota clears the old percentage');
    const requestsBeforeHover = await js('({status:statusCalls,list:calls.filter(c=>c.op==="list").length})');
    await js(`(()=>{const tab=document.querySelector('[data-library-storage=remote]');for(let i=0;i<20;i++){tab.dispatchEvent(new MouseEvent('mouseenter'));tab.dispatchEvent(new MouseEvent('mouseleave'));}tab.focus();})();`);
    await delay(80);
    assert.deepEqual(await js('({status:statusCalls,list:calls.filter(c=>c.op==="list").length})'), requestsBeforeHover);
    assert.equal(await js('document.querySelector("[data-library-storage=remote]").title'), '远程存储已连接 · 剩余 100%');
    report.cases.push('Repeated hover and keyboard focus do not issue status probes or list reads');
    await click('[data-library-migrate=local-fixture]'); await until('document.querySelector(".library-confirm-dialog")');
    await click('[data-library-confirm-cancel]'); await delay(30);
    assert.equal(await js('calls.some(c=>c.op==="copy")'), false);
    await click('[data-library-migrate=local-fixture]'); await until('document.querySelector(".library-confirm-dialog")');
    // Refresh the server-selected provider while a local migration is awaiting
    // confirmation. The old confirmation must never write to the old provider.
    await status({ storage: { local: available('local'), remote: available('minio'), nfs: available('nfs'), minio: available('minio') } });
    await js('document.querySelector(".library-confirm-submit")?.click();void 0;'); await delay(40);
    assert.equal(await js('calls.some(c=>c.op==="copy")'), false);
    report.cases.push('Cancel and a changed remote provider cannot submit a stale local-file migration');
    await status({ storage: { local: available('local'), remote: available('nfs'), nfs: available('nfs') } });
    await click('[data-library-migrate=local-fixture]'); await until('document.querySelector(".library-confirm-dialog")');
    await js('const submit=document.querySelector(".library-confirm-submit");submit.click();submit.click();void 0;');
    await until('calls.some(c=>c.op==="copy")');
    assert.deepEqual(await js('calls.filter(c=>c.op==="copy")'), [{op:'copy',id:'local-fixture',storage:'nfs'}]);
    assert.equal(await js('calls.some(c=>c.op==="update")'), false);
    assert.ok(await js('document.querySelector("[data-library-migrate=local-fixture]")'));
    await until('!document.querySelector("[data-library-menu-toggle=create]").disabled');
    await js('calls=[];void 0;');
    report.cases.push('Confirmed client-local copy submits once to NFS, never PATCHes storage, and preserves the local item');
    await js('batchFixture=true;void 0;');
    await status({ storage: { local: available('local'), remote: available('nfs'), nfs: available('nfs') } });
    await until('document.querySelector("[data-library-select=local-batch-a]")&&document.querySelector("[data-library-select=local-batch-b]")');
    await click('[data-library-select=local-batch-a]'); await click('[data-library-select=local-batch-b]');
    await until('document.querySelector("[data-library-batch-migrate]")&&!document.querySelector("[data-library-batch-migrate]").hidden');
    await click('[data-library-batch-migrate]'); await until('document.querySelector(".library-confirm-dialog")');
    await click('.library-confirm-submit'); await until('calls.some(c=>c.op==="batch-copy")');
    assert.deepEqual(await js('calls.find(c=>c.op==="batch-copy")'), { op: 'batch-copy', ids: ['local-batch-a', 'local-batch-b'], target: 'nfs' });
    await until('!document.querySelector("[data-library-menu-toggle=create]").disabled');
    assert.equal(await js('document.querySelector("[data-library-batch-migrate]").hidden'), true);
    report.cases.push('Selected local materials are copied in one ordered batch to NFS and successful selections clear');
    await js('batchCopyFail=true;calls=[];void 0;');
    await click('[data-library-select=local-batch-a]'); await until('!document.querySelector("[data-library-batch-migrate]").hidden');
    await click('[data-library-batch-migrate]'); await until('document.querySelector(".library-confirm-dialog")');
    await click('.library-confirm-submit'); await until('calls.some(c=>c.op==="batch-copy")');
    assert.equal(await js('document.querySelector("[data-library-select=local-batch-a]").checked'), true);
    await js('batchCopyFail=false;void 0;');
    report.cases.push('A partial batch failure keeps the failed local selection for retry');
    await click('[data-library-storage=remote]'); await until('document.querySelector("[data-library-file-preview=file-nfs]")');
    await upload();
    assert.equal(await js('calls.find(c=>c.op==="upload").storage'), 'nfs');
    report.cases.push('NFS-only configuration enables one generic remote tab; listing and upload pin the NFS backend');

    await click('[data-library-create-kind=folder]'); await until('document.querySelector("[data-library-folder-name]")');
    await js('document.querySelector("[data-library-folder-name]").value="NFS folder";document.querySelector(".library-folder-editor").requestSubmit();void 0;');
    await until('calls.some(c=>c.op==="folder")'); assert.equal(await js('calls.find(c=>c.op==="folder").storage'), 'nfs');
    assert.equal(await js('document.querySelector("[data-library-create-kind=document]")'), null);
    await click('[data-library-filter-kind=document]');
    assert.ok(await js('document.querySelector("[data-library-file-preview=file-nfs]") !== null'));
    await click('[data-library-move=file-nfs]'); await until('document.querySelector("[data-library-move-folder=folder-nfs]")');
    await click('[data-library-move-folder=folder-nfs]'); await until('calls.some(c=>c.op==="update")');
    assert.equal(await js('calls.find(c=>c.op==="update").storage'), 'nfs');
    report.cases.push('New folder, existing-document filtering and move operations retain the selected concrete provider');

    await status({ storage: { local: available('local'), remote: available('minio'), minio: available('minio'), nfs: available('nfs') }, remoteOrder: ['minio', 'nfs'] });
    await until('document.querySelector("[data-library-file-preview=file-minio]")');
    assert.equal(await js('document.querySelector("[data-library-storage=remote]").title'), '远程存储已连接 · 剩余 100%');
    await status({ storage: { local: available('local'), remote: available('nfs'), minio: available('minio'), nfs: available('nfs') }, remoteOrder: ['nfs', 'minio'] });
    await until('document.querySelector("[data-library-file-preview=file-nfs]")');
    report.cases.push('When both providers exist, server-selected first configured provider controls the remote tab and refresh resets the old provider view');

    await js('waitUpload=true;(()=>{const input=document.querySelector("[data-library-upload]"),d=new DataTransfer();d.items.add(new File(["a"],"first.txt"));d.items.add(new File(["b"],"second.txt"));input.files=d.files;input.dispatchEvent(new Event("change",{bubbles:true}));})();');
    await until('!!releaseUpload');
    await status({ storage: { local: available('local'), remote: available('minio'), minio: available('minio'), nfs: available('nfs') } });
    await until('document.querySelector("[data-library-file-preview=file-minio]")');
    await js('waitUpload=false;releaseUpload();void 0;'); await delay(50);
    assert.equal(await js('calls.find(c=>c.op==="upload"&&c.name==="first.txt").storage'), 'nfs');
    assert.equal(await js('calls.some(c=>c.op==="upload"&&c.name==="second.txt")'), false);
    assert.equal(await js('document.querySelector("[data-library-storage=remote]").getAttribute("aria-selected")'), 'true');
    report.cases.push('A provider change never redirects an in-flight upload; remaining files in the old batch are canceled');
    await click('[data-library-create-kind=folder]'); await until('document.querySelector("[data-library-folder-name]")');
    await status({ storage: { local: available('local'), remote: available('nfs'), minio: available('minio'), nfs: available('nfs') } });
    await until('document.querySelector("[data-library-file-preview=file-nfs]")');
    assert.equal(await js('document.querySelector("[data-library-folder-name]")'), null);
    report.cases.push('A configuration change closes a pending folder dialog instead of creating it in a newly selected provider');

    await js('window.waitList=true;openLibraryPanel();void 0;'); await until('!!releaseList');
    await status({ storage: { local: available('local'), remote: { backend: 'nfs', configured: true, available: false, connected: false, message: 'NFS mount unavailable' }, minio: available('minio'), nfs: { configured: true, available: false } }, remoteOrder: ['nfs', 'minio'] });
    await js('releaseList();void 0;'); await delay(80);
    assert.equal(await js('document.querySelector("[data-library-storage=remote]").getAttribute("aria-selected")'), 'true');
    assert.equal(await js('document.querySelector("[data-library-menu-toggle=create]").disabled'), true);
    assert.match(await js('document.querySelector("[data-library-state]").textContent'), /NFS mount unavailable/);
    assert.equal(await js('document.querySelector("[data-library-storage-quota=remote]")'), null);
    // The 2026-10-22 cache contract preserves the last successful view during
    // outages. An outage must still block writes and cannot pick another backend.
    assert.deepEqual(await js('[...document.querySelectorAll("[data-library-file-preview]")].map(node=>node.dataset.libraryFilePreview)'), ['file-nfs']);
    assert.equal(await js('document.querySelector("[data-library-storage=local]").getAttribute("aria-selected")'), 'false');
    assert.equal(await js('document.querySelector("[data-library-create-kind=upload]").disabled'), true);
    const count = await js('calls.filter(c=>c.op==="upload").length');
    await js('(()=>{const input=document.querySelector("[data-library-upload]"),d=new DataTransfer();d.items.add(new File(["x"],"blocked.txt"));input.files=d.files;input.dispatchEvent(new Event("change",{bubbles:true}));})();');
    await delay(50); assert.equal(await js('calls.filter(c=>c.op==="upload").length'), count);
    report.cases.push('Unavailable first provider retains exactly the cached NFS item and error, blocks writes, and never switches to MinIO or local');

    await js(`fixtureStatus=${JSON.stringify({ storage: { local: available('local'), remote: available('nfs'), nfs: available('nfs') } })};void 0;`);
    await click('[data-library-retry]'); await until('document.querySelector("[data-library-file-preview=file-nfs]")');
    assert.equal(await js('document.querySelector("[data-library-menu-toggle=create]").disabled'), false);
    report.cases.push('Retry refreshes the provider status and restores the same remote backend when it becomes available');

    await click('[data-library-storage=local]');
    await status({ local: available('local'), minio: available('minio') });
    await click('[data-library-storage=remote]'); await until('document.querySelector("[data-library-file-preview=file-minio]")');
    report.cases.push('Legacy Hub minio-only capability responses continue to enable remote storage');
    await click('[data-library-storage=local]');
    await status({ storage: { local: available('local'), remote: { backend: '', configured: false, available: false }, minio: { configured: false }, nfs: { configured: false } } });
    assert.equal(await js('document.querySelector("[data-library-storage=remote]").disabled'), true);
    assert.equal(await js('document.querySelector("[data-library-storage=local]").getAttribute("aria-selected")'), 'true');
    assert.equal(await js('document.querySelector("[data-library-migrate]")'), null);
    report.cases.push('No configured provider disables remote storage while local remains usable');
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    if (win && !win.isDestroyed()) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
