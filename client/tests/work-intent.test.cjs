'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const os = require('node:os');
const intent = require('../components/panels/work-intent.js');
const goal = require('../main/conversation/goal-contract.js');
const quality = require('../main/conversation/goal-quality.js');
const spec = require('../main/conversation/session-spec.js');

test('新建入口明确区分普通对话、目标和正式任务', () => {
  assert.equal(intent.normalize({}).mode, 'chat');
  assert.equal(intent.normalize({ mode: 'task' }).mode, 'task');
  assert.deepEqual(intent.normalize({ mode: 'goal', goal: '  做完 竞品分析  ' }), {
    mode: 'goal', goal: '做完 竞品分析', acceptance: '', schedule: null,
  });
  assert.equal(intent.normalize({ mode: 'goal' }).mode, 'chat');
  const controls = intent.controls('cp');
  const surface = intent.surface('cp');
  assert.match(controls, /cpIntentMenu/);
  assert.match(controls, /cpIntentGoal/);
  assert.match(controls, /cpIntentTask/);
  assert.match(surface, /cpIntentAcceptance/);
  assert.match(surface, /完成标准/);
  assert.doesNotMatch(surface, /role="dialog"|IntentPop|IntentSave|IntentGoalText/);
  assert.deepEqual(intent.normalize({ mode: 'task', acceptance: '可运行\n有证据' }, '交付功能'), {
    mode: 'task', goal: '交付功能', acceptance: '可运行\n有证据', schedule: null,
  });
  assert.deepEqual(intent.acceptanceItems('1. 可运行\n- 有证据；可回滚'), ['可运行', '有证据', '可回滚']);
  assert.equal(intent.acceptanceItems('一\n二\n三\n四\n五\n六').length, 6);
});

test('新建入口只把目标作为内置工作模式', () => {
  const controls = intent.controls('cp', { goalOnly: true });
  const surface = intent.surface('cp', { goalOnly: true });
  assert.match(controls, /cpIntentMenu/);
  assert.match(controls, /设定目标/);
  assert.doesNotMatch(controls, /cpIntentTask|cpIntentSchedule|cpIntentChooser/);
  assert.match(surface, /cpIntentAcceptance/);
  assert.doesNotMatch(surface, /cpIntentScheduleRow|cpIntentSchEvery/);
  const compose = fs.readFileSync(
    path.join(__dirname, '../components/panels/panels-compose.js'), 'utf8');
  assert.match(compose, /WorkIntent\.controls\('cp', \{ goalOnly: true \}\)/);
  assert.match(compose, /goalOnly: true/);
});

test('自动化模式：设定形状与「我的定时任务」一致，出格的值被洗干净', () => {
  assert.match(intent.controls('cp'), /cpIntentSchedule/);
  assert.match(intent.controls('cp'), /自动化/);
  const surface = intent.surface('cp');
  assert.match(surface, /cpIntentScheduleRow/);
  assert.match(surface, /cpIntentSchEvery/);
  assert.match(surface, /cpIntentSchTime/);
  const value = intent.normalize({ mode: 'schedule',
    schedule: { every: 'weekly', atHour: 18, atMinute: 30, weekday: 5 } }, '每周汇报');
  assert.equal(value.mode, 'schedule');
  assert.deepEqual(value.schedule, {
    every: 'weekly', atHour: 18, atMinute: 30, weekday: 5,
    weekdays: [], monthDays: [], monthDayPolicy: 'skip', startDate: '', endDate: '',
  });
  /* Normalize invalid frequency values and clamp time and weekday fields before persistence. */
  assert.deepEqual(intent.normalize({ mode: 'schedule',
    schedule: { every: 'never', atHour: 99, atMinute: -3, weekday: 12 } }).schedule,
    { every: 'daily', atHour: 23, atMinute: 0, weekday: 7,
      weekdays: [], monthDays: [], monthDayPolicy: 'skip', startDate: '', endDate: '' });
  /* Exclude schedule settings from unrelated goal and task intent contracts. */
  assert.equal(intent.normalize({ mode: 'goal', goal: 'x',
    schedule: { every: 'daily' } }).schedule, null);
  /* Include personal-plugin method keys only when selected and truncate oversized values while preserving the legacy shape otherwise. */
  assert.match(intent.surface('cp'), /cpIntentSchPlugin/);
  assert.equal(intent.normalize({ mode: 'schedule',
    schedule: { every: 'daily', personalPluginKey: '  daily-report  ' } })
    .schedule.personalPluginKey, 'daily-report');
  assert.equal(intent.normalize({ mode: 'schedule',
    schedule: { every: 'daily', personalPluginKey: 'x'.repeat(200) } })
    .schedule.personalPluginKey.length, 64);
});

