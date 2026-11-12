// Real Chromium component interaction; isolated API fixture, no external mail.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const http = require('node:http')
const root = path.resolve(__dirname, '..')
const output = path.resolve(root, '../outputs/account-center-20261023/admin-mail-ui')
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key]
  const result = spawnSync(require('../../client/node_modules/electron'), [__filename],
    { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
  console.log(result.stdout || '')
  if (result.status !== 0) console.error(result.stderr || result.error)
  process.exitCode = result.status || (result.error ? 1 : 0)
} else {
  const { app, BrowserWindow, session } = require('electron')
  fs.mkdirSync(output, { recursive: true })
  app.setPath('userData', path.join(output, 'profile'))
  app.disableHardwareAcceleration()
  let server, win
  const errors = [], checks = []
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const js = async code => {
    try { return await win.webContents.executeJavaScript(code, true) }
    catch (error) { throw new Error(`${error.message}\nRenderer check: ${code}`, { cause: error }) }
  }
  const fixture = `let saved={enabled:false,host:'smtp.126.com',port:465,security:'ssl',username:'',senderAddress:'',senderName:'SoduWork',ready:false,passwordConfigured:false};
    let history=[]; window.mailCalls=[]; export const can=()=>true; export const api={
      mailSettings:async()=>saved,accountLegal:async()=>({operatorName:'',contactEmail:'',canEdit:!location.search.includes('readonly')}),mailDeliveries:async()=>({items:history}),accountPrivacyRequests:async()=>({items:[]}),
      saveMailSettings:async body=>{window.mailCalls.push({action:'save',body});saved={...body,password:'',ready:body.enabled,passwordConfigured:!!body.password||saved.passwordConfigured};return saved},
      testMailSettings:async recipient=>{window.mailCalls.push({action:'test',recipient});history=[{id:'test-1',purpose:'test',recipient:'r***@example.com',state:'sent',createdAt:new Date().toISOString()}];return {queued:true}},
      saveAccountLegal:async body=>{window.mailCalls.push({action:'legal',body});return body}
    }`
  async function wait(code, name) {
    for (let i = 0; i < 100; i++) { if (await js(code)) return; await sleep(50) }
    throw Error('Timed out: ' + name)
  }
  async function click(text) {
    await js(`(()=>{const button=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!button||button.disabled)throw Error('Unavailable button');button.click()})()`)
  }
  async function input(selector, value) {
    await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  }
  async function shot(name) {
    await sleep(150); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  app.whenReady().then(async () => {
    await require('esbuild').build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{setLocale}from'./src/i18n.js';import MailSettings from './src/screens/MailSettings.jsx';import './src/styles.css';import './src/design-system.css';import './src/console-theme.css';import './src/admin-controls.css';import './src/screens/client-access-policy.css';setLocale('zh-CN');createRoot(document.getElementById('root')).render(<MailSettings/>);`,
      loader: 'jsx', resolveDir: root }, bundle: true, outfile: path.join(output, 'fixture.js'), loader: { '.svg': 'dataurl' },
      plugins: [{ name: 'isolated-admin-api', setup(build) { build.onResolve({ filter: /(?:^|\/)api\.js$/ }, () => ({ path: 'fixture-api', namespace: 'fixture' })); build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: fixture, loader: 'js' })) } }] })
    const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>body{margin:0;background:var(--bg);padding:24px;display:block}#root{max-width:1150px;margin:auto}.mail-settings{margin:0}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'
    server = http.createServer((req, res) => {
      if (req.url.split('?')[0] === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(html); return }
      const name = req.url.slice(1)
      if (!['fixture.js', 'fixture.css'].includes(name)) { res.writeHead(404); res.end(); return }
      res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(path.join(output, name)))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = 'http://127.0.0.1:' + server.address().port
    const isolated = session.fromPartition('admin-mail-' + Date.now())
    isolated.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('data:') }))
    win = new BrowserWindow({ show: false, width: 1280, height: 1080, webPreferences: { session: isolated, offscreen: true, backgroundThrottling: false } })
    win.webContents.on('console-message', event => { if (/Uncaught|React error/.test(event.message)) errors.push(event.message) })
    await win.loadURL(origin)
    await wait('!!document.querySelector(".mail-fields")', 'loaded settings')
    assert.equal(await js('document.querySelector(".mail-test-button").disabled'), true)
    assert.equal(await js('document.querySelector(".mail-legal input").value'), '')
    checks.push('Unconfigured service disables test; operator identity starts empty')
    await js('document.querySelector(".select-menu-trigger").click()')
    await wait('!!document.querySelector("[role=option]")', 'security options')
    await js('[...document.querySelectorAll("[role=option]")].find(e=>e.textContent.trim()==="STARTTLS").click()')
    assert.equal(await js('document.querySelector(".select-menu-trigger").textContent.trim()'), 'STARTTLS')
    assert.equal(await js('getComputedStyle(document.querySelector(".select-menu-trigger")).display'), 'flex')
    checks.push('Styled security selector opens and changes transport')
    await input('.mail-fields input[type="email"]', 'sender@126.com')
    await input('input[type="password"]', 'fixture-authorization')
    await js('document.querySelector(".mail-enable input").click()')
    await click('填入 126 邮箱配置'); await click('保存配置')
    await wait('window.mailCalls.length === 1 && document.querySelector("input[type=password]").value === ""', 'saved settings')
    assert.equal((await js('window.mailCalls[0].body')).security, 'ssl')
    checks.push('126 preset saves SSL 465 and clears authorization from rendered input')
    await input('.mail-test-label input', 'receiver@example.com')
    await click('发送测试邮件')
    await wait('document.querySelector(".mail-history").textContent.includes("SMTP 已接收")', 'delivery record')
    assert.equal(await js('window.mailCalls[1].recipient'), 'receiver@example.com')
    assert.ok(!(await js('document.querySelector(".mail-history").textContent')).includes('fixture-authorization'))
    checks.push('Explicit recipient test and masked delivery history render correctly')
    await click('填入阿里邮箱配置'); await click('保存配置')
    await wait('window.mailCalls.length === 3', 'saved Ali settings')
    const ali = await js('window.mailCalls[2].body')
    assert.equal(ali.host, 'smtp.qiye.aliyun.com')
    assert.equal(ali.port, 465)
    assert.equal(ali.security, 'ssl')
    assert.equal(ali.username, 'sender@126.com')
    assert.equal(ali.password, '')
    checks.push('Ali enterprise preset saves SSL 465 while preserving sender and stored authorization')
    await shot('mail-settings-desktop')
    win.setSize(390, 960); await sleep(150)
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'))
    await shot('mail-settings-mobile')
    checks.push('390px responsive layout has no horizontal overflow')
    await win.loadURL(origin + '/?readonly=1')
    await wait('!!document.querySelector(".mail-legal input")', 'read-only legal settings')
    assert.equal(await js('[...document.querySelectorAll(".mail-legal input")].every(input=>input.disabled)'), true)
    assert.equal(await js('[...document.querySelectorAll("button")].find(button=>button.textContent.trim()==="保存运营信息").disabled'), true)
    assert.equal(await js('window.mailCalls.length'), 0)
    checks.push('Non-super administrators cannot edit or save legacy legal settings')
    assert.deepEqual(errors, [])
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, checks, errors, boundary: 'Real Chromium with fixture API; no external SMTP or business account' }, null, 2))
    console.log(JSON.stringify({ ok: true, checks, output }))
    win.destroy(); server.close(); app.exit(0)
  }).catch(error => { console.error(error); win?.destroy(); server?.close(); app.exit(1) })
}
