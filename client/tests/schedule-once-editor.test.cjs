'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const folder = path.join(__dirname, '../components/panels');
const future = '2099-10-15T04:30:15.123456+00:00';
const display = '2099-10-15T12:30:15.123';
const copy = value => JSON.parse(JSON.stringify(value));

function fixture(existing = null, every = 'once') {
  const controls = {}, saves = [], notices = [], probes = [], timingCalls = [];
  const element = (value = '') => ({ value, checked: false, style: {}, attrs: {},
    listeners: {}, classList: { add() {}, remove() {}, toggle() {} }, isConnected: true,
    addEventListener(name, callback) { this.listeners[name] = callback; },
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    getAttribute(name) { return name === 'data-mode' ? 'direct' : this.attrs[name]; },
    focus() { this.focused = true; },
  });
  for (const id of ['schEvery', 'schRepo', 'schWd', 'schHWrap', 'schDirectBlock',
    'schPluginBlock', 'schFlowWrap', 'schPv', 'schBpWhen', 'schBpWork', 'schRetryOptions',
    'schRetry', 'schTitle', 'schNote', 'schWho', 'schRetryLimit', 'schRetryDelay',
    'schCancel', 'schSave', 'schH', 'schM', 'schEnabled', 'schRunAt', 'schOnceWrap',
    'schPluginConfig', 'schMethodWrap', 'schMethod', 'schOnceHint', 'schFlow']) controls[id] = element();
  controls.schCustomRule = element(existing?.customRule || '');
  controls.schCustomRuleWrap = element();
  controls.schDateRange = element();
  Object.assign(controls.schEvery, { value: every });
  Object.assign(controls.schTitle, { value: '一次性工作' });
  Object.assign(controls.schNote, { value: '完整工作说明' });
  Object.assign(controls.schWho, { value: 'local:pi' });
  Object.assign(controls.schRunAt, { value: display });
  Object.assign(controls.schH, { value: '18' });
  Object.assign(controls.schM, { value: '15' });
  Object.assign(controls.schWd, { value: '2' });
  Object.assign(controls.schEnabled, { checked: true });
  const mode = element();
  const c = { console, Intl, Date, Event, setTimeout, clearTimeout,
    esc: value => String(value ?? '').replaceAll('"', '&quot;'),
    addEventListener() {}, petSay: value => notices.push(value),
    document: {
      getElementById: id => controls[id] || null,
      querySelector: selector => selector === '.sch-mode-btn.on' ? mode : null,
      querySelectorAll: selector => selector === '.sch-mode-btn' ? [mode] : [],
    },
    SoduWorkAPI: {
      createSchedule: async body => saves.push({ body: copy(body) }),
      updateSchedule: async (id, body) => saves.push({ id, body: copy(body) }),
    },
  };
  c.window = c;
  vm.createContext(c);
  for (const file of ['schedule-timing.js', 'panels-schedules-methods.js', 'panels-schedules-cards.js',
    'panels-schedules.js', 'panels-schedules-editor.js'])
    vm.runInContext(fs.readFileSync(path.join(folder, file), 'utf8'), c, { filename: file });
  c.initial = existing || 'new';
  vm.runInContext('_schEditing = initial', c);
  c._schBrowserTimeZone = () => 'Asia/Shanghai';
  if (existing?.every === 'once') controls.schRunAt.value = c.ScheduleTiming.localInput(
    existing.runAt, existing.timeZone || 'Asia/Shanghai');
  const timing = { ...c.ScheduleTiming };
  c.ScheduleTiming.localInput = (value, zone) => { timingCalls.push(['local', value, zone]); return timing.localInput(value, zone); };
  c.ScheduleTiming.fromLocalInput = (value, zone) => { timingCalls.push(['parse', value, zone]); return timing.fromLocalInput(value, zone); };
  c._schmSnapshotState = () => ({ versionPolicy: 'latest', personalVersion: '', personalChecksum: '', preserveSnapshot: false });
  c._schmSnapshotLocked = () => false;
  c._schmFind = () => null;
  c._schCloseEditor = () => {};
  c._loadSch = async () => {};
  return { c, controls, saves, notices, probes, timingCalls,
    wire() { c._wireSchForm(); },
    save() { return controls.schSave.listeners.click(); },
    change() { return controls.schEvery.listeners.change(); },
  };
}

