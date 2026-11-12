import { translateText as tx } from './i18n.js'
// Administration API client uses the Vite /api proxy and stores authentication and current-user permissions locally.
const TOKEN_KEY = 'soduwork_hub_admin_token'
const USER_KEY = 'soduwork_hub_admin_user'
let token = localStorage.getItem(TOKEN_KEY) || ''
let me = null
try { me = JSON.parse(localStorage.getItem(USER_KEY) || 'null') } catch (_e) { me = null }
const REQUEST_TIMEOUT = 30000
// Repository operations include GitLab authentication and paginated API reads.
const REPOSITORY_TIMEOUT = 180000

async function fetchSafe(path, options = {}, timeout = REQUEST_TIMEOUT, consume = responseData) {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeout)
  try {
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    const res = await fetch(path, { ...options, signal })
    // Keep cancellation active until the response body has been consumed.
    if (res.status === 401) res.body?.cancel().catch(() => {})
    const data = res.status === 401 ? null : await consume(res)
    return { res, data }
  } catch (error) {
    if (options.signal?.aborted) throw error
    if (error && error.name === 'AbortError') throw new Error(tx("请求超时，请稍后重试"))
    throw new Error(tx("无法连接 SoduWork 服务，请检查后台地址或网络"))
  } finally {
    window.clearTimeout(timer)
  }
}

async function responseData(res) {
  const text = await res.text()
  if (!text) return null
  try { return JSON.parse(text) } catch (_error) {
    return { detail: text.trim().slice(0, 300) || `HTTP ${res.status}` }
  }
}

function responseError(res, data) {
  let detail = data && typeof data === 'object' ? data.detail : ''
  if (Array.isArray(detail)) detail = detail.map((item) => item && item.msg || String(item || '')).filter(Boolean).join('；')
  else if (detail && typeof detail === 'object') detail = detail.message || ''
  if (typeof detail !== 'string' || /^\s*</.test(detail)) detail = ''
  const error = new Error(detail || tx("请求失败（HTTP {0}）", [res.status]))
  error.status = res.status
  error.requestId = res.headers.get('X-Request-ID') || ''
  return error
}

export function getToken() { return token }
export function setToken(t) {
  token = t || ''
  if (t) localStorage.setItem(TOKEN_KEY, t)
  else localStorage.removeItem(TOKEN_KEY)
}
export function getUser() { return me }
export function setUser(u) {
  me = u || null
  if (u) localStorage.setItem(USER_KEY, JSON.stringify(u))
  else localStorage.removeItem(USER_KEY)
}
// Superadministrators bypass permission-point checks; other users require explicit permissions.
export function can(key) { return !!(me && (me.isSuper || (me.permissions || []).includes(key))) }

async function call(method, path, body, timeout = REQUEST_TIMEOUT) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = 'Bearer ' + token
  const { res, data } = await fetchSafe('/api/v1' + path, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  }, timeout)
  if (res.status === 401) {
    setToken(''); setUser('')
    window.dispatchEvent(new Event('soduwork-hub-unauth'))
    throw new Error(tx("登录已失效，请重新登录"))
  }
  if (!res.ok) throw responseError(res, data)
  return data
}

async function upload(path, file) {
  const fd = new FormData(); fd.append('file', file)
  const headers = {}; if (token) headers.Authorization = 'Bearer ' + token
  const { res, data } = await fetchSafe('/api/v1' + path, { method: 'POST', headers, body: fd }, 90000)
  if (res.status === 401) {
    setToken(''); setUser(''); window.dispatchEvent(new Event('soduwork-hub-unauth'))
    throw new Error(tx("登录已失效，请重新登录"))
  }
  if (!res.ok) throw responseError(res, data)
  return data
}


