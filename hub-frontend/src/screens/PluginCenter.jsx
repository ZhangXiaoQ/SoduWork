import { serverMessage } from '../i18n.js'
import { getLocale, translateText as tx, localeMap, useLocale } from '../i18n.js'
import { catalogPlugin } from '../plugin-locales.js'
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { api, can } from '../api.js'
import { ErrorState, Icon, Loading, Modal, takeNav, toast, SelectMenu } from '../ui.jsx'
import PluginCatalogIndex from './PluginCatalogIndex.jsx'
import PluginCategoryManager from './PluginCategoryManager.jsx'
import PluginDetailDrawer from './PluginDetailDrawer.jsx'
import { pluginIssues } from './plugin-catalog-model.js'
import PluginDetailWorkspace, { WorkflowGraph } from './PluginDetailWorkspace.jsx'
import { LoadIssue } from './PluginOverviewParts.jsx'
import { PluginRiskConfirm } from './PluginReviewDecision.jsx'
import { AgentChoice, BindingForm } from './PluginBindingDialog.jsx'
import { Field, NoticeList } from './PluginDialogParts.jsx'
import { PluginRunForm, RunDrawer } from './PluginRunDialogs.jsx'
import { PluginPublisherCandidate, PluginPublisherKeys } from './PluginPublisherKeys.jsx'
import './plugin-foundation.css'
import './plugin-workshop.css'
import './plugin-import-contract.css'
import './plugin-bulk-import.css'
import './plugin-lifecycle.css'
import './plugin-workshop-dialogs.css'
import './plugin-evaluations.css'
import './plugin-detail-tabs.css'
import './plugin-activity.css'
import './plugin-admin-workspace.css'
import './plugin-admin-detail.css'
import './plugin-admin-polish.css'
import './plugin-unified.css'

const PluginAuthorGuide = lazy(() => import('./PluginAuthoring.jsx').then((x) => ({ default: x.PluginAuthorGuide })))
const fmt = (ms) => ms ? new Date(ms).toLocaleString(getLocale(), { hour12: false }) : '—'

