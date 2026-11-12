import React, { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import TurndownService from 'turndown'
import { tables } from 'turndown-plugin-gfm'
import '../../../client/components/client-auth/legal-html.js'
import { api, getUser } from '../api.js'
import { translateText as tx, useLocale, LOCALES, localeMap } from '../i18n.js'
import { Modal, SelectMenu, toast } from '../ui.jsx'
import LegalDocumentImport from './LegalDocumentImport.jsx'
import './legal-documents.css'
import '../../../client/components/client-auth/legal-html.css'

const blank = { version: '', action: 'notice', defaultLocale: '', format: 'text', translations: {} }
const emptyText = { title: '', content: '', summary: '', format: 'text' }
const names = localeMap(() => ({ terms: '用户协议', privacy: '隐私政策' }))
const panels = localeMap(() => ({ edit: '内容维护', preview: '用户端预览', publish: '发布设置', history: '版本记录' }))
const fieldNames = localeMap(() => ({ title: '文档标题', content: '协议正文', summary: '本语言更新说明' }))
const safeMarkup = content => DOMPurify.sanitize(marked.parse(content || ''), {
  ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'code', 'pre'],
  ALLOWED_ATTR: ['start', 'colspan', 'rowspan']
})

function Preview({ draft, locale }) {
  const content = draft.translations[locale]
  if (!content) return <p className="muted">{tx('导入协议文档后，即可核对和编辑正文')}</p>
  const format = content.format || draft.format
  return <article className="legal-preview" translate="no" lang={locale}>
    {format !== 'html' && <h2>{content.title}</h2>}{draft.version && <small>{draft.version}</small>}
    {format === 'html' ? <div className="sw-legal-html" dangerouslySetInnerHTML={{ __html: globalThis.SoduWorkLegalHtml.sanitize(DOMPurify, content.content) }} /> : format === 'markdown' ? <div dangerouslySetInnerHTML={{ __html: safeMarkup(content.content) }} /> : <div className="legal-plain">{content.content}</div>}
  </article>
}

export default function LegalDocuments() {
  const uiLocale = useLocale()
  if (!getUser()?.isSuper) return <section className="legal-manager legal-access">
    <div className="legal-main"><header className="legal-heading"><h2>{tx('协议与隐私政策')}</h2></header>
      <p role="status">{tx('协议维护需要超级管理员权限')}</p>
      <p className="muted">{tx('当前账号没有协议维护权限。请联系超级管理员，或切换超级管理员账号后进入。')}</p>
    </div>
  </section>
  return <LegalEditor uiLocale={uiLocale} />
}

