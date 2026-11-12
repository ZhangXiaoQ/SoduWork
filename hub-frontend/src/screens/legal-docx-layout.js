import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const children = (node, name) => Array.from(node?.childNodes || []).filter(n => n.namespaceURI === W && n.localName === name)
const child = (node, name) => children(node, name)[0]
const attr = (node, name = 'val') => node?.getAttributeNS(W, name) || ''
const value = (node, name) => attr(child(node, name))
const descendants = (node, name) => Array.from(node?.getElementsByTagNameNS(W, name) || [])
function parse(xml) {
  if (!xml) return null
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw Error('LEGAL_IMPORT_DOCX')
  return new DOMParser({ errorHandler: { warning() { throw Error('LEGAL_IMPORT_DOCX') }, error() { throw Error('LEGAL_IMPORT_DOCX') }, fatalError() { throw Error('LEGAL_IMPORT_DOCX') } } }).parseFromString(xml, 'text/xml')
}
function properties(node) {
  const result = {}
  for (const item of Array.from(node?.childNodes || []).filter(n => n.namespaceURI === W)) {
    result[item.localName] = Object.fromEntries(Array.from(item.attributes).filter(a => a.namespaceURI === W).map(a => [a.localName, a.value]))
    if (item.localName === 'numPr') result.numPr = Object.fromEntries(['numId', 'ilvl'].filter(key => child(item, key)).map(key => [key, value(item, key)]))
  }
  return result
}
function merge(...sources) {
  const result = {}
  for (const source of sources) for (const [key, values] of Object.entries(source || {})) result[key] = { ...result[key], ...values }
  return result
}
const on = prop => prop && !['0', 'false', 'off', 'none'].includes(prop.val)
const numeric = (v, fallback = 0) => v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback
const pt = twips => `${Math.round(numeric(twips) / 20 * 100) / 100}pt`
function runStyles(props) {
  const css = {}
  if (props.sz) css['font-size'] = `${numeric(props.sz.val, 24) / 2}pt`
  if (props.b) css['font-weight'] = on(props.b) ? '700' : '400'
  if (props.i) css['font-style'] = on(props.i) ? 'italic' : 'normal'
  if (props.u) css['text-decoration-line'] = on(props.u) ? 'underline' : 'none'
  return css
}
function paragraphStyles(props) {
  const css = { 'margin-top': '0pt', 'margin-bottom': '0pt', 'line-height': '1.15', ...runStyles(props) }
  const spacing = props.spacing || {}, indent = props.ind || {}
  for (const [word, html] of [['before', 'margin-top'], ['after', 'margin-bottom']]) {
    if (spacing[word] !== undefined) css[html] = pt(spacing[word])
    if (spacing[word + 'Lines'] !== undefined) css[html] = `${numeric(spacing[word + 'Lines']) / 100}em`
    if (on({ val: spacing[word + 'Autospacing'] || '0' })) css[html] = '0.5em'
  }
  if (spacing.line) css['line-height'] = !spacing.lineRule || spacing.lineRule === 'auto' ? String(numeric(spacing.line, 240) / 240) : pt(spacing.line)
  const alignment = { left: 'left', right: 'right', center: 'center', both: 'justify', distribute: 'justify', start: 'start', end: 'end' }[props.jc?.val]
  if (alignment) css['text-align'] = alignment
  if (indent.start !== undefined || indent.left !== undefined) css['margin-left'] = pt(indent.start ?? indent.left)
  if (indent.end !== undefined || indent.right !== undefined) css['margin-right'] = pt(indent.end ?? indent.right)
  if (indent.leftChars !== undefined) css['margin-left'] = `${numeric(indent.leftChars) / 100}em`
  if (indent.rightChars !== undefined) css['margin-right'] = `${numeric(indent.rightChars) / 100}em`
  if (indent.firstLine !== undefined) css['text-indent'] = pt(indent.firstLine)
  if (indent.firstLineChars !== undefined) css['text-indent'] = `${numeric(indent.firstLineChars) / 100}em`
  if (indent.hanging !== undefined) css['text-indent'] = pt(-numeric(indent.hanging))
  if (indent.hangingChars !== undefined) css['text-indent'] = `${-numeric(indent.hangingChars) / 100}em`
  return css
}
function formatNumber(number, format) {
  if (format === 'decimal' || !format) return String(number)
  if (format === 'decimalZero') return String(number).padStart(2, '0')
  if (format === 'none') return ''
  if (/^(upper|lower)Letter$/.test(format)) {
    let text = '', n = number
    while (n > 0) { text = String.fromCharCode(65 + (n - 1) % 26) + text; n = Math.floor((n - 1) / 26) }
    return format === 'lowerLetter' ? text.toLowerCase() : text
  }
  if (/^(upper|lower)Roman$/.test(format) && number > 0 && number < 4000) {
    let text = '', n = number
    for (const [amount, token] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) while (n >= amount) { text += token; n -= amount }
    return format === 'lowerRoman' ? text.toLowerCase() : text
  }
  if (['chineseCounting', 'chineseCountingThousand'].includes(format) && number >= 0 && number < 10000) {
    const digits = '零一二三四五六七八九', units = ['', '十', '百', '千']
    let text = '', zero = false
    for (let i = 3; i >= 0; i--) {
      const digit = Math.floor(number / 10 ** i) % 10
      if (digit) { if (zero) text += digits[0]; text += digits[digit] + units[i]; zero = false }
      else if (text && number % 10 ** i) zero = true
    }
    return (text || digits[0]).replace(/^一十/, '十')
  }
  // Incorrect legal clause numbers are worse than a rejected import.
  throw Error('LEGAL_IMPORT_CONVERSION')
}

