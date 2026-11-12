'use strict';
// Production renderer/preload with isolated event snapshots; no model or network calls.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, clipboard } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), out = path.resolve(process.env.SODUWORK_CHAT_FOOTER_OUTPUT || path.join(client, '../outputs/chat-reasoning-polish'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-message-footer-'));
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', profile);
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  function css(file) {
    return fs.readFileSync(file, 'utf8').replace(/@import\s+url\(["']?([^"')]+)["']?\)\s*;/g, (_, relative) => css(path.resolve(path.dirname(file), relative)))
      .replace(/url\(["']?([^"')]+)["']?\)/g, (match, relative) => /^(?:data:|https?:|file:)/.test(relative) ? match : 'url("' + pathToFileURL(path.resolve(path.dirname(file), relative)).href + '")');
  }
  let win;
  const js = code => win.webContents.executeJavaScript(code, true), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const sentAt = new Date('2026-09-30T02:18:00Z').getTime(), completedAt = sentAt + 85000;
  const prompt = '请整理方案，保留这段提示词。';
  const plugin = { key: 'plugin-author', name: '插件开发助手', scopeLabel: '个人插件', version: '1.0.0' };
  let snapshot = { status: 'streaming', tools: [], execution: { running: true, elapsedMs: 33000 }, messages: [
    { role: 'user', text: prompt, sentAt, plugins: [plugin] },
    { role: 'assistant', done: false, blocks: [{ kind: 'thinking', index: 0, text: 'Hidden reasoning content', done: true },
      { kind: 'text', index: 1, text: '', done: false }] },
  ] };
  async function until(check) {
    for (let i = 0; i < 120; i++) { if (await js(check)) return; await delay(30); }
    console.error('Footer fixture diagnostics', await js('({errors:window.errors, messages:Array.from(document.querySelectorAll(".nmsg"),e=>e.outerHTML.slice(0,1400))})'));
    throw Error('Timed out: ' + check);
  }
  async function publish() {
    win.webContents.send('pi-session-event', { ref: 'footer', kind: 'snapshot', snapshot: structuredClone(snapshot) });
    await delay(150);
  }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    await delay(180);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(200);
  }
  async function copiedText() {
    // Verify the Unicode text/plain payload through Electron's clipboard API;
    // the legacy synchronous Windows reader can decode Chinese as ANSI here.
    const item = (await clipboard.read()).find(value => value.types.includes('text/plain'));
    return item ? (await item.getType('text/plain')).text() : '';
  }
  app.whenReady().then(async () => {
    const priorClipboard = await Promise.all((await clipboard.read()).map(async item => new electron.ClipboardItem(
      Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
    const results = [];
    try {
      win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: {
        preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
      win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, callback) => callback({ cancel: true }));
      win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => callback(permission.startsWith('clipboard')));
      ipcMain.handle('pi-session-open', () => ({ ok: true, ref: 'footer', sessionId: 'footer', adapterId: 'pi', displayName: 'Pi', cwd: profile, model: { label: 'Fixture model' }, snapshot }));
      ipcMain.handle('pi-session-snapshot', () => ({ ok: true, snapshot }));
      for (const [channel, value] of Object.entries({ 'pi-session-history': { ok: true, chats: [] }, 'pi-session-outputs': { ok: true, items: [] },
        'pi-session-release': { ok: true }, 'pi-session-runtime-models': { ok: true, items: [] }, 'work-preview-hide': { ok: true }, 'work-preview-destroy': { ok: true } })) ipcMain.handle(channel, () => value);
      const source = path.join(client, 'e2e/fixtures/workbench-annotations.html'), scripts = [];
      const html = fs.readFileSync(source, 'utf8').replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_, attrs, body) => {
        const src = attrs.match(/src=["']([^"']+)/); scripts.push(src ? fs.readFileSync(path.resolve(path.dirname(source), src[1]), 'utf8') : body); return '';
      });
      const documentFile = path.join(out, 'footer-native-chat.html');
      fs.writeFileSync(documentFile, html.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/gi, '').replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '">'));
      await win.loadFile(documentFile);
      for (const file of ['theme/variables.css', 'components/panels/work-composer.css', 'components/panels/panels-chat.css', 'components/panels/conversation-attachments.css', 'components/panels/chat-plugin-mention.css']) {
        await js('(()=>{const style=document.createElement("style");style.textContent=' + JSON.stringify(css(path.join(client, file))) + ';document.head.appendChild(style);})();');
      }
      for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
      for (const file of ['core/i18n-dom.js', 'core/i18n.js']) await js(read(file) + '\nvoid 0;');
      // Production loads this helper before the renderer; the legacy workbench
      // fixture predates its extraction and otherwise renders fallback badges.
      await js(read('components/panels/chat-message-plugins.js') + '\nvoid 0;');
      await js(read('components/panels/agent-brand.js') + '\nvoid 0;');
      await js(read('core/requirement-session-context.js') + '\nvoid 0;');
      for (const script of scripts) await js(script + '\nvoid 0;');
      await js('SoduWorkI18n.setLocale("zh-CN");NativeChat.enter("","footer",{adapterId:"pi"});');
      await until('Boolean(document.querySelector(".nmsg.ai .ntext"))');
      assert.equal(await js('document.querySelectorAll(".nmsg.ai time").length'), 0);
      assert.equal(await js('document.querySelector(".nmsg.user time").dateTime'), new Date(sentAt).toISOString());
      assert.equal(await js('document.querySelector(".nmsg.user time").textContent.includes("月")'), true);
      assert.match(await js('document.querySelector(".nmsg.user time").title'), /^2026-09-30 \d{2}:18:00$/);
      assert.equal(await js('document.querySelector(".nmsg.user time").tabIndex'), 0);
      results.push('Historical timestamps include the calendar date with a complete hover timestamp and keyboard focus');
      // The production Markdown renderer batches token updates for 120 ms.
      // Let the initial empty frame settle before this isolated single delta.
      await delay(160);
      const growing = snapshot.messages[1];
      growing.blocks[1].text = '## 方案\n\n第一部分。';
      await publish();
      await until('document.querySelector(".nmsg.ai .ntext").textContent.includes("第一部分")');
      assert.equal(await js('document.querySelectorAll(".nmsg.ai .nmessage-footer").length'), 0);
      const pluginLayouts = [];
      for (const width of [1100, 360]) {
        win.setSize(width, 800); await delay(100);
        for (const theme of ['azure', 'ruby', 'minimal', 'steady', 'warm']) {
          await js('document.documentElement.dataset.theme=' + JSON.stringify(theme));
          const metrics = await js(`(()=>{
            const message=document.querySelector('.nmsg.user'), bubble=message.querySelector('.nbubble');
            const badges=message.querySelector('.nmessage-plugins'), badge=badges.firstElementChild;
            const footer=message.querySelector('.nmessage-footer');
            const b=bubble.getBoundingClientRect(),p=badges.getBoundingClientRect(),m=message.getBoundingClientRect();
            const bodySize=parseFloat(getComputedStyle(document.querySelector('.ntext')).fontSize);
            return {gap:p.top-b.bottom,badgeHeight:badge.getBoundingClientRect().height,
              direct:badges.previousElementSibling===bubble,footerLast:footer===message.lastElementChild,
              footerBelow:footer.getBoundingClientRect().top>=p.bottom,
              contained:p.left>=m.left-1&&p.right<=m.right+1,overflow:message.scrollWidth>message.clientWidth+1,
              bodySize,metricsSize:parseFloat(getComputedStyle(document.querySelector('.nturn-metrics')).fontSize),
              statusSize:parseFloat(getComputedStyle(document.querySelector('.nstatus.show')).fontSize),
              background:getComputedStyle(badge).backgroundColor,color:getComputedStyle(badge).color,
              title:badge.title};
          })()`);
          assert.ok(metrics.gap >= 0 && metrics.gap <= 6, JSON.stringify(metrics));
          assert.equal(metrics.direct, true); assert.equal(metrics.footerLast, true); assert.equal(metrics.footerBelow, true);
          assert.equal(metrics.contained, true); assert.equal(metrics.overflow, false);
          assert.ok(metrics.badgeHeight >= 22 && metrics.badgeHeight <= 27);
          assert.ok(metrics.metricsSize >= metrics.bodySize - .5 && metrics.metricsSize <= metrics.bodySize);
          assert.ok(metrics.statusSize >= 13.5 && metrics.statusSize <= metrics.bodySize);
          assert.ok(metrics.title.includes(plugin.name) && metrics.title.includes(plugin.version));
          pluginLayouts.push({ width, theme, ...metrics });
        }
        await js('document.documentElement.dataset.theme="azure"');
        await delay(100);
        fs.writeFileSync(path.join(out, 'plugin-status-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
      }
      // The current plugin badge has a transparent background and themed ink.
      assert.ok(new Set(pluginLayouts.map(item => item.color)).size > 1, 'Badge text follows the selected theme');
      fs.writeFileSync(path.join(out, 'plugin-status-layouts.json'), JSON.stringify(pluginLayouts, null, 2));
      results.push('Plugin badges sit within 6 px of the prompt before hover controls; 360/1100 px and five themes retain readable 14 px metrics and 13.5 px status');
      async function checkLongPluginLabels() {
        win.setSize(360, 800); await delay(100);
        const longName = '插件开发助手 · 团队业务流程与交付方案自动整理能力'.repeat(4);
        snapshot.messages[0].plugins = [{ ...plugin, name: longName }, { ...plugin, key: 'second', name: '资料整理' }];
        snapshot.messages[0].attachments = [{ name: '业务需求说明.md', type: 'text/markdown', size: 256 }];
        await publish();
        await until('document.querySelectorAll(".nmessage-plugin").length===2');
        const longBadge = await js(`(()=>{
          const msg=document.querySelector('.nmsg.user'),label=msg.querySelector('.nmessage-plugin-label');
          return{full:label.textContent,title:label.parentElement.title,overflow:msg.scrollWidth>msg.clientWidth+1,
            clipped:label.scrollWidth>label.clientWidth,ellipsis:getComputedStyle(label).textOverflow,
            attachmentsAfter:msg.querySelector('.nuser-atts').previousElementSibling.matches('.nmessage-plugins'),
            footerAfter:msg.querySelector('.nmessage-footer').previousElementSibling.matches('.nuser-atts'),
            footerLast:msg.lastElementChild.matches('.nmessage-footer')};
        })()`);
        assert.equal(longBadge.full, longName); assert.ok(longBadge.title.includes(longName));
        assert.equal(longBadge.overflow, false); assert.equal(longBadge.clipped, true); assert.equal(longBadge.ellipsis, 'ellipsis');
        assert.equal(longBadge.footerLast, true); assert.equal(longBadge.attachmentsAfter, true); assert.equal(longBadge.footerAfter, true);
        fs.writeFileSync(path.join(out, 'plugin-long-name-360.png'), (await win.webContents.capturePage()).toPNG());
        snapshot.messages[0].plugins = [plugin]; delete snapshot.messages[0].attachments;
        await publish(); win.setSize(1100, 800);
        results.push('Multiple and long plugin labels wrap within the narrow message; attachments precede hover controls and full names remain in tooltips without changing the copied prompt');
      }
      win.setSize(1100, 800);
      await js('window.retainedText=document.querySelector(".nmsg.ai .ntext")');
      growing.blocks[1].text += '\n\n持续输出中的新内容。';
      await publish();
      await until('document.querySelector(".nmsg.ai .ntext").textContent.includes("持续输出中的新内容")');
      assert.equal(await js('window.retainedText===document.querySelector(".nmsg.ai .ntext")'), true);
      assert.equal(await js('document.querySelectorAll(".nmsg.ai .nmessage-footer").length'), 0);
      growing.blocks[1].done = true;
      growing.blocks.push({ kind: 'text', index: 2, text: '**第二部分。**', done: true });
      growing.done = true; growing.completedAt = completedAt;
      snapshot.status = 'idle'; snapshot.execution.running = false;
      await publish();
      await until('Boolean(document.querySelector(".nmsg.ai time"))');
      assert.equal(await js('document.querySelector(".nmsg.ai time").dateTime'), new Date(completedAt).toISOString());
      assert.equal(await js('document.querySelectorAll(".nmsg.ai .ntext-copy").length'), 1);
      results.push('Streaming text retains its DOM node and has no assistant footer; completion adds exactly one footer for all final text blocks');
      await checkLongPluginLabels();
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 }); await delay(180);
      assert.deepEqual(await js('Array.from(document.querySelectorAll(".nmessage-footer")).map(e=>Number(getComputedStyle(e).opacity))'), [0, 0]);
      assert.equal(await js('document.querySelector(".nmsg.user .nbubble").contains(document.querySelector(".nmessage-copy"))'), false);
      for (const selector of ['.nmsg.user', '.nmsg.ai']) {
        const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+8)}})()`);
        win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await delay(180);
        assert.equal(await js('Number(getComputedStyle(document.querySelector(' + JSON.stringify(selector + ' .nmessage-footer') + ')).opacity)'), 1,
          JSON.stringify(await js('({hover:Array.from(document.querySelectorAll(":hover")).map(e=>e.className),point:' + JSON.stringify(point) + ',target:document.elementFromPoint(' + point.x + ',' + point.y + ')?.outerHTML?.slice(0,400)})')));
      }
      results.push('Time and copy hide together at rest and reveal together on message hover; user footer remains outside the prompt bubble');
      await click('.nmsg.user .nmessage-copy');
      const userCopy = await copiedText();
      assert.equal(userCopy, prompt);
      await click('.nmsg.ai .ntext-copy');
      const copied = await copiedText();
      assert.match(copied, /第一部分/); assert.match(copied, /第二部分/);
      assert.doesNotMatch(copied, /Hidden reasoning|10:19|复制内容/);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 }); await delay(180);
      assert.deepEqual(await js('Array.from(document.querySelectorAll(".nmessage-footer")).map(e=>Number(getComputedStyle(e).opacity))'), [0, 0]);
      // An offscreen window cannot own OS focus. Chromium focus emulation lets
      // trusted keyboard events exercise :focus-visible without stealing it.
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
      await delay(100);
      for (const selector of ['.nmessage-copy', '.ntext-copy']) {
        await js('document.querySelector(' + JSON.stringify(selector) + ').focus({preventScroll:true})');
        await delay(180);
        assert.equal(await js('document.activeElement.matches(":focus-visible")'), true,
          JSON.stringify(await js('({focused:document.hasFocus(),active:document.activeElement.outerHTML,hover:Array.from(document.querySelectorAll(":hover"),e=>e.className)})')));
        assert.equal(await js('Number(getComputedStyle(document.activeElement.closest(".nmessage-footer")).opacity)'), 1);
      }
      await js('document.activeElement.blur()');
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false });
      win.webContents.debugger.detach();
      results.push('Actual clipboard holds user prompt or full answer without reasoning, time or controls');
      for (const locale of ['en-US', 'zh-CN']) {
        await js('SoduWorkI18n.setLocale(' + JSON.stringify(locale) + ')'); await delay(100);
        assert.equal(await js('document.querySelector(".nmsg.user .nmessage-time").title'), locale === 'en-US' ? 'Sent at' : '发送时间');
        assert.equal(await js('document.querySelector(".nmsg.ai .nmessage-time").title'), locale === 'en-US' ? 'Response completed at' : '输出完成时间');
      }
      for (const width of [1100, 360]) {
        win.setSize(width, 800); await delay(100);
        const geometry = await js(`Array.from(document.querySelectorAll('.nmsg')).map(e=>{const footer=e.querySelector('.nmessage-footer'),copy=footer.querySelector('button');const f=footer.getBoundingClientRect(),c=copy.getBoundingClientRect(),r=e.getBoundingClientRect();const previous=footer.previousElementSibling.getBoundingClientRect();return{right:r.right-c.right,bottom:r.bottom-c.bottom,below:f.top>=previous.bottom-1,inside:c.left>=r.left&&c.right<=r.right+1,overflow:e.scrollWidth>e.clientWidth+1}})`);
        for (const item of geometry) { assert.ok(item.right >= 0 && item.right <= 16); assert.ok(item.bottom >= 0 && item.bottom <= 10); assert.equal(item.below, true); assert.equal(item.inside, true); assert.equal(item.overflow, false); }
        await win.webContents.capturePage(); await delay(200);
        fs.writeFileSync(path.join(out, 'footer-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
      }
      results.push('Both locales and 360/1100 px: bottom-right controls do not overlap content or overflow');
      snapshot.messages[0].text = prompt.repeat(40);
      await publish();
      await until('Boolean(document.querySelector(".nuser-long"))');
      for (const expanded of [false, true]) {
        await js('document.querySelector(".nuser-long").open=' + expanded);
        assert.equal(await js('(()=>{const d=document.querySelector(".nuser-long").getBoundingClientRect(),f=document.querySelector(".nmsg.user .nmessage-footer").getBoundingClientRect();return f.top>=d.bottom-1})()'), true);
        assert.equal(await js('document.querySelector(".nmessage-copy").dataset.copyMessage'), prompt.repeat(40));
      }
      results.push('Long prompt footer follows collapsed or expanded content and retains the complete copy payload');
      const answer = (text, completed, extra = {}) => ({ role: 'assistant', done: true, completedAt: completed,
        stopReason: 'stop', blocks: [{ kind: 'text', index: 0, text, done: true }], ...extra });
      const toolIntro = (text, id, completed) => answer(text, completed, { stopReason: 'toolUse', blocks: [
        { kind: 'text', index: 0, text, done: true },
        { kind: 'toolcall', index: 1, toolCall: { id, name: 'read', arguments: { path: 'fixture.md' } }, done: true },
      ] });
      const footerPayloads = 'Array.from(document.querySelectorAll(".nmsg.ai>.nmessage-footer [data-copy-message]"),e=>e.dataset.copyMessage)';
      async function expectFooters(expected) {
        await until('JSON.stringify(' + footerPayloads + ') === ' + JSON.stringify(JSON.stringify(expected)));
        assert.deepEqual(await js(footerPayloads), expected);
        assert.equal(await js('document.querySelectorAll(".nmsg.ai>.nmessage-footer").length'), expected.length);
      }
      const firstFinal = '第一轮最终结果：已核对两份材料。';
      snapshot = { status: 'idle', execution: { running: false }, messages: [
        { role: 'user', text: '整理两份材料', sentAt },
        toolIntro('中间说明：先读取第一份材料。', 'read-one', completedAt),
        toolIntro('中间说明：继续核对第二份材料。', 'read-two', completedAt + 1000),
        answer(firstFinal, completedAt + 3000),
      ], tools: [
        { id: 'read-one', name: 'read', toolKind: 'read', args: { path: 'first.md' }, state: 'done', after: 1, result: 'first fixture' },
        { id: 'read-two', name: 'read', toolKind: 'read', args: { path: 'second.md' }, state: 'done', after: 2, result: 'second fixture' },
      ] };
      await publish();
      await expectFooters([firstFinal]);
      assert.equal(await js(`document.querySelector('[data-chat-node="message:1"] .nmessage-footer')`), null);
      assert.equal(await js(`document.querySelector('[data-chat-node="message:2"] .nmessage-footer')`), null);
      await click('.nmsg.ai .ntext-copy');
      assert.equal(await copiedText(), firstFinal);
      results.push('Multiple assistant explanations and tools produce no intermediate footer; the completed turn has exactly one final-result copy and time');

      snapshot.messages.push({ role: 'user', text: '再做第二轮', sentAt: completedAt + 4000 },
        answer('第二轮正在输出的正文', 0, { done: false, stopReason: '', blocks: [{ kind: 'text', index: 0, text: '第二轮正在输出的正文', done: false }] }));
      snapshot.status = 'streaming'; snapshot.execution.running = true;
      await publish();
      await until(`document.querySelector('[data-chat-node="message:5"]').textContent.includes("第二轮正在输出")`);
      await expectFooters([firstFinal]);
      assert.equal(await js(`document.querySelector('[data-chat-node="message:5"] .nmessage-footer')`), null);
      results.push('Starting a second turn keeps the first completed result copyable while the live second turn has no footer');

      const secondFinal = '第二轮最终结果：已补充完成。';
      snapshot.messages[5] = answer(secondFinal, completedAt + 8000);
      snapshot.status = 'idle'; snapshot.execution.running = false;
      await publish();
      await expectFooters([firstFinal, secondFinal]);
      assert.deepEqual(await js('Array.from(document.querySelectorAll(".nmsg.ai time"),e=>e.dateTime)'),
        [completedAt + 3000, completedAt + 8000].map(at => new Date(at).toISOString()));
      results.push('Two completed user turns retain one footer and their own persisted completion time each');

      for (const [status, stopReason] of [['unreachable', 'error'], ['incomplete', 'length'], ['aborted', 'aborted'], ['no-output', 'error']]) {
        snapshot.status = status;
        snapshot.messages[5] = answer('第二轮未完成：' + status, completedAt + 8000, { stopReason });
        await publish();
        await until(`document.querySelector('[data-chat-node="message:5"]').textContent.includes(` + JSON.stringify(status) + ')');
        await expectFooters([firstFinal]);
      }
      snapshot.status = 'idle';
      snapshot.messages[5] = toolIntro('准备调用工具，尚无最终结果', 'read-last', completedAt + 8000);
      snapshot.tools.push({ id: 'read-last', name: 'read', toolKind: 'read', args: { path: 'last.md' }, state: 'done', after: 5, result: 'fixture' });
      await publish(); await expectFooters([firstFinal]);
      results.push('Failure, truncation, cancellation and an idle tool-only ending never turn intermediate text into a final-result footer');

      // This projection has a completed tool and a later final text in the SAME
      // visible assistant message. A blanket tool.after >= candidate check is wrong.
      const acc = require('../main/pi-session/event-stream').create();
      const update = event => acc.push(event);
      update({ type: 'message_end', message: { role: 'user', content: '继续完成材料', sentAt } });
      update({ type: 'agent_run_start' });
      update({ type: 'message_start', message: { role: 'assistant' } });
      update({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: '恢复前的已完成部分。' } });
      update({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1, toolCall: { id: 'merged-read', name: 'read', arguments: { path: 'reference.md' } } } });
      update({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', completedAt } });
      update({ type: 'tool_execution_start', toolCallId: 'merged-read', toolName: 'read', args: { path: 'reference.md' } });
      update({ type: 'tool_execution_end', toolCallId: 'merged-read', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: 'Reference' }] } });
      update({ type: 'message_end', message: { role: 'user', content: require('../main/pi-session/output-continuation').continuationPrompt(1, 'length') } });
      update({ type: 'message_start', message: { role: 'assistant' } });
      update({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: '续接后的最终结果。' } });
      update({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', completedAt: completedAt + 10000 } });
      update({ type: 'agent_settled' });
      snapshot = { ...acc.snapshot(), execution: { running: false } };
      assert.equal(snapshot.messages.length, 2);
      assert.equal(snapshot.tools[0].after, 1);
      assert.equal(snapshot.messages[1].blocks.at(-1).text, '续接后的最终结果。');
      await publish();
      await expectFooters(['恢复前的已完成部分。\n\n续接后的最终结果。']);
      assert.equal(await js('document.querySelector(".nmsg.ai time").dateTime'), new Date(completedAt + 10000).toISOString());
      results.push('A real Pi accumulator continuation projection retains its final footer when an earlier completed tool maps to the same visible assistant index');

      for (const runtime of require('../main/agent-runtime/runtime-catalog').runtimes()) {
        const projected = require('../main/pi-session/event-stream').create(), saved = [];
        const taskMessages = require('../main/conversation/task-message-stream.cjs').create(projected.state, row => saved.push(row));
        const full = '我会先查看工作目录，再创作并核验散文文件。';
        const handle = { taskMessageStreaming: true,
          appendTaskMessage(role, text) { projected.push({ type: 'message_end', message: { role, content: text } }); },
          appendTaskRuntimeEvent(item, taskId) {
            if (item.kind === 'task-stream-end') taskMessages.finish(item.streamPrefix);
            else taskMessages.apply(item, taskId);
          }, appendTaskTool(event) { projected.push(event); }, taskExecutionChanged() {} };
        const turn = require('../main/pi-session/controlled-task-turn').create({ task: { id: 'stream-task' },
          spec: { mode: 'dispatch', context: {}, agentId: 'runner:device:' + runtime.id }, scope: {},
          request: async (route, body) => body ? { ref: 'stream-ref' } : { ref: 'stream-ref', engine: runtime.id, status: 'done', seq: 6,
            items: [{ seq: 1, kind: 'say', text: '开始检查材料。' },
              { seq: 2, kind: 'do', callId: 'read', tool: 'read', args: { path: 'fixture.md' } },
              { seq: 3, kind: 'out', callId: 'read', tool: 'read', text: 'Fixture material' },
              ...['我会', '先查看工作目录，再创作并核', '验散文文件。'].map((text, index) =>
                ({ seq: 4 + index, kind: 'say', text, delta: true, streamId: 'answer' }))] } });
        await turn.execute(handle, '写冬天主题散文', []);
        snapshot = { ...projected.snapshot(), status: 'idle', execution: { running: false } };
        await js('window.fixtureTask=' + JSON.stringify({ id: 'stream-task', title: '写冬天主题散文', status: 'in_progress',
          executionContext: { agent: { id: 'runner:device:' + runtime.id } },
          workRouting: { conversationTurn: { conversationId: 'footer', executor: 'dispatch', state: 'completed' } } }) +
          ';SoduWorkAPI.getTask=async()=>fixtureTask;NativeChat.bindTask("stream-task",fixtureTask.title,{persist:false,taskMeta:fixtureTask});void 0;');
        await publish(); await expectFooters([full]);
        await until('document.querySelector("#nchatRuntimeName").textContent===' + JSON.stringify(runtime.displayName));
        assert.equal(await js('NativeChat.sessionInfo().adapterId'), 'pi');
        assert.equal(saved.length, 1); assert.equal(saved[0].sourceAgent.agentId, runtime.id);
        for (const expanded of [true, false]) {
          if (await js('Boolean(document.querySelector("[data-turn-toggle]"))')) {
            const current = await js('document.querySelector("[data-turn-toggle]").getAttribute("aria-expanded")==="true"');
            if (current !== expanded) await click('[data-turn-toggle]');
          }
          await expectFooters([full]);
          assert.equal(await js('Array.from(document.querySelectorAll(".nmsg.ai .ntext")).some(node=>node.textContent===' + JSON.stringify('验散文文件。') + ')'), false);
        }
      }
      results.push('Every registered runtime retains the complete controlled answer and one copy payload with process records expanded or collapsed');
      results.push('The production NativeChat requirement binding shows every assigned runtime while preserving the original local archive identity');

      snapshot.messages = [{ role: 'user', text: 'Today dated prompt', sentAt: Date.now() }, { role: 'assistant', done: true,
        completedAt: Date.now(), blocks: [{ kind: 'text', text: 'Today dated answer' }] }];
      snapshot.status = 'idle'; snapshot.tools = []; snapshot.execution = { running: false };
      await publish();
      await until('document.querySelector(".nmessage-copy").dataset.copyMessage==="Today dated prompt"');
      assert.match(await js('document.querySelector(".nmsg.user time").textContent'), /^\d{2}:\d{2}$/);
      await js('document.querySelector(".nmsg.user time").focus()');
      await delay(180);
      assert.equal(await js('getComputedStyle(document.querySelector(".nmsg.user .nmessage-footer")).opacity'), '1');
      results.push('Today uses hours and minutes; keyboard focus reveals the quiet timestamp row');

      snapshot.messages = [{ role: 'user', text: 'Older undated prompt' }, { role: 'assistant', done: true, blocks: [{ kind: 'text', text: 'Older undated answer' }] }];
      snapshot.status = 'idle'; snapshot.tools = []; snapshot.execution = { running: false };
      await publish();
      await until('document.querySelector(".nmessage-copy").dataset.copyMessage==="Older undated prompt"');
      assert.equal(await js('document.querySelectorAll(".nmsg time").length'), 0);
      assert.equal(await js('document.querySelectorAll(".nmessage-footer button").length'), 2);
      assert.deepEqual(await js('window.errors'), []);
      results.push('Undated historical messages stay undated and copyable');
      fs.writeFileSync(path.join(out, 'footer-report.json'), JSON.stringify({ ok: true, results }, null, 2));
      console.log(JSON.stringify({ ok: true, results }, null, 2));
    } finally { await clipboard.write(priorClipboard); if (win && !win.isDestroyed()) win.destroy(); app.quit(); }
  }).catch(error => { console.error(error); app.exit(1); });
}
