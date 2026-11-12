import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import http from 'node:http'
import { once } from 'node:events'
import { transform } from 'esbuild'

async function fixture(t) {
  const requests = [], events = []
  const storage = new Map([['soduwork_hub_admin_token', 'synthetic-release-token'],
    ['soduwork_hub_admin_user', JSON.stringify({ id: 'fixture-publisher' })]])
  let reply = { status: 200, body: { notes: [{ version: '2.0.0', channel: 'stable', locales: {} }] } }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body })
      res.writeHead(reply.status, { 'Content-Type': 'application/json', 'X-Request-ID': 'fixture-release-notes' })
      res.end(JSON.stringify(reply.body))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const origin = 'http://127.0.0.1:' + server.address().port
  // Execute the actual API exports. Only browser globals and relative URL
  // resolution are supplied; requests use real fetch against loopback HTTP.
  const source = await fs.readFile(new URL('../src/api.js', import.meta.url), 'utf8')
  const { code } = await transform(source, { format: 'cjs', loader: 'js' })
  const module = { exports: {} }
  const browser = { setTimeout, clearTimeout, dispatchEvent: event => events.push(event.type) }
  const localStorage = { getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  new Function('require', 'module', 'exports', 'window', 'localStorage', 'fetch', code)(
    () => ({ translateText: text => text }), module, module.exports, browser, localStorage,
    (url, options) => fetch(new URL(url, origin), options))
  return { api: module.exports.api, storage, requests, events,
    respond: (status, body) => { reply = { status, body } } }
}

test('real release-notes API export sends an authenticated read-only HTTP request', async t => {
  const { api, requests } = await fixture(t)
  assert.equal(typeof api.clientReleaseNotes, 'function', 'the release screen requires this real API export')
  const response = await api.clientReleaseNotes()
  assert.deepEqual(response, { notes: [{ version: '2.0.0', channel: 'stable', locales: {} }] })
  assert.deepEqual(requests, [{ method: 'GET', path: '/api/v1/admin/client-release-notes',
    authorization: 'Bearer synthetic-release-token', body: '' }])
})

test('release-note HTTP errors retain status and expiry clears authentication', async t => {
  const { api, respond, requests, storage, events } = await fixture(t)
  for (const status of [404, 403, 503]) {
    respond(status, { detail: 'fixture failure ' + status })
    await assert.rejects(api.clientReleaseNotes(), error =>
      error.status === status && error.requestId === 'fixture-release-notes'
      && error.message === 'fixture failure ' + status)
    assert.equal(storage.get('soduwork_hub_admin_token'), 'synthetic-release-token')
  }
  respond(401, { detail: 'expired fixture session' })
  await assert.rejects(api.clientReleaseNotes(), error => Boolean(error.message))
  assert.equal(storage.has('soduwork_hub_admin_token'), false)
  assert.equal(storage.has('soduwork_hub_admin_user'), false)
  assert.deepEqual(events, ['soduwork-hub-unauth'])
  assert.equal(requests.length, 4)
  assert.ok(requests.every(row => row.method === 'GET' && row.path === '/api/v1/admin/client-release-notes'))
})

test('quota reads preserve pagination, search encoding and member identity over real HTTP', async t => {
  const { api, requests } = await fixture(t)
  await api.quotaPlans()
  await api.quotaMembers({ q: 'fixture +/&?', limit: 50, offset: 0 })
  await api.quotaMember('fixture member+?')
  assert.equal(requests[0].path, '/api/v1/admin/quotas')
  const members = new URL(requests[1].path, 'http://fixture.invalid')
  assert.equal(members.pathname, '/api/v1/admin/quotas/members')
  assert.deepEqual(Object.fromEntries(members.searchParams), { q: 'fixture +/&?', limit: '50', offset: '0' })
  assert.equal(requests[2].path, '/api/v1/admin/quotas/members/fixture%20member%2B%3F')
  assert.ok(requests.every(row => row.method === 'GET' && row.body === ''
    && row.authorization === 'Bearer synthetic-release-token'))
})

test('quota writes retain revision, zero and unlimited values without changing the payload', async t => {
  const { api, requests } = await fixture(t)
  const config = { revision: 7, defaultLimit: null, plans: [
    { id: 'standard', name: 'Fixture plan', totalLimit: 0, models: [], restrictModels: false },
  ] }
  const assignment = { revision: 2, mode: 'custom', custom: { totalLimit: 0, models: [], restrictModels: false } }
  await api.saveQuotaPlans(config)
  await api.assignQuota('fixture member+?', assignment)
  assert.deepEqual(requests.map(row => [row.method, row.path, JSON.parse(row.body)]), [
    ['PUT', '/api/v1/admin/quotas', config],
    ['PUT', '/api/v1/admin/quotas/members/fixture%20member%2B%3F', assignment],
  ])
  assert.ok(requests.every(row => row.authorization === 'Bearer synthetic-release-token'))
})

test('quota revision conflicts reach the editor with their actual HTTP status', async t => {
  const { api, respond } = await fixture(t)
  respond(409, { detail: 'fixture quota revision conflict' })
  await assert.rejects(api.assignQuota('fixture-member', { revision: 1, mode: 'inherit' }),
    error => error.status === 409 && error.message === 'fixture quota revision conflict')
})
