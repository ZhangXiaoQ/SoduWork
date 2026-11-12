'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http');
const runtime = require('../main/platform-connections/runtime.cjs');
const connections = require('../main/platform-connections/index.cjs');
const feishu = require('../main/platform-connections/feishu.cjs');
const { identity, sessions } = require('./helpers/platform-session-fixture.cjs');
function temporary(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-connection-test-'));
  t.after(() => { assert.equal(path.dirname(folder), path.resolve(os.tmpdir()));
    assert.ok(path.basename(folder).startsWith('soduwork-connection-test-')); fs.rmSync(folder, { recursive: true, force: true }); });
  return { getPath: () => folder };
}
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return server;
}
test('scope binds the SoduWork account: roaming environments keep one identity and missing ownership is rejected', () => {
  assert.notEqual(runtime.scope(identity()), runtime.scope(identity('two')));
  // Same-account Hub and enrollment changes preserve account ownership.
  assert.equal(runtime.scope(identity()), runtime.scope({ ...identity(), hub: 'http://127.0.0.1:9081' }));
  assert.equal(runtime.scope(identity()),
    runtime.scope({ ...identity(), clientId: 'device-two', session: sessions().otherDevice }));
  assert.throws(() => runtime.scope({ ...identity(), clientId: 'another' }));
  assert.throws(() => runtime.scope({}));
});
test('state paths reject traversal and directory junctions before writing', t => {
  const app = temporary(t), outside = temporary(t);
  assert.throws(() => runtime.paths(app, 'wecom', '../escape'));
  const root = runtime.base(app); fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(outside.getPath(), path.join(root, 'accounts'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => runtime.paths(app, 'wecom', runtime.scope(identity())));
  assert.deepEqual(fs.readdirSync(outside.getPath()), []);
});
test('authorization hints accept official pages without reflecting secrets', () => {
  const value = connections.loginHint('dingtalk', 'https://login.dingtalk.com/device user_code: ABCD-EFGH');
  assert.equal(value.authUrl, 'https://login.dingtalk.com/device'); assert.equal(value.userCode, 'ABCD-EFGH');
  for (const url of ['https://dingtalk.com.evil.test/a', 'https://evil.test/?target=dingtalk.com',
    'https://secret@login.dingtalk.com/a', 'https://login.dingtalk.com/a?access_token=private']) {
    assert.equal(connections.loginHint('dingtalk', url).authUrl, '');
  }
  assert.match(connections.loginHint('wecom', 'https://work.weixin.qq.com/ai/qc/gen?scode=fixture').authUrl, /^https:/);
  assert.equal(connections.loginHint('wecom', 'https://login.dingtalk.com/a').authUrl, '');
});
test('only explicit official authorization status counts as connected', () => {
  assert.equal(connections.authResult('wecom', { code: 0, output: 'authorized\n' }), true);
  assert.equal(connections.authResult('wecom', { code: 0, output: 'unauthorized\n' }), false);
  assert.equal(connections.authResult('dingtalk', { code: 0, output: '{"authenticated":false}' }), false);
  assert.throws(() => connections.authResult('dingtalk', { code: 0, output: '{"success":true}' }));
  assert.throws(() => connections.authResult('dingtalk', { code: 0, output: '{"success":false,"authenticated":true}' }));
  assert.throws(() => connections.authResult('dingtalk', { code: 0, output: '{"authenticated":false,"reason":"dek_missing","message":"sensitive fixture"}' }),
    error => error.message.includes('凭据存储') && !error.message.includes('sensitive'));
  assert.throws(() => connections.authResult('wecom', { code: 1, output: 'authorized' }));
});
test('IPC checks the invoking frame rather than trusting its parent window', () => {
  const local = require('node:url').pathToFileURL(path.resolve(__dirname, '../desk.html')).href;
  assert.equal(connections.trustedSender({ sender: { getURL: () => local } }), true);
  assert.equal(connections.trustedSender({ sender: { getURL: () => local }, senderFrame: { url: 'https://untrusted.test' } }), false);
  assert.equal(connections.trustedSender({ sender: { getURL: () => 'file:///C:/untrusted.html' } }), false);
});
test('credentials use fixed HTTPS endpoint and never return tokens or provider diagnostics', async () => {
  assert.equal(await feishu.verifyCredentials('cli_fixture', 'fixture-secret', async (url, options) => {
    assert.equal(new URL(url).hostname, 'open.feishu.cn'); assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { app_id: 'cli_fixture', app_secret: 'fixture-secret' });
    return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'private-fixture-token' }) };
  }), true);
  await assert.rejects(feishu.verifyCredentials('cli_fixture', 'fixture-secret', async () => ({
    ok: false, json: async () => ({ code: 1, message: 'fixture-secret' }),
  })), error => !error.message.includes('fixture-secret'));
});
test('credential persistence calls the OS encryption interface and refuses unavailable keystore', t => {
  const app = temporary(t), scope = runtime.scope(identity());
  const safe = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test-secure',
    encryptString: value => Buffer.from(value).map(x => x ^ 137), decryptString: value => Buffer.from(value).map(x => x ^ 137).toString() };
  const value = { appId: 'cli_fixture', appSecret: 'fixture-secret', bearer: 'fixture-bearer' };
  feishu.save(app, scope, value, safe);
  const stored = fs.readFileSync(path.join(runtime.paths(app, 'feishu', scope).account, 'connection.json'), 'utf8');
  assert.ok(!stored.includes(value.appSecret)); assert.ok(!stored.includes(value.bearer));
  assert.deepEqual(feishu.read(app, scope, safe), value);
  assert.throws(() => feishu.save(app, scope, value, { isEncryptionAvailable: () => false }));
});
test('proxy enforces bearer and current user, then forwards only MCP headers', async t => {
  let forwarded = 0, current = identity(); const app = temporary(t);
  const upstream = await serve(t, (req, res) => {
    forwarded++; assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers['mcp-session-id'], 'fixture-session');
    res.setHeader('Content-Type', 'application/json'); res.end('{"result":{"tools":[]}}');
  });
  const proxy = feishu.createProxy(upstream.address().port, runtime.platformScope(app, identity(), 'feishu'), { bearer: 'fixture-bearer' }, app, async () => current);
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const url = 'http://127.0.0.1:' + proxy.address().port + '/mcp';
  assert.equal((await fetch(url)).status, 401);
  const opts = { headers: { Authorization: 'Bearer fixture-bearer', cookie: 'do-not-forward', 'mcp-session-id': 'fixture-session' } };
  assert.equal((await fetch(url, opts)).status, 200); assert.equal(forwarded, 1);
  current = identity('two'); assert.equal((await fetch(url, opts)).status, 403); assert.equal(forwarded, 1);
});
test('real Runner tool probe precedes enabling MCP and preserves unrelated settings', async t => {
  const calls = [], old = { id: 'existing', name: 'other', headers: { Authorization: '***' } };
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') return { ok: true, json: async () => ({ personal: [old], company: [], enabledCompany: ['company'] }) };
    if (url.endsWith('/probe')) return { ok: true, json: async () => ({ ok: true, tools: ['read-doc'] }) };
    assert.ok(url.endsWith('/upsert'));
    const body = JSON.parse(options.body); assert.deepEqual(Object.keys(body).sort(), ['original','server']);
    assert.equal(body.original,null);assert.equal(body.server.name,'feishu');assert.ok(!JSON.stringify(body).includes(old.id));
    return { ok: true, json: async () => ({ ok: true }) };
  });
  assert.equal((await feishu.register(identity(), runtime.scope(identity()), { port: 1234, bearer: 'fixture' })).toolCount, 1);
  assert.deepEqual(calls.map(x => x.options.method), ['GET', 'POST', 'POST']);
});
test('failed tool probe does not enable or overwrite any connection', async t => {
  let writes = 0;
  t.mock.method(global, 'fetch', async (_url, options) => {
    if (options.method === 'GET') return { ok: true, json: async () => ({ personal: [], company: [] }) };
    if (_url.endsWith('/upsert') || options.method === 'PUT') writes++;
    return { ok: false, json: async () => ({ detail: 'credential-echo' }) };
  });
  await assert.rejects(feishu.register(identity(), runtime.scope(identity()), { port: 1234, bearer: 'fixture' }),
    error => !error.message.includes('credential-echo'));
  assert.equal(writes, 0);
});
test('service status retains preparation progress and blocks unconnected execution', async t => {
  const app = temporary(t); let release;
  t.mock.method(runtime, 'inspect', async () => ({ status: 'missing', label: '钉钉' }));
  t.mock.method(runtime, 'prepare', () => new Promise(resolve => { release = resolve; }));
  const service = connections.create({ app, identityOf: async () => identity(), safeStorage: {}, shell: {} });
  const preparing = service.prepare('dingtalk');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await service.status('dingtalk')).state, 'preparing');
  release(); await preparing;
  await assert.rejects(service.guide('dingtalk'), /连接账号/);
  assert.equal((await service.status('dingtalk')).connected, false);
});
test('simultaneous connection requests launch one authorization process', async t => {
  const app=temporary(t);let starts=0;
  t.mock.method(runtime,'inspect',async()=>({status:'installed',label:'钉钉'}));
  t.mock.method(runtime,'launch',async()=>{starts++;return{completion:new Promise(()=>{}),cancel(){}}});
  const service=connections.create({app,identityOf:async()=>identity(),safeStorage:{},shell:{}});
  t.after(()=>service.close());
  await Promise.all([service.connect('dingtalk'),service.connect('dingtalk')]);
  assert.equal(starts,1);assert.equal((await service.status('dingtalk')).state,'connecting');
});
test('cancellation during CLI launch also stops the child when launch completes', async t => {
  const app=temporary(t);let launchReady,cancelled=0;
  t.mock.method(runtime,'inspect',async()=>({status:'installed',label:'钉钉'}));
  t.mock.method(runtime,'launch',()=>new Promise(resolve=>{launchReady=resolve}));
  const service=connections.create({app,identityOf:async()=>identity(),safeStorage:{},shell:{}});
  t.after(()=>service.close());
  const pending=service.connect('dingtalk');await new Promise(r=>setImmediate(r));
  await service.cancel('dingtalk');launchReady({completion:new Promise(()=>{}),cancel(){cancelled++}});
  await pending;assert.equal(cancelled,1);assert.equal((await service.status('dingtalk')).state,'needs_auth');
});
test('external launchers are immutable real files outside the Electron application', async t => {
 const app=temporary(t),entry=runtime.entry(app,'dingtalk');
 assert.ok(entry.startsWith(app.getPath()+path.sep));
 assert.ok(fs.existsSync(path.join(path.dirname(entry),'prepare-dingtalk.py')));
 const result=await runtime.execute(runtime.node(),[entry,'info'],{cwd:app.getPath()}).completion;
 assert.equal(result.code,0);assert.equal(JSON.parse(result.output).version,'1.0.61');
 assert.equal(runtime.entry(app,'dingtalk'),entry);
 fs.writeFileSync(entry,'tampered');assert.throws(()=>runtime.entry(app,'dingtalk'),/已被修改/);
});

