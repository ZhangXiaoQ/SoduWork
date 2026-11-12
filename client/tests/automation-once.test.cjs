'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const panels = path.join(__dirname, '../components/panels');
const now = Date.parse('2026-10-15T01:00:00Z');
function runtime() {
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = {Date:Clock, Intl, setTimeout, clearTimeout}; context.window = context;
  for (const file of ['schedule-timing.js','work-automation-bindings.js']) {
    const target = path.join(panels,file);
    if (fs.existsSync(target)) vm.runInNewContext(fs.readFileSync(target,'utf8'),context);
  }
  vm.runInNewContext(fs.readFileSync(path.join(panels,'work-automation-sheet.js'),'utf8').replace(
    '  global.WorkAutomationSheet = { open, active, refine, close };',
    '  global.probe = {state,proposalOf,bodyOf,validate};'),context);
  context.probe.state.agents = [{id:'local:pi',name:'Pi',available:true}];
  return {...context.probe, timing:context.ScheduleTiming};
}
test('today at noon is a one-time UTC reservation, not a daily fallback', () => {
  const {proposalOf,bodyOf,validate} = runtime();
  const draft=proposalOf({},'在今天中午12点执行一次，生成报告',{timeZone:'Asia/Shanghai'});
  assert.equal(draft.every,'once');
  assert.equal(draft.runAt,'2026-10-15T04:00:00.000Z');
  assert.equal(validate(draft),'');
  assert.equal(bodyOf(draft).runAt,'2026-10-15T04:00:00.000Z');
});
test('absolute date, relative day and Chinese clock stay faithful to the given date', () => {
  const {proposalOf}=runtime();
  for (const [text,want] of [
    ['2026年10月20日下午两点半运行一次','2026-10-20T06:30:00.000Z'],
    ['2026-10-20 14:30执行报告','2026-10-20T06:30:00.000Z'],
    ['明天晚上8点执行','2026-10-16T12:00:00.000Z'],
    ['后天上午九点运行','2026-10-17T01:00:00.000Z'],
  ]) assert.equal(proposalOf({},text,{timeZone:'Asia/Shanghai'}).runAt,want,text);
});
test('missing date, missing clock, invalid and elapsed dates are blocked rather than guessed', () => {
  const {proposalOf,validate}=runtime();
  for (const text of ['仅执行一次生成报告','明天生成报告','2026年2月30日12点执行','今天早上8点执行']) {
    const draft=proposalOf({},text,{timeZone:'Asia/Shanghai'});
    assert.equal(draft.every,'once');
    assert.ok(validate(draft),text);
  }
});
test('refinement preserves one-time selection unless it explicitly changes the rhythm', () => {
  const {proposalOf,bodyOf}=runtime();
  const prior={every:'once',runAt:'2026-10-20T04:00:00Z',timeZone:'Asia/Shanghai'};
  assert.equal(proposalOf({},'完成标准增加截图',prior).runAt,prior.runAt);
  assert.equal(proposalOf({},'改为下午两点执行',prior).runAt,'2026-10-20T06:00:00.000Z');
  const daily=proposalOf({},'改为每天上午九点',prior);
  assert.equal(daily.every,'daily'); assert.equal(bodyOf(daily).runAt,null);
  assert.equal(proposalOf({},'把标题改为“明天12点执行一次”',prior).runAt,prior.runAt);
});
test('dates in material, negation and hypothetical wording cannot change the reservation', () => {
  const {proposalOf}=runtime();
  const prior={every:'once',runAt:'2026-10-20T04:00:00Z',timeZone:'Asia/Shanghai'};
  for (const text of ['分析2026年10月18日12点的日志','不要今天12点执行','如果明天12点执行会怎样']) {
    assert.equal(proposalOf({},text,prior).runAt,prior.runAt,text);
  }
  assert.equal(proposalOf({},'不要今天12点执行，改为明天12点执行',prior).runAt,'2026-10-16T04:00:00.000Z');
});
test('a leading appointment survives source dates and a negative reminder in its task body', () => {
  const {proposalOf}=runtime();
  for (const text of ['明天12点汇总今天的数据','明天12点分析2026年10月14日的日志',
    '不是每天，是明天12点执行一次','明天12点不要忘记执行一次','明天12点汇总每天的指标']) {
    const result=proposalOf({},text,{timeZone:'Asia/Shanghai'});
    assert.equal(result.every,'once',text);
    assert.equal(result.runAt,'2026-10-16T04:00:00.000Z',text);
  }
});
test('restating once does not rewrite an existing appointment precision', () => {
  const {proposalOf}=runtime();
  const prior={every:'once',runAt:'2026-10-14T04:30:15.123456+00:00',timeZone:'Asia/Shanghai'};
  assert.equal(proposalOf({},'只执行一次，标题改为日报',prior).runAt,prior.runAt);
  assert.equal(proposalOf({},'执行一次生成报告',{timeZone:'Asia/Shanghai'}).every,'once');
});
test('the time zone controls conversion even on a device in a different zone', () => {
  const {timing}=runtime();
  assert.equal(timing.fromLocalInput('2026-10-20T12:30','Asia/Shanghai'),'2026-10-20T04:30:00.000Z');
  assert.equal(timing.localInput('2026-10-20T04:30:00Z','America/New_York'),'2026-10-20T00:30');
  assert.equal(timing.fromLocalInput('2026-10-20T00:30','America/New_York'),'2026-10-20T04:30:00.000Z');
  assert.equal(timing.fromLocalInput('2026-02-30T12:00','Asia/Shanghai'),'');
  assert.equal(timing.fromLocalInput('2026-10-20T12:00','invalid'),'');
});
test('DST missing and repeated local times do not silently move an appointment', () => {
  const {timing}=runtime();
  assert.equal(timing.fromLocalInput('2026-03-08T02:30','America/New_York'),'');
  assert.equal(timing.fromLocalInput('2026-11-01T01:30','America/New_York'),'');
  assert.equal(timing.fromLocalInput('2026-11-01T03:30','America/New_York'),'2026-11-01T08:30:00.000Z');
});
test('editing an unchanged past reservation is allowed but a new past date is rejected', () => {
  const {timing}=runtime();
  const value={every:'once',runAt:'2026-10-14T04:00:00Z'};
  assert.ok(timing.validate(value));
  assert.equal(timing.validate(value,{...value,id:'existing'}),'');
  assert.ok(timing.validate(value,{...value,id:'existing',runAt:'2026-10-13T04:00:00Z'}));
});

