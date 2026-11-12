import { translateText as tx, localeMap, useLocale } from './i18n.js'
import React, { lazy, Suspense, useState, useEffect, useRef, useCallback } from 'react'
import { api, getToken, getUser, setUser, setToken, can } from './api.js'
import Login from './Login.jsx'
import LocaleSettings from './LocaleSettings.jsx'
import Landing from './Landing.jsx'
import { Icon, Loading, ThemeToggle, ToastHost } from './ui.jsx'
import { getLocale, t } from './i18n.js'
import { healthReleaseLabel } from './health-version.js'
import { MAX_STEP, MIN_STEP, readScaleStep, stepScale, subscribeScale } from './enlarge-theme.js'

// Lazy-load management pages so the login introduction does not bundle all plugin, automation, and organization code.
const Overview = lazy(() => import('./screens/Overview.jsx'))
const LegalDocuments = lazy(() => import('./screens/LegalDocuments.jsx'))
const IntegrationsHub = lazy(() => import('./screens/IntegrationsHub.jsx'))
const Clients = lazy(() => import('./screens/Clients.jsx'))
const ClientReleases = lazy(() => import('./screens/ClientReleases.jsx'))
const UsageCenter = lazy(() => import('./screens/UsageCenter.jsx'))
const QuotaManagement = lazy(() => import('./screens/QuotaManagement.jsx'))
const Orgs = lazy(() => import('./screens/Orgs.jsx'))
const Users = lazy(() => import('./screens/Users.jsx'))
const Roles = lazy(() => import('./screens/Roles.jsx'))
const Audit = lazy(() => import('./screens/Audit.jsx'))
const Projects = lazy(() => import('./screens/Projects.jsx'))
const Repositories = lazy(() => import('./screens/Repositories.jsx'))
const ModelCatalog = lazy(() => import('./screens/ModelCatalog.jsx'))
const PluginCenter = lazy(() => import('./screens/PluginCenter.jsx'))
const Capabilities = lazy(() => import('./screens/Skills.jsx'))
const OperationsCenter = lazy(() => import('./screens/OperationsCenter.jsx'))
const OperationsInsights = lazy(() => import('./screens/OperationsInsights.jsx'))
const AutomationTemplates = lazy(() => import('./screens/AutomationTemplates.jsx'))
const IdentityCenter = lazy(() => import('./screens/IdentityCenter.jsx'))
const MailSettings = lazy(() => import('./screens/MailSettings.jsx'))
const WorkCatalog = lazy(() => import('./screens/WorkCatalog.jsx'))
const OrgMemory = lazy(() => import('./screens/OrgMemory.jsx'))

let SSO_ERROR = ''
try {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const oidcToken = hash.get('sso')
  SSO_ERROR = hash.get('sso_error') || ''
  if (oidcToken) setToken(oidcToken)
  if (oidcToken || SSO_ERROR) window.history.replaceState({}, document.title, window.location.pathname + window.location.search)
} catch (_e) { /* old embedded browser: keep normal login */ }

/*
 * Administration owns enterprise configuration, runtime governance, and access auditing.
 * Daily tasks, inboxes, collaboration, and automation entry points belong to the client.
 */
