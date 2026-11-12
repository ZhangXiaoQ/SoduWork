import React, { useEffect, useRef, useState } from 'react'
import { t, translateText as tx } from '../i18n.js'
import { api } from '../api.js'
import { Modal, toast } from '../ui.jsx'
import PluginCoverPreview from './PluginCoverPreview.jsx'

const COMPOSE_ICON = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v9a2.5 2.5 0 0 1-2.5 2.5H12l-4.6 3.7c-.66.53-1.4.09-1.4-.7V17h-.5A2.5 2.5 0 0 1 3 14.5v-9Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /></svg>
const APPS_ICON = <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7.6" height="7.6" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.7" /><rect x="13.4" y="3" width="7.6" height="7.6" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.7" /><rect x="3" y="13.4" width="7.6" height="7.6" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.7" /><rect x="13.4" y="13.4" width="7.6" height="7.6" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.7" /></svg>

function PositionCard({ id, icon, label, sub, checked, busy, onToggle }) {
  return <button type="button" id={id} role="switch" aria-checked={checked} disabled={busy}
    className={'rec-pos' + (checked ? ' on' : '')} onClick={onToggle}>
    <span className="rec-pos-ico" aria-hidden="true">{icon}</span>
    <span className="rec-pos-copy"><b>{label}</b><i>{sub}</i></span>
    <span className="rec-switch" aria-hidden="true"><i /></span>
  </button>
}

