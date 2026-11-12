'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-sidebar-lifecycle-'));
  app.setPath('userData', root); app.on('window-all-closed', () => {});
  let win;
  const report = { ok: false, cases: [], errors: [] };
  const js = source => win.webContents.executeJavaScript(source, true);
  async function boot() {
    await win.loadFile(path.join(root, 'fixture.html'));
    await js(`
      window.owner = 'fixture-account'; window.reply = {ok:true,chats:[]}; window.notices = [];
      window.petSay = message => notices.push(message);
      window.SoduWorkAPI = {hubBase:()=> 'http://127.0.0.1:1',
        clientAuthSnapshot:()=>({clientId:'fixture-device',user:{id:owner}})};
      window.soduWorkAPI = {conversationSession:{history:async()=>reply,
        archiveHistory:async id=>({ok:true,id,archived:true,aliasIds:['account-copy','segment','old-copy']}),
        onEvent(){},onEventBatch(fn){window.receive=fn;return ()=>{};}}};
      window.WorkspaceSidebarDrag = {install(){}};
      void 0;`);
    for (const file of ['workspace-chat-history', 'workspace-sidebar-state', 'workspace-sidebar-projects', 'workspace-chat-list']) {
      await js(fs.readFileSync(path.join(client, 'components/workspace', file + '.js'), 'utf8') + '\nvoid 0;');
    }
    await js(`
      window.ctx = {...WorkspaceChatHistory,root:document.querySelector('#root'),
        active:'create',activeChatId:'',chatItems:[],chatNames:new Map(),mount(){},icon:()=>'',wsT:(_key,text)=>text,
        _empty(target,text){const row=document.createElement('div');row.className='ws-list-empty';row.textContent=text;target.append(row);}};
      ctx.chats=document.querySelector('#wsChats');ctx.pinnedChats=document.querySelector('#wsPinnedChats');
      Object.assign(ctx,WorkspaceChatList.create(ctx));
      ctx.sidebarProjects=WorkspaceSidebarProjects.create({root:ctx.root,getItems:()=>ctx.chatItems,render:()=>ctx.renderChats()});
      window.openStore=()=>WorkspaceSidebarState.create(WorkspaceSidebarState.accountOptions({storage:localStorage,api:SoduWorkAPI}));
      window.domIds=()=>[...new Set([...document.querySelectorAll('.ws-chat')].map(row=>row.dataset.chatId))].sort();
      window.row=id=>({id,title:'Same conversation title',at:100,state:'completed'});
      window.seed=()=>{localStorage.clear();const store=openStore();
        const active=store.saveProject({name:'Active group'}),archived=store.saveProject({name:'Archived group'});
        const native={...row('native'),historyAliasIds:['account-copy','segment','old-copy']};
        store.move(native,'pinned','',[native]);store.move(row('account-copy'),'recent','',[row('account-copy')]);
        store.fileChat('segment',active,row('segment'));store.fileChat('old-copy',archived,row('old-copy'));store.archiveProject(archived);
        store.fileChat('independent',active,{...row('independent'),sourceSessionId:'native'});
        ctx.setChats([native,row('independent')]);};
      ctx.subscribeConversationPresence();ctx.setChats([]);void 0;`);
  }
  app.whenReady().then(async () => {
    fs.writeFileSync(path.join(root, 'fixture.html'), '<!doctype html><meta charset="utf-8"><div id="root"><div id="wsSideScroll"><section id="wsPinnedBox"><button id="wsPinnedToggle"></button><div id="wsPinnedChats"></div></section><section id="wsChatsBox"><div id="wsChats"></div></section></div></div>');
    win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_r, callback) => callback({ cancel: true }));
    for (const flag of ['archived', 'deleted']) {
      await boot(); await js('seed();void 0;');
      assert.ok((await js('domIds()')).includes('segment'));
      await js(`receive({kind:'history-lifecycle',sessionId:'native',presence:{...row('native'),historyAliasIds:['account-copy','segment','old-copy'],${flag}:true,lifecycleRevision:2}});void 0;`);
      assert.deepEqual(await js('domIds()'), ['independent']);
      const saved = await js('openStore().get()');
      assert.deepEqual(saved.rows.map(row => row.id).sort(), flag === 'archived' ? ['independent', 'old-copy'] : ['independent']);
      assert.equal(saved.archivedProjects[0].chatIds.length, flag === 'archived' ? 1 : 0);
      await boot(); assert.deepEqual(await js('domIds()'), ['independent']);
      report.cases.push('remote ' + flag + ': real partition and DOM clear every authenticated alias across reload');
    }
    await boot(); await js('seed();void 0;');
    assert.equal(await js('ctx.archiveHistoryChat("native")'), true);
    assert.deepEqual(await js('domIds()'), ['independent']);
    await boot(); assert.deepEqual(await js('domIds()'), ['independent']);
    await js(`receive({kind:'history-lifecycle',sessionId:'native',presence:{...row('native'),archived:false,deleted:false,lifecycleRevision:4}});void 0;`);
    assert.deepEqual(await js('domIds()'), ['independent', 'native']);
    assert.equal(await js('document.querySelector("#wsChats .ws-chat").dataset.chatId'), 'native');
    assert.equal(await js('openStore().get().pins.length'), 0);
    await js(`openStore().togglePin('native',row('native'));ctx.renderChats();receive({kind:'history-lifecycle',sessionId:'native',presence:{...row('native'),archived:true,lifecycleRevision:2}});void 0;`);
    assert.equal(await js('openStore().get().pins.includes("native")'), true);
    report.cases.push('local archive clears alias snapshots; restore returns to recent; stale archive preserves a new pin');

    await boot(); await js(`localStorage.clear();window.groupId=openStore().saveProject({name:'Whole group'});
      for(const id of ['first','second'])openStore().fileChat(id,groupId,row(id));ctx.setChats([row('first'),row('second')]);
      window.confirm=()=>true;
      soduWorkAPI.conversationSession.archiveHistory=async id=>{
        receive({kind:'history-lifecycle',sessionId:id,presence:{...row(id),archived:true,deleted:false,lifecycleRevision:10}});
        return {ok:true,id,archived:true};};
      soduWorkAPI.conversationSession.restoreHistory=async id=>{
        receive({kind:'history-lifecycle',sessionId:id,presence:{...row(id),archived:false,deleted:false,lifecycleRevision:11}});
        return {ok:true,id,archived:false};};
      document.querySelector('.ws-project-edit').click();void 0;`);
    await js('document.querySelector(".ws-project-archive").onclick()');
    assert.deepEqual(await js('openStore().get().archivedProjects[0].chatIds.slice().sort()'), ['first', 'second']);
    assert.deepEqual(await js('domIds()'), []);
    await js(`(async()=>{for(const id of ['first','second'])await soduWorkAPI.conversationSession.restoreHistory(id);
      openStore().restoreProject(groupId);ctx.renderChats();})()`);
    assert.deepEqual(await js('[...document.querySelectorAll(".ws-project-chats .ws-chat")].map(el=>el.dataset.chatId).sort()'), ['first', 'second']);
    report.cases.push('whole-project archive protects member snapshots during synchronous lifecycle events and restores the complete group');

    for (const flag of ['archived', 'deleted']) {
      await boot(); await js('seed();void 0;'); await boot();
      await js(`reply={ok:true,chats:[row('independent')],lifecycle:[{id:'native',historyAliasIds:['account-copy','segment','old-copy'],${flag}:true,lifecycleRevision:7}]};void 0;`);
      assert.equal(await js('ctx.refreshConversationHistory()'), true);
      assert.deepEqual(await js('domIds()'), ['independent']);
      await boot(); assert.deepEqual(await js('domIds()'), ['independent']);
      report.cases.push('cold-start ' + flag + ': history lifecycle receipts clear cached groups without a presence event');
    }
    await boot(); await js('seed();ctx.removeChat("native");void 0;');
    assert.ok((await js('domIds()')).includes('native'), 'ordinary removal must not erase a durable group snapshot');
    const original = await js('JSON.stringify(openStore().get())');
    await js(`receive({kind:'account-conversation-sync',sessionId:'native',presence:{...row('native'),archived:true}});void 0;`);
    assert.equal(await js('JSON.stringify(openStore().get())'), original, 'ordinary snapshots must not permanently clear organization');
    assert.ok(!(await js('domIds()')).includes('native'), 'hidden lifecycle rows must not repaint through cached snapshots');
    report.cases.push('temporary removal and ordinary status never delete persistent grouping');

    await boot(); await js('seed();window.oldReceive=receive;owner="other-fixture-account";dispatchEvent(new Event("soduwork-data-scope-changed"));void 0;');
    await js('seed();void 0;'); const other = await js('JSON.stringify(openStore().get())');
    await js(`oldReceive({kind:'history-lifecycle',sessionId:'native',presence:{...row('native'),deleted:true,lifecycleRevision:99}});void 0;`);
    assert.equal(await js('JSON.stringify(openStore().get())'), other);
    report.cases.push('late lifecycle events from the previous account cannot clear the current account grouping');
    assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); })
    .finally(() => {
      win?.destroy(); console.log(JSON.stringify(report));
      const target = path.resolve(root), boundary = path.resolve(os.tmpdir()) + path.sep;
      if (target.startsWith(boundary)) { try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) {} }
      app.exit(report.ok ? 0 : 1);
    });
}
