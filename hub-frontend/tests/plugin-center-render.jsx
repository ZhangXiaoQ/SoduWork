// Real UI, isolated fixture data. No backend or production mutation is permitted.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { api, setUser } from '../src/api.js'
import { setLocale, getLocale, translateText as tx } from '../src/i18n.js'
import { catalogPlugin } from '../src/plugin-locales.js'
import '../src/styles.css'
import '../src/styles-bugloop.css'
import '../src/styles-devflow.css'
import '../src/design-system.css'
import '../src/page-layouts.css'
import '../src/landing.css'
import '../src/filter-controls.css'
import '../src/admin-controls.css'
import '../src/accessibility.css'
import '../src/responsive-pages.css'
import '../src/dialog-layout.css'
import '../src/screens/detail-layout.css'
import '../src/layout-safety.css'
import '../src/console-theme.css'
import './plugin-center-render.css'

const params = new URLSearchParams(location.search)
setLocale('zh-CN') // Chinese journeys must not inherit the headless browser's system language.
document.documentElement.dataset.theme = params.get('theme') || 'light'
setUser({ id: 'isolated-test-admin', isSuper: true })
const failures = [], checks = [], calls = []
let reviewFails = false
const composePlacements = new Map()
let recommendationFails = false, recommendationGate = null
window.addEventListener('error', (event) => failures.push(event.message))
window.addEventListener('unhandledrejection', (event) => failures.push(String(event.reason)))
window.fetch = async () => { throw new Error('Unexpected network request in isolated test') }
const rows = [
  ['prototype', '智能体产品设计', '将业务需求整理为目标、工具与协作流程，交付可以点击体验的 HTML 产品原型。', 'workflow', true],
  ['slides', '演示文稿工坊', '从主题和素材构建故事线，制作版式统一、可直接讲解的演示文稿。', 'skill', true],
  ['bugfix', 'SoduWork · 问题修复', '定位问题、修改代码并自测，提交独立分支。上线在独立发布流程中完成。', 'workflow', true],
  ['hr', '人事服务助手', '连接企业人事系统，查询制度、整理材料，并协助处理日常人事事项。', 'connector', true],
  ['contracts', '合同版本审核', '比较合同修订内容，标注关键条款变化，输出可追溯的审核意见。', 'skill', false],
  ['research', '行业研究简报', '围绕指定主题查找资料、交叉核对来源，形成精炼的研究结论与参考链接。', 'skill', true],
  ['release', 'SoduWork · 集中发布', '汇总已完成的修复与需求，检查待发布版本，完成发布、健康检查与回滚准备。', 'workflow', false],
  ['minutes', '会议纪要与行动项', '整理讨论结论、负责人和截止时间，生成可继续跟进的行动清单。', 'skill', true],
  ['data', '表格与数据分析', '清理数据、核对口径并分析趋势，交付工作簿、图表和结论。', 'skill', true],
]
const plugins = rows.map(([id, name, description, kind, ready], index) => {
  const version = {
    manifest: {},
    id: id + '-v1', version: '1.2.0', trustState: ready ? 'approved' : 'quarantined', enabled: ready,
    visibility: 'org', createdAt: 1788314400000, provenance: { signatureState: id === 'contracts' ? 'unknown-key' : 'verified', publisherName: index % 2 ? '产品团队' : 'SoduWork 团队' },
    capabilities: { hasWorkflow: kind === 'workflow', executionMode: kind === 'workflow' ? 'workflow' : 'direct', skills: kind === 'connector' ? [] : ['frontend-design', 'delivery-check'], mcpServers: kind === 'connector' ? ['hr-service'] : [], runtime: ['files'], agentKinds: ['local:codex'], entrypoints: { conversation: true, task: true, automation: kind === 'workflow' } },
    workflow: { nodes: kind === 'workflow' ? [{ key: 'understand', name: '明确需求', type: 'ai' }, { key: 'deliver', name: '完成交付', type: 'ai' }, { key: 'verify', name: '检查成果', type: 'ai_review' }] : [] },
  }
  return { id, key: id, qualifiedKey: 'soduwork/' + id, name, description, orgId: index % 3 ? 'fixture-org' : null, sourceKind: index % 3 ? 'soduwork' : 'builtin', enabled: ready, updatedAt: 1788314400000 - index, latestVersion: version, versions: [version], bindings: [], catalogPolicy: { installation: 'available' } }
})
plugins.find((item) => item.id === 'contracts').latestVersion.manifest.setup = {
  title: '合同审核的安装偏好', description: '所选插件版本的配置定义。', preferences: [
    { key: 'enabled', label: '完成后通知', type: 'boolean', required: true, default: false },
    { key: 'retries', label: '重试次数', type: 'number', default: 0, minimum: 0, maximum: 3 },
    { key: 'language', label: '报告语言', type: 'select', default: 'zh-CN', options: [{ value: 'zh-CN', label: '中文报告' }, { value: 'en-US', label: 'English report' }] },
    { key: 'context', label: '合同审核的业务范围与补充说明', type: 'textarea', description: '完整展示长说明和字段值，不能依靠截断省略审核内容。', placeholder: '请填写团队审核规范', maxLength: 500 },
  ],
}
const appFixture = plugins.find(item => item.id === 'contracts')
appFixture.latestVersion.manifest.template = 'app'
if (params.get('view') === 'featured-cover') {
  appFixture.catalogPolicy.featured = true
  appFixture.catalogPolicy.coverUrl = location.origin + '/soduwork.png'
}
if (params.get('view') === 'catalog-tabs') {
  appFixture.catalogPolicy.featured = true
  plugins.find(item => item.id === 'prototype').catalogPolicy.featured = true
}
appFixture.latestVersion.capabilities.mcpServers = ['fixture-app-service']
appFixture.versions.push({ ...structuredClone(appFixture.latestVersion), id: 'contracts-old', version: '1.1.0',
  manifest: {}, trustState: 'approved', enabled: true })