test('each platform routes authentication, cancellation and status to its own provider', async t => {
 const app=temporary(t),calls=[],jobs=new Map();
 t.mock.method(runtime,'inspect',async(_app,key)=>({status:'installed',label:runtime.LABELS[key]}));
 t.mock.method(feishu,'restore',async()=>({connected:false}));
 t.mock.method(feishu,'connect',async(_app,_identity,_scope,options)=>{
  assert.ok(options.signal instanceof AbortSignal);assert.equal(typeof options.progress,'function');
  calls.push({key:'feishu'});return{connected:true};
 });
 t.mock.method(runtime,'launch',async(_app,key,scope,args,options)=>{
  calls.push({key,scope,args});
  if(args[1]==='show'||args[1]==='status')return{completion:Promise.resolve({code:0,output:key==='wecom'?'unauthorized':'{"authenticated":false}'})};
  let finish;const completion=new Promise(resolve=>{finish=resolve});
  jobs.set(key,{options,finish,cancelled:false});
  return{completion,cancel(){jobs.get(key).cancelled=true;finish({code:1,output:''});}};
 });
 const urls=[];
 const service=connections.create({app,identityOf:async()=>identity(),safeStorage:{},shell:{async openExternal(url){urls.push(new URL(url).hostname);}}});
 t.after(()=>service.close());
 await service.connect('wecom');await service.connect('dingtalk');
 assert.deepEqual(calls[0].args.slice(0,5),['auth','init','--noninteractive','--no-browser','--output-qrcode']);
 assert.match(calls[0].args[5],/^login-[a-f0-9-]+\.png$/);
 assert.deepEqual(calls[1].args,['auth','login','--device','--no-browser','--format','json']);
 jobs.get('wecom').options.onOutput('https://open.feishu.cn/auth https://login.dingtalk.com/device');
 assert.equal((await service.status('wecom')).authUrl,'');
 jobs.get('wecom').options.onOutput('https://work.weixin.qq.com/ai/qc/gen?scode=fixture');
 jobs.get('dingtalk').options.onOutput('https://login.dingtalk.com/device user_code: ABCD-EFGH');
 await service.openAuth('wecom');await service.openAuth('dingtalk');
 assert.deepEqual(urls,['work.weixin.qq.com','login.dingtalk.com']);
 await service.connect('feishu');await new Promise(r=>setImmediate(r));
 assert.equal((await service.status('feishu')).connected,true);
 for(const key of ['wecom','dingtalk']){const value=await service.status(key);assert.equal(value.provider,key);assert.equal(value.connected,false);assert.equal(value.state,'awaiting_user');}
 await service.cancel('wecom');
 assert.equal(jobs.get('wecom').cancelled,true);assert.equal(jobs.get('dingtalk').cancelled,false);
 assert.equal((await service.status('dingtalk')).state,'awaiting_user');
 await assert.rejects(service.openAuth('wecom'),/失效/);
});


