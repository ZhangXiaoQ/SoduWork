const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

/*
 * Load real catalogs to verify English automation preflight, next-run, and runtime-option
 * text without untranslated UI fragments.
 */
function boot(locale) {
  const context = vm.createContext({
    console, JSON, Math, Date, RegExp, Object, Array, String, Number, Boolean, Error, TypeError, Intl,
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener() {}, dispatchEvent() {},
    MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    document: { readyState: 'loading', documentElement: { dataset: {} }, querySelectorAll: () => [] },
  });
  context.globalThis = context;
  context.window = context;
  for (const file of JSON.parse(fs.readFileSync(path.join(__dirname, '../core/locales/manifest.json'), 'utf8')))
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../core/locales', file), 'utf8'), context, { filename: file });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../core/i18n.js'), 'utf8'), context, { filename: 'core/i18n.js' });
  context.SoduWorkI18n.setLocale(locale);
  return context;
}

const CJK = /[\u4e00-\u9fff]/;

test('yearly binding validation uses the actual message in every supported locale', () => {
  const source = fs.readFileSync(path.join(__dirname, '../components/panels/work-automation-bindings.js'), 'utf8');
  const message = '当前不支持年度执行，请确认时间安排后再创建。';
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
    const context = boot(locale);
    vm.runInContext(source, context);
    const draft = context.WorkAutomationBindings.resolve({}, '每年整理年度报告', { every: 'daily' }, {});
    assert.equal(draft.bindingIssues[0].message, message);
    const translated = context.WorkAutomationBindings.validate(draft, {});
    assert.equal(translated, context.SoduWorkI18n.translateText(message));
    if (locale === 'zh-CN') assert.equal(translated, message);
    else assert.notEqual(translated, message, locale);
    if (locale === 'en-US' || locale === 'ko-KR') assert.ok(!CJK.test(translated), locale + ': ' + translated);
    assert.equal(context.SoduWorkI18n.translateText('用户自己的年度报告名称'), '用户自己的年度报告名称');
  }
});

test('combined binding errors translate separately while preserving source issues and user names', () => {
  const source = fs.readFileSync(path.join(__dirname, '../components/panels/work-automation-bindings.js'), 'utf8');
  const expected = {
    'en-US': [
      'Linked project "清风Demo" is unavailable or has no unique match. Select it explicitly in the form.',
      'Yearly schedules are not supported. Confirm a supported schedule before creating the automation.',
    ],
    'ja-JP': [
      '関連プロジェクト「清风Demo」は利用できないか、一意に特定できません。フォームで明示的に選択してください。',
      '年単位の実行には対応していません。対応しているスケジュールを確認してから自動化を作成してください。',
    ],
    'ko-KR': [
      '연결된 프로젝트 "清风Demo"을 사용할 수 없거나 일치하는 항목이 하나가 아닙니다. 양식에서 직접 선택하세요.',
      '연간 실행은 지원하지 않습니다. 지원되는 일정을 확인한 후 자동화를 만드세요.',
    ],
  };
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
    const context = boot(locale);
    vm.runInContext(source, context);
    const draft = context.WorkAutomationBindings.resolve({}, '每年整理年度报告，使用清风Demo工程', { every: 'daily' }, {});
    assert.equal(draft.bindingIssues.length, 2);
    const original = JSON.stringify(draft.bindingIssues);
    const error = context.WorkAutomationBindings.validate(draft, {});
    assert.equal(JSON.stringify(draft.bindingIssues), original);
    const messages = draft.bindingIssues.map(issue => issue.message);
    const translated = messages.map(message => context.SoduWorkI18n.translateText(message));
    assert.equal(error, translated.join('\n'));
    assert.ok(error.includes('清风Demo'));
    if (locale !== 'zh-CN') assert.equal(error, expected[locale].join('\n'));
    for (let index = 0; index < messages.length; index++) {
      if (locale === 'zh-CN') assert.equal(translated[index], messages[index]);
      else assert.notEqual(translated[index], messages[index], locale + ': ' + messages[index]);
    }
    context.SoduWorkI18n.setLocale('zh-CN');
    assert.equal(context.WorkAutomationBindings.validate(draft, {}), messages.join('\n'));
  }
});

test('multi-weekday card summaries translate every weekday before assembly', () => {
  const context = boot('en-US');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-schedules.js'), 'utf8'), context);
  const summary = context._schRhythm({every:'weekly',weekdays:[1,3,5],atHour:9,atMinute:30});
  assert.ok(!CJK.test(summary), summary);
  assert.match(summary, /09:30/);
});

