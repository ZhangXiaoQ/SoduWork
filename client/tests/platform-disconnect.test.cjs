'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const runtime = require('../main/platform-connections/runtime.cjs');
const life = require('../main/platform-connections/account-lifecycle.cjs');
const connections = require('../main/platform-connections/index.cjs');
const feishu = require('../main/platform-connections/feishu.cjs');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

for (const authenticated of [true,false]) test('interrupted DingTalk browser completion is reconciled from CLI status: '+authenticated,async t=>{
  const f=fixture(t),scope=runtime.platformScope(f.app,f.state.identity,'dingtalk',true);
  life.begin(f.app,'dingtalk',scope,false);
  let calls=0;t.mock.method(runtime,'launch',async (_app,provider,owner,args)=>{
    assert.equal(provider,'dingtalk');assert.equal(owner,scope);
    assert.deepEqual(args,['auth','status','--format','json']);calls++;
    return {completion:Promise.resolve({code:0,output:JSON.stringify({success:true,authenticated})}),cancel(){}};
  });
  const results=await Promise.all(Array.from({length:64},()=>f.service.refresh('dingtalk')));
  assert.equal(calls,1);assert.ok(results.every(row=>row.connected===authenticated));
  assert.equal(life.read(f.app,'dingtalk',scope).connecting,false);
});

test('a failed Feishu registration permits a later check without another QR consent',async t=>{
  const f=fixture(t);let attempts=0,restores=0;
  t.mock.method(feishu,'connect',async()=>{attempts++;throw Object.assign(Error('Conflict'),{conflictId:'other'})});
  t.mock.method(feishu,'restore',async()=>{restores++;return {connected:true}});
  await f.service.connect('feishu');await turn();
  const failed=await f.service.status('feishu');assert.equal(failed.state,'error');assert.equal(failed.conflictId,'other');
  const result=await f.service.refresh('feishu');assert.equal(result.connected,true);assert.equal(result.conflictId,'');
  assert.equal(attempts,1);assert.equal(restores,1);
});

test('DingTalk verifies a persisted profile after a nonzero login exit instead of repeating consent',async t=>{
  const f=fixture(t),calls=[];
  t.mock.method(runtime,'launch',async (_app,key,_scope,args)=>{
    assert.equal(key,'dingtalk');calls.push(args[1]);
    return {completion:Promise.resolve(args[1]==='login'?{code:1,output:''}:
      {code:0,output:'{"success":true,"authenticated":true}'}),cancel(){}};
  });
  await f.service.connect('dingtalk');await turn();
  const row=await f.service.status('dingtalk');
  assert.equal(row.connected,true);assert.match(row.message,/本机已有/);assert.deepEqual(calls,['login','status']);
});