test('official WeCom QR is isolated, bounded and removed on cancellation', async t => {
 const app=temporary(t),qr=require('../main/platform-connections/wecom-qr.cjs');
 const one=qr.create(app,runtime.scope(identity())),two=qr.create(app,runtime.scope(identity('two')));
 assert.notEqual(one.cwd,two.cwd);assert.notEqual(one.name,two.name);
 for(const [item,owner] of [[one,identity()],[two,identity('two')]]){
  const paths=runtime.paths(app,'wecom',runtime.scope(owner));
  assert.equal(runtime.inside(paths.root,item.cwd),true);
  assert.equal(runtime.inside(paths.account,item.cwd),false,'官方 CLI 禁止二维码输出到凭据目录');
 }
 assert.equal(one.read(),'');
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVZkAAAAASUVORK5CYII=','base64');
 const file=path.join(one.cwd,one.name);
 fs.writeFileSync(file,'private credential data must not be returned');assert.equal(one.read(),'');
 fs.writeFileSync(file,Buffer.concat([png,Buffer.alloc(256*1024)]));assert.equal(one.read(),'');
 fs.writeFileSync(file,png);assert.equal(one.read(),'data:image/png;base64,'+png.toString('base64'));
 assert.equal(two.read(),'');one.dispose();assert.equal(fs.existsSync(file),false);assert.equal(one.read(),'');two.dispose();
});