const NAV = localeMap(() => ([
  { id: 'overview', label: '治理总览', sub: '企业 AI 运行与协同状态', icon: 'grid', Comp: Overview, group: '总览', perm: 'task.view' },
  { id: 'insights', label: '运营分析', sub: '采用度、插件使用、自动化健康与产出', icon: 'activity', Comp: OperationsInsights, group: '总览', perm: 'operations.view' },
  { id: 'automation-templates', label: '自动化模板', sub: '配置员工可直接套用的自动化工作模板', icon: 'sparkle', Comp: AutomationTemplates, group: 'AI 运行', perm: 'task.dispatch' },
  { id: 'operations', label: '运行监控', sub: 'Hub、Runner、请求与执行链路健康', icon: 'pulse', Comp: OperationsCenter, group: 'AI 运行', perm: 'operations.view' },
  { id: 'clients', label: '执行网络', sub: '集中管理员工终端、Runner 执行机与接单状态', icon: 'monitor', Comp: Clients, group: 'AI 运行', perm: 'client.view' },
  { id: 'client-releases', label: '客户端发布', sub: '上传已签名安装包、启用或停用各平台版本', icon: 'send', Comp: ClientReleases, group: 'AI 运行', perm: 'client.update' },
  { id: 'usage', label: '用量与成本', sub: '按成员、场景、Agent 与模型治理企业 AI 消耗', icon: 'chart', Comp: UsageCenter, group: 'AI 运行', perm: 'client.view' },
  { id: 'quotas', label: '额度管理', sub: '套餐、模型额度与成员分配', icon: 'chart', Comp: QuotaManagement, group: 'AI 运行', perm: 'quota.manage' },
  // Treat automation as a plugin execution mode rather than a separate capability catalog.
  { id: 'projects', label: '项目与仓库', sub: '项目、代码仓库、流程和发布目标的治理入口', icon: 'box', Comp: Projects, group: 'AI 运行', perm: 'task.view' },
  { id: 'repositories', label: '仓库目录', sub: '企业代码资产全量目录、同步健康与项目挂载', icon: 'file', Comp: Repositories, group: 'AI 运行', perm: 'task.view' },
  { id: 'models', label: '模型目录', sub: '模型服务与企业模型配置', icon: 'key', Comp: ModelCatalog, group: '能力配置', perm: 'integration.manage' },
  { id: 'plugins', label: '插件与应用', sub: '企业能力、工作流与运行治理', icon: 'plug', Comp: PluginCenter, group: '能力配置', perm: 'plugin.manage' },
  { id: 'capabilities', label: '能力目录', sub: '统一治理 Skill、连接器与企业开放策略', icon: 'layers', Comp: Capabilities, group: '能力配置', perm: 'integration.manage' },
  { id: 'integrations', label: '系统集成', sub: '外部业务系统、代码平台与消息通道', icon: 'link', Comp: IntegrationsHub, group: '能力配置', perm: 'integration.manage' },
  { id: 'orgs', label: '组织架构', sub: '部门层级与管理作用域', icon: 'tree', Comp: Orgs, group: '组织治理', perm: 'org.manage' },
  { id: 'org-memory', label: '\u7ec4\u7ec7\u8bb0\u5fc6', sub: '\u7ef4\u62a4\u4f01\u4e1a\u5171\u4eab\u7684\u89c4\u5219\u3001\u65b9\u6cd5\u4e0e\u4ea4\u4ed8\u7ecf\u9a8c\u6458\u8981', icon: 'memory', Comp: OrgMemory, group: '\u7ec4\u7ec7\u6cbb\u7406', perm: 'org.manage' },
  { id: 'work-catalog', label: '工作目录', sub: '职业画像、工作类型与默认交付标准', icon: 'sitemap', Comp: WorkCatalog, group: '组织治理', perm: 'work.catalog.manage' },
  { id: 'users', label: '用户管理', sub: '成员、部门与角色归属', icon: 'users', Comp: Users, group: '组织治理', perm: 'user.manage' },
  { id: 'roles', label: '角色权限', sub: '角色和最小权限策略', icon: 'shield', Comp: Roles, group: '组织治理', perm: 'role.manage' },
  { id: 'account-security', label: '账户与安全', sub: '注册邮件、协议与个人数据处理', icon: 'shield', Comp: MailSettings, group: '组织治理', perm: 'identity.manage' },
  { id: 'legal-documents', label: '协议与隐私政策', sub: '协议草稿、多语言发布与历史记录', icon: 'file', Comp: LegalDocuments, group: '组织治理', superOnly: true },
  { id: 'identity', label: '身份接入', sub: '企业 OIDC、账号映射与登录安全', icon: 'lock', Comp: IdentityCenter, group: '组织治理', perm: 'identity.manage' },
  { id: 'audit', label: '审计日志', sub: '关键操作与责任追溯', icon: 'ticket', Comp: Audit, group: '组织治理', perm: 'audit.view' },
]))

