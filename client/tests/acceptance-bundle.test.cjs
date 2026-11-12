'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { prepare } = require('../main/pi-session/task-input');
const { load } = require('../main/pi-session/acceptance-bundle');
const identity = {hub:'http://fixture',clientId:'device',secret:'test-only'};
const bytes = Buffer.from('PK\x03\x04fixture archive');
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
const bundle = {filename:'交付物.zip',artifactVersionId:'v2',attachmentIds:['html','css']};
function response(headers={}) { return new Response(bytes,{headers:{'X-Artifact-Version':'v2','X-Artifact-SHA256':digest,...headers}}); }

test('acceptance downloads one pinned ZIP; optional evidence is fetched only when selected', async t => {
  for (const optional of [false,true]) {
    const calls=[];
    t.mock.method(global,'fetch',async (url,init)=>{
      url=String(url);calls.push(url);
      if(url.includes('/artifacts.zip')) {assert.match(url,/artifactVersionId=v2$/);return response();}
      if(url.includes('/acceptance-context'))return Response.json({canDecide:true,task:{id:'t',title:'Website'},approvalId:'a',artifactVersionId:'v2',requirementVersion:1,
        attachments:[{id:'html',filename:'index.html'},{id:'css',filename:'assets/style.css'}],attachmentIds:['html','css'],deliveryBundle:bundle,
        optionalAttachments:[{id:'screenshot',filename:'verify.png'}],criteria:[]});
      if(url.includes('/tasks/t/attachments'))return Response.json([{id:'screenshot',filename:'verify.png',url:'/api/v1/attachments/screenshot?ticket=fixture',role:'verification'}]);
      if(url.includes('/attachments/screenshot'))return new Response('evidence');
      return Response.json({id:'t',title:'Website'});
    });
    const result=await prepare(identity,'t','chat','turn','Review',{acceptanceOnly:true,...(optional?{acceptanceAttachmentIds:['screenshot']}:{})},{});
    assert.deepEqual(result.attachments.map(file=>file.name),optional?['交付物.zip','verify.png']:['交付物.zip']);
    assert.match(result.text,/请先解压/);
    assert.equal(calls.some(url=>url.endsWith('/tasks/t/attachments')),optional);
    assert.ok(!calls.some(url=>/attachments\/(html|css)/.test(url)));
    t.mock.restoreAll();
  }
});

test('review stages original references beside loose or bundled delivery without downloading run evidence', async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const staging = require('../main/pi-session/attachments');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-review-references-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const bundled of [false, true]) {
    const calls = [];
    t.mock.method(global, 'fetch', async url => {
      url = String(url); calls.push(url);
      if (url.includes('/acceptance-context')) return Response.json({ canDecide: true,
        task: { id: 't', title: 'Compare to reference' }, approvalId: 'a', artifactVersionId: 'v2', requirementVersion: 1,
        attachments: bundled ? [{ id: 'html' }, { id: 'css' }] : [{ id: 'html' }],
        attachmentIds: bundled ? ['html', 'css'] : ['html'], deliveryBundle: bundled ? bundle : null,
        optionalAttachments: [{ id: 'reference', filename: 'same.md', role: 'input' },
          { id: 'verification', filename: 'verify.log', role: 'verification' }], criteria: [] });
      if (url.includes('/artifacts.zip')) return response();
      if (url.endsWith('/tasks/t/attachments')) return Response.json([
        { id: 'html', filename: 'same.md', role: 'output', url: '/api/v1/attachments/html?ticket=fixture' },
        { id: 'reference', filename: 'same.md', role: 'input', url: '/api/v1/attachments/reference?ticket=fixture' },
        { id: 'verification', filename: 'verify.log', role: 'verification', url: '/api/v1/attachments/verification?ticket=fixture' }]);
      if (url.includes('/attachments/reference?')) return new Response('Original reference bytes');
      if (url.includes('/attachments/html?')) return new Response('Current delivery bytes');
      if (url.endsWith('/tasks/t')) return Response.json({ id: 't' });
      throw Error('Unexpected review request: ' + url);
    });
    const review = await prepare(identity, 't', 'chat', 'turn', 'Review', { acceptanceOnly: true }, {});
    const staged = await staging.stage(root, review.attachments);
    assert.deepEqual(staged.warnings, []);
    assert.equal(staged.files.length, 2);
    const reference = staged.files.find(file => file.attachmentId === 'reference');
    assert.equal(await fs.readFile(reference.path, 'utf8'), 'Original reference bytes');
    assert.equal(reference.role, 'input');
    assert.ok(staged.files.every(file => path.resolve(file.path).startsWith(path.resolve(root) + path.sep)));
    assert.equal(new Set(staged.files.map(file => file.path)).size, 2);
    if (!bundled) assert.equal(await fs.readFile(staged.files.find(file => file.attachmentId === 'html').path, 'utf8'), 'Current delivery bytes');
    assert.ok(!calls.some(url => url.includes('/attachments/verification?')));
    await review.beforeTurn();
    t.mock.restoreAll();
  }
});

test('missing requirement reference prevents acceptance preparation without executing or approving', async t => {
  for (const bundled of [false, true]) {
    t.mock.method(global, 'fetch', async (url, init) => {
      assert.ok(!init?.method || init.method === 'GET');
      url = String(url);
      if (url.includes('/acceptance-context')) return Response.json({ canDecide: true,
        task: { id: 't' }, approvalId: 'a', artifactVersionId: 'v2', requirementVersion: 1,
        attachments: bundled ? [{ id: 'html' }, { id: 'css' }] : [{ id: 'html' }],
        attachmentIds: bundled ? ['html', 'css'] : ['html'], deliveryBundle: bundled ? bundle : null,
        optionalAttachments: [{ id: 'missing', role: 'input' }], criteria: [] });
      if (url.includes('/artifacts.zip')) return response();
      if (url.endsWith('/tasks/t/attachments')) return Response.json([{ id: 'html' }]);
      return Response.json({ id: 't' });
    });
    await assert.rejects(prepare(identity, 't', 'chat', 'turn', 'Review', { acceptanceOnly: true }, {}), /验收材料已变化或不可读/);
    t.mock.restoreAll();
  }
});
for (const [name,headers] of [['stale version',{'X-Artifact-Version':'v1'}],['corrupt bytes',{'X-Artifact-SHA256':'0'.repeat(64)}],['oversized response',{'content-length':String(257*1024*1024)}]])
  test('bundle rejects '+name,async t=>{t.mock.method(global,'fetch',async()=>response(headers));await assert.rejects(load(identity,'/tasks/t',bundle));});

test('acceptance explains missing archive sources without exposing arbitrary service bodies', async t => {
  for (const [status,detail,expected] of [
    [502,'当前固定版本的源文件已丢失，拒绝返回不完整压缩包',/源文件已丢失.*原执行电脑/],
    [502,'private storage path and credentials',/HTTP 502/],
    [401,'private authentication detail',/访问权限已变化/],
  ]) {
    t.mock.method(global,'fetch',async()=>Response.json({detail},{status}));
    await assert.rejects(load(identity,'/tasks/t',bundle),expected);
    t.mock.restoreAll();
  }
});
