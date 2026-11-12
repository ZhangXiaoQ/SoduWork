'use strict';
// Isolated Chromium interactions with the real account UI and locale bundles.
// Service responses are fixtures; no real login, legal publication or receipt is performed.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 120000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-legal-e2e-'));
  const out = path.resolve(process.argv[2] || path.join(client, '../outputs/legal-client-20261106/legal-documents'));
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(temp, 'profile')); app.disableHardwareAcceleration();
  const report = { ok: false, cases: [], screenshots: [], network: [], boundary: 'Real renderer and i18n; isolated document and account fixtures.' };
  let win;
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const js = async code => {
    try { return await win.webContents.executeJavaScript(code, true); }
    catch (error) { process.stderr.write('Renderer action: ' + code.slice(0, 180) + '\n'); throw error; }
  };
  const tick = () => js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const record = name => { report.cases.push(name); process.stdout.write('PASS ' + name + '\n'); };
  async function click(selector) {
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'});`); await tick();
    const point = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect();const p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};if(el.disabled||!el.contains(document.elementFromPoint(p.x,p.y)))throw Error('Blocked control: '+${JSON.stringify(selector)});return p;})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    await tick();
  }
  async function shot(name) {
    await tick();
    const image = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
    const file = path.join(out, name + '.png'); fs.writeFileSync(file, Buffer.from(image.data, 'base64')); report.screenshots.push(file);
  }
  app.whenReady().then(async () => {
    const fixture = path.join(temp, 'index.html');
    const styles = ['theme/variables.css', 'theme/cursor.css', 'components/client-auth/client-auth.css', 'components/client-auth/account-center.css', 'components/client-auth/legal-html.css'];
    fs.writeFileSync(fixture, '<!doctype html><html><head><meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '">' + styles.map(file => '<link rel="stylesheet" href="' + pathToFileURL(path.join(client, file)).href + '">').join('') + '</head><body><div id="gate" class="soduwork-auth-gate"></div></body></html>');
    win = new BrowserWindow({ show: false, width: 1080, height: 850, useContentSize: true, webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.debugger.attach('1.3');
    win.webContents.on('console-message', (_event, details) => {
      if (details?.level === 'error') process.stderr.write('Renderer: ' + details.message + '\n');
    });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, callback) => { report.network.push(request.url); callback({ cancel: true }); });
    await win.loadFile(fixture);
    await js(`window.errors=[];window.cfg={locale:'zh-CN'};window.saveCfg=()=>{};addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));`);
    for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file) + '\n;void 0;');
    await js(read('core/i18n-dom.js') + '\n;void 0;'); await js(read('core/i18n.js') + '\n;void 0;');
    for (const file of ['legal-html.js', 'account-ui.js', 'email-auth.js']) await js(read('components/client-auth/' + file) + '\n;void 0;');
    const original = 'SoduWork 用户协议\n\n一、账号注册\n保存\n<img src=x onerror="window.injected=true">\n\n二、服务内容\n' + Array(80).fill('这是正式原文的隔离测试内容，不得被界面翻译器改写。').join('\n') + '\n\n三、联系我们\nprivacy@example.test';
    const documents = [{ key: 'terms', version: 'v2', locale: 'zh-CN', content: original, updatedAt: '2026-11-03', effectiveAt: '2026-11-06' },
      { key: 'terms', version: 'v2', locale: 'en-US', content: 'Terms of Service\n\n1. Account registration\nSave\n\n2. Service\nPublished English wording.' },
      { key: 'privacy', version: 'v2', locale: 'zh-CN', content: '隐私政策\n\n一、信息处理\n保存\n\n二、联系我们\nprivacy@example.test' },
      { key: 'privacy', version: 'v1', locale: 'en-US', content: 'Obsolete privacy translation' }];
    await js(`window.hub='https://current.example.test';window.user=null;window.saved=0;window.policyReads=0;
      window.documents=${JSON.stringify(documents)};
      window.policy={mailReady:true,allowSelfRegistration:true,requiredConsentVersions:{terms:'v2',privacy:'v2'},legalDocuments:documents};
      window.SoduWorkAPI={hubBase:()=>hub,clientAuthSnapshot:()=>({clientId:'fixture-device',user}),clientAuthPolicy:async()=>{policyReads++;return policy;},clientAccountAction:async()=>{saved++;return {ok:true};}};
      window.gate=document.querySelector('#gate');window.view=EmailAuth.mount(gate,{api:()=>SoduWorkAPI,retry(){},success(){}});view.setPolicy(policy);SoduWorkI18n.setLocale('zh-CN');void 0;`);
    await tick();
    assert.equal(await js("document.querySelectorAll('[data-auth-language] option').length"), 4);
    await shot('login-zh');
    await js("document.querySelector('#soduWorkAuthAccount').value='draft@example.test';document.querySelector('#soduWorkAuthPassword').value='fixture-password';");
    await click('.ac-auth-footer [data-legal="terms"]');
    assert.equal(await js("document.querySelectorAll('.ac-legal-toc li').length"), 3);
    assert.equal(await js("document.querySelectorAll('.ac-legal-toc button,.ac-legal-toc a,.ac-legal-toc summary,.ac-legal-toc [tabindex]').length"), 0);
    assert.equal(await js("document.querySelectorAll('.ac-legal-tabs,[data-document]').length"), 0);
    assert.equal(await js("document.querySelector('.ac-legal-meta')"), null);
    assert.equal(await js("document.querySelector('.ac-legal-copy img')"), null);
    assert.equal(await js('Boolean(window.injected)'), false);
    await click('.ac-legal-toc li:last-child');
    assert.equal(await js("document.querySelector('.ac-legal-reading').scrollTop"), 0);
    const readingPoint = await js("(()=>{const r=document.querySelector('.ac-legal-reading').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...readingPoint, deltaX: 0, deltaY: 600 });
    await tick();
    assert.equal(await js("document.querySelector('.ac-legal-reading').scrollTop>0"), true);
    await shot('reader-zh'); await click('[data-legal-back]');
    assert.equal(await js("document.querySelector('#soduWorkAuthAccount').value"), 'draft@example.test');
    assert.equal(await js("document.querySelector('#soduWorkAuthPassword').value"), 'fixture-password');
    assert.equal(await js("document.activeElement.dataset.legal"), 'terms');
    assert.equal(await js('saved'), 0);
    record('each anonymous link opens its own document; chapter lists are inert, text scrolls and closing restores input and focus');
    for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN']) {
      await js(`document.querySelector('[data-auth-language]').value=${JSON.stringify(locale)};document.querySelector('[data-auth-language]').dispatchEvent(new Event('change'));`); await tick();
      assert.equal(await js('SoduWorkI18n.getLocale()'), locale);
      await click('.ac-auth-footer [data-legal="privacy"]');
      assert.equal(await js("document.querySelectorAll('.ac-legal-tabs,[data-document]').length"), 0);
      assert.equal(await js("document.querySelector('.ac-dialog-head h2').textContent"), await js("SoduWorkI18n.t('隐私政策','隐私政策')"));
      assert.equal(await js("document.querySelector('.ac-legal-copy').textContent.includes('保存')"), true);
      assert.equal(await js("document.querySelector('.ac-legal-copy').textContent.includes('Obsolete')"), false);
      assert.equal(await js("document.querySelector('.ac-legal-language').hidden"), true);
      assert.equal(await js("document.querySelector('.ac-legal-language-note').hidden"), locale === 'zh-CN');
      await shot('privacy-' + locale); await click('[data-legal-back]');
    }
    record('four UI languages preserve legal originals; outdated translations are excluded and missing locales explained');
    await js("SoduWorkI18n.setLocale('en-US');"); await tick(); await click('.ac-auth-footer [data-legal="terms"]');
    assert.equal(await js("document.querySelector('.ac-legal-copy').textContent.includes('Published English wording.')"), true);
    await js("document.querySelector('[data-document-language]').value='zh-CN';document.querySelector('[data-document-language]').dispatchEvent(new Event('change'));"); await tick();
    assert.equal(await js("document.querySelector('.ac-legal-copy').textContent.includes('保存')"), true);
    await shot('reader-en-original'); await click('[data-legal-back]');
    await click('[data-auth-mode="register"]'); await click('[data-auth-consent] [data-legal="terms"]'); await click('[data-legal-back]');
    assert.equal(await js("document.querySelector('#acConsent').checked"), false);
    await click('#acConsent');
    await js("SoduWorkI18n.setLocale('ko-KR');"); await tick();
    assert.equal(await js("document.querySelector('#acConsent').checked"), true);
    await js("view.setPolicy({...policy,requiredConsentVersions:{terms:'v3',privacy:'v2'}});");
    assert.equal(await js("document.querySelector('#acConsent').checked"), false);
    record('translation choice and UI changes never accept documents; new required revisions clear stale consent');
    await js("view.setPolicy(policy);SoduWorkI18n.setLocale('en-US');"); await tick(); await click('.ac-auth-footer [data-legal="terms"]');
    for (const width of [1080, 360]) {
      win.setContentSize(width, 780); await tick();
      assert.equal(await js("(()=>{const d=document.querySelector('.ac-legal .ac-dialog'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&d.scrollWidth<=d.clientWidth+1})()"), true);
      await shot('reader-width-' + width);
    }
    await js("document.documentElement.style.setProperty('--bg-0','#202124');document.documentElement.style.setProperty('--bg-1','#282a30');document.documentElement.style.setProperty('--ink','#eef0f4');document.documentElement.style.setProperty('--ink-2','#d5d9e0');document.documentElement.style.setProperty('--ink-3','#aeb5c0');document.documentElement.style.setProperty('--accent','#b5a4f2');");
    await shot('reader-dark'); await click('[data-legal-back]');
    record('desktop and narrow reader layouts stay inside the viewport and reuse skin tokens');
    await js("AccountUI.legal(gate,[],'terms',{load:()=>new Promise(resolve=>window.resolveLegal=resolve),getScope:()=>hub});void 0;"); await tick();
    assert.equal(await js("document.querySelector('[data-legal-retry]').disabled"), true);
    await js("hub='https://other.example.test';dispatchEvent(new Event('soduwork-data-scope-changed'));resolveLegal({documents});"); await tick();
    assert.equal(await js("document.querySelector('.ac-legal')"), null);
    record('anonymous Hub changes close the reader and discard late legal responses');
    await js("AccountUI.legal(gate,[],'terms',{load:async()=>{throw Error('private failure');}});void 0;"); await tick();
    assert.equal(await js("document.querySelector('[data-legal-retry]').disabled"), false);
    assert.equal(await js("document.querySelector('.ac-legal').textContent.includes('private failure')"), false);
    await click('[data-legal-back]');
    await js("AccountUI.legal(gate,documents,'terms',{consents:[{document:'terms',version:'v1',acceptedAt:'2026-10-23'}]});void 0;"); await tick();
    assert.equal(await js("document.querySelector('.ac-legal-records').hidden"), false);
    assert.equal(await js("document.querySelector('.ac-legal-records div').textContent.includes('v1')"), true);
    record('failed document loading remains retryable; confirmation history uses server receipts');
    await click('[data-legal-back]');
    for (const file of ['vendor/markdown/marked.umd.js', 'vendor/markdown/purify.min.js', 'components/client-auth/legal-updates.js']) await js(read(file) + '\n;void 0;');
    win.setContentSize(1080, 800);
    const published = [{key:'terms',version:'v4',revisionId:'snapshot-4',locale:'en-US',defaultLocale:true,format:'markdown',content:'## Scope\n**Published words**\n<img src=x onerror="window.injected=true">\n\n5. Original clause\n6. Next clause\n\n<table><tr><td colspan="2" onmouseover="window.injected=true">Merged source cell</td></tr></table>',summary:'Updated scope.'},
      {key:'terms',version:'v4',revisionId:'snapshot-4',locale:'ja-JP',format:'markdown',content:'## 利用範囲\n**確定した原文**',summary:'利用範囲を更新しました。'}];
    await js(`(async()=>{user={id:'legal-owner'};window.responses=[];window.legalStatus={documents:${JSON.stringify(published)},requiredConsentVersions:{terms:'v4'},acceptanceRequired:true,updates:[{key:'terms',revisionId:'snapshot-4',version:'v4',action:'accept'}]};
      SoduWorkAPI.clientAccountRequest=async(operation,payload)=>{if(operation==='legalStatus')return legalStatus;responses.push(payload);return {...legalStatus,acceptanceRequired:false,updates:[]}};
      gate.hidden=true;SoduWorkI18n.setLocale('en-US');await LegalUpdates.refresh(true);})()`);
    assert.equal(await js("document.querySelector('.ac-legal-notice')"), null);
    await js('LegalUpdates.open();'); await tick();
    assert.equal(await js("document.querySelector('.ac-legal-copy strong').textContent"), 'Published words');
    assert.equal(await js("document.querySelector('.ac-legal-copy img')===null"), true);
    assert.equal(await js("document.querySelector('.ac-legal-copy ol').start"), 5);
    assert.equal(await js("document.querySelector('.ac-legal-copy td').colSpan"), 2);
    assert.equal(await js("document.querySelector('.ac-legal-copy [onmouseover]')===null"), true);
    assert.equal(await js("document.querySelector('.ac-legal-update-actions .ac-primary').disabled"), true);
    await click('.ac-legal-accept input');
    await js("document.querySelector('[data-document-language]').value='ja-JP';document.querySelector('[data-document-language]').dispatchEvent(new Event('change'));"); await tick();
    assert.equal(await js("document.querySelector('.ac-legal-accept input').checked"), false);
    assert.equal(await js("document.querySelector('.ac-legal-update-actions .ac-primary').disabled"), true);
    await click('.ac-legal-update-actions .ac-secondary');
    assert.equal(await js('responses.length'), 0);
    assert.equal(await js("document.querySelector('.ac-legal-notice')"), null);
    record('required updates sanitize Markdown, clear acceptance on language changes and preserve refusal without recording consent');
    await js('LegalUpdates.open();'); await shot('required-update');
    await click('.ac-legal-accept input'); await click('.ac-legal-update-actions .ac-primary');
    assert.deepEqual(await js('responses'), [{kind:'terms',revisionId:'snapshot-4',locale:'en-US',action:'accept'}]);
    assert.equal(await js("document.querySelector('.ac-legal-notice')===null"), true);
    record('only the explicit checked action submits the exact immutable revision and displayed language');
    await js("(async()=>{legalStatus={...legalStatus,acceptanceRequired:false,updates:[{key:'terms',revisionId:'snapshot-4',version:'v4',action:'notice'}]};await LegalUpdates.refresh(true);})()");
    await js('LegalUpdates.open();'); await tick();
    assert.equal(await js("document.querySelector('.ac-legal-accept')===null"), true);
    await click('.ac-legal-update-actions .ac-primary');
    assert.equal(await js('responses[1].action'), 'notice');
    record('ordinary updates produce acknowledgement rather than acceptance evidence');
    await js("(async()=>{legalStatus={...legalStatus,acceptanceRequired:true,updates:[{key:'terms',revisionId:'snapshot-4',version:'v4',action:'accept'}]};SoduWorkAPI.clientAccountRequest=async(operation,payload)=>{if(operation==='legalStatus')return legalStatus;throw Object.assign(Error('changed'),{code:'LEGAL_VERSION_CHANGED'});};await LegalUpdates.refresh(true);})()");
    await js('LegalUpdates.open();'); await click('.ac-legal-accept input');
    await js("legalStatus={...legalStatus,documents:legalStatus.documents.map(d=>({...d,version:'v5',revisionId:'snapshot-5',content:'## Revised scope\\nNew publication wording.'})),requiredConsentVersions:{terms:'v5'},updates:[{key:'terms',version:'v5',revisionId:'snapshot-5',action:'accept'}]};");
    await click('.ac-legal-update-actions .ac-primary'); await tick();
    assert.equal(await js("document.querySelector('.ac-legal-accept input').checked"), false);
    assert.equal(await js("document.querySelector('.ac-legal-footer .ac-status').textContent.includes('latest version')"), true);
    await click('.ac-legal-update-actions .ac-secondary'); await js('LegalUpdates.open();'); await tick();
    assert.equal(await js("document.querySelector('.ac-legal-meta')"), null);
    assert.equal(await js("document.querySelector('.ac-legal-copy').textContent.includes('New publication wording.')"), true);
    assert.equal(await js("document.querySelector('.ac-legal-accept input').checked"), false);
    await click('.ac-legal-update-actions .ac-secondary');
    record('a publication race clears the checkbox and requires reviewing the new revision');
    await js("AccountUI.legal(document.body,legalStatus.documents,'terms',{consents:[{document:'terms',version:'v0',revisionId:'snapshot-0',locale:'en-US',acceptedAt:'2026-10-01'}],loadVersion:async()=>({documents:[{key:'terms',version:'v0',locale:'en-US',content:'Historical original text'}]})});void 0;");
    await click('.ac-legal-records summary'); await click('.ac-legal-records .ac-link'); await tick();
    assert.equal(await js("[...document.querySelectorAll('.ac-legal-copy')].at(-1).textContent"), 'Historical original text');
    await click('.ac-legal:last-child [data-legal-back]'); await click('[data-legal-back]');
    record('confirmation history loads the accepted immutable version in a separate reader');
    await js("SoduWorkAPI.clientAccountRequest=()=>new Promise(resolve=>window.resolveUpdate=resolve);void LegalUpdates.refresh(true);");
    await js("user={id:'another-owner'};dispatchEvent(new Event('soduwork-data-scope-changed'));resolveUpdate(legalStatus);LegalUpdates.clear();"); await tick();
    assert.equal(await js("document.querySelector('.ac-legal-notice')===null"), true);
    record('account changes discard delayed publication status and remove the old account notice');
    await js(`AccountUI.legal(document.body,[{key:'terms',locale:'zh-CN',title:'原文标题',format:'html',content:'<p style="text-align:center;font-size:14pt"><strong>原文标题</strong></p><h2 style="font-size:12pt;margin-bottom:8pt">1. 引言</h2><p style="margin-top:6pt;margin-bottom:8pt;line-height:1.5;text-indent:22pt">1.1 原文条款</p><p style="position:fixed;inset:0;background:url(https://untrusted.test/pixel);color:transparent">安全正文</p><script>window.htmlInjected=true</script><img src="https://untrusted.test/pixel" onerror="window.htmlInjected=true"><a href="https://untrusted.test">原文链接文字</a><table><tr><td colspan="2">合并单元格</td></tr></table>'}],'terms');void 0;`);
    assert.equal(await js("document.querySelector('.ac-legal-copy').textContent.split('原文标题').length-1"), 1);
    assert.deepEqual(await js("(()=>{const p=[...document.querySelectorAll('.sw-legal-html p')].find(p=>p.textContent.startsWith('1.1')),s=getComputedStyle(p);return [p.style.marginTop,p.style.marginBottom,p.style.lineHeight,p.style.textIndent,s.whiteSpace]})()"), ['6pt', '8pt', '1.5', '22pt', 'pre-wrap']);
    assert.equal(await js("!window.htmlInjected&&!document.querySelector('.ac-legal-copy img,.ac-legal-copy script,.ac-legal-copy a,[style*=fixed],[style*=url]')"), true);
    assert.equal(await js("document.querySelector('.ac-legal-copy td').colSpan"), 2);
    assert.equal(await js("document.querySelector('.ac-legal-toc li').textContent"), '1. 引言');
    await shot('reader-html-zh'); await click('[data-legal-back]');
    record('HTML preserves original title, paragraph metrics and tables, with inert chapter labels and no executable styles or remote assets');
    if (process.env.SODUWORK_LEGAL_SOURCE_HTML) {
      const content = fs.readFileSync(process.env.SODUWORK_LEGAL_SOURCE_HTML, 'utf8');
      await js(`SoduWorkI18n.setLocale('zh-CN');AccountUI.legal(document.body,[{key:'terms',locale:'zh-CN',format:'html',title:'SoduWork用户协议',content:${JSON.stringify(content)}}],'terms');void 0;`);
      assert.equal(await js("document.querySelector('.ac-legal-copy').textContent.split('SoduWork用户协议').length-1"), 1);
      assert.equal(await js("document.querySelector('.ac-legal-copy').textContent.includes('1.2 本服务支持')"), true);
      assert.equal(await js("getComputedStyle([...document.querySelectorAll('.ac-legal-copy p')].find(p=>p.textContent.startsWith('1.1'))).fontWeight"), '400');
      assert.equal(await js("(()=>{const p=document.querySelector('.ac-legal-copy');return p.scrollWidth<=p.clientWidth+1})()"), true);
      await shot('reader-original-cn-html'); await click('[data-legal-back]');
      record('the supplied Chinese Word original renders in the desktop reader without duplicate title, renumbering or horizontal overflow');
    }
    assert.deepEqual(await js('errors'), []); assert.deepEqual(report.network, []); report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); process.stderr.write(report.error + '\n'); })
    .finally(() => { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify({ ok: report.ok, cases: report.cases.length, report: path.join(out, 'report.json') }) + '\n'); win?.destroy(); app.exit(report.ok ? 0 : 1); });
}