test('Feishu reuses a scoped registration only after a live credential proof; upsert preserves the original revision',async t=>{
  const scope=runtime.scope(identity()),url='http://127.0.0.1:23456/mcp';
  const row={id:'previous-'+scope.slice(0,23),name:'feishu',type:'http',url,headers:{Authorization:'••••'}};
  let accepted=false,writes=0,closed=0;
  t.mock.method(global,'fetch',async (target,options)=>{
    if(options.method==='GET')return {ok:true,json:async()=>({personal:[row],company:[]})};
    const body=JSON.parse(options.body);
    if(target.endsWith('/probe')){
      if(body.url.endsWith('/proof'))assert.equal(body.headers.Authorization,'••••');
      return {ok:true,json:async()=>({tools:['read']})};
    }
    assert.ok(target.endsWith('/upsert'));assert.deepEqual(body.original,row);assert.equal(body.server.id,row.id);
    writes++;return {ok:true,json:async()=>({ok:true})};
  });
  const register=()=>feishu.register(identity(),scope,{port:23456,bearer:'fixture'},async()=>{},
    ()=>({url:url+'/proof',confirmed:()=>accepted,close:()=>{closed++}}));
  await assert.rejects(register(),e=>e.conflictId===row.id);assert.equal(writes,0);
  accepted=true;assert.equal((await register()).registrationId,row.id);assert.equal(writes,1);assert.equal(closed,2);
  row.id='foreign';await assert.rejects(register(),e=>e.conflictId==='foreign');assert.equal(writes,1);assert.equal(closed,2);
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-disconnect-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const app = { getPath: () => root }, state = { identity: identity(), calls: [], stopped: 0 };
  t.mock.method(runtime, 'inspect', async (_app, key) => ({ status: 'installed', label: runtime.LABELS[key] }));
  t.mock.method(runtime, 'launch', async (_app, key, scope, args) => {
    state.calls.push({ key, scope, args });
    if (args[1] === 'init' || args[1] === 'login') fs.writeFileSync(path.join(runtime.paths(app, key, scope).account, 'auth.fixture'), 'new-auth');
    return { completion: Promise.resolve({ code: 0, output: key === 'wecom' ? 'authorized' : '{"authenticated":true}' }),
      cancel() { state.stopped++; } };
  });
  const options = { app, identityOf: async () => state.identity, safeStorage: {}, shell: {} };
  const service = connections.create(options);
  t.after(() => service.close());
  return { root, app, state, options, service };
}
for (const key of ['wecom', 'dingtalk']) test(key + ': local disconnect persists, keeps runtime/other owners and explicitly reconnects', async t => {
  const f = fixture(t), scope = runtime.platformScope(f.app, f.state.identity, key);
  const p = runtime.paths(f.app, key, scope), auth = path.join(p.account, 'auth.fixture');
  fs.writeFileSync(auth, 'old-auth');
  const installed = path.join(p.prefix, 'installed.fixture'); fs.writeFileSync(installed, 'runtime');
  const other = runtime.paths(f.app, key, runtime.platformScope(f.app, identity('two'), key)).account;
  fs.writeFileSync(path.join(other, 'auth.fixture'), 'other-auth');
  assert.equal((await f.service.refresh(key)).connected, true);
  assert.match(await f.service.conversationGuide(runtime.scope(f.state.identity)), /CLI/);
  const before = f.state.calls.length;
  const result = await f.service.disconnect(key);
  assert.equal(result.ok, true); assert.equal(result.state, 'disconnected'); assert.equal(result.disconnected, true);
  assert.equal(fs.existsSync(auth), false); assert.equal(fs.readFileSync(installed, 'utf8'), 'runtime');
  assert.equal(fs.readFileSync(path.join(other, 'auth.fixture'), 'utf8'), 'other-auth');
  assert.equal(await f.service.conversationGuide(runtime.scope(f.state.identity)), '');
  assert.equal((await f.service.refresh(key)).connected, false); assert.equal(f.state.calls.length, before);
  const reopened = connections.create(f.options); t.after(() => reopened.close());
  assert.equal((await reopened.refresh(key)).disconnected, true); assert.equal(f.state.calls.length, before);
  await reopened.connect(key); await turn(); await turn();
  assert.equal((await reopened.refresh(key)).connected, true);
  assert.equal(fs.readFileSync(auth, 'utf8'), 'new-auth');
  assert.ok(f.state.calls.every(call => !call.args.includes('logout')), 'no remote revoke command is called');
});
test('late CLI launch and auth completion cannot revive a disconnected account', async t => {
  const f = fixture(t), launch = deferred(), complete = deferred(); let cancelled = 0;
  t.mock.method(runtime, 'launch', () => launch.promise);
  await f.service.connect('wecom');
  const stopping = f.service.disconnect('wecom'); await turn();
  const scope = runtime.platformScope(f.app, f.state.identity, 'wecom');
  assert.equal(life.read(f.app, 'wecom', scope).disconnected, true);
  launch.resolve({ completion: complete.promise, cancel() { cancelled++; complete.resolve({ code: 0, output: 'authorized' }); } });
  const result = await stopping;
  assert.equal(result.ok, true); assert.ok(cancelled > 0);
  assert.equal((await f.service.status('wecom')).connected, false);
  assert.equal(await f.service.conversationGuide(runtime.scope(f.state.identity)), '');
});
test('a late successful refresh is cancelled and cannot undo the persistent fence', async t => {
  const f = fixture(t), complete = deferred(); let cancelled = 0;
  t.mock.method(runtime, 'launch', async () => ({ completion: complete.promise, cancel() { cancelled++; complete.resolve({ code: 0, output: 'authorized' }); } }));
  const checking = f.service.refresh('wecom'); await turn();
  const result = await f.service.disconnect('wecom');
  assert.equal(result.ok, true); assert.equal(cancelled, 1);
  assert.equal((await checking).connected, false);
  assert.equal((await f.service.refresh('wecom')).disconnected, true);
});
test('cleanup failure stays visibly disconnected and can be retried without following links', async t => {
  const f = fixture(t), scope = runtime.platformScope(f.app, f.state.identity, 'wecom');
  const p = runtime.paths(f.app, 'wecom', scope), outside = path.join(f.root, 'business');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'important.txt'), 'keep');
  const link = path.join(p.account, 'unexpected');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const failed = await f.service.disconnect('wecom');
  assert.equal(failed.ok, false); assert.equal(failed.disconnected, true); assert.equal(failed.state, 'error');
  assert.equal(fs.readFileSync(path.join(outside, 'important.txt'), 'utf8'), 'keep');
  fs.unlinkSync(link);
  assert.equal((await f.service.disconnect('wecom')).ok, true);
});
test('failure to persist the fence cannot report a successful disconnect', async t => {
  const f = fixture(t), write = fs.writeFileSync;
  await f.service.refresh('wecom');
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).endsWith(life.MARKER)) throw Object.assign(Error('denied'), { code: 'EACCES' });
    return write(file, ...args);
  });
  const result = await f.service.disconnect('wecom');
  assert.equal(result.ok, false); assert.equal(result.connected, false); assert.equal(result.disconnected, false);
  const before = f.state.calls.length;
  assert.equal((await f.service.refresh('wecom')).connected, false);
  assert.equal((await f.service.status('wecom')).state, 'error');
  assert.equal(f.state.calls.length, before);
  assert.equal(await f.service.conversationGuide(runtime.scope(f.state.identity)), '');
});
test('legacy credentials are bound without moving files; the same user on another Hub uses independent storage', async t => {
  const f = fixture(t), original = f.state.identity, legacy = runtime.scope(original), seen = [];
  for (const key of ['wecom', 'feishu']) fs.writeFileSync(path.join(runtime.paths(f.app, key, legacy).account, 'auth.fixture'), key);
  t.mock.method(feishu, 'restore', async (_app, _identity, scope) => { seen.push(scope); return { connected: true }; });
  t.mock.method(feishu, 'closeScope', () => {});
  t.mock.method(feishu, 'disableRegistration', async () => {});
  assert.equal((await f.service.refresh('wecom')).connected, true);
  assert.equal((await f.service.refresh('feishu')).connected, true);
  assert.equal(f.state.calls[0].scope, legacy); assert.deepEqual(seen, [legacy]);
  f.state.identity = { ...original, hub: 'http://other-hub.invalid' };
  const otherScope = runtime.platformScope(f.app, f.state.identity, 'wecom');
  assert.notEqual(otherScope, legacy);
  assert.equal((await f.service.disconnect('wecom')).ok, true);
  assert.equal((await f.service.disconnect('feishu')).ok, true);
  for (const key of ['wecom', 'feishu']) assert.equal(fs.readFileSync(path.join(runtime.paths(f.app, key, legacy).account, 'auth.fixture'), 'utf8'), key);
  f.state.identity = original;
  assert.equal((await f.service.refresh('wecom')).connected, true);
  assert.equal((await f.service.refresh('feishu')).connected, true);
  assert.equal(seen.at(-1), legacy, 'legacy Feishu registration ID remains stable');
});
test('exclusive legacy binding never overwrites a different environment that wins the race', t => {
  const f = fixture(t), legacy = runtime.scope(f.state.identity);
  const account = runtime.paths(f.app, 'wecom', legacy).account;
  const other = runtime.connectionScope({ ...f.state.identity, hub: 'http://winner.invalid' }), write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, data, options) => {
    if (file === path.join(account, '.soduwork-hub-binding.json') && options.flag === 'wx') {
      write(file, JSON.stringify({ schema: 1, scope: other }), { flag: 'wx' });
      throw Object.assign(Error('existing'), { code: 'EEXIST' });
    }
    return write(file, data, options);
  });
  assert.equal(runtime.platformScope(f.app, f.state.identity, 'wecom', true), runtime.connectionScope(f.state.identity));
  assert.equal(JSON.parse(fs.readFileSync(path.join(account, '.soduwork-hub-binding.json'), 'utf8')).scope, other);
});
test('Feishu local credentials are cleared even when Hub disable fails; retry only disables the owned registration', async t => {
  const f = fixture(t), scope = runtime.platformScope(f.app, f.state.identity, 'feishu');
  const file = path.join(runtime.paths(f.app, 'feishu', scope).account, 'connection.json');
  fs.writeFileSync(file, '{"cipher":"isolated-fixture"}');
  let stop = 0, attempts = 0;
  t.mock.method(feishu, 'closeScope', value => { assert.equal(value, scope); stop++; });
  t.mock.method(feishu, 'disableRegistration', async (_id, value) => {
    assert.equal(value, scope); if (++attempts === 1) throw Error('后台暂时不可用');
  });
  const result = await f.service.disconnect('feishu');
  assert.equal(result.disconnected, true); assert.equal(result.ok, false); assert.equal(result.state, 'error');
  assert.equal(fs.existsSync(file), false); assert.equal(stop, 1);
  const restarted = connections.create(f.options); t.after(() => restarted.close());
  const afterRestart = await restarted.status('feishu');
  assert.equal(afterRestart.disconnected, true); assert.equal(afterRestart.ok, false); assert.equal(afterRestart.state, 'error');
  assert.equal((await f.service.disconnect('feishu')).ok, true); assert.equal(attempts, 2);
});
test('Feishu late restore respects cancellation before credentials or status can be restored', async t => {
  const f = fixture(t), pending = deferred(); let signal, stopped = 0;
  t.mock.method(feishu, 'restore', async (_app, _id, _scope, _safe, _owner, active) => { signal = active; return pending.promise; });
  t.mock.method(feishu, 'closeScope', () => { stopped++; });
  t.mock.method(feishu, 'disableRegistration', async () => {});
  const checking = f.service.refresh('feishu'); await turn();
  const closing = f.service.disconnect('feishu'); await turn();
  assert.equal(signal.aborted, true); pending.resolve({ connected: true, account: 'late' });
  assert.equal((await closing).ok, true); assert.equal((await checking).connected, false);
  assert.ok(stopped > 0); assert.equal((await f.service.status('feishu')).account, '');
});
test('native Feishu registration disable is an exact incremental update and never invokes the provider', async t => {
  const id = identity(), scope = runtime.scope(id), owned = ('soduwork-feishu-' + scope).slice(0, 36), calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url, options });
    assert.equal(new URL(url).origin, new URL(id.hub).origin);
    return { ok: true, json: async () => options.method === 'GET'
      ? { personal: [{ id: owned, name: 'feishu', enabled: true }, { id: 'other', name: 'other', enabled: true }] }
      : { personal: [{ id: owned, name: 'feishu', enabled: false }] } };
  });
  await feishu.disableRegistration(id, scope);
  assert.deepEqual(calls.map(call => call.options.method), ['GET', 'PATCH']);
  assert.deepEqual(JSON.parse(calls[1].options.body), { changes: [{ kind: 'personal', id: owned, enabled: false }] });
});
test('disconnect IPC only accepts trusted app frames and fixed providers, never a renderer path', async t => {
  const f = fixture(t), handlers = new Map();
  f.app.on = () => {}; f.app.whenReady = () => new Promise(() => {});
  const service = connections.install({ ...f.options, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } });
  t.after(() => service.close());
  const invoke = handlers.get('platform-connection-disconnect');
  const evil = { sender: { getURL: () => 'https://untrusted.invalid' } };
  assert.equal((await invoke(evil, 'wecom', { path: f.root })).ok, false);
  const local = { sender: { getURL: () => require('node:url').pathToFileURL(path.resolve(__dirname, '../desk.html')).href } };
  assert.equal((await invoke(local, '../escape')).ok, false);
  const result = await invoke(local, 'dingtalk', { path: f.root });
  assert.equal(result.ok, true); assert.equal(result.disconnected, true); assert.equal(fs.existsSync(f.root), true);
});

