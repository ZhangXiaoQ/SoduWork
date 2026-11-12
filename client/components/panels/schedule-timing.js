/* Shared display and input contract for schedule instants. Hub owns dispatch.
   datetime-local values are interpreted in the schedule's zone, not the OS zone. */
(function (global) {
  'use strict';
  const every = [['daily','每天'],['weekly','每周'],['monthly','每月'],['hourly','每小时'],['once','指定日期时间 · 仅一次'],['custom','自定义']];
  const weekdays = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
  const pad = value => String(value).padStart(2, '0');
  const instant = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
  function localInput(value, zone) {
    if (!instant(value)) return '';
    try {
      const date = new Date(value), parts = {};
      new Intl.DateTimeFormat('en-CA', {timeZone:zone, year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'})
        .formatToParts(date).forEach(part => {parts[part.type] = part.value;});
      const base = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
      const fraction = date.getUTCMilliseconds();
      return base + (parts.second !== '00' || fraction ? ':' + parts.second : '') +
        (fraction ? '.' + String(fraction).padStart(3,'0') : '');
    } catch (_) { return ''; }
  }
  function fromLocalInput(value, zone) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
    if (!match || Number(match[1]) < 100) return '';
    const ms = Number((match[7] || '').padEnd(3,'0'));
    const nominal = Date.UTC(+match[1],+match[2]-1,+match[3],+match[4],+match[5],+(match[6] || 0),ms);
    const canonical = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}` +
      (Number(match[6]) || ms ? ':' + (match[6] || '00') : '') + (ms ? '.' + String(ms).padStart(3,'0') : '');
    // Check both sides of an offset transition. A repeated/missing wall time must
    // be corrected explicitly, rather than quietly selecting a different instant.
    const offsets = new Set(), matches = new Set();
    for (const hours of [-36,0,36]) {
      const sample = nominal + hours * 3600000;
      const local = localInput(new Date(sample).toISOString(),zone);
      if (!local) return '';
      offsets.add(Date.parse(local + 'Z') - sample);
    }
    for (const offset of offsets) {
      const candidate = new Date(nominal-offset).toISOString();
      if (localInput(candidate,zone) === canonical) matches.add(candidate);
    }
    return matches.size === 1 ? [...matches][0] : '';
  }
  function clockNumber(value) {
    return value == null || String(value).trim() === '' ? NaN : Number(value);
  }
  function clockOptions(limit, value) {
    const selected = clockNumber(value);
    const valid = Number.isInteger(selected) && selected >= 0 && selected < limit;
    return (valid ? '' : '<option value="" selected disabled>--</option>') +
      Array.from({length:limit}, (_, number) => '<option value="' + number + '"' +
        (number === selected ? ' selected' : '') + '>' + pad(number) + '</option>').join('');
  }
  function cleanList(value, min, max) {
    let values = [];
    if (Array.isArray(value)) values = value;
    else if (value != null && value !== '') values = [value];
    return [...new Set(values.map(item => Number(item)).filter(item => Number.isInteger(item) && item >= min && item <= max))].sort((a, b) => a - b);
  }
  function cleanDate(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
    const date = new Date(text + 'T00:00:00Z');
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? '' : text;
  }
  function customDateTime(raw) {
    const match = String(raw || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i);
    if (!match || Number(match[1]) < 100) return false;
    const [, year, month, day, hour, minute, second = '00'] = match;
    if (!cleanDate(year + '-' + month + '-' + day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
    return true;
  }
  function customInstant(raw, zone) {
    const value = raw.toUpperCase(), stamp = value.replace(/Z$/, '').padEnd(15, '0');
    const wall = stamp.slice(0, 4) + '-' + stamp.slice(4, 6) + '-' + stamp.slice(6, 8) + 'T' +
      stamp.slice(9, 11) + ':' + stamp.slice(11, 13);
    return value.endsWith('Z') ? wall + ':00Z' : fromLocalInput(wall, zone);
  }
  function validateCustomRule(raw, defaultZone = 'Asia/Shanghai') {
    const text = String(raw || '').trim();
    if (!text) return '请填写自定义规则';
    if (text.length > 4096) return '自定义规则最多 4096 个字符';
    const lines = text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
    const headers = Object.create(null);
    for (const line of lines) {
      const match = line.match(/^(DTSTART|RRULE)(?:;TZID=([^:;]+))?:(.+)$/i);
      if (!match || headers[match[1].toUpperCase()] || (match[1].toUpperCase() === 'RRULE' && match[2]))
        return '自定义规则仅支持一行 DTSTART 和一行 RRULE';
      headers[match[1].toUpperCase()] = { value: match[3].trim(), zone: match[2] };
    }
    if (!headers.DTSTART) return '自定义规则需要包含 DTSTART';
    if (!headers.RRULE) return '自定义规则需要包含 RRULE';
    if (/[+-]\d{2}:?\d{2}$/.test(headers.DTSTART.value) || (headers.DTSTART.zone && /Z$/i.test(headers.DTSTART.value)))
      return '自定义规则请使用 TZID 或 Z 指定时区';
    if (!customDateTime(headers.DTSTART.value)) return '自定义规则的 DTSTART 日期时间无效';
    const zone = /Z$/i.test(headers.DTSTART.value) ? 'UTC' : headers.DTSTART.zone || defaultZone;
    try { new Intl.DateTimeFormat('en', { timeZone: zone }); }
    catch (_) { return '自定义规则的时区无效'; }
    const fields = Object.create(null);
    for (const token of headers.RRULE.value.split(';')) {
      const pair = token.split('=');
      const key = pair[0].trim().toUpperCase(), value = String(pair[1] || '').trim().toUpperCase();
      if (pair.length !== 2 || !key || !value || Object.hasOwn(fields, key))
        return 'RRULE 包含重复或无效的字段';
      fields[key] = value;
    }
    if (!['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'].includes(fields.FREQ))
      return 'RRULE 的 FREQ 支持 HOURLY、DAILY、WEEKLY 或 MONTHLY';
    if (Object.keys(fields).some(key => !['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY'].includes(key)))
      return 'RRULE 包含不支持的字段';
    if (fields.INTERVAL && (!/^\d+$/.test(fields.INTERVAL) || Number(fields.INTERVAL) < 1 || Number(fields.INTERVAL) > 100000))
      return 'RRULE 的 INTERVAL 应为 1 至 100000 的整数';
    if (fields.COUNT && (!/^\d+$/.test(fields.COUNT) || Number(fields.COUNT) < 1 || Number(fields.COUNT) > 1000000))
      return 'RRULE 的 COUNT 应为 1 至 1000000 的整数';
    if (fields.COUNT && fields.UNTIL) return 'RRULE 的 COUNT 与 UNTIL 不能同时使用';
    if (fields.UNTIL && /[+-]\d{2}:?\d{2}$/.test(fields.UNTIL)) return '自定义规则请使用 TZID 或 Z 指定时区';
    if (fields.UNTIL && !customDateTime(fields.UNTIL)) return 'RRULE 的 UNTIL 日期时间无效';
    if ([headers.DTSTART.value, fields.UNTIL].some(value => value && /T\d{4}(?!00)\d{2}Z?$/i.test(value)))
      return '自定义规则的时间须精确到分钟，秒数应为 00';
    const start = customInstant(headers.DTSTART.value, zone);
    const until = fields.UNTIL ? customInstant(fields.UNTIL, zone) : null;
    if (!start || (fields.UNTIL && !until)) return '自定义规则的日期时间因夏令时无效或不明确，请调整后重试';
    if (until && Date.parse(until) < Date.parse(start)) return 'RRULE 的 UNTIL 不能早于 DTSTART';
    if (fields.BYDAY && (fields.FREQ !== 'WEEKLY' || fields.BYDAY.split(',').some(day => !/^(MO|TU|WE|TH|FR|SA|SU)$/.test(day))))
      return 'BYDAY 仅用于 WEEKLY，使用 MO、TU、WE、TH、FR、SA、SU';
    if (fields.BYMONTHDAY && (fields.FREQ !== 'MONTHLY' || fields.BYMONTHDAY.split(',').some(day => !/^\d+$/.test(day) || Number(day) < 1 || Number(day) > 31)))
      return 'BYMONTHDAY 仅用于 MONTHLY，日期范围为 1 至 31';
    return '';
  }
  function customExample(zone = 'Asia/Shanghai', now = Date.now()) {
    const nextHour = new Date(now + 3600000).toISOString();
    const wall = localInput(nextHour, zone).slice(0, 16).replace(/[-:]/g, '') + '00';
    return 'DTSTART;TZID=' + zone + ':' + wall + '\nRRULE:FREQ=DAILY;COUNT=1';
  }
  function customTimeZone(raw, fallback = 'Asia/Shanghai') {
    const start = String(raw || '').split(/\r?\n/).find(line => /^\s*DTSTART(?:;|:)/i.test(line));
    const declared = start?.match(/;TZID=([^:;]+):/i)?.[1];
    return declared || (/Z\s*$/i.test(start || '') ? 'UTC' : fallback);
  }
  function customPreview(result, zone) {
    if (result?.timingError) return result.timingError;
    if (!result || !Object.hasOwn(result, 'nextRunAt')) return '保存后由服务端计算下一次执行时间';
    if (!result.nextRunAt) return '自定义规则已无后续执行时间';
    const wall = localInput(result.nextRunAt, result.timeZone || zone || 'Asia/Shanghai');
    const nextLabel = global.SoduWorkI18n?.translateText?.('下一次：') || '下一次：';
    return wall ? nextLabel + wall.replace('T', ' ') : '保存后由服务端计算下一次执行时间';
  }
  function validate(value, existing, now = Date.now()) {
    if (!every.some(item => item[0] === value.every)) return '请选择支持的执行方式';
    if (value.every === 'custom') return validateCustomRule(value.customRule, value.timeZone);
    if (value.every !== 'once') {
      const startDate = cleanDate(value.startDate), endDate = cleanDate(value.endDate);
      if (value.startDate && !startDate) return '开始日期无效，请重新选择';
      if (value.endDate && !endDate) return '结束日期无效，请重新选择';
      if (startDate && endDate && startDate > endDate) return '开始日期不能晚于结束日期';
      const hour = clockNumber(value.atHour), minute = clockNumber(value.atMinute);
      if (value.every !== 'hourly' && (!Number.isInteger(hour) || hour < 0 || hour > 23))
        return '请选择小时（00–23）';
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) return '请选择分钟（00–59）';
      if (value.every === 'weekly' && !cleanList(value.weekdays, 1, 7).length && !cleanList(value.weekday, 1, 7).length)
        return '请选择至少一个星期';
      if (value.every === 'monthly' && !cleanList(value.monthDays, 1, 31).length)
        return '请选择至少一个月度日期';
      if (value.every === 'monthly' && !['skip', 'last_day'].includes(value.monthDayPolicy || 'skip'))
        return '月度无效日期处理方式无效';
      return '';
    }
    if (!instant(value.runAt)) return '请选择有效的执行日期和时间；夏令时跳过或重复的时刻请调整后重试';
    const unchanged = existing?.id && existing.every === 'once' && value.runAt === existing.runAt;
    if (!unchanged && Date.parse(value.runAt) <= now) return '执行时间已过去，请选择将来的日期和时间';
    return '';
  }
  function summary(value) {
    if (value.every === 'custom') return value.customRule ? '自定义规则' : '自定义规则 · 待设置';
    const formatted = localInput(value.runAt,value.timeZone);
    return formatted ? formatted.replace('T',' ') + ' · 仅一次' : '指定日期时间 · 待设置';
  }
  function cnNumber(raw) {
    if (/^\d{1,2}$/.test(raw)) return Number(raw);
    const digits = {'零':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
    const parts = String(raw).split('十');
    return parts.length === 2 ? (parts[0] ? digits[parts[0]] : 1)*10 + (parts[1] ? digits[parts[1]] : 0) : digits[raw];
  }
  function clock(text) {
    const found = text.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*([\d零一二两三四五六七八九十]{1,3})\s*([:：点时])\s*(半|一刻|三刻|整|[\d零一二两三四五六七八九十]{1,3})?\s*分?/);
    if (!found) return null;
    let hour = cnNumber(found[2]);
    const token = found[4] || '0', minute = ({半:30,一刻:15,三刻:45,整:0})[token] ?? cnNumber(token);
    if (/下午|傍晚|晚上/.test(found[1]) && hour < 12) hour += 12;
    if (/凌晨|早上|上午/.test(found[1]) && hour === 12) hour = 0;
    if (found[1] === '中午' && hour < 11) hour += 12;
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? {atHour:hour,atMinute:minute} : {invalid:true};
  }
  function infer(text, previous, now = Date.now()) {
    const rawLines = String(text || '').split(/\r?\n/), lines = rawLines.map(line => line.trim());
    const calendarProperty = /^(?:DTSTART|RRULE|RDATE|EXDATE|EXRULE|DTEND|DURATION|RECURRENCE-ID|TZID|BEGIN|END|X-[A-Z0-9-]+)(?:;[^:]*)?:/i;
    if (lines.some(line => /^(?:DTSTART|RRULE)(?:;[^:]*)?:/i.test(line))) {
      // Preserve unsupported properties and folded lines for strict validation.
      let continuation = false;
      const ruleLines = lines.filter((line, index) => {
        const property = calendarProperty.test(line) || /^[A-Z][A-Z0-9-]*(?:;[^:]*)?:/.test(line);
        continuation = property || (continuation && Boolean(line) && /^[ \t]/.test(rawLines[index]));
        return continuation;
      });
      return { ...previous, every: 'custom', customRule: ruleLines.join('\n'),
        runAt: null, timeZone: previous?.timeZone || 'Asia/Shanghai' };
    }
    // Keep recurrence lists together before separating timing from task content.
    text = String(text || '').replace(/每周\s*[一二三四五六日天](?:\s*[、,，和及]\s*(?:周)?[一二三四五六日天])+|每月\s*\d{1,2}(?:\s*[日号])?(?:\s*[、,，和及]\s*\d{1,2}(?:\s*[日号])?)+/g,
      group => group.replace(/[,，]/g, '、'));
    text = String(text || '').split(/[，,。；;\n]/).map(clause => {
      const first = clause.search(/\d{4}[-/年]|\d{1,2}月|今天|明天|后天|今晚|明晚|[本这下]周|每[天日周月小]|(?:仅|只|执行|运行)一次|一次性|单次|[零一二两三四五六七八九十\d]+[:：点时]|\btoday\b|\btomorrow\b|\bonce\b/i);
      const before = first < 0 ? clause : clause.slice(0,first);
      if (/(?:不要|不用|不在|不需要|不是|取消|如果|假如|比如|例如|是否|能否|\bif\b|\bdo not\b|\bdon't\b)/i.test(before)) return '';
      // Only the text before the leading appointment determines whether it is
      // source material. "Tomorrow at noon, summarize today's data" remains once.
      if (/(?:分析|统计|查看|处理|读取|汇总|对比|报告中|日志中)/.test(before) &&
          !/(?:执行时间|触发时间|运行时间|定于|改为|改到|安排在|计划在)/.test(before)) return '';
      const work = first < 0 ? -1 : clause.slice(first).search(/分析|统计|查看|处理|读取|汇总|对比|生成|输出|检查|发送|开发|制作/);
      return work < 0 ? clause : clause.slice(0,first+work);
    }).join('，');
    const prior = previous || {}, next = {...{every:'daily',atHour:18,atMinute:0,weekday:1},...prior};
    const zone = /北京时间/.test(text) ? 'Asia/Shanghai' : /\bUTC\b/.test(text) ? 'UTC' :
      prior.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
    next.timeZone = zone;
    const recurring = /每(?:隔)?(?:一|1)?小时|每小时|每周|每月|每天|每日|天天/.test(text);
    const explicit = text.match(/(?:\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})|(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号])/);
    const relative = text.match(/大后天|后天|明天|明晚|今天|今晚|\btoday\b|\btomorrow\b/i);
    const week = text.match(/(本周|这周|下周)([一二三四五六日天])/);
    const oneTime = !recurring && Boolean(explicit || relative || week || /(?:仅|只)(?:执行|运行)?一次|执行一次|运行一次|一次性|单次|\bonce\b/i.test(text));
    if (/每(?:隔)?(?:一|1)?小时|每小时/.test(text)) next.every = 'hourly';
    else if (/每周/.test(text)) next.every = 'weekly';
    else if (/每月/.test(text)) next.every = 'monthly';
    else if (/每天|每日|天天/.test(text)) next.every = 'daily';
    if (oneTime) next.every = 'once';
    const weekday = text.match(/(?:每周|周)([一二三四五六日天])/);
    if (weekday && !oneTime && prior.every !== 'once') next.every = 'weekly';
    const weekdayGroup = text.match(/每周\s*([一二三四五六日天](?:\s*[、,，和及]\s*(?:周)?[一二三四五六日天])*)/);
    if (weekdayGroup && !oneTime) {
      next.weekdays = [...new Set([...weekdayGroup[1].matchAll(/[一二三四五六日天]/g)].map(item => Math.min(7, '一二三四五六日天'.indexOf(item[0]) + 1)))].sort((a, b) => a - b);
      next.weekday = next.weekdays[0];
    } else if (weekday) {
      next.weekdays = [Math.min(7, '一二三四五六日天'.indexOf(weekday[1]) + 1)];
      next.weekday = next.weekdays[0];
    }
    const monthGroup = text.match(/每月\s*(\d{1,2}(?!\d)(?:\s*[日号])?(?:\s*[、,，和及]\s*\d{1,2}(?!\d)(?:\s*[日号])?)*(?![:：点时])|月底|月末|最后一天|末日)/);
    if (/每月/.test(text) && !oneTime) {
      const segment = monthGroup?.[1] || '';
      const monthTokens = [
        ...segment.matchAll(/(?:^|[、,，和及至到\s])(\d{1,2})(?=\s*(?:日|号))/g),
        ...segment.matchAll(/(?:^|[、,，和及至到\s])(\d{1,2})(?=\s*(?:[、,，和及至到\s]|$))/g),
      ].map(item => item[1]);
      next.monthDays = cleanList(monthTokens, 1, 31);
      if (/月底|月末|最后一天|末日/.test(segment)) {
        next.monthDayPolicy = 'last_day';
        if (!next.monthDays.length) next.monthDays = [31];
      }
    }
    const time = clock(text);
    if (time && !time.invalid) Object.assign(next,time);
    else if (next.every === 'hourly') {
      const minute = text.match(/(?:第|每小时)?\s*([0-5]?\d)\s*分/);
      if (minute) next.atMinute = Number(minute[1]);
    }
    if (next.every !== 'once') { next.runAt = null; return next; }
    if (!explicit && !relative && !week && !time && prior.every === 'once') return next;
    const old = localInput(prior.runAt,zone);
    let date = prior.every === 'once' && old ? old.slice(0,10) : '';
    const today = localInput(new Date(now).toISOString(),zone).slice(0,10);
    const firstDate = [explicit,relative,week].filter(Boolean).sort((a,b) => a.index-b.index)[0];
    if (firstDate && firstDate === explicit) date = `${explicit[1] || explicit[4] || today.slice(0,4)}-${pad(explicit[2] || explicit[5])}-${pad(explicit[3] || explicit[6])}`;
    else if (firstDate) {
      const day = new Date(today + 'T12:00:00Z');
      const offset = firstDate === relative ? /大后天/.test(relative[0]) ? 3 : /后天/.test(relative[0]) ? 2 : /明|tomorrow/i.test(relative[0]) ? 1 : 0 :
        (week[1] === '下周' ? 7 : 0) + Math.min(6,'一二三四五六日天'.indexOf(week[2])) - ((day.getUTCDay()+6)%7);
      day.setUTCDate(day.getUTCDate()+offset); date = day.toISOString().slice(0,10);
    }
    // A newly requested one-off without an explicit clock stays incomplete.
    const when = time && !time.invalid ? pad(time.atHour)+':'+pad(time.atMinute) : old ? old.slice(11) : '';
    next.runAt = date && when && !time?.invalid ? fromLocalInput(date+'T'+when,zone) : '';
    return next;
  }
  global.ScheduleTiming = {every,weekdays,localInput,fromLocalInput,validate,summary,infer,clock,clockNumber,clockOptions,cleanList,cleanDate,
    validateCustomRule,customExample,customPreview,customTimeZone};
})(window);