test('custom automation intent preserves both recurrence lines and its mode', () => {
  const rule = 'DTSTART;TZID=Asia/Shanghai:20990101T105100\nRRULE:FREQ=DAILY;INTERVAL=3;COUNT=10';
  const value = intent.normalize({mode:'schedule', schedule:{every:'custom',customRule:rule}});
  assert.equal(value.schedule.every, 'custom');
  assert.equal(value.schedule.customRule, rule);
  assert.match(intent.surface('cp'), /value="custom"/);
  assert.match(intent.surface('cp'), /cpIntentSchCustomRule/);
});

test('长要求折叠，目标和完成标准随同一条消息发送', () => {
  assert.equal(intent.longMessage('x'.repeat(320)), false);
  assert.equal(intent.longMessage('x'.repeat(321)), true);
  assert.equal(intent.longMessage('一\n二\n三\n四\n五\n六\n七'), true);

  const folded = intent.userMessage('<需要保留的长要求>' + 'x'.repeat(321), {});
  assert.match(folded, /<details class="nuser-long">/);
  assert.match(folded, /nmessage-copy/);
  assert.match(folded, /data-copy-message=/);
  assert.match(folded, /展开全文/);
  assert.match(folded, /&lt;需要保留的长要求&gt;/);

  const chatCss = fs.readFileSync(path.join(
    __dirname, '../components/panels/panels-chat.css'), 'utf8');
  assert.match(chatCss, /\.nuser-long\[open\] summary>span\{display:none\}/,
    '展开长消息时隐藏摘要，避免摘要与完整正文重复');

  const goalMessage = intent.userMessage('交付可运行的页面', {
    mode: 'goal', goal: '交付可运行的页面', acceptance: '能打开\n无控制台错误',
  });
  assert.match(goalMessage, /目标循环/);
  assert.match(goalMessage, /2 项完成标准/);
  assert.match(goalMessage, /已写入工作记忆/);
  assert.match(goalMessage, /查看完成标准/);
  assert.doesNotMatch(intent.userMessage('普通对话', {}), /目标循环|工作记忆/);
});

test('目标提示条按真实运行状态反馈，不复制一套任务进度', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../components/panels/work-intent.js'), 'utf8');
  assert.match(source, /state\.busy \? 'running'/);
  assert.match(source, /目标暂时受阻/);
  assert.match(source, /目标已暂停/);
  assert.match(source, /进度已保留/);
  assert.match(source, /目标已完成/);
  assert.match(source, /后续可正常对话/);
});

test('目标总进度只使用真实五阶段，阶段内命令不伪装成计划总数', () => {
  const progress = intent.phaseView({ phases: [
    { key: 'understand', state: 'completed' },
    { key: 'plan', state: 'completed' },
    { key: 'execute', state: 'running' },
    { key: 'verify', state: 'pending' },
    { key: 'deliver', state: 'pending' },
  ] });
  assert.equal(progress.total, 5);
  assert.equal(progress.current, 3);
  assert.equal(progress.completed, 2);
  assert.equal(progress.phase.label, '完成工作');
  assert.equal(progress.phase.state, 'running');
  const markup = intent.rail('nchat');
  assert.match(markup, /nchatIntentToggle/);
  assert.match(markup, /nchatIntentPanel/);
  assert.match(markup, /nchatIntentSteps/);
  assert.match(markup, /nchatIntentPause/);
  assert.match(markup, /nchatIntentResume/);
  assert.match(markup, /nchatIntentClear/);
  assert.match(markup, /wi-rail-actions/);
  const chatSource = fs.readFileSync(
    path.join(__dirname, '../components/panels/panels-chat.js'), 'utf8');
  const toolSource = fs.readFileSync(
    path.join(__dirname, '../components/panels/panels-chat-tools.js'), 'utf8');
  assert.match(chatSource, /phases: harness\.phases/);
  assert.match(toolSource, /\\u6b63\\u5728\\u6309\\u8ba1\\u5212\\u63a8\\u8fdb/);
  assert.doesNotMatch(chatSource, /工具步骤.*maxSteps/);
});

