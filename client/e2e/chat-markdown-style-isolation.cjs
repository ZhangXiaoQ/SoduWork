'use strict';
// Production Markdown, DOMPurify and DOM patching in a real hidden Chromium
// window. No running client, signed-in profile, Hub or model is contacted.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 45000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-markdown-isolation-'));
  const output = path.resolve(process.argv[2] || path.join(client, '../outputs/chat-markdown-style-isolation/report.json'));
  const report = { ok: false, isolatedProfile: true, userWindowTouched: false,
    realHub: false, realModel: false, cases: [], externalRequests: [] };
  app.setPath('userData', path.join(scratch, 'profile'));
  let win;
  const run = source => win.webContents.executeJavaScript(source, true);
  const load = file => run(fs.readFileSync(path.join(client, file), 'utf8') + '\n;void 0;');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function check(name, body) {
    try { report.cases.push({ name, ok: true, ...await body() }); }
    catch (error) { report.cases.push({ name, ok: false, error: error.message }); }
  }
  function bounded(state) {
    assert.equal(state.main.display, 'flex', 'message cannot override the chat flex column');
    assert(state.main.width <= state.frame.width + 1, 'chat column stays inside its frame');
    assert(state.message.width >= Math.min(300, state.frame.width - 40), 'history message keeps a readable width');
    assert(state.message.width <= state.frame.width + 1, 'history message stays inside its chat column');
    assert(state.footer.bottom <= state.viewport.height + 1, 'composer remains in the viewport');
    assert(state.footer.top >= 0 && state.footer.height > 0, 'composer remains visible');
    assert.equal(state.unsafeTags, 0, 'raw global styling/navigation markup is removed');
    assert.equal(state.inlineStyles, 0, 'raw inline styles cannot overlay the conversation');
  }
  app.whenReady().then(async () => {
    const html = path.join(scratch, 'fixture.html');
    fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><div id="frame" style="position:absolute;inset:10px 10px 10px 250px;overflow:hidden">' +
      '<div class="nchat"><div class="nchat-stage"><div class="nchat-main"><header class="nchat-head">隔离会话样式回归</header>' +
      '<div class="nchat-content-area"><div class="nchat-scroll"><div class="nchat-inner" id="list"></div></div></div>' +
      '<div class="nchat-foot"><div class="nchat-footin"><textarea placeholder="接着说…" style="box-sizing:border-box;width:100%;height:80px"></textarea></div></div>' +
      '</div></div></div></div>');
    win = new BrowserWindow({ show: false, width: 1280, height: 800, skipTaskbar: true,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
      report.externalRequests.push(request.url); callback({ cancel: true });
    });
    await win.loadFile(html);
    for (const file of ['theme/variables.css', 'components/panels/panels-chat.css', 'components/panels/chat-collaboration.css']) {
      await run(`new Promise(resolve => { const link=document.createElement('link'); link.rel='stylesheet'; link.href=${JSON.stringify(pathToFileURL(path.join(client, file)).href)}; link.onload=link.onerror=resolve; document.head.append(link); })`);
    }
    for (const file of ['vendor/markdown/purify.min.js', 'vendor/markdown/marked.umd.js',
      'components/panels/chat-output-links.js', 'components/panels/chat-markdown.js', 'components/panels/chat-dom-patch.js']) await load(file);
    await run(`
      window.ctx = { _ref: 'history-a', _liveTextKey: 'block-a', esc: s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') };
      window.md = ChatMarkdown.create(ctx, () => {});
      window.outputLinks = ChatOutputLinks;
      window.paint = (source, mode = 'rich') => {
        const content = mode === 'sanitize' ? ChatOutputLinks.sanitize(source, DOMPurify)
          : mode === 'stream' ? md._streamText(source) : md.rich(source);
        ChatDomPatch.patchList(document.getElementById('list'), '<article class="nmsg ai" data-chat-node="message:0"><div class="ntext" data-block="0">' + content + '</div></article>');
      };
      window.measure = () => {
        const rect = selector => { const node=document.querySelector(selector), r=node.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,width:r.width,height:r.height,display:getComputedStyle(node).display}; };
        const list=document.getElementById('list');
        return { viewport:{width:innerWidth,height:innerHeight}, frame:rect('#frame'), main:rect('.nchat-main'), footer:rect('.nchat-foot'),
          message:rect('#list .nmsg.ai'),
          unsafeTags:list.querySelectorAll('style,link,meta,base').length, inlineStyles:list.querySelectorAll('[style]').length, text:list.textContent };
      }; void 0;
    `);
    const ordinary = '正文开头，历史消息完整保留。\n\n' + ('可复制的普通长正文。'.repeat(40) + '\n\n').repeat(12) + '正文结束标记。';
    const poisoned = '<div><style>.nchat-main{display:block;min-width:2700px}.nchat-foot{display:none}</style><p>样式外的正文保留。</p></div>\n\n' + ordinary;
    for (const [width, height] of [[960, 700], [1280, 800], [2000, 1240]]) {
      win.setSize(width, height);
      await delay(70);
      for (const [name, source, reset] of [
        ['ordinary-history', ordinary, 'ctx._ref="history-a";md.reset();'],
        ['nested-global-style-history', poisoned, ''],
        ['switch-to-other-history', ordinary, 'ctx._ref="history-b";'],
        ['reopen-poisoned-history', poisoned, 'ctx._ref="history-a";md.reset();'],
        ['cached-poisoned-history', poisoned, ''],
        ['streamed-global-style', poisoned, 'md.reset();ctx._liveTextKey="style-stream";'],
      ]) {
        await check(`${width}x${height}:${name}`, async () => {
          await run(reset + `paint(${JSON.stringify(source)},${JSON.stringify(name.startsWith('streamed') ? 'stream' : 'rich')});void 0;`);
          await delay(30);
          const state = await run('measure()'); bounded(state);
          assert(state.text.includes('正文开头，历史消息完整保留。'));
          assert(state.text.includes('正文结束标记。'), 'the entire visible prose survives sanitization');
          if (source === poisoned) assert(state.text.includes('样式外的正文保留。'));
          return { viewport: state.viewport, main: state.main, footer: state.footer };
        });
      }
    }
    await check('inline-positioned-overlay-is-inert', async () => {
      await run('md.reset();paint(' + JSON.stringify('<div style="position:fixed;inset:0;z-index:2147483647" id="overlay">覆盖层正文仍可读。</div>') + ');void 0;');
      const state = await run('measure()'); bounded(state);
      assert.equal(await run('getComputedStyle(document.getElementById("overlay")).position'), 'static');
      assert(state.text.includes('覆盖层正文仍可读。'));
    });
    await check('sanitizer-fast-path-removes-global-and-inline-styles', async () => {
      await run('paint(' + JSON.stringify('<div><style>body{display:none}</style><link rel="stylesheet" href="https://example.invalid/global.css"><base href="https://example.invalid/"><meta http-equiv="refresh" content="0;url=https://example.invalid/"><p style="min-width:9000px">正文安全标记。</p></div>') + ',"sanitize");void 0;');
      const state = await run('measure()'); bounded(state); assert(state.text.includes('正文安全标记。'));
    });
    await check('sanitizer-media-path-keeps-inert-images-and-authorized-output-links', async () => {
      await run('paint(' + JSON.stringify('<div><style>.nchat-main{display:block}</style><p style="position:fixed">查看 <a href="file:///C:/work/report.md">报告</a> 与 <a href="https://example.invalid/report.md">外链</a>。</p><img src="https://example.invalid/pixel.png" style="position:fixed" onerror="alert(1)" alt="图像说明"></div>') + ',"sanitize");void 0;');
      const before = await run('measure()'); bounded(before);
      assert.equal(await run('document.querySelectorAll("#list img[src]").length'), 0, 'untrusted media remains inert');
      assert.equal(await run('document.querySelector("#list [data-output-image-ref]").textContent'), '图像说明');
      const matches = await run('ChatOutputLinks.linkify(document.getElementById("list"),[{artifactId:"trusted-report",name:"report.md",relative:"report.md"}])');
      assert.equal(matches, 1);
      assert.equal(await run('document.querySelector("#list [data-open-app]").dataset.openApp'), 'trusted-report');
      assert.equal(await run('document.querySelector("#list a").getAttribute("href")'), 'https://example.invalid/report.md');
    });
    await check('markdown-tables-code-links-and-long-body-remain-intact', async () => {
      const source = '# 标题\n\n| 字段 | 结果 |\n| --- | --- |\n| 检查 | 保留 |\n\n```html\n<style>.nchat-main{display:block}</style>\n```\n\n[文档](https://example.invalid/doc)\n\n' + ordinary;
      await run('md.reset();paint(' + JSON.stringify(source) + ');void 0;');
      const state = await run('measure()'); bounded(state);
      assert.equal(await run('document.querySelectorAll("#list table tbody tr").length'), 1);
      assert.equal(await run('document.querySelector("#list pre code").textContent.trim()'), '<style>.nchat-main{display:block}</style>');
      assert.equal(await run('document.querySelector("#list a").getAttribute("href")'), 'https://example.invalid/doc');
      assert(state.text.includes('正文结束标记。'));
    });
    for (const mode of ['rich', 'stream']) {
      await check(`output-links-module-unavailable:${mode}`, async () => {
        await run(`window.ChatOutputLinks=undefined;md.reset();paint(${JSON.stringify('<div><style>.nchat-foot{display:none}.nchat-main{min-width:2700px}</style><link rel="stylesheet" href="https://example.invalid/theme.css"><p style="position:fixed;inset:0">降级正文与末尾保留。</p></div>')},${JSON.stringify(mode)});void 0;`);
        const state = await run('measure()'); bounded(state); assert(state.text.includes('降级正文与末尾保留。'));
      });
    }
    await run('window.ChatOutputLinks=outputLinks;md.reset();paint(' + JSON.stringify(poisoned) + ');void 0;');
    await delay(100);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(output), 'isolated-history.png'), (await win.webContents.capturePage()).toPNG());
    await check('raw-styles-and-inert-images-make-no-external-request', async () => {
      assert.deepEqual(report.externalRequests, []);
    });
    report.ok = report.cases.every(item => item.ok);
  }).catch(error => { report.error = error.stack || String(error); })
    .finally(() => {
      if (win && !win.isDestroyed()) win.destroy();
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
    });
}
