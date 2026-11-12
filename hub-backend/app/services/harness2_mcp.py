"""MCP dispatch with bounded output and owned subprocess cleanup."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time

from .acp_process import close_process, OwnedProcessGroup

MAX_OUTPUT = 2_000_000


def _allowed(spec, name):
    allowed = spec.get("enabledTools") or []
    disabled = spec.get("disabledTools") or []
    granted = "allowedTools" not in spec or name in (spec.get("allowedTools") or [])
    return granted and (not allowed or name in allowed) and name not in disabled


def _timeout(spec, action):
    key = "startupTimeoutSeconds" if action == "list" else "toolTimeoutSeconds"
    values = [min(120, max(3, int(spec.get(key) or 60)))]
    for name in ("soduWorkPolicy", "soduworkPolicy"):
        policy = spec.get(name)
        if isinstance(policy, dict) and policy.get("timeoutSeconds"):
            values.append(max(3, min(300, int(policy["timeoutSeconds"]))))
    return min(values)


def _bounded(result, spec):
    limits = [65536]
    for name in ("soduWorkPolicy", "soduworkPolicy"):
        policy = spec.get(name)
        if isinstance(policy, dict) and policy.get("maxResultChars"):
            limits.append(max(1000, int(policy["maxResultChars"])))
    text, limit = json.dumps(result, ensure_ascii=False), min(limits)
    return result if len(text) <= limit else {"truncated": True, "preview": text[:limit]}


def _stdio(server, spec, action, tool, arguments, cancel):
    if cancel.is_set():
        raise ValueError("MCP execution was cancelled")
    from .skills import bundled_root
    node = shutil.which("node") or shutil.which("node.exe")
    script = Path(bundled_root()) / "mcp-tools/scripts/mcp.mjs"
    if not node or not script.is_file():
        raise ValueError("The configured stdio MCP requires the bundled Node bridge")
    env = {key: value for key, value in os.environ.items()
           if key not in {"SODUWORK_APPROVAL_CHANNEL", "SODUWORK_MCP_SERVERS",
                          "SODUWORK_HARNESS2_MODEL", "SODUWORK_LLM_KEY"}}
    env.update(SODUWORK_MCP_SERVERS_JSON=json.dumps({"servers": {server: spec}}),
               SODUWORK_MCP_JSON="1", SODUWORK_MCP_ARGS_STDIN="1")
    argv = [node, str(script), action, server]
    if action == "call":
        argv.append(tool)
    payload = json.dumps(arguments or {}).encode("utf-8")
    if len(payload) > 65536:
        raise ValueError("MCP arguments exceed the execution limit")
    flags = ({"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
             if os.name == "nt" else {"start_new_session": True})
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, **flags)
    group = OwnedProcessGroup(proc.pid) if os.name != "nt" else None
    output, overflow = bytearray(), threading.Event()
    def read(pipe, keep):
        while chunk := pipe.read(65536):
            if keep:
                if len(output) + len(chunk) > MAX_OUTPUT:
                    overflow.set()
                    return
                output.extend(chunk)
    def write():
        try:
            proc.stdin.write(payload)
            proc.stdin.close()
        except (OSError, ValueError):
            pass
    readers = [threading.Thread(target=read, args=(proc.stdout, True), daemon=True),
               threading.Thread(target=read, args=(proc.stderr, False), daemon=True),
               threading.Thread(target=write, daemon=True)]
    try:
        for reader in readers:
            reader.start()
        deadline = time.monotonic() + _timeout(spec, action)
        while proc.poll() is None:
            if cancel.wait(.025) or overflow.is_set() or time.monotonic() >= deadline:
                raise ValueError("MCP stopped at its execution boundary")
        for reader in readers:
            reader.join(timeout=1)
        if proc.returncode or overflow.is_set():
            raise ValueError("MCP execution failed")
        return json.loads(output)
    finally:
        close_process(proc, readers, group)


def list_tools(server, spec, cancel):
    if cancel.is_set():
        raise ValueError("MCP discovery was cancelled")
    if spec.get("type") == "http":
        from .mcp_http import list_tools as http_list
        rows = http_list(spec, timeout=_timeout(spec, "list"))
    else:
        rows = _stdio(server, spec, "list", "", {}, cancel).get("tools") or []
    if not isinstance(rows, list):
        raise ValueError("Invalid MCP tool list")
    result = [row for row in rows[:500] if isinstance(row, dict)
              and isinstance(row.get("name"), str) and _allowed(spec, row["name"])]
    if len(json.dumps(result)) > MAX_OUTPUT:
        raise ValueError("MCP catalog exceeds the execution limit")
    return result


def call_tool(server, spec, tool, arguments, cancel):
    if cancel.is_set() or not _allowed(spec, tool):
        raise ValueError("MCP tool is not allowed")
    if spec.get("type") == "http":
        from .mcp_http import call
        result = call(spec, tool, arguments, timeout=_timeout(spec, "call"))
    else:
        from .mcp_http import normalize_tool_result
        result = normalize_tool_result(_stdio(server, spec, "call", tool, arguments, cancel))
    return _bounded(result, spec)
