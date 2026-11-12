// Run after npm run build: node tests/service-health-browser.cjs [--dist PATH].
// Optional SODUWORK_TEST_PYTHON and SODUWORK_TEST_ELECTRON select installed tools.
// Actual React/Chromium -> production Hub routes -> fresh synthetic SQLite.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
if (!process.versions.electron) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
  const electron = env.SODUWORK_TEST_ELECTRON || require('../../client/node_modules/electron')
  const result = spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, encoding: 'utf8', timeout: 150000,
  })
  console.log(result.stdout || '')
  const completed = /"output":"[^"]+","passed":\d+,"failed":\d+/.test(result.stdout || '')
  if (result.error || !completed) console.error(result.error || 'Electron exited without a completion report')
  if (result.status !== 0 && result.stderr) console.error(result.stderr)
  process.exitCode = result.status === 0 && completed && !result.error ? 0 : 1
} else {
  const { app, BrowserWindow, session } = require('electron')
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-service-health-'))
  const distArg = process.argv.indexOf('--dist')
  const dist = path.resolve(distArg < 0 ? path.join(__dirname, '../dist') : process.argv[distArg + 1])
  app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration()
  app.on('window-all-closed', () => {}) // Finish owned Hub cleanup before explicitly exiting.
  const checks = [], errors = [], calls = [], failedRequests = [], canceledRequests = []
  let hub, win, origin, hubLog = '', timer
  const progress = label => fs.appendFileSync(path.join(output, 'progress.log'), label + '\n')
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const exited = child => child.exitCode !== null || child.signalCode !== null
  const js = code => win.webContents.executeJavaScript(code, true)
  async function wait(code, label, timeout = 10000) {
    const start = Date.now()
    while (Date.now() - start < timeout) { if (await js(code)) return; await sleep(50) }
    throw Error('Timed out: ' + label)
  }
  async function click(selector) {
    const point = await js(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw Error('Missing click target');
      el.scrollIntoView({block:'center',inline:'nearest'});
      const r=el.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
      if (!el.contains(document.elementFromPoint(x,y))) throw Error('Click target obscured');
      return {x,y};
    })()`)
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type, ...point, button: 'left', clickCount: 1,
    })
    await sleep(70)
  }
  async function key(keyName, code, keyCode) {
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type, key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
      ...(keyName === 'Enter' && type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}),
    })
    await sleep(70)
  }
  async function open() {
    if (await js('document.querySelector(".env").open')) await click('.env summary')
    await click('.env summary')
    await wait('document.querySelector(".env").open', 'health popover opens')
  }
  const closed = () => js('!document.querySelector(".env").open')
  async function check(name, run) {
    try { await run(); checks.push({ name, ok: true }) }
    catch (error) { checks.push({ name, ok: false, error: error.stack }) }
    console.log(JSON.stringify(checks.at(-1)))
  }
  async function navigate(screen) {
    await js(`window.dispatchEvent(new CustomEvent('soduwork-hub-nav',{detail:{screen:${JSON.stringify(screen)}}}))`)
    await wait(`document.querySelector('.app')?.dataset.screen===${JSON.stringify(screen)}`, screen)
  }
  async function run() {
    progress('starting isolated Hub')
    assert.ok(fs.existsSync(path.join(dist, 'index.html')), 'Run npm run build first')
    hub = spawn(process.env.SODUWORK_TEST_PYTHON || 'python', ['-B', '-X', 'utf8',
      path.join(__dirname, 'fixtures/service-health-hub.py'), '--root', output, '--dist', dist, '--watch-parent'],
    { windowsHide: true, cwd: output, env: { ...process.env, PYTHONUTF8: '1' } })
    hub.stdout.on('data', chunk => { hubLog += chunk }); hub.stderr.on('data', chunk => { hubLog += chunk })
    hub.on('error', error => { hubLog += String(error) })
    const ready = path.join(output, 'ready.json')
    for (let i = 0; i < 400 && !fs.existsSync(ready); i++) {
      if (exited(hub)) throw Error('Hub startup failed: ' + hubLog)
      await sleep(100)
    }
    assert.ok(fs.existsSync(ready), 'Hub startup timed out: ' + hubLog)
    const identity = JSON.parse(fs.readFileSync(ready))
    origin = identity.origin
    progress('Hub ready')
    const isolated = session.fromPartition('service-health-' + Date.now())
    isolated.webRequest.onBeforeRequest((details, done) => done({ cancel: details.url !== 'about:blank' && !details.url.startsWith(origin + '/') && !details.url.startsWith('data:') }))
    isolated.webRequest.onCompleted(details => { if (new URL(details.url).pathname.startsWith('/api/') || details.url.endsWith('/healthz')) calls.push({ path: new URL(details.url).pathname, status: details.statusCode }) })
    isolated.webRequest.onErrorOccurred(details => {
      const url = new URL(details.url)
      if (url.origin !== origin || (!url.pathname.startsWith('/api/') && url.pathname !== '/healthz')) return
      const request = { path: url.pathname, error: details.error }
      // Navigation legitimately aborts in-flight reads. Preserve these receipts,
      // while independently rejecting uncaught Hub exceptions even if the
      // browser canceled before it received an HTTP error response.
      if (details.error === 'net::ERR_ABORTED') canceledRequests.push(request)
      else failedRequests.push(request)
    })
    win = new BrowserWindow({ show: false, width: 1440, height: 1000,
      webPreferences: { session: isolated, offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', event => { if (/Uncaught|React error/.test(event.message)) errors.push(event.message) })
    await win.loadURL('about:blank')
    progress('browser ready')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Page.enable')
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem('soduwork-locale','zh-CN');Object.defineProperty(navigator,'languages',{get:()=>['zh-CN']});Object.defineProperty(navigator,'language',{get:()=>'zh-CN'});`,
    })
    await win.loadURL(origin)
    progress('landing loaded')
    await wait('!!document.querySelector(".public-nav-login")', 'landing')
    await click('.public-nav-login')
    progress('opening login')
    await wait('!!document.querySelector("[name=username]")', 'login form')
    await click('[name=username]'); await win.webContents.insertText(identity.username)
    await click('[name=password]'); await win.webContents.insertText(identity.password)
    await click('.login-card button[type=submit]')
    progress('login submitted')
    await wait('!!document.querySelector(".env.is-ok") && !!document.querySelector(".gov-metric")', 'real authenticated health and overview')
    progress('authenticated health and overview ready')
    const health = await js('fetch("/healthz").then(r=>r.json())')
    const versionLabel = /^v?\d+\.\d+/.test(health.version || '') ? String(health.version).replace(/^v?/, 'v') : '—'
    const diagnosticBuild = health.commit || health.version || '—'
    await check('real login, production health/version/build and native toggle', async () => {
      await open()
      assert.deepEqual(await js('[...document.querySelectorAll(".env-details dt")].map(el=>el.textContent)'), ['版本', '构建'])
      assert.deepEqual(await js('[...document.querySelectorAll(".env-details dd")].map(el=>el.textContent)'), [versionLabel, diagnosticBuild])
      await click('.env-details dd'); assert.equal(await closed(), false, 'inside clicks keep popover open')
      await click('.env summary'); assert.equal(await closed(), true, 'summary toggles closed')
    })
    await check('sidebar navigation closes popover and loads real insights endpoint', async () => {
      await open(); await click('.nav-item[title^="运营分析"]')
      await wait('document.querySelector(".app")?.dataset.screen==="insights" && !!document.querySelector(".oi-panel")', 'insights')
      assert.equal(await closed(), true)
      assert.ok(calls.some(call => call.path === '/api/v1/admin/operations/insights' && call.status === 200))
    })
    await check('current sidebar menu keyboard activation closes popover', async () => {
      await open(); await js('document.querySelector(".nav-item.active").focus()')
      await js(`window.fixtureNavActivation=null;document.querySelector('.nav-item.active').addEventListener('click',event=>{window.fixtureNavActivation={trusted:event.isTrusted,detail:event.detail}},{once:true})`)
      await key('Enter', 'Enter', 13)
      assert.deepEqual(await js('window.fixtureNavActivation'), { trusted: true, detail: 0 }, 'native Enter must activate the selected menu without a pointer')
      assert.equal(await closed(), true, 'same-menu keyboard navigation must close health')
      assert.equal(await js('document.activeElement.matches(".nav-item.active")'), true, 'menu keyboard focus must remain on the selected menu')
    })
    await check('programmatic route change closes popover without a pointer event', async () => {
      await open(); await navigate('overview'); assert.equal(await closed(), true)
    })
    await check('same-screen navigation event also closes popover', async () => {
      await open(); await navigate('overview'); assert.equal(await closed(), true)
    })
    for (const source of ['sidebar', 'navigation event']) await check(`${source} preserves a canceled leave guard and resumes only once`, async () => {
      await navigate('overview'); await open()
      await js(`window.fixtureLeaveCount=0;window.fixtureLeaveProceed=null;
        window.fixtureLeaveGuard=event=>{event.preventDefault();window.fixtureLeaveCount++;window.fixtureLeaveProceed=event.detail.proceed};
        window.addEventListener('soduwork-before-admin-leave',window.fixtureLeaveGuard)`)
      try {
        if (source === 'sidebar') await click('.nav-item[title^="运营分析"]')
        else await js(`window.dispatchEvent(new CustomEvent('soduwork-hub-nav',{detail:{screen:'insights'}}))`)
        assert.equal(await closed(), true, 'navigation intent dismisses health even when the page vetoes leaving')
        assert.equal(await js('document.querySelector(".app").dataset.screen'), 'overview', 'canceling the leave event preserves the current page')
        assert.equal(await js('window.fixtureLeaveCount'), 1)
        assert.equal(await js('typeof window.fixtureLeaveProceed'), 'function')
      } finally {
        await js(`window.removeEventListener('soduwork-before-admin-leave',window.fixtureLeaveGuard)`)
      }
      await js('window.fixtureLeaveProceed()')
      await wait('document.querySelector(".app").dataset.screen==="insights"', 'deferred navigation after confirmation')
      await navigate('overview')
      await js('window.fixtureLeaveProceed()')
      assert.equal(await js('document.querySelector(".app").dataset.screen'), 'overview', 'an already-consumed confirmation cannot replay navigation')
    })
    await check('outside click closes popover and preserves target action', async () => {
      await open(); await click('.side-foot')
      assert.equal(await closed(), true)
      assert.equal(await js('!!document.querySelector(".profile-menu")'), true)
      await click('.side-foot')
    })
    await check('Escape inside closes and retains summary focus', async () => {
      await open(); await key('Escape', 'Escape', 27)
      assert.equal(await closed(), true)
      assert.equal(await js('document.activeElement.matches(".env summary")'), true)
    })
    await check('Escape outside closes without stealing external keyboard focus', async () => {
      await open(); await key('Tab', 'Tab', 9)
      assert.equal(await js('document.querySelector(".env").contains(document.activeElement)'), false)
      await js('window.fixtureOutsideFocus = document.activeElement')
      await key('Escape', 'Escape', 27); assert.equal(await closed(), true)
      assert.equal(await js('document.activeElement === window.fixtureOutsideFocus'), true)
    })
    await check('an already-handled Escape does not dismiss the popover', async () => {
      await open()
      await js('document.addEventListener("keydown",e=>{if(e.key==="Escape")e.preventDefault()},{capture:true,once:true})')
      await key('Escape', 'Escape', 27); assert.equal(await closed(), false)
    })
    await check('health refresh keeps an open popover and its diagnostic content', async () => {
      await open(); const before = calls.filter(call => call.path === '/healthz').length
      await js('document.dispatchEvent(new Event("visibilitychange"))')
      for (let i = 0; i < 100 && calls.filter(call => call.path === '/healthz').length === before; i++) await sleep(50)
      assert.ok(calls.filter(call => call.path === '/healthz').length > before)
      assert.equal(await closed(), false)
      assert.deepEqual(await js('[...document.querySelectorAll(".env-details dd")].map(el=>el.textContent)'), [versionLabel, diagnosticBuild])
    })
    await check('narrow viewport sidebar navigation dismisses the popover', async () => {
      win.setSize(820, 900); await sleep(150); await open()
      await click('.nav-item[title^="运营分析"]')
      await wait('document.querySelector(".app")?.dataset.screen==="insights"', 'narrow insights')
      assert.equal(await closed(), true)
    })
    win.setSize(1440, 1000); await sleep(150)
    fs.writeFileSync(path.join(output, 'after-navigation.png'), (await win.webContents.capturePage()).toPNG())
    assert.deepEqual(errors, [])
    assert.ok(calls.some(call => call.path === '/api/v1/admin/login' && call.status === 200))
    assert.equal(calls.some(call => call.status >= 400), false, 'page APIs must complete successfully')
  }
  async function stop() {
    let windowError
    try { if (win && !win.isDestroyed()) win.destroy() }
    catch (error) { windowError = error }
    if (hub && !exited(hub)) {
      fs.writeFileSync(path.join(output, 'shutdown'), '')
      for (let i = 0; i < 100 && !exited(hub); i++) await sleep(50)
      if (!exited(hub)) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(hub.pid), '/T', '/F'], { windowsHide: true, timeout: 15000, stdio: 'ignore' })
        else hub.kill('SIGKILL')
        for (let i = 0; i < 40 && !exited(hub); i++) await sleep(50)
      }
      assert.ok(exited(hub), 'disposable Hub must exit')
    }
    if (hub) assert.equal(hub.exitCode, 0, 'disposable Hub must shut down cleanly')
    if (origin) {
      const reachable = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(1000) }).then(() => true, () => false)
      assert.equal(reachable, false, 'disposable Hub port must close')
    }
    if (windowError) throw windowError
  }
  app.whenReady().then(async () => {
    try {
      await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Browser test deadline exceeded')), 110000) })])
    } catch (error) { checks.push({ name: 'fixture and page API prerequisites', ok: false, error: error.stack }); console.error(error) }
    finally {
      clearTimeout(timer)
      try { await stop(); checks.push({ name: 'isolated Hub process and port shut down', ok: true }) }
      catch (error) { checks.push({ name: 'isolated Hub cleanup', ok: false, error: error.message }) }
      const hubErrors = hubLog.split(/\r?\n/).filter(line => /^(?:ERROR:|Traceback \(most recent call last\):|Fatal Python error:)/.test(line))
      checks.push({ name: 'production Hub and application requests have no unhandled errors',
        ok: hubErrors.length === 0 && failedRequests.length === 0,
        ...(hubErrors.length ? { errors: hubErrors } : {}),
        ...(failedRequests.length ? { requests: failedRequests } : {}),
      })
      const ok = checks.every(check => check.ok)
      fs.writeFileSync(path.join(output, 'hub.log'), hubLog)
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok, platform: process.platform, dist, checks, calls, errors, failedRequests, canceledRequests,
        boundary: 'Built React, native Chromium pointer/keyboard, production Hub HTTP routes and fresh SQLite; no migrations, background jobs or external services.' }, null, 2))
      console.log(JSON.stringify({ ok, output, passed: checks.filter(check => check.ok).length, failed: checks.filter(check => !check.ok).length }))
      app.exit(ok ? 0 : 1)
    }
  })
}
