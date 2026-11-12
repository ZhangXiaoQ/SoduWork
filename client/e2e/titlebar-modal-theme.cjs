'use strict';
// Real Chromium backdrops and production preload/titlebar IPC. History and
// directory access use isolated fixtures; no Hub, model or user profile is used.
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const client = path.resolve(__dirname, '..'), output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence path required');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-titlebar-modal-'));
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(temp, 'profile'));
app.disableHardwareAcceleration();
const report = { ok: false, platform: process.platform, boundary: `${process.platform} Electron, production project dialog/CSS and real native titlebar API; rendered backdrop pixels are compared with the colors sent to the native caption API.`, cases: [], colors: [], errors: [] };
const themes = [];
let win;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code, true);
async function until(check, label) {
  for (let i = 0; i < 120; i++) { if (await check()) return; await delay(25); }
  throw Error('Timed out: ' + label);
}
async function click(selector) {
  const point = await js(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)}), r = el.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    if (!el.contains(document.elementFromPoint(x, y))) throw Error('Occluded control');
    return { x, y };
  })()`);
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  await delay(60);
}
async function matchesBar(label) {
  await delay(80);
  const point = await js(`(() => {const r = document.querySelector('.window-menu').getBoundingClientRect();
    return {x: r.left + r.width - 20, y: r.top + 10, width: innerWidth};})()`);
  const image = await win.webContents.capturePage(), size = image.getSize();
  const scale = size.width / point.width, x = Math.floor(point.x * scale), y = Math.floor(point.y * scale);
  const bitmap = image.toBitmap(), at = (y * size.width + x) * 4;
  const pixel = [bitmap[at + 2], bitmap[at + 1], bitmap[at]];
  const color = themes.at(-1).color, rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  report.colors.push({ label, color, pixel });
  assert.ok(rgb.every((value, i) => Math.abs(value - pixel[i]) <= 2), JSON.stringify(report.colors.at(-1)));
  assert.equal(themes.at(-1).height, 34);
  return color;
}
async function shot(name) {
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
const deadline = setTimeout(() => { console.error('Titlebar modal verification timed out'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  ipcMain.handle('pi-session-history', require('./fixtures/history-ipc.cjs').create(() => ({ ok: true, chats: [] })));
  ipcMain.handle('recent-workspace-get', () => ({ ok: true, dir: '' }));
  ipcMain.handle('app-info', () => ({ version: 'fixture', website: '', releaseHistory: [] }));
  const fixture = path.join(__dirname, 'fixtures/sidebar-projects.html');
  const html = fs.readFileSync(fixture, 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.dirname(fixture) + path.sep).href + '">')
    .replace('</head>', '<link rel="stylesheet" href="../../components/workspace/window-menu.css">' +
      '<link rel="stylesheet" href="../../components/panels/library-preview-pane.css"></head>')
    .replace('</body>', '<script src="../../components/workspace/window-menu.js"></script></body>');
  fs.writeFileSync(path.join(temp, 'desk.html'), html);
  const titlebar = require('../main/workspace-titlebar.cjs').create({
    app: { getAppPath: () => temp }, ipcMain, BrowserWindow, Menu,
  });
  const options = titlebar.windowOptions(client);
  win = new BrowserWindow({ width: 1200, height: 850, show: false, ...options,
    webPreferences: { preload: path.join(client, 'preload.js'), offscreen: true, contextIsolation: true,
      nodeIntegration: false, backgroundThrottling: false } });
  titlebar.attach(win, options);
  const nativeTheme = win.setTitleBarOverlay.bind(win);
  win.setTitleBarOverlay = value => { themes.push(value); return nativeTheme(value); };
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
  win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
  await win.loadFile(path.join(temp, 'desk.html'));
  await until(() => Promise.resolve(themes.length > 0), 'native titlebar initialized');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const initial = await matchesBar('initial');
  await click('#wsProjectAdd');
  await until(() => js('!!document.querySelector(".ws-project-dialog:modal")'), 'project dialog');
  await until(() => Promise.resolve(themes.at(-1).color !== initial), 'project backdrop synchronized');
  await matchesBar('create project'); await shot('project-modal');
  win.webContents.insertText('遮罩回归项目');
  await click('.ws-project-save');
  await until(() => Promise.resolve(themes.at(-1).color === initial), 'saved dialog restores titlebar');
  await click('.ws-project-edit');
  await until(() => Promise.resolve(themes.at(-1).color !== initial), 'edit project backdrop synchronized');
  await matchesBar('edit project');
  assert.equal(await js('document.querySelector("#wsProjectName").value'), '遮罩回归项目');
  await click('.ws-project-dialog-close');
  await until(() => Promise.resolve(themes.at(-1).color === initial), 'close restores titlebar');
  report.cases.push('Real pointer input opens create/edit project dialogs; their rendered backdrop matches native caption colors, and save/close restores the original theme.');

  await click('#wsProjectAdd');
  await js(`document.documentElement.style.setProperty('--ws-side','#17191f');
    document.documentElement.style.setProperty('--ink','#eef0f4');
    document.documentElement.style.setProperty('--ink-3','#dadde4');void 0;`);
  await matchesBar('theme change during modal'); await shot('project-modal-dark');
  for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Escape' });
  await until(() => Promise.resolve(themes.at(-1).color === '#17191f'), 'Escape restores current theme');
  await matchesBar('dark theme restored');
  await js(`for (const key of ['--ws-side','--ink','--ink-3']) document.documentElement.style.removeProperty(key);void 0;`);
  await until(() => Promise.resolve(themes.at(-1).color === initial), 'original skin restored');
  report.cases.push('Theme changes while a modal is open update the composition; Escape restores the new theme and normal keyboard close behavior.');

  await js(`window.extraDialog = document.createElement('dialog');
    extraDialog.textContent = 'Nested modal';extraDialog.style='padding:24px';
    const style=document.createElement('style');style.textContent='dialog.fixture-tint::backdrop{background:rgb(80 20 180 / 35%)}';document.head.append(style);
    extraDialog.className='fixture-tint';document.body.prepend(extraDialog);void 0;`);
  await click('#wsProjectAdd');
  const single = await matchesBar('single backdrop');
  await js('extraDialog.showModal();void 0;');
  const nested = await matchesBar('nested reverse DOM order'); assert.notEqual(nested, single);
  await js('extraDialog.close();void 0;');
  await until(() => Promise.resolve(themes.at(-1).color === single), 'underlying backdrop retained');
  await js('document.querySelector(".ws-project-dialog").remove();void 0;');
  await until(() => Promise.resolve(themes.at(-1).color === initial), 'removed modal restores theme');
  await js('extraDialog.showModal();void 0;');
  await matchesBar('reopened dialog');
  await js('extraDialog.remove();void 0;');
  await until(() => Promise.resolve(themes.at(-1).color === initial), 'removed reopened modal restores theme');
  report.cases.push('Nested dialogs compose in opening order even when DOM order differs; closing one keeps the remaining shade, and removal/reopening cannot leave a stale color.');

  await js(`window.transparentDialog=document.createElement('dialog');transparentDialog.className='app-chat-history-dialog';
    const transparentStyle=document.createElement('style');transparentStyle.textContent='.app-chat-history-dialog::backdrop{background:transparent}';document.head.append(transparentStyle);
    transparentDialog.textContent='Transparent backdrop';document.body.append(transparentDialog);transparentDialog.showModal();void 0;`);
  await matchesBar('transparent backdrop'); assert.equal(themes.at(-1).color, initial);
  await js('transparentDialog.remove();void 0;');
  await js(`window.previewDialog=document.createElement('dialog');previewDialog.className='library-preview-dialog';
    previewDialog.textContent='Preview below titlebar';document.body.append(previewDialog);previewDialog.showModal();void 0;`);
  assert.equal(await js('getComputedStyle(previewDialog,"::backdrop").top'), '34px');
  await matchesBar('preview leaves titlebar uncovered'); assert.equal(themes.at(-1).color, initial);
  await js('previewDialog.remove();void 0;');
  await js(`window.nonModal=document.createElement('dialog');nonModal.className='ws-project-dialog';
    nonModal.textContent='Non-modal';document.body.append(nonModal);nonModal.show();void 0;`);
  await matchesBar('non-modal dialog'); assert.equal(themes.at(-1).color, initial);
  await js('nonModal.remove();void 0;');
  report.cases.push('Transparent, non-modal and production library-preview backdrops do not darken an uncovered titlebar.');

  const count = themes.length;
  await js(`const text=document.createElement('div');document.body.append(text);
    for(let i=0;i<100;i++){text.textContent='Streaming output '+i;text.className='row-'+i;}void 0;`);
  await delay(120); assert.equal(themes.length, count);
  await js(`document.documentElement.dataset.workspaceView='history';void 0;`);
  await until(() => Promise.resolve(themes.at(-1).color === '#f9f9f9'), 'page-specific titlebar theme');
  await matchesBar('page-specific background');
  report.cases.push('Unrelated DOM updates do not send duplicate native themes; page-specific titlebar colors remain synchronized.');
  assert.deepEqual(await js('errors'), []); assert.deepEqual(report.errors, []);
  report.ok = true;
}).catch(async error => { report.error = error.stack; if (win) await shot('failure').catch(() => {}); }).finally(() => {
  clearTimeout(deadline);
  win?.destroy();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (_) {}
  app.exit(report.ok ? 0 : 1);
});
