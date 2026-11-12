import { LOCALES, translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { useViewportHeight } from '../viewport-height.js'
import { Confirm, Icon, Loading, Modal, toast, SelectMenu } from '../ui.jsx'
import LocalesEditor from '../components/LocalesEditor.jsx'
import './automation-templates.css'

const blank = () => ({ id: '', name: '', description: '', title: '', note: '', every: 'daily',
  atHour: 9, atMinute: 0, weekday: 1, requiredCapabilities: [], retryLimit: 2,
  retryDelayMinutes: 5, pluginBindingId: '', startDate: '', endDate: '', enabled: true })
const capOptions = localeMap(() => ([['browser', '浏览网页'], ['computer', '操作电脑'], ['office', '办公文档']]))
const rhythm = localeMap(() => ({ hourly: '每小时', daily: '每天', weekly: '每周' }))
// Optional locale maps supply employee display and prefill with base-field fallback.
const localeFields = ['en-US', 'ja-JP', 'ko-KR'].map((locale) => [locale, LOCALES[locale]])

function templateErrors(value, items = []) {
  const errors = {}, id = value.id, name = value.name
  if (typeof id !== 'string' || !id) errors.id = tx("请填写模板标识")
  else if (id.length < 2 || id.length > 64) errors.id = tx("模板标识需为 2–64 个字符")
  else if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id) || /\s/.test(id))
    errors.id = tx("模板标识须以小写字母或数字开头，仅支持小写字母、数字、点（.）、短横线（-）和下划线（_），不能包含空格")
  else if (!value.updatedAt && items.some(item => item.id === id))
    errors.id = tx("模板标识已存在，请更换一个")
  if (typeof name !== 'string' || !name.trim()) errors.name = tx("请填写模板名称，不能全为空白")
  else if (Array.from(name.trim()).length > 80) errors.name = tx("模板名称最多 80 个字符")
  else if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) errors.name = tx("模板名称不能包含换行或控制字符")
  if (value.startDate && value.endDate && value.endDate < value.startDate)
    errors.endDate = tx("结束日期不能早于开始日期")
  return errors
}

