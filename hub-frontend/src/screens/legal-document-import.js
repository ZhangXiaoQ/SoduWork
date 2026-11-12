import DOMPurify from 'dompurify'
import { marked } from 'marked'
import '../../../client/components/client-auth/legal-html.js'
import { detectDocumentLanguage } from './legal-document-language.js'
import { deferredMessageKey } from '../i18n.js'

const tags = ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'code', 'pre', 'a', 'sup', 'sub']
const options = { ALLOWED_TAGS: tags, ALLOWED_ATTR: ['href', 'start', 'colspan', 'rowspan'] }
const errorFor = message => Object.assign(Error(message), { code: 'LEGAL_IMPORT' })
const fail = message => { throw errorFor(message) }
const workerMessages = {
  LEGAL_IMPORT_COMPLEX: deferredMessageKey('文档过大或结构过于复杂，请精简后导入'),
  LEGAL_IMPORT_DOCX: deferredMessageKey('无法读取此 Word 文档，请另存为 .docx 后重试'),
  LEGAL_IMPORT_REVISIONS: deferredMessageKey('文档包含未确认的修订，请先在 Word 中处理修订后再导入'),
  LEGAL_IMPORT_CONVERSION: deferredMessageKey('无法完整转换此文档，请检查原文件后重试'),
}
const abortError = () => new DOMException('Import canceled', 'AbortError')

function convertDocx(buffer, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./legal-document-import.worker.js', import.meta.url), { type: 'module' })
    const finish = (error, result) => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); worker.terminate(); error ? reject(error) : resolve(result) }
    const cancel = () => finish(abortError())
    const timer = setTimeout(() => finish(errorFor(deferredMessageKey('文档解析超时，请精简后重试'))), 20000)
    worker.onmessage = event => finish(event.data.ok ? null : errorFor(workerMessages[event.data.error] || workerMessages.LEGAL_IMPORT_DOCX), event.data)
    worker.onerror = () => finish(errorFor(workerMessages.LEGAL_IMPORT_DOCX))
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) { cancel(); return }
    worker.postMessage(buffer, [buffer])
  })
}

function decodeText(buffer) {
  const bytes = new Uint8Array(buffer)
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw Error('binary')
    return text
  } catch { return fail(deferredMessageKey('文本编码无法识别，请另存为 UTF-8 后导入')) }
}

export async function importLegalDocument(file, { signal } = {}) {
  const extension = file.name.split('.').pop().toLowerCase()
  if (!['docx', 'txt', 'md'].includes(extension)) fail(deferredMessageKey('请选择 .docx、.txt 或 .md 文档'))
  if (!file.size || file.size > 5 * 1024 * 1024) fail(deferredMessageKey('请选择不超过 5 MB 的非空文档'))
  const buffer = await file.arrayBuffer()
  if (signal?.aborted) throw abortError()
  let content, html, hints = [], needsReview = false, title = file.name.replace(/\.[^.]+$/, '')
  const format = extension === 'docx' ? 'html' : extension === 'txt' ? 'text' : 'markdown'
  if (extension === 'docx') {
    const converted = await convertDocx(buffer, signal)
    hints = converted.hints; needsReview = converted.needsReview
    const source = document.createElement('div')
    source.append(DOMPurify.sanitize(converted.html, { ALLOWED_TAGS: [...tags, 'h5', 'h6', 'span', 'u', 's'], ALLOWED_ATTR: [...options.ALLOWED_ATTR, 'class'], RETURN_DOM_FRAGMENT: true }))
    source.querySelectorAll('[class]').forEach(node => {
      const styles = converted.styles[node.getAttribute('class')]
      node.removeAttribute('class')
      if (styles) node.setAttribute('style', globalThis.SoduWorkLegalHtml.safeStyle(Object.entries(styles).map(([key, value]) => `${key}:${value}`).join(';')))
    })
    source.querySelectorAll('a').forEach(node => {
      const href = node.getAttribute('href') || ''
      if (/^(?:https?:|mailto:)/i.test(href) && !node.textContent.includes(href)) node.append(document.createTextNode(` (${href})`))
    })
    const heading = source.firstElementChild
    if (heading && heading.textContent.trim() && heading.textContent.trim().length <= 200) {
      title = heading.textContent.trim()
    }
    html = content = globalThis.SoduWorkLegalHtml.sanitize(DOMPurify, source.innerHTML)
  } else {
    content = decodeText(buffer)
    html = extension === 'md' ? DOMPurify.sanitize(marked.parse(content), options) : ''
    const heading = extension === 'md' && content.match(/^#{1,2}\s+([^\r\n]+)\r?\n/)
    if (heading) {
      const titleText = DOMPurify.sanitize(marked.parse(heading[0]), { ...options, RETURN_DOM_FRAGMENT: true }).textContent.trim()
      if (titleText.length <= 200) { title = titleText; content = content.slice(heading[0].length).replace(/^\r?\n/, '') }
    }
  }
  if (signal?.aborted) throw abortError()
  if (!content.trim()) fail(deferredMessageKey('文档中没有可导入的正文'))
  if (content.length > 200000) fail(deferredMessageKey('正文超过 200000 字符，请拆分或精简后导入'))
  const parsed = document.createElement('div')
  if (html) parsed.append(DOMPurify.sanitize(html, { ...options, RETURN_DOM_FRAGMENT: true }))
  const plain = html ? parsed.textContent : content
  if (!plain.trim()) fail(deferredMessageKey('文档中没有可导入的正文'))
  return { fileName: file.name, title: title.trim().slice(0, 200), content, format, locale: detectDocumentLanguage(plain, hints), needsReview }
}