export default function PluginCenter({ setupContext, onNavigate }) {
  const uiLocale = useLocale();
  const [navigation] = useState(() => setupContext || takeNav('plugins'))
  const setupProject = navigation && navigation.target === 'plugin' ? navigation : null
  const [data, setData] = useState(null)
  const [selected, setSelected] = useState('')
  const [detail, setDetail] = useState(null)
  const [runs, setRuns] = useState([])
  const [error, setError] = useState(null)
  const [syncIssue, setSyncIssue] = useState('')
  const [lastSyncedAt, setLastSyncedAt] = useState(0)
  const [detailError, setDetailError] = useState('')
  const [busy, setBusy] = useState('')
  const [recommendationOpen, setRecommendationOpen] = useState(false)
  const [bulkImport, setBulkImport] = useState(null)
  const [simulation, setSimulation] = useState(null)
  const [bindingOpen, setBindingOpen] = useState(false)
  const [bindingEdit, setBindingEdit] = useState(null)
  const [runOpen, setRunOpen] = useState(false)
  const [runDetail, setRunDetail] = useState(null)
  const [guidedDetailsOpen, setGuidedDetailsOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(Boolean(setupProject))
  const [authorOpen, setAuthorOpen] = useState(false)
  const [publishersOpen, setPublishersOpen] = useState(false)
  const [publisherCandidate, setPublisherCandidate] = useState(null)
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false)
  const [catalogCategories, setCatalogCategories] = useState([])
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [categoryRevision, setCategoryRevision] = useState(0)
  const [evaluationData, setEvaluationData] = useState(null)
  const [evaluationBusy, setEvaluationBusy] = useState('')
  const [activeVersionId, setActiveVersionId] = useState('')
  const [audienceData, setAudienceData] = useState(null)
  const [riskConfirm, setRiskConfirm] = useState(null)
  const [riskBusy, setRiskBusy] = useState(false)
  const detailRequest = useRef(0)
  const [governance, setGovernance] = useState(null)
  const [governanceError, setGovernanceError] = useState('')
  const [detailSection, setDetailSection] = useState('overview')
  const requestedDetailSection = useRef('')
  const evaluationRequest = useRef(0)
  const audienceRequest = useRef(0)
  const fileRef = useRef(null)
  const moreMenuRef = useRef(null)

  function closeMoreMenu() {
    if (moreMenuRef.current) moreMenuRef.current.open = false
  }

  async function refreshRuns(quiet = false) {
    try {
      const runData = await api.pluginRuns()
      setRuns(runData.items || [])
      setSyncIssue('')
      setLastSyncedAt(Date.now())
    } catch (e) {
      setSyncIssue(e.message || tx("无法连接插件运行服务"))
      if (!quiet) toast(tx("运行数据刷新失败：") + (e.message || tx("请检查服务连接")))
    }
  }
  async function refreshGovernance(quiet = false) {
    if (!can('plugin.manage') || setupProject) return null
    try {
      const next = await api.pluginGovernance()
      let categoryData = null
      try { categoryData = await api.pluginCategories() } catch (_) {
        // A category read outage must not hide the rest of the governance
        // workspace; the policy editor will show its own retry state.
      }
      setGovernance(next)
      setData(next.items || [])
      setCatalogCategories(Array.isArray(categoryData?.items) ? categoryData.items : [])
      setGovernanceError('')
      return next.items || []
    } catch (e) {
      setGovernanceError(e.message || tx("无法读取插件治理数据"))
      if (!quiet) toast(tx("治理数据刷新失败：") + (e.message || tx("请检查服务连接")))
      return null
    }
  }
  async function load() {
    let items = null
    if (can('plugin.manage') && !setupProject) {
      items = await refreshGovernance(true)
    }
    if (items === null) {
      try {
        const plugins = await api.plugins()
        items = plugins.items || []
      } catch (e) { setError(e); setData(null); return }
    }
    try {
      setData(items)
      setSelected((old) => old || (items[0] && items[0].id) || '')
      setError(null)
    } catch (e) { setError(e); setData(null); return }
    if (detailOpen) await refreshRuns(true)
  }
  async function loadDetail(id) {
    const request = ++detailRequest.current
    if (!id) { setDetail(null); setDetailError(''); setEvaluationData(null); setAudienceData(null); setActiveVersionId(''); return }
    setDetail(null); setDetailError(''); setEvaluationData(null); setAudienceData(null)
    try {
      const next = await api.pluginDetail(id)
      if (request !== detailRequest.current) return
      setDetail(next)
      if (requestedDetailSection.current) {
        setDetailSection(requestedDetailSection.current)
        requestedDetailSection.current = ''
      }
      setActiveVersionId((old) => (next.versions || []).some((x) => x.id === old)
        ? old : (((next.versions || [])[0] || {}).id || ''))
    }
    catch (e) {
      if (request === detailRequest.current) setDetailError(e.message || tx("无法读取插件详情"))
    }
  }
  async function loadEvaluations(versionId, quiet = false) {
    const request = ++evaluationRequest.current
    if (!versionId || !can('plugin.manage') || (detail && detail.orgId)) { setEvaluationData(null); return }
    try {
      const next = await api.pluginEvaluations(versionId)
      if (request === evaluationRequest.current) setEvaluationData(next)
    }
    catch (e) {
      if (request === evaluationRequest.current && !quiet) toast(tx("发布评测加载失败：") + e.message)
    }
  }
  async function loadAudience(versionId) {
    const request = ++audienceRequest.current
    if (!versionId || !can('plugin.manage')) { setAudienceData(null); return }
    const version = detail && (detail.versions || []).find((x) => x.id === versionId)
    if (!version || !['users', 'org_units'].includes(version.visibility)) { setAudienceData(null); return }
    setAudienceData({ loading: true, items: [] })
    try {
      const next = await api.pluginVersionAudience(versionId)
      if (request === audienceRequest.current) setAudienceData(next)
    }
    catch (e) {
      if (request === audienceRequest.current) {
        setAudienceData({ error: e.message || tx("定向成员加载失败"), items: [] })
      }
    }
  }
  useEffect(() => { load() }, [])
  useEffect(() => {
    if (!data || !setupProject) return
    const recommended = pickRecommended(data)
    if (recommended) setSelected(recommended.id)
  }, [data, setupProject && setupProject.projectId])
  useEffect(() => {
    if (detailOpen) loadDetail(selected)
    return () => { detailRequest.current += 1 }
  }, [selected, detailOpen])
  useEffect(() => {
    if (!detailOpen) return undefined
    refreshRuns(true)
    if (detailSection !== 'runs') return undefined
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refreshRuns(true)
    }, 10000)
    return () => clearInterval(timer)
  }, [detailOpen, detailSection])
  const evaluationVersionId = activeVersionId ||
    (detail && detail.versions && detail.versions[0] && detail.versions[0].id)
  const evaluationActive = Boolean(evaluationData && (evaluationData.items || [])
    .some((item) => ['queued', 'running'].includes(item.state)))
  useEffect(() => {
    if (!detailOpen || detailSection !== 'versions') return
    loadEvaluations(evaluationVersionId)
  }, [evaluationVersionId, detailSection, detailOpen])
  useEffect(() => {
    if (detailSection !== 'settings') return
    loadAudience(evaluationVersionId)
  }, [evaluationVersionId, detail, detailSection])
  useEffect(() => {
    if (!detailOpen || !evaluationVersionId || !evaluationActive || detailSection !== 'versions') return undefined
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') loadEvaluations(evaluationVersionId, true)
    }, 3000)
    return () => clearInterval(timer)
  }, [evaluationVersionId, evaluationActive, detailSection, detailOpen])

  async function importFile(file) {
    if (!file) return
    setBusy('import')
    try {
      const out = await api.importPlugin(file)
      toast(out.created ? tx("已提交企业审核，管理员通过后即可上架") : tx("这个不可变版本已经导入过"))
      await load()
      setSelected(out.plugin.id)
      setDetailSection('versions')
      setDetailOpen(true)
      await loadDetail(out.plugin.id)
    } catch (e) { toast(tx("导入失败：") + e.message) }
    setBusy('')
  }
  function chooseBulkFiles() {
    const input = document.createElement('input')
    input.type = 'file'; input.multiple = true; input.accept = '.soduwork-plugin,.soduwork-plugin,.soduwork-plugin,.zip'
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []).slice(0, 30)
      if (files.length) setBulkImport({ files })
    }, { once: true })
    input.click()
  }
  async function confirmBulkImport(options) {
    if (!bulkImport || !(bulkImport.files || []).length) return
    setBusy('bulk-import')
    try {
      const out = await api.bulkImportPlugins(
        bulkImport.files, options.rightsConfirmed, options.sourceLabel)
      await load()
      if (out.failed) {
        setBulkImport((old) => old ? { ...old, result: out } : old)
        toast(tx("已导入 {0} 个，{1} 个需要检查", [out.imported, out.failed]))
      } else {
        setBulkImport(null)
        toast(tx("已导入 {0} 个插件包，等待管理员审核上架", [out.imported]))
      }
    } catch (e) {
      toast(tx("批量导入失败：") + e.message)
    }
    setBusy('')
  }
  async function trust(version, enabled, confirmWithoutEvaluation = false, note = '') {
    setBusy(version.id)
    let saved = false
    try {
      const internalReview = Boolean(detail && detail.orgId)
      if (enabled && !internalReview) {
        const quality = await api.pluginEvaluations(version.id)
        setEvaluationData(quality)
        if ((quality.gate && quality.gate.caseCount) &&
            !quality.gate.ok && !quality.gate.readyForApproval) {
          throw new Error(tx("请先完成并通过全部发布评测"))
        }
        if (!(quality.gate && quality.gate.caseCount) && !confirmWithoutEvaluation) {
          setRiskConfirm({
            kind: 'enable-version',
            version,
            pluginName: catalogPlugin(detail || chosen || { name: tx("这个插件") }, uiLocale, version).name,
          })
          setBusy('')
          return
        }
      }
      await api.trustPluginVersion(version.id, enabled, confirmWithoutEvaluation, note)
      saved = true
      const rejected = !enabled && version.trustState === 'quarantined'
      toast(enabled
        ? internalReview ? tx("审核通过并已上架，员工目录会立即更新") : tx("平台版本已通过严格发布审查")
        : rejected ? tx("已退回发布者修改，原因会显示在客户端")
          : tx("版本已撤销，相关绑定已停用"))
      setDetail(await api.pluginDetail(selected)); await load()
    } catch (e) { toast((saved ? tx("审核结果已保存，刷新失败：") : tx("处理失败：")) + e.message) }
    setBusy('')
    return saved
  }
  async function togglePublication(plugin) {
    const current = plugin.catalogPolicy || {}
    const nextInstallation = current.installation === 'not_available' ? 'available' : 'not_available'
    setBusy('catalog:' + plugin.id)
    try {
      const policy = await api.updatePluginCatalogPolicy(plugin.id, {
        ...current, installation: nextInstallation,
      })
      setData((old) => (old || []).map((item) => item.id === plugin.id
        ? { ...item, catalogPolicy: policy } : item))
      if (detail && detail.id === plugin.id) setDetail((old) => old ? { ...old, catalogPolicy: policy } : old)
      toast(nextInstallation === 'not_available' ? tx("插件已下架，客户端目录会同步隐藏") : tx("插件已上架，客户端目录会同步显示"))
      await refreshGovernance(true)
    } catch (error) {
      toast(tx("目录状态更新失败：") + error.message)
    } finally { setBusy('') }
  }
  async function deletePlugin(force = false) {
    if (!deleteTarget) return
    setBusy('delete:' + deleteTarget.id)
    try {
      await api.deletePlugin(deleteTarget.id, force)
      toast(tx(force ? "插件已强制删除：已自动下架并解除在用关系" : "插件已删除，历史审计记录仍会保留"))
      setDeleteTarget(null)
      setDetailOpen(false)
      setDetail(null)
      setSelected('')
      await load()
    } catch (error) {
      toast(tx("插件暂时不能删除：") + error.message)
    } finally { setBusy('') }
  }
  async function startEvaluation(version, caseItem, options = {}) {
    const capabilities = version.capabilities || {}
    const external = Boolean(capabilities.network || (capabilities.mcpServers || []).length ||
      (capabilities.runtime || []).some((x) => ['browser', 'computer'].includes(x)))
    setEvaluationBusy('start:' + caseItem.key)
    try {
      await api.startPluginEvaluation(version.id, caseItem.key, {
        ...options,
        confirmExternalAccess: external && Boolean(options.confirmExternalAccess),
      })
      toast(tx("发布评测已交给在线 Agent，执行证据会自动回到这里"))
      await loadEvaluations(version.id)
      setEvaluationBusy('')
      return true
    } catch (e) {
      toast(tx("发布评测启动失败：") + e.message)
      setEvaluationBusy('')
      return false
    }
  }
  async function reviewEvaluation(version, run, decision, note = '') {
    setEvaluationBusy('review:' + run.id)
    try {
      await api.reviewPluginEvaluation(run.id, decision, note)
      toast(decision === 'passed' ? tx("已确认这次评测通过") : tx("已记录未通过，可修订插件后重新发布版本"))
      await loadEvaluations(version.id)
      await refreshGovernance(true)
    } catch (e) { toast(tx("评测结论保存失败：") + e.message) }
    setEvaluationBusy('')
  }
  async function cancelEvaluation(version, run, confirmed = false) {
    if (!confirmed) {
      setRiskConfirm({
        kind: 'cancel-evaluation',
        version,
        run,
        pluginName: catalogPlugin(detail || chosen || { name: tx("这个插件") }, uiLocale, version).name,
      })
      return
    }
    setEvaluationBusy('cancel:' + run.id)
    try {
      await api.cancelPluginEvaluation(run.id)
      await loadEvaluations(version.id)
      await refreshGovernance(true)
    } catch (e) { toast(tx("停止评测失败：") + e.message) }
    setEvaluationBusy('')
  }
  async function openRun(row) {
    try { setRunDetail(await api.pluginRun(row.id)) } catch (e) { toast(tx("运行详情加载失败：") + e.message) }
  }
  function openBinding(binding = null) {
    setBindingEdit(binding)
    setBindingOpen(true)
  }
  async function toggleBinding(binding) {
    const key = 'binding:' + binding.id
    if (busy) return
    setBusy(key)
    try {
      await api.updatePluginBinding(binding.id, { enabled: !binding.enabled })
      toast(binding.enabled ? tx("绑定已停用") : tx("体检通过，绑定已启用"))
      setDetail(await api.pluginDetail(selected))
      await refreshGovernance(true)
    } catch (error) {
      toast((binding.enabled ? tx("停用失败：") : tx("暂不能启用：")) + error.message)
    } finally {
      setBusy('')
    }
  }
  async function quickBind(confirmWithoutEvaluation = false) {
    const recommended = pickRecommended(data || [])
    if (!recommended || !setupProject) return
    setBusy('quick-bind')
    try {
      let full = await api.pluginDetail(recommended.id)
      let version = (full.versions || [])[0]
      if (!version) throw new Error(tx("推荐插件没有可用版本"))
      if (version.trustState !== 'approved' || !version.enabled) {
        if (!full.orgId) {
          const quality = await api.pluginEvaluations(version.id)
          if (quality.gate && quality.gate.caseCount && !quality.gate.ok) {
            throw new Error(tx("推荐插件的发布评测尚未全部通过"))
          }
          if (!(quality.gate && quality.gate.caseCount) && !confirmWithoutEvaluation) {
            setRiskConfirm({
              kind: 'quick-bind',
              version,
              pluginName: full.name || recommended.name,
              projectName: setupProject.projectName,
            })
            setBusy('')
            return
          }
        }
        await api.trustPluginVersion(version.id, true, confirmWithoutEvaluation)
        full = await api.pluginDetail(recommended.id)
        version = (full.versions || [])[0]
      }
      const check = await api.simulatePluginVersion(version.id, { projectId: setupProject.projectId })
      if (!check.ok) {
        setSelected(recommended.id); setDetail(full)
        setSimulation({ plugin: full, version })
        throw new Error(tx("还有配置未就绪，已为你打开体检结果"))
      }
      const existing = (full.bindings || []).find((x) => x.projectId === setupProject.projectId)
      if (existing) await api.updatePluginBinding(existing.id, { versionId: version.id, enabled: true, config: existing.config || {} })
      else await api.bindPlugin(recommended.id, { versionId: version.id, projectId: setupProject.projectId, config: {}, enabled: true })
      toast(tx("已为「{0}」启用推荐工作流", [setupProject.projectName]))
      setSelected(recommended.id); setDetail(await api.pluginDetail(recommended.id)); await load()
      if (onNavigate) onNavigate('overview')
    } catch (e) { toast(e.message) }
    setBusy('')
  }
  async function confirmRiskAction(note = '') {
    if (!riskConfirm || riskBusy) return
    const request = riskConfirm
    setRiskBusy(true)
    try {
      let saved
      if (request.kind === 'enable-version') saved = await trust(request.version, true, true)
      else if (request.kind === 'quick-bind') await quickBind(true)
      else if (request.kind === 'reject-version') saved = await trust(request.version, false, true, note)
      else if (request.kind === 'revoke-version') saved = await trust(request.version, false, true, note)
      else if (request.kind === 'cancel-evaluation') {
        await cancelEvaluation(request.version, request.run, true)
      }
      if (saved !== false) setRiskConfirm(null)
    } finally {
      setRiskBusy(false)
    }
  }

  function openGovernanceItem(item) {
    const target = ['bindings', 'blueprint'].includes(item.target) ? 'settings' : (item.target || 'overview')
    requestedDetailSection.current = item.pluginId !== selected || !detail ? target : ''
    setDetailSection(target)
    setSelected(item.pluginId)
    if (item.versionId) setActiveVersionId(item.versionId)
    setDetailOpen(true)
    if (item.runId) openRun({ id: item.runId })
  }
  if (error) return <ErrorState msg={error.message} onRetry={load} />
  if (!data) return <Loading />
  const chosen = data.find((x) => x.id === selected)
  const latest = detail && detail.versions &&
    (detail.versions.find((x) => x.id === activeVersionId) || detail.versions[0])
  const recommended = pickRecommended(data)

  return <div className="plugin-page">
    {can('plugin.manage') && <input ref={fileRef} type="file" accept=".soduwork-plugin,.soduwork-plugin,.soduwork-plugin,.zip" hidden onChange={(e) => { importFile(e.target.files[0]); e.target.value = '' }} />}
    {governanceError && <div className="plugin-sync-alert" role="status"><Icon name="alert" /><span><b>{tx("待处理状态暂未更新")}</b><small>{governanceError}{tx("；当前仍可浏览插件目录。")}</small></span><button onClick={() => refreshGovernance(false)}>{tx("重试")}</button></div>}

    {setupProject && <section className="plugin-quick-setup">
      <span className="plugin-quick-mark"><Icon name="plug" /></span>
      <div><small>{tx("项目配置 · ")}{setupProject.projectName}</small><b>{tx("使用推荐的研发交付工作流")}</b><p>{recommended ? tx("「{0}」会串起 AI 开发、独立审查、自动合并、环境发布和业务验收。", [recommended.name]) : tx("当前还没有可用插件，请先导入工作流插件。")}</p></div>
      <div className="plugin-quick-actions">
        {recommended && can('plugin.manage') && <button className="btn btn-primary" disabled={busy === 'quick-bind'} onClick={quickBind}>{busy === 'quick-bind' ? tx("正在体检…") : tx("体检并启用")}</button>}
        {!recommended && can('plugin.manage') && <button className="btn btn-primary" onClick={() => fileRef.current.click()}>{tx("导入插件")}</button>}
        {recommended && <button className="btn btn-ghost" onClick={() => { setGuidedDetailsOpen(true); setDetailOpen(true) }}>{tx("查看流程详情")}</button>}
      </div>
    </section>}

    {(!setupProject || guidedDetailsOpen) && <section className="plugin-catalog-page">
      <PluginCatalogIndex items={data} categories={catalogCategories} canManage={can('plugin.manage')}
        onTogglePublication={togglePublication} onDelete={setDeleteTarget}
        onPolicyChanged={(id, policy) => {
          setData(old => (old || []).map(item => item.id === id ? { ...item, catalogPolicy: policy } : item))
          setDetail(old => old?.id === id ? { ...old, catalogPolicy: policy } : old)
        }}
        queues={(governance && governance.queues) || {}}
        selected={detailOpen ? selected : ''} onSelect={(id) => { requestedDetailSection.current = ''; setSelected(id); setDetailSection('overview'); setDetailOpen(true) }}
        actions={<>
          <button className="btn btn-ghost" onClick={() => setAuthorOpen(true)}>{tx("制作与上架说明")}</button>
          {can('plugin.manage') && <button className="btn btn-ghost" onClick={() => setCategoryManagerOpen(true)}><Icon name="sitemap" />{tx("管理分类")}</button>}
          {can('plugin.manage') && <details ref={moreMenuRef} className="plugin-admin-more">
            <summary className="btn btn-ghost">{tx("更多")}<Icon name="chevron" /></summary>
            <div className="plugin-admin-more-menu">
              <button type="button" onClick={() => { closeMoreMenu(); setPublishersOpen(true) }}><Icon name="shield" /><span><b>{tx("发布身份")}</b><small>{tx("核对可信发布者")}</small></span></button>
              <button type="button" disabled={busy === 'bulk-import'} onClick={() => { closeMoreMenu(); chooseBulkFiles() }}><Icon name="plus" /><span><b>{tx("批量导入")}</b><small>{tx("一次检查多个插件包")}</small></span></button>
              <button type="button" onClick={() => { closeMoreMenu(); load() }}><Icon name="refresh" /><span><b>{tx("刷新目录")}</b><small>{tx("重新获取上架与待处理状态")}</small></span></button>
            </div>
          </details>}
          {can('plugin.manage') && <button className="btn btn-primary" disabled={busy === 'import'}
            onClick={() => fileRef.current.click()}><Icon name="plus" />{busy === 'import' ? tx("正在导入…") : tx("导入并送审")}</button>}
        </>} />
    </section>}

    {(!setupProject || guidedDetailsOpen) && detailOpen && <PluginDetailDrawer title={chosen && catalogPlugin(chosen, uiLocale, latest).name}
      onClose={() => setDetailOpen(false)} suspended={Boolean(recommendationOpen || bulkImport || simulation || bindingOpen || runOpen || runDetail || authorOpen || publishersOpen || publisherCandidate || categoryManagerOpen || riskConfirm)}>
        {!chosen && <div className="auto-empty"><Icon name="plug" /><b>{tx("选择一个能力包")}</b><span>{tx("查看内容、调用入口、权限、适用范围和真实运行证据。")}</span></div>}
        {chosen && detailError && <ErrorState msg={tx("插件详情加载失败：") + detailError} onRetry={() => loadDetail(selected)} />}
        {chosen && !detail && !detailError && <Loading />}
        {detail && !latest && <div className="auto-empty"><Icon name="plug" /><b>{tx("还没有可查看的版本")}</b><span>{tx("请作者从客户端提交插件，或导入已有插件包。")}</span></div>}
        {detail && latest && <PluginDetailWorkspace plugin={detail} version={latest}
          section={detailSection} runs={runs} evaluationData={evaluationData}
          audienceData={audienceData} busy={busy} evaluationBusy={evaluationBusy}
          categoryRevision={categoryRevision}
          issues={pluginIssues(governance?.queues)[selected] || []}
          actions={{
            openIssue: openGovernanceItem,
            selectSection: setDetailSection,
            selectVersion: setActiveVersionId,
            simulate: () => setSimulation({ plugin: detail, version: latest }),
            simulateVersion: (version) => setSimulation({ plugin: detail, version }),
            startRun: () => setRunOpen(true),
            openBinding,
            toggleBinding,
            openRun,
            reloadAudience: loadAudience,
            trust,
            startEvaluation,
            reviewEvaluation,
            cancelEvaluation,
            risk: setRiskConfirm,
            publisher: setPublisherCandidate,
            recommendationOpenChanged: setRecommendationOpen,
            catalogPolicyChanged: (policy) => {
              setDetail((old) => old ? { ...old, catalogPolicy: policy } : old)
              setData((old) => (old || []).map((item) =>
                item.id === selected ? { ...item, catalogPolicy: policy } : item))
            },
            rolloutChanged: async () => {
              setDetail(await api.pluginDetail(selected))
              await refreshGovernance(true)
            },
          }} />}
        {syncIssue && <div className="plugin-sync-alert"><Icon name="alert" /><span><b>{tx("运行数据暂时没有更新")}</b><small>{syncIssue}{lastSyncedAt ? tx(" · 上次同步 {0}", [fmt(lastSyncedAt)]) : ''}</small></span><button onClick={() => refreshRuns(false)}>{tx("重新连接")}</button></div>}
    </PluginDetailDrawer>}

    {bulkImport && <BulkImportModal data={bulkImport} busy={busy === 'bulk-import'}
      onClose={() => setBulkImport(null)} onConfirm={confirmBulkImport} />}
    {simulation && <SimulationModal plugin={simulation.plugin} version={simulation.version} initialProjectId={setupProject && setupProject.projectId} onClose={() => setSimulation(null)} />}
    {bindingOpen && detail && <BindingForm plugin={detail} binding={bindingEdit} onClose={() => { setBindingOpen(false); setBindingEdit(null) }} onSaved={async () => { setBindingOpen(false); setBindingEdit(null); setDetail(await api.pluginDetail(selected)); await refreshGovernance(true) }} />}
    {can('plugin.run') && runOpen && detail && <PluginRunForm plugin={detail} onClose={() => setRunOpen(false)} onStarted={(run) => { setRunOpen(false); setRunDetail(run); load() }} />}
    {runDetail && <RunDrawer run={runDetail} onClose={() => setRunDetail(null)} />}
    {authorOpen && <Suspense fallback={null}><PluginAuthorGuide adminOnly onClose={() => setAuthorOpen(false)} /></Suspense>}
    {publishersOpen && <PluginPublisherKeys onClose={() => setPublishersOpen(false)} />}
    {categoryManagerOpen && <PluginCategoryManager open onClose={() => setCategoryManagerOpen(false)}
      onSaved={(items) => { setCatalogCategories(items || []); setCategoryRevision((value) => value + 1); refreshGovernance(true) }} />}
    {deleteTarget && <PluginDeleteConfirm plugin={deleteTarget} busy={busy === 'delete:' + deleteTarget.id}
      onClose={() => !busy && setDeleteTarget(null)} onConfirm={deletePlugin} />}
    {publisherCandidate && <PluginPublisherCandidate {...publisherCandidate} onClose={() => setPublisherCandidate(null)} onRegistered={async () => { await loadDetail(selected); await load() }} />}
    {riskConfirm && <PluginRiskConfirm request={riskConfirm} busy={riskBusy} onClose={() => !riskBusy && setRiskConfirm(null)} onConfirm={confirmRiskAction} />}
  </div>
}