test('目标执行把真实检查点整理成简洁阶段播报，而不是只堆命令', () => {
  const previousWindow = global.window;
  const previousWorkIntent = global.WorkIntent;
  const toolPath = require.resolve('../components/panels/panels-chat-tools.js');
  global.window = { WorkIntent: intent };
  global.WorkIntent = intent;
  delete require.cache[toolPath];
  const tools = require(toolPath);
  const html = tools.goalPhaseHtml(true, {
    phase: 'verify', state: 'retrying', reason: '交互检查未通过',
    phases: [
      { key: 'understand', label: '理解工作', state: 'completed' },
      { key: 'plan', label: '形成方案', state: 'completed' },
      { key: 'execute', label: '完成工作', state: 'completed' },
      { key: 'verify', label: '确认结果', state: 'running' },
      { key: 'deliver', label: '整理交付', state: 'pending' },
    ],
    progress: [
      { id: 'p1', type: 'action.started', summary: '正在完成主要页面' },
      { id: 'p2', type: 'verification.started', summary: '开始核对完成标准' },
      { id: 'p3', type: 'verification.failed', summary: '按钮点击没有响应' },
    ],
  }, { phase: 'repairing' }, false);
  global.window = previousWindow;
  global.WorkIntent = previousWorkIntent;
  assert.match(html, /开始实施/);
  assert.match(html, /发现缺口，继续修订/);
  assert.doesNotMatch(html, /开始验收/);
  assert.doesNotMatch(html, /按钮点击没有响应/);
  assert.equal((html.match(/goal-progress:phase:verify/g) || []).length, 1);
  assert.doesNotMatch(html, /soduwork-internal-loop-cycle/);
});

test('目标运行契约自主推进但不越过高风险授权', () => {
  const prompts = goal.prompts({ intent: 'goal', goal: '交付报告', acceptance: '通过复核' });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /自主理解、规划、执行、验证/);
  assert.match(prompts[0], /完整交付门槛/);
  assert.match(prompts[0], /前端、后端\/API、数据与配置/);
  assert.match(prompts[0], /只完成后端.*不得宣称完成/);
  assert.match(prompts[0], /实际检查最终呈现/);
  assert.match(prompts[0], /不可逆\/高风险/);
  assert.match(prompts[0], /缺少必要凭据或授权/);
  assert.doesNotMatch(prompts[0], /自动同意|绕过授权/);
});