test('management editor offers one-time mode and a date-time input in the schedule timezone', () => {
  const f = fixture();
  const html = f.c._schFormHtml({ every: 'once', runAt: future, timeZone: 'Asia/Shanghai',
    title: '', note: '', atHour: 9, atMinute: 0, weekday: 1 });
  assert.match(html, /value="once" selected/);
  assert.match(html, /id="schRunAt"[^>]*type="datetime-local"|type="datetime-local"[^>]*id="schRunAt"/);
  assert.ok(html.includes('value="' + display + '"'));
  assert.ok(f.timingCalls.some(item => item[0] === 'local' && item[2] === 'Asia/Shanghai'));
});

test('management custom rule editor preserves and saves the full recurrence rule', async () => {
  const rule = 'DTSTART;TZID=Asia/Shanghai:20990101T105100\nRRULE:FREQ=MONTHLY;BYMONTHDAY=30,31;COUNT=10';
  const f = fixture({id:'custom', every:'custom', customRule:rule}, 'custom');
  const html = f.c._schFormHtml({every:'custom',customRule:rule,timeZone:'Asia/Shanghai'});
  assert.match(html, /value="custom" selected/);
  assert.match(html, /id="schCustomRule"/);
  assert.ok(html.includes(rule));
  f.wire();
  assert.equal(f.controls.schCustomRuleWrap.hidden, false);
  assert.equal(f.controls.schHWrap.style.display, 'none');
  assert.equal(f.controls.schDateRange.hidden, true);
  await f.save();
  assert.equal(f.saves[0].body.customRule, rule);
  assert.equal(f.saves[0].body.every, 'custom');
  assert.equal(f.saves[0].body.startDate, null);
  f.controls.schCustomRule.value = '';
  await f.save();
  assert.equal(f.saves.length, 1, 'Clearing a saved rule must not restore the old rule');
  assert.equal(f.controls.schCustomRule.focused, true);
});

test('management editor renders calendar-aware timing controls in the live schedule drawer', () => {
  const f = fixture();
  const html = f.c._schFormHtml({ every: 'monthly', monthDays: [30, 31], monthDayPolicy: 'last_day',
    startDate: '2099-01-01', endDate: '2099-12-31', atHour: 18, atMinute: 0 });
  assert.match(html, /id="schDateRange"/);
  assert.match(html, /id="schWeekdays"/);
  assert.match(html, /id="schMonthDays"/);
  assert.equal((html.match(/class="sch-choice"/g) || []).length, 38);
  assert.match(html, /id="schMonthLastDay" checked/);
  assert.match(html, /id="schRunAt" type="datetime-local" step="60"/);
});

test('management editor saves multi-day timing and optional date bounds', async () => {
  const f = fixture(null, 'monthly');
  const control = (value = '', checked = false) => ({ value, checked, style: {}, attrs: {}, listeners: {},
    classList: { add() {}, remove() {}, toggle() {} }, isConnected: true,
    addEventListener(name, callback) { this.listeners[name] = callback; },
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    focus() {},
  });
  f.controls.schStartDate = control('2099-01-01');
  f.controls.schEndDate = control('2099-12-31');
  f.controls.schDateRange = control();
  f.controls.schWeekdays = control();
  f.controls.schMonthDays = control();
  f.controls.schMonthLastDay = control('', true);
  const weekdays = [1, 3, 5].map(value => control(String(value), true));
  const monthDays = [30, 31].map(value => control(String(value), true));
  const originalQuery = f.c.document.querySelectorAll;
  f.c.document.querySelectorAll = selector => {
    if (selector === '#schWeekdays input[type="checkbox"]') return weekdays;
    if (selector === '#schMonthDays input[type="checkbox"]') return monthDays;
    if (selector === '#schWeekdays input, #schMonthDays input, #schMonthLastDay') {
      return [...weekdays, ...monthDays, f.controls.schMonthLastDay];
    }
    return originalQuery(selector);
  };
  f.wire();
  await f.save();
  assert.equal(f.saves.length, 1);
  assert.deepEqual(f.saves[0].body.weekdays, []);
  assert.deepEqual(f.saves[0].body.monthDays, [30, 31]);
  assert.equal(f.saves[0].body.monthDayPolicy, 'last_day');
  assert.equal(f.saves[0].body.startDate, '2099-01-01');
  assert.equal(f.saves[0].body.endDate, '2099-12-31');
});

