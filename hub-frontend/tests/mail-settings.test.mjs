import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale } from '../src/i18n.js'

async function fixture(overrides = {}) {
  setLocale('zh-CN')
  const calls = [], notices = []
  const settings = { enabled: true, host: 'smtp.126.com', port: 465, security: 'ssl', username: 'sender@126.com', senderAddress: '', senderName: 'SoduWork', ready: true, passwordConfigured: true }
  const page = await createComponentHarness(new URL('../src/screens/MailSettings.jsx', import.meta.url), { dependencies: {
    '../api.js': { api: {
      mailSettings: async () => settings,
      accountPrivacyRequests: async () => ({ items: [] }),
      retryAccountPrivacyRequest: async id => { calls.push(['retry', id]); return { ok: true } },
      accountLegal: async () => ({ operatorName: '', contactEmail: '' }),
      mailDeliveries: async () => ({ items: [] }),
      saveMailSettings: async body => { calls.push(['save', body]); return settings },
      testMailSettings: async recipient => { calls.push(['test', recipient]); return { queued: true } },
      saveAccountLegal: async body => { calls.push(['legal', body]); return body },
      ...overrides,
    } },
    '../ui.jsx': { Icon: 'Icon', SelectMenu: 'SelectMenu', toast: message => notices.push(message) },
    './mail-settings.css': {},
  } })
  page.render(); await page.flush()
  const button = text => page.nodes(node => node.type === 'button' && node.props.children === text)[0]
  return { ...page, calls, notices, button }
}

test('saved authorization stays write-only and blank preserves it on save', async () => {
  const page = await fixture()
  assert.equal(page.nodes(node => node.type === 'input' && node.props.type === 'password')[0].props.value, '')
  page.act(() => page.button('保存配置').props.onClick()); await page.flush()
  assert.equal(page.calls[0][1].password, '')
  assert.equal('passwordConfigured' in page.calls[0][1], false)
  assert.equal('ready' in page.calls[0][1], false)
  page.unmount()
})

test('test mail uses the explicitly entered recipient and reports queued rather than received', async () => {
  const page = await fixture()
  assert.equal(page.button('发送测试邮件').props.disabled, true)
  const input = page.nodes(node => node.type === 'input' && node.props.placeholder === '输入接收测试邮件的地址')[0]
  page.act(() => input.props.onChange({ target: { value: 'receiver@example.com' } }))
  page.act(() => page.button('发送测试邮件').props.onClick()); await page.flush()
  assert.deepEqual(page.calls, [['test', 'receiver@example.com']])
  assert.ok(page.notices.some(text => text.includes('已排队')))
  page.unmount()
})

test('disabled or unconfigured service cannot pretend to send test mail', async () => {
  const page = await fixture({ mailSettings: async () => ({ ready: false }) })
  const input = page.nodes(node => node.type === 'input' && node.props.placeholder === '输入接收测试邮件的地址')[0]
  page.act(() => input.props.onChange({ target: { value: 'receiver@example.com' } }))
  assert.equal(page.button('发送测试邮件').props.disabled, true)
  assert.equal(page.calls.length, 0)
  page.unmount()
})

test('126 preset only changes transport and retains operator input', async () => {
  const page = await fixture()
  const password = page.nodes(node => node.type === 'input' && node.props.type === 'password')[0]
  page.act(() => password.props.onChange({ target: { value: 'typed-authorization' } }))
  page.act(() => page.button('填入 126 邮箱配置').props.onClick())
  page.act(() => page.button('保存配置').props.onClick()); await page.flush()
  assert.equal(page.calls[0][1].host, 'smtp.126.com')
  assert.equal(page.calls[0][1].port, 465)
  assert.equal(page.calls[0][1].password, 'typed-authorization')
  assert.equal(page.calls[0][1].username, 'sender@126.com')
  page.unmount()
})

