"""Repeatable ACP bridge smoke test; no model, network or database required."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
BRIDGE = ROOT / "app" / "services" / "acp_bridge.py"


def _send(value: dict) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)


def _fake_agent(expect_resume: bool = False) -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError):
            pass

    resumed = False
    for raw in sys.stdin:
        message = json.loads(raw)
        method = message.get("method")
        if method == "initialize":
            assert message["params"]["protocolVersion"] == 1
            caps = message["params"]["clientCapabilities"]
            assert caps["fs"]["readTextFile"] is True
            assert caps["fs"]["writeTextFile"] is True
            assert caps["terminal"] is True
            assert caps["auth"]["_meta"]["gateway"] is True
            _send({"jsonrpc": "2.0", "id": message["id"], "result": {
                "protocolVersion": 1,
                "agentCapabilities": {"loadSession": True,
                                      "sessionCapabilities": {"resume": {}}},
                "agentInfo": {"name": "fake", "version": "1"}}})
        elif method == "session/new":
            assert not expect_resume
            assert os.path.isabs(message["params"]["cwd"])
            assert message["params"]["mcpServers"] == []
            _send({"jsonrpc": "2.0", "id": message["id"],
                   "result": {"sessionId": "fake-session"}})
        elif method == "session/resume":
            assert expect_resume
            assert message["params"]["sessionId"] == "fake-session"
            resumed = True
            _send({"jsonrpc": "2.0", "id": message["id"], "result": {}})
        elif method == "session/prompt":
            assert bool(resumed) == bool(expect_resume)
            prompt_id = message["id"]
            assert message["params"]["prompt"][0]["text"] == "完成最小任务"
            _send({"jsonrpc": "2.0", "id": 900,
                   "method": "session/request_permission", "params": {
                       "sessionId": "fake-session", "toolCall": {"toolCallId": "call-1"},
                       "options": [
                           {"optionId": "always", "name": "总是允许", "kind": "allow_always"},
                           {"optionId": "once", "name": "允许一次", "kind": "allow_once"},
                           {"optionId": "reject", "name": "拒绝", "kind": "reject_once"},
                       ]}})
            decision = json.loads(sys.stdin.readline())
            assert decision["id"] == 900
            assert decision["result"]["outcome"] == {
                "outcome": "selected", "optionId": "once"}
            _send({"jsonrpc": "2.0", "method": "session/update", "params": {
                "sessionId": "fake-session", "update": {"sessionUpdate": "plan", "entries": [
                    {"content": "检查输入", "priority": "high", "status": "completed"},
                    {"content": "生成结果", "priority": "high", "status": "in_progress"}]}}})
            _send({"jsonrpc": "2.0", "method": "session/update", "params": {
                "sessionId": "fake-session", "update": {"sessionUpdate": "tool_call",
                    "toolCallId": "call-1", "title": "写入文件", "kind": "edit",
                    "status": "in_progress", "rawInput": {"path": "result.txt"}}}})
            _send({"jsonrpc": "2.0", "method": "session/update", "params": {
                "sessionId": "fake-session", "update": {"sessionUpdate": "tool_call_update",
                    "toolCallId": "call-1", "status": "completed", "content": [
                        {"type": "content", "content": {"type": "text", "text": "写入成功"}}]}}})
            for chunk in ("任务", "完成"):
                _send({"jsonrpc": "2.0", "method": "session/update", "params": {
                    "sessionId": "fake-session", "update": {
                        "sessionUpdate": "agent_message_chunk", "messageId": "msg-1",
                        "content": {"type": "text", "text": chunk}}}})
            _send({"jsonrpc": "2.0", "method": "session/update", "params": {
                "sessionId": "fake-session", "update": {
                    "sessionUpdate": "usage_update", "used": 321, "size": 1000}}})
            _send({"jsonrpc": "2.0", "id": prompt_id,
                   "result": {"stopReason": "end_turn"}})
        else:
            raise AssertionError("unexpected method: " + str(method))
    return 0


def _run(*extra: str) -> list[dict]:
    fake = [sys.executable, str(Path(__file__).resolve()), "--fake-agent", *extra]
    argv = [sys.executable, str(BRIDGE), "--cwd", str(ROOT),
            "--agent-name", "fake", "--permission", "workspace", "--terminal"]
    if "--expect-resume" in extra:
        argv += ["--session", "fake-session"]
    run = subprocess.run([*argv, "--", *fake], input="完成最小任务",
                         capture_output=True, text=True, encoding="utf-8",
                         errors="replace", timeout=20)
    assert run.returncode == 0, run.stdout + "\n" + run.stderr
    rows = [json.loads(line) for line in run.stdout.splitlines() if line.strip()]
    assert rows and not run.stderr.strip()
    return rows


def _run_internal() -> list[dict]:
    fake = [sys.executable, str(Path(__file__).resolve()), "--fake-agent"]
    runner_exe = str(os.environ.get("SODUWORK_RUNNER_EXE") or "").strip()
    launcher = ([runner_exe] if runner_exe
                else [sys.executable, str(ROOT / "runner_main.py")])
    argv = [
        *launcher, "--acp-bridge",
        "--cwd", str(ROOT), "--agent-name", "fake",
        "--permission", "workspace", "--terminal", "--", *fake,
    ]
    run = subprocess.run(
        argv, input="\u5b8c\u6210\u6700\u5c0f\u4efb\u52a1",
        capture_output=True, text=True, encoding="utf-8",
        errors="replace", timeout=20)
    assert run.returncode == 0, run.stdout + "\n" + run.stderr
    assert not run.stderr.strip()
    return [json.loads(line) for line in run.stdout.splitlines() if line.strip()]



def main() -> int:
    from app.services.acp_bridge import (
        AcpBridge, BridgeError, _safe_path, _stderr_detail)
    from app.services import acp_agents, agent_execution_options

    allow = AcpBridge([], str(ROOT), "fake", "workspace")._permission_result({
        "options": [{"optionId": "always", "kind": "allow_always"},
                    {"optionId": "once", "kind": "allow_once"}]})
    assert allow["outcome"] == {"outcome": "selected", "optionId": "once"}
    reject = AcpBridge([], str(ROOT), "fake", "readonly")._permission_result({
        "options": [{"optionId": "once", "kind": "allow_once"},
                    {"optionId": "no", "kind": "reject_once"}]})
    assert reject["outcome"] == {"outcome": "selected", "optionId": "no"}

    detail = _stderr_detail(
        ["TypeError: failed to load Qwen settings"],
        ["at start (file:///qwen/chunk.js:10:4)", "Node.js v24.19.0"])
    assert "TypeError: failed to load Qwen settings" in detail
    assert "Node.js v24.19.0" in detail
    first = _run()
    with tempfile.TemporaryDirectory(prefix="soduwork-acp-") as workspace:
        work = Path(workspace)
        bridge = AcpBridge(
            [], workspace, "fake", "workspace", allow_terminal=True)
        target = work / "result.txt"
        bridge._write_text_file({
            "path": str(target), "content": "line-1\nline-2\n"})
        read = bridge._read_text_file({
            "path": str(target), "line": 2, "limit": 1})
        assert read["content"] == "line-2\n"
        try:
            _safe_path(workspace, str(work.parent / "outside.txt"))
        except BridgeError:
            pass
        else:
            raise AssertionError("workspace escape was accepted")
        terminal_id = bridge._terminal_create({
            "command": sys.executable,
            "args": ["-c", "print('ACP_TERM_OK')"],
            "cwd": workspace,
            "env": [],
            "outputByteLimit": 8192,
        })["terminalId"]
        assert bridge._terminal({"terminalId": terminal_id}).wait()["exitCode"] == 0
        terminal_output = bridge._client_request(
            "terminal/output", {"terminalId": terminal_id})
        assert "ACP_TERM_OK" in terminal_output["output"]
        bridge._client_request(
            "terminal/release", {"terminalId": terminal_id})
        assert not bridge.terminals
        readonly = AcpBridge([], workspace, "fake", "readonly")
        try:
            readonly._write_text_file({
                "path": str(target), "content": "forbidden"})
        except BridgeError:
            pass
        else:
            raise AssertionError("read-only write was accepted")
    second = _run("--expect-resume")
    internal = _run_internal()
    for rows in (first, second, internal):
        assert any(row.get("sessionID") == "fake-session" for row in rows)
        assert any(row.get("type") == "step_start" for row in rows)
        assert any(row.get("type") == "tool_use" and
                   (row.get("part") or {}).get("tool") == "写入文件" for row in rows)
        text_rows = [row for row in rows if row.get("type") == "text"]
        assert len(text_rows) >= 3 and text_rows[0].get("part", {}).get("text") and text_rows[1].get("part", {}).get("text")
        assert "".join((row.get("part") or {}).get("text", "") for row in text_rows[:-1]) == text_rows[0]["part"]["text"] + text_rows[1]["part"]["text"]
        assert text_rows[-1].get("part", {}).get("done") is True
        assert any(row.get("type") == "step_finish" and
                   ((row.get("part") or {}).get("tokens") or {}).get("input") == 321
                   for row in rows)
        assert not any("allow_always" in json.dumps(row) for row in rows)

    assert {"qwen", "dsh", "codex-harness"} <= set(acp_agents.CATALOG)
    assert not ({"goose", "openhands"} & set(acp_agents.CATALOG))
    assert all(agent_execution_options.supports_soduwork_model_kind("local:" + key)
               for key in ("opencode", "pi", "qwen", "dsh", "codex-harness"))
    qwen_runtime = agent_execution_options.runtime_options(
        "local:qwen", "dev-coding-large-agent-soduwork")
    assert qwen_runtime == {"kind": "local:qwen",
                            "model": "dev-coding-large-agent-soduwork"}
    assert agent_execution_options.runtime_options(
        "local:qwen", "vendor/coding-model")["model"] == "vendor/coding-model"
    try:
        agent_execution_options.runtime_options("local:claude", "forced-model")
    except ValueError as exc:
        assert "does not support" in str(exc)
    else:
        raise AssertionError("own-account agent accepted a SoduWork-selected model")
    qwen = acp_agents.command_argv("qwen", "qwen", [], str(ROOT), {"llm": {
        "base": "https://model.invalid/v1", "key": "never-on-argv", "model": "coding"},
        "requiredCapabilities": ["files", "terminal"]})
    assert str(BRIDGE) in qwen and "never-on-argv" not in qwen
    assert "--terminal" in qwen
    qwen_env = {
        "QWEN_CODE_CPU_PROFILE": "1", "QWEN_CODE_RELAUNCH_ARGS": "stale",
        "QWEN_CODE_MANAGED_NPM_UPDATE_VERSION": "broken"}
    acp_agents.inject_llm_env("qwen", qwen_env, {
        "base": "https://model.invalid/v1", "key": "secret", "model": "coding"})
    assert "QWEN_CODE_CPU_PROFILE" not in qwen_env
    assert "QWEN_CODE_RELAUNCH_ARGS" not in qwen_env
    assert "QWEN_CODE_MANAGED_NPM_UPDATE_VERSION" not in qwen_env
    assert qwen_env["QWEN_CODE_NO_RELAUNCH"] == "1"
    with tempfile.TemporaryDirectory(prefix="soduwork-qwen-home-") as qwen_root:
        acp_agents.home_env("qwen", qwen_env, qwen_root)
        assert qwen_env["QWEN_HOME"].startswith(os.path.abspath(qwen_root))
    codex = acp_agents.command_argv(
        "codex-harness", "codex-acp", [], str(ROOT), {"llm": {
            "base": "https://model.invalid/v1", "key": "never-on-argv",
            "model": "coding"}})
    assert str(BRIDGE) in codex and "never-on-argv" not in codex
    import unittest
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromName("test_acp_process_lifecycle"))
    if not result.wasSuccessful():
        return 1
    print(f"ACP_RUNTIME_OK: 62 assertions; lifecycle passed={result.testsRun - len(result.skipped)}, "
          f"platform_skipped={len(result.skipped)}")
    return 0


if __name__ == "__main__":
    if "--fake-agent" in sys.argv:
        raise SystemExit(_fake_agent("--expect-resume" in sys.argv))
    raise SystemExit(main())