test('automation editor keeps the personal plugin chooser visible and persists the selection', async () => {
  const f = fixture();
  const checksum = 'a'.repeat(64);
  f.c._schmFind = key => key === 'daily-report'
    ? { key, version: '1.0.0', checksum, capabilities: { runtime: [] }, inputs: [] }
    : null;
  f.c._schmSnapshotState = () => ({
    versionPolicy: 'pinned', personalVersion: '1.0.0', personalChecksum: checksum,
    preserveSnapshot: false,
  });
  const html = f.c._schFormHtml({ personalPluginKey: 'daily-report', every: 'once',
    runAt: future, timeZone: 'Asia/Shanghai', title: '日报', note: '整理日报' });
  assert.doesNotMatch(html, /id="schMethodWrap" hidden/);
  f.controls.schMethod.value = 'daily-report';
  f.wire();
  await f.save();
  assert.equal(f.saves[0].body.personalPluginKey, 'daily-report');
  assert.equal(f.saves[0].body.personalPluginVersionPolicy, 'pinned');
  assert.equal(f.saves[0].body.personalPluginVersion, '1.0.0');
  assert.equal(f.saves[0].body.personalPluginChecksum, checksum);
});

test('one-time save converts the chosen schedule-zone wall time and excludes readonly consumption', async () => {
  const f = fixture(); f.wire(); await f.save();
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0].body.every, 'once');
  assert.equal(f.saves[0].body.runAt, '2099-10-15T04:30:15.123Z');
  assert.equal(f.saves[0].body.onceFired, undefined);
  assert.equal(f.saves[0].body.scheduleId, undefined);
});

test('editing an unchanged instant preserves the original microseconds and adds preflight identity', async () => {
  const f = fixture({ id: 'plan', every: 'once', runAt: future, timeZone: 'Asia/Shanghai' });
  f.controls.schRunAt.value = display.replace('.123', '.123');
  f.wire(); await f.save();
  assert.equal(f.saves[0].id, 'plan');
  assert.equal(f.saves[0].body.runAt, future);
  assert.equal(f.saves[0].body.scheduleId, 'plan');
  assert.equal(f.saves[0].body.timeZone, 'Asia/Shanghai');
  assert.equal(f.timingCalls.filter(item => item[0] === 'parse').length, 0);
});

for (const value of ['', '2020-01-01T08:00']) {
  test('new one-time appointment rejects ' + (value ? 'a past date' : 'a missing date') + ' before sending', async () => {
    const f = fixture(); f.controls.schRunAt.value = value;
    f.wire(); await f.save();
    assert.equal(f.saves.length, 0);
    assert.ok(f.notices.some(text => /日期|时间/.test(text)));
    assert.equal(f.controls.schRunAt.focused, true);
  });
}

