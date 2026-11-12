'use strict';
// Use real Chromium styles and forms with stub APIs and temporary user data.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-automation-layout-'));
  const out = path.resolve(process.argv[2] || path.join(client, '../outputs/automation-sheet-layout-20261016'));
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  const report = { ok: false, cases: [], errors: [], networkRequests: [] };
  let win;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  const rect = selector => js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return {x:r.x,y:r.y,bottom:r.bottom,right:r.right,width:r.width,height:r.height}})()`);
  async function open(inline = false) {
    await js(`WorkAutomationSheet.close(true);document.querySelector('#opener').focus();
      WorkAutomationSheet.open({${inline ? "host:document.querySelector('#inlineHost')," : ''}text:'每天18点检查报告',
        proposal:{title:'隔离自动化',note:'任务原文\\n'.repeat(100),acceptance:['保留所有内容','只使用替身服务']}})`);
    await delay(350);
  }
  async function key(keyCode, modifiers = []) {
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode, modifiers });
    await delay(50);
  }
  async function run(name, action) {
    const row = { name, ok: false };
    try { await action(row); row.ok = true; } catch (error) { row.error = String(error.stack || error); }
    report.cases.push(row);
  }
  app.whenReady().then(async () => {
    const desk = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
    const css = [...desk.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(m => m[1]);
    const href = file => pathToFileURL(path.join(client, file)).href;
    const fixture = path.join(temporary, 'fixture.html');
    fs.writeFileSync(fixture, '<!doctype html><html data-window-menu="true" data-window-titlebar="overlay"><head><meta charset="utf-8">' +
      css.map(file => '<link rel="stylesheet" href="' + href(file) + '">').join('') +
      '<style>#background{position:fixed;inset:34px 0 0;overflow:auto}#background>div{height:2000px;padding:40px}' +
      '#inlineHost{position:fixed;inset:50px 20px 20px;overflow:auto}#inlineHost:empty{display:none}</style></head><body>' +
      '<div class="window-menu">隔离验证 · 系统标题栏</div><main id="background"><div><button id="opener">创建自动化</button>' +
      '<p>背景需求池，滚动位置应保持</p></div></main><div id="inlineHost"></div></body></html>');
    win = new BrowserWindow({ show: false, width: 1200, height: 800, useContentSize: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, cb) => {
      report.networkRequests.push(request.url); cb({ cancel: true });
    });
    await win.loadFile(fixture);
    await js(`window.errors=[];addEventListener('error',e=>errors.push(e.message));
      window.saves=[];window._schmLoad=async()=>[{key:'report',name:'报告插件',version:'1.0.0',checksum:'a'.repeat(64),inputs:[]}];window.SoduWorkAPI={
        taskExecutionOptions:async()=>({substrates:[{key:'local:pi',name:'Pi',available:true}],repos:[]}),
        preflightSchedule:async()=>({state:'ready',message:'执行条件已就绪',checks:[{label:'隔离验证，无真实 Runner'}]}),
        createSchedule:async body=>{saves.push(body);return {...body,id:'fixture'}}};void 0;`);
    for (const file of ['plugin-ui-host', 'schedule-timing', 'panels-forward-select', 'work-automation-bindings', 'work-automation-view', 'work-automation-card-state','work-automation-sheet'])
      await js(fs.readFileSync(path.join(client, 'components/panels', file + '.js'), 'utf8') + '\nvoid 0;');

    await run('弹窗只滚动正文，头尾与完整遮罩保持位置', async row => {
      await open();
      const head = await rect('.waz-head'), foot = await rect('.waz-foot');
      const area = await rect('.waz-body');
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(area.x + area.width - 10), y: 400,
        deltaX: 0, deltaY: -1800, canScroll: true });
      await delay(400);
      row.geometry = { head, afterHead: await rect('.waz-head'), foot, afterFoot: await rect('.waz-foot'), backdrop: await rect('.pui-backdrop') };
      fs.writeFileSync(path.join(out, 'scrolled.png'), (await win.webContents.capturePage()).toPNG());
      assert.ok(Math.abs(head.y - row.geometry.afterHead.y) < 1, '滚动不能带走头部');
      assert.ok(foot.bottom <= 800 && Math.abs(foot.y - row.geometry.afterFoot.y) < 1, '操作区始终可见');
      assert.ok(row.geometry.backdrop.y <= 34 && row.geometry.backdrop.bottom >= 800, '遮罩持续覆盖工作区');
      assert.equal(await js('document.querySelector(".pui-layer").scrollTop'), 0);
      assert.ok(await js('document.querySelector(".waz-fields").scrollTop>0'), '字段区域实际发生滚动');
      assert.equal(await js('document.querySelector("#background").scrollTop'), 0);
    });
    for (const [width, height, zoom] of [[1200, 800, 1], [760, 560, 1], [480, 640, 1], [1200, 800, 1.5]]) {
      await run(`窗口 ${width}×${height} 缩放 ${zoom}：标题栏留白、关闭及提交可见`, async row => {
        win.setContentSize(width, height); win.webContents.setZoomFactor(zoom); await open();
        const viewport = await js('({w:innerWidth,h:innerHeight})');
        const dialog = await rect('.pui-dialog'), close = await rect('.waz-close'), save = await rect('[data-waz-save]');
        row.geometry = { viewport, dialog, close, save };
        assert.ok(dialog.y >= 34, '避开原生窗口标题栏');
        assert.ok(dialog.bottom <= viewport.h && dialog.x >= 0 && dialog.right <= viewport.w, '弹窗不能越过视口');
        assert.ok(close.y >= 34 && save.bottom <= viewport.h, '关闭与提交可见');
        assert.ok(await js('document.querySelector(".pui-dialog").scrollWidth<=document.querySelector(".pui-dialog").clientWidth+1'), '没有横向溢出');
        fs.writeFileSync(path.join(out, `viewport-${width}-${height}-${zoom}.png`), (await win.webContents.capturePage()).toPNG());
      });
    }
    await run('键盘留在弹窗中，关闭后返回发起按钮', async () => {
      win.setContentSize(1200, 800); win.webContents.setZoomFactor(1); await open();
      assert.equal(await js('document.activeElement.classList.contains("waz-close")'), true);
      assert.equal(await js('document.querySelector(".waz-sheet").getAttribute("aria-modal")'), 'true');
      await js('document.querySelector("[data-waz-save]").focus();void 0;');
      await key('Tab'); assert.equal(await js('document.activeElement.classList.contains("waz-close")'), true);
      await key('Tab', ['shift']); assert.equal(await js('document.activeElement.hasAttribute("data-waz-save")'), true);
      await js('document.querySelector(".waz-close").click();void 0;'); await delay(150);
      assert.equal(await js('document.activeElement.id'), 'opener');
    });
    await run('顶部修改后直接提交也能看到校验错误，草稿不丢失', async () => {
      await open(); await js('document.querySelector("[name=title]").value="";document.querySelector("[data-waz-save]").click();void 0;');
      const error = await rect('#wazError');
      assert.ok(error.y >= 34 && error.bottom <= 800, '校验反馈必须可见');
      assert.match(await js('document.querySelector("#wazError").textContent'), /名字/);
      assert.equal(await js('saves.length'), 0);
      assert.equal(await js('document.querySelector("[name=note]").value'), '任务原文\n'.repeat(100));
    });
    await run('切换工作方法重绘后保持滚动位置和键盘焦点', async () => {
      await open();
      const before = await js(`(()=>{const field=document.querySelector('[name=personalPluginKey]');
        field.focus();const top=document.querySelector('.waz-fields').scrollTop;
        field.value='report';field.dispatchEvent(new Event('change',{bubbles:true}));return top})()`);
      assert.ok(before > 0);
      assert.equal(await js('document.querySelector(".waz-fields").scrollTop'), before);
      assert.equal(await js('document.activeElement.name'), 'personalPluginKey');
      assert.equal(await js('document.querySelector("[name=personalPluginKey]").value'), 'report');
    });
    await run('Escape 只关闭自动化弹窗并恢复背景入口', async () => {
      await open(); await key('Escape'); await delay(150);
      assert.equal(await js('!!document.querySelector(".pui-layer")'), false);
      assert.equal(await js('document.activeElement.id'), 'opener');
    });
    await run('固定操作区仍通过原表单保存完整正文、标准和启用状态', async () => {
      await open(); await js('document.querySelector("[name=enabled]").checked=false;document.querySelector("[data-waz-save]").click();void 0;');
      await delay(100);
      assert.equal(await js('saves.length'), 1);
      assert.equal(await js('saves[0].enabled'), false);
      assert.ok(await js('saves[0].note.includes("任务原文\\n".repeat(99))'));
      assert.ok(await js('saves[0].note.includes("保留所有内容")'));
      assert.ok((await rect('.waz-saved')).bottom <= 800);
    });
    await run('长失败说明可完整查看，提交按钮保持可见并能重试', async () => {
      await open();
      await js(`window.originalPreflight=SoduWorkAPI.preflightSchedule;
        SoduWorkAPI.preflightSchedule=async()=>{throw Error('隔离失败原因与处理建议。'.repeat(120))};
        document.querySelector('[data-waz-save]').click();void 0;`);
      await delay(100);
      const save = await rect('[data-waz-save]');
      assert.ok(save.bottom <= 800 && save.y >= 34, '长错误不能把提交按钮推出视口');
      assert.equal(await js('document.querySelector("[data-waz-save]").disabled'), false);
      assert.ok(await js('document.querySelector("#wazError").textContent.length > 1000'));
      await js('SoduWorkAPI.preflightSchedule=originalPreflight;document.querySelector("[data-waz-save]").click();void 0;');
      await delay(100);
      assert.equal(await js('!!document.querySelector(".waz-saved")'), true, '预检失败后可以重试并成功创建');
    });
    await run('创建结果未确认时禁止重复提交，提供管理页查询入口', async () => {
      await open();
      await js(`window.originalCreate=SoduWorkAPI.createSchedule;
        SoduWorkAPI.createSchedule=async()=>{throw Error('创建请求连接中断')};
        document.querySelector('[data-waz-save]').click();void 0;`);
      await delay(100);
      assert.equal(await js('document.querySelector("[data-waz-save]").disabled'), true);
      assert.match(await js('document.querySelector("#wazError").textContent'), /创建结果尚未确认/);
      assert.equal(await js('!!document.querySelector("[data-waz-open]")'), true);
      await js('SoduWorkAPI.createSchedule=originalCreate;void 0;');
    });
    await run('创建表单通过有限选项选择时间，并保存所选时分', async () => {
      await open();
      assert.deepEqual(await js(`['clockHour','clockMinute','minute'].map(name=>{
        const field=document.querySelector('[name='+name+']');return [field.tagName,field.options.length];})`),
        [['SELECT',24],['SELECT',60],['SELECT',60]]);
      await js(`document.querySelector('[name=clockHour]').focus();void 0;`);
      await key('End');
      assert.ok((await rect('.fwd-select-compact-time')).height <= 220);
      await key('Enter');
      await js(`document.querySelector('[name=clockMinute]').focus();void 0;`);
      await key('End');
      assert.ok((await rect('.fwd-select-compact-time')).height <= 220);
      fs.writeFileSync(path.join(out, 'compact-minute-menu.png'), (await win.webContents.capturePage()).toPNG());
      await key('Enter');
      assert.equal(await js('document.querySelector("[name=clockHour]").value'), '23');
      assert.equal(await js('document.querySelector("[name=clockMinute]").value'), '59');
      await js(`document.querySelector('[data-waz-save]').click();void 0;`);
      await delay(100);
      assert.deepEqual(await js('({hour:saves.at(-1).atHour,minute:saves.at(-1).atMinute})'), {hour:23,minute:59});
    });
    await run('每周和每月多选与可选日期范围保持完整保存', async () => {
      for (const mode of ['weekly','monthly']) {
        await open();
        const before=await js('saves.length');
        await js(`(()=>{const field=document.querySelector('[name=every]');field.value=${JSON.stringify(mode)};
          field.dispatchEvent(new Event('change',{bubbles:true}));
          for(const input of document.querySelectorAll('[name=${mode === 'weekly' ? 'weekdays' : 'monthDays'}]')) {
            const selected=${mode === 'weekly' ? '[1,3,5]' : '[30,31]'}.includes(Number(input.value));
            if(input.checked!==selected)input.click();
          }
          document.querySelector('[name=startDate]').value='2099-01-01';
          document.querySelector('[name=endDate]').value='2098-12-31';
          document.querySelector('[data-waz-save]').click();})()`);
        assert.equal(await js('saves.length'),before);
        await js(`(()=>{const end=document.querySelector('[name=endDate]');end.value='2099-12-31';
          end.dispatchEvent(new Event('input',{bubbles:true}));
          document.querySelector('[data-waz-${mode === 'weekly' ? 'weekday' : 'monthday'}]').scrollIntoView({block:'center'});})()`);
        await delay(80);
        fs.writeFileSync(path.join(out, mode+'-sheet.png'), (await win.webContents.capturePage()).toPNG());
        await js(`document.querySelector('[data-waz-save]').click();void 0;`);await delay(100);
        assert.equal(await js('saves.length'),before+1);
        assert.deepEqual(await js(`(()=>{const v=saves.at(-1);return [v.every,v.${mode === 'weekly' ? 'weekdays' : 'monthDays'},v.startDate,v.endDate]})()`),
          [mode,mode==='weekly'?[1,3,5]:[30,31],'2099-01-01','2099-12-31']);
      }
    });
    await run('自定义规则保存完整文本，空规则阻止提交；反复打开关闭不残留菜单', async row => {
      await open();
      const before=await js('saves.length');
      await js(`(()=>{const cadence=document.querySelector('[name=every]');cadence.value='custom';
        cadence.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await js(`(()=>{const field=document.querySelector('[name=customRule]');field.value='';
        field.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-waz-save]').click();})()`);
      assert.equal(await js('saves.length'),before);
      assert.equal(await js('document.activeElement.name'),'customRule');
      const rule='DTSTART;TZID=Asia/Shanghai:20990101T105100\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=10';
      await js(`(()=>{const field=document.querySelector('[name=customRule]');field.value=${JSON.stringify(rule)};
        field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      fs.writeFileSync(path.join(out, 'custom-rule-sheet.png'), (await win.webContents.capturePage()).toPNG());
      await js(`document.querySelector('[data-waz-save]').click();void 0;`);await delay(100);
      assert.equal(await js('saves.at(-1).customRule'),rule);
      row.pressure=await js(`(async()=>{const start=performance.now();
        for(let i=0;i<50;i++){WorkAutomationSheet.close(true);
          await WorkAutomationSheet.open({text:'每天18点检查报告'});
          document.querySelector('[name=clockMinute]').nextElementSibling.querySelector('button').click();
          WorkAutomationSheet.close(true);}
        return{ms:performance.now()-start,popups:document.querySelectorAll('.fwd-select-popup').length,
          controls:document.querySelectorAll('.waz-sheet .fwd-select').length};})()`);
      assert.equal(row.pressure.popups,0);assert.equal(row.pressure.controls,0);
    });
    await run('四种语言下自定义规则和紧凑时间菜单保持完整布局与主题色', async row => {
      for (const file of JSON.parse(fs.readFileSync(path.join(client,'core/locales/manifest.json'),'utf8')))
        await js(fs.readFileSync(path.join(client,'core/locales',file),'utf8')+'\nvoid 0;');
      await js(fs.readFileSync(path.join(client,'core/i18n-dom.js'),'utf8')+'\nvoid 0;');
      await js(fs.readFileSync(path.join(client,'core/i18n.js'),'utf8')+'\nvoid 0;');
      row.locales=[];
      for(const locale of ['zh-CN','en-US','ja-JP','ko-KR']) {
        await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)});document.documentElement.dataset.theme='warm';void 0;`);
        await open();
        await js(`(()=>{const cadence=document.querySelector('[name=every]');cadence.value='custom';
          cadence.dispatchEvent(new Event('change',{bubbles:true}));
          document.querySelector('[name=customRule]').scrollIntoView({block:'center'});})()`);
        await delay(80);
        const label=await js('document.querySelector("[name=every] option:checked").textContent');
        if(locale!=='zh-CN')assert.notEqual(label,'自定义');
        if(locale==='en-US') {
          assert.ok(!/[\u4e00-\u9fff]/.test(await js('document.querySelector("[data-waz-custom]").textContent')));
          assert.ok(!/[\u4e00-\u9fff]/.test(await js('document.querySelector("#wazProbe").textContent')));
        }
        await js(`(()=>{const field=document.querySelector('[name=customRule]');
          field.value='DTSTART;TZID=Asia/Shanghai:20990101T105100\\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=10';
          field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await delay(350);
        assert.equal(await js('document.querySelector(".waz-form").scrollWidth<=document.querySelector(".waz-form").clientWidth+1'),true);
        fs.writeFileSync(path.join(out, 'custom-'+locale+'.png'), (await win.webContents.capturePage()).toPNG());
        row.locales.push({locale,label});
      }
      await js(`SoduWorkI18n.setLocale('zh-CN');void 0;`);
    });
    await run('聊天内嵌表单保持自然高度，不增加弹窗内滚动与焦点锁', async () => {
      await open(true);
      assert.equal(await js('document.querySelector(".pui-layer")'), null);
      assert.equal(await js('document.querySelector(".waz-sheet").getAttribute("aria-modal")'), null);
      assert.equal(await js('getComputedStyle(document.querySelector(".waz-body")).overflowY'), 'visible');
      assert.ok((await rect('.waz-sheet')).height > 800);
    });
    report.errors = await js('errors');
    report.ok = report.cases.every(row => row.ok) && !report.errors.length && !report.networkRequests.length;
  }).catch(error => { report.error = String(error.stack || error); }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); if (win) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
