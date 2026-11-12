import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'
import * as healthVersion from '../src/health-version.js'
import { setLocale } from '../src/i18n.js'

async function mount(t, { permissions = ['identity.manage', 'task.view'], active = 'overview', isSuper = false } = {}) {
  setLocale('zh-CN')
  const values = new Map([['soduwork-hub-screen', active]])
  const descriptors = new Map(['window', 'document', 'sessionStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const events = new EventTarget()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    setInterval() { return 1 }, clearInterval() {}, scrollTo() {},
  } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    hidden: false, documentElement: {}, addEventListener() {}, removeEventListener() {},
  } })
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value),
  } })
  const user = { username: 'admin-fixture', displayName: 'Fixture Admin', isSuper }
  const page = await createComponentHarness(new URL('../src/App.jsx', import.meta.url), { dependencies: {
    './api.js': { api: { me: async () => user, health: async () => ({ ok: true }) }, getToken: () => 'fixture',
      getUser: () => user, setUser() {}, setToken() {}, can: permission => permissions.includes(permission) },
    './Login.jsx': 'Login', './LocaleSettings.jsx': 'LocaleSettings', './Landing.jsx': 'Landing',
    './ui.jsx': { Icon: 'Icon', Loading: 'Loading', ThemeToggle: 'ThemeToggle', ToastHost: 'ToastHost' },
    './health-version.js': healthVersion,
  } })
  page.render(); await page.flush()
  t.after(() => {
    page.unmount()
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  })
  const buttons = () => page.nodes(node => node.type === 'button' && String(node.props.className).startsWith('nav-item'))
  const account = () => buttons().find(node => node.props.children[1].props.children === '账户与安全')
  const screen = () => page.nodes(node => node.props.className === 'app')[0].props['data-screen']
  const legal = () => buttons().find(node => node.props.children[1].props.children === '协议与隐私政策')
  return { page, account, legal, screen, values, events }
}

test('identity administrator can open account security from the visible organization navigation', async t => {
  const { page, account, screen, values } = await mount(t)
  assert.ok(account(), 'mail configuration needs a reachable navigation entry')
  page.act(() => account().props.onClick())
  assert.equal(screen(), 'account-security')
  assert.equal(account().props['aria-current'], 'page')
  assert.equal(values.get('soduwork-hub-screen'), 'account-security')
})

test('saved account security selection reopens the configured page after refresh', async t => {
  const { account, screen } = await mount(t, { active: 'account-security', isSuper: true })
  assert.ok(account())
  assert.equal(screen(), 'account-security')
})

test('integration management alone cannot expose or restore the identity-protected page', async t => {
  const { account, screen } = await mount(t, { permissions: ['integration.manage', 'task.view'], active: 'account-security' })
  assert.equal(account(), undefined)
  assert.equal(screen(), 'overview')
})

test('ordinary administrators cannot expose or restore superuser-only legal management', async t => {
  const regular = await mount(t, { active: 'legal-documents' })
  assert.equal(regular.legal(), undefined)
  assert.equal(regular.screen(), 'overview')
})

test('platform administrators can open legal publication management', async t => {
  const { page, legal, screen } = await mount(t, { isSuper: true })
  assert.ok(legal())
  page.act(() => legal().props.onClick())
  assert.equal(screen(), 'legal-documents')
})

test('unsaved-page guards can cancel sidebar and cross-page navigation without changing the stored screen', async t => {
  const { page, account, screen, values, events } = await mount(t)
  const keepDraft = event => event.preventDefault()
  events.addEventListener('soduwork-before-admin-leave', keepDraft)
  page.act(() => account().props.onClick())
  assert.equal(screen(), 'overview')
  page.act(() => events.dispatchEvent(new CustomEvent('soduwork-hub-nav', { detail: { screen: 'account-security' } })))
  assert.equal(screen(), 'overview')
  assert.equal(values.get('soduwork-hub-screen'), 'overview')
  events.removeEventListener('soduwork-before-admin-leave', keepDraft)
  page.act(() => account().props.onClick())
  assert.equal(screen(), 'account-security')
})

test('a confirmed asynchronous guard resumes only its requested navigation once', async t => {
  const { page, account, screen, events } = await mount(t)
  let proceed
  const defer = event => { event.preventDefault(); proceed = event.detail.proceed }
  events.addEventListener('soduwork-before-admin-leave', defer)
  page.act(() => account().props.onClick())
  assert.equal(screen(), 'overview')
  assert.equal(typeof proceed, 'function')
  page.act(() => proceed())
  assert.equal(screen(), 'account-security')
  events.removeEventListener('soduwork-before-admin-leave', defer)
  page.act(() => events.dispatchEvent(new CustomEvent('soduwork-hub-nav', { detail: { screen: 'overview' } })))
  page.act(() => proceed())
  assert.equal(screen(), 'overview')
})
