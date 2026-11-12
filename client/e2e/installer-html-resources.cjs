'use strict';
// Actual downloaded payload, isolated extraction only. No product installation.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { once } = require('node:events');
const crypto = require('node:crypto');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const [rootArg, outputArg] = process.argv.slice(2);
  const root = path.resolve(rootArg || '');
  assert.equal(path.dirname(root), os.tmpdir(), 'Use only a diagnostic self-check extraction');
  assert.match(path.basename(root), /^soduwork-package-check-[a-f0-9-]{36}$/);
  assert.equal(fs.existsSync(path.join(root, '.soduwork-active')), false);
  const output = path.resolve(outputArg || path.join(root, 'html-regression.json'));
  const initial = JSON.parse(fs.readFileSync(path.join(root, '.soduwork-payload.json')));
  const oldVerify = require(path.join(root, '.soduwork-verify.cjs')).verify;
  const piRoot = path.join(root, 'resources/pi/@earendil-works/pi-coding-agent');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-html-runtime-'));
  const session = path.join(sessionDir, 'fixture.jsonl');
  const sessionId = crypto.randomUUID();
  fs.writeFileSync(session, JSON.stringify({type:'session',version:3,id:sessionId,timestamp:new Date().toISOString(),cwd:sessionDir}) + '\n');
  const beforeModule = await import(pathToFileURL(path.join(piRoot, 'dist/core/export-html/index.js')).href + '?before');
  const baselineFile = path.join(sessionDir, 'before-export.html');
  await beforeModule.exportFromFile(session, { outputPath: baselineFile, themeName: 'dark' });
  const baseline = fs.readFileSync(baselineFile);
  const templatePaths = [
    'resources/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.html',
    'resources/skills/brainstorming/scripts/frame-template.html',
  ];
  const customerPaths = initial.files.filter(item => templatePaths.includes(item.path) ||
    /^resources\/shell\/usr\/share\/gtk-doc\/html\/p11-kit\/[^/]+\.html$/.test(item.path)).map(item=>item.path);
  assert.equal(customerPaths.length, 32, 'Fixture must contain the exact customer failure set');
  const originals = new Map(customerPaths.map(name=>[name, fs.readFileSync(path.join(root, name))]));
  const result = { sourceFiles: initial.files.length, customerPaths, checks: [] };
  try {
    for (const [name, bytes] of originals) fs.writeFileSync(path.join(root, name), Buffer.concat([Buffer.alloc(4096, 65), bytes]));
    await assert.rejects(oldVerify(root, [], { installationMode: true }), error => {
      assert.equal(error.errorCount, 32);
      assert.deepEqual(new Set(error.failures.map(item=>item.path)), new Set(customerPaths));
      assert.ok(error.failures.every(item=>item.actualSize === item.expectedSize + 4096));
      return true;
    });
    result.checks.push('old installer rejects all 32 customer HTML paths after +4096 representation change');
  } finally {
    for (const [name, bytes] of originals) fs.writeFileSync(path.join(root, name), bytes);
  }
  // Only the owned extracted payload is transformed. Source and node_modules stay intact.
  const docs = path.resolve(root, 'resources/shell/usr/share/gtk-doc');
  assert.ok(docs.startsWith(root + path.sep));
  assert.equal(fs.lstatSync(docs).isSymbolicLink(), false);
  fs.rmSync(docs, { recursive: true });
  result.preparation = await require('../scripts/prepare-html-resources.cjs').prepareHtmlResources(root);
  await require('../scripts/prepare-installer.cjs').inventory(root);
  const verifier = require('../build/verify-payload.cjs');
  result.fileCount = await verifier.verify(root);
  const after = JSON.parse(fs.readFileSync(path.join(root, '.soduwork-payload.json')));
  assert.ok(customerPaths.every(name=>!fs.existsSync(path.join(root, name))));
  result.checks.push('transformed complete payload passes unchanged strict verification');
  const licenseName = 'LICENSES.chromium.html';
  const license = fs.readFileSync(path.join(root, licenseName));
  try {
    fs.writeFileSync(path.join(root, licenseName), Buffer.concat([Buffer.alloc(4096, 65), license]));
    assert.equal(await verifier.verify(root, [], { installationMode: true }), after.files.length);
    result.checks.push('all remaining loose HTML uses existing verified license source policy');
  } finally { fs.writeFileSync(path.join(root, licenseName), license); }

  const module = await import(pathToFileURL(path.join(piRoot, 'dist/core/export-html/index.js')).href + '?after');
  const htmlFile = path.join(sessionDir, 'module-export.html');
  await module.exportFromFile(session, { outputPath: htmlFile, themeName: 'dark' });
  const html = fs.readFileSync(htmlFile, 'utf8');
  assert.match(html, /<!DOCTYPE html>/i);
  assert.equal(crypto.createHash('sha256').update(html).digest('hex'), crypto.createHash('sha256').update(baseline).digest('hex'),
    'HTML export must stay byte-for-byte equal to the released runtime');
  result.checks.push('actual Pi module exports a complete session without its loose HTML template');
  const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(sessionDir, 'pi-profile'), DISABLE_TELEMETRY: '1', NO_TELEMETRY: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  async function run(file, args, cwd=sessionDir) {
    const child = spawn(file, args, {env, cwd, windowsHide:true, stdio:['ignore','pipe','pipe']});
    let text=''; child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>text+=b);
    const [code] = await once(child, 'exit'); assert.equal(code,0,text.slice(-1500)); return text;
  }
  const cliExport = path.join(sessionDir, 'cli-export.html');
  await run(process.execPath, [path.join(piRoot, 'dist/cli.js'), '--export', session, cliExport]);
  assert.match(fs.readFileSync(cliExport,'utf8'),/<!DOCTYPE html>/i);
  result.checks.push('actual bundled Pi CLI exports session without its loose HTML template');

  const brainDir = path.join(sessionDir, 'brainstorm');
  fs.mkdirSync(path.join(brainDir,'content'),{recursive:true});
  fs.writeFileSync(path.join(brainDir,'content/screen.html'), '<section>installer-frame-fixture</section>');
  const portFile = path.join(sessionDir,'brainstorm.port');
  const token = crypto.randomBytes(24).toString('hex');
  const reservation = require('node:net').createServer();
  reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const freePort = reservation.address().port;
  await new Promise(resolve=>reservation.close(resolve));
  const server = spawn(process.execPath,[path.join(root,'resources/skills/brainstorming/scripts/server.cjs')],{
    windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...env,BRAINSTORM_DIR:brainDir,
      BRAINSTORM_PORT:String(freePort), BRAINSTORM_PORT_FILE:portFile, BRAINSTORM_HOST:'127.0.0.1',
      BRAINSTORM_TOKEN:token, BRAINSTORM_OPEN:'', BRAINSTORM_OWNER_PID:String(process.pid)} });
  let serverLog='';server.stdout.on('data',b=>serverLog+=b);server.stderr.on('data',b=>serverLog+=b);
  try {
    const until=Date.now()+15000;
    while(!fs.existsSync(portFile)){if(Date.now()>until||server.exitCode!==null)throw Error('Brainstorm failed: '+serverLog);await delay(50);}
    const port=fs.readFileSync(portFile,'utf8').trim();
    const response=await fetch('http://127.0.0.1:'+port+'/',{headers:{Cookie:'brainstorm-key-'+port+'='+token}});
    assert.equal(response.status,200);
    const body=await response.text();assert.match(body,/installer-frame-fixture/);assert.match(body,/<!DOCTYPE html>/i);
    result.checks.push('actual brainstorm HTTP server renders a fragment inside its embedded frame');
  } finally { if(server.exitCode===null){server.kill();await once(server,'exit');} }
  result.ok=true;result.sessionDir=sessionDir;
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2));
  console.log(JSON.stringify({ok:true,fileCount:result.fileCount,checks:result.checks}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