function LegalEditor({ uiLocale }) {
  const [kind, setKind] = useState('terms'), [panel, setPanel] = useState('edit')
  const [state, setState] = useState(null), [draft, setDraft] = useState(blank)
  const [sourceLocale, setSourceLocale] = useState('')
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [dirty, setDirty] = useState(false)
  const [reviewed, setReviewed] = useState([]), [effectiveAt, setEffectiveAt] = useState('')
  const [dialog, setDialog] = useState(null), [historyVersion, setHistoryVersion] = useState(null)
  const attempt = useRef(0), editor = useRef(null), operation = useRef(false), effectiveInput = useRef(null)
  const localeName = code => { if (LOCALES[code]) return LOCALES[code]; try { return new Intl.DisplayNames([uiLocale], { type: 'language' }).of(code) || code } catch { return code } }
  const date = value => new Date(value).toLocaleString(uiLocale)
  async function load() {
    const stamp = ++attempt.current
    setBusy(true); setError(''); setDialog(null); setHistoryVersion(null)
    try {
      const result = await api.legalDocument(kind)
      if (stamp !== attempt.current) return
      setState(result); setDraft({ ...blank, ...result.draft, version: '' }); setDirty(false); setReviewed([])
      setSourceLocale(result.draft.defaultLocale || Object.keys(result.draft.translations)[0] || '')
    } catch (e) { if (stamp === attempt.current) setError(e.message) }
    finally { if (stamp === attempt.current) setBusy(false) }
  }
  useEffect(() => { setState(null); setPanel('edit'); setEffectiveAt(''); void load(); return () => { attempt.current++ } }, [kind])
  useEffect(() => {
    const leave = event => { if (dirty || operation.current) { event.preventDefault(); event.returnValue = '' } }
    const navigate = event => {
      if (busy || dirty) {
        event.preventDefault()
        if (!busy && typeof event.detail?.proceed === 'function') discard(event.detail.proceed)
      }
    }
    window.addEventListener('beforeunload', leave)
    window.addEventListener('soduwork-before-admin-leave', navigate)
    return () => { window.removeEventListener('beforeunload', leave); window.removeEventListener('soduwork-before-admin-leave', navigate) }
  }, [dirty, busy])
  function discard(proceed) {
    if (busy) return
    if (!dirty) { proceed(); return }
    setDialog({ title: tx('放弃未保存的改动'), text: tx('未保存的内容将丢失，已保存的草稿和已发布版本不受影响。'), label: tx('放弃并继续'), danger: true,
      confirm: () => { setDialog(null); proceed() } })
  }
  function change(next) { setDraft({ ...next, version: '' }); setDirty(true); setReviewed([]); setDialog(null) }
  function textField(key, value) {
    change({ ...draft, translations: { ...draft.translations, [sourceLocale]: { ...draft.translations[sourceLocale], [key]: value } } })
  }
  function changeFormat(next) {
    const row = draft.translations[sourceLocale], previous = row.format || draft.format
    if (next === previous) return
    const apply = () => {
      let content = row.content
      if (previous === 'html') {
        const html = globalThis.SoduWorkLegalHtml.sanitize(DOMPurify, content)
        const converter = new TurndownService({ headingStyle: 'atx' }); converter.use(tables)
        if (next === 'markdown') content = converter.turndown(html)
        else {
          const body = globalThis.SoduWorkLegalHtml.fragment(DOMPurify, html)
          body.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,tr,br').forEach(node => node.append('\n'))
          content = body.textContent
        }
      } else if (next === 'html') {
        if (previous === 'markdown') content = globalThis.SoduWorkLegalHtml.sanitize(DOMPurify, marked.parse(content))
        else { const node = document.createElement('p'); node.textContent = content; content = node.outerHTML }
      }
      change({ ...draft, translations: { ...draft.translations, [sourceLocale]: { ...row, format: next, content } } })
    }
    if (previous === 'html') setDialog({ title: tx('转换正文格式'), text: tx('转换后将失去 Word 的部分排版。建议保留 HTML，需要修改时重新导入 Word。'), label: tx('确认转换'), confirm: apply })
    else apply()
  }
  function importDocument(document) {
    const code = document.locale
    if (!draft.translations[code] && Object.keys(draft.translations).length >= 20) { setError(tx('请提供有效的语言版本（最多 20 种）')); return false }
    change({ ...draft, defaultLocale: draft.defaultLocale || code, translations: { ...draft.translations,
      [code]: { ...emptyText, title: document.title, content: document.content, format: document.format } } })
    setSourceLocale(code); setError('')
    return true
  }
  function removeLanguage() {
    setDialog({ title: tx('移除此语言'), text: tx('仅从当前草稿移除该语言，保存后才会更新草稿。已发布版本保持不变。'), detail: localeName(sourceLocale), label: tx('确认移除'), danger: true,
      confirm: () => {
        const next = { ...draft.translations }; delete next[sourceLocale]
        const first = Object.keys(next)[0] || ''
        change({ ...draft, translations: next, defaultLocale: draft.defaultLocale === sourceLocale ? first : draft.defaultLocale })
        setSourceLocale(first)
      } })
  }
  async function save() {
    if (operation.current) return false
    operation.current = true
    const stamp = attempt.current
    setBusy(true); setError('')
    try {
      const result = await api.saveLegalDraft(kind, { revision: state.revision, draft })
      if (stamp !== attempt.current) return false
      setState(old => ({ ...old, ...result })); setDraft({ ...blank, ...result.draft }); setDirty(false); setReviewed([])
      toast(tx('协议草稿已保存'))
      return true
    } catch (e) { if (stamp === attempt.current) setError(e.message); return false }
    finally { operation.current = false; if (stamp === attempt.current) setBusy(false) }
  }
  async function publish() {
    if (operation.current || !ready) return
    if (!validTime()) return
    operation.current = true
    setBusy(true); setError('')
    try {
      await api.publishLegalDocument(kind, { revision: state.revision, effectiveAt: effectiveAt ? new Date(effectiveAt).toISOString() : null })
      toast(tx('协议版本已发布')); await load(); setPanel('history')
    } catch (e) { setError(e.message); setDialog(null) }
    finally { operation.current = false; setBusy(false) }
  }
  async function openVersion(id) {
    const stamp = ++attempt.current
    setBusy(true); setError('')
    try {
      const result = await api.legalDocumentVersion(id)
      if (stamp === attempt.current) { setHistoryVersion(result); setSourceLocale(result.defaultLocale) }
    } catch (e) { if (stamp === attempt.current) setError(e.message) }
    finally { if (stamp === attempt.current) setBusy(false) }
  }
  async function cancelVersion(id) {
    if (operation.current) return
    operation.current = true
    setBusy(true); setError('')
    try { await api.cancelLegalPublication(id); await load() } catch (e) { setError(e.message); setDialog(null) }
    finally { operation.current = false; setBusy(false) }
  }
  function insert(before, after = '') {
    const node = editor.current, value = draft.translations[sourceLocale].content
    const start = node.selectionStart, end = node.selectionEnd
    textField('content', value.slice(0, start) + before + value.slice(start, end) + after + value.slice(end))
    requestAnimationFrame(() => { node.focus(); node.setSelectionRange(start + before.length, end + before.length) })
  }
  const locales = Object.keys(draft.translations)
  const filled = (row, key) => key === 'content' && (row.format || draft.format) === 'html'
    ? !!globalThis.SoduWorkLegalHtml.fragment(DOMPurify, row.content).textContent.trim() : !!row[key]?.trim()
  const complete = !!draft.defaultLocale && locales.length > 0 && locales.every(key =>
    ['title', 'content', 'summary'].every(field => filled(draft.translations[key], field)))
  const ready = complete && !dirty && state?.revision > 0 && locales.every(key => reviewed.includes(key))
  const text = draft.translations[sourceLocale]
  const previewDraft = panel === 'history' && historyVersion ? historyVersion.payload : draft
  const missing = code => ['title', 'content', 'summary'].filter(key => !filled(draft.translations[code], key))
  function visit(nextPanel, code = nextPanel === 'history' && historyVersion ? historyVersion.defaultLocale : draft.defaultLocale || locales[0] || '') {
    setPanel(nextPanel); setSourceLocale(code); setDialog(null)
  }
  function validTime() {
    if (!effectiveAt || Number.isFinite(new Date(effectiveAt).getTime()) && new Date(effectiveAt) > new Date()) return true
    setDialog(null); setError(tx('生效时间不能早于当前时间')); effectiveInput.current?.focus(); return false
  }
  async function continuePublication() {
    if (!complete) { visit('edit', locales.find(code => missing(code).length) || draft.defaultLocale || locales[0] || ''); return }
    if (dirty || !state?.revision) { if (await save()) visit('preview'); return }
    if (!ready) { visit('preview', locales.find(code => !reviewed.includes(code))); return }
    if (!validTime()) return
    setDialog({ publish: true, title: tx('确认发布'), text: tx('发布后正文不可覆盖。后续修改将生成新版本，历史原文保持不变。'), label: tx('确认发布'), confirm: publish })
  }
  function continueReview() {
    if (!complete || dirty) { void continuePublication(); return }
    const checked = [...new Set([...reviewed, sourceLocale])]
    setReviewed(checked)
    const next = locales.find(code => !checked.includes(code))
    visit(next ? 'preview' : 'publish', next || sourceLocale)
  }
  const nextAction = tx(!complete ? '补全内容' : dirty || !state?.revision ? '保存并继续核对' : !ready ? '核对正文' : '核对发布')
  return <section className="legal-manager">
    <aside className="legal-sidebar" aria-label={tx('协议与隐私政策')}>
      {Object.entries(names).map(([key, label]) => <button type="button" className={'legal-document-card' + (key === kind ? ' active' : '')} key={key}
        disabled={busy} aria-pressed={key === kind} onClick={() => { if (key !== kind) discard(() => setKind(key)) }}>{tx(label)}</button>)}
      <p>{tx('保存草稿后，客户端内容保持不变。发布后按生效时间更新。')}</p>
    </aside>
    <main className="legal-main" aria-busy={busy}>
      <header className="legal-heading"><h2>{tx(names[kind])}</h2><button className="btn btn-ghost" disabled={busy} onClick={() => discard(load)}>{tx('重新加载')}</button></header>
      <nav className="legal-tabs" aria-label={tx('协议管理')}>
        {Object.entries(panels).map(([key, label]) => <button className={'btn btn-ghost' + (panel === key ? ' active' : '')} aria-pressed={panel === key} key={key}
          disabled={busy || !state} onClick={() => visit(key)}>{tx(label)}</button>)}
      </nav>
      {error && <p className="legal-error" role="alert">{tx(error)}</p>}
      {!state && <p className="muted" role="status">{tx(busy ? '加载中…' : '加载失败，请重试')}</p>}
      {state && <fieldset className="legal-fields" disabled={busy}>
        {panel === 'edit' && <>
          <LegalDocumentImport key={kind} disabled={busy} translations={draft.translations} onApply={importDocument} localeName={localeName} Preview={Preview} />
          {locales.length > 1 ? <label className="legal-language-select">{tx('正文语言')}<SelectMenu className="f-in" aria-label={tx('正文语言')} disabled={busy} value={sourceLocale} onChange={e => setSourceLocale(e.target.value)}>{locales.map(code => <option key={code} value={code}>{localeName(code)}</option>)}</SelectMenu></label> : text && <p className="legal-source-language">{tx('正文语言')} · <b>{localeName(sourceLocale)}</b></p>}
          {text ? <>
            <div className="legal-row"><label className="legal-grow">{tx('文档标题')}<input className="f-in" lang={sourceLocale} value={text.title} maxLength={200} onChange={e => textField('title', e.target.value)} /></label>
              <label className="legal-format">{tx('正文格式')}<SelectMenu className="f-in" aria-label={tx('正文格式')} disabled={busy} value={text.format || draft.format} onChange={e => changeFormat(e.target.value)}><option value="html">HTML</option><option value="text">{tx('纯文本')}</option><option value="markdown">Markdown</option></SelectMenu></label></div>
            {(text.format || draft.format) === 'markdown' && <div className="legal-toolbar">
              <button className="btn btn-ghost xs" onClick={() => insert('## ')}>{tx('标题')}</button><button className="btn btn-ghost xs" onClick={() => insert('**', '**')}>{tx('加粗')}</button>
              <button className="btn btn-ghost xs" onClick={() => insert('\n- ')}>{tx('列表')}</button><button className="btn btn-ghost xs" onClick={() => insert('\n|  |  |\n| --- | --- |\n|  |  |\n')}>{tx('表格')}</button></div>}
            {(text.format || draft.format) === 'html' ? <div className="legal-html-editor">
              <p className="muted">{tx('正文保留文档排版。修改原稿后可重新导入，保存草稿前请核对预览。')}</p>
              <Preview draft={draft} locale={sourceLocale} />
              <details><summary>{tx('编辑 HTML 源码')}</summary><label>{tx('协议正文')}<textarea className="f-in legal-editor" lang={sourceLocale} spellCheck={false} value={text.content} maxLength={200000} onChange={e => textField('content', e.target.value)} /></label></details>
            </div> : <label>{tx('协议正文')}<textarea ref={editor} className="f-in legal-editor" lang={sourceLocale} spellCheck={false} value={text.content} maxLength={200000} onChange={e => textField('content', e.target.value)} /></label>}
            <label>{tx('本语言更新说明')}<textarea className="f-in" lang={sourceLocale} rows={3} value={text.summary} maxLength={2000} onChange={e => textField('summary', e.target.value)} /></label>
            <div className="legal-row"><label className="legal-check"><input type="radio" name="legal-default-locale" checked={draft.defaultLocale === sourceLocale} onChange={() => change({ ...draft, defaultLocale: sourceLocale })} />{tx('设为默认原文')}</label>
              <button className="btn btn-ghost" onClick={removeLanguage}>{tx('移除此语言')}</button></div>
          </> : <p className="muted">{tx('导入协议文档后，即可核对和编辑正文')}</p>}
          <footer className="legal-actions"><span className="muted">{tx(dirty ? '有未保存的改动' : state.revision ? '草稿已保存' : '尚未创建草稿')}</span><button className="btn btn-primary" disabled={!dirty} onClick={save}>{tx('保存草稿')}</button></footer>
        </>}
        {panel === 'preview' && <>
          {locales.length > 1 ? <label className="legal-language-select">{tx('正文语言')}<SelectMenu className="f-in" aria-label={tx('正文语言')} disabled={busy} value={sourceLocale} onChange={e => setSourceLocale(e.target.value)}>{locales.map(code => <option key={code} value={code}>{localeName(code)}</option>)}</SelectMenu></label> : text && <p className="legal-source-language">{tx('正文语言')} · <b>{localeName(sourceLocale)}</b></p>}
          <Preview draft={draft} locale={sourceLocale} />
          {text?.summary?.trim() && <p className="legal-summary" translate="no" lang={sourceLocale}>{text.summary}</p>}
          <label className="legal-check"><input type="checkbox" disabled={dirty || !text || !!missing(sourceLocale).length} checked={reviewed.includes(sourceLocale)} onChange={e => setReviewed(old => e.target.checked ? [...old, sourceLocale] : old.filter(code => code !== sourceLocale))} />{tx('已核对该语言的正文与更新说明')}</label>
          {dirty && <p className="muted">{tx('请先保存草稿，再进行发布核对。')}</p>}
          {!complete && <p className="muted">{tx('发布前请补全每个语言版本的标题、正文和更新说明')}</p>}
          <footer className="legal-actions"><button className="btn btn-ghost" onClick={() => visit('edit', sourceLocale)}>{tx('内容维护')}</button>
            <button className="btn btn-primary" onClick={continueReview}>{tx(!complete ? '补全内容' : dirty ? '保存并继续核对' : '确认本语言并继续')}</button></footer>
        </>}
        {panel === 'publish' && <>
          <div className="legal-auto-version"><span>{tx('版本号')}</span><b>{tx('发布时自动生成')}</b><small>{tx('按文档依次生成 v1、v2…；保存草稿不占用版本号。')}</small></div>
          {kind === 'privacy' ? <div className="legal-fixed-field"><span>{tx('更新方式')}</span><p>{tx('通知用户，无需重新同意')}</p></div> :
            <label>{tx('更新方式')}<SelectMenu className="f-in" aria-label={tx('更新方式')} disabled={busy} value={draft.action} onChange={e => change({ ...draft, action: e.target.value })}>
              <option value="notice">{tx('通知用户，无需重新同意')}</option><option value="accept">{tx('需要重新同意用户协议')}</option></SelectMenu></label>}
          {kind === 'privacy' && <p className="muted">{tx('特定处理目的的授权需在对应功能单独取得，政策发布不会代替该授权。')}</p>}
          {kind === 'terms' && draft.action === 'accept' && <p className="muted">{tx('发布前请确认用户已升级到支持重新确认的客户端。')}</p>}
          <label>{tx('生效时间')}<input ref={effectiveInput} className="f-in" type="datetime-local" value={effectiveAt} onChange={e => { setEffectiveAt(e.target.value); setDialog(null); setError('') }} /></label>
          <p className="muted">{tx('留空即发布时生效；填写时间按当前设备时区处理。')}</p>
          <section className="legal-checklist" aria-label={tx('发布前核对')}>
            <h3>{tx('发布前核对')}</h3><p className="muted">{tx('完成下列步骤后即可发布，版本号由系统生成。')}</p>
            {!locales.length && <div className="legal-checklist-row"><span>{tx('请先导入协议文档')}</span><button className="btn btn-ghost xs" onClick={() => visit('edit')}>{tx('导入文档')}</button></div>}
            {!!locales.length && !draft.defaultLocale && <div className="legal-checklist-row"><span>{tx('请设置默认原文')}</span><button className="btn btn-ghost xs" onClick={() => visit('edit', locales[0])}>{tx('补全内容')}</button></div>}
            {locales.map(code => <div className="legal-checklist-row" key={code}>
              <div><b>{localeName(code)}</b><span>{missing(code).length ? tx('待补全：{0}', [missing(code).map(key => tx(fieldNames[key])).join('、')]) : dirty || !state.revision ? tx('保存后可核对正文') : reviewed.includes(code) ? tx('正文已核对') : tx('待核对正文与更新说明')}</span></div>
              <button className="btn btn-ghost xs" onClick={() => visit(missing(code).length ? 'edit' : 'preview', code)}>{tx(missing(code).length ? '补全内容' : reviewed.includes(code) ? '查看' : '去核对')}</button></div>)}
            <div className="legal-checklist-row"><div><b>{tx('草稿状态')}</b><span>{tx(dirty ? '有未保存的改动' : state.revision ? '草稿已保存' : '尚未创建草稿')}</span></div>
              {dirty && <button className="btn btn-ghost xs" onClick={save}>{tx('保存草稿')}</button>}</div>
          </section>
          <footer className="legal-actions"><span className="muted" role="status">{tx(ready ? '核对已完成，可以发布' : '按提示完成核对后发布')}</span><button className="btn btn-primary" onClick={continuePublication}>{tx(nextAction)}</button></footer>
        </>}
        {panel === 'history' && <>
          <div className="legal-history">{state.history.length ? state.history.map(row => <article key={row.id}>
            <div><b translate="no">{row.version}</b><span>{tx(row.canceledAt ? '已取消' : row.id === state.currentId ? '当前版本' : new Date(row.effectiveAt) > new Date() ? '待生效' : '历史版本')}</span>
              <small>{date(row.effectiveAt)} · {row.locales.map(localeName).join(' / ')}</small></div>
            <button className="btn btn-ghost xs" onClick={() => openVersion(row.id)}>{tx('查看')}</button>
            {!row.canceledAt && new Date(row.effectiveAt) > new Date() && <button className="btn btn-ghost xs" onClick={() => setDialog({ title: tx('取消定时发布'), text: tx(dirty ? '取消定时发布会重新加载页面，未保存的改动将丢失。历史快照仍会保留。' : '确定取消此定时发布吗？历史快照仍会保留。'), detail: row.version, label: tx('确认取消发布'), danger: true, confirm: () => cancelVersion(row.id) })}>{tx('取消定时发布')}</button>}
          </article>) : <p className="muted">{tx('尚未发布新版本，客户端继续使用现有协议。')}</p>}</div>
          {historyVersion && <><label>{tx('正文语言')}<SelectMenu className="f-in" aria-label={tx('正文语言')} disabled={busy} value={sourceLocale} onChange={e => setSourceLocale(e.target.value)}>{historyVersion.locales.map(code => <option key={code} value={code}>{localeName(code)}</option>)}</SelectMenu></label>
            <Preview draft={previewDraft} locale={sourceLocale} /><button className="btn btn-ghost" onClick={() => {
              discard(() => { change({ ...historyVersion.payload, version: '' }); setSourceLocale(historyVersion.defaultLocale); setPanel('edit') })
            }}>{tx('以此版本创建草稿')}</button></>}
        </>}
      </fieldset>}
    </main>
    {dialog && <Modal title={tx(dialog.title)} icon={dialog.danger ? 'alert' : 'file'} size="compact" className="legal-dialog" onClose={() => { if (!busy) setDialog(null) }}
      foot={<><button className="btn btn-ghost" disabled={busy} onClick={() => setDialog(null)}>{tx('取消')}</button>
        <button className={'btn ' + (dialog.danger ? 'btn-danger' : 'btn-primary')} disabled={busy} onClick={dialog.confirm}>{tx(busy ? '处理中…' : dialog.label)}</button></>}>
      <p>{tx(dialog.text)}</p>{dialog.detail && <p className="legal-dialog-detail" translate="no">{dialog.detail}</p>}
      {dialog.publish && <dl className="legal-publication-details">
        <dt>{tx('文档')}</dt><dd>{tx(names[kind])}</dd><dt>{tx('版本号')}</dt><dd>{tx('发布时自动生成')}</dd>
        <dt>{tx('正文语言')}</dt><dd>{locales.map(localeName).join(' / ')}</dd>
        <dt>{tx('默认原文')}</dt><dd>{localeName(draft.defaultLocale)}</dd>
        <dt>{tx('更新方式')}</dt><dd>{tx(draft.action === 'accept' ? '需要重新同意用户协议' : '通知用户，无需重新同意')}</dd>
        <dt>{tx('生效时间')}</dt><dd>{effectiveAt ? date(effectiveAt) : tx('立即生效')}</dd>
      </dl>}
    </Modal>}
  </section>
}
