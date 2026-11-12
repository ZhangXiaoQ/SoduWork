// Run after npm run build: node tests/font-scale-browser.cjs [--dist PATH].
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
    env, windowsHide: true, encoding: 'utf8', timeout: 200000,
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
  let hub, win, peer, origin, hubLog = '', timer
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
      source: `localStorage.setItem('soduwork-locale','en-US');Object.defineProperty(navigator,'languages',{get:()=>['en-US']});Object.defineProperty(navigator,'language',{get:()=>'en-US'});`,
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

    const scaleValue = () => js('Number(document.documentElement.dataset.scale || 0)')
    async function menu() {
      if (!await js('!!document.querySelector(".profile-menu")')) await click('.side-foot')
      await wait('!!document.querySelector(".scale-level")', 'font size menu')
    }
    async function scale(value) {
      await menu()
      for (let attempts = 0; await scaleValue() !== value && attempts < 6; attempts++) {
        const direction = await scaleValue() < value ? 'first-of-type' : 'nth-of-type(2)'
        await click('.scale-steps button:' + direction)
      }
      await wait(`Number(document.querySelector(".scale-level")?.textContent)===${value} && Number(document.documentElement.dataset.scale||0)===${value}`, 'menu and document scale ' + value)
    }
    await check('all five native font controls clamp both bounds and retain readable status', async () => {
      await scale(-2)
      assert.equal(await js('document.querySelector(".scale-steps button:nth-of-type(2)").disabled'), true)
      await click('.scale-steps button:nth-of-type(2)')
      assert.equal(await scaleValue(), -2)
      for (const value of [-1, 0, 1, 2]) await scale(value)
      assert.equal(await js('document.querySelector(".scale-steps button:first-of-type").disabled'), true)
      await click('.scale-steps button:first-of-type')
      assert.equal(await scaleValue(), 2)
      assert.equal(await js('document.querySelector(".scale-level").getAttribute("aria-live")'), 'polite')
      assert.equal(await js('localStorage.getItem("soduwork-hub-scale")'), '2')
    })
    await check('font size survives an authenticated full reload', async () => {
      await win.reload()
      await wait('!!document.querySelector(".app") && !!document.querySelector(".side-foot")', 'authenticated reload')
      await menu()
      assert.equal(await scaleValue(), 2)
      assert.equal(await js('document.querySelector(".scale-level").textContent'), '+2')
    })
    await check('real second-tab storage updates menu state, bounds and rendered font together', async () => {
      peer = new BrowserWindow({ show: false, width: 1280, height: 900,
        webPreferences: { session: isolated, offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
      await peer.loadURL(origin)
      for(let i=0;i<200 && !await peer.webContents.executeJavaScript('!!document.querySelector(".app")');i++) await sleep(50)
      assert.ok(await peer.webContents.executeJavaScript('!!document.querySelector(".app")'), 'second tab must finish authenticated startup')
      await peer.webContents.executeJavaScript('localStorage.setItem("soduwork-hub-scale","-2")')
      await wait('document.querySelector(".scale-level").textContent==="-2"', 'cross-tab subscriber')
      assert.equal(await scaleValue(), -2)
      assert.equal(await js('document.querySelector(".scale-steps button:nth-of-type(2)").disabled'), true)
      await peer.webContents.executeJavaScript('localStorage.removeItem("soduwork-hub-scale")')
      await wait('document.querySelector(".scale-level").textContent==="0"', 'cross-tab key removal')
      await scale(1)
      // storage.clear is a real event with key=null, while preserving synthetic login
      // in the writer afterward so the remaining tests stay authenticated.
      await peer.webContents.executeJavaScript(`(()=>{const saved=Object.entries(localStorage).filter(([key])=>key!=='soduwork-hub-scale');localStorage.clear();for(const [key,value] of saved)localStorage.setItem(key,value)})()`)
      await wait('document.querySelector(".scale-level").textContent==="0"', 'cross-tab clear')
      assert.equal(await scaleValue(), 0)
      peer.destroy(); peer = null
    })
    await check('legacy enlarged preference migrates to step one on startup', async () => {
      await js('localStorage.setItem("soduwork-hub-scale","enlarge")')
      await win.reload()
      await wait('!!document.querySelector(".side-foot")', 'legacy preference reload')
      await menu()
      assert.equal(await scaleValue(), 1)
      assert.equal(await js('document.querySelector(".scale-level").textContent'), '+1')
    })
    await navigate('models')
    await wait('!!document.querySelector(".model-provider-grid")', 'real model catalog')

    await check('create a synthetic model service through production form and Hub', async () => {
      if (await js('!!document.querySelector(".profile-menu")')) await click('.side-foot')
      await click('.content .btn-primary')
      await wait('!!document.querySelector(".modal-body input")', 'provider form')
      for (const [index,value] of [[1,'font-scale-fixture'],[2,'Font layout fixture'],[3,'http://127.0.0.1:9/v1']]) {
        await click(`.modal-body > div:nth-child(${index === 3 ? 4 : index}) > input`)
        await win.webContents.insertText(value)
      }
      await click('.modal-foot .btn-primary')
      await wait('!!document.querySelector(".model-provider") && !document.querySelector(".modal-body")', 'provider persisted')
    })
    const geometry = []

    for (const width of [1440, 820, 390]) {
      win.setContentSize(width, 960)
      await sleep(120)
      for (const step of [-2, -1, 0, 1, 2]) await check(`font layout at ${width}px and step ${step}`, async () => {
        await scale(step)
        const measure = await js(`(() => {
          const menu=document.querySelector('.profile-menu'), row=document.querySelector('.scale-steps');
          const r=menu.getBoundingClientRect(), s=row.getBoundingClientRect();
          return { width:innerWidth, bodyWidth:document.documentElement.scrollWidth,
            menu:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},
            controls:{left:s.left,right:s.right},
            font:getComputedStyle(document.querySelector('.nav-copy')).fontSize,
            heading:getComputedStyle(document.querySelector('.page-title h1')).fontSize,
            buttons:[...row.querySelectorAll('button')].map(el=>{const b=el.getBoundingClientRect();return {width:b.width,height:b.height,font:getComputedStyle(el).fontSize}}),
            theme:document.documentElement.dataset.theme||null };
        })()`)
        geometry.push({requestedWidth:width,step,...measure})
        assert.ok(measure.menu.left >= -1 && measure.menu.right <= measure.width + 1, 'settings menu must remain horizontally inside viewport')
        assert.ok(measure.menu.top >= -1 && measure.menu.bottom <= 961, 'settings menu must remain vertically reachable')
        assert.ok(measure.controls.left >= measure.menu.left && measure.controls.right <= measure.menu.right, 'font buttons must fit settings menu')
        assert.ok(measure.buttons.every(button=>button.width>=26 && button.height>=26), 'font controls must keep a usable target size')
        assert.ok(measure.bodyWidth <= measure.width + 1, 'scale must not introduce document horizontal overflow')
        if (step === 2 || step === 0) fs.writeFileSync(path.join(output, `font-${width}-${step}.png`), (await win.webContents.capturePage()).toPNG())
        await click('.side-foot')
      })
    }
    fs.writeFileSync(path.join(output,'geometry.json'),JSON.stringify(geometry,null,2))
    for(const width of [1440,820,390]) {
      const rows=geometry.filter(row=>row.requestedWidth===width)
      assert.equal(rows.length,5)
      assert.ok(parseFloat(rows.at(-1).font)>parseFloat(rows[2].font), 'enlarged navigation must actually grow')
      assert.ok(parseFloat(rows[0].heading)<parseFloat(rows[2].heading), 'smaller display type must actually shrink')
    }
    win.setContentSize(1280, 960); await sleep(100); await scale(2); await click('.side-foot')
    await check('model editor native radio controls retain intrinsic sizing at largest font', async () => {
      assert.ok(await js('!!document.querySelector(".model-provider .admin-card-action.is-primary")'), 'real catalog must contain a provider')
      await click('.model-provider .admin-card-action.is-primary')
      await wait('!!document.querySelector(".model-config-form")', 'model editor')
      await click('.model-config-advanced summary')
      await wait('document.querySelector(".model-config-form input[type=radio]").getBoundingClientRect().height>0', 'visible advanced radio controls')
      const sizes = await js(`[...document.querySelectorAll('.model-config-form input[type=radio]')].map(el=>({height:el.getBoundingClientRect().height,minHeight:getComputedStyle(el).minHeight}))`)
      assert.ok(sizes.length>0)
      assert.ok(sizes.every(size=>size.height>0 && size.height<30), 'radio controls must not inherit large text-input minimum height')
      await click('.model-config-form input[type=radio][value="controllable"]')
      assert.equal(await js('document.querySelector(".model-config-form input[type=radio][value=controllable]").checked'),true)
      const checkbox=await js('document.querySelector(".model-config-form input[type=checkbox]").getBoundingClientRect().height')
      assert.ok(checkbox>0 && checkbox<30, 'checkbox must retain intrinsic size too')
      const wasChecked=await js('document.querySelector(".model-config-form input[type=checkbox]").checked')
      await click('.model-config-form input[type=checkbox]')
      assert.equal(await js('document.querySelector(".model-config-form input[type=checkbox]").checked'),!wasChecked)
      fs.writeFileSync(path.join(output,'model-editor-largest.png'),(await win.webContents.capturePage()).toPNG())
      await key('Escape','Escape',27)
      await wait('!document.querySelector(".model-config-form")', 'model editor dismisses')
    })
    await check('color theme is preserved while font changes and returns to standard', async () => {
      await menu()
      const before=await js('document.documentElement.dataset.theme||null')
      await scale(-2); await scale(0)
      assert.equal(await js('document.documentElement.dataset.theme||null'),before)
      assert.equal(await js('localStorage.getItem("soduwork-hub-scale")'),null)
    })
    await check('storage denied on startup still permits successive native font adjustments', async () => {
      await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `
        for(const name of ['getItem','setItem','removeItem']) {
          const original=Storage.prototype[name];
          Storage.prototype[name]=function(key,...args) {
            if(key==='soduwork-hub-scale') throw new DOMException('Fixture storage unavailable','SecurityError');
            return original.call(this,key,...args);
          };
        }
      ` })
      await win.reload()
      await wait('!!document.querySelector(".side-foot")', 'storage denied reload')
      for (const value of [1,2,1,0,-1,-2]) await scale(value)
      assert.equal(await scaleValue(),-2)
    })
    assert.deepEqual(errors, [])
    assert.ok(calls.some(call=>call.path==='/api/v1/admin/login' && call.status===200))
  }
  async function stop() {
    let windowError
    try { if (peer && !peer.isDestroyed()) peer.destroy(); if (win && !win.isDestroyed()) win.destroy() }
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
      await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Browser test deadline exceeded')), 160000) })])
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