function Editor({ value, items = [], onChange, onCancel, onSave, busy }) {
  const formId = useId()
  const idRef = useRef(null), nameRef = useRef(null), endDateRef = useRef(null)
  const [touched, setTouched] = useState({})
  const errors = templateErrors(value, items)
  useEffect(() => {
    idRef.current?.setCustomValidity(errors.id || '')
    nameRef.current?.setCustomValidity(errors.name || '')
    endDateRef.current?.setCustomValidity(errors.endDate || '')
  }, [errors.id, errors.name, errors.endDate])
  const touch = key => setTouched(previous => ({ ...previous, [key]: true }))
  const set = (key, next) => onChange({ ...value, [key]: next })
  const toggleCap = (key) => set('requiredCapabilities', value.requiredCapabilities.includes(key)
    ? value.requiredCapabilities.filter((x) => x !== key) : [...value.requiredCapabilities, key])
  return <Modal wide className="at-dialog" icon="activity" title={value.updatedAt ? tx("编辑自动化模板") : tx("新建自动化模板")} onClose={onCancel}
    foot={<><label className="at-enabled modal-foot-note"><input type="checkbox" checked={value.enabled} onChange={(e) => set('enabled', e.target.checked)} />{tx("发布给员工使用")}</label>
      <button type="button" className="btn btn-ghost" onClick={onCancel}>{tx("取消")}</button><button type="submit" form={formId} className="btn btn-primary" disabled={busy}>{busy ? tx("保存中…") : tx("保存模板")}</button></>}>
    <form id={formId} className="at-editor" onInvalidCapture={() => setTouched({ id: true, name: true, endDate: true })}
      onSubmit={(event) => {
        event.preventDefault()
        if (Object.keys(errors).length) {
          setTouched({ id: true, name: true, endDate: true })
          ;(errors.id ? idRef : errors.name ? nameRef : endDateRef).current?.focus()
          return
        }
        onSave()
      }}>
    <div className="at-editor-grid">
      <label><span>{tx("模板标识")}</span><input ref={idRef} name="id" required value={value.id}
        disabled={Boolean(value.updatedAt)} onChange={(e) => { set('id', e.target.value); touch('id') }} onBlur={() => touch('id')}
        aria-invalid={Boolean(touched.id && errors.id)} aria-describedby={`${formId}-id-hint${touched.id && errors.id ? ` ${formId}-id-error` : ''}`}
        placeholder="daily-report" autoCapitalize="none" spellCheck={false} />
        <small className="at-field-hint" id={`${formId}-id-hint`}>{tx("2–64 位，以小写字母或数字开头，可含 . - _，标识不可重复，创建后不可修改。")}</small>
        {touched.id && errors.id && <small className="at-field-error" id={`${formId}-id-error`} role="status">{errors.id}</small>}</label>
      <label><span>{tx("模板名称")}</span><input ref={nameRef} name="name" required value={value.name}
        onChange={(e) => { set('name', e.target.value); touch('name') }} onBlur={() => touch('name')}
        aria-invalid={Boolean(touched.name && errors.name)} aria-describedby={`${formId}-name-hint${touched.name && errors.name ? ` ${formId}-name-error` : ''}`}
        placeholder={tx("团队日报")} />
        <small className="at-field-hint" id={`${formId}-name-hint`}>{tx("1–80 个字符，支持多语言和常用符号，不能全为空白或包含换行、控制字符。")}</small>
        {touched.name && errors.name && <small className="at-field-error" id={`${formId}-name-error`} role="status">{errors.name}</small>}</label>
      <label className="wide"><span>{tx("一句话说明")}</span><input maxLength="240" value={value.description}
        onChange={(e) => set('description', e.target.value)} placeholder={tx("让团队每天自动收到一份日报")} /></label>
      <label className="wide"><span>{tx("生成需求标题")}</span><input maxLength="200" value={value.title}
        onChange={(e) => set('title', e.target.value)} placeholder={tx("每日工作总结")} /></label>
      <label className="wide"><span>{tx("交给 AI 的工作说明")}</span><textarea required maxLength="8000" rows="5" value={value.note}
        onChange={(e) => set('note', e.target.value)} placeholder={tx("说明 AI 每次需要完成的工作、交付物和验收要求")} /></label>
    </div>
    <LocalesEditor summary={tx("多语言（可选）")} languages={localeFields} value={value}
      onChange={(key, map) => set(key, map)}
      fields={[
        { key: 'nameLocales', label: tx("模板名称"), maxLength: 80 },
        { key: 'descriptionLocales', label: tx("一句话说明"), maxLength: 240, wide: true },
        { key: 'noteLocales', label: tx("交给 AI 的工作说明"), maxLength: 8000, textarea: true, rows: 3 },
      ]} />
    <div className="at-section"><b>{tx("默认节奏")}</b><div className="at-rhythm">
      {Object.entries(rhythm).map(([key, label]) => <button type="button" key={key}
        className={value.every === key ? 'on' : ''} onClick={() => set('every', key)}>{label}</button>)}
      <label className="at-time"><span>{tx("时")}</span><input type="number" min="0" max="23" value={value.atHour}
        onChange={(e) => set('atHour', Number(e.target.value))} /><i>:</i><input type="number" min="0" max="59" value={value.atMinute}
        onChange={(e) => set('atMinute', Number(e.target.value))} /></label>
      {value.every === 'weekly' && <SelectMenu value={value.weekday} onChange={(e) => set('weekday', Number(e.target.value))}>
        {[[tx("周一"), 1], [tx("周二"), 2], [tx("周三"), 3], [tx("周四"), 4], [tx("周五"), 5], [tx("周六"), 6], [tx("周日"), 7]].map(([label, key]) => <option key={key} value={key}>{label}</option>)}
      </SelectMenu>}
      <label className="at-date"><span>{tx("开始日期")}</span><input type="date" value={value.startDate || ''}
        max={value.endDate || undefined} onChange={(e) => set('startDate', e.target.value)} /></label>
      <label className="at-date"><span>{tx("结束日期")}</span><input ref={endDateRef} type="date" value={value.endDate || ''}
        min={value.startDate || undefined} onChange={(e) => set('endDate', e.target.value)} />
        {errors.endDate && <small className="at-field-error" role="status">{errors.endDate}</small>}</label>
    </div></div>
    <div className="at-section"><b>{tx("执行要求")}</b><div className="at-checks">
      {capOptions.map(([key, label]) => <label key={key}><input type="checkbox" checked={value.requiredCapabilities.includes(key)} onChange={() => toggleCap(key)} />{label}</label>)}
      <label><span>{tx("失败重试")}</span><input className="small" type="number" min="0" max="10" value={value.retryLimit} onChange={(e) => set('retryLimit', Number(e.target.value))} />{tx(" 次")}</label>
      <label><span>{tx("间隔")}</span><input className="small" type="number" min="1" max="1440" value={value.retryDelayMinutes} onChange={(e) => set('retryDelayMinutes', Number(e.target.value))} />{tx(" 分钟")}</label>
    </div></div>
    </form>
  </Modal>
}