const LEGACY_SCREEN = {
  flows: 'plugins', automation: 'plugins', skills: 'capabilities', mcp: 'capabilities', schedules: 'plugins',
  tasks: 'overview', inbox: 'overview', subs: 'overview',
}
const normalizeScreen = (id) => LEGACY_SCREEN[id] || id
const canLeavePage = proceed => {
  let resumed = false
  return window.dispatchEvent(new CustomEvent('soduwork-before-admin-leave', {
    cancelable: true, detail: { proceed: () => { if (!resumed) { resumed = true; proceed() } } },
  }))
}

export default function App() {
  const uiLocale = useLocale();
  const [authed, setAuthed] = useState(!!getToken())
  const [showLogin, setShowLogin] = useState(!!SSO_ERROR)   // Explain SSO callback failures directly.
  const [me, setMe] = useState(getUser())
  const [health, setHealth] = useState({ state: 'checking', version: '' })
  const healthRef = useRef(null)
  const [collapsedGroups, setCollapsedGroups] = useState({})
  const [profileOpen, setProfileOpen] = useState(false)
  const [scaleStep, setScaleStepState] = useState(readScaleStep)
  useEffect(() => subscribeScale(setScaleStepState), [])
  const profileRef = useRef(null)
  const profileTriggerRef = useRef(null)
  const [locale, setLocaleState] = useState(getLocale())
  const [active, setActive] = useState(() => {
    try {
      const saved = sessionStorage.getItem('soduwork-hub-screen') || 'overview'
      return normalizeScreen(saved)
    } catch (_e) { return 'overview' }
  })

  const closeHealth = useCallback(() => {
    if (healthRef.current) healthRef.current.open = false
  }, [])
  const navigate = useCallback((screen) => {
    // Navigation to the current screen can still change that page's filters.
    closeHealth()
    const next = screen && normalizeScreen(screen)
    if (next && next !== active && canLeavePage(() => setActive(next))) setActive(next)
  }, [active, closeHealth])

  useEffect(() => {
    if (!authed) return undefined
    const closeOutside = (event) => {
      const details = healthRef.current
      if (details?.open && !details.contains(event.target)) closeHealth()
    }
    const closeOnEscape = (event) => {
      const details = healthRef.current
      if (event.key !== 'Escape' || event.defaultPrevented || !details?.open) return
      const restoreFocus = details.contains(document.activeElement)
      closeHealth()
      if (restoreFocus) {
        event.preventDefault()
        details.querySelector('summary')?.focus()
      }
    }
    document.addEventListener('pointerdown', closeOutside, true)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [authed, closeHealth])

  useEffect(() => {
    const h = () => { setAuthed(false); setMe(null) }
    window.addEventListener('soduwork-hub-unauth', h)
    return () => window.removeEventListener('soduwork-hub-unauth', h)
  }, [])

  useEffect(() => {
    const h = (event) => setLocaleState((event.detail && event.detail.locale) || getLocale())
    window.addEventListener('soduwork-locale-change', h)
    document.documentElement.lang = locale
    return () => {
      window.removeEventListener('soduwork-locale-change', h)
    }
  }, [locale])

  // Cross-page navigation with preset filters.
  useEffect(() => {
    const h = (e) => { if (e.detail && e.detail.screen) navigate(e.detail.screen) }
    window.addEventListener('soduwork-hub-nav', h)
    return () => window.removeEventListener('soduwork-hub-nav', h)
  }, [navigate])

  // Refresh /me after login to obtain current permissions.
  useEffect(() => {
    if (!authed) return
    api.me().then((u) => { setUser(u); setMe(u) }).catch(() => {})
  }, [authed])

  useEffect(() => {
    if (!authed) return undefined
    let alive = true
    const check = async () => {
      if (document.hidden) return
      try {
        const data = await api.health()
        if (alive) setHealth({ state: data && data.ok ? 'ok' : 'error',
          version: data && data.version || '', commit: data && data.commit || '' })
      } catch (_error) {
        if (alive) setHealth({ state: 'error', version: '' })
      }
    }
    check()
    const timer = window.setInterval(check, 30000)
    document.addEventListener('visibilitychange', check)
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', check) }
  }, [authed])

  useEffect(() => {
    try { sessionStorage.setItem('soduwork-hub-screen', active) } catch (_e) {}
    window.scrollTo(0, 0)
  }, [active])

  useEffect(() => {
    if (!profileOpen) return undefined
    profileRef.current?.querySelector('.profile-menu button, .profile-menu select')?.focus()
    const close = (event) => {
      if (profileRef.current && !profileRef.current.contains(event.target)) setProfileOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [profileOpen])

  // Explain administrator configuration and employee client roles before authentication.
  // Show the login form as the next step to avoid confusing administration with daily work.
  if (!authed) {
    return (
      <>
        {showLogin
          ? <Login initialError={SSO_ERROR} onLogin={() => { SSO_ERROR = ''; setAuthed(true); setMe(getUser()) }} onBack={() => { SSO_ERROR = ''; setShowLogin(false) }} />
          : <Landing onLogin={() => setShowLogin(true)} />}
        <LocaleSettings floating />
        <ToastHost />
      </>
    )
  }

  const visible = NAV.filter((n) => (!n.perm || can(n.perm)) && (!n.perms || n.perms.some(can)) && (!n.superOnly || (me && me.isSuper)))
  const groups = [...new Set(visible.map((n) => n.group))]
  const cur = visible.find((n) => n.id === active) || visible[0]
  const Comp = (cur && cur.Comp) || Overview
  const healthOk = health.state === 'ok'
  const healthTitle = healthOk ? t('health.ok') : health.state === 'checking' ? t('health.checking') : t('health.error')
  const healthVersion = healthReleaseLabel(health.version)
  const healthSub = healthOk ? `${t('health.hub')}${healthVersion ? ` · ${healthVersion}` : ''}` :
    health.state === 'checking' ? tx("正在读取真实健康状态") :
      tx("请检查后台地址或网络")

  const navLabel = (item) => t('nav.' + item.id, item.label)
  const groupLabel = (value) => {
    const key = value === '总览' ? 'group.overview' : value === 'AI 运行' ? 'group.aiRun' :
      value === '能力配置' ? 'group.capabilities' : value === '组织治理' ? 'group.org' : ''
    return key ? t(key, value) : value
  }
  const logout = () => {
    const proceed = () => { setProfileOpen(false); setToken(''); setUser(''); setAuthed(false); setMe(null); setShowLogin(false) }
    if (canLeavePage(proceed)) proceed()
  }

  // Guide accounts without management permissions to the client rather than empty administration pages.
  if (visible.length === 0) {
    return (
      <div className="app">
        <div className="landing">
          <img src="/soduwork.png" alt="" className="logo-box" style={{ width: 44, height: 44 }} />
          <h2>{tx("SoduWork 管理端是管理端")}</h2>
          <p>{tx("你好，")}{(me && (me.displayName || me.username)) || tx("同事")}{tx("。日常需求、收件箱认领和工作日报都在")}<b>{tx("桌面端「SoduWork」")}</b>{tx("里完成；")}<br />{tx("这里是负责人与管理员使用的管理控制台。如需管理权限，请联系管理员为你的角色开通。")}</p>
          <button className="btn btn-ghost" onClick={() => { setToken(''); setUser(''); setAuthed(false); setMe(null); setShowLogin(false) }}>{tx("退出登录")}</button>
        </div>
        <ToastHost />
      </div>
    )
  }

  return (
    <div className="app" data-screen={cur && cur.id}>
      <aside className="sidebar">
        <div className="brand">
          <img src="/soduwork.png" alt="" className="logo-box" />
          <span className="brand-copy"><b>{t('brand.title')}</b><small>{tx("企业智能工作台")}</small></span>
          <span className="brand-edition">{tx("企业")}</span>
        </div>
        <nav className="nav" aria-label={t('nav.aria')}>
          {groups.map((g) => (
            <section className="nav-group" key={g}>
              <button type="button" className="nav-label" aria-expanded={collapsedGroups[g] !== true}
                onClick={() => setCollapsedGroups((old) => ({ ...old, [g]: old[g] !== true }))}><span>{groupLabel(g)}</span></button>
              {collapsedGroups[g] !== true && visible.filter((n) => n.group === g).map((n) => (
                <button key={n.id} title={navLabel(n) + ' · ' + t('sub.' + n.id, n.sub)} aria-current={cur && n.id === cur.id ? 'page' : undefined}
                  className={'nav-item' + (cur && n.id === cur.id ? ' active' : '')} onClick={() => navigate(n.id)}>
                  <span className="ico"><Icon name={n.icon} /></span><span className="nav-copy">{navLabel(n)}</span>
                </button>
              ))}
            </section>
          ))}
        </nav>
        <div className="side-foot-wrap" ref={profileRef}>
          {profileOpen && <div id="profile-settings" className="profile-menu" role="dialog" aria-label={t('account.settings')}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !event.defaultPrevented) {
                event.stopPropagation(); setProfileOpen(false); profileTriggerRef.current?.focus()
              }
            }}>
            <div className="profile-menu-head"><div className="avatar">{(me && me.displayName || me && me.username || '?').slice(0, 1)}</div>
              <div><b>{(me && me.displayName) || (me && me.username) || '—'}</b><span>{me && me.isSuper ? tx("超级管理员") : tx("管理员")}</span></div></div>
            <div className="profile-menu-meta"><span>{tx("登录环境")}</span><b>{tx("企业内网")}</b></div>
            <div className="profile-menu-actions"><span>{tx("界面主题")}</span><ThemeToggle /></div>
            <div className="profile-menu-actions"><span>{tx("字体大小")}</span>
              <span className="scale-steps">
                <button type="button" className="icon-btn scale-toggle" disabled={scaleStep >= MAX_STEP}
                  title={tx("放大界面字体")} aria-label={tx("放大界面字体")}
                  onClick={() => stepScale(1)}>A+</button>
                <button type="button" className="icon-btn scale-toggle" disabled={scaleStep <= MIN_STEP}
                  title={tx("缩小界面字体")} aria-label={tx("缩小界面字体")}
                  onClick={() => stepScale(-1)}>A-</button>
                <span className="scale-level" aria-live="polite"
                  title={tx("当前字号：{0}", [scaleStep > 0 ? `+${scaleStep}` : String(scaleStep)])}>
                  {scaleStep > 0 ? `+${scaleStep}` : scaleStep}
                </span>
              </span>
            </div>
            <LocaleSettings inline />
            <button type="button" className="profile-logout" onClick={logout}><Icon name="logout" />{t("account.logout")}</button>
          </div>}
          <button ref={profileTriggerRef} type="button" className="side-foot" aria-expanded={profileOpen}
            aria-label={t('account.settings')} aria-haspopup="dialog" aria-controls={profileOpen ? 'profile-settings' : undefined} onClick={() => setProfileOpen((open) => !open)}>
            <span className="avatar">{(me && me.displayName || me && me.username || '?').slice(0, 1)}</span>
            <span className="u"><b>{(me && me.displayName) || (me && me.username) || '—'}</b><span>{me && me.isSuper ? tx("超级管理员") : tx("管理员")}{tx(" · 内网")}</span></span>
            <Icon name="settings" className="profile-trigger-icon" />
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="topbar-inner">
            <span className="page-mark"><Icon name={(cur && cur.icon) || 'grid'} /></span>
            <div className="page-title">
              <div className="page-route"><span>{t('brand.title')}</span><i>/</i><span>{cur && groupLabel(cur.group)}</span></div>
              <h1>{cur && navLabel(cur)}</h1>
            </div>
            <div className="top-actions">
              <details ref={healthRef} className={`env is-${health.state}`}>
                <summary aria-label={healthTitle + " · " + tx("服务版本信息")}><span className={healthOk ? "dot" : "dot off"} aria-hidden="true" /><span className="env-copy"><b>{healthTitle}</b><small>{healthSub}</small></span></summary>
                <dl className="env-details">
                  <div><dt>{tx("版本")}</dt><dd>{healthVersion || '—'}</dd></div>
                  <div><dt>{tx("构建")}</dt><dd>{health.commit || health.version || '—'}</dd></div>
                </dl>
              </details>
            </div>
          </div>
        </header>
        <div className="content"><Suspense fallback={<Loading />}>{cur ? <Comp me={me} /> : null}</Suspense></div>
      </div>
      <ToastHost />
    </div>
  )
}
