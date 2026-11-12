import { catalogPlugin, presentPlugin } from '../plugin-locales.js'
import PluginLocalesReview from './PluginLocalesReview.jsx'
import { getLocale, translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { lazy, Suspense } from 'react'
import { can } from '../api.js'
import { Icon } from '../ui.jsx'
import { Capability, PluginAudienceReview, PluginHealth, PluginInvocationActivity, PluginVersionHistory } from './PluginOverviewParts.jsx'
import { CompatibilityNotice, bindingRouteSummary } from './PluginBindingDialog.jsx'
import { PluginCatalogPolicy } from './PluginCatalogPolicy.jsx'
import { NoticeList } from './PluginDialogParts.jsx'
import PluginAccessPolicy from './PluginAccessPolicy.jsx'
import { PluginDistributionStatus } from './PluginDistributionStatus.jsx'
import PluginLifecycleRail from './PluginLifecycleRail.jsx'
import PluginInstallContract from './PluginInstallContract.jsx'
import { pluginKind } from './plugin-catalog-model.js'
import PluginAppTag from './PluginAppTag.jsx'
import PluginRecommendButton from './PluginRecommendButton.jsx'
import PluginCoverPreview from './PluginCoverPreview.jsx'

const WorkflowContractPanel = lazy(() => import('./PluginAuthoring.jsx')
  .then((module) => ({ default: module.WorkflowContractPanel })))
const PluginRolloutPanel = lazy(() => import('./PluginRolloutPanel.jsx'))
const PublicationEvaluationPanel = lazy(() => import('./PluginEvaluationPanel.jsx')
  .then((module) => ({ default: module.PublicationEvaluationPanel })))

const APP_CATEGORY = localeMap(() => ({ office: '工具办公', game: '小游戏', robot: '机器人', other: '其他' }))
const SOURCE = localeMap(() => ({ builtin: 'SoduWork 内置', soduwork: 'SoduWork 原生', adapter: '兼容导入', codex: 'Codex', claude: 'Claude' }))
const NODE = localeMap(() => ({ ai: 'AI 执行', ai_review: 'AI 代码审查', spec: '需求定版', quality: '质量门禁', validate: '制品校验', human_review: '人工验收', approval: '发布审批', merge: '代码合并', condition: '条件判断', deploy: '环境发布', deploy_chain: '发布链', publish: '交付完成', script: '受信脚本', tool: '工具调用' }))
const RUN = localeMap(() => ({ running: '运行中', dispatching: '正在派发', queued: '排队中', waiting_human: '等待人工', waiting_external: '等待环境', rework: '返修中', succeeded: '已完成', failed: '运行失败', skipped: '已跳过', cancelled: '已取消' }))
const fmt = (ms) => ms ? new Date(ms).toLocaleString(getLocale(), { hour12: false }) : '—'

export default function PluginDetailWorkspace({
  plugin, version, section, runs = [], evaluationData, audienceData,
  busy, evaluationBusy, actions, issues = [], categoryRevision = 0,
}) {
  const uiLocale = useLocale();
  plugin = catalogPlugin(plugin, uiLocale, version);
  version = { ...version, manifest: presentPlugin(version.manifest, uiLocale) };
  const capabilities = version.capabilities || {}
  const hasWorkflow = capabilities.hasWorkflow !== false &&
    (capabilities.executionMode === 'workflow' || (((version.workflow || {}).nodes || []).length > 0))
  const entrypoints = (version.manifest || {}).entrypoints || capabilities.entrypoints || {}
  const provenance = version.provenance || {}
  const pluginRuns = runs.filter((item) => item.pluginId === plugin.id)
  const bindings = plugin.bindings || []
  const activeBindings = bindings.filter((item) => item.enabled && item.versionId === version.id)
  const approved = Boolean(plugin.enabled && version.trustState === 'approved' && version.enabled)
  const canManage = can('plugin.manage')
  const internalReview = Boolean(plugin.orgId)
  const canRun = can('plugin.run') && approved
  const primary = section === 'versions' && version.trustState === 'quarantined' ? null : version.trustState === 'quarantined' && canManage
    ? { label: tx("审核上架"), icon: 'shield', run: () => actions.selectSection('versions') }
    : approved && hasWorkflow && activeBindings.length === 0
      ? { label: tx("配置使用范围"), icon: 'link', run: () => actions.selectSection('settings') }
      : canRun ? { label: tx("用于需求"), icon: 'send', run: actions.startRun } : null
  const releaseState = pluginReleaseState({ plugin, version, evaluationData, approved, activeBindings, internalReview })

  return <>
    <PluginLocalesReview manifest={version.manifest} />
    <header className="plugin-titlebar plugin-titlebar-v3">
      <span className="plugin-logo plugin-logo-v2"><Icon name={pluginKind({ latestVersion: version }).icon} /></span>
      <div className="plugin-title-copy">
        <span className="plugin-title-kicker">{plugin.orgId ? tx("企业提交") : SOURCE[plugin.sourceKind] || tx("第三方插件")} · {provenance.publisherName || tx("未知发布者")} · v{version.version}</span>
        <h3 className="plugin-app-heading">{plugin.name}<PluginAppTag version={version} /></h3><p>{plugin.description || tx("尚未补充用途说明。")}</p>
        <div className="plugin-title-meta">
          {(version.process || {}).enterprise && <span className="enterprise-flow">{version.process.label || tx("企业流程")}</span>}
          <span>{audienceText(version)}</span>
          {version.manifest?.template === 'app' && <>
            <span>{tx('开发者')} · {version.manifest.author || tx('未填写')}</span>
            <span>{tx('即用分类')} · {APP_CATEGORY[version.manifest.appCategory] || APP_CATEGORY.other}</span>
          </>}
        </div>
      </div>
      {(plugin.catalogPolicy?.featured || canManage) && <div className={'plugin-title-cover' + (plugin.catalogPolicy?.featured ? ' plugin-featured-cover' : '')}>
        {plugin.catalogPolicy?.featured && <PluginCoverPreview url={plugin.catalogPolicy.coverUrl || version.manifest?.coverUrl || plugin.latestVersion?.manifest?.coverUrl || ''} />}
        {canManage && <div className="plugin-cover-actions"><PluginRecommendButton plugin={plugin} version={version} disabled={Boolean(busy)}
          onChanged={(_id, policy) => actions.catalogPolicyChanged?.(policy)} onOpenChanged={actions.recommendationOpenChanged} /></div>}
      </div>}
      <div className="plugin-title-aside">
        <div className={'plugin-title-state tone-' + releaseState.tone}>
          <small>{tx("当前状态")}</small><b><i />{releaseState.label}</b><span>{releaseState.detail}</span>
        </div>
        <div className="plugin-title-actions">
          {primary && <button className="btn btn-primary" onClick={primary.run}><Icon name={primary.icon} />{primary.label}</button>}
        </div>
      </div>
    </header>

    <nav className="plugin-detail-tabs" aria-label={tx("插件详情")}>
      <DetailTab value="overview" current={section} icon="file" label={tx("插件说明")} onSelect={actions.selectSection} />
      <DetailTab value="versions" current={section} icon="shield" label={tx("审核与版本")} onSelect={actions.selectSection} />
      <DetailTab value="settings" current={section} icon="settings" label={tx("使用配置")} onSelect={actions.selectSection} />
      <DetailTab value="runs" current={section} icon="activity" label={tx("运行记录")} onSelect={actions.selectSection} />
    </nav>

    {section === 'overview' && <div className="plugin-detail-panel plugin-overview-panel">
      <PluginDescription plugin={plugin} version={version} entrypoints={entrypoints} approved={approved} />
      {issues.length > 0 && <details className="plugin-contract-disclosure">
        <summary>{tx("待处理事项 · ")}{issues.length}</summary>
        <div className="plugin-contract-disclosure-body plugin-issue-list">{issues.map((item, index) =>
          <button key={item.id || index} type="button" onClick={() => actions.openIssue(item)}><Icon name="alert" />
            <span>{[item.title, item.reason, item.label].find((value) => typeof value === 'string' && value) || tx("查看待处理事项")}</span><Icon name="chevron" /></button>)}</div>
      </details>}
      <details className="plugin-contract-disclosure"><summary>{tx("技能、连接与权限清单")}</summary>
        <div className="plugin-contract-disclosure-body"><CapabilitySummary version={version} hasWorkflow={hasWorkflow} /></div>
      </details>
    </div>}

    {section === 'versions' && <div className="plugin-detail-panel plugin-release-panel">
      {!internalReview && <PluginLifecycleRail version={version} evaluationData={evaluationData} bindings={bindings}
        runs={pluginRuns} onNavigate={(target) => actions.selectSection(['bindings', 'blueprint'].includes(target) ? 'settings' : target)} />}
      {version.trustState === 'quarantined' && canManage && <ReviewCallout plugin={plugin} version={version}
        provenance={provenance} busy={busy} actions={actions} />}
      <PluginInstallContract version={version} />
      <details className="plugin-contract-disclosure"><summary>{tx("版本记录与回退 · ")}{(plugin.versions || []).length}{tx(" 个版本")}</summary>
      <div className="plugin-contract-disclosure-body"><PluginVersionHistory plugin={plugin} selectedId={version.id} busy={busy} canManage={canManage}
        onSelect={actions.selectVersion} onSimulate={actions.simulateVersion}
        onEnable={(item) => { actions.selectVersion(item.id); actions.trust(item, true) }}
        onReject={(item) => { actions.selectVersion(item.id); actions.risk({ kind: 'reject-version', version: item, pluginName: plugin.name }) }}
        onRevoke={(item) => { actions.selectVersion(item.id); actions.risk({ kind: 'revoke-version', version: item, pluginName: plugin.name, bindingCount: bindings.filter((row) => row.versionId === item.id && row.enabled).length }) }} /></div></details>
      {canManage && !internalReview && <Suspense fallback={null}>
        <PublicationEvaluationPanel version={version} data={evaluationData} busy={evaluationBusy}
          onStart={(caseItem, options) => actions.startEvaluation(version, caseItem, options)}
          onReview={(run, decision, note) => actions.reviewEvaluation(version, run, decision, note)}
          onCancel={(run) => actions.cancelEvaluation(version, run)} />
        <details className="plugin-contract-disclosure"><summary>{tx("需求绑定的版本切换与回滚")}</summary>
          <div className="plugin-contract-disclosure-body"><PluginRolloutPanel plugin={plugin} version={version} onChanged={actions.rolloutChanged} /></div>
        </details>
      </Suspense>}
      {(capabilities.adapterWarnings || []).length > 0 && <NoticeList tone="warn" title={tx("适配说明")} items={capabilities.adapterWarnings} />}
      {version.compatibility && !['initial', 'current'].includes(version.compatibility.level) && <CompatibilityNotice data={version.compatibility} />}
    </div>}

    {section === 'settings' && <div className="plugin-detail-panel plugin-settings-panel">
      <section className="plugin-settings-intro">
        <span><Icon name="link" /></span><div><b>{tx("员工使用与需求执行分别配置")}</b><p>{tx("普通插件审核后按目录策略供员工安装；企业工作流需要执行时，再关联项目、环境和执行配置。")}</p></div>
      </section>
      {canManage && <PluginAccessPolicy key={plugin.id} pluginId={plugin.id} disabled={Boolean(busy)} />}
      <PluginCatalogPolicy pluginId={plugin.id} value={plugin.catalogPolicy} capabilities={capabilities}
        canManage={canManage} disabled={Boolean(busy)} categoryRevision={categoryRevision}
        onChanged={actions.catalogPolicyChanged} />
      <BindingList bindings={bindings} versions={plugin.versions || []} canManage={canManage}
        busy={busy} onOpen={actions.openBinding} onToggle={actions.toggleBinding} />
      {canManage && ['users', 'org_units'].includes(version.visibility) &&
        <PluginAudienceReview data={audienceData} onRetry={() => actions.reloadAudience(version.id)} />}
      <details className="plugin-contract-disclosure">
        <summary><span><Icon name="settings" /><span><b>{tx("查看版本能力与执行节点")}</b><small>{tx("面向插件开发者和故障排查人员的技术信息")}</small></span></span><em>{tx("高级")}</em></summary>
        <div className="plugin-contract-disclosure-body">
          <CapabilitySummary version={version} hasWorkflow={hasWorkflow} />
          <Blueprint version={version} hasWorkflow={hasWorkflow} entrypoints={entrypoints} capabilities={capabilities} />
        </div>
      </details>
      <details className="plugin-contract-disclosure"><summary>{tx("查看上架与需求开放状态")}</summary><div className="plugin-contract-disclosure-body">
        <PluginDistributionStatus plugin={plugin} version={version} evaluationData={evaluationData} audienceData={audienceData} lightweight={internalReview} />
      </div></details>
    </div>}

    {section === 'runs' && <div className="plugin-detail-panel plugin-runs-panel">
      <RunList runs={pluginRuns} onOpen={actions.openRun} />
      {plugin.health?.runs > 0 && <PluginHealth data={plugin.health} />}
      {canManage && <details className="plugin-contract-disclosure"><summary>{tx("管理操作与连接调用审计")}</summary>
        <div className="plugin-contract-disclosure-body"><PluginInvocationActivity plugin={plugin} /></div>
      </details>}
    </div>}
  </>
}

function PluginDescription({ plugin, version, entrypoints, approved }) {
  const uiLocale = useLocale();
  const cap = version.capabilities || {}
  const nodes = version.workflow?.nodes || []
  const entries = [
    entrypoints.conversation !== false && { name: tx("对话中使用"), icon: 'webhook', note: tx("在客户端选择插件，直接描述要完成的工作。") },
    entrypoints.task !== false && { name: tx("用于需求执行"), icon: 'send', note: tx("正式需求按授权和使用范围调用。") },
    entrypoints.automation && { name: tx("自动化"), icon: 'refresh', note: tx("使用同一插件配置定时或触发执行。") },
  ].filter(Boolean)
  return <>
    <section className="plugin-description-section"><h4>{tx("使用方式")}</h4>
      {!approved && <p>{tx("以下是版本声明的入口，审核通过后才能使用。")}</p>}
      <div className="plugin-entry-list">{entries.map((item) => <div key={item.name}><Icon name={item.icon} /><b>{item.name}</b><small>{item.note}</small></div>)}</div>
      {!entries.length && <p>{tx("这个版本尚未声明可用入口。")}</p>}
    </section>
    {nodes.length > 0 && <section className="plugin-description-section"><h4>{tx("工作流 · ")}{nodes.length}{tx(" 个步骤")}</h4>
      <p>{nodes.map((node) => node.name || node.key).join(' → ')}</p>
    </section>}
    <dl className="plugin-description-facts">
      <div><dt>{tx("随插件使用的技能")}</dt><dd>{(cap.skills || []).join('、') || tx("没有额外技能")}</dd></div>
      <div><dt>{tx("连接工具")}</dt><dd>{(cap.mcpServers || []).join('、') || tx("没有外部连接")}</dd></div>
      <div><dt>{tx("插件标识")}</dt><dd>{plugin.qualifiedKey || plugin.key}</dd></div>
      <div><dt>{tx("发布方式")}</dt><dd>{plugin.orgId ? tx("企业提交 · 一次管理员审核上架") : tx("平台插件 · 评测与发布审查")}</dd></div>
    </dl>
  </>
}

function pluginReleaseState({ plugin, version, evaluationData, approved, activeBindings, internalReview }) {
  const gate = (evaluationData && evaluationData.gate) || version.capabilities?.qualitySummary || {}
  const runs = (evaluationData && evaluationData.items) || []
  const validating = runs.some((item) =>
    ['queued', 'dispatching', 'running', 'waiting_external', 'waiting_human'].includes(item.state))
  const cases = Number(gate.caseCount || 0)
  const ready = Boolean(gate.ok || gate.readyForApproval)
  if (version.trustState === 'revoked') {
    return { tone: 'danger', label: tx("版本已撤销"), detail: tx("员工使用和需求执行都不能再发起调用") }
  }
  if (approved && activeBindings.length) {
    return { tone: 'ready', label: tx("版本已审核"), detail: tx("{0} 个需求范围正在使用这个版本；员工安装按目录策略开放", [activeBindings.length]) }
  }
  if (approved) {
    return plugin.catalogPolicy?.installation === 'not_available'
      ? { tone: 'neutral', label: tx("已审核，未开放安装"), detail: tx("可在使用配置中调整目录策略或关联需求范围") }
      : { tone: 'ready', label: tx("已上架"), detail: tx("员工可按目录策略安装；执行需求前再配置使用范围") }
  }
  if (version.provenance?.signatureState === 'unknown-key') {
    return { tone: 'attention', label: tx("待核对发布身份"), detail: tx("先在审核页确认发布者指纹，再审核上架；不需要重新上传") }
  }
  if (version.provenance?.signatureState === 'revoked-key') {
    return { tone: 'danger', label: tx("发布身份已撤销"), detail: tx("请作者使用有效身份重新签名并提交新版本") }
  }
  if (internalReview) {
    return { tone: 'attention', label: tx("等待管理员审核"), detail: tx("静态预检已完成，审核通过后立即进入员工目录") }
  }
  if (validating) {
    return { tone: 'live', label: tx("正在自动验证"), detail: tx("完成后只需管理员确认一次发布") }
  }
  if (ready) {
    return { tone: 'attention', label: tx("等待发布确认"), detail: tx("{0} 项验证已完成，可以做发布决定", [cases || tx("全部")]) }
  }
  if (cases) {
    return { tone: 'attention', label: tx("验证尚未通过"), detail: tx("查看失败场景，修订版本后重新验证") }
  }
  return { tone: 'neutral', label: tx("等待补齐验证"), detail: tx("先声明代表性场景，再进入企业发布审查") }
}

function DetailTab({ value, current, icon, label, count, onSelect }) {
  const uiLocale = useLocale();
  return <button type="button" className={current === value ? 'on' : ''}
    aria-current={current === value ? 'page' : undefined} onClick={() => onSelect(value)}>
    <Icon name={icon} /><span>{label}</span>{count != null && <b>{count}</b>}
  </button>
}

function CapabilitySummary({ version, hasWorkflow }) {
  const uiLocale = useLocale();
  const cap = version.capabilities || {}
  const provenance = version.provenance || {}
  const sourceProof = provenance.signatureState === 'platform' ? tx("平台来源")
    : provenance.signatureState === 'verified' ? tx("签名有效")
      : provenance.signatureState === 'unknown-key' ? tx("发布者未登记")
        : provenance.signatureState === 'revoked-key' ? tx("发布者密钥已撤销") : tx("未提供签名")
  return <section className="capability-strip capability-strip-v2 plugin-detail-card">
    <header className="capability-summary-head"><span className="eyebrow">{tx("版本契约")}</span>
      <h3>{tx("能力与权限")}</h3><p>{tx("运行时只会获得本版本声明的最小能力。")}</p></header>
    <div className="plugin-capability-grid">
      <Capability icon="shield" label={tx("来源")} value={(provenance.publisherName || tx("未知发布者")) + ' · ' + sourceProof} />
      <Capability icon="sitemap" label={tx("形态")} value={version.manifest?.template === 'app' ? pluginKind({ latestVersion: version }).label : hasWorkflow ? tx("自动化流程") : tx("直接能力")} />
      <Capability icon="sparkle" label="AI" value={(cap.agentKinds || []).join('、') || ((cap.nodeTypes || []).includes('ai') ? tx("自动选择") : tx("不需要"))} />
      <Capability icon="plug" label={tx("技能")} value={(cap.skills || []).join('、') || tx("无")} />
      <Capability icon="link" label={tx("连接器")} value={(cap.mcpServers || []).join('、') || tx("无")} />
      <Capability icon="desktop" label={tx("执行能力")} value={(cap.runtime || []).join('、') || tx("基础执行")} />
      <Capability icon="key" label={tx("密钥")} value={(cap.secrets || []).join('、') || tx("无")} />
    </div>
  </section>
}

function ReviewCallout({ plugin, version, provenance, busy, actions }) {
  const uiLocale = useLocale();
  return <section className="plugin-review-callout">
    <span><Icon name="shield" /></span><div><b>{plugin.orgId ? tx("审核并上架") : tx("平台发布审查")}<PluginAppTag version={version} /></b><p>{provenance.signatureState === 'unknown-key'
      ? tx("先核对发布者指纹并登记可信身份，再完成本次审核。无需让作者重新上传。")
      : provenance.signatureState === 'revoked-key' ? tx("发布身份已撤销，请作者使用有效身份重新签名并提交。")
      : plugin.orgId
      ? tx("客户端制作与试用 → 提交审核 → 管理员审核并上架。静态预检已完成；核对用途、权限与使用范围后确认一次即可。")
      : tx("平台级插件仍需完成代表性评测和严格发布审查。")}</p></div>
      <div>{provenance.signatureState === 'unknown-key' && <button className="btn btn-ghost"
      onClick={() => actions.publisher({ version, pluginName: plugin.name })}>{tx("核对发布者")}</button>}
      <button className="btn btn-ghost" disabled={busy === version.id}
        onClick={() => actions.risk({ kind: 'reject-version', version, pluginName: plugin.name })}>{tx("退回修改")}</button>
      <button className="btn btn-primary" disabled={busy === version.id || ['unknown-key', 'revoked-key'].includes(provenance.signatureState)}
        onClick={() => actions.trust(version, true)}>{busy === version.id ? tx("处理中…") : plugin.orgId ? tx("审核并上架") : tx("审核通过")}</button></div>
  </section>
}

function Blueprint({ version, hasWorkflow, entrypoints, capabilities }) {
  const uiLocale = useLocale();
  const nodes = (version.workflow || {}).nodes || []
  if (!hasWorkflow) return <section className="workflow-map workflow-map-v2 direct-package-map plugin-detail-card">
    <div className="auto-section-head"><div><span className="eyebrow">{tx("调用方式")}</span><h3>{tx("直接能力")}</h3><p>{tx("运行时按需求生成可恢复执行计划，不额外套用固定业务流程。")}</p></div></div>
    <div className="direct-package-components">
      {(capabilities.components || []).filter((item) => item.state !== 'blocked').map((item) => <span key={item.kind}><Icon name={item.kind === 'mcp' ? 'link' : item.kind === 'skills' ? 'sparkle' : 'check'} /><b>{item.label}</b><small>{item.count > 1 ? item.count + tx(" 项") : tx("已包含")}</small></span>)}
      <span><Icon name="send" /><b>{tx("可用入口")}</b><small>{[entrypoints.conversation !== false && tx("对话"), entrypoints.task !== false && tx("需求"), entrypoints.automation && tx("自动化")].filter(Boolean).join(' · ') || tx("未开放")}</small></span>
    </div>
  </section>
  return <><section className="workflow-map workflow-map-v2 plugin-detail-card">
    <div className="auto-section-head"><div><span className="eyebrow">{tx("工作流定义")}</span><h3>{tx("执行节点")}</h3><p>{tx("这里展示当前不可变版本真实保存的节点顺序。")}</p></div><span className="workflow-count">{nodes.length}{tx(" 个节点")}</span></div>
    <WorkflowGraph nodes={nodes} />
  </section><Suspense fallback={null}><WorkflowContractPanel nodes={nodes} /></Suspense></>
}

function BindingList({ bindings, versions, canManage, busy, onOpen, onToggle }) {
  const uiLocale = useLocale();
  return <section className="binding-zone plugin-detail-card"><div className="auto-section-head"><div><span className="eyebrow">{tx("使用范围")}</span><h3>{tx("项目与组织绑定")}</h3><p>{tx("决定这个插件在哪里生效，以及使用哪一版运行配置。")}</p></div>{canManage && <button onClick={() => onOpen()}>{tx("+ 新建绑定")}</button>}</div>
    {!bindings.length && <div className="mini-empty">{tx("还没有绑定。发布完成后，把插件开放给指定项目或组织。")}</div>}
    {bindings.map((binding) => {
      const boundVersion = versions.find((item) => item.id === binding.versionId)
      return <div className={'binding-row ' + (!binding.enabled ? 'disabled' : '')} key={binding.id}>
        <span className="binding-mark"><Icon name="link" /></span><div><b>{binding.projectId ? tx("项目专属绑定") : tx("组织通用绑定")} · v{(boundVersion && boundVersion.version) || '—'}</b><small>{bindingRouteSummary(binding.config)} · {binding.enabled ? tx("已启用") : tx("已停用")}</small></div>
        {canManage && <span className="binding-actions"><button onClick={() => onOpen(binding)}>{tx("配置")}</button><button disabled={busy === 'binding:' + binding.id} onClick={() => onToggle(binding)}>{busy === 'binding:' + binding.id ? tx("体检中…") : binding.enabled ? tx("停用") : tx("启用")}</button></span>}
      </div>
    })}
  </section>
}

function RunList({ runs, onOpen }) {
  const uiLocale = useLocale();
  return <section className="plugin-runs plugin-detail-card"><div className="auto-section-head"><div><span className="eyebrow">{tx("最近执行")}</span><h3>{tx("运行记录")}</h3><p>{tx("只展示真实发生的运行、等待、返修和交付证据。")}</p></div></div>
    {!runs.length && <div className="mini-empty">{tx("还没有运行记录。需求执行或自动化调用插件后会出现在这里。")}</div>}
    {runs.slice(0, 20).map((run) => <button className="plugin-run-row" key={run.id} onClick={() => onOpen(run)}><span className={'run-dot state-' + run.state} /><span><b>{RUN[run.state] || run.state}</b><small>{(run.currentNodes || []).length ? tx("当前：") + run.currentNodes.join('、') : fmt(run.finishedAt || run.createdAt)}</small></span><Icon name="chevron" /></button>)}
  </section>
}

export function WorkflowGraph({ nodes }) {
  const uiLocale = useLocale();
  return <div className="workflow-graph workflow-graph-v2" tabIndex={0} role="region" aria-label={tx("工作流")}>{nodes.map((node, index) => <React.Fragment key={node.key}>{index > 0 && <i className="workflow-arrow"><span>›</span></i>}<div className={'workflow-node type-' + node.type}><span className="node-index">{String(index + 1).padStart(2, '0')}</span><span className="node-icon"><Icon name={nodeIcon(node.type)} /></span><b>{node.name || node.key}</b><small>{NODE[node.type] || node.type}</small></div></React.Fragment>)}</div>
}

function nodeIcon(type) {
  if (type === 'ai' || type === 'ai_review') return 'sparkle'
  if (['deploy', 'deploy_chain'].includes(type)) return 'monitor'
  if (['spec', 'human_review', 'approval'].includes(type)) return 'shield'
  if (type === 'merge') return 'sitemap'
  return 'check'
}

function audienceText(version) {
  if (version.visibility === 'users') return tx("指定 {0} 人", [version.audienceCount || 0])
  if (version.visibility === 'org_units') return tx("指定 {0} 个团队", [version.audienceCount || 0])
  return tx("全公司可见")
}