test('consumed appointment is displayed without turning a manual-run timestamp into consumption', () => {
  const f = fixture();
  const base = { id: 'once', title: 'Work', every: 'once', runAt: future,
    enabled: true, assigneeId: 'local:pi', timeZone: 'Asia/Shanghai', lastRunAt: '2020-01-01T00:00:00Z' };
  const pending = f.c._schCardHtml({ ...base, onceFired: false, nextRunAt: future });
  assert.match(pending, /下次/);
  assert.doesNotMatch(pending, /本次预约已触发/);
  const fired = f.c._schCardHtml({ ...base, onceFired: true, nextRunAt: null });
  assert.match(fired, /本次预约已触发/);
  assert.doesNotMatch(fired, /每天|下次 <\/span>/);
  assert.match(fired, /data-act="run"/);
});

test('mode changes hide irrelevant clock controls and periodic save clears any old absolute time', async () => {
  const f = fixture({ id: 'plan', every: 'once', runAt: future, onceFired: true });
  f.wire();
  assert.equal(f.controls.schHWrap.style.display, 'none');
  assert.notEqual(f.controls.schOnceWrap.style.display, 'none');
  f.controls.schEvery.value = 'weekly'; f.change(); await f.save();
  assert.equal(f.controls.schOnceWrap.style.display, 'none');
  assert.equal(f.controls.schHWrap.style.display, '');
  const body = f.saves[0].body;
  assert.equal(body.every, 'weekly');
  assert.equal(body.atHour, 18); assert.equal(body.atMinute, 15); assert.equal(body.weekday, 2);
  assert.ok(!body.runAt);
});

test('unchanged overdue existing appointment remains editable for catch-up once', async () => {
  const past = '2020-01-01T00:00:00.123456+00:00';
  const f = fixture({ id: 'overdue', every: 'once', runAt: past, onceFired: false });
  f.wire(); await f.save();
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0].body.runAt, past);
});

test('browser-normalized fractional seconds still preserve original microseconds', async () => {
  const precise = future.replace('.123456', '.120456');
  const f = fixture({ id: 'precise', every: 'once', runAt: precise, timeZone: 'Asia/Shanghai' });
  f.controls.schRunAt.value = f.controls.schRunAt.value.replace('.120', '.12');
  f.wire(); await f.save();
  assert.equal(f.saves[0].body.runAt, precise);
});

test('an invalid wall date cannot normalize into the old instant and masquerade as unchanged', async () => {
  const f = fixture({ id: 'march', every: 'once', runAt: '2099-03-03T04:30:00Z', timeZone: 'Asia/Shanghai' });
  f.controls.schRunAt.value = '2099-02-31T12:30';
  f.wire(); await f.save();
  assert.equal(f.saves.length, 0);
});

test('editing on another device keeps the schedule zone and converts a changed date in that zone', async () => {
  const f = fixture({ id: 'overseas', every: 'once', runAt: future, timeZone: 'America/New_York', onceFired: true });
  f.controls.schRunAt.value = '2099-10-16T12:30';
  f.wire(); await f.save();
  assert.equal(f.saves[0].body.runAt, '2099-10-16T16:30:00.000Z');
  assert.equal(f.saves[0].body.timeZone, 'America/New_York');
  assert.equal(f.saves[0].body.onceFired, undefined);
});

for (const wall of ['2027-03-14T02:30', '2027-11-07T01:30', '2099-02-31T12:00']) {
  test('unrepresentable or ambiguous wall time is blocked before API: ' + wall, async () => {
    const f = fixture({ id: 'dst', every: 'daily', timeZone: 'America/New_York' });
    f.controls.schRunAt.value = wall;
    f.wire(); await f.save();
    assert.equal(f.saves.length, 0);
    assert.equal(f.controls.schRunAt.focused, true);
  });
}

test('legacy automation normalization preserves once even when its date is incomplete', () => {
  const intent = require('../components/panels/work-intent.js');
  const complete = intent.normalize({ mode: 'schedule', schedule: { every: 'once', runAt: future, timeZone: 'America/New_York' } });
  assert.equal(complete.schedule.every, 'once');
  assert.equal(complete.schedule.runAt, future);
  assert.equal(complete.schedule.timeZone, 'America/New_York');
  const missing = intent.normalize({ mode: 'schedule', schedule: { every: 'once' } });
  assert.equal(missing.schedule.every, 'once');
  assert.equal(missing.schedule.runAt, '');
});