test('custom recurrence labels and validation translate across supported locales', () => {
  const source = fs.readFileSync(path.join(__dirname, '../components/panels/schedule-timing.js'), 'utf8');
  const messages = [...source.matchAll(/return '(.*?)'/g)].map(match => match[1])
    .filter(text => /自定义|RRULE|BYDAY|BYMONTHDAY/.test(text));
  messages.push('自定义', '自定义规则', '支持 iCalendar RRULE',
    '可使用 DTSTART 与 RRULE 精确指定开始时间、时区和重复规则',
    '支持 HOURLY、DAILY、WEEKLY、MONTHLY，可设置 INTERVAL、COUNT 或 UNTIL',
    '按天、周、月重复时，夏令时跳过的时刻顺延，重复时刻执行一次', '执行时间需要确认');
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    const tt = boot(locale).SoduWorkI18n.translateText;
    for (const message of messages) {
      assert.notEqual(tt(message), message, locale + ': ' + message);
      if (locale === 'en-US') assert.ok(!CJK.test(tt(message)), message);
    }
  }
});

test('history distinguishes trigger records from execution in every supported locale', () => {
  const messages = [
    '自动化触发后，这里会记录状态；开始执行后可查看对应会话。',
    '触发不代表已开始执行',
    '客户端接收任务后才会创建会话；失败或取消的记录请查看原因。',
    '09:00 · 展示最近 20 次触发与执行记录',
    '执行端不在线，本次未执行。请启动原执行设备上的客户端后重试；不会自动改派其他设备。',
    '执行端未在规定时间内接收，本次未执行。请启动原执行设备上的客户端后重新执行。',
    '执行端已失联，未收到完成回执，本次记为失败。请确认客户端在线后检查原会话，必要时重新执行。',
    '客户端执行被中断；为避免重复操作未自动重发，请在最近聊天中查看原会话。',
    '客户端执行被中断；为避免重复操作未自动重发，请检查客户端状态。',
    '自动化消息未被接收，请在最近聊天中查看原会话并确认执行状态。',
    '本轮执行已暂停，请在最近聊天中查看原会话并处理待确认事项；本次内容不会自动重发。',
    '本轮执行未完成，请在最近聊天中查看原会话了解详细原因。',
    '本轮执行已停止，可在最近聊天中查看原会话。',
    '本轮执行中断，请在最近聊天中查看原会话；本次内容不会自动重发。',
  ];
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
    const tt = boot(locale).SoduWorkI18n.translateText;
    for (const source of messages) {
      const result = tt(source);
      if (locale === 'zh-CN') assert.equal(result, source);
      else assert.notEqual(result, source, locale + ': ' + source);
      assert.ok(!result.includes('{value'));
      if (locale === 'en-US') assert.ok(!CJK.test(result));
    }
  }
});

test('one-time timing labels, validation and localized summary render in English', () => {
  const context = boot('en-US');
  const tt = source => context.SoduWorkI18n.translateText(source);
  for (const source of ['指定日期时间 · 仅一次', '指定日期时间 · 待设置',
    '执行日期时间 · ' + tt('北京时间'), '仅一次', '到点触发一次；失败按设置重试', '本次预约已触发',
    '本次预约已触发；修改为将来时间可重新预约', '不再自动触发', '等待补跑一次',
    '一次性自动化已保存', '时间设置尚未就绪，请重新打开自动化',
    '请选择支持的执行方式', '请选择有效的执行日期和时间；夏令时跳过或重复的时刻请调整后重试',
    '执行时间已过去，请选择将来的日期和时间', '2099-10-15 12:30 · 仅一次'])
    assert.ok(!CJK.test(tt(source)), source + ' -> ' + tt(source));
});

test('automation preflight results render fully in English with no CJK residue', () => {
  const context = boot('en-US');
  const tt = source => context.SoduWorkI18n.translateText(source);
  // Match schedules-service messages, checks, and fallback machine labels.
  const messages = [
    '执行条件已就绪', '执行条件已就绪；个人插件跟随本机当前版本', '执行条件已就绪；个人插件固定 v1.4.2',
    '等待可用 Runner', '暂时无法探测执行机：connect ECONNREFUSED', '读取 Agent 配置失败：missing file',
    '请先选择任务归属的 SoduWork', '请先选择执行 Agent',
  ];
  const checks = ['Runner 已在线', '已在线', '能力授权满足', '等待可用 Runner',
    '个人插件跟随本机当前版本', '个人插件固定 v2.0'];
  for (const source of [...messages, ...checks, '可用执行机', '执行条件待确认', '正在检查执行条件…']) {
    const out = tt(source);
    assert.ok(!CJK.test(out), source + ' -> ' + out);
  }
  // Keep user-provided skill names while translating the waiting-message structure.
  assert.equal(tt('配置有效；等待具备 视觉识别 的 Runner 在线'), 'Configuration valid; waiting for an online Runner with 视觉识别');
  assert.ok(!CJK.test(tt('配置有效；等待具备 所选 Agent 的 Runner 在线').replace('the selected Agent', '')));
  assert.equal(tt('执行条件已就绪'), 'Ready to run');
  assert.equal(tt('执行条件已就绪；个人插件固定 v1.4.2'), 'Ready to run; personal plugin pinned to v1.4.2');
  assert.equal(tt('Runner 已在线'), 'Runner online');
  assert.equal(tt('能力授权满足'), 'Capability authorized');
  // Verify the complete readiness row contains no unintended CJK text.
  const line = tt('执行条件已就绪') + ' · DESKTOP-FIXTURE Runner';
  const small = checks.map(item => tt(item)).join(' · ');
  assert.ok(!CJK.test(line) && !CJK.test(small), line + ' / ' + small);
});