test('recurring inference keeps multi-select weekdays, month days, and date bounds', () => {
  const { timing } = runtime();
  const weekly = timing.infer('每周一、三、五上午9点');
  assert.equal(weekly.every, 'weekly');
  assert.deepEqual([...weekly.weekdays], [1, 3, 5]);
  assert.equal(weekly.atHour, 9);
  const monthly = timing.infer('每月30、31号早上9点');
  assert.equal(monthly.every, 'monthly');
  assert.deepEqual([...monthly.monthDays], [30, 31]);
  for (const phrase of ['每月30,31号早上9点', '每月30号，31号早上9点', '每月30,31号汇总报告']) {
    assert.deepEqual([...timing.infer(phrase).monthDays], [30, 31], phrase);
  }
  assert.deepEqual([...timing.infer('每周一、周三、周五上午9点').weekdays], [1, 3, 5]);
  assert.deepEqual([...timing.infer('每周一，周三，周五汇总报告').weekdays], [1, 3, 5]);
  assert.equal(timing.infer('每月5号汇总报告').every, 'monthly');
  const lastDay = timing.infer('每月最后一天早上9点');
  assert.deepEqual([...lastDay.monthDays], [31]);
  assert.equal(lastDay.monthDayPolicy, 'last_day');
  assert.equal(timing.validate({ ...monthly, startDate: '2026-11-01', endDate: '2026-12-31' }), '');
  assert.match(timing.validate({ ...monthly, startDate: '2026-12-31', endDate: '2026-11-01' }), /开始日期/);
  assert.match(timing.validate({ every: 'weekly', weekdays: [], weekday: null, atHour: 9, atMinute: 0 }), /至少一个星期/);
});

test('custom recurrence rules preserve text and use the shared create contract', () => {
  const { proposalOf, bodyOf, validate, timing } = runtime();
  const rule = 'DTSTART;TZID=Asia/Shanghai:20990101T105100\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=8';
  const draft = proposalOf({}, 'Task: Generate a report\n' + rule, {timeZone:'Asia/Shanghai'});
  assert.equal(draft.every, 'custom');
  assert.equal(draft.customRule, rule);
  assert.equal(validate(draft), '');
  const body = bodyOf({...draft, startDate:'2000-01-01', endDate:'2000-01-02'});
  assert.equal(body.customRule, rule);
  assert.equal(body.startDate, null);
  assert.equal(body.endDate, null);
  const refined = proposalOf({}, 'Keep the report concise', draft);
  assert.equal(refined.every, 'custom');
  assert.equal(refined.customRule, rule);
  assert.equal(timing.summary(draft), '自定义规则');
});