test('legacy direct create preserves the absolute appointment and refuses an incomplete once', async () => {
  const f = fixture();
  f.c.SoduWorkAPI.taskExecutionOptions = async () => ({ substrates: [{ key: 'local:pi', name: 'Pi', available: true }] });
  assert.equal(await f.c._schmCreateAutomation('Work once', { schedule: { every: 'once', runAt: future, timeZone: 'Asia/Shanghai' } }), true);
  assert.equal(f.saves[0].body.runAt, future);
  assert.equal(f.saves[0].body.timeZone, 'Asia/Shanghai');
  assert.equal(await f.c._schmCreateAutomation('Incomplete once', { schedule: { every: 'once', runAt: '' } }), false);
  assert.equal(f.saves.length, 1);
});

test('legacy direct create converts a frozen normalized wall time without mutating the intent', async () => {
  const f = fixture();
  const intent = require('../components/panels/work-intent.js').normalize({
    mode: 'schedule',
    schedule: { every: 'once', runAt: '2099-10-15T12:30', timeZone: 'Asia/Shanghai' },
  });
  const original = copy(intent);
  assert.equal(Object.isFrozen(intent.schedule), true);
  f.c.SoduWorkAPI.taskExecutionOptions = async () => ({ substrates: [{ key: 'local:pi', name: 'Pi', available: true }] });

  assert.equal(await f.c._schmCreateAutomation('Work once', intent), true);
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0].body.runAt, '2099-10-15T04:30:00.000Z');
  assert.equal(f.saves[0].body.timeZone, 'Asia/Shanghai');
  assert.deepEqual(copy(intent), original);
});

test('legacy conversation create forwards custom recurrence without rewriting lines', async () => {
  const f = fixture();
  const customRule = 'DTSTART;TZID=Asia/Shanghai:20990101T105100\nRRULE:FREQ=HOURLY;INTERVAL=3;COUNT=6';
  f.c.SoduWorkAPI.taskExecutionOptions = async () => ({ substrates: [{ key:'local:pi', name:'Pi', available:true }] });
  assert.equal(await f.c._schmCreateAutomation('Custom work', {schedule:{every:'custom',customRule}}), true);
  assert.equal(f.saves[0].body.customRule, customRule);
  assert.equal(f.saves[0].body.every, 'custom');
});

test('legacy single-weekday intents remain valid through the new array request contract', async () => {
  const f = fixture();
  f.c.SoduWorkAPI.taskExecutionOptions = async () => ({ substrates: [{key:'local:pi',name:'Pi',available:true}] });
  assert.equal(await f.c._schmCreateAutomation('Weekly work', {schedule:{every:'weekly',weekday:3,atHour:9,atMinute:0}}), true);
  assert.deepEqual(f.saves[0].body.weekdays, [3]);
  assert.equal(f.c._schCardNext({every:'custom',enabled:true,retrying:true,nextRunAt:null}), '等待重试');
});

test('an unavailable saved repo remains selected and cannot silently become empty', () => {
  const f = fixture();
  const html = f.c._schFormHtml({ id: 'saved', repoId: 'removed-repo', every: 'daily' });
  assert.match(html, /value="removed-repo"[^>]*selected[^>]*>[^<]*(?:不可用|无权|移除)/);
});

test('late save success or failure cannot close or notify a replacement editor', async () => {
  for (const fail of [false, true]) {
    const f = fixture(); let finish, closes = 0, reloads = 0;
    f.c.SoduWorkAPI.createSchedule = () => new Promise((resolve, reject) => {
      finish = () => fail ? reject(Error('old failure')) : resolve({ id: 'old' });
    });
    f.c._schCloseEditor = () => closes++;
    f.c._loadSch = () => reloads++;
    f.wire(); const pending = f.save();
    // Closing/reopening replaces native controls, even when editing the same row.
    f.controls.schSave = { ...f.controls.schSave, listeners: {} };
    finish(); await pending;
    assert.equal(closes, 0); assert.equal(reloads, 0); assert.deepEqual(f.notices, []);
  }
});

