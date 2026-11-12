"""Synthetic vendor boundary for real Runner process/ACP steering tests.

No model or network. Everything above this peer is production code, including
the durable child-process host, process-tree termination and ACP bridge.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from steering_readiness import publish_pid


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def record(value):
    with Path("peer.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value, ensure_ascii=False) + "\n")


def prompt(text, sid, emit_text):
    dialogue = next((name for name in ("DIALOGUE_QUESTION", "DIALOGUE_EMPTY", "DIALOGUE_SUCCESS",
        "DIALOGUE_ERROR", "DIALOGUE_EXIT", "DIALOGUE_THINKING") if name in text), "")
    if dialogue:
        record({"event": "prompt", "label": dialogue, "text": text, "sid": sid, "pid": os.getpid()})
        if dialogue == "DIALOGUE_EXIT":
            print("fixture child exited unexpectedly", file=sys.stderr, flush=True)
            raise SystemExit(17)
        if dialogue == "DIALOGUE_QUESTION":
            emit_text("Which folder should I use?")
        elif dialogue == "DIALOGUE_SUCCESS":
            emit_text("The requested follow-up is complete.")
        return dialogue
    label = next((name for name in ("STEER_FIRST", "STEER_NOW", "STEER_LATER") if name in text), "UNKNOWN")
    record({"event": "prompt", "label": label, "text": text, "sid": sid, "pid": os.getpid()})
    if label == "STEER_FIRST":
        with Path("once.txt").open("a", encoding="utf-8") as out:
            out.write("one operation\n")
        emit_text("Waiting for steering")
        publish_pid(Path("first-ready"), os.getpid())
        while True:
            time.sleep(1)
    assert label != "UNKNOWN", text
    assert Path("once.txt").read_text(encoding="utf-8") == "one operation\n"
    if label == "STEER_NOW":
        assert "note.txt" in text and "【本轮补充文件】" in text, text
        staged = text.rsplit("【本轮补充文件】", 1)[1].strip().split("：", 1)[1]
        assert Path(staged).read_text(encoding="utf-8") == "attached evidence"
    emit_text("Completed " + label)
    if label == "STEER_NOW" and os.environ.get("SODUWORK_STEER_STOP_FOLLOWUP") == "1":
        publish_pid(Path("followup-ready"), os.getpid())
        while True:
            time.sleep(1)


def acp(agent):
    sid = "native-" + agent
    if agent == "harness2":
        sid = "h2_" + "a" * 32
    resumed = False
    for raw in sys.stdin:
        message = json.loads(raw)
        method = message.get("method")
        params = message.get("params") or {}
        record({"event": "acp", "method": method, "sid": params.get("sessionId")})
        if method == "initialize":
            # DSH 0.4.26 advertises only loadSession. Exercise both supported
            # wire contracts rather than giving every fixture session/resume.
            caps = {"loadSession": True, "sessionCapabilities": {} if agent == "dsh" else {"resume": {}}}
            result = {"protocolVersion": 1, "agentCapabilities": caps}
        elif method == "session/new":
            assert not Path("native-session").exists(), "must not create another native session"
            Path("native-session").write_text(sid, encoding="utf-8")
            result = {"sessionId": sid}
        elif method in {"session/load", "session/resume"}:
            assert params["sessionId"] == Path("native-session").read_text(encoding="utf-8")
            assert method == ("session/load" if agent == "dsh" else "session/resume")
            resumed = True
            result = {}
        elif method == "session/set_mode" and agent == "harness2":
            result = {}
        elif method == "session/prompt":
            text = "\n".join(x.get("text", "") for x in params["prompt"])
            assert resumed == ("STEER_FIRST" not in text and "DIALOGUE_QUESTION" not in text)
            def say(value):
                emit({"jsonrpc": "2.0", "method": "session/update", "params": {
                    "sessionId": sid, "update": {"sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": value}}}})
            outcome = prompt(text, sid, say)
            if outcome == "DIALOGUE_THINKING":
                emit({"jsonrpc": "2.0", "method": "session/update", "params": {
                    "sessionId": sid, "update": {"sessionUpdate": "agent_thought_chunk",
                    "content": {"type": "text", "text": "Planning the response"}}}})
            if outcome == "DIALOGUE_ERROR":
                emit({"jsonrpc": "2.0", "id": message["id"], "error": {
                    "code": -32000, "message": "fixture provider failure"}})
                continue
            result = {"stopReason": "end_turn"}
        else:
            raise AssertionError(method)
        emit({"jsonrpc": "2.0", "id": message["id"], "result": result})


def native(agent, args):
    text = sys.stdin.read()
    old = Path("native-session")
    if agent in {"pi", "claude"}:
        flag = "--resume" if "--resume" in args else "--session-id"
        sid = args[args.index(flag) + 1]
    else:
        sid = args[args.index("resume") + 1] if "resume" in args else "native-codex"
    assert not old.exists() or old.read_text(encoding="utf-8") == sid
    old.write_text(sid, encoding="utf-8")
    record({"event": "native", "agent": agent, "args": args, "sid": sid})
    if agent == "codex":
        emit({"type": "thread.started", "thread_id": sid})
        say = lambda value: emit({"type": "item.completed", "item": {"type": "agent_message", "text": value}})
    elif agent == "pi":
        emit({"type": "session", "id": sid})
        say = lambda value: emit({"type": "message_update", "assistantMessageEvent": {"type": "text_end", "content": value}})
    else:
        emit({"type": "system", "subtype": "init", "session_id": sid})
        say = lambda value: emit({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": value}]}})
    outcome = prompt(text, sid, say)
    empty = outcome == "DIALOGUE_EMPTY"
    thinking = outcome == "DIALOGUE_THINKING"
    if thinking:
        if agent == "pi":
            emit({"type": "message_update", "assistantMessageEvent": {
                "type": "thinking_end", "contentIndex": 0, "content": "Planning the response"}})
        elif agent == "codex":
            emit({"type": "item.completed", "item": {"type": "reasoning", "id": "thought-1", "text": "Planning the response"}})
        else:
            emit({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "Planning the response"}]}})
    failed = outcome == "DIALOGUE_ERROR"
    if failed:
        if agent == "claude":
            emit({"type": "result", "is_error": True, "result": "fixture provider failure"})
        elif agent == "codex":
            emit({"type": "turn.failed", "error": {"message": "fixture provider failure"}})
        else:
            emit({"type": "agent_end", "messages": [{"role": "assistant", "content": [],
                "stopReason": "error", "errorMessage": "fixture provider failure"}]})
        return
    if agent == "codex":
        emit({"type": "turn.completed", "usage": {"input_tokens": 20, "output_tokens": 0 if empty else 5}})
    elif agent == "claude":
        emit({"type": "result", "is_error": False, "result": "" if empty or thinking else "Completed", "usage": {"input_tokens": 20, "output_tokens": 0 if empty else 5}})
    else:
        emit({"type": "message_end", "message": {"role": "assistant", "stopReason": "stop",
            "usage": {"input": 20, "output": 0 if empty else 5}}})
        emit({"type": "agent_end", "messages": [{"role": "assistant", "stopReason": "stop", "content": [] if empty or thinking else [{"type": "text", "text": "Completed"}]}]})


if __name__ == "__main__":
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    agent = sys.argv[1]
    acp(agent) if "--acp-fixture" in sys.argv or agent not in {"pi", "claude", "codex"} else native(agent, sys.argv[2:])