test('目标模式二阶段复核会补缺口并给出机器可判定结论', () => {
  const sessionSource = fs.readFileSync(
    path.join(__dirname, '../main/pi-session/session.js'), 'utf8');
  const prompt = quality.reviewPrompt({ goal: '交付完整网站', acceptance: '前后端可运行' });
  assert.match(prompt, /不要相信上一轮“已完成”的自述/);
  assert.match(prompt, /前端、后端\/API、数据与配置/);
  assert.match(prompt, /实际查看最终呈现与交互/);
  assert.match(prompt, /soduwork-delivery-audit:pass/);
  assert.equal(quality.isInternalPrompt(prompt), true);
  assert.equal(quality.outcome({ messages: [{ role: 'assistant', blocks: [
    { kind: 'text', text: '<!-- soduwork-delivery-audit:pass -->\n完成' },
  ] }] }, 0).phase, 'reviewed');
  assert.equal(quality.outcome({ messages: [] }, 0).phase, 'blocked');
  assert.equal(quality.outcome({ messages: [{ role: 'assistant', blocks: [
    { kind: 'text', text: '我看到了 <!-- soduwork-delivery-audit:pass -->，但没有按协议输出' },
  ] }] }, 0).phase, 'blocked');
  assert.equal(quality.outcome({ messages: [
    { role: 'assistant', blocks: [{ kind: 'text', text: '正在复核并补齐缺口' }] },
    { role: 'assistant', blocks: [{ kind: 'text', text:
      '证据核对完成。\n\n<!-- soduwork-delivery-audit:pass -->\n已完成并验证' }] },
  ] }, 0).phase, 'reviewed');
  assert.equal(quality.auditVisible('还在复核，没有结论'), '');
  assert.equal(quality.auditVisible('内部分析\n<!-- soduwork-delivery-audit:pass -->\n正式交付'), '正式交付');
  assert.equal(quality.cleanVisible('<!-- soduwork-delivery-audit:pass -->\n已完成'), '已完成');
  assert.equal(quality.fromEntries([{ type: 'custom', customType: quality.ENTRY_TYPE,
    data: { phase: 'reviewed', reason: '证据齐全', rounds: 1 } }]).phase, 'reviewed');
  assert.match(sessionSource, /goalQuality\.outcome\([\s\S]*\{ messages: ctx\.acc\.state\.messages \}/);
  assert.doesNotMatch(sessionSource, /goalQuality\.outcome\(acc\.snapshot\(\)/);
});

test('会话规格只接受有内容的目标并限制长度', () => {
  const resolved = { capabilityIds: [], skillDirs: [], warnings: [] };
  const built = spec.build({
    intent: 'goal', goal: 'x'.repeat(1400), acceptance: '完成',
  }, resolved, {});
  assert.equal(built.schemaVersion, 4);
  assert.equal(built.intent, 'goal');
  assert.equal(built.goal.length, 1200);
  assert.equal(built.budgetMinutes, 240);
  assert.equal(built.maxSteps, 1000);
  const limited = spec.build({
    intent: 'goal', goal: '交付', budgetMinutes: 999, maxSteps: 1,
  }, resolved, {});
  assert.equal(limited.budgetMinutes, 720);
  assert.equal(limited.maxSteps, 5);
  const complex = spec.build({
    intent: 'goal', goal: '复刻完整网站', budgetMinutes: 360, maxSteps: 300,
  }, resolved, {});
  assert.equal(complex.budgetMinutes, 360);
  assert.equal(complex.maxSteps, 300);
  const runaway = spec.build({
    intent: 'goal', goal: '复杂工程', maxSteps: 99999,
  }, resolved, {});
  assert.equal(runaway.maxSteps, 5000);
  assert.equal(spec.build({ intent: 'goal' }, resolved, {}).intent, '');
});

test('目标随 Pi 会话自定义条目恢复且不进入普通消息', () => {
  const restored = goal.fromEntries([
    { type: 'custom', customType: goal.ENTRY_TYPE,
      data: { intent: 'goal', goal: '旧目标' } },
    { type: 'custom', customType: goal.ENTRY_TYPE,
      data: { intent: 'goal', goal: '最新目标', acceptance: '有证据' } },
  ]);
  assert.equal(restored.goal, '最新目标');
  assert.equal(restored.acceptance, '有证据');
  assert.equal(goal.normalize({ intent: 'goal', goal: '交付', acceptance: '可运行\n有证据' }).acceptance,
    '可运行\n有证据');
});

test('Pi 首轮落盘后能从真实会话文件恢复目标', async (t) => {
  /* Explicitly skip integration when the real package is absent in a dependency-free checkout. */
  let SessionManager;
  try {
    ({ SessionManager } = await import('@earendil-works/pi-coding-agent'));
  } catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
      t.skip('未安装 @earendil-works/pi-coding-agent（干净检出）');
      return;
    }
    throw error;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-goal-test-'));
  const dir = path.join(root, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const manager = SessionManager.create(root, dir);
    manager.appendCustomEntry(goal.ENTRY_TYPE, {
      intent: 'goal', goal: '持续交付验证', acceptance: '有结果和证据',
    });
    /* Pi flushes prior entries when the first assistant message appears. */
    manager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'checkpoint' }],
      api: 'test', provider: 'test', model: 'test',
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop', timestamp: Date.now(),
    });
    const reopened = SessionManager.open(manager.getSessionFile());
    const restored = goal.fromEntries(reopened.getEntries());
    assert.equal(restored.goal, '持续交付验证');
    assert.equal(restored.acceptance, '有结果和证据');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('任务模式复用正式任务草稿，目标通过隐藏会话契约下发', () => {
  const compose = fs.readFileSync(
    path.join(__dirname, '../components/panels/panels-compose.js'), 'utf8');
  const session = fs.readFileSync(
    path.join(__dirname, '../main/pi-session/session.js'), 'utf8');
  const draft = fs.readFileSync(
    path.join(__dirname, '../components/panels/panels-compose-draft.js'), 'utf8');
  assert.match(compose, /intent\.mode === 'task'/);
  assert.match(compose, /workIntent: intent/);
  assert.match(draft, /WorkIntent\.acceptanceItems\(workIntent\.acceptance\)/);
  assert.match(compose, /intent: 'goal'/);
  assert.match(compose, /if \(_intent\) _intent\.reset\(\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '../components/panels/panels-chat.js'), 'utf8'),
    /WorkIntent\.userMessage/);
  assert.match(session, /goalHarness\.prompt\(goal\)/);
  assert.match(session, /appendCustomEntry\(goalContract\.ENTRY_TYPE/);
});

