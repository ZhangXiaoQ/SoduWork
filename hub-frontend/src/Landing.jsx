import React, { useCallback, useEffect, useRef, useState } from 'react'
import { translateText as tx, localeMap, useLocale } from './i18n.js'
import LandingPreview, { PublicIcon as Glyph } from './LandingPreview.jsx'
import LandingAtmosphere from './LandingAtmosphere.jsx'
import LandingOrbit from './LandingOrbit.jsx'

const capabilities = localeMap(() => ([
  { icon: 'chat', title: '从对话开始，把成果带走', detail: '围绕资料、文件和工作目录展开对话，预览交付成果，随时回到历史继续工作。', tag: '对话与成果' },
  { icon: 'team', title: '人与 AI，围绕同一项需求', detail: '明确目标、责任人与验收标准，在需求池里跟踪进度，让协作者接得住上下文。', tag: '需求协作' },
  { icon: 'clock', title: '给重复工作一个固定安排', detail: '设置自动化计划，查看每次运行的结果和记录，让周期性工作有迹可循。', tag: '自动化' },
  { icon: 'layers', title: '把团队的方法，变成可用能力', detail: '通过插件、技能和系统连接，把已有工具与工作方法接入日常流程。', tag: '插件与连接' },
  { icon: 'memory', title: '让经验，留给下一次工作', detail: '将个人工作上下文与组织共享经验沉淀为记忆，让后续协作有据可依。', tag: '个人与组织记忆' },
  { icon: 'shield', title: '在关键一步，由人来决定', detail: '通过角色权限、操作确认和人工验收明确边界，重要操作保留审计记录。', tag: '权限与审批' },
]))
const flow = localeMap(() => ([
  ['说清目标', '从一次对话开始，带上资料、背景与期望。'],
  ['推进工作', '选择合适的能力；需要协作时，整理为需求。'],
  ['核对成果', '查看过程与交付，在需要时完成确认和验收。'],
  ['留下经验', '成果进入资料库，工作经验沉淀为共享记忆。'],
]))
const governance = localeMap(() => ([
  ['team', '组织与身份', '成员、部门、角色权限与企业单点登录。'],
  ['layers', '模型与能力', '模型目录、插件、技能与企业系统连接。'],
  ['grid', '执行与运营', '终端与执行机、运行监控、用量与成本。'],
  ['shield', '治理与追溯', '项目与仓库、组织记忆、客户端发布和审计。'],
]))

function Brand() {
  return <span className="public-brand"><img src="/soduwork.png" alt="" className="logo-box" /><b>SoduWork</b></span>
}

