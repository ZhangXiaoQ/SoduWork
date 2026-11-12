'use strict';
// Production renderers with isolated storage and local API fixtures only.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
require('./lib/isolated-profile.cjs').isolateProfile(app, 'runtime-locales');
const root = path.resolve(__dirname, '..');
const output = path.resolve(root, '../outputs/cli-i18n-20261031/ui');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
let win;
const js = code => win.webContents.executeJavaScript(code);
const tick = () => js('new Promise(resolve => setTimeout(resolve, 60))');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  win = new BrowserWindow({ show: false, width: 1100, height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_r, cb) => cb({ cancel: true }));
  await win.loadFile(path.join(__dirname, 'fixtures/cloud-environments.html'));
  for (const name of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + name) + '\n;void 0;');
  for (const name of ['core/i18n-dom.js', 'core/i18n.js', 'components/panels/agent-brand.js', 'components/panels/panels-agents.js', 'components/panels/panels-desk.js']) await js(read(name) + '\n;void 0;');
  await js(`window.errors=[];addEventListener('error',event=>errors.push(event.message));
    window.esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
    window.petSay=()=>{};
    SoduWorkAPI.localAgentSetup=async()=>({modelCount:1,models:[],machines:[{runnerId:'fixture-local',scope:'current-instance',label:'保存',env:{ok:true},agents:[
      {key:'claude',name:'Claude Code CLI',installed:true,present:true,setupState:'unauthed',state:'unauthed',modelPick:false,
       accountSetup:{shell:'PowerShell',command:'fixture account login 保存 {sender}'},
       why:'请先连接当前执行环境的账号。',whyMessage:{key:'agent.auth.required',fallback:'请先连接当前执行环境的账号。'},
       blurb:'Anthropic 官方 Claude Code，通过 ACP 适配器接入；使用自己的 Anthropic 账号。'},
      {key:'kimi',name:'Kimi Code CLI',installed:false,setupState:'missing',state:'missing',
       blurb:'Kimi 官方编码助手，通过 ACP 接入，使用已授权的企业模型。'}]}]});
    SoduWorkAPI.agentSetup=SoduWorkAPI.localAgentSetup;openAgentsPanel();void 0;`);
  await tick();
  await js(`_agJobs['fixture-local~claude']={key:'fixture-local~claude',action:'repair',state:'done',ok:false,
    detail:'fixture detail <fixture>',lines:['\u4fee\u590d\u672a\u5b8c\u6210','custom diagnostic <fixture>']};`);
  await js(`document.querySelector('[data-atoggle="fixture-local~claude"]').click()`);
  await js(read('components/panels/panels-chat-status.js'));
  await js(`window.runtimeNotice='当前会话没有授权：浏览网页。请新建会话并开启对应能力后再使用这个插件';
    const notice=document.createElement('span');notice.dataset.runtimeNotice=runtimeNotice;notice.setAttribute('translate','no');
    notice.textContent=ChatStatus.notice(runtimeNotice);document.body.append(notice);
    const reply=document.createElement('p');reply.dataset.messageContent='';reply.id='originalReply';
    reply.textContent=runtimeNotice;document.body.append(reply);`);
  for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN', 'en-US']) {
    await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)})`); await tick();
    const runtimeNotice=await js('document.querySelector("[data-runtime-notice]").textContent');
    assert.equal(runtimeNotice,await js('ChatStatus.notice(window.runtimeNotice)'));
    assert.equal(await js('document.querySelector("#originalReply").textContent'),await js('window.runtimeNotice'));
    if(locale==='en-US')assert.doesNotMatch(runtimeNotice,/[\u3400-\u9fff]/);
    if(locale==='ja-JP')assert.ok(runtimeNotice.includes('ウェブを閲覧'));
    if(locale==='ko-KR')assert.ok(runtimeNotice.includes('웹 탐색'));
    const text = await js('document.querySelector("#agDrawerWrap").innerText');
    assert.ok(text.includes('Claude Code'));
    assert.ok(!text.includes('Claude Code CLI'));
    assert.ok(text.includes('fixture account login 保存 {sender}'));
    assert.ok(text.includes(await js('SoduWorkI18n.t("agent.auth.required")')), locale + ' drawer status');
    const repairLabel = await js("SoduWorkI18n.translateText('\u4fee\u590d\u672a\u5b8c\u6210')");
    assert.equal(await js('document.querySelector("#agDrawerWrap .ag-job-h b").textContent'), repairLabel, locale + ' repair status');
    assert.equal(await js('document.querySelector("#agDrawerWrap [data-alog]").textContent'), repairLabel + '\ncustom diagnostic <fixture>', locale + ' translated and original log lines');
    assert.equal(await js('document.querySelector("#agDrawerWrap .ag-job-h>span").textContent'), 'fixture detail <fixture>');
    assert.equal(await js('document.querySelector("#agDrawerWrap fixture")'), null, 'diagnostics render as text');

    const notice = await js(`_noticePresentation({kind:'task_assignment',senderName:'保存',text:'legacy',textMessage:{key:'notification.task_assignment',params:{sender:'保存',title:'New chat'},fallback:'legacy'}}).text`);
    assert.ok(notice.includes('保存') && notice.includes('New chat'), 'business values preserved');
    assert.notEqual(notice, 'legacy');
    await js(`CloudEnvironmentSetup.edit({id:'a',name:'保存',canManage:true,mode:'accepting',workRoot:'/work'})`); await tick();
    assert.equal(await js('document.querySelector(".ce-dialog header p").textContent'), '保存');
    await js(`document.querySelector('.ce-dialog input[name=name]').value='user draft';SoduWorkI18n.setLocale('zh-CN')`); await tick();
    assert.equal(await js('document.querySelector("#ceDialogTitle").textContent'), '环境设置');
    assert.equal(await js('document.querySelector(".ce-dialog input[name=name]").value'), 'user draft');
    await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)})`); await tick();
    assert.equal(await js('document.querySelector("#ceDialogTitle").textContent'), await js(`SoduWorkI18n.translateText('环境设置')`));
    assert.equal(await js(`document.querySelector('.ce-dialog').matches(':modal')`), true, 'dialog remains modal after a language switch');
    assert.equal(await js(`(()=>{const d=document.querySelector('.ce-dialog'),r=d.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('dialog')===d})()`), true, 'dialog is visible above the drawer');
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(output, locale + '.png'), (await win.webContents.capturePage()).toPNG());
    await js('CloudEnvironmentSetup.close()');
  }
  assert.deepEqual(await js('errors'), []);
  console.log('PASS: four locales, live drawer/dialog switches, preserved drafts and notification business content');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); win?.destroy(); app.exit(1); });