if (params.get('view') === 'locale-review') {
  appFixture.latestVersion.manifest.locales = {
    'zh-CN': { name: '运营应用', description: '管理运营工作' },
    'en-US': { name: 'Operations App', description: 'Manage operations', setup: { title: 'App preferences', preferences: { language: { label: 'Report language', options: { 'zh-CN': 'Chinese report', 'en-US': 'English report' } } } } },
    'ko-KR': { name: '운영 앱', description: '운영 관리' },
  }
  appFixture.versions[1].manifest.locales = {
    'zh-CN': { name: '旧运营插件', description: '旧版说明' },
    'en-US': { name: 'Old Operations Plugin', description: 'Old version' },
  }
}
const queues = { issues: [{ id: 'missing-identity', pluginId: 'contracts', versionId: 'contracts-v1', target: 'versions', title: '核对发布身份' }, { id: 'runtime', pluginId: 'prototype', target: 'runs', title: '上次运行需要检查' }] }
for (const key of Object.keys(api)) api[key] = async () => { failures.push('Unexpected API: ' + key); throw new Error('Unmocked API: ' + key) }
// HTTP responses are immutable snapshots, not shared references to server state.
api.pluginGovernance = async () => structuredClone({ items: plugins, queues })
api.plugins = async () => structuredClone({ items: plugins })
api.pluginDetail = async (id) => { calls.push(['detail', id]); return structuredClone(plugins.find((item) => item.id === id)) }
api.pluginRuns = async () => ({ items: [] })
api.pluginRecommendation = async (id) => {
  calls.push(['recommendation', id])
  if (recommendationFails) throw new Error('Simulated recommendation read failure')
  const echo = { composeRecommended: composePlacements.get(id) === true, sidebarRecommended: Boolean(plugins.find(item => item.id === id)?.catalogPolicy?.sidebarRecommended) }
  if (recommendationGate) await recommendationGate
  return echo
}
api.pluginRollout = async () => ({ items: [], summary: { active: 0, eligible: 0, breaking: 0, blocked: 0 } })
api.pluginEvaluations = async (id) => { calls.push(['evaluation', id]); return { items: [], gate: { caseCount: 0 } } }
api.projects = async () => ({ items: [] })
api.pluginCategories = async () => ({ items: [{ key: 'general', name: '通用能力', enabled: true }] })
api.updatePluginCatalogPolicy = async (id, patch) => {
  calls.push(['recommend', id, patch])
  const plugin=plugins.find(item=>item.id===id)
  const { composeRecommended, ...policy } = patch
  if (typeof composeRecommended === 'boolean') composePlacements.set(id, composeRecommended)
  plugin.catalogPolicy={...plugin.catalogPolicy,...policy}
  return structuredClone({ ...plugin.catalogPolicy, composeRecommended: composePlacements.get(id) === true })
}
api.pluginAccessPolicy = async () => ({ use: { mode: 'inherit' }, edit: { mode: 'inherit' }, updatedAt: 0 })
api.pluginAccessCandidates = async () => ({ items: [], orgUnits: [] })
api.pluginActivity = async () => ({ items: [], total: 0, summary: {}, governance: { items: [], total: 0 } })
api.trustPluginVersion = async (id, enabled, _confirm, note) => {
  calls.push(['trust', id, enabled, note])
  if (reviewFails) throw new Error('Simulated review failure')
  const plugin = plugins.find((item) => item.latestVersion.id === id)
  const version = { ...plugin.latestVersion, trustState: enabled ? 'approved' : 'revoked', enabled }
  plugin.latestVersion = version; plugin.versions = [version]; plugin.enabled = enabled
  return { ok: true }
}
api.simulatePluginVersion = async () => ({ ok: true, checks: [], warnings: [], errors: [] })
const { default: PluginCenter } = await import('../src/screens/PluginCenter.jsx')
createRoot(document.getElementById('root')).render(<main className="fixture-shell"><header className="fixture-head"><div><small>SoduWork 管理端 / 能力配置</small><h1>插件与应用</h1><p>管理团队共享的工作方法与工具</p></div><span>隔离测试数据</span></header><PluginCenter /></main>)

