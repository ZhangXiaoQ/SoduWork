import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale } from '../src/i18n.js'
const dependencies = {
  '../api.js': { api: {} },
  '../ui.jsx': { Modal: () => null, Confirm: () => null, Icon: () => null, Loading: () => null, SelectMenu: () => null, toast() {} },
  '../components/LocalesEditor.jsx': () => null, './automation-templates.css': {},
}
const valid = { id: 'daily-report', name: '日报', every: 'daily', note: 'Summarize', enabled: true, requiredCapabilities: [] }
const cases = [
  [{ id: '' }, 'id', /填写模板标识/], [{ id: 'a' }, 'id', /2–64/],
  [{ id: 'a'.repeat(65) }, 'id', /2–64/], [{ id: 'Daily-Report' }, 'id', /小写/],
  [{ id: ' daily-report' }, 'id', /空格/], [{ id: 'daily-report\n' }, 'id', /空格/],
  [{ id: '_daily' }, 'id', /开头/], [{ id: '每日' }, 'id', /小写/],
  [{ id: 'daily/report' }, 'id', /仅支持/], [{ id: 'daily report' }, 'id', /空格/],
  [{ name: ' 　' }, 'name', /不能全为空白/], [{ name: '' }, 'name', /填写/],
  [{ name: '报'.repeat(81) }, 'name', /80/], [{ name: '日报\n总结' }, 'name', /控制字符/],
  [{ name: '日报\u0000' }, 'name', /控制字符/],
]

test('invalid identities show field errors and cannot submit, while correction clears feedback', async t => {
  setLocale('zh-CN')
  for (const [changes, field, expected] of cases) {
    const calls = []
    let props = { value: { ...valid, ...changes }, onChange() {}, onCancel() {}, onSave: () => calls.push('save') }
    const page = await createComponentHarness(new URL('../src/screens/AutomationTemplates.jsx', import.meta.url), {
      exportName: 'Editor', privateExports: ['Editor'], dependencies, props,
    })
    try {
      assert.equal(page.nodes(n => n.props.className === 'at-field-error').length, 0, 'initial empty form is not covered in errors')
      page.act(() => page.nodes(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }))
      assert.equal(calls.length, 0)
      assert.equal(page.nodes(n => n.type === 'input' && n.props.name === field)[0].props['aria-invalid'], true)
      assert.match(page.nodes(n => n.props.className === 'at-field-error')[0].props.children, expected)
      props = { ...props, value: valid }; page.render(props)
      assert.equal(page.nodes(n => n.props.className === 'at-field-error').length, 0)
      page.act(() => page.nodes(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }))
      assert.deepEqual(calls, ['save'])
    } finally { page.unmount() }
  }
})

test('creation rejects existing IDs including disabled templates, but editing itself is valid', async () => {
  setLocale('zh-CN')
  const calls = []
  const props = { value: valid, items: [{ ...valid, enabled: false }], onChange() {}, onCancel() {}, onSave: () => calls.push('save') }
  const page = await createComponentHarness(new URL('../src/screens/AutomationTemplates.jsx', import.meta.url), {
    exportName: 'Editor', privateExports: ['Editor'], dependencies, props,
  })
  try {
    page.act(() => page.nodes(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }))
    assert.equal(calls.length, 0)
    assert.match(page.nodes(n => n.props.className === 'at-field-error')[0].props.children, /已存在/)
    page.render({ ...props, value: { ...valid, updatedAt: '2026-11-02' } })
    page.act(() => page.nodes(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }))
    assert.deepEqual(calls, ['save'])
    assert.equal(page.nodes(n => n.props.name === 'id')[0].props.disabled, true)
  } finally { page.unmount() }
})

test('boundaries and multilingual names remain valid without silent rewriting', async () => {
  for (const value of [{ ...valid, id: 'a1', name: '报' }, { ...valid, id: 'a'.repeat(64), name: '报'.repeat(80) },
    { ...valid, id: '1.a_b-c', name: ' Weekly 日報 주간 / Review（2026） 📊 ' }, { ...valid, name: '📊'.repeat(80) }]) {
    const page = await createComponentHarness(new URL('../src/screens/AutomationTemplates.jsx', import.meta.url), {
      exportName: 'templateErrors', privateExports: ['templateErrors'], dependencies, props: value,
    })
    assert.deepEqual(page.render(), {}); page.unmount()
  }
})

test('date controls retain optional bounds and reject a reversed range before saving', async () => {
  setLocale('zh-CN')
  const saved = [], changes = []
  const props = { value: { ...valid, startDate: '2030-02-01', endDate: '2030-01-31' },
    onChange: value => changes.push(value), onCancel() {}, onSave: () => saved.push('save') }
  const page = await createComponentHarness(new URL('../src/screens/AutomationTemplates.jsx', import.meta.url), {
    exportName: 'Editor', privateExports: ['Editor'], dependencies, props,
  })
  try {
    const dates = () => page.nodes(n => n.type === 'input' && n.props.type === 'date')
    assert.equal(dates().length, 2)
    assert.equal(dates()[0].props.max, '2030-01-31')
    assert.equal(dates()[1].props.min, '2030-02-01')
    page.act(() => page.nodes(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }))
    assert.deepEqual(saved, [])
    assert.match(page.nodes(n => n.props.className === 'at-field-error')[0].props.children, /结束日期不能早于开始日期/)
    page.act(() => dates()[1].props.onChange({ target: { value: '2030-02-28' } }))
    assert.equal(changes[0].startDate, '2030-02-01')
    assert.equal(changes[0].endDate, '2030-02-28')
    page.render({ ...props, value: changes[0] })
    page.act(() => page.nodes(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }))
    assert.deepEqual(saved, ['save'])
    page.render({ ...props, value: valid })
    assert.equal(dates()[0].props.value, '')
    assert.equal(dates()[1].props.min, undefined)
    page.act(() => page.nodes(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }))
    assert.deepEqual(saved, ['save', 'save'])
  } finally { page.unmount() }
})