test('新建入口把目标模式放入加号菜单，模型与底座位于发送侧', () => {
  const compose = fs.readFileSync(
    path.join(__dirname, '../components/panels/panels-compose.js'), 'utf8');
  const composerCss = fs.readFileSync(
    path.join(__dirname, '../components/panels/work-composer.css'), 'utf8');
  assert.match(compose, /morePop\.appendChild\(intent\)/);
  assert.match(compose, /querySelector\('\.wc-tools'\)\.appendChild\(more\)/);
  assert.match(compose, /actions\.insertBefore\(model, voice \|\| actions\.firstChild\)/);
  assert.doesNotMatch(compose, /morePop\.appendChild\(model\)/);
  assert.match(compose, /toolbarContext\.insertBefore\(permission, workspace\)/);
  assert.match(compose, /morePop\.appendChild\(ability\)/);
  assert.match(compose, /toolbarContext\.appendChild\(permissionPop\)/);
  assert.match(compose, /morePop\.appendChild\(abilityPop\)/);
  assert.match(compose, /id="cpMorePop"[^>]*hidden/);
  assert.match(compose, /pop\.hidden = !show/);
  assert.match(compose, /actions: '<button type="button" class="wc-voice" id="cpMic"/);
  assert.match(compose, /button: null, tray:/);
  assert.match(compose, /默认工作区/);
  assert.match(composerCss, /\.compose-panel \.wc-toolbar\{flex-wrap:nowrap/);
  assert.match(composerCss, /\.cp-more-pop\{display:none/);
  assert.match(composerCss, /\.cp-more-pop \.cp-modelpop,\.cp-more-pop>\.wc-popover/);
  assert.match(composerCss, /\.compose-panel \.wc-actions \.wc-voice\{margin-right:8px\}/);
  assert.match(composerCss, /\.wc-voice\{display:none!important\}/);
  assert.match(compose, /本次会话模型：/);
  assert.match(compose, /本次会话权限：/);
  assert.match(compose, /本次会话能力：/);
});

test('统一输入区使用向上箭头发送', () => {
  const composer = fs.readFileSync(
    path.join(__dirname, '../components/panels/work-composer.js'), 'utf8');
  const chat = fs.readFileSync(
    path.join(__dirname, '../components/panels/panels-chat.js'), 'utf8');
  assert.match(composer, /M12 19V6M6\.5 11\.5 12 6l5\.5 5\.5/);
  assert.match(chat, /M12 19V6M6\.5 11\.5 12 6l5\.5 5\.5/);
  assert.doesNotMatch(composer, /M5 12h13M13 6l6 6-6 6/);
});

test('主框架侧栏与白色工作区保持轻微层级差', () => {
  const shellCss = fs.readFileSync(
    path.join(__dirname, '../components/workspace/workspace-shell.css'), 'utf8');
  assert.match(shellCss, /--ws-side:color-mix\(in srgb,var\(--bg-1\) 88%,var\(--bg-2\)\)/);
  assert.match(shellCss, /\.ws-recent\{[^}]*background:var\(--ws-side\)/s);
});

test('主菜单按产品入口扁平排序，AI 团队收进更多', () => {
  const shell = fs.readFileSync(
    path.join(__dirname, '../components/workspace/workspace-shell.js'), 'utf8');
  const shellCss = fs.readFileSync(
    path.join(__dirname, '../components/workspace/workspace-shell.css'), 'utf8');
  const primaryMatch = shell.match(/const RAIL_ITEMS = \[([\s\S]*?)\];/);
  assert.ok(primaryMatch, 'primary rail must be declared');
  const primary = primaryMatch[1];
  let previous = -1;
  for (const key of ['create', 'history', 'skills', 'schedules', 'library']) {
    const index = primary.indexOf("['" + key + "'");
    assert.ok(index > previous, key + ' should follow the requested order');
    previous = index;
  }
  assert.match(shell, /const RAIL_MORE_ITEMS = \[[\s\S]*?\['aidesk', 'AI 团队', 'aidesk'\]/);
  assert.doesNotMatch(shell, /const RAIL_COLLAB_ITEMS = \[/);
  assert.doesNotMatch(shell, /ws-rail-separator/);
  assert.match(shell, /const CONVERSATION_KEYS = new Set\(\['create', 'pichat'\]\)/);
  assert.match(shellCss, /font-weight:420/);
  assert.match(shellCss, /var\(--ink-3\) 94%/);
});

test('资料库与插件共用工作区边界，打开后保留可点击的左侧导航', () => {
  const shellCss = fs.readFileSync(
    path.join(__dirname, '../components/workspace/workspace-shell.css'), 'utf8');
  const boot = fs.readFileSync(path.join(__dirname, '../desk-boot.js'), 'utf8');
  const hostedRule = [...shellCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, selector, body]) =>
    selector.includes('html[data-desk-panel="workspace"] :is(') &&
    selector.includes('#capPanel') && selector.includes('#libraryPanel') &&
    body.includes('position:fixed!important'));
  assert.ok(hostedRule, '资料库必须像插件页一样由工作区托管，不能用全窗浮层覆盖导航');
  assert.match(hostedRule[2], /left:var\(--ws-main-left,[^)]+\)!important/,
    '资料库左边界必须跟随工作区导航宽度');
  assert.match(shellCss, /\[data-workspace-layout="utility"\]\{--ws-main-left:var\(--ws-rail-w,52px\)!important\}/,
    '功能页面仍需为快捷导航留出空间');
  assert.match(shellCss, /#libraryPanel\{overflow:auto!important\}/,
    '资料多于一屏时页面内容可滚动，不能借用覆盖侧栏的全屏滚动层');
  assert.match(boot, /skills: 'capPanel', library: 'libraryPanel'/);
});

test('历史对话和最近任务使用易读字号与清晰滚动条', () => {
  const shellCss = fs.readFileSync(
    path.join(__dirname, '../components/workspace/workspace-shell.css'), 'utf8');
  assert.match(shellCss, /\.ws-task\{[^}]*font-size:max\(var\(--font-min-readable,\s*14\.5px\),\s*13px\)/);
  assert.match(shellCss, /:is\(\.ws-side-scroll,#wsRecent\)::\-webkit-scrollbar\{width:6px;height:6px\}/);
  assert.match(shellCss, /:is\(\.ws-side-scroll,#wsRecent\)::\-webkit-scrollbar-button\{display:none;width:0;height:0\}/);
  assert.match(shellCss, /:is\(\.ws-side-scroll,#wsRecent\)::\-webkit-scrollbar-thumb\{[^}]*border-radius:99px/);
  assert.doesNotMatch(shellCss, /\.ws-list-body\{[^}]*scrollbar-width/);
  assert.match(shellCss, /overscroll-behavior:contain/);
});

test('最近会话与最近任务在窄窗口中保持固定行高', () => {
  const shell = fs.readFileSync(
    path.join(__dirname, '../components/workspace/workspace-shell.js'), 'utf8');
  const shellCss = fs.readFileSync(
    path.join(__dirname, '../components/workspace/workspace-shell.css'), 'utf8');
  assert.match(shell, />最近聊天<\/span>/);
  assert.match(shell, /id="wsRecentToggle"[^>]*aria-expanded="false"[^>]*aria-controls="wsRecent"/);
  assert.doesNotMatch(shell, />最近会话<\/div>/);
  assert.match(shellCss, /\.ws-section-label\{[^}]*font-weight:400/);
  assert.match(shellCss, /\.ws-task\{[^}]*height:32px;min-height:32px;max-height:32px;flex:0 0 32px/);
});

test('最近任务默认向下收起并保留可展开分组栏', () => {
  const shell = fs.readFileSync(
    path.join(__dirname, '../components/workspace/workspace-shell.js'), 'utf8');
  const shellCss = fs.readFileSync(
    path.join(__dirname, '../components/workspace/workspace-shell.css'), 'utf8');
  assert.match(shell, /class="ws-list ws-recent is-collapsed"/);
  assert.match(shell, /setRecentCollapsed\(true\)/);
  assert.match(shell, /recentToggle\.addEventListener\('click'/);
  assert.match(shell, /setAttribute\('aria-expanded'/);
  assert.match(shellCss, /\.ws-recent\.is-collapsed \.ws-list-body\{display:none\}/);
  assert.match(shellCss, /\.ws-recent:not\(\.is-collapsed\) \.ws-section-toggle svg\{transform:rotate\(180deg\)\}/);
  assert.match(shellCss, /\.ws-section-toggle:focus-visible/);
});

test('聊天支持按 Hub 隔离的置顶与取消置顶', () => {
  const shell = fs.readFileSync(
    path.join(__dirname, '../components/workspace/workspace-shell.js'), 'utf8');
  const shellCss = fs.readFileSync(
    path.join(__dirname, '../components/workspace/workspace-shell.css'), 'utf8');
  assert.match(shell, /id="wsPinnedBox" hidden/);
  assert.match(shell, /function togglePinned\(id\)/);
  assert.match(shell, /SoduWorkAPI\.hubBase\(\)/);
  assert.match(shell, /soduwork_work_chat_pins_v1:/);
  assert.match(shell, /取消置顶/);
  assert.match(shellCss, /\.ws-chat-pin/);
  assert.match(shellCss, /font-size:14\.5px/);
  assert.ok(shellCss.includes('color:color-mix(in srgb,var(--ink-3) 94%,var(--ink-4))'));
});

test('新建使用轻量方框斜笔图标', () => {
  const shell = fs.readFileSync(
    path.join(__dirname, '../components/workspace/workspace-shell.js'), 'utf8');
  assert.match(shell, /create: lineGlyph\('<path d="M13 4\.5H6\.5/);
  assert.match(shell, /m9\.5 14\.5\.75-3\.25L18 3\.5/);
  assert.match(shell, /const lineGlyph =[^\n]*fill="none" stroke="currentColor" stroke-width="1\.75"/);
  assert.doesNotMatch(shell, /create: '<path d="M6 3h8l4 4/);
});

test('会话底栏以圆环展示上下文并暂时隐藏语音入口', () => {
  const composer = fs.readFileSync(path.join(__dirname, '../components/panels/work-composer.js'), 'utf8');
  const chat = fs.readFileSync(path.join(__dirname, '../components/panels/panels-chat.js'), 'utf8');
  const chatCss = fs.readFileSync(path.join(__dirname, '../components/panels/panels-chat.css'), 'utf8');
  assert.ok(composer.indexOf('id="nchatModel"') < composer.indexOf('id="nchatMic"'));
  assert.match(chat, /function _ctxHtml()/);
  assert.match(chat, /class="nctx-ring/);
  assert.match(chat, /_ctxHtml/);
  assert.match(chat, /_toggleChatMic/);
  assert.match(chat, /class="nctx-track"/);
  assert.match(chatCss, /\.nctx-value/);
  assert.match(chatCss, /.nctx-pop/);
});

test('会话底栏把上下文放在模型左侧并保留粘贴附件', () => {
  const composer = fs.readFileSync(path.join(__dirname, '../components/panels/work-composer.js'), 'utf8');
  const chat = fs.readFileSync(path.join(__dirname, '../components/panels/panels-chat.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../components/panels/panels-chat.css'), 'utf8');
  assert.match(composer, /actions: \(meta \? meta\.outerHTML : ''\)/);
  assert.doesNotMatch(composer, /afterInput: \(meta/);
  assert.doesNotMatch(composer, /id="nchatAtt"/);
  assert.match(composer, /id="nchatFile" multiple hidden/);
  assert.match(chat, /button: null, tray:/);
  assert.doesNotMatch(chat, /_sessionInputs\.length \+ ' 个附件'/);
  assert.match(css, /\.nmeta\{[^}]*position:relative/);
  assert.match(css, /\.nbox \.wc-voice\{margin-right:8px\}/);
  assert.match(fs.readFileSync(path.join(__dirname, '../components/panels/work-composer.css'), 'utf8'), /\.wc-voice\{display:none!important\}/);
});

test('插件页保留紧凑技能卡片和统一连接管理入口', () => {
  const capabilities = fs.readFileSync(
    path.join(__dirname, '../components/panels/panels-capabilities.js'), 'utf8');
  const css = fs.readFileSync(
    path.join(__dirname, '../components/panels/panels-capabilities.css'), 'utf8');
  const editors = fs.readFileSync(path.join(__dirname, '../components/panels/panels-capability-editors.js'), 'utf8');
  assert.match(editors, /cap-card cap-skill-card/);
  const connectors = fs.readFileSync(path.join(__dirname, '../components/panels/connector-directory.js'), 'utf8');
  assert.match(capabilities, /SoduWorkConnectorDirectory.render/);
  assert.match(connectors, /data-my-connections/);
  assert.match(connectors, /openLibrary/);
  assert.match(css, /\.cap-card\{--cap-kind:var\(--accent\)/);
  assert.match(css, /min-height:76px/);
  assert.doesNotMatch(css, /min-height:94px/);
  assert.match(css, /\.cap-card::before/);
  assert.match(css, /\.cap-mcp-list\{display:grid;grid-template-columns:repeat\(2/);
  assert.match(css, /\.cap-template-row\{display:grid;grid-template-columns:repeat\(2/);
  assert.doesNotMatch(css, /linear-gradient\(145deg/);
});


test('web batch annotation control has a named stateful action and shared toolbar styling', () => {
  const info = require('../components/panels/chat-workspace-info');
  const css = fs.readFileSync(path.join(__dirname, '../components/panels/chat-workbench-toolbar.css'), 'utf8');
  const workspace = fs.readFileSync(path.join(__dirname, '../components/panels/panels-chat-workspace.js'), 'utf8');
  const toolbar = (tab, state) => info.browserToolbar({ tab, state, location: tab.url || '', address: tab.url || '', libraryButton: '' })
    .match(/<button[^>]*data-wb-inspect[^>]*>[\s\S]*?<\/button>/)[0];
  const enabled = toolbar({kind:'browser',url:'https://example.test/'},{inspectEnabled:true});
  assert.match(enabled, /class="ncw-annotate-action"/);
  assert.match(enabled, /aria-label="标注网页元素"/);
  assert.match(enabled, /aria-pressed="true"/);
  assert.doesNotMatch(enabled, / disabled/);
  assert.ok(enabled.includes(info.ICONS.annotation));
  assert.match(info.ICONS.annotation, /<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.match(info.ICONS.annotation, /<path/);
  const blank = toolbar({kind:'browser',url:''},{});
  assert.match(blank, / disabled/);
  assert.match(blank, /aria-pressed="false"/);
  assert.match(workspace, /info\.browserToolbar\(/);
  assert.match(css, /\.ncw-browserbar>\.ncw-annotate-action[^}]*border-radius:999px/);
  assert.match(css, /\.ncw-browserbar button:hover:not\(:disabled\)[^{]*\{[^}]*background:var\(--bg-2\)/);
});
