'use strict';
// Real child processes only; never enroll or touch an installed Runner.
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { supervise } = require('../main/runner-process-lifecycle.cjs');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const idle = 'setInterval(()=>{},1000)';
const script = `const {spawn}=require('node:child_process');
  const child=spawn(process.execPath,[ '-e',${JSON.stringify(idle)}],{windowsHide:true,stdio:'ignore'});
  process.send({pid:child.pid});process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`;
(async () => {
  const times = [];
  const unrelated = spawn(process.execPath, ['-e', idle], { windowsHide: true, stdio: 'ignore' });
  try {
    for (let round = 0; round < 3; round++) {
      const child = spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore', 'ipc'] });
      let descendant;
      try {
        [descendant] = await once(child, 'message');
        const controller = supervise(child, { graceMs: 1500 });
        const started = Date.now(), pending = controller.stop();
        assert.equal(controller.stop(), pending);
        await pending;
        assert.equal(alive(child.pid), false);
        assert.equal(alive(descendant.pid), false);
        assert.equal(alive(unrelated.pid), true);
        times.push(Date.now() - started);
      } finally {
        if (child.exitCode == null) child.kill();
        if (descendant && alive(descendant.pid)) process.kill(descendant.pid);
      }
    }
  } finally { unrelated.kill(); }
  console.log(JSON.stringify({ ok: true, rounds: times.length, durationMs: times,
    scope: 'Real owned launcher and descendant cleanup; unrelated process survives' }));
})().catch(error => { console.error(error); process.exitCode = 1; });
