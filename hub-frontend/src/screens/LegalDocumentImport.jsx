import React, { useEffect, useRef, useState } from 'react'
import { translateText as tx, LOCALES } from '../i18n.js'
import { canonicalLanguage } from './legal-document-language.js'
import { SelectMenu } from '../ui.jsx'

export default function LegalDocumentImport({ disabled, translations, onApply, localeName, Preview }) {
  const input = useRef(null), request = useRef(null)
  const [pending, setPending] = useState(null), [reading, setReading] = useState(false), [error, setError] = useState('')
  const [correcting, setCorrecting] = useState(false), [custom, setCustom] = useState('')
  useEffect(() => () => request.current?.abort(), [])
  async function choose(event) {
    const file = event.target.files?.[0]; event.target.value = ''
    if (!file) return
    request.current?.abort()
    const controller = new AbortController(); request.current = controller
    setReading(true); setPending(null); setError(''); setCorrecting(false); setCustom('')
    try {
      const { importLegalDocument } = await import('./legal-document-import.js')
      const result = await importLegalDocument(file, { signal: controller.signal })
      if (controller.signal.aborted) return
      setPending(result); setCorrecting(!result.locale)
    } catch (cause) {
      if (controller.signal.aborted) return
      setError(cause.code === 'LEGAL_IMPORT' ? cause.message : tx('无法完整转换此文档，请检查原文件后重试'))
    } finally { if (!controller.signal.aborted) setReading(false) }
  }
  const code = pending?.locale === 'custom' ? canonicalLanguage(custom) : pending?.locale || ''
  const replacing = !!translations[code]
  const preview = pending && { translations: { [code]: pending } }
  return <div className="legal-import">
    <div className="legal-row">
      <button type="button" className="btn btn-ghost" disabled={disabled || reading} onClick={() => input.current.click()}>{tx(reading ? '正在解析文档…' : '导入文档')}</button>
      <span className="muted">{tx('支持 Word、TXT、Markdown，正文语言随文档识别')}</span>
      <input ref={input} type="file" accept=".docx,.txt,.md" hidden disabled={disabled || reading} onChange={choose} />
    </div>
    {reading && <p role="status" className="muted">{tx('正在读取文档并识别语言')}</p>}
    {error && <p role="alert" className="legal-error">{tx(error)}</p>}
    {pending && <section className="legal-import-review" aria-label={tx('核对导入内容')}>
      <header className="legal-heading"><h3>{tx('核对导入内容')}</h3><span translate="no">{pending.fileName}</span></header>
      <div className="legal-row"><p>{tx('正文语言')} · <b>{code ? localeName(code) : tx('未能确定正文语言')}</b></p>
        {!correcting && <button type="button" className="btn btn-ghost xs" onClick={() => setCorrecting(true)}>{tx('更正语言')}</button>}</div>
      {correcting && <div className="legal-row"><label>{tx('确认正文语言')}<SelectMenu className="f-in" aria-label={tx('确认正文语言')} disabled={disabled} value={pending.locale} onChange={event => setPending({ ...pending, locale: event.target.value })}>
        <option value="" disabled>{tx('请选择文档实际使用的语言')}</option>
        {pending.locale && pending.locale !== 'custom' && !LOCALES[pending.locale] && <option value={pending.locale}>{localeName(pending.locale)}</option>}
        {Object.entries(LOCALES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
        <option value="custom">{tx('其他语言')}</option>
      </SelectMenu></label>{pending.locale === 'custom' && <label>{tx('语言标识')}<input className="f-in" placeholder="fr-FR" value={custom} onChange={event => setCustom(event.target.value)} /></label>}</div>}
      <p className="muted">{tx('请对照原稿核对正文。导入只修改草稿，保存并发布后客户端才会更新。')}</p>
      {pending.needsReview && <p role="status" className="legal-import-warning">{tx('部分图片、页眉页脚或特殊排版未导入，请对照原稿补齐。')}</p>}
      {replacing && <p className="legal-import-warning">{tx('将替换草稿中此语言的标题与正文，其他语言保持不变。')}</p>}
      <Preview draft={preview} locale={code} />
      <div className="legal-actions"><button type="button" className="btn btn-ghost" onClick={() => setPending(null)}>{tx('取消')}</button>
        <button type="button" className="btn btn-primary" disabled={disabled || !code} onClick={() => { if (onApply({ ...pending, locale: code }) !== false) setPending(null) }}>{tx(replacing ? '替换此语言草稿' : '导入到草稿')}</button></div>
    </section>}
  </div>
}