test('WeCom service returns the actual official PNG and clears it on cancel and account switch',async t=>{
 const app=temporary(t),calls=[];let current=identity();
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVZkAAAAASUVORK5CYII=','base64');
 t.mock.method(runtime,'inspect',async()=>({status:'installed',label:'企业微信'}));
 t.mock.method(runtime,'launch',async(_app,key,scope,args,options)=>{
  const file=path.join(options.cwd,args.at(-1));
  assert.equal(runtime.inside(runtime.paths(app,key,scope).account,file),false,'重连必须遵守官方凭据目录沙箱');
  calls.push(file);fs.writeFileSync(file,png);
  options.onOutput('https://work.weixin.qq.com/ai/qc/gen?scode=fixture');
  let finish;return{completion:new Promise(resolve=>{finish=resolve;}),cancel(){finish({code:1});}};
 });
 const service=connections.create({app,identityOf:async()=>current,safeStorage:{},shell:{}});t.after(()=>service.close());
 await service.connect('wecom');assert.match((await service.status('wecom')).qrCode,/^data:image\/png/);
 await service.cancel('wecom');assert.equal((await service.status('wecom')).qrCode,'');assert.equal(fs.existsSync(calls[0]),false);
 await service.connect('wecom');current=identity('two');assert.equal((await service.status('wecom')).qrCode,'');assert.equal(fs.existsSync(calls[1]),false);
});