test('operator fields start empty and cannot save fictitious defaults', async () => {
  const page = await fixture()
  assert.equal(page.button('保存运营信息').props.disabled, true)
  const operator = page.nodes(node => node.type === 'input' && node.props.maxLength === '120')[0]
  assert.ok(operator, 'operator input must enforce the API limit of 120 characters')
  page.act(() => operator.props.onChange({ target: { value: '测试运营主体' } }))
  const inputs = page.nodes(node => node.type === 'input' && node.props.type === 'email')
  page.act(() => inputs.at(-1).props.onChange({ target: { value: 'privacy@example.com' } }))
  page.act(() => page.button('保存运营信息').props.onClick()); await page.flush()
  assert.deepEqual(page.calls, [['legal', { operatorName: '测试运营主体', contactEmail: 'privacy@example.com' }]])
  page.unmount()
})

test('legacy operator settings honor the server edit capability', async () => {
  const page = await fixture({ accountLegal: async () => ({ operatorName: 'Published operator', contactEmail: 'privacy@example.test', canEdit: false }) })
  assert.equal(page.button('保存运营信息').props.disabled, true)
  assert.equal(page.nodes(node => node.type === 'input' && node.props.maxLength === '120')[0].props.disabled, true)
  page.act(() => page.button('保存运营信息').props.onClick()); await page.flush()
  assert.deepEqual(page.calls, [])
  page.unmount()
})

test('unmount while initial settings load is pending cannot update a closed screen', async () => {
  let resolve
  const page = await fixture({ mailSettings: () => new Promise(yes => { resolve = yes }) })
  page.unmount(); resolve({ ready: false }); await new Promise(yes => setImmediate(yes))
})

test('failed deletion can retry while export and completed requests cannot', async () => {
  const page = await fixture({ accountPrivacyRequests: async () => ({ items: [
    { id: 'delete-failed', kind: 'deletion', status: 'failed' },
    { id: 'export-failed', kind: 'export', status: 'failed' },
    { id: 'delete-done', kind: 'deletion', status: 'completed' },
  ] }) })
  assert.equal(page.nodes(node => node.type === 'button' && node.props.children === '重新处理').length, 1)
  page.act(() => page.button('重新处理').props.onClick()); await page.flush()
  assert.deepEqual(page.calls, [['retry', 'delete-failed']]); page.unmount()
})

test('403 from super-only privacy jobs hides that area and does not block SMTP setup', async () => {
  const page = await fixture({ accountPrivacyRequests: async () => { throw Object.assign(Error('Denied'), { status: 403 }) } })
  assert.equal(page.nodes(node => node.type === 'button' && node.props.children === '刷新处理状态').length, 0)
  assert.ok(page.button('保存配置')); page.unmount()
})

for (const dependency of ['accountLegal', 'mailDeliveries']) test(dependency + ' failure preserves loaded SMTP configuration', async () => {
  const page = await fixture({ [dependency]: async () => { throw Error('temporary auxiliary read failure') } })
  const sender = page.nodes(node => node.type === 'input' && node.props.placeholder === 'name@example.com')[0]
  assert.equal(sender.props.value, 'sender@126.com')
  assert.equal(page.button('保存配置').props.disabled, false)
  page.act(() => page.button('保存配置').props.onClick()); await page.flush()
  assert.equal(page.calls[0][1].username, 'sender@126.com')
  assert.equal(page.calls[0][1].enabled, true)
  assert.equal(page.calls[0][1].password, '')
  page.unmount()
})

test('pending delivery history does not block loading or saving SMTP settings', async () => {
  let resolveHistory
  const page = await fixture({ mailDeliveries: () => new Promise(resolve => { resolveHistory = resolve }) })
  assert.equal(page.button('保存配置').props.disabled, false)
  page.act(() => page.button('保存配置').props.onClick()); await page.flush()
  assert.equal(page.calls[0][1].username, 'sender@126.com')
  page.unmount(); resolveHistory({ items: [] }); await new Promise(resolve => setImmediate(resolve))
})

