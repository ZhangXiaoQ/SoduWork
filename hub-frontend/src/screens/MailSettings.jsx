import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import { Icon, SelectMenu, toast } from '../ui.jsx'
import './mail-settings.css'

const EMPTY = { enabled: false, host: 'smtp.126.com', port: 465, security: 'ssl', username: '', senderAddress: '', senderName: 'SoduWork', password: '' }
const STATES = localeMap(() => ({ queued: '等待发送', sending: '正在发送', retry: '等待重试', sent: 'SMTP 已接收', failed: '发送失败', expired: '已过期', unknown: '结果待确认' }))
const ERRORS = localeMap(() => ({ SMTP_AUTH_FAILED: '授权失败，请检查客户端授权码', SMTP_TLS_FAILED: 'TLS 证书验证失败', SMTP_CONNECTION_FAILED: 'SMTP 连接失败', SMTP_REJECTED: '邮件服务器拒绝投递', SMTP_RECIPIENT_REJECTED: '收件地址被拒绝', SMTP_RESULT_UNKNOWN: '发送结果不确定，请先检查收件箱', MAIL_NOT_READY: '邮件配置不可用', MAIL_EXPIRED: '邮件已过期', MAIL_INTERNAL_ERROR: '邮件处理异常' }))
const PRIVACY_STATES = localeMap(() => ({ queued: '等待处理', running: '处理中', processing: '处理中', completed: '已完成', ready: '已就绪', failed: '处理失败', expired: '已过期' }))