export default function PluginRecommendButton({ plugin, version, onChanged, onOpenChanged, disabled = false }) {
  const [open, setOpen] = useState(false)
  const [cover, setCover] = useState('')
  const [compose, setCompose] = useState(false)
  const [featured, setFeatured] = useState(false)
  const [sidebar, setSidebar] = useState(false)
  const [sidebarSaved, setSidebarSaved] = useState(Boolean(plugin.catalogPolicy?.sidebarRecommended))
  const savedCompose = plugin.catalogPolicy?.composeRecommended
  const [composeSaved, setComposeSaved] = useState(savedCompose ?? null)
  const [checking, setChecking] = useState(typeof savedCompose !== 'boolean')
  const [lookupError, setLookupError] = useState(false)
  const statusRequest = useRef(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const featuredNow = Boolean(plugin.catalogPolicy?.featured)
  useEffect(() => { onOpenChanged?.(open); return () => onOpenChanged?.(false) }, [open, onOpenChanged])
  useEffect(() => {
    const request = ++statusRequest.current
    setLookupError(false)
    if (typeof savedCompose === 'boolean' && typeof plugin.catalogPolicy?.sidebarRecommended === 'boolean') {
      setComposeSaved(savedCompose)
      setSidebarSaved(plugin.catalogPolicy.sidebarRecommended)
      setChecking(false)
    } else {
      // Detail responses omit compose placements; read them before choosing the action.
      setComposeSaved(null)
      setChecking(true)
      api.pluginRecommendation(plugin.id).then((echo) => {
        if (request === statusRequest.current) {
          setComposeSaved(Boolean(echo?.composeRecommended))
          setSidebarSaved(Boolean(echo?.sidebarRecommended))
        }
      }).catch(() => {
        if (request === statusRequest.current) setLookupError(true)
      }).finally(() => {
        if (request === statusRequest.current) setChecking(false)
      })
    }
    return () => { statusRequest.current += 1 }
  }, [plugin.id, savedCompose, plugin.catalogPolicy?.sidebarRecommended])
  async function openDialog() {
    if (checking || busy || disabled) return
    const request = ++statusRequest.current
    setChecking(true)
    try {
      const echo = await api.pluginRecommendation(plugin.id)
      if (request !== statusRequest.current) return
      const currentCompose = Boolean(echo?.composeRecommended)
      setComposeSaved(currentCompose)
      setLookupError(false)
      setCompose(currentCompose)
      setSidebar(Boolean(echo?.sidebarRecommended))
      setSidebarSaved(Boolean(echo?.sidebarRecommended))
      setFeatured(featuredNow)
      setCover(plugin.catalogPolicy?.coverUrl || version?.manifest?.coverUrl || plugin.latestVersion?.manifest?.coverUrl || '')
      setError('')
      setOpen(true)
    } catch (_) {
      if (request === statusRequest.current) {
        setLookupError(true)
        toast(tx('推荐状态读取失败，请重试'))
      }
    } finally {
      if (request === statusRequest.current) setChecking(false)
    }
  }
  function validate() {
    const value = cover.trim()
    if (!value) return ''
    try {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error()
    } catch (_) { return tx('请填写有效的 HTTP(S) 封面地址') }
    return ''
  }
  async function save() {
    if (busy) return
    const invalid = validate()
    if (invalid) { setError(invalid); return }
    setBusy(true); setError('')
    try {
      const policy = await api.updatePluginCatalogPolicy(plugin.id, {
        featured, coverUrl: cover.trim(), composeRecommended: compose, sidebarRecommended: sidebar,
      })
      setComposeSaved(Boolean(policy?.composeRecommended))
      setSidebarSaved(Boolean(policy?.sidebarRecommended))
      onChanged?.(plugin.id, policy)
      setOpen(false)
      toast(featured || compose || sidebar ? tx('已保存推荐，客户端目录会自动同步') : tx('已取消推荐'))
    } catch (e) { setError(e.message); toast(e.message) }
    finally { setBusy(false) }
  }
  async function cancelAll() {
    if (busy) return
    setBusy(true); setError('')
    try {
      const policy = await api.updatePluginCatalogPolicy(plugin.id, { featured: false, composeRecommended: false, sidebarRecommended: false })
      setComposeSaved(false)
      setSidebarSaved(false)
      onChanged?.(plugin.id, policy); setOpen(false); toast(tx('已取消推荐'))
    } catch (e) { setError(e.message); toast(e.message) }
    finally { setBusy(false) }
  }
  const saving = busy ? tx('正在保存…') : tx('保存')
  const active = compose || featured || sidebar
  const hasSaved = featuredNow || composeSaved === true || sidebarSaved
  const actionLabel = hasSaved ? tx('编辑推荐') : composeSaved === null ? tx('推荐设置') : t('plugin.recommend.action')
  return <>
    <div className={'plugin-recommend-control' + (hasSaved ? ' is-recommended' : '')}>
      {hasSaved && <span className="plugin-recommend-status" role="status">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8 3 3 6-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {tx('已推荐')}
      </span>}
      <button type="button" className="plugin-card-quick-action admin-card-action" disabled={busy || disabled || checking}
        aria-busy={checking} title={lookupError ? tx('推荐状态读取失败，请重试') : hasSaved ? tx('编辑推荐') : undefined}
        aria-label={actionLabel + ' ' + plugin.name}
        onClick={() => { void openDialog() }}>
        {hasSaved ? t('plugin.recommend.edit') : actionLabel}</button>
    </div>
    {open && <Modal title={tx('推荐设置')} icon="sparkle" className="rec-modal" onClose={() => { if (!busy) setOpen(false) }}
      foot={<>
        {hasSaved && <button className="btn btn-ghost rec-foot-danger" disabled={busy} onClick={cancelAll}>{tx('取消推荐')}</button>}
        <span className="rec-foot-space" />
        <button className="btn btn-ghost" disabled={busy} onClick={() => setOpen(false)}>{tx('关闭')}</button>
        {/* Removal goes through the explicit "cancel recommendation" action; saving requires
            at least one selected placement, matching the pre-existing save contract. */}
        <button className="btn btn-primary" disabled={busy || !active} onClick={save}>{saving}</button>
      </>}>
      <section className="rec-section rec-section-first">
        <div className="rec-section-head"><b>{tx('封面')}</b><i>{tx('可选 · 仅用于应用页大图卡，coverUrl 自动填入')}</i></div>
        <input className="f-in" type="url" value={cover} disabled={busy} spellCheck={false}
          placeholder="https://example.com/cover.jpg" onChange={e => setCover(e.target.value)} />
        <div className="rec-cover-preview"><PluginCoverPreview url={cover} debounceMs={300} /></div>
      </section>
      <section className="rec-section">
        <div className="rec-section-head"><b>{tx('推荐位置')}</b><i>{tx('可多选 · 客户端按目录默认排序')}</i></div>
        <div className="rec-pos-list" role="group" aria-label={tx('推荐位置')}>
          <PositionCard id="optCompose" icon={COMPOSE_ICON} label={tx('对话页 · 起手推荐')}
            sub={tx('新对话页输入框下方的起手推荐位，点击直接打开应用')}
            checked={compose} busy={busy} onToggle={() => setCompose(v => !v)} />
          <PositionCard id="optApp" icon={APPS_ICON} label={tx('应用页 · 推荐分组')}
            sub={tx('应用面板「推荐」分组的大图卡片')}
            checked={featured} busy={busy} onToggle={() => setFeatured(v => !v)} />
          <PositionCard id="optSidebar" icon={APPS_ICON} label={tx('主侧栏 · 应用入口')}
            sub={tx('向有使用权限的用户展示，点击在主窗口右侧打开')}
            checked={sidebar} busy={busy} onToggle={() => setSidebar(v => !v)} />
        </div>
      </section>
      {(version || plugin.latestVersion)?.trustState !== 'approved' &&
        <p className="rec-note rec-note-warn">{tx('保存推荐信息后，应用仍需审核通过并上架，才会展示在客户端。')}</p>}
      {error && <p className="rec-error" role="alert">{error}</p>}
    </Modal>}
  </>
}