test('next-run preview and timezone labels compose in English at the source', () => {
  const context = boot('en-US');
  const tt = source => context.SoduWorkI18n.translateText(source);
  // Translate date fragments before the DOM layer applies the full next-run template.
  assert.equal(tt('下一次：Today 18:00'), 'Next: Today 18:00');
  assert.equal(tt('下一次：10/12 18:00'), 'Next: 10/12 18:00');
  assert.equal(tt('今天 18:00'), 'Today 18:00');
  assert.equal(tt('明天 09:30'), 'Tomorrow 09:30');
  // Translate timezone labels before composing the execution template.
  assert.equal(tt('北京时间'), 'Beijing time');
  assert.equal(tt('按Beijing time执行 · 触发精度约两分钟'), 'Runs in Beijing time · Trigger precision is about two minutes');
  assert.equal(tt('设备当地时间'), 'Device local time');
});

test('runtime option labels translate seats and readiness, keep agent data as-is', () => {
  const context = boot('en-US');
  const tt = source => context.SoduWorkI18n.translateText(source);
  // Exercise option composition shared by schedule editors and inline automation forms.
  const label = agent => {
    const suffix = [agent.locationLabel,
      agent.onlineSeats ? tt(agent.onlineSeats + ' 个在线席位') : '',
      agent.available === false ? tt('当前未就绪') : ''].filter(Boolean);
    return String(agent.name || agent.id) + (suffix.length ? ' · ' + suffix.join(' · ') : '');
  };
  assert.equal(label({ name: 'Pi', locationLabel: 'Local', onlineSeats: 1 }), 'Pi · Local · 1 online seats');
  assert.equal(label({ name: 'saved-runtime', available: false }), 'saved-runtime · Not ready');
  // Translate fallback names before inserting options.
  assert.ok(!CJK.test(tt('已保存的执行底座') + ' · ' + tt('当前设备没有可选执行底座')));
  // Preserve user and device names as data.
  const withOwner = label({ name: '张树珍', locationLabel: 'Local', onlineSeats: 2 });
  assert.equal(withOwner, '张树珍 · Local · 2 online seats');
});


test('zh-CN output stays byte-identical for every schedule string', () => {
  const context = boot('zh-CN');
  const tt = source => context.SoduWorkI18n.translateText(source);
  for (const source of [
    '执行条件已就绪', '执行条件已就绪；个人插件固定 v1.4.2', '执行条件已就绪；个人插件跟随本机当前版本',
    'Runner 已在线', '能力授权满足', '等待可用 Runner', '配置有效；等待具备 视觉识别 的 Runner 在线',
    '暂时无法探测执行机：boom', '今天 18:00', '下一次：今天 18:00', '按北京时间执行 · 触发精度约两分钟',
    '北京时间', '设备当地时间', '当前未就绪', '1 个在线席位', '已保存的执行底座', '当前设备没有可选执行底座',
    '正在检查执行条件…', '执行条件待确认', '请先选择任务归属的 SoduWork', '请先选择执行 Agent',
  ]) assert.equal(tt(source), source, source);
});

test('device dependency statuses translate without exposing implementation placeholders', () => {
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    const tt = boot(locale).SoduWorkI18n.translateText;
    for (const source of ['个人插件和连接器待本机验证', '执行机已就绪；个人插件和连接器待本机验证',
      '执行条件已检查；运行时会再次验证授权', '平台账号授权已检查：WeCom', '请先连接平台账号：WeCom',
      '连接器未配置、未启用或未授权：docs', '连接器未提供可用工具，请检查权限：docs']) {
      const translated = tt(source);
      assert.notEqual(translated, source, locale + ': ' + source);
      assert.ok(!translated.includes('{value'));
      if (source.endsWith('docs')) assert.ok(translated.endsWith('docs'));
    }
  }
});


test('scroll time selection labels and validation are localized', () => {
  for (const locale of ['en-US','ja-JP','ko-KR']) {
    const context=boot(locale), tt=source=>context.SoduWorkI18n.translateText(source);
    for (const source of ['滚动选择时间','请选择小时（00–23）','请选择分钟（00–59）'])
      assert.notEqual(tt(source),source,locale+': '+source);
  }
});