function pickRecommended(items) { return items.find((x) => x.key === 'project-validation-release') || items.find((x) => x.sourceKind === 'builtin') || items[0] }

function PluginDeleteConfirm({ plugin, busy, onClose, onConfirm }) {
  const uiLocale = useLocale();
  const [force, setForce] = useState(false);
  return <Modal scope="plugin-page" title={tx("删除插件")} icon="trash" onClose={onClose} foot={<>
    <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>{tx("取消")}</button>
    <button type="button" className="btn btn-danger" onClick={() => onConfirm(force)} disabled={busy}>{busy ? tx("正在删除…") : (force ? tx("强制删除") : tx("确认删除"))}</button>
  </>}>
    <div className="plugin-delete-confirm">
      <span className="plugin-delete-icon"><Icon name="trash" /></span>
      <div><h3>{tx("确定删除“")}{plugin.name || tx("未命名插件")}{'\u201d\uff1f'}</h3>
        <p>{tx("删除后插件立即从客户端消失，历史审核记录会保留。")}</p>
        <label className="plugin-delete-force">
          <input type="checkbox" checked={force} disabled={busy}
            onChange={(e) => setForce(e.target.checked)} />
          <span>{tx("自动解除在用关系（下架目录、撤销版本、停用绑定与员工安装；运行中的任务除外）")}</span>
        </label>
        <div className="plugin-delete-rule"><Icon name="shield" /><span>{force ? tx("强制删除会一并撤销已发布版本，请确认没有正在运行的任务依赖这个插件。") : tx("未勾选时只能删除已下架、没有在用版本、绑定或安装关系的插件。")}</span></div>
      </div>
    </div>
  </Modal>
}

