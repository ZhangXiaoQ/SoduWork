// Exercise production React, API serialization, native controls and layout against an isolated HTTP fixture.
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), os = require('node:os')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..'), dist = path.join(root, 'dist')
const output = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-quota-admin-'))
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, 'profile'))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
const user = { id: 'quota-fixture-admin', displayName: 'Quota administrator', isSuper: false, permissions: ['quota.manage'] }
const models = [{ provider: 'primary', providerName: 'Primary', model: 'model-a', label: 'Model A' }, { provider: 'secondary', providerName: 'Secondary', model: 'model-b', label: 'Model B' }]
let catalog = { revision: 1, defaultLimit: 1000000, models, plans: [
  { id: 'trial', name: 'Trial', description: '', period: 'once', durationDays: 7, totalLimit: 100000, models: [], restrictModels: false },
  { id: 'standard', name: 'Standard', description: '', period: 'monthly', durationDays: 7, totalLimit: 1000000, models: [], restrictModels: false },
  { id: 'pro', name: 'Pro', description: '', period: 'monthly', durationDays: 7, totalLimit: 5000000, models: [], restrictModels: false },
] }
let member = { id: 'fixture-alice', username: 'alice@example.invalid', displayName: 'Alice', isActive: true,
  quota: { used: 13160809, limit: 1000000, totalLimited: true, exceeded: true, reason: 'total_exhausted', period: '2026-10', planName: 'Standard', models: [], resetsAt: '2026-11-01T00:00:00Z' },
  legacyOverride: { mode: 'inherit', limit: 0 }, assignment: { revision: 2, mode: 'plan', planId: 'standard', custom: null, hasTrial: false } }
