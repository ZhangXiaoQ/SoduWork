'use strict'
// Production React build in a real, isolated Chromium renderer. All network
// endpoints below are local fixtures; no installed client or account is used.
const electron = process.versions.electron ? require('electron') : require('../../client/node_modules/electron')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..'), out = path.resolve(root, '../outputs/public-pages-20261013')
fs.mkdirSync(out, { recursive: true })
if (typeof electron === 'string') {
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'NODE_USE_SYSTEM_CA', 'CHROME_DEVEL_SANDBOX']) delete env[key]
  const child = require('node:child_process').spawnSync(electron, [__filename], { env, windowsHide: true, encoding: 'utf8', timeout: 150000, maxBuffer: 2e6 })
  console.log(child.stdout || '')
  if (child.status !== 0) console.error(child.stderr || child.error)
  process.exitCode = child.status || (child.error ? 1 : 0)
} else {
  const { app, BrowserWindow, session } = electron
  app.setPath('userData', fs.mkdtempSync(path.join(out, 'browser-profile-')))
  app.disableHardwareAcceleration()
  let win, server, mode = 'available', loginStatus = 401, loginCalls = 0
  const results = [], errors = [], requests = [], blocked = []
  const user = { id: 'local-public-test', username: 'test-admin', displayName: 'Local fixture', isSuper: false, permissions: [] }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const js = code => win.webContents.executeJavaScript(code)
  async function until(code, message) {
    for (let i = 0; i < 100; i++) { if (await js(code)) return; await sleep(50) }
    throw Error('Timed out: ' + message)
  }
  async function capture(name) {
    await js('for(const animation of document.getAnimations()) if(animation.effect.getComputedTiming().iterations!==Infinity) animation.finish()')
    await sleep(100)
    fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  async function geometry(label, width, height) {
    win.setSize(width, height); await sleep(120)
    const data = await js(`(() => {
      const targets=[...document.querySelectorAll('.public-nav-login,.public-hero-actions .w-cta,.product-tabs,.product-tabs button,.login-card,.public-download-platform')];
      const outside=targets.filter(el=>{const r=el.getBoundingClientRect();return r.width && (r.left < -1 || r.right>innerWidth+1)}).map(el=>el.className);
      const clippedTabs=[...document.querySelectorAll('.product-tabs button')].filter(el=>{const r=el.getBoundingClientRect(),p=el.parentElement.getBoundingClientRect();return r.left<p.left-1||r.right>p.right+1||el.scrollWidth>el.clientWidth+1}).map(el=>el.textContent);
      return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,outside,clippedTabs};
    })()`)
    assert.ok(data.scrollWidth <= data.width + 1, label + ' horizontal page overflow: ' + JSON.stringify(data))
    assert.deepEqual(data.outside, [], label + ' controls fit')
    assert.deepEqual(data.clippedTabs, [], label + ' every scenario tab stays readable')
    results.push({ name: label, ...data })
    await capture(label)
  }
  async function input(selector, value) {
    await js(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  }
  function report(extra = {}) {
    fs.writeFileSync(path.join(out, 'browser-report.json'), JSON.stringify({ scope: 'Local source build and synthetic API only', results, errors, requests, blocked, loginCalls, ...extra }, null, 2))
  }
  app.whenReady().then(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const json = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
      if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
        requests.push({ method: req.method, path: url.pathname })
        if (url.pathname === '/healthz') return json({ ok: true, commit: 'local-fixture', version: 'test' })
        if (url.pathname === '/api/v1/auth/providers') return json({ items: [{ key: 'test-sso', name: 'Test organization', startUrl: '/local-sso' }] })
        if (url.pathname === '/api/v1/admin/login') {
          loginCalls++; req.resume()
          return setTimeout(() => json(loginStatus === 200 ? { token: 'local-synthetic-token', user } : { detail: 'Invalid credentials' }, loginStatus), 100)
        }
        if (url.pathname === '/api/v1/admin/me') return json(user)
        if (/\/download\/(?:client(?:\/mac|\/linux)?|mobile)\/info$/.test(url.pathname)) {
          if (mode === 'error') return json({ detail: 'Local test unavailable' }, 503)
          if (mode === 'none' || (mode === 'windows-only' && /\/(mac|linux|mobile)\//.test(url.pathname))) return json({ available: false })
          const meta = { available: true, version: '1.12.73', sizeText: '128 MB', filename: 'local-fixture', updatedAt: '2026-10-13T00:00:00Z' }
          if (url.pathname.includes('/mac/')) return json({ available: true, arches: { arm64: meta, x64: meta } })
          if (url.pathname.includes('/linux/')) return json({ available: true, formats: { deb: meta, rpm: meta, 'tar.gz': meta } })
          return json(meta)
        }
        return json([])
      }
      if (url.pathname === '/local-sso') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>Local SSO fixture</h1>'); return }
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
      const base = path.join(root, 'dist'), file = path.resolve(base, relative)
      if (!file.startsWith(base + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
      let body = fs.readFileSync(file)
      if (relative === 'index.html') {
        const locale = url.searchParams.get('locale') === 'en-US' ? 'en-US' : 'zh-CN'
        const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'
        body = Buffer.from(body.toString().replace('<head>', `<head><script>localStorage.clear();localStorage.setItem('soduwork.locale',${JSON.stringify(locale)});localStorage.setItem('soduwork-hub-theme',${JSON.stringify(theme)})</script>`))
      }
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); res.end(body)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = 'http://127.0.0.1:' + server.address().port
    const isolated = session.fromPartition('public-pages-' + Date.now())
    isolated.webRequest.onBeforeRequest((detail, done) => { const cancel = !detail.url.startsWith(origin + '/') && !detail.url.startsWith('data:'); if (cancel) blocked.push(detail.url); done({ cancel }) })
    win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { session: isolated, offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } })
    win.webContents.on('console-message', event => { if (/Uncaught|React error|Each child in a list/.test(event.message)) errors.push(event.message) })
    win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    await win.loadURL(origin)
    await until('document.querySelectorAll(".public-platform-packages a").length===7', 'seven platform downloads')
    assert.equal(await js('document.querySelector(".public-hero-actions a").getAttribute("href")'), '/api/v1/download/client')
    for (const [width, height] of [[1440, 1000], [1024, 900], [768, 1024], [390, 844], [320, 740]]) await geometry('landing-zh-' + width, width, height)
    for (const width of [1440, 390]) {
      win.setSize(width, 1000); await sleep(120)
      for (const section of ['platform', 'loop', 'enterprise', 'downloads']) {
        await js(`document.getElementById('${section}').scrollIntoView({block:'start',behavior:'instant'})`)
        await capture('landing-zh-' + width + '-' + section)
      }
    }
    await js('window.scrollTo({top:0,behavior:"instant"})')
    await js('document.querySelectorAll("[role=tab]")[1].click()')
    await until('document.querySelector("[role=tabpanel]").textContent.includes("改版目标")', 'scenario selection')
    await js('document.querySelectorAll("[role=tab]")[1].dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))')
    assert.equal(await js('document.activeElement.id'), 'preview-tab-routine')
    assert.equal(await js('[...document.querySelectorAll("[role=tab]")].filter(el => el.tabIndex === 0).length'), 1)
    results.push({ name: 'scenario click and keyboard navigation', ok: true })
    await js('document.querySelector(".public-nav-login").click()')
    await until('!!document.querySelector(".login-card")', 'login screen')
    await until('!!document.querySelector(".login-sso-button")', 'SSO option')
    for (const [width, height] of [[1440, 1000], [1024, 900], [768, 1024], [390, 844], [320, 740]]) await geometry('login-zh-' + width, width, height)
    await input('[name=username]', ' test-admin '); await input('[name=password]', 'synthetic-test-password')
    await js('document.querySelector(".login-password-toggle").click()')
    assert.equal(await js('document.querySelector("[name=password]").type'), 'text')
    await js('document.querySelector(".login-password-toggle").click()')
    assert.equal(await js('document.querySelector("[name=password]").type'), 'password')
    await js('document.querySelector(".login-card").requestSubmit()')
    await until('!!document.querySelector(".login-error")', 'invalid login')
    assert.ok(await js('document.querySelector(".login-error").textContent.includes("账号或密码")'), 'credential rejection stays clear')
    assert.equal(await js('document.querySelector("[name=username]").value'), ' test-admin ')
    results.push({ name: 'password visibility and failed login preserve fields', ok: true })
    await capture('login-error-320')
    loginStatus = 503
    await js('document.querySelector(".login-card").requestSubmit()')
    await until('document.querySelector(".login-error")?.textContent.includes("Invalid credentials")', 'server error surfaced')
    loginStatus = 200
    await js('document.querySelector(".login-card").requestSubmit()')
    await until('!document.querySelector(".login-card")', 'successful local login')
    assert.equal(await js('localStorage.getItem("soduwork_hub_admin_token")'), 'local-synthetic-token')
    results.push({ name: 'successful local login calls existing application route', ok: true })
    await win.loadURL(origin + '/?locale=en-US')
    await until('document.querySelectorAll(".public-platform-packages a").length===7', 'English landing')
    for (const width of [1440, 390, 320]) await geometry('landing-en-' + width, width, 1000)
    await js('document.querySelector(".public-nav-login").click()')
    await until('!!document.querySelector(".login-sso-button")', 'English login')
    assert.ok(await js('document.querySelector(".login-sso-button").textContent.includes("Sign in with Test organization")'))
    for (const width of [1440, 390, 320]) await geometry('login-en-' + width, width, 1000)
    await js('document.querySelector(".login-sso-button").click()')
    await until('document.body.textContent.includes("Local SSO fixture")', 'SSO navigation')
    results.push({ name: 'SSO uses server-provided local start URL', ok: true })
    mode = 'none'; await win.loadURL(origin)
    await until('document.querySelector(".w-meta")?.textContent.includes("尚未发布")', 'unpublished downloads')
    assert.equal(await js('document.querySelector(".public-hero-actions button").disabled'), true)
    assert.equal(await js('document.querySelectorAll(".public-platform-packages a").length'), 0)
    mode = 'error'; await win.loadURL(origin)
    await until('!!document.querySelector(".w-meta .public-text-button")', 'retry state')
    mode = 'available'; await js('document.querySelector(".w-meta .public-text-button").click()')
    await until('document.querySelectorAll(".public-platform-packages a").length===7', 'download retry recovers')
    mode = 'windows-only'
    win.webContents.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
    await win.loadURL(origin)
    await until('document.querySelector(".w-meta")?.textContent.includes("尚未发布")', 'unpublished Mac state')
    assert.equal(await js('document.querySelector(".public-hero-actions button").disabled'), true, 'Mac must not receive a Windows installer')
    assert.equal(await js('document.querySelectorAll(".public-platform-packages a").length'), 1)
    mode = 'available'
    win.webContents.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 Mobile')
    await win.loadURL(origin)
    await until('document.querySelector(".public-hero-actions a")?.getAttribute("href") === "/api/v1/download/mobile/android"', 'Android APK selected')
    await geometry('landing-android-390', 390, 844)
    mode = 'none'; await win.loadURL(origin)
    await until('document.querySelector(".w-meta")?.textContent.includes("尚未发布")', 'Android unpublished')
    assert.equal(await js('document.querySelector(".public-hero-actions button").disabled'), true)
    mode = 'available'
    for (const ua of ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)']) {
      win.webContents.setUserAgent(ua); await win.loadURL(origin)
      await until('document.querySelector(".w-meta")?.textContent.includes("尚未发布")', 'iOS unpublished')
      assert.equal(await js('document.querySelector(".public-hero-actions button").disabled'), true)
    }
    win.webContents.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await win.loadURL(origin)
    await until('document.querySelector(".w-meta")?.textContent.includes("尚未发布")', 'iPad desktop UA must not select macOS')
    assert.equal(await js('document.querySelector(".public-hero-actions button").disabled'), true)
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
    win.webContents.debugger.detach()
    results.push({ name: 'unpublished platform, retry and OS-specific download safety', ok: true })
    mode = 'available'; await win.loadURL(origin + '/?theme=dark')
    await until('!!document.querySelector(".product-workspace")', 'dark landing')
    await geometry('landing-dark-1440', 1440, 1000)
    const hoverPoint = await js(`(() => {const el=document.querySelector('.w-cta-dark');el.scrollIntoView({block:'center',behavior:'instant'});const r=el.getBoundingClientRect();return {x:Math.floor(r.left+r.width/2),y:Math.floor(r.top+r.height/2)}})()`)
    win.webContents.sendInputEvent({ type: 'mouseMove', ...hoverPoint })
    await sleep(250)
    const contrast = await js(`(() => {
      const style=getComputedStyle(document.querySelector('.w-cta-dark'));
      const luminance=color=>color.match(/[0-9.]+/g).slice(0,3).map(x=>Number(x)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((sum,x,i)=>sum+x*[.2126,.7152,.0722][i],0);
      const a=luminance(style.color),b=luminance(style.backgroundColor);
      return {foreground:style.color,background:style.backgroundColor,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
    })()`)
    assert.ok(contrast.ratio >= 4.5, 'dark enterprise button hover has readable text: ' + JSON.stringify(contrast))
    results.push({ name: 'dark enterprise hover contrast', ...contrast })
    await js('document.querySelector(".public-nav-login").click()'); await until('!!document.querySelector(".login-card")', 'dark login')
    await geometry('login-dark-1440', 1440, 1000)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await win.loadURL(origin)
    await until('!!document.querySelector(".product-stage")', 'reduced motion landing')
    assert.equal(await js('getComputedStyle(document.querySelector(".product-stage")).animationName'), 'none')
    results.push({ name: 'reduced motion avoids entrance animation', ok: true })
    win.webContents.debugger.detach()
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    report({ ok: true }); console.log(JSON.stringify({ ok: true, cases: results.length, loginCalls, report: path.join(out, 'browser-report.json') }))
  }).catch(error => { report({ ok: false, failure: error.stack }); console.error(error.stack); process.exitCode = 1 })
    .finally(() => { win?.destroy(); server?.close(); app.exit(process.exitCode || 0) })
}