// Preserve source layout before Mammoth's semantic conversion discards it. Unique
// bookmarks bind XML paragraphs to its AST, including paragraphs inside tables.
export function prepareDocxLayout(documentXml, stylesXml, numberingXml) {
  const document = parse(documentXml), styles = parse(stylesXml), numbering = parse(numberingXml)
  if (['ins', 'del', 'moveFrom', 'moveTo'].some(name => descendants(document, name).length)) throw Error('LEGAL_IMPORT_REVISIONS')
  const styleNodes = new Map(descendants(styles, 'style').map(node => [attr(node, 'styleId'), node]))
  const defaultId = [...styleNodes].find(([, node]) => attr(node, 'type') === 'paragraph' && attr(node, 'default') === '1')?.[0]
  const defaults = child(styles?.documentElement, 'docDefaults')
  const defaultP = properties(child(child(defaults, 'pPrDefault'), 'pPr'))
  const defaultR = properties(child(child(defaults, 'rPrDefault'), 'rPr'))
  function resolveStyle(id, part, seen = new Set()) {
    if (!id || !styleNodes.has(id)) return {}
    if (seen.has(id) || seen.size > 30) throw Error('LEGAL_IMPORT_COMPLEX')
    seen.add(id)
    const node = styleNodes.get(id)
    return merge(resolveStyle(value(node, 'basedOn'), part, seen), properties(child(node, part)))
  }
  const abstracts = new Map(descendants(numbering, 'abstractNum').map(node => [attr(node, 'abstractNumId'), node]))
  const nums = new Map(descendants(numbering, 'num').map(node => [attr(node, 'numId'), node]))
  function level(numId, index, seen = new Set()) {
    if (seen.has(numId)) throw Error('LEGAL_IMPORT_CONVERSION')
    seen.add(numId)
    const num = nums.get(numId), abstract = abstracts.get(value(num, 'abstractNumId'))
    const linked = value(abstract, 'numStyleLink')
    if (linked) return level(resolveStyle(linked, 'pPr').numPr?.numId, index, seen)
    const override = children(num, 'lvlOverride').find(n => numeric(attr(n, 'ilvl')) === index)
    const base = children(abstract, 'lvl').find(n => numeric(attr(n, 'ilvl')) === index)
    const node = child(override, 'lvl') || base
    if (!node) throw Error('LEGAL_IMPORT_CONVERSION')
    return { node, start: numeric(value(override, 'startOverride') || value(node, 'start'), 1), format: value(node, 'numFmt'), pattern: value(node, 'lvlText'), restart: value(node, 'lvlRestart') }
  }
  const counters = new Map(), paragraphMeta = new Map(), styleMap = [], css = {}, styleKeys = new Map()
  function register(styles, type = 'p', tag = 'p') {
    const key = JSON.stringify([type, tag, styles])
    if (styleKeys.has(key)) return styleKeys.get(key)
    const name = `sw-legal-${styleKeys.size}`
    styleKeys.set(key, name); css[name] = styles
    styleMap.push(`${type}[style-name='${name}'] => ${tag}.${name}${type === 'p' ? ':fresh' : ''}`)
    return name
  }
  const paragraphs = descendants(document, 'p')
  if (paragraphs.length > 10000) throw Error('LEGAL_IMPORT_COMPLEX')
  for (let index = 0; index < paragraphs.length; index++) {
    const p = paragraphs[index], direct = child(p, 'pPr'), styleId = value(direct, 'pStyle') || defaultId
    let props = merge(defaultP, resolveStyle(styleId, 'pPr'), properties(direct))
    const run = merge(defaultR, resolveStyle(styleId, 'rPr'))
    let label = ''
    if (props.numPr?.numId && props.numPr.numId !== '0') {
      const id = props.numPr.numId, depth = numeric(props.numPr.ilvl), spec = level(id, depth)
      if (depth < 0 || depth > 8) throw Error('LEGAL_IMPORT_CONVERSION')
      const counts = counters.get(id) || []
      counts[depth] = counts[depth] === undefined ? spec.start : counts[depth] + 1
      for (let i = depth + 1; i < counts.length; i++) {
        const restart = level(id, i).restart
        if (restart !== '0' && depth <= (restart ? Number(restart) - 1 : i - 1)) counts[i] = undefined
      }
      counters.set(id, counts)
      label = spec.format === 'bullet' ? (spec.pattern.replace(/[\uF000-\uF8FF]/g, '•') || '•') : spec.pattern.replace(/%([1-9])/g, (_, n) => {
        const i = Number(n) - 1, part = level(id, i)
        return formatNumber(counts[i] ?? part.start, child(spec.node, 'isLgl') ? 'decimal' : part.format)
      })
      if (value(spec.node, 'suff') !== 'nothing') label += '\u00a0'
      props = merge(defaultP, properties(child(spec.node, 'pPr')), resolveStyle(styleId, 'pPr'), properties(direct))
    }
    const outline = numeric(props.outlineLvl?.val, -1)
    const tag = outline >= 0 && outline < 6 ? `h${outline + 1}` : 'p'
    const name = register(paragraphStyles(merge(run, props)), 'p', tag)
    const marker = `sw_legal_paragraph_${index}`
    const bookmark = document.createElementNS(W, 'w:bookmarkStart')
    bookmark.setAttributeNS(W, 'w:name', marker); bookmark.setAttributeNS(W, 'w:id', String(1000000 + index))
    p.insertBefore(bookmark, direct ? direct.nextSibling : p.firstChild)
    const end = document.createElementNS(W, 'w:bookmarkEnd'); end.setAttributeNS(W, 'w:id', String(1000000 + index)); p.appendChild(end)
    paragraphMeta.set(marker, { name, label })
  }
  function transformDocument(root) {
    function visit(node) {
      if (node.children) node.children = node.children.map(visit)
      if (node.type === 'run') {
        const styles = {}
        if (node.fontSize) styles['font-size'] = `${node.fontSize}pt`
        if (node.isUnderline) styles['text-decoration-line'] = 'underline'
        if (Object.keys(styles).length) { node.styleId = null; node.styleName = register(styles, 'r', 'span') }
      }
      if (node.type === 'paragraph') {
        const marker = node.children.find(n => n.type === 'bookmarkStart' && paragraphMeta.has(n.name))
        const meta = paragraphMeta.get(marker?.name)
        if (meta) {
          node.children = node.children.filter(n => n !== marker)
          node.numbering = null; node.styleId = null; node.styleName = meta.name
          if (meta.label) node.children.unshift({ type: 'text', value: meta.label })
          // Empty source paragraphs occupy one line, not a browser-specific p margin.
          const hasContent = node => node.type === 'text' && node.value || node.type === 'break' || node.type === 'image' || node.children?.some(hasContent)
          if (!node.children.some(hasContent)) node.children.push({ type: 'text', value: '\u00a0' })
        }
      }
      return node
    }
    return visit(root)
  }
  return { documentXml: new XMLSerializer().serializeToString(document), styleMap, css, transformDocument }
}
