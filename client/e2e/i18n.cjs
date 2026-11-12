'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence directory required');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-i18n-')));
const report = { cases: [], screenshots: [], missing: {} };
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
let win;
const js = code => win.webContents.executeJavaScript(code);
const tick = () => js('new Promise(resolve => setTimeout(resolve, 60))');
async function inject() {
  if (await js('!!window.SoduWorkI18n')) return;
  for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
  await js(read('core/i18n-dom.js'));
  await js(read('core/i18n.js'));
}
async function shot(name) {
  const file = path.join(output, name + '.png');
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  report.screenshots.push(file);
}
async function run() {
  win = new BrowserWindow({ show: false, width: 1050, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, cb) => cb({ cancel: true }));
  await win.loadURL('about:blank');
  await js(`document.body.innerHTML = '<button id="state">保存</button><p id="changing">加载中…</p><input id="entry" placeholder="搜索"><pre><code>保存</code></pre><div data-user-content id="user">保存</div><div contenteditable="true" id="edit">保存</div><div id="dynamic"></div>'`);
  await inject();
  await js('SoduWorkI18n.setLocale("en-US")'); await tick();
  assert.equal(await js('document.querySelector("#state").textContent'), 'Save');
  assert.equal(await js('document.querySelector("#entry").placeholder'), 'Search');
  assert.equal(await js('document.querySelector("#user").textContent'), '保存');
  assert.equal(await js('document.querySelector("#edit").textContent'), '保存');
  assert.equal(await js('document.querySelector("code").textContent'), '保存');
  report.cases.push('UI text translates; code, editable text and user values remain unchanged');
  await js(`document.querySelector('#dynamic').innerHTML='<div class="nmsg ai"><div class="ntext"><div class="nmd">保存</div><button class="ntext-copy" title="复制">复制</button></div><div class="nthink"><button class="nthink-head">思考过程</button><div class="nthink-body">删除</div></div></div>'`); await tick();
  assert.equal(await js('document.querySelector(".nmd").textContent'), '保存');
  assert.equal(await js('document.querySelector(".nthink-body").textContent'), '删除');
  assert.equal(await js('document.querySelector(".ntext-copy").title'), 'Copy');
  assert.equal(await js('document.querySelector(".ntext-copy").textContent'), 'Copy');
  report.cases.push('chat controls translate while assistant text and reasoning remain verbatim');
  await js(`document.querySelector('#dynamic').innerHTML='<pre id="toolUi">'+SoduWorkI18n.html('正在执行…','正在执行…')+'</pre><pre id="rawOutput">正在执行…</pre><button id="customTitle" data-user-attributes="title" title="保存">保存</button>'`); await tick();
  assert.equal(await js('document.querySelector("#rawOutput").textContent'), '正在执行…');
  assert.equal(await js('document.querySelector("#customTitle").title'), '保存');
  assert.equal(await js('document.querySelector("#customTitle").textContent'), 'Save');
  await js(`SoduWorkI18n.setLocale('zh-CN')`); await tick();
  assert.equal(await js('document.querySelector("#toolUi").textContent'), '正在执行…');
  await js(`SoduWorkI18n.setLocale('en-US')`); await tick();
  assert.equal(await js('/[A-Za-z]/.test(document.querySelector("#toolUi").textContent)'), true);
  report.cases.push('explicit tool placeholders localize inside preformatted output and user attributes stay verbatim');
  await js(`document.querySelector('#changing').firstChild.nodeValue='已完成';document.querySelector('#entry').placeholder='取消';document.querySelector('#dynamic').innerHTML='<input id="rootAttribute" title="删除"><div data-user-content id="newUser"></div>';document.querySelector('#newUser').appendChild(document.createTextNode('保存'));`); await tick();
  assert.equal(await js('document.querySelector("#changing").textContent'), 'Done');
  assert.equal(await js('document.querySelector("#entry").placeholder'), 'Cancel');
  assert.equal(await js('document.querySelector("#rootAttribute").title'), 'Delete');
  assert.equal(await js('document.querySelector("#newUser").textContent'), '保存');
  await js('SoduWorkI18n.setLocale("zh-CN")'); await tick();
  assert.equal(await js('document.querySelector("#changing").textContent'), '已完成');
  assert.equal(await js('document.querySelector("#entry").placeholder'), '取消');
  report.cases.push('reused nodes, root attributes and new text nodes update and restore the latest values');
  await js(`let clicks=0;document.querySelector('#state').onclick=()=>clicks++;document.querySelector('#entry').value='未提交的草稿';document.querySelector('#entry').focus();for(let i=0;i<5;i++){SoduWorkI18n.setLocale('en-US');SoduWorkI18n.setLocale('zh-CN');}document.querySelector('#state').click();`);
  assert.equal(await js('clicks'), 1);
  assert.equal(await js('document.querySelector("#entry").value'), '未提交的草稿');
  assert.equal(await js('document.activeElement.id'), 'entry');
  report.cases.push('repeated toggles preserve input, focus and click handlers');
  await js(`document.body.innerHTML='<div id="mcNew" style="display:none"></div>';window.tasks=[{id:'ui-word',title:'保存（有会话）abcdefghijklmnopqrstuvwxyz0123456789'}];window.esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));void 0;`);
  await js(read('components/panels/console-multi.js') + '\nvoid 0;');
  await js(`_MC.meta={known:{taskId:'ui-word',title:tasks[0].title}};_mcTick=()=>{};_mcToggleNew(true);SoduWorkI18n.setLocale('en-US')`); await tick();
  assert.equal(await js('document.querySelector("#mcNewTask option").textContent'), '保存（有会话）abcdefghijklmnopqrstuvwxyz0123456 (has chat)');
  await js('_mcCreate();SoduWorkI18n.setLocale("zh-CN")'); await tick();
  assert.equal(await js('_MC.extra[0].title'), '保存（有会话）abcdefghijklmnopqrstuvwxyz0123456789');
  report.cases.push('multi-console task names stay verbatim and retain their full source after selection');
  // Render production settings markup and CSS in an isolated renderer.
  const desk = read('desk.html');
  const settings = desk.slice(desk.indexOf('<div class="panel" id="settingsPanel">'), desk.indexOf('<div class="skin-manager"'));
  await win.loadURL('about:blank');
  await js(`document.head.innerHTML='<style>'+${JSON.stringify(read('theme/variables.css') + read('components/settings/settings.css'))}+'</style>';document.body.innerHTML=${JSON.stringify(settings)};document.documentElement.dataset.deskPanel='workspace';document.documentElement.dataset.workspaceView='settings';document.querySelector('#settingsPanel').classList.add('show');`);
  await inject();
  await js(`const localeSelect=document.querySelector('#localeSelect');localeSelect.value='en-US';SoduWorkI18n.setLocale(localeSelect.value)`); await tick();
  report.missing.settings = await js(`SoduWorkI18n.getMissing().filter(s=>s!=='简体中文')`);
  assert.deepEqual(report.missing.settings, [], 'settings contain untranslated UI');
  await js(`(()=>{const select=document.querySelector('#localeSelect');select.value='ja-JP';SoduWorkI18n.setLocale(select.value);})()`); await tick();
  assert.equal(await js('SoduWorkI18n.getLocale()'), 'ja-JP');
  assert.equal(await js('document.querySelector("#localeSelect").value'), 'ja-JP');
  assert.equal(await js('document.querySelector("#settingsPanel [data-i18n=language]").textContent'), '言語');
  await js(`(()=>{const select=document.querySelector('#localeSelect');select.value='ko-KR';SoduWorkI18n.setLocale(select.value);})()`); await tick();
  assert.equal(await js('SoduWorkI18n.getLocale()'), 'ko-KR');
  assert.equal(await js('document.querySelector("#localeSelect").value'), 'ko-KR');
  assert.equal(await js('document.querySelector("#settingsPanel [data-i18n=language]").textContent'), '언어');
  await js('SoduWorkI18n.setLocale("en-US")'); await tick();
  report.cases.push('Japanese and Korean settings selections persist in the native locale select and translate the settings label');
  await shot('settings-en');
  win.setSize(820, 720); await tick(); await shot('settings-en-narrow');
  report.settingsOverflow = await js('document.documentElement.scrollWidth > innerWidth + 1');
  report.cases.push('production settings markup rendered in English at 1050px and 820px');
  win.setSize(1280, 900);
  await win.loadFile(path.join(__dirname, 'fixtures/model-settings.html'));
  await inject(); await js('SoduWorkI18n.setLocale("en-US")'); await tick();
  await js('selectService("personal")'); await tick();
  report.missing.models = await js(`SoduWorkI18n.getMissing().filter(s=>s!=='简体中文')`);
  assert.deepEqual(report.missing.models, [], 'models or sidebar contain untranslated UI');
  assert.equal(await js('document.querySelector(".cfg-master-head strong").textContent'), 'Available models: 2');
  await js(`fill('[data-pkey]', 'unsaved-input');document.querySelector('[data-pkey]').focus();`);
  await shot('models-en');
  await js('SoduWorkI18n.setLocale("zh-CN")'); await tick();
  assert.equal(await js('document.querySelector("[data-ptest]").textContent.includes("保存")'), true);
  assert.equal(await js('document.querySelector(".cfg-master-head strong").textContent'), '2 个可选模型');
  assert.equal(await js('document.querySelector("[data-pkey]").value'), 'unsaved-input');
  assert.equal(await js('document.activeElement.hasAttribute("data-pkey")'), true);
  report.cases.push('production model form follows toggles after service selection');
  await win.loadURL('about:blank');
  await js(`document.body.innerHTML='<main id="goal"></main>';document.head.innerHTML='<style>'+${JSON.stringify(read('theme/variables.css') + read('components/panels/work-intent.css'))}+'</style>'`);
  await inject();
  await js(read('components/panels/work-intent.js'));
  await js(`document.querySelector('#goal').innerHTML=WorkIntent.rail('test');WorkIntent.showGoal(document.querySelector('#goal'),{mode:'goal',goal:'保存' },'test',{failed:true,canContinue:true,detail:'后台连接已断开'});SoduWorkI18n.setLocale('en-US')`); await tick();
  report.missing.goal = await js('SoduWorkI18n.getMissing()');
  assert.deepEqual(report.missing.goal, [], 'goal controls contain untranslated UI');
  assert.equal(await js(`!!document.querySelector('#goal button')`), true);
  await shot('goal-en');
  report.cases.push('production goal rail renders its blocked and resumable state in the locale adapter');
  await win.loadURL('about:blank');
  await js(`document.body.innerHTML='<main id="issues"></main>';document.head.innerHTML='<style>'+${JSON.stringify(read('theme/variables.css') + read('components/requirements/requirements-board.css'))}+'</style>'`);
  await inject();
  for (const file of ['core/requirements.js', 'components/panels/task-trace-approval.js', 'components/requirements/requirements-view.js']) await js(read(file));
  await js(`window.__teamCap={meId:'fixture-reviewer'};
    window.renderIssues=()=>{document.querySelector('#issues').innerHTML=RequirementsView.board([
      {id:'pending',title:'核对成果并选择验收方式',status:'done',createdBy:'fixture-reviewer',canReview:true},
      {id:'direct',title:'User title 保存',status:'done',createdBy:'fixture-reviewer',canReview:true}
    ],{...Requirements.defaults,limits:{}},{approvals:new Map([['pending',{id:'review',action:'review',status:'pending'}]])});};renderIssues();`);
  for (const [locale, label] of [
    ['en-US', 'Review outputs and choose a review method'],
    ['ja-JP', '成果を確認して検収方法を選択'],
    ['ko-KR', '성과를 확인하고 검수 방식 선택'],
    ['zh-CN', '核对成果并选择验收方式'],
    ['en-US', 'Review outputs and choose a review method'],
  ]) {
    await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)})`); await tick();
    for (const redraw of [false, true]) {
      if (redraw) { await js('renderIssues()'); await tick(); }
      assert.deepEqual(await js(`Array.from(document.querySelectorAll('.rq-card-decision'),node=>node.textContent)`), [label, label]);
      assert.deepEqual(await js(`Array.from(document.querySelectorAll('.rq-card-decision'),node=>node.dataset.rqOpen).sort()`), ['direct', 'pending']);
      assert.deepEqual(await js(`['pending','direct'].map(id=>document.querySelector('[data-hbid="'+id+'"] .rq-card-title').textContent)`), ['核对成果并选择验收方式', 'User title 保存']);
      assert.equal(await js(`document.querySelectorAll('.rq-card-decision svg').length`), 4);
    }
    await shot('acceptance-entry-' + locale);
  }
  report.cases.push('Pending and direct acceptance entries follow all four locales before and after rerender; user titles and navigation remain unchanged');
  await js(read('components/panels/panels-chat-chrome.js'));
  await js(`document.body.innerHTML='<main class="nchat" id="summaryChat"><div class="nchat-stage"><div class="nchat-main">'+ChatChrome.header()+'</div></div></main>';
    ChatChrome.bind(document.querySelector('#summaryChat'),()=>({ref:'locale-fixture'}));ChatChrome.openSummary();`);
  for (const [locale, toggle, close] of [
    ['en-US', 'Toggle output summary panel', 'Close output summary'],
    ['ja-JP', '成果サマリーパネルを切り替え', '成果サマリーを閉じる'],
    ['ko-KR', '산출물 요약 패널 전환', '산출물 요약 닫기'],
    ['zh-CN', '切换成果摘要面板', '关闭成果摘要'],
  ]) {
    await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)})`); await tick();
    assert.deepEqual(await js(`['[data-chat-summary]','[data-chat-summary-close]'].map(s=>document.querySelector(s).getAttribute('aria-label'))`), [toggle, close]);
    assert.deepEqual(await js(`['[data-chat-summary]','[data-chat-summary-close]'].map(s=>document.querySelector(s).title)`), [toggle, close]);
  }
  report.cases.push('Summary toggle and close controls follow all four locales, including tooltips and accessible names.');
  report.ok = true;
}
app.whenReady().then(run).catch(error => { report.error = error.stack; }).finally(() => {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win?.destroy(); app.exit(report.ok ? 0 : 1);
});