function platform() {
  const ua = String(navigator.userAgent || '')
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return 'ios'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac'
  if (/Linux|X11/i.test(ua) && !/Android|Mobile/i.test(ua)) return 'lin'
  return 'win'
}
function primaryTarget(pkgs) {
  const os = platform(), info = pkgs?.[os]
  if (os === 'android') return { info, meta: info, href: '/api/v1/download/mobile/android', label: 'Android · APK' }
  if (os === 'ios') return { info, meta: null, href: '', label: 'iOS' }
  if (os === 'mac') {
    const arch = ['arm64', 'x64'].find(key => info?.arches?.[key])
    return { info, meta: info?.arches?.[arch], href: arch ? `/api/v1/download/client/mac/${arch}` : '', label: arch === 'x64' ? 'macOS · Intel' : 'macOS · Apple Silicon' }
  }
  if (os === 'lin') {
    const format = ['deb', 'rpm', 'tar.gz'].find(key => info?.formats?.[key])
    return { info, meta: info?.formats?.[format], href: format ? `/api/v1/download/client/linux/${format}` : '', label: `Linux · ${format || ''}` }
  }
  return { info, meta: info, href: '/api/v1/download/client', label: 'Windows 10 / 11' }
}
function Download({ pkgs, variant = 'fill' }) {
  const target = primaryTarget(pkgs)
  const ready = Boolean(target.info?.available && target.meta && target.href)
  const className = 'w-cta w-cta-' + variant
  return ready ? <a className={className} href={target.href}><Glyph name="download" size={18} />{tx('下载员工客户端')}</a>
    : <button type="button" className={className} disabled aria-busy={pkgs === null}><Glyph name="download" size={18} />{tx('下载员工客户端')}</button>
}
function DownloadMeta({ pkgs, onRetry }) {
  const { info, meta, label } = primaryTarget(pkgs)
  if (pkgs === null) return <p className="w-meta" role="status">{tx('正在确认安装包…')}</p>
  if (info?.error) return <p className="w-meta" role="status">{tx('暂时取不到安装包信息')}<button className="public-text-button" type="button" onClick={onRetry}>{tx('重试')}</button></p>
  if (!info?.available || !meta) return <p className="w-meta" role="status">{tx('此平台安装包尚未发布，请联系管理员。')}</p>
  return <p className="w-meta">{label}{meta.version ? ` · v${meta.version}` : ''}{meta.sizeText ? ` · ${meta.sizeText}` : ''}</p>
}
function PlatformDownloads({ pkgs, onRetry }) {
  const targets = [
    { key: 'win', label: 'Windows', packages: pkgs?.win?.available ? [['exe', '/api/v1/download/client', pkgs.win]] : [] },
    { key: 'mac', label: 'macOS', packages: pkgs?.mac?.available ? ['arm64', 'x64'].filter(arch => pkgs.mac.arches?.[arch]).map(arch => [arch === 'arm64' ? 'Apple Silicon' : 'Intel', `/api/v1/download/client/mac/${arch}`, pkgs.mac.arches[arch]]) : [] },
    { key: 'lin', label: 'Linux', packages: pkgs?.lin?.available ? ['deb', 'rpm', 'tar.gz'].filter(format => pkgs.lin.formats?.[format]).map(format => [format, `/api/v1/download/client/linux/${format}`, pkgs.lin.formats[format]]) : [] },
    { key: 'android', label: 'Android', packages: pkgs?.android?.available ? [['APK', '/api/v1/download/mobile/android', pkgs.android]] : [] },
    { key: 'ios', label: 'iPhone / iPad', packages: [] },
  ]
  return <div className="public-download-grid">{targets.map(target => <article className="public-download-platform" key={target.key}>
    <div className="public-platform-head"><span className={'public-platform-icon is-' + target.key}>{target.key === 'win' ? <Glyph name="grid" size={21} /> : target.key === 'mac' ? '⌘' : ['android', 'ios'].includes(target.key) ? <Glyph name="grid" size={21} /> : '>_'}</span><h3>{target.label}</h3></div>
    <div className="public-platform-packages">{target.packages.length ? target.packages.map(([label, href, info]) => <a href={href} key={href}><span>{label}<small>{info.version ? `v${info.version}` : ''}{info.sizeText ? ` · ${info.sizeText}` : ''}</small></span><Glyph name="download" size={17} /></a>) : <p>{pkgs === null ? tx('正在确认安装包…') : pkgs?.[target.key]?.error ? <>{tx('暂时取不到安装包信息')} <button className="public-text-button" type="button" onClick={onRetry}>{tx('重试')}</button></> : tx('尚未发布')}</p>}</div>
  </article>)}</div>
}

