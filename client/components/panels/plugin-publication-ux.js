/* Publication progress and immutable-version upgrade consent for employee plugins. */
(function (global) {
  'use strict';

  function h(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function progress(item) {
    const row = item || {};
    const proof = row.provenance || {};
    const quality = row.qualitySummary || {};
    const approved = row.trustState === 'approved' && row.enabled;
    const rejected = row.reviewDecision === 'reject';
    const revoked = row.trustState === 'revoked' || row.reviewDecision === 'revoke';
    let identity = {
      label: '发布身份', detail: '等待管理员核对来源', state: 'waiting'
    };
    if (proof.signatureState === 'verified' || proof.signatureState === 'platform') {
      identity = { label: '发布身份', detail: '签名和来源已验证', state: 'done' };
    } else if (proof.signatureState === 'unknown-key') {
      identity.detail = '等待登记本机发布公钥';
    } else if (approved) {
      identity = { label: '发布身份', detail: '管理员已人工核对来源', state: 'done' };
    }
    let evaluation = {
      label: '发布评测', detail: quality.message || '尚未声明代表性评测', state: 'waiting'
    };
    if (quality.verified) {
      evaluation.state = 'done';
    } else if (!Number(quality.caseCount || 0)) {
      evaluation.state = approved ? 'warn' : 'waiting';
      evaluation.detail = approved
        ? '管理员已确认无代表性评测的风险'
        : '尚未声明代表性发布评测';
    }
    const review = rejected
      ? { label: '管理员审核', detail: '已退回修改', state: 'bad' }
      : revoked
        ? { label: '管理员审核', detail: '已撤销版本', state: 'bad' }
        : approved
          ? { label: '管理员审核', detail: '已批准当前不可变版本', state: 'done' }
          : { label: '管理员审核', detail: '等待管理员给出结论', state: 'waiting' };
    const taskOnly = (row.marketPolicy || {}).installation === 'not_available';
    const available = approved && (row.catalogReady || (taskOnly && row.bindingCount > 0))
      ? { label: '企业目录', detail: taskOnly
          ? '已配置需求与自动化使用范围，不开放个人安装'
          : '已上架，可按选定范围安装使用', state: 'done' }
      : approved
        ? { label: '企业目录', detail: taskOnly
            ? '仅供需求与自动化使用，等待管理员配置使用范围'
            : '已批准，等待管理员开放目录', state: 'waiting' }
        : { label: '企业目录', detail: '审核通过后按选定范围开放', state: 'waiting' };
    // Match the Hub's internal-light review contract. Unknown/legacy scope
    // stays strict; signing checks remain part of the administrator's review.
    const internal = row.reviewMode === 'internal-light' ||
      (row.reviewMode !== 'platform-strict' && row.scope === 'organization');
    if (internal) {
      const internalReview = Object.assign({}, review);
      if (!approved && !rejected && !revoked) {
        internalReview.detail = proof.signatureState === 'unknown-key'
          ? '等待管理员核对发布身份并审核，无需重新上传'
          : '等待管理员审核当前版本与使用范围';
      }
      return [
        { label: '提交成功', detail: '当前版本与随包资源已保存', state: 'done' },
        internalReview,
        Object.assign({}, available, { label: '开放使用' }),
      ];
    }
    return [
      { label: '隔离入库', detail: '不可变版本已固定', state: 'done' },
      identity, evaluation, review, available,
    ];
  }

  function currentStep(item) {
    const steps = progress(item);
    return steps.find(function (step) { return step.state === 'bad'; }) ||
      steps.find(function (step) { return step.state !== 'done'; }) ||
      steps[steps.length - 1] || { label: '发布链已完成', detail: '当前版本已经可以按范围使用', state: 'done' };
  }

  function currentStepHtml(item) {
    const step = currentStep(item);
    const stateLabel = step.state === 'bad' ? '需要修改' :
      step.state === 'warn' ? '需要关注' :
        step.state === 'done' ? '已完成' : '等待处理';
    return '<section class="cap-publication-current is-' + h(step.state) + '">' +
      "<span><small>当前节点</small><b>" + h(step.label) + '</b></span>' +
      '<em>' + stateLabel + '</em><p>' + h(step.detail) + '</p></section>';
  }

  function levelInfo(level) {
    return ({
      safe: ['兼容升级', 'safe'],
      review: ['需要复核', 'review'],
      breaking: ['破坏性变化', 'breaking'],
    })[level] || ['需要确认', 'review'];
  }

  function openUpgrade(item, ctx, onConfirm) {
    const impact = item && item.upgradeImpact || {};
    const info = levelInfo(impact.level);
    const fromVersion = impact.fromVersion || item.installedVersion || '旧版本';
    const toVersion = impact.toVersion || item.version || '新版本';
    const changes = Array.isArray(impact.changes) ? impact.changes : [];
    const needsConsent = impact.level === 'review' || impact.level === 'breaking';
    const changeRows = changes.length
      ? changes.slice(0, 20).map(function (change) {
          const level = levelInfo(change.level);
          return '<li><i class="' + h(level[1]) + '"></i><span>' +
            h(change.message || '能力契约发生变化') + '</span></li>';
        }).join('')
      : '<li class="is-empty"><span>未检测到权限、调用入口或交付契约的破坏性变化。</span></li>';
    const consent = needsConsent
      ? '<label class="cap-upgrade-confirm"><input type="checkbox" id="capUpgradeConsent">' +
        '<span>我已查看上述变化，同意将个人工具箱升级到这个不可变版本。</span></label>'
      : '<p class="cap-upgrade-safe-note">系统已完成兼容性核对；点击确认后，仅更新你的个人对话工具箱。</p>';
    const layer = ctx.openModal(
      '确认插件升级',
      String(item.name || '企业插件') + ' · v' + String(fromVersion) +
      ' → v' + String(toVersion),
      '<div class="cap-upgrade-head"><span class="cap-upgrade-level ' + h(info[1]) + '">' +
      h(info[0]) + '</span><div><b>升级影响</b><p>' +
      h(impact.summary || '请确认新版能力、权限和工作流契约后再升级。') +
      '</p></div></div><section class="cap-upgrade-changes"><b>本次变化</b><ul>' +
      changeRows + '</ul></section>' + consent,
      '<button class="btn-mini" id="capUpgradeCancel">取消</button><span class="push"></span>' +
      '<button class="btn-mini primary" id="capUpgradeConfirm"' +
      (needsConsent ? ' disabled' : '') + '>确认升级</button>'
    );
    const cancel = layer.querySelector('#capUpgradeCancel');
    const confirm = layer.querySelector('#capUpgradeConfirm');
    const checkbox = layer.querySelector('#capUpgradeConsent');
    cancel.addEventListener('click', ctx.closeModal);
    if (checkbox) checkbox.addEventListener('change', function () {
      confirm.disabled = !this.checked;
    });
    confirm.addEventListener('click', async function () {
      if (needsConsent && (!checkbox || !checkbox.checked)) return;
      this.disabled = true;
      this.textContent = '正在升级…';
      try {
        const done = await onConfirm(this);
        if (done === false) {
          this.disabled = needsConsent && !checkbox.checked;
          this.textContent = '确认升级';
        }
      } catch (error) {
        this.disabled = needsConsent && !checkbox.checked;
        this.textContent = '确认升级';
        ctx.say(ctx.errorText(error, '插件没有升级成功'));
      }
    });
    return layer;
  }

  function submissionStrip(rows, trustName) {
    if (!rows.length) return '';
    return '<section class="cap-plugin-submissions"><div><b>我的提交</b><span>查看审核进度；通过后按所选范围开放</span></div>' +
      '<div class="cap-submission-list">' + rows.slice(0, 5).map(function (item) {
        const state = trustName(item.trustState, item.enabled, item.reviewDecision);
        const progress = global.SoduWorkPluginPublication.progress(item);
        const done = progress.filter(function (step) { return step.state === 'done'; }).length;
        const next = currentStep(item);
        return '<button type="button" class="cap-submission" data-submission="' +
          h(item.pluginId) + "\"><span><b data-user-content>" + h(item.name) + '</b><small>v' +
          h(item.version) + '</small></span><i class="' + state[1] + '">' +
          state[0] + '</i><small class="cap-submission-stage">' + done + '/' + progress.length + ' · ' +
          h(next.label) + '</small>' +
          (item.reviewNote ? '<em class="cap-submission-note">' +
            h(item.reviewNote) + '</em>' : '') + '</button>';
      }).join('') + '</div></section>';
  }

  function openSubmission(item, ctx, options) {
    const opts = options || {};
    const catalog = { items: opts.items || [] };
    const trustName = opts.trustName;
    const sourceName = opts.sourceName;
    const choosePackage = opts.choosePackage;
    const openDetail = opts.openDetail;
    if (!item) return;
    const state = trustName(item.trustState, item.enabled, item.reviewDecision);
    const progress = global.SoduWorkPluginPublication.progress(item);
    const proof = item.provenance || {};
    const proofText = proof.signatureState === 'verified' ? ['签名已验证', '平台已确认这是登记发布者签出的原始版本'] :
      proof.signatureState === 'unknown-key' ? ['发布身份待登记', '管理员登记本机公钥后才能发布；不需要重新上传'] :
        proof.signatureState === 'platform' ? ['平台来源', '由 SoduWork 平台内置并校验'] : ['普通隔离审查', '这个版本没有发布者签名，需要管理员人工核对来源'];
    const rejected = item.reviewDecision === 'reject';
    const local = (catalog.items || []).find(function (candidate) {
      return candidate.personal && !candidate.builtIn &&
        ((item.key && candidate.key === item.key) || candidate.name === item.name);
    });
    const scope = item.visibility === 'users' ? '指定 ' + Number(item.audienceCount || 0) + ' 人' :
      item.visibility === 'org_units' ? '指定 ' + Number(item.audienceCount || 0) + ' 个团队' :
      '全公司';
    const reviewed = item.reviewedAt ?
      new Date(item.reviewedAt).toLocaleString() : '等待管理员处理';
    const feedback = item.reviewNote ||
      (item.reviewDecision === 'approve' ? '管理员已通过这个版本。' :
        item.reviewDecision === 'revoke' ? '管理员已撤销这个版本。' :
          '管理员还没有给出审查结论。');
    const recovery = rejected
      ? local
        ? '<p class="cap-governance-note"><b>下一步</b>打开本机个人插件，使用 SoduWork 按反馈改进；确认改进后重新提交会生成新的不可变版本，原审查记录保留。</p>'
        : '<p class="cap-governance-note"><b>当前设备没有对应的个人插件。</b>重新导入源包后再按反馈修改，不能直接覆盖已提交版本。</p>'
      : '';
    const layer = ctx.openModal('企业发布进度', item.name + ' · v' + item.version,
      '<div class="cap-submission-detail"><span class="' + state[1] + '">' +
      state[0] + "</span><div><b data-user-content>" + h(item.name) + '</b><small>' +
      h(scope) + ' · ' + h(sourceName(item.sourceKind)) + '</small></div></div>' +
      currentStepHtml(item) +
      '<ol class="cap-publication-progress" style="--cap-publication-steps:' + progress.length + '">' + progress.map(function (step) {
        return '<li class="is-' + h(step.state) + "\"><i></i><span><b>" +
          h(step.label) + '</b><small>' + h(step.detail) +
          '</small></span></li>';
      }).join('') + '</ol>' +
      '<section class="cap-submission-proof"><b>' + h(proofText[0]) + '</b><span>' +
      h(proofText[1]) + '</span>' + (proof.signatureKeyId ? '<code>' +
      h(proof.signatureKeyId) + '</code>' : '') + '</section>' +
      '<section class="cap-review-feedback"><b>' +
      (rejected ? '管理员修改要求' : '最近审查结论') + '</b><p>' +
      h(feedback) + '</p><small>' + h(item.reviewedBy || '企业插件管理员') +
      ' · ' + h(reviewed) + '</small></section>' + recovery,
      '<button class="btn-mini" id="capSubmissionClose">' + (opts.onBack ? '返回我的申请' : '关闭') + '</button><span class="push"></span>' +
      (rejected ? local
        ? '<button class="btn-mini primary" id="capSubmissionImprove">打开个人插件继续改进</button>'
        : '<button class="btn-mini primary" id="capSubmissionImport">重新导入源包</button>'
        : ''));
    layer.querySelector('#capSubmissionClose').addEventListener('click', opts.onBack || ctx.closeModal);
    if (global.SoduWorkPluginPresentation) global.SoduWorkPluginPresentation.dialog(layer, ctx);
    const improve = layer.querySelector('#capSubmissionImprove');
    if (improve) improve.addEventListener('click', function () {
      ctx.closeModal();
      if (typeof openDetail === 'function') openDetail(local, ctx);
    });
    const importButton = layer.querySelector('#capSubmissionImport');
    if (importButton) importButton.addEventListener('click', function () {
      ctx.closeModal();
      choosePackage(ctx);
    });
    return layer;
  }

  async function openPersonalPublish(item, ctx, options) {
    const opts = options || {};
    const SoduWorkAPI = opts.api || global.SoduWorkAPI;
    const copyText = opts.copyText;
    const load = opts.load;
    const [detailResult, peopleResult, publisherResult] = await Promise.all([
      SoduWorkAPI.personalPlugin(item.pluginId), SoduWorkAPI.pluginAudienceCandidates(),
      SoduWorkAPI.personalPluginPublisherIdentity(),
    ]);
    if (opts.isCurrent && !opts.isCurrent()) return;
    const detail = detailResult && detailResult.plugin || {};
    let draft = detail.localDraft || {};
    const application = opts.application === true || draft.template === 'app';
    const appCategories = [['office','工具办公'],['game','小游戏'],['robot','机器人'],['other','其他']];
    const publisher = publisherResult && publisherResult.identity || {};
    const authorName = draft.author || detail.authorName || item.authorName || publisher.displayName || publisher.name || '\u0053odo \u4e2a\u4eba\u4f5c\u8005';
    const people = (peopleResult && peopleResult.items || []).slice(0, 500);
    const orgUnits = (peopleResult && peopleResult.orgUnits || []).slice(0, 500);
    if (!draft.name || !draft.version) throw new Error(application ? '应用版本不完整，请重新安装后再提交审核' : '个人插件版本不完整，请重新安装后再上传');
    const layer = ctx.openModal(opts.application ? '申请上架' : '上传到企业', item.name + ' · v' + item.version,
      (global.SoduWorkPluginMakerUtils ? global.SoduWorkPluginMakerUtils.resourceMarkup(draft.resources) : '') +
      '<section class="cap-publish-summary"><span><small>\u63d0\u4ea4\u7248\u672c</small><b>' + h(draft.name) + ' \u00b7 v' + h(draft.version) + '</b></span><span><small>' + (draft.template === 'app' ? '开发者' : '作者') + '</small><b>' + h(authorName) + '</b></span></section>' +
      (draft.template === 'app' ? '<label class="cap-field"><span>即用分类</span><select class="cap-select" id="capPublishAppCategory">' + appCategories.map(([id,label]) => '<option value="' + id + '"' + (id === (draft.appCategory || 'other') ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></label>' : '') +
      (draft.template === 'app' ? '<p class="cap-governance-note">修改分类会保存为新版本；提交后由管理员审核，按所选范围开放。</p>' : '<p class="cap-governance-note"><b>本地版本不会改变。</b>上传的是当前不可变快照，先进入企业隔离区；管理员审核发布后，才按下面的范围可用。</p>') +
      '<section class="cap-publisher-proof"><span><b>本机发布身份</b><em>私钥由系统安全存储保护，只上传签名与公钥</em>' +
        '<code title="' + h(publisher.fingerprint || '') + '">' + h(publisher.keyId || '') +
        ' · ' + h(String(publisher.fingerprint || '').slice(0, 16)) + '…</code></span>' +
        '<button class="btn-mini" id="capCopyPublisher">复制登记信息</button></section>' +
      '<div class="cap-audience-options">' +
        '<label class="on"><input type="radio" name="capAudience" value="organization" checked><span><b>全公司</b><em>审核发布后，全体成员可发现和使用</em></span></label>' +
        '<label><input type="radio" name="capAudience" value="users"><span><b>指定人员</b><em>只有选中的成员可以发现和使用</em></span></label>' +
        '<label><input type="radio" name="capAudience" value="org_units"><span><b>团队 / 部门</b><em>所选部门及其下级团队成员可使用</em></span></label>' +
      '</div><section class="cap-audience-people" id="capAudiencePeople" hidden>' +
        '<input class="cap-input" id="capAudienceSearch" placeholder="搜索姓名、账号或部门">' +
        '<div class="cap-audience-list" id="capAudienceList">' + people.map(function (person) {
          return '<label data-person-search="' +
            h((person.name + ' ' + person.username + ' ' + (person.orgPath || '')).toLowerCase()) + '">' +
            '<input type="checkbox" value="' + h(person.id) + "\"><span><b data-user-content>" + h(person.name) +
            '</b><em>' + h(person.username + (person.orgPath ? ' · ' + person.orgPath : '')) +
            '</em></span></label>';
        }).join('') + '</div>' +
        (!people.length ? '<p class="cap-audience-empty">当前组织还没有可选成员。</p>' : '') +
      '<p class="cap-audience-count" id="capAudienceCount">\u5168\u516c\u53f8\u53ef\u7528</p>' +
      '</section><section class="cap-audience-people" id="capAudienceUnits" hidden>' +
        '<input class="cap-input" id="capAudienceUnitSearch" placeholder="搜索团队或部门">' +
        '<div class="cap-audience-list" id="capAudienceUnitList">' + orgUnits.map(function (unit) {
          return '<label data-unit-search="' + h((unit.path || unit.name).toLowerCase()) + '">' +
            '<input type="checkbox" value="' + h(unit.id) + "\"><span><b data-user-content>" + h(unit.name) +
            '</b><em>' + h(unit.path || unit.name) + '</em></span></label>';
        }).join('') + '</div>' +
        (!orgUnits.length ? '<p class="cap-audience-empty">当前组织还没有可选团队。</p>' : '') +
      '</section>',
      '<button class="btn-mini" id="capPublishCancel">取消</button><span class="push"></span>' +
      '<button class="btn-mini primary" id="capPublishDo">提交审核</button>');
    const peopleBox = layer.querySelector('#capAudiencePeople');
    const unitBox = layer.querySelector('#capAudienceUnits');
    layer.querySelector('#capCopyPublisher').addEventListener('click', async function () {
      const registration = JSON.stringify({
        publisherName: 'SoduWork 个人发布者', keyId: publisher.keyId,
        publicKey: publisher.publicKey, fingerprint: publisher.fingerprint,
      }, null, 2);
      const ok = await copyText(registration);
      this.textContent = ok ? '已复制' : '复制失败';
      setTimeout(() => { this.textContent = '复制登记信息'; }, 1200);
    });
    layer.querySelectorAll('input[name="capAudience"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        layer.querySelectorAll('.cap-audience-options>label').forEach(function (label) {
          label.classList.toggle('on', Boolean(label.querySelector('input:checked')));
        });
        const mode = layer.querySelector('input[name="capAudience"]:checked').value;
        peopleBox.hidden = mode !== 'users';
        unitBox.hidden = mode !== 'org_units';
        updateAudienceSummary();
      });
    });
    function updateAudienceSummary() {
      const mode = layer.querySelector('input[name="capAudience"]:checked').value;
      const count = mode === 'users'
        ? layer.querySelectorAll('#capAudienceList input:checked').length
        : mode === 'org_units'
          ? layer.querySelectorAll('#capAudienceUnitList input:checked').length
          : 0;
      const summary = layer.querySelector('#capAudienceCount');
      if (summary) summary.textContent = mode === 'organization'
        ? '\u5168\u516c\u53f8\u53ef\u7528'
        : (mode === 'users' ? '\u5df2\u9009\u62e9 ' : '\u5df2\u9009\u62e9 ') + count + (mode === 'users' ? '\u4f4d\u6210\u5458' : '\u4e2a\u56e2\u961f/\u90e8\u95e8');
    }
    layer.querySelectorAll('#capAudienceList input, #capAudienceUnitList input').forEach(function (input) {
      input.addEventListener('change', updateAudienceSummary);
    });
    const search = layer.querySelector('#capAudienceSearch');
    if (search) search.addEventListener('input', function () {
      const query = search.value.trim().toLowerCase();
      layer.querySelectorAll('[data-person-search]').forEach(function (row) {
        row.hidden = Boolean(query) && !row.dataset.personSearch.includes(query);
      });
    });
    const unitSearch = layer.querySelector('#capAudienceUnitSearch');
    if (unitSearch) unitSearch.addEventListener('input', function () {
      const query = unitSearch.value.trim().toLowerCase();
      layer.querySelectorAll('[data-unit-search]').forEach(function (row) {
        row.hidden = Boolean(query) && !row.dataset.unitSearch.includes(query);
      });
    });
    layer.querySelector('#capPublishCancel').addEventListener('click', ctx.closeModal);
    layer.querySelector('#capPublishDo').addEventListener('click', async function () {
      const current = () => (!opts.isCurrent || opts.isCurrent()) && !layer.hidden && layer.querySelector('#capPublishDo') === this;
      if (!current()) return;
      const mode = layer.querySelector('input[name="capAudience"]:checked').value;
      const userIds = mode === 'users' ? [...layer.querySelectorAll('#capAudienceList input:checked')].map(x => x.value) : [];
      const orgUnitIds = mode === 'org_units' ?
        [...layer.querySelectorAll('#capAudienceUnitList input:checked')].map(x => x.value) : [];
      if (mode === 'users' && !userIds.length) { ctx.say(application ? '至少选择一位可以使用应用的成员' : '至少选择一位可以使用插件的成员'); return; }
      if (mode === 'org_units' && !orgUnitIds.length) { ctx.say(application ? '至少选择一个可以使用应用的团队或部门' : '至少选择一个可以使用插件的团队或部门'); return; }
      this.disabled = true; this.textContent = '正在上传…';
      const categoryControl=layer.querySelector('#capPublishAppCategory');if(categoryControl)categoryControl.disabled=true;
      try {
        const category = layer.querySelector('#capPublishAppCategory');
        if (category && draft.appCategory !== category.value) {
          const saved = await global.soduWorkAPI.personalPlugins.updateMetadata(item.pluginId,{author:authorName,appCategory:category.value,expectedChecksum:detail.checksum});
          if (!current()) return;
          if (!saved?.ok || !saved.plugin?.localDraft) throw Error(saved?.reason || '即用信息保存失败');
          Object.assign(detail,saved.plugin);Object.assign(item,saved.plugin);draft=saved.plugin.localDraft;
          const summary=layer.querySelector('.cap-publish-summary b');if(summary)summary.textContent=draft.name+' · v'+draft.version;
        }
        const signed = await SoduWorkAPI.signPersonalPluginDraft(draft);
        if (!current()) return;
        const result = await SoduWorkAPI.publishPersonalPlugin(
          draft, mode, userIds, orgUnitIds, signed.signature, signed.identity);
        if (!current()) return;
        const proof = result && result.preview && result.preview.signature || {};
        const message = application ? (proof.state === 'unknown-key'
          ? '应用已签名并提交审核；管理员确认发布身份后可继续审核上架'
          : '应用已提交审核，管理员审核发布后按所选范围可用') : proof.state === 'unknown-key'
          ? '插件已签名并进入隔离区；管理员可在版本审查中核对指纹并一键登记发布身份'
          : (result.message || '插件已使用本机发布身份提交企业审核');
        ctx.closeModal(); ctx.say(message); await load(); ctx.refresh();
      } catch (error) {
        if (!current()) return;
        ctx.say(ctx.errorText(error, application ? '应用没有提交成功' : '插件没有上传成功'));
        if(categoryControl)categoryControl.disabled=false;
        this.disabled = false; this.textContent = '提交审核';
      }
    });
  }

  // Receipts come from the authenticated catalog, never infer a submission from a local click.
  function personalSubmission(item, rows) {
    if (!item?.personal || !item.key || !item.version) return null;
    return (rows || []).filter(row => row.key === item.key && row.version === item.version)
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0] || null;
  }

  async function refreshPersonalSubmission(button, item, options) {
    if (!button) return;
    const opts = options || {}, api = opts.api || global.SoduWorkAPI;
    const scope = api.taskStorageKey?.('plugins');
    const request = button._publicationRead = (button._publicationRead || 0) + 1;
    const current = () => button.isConnected && button._publicationRead === request &&
      scope === api.taskStorageKey?.('plugins') && (!opts.isCurrent || opts.isCurrent());
    button.disabled = true; button.textContent = '正在读取审核状态…';
    try {
      const catalog = await api.pluginCatalog();
      if (!current()) return;
      if (!catalog || catalog.remoteError || catalog.error) throw Error(catalog?.remoteError || catalog?.error || '上架状态暂不可用');
      const receipt = personalSubmission(item, catalog.submissions);
      button.disabled = Boolean(receipt);
      button.textContent = !receipt ? '申请上架' :
        receipt.reviewDecision === 'reject' ? '审核未通过' :
        receipt.trustState === 'revoked' || receipt.reviewDecision === 'revoke' ? '上架已撤销' :
        receipt.trustState === 'approved' ? (receipt.catalogReady ? '已上架' : '审核已通过') : '上架审核中';
      button.title = receipt ? (receipt.reviewNote || currentStep(receipt).detail) : '';
    } catch (error) {
      if (!current()) return;
      button.disabled = true; button.textContent = '上架状态暂不可用';
      button.title = error.message || '请重新打开设置重试';
    }
  }

  global.SoduWorkPluginPublication = {
    progress, currentStep, openUpgrade, submissionStrip, openSubmission, openPersonalPublish,
    personalSubmission, refreshPersonalSubmission,
  };
})(window);
