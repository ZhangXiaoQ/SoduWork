'use strict';
// Creates inert authoring files. Does not install, launch servers or send chat.
const fs = require('node:fs'), path = require('node:path');
function scaffold({ out, key, name, nameEn, url, storage = false, category = 'other', entry = 'ui/index.html' }) {
  if (![false,true,'false','true','local','cloud'].includes(storage)) throw Error('storage 必须为 local 或 cloud（兼容 true/false）');
  if (!['office','game','robot','other'].includes(category)) throw Error('请选择有效的即用分类');
  if (!out || !/^[a-z][a-z0-9-]{1,62}$/.test(key || '') || !String(name || '').trim()) throw Error('需要 out、合法 key 和即用名称');
  const page = url ? new URL(url) : null;
  if (page && (!['http:', 'https:'].includes(page.protocol) || page.username || page.password || page.search || page.hash)) throw Error('页面使用不含凭据或查询参数的 HTTP(S) 地址');
  if (!page && (!/^ui\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.html?$/i.test(entry) || entry.split('/').some(part => part.startsWith('.')))) throw Error('包内入口必须是 ui 目录下的 HTML 相对路径');
  const htmlFile = page ? 'ui/index.html' : entry;
  const relative = file => path.posix.relative(path.posix.dirname(htmlFile), 'ui/' + file);
  const target = path.resolve(out);
  if (fs.existsSync(target)) throw Error('输出目录已经存在，请选择新目录');
  const bundled = path.resolve(__dirname, '../sdk/soduwork-app.js');
  const sdk = fs.readFileSync(fs.existsSync(bundled) ? bundled : path.resolve(__dirname, '../../../client/sdk/soduwork-app.js'));
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escape(name) + '</title><style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;font:15px system-ui;background:light-dark(#fafafa,#10131a);color:light-dark(#151923,#e8ecf2)}main{max-width:760px;margin:auto;padding:32px 24px}h1{font-size:24px}textarea{width:100%;min-height:140px;padding:12px;font:inherit;border:0;border-radius:6px;background:light-dark(#eee,#242a36);color:inherit}[role=button]{display:inline-block;padding:10px 18px;background:light-dark(#151923,#e8ecf2);color:light-dark(#fff,#10131a);border-radius:6px;cursor:pointer}[aria-disabled=true]{opacity:.5;cursor:wait}[role=status]{white-space:pre-wrap}small{opacity:.7}</style>' +
    '<main><h1>' + escape(name) + '</h1><p>描述希望完成的工作，由当前即用对话处理。</p><textarea id="description" aria-label="工作描述"></textarea><p><div id="submit" role="button" tabindex="0">交给 SoduWork</div></p><p id="status" role="status"></p><small id="refresh">等待应用数据刷新</small></main>' +
    '<script src="' + relative('soduwork-app.js') + '"></script><script src="' + relative('app.js') + '"></script></html>';
  const script = `'use strict';
const input = document.getElementById('description'), submit = document.getElementById('submit'), status = document.getElementById('status');
let busy = false, attempt;
submit.onclick = async () => {
  if (busy || !input.value.trim()) return;
  attempt ||= { text: input.value.trim(), requestId: soduWorkApp.createRequestId() };
  busy = true; submit.setAttribute('aria-disabled', 'true'); input.disabled = true;
  try {
    await soduWorkApp.chat.expand();
    const receipt = await soduWorkApp.chat.send(attempt);
    if (!receipt.ok) throw Error(receipt.reason || '发送失败');
    status.textContent = '任务已交给当前即用对话，请在右侧查看结果。'; input.value = ''; attempt = null;
  } catch (error) { status.textContent = error.message + '；输入已保留。超时请先核对右侧对话。'; }
  finally { busy = false; input.disabled = false; submit.setAttribute('aria-disabled', 'false'); }
};
input.oninput = () => { if (!busy) attempt = null; };
submit.onkeydown = event => { if (['Enter',' '].includes(event.key)) { event.preventDefault(); submit.click(); } };
window.refreshCount = 0;
soduWorkApp.events.onRefresh(() => {
  // Replace with an authorized business readback; a refresh event is not completion evidence.
  document.getElementById('refresh').textContent = '收到即用壳刷新通知（' + (++window.refreshCount) + '）';
});
`;
  const body = { template: 'app', key, name: String(name).trim(), version: '0.1.0', appCategory:category,
    locales: {
      'zh-CN': { name: String(name).trim(), description: String(name).trim() + '：通过页面和当前即用对话完成工作', ui: { main: { title: String(name).trim() } } },
      'en-US': { name: String(nameEn || key.replace(/-/g, ' ')).trim(), description: 'Complete work through this app and its SoduWork conversation', ui: { main: { title: String(nameEn || key.replace(/-/g, ' ')).trim() } } },
    },
    description: String(name).trim() + '：通过页面和当前即用对话完成工作',
    instructions: '根据用户输入完成当前即用的工作。使用真实业务数据和已有授权能力，验证并报告实际结果。不要把消息接收回执当作任务完成。',
    inputs: [], setup: { preferences: [] }, mcpServers: [], runtimeCapabilities: [], evaluationInstruction: '', evaluationCriteria: [],
    ui: { contributions: [{ id: 'main', title: String(name).trim(), slot: 'workspace.navigation',
      source: { ...(page ? { type: 'external', url: page.href } : { type: 'package', entry }), openMode: 'workspace',
        bridge: { version: 1, capabilities: ['conversation.send', 'composer.control'] } } }] },
    resources: [htmlFile, 'ui/soduwork-app.js', 'ui/app.js'].map(file => ({ path: file, kind: 'ui' })),
  };
  fs.mkdirSync(path.join(target, 'ui'), { recursive: true });
  if(storage===true || ['true','local','cloud'].includes(storage)){
    body.jiyong={version:1,storage:{location:storage==='cloud'?'cloud':'local'},parameters:[],collections:[{key:'notes',indexes:['status']}],...(!page?{mcp:{server:'soduwork-jiyong',bindings:[]}}:{}),initialization:{script:'assets/data-init.json'}};
    body.mcpServers=page?[]:['soduwork-jiyong'];
    body.ui.contributions[0].source.bridge.capabilities.push('data.read','data.write',...(!page?['mcp.connect']:[]));
    body.resources.push({path:'assets/data-init.json',kind:'asset'});
  }
  fs.mkdirSync(path.join(target, '.soduwork'));
  for (const [file, content] of Object.entries({ [htmlFile]: html, 'ui/app.js': script, 'ui/soduwork-app.js': sdk,
    ...(body.jiyong ? { 'assets/data-init.json': JSON.stringify({ schemaVersion: 1, migrations: [] }, null, 2) } : {}),
    'soduwork-plugin-draft.json': JSON.stringify(body, null, 2),
    ...(body.jiyong ? {'assets/data-init.json':JSON.stringify({schemaVersion:1,migrations:[{version:1,seed:[]}]},null,2)} : {}),
    '.soduwork/delivery.json': JSON.stringify({ schemaVersion: 1, deliverables: [{ path: 'soduwork-plugin-draft.json', kind: 'file', title: String(name).trim() + '应用草稿', primary: true }] }, null, 2) })) {
    fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    fs.writeFileSync(path.join(target, file), content, { flag: 'wx' });
  }
  return { out: target, draft: path.join(target, 'soduwork-plugin-draft.json'), page: page?.href || entry, installed: false, runtimeTested: false };
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--out', '--key', '--name', '--name-en', '--url', '--entry', '--storage', '--category'].includes(args[i]) || args[i + 1] == null) throw Error('用法：--out 新目录 --key app-key --name 即用名称 --name-en EnglishName [--entry ui/index.html | --url HTTP(S)地址]');
      options[args[i] === '--name-en' ? 'nameEn' : args[i].slice(2)] = args[i + 1];
    }
    console.log(JSON.stringify(scaffold(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { scaffold };