let server, win
const checks = [], errors = [], requests = [], saves = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = code => win.webContents.executeJavaScript(code, true)
async function waitFor(code, name) {
  for (let i = 0; i < 160; i++) { if (await js(code)) return; await sleep(50) }
  throw Error('Timed out: ' + name)
}
async function point(code) {
  const position = await js(`(() => {const e=(${code});if(!e)throw Error('Missing click target');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...position })
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...position })
  await sleep(60)
}
const click = text => point(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)})`)
const findField = label => `[...document.querySelectorAll('.qm-editor label')].find(e=>e.querySelector('span')?.textContent===${JSON.stringify(label)})?.querySelector('input')`
async function input(code, value) {
  await point(code)
  // The fixture window stays hidden. Dispatch a native input event without
  // depending on which business window currently owns the desktop keyboard.
  await js(`(() => {const input=(${code});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await sleep(60)
  assert.equal(await js('(' + code + ').value'), value, 'form input receives the intended value')
}
async function select(selector, option) {
  await point(`document.querySelector(${JSON.stringify(selector)})`)
  await waitFor('!!document.querySelector("[role=listbox]")', 'select menu')
  await point(`[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.trim()===${JSON.stringify(option)})`)
}
async function shot(name) {
  // Refresh the hidden window's compositor before collecting visual evidence.
  const [width, height] = win.getSize()
  win.setSize(width + 1, height); await sleep(80)
  win.setSize(width, height); await sleep(140)
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG())
}
const respond = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
function readBody(req) { return new Promise(resolve => { let body = ''; req.on('data', part => { body += part }); req.on('end', () => resolve(body ? JSON.parse(body) : {})) }) }

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
    requests.push({ method: req.method, path: url.pathname, query: url.search })
    if (url.pathname === '/healthz') return respond(res, 200, { ok: true, version: 'fixture-only' })
    if (url.pathname === '/api/v1/admin/me') return respond(res, 200, user)
    if (url.pathname === '/api/v1/admin/quotas') {
      if (req.method === 'GET') return respond(res, 200, catalog)
      const body = await readBody(req)
      if (body.revision !== catalog.revision) return respond(res, 409, { detail: 'Fixture revision conflict' })
      assert.equal('models' in body, false, 'read-only choices must never be persisted')
      assert.ok(body.plans.every(plan => plan.durationDays >= 1 && plan.durationDays <= 365), 'all plan durations satisfy the actual backend schema')
      assert.ok(catalog.plans.every(plan => body.plans.some(next => next.id === plan.id)), 'all existing plans retained')
      saves.push(body); catalog = { ...body, models, revision: catalog.revision + 1 }
      const { models: ignored, ...saved } = catalog
      return respond(res, 200, saved)
    }
    if (url.pathname === '/api/v1/admin/quotas/members') {
      const offset = Number(url.searchParams.get('offset'))
      assert.equal(Number(url.searchParams.get('limit')), 50)
      return respond(res, 200, { offset, limit: 50, total: 52, items: [offset ? { ...member, id: 'last-member', displayName: 'Last member' } : member] })
    }
    if (url.pathname === '/api/v1/admin/quotas/members/' + member.id) {
      if (req.method === 'GET') return respond(res, 200, member)
      const body = await readBody(req)
      if (body.revision !== member.assignment.revision) return respond(res, 409, { detail: 'Fixture assignment conflict' })
      saves.push(body)
      member = { ...member, assignment: { ...member.assignment, ...body, revision: body.revision + 1 }, quota: { ...member.quota, ...(body.mode === 'custom' ? { limit: body.custom.totalLimit ?? 0, totalLimited: body.custom.totalLimit !== null, models: body.custom.models } : {}) } }
      return respond(res, 200, { ok: true, revision: member.assignment.revision })
    }
    return respond(res, 404, { detail: 'Unexpected fixture endpoint: ' + url.pathname })
  }
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
  const file = path.resolve(dist, relative)
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
  let body = fs.readFileSync(file)
  if (relative === 'index.html') {
    const setup = `localStorage.setItem('soduwork_hub_admin_token','quota-fixture-token');localStorage.setItem('soduwork_hub_admin_user',${JSON.stringify(JSON.stringify(user))});sessionStorage.setItem('soduwork-hub-screen','quotas');localStorage.setItem('soduwork.locale',${JSON.stringify(url.searchParams.get('locale') || 'zh-CN')});`
    body = Buffer.from(body.toString().replace('<head>', '<head><script>' + setup + '</script>'))
  }
  res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); res.end(body)
}

async function finish(error) {
  if (error && win && !win.isDestroyed()) await shot('failure').catch(() => {})
  if (win && !win.isDestroyed()) { win.webContents.stop(); await win.webContents.session.closeAllConnections(); win.destroy() }
  server?.closeAllConnections(); server?.close()
  const result = { ok: !error, checks, errors, ...(error ? { error: String(error) } : {}), boundary: 'Production admin build and real API client against an isolated HTTP fixture; no live user, backend or model contacted' }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ...result, output }))
  if (process.send) process.send({ type: 'soduwork-quota-admin-complete', result })
  else app.exit(result.ok ? 0 : 1)
}

app.whenReady().then(async () => {
  server = http.createServer((req, res) => handle(req, res).catch(error => { errors.push(String(error)); respond(res, 500, { detail: String(error) }) }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const isolated = session.fromPartition('quota-admin-' + Date.now())
  isolated.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('data:') }))
  win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { session: isolated, backgroundThrottling: false } })
  win.webContents.on('console-message', event => { if (/Uncaught|React error/.test(event.message)) errors.push(event.message) })
  await win.loadURL(origin)
  await waitFor('document.querySelectorAll(".qm-plan-card").length===3', 'three plans')
  assert.equal(await js('document.querySelector(".app").dataset.screen'), 'quotas')
  assert.equal(await js('document.querySelectorAll(".nav-item").length'), 1, 'quota-only permission exposes only the quota module')
  await point('document.querySelector(".nav-item[aria-current=page]")')
  assert.equal(await js('document.querySelectorAll(".qm-plan-card").length'), 3)
  assert.ok(await js('document.querySelector(".qm-trial").textContent.includes("100,000")'))
  await shot('plans-zh')
  checks.push('Dedicated permission-gated module renders trial, Standard and Pro from one catalog request')

  await point('document.querySelector(' + JSON.stringify('button[aria-label="编辑套餐：Trial"]') + ')')
  await waitFor('!!document.querySelector(".qm-editor")', 'trial editor')
  await input(findField('试用有效天数'), '10')
  await input('document.querySelector(".qm-total-fields input")', '120000')
  await click('添加模型额度'); await select('[aria-label="模型 1"]', 'Model A · Primary')
  await input('document.querySelector(".qm-model-row input[type=number]")', '70000')
  await click('添加模型额度'); await select('[aria-label="模型 2"]', 'Model B · Secondary')
  await input('document.querySelectorAll(".qm-model-row input[type=number]")[1]', '50000')
  await point('document.querySelector(".qm-checkbox input")')
  await shot('model-allowances')
  await click('保存套餐'); await waitFor('!document.querySelector(".qm-editor")', 'trial saved')
  assert.equal(catalog.plans[0].durationDays, 10); assert.equal(catalog.plans[0].totalLimit, 120000)
  assert.equal(catalog.plans[0].models.length, 2); assert.equal(catalog.plans[0].restrictModels, true)
  checks.push('Trial duration, total cap, two model limits and allowed-model-only mode persist through real controls')

  await click('新建套餐'); await input(findField('套餐名称'), 'Research')
  await click('保存套餐'); await waitFor('!document.querySelector(".qm-editor")', 'custom plan saved')
  assert.equal(catalog.plans.at(-1).period, 'monthly'); assert.match(catalog.plans.at(-1).id, /^plan_/)
  checks.push('A new monthly tier saves while preserving all required and assigned plan IDs')

  await point('document.querySelector(' + JSON.stringify('button[aria-label="编辑套餐：Standard"]') + ')')
  await input(findField('套餐名称'), 'Preserved draft')
  catalog = { ...catalog, revision: catalog.revision + 1, plans: catalog.plans.map(plan => plan.id === 'pro' ? { ...plan, name: 'Colleague change' } : plan) }
  await click('保存套餐'); await waitFor('document.body.textContent.includes("保留草稿，载入最新版本")', 'conflict feedback')
  assert.equal(await js(`[...document.querySelectorAll('.qm-editor .modal-foot button')].at(-1).disabled`), true)
  await click('保留草稿，载入最新版本'); await waitFor('document.body.textContent.includes("覆盖此项并保存")', 'review latest')
  assert.equal(await js('(' + findField('套餐名称') + ').value'), 'Preserved draft')
  await shot('conflict-review')
  await click('覆盖此项并保存'); await waitFor('!document.querySelector(".qm-editor")', 'rebased save')
  assert.equal(catalog.plans.find(plan => plan.id === 'pro').name, 'Colleague change')
  checks.push('Concurrent catalog changes preserve the draft, require explicit review and retain other administrators’ plan edits')

  await click('成员额度'); await waitFor('!!document.querySelector(".qm-usage")', 'member list')
  assert.ok(await js('document.querySelector(".qm-usage").textContent.includes("13,160,809")'))
  assert.equal(await js('document.querySelector(".qm-meter").getAttribute("aria-valuenow")'), '100')
  await point('document.querySelector("button[aria-label=下一页]")'); await waitFor('document.querySelector(".qm-table").textContent.includes("Last member")', 'next page')
  await point('document.querySelector("button[aria-label=上一页]")'); await waitFor('document.querySelector(".qm-table").textContent.includes("Alice")', 'previous page')
  await click('分配额度'); await select('[aria-label="额度规则"]', '使用套餐')
  await point('document.querySelector("[aria-label=选择套餐]")')
  assert.equal(await js(`[...document.querySelectorAll('[role=option]')].some(e=>e.textContent==='Trial')`), false)
  await point(`[...document.querySelectorAll('[role=option]')].find(e=>e.textContent==='Preserved draft')`)
  await select('[aria-label="额度规则"]', '个人自定义')
  await input('document.querySelector(".qm-total-fields input")', '0')
  await click('保存分配'); await waitFor('!document.querySelector(".qm-editor")', 'member saved')
  assert.equal(member.assignment.custom.totalLimit, 0); assert.equal(member.quota.used, 13160809)
  await shot('member-allowances')
  checks.push('Member pagination, exact overage totals, no trial for an old account and an explicit personal zero pause')

  await click('原有账号默认规则'); await click('调整默认额度')
  await select('[aria-label="总额度规则"]', '不限额')
  await click('保存'); await waitFor('!document.querySelector(".qm-editor")', 'legacy default saved')
  assert.equal(catalog.defaultLimit, null)
  checks.push('Existing-account default supports unlimited without changing assigned plans or personal usage')

  for (const [locale, label] of [['en-US', 'Plans'], ['ja-JP', 'プラン設定'], ['ko-KR', '요금제 설정']]) {
    await win.loadURL(origin + '/?locale=' + locale)
    await waitFor('document.querySelectorAll(".qm-plan-card").length===4', locale + ' plans')
    assert.ok(await js('document.querySelector(".qm-tabs").textContent.includes(' + JSON.stringify(label) + ')'))
    await shot('plans-' + locale)
  }
  win.setSize(720, 850); await sleep(100)
  assert.ok(await js('document.querySelector(".quota-management").getBoundingClientRect().right <= innerWidth + 1'))
  await shot('plans-narrow')
  checks.push('English, Japanese and Korean copy plus narrow-layout bounds verified in Chromium')
  const quotaRequestsBeforeDenial = requests.filter(row => row.path.startsWith('/api/v1/admin/quotas')).length
  user.permissions = []
  await win.loadURL(origin + '/?locale=en-US')
  await waitFor('!!document.querySelector(".app .landing")', 'account without management permissions')
  assert.equal(await js('document.querySelectorAll(".quota-management, .nav-item").length'), 0, 'no quota access without its permission')
  assert.equal(requests.filter(row => row.path.startsWith('/api/v1/admin/quotas')).length, quotaRequestsBeforeDenial, 'denied account never requests quota data')
  user.permissions = ['quota.manage']
  await win.loadURL(origin + '/?locale=en-US')
  await waitFor('document.querySelectorAll(".qm-plan-card").length===4', 'quota permission restored')
  checks.push('Quota-only permission exposes the module; removing permission hides it and prevents quota requests; restoring permission restores access')
  assert.deepEqual(errors, [])
  assert.equal(requests.filter(row => /\/admin\/(users|model-catalog|orgs)/.test(row.path)).length, 0)
  await finish()
}).catch(error => { console.error(error); finish(error) })
