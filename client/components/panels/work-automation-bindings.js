/* Automation draft references only. A model suggests names; the current visible
   catalogs supply IDs, versions and capabilities. This never parses chat hooks. */
(function (global) {
  'use strict';
  const fields = { method: 'personalPluginKey', repo: 'repoId', agent: 'assigneeId' };
  const labels = { method: '工作方法插件', repo: '关联工程', agent: '执行底座' };
  const trim = value => String(value || '').trim();
  const norm = value => trim(value).replace(/[\s「」『』“”"'《》]/g, '').toLowerCase();
  const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const kinds = {
    method: { noun: '(?:插件|工作方法|plugin|method)', clear: /(?:不再使用|不使用|不用|不要用|无需|取消)(?:任何|该|这个)?(?:插件|工作方法)|\b(?:no|without|remove|clear)\s+(?:the\s+)?(?:plugin|method)\b/i,
      before: '(?:使用|调用|采用|选用|选择|指定|改用|改为|切换到|切换为|通过|用|\\buse|\\busing|\\bselect|\\bswitch to)' },
    repo: { noun: '(?:工程|仓库|项目|project|repository|repo)', clear: /(?:不关联|不指定|不使用|不用|取消关联|移除)(?:任何|该|这个)?(?:工程|仓库|项目)|\b(?:no|without|remove|clear)\s+(?:the\s+)?(?:project|repository|repo)\b/i,
      before: '(?:关联到|关联|指定|切换到|改用|使用|选择|选用|绑定|挂到|挂在|在|用|\\bin|\\buse|\\bselect|\\bswitch to)' },
    agent: { noun: '(?:执行底座|底座|Agent|substrate)', clear: /(?:取消指定|不指定)(?:执行底座|底座|Agent)|\b(?:no|without|remove|clear)\s+(?:the\s+)?(?:agent|substrate)\b/i,
      before: '(?:使用|选择|指定|改用|切换到|改为|用|由|\\buse|\\busing|\\bselect|\\brun with|\\bexecute with)' },
  };
  const nonDirective = /(?:不要|不用|不使用|不想|禁止|别用|不需要|不是|不选|而非|如果|假如|比如|例如|是否|能否|能不能|\bif\b|\bunless\b|\bwithout\b|\bdo not\b|\bdon't\b|\bcompare\b)/i;
  const hypothetical = /如果|假如|比如|例如|是否|能否|能不能|\bif\b|\bunless\b|\bwhether\b|\bcompare\b/i;
  const textEdit = /(?:标题|名称|执行说明|完成标准|备注|正文|描述).{0,12}(?:改为|改成|设为|设置为|写成|写为|叫做|叫|增加|添加|写上)|\b(?:title|name|note|description)\b.{0,20}\b(?:to|as|is)\b/i;
  function directiveText(text) {
    const pairs = {'“':'”','「':'」','『':'』','《':'》','"':'"',"'":"'"};
    let output = '', start = 0;
    for (let i = 0; i < text.length; i++) {
      const close = pairs[text[i]];
      if (close && textEdit.test(text.slice(start, i))) {
        const end = text.indexOf(close, i + 1), last = end < 0 ? text.length - 1 : end;
        output += ' '.repeat(last - i + 1); i = last;
      } else {
        output += text[i];
        if (/[，,。；;\n]/.test(text[i])) start = i + 1;
      }
    }
    return output;
  }
  const clauses = text => directiveText(text).split(/[，,。；;\n]|而是|但是/).map(trim).filter(Boolean);
  function rows(catalogs, kind) { return catalogs[kind === 'method' ? 'methods' : kind === 'repo' ? 'repos' : 'agents'] || []; }
  function idOf(item, kind) { return trim(kind === 'method' ? item.key : item.id); }
  function names(item) { return [item.name, item.title, item.projectName, ...(Array.isArray(item.aliases) ? item.aliases : [])].filter(Boolean); }
  function cleanName(value) {
    return trim(value).replace(/^(?:名为|名称为|叫做|叫|名叫)\s*/, '').replace(/^[「『“"'《\s]+|[」』”"'》\s]+$/g, '');
  }
  function exact(items, name) { return items.filter(item => names(item).some(value => norm(value) === norm(name))); }
  function references(text, kind, items) {
    const rule = kinds[kind], found = [];
    for (const clause of clauses(text)) {
      if (hypothetical.test(clause) || textEdit.test(clause)) continue;
      if (rule.clear.test(clause)) { found.push({ action: 'clear', evidence: clause }); continue; }
      // A negative or hypothetical clause must not silently become an instruction.
      if (nonDirective.test(clause)) continue;
      let direct = false;
      for (const item of items) for (const name of names(item)) {
        const n = escape(name), quote = '[「『“"\'《]?';
        const end = '(?=$|[」』”"\'》\\s]|插件|工作方法|工程|仓库|项目|底座|执行|运行|开发|完成|进行|帮我|来|做|的|中)';
        const closing = '[」』”"\'》]?\\s*';
        const includesKind = new RegExp(rule.noun + '$', 'i').test(name);
        const tail = includesKind ? end : closing + '(?:' + rule.noun + (kind === 'agent' ? '|执行|运行' : '') + ')';
        const before = new RegExp(rule.before + '(?:名为|名称为|叫做|\\s+the)?\\s*' + quote + n + tail, 'i');
        const after = new RegExp(rule.noun + '(?:选择|选用|使用|设为|改为|指定为|指定|为|是|[:：])\\s*' + quote + n + end, 'i');
        const leadingKind = new RegExp(rule.before + '\\s*' + rule.noun + '\\s*' + quote + n + end, 'i');
        if (before.test(clause) || after.test(clause) || leadingKind.test(clause)) {
          found.push({ action: 'select', name: trim(name), evidence: clause }); direct = true; break;
        }
      }
      if (direct) continue;
      const name = '[^，,。；;\\n]{1,80}?';
      const a = clause.match(new RegExp(rule.before + '\\s*(' + name + ')' + rule.noun, 'i'));
      const b = clause.match(new RegExp(rule.noun + '(?:选择|选用|使用|设为|改为|指定为|指定|为|是|[:：])\\s*(' + name + ')(?=$|[，,。；;])', 'i'));
      const c = kind === 'agent' && clause.match(/(?:由|使用|改用)\s*([^，,。；;\n]{1,40}?)(?:执行|运行)/i);
      const captured = a ? a[1] : b ? b[1] : c ? c[1] : '';
      if (captured && !/帮我|开发|生成|完成|创建|新建|编写|处理|然后|插件/.test(captured)) {
        found.push({ action: 'select', name: cleanName(captured), evidence: clause });
      }
    }
    return found.filter(item => item.action === 'clear' || item.name);
  }
  function parsedReference(text, value, kind) {
    if (!value || typeof value !== 'object') return null;
    const evidence = trim(value.evidence), name = trim(value.name);
    if (!evidence || !text.includes(evidence)) return null;
    if (!clauses(text).some(clause => clause.includes(evidence) && !hypothetical.test(clause) && !textEdit.test(clause))) return null;
    if (value.action === 'clear') return kinds[kind].clear.test(evidence) ? {action:'clear',evidence} : null;
    if (value.action !== 'select' || !name || !evidence.includes(name)) return null;
    if (!clauses(text).some(clause => clause.includes(evidence) && !nonDirective.test(clause))) return null;
    const otherKinds = Object.keys(kinds).filter(key => key !== kind);
    if (otherKinds.some(key => new RegExp(escape(name) + '[」』”"\'》]?\\s*' + kinds[key].noun, 'i').test(evidence)) &&
        !new RegExp(escape(name) + '[」』”"\'》]?\\s*' + kinds[kind].noun, 'i').test(evidence)) return null;
    // The reference has to occur in an instruction, not merely in generated prose.
    if (!new RegExp(kinds[kind].before + '[^，,。；;\\n]{0,40}' + escape(name), 'i').test(evidence)) return null;
    return { action:'select', name, id:trim(value.id), evidence };
  }
  function issue(kind, name, reason) { return { field:fields[kind], message: labels[kind] + '“' + name + '”' + reason + '，请在表单中明确选择。' }; }
  function activationClauses(text) {
    // Literal content is not schedule control. Mask before splitting so sentence
    // punctuation inside a quote or code block cannot manufacture a directive.
    const pairs = {'“':'”','「':'」','『':'』','《':'》','"':'"',"'":"'"};
    let plain = '', fence = null;
    for (const line of text.split(/\r?\n/)) {
      if (fence) {
        if (new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}\\s*$').test(line)) fence = null;
        continue;
      }
      const start = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (start) { fence = start[1]; plain += '\n\uFFF0'; }
      else plain += '\n' + (/^\s*>/.test(line) ? '\uFFF0' : line);
    }
    let visible = '';
    for (let i = 0; i < plain.length; i++) {
      const char = plain[i];
      if (char === '`') {
        const run = plain.slice(i).match(/^`+/)[0];
        let end = i + run.length;
        for (; end < plain.length; end++) {
          if (plain[end] !== '`') continue;
          const closing = plain.slice(end).match(/^`+/)[0];
          if (closing.length === run.length) break;
          end += closing.length - 1;
        }
        visible += '\uFFF0'; i = Math.min(plain.length, end + run.length) - 1;
      } else if (pairs[char] && !(char === "'" && /\w/.test(plain[i - 1] || '') && /\w/.test(plain[i + 1] || ''))) {
        let end = i + 1;
        for (; end < plain.length; end++) {
          if (plain[end] === '\\') { end++; continue; }
          if (plain[end] === pairs[char]) break;
        }
        visible += '\uFFF0'; i = end;
      } else visible += char;
    }
    // Keep conditional context across commas, semicolons and line wraps. Only
    // complete, unambiguous imperative sentences may alter activation.
    const uncertain = /如果|假如|假设|若|除非|只有|一旦|比如|例如|是否|能否|能不能|(?:审批|审核|批准|确认|同意|通过).{0,12}(?:后|时|再)|\b(?:if|unless|whether|when|once|after approval|provided|example|suppose|compare)\b/i;
    return (visible.match(/[^。.!！?？]+[。.!！?？]?/g) || [])
      .filter(sentence => !/[?？]/.test(sentence) && !uncertain.test(sentence))
      .flatMap(sentence => sentence.replace(/[。.!！]$/, '').split(/[，,；;\n]/).map(trim));
  }
  function resolve(raw, text, prior, catalogs) {
    const next = { ...prior, bindingIssues: [...(prior.bindingIssues || [])] };
    const source = directiveText(trim(text));
    // Only explicit schedule directives change activation; quoted work content
    // and "do not run immediately" are not instructions to pause the schedule.
    for (const clause of activationClauses(trim(text))) {
      if (/^(?:请)?(?:保存为暂停(?:状态|计划)?|(?:创建|保存)后(?:暂不|不要|不)启用|暂不启用|保持暂停(?:状态)?|暂停(?:此|这个|该)?(?:计划|自动化))$/.test(clause) ||
          /^(?:please\s+)?(?:save (?:it )?as paused|keep (?:it )?paused|do not enable (?:it )?after (?:creation|saving))$/i.test(clause)) next.enabled = false;
      else if (/^(?:请)?(?:创建后启用|保存后启用|启用(?:此|这个|该)(?:计划|自动化))$/.test(clause) ||
          /^(?:please\s+)?enable (?:it )?after (?:creation|saving)$/i.test(clause)) next.enabled = true;
    }
    for (const kind of Object.keys(fields)) {
      const items = rows(catalogs, kind), field = fields[kind];
      let refs = references(source, kind, items);
      const parsed = parsedReference(source, raw?.automationBindings?.[kind], kind);
      if (!refs.length && parsed) refs = [parsed];
      if (!refs.length) continue; // Omitted means preserve, including a deliberate empty selection.
      next.bindingIssues = next.bindingIssues.filter(item => item.field !== field);
      const keys = [...new Set(refs.map(ref => ref.action === 'clear' ? '@clear' : norm(ref.name)))];
      if (keys.length > 1) {
        next[field] = '';
        next.bindingIssues.push(issue(kind, refs.map(ref => ref.name || '不指定').join(' / '), '存在多个指定'));
      } else if (refs[0].action === 'clear') {
        next[field] = kind === 'agent' ? (items.find(item => item.available !== false)?.id || '') : '';
      } else {
        const ref = refs[0];
        let matches = exact(items, ref.name);
        // Semantic abbreviation can suggest a unique catalog row, never invent an ID.
        if (!matches.length && parsed && norm(parsed.name) === norm(ref.name)) {
          const suggested = items.filter(item => idOf(item, kind) === parsed.id);
          const similar = items.filter(item => names(item).some(name => norm(name).includes(norm(ref.name))));
          if (suggested.length === 1 && similar.length === 1 && suggested[0] === similar[0]) matches = suggested;
        }
        if (matches.length === 1) next[field] = idOf(matches[0], kind);
        else {
          next[field] = '';
          next.bindingIssues.push(issue(kind, ref.name, matches.length ? '名称不唯一' : '当前不可用或无法唯一匹配'));
        }
      }
      if (kind === 'method' && next[field] !== prior[field]) next.pluginInputs = {};
      if (kind === 'repo' && !next[field]) next.flow = false;
    }
    if (/(?:^|\n)\s*(?:DTSTART(?:;TZID=[^:;]+)?:|RRULE:)/i.test(source)) {
      next.every = 'custom';
      next.bindingIssues = next.bindingIssues.filter(item => item.field !== 'every');
    } else if (/(?:每月|monthly)/i.test(source)) {
      next.every = 'monthly';
      next.bindingIssues = next.bindingIssues.filter(item => item.field !== 'every');
    } else if (/(?:每年|yearly)/i.test(source)) {
      next.every = '';
      next.bindingIssues = next.bindingIssues.filter(item => item.field !== 'every');
      next.bindingIssues.push({field:'every',message:'当前不支持年度执行，请确认时间安排后再创建。'});
    } else if (/(?:每天|每日|每周|每小时|今天|明天|后天|今晚|明晚|单次|一次)/.test(source)) {
      next.bindingIssues = next.bindingIssues.filter(item => item.field !== 'every');
    }
    return next;
  }
  function candidates(catalogs, instruction) {
    const value = {};
    for (const kind of Object.keys(fields)) value[kind === 'method' ? 'methods' : kind === 'repo' ? 'repos' : 'agents'] =
      rows(catalogs, kind).map(item => ({id:idOf(item, kind), name:trim(item.name || item.title || item.id)}));
    return {kind:'automation',instruction:trim(instruction),candidates:value};
  }
  function fromContext(prior, context, catalogs) {
    const next = {...prior, bindingIssues:[...(prior.bindingIssues || [])]}, ctx = context || {};
    for (const field of Object.values(fields)) if (!Object.hasOwn(prior, field) && ctx[field]) next[field] = trim(ctx[field]);
    const plugins = ctx.plugins || [];
    if (!Object.hasOwn(prior, 'personalPluginKey') && plugins.length && !ctx.personalPluginKey) {
      next.bindingIssues.push(issue('method', plugins.map(item => item.name || item.pluginId || item.key).join(' / '),
        plugins.length > 1 ? '一次只能绑定一个' : '不属于可自动执行的本机工作方法'));
    }
    if (!next.repoId && !Object.hasOwn(prior, 'repoId') && ctx.projectId) {
      const matches = (catalogs.repos || []).filter(item => String(item.projectId || '') === String(ctx.projectId));
      if (matches.length === 1) next.repoId = matches[0].id;
      else next.bindingIssues.push(issue('repo', '当前项目', '没有唯一关联工程'));
    }
    if (!next.assigneeId && ctx.adapterId) {
      const matches = (catalogs.agents || []).filter(item =>
        item.adapterId === ctx.adapterId || String(item.id).split(':').at(-1) === ctx.adapterId);
      if (matches.length === 1) next.assigneeId = matches[0].id;
      else next.bindingIssues.push(issue('agent', ctx.adapterId, '没有唯一可用底座'));
    }
    return next;
  }
  function validate(value, catalogs) {
    if (value.bindingIssues?.length) return value.bindingIssues.map(item =>
      global.SoduWorkI18n?.translateText?.(item.message) || item.message).join('\n');
    for (const kind of Object.keys(fields)) {
      const id = value[fields[kind]];
      if (id && !rows(catalogs, kind).some(item => idOf(item, kind) === String(id))) {
        return labels[kind] + '已不可用，请重新选择；不会自动切换为默认配置。';
      }
    }
    return '';
  }
  function refinePrompt(current, change) {
    return ['请根据用户补充更新这条自动化的标题、执行说明和完成标准。',
      '没有提到的内容必须保留；不要编造执行时间、Agent 或权限。',
      '当前自动化：' + JSON.stringify({title:current.title,note:current.note,acceptance:current.acceptance || []}),
      '用户补充：' + change].join('\n');
  }
  global.WorkAutomationBindings = {resolve, candidates, fromContext, validate, refinePrompt, directiveText};
})(window);