const pause = () => new Promise((resolve) => setTimeout(resolve, 20))
async function until(test) { for (let i = 0; i < 100; i++) { if (test()) return; await pause() } throw new Error('Timeout: ' + test.toString()) }
function check(condition, label) { (condition ? checks : failures).push(label) }
const q = (selector) => document.querySelector(selector)
const all = (selector) => [...document.querySelectorAll(selector)]
const button = (text, root = document) => [...root.querySelectorAll('button')].find((element) => element.textContent.trim() === text)
async function click(element) { if (!element) throw new Error('Missing control: ' + [...document.querySelectorAll('button')].map(node => node.textContent.trim()).join(' | ')); element.focus(); element.click(); await pause() }
async function select(label, optionText) {
  const trigger = q(`.select-menu-trigger[aria-label="${label}"]`)
  await click(trigger)
  const options = [...trigger.closest('.select-menu').querySelectorAll('[role="option"]')]
  await click(options.find((element) => element.textContent.trim() === optionText || element.textContent.trim().startsWith(optionText + '（')))
}
async function input(value) { const element = q('[aria-label="搜索插件"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); await pause() }
async function escape() { document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await pause() }
async function open(id) {
  const plugin = plugins.find(item => item.id === id)
  const type = plugin.latestVersion.manifest.template === 'app' ? 'app' : 'plugin'
  if (q(`#plugin-catalog-tab-${type}`).getAttribute('aria-selected') !== 'true') await click(q(`#plugin-catalog-tab-${type}`))
  const name = catalogPlugin(plugin, getLocale()).name
  await click(q(`[aria-label="${tx('查看{0}详情', [name])}"]`)); await until(() => q('.plugin-title-copy h3'))
}
function readableType() {
  const selector = '.plugin-card *, .plugin-titlebar-v3 *, .plugin-version-history *, .plugin-description-section *, .plugin-preview-setup *'
  const small = all(selector).filter((element) => element.checkVisibility() &&
    [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()) &&
    parseFloat(getComputedStyle(element).fontSize) < 12)
  check(small.length === 0, 'plugin metadata and version actions use at least 12px: ' +
    small.map((element) => element.className || element.tagName).join(', '))
}
function noOverflow() {
  // Headless virtual time advances timers separately from compositor animations.
  // Measure the resting layout, not a translated frame of the drawer entrance.
  for (const animation of document.getAnimations()) {
    if (animation.effect?.getComputedTiming().iterations !== Infinity) animation.finish()
  }
  readableType()
  if (params.has('width')) {
    const expected = Number(params.get('width'))
    check(innerWidth === expected,
      `viewport is the intended size (${innerWidth}px, requested ${expected}px)`)
  }
  check(document.documentElement.scrollWidth <= innerWidth + 1, 'page has no horizontal overflow')
  if (innerWidth <= 720) {
    const controls = all('.plugin-catalog-refine .select-menu-trigger')
    const count = q('#plugin-catalog-tab-app[aria-selected="true"]') ? 4 : 5
    check(controls.length === count && controls.every((element) => element.getBoundingClientRect().width >= 100), 'narrow-screen filters remain usable, at least 100px wide')
  }
  for (const element of all('.plugin-card, .plugin-detail-drawer, .plugin-description-facts, .plugin-review-callout, .plugin-catalog-controls, .plugin-preview-setup, .plugin-setup-field')) {
    check(element.scrollWidth <= element.clientWidth + 2, 'content fits: ' + element.className + (element.scrollWidth > element.clientWidth + 2 ? ' ' + JSON.stringify([...element.querySelectorAll('*')].filter((child) => child.checkVisibility() && child.getBoundingClientRect().right > element.getBoundingClientRect().right + 2).map((child) => [child.className, child.getBoundingClientRect().width])) : ''))
    const rect = element.getBoundingClientRect()
    check(rect.left >= -1 && rect.right <= innerWidth + 1, 'element is not clipped by viewport: ' + element.className)
  }
  if (q('.plugin-title-copy')) check(q('.plugin-title-copy').getBoundingClientRect().width >= Math.min(240, innerWidth - 125), 'detail title has readable width')
}
try {
  await until(() => all('.plugin-card').length === plugins.length - 1)
  check(!q('.plugin-catalog-hero') && !q('.plugin-governance-overview'), 'directory has no overview or stats hero')
  check(calls.length === 0, 'directory does not fetch invisible detail/evaluation')
  const catalogWidth = q('.plugin-catalog').getBoundingClientRect().width
  const columns = getComputedStyle(q('.plugin-card-grid')).gridTemplateColumns.split(' ').length
  check(catalogWidth < 900 || columns === (catalogWidth >= 1240 ? 4 : 3), 'catalog columns adapt to the actual container width')
  check(all('.plugin-card-shell').every(card => getComputedStyle(card).borderTopWidth === '0px'), 'catalog cards have no border')
  check(all('.plugin-card-icon').every(icon => icon.getBoundingClientRect().width === 48), 'catalog artwork uses a consistent 48px size')
  check(!q('.plugin-card-shell .plugin-card-chip, .plugin-card-shell .plugin-app-tag'), 'catalog does not repeat app/category pills')
  check(!q('.plugin-card-shell [aria-label^="推荐 "], .plugin-card-shell [aria-label^="取消推荐 "]'), 'recommendation actions live only in details')
  const view = params.get('view') || 'test'
  if (view === 'test') {
    await click(q('#plugin-catalog-tab-app'))
    check(Boolean(q('.plugin-card-shell[data-catalog-kind="app"]')), 'application tab identifies application cards without a repeated tag')
    check(all('.plugin-card').length === 1, 'application tab excludes ordinary plugins')
    await input('合同'); check(all('.plugin-card').length === 1, 'search is live')
    await open('contracts'); const drawer = q('.plugin-detail-drawer')
    check(drawer.contains(document.activeElement), 'opening drawer moves focus inside')
    await click(button('审核与版本', drawer)); await pause()
    check(!q('.plugin-lifecycle'), 'enterprise review has no platform evaluation rail')
    check(Boolean(button('核对发布者')), 'unknown enterprise signing identity has recovery action')
    check(button('审核并上架', q('.plugin-review-callout')).disabled, 'unregistered signing identity cannot be approved')
    check(!calls.some(([kind]) => kind === 'evaluation'), 'enterprise review never fetches strict evaluations')
    await click(q('.plugin-contract-disclosure summary')); readableType(); noOverflow()
    await click(button('退回修改', drawer)); await until(() => q('.modal-mask'))
    check(drawer.inert, 'parent drawer is inert during confirmation')
    check(q('.modal').contains(document.activeElement), 'nested confirmation takes keyboard focus')
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    check(q('.modal').contains(document.activeElement), 'nested confirmation traps keyboard focus')
    check(Number(getComputedStyle(q('.modal-mask')).zIndex) > Number(getComputedStyle(q('.plugin-detail-overlay')).zIndex), 'confirmation is above drawer')
    check(button('确认退回').disabled, 'rejection requires a reason')
    await escape(); check(!q('.modal-mask') && Boolean(q('.plugin-detail-drawer')), 'Escape closes nested confirmation only')
    await escape(); check(!q('.plugin-detail-drawer'), 'Escape closes detail')
    check(q('[aria-label="搜索插件"]').value === '合同' && all('.plugin-card').length === 1, 'closing detail retains filters')
    check(document.activeElement.matches('.plugin-card'), 'closing detail restores trigger focus')
    await open('contracts'); await click(button('审核与版本', q('.plugin-detail-drawer')))
    await click(button('退回修改')); await until(() => q('.modal-mask'))
    const note = q('.modal textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(note, '请补充用途和权限说明')
    note.dispatchEvent(new Event('input', { bubbles: true })); await pause()
    reviewFails = true; await click(button('确认退回')); await pause()
    check(Boolean(q('.modal-mask')) && q('.modal textarea').value === '请补充用途和权限说明', 'failed review preserves dialog and written feedback')
    reviewFails = false; await escape(); await escape()
    plugins.find((item) => item.id === 'contracts').latestVersion.provenance.signatureState = 'verified'
    await open('contracts'); await click(button('审核与版本', q('.plugin-detail-drawer')))
    await click(button('审核并上架', q('.plugin-review-callout'))); await pause()
    check(q('.plugin-title-state').textContent.includes('已上架'), 'enterprise approval updates detail in one action')
    check(!calls.some(([kind]) => kind === 'evaluation'), 'enterprise approval does not add evaluation steps')
    await escape()
    check(q('.plugin-card-shell').textContent.includes('已上架'), 'approval updates the matching catalog card')
    await click(q('.filter-clear[aria-label="清空搜索插件"]')); check(all('.plugin-card').length === 1, 'search clear retains the application tab')
    await click(q('#plugin-catalog-tab-plugin')); check(all('.plugin-card').length === 8, 'plugin tab excludes applications')
    await select('能力类型', '工作流'); check(all('.plugin-card').length === 3, 'type filter works immediately')
    await select('插件来源', '企业提交'); check(all('.plugin-card').length === 1, 'combined source filter works immediately')
    await click(q('.filter-clear[aria-label="恢复能力类型默认值"]')); check(all('.plugin-card').length === 5, 'clearing type retains the source filter')
    await click(q('.filter-clear[aria-label="恢复插件来源默认值"]')); check(all('.plugin-card').length === 8, 'clearing source restores directory')
    await select('插件状态', '待处理')
    check(all('.plugin-card').length === 1 && q('.state-published'), 'attention and publication are independent')
    await click(q('.filter-clear[aria-label="恢复插件状态默认值"]')); check(all('.plugin-card').length === 8, 'clearing status restores directory')
    await open('slides')
    await click(button('使用配置', q('.plugin-detail-drawer'))); await pause()
    check(Boolean(q('.plugin-settings-panel')), 'configuration remains available')
    await click(button('运行记录', q('.plugin-detail-drawer'))); check(q('.plugin-runs-panel').textContent.includes('还没有运行记录'), 'empty run state uses real data')
    await escape(); await open('prototype'); await click(button('审核与版本', q('.plugin-detail-drawer')))
    await until(() => calls.some(([kind]) => kind === 'evaluation'))
    check(Boolean(q('.plugin-lifecycle')), 'platform review retains strict evaluation')
    await escape(); await click(button('制作与上架说明')); await until(() => q('.modal-mask'))
    check(q('.modal-mask').textContent.includes('本机试用'), 'client-making and trial guide is accessible')
    await escape()
  } else if (view === 'catalog-tabs') {
    check(all('.plugin-card').length === 8 && !q('.plugin-app-tag'), 'default plugin tab excludes applications')
    await select('插件状态', '已推荐')
    check(all('.plugin-card').length === 1 && q('.plugin-card-name').textContent === '智能体产品设计', 'recommended plugin filter uses the existing featured flag')
    q('#plugin-catalog-tab-plugin').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await pause()
    check(q('#plugin-catalog-tab-app').getAttribute('aria-selected') === 'true' && document.activeElement.id === 'plugin-catalog-tab-app', 'keyboard selects and focuses application tab')
    check(all('.plugin-card').length === 1 && q('.state-pending'), 'recommendation status survives tab switch and includes a pending recommended application')
    check(q('[aria-label="插件状态"]').textContent.includes('已推荐'), 'selected recommendation status stays visible')
    await input('合同'); await click(q('#plugin-catalog-tab-plugin'))
    check(all('.plugin-card').length === 0, 'tab switch retains the search query')
    await click(q('#plugin-catalog-tab-app'))
    check(all('.plugin-card').length === 1, 'application matches combined search and recommendation filters')
    await click(q('.filter-clear[aria-label="清空搜索插件"]'))
  } else if (view === 'recommend') {
    const card=q('.plugin-card-shell')
    await open(plugins[0].id)
    await click(button('推荐',q('.plugin-detail-drawer')));await until(()=>q('.modal-mask'))
    check(q('.modal .btn-primary').disabled, 'saving requires an explicitly selected recommendation placement')
    await click(q('#optApp'))
    const input=q('.modal input[type="url"]')
    const coverUrl=location.origin+'/soduwork.png'
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,location.origin+'/__missing-cover.png')
    input.dispatchEvent(new Event('input',{bubbles:true}));await pause()
    await until(()=>q('.modal .plugin-cover-preview[data-status="error"]'))
    check(input.value.endsWith('/__missing-cover.png'),'failed preview preserves the entered URL')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,coverUrl)
    input.dispatchEvent(new Event('input',{bubbles:true}));await pause()
    await until(()=>q('.modal .plugin-cover-preview[data-status="ready"]'))
    check(q('.modal .plugin-cover-preview img').naturalWidth>0,'entered URL renders a real image preview')
    await click(button('保存',q('.modal')));await until(()=>!q('.modal-mask'))
    check(Boolean(card.querySelector('.plugin-card-recommended-mark')),'recommendation shows the colorful thumbs-up on its card')
    check(calls.some(([kind,id,patch])=>kind==='recommend'&&patch.featured&&patch.coverUrl===coverUrl),'cover is saved through existing policy API')
    await until(()=>q('.plugin-featured-cover .plugin-cover-preview[data-status="ready"]'))
    check(q('.plugin-featured-cover img').src===coverUrl,'recommended detail displays the saved cover')
    await click(button('编辑推荐',q('.plugin-detail-drawer')));await until(()=>q('.modal-mask'))
    await click(button('取消推荐',q('.modal')));await until(()=>!q('.modal-mask'))
    check(!card.querySelector('.plugin-card-recommended-mark'),'cancel recommendation removes the thumbs-up marker')
    check(!q('.plugin-featured-cover'),'cancel recommendation removes the featured cover section')
    await click(button('推荐',q('.plugin-detail-drawer')));await until(()=>q('.modal-mask'))
    check(q('.modal input[type="url"]').value===coverUrl,'recommending again restores saved artwork')
    await escape(); await escape(); await open('contracts')
    const drawer=q('.plugin-detail-drawer')
    check(Boolean(button('推荐',drawer)),'newly imported application exposes recommendation in its detail header')
    await click(button('推荐',drawer));await until(()=>q('.modal-mask'))
    check(drawer.inert,'recommendation suspends the parent detail drawer')
    check(q('.modal').textContent.includes('审核通过并上架'),'pending app recommendation explains its publication requirement')
    await escape()
    check(!q('.modal-mask')&&Boolean(q('.plugin-detail-drawer')),'Escape closes recommendation without closing application detail')
    await click(button('推荐',q('.plugin-detail-drawer')));await until(()=>q('.modal-mask'))
    const appCoverInput=q('.modal input[type="url"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(appCoverInput,coverUrl)
    appCoverInput.dispatchEvent(new Event('input',{bubbles:true}))
    await until(()=>q('.modal .plugin-cover-preview[data-status="ready"]'))
    check(q('.modal .plugin-cover-preview img').naturalWidth>0,'application recommendation also previews artwork')
  } else if (view === 'recommend-state') {
    for (const [compose, featured] of [[true, false], [false, true], [true, true], [false, false]]) {
      composePlacements.set('contracts', compose)
      appFixture.catalogPolicy.featured = featured
      appFixture.catalogPolicy.coverUrl = location.origin + '/soduwork.png'
      await open('contracts')
      await until(() => q('.plugin-cover-actions button') && !q('.plugin-cover-actions button').disabled)
      const label = compose || featured ? '编辑推荐' : '推荐'
      check(Boolean(button(label, q('.plugin-cover-actions'))), `saved placements (${compose}, ${featured}) show ${label} before opening settings`)
      check(Boolean(q('.plugin-recommend-status')) === (compose || featured), `saved placements (${compose}, ${featured}) show the correct recommendation status`)
      await click(q('.plugin-cover-actions button')); await until(() => q('.rec-modal'))
      check(q('#optCompose').getAttribute('aria-checked') === String(compose) && q('#optApp').getAttribute('aria-checked') === String(featured), 'settings echo both saved placements')
      await click(q('#optCompose')); await click(q('#optApp'))
      await click(button('关闭', q('.rec-modal')))
      check(Boolean(button(label, q('.plugin-cover-actions'))), 'closing unsaved changes preserves the saved recommendation label')
      await escape(); await open('contracts')
      await until(() => q('.plugin-cover-actions button') && !q('.plugin-cover-actions button').disabled)
      check(Boolean(button(label, q('.plugin-cover-actions'))), 'reopening detail preserves the saved recommendation label')
      await escape()
    }
    await open('contracts')
    await until(() => q('.plugin-cover-actions button') && !q('.plugin-cover-actions button').disabled)
    await click(button('推荐', q('.plugin-cover-actions'))); await until(() => q('.rec-modal'))
    await click(q('#optCompose')); await click(button('保存', q('.rec-modal')))
    await until(() => !q('.rec-modal'))
    check(Boolean(button('编辑推荐', q('.plugin-cover-actions'))) && Boolean(q('.plugin-recommend-status')), 'saving compose-only recommendation updates the status immediately')
    await escape(); await open('contracts')
    await until(() => q('.plugin-cover-actions button') && !q('.plugin-cover-actions button').disabled)
    check(Boolean(button('编辑推荐', q('.plugin-cover-actions'))), 'saved compose-only recommendation survives detail remount')
    await click(q('.plugin-cover-actions button')); await until(() => q('.rec-modal'))
    await click(button('取消推荐', q('.rec-modal'))); await until(() => !q('.rec-modal'))
    check(Boolean(button('推荐', q('.plugin-cover-actions'))) && !q('.plugin-recommend-status'), 'cancel removes the status immediately')
    await escape(); await open('contracts')
    await until(() => q('.plugin-cover-actions button') && !q('.plugin-cover-actions button').disabled)
    check(Boolean(button('推荐', q('.plugin-cover-actions'))) && !q('.plugin-recommend-status'), 'cancel remains effective after detail remount')
    await escape()
    appFixture.catalogPolicy.sidebarRecommended = true
    await open('contracts')
    await until(() => q('.plugin-cover-actions button') && !q('.plugin-cover-actions button').disabled)
    check(Boolean(button('编辑推荐', q('.plugin-cover-actions'))), 'sidebar-only recommendation is recognized before opening settings')
    await click(q('.plugin-cover-actions button')); await until(() => q('.rec-modal'))
    check(q('#optSidebar').getAttribute('aria-checked') === 'true', 'settings echo the saved sidebar placement')
    check(q('#optCompose').getAttribute('aria-checked') === 'false' && q('#optApp').getAttribute('aria-checked') === 'false', 'sidebar placement is independent of existing placements')
    await click(button('保存', q('.rec-modal'))); await until(() => !q('.rec-modal'))
    check(calls.filter(([kind]) => kind === 'recommend').at(-1)[2].sidebarRecommended === true, 'saving sends administrator sidebar placement')
    await click(q('.plugin-cover-actions button')); await until(() => q('.rec-modal'))
    await click(button('取消推荐', q('.rec-modal'))); await until(() => !q('.rec-modal'))
    check(appFixture.catalogPolicy.sidebarRecommended === false, 'cancel recommendation removes sidebar placement too')
    await escape()
    composePlacements.set('contracts', true)
    recommendationFails = true
    await open('contracts')
    await until(() => q('.plugin-cover-actions button') && !q('.plugin-cover-actions button').disabled)
    check(Boolean(button('推荐设置', q('.plugin-cover-actions'))) && !q('.plugin-recommend-status'), 'failed initial lookup does not claim the app is unrecommended')
    const writesBeforeRetry = calls.filter(([kind]) => kind === 'recommend').length
    await click(q('.plugin-cover-actions button'))
    check(!q('.rec-modal') && calls.filter(([kind]) => kind === 'recommend').length === writesBeforeRetry, 'failed settings lookup does not open an empty editable draft or write placements')
    recommendationFails = false
    await click(q('.plugin-cover-actions button')); await until(() => q('.rec-modal'))
    check(q('#optCompose').getAttribute('aria-checked') === 'true', 'retry recovers the saved compose placement')
    await escape()
    for (const [locale, status, edit] of [['en-US', 'Recommended', 'Edit']]) {
      setLocale(locale); await pause()
      check(q('.plugin-recommend-status')?.textContent === status && Boolean(button(edit, q('.plugin-cover-actions'))), 'recommendation state follows locale ' + locale)
      noOverflow()
    }
    setLocale('zh-CN'); await pause(); await escape()
    let releaseRecommendation
    recommendationGate = new Promise(resolve => { releaseRecommendation = resolve })
    await open('contracts')
    check(q('.plugin-cover-actions button').disabled && !button('推荐', q('.plugin-cover-actions')), 'pending lookup never offers an unconfirmed recommendation action')
    await escape(); await open('prototype')
    recommendationGate = null
    releaseRecommendation()
    await until(() => q('.plugin-cover-actions button') && !q('.plugin-cover-actions button').disabled)
    check(Boolean(button('推荐', q('.plugin-cover-actions'))) && !q('.plugin-recommend-status') && !q('.rec-modal'), 'late lookup from a closed app cannot change another plugin or reopen settings')
    await escape(); await open('contracts')
    await until(() => q('.plugin-cover-actions button') && !q('.plugin-cover-actions button').disabled)
    noOverflow()
  } else if (view === 'recommend-en') {
    setLocale('en-US'); await pause()
    function compactRecommendation(label) {
      noOverflow()
      const status = q('.plugin-recommend-status').getBoundingClientRect()
      const action = q('.plugin-cover-actions button').getBoundingClientRect()
      const group = q('.plugin-recommend-control').getBoundingClientRect()
      check(Math.abs((status.top + status.bottom) / 2 - (action.top + action.bottom) / 2) <= 2, label + ': status and action stay on one row')
      check(group.height <= 44, label + ': control does not grow into a tall box')
      check(q('.plugin-cover-actions button').textContent === 'Edit', label + ': visible action uses compact English copy')
      check(q('.plugin-cover-actions button').getAttribute('aria-label').startsWith('Edit recommendation '), label + ': accessible name preserves the full action')
    }
    for (const featured of [false, true]) {
      composePlacements.set('contracts', true)
      appFixture.catalogPolicy.featured = featured
      appFixture.catalogPolicy.coverUrl = location.origin + '/soduwork.png'
      await open('contracts')
      await until(() => q('.plugin-cover-actions button') && !q('.plugin-cover-actions button').disabled)
      compactRecommendation(featured ? 'featured cover' : 'compose-only placement')
      q('.plugin-title-cover').style.width = '220px'
      compactRecommendation('constrained recommendation area')
      await click(q('.plugin-cover-actions button')); await until(() => q('.rec-modal'))
      const cover = q('.rec-modal input[type="url"]')
      const draft = location.origin + '/soduwork.png?draft=1'
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(cover, draft)
      cover.dispatchEvent(new Event('input', { bubbles: true })); await pause()
      setLocale('zh-CN'); await pause()
      check(q('.rec-modal input[type="url"]').value === draft && q('#optCompose').getAttribute('aria-checked') === 'true', 'switching to Chinese preserves the recommendation draft')
      setLocale('en-US'); await pause()
      check(q('.rec-modal input[type="url"]').value === draft, 'switching back to English preserves the recommendation draft')
      await click(q('.rec-foot-danger')); await until(() => !q('.rec-modal'))
      check(Boolean(button('Recommend', q('.plugin-cover-actions'))) && !q('.plugin-recommend-status'), 'unrecommended English action says Recommend')
      setLocale('zh-CN'); await pause()
      check(Boolean(button('推荐', q('.plugin-cover-actions'))) && !q('.plugin-recommend-status'), 'unrecommended Chinese action remains 推荐')
      setLocale('en-US'); await pause(); await escape()
    }
    composePlacements.set('contracts', true)
    appFixture.catalogPolicy.featured = false
    await open('contracts')
    await until(() => q('.plugin-cover-actions button') && !q('.plugin-cover-actions button').disabled)
    compactRecommendation('final English detail')
  } else if (view === 'featured-cover') {
    await open('contracts')
    await until(()=>q('.plugin-featured-cover .plugin-cover-preview[data-status="ready"]'))
    check(q('.plugin-featured-cover img').naturalWidth>0,'existing recommended application shows its cover when detail opens')
    const cover = q('.plugin-featured-cover'), action = button('编辑推荐', cover)
    check(Boolean(cover.closest('.plugin-titlebar-v3')), 'cover belongs to the top plugin summary')
    check(Boolean(action), 'recommendation action remains beside the plugin summary')
    const bounds = cover.getBoundingClientRect(), actionBounds = action.getBoundingClientRect()
    check(actionBounds.left >= bounds.left && actionBounds.right <= bounds.right && actionBounds.top >= bounds.top && actionBounds.bottom <= bounds.bottom, 'recommendation action stays within cover bounds')
    if (innerWidth > 640) check(bounds.left >= q('.plugin-title-copy').getBoundingClientRect().right, 'wide layout places cover to the right of the summary')
    check(!q('.plugin-title-aside .plugin-card-quick-action'), 'status row keeps only the primary action')
    for (const locale of ['en-US', 'zh-CN']) {
      setLocale(locale); await pause()
      noOverflow()
      const previewBounds = cover.querySelector('.plugin-cover-preview').getBoundingClientRect()
      const controls = cover.querySelector('.plugin-cover-actions').getBoundingClientRect()
      const group = cover.querySelector('.plugin-recommend-control').getBoundingClientRect()
      check(controls.top >= previewBounds.bottom - 1 && controls.top <= previewBounds.bottom + 1, locale + ': the artwork and action footer form one continuous card')
      check(group.top >= previewBounds.bottom + 8, locale + ': recommendation controls keep visible spacing below the artwork')
      check(group.left >= previewBounds.left - 1 && group.right <= previewBounds.right + 1, locale + ': recommendation controls align within the artwork width')
      check(cover.getBoundingClientRect().width <= 242, locale + ': the cover card remains compact beside the summary')
    }
  } else if (view === 'locale-review') {
    await click(q('#plugin-catalog-tab-app'))
    check(q('.plugin-card-name').textContent === '运营应用', 'imported app catalog reads Chinese metadata')
    setLocale('en-US'); await pause()
    check(q('.plugin-card-name').textContent === 'Operations App', 'catalog updates metadata on locale switch')
    await open('contracts')
    check(q('.plugin-title-copy h3').textContent.includes('Operations App'), 'detail reads English from selected manifest')
    const languageReview = all('details').find(item => item.querySelector('summary')?.textContent.includes('Language variants'))
    await click(languageReview.querySelector('summary'))
    check(languageReview.textContent.includes('运营应用') && languageReview.textContent.includes('운영 앱'), 'review exposes every declared language')
    await click(button('Reviews and versions', q('.plugin-detail-drawer')))
    check(q('.plugin-preview-setup').textContent.includes('Report language'), 'installation contract uses translated field labels')
    const history = all('details').find(item => item.querySelector('summary')?.textContent.includes('Version history'))
    await click(history.querySelector('summary'))
    await click(all('.plugin-version-main').find(item => item.textContent.includes('v1.1.0')))
    check(q('.plugin-title-copy h3').textContent.includes('Old Operations Plugin'), 'old review never borrows latest version translations')
    setLocale('zh-CN'); await pause()
    check(q('.plugin-title-copy h3').textContent.includes('旧运营插件'), 'open version review switches back to Chinese')
    setLocale('en-US'); await pause()
    await click(all('.plugin-version-main').find(item => item.textContent.includes('v1.2.0')))
    await click(button(tx('退回修改'), q('.plugin-review-callout')))
    await until(() => q('.modal-mask'))
    check(q('.modal').textContent.includes('Operations App'), 'review confirmation uses the localized immutable version name')
    await escape()
    q('.plugin-detail-drawer-body').scrollTop = 0
  } else if (view === 'app-review') {
    await open('contracts'); const drawer = q('.plugin-detail-drawer')
    check(q('.plugin-title-copy .plugin-app-tag')?.textContent === '应用', 'selected application version has a detail tag')
    await click(button('审核与版本', drawer))
    check(q('.plugin-review-callout .plugin-app-tag')?.textContent === '应用', 'application review reuses the plugin review callout with a tag')
    const disclosure = all('details').find(item => item.querySelector('summary')?.textContent.includes('版本记录与回退'))
    await click(disclosure.querySelector('summary'))
    const versionButtons = () => all('.plugin-version-main')
    await click(versionButtons().find(item => item.textContent.includes('v1.1.0')))
    check(!q('.plugin-title-copy .plugin-app-tag'), 'reviewing an older ordinary version does not borrow the latest app tag')
    await click(versionButtons().find(item => item.textContent.includes('v1.2.0')))
    check(Boolean(q('.plugin-title-copy .plugin-app-tag')), 'switching back restores the selected version app tag')
    await click(button('退回修改', q('.plugin-review-callout')))
    await until(() => q('.modal-mask'))
    check(q('.modal .plugin-app-tag')?.textContent === '应用', 'review confirmation identifies the application being reviewed')
    await escape()
    setLocale('en-US'); await pause()
    check(q('.plugin-title-copy .plugin-app-tag')?.textContent === 'App', 'application tag switches to English App')
    const stateNote = q('.plugin-title-state > span')
    check(stateNote.getBoundingClientRect().width >= Math.min(180, innerWidth - 100), 'review status remains readable beside the application identity')
  } else if (view === 'catalog-en') {
    setLocale('en-US'); await pause()
    check(q('[aria-label="Search plugins"]') !== null, 'catalog switches to English')
  } else if (view === 'contract' || view === 'contract-en') {
    await open('contracts'); await click(button('审核与版本', q('.plugin-detail-drawer')))
    const contract = q('.plugin-preview-setup')
    check(Boolean(contract) && all('.plugin-setup-field').length === 4, 'selected version installation preferences are present')
    check(!contract.querySelector('input,textarea,select,form,button'), 'install contract is read-only')
    check(contract.textContent.includes('默认值否') && contract.textContent.includes('默认值0'), 'false and zero defaults are visible')
    setLocale('en-US'); await pause()
    check(contract.textContent.includes('Installation settings') && contract.textContent.includes('Default valueNo'), 'open contract switches to English')
    check(contract.textContent.includes('合同审核的安装偏好') && contract.textContent.includes('报告语言'), 'publisher text remains unchanged')
    setLocale('zh-CN'); await pause()
    check(contract.textContent.includes('安装设置清单') && contract.textContent.includes('默认值否'), 'open contract switches back to Chinese')
    if (view === 'contract-en') { setLocale('en-US'); await pause() }
    contract.scrollIntoView({ block: 'start' }); q('.plugin-detail-drawer-body').scrollTop -= 100
  } else if (view === 'detail' || view === 'mobile-detail') {
    await open('slides')
  } else if (view === 'review' || view === 'nested') {
    await open('contracts'); await click(button('审核与版本', q('.plugin-detail-drawer')))
    if (view === 'nested') { await click(button('退回修改')); await until(() => q('.modal-mask')) }
  }
  await new Promise((resolve) => setTimeout(resolve, 350)); noOverflow()
} catch (error) { failures.push(error.stack || String(error)) }
document.getElementById('out').textContent = JSON.stringify({ passed: checks.length, failures, viewport: { width: innerWidth, clientWidth: document.documentElement.clientWidth }, calls }, null, 2)
document.documentElement.dataset.testComplete = failures.length ? 'failed' : 'passed'