test('failed authorization remains an error until an explicit retry', async t => {
  const f = fixture(t);
  t.mock.method(runtime, 'launch', async () => ({ completion: Promise.resolve({ code: 1 }), cancel() {} }));
  await f.service.connect('dingtalk'); await turn();
  const failed = await f.service.status('dingtalk');
  assert.equal(failed.state, 'error'); assert.equal(failed.connected, false);
  assert.equal((await f.service.refresh('dingtalk')).state, 'error');
});

test('DingTalk device authorization survives five minutes and settles after the official window', async t => {
  const f = fixture(t), complete = deferred(); let loginOptions, now = Date.now(), checks = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(runtime, 'launch', async (_app, key, _scope, args, options) => {
    assert.equal(key, 'dingtalk');
    if (args[1] === 'login') {
      loginOptions = options;
      return { completion: complete.promise, cancel() {} };
    }
    checks++;
    return { completion: Promise.resolve({ code: 0, output: '{"authenticated":true}' }), cancel() {} };
  });
  await f.service.connect('dingtalk'); await turn();
  assert.ok(loginOptions.timeout > 16 * 60 * 1000 && loginOptions.timeout <= 18 * 60 * 1000);
  now += 6 * 60 * 1000;
  assert.equal((await f.service.status('dingtalk')).state, 'connecting');
  complete.resolve({ code: 0 }); await turn(); await turn();
  assert.equal((await f.service.status('dingtalk')).connected, true);
  assert.equal(checks, 1);
});

