import mammoth from 'mammoth/mammoth.browser.js'
import JSZip from 'jszip'
import { prepareDocxLayout } from './legal-docx-layout.js'

const MAX_EXPANDED = 20 * 1024 * 1024

export async function readDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer)
  const files = Object.values(zip.files).filter(file => !file.dir)
  // JSZip 3.10.1 is pinned; check central-directory lengths before decompression.
  if (files.length > 2000 || files.some(file => !Number.isSafeInteger(file._data?.uncompressedSize)) ||
      files.reduce((size, file) => size + file._data.uncompressedSize, 0) > MAX_EXPANDED) throw Error('LEGAL_IMPORT_COMPLEX')
  if (!zip.file('word/document.xml') || !zip.file('[Content_Types].xml')) throw Error('LEGAL_IMPORT_DOCX')
  const documentXml = await zip.file('word/document.xml').async('string')
  const styleXml = await zip.file('word/styles.xml')?.async('string') || ''
  const numberingXml = await zip.file('word/numbering.xml')?.async('string') || ''
  if (/<!DOCTYPE|<!ENTITY/i.test(documentXml + styleXml)) throw Error('LEGAL_IMPORT_DOCX')
  if (/<w:(?:ins|del|moveFrom|moveTo)\b/.test(documentXml)) throw Error('LEGAL_IMPORT_REVISIONS')
  const hints = [...(documentXml + styleXml).matchAll(/<w:lang\b[^>]*>/g)]
    .flatMap(match => [...match[0].matchAll(/w:(?:val|eastAsia)="([^"]+)"/g)].map(value => value[1]))
  let omitted = files.some(file => /^word\/(?:header|footer|comments)\d*\.xml$/.test(file.name))
  const layout = prepareDocxLayout(documentXml, styleXml, numberingXml)
  zip.file('word/document.xml', layout.documentXml)
  const convertedBuffer = await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' })
  const result = await mammoth.convertToHtml({ arrayBuffer: convertedBuffer }, {
    externalFileAccess: false, includeEmbeddedStyleMap: false, ignoreEmptyParagraphs: false,
    styleMap: layout.styleMap, transformDocument: layout.transformDocument,
    convertImage: mammoth.images.imgElement(async () => { omitted = true; return { src: '' } }),
  })
  if (result.messages.some(message => message.type === 'error')) throw Error('LEGAL_IMPORT_CONVERSION')
  if (result.value.length > 1000000) throw Error('LEGAL_IMPORT_COMPLEX')
  return { html: result.value, styles: layout.css, hints, needsReview: omitted || result.messages.length > 0 }
}

if (typeof self !== 'undefined') self.onmessage = async event => {
  try { self.postMessage({ ok: true, ...await readDocx(event.data) }) }
  catch (error) { self.postMessage({ ok: false, error: error.message?.startsWith('LEGAL_IMPORT_') ? error.message : 'LEGAL_IMPORT_DOCX' }) }
}