async function uploadForm(path, form, timeout = 120000) {
  const headers = {}; if (token) headers.Authorization = 'Bearer ' + token
  const { res, data } = await fetchSafe('/api/v1' + path, {
    method: 'POST', headers, body: form,
  }, timeout)
  if (res.status === 401) {
    setToken(''); setUser(''); window.dispatchEvent(new Event('soduwork-hub-unauth'))
    throw new Error(tx("登录已失效，请重新登录"))
  }
  if (!res.ok) throw responseError(res, data)
  return data
}
async function download(path, filename, timeout = 120000) {
  const headers = {}; if (token) headers.Authorization = 'Bearer ' + token
  const { res, data } = await fetchSafe('/api/v1' + path, { headers }, timeout,
    response => response.ok ? response.blob() : responseData(response))
  if (res.status === 401) {
    setToken(''); setUser(''); window.dispatchEvent(new Event('soduwork-hub-unauth'))
    throw new Error(tx("登录已失效，请重新登录"))
  }
  if (!res.ok) throw responseError(res, data)
  const url = URL.createObjectURL(data)
  const link = document.createElement('a')
  link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const api = {
  legalDocument: kind => call('GET', '/admin/legal-documents/' + encodeURIComponent(kind)),
  saveLegalDraft: (kind, body) => call('PUT', '/admin/legal-documents/' + encodeURIComponent(kind) + '/draft', body),
  publishLegalDocument: (kind, body) => call('POST', '/admin/legal-documents/' + encodeURIComponent(kind) + '/publish', body),
  legalDocumentVersion: id => call('GET', '/admin/legal-documents/versions/' + encodeURIComponent(id)),
  cancelLegalPublication: id => call('POST', '/admin/legal-documents/versions/' + encodeURIComponent(id) + '/cancel', {}),
  accountPrivacyRequests: () => call('GET', '/admin/account-privacy-requests'),
  retryAccountPrivacyRequest: (id) => call('POST', '/admin/account-privacy-requests/' + encodeURIComponent(id) + '/retry', {}),
  mailSettings: () => call('GET', '/admin/mail-settings'),
  saveMailSettings: (body) => call('PUT', '/admin/mail-settings', body),
  testMailSettings: (recipient) => call('POST', '/admin/mail-settings/test', { recipient }),
  mailDeliveries: () => call('GET', '/admin/mail-deliveries'),
  accountLegal: () => call('GET', '/admin/account-legal'),
  saveAccountLegal: (body) => call('PUT', '/admin/account-legal', body),
  health: async () => {
    const { res, data } = await fetchSafe('/healthz', {}, 6000)
    if (!res.ok) throw responseError(res, data)
    return data
  },
  login: (user, pass) => call('POST', '/admin/login', { user, pass }),
  me: () => call('GET', '/admin/me'),
  authProviders: () => call('GET', '/auth/providers'),
  operationsOverview: () => call('GET', '/admin/operations/overview'),
  operationsInsights: () => call('GET', '/admin/operations/insights'),
  identityProviders: () => call('GET', '/admin/identity-providers'),
  createIdentityProvider: (b) => call('POST', '/admin/identity-providers', b),
  updateIdentityProvider: (id, b) => call('PATCH', '/admin/identity-providers/' + encodeURIComponent(id), b),
  probeIdentityProvider: (id) => call('POST', '/admin/identity-providers/' + encodeURIComponent(id) + '/probe', {}),
  deleteIdentityProvider: (id) => call('DELETE', '/admin/identity-providers/' + encodeURIComponent(id)),
  // Organization hierarchy.
  orgs: () => call('GET', '/admin/orgs'),
  createOrg: (b) => call('POST', '/admin/orgs', b),
  updateOrg: (id, b) => call('PATCH', '/admin/orgs/' + id, b),
  deleteOrg: (id) => call('DELETE', '/admin/orgs/' + id),
  // Roles and permission points.
  roles: () => call('GET', '/admin/roles'),
  permissions: () => call('GET', '/admin/permissions'),
  createRole: (b) => call('POST', '/admin/roles', b),
  updateRole: (id, b) => call('PATCH', '/admin/roles/' + id, b),
  deleteRole: (id) => call('DELETE', '/admin/roles/' + id),
  // Users.
  users: () => call('GET', '/admin/users'),
  createUser: (b) => call('POST', '/admin/users', b),
  updateUser: (id, b) => call('PATCH', '/admin/users/' + id, b),
  // Occupational profiles describe work without granting permissions; scenarios link intent, capabilities, workflows, and delivery criteria.
  workCatalog: (orgId = '') => call('GET', '/admin/work-catalog' +
    (orgId ? '?orgId=' + encodeURIComponent(orgId) : '')),
  createProfession: (b) => call('POST', '/admin/work-catalog/professions', b),
  updateProfession: (id, b) => call('PATCH', '/admin/work-catalog/professions/' + encodeURIComponent(id), b),
  deleteProfession: (id) => call('DELETE', '/admin/work-catalog/professions/' + encodeURIComponent(id)),
  createWorkScenario: (b) => call('POST', '/admin/work-catalog/scenarios', b),
  updateWorkScenario: (id, b) => call('PATCH', '/admin/work-catalog/scenarios/' + encodeURIComponent(id), b),
  deleteWorkScenario: (id) => call('DELETE', '/admin/work-catalog/scenarios/' + encodeURIComponent(id)),
  // Compatibility occupation list for the user editor.
  positions: () => call('GET', '/admin/positions'),
  // Responsibility domains, modules, and skills for task assignment.
  domains: () => call('GET', '/admin/domains'),
  createDomain: (b) => call('POST', '/admin/domains', b),
  updateDomain: (id, b) => call('PATCH', '/admin/domains/' + id, b),
  deleteDomain: (id) => call('DELETE', '/admin/domains/' + id),
  audit: (p) => call('GET', '/admin/audit' + (p && Object.keys(p).length ? '?' + new URLSearchParams(p).toString() : '')),
  quotaPlans: () => call('GET', '/admin/quotas'),
  saveQuotaPlans: (body) => call('PUT', '/admin/quotas', body),
  quotaMembers: (params = {}) => call('GET', '/admin/quotas/members' +
    (Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : '')),
  quotaMember: (id) => call('GET', '/admin/quotas/members/' + encodeURIComponent(id)),
  assignQuota: (id, body) => call('PUT', '/admin/quotas/members/' + encodeURIComponent(id), body),
  // Organization memory is restricted to administrators with org.manage.
  // Superadministrators may pass orgId to inspect another organization's memory.
  orgMemories: ({ archived = false, offset = 0, orgId = '' } = {}) => call('GET', '/admin/org-memory?' + new URLSearchParams({ archived: String(Boolean(archived)), offset: String(offset), ...(orgId ? { orgId } : {}) }).toString()),
  createOrgMemory: (body) => call('POST', '/admin/org-memory', body),
  updateOrgMemory: (id, body) => call('PUT', '/admin/org-memory/' + encodeURIComponent(id), body),
  deleteOrgMemory: (id) => call('DELETE', '/admin/org-memory/' + encodeURIComponent(id)),

  // Task overview and execution network.
  tasks: (query = '') => call('GET', '/admin/tasks' + query),
  clients: () => call('GET', '/admin/clients'),
  clientsPage: (p = {}) => call('GET', '/admin/clients?' + new URLSearchParams({
    paged: 'true', page: p.page || 1, pageSize: p.pageSize || 25,
    state: p.state || 'all', form: p.form || 'all', q: p.q || '',
  }).toString()),
  clientAuthPolicy: () => call('GET', '/admin/client-auth-policy'),
  saveClientAuthPolicy: (b) => call('PUT', '/admin/client-auth-policy', b),
  teamModuleScope: () => call('GET', '/admin/team-module-scope'),
  setTeamModuleScope: (scope) => call('PUT', '/admin/team-module-scope', { scope }),
  // Retain legacy managed events only in server compatibility and audit history.
  // Project task dependencies and layered graph views.
  projects: () => call('GET', '/admin/projects'),
  projectOwners: () => call('GET', '/admin/project-owner-options'),
  createProject: (b) => call('POST', '/admin/projects', b),
  projectDetail: (id) => call('GET', '/admin/projects/' + id),
  addProjectTask: (id, b) => call('POST', '/admin/projects/' + id + '/tasks', b),
  deleteProject: (id) => call('DELETE', '/admin/projects/' + id),
  updateProject: (id, b) => call('PUT', '/admin/projects/' + id, b),
  // Manage repositories within projects and associate them with execution-runtime projects.
  repos: (pid) => call('GET', '/admin/projects/' + pid + '/repos'),
  addRepo: (pid, b) => call('POST', '/admin/projects/' + pid + '/repos', b),
  updateRepo: (rid, b) => call('PUT', '/admin/repos/' + rid, b),
  deleteRepo: (rid) => call('DELETE', '/admin/repos/' + rid),
  repositoryCatalog: (integrationId = '', search = '') => call('GET', '/admin/repository-catalog?' + new URLSearchParams({
    ...(integrationId ? { integrationId } : {}), ...(search ? { search } : {}),
  })),
  syncRepositoryCatalog: (integrationId, clientId = '') => call('POST', '/admin/integrations/' + integrationId + '/repositories/sync', clientId ? { clientId } : {}, REPOSITORY_TIMEOUT),
  savePullAccount: (integrationId, b) => call('POST', '/admin/integrations/' + integrationId + '/pull-account', b),
  testPullAccount: (integrationId, b = {}) => call('POST', '/admin/integrations/' + integrationId + '/pull-account/test', b, REPOSITORY_TIMEOUT),
  repositoryIssueSync: (catalogId) => call('GET', '/admin/repository-catalog/' + encodeURIComponent(catalogId) + '/issue-sync'),
  saveRepositoryIssueSync: (catalogId, body) => call('PUT', '/admin/repository-catalog/' + encodeURIComponent(catalogId) + '/issue-sync', body, REPOSITORY_TIMEOUT),
  runRepositoryIssueSync: (catalogId) => call('POST', '/admin/repository-catalog/' + encodeURIComponent(catalogId) + '/issue-sync/run', {}, REPOSITORY_TIMEOUT),
  mapRepositoryIssueMember: (catalogId, externalUserId, body) => call('PUT', '/admin/repository-catalog/' + encodeURIComponent(catalogId) + '/issue-sync/members/' + encodeURIComponent(externalUserId), body),
  repositoryBranches: (catalogId, clientId = '') => call('GET', '/admin/repository-catalog/' + catalogId + '/branches?' + new URLSearchParams(clientId ? { clientId } : {}), undefined, REPOSITORY_TIMEOUT),
  addRepoFromCatalog: (pid, b) => call('POST', '/admin/projects/' + pid + '/repos/from-catalog', b),
  copyRepo: (rid, b) => call('POST', '/admin/repos/' + rid + '/copy', b),
  aiProjects: () => call('GET', '/admin/ai-projects'),
  clientDetail: (id) => call('GET', '/admin/clients/' + id),
  pushClient: (id, b) => call('POST', '/admin/clients/' + id + '/push', b),
  clientUpdates: (id) => call('GET', '/admin/clients/' + encodeURIComponent(id) + '/updates'),
  requestClientUpdate: (id, b = {}) => call('POST', '/admin/clients/' + encodeURIComponent(id) + '/updates', b),
  // List, stage, enable, and disable signed client releases; the server revalidates signatures on enablement.
  clientReleases: () => call('GET', '/admin/client-releases'),
  clientReleaseNotes: () => call('GET', '/admin/client-release-notes'),
  downloadClientRelease: (id, filename) => download('/admin/client-releases/' + encodeURIComponent(id) + '/download', filename, 900000),
  clientUpdateAttempts: (filter = {}) => {
    const q = new URLSearchParams()
    if (filter.releaseId) q.set('releaseId', filter.releaseId)
    if (filter.state && filter.state !== 'all') q.set('state', filter.state)
    const qs = q.toString()
    return call('GET', '/admin/client-update-attempts' + (qs ? '?' + qs : ''))
  },
  setClientReleaseEnabled: (id, enabled) => call(
    'PATCH', '/admin/client-releases/' + encodeURIComponent(id), { enabled }),
  uploadClientRelease: (bundleFile, installerFile) => {
    const form = new FormData()
    form.append('bundle', bundleFile)
    form.append('installer', installerFile)
    return uploadForm('/admin/client-releases/upload', form, 900000)
  },
  assignClient: (id, userId) => call('POST', '/admin/clients/' + id + '/assign', { userId }),
  revokeClient: (id) => call('POST', '/admin/clients/' + id + '/revoke', {}),
  resetClientEnrollment: (id) => call('POST', '/admin/clients/' + id + '/reset-enrollment', {}),
  // Enterprise AI ledger views by member, scenario, agent, and model.
  usageOverview: ({ days = 30, userId = '', source = '', agent = '' } = {}) => {
    const query = new URLSearchParams()
    query.set('days', String(days))
    if (userId) query.set('user_id', userId)
    if (source) query.set('source', source)
    if (agent) query.set('agent', agent)
    return call('GET', '/admin/usage/overview?' + query.toString())
  },
  adminRunners: () => call('GET', '/admin/runners'),
  cloudRunnerAssignees: (q = '') => call('GET', '/admin/cloud-runners/assignees?q=' + encodeURIComponent(q)),
  cloudRunnerAvailability: (row, enabled) => call('POST', '/admin/cloud-runners/' +
    encodeURIComponent(row.runnerId) + '/availability', { expectedOwnerUserId: row.ownerUserId, enabled }),
  reassignCloudRunner: (row, targetUserId) => call('POST', '/admin/cloud-runners/' +
    encodeURIComponent(row.runnerId) + '/reassign', { expectedOwnerUserId: row.ownerUserId, targetUserId }),
  provisionCloudRunner: (row, body) => call('POST', '/admin/cloud-runners/' +
    encodeURIComponent(row.runnerId) + '/provision', { expectedOwnerUserId: row.ownerUserId, ...body }),
  adminRunnerProbe: (id) => call('POST', '/admin/runners/' + encodeURIComponent(id) + '/probe', {}),
  revokeRunnerKey: (id) => call('POST', '/admin/runners/' + encodeURIComponent(id) + '/revoke-key', {}),
  // Register standalone execution machines and issue installation credentials; runnerId selects rotation.
  enrollRunner: (b) => call('POST', '/admin/runners/enroll', b),
  // Webhook channels for delivery alerts.
  alertConfig: () => call('GET', '/admin/alert-config'),
  saveAlertConfig: (url) => call('PUT', '/admin/alert-config', { url }),
  testAlert: () => call('POST', '/admin/alert-config/test', {}),
  runnerMode: (id, mode) => call('POST', '/admin/runners/' + encodeURIComponent(id) + '/mode', { mode }),
  installRunnerComponent: (id, key) => call('POST', '/admin/runners/' +
    encodeURIComponent(id) + '/components/' + encodeURIComponent(key) + '/install'),
  runnerComponentJob: (id, jobId) => call('GET', '/admin/runners/' +
    encodeURIComponent(id) + '/components/jobs/' + encodeURIComponent(jobId)),
  deleteRunner: (id) => call('DELETE', '/admin/runners/' + encodeURIComponent(id)),
  // Available agent catalog.
  aiAgents: () => call('GET', '/admin/ai-agents'),
  // Read credential references for plugin binding without secret values.
  secretReferences: () => call('GET', '/admin/secret-references'),
  // Plugin lifecycle: isolated import, version trust, scope binding, and task execution.
  plugins: () => call('GET', '/admin/plugins'),
  pluginGovernance: () => call('GET', '/admin/plugins/governance'),
  pluginDetail: (id) => call('GET', '/admin/plugins/' + id),
  pluginRollout: (id, targetVersionId) => call(
    'GET', '/admin/plugins/' + id + '/rollout?' +
    new URLSearchParams({ targetVersionId })),
  applyPluginRollout: (id, body) => call(
    'POST', '/admin/plugins/' + id + '/rollout', body),
  pluginAccessPolicy: (id) => call('GET', '/admin/plugins/' + encodeURIComponent(id) + '/access-policy'),
  pluginAccessCandidates: (id) => call('GET', '/admin/plugins/' + encodeURIComponent(id) + '/access-candidates'),
  updatePluginAccessPolicy: (id, body) => call('PATCH', '/admin/plugins/' + encodeURIComponent(id) + '/access-policy', body),
  updatePluginCatalogPolicy: (id, body) => call(
    'PATCH', '/admin/plugins/' + id + '/catalog-policy', body),
  pluginRecommendation: (id) => call('GET', '/admin/plugins/' + encodeURIComponent(id) + '/recommendation'),
  deletePlugin: (id, force = false) => call('DELETE', '/admin/plugins/' + encodeURIComponent(id) + (force ? '?force=true' : '')),
  pluginCategories: () => call('GET', '/admin/plugins/categories'),
  updatePluginCategories: (items) => call(
    'PUT', '/admin/plugins/categories', { items }),
  bulkImportPlugins: (files, rightsConfirmed = false, sourceLabel = '') => {
    const form = new FormData()
    Array.from(files || []).forEach((file) => form.append('files', file))
    form.append('rightsConfirmed', rightsConfirmed ? 'true' : 'false')
    form.append('sourceLabel', sourceLabel || '')
    return uploadForm('/admin/plugins/bulk-import', form, 180000)
  },
  pluginActivity: (id, limit = 40) => call('GET', '/admin/plugins/' + id + '/activity?limit=' + limit),
  importPlugin: (file) => upload('/admin/plugins/import', file),
  downloadPluginStarter: () => download('/admin/plugins/starter', 'soduwork-workflow-starter.soduwork-plugin'),
  pluginPublishers: () => call('GET', '/admin/plugin-publishers'),
  pluginPublisherCandidate: (versionId) =>
    call('GET', '/admin/plugins/versions/' + versionId + '/publisher-candidate'),
  trustPluginPublisherCandidate: (versionId, body) =>
    call('POST', '/admin/plugins/versions/' + versionId + '/publisher-candidate/trust', body),
  createPluginPublisher: (body) => call('POST', '/admin/plugin-publishers', body),
  revokePluginPublisher: (id, note = '') => call(
    'POST', '/admin/plugin-publishers/' + id + '/revoke', { note }),
  trustPluginVersion: (id, enabled, confirmWithoutEvaluation = false, note = '') => call(
    'POST', '/admin/plugins/versions/' + id + '/trust',
    { enabled, confirmWithoutEvaluation, note }),
  simulatePluginVersion: (id, body) => call('POST', '/admin/plugins/versions/' + id + '/simulate', body),
  pluginMcpTools: (id) => call('GET', '/admin/plugins/versions/' + id + '/mcp-tools'),
  pluginEvaluations: (id) => call('GET', '/admin/plugins/versions/' + id + '/evaluations'),
  pluginVersionAudience: (id) => call('GET', '/admin/plugins/versions/' + id + '/audience'),
  startPluginEvaluation: (id, caseKey, body = {}) => call(
    'POST', '/admin/plugins/versions/' + id + '/evaluations/' +
    encodeURIComponent(caseKey) + '/start', body),
  reviewPluginEvaluation: (id, decision, note = '') => call(
    'POST', '/admin/plugins/evaluation-runs/' + id + '/review', { decision, note }),
  cancelPluginEvaluation: (id) => call(
    'POST', '/admin/plugins/evaluation-runs/' + id + '/cancel', {}),
  bindPlugin: (id, b) => call('POST', '/admin/plugins/' + id + '/bindings', b),
  updatePluginBinding: (id, b) => call('PATCH', '/admin/plugins/bindings/' + id, b),
  pluginRuns: (taskId = '') => call('GET', '/admin/plugin-runs' +
    (taskId ? '?taskId=' + encodeURIComponent(taskId) : '')),
  pluginRun: (id) => call('GET', '/admin/plugin-runs/' + id),
  startPluginRun: (taskId, b) => call('POST', '/admin/tasks/' + taskId + '/plugin-runs', b),
  // Delivery overview uses shared task-state semantics for attention, active work, and completion.
  // Workflow retries retain server approval and permission checks.
  retryRunGate: (runId, nodeKey = '', options = {}) => call(
    'POST', '/admin/plugin-runs/' + encodeURIComponent(runId) + '/retry-gate',
    { nodeKey, resumeRework: !!options.resumeRework }),
  /* Separate provider credentials from models; secrets are write-only. */
  modelCatalog: () => call('GET', '/admin/model-catalog'),
  checkModelCapabilities: (body) => call('POST', '/admin/model-capabilities/check', body, 140000),
  saveModelProvider: (pid, b) => call('PUT', '/admin/model-providers/' + encodeURIComponent(pid), b),
  deleteModelProvider: (pid, revision) => call('DELETE', '/admin/model-providers/' + encodeURIComponent(pid) + '?expectedRevision=' + encodeURIComponent(revision)),
  saveModelDef: (b) => call('PUT', '/admin/model-defs', b),
  deleteModelDef: (mid, revision) => call('DELETE', '/admin/model-defs/' + encodeURIComponent(mid) + '?expectedRevision=' + encodeURIComponent(revision)),
  modelRuntime: () => call('GET', '/admin/model-runtime'),
  saveModelRuntime: (body) => call('PUT', '/admin/model-runtime', body),
  // Discover and enable compatible Agent Skills.
  // MCP tool sources return masked environment values.
  mcpServers: () => call('GET', '/admin/mcp-servers'),
  upsertMcpServer: (server, original) => call('POST', '/admin/mcp-servers/upsert', { server, original }),
  deleteMcpServer: (id, original) => call('DELETE', '/admin/mcp-servers/' + encodeURIComponent(id), { original }),
  probeMcpServer: (spec) => call('POST', '/admin/mcp-servers/probe', spec, 150000),
  mcpSubmissions: () => call('GET', '/admin/capabilities/mcp/submissions'),
  reviewMcpSubmission: (id, body) => call('POST', '/admin/capabilities/mcp/submissions/' + encodeURIComponent(id) + '/review', body, 150000),
  skills: () => call('GET', '/admin/skills'),
  saveSkills: (cfg) => call('PUT', '/admin/skills', { cfg }),
  skillSubmissions: () => call('GET', '/admin/capabilities/skill-submissions'),
  skillSubmission: (id) => call('GET', '/admin/capabilities/skill-submissions/' + encodeURIComponent(id)),
  skillSubmissionContent: (id, checksum, path, offset = 0) => call('GET',
    '/admin/capabilities/skill-submissions/' + encodeURIComponent(id) + '/content?' +
    new URLSearchParams({ checksum, path, offset })),
  reviewSkillSubmission: (id, body) => call('POST',
    '/admin/capabilities/skill-submissions/' + encodeURIComponent(id) + '/review', body),
  downloadSkillSubmission: async (id, checksum, path, name) => {
    const { res, data } = await fetchSafe('/api/v1/admin/capabilities/skill-submissions/' +
      encodeURIComponent(id) + '/download?' + new URLSearchParams({ checksum, path: path || '' }),
      { headers: { Authorization: 'Bearer ' + token } }, 60000,
      response => response.ok ? response.blob() : responseData(response))
    if (!res.ok) throw responseError(res, data)
    const url = URL.createObjectURL(data)
    const link = document.createElement('a')
    link.href = url; link.download = path ? path.split('/').pop() : name + '.skill'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 30000)
  },
  capabilityCatalog: () => call('GET', '/admin/capabilities'),
  saveCapabilityPolicy: (cfg) => call('PUT', '/admin/capabilities', { cfg }),
  preflightCapabilitySkill: (file) => upload('/admin/capabilities/skills/preflight', file),
  importCapabilitySkill: (file) => upload('/admin/capabilities/skills/import', file),
  preflightCapabilityMcp: (file) => upload('/admin/capabilities/mcp/preflight', file),
  importCapabilityMcp: (file) => upload('/admin/capabilities/mcp/import', file),
  // Configure development instructions globally or per repository, separately from plugin workflow orchestration.
  devFlow: () => call('GET', '/admin/dev-flow'),
  previewDevFlow: (b) => call('POST', '/admin/dev-flow/preview', b),
  automationTemplates: () => call('GET', '/admin/automation-templates'),
  saveAutomationTemplates: (items) => call('PUT', '/admin/automation-templates', { items }),
  // Integrations and bindings.
  integrations: () => call('GET', '/admin/integrations'),
  createIntegration: (b) => call('POST', '/admin/integrations', b),
  toggleIntegration: (id, enabled) => call('PATCH', '/admin/integrations/' + id, { enabled }),
  updateIntegration: (id, b) => call('PATCH', '/admin/integrations/' + id, b),
  rotateIntegrationToken: (id) => call('POST', '/admin/integrations/' + id + '/token/rotate', {}),
  pullIntegration: (id) => call('POST', '/admin/integrations/' + id + '/pull', {}),
  deleteIntegration: (id) => call('DELETE', '/admin/integrations/' + id),
  // Organization defaults for reports and compatibility execution; model catalogs are managed elsewhere.
  llmConfig: () => call('GET', '/admin/llm-config'),
  saveLlmConfig: (b) => call('PUT', '/admin/llm-config', b),
  // Map external projects to repositories and configure batch dispatch.
  repoBindings: (iid) => call('GET', '/admin/repo-bindings' + (iid ? '?integrationId=' + encodeURIComponent(iid) : '')),
  saveRepoBinding: (b) => call('POST', '/admin/repo-bindings', b),
  deleteRepoBinding: (id) => call('DELETE', '/admin/repo-bindings/' + id),
  repoMapPending: () => call('GET', '/admin/repo-bindings/pending'),
  // Execute only with run=true and the server AUTOBATCH_ENABLED switch enabled.
  autobatch: (run) => call('GET', '/admin/autobatch' + (run ? '?run=true' : '')),
  bindings: () => call('GET', '/admin/bindings'),
  deleteBinding: (id) => call('DELETE', '/admin/bindings/' + id),
  unassigned: () => call('GET', '/admin/unassigned'),
  assign: (id, b) => call('POST', '/admin/unassigned/' + id + '/assign', b),
}