export default function MailSettings() {
  useLocale()
  const [form, setForm] = useState(EMPTY)
  const [legal, setLegal] = useState({ operatorName: '', contactEmail: '' })
  const [canEditLegal, setCanEditLegal] = useState(false)
  const [recipient, setRecipient] = useState('')
  const [deliveries, setDeliveries] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('loading')
  const [saved, setSaved] = useState(null)
  const [settingsAttempt, setSettingsAttempt] = useState(0)
  const [settingsError, setSettingsError] = useState('')
  const [deliveryError, setDeliveryError] = useState('')
  const [legalLoading, setLegalLoading] = useState(true)
  const deliveryRevision = useRef(0)
  const [privacyRequests, setPrivacyRequests] = useState(null)
  const [privacyError, setPrivacyError] = useState('')
  useEffect(() => {
    let live = true
    api.accountPrivacyRequests().then(result => { if (live) setPrivacyRequests(result.items || []) })
      .catch(e => { if (live && e.status !== 403) setPrivacyError(e.message) })
    return () => { live = false }
  }, [])
  useEffect(() => {
    let live = true
    setBusy('loading'); setSettingsError('')
    api.mailSettings().then(mail => {
      if (!live) return
      setForm({ ...EMPTY, ...mail, password: '' }); setSaved(mail)
    }).catch(e => { if (live) { setSaved(null); setSettingsError(e.message) } }).finally(() => live && setBusy(''))
    return () => { live = false }
  }, [settingsAttempt])
  useEffect(() => {
    let live = true
    api.accountLegal().then(terms => {
      if (live) { setLegal({ operatorName: terms.operatorName || '', contactEmail: terms.contactEmail || '' }); setCanEditLegal(terms.canEdit !== false) }
    }).catch(e => live && setError(e.message)).finally(() => live && setLegalLoading(false))
    const stamp = ++deliveryRevision.current
    api.mailDeliveries().then(history => {
      if (live && stamp === deliveryRevision.current) { setDeliveries(history.items || []); setDeliveryError('') }
    }).catch(e => { if (live && stamp === deliveryRevision.current) setDeliveryError(e.message) })
    return () => { live = false; deliveryRevision.current++ }
  }, [])
  useEffect(() => {
    if (!deliveries.some(row => ['queued', 'sending', 'retry'].includes(row.state))) return undefined
    let live = true
    const timer = setInterval(() => {
      const stamp = ++deliveryRevision.current
      api.mailDeliveries().then(r => { if (live && stamp === deliveryRevision.current) { setDeliveries(r.items || []); setDeliveryError('') } })
        .catch(e => { if (live && stamp === deliveryRevision.current) setDeliveryError(e.message) })
    }, 3000)
    return () => { live = false; clearInterval(timer) }
  }, [deliveries])
  const field = key => ({ value: form[key], disabled: !!busy || !saved, onChange: e => setForm(old => ({ ...old, [key]: e.target.value })) })
  async function save() {
    if (!saved || busy) return
    setBusy('save'); setError('')
    try {
      const body = Object.fromEntries(Object.keys(EMPTY).map(key => [key, key === 'port' ? Number(form[key]) : form[key]]))
      const result = await api.saveMailSettings(body)
      setForm({ ...EMPTY, ...result, password: '' }); setSaved(result); toast(tx('邮件配置已保存'))
    } catch (e) { setError(e.message) } finally { setBusy('') }
  }
  async function test() {
    setBusy('test'); setError('')
    try {
      await api.testMailSettings(recipient.trim())
      toast(tx('测试邮件已排队，请查看发送记录与收件箱'))
      await refreshDeliveries()
    } catch (e) { setError(e.message) } finally { setBusy('') }
  }
  async function refreshDeliveries() {
    const stamp = ++deliveryRevision.current
    try {
      const result = await api.mailDeliveries()
      if (stamp === deliveryRevision.current) { setDeliveries(result.items || []); setDeliveryError('') }
    } catch (e) { if (stamp === deliveryRevision.current) setDeliveryError(e.message) }
  }
  async function saveLegal() {
    if (!canEditLegal || legalLoading || busy) return
    setBusy('legal'); setError('')
    try {
      const next = await api.saveAccountLegal(legal)
      setLegal({ operatorName: next.operatorName || '', contactEmail: next.contactEmail || '' })
      toast(tx('协议与运营信息已保存'))
    } catch (e) { setError(e.message) } finally { setBusy('') }
  }
  async function privacyRefresh(id = '') {
    setBusy(id ? 'retry' : 'privacy'); setPrivacyError('')
    try {
      if (id) await api.retryAccountPrivacyRequest(id)
      setPrivacyRequests((await api.accountPrivacyRequests()).items || [])
      if (id) toast(tx('已重新排队，清理将在后台继续'))
    } catch (e) { setPrivacyError(e.message) } finally { setBusy('') }
  }
  if (busy === 'loading') return <section className="mail-settings cap-panel"><p className="muted">{tx('正在读取邮件服务…')}</p></section>
  return <section className="mail-settings cap-panel" aria-label={tx('账号邮件服务')}>
    <header className="mail-section-head"><div><h3><Icon name="send" />{tx('账号邮件服务')}</h3><p>{tx('注册、邮箱验证码登录与找回密码共用此发件服务。')}</p></div>
      <span className={'mail-status ' + (saved?.ready ? 'ready' : '')}>{saved?.ready ? tx('已配置') : tx('待配置')}</span></header>
    {settingsError && <div className="mail-error" role="alert">{settingsError} <button className="btn btn-ghost xs" disabled={!!busy} onClick={() => setSettingsAttempt(value => value + 1)}>{tx('重试')}</button></div>}
    {error && <div className="mail-error" role="alert">{error}</div>}
    <div className="mail-layout">
      <div className="mail-card">
        <div className="mail-card-heading"><h4>{tx('发件设置')}</h4><div className="mail-presets"><button className="btn btn-ghost xs" disabled={!!busy || !saved} onClick={() => setForm(old => ({ ...old, host: 'smtp.126.com', port: 465, security: 'ssl' }))}>{tx('填入 126 邮箱配置')}</button><button className="btn btn-ghost xs" disabled={!!busy || !saved} onClick={() => setForm(old => ({ ...old, host: 'smtp.qiye.aliyun.com', port: 465, security: 'ssl' }))}>{tx('填入阿里邮箱配置')}</button></div></div>
        <div className="mail-fields">
          <label className="mail-wide"><span>{tx('发件邮箱')}</span><input className="f-in" type="email" autoComplete="off" {...field('username')} placeholder="name@example.com" /></label>
          <label className="mail-wide"><span>{tx('SMTP 授权码 / 密码')}</span><input className="f-in" type="password" autoComplete="new-password" {...field('password')} placeholder={form.passwordConfigured ? tx('已设置，留空保持不变') : tx('填写 SMTP 授权码或密码')} /><small>{tx('请填写邮箱服务商提供的 SMTP 授权码或密码；开启三方客户端安全密码时使用该密码。')}</small></label>
          <label><span>{tx('SMTP 服务器')}</span><input className="f-in" {...field('host')} /></label>
          <label><span>{tx('端口')}</span><input className="f-in" type="number" min="1" max="65535" {...field('port')} /></label>
          <label><span>{tx('连接安全')}</span><SelectMenu className="f-in" {...field('security')}><option value="ssl">SSL / TLS</option><option value="starttls">STARTTLS</option></SelectMenu></label>
          <label><span>{tx('发件名称')}</span><input className="f-in" {...field('senderName')} maxLength="80" /></label>
          <label className="mail-wide"><span>{tx('发件地址')} <small>{tx('默认同发件邮箱')}</small></span><input className="f-in" type="email" {...field('senderAddress')} placeholder={form.username || 'name@example.com'} /></label>
        </div>
        <footer className="mail-card-actions"><label className="mail-enable"><input type="checkbox" checked={form.enabled} disabled={!!busy || !saved} onChange={e => setForm(old => ({ ...old, enabled: e.target.checked }))} />{tx('启用账号邮件')}</label><button className="btn btn-primary" disabled={!!busy || !saved} onClick={save}>{busy === 'save' ? tx('保存中…') : tx('保存配置')}</button></footer>
      </div>
      <div className="mail-card"><h4>{tx('发送测试邮件')}</h4><p>{tx('使用已保存的配置，向下方指定邮箱发送固定测试邮件。')}</p>
        <label className="mail-test-label"><span>{tx('收件邮箱')}</span><input className="f-in" type="email" value={recipient} disabled={!!busy} onChange={e => setRecipient(e.target.value)} placeholder={tx('输入接收测试邮件的地址')} /></label>
        <button className="btn btn-primary mail-test-button" disabled={!!busy || !saved?.ready || !recipient.trim()} onClick={test}>{busy === 'test' ? tx('正在提交…') : tx('发送测试邮件')}</button>
        <p className="mail-hint">{tx('SMTP 接收成功不代表已进入收件箱，请同时检查垃圾邮件。')}</p>
        <div className="mail-history-head"><h4>{tx('最近发送记录')}</h4><button className="btn btn-ghost xs" disabled={!!busy} onClick={refreshDeliveries}>{tx('刷新')}</button></div>
        {deliveryError && <p className="mail-error" role="alert">{deliveryError}</p>}
        <div className="mail-history">{deliveries.length ? deliveries.slice(0, 8).map(row => <article key={row.id}><div><b>{row.recipient}</b><span>{STATES[row.state] || row.state}</span></div><small>{ERRORS[row.errorCode] ? ERRORS[row.errorCode] : row.createdAt ? new Date(row.createdAt).toLocaleString() : '—'}</small></article>) : <p className="muted">{tx('暂无发送记录')}</p>}</div>
      </div>
    </div>
    <div className="mail-card mail-legal"><div><h4>{tx('协议与运营信息')}</h4><p>{tx('已发布的正文保持不变。运营信息变更后，请在协议管理中更新草稿并重新发布。')}</p></div><div className="mail-fields"><label><span>{tx('运营主体名称')}</span><input className="f-in" value={legal.operatorName} disabled={!!busy || legalLoading || !canEditLegal} maxLength="120" onChange={e => setLegal(old => ({ ...old, operatorName: e.target.value }))} /></label><label><span>{tx('隐私联系邮箱')}</span><input className="f-in" type="email" value={legal.contactEmail} disabled={!!busy || legalLoading || !canEditLegal} onChange={e => setLegal(old => ({ ...old, contactEmail: e.target.value }))} /></label></div><footer className="mail-card-actions"><span className="muted">{tx('授权码与验证码不会显示在发送记录中。')}</span><button className="btn btn-primary" disabled={!!busy || legalLoading || !canEditLegal || !legal.operatorName.trim() || !legal.contactEmail.trim()} onClick={saveLegal}>{tx('保存运营信息')}</button></footer></div>
    {(privacyRequests !== null || privacyError) && <div className="mail-card mail-legal"><div className="mail-card-heading"><div><h4>{tx('个人数据处理请求')}</h4><p>{tx('查看导出与注销处理进度；清理失败后可重新排队。')}</p></div><button className="btn btn-ghost xs" disabled={!!busy} onClick={() => privacyRefresh()}>{tx('刷新处理状态')}</button></div>
      {privacyError && <p className="mail-error" role="alert">{privacyError}</p>}
      <div className="mail-history">{privacyRequests?.length ? privacyRequests.map(row => <article key={row.id}><div><b>{row.kind === 'deletion' ? tx('账号注销') : tx('数据导出')} · {row.id.slice(0, 8)}</b><span>{PRIVACY_STATES[row.status] || row.status}</span></div><small>{row.errorCode || (row.createdAt ? new Date(row.createdAt).toLocaleString() : '')}</small>{row.kind === 'deletion' && row.status === 'failed' && <button className="btn btn-ghost xs" disabled={!!busy} onClick={() => privacyRefresh(row.id)}>{tx('重新处理')}</button>}</article>) : <p className="muted">{tx('暂无个人数据处理请求')}</p>}</div></div>}
  </section>
}
