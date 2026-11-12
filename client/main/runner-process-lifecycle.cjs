'use strict';

const { createProcessTreeGuard } = require('./agent-runtime/process-tree');

// Hold Electron's quit boundary until the owned Runner and observed children exit.
function supervise(child, { createGuard = createProcessTreeGuard, graceMs = 10000 } = {}) {
  const guard = createGuard({ pid: child.pid, intervalMs: 2000 });
  const ready = guard.start().catch(() => null);
  let exited = child.exitCode != null, stopping = null;
  let resolveExit;
  const exit = new Promise(resolve => { resolveExit = resolve; });
  child.once('exit', () => { exited = true; resolveExit(); });
  child.once('error', () => { if (!child.pid) { exited = true; resolveExit(); } });
  if (exited) resolveExit();

  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      await ready;
      // Capture descendants before graceful shutdown can reparent them.
      await guard.refresh().catch(() => null);
      if (!exited) {
        try {
          if (child.stdin?.writable) {
            child.stdin.write('@@SODUWORK_LOCAL_RPC@@' + JSON.stringify({
              id: 'shutdown-' + Date.now().toString(36), message: { op: 'runtime.shutdown' },
            }) + '\n');
            child.stdin.end();
          }
        } catch (_) { /* Verified process-tree cleanup remains available. */ }
        let timer;
        try { await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, graceMs); })]); }
        finally { clearTimeout(timer); }
      }
      try { return await guard.stop(); }
      catch (_) { return await guard.stop(); }
      finally { guard.dispose(); }
    })();
    return stopping;
  }
  return { stop };
}

module.exports = { supervise };
