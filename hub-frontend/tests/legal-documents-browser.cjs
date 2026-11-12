'use strict'
// Production React UI and real legal APIs with a disposable SQLite database.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const assert = require('node:assert/strict'), { spawn, spawnSync } = require('node:child_process')
const electron = process.versions.electron ? require('electron') : require('../../client/node_modules/electron')
const root = path.resolve(__dirname, '..'), out = path.resolve(root, '../outputs/legal-client-20261106/admin-browser')
fs.mkdirSync(out, { recursive: true })
if (typeof electron === 'string') {
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key]
  const result = spawnSync(electron, [__filename], { env, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 2e6 })
  process.stdout.write(result.stdout || '')
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error))
  process.exitCode = result.status || (result.error ? 1 : 0)
} else {
  const { app, BrowserWindow, session } = electron
  app.setPath('userData', fs.mkdtempSync(path.join(out, 'profile-'))); app.disableHardwareAcceleration()
  let backend, server, win, fixture, publishRequests = 0
  const results = [], errors = [], performanceResults = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const js = code => win.webContents.executeJavaScript(code, true)
  async function until(code, label) { for (let i = 0; i < 180; i++) { if (await js(code)) return; await sleep(50) } throw Error('Timeout: ' + label) }
  async function click(text) {
    await js(`(()=>{const b=[...document.querySelectorAll('.legal-manager button,.legal-dialog button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Missing or disabled: '+${JSON.stringify(text)});b.focus();b.click()})()`)
    await sleep(80)
  }
  async function field(label, value) {
    const select = await js(`(()=>{const l=[...document.querySelectorAll('.legal-manager label')].find(l=>l.firstChild.textContent.trim()===${JSON.stringify(label)});const b=l?.querySelector('.select-menu-trigger');if(!b)return false;b.click();return true})()`)
    if (select) {
      const name = { 'en-US': 'English', 'zh-CN': '简体中文', 'ja-JP': '日本語', 'ko-KR': '한국어', html: 'HTML', markdown: 'Markdown', text: '纯文本', accept: '需要重新同意用户协议', notice: '通知用户，无需重新同意' }[value]
      await until("!!document.querySelector('[role=option]')", 'select options')
      await js(`(()=>{const b=[...document.querySelectorAll('[role=option]')].find(b=>b.textContent.trim()===${JSON.stringify(name)});if(!b||b.disabled)throw Error('Missing option');b.click()})()`)
      await sleep(50); return
    }
    await js(`(()=>{const l=[...document.querySelectorAll('.legal-manager label')].find(l=>l.firstChild.textContent.trim()===${JSON.stringify(label)});if(!l)throw Error('Missing label: '+${JSON.stringify(label)});const el=l.querySelector('input,textarea,select');const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`)
    await sleep(50)
  }
  async function request(method, route, body, device = false) {
    const response = await fetch(fixture.url + '/api/v1/' + route, { method,
      headers: { Authorization: device ? 'Device ' + fixture.deviceToken : 'Bearer ' + fixture.token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  const state = async kind => (await request('GET', 'admin/legal-documents/' + kind)).data
  async function shot(name) { await sleep(100); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()) }
  async function reviewed() { await js("document.querySelector('.legal-check input').click()"); await sleep(50) }
  async function key(keyCode, modifiers = []) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(60)
  }
  async function assertOptionsFit(selector, count = 2) {
    const bounds = await js(`(()=>[...document.querySelectorAll(${JSON.stringify(selector)})].map(option=>{const span=option.querySelector('span'),range=document.createRange();range.selectNodeContents(span);const r=range.getBoundingClientRect(),b=option.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=b.left-1&&r.right<=b.right+1&&r.top>=b.top-1&&r.bottom<=b.bottom+1}))()`)
    assert.equal(bounds.length, count)
    assert.ok(bounds.every(Boolean), 'every option must contain its full visible text')
  }
  async function importFile(key) {
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
    await js(`window.legalImportDispatched=new Promise(resolve=>document.querySelector('.legal-import input[type=file]')
      .addEventListener('change',()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)),{once:true}));void 0;`)
    const { root: documentNode } = await win.webContents.debugger.sendCommand('DOM.getDocument')
    const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: documentNode.nodeId, selector: '.legal-import input[type=file]' })
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [fixture.importFiles[key]] })
    await js('legalImportDispatched')
    await until("!!document.querySelector('.legal-import-review,.legal-import .legal-error')", 'document import')
  }
  function record(name) { results.push(name); process.stdout.write('PASS ' + name + '\n') }
  async function startBackend() {
    const backendRoot = path.resolve(root, '../hub-backend')
    const python = process.env.SODUWORK_TEST_PYTHON || path.join(backendRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    backend = spawn(python, ['-u', 'tests/legal_documents_server.py'], { cwd: backendRoot, windowsHide: true })
    return new Promise((resolve, reject) => {
      let text = '', diagnostic = ''
      const timer = setTimeout(() => reject(Error('Fixture startup: ' + diagnostic)), 20000)
      backend.stderr.on('data', chunk => { diagnostic += String(chunk) })
      backend.on('error', reject)
      backend.on('exit', code => { clearTimeout(timer); if (!fixture) reject(Error('Fixture exited ' + code + ': ' + diagnostic)) })
      backend.stdout.on('data', chunk => { text += String(chunk); for (const line of text.split('\n')) { try { const value = JSON.parse(line); if (value.fixtureOnly && value.ready) { fixture = value; clearTimeout(timer); resolve(value); return } } catch {} } })
    })
  }
  app.whenReady().then(async () => {
    await startBackend()
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(fixture.url + '/healthz')).ok) break } catch (error) { if (attempt === 99) throw error }
      await sleep(50)
    }
    const user = (await request('GET', 'admin/me')).data
    server = http.createServer((req, res) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/healthz')) {
        if (req.method === 'POST' && /\/legal-documents\/[^/]+\/publish$/.test(req.url)) publishRequests++
        const proxy = http.request(fixture.url + req.url, { method: req.method, headers: req.headers }, upstream => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res) })
        proxy.on('error', () => { res.writeHead(502); res.end() }); req.pipe(proxy); return
      }
      const name = new URL(req.url, 'http://localhost').pathname
      const file = path.resolve(root, 'dist', name === '/' ? 'index.html' : decodeURIComponent(name.slice(1)))
      if (!file.startsWith(path.resolve(root, 'dist') + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
      let body = fs.readFileSync(file)
      if (file.endsWith('index.html')) body = Buffer.from(body.toString().replace('<head>', `<head><script>localStorage.setItem('soduwork_hub_admin_token',${JSON.stringify(fixture.token)});localStorage.setItem('soduwork_hub_admin_user',${JSON.stringify(JSON.stringify(user))});sessionStorage.setItem('soduwork-hub-screen','legal-documents');if(!localStorage.getItem('soduwork.locale'))localStorage.setItem('soduwork.locale','zh-CN');window.confirm=()=>{throw Error('Unexpected native confirmation')};</script>`))
      res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(body)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = 'http://127.0.0.1:' + server.address().port
    const isolated = session.fromPartition('legal-admin-' + Date.now())
    isolated.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('data:') }))
    win = new BrowserWindow({ show: false, width: 1280, height: 960, webPreferences: { session: isolated, offscreen: true, backgroundThrottling: false } })
    win.webContents.on('console-message', event => { if (/Uncaught|React error/.test(event.message)) errors.push(event.message) })
    await win.loadURL(origin)
    await until("!!document.querySelector('.legal-fields')", 'legal editor')
    const baseline = (await request('GET', 'client-auth/legal-documents')).data
    assert.equal(await js("document.querySelector('.legal-fields select')===null"), true)
    await shot('empty-import')
    await importFile('invalid')
    assert.equal(await js("document.querySelector('.legal-import .legal-error').textContent"), '无法读取此 Word 文档，请另存为 .docx 后重试')
    await importFile('revisions')
    assert.equal(await js("document.querySelector('.legal-import .legal-error').textContent"), '文档包含未确认的修订，请先在 Word 中处理修订后再导入')
    await importFile('oversized')
    assert.equal(await js("document.querySelector('.legal-import .legal-error').textContent"), '文档过大或结构过于复杂，请精简后导入')
    await importFile('empty')
    assert.equal(await js("document.querySelector('.legal-import .legal-error').textContent"), '文档中没有可导入的正文')
    for (const key of ['text', 'markdown']) {
      await importFile(key)
      assert.equal(await js("[...document.querySelectorAll('.legal-import-review button')].find(b=>b.textContent==='导入到草稿').disabled"), false)
      assert.equal(await js("document.querySelector('.legal-import-review img, .legal-import-review script')===null && !window.importInjected"), true)
      await click('取消')
    }
    record('text and Markdown imports are previewed safely; malformed, unresolved and oversized Word documents leave drafts unchanged')
    {
      const JSZip = require('jszip'), zip = await JSZip.loadAsync(fs.readFileSync(fixture.importFiles['en-US']))
      const paragraphs = Array.from({ length: 1000 }, (_, index) => `<w:p><w:r><w:t>Clause ${index + 1}. This synthetic legal paragraph preserves the original wording and readable spacing.</w:t></w:r></w:p>`).join('')
      zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paragraphs + '</w:body></w:document>')
      fixture.importFiles.pressure = path.join(path.dirname(fixture.importFiles['en-US']), 'import-pressure.docx')
      fs.writeFileSync(fixture.importFiles.pressure, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
      for (let iteration = 0; iteration < 3; iteration++) {
        await js(`window.legalImportTiming={started:performance.now(),last:performance.now(),gaps:[]};
          window.legalImportClock=setInterval(()=>{const now=performance.now();legalImportTiming.gaps.push(now-legalImportTiming.last);legalImportTiming.last=now;},10);`)
        await importFile('pressure'); await sleep(100)
        const timing = await js(`(()=>{clearInterval(legalImportClock);return {elapsedMs:performance.now()-legalImportTiming.started,
          maxMainThreadGapMs:Math.max(...legalImportTiming.gaps),heartbeatSamples:legalImportTiming.gaps.length,
          paragraphs:document.querySelectorAll('.legal-import-review .legal-preview p').length,
          finalParagraph:document.querySelector('.legal-import-review .legal-preview p:last-child')?.textContent}})()`)
        assert.equal(timing.paragraphs, 1000)
        assert.match(timing.finalParagraph, /^Clause 1000\./)
        assert.ok(timing.heartbeatSamples > 10, 'the renderer must remain responsive while the worker converts Word')
        assert.ok(timing.maxMainThreadGapMs < 1000, JSON.stringify(timing))
        performanceResults.push({ iteration: iteration + 1, ...timing }); await click('取消')
      }
      assert.deepEqual((await state('terms')).history, [])
      record('three 1000-paragraph Word imports preserve every paragraph without a one-second renderer stall or a draft write')
    }
    await importFile('short')
    assert.equal(await js("[...document.querySelectorAll('.legal-import-review button')].find(b=>b.textContent==='导入到草稿').disabled"), true)
    await field('确认正文语言', 'en-US')
    assert.equal(await js("[...document.querySelectorAll('.legal-import-review button')].find(b=>b.textContent==='导入到草稿').disabled"), false)
    await click('取消')
    for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
      await importFile(locale)
      assert.equal(await js("document.querySelector('.legal-import-review .legal-row b').textContent"), { 'en-US': 'English', 'ja-JP': '日本語', 'ko-KR': '한국어' }[locale])
      await click('取消')
    }
    // Optional, local-only comparison against reviewer's Word originals. No save
    // or publish call is made for these documents, and they are never fixtures.
    if (process.env.SODUWORK_LEGAL_SOURCE_ZIP) {
      const JSZip = require('jszip'), { DOMParser } = require('@xmldom/xmldom')
      const sourceZip = await JSZip.loadAsync(fs.readFileSync(process.env.SODUWORK_LEGAL_SOURCE_ZIP))
      let index = 0
      for (const file of Object.values(sourceZip.files).filter(file => file.name.endsWith('.docx'))) {
        const bytes = await file.async('nodebuffer'), source = await JSZip.loadAsync(bytes)
        const xml = new DOMParser().parseFromString(await source.file('word/document.xml').async('string'), 'text/xml')
        const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
        const normalize = text => text.replace(/\s+/g, '')
        const paragraphs = Array.from(xml.getElementsByTagNameNS(ns, 'p')).map(p => Array.from(p.getElementsByTagNameNS(ns, 't')).map(t => t.textContent).join('')).filter(text => text.trim())
        const key = 'original-' + index++, local = path.join(out, key + '.docx')
        fs.writeFileSync(local, bytes); fixture.importFiles[key] = local
        await importFile(key)
        const shown = await js("document.querySelector('.legal-import-review .sw-legal-html')?.textContent || ''")
        fs.writeFileSync(path.join(out, key + '-body.html'), await js("document.querySelector('.legal-import-review .sw-legal-html').innerHTML"))
        for (const paragraph of paragraphs) assert.ok(normalize(shown).includes(normalize(paragraph)), 'original paragraph retained: ' + paragraph.slice(0, 24))
        assert.ok(await js("[...document.querySelectorAll('.legal-import-review .sw-legal-html p')].some(p=>p.style.marginBottom==='8pt')"))
        if (shown.includes('本服务支持')) assert.ok(normalize(shown).includes('1.2本服务支持'))
        await js("document.querySelector('.legal-import-review .legal-preview').scrollIntoView({block:'center'})")
        await shot(key + '-html'); await click('取消')
      }
      assert.equal(index, 4)
      record('all four supplied final Word documents preserve every source paragraph and original spacing in local HTML previews')
    }
    await importFile('zh-CN')
    assert.equal(await js("document.querySelector('.legal-import-review .legal-row b').textContent"), '简体中文')
    assert.equal(await js("document.querySelector('.legal-import-review .legal-preview table')!==null"), true)
    assert.deepEqual(await js("[...document.querySelectorAll('.legal-import-review .sw-legal-html p')].filter(p=>p.textContent.includes('原文第')).map(p=>p.textContent)"), ['1.\u00a0原文第一项', '2.\u00a0原文第二项'])
    assert.deepEqual(await js("(()=>{const p=[...document.querySelectorAll('.legal-import-review .sw-legal-html p')].find(p=>p.textContent.startsWith('本协议说明')),s=getComputedStyle(p);return [p.style.marginTop,p.style.marginBottom,p.style.lineHeight,p.style.textIndent,s.whiteSpace]})()"), ['6pt', '8pt', '1.5', '22pt', 'pre-wrap'])
    assert.equal(await js("[...document.querySelectorAll('.legal-import-review .legal-preview h1,.legal-import-review .legal-preview h2')].filter(h=>h.textContent==='测试用户协议').length"), 1)
    assert.equal(await js("(()=>{const p=document.querySelector('.legal-import-review .legal-preview');return p.scrollWidth<=p.clientWidth+1})()"), true)
    assert.deepEqual((await state('terms')).draft.translations, {})
    await shot('import-review-zh'); await click('导入到草稿')
    await click('移除此语言'); await until("!!document.querySelector('.legal-dialog')", 'remove confirmation')
    assert.equal(await js("document.querySelector('.legal-dialog').contains(document.activeElement)"), true)
    await shot('remove-language-dialog')
    for (let i = 0; i < 5; i++) { await key('Tab'); assert.equal(await js("document.querySelector('.legal-dialog').contains(document.activeElement)"), true) }
    await key('Escape')
    assert.equal(await js("document.querySelector('.legal-dialog')===null"), true)
    await click('移除此语言')
    await click('取消')
    assert.equal(await js("document.activeElement.textContent.trim()"), '移除此语言')
    assert.equal(await js("document.querySelector('.legal-editor').value.includes('第一')"), true)
    await click('发布设置')
    assert.equal(await js("document.querySelector('.legal-checklist').textContent.includes('本语言更新说明')"), true)
    assert.equal(await js("document.querySelector('.legal-auto-version input')===null"), true)
    await shot('publication-missing-summary')
    await click('补全内容')
    await importFile('zh-CN')
    assert.ok(await js("[...document.querySelectorAll('.legal-import-review button')].some(b=>b.textContent==='替换此语言草稿')"))
    await click('取消')
    record('real Word imports detect four document languages, preserve lists and tables, require review and keep drafts private')
    await field('文档标题', '测试用户协议'); await field('正文格式', 'markdown'); await click('确认转换')
    await field('协议正文', '## 使用范围\n**完整原文**\n<img src="https://untrusted.test/x" onerror="alert(1)">\n\n| 项目 | 说明 |\n| --- | --- |\n| 数据 | 原文 |')
    await field('本语言更新说明', '本次更新范围。')
    await importFile('en-US'); await click('导入到草稿')
    await field('文档标题', 'Fixture Terms'); await field('正文格式', 'markdown'); await click('确认转换'); await field('协议正文', '## Scope\n**Exact source**'); await field('本语言更新说明', 'Scope was updated.')
    await click('发布设置'); await field('更新方式', 'accept'); await click('保存并继续核对')
    await until("document.querySelector('.legal-fields')?.disabled===false", 'saved draft')
    assert.deepEqual((await request('GET', 'client-auth/legal-documents')).data, baseline)
    assert.equal((await state('terms')).draft.version, '')
    assert.equal(await js("document.querySelector('.legal-tabs .active').textContent"), '用户端预览')
    record('saved draft stays private and publication requires language review')
    await click('用户端预览'); await reviewed(); await field('正文语言', 'en-US'); await reviewed()
    assert.equal(await js("document.querySelector('.legal-preview strong').textContent"), 'Exact source')
    await field('正文语言', 'zh-CN')
    assert.equal(await js("document.querySelector('.legal-preview img')===null"), true)
    assert.equal(await js("document.querySelector('.legal-preview table')!==null"), true)
    await shot('preview-zh')
    await click('发布设置')
    await field('生效时间', '2020-01-01T00:00'); await click('核对发布')
    assert.equal(publishRequests, 0)
    assert.equal(await js("document.querySelector('.legal-error').textContent"), '生效时间不能早于当前时间')
    await field('生效时间', '')
    await click('核对发布'); await shot('publish-review')
    await js("(()=>{const b=[...document.querySelectorAll('.legal-dialog button')].find(b=>b.textContent==='确认发布');b.click();b.click()})()")
    await until("!!document.querySelector('.legal-history article')", 'published version')
    const first = await state('terms'), version = first.history[0]
    assert.equal(version.version, 'v1')
    assert.equal(first.history.length, 1)
    assert.equal(publishRequests, 1)
    assert.equal(first.currentId, version.id)
    assert.equal((await request('GET', 'client-auth/me/legal-status', undefined, true)).data.acceptanceRequired, true)
    const live = (await request('GET', 'client-auth/legal-documents')).data
    assert.equal(live.documents.filter(row => row.key === 'terms').length, 2)
    record('reviewed publication appears through the real client API with exact translations and acceptance requirement')
    await click('查看'); await until("!!document.querySelector('.legal-preview')", 'history snapshot'); await shot('history')
    await click('以此版本创建草稿'); await click('发布设置')
    assert.equal(await js("document.querySelector('.legal-auto-version').textContent.includes('发布时自动生成')"), true)
    record('history is read-only and restoring it starts a new unnumbered draft')
    await click('重新加载'); await shot('discard-draft-dialog'); await click('放弃并继续'); await until("document.querySelector('.legal-fields')?.disabled===false", 'reload')
    await click('内容维护'); await field('文档标题', 'Unsaved UI edit')
    await js("window.dispatchEvent(new CustomEvent('soduwork-hub-nav',{detail:{screen:'overview'}}))")
    await until("!!document.querySelector('.legal-dialog')", 'navigation confirmation'); await click('取消')
    assert.equal(await js("document.querySelector('.app').dataset.screen"), 'legal-documents')
    const competing = await state('terms')
    await request('PUT', 'admin/legal-documents/terms/draft', { revision: competing.revision, draft: { ...competing.draft, translations: { ...competing.draft.translations, 'zh-CN': { ...competing.draft.translations['zh-CN'], title: 'Concurrent edit' } } } })
    await click('保存草稿'); await until("!!document.querySelector('.legal-error')", 'conflict')
    assert.equal((await state('terms')).draft.translations['zh-CN'].title, 'Concurrent edit')
    record('concurrent draft saves report a conflict without overwriting another administrator')
    await click('隐私政策'); await click('放弃并继续'); await until("document.querySelector('.legal-fields')?.disabled===false", 'privacy')
    await click('发布设置')
    assert.equal(await js("document.querySelector('select option[value=accept]')===null"), true)
    assert.equal(await js("document.querySelector('.legal-fixed-field p').textContent"), '通知用户，无需重新同意')
    assert.equal(await js("document.querySelector('.legal-fixed-field select,.legal-fixed-field input')===null"), true)
    await shot('privacy-publish-readonly')
    record('privacy publication never pretends to collect purpose-specific consent')
    await click('内容维护'); await importFile('en-US'); await click('导入到草稿'); await field('文档标题', 'Fixture Privacy')
    await field('协议正文', 'Published later.'); await field('本语言更新说明', 'Privacy notice update.')
    await click('发布设置')
    const future = new Date(Date.now() + 86400000)
    await field('生效时间', new Date(future.getTime() - future.getTimezoneOffset() * 60000).toISOString().slice(0, 16))
    await click('保存草稿'); await until("document.querySelector('.legal-fields')?.disabled===false", 'scheduled draft')
    await click('核对正文'); await click('确认本语言并继续'); await click('核对发布'); await click('确认发布')
    await until("!!document.querySelector('.legal-history article')", 'scheduled history')
    assert.equal((await request('GET', 'client-auth/legal-documents')).data.requiredConsentVersions.privacy, baseline.requiredConsentVersions.privacy)
    await click('取消定时发布'); await shot('cancel-publication-dialog'); await click('确认取消发布'); await until("document.querySelector('.legal-fields')?.disabled===false", 'cancel schedule')
    assert.ok((await state('privacy')).history[0].canceledAt)
    record('scheduled publication stays private and cancellation preserves its history')
    for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN']) {
      await js(`localStorage.setItem('soduwork.locale',${JSON.stringify(locale)})`); await win.reload()
      await until("!!document.querySelector('.legal-fields')", 'locale editor')
      const title = await js("document.querySelector('.legal-heading h2').textContent")
      assert.equal(title, { 'en-US': 'Terms of Service', 'ja-JP': '利用規約', 'ko-KR': '이용약관', 'zh-CN': '用户协议' }[locale])
      await importFile('invalid')
      assert.equal(await js("document.querySelector('.legal-import .legal-error').textContent"), {
        'en-US': 'Cannot read this Word document. Save it as .docx and retry.',
        'ja-JP': 'Word 文書を読み込めません。.docx 形式で保存して再試行してください。',
        'ko-KR': 'Word 문서를 읽을 수 없습니다. .docx로 저장한 후 다시 시도하세요.',
        'zh-CN': '无法读取此 Word 文档，请另存为 .docx 后重试',
      }[locale])
      await importFile('en-US')
      await js("document.querySelector('.legal-import-review .legal-actions .btn-ghost').click()")
      await js("document.querySelector('.legal-format .select-menu-trigger').focus()")
      await key('Down')
      assert.equal(await js("document.activeElement.getAttribute('role')"), 'option')
      for (const zoom of [1, 1.5]) {
        win.webContents.setZoomFactor(zoom); await sleep(100)
        assert.equal(await js(`(()=>{const b=document.querySelector('.legal-format .select-menu-trigger'),s=b.querySelector('span'),r=s.getBoundingClientRect(),p=b.getBoundingClientRect();return r.top>=p.top&&r.bottom<=p.bottom&&s.scrollWidth<=s.clientWidth+1})()`), true)
        await assertOptionsFit('.legal-format [role=option]', 3)
        await shot('format-' + locale + '-' + zoom)
      }
      win.webContents.setZoomFactor(1); await key('Escape')
      await js("[...document.querySelectorAll('.legal-tabs button')][2].click()")
      await js("document.querySelector('.legal-fields .select-menu-trigger').click()")
      await until("document.querySelectorAll('[role=option]').length===2", 'update options')
      await assertOptionsFit('.legal-fields [role=option]')
      await shot('update-options-' + locale); await key('Escape')
      await js("[...document.querySelectorAll('.legal-tabs button')][0].click()")
      await shot('editor-' + locale)
    }
    win.setContentSize(560, 900); await shot('editor-narrow')
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth+1'), true)
    await click('移除此语言'); await click('确认移除')
    assert.equal(await js("document.querySelector('.legal-source-language b').textContent"), 'English')
    assert.deepEqual(Object.keys((await state('terms')).draft.translations).sort(), ['en-US', 'zh-CN'])
    await click('重新加载'); await click('放弃并继续')
    await until("document.querySelector('.legal-fields')?.disabled===false", 'discard local language removal')
    assert.deepEqual(errors, [])
    record('four interface languages and narrow layout keep original text and native admin styling')
    record('styled dialogs trap and restore keyboard focus; publication checks guide missing fields and duplicate clicks create one release')
    await importFile('zh-CN'); await click('替换此语言草稿'); await field('本语言更新说明', '保留原稿排版。')
    assert.equal(await js("document.querySelector('.legal-format .select-menu-trigger').textContent.trim()"), 'HTML')
    assert.equal(await js("document.querySelector('.legal-html-editor details').open"), false)
    await click('发布设置'); await click('保存并继续核对')
    await until("document.querySelector('.legal-fields')?.disabled===false", 'HTML draft saved')
    await click('确认本语言并继续'); await click('确认本语言并继续'); await click('核对发布'); await click('确认发布')
    await until("!!document.querySelector('.legal-history article')", 'HTML publication')
    const htmlPublication = (await request('GET', 'client-auth/legal-documents')).data.documents.find(row => row.key === 'terms' && row.locale === 'zh-CN')
    assert.equal(htmlPublication.format, 'html')
    assert.match(htmlPublication.content, /margin-top:6pt/)
    assert.match(htmlPublication.content, /line-height:1.5/)
    assert.equal(htmlPublication.content, (await state('terms')).draft.translations['zh-CN'].content)
    assert.match(htmlPublication.content, /1\.&nbsp;原文第一项/)
    assert.ok(!htmlPublication.content.includes('class=') && !htmlPublication.content.includes('sw_legal_paragraph_'))
    record('Word HTML survives draft save, reviewed publication and public API retrieval with its exact source metrics')
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ok: true, results, performanceResults }, null, 2))
  }).catch(error => { errors.push(String(error.stack || error)); process.stderr.write(errors.at(-1) + '\n'); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ok: false, results, errors }, null, 2)) })
    .finally(() => { win?.destroy(); server?.close(); backend?.kill(); app.exit(errors.length ? 1 : 0) })
}