test('ordinary native platform guidance reuses only the owning connected account without probing or login', async t => {
  const app = temporary(t); let current = identity(), launches = 0;
  t.mock.method(runtime, 'inspect', async () => ({ status: 'installed' }));
  t.mock.method(runtime, 'launch', async (_app, key, _scope, args) => {
    launches++; assert.deepEqual(args, ['auth', 'show', '--status']);
    assert.equal(key, 'wecom');
    return { completion: Promise.resolve({ code: 0, output: 'authorized' }) };
  });
  const service = connections.create({ app, identityOf: async () => current, safeStorage: {}, shell: {} });
  t.after(() => service.close());
  const owner = runtime.scope(current);
  assert.equal(await service.conversationGuide(owner), '');
  assert.equal(launches, 0);
  await service.refresh('wecom');
  const guide = await service.conversationGuide(owner);
  assert.match(guide, /CLI/); assert.match(guide, /--state/); assert.match(guide, /审批/);
  assert.equal(launches, 1, 'chat guidance must not call auth or business APIs');
  assert.doesNotMatch(guide, /钉钉/);
  current = identity('two');
  assert.equal(await service.conversationGuide(owner), '');
  assert.equal(await service.conversationGuide(runtime.scope(current)), '');
  assert.equal(launches, 1);
});

test('WeCom QR preview refuses a linked directory and never exposes another account file', t => {
 const app=temporary(t),outside=temporary(t),qr=require('../main/platform-connections/wecom-qr.cjs');
 const scope=runtime.scope(identity()),p=runtime.paths(app,'wecom',scope);
 fs.symlinkSync(outside.getPath(),path.join(p.root,'auth-previews'),process.platform==='win32'?'junction':'dir');
 assert.throws(()=>qr.create(app,scope));
 assert.deepEqual(fs.readdirSync(outside.getPath()),[]);
});

test('WeCom QR attempts share no files and disposing an old attempt preserves the new attempt', t => {
 const app=temporary(t),qr=require('../main/platform-connections/wecom-qr.cjs'),scope=runtime.scope(identity());
 const old=qr.create(app,scope),next=qr.create(app,scope);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVZkAAAAASUVORK5CYII=','base64');
 assert.equal(old.cwd,next.cwd);assert.notEqual(old.name,next.name);
 fs.writeFileSync(path.join(old.cwd,old.name),png);fs.writeFileSync(path.join(next.cwd,next.name),png);
 old.dispose();assert.equal(old.read(),'');assert.match(next.read(),/^data:image\/png;base64,/);
 assert.equal(fs.existsSync(path.join(next.cwd,next.name)),true);next.dispose();
});