test('custom inference retains unsupported calendar properties for validation', () => {
  const { proposalOf, validate } = runtime();
  assert.equal(proposalOf({}, 'BEGIN: task notes\n每天9点生成报告', {}).every, 'daily');
  const rule = 'DTSTART;TZID=Asia/Shanghai:20990101T105100\nRRULE:FREQ=DAILY';
  const folded = proposalOf({}, rule + ';COUNT=1\n 0', {timeZone:'Asia/Shanghai'});
  assert.equal(folded.customRule, rule + ';COUNT=1\n0');
  assert.ok(validate(folded), 'Unsupported folding must not turn COUNT=10 into COUNT=1');
  for (const property of ['EXDATE:20990102T105100', 'exdate:20990102T105100',
    'RDATE:20990102T105100', 'DTEND:20990102T105100', 'X-HOLIDAY:skip', 'UNSUPPORTED:date']) {
    for (const text of [rule + '\n' + property, property + '\n' + rule]) {
      const draft = proposalOf({}, 'Task: Generate a report\n' + text, {timeZone:'Asia/Shanghai'});
      assert.equal(draft.every, 'custom');
      assert.ok(draft.customRule.includes(property), property);
      assert.ok(validate(draft), property);
    }
  }
});

test('custom validation rejects malformed dates, unknown rules and duplicates', () => {
  const { timing } = runtime();
  const rule = 'DTSTART;TZID=Asia/Shanghai:20990101T105100\nRRULE:FREQ=DAILY';
  for (const invalid of ['', rule.replace('20990101', '20990230'), rule.replace('105100', '246100'),
    rule.replace('Asia/Shanghai', 'Invalid/Zone'), rule + ';FREQ=WEEKLY', rule + ';BYHOUR=9',
    rule + ';INTERVAL=0', rule + ';COUNT=1000001', rule + ';BYDAY=MO',
    rule + ';BYMONTHDAY=1', rule + ';UNTIL=20990230T120000', rule + '\nRRULE:FREQ=MONTHLY',
    rule + ';COUNT=5;UNTIL=20991231T000000Z', rule + ';UNTIL=20900101T000000',
    rule.replace('105100', '105101'), rule.replace('105100', '105100+08:00'), rule.replace('105100', '105100Z'),
    rule + '\nEXDATE:20990101T105100', rule + ';' + 'X'.repeat(4096)]) {
    assert.ok(timing.validate({every:'custom',customRule:invalid}), invalid);
  }
  for (const valid of [rule, rule.replace('105100', '1051'), rule.replace(';TZID=Asia/Shanghai', '').replace('105100', '105100Z'),
    rule + ';UNTIL=20991231T120000Z',
    rule.replace('FREQ=DAILY', 'FREQ=MONTHLY;BYMONTHDAY=30,31'),
    rule.replace('FREQ=DAILY', 'FREQ=HOURLY;INTERVAL=100000')]) {
    assert.equal(timing.validate({every:'custom',customRule:valid}), '', valid);
  }
  assert.ok(timing.validateCustomRule('DTSTART:00990101T090000Z\nRRULE:FREQ=DAILY'));
  assert.equal(timing.validateCustomRule('DTSTART:20990101T090000Z\nRRULE:FREQ=DAILY;UNTIL=20990101T100000', 'Asia/Shanghai'), '');
});

test('custom example is future minute precision and preview uses server occurrence', () => {
  const { timing } = runtime();
  assert.equal(timing.customExample('Asia/Shanghai', now),
    'DTSTART;TZID=Asia/Shanghai:20261015T100000\nRRULE:FREQ=DAILY;COUNT=1');
  assert.equal(timing.customPreview({nextRunAt:'2099-01-01T02:51:00Z',timeZone:'Asia/Shanghai'}),
    '下一次：2099-01-01 10:51');
  assert.equal(timing.customPreview({nextRunAt:null}), '自定义规则已无后续执行时间');
  assert.equal(timing.customPreview({}), '保存后由服务端计算下一次执行时间');
});
