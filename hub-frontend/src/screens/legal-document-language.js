import { francAll } from 'franc-min'

export function canonicalLanguage(value) {
  try {
    const code = Intl.getCanonicalLocales(String(value || '').trim().replaceAll('_', '-'))[0] || ''
    return /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-\d{3})?$/.test(code) ? code : ''
  } catch { return '' }
}

// Document text determines the language; metadata may refine its regional variant.
// Never derive legal text language from the current UI or deployment environment.
export function detectDocumentLanguage(text, hints = []) {
  const sample = String(text || '').replace(/https?:\/\/\S+|\S+@\S+/g, ' ').slice(0, 20000)
  const letters = sample.match(/\p{L}/gu) || []
  const kana = (sample.match(/[\u3040-\u30ff]/g) || []).length
  const hangul = (sample.match(/[\uac00-\ud7af]/g) || []).length
  const han = (sample.match(/\p{Script=Han}/gu) || []).length
  let family = ''
  if (kana >= 4) family = (kana + han) / letters.length >= 0.65 ? 'ja' : ''
  else if (hangul >= 4) family = hangul / letters.length >= 0.65 ? 'ko' : ''
  else if (han >= 15) family = han / letters.length >= 0.65 ? 'zh' : ''
  else if (letters.length >= 80) {
    const ranked = francAll(sample, { minLength: 80 })
    if (ranked[0]?.[0] !== 'und' && (!ranked[1] || ranked[0][1] - ranked[1][1] >= 0.08)) family = canonicalLanguage(ranked[0][0])
  }
  if (!family) return ''
  return hints.map(canonicalLanguage).find(code => code.split('-')[0] === family) || family
}