test('one editor cannot submit a second create while its save is pending', async () => {
  const f = fixture(); let finish, requests = 0;
  f.c.SoduWorkAPI.createSchedule = () => {
    requests++; return new Promise(resolve => { finish = resolve; });
  };
  f.wire(); const pending = f.save();
  const duplicate = f.save();
  assert.equal(requests, 1);
  finish(); await Promise.all([pending, duplicate]);
});

test('changing a method releases its old derived capabilities while preserving extra choices', () => {
  const f = fixture();
  const capability = (value, checked, disabled) => ({ value, checked, disabled,
    closest: () => ({ classList: { toggle() {} } }), addEventListener() {} });
  const caps = [capability('browser', true, true), capability('office', true, false)];
  f.controls.schMethod.value = 'browser-method';
  f.c._schmFind = key => key === 'browser-method' ? { capabilities: { runtime: ['browser'] } } : null;
  const query = f.c.document.querySelectorAll;
  f.c.document.querySelectorAll = selector => selector === '#schCaps input' ? caps : query(selector);
  f.wire();
  f.controls.schMethod.value = ''; f.controls.schMethod.listeners.change();
  assert.equal(caps[0].checked, false); assert.equal(caps[0].disabled, false);
  assert.equal(caps[1].checked, true);
});

test('unlocking a pinned snapshot preserves explicit capabilities beyond its method requirements', () => {
  const f = fixture({ id: 'locked', personalPluginKey: 'browser-method', requiredCapabilities: ['browser', 'office'] });
  const capability = value => ({ value, checked: true, disabled: false,
    closest: () => ({ classList: { toggle() {} } }), addEventListener() {} });
  const caps = [capability('browser'), capability('office')]; let locked = true, changePolicy;
  f.controls.schMethod.value = 'browser-method';
  f.c._schmSnapshotLocked = () => locked;
  f.c._schmFind = () => ({ capabilities: { runtime: ['browser'] } });
  const query = f.c.document.querySelectorAll;
  f.c.document.querySelectorAll = selector => selector === '#schCaps input' ? caps :
    selector === '#schMethodWrap input[name="schMethodVersionPolicy"]' ? [{ addEventListener: (_, fn) => { changePolicy = fn; } }] : query(selector);
  f.wire(); assert.ok(caps.every(cap => cap.disabled));
  locked = false; changePolicy();
  assert.equal(caps[0].checked, true); assert.equal(caps[0].disabled, true);
  assert.equal(caps[1].checked, true); assert.equal(caps[1].disabled, false);
});

test('late project-plugin lookup cannot repaint after a newer project choice', async () => {
  const f = fixture(), pending = [], rendered = [];
  f.c._schLoadPlugins = () => new Promise(resolve => pending.push(resolve));
  f.c._schPluginsForRepo = () => [];
  f.c._schPluginConfigHtml = repo => { rendered.push(repo); return repo; };
  f.wire();
  f.controls.schRepo.value = 'first'; const first = f.controls.schRepo.listeners.change();
  f.controls.schRepo.value = 'second'; const second = f.controls.schRepo.listeners.change();
  pending[1](); await second; pending[0](); await first;
  assert.deepEqual(rendered, ['second']);
});

test('save freezes editable fields until a failure restores their previous availability', async () => {
  const f = fixture(); let finish;
  f.controls.schEditorContent = { querySelectorAll: () => [f.controls.schTitle, f.controls.schWho] };
  f.controls.schTitle.disabled = false; f.controls.schWho.disabled = true;
  f.c.SoduWorkAPI.createSchedule = () => new Promise((_, reject) => { finish = () => reject(Error('fixture failure')); });
  f.wire(); const pending = f.save();
  assert.equal(f.controls.schTitle.disabled, true);
  finish(); await pending;
  assert.equal(f.controls.schTitle.disabled, false); assert.equal(f.controls.schWho.disabled, true);
});