test('DingTalk failure and cancellation release the persistent connecting fence', async t => {
  const f = fixture(t), scope = runtime.platformScope(f.app, f.state.identity, 'dingtalk');
  t.mock.method(runtime, 'launch', async () => ({ completion: Promise.reject(Error('平台程序响应超时，请重试')), cancel() {} }));
  await f.service.connect('dingtalk'); await turn(); await turn();
  assert.equal(life.read(f.app, 'dingtalk', scope).connecting, false);
  assert.match((await f.service.status('dingtalk')).message, /等待钉钉授权超时/);
  const complete = deferred();
  t.mock.method(runtime, 'launch', async () => ({ completion: complete.promise, cancel() { complete.resolve({ code: 0 }); } }));
  await f.service.connect('dingtalk'); await turn();
  await f.service.cancel('dingtalk'); await turn();
  assert.equal(life.read(f.app, 'dingtalk', scope).connecting, false);
  assert.equal((await f.service.status('dingtalk')).connected, false);
});
test('a throwing stop is a structured failure behind the persistent fence and is retryable', async t => {
  const f = fixture(t), complete = deferred();
  t.mock.method(runtime, 'launch', async () => ({ completion: complete.promise,
    cancel() { complete.resolve({ code: 0, output: 'authorized' }); throw Error('private process diagnostic'); } }));
  await f.service.connect('wecom'); await turn();
  const failed = await f.service.disconnect('wecom');
  assert.equal(failed.ok, false); assert.equal(failed.disconnected, true); assert.equal(failed.connected, false);
  assert.equal(failed.state, 'error'); assert.ok(!JSON.stringify(failed).includes('private'));
  assert.equal(await f.service.conversationGuide(runtime.scope(f.state.identity)), '');
  assert.equal((await f.service.disconnect('wecom')).ok, true);
});
test('cancelled native login cannot race a new login while the former process can still write', async t => {
  const f = fixture(t), complete = deferred(); let launches = 0;
  t.mock.method(runtime, 'launch', async () => { launches++; return { completion: complete.promise, cancel() {} }; });
  await f.service.connect('dingtalk'); await turn();
  await f.service.cancel('dingtalk');
  await assert.rejects(f.service.connect('dingtalk'), /仍在退出/);
  assert.equal(launches, 1);
  complete.resolve({ code: 0, output: '{"authenticated":true}' }); await turn();
  await f.service.connect('dingtalk'); await turn(); assert.ok(launches >= 2);
});
test('Feishu disconnect stop failure still reports a persistent local block', async t => {
  const f = fixture(t); let stops = 0;
  t.mock.method(feishu, 'closeScope', () => { if (++stops === 1) throw Error('managed process failed to stop'); });
  t.mock.method(feishu, 'disableRegistration', async () => {});
  const failed = await f.service.disconnect('feishu');
  assert.equal(failed.ok, false); assert.equal(failed.disconnected, true); assert.equal(failed.connected, false);
  assert.equal((await f.service.disconnect('feishu')).ok, true);
});
test('Feishu token restore honors a persisted local disconnect without contacting the platform', async t => {
  const f = fixture(t), scope = runtime.platformScope(f.app, f.state.identity, 'feishu');
  life.begin(f.app, 'feishu', scope, true);
  await assert.rejects(feishu.restore(f.app, f.state.identity, scope, {}, f.options.identityOf), /已断开/);
});