function BulkImportModal({ data, busy, onClose, onConfirm }) {
  const uiLocale = useLocale();
  const [sourceLabel, setSourceLabel] = useState(tx("外部插件包"))
  const [rightsConfirmed, setRightsConfirmed] = useState(false)
  const files = data.files || []
  const result = data.result
  return <Modal scope="plugin-page" title={tx("批量导入插件包")} icon="box" onClose={onClose} foot={<>
    <button className="btn btn-ghost" onClick={onClose}>{result ? tx("关闭") : tx("取消")}</button>
    {!result && <button className="btn btn-primary" disabled={busy || !files.length}
      onClick={() => onConfirm({ sourceLabel, rightsConfirmed })}>
      {busy ? tx("正在校验并导入…") : tx("提交 {0} 个包审核", [files.length])}
    </button>}
  </>}>
    <div className="plugin-bulk-import">
      <section className="plugin-bulk-summary"><Icon name="shield" /><div>
        <b>{tx("只导入有明确使用权的插件包")}</b>
        <p>{tx("SoduWork 不抓取未知市场。宽松开源许可证可直接识别；企业自有或已获授权的包需要人工确认使用权。")}</p>
      </div></section>
      <label><span>{tx("来源名称")}</span><input value={sourceLabel} maxLength={80}
        placeholder={tx("例如：企业自有插件库")}
        onChange={(event) => setSourceLabel(event.target.value)} /></label>
      <label className="plugin-bulk-rights"><input type="checkbox" checked={rightsConfirmed}
        onChange={(event) => setRightsConfirmed(event.target.checked)} />
        <span><b>{tx("我确认企业拥有这些插件包的导入与内部使用权")}</b><small>{tx("具有明确宽松开源许可证的包无需勾选；未知授权包会被拒绝。")}</small></span>
      </label>
      <div className="plugin-bulk-files">
        <header><b>{tx("待导入文件")}</b><span>{files.length}{tx(" 个 · 单包不超过 10 MB")}</span></header>
        {files.map((file) => <span key={file.name + file.size}><b>{file.name}</b><small>{Math.max(1, Math.round(file.size / 1024))} KB</small></span>)}
      </div>
      {result && <div className="plugin-bulk-result">
        <b>{tx("导入完成：")}{result.imported}{tx(" 个成功，")}{result.failed}{tx(" 个未导入")}</b>
        {(result.items || []).map((item) => <span className={item.ok ? 'ok' : 'bad'} key={item.filename}>
          <i>{item.ok ? '✓' : '!'}</i><strong>{item.filename}</strong><small>{item.ok ? tx("已进入待审核列表") : item.error}</small>
        </span>)}
      </div>}
    </div>
  </Modal>
}