export default function AutomationTemplates() {
  const uiLocale = useLocale();
  const listRef = useViewportHeight(180)
  const [items, setItems] = useState(null)
  const [editing, setEditing] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [busy, setBusy] = useState(false)
  const [toggling, setToggling] = useState(null)
  const [error, setError] = useState('')
  const load = () => api.automationTemplates().then((data) => { setItems(data.items || []); setError('') }).catch((e) => setError(e.message || tx("模板暂时加载失败")))
  useEffect(() => { load() }, [])
  const enabled = useMemo(() => (items || []).filter((x) => x.enabled).length, [items, uiLocale])
  async function save() {
    if (!editing || busy) return
    const errors = templateErrors(editing, items)
    if (Object.keys(errors).length) { toast(Object.values(errors)[0]); return }
    setBusy(true)
    try {
      const draft = { ...editing, name: editing.name.trim() }
      const next = editing.updatedAt ? items.map((x) => x.id === editing.id ? draft : x) : [...items, draft]
      const result = await api.saveAutomationTemplates(next)
      setItems(result.items || next); setEditing(null); toast(tx("自动化模板已保存"))
    } catch (e) { toast(tx("保存失败：") + (e.message || tx("请稍后重试"))) }
    finally { setBusy(false) }
  }
  async function toggleEnabled(item) {
    if (busy) return
    setBusy(true); setToggling(item.id)
    const next = items.map((entry) => entry.id === item.id ? { ...entry, enabled: !item.enabled } : entry)
    try {
      const result = await api.saveAutomationTemplates(next)
      setItems(result.items || next)
      toast(item.enabled ? tx("模板已停用，客户端不再展示") : tx("模板已启用，客户端可使用"))
    } catch (e) { toast(tx("保存失败：") + (e.message || tx("请稍后重试"))) }
    finally { setBusy(false); setToggling(null) }
  }
  async function remove(item) {
    setBusy(true)
    try { const result = await api.saveAutomationTemplates(items.filter((x) => x.id !== item.id)); setItems(result.items || []); setPendingDelete(null); toast(tx("模板已删除")) }
    catch (e) { toast(tx("删除失败：") + e.message) }
    finally { setBusy(false) }
  }
  if (error && items === null) return <div className="at-page"><div className="at-error"><Icon name="alert" /><b>{tx("模板没有加载出来")}</b><span>{error}</span><button className="btn btn-ghost" onClick={load}>{tx("重新加载")}</button></div></div>
  if (items === null) return <Loading />
  return <section className="at-page">
    <div className="at-topbar"><div className="at-summary"><span><b>{items.length}</b>{tx(" 个模板")}</span><span><b>{enabled}</b>{tx(" 个已发布")}</span><span>{tx("模板只保存工作说明和默认节奏")}</span></div><button className="btn btn-primary at-create" disabled={busy} onClick={() => setEditing(blank())}><Icon name="plus" />{tx("新建模板")}</button></div>
    <p className="at-visibility-hint">{tx("停用后客户端不再展示模板，已创建的自动化不受影响。")}</p>
    {items.length === 0 && <div className="at-empty"><Icon name="box" /><b>{tx("还没有自动化模板")}</b><span>{tx("把团队重复工作配置一次，员工在客户端的自动化页面就能直接使用。")}</span><button className="btn btn-ghost" disabled={busy} onClick={() => setEditing(blank())}>{tx("创建第一个模板")}</button></div>}
    <div className="at-list admin-viewport-list" ref={listRef} role="region" tabIndex={0} aria-label={tx("自动化模板")}>{items.map((item) => <article className={'at-card' + (item.enabled ? '' : ' off')} key={item.id}><div className="at-card-icon"><Icon name="activity" /></div><div className="at-card-main"><div className="at-card-title"><h3 title={item.name}>{item.name}</h3><code title={item.id}>{item.id}</code>{!item.enabled && <em>{tx("已停用")}</em>}</div><p title={item.description || item.note || tx("暂无说明")}>{item.description || item.note || tx("暂无说明")}</p><div className="at-card-meta"><span title={`${rhythm[item.every] || item.every} · ${String(item.atHour).padStart(2, '0')}:${String(item.atMinute).padStart(2, '0')}`}>{rhythm[item.every] || item.every} · {String(item.atHour).padStart(2, '0')}:{String(item.atMinute).padStart(2, '0')}</span><span title={(item.requiredCapabilities || []).map((key) => (capOptions.find((x) => x[0] === key) || [key, key])[1]).join('、') || tx("基础对话")}>{(item.requiredCapabilities || []).map((key) => (capOptions.find((x) => x[0] === key) || [key, key])[1]).join('、') || tx("基础对话")}</span></div></div><div className="at-card-actions admin-card-actions"><button className="admin-card-action is-primary" disabled={busy} onClick={() => setEditing({ ...item, requiredCapabilities: [...(item.requiredCapabilities || [])] })}>{tx("编辑")}</button><button type="button" className="admin-card-action at-toggle" disabled={busy}
        aria-busy={toggling === item.id} aria-label={item.enabled ? tx("停用模板「{0}」", [item.name]) : tx("启用模板「{0}」", [item.name])}
        onClick={() => toggleEnabled(item)}>{toggling === item.id ? tx("保存中…") : item.enabled ? tx("停用") : tx("启用")}</button><button className="admin-card-action is-danger" disabled={busy} onClick={() => setPendingDelete(item)}>{tx("删除")}</button></div></article>)}</div>
    {editing && <Editor value={editing} items={items} onChange={setEditing} onCancel={() => setEditing(null)} onSave={save} busy={busy} />}
    {pendingDelete && <Confirm title={tx("删除模板")} text={tx("确定删除「{0}」吗？已创建的自动化不会受影响。", [pendingDelete.name])}
      danger confirmText={tx("删除")} onConfirm={() => remove(pendingDelete)} onClose={() => setPendingDelete(null)} />}
  </section>
}