test('save uses a fresh preflight and does not persist a blocked automation', async () => {
  const f = fixture(), calls = [];
  f.c.SoduWorkAPI.preflightSchedule = async (body, options) => {
    calls.push({ body, options }); return { state: 'blocked', message: 'Connect your account first' };
  };
  f.wire(); await f.save();
  assert.equal(calls.length, 1); assert.equal(calls[0].options.force, true);
  assert.equal(f.saves.length, 0); assert.ok(f.notices.some(x => x.includes('Connect your account first')));
  assert.equal(f.controls.schSave.disabled, false);
});
test('an unverified offline automation can be saved without claiming readiness', async () => {
  const f = fixture(); f.c.SoduWorkAPI.preflightSchedule = async () => ({ state: 'waiting' });
  f.wire(); await f.save(); assert.equal(f.saves.length, 1);
});
test('closing the editor during preflight prevents a late save or notification', async () => {
  const f = fixture(); let finish;
  f.c.SoduWorkAPI.preflightSchedule = () => new Promise(resolve => { finish = resolve; });
  f.wire(); const pending = f.save();
  f.controls.schSave = { ...f.controls.schSave, listeners: {} };
  finish({ state: 'ready' }); await pending;
  assert.equal(f.saves.length, 0); assert.deepEqual(f.notices, []);
});


test('recurring times are bounded selects with an immediately updated preview', async () => {
  const f = fixture(null, 'daily'); f.wire();
  const html = f.c._schFormHtml({every:'daily', atHour:16, atMinute:59, title:'', note:''});
  assert.match(html, /<select[^>]+id="schH"/);
  assert.match(html, /<select[^>]+id="schM"/);
  assert.doesNotMatch(html, /id="sch[HM]"[^>]*type="number"/);
  f.controls.schH.value = '23'; f.controls.schM.value = '59';
  f.controls.schM.listeners.change();
  assert.match(f.controls.schPv.textContent, /23:59/);
  await f.save();
  assert.equal(f.saves[0].body.atHour, 23); assert.equal(f.saves[0].body.atMinute, 59);
});

test('invalid recurring times are explained immediately and never corrected on save', async () => {
  for (const [field,value] of [['schM','888'],['schM',''],['schM','-1'],['schM','1.5'],['schH','24']]) {
    const f = fixture(null, 'daily'); f.wire(); f.controls[field].value = value;
    f.controls[field].listeners.change();
    assert.match(f.controls.schPv.textContent, /请选择/);
    await f.save(); assert.equal(f.saves.length, 0);
    assert.equal(f.controls[field].value, value);
    assert.equal(f.controls[field].attrs['aria-invalid'], 'true');
  }
});

test('hourly schedules expose their minute selection and retain it unchanged', async () => {
  const f = fixture(null, 'hourly'); f.wire();
  assert.equal(f.controls.schHWrap.style.display, '');
  assert.equal(f.controls.schH.hidden, true);
  f.controls.schM.value = '30'; f.controls.schM.listeners.change();
  await f.save(); assert.equal(f.saves[0].body.atMinute, 30);
});

test('clock options include every boundary without coercing invalid stored values', () => {
  const {c} = fixture();
  for (const [limit,value] of [[24,23],[60,59]]) {
    const options = c.ScheduleTiming.clockOptions(limit,value);
    assert.equal((options.match(/<option /g)||[]).length,limit);
    assert.ok(options.includes('value="0">00</option>'));
    assert.ok(options.includes('value="'+value+'" selected>'+value+'</option>'));
  }
  assert.match(c.ScheduleTiming.clockOptions(60,888), /value="" selected disabled/);
  assert.ok(c.ScheduleTiming.validate({every:'daily',atHour:0,atMinute:0}) === '');
  assert.ok(c.ScheduleTiming.validate({every:'hourly',atMinute:59}) === '');
});
