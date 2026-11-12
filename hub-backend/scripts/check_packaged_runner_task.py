"""Real frozen Runner + bundled Pi; only the loopback model response is a fixture."""
import http.server
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import uuid

PREFIX = "@@SODUWORK_LOCAL_RPC@@"

def delivered_node(payload: Path, executable: Path) -> Path:
    assert executable.parent == payload and executable.suffix.lower() == ".exe", "Delivered Electron runtime must belong to the payload"
    assert executable.is_file(), "Delivered Electron runtime is missing"
    return executable

def main():
    exe, payload, root, executable = [Path(x).resolve() for x in sys.argv[1:5]]
    bundled_node = delivered_node(payload, executable)
    root.mkdir(parents=True, exist_ok=True)
    work = root / "work"
    work.mkdir(exist_ok=True)
    received = threading.Event()
    release = threading.Event()
    release.set()
    requests = []
    class Model(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(dict(path=self.path, model=body.get("model")))
            received.set()
            if not release.wait(35):
                self.send_error(503)
                return
            # Exercise Pi's actual file-write tool, then return a completed turn.
            tool_seen = any(m.get("role") == "tool" for m in body.get("messages", []))
            if tool_seen:
                delta = dict(role="assistant", content="INSTALLER_RUNTIME_OK")
                finish = "stop"
            else:
                delta = dict(role="assistant", tool_calls=[dict(index=0, id="write-check", type="function",
                    function=dict(name="write", arguments=json.dumps(dict(path="runner-result.txt", content="INSTALLER_RUNTIME_OK"))))])
                finish = "tool_calls"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for d, f in [(delta, None), ({}, finish)]:
                msg = dict(id="fixture", object="chat.completion.chunk", created=1, model="installer-fixture",
                           choices=[dict(index=0, delta=d, finish_reason=f)])
                self.wfile.write(("data: " + json.dumps(msg) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:" + str(server.server_port)
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8",
        USERPROFILE=str(root / "profile"), SODUWORK_DATA_ROOT=str(root / "data"),
        SODUWORK_BUNDLED_PI_CLI=str(payload / "resources/pi/@earendil-works/pi-coding-agent/dist/cli.js"),
        SODUWORK_BUNDLED_NODE=str(bundled_node),
        SODUWORK_BUNDLED_SHELL=str(payload / "resources/shell"))
    for key in ["SODUWORK_HUB", "SODUWORK_RUNNER_TOKEN", "SODUWORK_RUNNER_KEY", "SODUWORK_DEVICE_SECRET", "SODUWORK_RUNNER_ID", "SODUWORK_WORK_ROOT", "PI_CODING_AGENT_DIR", "SODUWORK_PROXY_KEY", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"]:
        env.pop(key, None)
    config = dict(hub=base, clientId="installer-fixture", runnerId="task-" + uuid.uuid4().hex,
                  dataRoot=str(root / "data"), workRoot=str(work), capabilityGrants=[], tags=["soduwork-client"])
    processes = []
    class Runner:
        def __init__(self, label):
            err = open(root / (label + ".stderr.log"), "wb")
            self.proc = subprocess.Popen([str(exe), "--config-stdin"], cwd=root, env=env,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err)
            err.close()
            processes.append(self.proc)
            self.replies = queue.Queue()
            def read():
                for line in self.proc.stdout:
                    if line.startswith(PREFIX.encode()):
                        self.replies.put(json.loads(line[len(PREFIX):]))
            threading.Thread(target=read, daemon=True).start()
            self.proc.stdin.write(("@@SODUWORK_RUNNER_CONFIG@@" + json.dumps(config) + "\n").encode())
            self.proc.stdin.flush()
            assert self.rpc("runtime.ping")["ok"]
        def rpc(self, op, **payload):
            rid = uuid.uuid4().hex
            message = dict(op=op, **payload)
            self.proc.stdin.write((PREFIX + json.dumps(dict(id=rid, message=message)) + "\n").encode())
            self.proc.stdin.flush()
            reply = self.replies.get(timeout=40)
            assert reply["id"] == rid and reply["ok"], reply
            return reply["result"]
        def stop(self):
            self.proc.stdin.close()
            assert self.proc.wait(timeout=12) == 0
    checks = []
    try:
        runner = Runner("first")
        dispatch = runner.rpc("job.dispatch", cli="pi", dispatchId=uuid.uuid4().hex,
            task=dict(id="fixture-task", title="Write runner-result.txt", note="write INSTALLER_RUNTIME_OK to runner-result.txt"),
            cfg=dict(local_cli="pi", llm=dict(base=base + "/v1", key="local-fixture", model="installer-fixture")),
            ctx=dict(workspace=dict(workRoot=str(work)), workRoot=str(work), workDir=str(work),
                     requiredAgentCapabilities=[], expectedOutputs=["runner-result.txt"]))
        assert dispatch["ok"], dispatch
        ref = dispatch["data"]["ref"]
        last = None
        for _ in range(100):
            last = runner.rpc("job.status", ref=ref)
            (root / "last-status.json").write_text(json.dumps(last, ensure_ascii=False, indent=2), encoding="utf-8")
            state = last.get("data", {}).get("status")
            if state in ["done", "failed", "cancelled", "error", "completed"]:
                break
            time.sleep(0.5)
        assert (root / "profile/.pi/agent/models.json").is_file(), "Runner must create its actual Pi configuration"
        assert requests, last
        assert state in ["done", "completed"], last
        assert (Path(last["data"]["workDirAbs"]) / "runner-result.txt").read_text(encoding="utf-8") == "INSTALLER_RUNTIME_OK", last
        checks.append(dict(name="real frozen Runner dispatches bundled Pi and writes requested artifact", status=state, ref=ref))
        print("PASS real Runner -> durable worker -> bundled Pi -> loopback model -> file tool -> result", flush=True)
        runner.stop()
        runner = Runner("restarted")
        for _ in range(30):
            recovered = runner.rpc("job.status", ref=ref)
            if recovered.get("data", {}).get("status") in ["done", "completed"]:
                break
            time.sleep(0.2)
        assert recovered.get("data", {}).get("status") in ["done", "completed"], recovered
        checks.append(dict(name="completed execution survives Runner restart", ref=ref))
        release.clear()
        received.clear()
        second = runner.rpc("job.dispatch", cli="pi", dispatchId=uuid.uuid4().hex,
            task=dict(id="fixture-durable", title="Write runner-result.txt", note="write INSTALLER_RUNTIME_OK"),
            cfg=dict(local_cli="pi", llm=dict(base=base + "/v1", key="local-fixture", model="installer-fixture")),
            ctx=dict(workspace=dict(workRoot=str(work)), workRoot=str(work), expectedOutputs=["runner-result.txt"]))
        assert second["ok"], second
        second_ref = second["data"]["ref"]
        assert received.wait(25), runner.rpc("job.status", ref=second_ref)
        runner.stop()
        # The original Runner has exited while its actual Pi request is in flight.
        runner = Runner("inflight-restart")
        release.set()
        for _ in range(100):
            resumed = runner.rpc("job.status", ref=second_ref)
            state = resumed.get("data", {}).get("status")
            if state in ["done", "failed", "cancelled", "error", "completed"]:
                break
            time.sleep(0.5)
        assert state in ["done", "completed"], resumed
        assert (Path(resumed["data"]["workDirAbs"]) / "runner-result.txt").read_text(encoding="utf-8") == "INSTALLER_RUNTIME_OK", resumed
        checks.append(dict(name="in-flight Pi task outlives original frozen Runner and is recovered", ref=second_ref))
        print("PASS actual in-flight task survives Runner exit and is recovered by replacement", flush=True)
        runner.stop()
        (root / "report.json").write_text(json.dumps(dict(ok=True, checks=checks, modelRequests=requests,
            modelBoundary="loopback deterministic fixture; actual Runner, sidecar and Pi binaries"), indent=2), encoding="utf-8")
    finally:
        release.set()
        for proc in processes:
            if proc.poll() is None:
                subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        server.shutdown()

if __name__ == "__main__":
    main()
