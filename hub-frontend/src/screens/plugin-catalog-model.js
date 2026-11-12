import { catalogPlugin } from '../plugin-locales.js'
import { translateText as tx, localeMap, getLocale, t } from '../i18n.js'
export const SOURCE_LABELS = localeMap(() => ({
  builtin: 'SoduWork 内置', soduwork: 'SoduWork 原生', adapter: '兼容导入', codex: 'Codex', claude: 'Claude',
}))

export const CATALOG_FILTERS = localeMap(() => ([
  ['all', '全部插件'], ['pending', '待审核'], ['published', '已上架'], ['featured', '已推荐'],
  ['attention', '待处理'], ['disabled', '未开放'],
]))

export function pluginKind(plugin) {
  if (plugin.latestVersion?.manifest?.template === 'app') {
    return { key: 'app', label: t('plugin.type.app', '应用'), icon: 'grid' }
  }
  const cap = plugin.latestVersion?.capabilities || {}
  if (cap.hasWorkflow !== false && (cap.executionMode === 'workflow' || cap.hasWorkflow === true)) {
    return { key: 'workflow', label: tx("工作流"), icon: 'tree' }
  }
  if ((cap.mcpServers || []).length) return { key: 'connector', label: tx("连接工具"), icon: 'link' }
  return { key: 'skill', label: tx("AI 能力"), icon: 'sparkle' }
}

export function pluginSource(plugin) {
  if (plugin.orgId) return { key: 'enterprise', label: tx("企业提交") }
  if (['builtin', 'soduwork'].includes(plugin.sourceKind)) return { key: 'builtin', label: tx("SoduWork 内置") }
  return { key: 'external', label: SOURCE_LABELS[plugin.sourceKind] || tx("外部导入") }
}

export function pluginPublication(plugin) {
  const version = plugin.latestVersion
  if (!version) return { key: 'disabled', label: tx("暂无版本") }
  if (version.trustState === 'quarantined') return { key: 'pending', label: tx("待审核") }
  if (version.trustState === 'revoked') return { key: 'disabled', label: tx("版本已撤销") }
  if (plugin.enabled && version.enabled && version.trustState === 'approved') {
    return plugin.catalogPolicy?.installation === 'not_available'
      ? { key: 'disabled', label: tx("未开放安装") }
      : { key: 'published', label: tx("已上架") }
  }
  return { key: 'disabled', label: tx("未启用") }
}

export function pluginIssues(queues = {}) {
  const result = {}
  const seen = new Set()
  Object.entries(queues || {}).forEach(([kind, values]) => {
    if (!Array.isArray(values)) return
    values.forEach((item) => {
      if (!item?.pluginId) return
      const identity = `${item.pluginId}:${item.id || `${kind}:${item.versionId || ''}:${item.runId || ''}:${item.title || ''}`}`
      if (seen.has(identity)) return
      seen.add(identity)
      ;(result[item.pluginId] ||= []).push(item)
    })
  })
  return result
}

export function selectCatalog(items = [], queues = {}, filters = {}) {
  const { query = '', status = 'all', source = 'all', kind = 'all', category = 'all', sort = 'updated', catalogType = 'all' } = filters
  const issues = pluginIssues(queues)
  const needle = query.trim().toLocaleLowerCase()
  const rows = items.map(plugin => catalogPlugin(plugin, getLocale())).map((plugin) => ({
    plugin, source: pluginSource(plugin), kind: pluginKind(plugin),
    category: String(plugin.catalogPolicy?.category || 'general'),
    publication: pluginPublication(plugin), issues: issues[plugin.id] || [],
  })).filter((row) => {
    if (catalogType === 'app' && row.kind.key !== 'app') return false
    if (catalogType === 'plugin' && row.kind.key === 'app') return false
    if (source !== 'all' && row.source.key !== source) return false
    if (kind !== 'all' && row.kind.key !== kind) return false
    if (category !== 'all' && row.category !== category) return false
    const version = row.plugin.latestVersion || {}
    const cap = version.capabilities || {}
    return !needle || [row.plugin.name, row.plugin.description, row.plugin.qualifiedKey,
      row.plugin.key, row.source.label, row.kind.label, version.provenance?.publisherName,
      row.plugin.createdBy, row.category, ...(cap.skills || []), ...(cap.mcpServers || [])]
      .some((value) => String(value || '').toLocaleLowerCase().includes(needle))
  })
  const matchesStatus = (row, key) => key === 'all' || (key === 'featured'
    ? Boolean(row.plugin.catalogPolicy?.featured)
    : key === 'attention' ? row.issues.length > 0 : row.publication.key === key)
  const counts = Object.fromEntries(CATALOG_FILTERS.map(([key]) => [key, rows.filter((row) => matchesStatus(row, key)).length]))
  const shown = rows.filter((row) => matchesStatus(row, status))
  shown.sort((a, b) => {
    if (sort === 'name') return String(a.plugin.name || '').localeCompare(String(b.plugin.name || ''), getLocale())
    const updated = Number(b.plugin.updatedAt || 0) - Number(a.plugin.updatedAt || 0)
    return updated || String(a.plugin.id).localeCompare(String(b.plugin.id))
  })
  return { shown, counts }
}
