'use strict';
// Isolated Electron renderer + production artifact IPC. No real conversations,
// account, model calls or user working directories participate in this fixture.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 45000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-current-work-'));
  const out = path.resolve(__dirname, '../../outputs/current-work-output-scope-20261020');
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', path.join(owned, 'profile'));
  const cwd = path.join(owned, 'project'); fs.mkdirSync(cwd);
  for (const directory of ['first', 'second']) {
    fs.mkdirSync(path.join(cwd, directory));
    fs.writeFileSync(path.join(cwd, directory, 'report.md'), '# ' + directory + '\n\n独立会话的交付正文。');
  }
  const outputs = require('../main/pi-session/outputs');
  const report = { ok: false, cases: [], errors: [], boundary: 'Real Electron and production artifact IPC; isolated shared project and synthetic session snapshots, no business data or model.' };
  const handles = new Map(['first', 'second'].map(id => [id, { cwd, sessionId: id,
    outputSnapshot: () => outputs.scan(cwd, 0, 1), snapshot: () => ({ tools: [] }) }]));
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
      const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded control: '+${JSON.stringify(selector)});return{x,y}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
    await sleep(220);
  }
  const until = async (fn, label) => {
    for (let count = 0; count < 80; count++) { if (await fn()) return; await sleep(30); }
    throw Error('Timed out: ' + label);
  };
  app.whenReady().then(async () => {
    require('../main/pi-session/artifact-ipc').install({ app, ipcMain, BrowserWindow,
      session: { get: ref => handles.get(ref) }, workDir: () => cwd });
    require('../main/work-preview').install({ ipcMain, BrowserWindow, WebContentsView: electron.WebContentsView,
      shell: { openExternal: async () => { throw Error('External navigation is outside this fixture'); } } });
    const client = path.resolve(__dirname, '..');
    const url = file => pathToFileURL(path.join(client, file)).href;
    const scripts = ['chat-dom-patch', 'panels-chat-tools', 'chat-output-links', 'chat-workspace-info',
      'chat-workspace-split', 'chat-workspace-controls', 'panels-chat-workspace', 'panels-chat-chrome'];
    const html = path.join(owned, 'fixture.html');
    fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>本次工作 · 隔离验证</title>' +
      '<link rel="stylesheet" href="' + url('theme/variables.css') + '">' +
      '<link rel="stylesheet" href="' + url('components/panels/panels-chat.css') + '">' +
      '<link rel="stylesheet" href="' + url('components/panels/code-workbench.css') + '">' +
      '<style>body{margin:0;font:14px system-ui;color:#26262a}#chat{height:100vh}</style>' +
      '<div id="chat" class="nchat"></div>' + scripts.map(file => '<script src="' + url('components/panels/' + file + '.js') + '"></script>').join('') +
      '<script>window.fixtureRoot=document.querySelector("#chat");window.fixtureContext={ref:"first",intent:{cwd:' + JSON.stringify(cwd) + '}};' +
      'fixtureRoot.innerHTML=\'<div class="nchat-stage"><section class="nchat-main">\'+ChatChrome.header()+\'<div class="nchat-content-area">Current conversation</div></section></div>\';' +
      'window.contextValue=()=>fixtureContext;ChatChrome.bind(fixtureRoot,contextValue);ChatWorkbench.bind(fixtureRoot,contextValue);</script>');
    win = new BrowserWindow({ show: false, width: 1280, height: 860,
      webPreferences: { preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true } });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    await win.loadFile(html);
    await js('(async()=>{window.index=await soduWorkAPI.conversationSession.outputs("first");window.files=index.artifacts;})()');
    assert.equal(await js('files.length'), 2, 'actual shared-directory index retains both historical files');
    const snapshot = id => ({ messages: [{ role: 'user', sentAt: 1000, blocks: [{ kind: 'text', text: '当前工作' }] },
      { role: 'assistant', completedAt: 2000, blocks: [{ kind: 'text', text: '交付 ' + id + '/report.md' }] }], tools: [] });
    await js('ChatWorkbench.render(fixtureRoot,' + JSON.stringify(snapshot('first')) + ',files);ChatChrome.openSummary();void 0');
    assert.equal(await js('document.querySelectorAll("[data-chat-summary-body] button").length'), 1);
    const firstArtifact = await js('files.find(file=>file.relative==="first/report.md").artifactId');
    assert.equal(await js('document.querySelector("[data-chat-summary-body] button").dataset.wbFile'), firstArtifact);
    await until(() => js('document.querySelector(".ncw-body")?.textContent.includes("first")'), 'own auto-preview');
    assert.equal(await js('document.querySelector(".ncw-body").textContent.includes("second")'), false);
    await click('[data-wb-close]');
    assert.equal(await js('document.querySelector(".nchat-summary").hidden'), true, 'clicking the preview controls dismisses the summary');
    await click('[data-chat-summary]');
    await click('[data-chat-summary-body] [data-wb-file]');
    await until(() => js('document.querySelector(".ncw-body")?.textContent.includes("first")'), 'summary file click');
    assert.equal(await js('document.querySelector(".nchat-summary").hidden'), true, 'opening a file dismisses the compact summary');
    const previewBefore = await js('document.querySelector(".ncw").getBoundingClientRect().toJSON()');
    await click('[data-chat-summary]');
    assert.deepEqual(await js('document.querySelector(".ncw").getBoundingClientRect().toJSON()'), previewBefore, 'reopening summary never shrinks the preview');
    assert.equal(await js(`(()=>{const preview=document.querySelector('.ncw').getBoundingClientRect(),panel=document.querySelector('.nchat-summary').getBoundingClientRect(),header=document.querySelector('.nchat-head').getBoundingClientRect();
      return Math.abs(preview.right-innerWidth)<1&&Math.abs(panel.right-(header.right-8))<1;})()`), true, 'preview reaches the window edge and summary stays below chat controls');
    fs.writeFileSync(path.join(out, 'summary-file-preview.png'), (await win.webContents.capturePage()).toPNG());
    await click('[data-chat-summary-close]');
    assert.equal(await js('Math.round(document.querySelector(".ncw").getBoundingClientRect().right)===innerWidth'), true);
    report.cases.push('Native click opens the real file; preview fills the right edge and reopening the summary under chat controls never moves or shrinks either column.');
    report.cases.push('Shared-folder directory scan keeps both files; the current-work summary claims only the current reply result and no unrelated file auto-opens.');
    await js('ChatWorkbench.reset();ChatChrome.reset();fixtureContext.ref="second";' +
      'ChatChrome.bind(fixtureRoot,contextValue);ChatWorkbench.bind(fixtureRoot,contextValue);' +
      'ChatWorkbench.render(fixtureRoot,' + JSON.stringify(snapshot('second')) + ',files);ChatChrome.openSummary();void 0');
    assert.equal(await js('document.querySelector("[data-chat-summary-body] button").dataset.wbFile'),
      await js('files.find(file=>file.relative==="second/report.md").artifactId'));
    report.cases.push('Switching to the other session selects its exact same-name file in another directory.');
    await js('ChatWorkbench.render(fixtureRoot,{messages:[{role:"user",sentAt:3000,blocks:[{kind:"text",text:"开始新的工作"}]}],tools:[]},files);void 0');
    assert.equal(await js('document.querySelectorAll("[data-chat-summary-body] button").length'), 0);
    assert.equal(await js('ChatWorkbench.openOutput(' + JSON.stringify(firstArtifact) + ')'), true);
    await until(() => js('document.querySelector(".ncw-body")?.textContent.includes("first")'), 'historical file content');
    report.cases.push('The next instruction clears the summary while historical files still open through production artifact read IPC.');
    await sleep(180);
    assert.equal(await js('document.querySelectorAll("[data-chat-summary-body] button").length'), 0, 'opening history must not relabel it as current work');
    fs.writeFileSync(path.join(out, 'historical-preview.png'), (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(report.errors, []);
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