test('failed SMTP settings read blocks mutation until an explicit successful retry', async () => {
  let attempts = 0
  const page = await fixture({ mailSettings: async () => {
    if (++attempts === 1) throw Error('temporary SMTP settings read failure')
    return { enabled: true, username: 'recovered@126.com', ready: true, passwordConfigured: true }
  } })
  assert.equal(page.button('保存配置').props.disabled, true)
  assert.equal(page.button('填入 126 邮箱配置').props.disabled, true)
  page.act(() => page.button('保存配置').props.onClick()); await page.flush()
  assert.equal(page.calls.length, 0, 'the handler also rejects saving unknown server configuration')
  page.act(() => page.button('重试').props.onClick()); await page.flush()
  assert.equal(page.button('保存配置').props.disabled, false)
  page.act(() => page.button('保存配置').props.onClick()); await page.flush()
  assert.equal(page.calls[0][1].username, 'recovered@126.com')
  assert.equal(page.calls[0][1].enabled, true)
  page.unmount()
})

test('successful test submission remains acknowledged when refreshing its history fails', async () => {
  let historyReads = 0
  const page = await fixture({ mailDeliveries: async () => {
    if (++historyReads > 1) throw Error('history temporarily unavailable')
    return { items: [] }
  } })
  const input = page.nodes(node => node.type === 'input' && node.props.placeholder === '输入接收测试邮件的地址')[0]
  page.act(() => input.props.onChange({ target: { value: 'receiver@example.com' } }))
  page.act(() => page.button('发送测试邮件').props.onClick()); await page.flush()
  assert.deepEqual(page.calls, [['test', 'receiver@example.com']])
  assert.ok(page.notices.some(text => text.includes('已排队')))
  assert.equal(page.nodes(node => node.props.role === 'alert' && node.props.children === 'history temporarily unavailable').length, 1)
  page.unmount()
})

test('pending operator information stays read-only while SMTP is editable', async () => {
  let resolveLegal
  const page = await fixture({ accountLegal: () => new Promise(resolve => { resolveLegal = resolve }) })
  const input = () => page.nodes(node => node.type === 'input' && node.props.maxLength === '120')[0]
  assert.equal(input().props.disabled, true)
  assert.equal(page.button('保存配置').props.disabled, false)
  resolveLegal({ operatorName: 'Loaded operator', contactEmail: 'operator@example.test' }); await page.flush()
  assert.equal(input().props.value, 'Loaded operator')
  assert.equal(input().props.disabled, false)
  page.unmount()
})

test('late initial history cannot replace a newer explicit refresh', async () => {
  let resolveInitial, reads = 0
  const page = await fixture({ mailDeliveries: () => ++reads === 1 ? new Promise(resolve => { resolveInitial = resolve })
    : Promise.resolve({ items: [{ id: 'new', recipient: 'new@example.test', state: 'sent' }] }) })
  page.act(() => page.button('刷新').props.onClick()); await page.flush()
  resolveInitial({ items: [{ id: 'old', recipient: 'old@example.test', state: 'failed' }] }); await page.flush()
  assert.equal(page.nodes(node => node.type === 'b' && node.props.children === 'new@example.test').length, 1)
  assert.equal(page.nodes(node => node.type === 'b' && node.props.children === 'old@example.test').length, 0)
  page.unmount()
})


test('Ali enterprise preset preserves the sender and authorization while changing only transport', async () => {
  const page = await fixture()
  const password = page.nodes(node => node.type === 'input' && node.props.type === 'password')[0]
  page.act(() => password.props.onChange({ target: { value: 'typed-authorization' } }))
  assert.ok(page.button('填入阿里邮箱配置'))
  page.act(() => page.button('填入阿里邮箱配置').props.onClick())
  page.act(() => page.button('保存配置').props.onClick()); await page.flush()
  assert.equal(page.calls[0][1].host, 'smtp.qiye.aliyun.com')
  assert.equal(page.calls[0][1].port, 465)
  assert.equal(page.calls[0][1].security, 'ssl')
  assert.equal(page.calls[0][1].username, 'sender@126.com')
  assert.equal(page.calls[0][1].password, 'typed-authorization')
  page.unmount()
})
