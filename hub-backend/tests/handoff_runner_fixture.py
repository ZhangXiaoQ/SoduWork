"""Real Runner/process/spool with private test transport and synthetic model CLI."""
import asyncio
import base64
import json
import os
from pathlib import Path
import sys

for stream in (sys.stdin, sys.stdout, sys.stderr):
    stream.reconfigure(encoding="utf-8", errors="replace")
root = Path(__file__).resolve().parents[1]
work = Path(sys.argv[1]).resolve()
os.environ["SODUWORK_DATA_ROOT"] = str(work / "data")
os.environ["SODUWORK_LOCAL_STALL_RETRIES"] = "0"
sys.path.insert(0, str(root))
from app.services import local_base, local_process, local_stream, runner_admission, acp_agents
import runner_main

for profile in local_base._PROFILES.values():
    profile["bin"] = lambda: sys.executable
    profile.pop("runtime_probe", None)
    profile.pop("runtime_issue", None)
original_argv = local_base._command_argv
def command(exe, args, ws, cfg, profile):
    agent = next(key for key, value in local_base._PROFILES.items() if value is profile)
    peer = [sys.executable, str(Path(__file__).with_name("handoff_vendor_peer.py")), agent]
    if agent == "opencode":
        sid = args[args.index("--session") + 1] if "--session" in args else ""
        actual = acp_agents.command_argv(agent, exe, acp_agents.run_args(sid, "work", ws, cfg), ws, cfg)
    elif agent in {"codex-harness", "qwen", "dsh", "harness2"}:
        actual = original_argv(exe, args, ws, cfg, profile)
    else:
        actual = None
    if agent == "harness2":
        entry = str(Path(__file__).with_name("handoff_harness2_entry.py"))
        return [actual[0], entry, *actual[2:]]
    return [*actual[:actual.index("--") + 1], *peer] if agent in {"codex-harness", "opencode", "qwen", "dsh"} else [*peer, *args]
local_process._command_argv = command
def environment(profile, *_args, **_kwargs):
    if profile is local_base._PROFILES.get("harness2"):
        from app.services import harness2_runtime
        return {**os.environ, harness2_runtime.MODEL_ENV: "{}",
                harness2_runtime.EXECUTOR_ENV: sys.executable,
                harness2_runtime.ROOT_ENV: str(work / "harness2")}
    return dict(os.environ)
local_process._env_for = environment
local_stream._llm_gate_check = lambda *_args: ""


async def run():
    workspace = work / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    machine = runner_main.Runner("http://127.0.0.1:1", "fixture", "cloud", "fixture", str(workspace))
    machine._resource_budget.snapshot = lambda **_: runner_admission.ResourceSnapshot(
        limit=2, cpu_count=4, can_start=not (work / "hold-queue").exists())
    actual_run = machine._run_admitted
    async def run_admitted(item):
        if (work / "hold-start").exists():
            (work / "claimed").write_text(item.key, encoding="utf-8")
            while (work / "hold-start").exists():
                await asyncio.sleep(.02)
        await actual_run(item)
    machine._run_admitted = run_admitted
    await asyncio.to_thread(local_base.reclaim)
    recovered = asyncio.Event()
    original_recover = machine._admission.recover
    def recover(runs):
        original_recover(runs)
        recovered.set()
    machine._admission.recover = recover
    machine._ensure_admission_loop()
    # The fixture's ready receipt includes journal recovery, not just scheduling
    # the worker. A single loop tick does not finish its asynchronous archive scan.
    await asyncio.wait_for(recovered.wait(), timeout=10)
    print(json.dumps({"ready": True}), flush=True)
    try:
        while line := await asyncio.to_thread(sys.stdin.readline):
            message = json.loads(line)
            if message["op"] == "fixture.desktop":
                from types import SimpleNamespace
                async def native_plugin(packet):
                    # Isolated stand-in for the desktop pipe; execution, staging,
                    # event persistence and duplicate admission remain real.
                    context = packet["_turnContext"]
                    if packet["args"]["plugins"] != [{"pluginId":"local:fixture", "checksum":"a" * 64}]:
                        return {"ok":False,"error":"fixture version mismatch"}
                    (work / "plugin-start-context.json").write_text(json.dumps(context),encoding="utf-8")
                    return {"ok":True,"data":{"promptText":context["text"] + "\nVerified fixture method",
                        "plugins":[{"pluginId":"local:fixture", "name":"Fixture method", "version":"1.0.0"}],
                        "resourceBundles":[]}}
                machine.desktop_owned = True
                machine._desktop_capabilities = SimpleNamespace(call=native_plugin)
                print(json.dumps({"ok":True}),flush=True)
                continue
            if message["op"] == "fixture.close":
                break
            try:
                reply = await (machine._input(message) if message["op"].startswith("input.") else machine._job(message))
            except Exception as exc:
                reply = {"ok": False, "error": type(exc).__name__ + ": " + str(exc)}
            data = reply.get("data")
            if isinstance(data, dict) and "__bytes__" in data:
                data["b64"] = base64.b64encode(data.pop("__bytes__")).decode("ascii")
            print(json.dumps(reply, ensure_ascii=False), flush=True)
    finally:
        for ref in list(local_base._RUNS):
            await asyncio.to_thread(local_stream.stop_sync, {}, ref)
        if machine._admission_task:
            machine._admission_task.cancel()
        await asyncio.gather(*machine._admission_workers, return_exceptions=True)


asyncio.run(run())
