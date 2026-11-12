'use strict';
// Production requirement board and monthly renderer with synthetic tasks only.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const output = process.argv[2];
assert.ok(output && path.isAbsolute(output)); fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { ok: false, layouts: [], cases: [] }; let win;
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1366, height: 900, show: false, webPreferences: { offscreen: true, sandbox: true } });
    const js = text => win.webContents.executeJavaScript(text, true);
    await win.loadFile(path.join(__dirname, 'fixtures/requirements-board.html'));
    await js('for(const key of Object.keys(localStorage))if(key.startsWith("fixture:"))localStorage.removeItem(key)');
    await win.loadFile(path.join(__dirname, 'fixtures/requirements-board.html'));
    win.webContents.setZoomFactor(1);
    const click = async selector => {
      const point = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'nearest',inline:'nearest'});const r=n.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
      await pause(100);
    };
    await js(`(()=>{
      const base=tasks.find(t=>t.id==='ready-0'),day=n=>new Date(2026,10,n).getTime();
      tasks=[
        {id:'long',title:'产出《登录页验证码加载优化与异常场景验证》需求规格说明书，包含跨平台浏览器兼容性与错误恢复方案',start:day(1),due:day(2)},
        {id:'last',title:'修复月末单日交付的登录页面问题',start:day(30),due:day(30)},
        {id:'done',title:'写一篇秋天主题的短文',start:day(9),due:day(12),status:'done',actualStart:day(9),actualEnd:day(14)},
        {id:'english',title:'Deliver the international enterprise sign-in and accessibility specification with all requested compatibility requirements',start:day(2),due:day(3)},
        {id:'across',title:'跨月份的需求保持真实日期跨度',start:day(-2),due:day(6)},
        {id:'routine',title:'每周汇总本周需求进展',recur:'weekly',start:day(1),due:null},
        {id:'actual',title:'只有实际执行日期的记录',start:null,createdAt:null,actualStart:day(20),actualEnd:day(23)},
        {id:'outside',title:'下个月才开始的需求',start:new Date(2026,11,1).getTime(),due:new Date(2026,11,2).getTime()}
      ].map(t=>({...base,assigneeName:'测试执行负责人',status:'doing',myRoles:['executor','creator'],...t}));
      RequirementsBoard.render();return true;
    })()`);
    await click('[data-rq-scope="related"]');
    await click('.rq-menu-toggle'); await click('[data-rq-view="gantt"]');
    // The fixture month is fixed so clipping and last-day geometry remain deterministic.
    const current = new Date();
    const steps = (2026 - current.getFullYear()) * 12 + 10 - current.getMonth();
    for (let i = 0; i < Math.abs(steps); i++) await click('[data-gvnav="' + Math.sign(steps) + '"]');
    for (const [width, height, zoom, theme] of [[1366,900,1,'vivid'],[900,900,1,'vivid'],[1366,900,1.5,'vivid'],[1200,900,1,'dark'],[600,600,1,'vivid'],[420,600,1,'vivid'],[1800,900,1,'vivid'],[3745,1100,1,'vivid']]) {
      win.setSize(width, height); win.webContents.setZoomFactor(zoom);
      await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('.gv-body').scrollLeft=0`); await pause(120);
      const geometry = await js(`(()=>{
        const chart=document.querySelector('.gv-body'),rows=[...chart.querySelectorAll('.gv-row:not(.gv-headrow)')];
        return {chartWidth:chart.clientWidth,scrollWidth:chart.scrollWidth,documentOverflow:document.documentElement.scrollWidth>innerWidth,
          scrollbarHeight:chart.offsetHeight-chart.clientHeight-2,scrollbarBottom:chart.getBoundingClientRect().bottom,
          viewportHeight:innerHeight,
          rows:rows.map(row=>{const title=row.querySelector('.gv-rowlabel b'),lane=row.querySelector('.gv-lane'),bar=lane.querySelector('.gv-bar,.gv-act');
            return {id:title.dataset.rqOpen,title:title.textContent,tooltip:title.title,ownerTooltip:row.querySelector('.gv-rowlabel span').title,
              titleOverflow:getComputedStyle(title).textOverflow,labelWidth:row.querySelector('.gv-rowlabel').getBoundingClientRect().width,
              titleWrap:getComputedStyle(title).whiteSpace,rowHeight:row.clientHeight,laneHeight:lane.clientHeight,
              titleHeight:title.clientHeight,barWidth:bar.getBoundingClientRect().width,laneWidth:lane.getBoundingClientRect().width};})};})()`);
      report.activeLayout = { width, height, zoom, theme, ...geometry };
      assert.equal(geometry.documentOverflow, false, 'horizontal scrolling must stay within the Gantt chart');
      assert.equal(geometry.rows.length, 7);
      assert.ok(geometry.rows.every(row => row.tooltip === row.title && row.ownerTooltip && row.titleWrap === 'nowrap' && row.titleOverflow === 'ellipsis'));
      assert.ok(geometry.rows.every(row => row.labelWidth === 240 && Math.abs(row.laneWidth - Math.max(1200, geometry.chartWidth - 240)) <= 2),
        'day columns keep a readable minimum and expand together to fill wider viewports');
      assert.equal(new Set(geometry.rows.map(row=>row.rowHeight)).size, 1, 'long titles must not change row alignment');
      assert.ok(geometry.scrollbarHeight >= 10, 'horizontal scrollbar must have a visible, usable pointer target');
      assert.ok(geometry.scrollbarBottom <= geometry.viewportHeight, 'horizontal scrollbar must remain inside the visible board');
      const last = geometry.rows.find(row => row.id === 'last');
      assert.ok(Math.abs(last.barWidth / last.laneWidth - 1/30) < .001, 'single-day duration must stay one day wide');
      const across = geometry.rows.find(row => row.id === 'across');
      assert.ok(Math.abs(across.barWidth / across.laneWidth - 6/30) < .001, 'cross-month duration must clip at month start');
      const before = await js(`document.querySelector('.gv-rowlabel b').getBoundingClientRect().left`);
      if (geometry.scrollWidth > geometry.chartWidth) {
        // Drag the native scrollbar thumb rather than setting scrollLeft to prove pointer usability.
        const track = await js(`(()=>{const c=document.querySelector('.gv-body'),r=c.getBoundingClientRect();return{x:r.left+2+c.clientWidth*c.clientWidth/c.scrollWidth/2,y:r.bottom-7,end:r.right-18}})()`);
        // Electron input coordinates are device-independent window pixels, not zoomed CSS pixels.
        for (const key of ['x','y','end']) track[key] *= zoom;
        await win.webContents.capturePage();
        win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(track.x),y:Math.round(track.y)});
        win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(track.x),y:Math.round(track.y)});
        await pause(50);
        for(let step=1;step<=10;step++) {
          win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(track.x+(track.end-track.x)*step/10),y:Math.round(track.y)});
          await pause(20);
        }
        win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(track.end),y:Math.round(track.y)});
        // Commit an offscreen compositor frame before reading the main-thread scroll position.
        await win.webContents.capturePage();
        const scrolledBy = Date.now() + 3000;
        while (Date.now() < scrolledBy && !await js(`document.querySelector('.gv-body').scrollLeft>0`)) await pause(50);
        assert.ok(await js(`document.querySelector('.gv-body').scrollLeft>0`), 'the visible scrollbar must scroll the calendar using a mouse');
        assert.ok(await js(`(()=>{const c=document.querySelector('.gv-body'),last=c.querySelector('.gv-headlane .gv-cell:last-child').getBoundingClientRect(),r=c.getBoundingClientRect();return last.right<=r.right&&last.left>=r.left+240})()`), 'dragging to the end must reveal the last day');
      }
      const after = await js(`document.querySelector('.gv-rowlabel b').getBoundingClientRect().left`);
      assert.ok(Math.abs(before-after)<1, 'task names stay visible while scrolling dates');
      const scrollLeft = await js(`document.querySelector('.gv-body').scrollLeft`);
      await js(`RequirementsBoard.render(true);true`);
      assert.equal(await js(`document.querySelector('.gv-body').scrollLeft`), scrollLeft, 'refresh retains the selected date position');
      fs.writeFileSync(path.join(output, 'gantt-' + width + '-' + zoom + '-' + theme + '.png'), (await win.webContents.capturePage()).toPNG());
      report.layouts.push({ width, height, zoom, theme, ...geometry });
    }
    win.webContents.setZoomFactor(1); win.setSize(1366,900);
    await click('.gv-rowlabel [data-rq-open="last"]');
    assert.ok(await js(`!!document.querySelector('.rq-detail')`), 'full title opens the existing requirement detail');
    report.cases.push('fixed columns, ellipsis with full hover labels, visible native scrollbar drag, sticky names, exact date widths, month clipping, recurring and actual-only tasks, native pointer detail entry');
    await js(`document.body.innerHTML=GanttView.html([{label:'团队成员',tasks:[
      {id:'one',title:'One',start:new Date(2026,10,1).getTime(),due:new Date(2026,10,5).getTime()},
      {id:'two',title:'Two',start:new Date(2026,10,3).getTime(),due:new Date(2026,10,7).getTime()},
      {id:'three',title:'Three',start:new Date(2026,10,10).getTime(),due:new Date(2026,10,12).getTime()}
    ]}],{year:2026,month:10});true`);
    const lanes = await js(`[...document.querySelectorAll('.gv-bar')].map(n=>({id:n.dataset.gvtid,top:n.offsetTop,title:n.textContent}))`);
    assert.notEqual(lanes[0].top, lanes[1].top, 'overlapping team tasks still occupy separate lanes');
    assert.equal(lanes[0].top, lanes[2].top, 'non-overlapping team tasks retain compact shared lanes');
    assert.deepEqual(lanes.map(row=>row.title), ['One','Two','Three']);
    report.cases.push('shared team Gantt grouping and overlap packing preserved');
    report.load = [];
    for (const [year, month, days] of [[2026,1,28],[2028,1,29],[2026,10,30],[2026,11,31]]) {
      const sample = await js(`(()=>{
        const started=performance.now(),year=${year},month=${month},days=${days};
        document.body.innerHTML=GanttView.html(Array.from({length:1000},(_,i)=>({label:'Requirement '+i,tasks:[
          {id:'load-'+i,title:'Synthetic '+i,start:new Date(year,month,days).getTime(),due:new Date(year,month,days).getTime()}
        ]})),{year,month});
        const lanes=[...document.querySelectorAll('.gv-lane')],bars=[...document.querySelectorAll('.gv-bar')];
        const bar=bars.at(-1),lane=bar.parentElement;
        return{elapsedMs:performance.now()-started,bars:bars.length,laneCount:lanes.length,
          ratio:bar.getBoundingClientRect().width/lane.getBoundingClientRect().width,
          laneWidth:lane.getBoundingClientRect().width};})()`);
      assert.equal(sample.bars,1000);
      assert.ok(Math.abs(sample.ratio-1/days)<.001);
      assert.ok(sample.laneWidth>=days*40-1);
      report.load.push({year,month,days,...sample});
    }
    report.cases.push('One thousand synthetic requirements retain all bars and exact final-day geometry for 28/29/30/31-day months; local render timings recorded');
    assert.deepEqual(await js('fixtureErrors'), []);
    report.ok = true;
  } catch (error) {
    report.error = error.stack;
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, error: report.error, layouts: report.layouts.length }));
  if (win) win.destroy(); app.exit(report.ok ? 0 : 1);
});