function SimulationModal({ plugin, version, initialProjectId = '', onClose }) {
  const uiLocale = useLocale();
  const [projects, setProjects] = useState([])
  const [projectId, setProjectId] = useState(initialProjectId || '')
  const [agentKind, setAgentKind] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState('')
  async function loadProjects() {
    setLoadError('')
    try { setProjects((await api.projects()) || []) }
    catch (e) { setLoadError(tx("项目目录加载失败：") + (e.message || tx("请检查服务连接"))) }
  }
  useEffect(() => { loadProjects() }, [])
  async function run() {
    setBusy(true); setResult(null)
    try { setResult(await api.simulatePluginVersion(version.id, { projectId, agentKind })) } catch (e) { toast(tx("模拟失败：") + e.message) }
    setBusy(false)
  }
  return <Modal scope="plugin-page" wide title={tx("预检与模拟 · {0}", [plugin.name])} icon="check" onClose={onClose} foot={<><button className="btn btn-ghost" onClick={onClose}>{tx("关闭")}</button><button className="btn btn-primary" disabled={busy} onClick={run}>{busy ? tx("正在体检…") : result ? tx("重新模拟") : tx("开始模拟")}</button></>}>
    <p className="plugin-modal-intro">{tx("选择真实项目与执行器，SoduWork 只检查版本、技能、Runner、仓库和环境，不创建需求、不拉代码、也不启动进程。")}</p>
    {loadError && <LoadIssue message={loadError} onRetry={loadProjects} />}
    <div className="form-pair"><Field label={tx("模拟项目")}><SelectMenu className="f-in" value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">{tx("组织通用场景")}</option>{projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</SelectMenu></Field><AgentChoice value={agentKind} onChange={setAgentKind} /></div>
    {!result && <div className="plugin-sim-empty"><Icon name="check" /><b>{tx("尚未运行模拟")}</b><span>{tx("点击“开始模拟”，一次看清能不能跑、缺什么、会经过哪些节点。")}</span></div>}
    {result && <><div className={'plugin-sim-verdict ' + (result.ok ? 'ok' : 'bad')}><i>{result.ok ? '✓' : '!'}</i><div><b>{result.ok ? tx("这套方法已具备运行条件") : tx("还有配置需要补齐")}</b><span>{result.ok ? tx("将由 {0} 承接", [(result.agent && result.agent.name) || tx("自动执行机")]) : tx("处理阻断项后重新模拟，不必重新导入插件")}</span></div></div><div className="plugin-sim-checks">{(result.checks || []).map((x) => <span className={x.ok ? 'ok' : 'bad'} key={x.key}><i>{x.ok ? '✓' : '!'}</i><div><b>{serverMessage(x.labelMessage, x.label)}</b><small>{serverMessage(x.detailMessage, x.detail)}</small></div></span>)}</div><NoticeList tone="bad" title={tx("阻断项")} items={result.blockers || []} /><NoticeList tone="warn" title={tx("建议确认")} items={result.warnings || []} /><section className="plugin-preview-section"><div className="auto-section-head"><div><span className="eyebrow">{tx("模拟路线")}</span><h3>{tx("不会启动的干跑计划")}</h3></div></div><WorkflowGraph nodes={result.plan || []} /></section></>}
  </Modal>
}
