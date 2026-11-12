'use strict';
// A per-turn revocable loopback lease. The agent never receives the stored ukey.
const http = require('node:http'), https = require('node:https'), crypto = require('node:crypto');
async function create(connection) {
  const nonce = crypto.randomBytes(32).toString('hex'), target = new URL(connection.url), active = new Set();
  let closed = false;
  const lifetime = new AbortController();
  const server = http.createServer(async (request, response) => {
    const deny = (code, message) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: message })); };
    const view = request.url === '/app-view/inspect' || request.url === '/app-view/shot';
    if (closed || (!view && request.url !== '/mcp') || request.headers.origin || request.headers.authorization !== 'Bearer ' + nonce || !['POST','GET','DELETE'].includes(request.method)) return deny(403, '应用连接授权无效');
    let current;
    try {
      await connection.authorize?.();
      if (closed) throw Error();
      current = connection.readCurrent();
      if (current.revision !== connection.revision || current.token !== connection.token) throw Error();
    } catch (_) { return deny(401, '应用接入凭据、账号或安装授权已变化，请检查应用接入配置'); }
    if (view) {
      if (request.method !== 'GET' || typeof connection.inspect !== 'function') return deny(403, '当前即用不支持只读查看');
      return void Promise.resolve().then(() => connection.inspect(request.url.endsWith('/shot') ? 'shot' : 'inspect')).then(result => {
        const now = connection.readCurrent();
        if (closed || now.revision !== connection.revision || now.token !== connection.token) throw Error();
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(result));
      }).catch(() => { if (!response.headersSent) deny(409, '即用页面或授权已变化，无法查看'); });
    }
    if (connection.invoke) {
      if (request.method !== 'POST') return deny(405, '即用 MCP 仅接受 POST');
      let size = 0, chunks = [];
      try {
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 1024 * 1024) throw Error('请求过大');
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = await connection.invoke(body);
        const now = connection.readCurrent();
        if (closed || now.revision !== connection.revision || now.token !== connection.token) throw Error('授权已变化');
        response.writeHead(result == null ? 202 : 200, {'Content-Type':'application/json','Cache-Control':'no-store'});
        response.end(result == null ? '' : JSON.stringify(result));
      } catch (_) { if (!response.headersSent) deny(400,'即用 MCP 请求失败，请检查参数或重新发送'); }
      return;
    }
    if (connection.bindings) {
      try { await require('../jiyong-mcp-bindings.cjs').proxy(request,response,connection,current,lifetime.signal); }
      catch (_) { if (!response.headersSent) deny(502,'即用 MCP 参数或服务响应无效'); else response.destroy(); }
      return;
    }
    const headers = { Authorization: 'Bearer ' + current.token };
    for (const key of ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) if (request.headers[key]) headers[key] = request.headers[key];
    const upstream = (target.protocol === 'https:' ? https : http).request(target, { method: request.method, headers, timeout: 300000 }, reply => {
      const forwarded = {};
      for (const key of ['content-type', 'mcp-session-id', 'cache-control']) if (reply.headers[key]) forwarded[key] = reply.headers[key];
      require('./app-mcp-change.cjs').observe(reply,connection,()=>closed);
      response.writeHead(reply.statusCode, forwarded); reply.pipe(response);
    });
    active.add(upstream); let size = 0;
    request.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) upstream.destroy(); });
    request.pipe(upstream);
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!response.headersSent) deny(502, '应用 MCP 连接失败'); else response.destroy(); });
    upstream.on('close', () => active.delete(upstream));
    response.on('close', () => upstream.destroy());
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  return { url: 'http://127.0.0.1:' + server.address().port + '/mcp', token: nonce,
    cleanup() { closed = true; lifetime.abort(); active.forEach(request => request.destroy()); server.closeAllConnections(); server.close(); } };
}
module.exports = { create };