test('只读目录状态以授权操作历史判断已添加，并隔离账号与后台', async t => {
  const f = fixture(t), original = f.state.identity;
  const fresh = await f.service.status('wecom');
  assert.equal(fresh.installed, true); assert.equal(fresh.state, 'needs_auth'); assert.equal(fresh.added, false);
  const scope = runtime.platformScope(f.app, original, 'wecom', true);
  const started = life.begin(f.app, 'wecom', scope, false);
  life.finish(f.app, 'wecom', scope, started.revision);
  const restarted = connections.create(f.options); t.after(() => restarted.close());
  const expired = await restarted.status('wecom');
  assert.equal(expired.state, 'needs_auth'); assert.equal(expired.added, true); assert.equal(expired.connected, false);
  f.state.identity = identity('two');
  assert.equal((await restarted.status('wecom')).added, false);
  f.state.identity = { ...original, hub: 'http://other-hub.invalid' };
  assert.equal((await restarted.status('wecom')).added, false);
  f.state.identity = original;
  assert.equal((await restarted.status('wecom')).added, true);
  life.begin(f.app, 'wecom', scope, true);
  const disconnected = await restarted.status('wecom');
  assert.equal(disconnected.disconnected, true); assert.equal(disconnected.added, true);
  assert.equal(f.state.calls.length, 0, '状态查询不启动 CLI 或平台授权');
});
