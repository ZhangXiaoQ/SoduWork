"""Synthetic Codex subprocess: verify restored bytes, then make a real artifact."""
import json
import os
import re
from pathlib import Path
import sys
import time
import uuid

for stream in (sys.stdin, sys.stdout, sys.stderr):
    stream.reconfigure(encoding="utf-8", errors="replace")

def emit(value):
    print(json.dumps(value), flush=True)


def work(prompt):
    # The initial prompt selects the isolated test's entry route. Later turns
    # (including resumed subprocesses) must work without a magic marker.
    # Keep fixture audit records outside the deliverable file set.
    history = Path(".cache/prompts.jsonl")
    history.parent.mkdir(exist_ok=True)
    first_prompt = json.loads(history.read_text(encoding="utf-8").splitlines()[0])["prompt"] if history.exists() else prompt
    if 'CLOUD_ACCEPTANCE_TEST' in first_prompt:
        # Synthetic reviewer: exercise real report discovery and transport, not model quality.
        material = json.loads(prompt.split('固定版本材料：\n', 1)[1].split('\n验收人补充说明：', 1)[0])
        name = re.search(r'acceptance-report-[a-f0-9]{24}\.json', prompt).group()
        assert material['artifact']['manifest']['text'] == 'Isolated review output'
        report = {'verdict': 'approve', 'summary': 'Synthetic reviewer read the fixed text',
                  'checks': [{'criterion': c['id'], 'result': 'pass',
                              'evidence': 'Fixed text: Isolated review output'} for c in material['criteria']]}
        Path(name).write_text(json.dumps(report), encoding='utf-8')
        return 'Synthetic review complete.'
    if "CLOUD_NEW_TEST" in first_prompt:
        assert not Path("input.txt").exists(), "Direct cloud entry must not restore a workspace"
        assert not Path("soduwork-workspace-handoff.zip").exists()
    else:
        assert Path("input.txt").read_text(encoding="utf-8") == "portable input", os.getcwd()
    with Path(".cache/prompts.jsonl").open("a", encoding="utf-8") as output:
        output.write(json.dumps({"prompt": prompt, "pid": os.getpid(), "agent": agent,
                                 "sid": sid, "resumed": resumed}, ensure_ascii=False) + "\n")
    while Path("hold-process").exists():
        time.sleep(.02)
    if "WAIT_FOR_DISCONNECT" in prompt:
        time.sleep(1)
    Path("delivery.md").write_text("# Delivered from independent cloud workspace\n", encoding="utf-8")
    return "Created delivery.md in the restored workspace."


agent = sys.argv[1]
sid = "fixture-" + uuid.uuid4().hex
if agent == "harness2":
    sid = "h2_" + uuid.uuid4().hex
resumed = False
thought = "Inspect restored workspace before delivering."
if agent in {"codex-harness", "qwen", "opencode", "dsh", "harness2"}:
    for raw in sys.stdin:
        message = json.loads(raw)
        method, params = message.get("method"), message.get("params") or {}
        if method == "initialize":
            result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": True, "sessionCapabilities": {"resume": {}}}}
        elif method == "session/new":
            result = {"sessionId": sid}
        elif method in {"session/load", "session/resume"}:
            sid, resumed = params["sessionId"], True
            result = {}
        elif method == "session/set_mode" and agent == "harness2":
            result = {}
        elif method == "session/prompt":
            text = work("\n".join(x.get("text", "") for x in params["prompt"]))
            for part in ("Inspect restored", " workspace before delivering."):
                emit({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid,
                    "update": {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": part}}}})
            # ACP occupancy is deliberately not billed as model output usage.
            emit({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid,
                "update": {"sessionUpdate": "usage_update", "used": 1024, "size": 8192}}})
            emit({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid,
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}}})
            result = {"stopReason": "end_turn"}
        else:
            raise AssertionError(method)
        emit({"jsonrpc": "2.0", "id": message["id"], "result": result})
else:
    if agent != "codex":
        if "--resume" in sys.argv:
            flag = "--resume"
            sid = sys.argv[sys.argv.index(flag) + 1]
            resumed = True
        elif "--session-id" in sys.argv:
            flag = "--session-id"
            sid = sys.argv[sys.argv.index(flag) + 1]
        elif "--soduwork-session" in sys.argv:
            # Generic ACP profiles keep the provider session behind the bridge.
            # The fixture bypasses that bridge, so use its opaque session marker
            # to exercise initial and resumed turns without an installed Agent.
            marker = sys.argv[sys.argv.index("--soduwork-session") + 1]
            sid = marker or sid
            resumed = bool(marker)
        else:
            sid = sid
    elif "resume" in sys.argv:
        sid, resumed = sys.argv[sys.argv.index("resume") + 1], True
    text = work(sys.stdin.read())
    if agent == "codex":
        emit({"type": "thread.started", "thread_id": sid})
        for event, text_part in (("item.started", "Inspect restored"), ("item.updated", thought), ("item.completed", thought)):
            emit({"type": event, "item": {"type": "reasoning", "id": "thought-1",
                 "summary": [{"type": "summary_text", "text": text_part}]}})
        emit({"type": "item.completed", "item": {"type": "agent_message", "text": text}})
        emit({"type": "turn.completed", "usage": {"input_tokens": 20, "output_tokens": 10}})
    elif agent == "claude":
        emit({"type": "system", "subtype": "init", "session_id": sid})
        for event in ({"type": "message_start", "message": {"id": "thought-1"}},
                      {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}},
                      {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Inspect restored"}},
                      {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": " workspace before delivering."}},
                      {"type": "content_block_stop", "index": 0}):
            emit({"type": "stream_event", "event": event})
        emit({"type": "assistant", "message": {"id": "thought-1", "role": "assistant", "content": [
            {"type": "thinking", "thinking": thought}, {"type": "text", "text": text}]}})
        emit({"type": "result", "is_error": False, "result": text, "usage": {"input_tokens": 20, "output_tokens": 10}})
    else:
        emit({"type": "session", "id": sid})
        emit({"type": "message_start", "message": {"timestamp": 11}})
        for part in ("Inspect restored", " workspace before delivering."):
            emit({"type": "message_update", "assistantMessageEvent": {
                "type": "thinking_delta", "contentIndex": 0, "delta": part}})
        emit({"type": "message_update", "assistantMessageEvent": {
            "type": "thinking_end", "contentIndex": 0, "content": thought}})
        emit({"type": "message_update", "assistantMessageEvent": {"type": "text_end", "content": text}})
        emit({"type": "message_end", "message": {"role": "assistant", "stopReason": "stop", "usage": {"input": 20, "output": 10}}})
        emit({"type": "agent_end", "messages": [{"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": text}]}]})
