'use strict';
// Real Chromium layout and native wheel events; isolated profile, synthetic model stream.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: 'inherit',
  }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict');
  const baseline = process.argv.includes('--baseline');
  const baselineRef = '535a3c52a5ba2ec4f0c089d9c4d520a0b08a6b58';
  const output = path.resolve(__dirname, '../../outputs/chat-stream-scroll-20261014');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-stream-scroll-')));
  const report = { ok: false, baseline, baselineRef: baseline ? baselineRef : null, realNativeWheel: true, realModel: false };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let win;
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: true, title:'SoduWork streaming regression (isolated)', width: 1100, height: 820, skipTaskbar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await win.loadFile(path.join(__dirname, 'fixtures/long-conversation.html'));
    if (baseline) {
      await win.webContents.executeJavaScript('renderer.reset()');
      for (const file of ['chat-scroll-follow.js', 'chat-message-renderer.js']) {
        const source = require('node:child_process').execFileSync('git', ['show', baselineRef + ':client/components/panels/' + file], {
          cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', windowsHide: true,
        });
        await win.webContents.executeJavaScript(source);
      }
      await win.webContents.executeJavaScript('window.renderer = ChatMessageRenderer.create(ctx); void 0;');
    }
    await win.webContents.executeJavaScript(`
      const area = document.createElement('div'); area.className = 'nchat-content-area'; area.style.position = 'relative';
      document.querySelector('#root').appendChild(area); area.appendChild(document.querySelector('#nchatScroll'));
      document.querySelector('#nchatScroll').classList.add('nchat-scroll');
      document.querySelector('#nchatScroll').tabIndex = 0;
      fill(20); ctx._snap.tools = []; ctx._snap.status = 'streaming';
      ctx._snap.messages.push({ role:'assistant', done:false, blocks:[{kind:'text', index:0, done:false,
        text:'## Streaming answer\\n\\n' + 'A stable paragraph with **formatting**.\\n\\n'.repeat(35)}] });
      window.scrollBox = document.querySelector('#nchatScroll');
      window.tick = 0; window.wheels = 0;
      scrollBox.addEventListener('wheel', () => wheels++, {passive:true});
      window.streamTimer = setInterval(() => {
        ctx._snap.messages.at(-1).blocks[0].text += ' next'; tick++; renderer._render();
      }, 25);
      renderer._render();
    `);
    win.focus(); win.webContents.focus();
    win.webContents.sendInputEvent({type:'mouseMove', x:550, y:360});
    await delay(600);
    const get = () => win.webContents.executeJavaScript(`({top:scrollBox.scrollTop, height:scrollBox.scrollHeight,
      viewport:scrollBox.clientHeight, follow:scrollBox.__soduworkScrollFollow.follow, wheels, tick})`);
    report.before = await get();
    win.webContents.sendInputEvent({ type:'mouseWheel', x:550, y:360, deltaY:24, deltaX:0 });
    await delay(200);
    report.smallUp = await get();
    for (let i = 0; i < 6; i++) {
      win.webContents.sendInputEvent({ type:'mouseWheel', x:550, y:360, deltaY:100, deltaX:0 });
      await delay(50);
    }
    await delay(250);
    report.readStart = await get();
    await delay(1100);
    report.readEnd = await get();
    await win.webContents.executeJavaScript(`document.querySelector('.nchat-jump-latest').click()`);
    await delay(250);
    await win.webContents.executeJavaScript('clearInterval(streamTimer); void 0;');
    await delay(350); // Include the deferred Markdown flush and its follow frame.
    report.latest = await get();
    await win.webContents.executeJavaScript(`clearInterval(streamTimer); ctx._snap.status='idle';
      ctx._snap.messages.at(-1).done=true; ctx._snap.messages.at(-1).blocks[0].done=true; renderer._render();`);
    report.longCode = await win.webContents.executeJavaScript(`(async () => {
      renderer.reset(); ctx._ref='long-code'; ctx._snap.status='streaming';
      const source = '\\u0060\\u0060\\u0060js\\n' + 'const item = 1;\\n'.repeat(1800);
      ctx._snap.messages=[{role:'assistant',done:false,blocks:[{kind:'text',index:0,done:false,text:source.slice(0,24000)}]}];
      renderer._render(); await new Promise(r=>setTimeout(r,150));
      const code=document.querySelector('.ntext pre');
      const before={pre:!!code,height:document.querySelector('.ntext').offsetHeight};
      ctx._snap.messages[0].blocks[0].text=source;
      renderer._render(); await new Promise(r=>setTimeout(r,400)); renderer._render();
      const after={pre:!!document.querySelector('.ntext pre'),sameNode:document.querySelector('.ntext pre')===code,
        height:document.querySelector('.ntext').offsetHeight, chars:document.querySelector('.ntext').textContent.length};
      return {before,after,sourceChars:source.length};
    })()`);
    report.activeRow = await win.webContents.executeJavaScript(`(() => {
      renderer.reset(); ctx._ref='row-transition'; ctx._snap.status='streaming';
      const message={role:'assistant',done:false,blocks:[{kind:'thinking',index:0,done:false,text:'Planning'}]};
      ctx._snap.messages=[message]; renderer._render();
      const row=document.querySelector('[data-chat-node="message:0"]');
      message.blocks[0].done=true;
      message.blocks.push({kind:'text',index:1,done:false,text:'Visible answer'}); renderer._render();
      const live={sameNode:document.querySelector('[data-chat-node="message:0"]')===row,
        flag:row.dataset.streaming,visibility:getComputedStyle(row).contentVisibility};
      message.done=true; message.blocks[1].done=true; ctx._snap.status='idle'; renderer._render();
      return {live,settled:{sameNode:document.querySelector('[data-chat-node="message:0"]')===row,
        flag:row.dataset.streaming,visibility:getComputedStyle(row).contentVisibility}};
    })()`);
    if (!baseline) {
      await win.webContents.executeJavaScript(`
        renderer.reset();ctx._ref='growing-reasoning';fill(20);ctx._snap.tools=[];ctx._snap.status='streaming';
        window.growingThought={kind:'thinking',index:0,done:false,text:'Planning'};
        ctx._snap.messages.push({role:'assistant',done:false,blocks:[growingThought]});renderer._render();
      `);
      await delay(200);
      const thinkingState = () => win.webContents.executeJavaScript(`(()=>{
        const body=document.querySelector('.nthink-body');return {height:body.getBoundingClientRect().height,
          top:scrollBox.scrollTop,follow:scrollBox.__soduworkScrollFollow.follow,
          bottomGap:scrollBox.scrollHeight-scrollBox.clientHeight-scrollBox.scrollTop,
          innerTop:body.scrollTop,innerBottomGap:body.scrollHeight-body.clientHeight-body.scrollTop};
      })()`);
      report.reasoningGrowth = [await thinkingState()];
      for (const lines of [1, 1, 2, 12]) {
        await win.webContents.executeJavaScript(`growingThought.text+='\\nChecking a constraint'.repeat(${lines});renderer._render();void 0`);
        await delay(120);
        report.reasoningGrowth.push(await thinkingState());
      }
      assert.ok(report.reasoningGrowth[0].height<70, 'short reasoning has no empty fixed-height block');
      assert.equal(report.reasoningGrowth.at(-1).height,144, 'reasoning grows up to the 144px cap');
      for (let i=1;i<report.reasoningGrowth.length;i++) {
        assert.ok(report.reasoningGrowth[i].height>=report.reasoningGrowth[i-1].height, 'stream height grows monotonically');
        assert.ok(report.reasoningGrowth[i].bottomGap<3, 'following stays at the bottom during natural growth');
      }
      assert.ok(report.reasoningGrowth.at(-1).innerBottomGap<3, 'long live reasoning follows its own latest line');
      await win.webContents.executeJavaScript('document.querySelector(".nthink-body").scrollTop=0;void 0');
      await win.webContents.executeJavaScript('growingThought.text+="\\nA later reasoning line";renderer._render();void 0');
      await delay(150);
      assert.equal((await thinkingState()).innerTop,0, 'reading earlier reasoning is not pulled down');
      for(let i=0;i<4;i++) {
        win.webContents.sendInputEvent({type:'mouseWheel',x:550,y:90,deltaY:180,deltaX:0});await delay(70);
      }
      await delay(180);
      report.reasoningBrowseBefore=await thinkingState();
      await win.webContents.executeJavaScript('growingThought.text+="\\nAnother line".repeat(12);renderer._render();void 0');
      await delay(250);
      report.reasoningBrowseAfter=await thinkingState();
      assert.equal(report.reasoningBrowseBefore.follow,false, 'native wheel suspends following during reasoning');
      assert.ok(Math.abs(report.reasoningBrowseAfter.top-report.reasoningBrowseBefore.top)<=2,
        'reasoning updates preserve the outer history reading position');
      assert.ok(report.smallUp.wheels > 0, 'Chromium must receive the native wheel');
      assert.equal(report.smallUp.follow, false, 'small upward wheel suspends follow immediately');
      assert.ok(report.smallUp.top < report.before.top, 'one small wheel scrolls upward');
      assert.ok(report.readStart.top < report.smallUp.top - 250, 'repeated native wheels can read older content');
      assert.ok(report.readEnd.tick > report.readStart.tick + 20, 'tokens continue during historical reading');
      assert.ok(Math.abs(report.readEnd.top - report.readStart.top) <= 2, 'stream cannot move reading position');
      assert.equal(report.latest.follow, true, 'explicit latest resumes following');
      assert.ok(report.latest.height - report.latest.viewport - report.latest.top < 3, 'latest reaches actual bottom');
      assert.equal(report.longCode.after.pre, true, 'crossing 24k cannot strip the opening code fence');
      assert.equal(report.longCode.after.sameNode, true, 'growing code retains its existing DOM');
      assert.ok(report.longCode.after.height >= report.longCode.before.height, 'growing code must not collapse');
      assert.ok(report.longCode.after.chars > 24000, 'earlier output remains readable during streaming');
      assert.deepEqual(report.activeRow.live, {sameNode:true,flag:'true',visibility:'visible'});
      assert.deepEqual(report.activeRow.settled, {sameNode:true,flag:'false',visibility:'auto'});
      // Exercise Chromium's real ResizeObserver independently of transcript
      // changes. This is viewport coverage, not an iOS keyboard simulation.
      await win.webContents.executeJavaScript('document.querySelector(".nchat-jump-latest").click();void 0;');
      await delay(200);
      await win.webContents.executeJavaScript('scrollBox.style.height="360px";void 0;');
      await delay(250);
      report.viewportLatest = await get();
      assert.equal(report.viewportLatest.viewport, 360);
      assert.ok(report.viewportLatest.height - report.viewportLatest.viewport - report.viewportLatest.top < 3,
        'shrinking only the viewport keeps the latest content visible');
      win.webContents.sendInputEvent({type:'mouseWheel',x:550,y:180,deltaY:150,deltaX:0});
      await delay(200);
      report.viewportReadBefore = await get();
      assert.equal(report.viewportReadBefore.follow, false);
      await win.webContents.executeJavaScript('scrollBox.style.height="480px";void 0;');
      await delay(250);
      report.viewportReadAfter = await get();
      assert.ok(Math.abs(report.viewportReadAfter.top - report.viewportReadBefore.top) <= 2,
        'viewport growth preserves an intentional history reading position');
    }
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); }).finally(() => {
    if (win && !win.isDestroyed()) win.destroy();
    fs.mkdirSync(output, {recursive:true});
    fs.writeFileSync(path.join(output, baseline ? 'baseline.json' : 'fixed.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  });
}