export default function Landing({ onLogin }) {
  useLocale()
  const [pkgs, setPkgs] = useState(null)
  const [commit, setCommit] = useState('')
  const request = useRef(null)
  const loadPkg = useCallback(() => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setPkgs(null)
    const timer = setTimeout(() => controller.abort(), 12000)
    const fetchInfo = url => fetch(url, { signal: controller.signal }).then(r => r.ok ? r.json() : { available: false, error: r.status !== 404 }).catch(() => ({ available: false, error: true }))
    Promise.all([fetchInfo('/api/v1/download/client/info'), fetchInfo('/api/v1/download/client/mac/info'), fetchInfo('/api/v1/download/client/linux/info'), fetchInfo('/api/v1/download/mobile/info')])
      .then(([win, mac, lin, android]) => { if (request.current === controller) setPkgs({ win, mac, lin, android }) })
      .finally(() => clearTimeout(timer))
  }, [])
  useEffect(() => {
    loadPkg()
    const controller = new AbortController()
    fetch('/healthz', { signal: controller.signal }).then(r => r.ok ? r.json() : {}).then(data => {
      if (!controller.signal.aborted && data?.commit) setCommit(String(data.commit).slice(0, 12))
    }).catch(() => {})
    return () => { const previous = request.current; request.current = null; previous?.abort(); controller.abort() }
  }, [loadPkg])

  return <div className="welcome public-theme" id="top">
    <a className="public-skip" href="#public-main">{tx('跳到主要内容')}</a>
    <header className="public-header"><div className="public-wrap public-nav">
      <a href="#top" aria-label={tx('SoduWork 首页')}><Brand /></a>
      <nav aria-label={tx('网站导航')}><a href="#platform">{tx('工作方式')}</a><a href="#enterprise">{tx('企业管理')}</a><a href="#downloads">{tx('下载客户端')}</a></nav>
      <button type="button" className="public-nav-login" onClick={onLogin}>{tx('进入管理后台')}<Glyph name="arrow" size={17} /></button>
    </div></header>
    <main id="public-main">
      <section className="public-hero public-wrap">
        <LandingAtmosphere />
        <div className="public-hero-copy"><span className="public-eyebrow"><i />{tx('为人与 AI 一起工作而设计')}</span>
          <h1>{tx('让想法向前一步。')}<br /><span>{tx('让工作真正完成。')}</span></h1>
          <p>{tx('对话、需求协作、自动化与知识沉淀，在同一个工作空间自然衔接。SoduWork 陪团队从一个想法，走到一份可以交付的成果。')}</p>
          <div className="public-hero-actions"><Download pkgs={pkgs} /><a className="w-cta w-cta-ghost" href="#platform">{tx('看看如何工作')}<Glyph name="arrow" size={17} /></a></div>
          <DownloadMeta pkgs={pkgs} onRetry={loadPkg} />
          <a className="public-all-platforms" href="#downloads">{tx('查看桌面端与移动端下载')}<span>↗</span></a>
        </div>
        <LandingOrbit />
      </section>
      <div className="public-principles public-wrap"><span>{tx('一个连贯的工作空间')}</span><p>{tx('随时开始对话')}<i />{tx('按需组织协作')}<i />{tx('把成果和经验留下')}</p></div>
      <section className="public-demo public-wrap">
        <div className="public-section-head"><div><span className="public-eyebrow">{tx('工作场景示意')}</span><h2>{tx('一个空间，衔接整段工作')}</h2></div><p>{tx('成果与过程，一起留在工作里')}</p></div>
        <LandingPreview />
      </section>
      <section className="public-capabilities public-wrap" id="platform">
        <div className="public-section-head"><div><span className="public-eyebrow">{tx('从日常工作出发')}</span><h2>{tx('工作有很多种，')}<br />{tx('好用的入口只需一个。')}</h2></div><p>{tx('临时问题，直接聊。持续推进的事，放进需求。常做的工作，交给自动化。把精力留给真正需要你判断的地方。')}</p></div>
        <div className="public-capability-grid">{capabilities.map(item => <article key={item.tag}><div className="public-capability-top"><span className="public-feature-icon"><Glyph name={item.icon} size={23} /></span><small>{item.tag}</small></div><h3>{item.title}</h3><p>{item.detail}</p></article>)}</div>
      </section>
      <section className="public-flow" id="loop"><div className="public-wrap"><div className="public-section-head"><div><span className="public-eyebrow">{tx('让上下文接得上，让工作走得远')}</span><h2>{tx('每一步，都通向下一步。')}</h2></div><span className="public-flow-note"><Glyph name="memory" />{tx('成果可回看，经验可复用')}</span></div>
        <ol>{flow.map(([title, text], index) => <li key={title}><span className="public-step-number">0{index + 1}</span><h3>{title}</h3><p>{text}</p></li>)}</ol>
      </div></section>
      <section className="public-enterprise public-wrap" id="enterprise">
        <div className="public-enterprise-copy"><span className="public-eyebrow">{tx('团队的工作空间，企业的管理视角')}</span><h2>{tx('让能力向前，')}<br />{tx('也让边界清楚。')}</h2><p>{tx('员工在客户端完成工作，管理员在后台配置组织、模型与能力，查看运行状态和用量。协作有共同规则，关键操作有据可查。')}</p><button className="w-cta w-cta-dark" type="button" onClick={onLogin}>{tx('进入管理后台')}<Glyph name="arrow" size={18} /></button></div>
        <div className="public-governance"><header><Brand /><span>{tx('管理端能力')}</span></header>{governance.map(([icon, title, text]) => <div className="public-governance-row" key={title}><span><Glyph name={icon} /></span><div><h3>{title}</h3><p>{text}</p></div><Glyph name="check" size={16} /></div>)}<footer><Glyph name="shield" size={16} />{tx('权限按角色配置，能力按企业策略开放')}</footer></div>
      </section>
      <section className="public-downloads" id="downloads"><div className="public-wrap"><div className="public-section-head"><div><span className="public-eyebrow">{tx('从一项真实工作开始')}</span><h2>{tx('把 SoduWork，带在身边。')}</h2></div><p>{tx('选择适合你设备的客户端。在电脑与手机上，继续同一个工作空间里的事。')}</p></div><PlatformDownloads pkgs={pkgs} onRetry={loadPkg} /><div className="public-download-help"><span>{tx('安装包版本与大小以当前发布信息为准。')}</span><button type="button" className="public-text-button" onClick={onLogin}>{tx('管理员？进入管理后台')}<Glyph name="arrow" size={16} /></button></div></div></section>
    </main>
    <footer className="public-footer public-wrap"><div><a href="#top"><Brand /></a><p>{tx('好想法，值得一个好结果。')}</p></div><nav aria-label={tx('页脚导航')}><a href="#platform">{tx('工作方式')}</a><a href="#downloads">{tx('下载客户端')}</a><button type="button" onClick={onLogin}>{tx('进入管理后台')}</button></nav><small>{commit ? `build ${commit}` : 'SoduWork'}</small></footer>
  </div>
}
