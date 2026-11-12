'use strict';
// Production setting markup, renderer, preload, IPC, persistence and isolated
// native consent. No model, business data or user's preference file is used.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, protocol, net, screen } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-default-access-'));
  app.setPath('userData', path.join(root, 'profile'));
  const out = path.resolve(client, '../outputs/default-access/preferences'); fs.mkdirSync(out, { recursive: true });
  const report = { ok: false, cases: [], layouts: [], errors: [] };
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const preferences = require('../main/access-control/preferences'), locale = require('../main/native-locale.cjs');
  locale.setLocale('zh-CN');
  const desk = path.join(client, 'desk.html'), pageURL = pathToFileURL(desk).href;
  const source = read('desk.html'), start = source.indexOf('  <div class="set-group set-access-default">');
  const end = source.indexOf('  <div class="set-group ', start + 1);
  assert.ok(start >= 0 && end > start, 'The production access settings section must be present');
  const markup = source.slice(start, end);
  assert.doesNotMatch(markup, /<script\b/i, 'The isolated settings fixture must not include desktop startup');
  const scripts = [...JSON.parse(read('core/locales/manifest.json')).map(name => 'core/locales/' + name),
    'core/i18n-dom.js', 'core/i18n.js', 'components/settings/access-preferences.js'];
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<link rel="stylesheet" href="theme/variables.css"><link rel="stylesheet" href="components/settings/settings.css">' +
    '<style>body{margin:0;background:var(--bg-0)}#settingsPanel{position:static!important;display:block!important;width:100%!important;max-width:1050px!important;height:auto!important;max-height:none!important;margin:30px auto!important;padding:20px!important}#settingsPanel>.set-group{width:100%!important}*{box-sizing:border-box}</style>' +
    '<body><section id="settingsPanel" class="show">' + markup + '</section>' +
    scripts.map(file => '<script src="' + file + '"></script>').join('') + '</body></html>';
  let owner, peer;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = (win, code) => win.webContents.executeJavaScript(code, true);
  async function until(check, message) {
    for (let index = 0; index < 200; index++) { const value = await check(); if (value) return value; await delay(30); }
    throw Error('Timed out: ' + message);
  }
  async function click(win, selector) {
    const point = await js(win, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});if(e.disabled)throw Error('disabled');const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(45);
  }
  async function window() {
    const win = new BrowserWindow({ show: false, width: 1120, height: 780,
      webPreferences: { preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
    await win.loadFile(desk);
    await until(() => js(win, '!document.querySelector("[data-default-access]").disabled'), 'preference loaded');
    return win;
  }
  async function selected(win, mode) { await until(() => js(win, `AccessPreferences.snapshot().mode===${JSON.stringify(mode)}&&!document.querySelector('[data-default-access]').disabled`), 'selected ' + mode); }
  async function modal() {
    const win = await until(() => BrowserWindow.getAllWindows().find(w => w.getParentWindow() === owner), 'native consent');
    await until(() => js(win, 'Boolean(document.querySelector("#consentTitle")?.textContent)'), 'native content');
    return win;
  }
  async function layout(width, lang, theme) {
    owner.setSize(width, 780);
    await js(owner, `SoduWorkI18n.setLocale(${JSON.stringify(lang)});document.documentElement.dataset.theme=${JSON.stringify(theme)};`);
    await delay(120);
    const metric = await js(owner, `(()=>{const buttons=[...document.querySelectorAll('[data-default-access]')];return{overflow:document.documentElement.scrollWidth>innerWidth,selected:buttons.find(b=>b.getAttribute('aria-checked')==='true')?.dataset.defaultAccess,minimum:Math.min(...buttons.flatMap(b=>[b.querySelector('b'),b.querySelector('small')]).map(e=>parseFloat(getComputedStyle(e).fontSize))),text:document.body.innerText}})()`);
    assert.equal(metric.overflow, false); assert.ok(metric.minimum >= 12);
    assert.match(metric.text, lang === 'zh-CN' ? /默认授权模式/ : /Default access mode/);
    report.layouts.push({ width, lang, theme, ...metric });
    fs.writeFileSync(path.join(out, `settings-${width}-${lang}-${theme}.png`), (await owner.webContents.capturePage()).toPNG());
  }
  app.whenReady().then(async () => {
    locale.setLocale('zh-CN');
    // Replace only the outer desktop shell with the actual settings section.
    // This keeps its trusted production URL while avoiding auth/model startup.
    protocol.handle('file', request => {
      return request.url.split('?')[0] === pageURL
        ? new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
        : net.fetch(request.url, { bypassCustomProtocolHandlers: true });
    });
    function HiddenConsent(options) {
      const win = new BrowserWindow({ ...options, webPreferences: { ...options.webPreferences, backgroundThrottling: false } });
      win.show = () => {}; win.focus = () => {};
      return win;
    }
    const confirm = require('../main/access-control/full-access-consent').create({ BrowserWindow: HiddenConsent, ipcMain, screen });
    preferences.install({ app, ipcMain, BrowserWindow, confirmFullAccess: confirm });
    owner = await window(); peer = await window();
    await selected(owner, 'full'); await selected(peer, 'full');
    assert.equal(preferences.forNewChat(app, { adapterId: 'pi' }, true).accessMode, 'full');
    assert.equal(preferences.hasFullConsent(app, {}), true);
    assert.equal(fs.existsSync(path.join(app.getPath('userData'), 'access-preferences.json')), false);
    await js(owner, 'SoduWorkI18n.setLocale("zh-CN")'); await delay(100);
    assert.match(await js(owner, 'document.querySelector("#defaultAccessStatus").textContent'), /新建对话将默认完全访问/);
    await owner.webContents.capturePage(); await delay(120);
    fs.writeFileSync(path.join(out, 'new-user-default-full-zh.png'), (await owner.webContents.capturePage()).toPNG());
    report.cases.push('Fresh profile settings select full access and supported new chats inherit it without altering an existing saved choice.');
    await click(owner, '[data-default-access=readonly]'); await selected(owner, 'readonly'); await selected(peer, 'readonly');
    for (const adapterId of ['pi', 'opencode', 'codex-harness', 'qwen']) assert.equal(preferences.forNewChat(app, { adapterId }, true).accessMode, 'readonly');
    report.cases.push('Real mouse setting change persists through trusted IPC and synchronizes a second desktop window; all supported new-chat adapters inherit readonly.');
    await click(owner, '[data-default-access=full]'); let consent = await modal();
    assert.equal(await js(consent, 'document.querySelector("#consentAllow").disabled'), true);
    assert.match(await js(consent, 'document.body.innerText'), /此设备的新建对话/);
    await click(consent, '#consentCancel'); await selected(owner, 'readonly');
    assert.equal(preferences.snapshot(app).mode, 'readonly');
    report.cases.push('Persistent full access uses a dedicated native dialog with explicit device/new-chat scope; unchecked and cancelled consent never changes the saved mode.');
    await click(owner, '[data-default-access=full]'); consent = await modal();
    fs.writeFileSync(path.join(out, 'default-full-consent-zh.png'), (await consent.webContents.capturePage()).toPNG());
    await click(consent, '.acknowledgement'); await click(consent, '#consentAllow');
    await selected(owner, 'full'); await selected(peer, 'full');
    assert.equal(preferences.hasFullConsent(app, {}), true);
    await new Promise(resolve => { owner.webContents.once('did-finish-load', resolve); owner.reload(); });
    await selected(owner, 'full');
    for (const opts of [{ chatId: 'history' }, { automationId: 'schedule' }, { accessMode: 'readonly' }]) {
      assert.equal(preferences.forNewChat(app, opts, true), opts);
    }
    for (const opts of [{ taskSession: true }, { taskRef: 'task' },
      ...['pi', 'opencode', 'codex-harness', 'qwen', 'kimi', 'claude', 'codex', 'dsh', 'harness2'].map(adapterId => ({ adapterId }))]) {
      assert.deepEqual(preferences.forNewChat(app, opts, true), { ...opts, accessMode: 'full' });
    }
    report.cases.push('Checked native consent persists through reload; all supported new chats and new local tasks inherit it, while existing chats, automation and explicit session modes retain their grants.');
    for (const [width, lang, theme] of [[1120, 'zh-CN', 'azure'], [360, 'en-US', 'cnbm'], [360, 'zh-CN', 'azure'], [1120, 'en-US', 'cnbm']]) await layout(width, lang, theme);
    await click(owner, '[data-default-access=standard]'); await selected(owner, 'standard'); await selected(peer, 'standard');
    assert.equal(preferences.hasFullConsent(app, {}), false);
    locale.setLocale('en-US');
    await click(owner, '[data-default-access=full]'); consent = await modal();
    assert.match(await js(consent, 'document.body.innerText'), /New chats on this device/);
    fs.writeFileSync(path.join(out, 'default-full-consent-en.png'), (await consent.webContents.capturePage()).toPNG());
    await click(consent, '#consentCancel'); await selected(owner, 'standard');
    assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); }).finally(() => {
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, layouts: report.layouts.length, error: report.error, report: path.join(out, 'report.json') }));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    app.exit(report.ok ? 0 : 1);
  });
}
