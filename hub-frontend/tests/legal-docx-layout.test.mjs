import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { readDocx } from '../src/screens/legal-document-import.worker.js'
import { DOMParser } from '@xmldom/xmldom'
import '../../client/components/client-auth/legal-html.js'

const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
async function word(body, numbering = '') {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="r3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>')
  zip.file('word/document.xml', `<w:document xmlns:w="${ns}"><w:body>${body}</w:body></w:document>`)
  zip.file('word/styles.xml', `<w:styles xmlns:w="${ns}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="160" w:line="360" w:lineRule="auto"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Clause"><w:basedOn w:val="Normal"/><w:pPr><w:ind w:firstLineChars="200"/></w:pPr></w:style></w:styles>`)
  zip.file('word/numbering.xml', `<w:numbering xmlns:w="${ns}">${numbering}</w:numbering>`)
  return zip.generateAsync({ type: 'arraybuffer' })
}
const p = (text, props = '') => `<w:p><w:pPr>${props}</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`
const num = depth => `<w:numPr><w:ilvl w:val="${depth}"/><w:numId w:val="1"/></w:numPr>`
const numbering = '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
const html = result => new DOMParser().parseFromString('<body>' + result.html + '</body>', 'text/xml')

test('Word keeps source paragraph spacing, inherited indentation, alignment, emphasis and empty lines', async () => {
  const result = await readDocx(await word(p('Title', '<w:jc w:val="center"/>') +
    p('Clause', '<w:pStyle w:val="Clause"/><w:spacing w:before="120"/>') + p('') +
    '<w:p><w:r><w:rPr><w:b/><w:u w:val="single"/><w:sz w:val="28"/></w:rPr><w:t>Important</w:t></w:r></w:p>'))
  const paragraphs = Array.from(html(result).getElementsByTagName('p'))
  assert.equal(paragraphs.length, 4)
  assert.equal(result.styles[paragraphs[0].getAttribute('class')]['text-align'], 'center')
  assert.deepEqual(result.styles[paragraphs[1].getAttribute('class')], { 'margin-top': '6pt', 'margin-bottom': '8pt', 'line-height': '1.5', 'font-size': '12pt', 'text-indent': '2em' })
  assert.equal(paragraphs[2].textContent, '\u00a0')
  assert.match(result.html, /<strong>Important<\/strong>/)
  assert.ok(Object.values(result.styles).some(style => style['font-size'] === '14pt' && style['text-decoration-line'] === 'underline'))
  assert.ok(!result.html.includes('bookmark'))
})

test('legal multilevel numbers continue across intervening paragraphs and reset after parent changes', async () => {
  const result = await readDocx(await word(p('Introduction', num(0)) + p('First', num(1)) + p('Second', num(1)) + p('Unnumbered') + p('Third', num(1)) + p('Scope', num(0)) + p('Child', num(1)), numbering))
  assert.deepEqual(Array.from(html(result).getElementsByTagName('p')).map(node => node.textContent), ['1.\u00a0Introduction', '1.1\u00a0First', '1.2\u00a0Second', 'Unnumbered', '1.3\u00a0Third', '2.\u00a0Scope', '2.1\u00a0Child'])
})

test('explicit start overrides are preserved and unsupported numbers fail instead of silently changing clause references', async () => {
  const override = numbering.replace('<w:abstractNumId w:val="0"/>', '<w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="7"/></w:lvlOverride>')
  assert.match((await readDocx(await word(p('Start', num(0)), override))).html, />7\. Start</)
  await assert.rejects(readDocx(await word(p('Unknown', num(0)), numbering.replace('w:val="decimal"', 'w:val="unknown"'))), /LEGAL_IMPORT_CONVERSION/)
})

test('table paragraphs use their own layout and unresolved revisions with alternate namespace prefixes are rejected', async () => {
  const table = '<w:tbl><w:tr><w:tc>' + p('Cell', '<w:jc w:val="right"/>') + '</w:tc></w:tr></w:tbl>'
  const result = await readDocx(await word(p('Before') + table + p('After')))
  const cell = html(result).getElementsByTagName('td')[0].getElementsByTagName('p')[0]
  assert.equal(result.styles[cell.getAttribute('class')]['text-align'], 'right')
  await assert.rejects(readDocx(await word(`<x:ins xmlns:x="${ns}">${p('Revision')}</x:ins>`)), /LEGAL_IMPORT_REVISIONS/)
})

test('shared HTML policy only preserves bounded typographic styles', () => {
  const clean = globalThis.SoduWorkLegalHtml.safeStyle('margin-bottom:8pt;line-height:1.5;text-indent:-18pt;position:fixed;inset:0;background:url(https://untrusted.test);font-size:0;opacity:0;color:transparent;width:99999px;--bad:1;line-height:expression(x);margin-top:9999pt')
  assert.equal(clean, 'margin-bottom:8pt;line-height:1.5;text-indent:-18pt')
})
